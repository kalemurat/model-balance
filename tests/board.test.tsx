import { expect, test } from 'claude-code/testing'

import type { AgentRow } from '../types'

const rows: AgentRow[] = [
  {
    id: 'a-run',
    type: 'model-balance:sonnet-worker',
    tier: 'sonnet',
    description: 'Fix the login form',
    status: 'running',
    startedAt: 0,
    model: 'claude-sonnet-5-5',
    effort: 'high',
    contextTokens: 41_000,
    window: 1_000_000,
  },
  {
    id: 'a-done',
    type: 'model-balance:opus-worker',
    tier: 'opus',
    description: 'Refactor the store',
    status: 'done',
    startedAt: 0,
    endedAt: 243_000,
    contextTokens: 120_000,
    window: 1_000_000,
    outputTokens: 8000,
  },
]

/** What the board reads, as a session would hold it; a key left out falls through to the kit's own state. */
type Seed = Record<string, unknown>

const BAND = {
  plugin: 'model-balance',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 12,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'model-balance',
  component: 'Pane',
  requestId: 'model-balance',
  props: {
    title: 'model-balance',
    isFocused: false,
    bodyColumns: 60,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

test('the band shows the running worker and keeps the finished ones behind a button', async ($, on) => {
  const state: Seed = {
    toggle: { sessionId: 's', enabled: true },
    mainContext: { tokens: 226_000, window: 1_000_000, percent: 23, model: 'claude-opus-5-5', effort: 'high' },
    agents: rows,
  }
  on('state.get', ($, e, next) => (e.key in state ? ({ value: { value: state[e.key], version: 1 } } as never) : next(e)))
  // The kit's clock stands for the engine's: the running row is five minutes old.
  on('clock.now', () => ({ value: 300_000 }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ type: 'Text', text: /model-balance · main/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /opus-5-5/ }))?.text).toBe('· opus-5-5 · effort high')
    expect((await ui.find({ type: 'Text', text: /sonnet worker/ }))?.text).toContain('Fix the login form')
    expect(await ui.find({ type: 'Text', text: /Refactor the store/ })).toBeUndefined()

    await ui.press({ key: 'history-toggle' })
    expect((await ui.find({ type: 'Text', text: /opus worker/ }))?.text).toContain('Refactor the store')

    await ui.press({ key: 'history-toggle' })
    expect(await ui.find({ type: 'Text', text: /Refactor the store/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the band stays empty while routing is off', async ($, on) => {
  const state: Seed = { toggle: { sessionId: 's', enabled: false }, agents: rows }
  on('state.get', ($, e, next) => (e.key in state ? ({ value: { value: state[e.key], version: 1 } } as never) : next(e)))
  // The kit's clock stands for the engine's: the running row is five minutes old.
  on('clock.now', () => ({ value: 300_000 }))

  // Stands for the engine's own band, which the plugin leaves in place.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /sonnet worker/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('the pane draws the same board in VS Code, where no band is drawn', async ($, on) => {
  const state: Seed = { agents: rows }
  on('state.get', ($, e, next) => (e.key in state ? ({ value: { value: state[e.key], version: 1 } } as never) : next(e)))
  // The kit's clock stands for the engine's: the running row is five minutes old.
  on('clock.now', () => ({ value: 300_000 }))

  for (const surface of ['vscode', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    const running = (await ui.find({ type: 'Text', text: /sonnet worker/ }))?.text
    expect(running).toContain('5m 0s')
    expect(running).toContain('effort high')
    expect((await ui.find({ type: 'Button', key: 'history-toggle' }))?.text).toContain('Finished (1)')
    await ui.unmount()
  }
})

test('an empty pane says no subagent has run', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('No subagent has run in this session yet.')
  await ui.unmount()
})
