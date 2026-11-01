/**
 * Inspiration import (target C3): list the pictures on a public Pinterest board.
 *
 * The work is done by python/pinterest_board.py (gallery-dl, in the website's own Python environment, python/.venv). This file
 * is everything around it that has to be safe, because the program it starts fetches whatever address it is given:
 *   - only a Pinterest board address gets through (parseBoardUrl), rebuilt from its parts so nothing else rides along;
 *   - the program is started without a shell, with a time limit, an output limit and a bare environment (no secrets);
 *   - only https://*.pinimg.com picture addresses come back out, so a reply can never point somewhere else;
 *   - at most two imports run at once, each account gets a few an hour, and a board asked for twice is answered from memory.
 * Nothing is downloaded or stored: the page shows the pictures from Pinterest's own address.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RateLimiter } from './rateLimit.js';

const HOST = /^(?:www\.|[a-z]{2}\.)?pinterest\.com$/;
/** First path parts that are Pinterest's own pages, not a person's name (so /pin/123/ is not read as "user pin, board 123"). */
const NOT_A_USER = new Set(['pin', 'ideas', 'search', 'topics', 'today', 'business', 'explore', 'settings', 'login', 'news_hub', 'videos', 'shop', 'oauth', 'resource', '_']);
const PART = /^[\p{L}\p{N}_.\- ]{1,100}$/u;
const PICTURE_HOST = /^(?:[a-z0-9-]+\.)?pinimg\.com$/;

const MAX_AT_ONCE = 2;
const PER_ACCOUNT_PER_HOUR = 10;
const PER_ADDRESS_PER_HOUR = 40;
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 50;
const MAX_OUTPUT_BYTES = 256 * 1024;

