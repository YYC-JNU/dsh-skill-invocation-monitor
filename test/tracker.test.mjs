/**
 * Unit tests for the pure tracker: no Cordis, no I/O, explicit timestamps.
 *
 * Covers both invocation origins — the model-facing `skill` tool call and the
 * human-facing `skill-invocation` user message — plus the field-name extraction
 * of that durable payload, using the shape measured from a real session log.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_MAX_RECORDS,
  DONE,
  FAILED,
  ORIGIN_MODEL,
  ORIGIN_USER,
  RUNNING,
  SKILL_INVOCATION_KIND,
  SkillTracker,
  TURN_END,
  UNKNOWN,
  agentIdOf,
  errorTextOf,
  isSkillCall,
  skillInvocationOf,
  skillNameOf,
} from '../lib/host/tracker.js'

test('isSkillCall: only the skill tool counts', () => {
  assert.equal(isSkillCall('skill'), true)
  for (const other of ['read', 'bash', 'Skill', 'skill ', undefined, null, 42]) {
    assert.equal(isSkillCall(other), false, `expected ${String(other)} not to be a skill call`)
  }
})

test('the durable names are the measured ones', () => {
  assert.equal(SKILL_INVOCATION_KIND, 'skill-invocation')
  assert.equal(TURN_END, 'turn/end')
})

test('skillNameOf: reads the skill name from the call arguments', () => {
  assert.equal(skillNameOf({ name: 'tdd' }), 'tdd')
  assert.equal(skillNameOf({ skill: 'archify' }), 'archify')
  assert.equal(skillNameOf({ skillName: 'code-review' }), 'code-review')
  assert.equal(skillNameOf('raw-name'), 'raw-name')
  assert.equal(skillNameOf({ name: '' }), null)
  assert.equal(skillNameOf({}), null)
  assert.equal(skillNameOf(null), null)
  assert.equal(skillNameOf(undefined), null)
  assert.equal(skillNameOf(7), null)
})

test('skillNameOf: bounds the stored name', () => {
  const name = skillNameOf({ name: 'x'.repeat(500) })
  assert.equal(typeof name, 'string')
  assert.equal(name.length, 120)
})

/**
 * The durable record shape a human `/grill-me` produces. The shape — event type,
 * payload keys, the `skill-invocation` source union — is taken from a real
 * session log; every value below is synthetic, so no real session artifact
 * ships with the plugin.
 */
function realSkillInvocation() {
  return {
    type: 'user/message',
    seq: 42,
    time: 1_700_000_000_000,
    data: {
      content: [{ type: 'text', text: '<skill_content name="grill-me">\n…' }],
      source: { kind: 'skill-invocation', name: 'grill-me', form: 'instructions' },
      role: 'user',
      id: '7c2e0f5a-3b9d-4e18-9a6c-1d2f3a4b5c6d',
    },
    surfaceOp: 'append',
  }
}

test('skillInvocationOf: reads the real recorded shape', () => {
  assert.deepEqual(skillInvocationOf(realSkillInvocation()), {
    messageId: '7c2e0f5a-3b9d-4e18-9a6c-1d2f3a4b5c6d',
    name: 'grill-me',
    form: 'instructions',
  })
})

test('skillInvocationOf: a plain user message is not a skill invocation', () => {
  assert.equal(skillInvocationOf({ type: 'user/message', data: { content: [], role: 'user' } }), null)
  assert.equal(
    skillInvocationOf({ type: 'user/message', data: { source: { kind: 'user', rpcId: 'r' }, role: 'user' } }),
    null,
  )
})

test('skillInvocationOf: other forms of the same kind still count', () => {
  const parsed = skillInvocationOf({
    type: 'user/message',
    data: { source: { kind: 'skill-invocation', name: 'archify', form: 'catalog' }, id: 'm-1' },
  })
  assert.equal(parsed.name, 'archify')
  assert.equal(parsed.form, 'catalog', 'form is carried through, not filtered on')
})

test('skillInvocationOf: refuses payloads it cannot trust', () => {
  assert.equal(skillInvocationOf(undefined), null)
  assert.equal(skillInvocationOf({}), null)
  assert.equal(skillInvocationOf({ data: null }), null)
  assert.equal(skillInvocationOf({ data: { source: null } }), null)
  assert.equal(skillInvocationOf({ data: { source: { kind: 'skill-invocation' } } }), null, 'no name')
  assert.equal(skillInvocationOf({ data: { source: { kind: 'skill-invocation', name: '' } } }), null, 'empty name')
  assert.equal(skillInvocationOf({ data: { source: { kind: 'skill-invocation', name: 7 } } }), null, 'non-string name')
})

