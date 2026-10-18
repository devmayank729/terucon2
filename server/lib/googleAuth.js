/**
 * OAuth access tokens for a service account (or Application Default Credentials).
 *
 * The private key never leaves this process. We sign the JWT with node:crypto, post it to Google's
 * token endpoint, and cache the token until shortly before it expires. Concurrent callers share one
 * refresh, and invalidate() makes the next call fetch a fresh token even if a refresh is in flight.
 */
import crypto from 'node:crypto';
import { readAuthorizedUser } from './adc.js';
import { httpRequest } from './httpClient.js';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const REFRESH_MARGIN_SECONDS = 120; // before expiry at which we fetch a new token
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

export class GoogleAuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'GoogleAuthError';
    this.status = status;
  }
}

/** Turn Google's OAuth error into advice a person can act on. */
export function explain(error, description, httpStatus, who = 'service account') {
  const d = description || '';
  if (d.includes('Invalid JWT Signature')) {
    return 'Google rejected the key signature. This key was probably deleted or disabled; create a new JSON key for the service account.';
  }
  if (d.includes('reasonable timeframe') || d.includes('iat')) {
    return "Google rejected the token time. This computer's clock is off; turn on automatic date and time, then restart.";
  }
  if (error === 'invalid_grant') {
    return who === 'service account'
      ? `Google rejected this service account (${d || 'invalid_grant'}). Check that the account still exists and is enabled.`
      : `Google rejected the gcloud login (${d || 'invalid_grant'}). Run: gcloud auth application-default login`;
  }
  if (error === 'invalid_scope') return 'Google rejected the requested permission scope for this service account.';
  return `Token request failed: ${error || 'http_' + httpStatus}${d ? ` (${d})` : ''}.`;
}

const base64url = (data) => Buffer.from(data).toString('base64url');

function signJwt(privateKey, header, payload) {
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  return `${input}.${base64url(crypto.sign('RSA-SHA256', Buffer.from(input), privateKey))}`;
}

export class GoogleAuth {
  #token = '';
  #expiresAt = 0; // seconds since the epoch
  #pending = null;
  #generation = 0;
  #signer = null;

  /**
   * Build one per configuration; it is cheap.
   * @param {object} cfg settings.google
   * @param {{timeoutMs?: number, now?: () => number, request?: typeof httpRequest}} [options]
   *   `now` returns seconds since the epoch; `request` replaces the HTTP client (tests)
   */
  constructor(cfg, { timeoutMs = 20_000, now = () => Date.now() / 1000, request = httpRequest } = {}) {
    this.cfg = cfg;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.request = request;
  }

  get needsToken() {
    return this.cfg.mode === 'vertex';
  }

  /** @returns {Promise<string>} a valid access token; throws GoogleAuthError */
  async token() {
    if (this.cfg.mode !== 'vertex') throw new GoogleAuthError('This server is not set up for Vertex AI.', 500);
    if (this.#token && this.now() < this.#expiresAt - REFRESH_MARGIN_SECONDS) return this.#token;
    if (!this.#pending) {
      const generation = this.#generation;
      const pending = this.#fetch()
        .then(({ token, expiresAt }) => {
          if (generation === this.#generation) [this.#token, this.#expiresAt] = [token, expiresAt];
          return token;
        })
        .finally(() => {
          if (this.#pending === pending) this.#pending = null;
        });
      this.#pending = pending;
    }
    return this.#pending;
  }

  /** Forget the cached token (revoked or rejected). A refresh already under way is not cached. */
  invalidate() {
    this.#token = '';
    this.#expiresAt = 0;
    this.#generation += 1;
    this.#pending = null;
  }

  async #fetch() {
    const { serviceAccount, adc } = this.cfg;
    if (serviceAccount) return this.#fetchWithKey(serviceAccount);
    if (adc?.kind === 'metadata') return this.#fetchFromMetadata(adc.host);
    if (adc?.kind === 'gcloud') return this.#fetchWithGcloudLogin(adc);
    throw new GoogleAuthError('No Google credentials are available.', 500);
  }

  // ---- service-account key -> token --------------------------------------
  async #fetchWithKey(info) {
    if (!this.#signer) {
      try {
        // a key pasted with literal "\n" instead of line breaks is common; fix it rather than fail
        this.#signer = crypto.createPrivateKey(String(info.private_key).replace(/\\n/g, '\n'));
      } catch {
        throw new GoogleAuthError('The private key in the service-account JSON could not be read. Create a new JSON key.', 500);
      }
    }
    const tokenUri = info.token_uri || DEFAULT_TOKEN_URI;
    const iat = Math.floor(this.now());
    const header = { alg: 'RS256', typ: 'JWT', ...(info.private_key_id ? { kid: info.private_key_id } : {}) };
    const assertion = signJwt(this.#signer, header, { iss: info.client_email, scope: SCOPE, aud: tokenUri, iat, exp: iat + 3600 });
    return this.#postForm(tokenUri, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }, 'service account');
  }

  // ---- ADC: the gcloud login file ----------------------------------------
  async #fetchWithGcloudLogin({ file, allowCustom }) {
    const { info, error } = readAuthorizedUser(file, allowCustom);
    if (error) throw new GoogleAuthError(error, 401);
    const form = { grant_type: 'refresh_token', client_id: info.client_id, client_secret: info.client_secret, refresh_token: info.refresh_token };
    return this.#postForm(info.token_uri || DEFAULT_TOKEN_URI, form, 'gcloud login');
  }

  // ---- ADC: the metadata server (Compute Engine, Cloud Run, App Engine, Cloud Functions) ---
  async #fetchFromMetadata(host) {
    const url = `http://${host}/computeMetadata/v1/instance/service-accounts/default/token?scopes=${encodeURIComponent(SCOPE)}`;
    let res;
    try {
      res = await this.request(url, { headers: { 'Metadata-Flavor': 'Google' }, connectTimeoutMs: 3000, readTimeoutMs: this.timeoutMs });
    } catch {
      throw new GoogleAuthError('Could not reach the Google metadata server. Application default credentials only work on Google Cloud.', 503);
    }
    const data = res.json();
    if (res.status !== 200 || !data?.access_token) {
      throw new GoogleAuthError(`Application default credentials failed: the metadata server answered HTTP ${res.status}.`, 401);
    }
    return { token: data.access_token, expiresAt: this.now() + expiresIn(data) };
  }

  async #postForm(tokenUri, form, who) {
    let res;
    try {
      res = await this.request(tokenUri, { method: 'POST', headers: FORM, body: new URLSearchParams(form).toString(), connectTimeoutMs: 10_000, readTimeoutMs: this.timeoutMs });
    } catch {
      throw new GoogleAuthError("Could not reach Google to sign in. Check this computer's internet connection.", 503);
    }
    const data = res.json();
    const body = data && typeof data === 'object' ? data : {};
    if (res.status !== 200 || !body.access_token) {
      throw new GoogleAuthError(explain(String(body.error ?? ''), String(body.error_description ?? ''), res.status, who), 401);
    }
    return { token: body.access_token, expiresAt: this.now() + expiresIn(body) };
  }
}

function expiresIn(data) {
  const seconds = Number(data.expires_in ?? 3600);
  return Number.isFinite(seconds) ? seconds : 3600;
}
