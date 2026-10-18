/**
 * Talks to the model service: a cached health check for the status, and a streaming proxy for the
 * requests the Design Studio makes.
 *
 * The proxy never buffers or re-encodes a body (photos are tens of megabytes): the browser's request is
 * piped to the service and the service's answer is piped back. Its timeouts are its own: five seconds to
 * connect, and a long silence limit afterwards, because a scan includes a Google call that can take minutes.
 */
import http from 'node:http';
import https from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream';
import { HttpError, sendError } from '../lib/errors.js';
import { httpRequest, RequestTimeoutError, whenConnected } from '../lib/httpClient.js';

const MAX_BODY_BYTES = 80 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 5000;
const SILENCE_LIMIT_MS = 10 * 60 * 1000;
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-length'];

/** The sentence people see (Design Studio, SAM health) when the service can not be used. */
export function unavailableMessage(status) {
  if (status.status === 'starting') return 'The model service is still starting. Try again in a moment.';
  if (status.status === 'off') return 'The model service is switched off (MODEL_SERVICE=off).';
  return status.error || 'The model service is not available.';
}

/**
 * @param {object} options
 * @param {'auto' | 'external' | 'off'} options.mode
 * @param {() => {state: string, url?: string, error?: string}} options.resolve where the service is right now
 * @param {string} [options.key] sent as X-Terucon-Model-Key
 * @param {number} [options.probeTtlMs] how long a health check result is reused
 */
export function createModelClient({ mode, resolve, key = '', probeTtlMs = 1500, probeTimeoutMs = 2000 }) {
  let cached = null; // {url, at, result}: the last health check, shared by concurrent callers

  const keyHeader = key ? { 'X-Terucon-Model-Key': key } : {};

  async function probe(url) {
    try {
      const res = await httpRequest(`${url}/health`, { headers: keyHeader, connectTimeoutMs: 1000, readTimeoutMs: probeTimeoutMs });
      if (res.status === 401) return { error: 'The model service rejected the key. MODEL_SERVICE_KEY must be the same on both sides.' };
      const health = res.json();
      if (res.status === 200 && health?.ok === true) return { health };
      return { error: `The model service answered ${res.status} to its health check.` };
    } catch (err) {
      return { error: err instanceof RequestTimeoutError ? 'The model service is not answering (its health check timed out).' : 'The model service can not be reached.' };
    }
  }

  /** @returns {Promise<{mode: string, status: 'ready' | 'starting' | 'unavailable' | 'off', error?: string, url?: string, health?: object}>} `url` and `health` only when ready */
  async function status() {
    const where = resolve();
    if (where.state !== 'ready') {
      const known = ['starting', 'off'].includes(where.state) ? where.state : 'unavailable';
      return { mode, status: known, ...(where.error ? { error: where.error } : {}) };
    }
    if (!cached || cached.url !== where.url || Date.now() - cached.at > probeTtlMs) cached = { url: where.url, at: Date.now(), result: probe(where.url) };
    const result = await cached.result;
    return result.health ? { mode, status: 'ready', url: where.url, health: result.health } : { mode, status: 'unavailable', error: result.error };
  }

  /**
   * Stream `req` to `route` of the service and its answer back to `res`. Of the browser's headers only the content
   * type, length and accept travel on; `extraHeaders` are ours to add.
   */
  async function forward(req, res, route, extraHeaders = {}) {
    const current = await status();
    if (res.destroyed) return; // the browser left while the health check was running
    if (current.status !== 'ready') return sendError(res, 503, unavailableMessage(current), 'UNAVAILABLE');
    const declared = Number(req.headers['content-length']);
    if (declared > MAX_BODY_BYTES) {
      res.set('Connection', 'close');
      return sendError(res, 413, 'The request is too large (the limit is 80 MB).');
    }
    const target = new URL(current.url.replace(/\/+$/, '') + route); // the address the health check just confirmed
    const secure = target.protocol === 'https:';

    const headers = { ...keyHeader, ...extraHeaders };
    for (const name of ['content-type', 'content-length', 'accept']) if (req.headers[name]) headers[name] = req.headers[name];

    let received = 0;
    const limit = new Transform({
      transform(chunk, encoding, done) {
        received += chunk.length;
        done(received > MAX_BODY_BYTES ? new HttpError(413, 'The request is too large (the limit is 80 MB).') : null, chunk);
      },
    });

    return new Promise((done) => {
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        if (res.destroyed) return;
        if (res.headersSent) return res.destroy();
        if (err instanceof HttpError) {
          res.set('Connection', 'close');
          return sendError(res, err.status, err.message);
        }
        sendError(res, 503, 'The model service did not respond. If it keeps happening, look at the [model] lines in the server window.', 'UNAVAILABLE');
      };

      const upstream = (secure ? https : http).request(target, { method: req.method, headers, agent: false }, (answer) => {
        const forwarded = {};
        for (const name of FORWARDED_RESPONSE_HEADERS) if (answer.headers[name]) forwarded[name] = answer.headers[name];
        res.writeHead(answer.statusCode, forwarded);
        pipeline(answer, res, (err) => err && res.destroy());
      });
      const connectTimer = setTimeout(() => upstream.destroy(new Error('connect timeout')), CONNECT_TIMEOUT_MS);
      whenConnected(upstream, secure, () => clearTimeout(connectTimer));
      upstream.setTimeout(SILENCE_LIMIT_MS, () => upstream.destroy(new Error('silence limit')));
      upstream.on('error', fail);
      // A browser that went away (closed tab, cancelled scan) must not leave the service computing for nobody.
      res.on('close', () => {
        clearTimeout(connectTimer);
        if (!res.writableFinished) upstream.destroy();
        done();
      });
      // pipe, not pipeline: pipeline would destroy the browser's request on an error, and with it the connection
      // the error answer has to travel on.
      limit.once('error', (err) => {
        upstream.destroy();
        fail(err);
      });
      req.once('error', fail);
      req.pipe(limit).pipe(upstream);
    });
  }

  return { mode, status, forward, unavailableMessage, invalidate: () => (cached = null) };
}
