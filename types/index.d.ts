/**
 * This session's on/off, tagged with the session it was decided for: a process
 * that moves to another session (/clear, /resume) does not carry it over.
 */
export type SessionToggle = { sessionId: string; enabled: boolean }

/**
 * The main conversation's context fill as the engine last measured it; `tokens` is absent until a response of
 * the live window came back. `model` and `effort` are what main's latest request ran at (turn.step), the
 * session's model standing in before its first; `effort` is absent for a model without one.
 */
export type MainContext = { tokens?: number; window: number; percent?: number; model?: string; effort?: string }

/**
 * One subagent of this session as the board shows it, the latest run of it: a resume through SendMessage
 * starts the clock again. `tier` is set for an agent the router rated (a worker, a fork, a /subtask);
 * `contextTokens` is the input side of its latest request, absent before the first one came back.
 *
 * `canHandOff` marks an agent main can start again from a handoff: one main spawned itself or a /subtask,
 * fork or not, but no teammate, workflow agent or subagent's own subagent. `handoffAt` is the context
 * percentage it was asked to hand off at.
 */
export type AgentRow = {
  id: string
  type: string
  tier?: 'haiku' | 'sonnet' | 'opus'
  description: string
  status: 'running' | 'done' | 'failed' | 'stopped'
  startedAt: number
  endedAt?: number
  model?: string
  effort?: string
  contextTokens?: number
  window: number
  outputTokens?: number
  canHandOff?: true
  handoffAt?: number
}

/** A subagent request's effort as the router holds it: any level but `max`, or a budget. */
export type HandoffEffort = 'low' | 'medium' | 'high' | 'xhigh' | number

/**
 * The model and effort every request of one agent runs at (turn.step), as the router chose them for it or
 * as the agent it continues ran. `model` absent leaves the agent on the model the engine resolved (a fork
 * on main's, whose prompt cache it then shares); `effort` absent, at its own effort.
 */
export type Pin = {
  agentId: string
  tier?: 'haiku' | 'sonnet' | 'opus'
  model?: string
  effort?: HandoffEffort
  at: number
}

/**
 * One subagent asked to hand off because its context passed the threshold, through to the agent that
 * continues its work.
 *
 * `requested`: asked, its run still going; `deliveredAt` is when the request reached it, beside one of its
 * tool results. `complete`: its run ended with the task done. `ended`: its run failed or was stopped, which
 * main handles as any failed run. `reported`: it ended with work remaining and `report` holds its handoff
 * whole. `announced`: main has been told to continue it, as `continueAs` (`fork`, or an agent type).
 * `continued`: `continuedBy` is the agent carrying on, pinned to `model` and `effort`.
 */
export type Handoff = {
  agentId: string
  type: string
  tier?: 'haiku' | 'sonnet' | 'opus'
  description: string
  model: string
  effort?: HandoffEffort
  tokens: number
  window: number
  at: number
  status: 'requested' | 'complete' | 'ended' | 'reported' | 'announced' | 'continued'
  deliveredAt?: number
  report?: string
  continueAs?: string
  continuedBy?: string
}

/** A finished worker's final report, kept for the workers after it: the session's record of what was done. */
export type WorkerReport = {
  id: string
  tier: 'haiku' | 'sonnet' | 'opus'
  description: string
  report: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'model-balance': {
      toggle: SessionToggle
      mainContext: MainContext | null
      agents: AgentRow[]
      pins: Pin[]
      reports: WorkerReport[]
      handoffs: Handoff[]
      isHistoryOpen: boolean
      isPaneDismissed: boolean
    }
  }
}
