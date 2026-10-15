import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnStepInput, TurnUsage } from 'claude-code'

import {
  ASK_TOOL,
  ASK_TOOL_SCHEMA,
  DEFAULT_TOGGLE_KEY,
  MARK_CLOSE,
  MARK_OPEN,
  TIERS,
  contextBar,
  contextColor,
  contextFigures,
  contextTokensOf,
  clipMemoryIndex,
  contextWindowOf,
  directoryOf,
  excerptOf,
  formatAnswers,
  formatContextReport,
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
  percentOf,
  pickLastWorker,
  pushRun,
  readAnswers,
  readOverride,
  readQuestions,
  readSavedToggle,
  readToggleCommand,
  sessionToggleKey,
  tierOfWorker,
  workerType,
  type ContextLine,
  type Provider,
  type SavedToggle,
  type Tier,
  type WindowEnv,
  type WorkerCandidate,
} from './route'
import type { SessionToggle, WorkerRun } from '../types'

const ASK_TOOL_NAME = `mcp__model-balance__${ASK_TOOL}` as const

declare module 'claude-code' {
  interface McpToolInputs {
    /** Loose on purpose: `readQuestions` checks what the worker actually sent. */
    'mcp__model-balance__ask_user': { questions: unknown }
  }
}

type Verdict = { tier: Tier; by: 'override' | 'classifier' | 'heuristic'; isContinuation: boolean }

/** The latest top-level worker as the router reads it for a follow-up. */
type LastWorker = { id: string; tier: Tier; description: string; task: string; isActive: boolean }

/** Prompts a person sent; notifications, peers, schedules and other plugins pass untouched. */
const ROUTED_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

/** Main's tools that change files; refused to main on a routed turn so the worker does the editing. */
const MAIN_WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const

/** How much of the last worker's task the classifier reads to judge a follow-up. */
const LAST_TASK_CHARS = 1500

const CLASSIFIER_SYSTEM = `You rate how hard a coding-assistant request is, to pick the cheapest model that will do it well.
HAIKU: lookups, explanations of a known thing, renames, typos, formatting, small single-file edits, translations, summaries, commit messages.
SONNET: everyday engineering: features, bug fixes with a clear lead, tests, multi-file edits that follow existing patterns, code review.
OPUS: architecture and design decisions, unclear root causes, cross-cutting refactors or migrations, concurrency, security, performance, long multi-step plans.
When unsure between two, pick the higher.
When a <last_worker> block describes a task a worker is doing or did, also judge whether the request continues that task (a follow-up, a correction, more of the same, an answer to its question) or is a new task, and answer with two words: the level and CONTINUE or NEW, e.g. "SONNET NEW". Without that block answer with exactly one word: HAIKU, SONNET or OPUS.`

const workerPrompt = (tier: Tier): string => `You are the ${tier} worker of the model-balance router: it judged the task you are given to be of ${tier}-level difficulty.

Your input has up to three parts. <main_conversation_excerpt> quotes the latest messages of the user's main conversation, for context only: earlier decisions, constraints and what was already tried. <auto_memory> is the index of the user's auto memory, which the main conversation loads and you do not: one line per memory file in the directory it names. <task> is the work to do now.

Before you start, open with Read the memory files whose line touches your task, every feedback_ one among them, and follow them as the main conversation would. Leave writing memory to the main conversation: name anything worth remembering in your report.

Do the task completely with the tools you have, following the project's instructions.

When the work needs a decision only the user can make (a choice between approaches, a missing fact, an ambiguity the request, the code and the docs do not settle), ask it with the ${ASK_TOOL_NAME} tool: it opens the user's own AskUserQuestion dialog, waits for the answers and returns them, and you carry on with the task using them. Ask only what blocks the work, gather related questions into one call (up to 4), and never answer in the user's place. Do not end your run with a question in your final message expecting a reply: nobody replies to it. If the tool reports a question left unanswered, stop and list it under "Open questions" in your report. If something else blocks you, stop and say what.

Your final message is the only thing the main conversation receives, so make it a self-contained report: the outcome, the files you changed (paths), key findings or decisions, the questions you asked with the user's answers, and anything left open. Keep it under about 300 words unless the answer itself (code or text the user asked for) needs more. Write it in the language the user writes in.`

const NO_EDITS = 'Edit, Write and NotebookEdit are refused to you on this turn, outside the auto-memory directory.'

