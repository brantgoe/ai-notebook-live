'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { log } = require('./log');

const SECRET_KEY = 'aiNotebookLive.anthropicApiKey';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

class ProviderError extends Error {
  constructor(message, { action } = {}) {
    super(message);
    this.action = action;
  }
}

// The secret store is a keychain round trip, and on a locked keyring it can
// raise a password prompt - so it is read once and invalidated by event.
let secretCache = { valid: false, value: undefined };

function invalidateSecretCache() {
  secretCache = { valid: false, value: undefined };
}

async function storedApiKey(secrets) {
  if (!secretCache.valid) {
    secretCache = { valid: true, value: secrets ? await secrets.get(SECRET_KEY) : undefined };
  }
  // Environment variables are re-read every time: they cost nothing and a
  // terminal-launched window can pick them up mid-session.
  if (secretCache.value) return { key: secretCache.value, source: 'secret' };
  if (process.env.ANTHROPIC_API_KEY) return { key: process.env.ANTHROPIC_API_KEY, source: 'env' };
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    return { key: process.env.ANTHROPIC_AUTH_TOKEN, source: 'env' };
  }
  return { key: undefined, source: 'none' };
}

// The PATH scan stats every directory on PATH, so it is cached - but on a TTL,
// not forever: someone who is told to install the CLI must not have to reload
// the window afterwards.
/** A single stdout line longer than this is a runaway, not a cell. */
const MAX_LINE = 8 * 1024 * 1024;
/** Only the last lines of stderr are ever reported to the user. */
const MAX_STDERR = 64 * 1024;
const CLI_TTL_MS = 30_000;
let cliCache = { at: 0, hint: null, found: false, binary: undefined, source: 'none' };

function candidatePaths(explicit) {
  const home = os.homedir();
  const paths = [];
  if (explicit) paths.push([explicit, 'setting']);
  if (process.env.CLAUDE_CODE_EXECPATH) paths.push([process.env.CLAUDE_CODE_EXECPATH, 'env']);
  paths.push([path.join(home, '.local', 'bin', 'claude'), 'local']);
  paths.push(['/usr/local/bin/claude', 'usr-local']);
  paths.push([path.join(home, '.claude', 'local', 'claude'), 'claude-local']);
  paths.push(['/opt/homebrew/bin/claude', 'homebrew']);
  paths.push(['/home/linuxbrew/.linuxbrew/bin/claude', 'linuxbrew']);
  paths.push([path.join(home, '.bun', 'bin', 'claude'), 'bun']);
  // nvm keeps npm globals under a per-version directory, so a CLI installed
  // there is invisible unless that exact Node version is active.
  try {
    const versions = path.join(home, '.nvm', 'versions', 'node');
    for (const v of fs.readdirSync(versions)) {
      paths.push([path.join(versions, v, 'bin', 'claude'), 'nvm']);
    }
  } catch {
    /* no nvm */
  }
  return paths;
}

function locateClaude(explicit) {
  const hint = explicit || null;
  if (cliCache.hint === hint && Date.now() - cliCache.at < CLI_TTL_MS) return cliCache;
  let found = false;
  let binary;
  let source = 'none';
  for (const [candidate, why] of candidatePaths(explicit)) {
    try {
      // isFile first: on POSIX the execute bit on a DIRECTORY means "search",
      // so accessSync(X_OK) happily accepted ~/.local/bin. The control panel
      // then reported a healthy provider and the failure surfaced as a raw
      // `spawn EACCES` only after the cell had already been created.
      if (!fs.statSync(candidate).isFile()) throw new Error('not a file');
      fs.accessSync(candidate, fs.constants.X_OK);
      found = true;
      binary = candidate;
      source = why;
      break;
    } catch {
      /* keep looking */
    }
  }
  if (!found) {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      try {
        const candidate = path.join(dir, 'claude');
        fs.accessSync(candidate, fs.constants.X_OK);
        found = true;
        binary = candidate;
        source = 'path';
        break;
      } catch {
        /* keep looking */
      }
    }
  }
  cliCache = { at: Date.now(), hint, found, binary, source };
  return cliCache;
}

