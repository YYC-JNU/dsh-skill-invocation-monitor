/**
 * Integration tests for the host half against a hand-written fake Cordis
 * context. These assert the read-only contract directly: which events are
 * observed, that the pre-execute listener only ever hands back `next()`, that
 * a broken observer cannot escape, that the one route is GET-only, and that
 * both invocation paths (model tool call, human skill invocation) are folded
 * into the same snapshot.
 *
 * The human-path fixtures are the shapes measured from a real session log
 * rather than invented ones.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { STATE_PATH, apply, inject, name } from '../lib/host/index.js'

const OBSERVED_EVENTS = ['tools/pre-execute', 'tools/result', 'session/event', 'agent/status', 'agent/disposed']

function createHarness(options = {}) {
  const listeners = new Map()
  const routes = []
  const effects = []
  const titles = options.titles ?? {}
  const sessions = options.sessions ?? []
  const state = { agents: options.agents ?? [] }
  const ctx = {
    logger: { warn: () => {} },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
      }
    },
    effect(fn, label) {
      const off = fn()
      effects.push({ label, off })
      return off
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    agents: {
      list() {
        if (options.agentsThrows === true) throw new Error('registry unavailable')
        return state.agents
      },
    },
    sessions: {
      get(id) {
        if (options.sessionsThrows === true) throw new Error('sessions unavailable')
        return sessions.includes(id) ? { id } : undefined
      },
    },
    sessionTitle: {
      get(session) {
        const title = titles[session.id]
        return title === undefined ? undefined : { title }
      },
    },
  }
  return { ctx, listeners, routes, effects, state }
}

function emit(listeners, event, ...args) {
  const results = []
  for (const listener of listeners.get(event) ?? []) results.push(listener(...args))
  return results
}

function call(overrides = {}) {
  return {
    name: 'skill',
    callId: 'call-1',
    arguments: { name: 'tdd' },
    agent: { id: 'session-a' },
    ...overrides,
  }
}

/**
 * The exact durable record a human `/grill-me` produced (copied from this
 * session's log): a `user/message` whose structured source is the
 * `SkillInvocationSource` union declared by the skills seam.
 */
function skillInvocationEvent(messageId, skillName) {
  return {
    type: 'user/message',
    seq: 42,
    time: 1_700_000_000_000,
    data: {
      content: [{ type: 'text', text: `<skill_content name="${skillName}">\n…` }],
      source: { kind: 'skill-invocation', name: skillName, form: 'instructions' },
      role: 'user',
      id: messageId,
    },
    surfaceOp: 'append',
  }
}

/** Only the event type is used by the observer, so the payload stays minimal. */
function turnEndEvent(turn = 10) {
  return { type: 'turn/end', seq: 1300, data: { turn } }
}

function plainUserMessage(text = '你好') {
  return { type: 'user/message', seq: 1261, data: { content: [{ type: 'text', text }], role: 'user', id: 'm-0' } }
}

function request(route, options = {}) {
  const res = {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      return this
    },
    end(body) {
      this.body = body === undefined ? '' : String(body)
    },
  }
  route.handler(
    {
      method: options.method ?? 'GET',
      socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
      headers: options.headers ?? {},
    },
    res,
  )
  return {
    status: res.status,
    headers: res.headers,
    raw: res.body,
    json: res.body.length > 0 ? JSON.parse(res.body) : null,
  }
}

function stateRoute(routes) {
  assert.equal(routes.length, 1, 'exactly one route is registered')
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, STATE_PATH)
  return routes[0]
}

test('the plugin declares a stable name and only read services', () => {
  assert.equal(name, 'skill-invocation-monitor')
  assert.deepEqual(inject, ['webServer', 'agents', 'sessions', 'sessionTitle'])
  assert.equal(STATE_PATH, '/api/plugins/skill-monitor/state')
})

test('apply() adds no context member and registers no Tool or Service', () => {
  const { ctx } = createHarness()
  const before = Object.keys(ctx).sort()
  apply(ctx, {})
  assert.deepEqual(Object.keys(ctx).sort(), before, 'ctx must not gain a member')
  assert.equal(ctx.tools, undefined, 'the tools registry is never even reached for')
  assert.equal(ctx.commands, undefined, 'no Command is registered either')
})

test('apply() observes exactly the five read-only events', () => {
  const { ctx, listeners } = createHarness()
  apply(ctx, {})
  assert.deepEqual([...listeners.keys()].sort(), [...OBSERVED_EVENTS].sort())
  for (const event of OBSERVED_EVENTS) assert.equal(listeners.get(event).length, 1)
})

