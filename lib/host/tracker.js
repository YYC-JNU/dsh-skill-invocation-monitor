/**
 * Skill invocation tracker — the entire observation model of this plugin.
 *
 * Two invocation paths reach the same skill, and they are structurally
 * different in DSH:
 *
 *   model  a `skill` tool call, observed through the tool pipeline
 *          (`tools/pre-execute` … `tools/result`), identified by `callId`.
 *   user   a human invoking a skill in the GUI. DSH answers it by appending a
 *          `user/message` whose source is `{ kind: 'skill-invocation', name }` —
 *          the instructions ride the conversation, not a tool call and not a
 *          command. Its window opens at that append and closes at `turn/end`,
 *          because there is no result event of its own.
 *
 * Both are folded into one record shape with an `origin`, because the panel's
 * question is the same either way: which skill, for which agent, running for
 * how long, and how did it end.
 *
 * Deliberately free of Cordis, I/O, timers and wall-clock reads: every method
 * takes an explicit `at`, so the whole thing is deterministic and testable
 * outside DSH (`node --test test/`).
 *
 * It stores nothing durable and mutates nothing outside itself. Records live in
 * one Map, are capped, and age out; the plugin's memory footprint is therefore
 * bounded even if nobody ever reads a snapshot.
 */

/** The one tool whose invocation means "a Skill is being loaded". */
export const SKILL_TOOL_NAME = 'skill'

/**
 * Durable shape of a human-invoked skill.
 *
 * DSH appends a `user/message` whose `source` is the `SkillInvocationSource`
 * discriminated union declared by the skills seam itself (persistence catalog,
 * `packages/skill/skill/src/index.ts`). Note what is NOT here: the command path
 * (`command/run` / `command/done`) was an earlier hypothesis, and this session's
 * own durable log disproved it — a human-invoked skill produces no command event.
 */
export const SKILL_INVOCATION_KIND = 'skill-invocation'
export const SKILL_INVOCATION_FORM = 'instructions'
/**
 * The durable event that closes a turn, and with it a human skill's window.
 * A human skill has no result event of its own.
 */
export const TURN_END = 'turn/end'

export const ORIGIN_MODEL = 'model'
export const ORIGIN_USER = 'user'

export const RUNNING = 'running'
export const DONE = 'done'
export const FAILED = 'failed'
/**
 * A `running` record whose outcome never arrived (denied before dispatch, a
 * cancelled parent, or a crashed host that never wrote the closing event).
 * Derived, never stored.
 */
export const UNKNOWN = 'unknown'

export const DEFAULT_MAX_RECORDS = 200
/** How long a settled invocation stays visible. */
export const DEFAULT_RETENTION_MS = 10 * 60 * 1000
/** When an invocation with no observed outcome stops counting as "运行中". */
export const DEFAULT_STALE_MS = 15 * 60 * 1000
export const DEFAULT_MAX_CALLS_PER_AGENT = 20

const MAX_SKILL_NAME = 120
const MAX_ERROR_TEXT = 240

/** True for a `skill` tool dispatch — the model-facing invocation path. */
export function isSkillCall(name) {
  return name === SKILL_TOOL_NAME
}

/**
 * The Skill name carried by a `skill` tool call's parsed arguments.
 * @returns the name, or null when the arguments carry none.
 */
export function skillNameOf(args) {
  if (typeof args === 'string' && args.length > 0) return args.slice(0, MAX_SKILL_NAME)
  if (args === null || typeof args !== 'object') return null
  for (const key of ['name', 'skill', 'skillName']) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) return value.slice(0, MAX_SKILL_NAME)
  }
  return null
}

