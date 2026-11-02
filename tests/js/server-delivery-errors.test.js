// Failing well: a 5xx is the branded page for a browser and JSON for everything else, never a stack or a setting; what the process
// does with an error nobody caught; and the timeouts it listens with. (server/middleware/errorHandler.js, server/lib/errorPage.js,
// server/lib/crash.js, app.js)
import assert from 'node:assert/strict';
import express from 'express';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { installCrashHandlers } from '../../server/lib/crash.js';
import { errorHandler, notFound } from '../../server/middleware/errorHandler.js';
import { compress } from '../../server/middleware/compress.js';
import { startTestApp, collectLog } from '../helpers/app.js';
import { PROJECT_ROOT } from '../helpers/tempRoot.js';
import { request } from '../helpers/http.js';
import { writeFixtureDist } from './server-delivery-helpers.js';

const BROWSER = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8' };
const BRANDED = '<!doctype html><title>Something went wrong</title><style>body{font:16px system-ui}</style><h1>Something went wrong</h1><p><a href="/">Home</a></p><script>document.title+=" - Terucon"</script>';

function miniApp(root) {
  const log = collectLog();
  const mini = express();
  mini.use(compress());
  mini.get('/boom', () => {
    throw new Error('connection string mongodb://admin:hunter2@db.example.com/terucon failed');
  });
  mini.get('/api/boom', () => {
    throw new Error('api detail that must stay in the log');
  });
  mini.get('/teapot', (req, res, next) => next(Object.assign(new Error('short and stout'), { status: 418 })));
  mini.use(notFound);
  mini.use(errorHandler({ log, root }));
  return { mini, log };
}

async function serve(mini) {
  const server = http.createServer(mini);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))) };
}

