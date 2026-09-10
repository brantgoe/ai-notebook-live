'use strict';
/**
 * Generates THIRD-PARTY-NOTICES.md from what the bundle actually pulled in.
 *
 * This is not optional housekeeping. The dependencies are MIT and Unlicense,
 * and MIT requires its notice to travel with the software. Unbundled, that
 * happened by accident because every node_modules/<pkg>/LICENSE shipped inside
 * the .vsix. Bundling deletes those files, so the obligation has to be met
 * deliberately - and it is Apache-2.0 that we are redistributing them under.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function packagesFrom(metafile) {
  const names = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const at = input.lastIndexOf('node_modules/');
    if (at === -1) continue;
    const rest = input.slice(at + 'node_modules/'.length).split('/');
    names.add(rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]);
  }
  return [...names].sort();
}

function readPackage(name) {
  const dir = path.join(root, 'node_modules', name);
  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    /* nothing to report */
  }
  let text = '';
  for (const candidate of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'UNLICENSE']) {
    try {
      text = fs.readFileSync(path.join(dir, candidate), 'utf8').trim();
      break;
    } catch {
      /* keep looking */
    }
  }
  const repo =
    typeof manifest.repository === 'string'
      ? manifest.repository
      : (manifest.repository && manifest.repository.url) || manifest.homepage || '';
  const author =
    typeof manifest.author === 'string' ? manifest.author : (manifest.author && manifest.author.name) || '';
  return {
    name,
    version: manifest.version || 'unknown',
    license: manifest.license || 'unknown',
    text,
    repo: String(repo).replace(/^git\+/, '').replace(/\.git$/, ''),
    author,
  };
}

/** Canonical texts, for packages that declare a licence and ship no file. */
const CANONICAL = {
  MIT: `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
};

/** Things worth saying about a specific package, checked by hand. */
const NOTES = {
  standardwebhooks:
    "Note: this package's `package.json` declares MIT, while the upstream " +
    'repository publishes an Apache-2.0 LICENSE at its root. The declared ' +
    'licence is reproduced above; Apache-2.0 is the more restrictive of the two ' +
    'and its terms are also honoured here (attribution retained, no trademark ' +
    'use, changes not made). Raised upstream is the right long-term fix.',
};

function generate(metafile) {
  const packages = packagesFrom(metafile).map(readPackage);
  const missing = packages.filter((p) => !p.text);
  const lines = [
    '# Third-party notices',
    '',
    'AI Notebook Live is licensed under Apache-2.0. The published extension',
    'bundles the packages below; their licenses and copyright notices follow, as',
    'those licenses require.',
    '',
    ...packages.map((p) => `- \`${p.name}\` ${p.version} — ${p.license}`),
    '',
  ];
  for (const p of packages) {
    lines.push('---', '', `## ${p.name} ${p.version}`, '', `License: ${p.license}`, '');
    if (p.text) {
      lines.push('```', p.text, '```', '');
    } else {
      // The package declares a license but ships no text for it. Attribute what
      // it does declare and point at the authoritative source, rather than
      // inventing a copyright line it never provided.
      lines.push(
        `This package ships no license file. Its \`package.json\` declares **${p.license}**` +
          `${p.author ? `, authored by ${p.author}` : ''}.`,
        '',
        p.repo ? `Upstream: ${p.repo}` : '',
        '',
        // A URL is not a notice. MIT and BSD both require the permission text
        // itself to travel with the software, so where a package declares one
        // and ships no file, the canonical text of the licence it declared goes
        // here - marked as such, with no copyright line invented on its behalf.
        ...(CANONICAL[p.license]
          ? [
              `No copyright line was supplied by the package. The canonical text of ${p.license}, ` +
                'reproduced so that the permission notice travels with this software:',
              '',
              '```',
              CANONICAL[p.license],
              '```',
              '',
            ]
          : []),
        ...(NOTES[p.name] ? [NOTES[p.name], ''] : [])
      );
    }
  }
  fs.writeFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md'), `${lines.join('\n')}\n`);
  process.stdout.write(
    `THIRD-PARTY-NOTICES.md - ${packages.length} bundled package${packages.length === 1 ? '' : 's'}` +
      `${
        missing.length
          ? `; ${missing.map((m) => m.name).join(', ')} ship no license file and are attributed by declaration`
          : ''
      }\n`
  );
  return packages;
}

module.exports = { generate, packagesFrom, readPackage };
