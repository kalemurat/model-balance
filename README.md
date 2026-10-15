# model-balance

A Claude Code plugin that routes each prompt to a Haiku, Sonnet or Opus worker subagent, chosen by the prompt's difficulty. The main model does not answer routed prompts itself; it hands them to a worker, whatever model the main conversation runs on.

## What it does

- **Classifies each prompt.** A Haiku call rates the prompt as HAIKU, SONNET or OPUS. A `#haiku`, `#sonnet` or `#opus` prefix skips the classifier and uses the tier you name.
- **Hands the prompt to a worker.** The main model spawns a `haiku-worker`, `sonnet-worker` or `opus-worker` subagent for the prompt. Each worker sees the recent conversation and the auto-memory index.
- **Continues the last worker for follow-ups.** A short follow-up such as "continue" or "one more thing" goes back to the same worker through SendMessage instead of starting a new one.
- **Keeps one top-level worker at a time.** A new task waits while a worker is still running.
- **Refuses main's own file edits on a routed turn.** `Edit`, `Write` and `NotebookEdit` are denied on a routed turn so that the worker does the work.
- **Lets workers ask blocking questions.** A worker can call `mcp__model-balance__ask_user`, which opens one AskUserQuestion dialog with up to four questions and returns the answers to the worker.
- **Shows context in a band above the prompt.** It shows the main conversation's context fill and the context size of the latest finished workers, refreshed after each turn.

Routing applies to prompts typed by a person (composer, bridge and SDK origins). Notifications, peer messages, scheduled runs and other plugins' prompts pass through untouched. Prompts shorter than 16 characters and prompts starting with `/` are not routed.

## Requirements

- Claude Code with plugin support.
- Model access for Haiku, Sonnet and Opus.

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

Routing is switched on and off per session. Use the `/model-balance` command:

| Command | Effect |
| --- | --- |
| `/model-balance on` | Turn routing on for this session |
| `/model-balance off` | Turn routing off for this session |
| `/model-balance status` | Show whether routing is on |
| `/model-balance context` | Show the context report |
| `/model-balance default on` / `default off` | Set the default for new sessions |

Prefix a prompt to choose the tier yourself:

| Prefix | Effect |
| --- | --- |
| `#haiku` | Route to a fresh Haiku worker |
| `#sonnet` | Route to a fresh Sonnet worker |
| `#opus` | Route to a fresh Opus worker |
| `#main` | Send the prompt to the main model without routing |

An explicit tier always starts a fresh worker. Only the classifier can decide that a prompt continues the last worker.

## Development

- `hooks/register.tsx` is the hooks module. `hooks/route.ts` holds the pure helpers (verdict parsing, tier parsing, override parsing, context formatting).
- `types/index.d.ts` declares this plugin's `$.state` contract.
- `tests/route.test.ts` tests the helpers. Run it with `claude plugin test .`.
- `claude plugin validate --strict .` checks the manifest, marketplace file and hooks module.
- The engine writes `.claude-plugin/types/` the first time the plugin loads. That folder is generated and is not committed; `tsconfig.json` extends it, so run `tsc -p .` only after the plugin has loaded once.

## Limitations

- Routing depends on the Haiku classifier. A wrong verdict sends the prompt to a tier that is too small or too large; use the `#tier` prefix to override it.
- The continuation check reads the last worker's task. A long gap between follow-ups can make the classifier start a new worker instead.

## License

[MIT](LICENSE)
