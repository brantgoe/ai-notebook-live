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
function unfence(raw, { final = false } = {}) {
  const lead = raw.replace(/^\s+/, '');
  if (!lead) return '';
  if (final) return unfenceFinal(lead);
  // An opening fence may still be arriving ("`", "``", "```pyth"). Emit nothing
  // until we know whether it is a fence and which language tag it carries.
  if (/^`{1,3}[^\n]*$/.test(lead)) return '';
  if (!lead.startsWith('```')) return lead;
  const afterOpen = lead.slice(lead.indexOf('\n') + 1);
  const close = afterOpen.search(/(^|\n)```/);
  if (close !== -1) return afterOpen.slice(0, close);
  // No closing fence yet: hold back a tail that could turn out to be one,
  // because text already written into the cell must never be retracted.
  return afterOpen.replace(/(?:^|\n)`{0,2}$/, '');
}

function unfenceFinal(lead) {
  // The answer is only fenced if its FIRST line is an opener. This is the branch
  // that used to swallow `x` and `my var` <- 5 whole: a single backtick is not a
  // fence, and at the end there is no "it might still become one".
  const open = /^(`{3,})[^\n]*(\n|$)/.exec(lead);
  if (!open) return lead;
  if (!open[2]) return ''; // an opener and nothing after it
  const body = lead.slice(open[0].length);
  // The closer is the LAST line that is nothing but the marker - or more of it,
  // which CommonMark allows. Taking the FIRST one truncated at any fence the
  // code itself contained, which is how a docstring lost its second half.
  const closer = new RegExp(`(^|\\n)${open[1]}\`*[ \\t\\r]*(?=\\n|$)`, 'g');
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
      const at = Math.max(0, Math.min(index, notebook.cellCount));
      const before = new Set(notebook.getCells().map((c) => c.document.uri.toString()));
      const data = new vscode.NotebookCellData(cellKind, '', lang);
      const edit = new vscode.WorkspaceEdit();
      edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(at, [data])]);
      await apply(edit, 'insert a cell into the notebook');
      // Claim the cell by identity rather than by index, so a foreign edit that
      // lands during the await cannot hand us somebody else's cell.
      const created = notebook
        .getCells()
        .find((c) => !before.has(c.document.uri.toString()));
      if (!created) throw new Error('The inserted cell could not be found.');
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

  async setText(target, { force = false } = {}) {
    if (this.closed && !force) return;
    const cell = this.cell();
    if (!cell) return;
    const doc = cell.document;
    const current = doc.getText();
    if (current === target) return;
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
  }

  /**
   * Final reconcile. Returns the text that is actually in the document now -
   * not the text we meant to write, which used to be reported as success even
   * when every edit had failed.
   *
   * Execution is deliberately not decided here; see src/policy.js.
   */
  async end({ trim = true } = {}) {
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
      return { restored: true, partial };
    }

    await this.setText(this.original, { force: true });
    return { restored: true, partial };
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
  const clip = (s) => (s.length > limit ? `${s.slice(0, limit)}\n...<truncated>` : s);
  return {
    error: errors.length ? clip(errors.join('\n\n')) : '',
    text: text.length ? clip(text.join('')) : '',
  };
}

module.exports = { CellWriter, runCell, readOutputs, notebookLanguage, editorFor, unfence };