function invalidateCliCache() {
  cliCache.at = 0;
}

function claudeBinary(explicit) {
  return locateClaude(explicit).binary || 'claude';
}

/**
 * Decides which backend to use, and proves it is usable.
 *
 * Callers must run this BEFORE touching the notebook: resolving it late is what
 * used to let a missing API key blank a user's cell.
 */
async function resolveProvider(opts, secrets) {
  const { key, source } = await storedApiKey(secrets);
  const where = source === 'secret' ? 'the VS Code secret store' : 'an environment variable';

  if (opts.provider === 'api') {
    if (!key) {
      throw new ProviderError(
        'aiNotebookLive.provider is set to "api", but no API key is stored. Add a key, or set it back to "auto" to use your Claude Code login.',
        { action: 'setKey' }
      );
    }
    return { kind: 'api', key, source, label: `Anthropic API - key from ${where}` };
  }

  if (opts.provider === 'claude-cli') {
    const cli = locateClaude(opts.claudePath);
    if (!cli.found) {
      throw new ProviderError(
        'Could not find the `claude` command. If Claude Code is installed, run `which claude` in a terminal and put that path in aiNotebookLive.claudePath.',
        { action: 'install' }
      );
    }
    return { kind: 'cli', binary: cli.binary, source: cli.source, label: `Claude Code CLI - ${cli.binary}` };
  }

  if (key) return { kind: 'api', key, source, label: `Anthropic API - key from ${where}` };
  const cli = locateClaude(opts.claudePath);
  if (cli.found) {
    return { kind: 'cli', binary: cli.binary, source: cli.source, label: `Claude Code CLI - ${cli.binary}` };
  }
  throw new ProviderError(
    'AI Notebook Live needs either Claude Code (uses your existing Claude login, no API key) or an Anthropic API key.',
    { action: 'install' }
  );
}

/**
 * Streams a completion into onText(chunk).
 * Resolves with { provider, model, stopReason, refused }.
 */
async function stream({ target, system, user, opts, token, onText }) {
  // The target is resolved by the caller, before any notebook edit. Taking it
  // as a parameter means this function structurally cannot fail on a missing
  // key half-way through writing a cell.
  if (!target) throw new Error('stream() requires a resolved provider target.');
  return target.kind === 'api'
    ? streamApi({ system, user, opts, token, onText, apiKey: target.key })
    : streamCli({ system, user, opts, token, onText, binary: target.binary });
}

async function streamApi({ system, user, opts, token, onText, apiKey }) {
  // Required here, not at the top: the SDK is the bulk of the bundle, and a
  // CLI-only user was paying its module initialisation on every notebook open
  // for a code path they never take. esbuild still bundles it; this only
  // defers evaluating it until the first API call.
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  const params = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort: opts.effort },
  };

  const run = async (withFallback) => {
    const active = withFallback
      ? client.beta.messages.stream({
          ...params,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
        })
      : client.messages.stream(params);
    const cancel = token && token.onCancellationRequested(() => active.abort());
    try {
      active.on('text', (delta) => onText(delta));
      const message = await active.finalMessage();
      return {
        provider: 'api',
        model: message.model,
        stopReason: message.stop_reason,
        refused: message.stop_reason === 'refusal',
        refusalDetails: message.stop_details || undefined,
        usage: message.usage,
      };
    } finally {
      if (cancel) cancel.dispose();
    }
  };

  try {
    return await run(Boolean(opts.refusalFallback));
  } catch (err) {
    if (token && token.isCancellationRequested) return { provider: 'api', cancelled: true };
    // The refusal-fallback beta is rejected on some accounts and platforms;
    // that must not cost the user their cell.
    if (opts.refusalFallback && err instanceof Anthropic.BadRequestError) {
      log('retrying without refusal fallbacks:', err.message);
      return run(false);
    }
    throw apiError(err);
  }
}

