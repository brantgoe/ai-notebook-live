'use strict';
const vscode = require('vscode');

let channel;

function output() {
  if (!channel) channel = vscode.window.createOutputChannel('AI Notebook Live');
  return channel;
}

function log(...parts) {
  // Date as well as time. A pasted output channel could not be ordered against
  // anything, and a session spanning midnight read as though it went backwards.
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  output().appendLine(`[${stamp}] ${parts.join(' ')}`);
}

function show() {
  output().show(true);
}

function dispose() {
  if (channel) channel.dispose();
  channel = undefined;
}

module.exports = { log, show, dispose };