/** An import that failed, with the answer to give. `reason` is a short code; `status` the HTTP status. */
export class ImportError extends Error {
  constructor(reason, status, message, retryAfter) {
    super(message);
    this.reason = reason;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/**
 * A board address (or one of its sections) rebuilt as https://www.pinterest.com/<user>/<board>/[<section>/], or null.
 * Anything else (another site, a pin, a profile, a port, a password in the address, a short link) is null.
 */
export function parseBoardUrl(text) {
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > 300) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !HOST.test(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return null;
  const decoded = [];
  for (const part of parts) {
    let plain;
    try {
      plain = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (!PART.test(plain) || plain.startsWith('-') || /^\.+$/.test(plain)) return null;
    decoded.push(plain);
  }
  if (NOT_A_USER.has(decoded[0].toLowerCase())) return null;
  return `https://www.pinterest.com/${decoded.map(encodeURIComponent).join('/')}/`;
}

/** The picture addresses in `list` that are https://*.pinimg.com, once each, at most `limit`. */
export function onlyPictures(list, limit) {
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'string' || item.length > 500) continue;
    let url;
    try {
      url = new URL(item);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !PICTURE_HOST.test(url.hostname)) continue;
    seen.add(url.href);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

const MESSAGES = {
  'not-found': [404, 'We could not find that board. Check the address, and that the board is public.'],
  blocked: [502, 'Pinterest did not let us read that board. Make sure it is public, then try again later.'],
  empty: [404, 'That board has no pictures we could read.'],
  timeout: [504, 'Pinterest took too long to answer. Please try again.'],
  failed: [502, 'We could not read that board right now. Please try again later.'],
};

/** Read what python/pinterest_board.py printed. @returns {string[]} the pictures, or throws ImportError */
function readAnswer(stdout, limit) {
  let answer;
  try {
    answer = JSON.parse(stdout);
  } catch {
    throw new ImportError('failed', ...MESSAGES.failed);
  }
  if (answer?.ok === true) {
    const images = onlyPictures(answer.images, limit);
    if (!images.length) throw new ImportError('empty', ...MESSAGES.empty);
    return images;
  }
  if (answer?.reason === 'not-installed') throw new ImportError('not-set-up', 503, 'Pinterest import is not set up on this server yet.');
  const [status, message] = MESSAGES[answer?.reason] ?? MESSAGES.failed;
  throw new ImportError(answer?.reason in MESSAGES ? answer.reason : 'failed', status, message);
}

/**
 * @param {object} options
 * @param {() => {enabled: boolean, python: string, script: string, limit: number, timeoutMs: number}} options.settings read on every use
 * @param {{warn: Function}} [options.log]
 * @param {() => number} [options.now]
 * @param {typeof execFile} [options.exec] tests
 */
export function createPinterestImporter({ settings, log, now = Date.now, exec = execFile }) {
  const perAccount = new RateLimiter({ windowMs: 3600000, now });
  const perAddress = new RateLimiter({ windowMs: 3600000, now });
  const cache = new Map();
  let running = 0;

  function cached(board) {
    const hit = cache.get(board);
    if (!hit) return null;
    if (hit.until < now()) {
      cache.delete(board);
      return null;
    }
    return hit.images;
  }

  function run(board, cfg) {
    const seconds = Math.max(3, Math.floor(cfg.timeoutMs / 1000) - 5); // the program stops itself a little before we would
    return new Promise((resolve, reject) => {
      exec(
        cfg.python,
        [cfg.script, board, String(cfg.limit), String(seconds)],
        { cwd: path.dirname(cfg.script), timeout: cfg.timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT_BYTES, env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' }, windowsHide: true },
        (error, stdout) => {
          if (error?.killed) return reject(new ImportError('timeout', ...MESSAGES.timeout));
          if (error && !stdout) {
            log?.warn(`inspiration  the Pinterest importer did not run: ${error.code ?? error.message}`);
            return reject(new ImportError('not-set-up', 503, 'Pinterest import is not set up on this server yet.'));
          }
          try {
            resolve(readAnswer(stdout, cfg.limit));
          } catch (e) {
            reject(e);
          }
        },
      );
    });
  }

  return {
    /** Whether the importer can run here: switched on, and its Python and script exist. */
    ready() {
      const cfg = settings();
      return cfg.enabled && fs.existsSync(cfg.python) && fs.existsSync(cfg.script);
    },

    /**
     * @param {string} input what the person typed
     * @param {{account: string | null, address: string}} who
     * @returns {Promise<{board: string, images: string[], cached: boolean}>} or throws ImportError
     */
    async list(input, { account, address }) {
      const cfg = settings();
      if (!cfg.enabled) throw new ImportError('off', 503, 'Pinterest import is switched off.');
      const board = parseBoardUrl(input);
      if (!board) throw new ImportError('bad-address', 400, 'Paste the address of a Pinterest board, like https://www.pinterest.com/name/board-name/.');
      const known = cached(board);
      if (known) return { board, images: known.slice(0, cfg.limit), cached: true };
      if (!fs.existsSync(cfg.python) || !fs.existsSync(cfg.script)) throw new ImportError('not-set-up', 503, 'Pinterest import is not set up on this server yet.');

      const keys = [['account', account ? `u:${account}` : null, PER_ACCOUNT_PER_HOUR, perAccount], ['address', `ip:${address}`, PER_ADDRESS_PER_HOUR, perAddress]];
      for (const [, key, limit, limiter] of keys) {
        if (!key) continue;
        const room = limiter.check(key, limit);
        if (!room.ok) throw new ImportError('rate', 429, 'You have imported a lot of boards in the last hour. Please try again later.', room.retryAfter);
      }
      if (running >= MAX_AT_ONCE) throw new ImportError('busy', 503, 'Other imports are running. Please try again in a minute.', 30);

      for (const [, key, , limiter] of keys) if (key) limiter.record(key);
      running += 1;
      try {
        const images = await run(board, cfg);
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(board, { images, until: now() + CACHE_MS });
        return { board, images, cached: false };
      } finally {
        running -= 1;
      }
    },

    close() {
      perAccount.close();
      perAddress.close();
    },
  };
}
