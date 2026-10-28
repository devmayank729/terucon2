import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { createApp, startServer } from '../../app.js';
import { request, waitFor } from '../helpers/http.js';
import { collectLog } from '../helpers/app.js';
import { makeTempRoot, PROJECT_ROOT } from '../helpers/tempRoot.js';

describe('Express 5 pitfalls are avoided in the source', () => {
  const files = [path.join(PROJECT_ROOT, 'app.js')];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(path.join(PROJECT_ROOT, 'server'));

  // the string given as a path to app.get/post/use/all/...
  const routePaths = files.flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return [...source.matchAll(/\b(?:app|router|api)\.(?:get|post|put|patch|delete|all|use)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) => ({ file: path.relative(PROJECT_ROOT, file), route: m[2] }));
  });

  test('the scan finds the routes (so the checks below mean something)', () => {
    const routes = routePaths.map((r) => r.route);
    assert.ok(routes.includes('/api/health') && routes.includes('/api/site') && routes.includes('/favicon.ico'));
    assert.ok(routes.some((r) => r.includes('*name')));
  });

  test('wildcards are named (/media/*name, never a bare *)', () => {
    for (const { file, route } of routePaths) assert.ok(!/\*(?![A-Za-z_])/.test(route.replace(/\{\*(\w+)\}/g, '')), `${file}: ${route}`);
  });

  test('no v4-only path syntax: optional ":param?", regexp groups, or "(.*)"', () => {
    for (const { file, route } of routePaths) {
      assert.ok(!/:\w+\?/.test(route), `${file}: ${route}`);
      assert.ok(!/\(\.\*\)|\(\\|\[\^/.test(route), `${file}: ${route}`);
    }
  });

  test('req.query is never assigned and express.static is never used', () => {
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      assert.ok(!/req\.query\s*=[^=]/.test(source), file);
      assert.ok(!/express\.static|serve-static/.test(source), file);
    }
  });
});

describe('createApp and startServer', () => {
  test('createApp alone listens on nothing and starts no process', async () => {
    const temp = makeTempRoot();
    try {
      const app = createApp({ root: temp.root, envPath: temp.envPath, environ: {}, log: collectLog() });
      for (const key of ['close', 'settings', 'site']) assert.ok(key in app.locals.terucon, key);
      assert.equal(await app.locals.terucon.close(), undefined, 'closing an app that was never started is fine');
      assert.equal(app.locals.terucon.settings().port, 8080);
      assert.equal(app.locals.terucon.site.pages.home.route, '/');
    } finally {
      temp.cleanup();
    }
  });

  test('a missing or broken site.json is an error that says where', () => {
    const temp = makeTempRoot();
    try {
      fs.writeFileSync(path.join(temp.root, 'site', 'site.json'), '{"pages":{"a":{"route":"nope","file":"pages/a.html"}}}');
      assert.throws(() => createApp({ root: temp.root, envPath: temp.envPath, environ: {}, log: collectLog() }), /site\/site\.json: pages\.a\.route must start with "\/"/);
      fs.writeFileSync(path.join(temp.root, 'site', 'site.json'), '{"pages":{"a":{"route":"/","file":"../outside.html"}}}');
      assert.throws(() => createApp({ root: temp.root, envPath: temp.envPath, environ: {}, log: collectLog() }), /relative path inside the project/);
      fs.rmSync(path.join(temp.root, 'site', 'site.json'));
      assert.throws(() => createApp({ root: temp.root, envPath: temp.envPath, environ: {}, log: collectLog() }), /Could not read/);
    } finally {
      temp.cleanup();
    }
  });

  test('PORT=0 in the env file picks a free port, which is the one reported', async () => {
    const temp = makeTempRoot();
    fs.writeFileSync(temp.envPath, 'PORT=0\n');
    const running = await startServer({ root: temp.root, envPath: temp.envPath, environ: {}, log: collectLog() });
    try {
      assert.ok(running.port > 0);
      assert.equal(running.server.address().port, running.port);
      assert.equal((await request(running.port, { path: '/api/health' })).status, 200);
    } finally {
      await running.close();
      temp.cleanup();
    }
  });

  test('close() is idempotent, ends keep-alive connections, and frees the port', async () => {
    const temp = makeTempRoot();
    const running = await startServer({ root: temp.root, envPath: temp.envPath, environ: {}, log: collectLog(), port: 0 });
    const socket = net.connect(running.port, '127.0.0.1');
    await new Promise((resolve) => socket.on('connect', resolve));
    socket.write(`GET /api/health HTTP/1.1\r\nHost: localhost:${running.port}\r\n\r\n`); // keep-alive, left open
    await new Promise((resolve) => socket.once('data', resolve));
    await Promise.all([running.close(), running.close()]);
    await waitFor(() => socket.destroyed, { what: 'the idle connection to be closed' });
    await assert.rejects(request(running.port, { path: '/api/health' }), { code: 'ECONNREFUSED' });
    temp.cleanup();
  });

  test('a port already in use rejects with EADDRINUSE', async () => {
    const temp = makeTempRoot();
    const taken = net.createServer().listen(0, '127.0.0.1');
    await new Promise((resolve) => taken.once('listening', resolve));
    try {
      await assert.rejects(startServer({ root: temp.root, envPath: temp.envPath, environ: {}, log: collectLog(), port: taken.address().port, host: '127.0.0.1' }), { code: 'EADDRINUSE' });
    } finally {
      taken.close();
      temp.cleanup();
    }
  });

  test('the env file defaults: TERUCON_ENV_FILE, relative to the project folder', () => {
    const temp = makeTempRoot();
    try {
      fs.writeFileSync(path.join(temp.root, 'custom.env'), 'PORT=4321\n');
      const app = createApp({ root: temp.root, environ: { TERUCON_ENV_FILE: 'custom.env' }, log: collectLog() });
      assert.equal(app.locals.terucon.settings().port, 4321);
      assert.equal(app.locals.terucon.settings().envPath, path.join(temp.root, 'custom.env'));
    } finally {
      temp.cleanup();
    }
  });
});