function apiError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return new ProviderError('Anthropic rejected the API key.', { action: 'setKey' });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ProviderError('Rate limited by the Anthropic API - try again shortly.');
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new ProviderError(`Anthropic rejected the request: ${err.message}`);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError('Could not reach the Anthropic API - check your connection.');
  }
  if (err instanceof Anthropic.APIError) {
    return new ProviderError(`Anthropic API error ${err.status}: ${err.message}`);
  }
  return err;
}

/**
 * Uses the local `claude` CLI in print mode, so the extension works off an
 * existing Claude Code login with no API key.
 */
function streamCli({ system, user, opts, token, onText, binary }) {
  const bin = binary || claudeBinary(opts.claudePath);
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--max-turns',
    '1',
    '--model',
    opts.model,
    '--system-prompt',
    system,
  ];
  log('spawning', bin, 'with model', opts.model);

  return new Promise((resolve, reject) => {
    // Declared up here because the cancellation handler below is created BEFORE
    // the old `let escalate` and assigns to it. That was safe only because
    // VS Code happens to dispatch an already-cancelled token via setTimeout
    // rather than synchronously - an undocumented detail holding off a TDZ
    // ReferenceError.
    let escalate;
    let cwd;
    try {
      if (opts.cwd && fs.statSync(opts.cwd).isDirectory()) cwd = opts.cwd;
    } catch {
      cwd = undefined;
    }
    const child = spawn(bin, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'ai-notebook-live' },
    });
    let cancelled = false;
    const cancel =
      token &&
      token.onCancellationRequested(() => {
        cancelled = true;
        child.kill('SIGTERM');
        // A child that ignores SIGTERM would otherwise keep running and keep
        // burning tokens. This does not affect how fast the extension recovers
        // - cancelling settles the promise without waiting for the child.
        escalate = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, 2000);
        if (escalate.unref) escalate.unref();
      });

    let buffer = '';
    let stderr = '';
    let sawDelta = false;
    // Distinct from sawDelta, which says "we are receiving streamed deltas" and
    // is what the whole-turn fallback below keys off. This one only says
    // whether the caller ever received any text at all.
    let producedText = false;
    let model = opts.model;

    const handle = (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === 'stream_event' && event.event) {
        const inner = event.event;
        if (
          inner.type === 'content_block_delta' &&
          inner.delta &&
          inner.delta.type === 'text_delta'
        ) {
          sawDelta = true;
          if (inner.delta.text) producedText = true;
          onText(inner.delta.text);
        }
        if (inner.type === 'message_start' && inner.message && inner.message.model) {
          model = inner.message.model;
        }
        return;
      }
      // Without partial-message support the whole assistant turn arrives at once.
      if (event.type === 'assistant' && !sawDelta && event.message) {
        for (const block of event.message.content || []) {
          if (block.type === 'text') {
            if (block.text) producedText = true;
            onText(block.text);
          }
        }
      }
      if (event.type === 'result' && event.subtype && event.subtype !== 'success') {
        stderr += `\n${event.subtype}: ${event.result || event.error || ''}`;
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) handle(line);
      }
      // A single line longer than this is not a cell, it is a runaway - a
      // claudePath pointing at the wrong binary, or a wrapper teeing a verbose
      // log. Left unbounded the string grows to MAX_STRING_LENGTH (~537MB here)
      // and then throws RangeError INSIDE a stream handler, which is an
      // uncaught exception in the extension host: every extension in the window
      // goes down. Long before that a classroom laptop is swapping.
      if (buffer.length > MAX_LINE) {
        buffer = '';
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        reject(
          new ProviderError(
            'The `claude` CLI produced far more output than a cell can hold, so it was stopped. ' +
              'Check aiNotebookLive.claudePath points at the real CLI.'
          )
        );
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      // Only the last couple of lines are ever shown, so keeping megabytes of
      // it serves nobody.
      if (stderr.length > MAX_STDERR) stderr = stderr.slice(-MAX_STDERR);
    });

    child.on('error', (err) => {
      if (cancel) cancel.dispose();
      // Leaving it alive meant its stdout handlers kept calling writer.write()
      // into a writer the caller had already closed.
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      reject(
        err.code === 'ENOENT'
          ? new ProviderError('The `claude` CLI was not found on PATH.', { action: 'install' })
          : err
      );
    });
    // 'exit' rather than 'close'. Node emits 'close' only once the child has
    // exited AND its stdio has closed, and a grandchild holding the inherited
    // stdout pipe keeps it open indefinitely - measured: exit fired at 302ms,
    // close never fired at all, even after SIGKILL. stream() then never settled,
    // guard()'s finally never ran, and every later command was refused for the
    // life of the window. That is the exact wedge the idle timer exists to
    // prevent, and the timer cannot help: all it does is cancel, which is what
    // already failed.
    let settled = false;
    const finish = (code) => {
      if (settled) return undefined;
      settled = true;
      if (escalate) clearTimeout(escalate);
      if (cancel) cancel.dispose();
      if (buffer.trim()) handle(buffer.trim());
      if (cancelled) return resolve({ provider: 'claude-cli', model, cancelled: true });
      const said = stderr.trim();
      if (code !== 0) {
        log('claude CLI exited', String(code), said);
        return reject(
          new ProviderError(
            // The likeliest first-run failure by far is "installed but not
            // signed in", which exits non-zero with nothing useful on stderr.
            // An exit code is not an explanation for the audience this is for.
            said
              ? `The \`claude\` CLI failed: ${said.split('\n').slice(-2).join(' ')}`.trim()
              : 'The `claude` command ran but did not answer. If you have not signed in yet, ' +
                'open a terminal, run `claude`, and follow the login prompt.'
          )
        );
      }
      // The CLI reports trouble in-band and still exits 0 - error_max_turns is
      // the common one. The reason was collected above and then only ever shown
      // when the exit code was non-zero, so the user got an empty cell and no
      // explanation at all. Exit code is not what decides whether they hear
      // about a failure; producing nothing while having something to say is.
      if (!producedText && said) {
        log('claude CLI produced nothing:', said);
        return reject(
          new ProviderError(`The \`claude\` CLI produced no output. ${said.split('\n').slice(-2).join(' ')}`.trim())
        );
      }
      // Trouble reported in-band AFTER some text arrived - half a function and
      // then error_max_turns - used to resolve as a clean end_turn with no
      // warning at all. The API path's max_tokens toast could never fire for the
      // CLI because the stop reason was hard-coded. Surface it as the CLI's
      // equivalent so pump can say the cell may be cut off.
      if (/error_max_turns|max_turns/.test(said)) {
        log('claude CLI stopped early:', said);
        return resolve({ provider: 'claude-cli', model, stopReason: 'max_turns' });
      }
      return resolve({ provider: 'claude-cli', model, stopReason: 'end_turn' });
    };
    child.on('exit', finish);
    // Still listened for, because it carries any last buffered stdout when it
    // does arrive first; whichever comes first wins and the other is ignored.
    child.on('close', finish);

    // The prompt carries the whole notebook context, so this write is often
    // still queued in the pipe buffer when the child goes away - on cancel, or
    // when the CLI exits immediately because it is not logged in. Without a
    // listener that EPIPE is an uncaught exception, which takes down the
    // extension host and every other extension in the window with it.
    child.stdin.on('error', (err) => {
      log('claude CLI stdin closed early:', (err && err.code) || String(err));
    });
    child.stdin.end(user, 'utf8');
  });
}

module.exports = {
  stream,
  resolveProvider,
  ProviderError,
  SECRET_KEY,
  storedApiKey,
  invalidateSecretCache,
  invalidateCliCache,
  // Exported for the test that pins "a directory is not an executable".
  locateClaude,
};
