/**
 * dsh-skill-invocation-monitor — host half.
 *
 * READ-ONLY CONTRACT (the plugin's whole reason to exist):
 *   - registers no Tool, no Command, no Service and no config schema;
 *   - never writes Session state, never appends to a session log, keeps nothing
 *     on disk — all state is one in-memory Map owned by this fiber;
 *   - never blocks, denies, cancels, rewrites or measures a call: the
 *     `tools/pre-execute` listener returns `next()` untouched, and every
 *     observation is wrapped so a bug here cannot break a dispatch;
 *   - exposes exactly one route, `GET`, with no request body and no mutation.
 *
 * What it observes (both paths reach the same skill):
 *   - model: `tools/pre-execute` / `tools/result` for the `skill` tool;
 *   - user:  a `user/message` on the `session/event` feed whose source is
 *            `{ kind: 'skill-invocation', name }`. DSH answers a human skill
 *            invocation by appending the skill's instructions to the
 *            conversation, so there is no tool call and no result event; the
 *            window closes at that session's `turn/end`;
 *   - plus `agent/status` / `agent/disposed`.
 *
 * Measured, not assumed: the earlier hypothesis for the user path was the
 * `command/run` / `command/done` pair. This session's own durable log shows a
 * human skill produces no command event at all, and that the structured
 * `skill-invocation` source carries the name directly — so the catalog lookup
 * and 60s TTL that hypothesis required are gone.
 */

import {
  ORIGIN_USER,
  SKILL_INVOCATION_KIND,
  SkillTracker,
  TURN_END,
  agentIdOf,
  errorTextOf,
  isSkillCall,
  skillInvocationOf,
} from './tracker.js'

/** Stable Cordis plugin name (also this bundle's row id in cordis.patch.yml). */
export const name = 'skill-invocation-monitor'

/**
 * Every service is a plain read: `webServer` carries the one route, and
 * `agents` / `sessions` / `sessionTitle` resolve an Agent id to its title.
 */
export const inject = ['webServer', 'agents', 'sessions', 'sessionTitle']

/** The single read-only endpoint the browser half polls. */
export const STATE_PATH = '/api/plugins/skill-monitor/state'

/** How many unusable skill-invocation names the diagnostics keep, most recent first. */
const MAX_UNMATCHED_SEEN = 5

/**
 * Mount the observers and the read-only state route.
 * @param ctx - plugin context carrying the injected services.
 * @param config - optional tracker tuning: `maxRecords`, `retentionMs`, `staleMs`, `maxCallsPerAgent`.
 */
