'use strict';
/* Plain-node tests for the logic that does not need a running VS Code:
   fence stripping, live cell writing, and the agent bridge. */
const assert = require('assert');
const http = require('http');
const Module = require('module');
const path = require('path');

// The bridge advertises its port and token in a file. Point it at a throwaway
// directory BEFORE requiring it: this suite used to write over, and then delete,
// the token file of a real bridge running in another VS Code window.
const fs = require('fs');
const os = require('os');
const BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-notebook-live-test-'));
process.env.AI_NOTEBOOK_LIVE_HOME = BRIDGE_HOME;

// Redirect require('vscode') to the stub before loading extension code.
const stubPath = require.resolve('./vscode-stub.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return stubPath;
  return originalResolve.call(this, request, ...rest);
};

const vscode = require('./vscode-stub.js');
const { CellWriter, unfence, readOutputs, runCell } = require(path.join('..', 'src', 'notebook.js'));
const { Bridge } = require(path.join('..', 'src', 'bridge.js'));

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function newNotebook(cells = []) {
  const notebook = new vscode.NotebookDocument(
    '/tmp/Test_Notebook.ipynb',
    cells.map((c) =>
      typeof c === 'string'
        ? { kind: vscode.NotebookCellKind.Code, value: c, languageId: 'python' }
        : c
    ),
    { metadata: { kernelspec: { language: 'python' } } }
  );
  vscode.__test.notebooks.length = 0;
  vscode.__test.notebooks.push(notebook);
  vscode.__test.executed.length = 0;
  vscode.window.visibleNotebookEditors.length = 0;
  return notebook;
}

/* ------------------------------- unfence -------------------------------- */

test('unfence strips a fenced block with a language tag', () => {
  assert.strictEqual(unfence('```python\nprint(1)\n```'), 'print(1)');
});

test('unfence leaves unfenced code alone', () => {
  assert.strictEqual(unfence('print(1)\n'), 'print(1)\n');
});

test('unfence keeps a fence that is inside a markdown answer body', () => {
  const raw = 'text\n```python\nx=1\n```';
  assert.strictEqual(unfence(raw), raw);
});

test('unfence is prefix-stable while a response streams in', () => {
  const full = '```python\nimport math\nprint(math.pi)\n```';
  const final = unfence(full);
  for (let i = 1; i <= full.length; i += 1) {
    const partial = unfence(full.slice(0, i));
    assert.ok(
      final.startsWith(partial),
      `prefix ${i} produced "${partial}" which is not a prefix of the final text`
    );
  }
});

test('unfence emits nothing while an opening fence is still arriving', () => {
  for (const partial of ['`', '``', '```', '```py', '```python']) {
    assert.strictEqual(unfence(partial), '');
  }
});

/* ------------------------------ CellWriter ------------------------------ */

test('insert streams chunks into a new cell and strips fences', async () => {
  const notebook = newNotebook(['x = 1']);
  const writer = await CellWriter.insert(notebook, 1, { kind: 'code' });
  assert.strictEqual(notebook.cellCount, 2);
  for (const chunk of ['```pyth', 'on\nprint(', 'x)\n', '```']) {
    writer.write(chunk);
    await writer.flush();
  }
  const text = await writer.end();
  assert.strictEqual(text, 'print(x)');
  assert.strictEqual(notebook.cellAt(1).document.getText(), 'print(x)');
});

test('writer survives cells shifting underneath it', async () => {
  const notebook = newNotebook(['a = 1', 'b = 2']);
  const writer = await CellWriter.insert(notebook, 2, { kind: 'code' });
  writer.write('print(a + b)');
  // Something else inserts a cell above ours mid-stream.
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [
    vscode.NotebookEdit.insertCells(0, [
      new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '# header', 'python'),
    ]),
  ]);
  await vscode.workspace.applyEdit(edit);
  const text = await writer.end();
  assert.strictEqual(text, 'print(a + b)');
  assert.strictEqual(writer.index, 3);
  assert.strictEqual(notebook.cellAt(3).document.getText(), 'print(a + b)');
  assert.strictEqual(notebook.cellAt(0).document.getText(), '# header');
});

