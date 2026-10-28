/**
 * A small, dependency-free .env reader.
 *
 * Supports the forms people actually paste:
 *
 *     KEY=value
 *     export KEY=value
 *     KEY="value with \n escapes"      (double quotes: \n \r \t \" \\ are expanded)
 *     KEY='{"literal": "json"}'        (single quotes: taken literally, may span lines)
 *     KEY=value   # trailing comment   (a # needs whitespace before it to start a comment)
 *
 * Real environment variables win over the file, like every other dotenv loader, so a value
 * set on a host (Render, Cloud Run, a shell export) is never silently replaced.
 *
 * The parsing cases are in tests/fixtures/env-cases.json (tests/js/server-envfile.test.js).
 */
import fs from 'node:fs';

const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const ESCAPES = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

/**
 * Parse .env text. Later duplicates win. Never throws on odd input; bad lines are skipped.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnv(text) {
  text = text.replace(/^﻿+/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const values = {};
  const n = text.length;
  let i = 0;
  while (i < n) {
    // skip blanks and whole-line comments
    let j = text.indexOf('\n', i);
    j = j === -1 ? n : j;
    let line = text.slice(i, j);
    let stripped = line.trim();
    if (!stripped || stripped.startsWith('#')) {
      i = j + 1;
      continue;
    }
    if (stripped.startsWith('export ') || stripped.startsWith('export\t')) {
      line = line.trimStart().slice(7);
      stripped = line.trim();
    }
    const eq = stripped.indexOf('=');
    if (eq <= 0) {
      i = j + 1;
      continue;
    }
    const key = stripped.slice(0, eq).trim();
    if (!KEY.test(key)) {
      i = j + 1;
      continue;
    }
    // the first '=' on the line is the separator (a key cannot contain one)
    let restStart = text.indexOf('=', i) + 1;
    while (restStart < n && (text[restStart] === ' ' || text[restStart] === '\t')) restStart += 1;
    const [value, nextI] = readValue(text, restStart, n);
    values[key] = value;
    i = nextI;
  }
  return values;
}

/** @returns {[string, number]} the value and the index where the next line starts */
function readValue(text, start, n) {
  if (start >= n || text[start] === '\n') return ['', start + 1];
  const quote = text[start];
  if (quote === "'" || quote === '"') {
    let k = start + 1;
    let buf = '';
    while (k < n) {
      const ch = text[k];
      if (quote === '"' && ch === '\\' && k + 1 < n) {
        const next = text[k + 1];
        buf += Object.hasOwn(ESCAPES, next) ? ESCAPES[next] : '\\' + next;
        k += 2;
        continue;
      }
      if (ch === quote) {
        // consume the rest of the line (a trailing comment is allowed)
        const eol = text.indexOf('\n', k + 1);
        return [buf, eol === -1 ? n : eol + 1];
      }
      buf += ch;
      k += 1;
    }
    // unterminated quote: take what we have to the end of the line it started on
    const eol = text.indexOf('\n', start);
    return [text.slice(start + 1, eol === -1 ? n : eol), eol === -1 ? n : eol + 1];
  }
  let eol = text.indexOf('\n', start);
  eol = eol === -1 ? n : eol;
  let raw = text.slice(start, eol);
  const comment = /\s#/.exec(raw);
  if (comment) raw = raw.slice(0, comment.index);
  return [raw.trim(), eol + 1];
}

/**
 * Read and parse an env file. A missing file is an empty file; any other read error is raised.
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
export function loadEnvFile(filePath) {
  try {
    return parseEnv(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

/**
 * The env file overlaid by the given environment (the environment wins).
 * @param {string} filePath
 * @param {Record<string, string | undefined>} [environ] defaults to the real process environment
 */
export function mergedEnvironment(filePath, environ = process.env) {
  const merged = loadEnvFile(filePath);
  for (const [key, value] of Object.entries(environ)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}
