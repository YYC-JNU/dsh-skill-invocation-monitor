/**
 * dsh-skill-invocation-monitor — browser half (ModuleLoader bundle).
 *
 * Mounts two official slots and nothing else:
 *   - `sidebar.panellist` (list, id `skill-monitor`): the sidebar entry, whose
 *     glyph carries a live badge with the number of running skill calls;
 *   - `main` (keyed, key `skill-monitor`): the live panel. The sidebar owns the
 *     button, and by contract "each list id addresses the matching main panel",
 *     so the entry id and the main key must stay identical.
 *
 * Data reaches this half through one read-only GET route; there is no write
 * path in either direction. Rendered with React elements from the host's own
 * module table (no primitives package, no CSS file, no extra route), so a
 * missing optional dependency can never blank the panel.
 */
window.__ModuleLoader__.load({
  id: '@yyc-jnu/dsh-skill-invocation-monitor',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement

    /** Must match `sidebar.panellist` id AND the `main` key. */
    var ENTRY_ID = 'skill-monitor'
    /** Must match STATE_PATH in the host half. */
    var STATE_PATH = '/api/plugins/skill-monitor/state'
    var POLL_MS = 1500
    var TICK_MS = 1000

    var STATE = {
      running: { label: '运行中', color: 'var(--dsw-alias-state-success-primary, #22c55e)' },
      done: { label: '已完成', color: 'var(--dsw-alias-label-secondary, #8b93a1)' },
      failed: { label: '失败', color: 'var(--dsw-alias-state-error-primary, #e05252)' },
      unknown: { label: '未观测到结果', color: 'var(--dsw-alias-state-warn-primary, #e0a052)' },
    }

    var CSS = `
.dsim-panel{height:100%;overflow:auto;padding:16px 20px 28px;box-sizing:border-box;font-size:13px;color:var(--dsw-alias-label-primary,#e6e8ec);background:var(--dsw-alias-bg-base,#171a20)}
.dsim-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-bottom:12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25))}
.dsim-title{font-size:15px;font-weight:600;margin:0}
.dsim-sub{display:block;margin-top:4px;font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary,#8b93a1)}
.dsim-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsim-pill{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:999px;padding:1px 9px;font-size:11px;color:var(--dsw-alias-label-secondary,#8b93a1);white-space:nowrap}
.dsim-pill b{color:var(--dsw-alias-label-primary,#e6e8ec);font-weight:600}
.dsim-pill-live{border-color:var(--dsw-alias-state-success-primary,#22c55e);color:var(--dsw-alias-state-success-primary,#22c55e)}
.dsim-pill-live b{color:inherit}
.dsim-pill-bad{border-color:var(--dsw-alias-state-error-primary,#e05252);color:var(--dsw-alias-state-error-primary,#e05252)}
.dsim-pill-bad b{color:inherit}
.dsim-note{margin:10px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary,#8b93a1)}
.dsim-warn{margin:12px 0 0;padding:8px 10px;border-radius:6px;font-size:12px;color:var(--dsw-alias-state-warn-primary,#e0a052);border:1px solid var(--dsw-alias-state-warn-primary,#e0a052)}
.dsim-empty{padding:56px 8px;text-align:center;line-height:1.8;color:var(--dsw-alias-label-secondary,#8b93a1)}
.dsim-group{margin-top:14px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04))}
.dsim-grouphead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}
.dsim-grouphead b{font-size:13px;font-weight:600}
.dsim-sid{font-family:Consolas,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#8b93a1)}
.dsim-tag{border-radius:4px;padding:0 6px;font-size:11px;background:rgba(127,127,127,.16);color:var(--dsw-alias-label-secondary,#8b93a1)}
.dsim-tag-live{background:transparent;border:1px solid var(--dsw-alias-state-success-primary,#22c55e);color:var(--dsw-alias-state-success-primary,#22c55e)}
.dsim-spacer{flex:1}
.dsim-none{padding:14px 12px;font-size:12px;color:var(--dsw-alias-label-secondary,#8b93a1)}
table.dsim-table{width:100%;border-collapse:collapse;font-size:12px}
.dsim-table th{text-align:left;padding:7px 12px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#8b93a1);border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}
.dsim-table td{padding:7px 12px;border-bottom:1px solid rgba(127,127,127,.1);vertical-align:middle}
.dsim-table tr:last-child td{border-bottom:none}
.dsim-state{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.dsim-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none}
.dsim-skill{font-family:Consolas,Menlo,monospace;font-size:12px}
.dsim-src{margin-left:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));border-radius:4px;padding:0 5px;font-size:10px;color:var(--dsw-alias-label-secondary,#8b93a1)}
.dsim-mono{font-family:Consolas,Menlo,monospace;font-variant-numeric:tabular-nums}
.dsim-clock{font-family:Consolas,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#8b93a1)}
.dsim-err{margin-top:2px;font-size:11px;color:var(--dsw-alias-state-error-primary,#e05252);word-break:break-all}
.dsim-ico{position:relative;display:inline-flex;align-items:center;justify-content:center}
.dsim-badge{position:absolute;top:-4px;right:-6px;min-width:14px;height:14px;padding:0 3px;box-sizing:border-box;border-radius:999px;background:var(--dsw-alias-state-success-primary,#22c55e);color:#06120a;font-size:9px;font-weight:700;line-height:14px;text-align:center}
`

    // ---- one shared store: poll once, fan out to every mounted component ---
    var store = { snapshot: null, error: null, at: 0 }
    var listeners = new Set()
    var pollTimer = null
    var inflight = false

    function publish() {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          console.error('[skill-monitor] subscriber failed:', error)
        }
      }
    }

    function subscribe(listener) {
      listeners.add(listener)
      return function () {
        listeners.delete(listener)
      }
    }

    function fetchState() {
      if (inflight) return
      inflight = true
      fetch(STATE_PATH, { cache: 'no-store' })
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status)
          return response.json()
        })
        .then(function (json) {
          store.snapshot = json
          store.error = null
          store.at = Date.now()
        })
        .catch(function (error) {
          store.error = String((error && error.message) || error)
        })
        .then(function () {
          inflight = false
          publish()
        })
    }

    function ensurePolling() {
      if (pollTimer !== null) return
      fetchState()
      pollTimer = setInterval(fetchState, POLL_MS)
    }

    function stopPolling() {
      if (pollTimer === null) return
      clearInterval(pollTimer)
      pollTimer = null
    }

    function useSnapshot() {
      var state = React.useState(0)
      var bump = state[1]
      React.useEffect(function () {
        return subscribe(function () {
          bump(function (n) {
            return n + 1
          })
        })
      }, [])
      return store
    }

    /** Re-render on a fixed tick so a running duration grows between polls. */
    function useTick(intervalMs) {
      var state = React.useState(0)
      var bump = state[1]
      React.useEffect(function () {
        var id = setInterval(function () {
          bump(function (n) {
            return n + 1
          })
        }, intervalMs)
        return function () {
          clearInterval(id)
        }
      }, [])
    }

    // ---- formatting ------------------------------------------------------
    function formatDuration(ms) {
      if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—'
      if (ms < 1000) return Math.round(ms) + 'ms'
      var seconds = ms / 1000
      if (seconds < 60) return seconds.toFixed(1) + 's'
      var minutes = Math.floor(seconds / 60)
      if (minutes < 60) return minutes + 'm' + String(Math.floor(seconds % 60)).padStart(2, '0') + 's'
      return Math.floor(minutes / 60) + 'h' + String(minutes % 60).padStart(2, '0') + 'm'
    }

    function formatClock(epoch) {
      if (typeof epoch !== 'number' || !isFinite(epoch) || epoch <= 0) return '—'
      var date = new Date(epoch)
      return [date.getHours(), date.getMinutes(), date.getSeconds()]
        .map(function (part) {
          return String(part).padStart(2, '0')
        })
        .join(':')
    }

    function shortId(id) {
      if (typeof id !== 'string' || id.length === 0) return '—'
      return id.length > 16 ? id.slice(0, 12) + '…' : id
    }

    function groupTitle(group) {
      if (typeof group.title === 'string' && group.title.length > 0) return group.title
      return group.live ? '未命名会话' : '已结束的 Agent'
    }

    function runningCount(snapshot) {
      return snapshot && snapshot.totals ? snapshot.totals.running || 0 : 0
    }

    function statusOf(call) {
      return STATE[call.status] || STATE.unknown
    }

    function durationOf(call, now) {
      if (typeof call.durationMs === 'number' && call.status !== 'running') return call.durationMs
      return Math.max(0, now - call.startedAt)
    }

    function dot(color) {
      return h('span', { className: 'dsim-dot', style: { background: color } })
    }

    // ---- sidebar entry: glyph + live badge -------------------------------
    function PanelIcon(props) {
      var storeState = useSnapshot()
      var size = props && typeof props.size === 'number' ? props.size : 18
      var running = runningCount(storeState.snapshot)
      var stroke = props && props.active ? 'var(--dsw-alias-brand-primary, #3f92fe)' : 'currentColor'
      var glyph = h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: stroke,
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          'aria-hidden': 'true',
        },
        h('circle', { key: 'root', cx: 8, cy: 3.2, r: 1.5 }),
        h('circle', { key: 'left', cx: 3.6, cy: 12.4, r: 1.5 }),
        h('circle', { key: 'right', cx: 12.4, cy: 12.4, r: 1.5 }),
        h('path', { key: 'links', d: 'M8 4.7v2.6M8 7.3H3.6v3.6M8 7.3h4.4v3.6' }),
      )
      return h(
        'span',
        { className: 'dsim-ico', style: { width: size + 'px', height: size + 'px' }, title: '技能调用监控' },
        glyph,
        running > 0 ? h('span', { className: 'dsim-badge' }, running > 99 ? '99+' : String(running)) : null,
      )
    }

    // ---- main panel: live list -------------------------------------------
    function SkillPanel() {
      var storeState = useSnapshot()
      useTick(TICK_MS)
      var snapshot = storeState.snapshot
      var now = Date.now()
      var totals = snapshot && snapshot.totals ? snapshot.totals : null
      var agents = snapshot && Array.isArray(snapshot.agents) ? snapshot.agents : null

      var header = h(
        'div',
        { className: 'dsim-head' },
        h(
          'div',
          null,
          h('h2', { className: 'dsim-title' }, '技能调用监控'),
          h(
            'span',
            { className: 'dsim-sub' },
            '只读 · 数据仅在宿主内存 · 追踪 ' + ((snapshot && snapshot.policy && snapshot.policy.trackedTool) || 'skill') + ' 工具与用户技能调用',
          ),
        ),
        h(
          'div',
          { className: 'dsim-meta' },
          h('span', { className: 'dsim-pill' }, 'Agent ', h('b', null, totals ? String(totals.agents) : '—')),
          h('span', { className: 'dsim-pill dsim-pill-live' }, '运行中 ', h('b', null, totals ? String(totals.running) : '—')),
          h('span', { className: 'dsim-pill' }, '已完成 ', h('b', null, totals ? String(totals.done) : '—')),
          h('span', { className: 'dsim-pill dsim-pill-bad' }, '失败 ', h('b', null, totals ? String(totals.failed) : '—')),
          totals && totals.byUser > 0
            ? h('span', { className: 'dsim-pill' }, '用户触发 ', h('b', null, String(totals.byUser)))
            : null,
          h('span', { className: 'dsim-clock' }, '更新于 ' + (storeState.at > 0 ? formatClock(storeState.at) : '—')),
        ),
      )

      var body = null
      if (storeState.error !== null) {
        body = h('div', { className: 'dsim-warn' }, '无法读取宿主状态：' + storeState.error + '（宿主半加载后路由才存在；改动宿主半需要重启 DSH）')
      } else if (snapshot === null) {
        body = h('div', { className: 'dsim-empty' }, '加载中…')
      } else if (agents === null || agents.length === 0) {
        body = h(
          'div',
          { className: 'dsim-empty' },
          '暂无活动 Agent。',
          h('br'),
          '当有会话在运行时，其 Agent 会出现在这里；模型调用 skill 工具、或你在会话里手动执行同名命令时，都会记录一次技能调用。',
        )
      } else {
        body = h('div', null, agents.map(function (group) {
          return h(AgentGroup, { key: group.id, group: group, now: now })
        }))
      }

      return h(
        'div',
        { className: 'dsim-panel' },
        header,
        h('p', { className: 'dsim-note' }, '本插件不注册工具、不修改会话、不拦截任何调用；仅观察事件并聚合展示，关闭或卸载后数据即刻消失。'),
        body,
      )
    }

    function AgentGroup(props) {
      var group = props.group
      var now = props.now
      var calls = Array.isArray(group.calls) ? group.calls : []
      var isLive = group.status === 'running' || group.running > 0
      return h(
        'section',
        { className: 'dsim-group' },
        h(
          'div',
          { className: 'dsim-grouphead' },
          dot(isLive ? STATE.running.color : 'var(--dsw-alias-state-idle-primary, #6b7280)'),
          h('b', null, groupTitle(group)),
          h('span', { className: 'dsim-sid' }, shortId(group.id)),
          h('span', { className: isLive ? 'dsim-tag dsim-tag-live' : 'dsim-tag' }, isLive ? '运行中' : '空闲'),
          h('span', { className: 'dsim-spacer' }),
          h('span', { className: 'dsim-clock' }, '技能调用 ' + String(group.callCount || 0) + ' 次'),
        ),
        calls.length === 0
          ? h('div', { className: 'dsim-none' }, '未观察到技能调用')
          : h(
              'table',
              { className: 'dsim-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', { style: { width: '132px' } }, '状态'),
                  h('th', null, 'Skill'),
                  h('th', { style: { width: '92px' } }, '调用时长'),
                  h('th', { style: { width: '72px' } }, '时间'),
                ),
              ),
              h(
                'tbody',
                null,
                calls.map(function (call) {
                  var status = statusOf(call)
                  var running = call.status === 'running'
                  return h(
                    'tr',
                    { key: call.id },
                    h(
                      'td',
                      null,
                      h('span', { className: 'dsim-state', style: { color: status.color } }, dot(status.color), status.label),
                      call.error ? h('div', { className: 'dsim-err' }, call.error) : null,
                    ),
                    h(
                      'td',
                      null,
                      h('span', { className: 'dsim-skill' }, call.skill),
                      call.origin === 'user'
                        ? h('span', { className: 'dsim-src', title: '你在会话里手动触发的技能' }, '用户触发')
                        : null,
                    ),
                    h('td', null, h('span', { className: 'dsim-mono' }, formatDuration(durationOf(call, now)))),
                    h(
                      'td',
                      null,
                      h('span', { className: 'dsim-clock' }, running ? '起 ' + formatClock(call.startedAt) : formatClock(call.endedAt)),
                    ),
                  )
                }),
              ),
            ),
      )
    }

    // ---- plugin body -----------------------------------------------------
    /** No client service is required up front; `slots` is reached through a
     * scoped inject so the entry simply never appears where it does not exist. */
    var inject = []

    function ensureStyle() {
      if (document.querySelector('style[data-dsh-skill-monitor]') !== null) return
      var style = document.createElement('style')
      style.setAttribute('data-dsh-skill-monitor', '')
      style.textContent = CSS
      ;(document.head ?? document.documentElement).appendChild(style)
    }

    function apply(ctx) {
      ensureStyle()
      ensurePolling()
      if (typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return stopPolling
        }, 'skill-monitor: state polling')
      }
      if (typeof ctx.inject !== 'function') return
      ctx.inject(['slots'], function (scope) {
        scope.slots.inject('sidebar.panellist', function* () {
          yield scope.slots.register(
            { name: 'sidebar.panellist', id: ENTRY_ID, order: 30, label: function () { return '技能监控' } },
            PanelIcon,
          )
        })
        scope.slots.inject('main', function* () {
          yield scope.slots.register({ name: 'main', key: ENTRY_ID }, SkillPanel)
        })
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})