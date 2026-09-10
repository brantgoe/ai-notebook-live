'use strict';
/**
 * Coercion and shape checks for values that arrive from outside.
 *
 * This module exists because every boundary used to hand-roll its own rules and
 * each got them differently wrong: a float position reached insertCells(2.7),
 * `?kind=Markdown` silently became a code cell, and a language string went
 * straight into a VS Code API with no coercion at all.
 *
 * The rule throughout is LENIENT ABOUT SHAPE, STRICT ABOUT MEANING. Case and
 * surrounding whitespace are forgiven, because there is only one sane reading.
 * A token nobody recognises is refused, because guessing is what produced the
 * bugs above.
 *
 * DELIBERATELY DEPENDENCY-FREE - it must not require anything, not even vscode,
 * so it stays usable from every layer. There is a test that asserts this.
 */

/** Thrown for input a caller could fix. Carries the status the bridge should send. */
class InvalidInput extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/** Squeezes a value into range, where "as much as allowed" is the sane answer. */
function clamp(value, low, high, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(high, Math.max(low, Math.round(n)));
}

/**
 * Falls back to the default when out of range rather than clamping, for values
 * where the nearest legal answer would itself be a surprise: contextCells of -7
 * must not quietly mean "send no context", and port 80 must not mean 1024.
 */
function inRangeOr(value, low, high, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const r = Math.round(n);
  return r >= low && r <= high ? r : fallback;
}

/** 'code' or 'markdown'. Case is forgiven; an unrecognised word is not. */
function cellKind(value) {
  if (value === undefined || value === null || value === '') return 'code';
  const word = String(value).trim().toLowerCase();
  if (word === 'code') return 'code';
  if (word === 'markdown' || word === 'markup') return 'markdown';
  throw new InvalidInput(`kind must be code or markdown, not ${JSON.stringify(String(value))}`);
}

/**
 * A cell index, or one of the named positions the bridge understands.
 *
 * Past the end clamps, because "append" is the one sane reading. Anything that
 * is not a whole number is refused: an off-by-half index means the caller's
 * arithmetic is wrong and it deserves to be told, and "round it" is the guess
 * that let insertCells(2.7) happen.
 */
function cellPosition(value, { cellCount, below, above }) {
  if (value === undefined || value === null || value === '' || value === 'below') return below;
  const word = String(value).trim().toLowerCase();
  if (word === 'below') return below;
  if (word === 'above') return above;
  if (word === 'end') return cellCount;
  const n = Number(word);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new InvalidInput(
      `position must be a whole number, or below/above/end, not ${JSON.stringify(String(value))}`
    );
  }
  return Math.min(Math.max(0, n), cellCount);
}

/**
 * A kernel language hint. Advisory, so a value we cannot use is ignored rather
 * than refused - never reject something you were going to throw away anyway.
 * Deliberately not an allow-list: R, Julia, SQL and Scala kernels are all real.
 */
function cellLanguage(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const word = String(value).trim().toLowerCase();
  return /^[a-z0-9][a-z0-9+#._-]{0,31}$/.test(word) ? word : undefined;
}

/** The bridge's boolean query convention. Anything unrecognised means false. */
function boolish(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

/** One of a known set, or a stated fallback. Used to fail closed on typos. */
function oneOf(value, allowed, fallback) {
  const word = String(value === undefined || value === null ? '' : value)
    .trim()
    .toLowerCase();
  return allowed.includes(word) ? word : fallback;
}


/**
 * Text that is about to become a notebook cell.
 *
 * Refuses rather than sanitises: silently altering somebody's code is exactly
 * the content loss this project spent a release removing. A caller that sent
 * something unusable deserves to be told which character.
 *
 * What is refused, and why each one matters:
 *
 *  - LONE SURROGATES. VS Code writes notebooks with JavaScript, which escapes
 *    an unpaired surrogate happily. Python - which is nbformat, nbconvert,
 *    papermill, and effectively the whole notebook toolchain - can READ that
 *    file but cannot write it back out: UnicodeEncodeError. One pushed cell
 *    makes the notebook unprocessable, with an error that names Unicode rather
 *    than the cell that caused it.
 *  - NUL, and the other C0 controls. `compile()` refuses a NUL outright
 *    ("source code string cannot contain null bytes"), so the cell looks fine,
 *    saves fine, and fails at execution with a message that never names it.
 *  - U+2028 and U+2029. Python calls these "invalid non-printable character".
 *
 * Tab, newline and carriage return are allowed. A literal ESC is not, which is
 * worth explaining because it looks over-strict: a colour code in Python source
 * is written "\\x1b[31m" - backslash, x, 1, b - which is ordinary ASCII and
 * passes untouched. A RAW ESC byte in the source of a cell is almost always an
 * accident or an injection, and refusing it costs nobody anything.
 */
function cellText(value, { field = 'code' } = {}) {
  if (typeof value !== 'string') {
    throw new InvalidInput(`${field} must be a string`);
  }
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (c < 0x20 || c === 0x7f) {
      throw new InvalidInput(
        `${field} contains a control character (U+${c.toString(16).toUpperCase().padStart(4, '0')}) ` +
          `at position ${i}, which a notebook kernel cannot run`
      );
    }
    if (c === 0x2028 || c === 0x2029) {
      throw new InvalidInput(
        `${field} contains U+${c.toString(16).toUpperCase()} at position ${i}, ` +
          'which Python rejects as a non-printable character'
      );
    }
    // A high surrogate must be followed by a low one, and a low one must not
    // appear alone. Either way round, the result cannot be encoded as UTF-8.
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new InvalidInput(
          `${field} contains an unpaired surrogate at position ${i}. The notebook ` +
            'would become unreadable to nbformat, nbconvert and papermill'
        );
      }
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new InvalidInput(
        `${field} contains an unpaired surrogate at position ${i}. The notebook ` +
          'would become unreadable to nbformat, nbconvert and papermill'
      );
    }
  }
  return value;
}

module.exports = {
  InvalidInput,
  clamp,
  inRangeOr,
  cellKind,
  cellText,
  cellPosition,
  cellLanguage,
  boolish,
  oneOf,
};
