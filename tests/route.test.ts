import { expect, test } from 'claude-code/testing'

import {
  DEFAULT_WORKER_EFFORT,
  agentLabel,
  cappedSubagentEffort,
  endStatusOf,
  formatElapsed,
  formatReports,
  patchAgent,
  pushReport,
  readRouterModel,
  readWorkerEffort,
  restartAgent,
  routerChain,
  upsertAgent,
  MARK_CLOSE,
  contextBar,
  contextColor,
  contextFigures,
  contextTokensOf,
  contextWindowOf,
  isSwitchOn,
  type WindowEnv,
  formatContextReport,
  formatTokens,
  percentOf,
  MARK_OPEN,
  excerptOf,
  clipMemoryIndex,
  directoryOf,
  isActiveStatus,
  isContinuationReply,
  isInside,
  isRoutedTurn,
  memoryIndexPathOf,
  pickLastWorker,
  readAnswers,
  formatAnswers,
  guessTier,
  isStaleSessionToggle,
  isWorthRouting,
  parseVerdict,
  readOverride,
  readQuestions,
  readDefaultToggle,
  readSavedToggle,
  readToggleCommand,
  sessionToggleKey,
  SAVED_TOGGLE_TTL_MS,
  tierOfWorker,
  workerType,
} from '../hooks/route'

test('an override prefix is read and stripped', async () => {
  expect(readOverride('#opus redesign the store')).toEqual({ override: 'opus', rest: 'redesign the store' })
  expect(readOverride('  #MAIN just answer')).toEqual({ override: 'main', rest: 'just answer' })
  expect(readOverride('fix #opus later')).toEqual({ rest: 'fix #opus later' })
})

test('short follow-ups and slash commands are not routed', async () => {
  expect(isWorthRouting('devam')).toBe(false)
  expect(isWorthRouting('/compact keep it short')).toBe(false)
  expect(isWorthRouting('add a loading state to the user table')).toBe(true)
})

test('the classifier reply and model names map to tiers', async () => {
  expect(parseVerdict('OPUS')).toBe('opus')
  expect(parseVerdict(' Sonnet.')).toBe('sonnet')
  expect(parseVerdict('no idea')).toBeUndefined()
  expect(parseVerdict('SONNET CONTINUE')).toBe('sonnet')
  expect(parseVerdict('MAIN NEW')).toBe('main')
  expect(parseVerdict('main')).toBe('main')
  expect(isContinuationReply('SONNET CONTINUE')).toBe(true)
  expect(isContinuationReply('opus new')).toBe(false)
  expect(isContinuationReply('HAIKU')).toBe(false)
  expect(tierOfWorker(workerType('sonnet'))).toBe('sonnet')
  expect(tierOfWorker('general-purpose')).toBeUndefined()
})

test('the heuristic reads Turkish and English signals', async () => {
  expect(guessTier('bu modülün mimarisini yeniden tasarla')).toBe('opus')
  expect(guessTier('şu metni özetle')).toBe('haiku')
  expect(guessTier('çevir bunu ingilizceye')).toBe('haiku')
  expect(guessTier('add a column to the users table')).toBe('sonnet')
})

test('the router is Sonnet unless Haiku is chosen, the other one standing in', async () => {
  expect(readRouterModel(undefined)).toBe('sonnet')
  expect(readRouterModel('opus')).toBe('sonnet')
  expect(readRouterModel('haiku')).toBe('haiku')
  expect(routerChain('sonnet')).toEqual(['sonnet', 'haiku'])
  expect(routerChain('haiku')).toEqual(['haiku', 'sonnet'])
})

test('a worker effort is a level below max or session; max and unknown values fall back to the tier default', async () => {
  expect(DEFAULT_WORKER_EFFORT).toEqual({ haiku: 'medium', sonnet: 'high', opus: 'xhigh' })
  expect(readWorkerEffort(undefined, 'opus')).toBe('xhigh')
  expect(readWorkerEffort('low', 'opus')).toBe('low')
  expect(readWorkerEffort('session', 'haiku')).toBe('session')
  expect(readWorkerEffort('max', 'sonnet')).toBe('high')
  expect(readWorkerEffort('turbo', 'haiku')).toBe('medium')
})

