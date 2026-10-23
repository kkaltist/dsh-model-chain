/**
 * 链的核心逻辑自测（不需要启动 DSH）：
 *   · 前一跳没输出就失败 → 静默换下一跳；
 *   · 已经输出过内容再失败 → 不许回退，原样抛错；
 *   · 全部失败 → 抛最后一跳的错；
 *   · 中途 abort → 把 aborted 的 finish 原样透传；
 *   · 自引用成员被跳过；禁用/空链不进目录；
 *   · 落盘清洗：成员去重、id 唯一。
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const { createChainAdapter } = await import(pathToFileURL(join(root, 'lib/adapter.js')).href)
const store = await import(pathToFileURL(join(root, 'lib/store.js')).href)

const assert = (condition, message) => { if (!condition) throw new Error(message) }

const ROUTE = 'model-chain'

/** 假的宿主 llm：按 (provider, model) 执行剧本。 */
function fakeLlm(script) {
  return {
    stream(options) {
      const key = `${options.provider}/${options.model}`
      const act = script[key]
      return (async function* run() {
        if (act === undefined) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: `no route ${key}` } } }
          return
        }
        if (act.kind === 'fail') {
          yield { type: 'finish', reason: { kind: 'error', failure: act.failure } }
          return
        }
        if (act.kind === 'abort') {
          yield { type: 'bash', text: '' }
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'stoped' } } }
          return
        }
        if (act.kind === 'text-then-fail') {
          yield { type: 'text-delta', index: 0, text: '半句' }
          yield { type: 'finish', reason: { kind: 'error', failure: act.failure } }
          return
        }
        for (const piece of act.text) yield { type: 'text-delta', index: 0, text: piece }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

