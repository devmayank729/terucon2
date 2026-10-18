import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { parseEnv } from '../../server/config/envfile.js';
import { describe as describeSettings, loadSettings, publicSettings, SettingsManager } from '../../server/config/settings.js';
import { makeServiceAccount } from '../helpers/mockGoogle.js';

const cases = JSON.parse(fs.readFileSync(new URL('../fixtures/env-cases.json', import.meta.url), 'utf8'));
let dir;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-settings-'));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Settings from env-file text. The environment is empty (plus a HOME that holds no gcloud login), so nothing real leaks in. */
function settingsFrom(text, environ = {}) {
  const file = path.join(dir, `${Math.random().toString(36).slice(2)}.env`);
  fs.writeFileSync(file, text);
  return loadSettings(file, { HOME: path.join(dir, 'no-home'), ...environ }, dir);
}

const envText = (info, extra = {}) => `GCP_SERVICE_ACCOUNT_JSON='${JSON.stringify(info)}'\n${Object.entries(extra).map(([k, v]) => `${k}=${v}\n`).join('')}`;

/** The normalised view the shared fixture talks about. */
function view(s) {
  return {
    google: { ...s.google, hasApiKey: Boolean(s.google.apiKey) },
    models: s.models,
    segmentation: { engine: s.segmentationEngine, edgeRefine: s.edgeRefine, edgeMethod: s.edgeMethod, analysisMaxSide: s.analysisMaxSide },
    sam: { ...s.sam, hasServerKey: Boolean(s.sam.serverKey), remoteUrl: s.sam.remoteUrl },
    warnings: s.warnings,
  };
}

describe('shared settings cases (tests/fixtures/env-cases.json)', () => {
  for (const c of cases.settings) {
    test(c.name, () => {
      const v = view(settingsFrom(c.envFile, c.environ));
      for (const [dotted, want] of Object.entries(c.expect)) {
        const got = dotted.split('.').reduce((o, p) => o?.[p], v);
        if (want !== null && typeof want === 'object' && 'contains' in want) assert.ok(String(got).includes(want.contains), `${dotted}: ${JSON.stringify(got)} should contain ${want.contains}`);
        else if (want !== null && typeof want === 'object' && 'anyContains' in want) assert.ok(got.some((x) => x.includes(want.anyContains)), `${dotted}: ${JSON.stringify(got)}`);
        else assert.deepEqual(got, want, dotted);
      }
    });
  }
});

