import type { ModelEffort, SessionMessage } from 'claude-code'

import type { AgentRow, Handoff, HandoffEffort, Pin, WorkerReport } from '../types'

export type Tier = 'haiku' | 'sonnet' | 'opus'

/** Where the router sends a request: a worker tier, or the main conversation itself. */
export type Route = Tier | 'main'

export const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus']

export const MARK_OPEN = '[model-balance]'
export const MARK_CLOSE = '[/model-balance]'

/**
 * Brackets what this mod adds to an agent's own prompt. Unlike MARK_OPEN it never marks a routed turn: a
 * /subtask's arguments, notice included, come back in main's transcript as the command's echo.
 */
export const NOTICE_OPEN = '[model-balance notice]'
export const NOTICE_CLOSE = '[/model-balance notice]'

/** Shorter prompts are follow-ups ("devam", "ok", "evet") the main model answers itself. */
const MIN_ROUTED_LENGTH = 16

/** The verbatim tail a worker gets beside main's handoff brief, for exact wording only. */
const EXCERPT_MESSAGES = 12
const EXCERPT_MESSAGE_CHARS = 1500
const EXCERPT_TOTAL_CHARS = 14000

/** The tool a worker asks the person through; listed as `mcp__model-balance__ask_user`. */
export const ASK_TOOL = 'ask_user'

/** One question in the shape AskUserQuestion takes, so a batch opens as one dialog. */
export type WorkerQuestion = {
  question: string
  header: string
  options: { label: string; description: string }[]
  multiSelect: boolean
}

export type AskedQuestion = { question: string; answer: string }

const HEADER_MAX = 12
const DEFAULT_HEADER = 'Question'

export const ASK_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      description: 'Asked together in one dialog.',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The full question, ending in a question mark.' },
          header: { type: 'string', maxLength: HEADER_MAX, description: 'A short chip label, 12 characters at most.' },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'The choice, 1-5 words.' },
                description: { type: 'string', description: 'One line on what choosing it leads to.' },
              },
              required: ['label'],
            },
            description: '2-4 choices; put a recommended one first with " (Recommended)" in its label. The user can always type an answer of their own instead.',
          },
          multiSelect: { type: 'boolean' },
        },
        required: ['question', 'options'],
      },
    },
  },
  required: ['questions'],
} as const

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

/** An option as the schema asks for it, or a bare label string as the tool took before. */
const readOption = (option: unknown): { label: string; description: string } | undefined => {
  if (isText(option)) return { label: option, description: '' }
  const { label, description } = (option ?? {}) as Record<string, unknown>

  return isText(label) ? { label, description: isText(description) ? description : '' } : undefined
}

/** The tool's `questions` argument, checked; a string says what is wrong with it. */
export const readQuestions = (questions: unknown): WorkerQuestion[] | string => {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) {
    return '`questions` must be an array of 1-4 questions.'
  }

  const read: WorkerQuestion[] = []
  for (const [index, one] of questions.entries()) {
    const { question, header, options, multiSelect } = (one ?? {}) as Record<string, unknown>
    if (!isText(question)) return `questions[${index}].question must be a non-empty string.`
    const choices = Array.isArray(options) ? options.map(readOption) : []
    if (choices.length < 2 || choices.length > 4 || choices.some(choice => choice === undefined)) {
      return `questions[${index}].options must be 2-4 options, each with a non-empty label.`
    }

    read.push({
      question,
      header: isText(header) ? header.slice(0, HEADER_MAX) : DEFAULT_HEADER,
      options: choices as { label: string; description: string }[],
      multiSelect: multiSelect === true,
    })
  }

  return read
}

/**
 * Pairs each asked question with the dialog's answer, keyed as AskUserQuestion keys them (by question text).
 * A question with no non-empty answer (skipped, or the dialog resolved on idle) goes to `unanswered`.
 */
export const readAnswers = (
  questions: readonly string[],
  answers: Readonly<Record<string, unknown>>,
): { asked: AskedQuestion[]; unanswered: string[] } => {
  const asked: AskedQuestion[] = []
  const unanswered: string[] = []
  for (const question of questions) {
    const answer = answers[question]
    if (isText(answer)) asked.push({ question, answer })
    else unanswered.push(question)
  }

  return { asked, unanswered }
}

/** What the worker reads back: every answer, and a stop order for what went unanswered. */
export const formatAnswers = (asked: readonly AskedQuestion[], unanswered: readonly string[]): string => {
  const lines = asked.map(({ question, answer }) => `Q: ${question}\nA: ${answer}`)
  if (unanswered.length > 0) {
    lines.push(
      `The user left these unanswered: ${unanswered.map(q => `"${q}"`).join(', ')}. Do not guess an answer: stop, and list these questions under "Open questions" in your final report.`,
    )
  }

  return lines.join('\n\n')
}

export const workerType = (tier: Tier): string => `model-balance:${tier}-worker`

export const tierOfWorker = (subagentType: string): Tier | undefined =>
  TIERS.find(tier => workerType(tier) === subagentType)

/**
 * Reads a leading `#haiku`, `#sonnet`, `#opus` or `#main` the person typed to override the router, an
 * effort after a tier (`#opus:high`), and the prompt without it. An effort that is no subagent level
 * (`#opus:max`) is dropped, the tier kept.
 */
