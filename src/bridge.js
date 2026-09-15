'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  CellWriter,
  clipText,
  editorFor,
  runCell,
  runApproved,
  readOutputs,
  cellKindName,
} = require('./notebook');
const validate = require('./validate');
const { log } = require('./log');

const MAX_BODY = 1024 * 1024;
/** Cells per /cells response; the caller pages with ?from=<next>. */
const MAX_CELLS = 200;
/** How long to keep draining a rejected upload so its status can be delivered. */
const DRAIN_MS = 2000;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
  constructor({ resolveNotebook, decideRun, infoDir, listNotebooks, notify, version }) {
    // Injected rather than required from package.json: requiring it here makes
    // esbuild inline the WHOLE manifest - devDependencies, scripts and all -
    // into the shipped bundle, which grew it by 16 KB of build detail.
    this.version = version || '0.0.0';
    this.resolveNotebook = resolveNotebook;
    this.listNotebooks = listNotebooks;
    // This module deliberately does not import vscode - it is the one piece
    // that can be driven headlessly, and a test asserts as much. Anything the
    // user needs to SEE goes out through here instead.
    this.notify = notify || (() => {});
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
    // `running` only becomes true once listen() completes, so two overlapping
    // starts - autoStart racing a manual one, or a double-click on the control
    // panel row - each overwrote the other's token and server, and the first
    // one's callback then read the SECOND server's address while it was still
    // binding. The first server stayed listening on the port, unreachable, for
    // the life of the window.
    if (this.starting) return this.starting;
    this.starting = this.begin(port).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  async begin(port) {
    this.token = crypto.randomBytes(18).toString('hex');
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        log('bridge error:', err && err.message);
        send(res, (err && err.status) || 500, { error: String((err && err.message) || err) });
      });
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      // Loopback only - never expose notebook writes to the network.
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    // Bound to a local until it is actually listening, so a concurrent start
    // cannot swap it out from under this one.
    this.server = server;
    this.port = server.address().port;
    // Nothing keeps an 'error' listener on a live server, and Node emits one
    // for accept-time failures such as EMFILE. An unhandled 'error' on an
    // EventEmitter throws, and here that would take down the whole extension
    // host - every extension in the window, not just this one.
    server.on('error', (err) => log('bridge server error:', (err && err.message) || err));
    try {
      this.writeInfo();
    } catch (err) {
      // A bridge nobody can find is not a bridge. This used to be swallowed and
      // the next line announced success anyway, leaving the user in a loop: VS
      // Code says it is running, every client says it is not, and running the
      // start command again just repeats both.
      await this.stop();
      throw new Error(
        `the bridge started but could not publish its token to ${this.infoFile}: ` +
          `${(err && err.message) || err}`
      );
    }
    log(`bridge listening on http://127.0.0.1:${this.port}`);
    return { port: this.port, token: this.token };
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    // Unlink first, close second. The other order left a moment in which the
    // file named a port nobody was listening on - on a shared machine another
    // local user could bind it in that gap and be handed the token by a client
    // reading the file at the same time.
    this.unlinkIfOurs();
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
    log('bridge stopped');
  }

  unlinkIfOurs() {
    try {
      // Only remove the advertisement if it is still ours: another window may
      // have claimed this path since, and deleting theirs would leave their
      // bridge listening but unreachable.
      const seen = JSON.parse(fs.readFileSync(this.infoFile, 'utf8'));
      if (seen.pid === process.pid) fs.unlinkSync(this.infoFile);
    } catch {
      /* already gone, or not parseable - either way not ours to tidy */
    }
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
      throw err;
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
        // Something is already here. On a FIXED port it cannot be a live
        // bridge, because listen() would have failed first. That reasoning
        // does not hold for bridge.port 0: this window got a fresh port, the
        // other window is alive on its own, and unlinking its file left it
        // listening but unreachable - the exact failure the module comment
        // says was fixed once already. So look before unlinking.
        let seen;
        try {
          seen = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          seen = undefined; // unparseable: stale, or a plant
        }
        if (seen && Number.isInteger(seen.pid) && seen.pid !== process.pid && alive(seen.pid)) {
          throw new Error(
            `another VS Code window (pid ${seen.pid}) already advertises a bridge at ${file}. ` +
              'Stop its bridge first, or this one would be unreachable.'
          );
        }
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
    const reading = req.method === 'GET' || req.method === 'HEAD';
    if (reading && url.pathname === '/health' && this.authorized(req)) {
      const notebook = this.resolveNotebook();
      return send(res, 200, {
        ok: true,
        notebook: notebook ? notebook.uri.fsPath : null,
        cells: notebook ? notebook.cellCount : 0,
        // So a client can tell an old host from a broken one. There was no way
        // to: a 0.5.0 client asking a 0.4.0 bridge for /cells got "use POST",
        // which says nothing about the endpoint being absent.
        version: this.version,
        supports: ['cells', 'replace', 'expect', 'stream'],
      });
    }
    if (!this.authorized(req)) return send(res, 401, { error: 'bad or missing token' });

    // Reading is routed before the POST-only gate. An agent that can add a cell
    // but never look at one cannot check its own work, or see what the user
    // changed afterwards.
    if (reading && url.pathname === '/cells') {
      return send(res, 200, this.readCells(url.searchParams));
    }

    const KNOWN = ['/health', '/cells', '/cell', '/cell/replace', '/cell/stream'];
    if (!KNOWN.includes(url.pathname)) {
      return send(res, 404, { error: `unknown path: ${url.pathname}` });
    }
    if (req.method !== 'POST') {
      // Allow, per RFC 9110 - and a 405 now means "wrong method for a path I
      // have", never "I have never heard of that path".
      res.setHeader('allow', url.pathname === '/cells' || url.pathname === '/health' ? 'GET' : 'POST');
      return send(res, 405, { error: `use POST for ${url.pathname}` });
    }

    if (url.pathname === '/cell') {
      requireJson(req);
      const body = await readJson(req);
      // The body supplies content and nothing else. It used to be spread into
      // the options bag, so any key a caller invented became an option - and
      // body keys beat the query string. Options come from the URL, which is
      // also what the README has always documented.
      const raw = typeof body.code === 'string' ? body.code : body.text;
      if (typeof raw !== 'string') {
        return send(res, 400, { error: 'body needs a "code" string' });
      }
      // Checked before the cell is created, so a rejected push leaves nothing.
      const code = validate.cellText(raw);
      const writer = await this.openWriter({ search: url.searchParams });
      let result;
      try {
        writer.write(code);
        result = await this.closeWriter(writer, { search: url.searchParams });
      } catch (err) {
        await writer.abandon();
        throw err;
      }
      // Outside the try: a client that hung up before the answer arrived has
      // still had its cell written, and undoing that would be wrong twice.
      return send(res, 200, result);
    }

    if (url.pathname === '/cell/replace') {
      // Rewriting an existing cell, as opposed to adding one. Deliberately
      // separate from /cell: appending is additive and forgiving, replacing
      // destroys what was there, so it must be asked for by name and by index.
      requireJson(req);
      const body = await readJson(req);
      const raw = typeof body.code === 'string' ? body.code : body.text;
      if (typeof raw !== 'string') {
        return send(res, 400, { error: 'body needs a "code" string' });
      }
      const code = validate.cellText(raw);
      const notebook = this.resolveNotebook(url.searchParams.get('notebook'));
      if (!notebook) throw new BridgeError('no notebook is open in VS Code', 409);
      const at = Number(url.searchParams.get('index'));
      if (!Number.isInteger(at) || at < 0 || at >= notebook.cellCount) {
        throw new BridgeError(
          `index must be a cell that exists: 0..${notebook.cellCount - 1}`,
          400
        );
      }
      const cell = notebook.cellAt(at);
      // Handed back so the caller - and the user reading a log - can see what
      // was destroyed. Ctrl+Z also restores it, but only if somebody noticed.
      const previous = cell.document.getText();

      // An optional precondition on what the caller believes it is replacing.
      //
      // A read from /cells is clipped at 4000 characters, and nothing stopped a
      // caller reconstructing a clipped cell and writing the truncation back
      // over the real thing. Indices also shift under a live editor, so "cell 7"
      // at read time need not be cell 7 now. Optional in 0.6.0 and required
      // later, so existing callers keep working while they are updated.
      const expect = url.searchParams.get('expect');
      if (expect !== null && expect !== previous) {
        throw new BridgeError(
          `cell ${at} does not contain what you expected, so it was not replaced. ` +
            'Read it again and retry if you still want to.',
          409
        );
      }
      if (expect === null) {
        log(`replace: cell ${at} rewritten with no expect= precondition`);
      }

      const writer = await CellWriter.replace(notebook, cell);
      let result;
      try {
        writer.write(code);
        // The guard that has always protected /cell, on the one path where the
        // consequence is destruction rather than clutter. Without it a body of
        // "", " ", "\n" or "```" answered 200 and BLANKED the cell - measured,
        // and the fix changed no existing test, which is why it survived.
        await requireProduced(writer, 'replace');
        const text = await writer.end();
        // A cell changing under the user's cursor used to leave NO trace at all:
        // no log line, nothing on screen. The only evidence was the text itself
        // being different, and Ctrl+Z only helps somebody who noticed.
        log(`replace: cell ${at} in ${path.basename(notebook.uri.fsPath)} - ` +
          `${previous.length} chars replaced with ${text.length}`);
        this.notify(
          'info',
          `An agent rewrote cell ${at} of ${path.basename(notebook.uri.fsPath)}. Ctrl+Z undoes it.`
        );
        result = {
          ok: true,
          notebook: notebook.uri.fsPath,
          index: at,
          characters: text.length,
          replaced: previous,
        };
      } catch (err) {
        await writer.abandon();
        throw err;
      }
      return send(res, 200, result);
    }

    if (url.pathname === '/cell/stream') {
      // The request body is streamed straight into the cell, so a piped
      // generator shows up in the notebook as it produces text.
      req.setEncoding('utf8');
      let size = 0;
      // Deliberately not opened until the first byte arrives. Opening on the
      // headers meant a client that connected and then stalled - nbpush on a
      // terminal, waiting for stdin that never came - left an empty cell
      // sitting in the notebook for as long as it hung.
      let writer;
      try {
        // destroyOnReturn: false, because leaving this loop early - which is
        // exactly what a 413 or a bad character does - would otherwise destroy
        // the request, and a destroyed request means Node resets the socket
        // before send() can drain it and deliver the status.
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          size += Buffer.byteLength(chunk); // bytes, as the README says - not UTF-16 units
          if (size > MAX_BODY) throw new BridgeError('body too large', 413);
          // Per chunk, before anything is written. Node's utf8 decoder joins
          // multi-byte sequences split across chunks, so a surrogate pair is
          // never torn apart here - an unpaired one really was sent as one.
          validate.cellText(chunk);
          if (!writer) writer = await this.openWriter({ search: url.searchParams });
          writer.write(chunk);
        }
      } catch (err) {
        // The push failed, so take the half-written cell back out. Note the
        // status comes from the error: a client that hung up is a 400, not the
        // 413 every failure in this loop used to report.
        if (writer) await writer.abandon();
        return send(res, (err && err.status) || 400, {
          error: String((err && err.message) || err),
        });
      }
      if (!writer) {
        return send(res, 400, { error: 'nothing to insert: the request body was empty' });
      }
      try {
        return send(res, 200, await this.closeWriter(writer, { search: url.searchParams }));
      } catch (err) {
        // /cell wraps this and /cell/stream did not, so a failure in the final
        // write left the half-written cell sitting in the notebook.
        await writer.abandon();
        throw err;
      }
    }

    return send(res, 404, { error: `unknown path: ${url.pathname}` });
  }

  /**
   * The live contents of the open notebook.
   *
   * Reads the document VS Code has in memory, so it reflects unsaved edits -
   * which is the whole point, since the file on disk can be arbitrarily out of
   * date while a tab is open.
   */
  readCells(search) {
    const hint = search.get('notebook');
    const notebook = this.resolveNotebook(hint);
    if (!notebook) {
      throw new BridgeError(
        hint ? `no open notebook matches ${JSON.stringify(hint)}` : 'no notebook is open in VS Code',
        409
      );
    }
    const all = notebook.getCells();
    const from = clampIndex(search.get('from'), 0, all.length);
    let to = clampIndex(search.get('to'), all.length, all.length);
    // Per-cell clipping bounded the size of each cell and nothing bounded the
    // number of them, so a large notebook forced a multi-megabyte response from
    // one authenticated GET. Page instead: the caller is told where to resume.
    let more = false;
    if (to - from > MAX_CELLS) {
      to = from + MAX_CELLS;
      more = true;
    }
    const wantOutputs = search.get('outputs') === '1';
    // A notebook can be far larger than anything worth sending in one response,
    // so each cell is clipped and the caller is told when that happened.
    const LIMIT = 4000;
    let truncated = false;

    const cells = all.slice(from, Math.max(from, to)).map((cell) => {
      const text = cell.document.getText();
      const clipped = text.length > LIMIT;
      if (clipped) truncated = true;
      const out = {
        index: cell.index,
        kind: cellKindName(cell),
        language: cell.document.languageId,
        source: clipped ? clipText(text, LIMIT) : text,
      };
      // Per cell, not just once for the whole response. A caller deciding
      // whether it may safely rewrite cell 7 needs to know about CELL 7, and a
      // response-level flag set by some other cell tells it nothing. This is the
      // read half of the same hazard `expect=` guards on the write half.
      if (clipped) out.truncated = true;
      if (wantOutputs) {
        const seen = readOutputs(cell);
        if (seen.error) out.error = seen.error;
        if (seen.text) out.output = seen.text;
        // Outputs are clipped too, and that never set the flag at all - so a
        // response could carry "...<truncated>" while claiming nothing was.
        if (seen.truncated) {
          out.truncated = true;
          truncated = true;
        }
      }
      return out;
    });

    return {
      ok: true,
      notebook: notebook.uri.fsPath,
      count: all.length,
      from,
      cells,
      truncated,
      ...(more ? { more: true, next: to } : {}),
    };
  }

  async openWriter(options) {
    const hint = options.search.get('notebook');
    const notebook = this.resolveNotebook(hint);
    if (!notebook) {
      // A hint that matched nothing used to fall through and write to whatever
      // notebook happened to be active. Landing in the wrong file silently is
      // worse than being told.
      if (hint) {
        const open = this.listNotebooks ? this.listNotebooks() : [];
        throw new BridgeError(
          `no open notebook matches ${JSON.stringify(hint)}` +
            (open.length ? `. Open: ${open.join(', ')}` : ''),
          409
        );
      }
      throw new BridgeError('no notebook is open in VS Code', 409);
    }
    const kind = validate.cellKind(options.search.get('kind'));
    const editor = editorFor(notebook);
    const index = validate.cellPosition(options.search.get('position'), {
      cellCount: notebook.cellCount,
      below: editor ? editor.selection.end : notebook.cellCount,
      above: editor ? editor.selection.start : 0,
    });
    return CellWriter.insert(notebook, index, {
      kind,
      language: validate.cellLanguage(options.search.get('language')),
      // Markdown cells keep their fenced code blocks, exactly as the explain
      // command already did. Only this path got it wrong.
      fenced: kind !== 'markdown',
    });
  }

  async closeWriter(writer, options) {
    // Query string only, like every other option. Reading a body key here was
    // the last way a caller-invented field could influence execution.
    const raw = options.search.get('run');
    // undefined means "no opinion", which lets the user's setting decide.
    // An explicit false is honoured; an explicit true is only a request.
    const requested = raw === undefined || raw === null ? undefined : validate.boolish(raw);
    // Nothing usable arrived: take the cell back out rather than leaving an
    // empty one behind. pump() has always done this; the bridge did not.
    await requireProduced(writer, 'insert');
    const text = await writer.end();
    const decision = await this.decideRun({
      requested,
      preview: text,
      // Never hold an HTTP socket open waiting for a human to answer a dialog.
      blocking: false,
      onLateApproval: async () => {
        const cell = writer.cell();
        if (!cell) return;
        // What was approved, not merely which cell. The dialog can be open for
        // as long as the user takes to read it, and another request can rewrite
        // that cell in the meantime - so the code being run here is checked
        // against the code that was actually shown.
        if (!(await runApproved(writer.notebook, cell.index, text))) {
          log(`late approval declined: cell ${cell.index} changed after it was shown`);
          this.notify(
            'warning',
            'AI Notebook Live: that cell changed while the approval was open, so it was not run. ' +
              'Look at it and run it yourself if you still want to.'
          );
        }
      },
    });
    if (decision.run && !(await runApproved(writer.notebook, writer.index, text))) {
      log(`execution declined: cell ${writer.index} changed before it could run`);
    }
    return {
      ok: true,
      // Which notebook it actually landed in. nbpush echoes this, and it is what
      // makes a mis-targeted push visible instead of silent.
      notebook: writer.notebook.uri.fsPath,
      index: writer.index,
      characters: text.length,
      ran: Boolean(decision.run),
      pending: Boolean(decision.pending),
      reason: decision.reason,
    };
  }
}