test('a subagent request never runs at max', async () => {
  expect(cappedSubagentEffort('max')).toBe('xhigh')
  expect(cappedSubagentEffort('xhigh')).toBeUndefined()
  expect(cappedSubagentEffort('low')).toBeUndefined()
  expect(cappedSubagentEffort(undefined)).toBeUndefined()
  expect(cappedSubagentEffort(32_000)).toBeUndefined()
})

test("the excerpt cuts main's messages shorter than the user's", async () => {
  const long = 'x'.repeat(1200)
  const excerpt = excerptOf([
    { role: 'user', text: long, toolUses: [] },
    { role: 'assistant', text: long, toolUses: [] },
  ])

  expect(excerpt).toContain(`USER: ${long}`)
  expect(excerpt).toContain(`ASSISTANT: ${'x'.repeat(700)} …[500 chars cut]`)
})

test('a worker report is kept newest first, replaces its own earlier one and is clipped', async () => {
  const report = (id: string, text: string) => ({ id, tier: 'sonnet' as const, description: `task ${id}`, report: text, at: 1 })
  let reports = pushReport([], report('a', 'first'), 3)
  reports = pushReport(reports, report('b', 'second'), 3)
  reports = pushReport(reports, report('a', 'again'), 3)
  expect(reports.map(one => [one.id, one.report])).toEqual([
    ['a', 'again'],
    ['b', 'second'],
  ])
  expect(pushReport([], report('c', 'y'.repeat(3000)), 3)[0]!.report).toContain('…[500 chars cut]')

  expect(formatReports(reports, 1)).toBe('<report worker="sonnet" id="a" task="task a">\nagain\n</report>')
  expect(formatReports([], 4)).toBe('')
})

test('board rows: elapsed time, labels, end status, upsert and restart', async () => {
  expect(formatElapsed(45_400)).toBe('45s')
  expect(formatElapsed(72_000)).toBe('1m 12s')
  expect(formatElapsed(3_780_000)).toBe('1h 3m')
  expect(formatElapsed(-5)).toBe('0s')
  expect(agentLabel({ tier: 'opus', type: workerType('opus') })).toBe('opus worker')
  expect(agentLabel({ type: 'Explore' })).toBe('Explore')
  expect(endStatusOf('answer')).toBe('done')
  expect(endStatusOf('aborted')).toBe('stopped')
  expect(endStatusOf('error')).toBe('failed')

  const row = (id: string) => ({
    id,
    type: workerType('haiku'),
    tier: 'haiku' as const,
    description: id,
    status: 'running' as const,
    startedAt: 0,
    window: 1_000_000,
  })
  const rows = upsertAgent(upsertAgent([row('a')], row('b'), 2), row('c'), 2)
  expect(rows.map(one => one.id)).toEqual(['c', 'b'])
  expect(upsertAgent(rows, row('b'), 2).map(one => one.id)).toEqual(['b', 'c'])

  const ended = patchAgent(rows, 'b', { status: 'done', endedAt: 9, outputTokens: 120 })
  expect(ended.find(one => one.id === 'b')).toMatchObject({ status: 'done', endedAt: 9, outputTokens: 120 })
  const again = restartAgent(ended, 'b', 50).find(one => one.id === 'b')!
  expect(again.status).toBe('running')
  expect(again.startedAt).toBe(50)
  expect('endedAt' in again).toBe(false)
  expect('outputTokens' in again).toBe(false)
})

test('the excerpt drops routing notes and keeps the newest messages', async () => {
  const excerpt = excerptOf([
    { role: 'user', text: 'first question', toolUses: [] },
    { role: 'assistant', text: 'first answer', toolUses: [] },
    { role: 'user', text: `rename the field\n${MARK_OPEN}\nnote for main\n${MARK_CLOSE}`, toolUses: [] },
  ])

  expect(excerpt).toContain('USER: first question')
  expect(excerpt).toContain('USER: rename the field')
  expect(excerpt).not.toContain('note for main')
  expect(excerpt.indexOf('first question')).toBeLessThan(excerpt.indexOf('rename the field'))
})

