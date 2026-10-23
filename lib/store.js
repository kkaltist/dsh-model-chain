/**
 * 链状态的落盘：`$DSH_HOME/model-chain/state.json`。
 *
 * 形状：
 *   { chains: [ { id, name, enabled, members: [ { provider, model } ] } ] }
 *
 * `id` 就是暴露给调用方的模型 ID（在 `model-chain` 这个路由下），
 * 所以它必须是稳定的 slug：改名不动 id，模型选择里选中的那个 ID 才不会漂。
 */
import { copyFile, mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

export function homeDir() {
  return process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : path.join(homedir(), '.dsh')
}

export function statePath() {
  return path.join(homeDir(), 'model-chain', 'state.json')
}

/** 从任意字符串得到稳定的模型 ID（用于新建链）。 */
export function slugOf(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase()
  const slug = text.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return slug === '' ? 'chain' : slug
}

function normalizeMember(raw) {
  if (raw === null || raw === undefined) return null
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (provider === '' || model === '') return null
  return { provider, model }
}

/** 清洗一条链：成员去空、去重（同 provider+model 只留第一次出现的位置）。 */
export function normalizeChain(raw, used) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const name = typeof source.name === 'string' && source.name.trim() !== '' ? source.name.trim().slice(0, 60) : '未命名链'
  let id = typeof source.id === 'string' && source.id.trim() !== '' ? slugOf(source.id) : slugOf(name)
  if (used !== undefined) {
    let candidate = id
    let n = 2
    while (used.has(candidate)) { candidate = `${id}-${n}`; n += 1 }
    id = candidate
    used.add(id)
  }
  const seen = new Set()
  const members = []
  for (const item of Array.isArray(source.members) ? source.members : []) {
    const member = normalizeMember(item)
    if (member === null) continue
    const key = member.provider + '\u0000' + member.model
    if (seen.has(key)) continue
    seen.add(key)
    members.push(member)
  }
  return { id, name, enabled: source.enabled !== false, members }
}

export function normalizeState(raw) {
  const used = new Set()
  const list = Array.isArray(raw && raw.chains) ? raw.chains : []
  return { chains: list.map(item => normalizeChain(item, used)) }
}

/** 没有任何配置时的初始状态：留一条空链，设置页一打开就有东西可编辑。 */
export function defaultState() {
  return { chains: [{ id: 'main', name: '主力链', enabled: true, members: [] }] }
}

export async function loadState() {
  const file = statePath()
  let text
  try { text = await readFile(file, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return defaultState()
    throw error
  }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || !Array.isArray(parsed.chains)) throw new SyntaxError('chains must be an array')
    return normalizeState(parsed)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    // Keep every broken original; fail closed if a backup cannot be written.
    await copyFile(file, `${file}.broken-${Date.now()}-${randomUUID()}`)
    return defaultState()
  }
}

const writes = new Map()

export function saveState(state) {
  const file = statePath()
  const next = normalizeState(state)
  // Serialize writes per destination, preserving arrival order in this process.
  const pending = (writes.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, JSON.stringify(next, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temp, file)
      return next
    } finally {
      await rm(temp, { force: true })
    }
  })
  writes.set(file, pending)
  const cleanup = () => { if (writes.get(file) === pending) writes.delete(file) }
  void pending.then(cleanup, cleanup)
  return pending
}