test('skillInvocationOf: a missing message id is tolerated, a long name is bounded', () => {
  const parsed = skillInvocationOf({ data: { source: { kind: 'skill-invocation', name: 'n'.repeat(400) } } })
  assert.equal(parsed.messageId, null, 'begin() will synthesise a key')
  assert.equal(parsed.name.length, 120)
})

test('agentIdOf: only a non-empty string id identifies an agent', () => {
  assert.equal(agentIdOf({ id: 'session-a' }), 'session-a')
  assert.equal(agentIdOf({}), null)
  assert.equal(agentIdOf({ id: '' }), null)
  assert.equal(agentIdOf({ id: 12 }), null)
  assert.equal(agentIdOf(null), null)
  assert.equal(agentIdOf(undefined), null)
})

test('errorTextOf: prefers the failure message, always yields text', () => {
  assert.equal(errorTextOf({ isError: true, error: { message: 'boom' } }), 'boom')
  assert.equal(errorTextOf({ isError: true, error: 'plain' }), 'plain')
  assert.equal(errorTextOf({ isError: true }), '调用失败')
  assert.equal(errorTextOf(null), '调用失败')
  assert.equal(errorTextOf({ error: { message: 'y'.repeat(500) } }).length, 240)
})

test('a model call runs, then settles with its final duration', () => {
  const tracker = new SkillTracker()
  tracker.begin({ id: 'c1', agentId: 'session-a', args: { name: 'tdd' }, at: 1_000 })

  const during = tracker.snapshot({ now: 3_500 }).agents[0].calls[0]
  assert.equal(during.status, RUNNING)
  assert.equal(during.skill, 'tdd')
  assert.equal(during.origin, ORIGIN_MODEL)
  assert.equal(during.durationMs, 2_500)
  assert.equal(during.endedAt, null)

  tracker.finish({ id: 'c1', at: 4_000, isError: false })
  const after = tracker.snapshot({ now: 9_999 }).agents[0].calls[0]
  assert.equal(after.status, DONE)
  assert.equal(after.durationMs, 3_000)
  assert.equal(after.endedAt, 4_000)
  assert.equal(after.error, null)
})

test('a failed call keeps a short reason', () => {
  const tracker = new SkillTracker()
  tracker.begin({ id: 'c1', agentId: 'a', at: 0 })
  tracker.finish({ id: 'c1', at: 10, isError: true, error: errorTextOf({ error: { message: 'skill not found' } }) })
  const call = tracker.snapshot({ now: 20 }).agents[0].calls[0]
  assert.equal(call.status, FAILED)
  assert.equal(call.error, 'skill not found')
})

test('a failed call with no reason still explains itself', () => {
  const tracker = new SkillTracker()
  tracker.begin({ id: 'c1', agentId: 'a', at: 0 })
  tracker.finish({ id: 'c1', at: 10, isError: true })
  assert.equal(tracker.snapshot({ now: 20 }).agents[0].calls[0].error, '调用失败')
})

test('a human skill invocation is tracked with origin user', () => {
  const tracker = new SkillTracker()
  const parsed = skillInvocationOf(realSkillInvocation())
  tracker.begin({ id: parsed.messageId, origin: ORIGIN_USER, agentId: 'session-a', skill: parsed.name, at: 1_000 })

  const during = tracker.snapshot({ now: 4_000 }).agents[0].calls[0]
  assert.equal(during.origin, ORIGIN_USER)
  assert.equal(during.skill, 'grill-me')
  assert.equal(during.id, '7c2e0f5a-3b9d-4e18-9a6c-1d2f3a4b5c6d')
  assert.equal(during.status, RUNNING)
  assert.equal(during.durationMs, 3_000)
})