describe('Google credentials', () => {
  const { info } = makeServiceAccount('https://oauth2.googleapis.com/token', 'my-project-123');

  test('service account in single quotes', () => {
    const s = settingsFrom(envText(info));
    assert.equal(s.google.mode, 'vertex');
    assert.equal(s.google.projectId, 'my-project-123');
    assert.equal(s.google.clientEmail, info.client_email);
    assert.equal(s.google.error, '');
  });

  test('base64 of the JSON file is accepted', () => {
    const s = settingsFrom(`GCP_SERVICE_ACCOUNT_JSON=${Buffer.from(JSON.stringify(info)).toString('base64')}\n`);
    assert.equal(s.google.mode, 'vertex');
  });

  test('a double-quoted value whose \\n escapes became real newlines inside the key still parses', () => {
    // in a "..." value the .env reader expands \n; inside the JSON string that leaves raw line breaks, which strict JSON forbids
    const doubleQuoted = `GCP_SERVICE_ACCOUNT_JSON="${JSON.stringify(info).replaceAll('"', '\\"')}"\n`;
    const raw = parseEnv(doubleQuoted).GCP_SERVICE_ACCOUNT_JSON;
    assert.ok(raw.includes('\n'), 'the fixture should contain raw newlines');
    assert.throws(() => JSON.parse(raw));
    const s = settingsFrom(doubleQuoted);
    assert.equal(s.google.mode, 'vertex');
    assert.equal(s.google.clientEmail, info.client_email);
  });

  test('a key pasted into GOOGLE_CLOUD_PROJECT still works, with a warning', () => {
    const s = settingsFrom(`GOOGLE_CLOUD_PROJECT='${JSON.stringify(info)}'\n`);
    assert.equal(s.google.mode, 'vertex');
    assert.equal(s.google.projectId, 'my-project-123');
    assert.ok(s.warnings.some((w) => w.includes('GOOGLE_CLOUD_PROJECT')));
  });

  test('an explicit project id wins over the key', () => {
    assert.equal(settingsFrom(envText(info, { GOOGLE_CLOUD_PROJECT: 'other-project-9' })).google.projectId, 'other-project-9');
  });

  test('garbage JSON gives a readable error, not a crash', () => {
    const s = settingsFrom('GCP_SERVICE_ACCOUNT_JSON={not json\n');
    assert.equal(s.google.configured, false);
    assert.match(s.google.error, /not valid JSON/);
  });

  test('JSON that is not a service account is rejected', () => {
    assert.equal(settingsFrom('GCP_SERVICE_ACCOUNT_JSON=\'{"type":"authorized_user"}\'\n').google.configured, false);
  });

  test('token_uri must be on googleapis.com, not merely contain it', () => {
    for (const uri of ['https://evil.example.com/token', 'https://evilgoogleapis.com/token', 'https://googleapis.com.evil.example/token', 'http://oauth2.googleapis.com/token']) {
      const s = settingsFrom(envText({ ...info, token_uri: uri }));
      assert.equal(s.google.configured, false, uri);
      assert.match(s.google.error, /token_uri/, uri);
    }
    assert.equal(settingsFrom(envText({ ...info, token_uri: 'https://oauth2.googleapis.com/token' })).google.configured, true);
  });

  test('a custom token_uri is accepted only when custom endpoints are switched on', () => {
    const local = { ...info, token_uri: 'http://127.0.0.1:9/token' };
    assert.equal(settingsFrom(envText(local)).google.configured, false);
    assert.equal(settingsFrom(envText(local, { TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS: '1' })).google.configured, true);
  });

  test('a credentials file is read; relative paths are relative to the project folder', () => {
    fs.writeFileSync(path.join(dir, 'key.json'), JSON.stringify(info));
    const absolute = settingsFrom(`GOOGLE_APPLICATION_CREDENTIALS=${path.join(dir, 'key.json')}\n`);
    assert.equal(absolute.google.mode, 'vertex');
    assert.equal(settingsFrom('GOOGLE_APPLICATION_CREDENTIALS=key.json\n').google.mode, 'vertex'); // root = dir
    const missing = settingsFrom('GOOGLE_APPLICATION_CREDENTIALS=nope.json\n');
    assert.match(missing.google.error, /could not be read/);
  });

  test('api-key mode', () => {
    const s = settingsFrom('GEMINI_API_KEY=abc123\n');
    assert.equal(s.google.mode, 'api-key');
    assert.equal(s.google.configured, true);
  });

  test('GOOGLE_GENAI_USE_VERTEXAI=false forces the API key', () => {
    assert.equal(settingsFrom(envText(info, { GEMINI_API_KEY: 'abc123', GOOGLE_GENAI_USE_VERTEXAI: 'false' })).google.mode, 'api-key');
  });

  test('nothing set', () => {
    const s = settingsFrom('');
    assert.equal(s.google.configured, false);
    assert.equal(s.google.mode, 'none');
  });

  test('Vertex asked for, no credentials anywhere: a clear error', () => {
    assert.match(settingsFrom('GOOGLE_GENAI_USE_VERTEXAI=true\n').google.error, /service account/);
  });

  test('a project id is needed in vertex mode', () => {
    const noProject = { ...info };
    delete noProject.project_id;
    const s = settingsFrom(envText(noProject));
    assert.equal(s.google.mode, 'none');
    assert.match(s.google.error, /project id/);
  });

  test('model overrides are validated', () => {
    const s = settingsFrom('SWATCHROOM_IMAGE_MODEL=gemini-x-1\nSWATCHROOM_DETECT_MODEL=bad name!\n');
    assert.deepEqual({ ...s.models }, { image: 'gemini-x-1' });
    assert.ok(s.warnings.some((w) => w.includes('SWATCHROOM_DETECT_MODEL')));
  });
});

