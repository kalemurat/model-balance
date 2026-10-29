import { expect, mock, test, type Engine } from 'claude-code/testing'
import type {
  AgentInfo,
  AgentSpawnInput,
  On,
  PromptSubmitInput,
  SessionMessage,
  SessionSendInput,
  ToolCallResult,
  TurnStepInput,
  TurnStopReason,
} from 'claude-code'

import { HANDOFF_COMPLETE, HANDOFF_CONTINUE, NOTICE_OPEN, continuesLine } from '../hooks/route'
import type { AgentRow, Handoff } from '../types'

const OPUS = 'model-balance:opus-worker'

const REPORT = [
  '## Handoff: stopped at the context limit.',
  '## Task: migrate the store to signals.',
  '## Done: src/store.ts moved to signals; tests pass.',
  '## State: selectors.ts half read, nothing edited in it.',
  '## Remaining:',
  '1. Port the last two selectors in src/selectors.ts.',
  '2. Run the store tests.',
  HANDOFF_CONTINUE,
].join('\n')

/** A step the engine answered: `tokens` of input context, and why the model stopped. */
type Answer = { tokens: number; stopReason: TurnStopReason }

/** A transcript a compaction runs over: the engine never compacts an empty one. */
const TRANSCRIPT: SessionMessage[] = [{ role: 'user', text: 'Migrate the store to signals.', toolUses: [] }]

/**
 * The session beneath the plugin: routing on unless `enabled` is false (this session's own saved choice:
 * nothing else turns it on), no other agent running, and every send, spawn, prompt, request and state
 * write recorded as it reached the bottom.
 */
