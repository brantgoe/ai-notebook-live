'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { CellWriter, editorFor, runCell } = require('./notebook');
const { log } = require('./log');

const MAX_BODY = 1024 * 1024;

/** An error that knows its own HTTP status, so callers get told the truth. */
class BridgeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Where a bridge advertises its port and token.
 *
 * Injectable, because it used to be a module constant: running the test suite
 * wrote over - and then deleted - the token file of a live bridge in another
 * VS Code window, leaving it listening but unreachable. Tests pass their own
 * directory; the env var is a backstop so a test that forgets still cannot
 * reach $HOME.
 */
function defaultInfoDir() {
  return process.env.AI_NOTEBOOK_LIVE_HOME || path.join(os.homedir(), '.ai-notebook-live');
}

/**
 * A loopback-only HTTP endpoint that lets any local AI agent (Claude Code, a
 * script, a cron job) append cells to the notebook that is open right now.
 * Requests must carry the token written to ~/.ai-notebook-live/bridge.json.
 */
class Bridge {
  constructor({ resolveNotebook, decideRun, infoDir }) {
    this.resolveNotebook = resolveNotebook;
    // Asks the shared execution policy. A bridge caller can decline execution
    // but can never demand it - that escalation was the whole bug.
    this.decideRun = decideRun || (async () => ({ run: false, reason: 'no policy configured' }));
    this.infoDir = infoDir || defaultInfoDir();
    this.infoFile = path.join(this.infoDir, 'bridge.json');
    this.server = undefined;
    this.token = undefined;
    this.port = undefined;
  }

  get running() {
    return Boolean(this.server && this.server.listening);
  }

  async start(port) {
    if (this.running) return { port: this.port, token: this.token };
    this.token = crypto.randomBytes(18).toString('hex');
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        log('bridge error:', err && err.message);
        send(res, (err && err.status) || 500, { error: String((err && err.message) || err) });
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      // Loopback only - never expose notebook writes to the network.
      this.server.listen(port, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    this.port = this.server.address().port;
    this.writeInfo();
    log(`bridge listening on http://127.0.0.1:${this.port}`);
    return { port: this.port, token: this.token };
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    await new Promise((resolve) => {
      server.close(resolve);
      // server.close() waits for every open connection, and a client that was
      // mid-upload when we rejected it can hold its socket open indefinitely.
      // Cut them, so stopping the bridge - and deactivating the extension -
      // can never hang.
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
    this.server = undefined;
    this.port = undefined;
    this.token = undefined;
    try {
      // Only remove the advertisement if it is still ours: another window may
      // have claimed this path since, and deleting theirs would leave their
      // bridge listening but unreachable.
      const seen = JSON.parse(fs.readFileSync(this.infoFile, 'utf8'));
      if (seen.pid === process.pid) fs.unlinkSync(this.infoFile);
    } catch {
      /* already gone, or not parseable - either way not ours to tidy */
    }
    log('bridge stopped');
  }

  /**
   * Publishes the port and token for local clients.
   *
   * The obvious version of this is wrong in three ways, each verified rather
   * than assumed:
   *   - mkdirSync's `mode` is ignored when the directory already exists, so a
   *     pre-existing 0755 directory silently stayed world-readable.
   *   - writeFileSync's `mode` is only applied when the file is created, so a
   *     pre-existing 0666 file received a fresh token and kept its permissions.
   *   - writeFileSync follows symlinks, so a link at this path meant the token
   *     JSON overwrote whatever it pointed at.
   * Hence: chmod the directory explicitly, and create the file with O_EXCL,
   * which refuses to follow a symlink and refuses to reuse an existing inode.
   */
  writeInfo() {
    const payload = `${JSON.stringify(
      { port: this.port, token: this.token, pid: process.pid },
      null,
      2
    )}\n`;
    try {
      fs.mkdirSync(this.infoDir, { recursive: true, mode: 0o700 });
      // Applied unconditionally, because mkdirSync's mode did not touch an
      // existing directory.
      try {
        fs.chmodSync(this.infoDir, 0o700);
      } catch {
        /* not ours to chmod, or a platform that does not care */
      }
      this.writeExclusive(this.infoFile, payload);
    } catch (err) {
      log('could not write bridge info file:', err && err.message);
    }
  }

  writeExclusive(file, payload) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // 'wx' is O_CREAT|O_EXCL: it will not follow a symlink and will not
        // reuse a file somebody else left here.
        const fd = fs.openSync(file, 'wx', 0o600);
        try {
          fs.writeSync(fd, payload);
        } finally {
          fs.closeSync(fd);
        }
        return;
      } catch (err) {
        if (err.code !== 'EEXIST' || attempt === 1) throw err;
        // Something is already here. We know it is not a live bridge on this
        // port, because listen() would have failed first - so it is stale, or
        // it is a plant. Either way it does not get to keep the path.
        fs.unlinkSync(file);
      }
    }
  }

  /**
   * A ready-to-run command that does NOT contain the token.
   *
   * This used to interpolate the live token, and the copy-bridge-info command
   * put that on the clipboard - from where it goes into shell history, and onto
   * a projector in a classroom. The token is read from the info file at run
   * time instead.
   */
  curlExample() {
    const read = `$(node -e "process.stdout.write(require('${this.infoFile}').token)")`;
    return [
      `printf 'print("hello from an agent")' | \\`,
      `  curl -sS -X POST "http://127.0.0.1:${this.port}/cell/stream" \\`,
      `    -H "x-ai-notebook-token: ${read}" --data-binary @-`,
    ].join('\n');
  }

