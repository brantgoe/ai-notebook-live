# AI Notebook Live

Streams AI-generated code into Jupyter notebook cells **as it is written**, and opens a
loopback bridge so other AI agents (Claude Code, scripts, cron jobs) can drop cells into
the notebook you have open right now.

Nothing is pasted in after the fact: a cell is created empty and fills in token by token,
so you watch the code appear and can stop it mid-sentence.

## Install

```bash
cd ai-notebook-live
npm install                 # one dependency: @anthropic-ai/sdk
npm test                    # 18 tests, no VS Code needed
npx @vscode/vsce package    # -> ai-notebook-live-0.1.0.vsix
code --install-extension ai-notebook-live-0.1.0.vsix
```

Then reload VS Code (**Developer: Reload Window**). Development alternative: copy or symlink
this folder into `~/.vscode/extensions/` and reload.

## Where the code comes from

Two providers, picked by `aiNotebookLive.provider` (default `auto`):

| Provider | Needs | Notes |
|---|---|---|
| `api` | An Anthropic API key | Run **AI Notebook: Set Anthropic API Key** (stored in the VS Code secret store, never in `settings.json`). Also reads `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`. Streams over the official SDK with `output_config.effort` and server-side refusal fallbacks. |
| `claude-cli` | The `claude` CLI on PATH | Uses your existing Claude Code login — **no API key needed**. Runs `claude --print --output-format stream-json --include-partial-messages`. |

`auto` uses the API when a key is available and the CLI otherwise.

## Commands

| Command | Keybinding | What it does |
|---|---|---|
| AI Notebook: Generate Cell with AI… | `Ctrl+Alt+G` | Asks what you want, inserts a cell below the selected one, streams the code in |
| AI Notebook: Revise This Cell… | `Ctrl+Alt+R` | Rewrites the selected cell in place from your instruction (`Ctrl+Z` restores it) |
| AI Notebook: Fix the Error in This Cell | `Ctrl+Alt+F` | Reads the cell's traceback, rewrites the cell, and runs it |
| AI Notebook: Explain This Cell | — | Streams a markdown explanation cell in directly above |
| AI Notebook: Cancel AI Generation | — | Also on the status-bar item while it is writing |
| AI Notebook: Start/Stop Local Agent Bridge | — | See below |

Every generation sees the preceding cells **and their outputs and errors**, so it reuses the
variables and imports you already have instead of inventing new ones.

## Letting other agents write into the notebook

Run **AI Notebook: Start Local Agent Bridge**. It listens on `127.0.0.1` only, requires a
token, and writes that token to `~/.ai-notebook-live/bridge.json` (mode 600).

```bash
# one-shot cell
curl -sS -X POST "http://127.0.0.1:37417/cell?run=1" \
  -H "x-ai-notebook-token: $(jq -r .token ~/.ai-notebook-live/bridge.json)" \
  -d '{"code":"print(\"hello from an agent\")"}'

# stream a generator straight into a cell, live
claude -p 'write a pandas groupby example' | node bin/nbpush.js --run
```

`bin/nbpush.js` is a small client for the same bridge:

```
nbpush [--code TEXT | --file PATH | -]   # default: read stdin, streaming
       [--markdown] [--run | --no-run]
       [--position below|above|end|<index>]
       [--notebook <path substring>] [--health]
```

Endpoints (all require the token header, `POST` unless noted):

| Endpoint | Body | Result |
|---|---|---|
| `GET /health` | — | `{ok, notebook, cells}` |
| `/cell` | `{"code": "...", "kind": "code\|markdown", "position": …, "run": …}` | inserts one cell |
| `/cell/stream` | raw text, streamed | appends each chunk to the cell as it arrives |

Query parameters (`?kind=&position=&run=&notebook=`) work in place of JSON fields.

### Using it from Claude Code

Point Claude Code at the bridge and it can write cells into your open notebook itself:

> Read `~/.ai-notebook-live/bridge.json`, then POST a cell to `/cell?run=1` that plots the
> price column from the dataframe in my notebook.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `aiNotebookLive.provider` | `auto` | `auto`, `api`, or `claude-cli` |
| `aiNotebookLive.model` | `claude-opus-5` | Any current model id |
| `aiNotebookLive.effort` | `medium` | `low`→`max`; raise it for harder cells, lower it for speed |
| `aiNotebookLive.maxTokens` | `8000` | Output cap per cell |
| `aiNotebookLive.contextCells` | `12` | Preceding cells sent as context (`-1` = whole notebook) |
| `aiNotebookLive.includeOutputs` | `true` | Send cell outputs and errors too |
| `aiNotebookLive.autoRun` | `false` | Execute a generated code cell when streaming finishes |
| `aiNotebookLive.systemPromptExtra` | `""` | House style, e.g. *"Beginner class: comment every line."* |
| `aiNotebookLive.refusalFallback` | `true` | Server-side refusal fallbacks on the API provider |
| `aiNotebookLive.bridge.autoStart` | `false` | Start the bridge when a notebook opens |
| `aiNotebookLive.bridge.port` | `37417` | `0` picks a free port |

## How it works

- A cell is inserted empty, then every flush (60 ms) reconciles the cell document with the
  text received so far, rewriting only the tail that changed — so the editor is not
  re-rendered per token and the undo stack stays usable.
- The cell is re-resolved from its document URI before each flush, so it keeps writing to
  the right cell even if you add or delete cells above it mid-stream.
- Models sometimes wrap answers in ``` fences. Stripping them from a *partial* response has
  to be prefix-stable — text already shown must never be retracted — which is what
  `unfence()` and its tests guarantee.
- Cancelling keeps whatever was written; an empty result removes the cell again.

## Limitations

- One generation at a time (the status bar shows it; click to cancel).
- Typing in a cell while it is being written fights the stream — let it finish.
- Requires the Jupyter extension for execution (`autoRun`, *Fix the Error*).

## Development

```bash
npm test     # node test/run.js — vscode API is stubbed in test/vscode-stub.js
```
