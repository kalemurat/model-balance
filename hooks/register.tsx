import { atom, read, update } from 'claude-code'
import type { AgentSpawnInput, AgentSpawnResult, ElementTable, EngineInterface, Register, RenderElement } from 'claude-code'

import {
  ASK_TOOL,
  ASK_TOOL_SCHEMA,
  DEFAULT_TOGGLE_KEY,
  MARK_CLOSE,
  MARK_OPEN,
  TIERS,
  agentLabel,
  cappedSubagentEffort,
  contextBar,
  contextColor,
  contextFigures,
  contextTokensOf,
  clipMemoryIndex,
  contextWindowOf,
  directoryOf,
  endStatusOf,
  excerptOf,
  formatAnswers,
  formatContextReport,
  formatElapsed,
  formatReports,
  formatTokens,
  guessTier,
  isActiveStatus,
  isContinuationReply,
  isInside,
  isRoutedTurn,
  isStaleSessionToggle,
  isSwitchOn,
  isWorthRouting,
  memoryIndexPathOf,
  parseVerdict,
  patchAgent,
  percentOf,
  pickLastWorker,
  pushReport,
  readAnswers,
  readDefaultToggle,
  readOverride,
  readQuestions,
  readRouterModel,
  readSavedToggle,
  readToggleCommand,
  readWorkerEffort,
  restartAgent,
  routerChain,
  sessionToggleKey,
  tierOfWorker,
  upsertAgent,
  workerType,
  type ContextLine,
  type Provider,
  type Route,
  type RouterModel,
  type SavedToggle,
  type Tier,
  type WindowEnv,
  type WorkerCandidate,
  type WorkerEffort,
} from './route'
import type { AgentRow, MainContext, SessionToggle } from '../types'

const ASK_TOOL_NAME = `mcp__model-balance__${ASK_TOOL}` as const

declare module 'claude-code' {
  interface McpToolInputs {
    /** Loose on purpose: `readQuestions` checks what the worker actually sent. */
    'mcp__model-balance__ask_user': { questions: unknown }
  }
}

/** `by` names who decided: `override`, `<model> router` or `heuristic`. */
type Verdict = { route: Route; by: string; isContinuation: boolean }

/** The latest top-level worker as the router reads it for a follow-up. */
type LastWorker = { id: string; tier: Tier; description: string; task: string; isActive: boolean }

/** Prompts a person sent; notifications, peers, schedules and other plugins pass untouched. */
const ROUTED_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

/** Main's tools that change files; refused to main on a routed turn so the worker does the editing. */
const MAIN_WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const

/** How much of the last worker's task the classifier reads to judge a follow-up. */
const LAST_TASK_CHARS = 1500

const CLASSIFIER_SYSTEM = `You route one request in a coding-assistant session to the cheapest handler that will do it well.
MAIN: the main conversation answers it at once from what is already in the conversation, with no file to read or change: a question about the last answer or about work a worker just reported, a clarification, a choice or yes/no the user makes, a commit message or summary of work the conversation already describes.
HAIKU: small, well-specified work: lookups, explaining a known thing, renames, typos, formatting, small single-file edits, translations.
SONNET: everyday engineering: features, bug fixes with a clear lead, tests, multi-file edits that follow existing patterns, code review, checking a change in the browser.
OPUS: architecture and design decisions, unclear root causes, cross-cutting refactors or migrations, matching an old system's behaviour exactly, concurrency, security, performance, long multi-step plans.
When unsure between two levels, pick the higher. Pick MAIN only when nothing has to be read, run or changed.
When a <last_worker> block describes a task a worker is doing or did, also judge whether the request continues that task (a follow-up, a correction, more of the same, an answer to its question, "try the second option") or is a new task, and answer with two words: the level and CONTINUE or NEW, e.g. "SONNET NEW". MAIN is always "MAIN NEW". Without that block answer with exactly one word: MAIN, HAIKU, SONNET or OPUS.`

