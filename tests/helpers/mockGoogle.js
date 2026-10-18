/**
 * A local stand-in for Google: the OAuth token endpoint, the Compute Engine metadata server, and Vertex AI /
 * Gemini generateContent. The token endpoint really verifies the RS256 signature of the JWT it is given,
 * so a pass here means our signing is correct. generateContent answers come from a queue you script per
 * model, or from `defaultHandler`.
 */
import crypto from 'node:crypto';
import http from 'node:http';

let sharedKey = null;

/** A throw-away service-account key (and its public key) for tests. The RSA key is generated once per process. */
export function makeServiceAccount(tokenUri, projectId = 'terucon-test-project', email) {
  sharedKey ??= crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const info = {
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'testkeyid0123456789',
    private_key: sharedKey.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    client_email: email ?? `swatchroom@${projectId}.iam.gserviceaccount.com`,
    client_id: '1234567890',
    token_uri: tokenUri,
  };
  return { info, publicKey: sharedKey.publicKey };
}

const fromBase64Url = (text) => Buffer.from(text, 'base64url');

export function textResponse(text) {
  return { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] };
}

export function imageResponse(pngBytes, text = '') {
  const parts = text ? [{ text }] : [];
  parts.push({ inlineData: { mimeType: 'image/png', data: Buffer.from(pngBytes).toString('base64') } });
  return { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] };
}

export class MockGoogle {
  /** @param {crypto.KeyObject} [publicKey] when given, the signature of every JWT is verified with it */
  constructor(publicKey) {
    this.publicKey = publicKey;
    this.tokenCalls = [];
    this.generateCalls = [];
    this.metadataCalls = [];
    /** model -> queue of [status, body, headers?] answered first, one per call */
    this.script = {};
    /** async (model, body, headers) => [status, body, headers?]; used when the queue for the model is empty */
    this.defaultHandler = null;
    /** [status, body]: make every token request fail */
    this.tokenFail = null;
    /** when set, generateContent wants this x-goog-api-key instead of a bearer token */
    this.expectApiKey = null;
    /** what the refresh_token grant must present: {client_id, client_secret, refresh_token} */
    this.expectUser = null;
    this.tokens = 0;
    this.server = null;
  }

  async start() {
    this.server = http.createServer((req, res) => this.#handle(req, res));
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return this.base;
  }

  get port() {
    return this.server.address().port;
  }

  get base() {
    return `http://127.0.0.1:${this.port}`;
  }

  get tokenUrl() {
    return `${this.base}/token`;
  }

  /** What GCE_METADATA_HOST would hold. */
  get metadataHost() {
    return `127.0.0.1:${this.port}`;
  }

  async stop() {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  #send(res, status, data, headers = {}) {
    const raw = typeof data === 'string' ? data : JSON.stringify(data); // a string is sent as is: how an HTML error page looks
    res.writeHead(status, { 'Content-Type': typeof data === 'string' ? 'text/html' : 'application/json', 'Content-Length': Buffer.byteLength(raw), ...headers });
    res.end(raw);
  }

  async #handle(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://mock');
    if (req.method === 'GET' && url.pathname === '/__calls') {
      return this.#send(res, 200, { generate: this.generateCalls.map(({ model, path }) => ({ model, path })), tokens: this.tokenCalls.length });
    }
    if (req.method === 'GET' && url.pathname === '/computeMetadata/v1/instance/service-accounts/default/token') return this.#metadata(req, url, res);
    if (req.method === 'POST' && url.pathname === '/token') return this.#token(res, raw.toString('utf8'));
    if (req.method === 'POST') return this.#generate(req, res, raw);
    return this.#send(res, 404, { error: 'not found' });
  }

  #metadata(req, url, res) {
    this.metadataCalls.push({ headers: req.headers, scopes: url.searchParams.get('scopes') });
    if (req.headers['metadata-flavor'] !== 'Google') return this.#send(res, 403, { error: 'missing Metadata-Flavor' });
    this.tokens += 1;
    return this.#send(res, 200, { access_token: `mock-metadata-token-${this.tokens}`, expires_in: 3599, token_type: 'Bearer' });
  }

  #token(res, rawBody) {
    const form = Object.fromEntries(new URLSearchParams(rawBody));
    const record = { grantType: form.grant_type, form };
    if (this.tokenFail) {
      this.tokenCalls.push(record);
      return this.#send(res, ...this.tokenFail);
    }
    if (form.grant_type === 'refresh_token') {
      this.tokenCalls.push(record);
      const want = this.expectUser;
      if (want && (form.client_id !== want.client_id || form.client_secret !== want.client_secret || form.refresh_token !== want.refresh_token)) {
        return this.#send(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      }
      this.tokens += 1;
      return this.#send(res, 200, { access_token: `mock-user-token-${this.tokens}`, expires_in: 3599, token_type: 'Bearer' });
    }
    try {
      const [headB64, payloadB64, sigB64] = (form.assertion ?? '').split('.');
      record.header = JSON.parse(fromBase64Url(headB64));
      record.payload = JSON.parse(fromBase64Url(payloadB64));
      record.signatureOk = this.publicKey ? crypto.verify('RSA-SHA256', Buffer.from(`${headB64}.${payloadB64}`), this.publicKey, fromBase64Url(sigB64)) : true;
    } catch {
      record.signatureOk = false;
    }
    this.tokenCalls.push(record);
    if (!record.signatureOk) return this.#send(res, 400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
    this.tokens += 1;
    return this.#send(res, 200, { access_token: `mock-token-${this.tokens}`, expires_in: 3600, token_type: 'Bearer' });
  }

  async #generate(req, res, raw) {
    const model = req.url.includes('/models/') ? req.url.split('/models/').at(-1).split(':')[0] : '';
    let body;
    try {
      body = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      body = {};
    }
    this.generateCalls.push({ path: req.url, model, headers: req.headers, body });
    if (this.expectApiKey !== null) {
      if (req.headers['x-goog-api-key'] !== this.expectApiKey) return this.#send(res, 403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'API key not valid.' } });
    } else if (!(req.headers.authorization ?? '').startsWith('Bearer mock-')) {
      return this.#send(res, 401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'Missing or invalid token.' } });
    }
    const queued = this.script[model]?.shift();
    if (queued) return this.#send(res, queued[0], queued[1], queued[2]);
    if (this.defaultHandler) {
      const answer = await this.defaultHandler(model, body, req.headers);
      return this.#send(res, answer[0], answer[1], answer[2]);
    }
    return this.#send(res, 200, textResponse('ok'));
  }
}
