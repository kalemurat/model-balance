import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { AgentInfo, AgentSpawnInput, On, PromptSubmitInput, TurnStepInput } from 'claude-code'

import { LEGACY_DEFAULT_KEY, NOTICE_OPEN, sessionToggleKey } from '../hooks/route'
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
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.id', () => ({ value: 's-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', () => ({ value: [] }))
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
