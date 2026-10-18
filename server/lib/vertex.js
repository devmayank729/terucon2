/**
 * generateContent proxy: the Design Studio's one path to Gemini and Nano Banana.
 *
 * The browser sends {model, location, body}; we add credentials and forward to Vertex AI (service
 * account) or the Gemini API (AI Studio key). Google's status code and JSON error come back
 * unchanged, because the studio's error messages and its 404 model-fallback chain are built on them.
 */
import { GoogleAuthError } from './googleAuth.js';
import { httpRequest, RequestTimeoutError } from './httpClient.js';

const MODEL = /^[A-Za-z0-9._-]{3,80}$/;
const LOCATION = /^[a-z0-9-]{2,40}$/;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const CONNECT_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 240_000; // image generation can take a while
const MAX_TOTAL_MS = 330_000; // whatever happens, a call never keeps the user waiting longer than this
const MAX_RETRY_AFTER_SECONDS = 20;

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const googleError = (status, apiStatus, message) => ({ error: { code: status, status: apiStatus, message } });

export class VertexRequestError extends Error {
  constructor(status, message, apiStatus = 'INVALID_ARGUMENT') {
    super(message);
    this.status = status;
    this.body = googleError(status, apiStatus, message);
  }
}

/**
 * The URL and auth kind for generateContent on the configured backend.
 * @returns {{url: string, kind: 'api-key' | 'bearer'}}
 */
export function endpoint(settings, model, location) {
  if (!MODEL.test(model ?? '')) throw new VertexRequestError(400, `Invalid model name: '${model}'`);
  const g = settings.google;
  if (g.mode === 'api-key') {
    const base = settings.vertexApiBase || 'https://generativelanguage.googleapis.com'; // vertexApiBase is only ever set when custom endpoints are allowed
    return { url: `${base}/v1beta/models/${model}:generateContent`, kind: 'api-key' };
  }
  if (g.mode !== 'vertex') {
    throw new VertexRequestError(503, 'Google Cloud is not configured on this server. Add credentials to .env.', 'FAILED_PRECONDITION');
  }
  const loc = (location || g.location || 'global').trim();
  if (!LOCATION.test(loc)) throw new VertexRequestError(400, `Invalid location: '${loc}'`);
  const base = settings.vertexApiBase || (loc === 'global' ? 'https://aiplatform.googleapis.com' : `https://${loc}-aiplatform.googleapis.com`);
  return { url: `${base}/v1/projects/${g.projectId}/locations/${loc}/publishers/google/models/${model}:generateContent`, kind: 'bearer' };
}

/** Retry-After in milliseconds, capped; undefined when absent or not a number. */
function retryAfterMs(headers) {
  const value = headers['retry-after'];
  if (value === undefined || !NUMBER.test(String(value).trim())) return undefined;
  return Math.max(0, Math.min(MAX_RETRY_AFTER_SECONDS, Number(value))) * 1000;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultClock = () => performance.now();

/**
 * Call generateContent. Resolves (never rejects for upstream errors) with the HTTP status and JSON body to
 * hand to the browser, plus `info`: the attempts made and the model used.
 *
 * @param {object} settings
 * @param {import('./googleAuth.js').GoogleAuth} auth
 * @param {string} model
 * @param {object} body
 * @param {string} [location]
 * @param {object} [options] injectable for tests: sleep(ms), clock() in ms, the timeouts, the HTTP client
 * @returns {Promise<{status: number, data: any, info: {attempts: number, model: string}}>}
 */
export async function generateContent(settings, auth, model, body, location, options = {}) {
  const {
    sleep = defaultSleep,
    clock = defaultClock,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    readTimeoutMs = READ_TIMEOUT_MS,
    maxTotalMs = MAX_TOTAL_MS,
    request = httpRequest,
  } = options;
  let target;
  try {
    target = endpoint(settings, model, location);
  } catch (err) {
    if (err instanceof VertexRequestError) return { status: err.status, data: err.body, info: { attempts: 0, model } };
    throw err;
  }
  const { url, kind } = target;
  const payload = JSON.stringify(body);
  const deadline = clock() + maxTotalMs;
  let attempts = 0;
  let last = { status: 502, data: googleError(502, 'UNAVAILABLE', 'No response from Google.') };
  let refreshed = false;
  const finish = (status, data) => ({ status, data, info: { attempts, model } });
  const backoff = () => 2 ** (attempts - 1) * (0.8 + Math.random() * 0.4) * 1000;

  while (attempts < MAX_ATTEMPTS && (attempts === 0 || clock() < deadline)) {
    attempts += 1;
    const headers = { 'Content-Type': 'application/json' };
    try {
      if (kind === 'bearer') headers.Authorization = `Bearer ${await auth.token()}`;
      else headers['x-goog-api-key'] = settings.google.apiKey;
    } catch (err) {
      if (!(err instanceof GoogleAuthError)) throw err;
      const code = [401, 403, 429, 500, 503].includes(err.status) ? err.status : 401;
      return finish(code, googleError(code, code === 401 ? 'UNAUTHENTICATED' : 'UNAVAILABLE', err.message));
    }
    let res;
    try {
      res = await request(url, { method: 'POST', headers, body: payload, connectTimeoutMs, readTimeoutMs });
    } catch (err) {
      if (err instanceof RequestTimeoutError && err.phase === 'read') {
        // Google accepted the request but never answered: asking again would only make the user wait
        // several times as long for the same silence.
        return finish(504, googleError(504, 'DEADLINE_EXCEEDED', `${model} did not answer within ${Math.round(readTimeoutMs / 1000)} seconds.`));
      }
      last = err instanceof RequestTimeoutError
        ? { status: 504, data: googleError(504, 'DEADLINE_EXCEEDED', 'Could not connect to Google in time.') } // worth another try
        : { status: 503, data: googleError(503, 'UNAVAILABLE', "Could not reach Google. Check this computer's internet connection.") };
      if (attempts < MAX_ATTEMPTS) await sleep(backoff());
      continue;
    }
    const data = res.json() ?? googleError(res.status, 'UNKNOWN', res.text().slice(0, 300));
    if (res.status === 401 && kind === 'bearer' && !refreshed) {
      auth.invalidate(); // token revoked or expired early: get a fresh one once
      refreshed = true;
      attempts -= 1;
      continue;
    }
    if (!RETRY_STATUS.has(res.status)) return finish(res.status, data);
    last = { status: res.status, data };
    if (attempts < MAX_ATTEMPTS) await sleep(retryAfterMs(res.headers) ?? backoff());
  }
  return finish(last.status, last.data);
}