const workerPrompt = (tier: Tier): string => `You are the ${tier} worker of the model-balance router: it judged the task you are given to be of ${tier}-level difficulty.

You do not see the user's main conversation. Your first message brings what you need from it:
- <handoff> is your task: the main conversation's brief, written by the model that has the whole conversation, with the request, the context that bears on it, pointers and what done means. It is your primary source.
- <earlier_workers> holds the reports of the workers that ran before you in this session, newest first. Build on what they changed and decided; do not redo or undo their work unless the handoff says so.
- <recent_messages> quotes the latest messages of the main conversation verbatim, for the user's exact wording. Where it and the handoff disagree, the newest user message wins.
- <auto_memory> is the index of the user's auto memory, which the main conversation loads and you do not: one line per memory file in the directory it names.
A later message from the main conversation continues the same task (a follow-up, a correction, answers) and says what changed since your last report.

Before you start, open with Read the memory files whose line touches your task, every feedback_ one among them, and follow them as the main conversation would. Leave writing memory to the main conversation.

Do the task completely with the tools you have, following the project's instructions.

When the work needs a decision only the user can make (a choice between approaches, a missing fact, an ambiguity the request, the code and the docs do not settle), ask it with the ${ASK_TOOL_NAME} tool: it opens the user's own AskUserQuestion dialog, waits for the answers and returns them, and you carry on with the task using them. Ask only what blocks the work, gather related questions into one call (up to 4), and never answer in the user's place. Do not end your run with a question in your final message expecting a reply: nobody replies to it. If the tool reports a question left unanswered, stop and list it under "Open" in your report. If something else blocks you, stop and say what.

Your final message is the only thing the main conversation receives, and it is kept as the session's record of your work for the workers after you. Write it as a report under these headings, leaving out a heading with nothing under it:
## Result: the outcome in one to three sentences.
## Changes: each file you changed, by path, and what changed in it.
## Decisions & findings: what you decided or learned that later work must know.
## Questions: each question you asked the user, with the answer.
## Open: what is left undone or unverified, and any question still open.
## Remember: anything worth saving to memory.
Keep it under about 350 words unless the answer itself (code or text the user asked for) needs more. Write it in the language the user writes in.`

const NO_EDITS = 'Edit, Write and NotebookEdit are refused to you on this turn, outside the auto-memory directory.'

const workerFollowUp = `The worker asks the user its own questions through a dialog while it runs. If its report still ends with open questions for the user, do not answer them yourself and do not stop there: ask them with AskUserQuestion, then continue that same worker with SendMessage (its agent id or name; load SendMessage through ToolSearch if it is deferred), passing the answers verbatim, and wait for its new report.
When the worker returns, answer the user from its report: relay its result, its changes and what is left open, faithfully and briefly, adding nothing you have not verified.`

const workerLabel = ({ id, tier, description }: LastWorker): string =>
  `${tier} worker ${id}${description === '' ? '' : ` ("${description}")`}`

const spawnNote = (tier: Tier, by: string): string => `${MARK_OPEN}
The model-balance router rated this request ${tier.toUpperCase()} difficulty (${by}).
Do not do the work yourself and do not read files first. ${NO_EDITS} Call the Agent tool once with subagent_type "${workerType(tier)}", a short description, and a prompt that briefs a colleague who has not seen this conversation, under these headings:
## Request: the user's request in full, in their own words where the wording matters.
## Context: what this conversation has settled that bears on it: decisions, constraints, the user's preferences and corrections, what was tried and failed, earlier results it builds on.
## Pointers: files, routes, symbols, commands or URLs already known.
## Done when: what the user will check.
Write it from the whole conversation, a summary of earlier parts included, and leave out what does not bear on the task. The router adds the earlier workers' reports, the latest messages verbatim and the memory index itself, so do not paste those.
${workerFollowUp} Only if the worker failed or the report shows the task is clearly not ${tier}-level may you retry once with another model-balance worker type.
${MARK_CLOSE}`

const continueNote = (worker: LastWorker, by: string): string => `${MARK_OPEN}
The model-balance router judged this request a continuation of the task the ${workerLabel(worker)} ${worker.isActive ? 'is doing' : 'did'} (${by}).
Do not do the work yourself and do not spawn a new worker. ${NO_EDITS} Send the request to that worker with SendMessage (to: "${worker.id}"; load SendMessage through ToolSearch if it is deferred): the user's words, with every detail it needs, and what changed in this conversation since its last report (decisions, answers, other work done). ${worker.isActive ? 'It is still running and takes the message as a course correction.' : 'It resumes with its full history and model.'}
${workerFollowUp}
${MARK_CLOSE}`

