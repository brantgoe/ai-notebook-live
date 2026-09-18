# AI Notebook Live

> 🚧 **In development.** Early, pre-1.0, and still changing between releases.

**Claude writes, fixes and explains Jupyter cells in place — using your existing
Claude Code login, no API key required.**

The code appears in the cell, token by token, in the notebook you already have
open. Not in a side panel you copy out of, and not on disk behind a stale tab.

There is also a localhost bridge, so other AI tools on your machine can read
the open notebook and write cells into it. That is off by default.

📖 **[Read the handbook](https://brantgoe.github.io/ai-notebook-live/)** — install,
a first-cell walkthrough, the full settings and bridge reference, and a help page
organised by what went wrong.

> **What that means in practice.** Settings and the bridge API can still change
> between versions, so read the [changelog](CHANGELOG.md) before you upgrade. It
> is used daily by its author and has 131 tests behind it, but few other people
> have run it yet, so expect rough edges. Bug reports are welcome in
> [Issues](https://github.com/brantgoe/ai-notebook-live/issues); security problems
> go through
> [private vulnerability reporting](https://github.com/brantgoe/ai-notebook-live/security/advisories/new),
> not the issue tracker.

> Not affiliated with, endorsed by, or sponsored by Anthropic.
> Claude is a trademark of Anthropic, PBC.

## Why this rather than the alternatives

Most notebook AI tools either need an API key with billing attached, or write to
the `.ipynb` on disk — which does **not** show up in a notebook tab you already
have open, and gets overwritten the moment you save. Editing the live document
needs VS Code's `NotebookEdit` API, which is what this extension uses.

- **No API key needed.** If you have Claude Code installed and logged in, that
  is enough. A key is supported if you prefer one.
- **It reads your errors.** *Fix the Error* sends the cell and its traceback, so
  you do not have to explain what went wrong.
- **It writes where you are.** The notebook stays the artifact, and undo works.

## Install

1. Download the `.vsix` from [Releases](https://github.com/brantgoe/ai-notebook-live/releases).
2. In VS Code: **Extensions** view → the `...` menu at its top right → **Install
   from VSIX...** → pick the file you downloaded.

   Or, from a terminal you have already `cd`'d into the download folder:

   ```bash
   code --install-extension ai-notebook-live-<version>.vsix
   ```

   On a Mac the `code` command does not exist until you run **Shell Command:
   Install 'code' command in PATH** from the command palette, so the menu route
   above is the shorter one.
3. Reload the window.

You also need the **Jupyter** extension and a Python kernel to *run* cells;
without them the extension still writes cells, it just cannot execute them.

### Updating

Installs are manual, so nothing will prompt you. Grab the newer `.vsix` from
Releases and install it the same way — `--force` if the CLI complains — then
reload. Going **back** works the same way: install an older `.vsix` from
Releases and reload.
[CHANGELOG.md](CHANGELOG.md) says whether it is worth it.

## Setup

Open the **control panel** — `Ctrl+Shift+P` → `AI Notebook: Control Panel`, or
click the ✨ **AI** item in the status bar. It tells you which provider it
found and what will happen when a cell finishes.

Two ways to reach a model:

| | How | Cost |
|---|---|---|
| **Claude Code CLI** *(default)* | Install [Claude Code](https://claude.com/claude-code) and log in | Uses your existing plan |
| **Anthropic API** | `AI Notebook: Set Anthropic API Key` | Billed per token |

With `provider` on `auto` an API key wins — one you stored, **or one exported
as `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` in your shell**, which is easy
to forget you did and is billed per token. Set `provider` to `claude-cli` to
always use your Claude Code plan. Otherwise the CLI is used. If the
`claude` command is somewhere unusual, set `aiNotebookLive.claudePath` — the
error message offers to do it for you.

## Commands

| Command | Key | What it does |
|---|---|---|
| Generate Cell with AI… | `Ctrl+Alt+G` (`Cmd+Alt+G` on a Mac) | Describe a cell; it is written below the selection |
| Revise This Cell with AI… | `Ctrl+Alt+R` (`Cmd+Alt+R` on a Mac) | Rewrites the selected cell from your instruction |
| Fix the Error in This Cell | — | Sends the cell and its traceback, and rewrites it |
| Explain This Cell | — | Adds a markdown explanation *above* the cell |
| Control Panel | — | Provider, execution policy, bridge state |
| Cancel AI Generation | — | Stops the current stream, keeping what arrived |
| Set / Clear Anthropic API Key | — | Stored in VS Code's secret store, never in `settings.json` |
| Start / Stop Local Agent Bridge | — | The localhost endpoint for other tools |
| Copy Agent Bridge Example Command | — | A ready-to-run command, with no token in it |
| Show Log | — | What was sent where, and why a cell did or did not run |

*Revise* and *Explain* are also on the cell toolbar; *Fix the Error* appears
there once the cell has been run and has an error to fix.

**Don't like what it wrote? `Ctrl+Z`.** Everything the extension does to a cell
is an ordinary undoable edit.

## Whether generated code runs

Writing a cell and running a cell are separate decisions, and you own the second
one. Set it in the control panel, or directly:

| Setting | Default | Applies to |
|---|---|---|
| `aiNotebookLive.execution` | `ask` | Cells **you** asked Claude for |
| `aiNotebookLive.bridge.execution` | `never` | Cells **another program** pushed in |

Each is `never`, `ask` or `always`. `ask` shows the code and waits for you —
except on the bridge, where the HTTP caller is answered immediately (`pending`)
and the prompt appears afterwards, so an agent-pushed cell can run a few seconds
after it arrives. Nothing runs without you clicking.

An agent using the bridge may ask for its cell to be run, but cannot demand it:
a request can only ever lower this decision, never raise it. Nothing executes in
a workspace you have not trusted.

If you previously used `aiNotebookLive.autoRun`, it still works — `true` behaves
as `always`, `false` as `never`. Bridge execution is deliberately not inherited
from it; turn that on yourself if you want it.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `provider` | `auto` | `auto`, `api`, or `claude-cli` |
| `claudePath` | — | Absolute path to `claude`, if it is not found |
| `model` | `claude-opus-5` | Try `claude-sonnet-5` for faster, cheaper cells |
| `effort` | `medium` | Reasoning effort. API provider only |
| `maxTokens` | `8000` | Per cell. API provider only |
| `contextCells` | `12` | Preceding cells sent as context; `-1` for all |
| `includeOutputs` | `true` | Send cell outputs and tracebacks too — see [Privacy](#privacy). *Fix the Error* always sends the traceback |
| `execution` | `ask` | Whether generated code runs |
| `systemPromptExtra` | — | House style, e.g. *"Beginner class: keep code simple and comment every line"* |
| `refusalFallback` | `true` | Retry a declined request on a fallback model |
| `timeoutSeconds` | `300` | Give up after this long with **no output at all**. Measured from the last token, so a long think is not interrupted |
| `bridge.execution` | `never` | Whether agent-pushed code runs |
| `bridge.autoStart` | `false` | Start the bridge when a notebook opens |
| `bridge.port` | `37417` | `0` picks a free port |

`systemPromptExtra` is settable per-workspace, so a class or team folder can
carry its own house style. It is ignored in a workspace you have not trusted.
Settings that decide execution or open a socket can only be set per-machine, so
a repository you clone cannot change them.

## The agent bridge

`AI Notebook: Start Local Agent Bridge` opens a token-authenticated HTTP
endpoint on `127.0.0.1` so other tools can add cells to the open notebook.

```bash
# Anything on the machine that can read the token file:
printf 'print("hello from an agent")' | node bin/nbpush.js
```

`nbpush` lives inside the installed extension. `Copy Agent Bridge Example
Command` gives you a working command for your machine.

```
GET  /health         state of the target notebook
GET  /cells          the live contents, including unsaved edits
POST /cell           {"code": "..."} in one shot
POST /cell/replace   rewrite one existing cell, by ?index=
POST /cell/stream    raw body, streamed into the cell as it arrives
```

Query parameters — and only the query string: `kind=code|markdown`,
`position=below|above|end|<whole number>`, `run=0|1`,
`notebook=<path fragment>`, `language=<kernel language>`. On `/cells`:
`from=`, `to=`, `outputs=1`. On `/cell/replace`: `index=` and `expect=`. The
body carries the content and nothing else.

Code that reaches the bridge is checked for characters the kernel could not run
— a non-breaking space where a space belongs, a zero-width joiner inside an
identifier. They are rewritten rather than refused, and the response carries
`repaired: <n>` saying how many, so a caller is never silently edited.

`expect=` is the current source of the cell you are replacing, as you last read
it. Pass it: the replace is then refused if the cell has changed since, instead
of destroying something you have not seen. `/cells` clips a long cell and marks
that cell `truncated` — never replace one of those from what you were shown.

The bridge refuses rather than guesses. `401` without the token. `400` for a
body that is not a JSON object, a body that produces no content — including for
`/cell/replace`, which will not blank a cell for you — an unrecognised `kind`,
a `position` that is not a whole number, or a `/cell/replace` with no `index=`
— it will not pick a cell for you. `404` for an unknown path, `405` for
the wrong method. `409` when no notebook is open, when `notebook=` matches none
of the open ones **or more than one** — it will not quietly write somewhere
else, and an ambiguous hint names the candidates so you can narrow it — or when
`expect=` does not match. `413` for a body over 1 MiB.

## Letting other AI tools write here

The bridge is also exposed as an **MCP server** (Model Context Protocol — the
standard way an AI tool is told what actions it may take), so a tool that speaks it can
add cells to your open notebook as a first-class action rather than by being
told to run a shell command.

This matters most for **Codex**, whose extension edits notebooks *on disk* — and
a `.ipynb` written on disk does not appear in a tab you already have open, and
is overwritten the moment you save. Going through the bridge edits the live
document instead.

Run **AI Notebook: Copy Setup Command for Another AI Tool** (or the matching row
in the control panel) and paste what it gives you:

```bash
codex mcp add ai-notebook -- node <path to bin/mcp-server.js>
```

Then restart Codex. It gets four tools:

| tool | what it does |
|---|---|
| `get_notebook_status` | which notebook is targeted, and how many cells it has |
| `get_notebook_cells` | reads the live contents, **including unsaved edits** — the file on disk can be arbitrarily stale |
| `add_notebook_cell` | adds a cell, live — `code`/`markdown`, a position, and an optional request to run it |
| `replace_notebook_cell` | rewrites one existing cell by index, so an agent can correct its own work instead of appending a second copy |

Start the bridge before asking Codex to write. Whether an agent-written cell
*executes* is still governed by `aiNotebookLive.bridge.execution`, which defaults
to `never` — an agent can ask, and never override you.

### Security

- **Loopback only.** The listener binds `127.0.0.1` and is never exposed.
- **Token in a header**, `x-ai-notebook-token`, never in the URL. That is
  deliberate: a header forces browsers to preflight the request, which this
  server refuses, so a web page cannot reach the bridge. A token in a query
  string would remove that protection and would land in shell history.
- Requests carrying an `Origin`, or a `Host` that is not loopback, are refused.
**Short version:** only programs already running on your own computer can reach
this. A web page cannot, and it is off until you turn it on.

- The token file is created `0600` in a `0700` directory, with `O_EXCL` so it
  will not follow a symlink.
- Copyable commands never contain the token.
- Execution goes through the policy above, and never happens in an untrusted
  workspace.

**What it still means:** while the bridge is running, any program on your
machine that can read `~/.ai-notebook-live/` can **read** your notebook —
including cell outputs, which may hold data or keys you printed — **add** cells,
and **overwrite** existing ones. It can run them too, if you have set
`bridge.execution` to allow it. That is the point
of the feature, and it is why it is off by default. On Windows the file modes
above are not meaningfully enforced by the OS.

## Privacy

To generate a cell, this extension sends to your chosen provider:

- the **cells before the insertion point** (`contextCells`, 12 by default),
- their **outputs and error tracebacks**, if `includeOutputs` is on — which it
  is by default,
- the notebook's **file name only**, never its path,
- the kernel language, and your instruction.

Cell outputs routinely contain more than people expect: dataframe contents, file
paths, API responses, and anything you have printed. The default is on because
it is what makes the tool good — the model reuses your real column names instead
of inventing them — but you can turn it off in the control panel or with
`includeOutputs`.

*Fix the Error* is the one exception, and a deliberate one: asking to fix an
error **is** asking to send that error, so the traceback goes either way. With
`includeOutputs` off it sends the traceback and nothing else — the cell's ordinary
printed output stops.

With the **API** provider this goes to Anthropic under your API key, and nothing
else does.

With the **Claude Code CLI** provider it goes through your existing Claude Code
session, and more travels than the list above. The CLI is started *inside your
workspace folder*, which means it behaves the way Claude Code always does there:
**any `CLAUDE.md` that applies to the folder is part of the request**, and Claude
Code may read other files in the folder and send their contents if answering
needs it. If that folder holds anything you would not send to Anthropic, use the
API provider for it, or open the notebook somewhere else. In a workspace you have
**not** trusted, the CLI is run outside the folder instead, so neither its
`CLAUDE.md` nor its hooks apply.

If `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is exported in your shell, the
`auto` provider uses it in preference to your Claude Code plan, and that is
billed per token. Set `provider` to `claude-cli` if you would rather it never
did.

**This extension collects no telemetry of its own.** Nothing is sent anywhere
except the provider you chose, for a request you triggered — with one thing worth
naming: while the agent bridge is running, any local program holding the token
can read the open notebook, including cell outputs, and whatever that program
does with what it reads is between you and it. See [The agent
bridge](#the-agent-bridge).

## Limitations

- Writes into the notebook **currently open in VS Code**. It does not edit files
  on disk, and cannot help with a notebook that is closed.
- Running cells needs the Jupyter extension and a live kernel.
- **The Claude Code CLI provider is not supported on Windows.** The CLI is
  installed there as a `.cmd`, which this extension neither finds nor launches
  correctly, and the obvious fix (`shell: true`) would turn a launch problem
  into a shell-injection surface. Windows users should use an Anthropic API key.
  Everything else — including the bridge and the MCP server — works there.
- `maxTokens`, `effort` and `refusalFallback` apply to the API provider only.
- On models with extended thinking there can be a pause before any text appears;
  the status bar shows a spinner while it works.
- Undo granularity follows the stream: `Ctrl+Z` steps back through it rather
  than reverting a whole generation in one go. If a revision *fails*, your
  original is restored in a single step.
- If you type into a cell while it is being written, the AI stops and leaves
  your version alone — but a keystroke landing in the same instant as a write
  can still be lost.

## Development

```bash
npm ci
npm test          # 131 tests, no VS Code needed
npm run build     # bundle to dist/
npm run package   # build a .vsix
```

`test/vscode-stub.js` stands in for the `vscode` API, which is why the suite runs
under plain Node. `npm test` writes only to a temporary directory and will not
disturb a bridge you have running.

## Licence

[Apache-2.0](LICENSE). Bundled dependency notices are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