export const readOverride = (
  text: string,
): { override?: Tier | 'main'; effort?: SubagentEffort; rest: string } => {
  const found = /^\s*#(haiku|sonnet|opus|main)(?::([a-z]+))?(?![\w:])\s*/i.exec(text)
  if (found === null) return { rest: text }
  const override = found[1]!.toLowerCase() as Tier | 'main'
  const effort = override === 'main' ? undefined : readEffortWord(found[2] ?? '')

  return {
    override,
    ...(effort === undefined ? {} : { effort }),
    rest: text.slice(found[0].length),
  }
}

/**
 * The `$.store` key `/model-balance default on|off` kept the on/off of new sessions under. Every session
 * starts off now, so it is no longer read, and the start-up prune drops it.
 */
export const LEGACY_DEFAULT_KEY = 'enabled'

const SESSION_TOGGLE_PREFIX = 'session:'

/** A saved per-session choice older than this is dropped: the session is not going to be resumed. */
export const SAVED_TOGGLE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** One session's own `/model-balance on|off`, kept in `$.store` so a resumed session finds it again. */
export type SavedToggle = { enabled: boolean; at: number }

export const sessionToggleKey = (sessionId: string): string => `${SESSION_TOGGLE_PREFIX}${sessionId}`

export const readSavedToggle = (value: unknown): SavedToggle | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const { enabled, at } = value as Record<string, unknown>

  return typeof enabled === 'boolean' && typeof at === 'number' ? { enabled, at } : undefined
}

/** Whether a `$.store` entry is a per-session choice that is malformed or past its TTL. */
export const isStaleSessionToggle = (key: string, value: unknown, now: number): boolean => {
  if (!key.startsWith(SESSION_TOGGLE_PREFIX)) return false
  const saved = readSavedToggle(value)

  return saved === undefined || now - saved.at > SAVED_TOGGLE_TTL_MS
}

export type ToggleCommand =
  | { scope: 'session'; enabled: boolean }
  | { scope: 'context' }
  | { scope: 'panel' }
  | { scope: 'status'; isUnknown: boolean }

/**
 * Reads `/model-balance` arguments: `on|off` for this session, `context` for every context window, `panel`
 * to open or close the board's pane, anything else shows the status. There is no default for new sessions:
 * each starts off, so `default on|off` reads as an unknown argument.
 */
export const readToggleCommand = (args: string): ToggleCommand => {
  const words = args.trim().toLowerCase().split(/\s+/).filter(word => word !== '')
  const [first] = words
  if (words.length === 1 && first === 'context') return { scope: 'context' }
  if (words.length === 1 && first === 'panel') return { scope: 'panel' }
  if (words.length === 1 && (first === 'on' || first === 'off')) return { scope: 'session', enabled: first === 'on' }

  return { scope: 'status', isUnknown: words.length > 0 && !(words.length === 1 && first === 'status') }
}

export const isWorthRouting = (text: string): boolean =>
  text.trim().length >= MIN_ROUTED_LENGTH && !text.trimStart().startsWith('/')

/** Takes the first MAIN / HAIKU / SONNET / OPUS word of the classifier's reply. */
export const parseVerdict = (reply: string): Route | undefined => {
  const found = /\b(main|haiku|sonnet|opus)\b/i.exec(reply)

  return found === null ? undefined : (found[1]!.toLowerCase() as Route)
}

/** A subagent level as one word of a reply or a prefix (`HIGH`, `xhigh`), `undefined` for anything else. */
export const readEffortWord = (word: string): SubagentEffort | undefined => {
  const level = word.trim().toLowerCase()

  return SUBAGENT_EFFORT_LEVELS.includes(level as SubagentEffort) ? (level as SubagentEffort) : undefined
}

/** Takes the first LOW / MEDIUM / HIGH / XHIGH word of the classifier's reply; `\b` keeps HIGH out of XHIGH. */
export const parseEffort = (reply: string): SubagentEffort | undefined => {
  const found = /\b(xhigh|high|medium|low)\b/i.exec(reply)

  return found === null ? undefined : readEffortWord(found[1]!)
}

/** The models the router may rate with, a `router_model` option. */
export type RouterModel = 'sonnet' | 'haiku'

/** `router_model` as configured, Sonnet for anything else: a wrong tier costs a whole worker run, the rating one short request. */
export const readRouterModel = (value: unknown): RouterModel => (value === 'haiku' ? 'haiku' : 'sonnet')

/** The efforts the router may rate at, a `router_effort` option: a rating never needs more than `high`. */
export type RouterEffort = 'low' | 'medium' | 'high'

/** `router_effort` as configured, `medium` for anything else. */
export const readRouterEffort = (value: unknown): RouterEffort =>
  value === 'low' || value === 'high' ? value : 'medium'

/** The configured router first, then the other, which stands in when the first fails or is blocked. */
export const routerChain = (first: RouterModel): readonly RouterModel[] =>
  first === 'sonnet' ? ['sonnet', 'haiku'] : ['haiku', 'sonnet']