test('finishAgentCommands settles that agent and only that agent', () => {
  const tracker = new SkillTracker()
  tracker.begin({ id: 'u-a', origin: ORIGIN_USER, agentId: 'session-a', skill: 'grill-me', at: 0 })
  tracker.begin({ id: 'u-b', origin: ORIGIN_USER, agentId: 'session-b', skill: 'handoff', at: 0 })
  tracker.begin({ id: 'tool-a', agentId: 'session-a', args: { name: 'tdd' }, at: 0 })

  const settled = tracker.finishAgentCommands({ agentId: 'session-a', at: 5_000 })
  assert.equal(settled, 1, 'only the running user record of that agent')

  const snapshot = tracker.snapshot({ now: 6_000 })
  const byId = new Map(snapshot.agents.flatMap((group) => group.calls.map((call) => [call.id, call])))
  assert.equal(byId.get('u-a').status, DONE)
  assert.equal(byId.get('u-a').durationMs, 5_000, 'the turn window is the duration')
  assert.equal(byId.get('u-b').status, RUNNING, 'another agent is untouched')
  assert.equal(byId.get('tool-a').status, RUNNING, 'the model path is untouched')
})

test('finishAgentCommands is idempotent and safe with no agent', () => {
  const tracker = new SkillTracker()
  tracker.begin({ id: 'u-a', origin: ORIGIN_USER, agentId: 'session-a', skill: 'grill-me', at: 0 })
  assert.equal(tracker.finishAgentCommands({ agentId: 'session-a', at: 100 }), 1)
  assert.equal(tracker.finishAgentCommands({ agentId: 'session-a', at: 200 }), 0, 'already settled')
  assert.equal(tracker.finishAgentCommands({ agentId: null, at: 300 }), 0)
  assert.equal(tracker.finishAgentCommands({ agentId: 'session-unknown', at: 400 }), 0)
})

test('finishAgentCommands can record a failure', () => {
  const tracker = new SkillTracker()
  tracker.begin({ id: 'u-a', origin: ORIGIN_USER, agentId: 'session-a', skill: 'grill-me', at: 0 })
  tracker.finishAgentCommands({ agentId: 'session-a', at: 10, isError: true, error: 'turn failed' })
  const call = tracker.snapshot({ now: 20 }).agents[0].calls[0]
  assert.equal(call.status, FAILED)
  assert.equal(call.error, 'turn failed')
})

test('a tool id and a user message id with the same text stay separate records', () => {
  const tracker = new SkillTracker()
  tracker.begin({ id: 'same', agentId: 'a', args: { name: 'tool-side' }, at: 0 })
  tracker.begin({ id: 'same', origin: ORIGIN_USER, agentId: 'a', skill: 'user-side', at: 5 })
  const calls = tracker.snapshot({ now: 10 }).agents[0].calls
  assert.equal(calls.length, 2)

  // Settling the tool record must not settle the user record.
  tracker.finish({ id: 'same', at: 20, isError: false })
  const after = tracker.snapshot({ now: 30 }).agents[0].calls
  const bySkill = Object.fromEntries(after.map((call) => [call.skill, call]))
  assert.equal(bySkill['tool-side'].status, DONE)
  assert.equal(bySkill['user-side'].status, RUNNING)
})

test('a repeated start for one call keeps the first start time', () => {
  const tracker = new SkillTracker()
  tracker.begin({ id: 'c1', agentId: 'a', args: { name: 'first' }, at: 100 })
  tracker.begin({ id: 'c1', agentId: 'a', args: { name: 'second' }, at: 900 })
  const calls = tracker.snapshot({ now: 1_000 }).agents[0].calls
  assert.equal(calls.length, 1)
  assert.equal(calls[0].skill, 'first')
  assert.equal(calls[0].durationMs, 900)
})

test('a repeated human invocation of the same message is not double counted', () => {
  const tracker = new SkillTracker()
  tracker.begin({ id: 'm-1', origin: ORIGIN_USER, agentId: 'a', skill: 'grill-me', at: 100 })
  tracker.begin({ id: 'm-1', origin: ORIGIN_USER, agentId: 'a', skill: 'grill-me', at: 500 })
  const calls = tracker.snapshot({ now: 600 }).agents[0].calls
  assert.equal(calls.length, 1)
  assert.equal(calls[0].durationMs, 500)
})

test('a finish for an untracked call is ignored', () => {
  const tracker = new SkillTracker()
  assert.equal(tracker.finish({ id: 'nope', at: 5, isError: false }), undefined)
  assert.equal(tracker.finish({ id: undefined, at: 5, isError: false }), undefined)
  assert.equal(tracker.records.size, 0)
})

