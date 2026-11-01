import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { checkTarget, createSafeFetch, FetchError } from '../../server/lib/inspiration/safeFetch.js';

// Inspiration import (C3): the server opens an address a visitor chose. These tests attack that: internal addresses, IP literals,
// redirects to them, DNS that answers with a private address, endless and oversized bodies, slow servers, the wrong kind of file.
// The "websites" are a local HTTPS server answering to made-up names.

const refuses = (text, code) => assert.throws(() => checkTarget(text), (e) => e instanceof FetchError && e.code === code, text);

test('addresses that are refused before anything is looked up', () => {
  for (const text of ['not a url', '', 'https://', '//example.com/a.jpg']) refuses(text, 'bad-address');
  for (const text of ['http://example.com/a.jpg', 'ftp://example.com/a.jpg', 'file:///etc/passwd', 'https://user:pw@example.com/a.jpg', 'https://example.com:8443/a.jpg', 'https://example.com:80/a.jpg']) refuses(text, 'bad-address');
  for (const text of ['https://localhost/a.jpg', 'https://127.0.0.1/a.jpg', 'https://[::1]/a.jpg', 'https://2130706433/a.jpg', 'https://0x7f.1/a.jpg', 'https://169.254.169.254/latest/meta-data/', 'https://printer.local/a.jpg', 'https://db.internal/a.jpg', 'https://app.localhost/a.jpg', 'https://intranet/a.jpg', 'https://10.1.2.3/a.jpg', 'https://nas.home.arpa/a.jpg']) refuses(text, 'blocked');
  assert.equal(checkTarget('https://Pics.Example.com./a.jpg?x=1').hostname, 'pics.example.com.');
});

test('a name that resolves to a private address is refused at the connection, whatever the name says', async () => {
  for (const answer of ['127.0.0.1', '10.0.0.7', '169.254.169.254', '192.168.1.1', '::1']) {
    const fetcher = createSafeFetch({ resolve: (host, options, cb) => cb(null, [{ address: answer, family: answer.includes(':') ? 6 : 4 }]), timeoutMs: 3000 });
    await assert.rejects(fetcher.get('https://pics.example.com/a.jpg', { accept: 'image/*', maxBytes: () => 1000 }), (e) => e.code === 'blocked', answer);
  }
  const mixed = createSafeFetch({ resolve: (host, options, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]), timeoutMs: 3000 });
  await assert.rejects(mixed.get('https://pics.example.com/a.jpg', { accept: 'image/*', maxBytes: () => 1000 }), (e) => e.code === 'blocked', 'one private answer among public ones');
});

// ---- a local HTTPS server standing in for the internet

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-insp-'));
const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=pics.example.com', '-addext', 'subjectAltName=DNS:pics.example.com,DNS:other.example.com'], { encoding: 'utf8' });
const skip = made.status !== 0 && 'openssl is not available to make a test certificate';

let server;
let port;
let hits;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.alloc(100, 7)]);

