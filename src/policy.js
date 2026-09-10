'use strict';
const vscode = require('vscode');
const { log } = require('./log');

/**
 * The single gate on executing a notebook cell.
 *
 * Every execution in this extension goes through here - the four AI commands
 * and the agent bridge alike. Before this existed the decision was scattered:
 * `fixError` hard-coded run:true and ignored the user's setting entirely, and
 * a bridge caller could append ?run=1 to override it. Two different surfaces,
 * neither of them the user, deciding whether code runs in their kernel.
 */

const LABEL = {
  generate: 'newly generated',
  revise: 'revised',
  fix: 'AI-repaired',
  explain: 'explanatory',
  bridge: 'agent-supplied',
};

/**
 * Approvals that last until the window closes. Deliberately in memory and never
 * persisted: a grant that outlived the session would be a setting wearing a
 * consent prompt's clothing.
 * @type {Map<string, 'allow' | 'deny'>}
 */
const sessionGrants = new Map();

function forgetSessionGrants() {
  sessionGrants.clear();
}

function sessionGrant(intent) {
  return sessionGrants.get(intent);
}

/** Everything currently approved for the session, for the control panel to show. */
function activeGrants() {
  return [...sessionGrants.entries()]
    .filter(([, v]) => v === 'allow')
    .map(([intent]) => intent);
}

/**
 * @param {object} req
 * @param {'generate'|'revise'|'fix'|'explain'|'bridge'} req.intent
 * @param {boolean} [req.requested]  what the caller asked for; may only ever
 *   LOWER the decision, never raise it.
 * @param {string} req.preview       the code that would run
 * @param {object} req.opts          from settings()
 * @param {boolean} [req.blocking]   false: never wait on a human (the bridge,
 *   which is holding an HTTP socket open)
 * @param {(intent: string) => Promise<void>} [req.onLateApproval]
 * @returns {Promise<{run: boolean, reason: string, pending?: boolean}>}
 */
async function decideExecution({
  intent,
  requested,
  preview,
  opts,
  blocking = true,
  onLateApproval,
}) {
  if (!preview || !preview.trim()) return { run: false, reason: 'there is nothing to run' };

  // Restricted Mode means the user has said they do not trust this folder.
  // Running model-written code in it is exactly what they declined.
  if (vscode.workspace.isTrusted === false) {
    return { run: false, reason: 'this workspace is not trusted' };
  }

  // A caller may always decline execution; it may never demand it.
  if (requested === false) return { run: false, reason: 'the caller asked for it not to run' };

  const mode = intent === 'bridge' ? opts.bridgeExecution : opts.execution;
  if (mode === 'never') {
    return {
      run: false,
      reason:
        intent === 'bridge'
          ? 'running agent-supplied code is turned off'
          : 'running generated code is turned off',
    };
  }

  const grant = sessionGrant(intent);
  if (grant === 'deny') return { run: false, reason: 'you declined this for the session' };
  if (mode === 'always') return { run: true, reason: 'set to always run' };
  if (grant === 'allow') return { run: true, reason: 'you approved these for this session' };

  // 'ask' from here down.
  if (!blocking) {
    // The bridge is holding a socket open, so never make an HTTP client wait on
    // a human. Answer now, prompt afterwards, run it if the answer is yes.
    askLater(intent, preview, onLateApproval);
    return { run: false, pending: true, reason: 'waiting for your approval in VS Code' };
  }
  return askNow(intent, preview);
}

function promptFor(intent, preview) {
  const detail = preview.length > 900 ? `${preview.slice(0, 900)}\n...` : preview;
  // Modal on purpose: a consent prompt that can be missed is not consent.
  return vscode.window.showWarningMessage(
    `Run this ${LABEL[intent] || 'generated'} code in your notebook?`,
    { modal: true, detail },
    'Run it',
    'Always run these this session'
  );
}

async function askNow(intent, preview) {
  const pick = await promptFor(intent, preview);
  if (pick === 'Always run these this session') {
    sessionGrants.set(intent, 'allow');
    return { run: true, reason: 'you approved these for this session' };
  }
  if (pick === 'Run it') return { run: true, reason: 'you approved it' };
  sessionGrants.set(intent, 'deny');
  return { run: false, reason: 'you declined' };
}

function askLater(intent, preview, onLateApproval) {
  promptFor(intent, preview).then(
    async (pick) => {
      if (pick === 'Always run these this session') sessionGrants.set(intent, 'allow');
      else if (pick !== 'Run it') {
        sessionGrants.set(intent, 'deny');
        return;
      }
      if (onLateApproval) {
        try {
          await onLateApproval(intent);
        } catch (err) {
          log('late approval failed:', (err && err.message) || String(err));
        }
      }
    },
    () => {}
  );
}

module.exports = { decideExecution, forgetSessionGrants, activeGrants, sessionGrant, LABEL };