const workerFollowUp = `The worker asks the user its own questions through a dialog while it runs. If its report still ends with open questions for the user, do not answer them yourself and do not stop there: ask them with AskUserQuestion, then continue that same worker with SendMessage (its agent id or name; load SendMessage through ToolSearch if it is deferred), passing the answers verbatim, and wait for its new report.
When the worker returns, answer the user with its report: relay it faithfully and briefly, adding nothing you have not verified.`

const workerLabel = ({ id, tier, description }: LastWorker): string =>
  `${tier} worker ${id}${description === '' ? '' : ` ("${description}")`}`

const spawnNote = ({ tier, by }: Verdict): string => `${MARK_OPEN}
The model-balance router rated this request ${tier.toUpperCase()} difficulty (${by}).
Do not do the work yourself and do not read files first. ${NO_EDITS} Call the Agent tool once with subagent_type "${workerType(tier)}", a short description, and a prompt that restates the user's request with every detail from this conversation the worker needs; the router attaches the recent conversation to that prompt itself.
${workerFollowUp} Only if the worker failed or the report shows the task is clearly not ${tier}-level may you retry once with another model-balance worker type.
${MARK_CLOSE}`

const continueNote = (worker: LastWorker, by: Verdict['by']): string => `${MARK_OPEN}
The model-balance router judged this request a continuation of the task the ${workerLabel(worker)} ${worker.isActive ? 'is doing' : 'did'} (${by}).
Do not do the work yourself and do not spawn a new worker. ${NO_EDITS} Send the request to that worker with SendMessage (to: "${worker.id}"; load SendMessage through ToolSearch if it is deferred), restating the user's words with every detail from this conversation it needs. ${worker.isActive ? 'It is still running and takes the message as a course correction.' : 'It resumes with its full history and model.'}
${workerFollowUp}
${MARK_CLOSE}`

const waitNote = (worker: LastWorker): string => `${MARK_OPEN}
The ${workerLabel(worker)} is still running, and the model-balance router judged this request a new task. Two workers must not edit the same working tree at once.
Do not do the work yourself and do not spawn a worker: the spawn is refused. ${NO_EDITS} Tell the user in one or two sentences that this request waits until that worker finishes: they can send it again then, or prefix it with #main to have the main conversation do it now.
${MARK_CLOSE}`

const toggleRef = { plugin: 'model-balance', key: 'toggle' } as const

const mainContextAtom = atom({ plugin: 'model-balance', key: 'mainContext' } as const, null)
const workerRunsAtom = atom({ plugin: 'model-balance', key: 'workerRuns' } as const, [])

/** Finished worker runs the band lists, newest first. */
const BAND_RUNS = 3

/** Wide enough for `model-balance · main`, so terminal rows line their figures up in one column. */
const TERMINAL_LABEL_WIDTH = 20

/** Agents whose latest context is remembered for `/model-balance context`. */
const MAX_TRACKED_AGENTS = 50

const statusText = (isOn: boolean): string => (isOn ? 'model-balance: on' : 'model-balance: off')

const readDefault = async ($: EngineInterface): Promise<boolean> =>
  (await $.store.get(DEFAULT_TOGGLE_KEY)) !== false

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