/** The levels a subagent may run at: the person ruled `max` out for every subagent. */
export type SubagentEffort = Exclude<ModelEffort, 'max'>

/** A worker tier's effort: a level its agent definition carries, or `session` to set none and let Claude Code resolve it. */
export type WorkerEffort = SubagentEffort | 'session'

const SUBAGENT_EFFORT_LEVELS: readonly SubagentEffort[] = ['low', 'medium', 'high', 'xhigh']

/** Each tier's effort when its `<tier>_effort` option is unset; mirrors the manifest's defaults. */
export const DEFAULT_WORKER_EFFORT: Readonly<Record<Tier, WorkerEffort>> = { haiku: 'medium', sonnet: 'high', opus: 'xhigh' }

/** A `<tier>_effort` option as configured; an unset or unknown value (`max` included) falls back to the tier's default. */
export const readWorkerEffort = (value: unknown, tier: Tier): WorkerEffort =>
  value === 'session' || SUBAGENT_EFFORT_LEVELS.includes(value as SubagentEffort)
    ? (value as WorkerEffort)
    : DEFAULT_WORKER_EFFORT[tier]

/**
 * A subagent request's effort held below `max`, the ceiling the person set: whatever asked for `max` (the
 * session's level a `session` worker takes, `CLAUDE_CODE_EFFORT_LEVEL`, an Agent call's `effort`) runs at `xhigh`.
 * `undefined` when the request needs no change.
 */
export const cappedSubagentEffort = (effort: ModelEffort | number | undefined): SubagentEffort | undefined =>
  effort === 'max' ? 'xhigh' : undefined

/** The effort a subagent request runs at: as asked, `max` held at `xhigh`. */
export const subagentEffortOf = (effort: ModelEffort | number | undefined): HandoffEffort | undefined =>
  cappedSubagentEffort(effort) ?? (effort as HandoffEffort | undefined)

/** Whether the classifier judged the request a continuation of the last worker's task. */
export const isContinuationReply = (reply: string): boolean => /\bCONTINUE\b/i.test(reply)

/** The fields of an agent list entry the router reads. */
export type WorkerCandidate = { id: string; type: string; status: string; parentId?: string; description: string }

/** Statuses of an agent whose run has not ended: a second writer must not start beside it. */
export const isActiveStatus = (status: string): boolean => status === 'pending' || status === 'running' || status === 'waiting'

/**
 * The worker a follow-up could continue: `preferredId` (the latest this module started) when listed,
 * else the last top-level worker in the list. A worker the person stopped is skipped: docs/sub-agents
 * says a message to it is refused.
 */
export const pickLastWorker = <A extends WorkerCandidate>(agents: readonly A[], preferredId?: string): A | undefined => {
  const resumable = agents.filter(
    agent => tierOfWorker(agent.type) !== undefined && agent.parentId === undefined && agent.status !== 'killed',
  )

  return resumable.find(agent => agent.id === preferredId) ?? resumable.at(-1)
}

/**
 * Whether main is answering a prompt the router handed to a worker: the newest user text that is not
 * the engine's own (a reminder, a task notification, a command echo: they open with `<`) carries the
 * routing note. A worker's report arriving after it keeps the turn routed; the person's next unrouted
 * prompt (`#main`, a short follow-up) ends it.
 */
export const isRoutedTurn = (messages: readonly SessionMessage[]): boolean => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const { role, text } = messages[index]!
    if (role !== 'user' || text === '') continue
    if (text.includes(MARK_OPEN)) return true
    if (!text.trimStart().startsWith('<')) return false
  }

  return false
}

const MEMORY_INDEX_LINES = 200
const MEMORY_INDEX_CHARS = 25_000

/** The part of `MEMORY.md` a session loads (docs/memory: the first 200 lines or 25KB, whichever comes first). */
export const clipMemoryIndex = (text: string): string =>
  text.split('\n').slice(0, MEMORY_INDEX_LINES).join('\n').slice(0, MEMORY_INDEX_CHARS)

/** The auto-memory `MEMORY.md` among the context's memory files, `undefined` when auto memory is off. */
export const memoryIndexPathOf = (files: readonly { path: string; type: string }[]): string | undefined =>
  files.find(file => file.type === 'AutoMem' && /[/\\]MEMORY\.md$/.test(file.path))?.path

/** The directory part of an absolute path, either separator. */
export const directoryOf = (path: string): string => path.replace(/[/\\][^/\\]*$/, '')

/** Whether `path` lies inside `directory`; both absolute. */
export const isInside = (path: string, directory: string): boolean => {
  const base = directory.replace(/[/\\]+$/, '')

  return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`)
}

/** Matches any of `stems` as the start of a word; `\b` would miss stems opening with ö, ç, ğ. */
const wordStarts = (stems: readonly string[]): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}_])(?:${stems.join('|')})`, 'iu')

const OPUS_SIGNALS = wordStarts([
  'architect', 'mimari', 'design', 'tasarla', 'refactor', 'migrat',
  'root cause', 'kök neden', 'race condition', 'deadlock', 'memory leak',
  'bellek sızıntı', 'security', 'güvenlik', 'performan', 'concurren', 'plan',
])
const HAIKU_SIGNALS = wordStarts([
  'typo', 'rename', 'yeniden adlandır', 'translate', 'çevir', 'summari',
  'özetle', 'format', 'commit mesaj', 'what is', 'ne demek', 'list',
])