test('replace rewrites an existing cell in place', async () => {
  const notebook = newNotebook(['prnt("typo")']);
  const writer = await CellWriter.replace(notebook, notebook.cellAt(0));
  assert.strictEqual(
    notebook.cellAt(0).document.getText(),
    'prnt("typo")',
    'the original must survive until the model produces something'
  );
  writer.write('print("typo")');
  const replaced = await writer.end();
  await runCell(notebook, writer.index);
  assert.strictEqual(replaced, 'print("typo")');
  assert.strictEqual(notebook.cellCount, 1);
  assert.strictEqual(notebook.cellAt(0).document.getText(), 'print("typo")');
  assert.deepStrictEqual(vscode.__test.executed[0].payload.ranges, [{ start: 0, end: 1 }]);
});

test('markdown cells keep their fenced code blocks', async () => {
  const notebook = newNotebook(['x = 1']);
  const writer = await CellWriter.insert(notebook, 0, { kind: 'markdown', fenced: false });
  writer.write('## Setup\n\n```python\nx = 1\n```');
  const text = await writer.end();
  assert.ok(text.includes('```python'));
  assert.strictEqual(notebook.cellAt(0).kind, vscode.NotebookCellKind.Markup);
});

test('empty generations leave an empty cell the caller can drop', async () => {
  const notebook = newNotebook([]);
  const writer = await CellWriter.insert(notebook, 0, { kind: 'code' });
  const text = await writer.end();
  assert.strictEqual(text, '');
  assert.strictEqual(vscode.__test.executed.length, 0, 'must not execute an empty cell');
});

test('a failed replace hands the cell back exactly as it was', async () => {
  const notebook = newNotebook(['answer = 42  # hard-won']);
  const writer = await CellWriter.replace(notebook, notebook.cellAt(0));
  writer.write('answer = ');
  await writer.flush();
  const { restored, partial } = await writer.abandon();
  assert.ok(restored);
  assert.strictEqual(partial, 'answer = ', 'the partial is offered back to the caller');
  assert.strictEqual(
    notebook.cellAt(0).document.getText(),
    'answer = 42  # hard-won',
    'the user gets their own code back, not a half-written statement'
  );
});

test('a writer abandoned after a restore cannot clobber it later', async () => {
  // The landmine: write() checked `closed` but flush() did not, so a flush that
  // was still in flight landed after the restore and overwrote it again.
  const notebook = newNotebook(['keep = "me"']);
  const writer = await CellWriter.replace(notebook, notebook.cellAt(0));
  writer.write('destroyed = True');
  await writer.abandon();
  writer.write('and again');
  await writer.flush();
  await writer.flush();
  assert.strictEqual(
    notebook.cellAt(0).document.getText(),
    'keep = "me"',
    'nothing may write through a writer that has been abandoned'
  );
});

test('an abandoned insert removes its own cell and leaves neighbours alone', async () => {
  const notebook = newNotebook(['first', 'second']);
  const writer = await CellWriter.insert(notebook, 1, { kind: 'code' });
  writer.write('half a thought');
  await writer.flush();
  await writer.abandon();
  assert.strictEqual(notebook.cellCount, 2);
  assert.strictEqual(notebook.cellAt(0).document.getText(), 'first');
  assert.strictEqual(notebook.cellAt(1).document.getText(), 'second');
});

test('end() reports the document, and throws instead of faking success', async () => {
  const notebook = newNotebook([]);
  const writer = await CellWriter.insert(notebook, 0, { kind: 'code' });
  writer.write('print("real")');
  const text = await writer.end();
  assert.strictEqual(text, 'print("real")');
  assert.strictEqual(text, notebook.cellAt(0).document.getText(), 'the return value IS the document');

  const second = await CellWriter.insert(notebook, 1, { kind: 'code' });
  second.write('print("this edit will fail")');
  vscode.__test.failApplyEdit = true;
  try {
    await assert.rejects(() => second.end(), /Could not write into the cell/);
  } finally {
    vscode.__test.failApplyEdit = false;
  }
});

test('two concurrent inserts never claim the same cell', async () => {
  const notebook = newNotebook(['x = 1']);
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  // Hold the first insert inside applyEdit while the second one runs to
  // completion, which is exactly the window the index-based claim lost.
  let first = true;
  vscode.__test.onBeforeApply = async () => {
    if (!first) return;
    first = false;
    await gate;
  };
  try {
    const a = CellWriter.insert(notebook, 1, { kind: 'code' });
    const b = CellWriter.insert(notebook, 1, { kind: 'code' });
    release();
    const [wa, wb] = await Promise.all([a, b]);
    assert.notStrictEqual(wa.uri, wb.uri, 'each writer must own a distinct cell');
    wa.write('AAA');
    wb.write('BBB');
    await Promise.all([wa.end(), wb.end()]);
    const texts = notebook.getCells().map((c) => c.document.getText());
    assert.ok(texts.includes('AAA'), 'the first agent kept its content');
    assert.ok(texts.includes('BBB'), 'the second agent kept its content');
  } finally {
    vscode.__test.onBeforeApply = null;
  }
});

