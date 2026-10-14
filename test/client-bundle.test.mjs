/**
 * Client-half tests. The bundle is loaded exactly the way the shell loads it —
 * a `window.__ModuleLoader__.load({ id, factory })` call — but with a hand-made
 * `require`, React shim, DOM stub and fetch stub, so the slot registrations and
 * the rendered output are verified without a browser.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const PACKAGE_NAME = '@yyc-jnu/dsh-skill-invocation-monitor'
const STATE_PATH = '/api/plugins/skill-monitor/state'

const ReactShim = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
  },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
}

/** Render one function component (the shim has no reconciler) so the tree is walkable. */
function resolve(node) {
  if (node !== null && typeof node === 'object' && !Array.isArray(node) && typeof node.type === 'function') {
    return resolve(node.type(node.props))
  }
  return node
}

/** Every string inside a rendered element tree, in order. */
function textOf(node, out = []) {
  const current = resolve(node)
  if (current === null || current === undefined || current === false || current === true) return out
  if (typeof current === 'string' || typeof current === 'number') {
    out.push(String(current))
    return out
  }
  if (Array.isArray(current)) {
    for (const child of current) textOf(child, out)
    return out
  }
  if (typeof current === 'object' && current.props !== undefined) textOf(current.props.children, out)
  return out
}

/** Every element in a rendered tree with the given className. */
function findByClass(node, className, out = []) {
  const current = resolve(node)
  if (current === null || typeof current !== 'object') return out
  if (Array.isArray(current)) {
    for (const child of current) findByClass(child, className, out)
    return out
  }
  if (current.props !== undefined) {
    if (current.props.className === className) out.push(current)
    findByClass(current.props.children, className, out)
  }
  return out
}

/** A live snapshot with timestamps relative to now, so durations are stable. */
function snapshot() {
  const now = Date.now()
  return {
    ok: true,
    at: now,
    agents: [
      {
        id: 'session-a',
        title: '示例会话标题',
        status: 'running',
        live: true,
        running: 1,
        callCount: 2,
        calls: [
          { id: 'c2', origin: 'model', skill: 'tdd', status: 'running', startedAt: now - 1_200, endedAt: null, durationMs: 1_200, error: null },
          { id: 'm-1', origin: 'user', skill: 'code-review', status: 'failed', startedAt: now - 9_000, endedAt: now - 4_000, durationMs: 5_000, error: 'skill not found' },
        ],
      },
    ],
    totals: { agents: 1, running: 1, done: 0, failed: 1, unknown: 0, byUser: 1, byModel: 1 },
    policy: {
      readOnly: true,
      trackedTool: 'skill',
      trackedUserPath: 'skill-invocation user messages (window closes at turn/end)',
      retentionMs: 600_000,
      staleMs: 900_000,
      maxRecords: 200,
    },
  }
}

function loadBundle(response) {
  const registered = []
  const injected = []
  const intervals = []
  const fetches = []
  let moduleExports = null

  const fakeDocument = {
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
    querySelector: () => null,
    createElement: () => ({ setAttribute() {}, textContent: '' }),
  }
  const windowStub = {
    __ModuleLoader__: {
      load(spec) {
        assert.equal(spec.id, PACKAGE_NAME, 'the bundle id must be the package name')
        moduleExports = spec.factory((id) => {
          if (id === 'react') return ReactShim
          throw new Error(`unexpected require: ${id}`)
        })
      },
    },
  }
  const fetchStub = (url, init) => {
    fetches.push({ url, init })
    if (response instanceof Error) return Promise.reject(response)
    if (typeof response === 'number') {
      return Promise.resolve({ ok: false, status: response, json: () => Promise.resolve(null) })
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(response) })
  }

  const run = new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', 'console', SOURCE)
  run(
    windowStub,
    fakeDocument,
    fetchStub,
    (callback, ms) => {
      intervals.push({ callback, ms })
      return intervals.length
    },
    () => {},
    { error: () => {} },
  )

  const slots = {
    inject(slotName, callback) {
      const iterator = callback()
      if (iterator !== undefined && typeof iterator.next === 'function') {
        let step = iterator.next()
        while (step.done !== true) step = iterator.next()
      }
    },
    register(descriptor, component) {
      registered.push({ descriptor, component })
      return () => {}
    },
  }
  const scope = { slots, effect: (fn) => fn() }
  const ctx = {
    inject(names, callback) {
      injected.push(names)
      callback(scope)
    },
    effect: (fn) => fn(),
  }
  return { exports: moduleExports, ctx, registered, injected, intervals, fetches }
}

