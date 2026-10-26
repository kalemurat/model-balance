# model-balance

A Claude Code plugin that routes each prompt either to the main conversation or to a Haiku, Sonnet or Opus worker subagent, chosen by the prompt's difficulty. A routed prompt is not answered by the main model itself; it hands it to a worker, whatever model the main conversation runs on.

## What it does

- **Rates each prompt.** A router call (Sonnet by default, Haiku if you choose it) rates the prompt as MAIN, HAIKU, SONNET or OPUS. MAIN is a prompt the conversation can answer as it stands, with nothing to read or change (a question about the last answer, a summary, a choice): the main model answers it and no worker starts. A `#haiku`, `#sonnet` or `#opus` prefix skips the router and uses the tier you name; `#main` skips routing.
- **Hands the prompt to a worker with a brief.** The main model spawns a `haiku-worker`, `sonnet-worker` or `opus-worker` subagent and writes its prompt as a brief under fixed headings (Request, Context, Pointers, Done when) from the whole conversation. The plugin adds the reports of the workers that ran earlier in the session, the latest messages verbatim and the auto-memory index.
- **Keeps a record of the session's work.** Each worker reports back under fixed headings (Result, Changes, Decisions & findings, Questions, Open, Remember). The main model relays the report, and the plugin keeps it for the workers after it.
- **Continues the last worker for follow-ups.** A follow-up such as "continue" or "try the second option" goes back to the same worker through SendMessage instead of starting a new one.
- **Keeps one top-level worker at a time.** A new task waits while a worker is still running.
- **Runs each tier at its own effort, never at max.** Each worker type carries an effort level in its agent definition (Haiku `medium`, Sonnet `high`, Opus `xhigh` by default; configurable). Every subagent request that would run at `max` runs at `xhigh` instead.
- **Refuses main's own file edits on a routed turn.** `Edit`, `Write` and `NotebookEdit` are denied on a routed turn so that the worker does the work.
- **Lets workers ask blocking questions.** A worker can call `mcp__model-balance__ask_user`, which opens one AskUserQuestion dialog with up to four questions and returns the answers to the worker.
- **Shows a board of the subagents.** It shows the main conversation's context fill, every running subagent with its elapsed time, context fill, effort and task, and the finished ones behind a button that shows or hides them. In the terminal and the desktop app the board sits in the band above the prompt; in VS Code, which draws no band, it opens in a pane when a worker starts, and the status line names the running worker.

Routing applies to prompts typed by a person (composer, bridge and SDK origins). Notifications, peer messages, scheduled runs and other plugins' prompts pass through untouched. Prompts shorter than 16 characters and prompts starting with `/` are not routed.

## What it reads and sends

Everything the plugin does goes through Claude Code's own engine API; it opens no network connection, runs no process and writes no file of its own.

