import { atom, read, update } from 'claude-code'
import type { AgentSpawnInput, AgentSpawnResult, ElementTable, EngineInterface, ModelEffort, Register, RenderElement } from 'claude-code'

import {
  ASK_TOOL,
  ASK_TOOL_SCHEMA,
  FORK_TYPE,
  HANDOFF_CONTINUE,
  HANDOFF_RATIO,
  LEGACY_DEFAULT_KEY,
  MARK_CLOSE,
  MARK_OPEN,
  TIERS,
  agentLabel,
  agentNotice,
  canHandOffSpawn,
  continuationNote,
  continuationTypeOf,
  forkModelFor,
  continuesLine,
  contextBar,
  contextColor,
  contextFigures,
  contextTokensOf,
  clipMemoryIndex,
  contextWindowOf,
  directoryOf,
  endStatusOf,
  excerptOf,
  findContinuation,
  formatAnswers,
  formatContextReport,
  formatElapsed,
  formatReports,
  formatTokens,
  guessTier,
  handoffBlock,
  handoffLabel,
  handoffRequest,
  handoffsNamedIn,
  isActiveStatus,
  isContinuationReply,
  isInside,
  isPastHandoffPoint,
  isRoutedTurn,
  isStaleSessionToggle,
  isSwitchOn,
  isWorthRouting,
  matchPending,
  memoryIndexPathOf,
  parseEffort,
  parseVerdict,
  patchAgent,
  patchHandoff,
  percentOf,
  pickLastWorker,
  pinOf,
  pinText,
  pushHandoff,
  pushPin,
  pushReport,
  readAnswers,
  readHandoffOutcome,
  readOverride,
  readQuestions,
  readRouterEffort,
  readRouterModel,
  readSavedToggle,
  readToggleCommand,
  readWorkerEffort,
  restartAgent,
  routerChain,
  sessionToggleKey,
  shortModelName,
  subagentEffortOf,
  tierOfWorker,
  undeliveredHandoffOf,
  upsertAgent,
  workerType,
  type ContextLine,
  type Provider,
  type Route,
  type RouterEffort,
  type RouterModel,
  type SavedToggle,
  type SubagentEffort,
  type Tier,
  type WindowEnv,
  type WorkerCandidate,
  type WorkerEffort,
} from './route'
import type { AgentRow, Handoff, MainContext, Pin, SessionToggle } from '../types'

const ASK_TOOL_NAME = `mcp__model-balance__${ASK_TOOL}` as const

declare module 'claude-code' {
  interface McpToolInputs {
    /** Loose on purpose: `readQuestions` checks what the worker actually sent. */
    'mcp__model-balance__ask_user': { questions: unknown }
  }
}

/** `by` names who decided: `override`, `<model> router` or `heuristic`; `effort` is absent when none was named. */
type Verdict = { route: Route; effort?: SubagentEffort; by: string; isContinuation: boolean }

/** The model that rates prompts and the effort it rates at. */
type Router = { model: RouterModel; effort: RouterEffort }

/** What an agent runs at, before its id is known: a pin without `agentId` and `at`. */
type PinSpec = Omit<Pin, 'agentId' | 'at'>

/** The worker a routing note asked main for: its spawn is pinned to `tier`'s model and the router's `effort`. */
type RoutedSpawn = { tier: Tier; effort?: SubagentEffort; by: string }

/** A pin waiting for its agent's first turn, which names the agent by the prompt it starts with. */
type PendingPin = { text: string; pin: PinSpec; at: number }

/** The latest top-level worker as the router reads it for a follow-up. */
type LastWorker = { id: string; tier: Tier; description: string; task: string; isActive: boolean }

/** Prompts a person sent; notifications, peers, schedules and other plugins pass untouched. */
const ROUTED_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

/** Main's tools that change files; refused to main on a routed turn so the worker does the editing. */
const MAIN_WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const

/** How much of the last worker's task the classifier reads to judge a follow-up. */
const LAST_TASK_CHARS = 1500

/** How much of the conversation the router reads beside the request: the latest messages, their newest characters. */
const ROUTER_MESSAGES = 6
const ROUTER_CHARS = 4000

/**
 * Below this many tokens of main's context, a change main finishes in one or two tool calls stays in main.
 * Handing a task over costs main two requests over its whole context (the brief, then the report) plus the
 * worker's own run, about as much as main reading 150k tokens from its cache (measured 2026-10-29: a small
 * Sonnet worker run cost what an Opus main request over ~150k cached tokens costs). Past it, the worker's
 * run is the cheaper part.
 */
const SMALL_TASK_MAIN_TOKENS = 150_000

const LEVELS = `HAIKU: small, well-specified work: lookups, explaining a known thing, renames, typos, formatting, small single-file edits, translations.
SONNET: everyday engineering: features, bug fixes with a clear lead, tests, multi-file edits that follow existing patterns, code review, checking a change in the browser.
OPUS: architecture and design decisions, unclear root causes, cross-cutting refactors or migrations, matching an old system's behaviour exactly, concurrency, security, performance, long multi-step plans.`

const EFFORTS = `Then pick how hard that model thinks:
LOW: mechanical work whose answer is plain: a lookup, a rename, a typo, formatting.
MEDIUM: routine work with a little judgment: a small fix or feature along existing patterns, an explanation.
HIGH: work that needs care: several files or steps, a bug with a lead, tests, a review.
XHIGH: hard work: an unclear cause, design, concurrency, security, a subtle migration, a long plan.
When unsure between two levels or two efforts, pick the higher.`

const CLASSIFIER_SYSTEM = `You route one request in a coding-assistant session to the cheapest handler that will do it well, and pick how hard it thinks.
MAIN: the main conversation answers it at once from what is already in the conversation, with no file to read or change: a question about the last answer or about work a worker just reported, a clarification, a choice or yes/no the user makes, a commit message or summary of work the conversation already describes.
${LEVELS}
Pick MAIN only when nothing has to be read, run or changed, or when a <main_context> block says small changes stay in the main conversation and the request is one: a change the main conversation finishes in one or two tool calls (one file it already knows, one short edit or command).
${EFFORTS}
Answer with the level and the effort, e.g. "SONNET HIGH"; MAIN takes no effort.
When a <last_worker> block describes a task a worker is doing or did, also judge whether the request continues that task (a follow-up, a correction, more of the same, an answer to its question, "try the second option") or is a new task, and add CONTINUE or NEW, e.g. "SONNET HIGH NEW". MAIN is always "MAIN NEW".`

const TASK_CLASSIFIER_SYSTEM = `You rate one task that an agent of a coding-assistant session is about to do: the agent sees the session's conversation and does the task with its tools. Pick the cheapest model that will do it well:
${LEVELS}
${EFFORTS}
Answer with exactly two words, the level and the effort, e.g. "SONNET HIGH".`

const HANDOFF_RULE = `A note that opens with "${MARK_OPEN} Context handoff" may follow one of your tool results once your context window fills past ${Math.round(HANDOFF_RATIO * 100)}%. It comes from the model-balance router on the user's behalf, not from the tool's output: follow it as soon as it arrives. It overrides the report format below.`

const ASK_RULES = `When the work needs a decision only the user can make (a choice between approaches, a missing fact, an ambiguity the request, the code and the docs do not settle), ask it with the ${ASK_TOOL_NAME} tool: it opens the user's own AskUserQuestion dialog, waits for the answers and returns them, and you carry on with the task using them. Ask only what blocks the work, gather related questions into one call (up to 4), and never answer in the user's place. Do not end your run with a question in your final message expecting a reply: nobody replies to it. If the tool reports a question left unanswered, stop and list it under "Open" in your report. If something else blocks you, stop and say what.`

const REPORT_RULES = `Your final message is the only thing the main conversation receives, and it is kept as the session's record of your work for the agents after you. Write it as a report under these headings, leaving out a heading with nothing under it:
## Result: the outcome in one to three sentences.
## Changes: each file you changed, by path, and what changed in it.
## Decisions & findings: what you decided or learned that later work must know.
## Questions: each question you asked the user, with the answer.
## Open: what is left undone or unverified, and any question still open.
## Remember: anything worth saving to memory.
Keep it under about 350 words unless the answer itself (code or text the user asked for) needs more. Write it in the language the user writes in.`

