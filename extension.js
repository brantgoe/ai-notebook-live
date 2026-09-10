'use strict';
const path = require('path');
const vscode = require('vscode');
const { settings } = require('./src/config');
const { log, show: showLog, dispose: disposeLog } = require('./src/log');
const { CellWriter, readOutputs, runCell } = require('./src/notebook');
const prompts = require('./src/prompt');
const {
  stream,
  resolveProvider,
  ProviderError,
  SECRET_KEY,
  invalidateSecretCache,
  invalidateCliCache,
} = require('./src/provider');
const { Bridge } = require('./src/bridge');
const {
  decideExecution,
  forgetSessionGrants,
  activeGrants,
} = require('./src/policy');

const state = {
  /** @type {vscode.CancellationTokenSource | undefined} */
  active: undefined,
  /** @type {vscode.NotebookDocument | undefined} */
  lastNotebook: undefined,
  lastInstruction: '',
  status: undefined,
  bridge: undefined,
  providerLabel: '',
  context: undefined,
};

function activate(context) {
  state.context = context;
  state.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(state.status);
  idle();

  state.bridge = new Bridge({
    resolveNotebook: (hint) => targetNotebook(hint),
    listNotebooks: () =>
      vscode.workspace.notebookDocuments
        .filter((d) => !d.isClosed)
        .map((d) => path.basename(d.uri.fsPath)),
    decideRun: (req) => decideExecution({ ...req, intent: 'bridge', opts: settings() }),
  });

  // The provider probe is cached, so anything that could change its answer has
  // to say so: a stored key changing, or the CLI path setting being edited.
  if (context.secrets.onDidChange) {
    context.subscriptions.push(
      context.secrets.onDidChange((e) => {
        if (!e || e.key === SECRET_KEY) invalidateSecretCache();
      })
    );
  }
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('aiNotebookLive.claudePath') ||
        e.affectsConfiguration('aiNotebookLive.provider')
      ) {
        invalidateCliCache();
      }
      // Changing the policy is a fresh statement of intent; a stale "allow for
      // this session" must not survive it.
      if (
        e.affectsConfiguration('aiNotebookLive.execution') ||
        e.affectsConfiguration('aiNotebookLive.bridge.execution')
      ) {
        forgetSessionGrants();
      }
      if (e.affectsConfiguration('aiNotebookLive')) renderStatus();
    })
  );

  rememberNotebook(vscode.window.activeNotebookEditor);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveNotebookEditor((editor) => {
      rememberNotebook(editor);
      if (!state.active) idle();
    })
  );

  const register = (name, handler) =>
    context.subscriptions.push(vscode.commands.registerCommand(name, handler));

  register('aiNotebookLive.generate', (arg) => guard('generate', (ctx) => generate(arg, ctx)));
  register('aiNotebookLive.reviseCell', (arg) => guard('revise', (ctx) => revise(arg, ctx)));
  register('aiNotebookLive.explainCell', (arg) => guard('explain', (ctx) => explain(arg, ctx)));
  register('aiNotebookLive.fixError', (arg) => guard('fix', (ctx) => fixError(arg, ctx)));
  register('aiNotebookLive.cancel', () => {
    if (state.active) {
      state.active.cancel();
      vscode.window.setStatusBarMessage('$(stop-circle) AI generation cancelled', 2500);
    }
  });
  register('aiNotebookLive.setApiKey', setApiKey);
  register('aiNotebookLive.clearApiKey', async () => {
    await context.secrets.delete(SECRET_KEY);
    invalidateSecretCache();
    const still = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
    vscode.window.showInformationMessage(
      still
        ? 'AI Notebook Live: stored key removed - but ANTHROPIC_API_KEY is still set in your environment and will be used.'
        : 'AI Notebook Live: stored Anthropic API key removed.'
    );
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
  register('aiNotebookLive.controlPanel', showControlPanel);
  register('aiNotebookLive.showLog', showLog);

  // Warm the probe so the first Ctrl+Alt+G costs no I/O.
  resolveProvider(settings(), context.secrets).catch(() => {});

  if (settings().bridgeAutoStart) startBridge(false);
  log('activated');
}

async function deactivate() {
  forgetSessionGrants();
  if (state.bridge) await state.bridge.stop();
  disposeLog();
}

/* ------------------------------- UI plumbing ------------------------------ */

const MODE_LABEL = { never: 'Never', ask: 'Ask each time', always: 'Always' };

/**
 * The always-visible half of the control panel.
 *
 * Before this the bridge could be listening - accepting code from any local
 * process - with nothing anywhere in the UI saying so.
 */
function renderStatus() {
  const item = state.status;
  if (!item) return;
  const opts = settings();
  const running = Boolean(state.bridge && state.bridge.running);
  const armed = opts.execution === 'always' || opts.bridgeExecution === 'always';

  const bits = ['$(sparkle) AI'];
  if (running) bits.push('$(plug)');
  if (armed) bits.push('$(play)');
  item.text = bits.join(' ');

  const md = new vscode.MarkdownString(
    [
      '**AI Notebook Live**',
      '',
      `Provider: ${state.providerLabel || 'not checked yet'}`,
      `Agent bridge: ${running ? `listening on 127.0.0.1:${state.bridge.port}` : 'stopped'}`,
      `Run AI code: **${MODE_LABEL[opts.execution] || opts.execution}**`,
      `Run agent code: **${MODE_LABEL[opts.bridgeExecution] || opts.bridgeExecution}**`,
      '',
      '_Click to open the control panel._',
    ].join('\n')
  );
  item.tooltip = md;
  item.command = 'aiNotebookLive.controlPanel';
  if (vscode.window.activeNotebookEditor) item.show();
  else item.hide();
}

// Kept as the name the rest of the file already uses for "not busy".
function idle() {
  renderStatus();
}

async function pickMode(title, current) {
  const rows = ['never', 'ask', 'always'].map((mode) => ({
    label: MODE_LABEL[mode],
    description: mode === current ? '$(check) current' : '',
    mode,
  }));
  const pick = await vscode.window.showQuickPick(rows, { title, placeHolder: title });
  return pick && pick.mode;
}

/**
 * The control panel: one menu that shows what this extension will actually do,
 * and lets the user change it. A QuickPick rather than a webview on purpose -
 * it is the command palette, which is the one piece of VS Code UI a beginner
 * has already been taught, and it stays testable.
 */
async function showControlPanel() {
  const opts = settings();
  const running = Boolean(state.bridge && state.bridge.running);
  const grants = activeGrants();

  const rows = [
    {
      label: '$(sparkle) Generate a cell with AI',
      description: 'Ctrl+Alt+G',
      act: () => vscode.commands.executeCommand('aiNotebookLive.generate'),
    },
    {
      label: '$(play) Run AI-generated code',
      description: MODE_LABEL[opts.execution],
      detail: 'What happens after Claude finishes writing a cell for you.',
      act: async () => {
        const mode = await pickMode('Run AI-generated code', opts.execution);
        if (mode) await update('execution', mode);
      },
    },
    {
      label: '$(shield) Run code pushed in by agents',
      description: MODE_LABEL[opts.bridgeExecution],
      detail: 'Applies to cells that arrive over the local bridge from another tool.',
      act: async () => {
        const mode = await pickMode('Run code pushed in by agents', opts.bridgeExecution);
        if (mode) await update('bridge.execution', mode);
      },
    },
    {
      label: '$(plug) Agent bridge',
      description: running ? `running on 127.0.0.1:${state.bridge.port}` : 'stopped',
      detail: running
        ? 'Any program on this machine holding the token can add cells to this notebook.'
        : 'Let other AI tools write into this notebook.',
      act: async () => {
        if (running) await vscode.commands.executeCommand('aiNotebookLive.stopBridge');
        else await startBridge(true);
      },
    },
    {
      label: '$(key) Provider',
      description: state.providerLabel || 'not checked yet',
      detail: 'Where generated code comes from.',
      act: showProviderMenu,
    },
    {
      label: '$(eye) Send cell outputs to the model',
      description: opts.includeOutputs ? 'On' : 'Off',
      detail: 'Outputs and error tracebacks from earlier cells are included in the prompt.',
      act: () => update('includeOutputs', !opts.includeOutputs),
    },
    {
      label: '$(output) Show log',
      act: () => showLog(),
    },
  ];

  if (grants.length) {
    rows.splice(3, 0, {
      label: '$(unlock) Approved for this session',
      description: grants.join(', '),
      detail: 'Forget these, so you are asked again.',
      act: () => {
        forgetSessionGrants();
        vscode.window.showInformationMessage('AI Notebook Live: session approvals forgotten.');
      },
    });
  }

  const pick = await vscode.window.showQuickPick(rows, {
    title: 'AI Notebook Live',
    placeHolder: 'What should this extension be allowed to do?',
  });
  if (pick && pick.act) await pick.act();
  renderStatus();
}

async function update(key, value) {
  await vscode.workspace
    .getConfiguration('aiNotebookLive')
    .update(key, value, vscode.ConfigurationTarget.Global);
  renderStatus();
}

async function showProviderMenu() {
  let label = state.providerLabel;
  let problem;
  try {
    const target = await resolveProvider(settings(), state.context.secrets);
    label = target.label;
    state.providerLabel = label;
  } catch (err) {
    problem = (err && err.message) || String(err);
  }
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(key) Set an Anthropic API key', act: setApiKey },
      {
        label: '$(folder) Set the path to the claude command',
        act: () =>
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'aiNotebookLive.claudePath'
          ),
      },
      { label: '$(output) Show log', act: () => showLog() },
    ],
    { title: problem ? `Provider: ${problem}` : `Provider: ${label}` }
  );
  if (pick && pick.act) await pick.act();
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
  const opts = settings();
  // Start proving the provider works now, but do not wait on it yet: the probe
  // overlaps with the user typing their instruction, so it costs nothing. What
  // matters is only that it resolves before anything edits the notebook.
  const provider = resolveProvider(opts, state.context.secrets);
  provider.then(
    (target) => {
      state.providerLabel = target.label;
    },
    () => {
      state.providerLabel = '';
    }
  );

  const cts = new vscode.CancellationTokenSource();
  state.active = cts;
  busy(label === 'explain' ? 'explaining' : 'writing');
  vscode.commands.executeCommand('setContext', 'aiNotebookLive.generating', true);
  try {
    await body({ token: cts.token, opts, provider, intent: label });
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
  if (err instanceof ProviderError && err.action === 'install') {
    const pick = await vscode.window.showErrorMessage(
      message,
      'Install Claude Code',
      'Set the claude path',
      'Use an API key',
      'Show Log'
    );
    if (pick === 'Install Claude Code') {
      vscode.env.openExternal(vscode.Uri.parse('https://claude.com/claude-code'));
    }
    if (pick === 'Set the claude path') {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'aiNotebookLive.claudePath'
      );
    }
    if (pick === 'Use an API key') await setApiKey();
    if (pick === 'Show Log') showLog();
    return;
  }
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
  invalidateSecretCache();
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
    // A hint that matches nothing returns undefined rather than falling through
    // to the active notebook: silently writing into a different file than the
    // caller asked for is worse than refusing.
    return open.find((d) => d.uri.fsPath.includes(String(hint)));
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