describe('numbers and flags', () => {
  test('numbers follow Python float(): blanks and hex are not numbers, decimals and exponents are', () => {
    assert.equal(settingsFrom('ANALYSIS_MAX_SIDE=\n').analysisMaxSide, 1536);
    assert.equal(settingsFrom('ANALYSIS_MAX_SIDE=0x10\n').analysisMaxSide, 1536);
    assert.equal(settingsFrom('ANALYSIS_MAX_SIDE=abc\n').analysisMaxSide, 1536);
    assert.equal(settingsFrom('ANALYSIS_MAX_SIDE=1e3\n').analysisMaxSide, 1000);
    assert.equal(settingsFrom('ANALYSIS_MAX_SIDE=2000.9\n').analysisMaxSide, 2000);
    assert.equal(settingsFrom('ANALYSIS_MAX_SIDE=-5\n').analysisMaxSide, 512);
  });

  test('PORT: default 8080, a port is kept, 0 means "pick one" (tests), junk falls back', () => {
    assert.equal(settingsFrom('').port, 8080);
    assert.equal(settingsFrom('PORT=9000\n').port, 9000);
    assert.equal(settingsFrom('PORT=0\n').port, 0);
    assert.equal(settingsFrom('PORT=99999\n').port, 65535);
    assert.equal(settingsFrom('PORT=http\n').port, 8080);
  });

  test('host and allowed hosts', () => {
    const s = settingsFrom('HOST=0.0.0.0\nALLOWED_HOSTS= Studio.Example.com , other.test \n');
    assert.equal(s.host, '0.0.0.0');
    assert.deepEqual(s.allowedHosts, ['studio.example.com', 'other.test']);
  });
});

describe('the model service settings', () => {
  test('defaults', () => {
    assert.deepEqual({ ...settingsFrom('').model }, { mode: 'auto', url: '', key: '', startTimeoutSeconds: 90, python: '' });
  });

  test('external with a URL, a key, a timeout and an interpreter', () => {
    const s = settingsFrom('MODEL_SERVICE=External\nMODEL_SERVICE_URL=http://127.0.0.1:8081/\nMODEL_SERVICE_KEY=k\nMODEL_START_TIMEOUT=120\nPYTHON=/x/python\n');
    assert.deepEqual({ ...s.model }, { mode: 'external', url: 'http://127.0.0.1:8081', key: 'k', startTimeoutSeconds: 120, python: '/x/python' });
    assert.deepEqual(s.warnings, []);
  });

  test('unknown mode, bad URL and external without a URL are explained', () => {
    assert.ok(settingsFrom('MODEL_SERVICE=cloud\n').warnings.some((w) => w.includes('MODEL_SERVICE')));
    assert.ok(settingsFrom('MODEL_SERVICE_URL=ftp://x\n').warnings.some((w) => w.includes('MODEL_SERVICE_URL')));
    assert.ok(settingsFrom('MODEL_SERVICE=external\n').warnings.some((w) => w.includes('MODEL_SERVICE_URL')));
  });
});

