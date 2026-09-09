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

async function storedApiKey(secrets) {
  const fromStore = secrets ? await secrets.get(SECRET_KEY) : undefined;
  return (
    fromStore ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    undefined
  );
}

function claudeBinary() {
  if (process.env.CLAUDE_CODE_EXECPATH) return process.env.CLAUDE_CODE_EXECPATH;
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return 'claude';
}

function claudeCliAvailable() {
  const bin = claudeBinary();
  if (bin !== 'claude') return true;
  const dirs = (process.env.PATH || '').split(path.delimiter);
  return dirs.some((dir) => {
    try {
      fs.accessSync(path.join(dir, 'claude'), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** Decides which backend to use for this request. */
async function resolveProvider(opts, secrets) {
  const key = await storedApiKey(secrets);
  if (opts.provider === 'api') {
    if (!key) {
      throw new ProviderError('No Anthropic API key is configured.', { action: 'setKey' });
    }
    return { kind: 'api', key };
  }
  if (opts.provider === 'claude-cli') {
    if (!claudeCliAvailable()) {
      throw new ProviderError('The `claude` CLI was not found on PATH.', { action: 'install' });
    }
    return { kind: 'cli' };
  }
  if (key) return { kind: 'api', key };
  if (claudeCliAvailable()) return { kind: 'cli' };
  throw new ProviderError(
    'No Anthropic API key and no `claude` CLI found. Set a key, or install Claude Code.',
    { action: 'setKey' }
  );
}

/**
 * Streams a completion into onText(chunk).
 * Resolves with { provider, model, stopReason, refused }.
 */
async function stream({ system, user, opts, secrets, token, onText }) {
  const target = await resolveProvider(opts, secrets);
  return target.kind === 'api'
    ? streamApi({ system, user, opts, token, onText, apiKey: target.key })
    : streamCli({ system, user, opts, token, onText });
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
function streamCli({ system, user, opts, token, onText }) {
  const bin = claudeBinary();
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

module.exports = { stream, resolveProvider, ProviderError, SECRET_KEY, storedApiKey };
