# model-balance

A Claude Code plugin that spends fewer tokens on the same work. A router rates each prompt and picks the model and the effort it needs. The main conversation then either answers the prompt itself or hands it to a Haiku, Sonnet or Opus worker subagent pinned to that model and effort, whatever model the main conversation runs on. The main conversation stays short: the worker does the reading, running and editing, and only its report comes back.

## What it does

- **Rates each prompt for model and effort.** A router call rates the prompt as MAIN, HAIKU, SONNET or OPUS; for a worker it also picks the effort: LOW, MEDIUM, HIGH or XHIGH. The router is Sonnet at medium effort by default; you can choose Haiku.
  - MAIN is a prompt the conversation can answer as it stands, with nothing to read or change: a question about the last answer, a summary, a choice.
  - While the main conversation holds under 150k tokens, a change it finishes in one or two tool calls is MAIN too, because handing it over would cost more than doing it.
  - A `#haiku`, `#sonnet` or `#opus` prefix skips the router and uses the tier you name, with an optional effort (`#opus:high`). `#main` skips routing.
- **Hands the prompt to a worker with a brief.** The main model spawns a `haiku-worker`, `sonnet-worker` or `opus-worker` subagent. It writes the worker's prompt as a brief from the whole conversation, under fixed headings: Request, Context, Pointers, Done when.
  - The plugin adds the reports of earlier workers in the session, the latest messages verbatim and the auto-memory index.
  - Every request the worker makes runs on the tier's model at the effort the router picked.
- **Keeps a record of the session's work.** Each worker reports back under fixed headings: Result, Changes, Decisions & findings, Questions, Open, Remember. The main model relays the report without re-running its checks or re-reading the files it changed. The plugin keeps the report for the workers after it.
- **Continues the last worker for follow-ups.** A follow-up such as "continue" or "try the second option" goes back to the same worker through SendMessage, on the same model and effort, instead of starting a new one.
- **Keeps one top-level worker at a time.** A new task waits while a worker is still running.
- **Never runs a subagent at max.** Any subagent request that would run at `max` runs at `xhigh` instead.
- **Rates `/subtask` and forks too.** A `/subtask` you start and a fork the main model starts on its own are rated the same way.
  - Their effort is pinned to the rated one. A fork keeps sharing its prompt cache with the main conversation at any effort.
  - Their model changes only where the change pays for itself: up to a stronger model when the task needs it, and down to a cheaper one only while the main conversation holds at most 50k tokens. A new model has to write the whole conversation to its own cache again.
- **Refuses main's own file edits on a routed turn.** `Edit`, `Write` and `NotebookEdit` are denied on a routed turn so that the worker does the work.
- **Lets workers ask blocking questions.** A worker or a fork can call `mcp__model-balance__ask_user`. It opens one AskUserQuestion dialog with up to four questions and returns the answers.
- **Shows a board of the subagents.**
  - It shows the main conversation's context fill.
  - It lists every running subagent with its elapsed time, context fill, effort and task. A rated fork shows as `haiku fork`, `sonnet fork` and so on.
  - Finished subagents sit behind a button that shows or hides them.
  - In the terminal and the desktop app the board sits in the band above the prompt. VS Code draws no band, so there it opens in a pane when a worker starts, and the status line names the running worker.
- **Turns auto-compaction off while routing is on.** No conversation of the session compacts on its own, neither the main one nor any subagent.
  - Automatic and idle compaction are skipped; `/compact` keeps working.
  - Your `autoCompactEnabled` setting is not touched. With routing off, compaction behaves as you configured it.