describe('what the browser may see', () => {
  const { info } = makeServiceAccount('https://oauth2.googleapis.com/token', 'my-project-123');
  const off = { mode: 'off', status: 'off' };

  test('publicSettings has the contract shape and never a secret', () => {
    const s = settingsFrom(envText(info, { GEMINI_API_KEY: 'SECRETKEY999', SAM_SERVER_KEY: 'SAMSECRET', MODEL_SERVICE_KEY: 'MODELSECRET', HF_TOKEN: 'HFSECRET', SAM_REMOTE_KEY: 'REMOTESECRET' }));
    const pub = publicSettings(s, undefined, off);
    const dumped = JSON.stringify(pub);
    for (const secret of ['SECRETKEY999', 'SAMSECRET', 'MODELSECRET', 'HFSECRET', 'REMOTESECRET', 'BEGIN PRIVATE KEY', info.private_key_id]) assert.ok(!dumped.includes(secret), secret);
    assert.deepEqual(Object.keys(pub), ['version', 'server', 'google', 'models', 'segmentation', 'sam', 'warnings', 'model']);
    assert.equal(pub.version, '1');
    assert.equal(pub.server, true);
    assert.deepEqual(pub.google, { configured: true, mode: 'vertex', projectId: 'my-project-123', clientEmail: info.client_email, location: 'global', error: '' });
    assert.deepEqual(pub.segmentation, { engine: 'auto', edgeRefine: true, edgeMethod: 'contour', analysisMaxSide: 1536 });
  });

  test('sam: the service status when given, else the fallback for the model state', () => {
    const wanted = settingsFrom('SAM_ENABLED=true\n');
    const unavailable = { mode: 'auto', status: 'unavailable', error: 'Python was not found.' };
    assert.deepEqual(publicSettings(wanted, undefined, unavailable).sam, { enabled: true, status: 'unavailable', backend: '', model: '', interactive: false, textPrompts: false, error: 'Python was not found.' });
    assert.deepEqual(publicSettings(wanted, undefined, off).sam, { enabled: true, status: 'off', backend: '', model: '', interactive: false, textPrompts: false });
    assert.deepEqual(publicSettings(settingsFrom(''), undefined, unavailable).sam, { enabled: false, status: 'off', backend: '', model: '', interactive: false, textPrompts: false });
    const live = { enabled: true, status: 'ready', backend: 'sam2', model: 'sam2.1', interactive: true, textPrompts: false };
    assert.deepEqual(publicSettings(wanted, live, { mode: 'auto', status: 'ready' }).sam, live);
  });

  test('model carries mode, status and the reason when there is one', () => {
    assert.deepEqual(publicSettings(settingsFrom(''), undefined, { mode: 'auto', status: 'unavailable', error: 'why' }).model, { mode: 'auto', status: 'unavailable', error: 'why' });
    assert.deepEqual(publicSettings(settingsFrom(''), undefined, { mode: 'auto', status: 'starting' }).model, { mode: 'auto', status: 'starting' });
  });

  test('describe() lines name the account, not the key', () => {
    const lines = describeSettings(settingsFrom(envText(info, { SAM_ENABLED: 'true' })));
    assert.match(lines[0], /^Google: Vertex AI as swatchroom@my-project-123\.iam\.gserviceaccount\.com {2}\(project my-project-123, location global\)$/);
    assert.match(lines[1], /^SAM: enabled, backend=auto, model=facebook\/sam2\.1-hiera-small$/);
    assert.equal(lines[2], 'Segmentation: engine=auto, edge refinement=on, contour');
    assert.match(lines[3], /^Model service: /);
    assert.equal(describeSettings(settingsFrom(''))[0], 'Google: not configured - fill in .env (see .env.example)');
    assert.equal(describeSettings(settingsFrom('GEMINI_API_KEY=k\n'))[0], 'Google: Gemini API key (AI Studio)');
    assert.match(describeSettings(settingsFrom('GCP_SERVICE_ACCOUNT_JSON={x\n'))[0], /^Google: GCP_SERVICE_ACCOUNT_JSON is set but is not valid JSON/);
    assert.ok(describeSettings(settingsFrom('MODEL_SERVICE=off\n')).at(-1).startsWith('Model service: off'));
  });
});

