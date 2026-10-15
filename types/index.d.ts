/**
 * This session's on/off, tagged with the session it was decided for: a process
 * that moves to another session (/clear, /resume) does not carry it over.
 */
export type SessionToggle = { sessionId: string; enabled: boolean }

/** The main conversation's context fill as the engine last measured it; `tokens` is absent until a response of the live window came back. */
export type MainContext = { tokens?: number; window: number; percent?: number }

/** One finished worker run; `contextTokens` is the input side of its last request, absent when none was reported. */
export type WorkerRun = {
  tier: 'haiku' | 'sonnet' | 'opus'
  seconds: number
  contextTokens?: number
  window: number
  outputTokens?: number
}

declare module 'claude-code' {
  interface PluginState {
    'model-balance': { toggle: SessionToggle; mainContext: MainContext | null; workerRuns: WorkerRun[] }
  }
}
