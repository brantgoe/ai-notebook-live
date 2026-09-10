'use strict';
const path = require('path');
const vscode = require('vscode');
const { settings } = require('./src/config');
const { log, show: showLog, dispose: disposeLog } = require('./src/log');
const { CellWriter, readOutputs, runCell, runApproved } = require('./src/notebook');
const validate = require('./src/validate');
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
    // The bridge has no vscode of its own, so anything the user needs to see -
    // a cell an agent overwrote, an approval that no longer matched - comes back
    // out through here.
    notify: (kind, message) => {
      if (kind === 'warning') vscode.window.showWarningMessage(message);
      else vscode.window.showInformationMessage(message);
    },
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
    const was = state.bridge.running;
    await state.bridge.stop();
    renderStatus();
    vscode.window.showInformationMessage(
      was
        ? 'AI Notebook Live: agent bridge stopped.'
        : 'AI Notebook Live: the agent bridge was not running.'
    );
  });
  register('aiNotebookLive.copyBridgeInfo', async () => {
    // Running a command called "Copy ... Example Command" used to open a
    // listening socket as a side effect, silently, while the README said the
    // bridge was off by default. Announce it if we start it.
    const started = !state.bridge.running;
    if (started) await startBridge(false);
    if (!state.bridge.running) return;
    if (started) {
      vscode.window.showInformationMessage(
        `AI Notebook Live: started the agent bridge on 127.0.0.1:${state.bridge.port} so this command works. ` +
          'Other local programs can now read and write this notebook. Stop it from the control panel.'
      );
    }
    await vscode.env.clipboard.writeText(state.bridge.curlExample());
    vscode.window.showInformationMessage(
      `Copied a ready-to-run bridge command (port ${state.bridge.port}).`
    );
  });
  register('aiNotebookLive.copyAgentSetup', copyAgentSetup);
  register('aiNotebookLive.controlPanel', showControlPanel);
  register('aiNotebookLive.showLog', showLog);

  // Warm the probe so the first Ctrl+Alt+G costs no I/O.
  resolveProvider(settings(), context.secrets).catch(() => {});

  if (settings().bridgeAutoStart) startBridge(false);
  log('activated');
}

