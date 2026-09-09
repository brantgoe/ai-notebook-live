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

const INFO_FILE = path.join(os.homedir(), '.ai-notebook-live', 'bridge.json');

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

function parseArgs(argv) {
  const out = { position: undefined, run: undefined, kind: 'code' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) usage(2);
      i += 1;
      return value;
    };
    if (arg === '--code') out.code = next();
    else if (arg === '--file') out.file = next();
    else if (arg === '--markdown' || arg === '--md') out.kind = 'markdown';
    else if (arg === '--position' || arg === '-p') out.position = next();
    else if (arg === '--run') out.run = true;
    else if (arg === '--no-run') out.run = false;
    else if (arg === '--notebook') out.notebook = next();
    else if (arg === '--health') out.health = true;
    else if (arg === '-h' || arg === '--help') usage(0);
    else if (!arg.startsWith('-') && !out.file) out.file = arg;
    else usage(2);
  }
  return out;
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

  const search = new URLSearchParams();
  if (args.kind === 'markdown') search.set('kind', 'markdown');
  if (args.position !== undefined) search.set('position', args.position);
  if (args.run !== undefined) search.set('run', args.run ? '1' : '0');
  if (args.notebook) search.set('notebook', args.notebook);

  let res;
  if (args.code !== undefined || args.file) {
    const code = args.code !== undefined ? args.code : fs.readFileSync(args.file, 'utf8');
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
  process.stdout.write(`${res.text}\n`);
  return undefined;
}

main().catch((err) => {
  process.stderr.write(`nbpush: ${(err && err.message) || err}\n`);
  process.exit(1);
});