test('a worker question batch is checked and shaped for one AskUserQuestion dialog', async () => {
  expect(readQuestions([])).toBe('`questions` must be an array of 1-4 questions.')
  expect(readQuestions([{ question: 'Which store?', options: ['Seed'] }])).toBe(
    'questions[0].options must be 2-4 options, each with a non-empty label.',
  )
  expect(readQuestions([{ question: 'Which store?', options: [{ label: 'Seed' }, { description: 'no label' }] }])).toBe(
    'questions[0].options must be 2-4 options, each with a non-empty label.',
  )
  expect(
    readQuestions([
      {
        question: 'Which store?',
        header: 'Store backing',
        options: [{ label: 'Seed', description: 'Keep the seed data' }, 'HTTP'],
        multiSelect: false,
      },
    ]),
  ).toEqual([
    {
      question: 'Which store?',
      header: 'Store backin',
      options: [
        { label: 'Seed', description: 'Keep the seed data' },
        { label: 'HTTP', description: '' },
      ],
      multiSelect: false,
    },
  ])
  expect(readQuestions([{ question: 'Which?', options: ['A', 'B'], multiSelect: true }])).toEqual([
    {
      question: 'Which?',
      header: 'Question',
      options: [
        { label: 'A', description: '' },
        { label: 'B', description: '' },
      ],
      multiSelect: true,
    },
  ])
})

test('dialog answers pair with their questions; a skipped one is unanswered', async () => {
  expect(readAnswers(['Which store?', 'Keep the seed?'], { 'Which store?': 'HTTP', 'Keep the seed?': '  ' })).toEqual({
    asked: [{ question: 'Which store?', answer: 'HTTP' }],
    unanswered: ['Keep the seed?'],
  })
  expect(readAnswers(['Which store?'], {})).toEqual({ asked: [], unanswered: ['Which store?'] })
})

const worker = (id: string, status: string, extra: { parentId?: string; type?: string } = {}) => ({
  id,
  type: extra.type ?? workerType('sonnet'),
  status,
  description: id,
  ...(extra.parentId === undefined ? {} : { parentId: extra.parentId }),
})

test('the last worker is the one this module started, else the newest listed; stopped ones are skipped', async () => {
  const agents = [worker('a', 'completed'), worker('b', 'completed'), worker('c', 'killed')]
  expect(pickLastWorker(agents)?.id).toBe('b')
  expect(pickLastWorker(agents, 'a')?.id).toBe('a')
  expect(pickLastWorker(agents, 'c')?.id).toBe('b')
  expect(pickLastWorker([worker('x', 'running', { type: 'Explore' }), worker('n', 'running', { parentId: 'b' })])).toBeUndefined()
  expect(isActiveStatus('running')).toBe(true)
  expect(isActiveStatus('waiting')).toBe(true)
  expect(isActiveStatus('completed')).toBe(false)
  expect(isActiveStatus('idle')).toBe(false)
})

const userText = (text: string) => ({ role: 'user' as const, text, toolUses: [] })

test('a turn stays routed until the person sends an unrouted prompt', async () => {
  const routed = userText(`fix the table\n${MARK_OPEN}\nnote\n${MARK_CLOSE}`)
  expect(isRoutedTurn([routed])).toBe(true)
  expect(isRoutedTurn([routed, { role: 'assistant', text: 'delegating', toolUses: [] }, userText('')])).toBe(true)
  expect(isRoutedTurn([routed, userText('<task-notification>worker done</task-notification>')])).toBe(true)
  expect(isRoutedTurn([routed, userText('now edit it yourself')])).toBe(false)
  expect(isRoutedTurn([userText('hello there')])).toBe(false)
  expect(isRoutedTurn([])).toBe(false)
})

