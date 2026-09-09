'use strict';
const path = require('path');
const vscode = require('vscode');
const { settings } = require('./src/config');
const { log, show: showLog, dispose: disposeLog } = require('./src/log');
const { CellWriter, readOutputs, runCell } = require('./src/notebook');
const prompts = require('./src/prompt');
const { stream, ProviderError, SECRET_KEY } = require('./src/provider');
const { Bridge } = require('./src/bridge');

const state = {
  /** @type {vscode.CancellationTokenSource | undefined} */
  active: undefined,
  /** @type {vscode.NotebookDocument | undefined} */
  lastNotebook: undefined,
  lastInstruction: '',
  status: undefined,
  bridge: undefined,
  context: undefined,
};

function activate(context) {
  state.context = context;
  state.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(state.status);
  idle();

  state.bridge = new Bridge({
    resolveNotebook: (hint) => targetNotebook(hint),
    defaultRun: () => settings().autoRun,
  });

  rememberNotebook(vscode.window.activeNotebookEditor);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveNotebookEditor((editor) => {
      rememberNotebook(editor);
      if (!state.active) idle();
    })
  );

  const register = (name, handler) =>
    context.subscriptions.push(vscode.commands.registerCommand(name, handler));

  register('aiNotebookLive.generate', (arg) => guard('generate', (token) => generate(arg, token)));
  register('aiNotebookLive.reviseCell', (arg) => guard('revise', (token) => revise(arg, token)));
  register('aiNotebookLive.explainCell', (arg) => guard('explain', (token) => explain(arg, token)));
  register('aiNotebookLive.fixError', (arg) => guard('fix', (token) => fixError(arg, token)));
  register('aiNotebookLive.cancel', () => {
    if (state.active) {
      state.active.cancel();
      vscode.window.setStatusBarMessage('$(stop-circle) AI generation cancelled', 2500);
    }
  });
  register('aiNotebookLive.setApiKey', setApiKey);
  register('aiNotebookLive.clearApiKey', async () => {
    await context.secrets.delete(SECRET_KEY);
    vscode.window.showInformationMessage('AI Notebook Live: stored Anthropic API key removed.');
  });
  register('aiNotebookLive.startBridge', () => startBridge(true));
  register('aiNotebookLive.stopBridge', async () => {
    await state.bridge.stop();
    vscode.window.showInformationMessage('AI Notebook Live: agent bridge stopped.');
  });
  register('aiNotebookLive.copyBridgeInfo', async () => {
    if (!state.bridge.running) await startBridge(false);
    if (!state.bridge.running) return;
    await vscode.env.clipboard.writeText(state.bridge.curlExample());
    vscode.window.showInformationMessage(
      `Copied a ready-to-run bridge command (port ${state.bridge.port}).`
    );
  });
  register('aiNotebookLive.showLog', showLog);

  if (settings().bridgeAutoStart) startBridge(false);
  log('activated');
}

async function deactivate() {
  if (state.bridge) await state.bridge.stop();
  disposeLog();
}

/* ------------------------------- UI plumbing ------------------------------ */

function idle() {
  const item = state.status;
  if (!item) return;
  item.text = '$(sparkle) AI Cell';
  item.tooltip = 'Generate a notebook cell with AI (Ctrl+Alt+G)';
  item.command = 'aiNotebookLive.generate';
  if (vscode.window.activeNotebookEditor) item.show();
  else item.hide();
}

function busy(label) {
  const item = state.status;
  if (!item) return;
  item.text = `$(loading~spin) AI ${label}...`;
  item.tooltip = 'Click to cancel AI generation';
  item.command = 'aiNotebookLive.cancel';
  item.show();
}

/** One generation at a time, always cancellable, never leaves the UI stuck. */
async function guard(label, body) {
  if (state.active) {
    const pick = await vscode.window.showWarningMessage(
      'AI Notebook Live is already writing a cell.',
      'Cancel it'
    );
    if (pick === 'Cancel it') state.active.cancel();
    return;
  }
  const cts = new vscode.CancellationTokenSource();
  state.active = cts;
  busy(label === 'explain' ? 'explaining' : 'writing');
  vscode.commands.executeCommand('setContext', 'aiNotebookLive.generating', true);
  try {
    await body(cts.token);
  } catch (err) {
    await reportError(err);
  } finally {
    cts.dispose();
    state.active = undefined;
    vscode.commands.executeCommand('setContext', 'aiNotebookLive.generating', false);
    idle();
  }
}