describe('running it: node app.js', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-cli-'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** Start `node app.js` with an explicit, minimal environment: nothing of the real one can reach it. */
  function launch(envText, extraEnv = {}, { writeEnvFile = true } = {}) {
    const envFile = path.join(dir, `${Math.random().toString(36).slice(2)}.env`);
    if (writeEnvFile) fs.writeFileSync(envFile, envText);
    const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'app.js')], { cwd: dir, env: { PATH: process.env.PATH, TERUCON_ENV_FILE: envFile, PORT: '0', ...extraEnv } });
    const out = { text: '', code: null };
    child.stdout.on('data', (d) => (out.text += d));
    child.stderr.on('data', (d) => (out.text += d));
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    return { child, out, envFile, exited, stop: async () => { child.kill('SIGINT'); return exited; } };
  }
  const portOf = (text) => Number(/Site: {14}http:\/\/[^:]+:(\d+)\//.exec(text)?.[1]);

  test('the banner: site, overview, settings file, Ctrl+C', async () => {
    const run = launch('');
    await waitFor(() => /Press Ctrl\+C/.test(run.out.text), { what: 'the banner' });
    const port = portOf(run.out.text);
    assert.ok(port > 0, run.out.text);
    const lines = run.out.text.split('\n');
    assert.equal(lines.find((l) => l.startsWith('Terucon server')), 'Terucon server');
    assert.ok(lines.includes(`  Site:              http://localhost:${port}/`), run.out.text);
    assert.ok(lines.includes(`  Project overview:  http://localhost:${port}/project-overview`));
    assert.ok(lines.includes(`  Settings file:     ${run.envFile}  (found)`));
    assert.ok(lines.includes('  Press Ctrl+C to stop.'));
    assert.equal((await request(port, { path: '/api/health' })).status, 200);
    const { code } = await run.stop();
    assert.equal(code, 0);
    assert.match(run.out.text, /Stopping\.\.\./);
  });

  test('the file is reported when it is not there', async () => {
    const run = launch('', {}, { writeEnvFile: false });
    await waitFor(() => /Press Ctrl\+C/.test(run.out.text), { what: 'the banner' });
    assert.match(run.out.text, /Settings file: +.*\.env {2}\(NOT FOUND - copy \.env\.example to \.env\)/);
    await run.stop();
  });

  test('a busy port gets the old message and exit code 1', async () => {
    const taken = net.createServer().listen(0, '127.0.0.1');
    await new Promise((resolve) => taken.once('listening', resolve));
    const busy = taken.address().port;
    try {
      const run = launch('', { PORT: String(busy) });
      const { code } = await run.exited;
      assert.equal(code, 1);
      assert.match(run.out.text, new RegExp(`Could not start on port ${busy}: .*EADDRINUSE.*\\nChange PORT in \\.env and try again\\.`));
    } finally {
      taken.close();
    }
  });

  test('SIGTERM stops it cleanly as well', async () => {
    const run = launch('');
    await waitFor(() => /Press Ctrl\+C/.test(run.out.text), { what: 'the banner' });
    run.child.kill('SIGTERM');
    assert.equal((await run.exited).code, 0);
  });
});
