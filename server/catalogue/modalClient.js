/**
 * The website's side of the conversation with the two Modal apps (catalogue/ARCHITECTURE.md section 6): the search app (GPU, models
 * loaded once per container) and the ingest app (CPU, starts and cancels a processing job). This file only talks HTTP and turns
 * Modal's answers into the error vocabulary of the site; what a search MEANS is in service.js.
 *
 * What it promises:
 *   - Every call has a timeout (CATALOGUE_MODAL_TIMEOUT_MS) and an answer-size cap; a redirect is not followed.
 *   - The bearer key (and the optional Modal proxy key and secret) are sent to the one address from .env and never anywhere else, never
 *     logged, never repeated to a client. A refused key is logged once and the client only sees "not available".
 *   - A body is a Buffer we already judged (service.js); it goes out with a Content-Length. Nothing a client sent is ever put in an address
 *     except through URLSearchParams.
 *   - Nothing is logged but short facts (an app, a status, a reason). Never a photo, a text query, a key.
 *
 * How Modal's trouble becomes ours (each is a CatalogueError with the reason the page acts on):
 *   401, 403                          503 modal-unavailable   (the key is wrong: we log it, the client is not told)
 *   400 bad-image                     400 bad-image           (Modal could not read the photo)
 *   409 release-missing | feature-version-mismatch  409, the same reason   (the live release cannot be used: an operator's problem)
 *   413                               413 too-large
 *   429, 503                          503 busy + Retry-After  (Modal's GPU queue is full)
 *   other 4xx, 5xx, a bad answer      503 modal-unavailable
 *   no answer before the timeout      503 warming + Retry-After: 5   (the container is starting: the page asks again)
 *                                     ... unless Modal answered us within the last 5 minutes: then it is awake and the search is just
 *                                     slow, 504 modal-timeout
 *   the connection fails quickly      503 modal-unavailable   (refused, unknown host, certificate, reset)
 */
import { CatalogueError } from './errors.js';

const MAX_ANSWER_BYTES = 2 * 1024 * 1024;
const AWAKE_FOR_MS = 5 * 60 * 1000;
const WARM_GAP_MS = 60 * 1000;
const LOG_AGAIN_MS = 10 * 60 * 1000;

const LABEL = { search: 'search service', ingest: 'upload processing service' };
const unavailable = (app = 'search') => new CatalogueError(503, 'modal-unavailable', `The ${LABEL[app]} is not available right now. Please try again in a minute.`);

/** "7" -> 7 (seconds, 1 to 120); anything else -> undefined */
function retryAfterOf(headers) {
  const n = Number.parseInt(headers.get('retry-after') ?? '', 10);
  return Number.isInteger(n) && n >= 1 && n <= 120 ? n : undefined;
}