test('apply() registers one exact GET route', () => {
  const { ctx, routes } = createHarness()
  apply(ctx, {})
  const response = request(stateRoute(routes))
  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
})

test('the pre-execute listener is a pure passthrough', async () => {
  const { ctx, listeners } = createHarness()
  apply(ctx, {})
  const exec = call()
  const frozen = JSON.stringify(exec)
  const decision = { kind: 'allow' }
  const results = emit(listeners, 'tools/pre-execute', exec, () => Promise.resolve(decision))
  assert.equal(results.length, 1)
  const resolved = await results[0]
  assert.equal(resolved, decision, 'the listener must hand back next()s decision unchanged')
  assert.equal(JSON.stringify(exec), frozen, 'the execution object must not be touched')
})

test('the pre-execute listener never blocks dispatch, even when it breaks', () => {
  const { ctx, listeners } = createHarness()
  apply(ctx, {})
  const hostileArgs = new Proxy({}, { get() { throw new Error('nope') } })
  const decision = { kind: 'allow' }
  const results = emit(
    listeners,
    'tools/pre-execute',
    { name: 'skill', callId: 'call-x', arguments: hostileArgs, agent: null },
    () => decision,
  )
  assert.equal(results[0], decision, 'a throwing observer must still allow the call')
})

test('a model skill call is tracked, titled and reported as running', () => {
  const { ctx, listeners, routes } = createHarness({
    agents: [{ id: 'session-a' }],
    sessions: ['session-a'],
    titles: { 'session-a': '示例会话标题' },
  })
  apply(ctx, {})
  emit(listeners, 'tools/pre-execute', call(), () => Promise.resolve({ kind: 'allow' }))
  emit(listeners, 'agent/status', { agent: { id: 'session-a' }, status: 'running' })

  const body = request(stateRoute(routes)).json
  assert.equal(body.ok, true)
  assert.equal(body.totals.agents, 1)
  assert.equal(body.totals.running, 1)
  assert.equal(body.totals.byModel, 1)
  assert.equal(body.totals.byUser, 0)
  const group = body.agents[0]
  assert.equal(group.title, '示例会话标题')
  assert.equal(group.calls[0].skill, 'tdd')
  assert.equal(group.calls[0].origin, 'model')
  assert.equal(group.calls[0].id, 'call-1')
  assert.equal(group.calls[0].endedAt, null)
})

test('a human skill invocation is tracked with origin user', () => {
  const { ctx, listeners, routes } = createHarness({
    agents: [{ id: 'session-a' }],
    sessions: ['session-a'],
    titles: { 'session-a': '示例会话标题' },
  })
  apply(ctx, {})
  emit(listeners, 'session/event', { id: 'session-a' }, skillInvocationEvent('m-1', 'grill-me'))

  const body = request(stateRoute(routes)).json
  assert.equal(body.totals.running, 1)
  assert.equal(body.totals.byUser, 1)
  assert.equal(body.totals.byModel, 0)
  const running = body.agents[0].calls[0]
  assert.equal(running.skill, 'grill-me')
  assert.equal(running.origin, 'user')
  assert.equal(running.id, 'm-1')
  assert.equal(running.status, 'running')
  assert.equal(body.agents[0].title, '示例会话标题')
})

test('turn/end closes the human window and leaves the model call alone', () => {
  const { ctx, listeners, routes } = createHarness({ agents: [{ id: 'session-a' }] })
  apply(ctx, {})
  emit(listeners, 'session/event', { id: 'session-a' }, skillInvocationEvent('m-1', 'grill-me'))
  emit(listeners, 'tools/pre-execute', call(), () => Promise.resolve({ kind: 'allow' }))

  emit(listeners, 'session/event', { id: 'session-a' }, turnEndEvent())
  const calls = request(stateRoute(routes)).json.agents[0].calls
  const bySkill = Object.fromEntries(calls.map((entry) => [entry.skill, entry]))
  assert.equal(bySkill['grill-me'].status, 'done')
  assert.equal(bySkill['grill-me'].origin, 'user')
  assert.ok(bySkill['grill-me'].durationMs >= 0)
  assert.equal(bySkill['tdd'].status, 'running', 'the model call is settled by tools/result, not by turn/end')
})

test('turn/end in another session does not settle this one', () => {
  const { ctx, listeners, routes } = createHarness()
  apply(ctx, {})
  emit(listeners, 'session/event', { id: 'session-a' }, skillInvocationEvent('m-1', 'grill-me'))
  emit(listeners, 'session/event', { id: 'session-b' }, turnEndEvent())
  assert.equal(request(stateRoute(routes)).json.agents[0].calls[0].status, 'running')
})