async function reportError(err) {
  const message = (err && err.message) || String(err);
  log('error:', message);
  if (err instanceof ProviderError && err.action === 'setKey') {
    const pick = await vscode.window.showErrorMessage(message, 'Set API Key', 'Show Log');
    if (pick === 'Set API Key') await setApiKey();
    if (pick === 'Show Log') showLog();
    return;
  }
  const pick = await vscode.window.showErrorMessage(`AI Notebook Live: ${message}`, 'Show Log');
  if (pick === 'Show Log') showLog();
}

async function setApiKey() {
  const key = await vscode.window.showInputBox({
    title: 'Anthropic API key',
    prompt: 'Stored in the VS Code secret store, not in settings.json',
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'sk-ant-...',
  });
  if (!key) return;
  await state.context.secrets.store(SECRET_KEY, key.trim());
  vscode.window.showInformationMessage('AI Notebook Live: API key saved.');
}

async function startBridge(announce) {
  try {
    const { port } = await state.bridge.start(settings().bridgePort);
    log(`bridge token written to ${state.bridge.infoFile}`);
    if (announce) {
      const pick = await vscode.window.showInformationMessage(
        `Agent bridge listening on 127.0.0.1:${port}. Agents can POST cells into this notebook.`,
        'Copy Example Command',
        'Show Log'
      );
      if (pick === 'Copy Example Command') {
        await vscode.env.clipboard.writeText(state.bridge.curlExample());
      }
      if (pick === 'Show Log') showLog();
    }
  } catch (err) {
    await reportError(
      new Error(
        `could not start the agent bridge on port ${settings().bridgePort}: ${(err && err.message) || err}`
      )
    );
  }
}

function rememberNotebook(editor) {
  if (editor && editor.notebook) state.lastNotebook = editor.notebook;
}

/** The notebook an agent request should land in. */
function targetNotebook(hint) {
  const open = vscode.workspace.notebookDocuments.filter((d) => !d.isClosed);
  if (hint) {
    const match = open.find((d) => d.uri.fsPath.includes(String(hint)));
    if (match) return match;
  }
  const active = vscode.window.activeNotebookEditor;
  if (active) return active.notebook;
  const visible = vscode.window.visibleNotebookEditors[0];
  if (visible) return visible.notebook;
  if (state.lastNotebook && !state.lastNotebook.isClosed) return state.lastNotebook;
  return open.length === 1 ? open[0] : undefined;
}

function requireEditor() {
  const editor = vscode.window.activeNotebookEditor;
  if (!editor) throw new Error('open a notebook first - there is no active notebook editor.');
  return editor;
}

/**
 * Cell-toolbar commands hand us the cell; palette and keybinding invocations
 * hand us nothing, so fall back to the selection.
 */
function resolveCell(arg) {
  if (arg && arg.cell && arg.cell.document) return { notebook: arg.cell.notebook, cell: arg.cell };
  if (arg && arg.document && typeof arg.index === 'number' && arg.notebook) {
    return { notebook: arg.notebook, cell: arg };
  }
  const editor = requireEditor();
  if (!editor.notebook.cellCount) throw new Error('this notebook has no cells yet.');
  const index = Math.min(editor.selection.start, editor.notebook.cellCount - 1);
  return { notebook: editor.notebook, cell: editor.notebook.cellAt(index) };
}

async function ask(title, placeHolder) {
  const answer = await vscode.window.showInputBox({
    title,
    placeHolder,
    value: state.lastInstruction,
    valueSelection: state.lastInstruction ? [0, state.lastInstruction.length] : undefined,
    ignoreFocusOut: true,
  });
  if (answer && answer.trim()) state.lastInstruction = answer.trim();
  return answer && answer.trim();
}

/* -------------------------------- commands ------------------------------- */

async function generate(arg, token) {
  const editor = requireEditor();
  const notebook = editor.notebook;
  const instruction = await ask(
    'Generate a notebook cell',
    'e.g. ask for the product name and price, then print a receipt'
  );
  if (!instruction) return;

  const opts = settings();
  const index = notebook.cellCount ? editor.selection.end : 0;
  const { system, user } = prompts.generatePrompt({ notebook, index, instruction, opts });
  const writer = await CellWriter.insert(notebook, index, { kind: 'code' });
  await pump({ writer, system, user, opts, token, run: opts.autoRun });
}