before(async () => {
  if (skip) return;
  hits = [];
  server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }, (req, res) => {
    hits.push({ url: req.url, host: req.headers.host, ua: req.headers['user-agent'], cookie: req.headers.cookie, encoding: req.headers['accept-encoding'] });
    const send = (status, headers, body) => {
      res.writeHead(status, headers);
      res.end(body);
    };
    switch (req.url.split('?')[0]) {
      case '/ok.jpg': return send(200, { 'Content-Type': 'image/jpeg' }, JPEG);
      case '/octet': return send(200, { 'Content-Type': 'application/octet-stream' }, JPEG);
      case '/page': return send(200, { 'Content-Type': 'text/html; charset=utf-8' }, '<meta property="og:image" content="/ok.jpg">');
      case '/text': return send(200, { 'Content-Type': 'text/plain' }, 'hello');
      case '/missing': return send(404, {}, 'no');
      case '/hop1': return send(302, { Location: '/hop2' }, '');
      case '/hop2': return send(302, { Location: 'https://other.example.com/ok.jpg' }, '');
      case '/to-ip': return send(302, { Location: `https://127.0.0.1:${port}/ok.jpg` }, '');
      case '/to-http': return send(302, { Location: 'http://pics.example.com/ok.jpg' }, '');
      case '/to-meta': return send(302, { Location: 'https://169.254.169.254/latest/meta-data/' }, '');
      case '/to-localhost': return send(302, { Location: 'https://localhost/x.jpg' }, '');
      case '/loop': return send(302, { Location: '/loop' }, '');
      case '/declared-big': return send(200, { 'Content-Type': 'image/jpeg', 'Content-Length': '5000' }, Buffer.alloc(5000));
      case '/endless': {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        const timer = setInterval(() => res.write(Buffer.alloc(4096)), 5);
        res.on('close', () => clearInterval(timer));
        return undefined;
      }
      case '/slow': {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        return undefined; // never finishes
      }
      default: return send(404, {}, '');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(() => {
  server?.close();
  server?.closeAllConnections?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

const local = (extra = {}) => createSafeFetch({ resolve: (host, options, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]), isPublic: () => true, agentOptions: { ca: fs.readFileSync(path.join(dir, 'cert.pem')) }, port, timeoutMs: 4000, ...extra });
const IMAGE = { accept: 'image/*', maxBytes: (type) => (type.startsWith('image/') || type.endsWith('octet-stream') ? 1000 : 0) };
const at = (name) => `https://pics.example.com:${port}${name}`;

test('a picture is fetched with an honest user agent, no cookies and no compression', { skip }, async () => {
  const got = await local().get(at('/ok.jpg?x=1'), IMAGE);
  assert.equal(got.contentType, 'image/jpeg');
  assert.deepEqual(got.body, JPEG);
  assert.equal(got.finalUrl, at('/ok.jpg?x=1'));
  const hit = hits.at(-1);
  assert.match(hit.ua, /^TeruconInspirationImport\//);
  assert.equal(hit.cookie, undefined);
  assert.equal(hit.encoding, 'identity');
  assert.equal((await local().get(at('/octet'), IMAGE)).contentType, 'application/octet-stream');
});

test('redirects are followed by hand and every hop is checked again', { skip }, async () => {
  const followed = await local().get(at('/hop1'), IMAGE); // two hops, the second to another public name
  assert.equal(followed.finalUrl, 'https://other.example.com/ok.jpg');
  assert.deepEqual(followed.body, JPEG);
  assert.equal(hits.at(-1).host, `other.example.com:${port}`.replace(`:${port}`, ''), 'the next hop is asked for by its own name');
  await assert.rejects(local().get(at('/to-ip'), IMAGE), (e) => e.code === 'blocked', 'redirect to an IP address');
  await assert.rejects(local().get(at('/to-meta'), IMAGE), (e) => e.code === 'blocked', 'redirect to the cloud metadata address');
  await assert.rejects(local().get(at('/to-localhost'), IMAGE), (e) => e.code === 'blocked', 'redirect to localhost');
  await assert.rejects(local().get(at('/to-http'), IMAGE), (e) => e.code === 'bad-address', 'redirect down to http');
  await assert.rejects(local().get(at('/loop'), IMAGE), (e) => e.code === 'redirects', 'a loop');
});

test('too big, too slow, wrong type, missing', { skip }, async () => {
  await assert.rejects(local().get(at('/declared-big'), IMAGE), (e) => e.code === 'too-big', 'declared too big: refused before reading');
  await assert.rejects(local().get(at('/endless'), IMAGE), (e) => e.code === 'too-big', 'endless body: stopped at the limit');
  await assert.rejects(local({ timeoutMs: 300 }).get(at('/slow'), IMAGE), (e) => e.code === 'timeout');
  await assert.rejects(local().get(at('/text'), IMAGE), (e) => e.code === 'type');
  await assert.rejects(local().get(at('/missing'), IMAGE), (e) => e.code === 'status' && e.status === 404);
  const page = await local().get(at('/page'), { accept: 'text/html', maxBytes: (type) => (type === 'text/html' ? 5000 : 0) });
  assert.match(page.body.toString(), /og:image/);
});

test('a server that is not who it says is refused (certificate checked)', { skip }, async () => {
  const wrong = createSafeFetch({ resolve: (host, options, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]), isPublic: () => true, port, timeoutMs: 3000 }); // does not trust our test certificate
  await assert.rejects(wrong.get(at('/ok.jpg'), IMAGE), (e) => e.code === 'network');
});