function chain(id, members, extra) {
  return { id, name: id, enabled: true, members, ...extra }
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

// 1) 第一跳失败 → 第二跳接上
{
  const llm = fakeLlm({
    'a/m1': { kind: 'fail', failure: { code: 'QUOTA', message: '配额用完了' } },
    'b/m2': { kind: 'text', text: ['答', '案'] },
  })
  const adapter = createChainAdapter({ llm, route: ROUTE, chains: () => [chain('main', [{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' }])] })
  const chunks = await collect(adapter.stream({ provider: ROUTE, model: 'main', messages: [] }))
  const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  assert(text === '答案', '降级后应拿到第二跳的内容，实际：' + text)
  assert(chunks.at(-1).type === 'finish' && chunks.at(-1).reason.kind === 'stop', '最后一跳的 finish 应透传')
  console.log('✓ 前一跳未输出就失败 → 静默换下一跳')
}

// 2) 已经输出过内容再失败 → 抛错，不回退
{
  const llm = fakeLlm({
    'a/m1': { kind: 'text-then-fail', failure: { code: 'UPSTREAM', message: '连接被重置' } },
    'b/m2': { kind: 'text', text: ['不该出现'] },
  })
  const adapter = createChainAdapter({ llm, route: ROUTE, chains: () => [chain('main', [{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' }])] })
  let error = null
  try { await collect(adapter.stream({ provider: ROUTE, model: 'main', messages: [] })) } catch (failure) { error = failure }
  assert(error !== null, '已输出内容后失败必须抛错')
  assert(String(error.message).includes('a / m1'), '错误里应指出是哪一跳：' + error.message)
  assert(error.code === 'UPSTREAM', '错误码应透传')
  console.log('✓ 输出后再失败 → 抛错（不回退，避免上下文半句话）')
}

// 3) 全部失败 → 抛最后一跳
{
  const llm = fakeLlm({
    'a/m1': { kind: 'fail', failure: { code: 'QUOTA', message: '第一跳失败' } },
    'b/m2': { kind: 'fail', failure: { code: 'AUTH', message: '第二跳失败' } },
  })
  const adapter = createChainAdapter({ llm, route: ROUTE, chains: () => [chain('main', [{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' }])] })
  let error = null
  try { await collect(adapter.stream({ provider: ROUTE, model: 'main', messages: [] })) } catch (failure) { error = failure }
  assert(error !== null && error.code === 'AUTH', '应抛最后一跳的错误，实际：' + (error && error.code))
  console.log('✓ 全链失败 → 抛最后一跳的错误')
}

// 4) abort 透传
{
  const llm = fakeLlm({
    'a/m1': { kind: 'abort' },
    'b/m2': { kind: 'text', text: ['不该出现'] },
  })
  const adapter = createChainAdapter({ llm, route: ROUTE, chains: () => [chain('main', [{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' }])] })
  const chunks = await collect(adapter.stream({ provider: ROUTE, model: 'main', messages: [] }))
  assert(chunks.at(-1).reason.kind === 'aborted', 'aborted 应原样透传，不该触发降级')
  assert(chunks.every(chunk => chunk.text !== '不该出现'), 'abort 后不应继续降级')
  console.log('✓ 用户中断 → 透传 aborted，不降级')
}

// 5) 目录：禁用/空链不出现；自引用成员被跳过
{
  const chains = [
    chain('main', [{ provider: ROUTE, model: 'main' }, { provider: 'a', model: 'm1' }]),
    chain('off', [{ provider: 'a', model: 'm1' }], { enabled: false }),
    chain('empty', []),
  ]
  const llm = fakeLlm({ 'a/m1': { kind: 'text', text: ['ok'] } })
  const adapter = createChainAdapter({ llm, route: ROUTE, chains: () => chains })
  const listed = await adapter.listModels(ROUTE)
  assert(listed.length === 1 && listed[0].id === 'main', '目录只应列出启用且非空的链：' + JSON.stringify(listed.map(item => item.id)))
  const chunks = await collect(adapter.stream({ provider: ROUTE, model: 'main', messages: [] }))
  assert(chunks.some(chunk => chunk.text === 'ok'), '自引用成员应被跳过，直接用下一跳')
  const info = await adapter.resolveModel(ROUTE, 'main')
  assert(info.provider === ROUTE && info.id === 'main' && info.name === 'main', 'resolveModel 元数据不对')
  console.log('✓ 目录过滤 + 自引用跳过')
}

// 6) 「实际是哪一跳在答」：只报一次，且带正确跳数
{
  const seen = []
  const llm = fakeLlm({
    'a/m1': { kind: 'fail', failure: { code: 'QUOTA', message: '第一跳失败' } },
    'b/m2': { kind: 'text', text: ['救', '场'] },
  })
  const adapter = createChainAdapter({
    llm,
    route: ROUTE,
    chains: () => [chain('main', [{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' }])],
    onServed: (chainId, member, hop) => seen.push({ chainId, member, hop }),
  })
  await collect(adapter.stream({ provider: ROUTE, model: 'main', messages: [] }))
  assert(seen.length === 1, 'onServed 应只报一次，实际 ' + seen.length)
  assert(seen[0].chainId === 'main' && seen[0].member.provider === 'b' && seen[0].hop === 2,
    '应报「第二跳 b/m2」，实际 ' + JSON.stringify(seen[0]))

  // 已输出再失败：报的是第一跳（它确实产出了内容）
  const seen2 = []
  const llm2 = fakeLlm({ 'a/m1': { kind: 'text-then-fail', failure: { code: 'UPSTREAM', message: '断流' } } })
  const adapter2 = createChainAdapter({
    llm: llm2,
    route: ROUTE,
    chains: () => [chain('main', [{ provider: 'a', model: 'm1' }])],
    onServed: (chainId, member, hop) => seen2.push({ member, hop }),
  })
  try { await collect(adapter2.stream({ provider: ROUTE, model: 'main', messages: [] })) } catch { /* 预期抛错 */ }
  assert(seen2.length === 1 && seen2[0].member.provider === 'a' && seen2[0].hop === 1, '已输出那跳应被记为服务者')
  console.log('✓ 最近服务成员记录（含跳数与只报一次）')
}

// 7) 落盘清洗
{
  const normalized = store.normalizeState({
    chains: [
      { id: 'Same Name', name: 'Same Name', members: [{ provider: 'a', model: 'm1' }, { provider: 'a', model: 'm1' }, { provider: '', model: 'x' }] },
      { id: 'same-name', name: 'Same Name 2', members: [] },
    ],
  })
  assert(normalized.chains.length === 2, '两条链应都保留')
  assert(normalized.chains[0].id === 'same-name', 'slug 化后应为 same-name，实际 ' + normalized.chains[0].id)
  assert(normalized.chains[1].id === 'same-name-2', '重复 id 应自动加序号，实际 ' + normalized.chains[1].id)
  assert(normalized.chains[0].members.length === 1, '重复/非法成员应被清掉')
  const defaults = store.defaultState()
  assert(defaults.chains.length === 1 && defaults.chains[0].members.length === 0, '默认状态应是一条空链')
  console.log('✓ 状态清洗（去重、id 唯一、slug）')
}

console.log('\n全部通过')