const session = (on: On, options: { enabled?: boolean } = {}) => {
  mock.store(on, options.enabled === false ? {} : { 'session:s-1': { enabled: true, at: 1000 } })
  mock.env(on, {})
  mock.clock(on, { now: 1000 })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.id', () => ({ value: 's-1' }))
  on('session.messages', () => ({ value: [] }))
  // No auto memory: the breakdown lists no memory file, so a worker goes without the index.
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 } } }) as never)
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.cwd', () => ({ value: '/work' }))
  // The agents the engine lists as started; a test adds the ones whose run it needs listed.
  const listed: AgentInfo[] = []
  on('agent.list', () => ({ value: listed }))

  // The handoff request goes beside a tool result: a send would meet SendMessage's permission check.
  const sends: SessionSendInput[] = []
  on('session.send', (_, e) => {
    sends.push(e)

    return { isDelivered: true }
  })
  // Any tool answers plainly; Agent with `agentResult`, the record a test sets for a foreground run.
  const tools: { agentResult?: unknown } = {}
  on('tool.call', (_, e) => (e.tool === 'Agent' ? ({ result: tools.agentResult } as never) : ({ result: { stdout: 'ok' } } as never)))
  const spawns: AgentSpawnInput[] = []
  on('agent.spawn', (_, e) => {
    spawns.push(e)

    // A resume runs under the id it continues, as core answers it.
    return { model: 'claude-opus-5-5', agentId: e.resume?.agentId ?? `a-${spawns.length}` }
  })
  const prompts: PromptSubmitInput[] = []
  on('prompt.submit', (_, e) => {
    prompts.push(e)

    return { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  // The kit keeps the plugin's state beneath this hook; the test reads back what was last written.
  const state = new Map<string, unknown>()
  on('state.set', (_, e, next) => {
    if (e.plugin === 'model-balance') state.set(e.key, e.value)

    return next(e)
  })

  const requests: TurnStepInput[] = []
  const answer: Answer = { tokens: 10_000, stopReason: 'tool_use' }
  on('turn.step', async function* (_, e) {
    requests.push(e)

    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: answer.stopReason,
      usage: {
        input_tokens: 1000,
        cache_read_input_tokens: answer.tokens - 1000,
        cache_creation_input_tokens: 0,
        output_tokens: 300,
        model: 'claude-opus-5-5',
      },
    }
  })

  return {
    listed,
    tools,
    sends,
    spawns,
    prompts,
    requests,
    answer,
    handoffs: (): Handoff[] => (state.get('handoffs') as Handoff[] | undefined) ?? [],
    agents: (): AgentRow[] => (state.get('agents') as AgentRow[] | undefined) ?? [],
  }
}

const USAGE = { input_tokens: 300, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const spawnOf = (change: Partial<AgentSpawnInput> = {}): AgentSpawnInput => ({
  tool_use_id: 'toolu_1',
  prompt: 'Migrate the store to signals.',
  description: 'Migrate the store',
  subagentType: OPUS,
  provider: { plugin: 'model-balance', tier: 'user' },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
  ...change,
})

/** Runs one request of `agentId`'s loop through the plugins and reads it to its end. */
const step = async ($: Engine, agentId: string, effort: TurnStepInput['effort'] = 'xhigh'): Promise<void> => {
  const stream = $.turn.step({ turnId: `t-${agentId}`, index: 0, model: 'claude-opus-5-5', effort, messageCount: 40, agentId })
  for await (const _ of stream) {
    // A step the bottom answered whole yields nothing on the way.
  }
  await stream.result
}

const complete = ($: Engine, agentId: string, answer: string, reason: 'answer' | 'error' | 'aborted' = 'answer') =>
  $.turn.complete({ answer, durationMs: 60_000, isAborted: reason === 'aborted', turnId: `t-${agentId}`, agentId, reason })

/** One tool call of `agentId`'s loop, as its model makes it; the context it reads beside the result. */
const toolCall = async ($: Engine, agentId: string | undefined): Promise<string> => {
  const called = (await $.tool.call({ tool: 'Bash', command: 'ls', ...(agentId === undefined ? {} : { agentId }) } as never)) as ToolCallResult

  return called.context?.join('\n') ?? ''
}

const notify = ($: Engine, agentId: string) =>
  $.prompt.submit({
    text: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n<summary>Agent "Migrate the store" finished</summary>\n</task-notification>`,
    wait: false,
    origin: { kind: 'task-notification' },
  })

test('auto and precomputed compaction are skipped in main and subagents while routing is on; /compact runs', async ($, on) => {
  session(on)
  on('session.compact', (_, e) => ({ messages: e.messages }))

  for (const trigger of ['auto', 'precompute'] as const) {
    expect((await $.session.compact({ trigger, messages: TRANSCRIPT })).skip).toContain('auto-compaction is off')
    expect((await $.session.compact({ trigger, agentId: 'a-1', messages: TRANSCRIPT })).skip).toContain('/compact')
  }
  for (const trigger of ['manual', 'plugin'] as const) {
    expect((await $.session.compact({ trigger, messages: TRANSCRIPT })).messages).toHaveLength(1)
  }
})

test('compaction runs as usual while routing is off', async ($, on) => {
  session(on, { enabled: false })
  on('session.compact', (_, e) => ({ messages: e.messages }))

  for (const trigger of ['auto', 'precompute', 'manual'] as const) {
    const compacted = await $.session.compact({ trigger, messages: TRANSCRIPT })
    expect(compacted.skip).toBeUndefined()
    expect(compacted.messages).toHaveLength(1)
  }
})

test('a subagent is asked to hand off once, at 65%, beside its next tool result, and only while its run goes on', async ($, on) => {
  const world = session(on)
  expect((await $.agent.spawn(spawnOf())).agentId).toBe('a-1')

  world.answer.tokens = 649_000
  await step($, 'a-1')
  expect(world.handoffs()).toEqual([])
  expect(await toolCall($, 'a-1')).toBe('')

  // A run that ends here makes no tool call to carry the request, so none is recorded.
  world.answer.tokens = 650_000
  world.answer.stopReason = 'end_turn'
  await step($, 'a-1')
  expect(world.handoffs()).toEqual([])

  world.answer.stopReason = 'tool_use'
  await step($, 'a-1')
  // Main's own tool calls never carry it.
  expect(await toolCall($, undefined)).toBe('')
  const request = await toolCall($, 'a-1')
  expect(request).toContain('Context handoff')
  expect(request).toContain('65% full (650k of 1M tokens)')
  expect(await toolCall($, 'a-1')).toBe('')
  expect(world.sends).toHaveLength(0)

  world.answer.tokens = 700_000
  await step($, 'a-1')
  expect(await toolCall($, 'a-1')).toBe('')

  expect(world.handoffs()).toEqual([
    expect.objectContaining({
      agentId: 'a-1',
      type: OPUS,
      description: 'Migrate the store',
      model: 'claude-opus-5-5',
      effort: 'xhigh',
      tokens: 650_000,
      window: 1_000_000,
      status: 'requested',
      deliveredAt: 1000,
    }),
  ])
  expect(world.agents().find(row => row.id === 'a-1')).toMatchObject({ canHandOff: true, handoffAt: 65 })
})

test('an agent resumed after it was asked keeps the mark and is not asked again', async ($, on) => {
  const world = session(on)
  await $.agent.spawn(spawnOf())
  world.answer.tokens = 650_000
  await step($, 'a-1')
  expect(await toolCall($, 'a-1')).toContain('Context handoff')

  // SendMessage resumes the run: a spawn with `resume`, under the same id.
  await $.agent.spawn(spawnOf({ prompt: 'One more thing.', resume: { agentId: 'a-1' } }))
  expect(world.agents().find(row => row.id === 'a-1')).toMatchObject({ status: 'running', handoffAt: 65, canHandOff: true })
  world.answer.tokens = 720_000
  await step($, 'a-1')
  expect(await toolCall($, 'a-1')).toBe('')
  // A resume is never taken for the continuation of a pending handoff.
  expect(world.spawns[1]!.prompt).toBe('One more thing.')
})

test('a nested agent and a teammate are never asked, as main cannot start them again; a fork is', async ($, on) => {
  const world = session(on)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'OPUS HIGH', usage: USAGE } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  await $.agent.spawn(spawnOf({ subagentType: 'Explore', parentAgentId: 'a-9' }))
  await $.agent.spawn(spawnOf({ subagentType: 'teammate', isTeammate: true }))
  await $.agent.spawn(spawnOf({ subagentType: 'fork', fork: true }))

  world.answer.tokens = 900_000
  for (const agentId of ['a-1', 'a-2', 'a-3']) await step($, agentId)
  expect(world.handoffs().map(one => one.agentId)).toEqual(['a-3'])
  expect(world.agents().filter(row => row.canHandOff === true).map(row => row.id)).toEqual(['a-3'])
})

test('no handoff is asked while routing is off, and the spawn passes untouched', async ($, on) => {
  const world = session(on, { enabled: false })
  await $.agent.spawn(spawnOf({ subagentType: 'general-purpose' }))
  expect(world.spawns[0]!.prompt).toBe('Migrate the store to signals.')

  world.answer.tokens = 900_000
  await step($, 'a-1')
  expect(await toolCall($, 'a-1')).toBe('')
  expect(world.handoffs()).toEqual([])
})

test('a handoff goes from the report to main and on to a fresh worker with the report, model and effort', async ($, on) => {
  const world = session(on)
  await $.agent.spawn(spawnOf())
  world.answer.tokens = 660_000
  await step($, 'a-1')

  await complete($, 'a-1', REPORT)
  expect(world.handoffs()[0]).toMatchObject({ status: 'reported', report: REPORT })

  // Main is told once, with the notification that carries the agent's report.
  const notified = await notify($, 'a-1')
  const note = (notified as { context?: readonly string[] }).context?.join('\n') ?? ''
  expect(note).toContain('opus worker a-1 ("Migrate the store") stopped at 66%')
  expect(note).toContain(`subagent_type "${OPUS}"`)
  expect(note).toContain(continuesLine('a-1'))
  expect(note).toContain('same model (claude-opus-5-5) and effort xhigh')
  expect(world.handoffs()[0]?.status).toBe('announced')
  await notify($, 'a-1')
  expect(world.prompts.at(-1)?.context).toBeUndefined()

  // Main's spawn names the handoff; the report reaches the new worker whole, ahead of the brief.
  const started = await $.agent.spawn(
    spawnOf({ prompt: `Carry on with the store migration.\n${continuesLine('a-1')}`, description: 'Migrate the store (cont.)' }),
  )
  expect(started.agentId).toBe('a-2')
  const prompt = world.spawns[1]!.prompt
  expect(prompt).toContain('<previous_agent_handoff agent="a-1"')
  expect(prompt).toContain(REPORT)
  expect(prompt.indexOf('<previous_agent_handoff')).toBeLessThan(prompt.indexOf('<handoff>\nCarry on with the store migration.'))
  // The predecessor's report is not repeated, clipped, among the earlier workers.
  expect(prompt).not.toContain('<report worker="opus" id="a-1"')
  expect(world.spawns[1]!.model).toBe('claude-opus-5-5')
  expect(world.spawns[1]!.subagentType).toBe(OPUS)
  expect(world.handoffs()[0]).toMatchObject({ status: 'continued', continuedBy: 'a-2' })

  // The new worker's requests run at the effort the old one ran at, whatever they ask.
  world.answer.tokens = 20_000
  await step($, 'a-2', 'medium')
  expect(world.requests.at(-1)?.effort).toBe('xhigh')
  // Any other agent keeps its own effort.
  await $.agent.spawn(spawnOf({ subagentType: 'general-purpose', description: 'Look something up' }))
  await step($, 'a-3', 'medium')
  expect(world.requests.at(-1)?.effort).toBe('medium')
})

test('a spawn of the same type continues the one pending handoff even without the Continues line', async ($, on) => {
  const world = session(on)
  await $.agent.spawn(spawnOf({ subagentType: 'general-purpose' }))
  world.answer.tokens = 700_000
  await step($, 'a-1')
  await complete($, 'a-1', REPORT)
  await notify($, 'a-1')

  await $.agent.spawn(spawnOf({ subagentType: 'general-purpose', prompt: 'Continue the migration.' }))
  const prompt = world.spawns[1]!.prompt
  expect(prompt.startsWith('<previous_agent_handoff agent="a-1" type="general-purpose" context="70%">')).toBe(true)
  expect(prompt).toContain(REPORT)
  // The agent is told the handoff note is the user's, so it hands off again in turn.
  expect(prompt).toContain(`Continue the migration.\n\n${NOTICE_OPEN}`)
  expect(world.spawns[1]!.model).toBe('claude-opus-5-5')
  expect(world.handoffs()[0]).toMatchObject({ status: 'continued', continuedBy: 'a-2' })

  // Done once: the next spawn of that type starts fresh.
  await $.agent.spawn(spawnOf({ subagentType: 'general-purpose', prompt: 'Something else.' }))
  expect(world.spawns[2]!.prompt.startsWith(`Something else.\n\n${NOTICE_OPEN}`)).toBe(true)
  expect(world.spawns[2]!.prompt).not.toContain('<previous_agent_handoff')
})

test('a run that finished its task, failed or was stopped after the request is not continued', async ($, on) => {
  const world = session(on)
  for (let index = 0; index < 3; index++) await $.agent.spawn(spawnOf({ subagentType: 'general-purpose' }))
  world.answer.tokens = 700_000
  for (const agentId of ['a-1', 'a-2', 'a-3']) await step($, agentId)
  expect(world.handoffs()).toHaveLength(3)

  await complete($, 'a-1', `## Result: all done.\n${HANDOFF_COMPLETE}`)
  await complete($, 'a-2', 'Partial output before the API error.', 'error')
  await complete($, 'a-3', REPORT, 'aborted')
  expect(world.handoffs().map(one => [one.agentId, one.status])).toEqual([
    ['a-3', 'ended'],
    ['a-2', 'ended'],
    ['a-1', 'complete'],
  ])

  for (const agentId of ['a-1', 'a-2', 'a-3']) await notify($, agentId)
  expect(world.prompts.every(one => one.context === undefined)).toBe(true)

  // A finished run that is resumed and then hands off is read again.
  await complete($, 'a-1', REPORT)
  expect(world.handoffs().find(one => one.agentId === 'a-1')?.status).toBe('reported')
})

test("a foreground agent's handoff reaches main beside the Agent tool's result", async ($, on) => {
  const world = session(on)
  // The Agent tool's own record of a foreground run that finished.
  world.tools.agentResult = {
    status: 'completed',
    agentId: 'a-1',
    content: [{ type: 'text', text: REPORT }],
    totalToolUseCount: 30,
    totalDurationMs: 60_000,
    totalTokens: 650_000,
    prompt: 'Migrate the store to signals.',
  }
  await $.agent.spawn(spawnOf({ background: false }))
  world.answer.tokens = 650_000
  await step($, 'a-1')
  await complete($, 'a-1', REPORT)

  const called = await $.tool.call({ tool: 'Agent', description: 'Migrate the store', prompt: 'Migrate the store to signals.', subagent_type: OPUS })
  expect(called.context?.join('\n')).toContain(continuesLine('a-1'))
  expect(world.handoffs()[0]?.status).toBe('announced')
})

test('the note reaches main even after routing was switched off', async ($, on) => {
  const world = session(on)
  await $.agent.spawn(spawnOf())
  world.answer.tokens = 650_000
  await step($, 'a-1')
  await $.command.run({ command: 'model-balance', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

  await complete($, 'a-1', REPORT)
  const notified = await notify($, 'a-1')
  expect((notified as { context?: readonly string[] }).context?.join('\n')).toContain(continuesLine('a-1'))
})

test('the board marks the agent asked to hand off', async ($, on) => {
  const rows: AgentRow[] = [
    {
      id: 'a-1',
      type: OPUS,
      tier: 'opus',
      description: 'Migrate the store',
      status: 'running',
      startedAt: 0,
      model: 'claude-opus-5-5',
      effort: 'xhigh',
      contextTokens: 660_000,
      window: 1_000_000,
      canHandOff: true,
      handoffAt: 65,
    },
  ]
  on('state.get', ($, e, next) => (e.key === 'agents' ? ({ value: { value: rows, version: 1 } } as never) : next(e)))
  on('clock.now', () => ({ value: 60_000 }))

  const ui = await $.ui.mount({
    plugin: 'model-balance',
    component: 'Pane',
    requestId: 'model-balance',
    surface: 'vscode',
    props: {
      title: 'model-balance',
      isFocused: false,
      bodyColumns: 120,
      placement: 'inline',
      scroll: { offset: 0, bodyRows: 12 },
      view: {},
    },
  })
  const row = (await ui.find({ type: 'Text', text: /opus worker/ }))?.text
  expect(row).toContain('ctx 66%')
  expect(row).toContain('handoff at 65%')
  await ui.unmount()
})

test('the agent continuing a parallel part keeps its scope and starts beside the other part', async ($, on) => {
  const world = session(on)
  await $.agent.spawn(spawnOf({ prompt: 'Migrate the store.\n## Scope: be/' }))
  await $.agent.spawn(spawnOf({ prompt: 'Migrate the views.\n## Scope: fe/', description: 'Migrate the views' }))
  world.listed.push({ id: 'a-2', type: OPUS, status: 'running', description: 'Migrate the views' })
  world.answer.tokens = 660_000
  await step($, 'a-1')
  await complete($, 'a-1', REPORT)
  expect(world.handoffs()[0]).toMatchObject({ status: 'reported', scope: ['be'] })

  await notify($, 'a-1')
  const started = await $.agent.spawn(
    spawnOf({ prompt: `Carry on with the store migration.\n${continuesLine('a-1')}`, description: 'Migrate the store (cont.)' }),
  )
  // The fe/ part still runs; the be/ continuation stays out of its scope, so it starts.
  expect(started.agentId).toBe('a-3')
  expect(world.agents().find(row => row.id === 'a-3')?.scope).toEqual(['be'])
})