/**
 * @param {object} options
 * @param {() => {searchUrl: string, ingestUrl: string, timeoutMs: number, key: string, proxyKey: string, proxySecret: string}} options.target read on every call, so .env edits apply
 * @param {{warn: Function, info?: Function}} [options.log]
 * @param {() => number} [options.now]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createModalClient({ target, log, now = Date.now, fetchImpl = (...args) => fetch(...args) }) {
  let lastSearchAnswerAt = -Infinity;
  let lastWarmAt = -Infinity;
  let warming = null;
  const loggedAt = new Map();
  const logOnce = (key, message) => {
    if (now() - (loggedAt.get(key) ?? -Infinity) < LOG_AGAIN_MS) return;
    loggedAt.set(key, now());
    log?.warn(message);
  };

  function mapStatus(app, status, body, headers) {
    const reason = typeof body?.error?.reason === 'string' ? body.error.reason : '';
    const retryAfter = retryAfterOf(headers);
    if (status === 401 || status === 403) {
      logOnce(`key:${app}`, `catalogue  the ${app} service refused our key (HTTP ${status}): check CATALOGUE_MODAL_KEY (and CATALOGUE_MODAL_PROXY_KEY / _SECRET)`);
      return unavailable(app);
    }
    if (status === 409 && (reason === 'release-missing' || reason === 'feature-version-mismatch')) {
      logOnce(`409:${reason}`, `catalogue  the ${app} service cannot use the live release (${reason}): publish it again or go back to the previous release`);
      return new CatalogueError(409, reason, 'This catalogue is being updated and cannot be searched right now. Please try again later.');
    }
    if (status === 400 && reason === 'bad-image') return new CatalogueError(400, 'bad-image', 'We could not read that photo. Please try another one.');
    if (status === 413) return new CatalogueError(413, 'too-large', 'That photo is too large.');
    if (status === 429 || status === 503) return new CatalogueError(503, 'busy', 'The search is busy right now. Please try again in a moment.', { retryAfter: retryAfter ?? 5 });
    logOnce(`status:${app}:${status}:${reason}`, `catalogue  the ${app} service answered HTTP ${status}${reason ? ` (${reason.slice(0, 40)})` : ''}`);
    return unavailable(app);
  }

  /** The body of an answer, as text, refusing more than MAX_ANSWER_BYTES. */
  async function readText(response) {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_ANSWER_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('answer too large');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /** One HTTP call to one app. Returns the parsed JSON of a 2xx answer; throws a CatalogueError otherwise. */
  async function call(app, path, { method = 'GET', query, body, contentType } = {}) {
    const cfg = target();
    const base = app === 'search' ? cfg.searchUrl : cfg.ingestUrl;
    if (!base || !cfg.key) throw new CatalogueError(503, 'modal-not-configured', `The ${app} service is not set up on this server.`);
    const url = new URL(`${base}${path}`);
    for (const [name, value] of query ?? []) url.searchParams.set(name, value);
    const headers = { Authorization: `Bearer ${cfg.key}`, Accept: 'application/json' };
    if (cfg.proxyKey && cfg.proxySecret) {
      headers['Modal-Key'] = cfg.proxyKey;
      headers['Modal-Secret'] = cfg.proxySecret;
    }
    if (contentType) headers['Content-Type'] = contentType;
    let response;
    let text;
    try {
      response = await fetchImpl(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(cfg.timeoutMs) });
      text = await readText(response);
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        if (app === 'search' && now() - lastSearchAnswerAt < AWAKE_FOR_MS) throw new CatalogueError(504, 'modal-timeout', 'The search took too long. Please try again.');
        throw new CatalogueError(503, 'warming', `The ${LABEL[app]} is waking up. Please try again in a few seconds.`, { retryAfter: 5 });
      }
      if (error instanceof CatalogueError) throw error;
      logOnce(`net:${app}`, `catalogue  could not reach the ${app} service (${String(error?.cause?.code ?? error?.code ?? error?.name ?? 'error').slice(0, 40)})`);
      throw unavailable(app);
    }
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (response.status < 200 || response.status >= 300) throw mapStatus(app, response.status, json, response.headers);
    if (json === null || typeof json !== 'object') {
      logOnce(`shape:${app}`, `catalogue  the ${app} service answered with something that is not JSON`);
      throw unavailable(app);
    }
    if (app === 'search') lastSearchAnswerAt = now();
    return json;
  }

  function checkSearchAnswer(answer) {
    if (answer.ok === false || !Array.isArray(answer.results)) {
      logOnce('shape:results', 'catalogue  the search service answered without a list of results');
      throw unavailable();
    }
    return answer;
  }

  const client = {
    /** Which apps have an address and a key. */
    configured() {
      const cfg = target();
      return { search: Boolean(cfg.searchUrl && cfg.key), ingest: Boolean(cfg.ingestUrl && cfg.key) };
    },

    /**
     * Search by photo.
     * @param {{bytes: Buffer, contentType: string, query: {catalogue: string, release: string, mode: string, profile: string, k: number, point?: number[], radius?: number, box?: number[], category?: string[], finish?: string[]}}} p
     */
    async search({ bytes, contentType, query }) {
      const qs = [['catalogue', query.catalogue], ['release', query.release], ['mode', query.mode], ['profile', query.profile], ['k', String(query.k)]];
      if (query.point) qs.push(['point', query.point.join(',')]);
      if (query.radius !== undefined) qs.push(['radius', String(query.radius)]);
      if (query.box) qs.push(['box', query.box.join(',')]);
      if (query.category?.length) qs.push(['category', query.category.join(',')]);
      if (query.finish?.length) qs.push(['finish', query.finish.join(',')]);
      return checkSearchAnswer(await call('search', '/v1/search', { method: 'POST', query: qs, body: bytes, contentType }));
    },

    /** Search by words. `body` is {catalogue, release, text, k, category?, finish?} (the filters as comma lists, like the photo search's query). */
    async searchText(body) {
      return checkSearchAnswer(await call('search', '/v1/search-text', { method: 'POST', body: JSON.stringify(body), contentType: 'application/json' }));
    },

    /**
     * Wake the search container: a GET /healthz that nobody waits for. Several wake-ups at once are one call, and the site sends at most one a
     * minute (every call to Modal keeps a started container billing, so a busy shop must not keep it awake forever).
     * @returns {boolean} whether a call was started
     */
    warm() {
      if (!client.configured().search || warming || now() - lastWarmAt < WARM_GAP_MS) return false;
      lastWarmAt = now();
      warming = call('search', '/healthz').catch(() => {}).finally(() => {
        warming = null;
      });
      return true;
    },

    /** GET /healthz of one app, for the admin's check. This wakes it (and is billed like any start). Never throws. */
    async ping(app) {
      const t0 = Date.now();
      try {
        const body = await call(app, '/healthz');
        return { ok: body.ok !== false, ms: Date.now() - t0, detail: app === 'search' ? `ready ${body.ready === true ? 'yes' : 'no'}, device ${String(body.device ?? '?').slice(0, 20)}` : `version ${String(body.version ?? '?').slice(0, 30)}` };
      } catch (error) {
        return { ok: false, ms: Date.now() - t0, reason: error.reason ?? 'error', detail: error.message };
      }
    },

    /** Ask the ingest app to run a job it will read from MongoDB. @returns {Promise<{callId: string | null}>} */
    async startIngest(jobId) {
      const body = await call('ingest', '/v1/ingest', { method: 'POST', body: JSON.stringify({ jobId }), contentType: 'application/json' });
      return { callId: typeof body.callId === 'string' && body.callId.length <= 200 ? body.callId : null };
    },

    /** Ask the ingest app to stop a job at its next safe point. */
    async cancelIngest(jobId) {
      await call('ingest', '/v1/ingest/cancel', { method: 'POST', body: JSON.stringify({ jobId }), contentType: 'application/json' });
    },
  };
  return client;
}