const workerPrompt = (tier: Tier): string => `You are the ${tier} worker of the model-balance router: it judged the task you are given to be of ${tier}-level difficulty.

You do not see the user's main conversation. Your first message brings what you need from it:
- <handoff> is your task: the main conversation's brief, written by the model that has the whole conversation, with the request, the context that bears on it, pointers and what done means. It is your primary source.
- <earlier_workers> holds the reports of the workers that ran before you in this session, newest first. Build on what they changed and decided; do not redo or undo their work unless the handoff says so.
- <recent_messages> quotes the latest messages of the main conversation verbatim, for the user's exact wording. Where it and the handoff disagree, the newest user message wins.
- <auto_memory> is the index of the user's auto memory, which the main conversation loads and you do not: one line per memory file in the directory it names.
- <previous_agent_handoff>, when present, is the handoff report of an agent whose context filled before it finished this same task. You continue its work: start where it stopped, not over.
A later message from the main conversation continues the same task (a follow-up, a correction, answers) and says what changed since your last report.
${HANDOFF_RULE}

Before you start, open with Read the memory files whose line touches your task, every feedback_ one among them, and follow them as the main conversation would. Leave writing memory to the main conversation.

Do the task completely with the tools you have, following the project's instructions.

${ASK_RULES}

${REPORT_RULES}`

const NO_EDITS = 'Edit, Write and NotebookEdit are refused to you on this turn, outside the auto-memory directory.'

const workerFollowUp = `The agent asks the user its own questions through a dialog while it runs. If its report still ends with open questions for the user, do not answer them yourself and do not stop there: ask them with AskUserQuestion, then continue that same agent with SendMessage (its agent id or name; load SendMessage through ToolSearch if it is deferred), passing the answers verbatim, and wait for its new report.
When the agent returns, answer the user from its report: relay its result, its changes and what is left open, faithfully and briefly. The report is the record: do not re-run its checks, re-read the files it changed or redo any of its work yourself, as every request of yours re-reads this whole conversation. What it left unverified or failed goes back to it with SendMessage, or to the user as open.
A report that ends with ${HANDOFF_CONTINUE} is a handoff, not a result: its agent stopped because its context filled, and the task goes on. Follow the routing note that comes with it; without one, call the Agent tool at once with the same subagent_type and a prompt that restates your brief and holds the line "${continuesLine('<its agent id>')}", and pass no model or effort: the router attaches the report and keeps the model and effort.`

const workerLabel = ({ id, tier, description }: LastWorker): string =>
  `${tier} worker ${id}${description === '' ? '' : ` ("${description}")`}`

const routedPin = ({ tier, effort }: RoutedSpawn): PinSpec => ({ tier, model: tier, ...(effort === undefined ? {} : { effort }) })

const ratedText = (spawn: RoutedSpawn): string =>
  `${spawn.tier.toUpperCase()}${spawn.effort === undefined ? '' : ` at effort ${spawn.effort.toUpperCase()}`} (${spawn.by})`

const spawnNote = (spawn: RoutedSpawn): string => `${MARK_OPEN}
The model-balance router rated this request ${ratedText(spawn)}.
Do not do the work yourself and do not read files first. ${NO_EDITS} Call the Agent tool once with subagent_type "${workerType(spawn.tier)}", a short description, and a prompt that briefs a colleague who has not seen this conversation, under these headings:
## Request: the user's request in full, in their own words where the wording matters.
## Context: what this conversation has settled that bears on it: decisions, constraints, the user's preferences and corrections, what was tried and failed, earlier results it builds on.
## Pointers: files, routes, symbols, commands or URLs already known.
## Done when: what the user will check.
Write it from the whole conversation, a summary of earlier parts included, and leave out what does not bear on the task. The router adds the earlier workers' reports, the latest messages verbatim and the memory index itself, so do not paste those. Pass no model or effort: the router runs the worker on ${pinText(routedPin(spawn))}.
${workerFollowUp} Only if the worker failed or the report shows the task is clearly not ${spawn.tier}-level may you retry once with another model-balance worker type.
${MARK_CLOSE}`

const continueNote = (worker: LastWorker, by: string): string => `${MARK_OPEN}
The model-balance router judged this request a continuation of the task the ${workerLabel(worker)} ${worker.isActive ? 'is doing' : 'did'} (${by}).
Do not do the work yourself and do not spawn a new worker. ${NO_EDITS} Send the request to that worker with SendMessage (to: "${worker.id}"; load SendMessage through ToolSearch if it is deferred): the user's words, with every detail it needs, and what changed in this conversation since its last report (decisions, answers, other work done). ${worker.isActive ? 'It is still running and takes the message as a course correction.' : 'It resumes with its full history, on the same model and effort.'}
${workerFollowUp}
${MARK_CLOSE}`

const waitNote = (worker: LastWorker): string => `${MARK_OPEN}
The ${workerLabel(worker)} is still running, and the model-balance router judged this request a new task. Two workers must not edit the same working tree at once.
Do not do the work yourself and do not spawn a worker: the spawn is refused. ${NO_EDITS} Tell the user in one or two sentences that this request waits until that worker finishes: they can send it again then, or prefix it with #main to have the main conversation do it now.
${MARK_CLOSE}`

const toggleRef = { plugin: 'model-balance', key: 'toggle' } as const

const mainContextAtom = atom({ plugin: 'model-balance', key: 'mainContext' } as const, null)
const agentsAtom = atom({ plugin: 'model-balance', key: 'agents' } as const, [])
const pinsAtom = atom({ plugin: 'model-balance', key: 'pins' } as const, [])
const reportsAtom = atom({ plugin: 'model-balance', key: 'reports' } as const, [])
const handoffsAtom = atom({ plugin: 'model-balance', key: 'handoffs' } as const, [])
const historyOpenAtom = atom({ plugin: 'model-balance', key: 'isHistoryOpen' } as const, false)
const paneDismissedAtom = atom({ plugin: 'model-balance', key: 'isPaneDismissed' } as const, false)

/** The board's pane: the band's rows where no band is drawn (VS Code), or wherever the person opens it. */
const PANE = 'model-balance'

/** Subagent runs the board keeps, newest first. */
const BOARD_AGENTS = 12

/** Finished runs listed once the person opens them. */
const BOARD_FINISHED_SHOWN = 6

/** Worker reports kept for later workers, and how many of them a new worker reads. */
const REPORTS_KEPT = 8
const REPORTS_IN_PROMPT = 4

/** Handoffs kept, newest first: enough for every subagent the board holds. */
const HANDOFFS_KEPT = 12

/** Pins kept, newest first: twice the board, as a resumed agent outlives its row. */
const PINS_KEPT = 24

/** Pins waiting for their agent's first turn: a spawn the engine refused leaves one, dropped past this age or count. */
const PENDING_KEPT = 8
const PENDING_MS = 5 * 60 * 1000

/**
 * Why an automatic compaction is skipped. docs/settings-reference → autoCompactEnabled: with auto-compaction
 * off the manual /compact keeps working and idle compaction is off too. Of the compaction triggers, `auto`
 * and `precompute` are the engine's own and `manual` and `plugin` a person's or a plugin's call, so skipping
 * the first two mirrors that setting for this session alone, leaving the person's settings as they are.
 */
const AUTO_COMPACT_SKIP =
  'model-balance is on, so auto-compaction is off in this session: run /compact yourself, or /model-balance off to have it compact on its own again.'

/** Wide enough for `model-balance · main`, so terminal rows line their figures up in one column. */
const TERMINAL_LABEL_WIDTH = 22

const STATUS_MARK: Readonly<Record<AgentRow['status'], { glyph: string; color: string }>> = {
  running: { glyph: '▶', color: 'claude' },
  done: { glyph: '✓', color: 'success' },
  failed: { glyph: '✗', color: 'error' },
  stopped: { glyph: '■', color: 'warning' },
}

/** The engine heads the status line and every toast with the plugin's name, so these texts leave it out. */
const statusText = (isOn: boolean): string => (isOn ? 'on' : 'off')

