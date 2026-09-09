'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
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
      });

    let buffer = '';
    let stderr = '';
    let sawDelta = false;
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
          if (block.type === 'text') onText(block.text);
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
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      if (cancel) cancel.dispose();
      reject(
        err.code === 'ENOENT'
          ? new ProviderError('The `claude` CLI was not found on PATH.', { action: 'install' })
          : err
      );
    });
    child.on('close', (code) => {
      if (cancel) cancel.dispose();
      if (buffer.trim()) handle(buffer.trim());
      if (cancelled) return resolve({ provider: 'claude-cli', model, cancelled: true });
      if (code !== 0) {
        log('claude CLI exited', String(code), stderr.trim());
        return reject(
          new ProviderError(
            `The \`claude\` CLI exited with code ${code}. ${stderr.trim().split('\n').slice(-2).join(' ')}`.trim()
          )
        );
      }
      resolve({ provider: 'claude-cli', model, stopReason: 'end_turn' });
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
};
