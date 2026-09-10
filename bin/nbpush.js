#!/usr/bin/env node
'use strict';
/**
 * nbpush - push a cell into the notebook open in VS Code, from anywhere.
 *
 *   printf 'print("hi")' | nbpush --run
 *   claude -p 'write a pandas groupby example' | nbpush      # streams in live
 *   nbpush --markdown --code '## Section 3'
 *   nbpush --file analysis.py --position end
 *
 * Requires "AI Notebook: Start Local Agent Bridge" to be running in VS Code.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Must agree with src/bridge.js defaultInfoDir(). It used to hard-code the home
// directory while the bridge honoured this variable, which meant the test suite
// - which sets it deliberately, so it cannot clobber a live bridge - could not
// drive nbpush at all.
const INFO_DIR = process.env.AI_NOTEBOOK_LIVE_HOME || path.join(os.homedir(), '.ai-notebook-live');
const INFO_FILE = path.join(INFO_DIR, 'bridge.json');

function usage(code) {
  process.stderr.write(
    [
      'usage: nbpush [options] [file]',
      '',
      '  --code <text>       cell contents (default: read stdin)',
      '  --file <path>       read cell contents from a file',
      '  --markdown          insert a markdown cell instead of a code cell',
      '  --position <where>  below (default) | above | end | <cell index>',
      '  --run               execute the cell after inserting it',
      '  --no-run            do not execute it (overrides the VS Code setting)',
      '  --notebook <part>   pick the open notebook whose path contains <part>',
      '  --health            print bridge status and exit',
      '',
    ].join('\n')
  );
  process.exit(code);
}

function fail(message) {
  process.stderr.write(`nbpush: ${message}\n`);
  return usage(2);
}

const FLAGS = new Set([
  '--code', '--file', '--markdown', '--md', '--kind', '--position', '-p',
  '--run', '--no-run', '--notebook', '--health', '--dry-run', '-h', '--help',
]);

function parseArgs(argv) {
  const out = { position: undefined, run: undefined, kind: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (flag) => {
      const value = argv[i + 1];
      if (value === undefined) return fail(`${flag} needs a value`);
      // Without this, `nbpush --code --run` silently set code to "--run" and
      // swallowed the flag.
      if (FLAGS.has(value)) return fail(`${flag} needs a value, but was followed by ${value}`);
      i += 1;
      return value;
    };
    const once = (key, flag) => {
      if (out[key] !== undefined) fail(`${flag} was given more than once`);
    };
    if (arg === '--code') {
      once('code', '--code');
      out.code = next('--code');
    } else if (arg === '--file') {
      once('file', '--file');
      out.file = next('--file');
    } else if (arg === '--markdown' || arg === '--md') {
      // Used to be a one-way latch with no way to undo it.
      once('kind', arg);
      out.kind = 'markdown';
    } else if (arg === '--kind') {
      once('kind', '--kind');
      const value = next('--kind');
      if (value !== 'code' && value !== 'markdown') fail(`--kind must be code or markdown, not ${value}`);
      out.kind = value;
    } else if (arg === '--position' || arg === '-p') {
      once('position', arg);
      out.position = next(arg);
    } else if (arg === '--run') {
      // Conflicting flags used to resolve last-wins, silently, and this one
      // decides whether code executes in the user's kernel.
      if (out.run === false) fail('--run and --no-run cannot both be given');
      out.run = true;
    } else if (arg === '--no-run') {
      if (out.run === true) fail('--run and --no-run cannot both be given');
      out.run = false;
    } else if (arg === '--notebook') {
      once('notebook', '--notebook');
      out.notebook = next('--notebook');
    } else if (arg === '--health') out.health = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '-h' || arg === '--help') usage(0);
    else if (!arg.startsWith('-') && out.file === undefined) out.file = arg;
    else fail(`unexpected argument ${arg}`);
  }
  if (out.code !== undefined && out.file !== undefined) {
    fail('--code and a file cannot both be given');
  }
  if (out.kind === undefined) out.kind = 'code';
  return out;
}

/**
 * Decides where the cell body comes from, and refuses rather than hanging.
 *
 * Run on a terminal with nothing piped in, this used to block forever waiting
 * for stdin - and because the bridge opened its writer as soon as the headers
 * landed, an empty cell was already sitting in the notebook while it waited.
 */