test('a finish with the wrong origin does not settle the other origin', () => {
  const tracker = new SkillTracker()
  tracker.begin({ id: 'c1', agentId: 'a', at: 0 })
  assert.equal(tracker.finish({ id: 'c1', origin: ORIGIN_USER, at: 5, isError: false }), undefined)
  assert.equal(tracker.snapshot({ now: 6 }).agents[0].calls[0].status, RUNNING)
})

test('a call with no observed outcome stops counting as running', () => {
  const tracker = new SkillTracker({ staleMs: 1_000 })
  tracker.begin({ id: 'c1', agentId: 'a', at: 0 })
  assert.equal(tracker.snapshot({ now: 500 }).agents[0].calls[0].status, RUNNING)
  const stale = tracker.snapshot({ now: 1_001 }).agents[0].calls[0]
  assert.equal(stale.status, UNKNOWN)
  assert.equal(stale.durationMs, 1_001)
  tracker.finish({ id: 'c1', at: 1_500, isError: false })
  assert.equal(tracker.snapshot({ now: 2_000 }).agents[0].calls[0].status, DONE)
})

test('settled records age out; running ones do not', () => {
  const tracker = new SkillTracker({ retentionMs: 1_000, staleMs: 100_000 })
  tracker.begin({ id: 'done', agentId: 'a', at: 0 })
  tracker.finish({ id: 'done', at: 100, isError: false })
  tracker.begin({ id: 'live', agentId: 'a', at: 0 })

  assert.equal(tracker.snapshot({ now: 500 }).agents[0].calls.length, 2)
  const later = tracker.snapshot({ now: 5_000 }).agents[0].calls
  assert.deepEqual(later.map((call) => call.id), ['live'])
})

test('an unobserved call ages out after the stale window', () => {
  const tracker = new SkillTracker({ retentionMs: 1_000, staleMs: 1_000 })
  tracker.begin({ id: 'c1', agentId: 'a', at: 0 })
  assert.equal(tracker.snapshot({ now: 500 }).agents[0].calls.length, 1)
  assert.deepEqual(tracker.snapshot({ now: 5_000 }).agents, [], 'the record is gone, so the agent group is too')
})

test('the record cap evicts settled calls before live ones', () => {
  const tracker = new SkillTracker({ maxRecords: 3, staleMs: 10 ** 9 })
  tracker.begin({ id: 'live1', agentId: 'a', at: 1 })
  tracker.begin({ id: 'live2', agentId: 'a', at: 2 })
  tracker.begin({ id: 'settled1', agentId: 'a', at: 3 })
  tracker.finish({ id: 'settled1', at: 4, isError: false })
  tracker.begin({ id: 'settled2', agentId: 'a', at: 5 })

  assert.equal(tracker.records.size, 3)
  assert.equal(tracker.records.has('tool:settled1'), false, 'the oldest settled call is evicted first')
  assert.equal(tracker.records.has('tool:live1'), true)
  assert.equal(tracker.records.has('tool:live2'), true)
})

test('the record cap is still enforced when every call is live', () => {
  const tracker = new SkillTracker({ maxRecords: 2, staleMs: 10 ** 9 })
  for (const id of ['a', 'b', 'c']) tracker.begin({ id, agentId: 'x', at: 1 })
  assert.equal(tracker.records.size, 2)
})

test('the default record cap is bounded', () => {
  const tracker = new SkillTracker()
  assert.equal(tracker.maxRecords, DEFAULT_MAX_RECORDS)
  for (let index = 0; index < DEFAULT_MAX_RECORDS + 50; index += 1) {
    tracker.begin({ id: `c${index}`, agentId: 'a', at: index })
  }
  assert.equal(tracker.records.size, DEFAULT_MAX_RECORDS)
})

test('a snapshot lists every live Agent, with its title, even without skill calls', () => {
  const tracker = new SkillTracker()
  tracker.setAgentStatus('session-a', 'idle', 10)
  tracker.setAgentStatus('session-b', 'running', 20)
  const snapshot = tracker.snapshot({
    now: 100,
    agents: [
      { id: 'session-a', title: '示例会话标题' },
      { id: 'session-b', title: null },
    ],
  })

  assert.equal(snapshot.totals.agents, 2)
  const first = snapshot.agents.find((group) => group.id === 'session-a')
  assert.equal(first.title, '示例会话标题')
  assert.equal(first.live, true)
  assert.equal(first.status, 'idle')
  assert.deepEqual(first.calls, [])
  const second = snapshot.agents.find((group) => group.id === 'session-b')
  assert.equal(second.title, null, 'a missing title stays null for the client to fall back on')
  assert.equal(second.status, 'running')
})