async function revise(arg, token) {
  const { notebook, cell } = resolveCell(arg);
  const instruction = await ask(
    'Revise this cell',
    'e.g. handle bad input, add a docstring, use a loop instead'
  );
  if (!instruction) return;

  const opts = settings();
  const { system, user } = prompts.revisePrompt({ notebook, cell, instruction, opts });
  const writer = await CellWriter.replace(notebook, cell);
  await pump({ writer, system, user, opts, token, run: opts.autoRun });
}

async function fixError(arg, token) {
  const { notebook, cell } = resolveCell(arg);
  if (cell.kind !== vscode.NotebookCellKind.Code) {
    throw new Error('that is a markdown cell - there is nothing to fix.');
  }
  const { error } = readOutputs(cell);
  if (!error) {
    const pick = await vscode.window.showWarningMessage(
      'This cell has no error output. Run it first, or fix it anyway?',
      'Fix anyway'
    );
    if (pick !== 'Fix anyway') return;
  }

  const opts = settings();
  const { system, user } = prompts.fixPrompt({ notebook, cell, opts });
  const writer = await CellWriter.replace(notebook, cell);
  await pump({ writer, system, user, opts, token, run: opts.autoRun });
}

async function explain(arg, token) {
  const { notebook, cell } = resolveCell(arg);
  const opts = settings();
  const { system, user } = prompts.explainPrompt({ notebook, cell, opts });
  const writer = await CellWriter.insert(notebook, cell.index, {
    kind: 'markdown',
    fenced: false,
  });
  await pump({ writer, system, user, opts, token, run: false });
}

/** The directory the `claude` CLI should run in: the notebook's own project. */
function workingDirFor(notebook) {
  const folder = vscode.workspace.getWorkspaceFolder(notebook.uri);
  if (folder) return folder.uri.fsPath;
  return notebook.uri.scheme === 'file' ? path.dirname(notebook.uri.fsPath) : undefined;
}

/** Runs one streaming request and lands every token in the cell as it arrives. */
async function pump({ writer, system, user, opts, token, run }) {
  const started = Date.now();
  opts = { ...opts, cwd: workingDirFor(writer.notebook) };
  let result;
  try {
    result = await stream({
      system,
      user,
      opts,
      secrets: state.context.secrets,
      token,
      onText: (chunk) => writer.write(chunk),
    });
  } catch (err) {
    // The writer knows what undoing itself means: delete a cell we created,
    // hand back a cell we borrowed. pump no longer has to be told.
    const { partial } = await writer.abandon();
    if (writer.origin === 'replace' && partial.trim()) {
      const lines = partial.split('\n').length;
      vscode.window
        .showWarningMessage(
          `AI Notebook Live: that failed partway, so your cell was put back. Ctrl+Z brings back the ${lines} line${lines === 1 ? '' : 's'} the AI had written.`,
          'Keep what the AI wrote'
        )
        .then((pick) => {
          if (pick) writer.setText(partial, { force: true });
        });
    }
    throw err;
  }

  // Nothing usable came back: undo rather than leave an empty cell behind.
  // This is also what stops a failed revise from blanking the user's cell.
  if (!writer.produced()) {
    await writer.abandon();
    if (result.cancelled) {
      vscode.window.setStatusBarMessage('$(stop-circle) AI generation cancelled', 2500);
      return;
    }
  }

  const text = writer.produced() ? await writer.end() : '';
  if (text.trim() && run && !result.cancelled && !result.refused) {
    await runCell(writer.notebook, writer.index);
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  log(
    `${result.provider} (${result.model || opts.model}) wrote ${text.length} chars in ${seconds}s`,
    result.stopReason ? `stop_reason=${result.stopReason}` : ''
  );

  if (result.cancelled || (token && token.isCancellationRequested)) {
    vscode.window.setStatusBarMessage('$(stop-circle) AI generation cancelled', 2500);
    return;
  }
  if (result.refused) {
    const detail =
      (result.refusalDetails && result.refusalDetails.explanation) ||
      'the model declined this request.';
    vscode.window.showWarningMessage(`AI Notebook Live: ${detail}`);
    return;
  }
  if (result.stopReason === 'max_tokens') {
    vscode.window.showWarningMessage(
      `The cell hit the ${opts.maxTokens}-token limit and may be cut off. Raise aiNotebookLive.maxTokens.`
    );
    return;
  }
  vscode.window.setStatusBarMessage(
    `$(sparkle) AI wrote ${text.split('\n').length} lines in ${seconds}s`,
    6000
  );
}


module.exports = { activate, deactivate };
