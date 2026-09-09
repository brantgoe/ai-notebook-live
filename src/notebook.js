'use strict';
const vscode = require('vscode');
const { log } = require('./log');

// Tokens arrive far faster than a notebook wants to be re-rendered. Buffer the
// raw stream and reconcile the cell document on a timer instead.
const FLUSH_MS = 60;

/**
 * Removes markdown code fences from a partially streamed response.
 * Models sometimes wrap cell code in ```python ... ``` despite instructions, and
 * we only ever see a prefix of the answer, so this has to be prefix-stable:
 * the same text must never be emitted and then retracted.
 */
function unfence(raw) {
  const lead = raw.replace(/^\s+/, '');
  if (!lead) return '';
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
  constructor(notebook, cell, { fenced = true } = {}) {
    this.notebook = notebook;
    this.uri = cell.document.uri.toString();
    this.fenced = fenced;
    this.raw = '';
    this.timer = undefined;
    this.flushing = Promise.resolve();
    this.closed = false;
  }

  static async insert(notebook, index, { kind = 'code', language, fenced = true } = {}) {
    const lang =
      language || (kind === 'markdown' ? 'markdown' : notebookLanguage(notebook));
    const cellKind =
      kind === 'markdown' ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code;
    const at = Math.max(0, Math.min(index, notebook.cellCount));
    const data = new vscode.NotebookCellData(cellKind, '', lang);
    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(at, [data])]);
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error('Could not insert a cell into the notebook.');
    }
    const cell = notebook.cellAt(at);
    const writer = new CellWriter(notebook, cell, { fenced });
    writer.reveal();
    return writer;
  }

  /** Streams into a cell that already exists, replacing whatever it holds. */
  static async replace(notebook, cell, { fenced = true } = {}) {
    const writer = new CellWriter(notebook, cell, { fenced });
    await writer.setText('');
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
    // Serialise flushes: overlapping applyEdit calls race on the same document.
    this.flushing = this.flushing
      .then(() => this.setText(this.text()))
      .catch((err) => log('flush failed:', err && err.message ? err.message : String(err)));
    return this.flushing;
  }

  text() {
    const body = this.fenced ? unfence(this.raw) : this.raw;
    return body.replace(/^\n+/, '');
  }

  async setText(target) {
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
    await vscode.workspace.applyEdit(edit);
  }

  /** Final flush. Returns the text that ended up in the cell. */
  async end({ run = false, trim = true } = {}) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flush();
    const final = trim ? this.text().replace(/\s+$/, '') : this.text();
    await this.flushing.then(() => this.setText(final));
    this.closed = true;
    const cell = this.cell();
    if (run && cell && cell.kind === vscode.NotebookCellKind.Code && final.trim()) {
      await runCell(this.notebook, cell.index);
    }
    return final;
  }

  /**
   * Abandons the cell this writer created and removes it from the notebook.
   * A request that fails partway - an over-sized body, a cancelled generation -
   * must not leave a half-written cell behind for the user to clean up.
   */
  async drop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // Stop accepting writes before awaiting, so nothing re-schedules a flush.
    this.closed = true;
    // Let an in-flight flush settle first, or it races the delete.
    await this.flushing.catch(() => {});
    const cell = this.cell();
    if (!cell) return false;
    const edit = new vscode.WorkspaceEdit();
    edit.set(this.notebook.uri, [
      vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(cell.index, cell.index + 1)),
    ]);
    return vscode.workspace.applyEdit(edit);
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
