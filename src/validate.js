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

module.exports = {
  InvalidInput,
  clamp,
  inRangeOr,
  cellKind,
  cellPosition,
  cellLanguage,
  boolish,
  oneOf,
};