test('revising a markdown cell keeps its fenced code blocks', async () => {
  const notebook = newNotebook([
    { kind: vscode.NotebookCellKind.Markup, value: '# notes', languageId: 'markdown' },
  ]);
  const writer = await CellWriter.replace(notebook, notebook.cellAt(0));
  writer.write('## notes\n\n```python\nx = 1\n```');
  const text = await writer.end();
  assert.ok(text.includes('```python'), 'markdown must not be unfenced');
});

/* ------------------------------ readOutputs ----------------------------- */

test('readOutputs pulls errors and stdout out of a cell', () => {
  const notebook = newNotebook(['1/0']);
  const cell = notebook.cellAt(0);
  cell.outputs = [
    {
      items: [
        {
          mime: 'application/vnd.code.notebook.error',
          data: Buffer.from(
            JSON.stringify({ name: 'ZeroDivisionError', message: 'division by zero', stack: 'line 1' })
          ),
        },
        { mime: 'application/vnd.code.notebook.stdout', data: Buffer.from('before the crash\n') },
      ],
    },
  ];
  const { error, text } = readOutputs(cell);
  assert.match(error, /ZeroDivisionError: division by zero/);
  assert.strictEqual(text, 'before the crash\n');
});

/* -------------------------------- bridge -------------------------------- */

function call(port, token, { method = 'POST', path: p = '/cell', body, chunks }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request(
      { host: '127.0.0.1', port, method, path: p, headers: token ? { 'x-ai-notebook-token': token } : {} },
      (res) => {
        let text = '';
        res.on('data', (c) => {
          text += c;
        });
        res.on('end', () => {
          settled = true;
          // The server may answer (and cut us off) before we finish uploading.
          req.destroy();
          resolve({ status: res.statusCode, body: text });
        });
      }
    );
    // Writing into a socket the server already reset is expected once we have
    // an answer, so only a pre-response failure is a real error.
    req.on('error', (err) => {
      if (!settled) reject(err);
    });
    if (chunks) {
      let i = 0;
      const nextChunk = () => {
        if (settled) return undefined;
        if (i >= chunks.length) return req.end();
        req.write(chunks[i], () => {});
        i += 1;
        return setTimeout(nextChunk, 5);
      };
      nextChunk();
    } else {
      req.end(body);
    }
  });
}

test('bridge inserts, streams, runs, and rejects bad tokens', async () => {
  const notebook = newNotebook(['x = 1']);
  const bridge = new Bridge({ resolveNotebook: () => notebook, defaultRun: () => false, infoDir: BRIDGE_HOME });
  const { port, token } = await bridge.start(0);
  try {
    const health = await call(port, token, { method: 'GET', path: '/health' });
    assert.strictEqual(health.status, 200);
    assert.match(health.body, /Test_Notebook\.ipynb/);

    const denied = await call(port, 'wrong-token', { body: JSON.stringify({ code: 'x' }) });
    assert.strictEqual(denied.status, 401);
    assert.strictEqual(notebook.cellCount, 1, 'unauthorized request must not touch the notebook');

    const inserted = await call(port, token, {
      path: '/cell?position=end&run=1',
      body: JSON.stringify({ code: 'print("from an agent")' }),
    });
    assert.strictEqual(inserted.status, 200);
    assert.strictEqual(JSON.parse(inserted.body).index, 1);
    assert.strictEqual(notebook.cellAt(1).document.getText(), 'print("from an agent")');
    assert.strictEqual(vscode.__test.executed.length, 1, 'run=1 should execute the new cell');

    const streamed = await call(port, token, {
      path: '/cell/stream?position=end',
      chunks: ['```python\n', 'import sys\n', 'print(sys.version)\n', '```'],
    });
    assert.strictEqual(streamed.status, 200);
    assert.strictEqual(notebook.cellAt(2).document.getText(), 'import sys\nprint(sys.version)');

    const markdown = await call(port, token, {
      path: '/cell?position=0&kind=markdown',
      body: JSON.stringify({ code: '# Title' }),
    });
    assert.strictEqual(markdown.status, 200);
    assert.strictEqual(notebook.cellAt(0).kind, vscode.NotebookCellKind.Markup);

    const bad = await call(port, token, { body: '{not json' });
    assert.strictEqual(bad.status, 500);
  } finally {
    await bridge.stop();
  }
});

