/**
 * 链适配器：一个路由（默认 `model-chain`），每条链对外是一个模型 ID。
 *
 * 调用方只会看到一个 `provider=model-chain, model=<链 id>`；适配器内部按成员顺序
 * 依次向真正的 provider 发同一份请求，**第一个产出内容的成员赢**：
 *
 *   - 前一个成员在「还没输出任何内容」时失败（配额墙、地区限制、401、5xx、超时）
 *     → 静默换下一个，调用方看不到这一跳；
 *   - 已经吐过内容再失败 → 不能回退（半句话已经在上文里了），把失败原样抛出去；
 *   - 全部失败 → 抛出最后一个失败，并附上最后一跳的成员信息，便于定位。
 *
 * 元数据取「诚实的最小值」：不给 `context`、不给 `reasoning`，因为一条链的容量是
 * 各成员的**交集**，链上少报不如不报 —— 报大了会让会话把超长上下文送进一个接不住的
 * 成员。链成员的推理强度沿用调用方传来的值（选链时按头号成员选即可）。
 *
 * 防自引用：成员里如果出现本路由（`provider === route`），直接跳过，
 * 否则就是一次无限递归。
 */

function failureOf(error) {
  if (error && typeof error === 'object') {
    return {
      message: typeof error.message === 'string' && error.message !== '' ? error.message : '未知错误',
      code: typeof error.code === 'string' && error.code !== '' ? error.code : 'CHAIN_MEMBER_FAILED',
      ...(Number.isFinite(error.status) ? { status: Number(error.status) } : {}),
    }
  }
  return { message: String(error == null ? '未知错误' : error), code: 'CHAIN_MEMBER_FAILED' }
}

function errorOfFailure(failure, member) {
  const where = member ? `（${member.provider} / ${member.model}）` : ''
  const error = new Error(`${failure.message}${where}`)
  error.code = failure.code
  if (failure.status !== undefined) error.status = failure.status
  return error
}

/**
 * 造一个链适配器。
 * @param {{llm: object, route: string, chains: () => Array<{id: string, name: string, enabled: boolean, members: Array<{provider: string, model: string}>}>}} options
 *   `llm` 是宿主的 llm 服务（用于把请求转给真正的成员）；`chains` 每次调用都读最新状态。
 */
export function createChainAdapter(options) {
  const { llm, route, chains, onServed, ready = () => Promise.resolve() } = options

  const usable = () => chains().filter(chain => chain.enabled !== false && Array.isArray(chain.members) && chain.members.some(member => member.provider !== route))
  const chainOf = model => chains().find(chain => chain.id === model)

  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: '模型链' }
    },

    providerRetryPolicy() {
      return undefined
    },

    // 宿主会无保护地调用这两个（`adapter.imageRequestTarget(...)` 没有可选链），
    // 缺了就只会在「带图片的请求」上炸。默认语义 = 原样保留尺寸与字节预算。
    imageRequestPricing() {
      return undefined
    },

    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes }
    },

    async listModels() {
      await ready()
      return usable().map(chain => ({ provider: route, id: chain.id, name: chain.name }))
    },

    async resolveModel(provider, model) {
      await ready()
      const chain = chainOf(model)
      if (chain === undefined) throw errorOfFailure({ message: `没有叫 ${model} 的链`, code: 'CHAIN_UNKNOWN' }, null)
      if (chain.enabled === false) throw errorOfFailure({ message: `链「${chain.name}」已禁用`, code: 'CHAIN_DISABLED' }, null)
      if (chain.members.length === 0) throw errorOfFailure({ message: `链「${chain.name}」还没有成员`, code: 'CHAIN_EMPTY' }, null)
      return { provider: route, id: chain.id, name: chain.name }
    },

    async prepareCall(provider, model, signal) {
      const info = await adapter.resolveModel(provider, model, signal)
      return { model: info, stream: callOptions => adapter.stream(callOptions) }
    },

    async *stream(callOptions) {
      await ready()
      await adapter.resolveModel(callOptions.provider, callOptions.model)
      const chain = chainOf(callOptions.model)
      // Snapshot the order for this call; a later save only changes future calls.
      const members = chain.members.filter(member => member.provider !== route)
      if (members.length === 0) {
        throw errorOfFailure({ message: '这条链的成员全是它自己', code: 'CHAIN_SELF_REFERENCE' }, null)
      }

      const checkAbort = () => {
        if (callOptions.signal?.aborted) {
          throw callOptions.signal.reason ?? new DOMException('已中断', 'AbortError')
        }
      }
      let lastFailure = null
      let lastMember = null
      let hop = 0
      let served = false
      const markServed = member => {
        if (served || typeof onServed !== 'function') return
        served = true
        try { onServed(chain.id, member, hop) } catch { /* Observation must not affect generation. */ }
      }
      for (const member of members) {
        checkAbort()
        hop += 1
        let emitted = false
        let failure = null
        const pending = []
        try {
          const upstream = llm.stream({ ...callOptions, provider: member.provider, model: member.model })
          for await (const chunk of upstream) {
            checkAbort()
            if (chunk?.type === 'finish') {
              const kind = chunk.reason?.kind
              if (kind === 'error') { failure = failureOf(chunk.reason.failure); break }
              if (kind === 'aborted') { yield chunk; return }
              markServed(member)
              for (const item of pending) yield item
              yield chunk
              return
            }
            // Failed attempts must not leak block indexes/types or usage to the next member.
            const content = chunk && (
              ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text !== '') ||
              chunk.type === 'tool-call-delta' || chunk.type === 'block-end'
            )
            if (!emitted && content) {
              emitted = true
              markServed(member)
              for (const item of pending) yield item
              pending.length = 0
            }
            if (emitted) yield chunk
            else {
              if (pending.length >= 256) throw Object.assign(new Error('成员在输出前发送了过多元数据'), { code: 'CHAIN_PREAMBLE_LIMIT' })
              pending.push(chunk)
            }
          }
          failure ??= { message: '成员流未返回 finish 就结束', code: 'CHAIN_STREAM_INCOMPLETE' }
        } catch (error) {
          // A cancellation must never turn into another paid model request.
          if (callOptions.signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORTED') throw error
          failure = failureOf(error)
        }
        checkAbort()
        if (emitted) throw errorOfFailure(failure, member)
        lastFailure = failure
        lastMember = member
      }
      throw errorOfFailure(lastFailure ?? { message: '链上没有可用的成员', code: 'CHAIN_EXHAUSTED' }, lastMember)
    },
  }

  return adapter
}