const providerOf = async ($: EngineInterface): Promise<Provider> => {
  if (isSwitchOn(await $.env.get('CLAUDE_CODE_USE_BEDROCK')) || isSwitchOn(await $.env.get('CLAUDE_CODE_USE_MANTLE'))) {
    return 'bedrock'
  }
  if (isSwitchOn(await $.env.get('CLAUDE_CODE_USE_VERTEX'))) return 'vertex'
  if (isSwitchOn(await $.env.get('CLAUDE_CODE_USE_FOUNDRY'))) return 'foundry'
  if (isSwitchOn(await $.env.get('CLAUDE_CODE_USE_ANTHROPIC_AWS'))) return 'anthropic-aws'

  return 'anthropic'
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value.trim()

/** Read at each measurement, not once: settings' `env` block can change these mid-session. */
const readWindowEnv = async ($: EngineInterface): Promise<WindowEnv> => ({
  provider: await providerOf($),
  isOneMillionOff: isSwitchOn(await $.env.get('CLAUDE_CODE_DISABLE_1M_CONTEXT')),
  aliasOverrides: {
    opus: nonEmpty(await $.env.get('ANTHROPIC_DEFAULT_OPUS_MODEL')),
    sonnet: nonEmpty(await $.env.get('ANTHROPIC_DEFAULT_SONNET_MODEL')),
    haiku: nonEmpty(await $.env.get('ANTHROPIC_DEFAULT_HAIKU_MODEL')),
    fable: nonEmpty(await $.env.get('ANTHROPIC_DEFAULT_FABLE_MODEL')),
  },
})

/**
 * What a fork rated `tier` runs at: the tier's model only where forkModelFor finds the switch pays for the
 * cache write it costs, else main's model, whose cache the fork shares; and the rated effort either way,
 * which keeps that cache (measured: a fork of main at another effort reads main's whole prefix from it).
 */
const forkPinOf = async ($: EngineInterface, tier: Tier, effort: SubagentEffort | undefined): Promise<PinSpec> => {
  const model = forkModelFor(tier, await $.session.model(), (await read($, mainContextAtom))?.tokens)

  return { tier, ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) }
}

/** Sets `key` as the newest entry and drops the oldest past `max`. */
const rememberLatest = <V,>(entries: Map<string, V>, key: string, value: V, max: number): void => {
  entries.delete(key)
  entries.set(key, value)
  if (entries.size > max) entries.delete(entries.keys().next().value!)
}

/** Holds `pin` for the agent whose first turn starts with `text`, dropping entries too old or too many to be waited for. */
const addPending = (pending: PendingPin[], text: string, pin: PinSpec, now: number): void => {
  pending.unshift({ text, pin, at: now })
  for (let index = pending.length - 1; index >= 0; index--) {
    if (index >= PENDING_KEPT || now - pending[index]!.at > PENDING_MS) pending.splice(index, 1)
  }
}

/** The pending pin of the agent whose first turn starts with `text`, taken off the list. */
const takePending = (pending: PendingPin[], text: string): PinSpec | undefined => {
  const found = matchPending(pending, text)
  if (found === undefined) return undefined
  pending.splice(pending.indexOf(found), 1)

  return found.pin
}

/**
 * Whether routing is on for this session: its own `/model-balance on|off`, else off. A session that is
 * resumed finds its own last choice again; a new one, `/clear` included, always starts off, and no
 * session's choice reaches another.
 *
 * `$.state` holds the live answer and no other session writes it. `$.store` is one file every
 * session and worktree shares; each choice is keyed by its session id, so it only carries that
 * session's own choice across a resume.
 */
const isEnabled = async ($: EngineInterface): Promise<boolean> => {
  const sessionId = await $.session.id()
  const { value: held } = await $.state.get(toggleRef)
  if (held?.sessionId === sessionId) return held.enabled

  // Reached at start, and on a new session id the classic SessionStart hook did not adopt first.
  return adoptSession($, sessionId)
}

/** Takes `sessionId`'s own saved choice, off when it has none, as the live answer and the status line. */
const adoptSession = async ($: EngineInterface, sessionId: string): Promise<boolean> => {
  const enabled = readSavedToggle(await $.store.get(sessionToggleKey(sessionId)))?.enabled ?? false
  const toggle: SessionToggle = { sessionId, enabled }
  await $.state.set(toggleRef, toggle)
  $.ui.status(statusText(enabled))

  return enabled
}

const setEnabled = async ($: EngineInterface, enabled: boolean): Promise<void> => {
  const sessionId = await $.session.id()
  await $.state.set(toggleRef, { sessionId, enabled })
  const saved: SavedToggle = { enabled, at: await $.clock.now() }
  await $.store.set(sessionToggleKey(sessionId), saved)
  $.ui.status(statusText(enabled))
}

/** Drops the per-session choices past their TTL, and the default for new sessions an earlier version kept. */
const pruneSavedToggles = async ($: EngineInterface): Promise<void> => {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (key === LEGACY_DEFAULT_KEY || isStaleSessionToggle(key, await $.store.get(key), now)) await $.store.delete(key)
  }
}

/** Main's row as a conversation starts: its context as measured now, on the session's model; its effort comes with its first request. */
const measureMain = async ($: EngineInterface): Promise<void> => {
  const { context } = await $.session.usage()
  const model = await $.session.model()
  await update($, mainContextAtom, () => ({ tokens: context.tokens, window: context.window, percent: context.percent, model }))
}

/**
 * Keeps main's row on the model and effort its latest request runs at. No op reads the session's effort, and
 * a /model or /effort change shows only in main's next request, so the row follows that. Written only on a
 * change, as each write redraws the board.
 */
const noteMainRequest = async ($: EngineInterface, model: string, effort: ModelEffort | number | undefined): Promise<void> => {
  const level = effort === undefined ? undefined : String(effort)
  const held = await read($, mainContextAtom)
  if (held !== null && held.model === model && held.effort === level) return

  await update($, mainContextAtom, main => {
    const { effort: _effort, ...rest } = main ?? { window: 0 }

    return { ...rest, model, ...(level === undefined ? {} : { effort: level }) }
  })
}

const lastWorkerBlock = (worker: LastWorker): string =>
  `<last_worker status="${worker.isActive ? 'running' : 'finished'}">\nDescription: ${worker.description}\nTask: ${worker.task.slice(0, LAST_TASK_CHARS)}\n</last_worker>\n\n`

/** The latest messages of main the router reads beside a request, '' before there are any. */
const recentForRouter = async ($: EngineInterface): Promise<string> => {
  const recent = excerptOf((await $.session.messages()).slice(-ROUTER_MESSAGES)).slice(-ROUTER_CHARS)

  return recent === '' ? '' : `Recent conversation:\n${recent}\n\n`
}

/**
 * Asks the configured router model, the other one standing in when it fails, is blocked or answers
 * nothing `parse` reads; `undefined` when neither gave a reading.
 */
async function askRouter<V>(
  $: EngineInterface,
  request: { system: string; prompt: string },
  router: Router,
  parse: (reply: string) => V | undefined,
): Promise<{ value: V; by: string } | undefined> {
  for (const model of routerChain(router.model)) {
    try {
      const reply = await $.model.complete({
        model,
        system: request.system,
        prompt: request.prompt,
        maxTokens: 16,
        effort: router.effort,
        timeoutMs: model === router.model ? 10_000 : 6000,
      })
      const value = reply.isAnswered ? parse(reply.text) : undefined
      if (value !== undefined) return { value, by: `${model} router` }
    } catch {
      // A model the allowlist blocks rejects instead of answering; the next router stands in.
    }
  }

  return undefined
}

/**
 * Rates the request with the router: where it goes, at which effort, and whether it continues the last
 * worker's task. Without a verdict the heuristic rates difficulty alone and never assumes a follow-up.
 */
async function classify($: EngineInterface, text: string, last: LastWorker | undefined, router: Router): Promise<Verdict> {
  const mainTokens = (await read($, mainContextAtom))?.tokens
  const small =
    mainTokens === undefined || mainTokens >= SMALL_TASK_MAIN_TOKENS
      ? ''
      : `<main_context tokens="${mainTokens}">Small changes stay in the main conversation: handing one over would cost more than doing it.</main_context>\n\n`
  const prompt = `${await recentForRouter($)}${small}${last === undefined ? '' : lastWorkerBlock(last)}Request to rate:\n${text.slice(0, 6000)}`
  const rated = await askRouter($, { system: CLASSIFIER_SYSTEM, prompt }, router, reply => {
    const route = parseVerdict(reply)
    if (route === undefined) return undefined
    const effort = route === 'main' ? undefined : parseEffort(reply)

    return {
      route,
      ...(effort === undefined ? {} : { effort }),
      isContinuation: route !== 'main' && last !== undefined && isContinuationReply(reply),
    }
  })

  return rated === undefined
    ? { route: guessTier(text), by: 'heuristic', isContinuation: false }
    : { ...rated.value, by: rated.by }
}