function chooseInput(args, { isTTY = process.stdin.isTTY } = {}) {
  if (args.code !== undefined) return { kind: 'literal', code: args.code };
  if (args.file !== undefined) return { kind: 'file', file: args.file };
  if (isTTY) {
    return {
      kind: 'refuse',
      message:
        'no input. Pipe something in, or pass --code "..." or a file.\n' +
        '  printf \'print(1)\' | nbpush',
    };
  }
  return { kind: 'stdin' };
}

function readInfo() {
  try {
    return JSON.parse(fs.readFileSync(INFO_FILE, 'utf8'));
  } catch {
    process.stderr.write(
      `nbpush: no bridge found at ${INFO_FILE}\n` +
        'Run "AI Notebook: Start Local Agent Bridge" from the VS Code command palette.\n'
    );
    return process.exit(1);
  }
}

function request(info, { method, pathname, search, body, stream }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: info.port,
        method,
        path: search ? `${pathname}?${search}` : pathname,
        headers: { 'x-ai-notebook-token': info.token, 'content-type': 'application/json' },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', reject);
    if (stream) stream.pipe(req);
    else req.end(body);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const info = readInfo();

  if (args.health) {
    const res = await request(info, { method: 'GET', pathname: '/health' });
    process.stdout.write(`${res.text}\n`);
    return process.exit(res.status === 200 ? 0 : 1);
  }

  const input = chooseInput(args);
  if (input.kind === 'refuse') {
    process.stderr.write(`nbpush: ${input.message}\n`);
    return process.exit(2);
  }

  const search = new URLSearchParams();
  if (args.kind === 'markdown') search.set('kind', 'markdown');
  if (args.position !== undefined) search.set('position', args.position);
  if (args.run !== undefined) search.set('run', args.run ? '1' : '0');
  if (args.notebook) search.set('notebook', args.notebook);

  if (args.dryRun) {
    const health = await request(info, { method: 'GET', pathname: '/health' });
    if (health.status !== 200) {
      process.stderr.write(`nbpush: ${health.status} ${health.text}\n`);
      return process.exit(1);
    }
    const target = JSON.parse(health.text).notebook;
    process.stderr.write(
      `nbpush: would add a ${args.kind} cell to ${target}\n` +
        `  options: ${search.toString() || '(defaults)'}\n` +
        `  body:    ${input.kind}\n`
    );
    return process.exit(0);
  }

  let res;
  if (input.kind === 'literal' || input.kind === 'file') {
    const code = input.kind === 'literal' ? input.code : fs.readFileSync(input.file, 'utf8');
    res = await request(info, {
      method: 'POST',
      pathname: '/cell',
      search: search.toString(),
      body: JSON.stringify({ code }),
    });
  } else {
    // Stream stdin so a generator's output appears in the notebook as it is produced.
    res = await request(info, {
      method: 'POST',
      pathname: '/cell/stream',
      search: search.toString(),
      stream: process.stdin,
    });
  }

  if (res.status !== 200) {
    process.stderr.write(`nbpush: ${res.status} ${res.text}\n`);
    return process.exit(1);
  }
  // Where it landed goes to stderr; stdout stays machine-readable.
  try {
    const body = JSON.parse(res.text);
    if (body.notebook) process.stderr.write(`nbpush: added a cell to ${body.notebook}\n`);
  } catch {
    /* the server said something we could not parse; the raw text still prints */
  }
  process.stdout.write(`${res.text}\n`);
  return undefined;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`nbpush: ${(err && err.message) || err}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, chooseInput, INFO_FILE };
