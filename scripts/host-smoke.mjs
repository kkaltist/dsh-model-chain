// Optional integration check against an existing DSH installation; no model network calls.
// node scripts/host-smoke.mjs /absolute/path/to/node_modules/@deepseek-ai/dsh/package.json
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createChainAdapter } from '../lib/adapter.js'

if (!process.argv[2]) throw new Error('Provide the absolute path to an installed @deepseek-ai/dsh/package.json')
const requireFromHost = createRequire(pathToFileURL(resolve(process.argv[2])))
const { Context } = await import(pathToFileURL(requireFromHost.resolve('@deepseek-ai/cordis')).href)
const { LlmRuntime, LlmAdapter, BlockAssembler } = await import(pathToFileURL(requireFromHost.resolve('@deepseek-ai/dsh-llm')).href)
const ctx = new Context()
const fiber = ctx.plugin(LlmRuntime)
await fiber.await()
const calls = []
class Member extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    calls.push(options.provider)
    if (options.provider === 'review-a') {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      throw new Error('test failure')
    }
    yield { type: 'text-delta', index: 0, text: 'real host fallback OK' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const direct = ctx.llm.registerAdapter(['review-a', 'review-b'], new Member())
const chain = ctx.llm.registerAdapter(['model-chain'], createChainAdapter({
  llm: ctx.llm, route: 'model-chain',
  chains: () => [{ id: 'main', name: 'Review', enabled: true, members: [
    { provider: 'review-a', model: 'a' }, { provider: 'review-b', model: 'b' },
  ] }],
}))
try {
  const assembler = new BlockAssembler()
  const chunks = []
  for await (const chunk of ctx.llm.stream({ provider: 'model-chain', model: 'main', messages: [] })) {
    chunks.push(chunk)
    assembler.push(chunk)
  }
  assert.deepEqual(calls, ['review-a', 'review-b'])
  assert.deepEqual(assembler.blocks(), [{ type: 'text', text: 'real host fallback OK' }])
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  console.log('✓ Real DSH LLM registration, fallback and BlockAssembler integration')
} finally {
  await chain()
  await direct()
  await fiber.dispose()
}