test('an agent known only from a running status event is listed', () => {
  const tracker = new SkillTracker()
  tracker.setAgentStatus('session-x', 'running', 1)
  assert.equal(tracker.snapshot({ now: 2 }).agents.length, 1)
  tracker.setAgentStatus('session-x', 'idle', 3)
  assert.equal(tracker.snapshot({ now: 4 }).agents.length, 0, 'an idle agent with no calls stops being listed')
})

test('snapshot totals count every call, split by origin', () => {
  const tracker = new SkillTracker({ retentionMs: 10 ** 9 })
  tracker.begin({ id: 'r1', agentId: 'a', at: 0 })
  tracker.begin({ id: 'r2', agentId: 'b', at: 0 })
  tracker.begin({ id: 'd1', agentId: 'a', at: 0 })
  tracker.finish({ id: 'd1', at: 1, isError: false })
  tracker.begin({ id: 'f1', agentId: 'a', at: 0 })
  tracker.finish({ id: 'f1', at: 1, isError: true, error: 'x' })
  tracker.begin({ id: 'u1', origin: ORIGIN_USER, agentId: 'a', skill: 'grill-me', at: 0 })
  tracker.finish({ id: 'u1', origin: ORIGIN_USER, at: 2, isError: false })

  const snapshot = tracker.snapshot({ now: 5 })
  assert.deepEqual(snapshot.totals, {
    agents: 2,
    running: 2,
    done: 2,
    failed: 1,
    unknown: 0,
    byUser: 1,
    byModel: 4,
  })
  assert.equal(snapshot.agents[0].id, 'a', 'equal running counts break the tie by activity volume')
})

test('a disposed agent is forgotten entirely', () => {
  const tracker = new SkillTracker()
  tracker.begin({ id: 'c1', agentId: 'a', at: 0 })
  tracker.begin({ id: 'u1', origin: ORIGIN_USER, agentId: 'a', skill: 'grill-me', at: 0 })
  tracker.setAgentStatus('a', 'running', 1)
  tracker.dropAgent('a')
  assert.equal(tracker.records.size, 0)
  assert.equal(tracker.statuses.size, 0)
  assert.deepEqual(tracker.snapshot({ now: 2 }).agents, [])
})

test('the snapshot payload is plain, bounded, JSON-safe data', () => {
  const tracker = new SkillTracker({ maxCallsPerAgent: 4, retentionMs: 10 ** 9 })
  for (let index = 0; index < 10; index += 1) {
    tracker.begin({ id: `c${index}`, agentId: 'a', args: { name: `skill-${index}` }, at: index })
  }
  const snapshot = tracker.snapshot({ now: 100, agents: [{ id: 'a', title: 't' }] })
  const group = snapshot.agents[0]
  assert.equal(group.callCount, 10, 'the true count survives the display cap')
  assert.equal(group.calls.length, 4)
  assert.deepEqual(
    group.calls.map((call) => call.skill),
    ['skill-9', 'skill-8', 'skill-7', 'skill-6'],
    'newest call first',
  )
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot)
  assert.equal(snapshot.policy.readOnly, true)
  assert.equal(snapshot.policy.trackedTool, 'skill')
  assert.equal(snapshot.policy.trackedUserPath, 'skill-invocation user messages (window closes at turn/end)')
})

test('an unusable skill name is still displayed', () => {
  const tracker = new SkillTracker()
  tracker.begin({ id: 'c1', agentId: 'a', at: 0 })
  assert.equal(tracker.snapshot({ now: 1 }).agents[0].calls[0].skill, '(未提供技能名)')
})

test('a call with no id is tracked without crashing', () => {
  const tracker = new SkillTracker()
  tracker.begin({ id: undefined, agentId: 'a', at: 0 })
  const calls = tracker.snapshot({ now: 1 }).agents[0].calls
  assert.equal(calls.length, 1)
  assert.equal(calls[0].status, RUNNING)
})