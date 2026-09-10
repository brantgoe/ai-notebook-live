#!/usr/bin/env node
'use strict';
/**
 * An MCP server that lets another AI tool - Codex, or anything else that speaks
 * MCP - write cells into the notebook you have open in VS Code.
 *
 *   codex mcp add ai-notebook -- node <this file>
 *
 * Why this exists: the Codex extension edits notebooks on disk, and a .ipynb
 * written on disk does not appear in a tab you already have open - it is
 * overwritten the moment you save. Only vscode.NotebookEdit changes the live
 * document, which is what the bridge in this extension does. This exposes that
 * bridge as tools an agent can call directly, rather than as shell instructions
 * it has to remember to follow.
 *
 * Speaks the MCP subset it needs - initialize, tools/list, tools/call - as
 * newline-delimited JSON-RPC over stdio. Deliberately no SDK: like nbpush, this
 * ships as one file that imports only Node builtins, so it stays runnable
 * straight out of the installed extension directory.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const INFO_DIR = process.env.AI_NOTEBOOK_LIVE_HOME || path.join(os.homedir(), '.ai-notebook-live');
const INFO_FILE = path.join(INFO_DIR, 'bridge.json');
const PROTOCOL = '2024-11-05';

/* ----------------------------- the bridge ------------------------------- */

/** Reads the bridge's advertisement, refusing a stale one. Mirrors bin/nbpush.js. */
function readInfo() {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(INFO_FILE, 'utf8'));
  } catch {
    throw new Error(
      'The AI Notebook bridge is not running. In VS Code, run "AI Notebook: Start Local Agent Bridge".'
    );
  }
  if (!info || typeof info !== 'object' || !Number.isInteger(info.port) || !info.token) {
    throw new Error('The bridge file is malformed. Restart the bridge from VS Code.');
  }
  // The process that wrote this may be long gone - VS Code can exit without
  // cleaning up - and something else may own the port by now.
  if (!Number.isInteger(info.pid) || !alive(info.pid)) {
    throw new Error(
      'The bridge advertisement is stale: the VS Code window that wrote it is gone. ' +
        'Nothing was sent. Start the bridge again.'
    );
  }
  return info;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function request(info, { method = 'POST', pathname, search, body, anonymous }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: info.port,
        method,
        path: search ? `${pathname}?${search}` : pathname,
        headers: {
          ...(anonymous ? {} : { 'x-ai-notebook-token': info.token }),
          'content-type': 'application/json',
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          text += c;
        });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('the bridge did not respond within 15s'));
    });
    req.end(body);
  });
}

/** Confirms the listener really is the bridge before handing it anything. */
async function confirm(info) {
  const anon = await request(info, { method: 'GET', pathname: '/health', anonymous: true });
  if (anon.status !== 401 || !/bad or missing token/.test(anon.text)) {
    throw new Error(
      `Whatever is listening on 127.0.0.1:${info.port} is not the AI Notebook bridge. Nothing was sent.`
    );
  }
  const res = await request(info, { method: 'GET', pathname: '/health' });
  if (res.status !== 200) throw new Error(`the bridge answered ${res.status}: ${res.text}`);
  return JSON.parse(res.text);
}

/* -------------------------------- tools --------------------------------- */

