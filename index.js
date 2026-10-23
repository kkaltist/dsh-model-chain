/**
 * dsh-model-chain —— 把若干模型串成一条降级链，对调用方只暴露一个模型 ID。
 *
 * Host 半身的全部职责：
 *   1. 在 `llm` 上注册一个自己的路由（`model-chain`），每条链 = 该路由下的一个模型；
 *   2. 管好 `$DSH_HOME/model-chain/state.json`（设置页读写它）；
 *   3. 提供设置读写、模型目录和最近服务观测接口。
 *
 * 实际的降级逻辑在 `lib/adapter.js`；这里只做接线。
 */
import { createChainAdapter } from './lib/adapter.js'
import { defaultState, loadState, normalizeState, saveState } from './lib/store.js'

export const name = 'model-chain'

/** 需要一个带 `registerAdapter` 的 llm 服务才能挂上自己的路由。 */
export const inject = ['llm']

export const ROUTE = 'model-chain'
const API_PREFIX = '/api/model-chain'

// Per-activation state and observations are initialized in apply().
const LAST_SERVED_LIMIT = 64

const t = (zh) => zh

export function apply(ctx) {
  let state = defaultState()
  const lastServed = new Map()
  let alive = true
  const ready = loadState().then(loaded => {
    if (alive) { state = loaded; announce() }
  })
  void ready.catch(error => ctx.logger?.error?.(error))
  ctx.effect(() => () => { alive = false }, 'model-chain: lifecycle')

  const adapter = createChainAdapter({
    llm: ctx.llm,
    ready: () => ready,
    route: ROUTE,
    chains: () => state.chains,
    onServed: (chainId, member, hop) => {
      if (lastServed.size >= LAST_SERVED_LIMIT && !lastServed.has(chainId)) lastServed.clear()
      lastServed.set(chainId, { provider: member.provider, model: member.model, hop: hop || 1, at: Date.now() })
    },
  })

  // 注册路由。返回值带 replace()：保存后用同一份路由集 replace 一次，
  // 宿主据此广播 `llm/adapters-updated`，模型选择器的目录就会刷新。
  const handle = ctx.llm.registerAdapter([ROUTE], adapter)
  const announce = () => {
    try { handle.replace([ROUTE]) } catch { /* 注册已释放：热重载期间会发生，忽略 */ }
  }

  /**
   * 当前可选模型目录：把宿主上每个 provider 的模型列出来，供设置页勾选。
   * 排除本路由自己 —— 链里套链只会让失败面变大。
   */
  async function catalog() {
    const groups = []
    const llm = ctx.llm
    let providers = []
    try {
      providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
    } catch { providers = [] }
    for (const provider of providers) {
      if (!provider || typeof provider.id !== 'string' || provider.id === ROUTE) continue
      try {
        const models = await llm.listModels(provider.id)
        const list = (Array.isArray(models) ? models : [])
          .filter(model => model && typeof model.id === 'string' && model.id !== '')
          .map(model => ({ id: model.id, name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id }))
        if (list.length > 0) groups.push({ id: provider.id, name: typeof provider.name === 'string' && provider.name !== '' ? provider.name : provider.id, models: list })
      } catch { /* 某个 provider 列不出来就跳过，不影响别的 */ }
    }
    return groups
  }

  const send = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }

  const readJson = req => new Promise((resolve, reject) => {
    const parts = []
    let bytes = 0
    let failed = false
    req.on('data', chunk => {
      if (failed) return
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += part.length
      if (bytes > 2_000_000) {
        failed = true
        reject(Object.assign(new Error('body too large'), { status: 413 }))
      } else parts.push(part)
    })
    req.on('end', () => {
      if (failed) return
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))) }
      catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })) }
    })
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('request aborted')))
  })

  // Raw webServer routes bypass the host's Remote gateway: keep this API local.
  const loopback = value => value === 'localhost' || value === '[::1]' || value === '::1' || /^127(?:\.\d{1,3}){3}$/.test(value)
  const allowedRequest = req => {
    const peer = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '')
    if (!loopback(peer)) return false
    try {
      const origin = `${req.socket?.encrypted ? 'https' : 'http'}://${req.headers.host}`
      if (!loopback(new URL(origin).hostname)) return false
      if (req.headers.origin && req.headers.origin !== new URL(origin).origin) return false
      return req.headers['sec-fetch-site'] !== 'cross-site'
    } catch { return false }
  }

  const handler = async (req, res) => {
    if (!allowedRequest(req)) return send(res, 403, { error: 'local same-origin access required' })
    const url = new URL(req.url || '/', 'http://localhost')
    const routePath = url.pathname.replace(/^\/api\/model-chain/, '').replace(/\/+$/, '') || '/'
    const method = String(req.method || 'GET').toUpperCase()
    try {
      await ready
      if (method === 'GET' && routePath === '/state') {
        const catalogGroups = await catalog()
        return send(res, 200, {
          route: ROUTE,
          chains: state.chains.map(chain => ({ ...chain, lastServed: lastServed.get(chain.id) || null })),
          catalog: catalogGroups,
        })
      }
      // 给输入框里的模型标签用：只有「这条链上一跳是谁」，不拉目录，够轻。
      if (method === 'GET' && routePath === '/last') {
        const payload = Object.create(null)
        for (const [id, entry] of lastServed.entries()) payload[id] = entry
        return send(res, 200, { route: ROUTE, last: payload })
      }
      if (method === 'POST' && routePath === '/state') {
        if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return send(res, 415, { error: 'application/json required' })
        const body = await readJson(req)
        const incoming = Array.isArray(body && body.chains) ? body.chains : null
        if (incoming === null) return send(res, 400, { error: 'chains must be an array' })
        state = await saveState(normalizeState({ chains: incoming }))
        for (const id of lastServed.keys()) {
          const chain = state.chains.find(item => item.id === id)
          const entry = lastServed.get(id)
          if (!chain || chain.enabled === false || !chain.members.some(member => member.provider === entry.provider && member.model === entry.model)) lastServed.delete(id)
        }
        announce()
        return send(res, 200, { ok: true, route: ROUTE, chains: state.chains })
      }
      if (method === 'GET' && routePath === '/catalog') {
        return send(res, 200, { groups: await catalog() })
      }
      return send(res, 404, { error: 'not found' })
    } catch (error) {
      return send(res, error?.status === 400 || error?.status === 413 ? error.status : 500, { error: String((error && error.message) || error) })
    }
  }

  // webServer 可能比插件晚就绪，所以用 ctx.inject 等它，而不是 apply 时读一次。
  ctx.inject(['webServer'], scoped => {
    scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }),
      'model-chain: settings api',
    )
  })

  ctx.logger?.info?.(t(`model-chain: 已挂上路由 ${ROUTE}（${state.chains.length} 条链）`))
}