test('the auto-memory index is found among memory files and clipped as a session loads it', async () => {
  const files = [
    { path: '/repo/CLAUDE.md', type: 'Project' },
    { path: '/home/u/.claude/projects/-repo/memory/MEMORY.md', type: 'AutoMem' },
  ]
  expect(memoryIndexPathOf(files)).toBe('/home/u/.claude/projects/-repo/memory/MEMORY.md')
  expect(memoryIndexPathOf(files.slice(0, 1))).toBeUndefined()
  expect(directoryOf('/home/u/.claude/projects/-repo/memory/MEMORY.md')).toBe('/home/u/.claude/projects/-repo/memory')
  expect(isInside('/home/u/.claude/projects/-repo/memory/feedback_x.md', '/home/u/.claude/projects/-repo/memory')).toBe(true)
  expect(isInside('/home/u/.claude/projects/-repo/memory-old/x.md', '/home/u/.claude/projects/-repo/memory')).toBe(false)
  expect(clipMemoryIndex(Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n')).split('\n')).toHaveLength(200)
  expect(clipMemoryIndex('x'.repeat(30_000))).toHaveLength(25_000)
})

test('answers go back verbatim and a dismissed question stops the worker', async () => {
  const answered = formatAnswers([{ question: 'Which store?', answer: 'HTTP' }], [])
  expect(answered).toBe('Q: Which store?\nA: HTTP')

  const dismissed = formatAnswers([{ question: 'Which store?', answer: 'HTTP' }], ['Keep the seed?'])
  expect(dismissed).toContain('Q: Which store?\nA: HTTP')
  expect(dismissed).toContain('The user left these unanswered: "Keep the seed?"')
  expect(dismissed).toContain('Do not guess')
})

test('on/off switches this session, default on/off the sessions to come', async () => {
  expect(readToggleCommand(' ON ')).toEqual({ scope: 'session', enabled: true })
  expect(readToggleCommand('off')).toEqual({ scope: 'session', enabled: false })
  expect(readToggleCommand('default  on')).toEqual({ scope: 'default', enabled: true })
  expect(readToggleCommand('')).toEqual({ scope: 'status', isUnknown: false })
  expect(readToggleCommand('status')).toEqual({ scope: 'status', isUnknown: false })
  expect(readToggleCommand('default')).toEqual({ scope: 'status', isUnknown: true })
  expect(readToggleCommand('on please')).toEqual({ scope: 'status', isUnknown: true })

  // A fresh install routes nothing until `default on` has been run.
  expect(readDefaultToggle(undefined)).toBe(false)
  expect(readDefaultToggle(false)).toBe(false)
  expect(readDefaultToggle('true')).toBe(false)
  expect(readDefaultToggle(true)).toBe(true)
})

test('saved session choices are read strictly and pruned past their TTL', async () => {
  const now = 10 * SAVED_TOGGLE_TTL_MS
  const key = sessionToggleKey('7e61c33a')

  expect(readSavedToggle({ enabled: true, at: now })).toEqual({ enabled: true, at: now })
  expect(readSavedToggle(true)).toBeUndefined()
  expect(readSavedToggle({ enabled: 'yes', at: now })).toBeUndefined()

  expect(isStaleSessionToggle(key, { enabled: false, at: now - 1000 }, now)).toBe(false)
  expect(isStaleSessionToggle(key, { enabled: false, at: now - SAVED_TOGGLE_TTL_MS - 1 }, now)).toBe(true)
  expect(isStaleSessionToggle(key, 'garbage', now)).toBe(true)
  expect(isStaleSessionToggle('enabled', false, now)).toBe(false)
})

test('context figures are summed, scaled and drawn', async () => {
  expect(contextTokensOf({ input_tokens: 10, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 500 })).toBe(40_510)
  expect(formatTokens(842)).toBe('842')
  expect(formatTokens(2000)).toBe('2k')
  expect(formatTokens(52_300)).toBe('52k')
  expect(formatTokens(1_200_000)).toBe('1.2M')
  expect(percentOf(50_000, 200_000)).toBe(25)
  expect(percentOf(300_000, 200_000)).toBe(100)
  expect(percentOf(1, 0)).toBe(0)
  expect(contextBar(40)).toBe('████░░░░░░')
  expect(contextBar(150)).toBe('██████████')
  expect(contextColor(59)).toBe('success')
  expect(contextColor(70)).toBe('warning')
  expect(contextColor(90)).toBe('error')
  expect(contextFigures(226_000, 1_000_000)).toBe('23% · 226k / 1M')
  expect(contextFigures(226_000, 1_000_000, 24)).toBe('24% · 226k / 1M')
})

const anthropicEnv: WindowEnv = { provider: 'anthropic', isOneMillionOff: false, aliasOverrides: {} }

test('worker windows follow the documented model table', async () => {
  for (const nativeOneMillion of [
    'claude-opus-5-5',
    'claude-opus-4-7',
    'claude-sonnet-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-fable-5-1',
    'us.anthropic.claude-opus-4-7-v1:0',
  ]) {
    expect(contextWindowOf(nativeOneMillion, anthropicEnv)).toBe(1_000_000)
  }
  for (const twoHundredK of [
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5@20250929',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-20250514',
    'claude-3-5-sonnet-20241022',
    'something-else',
  ]) {
    expect(contextWindowOf(twoHundredK, anthropicEnv)).toBe(200_000)
  }
  expect(contextWindowOf('claude-opus-4-6[1m]', anthropicEnv)).toBe(1_000_000)
})

test('an alias resolves by provider and override before its window is read', async () => {
  expect(contextWindowOf('sonnet', anthropicEnv)).toBe(1_000_000)
  expect(contextWindowOf('haiku', { ...anthropicEnv, provider: 'bedrock' })).toBe(200_000)
  expect(contextWindowOf('opus', { ...anthropicEnv, provider: 'bedrock' })).toBe(1_000_000)
  expect(contextWindowOf('opus', { ...anthropicEnv, provider: 'foundry' })).toBe(200_000)
  expect(contextWindowOf('fable', { ...anthropicEnv, provider: 'foundry' })).toBe(1_000_000)
  expect(contextWindowOf('opus', { ...anthropicEnv, aliasOverrides: { opus: 'claude-opus-4-6' } })).toBe(200_000)
  expect(contextWindowOf('opus', { ...anthropicEnv, aliasOverrides: { opus: 'opus' } })).toBe(1_000_000)
})

test('CLAUDE_CODE_DISABLE_1M_CONTEXT holds every worker at 200k', async () => {
  const off = { ...anthropicEnv, isOneMillionOff: true }
  expect(contextWindowOf('claude-opus-5-5', off)).toBe(200_000)
  expect(contextWindowOf('claude-opus-4-6[1m]', off)).toBe(200_000)
  expect(contextWindowOf('fable', off)).toBe(200_000)
  expect(isSwitchOn(' TRUE ')).toBe(true)
  expect(isSwitchOn('on')).toBe(true)
  expect(isSwitchOn('0')).toBe(false)
  expect(isSwitchOn('')).toBe(false)
  expect(isSwitchOn(undefined)).toBe(false)
})

test('the context subcommand is read and the report lists main and agents', async () => {
  expect(readToggleCommand(' Context ')).toEqual({ scope: 'context' })
  expect(readToggleCommand('panel')).toEqual({ scope: 'panel' })
  expect(readToggleCommand('context now')).toEqual({ scope: 'status', isUnknown: true })

  const report = formatContextReport({ label: 'main', tokens: 100_000, window: 200_000 }, [
    { label: 'opus worker', tokens: 52_000, window: 200_000, note: 'completed' },
    { label: 'Explore', window: 200_000, note: 'running' },
  ])
  expect(report).toContain('main  █████░░░░░ 50% · 100k / 200k')
  expect(report).toContain('opus worker  ███░░░░░░░ 26% · 52k / 200k  (completed)')
  expect(report).toContain('Explore  no request yet  (running)')
  expect(formatContextReport({ label: 'main', window: 200_000 }, [])).toContain('no agents yet')
})