test('a plain user message is ignored', () => {
  const { ctx, listeners, routes } = createHarness()
  apply(ctx, {})
  emit(listeners, 'session/event', { id: 'session-a' }, plainUserMessage())
  const body = request(stateRoute(routes)).json
  assert.deepEqual(body.agents, [])
  assert.equal(body.diagnostics.skillInjections, 0)
})

test('a skill invocation without a usable name is reported, not tracked', () => {
  const { ctx, listeners, routes } = createHarness()
  apply(ctx, {})
  emit(listeners, 'session/event', { id: 'session-a' }, {
    type: 'user/message',
    data: { source: { kind: 'skill-invocation', form: 'instructions' }, role: 'user', id: 'm-9' },
  })
  const body = request(stateRoute(routes)).json
  assert.deepEqual(body.agents, [])
  assert.equal(body.diagnostics.skillInjections, 1)
  assert.equal(body.diagnostics.trackedInjections, 0)
  assert.deepEqual(body.diagnostics.unmatchedInjections, ['(skill-invocation without a usable name)'])
})

test('diagnostics expose the self-check counters', () => {
  const { ctx, listeners, routes } = createHarness()
  apply(ctx, {})
  emit(listeners, 'session/event', { id: 'session-a' }, plainUserMessage())
  emit(listeners, 'session/event', { id: 'session-a' }, skillInvocationEvent('m-1', 'grill-me'))
  emit(listeners, 'session/event', { id: 'session-a' }, turnEndEvent())

  const diagnostics = request(stateRoute(routes)).json.diagnostics
  assert.equal(diagnostics.sessionEvents, 3)
  assert.equal(diagnostics.skillInjections, 1)
  assert.equal(diagnostics.trackedInjections, 1)
  assert.equal(diagnostics.turnEnds, 1)
  assert.equal(diagnostics.settledByTurnEnd, 1)
  assert.deepEqual(diagnostics.unmatchedInjections, [])
})

test('a malformed session event cannot break the observer', () => {
  const { ctx, listeners, routes } = createHarness()
  apply(ctx, {})
  for (const event of [undefined, null, {}, { type: 'user/message' }, { type: 'user/message', data: {} }, { type: 'turn/end' }]) {
    emit(listeners, 'session/event', { id: 'session-a' }, event)
  }
  const body = request(stateRoute(routes)).json
  assert.equal(body.ok, true)
  assert.deepEqual(body.agents, [])
})

test('only the skill tool is tracked on the model path', () => {
  const { ctx, listeners, routes } = createHarness()
  apply(ctx, {})
  emit(listeners, 'tools/pre-execute', call({ name: 'read', arguments: { file_path: 'x' } }), () => Promise.resolve({ kind: 'allow' }))
  emit(listeners, 'tools/pre-execute', call({ name: 'bash' }), () => Promise.resolve({ kind: 'allow' }))
  assert.deepEqual(request(stateRoute(routes)).json.agents, [])
})

test('tools/result settles the duration and the outcome', () => {
  const { ctx, listeners, routes } = createHarness()
  apply(ctx, {})
  emit(listeners, 'tools/pre-execute', call(), () => Promise.resolve({ kind: 'allow' }))
  emit(listeners, 'tools/result', call(), { isError: false, value: {} })
  let group = request(stateRoute(routes)).json.agents[0]
  assert.equal(group.calls[0].status, 'done')
  assert.equal(typeof group.calls[0].endedAt, 'number')
  assert.equal(group.calls[0].error, null)

  emit(listeners, 'tools/pre-execute', call({ callId: 'call-2' }), () => Promise.resolve({ kind: 'allow' }))
  emit(listeners, 'tools/result', call({ callId: 'call-2' }), { isError: true, error: { message: 'skill "tdd" not found' } })
  group = request(stateRoute(routes)).json.agents[0]
  const failed = group.calls.find((entry) => entry.id === 'call-2')
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error, 'skill "tdd" not found')
})

test('a result for an untracked or non-skill call changes nothing', () => {
  const { ctx, listeners, routes } = createHarness()
  apply(ctx, {})
  emit(listeners, 'tools/result', call({ callId: 'never-seen' }), { isError: true })
  emit(listeners, 'tools/result', call({ name: 'read' }), { isError: true })
  assert.deepEqual(request(stateRoute(routes)).json.agents, [])
})

