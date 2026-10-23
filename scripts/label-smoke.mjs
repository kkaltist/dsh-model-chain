/**
 * 回归测试：`conversation.input.model.label` 是「单占位」座位 —— 注册了就接管
 * 所有 provider 的所有行。所以**任何** provider 都必须渲染出模型名，绝不能返回 null，
 * 否则别人的模型行会整行空白（真实事故：模型菜单只剩空行）。
 *
 * 顺带确认两个贡献点都注册上了（之前一次改动把 settings.section 拖没了）。
 *
 * 运行：node scripts/label-smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const assert = (condition, message) => { if (!condition) throw new Error(message) }

// ── 极简 React（只要够跑一次同步渲染）──────────────────────────────────────
const React = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: Object.assign({}, props || {}, { children }) }),
  useState: init => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: factory => factory(),
  useCallback: factory => factory,
  useRef: value => ({ current: value }),
}

let captured = null
globalThis.window = {
  __ModuleLoader__: { load(config) { captured = config } },
  addEventListener() {},
  removeEventListener() {},
  innerWidth: 1280,
  innerHeight: 800,
  localStorage: { getItem: () => null, setItem() {} },
  fetch: async () => ({ ok: true, json: async () => ({ last: { main: { provider: 'deepseek-official', model: 'deepseek-flash', hop: 1, at: 1 } } }) }),
}
globalThis.fetch = globalThis.window.fetch
globalThis.document = {
  documentElement: { lang: 'zh' },
  head: { appendChild() {} },
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
}

const source = readFileSync(join(root, 'client.js'), 'utf8')
new Function('window', 'document', 'fetch', source)(globalThis.window, globalThis.document, globalThis.fetch)
assert(captured !== null, 'bundle 没有被 ModuleLoader 捕获')

const mod = captured.factory(name => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})

const registered = []
const fakeCtx = {
  effect(fn) { fn(); return () => {} },
  locale: { register() {}, bind: () => key => key },
  slots: {
    inject(name, callback) { callback() },
    register(descriptor, component) { registered.push({ descriptor, component }); return () => {} },
  },
}
mod.apply(fakeCtx)

const names = registered.map(item => item.descriptor.name)
assert(names.includes('settings.section'), '设置分区没注册上：' + names.join(','))
assert(names.includes('conversation.input.model.label'), '模型标签座位没注册：' + names.join(','))

const labelEntry = registered.find(item => item.descriptor.name === 'conversation.input.model.label')
// 注册的是包装组件 `props => h(ChainLabel, props)`，这里往里再渲染一层。
const Label = props => {
  const outer = labelEntry.component(props)
  if (outer && typeof outer.type === 'function') return outer.type(outer.props)
  return outer
}

function textOf(vnode) {
  if (vnode === null || vnode === undefined || vnode === false) return ''
  if (typeof vnode === 'string' || typeof vnode === 'number') return String(vnode)
  if (Array.isArray(vnode)) return vnode.map(textOf).join('')
  const children = vnode.props && vnode.props.children
  return children ? children.map(textOf).join('') : ''
}

// ① 别的 provider 的「下拉选项行」：必须显示出模型名（这就是那次事故）
for (const placement of ['option', 'menu', 'trigger']) {
  const vnode = Label({ provider: { id: 'deepseek-official', name: 'DeepSeek' }, model: { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' }, placement, selected: false })
  assert(vnode !== null && vnode !== undefined, `${placement}: 非本路由的行不能返回 null`)
  assert(textOf(vnode) === 'DeepSeek V4.1 Flash', `${placement}: 模型名丢了，实际「${textOf(vnode)}」`)
}

// ② 本路由：链名照常显示（成员要等异步轮询，这次渲染里为 null）
for (const placement of ['option', 'menu', 'trigger']) {
  const vnode = Label({ provider: { id: 'model-chain', name: '模型链' }, model: { id: 'main', name: '主力链' }, placement, selected: true })
  assert(vnode !== null && textOf(vnode) === '主力链', `${placement}: 链名丢了，实际「${textOf(vnode)}」`)
}

console.log('✓ 非本路由的模型行恢复显示模型名（不会再整行空白）')
console.log('✓ 本路由的链名正常（成员后缀依赖异步轮询，不阻塞渲染）')
console.log('✓ settings.section 与模型标签座位都注册成功')