async function deactivate() {
  // First, because a reload or a disable mid-generation otherwise orphans the
  // `claude` child: reparented to init, still holding the user's plan quota,
  // with no window left that could cancel it. Cancelling also clears the
  // writer's 60ms flush timer.
  if (state.active) {
    state.active.cancel();
    // Cleared as well as cancelled: leaving it set means guard() refuses every
    // command with "already writing a cell" if this window is ever reused.
    state.active = undefined;
  }
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
      label: '$(plug) Let another AI tool write here',
      description: 'Codex, or anything that speaks MCP',
      detail: 'Copies the one-line command that registers this notebook as a tool.',
      act: copyAgentSetup,
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

/**
 * Hands another AI tool the one line it needs to be able to write cells here.
 *
 * The path has to be resolved at runtime: it lives inside the installed
 * extension directory, which carries the version number and therefore changes
 * on every upgrade. Nobody should be typing it from memory.
 */
async function copyAgentSetup() {
  const server = state.context.asAbsolutePath(path.join('bin', 'mcp-server.js'));
  const line = `codex mcp add ai-notebook -- node ${JSON.stringify(server)}`;
  const pick = await vscode.window.showInformationMessage(
    'Register this notebook with an AI tool that speaks MCP, so it can add cells here directly.',
    'Copy command for Codex',
    'Show the path'
  );
  if (pick === 'Copy command for Codex') {
    await vscode.env.clipboard.writeText(line);
    vscode.window.showInformationMessage(
      'Copied. Run it in a terminal, then restart Codex. Start the bridge before asking it to write.'
    );
  }
  if (pick === 'Show the path') {
    await vscode.env.clipboard.writeText(server);
    vscode.window.showInformationMessage(`Copied the server path: ${server}`);
  }
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
    // Re-read: the generation may well have finished while this dialog sat
    // open, and dereferencing the stale value threw a TypeError - reported to
    // the user as a failure of the command they were trying to run.
    if (pick === 'Cancel it' && state.active) state.active.cancel();
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
    await body({ token: cts.token, opts, provider, intent: label, cancel: () => cts.cancel() });
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
  // The manifest tells the user, in the Restricted Mode dialog, that "the agent
  // bridge does not start" in a folder they have not trusted. Nothing enforced
  // it: isTrusted appeared exactly once in the whole extension, gating execution
  // only. Execution being blocked did make this content-injection rather than
  // RCE - but a security property stated in a trust dialog has to be real.
  if (vscode.workspace.isTrusted === false) {
    log('bridge not started: this folder is not trusted');
    if (announce) {
      vscode.window.showWarningMessage(
        'AI Notebook Live: the agent bridge does not start in a folder you have not trusted. ' +
          'Trust this folder if you want other local tools to write here.'
      );
    }
    return;
  }
  try {
    const { port } = await state.bridge.start(settings().bridgePort);
    log(`bridge token written to ${state.bridge.infoFile}`);
    // The status bar plug exists precisely so a listening socket is never
    // invisible - and it did not repaint when the socket opened, which is the
    // one moment it is there for.
    renderStatus();
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

async function generate(arg, { token, opts, provider, intent, cancel }) {
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
  await pump({ writer, system, user, opts, token, target, intent, cancel });
}

async function revise(arg, { token, opts, provider, intent, cancel }) {
  const { notebook, cell } = resolveCell(arg);
  const instruction = await ask(
    'Revise this cell',
    'e.g. handle bad input, add a docstring, use a loop instead'
  );
  if (!instruction) return;

  const target = await provider;
  const { system, user } = prompts.revisePrompt({ notebook, cell, instruction, opts });
  const writer = await CellWriter.replace(notebook, cell);
  await pump({ writer, system, user, opts, token, target, intent, cancel });
}

async function fixError(arg, { token, opts, provider, intent, cancel }) {
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
  await pump({ writer, system, user, opts, token, target, intent, cancel });
}

async function explain(arg, { token, opts, provider, intent, cancel }) {
  const { notebook, cell } = resolveCell(arg);
  const target = await provider;
  const { system, user } = prompts.explainPrompt({ notebook, cell, opts });
  const writer = await CellWriter.insert(notebook, cell.index, {
    kind: 'markdown',
    fenced: false,
  });
  await pump({ writer, system, user, opts, token, target, intent, cancel, requested: false });
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

/**
 * Undo a failed generation, and offer the partial back when that is safe.
 *
 * Shared by both failure paths - the stream throwing, and the final reconcile
 * throwing - because the second one used to skip all of this.
 *
 * The distinction that matters is whether the cell was actually put back.
 * abandon() declines to restore when the user has typed into the cell, since it
 * cannot overwrite what they wrote. This used to say "your cell was put back"
 * regardless, which was false exactly when it mattered most, and then offered a
 * button that wrote the AI's partial over their typing - losing the original
 * AND the typing, with a message that told them the opposite.
 */
async function undoAndOffer(writer) {
  // The writer knows what undoing itself means: delete a cell we created, hand
  // back a cell we borrowed. pump does not have to be told.
  let restored;
  let partial;
  try {
    ({ restored, partial } = await writer.abandon());
  } catch (err) {
    // Whatever stopped the write usually stops the undo too - a read-only
    // notebook fails both. This must not replace the original error, which is
    // the one that explains what actually happened.
    log('could not undo the failed generation:', err && err.message);
    vscode.window.showWarningMessage(
      'AI Notebook Live: that failed partway and the cell could not be put back — the notebook may be ' +
        'read-only or closed. Ctrl+Z steps back to how it looked before the AI started.'
    );
    return;
  }
  if (writer.origin !== 'replace' || !partial.trim()) return;

  if (!restored) {
    if (writer.foreign) {
      vscode.window.showWarningMessage(
        'AI Notebook Live: that failed partway. You had edited the cell, so it was left exactly as you typed it - ' +
          'nothing of yours was overwritten. Ctrl+Z steps back to how it looked before the AI started.'
      );
    } else {
      vscode.window.showWarningMessage(
        'AI Notebook Live: that failed partway and the cell could not be put back - it may have been removed or the ' +
          'notebook may be read-only. Ctrl+Z steps back to how it looked before the AI started.'
      );
    }
    return;
  }

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
          'AI Notebook Live: that cell has changed since, so there was nothing safe to put back.'
        );
      }
    })
    // Deliberately not awaited - pump must not hold the command open waiting on
    // a dialog - but the rejection used to be unhandled. keepPartial is what
    // makes the delay safe: it refuses if the cell moved on meanwhile.
    .then(undefined, (err) => log('offering the partial back failed:', err && err.message));
}

