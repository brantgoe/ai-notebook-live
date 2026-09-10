#!/usr/bin/env node
'use strict';
/**
 * Bundles the extension host entry point.
 *
 * Unbundled, the .vsix carried 2,399 files and 9.6 MB uncompressed - almost all
 * of it the Anthropic SDK's source maps, .d.ts files and ESM builds, none of
 * which the CommonJS runtime ever loads.
 *
 * bin/nbpush.js is deliberately NOT an entry point: it is a standalone CLI that
 * imports only Node builtins, and it ships as-is.
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [path.join(root, 'extension.js')],
  outfile: path.join(root, 'dist', 'extension.js'),
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  // Provided by the extension host, never bundled.
  external: [
    'vscode',
    // An optional peer dependency of @anthropic-ai/sdk that is not installed;
    // without this the build fails to resolve it.
    'zod',
  ],
  minify: !watch,
  sourcemap: false,
  legalComments: 'none', // notices ship as THIRD-PARTY-NOTICES.md instead
  metafile: true,
  logLevel: 'info',
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    return;
  }
  const result = await esbuild.build(options);
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'dist', 'metafile.json'),
    JSON.stringify(result.metafile, null, 2)
  );
  const bytes = fs.statSync(options.outfile).size;
  process.stdout.write(`bundled dist/extension.js - ${(bytes / 1024).toFixed(0)} KB\n`);
  require('./licenses.js').generate(result.metafile);
}

main().catch((err) => {
  process.stderr.write(`${(err && err.message) || err}\n`);
  process.exit(1);
});
