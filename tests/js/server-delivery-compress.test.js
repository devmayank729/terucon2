// Compression of everything that is not precompressed (server/middleware/compress.js): the hand-written pages, the JSON API, brand files
// and the studio's files. What is compressed, what is left alone, and that validators and ranges survive.
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import zlib from 'node:zlib';
import { compress } from '../../server/middleware/compress.js';
import { startTestApp } from '../helpers/app.js';
import { request } from '../helpers/http.js';
import { filler } from './server-delivery-helpers.js';

const tokens = (r) => (r.headers.vary ?? '').split(/\s*,\s*/).filter(Boolean);

describe('the real server', () => {
  let app;
  const BIG_PAGE = `<!doctype html><title>Sign in</title><style>${filler('login', 6000)}</style><p>hello</p>`;
  before(async () => {
    app = await startTestApp();
    fs.writeFileSync(path.join(app.root, 'pages', 'login.html'), BIG_PAGE);
    fs.mkdirSync(path.join(app.root, 'site', 'brand'), { recursive: true });
    fs.writeFileSync(path.join(app.root, 'site', 'brand', 'big.css'), filler('big', 5000));
  });
  after(() => app.stop());

  test('a hand-written page: brotli, gzip or plain by what the client takes; the policy and the weak tag are untouched', async () => {
    const plain = await app.get('/login');
    assert.equal(plain.status, 200);
    assert.equal(plain.text, BIG_PAGE);
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.deepEqual(tokens(plain), ['Accept-Encoding'], 'the answer depends on the header even when this client sent none');

    const br = await app.get('/login', { 'Accept-Encoding': 'gzip, deflate, br' });
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(zlib.brotliDecompressSync(br.buffer).toString(), BIG_PAGE);
    assert.ok(br.buffer.length < plain.buffer.length / 4, `${br.buffer.length} vs ${plain.buffer.length}`);
    assert.equal(br.headers['content-length'], undefined, 'streamed: the plain length would be wrong');
    assert.equal(br.headers['content-security-policy'], plain.headers['content-security-policy'], 'the page\'s own policy is still there');
    assert.equal(br.headers.etag, plain.headers.etag, 'a weak tag stays true for a compressed copy');
    assert.match(br.headers.etag, /^W\//);
    assert.equal(br.headers['cache-control'], 'no-cache');

    const gz = await app.get('/login', { 'Accept-Encoding': 'gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(zlib.gunzipSync(gz.buffer).toString(), BIG_PAGE);

    for (const refuse of ['identity', 'br;q=0, gzip;q=0', 'deflate;q=0, *;q=0']) {
      assert.equal((await app.get('/login', { 'Accept-Encoding': refuse })).headers['content-encoding'], undefined, refuse);
    }
  });

  test('a conditional request gets the cheap 304 (nothing to compress), HEAD gets the headers of the plain answer', async () => {
    const first = await app.get('/login', { 'Accept-Encoding': 'br' });
    const again = await app.get('/login', { 'Accept-Encoding': 'br', 'If-None-Match': first.headers.etag });
    assert.equal(again.status, 304);
    assert.equal(again.buffer.length, 0);
    assert.equal(again.headers['content-encoding'], undefined);
    const head = await app.request('/login', { method: 'HEAD', headers: { 'Accept-Encoding': 'br' } });
    assert.equal(head.status, 200);
    assert.equal(head.buffer.length, 0);
    assert.equal(head.headers['content-encoding'], undefined);
    assert.equal(Number(head.headers['content-length']), Buffer.byteLength(BIG_PAGE));
  });

  test('the JSON API: compressed when it is over 1 KB and the client takes it, never given a tag, still no-store', async () => {
    const plain = await app.get('/api/site');
    assert.ok(plain.buffer.length > 1024, `${plain.buffer.length} bytes`);
    const br = await app.get('/api/site', { 'Accept-Encoding': 'br' });
    assert.equal(br.status, 200);
    assert.equal(br.headers['content-encoding'], 'br');
    assert.match(br.headers['content-type'], /^application\/json/);
    assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(br.buffer).toString()), plain.json());
    assert.equal(br.headers.etag, undefined);
    assert.equal(br.headers['cache-control'], 'no-store');
    assert.ok(br.buffer.length < plain.buffer.length / 2);
  });

  test('a small answer (under 1 KB) is left alone, with or without the header', async () => {
    const r = await app.get('/api/health', { 'Accept-Encoding': 'br, gzip' });
    assert.equal(r.status, 200);
    assert.ok(r.buffer.length < 1024);
    assert.equal(r.headers['content-encoding'], undefined);
    assert.equal(r.json().ok, true);
    const error = await app.get('/api/nothing', { 'Accept-Encoding': 'br' });
    assert.equal(error.status, 404);
    assert.equal(error.json().error.status, 'NOT_FOUND');
  });

  test('photos and video (not compressible types) are never touched and carry no Vary', async () => {
    for (const name of ['photo.jpg', 'clip.mp4']) {
      const r = await app.get(`/media/${name}`, { 'Accept-Encoding': 'br, gzip' });
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-encoding'], undefined, name);
      assert.equal(r.headers.vary, undefined, name);
    }
    const part = await app.get('/media/photo.jpg', { 'Accept-Encoding': 'br', Range: 'bytes=0-9' });
    assert.equal(part.status, 206);
    assert.equal(part.buffer.length, 10);
  });

  test('a Range request for a compressible file is answered as asked, uncompressed (a compressed byte range would be garbage)', async () => {
    const whole = await app.get('/brand/big.css', { 'Accept-Encoding': 'br' });
    assert.equal(whole.headers['content-encoding'], 'br');
    const part = await app.get('/brand/big.css', { 'Accept-Encoding': 'br', Range: 'bytes=5-24' });
    assert.equal(part.status, 206);
    assert.equal(part.headers['content-encoding'], undefined);
    assert.equal(part.headers['content-range'], `bytes 5-24/${fs.statSync(path.join(app.root, 'site', 'brand', 'big.css')).size}`);
    assert.equal(part.buffer.toString(), zlib.brotliDecompressSync(whole.buffer).toString().slice(5, 25));
  });
});

describe('the middleware on its own', () => {
  let server;
  let port;
  const body = filler('x', 4000);
  before(async () => {
    const mini = express();
    mini.use(compress());
    mini.get('/text', (req, res) => res.type('text/plain').send(body));
    mini.get('/no-transform', (req, res) => res.set('Cache-Control', 'public, no-transform').type('text/plain').send(body));
    mini.get('/own-coding', (req, res) => res.set('Content-Encoding', 'identity-x').type('text/plain').send(body));
    mini.get('/skip', (req, res) => {
      res.locals.skipCompression = true;
      res.type('text/plain').send(body);
    });
    mini.get('/stream', (req, res) => {
      res.type('text/event-stream');
      res.write(`data: ${body}\n\n`);
      res.end();
    });
    mini.get('/zip', (req, res) => res.type('application/zip').send(Buffer.from(body)));
    mini.get('/png', (req, res) => res.type('image/png').send(Buffer.from(body)));
    mini.get('/woff2', (req, res) => res.type('font/woff2').send(Buffer.from(body)));
    mini.get('/svg', (req, res) => res.type('image/svg+xml').send(body));
    mini.get('/json', (req, res) => res.json({ body }));
    mini.get('/exactly-1kb', (req, res) => res.type('text/plain').send('a'.repeat(1024)));
    mini.get('/just-under', (req, res) => res.type('text/plain').send('a'.repeat(1023)));
    mini.get('/partial', (req, res) => res.status(206).set('Content-Range', `bytes 0-${body.length - 1}/${body.length}`).type('text/plain').send(body));
    mini.get('/empty', (req, res) => res.status(204).end());
    server = http.createServer(mini);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });
  after(() => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))));

  const ask = (p, encoding = 'br', extra = {}) => request(port, { path: p, headers: { 'Accept-Encoding': encoding, ...extra } });

  test('plain text, JSON and SVG are compressed, brotli first', async () => {
    for (const p of ['/text', '/json', '/svg']) {
      const r = await ask(p, 'gzip, br');
      assert.equal(r.headers['content-encoding'], 'br', p);
      assert.match(r.headers.vary, /Accept-Encoding/, p);
      assert.ok(r.buffer.length < 400, `${p}: ${r.buffer.length}`);
    }
    assert.equal((await ask('/text', 'gzip')).headers['content-encoding'], 'gzip');
  });

  test('left alone: no-transform, an answer that already has a coding, one that marked itself, an event stream, a partial answer, and types that are already compressed', async () => {
    for (const p of ['/no-transform', '/own-coding', '/skip', '/stream', '/partial', '/zip', '/png', '/woff2']) {
      const r = await ask(p);
      const encoding = r.headers['content-encoding'];
      assert.ok(encoding === undefined || encoding === 'identity-x', `${p}: ${encoding}`);
      assert.ok(r.buffer.length >= 4000 || p === '/stream', `${p}: ${r.buffer.length} bytes`);
    }
    assert.equal((await ask('/partial')).status, 206);
  });

  test('the threshold is 1 KB: exactly 1024 bytes is compressed, 1023 is not', async () => {
    assert.equal((await ask('/exactly-1kb')).headers['content-encoding'], 'br');
    assert.equal((await ask('/just-under')).headers['content-encoding'], undefined);
  });

  test('an empty answer is fine', async () => {
    const r = await ask('/empty');
    assert.equal(r.status, 204);
    assert.equal(r.buffer.length, 0);
  });

  test('a client that sends no Accept-Encoding gets the plain bytes', async () => {
    const r = await request(port, { path: '/text' });
    assert.equal(r.headers['content-encoding'], undefined);
    assert.equal(r.text, body);
  });
});
