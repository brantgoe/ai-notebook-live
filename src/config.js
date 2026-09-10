'use strict';
const vscode = require('vscode');
// One-way: validate.js depends on nothing, so this cannot cycle.
const { clamp, inRangeOr } = require('./validate');

function cfg() {
  return vscode.workspace.getConfiguration('aiNotebookLive');
}

/** True when the user has set this key anywhere, as opposed to inheriting its default. */
function isSet(c, key) {
  const seen = c.inspect ? c.inspect(key) : undefined;
  if (!seen) return false;
  return (
    seen.globalValue !== undefined ||
    seen.workspaceValue !== undefined ||
    seen.workspaceFolderValue !== undefined
  );
}

/**
 * Resolves the tri-state execution policy, honouring the boolean it replaced.
 *
 * `get()` alone cannot tell "explicitly false" from "never touched", so this
 * has to inspect: someone who deliberately turned autoRun off must not be
 * migrated into being asked, and someone who turned it on must not silently
 * stop having their cells run.
 */
function executionMode(c) {
  if (isSet(c, 'execution')) return c.get('execution', 'ask');
  if (isSet(c, 'autoRun')) return c.get('autoRun', false) ? 'always' : 'never';
  return 'ask';
}

function settings() {
  const c = cfg();
  return {
    provider: c.get('provider', 'auto'),
    claudePath: (c.get('claudePath', '') || '').trim(),
    model: c.get('model', 'claude-opus-5'),
    effort: c.get('effort', 'medium'),
    maxTokens: clamp(c.get('maxTokens', 8000), 1, 64000, 8000),
    contextCells: (() => {
      const raw = Number(c.get('contextCells', 12));
      if (raw === -1) return -1; // -1 means the whole notebook
      return inRangeOr(raw, 0, 500, 12);
    })(),
    includeOutputs: c.get('includeOutputs', true) !== false,
    execution: executionMode(c),
    // Deliberately NOT migrated from autoRun: letting a local agent execute code
    // is a different decision from letting your own Ctrl+Alt+G do it, and it was
    // never opted into explicitly. Default off; the control panel turns it on.
    bridgeExecution: c.get('bridge.execution', 'never'),
    // Kept so the deprecated setting still reads back for the control panel.
    autoRun: c.get('autoRun', false),
    // Workspace-settable (that is the classroom house-style case), but capped so
    // it cannot become an essay, and ignored entirely in an untrusted folder via
    // the restrictedConfigurations declaration in package.json.
    systemPromptExtra: String(c.get('systemPromptExtra', '') || '').slice(0, 2000),
    refusalFallback: c.get('refusalFallback', true) !== false,
    bridgeAutoStart: c.get('bridge.autoStart', false) === true,
    bridgePort: (() => {
      const raw = Number(c.get('bridge.port', 37417));
      if (raw === 0) return 0; // 0 means "pick a free port"
      return inRangeOr(raw, 1024, 65535, 37417);
    })(),
  };
}

module.exports = { settings };
