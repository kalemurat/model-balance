/**
 * This session's on/off, tagged with the session it was decided for: a process
 * that moves to another session (/clear, /resume) does not carry it over.
 */
export type SessionToggle = { sessionId: string; enabled: boolean }

/** The main conversation's context fill as the engine last measured it; `tokens` is absent until a response of the live window came back. */
export type MainContext = { tokens?: number; window: number; percent?: number }

/**
 * One subagent of this session as the board shows it, the latest run of it: a resume through SendMessage
 * starts the clock again. `tier` is set for a model-balance worker only; `contextTokens` is the input side
 * of its latest request, absent before the first one came back.
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
      reports: WorkerReport[]
      isHistoryOpen: boolean
      isPaneDismissed: boolean
    }
  }
}
