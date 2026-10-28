// server/middleware/errorHandler.js on a throw-away app: no route of the real server reads a JSON body (yet), so the
// body-parser errors it turns into readable answers are provoked here.
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import test, { after, before, describe } from 'node:test';
import { errorHandler, notFound } from '../../server/middleware/errorHandler.js';
import { collectLog } from '../helpers/app.js';
import { request } from '../helpers/http.js';

describe('the error handler', () => {
  let server;
  let port;
  const log = collectLog();

  before(async () => {
    const app = express();
    app.post('/json', express.json({ limit: '1kb' }), (req, res) => res.json({ got: req.body }));
    app.get('/boom', () => {
      throw new Error('secret detail');
    });
    app.get('/teapot', (req, res, next) => next(Object.assign(new Error('short and stout'), { status: 418 })));
    app.use(notFound);
    app.use(errorHandler({ log }));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  const json = { 'Content-Type': 'application/json' };

  test('a body that is not JSON is a 400 in the usual shape', async () => {
    const r = await request(port, { method: 'POST', path: '/json', headers: json, body: '{nope' });
    assert.equal(r.status, 400);
    assert.deepEqual(r.json(), { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'The request body is not valid JSON.' } });
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  test('a body over the limit is a 413', async () => {
    const r = await request(port, { method: 'POST', path: '/json', headers: json, body: Buffer.alloc(2048, 0x20) });
    assert.equal(r.status, 413);
    assert.equal(r.json().error.status, 'INVALID_ARGUMENT');
    assert.match(r.json().error.message, /too large/);
  });

  test('a body in a charset the parser does not read is a 415', async () => {
    const r = await request(port, { method: 'POST', path: '/json', headers: { 'Content-Type': 'application/json; charset=iso-8859-1' }, body: '{}' });
    assert.equal(r.status, 415);
    assert.match(r.json().error.message, /UTF-8/);
  });

  test('an error that names a 4xx status keeps it and its message', async () => {
    const r = await request(port, { path: '/teapot' });
    assert.equal(r.status, 418);
    assert.equal(r.json().error.message, 'short and stout');
  });

  test('an unexpected error is a 500 that shows no detail; the detail goes to the log', async () => {
    const r = await request(port, { path: '/boom' });
    assert.equal(r.status, 500);
    assert.equal(r.json().error.status, 'INTERNAL');
    assert.ok(!r.text.includes('secret detail'));
    assert.ok(log.lines.some((line) => line.startsWith('error ') && line.includes('secret detail') && line.includes('GET /boom')), log.lines.join('\n'));
  });

  test('anything else is a plain 404', async () => {
    const r = await request(port, { path: '/nothing-here' });
    assert.equal(r.status, 404);
    assert.match(r.headers['content-type'], /^text\/plain/);
    assert.equal(r.text, 'Not found');
  });
});