/** Used only when the classifier gives no verdict. */
export const guessTier = (text: string): Tier => {
  if (text.length > 1500 || OPUS_SIGNALS.test(text)) return 'opus'
  if (text.length < 200 && HAIKU_SIGNALS.test(text)) return 'haiku'

  return 'sonnet'
}

/** Drops this mod's own routing notes and agent notices (a /subtask echo carries one) from a message so a worker never reads them. */
export const stripRoutingNote = (text: string): string =>
  text
    .replace(new RegExp(`${escape(MARK_OPEN)}[\\s\\S]*?${escape(MARK_CLOSE)}`, 'g'), '')
    .replace(new RegExp(`${escape(NOTICE_OPEN)}[\\s\\S]*?${escape(NOTICE_CLOSE)}`, 'g'), '')
    .trim()

const escape = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)} …[${text.length - max} chars cut]`

/** Main's own messages are cut shorter: they mostly relay worker reports, which reach a worker in a block of their own. */
const EXCERPT_ASSISTANT_CHARS = 700

/**
 * The main conversation's latest messages as plain text, newest last, sized so
 * the worker gets the thread without the whole transcript being re-sent.
 *
 * Tool calls are named, not replayed: their results stay in the main context.
 */
export const excerptOf = (messages: readonly SessionMessage[]): string => {
  const lines: string[] = []
  let size = 0

  for (const message of [...messages].reverse().slice(0, EXCERPT_MESSAGES)) {
    const text = stripRoutingNote(message.text)
    const tools = message.toolUses.map(use => use.tool).join(', ')
    if (text === '' && tools === '') continue

    const line = [
      `${message.role.toUpperCase()}: ${clip(text, message.role === 'assistant' ? EXCERPT_ASSISTANT_CHARS : EXCERPT_MESSAGE_CHARS)}`,
      tools === '' ? '' : `  (tools used: ${tools})`,
    ]
      .filter(part => part !== '')
      .join('\n')

    if (size + line.length > EXCERPT_TOTAL_CHARS) break
    size += line.length
    lines.unshift(line)
  }

  return lines.join('\n\n')
}

const WINDOW_200K = 200_000
const WINDOW_1M = 1_000_000

type ModelFamily = Tier | 'fable'

/** Where requests go, as the `CLAUDE_CODE_USE_*` variables select it; a gateway counts as the Anthropic API. */
export type Provider = 'anthropic' | 'anthropic-aws' | 'bedrock' | 'vertex' | 'foundry'

/** What decides a window besides the model id, read from the environment by the caller. */
export type WindowEnv = {
  provider: Provider
  isOneMillionOff: boolean
  /** `ANTHROPIC_DEFAULT_<FAMILY>_MODEL`: the id an alias resolves to in place of the provider's default. */
  aliasOverrides: Partial<Record<ModelFamily, string>>
}

/** Claude Code's on/off reading of a variable: `1`, `true`, `yes` or `on`, in any casing. */
export const isSwitchOn = (value: string | undefined): boolean =>
  value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())

/**
 * docs/model-config → Model aliases, per provider. The table has no `fable` column; Fable runs with a
 * native 1M window on every provider, so any Fable id stands in for it.
 */
const ALIAS_TARGETS: Record<Provider, Record<ModelFamily, string>> = {
  anthropic: { opus: 'opus-5-5', sonnet: 'sonnet-5-5', haiku: 'haiku-5-5', fable: 'fable-5-1' },
  'anthropic-aws': { opus: 'opus-5-5', sonnet: 'sonnet-4-6', haiku: 'haiku-4-5', fable: 'fable-5-1' },
  bedrock: { opus: 'opus-5-5', sonnet: 'sonnet-4-5', haiku: 'haiku-4-5', fable: 'fable-5-1' },
  vertex: { opus: 'opus-5-5', sonnet: 'sonnet-4-5', haiku: 'haiku-4-5', fable: 'fable-5-1' },
  foundry: { opus: 'opus-4-6', sonnet: 'sonnet-4-5', haiku: 'haiku-4-5', fable: 'fable-5-1' },
}

type ModelVersion = { family: ModelFamily; major: number; minor: number }

/**
 * Family and version out of an id in any provider's spelling (`claude-opus-4-6[1m]`,
 * `us.anthropic.claude-haiku-4-5-20251001-v1:0`, `claude-sonnet-4-5@20250929`).
 * Pre-4 ids (`claude-3-5-sonnet-20241022`) carry no version after the family and yield `undefined`.
 */
const readModelId = (id: string): ModelVersion | undefined => {
  const found = /(opus|sonnet|haiku|fable)[-\s](\d{1,2})(?:[-.](\d{1,2}))?(?!\d)/i.exec(id)
  if (found === null) return undefined

  return { family: found[1]!.toLowerCase() as ModelFamily, major: Number(found[2]), minor: Number(found[3] ?? 0) }
}

const isAtLeast = ({ major, minor }: ModelVersion, atLeastMajor: number, atLeastMinor: number): boolean =>
  major > atLeastMajor || (major === atLeastMajor && minor >= atLeastMinor)

/** docs/model-config → Extended context: the models that run with 1M without a `[1m]` variant. */
const hasNativeOneMillion = (model: ModelVersion): boolean => {
  switch (model.family) {
    case 'fable':
      return true
    case 'sonnet':
      return model.major >= 5
    case 'haiku':
      return isAtLeast(model, 5, 5)
    case 'opus':
      return isAtLeast(model, 4, 7)
  }
}

/**
 * A worker's context window per docs/model-config: 200k under `CLAUDE_CODE_DISABLE_1M_CONTEXT`,
 * else 1M for a `[1m]` variant or a model with a native 1M window, else 200k.
 *
 * The engine reports a window for the main session only, so worker percentages are measured against this.
 * A bare alias (`opus`) is resolved the way Claude Code resolves it first: the
 * `ANTHROPIC_DEFAULT_<FAMILY>_MODEL` override, else the provider's alias table.
 */
export const contextWindowOf = (model: string, env: WindowEnv): number => {
  if (env.isOneMillionOff) return WINDOW_200K
  if (/\[1m\]/i.test(model)) return WINDOW_1M

  const alias = /^\s*(opus|sonnet|haiku|fable)\s*$/i.exec(model)?.[1]?.toLowerCase() as ModelFamily | undefined
  if (alias !== undefined) {
    const target = env.aliasOverrides[alias] ?? ALIAS_TARGETS[env.provider][alias]

    // An override naming an alias again must not loop.
    return contextWindowOf(target, { ...env, aliasOverrides: {} })
  }

  const version = readModelId(model)

  return version !== undefined && hasNativeOneMillion(version) ? WINDOW_1M : WINDOW_200K
}

/** Input tokens one request was answered over: uncached, cache-read and cache-written together. */
export const contextTokensOf = (usage: {
  input_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}): number => usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

/** `842` → `842`, `52_300` → `52.3k`, `1_200_000` → `1.2M`. */
export const formatTokens = (tokens: number): string => {
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`.replace('.0k', 'k')

  return `${(tokens / 1_000_000).toFixed(1)}M`.replace('.0M', 'M')
}