/** A whole-number index inside the notebook, or a stated default. */
function clampIndex(raw, fallback, count) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new BridgeError(`from/to must be whole numbers, not ${JSON.stringify(String(raw))}`, 400);
  }
  return Math.min(Math.max(0, n), count);
}

/**
 * Refuse a writer that has nothing worth writing, and leave no trace.
 *
 * Lifted out of closeWriter so /cell/replace can use it too. Deliberately NOT
 * by routing replace through closeWriter: that also asks the execution policy,
 * and a replaced cell has never been executable. Fixing an empty-body bug is
 * not a reason to hand agents a power they did not have.
 */
async function requireProduced(writer, what) {
  if (writer.produced()) return;
  await writer.abandon();
  throw new BridgeError(`nothing to ${what}: the body produced no content`, 400);
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  const req = res.req;
  const unread = Boolean(req) && !req.readableEnded && !req.destroyed;
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
  if (!unread) return;
  // Ending a response while the request body is still arriving makes Node reset
  // the socket, and a reset DISCARDS the bytes we just wrote - so the caller got
  // ECONNRESET instead of the 413 explaining what it did wrong. Draining the
  // rest lets the close be graceful and the status actually arrive.
  //
  // Bounded, so an endless upload cannot hold the connection open: whatever has
  // not turned up within the window was not going to.
  req.resume();
  const giveUp = setTimeout(() => req.destroy(), DRAIN_MS);
  if (giveUp.unref) giveUp.unref();
  const done = () => clearTimeout(giveUp);
  req.once('end', done);
  req.once('error', done);
  req.once('close', done);
}

/**
 * A JSON endpoint should say so when handed something else. A missing header is
 * forgiven - curl users rarely set one - but text/plain or a form encoding was
 * being JSON-parsed regardless, which is the kind of guess this file exists not
 * to make.
 */
function requireJson(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type && type !== 'application/json') {
    throw new BridgeError(`send application/json, not ${type}`, 415);
  }
}

async function readJson(req) {
  let body = '';
  req.setEncoding('utf8');
  // Same reason as /cell/stream: throwing out of this loop must not destroy the
  // request, or the 413 never reaches the caller.
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    body += chunk;
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_BODY) throw new BridgeError('body too large', 413);
  }
  if (!body.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new BridgeError('body is not valid JSON', 400);
  }
  // A body of `null` used to reach `body.code` and throw a TypeError that
  // surfaced as a 500 with an internal message in it. Arrays and scalars parsed
  // fine and then failed confusingly further along.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BridgeError('body must be a JSON object', 400);
  }
  return parsed;
}

module.exports = { Bridge, BridgeError, defaultInfoDir };
