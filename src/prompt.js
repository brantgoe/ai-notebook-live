'use strict';
const vscode = require('vscode');
const path = require('path');
const { readOutputs, notebookLanguage, clipText } = require('./notebook');

const CELL_CLIP = 2000;

function baseSystem(language, extra) {
  const lines = [
    `You write cells for a Jupyter notebook whose kernel language is ${language}.`,
    '',
    'Output rules (these are absolute):',
    '- Reply with the literal contents of the cell and nothing else.',
    '- No markdown code fences, no "Here is...", no explanation outside the cell.',
    '- Explanations belong in comments inside the code.',
    '- The cell is appended to a live notebook and may be executed immediately, so',
    '  it must be valid, runnable, self-contained code for that kernel.',
    '- Reuse the variables, imports, and style already established in the notebook',
    '  instead of redefining them.',
    '- Never include shell prompts, cell markers like "In [1]:", or line numbers.',
  ];
  if (extra && extra.trim()) {
    lines.push('', 'House style from the notebook owner:', extra.trim());
  }
  return lines.join('\n');
}

function markdownSystem(extra) {
  const lines = [
    'You write markdown cells for a Jupyter notebook used for teaching.',
    '',
    'Output rules (these are absolute):',
    '- Reply with the literal markdown for the cell and nothing else.',
    '- Do not wrap the whole answer in a code fence.',
    '- Be concise: a short heading is fine, then a few sentences or bullets.',
    '- Explain what the code does and why, in plain language.',
  ];
  if (extra && extra.trim()) {
    lines.push('', 'House style from the notebook owner:', extra.trim());
  }
  return lines.join('\n');
}

function clip(text, limit = CELL_CLIP) {
  // Shared, so the surrogate-splitting fix cannot be applied to two of the
  // three clip sites and forgotten at the third.
  return clipText(text, limit);
}

function describeCell(cell, { includeOutputs }) {
  const kind = cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown';
  const parts = [`--- cell ${cell.index} [${kind}] ---`, clip(cell.document.getText())];
  if (includeOutputs && cell.kind === vscode.NotebookCellKind.Code) {
    const { error, text } = readOutputs(cell, { limit: 800 });
    if (text) parts.push('--- output ---', text.trimEnd());
    if (error) parts.push('--- error ---', error.trimEnd());
  }
  return parts.join('\n');
}

/**
 * Builds the notebook context: the cells before the insertion point, newest
 * last, so the model sees the state the new cell will run against.
 */
function notebookContext(notebook, upto, { contextCells, includeOutputs }) {
  const cells = notebook.getCells().slice(0, upto);
  const kept = contextCells < 0 ? cells : cells.slice(Math.max(0, cells.length - contextCells));
  const header = [
    `Notebook: ${path.basename(notebook.uri.fsPath)} (${notebookLanguage(notebook)} kernel, ${notebook.cellCount} cells)`,
  ];
  if (kept.length < cells.length) {
    header.push(`(${cells.length - kept.length} earlier cells omitted)`);
  }
  if (!kept.length) header.push('(the notebook has no cells above this point)');
  return [header.join(' '), '', ...kept.map((c) => describeCell(c, { includeOutputs }))].join('\n');
}

function generatePrompt({ notebook, index, instruction, opts }) {
  return {
    system: baseSystem(notebookLanguage(notebook), opts.systemPromptExtra),
    user: [
      notebookContext(notebook, index, opts),
      '',
      `A new cell is being inserted at position ${index}. Write its contents.`,
      '',
      'Request:',
      instruction,
    ].join('\n'),
  };
}

function revisePrompt({ notebook, cell, instruction, opts }) {
  // describeCell honoured includeOutputs and these two did not, so turning the
  // switch off still shipped the target cell's stdout and traceback - the one
  // cell whose output is likeliest to hold the dataframe you did not want sent.
  const { error, text } = opts.includeOutputs
    ? readOutputs(cell, { limit: 1200 })
    : { error: '', text: '' };
  const current = [
    'The cell to rewrite:',
    '--- begin cell ---',
    cell.document.getText(),
    '--- end cell ---',
  ];
  if (text) current.push('', 'Its last output:', text.trimEnd());
  if (error) current.push('', 'Its last error:', error.trimEnd());
  return {
    system: baseSystem(notebookLanguage(notebook), opts.systemPromptExtra),
    user: [
      notebookContext(notebook, cell.index, opts),
      '',
      ...current,
      '',
      'Rewrite this cell in full. Keep everything that already works; change only',
      'what the request asks for.',
      '',
      'Request:',
      instruction,
    ].join('\n'),
  };
}

function fixPrompt({ notebook, cell, opts }) {
  // Asking to fix an error is itself a request to send that error, so the
  // traceback goes either way - saying otherwise would make the command a lie.
  // Stdout is a different matter: nothing about "fix this" implies the
  // dataframe printed above it, so that stops when includeOutputs is off.
  const { error, text: stdout } = readOutputs(cell, { limit: 2000 });
  const text = opts.includeOutputs ? stdout : '';
  return {
    system: baseSystem(notebookLanguage(notebook), opts.systemPromptExtra),
    user: [
      notebookContext(notebook, cell.index, opts),
      '',
      'This cell failed:',
      '--- begin cell ---',
      cell.document.getText(),
      '--- end cell ---',
      '',
      error ? `The error it raised:\n${error.trimEnd()}` : 'It produced the wrong result.',
      text ? `\nOutput before the failure:\n${text.trimEnd()}` : '',
      '',
      'Rewrite the cell so it runs correctly. Fix the actual cause rather than',
      'suppressing the error, keep the original intent, and make the smallest',
      'change that works. Add a brief comment on the line you changed.',
    ].join('\n'),
  };
}

function explainPrompt({ notebook, cell, opts }) {
  return {
    system: markdownSystem(opts.systemPromptExtra),
    user: [
      notebookContext(notebook, cell.index, opts),
      '',
      'Write a short markdown cell to sit directly above this cell, explaining it',
      'to someone learning to code:',
      '--- begin cell ---',
      cell.document.getText(),
      '--- end cell ---',
    ].join('\n'),
  };
}

module.exports = { generatePrompt, revisePrompt, fixPrompt, explainPrompt };