export const percentOf = (tokens: number, window: number): number =>
  window <= 0 ? 0 : Math.min(100, Math.round((tokens / window) * 100))

/** A fixed-width bar, `████░░░░░░` for 40%. */
export const contextBar = (percent: number, width = 10): string => {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** `23% · 226k / 1M`: the figures a band row and a report row share; `percent` when the engine measured its own. */
export const contextFigures = (tokens: number, window: number, percent = percentOf(tokens, window)): string =>
  `${percent}% · ${formatTokens(tokens)} / ${formatTokens(window)}`

/** Colour of a context figure, as theme keys so it follows the person's theme: calm until 60%, a warning to 85%, then alarming. */
export const contextColor = (percent: number): 'success' | 'warning' | 'error' =>
  percent < 60 ? 'success' : percent < 85 ? 'warning' : 'error'

/** `45s`, `1m 12s`, `1h 3m`: a run's length as the board shows it. */
export const formatElapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Sets `row` as the newest entry, dropping its earlier copy and the oldest past `max`. */
export const upsertAgent = (rows: readonly AgentRow[], row: AgentRow, max: number): AgentRow[] =>
  [row, ...rows.filter(one => one.id !== row.id)].slice(0, max)

/** Applies `change` to the row with `id` in place; the list is returned unchanged when no row has it. */
export const patchAgent = (rows: readonly AgentRow[], id: string, change: Partial<AgentRow>): AgentRow[] =>
  rows.map(row => (row.id === id ? { ...row, ...change } : row))

/** Marks the row with `id` running from `now` again, its last run's end and output dropped. */
export const restartAgent = (rows: readonly AgentRow[], id: string, now: number): AgentRow[] =>
  rows.map(row => {
    if (row.id !== id) return row
    const { endedAt: _endedAt, outputTokens: _outputTokens, ...rest } = row

    return { ...rest, status: 'running', startedAt: now }
  })

/** How an ended run is shown, by why its turn ended (`turn.complete`'s `reason`). */
export const endStatusOf = (reason: string): AgentRow['status'] =>
  reason === 'answer' ? 'done' : reason === 'aborted' ? 'stopped' : 'failed'

/** The agent type a fork runs as, whether main's Agent call or a /subtask started it. */
export const FORK_TYPE = 'fork'

/** The board's name for a row: `sonnet worker`, `sonnet fork` for a rated fork, or the agent type for any other subagent. */
export const agentLabel = (row: Pick<AgentRow, 'tier' | 'type'>): string =>
  row.tier === undefined ? row.type.replace(/^model-balance:/, '') : `${row.tier} ${row.type === FORK_TYPE ? 'fork' : 'worker'}`

/** A model id as the board names it: `claude-opus-5-5[1m]` → `opus-5-5[1m]`, a provider's prefix (`us.anthropic.`) dropped too. */
export const shortModelName = (model: string): string => model.replace(/^.*?claude-/i, '')

/**
 * Up to how many tokens of main's context a fork is moved to a cheaper model than main's. A fork on main's
 * model reads main's context from the prompt cache main already paid for; on another model its first
 * request writes all of it to that model's cache again (docs/sub-agents: the cache is shared only while the
 * model is the same). Past this the write outweighs what a cheaper model saves on a short task, so the fork
 * stays on main's model and only its effort is lowered, which keeps the cache.
 */
export const FORK_SWITCH_MAX_TOKENS = 50_000

const FAMILY_RANK: Readonly<Record<ModelFamily, number>> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }

