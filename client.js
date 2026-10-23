/**
 * dsh-model-chain —— 浏览器半身：设置页里的「模型链」分区。
 *
 * 只做三件事：读 `/api/model-chain/state`、在本地编辑一份草稿、保存时整体回传。
 * 「可选的模型」由 Host 侧汇总（每个 provider 的 listModels），所以这里不需要
 * sessionId，也不依赖模型选择器当前打开的是哪个会话。
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-chain',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useMemo, useCallback } = React

    const NS = 'modelChain'
    const API = '/api/model-chain'
    const ROUTE = 'model-chain'

    const DICT = {
      zh: {
        nav: '模型链',
        title: '模型链',
        desc: '把若干已选模型按顺序串成一条链：第一个失败就换下一个，对外始终只有一个模型 ID。在模型选择器里它会出现在「模型链」分组下。',
        empty: '还没有链，先新建一条。',
        addChain: '新建链',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        name: '链名称',
        id: '模型 ID',
        enabled: '启用',
        members: '成员（按顺序降级）',
        noMembers: '还没有成员，从下面挑一个模型加进来。',
        addModel: '添加模型…',
        remove: '移除',
        up: '上移',
        down: '下移',
        removeChain: '删除这条链',
        loading: '正在读取…',
        loadFailed: '读取失败',
        retry: '重试',
        unsaved: '有未保存的改动',
        hint: '成员可以是任意来源的模型：官方 DeepSeek、Our Free Model 的免费模型、中转站都行。链里不会再套链。',
        lastServed: '最近服务：{model}',
        lastServedHop: '最近服务：{model}（第 {hop} 跳）',
        neverServed: '这条链还没被调用过',
        actual: '实际使用',
      },
      en: {
        nav: 'Model chain',
        title: 'Model chain',
        desc: 'Chain several selected models in order: the first failure moves to the next, while callers always see one model id. It shows up under the "Model chain" group in the model picker.',
        empty: 'No chain yet — create one.',
        addChain: 'New chain',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        name: 'Name',
        id: 'Model id',
        enabled: 'Enabled',
        members: 'Members (fallback order)',
        noMembers: 'No member yet — add one below.',
        addModel: 'Add a model…',
        remove: 'Remove',
        up: 'Move up',
        down: 'Move down',
        removeChain: 'Delete this chain',
        loading: 'Loading…',
        loadFailed: 'Load failed',
        retry: 'Retry',
        unsaved: 'Unsaved changes',
        hint: 'Members may come from any source: official DeepSeek, Our Free Model, or a relay. Chains cannot nest.',
        lastServed: 'Last served by: {model}',
        lastServedHop: 'Last served by: {model} (hop {hop})',
        neverServed: 'This chain has not been called yet',
        actual: 'Actual model',
      },
    }

    function makeT(ctx) {
      let bound = null
      try { bound = ctx.locale.bind(NS) } catch { bound = null }
      return key => {
        if (typeof bound === 'function') {
          try {
            const value = bound(key)
            if (typeof value === 'string' && value !== '' && value !== key) return value
          } catch { /* fall through */ }
        }
        return Object.prototype.hasOwnProperty.call(DICT.zh, key) ? DICT.zh[key] : key
      }
    }

    async function apiCall(path, init) {
      const response = await fetch(API + path, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      const text = await response.text()
      let payload = {}
      try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = {} }
      if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`)
      return payload
    }

    const clone = value => JSON.parse(JSON.stringify(value))

    /**
     * 输入框里的模型标签：链对外只有一个 ID，所以这里补一句「实际是哪一跳在答」。
     * 6 秒轮询一次本地 /last —— 每轮都可能换成员，这个信息只在本地进程间流动，
     * 代价就是一个小 GET。
     */
    function useLastServed(chainId, active) {
      const [observed, setObserved] = useState(null)
      useEffect(() => {
        if (active !== true || chainId === '') return undefined
        let alive = true
        const read = async () => {
          try {
            const payload = await apiCall('/last')
            if (!alive) return
            const entry = payload?.last && Object.hasOwn(payload.last, chainId) ? payload.last[chainId] : null
            setObserved({ chainId, entry: entry ?? null })
          } catch { /* 宿主没起来/路由没挂：静默保持原样 */ }
        }
        void read()
        const timer = setInterval(read, 6000)
        return () => { alive = false; clearInterval(timer) }
      }, [chainId, active])
      return active && observed?.chainId === chainId ? observed.entry : null
    }

    function shortName(modelId) {
      const text = String(modelId || '')
      const cut = text.indexOf('/')
      return cut >= 0 ? text.slice(cut + 1) : text
    }

    function ChainLabel(props) {
      const provider = props && props.provider ? props.provider : null
      const model = props && props.model ? props.model : null
      const mine = provider !== null && provider.id === ROUTE
      const member = useLastServed(mine && model !== null ? model.id : '', mine && (!props?.placement || props.placement === 'trigger'))

      // ⚠️ 这个座位是「单占位」：注册了就接管**所有** provider 的所有行
      //（触发按钮、根菜单当前值、每个可选模型行）。所以非本路由时**不能返回 null**，
      // 否则别人的模型行会整行空白 —— 这里必须原样把默认的「模型名」画回去。
      if (model === null || model === undefined) {
        return h('span', null, provider !== null && provider.name ? provider.name : '')
      }
      if (!mine) return h('span', { title: provider !== null && provider.name ? provider.name : undefined }, model.name)

      // 这里必须绝对安静：输入框的模型座位一旦抛错，整个输入区都会塌。
      try {
        return renderLabel()
      } catch (error) {
        return h('span', null, model && model.name ? model.name : '')
      }

      function renderLabel() {
        const placement = props && props.placement ? props.placement : 'trigger'
        // 弹出菜单/选项行里保持简洁：只写链名。
        if (placement === 'menu' || placement === 'option') return h('span', null, model.name)
        if (member === null) return h('span', null, model.name)
        const actual = shortName(member.model)
        const title = `${provider && provider.name ? provider.name : ROUTE} · ${model.name}\n最近服务：${member.provider} / ${member.model}`
        return h('span', { className: 'ofmc-label', title },
          model.name, h('span', { className: 'ofmc-label-member' }, ` · ${actual}`))
      }
    }

    function Page(props) {
      const t = props.t
      const [status, setStatus] = useState('loading')
      const [error, setError] = useState('')
      const [chains, setChains] = useState([])
      const [catalog, setCatalog] = useState([])
      const [dirty, setDirty] = useState(false)
      const [saving, setSaving] = useState(false)
      const [notice, setNotice] = useState('')
      const [noticeError, setNoticeError] = useState(false)

      const load = useCallback(async () => {
        setStatus('loading')
        setError('')
        try {
          const payload = await apiCall('/state')
          setChains(Array.isArray(payload.chains) ? clone(payload.chains) : [])
          setCatalog(Array.isArray(payload.catalog) ? payload.catalog : [])
          setStatus('ready')
          setDirty(false)
        } catch (failure) {
          setError(String((failure && failure.message) || failure))
          setStatus('error')
        }
      }, [])

      useEffect(() => { void load() }, [load])

      useEffect(() => {
        if (notice === '') return undefined
        const timer = setTimeout(() => setNotice(''), 2600)
        return () => clearTimeout(timer)
      }, [notice])

      const patch = useCallback(update => {
        setChains(previous => {
          const next = clone(previous)
          update(next)
          return next
        })
        setDirty(true)
      }, [])

      const save = useCallback(async () => {
        setSaving(true)
        setNoticeError(false)
        setNotice('')
        try {
          const payload = await apiCall('/state', { method: 'POST', body: JSON.stringify({ chains }) })
          setChains(Array.isArray(payload.chains) ? clone(payload.chains) : chains)
          setDirty(false)
          setNotice(t('saved'))
        } catch (failure) {
          setNoticeError(true)
          setNotice(String((failure && failure.message) || failure))
        } finally {
          setSaving(false)
        }
      }, [chains, t])

      const modelGroups = useMemo(() => catalog.filter(group => group && Array.isArray(group.models) && group.models.length > 0), [catalog])

      if (status === 'loading') return h('div', { className: 'ofmc-hint' }, t('loading'))
      if (status === 'error') {
        return h('div', { className: 'ofmc-hint' },
          `${t('loadFailed')}：${error}`,
          h('button', { className: 'ofmc-btn', style: { marginLeft: 8 }, onClick: () => void load() }, t('retry')))
      }

      const cards = chains.map((chain, chainIndex) => {
        const taken = new Set(chain.members.map(member => `${member.provider}\u0000${member.model}`))
        return h('section', { className: 'ofmc-card', key: chain.id || chainIndex },
          h('header', { className: 'ofmc-card-head' },
            h('div', { className: 'ofmc-card-title' },
              h('input', {
                className: 'ofmc-input ofmc-name',
                value: chain.name,
                'aria-label': t('name'),
                onChange: event => {
                  const value = event.target.value
                  patch(next => { next[chainIndex].name = value })
                },
              }),
              h('code', { className: 'ofmc-id', title: t('id') }, `${'model-chain'} / ${chain.id}`)),
            h('label', { className: 'ofmc-toggle' },
              h('input', {
                type: 'checkbox',
                checked: chain.enabled !== false,
                onChange: event => {
                  const value = event.target.checked
                  patch(next => { next[chainIndex].enabled = value })
                },
              }),
              h('span', null, t('enabled')))),
          chain.lastServed
            ? h('div', { className: 'ofmc-last' },
              (chain.lastServed.hop > 1 ? t('lastServedHop') : t('lastServed'))
                .replace('{model}', `${chain.lastServed.provider} / ${chain.lastServed.model}`)
                .replace('{hop}', String(chain.lastServed.hop)))
            : h('div', { className: 'ofmc-last empty' }, t('neverServed')),
          h('div', { className: 'ofmc-sub' }, t('members')),
          chain.members.length === 0
            ? h('div', { className: 'ofmc-hint small' }, t('noMembers'))
            : h('ol', { className: 'ofmc-members' }, chain.members.map((member, memberIndex) => {
              const group = modelGroups.find(item => item.id === member.provider)
              const model = group && group.models.find(item => item.id === member.model)
              return h('li', { className: 'ofmc-member', key: `${member.provider}:${member.model}` },
                h('span', { className: 'ofmc-step' }, String(memberIndex + 1)),
                h('span', { className: 'ofmc-member-name' }, model ? model.name : member.model,
                  h('span', { className: 'ofmc-member-src' }, group ? group.name : member.provider)),
                h('span', { className: 'ofmc-member-acts' },
                  h('button', {
                    className: 'ofmc-mini', title: t('up'), disabled: memberIndex === 0,
                    onClick: () => patch(next => {
                      const list = next[chainIndex].members
                      const [item] = list.splice(memberIndex, 1)
                      list.splice(memberIndex - 1, 0, item)
                    }),
                  }, '↑'),
                  h('button', {
                    className: 'ofmc-mini', title: t('down'), disabled: memberIndex === chain.members.length - 1,
                    onClick: () => patch(next => {
                      const list = next[chainIndex].members
                      const [item] = list.splice(memberIndex, 1)
                      list.splice(memberIndex + 1, 0, item)
                    }),
                  }, '↓'),
                  h('button', {
                    className: 'ofmc-mini danger', title: t('remove'),
                    onClick: () => patch(next => { next[chainIndex].members.splice(memberIndex, 1) }),
                  }, '×')))
            })),
          h('select', {
            className: 'ofmc-select',
            value: '',
            onChange: event => {
              const value = event.target.value
              if (value === '') return
              const [provider, model] = value.split('\u0000')
              patch(next => {
                const list = next[chainIndex].members
                if (!list.some(item => item.provider === provider && item.model === model)) list.push({ provider, model })
              })
              event.target.value = ''
            },
          },
          h('option', { value: '' }, t('addModel')),
          modelGroups.map(group => h('optgroup', { key: group.id, label: group.name },
            group.models.map(model => {
              const value = `${group.id}\u0000${model.id}`
              return h('option', { key: value, value, disabled: taken.has(value) }, taken.has(value) ? `${model.name}（已在链上）` : model.name)
            })))),
          chains.length > 1
            ? h('button', {
              className: 'ofmc-btn ghost danger',
              onClick: () => patch(next => { next.splice(chainIndex, 1) }),
            }, t('removeChain'))
            : null)
      })

      return h('div', { className: 'ofmc-page' },
        h('div', { className: 'ofmc-title' }, t('title')),
        h('p', { className: 'ofmc-desc' }, t('desc')),
        chains.length === 0 ? h('div', { className: 'ofmc-hint' }, t('empty')) : null,
        h('fieldset', { disabled: saving, style: { border: 0, padding: 0, margin: 0, minWidth: 0 } }, cards,
        h('div', { className: 'ofmc-actions' },
          h('button', {
            className: 'ofmc-btn',
            onClick: () => patch(next => {
              const base = 'chain'
              let n = next.length + 1
              const ids = new Set(next.map(item => item.id))
              while (ids.has(`${base}-${n}`)) n += 1
              next.push({ id: `${base}-${n}`, name: `链 ${n}`, enabled: true, members: [] })
            }),
          }, t('addChain')),
          h('button', { className: 'ofmc-btn primary', disabled: saving || !dirty, onClick: () => void save() },
            saving ? t('saving') : t('save')),
          dirty ? h('span', { className: 'ofmc-flag' }, t('unsaved')) : null,
          notice !== '' ? h('span', { role: noticeError ? 'alert' : 'status', className: noticeError ? 'ofmc-flag' : 'ofmc-flag ok' }, notice) : null)),
        h('p', { className: 'ofmc-hint small' }, t('hint')))
    }

    const CSS = `
.ofmc-label { white-space: nowrap; }
.ofmc-label-member { color: var(--dsw-alias-label-tertiary, #8b8f98); font-size: .92em; }
.ofmc-last { margin: 8px 0 0; font-size: 11.5px; color: var(--dsw-alias-state-business-primary, #6d8bff); }
.ofmc-last.empty { color: var(--dsw-alias-label-tertiary, #8b8f98); }
.ofmc-page { padding: 4px 2px 28px; font-size: 13px; line-height: 1.55; }
.ofmc-title { font-size: 15px; font-weight: 650; margin-bottom: 2px; }
.ofmc-desc { margin: 0 0 12px; color: var(--dsw-alias-label-tertiary, #8b8f98); font-size: 12.5px; max-width: 720px; }
.ofmc-card {
  border: 1px solid var(--dsw-alias-border-l2, rgba(140,148,164,.3));
  border-radius: 12px; padding: 10px 12px; margin: 10px 0;
  background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.03));
}
.ofmc-card-head { display: flex; align-items: center; gap: 10px; justify-content: space-between; }
.ofmc-card-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; flex: 1; }
.ofmc-input {
  border: 1px solid var(--dsw-alias-border-l2, rgba(140,148,164,.3)); border-radius: 7px;
  background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.15)); color: inherit;
  font: inherit; padding: 4px 8px;
}
.ofmc-name { min-width: 160px; flex: 0 0 auto; font-weight: 600; }
.ofmc-id { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8b8f98); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ofmc-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary, #c3c7cf); cursor: pointer; user-select: none; }
.ofmc-sub { margin: 10px 0 4px; font-size: 11px; font-weight: 600; letter-spacing: .5px; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, #8b8f98); }
.ofmc-members { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.ofmc-member { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 8px; background: var(--dsw-alias-bg-layer-3, rgba(255,255,255,.05)); }
.ofmc-step {
  flex: none; width: 18px; height: 18px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
  font-size: 10.5px; font-weight: 700; color: var(--dsw-alias-label-on-accent, #fff);
  background: var(--dsw-alias-state-business-primary, #4d6bfe);
}
.ofmc-member-name { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; overflow: hidden; }
.ofmc-member-src { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8b8f98); white-space: nowrap; }
.ofmc-member-acts { display: flex; gap: 2px; }
.ofmc-mini {
  width: 24px; height: 24px; border-radius: 6px; border: 1px solid transparent; background: transparent;
  color: var(--dsw-alias-label-secondary, #c3c7cf); font: inherit; font-size: 13px; line-height: 1; cursor: pointer;
}
.ofmc-mini:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
.ofmc-mini:disabled { opacity: .35; cursor: default; }
.ofmc-mini.danger:hover { background: var(--dsw-alias-state-error-primary, #e5484d); color: #fff; }
.ofmc-select {
  width: 100%; padding: 6px 8px; border-radius: 8px; font: inherit; font-size: 12.5px;
  border: 1px dashed var(--dsw-alias-border-l2, rgba(140,148,164,.35));
  background: transparent; color: var(--dsw-alias-label-secondary, #c3c7cf);
}
.ofmc-btn {
  padding: 5px 12px; border-radius: 8px; font: inherit; font-size: 12.5px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(140,148,164,.35));
  background: var(--dsw-alias-bg-layer-3, rgba(255,255,255,.05)); color: inherit;
}
.ofmc-btn:hover:not(:disabled) { border-color: var(--dsw-alias-state-business-primary, #4d6bfe); }
.ofmc-btn:disabled { opacity: .45; cursor: default; }
.ofmc-btn.primary { background: var(--dsw-alias-state-business-primary, #4d6bfe); border-color: transparent; color: var(--dsw-alias-label-on-accent, #fff); }
.ofmc-btn.ghost { background: transparent; }
.ofmc-btn.danger { color: var(--dsw-alias-state-error-primary, #e5484d); margin-top: 8px; }
.ofmc-actions { display: flex; align-items: center; gap: 8px; margin: 12px 0 4px; }
.ofmc-flag { font-size: 11.5px; color: var(--dsw-alias-state-warning-primary, #f5a623); }
.ofmc-flag.ok { color: var(--dsw-alias-state-success-primary, #30a46c); }
.ofmc-hint { color: var(--dsw-alias-label-tertiary, #8b8f98); font-size: 12px; }
.ofmc-hint.small { font-size: 11.5px; margin: 6px 0 0; }
`

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'model-chain: dictionaries')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-model-chain')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'model-chain: styles')

      const t = makeT(ctx)

      // ⚠️ 顺序与隔离都很重要：
      //   1. 设置分区先注册 —— 它是这个插件的主界面，任何时候都不该被别的贡献拖累；
      //   2. 每次注册各自 try/catch —— 插槽名在别的插件里是运行时才声明的
      //      （conversation.input.model.label 要等模型选择器挂上座位才存在），
      //      注册早了会抛错；一旦抛到 apply 外面，后面所有注册都不会发生。
      const contribute = (label, run) => {
        try { run() } catch (error) { try { console.warn(`[model-chain] ${label} 注册失败：${(error && error.message) || error}`) } catch { /* 无 console */ } }
      }

      contribute('settings.section', () => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'model-chain',
        order: 37,
        label: () => t('nav'),
        locale: NS,
      }, props => h(Page, { ...props, t }))))

      // 输入框里的模型标签：本路由补充成员信息，其它 provider 保留默认模型名。
      // 拿不到这个座位不影响任何东西 —— 真实成员在设置页和悬浮球里都还能看到。
      contribute('conversation.input.model.label', () => ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register({
        name: 'conversation.input.model.label',
        locale: NS,
      }, props => h(ChainLabel, props))))
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    exports.name = 'model-chain'
    exports.__test = { DICT, makeT }
    return module.exports
  },
})
