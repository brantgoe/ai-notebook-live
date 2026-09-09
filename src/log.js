'use strict';
const vscode = require('vscode');

let channel;

function output() {
  if (!channel) channel = vscode.window.createOutputChannel('AI Notebook Live');
  return channel;
}

function log(...parts) {
  const stamp = new Date().toISOString().slice(11, 19);
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