test('drop removes the cell the writer created, leaving the rest alone', async () => {
  const notebook = newNotebook(['x = 1']);
  const writer = await CellWriter.insert(notebook, notebook.cellCount, {});
  writer.write('half a generation');
  assert.strictEqual(notebook.cellCount, 2, 'sanity: the cell was created');
  await writer.drop();
  assert.strictEqual(notebook.cellCount, 1, 'drop must remove the cell it created');
  assert.strictEqual(notebook.cellAt(0).document.getText(), 'x = 1', 'neighbours untouched');
  writer.write('anything after drop');
  await writer.flush();
  assert.strictEqual(notebook.cellCount, 1, 'a dropped writer must not resurrect the cell');
});

test('an over-sized push is rejected and leaves no half-written cell behind', async () => {
  const notebook = newNotebook(['x = 1']);
  const bridge = new Bridge({ resolveNotebook: () => notebook, defaultRun: () => false, infoDir: BRIDGE_HOME });
  const { port, token } = await bridge.start(0);
  try {
    // 5 x 256 KiB = 1.25 MiB, comfortably over the 1 MiB cap.
    const chunk = '# junk\n'.repeat(Math.floor((256 * 1024) / 7));
    const res = await call(port, token, {
      path: '/cell/stream?position=end',
      chunks: [chunk, chunk, chunk, chunk, chunk],
    });
    assert.strictEqual(res.status, 413);
    assert.match(res.body, /body too large/);
    assert.strictEqual(
      notebook.cellCount,
      1,
      'a rejected push must not leave a cell in the notebook'
    );

    // The bridge must still be usable afterwards.
    const after = await call(port, token, {
      path: '/cell?position=end',
      body: JSON.stringify({ code: 'print("still working")' }),
    });
    assert.strictEqual(after.status, 200);
    assert.strictEqual(notebook.cellCount, 2);
    assert.strictEqual(notebook.cellAt(1).document.getText(), 'print("still working")');
  } finally {
    await bridge.stop();
  }
});

test('the bridge writes its token only inside the directory it was given', async () => {
  // Regression: infoDir used to be a module constant, so running this suite
  // clobbered and then deleted the token file of a live bridge in another window.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-nb-isolated-'));
  const notebook = newNotebook(['x = 1']);
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    defaultRun: () => false,
    infoDir: dir,
  });
  const { port, token } = await bridge.start(0);
  const info = path.join(dir, 'bridge.json');
  try {
    assert.strictEqual(bridge.infoFile, info, 'the bridge honours the injected directory');
    assert.ok(fs.existsSync(info), 'the token file lands in the injected directory');
    const parsed = JSON.parse(fs.readFileSync(info, 'utf8'));
    assert.strictEqual(parsed.port, port);
    assert.strictEqual(parsed.token, token);
    assert.strictEqual(parsed.pid, process.pid);
  } finally {
    await bridge.stop();
  }
  assert.ok(!fs.existsSync(info), 'stop() removes the file it wrote');
});

test('bridge refuses to start when no notebook is open', async () => {
  const bridge = new Bridge({ resolveNotebook: () => undefined, defaultRun: () => false, infoDir: BRIDGE_HOME });
  const { port, token } = await bridge.start(0);
  try {
    const res = await call(port, token, { body: JSON.stringify({ code: 'x = 1' }) });
    assert.strictEqual(res.status, 500);
    assert.match(res.body, /no notebook is open/);
  } finally {
    await bridge.stop();
  }
});

/* -------------------------------- prompts -------------------------------- */

const promptsModule = require(path.join('..', 'src', 'prompt.js'));
const providerModule = require(path.join('..', 'src', 'provider.js'));

const OPTS = {
  contextCells: 12,
  includeOutputs: true,
  systemPromptExtra: 'Beginner class: comment every line.',
  model: 'claude-opus-5',
  effort: 'medium',
  maxTokens: 8000,
};

