# Changelog

All notable changes to AI Notebook Live are recorded here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Installs are manual, so nothing prompts you to upgrade — see
[Updating](README.md#updating) for how to pick up a new version.

## [0.6.0] - 2026-09-10

A ten-expert review of 0.5.0 — security, VS Code platform, concurrency, test
efficacy, protocol, the fence parser, UX, reliability, licensing and scope. This
release is what came out of it. Nothing new was added; a lot was made true.

### Fixed — your work

- **A failed revise could destroy the cell it was revising.** `abandon()` asked
  the writer to put your text back, the writer correctly refused when you had
  typed into the cell, and `abandon()` reported success anyway — so you were
  told "your cell was put back" when it had not been. The button it offered,
  *Keep what the AI wrote*, then overwrote what you had typed as well. Both
  fixed; the message now says which of the three things actually happened.
- **A failure in the final write left a half-written cell with no way back.**
  That step sat outside the error handling entirely.
- **`POST /cell/replace` with an empty or whitespace-only body answered 200 and
  blanked the cell.** The guard that has always protected `/cell` was never
  reached by the newer, destructive path.
- **A fenced block whose lines end in a bare carriage return lost the whole
  cell**, silently, in both parsing modes.
- **Clipping a long cell could cut a character in half**, producing a notebook
  `nbformat` and `nbconvert` cannot read.

### Fixed — consent

- **An approval approved a cell, not the code in it.** With
  `bridge.execution: ask`, a second request could rewrite the cell while the
  dialog was open, so clicking *Run it* ran code you were never shown. Execution
  now checks the cell still holds what you were asked about.
- **A cell you had typed into could be executed.** The writer knew you had taken
  it over and nothing downstream ever asked.
- **One *Always run these this session* click approved every later agent push**
  for the life of the window. That button is no longer offered for pushed code.
- **Reading and overwriting left no trace at all** — no log line, nothing on
  screen. Both are recorded now, and an overwrite says which cell.
- **The bridge started in a folder you had not trusted**, which the Restricted
  Mode dialog says it will not do.

### Fixed — lifecycle

- **Every finished generation left a timer armed for five minutes** that
  cancelled whatever was running when it fired, and blamed you for it.
- **Reloading mid-generation orphaned the `claude` process**, still spending
  your plan quota with no window left to cancel it.
- The status bar did not repaint when the bridge opened a socket — the one
  moment that indicator exists for. *Copy Agent Bridge Example Command* also
  started the bridge silently; it says so now.
- A hung CLI could still wedge the window permanently, via a case the timeout
  could not reach.
- `claudePath` pointing at a *directory* was accepted as the CLI.

### Fixed — correctness

- Model output was never validated. Characters a kernel cannot run reached the
  cell; they are repaired now rather than refused, so one invisible character
  cannot discard a whole generation.
- The character rules were wrong in both directions, checked against real
  Python: non-breaking space, BOM, soft hyphen and the zero-width characters
  were allowed through, and form feed — which is legal — was refused.
- An indented closing fence was not recognised, leaving fence markers in the
  cell.
- An insert could claim a cell **you** had just added above it.

### Fixed — the CLI and the docs

- **`nbpush --list` and `--replace` never worked.** Both were announced in
  0.5.0, and neither was ever accepted by the argument parser. Now they are —
  and `--replace` on a pipe used to silently *append* rather than replace.
- **Every release told you to install a filename that does not exist**
  (`ai-notebook-live-v0.6.0.vsix`; the file has no `v`).
- `Ctrl+Alt+G` and `Ctrl+Alt+R` were dead while the cursor was inside a cell.
- The install steps now work on a Mac, where `code` is not on `PATH` by default.
- An `ANTHROPIC_API_KEY` left in your shell silently switches you to paid
  billing; the README says so now.

### Fixed — talking to other tools

- **A malformed line got no answer at all**, so an MCP client with a request
  outstanding waited forever. Batch requests vanished the same way. Both are
  answered now, and an unknown method returns `-32601` rather than a generic
  server error — which is how a client tells "I do not do that" from "I broke".
- **Calling a tool that does not exist reported "the bridge is not running."**
  The name was checked only after contacting VS Code, so a typo looked like a
  configuration problem.
- **Queued responses were lost when the input stream closed** — measured, 24 of
  40 with a slow reader — because `process.exit` does not flush a pending write.
- `/health` now reports the extension version and which verbs it supports. There
  was no way to tell an old bridge from a broken one.
- An unknown path is a `404`; a `405` now means the method was wrong for a path
  that does exist.

### Security and supply chain

- `SECURITY.md`: where to report a problem, what this extension can actually do,
  and how to check that a downloaded `.vsix` holds the code this repo built.
- Releases publish `SHA256SUMS`, including the hash of the bundled
  `extension.js` — the `.vsix` zip is not byte-reproducible, but its contents
  are.
- CI actions are pinned to commit SHAs rather than mutable tags, and the
  workflow defaults to `contents: read`.
- `standardwebhooks` ships no license file, so the notices carried a link rather
  than a notice; MIT requires the text itself to travel. It is embedded now,
  along with the discrepancy found while checking: the package declares MIT
  while its repository publishes Apache-2.0.

### Added

- `expect=` on `/cell/replace`: the source you believe you are replacing. The
  edit is refused if the cell has changed, instead of destroying something
  unseen. Optional now, required in a later release.
- `/cells` marks each clipped cell `truncated`, rather than once per response.
- `AI_NOTEBOOK_TEST_ORDER=reverse|shuffle:<seed>` for the test suite.

### Internal

111 tests, up from 80. The number matters less than what they cover: the old
suite tested the modules and almost never checked the product used them —
deleting the entire execution policy from `extension.js` left it green. Every
mutation the review found surviving now fails.

## [0.5.0] — 2026-09-09

### Added

- **Reading the notebook, live.** `GET /cells`, the `get_notebook_cells` MCP
  tool, and `nbpush --list` return what the editor actually holds, **including
  unsaved edits**. The bridge was write-only, which meant an agent could add a
  cell and then never look at it — and a reviewer had to ask you to save before
  they could see anything.
- **Rewriting a cell in place.** `POST /cell/replace?index=N`, the
  `replace_notebook_cell` MCP tool, and `nbpush --replace <index>`. Without it,
  an agent correcting a mistake could only append a second, fixed copy and leave
  the wrong one behind.

  Kept deliberately separate from adding a cell: appending is additive and
  forgiving, replacing destroys what was there. It must be asked for by name and
  by index, it refuses an index that does not exist rather than inventing a cell,
  and it returns the previous contents so the loss is visible rather than silent.
  `Ctrl+Z` still restores it.

## [0.4.0] — 2026-09-09

### Added

- **Other AI tools can now write cells into your open notebook.** The bridge is
  exposed as an MCP server, so anything that speaks MCP — **Codex** in
  particular — gets `add_notebook_cell` and `get_notebook_status` as real tools
  rather than shell instructions it has to remember.

  This is worth having because the Codex extension edits notebooks *on disk*,
  and a file written on disk does not appear in a tab you already have open — it
  is lost the moment you save. Going through the bridge edits the live document.

  Run **AI Notebook: Copy Setup Command for Another AI Tool**, paste the line it
  gives you, and restart Codex. Whether an agent-written cell *runs* is still
  governed by `aiNotebookLive.bridge.execution`, which defaults to `never`: an
  agent can ask, and can never override you.

  The server ships as a single file importing only Node builtins — no SDK, no
  new dependency, nothing added to the bundle.

### Changed

- **Windows is explicitly out of scope for the Claude Code CLI provider.** It
  was already broken there and is now documented as a limitation rather than
  tracked as a bug. Windows users should use an Anthropic API key; the bridge
  and the MCP server work fine there.

## [0.3.2] — 2026-09-09

A second round of adversarial testing, aimed at the `claude` CLI provider, which
had no test coverage at all. Three findings, all of them the same shape: the
extension had the information needed to explain itself and threw it away.

### Fixed

- **A generation that stalls now gives up on its own.** If the provider stopped
  responding entirely, nothing ever timed out — and the damage was worse than a
  hung request: the extension stayed convinced it was still writing, so **every
  later command was refused with "already writing a cell" until you reloaded
  the window**. It now stops after five minutes of silence, keeps whatever was
  written, and says so. The window is measured from the last token rather than
  from the start, so a model that thinks for a long time is not interrupted,
  and it is configurable with `aiNotebookLive.timeoutSeconds`.
- **A CLI failure that exits successfully is no longer silent.** The `claude`
  CLI reports some problems in its output stream and still exits 0 —
  `error_max_turns` is the common one. The reason was captured and then only
  ever shown if the exit code was non-zero, so you got an empty cell and no
  explanation. A genuinely empty result still stays quiet.
- **An unusual cell output no longer breaks *Fix the Error*.** Reading a cell's
  outputs assumed every item had both a type and data; one that did not threw a
  TypeError, which surfaced as a confusing error dialog instead of a fix.

### Internal

- 76 tests, up from 72. The CLI provider is now driven by a stand-in binary
  emitting crafted output, covering an in-band failure, a quiet success and a
  process that never exits.

## [0.3.1] — 2026-09-09

Two items filed as rough edges in the 0.2.0 review turned out to be neither.

### Fixed

- **`nbpush` could send your code to another program entirely.** The bridge
  records the process that owns it; `nbpush` never checked that process was
  still alive. After VS Code exits without shutting down cleanly — a crash, an
  OOM kill, a reboot — the advertisement survives naming a dead process and a
  port, and anything else that later binds that port received the code you piped
  in, and the token, while `nbpush` printed `{"ok":true}`. Reproduced against a
  stand-in listener before and after.

  `nbpush` now refuses a stale advertisement, checks the process is alive, and
  confirms the thing on that port really is the bridge — probing first *without*
  the token, so a wrong listener never receives a credential either. It also
  validates the file's shape, which is what makes the error messages readable
  instead of raw Node internals.

- **Text that poisons a notebook is refused instead of written.** An unpaired
  surrogate is the serious one: VS Code saves notebooks with JavaScript, which
  escapes one happily, but Python — `nbformat`, `nbconvert`, `papermill` — can
  read that file and then **cannot write it back out**. One pushed cell makes
  the notebook unprocessable by the whole toolchain, with an error naming
  Unicode rather than the cell. NUL bytes and U+2028 are quieter: they save
  fine and then fail at execution with a message that never names the cell.

  These are refused rather than silently cleaned up, because altering somebody's
  code without telling them is the failure this project spent 0.3.0 removing.
  Escape sequences written the normal way — `"\x1b[31m"` in Python source — are
  ordinary ASCII and unaffected.

## [0.3.0] — 2026-09-09

Adversarial testing of 0.2.0 found thirteen bugs; mapping the code to fix them
found eleven more. This release is those fixes. Two things stop happening: the
extension silently losing what the model wrote, and silently overwriting what
*you* wrote.

### Fixed — the ones you would have noticed

- **Typing into a cell while the AI is writing no longer destroys your text.**
  The AI stops and leaves your version alone, and offers to put its own version
  in a new cell below. It never overwrites you.
- **Code the model wrote is no longer silently dropped.** Fence-stripping was
  conservative while streaming — correct, since text withdrawn from a cell is
  text deleted in front of you — but nothing ever told it the stream had
  finished, so the guess became permanent. A cell containing only `` `x` ``, an
  R name like `` `my var` <- 5 ``, a fence inside a docstring, or a fenced block
  inside another all lost content. The `` `x` `` case was the worst: the result
  was empty, so the cell was removed and *nothing happened at all*.
- **`nbpush` no longer hangs forever** when run in a terminal with nothing piped
  in — and no longer parks an empty cell in your notebook while it waits.
- **An empty generation says so**, instead of reporting "AI wrote 1 lines" for a
  cell it just deleted.

### Fixed — correctness and safety

- `--run` and `--no-run` together used to run the cell. Contradictory arguments
  are now refused rather than resolved last-wins, which matters for a flag that
  decides whether code executes in your kernel. `--code --run` no longer eats
  the flag as a value. Added `--kind` and `--dry-run`.
- A `notebook=` hint matching nothing wrote to whatever notebook was active. It
  is now a `409` that lists what is open.
- Markdown pushed over the bridge had its fenced code blocks stripped.
- The request body was spread into the options bag, so any key a caller invented
  became an option and body keys beat the query string. Options now come from
  the query string only, so a body key *cannot* become one.
- A `null` body surfaced as a `500` with an internal JavaScript message in it.
- An empty push left an empty cell behind.
- A fractional `position` reached the notebook API; `?kind=Markdown` silently
  became a code cell; a `language` value reached VS Code with no coercion.
- The execution policy threw on a non-string preview and on missing settings,
  despite promising it never throws — and a throw there escaped the HTTP
  handler.
- An **unrecognised caller inherited your `execution` setting**, so an unknown
  surface could run code under `always`. It now fails closed, as does a typo in
  the setting itself.
- `end()` after a cell was abandoned could resurrect the discarded partial and
  overwrite the restored original.

### Changed

- **The bridge is stricter**, which is why this is 0.3.0 and not 0.2.1. Requests
  it used to accept and guess at are now refused with a reason. Options must be
  in the query string.
- `nbpush` prints the notebook it wrote to, on stderr — stdout stays JSON.

### Internal

- 69 tests, up from 44. Fence handling is fuzzed across 50,000 adversarial
  strings asserting that text once written is never retracted.
- `src/validate.js` is the one place input is coerced; it depends on nothing,
  and a test enforces that.

## [0.2.0] — 2026-09-09

The theme of this release is that the extension can no longer do two things
behind your back: destroy your code, or run code you did not agree to run.

### Changed — please read

- **Execution is now a three-way choice, not a checkbox.**
  `aiNotebookLive.execution` is `never`, `ask` or `always`, and defaults to
  `ask`. The old `aiNotebookLive.autoRun` is deprecated but still honoured:
  `true` behaves as `always`, `false` as `never`, and if you never set it you
  get `ask`. Nobody is migrated into an execution they did not have before.
- **Agent-pushed code now defaults to never executing.**
  `aiNotebookLive.bridge.execution` is a separate setting and defaults to
  `never`. It is deliberately *not* migrated from `autoRun`: letting another
  program run code in your kernel is a different decision, and it was never
  something you opted into explicitly. Turn it on from the control panel.
- **`?run=1` on the bridge is now a request, not an override.** A caller can
  decline execution but can no longer demand it. `nbpush --no-run` is
  unaffected; the HTTP response now reports `ran` and `reason`.
- **The bridge no longer accepts its token in the query string.** Use the
  `x-ai-notebook-token` header, which is what `nbpush`, the README and the
  copyable example command already used.
- **`Ctrl+Alt+F` / `Cmd+Alt+F` was removed.** It bound over Find/Replace on
  macOS, and did so while your caret was inside a cell. *Fix the Error* is
  still on the cell toolbar and in the command palette.
- **Licence changed from MIT to Apache-2.0**, which adds an explicit patent
  grant. Bundled dependency notices are in `THIRD-PARTY-NOTICES.md`.

### Added

- **A control panel.** `AI Notebook: Control Panel`, or click the status bar
  item. It shows which provider and key source is actually in play, whether the
  bridge is listening and on what port, and what will happen when a cell
  finishes — then lets you change any of it.
- **`aiNotebookLive.claudePath`** to point at the `claude` binary yourself. The
  search now also covers nvm, bun, linuxbrew and `~/.claude/local`.
- Workspace-trust and virtual-workspace support are now declared, so VS Code
  ignores workspace-supplied prompt text in a folder you have not trusted.
- Settings that decide execution or open a socket are machine-scoped, so a
  repository you clone cannot set them.

### Fixed

- **Revising or fixing a cell no longer destroys it when the request fails.**
  The cell was previously cleared *before* the model was contacted, so the
  likeliest first-run failure of all — no API key configured — blanked whatever
  you had written. On failure your cell is now handed back exactly as it was,
  and the AI's partial output is one `Ctrl+Z` away.
- **A failure part-way through no longer deletes a partly written cell.**
- ***Fix the Error* respected no setting at all** — it always executed the
  model's output, even with auto-run off. Since its prompt is built from cell
  outputs and error tracebacks, which content the notebook touches can
  influence, that was a route from a poisoned error message to running code.
- **Two simultaneous pushes could land in the same cell**, with one overwriting
  the other. Cell creation is serialised and each writer claims its cell by
  identity.
- **A failed edit reported success**, and auto-run then executed the stale
  content. Failures now surface.
- **An early `claude` exit could crash the extension host** — an unhandled
  `EPIPE` on the child's stdin, which takes down every extension in the window.
  The child is also no longer left running on the error path.
- **The bridge's token file** ignored the permissions it claimed (a directory
  that already existed stayed as it was; an existing file kept its mode) and
  followed symlinks, so a link at that path meant the token JSON overwrote
  whatever it pointed at. It is now created with `O_EXCL` and the directory is
  chmod'd explicitly.
- **Stopping the bridge in one window** deleted the token file belonging to
  another, leaving it listening but unreachable.
- **The copyable example command contained your live token**, which then landed
  in shell history. It now reads the token at run time.
- The bridge reported every failure as `500` or `413` regardless of cause;
  statuses are now accurate (`400`, `409`, `413`).
- **`npm test` deleted the token file of a bridge running in another window.**
- Out-of-range settings fall back to their defaults instead of clamping to a
  surprising nearby value.
- Revising a markdown cell no longer strips its fenced code blocks.

### Internal

- The published extension is bundled: **7 files instead of 2,399**, and 336 KB
  instead of 2.8 MB.
- `npm ci` works again — `package-lock.json` disagreed with `package.json`.
- 43 tests, up from 18 at the start of this work, running with no VS Code.

## [0.1.0] — 2026-09-09

Initial version: stream Claude-generated code into notebook cells, revise,
explain and fix cells, and a localhost bridge for external agents.