describe('a failure on the server\'s side', () => {
  let root;
  let withPage;
  let withoutPage;
  let log;
  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-errors-'));
    fs.mkdirSync(path.join(root, 'pages'));
    fs.writeFileSync(path.join(root, 'pages', 'error.html'), BRANDED);
    const a = miniApp(root);
    log = a.log;
    withPage = await serve(a.mini);
    withoutPage = await serve(miniApp(path.join(root, 'nowhere')).mini);
  });
  after(async () => {
    await withPage.close();
    await withoutPage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a browser gets pages/error.html with a 500, no-store and a policy built from the page\'s own inline blocks', async () => {
    const r = await request(withPage.port, { path: '/boom', headers: BROWSER });
    assert.equal(r.status, 500);
    assert.equal(r.text, BRANDED);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.match(r.headers['content-security-policy'], /^default-src 'none'; .*script-src 'self' 'sha256-/);
    assert.ok(!/hunter2|admin:|mongodb|Error:|at .*\.js:\d+/.test(r.text), 'nothing of the error is shown');
  });

  test('the detail goes to the log, with a password in a connection string hidden; the page never sees it', async () => {
    await request(withPage.port, { path: '/boom', headers: BROWSER });
    const line = log.lines.find((l) => l.startsWith('error ') && l.includes('GET /boom'));
    assert.ok(line, log.lines.join('\n'));
    assert.match(line, /mongodb:\/\/\*\*\*@db\.example\.com/);
    assert.ok(!line.includes('hunter2'));
    assert.match(line, /at /, 'the stack is there, for the person who runs the server');
  });

  test('the project\'s real pages/error.html (when it exists) is what a browser gets, under a policy that allows only its own blocks and /brand files', async (t) => {
    const file = path.join(PROJECT_ROOT, 'pages', 'error.html');
    if (!fs.existsSync(file)) return t.skip('pages/error.html is not there yet');
    const html = fs.readFileSync(file, 'utf8');
    const real = await serve(miniApp(PROJECT_ROOT).mini);
    try {
      const r = await request(real.port, { path: '/boom', headers: BROWSER });
      assert.equal(r.status, 500);
      assert.equal(r.text, html);
      assert.match(r.headers['content-security-policy'], /script-src 'self' 'sha256-/);
      const outside = [...html.matchAll(/\b(?:src|href)=["']([^"'#]+)["']/g)].map((m) => m[1]).filter((u) => /^(https?:)?\/\//.test(u));
      assert.deepEqual(outside, [], 'no request leaves the site');
    } finally {
      await real.close();
    }
  });

  test('without pages/error.html a small plain page of the same kind is sent', async () => {
    const r = await request(withoutPage.port, { path: '/boom', headers: BROWSER });
    assert.equal(r.status, 500);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.match(r.text, /Something went wrong/);
    assert.match(r.text, /href="\/"/);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.ok(!/hunter2|Error:/.test(r.text));
  });

  test('a program (no Accept header) or anything that does not ask for a page gets the JSON body', async () => {
    for (const headers of [{}, { Accept: 'application/json' }, { Accept: '*/*' }, { Accept: 'text/plain' }]) {
      const r = await request(withPage.port, { path: '/boom', headers });
      assert.equal(r.status, 500);
      assert.deepEqual(r.json(), { error: { code: 500, status: 'INTERNAL', message: 'The server hit an unexpected error. Details are in the server window.' } });
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.ok(!r.text.includes('hunter2'));
    }
  });

  test('/api is JSON even for a browser', async () => {
    const r = await request(withPage.port, { path: '/api/boom', headers: BROWSER });
    assert.equal(r.status, 500);
    assert.equal(r.json().error.status, 'INTERNAL');
    assert.ok(!r.text.includes('api detail'));
    assert.ok(log.lines.some((l) => l.includes('api detail that must stay in the log')));
  });

  test('a 4xx keeps its status and its message as JSON (it is not the server\'s fault, and not a page)', async () => {
    const r = await request(withPage.port, { path: '/teapot', headers: BROWSER });
    assert.equal(r.status, 418);
    assert.equal(r.json().error.message, 'short and stout');
  });

  test('HEAD gets the status and headers of the page and no body', async () => {
    const r = await request(withPage.port, { method: 'HEAD', path: '/boom', headers: BROWSER });
    assert.equal(r.status, 500);
    assert.equal(r.buffer.length, 0);
  });

  test('an unknown address is still the plain 404 here (the Coming soon page is the real server\'s, below)', async () => {
    const r = await request(withPage.port, { path: '/nothing', headers: BROWSER });
    assert.equal(r.status, 404);
    assert.equal(r.text, 'Not found');
  });
});

describe('in the real server', () => {
  let app;
  before(async () => {
    app = await startTestApp();
  });
  after(() => app.stop());

  test('the Coming soon page is still the 404 for a browser at an address nobody built; JSON/plain for the rest', async () => {
    const page = await app.get('/careers', BROWSER);
    assert.equal(page.status, 404);
    assert.match(page.text, /Coming soon/);
    const api = await app.get('/api/nothing', BROWSER);
    assert.equal(api.status, 404);
    assert.equal(api.json().error.status, 'NOT_FOUND');
    assert.equal((await app.get('/nothing.css', BROWSER)).text, 'Not found');
  });

  test('a built page that cannot be read is a 500 page for a browser and JSON for a program, with no path or code in either', async (t) => {
    if (process.getuid?.() === 0) return t.skip('root can read any file');
    writeFixtureDist(app.root, { onlyPlainPages: true });
    const file = path.join(app.root, 'dist', 'pages', 'home.html');
    fs.chmodSync(file, 0o000);
    try {
      app.writeEnv('');
      const browser = await app.get('/', BROWSER);
      assert.equal(browser.status, 500);
      assert.match(browser.headers['content-type'], /^text\/html/);
      assert.ok(!/EACCES|terucon-test|home\.html|dist/.test(browser.text), browser.text);
      const program = await app.get('/', { Accept: 'application/json' });
      assert.equal(program.status, 500);
      assert.equal(program.json().error.status, 'INTERNAL');
      assert.ok(!/EACCES|terucon-test|home\.html/.test(program.text));
      assert.ok(app.log.lines.some((l) => l.startsWith('error ') && l.includes('EACCES')), 'the log has the reason');
    } finally {
      fs.chmodSync(file, 0o644);
    }
    assert.equal((await app.get('/')).status, 200, 'and the page works again once it is readable');
  });

  test('it listens with the keep-alive and request timeouts meant for a proxy in front (65 s / 66 s / 5 min)', () => {
    assert.equal(app.server.keepAliveTimeout, 65_000);
    assert.equal(app.server.headersTimeout, 66_000);
    assert.equal(app.server.requestTimeout, 300_000);
    assert.ok(app.server.headersTimeout > app.server.keepAliveTimeout, 'Node needs this, or a request on a reused connection can be cut');
    assert.ok(app.server.requestTimeout >= app.server.headersTimeout);
    assert.equal(app.server.timeout, 0, 'a long answer (the studio waits up to 90 s on a GPU service) is not cut by a socket timeout');
  });
});

describe('an error nobody caught', () => {
  const setup = (options = {}) => {
    const proc = new EventEmitter();
    const log = collectLog();
    const exits = [];
    const closed = [];
    const remove = installCrashHandlers({
      log,
      proc,
      exit: (code) => exits.push(code),
      close: options.close ?? (async () => closed.push('closed')),
      graceMs: options.graceMs ?? 5000,
    });
    return { proc, log, exits, closed, remove };
  };

  test('an uncaught exception is logged, the server is closed, and the process leaves with 1', async () => {
    const { proc, log, exits, closed } = setup();
    proc.emit('uncaughtException', new Error('kaboom'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(closed, ['closed']);
    assert.deepEqual(exits, [1]);
    assert.ok(log.lines.some((l) => l.startsWith('error ') && l.includes('uncaught exception') && l.includes('kaboom')), log.lines.join('\n'));
    assert.ok(log.lines.some((l) => l.includes('exit')));
  });

  test('an unhandled rejection too, even when the reason is not an Error', async () => {
    const { proc, log, exits } = setup();
    proc.emit('unhandledRejection', 'just a string');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exits, [1]);
    assert.ok(log.lines.some((l) => l.includes('unhandled rejection') && l.includes('just a string')));
  });

  test('the exit comes after the close has finished, not before', async () => {
    let finish;
    const gate = new Promise((resolve) => (finish = resolve));
    const { proc, exits } = setup({ close: () => gate });
    proc.emit('uncaughtException', new Error('x'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(exits, [], 'still closing');
    finish();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(exits, [1]);
  });

  test('a close that hangs is not waited for for ever', async () => {
    const { proc, exits } = setup({ close: () => new Promise(() => {}), graceMs: 40 });
    proc.emit('uncaughtException', new Error('x'));
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(exits, [1]);
  });

  test('a close that throws still ends in exit 1; a second failure while closing only adds a log line', async () => {
    let finish;
    const gate = new Promise((resolve) => (finish = resolve));
    const first = setup({ close: async () => { await gate; throw new Error('close failed'); } });
    first.proc.emit('uncaughtException', new Error('one'));
    first.proc.emit('unhandledRejection', new Error('two'));
    finish();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(first.exits, [1], 'one exit');
    assert.ok(first.log.lines.some((l) => l.includes('two')));
    assert.ok(first.log.lines.some((l) => l.includes('close failed')));
  });

  test('a password in a connection string is not written to the log', async () => {
    const { proc, log } = setup();
    proc.emit('uncaughtException', new Error('cannot reach mongodb+srv://user:s3cret@cluster0.example.net/db'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(!log.lines.join('\n').includes('s3cret'));
    assert.match(log.lines.join('\n'), /mongodb\+srv:\/\/\*\*\*@cluster0/);
  });

  test('the handlers can be taken off again', () => {
    const { proc, remove } = setup();
    remove();
    assert.equal(proc.listenerCount('uncaughtException'), 0);
    assert.equal(proc.listenerCount('unhandledRejection'), 0);
  });
});