const TOOLS = [
  {
    name: 'add_notebook_cell',
    description:
      'Add a cell to the Jupyter notebook currently open in the user’s VS Code window, live. ' +
      'The cell appears immediately in the editor; nothing is written to disk, so it is safe even ' +
      'when the user has unsaved changes. Use this instead of editing the .ipynb file directly, ' +
      'because a file written on disk does not appear in a tab that is already open and is lost ' +
      'when the user saves.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The exact contents of the cell.' },
        kind: {
          type: 'string',
          enum: ['code', 'markdown'],
          description: 'Cell type. Defaults to code.',
        },
        position: {
          type: 'string',
          description:
            'Where to put it: "below" (default, after the selected cell), "above", "end", or a whole-number index.',
        },
        run: {
          type: 'boolean',
          description:
            'Ask for the cell to be executed. The user’s settings decide whether it actually runs; ' +
            'a request can be declined but never overrides them.',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'get_notebook_cells',
    description:
      'Read the cells of the notebook open in VS Code, including unsaved edits. ' +
      'Use this to check your own work after adding a cell, to see what the user changed, ' +
      'and to find the index of a cell you want to replace. Reading the .ipynb file instead ' +
      'gives you a stale copy, because the editor holds changes that are not on disk.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'number', description: 'First cell index to return. Defaults to 0.' },
        to: { type: 'number', description: 'Stop before this index. Defaults to the end.' },
        outputs: {
          type: 'boolean',
          description: 'Include each cell’s output and any error it produced. Off by default.',
        },
      },
    },
  },
  {
    name: 'replace_notebook_cell',
    description:
      'Rewrite the contents of one existing cell, in place, by index. Use this to correct a ' +
      'cell you added — appending a second, fixed copy leaves the wrong one behind. ' +
      'This DESTROYS what was there, so read the cell first and be sure of the index; the ' +
      'previous contents come back in the response. ' +
      'Always pass "expect" with the exact source you last read for that index: a person is ' +
      'editing this notebook while you work, so indices shift and contents change under you, ' +
      'and without it you are guessing. If the cell you read came back with truncated:true you ' +
      'do not have its full source — read a narrower range first, because writing back a ' +
      'truncated copy would delete the rest of the cell.',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'integer', minimum: 0, description: 'The index of the cell to rewrite.' },
        code: { type: 'string', description: 'The new contents of the cell.' },
        expect: {
          type: 'string',
          description:
            'The exact current source of that cell, as you last read it. The replace is ' +
            'refused if the cell no longer matches, rather than destroying something you ' +
            'have not seen.',
        },
        notebook: {
          type: 'string',
          description:
            'Part of the path of the notebook you read, so a replace cannot land in a ' +
            'different file if the user switches tabs between your read and your write.',
        },
      },
      required: ['index', 'code'],
    },
  },
  {
    name: 'get_notebook_status',
    description:
      'Report which notebook the bridge is currently targeting and how many cells it has. ' +
      'Call this first to confirm the right notebook is open before writing to it.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args) {
  const info = readInfo();
  const health = await confirm(info);

  if (name === 'get_notebook_status') {
    return `Bridge is live on 127.0.0.1:${info.port}.\nNotebook: ${health.notebook}\nCells: ${health.cells}`;
  }

  if (name === 'get_notebook_cells') {
    const search = new URLSearchParams();
    if (args.from !== undefined) search.set('from', String(args.from));
    if (args.to !== undefined) search.set('to', String(args.to));
    if (args.outputs) search.set('outputs', '1');
    const res = await request(info, {
      method: 'GET',
      pathname: '/cells',
      search: search.toString(),
    });
    if (res.status !== 200) throw new Error(`could not read the notebook (${res.status}): ${res.text}`);
    const d = JSON.parse(res.text);
    const body = d.cells
      // Marked per cell. "Some cells were clipped" told an agent that something
      // somewhere was incomplete but not WHICH, which is no use to one deciding
      // whether it may safely rewrite this particular index.
      .map((c) => `--- cell ${c.index} (${c.kind})${c.truncated ? ' [TRUNCATED - not the full source]' : ''} ---\n${c.source}` +
        (c.error ? `\n[error] ${c.error}` : '') +
        (c.output ? `\n[output] ${c.output}` : ''))
      .join('\n\n');
    return (
      `${d.notebook} has ${d.count} cells; showing ${d.cells.length} from index ${d.from}.` +
      (d.truncated
        ? ' Cells marked TRUNCATED are incomplete - do not replace one from what you see here.'
        : '') +
      `\n\nWhen replacing any of these, pass expect= with the exact source shown above.\n\n${body}`
    );
  }

  if (name === 'replace_notebook_cell') {
    if (!Number.isInteger(args.index)) throw new Error('index must be a whole number');
    if (typeof args.code !== 'string' || !args.code.trim()) {
      throw new Error('code is required and must be a non-empty string');
    }
    const search = new URLSearchParams({ index: String(args.index) });
    // Both optional on the wire, so an older caller still works - but passing
    // them is what turns "replace cell 7" from a guess into a checked edit.
    if (typeof args.expect === 'string') search.set('expect', args.expect);
    if (typeof args.notebook === 'string' && args.notebook) search.set('notebook', args.notebook);
    const res = await request(info, {
      pathname: '/cell/replace',
      search: search.toString(),
      body: JSON.stringify({ code: args.code }),
    });
    if (res.status !== 200) throw new Error(`the bridge refused this edit (${res.status}): ${res.text}`);
    const out = JSON.parse(res.text);
    return (
      `Rewrote cell ${out.index} of ${out.notebook}.\n` +
      `It previously contained:\n${out.replaced}`
    );
  }

  if (name !== 'add_notebook_cell') throw new Error(`unknown tool: ${name}`);
  if (typeof args.code !== 'string' || !args.code.trim()) {
    throw new Error('code is required and must be a non-empty string');
  }

  const search = new URLSearchParams();
  if (args.kind) search.set('kind', String(args.kind));
  if (args.position !== undefined) search.set('position', String(args.position));
  if (args.run !== undefined) search.set('run', args.run ? '1' : '0');

  const res = await request(info, {
    pathname: '/cell',
    search: search.toString(),
    body: JSON.stringify({ code: args.code }),
  });
  if (res.status !== 200) {
    // The bridge explains itself; pass that through rather than flattening it.
    throw new Error(`the bridge refused this cell (${res.status}): ${res.text}`);
  }
  const out = JSON.parse(res.text);
  return (
    `Added a ${args.kind === 'markdown' ? 'markdown' : 'code'} cell at index ${out.index} of ` +
    `${out.notebook}.\n` +
    (out.ran
      ? 'It was executed.'
      : `It was not executed: ${out.reason || 'the user’s settings did not allow it'}.`)
  );
}

/* ------------------------------ the plumbing ---------------------------- */

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32000, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  // Notifications carry no id and must never be answered.
  if (id === undefined) return;

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'ai-notebook-live', version: require('../package.json').version },
    });
  }
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const text = await callTool(params && params.name, (params && params.arguments) || {});
      return reply(id, { content: [{ type: 'text', text }] });
    } catch (err) {
      // A tool failure is a result the model should see and can act on, not a
      // protocol error - so it comes back as content with isError set.
      return reply(id, {
        content: [{ type: 'text', text: String((err && err.message) || err) }],
        isError: true,
      });
    }
  }
  if (method === 'ping') return reply(id, {});
  return fail(id, `unknown method: ${method}`);
}

function main() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a line we cannot parse is not ours to answer
      }
      handle(msg).catch((err) => {
        if (msg && msg.id !== undefined) fail(msg.id, String((err && err.message) || err));
      });
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

if (require.main === module) main();
module.exports = { TOOLS, callTool, readInfo, handle };
