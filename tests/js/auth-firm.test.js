import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { createFirmLookup, isPublicAddress, namesFromHtml, pickFirmName, safeLookup } from '../../server/auth/firm.js';

// Suggesting a firm name from a business e-mail, including the one dangerous part: the server opens a website the visitor chose.
// The tests attack that: loopback, private and metadata addresses, IPv6 tricks, DNS that changes its answer, redirects away from
// the site, endless bodies, slow servers.

test('which addresses count as the public internet', () => {
  for (const ok of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '192.169.0.1', '2606:4700:4700::1111', '2a00:1450:4009::200e']) assert.equal(isPublicAddress(ok), true, ok);
  const private_ = [
    '0.0.0.0', '10.0.0.1', '10.255.255.255', '100.64.0.1', '127.0.0.1', '127.255.255.254', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.7', '203.0.113.9',
    '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fec0::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::', '64:ff9b::7f00:1', '100::1',
    '::ffff:127.0.0.1', '::ffff:10.1.2.3', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::FFFF:192.168.1.1', '0:0:0:0:0:ffff:7f00:1',
    'not an address', '', '127.1', '2130706433', '0x7f.0.0.1', null, undefined, 5,
  ];
  for (const bad of private_) assert.equal(isPublicAddress(bad), false, String(bad));
});

test('the safe lookup hands back public addresses only, and refuses when any of the answers is private', async () => {
  const lookup = (answers) => safeLookup({ resolve: (host, options, cb) => (answers instanceof Error ? cb(answers) : cb(null, answers)) });
  const run = (answers, options = {}) => new Promise((resolve) => lookup(answers)('x.example', options, (error, address, family) => resolve({ error, address, family })));
  assert.equal((await run([{ address: '93.184.216.34', family: 4 }])).address, '93.184.216.34');
  assert.deepEqual((await run([{ address: '93.184.216.34', family: 4 }], { all: true })).address, [{ address: '93.184.216.34', family: 4 }]);
  for (const answers of [[{ address: '127.0.0.1', family: 4 }], [{ address: '169.254.169.254', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }], [{ address: '::1', family: 6 }], [{ address: '::ffff:7f00:1', family: 6 }], []]) {
    const r = await run(answers);
    assert.equal(r.error?.code, 'EBLOCKED', JSON.stringify(answers));
    assert.equal(r.address, undefined);
  }
  assert.match((await run(new Error('ENOTFOUND'))).error.message, /ENOTFOUND/);
});

test('reading a page: site name, application name, title pieces; the name that holds the domain\'s own word wins', () => {
  const html = '<html><head><title>Home &amp; Welcome | Test Interiors Pvt Ltd</title><meta property="og:site_name" content="Test Interiors"><meta name="application-name" content="x"></head>';
  assert.deepEqual(namesFromHtml(html).slice(0, 2), ['Test Interiors', 'x']);
  assert.ok(namesFromHtml(html).includes('Test Interiors Pvt Ltd'));
  assert.equal(pickFirmName(namesFromHtml(html), 'test.example'), 'Test Interiors', 'the shortest name containing "test"');
  assert.equal(pickFirmName(['Home', 'Welcome'], 'test.example'), null, 'nothing that looks like the firm');
  assert.equal(pickFirmName(['<script>alert(1)</script> Test'], 'test.example'), null, 'markup is refused, not cleaned up');
  assert.equal(pickFirmName(['Totally Different Name'], 'ab.example'), null, 'a label that is too short to compare is not guessed at');
  assert.deepEqual(namesFromHtml('<p>no head</p>'), []);
  assert.deepEqual(namesFromHtml('<title></title>'), []);
  // entities are decoded, so encoded markup comes out as literal "<b>": which is why every candidate then goes through cleanFirm, which refuses < and >
  assert.deepEqual(namesFromHtml('<meta property="og:site_name" content="A &lt;b&gt;bold&lt;/b&gt; Test">'), ['A <b>bold</b> Test']);
  assert.equal(pickFirmName(namesFromHtml('<meta property="og:site_name" content="A &lt;b&gt;bold&lt;/b&gt; Test">'), 'test.example'), null, 'markup, even encoded, never becomes a suggestion');
});

// ---- a real HTTPS server on this computer, with a throw-away certificate for test.example

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-firm-'));
const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=test.example', '-addext', 'subjectAltName=DNS:test.example,DNS:www.test.example,DNS:evil.example'], { encoding: 'utf8' });
const skip = made.status !== 0 && 'openssl is not available to make a test certificate';
let server;
let port;
const hits = [];
let behaviour = () => ({ status: 200, type: 'text/html', body: '<title>Hello | Test Interiors Pvt Ltd</title>' });

