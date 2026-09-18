'use strict';
const vscode = require('vscode');
const { log } = require('./log');
const validate = require('./validate');
const { clipText } = require('./notebook');

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
  opts = {},
  blocking = true,
  onLateApproval,
}) {
  // Coerced, not assumed. This function promises never to throw, and a throw
  // here propagates out of the bridge's HTTP handler.
  const code = typeof preview === 'string' ? preview : String(preview == null ? '' : preview);
  if (!code.trim()) return { run: false, reason: 'there is nothing to run' };

  // An unrecognised caller must not inherit a permissive setting. LABEL is
  // already the list of surfaces we know about, so it is also the allow-list.
  if (!Object.prototype.hasOwnProperty.call(LABEL, intent)) {
    return { run: false, reason: 'unrecognised caller' };
  }

  // Restricted Mode means the user has said they do not trust this folder.
  // Running model-written code in it is exactly what they declined.
  if (vscode.workspace.isTrusted === false) {
    return { run: false, reason: 'this workspace is not trusted' };
  }

  // A caller may always decline execution; it may never demand it.
  if (requested === false) return { run: false, reason: 'the caller asked for it not to run' };

  // Anything that is not exactly one of the three known modes means never, so a
  // typo in settings.json ("alway") fails closed instead of falling through to
  // the ask path.
  const mode = validate.oneOf(
    intent === 'bridge' ? opts.bridgeExecution : opts.execution,
    ['never', 'ask', 'always'],
    'never'
  );
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
    askLater(intent, code, onLateApproval);
    return { run: false, pending: true, reason: 'waiting for your approval in VS Code' };
  }
  return askNow(intent, code);
}

const PREVIEW_LIMIT = 900;

function promptFor(intent, preview) {
  // What you approve is the WHOLE cell; what you were shown was the first 900
  // characters and a bare "...", which reads as the end of the code rather than
  // as a warning that 1,900 characters are hidden below it. The tail is exactly
  // where anything nasty would sit. Say the real number, and cut on a line
  // boundary so the last visible line is a whole line. clipText is the shared
  // clipper, so a surrogate pair cannot be halved here either.
  const clipped = preview.length > PREVIEW_LIMIT;
  let detail = preview;
  if (clipped) {
    const head = clipText(preview, PREVIEW_LIMIT);
    const lastBreak = head.lastIndexOf('\n');
    const shown = lastBreak > PREVIEW_LIMIT / 2 ? head.slice(0, lastBreak) : head;
    detail =
      `Showing the first ${shown.length} of ${preview.length} characters. ` +
      `Read the whole cell before approving.\n\n${shown}\n\n` +
      `[${preview.length - shown.length} more characters not shown]`;
  }
  const buttons = ['Run it'];
  // No blanket grant for code another program pushed in. The grant is keyed on
  // intent alone, so one click on one agent's harmless-looking cell approved
  // EVERY later push from ANY local program for the life of the window -
  // measured: three pushes, one dialog shown, all three executed. Your own
  // generations keep the convenience, because you asked for each of them by
  // name; nothing asks you before an agent pushes.
  // Never offer a blanket grant off a preview the user could not fully read:
  // "always" would be answered on the strength of a partial cell.
  if (intent !== 'bridge' && !clipped) buttons.push('Always run these this session');
  // Modal on purpose: a consent prompt that can be missed is not consent.
  return vscode.window.showWarningMessage(
    `Run this ${LABEL[intent] || 'generated'} code in your notebook?`,
    { modal: true, detail },
    ...buttons
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
