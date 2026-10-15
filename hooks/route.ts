import type { SessionMessage } from 'claude-code'

export type Tier = 'haiku' | 'sonnet' | 'opus'

export const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus']

export const MARK_OPEN = '[model-balance]'
export const MARK_CLOSE = '[/model-balance]'

/** Shorter prompts are follow-ups ("devam", "ok", "evet") the main model answers itself. */
const MIN_ROUTED_LENGTH = 16

const EXCERPT_MESSAGES = 20
const EXCERPT_MESSAGE_CHARS = 1500
const EXCERPT_TOTAL_CHARS = 24000

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
 * Reads a leading `#haiku`, `#sonnet`, `#opus` or `#main` the person typed to
 * override the router, and the prompt without it.
 */
export const readOverride = (
  text: string,
): { override?: Tier | 'main'; rest: string } => {
  const found = /^\s*#(haiku|sonnet|opus|main)\b\s*/i.exec(text)
  if (found === null) return { rest: text }

  return {
    override: found[1]!.toLowerCase() as Tier | 'main',
    rest: text.slice(found[0].length),
  }
}

/** `$.store` key of the on/off a new session starts with; the toggle was global under this key before it became per session. */
export const DEFAULT_TOGGLE_KEY = 'enabled'

/**
 * The on/off a new session starts with, read from `$.store`: off until `/model-balance default on`
 * has been run on this machine, so a fresh install routes nothing until the person asks it to.
 */
export const readDefaultToggle = (value: unknown): boolean => value === true

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
  | { scope: 'default'; enabled: boolean }
  | { scope: 'context' }
  | { scope: 'status'; isUnknown: boolean }

/** Reads `/model-balance` arguments: `on|off` for this session, `default on|off` for new sessions, `context` for every context window, anything else shows the status. */
export const readToggleCommand = (args: string): ToggleCommand => {
  const words = args.trim().toLowerCase().split(/\s+/).filter(word => word !== '')
  const [first, second] = words
  if (words.length === 1 && first === 'context') return { scope: 'context' }
  const isSwitch = (word: string | undefined): word is 'on' | 'off' => word === 'on' || word === 'off'

  if (words.length === 1 && isSwitch(first)) return { scope: 'session', enabled: first === 'on' }
  if (words.length === 2 && first === 'default' && isSwitch(second)) return { scope: 'default', enabled: second === 'on' }

  return { scope: 'status', isUnknown: words.length > 0 && !(words.length === 1 && first === 'status') }
}

export const isWorthRouting = (text: string): boolean =>
  text.trim().length >= MIN_ROUTED_LENGTH && !text.trimStart().startsWith('/')

/** Takes the first HAIKU / SONNET / OPUS word of the classifier's reply. */
export const parseVerdict = (reply: string): Tier | undefined => {
  const found = /\b(haiku|sonnet|opus)\b/i.exec(reply)

  return found === null ? undefined : (found[1]!.toLowerCase() as Tier)
}

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

/** Drops this mod's own routing note from a message so a worker never reads it. */
export const stripRoutingNote = (text: string): string =>
  text
    .replace(
      new RegExp(`${escape(MARK_OPEN)}[\\s\\S]*?${escape(MARK_CLOSE)}`, 'g'),
      '',
    )
    .trim()

const escape = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)} …[${text.length - max} chars cut]`

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
      `${message.role.toUpperCase()}: ${clip(text, EXCERPT_MESSAGE_CHARS)}`,
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

/** Colour of a context figure: calm until 60%, a warning to 85%, then alarming. */
export const contextColor = (percent: number): 'green' | 'yellow' | 'red' =>
  percent < 60 ? 'green' : percent < 85 ? 'yellow' : 'red'

/** The latest `max` worker runs, newest first. */
export const pushRun = <T>(runs: readonly T[], run: T, max: number): T[] => [run, ...runs].slice(0, max)

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
