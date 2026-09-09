'use strict';
/* Minimal in-memory stand-in for the parts of the VS Code API this extension
   uses, so the cell-streaming and bridge logic can be tested with plain node. */

const NotebookCellKind = { Markup: 1, Code: 2 };
const NotebookEditorRevealType = { Default: 0 };

let uriSeq = 0;

class Position {
  constructor(offset) {
    this.offset = offset;
  }
}

class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

class NotebookRange {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

class NotebookCellData {
  constructor(kind, value, languageId) {
    this.kind = kind;
    this.value = value;
    this.languageId = languageId;
  }
}

class TextDocument {
  constructor(text, languageId) {
    this.uri = { scheme: 'vscode-notebook-cell', path: `/cell-${(uriSeq += 1)}`, toString() { return `${this.scheme}:${this.path}`; } };
    this.languageId = languageId;
    this.text = text;
  }
  getText() {
    return this.text;
  }
  positionAt(offset) {
    return new Position(Math.max(0, Math.min(offset, this.text.length)));
  }
  get lineCount() {
    return this.text.split('\n').length;
  }
}

class NotebookCell {
  constructor(notebook, data) {
    this.notebook = notebook;
    this.kind = data.kind;
    this.document = new TextDocument(data.value, data.languageId);
    this.outputs = [];
    this.executionSummary = undefined;
  }
  get index() {
    return this.notebook.cells.indexOf(this);
  }
}

class NotebookDocument {
  constructor(fsPath, cells = [], metadata = {}) {
    this.uri = { scheme: 'file', fsPath, path: fsPath, toString() { return `file://${this.path}`; } };
    this.metadata = metadata;
    this.isClosed = false;
    this.cells = [];
    for (const cell of cells) this.cells.push(new NotebookCell(this, cell));
  }
  get cellCount() {
    return this.cells.length;
  }
  getCells() {
    return this.cells.slice();
  }
  cellAt(index) {
    return this.cells[Math.max(0, Math.min(index, this.cells.length - 1))];
  }
}

const NotebookEdit = {
  insertCells: (index, cells) => ({ op: 'insert', index, cells }),
  deleteCells: (range) => ({ op: 'delete', range }),
};

class WorkspaceEdit {
  constructor() {
    this.notebookEdits = [];
    this.textEdits = [];
  }
  set(uri, edits) {
    this.notebookEdits.push({ uri, edits });
  }
  replace(uri, range, text) {
    this.textEdits.push({ uri, range, text });
  }
}

class CancellationTokenSource {
  constructor() {
    this.listeners = [];
    const self = this;
    this.token = {
      isCancellationRequested: false,
      onCancellationRequested(cb) {
        self.listeners.push(cb);
        return { dispose() {} };
      },
    };
  }
  cancel() {
    this.token.isCancellationRequested = true;
    for (const cb of this.listeners) cb();
  }
  dispose() {}
}

const registry = {
  notebooks: [],
  executed: [],
  commands: new Map(),
  edits: 0,
  failApplyEdit: false,
  onBeforeApply: null,
  // Settings the test wants to differ from their declared defaults. Without a
  // real backing store no test could exercise a non-default configuration.
  config: new Map(),
  // Queued answers for the modal/input surfaces, and a log of what was shown.
  inputs: [],
  picks: [],
  shown: [],
};

const workspace = {
  notebookDocuments: registry.notebooks,
  getConfiguration: (section) => ({
    get: (key, fallback) => {
      const full = section ? `${section}.${key}` : key;
      return registry.config.has(full) ? registry.config.get(full) : fallback;
    },
    inspect: (key) => {
      const full = section ? `${section}.${key}` : key;
      return {
        key: full,
        globalValue: registry.config.has(full) ? registry.config.get(full) : undefined,
        workspaceValue: undefined,
      };
    },
    update: async (key, value) => {
      registry.config.set(section ? `${section}.${key}` : key, value);
    },
  }),
  onDidChangeConfiguration: () => ({ dispose() {} }),
  getWorkspaceFolder: () => undefined,
  async applyEdit(edit) {
    registry.edits += 1;
    // Opt-in hooks for tests: failure injection and a deterministic yield so
    // two concurrent writers can be interleaved on purpose. Both off by default.
    if (registry.onBeforeApply) await registry.onBeforeApply(edit);
    if (registry.failApplyEdit) return false;
    for (const { uri, edits } of edit.notebookEdits) {
      const notebook = registry.notebooks.find((n) => n.uri.toString() === uri.toString());
      if (!notebook) return false;
      for (const change of edits) {
        if (change.op === 'insert') {
          const created = change.cells.map((data) => new NotebookCell(notebook, data));
          notebook.cells.splice(change.index, 0, ...created);
        } else if (change.op === 'delete') {
          notebook.cells.splice(change.range.start, change.range.end - change.range.start);
        }
      }
    }
    for (const { uri, range, text } of edit.textEdits) {
      let found;
      for (const notebook of registry.notebooks) {
        found = notebook.cells.find((c) => c.document.uri.toString() === uri.toString());
        if (found) break;
      }
      if (!found) return false;
      const doc = found.document;
      doc.text = doc.text.slice(0, range.start.offset) + text + doc.text.slice(range.end.offset);
    }
    return true;
  },
};

const window = {
  visibleNotebookEditors: [],
  activeNotebookEditor: undefined,
  createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
  createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} }),
  onDidChangeActiveNotebookEditor: () => ({ dispose() {} }),
  showInputBox: async (options) => {
    registry.shown.push({ kind: 'input', options });
    return registry.inputs.length ? registry.inputs.shift() : undefined;
  },
  showInformationMessage: async (message, ...items) => {
    registry.shown.push({ kind: 'info', message, items });
    return registry.picks.length ? registry.picks.shift() : undefined;
  },
  showWarningMessage: async (message, ...items) => {
    registry.shown.push({ kind: 'warning', message, items });
    return registry.picks.length ? registry.picks.shift() : undefined;
  },
  showErrorMessage: async (message, ...items) => {
    registry.shown.push({ kind: 'error', message, items });
    return registry.picks.length ? registry.picks.shift() : undefined;
  },
  setStatusBarMessage: () => undefined,
};

const commands = {
  executeCommand: async (name, payload) => {
    registry.executed.push({ name, payload });
    return undefined;
  },
  registerCommand: (name, handler) => {
    registry.commands.set(name, handler);
    return { dispose() {} };
  },
};

module.exports = {
  NotebookCellKind,
  NotebookEditorRevealType,
  NotebookCellData,
  NotebookEdit,
  NotebookRange,
  NotebookDocument,
  WorkspaceEdit,
  Range,
  Position,
  window,
  workspace,
  commands,
  env: { clipboard: { writeText: async () => undefined } },
  CancellationTokenSource,
  StatusBarAlignment: { Right: 2 },
  __test: registry,
};
