# Changelog

All notable changes to AI Notebook Live are recorded here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Installs are manual, so nothing prompts you to upgrade — see
[Updating](README.md#updating) for how to pick up a new version.

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
