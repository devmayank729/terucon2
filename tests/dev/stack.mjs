#!/usr/bin/env node
// The whole site, on throw-away settings: the real website code with the real Design Studio mounted in it, against mock GPU
// services, with no database, no Google key and no local model service. Try the flow by hand, or let the browser tests
// (tests/e2e/run.mjs) drive it.
//
//   node tests/dev/stack.mjs [--port 8765] [--passcode letmein] [--boot-ms 400]
//
// It copies the website and the studio's server code into a temp folder and runs `node app.js` from there with an explicit
// environment, so nothing here can read the project's real .env or swatchroom/.env, reach your database, wake a real GPU or
// spend anything at Google. The two mock GPU services answer /healthz after --boot-ms (a stand-in for a cold start) and
// record who asked: `stack.pools`. A test rig, not a product feature.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockModal } from '../helpers/mockModal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');

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

/** The project as a temp folder: real code and pages, no secrets. Links point back at the big, harmless folders. */
function copyProject(tmp) {
  const project = path.join(tmp, 'project');
  fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
  for (const item of ['app.js', 'package.json', 'server', 'site', 'pages']) fs.cpSync(path.join(ROOT, item), path.join(project, item), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'docs', 'PROJECT_OVERVIEW.html'), path.join(project, 'docs', 'PROJECT_OVERVIEW.html'));
  fs.symlinkSync(path.join(ROOT, 'media'), path.join(project, 'media'), 'dir');
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(project, 'node_modules'), 'dir');
  // the studio: its server code and its package.json (routes/session.js reads the version), its browser files by link;
  // no real .env or keys/, whatever the real swatchroom/ folder holds
  const studio = path.join(project, 'swatchroom');
  fs.mkdirSync(studio);
  fs.cpSync(path.join(ROOT, 'swatchroom', 'server'), path.join(studio, 'server'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'swatchroom', 'package.json'), path.join(studio, 'package.json'));
  fs.symlinkSync(path.join(ROOT, 'swatchroom', 'public'), path.join(studio, 'public'), 'dir');
  // decoys where the real studio keeps its secrets (swatchroom/.env, swatchroom/keys/), so the browser tests can show that
  // nothing at those paths is ever served; nothing real is in them
  fs.writeFileSync(path.join(studio, '.env'), '# decoy, never served\nDECOY_SECRET=do-not-serve-me\n');
  fs.mkdirSync(path.join(studio, 'keys'));
  fs.writeFileSync(path.join(studio, 'keys', 'decoy-key.json'), JSON.stringify({ type: 'decoy', private_key: 'DECOY-PRIVATE-KEY-do-not-serve' }));
  return project;
}

function removeProject(tmp) {
  const project = path.join(tmp, 'project');
  for (const link of ['media', 'node_modules', path.join('swatchroom', 'public')]) {
    try {
      if (fs.lstatSync(path.join(project, link)).isSymbolicLink()) fs.unlinkSync(path.join(project, link));
    } catch {
      /* already gone */
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function waitForHealth(base, exited, ms) {
  const deadline = Date.now() + ms;
  let last = '';
  while (Date.now() < deadline) {
    if (exited.done) throw new Error(`app.js exited with ${exited.code}`);
    try {
      const r = await fetch(base + '/api/health', { cache: 'no-store' });
      if (r.ok) return await r.json();
      last = `status ${r.status}`;
    } catch (e) {
      last = String(e.message || e);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`the site did not become ready: ${last}`);
}

/**
 * @param {{port?: number, passcode?: string, bootMs?: number, warmup?: 'on' | 'off'}} [opts]
 * @returns {Promise<{base: string, port: number, health: object, pools: {oneformer: object, analyze: object}, stop(): Promise<void>, logs(): string}>}
 */
export async function startStack(opts = {}) {
  const { passcode = '', bootMs = 400, warmup = 'on' } = opts;
  const port = opts.port || (await freePort());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-dev-'));
  const pools = { oneformer: await startMockModal({ key: 'key-oneformer', bootMs }), analyze: await startMockModal({ key: 'key-analyze', bootMs }) };
  let logs = '';
  let site = null;
  const exited = { done: false, code: null };
  const stop = async () => {
    if (site && !exited.done) {
      site.kill('SIGTERM');
      await new Promise((r) => (exited.done ? r() : site.once('exit', r)));
    }
    await Promise.all(Object.values(pools).map((p) => p.close()));
    removeProject(tmp);
  };
  try {
    const project = copyProject(tmp);
    const envFile = path.join(tmp, '.env');
    fs.writeFileSync(envFile, '# throw-away settings for the dev stack\n');
    const env = {
      PATH: process.env.PATH,
      HOME: tmp,
      LANG: process.env.LANG || 'C.UTF-8',
      TERUCON_ENV_FILE: envFile,
      HOST: '127.0.0.1',
      PORT: String(port),
      STUDIO_WARMUP: warmup,
      // the studio's settings, all pointing at nothing real
      MONGODB_URI: 'mongodb://127.0.0.1:1/terucon-dev',
      MODEL_SERVICE_URL: 'http://127.0.0.1:1',
      ONEFORMER_URL: `${pools.oneformer.url}/v1/parse`,
      ONEFORMER_KEY: 'key-oneformer',
      ANALYZE_URL: `${pools.analyze.url}/v1/analyze`,
      ANALYZE_KEY: 'key-analyze',
      SESSION_SECRET: 'dev-stack-session-secret',
      ADMIN_PASSWORD: 'dev-stack-admin',
    };
    if (passcode) env.STUDIO_PASSCODE = passcode;
    site = spawn(process.execPath, [path.join(project, 'app.js')], { cwd: project, env });
    site.stdout.on('data', (d) => (logs += d));
    site.stderr.on('data', (d) => (logs += d));
    site.once('exit', (code) => Object.assign(exited, { done: true, code }));
    const base = `http://127.0.0.1:${port}`;
    const health = await waitForHealth(base, exited, 60000);
    return { base, port, health, pools, stop, logs: () => logs };
  } catch (e) {
    const out = logs;
    await stop();
    throw new Error(`${e.message}\n${out}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf('--' + name);
    return i > -1 ? process.argv[i + 1] : dflt;
  };
  const stack = await startStack({ port: Number(arg('port', 8765)), passcode: arg('passcode', ''), bootMs: Number(arg('boot-ms', 400)) });
  console.log(`READY ${stack.base}  (mock GPU services, no database; studio passcode: ${arg('passcode', '') || 'none'})`);
  const bye = async () => {
    await stack.stop();
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  await new Promise(() => {});
}