describe('application default credentials (detected, never contacted, at settings time)', () => {
  const loginFile = { type: 'authorized_user', client_id: 'cid', client_secret: 'csecret', refresh_token: 'rtoken' };

  function homeWith(content) {
    const home = fs.mkdtempSync(path.join(dir, 'home-'));
    if (content !== undefined) {
      fs.mkdirSync(path.join(home, '.config', 'gcloud'), { recursive: true });
      fs.writeFileSync(path.join(home, '.config', 'gcloud', 'application_default_credentials.json'), typeof content === 'string' ? content : JSON.stringify(content));
    }
    return home;
  }

  test('a gcloud login file is found through HOME or CLOUDSDK_CONFIG', { skip: process.platform === 'win32' }, () => {
    const home = homeWith(loginFile);
    const s = settingsFrom('GOOGLE_GENAI_USE_VERTEXAI=true\nGOOGLE_CLOUD_PROJECT=my-project-123\n', { HOME: home });
    assert.equal(s.google.mode, 'vertex');
    assert.equal(s.google.adc.kind, 'gcloud');
    assert.equal(s.google.configured, true);
    assert.match(describeSettings(s)[0], /application default credentials/);
    const viaConfig = settingsFrom('GOOGLE_GENAI_USE_VERTEXAI=true\nGOOGLE_CLOUD_PROJECT=my-project-123\n', { HOME: '/nonexistent', CLOUDSDK_CONFIG: path.join(home, '.config', 'gcloud') });
    assert.equal(viaConfig.google.adc.kind, 'gcloud');
  });

  test('ADC is only looked for when Vertex is asked for', { skip: process.platform === 'win32' }, () => {
    const s = settingsFrom('GOOGLE_CLOUD_PROJECT=my-project-123\n', { HOME: homeWith(loginFile) });
    assert.equal(s.google.mode, 'none');
    assert.equal(s.google.adc, null);
  });

  test('without a project id there is no Vertex (the project is never guessed from ADC)', { skip: process.platform === 'win32' }, () => {
    const s = settingsFrom('GOOGLE_GENAI_USE_VERTEXAI=true\n', { HOME: homeWith(loginFile) });
    assert.equal(s.google.configured, false);
    assert.match(s.google.error, /project id/);
  });

  test('a broken or unsupported login file is reported, not ignored', { skip: process.platform === 'win32' }, () => {
    const wanted = 'GOOGLE_GENAI_USE_VERTEXAI=true\nGOOGLE_CLOUD_PROJECT=my-project-123\n';
    assert.match(settingsFrom(wanted, { HOME: homeWith('{broken') }).google.error, /could not be read/);
    assert.match(settingsFrom(wanted, { HOME: homeWith({ type: 'external_account' }) }).google.error, /external_account.*not supported/);
    assert.match(settingsFrom(wanted, { HOME: homeWith({ type: 'authorized_user', client_id: 'x' }) }).google.error, /incomplete/);
    assert.match(settingsFrom(wanted, { HOME: homeWith({ ...loginFile, token_uri: 'https://evil.example.com/t' }) }).google.error, /token_uri/);
  });

  test('metadata server markers: GCE_METADATA_HOST, Cloud Run variables; NO_GCE_CHECK turns it off', () => {
    const wanted = 'GOOGLE_GENAI_USE_VERTEXAI=true\nGOOGLE_CLOUD_PROJECT=my-project-123\n';
    const host = settingsFrom(wanted, { GCE_METADATA_HOST: '127.0.0.1:5555' });
    assert.deepEqual({ ...host.google.adc }, { kind: 'metadata', host: '127.0.0.1:5555' });
    assert.equal(settingsFrom(wanted, { K_SERVICE: 'terucon' }).google.adc.host, 'metadata.google.internal');
    assert.equal(settingsFrom(wanted, { K_SERVICE: 'terucon', NO_GCE_CHECK: 'true' }).google.mode, 'none');
  });

  test('with an explicit environment the real home directory is never consulted', () => {
    const s = settingsFrom('GOOGLE_GENAI_USE_VERTEXAI=true\nGOOGLE_CLOUD_PROJECT=my-project-123\n', { HOME: '', USERPROFILE: '' });
    assert.equal(s.google.adc, null);
    assert.equal(s.google.mode, 'none');
  });
});

describe('SettingsManager', () => {
  test('editing the env file is picked up without a restart, and the version counts reloads', () => {
    const file = path.join(dir, 'reload.env');
    fs.writeFileSync(file, '');
    const manager = new SettingsManager(file, { HOME: '/nonexistent' }, dir);
    assert.equal(manager.get().google.configured, false);
    assert.equal(manager.version, 1);
    assert.equal(manager.get(), manager.get(), 'unchanged file: same object');
    assert.equal(manager.version, 1);
    fs.writeFileSync(file, 'GEMINI_API_KEY=abc\n');
    assert.equal(manager.get().google.configured, true);
    assert.equal(manager.version, 2);
  });

  test('the file appearing and disappearing is noticed too', () => {
    const file = path.join(dir, 'later.env');
    const manager = new SettingsManager(file, {}, dir);
    assert.equal(manager.get().envFileFound, false);
    fs.writeFileSync(file, 'GEMINI_API_KEY=abc\n');
    assert.equal(manager.get().google.mode, 'api-key');
    fs.rmSync(file);
    assert.equal(manager.get().google.mode, 'none');
  });
});