async function generate(arg, { token, opts, provider, intent }) {
  const editor = requireEditor();
  const notebook = editor.notebook;
  const instruction = await ask(
    'Generate a notebook cell',
    'e.g. ask for the product name and price, then print a receipt'
  );
  if (!instruction) return;

  const target = await provider;
  const index = notebook.cellCount ? editor.selection.end : 0;
  const { system, user } = prompts.generatePrompt({ notebook, index, instruction, opts });
  const writer = await CellWriter.insert(notebook, index, { kind: 'code' });
  await pump({ writer, system, user, opts, token, target, intent });
}

async function revise(arg, { token, opts, provider, intent }) {
  const { notebook, cell } = resolveCell(arg);
  const instruction = await ask(
    'Revise this cell',
    'e.g. handle bad input, add a docstring, use a loop instead'
  );
  if (!instruction) return;

  const target = await provider;
  const { system, user } = prompts.revisePrompt({ notebook, cell, instruction, opts });
  const writer = await CellWriter.replace(notebook, cell);
  await pump({ writer, system, user, opts, token, target, intent });
}

async function fixError(arg, { token, opts, provider, intent }) {
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

  const target = await provider;
  const { system, user } = prompts.fixPrompt({ notebook, cell, opts });
  const writer = await CellWriter.replace(notebook, cell);
  await pump({ writer, system, user, opts, token, target, intent });
}

