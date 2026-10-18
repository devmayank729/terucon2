import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { GoogleAuth, GoogleAuthError, explain } from '../../server/lib/googleAuth.js';
import { HttpResponse, RequestNetworkError } from '../../server/lib/httpClient.js';
import { startTestApp } from '../helpers/app.js';
import { MockGoogle, makeServiceAccount } from '../helpers/mockGoogle.js';

const answer = (status, body) => new HttpResponse(status, {}, Buffer.from(JSON.stringify(body)));
const tokenAnswer = (token, expiresIn = 3600) => answer(200, { access_token: token, expires_in: expiresIn });

describe('GoogleAuth token source', () => {
  const { info } = makeServiceAccount('https://oauth2.googleapis.com/token');
  const cfg = () => ({ mode: 'vertex', serviceAccount: info, adc: null });

  test('a token is cached until 120 seconds before it expires', async () => {
    let clock = 1_000_000;
    let fetched = 0;
    const auth = new GoogleAuth(cfg(), { now: () => clock, request: async () => tokenAnswer(`t${++fetched}`) });
    assert.equal(await auth.token(), 't1');
    clock += 3479; // 3600 - 121: still good
    assert.equal(await auth.token(), 't1');
    clock += 2; // 3481: inside the margin
    assert.equal(await auth.token(), 't2');
    assert.equal(fetched, 2);
  });

  test('concurrent callers share one refresh; a failed refresh is not remembered', async () => {
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const auth = new GoogleAuth(cfg(), {
      request: async () => {
        calls += 1;
        await gate;
        return calls === 1 ? answer(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }) : tokenAnswer('good');
      },
    });
    const all = [auth.token(), auth.token(), auth.token()].map((p) => p.then(() => 'ok', (e) => e));
    release();
    const results = await Promise.all(all);
    assert.equal(calls, 1);
    assert.ok(results.every((r) => r instanceof GoogleAuthError && r.status === 401));
    assert.equal(await auth.token(), 'good', 'the next call tries again');
    assert.equal(calls, 2);
  });

  test('invalidate() during a refresh: the stale token is returned to its callers but not cached', async () => {
    const releases = [];
    let n = 0;
    const auth = new GoogleAuth(cfg(), {
      request: () => new Promise((resolve) => {
        const mine = ++n;
        releases.push(() => resolve(tokenAnswer(`t${mine}`)));
      }),
    });
    const first = auth.token();
    await new Promise((resolve) => setImmediate(resolve));
    auth.invalidate();
    const second = auth.token(); // starts a new fetch instead of joining the old one
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(releases.length, 2);
    releases[0]();
    assert.equal(await first, 't1');
    releases[1]();
    assert.equal(await second, 't2');
    assert.equal(await auth.token(), 't2', 'only the fresh token was cached');
    assert.equal(n, 2);
  });

  test('a mode that is not vertex has no token to give', async () => {
    const auth = new GoogleAuth({ mode: 'api-key' });
    assert.equal(auth.needsToken, false);
    await assert.rejects(auth.token(), (e) => e instanceof GoogleAuthError && e.status === 500);
  });

  test('an unreadable private key is explained, a key with literal \\n is repaired', async () => {
    const broken = new GoogleAuth({ mode: 'vertex', serviceAccount: { ...info, private_key: '-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n' } }, { request: async () => tokenAnswer('x') });
    await assert.rejects(broken.token(), /private key in the service-account JSON could not be read/);
    const escaped = new GoogleAuth({ mode: 'vertex', serviceAccount: { ...info, private_key: info.private_key.replaceAll('\n', '\\n') } }, { request: async () => tokenAnswer('fine') });
    assert.equal(await escaped.token(), 'fine');
  });

  test('network trouble is a 503, an odd expires_in falls back to an hour', async () => {
    const down = new GoogleAuth(cfg(), { request: async () => { throw new RequestNetworkError(Object.assign(new Error('boom'), { code: 'ECONNREFUSED' })); } });
    await assert.rejects(down.token(), (e) => e.status === 503 && /internet connection/.test(e.message));
    let clock = 0;
    const odd = new GoogleAuth(cfg(), { now: () => clock, request: async () => answer(200, { access_token: 'a', expires_in: 'soon' }) });
    await odd.token();
    clock = 3000;
    assert.equal(await odd.token(), 'a');
  });

  test('the explanations people see', () => {
    assert.match(explain('invalid_grant', 'Invalid JWT Signature.', 400), /deleted or disabled/);
    assert.match(explain('invalid_grant', 'Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe.', 400), /clock is off/);
    assert.match(explain('invalid_grant', 'Bad iat claim', 400), /clock is off/);
    assert.equal(explain('invalid_grant', '', 400), 'Google rejected this service account (invalid_grant). Check that the account still exists and is enabled.');
    assert.match(explain('invalid_scope', '', 400), /permission scope/);
    assert.equal(explain('', '', 500), 'Token request failed: http_500.');
    assert.equal(explain('weird', 'details', 400), 'Token request failed: weird (details).');
    assert.match(explain('invalid_grant', 'Token has been expired or revoked.', 400, 'gcloud login'), /gcloud auth application-default login/);
  });
});