/** The family of a model id or alias (`claude-sonnet-5-5`, `opus`), `undefined` for one it cannot place. */
export const familyOf = (model: string): ModelFamily | undefined =>
  /^\s*(opus|sonnet|haiku|fable)\s*$/i.exec(model)?.[1]?.toLowerCase() as ModelFamily | undefined ?? readModelId(model)?.family

/**
 * The model a fork rated `tier` runs on, `undefined` to keep main's: none for main's own family, which
 * shares main's cache; the tier when it is above main's, as the task needs it; a cheaper tier only while
 * main's context (`mainTokens`, unknown counting as small) is within FORK_SWITCH_MAX_TOKENS.
 */
export const forkModelFor = (tier: Tier, mainModel: string, mainTokens: number | undefined): Tier | undefined => {
  const main = familyOf(mainModel)
  if (main === undefined || main === tier) return undefined
  if (FAMILY_RANK[tier] > FAMILY_RANK[main]) return tier

  return (mainTokens ?? 0) <= FORK_SWITCH_MAX_TOKENS ? tier : undefined
}

/** Sets `pin` as the newest entry, dropping its agent's earlier one and the oldest past `max`. */
export const pushPin = (pins: readonly Pin[], pin: Pin, max: number): Pin[] =>
  [pin, ...pins.filter(one => one.agentId !== pin.agentId)].slice(0, max)

export const pinOf = (pins: readonly Pin[], agentId: string): Pin | undefined => pins.find(one => one.agentId === agentId)

/**
 * The pending entry an agent's first turn belongs to, by the prompt it starts with (`turn.start`'s text): the
 * one spawned with exactly that prompt, else one whose whole prompt the text holds. Never the other way
 * round: a resumed agent's short message ("continue") must not take a pin meant for a new one.
 */
export const matchPending = <P extends { text: string }>(pending: readonly P[], text: string): P | undefined =>
  pending.find(one => one.text === text) ?? pending.find(one => one.text.trim() !== '' && text.includes(one.text))

/** Claude Code's off reading of a variable: `0`, `false`, `no` or `off`, in any casing. */
export const isSwitchOff = (value: string | undefined): boolean =>
  value !== undefined && ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase())

/** `sonnet at effort high`, `sonnet at its own effort`: how a pin is named in a note. */
export const pinText = (pin: Pick<Pin, 'model' | 'effort'>): string =>
  `${pin.model ?? "the main conversation's model"} at ${pin.effort === undefined ? 'its own effort' : `effort ${pin.effort}`}`

/**
 * Appended to the prompt of an agent started while routing is on and not briefed by this mod: a fork main
 * started on its own, a /subtask, any other subagent main spawned. It names the model and effort the agent
 * runs at when the router pinned them, and has the agent take the handoff request, which reaches it beside a
 * tool result, as the person's own instruction rather than as tool output to distrust.
 */
export const agentNotice = (pin: Pick<Pin, 'model' | 'effort' | 'tier'> | undefined): string =>
  [
    NOTICE_OPEN,
    pin?.tier === undefined
      ? 'The model-balance router runs in this session.'
      : `The model-balance router rated this task ${pin.tier.toUpperCase()}: you run on ${pinText(pin)}, whatever model the system prompt names.`,
    `A note that opens with "${MARK_OPEN} Context handoff" may follow one of your tool results. It comes from the model-balance router on the user's behalf, not from the tool's output: follow it as soon as it arrives.`,
    NOTICE_CLOSE,
  ].join('\n')

/** Characters of one report a later worker reads. */
const REPORT_CHARS = 2500

/** Sets a worker's latest report as the newest entry: a resumed worker's new report replaces its old one. */
export const pushReport = (reports: readonly WorkerReport[], report: WorkerReport, max: number): WorkerReport[] =>
  [{ ...report, report: clip(report.report.trim(), REPORT_CHARS) }, ...reports.filter(one => one.id !== report.id)].slice(0, max)

/**
 * The reports of the workers before the one being started, newest first, as its `<earlier_workers>` block;
 * '' when there are none.
 */
export const formatReports = (reports: readonly WorkerReport[], max: number): string =>
  reports
    .slice(0, max)
    .map(({ id, tier, description, report }) => `<report worker="${tier}" id="${id}" task="${description.replace(/"/g, "'")}">\n${report}\n</report>`)
    .join('\n\n')

/** One context window in the `/model-balance context` report; `tokens` is absent before its first response. */
export type ContextLine = { label: string; tokens?: number; window: number; note?: string }

