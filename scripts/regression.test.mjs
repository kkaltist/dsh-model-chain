import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request } from 'node:http'
import { createChainAdapter } from '../lib/adapter.js'
import * as store from '../lib/store.js'
import { apply } from '../index.js'

const finish = kind => ({ type: 'finish', reason: { kind } })
const fail = { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'limit' } } }
const text = value => ({ type: 'text-delta', index: 0, text: value })
const members = [{ provider: 'a', model: 'one' }, { provider: 'b', model: 'two' }]
const makeChain = (extra = {}) => ({ id: 'main', name: '主力链', enabled: true, members, ...extra })
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
function setup(first, extra = {}) {
  const calls = []
  const llm = { stream(options) {
    calls.push(options)
    return options.provider === 'a' ? first(options) : (async function* () { yield text('fallback'); yield finish('stop') })()
  } }
  return { calls, adapter: createChainAdapter({ llm, route: 'model-chain', chains: () => [makeChain()], ...extra }) }
}

test('synchronous dispatch exceptions and iterator exceptions fall back before content', async () => {
  for (const first of [() => { throw new Error('dispatch') }, async function* () { throw new Error('iterator') }]) {
    const { adapter, calls } = setup(first)
    assert.deepEqual(await collect(adapter.stream({ model: 'main', messages: ['same'] })), [text('fallback'), finish('stop')])
    assert.equal(calls.length, 2)
    assert.strictEqual(calls[0].messages, calls[1].messages)
  }
})

test('failed preamble and usage never pollute a successful next member', async () => {
  const { adapter } = setup(async function* () {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: 0, text: '' }
    yield { type: 'usage', usage: { inputTokens: 999 } }
    yield fail
  })
  assert.deepEqual(await collect(adapter.stream({ model: 'main' })), [text('fallback'), finish('stop')])
})

test('winning preamble is flushed in order', async () => {
  const chunks = [{ type: 'block-start', index: 0, blockType: 'text' }, text('ok'), finish('stop')]
  const { adapter, calls } = setup(async function* () { yield* chunks })
  assert.deepEqual(await collect(adapter.stream({ model: 'main' })), chunks)
  assert.equal(calls.length, 1)
})

test('text, reasoning, tool calls and completed blocks prevent replay after failure', async () => {
  for (const chunk of [text('partial'), { type: 'reasoning-delta', index: 0, text: 'think' },
    { type: 'tool-call-delta', index: 0, id: 'call1', name: 'write', argumentsDelta: '' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }]) {
    const { adapter, calls } = setup(async function* () { yield chunk; throw Object.assign(new Error('broken'), { code: 'BROKEN', status: 502 }) })
    const seen = []
    await assert.rejects(async () => { for await (const item of adapter.stream({ model: 'main' })) seen.push(item) }, { code: 'BROKEN', status: 502 })
    assert.deepEqual(seen, [chunk])
    assert.equal(calls.length, 1)
  }
})

test('pre-aborted requests make no model calls', async () => {
  const controller = new AbortController(); controller.abort()
  const { adapter, calls } = setup(async function* () { yield text('never') })
  await assert.rejects(collect(adapter.stream({ model: 'main', signal: controller.signal })), { name: 'AbortError' })
  assert.equal(calls.length, 0)
})

test('cancellation between hops never dispatches a fallback', async () => {
  const controller = new AbortController()
  const { adapter, calls } = setup(async function* () { controller.abort(); yield fail })
  await assert.rejects(collect(adapter.stream({ model: 'main', signal: controller.signal })), { name: 'AbortError' })
  assert.equal(calls.length, 1)
})

test('thrown AbortError and aborted finish stay terminal', async () => {
  const one = setup(async function* () { throw new DOMException('cancel', 'AbortError') })
  await assert.rejects(collect(one.adapter.stream({ model: 'main' })), { name: 'AbortError' })
  assert.equal(one.calls.length, 1)
  const two = setup(async function* () { yield { type: 'block-start', index: 0, blockType: 'text' }; yield finish('aborted') })
  assert.deepEqual(await collect(two.adapter.stream({ model: 'main' })), [finish('aborted')])
  assert.equal(two.calls.length, 1)
})

test('missing terminal finish falls back only before content', async () => {
  const empty = setup(async function* () {})
  assert.deepEqual(await collect(empty.adapter.stream({ model: 'main' })), [text('fallback'), finish('stop')])
  const partial = setup(async function* () { yield text('partial') })
  await assert.rejects(collect(partial.adapter.stream({ model: 'main' })), { code: 'CHAIN_STREAM_INCOMPLETE' })
  assert.equal(partial.calls.length, 1)
})

test('disabled and self-only chains cannot be dispatched or listed', async () => {
  const disabled = setup(async function* () {}, { chains: () => [makeChain({ enabled: false })] })
  assert.deepEqual(await disabled.adapter.listModels(), [])
  await assert.rejects(disabled.adapter.resolveModel('model-chain', 'main'), { code: 'CHAIN_DISABLED' })
  await assert.rejects(collect(disabled.adapter.stream({ model: 'main' })), { code: 'CHAIN_DISABLED' })
  assert.equal(disabled.calls.length, 0)
  const self = setup(async function* () {}, { chains: () => [makeChain({ members: [{ provider: 'model-chain', model: 'main' }] })] })
  assert.deepEqual(await self.adapter.listModels(), [])
  await assert.rejects(collect(self.adapter.stream({ model: 'main' })), { code: 'CHAIN_SELF_REFERENCE' })
})

