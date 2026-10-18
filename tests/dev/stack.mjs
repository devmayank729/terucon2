#!/usr/bin/env node
// The real site (node app.js, and the Python model service it starts) running against a *mock* Google, so the whole
// Design Studio can be tried and tested without credentials and without spending anything.
//
//   node tests/dev/stack.mjs [--port 8765] [--sam real|off] [--model auto|off] [--jitter 14]
//
// It starts model/tests/mock_google_server.py (a stand-in for Google's sign-in and Gemini endpoints that answers like Gemini
// would for the synthetic room photo), writes a throw-away env file, and runs `node app.js` against both. Nothing here reads
// the project's real .env: the child gets an explicit environment and TERUCON_ENV_FILE points at the throw-away file.
// It is a test rig, not a product feature.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');

/** Python with the model service's packages, found the way the server finds it (PYTHON env var wins). */
function pythonCommand() {
  return process.env.PYTHON || 'python3';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Collect a child's output and resolve when `pattern` matches it (or reject on exit / timeout). */
function waitFor(child, pattern, label, ms) {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`${label} did not start within ${ms / 1000}s:\n${out}`)), ms);
    const onData = (d) => {
      out += d;
      const m = out.match(pattern);
      if (m) {
        clearTimeout(timer);
        resolve(m);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${label} exited with ${code}\n${out}`));
    });
  });
}

async function waitForHealth(base, ms) {
  const deadline = Date.now() + ms;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/api/config', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        const st = j.model && j.model.status;
        if (st === 'ready' || st === 'off' || st === 'unavailable') return j;
        last = `model ${st}`;
      }
    } catch (e) {
      last = String(e.message || e);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the site did not become ready: ${last}`);
}

/**
 * @param {{port?:number, sam?:'real'|'off', model?:'auto'|'off', jitter?:number}} [opts]
 * @returns {Promise<{base:string, mock:string, port:number, config:object, stop():Promise<void>, logs():string}>}
 */
export async function startStack(opts = {}) {
  const { sam = 'off', model = 'auto', jitter = 14 } = opts;
  const port = opts.port || (await freePort());
  const tmp = mkdtempSync(path.join(tmpdir(), 'terucon-dev-'));
  const children = [];
  let logs = '';
  const stop = async () => {
    for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
    await Promise.all(children.map((c) => new Promise((r) => (c.exitCode !== null ? r() : c.once('exit', r)))));
    rmSync(tmp, { recursive: true, force: true });
  };
  try {
    const mockChild = spawn(pythonCommand(), ['-W', 'ignore', path.join(ROOT, 'model/tests/mock_google_server.py'), '--port', '0', '--jitter', String(jitter)], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, HOME: tmp, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' },
    });
    children.push(mockChild);
    mockChild.stderr.on('data', (d) => (logs += `[mock-google] ${d}`));
    const ready = await waitFor(mockChild, /MOCK_GOOGLE_READY base=(\S+) sa=(\S+)/, 'the mock Google', 60000);
    const mock = ready[1];
    const sa = readFileSync(ready[2], 'utf8').trim();

    const envFile = path.join(tmp, '.env');
    writeFileSync(envFile, '# throw-away settings for the dev stack\n');
    const env = {
      PATH: process.env.PATH,
      HOME: tmp,
      LANG: process.env.LANG || 'C.UTF-8',
      TERUCON_ENV_FILE: envFile,
      HOST: '127.0.0.1',
      PORT: String(port),
      GCP_SERVICE_ACCOUNT_JSON: sa,
      TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS: '1',
      TERUCON_VERTEX_API_BASE: mock,
      MODEL_SERVICE: model,
      PYTHONDONTWRITEBYTECODE: '1',
    };
    if (process.env.PYTHON) env.PYTHON = process.env.PYTHON;
    if (sam === 'real') Object.assign(env, { SAM_ENABLED: 'true', SAM_BACKEND: 'sam2', SAM_MODEL_ID: 'facebook/sam2.1-hiera-small', HF_HOME: process.env.HF_HOME || path.join(process.env.HOME || tmp, '.cache/huggingface') });

    const site = spawn(process.execPath, [path.join(ROOT, 'app.js')], { cwd: ROOT, env });
    children.push(site);
    site.stdout.on('data', (d) => (logs += d));
    site.stderr.on('data', (d) => (logs += d));
    const base = `http://127.0.0.1:${port}`;
    const exited = new Promise((_, reject) => site.once('exit', (c) => reject(new Error(`app.js exited with ${c}\n${logs}`))));
    const config = await Promise.race([waitForHealth(base, 120000), exited]);
    return { base, mock, port, config, stop, logs: () => logs };
  } catch (e) {
    await stop();
    throw e;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf('--' + name);
    return i > -1 ? process.argv[i + 1] : dflt;
  };
  const stack = await startStack({ port: Number(arg('port', 8765)), sam: arg('sam', 'off'), model: arg('model', 'auto'), jitter: Number(arg('jitter', 14)) });
  console.log(`READY ${stack.base}  mock-google=${stack.mock}  model=${stack.config.model.status}  sam=${arg('sam', 'off')}`);
  const bye = async () => {
    await stack.stop();
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  await new Promise(() => {});
}
