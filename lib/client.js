/**
 * dsh-orch —— 客户端面板（Web UI 半边）。
 *
 * 交付形态与本机约定一致（**无需构建**：手写 CJS 信封 + `require` 白名单）：
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 *
 * 座位：宿主**右侧边栏页签**：
 *   ① `ctx.inject(['sidebarRightTabs'])` → `tabs.register({ id, kind, title, guide })`；
 *   ② `ctx.slots.inject('sidebar.right.pane.tab', …)` 注册页签主体；
 *   ③ `ctx.slots.inject('sidebar.right.pane.tab.title', …)` 注册标题。
 * 三条纪律：`id`/`kind` 必须全局唯一；读服务必须**按属性读**（`scoped.sidebarRightTabs`，
 * `ctx.get` 对未 inject 的服务会抛）；只 register 不 openTab 时「页签在但没人看见」。
 *
 * 这一屏只做一件事：**按工作区开关自动分诊**。开关状态由宿主侧 `setWorkspaceRouterEnabled`
 * 落盘，面板通过 `/dsh-orch/api/workspaces` 读写同一份数据——所以面板改动与
 * `orch_workspace` 工具完全等价，不会出现两套真相。
 */
window.__ModuleLoader__.load({
  id: 'dsh-orch',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/dsh-orch/api'
    const TYPE_ID = 'dsh-orch:panel'
    const KIND = 'dsh-orch:triage'
    const STYLE_ID = 'dsh-orch-styles'
    const POLL_MS = 20000

    const TOKEN = {
      text: 'var(--dsw-alias-label-primary, #e6e6e6)',
      dim: 'var(--dsw-alias-label-secondary, #9a9a9a)',
      faint: 'var(--dsw-alias-label-tertiary, #777)',
      border: 'var(--dsw-alias-border-l2, #333)',
      card: 'var(--dsw-alias-bg-layer-1, #1b1b1f)',
      cardAlt: 'var(--dsw-alias-bg-layer-2, #232329)',
      brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      ok: 'var(--dsw-alias-state-success-primary, #3fb950)',
      warn: 'var(--color-amber-500, #d29922)',
      err: 'var(--dsw-alias-state-error-primary, #f85149)',
    }

    function injectStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
.dsh-orch-root{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;height:100%;color:${TOKEN.text};font-size:12px;gap:10px;padding:12px;box-sizing:border-box}
.dsh-orch-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.dsh-orch-title{font-size:13px;font-weight:650}
.dsh-orch-sub{color:${TOKEN.dim};font-size:11px}
.dsh-orch-meta{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
.dsh-orch-chip{background:${TOKEN.cardAlt};border:1px solid ${TOKEN.border};border-radius:999px;padding:1px 8px;font-size:10.5px;color:${TOKEN.dim}}
.dsh-orch-list{display:flex;flex-direction:column;gap:6px;overflow-y:auto;min-height:0;scrollbar-width:thin}
.dsh-orch-row{display:flex;align-items:center;gap:10px;background:${TOKEN.card};border:1px solid ${TOKEN.border};border-radius:9px;padding:9px 11px;box-sizing:border-box}
.dsh-orch-row:hover{border-color:color-mix(in srgb, ${TOKEN.brand} 40%, ${TOKEN.border})}
.dsh-orch-row-main{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 auto}
.dsh-orch-path{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:11px;color:${TOKEN.text};word-break:break-all;line-height:1.35}
.dsh-orch-stats{display:flex;gap:8px;flex-wrap:wrap;color:${TOKEN.dim};font-size:10.5px;font-variant-numeric:tabular-nums}
.dsh-orch-stat b{color:${TOKEN.text};font-weight:600}
.dsh-orch-dot{width:7px;height:7px;border-radius:50%;flex:none}
.dsh-orch-dot-on{background:${TOKEN.ok}}
.dsh-orch-dot-off{background:${TOKEN.faint}}
.dsh-orch-switch{position:relative;flex:none;width:34px;height:19px;border-radius:999px;border:1px solid ${TOKEN.border};background:${TOKEN.cardAlt};cursor:pointer;padding:0;transition:background .18s ease,border-color .18s ease}
.dsh-orch-switch[data-on="true"]{background:color-mix(in srgb, ${TOKEN.brand} 78%, transparent);border-color:${TOKEN.brand}}
.dsh-orch-switch:disabled{opacity:.55;cursor:default}
.dsh-orch-knob{position:absolute;top:1px;left:1px;width:15px;height:15px;border-radius:50%;background:#fff;transition:transform .18s ease;display:block}
.dsh-orch-switch[data-on="true"] .dsh-orch-knob{transform:translateX(15px)}
.dsh-orch-empty{color:${TOKEN.dim};padding:14px 4px;font-size:11.5px;line-height:1.6}
.dsh-orch-err{color:${TOKEN.err};font-size:11.5px;line-height:1.6;word-break:break-all}
.dsh-orch-foot{color:${TOKEN.faint};font-size:10.5px;line-height:1.55;border-top:1px dashed ${TOKEN.border};padding-top:8px}
.dsh-orch-bar{display:flex;align-items:center;gap:8px}
.dsh-orch-btn{font:inherit;font-size:11px;color:${TOKEN.dim};background:transparent;border:1px solid ${TOKEN.border};border-radius:6px;padding:3px 9px;cursor:pointer}
.dsh-orch-btn:hover{color:${TOKEN.text};border-color:${TOKEN.brand}}
.dsh-orch-btn:disabled{opacity:.5;cursor:default}
`
      document.head.appendChild(style)
    }

    function apiGet(path) {
      return fetch(`${API}${path}`, { headers: { accept: 'application/json' } }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
    }

    function apiPost(path, body) {
      return fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(async (r) => {
        const payload = await r.json().catch(() => ({}))
        if (!r.ok || payload?.ok === false) throw new Error(payload?.error ?? `HTTP ${r.status}`)
        return payload
      })
    }

    function Stat({ label, value, tone }) {
      return h('span', { className: 'dsh-orch-stat' },
        label, ' ',
        h('b', tone ? { style: { color: tone } } : null, String(value)),
      )
    }

    function Row({ item, busy, onToggle }) {
      const counts = item.candidates ?? {}
      const pending = counts.pending ?? 0
      const muted = counts.muted ?? 0
      const routed = counts.routed ?? 0
      return h('div', { className: 'dsh-orch-row' },
        h('span', {
          className: `dsh-orch-dot ${item.routerEnabled ? 'dsh-orch-dot-on' : 'dsh-orch-dot-off'}`,
          title: item.routerEnabled ? '自动分诊已开启' : '自动分诊已关闭',
        }),
        h('div', { className: 'dsh-orch-row-main' },
          h('div', { className: 'dsh-orch-path', title: item.workspace }, item.label || item.workspace),
          h('div', { className: 'dsh-orch-stats' },
            pending > 0
              ? h(Stat, { label: '待分诊', value: pending, tone: TOKEN.warn })
              : h(Stat, { label: '待分诊', value: 0 }),
            routed > 0 ? h(Stat, { label: '已成单', value: routed, tone: TOKEN.brand }) : null,
            muted > 0 ? h(Stat, { label: '已静音', value: muted }) : null,
            item.routerRunning ? h('span', { style: { color: TOKEN.ok } }, 'router 运行中') : null,
          ),
        ),
        h('button', {
          type: 'button',
          className: 'dsh-orch-switch',
          'data-on': item.routerEnabled ? 'true' : 'false',
          disabled: busy,
          title: item.routerEnabled ? '点击关闭该工作区的自动分诊' : '点击开启该工作区的自动分诊',
          onClick: () => onToggle(item, !item.routerEnabled),
        }, h('span', { className: 'dsh-orch-knob' })),
      )
    }

    function Panel() {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(null)
      const [loading, setLoading] = useState(false)
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

      const load = useCallback(async (showSpinner) => {
        if (showSpinner) setLoading(true)
        try {
          const payload = await apiGet('/workspaces')
          if (!alive.current) return
          setData(payload)
          setError(null)
        } catch (e) {
          if (!alive.current) return
          setError(String(e?.message ?? e))
        } finally {
          if (alive.current && showSpinner) setLoading(false)
        }
      }, [])

      useEffect(() => {
        injectStyles()
        load(true)
        const timer = setInterval(() => { load(false) }, POLL_MS)
        return () => clearInterval(timer)
      }, [load])

      const onToggle = useCallback(async (item, enabled) => {
        setBusy(item.workspace)
        // 乐观更新：先翻 UI，失败再回滚——开关这种东西等一次往返会显得很卡
        setData((prev) => prev ? {
          ...prev,
          workspaces: prev.workspaces.map((w) => w.workspace === item.workspace ? { ...w, routerEnabled: enabled } : w),
        } : prev)
        try {
          await apiPost('/workspaces', { workspace: item.workspace, enabled })
          await load(false)
        } catch (e) {
          setError(String(e?.message ?? e))
          await load(false)
        } finally {
          if (alive.current) setBusy(null)
        }
      }, [load])

      const workspaces = data?.workspaces ?? []
      const enabledCount = workspaces.filter((w) => w.routerEnabled).length

      return h('div', { className: 'dsh-orch-root' },
        h('div', { className: 'dsh-orch-head' },
          h('span', { className: 'dsh-orch-title' }, '自动分诊'),
          h('span', { className: 'dsh-orch-sub' }, '按工作区开关'),
          h('div', { className: 'dsh-orch-meta' },
            h('span', { className: 'dsh-orch-chip' }, `开启 ${enabledCount}/${workspaces.length}`),
            data?.autoDispatch ? h('span', { className: 'dsh-orch-chip' }, 'accept 自动派发') : null,
            data?.routerEnabled === false ? h('span', { className: 'dsh-orch-chip' }, '全局已关') : null,
          ),
        ),

        error ? h('div', { className: 'dsh-orch-err' }, `读取失败：${error}`) : null,

        loading && !data
          ? h('div', { className: 'dsh-orch-empty' }, '读取中…')
          : workspaces.length === 0
            ? h('div', { className: 'dsh-orch-empty' }, '还没有任何工作区记录。在某个会话里干过活之后，这里会出现对应的工作区。')
            : h('div', { className: 'dsh-orch-list' },
                workspaces.map((item) => h(Row, {
                  key: item.workspace,
                  item,
                  busy: busy === item.workspace,
                  onToggle,
                })),
              ),

        h('div', { className: 'dsh-orch-bar' },
          h('button', {
            type: 'button',
            className: 'dsh-orch-btn',
            disabled: loading,
            onClick: () => { load(true) },
          }, loading ? '刷新中…' : '刷新'),
        ),

        h('div', { className: 'dsh-orch-foot' },
          '关掉的工作区不会再为它起任何 router，它的事件被直接忽略（连账本都不读）。',
          '手动全量扫描仍能看到它的候选，但会标成「静音」不自动分诊。',
        ),
      )
    }

    return {
      name: 'dsh-orch',
      // 只 inject 真正用到的：slots 是注册座位的基础，sidebarRightTabs 是页签类型注册表
      inject: ['slots', 'sidebarRightTabs'],
      apply(ctx) {
        if (typeof document === 'undefined') return
        let disposeTab

        // ① 页签类型：这一步才让「自动分诊」出现在侧边栏的页签表里
        try {
          ctx.inject(['sidebarRightTabs'], (scoped) => {
            const tabs = scoped.sidebarRightTabs ?? (typeof scoped.get === 'function' ? scoped.get('sidebarRightTabs') : undefined)
            if (!tabs || typeof tabs.register !== 'function') return undefined
            const dispose = tabs.register({
              id: TYPE_ID,
              kind: KIND,
              title: () => '自动分诊',
              guide: [
                {
                  id: 'dsh-orch',
                  order: 43,
                  title: () => '自动分诊',
                  description: () => '按工作区开关自动找出「没闭合的事」，开关即时生效',
                },
              ],
            })
            disposeTab = dispose
            return () => {
              disposeTab = undefined
              dispose?.()
            }
          })
        } catch (error) {
          console.warn(`[dsh-orch] 侧边栏页签注册失败（降级为仅工具面）：${error && error.message}`)
        }

        // ② 页签主体
        ctx.effect(
          () => ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              { name: 'sidebar.right.pane.tab', key: TYPE_ID },
              (props) => h(Panel, props ?? {}),
            ),
          ),
          'dsh-orch: sidebar pane body',
        )

        // ③ 页签标题
        ctx.effect(
          () => ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TYPE_ID }, () => h('span', null, '自动分诊')),
          ),
          'dsh-orch: sidebar pane title',
        )

        ctx.effect(() => () => {
          try { disposeTab?.() } catch { /* ignore */ }
        }, 'dsh-orch: teardown')
      },
    }
  },
})