export function apply(ctx, config) {
  const tracker = new SkillTracker(config ?? {})
  const warn = (error) => {
    try {
      ctx.logger?.warn?.(`[skill-invocation-monitor] ${error?.message ?? error}`)
    } catch {
      // Diagnostics must never become a failure mode of this plugin.
    }
  }
  const now = () => Date.now()

  // ---- self-check counters -------------------------------------------
  // These exist so a wrong assumption about the user path stays *visible*:
  // `sessionEvents: 0` means the feed never reached us, `skillInjections: 0`
  // after a human invocation means the durable shape is not what we think, and
  // `unmatchedInjections` lists invocations whose name could not be read.
  const diagnostics = {
    sessionEvents: 0,
    skillInjections: 0,
    trackedInjections: 0,
    unmatchedInjections: [],
    turnEnds: 0,
    settledByTurnEnd: 0,
  }

  const titleOf = (sessionId) => {
    try {
      const session = ctx.sessions.get(sessionId)
      if (session === undefined || session === null) return null
      const title = ctx.sessionTitle.get(session)?.title
      return typeof title === 'string' && title.length > 0 ? title : null
    } catch {
      // A cold or half-published session just has no title yet.
      return null
    }
  }

  const liveAgents = () => {
    const list = []
    try {
      for (const agent of ctx.agents.list()) {
        const id = agentIdOf(agent)
        if (id === null) continue
        list.push({ id, title: titleOf(id) })
      }
    } catch (error) {
      warn(error)
    }
    return list
  }

  const noteUnmatched = (label) => {
    diagnostics.unmatchedInjections = [
      label,
      ...diagnostics.unmatchedInjections.filter((entry) => entry !== label),
    ].slice(0, MAX_UNMATCHED_SEEN)
  }

  // ---- observers: read-only, failure-contained -------------------------
  const observers = [
    // Model path, start of a call. A waterfall listener must hand back
    // `next()`'s result unchanged; this one never returns deny/cancel/ask and
    // never touches exec.
    ctx.on('tools/pre-execute', (exec, next) => {
      try {
        if (isSkillCall(exec?.name)) {
          tracker.begin({
            id: exec?.callId,
            agentId: agentIdOf(exec?.agent),
            at: now(),
            args: exec?.arguments,
          })
        }
      } catch (error) {
        warn(error)
      }
      return next()
    }),
    // Model path, frozen final outcome: the only place its duration closes.
    ctx.on('tools/result', (exec, result) => {
      try {
        if (!isSkillCall(exec?.name)) return
        const failed = result?.isError === true
        tracker.finish({
          id: exec?.callId,
          at: now(),
          isError: failed,
          error: failed ? errorTextOf(result) : null,
        })
      } catch (error) {
        warn(error)
      }
    }),
    // User path. The skill's instructions ride a `user/message`; the name is in
    // the structured source, and the window closes when the turn ends.
    ctx.on('session/event', (session, event) => {
      try {
        diagnostics.sessionEvents += 1
        const type = event?.type
        if (type === 'user/message') {
          const invocation = skillInvocationOf(event)
          if (invocation === null) {
            // Distinguish "not a skill invocation" from "a skill invocation we
            // could not read", so the diagnostic is not noise.
            if (event?.data?.source?.kind === SKILL_INVOCATION_KIND) {
              diagnostics.skillInjections += 1
              noteUnmatched('(skill-invocation without a usable name)')
            }
            return
          }
          diagnostics.skillInjections += 1
          diagnostics.trackedInjections += 1
          tracker.begin({
            id: invocation.messageId,
            origin: ORIGIN_USER,
            agentId: agentIdOf(session),
            skill: invocation.name,
            at: now(),
          })
          return
        }
        if (type === TURN_END) {
          diagnostics.turnEnds += 1
          diagnostics.settledByTurnEnd += tracker.finishAgentCommands({
            agentId: agentIdOf(session),
            at: now(),
          })
        }
      } catch (error) {
        warn(error)
      }
    }),
    ctx.on('agent/status', (payload) => {
      try {
        tracker.setAgentStatus(agentIdOf(payload?.agent), payload?.status, now())
      } catch (error) {
        warn(error)
      }
    }),
    ctx.on('agent/disposed', (payload) => {
      try {
        tracker.dropAgent(agentIdOf(payload?.agent))
      } catch (error) {
        warn(error)
      }
    }),
  ]

  ctx.effect(() => () => {
    for (const off of observers) {
      try {
        off?.()
      } catch {
        // Already released with the fiber.
      }
    }
  }, 'skill-invocation-monitor: read-only observers')

  // ---- the one route: GET, no body, no mutation ------------------------
  const state = () => {
    const body = tracker.snapshot({ now: now(), agents: liveAgents() })
    body.diagnostics = { ...diagnostics, unmatchedInjections: [...diagnostics.unmatchedInjections] }
    return body
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: STATE_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET') {
            writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
            return
          }
          if (!trusted(req)) {
            writeJson(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          writeJson(res, 200, state())
        },
      }),
    'skill-invocation-monitor: read-only state route',
  )
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * Loopback fence against cross-site reads of a local endpoint.
 *
 * Stricter cases are refused: a non-loopback peer, a cross-site fetch marker,
 * or an Origin that is not loopback. A loopback request carrying neither marker
 * is admitted — that is the direct same-origin `fetch` from the served Web GUI
 * as well as an IPC-bridged request from the desktop shell, neither of which
 * sets browser origin headers. The payload is a read-only, non-secret
 * snapshot, so the permissive branch costs nothing worth protecting.
 */
function trusted(req) {
  const address = req.socket?.remoteAddress ?? ''
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!loopback) return false
  const headers = req.headers ?? {}
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  try {
    const hostname = new URL(origin).hostname
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}