test('agent/status lists an idle agent, agent/disposed removes it', () => {
  const live = [{ id: 'session-a' }]
  const { ctx, listeners, routes } = createHarness({ agents: live })
  apply(ctx, {})
  emit(listeners, 'agent/status', { agent: { id: 'session-a' }, status: 'idle' })
  let group = request(stateRoute(routes)).json.agents[0]
  assert.equal(group.status, 'idle')
  assert.equal(group.live, true)

  live.length = 0
  emit(listeners, 'agent/disposed', { agent: { id: 'session-a' } })
  assert.deepEqual(request(stateRoute(routes)).json.agents, [], 'a disposed agent disappears')
})

test('a skill invocation dies with its agent', () => {
  const { ctx, listeners, routes } = createHarness()
  apply(ctx, {})
  emit(listeners, 'session/event', { id: 'session-a' }, skillInvocationEvent('m-1', 'grill-me'))
  emit(listeners, 'agent/disposed', { agent: { id: 'session-a' } })
  assert.deepEqual(request(stateRoute(routes)).json.agents, [], 'records die with their agent')
})

test('a failing title lookup degrades to a null title instead of failing the read', () => {
  const { ctx, listeners, routes } = createHarness({ agents: [{ id: 'session-a' }], sessionsThrows: true })
  apply(ctx, {})
  emit(listeners, 'tools/pre-execute', call(), () => Promise.resolve({ kind: 'allow' }))
  const body = request(stateRoute(routes)).json
  assert.equal(body.ok, true)
  assert.equal(body.agents[0].title, null)
  assert.equal(body.agents[0].calls[0].skill, 'tdd')
})

test('a failing agents.list() degrades to an empty agent list', () => {
  const { ctx, routes } = createHarness({ agentsThrows: true })
  apply(ctx, {})
  const body = request(stateRoute(routes)).json
  assert.equal(body.ok, true)
  assert.deepEqual(body.agents, [])
})

test('the state route refuses every method but GET', () => {
  const { ctx, routes } = createHarness()
  apply(ctx, {})
  const route = stateRoute(routes)
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'PATCH']) {
    const response = request(route, { method })
    assert.equal(response.status, 405, `${method} must not be served`)
    assert.equal(response.json.error, 'method-not-allowed')
  }
})

test('the state route admits loopback and refuses everything cross-site', () => {
  const { ctx, routes } = createHarness()
  apply(ctx, {})
  const route = stateRoute(routes)

  assert.equal(request(route).status, 200, 'plain loopback GET')
  assert.equal(request(route, { remoteAddress: '::1' }).status, 200, 'IPv6 loopback')
  assert.equal(request(route, { remoteAddress: '::ffff:127.0.0.1' }).status, 200, 'mapped loopback')
  assert.equal(request(route, { headers: { origin: 'http://127.0.0.1:19387' } }).status, 200, 'same-host origin')
  assert.equal(request(route, { headers: { origin: 'http://localhost:19387' } }).status, 200, 'localhost origin')
  assert.equal(request(route, { headers: { 'sec-fetch-site': 'same-origin' } }).status, 200, 'same-origin marker')

  assert.equal(request(route, { remoteAddress: '192.168.1.20' }).status, 403, 'non-loopback peer')
  assert.equal(request(route, { headers: { 'sec-fetch-site': 'cross-site' } }).status, 403, 'cross-site marker')
  assert.equal(request(route, { headers: { origin: 'http://evil.example' } }).status, 403, 'foreign origin')
  assert.equal(request(route, { headers: { origin: 'not a url' } }).status, 403, 'unparsable origin')
})

test('disposal detaches every observer and the route effect', () => {
  const { ctx, listeners, routes, effects } = createHarness()
  apply(ctx, {})
  assert.equal(effects.length, 2, 'one effect for observers, one for the route')
  assert.equal(routes.length, 1)

  for (const effect of effects) effect.off()
  assert.equal(routes.length, 0)
  for (const event of OBSERVED_EVENTS) assert.equal((listeners.get(event) ?? []).length, 0, `${event} listeners released`)
})

test('tracker tuning arrives through the plugin config', () => {
  const { ctx, listeners, routes } = createHarness()
  apply(ctx, { maxRecords: 3, maxCallsPerAgent: 1 })
  for (const callId of ['a', 'b', 'c', 'd']) {
    emit(listeners, 'tools/pre-execute', call({ callId }), () => Promise.resolve({ kind: 'allow' }))
  }
  const body = request(stateRoute(routes)).json
  assert.equal(body.policy.maxRecords, 3)
  const group = body.agents[0]
  assert.equal(group.callCount, 3, 'the cap keeps the three newest records')
  assert.equal(group.calls.length, 1, 'the display cap is honoured too')
})