async function explain(arg, { token, opts, provider, intent }) {
  const { notebook, cell } = resolveCell(arg);
  const target = await provider;
  const { system, user } = prompts.explainPrompt({ notebook, cell, opts });
  const writer = await CellWriter.insert(notebook, cell.index, {
    kind: 'markdown',
    fenced: false,
  });
  await pump({ writer, system, user, opts, token, target, intent, requested: false });
}

/** The directory the `claude` CLI should run in: the notebook's own project. */
function workingDirFor(notebook) {
  const folder = vscode.workspace.getWorkspaceFolder(notebook.uri);
  if (folder) return folder.uri.fsPath;
  return notebook.uri.scheme === 'file' ? path.dirname(notebook.uri.fsPath) : undefined;
}

/**
 * Explains why a generation stopped. A timeout and a deliberate cancel both
 * arrive here as `cancelled`, but they mean opposite things to the user: one
 * they did, the other happened to them.
 */
function reportStop(gaveUp, silence) {
  if (!gaveUp) {
    vscode.window.setStatusBarMessage('$(stop-circle) AI generation cancelled', 2500);
    return;
  }
  vscode.window
    .showWarningMessage(
      `AI Notebook Live: no output for ${Math.round(silence / 1000)}s, so it gave up. ` +
        'Anything already written was kept.',
      'Show Log'
    )
    .then((pick) => {
      if (pick === 'Show Log') showLog();
    });
}

