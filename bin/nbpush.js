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

/**
 * Thrown instead of calling process.exit, so that argv validation can actually
 * be tested. It could not be before: every invalid-argument path exited the
 * process, which in a test run means killing the test run.
 */
class CliExit extends Error {
  constructor(code) {
    super(`nbpush exited with ${code}`);
    this.code = code;
  }
}

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
      '  --kind <code|markdown>  which kind of cell to insert',
      '  --list              list the live cells and their indexes, then exit',
      '  --replace <index>   rewrite that cell instead of inserting a new one',
      '  --health            print bridge status and exit',
      '  --dry-run           show what would be pushed, and where, without pushing',
      '',
    ].join('\n')
  );
  throw new CliExit(code);
}

function fail(message) {
  process.stderr.write(`nbpush: ${message}\n`);
  return usage(2);
}

const FLAGS = new Set([
  '--code', '--file', '--markdown', '--md', '--kind', '--position', '-p',
  '--run', '--no-run', '--notebook', '--health', '--dry-run', '-h', '--help',
  // Announced in the 0.5.0 CHANGELOG, handled further down, and never actually
  // parsed - both fell through to "unexpected argument" and exit 2, while the
  // code reading args.list and args.replace sat there unreachable.
  '--list', '--replace',
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
    } else if (arg === '--list') out.list = true;
    else if (arg === '--replace') {
      once('replace', '--replace');
      const value = next('--replace');
      if (!/^\d+$/.test(value)) fail(`--replace needs a cell index, not ${value}`);
      out.replace = Number(value);
    } else if (arg === '--health') out.health = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '-h' || arg === '--help') usage(0);
    else if (!arg.startsWith('-') && out.file === undefined) out.file = arg;
    else fail(`unexpected argument ${arg}`);
  }
  if (out.code !== undefined && out.file !== undefined) {
    fail('--code and a file cannot both be given');
  }
  if (out.replace !== undefined && out.position !== undefined) {
    fail('--replace rewrites an existing cell, so --position means nothing');
  }
  if (out.replace !== undefined && out.list) {
    fail('--list and --replace cannot both be given');
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

/**
 * Reads the bridge's advertisement, and refuses to trust a stale one.
 *
 * This used to hand back whatever JSON.parse produced. That mattered far more
 * than the confusing error messages it caused: after VS Code exits without
 * running deactivate() - a crash, an OOM kill, a reboot - the file survives
 * naming a dead process and a port. If anything else later binds that port,
 * piping code into nbpush sent that code, and the token, to a stranger, and
 * printed {"ok":true}.
 *
 * The pid check is what closes that. It is not a defence against a hostile
 * local process - anything running as this user can read the token file anyway
 * - but the realistic case is an accidental collision after a crash, and a
 * dead pid identifies it exactly.
 */
function readInfo() {
  let raw;
  try {
    raw = fs.readFileSync(INFO_FILE, 'utf8');
  } catch {
    // Thrown, not exited: main() prints and exits for every error alike, and a
    // --dry-run has to be able to catch this and carry on offline. Calling
    // process.exit from inside a helper made that impossible.
    throw new Error(
      `no bridge found at ${INFO_FILE}\n` +
        'Run "AI Notebook: Start Local Agent Bridge" from the VS Code command palette.'
    );
  }

  let info;
  try {
    info = JSON.parse(raw);
  } catch {
    return stale('it is not valid JSON');
  }
  if (info === null || typeof info !== 'object' || Array.isArray(info)) {
    return stale('it is not an object');
  }
  if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535) {
    return stale(`the port is ${JSON.stringify(info.port)}`);
  }
  if (typeof info.token !== 'string' || info.token.length === 0) {
    return stale('it has no token');
  }
  if (!Number.isInteger(info.pid) || !alive(info.pid)) {
    return stale(
      `the process that wrote it (${info.pid}) is gone. Something else may be ` +
        `listening on port ${info.port} now, so nothing was sent`
    );
  }
  return info;
}

function stale(why) {
  throw new Error(
    `the bridge file at ${INFO_FILE} is stale - ${why}.\n` +
      'Run "AI Notebook: Start Local Agent Bridge" in VS Code to write a fresh one.'
  );
}

function alive(pid) {
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to somebody else, which our own
    // bridge never would.
    return false;
  }
}

/**
 * Confirms the thing on that port is actually our bridge before handing it the
 * payload. Catches an accidental collision - some unrelated service that has
 * taken the port - rather than a deliberate impostor, which would have the
 * token from the file anyway.
 */