/** `Agent.id` is a branded string; anything else means "no agent on this call". */
export function agentIdOf(agent) {
  const id = agent === null || typeof agent !== 'object' ? undefined : agent.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/** A short, display-safe reason for a failed tool call. */
export function errorTextOf(result) {
  const failure = result === null || typeof result !== 'object' ? undefined : result.error
  const text = failure === null || typeof failure !== 'object' ? failure : failure.message
  if (typeof text === 'string' && text.length > 0) return text.slice(0, MAX_ERROR_TEXT)
  return '调用失败'
}

/**
 * Read one human skill invocation by FIELD NAME.
 *
 * The durable shape, observed in a real session log rather than invented. Only
 * the shape is real — the values below are synthetic:
 *
 *   { "type": "user/message", "seq": 42, "time": 1700000000000,
 *     "data": { "content": [{ "type": "text", "text": "<skill_content name=\"grill-me\">…" }],
 *               "source": { "kind": "skill-invocation", "name": "grill-me", "form": "instructions" },
 *               "role": "user", "id": "7c2e0f5a-3b9d-4e18-9a6c-1d2f3a4b5c6d" },
 *     "surfaceOp": "append" }
 *
 * The name comes from the structured source, so no catalog lookup and no text
 * parsing is involved. `form` is carried through for diagnostics.
 *
 * @returns `{ messageId, name, form }`, or null when this is not a usable skill invocation.
 */
export function skillInvocationOf(event) {
  const data = event === null || typeof event !== 'object' ? undefined : event.data
  if (data === null || typeof data !== 'object') return null
  const source = data.source
  if (source === null || typeof source !== 'object') return null
  if (source.kind !== SKILL_INVOCATION_KIND) return null
  const name = source.name
  if (typeof name !== 'string' || name.length === 0) return null
  return {
    messageId: typeof data.id === 'string' && data.id.length > 0 ? data.id : null,
    name: name.slice(0, MAX_SKILL_NAME),
    form: typeof source.form === 'string' ? source.form : null,
  }
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

export class SkillTracker {
  constructor(options = {}) {
    const config = options === null || typeof options !== 'object' ? {} : options
    this.maxRecords = positiveInteger(config.maxRecords, DEFAULT_MAX_RECORDS)
    this.retentionMs = positiveInteger(config.retentionMs, DEFAULT_RETENTION_MS)
    this.staleMs = positiveInteger(config.staleMs, DEFAULT_STALE_MS)
    this.maxCallsPerAgent = positiveInteger(config.maxCallsPerAgent, DEFAULT_MAX_CALLS_PER_AGENT)
    /** namespaced key → record; keys are pre-seeded by origin so a tool callId and a commandId can never collide */
    this.records = new Map()
    /** sessionId → { status, at } from `agent/status` */
    this.statuses = new Map()
    this.seq = 0
  }

  /**
   * Record the start of one invocation. A repeated id keeps the first start
   * time (the tool pipeline may re-enter pre-execute for the same call, and a
   * replayed command event must not restart the clock).
   *
   * @param id - the tool `callId` or the command `commandId`.
   * @param origin - `ORIGIN_MODEL` or `ORIGIN_USER`.
   * @returns the stored record.
   */
  begin({ id, origin = ORIGIN_MODEL, agentId = null, skill = null, args, at }) {
    const seed = typeof id === 'string' && id.length > 0 ? id : `anon:${++this.seq}`
    const key = `${origin === ORIGIN_USER ? 'command' : 'tool'}:${seed}`
    const existing = this.records.get(key)
    if (existing !== undefined) return existing
    const record = {
      key,
      id: seed,
      origin: origin === ORIGIN_USER ? ORIGIN_USER : ORIGIN_MODEL,
      agentId,
      skill: skill ?? skillNameOf(args) ?? '(未提供技能名)',
      status: RUNNING,
      startedAt: at,
      endedAt: null,
      error: null,
      seq: ++this.seq,
    }
    this.records.set(key, record)
    this.trim()
    return record
  }

  /**
   * Record the outcome of one invocation. Unknown ids are ignored: this plugin
   * only reports invocations it saw start.
   *
   * @param error - display-ready failure text, or null/undefined on success.
   * @returns the updated record, or undefined when the invocation was never tracked.
   */
  finish({ id, origin = ORIGIN_MODEL, at, isError = false, error = null }) {
    if (typeof id !== 'string' || id.length === 0) return undefined
    const key = `${origin === ORIGIN_USER ? 'command' : 'tool'}:${id}`
    const record = this.records.get(key)
    if (record === undefined) return undefined
    if (record.status !== RUNNING) return record
    record.status = isError ? FAILED : DONE
    record.endedAt = at
    record.error = isError ? (typeof error === 'string' && error.length > 0 ? error.slice(0, MAX_ERROR_TEXT) : '调用失败') : null
    return record
  }

  /**
   * Settle every running human-path record of one agent.
   *
   * A human skill has no result event: its instructions are in effect for the
   * turn they were injected into, so `turn/end` is what closes the window. A
   * turn in a session is serialized, so settling by agent is unambiguous.
   *
   * @returns how many records were settled.
   */
  finishAgentCommands({ agentId, at, isError = false, error = null }) {
    if (agentId === null) return 0
    let settled = 0
    for (const record of [...this.records.values()]) {
      if (record.origin !== ORIGIN_USER) continue
      if (record.agentId !== agentId) continue
      if (record.status !== RUNNING) continue
      this.finish({ id: record.id, origin: ORIGIN_USER, at, isError, error })
      settled += 1
    }
    return settled
  }

  /** Track `agent/status` so idle agents can be shown without skill activity. */
  setAgentStatus(agentId, status, at) {
    if (agentId === null) return
    if (status !== 'running' && status !== 'idle') return
    this.statuses.set(agentId, { status, at })
  }

  /** Forget one agent entirely (`agent/disposed`). */
  dropAgent(agentId) {
    if (agentId === null) return
    this.statuses.delete(agentId)
    for (const [key, record] of [...this.records.entries()]) {
      if (record.agentId === agentId) this.records.delete(key)
    }
  }

  /** The status a record shows at `now`: settled status, else staleness. */
  effectiveStatus(record, now) {
    if (record.status !== RUNNING) return record.status
    return now - record.startedAt > this.staleMs ? UNKNOWN : RUNNING
  }

  /** Drop settled records past retention, then enforce the record cap. */
  purge(now) {
    for (const [key, record] of [...this.records.entries()]) {
      if (this.effectiveStatus(record, now) === RUNNING) continue
      const settledAt = record.endedAt ?? record.startedAt + this.staleMs
      if (now - settledAt > this.retentionMs) this.records.delete(key)
    }
    this.trim()
  }

  /** Enforce `maxRecords`, evicting settled records (oldest first) before live ones. */
  trim() {
    while (this.records.size > this.maxRecords) {
      let victim = null
      for (const record of this.records.values()) {
        if (record.status === RUNNING) continue
        if (victim === null || record.seq < victim.seq) victim = record
      }
      if (victim === null) {
        for (const record of this.records.values()) {
          if (victim === null || record.seq < victim.seq) victim = record
        }
      }
      this.records.delete(victim.key)
    }
  }

  /** One invocation as the client sees it: no internal bookkeeping fields. */
  view(record, now) {
    const status = this.effectiveStatus(record, now)
    const end = record.endedAt ?? now
    return {
      id: record.id,
      origin: record.origin,
      skill: record.skill,
      status,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      durationMs: Math.max(0, end - record.startedAt),
      error: record.error,
    }
  }

  /**
   * The read model handed to the browser half.
   *
   * @param now - current epoch ms.
   * @param agents - live agents from `ctx.agents.list()`, each `{ id, title }`.
   * @returns a JSON-serializable snapshot: one group per Agent, newest first.
   */
  snapshot({ now, agents = [] }) {
    this.purge(now)
    const groups = new Map()
    const ensure = (id) => {
      let group = groups.get(id)
      if (group === undefined) {
        group = { id, title: null, status: null, live: false, calls: [] }
        groups.set(id, group)
      }
      return group
    }

    for (const agent of agents) {
      const id = agentIdOf(agent)
      if (id === null) continue
      const group = ensure(id)
      group.live = true
      if (typeof agent.title === 'string' && agent.title.length > 0) group.title = agent.title
    }

    for (const record of this.records.values()) {
      const group = ensure(record.agentId ?? '(未知 Agent)')
      group.calls.push(this.view(record, now))
    }

    for (const [id, entry] of this.statuses) {
      // An agent known only from a status event still counts while it runs;
      // an idle one is only listed when it is live or has tracked calls.
      if (entry.status !== 'running' && !groups.has(id)) continue
      ensure(id).status = entry.status
    }

    const totals = { agents: groups.size, running: 0, done: 0, failed: 0, unknown: 0, byUser: 0, byModel: 0 }
    const list = []
    for (const group of groups.values()) {
      group.calls.sort((left, right) => right.startedAt - left.startedAt || 0)
      for (const call of group.calls) {
        if (totals[call.status] !== undefined) totals[call.status] += 1
        if (call.origin === ORIGIN_USER) totals.byUser += 1
        else totals.byModel += 1
      }
      group.callCount = group.calls.length
      group.calls = group.calls.slice(0, this.maxCallsPerAgent)
      group.running = group.calls.filter((call) => call.status === RUNNING).length
      if (group.status === null && group.live) group.status = group.running > 0 ? 'running' : 'idle'
      list.push(group)
    }
    // Busiest and most recent first: running agents, then last activity.
    list.sort((left, right) => right.running - left.running || latestOf(right) - latestOf(left) || right.callCount - left.callCount)

    return {
      ok: true,
      at: now,
      agents: list,
      totals,
      policy: {
        readOnly: true,
        trackedTool: SKILL_TOOL_NAME,
        trackedUserPath: 'skill-invocation user messages (window closes at turn/end)',
        retentionMs: this.retentionMs,
        staleMs: this.staleMs,
        maxRecords: this.maxRecords,
      },
    }
  }
}

function latestOf(group) {
  return group.calls.length > 0 ? group.calls[0].startedAt : 0
}