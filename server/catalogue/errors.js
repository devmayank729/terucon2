/**
 * The one error type of the catalogue search, and how it is sent. Every answer that is not a success has the site's error body
 * ({error: {code, status, message}}) plus a short `reason` the page acts on (the slugs are listed in catalogue/ARCHITECTURE.md,
 * section 7). A message is plain language a person may read; it never carries a key, a token, an address of ours or a body.
 */
import { errorBody } from '../lib/errors.js';

export class CatalogueError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} reason the slug
   * @param {string} message plain language
   * @param {{retryAfter?: number}} [extra] seconds to wait, sent as Retry-After
   */
  constructor(status, reason, message, { retryAfter } = {}) {
    super(message);
    this.name = 'CatalogueError';
    this.status = status;
    this.reason = reason;
    if (retryAfter) this.retryAfter = Math.max(1, Math.ceil(retryAfter));
  }
}

/** Send a CatalogueError (or any {status, reason, message}) as the site's JSON error. */
export function sendCatalogueError(res, error, extra = {}) {
  const body = errorBody(error.status, error.message);
  body.error.reason = error.reason;
  Object.assign(body.error, extra);
  if (error.retryAfter) {
    res.set('Retry-After', String(error.retryAfter));
    body.error.retryAfter = error.retryAfter;
  }
  res.status(error.status).set('Cache-Control', 'no-store').json(body);
}

/**
 * Read what is left of a request body and throw it away; resolves when it has all arrived (or after `graceMs`, or once `ceiling` bytes have
 * been thrown away, when the connection is dropped). Used BEFORE an early answer (too big, busy, not allowed): a client that is still sending
 * when the server answers and closes gets a reset connection and never sees the answer, which is what a browser would show as "network error".
 * @returns {Promise<void>}
 */
export function drainRequest(req, { ceiling = 16 * 1024 * 1024, graceMs = 5000 } = {}) {
  if (req.complete || req.destroyed || req.readableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    let seen = 0;
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, graceMs);
    req.on('data', (chunk) => {
      seen += chunk.length;
      if (seen > ceiling) {
        req.destroy();
        done();
      }
    });
    req.once('end', done);
    req.once('close', done);
    req.on('error', done);
    req.resume();
  });
}