async function confirmBridge(info) {
  // Probe WITHOUT the token first. Our bridge refuses an unauthenticated
  // request with a distinctive body, so a wrong listener can be identified
  // before it is handed a credential - it is not only the code that should not
  // leak to whatever happens to own the port.
  try {
    const anon = await request({ ...info, token: undefined }, { method: 'GET', pathname: '/health' });
    if (anon.status !== 401 || !/bad or missing token/.test(anon.text)) {
      process.stderr.write(
        `nbpush: whatever is listening on 127.0.0.1:${info.port} is not the AI Notebook ` +
          'bridge. Nothing was sent.\n'
      );
      return process.exit(1);
    }
  } catch (err) {
    process.stderr.write(
      `nbpush: could not reach a bridge on 127.0.0.1:${info.port} (${(err && err.code) || err}).\n`
    );
    return process.exit(1);
  }

  let res;
  try {
    res = await request(info, { method: 'GET', pathname: '/health' });
  } catch (err) {
    process.stderr.write(
      `nbpush: could not reach a bridge on 127.0.0.1:${info.port} (${(err && err.code) || err}).\n`
    );
    return process.exit(1);
  }
  if (res.status !== 200) {
    process.stderr.write(`nbpush: ${res.status} from 127.0.0.1:${info.port}: ${res.text}\n`);
    return process.exit(1);
  }
  let health;
  try {
    health = JSON.parse(res.text);
  } catch {
    health = undefined;
  }
  if (!health || health.ok !== true || !('notebook' in health)) {
    process.stderr.write(
      `nbpush: whatever is listening on 127.0.0.1:${info.port} is not the AI Notebook ` +
        'bridge. Nothing was sent.\n'
    );
    return process.exit(1);
  }
  return health;
}

function request(info, { method, pathname, search, body, stream }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: info.port,
        method,
        path: search ? `${pathname}?${search}` : pathname,
        headers: {
          ...(info.token ? { 'x-ai-notebook-token': info.token } : {}),
          'content-type': 'application/json',
        },
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

  // A dry run must be possible with no bridge at all - that is half of what
  // "dry" means. readInfo() and confirmBridge() both ran first, so previewing
  // offline was impossible. Everything local is decided before anything is
  // read from disk or the network.
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

  let info;
  try {
    info = readInfo();
  } catch (err) {
    if (!args.dryRun) throw err;
    process.stderr.write(
      `nbpush: dry run - would ${args.replace !== undefined ? `replace cell ${args.replace}` : `add a ${args.kind} cell`}\n` +
        `  options: ${search.toString() || '(defaults)'}\n` +
        `  body:    ${input.kind}\n` +
        `  target:  unknown (${(err && err.message) || err})\n`
    );
    return process.exit(0);
  }

  // Every path that carries the token goes through the anonymous probe first.
  // --health and --list used to skip it and send the token to whatever owned
  // the port - the same exfiltration the main path was fixed for.
  const health = await confirmBridge(info);

  if (args.health) {
    process.stdout.write(`${JSON.stringify(health)}\n`);
    return process.exit(0);
  }

  if (args.list) {
    // Without the selector this listed whatever was focused, so an agent read
    // indices from one notebook and replaced that index in another.
    const res = await request(info, {
      method: 'GET',
      pathname: '/cells',
      search: args.notebook ? `notebook=${encodeURIComponent(args.notebook)}` : undefined,
    });
    if (res.status !== 200) {
      process.stderr.write(`nbpush: ${res.status} ${res.text}\n`);
      return process.exit(1);
    }
    const d = JSON.parse(res.text);
    process.stderr.write(`nbpush: ${d.notebook} - ${d.count} cells\n`);
    for (const c of d.cells) {
      const first = (c.source.split('\n')[0] || '').slice(0, 68);
      process.stdout.write(`${String(c.index).padStart(3)} [${c.kind[0]}] ${first}\n`);
    }
    return undefined;
  }

  if (args.dryRun) {
    process.stderr.write(
      `nbpush: would ${args.replace !== undefined ? `replace cell ${args.replace} in` : `add a ${args.kind} cell to`} ${health.notebook}\n` +
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
      pathname: args.replace !== undefined ? '/cell/replace' : '/cell',
      // Built FROM `search`, not instead of it: a fresh `index=` string dropped
      // --notebook, so --replace rewrote whichever notebook happened to be
      // focused - and said ok. Selecting the file and selecting the cell are
      // two different questions and both have to reach the bridge.
      search: replaceSearch(search, args.replace),
      body: JSON.stringify({ code }),
    });
  } else if (args.replace !== undefined) {
    // Replacing takes a whole body, not a stream, and the streaming branch below
    // ignores args.replace entirely - so `--replace 2` on a pipe silently
    // APPENDED a new cell instead of rewriting cell 2. That is the additive-vs-
    // destructive confusion this endpoint exists to keep apart, and it damaged a
    // real notebook. Read stdin to the end, then replace.
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const code = Buffer.concat(chunks).toString('utf8');
    res = await request(info, {
      method: 'POST',
      pathname: '/cell/replace',
      search: replaceSearch(search, args.replace),
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
    if (body.notebook) {
      const what = args.replace !== undefined ? `replaced cell ${args.replace} in` : 'added a cell to';
      process.stderr.write(`nbpush: ${what} ${body.notebook}\n`);
    }
  } catch {
    /* the server said something we could not parse; the raw text still prints */
  }
  process.stdout.write(`${res.text}\n`);
  return undefined;
}

if (require.main === module) {
  main().catch((err) => {
    if (err instanceof CliExit) return process.exit(err.code);
    process.stderr.write(`nbpush: ${(err && err.message) || err}\n`);
    return process.exit(1);
  });
}

/**
 * The query for a /cell/replace. `index` says which cell; everything the user
 * already chose - `notebook` above all - has to survive alongside it.
 */
function replaceSearch(search, index) {
  const q = new URLSearchParams(search);
  q.delete('kind');
  q.delete('position');
  q.set('index', String(index));
  return q.toString();
}

module.exports = { parseArgs, chooseInput, readInfo, alive, INFO_FILE, CliExit, replaceSearch };