- **Router call.** One model request per routed prompt at `low` effort, to the router model (`sonnet` by default; `haiku` stands in when it fails, and the other way round), sent to the same provider the session uses (Anthropic API, Bedrock, Vertex or Foundry). It carries the prompt text (first 6,000 characters), an excerpt of the last six messages (last 4,000 characters) and, when a worker exists, the first 1,500 characters of that worker's brief.
- **Worker input.** Each worker is a subagent started through the Agent tool. Its prompt carries, in this order: the first 200 lines or 25 KB of the auto-memory `MEMORY.md`; the latest messages of the main conversation (up to 12 messages, 1,500 characters for the user's and 700 for the main model's, 14,000 in total, tool results excluded); the reports of up to four earlier workers of this session (2,500 characters each); and the main model's brief. The worker reads memory files from that directory with Read.
- **Files.** The plugin reads `MEMORY.md` at the path the engine reports for the session's auto memory. It writes nothing to disk itself; its state lives in the engine's `$.state` (this session: the board and the workers' reports, reset by `/clear` and `/resume`) and `$.store` (the per-session on/off choices and the default for new sessions).
- **Environment.** It reads `CLAUDE_CODE_USE_*`, `CLAUDE_CODE_DISABLE_1M_CONTEXT` and `ANTHROPIC_DEFAULT_*_MODEL` to size context windows, and sets nothing.

## How it hooks into Claude Code

The plugin is a mod: a hooks module that registers on engine events. This is every hook and what it does, so the behaviour is visible before installing.

| Hook | What it does |
| --- | --- |
| `session.start` | Registers the three worker agent types (`model-balance:haiku-worker`, `sonnet-worker`, `opus-worker`) with their models and effort levels, the `mcp__model-balance__ask_user` tool and the `/model-balance` command. |
| `command.run` for `/model-balance` | Answers the command itself: switches routing for this session or the default, opens or closes the board's pane, or prints the status or context report. |
| `prompt.submit` | On a human-typed prompt while routing is on: strips a `#tier` prefix and, unless the router answers MAIN, attaches a routing note to the model's context. The prompt text is otherwise passed on as typed; nothing is dropped. |
| `agent.spawn` | For a worker type: adds the earlier workers' reports, the latest messages and the memory index to the main model's brief, and sets the worker's model to the tier's alias; refuses a second top-level worker while one is still running. Every spawn, of any agent type, is also put on the board; spawns of other agent types pass through unchanged. |
| `tool.call` for `Edit`, `Write`, `NotebookEdit` | Refuses these to the main conversation on a routed turn, except inside the auto-memory directory, so the worker does the editing. The user bypasses this with `#main`. Subagents' calls pass through unchanged. |
| `tool.call` for `mcp__model-balance__ask_user` | Implements the plugin's own tool: when a worker calls it, the plugin calls `AskUserQuestion` on the worker's behalf (subagents cannot call it themselves), waits for the dialog and returns the answers as the tool result. This is the only tool the plugin calls itself, and only in answer to a worker's call. |
| `turn.start` | Starts a subagent's clock on the board, again when SendMessage resumes it. |
| `turn.step` | Lowers a subagent request's effort from `max` to `xhigh`, whoever asked for `max`; records each subagent's context fill, model and effort for the board. The main conversation's requests pass unchanged. |
| `turn.complete`, `session.measure` | Close a subagent's row on the board and keep a worker's report for later workers; record the main conversation's context fill; show a toast when a worker finishes. |
| `ui.close` | Remembers for the session that the person closed the board's pane, so it does not open again by itself. |
| `ui.render` for `AbovePrompt` and the `model-balance` pane | Draws the board: in the band above the prompt while routing is on (terminal and desktop app), and in the pane (VS Code, or wherever `/model-balance panel` opens it). |

It never changes permission modes, permission decisions, settings, Remote Control or the system prompt, and it does not read or send any credential. The environment variables it reads (`CLAUDE_CODE_USE_*`, `CLAUDE_CODE_DISABLE_1M_CONTEXT`, `ANTHROPIC_DEFAULT_*_MODEL`) hold provider switches and model names, not secrets.

## Requirements

- Claude Code v2.1.290 or later. The plugin is a mod (a hooks module with `$.state`), which older releases do not load.
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

Routing starts **off** on a fresh install. Turn it on for the current session with `/model-balance on`, or for every new session with `/model-balance default on`. Each session keeps its own setting:

| Command | Effect |
| --- | --- |
| `/model-balance on` | Turn routing on for this session |
| `/model-balance off` | Turn routing off for this session |
| `/model-balance status` | Show whether routing is on, the router model and each worker's effort |
| `/model-balance context` | Show the context report |
| `/model-balance panel` | Open or close the board's pane |
| `/model-balance default on` / `default off` | Set the default for new sessions |

On the board, press **▸ Finished** to show the finished subagents and **▾ Hide finished** to hide them again: click it, or in the terminal press ctrl+x tab to focus the band, then Enter. Running subagents are always shown.

Prefix a prompt to choose the tier yourself:

| Prefix | Effect |
| --- | --- |
| `#haiku` | Route to a fresh Haiku worker |
| `#sonnet` | Route to a fresh Sonnet worker |
| `#opus` | Route to a fresh Opus worker |
| `#main` | Send the prompt to the main model without routing |

An explicit tier always starts a fresh worker. Only the router can decide that a prompt continues the last worker.

## Configuration

Four options appear as rows in `/config` (and in the plugin's configuration dialog):

| Option | Values | Default |
| --- | --- | --- |
| Router model (`router_model`) | `sonnet`, `haiku` | `sonnet` |
| Haiku worker effort (`haiku_effort`) | `low`, `medium`, `high`, `xhigh`, `session` | `medium` |
| Sonnet worker effort (`sonnet_effort`) | `low`, `medium`, `high`, `xhigh`, `session` | `high` |
| Opus worker effort (`opus_effort`) | `low`, `medium`, `high`, `xhigh`, `session` | `xhigh` |

A worker effort is set as the `effort` of its agent definition, which overrides the session's effort level as the subagent docs describe; `session` sets none and leaves the level to Claude Code. `CLAUDE_CODE_EFFORT_LEVEL` and an effort the main model passes to the Agent call still outrank it, but no subagent request runs above `xhigh`.

## Development

- `hooks/register.tsx` is the hooks module. `hooks/route.ts` holds the pure helpers (verdict parsing, tier parsing, override parsing, effort options, the board's rows, the workers' reports, context formatting).
- `types/index.d.ts` declares this plugin's `$.state` contract.
- `tests/route.test.ts` tests the helpers and `tests/board.test.tsx` draws the board on each surface. Run them with `claude plugin test .`.
- `claude plugin validate --strict .` checks the manifest, marketplace file and hooks module.
- The engine writes `.claude-plugin/types/` the first time the plugin loads. That folder is generated and is not committed; `tsconfig.json` extends it, so run `tsc -p .` only after the plugin has loaded once.

## Limitations

- Routing depends on the router's verdict. A wrong verdict sends the prompt to a tier that is too small or too large, or to the main model; use the `#tier` or `#main` prefix to override it.
- The router fails open. If one of its hooks fails (an engine call rejects, a time budget runs out), the prompt goes to the main model as typed and the status line says `router failed`; a worker whose preparation failed starts without the earlier reports, the latest messages and the memory index.
- The continuation check reads the last worker's brief. A long gap between follow-ups can make the router start a new worker instead.
- The workers' reports live in the session's state: `/clear` and `/resume` start the record afresh, and the main model's brief carries what came before.
- The `xhigh` ceiling holds for every subagent of the session, not only this plugin's workers.
- A pane opened without being asked waits in a narrow window; `/model-balance panel` opens it at any width.

## License

[MIT](LICENSE)
