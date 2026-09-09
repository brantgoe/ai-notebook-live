'use strict';
const vscode = require('vscode');

function cfg() {
  return vscode.workspace.getConfiguration('aiNotebookLive');
}

function settings() {
  const c = cfg();
  return {
    provider: c.get('provider', 'auto'),
    claudePath: (c.get('claudePath', '') || '').trim(),
    model: c.get('model', 'claude-opus-5'),
    effort: c.get('effort', 'medium'),
    maxTokens: c.get('maxTokens', 8000),
    contextCells: c.get('contextCells', 12),
    includeOutputs: c.get('includeOutputs', true),
    autoRun: c.get('autoRun', false),
    systemPromptExtra: c.get('systemPromptExtra', ''),
    refusalFallback: c.get('refusalFallback', true),
    bridgeAutoStart: c.get('bridge.autoStart', false),
    bridgePort: c.get('bridge.port', 37417),
  };
}

module.exports = { settings };