const waitNote = (worker: LastWorker): string => `${MARK_OPEN}
The ${workerLabel(worker)} is still running, and the model-balance router judged this request a new task. Two workers must not edit the same working tree at once.
Do not do the work yourself and do not spawn a worker: the spawn is refused. ${NO_EDITS} Tell the user in one or two sentences that this request waits until that worker finishes: they can send it again then, or prefix it with #main to have the main conversation do it now.
${MARK_CLOSE}`

const toggleRef = { plugin: 'model-balance', key: 'toggle' } as const

const mainContextAtom = atom({ plugin: 'model-balance', key: 'mainContext' } as const, null)
const agentsAtom = atom({ plugin: 'model-balance', key: 'agents' } as const, [])
const reportsAtom = atom({ plugin: 'model-balance', key: 'reports' } as const, [])
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

/** Wide enough for `model-balance · main`, so terminal rows line their figures up in one column. */
const TERMINAL_LABEL_WIDTH = 22

const STATUS_MARK: Readonly<Record<AgentRow['status'], { glyph: string; color: string }>> = {
  running: { glyph: '▶', color: 'claude' },
  done: { glyph: '✓', color: 'success' },
  failed: { glyph: '✗', color: 'error' },
  stopped: { glyph: '■', color: 'warning' },
}

const statusText = (isOn: boolean): string => (isOn ? 'model-balance: on' : 'model-balance: off')

const readDefault = async ($: EngineInterface): Promise<boolean> =>
  readDefaultToggle(await $.store.get(DEFAULT_TOGGLE_KEY))

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

/** Sets `key` as the newest entry and drops the oldest past `max`. */
const rememberLatest = <V,>(entries: Map<string, V>, key: string, value: V, max: number): void => {
  entries.delete(key)
  entries.set(key, value)
  if (entries.size > max) entries.delete(entries.keys().next().value!)
}

/**
 * Whether routing is on for this session: its own `/model-balance on|off`, else the default as it
 * stood when the session first asked, so another window's `default` change never flips it.
 *
 * `$.state` holds the live answer and no other session writes it. `$.store` is one file every
 * session and worktree shares; it only carries a session's choice across a resume.
 */
const isEnabled = async ($: EngineInterface): Promise<boolean> => {
  const sessionId = await $.session.id()
  const { value: held } = await $.state.get(toggleRef)
  if (held?.sessionId === sessionId) return held.enabled

  const enabled = readSavedToggle(await $.store.get(sessionToggleKey(sessionId)))?.enabled ?? (await readDefault($))
  const toggle: SessionToggle = { sessionId, enabled }
  await $.state.set(toggleRef, toggle)
  // Reached on a new session id (/clear, /resume in the same process) as well as at start.
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

const pruneSavedToggles = async ($: EngineInterface): Promise<void> => {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (isStaleSessionToggle(key, await $.store.get(key), now)) await $.store.delete(key)
  }
}

const lastWorkerBlock = (worker: LastWorker): string =>
  `<last_worker status="${worker.isActive ? 'running' : 'finished'}">\nDescription: ${worker.description}\nTask: ${worker.task.slice(0, LAST_TASK_CHARS)}\n</last_worker>\n\n`

/**
 * Rates the request with the configured router model, the other one standing in when it fails or is
 * blocked; without either verdict the heuristic rates difficulty alone and never assumes a follow-up.
 */