test('initial state readiness gates listing and dispatch', async () => {
  let release
  const ready = new Promise(resolve => { release = resolve })
  const { adapter, calls } = setup(async function* () { yield finish('stop') }, { ready: () => ready })
  const listing = adapter.listModels()
  const generation = collect(adapter.stream({ model: 'main' }))
  await Promise.resolve()
  assert.equal(calls.length, 0)
  release()
  assert.equal((await listing).length, 1)
  await generation
  assert.equal(calls.length, 1)
})

test('failed member iterators and consumer cancellation both run cleanup', async () => {
  let closed = 0
  const first = setup(async function* () { try { yield fail } finally { closed++ } })
  await collect(first.adapter.stream({ model: 'main' }))
  assert.equal(closed, 1)
  const second = setup(async function* () { try { yield text('one'); yield text('two') } finally { closed++ } })
  for await (const chunk of second.adapter.stream({ model: 'main' })) break
  assert.equal(closed, 2)
  assert.equal(second.calls.length, 1)
})

test('state writes serialize, preserve Unicode and leave no temporary files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-model-chain-test-'))
  const previous = process.env.DSH_HOME; process.env.DSH_HOME = dir
  try {
    const states = Array.from({ length: 24 }, (_, i) => ({ chains: [makeChain({ id: `chain-${i}`, name: `测试链 ${i}` })] }))
    await Promise.all(states.map(value => store.saveState(value)))
    assert.deepEqual(await store.loadState(), states.at(-1))
    assert.deepEqual(await readdir(join(dir, 'model-chain')), ['state.json'])
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('corrupt state is backed up separately; filesystem errors are not silently reset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-model-chain-test-'))
  const previous = process.env.DSH_HOME; process.env.DSH_HOME = dir
  try {
    assert.deepEqual(await store.loadState(), store.defaultState())
    await mkdir(join(dir, 'model-chain'))
    const file = store.statePath()
    for (const invalid of ['{broken', '{}']) {
      await writeFile(file, invalid)
      assert.deepEqual(await store.loadState(), store.defaultState())
    }
    const backups = (await readdir(join(dir, 'model-chain'))).filter(name => name.includes('.broken-'))
    assert.equal(backups.length, 2)
    const backedUp = await Promise.all(backups.map(name => readFile(join(dir, 'model-chain', name), 'utf8')))
    assert.deepEqual(backedUp.sort(), ['{broken', '{}'].sort())
    await rm(file); await mkdir(file)
    await assert.rejects(store.loadState())
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('host HTTP API handles startup, concurrent saves, malformed input and origin boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-model-chain-http-'))
  const previous = process.env.DSH_HOME; process.env.DSH_HOME = dir
  let handler, adapter
  const disposers = []
  const logs = []
  const host = {
    llm: { registerAdapter(routes, value) { adapter = value; return { replace() {} } }, listProviders: () => [] },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    inject(deps, fn) { fn({ effect: host.effect, webServer: { register(route) { handler = route.handler; return () => {} } } }) },
    logger: { info() {}, error(error) { logs.push(error) } },
  }
  const server = createServer((req, res) => void handler(req, res))
  try {
    await store.saveState({ chains: [makeChain()] })
    apply(host)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}/api/model-chain`
    assert.equal((await (await fetch(base + '/state')).json()).chains[0].name, '主力链')
    const send = (body, headers = {}) => fetch(base + '/state', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
    assert.equal((await send('{invalid')).status, 400)
    assert.equal((await send('{}')).status, 400)
    assert.equal((await send('{}', { 'content-type': 'text/plain' })).status, 415)
    assert.equal((await send('{}', { origin: 'https://evil.example' })).status, 403)
    const rebound = await new Promise((resolve, reject) => {
      const req = request(base + '/state', { headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode) })
      req.on('error', reject); req.end()
    })
    assert.equal(rebound, 403)
    assert.equal((await send('x'.repeat(2_000_001))).status, 413)
    const payloads = Array.from({ length: 12 }, (_, i) => JSON.stringify({ chains: [makeChain({ id: `http-${i}`, name: `中文链 ${i}` })] }))
    const responses = await Promise.all(payloads.map(body => send(body)))
    assert.ok(responses.every(response => response.status === 200))
    const final = await (await fetch(base + '/state')).json()
    assert.deepEqual(await store.loadState(), { chains: final.chains.map(({ lastServed, ...chain }) => chain) })
    assert.deepEqual((await adapter.listModels()).map(item => item.id), [final.chains[0].id])
    assert.equal((await fetch(base + '/missing')).status, 404)
    assert.equal(logs.length, 0)
  } finally {
    disposers.reverse().forEach(dispose => dispose())
    await new Promise(resolve => server.close(resolve))
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    await rm(dir, { recursive: true, force: true })
  }
})