- **Hands a long task over before a subagent's context fills.** When a subagent's context passes 65% of its window, it is asked to finish the step under way and end with a handoff report of what was done and everything that remains. The main model then starts a fresh agent on the same model and effort to continue the task; see [Context handoff](#context-handoff).
- **Starts off in every session.**
  - Routing is off when a session starts, after `/clear` too.
  - `/model-balance on` turns it on for that session alone; other sessions keep their own setting.
  - A session you resume keeps the choice it had.

**What gets routed.** Routing applies to prompts typed by a person (composer, bridge and SDK origins).
- Notifications, peer messages, scheduled runs and other plugins' prompts pass through untouched. The one exception: a background agent's notification that carries a handoff gets the main model's continuation note.
- Prompts shorter than 16 characters and prompts starting with `/` are not routed. `/subtask` is rated as a task instead.

## Token use

**What routing costs and saves.** Handing a task to a worker costs the main conversation two requests over its whole context: writing the brief, and relaying the report. It also costs the worker's own run. In return it saves every request the main model would otherwise make over its context while doing the task. Routing pays off for tasks with several steps, and more so the longer the main conversation gets.

**Measured run.** The setup was a multi-step task started from an 80k-token main conversation, with the main model on Opus at `xhigh`, on Claude Code 2.1.312.
- The routed task cost 23% less.
- The main conversation made 2 requests instead of 6.
- It read 163k tokens from its cache instead of 514k.

**Small changes.** A change of one or two tool calls costs more routed while the main conversation is small. That is why the router keeps those in main below 150k tokens.

**Forks.** A fork reads the main conversation from the prompt cache only while it stays on the main model; its effort can change without losing that. Routed tasks go to fresh workers, not forks: a fork would re-read the whole main conversation on every request.

**The router's own cost.** The router call costs about 1.5k input tokens per routed prompt. Claude Code leaves a plugin's model calls out of the session's cost total.

## Context handoff

1. **The request.**
   - **Which agents.** It applies to a subagent the main conversation started itself, a fork and a `/subtask` included. It does not apply to a teammate, a workflow agent or a subagent's own subagent.
   - **When.** After each request of such an agent, the plugin compares the request's input tokens with the agent's context window. Once the input passes 65%, and only while the agent's run goes on to a tool call, the plugin attaches the handoff request to that agent's next tool result, as a PostToolUse hook's context would.
   - **Why not SendMessage.** A message through SendMessage would need auto mode's approval, which a plugin's own message cannot get.
   - **Why the agent follows it.** Every agent started while routing is on is told in its prompt that this note comes from the router on the user's behalf, so it does not mistake the note for tool output.
   - **What the agent does.** It finishes the step it is in and starts nothing new. It then ends its run with a handoff report under fixed headings (Handoff, Task, Done, State, Remaining, Decisions & findings, Questions) and the line `[handoff: continue]`. If that step completed the whole task, it reports as usual and ends with `[handoff: complete]`. The usual length limit on a worker's report does not apply to a handoff.
2. **The note to main.**
   - **Where it comes from.** The agent's report comes back in its completion notification, or as the Agent tool's result for a foreground run. The plugin then attaches a note for the main model.
   - **What it asks.** The main model continues the task now, with one Agent call of the `subagent_type` the note names. It restates the task and carries the line `Continues: <agent id>`.
   - **Which type.** The note names the agent's own type. For a fork it names a fresh worker of its tier instead (`general-purpose` for a fork no router rated), since a new fork would carry the whole main conversation again.
   - **Routing switched off.** The note goes out even if routing was switched off in between, so a task cut at the threshold is never left half done.
3. **The continuation.**
   - **How it is recognised.** The plugin recognises the continuing spawn by that line, or, without it, as the one pending handoff of that agent type.
   - **How it runs.** It runs on the exact model the previous agent ran on. The whole handoff report, never clipped, goes ahead of the main model's brief, and every request of the new agent is held at the previous agent's effort.
   - **Again.** The new agent can hand off again in the same way.

A run that fails or is stopped after the request is not continued: the main model handles it as any failed run. A run resumed later is not asked again.

## What it reads and sends

Everything the plugin does goes through Claude Code's own engine API; it opens no network connection, runs no process and writes no file of its own.

- **Router call.** One model request per routed prompt.
  - **Settings.** It runs at `medium` effort (the `router_effort` option) on the router model. The router is `sonnet` by default; `haiku` stands in when it fails, and the other way round.
  - **Where it goes.** It is sent to the same provider the session uses: Anthropic API, Bedrock, Vertex or Foundry.
  - **What it carries.**
    - The prompt text (first 6,000 characters).
    - An excerpt of the last six messages (last 4,000 characters).
    - The main conversation's token count, while that count is under 150k.
    - When a worker exists, the first 1,500 characters of that worker's brief.
  - **`/subtask` and forks.** A `/subtask`, or a fork the main model starts, gets one such request too, over its task text and the same excerpt.
- **Worker input.** Each worker is a subagent started through the Agent tool. Its prompt carries, in this order:
  1. The first 200 lines or 25 KB of the auto-memory `MEMORY.md`.
  2. The latest messages of the main conversation: up to 12 messages, 1,500 characters for the user's and 700 for the main model's, 14,000 in total, tool results excluded.
  3. The reports of up to four earlier workers of this session, 2,500 characters each.
  4. For a continuation, the whole handoff report it continues.
  5. The main model's brief.

  The worker reads memory files from the memory directory with Read.
- **Agent notes.** While routing is on, a short note is appended to the prompt of a `/subtask`, of a fork the main model starts, and of any other subagent it spawns. The note says which model and effort the router pinned, if any, and that a handoff note may follow a tool result.
- **Handoff request.** One note per subagent that passes the handoff point, attached to one of that subagent's tool results. It carries the context figures and the handoff instructions, nothing from the conversation.
- **Files.** The plugin reads `MEMORY.md` at the path the engine reports for the session's auto memory. It writes nothing to disk itself.
  - **`$.state`.** Holds this session's board, model and effort pins, workers' reports and handoffs. `/clear` and `/resume` reset it.
  - **`$.store`.** Holds the per-session on/off choices. A default for new sessions that an earlier version kept there is deleted at start-up.
- **Environment.** It reads `CLAUDE_CODE_USE_*`, `CLAUDE_CODE_DISABLE_1M_CONTEXT` and `ANTHROPIC_DEFAULT_*_MODEL` to size context windows, and sets nothing.

## How it hooks into Claude Code

The plugin is a mod: a hooks module that registers on engine events. This is every hook and what it does, so the behaviour is visible before installing.

| Hook | What it does |
| --- | --- |
| `session.start` | Registers the three worker agent types (`model-balance:haiku-worker`, `sonnet-worker`, `opus-worker`) with their models and effort levels, the `mcp__model-balance__ask_user` tool and the `/model-balance` command. Deletes the default for new sessions an earlier version stored. |
| `command.run` for `/model-balance` | Answers the command itself: switches routing for this session, opens or closes the board's pane, or prints the status or context report. |
| `command.run` for `/subtask` | While routing is on, rates the task. Appends the agent note after the task's text, so the fork keeps the name Claude Code takes from the task's first words. Holds the model and effort for the fork's first turn. |
| `prompt.submit` | On a human-typed prompt while routing is on: strips a `#tier` prefix and, unless the router answers MAIN, attaches a routing note to the model's context. On a background agent's notification that carries a handoff: attaches the continuation note. Otherwise the prompt text is passed on as typed; nothing is dropped. |
| `agent.spawn` | **Worker types:** adds the earlier workers' reports, the latest messages and the memory index to the main model's brief, sets the model to the tier's alias and holds the effort the router picked. Refuses a second top-level worker while one is still running. **While routing is on:** rates and pins a fork the main model starts, and gives every other spawn the agent note. **Continuations:** a spawn that continues a handoff runs as the agent type the note named and on the previous agent's model, with the handoff report ahead of the brief. **Every spawn** goes on the board; with routing off, spawns of other agent types pass through unchanged. |
| `session.compact` for the `auto` and `precompute` triggers | While routing is on, skips the compaction, in the main conversation and in subagents. `/compact` and a plugin's compaction pass through. |
| `tool.call` for `Agent` | When a foreground subagent's result is a handoff, attaches the continuation note beside the result. Every other Agent call passes through unchanged. |
| `tool.call` for every tool | Attaches the handoff request to the next tool result of a subagent marked to hand off. Every other call passes through unchanged. |
| `tool.call` for `Edit`, `Write`, `NotebookEdit` | Refuses these to the main conversation on a routed turn, except inside the auto-memory directory, so the worker does the editing. The user bypasses this with `#main`. Subagents' calls pass through unchanged. |
| `tool.call` for `mcp__model-balance__ask_user` | Implements the plugin's own tool. When a worker or a fork calls it, the plugin calls `AskUserQuestion` on its behalf (subagents cannot call it themselves), waits for the dialog and returns the answers as the tool result. This is the only tool the plugin calls itself, and only in answer to an agent's call. |
| `turn.start` | Starts a subagent's clock on the board, again when SendMessage resumes it. Gives a new agent the model and effort held for it. Puts a `/subtask`'s fork on the board. |
| `turn.step` | Runs every subagent request on the model and at the effort pinned for it: the router's choice, or the previous agent's for a continuation. Lowers `max` to `xhigh` whoever asked for it. Records each subagent's context fill, model and effort for the board. Marks a subagent past 65% to hand off while routing is on. The main conversation's requests pass unchanged. |
| `turn.complete`, `session.measure` | `turn.complete`: closes a subagent's row on the board, keeps a worker's report for later workers, reads a handoff report for work remaining, and shows a toast when a worker finishes. `session.measure`: records the main conversation's context fill. |
| `ui.close` | Remembers for the session that the person closed the board's pane, so it does not open again by itself. |
| `ui.render` for `AbovePrompt` and the `model-balance` pane | Draws the board: in the band above the prompt while routing is on (terminal and desktop app), and in the pane (VS Code, or wherever `/model-balance panel` opens it). |

**What it never touches.**
- Permission modes and permission decisions.
- Settings: auto-compaction is skipped through the hook above, not by changing `autoCompactEnabled`.
- Remote Control and the system prompt.
- Credentials: it neither reads nor sends any.

The environment variables it reads (`CLAUDE_CODE_USE_*`, `CLAUDE_CODE_DISABLE_1M_CONTEXT`, `ANTHROPIC_DEFAULT_*_MODEL`) hold provider switches and model names, not secrets.

## Requirements

- Claude Code v2.1.290 or later; tested on v2.1.312. The plugin is a mod (a hooks module with `$.state`), which older releases do not load.
- For the board in VS Code, the Claude Code extension v2.1.299 or later.
- Model access for Haiku, Sonnet and Opus.
- A machine whose managed settings allow user-installed mods. Under `allowManagedModsOnly`, `allowManagedHooksOnly` or `disableAllHooks`, the plugin's hooks do not run.

## Installation

Add the marketplace and install the plugin in one command from a Claude Code session:

```
/plugin install model-balance --marketplace kalemurat/model-balance
```

Or from a terminal:

```
claude plugin marketplace add kalemurat/model-balance
claude plugin install model-balance@model-balance
```

## Usage

Routing is **off** whenever a session starts, `/clear` included. Turn it on for the current session with `/model-balance on`. Other sessions keep their own setting, and a session you resume keeps the choice it had.

| Command | Effect |
| --- | --- |
| `/model-balance on` | Turn routing on for this session |
| `/model-balance off` | Turn routing off for this session |
| `/model-balance status` | Show whether routing is on, the router model and effort, each worker's fallback effort, and the compaction and handoff rules |
| `/model-balance context` | Show the context report |
| `/model-balance panel` | Open or close the board's pane |

**The board.**
- To show the finished subagents, press **▸ Finished**; press **▾ Hide finished** to hide them again.
- Press the button by clicking it, or in the terminal by pressing ctrl+x tab to focus the band, then Enter.
- Running subagents are always shown.
- A subagent asked to hand off shows `handoff at 65%` on its row: the figure it was asked at.

Prefix a prompt to choose the tier, and optionally the effort, yourself:

| Prefix | Effect |
| --- | --- |
| `#haiku`, `#sonnet`, `#opus` | Route to a fresh worker of that tier, at the tier's effort option |
| `#opus:high`, `#sonnet:low`, … | Route to a fresh worker of that tier at that effort (`low`, `medium`, `high` or `xhigh`) |
| `#main` | Send the prompt to the main model without routing |

An explicit tier always starts a fresh worker. Only the router can decide that a prompt continues the last worker.

## Configuration

Five options appear as rows in `/config` (and in the plugin's configuration dialog):

| Option | Values | Default |
| --- | --- | --- |
| Router model (`router_model`) | `sonnet`, `haiku` | `sonnet` |
| Router effort (`router_effort`) | `low`, `medium`, `high` | `medium` |
| Haiku worker effort (`haiku_effort`) | `low`, `medium`, `high`, `xhigh`, `session` | `medium` |
| Sonnet worker effort (`sonnet_effort`) | `low`, `medium`, `high`, `xhigh`, `session` | `high` |
| Opus worker effort (`opus_effort`) | `low`, `medium`, `high`, `xhigh`, `session` | `xhigh` |

**How a worker's effort is chosen.**
- **The router's effort comes first.** The effort the router picks is set on each of the worker's requests, so it holds whatever else asks for another level.
- **The tier's option is the fallback.** When the router names no effort (a bare `#tier` prefix, or the heuristic after a router failure), the tier's option applies. It is set as the `effort` of the worker's agent definition and pinned the same way.
- **`session`.** This value sets none and leaves the level to Claude Code.
- **The ceiling.** No subagent request runs above `xhigh`.

## Development

- `hooks/register.tsx` is the hooks module.
- `hooks/route.ts` holds the pure helpers: verdict, effort and override parsing, effort options, fork model choice, pins, the board's rows, the workers' reports, handoffs and context formatting.
- `types/index.d.ts` declares this plugin's `$.state` contract.
- Tests, run with `claude plugin test .`:
  - `tests/route.test.ts` tests the helpers.
  - `tests/board.test.tsx` draws the board on each surface.
  - `tests/handoff.test.ts` drives the compaction skip and a handoff from the request to the continuation through the hooks.
  - `tests/routing.test.ts` drives routing, effort pinning, `/subtask` and forks, and the per-session switch.
- `claude plugin validate --strict .` checks the manifest, marketplace file and hooks module.
- The engine writes `.claude-plugin/types/` the first time the plugin loads. That folder is generated and is not committed. `tsconfig.json` extends it, so run `tsc -p .` only after the plugin has loaded once.

## Limitations

- **Routing depends on the router's verdict.** A wrong verdict sends the prompt to a tier or an effort that is too small or too large, or to the main model. Use the `#tier`, `#tier:effort` or `#main` prefix to override it.
- **The router fails open.** If one of its hooks fails (an engine call rejects, a time budget runs out):
  - the prompt goes to the main model as typed, and the status line says `router failed`;
  - a worker whose preparation failed starts without the earlier reports, the latest messages and the memory index;
  - a `/subtask` whose rating failed runs as Claude Code starts it.
- **The thresholds are estimates.** The limits that decide where a task runs come from measurements on one setup (Opus main conversation, Claude Code 2.1.312): 150k tokens of main context for keeping small changes in main, and 50k for moving a fork to a cheaper model.
- **The router's cost is not in `/cost`.** Its calls are not in the session's cost total, because Claude Code leaves a plugin's model calls out of it.
- **The continuation check reads the last worker's brief.** A long gap between follow-ups can make the router start a new worker instead.
- **The record resets.** The workers' reports live in the session's state, so `/clear` and `/resume` start the record afresh; the main model's brief carries what came before.
- **The `xhigh` ceiling holds for every subagent** of the session, not only this plugin's workers.
- **An unasked pane may wait.** A pane opened without being asked waits in a narrow window; `/model-balance panel` opens it at any width.
- **Compaction for over-long prompts is skipped too.** With auto-compaction off, the engine's compaction of a prompt grown too long for its window is skipped. The conversation stays as it is, with a line saying why, until you run `/compact` or `/model-balance off`. The same holds for a subagent that reaches its limit before it hands off.
- **The handoff point is fixed.** It is 65% of the window, measured against the documented model table, as the board's figures are.
- **A handoff depends on the subagent and the main model.**
  - The subagent has to follow the note.
  - The main model has to start the continuation. The plugin attaches the report and holds the model and effort itself, but it does not start the continuation on its own: the main model does, so that the new agent's report comes back to it.
- **Some agents are never asked to hand off.** Only a subagent the main conversation started itself is asked, a fork and a `/subtask` included. A teammate, a workflow agent or a subagent's own subagent is left to run as before.
- **Agents started while routing was off may ignore the note.** Such an agent was not told about the handoff note and may take it for tool output.

## License

[MIT](LICENSE)