/** Rates a task an agent that sees the conversation is about to do (a fork, a /subtask): its tier and effort. */
async function rateTask($: EngineInterface, task: string, router: Router): Promise<{ tier: Tier; effort?: SubagentEffort; by: string }> {
  const prompt = `${await recentForRouter($)}Task to rate:\n${task.slice(0, 6000)}`
  const rated = await askRouter($, { system: TASK_CLASSIFIER_SYSTEM, prompt }, router, reply => {
    const route = parseVerdict(reply)
    if (route === undefined || route === 'main') return undefined
    const effort = parseEffort(reply)

    return { tier: route, ...(effort === undefined ? {} : { effort }) }
  })

  return rated === undefined ? { tier: guessTier(task), by: 'heuristic' } : { ...rated.value, by: rated.by }
}

/**
 * The auto-memory `MEMORY.md` as the engine loaded it for main, path and the part a session reads.
 * The path comes from the engine, not from the working directory: docs/memory derives it from the git
 * repository, so every worktree of one repo shares it, and `autoMemoryDirectory` can move it anywhere.
 */
const readMemoryIndex = async ($: EngineInterface): Promise<{ path: string; text: string } | undefined> => {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const path = memoryIndexPathOf(context.breakdown?.memoryFiles ?? [])
    if (path === undefined) return undefined

    return { path, text: clipMemoryIndex(await $.fs.read(path)) }
  } catch {
    // Auto memory off, or the file gone since the session loaded it: the worker goes without the index.
    return undefined
  }
}

/** `task` is the worker's handoff as spawned, '' when this module did not see the spawn (a reload since). */
const toLastWorker = (agent: WorkerCandidate, task: string | undefined): LastWorker | undefined => {
  const tier = tierOfWorker(agent.type)

  return tier === undefined
    ? undefined
    : { id: agent.id, tier, description: agent.description, task: task ?? '', isActive: isActiveStatus(agent.status) }
}

const isTopLevelWorker = (agent: WorkerCandidate): boolean =>
  tierOfWorker(agent.type) !== undefined && agent.parentId === undefined

/** Falls back to the agent list: a worker's first request can come before its spawn resolved. */
async function workerTier(
  $: EngineInterface,
  workers: Map<string, Tier>,
  agentId: string,
): Promise<Tier | undefined> {
  const known = workers.get(agentId)
  if (known !== undefined) return known

  const agent = (await $.agent.list()).find(one => one.id === agentId)
  const tier = agent === undefined ? undefined : tierOfWorker(agent.type)
  if (tier !== undefined) workers.set(agentId, tier)

  return tier
}

const savePin = async ($: EngineInterface, agentId: string, pin: PinSpec): Promise<void> => {
  const at = await $.clock.now()
  await update($, pinsAtom, pins => pushPin(pins, { ...pin, agentId, at }, PINS_KEPT))
}

/**
 * Puts a started subagent on the board under the model it is pinned to, else the one it started on; a
 * resumed one starts its clock again, keeping what its last run measured. Never fails the spawn.
 */
async function trackSpawn($: EngineInterface, e: AgentSpawnInput, started: AgentSpawnResult, pin: PinSpec | undefined): Promise<void> {
  const agentId = started.agentId
  if (agentId === undefined || started.deny !== undefined) return
  try {
    const now = await $.clock.now()
    const model = pin?.model ?? started.model
    const window = contextWindowOf(model, await readWindowEnv($))
    const tier = pin?.tier ?? tierOfWorker(e.subagentType)
    await update($, agentsAtom, rows => {
      const known = rows.find(row => row.id === agentId)
      const { endedAt: _endedAt, outputTokens: _outputTokens, ...kept } = known ?? {}
      const row: AgentRow = {
        ...kept,
        id: agentId,
        type: e.subagentType,
        ...(tier === undefined ? {} : { tier }),
        description: known?.description ?? e.description,
        status: 'running',
        startedAt: now,
        model,
        window,
        // A resumed agent that was asked to hand off keeps the mark (`kept`): it is not asked again.
        ...(canHandOffSpawn(e) ? { canHandOff: true } : {}),
      }

      return upsertAgent(rows, row, BOARD_AGENTS)
    })
  } catch {
    // The board misses this run; the spawn itself is unaffected.
  }
}

/**
 * Records that a subagent past the handoff point is to hand off, once, so a later step does not ask again.
 * The request itself reaches the agent beside its next tool result (the `tool.call` hook): a message would
 * go through SendMessage's permission check, which auto mode cannot pass for a plugin's own send.
 */
async function requestHandoff(
  $: EngineInterface,
  row: AgentRow,
  request: { tokens: number; window: number; model: string; effort: Handoff['effort'] },
): Promise<void> {
  const { tokens, window, model, effort } = request
  const record: Handoff = {
    agentId: row.id,
    type: row.type,
    ...(row.tier === undefined ? {} : { tier: row.tier }),
    description: row.description,
    model,
    ...(effort === undefined ? {} : { effort }),
    tokens,
    window,
    at: await $.clock.now(),
    status: 'requested',
  }
  await update($, handoffsAtom, list => pushHandoff(list, record, HANDOFFS_KEPT))
  await update($, agentsAtom, rows => patchAgent(rows, row.id, { handoffAt: percentOf(tokens, window) }))
}

/**
 * The continuation notes for the handoffs a notification or an Agent result names, each marked announced
 * so main is told once. A fork is continued in a fresh agent of its tier, not in a new fork that would
 * carry main's whole context again.
 */
async function announceHandoffs($: EngineInterface, text: string): Promise<string[]> {
  const named = handoffsNamedIn(await read($, handoffsAtom), text)
  if (named.length === 0) return []
  const announced = named.map(one => ({ ...one, status: 'announced' as const, continueAs: continuationTypeOf(one) }))
  await update($, handoffsAtom, list =>
    announced.reduce((acc, one) => patchHandoff(acc, one.agentId, { status: 'announced', continueAs: one.continueAs! }), list),
  )

  return announced.map(continuationNote)
}

/** Opens the board's pane in VS Code, which draws no band, unless the person closed it this session. */
const openPaneInEditor = async ($: EngineInterface): Promise<void> => {
  if (await read($, paneDismissedAtom)) return
  if (!(await $.session.surfaces()).includes('vscode')) return
  if ((await $.ui.panes()).some(pane => pane.id === PANE)) return

  // Unasked, a pane may wait for room (`isPlaced: false`); `/model-balance panel` opens it at any width.
  await $.ui.open({ id: PANE, title: 'model-balance' })
}

type BoardElements = Pick<ElementTable, 'Box' | 'Text' | 'Button'>

/**
 * The rows the band and the pane share: main's context, every running subagent, and the finished ones
 * behind one button. On the terminal labels are padded into one column and figures drawn without the bar;
 * other surfaces keep the bar.
 */