const classify = async (
  $: EngineInterface,
  text: string,
  last: LastWorker | undefined,
  routerModel: RouterModel,
): Promise<Verdict> => {
  const recent = excerptOf((await $.session.messages()).slice(-6)).slice(-4000)
  const prompt = `${recent === '' ? '' : `Recent conversation:\n${recent}\n\n`}${last === undefined ? '' : lastWorkerBlock(last)}Request to rate:\n${text.slice(0, 6000)}`

  for (const model of routerChain(routerModel)) {
    try {
      const reply = await $.model.complete({
        model,
        system: CLASSIFIER_SYSTEM,
        prompt,
        maxTokens: 16,
        effort: 'low',
        timeoutMs: model === routerModel ? 8000 : 5000,
      })
      const route = reply.isAnswered ? parseVerdict(reply.text) : undefined
      if (route !== undefined && reply.isAnswered) {
        return {
          route,
          by: `${model} router`,
          isContinuation: route !== 'main' && last !== undefined && isContinuationReply(reply.text),
        }
      }
    } catch {
      // A model the allowlist blocks rejects instead of answering; the next router stands in.
    }
  }

  return { route: guessTier(text), by: 'heuristic', isContinuation: false }
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

/**
 * Puts a started subagent on the board, and a worker in `workers`; a resumed one starts its clock again.
 * Never fails the spawn.
 */
async function trackSpawn(
  $: EngineInterface,
  workers: Map<string, Tier>,
  e: AgentSpawnInput,
  started: AgentSpawnResult,
  tier: Tier | undefined,
): Promise<void> {
  const agentId = started.agentId
  if (agentId === undefined || started.deny !== undefined) return
  if (tier !== undefined) workers.set(agentId, tier)
  try {
    const now = await $.clock.now()
    const window = contextWindowOf(started.model, await readWindowEnv($))
    await update($, agentsAtom, rows => {
      const known = rows.find(row => row.id === agentId)
      const row: AgentRow = {
        id: agentId,
        type: e.subagentType,
        ...(tier === undefined ? {} : { tier }),
        description: known?.description ?? e.description,
        status: 'running',
        startedAt: now,
        model: started.model,
        window,
      }

      return upsertAgent(rows, row, BOARD_AGENTS)
    })
  } catch {
    // The board misses this run; the spawn itself is unaffected.
  }
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
  const routerModel = readRouterModel(options.router_model)
  const workerEffort = Object.fromEntries(
    TIERS.map(tier => [tier, readWorkerEffort(options[`${tier}_effort`], tier)]),
  ) as Record<Tier, WorkerEffort>
  /** Worker runs this module started, by agent id; lost on a reload, which only costs a lookup in the agent list. */
  const workers = new Map<string, Tier>()
  /** The latest top-level worker this module started; lost on a reload, when the agent list's last one stands in. */
  let lastWorkerId: string | undefined
  /**
   * Each worker's handoff as main wrote it, by agent id, for the classifier to judge a follow-up against;
   * the agent list carries only a short description. Lost on a reload: the description alone stands in.
   */
  const workerTasks = new Map<string, string>()

  on('session.start', async ($, e, next) => {
    for (const tier of TIERS) {
      const effort = workerEffort[tier]
      await $.agent.register({
        name: `${tier}-worker`,
        description: `Worker for ${tier}-level tasks. Use only when a model-balance routing note names this type.`,
        prompt: workerPrompt(tier),
        model: tier,
        // docs/sub-agents: frontmatter `effort` overrides the session's level; `session` leaves it to Claude Code.
        ...(effort === 'session' ? {} : { effort }),
        disallowedTools: ['Agent'],
      })
    }
    await $.tool.register({
      name: ASK_TOOL,
      description:
        'For model-balance workers only: asks the user 1-4 questions together in one AskUserQuestion dialog and returns the answers. Use it when a decision only the user can make blocks the task; then continue the task with the answers.',
      inputSchema: ASK_TOOL_SCHEMA,
      isDeferred: false,
    })
    await $.command.register({
      name: 'model-balance',
      description: 'Route prompts to Haiku/Sonnet/Opus workers by difficulty',
      argumentHint: '[on|off|status|context|panel|default on|off]',
      immediate: true,
    })
    $.ui.status(statusText(await isEnabled($)))
    try {
      const { context } = await $.session.usage()
      await update($, mainContextAtom, () => ({ tokens: context.tokens, window: context.window, percent: context.percent }))
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

  on('command.run', { command: 'model-balance' }, async ($, e) => {
    const onOff = (isOn: boolean): string => (isOn ? 'on' : 'off')
    const command = readToggleCommand(e.args)

    if (command.scope === 'session') {
      await setEnabled($, command.enabled)

      return {
        text: `model-balance is ${onOff(command.enabled)} for this session; other sessions keep their own setting.`,
      }
    }
    if (command.scope === 'default') {
      await $.store.set(DEFAULT_TOGGLE_KEY, command.enabled)

      return {
        text: `New sessions now start with model-balance ${onOff(command.enabled)}. This session stays ${onOff(await isEnabled($))}.`,
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
          label: `${agent.type}${agent.description === '' ? '' : ` · ${agent.description}`}`,
          ...(row?.contextTokens === undefined ? {} : { tokens: row.contextTokens }),
          window: row?.window ?? contextWindowOf(agent.type, windowEnv),
          note: agent.status,
        }
      })

      return { text: formatContextReport(main, agents) }
    }

    const main = await $.session.model()
    const efforts = TIERS.map(tier => `${tier} ${workerEffort[tier]}`).join(' · ')
    const usage = 'Use /model-balance on|off for this session, /model-balance default on|off for new sessions, /model-balance context for every context window, /model-balance panel to open or close the board.'

    return {
      text: `${command.isUnknown ? `Unknown argument "${e.args.trim()}". ` : ''}model-balance is ${onOff(await isEnabled($))} for this session (new sessions start ${onOff(await readDefault($))}). Main model: ${main}. Router: ${routerModel}. Worker effort: ${efforts} (never above xhigh). ${usage} Prefix a prompt with #haiku, #sonnet or #opus to force a worker, or #main to skip routing.`,
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!ROUTED_ORIGINS.has(e.origin.kind) || !(await isEnabled($))) return next(e)

    const { override, rest } = readOverride(e.text)
    if (override === 'main') {
      $.ui.status('model-balance → main (#main)')

      return next({ ...e, text: rest })
    }
    if (override === undefined && !isWorthRouting(e.text)) return next(e)

    const text = override === undefined ? e.text : rest
    const agents = await $.agent.list()
    const lastAgent = pickLastWorker(agents, lastWorkerId)
    const last = lastAgent === undefined ? undefined : toLastWorker(lastAgent, workerTasks.get(lastAgent.id))
    const runningAgent = agents.find(agent => isTopLevelWorker(agent) && isActiveStatus(agent.status))
    const running = runningAgent === undefined ? undefined : toLastWorker(runningAgent, workerTasks.get(runningAgent.id))
    // An explicit #tier asks for a fresh worker, so only the classifier's own verdict continues one.
    const verdict: Verdict =
      override === undefined
        ? await classify($, text, last, routerModel)
        : { route: override, by: 'override', isContinuation: false }

    // Answerable from the conversation itself: main answers, with no note and no worker.
    if (verdict.route === 'main') {
      $.ui.status(`model-balance → main (${verdict.by})`)

      return next({ ...e, text })
    }
    const tier = verdict.route

    const note = (() => {
      if (verdict.isContinuation && last !== undefined && (running === undefined || running.id === last.id)) {
        $.ui.status(`model-balance → continue ${last.tier} worker (${verdict.by})`)
        return continueNote(last, verdict.by)
      }
      if (running !== undefined) {
        $.ui.status(`model-balance → on hold: ${running.tier} worker still running`)
        return waitNote(running)
      }
      $.ui.status(`model-balance → ${tier} (${verdict.by})`)
      return spawnNote(tier, verdict.by)
    })()

    return next({ ...e, text, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => {
    // The router failing must never cost the person their prompt: it goes to main as typed. This build types
    // `kind` without `re-entry`, which the docs still list for a skipped re-entrant dispatch.
    if ((next.error.kind as string) !== 're-entry') $.ui.status('model-balance → main (router failed)')

    return next(e)
  })

  /**
   * One top-level worker writes at a time: a second spawn while one runs is refused, whoever asks for it.
   * A worker starts from main's handoff with the session's record beside it; every other subagent passes
   * untouched and only goes on the board.
   */
  on('agent.spawn', async ($, e, next) => {
    const tier = tierOfWorker(e.subagentType)
    if (tier === undefined || e.fork || e.parentAgentId !== undefined || e.resume !== undefined) {
      const started = await next(e)
      await trackSpawn($, workers, e, started, tier)

      return started
    }

    const running = (await $.agent.list()).find(agent => isTopLevelWorker(agent) && isActiveStatus(agent.status))
    if (running !== undefined) {
      return {
        deny: `A model-balance worker (${running.id}) is still running; two workers must not edit the same working tree at once. Tell the user this request waits until it finishes, or continue that worker with SendMessage if the request belongs to its task.`,
      }
    }

    const earlier = formatReports(await read($, reportsAtom), REPORTS_IN_PROMPT)
    const excerpt = excerptOf(await $.session.messages())
    const memory = await readMemoryIndex($)
    // Long material first and the task last, as docs/long-context-tips lays out a prompt.
    const prompt = [
      memory === undefined ? '' : `<auto_memory dir="${directoryOf(memory.path)}">\n${memory.text}\n</auto_memory>`,
      excerpt === '' ? '' : `<recent_messages>\n${excerpt}\n</recent_messages>`,
      earlier === '' ? '' : `<earlier_workers>\n${earlier}\n</earlier_workers>`,
      `<handoff>\n${e.prompt}\n</handoff>`,
    ]
      .filter(part => part !== '')
      .join('\n\n')
    const started = await next({ ...e, prompt, model: tier })
    if (started.agentId !== undefined && started.deny === undefined) {
      lastWorkerId = started.agentId
      rememberLatest(workerTasks, started.agentId, e.prompt, BOARD_AGENTS)
      await trackSpawn($, workers, e, started, tier)
      $.ui.status(`model-balance ▶ ${tier} worker: ${e.description}`)
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
   * opens the person's dialog for a worker, all its questions at once, and waits.
   */
  on('tool.call', { tool: 'mcp__model-balance__ask_user' }, async ($, e) => {
    const tier = e.agentId === undefined ? undefined : await workerTier($, workers, e.agentId)
    if (tier === undefined) {
      return { deny: `${ASK_TOOL_NAME} is for model-balance workers; ask with AskUserQuestion instead.` }
    }

    const questions = readQuestions(e.questions)
    if (typeof questions === 'string') return { deny: questions }

    const shown = questions.map(one => ({ ...one, question: `(${tier} worker) ${one.question}` }))
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

  /** A run of a subagent begins: a resume through SendMessage, which raises no spawn, starts its clock again. */
  on('turn.start', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId !== undefined) {
      try {
        const now = await $.clock.now()
        const rows = await read($, agentsAtom)
        const known = rows.find(row => row.id === agentId)
        const agent = known === undefined ? (await $.agent.list()).find(one => one.id === agentId) : undefined
        const windowEnv = known === undefined ? await readWindowEnv($) : undefined
        await update($, agentsAtom, list => {
          if (list.some(one => one.id === agentId)) return restartAgent(list, agentId, now)
          if (agent === undefined || windowEnv === undefined) return list
          const tier = tierOfWorker(agent.type)

          return upsertAgent(
            list,
            {
              id: agentId,
              type: agent.type,
              ...(tier === undefined ? {} : { tier }),
              description: agent.description,
              status: 'running',
              startedAt: now,
              window: contextWindowOf(tier ?? agent.type, windowEnv),
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
   * Every subagent request is held below `max`, the person's ceiling for subagents, and its usage puts the
   * agent's context fill and effort on the board.
   */
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) return yield* next(e)

    const capped = cappedSubagentEffort(e.effort)
    const effort = capped ?? e.effort
    const step = yield* next(capped === undefined ? e : { ...e, effort: capped })
    const agentId = e.agentId
    const usage = step.usage
    if (usage !== null) {
      try {
        const row = (await read($, agentsAtom)).find(one => one.id === agentId)
        if (row !== undefined) {
          const model = row.model ?? usage.model
          const window = row.model === undefined ? contextWindowOf(model, await readWindowEnv($)) : row.window
          await update($, agentsAtom, rows =>
            patchAgent(rows, agentId, {
              contextTokens: contextTokensOf(usage),
              model,
              window,
              ...(effort === undefined ? {} : { effort: String(effort) }),
            }),
          )
        }
      } catch {
        // The board keeps the previous figures; the step itself is done.
      }
    }

    return step
  })

  /** A subagent's run ended: its row closes, and a worker's report joins the session's record. */
  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId !== undefined) {
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

        if (tier !== undefined) {
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
          $.ui.toast(`model-balance: ${tier} worker ${status === 'done' ? 'finished' : status} in ${seconds}${context}${output}`)
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
      await update($, mainContextAtom, () => ({
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