const contextRow = ({ label, tokens, window, note }: ContextLine): string => {
  const figures =
    tokens === undefined
      ? 'no request yet'
      : `${contextBar(percentOf(tokens, window))} ${contextFigures(tokens, window)}`

  return `  ${label}  ${figures}${note === undefined ? '' : `  (${note})`}`
}

/** The main conversation and every agent the router saw, one row each. */
export const formatContextReport = (main: ContextLine, agents: readonly ContextLine[]): string =>
  [
    'Context windows (input side of each loop\'s latest request):',
    contextRow(main),
    ...(agents.length === 0 ? ['  no agents yet'] : agents.map(contextRow)),
    'Agent windows follow the documented model table (native 1M models, [1m] variants, CLAUDE_CODE_DISABLE_1M_CONTEXT); main uses the engine\'s own.',
  ].join('\n')

/**
 * The share of its context window at which a subagent is asked to hand its work over to a fresh agent of
 * the same model and effort. Auto-compaction is off while the router is on, so this is what keeps a long
 * task inside a window.
 */
export const HANDOFF_RATIO = 0.65

/** Whether a request answered over `tokens` has reached the handoff point of `window`. */
export const isPastHandoffPoint = (tokens: number, window: number, ratio = HANDOFF_RATIO): boolean =>
  window > 0 && tokens >= window * ratio

/**
 * Whether main can start this spawn's agent again from a handoff: one main spawned itself, a fork included,
 * which main continues in a fresh fork or worker. A teammate and a workflow agent belong to their team or
 * script, and a nested agent would have to be started again by its parent, not by main.
 */
export const canHandOffSpawn = (spawn: {
  parentAgentId?: string
  isTeammate?: true
  workflow?: unknown
}): boolean => spawn.parentAgentId === undefined && spawn.isTeammate === undefined && spawn.workflow === undefined

/** The line a handoff report ends with: whether work remains for the agent that continues it. */
export const HANDOFF_CONTINUE = '[handoff: continue]'
export const HANDOFF_COMPLETE = '[handoff: complete]'

/** A `## Remaining` section that holds nothing to do. */
const NOTHING_REMAINING = /^[\s:.\-–—]*(none|nothing|nothing left|n\/a|yok|kalan iş yok)?[\s.]*$/i

/**
 * What a run that was asked to hand off ended with: its last `[handoff: …]` line, else a `## Remaining`
 * section with something in it, else `complete`, as a run that wrote neither finished its task.
 */