const componentFor = (registered, slotName) => {
  const entry = registered.find((item) => item.descriptor.name === slotName)
  assert.ok(entry, `${slotName} was registered`)
  return entry
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const textOfPanel = (bundle) => textOf(componentFor(bundle.registered, 'main').component()).join(' ')

test('the bundle exports the plugin contract and mounts both slots', () => {
  const bundle = loadBundle(snapshot())
  assert.equal(typeof bundle.exports.apply, 'function')
  assert.ok(Array.isArray(bundle.exports.inject))
  assert.deepEqual(bundle.exports.inject, [], 'the fiber waits for no client service')

  bundle.exports.apply(bundle.ctx)
  assert.deepEqual(bundle.injected, [['slots']])
  assert.equal(bundle.registered.length, 2, 'exactly two registrations, both into declared slots')

  const sidebar = componentFor(bundle.registered, 'sidebar.panellist')
  const main = componentFor(bundle.registered, 'main')
  assert.equal(sidebar.descriptor.id, 'skill-monitor')
  assert.equal(sidebar.descriptor.order, 30)
  assert.equal(typeof sidebar.descriptor.label, 'function')
  assert.equal(sidebar.descriptor.label(), '技能监控')
  assert.equal(main.descriptor.key, 'skill-monitor', 'the main key must equal the sidebar list id')
  assert.equal(main.descriptor.key, sidebar.descriptor.id)
  assert.equal(typeof sidebar.component, 'function')
  assert.equal(typeof main.component, 'function')
})

test('apply() starts one poll and reads the state route over a plain GET', async () => {
  const bundle = loadBundle(snapshot())
  bundle.exports.apply(bundle.ctx)
  assert.equal(bundle.intervals.length, 1, 'one shared timer, not one per component')
  assert.equal(bundle.intervals[0].ms, 1500)
  assert.equal(bundle.fetches[0].url, STATE_PATH)
  assert.equal(bundle.fetches[0].init.method, undefined, 'a read is a plain GET')
  assert.equal(bundle.fetches[0].init.body, undefined, 'the request carries no body')
  assert.equal(bundle.fetches[0].init.cache, 'no-store')
  await settle()
})

test('the panel renders the live list: agent title, skill, status and duration', async () => {
  const bundle = loadBundle(snapshot())
  bundle.exports.apply(bundle.ctx)
  await settle()

  const text = textOfPanel(bundle)
  assert.match(text, /技能调用监控/)
  assert.match(text, /示例会话标题/, 'the Agent shows its session title')
  assert.match(text, /tdd/)
  assert.match(text, /code-review/)
  assert.match(text, /运行中/)
  assert.match(text, /失败/)
  assert.match(text, /skill not found/)
  assert.match(text, /1\.2s/, 'a running duration is rendered live')
  assert.match(text, /5\.0s/, 'a settled duration is rendered')
  assert.match(text, /更新于 \d{2}:\d{2}:\d{2}/, 'the as-of clock is rendered')
  assert.match(text, /只读/, 'the read-only badge is visible')
  assert.match(text, /1 次|2 次/, 'the per-agent call count is rendered')
  assert.match(text, /用户技能调用/, 'the header names both invocation paths')
  assert.match(text, /用户触发/, 'the by-user total is shown when it is non-zero')

  // Only the user-origin row carries the origin badge; the model row stays clean.
  const badges = findByClass(componentFor(bundle.registered, 'main').component(), 'dsim-src')
  assert.equal(badges.length, 1)
  assert.equal(badges[0].props.children, '用户触发')
  assert.match(String(badges[0].props.title), /手动触发/, 'the badge explains itself on hover')
})

test('the sidebar entry carries a live badge with the running count', async () => {
  const bundle = loadBundle(snapshot())
  bundle.exports.apply(bundle.ctx)
  await settle()

  const icon = componentFor(bundle.registered, 'sidebar.panellist').component
  const tree = icon({ size: 18, active: true })
  const badges = findByClass(tree, 'dsim-badge')
  assert.equal(badges.length, 1)
  assert.equal(badges[0].props.children, '1')
  assert.equal(findByClass(tree, 'dsim-ico')[0].props.style.width, '18px')
})

test('the sidebar entry has no badge while nothing is running', async () => {
  const idle = snapshot()
  idle.agents[0].status = 'idle'
  idle.agents[0].running = 0
  idle.agents[0].calls = [idle.agents[0].calls[1]]
  idle.totals = { agents: 1, running: 0, done: 0, failed: 1, unknown: 0 }

  const bundle = loadBundle(idle)
  bundle.exports.apply(bundle.ctx)
  await settle()

  const tree = componentFor(bundle.registered, 'sidebar.panellist').component({ size: 18 })
  assert.equal(findByClass(tree, 'dsim-badge').length, 0)
  assert.match(textOfPanel(bundle), /示例会话标题/)
})

test('an agent without a title falls back to a readable label', async () => {
  const unnamed = snapshot()
  unnamed.agents[0].title = null
  const bundle = loadBundle(unnamed)
  bundle.exports.apply(bundle.ctx)
  await settle()
  assert.match(textOfPanel(bundle), /未命名会话/)
})

test('a state with no agents renders an empty state instead of a table', async () => {
  const empty = snapshot()
  empty.agents = []
  empty.totals = { agents: 0, running: 0, done: 0, failed: 0, unknown: 0 }
  const bundle = loadBundle(empty)
  bundle.exports.apply(bundle.ctx)
  await settle()

  const text = textOfPanel(bundle)
  assert.match(text, /暂无活动 Agent/)
  assert.match(text, /skill 工具/)
  assert.equal(findByClass(componentFor(bundle.registered, 'main').component(), 'dsim-table').length, 0)
})

test('the panel survives a failing route and a non-OK response', async () => {
  for (const failure of [new Error('network down'), 403, 404]) {
    const bundle = loadBundle(failure)
    bundle.exports.apply(bundle.ctx)
    await settle()
    const text = textOfPanel(bundle)
    assert.match(text, /技能调用监控/, 'the panel still renders')
    assert.match(text, /无法读取宿主状态/, `failure ${String(failure)} is surfaced`)
    assert.equal(findByClass(componentFor(bundle.registered, 'main').component(), 'dsim-table').length, 0)
  }
})

test('the panel renders before the first response arrives', () => {
  const bundle = loadBundle(snapshot())
  bundle.exports.apply(bundle.ctx)
  assert.match(textOfPanel(bundle), /加载中/)
})

test('an unknown call status still renders a row', async () => {
  const odd = snapshot()
  odd.agents[0].calls = [
    { id: 'c9', origin: 'model', skill: 'grilling', status: 'unknown', startedAt: odd.at, endedAt: null, durationMs: 10, error: null },
  ]
  const bundle = loadBundle(odd)
  bundle.exports.apply(bundle.ctx)
  await settle()
  const text = textOfPanel(bundle)
  assert.match(text, /grilling/)
  assert.match(text, /未观测到结果/)
})

test('the panel never re-polls on its own: one timer serves every component', async () => {
  const bundle = loadBundle(snapshot())
  bundle.exports.apply(bundle.ctx)
  await settle()
  componentFor(bundle.registered, 'main').component()
  componentFor(bundle.registered, 'sidebar.panellist').component({ size: 16 })
  assert.equal(bundle.intervals.length, 1)
  assert.equal(bundle.fetches.length, 1, 'rendering does not trigger extra requests')
})