/** Runs one streaming request and lands every token in the cell as it arrives. */
async function pump({ writer, system, user, opts, token, target, intent, requested }) {
  const started = Date.now();
  opts = { ...opts, cwd: workingDirFor(writer.notebook) };
  // A provider that never settles used to wedge the extension permanently:
  // guard()'s finally never ran, state.active was never cleared, and every
  // later command was refused with "already writing a cell" for the life of
  // the window. The timer lives here rather than in the provider because
  // onText is already threaded through both of them, so one timer covers the
  // API and the CLI alike.
  //
  // It measures SILENCE, not elapsed time: a model can think for minutes
  // without emitting a token, and interrupting that would be wrong.
  const silence = Math.max(30, Number(opts.timeoutSeconds) || 300) * 1000;
  let idle;
  let gaveUp = false;
  const restartIdleTimer = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      gaveUp = true;
      log(`no output for ${silence / 1000}s; giving up`);
      // Cancelling rather than killing: the cancellation path already stops the
      // child, settles the promise and keeps whatever text arrived.
      if (state.active) state.active.cancel();
    }, silence);
  };

  let result;
  try {
    restartIdleTimer();
    result = await stream({
      target,
      system,
      user,
      opts,
      token,
      onText: (chunk) => {
        restartIdleTimer();
        writer.write(chunk);
      },
    });
  } catch (err) {
    if (idle) clearTimeout(idle);
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
        .then(async (pick) => {
          if (!pick) return;
          const kept = await writer.keepPartial(partial);
          if (!kept) {
            vscode.window.showWarningMessage(
              'AI Notebook Live: that cell is gone, so there was nothing to put back.'
            );
          }
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
  // One gate for every execution in the extension. `fixError` used to bypass
  // the user's setting entirely by hard-coding run:true, which mattered because
  // its prompt is built from cell outputs - text an attacker can influence.
  if (text.trim() && !result.cancelled && !result.refused) {
    const decision = await decideExecution({ intent, requested, preview: text, opts });
    log(`execution: ${decision.run ? 'ran' : 'did not run'} - ${decision.reason}`);
    if (decision.run) await runCell(writer.notebook, writer.index);
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  log(
    `${result.provider} (${result.model || opts.model}) wrote ${text.length} chars in ${seconds}s`,
    result.stopReason ? `stop_reason=${result.stopReason}` : ''
  );

  if (result.cancelled || (token && token.isCancellationRequested)) {
    reportStop(gaveUp, silence);
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