const drawBoard = (
  $: EngineInterface,
  { Box, Text, Button }: BoardElements,
  board: { main: MainContext | null; rows: readonly AgentRow[]; isHistoryOpen: boolean; now: number; isTerminal: boolean },
): RenderElement => {
  const { main, rows, isHistoryOpen, now, isTerminal } = board
  const label = (text: string, width: number): string => (isTerminal ? text.slice(0, width).padEnd(width) : text)
  const figures = (tokens: number, window: number, percent: number): string =>
    `${isTerminal ? '' : `${contextBar(percent)} `}${contextFigures(tokens, window, percent)}`
  const mainPercent = main?.percent ?? (main?.tokens === undefined ? undefined : percentOf(main.tokens, main.window))
  const running = rows.filter(row => row.status === 'running')
  const finished = rows.filter(row => row.status !== 'running')

  const agentRow = (row: AgentRow): RenderElement => {
    const mark = STATUS_MARK[row.status]
    const percent = row.contextTokens === undefined ? undefined : percentOf(row.contextTokens, row.window)
    const tail = [
      row.outputTokens === undefined || row.status === 'running' ? '' : ` · out ${formatTokens(row.outputTokens)}`,
      row.effort === undefined ? '' : ` · effort ${row.effort}`,
      row.handoffAt === undefined ? '' : ` · handoff at ${row.handoffAt}%`,
      row.description === '' ? '' : ` · ${row.description}`,
    ].join('')

    return (
      <Box key={`agent-${row.id}`}>
        <Text wrap="truncate-end">
          <Text color={mark.color}>{mark.glyph} </Text>
          {/* The glyph and its space take two cells of the column main's label fills. */}
          <Text weight="semibold">{label(agentLabel(row), TERMINAL_LABEL_WIDTH - 2)}</Text>
          {` ${formatElapsed((row.endedAt ?? now) - row.startedAt)}`}
          {percent === undefined || row.contextTokens === undefined ? null : (
            <Text color={contextColor(percent)}> · ctx {contextFigures(row.contextTokens, row.window, percent)}</Text>
          )}
          <Text dimColor>{tail}</Text>
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {main === null ? null : (
        <Box key="main" gap={1}>
          <Text dimColor>{label('model-balance · main', TERMINAL_LABEL_WIDTH)}</Text>
          {mainPercent === undefined || main.tokens === undefined ? (
            <Text dimColor>context —</Text>
          ) : (
            <Text color={contextColor(mainPercent)}>{figures(main.tokens, main.window, mainPercent)}</Text>
          )}
          {main.model === undefined ? null : (
            <Text dimColor>
              {`· ${shortModelName(main.model)}${main.effort === undefined ? '' : ` · effort ${main.effort}`}`}
            </Text>
          )}
        </Box>
      )}
      {running.map(agentRow)}
      {finished.length === 0 ? null : (
        <Box key="history">
          <Button
            key="history-toggle"
            label={isHistoryOpen ? `▾ Hide finished (${finished.length})` : `▸ Finished (${finished.length})`}
            dimColor
            // ctrl+x tab then Enter presses it: the band's focus starts here.
            autoFocus
            onPress={() => update($, historyOpenAtom, isOpen => !isOpen)}
          />
        </Box>
      )}
      {isHistoryOpen ? finished.slice(0, BOARD_FINISHED_SHOWN).map(agentRow) : null}
    </Box>
  )
}

export const register: Register = (on, options) => {
  const router: Router = { model: readRouterModel(options.router_model), effort: readRouterEffort(options.router_effort) }
  const workerEffort = Object.fromEntries(
    TIERS.map(tier => [tier, readWorkerEffort(options[`${tier}_effort`], tier)]),
  ) as Record<Tier, WorkerEffort>
  /** A tier's effort: the one the router named, else the tier's option, none for `session`. */
  const effortFor = (tier: Tier, named?: SubagentEffort): SubagentEffort | undefined => {
    if (named !== undefined) return named
    const configured = workerEffort[tier]

    return configured === 'session' ? undefined : configured
  }
  /** Routed agents this module started, by agent id; lost on a reload, which only costs a lookup in the state. */
  const workers = new Map<string, Tier>()
  /** The latest top-level worker this module started; lost on a reload, when the agent list's last one stands in. */
  let lastWorkerId: string | undefined
  /**
   * Each worker's handoff as main wrote it, by agent id, for the classifier to judge a follow-up against;
   * the agent list carries only a short description. Lost on a reload: the description alone stands in.
   */
  const workerTasks = new Map<string, string>()
  /**
   * The new agent the latest person's prompt was routed to, for the spawn its note asks of main; cleared by
   * the next prompt. Lost on a reload, when that spawn is rated as a fork of main's own.
   */
  let routed: RoutedSpawn | undefined
  /** Pins of agents spawned and not started yet: a fork's first request can come before its spawn resolves. */
  const pending: PendingPin[] = []

  on('session.start', async ($, e, next) => {
    for (const tier of TIERS) {
      const effort = workerEffort[tier]
      await $.agent.register({
        name: `${tier}-worker`,
        description: `Worker for ${tier}-level tasks. Use only when a model-balance routing note names this type.`,
        prompt: workerPrompt(tier),
        model: tier,
        // docs/sub-agents: frontmatter `effort` overrides the session's level; `session` leaves it to Claude Code.
        // A routed worker's requests run at the router's effort (turn.step), this one standing in when it names none.
        ...(effort === 'session' ? {} : { effort }),
        disallowedTools: ['Agent'],
      })
    }
    await $.tool.register({
      name: ASK_TOOL,
      description:
        'For model-balance workers and forks only: asks the user 1-4 questions together in one AskUserQuestion dialog and returns the answers. Use it when a decision only the user can make blocks the task; then continue the task with the answers.',
      inputSchema: ASK_TOOL_SCHEMA,
      isDeferred: false,
    })
    await $.command.register({
      name: 'model-balance',
      description: 'Route prompts to Haiku/Sonnet/Opus workers by difficulty and effort, for this session',
      argumentHint: '[on|off|status|context|panel]',
      immediate: true,
    })
    $.ui.status(statusText(await isEnabled($)))
    try {
      await measureMain($)
    } catch {
      // The band shows no main bar until the first measurement; nothing else depends on it.
    }
    try {
      await pruneSavedToggles($)
    } catch {
      // Housekeeping only: a failed prune leaves old entries for the next start.
    }
    // A running row's clock: redraw each second while one runs, nothing otherwise.
    $.clock.every(1000, () => {
      void read($, agentsAtom)
        .then(rows => {
          if (rows.some(row => row.status === 'running')) $.ui.invalidate('ui.render')
        })
        .catch(() => undefined)
    })

    return next(e)
  })

  /**
   * A /clear (/new is the same command) or a /resume moves the process to another conversation without a
   * `session.start` (SessionEndInput: "no `session.start` fires for it"); the classic SessionStart hook fires
   * for it, with the new session's id. The new conversation starts off unless it is a resumed one that was
   * switched on, and nothing of the last one reaches it: not its board, nor its workers' reports, which a new
   * worker would read as its own session's record, nor its handoffs, which a spawn of the same type would take up.
   * A fork of the conversation is a new session too, so it starts off, but it keeps the record it carries on.
   */
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'startup' || e.source === 'compact') return next(e)
    await adoptSession($, e.session_id)
    if (e.source === 'fork') return next(e)

    workers.clear()
    workerTasks.clear()
    lastWorkerId = undefined
    routed = undefined
    pending.length = 0
    await update($, agentsAtom, () => [])
    await update($, reportsAtom, () => [])
    await update($, handoffsAtom, () => [])
    await update($, historyOpenAtom, () => false)
    await update($, paneDismissedAtom, () => false)
    await measureMain($)

    return next(e)
  }).catch(($, e, next) =>
    // The next prompt still finds the new session id (isEnabled) and starts it off; only the board may lag.
    next(e),
  )

  on('command.run', { command: 'model-balance' }, async ($, e) => {
    const onOff = (isOn: boolean): string => (isOn ? 'on' : 'off')
    const command = readToggleCommand(e.args)

    if (command.scope === 'session') {
      await setEnabled($, command.enabled)

      return {
        text: `model-balance is ${onOff(command.enabled)} for this session; other sessions keep their own setting, and every new session starts off.`,
      }
    }
    if (command.scope === 'panel') {
      if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
        await update($, paneDismissedAtom, () => true)
        await $.ui.close({ id: PANE })

        return { text: 'model-balance panel closed; /model-balance panel opens it again.' }
      }
      await update($, paneDismissedAtom, () => false)
      const opened = await $.ui.open({ id: PANE, title: 'model-balance' })

      return { text: opened.isPlaced ? 'model-balance panel opened.' : `model-balance panel is waiting: ${opened.reason}` }
    }

    if (command.scope === 'context') {
      const { context } = await $.session.usage()
      const main: ContextLine = {
        label: `main (${await $.session.model()})`,
        tokens: context.tokens,
        window: context.window,
      }
      const windowEnv = await readWindowEnv($)
      const rows = await read($, agentsAtom)
      const agents: ContextLine[] = (await $.agent.list()).map(agent => {
        const row = rows.find(one => one.id === agent.id)

        return {
          label: `${row === undefined ? agent.type : agentLabel(row)}${agent.description === '' ? '' : ` · ${agent.description}`}`,
          ...(row?.contextTokens === undefined ? {} : { tokens: row.contextTokens }),
          window: row?.window ?? contextWindowOf(agent.type, windowEnv),
          note: agent.status,
        }
      })

      return { text: formatContextReport(main, agents) }
    }

    const main = await $.session.model()
    const efforts = TIERS.map(tier => `${tier} ${workerEffort[tier]}`).join(' · ')
    const usage = 'Use /model-balance on|off for this session, /model-balance context for every context window, /model-balance panel to open or close the board.'

    return {
      text: `${command.isUnknown ? `Unknown argument "${e.args.trim()}". ` : ''}model-balance is ${onOff(await isEnabled($))} for this session; every new session starts off and a resumed one keeps its own choice. Main model: ${main}. Router: ${router.model} at effort ${router.effort}, which picks each task's model and effort; a routed task runs in a fresh worker on them, briefed by main. Effort when the router names none: ${efforts} (never above xhigh). A /subtask or a fork main starts is rated too: its effort is pinned, and its model only where the switch pays for writing main's context to a new cache. While on, auto-compaction is off in main and every subagent (/compact still works), and a subagent past ${Math.round(HANDOFF_RATIO * 100)}% of its context hands its work to a fresh one on the same model and effort. ${usage} Prefix a prompt with #haiku, #sonnet or #opus (optionally :low, :medium, :high or :xhigh) to choose yourself, or #main to skip routing.`,
    }
  })

  on('prompt.submit', async ($, e, next) => {
    // A background agent's report arrives in a notification naming its id: a handoff in it gets main's
    // continuation note, whether or not routing is still on, so a task cut at the context limit goes on.
    if (e.origin.kind === 'task-notification') {
      let notes: string[] = []
      try {
        notes = await announceHandoffs($, e.text)
      } catch {
        // The notification goes on as it came; on a routed turn main's note says what a handoff line asks.
      }

      return next(notes.length === 0 ? e : { ...e, context: [...(e.context ?? []), ...notes] })
    }
    if (!ROUTED_ORIGINS.has(e.origin.kind) || !(await isEnabled($))) return next(e)
    routed = undefined

    const { override, effort: overrideEffort, rest } = readOverride(e.text)
    if (override === 'main') {
      $.ui.status('→ main (#main)')

      return next({ ...e, text: rest })
    }
    if (override === undefined && !isWorthRouting(e.text)) {
      // A short follow-up says why the router was not asked, so the line does not keep the last verdict.
      if (!e.text.trimStart().startsWith('/')) $.ui.status('→ main (short prompt)')

      return next(e)
    }

    const text = override === undefined ? e.text : rest
    const agents = await $.agent.list()
    // Only a worker of this conversation is continued: its board is emptied with the conversation (/clear, /resume).
    const onBoard = new Set((await read($, agentsAtom)).map(row => row.id))
    const lastAgent = pickLastWorker(agents.filter(agent => onBoard.has(agent.id)), lastWorkerId)
    const last = lastAgent === undefined ? undefined : toLastWorker(lastAgent, workerTasks.get(lastAgent.id))
    const runningAgent = agents.find(agent => isTopLevelWorker(agent) && isActiveStatus(agent.status))
    const running = runningAgent === undefined ? undefined : toLastWorker(runningAgent, workerTasks.get(runningAgent.id))
    // An explicit #tier asks for a fresh worker, so only the classifier's own verdict continues one.
    const verdict: Verdict =
      override === undefined
        ? await classify($, text, last, router)
        : { route: override, ...(overrideEffort === undefined ? {} : { effort: overrideEffort }), by: 'override', isContinuation: false }

    // Answerable from the conversation itself: main answers, with no note and no worker.
    if (verdict.route === 'main') {
      $.ui.status(`→ main (${verdict.by})`)

      return next({ ...e, text })
    }
    const tier = verdict.route

    if (verdict.isContinuation && last !== undefined && (running === undefined || running.id === last.id)) {
      $.ui.status(`→ continue ${last.tier} worker (${verdict.by})`)

      return next({ ...e, text, context: [...(e.context ?? []), continueNote(last, verdict.by)] })
    }
    if (running !== undefined) {
      $.ui.status(`→ on hold: ${running.tier} worker still running`)

      return next({ ...e, text, context: [...(e.context ?? []), waitNote(running)] })
    }

    const effort = effortFor(tier, verdict.effort)
    routed = { tier, ...(effort === undefined ? {} : { effort }), by: verdict.by }
    $.ui.status(`→ ${tier}${effort === undefined ? '' : ` · ${effort}`} (${verdict.by})`)

    return next({ ...e, text, context: [...(e.context ?? []), spawnNote(routed)] })
  }).catch(($, e, next) => {
    // The router failing must never cost the person their prompt: it goes to main as typed. This build types
    // `kind` without `re-entry`, which the docs still list for a skipped re-entrant dispatch.
    if ((next.error.kind as string) !== 're-entry') $.ui.status('→ main (router failed)')

    return next(e)
  })

  /**
   * A /subtask (docs/sub-agents: an in-session fork the person starts) raises no `agent.spawn`: its task is
   * rated here, the pin waits for the fork's first turn, and the notice joins the task's end, so the fork's
   * name, taken from the task's first words, stays the person's.
   */
  on('command.run', { command: 'subtask' }, async ($, e, next) => {
    const task = e.args.trim()
    if (task === '' || !(await isEnabled($))) return next(e)

    const rated = await rateTask($, task, router)
    const pin = await forkPinOf($, rated.tier, effortFor(rated.tier, rated.effort))
    const args = `${e.args.trimEnd()}\n\n${agentNotice(pin)}`
    addPending(pending, args, pin, await $.clock.now())
    $.ui.status(`→ /subtask on ${pinText(pin)} (${rated.by})`)

    return next({ ...e, args })
  }).catch(($, e, next) =>
    // Rating the task failed: the fork runs as Claude Code starts it, on main's model and effort.
    next(e),
  )

  /**
   * One top-level worker writes at a time: a second spawn while one runs is refused, whoever asks for it.
   * A worker starts from main's handoff with the session's record beside it, on its tier's model at the
   * router's effort. While routing is on, a fork main starts on its own is rated as a /subtask is, and every
   * other agent main spawns is told the handoff request is the person's; with routing off every spawn passes
   * untouched and only goes on the board.
   *
   * A spawn that continues a handoff (findContinuation) runs as the agent type the continuation note named
   * and on the model of the one that handed off, with its report whole ahead of main's prompt; turn.step
   * pins its effort.
   */
  on('agent.spawn', async ($, input, next) => {
    if (!canHandOffSpawn(input) || input.resume !== undefined) {
      // A resume, a nested agent, a teammate or a workflow agent: on the board, under its pin when it has one.
      const started = await next(input)
      await trackSpawn($, input, started, pinOf(await read($, pinsAtom), started.agentId ?? input.resume?.agentId ?? ''))

      return started
    }

    const continuation = findContinuation(await read($, handoffsAtom), input)
    const target = continuation === undefined ? input.subagentType : (continuation.continueAs ?? continuation.type)
    // A fork's type is its identity, and no other spawn becomes one: the type changes only between other types.
    const e: AgentSpawnInput =
      continuation === undefined || input.fork || target === FORK_TYPE ? input : { ...input, subagentType: target }
    const isOn = await isEnabled($)
    const tier = tierOfWorker(e.subagentType)

    if (tier !== undefined) {
      const running = (await $.agent.list()).find(agent => isTopLevelWorker(agent) && isActiveStatus(agent.status))
      if (running !== undefined) {
        return {
          deny: `A model-balance worker (${running.id}) is still running; two workers must not edit the same working tree at once. Tell the user this request waits until it finishes, or continue that worker with SendMessage if the request belongs to its task.`,
        }
      }
    }

    const pin: PinSpec | undefined = await (async () => {
      if (continuation !== undefined) {
        const continuedTier = continuation.tier ?? tierOfWorker(continuation.type) ?? tier
        return {
          ...(continuedTier === undefined ? {} : { tier: continuedTier }),
          model: continuation.model,
          ...(continuation.effort === undefined ? {} : { effort: continuation.effort }),
        }
      }
      if (tier !== undefined) {
        // The router's effort for the tier it routed to; a worker main picked itself runs at its tier's option.
        const effort = routed?.tier === tier ? routed.effort : effortFor(tier)
        return routedPin({ tier, ...(effort === undefined ? {} : { effort }), by: '' })
      }
      if (!e.fork || !isOn) return undefined
      // A fork main started on its own: rated as a /subtask is.
      const rated = await rateTask($, e.prompt, router)

      return forkPinOf($, rated.tier, effortFor(rated.tier, rated.effort))
    })()

    const prompt: string = await (async () => {
      if (tier !== undefined) {
        // The worker handing off reaches its successor whole, in its own block, not clipped among the others.
        const reports = (await read($, reportsAtom)).filter(one => one.id !== continuation?.agentId)
        const earlier = formatReports(reports, REPORTS_IN_PROMPT)
        const excerpt = excerptOf(await $.session.messages())
        const memory = await readMemoryIndex($)
        // Long material first and the task last, as docs/long-context-tips lays out a prompt.
        return [
          memory === undefined ? '' : `<auto_memory dir="${directoryOf(memory.path)}">\n${memory.text}\n</auto_memory>`,
          excerpt === '' ? '' : `<recent_messages>\n${excerpt}\n</recent_messages>`,
          earlier === '' ? '' : `<earlier_workers>\n${earlier}\n</earlier_workers>`,
          continuation === undefined ? '' : handoffBlock(continuation),
          `<handoff>\n${e.prompt}\n</handoff>`,
        ]
          .filter(part => part !== '')
          .join('\n\n')
      }
      const body = continuation === undefined ? e.prompt : `${handoffBlock(continuation)}\n\n${e.prompt}`

      return isOn || continuation !== undefined ? `${body}\n\n${agentNotice(pin)}` : body
    })()

    if (pin !== undefined) addPending(pending, prompt, pin, await $.clock.now())
    const model = e.fork ? undefined : (continuation?.model ?? tier)
    const started = await next({ ...e, prompt, ...(model === undefined ? {} : { model }) })
    const agentId = started.agentId
    if (agentId === undefined || started.deny !== undefined) return started

    // Never throws, so what follows (the status line, the editor pane) still runs.
    try {
      if (pin !== undefined) {
        takePending(pending, prompt)
        await savePin($, agentId, pin)
      }
      if (continuation !== undefined) {
        await update($, handoffsAtom, list => patchHandoff(list, continuation.agentId, { status: 'continued', continuedBy: agentId }))
        $.ui.toast(`${handoffLabel(continuation)} ${agentId} continues the handoff of ${continuation.agentId}`)
      }
    } catch {
      // The pin was taken at the agent's first turn, or its requests run as the engine resolved them.
    }
    await trackSpawn($, e, started, pin)
    if (tier !== undefined) {
      workers.set(agentId, tier)
      lastWorkerId = agentId
      rememberLatest(workerTasks, agentId, e.prompt, BOARD_AGENTS)
      $.ui.status(`▶ ${tier} worker: ${e.description}`)
      try {
        await openPaneInEditor($)
      } catch {
        // The board stays one /model-balance panel away.
      }
    }

    return started
  }).catch(($, e, next) => {
    // Preparing the worker failed: it still starts, on its tier's model, without the session's record.
    const tier = tierOfWorker(e.subagentType)

    return next.called || tier === undefined ? next(e) : next({ ...e, model: tier })
  })

  /**
   * While routing is on, nothing compacts on its own, in main or in any subagent: a subagent hands off at
   * the threshold instead (turn.step), and the person compacts main with /compact when they choose.
   */
  on('session.compact', { trigger: ['auto', 'precompute'] }, async ($, e, next) =>
    (await isEnabled($)) ? { skip: AUTO_COMPACT_SKIP } : next(e),
  ).catch(($, e, next) =>
    // Failing open: a compaction that runs is better than a conversation left too long for its window.
    next(e),
  )

  /**
   * A subagent run in the foreground hands its report back as the Agent tool's result, not in a
   * notification: a handoff there gets main's continuation note beside the result.
   */
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const called = await next(e)
    if (called.deny !== undefined || called.isError === true) return called
    const { result } = called
    if (!('status' in result) || result.status !== 'completed') return called
    try {
      const notes = await announceHandoffs($, result.agentId)

      return notes.length === 0 ? called : { ...called, context: [...(called.context ?? []), ...notes] }
    } catch {
      // Main still reads the report; on a routed turn its note says what the report's handoff line asks.
      return called
    }
  }).catch(($, e, next) =>
    // `next` is replay-safe here: the agent's result as it came back, nothing run again.
    next(e),
  )

  /**
   * A subagent asked to hand off (turn.step) reads the request beside its next tool result, as a
   * PostToolUse hook's context: in band, so no permission check stands between it and the agent.
   */
  on('tool.call', async ($, e, next) => {
    const called = await next(e)
    const agentId = e.agentId
    if (agentId === undefined || called.deny !== undefined) return called
    const handoff = undeliveredHandoffOf(await read($, handoffsAtom), agentId)
    if (handoff === undefined) return called

    const now = await $.clock.now()
    await update($, handoffsAtom, list => patchHandoff(list, agentId, { deliveredAt: now }))
    $.ui.toast(`${handoffLabel(handoff)} at ${percentOf(handoff.tokens, handoff.window)}% context, asked to hand off`)

    return { ...called, context: [...(called.context ?? []), handoffRequest(handoff)] }
  }).catch(($, e, next) =>
    // `next` is replay-safe: the tool ran once, and its result goes back without the request.
    next(e),
  )

  /**
   * A routed turn's editing is the worker's: main's own file edits are refused, except in the auto-memory
   * directory, where main keeps saving what the person asks it to remember.
   */
  on('tool.call', { tool: MAIN_WRITE_TOOLS }, async ($, e, next) => {
    if (e.agentId !== undefined || !(await isEnabled($)) || !isRoutedTurn(await $.session.messages())) return next(e)

    // The matcher types `e` on one variant; the three tools name their target differently.
    const { file_path: filePath, notebook_path: notebookPath } = e as unknown as { file_path?: string; notebook_path?: string }
    const target = notebookPath ?? filePath
    const memory = await readMemoryIndex($)
    if (target !== undefined && memory !== undefined && isInside(target, directoryOf(memory.path))) return next(e)

    return {
      deny: `model-balance routed this request to a worker, so ${e.tool} is refused to the main conversation on this turn. Follow the routing note: hand the work to the worker. The user can prefix a prompt with #main to have the main conversation edit.`,
    }
  }).catch(($, e, next) =>
    // The guard keeps routing discipline, not safety: when it cannot judge, main keeps its editing tools
    // rather than being locked out until the plugin is disabled.
    next(e),
  )

  /**
   * Subagents have no AskUserQuestion of their own (docs/sub-agents removes it from every subagent); this
   * opens the person's dialog for a worker or a fork, all its questions at once, and waits.
   */
  on('tool.call', { tool: 'mcp__model-balance__ask_user' }, async ($, e) => {
    const agentId = e.agentId
    const tier = agentId === undefined ? undefined : await workerTier($, workers, agentId)
    const pin = agentId === undefined ? undefined : pinOf(await read($, pinsAtom), agentId)
    const type = agentId === undefined ? undefined : (await $.agent.list()).find(one => one.id === agentId)?.type
    if (tier === undefined && pin?.tier === undefined && type !== FORK_TYPE) {
      return { deny: `${ASK_TOOL_NAME} is for model-balance workers and forks; ask with AskUserQuestion instead.` }
    }

    const questions = readQuestions(e.questions)
    if (typeof questions === 'string') return { deny: questions }

    const asker = agentLabel({ ...((tier ?? pin?.tier) === undefined ? {} : { tier: (tier ?? pin?.tier)! }), type: type ?? FORK_TYPE })
    const shown = questions.map(one => ({ ...one, question: `(${asker}) ${one.question}` }))
    const call = await $.tool.call({ tool: 'AskUserQuestion', questions: shown })
    const originals = questions.map(one => one.question)
    // Dismissed, refused, or nobody to ask (as under -p): nothing was answered.
    if (call.deny !== undefined || call.isError === true || call.result === undefined) {
      return { result: formatAnswers([], originals) }
    }

    const answers = call.result.answers as Readonly<Record<string, unknown>>
    const byOriginal = Object.fromEntries(shown.map((one, index) => [originals[index]!, answers[one.question]]))
    const { asked, unanswered } = readAnswers(originals, byOriginal)
    const written = call.result.response?.trim() ?? ''
    if (written === '') return { result: formatAnswers(asked, unanswered) }

    return {
      result: `${formatAnswers(asked, [])}\n\nThe user wrote, in place of choosing an option: "${written}". Read it as their answer to every question above left without a choice${unanswered.length === 0 ? '' : ` (${unanswered.map(q => `"${q}"`).join(', ')})`}.`.trimStart(),
    }
  }).catch(() => ({
    deny: 'The question dialog could not be opened. Do not guess: stop, and list your questions under "Open" in your final report.',
  }))

  /**
   * A run of a subagent begins: a new agent takes the pin its spawn (or its /subtask) left for the prompt it
   * starts with, before its first request, and a resume through SendMessage, which raises no spawn, starts
   * its clock again. A fork with no spawn (a /subtask) goes on the board here.
   */
  on('turn.start', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId !== undefined) {
      try {
        const now = await $.clock.now()
        const taken = takePending(pending, e.text)
        if (taken !== undefined) await savePin($, agentId, taken)
        const pin = taken ?? pinOf(await read($, pinsAtom), agentId)
        const rows = await read($, agentsAtom)
        const known = rows.find(row => row.id === agentId)
        const agent = known === undefined ? (await $.agent.list()).find(one => one.id === agentId) : undefined
        const windowEnv = await readWindowEnv($)
        // An unpinned fork runs on main's model, which its window follows.
        const forkModel = agent?.type === FORK_TYPE && pin?.model === undefined ? await $.session.model() : undefined
        const model = pin?.model ?? forkModel
        const pinned: Partial<AgentRow> = {
          ...(pin?.tier === undefined ? {} : { tier: pin.tier }),
          ...(model === undefined ? {} : { model, window: contextWindowOf(model, windowEnv) }),
        }
        await update($, agentsAtom, list => {
          if (list.some(one => one.id === agentId)) return patchAgent(restartAgent(list, agentId, now), agentId, pinned)
          if (agent === undefined) return list
          const tier = pin?.tier ?? tierOfWorker(agent.type)

          return upsertAgent(
            list,
            {
              id: agentId,
              type: agent.type,
              ...(tier === undefined ? {} : { tier }),
              description: agent.description,
              status: 'running',
              startedAt: now,
              window: contextWindowOf(model ?? tier ?? agent.type, windowEnv),
              ...pinned,
              // A /subtask is a fork of main's own: main can continue it from a handoff.
              ...(agent.type === FORK_TYPE && agent.parentId === undefined ? { canHandOff: true as const } : {}),
            },
            BOARD_AGENTS,
          )
        })
      } catch {
        // The board shows this run late, at its first request, or not at all; the run is unaffected.
      }
    }

    return next(e)
  })

  /**
   * Every subagent request runs on the model and at the effort its pin holds (the router's choice, or the
   * predecessor's for a handoff's continuation), and is held below `max`, the person's ceiling for
   * subagents. Its usage puts the agent's context fill and effort on the board, and an agent past the
   * handoff point is marked to hand off while routing is on.
   */
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      try {
        await noteMainRequest($, e.model, e.effort)
      } catch {
        // Main's row keeps the model and effort it showed; the request is unaffected.
      }

      return yield* next(e)
    }

    const agentId = e.agentId
    let pin: Pin | undefined
    try {
      pin = pinOf(await read($, pinsAtom), agentId)
    } catch {
      // The request runs on its own model and effort, still held below max.
    }
    const model = pin?.model ?? e.model
    const effort = subagentEffortOf(pin?.effort ?? e.effort)
    const step = yield* next(model === e.model && effort === e.effort ? e : { ...e, model, effort })
    const usage = step.usage
    if (usage !== null) {
      try {
        const row = (await read($, agentsAtom)).find(one => one.id === agentId)
        if (row !== undefined) {
          const rowModel = row.model ?? usage.model
          const window = row.model === undefined ? contextWindowOf(rowModel, await readWindowEnv($)) : row.window
          const tokens = contextTokensOf(usage)
          await update($, agentsAtom, rows =>
            patchAgent(rows, agentId, {
              contextTokens: tokens,
              model: rowModel,
              window,
              ...(effort === undefined ? {} : { effort: String(effort) }),
            }),
          )
          if (
            row.canHandOff === true &&
            row.handoffAt === undefined &&
            step.stopReason === 'tool_use' &&
            isPastHandoffPoint(tokens, window)
          ) {
            const isAsked = (await read($, handoffsAtom)).some(one => one.agentId === agentId)
            if (!isAsked && (await isEnabled($))) await requestHandoff($, row, { tokens, window, model: usage.model, effort })
          }
        }
      } catch {
        // The board keeps the previous figures and no handoff is asked this step; the step itself is done.
      }
    }

    return step
  })

  /**
   * A subagent's run ended: its row closes, a worker's report joins the session's record, and an agent that
   * was asked to hand off has its report read for work remaining.
   */
  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId !== undefined) {
      try {
        // `complete` is read again: a run resumed after it finished may still hand off.
        const handoff = (await read($, handoffsAtom)).find(
          one => one.agentId === agentId && (one.status === 'requested' || one.status === 'complete'),
        )
        if (handoff !== undefined) {
          const report = e.answer.trim()
          const change: Partial<Handoff> =
            e.reason !== 'answer'
              ? { status: 'ended' }
              : readHandoffOutcome(report) === 'continue'
                ? { status: 'reported', report }
                : { status: 'complete' }
          await update($, handoffsAtom, list => patchHandoff(list, agentId, change))
        }
      } catch {
        // Main still reads the report and its handoff line; only the continuation's attachments miss it.
      }
      try {
        const tier = await workerTier($, workers, agentId)
        const now = await $.clock.now()
        const status = endStatusOf(e.reason)
        const row = (await read($, agentsAtom)).find(one => one.id === agentId)
        await update($, agentsAtom, rows =>
          patchAgent(rows, agentId, {
            status,
            endedAt: now,
            ...(e.usage === undefined ? {} : { outputTokens: e.usage.output_tokens }),
          }),
        )

        // A worker off the board belongs to a conversation that ended (/clear, /resume): its report is not this one's record.
        if (tier !== undefined && row !== undefined) {
          workers.delete(agentId)
          const answer = e.answer.trim()
          if (answer !== '') {
            await update($, reportsAtom, reports =>
              pushReport(
                reports,
                {
                  id: agentId,
                  tier,
                  description: row?.description ?? '',
                  report: status === 'done' ? answer : `[${status} before finishing]\n${answer}`,
                  at: now,
                },
                REPORTS_KEPT,
              ),
            )
          }

          const seconds = formatElapsed(row === undefined ? e.durationMs : now - row.startedAt)
          const context =
            row?.contextTokens === undefined
              ? ''
              : ` · context ${formatTokens(row.contextTokens)} (${percentOf(row.contextTokens, row.window)}%)`
          const output = e.usage === undefined ? '' : ` · out ${formatTokens(e.usage.output_tokens)}`
          const label = agentLabel({ tier, type: row?.type ?? workerType(tier) })
          $.ui.toast(`${label} ${status === 'done' ? 'finished' : status} in ${seconds}${context}${output}`)
          $.ui.status(statusText(await isEnabled($)))
        }
      } catch {
        // The board and the record miss this end; the turn's own result goes on unchanged.
      }
    }

    return next(e)
  })

  /** Pushed by the engine after each main-thread turn: no polling, the band redraws on the write. */
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      await update($, mainContextAtom, main => ({
        ...main,
        tokens: e.context.tokens,
        window: e.context.window,
        percent: e.context.percent,
      }))
    }

    return next(e)
  })

  /** A pane the person closed stays closed for the session: the board goes back to the band and the status line. */
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await update($, paneDismissedAtom, () => true)

    return next(e)
  }).catch(($, e, next) =>
    // Remembering the close is a nicety: the close itself always goes through.
    next(e),
  )

  /** The band is drawn on the terminal and the desktop only; VS Code gets the same rows in the pane. */
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const toggle = await read($, toggleRef)
    if (e.props.hasSurvey || toggle?.enabled !== true) return next(e)

    const main = await read($, mainContextAtom)
    const rows = await read($, agentsAtom)
    if (main === null && rows.length === 0) return next(e)

    return drawBoard($, $.ui.resolve(e), {
      main,
      rows,
      isHistoryOpen: await read($, historyOpenAtom),
      now: await $.clock.now(),
      isTerminal: e.surface === 'terminal',
    })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const main = await read($, mainContextAtom)
    const rows = await read($, agentsAtom)
    const els = $.ui.resolve(e)
    if (main === null && rows.length === 0) {
      const { Text } = els

      return <Text dimColor>No subagent has run in this session yet.</Text>
    }

    return drawBoard($, els, {
      main,
      rows,
      isHistoryOpen: await read($, historyOpenAtom),
      now: await $.clock.now(),
      isTerminal: e.surface === 'terminal',
    })
  })
}