test('generatePrompt carries the notebook context and the house style', () => {
  const notebook = newNotebook(['price = 499.99', 'print(price)']);
  const { system, user } = promptsModule.generatePrompt({
    notebook,
    index: 2,
    instruction: 'add 8% sales tax',
    opts: OPTS,
  });
  assert.match(system, /no markdown code fences|No markdown code fences/i);
  assert.match(system, /python/);
  assert.match(system, /Beginner class/);
  assert.match(user, /price = 499\.99/);
  assert.match(user, /inserted at position 2/);
  assert.match(user, /add 8% sales tax/);
});

test('generatePrompt honours the context window setting', () => {
  const notebook = newNotebook(['a = 1', 'b = 2', 'c = 3', 'd = 4']);
  const { user } = promptsModule.generatePrompt({
    notebook,
    index: 4,
    instruction: 'print them',
    opts: { ...OPTS, contextCells: 2 },
  });
  assert.ok(!user.includes('a = 1'), 'older cells should be dropped');
  assert.match(user, /2 earlier cells omitted/);
  assert.match(user, /d = 4/);
});

test('fixPrompt includes the failing cell and its traceback', () => {
  const notebook = newNotebook(['total = price + "tax"']);
  const cell = notebook.cellAt(0);
  cell.outputs = [
    {
      items: [
        {
          mime: 'application/vnd.code.notebook.error',
          data: Buffer.from(
            JSON.stringify({ name: 'TypeError', message: 'unsupported operand type(s)', stack: 'line 1' })
          ),
        },
      ],
    },
  ];
  const { user } = promptsModule.fixPrompt({ notebook, cell, opts: OPTS });
  assert.match(user, /total = price \+ "tax"/);
  assert.match(user, /TypeError: unsupported operand/);
  assert.match(user, /smallest\n?\s*change/);
});

test('explainPrompt asks for markdown, not code', () => {
  const notebook = newNotebook(['print("hi")']);
  const { system } = promptsModule.explainPrompt({ notebook, cell: notebook.cellAt(0), opts: OPTS });
  assert.match(system, /markdown cells/);
  assert.ok(!/runnable code/.test(system));
});

/* ------------------------------- providers ------------------------------- */

test('provider selection falls back to the claude CLI with no API key', async () => {
  const saved = [process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_AUTH_TOKEN];
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  const secrets = { get: async () => undefined };
  try {
    await assert.rejects(
      () => providerModule.resolveProvider({ provider: 'api' }, secrets),
      (err) => err instanceof providerModule.ProviderError && err.action === 'setKey'
    );
    const auto = await providerModule.resolveProvider({ provider: 'auto' }, secrets);
    assert.strictEqual(auto.kind, 'cli', 'the local claude CLI should be used when no key is set');

    const withKey = await providerModule.resolveProvider(
      { provider: 'auto' },
      { get: async () => 'sk-ant-test' }
    );
    assert.strictEqual(withKey.kind, 'api');
    assert.strictEqual(withKey.key, 'sk-ant-test');
  } finally {
    if (saved[0] !== undefined) process.env.ANTHROPIC_API_KEY = saved[0];
    if (saved[1] !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved[1];
  }
});

/* ------------------------------- activation ------------------------------ */

test('activate registers exactly the commands the manifest contributes', async () => {
  const manifest = require(path.join('..', 'package.json'));
  const extension = require(path.join('..', 'extension.js'));
  vscode.__test.commands.clear();
  const context = {
    subscriptions: [],
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
  };
  extension.activate(context);
  const registered = [...vscode.__test.commands.keys()].sort();
  const contributed = manifest.contributes.commands.map((c) => c.command).sort();
  assert.deepStrictEqual(registered, contributed);
  for (const binding of manifest.contributes.keybindings) {
    assert.ok(contributed.includes(binding.command), `keybinding for unknown ${binding.command}`);
  }
  for (const group of Object.values(manifest.contributes.menus)) {
    for (const item of group) {
      assert.ok(contributed.includes(item.command), `menu item for unknown ${item.command}`);
    }
  }
  assert.ok(context.subscriptions.length >= contributed.length);
  await extension.deactivate();
});

test('cancel and bridge commands are safe to call with nothing running', async () => {
  const handler = vscode.__test.commands.get('aiNotebookLive.cancel');
  assert.strictEqual(typeof handler, 'function');
  await handler();
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      process.stdout.write(`  ok   ${name}\n`);
    } catch (err) {
      failures += 1;
      process.stdout.write(`  FAIL ${name}\n       ${err.message}\n`);
    }
  }
  process.stdout.write(`\n${tests.length - failures}/${tests.length} passed\n`);
  process.exit(failures ? 1 : 0);
})();
