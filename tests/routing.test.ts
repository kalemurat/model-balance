import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { AgentInfo, AgentSpawnInput, On, PromptSubmitInput, SessionMessage, ToolCallResult, TurnStepInput } from 'claude-code'

import { LEGACY_DEFAULT_KEY, MARK_CLOSE, MARK_OPEN, NOTICE_OPEN, sessionToggleKey } from '../hooks/route'
import type { AgentRow, Pin } from '../types'

const USAGE = { input_tokens: 300, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const PRESENTATION = { isFullscreen: false, columns: 100 } as const

/**
 * The session beneath the plugin: routing on unless `enabled` is false, main on Opus with `mainTokens` of
 * context, the router answering `reply`, and every router call, prompt, spawn, command and request recorded.
 */
const session = (on: On, options: { enabled?: boolean; reply?: string; mainTokens?: number; store?: Record<string, unknown> } = {}) => {
  // `$.store` in memory, every delete recorded.
  const store = new Map<string, unknown>(
    Object.entries({
      ...(options.enabled === false ? {} : { [sessionToggleKey('s-1')]: { enabled: true, at: 1000 } }),
      ...options.store,
    }),
  )
  const deleted: string[] = []
  on('store.get', (_, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }) as never)
  on('store.keys', () => ({ value: [...store.keys()] }) as never)
  on('store.delete', (_, e) => (deleted.push(e.key), store.delete(e.key), { value: undefined }) as never)
  mock.env(on, {})
  mock.clock(on, { now: 1000 })
  const statuses: (string | undefined)[] = []
  on('ui.status', (_, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  // The session the process runs under: a /clear moves it to another.
  const ids = { session: 's-1' }
  on('session.id', () => ({ value: ids.session }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  // Main's transcript as the guards read it; a test adds the routed prompt when it needs one.
  const messages: SessionMessage[] = []
  on('session.messages', () => ({ value: messages }))
  on('session.cwd', () => ({ value: '/work' }))
  on('tool.call', () => ({ result: { stdout: 'ok' } }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 } } }) as never)
  on('session.surfaces', () => ({ value: ['terminal'] }))
  const agents: AgentInfo[] = []
  on('agent.list', () => ({ value: agents }))

  const rated: string[] = []
  const world = { reply: options.reply ?? 'SONNET MEDIUM NEW' }
  on('model.complete', (_, e) => {
    rated.push(typeof e.prompt === 'string' ? e.prompt : '')

    return { value: { isAnswered: true, text: world.reply, usage: USAGE } }
  })
  const state = new Map<string, unknown>()
  on('state.get', ($, e, next) =>
    e.plugin === 'model-balance' && e.key === 'mainContext' && options.mainTokens !== undefined
      ? ({ value: { value: { tokens: options.mainTokens, window: 1_000_000 }, version: 1 } } as never)
      : next(e),
  )
  on('state.set', (_, e, next) => {
    if (e.plugin === 'model-balance') state.set(e.key, e.value)

    return next(e)
  })
  const prompts: PromptSubmitInput[] = []
  on('prompt.submit', (_, e) => {
    prompts.push(e)

    return { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }
  })
  const commands: string[] = []
  on('command.run', (_, e) => {
    commands.push(e.args)

    return { text: '' }
  })
  const spawns: AgentSpawnInput[] = []
  on('agent.spawn', (_, e) => {
    spawns.push(e)

    return { model: 'claude-opus-5-5', agentId: `a-${spawns.length}` }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const requests: TurnStepInput[] = []
  on('turn.step', async function* (_, e) {
    requests.push(e)

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })

  return {
    world,
    ids,
    statuses,
    messages,
    agents,
    rated,
    prompts,
    commands,
    spawns,
    requests,
    pins: (): Pin[] => (state.get('pins') as Pin[] | undefined) ?? [],
    rows: (): AgentRow[] => (state.get('agents') as AgentRow[] | undefined) ?? [],
    stored: state,
    deleted,
  }
}

const prompt = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

const noteOf = (submitted: unknown): string => (submitted as { context?: readonly string[] }).context?.join('\n') ?? ''

/** One request of `agentId`'s loop, as main's model and effort would send it; what reached the bottom. */
const step = async ($: Engine, world: ReturnType<typeof session>, agentId: string): Promise<TurnStepInput> => {
  const stream = $.turn.step({ turnId: `t-${agentId}`, index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 40, agentId })
  for await (const _ of stream) {
    // Answered whole at the bottom.
  }
  await stream.result

  return world.requests.at(-1)!
}

const spawnOf = (change: Partial<AgentSpawnInput> = {}): AgentSpawnInput => ({
  tool_use_id: 'toolu_1',
  prompt: 'Fix the login form.',
  description: 'Fix the login form',
  subagentType: 'model-balance:sonnet-worker',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
  ...change,
})

test('the router picks the model and the effort, and the worker runs at both', async ($, on) => {
  const world = session(on, { reply: 'SONNET MEDIUM NEW' })
  const note = noteOf(await prompt($, 'Fix the validation bug in the login form, the email field accepts spaces.'))
  expect(note).toContain('rated this request SONNET at effort MEDIUM (sonnet router)')
  expect(note).toContain('subagent_type "model-balance:sonnet-worker"')
  expect(note).toContain('runs the worker on sonnet at effort medium')
  // A routed task goes to a fresh worker with a brief, never to a fork that would carry main's whole context.
  expect(note).not.toContain('subagent_type "fork"')

  await $.agent.spawn(spawnOf())
  expect(world.spawns[0]!.model).toBe('sonnet')
  const sent = await step($, world, 'a-1')
  expect(sent.model).toBe('sonnet')
  expect(sent.effort).toBe('medium')
  expect(world.pins()).toEqual([expect.objectContaining({ agentId: 'a-1', tier: 'sonnet', model: 'sonnet', effort: 'medium' })])
})

test('a #tier:effort prefix skips the router; a bare #tier runs at its option', async ($, on) => {
  const world = session(on)
  const note = noteOf(await prompt($, '#opus:high Design the session store migration.'))
  expect(world.rated).toHaveLength(0)
  expect(note).toContain('rated this request OPUS at effort HIGH (override)')
  expect(world.prompts.at(-1)?.text).toBe('Design the session store migration.')
  await $.agent.spawn(spawnOf({ subagentType: 'model-balance:opus-worker' }))
  expect((await step($, world, 'a-1')).effort).toBe('high')

  // The next prompt's own verdict: a bare tier runs at the tier's option, xhigh for Opus by default.
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't-a-1', agentId: 'a-1', reason: 'answer' })
  expect(noteOf(await prompt($, '#haiku Rename the helper to formatTokens.'))).toContain('rated this request HAIKU at effort MEDIUM (override)')
})

test('a /subtask is rated and pinned: a cheaper model while main is small, its effort either way', async ($, on) => {
  const world = session(on, { reply: 'HAIKU LOW', mainTokens: 30_000 })
  await $.command.run({ command: 'subtask', args: 'draft unit tests for the parser', origin: { kind: 'composer' }, presentation: PRESENTATION })
  const args = world.commands.at(-1)!
  // The task opens the arguments as typed, so the fork's name stays the person's.
  expect(args.startsWith('draft unit tests for the parser\n\n')).toBe(true)
  expect(args).toContain(NOTICE_OPEN)
  expect(args).toContain('you run on haiku at effort low')

  // A /subtask raises no spawn: the fork's first turn, starting with those arguments, takes the pin.
  world.agents.push({ id: 'a-sub', type: 'fork', status: 'running', description: 'draft unit tests for the parser' })
  await $.turn.start({ text: args, turnId: 't-a-sub', agentId: 'a-sub' })
  const sent = await step($, world, 'a-sub')
  expect(sent.model).toBe('haiku')
  expect(sent.effort).toBe('low')
  expect(world.rows().find(row => row.id === 'a-sub')).toMatchObject({ tier: 'haiku', type: 'fork', canHandOff: true, model: 'haiku' })
})

test("a /subtask past the switch limit stays on main's model, and so its cache, at the rated effort", async ($, on) => {
  const world = session(on, { reply: 'SONNET MEDIUM', mainTokens: 120_000 })
  await $.command.run({ command: 'subtask', args: 'summarise the open review threads', origin: { kind: 'composer' }, presentation: PRESENTATION })
  const args = world.commands.at(-1)!
  expect(args).toContain("you run on the main conversation's model at effort medium")

  world.agents.push({ id: 'a-sub', type: 'fork', status: 'running', description: 'summarise the open review threads' })
  await $.turn.start({ text: args, turnId: 't-a-sub', agentId: 'a-sub' })
  const sent = await step($, world, 'a-sub')
  expect(sent.model).toBe('claude-opus-5-5')
  expect(sent.effort).toBe('medium')
})

test("a fork main starts on its own is rated the same way; another agent only learns the handoff note is the user's", async ($, on) => {
  const world = session(on, { reply: 'OPUS LOW', mainTokens: 200_000 })
  await $.agent.spawn(spawnOf({ subagentType: 'fork', fork: true, prompt: 'Check whether the cache key includes the locale.' }))
  expect(world.spawns[0]!.prompt).toContain('Check whether the cache key includes the locale.\n\n[model-balance notice]')
  expect(world.spawns[0]!.model).toBeUndefined()
  // Opus is main's own family: the fork keeps main's model and cache, its effort lowered.
  const sent = await step($, world, 'a-1')
  expect(sent.model).toBe('claude-opus-5-5')
  expect(sent.effort).toBe('low')

  await $.agent.spawn(spawnOf({ subagentType: 'Explore', prompt: 'Find the cache key builder.' }))
  expect(world.rated).toHaveLength(1)
  expect(world.spawns[1]!.prompt).toContain('The model-balance router runs in this session.')
  expect((await step($, world, 'a-2')).effort).toBe('xhigh')
})

test('with routing off nothing is rated, rewritten or pinned', async ($, on) => {
  const world = session(on, { enabled: false })
  expect(noteOf(await prompt($, 'Fix the validation bug in the login form, the email field accepts spaces.'))).toBe('')
  await $.command.run({ command: 'subtask', args: 'draft unit tests', origin: { kind: 'composer' }, presentation: PRESENTATION })
  expect(world.commands.at(-1)).toBe('draft unit tests')
  await $.agent.spawn(spawnOf({ subagentType: 'fork', fork: true, prompt: 'Look around.' }))
  expect(world.spawns[0]!.prompt).toBe('Look around.')
  expect(world.rated).toHaveLength(0)
  const sent = await step($, world, 'a-1')
  expect(sent.model).toBe('claude-opus-5-5')
  expect(sent.effort).toBe('xhigh')
})

test('every session starts off, whatever an earlier version stored as the default, and the old key is dropped', async ($, on) => {
  const world = session(on, { enabled: false, store: { [LEGACY_DEFAULT_KEY]: true } })
  on('agent.register', (_, e) => ({ value: { agent: `model-balance:${e.name}` } }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  expect(world.stored.get('toggle')).toEqual({ sessionId: 's-1', enabled: false })
  expect(world.deleted).toContain(LEGACY_DEFAULT_KEY)
  const status = await $.command.run({ command: 'model-balance', args: 'default on', origin: { kind: 'composer' }, presentation: PRESENTATION })
  expect(status.text).toContain('Unknown argument "default on"')
  expect(status.text).toContain('every new session starts off')
})

test("the router hears that small changes stay in main only while main's context is small", async ($, on) => {
  const small = session(on, { reply: 'MAIN NEW', mainTokens: 60_000 })
  expect(noteOf(await prompt($, 'Add a docstring to the add function in calc.py.'))).toBe('')
  expect(small.rated.at(-1)).toContain('<main_context tokens="60000">')
})

test('past the limit the router is not told to keep small changes in main', async ($, on) => {
  const large = session(on, { reply: 'HAIKU LOW NEW', mainTokens: 400_000 })
  expect(noteOf(await prompt($, 'Add a docstring to the add function in calc.py.'))).toContain('HAIKU at effort LOW')
  expect(large.rated.at(-1)).not.toContain('<main_context')
})

test('a /clear starts the next conversation off, with nothing of the last one on the board or in a worker prompt', async ($, on) => {
  const world = session(on)
  on('classic.SessionStart', () => ({}))
  await prompt($, 'Fix the validation bug in the login form, the email field accepts spaces.')
  await $.agent.spawn(spawnOf())
  await $.turn.complete({ answer: '## Result: the login form is fixed.', durationMs: 1, isAborted: false, turnId: 't-a-1', agentId: 'a-1', reason: 'answer' })
  expect(world.stored.get('reports')).toHaveLength(1)

  world.ids.session = 's-2'
  await $.classic.SessionStart({ source: 'clear', session_id: 's-2' })
  expect(world.stored.get('toggle')).toEqual({ sessionId: 's-2', enabled: false })
  // The engine heads the line with the plugin's name itself.
  expect(world.statuses.at(-1)).toBe('off')
  expect(world.rows()).toEqual([])
  expect(world.stored.get('reports')).toEqual([])
  expect(noteOf(await prompt($, 'Fix the validation bug in the signup form, the name field accepts digits.'))).toBe('')

  await $.command.run({ command: 'model-balance', args: 'on', origin: { kind: 'composer' }, presentation: PRESENTATION })
  world.agents.push({ id: 'a-1', type: 'model-balance:sonnet-worker', status: 'completed', description: 'Fix the login form' })
  const note = noteOf(await prompt($, 'Fix the validation bug in the signup form, the name field accepts digits.'))
  // The last conversation's worker is not offered to the router as one to continue.
  expect(world.rated.at(-1)).not.toContain('<last_worker')
  expect(note).toContain('subagent_type "model-balance:sonnet-worker"')
  await $.agent.spawn(spawnOf({ prompt: 'Fix the signup form.' }))
  expect(world.spawns.at(-1)!.prompt).not.toContain('<earlier_workers>')
})

test('a resumed session keeps its own choice', async ($, on) => {
  const world = session(on, { store: { [sessionToggleKey('s-old')]: { enabled: true, at: 1000 } } })
  on('classic.SessionStart', () => ({}))
  world.ids.session = 's-old'
  await $.classic.SessionStart({ source: 'resume', session_id: 's-old' })
  expect(world.stored.get('toggle')).toEqual({ sessionId: 's-old', enabled: true })
  expect(world.statuses.at(-1)).toBe('on')
})

test("main's row follows the model and effort of main's latest request", async ($, on) => {
  const world = session(on)
  const mainStep = async (model: string, effort: TurnStepInput['effort']): Promise<void> => {
    const stream = $.turn.step({ turnId: 't-main', index: 0, model, ...(effort === undefined ? {} : { effort }), messageCount: 4 })
    for await (const _ of stream) {
      // Answered whole at the bottom.
    }
    await stream.result
  }

  await mainStep('claude-opus-5-5', 'high')
  expect(world.stored.get('mainContext')).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
  await mainStep('claude-sonnet-5-5', 'low')
  expect(world.stored.get('mainContext')).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' })
  // Main's own request is never rewritten.
  expect(world.requests.at(-1)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' })
})

test('a short follow-up tells the status line it stayed in main', async ($, on) => {
  const world = session(on)
  await prompt($, 'merge et')
  expect(world.rated).toHaveLength(0)
  expect(world.statuses.at(-1)).toBe('→ main (short prompt)')
})

const SPLIT_TASK = 'Add the invoice export endpoint and its download button in the app.'

/** A brief of one parallel part, as main writes it under the routing note. */
const partBrief = (request: string, scope: string): string =>
  `## Request: ${request}\n## Scope: ${scope}\n## Contract: GET /invoices/export returns a CSV file.`

/** Main's transcript once the router's note came with the person's prompt: the turn is routed. */
const routedTurn = (world: ReturnType<typeof session>): void => {
  world.messages.push({ role: 'user', text: `${SPLIT_TASK}\n\n${MARK_OPEN}\nrouting note\n${MARK_CLOSE}`, toolUses: [] })
}

test('a split task runs one scoped worker per part, each rated on its own brief, side by side', async ($, on) => {
  const world = session(on, { reply: 'SONNET HIGH NEW' })
  expect(noteOf(await prompt($, SPLIT_TASK))).toContain('## Scope:')

  world.world.reply = 'OPUS HIGH'
  await $.agent.spawn(spawnOf({ description: 'Export endpoint', prompt: partBrief('the endpoint', 'be/') }))
  world.agents.push({ id: 'a-1', type: 'model-balance:opus-worker', status: 'running', description: 'Export endpoint' })
  world.world.reply = 'HAIKU LOW'
  await $.agent.spawn(spawnOf({ description: 'Download button', prompt: partBrief('the button', '`fe/` (the app)') }))

  // The request is rated once, and each part again on its brief alone.
  expect(world.rated).toHaveLength(3)
  expect(world.rated[2]!.startsWith('Brief of the part to rate:')).toBe(true)
  expect(world.spawns.map(one => [one.subagentType, one.model])).toEqual([
    ['model-balance:opus-worker', 'opus'],
    ['model-balance:haiku-worker', 'haiku'],
  ])
  expect((await step($, world, 'a-1')).effort).toBe('high')
  expect((await step($, world, 'a-2')).effort).toBe('low')
  expect(world.stored.get('parts')).toEqual([
    { agentId: 'a-1', scope: ['be'] },
    { agentId: 'a-2', scope: ['fe'] },
  ])
  expect(world.rows().find(row => row.id === 'a-2')?.scope).toEqual(['fe'])
})

test('a worker overlapping a running writer, or with no scope beside one, is refused; so is a fork on a routed turn', async ($, on) => {
  const world = session(on)
  await prompt($, SPLIT_TASK)
  await $.agent.spawn(spawnOf({ prompt: partBrief('the endpoint', 'be/') }))
  world.agents.push({ id: 'a-1', type: 'model-balance:sonnet-worker', status: 'running', description: 'Export endpoint' })

  expect((await $.agent.spawn(spawnOf({ prompt: partBrief('the export job', 'be/jobs/') }))).deny).toContain('overlaps')
  expect((await $.agent.spawn(spawnOf({ prompt: 'Fix the login form.' }))).deny).toContain('may write anywhere')
  expect(world.spawns).toHaveLength(1)

  routedTurn(world)
  const fork = await $.agent.spawn(spawnOf({ subagentType: 'fork', fork: true, prompt: 'Do the fe/ side.' }))
  expect(fork.deny).toContain('a fork is refused on this turn')
  expect(world.spawns).toHaveLength(1)
})

test("a part edits only inside its scope; main, on the split turn, only outside every part's", async ($, on) => {
  const world = session(on)
  await prompt($, SPLIT_TASK)
  routedTurn(world)
  await $.agent.spawn(spawnOf({ prompt: partBrief('the endpoint', 'be/') }))
  const edit = async (path: string, agentId?: string): Promise<ToolCallResult> =>
    (await $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b', ...(agentId === undefined ? {} : { agentId }) } as never)) as ToolCallResult

  expect((await edit('/work/be/src/export.ts', 'a-1')).deny).toBeUndefined()
  expect((await edit('/work/be/../fe/src/button.ts', 'a-1')).deny).toContain('outside it')
  expect((await edit('/work/docs/api.md')).deny).toBeUndefined()
  expect((await edit('/work/be/src/export.ts')).deny).toContain('scope of a parallel part')
})

test('a new task goes ahead beside scoped parts, and waits for a writer that may write anywhere', async ($, on) => {
  const world = session(on, { reply: 'SONNET HIGH NEW' })
  await prompt($, SPLIT_TASK)
  await $.agent.spawn(spawnOf({ description: 'Export endpoint', prompt: partBrief('the endpoint', 'be/') }))
  world.agents.push({ id: 'a-1', type: 'model-balance:sonnet-worker', status: 'running', description: 'Export endpoint' })

  const beside = noteOf(await prompt($, 'Fix the typo in the README introduction paragraph.'))
  expect(beside).toContain('rated this request SONNET')
  expect(beside).toContain('Still running: sonnet worker a-1 in be/')

  world.agents.push({ id: 'a-x', type: 'fork', status: 'running', description: 'look around' })
  expect(noteOf(await prompt($, 'Fix the typo in the README introduction paragraph.'))).toContain('fork a-x is still running')
})

test('a follow-up to a split is judged against every part and sent to the ones it concerns', async ($, on) => {
  const world = session(on, { reply: 'SONNET HIGH NEW' })
  await prompt($, SPLIT_TASK)
  world.world.reply = 'SONNET HIGH'
  await $.agent.spawn(spawnOf({ description: 'Export endpoint', prompt: partBrief('the endpoint', 'be/') }))
  await $.agent.spawn(spawnOf({ description: 'Download button', prompt: partBrief('the button', 'fe/') }))
  world.agents.push(
    { id: 'a-1', type: 'model-balance:sonnet-worker', status: 'completed', description: 'Export endpoint' },
    { id: 'a-2', type: 'model-balance:sonnet-worker', status: 'completed', description: 'Download button' },
  )

  world.world.reply = 'SONNET MEDIUM CONTINUE'
  const note = noteOf(await prompt($, 'The download button should also show a spinner while it waits.'))
  expect(world.rated.at(-1)).toContain('Description: Export endpoint (in be/); Download button (in fe/)')
  expect(note).toContain('continuation of the task these parallel parts did')
  expect(note).toContain('sonnet worker a-1 in be/')
  expect(note).toContain('sonnet worker a-2 in fe/')
})