before(async () => {
  if (skip) return;
  server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }, (req, res) => {
    hits.push(`${req.headers.host}${req.url}`);
    const b = behaviour(req);
    if (b.hang) return;
    res.writeHead(b.status, { 'Content-Type': b.type ?? 'text/html', ...(b.location && { Location: b.location }) });
    if (b.stream) {
      const chunk = Buffer.alloc(64 * 1024, 97);
      let sent = 0;
      const timer = setInterval(() => {
        if (res.destroyed || sent > 50 * 1024 * 1024) return clearInterval(timer);
        sent += chunk.length;
        res.write(chunk);
      }, 1);
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.end(b.body ?? '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(() => {
  server?.closeAllConnections();
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const lookup = (extra = {}) =>
  createFirmLookup({
    resolve: (host, options, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
    isPublic: () => true, // the test server is on this computer, so the "public" check is switched off for the happy paths
    agentOptions: { ca: fs.readFileSync(path.join(dir, 'cert.pem')) },
    port,
    timeoutMs: 1500,
    ...extra,
  });

test('website mode reads the firm\'s own name, and remembers it', { skip }, async () => {
  hits.length = 0;
  const finder = lookup();
  const first = await finder.suggest('test.example', 'website');
  assert.deepEqual(first, { name: 'Test Interiors Pvt Ltd', source: 'website' });
  const again = await finder.suggest('test.example', 'website');
  assert.deepEqual(again, first);
  assert.equal(hits.length, 1, 'the second answer came from memory, not from the firm\'s server');
  finder.close();
});

test('the other modes never touch the network', { skip }, async () => {
  hits.length = 0;
  const finder = lookup();
  assert.deepEqual(await finder.suggest('test.example', 'domain'), { name: 'Test', source: 'domain' });
  assert.deepEqual(await finder.suggest('test.example', 'off'), { name: null, source: null });
  assert.deepEqual(await finder.suggest('gmail.com', 'website'), { name: null, source: null }, 'a free mailbox has no firm to look up');
  assert.deepEqual(await finder.suggest('mailinator.com', 'website'), { name: null, source: null });
  assert.equal(hits.length, 0);
  finder.close();
});

test('a redirect to the www. twin is followed; anywhere else is not', { skip }, async () => {
  const finder = lookup();
  hits.length = 0;
  behaviour = (req) => (req.headers.host === 'test.example' ? { status: 301, location: 'https://www.test.example/home' } : { status: 200, body: '<title>Test Interiors</title>' });
  assert.equal((await finder.suggest('test.example', 'website')).name, 'Test Interiors');
  assert.deepEqual(hits, ['test.example/', 'www.test.example/home']);

  for (const location of ['https://evil.example/', 'http://test.example/', 'https://test.example:8443/', 'https://user:pw@test.example/', '//evil.example/', 'https://127.0.0.1/', 'https://169.254.169.254/latest/meta-data/']) {
    const fresh = lookup();
    hits.length = 0;
    behaviour = () => ({ status: 302, location });
    const r = await fresh.suggest('test.example', 'website');
    assert.deepEqual(r, { name: 'Test', source: 'domain' }, `not followed: ${location}`);
    assert.ok(hits.every((h) => h.startsWith('test.example') || h.startsWith('www.test.example')), `only the firm's own host was contacted: ${hits}`);
    fresh.close();
  }
  finder.close();
  behaviour = () => ({ status: 200, body: '<title>Hello | Test Interiors Pvt Ltd</title>' });
});

test('a loop of redirects stops after two', { skip }, async () => {
  const finder = lookup();
  hits.length = 0;
  behaviour = () => ({ status: 302, location: 'https://test.example/again' });
  await finder.suggest('test.example', 'website');
  assert.ok(hits.length <= 6, `at most two redirects per address, saw ${hits.length}`);
  finder.close();
  behaviour = () => ({ status: 200, body: '<title>Hello | Test Interiors Pvt Ltd</title>' });
});

test('not a page, an error, an endless body, a server that never answers: all fall back to the guess from the domain', { skip }, async () => {
  const cases = [
    () => ({ status: 200, type: 'application/json', body: '{"title":"Test Evil"}' }),
    () => ({ status: 500, body: '<title>Test</title>' }),
    () => ({ status: 404, body: '<title>Test Interiors</title>' }),
    () => ({ status: 200, stream: true }),
    () => ({ hang: true }),
  ];
  for (const make of cases) {
    behaviour = make;
    const finder = lookup({ timeoutMs: 800 });
    const started = Date.now();
    const r = await finder.suggest('test.example', 'website');
    assert.deepEqual(r, { name: 'Test', source: 'domain' });
    assert.ok(Date.now() - started < 4000, 'gave up quickly');
    finder.close();
  }
  behaviour = () => ({ status: 200, body: '<title>Hello | Test Interiors Pvt Ltd</title>' });
});

test('SSRF: with the real address check, a domain that resolves to this computer, a private network or the cloud metadata address is never connected to', { skip }, async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.0.9', '::1', '::ffff:127.0.0.1', 'fd00::5']) {
    hits.length = 0;
    const finder = createFirmLookup({ resolve: (host, options, cb) => cb(null, [{ address, family: address.includes(':') ? 6 : 4 }]), agentOptions: { ca: fs.readFileSync(path.join(dir, 'cert.pem')) }, port, timeoutMs: 1000 });
    const r = await finder.suggest('test.example', 'website');
    assert.deepEqual(r, { name: 'Test', source: 'domain' }, address);
    assert.equal(hits.length, 0, `${address}: the server was not contacted`);
    finder.close();
  }
});

test('DNS rebinding: the address is checked as the connection is made, every time, so a name that turns private later is refused', { skip }, async () => {
  let calls = 0;
  const finder = createFirmLookup({
    resolve: (host, options, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
    isPublic: () => {
      calls += 1;
      return calls === 1; // public for the first connection, private after: what a rebinding attacker's DNS does
    },
    agentOptions: { ca: fs.readFileSync(path.join(dir, 'cert.pem')) },
    port,
    timeoutMs: 1000,
  });
  hits.length = 0;
  assert.equal((await finder.suggest('test.example', 'website')).source, 'website');
  assert.equal(hits.length, 1);
  assert.equal((await finder.suggest('www.test.example', 'website')).source, 'domain', 'the next name resolved to a private address and was refused');
  assert.equal(hits.length, 1, 'no second connection was made');
  finder.close();
});