/** Runs one streaming request and lands every token in the cell as it arrives. */
async function pump({ writer, system, user, opts, token, target, intent, requested, cancel }) {
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
  let repaired = 0;
  const restartIdleTimer = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      gaveUp = true;
      log(`no output for ${silence / 1000}s; giving up`);
      // Cancelling rather than killing: the cancellation path already stops the
      // child, settles the promise and keeps whatever text arrived.
      //
      // Its OWN request, not state.active - which by the time a stray timer
      // fires is whatever is running now. Measured: five generations left five
      // live timers, and one of them killed a healthy stream 30s later, which
      // the user was then told was their own cancellation.
      cancel();
    }, silence);
  };

  // Cleared in a finally, not only in the catch. Every SUCCESSFUL generation
  // used to leave its timer armed for the whole silence window, holding the
  // writer - and through it the notebook - alive, and then cancelling whatever
  // unrelated generation happened to be running when it fired.
  try {
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
          // The one path that was never validated. cellText guarded all three
          // BRIDGE entry points and nothing at all here - where the traffic
          // actually is. Measured: a raw ESC, a NUL, a U+2028 and a lone
          // surrogate all reached the cell straight from the model, and the
          // surrogate is precisely the failure cellText exists to prevent - the
          // .ipynb saves fine and then nbformat, nbconvert and papermill cannot
          // read it back. A model need only echo one out of a cell output it
          // was shown.
          //
          // Repaired rather than refused: throwing here would discard a whole
          // generation the user waited for, over something invisible.
          const clean = validate.cellText(chunk, { mode: 'sanitize' });
          if (clean.repaired) {
            repaired += clean.repaired;
            log(`repaired ${clean.repaired} character(s) the kernel could not have run`);
          }
          writer.write(clean.text);
        },
      });
    } catch (err) {
      if (idle) clearTimeout(idle);
      await undoAndOffer(writer);
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

    let text = '';
    if (writer.produced()) {
      try {
        text = await writer.end();
      } catch (err) {
        // end() throws when the final reconcile could not be applied - a
        // read-only notebook, a cell removed mid-stream, an earlier flush that
        // failed. This sat OUTSIDE the try above, so it went straight to the
        // command's error handler with no abandon() at all: the user's cell kept
        // a half-written AI statement, permanently, and nothing was offered.
        if (idle) clearTimeout(idle);
        await undoAndOffer(writer);
        throw err;
      }
    }
    // The user typed into the cell mid-stream, so the writer stopped and end()
    // returned the DOCUMENT - which is their text, not the model's. Everything
    // below assumes `text` came from the model, so none of it applies.
    //
    // This is the gate the 0.3.0 ownership work existed to make possible, and it
    // was never wired up: `foreign` was set and then read by nothing outside the
    // test suite. Measured, with execution 'always': the user's own half-typed
    // line was executed in their kernel. Under 'ask' the modal showed them their
    // own code and asked whether to run "this newly generated code".
    if (writer.foreign) {
      log('execution: did not run - the cell was edited while it was being written');
      vscode.window.showInformationMessage(
        'AI Notebook Live: you edited that cell while it was being written, so the AI stopped and kept your version. ' +
          'Nothing was run.'
      );
      return;
    }

    // One gate for every execution in the extension. `fixError` used to bypass
    // the user's setting entirely by hard-coding run:true, which mattered because
    // its prompt is built from cell outputs - text an attacker can influence.
    if (text.trim() && !result.cancelled && !result.refused) {
      const decision = await decideExecution({ intent, requested, preview: text, opts });
      log(`execution: ${decision.run ? 'ran' : 'did not run'} - ${decision.reason}`);
      // Checked against what was approved, not just which cell: a bridge caller
      // can rewrite the cell while an 'ask' dialog is open.
      if (decision.run && !(await runApproved(writer.notebook, writer.index, text))) {
        log(`execution declined: cell ${writer.index} changed before it could run`);
      }
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
  if (repaired) {
      vscode.window.showInformationMessage(
        `AI Notebook Live: cleaned up ${repaired} invisible character${repaired === 1 ? '' : 's'} ` +
          'the model emitted that Python cannot parse - a non-breaking space, usually.'
      );
    }
    vscode.window.setStatusBarMessage(
      `$(sparkle) AI wrote ${text.split('\n').length} lines in ${seconds}s`,
      6000
    );
  } finally {
    if (idle) clearTimeout(idle);
  }
}


module.exports = {
  activate,
  deactivate,
  // A seam for the one thing a test cannot otherwise set up: a generation that
  // is still in flight when the window goes away.
  __test: {
    setActive: (cts) => {
      state.active = cts;
    },
  },
};