  /**
   * Header-only, deliberately.
   *
   * A cross-origin request carrying x-ai-notebook-token is not a CORS "simple"
   * request, so the browser must preflight it with OPTIONS - which this server
   * answers 405 with no CORS headers, so the real request never happens. The
   * design fails closed by construction. Accepting the token from the query
   * string used to undo that, since a plain form POST needs no custom header,
   * and it also wrote a live credential into shell history and proxy logs.
   */
  authorized(req) {
    // No legitimate client sends Origin; every browser does.
    if (req.headers.origin) return false;
    // The other half of DNS-rebinding defence: a rebound name would not match.
    const host = String(req.headers.host || '');
    const hostname = host.replace(/:\d+$/, '');
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return false;

    const header = req.headers['x-ai-notebook-token'];
    const supplied = Array.isArray(header) ? header[0] : header;
    if (typeof supplied !== 'string' || !this.token) return false;
    const a = Buffer.from(supplied);
    const b = Buffer.from(this.token);
    // Equal length is required by timingSafeEqual, and a length mismatch is
    // already a definitive answer.
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async handle(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    if (req.method === 'GET' && url.pathname === '/health' && this.authorized(req)) {
      const notebook = this.resolveNotebook();
      return send(res, 200, {
        ok: true,
        notebook: notebook ? notebook.uri.fsPath : null,
        cells: notebook ? notebook.cellCount : 0,
      });
    }
    if (!this.authorized(req)) return send(res, 401, { error: 'bad or missing token' });
    if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });

    if (url.pathname === '/cell') {
      const body = await readJson(req);
      const code = typeof body.code === 'string' ? body.code : body.text;
      if (typeof code !== 'string') return send(res, 400, { error: 'body needs a "code" string' });
      const writer = await this.openWriter({ ...body, search: url.searchParams });
      try {
        writer.write(code);
        return send(res, 200, await this.closeWriter(writer, { ...body, search: url.searchParams }));
      } catch (err) {
        await writer.abandon();
        throw err;
      }
    }

    if (url.pathname === '/cell/stream') {
      // The request body is streamed straight into the cell, so a piped
      // generator shows up in the notebook as it produces text.
      const writer = await this.openWriter({ search: url.searchParams });
      req.setEncoding('utf8');
      let size = 0;
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BODY) throw new BridgeError('body too large', 413);
          writer.write(chunk);
        }
      } catch (err) {
        // The push failed, so take the half-written cell back out. Note the
        // status comes from the error: a client that hung up is a 400, not the
        // 413 every failure in this loop used to report.
        await writer.abandon();
        return send(res, (err && err.status) || 400, {
          error: String((err && err.message) || err),
        });
      }
      return send(res, 200, await this.closeWriter(writer, { search: url.searchParams }));
    }

    return send(res, 404, { error: 'unknown path' });
  }

  async openWriter(options) {
    const notebook = this.resolveNotebook(options.notebook || options.search.get('notebook'));
    if (!notebook) throw new BridgeError('no notebook is open in VS Code', 409);
    const kind = options.kind || options.search.get('kind') || 'code';
    const index = resolvePosition(
      notebook,
      options.position !== undefined ? options.position : options.search.get('position')
    );
    return CellWriter.insert(notebook, index, {
      kind: kind === 'markdown' || kind === 'markup' ? 'markdown' : 'code',
      language: options.language || options.search.get('language') || undefined,
      fenced: true,
    });
  }

  async closeWriter(writer, options) {
    const raw = options.run !== undefined ? options.run : options.search.get('run');
    // undefined means "no opinion", which lets the user's setting decide.
    // An explicit false is honoured; an explicit true is only a request.
    const requested = raw === undefined || raw === null ? undefined : truthy(raw);
    const text = await writer.end();
    const decision = await this.decideRun({
      requested,
      preview: text,
      // Never hold an HTTP socket open waiting for a human to answer a dialog.
      blocking: false,
      onLateApproval: async () => {
        const cell = writer.cell();
        if (cell) await runCell(writer.notebook, cell.index);
      },
    });
    if (decision.run) await runCell(writer.notebook, writer.index);
    return {
      ok: true,
      index: writer.index,
      characters: text.length,
      ran: Boolean(decision.run),
      pending: Boolean(decision.pending),
      reason: decision.reason,
    };
  }
}

function truthy(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function resolvePosition(notebook, position) {
  if (position === undefined || position === null || position === '' || position === 'below') {
    const editor = editorFor(notebook);
    return editor ? editor.selection.end : notebook.cellCount;
  }
  if (position === 'end') return notebook.cellCount;
  if (position === 'above') {
    const editor = editorFor(notebook);
    return editor ? editor.selection.start : 0;
  }
  const index = Number(position);
  if (Number.isNaN(index)) return notebook.cellCount;
  return Math.max(0, Math.min(index, notebook.cellCount));
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req) {
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new BridgeError('body too large', 413);
  }
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new BridgeError('body is not valid JSON', 400);
  }
}

module.exports = { Bridge, BridgeError, defaultInfoDir };