/** Without a classifier verdict, a follow-up is never assumed: the heuristic only rates difficulty. */
const classify = async ($: EngineInterface, text: string, last: LastWorker | undefined): Promise<Verdict> => {
  try {
    const recent = excerptOf((await $.session.messages()).slice(-4)).slice(-3000)
    const reply = await $.model.complete({
      model: 'haiku',
      system: CLASSIFIER_SYSTEM,
      prompt: `${recent === '' ? '' : `Recent conversation:\n${recent}\n\n`}${last === undefined ? '' : lastWorkerBlock(last)}Request to rate:\n${text.slice(0, 6000)}`,
      maxTokens: 10,
      timeoutMs: 10_000,
    })
    const tier = reply.isAnswered ? parseVerdict(reply.text) : undefined
    if (tier !== undefined && reply.isAnswered) {
      return { tier, by: 'classifier', isContinuation: last !== undefined && isContinuationReply(reply.text) }
    }
  } catch {
    // A model the allowlist blocks rejects instead of answering; the heuristic stands in.
  }

  return { tier: guessTier(text), by: 'heuristic', isContinuation: false }
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

/** `task` is the worker's `<task>` as spawned, '' when this module did not see the spawn (a reload since). */
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

export const register: Register = on => {
  /** Worker runs this module started, by agent id; lost on a reload, which only drops their finish toast. */
  const workers = new Map<string, Tier>()
  /**
   * The effort of the main loop's latest request, which workers are sent with.
   * Empty after a reload until main sends its next request; workers keep their default meanwhile.
   */
  let mainEffort: TurnStepInput['effort']
  /**
   * Usage of every agent's latest request by agent id, oldest write first; its input side is that agent's
   * context at that moment. Kept after the agent finishes so `/model-balance context` can still list it.
   */
  const lastStepUsage = new Map<string, TurnUsage>()
  /**
   * The model each worker was started on, as core resolved it. Preferred over the API's reported id, which
   * drops a `[1m]` suffix the worker inherited from main. Lost on a reload; the reported id stands in then.
   */
  const spawnedModels = new Map<string, string>()
  /** The latest top-level worker this module started; lost on a reload, when the agent list's last one stands in. */
  let lastWorkerId: string | undefined
  /**
   * Each worker's task as main wrote it, by agent id, for the classifier to judge a follow-up against;
   * the agent list carries only a short description. Lost on a reload: the description alone stands in.
   */
  const workerTasks = new Map<string, string>()

  on('session.start', async ($, e, next) => {
    for (const tier of TIERS) {
      await $.agent.register({
        name: `${tier}-worker`,
        description: `Worker for ${tier}-level tasks. Use only when a model-balance routing note names this type.`,
        prompt: workerPrompt(tier),
        model: tier,
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
      argumentHint: '[on|off|status|context|default on|off]',
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

    if (command.scope === 'context') {
      const { context } = await $.session.usage()
      const main: ContextLine = {
        label: `main (${await $.session.model()})`,
        tokens: context.tokens,
        window: context.window,
      }
      const windowEnv = await readWindowEnv($)
      const agents: ContextLine[] = (await $.agent.list()).map(agent => {
        const usage = lastStepUsage.get(agent.id)
        const model = spawnedModels.get(agent.id) ?? usage?.model ?? agent.type

        return {
          label: `${agent.type}${agent.description === '' ? '' : ` · ${agent.description}`}`,
          tokens: usage === undefined ? undefined : contextTokensOf(usage),
          window: contextWindowOf(model, windowEnv),
          note: agent.status,
        }
      })

      return { text: formatContextReport(main, agents) }
    }

    const main = await $.session.model()
    const usage = 'Use /model-balance on|off for this session, /model-balance default on|off for new sessions, /model-balance context for every context window.'

    return {
      text: `${command.isUnknown ? `Unknown argument "${e.args.trim()}". ` : ''}model-balance is ${onOff(await isEnabled($))} for this session (new sessions start ${onOff(await readDefault($))}). Main model: ${main}. ${usage} Prefix a prompt with #haiku, #sonnet or #opus to force a worker, or #main to skip routing.`,
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
      override === undefined ? await classify($, text, last) : { tier: override, by: 'override', isContinuation: false }

    const note = (() => {
      if (verdict.isContinuation && last !== undefined && (running === undefined || running.id === last.id)) {
        $.ui.status(`model-balance → continue ${last.tier} worker (${verdict.by})`)
        return continueNote(last, verdict.by)
      }
      if (running !== undefined) {
        $.ui.status(`model-balance → on hold: ${running.tier} worker still running`)
        return waitNote(running)
      }
      $.ui.status(`model-balance → ${verdict.tier} (${verdict.by})`)
      return spawnNote(verdict)
    })()

    return next({ ...e, text, context: [...(e.context ?? []), note] })
  })

  /** One top-level worker writes at a time: a second spawn while one runs is refused, whoever asks for it. */
  on('agent.spawn', async ($, e, next) => {
    const tier = tierOfWorker(e.subagentType)
    if (tier === undefined || e.fork || e.parentAgentId !== undefined) return next(e)

    const running = (await $.agent.list()).find(agent => isTopLevelWorker(agent) && isActiveStatus(agent.status))
    if (running !== undefined) {
      return {
        deny: `A model-balance worker (${running.id}) is still running; two workers must not edit the same working tree at once. Tell the user this request waits until it finishes, or continue that worker with SendMessage if the request belongs to its task.`,
      }
    }

    const excerpt = excerptOf(await $.session.messages())
    const memory = await readMemoryIndex($)
    const prompt = [
      excerpt === '' ? '' : `<main_conversation_excerpt>\n${excerpt}\n</main_conversation_excerpt>`,
      memory === undefined ? '' : `<auto_memory dir="${directoryOf(memory.path)}">\n${memory.text}\n</auto_memory>`,
      `<task>\n${e.prompt}\n</task>`,
    ]
      .filter(part => part !== '')
      .join('\n\n')
    const started = await next({ ...e, prompt, model: tier })
    if (started.agentId !== undefined) {
      workers.set(started.agentId, tier)
      lastWorkerId = started.agentId
      rememberLatest(workerTasks, started.agentId, e.prompt, MAX_TRACKED_AGENTS)
      if (started.deny === undefined) rememberLatest(spawnedModels, started.agentId, started.model, MAX_TRACKED_AGENTS)
    }

    return started
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
  })

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
    deny: 'The question dialog could not be opened. Do not guess: stop, and list your questions under "Open questions" in your final report.',
  }))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      mainEffort = e.effort

      return yield* next(e)
    }

    const isWorker = mainEffort !== undefined && (await workerTier($, workers, e.agentId)) !== undefined
    const step = yield* next(isWorker ? { ...e, effort: mainEffort } : e)
    if (step.usage !== null) rememberLatest(lastStepUsage, e.agentId, step.usage, MAX_TRACKED_AGENTS)

    return step
  })

  on('turn.complete', async ($, e, next) => {
    const tier = e.agentId === undefined ? undefined : await workerTier($, workers, e.agentId)
    if (tier !== undefined && e.agentId !== undefined) {
      workers.delete(e.agentId)
      const last = lastStepUsage.get(e.agentId)

      const window = contextWindowOf(spawnedModels.get(e.agentId) ?? last?.model ?? e.usage?.model ?? tier, await readWindowEnv($))
      const run: WorkerRun = {
        tier,
        seconds: Math.round(e.durationMs / 1000),
        window,
        ...(last === undefined ? {} : { contextTokens: contextTokensOf(last) }),
        ...(e.usage === undefined ? {} : { outputTokens: e.usage.output_tokens }),
      }
      await update($, workerRunsAtom, runs => pushRun(runs, run, BAND_RUNS))

      const context =
        run.contextTokens === undefined
          ? ''
          : ` · context ${formatTokens(run.contextTokens)} (${percentOf(run.contextTokens, window)}%)`
      const output = run.outputTokens === undefined ? '' : ` · out ${formatTokens(run.outputTokens)}`
      $.ui.toast(`model-balance: ${tier} worker finished in ${run.seconds}s${context}${output}`)
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const toggle = await read($, toggleRef)
    if (e.props.hasSurvey || toggle?.enabled !== true) return next(e)

    const main = await read($, mainContextAtom)
    const runs = await read($, workerRunsAtom)
    if (main === null && runs.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const mainPercent = main?.percent ?? (main?.tokens === undefined ? undefined : percentOf(main.tokens, main.window))
    // The terminal gets the figures alone, labels in one column; other surfaces keep the bar.
    const isTerminal = e.surface === 'terminal'
    const figures = (tokens: number, window: number, percent: number): string =>
      `${isTerminal ? '' : `${contextBar(percent)} `}${contextFigures(tokens, window, percent)}`
    const label = (text: string, width: number): string => (isTerminal ? text.padEnd(TERMINAL_LABEL_WIDTH) : text.padEnd(width))

    return (
      <Box flexDirection="column">
        {main === null ? null : (
          <Box key="main" gap={1}>
            <Text dimColor>{label('model-balance · main', 0)}</Text>
            {mainPercent === undefined || main.tokens === undefined ? (
              <Text dimColor>context —</Text>
            ) : (
              <Text color={contextColor(mainPercent)}>{figures(main.tokens, main.window, mainPercent)}</Text>
            )}
          </Box>
        )}
        {runs.map((run, index) => {
          const percent = run.contextTokens === undefined ? undefined : percentOf(run.contextTokens, run.window)

          return (
            <Box key={`run-${index}`} gap={1}>
              <Text dimColor>{label(`  ${run.tier} worker`, 16)}</Text>
              {percent === undefined || run.contextTokens === undefined ? (
                <Text dimColor>context —</Text>
              ) : (
                <Text color={contextColor(percent)}>{figures(run.contextTokens, run.window, percent)}</Text>
              )}
              <Text dimColor>
                · {run.seconds}s{run.outputTokens === undefined ? '' : ` · out ${formatTokens(run.outputTokens)}`}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