describe('Application Default Credentials, end to end against the mock', () => {
  let dir;
  let mock;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-adc-'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const login = { type: 'authorized_user', client_id: 'cid.apps.googleusercontent.com', client_secret: 'csecret', refresh_token: 'rtoken-1' };
  const adcEnv = (extra) => ({ GOOGLE_GENAI_USE_VERTEXAI: 'true', GOOGLE_CLOUD_PROJECT: 'adc-project-1', HOME: '', TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS: '1', TERUCON_VERTEX_API_BASE: mock.base, ...extra });
  const generate = (app) => app.post('/api/vertex/generate', { model: 'gemini-x-1', body: { contents: [] } });

  async function withMock(run) {
    mock = new MockGoogle();
    await mock.start();
    try {
      await run();
    } finally {
      await mock.stop();
    }
  }

  function writeLogin(info) {
    const config = fs.mkdtempSync(path.join(dir, 'gcloud-'));
    fs.writeFileSync(path.join(config, 'application_default_credentials.json'), JSON.stringify(info));
    return config;
  }

  test('a gcloud login: the refresh token is exchanged for an access token, which is then used', () =>
    withMock(async () => {
      mock.expectUser = login;
      // a login file names no token endpoint (Google's own is then used); this one points at the mock to stay offline
      const running = await startTestApp({ environ: adcEnv({ CLOUDSDK_CONFIG: writeLogin({ ...login, token_uri: mock.tokenUrl }) }) });
      try {
        const config2 = (await running.get('/api/config')).json();
        assert.equal(config2.google.configured, true);
        assert.equal(config2.google.mode, 'vertex');
        assert.equal(config2.google.clientEmail, '');
        const r = await generate(running);
        assert.equal(r.status, 200);
        const grant = mock.tokenCalls[0];
        assert.equal(grant.grantType, 'refresh_token');
        assert.deepEqual(grant.form, { grant_type: 'refresh_token', client_id: login.client_id, client_secret: login.client_secret, refresh_token: login.refresh_token });
        assert.ok(mock.generateCalls[0].headers.authorization.startsWith('Bearer mock-user-token-'));
        assert.ok(mock.generateCalls[0].path.includes('/projects/adc-project-1/'));
        await generate(running);
        assert.equal(mock.tokenCalls.length, 1, 'cached');
      } finally {
        await running.stop();
      }
    }));

  test('a revoked login is explained with the command that fixes it', () =>
    withMock(async () => {
      mock.expectUser = { ...login, refresh_token: 'a-different-token' };
      const app = await startTestApp({ environ: adcEnv({ CLOUDSDK_CONFIG: writeLogin({ ...login, token_uri: mock.tokenUrl }) }) });
      try {
        const r = await generate(app);
        assert.equal(r.status, 401);
        assert.match(r.json().error.message, /gcloud auth application-default login/);
        assert.equal(mock.generateCalls.length, 0);
      } finally {
        await app.stop();
      }
    }));

  test('the login file is read again at every refresh (a new `gcloud auth application-default login` is noticed)', () =>
    withMock(async () => {
      const config = writeLogin({ ...login, token_uri: mock.tokenUrl });
      let clock = 1_000_000;
      const app = await startTestApp({ environ: adcEnv({ CLOUDSDK_CONFIG: config }), auth: { now: () => clock } });
      try {
        await generate(app);
        fs.writeFileSync(path.join(config, 'application_default_credentials.json'), JSON.stringify({ ...login, refresh_token: 'rtoken-2', token_uri: mock.tokenUrl }));
        clock += 3600;
        await generate(app);
        assert.deepEqual(mock.tokenCalls.map((c) => c.form.refresh_token), ['rtoken-1', 'rtoken-2']);
      } finally {
        await app.stop();
      }
    }));

  test('the metadata server (Compute Engine, Cloud Run): Metadata-Flavor header, cloud-platform scope, bearer token', () =>
    withMock(async () => {
      const app = await startTestApp({ environ: adcEnv({ GCE_METADATA_HOST: mock.metadataHost }) });
      try {
        assert.equal((await app.get('/api/config')).json().google.mode, 'vertex');
        const r = await generate(app);
        assert.equal(r.status, 200);
        assert.equal(mock.metadataCalls[0].headers['metadata-flavor'], 'Google');
        assert.equal(mock.metadataCalls[0].scopes, 'https://www.googleapis.com/auth/cloud-platform');
        assert.equal(mock.generateCalls[0].headers.authorization, 'Bearer mock-metadata-token-1');
        assert.equal(mock.tokenCalls.length, 0, 'no OAuth exchange: the metadata server hands out the token itself');
      } finally {
        await app.stop();
      }
    }));

  test('a metadata server that is not there is a clear 503; one that refuses is a 401', async () => {
    const app = await startTestApp({ environ: { GOOGLE_GENAI_USE_VERTEXAI: 'true', GOOGLE_CLOUD_PROJECT: 'adc-project-1', HOME: '', GCE_METADATA_HOST: '127.0.0.1:1', TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS: '1', TERUCON_VERTEX_API_BASE: 'http://127.0.0.1:1' } });
    try {
      const r = await generate(app);
      assert.equal(r.status, 503);
      assert.match(r.json().error.message, /metadata server/);
    } finally {
      await app.stop();
    }
    const refusing = http.createServer((req, res) => res.writeHead(404).end());
    await new Promise((resolve) => refusing.listen(0, '127.0.0.1', resolve));
    const refused = await startTestApp({ environ: { GOOGLE_GENAI_USE_VERTEXAI: 'true', GOOGLE_CLOUD_PROJECT: 'adc-project-1', HOME: '', GCE_METADATA_HOST: `127.0.0.1:${refusing.address().port}` } });
    try {
      const r = await generate(refused);
      assert.equal(r.status, 401);
      assert.match(r.json().error.message, /metadata server answered HTTP 404/);
    } finally {
      await refused.stop();
      refusing.closeAllConnections();
      refusing.close();
    }
  });

  test('ADC is never used when a service account is configured', () =>
    withMock(async () => {
      const made = makeServiceAccount(mock.tokenUrl, 'sa-project-1');
      mock.publicKey = made.publicKey;
      const app = await startTestApp({ environ: adcEnv({ GCE_METADATA_HOST: mock.metadataHost, GCP_SERVICE_ACCOUNT_JSON: JSON.stringify(made.info) }) });
      try {
        await generate(app);
        assert.equal(mock.metadataCalls.length, 0);
        assert.equal(mock.tokenCalls[0].grantType, 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      } finally {
        await app.stop();
      }
    }));
});
