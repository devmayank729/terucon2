/** The three server calls of the import (server/routes/inspiration.js), with failures turned into plain sentences and a short reason. */

export class ImportFailure extends Error {
  /** @param {string} message plain language, shown to people @param {{reason?: string, status?: number, retryAfter?: number}} [info] */
  constructor(message, { reason = 'failed', status = 0, retryAfter = 0 } = {}) {
    super(message);
    this.name = 'ImportFailure';
    this.reason = reason;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const FALLBACK = {
  401: ['signin', 'Please sign in to import a picture.'],
  403: ['signin', 'Please finish your details first.'],
  429: ['rate', 'You have imported a lot just now. Please try again in a little while.'],
  503: ['not-set-up', 'Importing from links is not available right now. You can upload a picture instead.'],
};

async function call(path, init = {}) {
  let response;
  try {
    response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ImportFailure('We could not reach Terucon. Check your connection and try again.', { reason: 'offline' });
  }
  if (response.ok) return response;
  let detail = null;
  try {
    detail = (await response.json())?.error ?? null;
  } catch {
    // not JSON: the fallback sentence is used
  }
  const [reason, message] = FALLBACK[response.status] ?? ['failed', 'Something went wrong. Please try again.'];
  throw new ImportFailure(detail?.message || message, { reason: detail?.reason || reason, status: response.status, retryAfter: Number(response.headers.get('Retry-After')) || 0 });
}

/** What kind of address was pasted, and which pictures it holds. @returns {Promise<object>} the server's answer (see the route's header) */
export async function resolveAddress(input, signal) {
  const response = await call('/api/inspiration/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }), signal });
  return response.json();
}

/** One of the pictures a resolve gave, as a Blob that is safe to draw on a canvas (it is served from this site). */
export async function fetchPicture(token, signal) {
  const response = await call(`/api/inspiration/file/${encodeURIComponent(token)}`, { signal });
  return response.blob();
}

export async function importStatus() {
  return (await call('/api/inspiration/status')).json();
}