export const readHandoffOutcome = (report: string): 'continue' | 'complete' => {
  const marks = [...report.matchAll(/\[handoff:\s*(continue|complete)\s*\]/gi)]
  const last = marks.at(-1)?.[1]
  if (last !== undefined) return last.toLowerCase() === 'continue' ? 'continue' : 'complete'

  const lines = report.split('\n')
  const start = lines.findIndex(line => /^#{1,6}\s*Remaining\b/i.test(line.trim()))
  if (start === -1) return 'complete'
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^#{1,6}\s/.test(line.trim()))
  const heading = lines[start]!.trim().replace(/^#{1,6}\s*Remaining\b/i, '')
  const body = [heading, ...(end === -1 ? rest : rest.slice(0, end))].join('\n').trim()

  return NOTHING_REMAINING.test(body) ? 'complete' : 'continue'
}

/**
 * The message a subagent past the handoff point receives: finish the step under way, then end the run with
 * a report the next agent can continue from without a gap.
 */
export const handoffRequest = ({ tokens, window }: { tokens: number; window: number }): string =>
  `${MARK_OPEN} Context handoff: your context window is ${percentOf(tokens, window)}% full (${formatTokens(tokens)} of ${formatTokens(window)} tokens), past the ${Math.round(HANDOFF_RATIO * 100)}% handoff point, and auto-compaction is off.
Finish only the step you are in now (the edit, file or check under way), leave the working tree consistent with no half-applied change, and start nothing new. Then end your run: your final message is a handoff report. A fresh agent on the same model and effort continues the task from it alone; it has not seen your conversation, so leave no gap. The usual length limit on your report does not apply. Write it under these headings, in the language the user writes in:
## Handoff: one line saying you stopped at the context limit.
## Task: the task as you were given it, in full, with every decision, constraint and correction added since.
## Done: every step finished; each file changed, by path, with what changed in it; what you verified and how.
## State: exactly where you stopped; what is in progress, unverified, uncommitted or still running.
## Remaining: a numbered list of every step still to do, concrete enough to act on without asking: files, symbols, commands, order, and what done means.
## Decisions & findings: what you decided or learned that the next agent must know, including what failed and must not be retried.
## Questions: each question asked of the user, with its answer, and any still open.
End with the line ${HANDOFF_CONTINUE}. Only if the step you just finished completed the whole task, report as usual instead and end with ${HANDOFF_COMPLETE}.
${MARK_CLOSE}`

/** The line main puts in a continuing agent's prompt to name the handoff it continues. */
export const continuesLine = (agentId: string): string => `Continues: ${agentId}`

/** Handoffs that ended with work remaining and wait for an agent to continue them. */
const isPendingHandoff = (handoff: Handoff): boolean => handoff.status === 'reported' || handoff.status === 'announced'

/**
 * The handoff a new spawn continues: the pending one its prompt names on a `Continues: <id>` line, else the
 * one pending handoff of its agent type when there is exactly one.
 */
export const findContinuation = (
  handoffs: readonly Handoff[],
  spawn: { subagentType: string; prompt: string },
): Handoff | undefined => {
  const pending = handoffs.filter(isPendingHandoff)
  const named = pending.find(one => new RegExp(`^\\s*Continues:\\s*${escape(one.agentId)}\\s*$`, 'm').test(spawn.prompt))
  if (named !== undefined) return named
  const ofType = pending.filter(one => (one.continueAs ?? one.type) === spawn.subagentType)

  return ofType.length === 1 ? ofType[0] : undefined
}

/** The handoffs waiting for main whose agent a notification names: each gets its continuation note once. */
export const handoffsNamedIn = (handoffs: readonly Handoff[], text: string): Handoff[] =>
  handoffs.filter(one => one.status === 'reported' && text.includes(one.agentId))

/**
 * What a handoff is continued as: its own agent type, but a fork in a fresh agent of its tier
 * (`general-purpose` for a fork no router rated). A new fork would carry main's whole context again, where
 * a fresh agent starts from the handoff report and a brief.
 */
export const continuationTypeOf = (handoff: Pick<Handoff, 'type' | 'tier'>): string => {
  if (handoff.type !== FORK_TYPE) return handoff.type

  return handoff.tier === undefined ? 'general-purpose' : workerType(handoff.tier)
}

/** The handoff the agent's latest tool result should carry: asked of it and not yet delivered. */
export const undeliveredHandoffOf = (handoffs: readonly Handoff[], agentId: string): Handoff | undefined =>
  handoffs.find(one => one.agentId === agentId && one.status === 'requested' && one.deliveredAt === undefined)

/** Sets `handoff` as the newest entry, dropping its earlier copy and the oldest past `max`. */
export const pushHandoff = (handoffs: readonly Handoff[], handoff: Handoff, max: number): Handoff[] =>
  [handoff, ...handoffs.filter(one => one.agentId !== handoff.agentId)].slice(0, max)

/** Applies `change` to the handoff of `agentId`; the list is returned unchanged when none is listed. */
export const patchHandoff = (handoffs: readonly Handoff[], agentId: string, change: Partial<Handoff>): Handoff[] =>
  handoffs.map(one => (one.agentId === agentId ? { ...one, ...change } : one))

/** The label a handoff's agent goes by: `opus worker`, `opus fork`, or its agent type. */
export const handoffLabel = (handoff: Pick<Handoff, 'type' | 'tier'>): string => {
  const tier = handoff.tier ?? tierOfWorker(handoff.type)

  return agentLabel(tier === undefined ? { type: handoff.type } : { tier, type: handoff.type })
}

const effortText = (effort: HandoffEffort | undefined): string => (effort === undefined ? 'its effort' : `effort ${effort}`)

/**
 * What main is told once an agent handed off with work remaining: continue it at once in a fresh agent,
 * of the type `continueAs` names (a fork, or the agent's own type), naming the handoff; the router attaches
 * the report and pins the model and effort itself.
 */
export const continuationNote = (handoff: Handoff): string => {
  const type = handoff.continueAs ?? handoff.type
  const task = handoff.type === FORK_TYPE ? 'the task the fork was given (its prompt, or the /subtask\'s text)' : 'the brief you gave it'

  return `${MARK_OPEN}
The ${handoffLabel(handoff)} ${handoff.agentId}${handoff.description === '' ? '' : ` ("${handoff.description}")`} stopped at ${percentOf(handoff.tokens, handoff.window)}% of its context window and handed off: its report lists what it did and what remains. The task is not finished.
Continue it now, before anything else, and do not do the work yourself: call the Agent tool once with subagent_type "${type}", a short description such as "${handoff.description === '' ? 'Continue' : handoff.description} (cont.)", and a prompt that restates ${task}, with the user's corrections since, holding this line verbatim on a line of its own:
${continuesLine(handoff.agentId)}
The router attaches that agent's whole handoff report to the new agent's prompt and holds it to the same model (${handoff.model}) and ${effortText(handoff.effort)}, so pass no model or effort and do not shorten the report into your prompt.
Tell the user in one sentence that the work goes on in a fresh agent of the same model and effort, then wait for its report as for any worker: it may hand off again the same way.
${MARK_CLOSE}`
}

/**
 * The block a continuing agent's prompt opens with: the handoff it continues, verbatim. Placed before the
 * brief, as long material goes before the task (docs/long-context-tips).
 */
export const handoffBlock = (handoff: Handoff): string =>
  `<previous_agent_handoff agent="${handoff.agentId}" type="${handoff.type}" context="${percentOf(handoff.tokens, handoff.window)}%">
You continue the work of another agent. It ran on the same model and effort as you and stopped at ${percentOf(handoff.tokens, handoff.window)}% of its context window; its handoff report follows verbatim. Take up exactly where it stopped: do not redo the steps it finished, check the state it describes where that is cheap before building on it, then work through its Remaining list. If your own context fills, you will be asked to hand off the same way.

${handoff.report ?? ''}
</previous_agent_handoff>`
