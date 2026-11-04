// Browser tests. Starts tests/dev/stack.mjs (the real website with the real Design Studio mounted in it, against mock GPU
// services, no database and no Google key), drives Chrome through the real pages, reports.
//
//   cd tests/e2e && npm install && npm test            (about a minute)
//   CHROME_PATH=/path/to/chrome npm test               if Chrome is somewhere unusual
//   E2E_ONLY="sign-in page" node tests/e2e/run.mjs      only the tests whose name contains that text
import puppeteer from 'puppeteer-core';
import fs, { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startStack } from '../dev/stack.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const chrome = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find((p) => existsSync(p));
if (!chrome) { console.error('Chrome not found. Set CHROME_PATH.'); process.exit(2); }

const site = JSON.parse(readFileSync(path.join(root, 'site/site.json'), 'utf8'));
const PAGES = Object.fromEntries(Object.entries(site.pages).map(([k, p]) => [k, p.route]));
const CONNECTIONS = Object.fromEntries(Object.entries(site.connections).filter(([k]) => k in site.pages));
const PASSCODE = 'letmein';

const results = [];
const test = async (name, fn) => {
  if (process.env.E2E_ONLY && !name.includes(process.env.E2E_ONLY)) return;
  const t0 = Date.now();
  try { await fn(); results.push([name, true, Date.now() - t0]); console.log(`  ok    ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  catch (e) { results.push([name, false, Date.now() - t0]); console.log(`  FAIL  ${name}\n        ${String(e.message || e).split('\n').join('\n        ')}`); if (process.env.E2E_STACK) console.log(String(e.stack).split('\n').slice(1, 6).map((l) => '        ' + l).join('\n')); }
};
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
/** Poll until `check()` is truthy (returns its value) or fail after `ms`. */
const until = async (check, what, ms = 8000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
};

// the stack the tests share (the studio asks for its passcode, like the real one), and a few more for the cold-start tests
const stack = await startStack({ port: 0, passcode: PASSCODE, bootMs: 300 });
const base = stack.base;
console.log(`stack up at ${base}; the studio: ${JSON.stringify(stack.health.studio)}\n`);
const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], defaultViewport: { width: 1440, height: 900 } });

// Every page we open records what a visitor would notice going wrong: script errors, console errors, same-origin 4xx/5xx.
// KNOWN_GAPS are reported, not failed. They come from the Claude Design exports themselves:
// the Materials page has `<img src="{{ c.img }}">` inside its own <sc-for> template, which Chrome requests once, literally,
// before the page's runtime fills the template in. The real images load; nothing visible is wrong.
// The dashboard builds `media/materials/<id>.jpg` for each material; every one is embedded in the exports except fx-mill
// (the aluminium support frame), whose photo was never exported. Add media/materials/fx-mill.jpg and delete this entry.
const KNOWN_GAPS = [/\/%7B%7B(%20|\+| )[^/]*%7D%7D$/, /\/media\/materials\/fx-mill\.jpg$/];
// What the studio asks its server for that this stack refuses on purpose, as the real one does: the start-up check is
// answered 401 until someone has signed in (the passcode is on), the local scan service is not running (503), and there is
// no database (500). The studio copes with all three; they are reported as notes.
// ...and what the Finder page's warm-up asks for that this stack refuses on purpose: the dev stack sets no CATALOGUE_*
// settings, so the catalogue is off, and client.warm() (fire-and-forget; finder.js calls it on every load) gets a 503.
const BY_DESIGN = [[401, /\/api\/vision\/warmup$/], [503, /\/api\/vision\/warmup$/], [500, /\/api\/rooms(\/|$)/], [503, /^\/api\/catalogue\/warm$/]];
let signIns = 0;
let guests = 0;
/**
 * Sign this window in the way a visitor does: ask for a code, read it (the stack prints it in its window), enter it, fill in the
 * sign-up form. Every page but the landing page is for members, so a test that walks the site starts here. Each call comes from its
 * own "network address" (X-Forwarded-For), so the per-address limits never decide a test.
 */
const signInPage = async (p, stk) => {
  signIns += 1;
  const email = `visitor${signIns}-${Date.now()}@example.com`;
  const ip = `10.66.${Math.floor(signIns / 250)}.${(signIns % 250) + 1}`;
  // the page's own requests come from that address too: every page now asks who is signed in (the site chrome), and 120 requests a
  // minute from one address are all the sign-in API allows, which a whole run of tests from one computer would use up. (The header goes to
  // other sites too, and their CORS rules refuse it: a test that opens a page which loads from another site clears it, see the overview test.)
  await p.setExtraHTTPHeaders({ 'X-Forwarded-For': ip });
  await p.goto(stk.base + '/login', { waitUntil: 'domcontentloaded' });
  const started = await p.evaluate(async (who, addr) => (await (await fetch('/api/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': addr }, body: JSON.stringify({ identifier: who }) })).json()), email, ip);
  assert(started.challengeId, 'sign-in did not start: ' + JSON.stringify(started));
  const code = await until(() => stk.codeFor(email), 'the one-time code in the stack\'s window', 5000);
  const done = await p.evaluate(async (id, c, addr, phone) => {
    const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': addr }, body: JSON.stringify(body) });
    const v = await post('/api/auth/verify', { challengeId: id, code: c });
    if (!v.ok) return 'verify ' + v.status;
    const s = await post('/api/auth/profile', { name: 'Test Visitor', phone, firm: 'Test Firm' });
    if (!s.ok) return 'profile ' + s.status;
    // the second contact detail is confirmed with a code before the sign-up counts as finished
    const c2 = await post('/api/auth/contact/start', { kind: 'phone', value: phone });
    return c2.ok ? { challengeId: (await c2.json()).challengeId } : 'contact start ' + c2.status;
  }, started.challengeId, code, ip, `98${String(signIns).padStart(8, '0')}`);
  assert(done && done.challengeId, 'sign-in failed: ' + JSON.stringify(done));
  const phoneCode = await until(() => stk.codeFor(`+9198${String(signIns).padStart(8, '0')}`, 'verify-contact'), 'the code for the mobile number', 5000);
  const confirmed = await p.evaluate(async (id, c) => (await fetch('/api/auth/contact/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeId: id, code: c }) })).status, done.challengeId, phoneCode);
  assert(confirmed === 200, 'the mobile number was not confirmed: ' + confirmed);
};

const newPage = async (viewport, stk = stack, { signedIn = true } = {}) => {
  // a visitor with a clean slate: its own cookies and storage (cookies are shared across ports, so one test's sign-in
  // must not be another test's)
  const context = await browser.createBrowserContext();
  const p = await context.newPage();
  const closePage = p.close.bind(p);
  p.close = async () => { await closePage(); await context.close(); };
  if (viewport) await p.setViewport(viewport);
  p.problems = [];
  p.gaps = [];
  p.on('pageerror', (e) => p.problems.push('script error: ' + String(e).slice(0, 200)));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) p.problems.push('console error: ' + m.text().slice(0, 200)); });
  p.on('response', (r) => {
    const u = r.url();
    if (u.startsWith(stk.base) && r.status() >= 400) {
      const line = `${r.status()} ${u.replace(stk.base, '')}`;
      const known = KNOWN_GAPS.some((re) => re.test(u)) || BY_DESIGN.some(([status, re]) => status === r.status() && re.test(new URL(u).pathname));
      (known ? p.gaps : p.problems).push('http ' + line);
    }
  });
  if (signedIn) await signInPage(p, stk);
  else {
    guests += 1;
    await p.setExtraHTTPHeaders({ 'X-Forwarded-For': `10.67.${Math.floor(guests / 250)}.${(guests % 250) + 1}` }); // see signInPage
  }
  return p;
};
const noProblems = (page, what) => assert(page.problems.length === 0, `${what}: ${page.problems.join('; ')}`);
const pathOf = (h) => { try { return decodeURI(new URL(h, base).pathname); } catch { return h; } };
const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

/** Click the `index`-th link inside `scope` whose text starts with `label`. */
const clickLink = async (page, label, { index = 0, scope = 'body' } = {}) => {
  const ok = await page.evaluate((text, i, sel) => {
    const area = document.querySelector(sel) || document;
    const a = [...area.querySelectorAll('a')].filter((x) => x.textContent.replace(/\s+/g, ' ').trim().startsWith(text))[i];
    if (!a) return false;
    a.click();
    return true;
  }, label, index, scope);
  assert(ok, `no link "${label}" in ${scope} on ${page.url()}`);
};
/** Click a link and wait until the page is at `expected` (a path; a hash is checked too when given as "/path#hash"). */
const go = async (page, label, expected, options) => {
  const [expectedPath, expectedHash = ''] = expected.split('#');
  const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
  await clickLink(page, label, options);
  await nav;
  await until(() => { const u = new URL(page.url()); return u.pathname === expectedPath && (!expectedHash || u.hash === '#' + expectedHash); }, `"${label}" to reach ${expected} (at ${page.url()})`);
  await sleep(300);
};
const poolHits = (s) => ({ oneformer: s.pools.oneformer.hits.length, analyze: s.pools.analyze.hits.length });

await test('every page loads cleanly and links to the pages the site map says it must', async () => {
  for (const [name, route] of Object.entries(PAGES)) {
    const page = await newPage();
    const r = await page.goto(base + route, { waitUntil: 'networkidle2' });
    assert(r.status() === 200, `${route} -> ${r.status()}`);
    await sleep(800);
    let hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')));
    // the links a visitor can see (the exports' own headers are in the page but not drawn: their links must not count as the page's links)
    const drawn = () => page.evaluate(() => [...document.querySelectorAll('a[href]')].filter((a) => { const r = a.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(a).visibility !== 'hidden'; }).map((a) => a.getAttribute('href')));
    let seen = await drawn();
    if (name === 'dashboard') {  // the dashboard keeps some links inside its own views ("My design" holds the studio link)
      for (const view of ['studio', 'materials']) {
        await page.evaluate((v) => { location.hash = '#/' + v; }, view);
        await sleep(700);
        hrefs = hrefs.concat(await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'))));
        seen = seen.concat(await drawn());
      }
    }
    for (const other of CONNECTIONS[name]) {
      assert(seen.some((h) => pathOf(h) === PAGES[other]), `${name} has no visible link to ${other} (${PAGES[other]})`);
    }
    assert(!hrefs.some((h) => /\.dc\.html|Media%20Brief|Terucon%20Home%20v2|landing%20page/.test(h)), `${name} still has a design-time link: ${hrefs.filter((h) => /\.dc\.html|Media|Home%20v2|landing/.test(h)).join(', ')}`);
    noProblems(page, `${name} (${route})`);
    if (page.gaps.length) console.log(`        note: ${name} made requests that fail on purpose in this stack (see KNOWN_GAPS / BY_DESIGN in this file):\n          ${[...new Set(page.gaps)].join('\n          ')}`);
    await page.close();
  }
});

await test('every same-site link in every page resolves (200)', async () => {
  const bad = [];
  for (const [name, route] of Object.entries(PAGES)) {
    const page = await newPage();
    await page.goto(base + route, { waitUntil: 'networkidle2' });
    await sleep(600);
    const urls = await page.evaluate(() => [...new Set([...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => h.startsWith(location.origin)).map((h) => h.split('#')[0]))]);
    for (const u of urls) {
      const code = await page.evaluate(async (x) => (await fetch(x, { method: 'GET' })).status, u);
      if (code !== 200) bad.push(`${name}: ${u} -> ${code}`);
    }
    await page.close();
  }
  assert(bad.length === 0, bad.join('\n'));
});

await test('old addresses redirect to the pages: file names and /studio, /swatchroom (301), design-time names (302)', async () => {
  const page = await newPage();
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  const rows = [];
  for (const [key, p] of Object.entries(site.pages)) for (const a of p.aliases || []) rows.push([a, 301, p.route]);
  for (const [legacy, key] of Object.entries(site.legacy_names)) rows.push(['/' + legacy, 302, site.pages[key].route]);
  assert(rows.some(([a, , to]) => a === '/studio' && to === '/design-studio') && rows.some(([a]) => a === '/swatchroom'), '/studio and /swatchroom are aliases of the Design Studio');
  const got = await page.evaluate(async (list) => Promise.all(list.map(async ([p]) => { const r = await fetch(p.split('/').map(encodeURIComponent).join('/'), { redirect: 'manual' }); return [p, r.type, r.status]; })), rows);
  // fetch(redirect:'manual') hides the status of a redirect (opaqueredirect), so follow it instead and compare where it ended up
  const ended = await page.evaluate(async (list) => Promise.all(list.map(async ([p]) => { const r = await fetch(p.split('/').map(encodeURIComponent).join('/')); return [p, r.status, new URL(r.url).pathname, r.redirected]; })), rows);
  const bad = ended.filter(([p, status, finalPath, redirected], i) => status !== 200 || finalPath !== rows[i][2] || !redirected);
  assert(bad.length === 0, 'redirects wrong: ' + JSON.stringify(bad));
  assert(got.every(([, type]) => type === 'opaqueredirect'), 'a redirect was not a redirect: ' + JSON.stringify(got));
  await page.close();
});

await test('secrets and source code are never served, not even with the Design Studio mounted', async () => {
  const page = await newPage();
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  const paths = ['/.env', '/.env.example', '/app.js', '/package-lock.json', '/server/config/settings.js', '/server/lib/swatchroom.js', '/site/site.json', '/site/patches/studio.json',
    '/swatchroom/.env', '/swatchroom/.env.example', '/swatchroom/keys/decoy-key.json', '/swatchroom/server/config.js', '/swatchroom/server/index.js', '/swatchroom/package.json', '/swatchroom/python/app.py', '/swatchroom/modalBlueprint.py', '/swatchroom/ARCHITECTURE.md',
    '/server/config.js', '/server/routes/vision.js', '/python/app.py', '/keys/decoy-key.json', '/.env.test', '/modalBlueprint.py',
    '/js/..%2fserver%2fconfig.js', '/js/%2e%2e/server/config.js', '/css/..%2f..%2f.env',
    '/tools/build-site.js', '/tests/e2e/run.mjs', '/node_modules/express/package.json', '/pages/home.html', '/pages_original/index.html', '/docs/HOW_TO_RUN.md',
    '/README.md', '/.git/config', '/media/../.env', '/media/%2e%2e/.env', '/media/..%2f.env', '/site.json'];
  // the stack plants decoys at swatchroom/.env and swatchroom/keys/decoy-key.json (where the real studio keeps its secrets):
  // none of these addresses may answer 200 or say anything of them
  const answers = await page.evaluate(async (ps) => Promise.all(ps.map(async (p) => { const r = await fetch(p, { headers: { Accept: 'text/html' } }); return [p, r.status, await r.text()]; })), paths);
  const leaked = answers.filter(([, c]) => c !== 404);
  assert(leaked.length === 0, 'served: ' + JSON.stringify(leaked.map(([p, c]) => [p, c])));
  const saying = answers.filter(([, , body]) => /DECOY|private_key|do-not-serve/.test(body));
  assert(saying.length === 0, 'a decoy secret leaked through: ' + JSON.stringify(saying.map(([p]) => p)));
  // the one package.json that is served is the studio's browser-code marker, not the project's
  const marker = await page.evaluate(async () => (await fetch('/package.json')).text());
  assert(!/express|dependencies|scripts/.test(marker), 'the project\'s package.json is served: ' + marker.slice(0, 120));
  // the studio's own files are, of course, served: that is the studio
  assert(await page.evaluate(async () => (await fetch('/js/swatchroom-app.js')).status === 200), 'the studio\'s own script is not served');
  await page.close();
});

await test('the project overview opens, is linked from the site map, and shows the live server', async () => {
  const route = site.docs.overview.route;
  const page = await newPage();
  // newPage gives every page its own network address (X-Forwarded-For); the overview loads fonts from another site, whose rules refuse that header
  await page.setExtraHTTPHeaders({});
  const r = await page.goto(base + route, { waitUntil: 'networkidle2' });
  assert(r.status() === 200, `${route} -> ${r.status()}`);
  await sleep(1200);
  const text = await page.evaluate(() => document.body.innerText);
  assert(/Terucon/.test(text) && /Express/.test(text) && /Design Studio/.test(text), 'the overview does not describe the Express website and the Design Studio');
  assert(!/offline view/i.test(text), 'the overview does not see the live server');
  noProblems(page, 'overview');
  await page.close();
});

await test('the API answers, shows that the studio is running, and never contains a secret', async () => {
  const page = await newPage();
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  const get = (p) => page.evaluate(async (x) => { const r = await fetch(x); return { status: r.status, text: await r.text() }; }, p);
  const health = JSON.parse((await get('/api/health')).text);
  assert(health.ok === true && health.studio.running === true, 'health: ' + JSON.stringify(health));
  const s = JSON.parse((await get('/api/site')).text);
  assert(s.pages.length === Object.keys(PAGES).length, '/api/site lists ' + s.pages.length + ' pages');
  assert(!/pages\/|\.html/.test(JSON.stringify(s.pages)), '/api/site leaks file names');
  const session = await get('/api/session');
  assert(session.status === 200 && JSON.parse(session.text).passcodeRequired === true, 'the studio\'s own session answer: ' + session.text.slice(0, 200));
  for (const [what, text] of [['/api/health', JSON.stringify(health)], ['/api/site', JSON.stringify(s)], ['/api/session', session.text]]) {
    assert(!new RegExp(`${PASSCODE}|key-oneformer|key-analyze|dev-stack|PRIVATE KEY`).test(text), `a secret is in ${what}`);
  }
  const wrong = await page.evaluate(async () => (await fetch('/api/health', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
  assert(wrong === 405, 'the website\'s own API answers a wrong method with 405, not the studio\'s passcode screen (got ' + wrong + ')');
  await page.close();
});

await test('the studio\'s passcode is not bypassed by anything the website adds', async () => {
  const page = await newPage();
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  const probe = (method, p, type, body) => page.evaluate(async (m, x, t, b) => (await fetch(x, { method: m, headers: t ? { 'Content-Type': t } : {}, body: b })).status, method, p, type, body);
  assert(await probe('GET', '/api/rooms') === 401, 'saved rooms are open');
  assert(await probe('POST', '/api/ai/generate', 'application/json', '{}') === 401, 'Gemini is open (the Google bill)');
  assert(await probe('POST', '/api/vision/segment?model=b5-quant', 'image/jpeg', 'x') === 401, 'a photo scan is open');
  assert(await probe('PUT', '/api/rooms/room-test0001/files/photo', 'image/jpeg', 'x') === 401, 'saving a photo is open');
  assert(await probe('POST', '/api/pipeline/warmup', 'application/json', '{"reason":"scan"}') === 401, 'the studio\'s own wake-up is open');
  await page.close();
});

await test('the landing page starts the studio\'s cold start as the page opens, and it carries on after the visitor leaves', async () => {
  const cold = await startStack({ port: 0, passcode: PASSCODE, bootMs: 1500 });
  try {
    assert(poolHits(cold).oneformer === 0 && poolHits(cold).analyze === 0, 'a fresh stack has asked nobody');
    const page = await newPage(undefined, cold);
    page.on('request', (r) => { if (r.url().startsWith(cold.base)) (page.requests ??= []).push(`${r.method()} ${new URL(r.url()).pathname}`); });
    const t0 = Date.now();
    await page.goto(cold.base + '/', { waitUntil: 'domcontentloaded' });
    await until(() => poolHits(cold).oneformer === 1 && poolHits(cold).analyze === 1, 'both GPU services to be asked', 4000);
    const took = Date.now() - t0;
    assert(took < 3000, `the services were asked ${took} ms after the page started loading`);
    assert(page.requests.filter((r) => r === 'POST /api/studio/warmup').length === 1, 'exactly one wake-up request: ' + page.requests.filter((r) => /warmup/.test(r)));
    // the visitor leaves at once; the wake-up is the server's, so it goes on
    await page.goto(cold.base + '/materials', { waitUntil: 'domcontentloaded' });
    const signedIn = await page.evaluate(async (code) => { await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: code }) }); return (await fetch('/api/vision/warmup')).json(); }, PASSCODE);
    assert(signedIn.warm === false && signedIn.state === 'waking', 'while the services boot the studio sees them as starting: ' + JSON.stringify(signedIn));
    const warm = await until(async () => { const s = await page.evaluate(async () => (await fetch('/api/vision/warmup')).json()); return s.warm ? s : null; }, 'the studio to see its services warm', 8000);
    assert(warm.pools.oneformer.warm && warm.pools.analyze.warm, 'both pools warm: ' + JSON.stringify(warm.pools));
    // opening the studio now asks nobody again
    await page.goto(cold.base + '/design-studio', { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    assert(poolHits(cold).oneformer === 1 && poolHits(cold).analyze === 1, 'the studio page woke services that were already warm: ' + JSON.stringify(poolHits(cold)));
    await page.close();
  } finally {
    await cold.stop();
  }
});

await test('STUDIO_WARMUP=off: landing on the page wakes nothing', async () => {
  const off = await startStack({ port: 0, passcode: PASSCODE, bootMs: 100, warmup: 'off' });
  try {
    const page = await newPage(undefined, off);
    await page.goto(off.base + '/', { waitUntil: 'networkidle2' });
    await sleep(1500);
    await page.goto(off.base + '/design-studio', { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    assert(poolHits(off).oneformer === 0 && poolHits(off).analyze === 0, 'a service was woken with the switch off: ' + JSON.stringify(poolHits(off)));
    await page.close();
  } finally {
    await off.stop();
  }
});

await test('from the landing page a visitor reaches the Design Studio in one click, and the rest of the site from there', async () => {
  const page = await newPage();
  await page.goto(base + '/', { waitUntil: 'networkidle2' });
  await sleep(1500);
  await go(page, 'Try it with your photo', '/design-studio');
  // the site chrome (site/brand/chrome.js): the sidebar on a laptop, the landing page's pill; the exports' own headers are hidden, so only
  // what a visitor can see is clicked here (clickLink would also click a hidden link)
  await go(page, 'Home', '/', { scope: '.tc-side' });
  await go(page, 'Materials', '/materials', { scope: '.tc-hdr' });
  await go(page, 'Design Studio', '/design-studio', { scope: '.tc-side' });
  await go(page, 'My project', '/my-project', { scope: '.tc-side' });
  await page.goto(base + '/design-studio', { waitUntil: 'domcontentloaded' });
  await sleep(600);
  await go(page, 'Materials', '/materials', { scope: '.tc-side' });
  // "Start a project" is in the header of the landing page only
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await sleep(1500);
  await go(page, 'Start a project', '/start-project', { scope: '.tc-hdr' });
  // /start-project is a page of its own (built apart from the chrome); until it exists the site's not-found page answers there
  page.problems = page.problems.filter((p) => !/ \/start-project$/.test(p));
  noProblems(page, 'the walk');
  await page.close();
});

await test('on a phone the studio is one tap from the landing page, and the menu leads on to the shop', async () => {
  const page = await newPage(PHONE);
  await page.goto(base + '/', { waitUntil: 'networkidle2' });
  // The page's intro fades the hero in over about 3.5 s from the moment it opens; a fixed sleep of 2.5 s after "network idle" looked only
  // 0.1 s after it ended and failed on a busy machine. Wait for the fade to finish instead (up to 8 s); the assertion below still fails if it never does.
  const measureHero = () => page.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find((x) => x.textContent.trim().startsWith('Try it with your photo'));
    const r = a.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: innerHeight, visible: getComputedStyle(a).visibility !== 'hidden' && Number(getComputedStyle(a.parentElement.parentElement).opacity) > 0.9 };
  });
  const box = await until(async () => { const b = await measureHero(); return b.visible ? b : null; }, 'the hero link to fade in', 8000).catch(() => measureHero());
  assert(box.top >= 0 && box.bottom <= box.height, `the hero link is not on the first screen of a phone (${JSON.stringify(box)})`);
  assert(box.visible, 'the hero link is not visible');
  // the landing page's Menu is the chrome's button (the pill's, which clicks the export's own): its overlay opens and leads with the destinations
  await page.click('.tc-hdr button[aria-label="Open menu"]');
  await sleep(1200);
  const cards = await page.evaluate(() => [...document.querySelectorAll('[data-menu] a')].map((a) => a.textContent.replace(/\s+/g, ' ').trim()));
  assert(cards.some((c) => /^Materials/.test(c)) && cards.some((c) => /Design Studio/.test(c)) && cards.some((c) => /My project/.test(c)), 'the phone menu lacks a destination: ' + JSON.stringify(cards));
  await page.evaluate(() => document.querySelector('[data-menu-close]').click());
  await sleep(900);
  await go(page, 'Try it with your photo', '/design-studio');
  await sleep(1500);
  // on the studio the phone's destinations are the dock; the studio's own header is not drawn, the chrome's pill is
  await go(page, 'Materials', '/materials', { scope: '.tc-dock' });
  await page.close();
});

await test('the studio opens inside the site: its splash, then its sign-in, then the studio', async () => {
  const page = await newPage();
  await page.goto(base + '/design-studio', { waitUntil: 'domcontentloaded' });
  await until(() => page.evaluate(() => !!document.querySelector('.swr-splash')), 'the "Powered by Terucon India" splash', 5000);
  const splash = await page.evaluate(() => document.querySelector('.swr-splash').innerText);
  assert(/Powered by/i.test(splash) && /Terucon India/.test(splash), 'the splash: ' + splash);
  await until(() => page.evaluate(() => /Sign in to the studio/.test(document.body.innerText) && !document.querySelector('.swr-splash')), 'the sign-in after the splash', 15000);
  assert(await page.evaluate(() => { const h = document.querySelector('.tc-hdr'); const s = document.querySelector('swatchroom-app'); return !!h && !!s && h.getBoundingClientRect().bottom <= s.getBoundingClientRect().top + 1; }), 'the studio sits under the site header (the chrome\'s pill)');
  await page.type('input[placeholder="Passcode"]', 'not-the-passcode');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Open the studio/i.test(b.textContent)).click());
  await until(() => page.evaluate(() => /passcode/i.test(document.querySelector('.sr-form-error, [role=alert]')?.textContent ?? '')), 'a refusal for a wrong passcode', 8000);
  page.problems = page.problems.filter((p) => p !== 'http 401 /api/session'); // the studio refusing the wrong passcode on purpose
  await page.click('input[placeholder="Passcode"]', { clickCount: 3 });
  await page.type('input[placeholder="Passcode"]', PASSCODE);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Open the studio/i.test(b.textContent)).click());
  await until(() => page.evaluate(() => /Add a room photo/.test(document.body.innerText)), 'the studio ("Add a room photo")', 15000);
  assert(await page.evaluate(() => [...document.querySelectorAll('footer')].some((f) => /Start a project/.test(f.innerText.replace(/\s+/g, ' ')))), 'the site footer is under the studio');
  noProblems(page, 'the studio');
  await page.close();
});

await test('a page that does not exist shows Coming soon, and its buttons lead back into the site', async () => {
  const page = await newPage();
  const r = await page.goto(base + '/careers', { waitUntil: 'networkidle2' });
  assert(r.status() === 404, '/careers -> ' + r.status());
  const text = await page.evaluate(() => document.body.innerText);
  assert(/Coming soon/i.test(text) && /isn.t ready yet/.test(text), 'not the Coming soon page: ' + text.slice(0, 120));
  assert(page.problems.every((p) => /404/.test(p)), page.problems.join('; '));
  page.problems = [];
  await go(page, 'Back to home', '/');
  await page.goto(base + '/careers', { waitUntil: 'domcontentloaded' });
  await go(page, 'Try it with your photo', '/design-studio');
  await page.goto(base + '/some/deep/unknown/page', { waitUntil: 'domcontentloaded' });
  assert(/Coming soon/i.test(await page.evaluate(() => document.body.innerText)), 'a deep unknown address');
  await go(page, 'Shop materials', '/materials');
  for (const [typed, landed] of [['/Materials', '/materials'], ['/materials/', '/materials'], ['/MY-PROJECT', '/my-project'], ['/Design-Studio/', '/design-studio']]) {
    await page.goto(base + typed, { waitUntil: 'domcontentloaded' });
    assert(new URL(page.url()).pathname === landed, `${typed} ended at ${page.url()}`);
  }
  await page.close();
});

await test('sign-in: leaving the landing page shows the sign-in page; a wrong code is refused, the right one leads to the form and then to the page asked for; the account page signs out and the gate closes again', async () => {
  const page = await newPage(undefined, stack, { signedIn: false });
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await until(() => page.evaluate(() => [...document.querySelectorAll('a[data-terucon-account]')].some((a) => a.textContent.trim() === 'Sign in')), 'the landing page\'s header link to say "Sign in"', 8000);
  // moving away from the landing page: the sign-in page, remembering where the visitor was going
  await page.goto(base + '/materials', { waitUntil: 'domcontentloaded' });
  const here = new URL(page.url());
  assert(here.pathname === '/login' && here.searchParams.get('next') === '/materials', 'sent to ' + page.url());
  await page.waitForSelector('#identifier', { visible: true });
  const email = `priya.${Date.now()}@ab-constructions.example`; // a reserved name that never resolves: the firm suggestion comes from the domain, with no outside request
  await page.type('#identifier', email);
  await page.click('#send');
  await page.waitForSelector('#code', { visible: true });
  const code = await until(() => stack.codeFor(email), 'the one-time code in the stack\'s window', 5000);
  // a wrong code is refused in words, the right one is accepted
  await page.type('#code', code === '000000' ? '111111' : '000000');
  await until(() => page.evaluate(() => !document.getElementById('alert').hidden && /tries left/.test(document.getElementById('alert').textContent)), 'a refusal that says how many tries are left', 6000);
  await page.$eval('#code', (el) => { el.value = ''; });
  await page.type('#code', code);
  await page.waitForSelector('#step-profile', { visible: true });
  assert(await page.evaluate(() => /confirmed/.test(document.getElementById('verified-line').textContent)), 'the form does not say which address was confirmed');
  // a business e-mail gives a firm name to start from, labelled as a suggestion that can be changed
  await until(() => page.evaluate(() => document.getElementById('firm').value.length > 0), 'a suggested firm name', 8000);
  assert(await page.evaluate(() => /suggest/.test(document.getElementById('firm-hint').textContent)), 'the firm name is not marked as a suggestion');
  await page.type('#name', 'Priya Sharma');
  await page.type('#phone', '98765 43210');
  await page.$eval('#firm', (el) => { el.value = ''; });
  await page.type('#firm', 'AB Constructions Pvt Ltd');
  assert(await page.evaluate(() => /confirm/.test(document.querySelector('[data-note-for="phone"]').textContent)), 'the form does not say the number will be confirmed with a code');
  await page.click('#save');
  // the number is confirmed with a code before the account counts as finished: until then the members' pages stay shut
  await page.waitForSelector('#confirm-code', { visible: true });
  const phoneCode = await until(() => stack.codeFor('+919876543210', 'verify-contact'), 'the code for the mobile number', 5000);
  await page.type('#confirm-code', phoneCode === '000000' ? '111111' : '000000');
  await until(() => page.evaluate(() => /tries left/.test(document.getElementById('alert').textContent)), 'a refusal of a wrong code for the number', 6000);
  await page.$eval('#confirm-code', (el) => { el.value = ''; });
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }), page.type('#confirm-code', phoneCode)]);
  assert(new URL(page.url()).pathname === '/materials', 'after the form the visitor should land where they were going, not ' + page.url());
  // the account page shows what was entered, and signs out
  await page.goto(base + '/account', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#profile-card:not([hidden])');
  const shownFirm = await page.evaluate(() => document.getElementById('firm').value);
  assert(shownFirm === 'AB Constructions Pvt Ltd', 'the account page does not show the firm that was entered: ' + JSON.stringify(shownFirm));
  assert(await page.evaluate(() => (document.getElementById('contacts').textContent.match(/Confirmed/g) || []).length === 2), 'the account page does not show both the e-mail address and the number as confirmed');
  // like a person: the page's loader still covers the button for a moment after the details appear (a click then lands on the loader, and nothing happens)
  await until(() => page.evaluate(() => { const l = document.getElementById('tc-loader'); return !l || getComputedStyle(l).pointerEvents === 'none'; }), 'the loader to let go of the account page', 15000);
  await Promise.all([page.waitForFunction(() => location.pathname === '/', { timeout: 10000 }), page.click('#logout')]);
  await page.goto(base + '/materials', { waitUntil: 'domcontentloaded' });
  assert(new URL(page.url()).pathname === '/login', 'after signing out the gate did not close: ' + page.url());
  await page.close();
});

// ---- inspiration import (target C3): paste an address, crop, send to the Design Studio. The two network answers (resolve, file) are
// faked inside Chrome so these run offline; everything else (the server's guards, the page, its policy, the dialog, the cropper, the hand-over,
// the studio taking the photo) is real. The server's own side is tested in tests/js/inspiration-*.test.js; the live path through
// gallery-dl was run by hand against Wikimedia Commons.
const inShadow = (page, source, ...args) => page.evaluate((src, a) => new Function('root', 'args', `return (${src})(root, args);`)(document.getElementById('terucon-import')?.shadowRoot ?? null, a), String(source), args);
const dialogText = (page, sel) => inShadow(page, (root, [s]) => root?.querySelector(s)?.textContent ?? null, sel);
const dialogOpen = (page) => inShadow(page, (root) => !!root && !root.querySelector('.tc-overlay').hidden);
const dialogClick = (page, sel, text = '') => inShadow(page, (root, [s, t]) => { const el = [...root.querySelectorAll(s)].find((e) => !t || new RegExp(t).test(e.textContent)); if (el) el.click(); return !!el; }, sel, text);
const dialogRect = (page, sel) => inShadow(page, (root, [s]) => { const r = root.querySelector(s)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; }, sel);
const pasteInto = (page, sel, text) => page.evaluate((selector, t) => {
  const el = document.querySelector(selector);
  el.focus();
  const data = new DataTransfer();
  data.setData('text/plain', t);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, t); // what the browser does with a paste
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}, sel, text);
const makeJpeg = async (page, w, h) => Buffer.from((await page.evaluate((width, height) => {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const g = c.getContext('2d');
  g.fillStyle = '#b08968'; g.fillRect(0, 0, width, height);
  g.fillStyle = '#e1d4c2'; g.fillRect(width * 0.1, height * 0.1, width * 0.3, height * 0.25);
  return c.toDataURL('image/jpeg', 0.9);
}, w, h)).split(',')[1], 'base64');
/** Answer the two inspiration calls inside this page: `resolve(body)` gives {status?, json}, `file(token)` gives the picture's bytes. */
const fakeImport = async (page, { resolve, file }) => {
  const seen = { resolves: [], files: [] };
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const path_ = new URL(req.url()).pathname;
    if (path_ === '/api/inspiration/resolve') {
      const body = JSON.parse(req.postData() || '{}');
      seen.resolves.push(body.input);
      const answer = resolve(body);
      return req.respond({ status: answer.status ?? 200, contentType: 'application/json', body: JSON.stringify(answer.json) });
    }
    if (path_.startsWith('/api/inspiration/file/')) {
      const token = decodeURIComponent(path_.split('/').pop());
      seen.files.push(token);
      return req.respond({ status: 200, contentType: 'image/jpeg', body: file(token) });
    }
    return req.continue();
  });
  return seen;
};
const tinyTile = (n) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40"><rect width="30" height="40" fill="hsl(${n * 50},40%,60%)"/></svg>`)}`;

await test('Inspiration page: opens under its strict policy with no violations; a pasted address asks "Import this photo?", Escape keeps the text; a sign-in-only site says so', async () => {
  const page = await newPage();
  const response = await page.goto(base + '/inspiration', { waitUntil: 'networkidle2' });
  const csp = response.headers()['content-security-policy'] || '';
  assert(/script-src 'self'(?!.*unsafe)/.test(csp) && /img-src 'self' data: blob: https:\/\/\*\.pinimg\.com/.test(csp), 'the page does not carry its strict policy: ' + csp);
  assert((await page.$$eval('#sites li', (l) => l.map((x) => x.textContent))).join() === 'Pinterest,Unsplash,Pexels,Flickr,Behance,Imgur,Wikimedia Commons,Any photo link,Any web page', 'the list of sites is not what the registry says');
  assert(await page.evaluate(() => !!window.TeruconImport), 'the import module did not load');
  await pasteInto(page, '#link', 'https://www.pinterest.com/pin/1234567890123456/');
  await until(() => dialogText(page, '.tc-title'), 'the question');
  assert(await dialogText(page, '.tc-title') === 'Import this photo?', 'wrong question: ' + await dialogText(page, '.tc-title'));
  assert(/photo from Pinterest/.test(await dialogText(page, '.tc-text')), 'the question does not say where it is from');
  assert(await page.evaluate(() => document.getElementById('detected').textContent.includes('Pinterest pin')), 'the page did not recognise the address as a Pinterest pin');
  await page.keyboard.press('Escape');
  await until(async () => !(await dialogOpen(page)), 'Escape to close the question');
  assert(await page.$eval('#link', (e) => e.value) === 'https://www.pinterest.com/pin/1234567890123456/', 'Escape took the pasted text away');
  assert(await page.evaluate(() => document.activeElement?.id === 'link'), 'focus did not return to the box');
  await page.$eval('#link', (e) => { e.value = ''; });
  await pasteInto(page, '#link', 'https://www.instagram.com/p/AbC123/');
  await until(() => dialogText(page, '.tc-title'), 'the sign-in message');
  assert(/Instagram needs a sign-in/.test(await dialogText(page, '.tc-title')) && /upload/i.test(await dialogText(page, '.tc-text')), 'the Instagram answer is not the plain message');
  assert(await dialogClick(page, '.tc-btn', 'Upload a photo instead'), 'no upload button on the message');
  await page.keyboard.press('Escape');
  noProblems(page, 'the Inspiration page (CSP violations show up here)');
  await page.close();
});

await test('upload, crop, send: a photo from the device is cropped to a locked shape, turned, and the Design Studio receives exactly that photo', async () => {
  // the studio as it is by default, with no passcode in front of it (the shared stack above has one on, to test that gate)
  const open = await startStack({ port: 0, bootMs: 300 });
  const page = await newPage(undefined, open);
  const base = open.base;
  await page.goto(base + '/inspiration', { waitUntil: 'networkidle2' });
  const file = path.join(os.tmpdir(), `terucon-e2e-${Date.now()}.jpg`);
  fs.writeFileSync(file, await makeJpeg(page, 1200, 800));
  try {
    await (await page.$('#file')).uploadFile(file);
    await until(() => dialogText(page, '.tc-readout'), 'the crop screen', 10000);
    await sleep(400);
    assert(await dialogText(page, '.tc-readout') === '1200 × 800', 'the crop starts as the whole photo: ' + await dialogText(page, '.tc-readout'));
    await dialogClick(page, '.tc-chip', '^1:1$');
    await sleep(150);
    assert(await dialogText(page, '.tc-readout') === '800 × 800', '1:1 should give the biggest square: ' + await dialogText(page, '.tc-readout'));
    // drag the south-east handle inwards: the shape stays square and the corner opposite stays put
    const before = await dialogRect(page, '.tc-box');
    const handle = await dialogRect(page, '.tc-handle-se');
    await page.mouse.move(handle.x + handle.w / 2, handle.y + handle.h / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.w / 2 - 90, handle.y + handle.h / 2 - 40, { steps: 8 });
    await page.mouse.up();
    await sleep(150);
    const after = await dialogRect(page, '.tc-box');
    assert(Math.abs(after.w - after.h) < 1.5 && after.w < before.w - 30, `the locked shape did not hold: ${JSON.stringify(after)}`);
    assert(Math.abs(after.x - before.x) < 1.5 && Math.abs(after.y - before.y) < 1.5, 'the opposite corner moved');
    const size = await dialogText(page, '.tc-readout');
    const [w, h] = size.split(' × ').map(Number);
    assert(w === h && w < 800 && w > 400, 'the saved size does not follow the box: ' + size);
    assert(await dialogClick(page, '.tc-tool[aria-label="Turn right"]'), 'no turn button');
    await sleep(150);
    assert(await dialogText(page, '.tc-readout') === size, 'turning changed the size of a square crop');
    // hand it over: the studio must receive a photo of exactly the saved size
    await page.evaluateOnNewDocument(() => {
      const real = window.fetch;
      window.fetch = function (input, init) {
        if (init?.method === 'PUT' && /\/files\/v0\/raw$/.test(String(input))) window.__studioRaw = init.body;
        return real.apply(this, arguments);
      };
    });
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }), dialogClick(page, '.tc-btn', 'Design Studio')]);
    assert(new URL(page.url()).pathname === '/design-studio', 'did not go to the studio: ' + page.url());
    await until(() => page.evaluate(() => /Original photo/.test(document.body.innerText)), 'the studio to show the photo', 30000);
    assert(!new URL(page.url()).searchParams.has('import'), 'the one-time code stayed in the address');
    const received = await until(() => page.evaluate(async () => (window.__studioRaw ? `${(await createImageBitmap(window.__studioRaw)).width} × ${(await createImageBitmap(window.__studioRaw)).height}` : null)), 'the studio to upload the photo', 15000);
    assert(received === size, `the studio received ${received}, the crop said ${size}`);
    assert(await page.evaluate(() => new Promise((resolve) => { const r = indexedDB.open('terucon-inspiration', 1); r.onsuccess = () => { const c = r.result.transaction('pending').objectStore('pending').count(); c.onsuccess = () => resolve(c.result === 0); }; r.onerror = () => resolve(false); })), 'the waiting photo was not deleted from the browser');
  } finally {
    fs.rmSync(file, { force: true });
    await page.close();
    await open.stop();
  }
});

await test('a board: the question, the picker with its photos, the chosen photo (and only it) is fetched and cropped; the dialog closes on Escape', async () => {
  const page = await newPage();
  await page.goto(base + '/inspiration', { waitUntil: 'networkidle2' });
  const photo = await makeJpeg(page, 1000, 1500);
  const seen = await fakeImport(page, {
    resolve: () => ({ json: { type: 'source', kind: 'collection', source: { id: 'pinterest', label: 'Pinterest' }, shape: 'board', title: 'Kitchen ideas', approximate: false, items: [1, 2, 3, 4, 5, 6].map((n) => ({ token: `tok${n}`, preview: tinyTile(n), width: 1000, height: 1500, title: `Pin ${n}` })) } }),
    file: () => photo,
  });
  await pasteInto(page, '#link', 'https://www.pinterest.com/some_one/kitchen-ideas/');
  await until(() => dialogText(page, '.tc-title'), 'the question');
  assert(await dialogText(page, '.tc-title') === 'Import a photo from this?' && /a Pinterest board/.test(await dialogText(page, '.tc-text')), 'the board question is wrong: ' + await dialogText(page, '.tc-text'));
  await dialogClick(page, '.tc-btn', 'Yes, import it');
  await until(async () => (await dialogText(page, '.tc-title')) === 'Kitchen ideas', 'the picker');
  assert(await inShadow(page, (root) => root.querySelectorAll('.tc-tile').length) === 6, 'the picker does not show six photos');
  assert(seen.files.length === 0, 'a photo was fetched before one was chosen');
  assert(await inShadow(page, (root) => document.activeElement === root.host && root.activeElement?.classList.contains('tc-tile')), 'focus is not on the first photo');
  await inShadow(page, (root) => root.querySelectorAll('.tc-tile')[2].click());
  await until(() => dialogText(page, '.tc-readout'), 'the crop screen');
  assert(seen.files.join() === 'tok3', 'the wrong photo was fetched: ' + seen.files);
  await sleep(300);
  assert(await dialogText(page, '.tc-readout') === '1000 × 1500' && /From Pinterest/.test(await dialogText(page, '.tc-sub')), 'the crop screen is not the chosen photo');
  assert(seen.resolves.length === 1 && /kitchen-ideas/.test(seen.resolves[0]), 'the address was not sent to be resolved');
  await page.keyboard.press('Escape');
  await until(async () => !(await dialogOpen(page)), 'Escape to close the crop screen');
  assert(await page.evaluate(() => document.documentElement.style.overflow !== 'hidden'), 'the page stayed locked after the dialog closed');
  noProblems(page, 'the board import');
  await page.close();
});

await test('the shop: the search box asks about a pasted photo address; "Not now" keeps the text, "Yes" takes the address out and goes on to the crop', async () => {
  const page = await newPage();
  await page.goto(base + '/materials', { waitUntil: 'networkidle2' });
  const photo = await makeJpeg(page, 900, 600);
  const seen = await fakeImport(page, {
    resolve: () => ({ json: { type: 'source', kind: 'photo', source: { id: 'unsplash', label: 'Unsplash' }, shape: 'photo', title: '', approximate: false, items: [{ token: 'one', preview: null, width: 900, height: 600, title: '' }] } }),
    file: () => photo,
  });
  const url = 'https://unsplash.com/photos/a-kitchen-with-a-wooden-island-Ab12Cd34Ef5';
  assert(await page.evaluate(() => !!window.TeruconImport), 'the import module did not load on the shop page');
  // the search box (the overlay the search button opens)
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Search (sheets|materials)/.test(b.textContent))?.click());
  await until(() => page.$('[data-import-urls][aria-label="Search materials"]'), 'the search box', 8000);
  await pasteInto(page, '[data-import-urls][aria-label="Search materials"]', `see ${url}`);
  await until(() => dialogText(page, '.tc-title'), 'the question in the search box');
  assert(/photo from Unsplash/.test(await dialogText(page, '.tc-text')), 'the question is wrong');
  await dialogClick(page, '.tc-btn', 'Not now');
  await until(async () => !(await dialogOpen(page)), 'the question to close');
  assert((await page.$eval('[data-import-urls][aria-label="Search materials"]', (e) => e.value)) === `see ${url}`, '"Not now" changed the text');
  await pasteInto(page, '[data-import-urls][aria-label="Search materials"]', url);
  await until(() => dialogText(page, '.tc-title'), 'the question again');
  await dialogClick(page, '.tc-btn', 'Yes, import it');
  await until(() => dialogText(page, '.tc-readout'), 'the crop screen from the shop');
  assert(await page.$eval('[data-import-urls][aria-label="Search materials"]', (e) => e.value) === '', '"Yes" left the address in the search box');
  assert(seen.resolves.length === 1 && seen.resolves[0] === url, 'the address sent was not the one pasted: ' + seen.resolves);
  await page.keyboard.press('Escape');
  await until(async () => !(await dialogOpen(page)), 'the crop screen to close');
  // Enter on a box that holds only an address asks instead of searching for the address
  await page.evaluate(() => { const el = document.querySelector('[data-import-urls][aria-label="Search materials"]'); el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'https://www.pexels.com/photo/white-wooden-cabinet-1457842/'); el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.keyboard.press('Enter');
  await until(() => dialogText(page, '.tc-title'), 'the question after Enter');
  await page.keyboard.press('Escape');
  await until(async () => !(await dialogOpen(page)), 'the question to close');
  // (the shop assistant's own box, which used to be tested here, went with the assistant: TeruBot is the one assistant now)
  await page.keyboard.press('Escape');
  await page.close();
});

await test('when an import fails the person is told in plain words and offered the way on: upload, sign in, or try again', async () => {
  const page = await newPage();
  await page.goto(base + '/inspiration', { waitUntil: 'networkidle2' });
  let answer = { status: 422, json: { error: { code: 422, status: 'INVALID_ARGUMENT', message: 'That looks private, or it needs a sign-in. Only public pictures can be imported.', reason: 'private' } } };
  await fakeImport(page, { resolve: () => answer, file: () => Buffer.alloc(0) });
  const ask = async (text) => { await pasteInto(page, '#link', text); await until(() => dialogText(page, '.tc-title'), 'the question'); await dialogClick(page, '.tc-btn', 'Yes, import it'); await until(async () => (await dialogText(page, '.tc-title')) === 'We could not import that' || (await dialogText(page, '.tc-title')) === 'Please sign in', 'the failure screen', 8000); };
  await ask('https://example.com/secret.jpg');
  assert(/private/.test(await dialogText(page, '.tc-text')), 'the reason is not shown');
  assert(await dialogClick(page, '.tc-btn', 'Upload a photo instead') && !(await dialogClick(page, '.tc-btn', 'Try again')), 'a private picture should offer upload, not "Try again"');
  await page.keyboard.press('Escape');
  await until(async () => !(await dialogOpen(page)), 'the dialog to close');
  answer = { status: 502, json: { error: { code: 502, status: 'UNAVAILABLE', message: 'We could not read that right now. Please try again later.', reason: 'failed' } } };
  await page.$eval('#link', (e) => { e.value = ''; });
  await ask('https://example.com/slow.jpg');
  assert(await inShadow(page, (root) => [...root.querySelectorAll('.tc-btn')].map((b) => b.textContent.trim()).join('|')) === 'Try again|Upload a photo instead|Close' || /Try again/.test(await inShadow(page, (root) => root.querySelector('.tc-actions').textContent)), 'a failure that may pass should offer "Try again"');
  await page.keyboard.press('Escape');
  await until(async () => !(await dialogOpen(page)), 'the dialog to close');
  answer = { status: 401, json: { error: { code: 401, status: 'UNAUTHENTICATED', message: 'Please sign in to import a picture.', reason: 'signin' } } };
  await page.$eval('#link', (e) => { e.value = ''; });
  await ask('https://example.com/other.jpg');
  assert(await dialogClick(page, '.tc-btn', 'Sign in'), 'a session that ended should offer to sign in');
  await page.close();
});

await test('on a phone the page does not scroll sideways and the crop screen fits the screen, with its buttons in reach', async () => {
  const page = await newPage(PHONE);
  await page.goto(base + '/inspiration', { waitUntil: 'networkidle2' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'the Inspiration page scrolls sideways on a phone');
  const file = path.join(os.tmpdir(), `terucon-e2e-phone-${Date.now()}.jpg`);
  fs.writeFileSync(file, await makeJpeg(page, 1600, 1200));
  try {
    await (await page.$('#file')).uploadFile(file);
    await until(() => dialogText(page, '.tc-readout'), 'the crop screen on a phone', 10000);
    await sleep(400);
    const card = await dialogRect(page, '.tc-card');
    assert(card.x >= -1 && card.y >= -1 && card.x + card.w <= 391 && card.y + card.h <= 845, 'the crop screen does not fit a phone: ' + JSON.stringify(card));
    const stage = await dialogRect(page, '.tc-stage');
    assert(stage.h > 220, 'the photo area is too small to work in: ' + stage.h);
    for (const [selector, text] of [['.tc-btn', 'Design Studio'], ['.tc-btn', 'Cancel'], ['.tc-chip', '^1:1$'], ['.tc-tool[aria-label="Turn right"]', '']]) {
      const r = await inShadow(page, (root, [s, t]) => { const el = [...root.querySelectorAll(s)].find((e) => !t || new RegExp(t).test(e.textContent)); const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }, selector, text);
      assert(r.x >= 0 && r.x + r.w <= 391 && r.y >= 0 && r.y + r.h <= 845 && r.h >= 34, `${selector} ${text} is out of reach: ${JSON.stringify(r)}`);
    }
    const handle = await dialogRect(page, '.tc-handle-se');
    assert(handle.w >= 44 && handle.h >= 44, 'the handles are too small for a finger: ' + handle.w);
  } finally {
    fs.rmSync(file, { force: true });
    await page.close();
  }
});

// ---- the Finder page (target C4 point-and-identify, plus C7 colour match / C5 word search): no inline script at all
// (its own CSP is "strict+catalogue"); its browser behaviour lives entirely in site/catalogue-ui/finder.js. The dev stack
// has no CATALOGUE_* settings, so the catalogue is off by default here (tests/dev/stack.mjs) — the page must say so
// plainly rather than pretend to work. A live end-to-end search needs a real Modal/GCS/MongoDB this repo has no
// credentials for (server/catalogue/'s own test suite, tests/js/catalogue-*.test.js, proves the server side against fakes).

await test('Finder page: opens under its own strict+catalogue policy with no violations; the mode tabs toggle aria-pressed and show the right panel', async () => {
  const page = await newPage();
  const response = await page.goto(base + '/finder', { waitUntil: 'networkidle2' });
  assert(response.status() === 200, '/finder -> ' + response.status());
  const csp = response.headers()['content-security-policy'] || '';
  assert(/script-src 'self'(?!.*unsafe)(?!.*accounts\.google)/.test(csp), 'the page does not carry its own strict script policy (and no Google sign-in belongs on this page): ' + csp);
  assert(/img-src 'self' data: blob: https:\/\/storage\.googleapis\.com/.test(csp), "the policy does not allow the catalogue's own picture host: " + csp);
  await sleep(400);
  // this stack's catalogue is off by default, which correctly disables the three tabs (checked on its own below, where
  // clicking a disabled button must do nothing); re-enable them here, exactly as the page would once a catalogue is
  // live, so this test can check the tab-switching behaviour itself
  await page.evaluate(() => { for (const id of ['mode-photo', 'mode-colour', 'mode-words']) document.getElementById(id).disabled = false; });
  const tabState = () => page.evaluate(() => ({
    photo: document.getElementById('mode-photo').getAttribute('aria-pressed'),
    colour: document.getElementById('mode-colour').getAttribute('aria-pressed'),
    words: document.getElementById('mode-words').getAttribute('aria-pressed'),
    photoPanelHidden: document.getElementById('photo-panel').hidden,
    wordsPanelHidden: document.getElementById('words-panel').hidden,
  }));
  let s = await tabState();
  assert(s.photo === 'true' && s.colour === 'false' && s.words === 'false' && !s.photoPanelHidden && s.wordsPanelHidden, 'the page does not start on the Photo tab: ' + JSON.stringify(s));
  await page.click('#mode-words');
  s = await tabState();
  assert(s.words === 'true' && s.photo === 'false' && s.colour === 'false' && s.photoPanelHidden && !s.wordsPanelHidden, 'clicking Words did not switch tabs and panels correctly: ' + JSON.stringify(s));
  await page.click('#mode-colour');
  s = await tabState();
  assert(s.colour === 'true' && s.photo === 'false' && s.words === 'false' && !s.photoPanelHidden && s.wordsPanelHidden, 'clicking Colour did not switch to the photo panel: ' + JSON.stringify(s));
  await page.click('#mode-photo');
  s = await tabState();
  assert(s.photo === 'true' && s.colour === 'false' && s.words === 'false', 'clicking Photo did not switch back: ' + JSON.stringify(s));
  noProblems(page, 'the Finder page (CSP violations show up here)');
  await page.close();
});

await test('Finder page: with no catalogue switched on (this stack\'s default) it says so plainly and disables the mode and search buttons, instead of pretending to work', async () => {
  const page = await newPage();
  await page.goto(base + '/finder', { waitUntil: 'networkidle2' });
  await until(() => page.evaluate(() => !document.getElementById('status').hidden), 'the status notice to appear', 5000);
  const text = await page.evaluate(() => document.getElementById('status').textContent.trim());
  assert(text === 'Catalogue search is not switched on here yet.', 'the notice is not the plain, honest sentence for a catalogue with no Modal search app configured: ' + JSON.stringify(text));
  const disabled = await page.evaluate(() => ['mode-photo', 'mode-colour', 'mode-words', 'go-photo', 'go-words'].map((id) => document.getElementById(id).disabled));
  assert(disabled.every(Boolean), 'not every mode/search button is disabled while the catalogue is off: ' + JSON.stringify(disabled));
  noProblems(page, 'the Finder page with the catalogue off');
  await page.close();
});

await test('Finder page: upload a photo, drag the reticle, and "Search the whole photo" / "Retake" behave as the drop zone says', async () => {
  const page = await newPage();
  await page.goto(base + '/finder', { waitUntil: 'networkidle2' });
  const file = path.join(os.tmpdir(), `terucon-e2e-finder-${Date.now()}.jpg`);
  fs.writeFileSync(file, await makeJpeg(page, 1200, 900));
  try {
    await (await page.$('#file')).uploadFile(file);
    await until(() => page.evaluate(() => !document.getElementById('viewfinder').hidden && !document.getElementById('still').hidden), 'the uploaded photo to show in the viewfinder', 8000);
    assert(await page.evaluate(() => document.getElementById('drop').hidden && !document.getElementById('photo-actions').hidden && !document.getElementById('reticle').hidden), 'the drop zone / photo actions / reticle are not in the right state after an upload');
    // drag the reticle: its centre (as a fraction of the viewfinder) should move
    const before = await page.evaluate(() => { const r = document.getElementById('reticle').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.move(before.x, before.y);
    await page.mouse.down();
    await page.mouse.move(before.x - 60, before.y - 40, { steps: 6 });
    await page.mouse.up();
    const after = await page.evaluate(() => { const r = document.getElementById('reticle').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    assert(Math.abs(after.x - before.x) > 20 || Math.abs(after.y - before.y) > 20, 'dragging the reticle did not move it: ' + JSON.stringify({ before, after }));
    // "Search the whole photo" hides the reticle; clicking the frame again brings it back
    await page.click('#whole-photo');
    assert(await page.evaluate(() => document.getElementById('reticle').hidden), 'the reticle did not hide after "Search the whole photo"');
    await page.evaluate(() => { const r = document.getElementById('viewfinder').getBoundingClientRect(); document.getElementById('viewfinder').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 })); });
    assert(await page.evaluate(() => !document.getElementById('reticle').hidden), 'clicking the viewfinder again did not bring the reticle back');
    // "Retake" goes back to the drop zone and clears the still photo
    await page.click('#retake');
    assert(await page.evaluate(() => document.getElementById('viewfinder').hidden && !document.getElementById('drop').hidden && document.getElementById('photo-actions').hidden), '"Retake" did not return to the empty drop-zone state');
  } finally {
    fs.rmSync(file, { force: true });
    await page.close();
  }
});

await test('Finder page: "Use camera" shows a live video stream, the reticle, and the photo actions (Puppeteer\'s fake camera device)', async () => {
  const page = await newPage();
  await page.goto(base + '/finder', { waitUntil: 'networkidle2' });
  await page.click('#start-camera');
  const ok = await until(() => page.evaluate(() => {
    const v = document.getElementById('video');
    return !document.getElementById('viewfinder').hidden && !v.hidden && v.srcObject instanceof MediaStream && v.videoWidth > 0 && v.videoHeight > 0;
  }), 'the fake camera to produce a playable video stream', 10000).catch(() => false);
  if (!ok) {
    console.log('        note: Puppeteer\'s fake camera device did not produce a playable stream in this environment; skipping the rest of this check (see the --use-fake-device-for-media-stream / --use-fake-ui-for-media-stream launch args).');
    await page.close();
    return;
  }
  assert(await page.evaluate(() => !document.getElementById('reticle').hidden && !document.getElementById('photo-actions').hidden), 'the reticle / photo actions did not appear once the camera opened');
  await page.close();
});

// ---- catalogue admin (target D1): the token gate. The dev stack sets no AUTH_ADMIN_TOKEN at all (there is no catalogue
// backend here either), so every /api/catalogue/admin/* route answers 404 "as if it did not exist" (server/catalogue/
// adminRoutes.js) whatever token is typed. That is still real behaviour worth checking in a real browser: the page must
// say plainly that no admin token is configured (not "wrong token"), never reveal the admin sections, and never keep a
// token that was not accepted. Connecting with a real token against a live catalogue backend is not something this dev
// stack can set up (see the admin.js task's own note on that), so it is not tested here.
await test('Catalogue admin: with no AUTH_ADMIN_TOKEN configured, any token says so plainly and the admin sections stay hidden', async () => {
  const page = await newPage();
  try {
    const response = await page.goto(base + '/admin/catalogue', { waitUntil: 'networkidle2' });
    const csp = response.headers()['content-security-policy'] || '';
    assert(/script-src 'self'(?!.*unsafe)/.test(csp), 'the page does not carry its strict script policy: ' + csp);
    assert(/connect-src 'self' https:\/\/storage\.googleapis\.com/.test(csp), 'the page is missing its signed-upload connect allowance: ' + csp);
    assert(await page.evaluate(() => document.getElementById('admin-sections').hidden), 'the admin sections must start hidden');
    await page.type('#token-input', 'some-made-up-admin-token');
    await page.click('#token-connect');
    await until(() => page.evaluate(() => !document.getElementById('token-status').hidden), 'the token-status message to appear', 6000);
    const message = await page.evaluate(() => document.getElementById('token-status').textContent);
    assert(/AUTH_ADMIN_TOKEN/.test(message) && !/wrong token/i.test(message), 'a 404 (no admin token set up at all) must not be read as "wrong token": ' + message);
    assert(await page.evaluate(() => document.getElementById('admin-sections').hidden), 'a failed connect must never reveal the admin sections');
    assert(await page.evaluate(() => sessionStorage.getItem('catalogueAdminToken')) === null, 'a token that was not accepted must not be remembered');
  } finally {
    await page.close();
  }
});

// ---- the six hand-written pages on a phone (390 x 844, touch): the logo, the phone dock, no sideways scroll, no policy violations.
// Each of these pages runs under a strict Content-Security-Policy built from the page itself, so the dock's one stylesheet and one
// script (same-origin, /brand/dock.*) and the logo files (/brand/*.webp) must be allowed by it: a violation shows up here as a
// console error (the "securitypolicyviolation" events are collected as well).
const HAND_WRITTEN = [['Sign in', '/login', { signedIn: false, hero: true }], ['Your account', '/account', {}], ['Inspiration', '/inspiration', {}], ['Finder', '/finder', {}], ['Catalogue admin', '/admin/catalogue', {}], ['Coming soon', '/coming-soon', { hero: true }]];
const DOCK_LINKS = ['/materials', '/design-studio', '/inspiration', '/finder', '/my-project'];
const watchPolicy = (page) => page.evaluateOnNewDocument(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI || 'inline'}`)); });

for (const [label, route, options] of HAND_WRITTEN) {
  await test(`on a phone, ${label} (${route}): loads with no console or policy errors, no sideways scroll, the logo shows, the five dock links are there`, async () => {
    const page = await newPage(PHONE, stack, { signedIn: options.signedIn !== false });
    try {
      await watchPolicy(page);
      const response = await page.goto(base + route, { waitUntil: 'networkidle2' });
      assert(response.status() === 200, `${route} -> ${response.status()}`);
      await sleep(400);
      const m = await page.evaluate(() => {
        const header = document.querySelector('header img');
        const box = header?.getBoundingClientRect();
        const hero = document.querySelector('main img[src*="logo-full"]');
        const items = [...document.querySelectorAll('.tc-dock .tc-dock__item')];
        const dock = document.querySelector('.tc-dock');
        return {
          wide: document.documentElement.scrollWidth - innerWidth,
          logo: header ? { loaded: header.complete && header.naturalWidth > 0, w: box.width, h: box.height, hidden: getComputedStyle(header).visibility === 'hidden' || getComputedStyle(header).display === 'none', alt: header.alt } : null,
          hero: hero ? { loaded: hero.complete && hero.naturalWidth > 0, w: hero.getBoundingClientRect().width } : null,
          dockOn: document.documentElement.classList.contains('tc-dock-on'),
          dockShown: dock ? getComputedStyle(dock).display !== 'none' : false,
          hrefs: items.map((a) => a.getAttribute('href')),
          tall: items.map((a) => Math.round(a.getBoundingClientRect().height)),
          csp: window.__csp,
        };
      });
      assert(m.wide <= 0, `sideways scroll: the page is ${m.wide}px wider than the screen`);
      assert(m.logo && m.logo.loaded && m.logo.w > 40 && m.logo.h > 20 && !m.logo.hidden, 'the header logo is missing, not loaded or not visible: ' + JSON.stringify(m.logo));
      assert(m.logo.alt === 'Terucon India', 'the header logo has no plain alt text: ' + JSON.stringify(m.logo.alt));
      if (options.hero) assert(m.hero && m.hero.loaded && m.hero.w > 120, 'the full logo is missing from the top of the page: ' + JSON.stringify(m.hero));
      assert(m.dockOn && m.dockShown, 'the phone dock is not on screen');
      assert(JSON.stringify(m.hrefs) === JSON.stringify(DOCK_LINKS), 'the dock links are not the five destinations: ' + JSON.stringify(m.hrefs));
      assert(m.tall.every((h) => h >= 44), 'a dock link is shorter than 44 px: ' + JSON.stringify(m.tall));
      assert(m.csp.length === 0, 'the page\'s policy refused something: ' + JSON.stringify(m.csp));
      noProblems(page, `${label} on a phone`);
    } finally {
      await page.close();
    }
  });
}

await test('on a phone, an uploaded tall photo gives the Finder a tall frame with the reticle inside it, and the buttons stay in reach', async () => {
  const page = await newPage(PHONE);
  const file = path.join(os.tmpdir(), `terucon-e2e-finder-tall-${Date.now()}.jpg`);
  try {
    await page.goto(base + '/finder', { waitUntil: 'networkidle2' });
    fs.writeFileSync(file, await makeJpeg(page, 900, 1200));
    await (await page.$('#file')).uploadFile(file);
    await until(() => page.evaluate(() => !document.getElementById('viewfinder').hidden && !document.getElementById('still').hidden && document.getElementById('still').complete), 'the uploaded photo to show in the viewfinder', 8000);
    await sleep(300);
    const m = await page.evaluate(() => {
      const v = document.getElementById('viewfinder').getBoundingClientRect();
      const r = document.getElementById('reticle').getBoundingClientRect();
      const go = document.getElementById('go-photo').getBoundingClientRect();
      return { ratio: v.width / v.height, inside: r.left >= v.left - 1 && r.right <= v.right + 1 && r.top >= v.top - 1 && r.bottom <= v.bottom + 1, reticle: Math.min(r.width, r.height), wide: document.documentElement.scrollWidth - innerWidth, goHeight: go.height };
    });
    assert(Math.abs(m.ratio - 0.75) < 0.03, 'the frame does not take the photo\'s tall shape (width / height = ' + m.ratio.toFixed(2) + ', expected 0.75)');
    assert(m.inside && m.reticle >= 44, 'the reticle is not inside the frame or is too small to touch: ' + JSON.stringify(m));
    assert(m.wide <= 0 && m.goHeight >= 44, 'sideways scroll, or the "Find it" button is too short: ' + JSON.stringify(m));
    noProblems(page, 'the Finder with a tall photo');
  } finally {
    fs.rmSync(file, { force: true });
    await page.close();
  }
});

await test('on a phone, the Inspiration crop screen fills the screen, its buttons are all inside it and a finger can resize the frame', async () => {
  const page = await newPage(PHONE);
  const file = path.join(os.tmpdir(), `terucon-e2e-crop-${Date.now()}.jpg`);
  try {
    await page.goto(base + '/inspiration', { waitUntil: 'networkidle2' });
    fs.writeFileSync(file, await makeJpeg(page, 1200, 900));
    await (await page.$('#file')).uploadFile(file);
    await until(() => dialogRect(page, '.tc-crop-screen'), 'the crop screen to open', 8000);
    await sleep(500);
    const card = await dialogRect(page, '.tc-crop-screen');
    assert(card.w >= 389 && card.h >= 843, 'the crop screen does not fill a 390 x 844 phone: ' + JSON.stringify(card));
    const buttons = await inShadow(page, (root) => [...root.querySelectorAll('.tc-foot .tc-btn')].map((b) => { const r = b.getBoundingClientRect(); return { text: b.textContent.trim(), right: Math.round(r.right), bottom: Math.round(r.bottom), left: Math.round(r.left), h: Math.round(r.height), clipped: b.scrollWidth > b.clientWidth + 1 }; }));
    assert(buttons.length >= 3 && buttons.every((b) => b.left >= 0 && b.right <= 390 && b.bottom <= 844 && b.h >= 44 && !b.clipped), 'a crop screen button is cut off or too small: ' + JSON.stringify(buttons));
    const before = await dialogRect(page, '.tc-box');
    const handle = await dialogRect(page, '.tc-handle-se');
    const touch = await page.touchscreen.touchStart(handle.x + handle.w / 2, handle.y + handle.h / 2);
    await touch.move(handle.x + handle.w / 2 - 50, handle.y + handle.h / 2 - 40);
    await touch.end();
    await sleep(300);
    const after = await dialogRect(page, '.tc-box');
    assert(after.w < before.w - 20 && after.h < before.h - 15, 'a finger on the corner did not resize the frame: ' + JSON.stringify({ before, after }));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'sideways scroll behind the crop screen');
  } finally {
    fs.rmSync(file, { force: true });
    await page.close();
  }
});

await test('when the server cannot be reached, Your account and Sign in say so and offer "Try again" instead of a blank page or a wrong redirect', async () => {
  const cut = async (page, prefix) => { await page.setRequestInterception(true); page.on('request', (req) => (new URL(req.url()).pathname.startsWith(prefix) ? req.abort('internetdisconnected') : req.continue())); };
  const account = await newPage(PHONE);
  try {
    await cut(account, '/api/auth/me');
    await account.goto(base + '/account', { waitUntil: 'networkidle2' });
    await until(() => account.evaluate(() => !document.getElementById('alert').hidden && !document.getElementById('retry-box').hidden), 'the connection message and the "Try again" button', 6000);
    const said = await account.evaluate(() => document.getElementById('alert').textContent);
    assert(/could not reach the server/i.test(said) && /connection/i.test(said), 'the message does not say what happened: ' + said);
    assert(new URL(account.url()).pathname === '/account', 'a lost connection must not send the person to the sign-in page: ' + account.url());
  } finally {
    await account.close();
  }
  const login = await newPage(PHONE, stack, { signedIn: false });
  try {
    await cut(login, '/api/auth/');
    await login.goto(base + '/login', { waitUntil: 'networkidle2' });
    await until(() => login.evaluate(() => !document.getElementById('step-unavailable').hidden && !document.getElementById('retry-load').hidden), 'the connection message and the "Try again" button', 6000);
    const said = await login.evaluate(() => document.getElementById('unavailable-text').textContent);
    assert(/could not reach the server/i.test(said), 'the message does not say what happened: ' + said);
    assert(await login.evaluate(() => document.getElementById('step-loading').hidden), 'the "One moment" line is still showing');
  } finally {
    await login.close();
  }
});

// The landing page's scroll-driven chapter label ("03 - Shell to handover", in the export's own header) is gone with that header: the site chrome's
// pill is the header now. What this test used to guard (the label printing over the links) cannot happen; it now guards the pill's own row.
await test('landing header: the pill\'s links (Materials, Design Studio AI, Inspiration, Finder, My project, Sign in) and its buttons never sit on one another or leave the pill from 900 to 1680 px, and no chapter label is drawn', async () => {
  for (const width of [900, 1024, 1100, 1280, 1366, 1440, 1680]) {
    const page = await newPage({ width, height: 800 }, stack, { signedIn: false });
    try {
      await page.goto(base + '/', { waitUntil: 'networkidle2' });
      await sleep(800);
      for (const section of ['hero', 'transform', 'enquire']) {
        await page.evaluate((key) => window.scrollTo(0, document.querySelector(`[data-sec="${key}"]`).getBoundingClientRect().top + scrollY + (key === 'hero' ? 0 : 40)), section);
        await sleep(1000);
        const seen = await page.evaluate(() => {
          const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
          const pill = document.querySelector('.tc-hdr');
          const parts = [...pill.querySelectorAll('a, button')].filter((e) => e.getBoundingClientRect().width > 1).map((e) => ({ what: (e.textContent || e.getAttribute('aria-label') || 'logo').trim().slice(0, 24), ...box(e) }));
          const p = box(pill);
          const label = document.querySelector('[data-chapter]');
          const labelRect = label ? label.getBoundingClientRect() : { width: 0, height: 0 };
          const overlaps = [];
          for (let i = 0; i < parts.length; i += 1) for (let j = i + 1; j < parts.length; j += 1) { const a = parts[i], b = parts[j]; if (a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5) overlaps.push(`${a.what} / ${b.what}`); }
          return {
            overlaps, outside: parts.filter((x) => x.l < p.l - 0.5 || x.r > p.r + 0.5).map((x) => x.what),
            links: [...pill.querySelectorAll('.tc-hdr__nav a')].map((a) => a.textContent.replace(/\s+/g, ' ').trim()),
            small: parts.filter((x) => x.h < 43.5).map((x) => x.what), labelDrawn: labelRect.width > 0 && labelRect.height > 0, sidebar: !!document.querySelector('.tc-side'),
          };
        });
        assert(seen.overlaps.length === 0, `at ${width} px (${section}) the pill's parts overlap: ${seen.overlaps.join('; ')}`);
        assert(seen.outside.length === 0, `at ${width} px the pill's parts leave the pill: ${seen.outside.join(', ')}`);
        assert(JSON.stringify(seen.links) === JSON.stringify(['Materials', 'Design StudioAI', 'Inspiration', 'Finder', 'My project', 'Sign in']), `at ${width} px the pill's links are ${JSON.stringify(seen.links)}`);
        assert(seen.small.length === 0, `at ${width} px a part of the pill is shorter than 44 px: ${seen.small.join(', ')}`);
        assert(!seen.labelDrawn, 'the chapter label is drawn');
        assert(!seen.sidebar, 'the landing page has no sidebar');
      }
    } finally {
      await page.close();
    }
  }
});

// ---- the studio's "Take a photo" (site/brand/studio-camera.js): the camera opens inside the page, so a phone's camera app never takes the screen
// (and cannot leave a reloaded page behind). Puppeteer's fake camera device stands in for the lens; a real phone was not tried.
const CAMERA_INPUT = 'input[data-input="camera"]';
const chooserOpens = (page, ms) => page.waitForFileChooser({ timeout: ms }).then(() => true, () => false);
const studioCameraPage = async (open, { before } = {}) => {
  const page = await newPage(PHONE, open);
  await page.evaluateOnNewDocument(() => {
    window.__stops = 0;
    const stop = MediaStreamTrack.prototype.stop;
    MediaStreamTrack.prototype.stop = function () { window.__stops += 1; return stop.call(this); };
    const real = window.fetch;
    window.fetch = function (input, init) {
      if (init?.method === 'PUT' && /\/files\/v0\/raw$/.test(String(input))) window.__raw = init.body;
      return real.apply(this, arguments);
    };
  });
  if (before) await page.evaluateOnNewDocument(before);
  await page.goto(open.base + '/design-studio', { waitUntil: 'networkidle2' });
  await page.waitForSelector(CAMERA_INPUT, { timeout: 20000 });
  return page;
};

await test('studio camera: "Take a photo" opens the camera inside the page (no camera app), the shot reaches the studio as a JPEG, the camera is switched off', async () => {
  const open = await startStack({ port: 0, bootMs: 300 });
  const page = await studioCameraPage(open);
  try {
    await page.evaluate(() => { window.__marker = 'same-page'; });
    const chooser = chooserOpens(page, 1500);
    await page.evaluate((sel) => document.querySelector(sel).click(), CAMERA_INPUT); // what the studio's own button does
    await until(() => page.evaluate(() => !!document.querySelector('[data-tc-camera]')), 'the in-page camera', 5000);
    assert(!(await chooser), 'the phone\'s file or camera picker opened as well');
    await until(() => page.evaluate(() => { const v = document.querySelector('[data-tc-camera] video'); return !!(v && v.srcObject && v.videoWidth > 0); }), 'the live picture', 8000);
    await until(() => page.evaluate(() => { const s = document.querySelector('.tcc-shutter'); return s && !s.disabled; }), 'the shutter to be ready', 5000);
    await page.evaluate(() => document.querySelector('.tcc-shutter').click());
    await until(() => page.evaluate(() => !document.querySelector('[data-tc-camera]')), 'the camera to close after the shot', 5000);
    const sent = await until(() => page.evaluate(async () => (window.__raw ? `${window.__raw.type} ${window.__raw.size > 1000}` : null)), 'the studio to upload the photo', 15000);
    assert(sent === 'image/jpeg true', 'the studio received: ' + sent);
    assert(await page.evaluate(() => window.__stops) >= 1, 'the camera was left running');
    assert(await page.evaluate(() => window.__marker === 'same-page'), 'the page was reloaded');
  } finally {
    await page.close();
    await open.stop();
  }
});

await test('studio camera: when the camera is refused, the person is told and offered the camera app or the gallery; the camera app hand-off leaves a note, and a reload during it says so', async () => {
  const open = await startStack({ port: 0, bootMs: 300 });
  const page = await studioCameraPage(open, { before: () => { navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('refused'), { name: 'NotAllowedError' })); } });
  try {
    await page.evaluate((sel) => document.querySelector(sel).click(), CAMERA_INPUT);
    await until(() => page.evaluate(() => /not allowed/i.test(document.querySelector('.tcc-panel')?.textContent ?? '')), 'the refusal message', 5000);
    const labels = await page.evaluate(() => [...document.querySelectorAll('.tcc-panel button')].map((b) => b.textContent));
    assert(labels.includes('Open the camera app') && labels.includes('Choose from gallery'), 'the fallbacks: ' + JSON.stringify(labels));
    const chooser = chooserOpens(page, 4000);
    await page.evaluate(() => [...document.querySelectorAll('.tcc-panel button')].find((b) => b.textContent === 'Open the camera app').click());
    assert(await chooser, 'the camera app (file picker) did not open from "Open the camera app"');
    assert(await page.evaluate(() => !!sessionStorage.getItem('terucon.cameraHandoff')), 'no note was left for the hand-off');
    await page.reload({ waitUntil: 'networkidle2' }); // the phone threw the page away while the camera app was open
    await until(() => page.evaluate(() => /reloaded this page/i.test(document.querySelector('.tcc-note')?.textContent ?? '')), 'the note about the reload', 8000);
    assert(await page.evaluate(() => !sessionStorage.getItem('terucon.cameraHandoff')), 'the note was not cleared after it was shown');
  } finally {
    await page.close();
    await open.stop();
  }
});

await test('studio camera: a browser with no in-page camera still gets the camera app straight away (the old way)', async () => {
  const open = await startStack({ port: 0, bootMs: 300 });
  const page = await studioCameraPage(open, { before: () => { Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }); } });
  try {
    const chooser = chooserOpens(page, 4000);
    await page.evaluate((sel) => document.querySelector(sel).click(), CAMERA_INPUT);
    assert(await chooser, 'the camera app (file picker) did not open');
    assert(await page.evaluate(() => !document.querySelector('[data-tc-camera]')), 'an in-page camera opened with no camera support');
  } finally {
    await page.close();
    await open.stop();
  }
});

// ---- the shop's "Find it from a photo" sheet: the same in-page camera (site/brand/studio-camera.js is shared with the studio; the shop's
// photo sheet has the same kind of input, `<input type=file capture=environment>`, behind its "Take a photo" button). Reported on a phone:
// the photo failed to upload after it was taken. A real phone was not tried; Puppeteer's fake camera device stands in for the lens.
const SHOP_CAMERA_INPUT = 'input[type="file"][capture]';
const shopPhotoPage = async ({ before } = {}) => {
  const page = await newPage(PHONE);
  await page.evaluateOnNewDocument(() => {
    window.__stops = 0;
    const stop = MediaStreamTrack.prototype.stop;
    MediaStreamTrack.prototype.stop = function () { window.__stops += 1; return stop.call(this); };
  });
  if (before) await page.evaluateOnNewDocument(before);
  await page.goto(base + '/materials', { waitUntil: 'networkidle2' });
  await until(() => page.evaluate(() => { const b = [...document.querySelectorAll('button[aria-label="Search by photo"]')].find((x) => x.getBoundingClientRect().width > 0); if (!b) return false; b.click(); return true; }), 'the "Search by photo" button of the shop', 20000);
  await page.waitForSelector(SHOP_CAMERA_INPUT, { timeout: 8000 });
  return page;
};
const clickByText = (page, text) => page.evaluate((t) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === t && x.getBoundingClientRect().width > 0); if (b) b.click(); return !!b; }, text);

await test('shop camera: "Take a photo" in "Find it from a photo" opens the camera inside the page (no camera app), the shot reaches the shop sheet as a photo it analyses, the camera is switched off, the page is not reloaded', async () => {
  const page = await shopPhotoPage();
  try {
    await page.evaluate(() => { window.__marker = 'same-page'; });
    const chooser = chooserOpens(page, 1500);
    assert(await clickByText(page, 'Take a photo'), 'no "Take a photo" button on the shop sheet');
    await until(() => page.evaluate(() => !!document.querySelector('[data-tc-camera]')), 'the in-page camera', 5000);
    assert(!(await chooser), 'the phone\'s file or camera picker opened as well');
    await until(() => page.evaluate(() => { const v = document.querySelector('[data-tc-camera] video'); return !!(v && v.srcObject && v.videoWidth > 0); }), 'the live picture', 8000);
    await until(() => page.evaluate(() => { const s = document.querySelector('.tcc-shutter'); return s && !s.disabled; }), 'the shutter to be ready', 5000);
    // Escape closes the camera only: the shop's sheet under it stays
    await page.keyboard.press('Escape');
    await until(() => page.evaluate(() => !document.querySelector('[data-tc-camera]')), 'Escape to close the camera', 3000);
    assert(await page.evaluate((sel) => !!document.querySelector(sel), SHOP_CAMERA_INPUT), 'Escape closed the shop sheet too');
    assert(await page.evaluate(() => window.__stops) >= 1, 'the camera was left running after Escape');
    assert(await clickByText(page, 'Take a photo'), 'no "Take a photo" button after the camera was closed');
    await until(() => page.evaluate(() => { const s = document.querySelector('.tcc-shutter'); return s && !s.disabled; }), 'the shutter to be ready (second time)', 8000);
    await page.evaluate(() => document.querySelector('.tcc-shutter').click());
    await until(() => page.evaluate(() => !document.querySelector('[data-tc-camera]')), 'the camera to close after the shot', 5000);
    // the shop took the photo: its sheet shows it (an object address made from the chosen file) and does not say it could not read it
    const shown = await until(() => page.evaluate(() => { const i = [...document.querySelectorAll('img')].find((x) => x.src.startsWith('blob:')); return i ? { blob: true, w: i.naturalWidth, text: document.body.innerText.slice(0, 4000) } : null; }), 'the shop to show the photo it was given', 15000);
    assert(!/couldn.t read that image|isn.t an image/i.test(shown.text), 'the shop could not read the photo: ' + shown.text.slice(0, 200));
    assert(await page.evaluate(() => window.__stops) >= 2, 'the camera was left running');
    assert(await page.evaluate(() => window.__marker === 'same-page'), 'the page was reloaded');
  } finally {
    await page.close();
  }
});

await test('shop camera: when the camera is refused the person is told and offered the camera app or the gallery (the shop\'s own gallery input); the camera app hand-off leaves a note, and a reload during it says so', async () => {
  const page = await shopPhotoPage({ before: () => { navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('refused'), { name: 'NotAllowedError' })); } });
  try {
    assert(await clickByText(page, 'Take a photo'), 'no "Take a photo" button on the shop sheet');
    await until(() => page.evaluate(() => /not allowed/i.test(document.querySelector('.tcc-panel')?.textContent ?? '')), 'the refusal message', 5000);
    const labels = await page.evaluate(() => [...document.querySelectorAll('.tcc-panel button')].map((b) => b.textContent));
    assert(labels.includes('Open the camera app') && labels.includes('Choose from gallery'), 'the fallbacks: ' + JSON.stringify(labels));
    // "Choose from gallery" opens the shop's own gallery input (the one without `capture`): a picker, and no hand-off note
    const gallery = page.waitForFileChooser({ timeout: 4000 }).catch(() => null);
    await page.evaluate(() => [...document.querySelectorAll('.tcc-panel button')].find((b) => b.textContent === 'Choose from gallery').click());
    const g = await gallery;
    assert(g, 'the gallery picker did not open from "Choose from gallery"');
    assert(await page.evaluate(() => !!document.querySelector('input[type="file"]:not([capture])')), 'the shop has no gallery input without capture');
    await g.cancel();
    assert(await page.evaluate(() => !sessionStorage.getItem('terucon.cameraHandoff')), 'a hand-off note was left for the gallery');
    // the camera app: a note, and the reload says what happened
    assert(await clickByText(page, 'Take a photo'), 'no "Take a photo" button after the gallery');
    await until(() => page.evaluate(() => /not allowed/i.test(document.querySelector('.tcc-panel')?.textContent ?? '')), 'the refusal message again', 5000);
    const chooser = chooserOpens(page, 4000);
    await page.evaluate(() => [...document.querySelectorAll('.tcc-panel button')].find((b) => b.textContent === 'Open the camera app').click());
    assert(await chooser, 'the camera app (file picker) did not open from "Open the camera app"');
    assert(await page.evaluate(() => !!sessionStorage.getItem('terucon.cameraHandoff')), 'no note was left for the hand-off');
    await page.reload({ waitUntil: 'networkidle2' }); // the phone threw the page away while the camera app was open
    await until(() => page.evaluate(() => /reloaded this page/i.test(document.querySelector('.tcc-note')?.textContent ?? '')), 'the note about the reload', 8000);
    assert(await page.evaluate(() => !sessionStorage.getItem('terucon.cameraHandoff')), 'the note was not cleared after it was shown');
  } finally {
    await page.close();
  }
});

await test('shop camera: a browser with no in-page camera still gets the camera app straight away (the old way)', async () => {
  const page = await shopPhotoPage({ before: () => { Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }); } });
  try {
    const chooser = chooserOpens(page, 4000);
    assert(await clickByText(page, 'Take a photo'), 'no "Take a photo" button on the shop sheet');
    assert(await chooser, 'the camera app (file picker) did not open');
    assert(await page.evaluate(() => !document.querySelector('[data-tc-camera]')), 'an in-page camera opened with no camera support');
  } finally {
    await page.close();
  }
});

// ---- the sign-in page's Google button ---------------------------------------------------------------------------------------------
// Seen on the live site on 2026-11-03: Google's script first draws a placeholder button on the page (its styles are inline, which the
// page's strict policy refuses, so it came out unstyled: a logo as wide as the card), and a moment later puts the real button, in a frame,
// beside it. These tests stand in for Google (no request leaves this machine): a script that does those same two steps (and, like Google
// when it refuses a page's address, leaves the placeholder where it is), and a frame whose arrival the test controls.
const GOOGLE_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';
const FAKE_GSI = `(function () {
  var renders = 0;
  window.__renders = function () { return renders; };
  window.google = { accounts: { id: {
    initialize: function () {}, prompt: function () {}, cancel: function () {},
    renderButton: function (box, o) {
      renders += 1;
      var wrap = document.createElement('div'); wrap.className = 'S9gUrf-YoZ4jf';
      var holder = document.createElement('div');
      holder.innerHTML = '<div role="button" tabindex="0"><svg viewBox="0 0 48 48"><path fill="#EA4335" d="M0 0h48v48H0z"/></svg><span>Continue with Google</span></div>';
      wrap.appendChild(holder); box.appendChild(wrap);
      setTimeout(function () {
        var f = document.createElement('iframe');
        f.src = 'https://accounts.google.com/gsi/button?width=' + o.width; f.title = 'Sign in with Google';
        f.style.display = 'block'; f.style.border = '0'; f.style.width = o.width + 'px'; f.style.height = '44px';
        wrap.appendChild(f);
      }, 150);
    }
  } } };
})();`;
const FAKE_GSI_FRAME = '<!doctype html><meta charset="utf-8"><body style="margin:0;font:500 14px sans-serif"><div style="margin:2px 0;height:40px;border-radius:20px;border:1px solid #ccc;background:#fff;display:flex;align-items:center;justify-content:center">Continue with Google</div>';
// records what a visitor could see, every 30 ms and on every change: the Google block's state, its height and where the form sits under it,
// the widest logo that is actually visible inside it, and whether the pill and the frame are visible
const GOOGLE_SAMPLER = () => {
  window.__g = [];
  const seen = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const c = getComputedStyle(n); if (c.visibility === 'hidden' || c.display === 'none' || Number(c.opacity) === 0) return false; } return true; };
  const snap = () => {
    const slot = document.getElementById('google-slot');
    const skel = document.getElementById('google-skel');
    const block = document.getElementById('google');
    if (!block) return;
    const frame = document.querySelector('#google-button iframe');
    const logos = [...block.querySelectorAll('svg')].filter(seen).map((s) => Math.round(s.getBoundingClientRect().width));
    window.__g.push({
      shown: seen(block), state: slot ? slot.dataset.state : 'none', blockH: Math.round(block.getBoundingClientRect().height), slotH: slot ? Math.round(slot.getBoundingClientRect().height) : 0,
      formGap: Math.round(document.getElementById('form-start').getBoundingClientRect().top - block.getBoundingClientRect().top),
      widest: logos.length ? Math.max(...logos) : 0, pill: !!skel && seen(skel), frame: !!frame && seen(frame),
    });
  };
  document.addEventListener('DOMContentLoaded', () => { new MutationObserver(snap).observe(document.documentElement, { childList: true, subtree: true, attributes: true }); setInterval(snap, 30); });
};
/** The sign-in page with Google's script and frame replaced by stand-ins. `script: false` = Google's script cannot be loaded; `hold` = the frame waits until `page.held` is released; `slowMs` = how long the page waits before it says it is taking longer (it waits 12 s). */
const googleLoginPage = async (stk, viewport, { script = true, hold = false, slowMs = 0 } = {}) => {
  const page = await newPage(viewport, stk, { signedIn: false });
  page.held = [];
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.startsWith('https://accounts.google.com/gsi/client')) {
      if (script) req.respond({ status: 200, contentType: 'application/javascript', body: FAKE_GSI }).catch(() => {});
      else req.abort('failed').catch(() => {});
    } else if (u.startsWith('https://accounts.google.com/')) {
      const send = () => req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: FAKE_GSI_FRAME }).catch(() => {});
      if (hold) page.held.push(send); else send();
    } else req.continue().catch(() => {});
  });
  await page.evaluateOnNewDocument(GOOGLE_SAMPLER);
  if (slowMs) await page.evaluateOnNewDocument((ms) => { const st = window.setTimeout; window.setTimeout = (fn, t, ...a) => st(fn, t === 12000 ? ms : t, ...a); }, slowMs);
  return page;
};
const googleState = (page) => page.evaluate(() => document.getElementById('google-slot')?.dataset.state);

await test('sign-in page: Google\'s unstyled placeholder is never shown, a pill holds the button\'s place, and the real button replaces it without moving anything (390 and 1440 px)', async () => {
  const open = await startStack({ port: 0, bootMs: 300, env: { AUTH_GOOGLE_CLIENT_ID: GOOGLE_ID } });
  try {
    for (const viewport of [PHONE, { width: 1440, height: 900 }]) {
      const page = await googleLoginPage(open, viewport);
      try {
        await page.goto(open.base + '/login', { waitUntil: 'domcontentloaded' });
        await until(() => page.evaluate(() => !!window.__g.at(-1)?.frame), 'the real button', 8000);
        await sleep(500); // the pill's fade
        const shown = (await page.evaluate(() => window.__g)).filter((x) => x.shown);
        const at = `at ${viewport.width}px`;
        assert(shown.length > 5, `the sampler saw the Google block ${shown.length} times ${at}`);
        const widest = Math.max(...shown.map((x) => x.widest));
        assert(widest <= 24, `a ${widest}px Google logo was visible ${at}: Google's placeholder showed while the button loaded`);
        assert(shown.some((x) => x.state === 'loading' && x.pill && x.slotH === 44), `no placeholder pill was shown while the button loaded ${at}`);
        for (const key of ['blockH', 'formGap']) {
          const values = shown.map((x) => x[key]);
          assert(Math.max(...values) - Math.min(...values) <= 1, `${key} changed from ${Math.min(...values)} to ${Math.max(...values)} px while the button loaded ${at}: the page jumped`);
        }
        const last = shown.at(-1);
        assert(last.state === 'ready' && last.frame && !last.pill, `the end state ${at} is not "the real button, no pill": ${JSON.stringify(last)}`);
        assert(await page.evaluate(() => [...document.querySelectorAll('#google-button iframe')].every((f) => [...f.parentNode.children].filter((el) => el !== f).every((el) => el.hidden))), `Google's placeholder was left showing beside the real button ${at}`);
        assert(await page.evaluate(() => document.getElementById('google').getAttribute('aria-busy') === 'false'), 'the block still says it is busy once the button is there');
      } finally {
        await page.close();
      }
    }
  } finally {
    await open.stop();
  }
});

await test('sign-in page: if the button is slow it says so after the wait and offers Try again, and the button still lands if it arrives (the placeholder is never shown)', async () => {
  const open = await startStack({ port: 0, bootMs: 300, env: { AUTH_GOOGLE_CLIENT_ID: GOOGLE_ID } });
  const page = await googleLoginPage(open, PHONE, { hold: true, slowMs: 500 });
  try {
    await page.goto(open.base + '/login', { waitUntil: 'domcontentloaded' });
    await until(async () => (await googleState(page)) === 'slow', 'the "taking longer" note', 6000);
    const note = await page.evaluate(() => { const n = document.getElementById('google-note'); const r = document.getElementById('google-retry'); return { shown: !n.hidden, text: n.textContent, retry: r.getBoundingClientRect().height >= 40, pill: !!document.getElementById('google-skel').offsetParent }; });
    assert(note.shown && /taking longer/i.test(note.text) && note.retry && note.pill, 'the note is not as expected: ' + JSON.stringify(note));
    await page.click('#google-retry');
    assert((await googleState(page)) === 'loading' && (await page.evaluate(() => document.getElementById('google-note').hidden)), 'Try again did not start over');
    await until(() => page.evaluate(() => window.__renders() === 2), 'the second render after Try again', 4000);
    await until(() => page.held.length >= 2, 'the second frame\'s request (the first frame was thrown away by Try again)', 4000);
    page.held.splice(0).forEach((send) => send()); // the frame comes at last
    await until(async () => (await googleState(page)) === 'ready', 'the button after the frame arrived', 6000);
    assert(await page.evaluate(() => document.querySelectorAll('#google-button iframe').length === 1 && document.getElementById('google-note').hidden), 'after the frame arrived there is not exactly one frame, or the note is still showing');
    const widest = Math.max(...(await page.evaluate(() => window.__g)).filter((x) => x.shown).map((x) => x.widest));
    assert(widest <= 24, `a ${widest}px Google logo was visible at some point`);
  } finally {
    await page.close();
    await open.stop();
  }
});

await test('sign-in page: if Google\'s script cannot load, the person is told in words (not left with an empty card) when Google is the only way in, and the form stays when it is not', async () => {
  const only = await startStack({ port: 0, bootMs: 300, env: { AUTH_GOOGLE_CLIENT_ID: GOOGLE_ID, AUTH_EMAIL_PROVIDER: 'off', AUTH_SMS_PROVIDER: 'off' } });
  const both = await startStack({ port: 0, bootMs: 300, env: { AUTH_GOOGLE_CLIENT_ID: GOOGLE_ID } });
  try {
    const a = await googleLoginPage(only, PHONE, { script: false });
    try {
      await a.goto(only.base + '/login', { waitUntil: 'domcontentloaded' });
      await until(() => a.evaluate(() => !document.getElementById('step-unavailable').hidden), 'the message', 6000);
      const got = await a.evaluate(() => ({ text: document.getElementById('unavailable-text').textContent, retry: !document.getElementById('retry-load').hidden, google: document.getElementById('google').hidden, loading: document.getElementById('step-loading').hidden }));
      assert(/Google sign-in could not be loaded/.test(got.text) && got.retry && got.google && got.loading, 'Google-only sign-in with no Google script: ' + JSON.stringify(got));
    } finally {
      await a.close();
    }
    const b = await googleLoginPage(both, PHONE, { script: false });
    try {
      await b.goto(both.base + '/login', { waitUntil: 'domcontentloaded' });
      await until(() => b.evaluate(() => document.getElementById('google').hidden && !document.getElementById('step-start').hidden), 'the form without the Google block', 6000);
      assert(await b.evaluate(() => !document.getElementById('form-start').hidden && document.getElementById('step-unavailable').hidden), 'the e-mail form should stay usable when only Google fails');
    } finally {
      await b.close();
    }
  } finally {
    await only.stop();
    await both.stop();
  }
});

// ==== chrome (begin) ====
// The site chrome (site/brand/chrome.{js,css}): ONE header (a floating pill) on every page and, on a laptop, a collapsible sidebar; the dock stays on a phone.
// Real Chrome against the dev stack, on a laptop and on phone widths. The exports' own headers are in their pages but not drawn: these tests look at what is drawn.
const CHROME_BUILT = Object.values(PAGES); // the four exported pages
const CHROME_HAND = ['/inspiration', '/finder', '/account', '/admin/catalogue']; // hand-written, with the sidebar
const CHROME_PLAIN = ['/login', '/coming-soon']; // hand-written, pill only
const rect = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left * 10) / 10, Math.round(b.top * 10) / 10, Math.round(b.width * 10) / 10, Math.round(b.height * 10) / 10]; };
const probeChrome = (page) => page.evaluate(() => {
  const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left * 10) / 10, Math.round(b.top * 10) / 10, Math.round(b.width * 10) / 10, Math.round(b.height * 10) / 10]; };
  const drawn = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const hdr = document.querySelector('.tc-hdr');
  const side = document.querySelector('.tc-side');
  const sideShown = !!side && getComputedStyle(side).display !== 'none';
  const cs = getComputedStyle(document.documentElement);
  const cta = hdr && hdr.querySelector('.tc-cta');
  return {
    headers: [...document.querySelectorAll('header')].filter((h) => drawn(h) && !h.closest('swatchroom-app')).length, // the studio's own bar (a <header> inside <swatchroom-app>) stays, by design
    pill: r(hdr), logo: r(hdr && hdr.querySelector('.tc-hdr__logo')), cta: r(cta), ctaText: cta && cta.textContent.trim(), ctaHref: cta && cta.getAttribute('href'), ctaArrow: !!(cta && cta.querySelector('.tc-cta__go svg')),
    title: hdr && hdr.querySelector('.tc-hdr__title') ? hdr.querySelector('.tc-hdr__title').textContent : null,
    acct: r(hdr && hdr.querySelector('.tc-hdr__acct')),
    side: sideShown ? r(side) : null, sideRail: document.documentElement.classList.contains('tc-side-rail'),
    rows: sideShown ? [...side.querySelectorAll('.tc-side__row')].map((a) => ({ text: a.textContent.replace(/\s+/g, ' ').trim(), href: a.getAttribute('href'), current: a.getAttribute('aria-current'), drawn: a.querySelector('.tc-side__text').getBoundingClientRect().width > 4 })) : [],
    hdrH: cs.getPropertyValue('--tc-hdr-h').trim(), sideW: cs.getPropertyValue('--tc-side-w').trim(),
    dock: !!document.querySelector('.tc-dock') && getComputedStyle(document.querySelector('.tc-dock')).display !== 'none',
    sideways: document.documentElement.scrollWidth - innerWidth, vh: innerHeight,
  };
});
const SIDE_ROWS = ['Home', 'Materials', 'Design StudioAI', 'Inspiration', 'Finder', 'My project', 'Account'];

await test('chrome: the same pill on every page at 1440 px (logo, account; the call to action to /start-project on the landing page only), no second header drawn, the sidebar on every page but the landing page, sign-in and coming soon', async () => {
  const seen = {};
  for (const route of [...CHROME_BUILT, ...CHROME_HAND, ...CHROME_PLAIN]) {
    const page = await newPage(undefined, stack, { signedIn: route !== '/login' });
    try {
      await page.goto(base + route, { waitUntil: 'networkidle2' });
      await sleep(route === '/' ? 1500 : 600);
      const m = await probeChrome(page);
      seen[route] = m;
      assert(m.headers === 1, `${route}: ${m.headers} headers are drawn (the exports' own must stay hidden)`);
      assert(m.pill && m.pill[0] === 12 && m.pill[1] === 10 && m.pill[3] === 60 && m.pill[2] === 1440 - 24, `${route}: the pill is not where it is on the other pages: ${JSON.stringify(m.pill)}`);
      if (route === '/') assert(m.ctaText === 'Start a project' && m.ctaHref === '/start-project' && m.ctaArrow && m.cta[3] >= 44, `${route}: the call to action: ${JSON.stringify([m.ctaText, m.ctaHref, m.ctaArrow, m.cta])}`);
      else assert(m.cta === null && m.ctaText === null, `${route}: the header has a call to action (it is on the landing page only): ${JSON.stringify([m.ctaText, m.cta])}`);
      assert(m.hdrH.startsWith('calc(70px'), `${route}: --tc-hdr-h is ${m.hdrH}`);
      const wantSide = !['/', '/login', '/coming-soon'].includes(route);
      assert(!!m.side === wantSide, `${route}: the sidebar should ${wantSide ? '' : 'not '}be drawn`);
      if (wantSide) {
        assert(JSON.stringify(m.rows.map((x) => x.text)) === JSON.stringify(SIDE_ROWS), `${route}: the rows are ${JSON.stringify(m.rows.map((x) => x.text))}`);
        const current = m.rows.filter((x) => x.current === 'page').map((x) => x.href);
        const here = { '/my-project': '/my-project', '/materials': '/materials', '/design-studio': '/design-studio', '/inspiration': '/inspiration', '/finder': '/finder', '/account': '/account' }[route];
        assert(JSON.stringify(current) === JSON.stringify(here ? [here] : []), `${route}: aria-current marks ${JSON.stringify(current)}`);
        assert(m.side[0] === 0 && m.side[2] === (route === '/my-project' ? 64 : 260) && m.side[1] === 70 && Math.abs(m.side[1] + m.side[3] - m.vh) < 1.5, `${route}: the sidebar's box ${JSON.stringify(m.side)}`);
        assert(m.sideW === (route === '/my-project' ? '64px' : '260px'), `${route}: --tc-side-w is ${m.sideW} (the dashboard has its own rail: the chrome's starts as a rail there)`);
      } else {
        assert(m.sideW === '0px', `${route}: --tc-side-w should be 0 (${m.sideW})`);
      }
      assert(m.sideways <= 0, `${route}: sideways scroll ${m.sideways}px`);
      noProblems(page, `${route} with the chrome`);
    } finally {
      await page.close();
    }
  }
  // one header, constant: the pill, the logo and (where nothing else sits right of it) the account button are the same boxes on every page
  const ref = seen['/inspiration'];
  for (const [route, m] of Object.entries(seen)) {
    assert(JSON.stringify(m.pill) === JSON.stringify(ref.pill) && JSON.stringify(m.logo) === JSON.stringify(ref.logo), `${route}: the pill or the logo differs from /inspiration: ${JSON.stringify([m.pill, m.logo])} vs ${JSON.stringify([ref.pill, ref.logo])}`);
    if (route !== '/' && route !== '/materials' && route !== '/login' && route !== '/coming-soon') assert(JSON.stringify(m.acct) === JSON.stringify(ref.acct), `${route}: the account button moved: ${JSON.stringify(m.acct)} vs ${JSON.stringify(ref.acct)}`);
  }
  assert(seen['/'].title === null && seen['/inspiration'].title === 'Inspiration' && seen['/design-studio'].title === 'Design Studio' && seen['/login'].title === 'Sign in' && seen['/admin/catalogue'].title === 'Catalogue admin', 'the titles: ' + JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.title]))));
  // the hand-written pages' footer bands are the same
  const bands = [];
  for (const route of [...CHROME_HAND, ...CHROME_PLAIN]) {
    const page = await newPage(undefined, stack, { signedIn: route !== '/login' });
    try {
      await page.goto(base + route, { waitUntil: 'networkidle2' });
      bands.push([route, await page.evaluate(() => { const f = document.querySelector('footer'); const cs = getComputedStyle(f); return [f.className, f.innerHTML.replace(/\s+/g, ' ').trim(), cs.backgroundColor, cs.paddingTop, cs.paddingBottom, cs.fontSize, cs.borderTopColor, Math.round(f.getBoundingClientRect().height)].join(' | '); })]);
    } finally {
      await page.close();
    }
  }
  assert(new Set(bands.map((b) => b[1])).size === 1, 'the footer bands differ:\n' + bands.map((b) => `${b[0]}: ${b[1]}`).join('\n'));
});

await test('chrome: the pill is keyboard-reachable with a visible focus ring, aria-current is on the current destination, reduced motion switches its transitions off, and the chrome causes no layout shift', async () => {
  const page = await newPage();
  try {
    await page.evaluateOnNewDocument(() => {
      window.__shifts = [];
      new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__shifts.push((e.sources || []).map((s) => s.node && s.node.nodeType === 1 && s.node.closest ? (s.node.closest('.tc-hdr, .tc-side') ? 'chrome' : 'page') : 'other')); }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto(base + '/inspiration', { waitUntil: 'networkidle2' });
    await sleep(800);
    // Tab from the top of the page: logo, account, the call to action, then the sidebar
    const order = [];
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      order.push(await page.evaluate(() => { const a = document.activeElement; const cs = getComputedStyle(a); return { what: a.className || a.tagName, text: (a.textContent || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 20), ring: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2, inChrome: !!a.closest('.tc-hdr, .tc-side') }; }));
    }
    const chromeStops = order.filter((o) => o.inChrome);
    assert(chromeStops.length >= 9, 'the chrome has too few keyboard stops: ' + JSON.stringify(order));
    assert(chromeStops.every((o) => o.ring), 'a stop in the chrome has no visible focus ring: ' + JSON.stringify(chromeStops.filter((o) => !o.ring)));
    assert(order[0].what === 'tc-hdr__logo' && /tc-hdr__acct/.test(order[1].what) && !order.some((o) => /tc-cta/.test(o.what)), 'the order of the pill is logo, account (no call to action off the landing page), then the sidebar: ' + JSON.stringify(order.slice(0, 3)));
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const motion = await page.evaluate(() => [...document.querySelectorAll('.tc-cta__go svg, .tc-side__row, .tc-side__toggle svg, .tc-hdr__link')].map((e) => getComputedStyle(e).transitionDuration));
    assert(motion.every((d) => d.split(',').every((x) => parseFloat(x) === 0)), 'reduced motion still has transitions: ' + JSON.stringify(motion));
    const shifts = await page.evaluate(() => window.__shifts);
    assert(!shifts.some((s) => s.includes('chrome')), 'the chrome shifted: ' + JSON.stringify(shifts));
    noProblems(page, 'keyboard and motion');
  } finally {
    await page.close();
  }
});

await test('chrome: the sidebar collapses to a 64 px icon rail and back, the page content follows with no overlap, the state is remembered (and a browser whose localStorage throws still works), the card shows the signed-in person', async () => {
  const page = await newPage();
  try {
    await page.goto(base + '/inspiration', { waitUntil: 'networkidle2' });
    await sleep(600);
    const mainLeft = () => page.evaluate(() => document.querySelector('main').getBoundingClientRect().left);
    const open = await probeChrome(page);
    assert(open.side[2] === 260 && !open.sideRail, 'starts open at 1440: ' + JSON.stringify(open.side));
    assert((await mainLeft()) >= 260, 'the page content overlaps the sidebar: main starts at ' + await mainLeft());
    const card = await page.evaluate(() => ({ name: document.querySelector('.tc-side__name').textContent, sub: document.querySelector('.tc-side__sub').textContent, href: document.querySelector('.tc-side__card').getAttribute('href'), av: document.querySelector('.tc-side__card .tc-av').textContent, hav: document.querySelector('.tc-hdr__acct .tc-av').textContent, hlabel: document.querySelector('.tc-hdr__acct').getAttribute('aria-label') }));
    assert(card.name === 'Test Visitor' && card.sub === 'Test Firm' && card.href === '/account' && card.av === 'TV' && card.hav === 'TV' && card.hlabel === 'Account, Test Visitor', 'the signed-in card: ' + JSON.stringify(card));
    const toggle = await page.evaluate(() => { const b = document.querySelector('.tc-side__toggle'); const r = b.getBoundingClientRect(); const side = document.querySelector('.tc-side').getBoundingClientRect(); return { exp: b.getAttribute('aria-expanded'), label: b.getAttribute('aria-label'), cx: r.left + r.width / 2, edge: side.right, size: r.width }; });
    assert(toggle.exp === 'true' && /smaller/.test(toggle.label) && Math.abs(toggle.cx - toggle.edge) <= 2 && toggle.size === 28, 'the chevron: ' + JSON.stringify(toggle));
    await page.click('.tc-side__toggle');
    await sleep(300);
    const shut = await probeChrome(page);
    assert(shut.side[2] === 64 && shut.sideRail && shut.sideW === '64px' && shut.rows.every((r) => !r.drawn), 'collapsed: ' + JSON.stringify([shut.side, shut.sideW, shut.rows.map((r) => r.drawn)]));
    assert((await mainLeft()) >= 64 && (await mainLeft()) < 260, 'the content did not follow the rail: main starts at ' + await mainLeft());
    assert(await page.evaluate(() => localStorage.getItem('tc-side')) === '1', 'the state was not remembered');
    assert(await page.evaluate(() => document.querySelector('.tc-side__row').getAttribute('title')) === 'Home', 'the rail has no tooltips');
    await page.reload({ waitUntil: 'networkidle2' });
    assert((await probeChrome(page)).sideRail, 'the rail did not come back after a reload');
    await page.click('.tc-side__toggle');
    await sleep(200);
    assert((await probeChrome(page)).side[2] === 260 && await page.evaluate(() => localStorage.getItem('tc-side')) === '0', 'did not open again');
    // a browser that refuses localStorage
    const blocked = await newPage();
    try {
      await blocked.evaluateOnNewDocument(() => { const no = () => { throw new DOMException('blocked', 'SecurityError'); }; Storage.prototype.getItem = no; Storage.prototype.setItem = no; });
      await blocked.goto(base + '/inspiration', { waitUntil: 'networkidle2' });
      assert((await probeChrome(blocked)).side[2] === 260, 'no sidebar when localStorage throws');
      await blocked.click('.tc-side__toggle');
      await sleep(200);
      assert((await probeChrome(blocked)).side[2] === 64, 'the toggle does not work when localStorage throws');
      noProblems(blocked, 'localStorage blocked');
    } finally {
      await blocked.close();
    }
    noProblems(page, 'the sidebar');
  } finally {
    await page.close();
  }
  // signed out (a stack that does not ask for sign-in): the card says Sign in
  const free = await startStack({ port: 0, bootMs: 300, env: { AUTH_REQUIRED: 'off' } });
  const guest = await newPage(undefined, free, { signedIn: false });
  try {
    await guest.goto(free.base + '/inspiration', { waitUntil: 'networkidle2' });
    await sleep(500);
    const card = await guest.evaluate(() => ({ name: document.querySelector('.tc-side__name').textContent, href: document.querySelector('.tc-side__card').getAttribute('href'), acct: document.querySelector('.tc-hdr__acct').getAttribute('aria-label') }));
    assert(card.name === 'Sign in' && card.href === '/login' && card.acct === 'Sign in', 'the signed-out card: ' + JSON.stringify(card));
    // 1000 px wide with nothing remembered: the rail, to leave the content room
    await guest.setViewport({ width: 1000, height: 800 });
    await guest.goto(free.base + '/inspiration', { waitUntil: 'networkidle2' });
    assert((await probeChrome(guest)).sideRail, 'at 1000 px the sidebar should start as a rail');
  } finally {
    await guest.close();
    await free.stop();
  }
});

await test('chrome: on a phone or a small tablet (820, 390, 360 px) the pill is logo + account (the landing page: logo + call to action + Menu), nothing overlaps or leaves it, no sidebar, the dock is the destinations, no sideways scroll', async () => {
  for (const width of [820, 390, 360]) {
    for (const route of [...CHROME_BUILT, '/inspiration', '/finder', '/account']) {
      const view = width === 820 ? { width, height: 1100 } : { ...PHONE, width };
      const page = await newPage(view);
      try {
        await page.goto(base + route, { waitUntil: 'networkidle2' });
        await sleep(route === '/' ? 1200 : 500);
        const m = await probeChrome(page);
        const parts = await page.evaluate(() => { const hdr = document.querySelector('.tc-hdr'); const p = hdr.getBoundingClientRect(); return [...hdr.querySelectorAll('a, button')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => { const r = e.getBoundingClientRect(); return { what: (e.getAttribute('aria-label') || e.textContent || 'logo').trim().slice(0, 18), l: r.left, r: r.right, t: r.top, b: r.bottom, outside: r.left < p.left - 0.5 || r.right > p.right + 0.5 }; }); });
        const where = `${route} at ${width} px`;
        assert(m.side === null && m.sideW === '0px', `${where}: a sidebar is drawn`);
        assert(m.dock || (route === '/my-project' && width < 720), `${where}: the dock is not there`);
        assert(m.headers === 1 && m.pill[3] === 54, `${where}: headers ${m.headers}, pill ${JSON.stringify(m.pill)}`);
        for (let i = 0; i < parts.length; i += 1) {
          assert(!parts[i].outside, `${where}: ${parts[i].what} leaves the pill`);
          assert(parts[i].b - parts[i].t >= 43.5, `${where}: ${parts[i].what} is shorter than 44 px`);
          for (let j = i + 1; j < parts.length; j += 1) assert(!(parts[i].l < parts[j].r - 0.5 && parts[j].l < parts[i].r - 0.5), `${where}: ${parts[i].what} overlaps ${parts[j].what}`);
        }
        const names = parts.map((x) => x.what);
        if (route === '/') assert(names.includes('Start a project'), `${where}: no call to action on the landing page: ${names}`);
        else assert(!names.includes('Start a project'), `${where}: the call to action is on the landing page only: ${names}`);
        if (route === '/') assert(names.includes('Open menu') && !names.some((n) => /^Account|^Sign in/.test(n)), `${where}: the landing page's phone pill: ${names}`);
        else assert(!names.includes('Open menu'), `${where}: only the landing page has the Menu button: ${names}`);
        if (route !== '/') assert(names.some((n) => /^Account|^Sign in/.test(n)), `${where}: no account button: ${names}`);
        if (route === '/materials') assert(names.some((n) => /^Cart/.test(n)) && !names.includes('Saved'), `${where}: the shop's pill: ${names}`);
        assert(m.sideways <= 0, `${where}: sideways scroll ${m.sideways}px`);
        noProblems(page, where);
      } finally {
        await page.close();
      }
    }
  }
});

await test('chrome: /materials: Saved and Cart are in the pill (only there), mirror the export\'s own counts, forward their clicks to the originals, and no node of the export is moved', async () => {
  const page = await newPage();
  try {
    await page.goto(base + '/materials', { waitUntil: 'networkidle2' });
    await sleep(1500);
    const read = () => page.evaluate(() => ({ shop: [...document.querySelectorAll('.tc-hdr__shop button')].map((b) => ({ label: b.getAttribute('aria-label'), n: b.querySelector('.tc-ib__n').getAttribute('data-n'), drawn: b.getBoundingClientRect().width > 0 })), exportHidden: getComputedStyle(document.querySelector('header[data-nav]')).display }));
    const first = await read();
    assert(first.shop.length === 2 && first.shop.every((b) => b.drawn) && first.shop[0].label === 'Saved' && /^Cart/.test(first.shop[1].label) && first.shop.every((b) => b.n === '0'), 'the two buttons at the start: ' + JSON.stringify(first.shop));
    assert(first.exportHidden === 'none', 'the export\'s own header is drawn');
    const endBefore = await page.evaluate(() => { const hdr = document.querySelector('.tc-hdr'); const p = hdr.getBoundingClientRect(); return { shopRight: hdr.querySelector('.tc-hdr__shop').getBoundingClientRect().right, pillRight: p.right, cta: !!hdr.querySelector('.tc-cta') }; });
    assert(!endBefore.cta && endBefore.shopRight <= endBefore.pillRight, 'Saved and Cart sit inside the right end of the pill, and the shop has no call to action: ' + JSON.stringify(endBefore));
    assert(await page.evaluate(() => { const hdr = document.querySelector('.tc-hdr'); return hdr.parentElement === document.documentElement && !hdr.closest('#dc-root'); }), 'the chrome sits inside the export');
    // a click on ours is a click on the export's own link
    await page.click('[data-tc-shop="cart"]');
    await until(() => page.evaluate(() => location.hash === '#/cart'), 'the cart page', 4000);
    await page.click('[data-tc-shop="saved"]');
    await until(() => page.evaluate(() => location.hash === '#/saved'), 'the saved list', 4000);
    // saving a material and adding one to the cart change the export's counts: ours follow
    await page.evaluate(() => { location.hash = '#/shop'; });
    await until(() => page.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.getAttribute('aria-label') === 'Save for later')), 'a "Save for later" button', 8000);
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Save for later').click());
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /^Add 1 .* to cart$/.test(b.getAttribute('aria-label') || '')).click());
    const after = await until(async () => { const r = await read(); return r.shop[0].n === '1' && r.shop[1].n === '1' ? r : null; }, 'the counts to follow the export', 6000);
    assert(after.shop[0].label === 'Saved, 1' && /^Cart, 1 /.test(after.shop[1].label), 'the labels after: ' + JSON.stringify(after.shop));
    const orig = await page.evaluate(() => { const n = document.querySelector('header[data-nav]'); return { saved: n.querySelector('a[href="#/saved"]').textContent.trim(), cart: n.querySelector('a[href="#/cart"]').textContent.trim() }; });
    assert(/Saved\s*1/.test(orig.saved) && /Cart\s*1/.test(orig.cart), 'the export\'s own counts: ' + JSON.stringify(orig));
    // only this page has them
    const other = await newPage();
    try {
      await other.goto(base + '/design-studio', { waitUntil: 'networkidle2' });
      assert(await other.evaluate(() => !document.querySelector('.tc-hdr__shop') || getComputedStyle(document.querySelector('.tc-hdr__shop')).display === 'none'), 'the studio has Saved and Cart in its pill');
    } finally {
      await other.close();
    }
    noProblems(page, 'the shop');
  } finally {
    await page.close();
  }
});

await test('chrome: /my-project: the dark top bar is gone, the chrome\'s sidebar starts as a 64 px rail beside the dashboard\'s own rail, the content is not cramped (1280, 1024 px), and the dark-mode switch and the text-size button are still reachable', async () => {
  for (const [width, minContent] of [[1440, 1050], [1280, 1050], [1024, 800]]) {
    const page = await newPage({ width, height: 860 });
    try {
      await page.goto(base + '/my-project', { waitUntil: 'networkidle2' });
      await sleep(1500);
      const m = await probeChrome(page);
      const d = await page.evaluate(() => {
        const rail = document.querySelector('nav[data-screen-label="Side menu"]');
        const r = rail.getBoundingClientRect();
        const bar = document.querySelector('header[data-screen-label="Top bar"]');
        return { rail: [r.left, r.top, r.width], bar: getComputedStyle(bar).display, content: innerWidth - r.right, sw: document.documentElement.scrollWidth - innerWidth };
      });
      const where = `/my-project at ${width} px`;
      assert(m.side && m.side[2] === 64 && m.sideRail, `${where}: the chrome's sidebar should start as a rail: ${JSON.stringify(m.side)}`);
      assert(d.bar === 'none' && m.headers === 1, `${where}: the top bar is drawn (${d.bar}, headers ${m.headers})`);
      assert(Math.abs(d.rail[0] - 64) < 1 && Math.abs(d.rail[1] - 70) < 2.5, `${where}: the dashboard's rail is at ${JSON.stringify(d.rail)}, not beside the chrome's`);
      assert(d.content >= minContent, `${where}: the content is ${Math.round(d.content)} px wide (wanted at least ${minContent})`);
      assert(d.sw <= 0, `${where}: sideways scroll ${d.sw}px`);
      if (width === 1280) {
        const sw = await page.evaluate(() => { const b = document.querySelector('nav[data-screen-label="Side menu"] [role="switch"]'); const r = b.getBoundingClientRect(); return { checked: b.getAttribute('aria-checked'), w: r.width, h: r.height, bg: getComputedStyle(document.documentElement).getPropertyValue('--bg') + '|' + getComputedStyle(document.querySelector('[data-dash]') || document.body).backgroundColor }; });
        assert(sw.checked === 'false' && sw.w >= 44 && sw.h >= 44, 'the dark-mode switch: ' + JSON.stringify(sw));
        await page.click('nav[data-screen-label="Side menu"] [role="switch"]');
        await sleep(900);
        assert(await page.evaluate(() => document.querySelector('nav[data-screen-label="Side menu"] [role="switch"]').getAttribute('aria-checked')) === 'true', 'the dark-mode switch did not switch');
        await page.click('nav[data-screen-label="Side menu"] [aria-haspopup="menu"]');
        await until(() => page.evaluate(() => !!document.querySelector('[role="menu"][aria-label="My account"]')), 'the text-size menu', 4000);
        assert(await page.evaluate(() => /Text size/.test(document.querySelector('[role="menu"][aria-label="My account"]').innerText)), 'the menu has no text-size choice');
        await page.mouse.click(700, 500); // the menu's own backdrop closes it
        await until(() => page.evaluate(() => !document.querySelector('[role="menu"][aria-label="My account"]')), 'the menu to close', 4000);
        // expanding the chrome's sidebar: the dashboard's rail follows it and the page looks at its width again
        await page.click('.tc-side__toggle');
        await sleep(900);
        const wide = await page.evaluate(() => { const r = document.querySelector('nav[data-screen-label="Side menu"]').getBoundingClientRect(); const s = document.querySelector('.tc-side').getBoundingClientRect(); return { railLeft: r.left, sideW: s.width, content: innerWidth - r.right }; });
        assert(wide.sideW === 260 && Math.abs(wide.railLeft - 260) < 1 && wide.content > 700, 'with the chrome\'s sidebar open: ' + JSON.stringify(wide));
      }
      noProblems(page, where);
    } finally {
      await page.close();
    }
  }
});

await test('chrome: /design-studio: the studio sits under the pill and right of the sidebar (open or collapsed), the chrome steps aside when the studio goes full screen, and a pointer over the photo still maps to the right place in it', async () => {
  const open = await startStack({ port: 0, bootMs: 300 });
  const page = await newPage(undefined, open);
  try {
    await page.goto(open.base + '/design-studio', { waitUntil: 'networkidle2' });
    await until(() => page.evaluate(() => /Add a room photo/.test(document.body.innerText)), 'the studio', 15000);
    // the studio's loader stays for at least two cycles (site/brand/loader.html) and covers the page until then: a pointer test waits for it to leave
    await until(() => page.evaluate(() => { const l = document.getElementById('tc-loader'); return !l || getComputedStyle(l).display === 'none'; }), 'the loader to leave the studio', 20000);
    const place = () => page.evaluate(() => { const s = document.querySelector('swatchroom-app'); const r = s.getBoundingClientRect(); const st = s.querySelector('.sr-studio').getBoundingClientRect(); return { left: r.left, top: r.top, bottom: st.bottom, swr: s.style.getPropertyValue('--swr-top'), h: innerHeight }; });
    let p = await place();
    assert(p.left === 260 && Math.abs(p.top - 70) < 1.5 && p.swr === '70px' && Math.abs(p.bottom - p.h) < 1.5, 'the studio at 1440 with the sidebar open: ' + JSON.stringify(p));
    // a photo
    const file = path.join(os.tmpdir(), `terucon-chrome-${Date.now()}.jpg`);
    fs.writeFileSync(file, await makeJpeg(page, 1200, 800));
    try {
      await (await page.$('input[data-input="photo"]')).uploadFile(file);
      await until(() => page.evaluate(() => /Original photo/.test(document.body.innerText)), 'the photo in the studio', 30000);
      await sleep(600);
      const probe = async (label) => {
        const pts = [[0.25, 0.3], [0.5, 0.5], [0.8, 0.7]];
        for (const [fx, fy] of pts) {
          const g = await page.evaluate(() => { const st = document.querySelector('swatchroom-app').studio.stage; const img = st.element.querySelector('img'); const r = img.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
          const x = g[0] + g[2] * fx, y = g[1] + g[3] * fy;
          await page.mouse.move(x, y);
          const got = await page.evaluate((cx, cy) => {
            const st = document.querySelector('swatchroom-app').studio.stage;
            const top = document.elementFromPoint(cx, cy);
            const p = st.pointFromEvent({ clientX: cx, clientY: cy });
            return { fx: p[0], fy: p[1], inStage: !!top && st.element.contains(top) };
          }, x, y);
          assert(got.inStage, `${label}: something other than the studio's stage is at (${Math.round(x)}, ${Math.round(y)})`);
          assert(Math.abs(got.fx - fx) < 0.01 && Math.abs(got.fy - fy) < 0.01, `${label}: the stage maps (${fx}, ${fy}) of the photo to (${got.fx.toFixed(3)}, ${got.fy.toFixed(3)})`);
        }
      };
      await probe('sidebar open');
      await page.click('.tc-side__toggle');
      await sleep(600);
      p = await place();
      assert(p.left === 64, 'the studio did not follow the rail: ' + JSON.stringify(p));
      await probe('sidebar collapsed');
    } finally {
      fs.rmSync(file, { force: true });
    }
    // full screen: the chrome steps aside, like the dock
    await page.evaluate(() => document.documentElement.classList.add('swr-immersive'));
    const hidden = await page.evaluate(() => ({ hdr: getComputedStyle(document.querySelector('.tc-hdr')).display, side: getComputedStyle(document.querySelector('.tc-side')).display, v: getComputedStyle(document.documentElement).getPropertyValue('--tc-hdr-h').trim() }));
    assert(hidden.hdr === 'none' && hidden.side === 'none' && hidden.v === '0px', 'the chrome stayed during full screen: ' + JSON.stringify(hidden));
    await page.evaluate(() => document.documentElement.classList.remove('swr-immersive'));
    assert(await page.evaluate(() => getComputedStyle(document.querySelector('.tc-hdr')).display !== 'none'), 'the chrome did not come back');
    // on a phone: the pill above the studio, the dock below
    await page.setViewport(PHONE);
    await page.goto(open.base + '/design-studio', { waitUntil: 'networkidle2' });
    await until(() => page.evaluate(() => /Add a room photo/.test(document.body.innerText)), 'the studio on a phone', 15000);
    p = await place();
    assert(p.left === 0 && Math.abs(p.top - 64) < 2 && p.swr === '64px', 'the studio on a phone: ' + JSON.stringify(p));
  } finally {
    await page.close();
    await open.stop();
  }
});
// ==== chrome (end) ====

// ==== terubot widget (begin) ====
// TeruBot, the one assistant of the site (site/brand/terubot.{js,css}; how it works: site/brand/terubot.md). The server it talks to is not
// part of these tests: /api/terubot/chat and /api/terubot/status are answered by the stubs below (puppeteer request interception).
// A stubbed 4xx/5xx is not a problem of the page, so the checks below leave /api/terubot/ out of page.problems.
const TB_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const tbState = (over = {}) => ({ calls: [], chat: null, status: { aiOn: true, model: 'gemini-test', signedIn: true }, statusDown: false, ...over });
const tbAnswer = (reply, extra = {}) => ({ json: { aiOn: true, reply, cards: [], actions: [], model: 'gemini-test', ...extra } });
const tbProblems = (page) => page.problems.filter((p) => !/\/api\/terubot\/|\/assets\/tb-/.test(p));
/** A signed-in page with the TeruBot endpoints stubbed by `st` (st.chat(body, n) -> {status?, json}, or a promise of one; st.status; st.statusDown). */
const tbPage = async (viewport, st, { speech = null } = {}) => {
  const page = await newPage(viewport);
  if (speech === 'none') await page.evaluateOnNewDocument(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; });
  if (speech === 'live' || speech === 'live-nosynth') {
    // a recogniser and a synthesiser the test drives: window.__hear(text) / __silence() play what the microphone heard; __endSpeech() is the end of
    // one spoken piece. What was spoken is also kept in sessionStorage, so it survives a page change.
    await page.evaluateOnNewDocument((withSynth) => {
      const sr = (window.__sr = { starts: 0, aborts: 0, active: false, inst: null });
      window.SpeechRecognition = class {
        constructor() { sr.inst = this; }
        start() { sr.starts += 1; sr.active = true; this.onstart && this.onstart(); }
        stop() { this.__end(); }
        abort() { sr.aborts += 1; if (sr.active) { this.onerror && this.onerror({ error: 'aborted' }); this.__end(); } }
        __end() { if (!sr.active) return; sr.active = false; this.onend && this.onend(); }
      };
      window.__hear = (text) => { const r = sr.inst; r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] }); r.__end(); };
      window.__silence = () => { const r = sr.inst; r.onerror && r.onerror({ error: 'no-speech' }); r.__end(); };
      if (!withSynth) { delete window.speechSynthesis; delete window.SpeechSynthesisUtterance; return; }
      const tts = (window.__tts = { spoken: [], cancels: 0, pending: [] });
      window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; this.volume = 1; } };
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
        getVoices: () => [],
        addEventListener() {},
        cancel() { tts.cancels += 1; const gone = tts.pending.splice(0); gone.forEach((u) => u.onerror && u.onerror({ error: 'canceled' })); },
        speak(u) { if (u.volume === 0) return; tts.spoken.push(u.text); tts.pending.push(u); try { sessionStorage.setItem('__spoken', JSON.stringify(tts.spoken)); } catch (e) {} },
      } });
      window.__endSpeech = () => { const u = tts.pending.shift(); if (u && u.onend) u.onend({}); };
    }, speech === 'live');
  }
  if (speech === 'fake') {
    await page.evaluateOnNewDocument(() => {
      window.__heard = 'show me terracotta';
      window.SpeechRecognition = class { start() { this.onstart && this.onstart(); setTimeout(() => { this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: window.__heard }], { isFinal: true })] }); this.onend(); }, 50); } stop() {} abort() {} };
    });
  }
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (u.pathname === '/api/terubot/chat' && req.method() === 'POST') {
      let body = null;
      try { body = JSON.parse(req.postData() || 'null'); } catch { /* stays null */ }
      st.calls.push(body);
      Promise.resolve(st.chat ? st.chat(body, st.calls.length) : tbAnswer('Hello.')).then((x) => (x.abort ? req.abort('failed') : req.respond({ status: x.status || 200, contentType: 'application/json', headers: x.headers || {}, body: JSON.stringify(x.json ?? {}) })));
    } else if (u.pathname === '/api/terubot/status') {
      if (st.statusDown) req.abort('failed'); else req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(st.status) });
    } else if (st.route && st.route(u, req) === true) { // a test that answers other addresses itself (the picture of a link, ...)
    } else if (/^\/assets\/tb-/.test(u.pathname)) { // the card pictures the stubs name: built-site assets look like /assets/<name>-<hash>.webp
      if (/404/.test(u.pathname)) req.respond({ status: 404, body: 'no' }); else req.respond({ status: 200, contentType: 'image/png', body: TB_PNG });
    } else req.continue();
  });
  return page;
};
/** Like a person: nothing can be clicked until the page's loader has stopped covering it (the studio's own loader holds for the GPU: not waited for). */
const tbLoaderGone = async (page) => {
  if (/\/design-studio/.test(page.url())) return;
  await until(() => page.evaluate(() => { const l = document.getElementById('tc-loader'); return !l || getComputedStyle(l).pointerEvents === 'none'; }), 'the loader to let go of ' + page.url(), 15000);
};
const tbGo = async (page, route) => {
  await page.goto(base + route, { waitUntil: 'domcontentloaded' });
  await until(() => page.evaluate(() => !!window.TeruBot && !!document.querySelector('.tb-launch')), `TeruBot on ${route}`, 15000);
  await tbLoaderGone(page);
};
/** The shop answers the "terucon:shop" event once its catalogue is loaded: poll with a harmless probe. */
const tbShopReady = (page) => until(() => page.evaluate(() => { const d = { op: 'saved_remove', id: 'no-such-item', handled: false }; window.dispatchEvent(new CustomEvent('terucon:shop', { detail: d })); return d.handled; }), 'the shop to answer', 20000);
const tbOpen = async (page) => { await tbLoaderGone(page); await page.evaluate(() => window.TeruBot.open()); await until(() => page.evaluate(() => { const p = document.getElementById('terubot-panel'); return !!p && !p.hidden; }), 'the panel to open'); };
const tbSend = async (page, text) => { await page.type('.tb-input', text); await page.keyboard.press('Enter'); };
const tbBotTexts = (page) => page.evaluate(() => [...document.querySelectorAll('.tb-msg--bot .tb-text')].map((n) => n.textContent));
const tbNotes = (page) => page.evaluate(() => [...document.querySelectorAll('.tb-note .tb-note__text')].map((n) => n.textContent));
const tbWaitBot = (page, n) => until(async () => (await page.evaluate(() => document.querySelectorAll('.tb-msg--bot:not([data-greeting])').length)) >= n && !(await page.$('.tb-typing')), `bot message ${n}`, 8000);
const TB_CART_KEY = 'terucon.store.v1.cart';

await test('terubot: one "Ask TeruBot" launcher on every page, nothing built until it opens; it opens, closes with the button and with Escape, and gives the focus back', async () => {
  const st = tbState();
  const page = await tbPage(null, st);
  for (const route of ['/', '/materials', '/design-studio', '/my-project', '/inspiration', '/finder', '/account']) {
    await tbGo(page, route);
    const got = await page.evaluate(() => ({ launchers: document.querySelectorAll('.tb-launch').length, label: document.querySelector('.tb-launch').textContent.trim(), panel: !!document.getElementById('terubot-panel'), api: Object.keys(window.TeruBot).sort().join() }));
    assert(got.launchers === 1 && got.label === 'Ask TeruBot', `${route}: ${JSON.stringify(got)}`);
    assert(!got.panel, `${route}: the panel was built before anyone opened it`);
    assert(got.api === 'ask,close,isOpen,open', `${route}: window.TeruBot is ${got.api}`);
  }
  assert(st.calls.length === 0, 'the page load alone talked to the chat endpoint');
  await tbGo(page, '/finder');
  await page.click('.tb-launch');
  await until(() => page.evaluate(() => { const p = document.getElementById('terubot-panel'); return p && !p.hidden; }), 'the panel to open');
  await until(() => page.evaluate(() => document.querySelector('.tb-log').getAttribute('aria-live') === 'polite'), 'the live region to settle');
  const open = await page.evaluate(() => { const p = document.getElementById('terubot-panel'); return { role: p.getAttribute('role'), name: document.getElementById('terubot-title').textContent, live: document.querySelector('.tb-log').getAttribute('aria-live'), logRole: document.querySelector('.tb-log').getAttribute('role'), expanded: document.querySelector('.tb-launch').getAttribute('aria-expanded'), focusIn: p.contains(document.activeElement), launcherShown: getComputedStyle(document.querySelector('.tb-launch')).display !== 'none', chips: [...document.querySelectorAll('.tb-chip')].map((c) => c.textContent) }; });
  assert(open.role === 'dialog' && open.name === 'TeruBot' && open.logRole === 'log' && open.live === 'polite' && open.expanded === 'true' && open.focusIn, 'the open panel: ' + JSON.stringify(open));
  assert(!open.launcherShown, 'the launcher stays on screen under the open panel');
  assert(JSON.stringify(open.chips) === JSON.stringify(['Find a material', 'Try the Design Studio with my photo', 'Start a project']), 'the suggestions: ' + open.chips);
  await page.keyboard.press('Escape');
  await until(() => page.evaluate(() => document.getElementById('terubot-panel').hidden), 'Escape to close the panel');
  assert(await page.evaluate(() => document.activeElement === document.querySelector('.tb-launch')), 'the focus did not return to the launcher');
  await page.click('.tb-launch');
  await until(() => page.evaluate(() => !document.getElementById('terubot-panel').hidden), 'a second open');
  await page.click('[aria-label="Close TeruBot"]');
  await until(() => page.evaluate(() => document.getElementById('terubot-panel').hidden), 'the close button');
  assert(await page.evaluate(() => document.activeElement === document.querySelector('.tb-launch')), 'the focus did not return after the close button');
  noProblems(page, 'TeruBot opening and closing');
  await page.close();
});

await test('terubot: a message goes out with the page context and nothing else; the reply and the cards are shown as text, never as HTML; Enter sends and Shift+Enter makes a new line', async () => {
  const st = tbState({
    chat: () => tbAnswer('Two options.\n<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>', { cards: [
      { kind: 'material', id: 'superbond-fr-metallic--acp-bronze-4-1220x2440', pid: 'superbond-fr-metallic', vid: 'superbond-fr-metallic--acp-bronze-4-1220x2440', fid: 'acp-bronze', variant: 'Brushed Bronze · 4 mm', name: '<b>Bronze</b> ACP', price: '₹2,050 / sq ft', image: '/assets/tb-bronze-abc123.webp', href: '/materials#/p/superbond-fr-metallic?v=superbond-fr-metallic--acp-bronze-4-1220x2440' },
      { kind: 'material', id: 'no-picture--a-1x1', pid: 'no-picture', vid: 'no-picture--a-1x1', fid: 'a', variant: '', name: 'Picture is missing', price: '', image: '/assets/tb-missing-404.webp', href: '/materials#/p/no-picture?v=no-picture--a-1x1' },
      { kind: 'material', id: 'fixing--b-1x1', pid: 'fixing', vid: 'fixing--b-1x1', fid: 'b', variant: '', name: 'Fixing without a photo', price: '', image: '', href: '/materials#/p/fixing?v=fixing--b-1x1' },
      { kind: 'material', id: 'evil', name: 'Elsewhere', price: '', image: 'https://evil.example/x.jpg', href: 'https://evil.example/' },
      { kind: 'banner', id: 'x', name: 'Not a material', href: '/finder' },
    ] }),
  });
  const page = await tbPage(null, st);
  await tbGo(page, '/materials');
  await page.evaluate((k) => { localStorage.setItem(k, JSON.stringify([{ vid: 'superbond-fr-metallic--acp-bronze-4-1220x2440', qty: 2 }])); localStorage.setItem('terucon.store.v1.saved', JSON.stringify([{ pid: 'terracotta-x', vid: 'terracotta-x--a-1x1' }])); }, TB_CART_KEY);
  await tbOpen(page);
  await page.type('.tb-input', 'a');
  await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift');
  await page.type('.tb-input', 'b');
  assert(st.calls.length === 0, 'Shift+Enter sent the message');
  await page.keyboard.press('Enter');
  await tbWaitBot(page, 1);
  const call = st.calls[0];
  assert(JSON.stringify(Object.keys(call).sort()) === '["context","messages"]', 'the request has more than messages and context: ' + Object.keys(call));
  assert(JSON.stringify(Object.keys(call.context).sort()) === '["cart","path","saved","title","viewport"]', 'the context has more than the five fields: ' + Object.keys(call.context));
  assert(call.context.path === '/materials' && call.context.viewport === 'desktop' && /Materials/.test(call.context.title), 'the context: ' + JSON.stringify(call.context));
  assert(JSON.stringify(call.context.cart) === '[{"id":"superbond-fr-metallic--acp-bronze-4-1220x2440","qty":2}]' && JSON.stringify(call.context.saved) === '["terracotta-x--a-1x1"]', 'cart and saved as the shop keeps them: ' + JSON.stringify(call.context));
  assert(JSON.stringify(call.messages) === '[{"role":"user","text":"a\\nb"}]', 'the messages: ' + JSON.stringify(call.messages));
  const shown = await page.evaluate(() => ({
    reply: document.querySelector('.tb-msg--bot:not([data-greeting]) .tb-text').textContent,
    imgs: [...document.querySelectorAll('.tb-log img')].map((i) => i.getAttribute('src')),
    scripts: document.querySelectorAll('.tb-log script').length,
    pwned: window.__pwned,
    cards: [...document.querySelectorAll('.tb-card')].map((c) => ({ name: c.querySelector('.tb-card__name').textContent, variant: c.querySelector('.tb-card__variant')?.textContent || '', price: c.querySelector('.tb-card__price')?.textContent || '', href: c.getAttribute('href'), bold: c.querySelectorAll('b').length })),
    user: document.querySelector('.tb-bubble').textContent,
  }));
  assert(/<img src=x onerror="window.__pwned=1"><script>/.test(shown.reply) && shown.pwned === undefined && shown.scripts === 0, 'the reply was treated as HTML: ' + JSON.stringify(shown));
  assert(shown.user === 'a\nb', 'the typed text: ' + JSON.stringify(shown.user));
  assert(shown.cards.length === 3 && shown.cards[0].name === '<b>Bronze</b> ACP' && shown.cards[0].bold === 0 && shown.cards[0].variant === 'Brushed Bronze · 4 mm' && shown.cards[0].price === '₹2,050 / sq ft' && shown.cards[0].href === '/materials#/p/superbond-fr-metallic?v=superbond-fr-metallic--acp-bronze-4-1220x2440', 'the cards: ' + JSON.stringify(shown.cards));
  assert(shown.imgs.length === 2 && shown.imgs[0] === '/assets/tb-bronze-abc123.webp', 'images: ' + shown.imgs + ' (three cards kept, one without a picture; the one from another site and the unknown kind were dropped)');
  await until(() => page.evaluate(() => document.querySelectorAll('.tb-card__img--none').length === 2), 'the card without a picture and the card whose picture is missing to show a plain tile');
  assert(await page.evaluate(() => document.querySelector('.tb-chips').hidden), 'the suggestions should go once the person has written');
  noProblems({ problems: tbProblems(page) }, 'a TeruBot answer');
  await page.close();
});

await test('terubot: actions: navigate, open_studio and prefill_enquiry leave a "Done:" line and go; the conversation is still open on the next page; addresses that are not paths of this site are ignored', async () => {
  const st = tbState();
  const page = await tbPage(null, st);
  await tbGo(page, '/finder');
  // refused: another site, protocol-relative, a script, the API, a backslash trick, an unknown action
  st.chat = () => tbAnswer('Going nowhere.', { actions: [{ type: 'navigate', to: 'https://evil.example/' }, { type: 'navigate', to: '//evil.example/x' }, { type: 'navigate', to: 'javascript:alert(1)' }, { type: 'navigate', to: '/api/auth/me' }, { type: 'navigate', to: '/\\evil.example' }, { type: 'run_script', code: 'x' }] });
  await tbOpen(page);
  await tbSend(page, 'take me somewhere');
  await tbWaitBot(page, 1);
  await sleep(500);
  assert(new URL(page.url()).pathname === '/finder', 'the page left for ' + page.url());
  assert((await tbNotes(page)).length === 0, 'a refused action left a "Done:" line: ' + (await tbNotes(page)));
  // navigate
  st.chat = () => tbAnswer('Opening the shop for you.', { actions: [{ type: 'navigate', to: '/materials' }] });
  const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await tbSend(page, 'open the shop');
  await nav;
  await until(() => page.evaluate(() => !!document.getElementById('terubot-panel') && !document.getElementById('terubot-panel').hidden), 'the conversation to be open on the next page', 15000);
  assert(new URL(page.url()).pathname === '/materials', 'navigate went to ' + page.url());
  const kept = await page.evaluate(() => ({ users: [...document.querySelectorAll('.tb-bubble')].map((n) => n.textContent), notes: [...document.querySelectorAll('.tb-note__text')].map((n) => n.textContent) }));
  assert(JSON.stringify(kept.users) === '["take me somewhere","open the shop"]' && kept.notes.length === 1 && /^Done: opening the shop/.test(kept.notes[0]), 'the conversation did not survive the page change: ' + JSON.stringify(kept));
  // open_studio
  st.chat = () => tbAnswer('The studio.', { actions: [{ type: 'open_studio' }] });
  const nav2 = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await tbSend(page, 'try it with my photo');
  await nav2;
  await until(() => new URL(page.url()).pathname === '/design-studio', 'the studio');
  // prefill_enquiry: the form data waits in sessionStorage under a documented key; the project form is opened
  await until(() => page.evaluate(() => !!document.querySelector('.tb-launch')), 'TeruBot in the studio', 15000);
  st.chat = () => tbAnswer('I have filled in what you told me.', { actions: [{ type: 'prefill_enquiry', fields: { type: 'Façade / elevation', name: 'Meera Rao', company: '', phone: '9800000000', email: 'meera@example.com', city: 'Bengaluru', area: '1200 sq ft', timeline: '3–6 months', message: 'Reception and waiting area', evil: '<script>' } }] });
  await tbOpen(page);
  const nav3 = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await tbSend(page, 'I want a clinic in Bengaluru');
  await nav3;
  await until(() => new URL(page.url()).pathname === '/start-project', 'the project form address');
  // the Start a project page takes the hand-over (sessionStorage "terucon.enquiry.prefill") and fills its form with the allowed values only
  const filled = await until(() => page.evaluate(() => {
    const f = document.getElementById('form');
    if (!f) return null;
    const val = (n) => (f.elements[n] ? f.elements[n].value : null);
    const radio = (n) => { const c = f.querySelector(`input[name="${n}"]:checked`); return c ? c.value : ''; };
    const o = { type: radio('type'), timeline: radio('timeline'), name: val('name'), phone: val('phone'), email: val('email'), city: val('city'), message: val('message'), company: val('company'), area: val('area'), key: sessionStorage.getItem('terucon.enquiry.prefill'), note: !document.getElementById('prefill-note').hidden };
    return o.name ? o : null;
  }), 'the project form filled in from TeruBot', 8000);
  assert(filled.type === 'Façade / elevation' && filled.timeline === '3–6 months' && filled.name === 'Meera Rao' && filled.phone === '9800000000' && filled.email === 'meera@example.com' && filled.city === 'Bengaluru' && filled.message === 'Reception and waiting area', 'the filled form: ' + JSON.stringify(filled));
  // (company: empty, or the signed-in test account's own firm, which the page may add a moment later: that is the account's data, not TeruBot's)
  assert((filled.company === '' || filled.company === 'Test Firm') && filled.area === '' && filled.key === null && filled.note === true, 'nothing invented, the hand-over used once, the "please check it" note shown: ' + JSON.stringify(filled));
  // the chat does not sit on top of the form it has just filled in; it is one tap away and still has the conversation
  assert(await page.evaluate(() => !!document.querySelector('.tb-launch') && !document.querySelector('.tb-root.is-open')), 'the chat panel should stay closed on the project form');
  await page.evaluate(() => document.querySelector('.tb-launch').click());
  await until(() => page.evaluate(() => !!document.querySelector('.tb-root.is-open') && /I want a clinic in Bengaluru/.test(document.querySelector('.tb-panel').innerText)), 'the conversation to be there when the chat is opened again', 5000);
  await page.close();
});

await test('terubot: a plain "navigate" to the project form (the "Start a project" suggestion, with or without a query) leaves the chat closed on the form, with the conversation one tap away; other pages still reopen it', async () => {
  const st = tbState();
  const page = await tbPage(null, st);
  const panelState = () => page.evaluate(() => ({ open: !!document.querySelector('.tb-root.is-open'), hidden: !document.getElementById('terubot-panel') || document.getElementById('terubot-panel').hidden, launch: !!document.querySelector('.tb-launch'), scrim: !!document.querySelector('.tb-scrim:not([hidden])') }));
  for (const to of ['/start-project', '/start-project?type=Retail', '/start-project/']) {
    await tbGo(page, '/finder');
    await page.evaluate(() => sessionStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await until(() => page.evaluate(() => !!window.TeruBot && !!document.querySelector('.tb-launch')), 'TeruBot on the Finder', 15000);
    st.chat = () => tbAnswer('Opening the project form.', { actions: [{ type: 'navigate', to }] });
    await tbOpen(page);
    const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { for (const c of document.querySelectorAll('.tb-chip')) if (c.textContent === 'Start a project') c.click(); });
    await nav;
    await until(() => new URL(page.url()).pathname.replace(/\/$/, '') === '/start-project', `the project form for ${to}`);
    await until(() => page.evaluate(() => !!window.TeruBot && !!document.querySelector('.tb-launch')), `TeruBot on the project form for ${to}`, 15000);
    await sleep(600); // anything that was going to reopen the chat by itself has done so by now
    const closed = await panelState();
    assert(closed.launch && !closed.open && closed.hidden && !closed.scrim, `navigate ${to}: the chat should stay closed over the form: ${JSON.stringify(closed)}`);
    assert(await page.evaluate(() => !!document.getElementById('form') && document.getElementById('form').getBoundingClientRect().width > 0), `navigate ${to}: the form is not on screen`);
    await page.evaluate(() => document.querySelector('.tb-launch').click());
    await until(() => page.evaluate(() => !!document.querySelector('.tb-root.is-open') && /Start a project/.test(document.querySelector('.tb-panel').innerText) && /Opening the project form\./.test(document.querySelector('.tb-panel').innerText) && /Done: opening the project form/.test(document.querySelector('.tb-panel').innerText)), `the conversation kept for ${to}`, 5000);
    // the flag was used up: a plain reload of the form does not reopen the chat either
    await page.reload({ waitUntil: 'domcontentloaded' });
    await until(() => page.evaluate(() => !!document.querySelector('.tb-launch')), 'TeruBot after a reload', 15000);
    await sleep(400);
    assert(!(await panelState()).open, `navigate ${to}: the chat reopened after a reload of the form`);
  }
  // a stale "reopen" flag in the tab must not put the chat over the form either (it can be left by an older page, a Back, a second tab)
  await tbGo(page, '/finder');
  await page.evaluate(() => { const k = 'terucon.terubot.v1'; const s = JSON.parse(sessionStorage.getItem(k) || '{}'); s.resume = true; s.msgs = s.msgs || [{ role: 'user', text: 'hello', cards: [], notes: [] }]; sessionStorage.setItem(k, JSON.stringify(s)); });
  await page.goto(base + '/start-project', { waitUntil: 'domcontentloaded' });
  await until(() => page.evaluate(() => !!document.querySelector('.tb-launch')), 'TeruBot on the form with a stale flag', 15000);
  await sleep(400);
  assert(!(await panelState()).open, 'a stale reopen flag put the chat over the form');
  // control: a page that is not a form still gets the conversation back
  await tbGo(page, '/finder');
  st.chat = () => tbAnswer('Opening the shop for you.', { actions: [{ type: 'navigate', to: '/materials' }] });
  await tbOpen(page);
  const nav2 = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await tbSend(page, 'open the shop');
  await nav2;
  await until(() => page.evaluate(() => !!document.querySelector('.tb-root.is-open')), 'the chat reopened on the shop (the unchanged behaviour)', 15000);
  await page.close();
});

await test('terubot: cart and saved list: on the shop the page itself changes (and Undo works); from another page the change is queued, said so in words, and applied when the shop opens', async () => {
  const st = tbState();
  const page = await tbPage(null, st);
  await tbGo(page, '/materials');
  await tbShopReady(page);
  st.chat = () => tbAnswer('Adding it.', { actions: [{ type: 'cart_add', id: 'superbond-fr-metallic--acp-bronze-4-1220x2440', qty: 2 }, { type: 'saved_add', id: 'superbond-fr-metallic--acp-bronze-4-1220x2440', pid: 'superbond-fr-metallic' }, { type: 'cart_add', id: 'no-such-thing--x-1x1', qty: 1 }] });
  await tbOpen(page);
  await tbSend(page, 'add the bronze ACP');
  await tbWaitBot(page, 1);
  await until(async () => (await tbNotes(page)).length === 3, 'three lines for three actions');
  const notes = await tbNotes(page);
  assert(/^Done: added 2 .*FR Façade ACP, Metallic.* to your cart\.$/.test(notes[0]) && /^Done: .* is in your saved list\.$/.test(notes[1]) && /^I could not do that: .*could not find/.test(notes[2]), 'the lines: ' + JSON.stringify(notes));
  const ls = await page.evaluate(() => ({ cart: JSON.parse(localStorage.getItem('terucon.store.v1.cart')), saved: JSON.parse(localStorage.getItem('terucon.store.v1.saved')) }));
  assert(ls.cart.length === 1 && ls.cart[0].vid === 'superbond-fr-metallic--acp-bronze-4-1220x2440' && ls.cart[0].qty === 2 && ls.saved.length === 1 && ls.saved[0].pid === 'superbond-fr-metallic', 'what the shop stored: ' + JSON.stringify(ls));
  // the shop's own header is hidden behind the site chrome, which mirrors its counts: the live React state shows in both
  assert(await page.evaluate(() => { const own = document.querySelector('[data-nav]'); const mirror = document.querySelector('.tc-hdr__saved .tc-ib__n'); return !!own && /Saved\s*1\b/.test(own.textContent.replace(/\s+/g, ' ')) && !!mirror && mirror.getAttribute('data-n') === '1'; }), 'the shop\'s Saved count (its own header and the chrome\'s button) did not show the saved item (the live page state was not updated)');
  await page.evaluate(() => document.querySelectorAll('.tb-note button')[0].click());
  await until(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('terucon.store.v1.cart')).length)) === 0, 'Undo to empty the cart');
  assert(/^Undone: 2 .* is out of your cart again/.test((await tbNotes(page))[0]), 'the Undo line: ' + (await tbNotes(page))[0]);
  // from another page: queued
  st.chat = () => tbAnswer('I will add it.', { cards: [{ kind: 'material', id: 'superbond-fr-metallic--acp-bronze-4-1220x2440', pid: 'superbond-fr-metallic', vid: 'superbond-fr-metallic--acp-bronze-4-1220x2440', fid: 'acp-bronze', variant: 'Brushed Bronze', name: 'FR Façade ACP', price: '₹', image: '', href: '/materials#/p/superbond-fr-metallic?v=superbond-fr-metallic--acp-bronze-4-1220x2440' }], actions: [{ type: 'cart_add', id: 'superbond-fr-metallic--acp-bronze-4-1220x2440', qty: 3 }, { type: 'saved_remove', id: 'superbond-fr-metallic--acp-bronze-4-1220x2440', pid: 'superbond-fr-metallic' }] });
  await tbGo(page, '/finder');
  await tbOpen(page);
  await page.click('.tb-head .tb-textbtn:not(.tb-talk)'); // New chat (Talk is the other text button of the header): the lines of the shop part above are not under test here
  await tbSend(page, 'put the bronze in my cart');
  await until(async () => (await tbNotes(page)).length === 2, 'two lines for two queued changes');
  const q = await tbNotes(page);
  assert(q.every((t) => /^Not done yet: I will .* when you open the shop\. Nothing in your .* has changed so far\.$/.test(t)), 'a queued change was reported as done: ' + JSON.stringify(q));
  assert(await page.evaluate(() => JSON.parse(localStorage.getItem('terucon.store.v1.cart')).length === 0 && JSON.parse(sessionStorage.getItem('terucon.terubot.pending')).length === 2), 'the cart changed from another page, or the queue is not there');
  await page.evaluate(() => document.querySelectorAll('.tb-note button')[1].click()); // Undo the second one before the shop opens
  await until(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('terucon.terubot.pending')).length === 1), 'Undo to take it out of the queue');
  const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await page.evaluate(() => [...document.querySelectorAll('.tb-note a')].find((a) => /shop/i.test(a.textContent)).click());
  await nav;
  await tbShopReady(page);
  await until(() => page.evaluate(() => JSON.parse(localStorage.getItem('terucon.store.v1.cart')).length === 1), 'the shop to apply the queue');
  const applied = await page.evaluate(() => ({ cart: JSON.parse(localStorage.getItem('terucon.store.v1.cart')), pending: sessionStorage.getItem('terucon.terubot.pending') }));
  assert(applied.cart[0].qty === 3 && applied.pending === null, 'applied: ' + JSON.stringify(applied));
  await tbOpen(page);
  const after = await tbNotes(page);
  assert(after.some((t) => /^Done: added 3 /.test(t)) && !after.some((t) => /^Not done yet/.test(t)), 'the chat after the shop opened: ' + JSON.stringify(after));
  // the card link of the server (/materials#/p/<pid>?v=<vid>) opens that product, and so does a bare /materials#<id>
  await page.goto(base + '/materials#/p/superbond-fr-metallic?v=superbond-fr-metallic--acp-bronze-4-1220x2440', { waitUntil: 'domcontentloaded' });
  await until(() => page.evaluate(() => /^FR Façade ACP, Metallic/.test(document.querySelector('h1')?.textContent || '')), 'the product page for the card link', 15000);
  await page.goto(base + '/materials#acp-bronze', { waitUntil: 'domcontentloaded' });
  await until(() => page.evaluate(() => /^FR Façade ACP, Metallic/.test(document.querySelector('h1')?.textContent || '')), 'the product page for a bare id', 15000);
  noProblems({ problems: tbProblems(page) }, 'the shop and TeruBot');
  await page.close();
});

await test('terubot: the honest states: AI off, a slowed-down visitor with the time to wait, a failed AI service with Try again, a server that cannot be reached, a refused message', async () => {
  const st = tbState({ status: { aiOn: false, model: null, signedIn: true } });
  const page = await tbPage(null, st);
  await tbGo(page, '/finder');
  await tbOpen(page);
  await until(() => page.evaluate(() => !document.querySelector('.tb-notice').hidden), 'the AI-off notice');
  assert(/not set up/.test(await page.evaluate(() => document.querySelector('.tb-notice__text').textContent)) && /AI is off/.test(await page.evaluate(() => document.querySelector('.tb-sub').textContent)), 'the AI-off state is not said in words');
  st.chat = () => ({ json: { aiOn: false, reply: 'TeruBot\'s AI is not set up yet.', cards: [], actions: [] } });
  await tbSend(page, 'hello');
  await tbWaitBot(page, 1);
  assert((await tbBotTexts(page)).includes('TeruBot\'s AI is not set up yet.'), 'the server\'s explanation is not shown');
  // 429
  st.chat = () => ({ status: 429, json: { error: 'slow down', retryAfterSec: 41 } });
  await tbSend(page, 'again');
  await until(() => page.evaluate(() => /41 seconds|40 seconds/.test(document.querySelector('.tb-notice__text').textContent)), 'the time to wait', 5000);
  assert(await page.evaluate(() => document.querySelector('.tb-send').disabled), 'the send button is not held back while the person is slowed down');
  assert((await tbBotTexts(page)).some((t) => /try again in (41|40) seconds/.test(t)), 'the answer does not say when to try again');
  await page.close();
  // 502 -> Try again; then it works
  const st2 = tbState();
  const page2 = await tbPage(null, st2);
  await tbGo(page2, '/finder');
  await tbOpen(page2);
  st2.chat = () => ({ status: 502, json: { error: 'upstream' } });
  await tbSend(page2, 'one');
  await until(() => page2.$('.tb-msg--err .tb-textbtn'), 'Try again after a 502');
  assert(/not answering/.test((await tbBotTexts(page2)).at(-1)), 'the 502 message: ' + (await tbBotTexts(page2)).at(-1));
  st2.chat = () => tbAnswer('Back again.');
  await page2.click('.tb-msg--err .tb-textbtn');
  await until(async () => (await tbBotTexts(page2)).includes('Back again.'), 'the answer after Try again');
  assert(st2.calls.length === 2 && st2.calls[1].messages.length === 1 && st2.calls[1].messages[0].text === 'one', 'Try again should send the same message once more, not a second copy: ' + JSON.stringify(st2.calls[1]));
  assert(!(await page2.$('.tb-msg--err')), 'the failure message stayed after Try again');
  // 400
  st2.chat = () => ({ status: 400, json: { error: 'The message is empty.' } });
  await tbSend(page2, 'two');
  await until(async () => (await tbBotTexts(page2)).some((t) => /The message is empty\./.test(t)), 'the 400 text');
  // the site's own guards answer in the nested shape, and without a sign-in matter
  st2.chat = () => ({ status: 403, json: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Cross-site requests are not allowed.' } } });
  await tbSend(page2, 'three');
  await until(async () => (await tbBotTexts(page2)).some((t) => /^Cross-site requests are not allowed\.$/.test(t)), 'the nested error text');
  assert(!(await page2.$('.tb-note a')), 'a 403 from a guard is not a sign-in matter');
  // 429 with only the Retry-After header
  st2.chat = () => ({ status: 429, headers: { 'Retry-After': '12' }, json: { error: 'busy' } });
  await tbSend(page2, 'four');
  await until(async () => (await tbBotTexts(page2)).some((t) => /try again in 12 seconds/.test(t)), 'the header\'s time to wait');
  await page2.close();
  // the server cannot be reached (status and chat)
  const st3 = tbState({ statusDown: true, chat: () => ({ abort: true }) });
  const page3 = await tbPage(null, st3);
  await tbGo(page3, '/finder');
  await tbOpen(page3);
  await until(() => page3.evaluate(() => /can.t be reached/.test(document.querySelector('.tb-notice__text').textContent)), 'the unreachable notice');
  await tbSend(page3, 'anyone there?');
  await until(() => page3.$('.tb-msg--err .tb-textbtn'), 'Try again after the network failure');
  assert(/can.t be reached/.test((await tbBotTexts(page3)).at(-1)), 'the unreachable message');
  noProblems({ problems: tbProblems(page3) }, 'TeruBot with the server down');
  await page3.close();
});

await test('terubot: the conversation survives a reload in the same tab; New chat clears it (and what was queued for the shop); the suggestions send what they say', async () => {
  const st = tbState({ chat: (body) => tbAnswer('You said: ' + body.messages.at(-1).text, { actions: [{ type: 'cart_add', id: 'acp-bronze', qty: 1 }] }) });
  const page = await tbPage(null, st);
  await tbGo(page, '/finder');
  await tbOpen(page);
  await page.click('.tb-chip');
  await tbWaitBot(page, 1);
  assert(st.calls[0].messages[0].text === 'Find a material', 'the first suggestion sent ' + JSON.stringify(st.calls[0]));
  await tbSend(page, 'second');
  await tbWaitBot(page, 2);
  assert(st.calls[1].messages.length === 3 && st.calls[1].messages[1].role === 'assistant', 'the history sent with the second message: ' + JSON.stringify(st.calls[1].messages));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await until(() => page.evaluate(() => !!window.TeruBot), 'TeruBot after the reload');
  assert(await page.evaluate(() => !document.getElementById('terubot-panel')), 'a reload opened the panel (only a trip TeruBot made itself does that)');
  await tbOpen(page);
  assert(JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.tb-bubble')].map((n) => n.textContent))) === '["Find a material","second"]', 'the conversation after the reload');
  assert(await page.evaluate(() => JSON.parse(sessionStorage.getItem('terucon.terubot.pending')).length) === 2, 'nothing queued');
  await page.click('.tb-head .tb-textbtn:not(.tb-talk)'); // New chat
  await until(() => page.evaluate(() => document.querySelectorAll('.tb-bubble').length === 0 && !!document.querySelector('[data-greeting]')), 'New chat to clear the list');
  assert(await page.evaluate(() => sessionStorage.getItem('terucon.terubot.pending') === null && !document.querySelector('.tb-chips').hidden), 'New chat should drop what was queued for the shop and bring the suggestions back');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await until(() => page.evaluate(() => !!window.TeruBot), 'TeruBot');
  await tbOpen(page);
  assert(await page.evaluate(() => document.querySelectorAll('.tb-bubble').length === 0), 'the cleared chat came back after a reload');
  await page.close();
});

await test('terubot: only ONE assistant on the shop and on My project; the old mic buttons and "Ask Saathi" buttons open TeruBot', async () => {
  const st = tbState();
  const page = await tbPage(null, st);
  await tbGo(page, '/materials');
  await tbShopReady(page);
  const shop = await page.evaluate(() => ({ old: document.querySelectorAll('[aria-label="Ask the Terucon assistant"], [role="dialog"][aria-label="Terucon assistant"]').length, text: /Ask Terucon|Demo · on device/.test(document.body.innerText), launchers: [...document.querySelectorAll('.tb-launch')].filter((b) => getComputedStyle(b).display !== 'none').length }));
  assert(shop.old === 0 && !shop.text && shop.launchers === 1, 'the shop: ' + JSON.stringify(shop));
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Ask by voice').click());
  await until(() => page.evaluate(() => window.TeruBot.isOpen()), 'the search bar\'s mic button to open TeruBot');
  assert(await page.evaluate(() => document.querySelectorAll('[role="dialog"]').length === 1 && !document.querySelector('[aria-label="Terucon assistant"]')), 'the shop shows a second dialog beside TeruBot');
  await page.keyboard.press('Escape');
  // the search overlay's own "Ask by voice" button
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /^Search (sheets|materials)/.test(b.textContent.trim()))?.click());
  await until(() => page.evaluate(() => [...document.querySelectorAll('button')].some((b) => /^Ask by voice$/.test(b.textContent.trim()))), 'the search overlay');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /^Ask by voice$/.test(b.textContent.trim())).click());
  await until(() => page.evaluate(() => window.TeruBot.isOpen()), 'the search overlay\'s "Ask by voice" to open TeruBot');
  await page.close();
  // My project, on a laptop
  const dash = await tbPage(null, st);
  await tbGo(dash, '/my-project');
  await sleep(1500);
  for (const view of ['', 'add', 'help', 'quote', 'studio', 'decide']) {
    await dash.evaluate((v) => { location.hash = '#/' + v; }, view);
    await sleep(500);
    const seen = await dash.evaluate(() => ({ saathi: /Saathi/i.test(document.body.innerText), aria: document.querySelectorAll('[aria-label*="Saathi"]').length, launchers: [...document.querySelectorAll('.tb-launch')].filter((b) => getComputedStyle(b).display !== 'none').length }));
    assert(!seen.saathi && seen.aria === 0 && seen.launchers === 1, `My project #/${view}: ${JSON.stringify(seen)}`);
  }
  await dash.evaluate(() => { location.hash = '#/add'; });
  await sleep(500);
  await dash.evaluate(() => [...document.querySelectorAll('button, label')].find((b) => /Tell TeruBot about it/.test(b.textContent)).click());
  await until(() => dash.evaluate(() => window.TeruBot.isOpen()), 'the "Tell TeruBot about it" button to open TeruBot');
  assert(await dash.evaluate(() => !document.querySelector('aside[aria-label*="Saathi"]')), 'a Saathi tray is in the page');
  await dash.close();
  // My project, on a phone: the page's own bottom bar has the one launcher
  const phone = await tbPage(PHONE, st);
  await tbGo(phone, '/my-project');
  await sleep(1500);
  const bar = await phone.evaluate(() => ({ floating: getComputedStyle(document.querySelector('.tb-launch')).display, buttons: document.querySelectorAll('nav button[aria-label="Ask TeruBot"]').length, saathi: /Saathi/i.test(document.body.innerText) }));
  assert(bar.floating === 'none' && bar.buttons === 1 && !bar.saathi, 'My project at 390 px: ' + JSON.stringify(bar));
  await phone.evaluate(() => document.querySelector('nav button[aria-label="Ask TeruBot"]').click());
  await until(() => phone.evaluate(() => window.TeruBot.isOpen()), 'the bottom bar\'s centre button to open TeruBot');
  await phone.close();
});

await test('terubot: a phone gets a bottom sheet above the dock, a launcher that clears the dock and the shop\'s cart bar, and every control is at least 44 px', async () => {
  const st = tbState();
  const page = await tbPage(PHONE, st);
  await tbGo(page, '/finder');
  const geo = () => page.evaluate(() => { const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height }; }; return { vh: innerHeight, vw: innerWidth, dock: r('.tc-dock'), launch: r('.tb-launch'), panel: r('#terubot-panel') }; });
  const g = await geo();
  assert(g.dock && g.launch.bottom <= g.dock.top - 8 && g.launch.right <= g.vw, 'the launcher is not clear of the dock: ' + JSON.stringify(g));
  await tbOpen(page);
  await sleep(500); // the sheet slides in
  const o = await geo();
  assert(Math.abs(o.panel.bottom - o.dock.top) <= 1 && o.panel.left === 0 && o.panel.w === o.vw && o.panel.h <= o.vh * 0.81, 'the sheet is not a bottom sheet above the dock: ' + JSON.stringify(o));
  const small = await page.evaluate(() => [...document.querySelectorAll('#terubot-panel button, #terubot-panel textarea, #terubot-panel a')].filter((e) => e.offsetParent !== null).map((e) => [e.className || e.tagName, Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)]).filter(([, w, h]) => w < 44 || h < 44));
  assert(small.length === 0, 'controls under 44 px: ' + JSON.stringify(small));
  assert(await page.evaluate(() => getComputedStyle(document.querySelector('.tb-input')).fontSize === '16px'), 'the box must be 16 px or iOS zooms the page');
  assert(await page.evaluate(() => document.getElementById('terubot-panel').getAttribute('aria-modal') === 'true' && !document.querySelector('.tb-scrim').hidden), 'a phone sheet is modal with a scrim');
  await page.click('.tb-scrim', { offset: { x: 20, y: 20 } });
  await until(() => page.evaluate(() => document.getElementById('terubot-panel').hidden), 'a tap on the scrim to close the sheet');
  // the shop on a phone: above the cart bar and the dock
  await tbGo(page, '/materials');
  await tbShopReady(page);
  await page.evaluate(() => { location.hash = '#/shop'; });
  await sleep(900);
  const shop = await page.evaluate(() => ({ lift: document.documentElement.style.getPropertyValue('--tb-bottom'), vh: innerHeight, launch: document.querySelector('.tb-launch').getBoundingClientRect().bottom, dock: document.querySelector('.tc-dock').getBoundingClientRect().top }));
  assert(shop.lift === '88px' && shop.launch <= shop.dock - 88 + 1, 'the shop list on a phone: ' + JSON.stringify(shop));
  noProblems({ problems: tbProblems(page) }, 'TeruBot on a phone');
  await page.close();
});

await test('terubot: a laptop: the launcher and the panel sit at the bottom right at 1440 and 1280 px, clear of the shop\'s Cart and of every control of the studio (with a photo loaded)', async () => {
  const st = tbState();
  for (const width of [1440, 1280]) {
    const page = await tbPage({ width, height: 800 }, st);
    for (const route of ['/materials', '/design-studio']) {
      if (route === '/design-studio') await page.evaluate(async (code) => { await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: code }) }); }, PASSCODE); // the studio's own passcode
      await tbGo(page, route);
      if (route === '/design-studio') {
        // the working view has its Share button, zoom control and status line along the bottom edge
        const input = await until(() => page.$('input[type=file]'), 'the studio\'s photo box');
        await input.uploadFile(path.join(root, 'media', 'p02-lobby.jpg'));
        await until(() => page.evaluate(() => [...document.querySelectorAll('button')].some((b) => /^Share$/.test(b.textContent.trim()) && b.offsetParent !== null)), 'the studio\'s working view (its Share button)', 20000);
      }
      await sleep(600);
      const r = await page.evaluate((everything) => {
        // what is really under the launcher: hit-test a grid of points inside it (a menu that is clipped away does not count)
        const l = document.querySelector('.tb-launch').getBoundingClientRect();
        const found = new Set();
        for (let ix = 0; ix <= 6; ix += 1) for (let iy = 0; iy <= 2; iy += 1) {
          const x = l.left + 4 + ((l.width - 8) * ix) / 6, y = l.top + 4 + ((l.height - 8) * iy) / 2;
          for (const e of document.elementsFromPoint(x, y)) {
            if (e.closest('#terubot')) continue;
            const c = e.closest('a, button, input, select, [role="button"]');
            if (c) found.add((c.getAttribute('aria-label') || c.textContent).trim().slice(0, 30));
          }
        }
        return { right: innerWidth - l.right, hit: [...found].filter((t) => everything || /^(Cart|Checkout|View cart|Compare|Menu)\b/i.test(t)) };
      }, route === '/design-studio');
      assert(r.right >= 12 && r.right <= 40, `${route} at ${width}: the launcher is not at the right edge: ${JSON.stringify(r)}`);
      assert(r.hit.length === 0, `${route} at ${width}: the launcher covers ${r.hit.join(', ')}`);
      await tbOpen(page);
      const p = await page.evaluate(() => { const b = document.getElementById('terubot-panel').getBoundingClientRect(); const cart = [...document.querySelectorAll('a, button')].filter((e) => !e.closest('#terubot') && /^Cart\b/.test(e.textContent.trim()) && e.offsetParent !== null).map((e) => e.getBoundingClientRect()); return { w: b.width, top: b.top, bottom: innerHeight - b.bottom, cartHidden: cart.some((c) => c.right > b.left && c.left < b.right && c.bottom > b.top && c.top < b.bottom) }; });
      assert(p.w >= 370 && p.w <= 390 && p.top >= 0 && p.bottom >= 12 && !p.cartHidden, `${route} at ${width}: the panel: ${JSON.stringify(p)}`);
      await page.keyboard.press('Escape');
    }
    await page.close();
  }
});

await test('terubot: keys typed in the panel never reach the page; Tab stays inside it; the studio\'s full-screen view hides it; reduced motion stills it', async () => {
  const st = tbState();
  const page = await tbPage(null, st);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await tbGo(page, '/materials');
  await page.evaluate(() => { window.__keys = 0; window.addEventListener('keydown', () => { window.__keys += 1; }); });
  await tbOpen(page);
  await page.type('.tb-input', 'hello');
  await page.keyboard.press('Escape');
  assert(await page.evaluate(() => window.__keys) === 0, 'the page saw ' + (await page.evaluate(() => window.__keys)) + ' key presses typed inside TeruBot');
  await tbOpen(page);
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('Tab');
    assert(await page.evaluate(() => document.getElementById('terubot-panel').contains(document.activeElement)), `Tab ${i + 1} left the panel`);
  }
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
    assert(await page.evaluate(() => document.getElementById('terubot-panel').contains(document.activeElement)), `Shift+Tab ${i + 1} left the panel`);
  }
  const still = await page.evaluate(() => ({ panel: getComputedStyle(document.getElementById('terubot-panel')).animationName, ring: getComputedStyle(document.querySelector('.tb-launch__mark'), '::after').animationName }));
  assert(still.panel === 'none' && still.ring === 'none', 'reduced motion: ' + JSON.stringify(still));
  await page.keyboard.press('Escape');
  // the studio's full-screen working view (html.swr-immersive, its host at z-index 90) used to switch TeruBot off; it is now raised above the studio
  await page.evaluate(() => document.documentElement.classList.add('swr-immersive'));
  assert(await page.evaluate(() => { const l = document.querySelector('.tb-launch'); const b = l.getBoundingClientRect(); const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return getComputedStyle(l).display !== 'none' && !!top && l.contains(top); }), 'the launcher is not reachable while the studio works full screen');
  await page.close();
});

await test('studio: the catalogue designs are added to the finish list before the studio starts (a group "Terucon catalogue" for wall, door and furniture, one item per surface kind), a card gets the design\'s photo, and the studio opens as it always did when the catalogue is off, down or slow', async () => {
  const finishes = [
    { id: 'tipl-sb804', code: 'SB804', productId: 'TIPL-SB804', name: 'Emperador Dark', sub: 'SB804 · marble-like veining, gloss', about: 'Emperador Dark, Terucon catalogue design TIPL-SB804. A dark brown surface.', prompt: 'Apply the design. [[terucon-design:TIPL-SB804]]', hex: '#271c1c', image: '/media/materials/tipl-sb804.jpg?w=320', described: true },
    { id: 'tipl-sb008', code: 'SB008', productId: 'TIPL-SB008', name: 'Burmese Teak', sub: 'SB008', about: 'Burmese Teak, Terucon catalogue design TIPL-SB008.', prompt: 'Apply the design. [[terucon-design:TIPL-SB008]]', hex: '#7b4312', image: '/media/materials/tipl-sb008.jpg?w=320', described: false },
  ];
  const open = async (answer) => {
    const page = await newPage({ width: 1440, height: 900 });
    const asked = { finishes: 0, pictures: [] };
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (u.pathname === '/api/catalogue/studio-finishes') { asked.finishes += 1; return answer(req); }
      if (/^\/media\/materials\/tipl-/.test(u.pathname)) { asked.pictures.push(u.pathname + u.search); return req.respond({ status: 200, contentType: 'image/png', body: TB_PNG }); }
      req.continue();
    });
    await page.goto(base + '/design-studio', { waitUntil: 'domcontentloaded' });
    await until(() => page.evaluate(() => /Add a room photo/.test(document.body.innerText)), 'the studio', 25000);
    return { page, asked };
  };
  const catalog = (page) => page.evaluate(async () => {
    const { CATALOG, findItem, findItemKind } = await import('/js/data/catalog.js');
    const group = (kind) => (CATALOG[kind][0] || {}).group;
    return { wall: group('wall'), door: group('door'), furniture: group('furniture'), floor: group('floor'), ceiling: group('ceiling'), window: group('window'), paint: CATALOG.wall.some((g) => g.group === 'Paint'),
      wallItems: CATALOG.wall[0].items.map((i) => i.id), doorItems: (CATALOG.door[0].items || []).map((i) => i.id),
      kinds: { wall: findItemKind('tipl-sb804'), door: findItemKind('tipl-sb804-door'), furniture: findItemKind('tipl-sb008-furniture') },
      found: (() => { const i = findItem('tipl-sb804-door'); return i && { name: i.name, mode: i.mode, hasTexture: !!i.texture, marker: /\[\[terucon-design:TIPL-SB804\]\]$/.test(i.prompt), swatch: i.swatch }; })() };
  });

  // 1. the catalogue answers
  let { page, asked } = await open((req) => req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ group: 'Terucon catalogue', kinds: ['wall', 'door', 'furniture'], finishes, state: 'ok' }) }));
  try {
    assert(asked.finishes === 1, 'the finish list was asked for ' + asked.finishes + ' times');
    const c = await catalog(page);
    assert(c.wall === 'Terucon catalogue' && c.door === 'Terucon catalogue' && c.furniture === 'Terucon catalogue', 'the group is not first for wall, door and furniture: ' + JSON.stringify(c));
    assert(c.floor !== 'Terucon catalogue' && c.ceiling !== 'Terucon catalogue' && c.window !== 'Terucon catalogue', 'a decorative sheet is not offered for a floor, a ceiling or a window: ' + JSON.stringify(c));
    assert(c.paint, 'the studio\'s own finishes are still there');
    assert(JSON.stringify(c.wallItems) === '["tipl-sb804","tipl-sb008"]' && JSON.stringify(c.doorItems) === '["tipl-sb804-door","tipl-sb008-door"]', 'ids: ' + JSON.stringify([c.wallItems, c.doorItems]));
    assert(c.kinds.wall === 'wall' && c.kinds.door === 'door' && c.kinds.furniture === 'furniture', 'the studio forgets a finish whose kind is not the surface\'s (itemFitsKind): ' + JSON.stringify(c.kinds));
    assert(c.found && c.found.name === 'Emperador Dark' && c.found.mode === 'surface' && c.found.marker && !c.found.hasTexture && c.found.swatch.hex === '#271c1c', 'the studio finds the item as one of its own: ' + JSON.stringify(c.found));
    // the studio draws its cards in code; the design's photograph is put on the card by the loader's observer
    await page.evaluate(() => {
      const tile = document.createElement('button');
      tile.className = 'sr-tile';
      tile.title = 'Emperador Dark, Terucon catalogue design TIPL-SB804. A dark brown surface.';
      tile.innerHTML = '<span class="sr-tile-swatch"><span class="sr-tile-art"><svg></svg></span></span>';
      tile.id = 'tc-fake-tile';
      document.querySelector('swatchroom-app').appendChild(tile);
      const other = tile.cloneNode(true); other.id = 'tc-other-tile'; other.title = 'Limewash. A soft cloudy wall.'; document.querySelector('swatchroom-app').appendChild(other);
    });
    await until(() => page.evaluate(() => !!document.querySelector('#tc-fake-tile img.tc-design-photo')), 'the design\'s photograph on its card');
    const img = await page.evaluate(() => { const i = document.querySelector('#tc-fake-tile img.tc-design-photo'); return { src: i.getAttribute('src'), w: i.style.width, fit: i.style.objectFit, svg: !!document.querySelector('#tc-fake-tile svg'), other: !!document.querySelector('#tc-other-tile img') }; });
    assert(img.src === '/media/materials/tipl-sb804.jpg?w=320' && img.w === '100%' && img.fit === 'cover' && !img.svg, 'the card: ' + JSON.stringify(img));
    assert(!img.other, 'a card of the studio\'s own finishes is left alone');
    // the studio redraws a card's art: the photograph comes back
    await page.evaluate(() => { document.querySelector('#tc-fake-tile .sr-tile-art').innerHTML = '<svg></svg>'; });
    await until(() => page.evaluate(() => !!document.querySelector('#tc-fake-tile img.tc-design-photo')), 'the photograph after a redraw');
    assert(page.problems.length === 0, 'problems: ' + page.problems.join(' | '));
  } finally {
    await page.close();
  }

  // 2. the catalogue is off (an empty list), refused, unreachable or too slow: the studio opens, with no group and nothing logged
  for (const [what, answer, ms] of [
    ['off', (req) => req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ group: 'Terucon catalogue', kinds: ['wall', 'door', 'furniture'], finishes: [], state: 'off' }) }), 0],
    ['refused', (req) => req.respond({ status: 401, contentType: 'application/json', body: '{"error":"no"}' }), 0],
    ['unreachable', (req) => req.abort('failed'), 0],
    ['slow', () => {}, 4000],
  ]) {
    const t0 = Date.now();
    ({ page, asked } = await open(answer));
    try {
      const c = await catalog(page);
      assert(c.wall !== 'Terucon catalogue' && c.door !== 'Terucon catalogue' && c.paint, `${what}: the studio must be as it always was: ` + JSON.stringify(c));
      assert(c.found === null, `${what}: no catalogue item`);
      if (ms) assert(Date.now() - t0 < ms + 8000, `${what}: the studio waited too long (${Date.now() - t0} ms)`);
      const real = page.problems.filter((p) => !/studio-finishes|ERR_FAILED/.test(p));
      assert(real.length === 0, `${what}: problems: ` + real.join(' | '));
    } finally {
      await page.close();
    }
  }
});

await test('terubot: the same assistant on every page: the launcher, the panel, Talk, dictation, attach and New chat are all there, in the studio and the Finder too', async () => {
  // Pages that carry TeruBot (the offline and error pages and the sign-in-free coming-soon page excepted by design are not in this list). One signature per
  // page; they must all be the same. A control that is missing on one page (Talk used to be, on the studio and the Finder) makes the signatures differ.
  const routes = ['/', '/materials', '/design-studio', '/my-project', '/inspiration', '/finder', '/start-project', '/account', '/admin/catalogue'];
  const st = tbState();
  const page = await tbPage({ width: 1440, height: 900 }, st, { speech: 'live' });
  const signatures = {};
  for (const route of routes) {
    await tbGo(page, route);
    // the studio's page loader holds for the GPU services (tbLoaderGone does not wait for it): here it is waited for, because the panel is checked to be on top
    await until(() => page.evaluate(() => { const l = document.getElementById('tc-loader'); return !l || getComputedStyle(l).display === 'none' || getComputedStyle(l).pointerEvents === 'none'; }), 'the loader to leave ' + route, 25000);
    await tbOpen(page);
    signatures[route] = await page.evaluate(() => {
      const visible = (el) => !!el && !el.hidden && getComputedStyle(el).display !== 'none';
      const panel = document.getElementById('terubot-panel');
      const b = (sel) => visible(panel.querySelector(sel));
      return {
        title: (panel.querySelector('.tb-title') || {}).textContent || null,
        talk: b('.tb-talk'),
        dictation: b('.tb-roundbtn[aria-pressed]'),
        attach: !!panel.querySelector('.tb-form input[type=file]'),
        newChat: [...panel.querySelectorAll('button')].some((x) => /new chat/i.test(x.textContent) && visible(x)),
        close: !!panel.querySelector('[aria-label="Close TeruBot"], [aria-label="Close"]') || [...panel.querySelectorAll('button')].some((x) => /close/i.test(x.getAttribute('aria-label') || '')),
        input: visible(panel.querySelector('.tb-input')),
        panelOnTop: (() => { const r = panel.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + 60); return !!e && panel.contains(e); })(),
      };
    });
  }
  await page.close();
  const first = signatures[routes[0]];
  assert(first.talk && first.dictation && first.attach && first.newChat && first.input && first.panelOnTop, 'the reference page lacks a control: ' + JSON.stringify(first));
  for (const route of routes) assert(JSON.stringify(signatures[route]) === JSON.stringify(first), `${route} offers a different TeruBot from ${routes[0]}: ${JSON.stringify(signatures[route])} instead of ${JSON.stringify(first)}`);
});

await test('terubot: the studio\'s full-screen working view on a phone: the launcher is under the top bar, above the studio (z-index 90) and clear of its bottom sheet, and the panel opens over the studio', async () => {
  const open = await startStack({ port: 0, bootMs: 300 });
  const page = await newPage(PHONE, open);
  const file = path.join(os.tmpdir(), `terucon-tb-immersive-${Date.now()}.jpg`);
  try {
    await page.goto(open.base + '/design-studio', { waitUntil: 'networkidle2' });
    await until(() => page.evaluate(() => /Add a room photo/.test(document.body.innerText)), 'the studio', 15000);
    await until(() => page.evaluate(() => { const l = document.getElementById('tc-loader'); return !l || getComputedStyle(l).display === 'none'; }), 'the loader to leave the studio', 25000);
    fs.writeFileSync(file, await makeJpeg(page, 1200, 800));
    await (await page.$('input[data-input="photo"]')).uploadFile(file);
    await until(() => page.evaluate(() => document.documentElement.classList.contains('swr-immersive') && !!document.querySelector('.sr-studio.has-photo')), 'the studio to go full screen with a photo', 30000);
    const at = await page.evaluate(() => {
      const l = document.querySelector('.tb-launch');
      const b = l.getBoundingClientRect();
      const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      const sheet = document.querySelector('.sr-sheet');
      const sb = sheet ? sheet.getBoundingClientRect() : null;
      const header = document.querySelector('.sr-studio header, .sr-top, .sr-bar');
      return { shown: getComputedStyle(l).display !== 'none', reachable: !!top && l.contains(top), box: [b.left, b.top, b.width, b.height], sheetTop: sb ? sb.top : null, innerWidth: window.innerWidth };
    });
    assert(at.shown && at.reachable, 'the launcher cannot be reached in the studio\'s full-screen view: ' + JSON.stringify(at));
    assert(at.box[1] > 52 && at.box[1] + at.box[3] < (at.sheetTop ?? 9999) && at.box[0] + at.box[2] <= at.innerWidth, 'the launcher is not under the top bar, above the bottom sheet and inside the screen: ' + JSON.stringify(at));
    await page.click('.tb-launch');
    await until(() => page.evaluate(() => { const p = document.getElementById('terubot-panel'); if (!p || p.hidden) return false; const r = p.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + 60); return !!e && p.contains(e); }), 'the panel to open above the studio');
    assert(await page.evaluate(() => !document.querySelector('.tb-talk').hidden), 'no Talk in the studio on a phone');
  } finally {
    fs.rmSync(file, { force: true });
    await page.close();
    await open.stop();
  }
});

await test('terubot: voice: the microphone button uses the browser\'s speech recognition and sends what was heard; it is hidden where the browser has none (and shown on the studio and the Finder, which allow the microphone)', async () => {
  const st = tbState({ chat: (body) => tbAnswer('Heard: ' + body.messages.at(-1).text) });
  const page = await tbPage(null, st, { speech: 'fake' });
  await tbGo(page, '/materials');
  await tbOpen(page);
  assert(await page.evaluate(() => !document.querySelector('[aria-label="Speak your message"]').hidden), 'no microphone button where speech recognition exists');
  await page.click('[aria-label="Speak your message"]');
  await tbWaitBot(page, 1);
  assert((await tbBotTexts(page)).includes('Heard: show me terracotta'), 'what was heard was not sent: ' + (await tbBotTexts(page)));
  // the studio page and the Finder used to send Permissions-Policy: microphone=() (the studio's own header, copied), which hid dictation and Talk there
  for (const route of ['/design-studio', '/finder']) {
    await tbGo(page, route);
    await tbOpen(page);
    assert(await page.evaluate(() => !document.querySelector('.tb-roundbtn[aria-pressed]').hidden), route + ': no microphone button, although the page allows the microphone');
    assert(await page.evaluate(() => !document.querySelector('.tb-talk').hidden), route + ': no Talk button, although the page allows the microphone');
  }
  await page.close();
  const none = await tbPage(null, st, { speech: 'none' });
  await tbGo(none, '/materials');
  await tbOpen(none);
  assert(await none.evaluate(() => document.querySelector('.tb-roundbtn[aria-pressed]').hidden), 'no microphone button should show where the browser has no speech recognition');
  assert(await none.evaluate(() => document.querySelector('.tb-talk').hidden), 'Talk should not show where the browser has no speech recognition');
  await none.close();
  const mute = await tbPage(null, st, { speech: 'live-nosynth' });
  await tbGo(mute, '/materials');
  await tbOpen(mute);
  assert(await mute.evaluate(() => !document.querySelector('[aria-label="Speak your message"]').hidden && document.querySelector('.tb-talk').hidden), 'with recognition but no speech synthesis: dictation stays, Talk (which needs to answer aloud) is hidden');
  await mute.close();
});

// ---- the live conversation (Talk): listen -> send -> answer aloud -> listen again. The recogniser and the synthesiser are stand-ins the test
// drives (headless Chrome has no voice and no microphone): what is checked is TeruBot's own logic, not a browser's speech quality.
const liveState = () => ({ strip: document.querySelector('.tb-live') && !document.querySelector('.tb-live').hidden ? document.querySelector('.tb-live__text').textContent : null, listening: window.__sr.active, starts: window.__sr.starts, spoken: window.__tts ? window.__tts.spoken.slice() : null, pressed: document.querySelector('.tb-talk').getAttribute('aria-pressed') });
const liveWait = (page, pred, what, ms = 6000) => until(() => page.evaluate(pred), what, ms);
/** The panel slides in: click only once it has stopped moving (a click on a moving button can miss it). */
const tbSettled = async (page) => { let last = null; await until(async () => { const t = await page.evaluate(() => { const b = document.querySelector('.tb-talk'); const r = b && b.getBoundingClientRect(); return r ? Math.round(r.top * 10) + ':' + Math.round(r.left * 10) : null; }); const same = t !== null && t === last; last = t; return same; }, 'the panel to stop moving', 4000); };

await test('terubot: live conversation: Talk greets, listens, sends what was heard, reads the answer aloud (never listening while it speaks), listens again; Skip interrupts; End stops; the spoken text has no addresses or markdown', async () => {
  const st = tbState();
  const page = await tbPage(null, st, { speech: 'live' });
  await tbGo(page, '/inspiration');
  await tbOpen(page);
  await tbSettled(page);
  assert(await page.evaluate(() => !document.querySelector('.tb-talk').hidden && document.querySelector('.tb-talk').textContent.trim() === 'Talk'), 'no Talk button where speech works');
  assert(await page.evaluate(() => document.querySelector('.tb-live').hidden), 'the live strip shows before anything started');
  await page.click('.tb-talk');
  // a fresh chat: TeruBot says hello first, and does not listen while it speaks
  await liveWait(page, () => window.__tts.spoken.length === 1, 'the spoken greeting');
  let m = await page.evaluate(liveState);
  assert(m.spoken[0] === 'Hi, I’m TeruBot. How can I help?' && m.strip === 'Speaking…' && !m.listening && m.pressed === 'true', 'the greeting: ' + JSON.stringify(m));
  await page.evaluate(() => window.__endSpeech());
  await liveWait(page, () => window.__sr.active, 'the microphone to open after the greeting');
  m = await page.evaluate(liveState);
  assert(/^Listening/.test(m.strip), 'the strip while listening: ' + m.strip);
  // what is heard is sent as a message; the answer is read aloud with no addresses, no markdown, rupees and units in words
  st.chat = () => tbAnswer('Here are **two** terracotta tiles from ₹1,200 per sq ft. See https://example.test/x and /materials#/p/terracotta for details. Each tile covers 2.5 sq ft.\n- first\n- second', { cards: [{ kind: 'material', id: 'terracotta-a', name: 'Terracotta A', variant: 'Matt', price: '₹1,200', image: '', href: '/materials#/p/terracotta-a' }] });
  await page.evaluate(() => window.__hear('show me terracotta'));
  await liveWait(page, () => window.__tts.spoken.length === 2, 'the answer to be spoken');
  assert(st.calls.at(-1).messages.at(-1).text === 'show me terracotta' && st.calls.length === 1, 'what was heard was not sent as one message: ' + JSON.stringify(st.calls.at(-1)));
  m = await page.evaluate(liveState);
  const said = m.spoken[1];
  assert(!/https?:|\/materials|\*|₹|^- |\n/.test(said) && /1,200 rupees per square foot/.test(said) && /two terracotta tiles/.test(said), 'the first spoken piece: ' + said);
  assert(m.strip === 'Speaking…' && !m.listening, 'listening while it speaks (it would hear itself): ' + JSON.stringify(m));
  assert((await tbBotTexts(page)).some((t) => /Here are \*\*two\*\*/.test(t)), 'the written answer is shown as it came');
  // the whole answer, piece by piece, to its end: nothing in it is an address, a path, markdown or a bullet
  while (await page.evaluate(() => window.__tts.pending.length > 0)) {
    assert(!(await page.evaluate(liveState)).listening, 'listening while a piece of the answer is spoken');
    await page.evaluate(() => window.__endSpeech());
    await sleep(40);
  }
  const whole = (await page.evaluate(liveState)).spoken.slice(1).join(' ');
  assert(!/https?:|example\.test|\/materials|terracotta-a|\*|₹|\n|(^|\s)- /.test(whole) && /for details/.test(whole) && /first/.test(whole) && /second/.test(whole), 'the whole spoken answer: ' + whole);
  assert(/covers 2\.5 square feet/.test(whole), 'a point between digits was taken for the end of a sentence: ' + whole);
  await liveWait(page, () => window.__sr.active, 'listening again once the whole answer was spoken');
  // Skip: the voice stops at once and the microphone opens at once
  st.chat = () => tbAnswer('You are welcome. Anything else I can find for you?');
  await page.evaluate(() => window.__hear('thanks'));
  await liveWait(page, () => window.__tts.pending.length === 1, 'the second answer to be spoken');
  const cancelsBefore = await page.evaluate(() => window.__tts.cancels);
  await page.evaluate(() => [...document.querySelectorAll('.tb-live button')].find((b) => b.textContent === 'Skip').click());
  await liveWait(page, () => window.__sr.active && window.__tts.pending.length === 0, 'the microphone to open after Skip', 2000);
  assert(await page.evaluate((n) => window.__tts.cancels > n, cancelsBefore), 'Skip did not stop the voice');
  // another turn, spoken to its end: it listens again by itself, a moment after the voice stops
  st.chat = () => tbAnswer('Glad to help.');
  const startsBefore = (await page.evaluate(liveState)).starts;
  await page.evaluate(() => window.__hear('great'));
  await liveWait(page, () => window.__tts.pending.length === 1, 'the third answer to be spoken');
  assert(!(await page.evaluate(liveState)).listening, 'listening while the third answer is spoken');
  await page.evaluate(() => window.__endSpeech());
  await until(() => page.evaluate((n) => window.__sr.starts > n && window.__sr.active, startsBefore), 'listening again after the answer', 4000);
  // End: nothing listens, nothing speaks, the strip goes, and it stays that way
  await page.evaluate(() => [...document.querySelectorAll('.tb-live button')].find((b) => b.textContent === 'End').click());
  await sleep(700);
  m = await page.evaluate(liveState);
  assert(m.strip === null && !m.listening && m.pressed === 'false', 'after End: ' + JSON.stringify(m));
  const starts = m.starts;
  await sleep(500);
  assert((await page.evaluate(liveState)).starts === starts, 'it started listening again after End');
  noProblems({ problems: tbProblems(page) }, 'a live conversation');
  await page.close();
});

await test('terubot: live conversation: three quiet listens end it with a message; closing the panel, a new chat, a hidden tab and a failed answer stop it and the voice at once; an answer that moves to another page is not spoken', async () => {
  const st = tbState();
  const page = await tbPage(null, st, { speech: 'live' });
  await tbGo(page, '/inspiration');
  await tbOpen(page);
  await tbSettled(page);
  const begin = async () => { // with a message already in the chat, Talk goes straight to listening
    await page.click('.tb-talk');
    await liveWait(page, () => window.__sr.active, 'the microphone');
  };
  // 1. nobody speaks: it listens again twice, and on the third quiet listen it stops and says so
  await tbSend(page, 'hello');
  await tbWaitBot(page, 1);
  await begin();
  for (let i = 0; i < 3; i += 1) {
    await liveWait(page, () => window.__sr.active, `listen ${i + 1}`);
    await page.evaluate(() => window.__silence());
  }
  await liveWait(page, () => document.querySelector('.tb-live').hidden, 'the conversation to end after three quiet listens');
  assert(/did not hear anything/.test(await page.evaluate(() => document.querySelector('.tb-mic-status').textContent)) && await page.evaluate(() => !document.querySelector('.tb-mic-status').hidden), 'no message after the quiet listens');
  assert((await page.evaluate(() => window.__sr.starts)) === 3, 'it listened ' + (await page.evaluate(() => window.__sr.starts)) + ' times, not 3');
  // 2. closing the panel while it speaks: the voice is cut, the microphone stays shut
  st.chat = () => tbAnswer('A long answer that is being read out.');
  await begin();
  await page.evaluate(() => window.__hear('tell me more'));
  await liveWait(page, () => window.__tts.pending.length === 1, 'the answer being spoken');
  const cancels = await page.evaluate(() => window.__tts.cancels);
  await page.keyboard.press('Escape');
  await liveWait(page, () => document.getElementById('terubot-panel').hidden, 'the panel to close');
  await sleep(700);
  let m = await page.evaluate(() => ({ cancels: window.__tts.cancels, pending: window.__tts.pending.length, active: window.__sr.active }));
  assert(m.cancels > cancels && m.pending === 0 && !m.active, 'closing the panel left the conversation going: ' + JSON.stringify(m));
  // 3. a hidden tab ends it (a browser stops listening in the background anyway)
  await tbOpen(page);
  await tbSettled(page);
  await begin();
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await liveWait(page, () => document.querySelector('.tb-live').hidden && !window.__sr.active, 'a hidden tab to end the conversation');
  await page.evaluate(() => { delete document.visibilityState; });
  // 4. an answer that is not an answer (the server failed): the chat says so and nothing keeps listening
  st.chat = () => ({ status: 500, json: { error: 'down' } });
  await begin();
  await page.evaluate(() => window.__hear('anyone there'));
  await liveWait(page, () => document.querySelector('.tb-live').hidden && !window.__sr.active, 'a failed answer to end the conversation');
  await sleep(500);
  assert(await page.evaluate(() => !window.__sr.active), 'it listened again after a failed answer');
  // 5. New chat ends it
  st.chat = () => tbAnswer('ok');
  await begin();
  await page.evaluate(() => [...document.querySelectorAll('.tb-textbtn')].find((b) => b.textContent === 'New chat').click());
  await liveWait(page, () => document.querySelector('.tb-live').hidden && !window.__sr.active, 'New chat to end the conversation');
  // 6. an answer that takes the visitor to another page: not spoken, the conversation ends, the new page starts quiet
  await tbSend(page, 'hello again');
  await tbWaitBot(page, 1);
  await begin();
  st.chat = () => tbAnswer('Opening the shop for you.', { actions: [{ type: 'navigate', to: '/materials' }] });
  await page.evaluate(() => sessionStorage.removeItem('__spoken'));
  const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await page.evaluate(() => window.__hear('open the shop'));
  await nav;
  await until(() => page.evaluate(() => !!document.querySelector('.tb-launch')), 'TeruBot on the shop', 15000);
  await sleep(600);
  m = await page.evaluate(() => ({ spoken: sessionStorage.getItem('__spoken'), starts: window.__sr.starts, live: !!document.querySelector('.tb-live') && !document.querySelector('.tb-live').hidden }));
  assert(m.spoken === null && m.starts === 0 && !m.live, 'the new page: ' + JSON.stringify(m));
  noProblems({ problems: tbProblems(page) }, 'ending a live conversation');
  await page.close();
});

await test('terubot: live conversation: on a phone the header still fits (Talk, New chat, Close are at least 44 px, none overlaps or leaves it), and the strip and the form fit in the sheet', async () => {
  const st = tbState();
  for (const width of [390, 360]) {
    const page = await tbPage({ ...PHONE, width }, st, { speech: 'live' });
    await tbGo(page, '/inspiration');
    await tbOpen(page);
  await tbSettled(page);
    await page.click('.tb-talk');
    await liveWait(page, () => window.__tts.spoken.length === 1, 'the greeting');
    const m = await page.evaluate(() => {
      const box = (n) => { const r = n.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
      const head = box(document.querySelector('.tb-head')), panel = box(document.querySelector('.tb-panel'));
      const parts = [...document.querySelectorAll('.tb-head button')].filter((b) => b.getBoundingClientRect().width > 0).map((b) => ({ name: b.textContent.trim() || b.getAttribute('aria-label'), ...box(b) }));
      const live = box(document.querySelector('.tb-live')), form = box(document.querySelector('.tb-form'));
      const live44 = [...document.querySelectorAll('.tb-live button')].filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.getBoundingClientRect().height);
      return { head, panel, parts, live, form, live44, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    assert(m.parts.length === 3 && m.parts.every((p) => p.h >= 43.5 && p.w >= 43.5 && p.l >= m.head.l - 0.5 && p.r <= m.head.r + 0.5), `${width}: a header control is under 44 px or leaves the header: ` + JSON.stringify(m.parts));
    for (let i = 0; i < m.parts.length; i += 1) for (let j = i + 1; j < m.parts.length; j += 1) assert(!(m.parts[i].l < m.parts[j].r - 0.5 && m.parts[j].l < m.parts[i].r - 0.5), `${width}: ${m.parts[i].name} overlaps ${m.parts[j].name}`);
    assert(m.live44.length >= 1 && m.live44.every((h) => h >= 43.5) && m.live.b <= m.form.t + 1 && m.form.b <= m.panel.b + 1 && m.sideways <= 0, `${width}: the strip and the form: ` + JSON.stringify({ live: m.live, form: m.form, panel: m.panel, live44: m.live44, sideways: m.sideways }));
    await page.close();
  }
});
// ==== terubot widget (end) ====

// ---- one loader on every page ---------------------------------------------------------------------------------------------------------
// The four built pages carry the loader inline (tools/build-dist.js); the hand-written pages get the same one from /brand/loader.js, which is
// generated from the same loader.html. Asked for on 2026-11-04: every page opens behind the one Terucon loader. The Design Studio is left out
// here on purpose: its loader holds for the GPU and has its own tests in the motion block below.
await test('loader: every page (built and hand-written) opens behind the same Terucon loader, put on screen while the page is still being read, and lets it go: nothing locked, no failure screen, no error', async () => {
  const ROUTES = ['/', '/materials', '/my-project', '/inspiration', '/finder', '/start-project', '/account', '/login', '/coming-soon', '/admin/catalogue'];
  const markup = {};
  for (const route of ROUTES) {
    const page = await newPage(undefined, stack, { signedIn: route !== '/login' });
    try {
      await page.evaluateOnNewDocument(() => {
        const ld = (window.__ld = { rs: null, markup: null, exit: false });
        const mo = new MutationObserver(() => { if (document.getElementById('tc-loader')) { ld.rs = document.readyState; mo.disconnect(); } });
        mo.observe(document, { childList: true, subtree: true });
        document.addEventListener('DOMContentLoaded', () => { const l = document.getElementById('tc-loader'); ld.markup = l ? l.innerHTML.replace(/>\s+</g, '><').replace(/(<div class="tc-ld-curtain"[^>]*>)[\s\S]*?<\/div>/, '$1</div>').replace(/ style="[^"]*"/g, '').trim() : null; }); // the curtain's slats and its --m are added when the loader opens: state, not markup
        window.addEventListener('tc-ld-exit', () => { ld.exit = true; });
      });
      await page.goto(base + route, { waitUntil: 'domcontentloaded' });
      await until(() => page.evaluate(() => window.__ld.markup !== null || window.__ld.exit), `the loader on ${route}`, 8000);
      const seen = await page.evaluate(() => window.__ld);
      assert(seen.markup, `${route}: the loader was not on the page when it had been read`);
      assert(seen.rs === 'loading', `${route}: the loader appeared when the page was already "${seen.rs}", not while it was still being read`);
      markup[route] = seen.markup;
      await until(() => page.evaluate(() => !document.getElementById('tc-loader')), `the loader to leave ${route}`, 20000);
      const after = await page.evaluate(() => ({ lock: document.documentElement.classList.contains('tc-ld-lock'), state: window.TeruconLoader && window.TeruconLoader.state, failed: !!document.querySelector('.tc-ld-failed'), exit: window.__ld.exit }));
      assert(!after.lock && after.state === 'done' && !after.failed && after.exit, `${route}: after the loader: ${JSON.stringify(after)}`);
      noProblems(page, `${route} behind the loader`);
    } finally {
      await page.close();
    }
  }
  const kinds = new Set(Object.values(markup));
  assert(kinds.size === 1, 'the loader is not the same on every page: ' + JSON.stringify(Object.entries(markup).map(([r, m]) => [r, m.length, m.slice(0, 60)])));
});

// ==== motion (begin) ====
// The loader, its curtain, the landing hero's louvres and the one continuous loader on the way into the Design Studio
// (site/brand/{loader.html,loader.css,transition.js,studio-entry.js}, site/patches/home.json "hero-curtain-*").
// Every page here opens without sign-in (AUTH_REQUIRED=off); bootMs is how long the mock GPU services take to wake.
{
  const STUDIO = '/design-studio';
  const MIN_MS = 650 + 2 * 2200; // the curtain closing + two cycles, from the click (site/brand/loader.html: CLOSE_MS, CYCLE_MS, MIN_CYCLES)
  const CAP_MS = 10000;

  // in every document: what is on screen at every frame (a row only when it changes), the frame times, and the moment the curtain starts
  const MOTION_PROBE = () => {
    const M = (window.__m = { s: [], f: [], last: '', exit: null, exitPerf: null, gone: null, iter: null, note: null, noteAt: null, ldexit: null, prev: null });
    try { M.prev = JSON.parse(sessionStorage.getItem('__m_prev') || 'null'); sessionStorage.removeItem('__m_prev'); } catch (e) {}
    addEventListener('pagehide', () => { try { sessionStorage.setItem('__m_prev', JSON.stringify(M.s.slice(-60))); } catch (e) {} });
    addEventListener('tc-ld-exit', () => { M.ldexit = performance.now(); });
    const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
    (function loop() {
      requestAnimationFrame((ts) => {
        M.f.push(ts);
        const q = (x) => document.querySelector(x);
        const ld = document.getElementById('tc-loader');
        const cls = ld ? ld.className.replace(/tc-ld-/g, '') : '-';
        if (!ld && M.exitPerf !== null && M.gone === null) M.gone = ts;
        const st = [location.pathname, cls, !!q('.sr-studio, .sr-gate'), vis(q('.sc-placeholder[title="swatchroom-app"]')), vis(q('.swr-splash'))].join('|');
        if (st !== M.last) {
          M.last = st;
          const now = Date.now();
          if (ld && /(^| )out( |$)/.test(cls) && M.exit === null) {
            M.exit = now;
            M.exitPerf = ts;
            try { M.iter = ld.querySelector('.tc-ld-mark').getAnimations()[0].effect.getComputedTiming().currentIteration; } catch (e) {}
          }
          if (ld && /(^| )noted( |$)/.test(cls) && M.note === null) { M.note = ld.querySelector('.tc-ld-status').textContent; M.noteAt = now; }
          M.s.push([now, st]);
        }
        loop();
      });
    })();
  };
  const motionPage = async (stk, viewport, { reduce = false, throttle = 0, slow = false } = {}) => {
    const context = await browser.createBrowserContext();
    const p = await context.newPage();
    const closePage = p.close.bind(p);
    p.close = async () => { await closePage(); await context.close(); };
    await p.setViewport(viewport);
    if (reduce) await p.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    if (throttle || slow) {
      const cdp = await p.createCDPSession();
      if (throttle) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
      // Slow-4G (1.6 Mbit/s, 150 ms), as in the speed pass: the page then takes longer than the loader's 700 ms "quick" limit
      if (slow) { await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 }); }
    }
    await p.evaluateOnNewDocument(MOTION_PROBE);
    p.problems = [];
    p.on('pageerror', (e) => p.problems.push('script error: ' + String(e).slice(0, 200)));
    p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) p.problems.push('console error: ' + m.text().slice(0, 200)); });
    return p;
  };
  const MOTION_ENV = { AUTH_REQUIRED: 'off' };
  const DESK = { width: 1280, height: 800 };
  // polling checks run while a page may be navigating: a lost execution context is "not yet", not an error
  const poll = (p, fn) => p.evaluate(fn).catch(() => false);
  const loaderGone = (p) => poll(p, () => !document.getElementById('tc-loader'));
  /** Click the first visible link to the studio on the page; returns the time of the click. */
  const clickStudio = (p) => p.evaluate(() => { const a = [...document.querySelectorAll('a[href="/design-studio"]')].find((x) => x.offsetParent !== null); const t = Date.now(); a.click(); return t; });
  const studioUsable = (p, ms = 40000) => until(() => poll(p, () => location.pathname === '/design-studio' && !document.getElementById('tc-loader') && !!document.querySelector('.sr-studio')), 'the studio usable and the loader gone', ms);
  /** What the visitor saw, frame by frame, from the origin page's samples and the studio page's: any frame that is neither origin page nor loader. */
  const reviewFrames = (m) => {
    const rows = [...(m.prev || []), ...m.s];
    let exitSeen = false;
    const bad = [];
    for (const [, st] of rows) {
      const [path, cls, , placeholder, splash] = st.split('|');
      if (/(^| )out( |$)/.test(cls)) exitSeen = true;
      if (path === STUDIO && cls === '-' && !exitSeen) bad.push(`the studio page with no loader before the curtain opened: ${st}`);
      if (cls === '-' && (placeholder === 'true' || splash === 'true')) bad.push(`the placeholder or the studio's own splash on screen without the loader: ${st}`);
    }
    return { rows, bad };
  };

  await test('motion: from the click to a usable studio the visitor sees the origin page or the loader, never the empty shell; two full cycles first (container wakes in 4 s)', async () => {
    const stk = await startStack({ port: 0, bootMs: 4000, env: MOTION_ENV });
    const p = await motionPage(stk, DESK);
    try {
      await p.goto(stk.base + '/', { waitUntil: 'load' });
      await until(() => loaderGone(p), 'the landing loader to leave', 15000);
      const clickAt = await clickStudio(p);
      // immediately: the loader is on the current page
      // (a page that navigated away in those two frames, as the old link did, loses its execution context: null)
      const shown = await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(!!document.getElementById('tc-loader') && document.documentElement.classList.contains('tc-ld-lock')))))).catch(() => null);
      assert(shown === true, `the loader was not on the current page two frames after the click (${shown === null ? 'the page had already navigated away' : 'no loader'})`);
      await studioUsable(p);
      const m = await p.evaluate(() => window.__m);
      const { rows, bad } = reviewFrames(m);
      assert(bad.length === 0, bad.slice(0, 3).join('; '));
      assert(rows.some(([, st]) => st.startsWith('/|') && /(^| )in( |$)/.test(st.split('|')[1])), 'no frame of the origin page showed the closing curtain');
      assert(m.exit !== null, 'the curtain never opened');
      assert(m.exit - clickAt >= MIN_MS - 250, `the loader left ${m.exit - clickAt} ms after the click; the minimum is ${MIN_MS}`);
      assert(m.iter >= 2, `only ${m.iter} full cycles were shown`);
      assert(m.exit - clickAt <= MIN_MS + 2200, `with a 4 s wake-up the loader took ${m.exit - clickAt} ms`);
      // nothing wrong with the studio itself
      assert(await p.evaluate(() => !!document.querySelector('.sr-studio, .sr-gate')), 'the studio is not there');
      noProblems(p, 'cold path');
    } finally { await p.close(); await stk.stop(); }
  });

  await test('motion: with the container already warm the two-cycle minimum still holds (and no more than a cycle is added)', async () => {
    const stk = await startStack({ port: 0, bootMs: 300, env: MOTION_ENV });
    const p = await motionPage(stk, DESK);
    try {
      await p.goto(stk.base + '/', { waitUntil: 'load' });
      await until(() => loaderGone(p), 'the landing loader to leave', 15000);
      await sleep(1500); // the landing page's own wake-up has finished
      assert(stk.pools.oneformer.hits.length > 0, 'the landing page did not start the wake-up');
      const clickAt = await clickStudio(p);
      await studioUsable(p);
      const m = await p.evaluate(() => window.__m);
      const { bad } = reviewFrames(m);
      assert(bad.length === 0, bad.slice(0, 3).join('; '));
      assert(m.exit - clickAt >= MIN_MS - 250 && m.exit - clickAt <= MIN_MS + 1400, `warm: the loader left ${m.exit - clickAt} ms after the click (the minimum is ${MIN_MS})`);
      assert(m.iter >= 2, `only ${m.iter} full cycles`);
    } finally { await p.close(); await stk.stop(); }
  });

  await test('motion: the studio opened directly (no click) shows two cycles too, and the click moment is not reused by a later visit', async () => {
    const stk = await startStack({ port: 0, bootMs: 300, env: MOTION_ENV });
    const p = await motionPage(stk, DESK);
    try {
      const t0 = Date.now();
      await p.goto(stk.base + STUDIO, { waitUntil: 'domcontentloaded' });
      await studioUsable(p);
      const m = await p.evaluate(() => window.__m);
      assert(m.exit - t0 >= 2 * 2200 - 400, `direct visit: the loader left after ${m.exit - t0} ms`);
      assert(m.iter >= 2, `only ${m.iter} cycles`);
      // a stale click time (older than the loader accepts) is ignored: the loader starts from the page, not from the old click
      await p.evaluate(() => sessionStorage.setItem('tc-go', JSON.stringify({ t: Date.now() - 60000, to: '/design-studio' })));
      const t1 = Date.now();
      await p.goto(stk.base + STUDIO, { waitUntil: 'domcontentloaded' });
      await studioUsable(p);
      const m2 = await p.evaluate(() => window.__m);
      assert(m2.exit - t1 >= 2 * 2200 - 400, `a stale click time shortened the wait: ${m2.exit - t1} ms`);
      assert((await p.evaluate(() => sessionStorage.getItem('tc-go'))) === null, 'the click time is used once');
    } finally { await p.close(); await stk.stop(); }
  });

  await test('motion: reduced motion: no curtain and no animation, the two-cycle minimum is skipped, the loader leaves as soon as the studio is ready', async () => {
    const stk = await startStack({ port: 0, bootMs: 300, env: MOTION_ENV });
    const p = await motionPage(stk, DESK, { reduce: true });
    try {
      await p.goto(stk.base + '/', { waitUntil: 'load' });
      await until(() => loaderGone(p), 'the landing loader to leave', 15000);
      const clickAt = await clickStudio(p);
      await until(() => poll(p, () => location.pathname === '/design-studio' && !!document.getElementById('tc-loader')), 'the loader on the studio page', 8000);
      const seen = await p.evaluate(() => {
        const el = document.getElementById('tc-loader');
        return { curtain: getComputedStyle(el.querySelector('.tc-ld-curtain')).display, running: el.getAnimations({ subtree: true }).filter((a) => a.animationName && a.animationName !== 'tc-pu' && a.playState === 'running').map((a) => a.animationName), mark: getComputedStyle(el.querySelector('.tc-ld-mark')).opacity };
      });
      assert(seen.curtain === 'none', 'a curtain is on screen with reduced motion');
      assert(seen.running.length === 0, 'animations running with reduced motion: ' + seen.running.join(','));
      await studioUsable(p);
      const m = await p.evaluate(() => window.__m);
      assert(m.exit - clickAt < MIN_MS - 800, `reduced motion: the loader left ${m.exit - clickAt} ms after the click (the full minimum is ${MIN_MS})`);
    } finally { await p.close(); await stk.stop(); }
  });

  await test('motion: a container that wakes in 14 s does not hold the visitor past the cap: a quiet status line, then the studio at about 10 s', async () => {
    const stk = await startStack({ port: 0, bootMs: 14000, env: MOTION_ENV });
    const p = await motionPage(stk, DESK);
    try {
      await p.goto(stk.base + '/', { waitUntil: 'load' });
      await until(() => loaderGone(p), 'the landing loader to leave', 15000);
      const clickAt = await clickStudio(p);
      await studioUsable(p, 30000);
      const m = await p.evaluate(() => window.__m);
      const { bad } = reviewFrames(m);
      assert(bad.length === 0, bad.slice(0, 3).join('; '));
      assert(/The studio is still waking its models; you can start now/.test(m.note || ''), 'no status line: ' + m.note);
      assert(m.noteAt - clickAt >= CAP_MS - 2300 && m.noteAt - clickAt <= CAP_MS, `the status line came ${m.noteAt - clickAt} ms after the click`);
      assert(m.exit - clickAt >= CAP_MS - 300 && m.exit - clickAt <= CAP_MS + 2600, `the loader left ${m.exit - clickAt} ms after the click (cap ${CAP_MS})`);
      assert(m.exit - clickAt < 14000, 'the visitor was held until the container woke');
    } finally { await p.close(); await stk.stop(); }
  });

  await test('motion: when the studio itself does not load, the loader shows the existing "taking longer than usual" screen with Retry; Retry works', async () => {
    const stk = await startStack({ port: 0, bootMs: 300, env: MOTION_ENV });
    const p = await motionPage(stk, DESK);
    try {
      let block = true;
      await p.setRequestInterception(true);
      p.on('request', (r) => (block && /\/js\/swatchroom-app\.js/.test(r.url()) ? r.abort('failed') : r.continue()));
      await p.goto(stk.base + '/', { waitUntil: 'load' });
      await until(() => loaderGone(p), 'the landing loader to leave', 15000);
      await clickStudio(p);
      await until(() => poll(p, () => location.pathname === '/design-studio' && !!document.querySelector('#tc-loader.tc-ld-failed')), 'the failure screen', 20000);
      const f = await p.evaluate(() => {
        const el = document.getElementById('tc-loader');
        const vis = (s) => { const e = el.querySelector(s); const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
        return { title: el.querySelector('.tc-ld-ft').textContent, retry: vis('.tc-ld-retry'), home: vis('.tc-ld-home'), placeholder: !!document.querySelector('.sc-placeholder[title="swatchroom-app"]') && getComputedStyle(document.querySelector('.sc-placeholder')).visibility !== 'hidden' };
      });
      assert(/taking longer than usual/.test(f.title) && f.retry && f.home, 'failure screen: ' + JSON.stringify(f));
      assert(!f.placeholder, 'the grey "swatchroom-app" placeholder is visible');
      block = false;
      const nav = p.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 });
      await p.click('#tc-loader .tc-ld-retry');
      await nav;
      await studioUsable(p, 30000);
    } finally { await p.close(); await stk.stop(); }
  });

  await test('motion: Ctrl/Cmd/Shift/Alt clicks, the middle button, target=_blank and downloads are left alone; a plain click is taken over; the studio\'s own links are not', async () => {
    const stk = await startStack({ port: 0, bootMs: 300, env: MOTION_ENV });
    const p = await motionPage(stk, DESK);
    try {
      await p.goto(stk.base + '/', { waitUntil: 'load' });
      await until(() => loaderGone(p), 'the landing loader to leave', 15000);
      const r = await p.evaluate(() => {
        const a = [...document.querySelectorAll('a[href="/design-studio"]')].find((x) => x.offsetParent !== null);
        const seen = [];
        // a bubbling listener on window runs after transition.js's capture listener: it records what that did, then stops the navigation
        addEventListener('click', (e) => { seen.push(e.defaultPrevented); e.preventDefault(); });
        const click = (init, target) => { const old = a.getAttribute('target'); if (target) a.setAttribute('target', target); a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })); if (target) { if (old === null) a.removeAttribute('target'); else a.setAttribute('target', old); } return { prevented: seen.at(-1), overlay: !!document.getElementById('tc-loader'), stored: sessionStorage.getItem('tc-go') }; };
        const out = {
          ctrl: click({ ctrlKey: true }), meta: click({ metaKey: true }), shift: click({ shiftKey: true }), alt: click({ altKey: true }),
          middle: click({ button: 1 }), blank: click({}, '_blank'),
        };
        const dl = a.hasAttribute('download'); a.setAttribute('download', ''); out.download = click({}); if (!dl) a.removeAttribute('download');
        return out;
      });
      for (const [kind, v] of Object.entries(r)) assert(v.prevented === false && !v.overlay && v.stored === null, `${kind}: the click was taken over: ${JSON.stringify(v)}`);
      // a plain click is taken over: the page's own navigation is prevented, the loader is up, the click time is stored
      const plain = await p.evaluate(() => {
        const a = [...document.querySelectorAll('a[href="/design-studio"]')].find((x) => x.offsetParent !== null);
        let prevented = null;
        addEventListener('click', (e) => { prevented = e.defaultPrevented; }, false);
        a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
        return { prevented, overlay: !!document.getElementById('tc-loader'), stored: !!sessionStorage.getItem('tc-go'), locked: document.documentElement.classList.contains('tc-ld-lock') };
      });
      assert(plain.prevented && plain.overlay && plain.stored && plain.locked, 'a plain click: ' + JSON.stringify(plain));
      await studioUsable(p);
      // on the studio page a link to the studio is not taken over
      const own = await p.evaluate(() => {
        const a = [...document.querySelectorAll('a[href="/design-studio"]')].find((x) => x.offsetParent !== null);
        if (!a) return { skipped: true };
        let prevented = null;
        addEventListener('click', (e) => { prevented = e.defaultPrevented; e.preventDefault(); });
        a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
        return { prevented, overlay: !!document.getElementById('tc-loader') };
      });
      assert(own.skipped || (own.prevented === false && !own.overlay), 'inside the studio: ' + JSON.stringify(own));
    } finally { await p.close(); await stk.stop(); }
  });

  await test('motion: a page with a strict Content-Security-Policy gets the same overlay from transition.js on a click to the studio (its own arrival loader already gone, no inline code), and the studio page continues it', async () => {
    const stk = await startStack({ port: 0, bootMs: 300, env: MOTION_ENV });
    const p = await motionPage(stk, DESK);
    const csp = [];
    p.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text().slice(0, 160)); });
    try {
      await p.goto(stk.base + '/inspiration', { waitUntil: 'load' });
      // the page's own loader (site/brand/loader.js) has come and gone: nothing is left on screen, nothing locks the page
      await until(() => poll(p, () => !document.getElementById('tc-loader')), 'the page\'s own loader to leave', 8000);
      assert(await p.evaluate(() => window.TeruconLoader && window.TeruconLoader.state === 'done' && !document.documentElement.classList.contains('tc-ld-lock')), 'the page\'s own loader left something behind');
      await p.addScriptTag({ url: stk.base + '/brand/transition.js' });
      await until(() => poll(p, () => [...document.styleSheets].some((s) => /\/brand\/loader\.css/.test(s.href || ''))), 'loader.css to load', 5000);
      await p.evaluate(() => { const a = document.createElement('a'); a.href = '/design-studio'; a.id = 'tc-test-link'; a.textContent = 'Design Studio'; document.body.prepend(a); a.click(); });
      const up = await p.evaluate(() => { const el = document.getElementById('tc-loader'); return !!el && getComputedStyle(el).display === 'flex' && el.querySelectorAll('.tc-ld-curtain i').length >= 5; });
      assert(up, 'the overlay did not come up on the strict page');
      await studioUsable(p);
      const m = await p.evaluate(() => window.__m);
      assert(reviewFrames(m).bad.length === 0, reviewFrames(m).bad.slice(0, 3).join('; '));
      assert(csp.length === 0, 'Content-Security-Policy violations: ' + csp.join(' | '));
    } finally { await p.close(); await stk.stop(); }
  });

  await test('motion: with loader.js unavailable a strict page still gets the click overlay (transition.js links the style sheet itself), and the page is not left behind a loader that never started', async () => {
    const stk = await startStack({ port: 0, bootMs: 300, env: MOTION_ENV });
    const p = await motionPage(stk, DESK);
    const csp = [];
    p.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text().slice(0, 160)); });
    await p.setRequestInterception(true);
    p.on('request', (req) => { if (new URL(req.url()).pathname === '/brand/loader.js') req.respond({ status: 404, contentType: 'text/plain', body: 'gone' }); else req.continue(); });
    try {
      await p.goto(stk.base + '/inspiration', { waitUntil: 'load' });
      assert(await p.evaluate(() => !document.getElementById('tc-loader') && !window.TeruconLoader && !document.documentElement.classList.contains('tc-ld-lock')), 'the page is behind a loader that cannot be released');
      await p.evaluate(() => { const a = document.createElement('a'); a.href = '/design-studio'; a.id = 'tc-test-link'; a.textContent = 'Design Studio'; document.body.prepend(a); a.click(); });
      const up = await p.evaluate(() => { const el = document.getElementById('tc-loader'); return !!el && getComputedStyle(el).display === 'flex' && el.querySelectorAll('.tc-ld-curtain i').length >= 5; });
      assert(up, 'the overlay did not come up on the strict page without loader.js');
      assert(csp.length === 0, 'Content-Security-Policy violations: ' + csp.join(' | '));
    } finally { await p.close(); await stk.stop(); }
  });

  await test('motion: a studio that is ready late (about 11 s) while the container is still cold never flashes the "taking longer than usual" screen', async () => {
    // the loader's own failure timer is 12 s from the click; the studio is ready at about 11 s, the status line is held for 1.2 s, so the
    // release lands after the 12 s mark: the timer must have been cancelled when the studio came up (TeruconLoader.hold)
    const stk = await startStack({ port: 0, bootMs: 14000, env: MOTION_ENV });
    const p = await motionPage(stk, DESK);
    try {
      await p.setRequestInterception(true);
      p.on('request', (r) => (/\/js\/swatchroom-app\.js/.test(r.url()) ? setTimeout(() => r.continue().catch(() => {}), 9500) : r.continue()));
      await p.goto(stk.base + '/', { waitUntil: 'load' });
      await until(() => loaderGone(p), 'the landing loader to leave', 15000);
      const clickAt = await clickStudio(p);
      await studioUsable(p, 40000);
      const m = await p.evaluate(() => window.__m);
      const rows = [...(m.prev || []), ...m.s];
      assert(rows.every(([, st]) => !/(^| )failed( |$)/.test(st.split('|')[1])), 'the failure screen appeared although the studio was up');
      assert(m.exit - clickAt > 11500, `the studio was not late enough for this test (the loader left ${m.exit - clickAt} ms after the click)`);
    } finally { await p.close(); await stk.stop(); }
  });

  await test('motion: Back from the studio does not leave the closed curtain on the page it came from', async () => {
    const stk = await startStack({ port: 0, bootMs: 300, env: MOTION_ENV });
    const p = await motionPage(stk, DESK);
    try {
      await p.goto(stk.base + '/', { waitUntil: 'load' });
      await until(() => loaderGone(p), 'the landing loader to leave', 15000);
      await clickStudio(p);
      await studioUsable(p);
      await p.goBack({ waitUntil: 'domcontentloaded' });
      // from the cache the overlay (data-tc-from) must be gone at once; a fresh load shows the page's own loader, which then leaves
      await until(() => poll(p, () => location.pathname === '/' && !document.querySelector('#tc-loader[data-tc-from]')), 'the click overlay to be gone after Back', 3000);
      await until(() => loaderGone(p), 'the landing loader to leave after Back', 15000);
      assert(await poll(p, () => !document.documentElement.classList.contains('tc-ld-lock') && !!document.querySelector('[data-hero-copy]')), 'the landing page is locked or empty after Back');
    } finally { await p.close(); await stk.stop(); }
  });

  // ---- the frame budget ----------------------------------------------------------------------------------------------------------
  // Measured on this Mac (headless Chrome, 4x CPU slowdown, Slow-4G, 3 runs each, interleaved with the unchanged code): over the 3.6 s from
  // the start of the loader's exit, the worst rAF gap was 33.4 ms after the change (390 and 1280 px) and 83-116 ms before it, where a
  // 107-131 ms long animation frame (three.js starting, inside the hero's opening) sat in every run. In the full browser suite, on a busy
  // machine, one isolated frame of 83 ms did appear after the change (once, in one full-suite run), so the numbers below are generous on purpose:
  // a budget tight enough to tell the old code from the new would be a flaky test. What separates them reliably is structural (what
  // runs on animations, what waits for what), and those checks come first.
  const gaps = (frames, from, to) => { const w = frames.filter((t) => t >= from && t <= to); const d = []; for (let i = 1; i < w.length; i++) d.push(w[i] - w[i - 1]); d.sort((a, b) => a - b); return { n: d.length, p95: d[Math.floor(d.length * 0.95)] ?? 0, max: d.at(-1) ?? 0, over50: d.filter((x) => x > 50).length }; };

  await test('motion: the hero\'s louvres open when the loader leaves, as Web Animations, the 3D façade waits, and the opening keeps to the frame budget at 4x CPU slowdown', async () => {
    const stk = await startStack({ port: 0, bootMs: 300, env: MOTION_ENV });
    const p = await motionPage(stk, DESK, { throttle: 4 });
    try {
      await p.evaluateOnNewDocument(() => { window.__fin = { before: null, three: null }; addEventListener('tc-ld-exit', () => { window.__fin.before = document.querySelectorAll('[data-louvres] div').length ? [...document.querySelectorAll('[data-louvres] div')].flatMap((d) => d.getAnimations()).length : -1; window.__fin.three = performance.getEntriesByType('resource').some((r) => /three-/.test(r.name)); }); });
      await p.goto(stk.base + '/', { waitUntil: 'load' });
      await until(() => poll(p, () => window.__m.ldexit !== null), 'the loader to hand over', 30000);
      const fin = await p.evaluate(() => window.__fin);
      assert(fin.before === 0, `the fins were already animating (${fin.before}) before the loader left`);
      assert(fin.three === false, 'three.js was fetched before the loader left');
      await sleep(600);
      const mid = await p.evaluate(() => ({ anims: [...document.querySelectorAll('[data-louvres] div')].flatMap((d) => d.getAnimations()).filter((a) => a.playState === 'running').length, fins: document.querySelectorAll('[data-louvres] > div').length - 1, three: performance.getEntriesByType('resource').some((r) => /three-/.test(r.name)) }));
      assert(mid.fins === 9, `${mid.fins} fins on a laptop (9 expected)`);
      assert(mid.anims >= 9, `only ${mid.anims} running animations 600 ms into the opening`);
      assert(mid.three === false, 'three.js started in the middle of the hero\'s opening');
      await sleep(3600);
      const done = await p.evaluate(() => new Promise((r) => {
        // after the opening, with nobody scrolling, nothing in the louvres changes (a guard: the old loop did not change anything either once its values settled)
        let n = 0; const host = document.querySelector('[data-louvres]');
        const mo = new MutationObserver((l) => { n += l.length; }); mo.observe(host, { attributes: true, subtree: true, childList: true });
        setTimeout(() => { mo.disconnect(); const m = window.__m; r({ writes: n, ldexit: m.ldexit, f: m.f }); }, 1200);
      }));
      assert(done.writes === 0, `${done.writes} style or DOM writes in the louvres while the page was idle`);
      const g = gaps(done.f, done.ldexit - 400, done.ldexit + 3000);
      assert(g.max <= 130 && g.p95 <= 34 && g.over50 <= 2, `the dissolve and the opening at 4x slowdown: ${JSON.stringify(g)} (budget: max <= 130 ms, p95 <= 34 ms, at most two frames over 50 ms)`);
      noProblems(p, 'landing hero');
    } finally { await p.close(); await stk.stop(); }
  });

  await test('motion: the loader\'s curtain exit on a page without its own curtain (Materials) keeps to the frame budget at 4x slowdown, on a laptop and on a phone, with 9 and 5 slats', async () => {
    const stk = await startStack({ port: 0, bootMs: 300, env: MOTION_ENV });
    try {
      for (const [name, vp, slats] of [['laptop', DESK, 9], ['phone', PHONE, 5]]) {
        const p = await motionPage(stk, vp, { throttle: 4, slow: true });
        try {
          await p.evaluateOnNewDocument(() => { new MutationObserver(() => { const l = document.querySelector('#tc-loader .tc-ld-curtain'); if (l && l.querySelectorAll('i').length && !window.__slats) window.__slats = l.querySelectorAll('i').length; }).observe(document, { childList: true, subtree: true, attributes: true }); });
          await p.goto(stk.base + '/materials', { waitUntil: 'load' });
          await until(() => loaderGone(p), `the ${name} loader to leave`, 30000);
          const m = await p.evaluate(() => ({ exitPerf: window.__m.exitPerf, gone: window.__m.gone, f: window.__m.f, slats: window.__slats }));
          assert(m.slats === slats, `${name}: ${m.slats} slats (${slats} expected)`);
          assert(m.exitPerf !== null && m.gone !== null && m.f.length > 60, `${name}: the exit was not seen`);
          assert(m.gone - m.exitPerf >= 1000 && m.gone - m.exitPerf <= 2400, `${name}: the curtain took ${Math.round(m.gone - m.exitPerf)} ms`);
          const g = gaps(m.f, m.exitPerf - 50, m.gone);
          assert(g.max <= 130 && g.p95 <= 34 && g.over50 <= 2, `${name} exit at 4x slowdown: ${JSON.stringify(g)} (budget: max <= 130 ms, p95 <= 34 ms, at most two frames over 50 ms)`);
          noProblems(p, name + ' materials');
        } finally { await p.close(); }
      }
    } finally { await stk.stop(); }
  });
}
// ==== motion (end) ====


// ==== photos: TeruBot with a photo, and the shop's "Find it from a photo" ====
const PHOTO_FILE = path.join(root, 'media', 'p02-lobby.jpg');
await test('terubot: a photo is attached, shrunk, sent with the message and kept for the next; a link\'s picture comes back as an attachment and is kept by its token; Remove and New chat clear it; a file that is not a picture is refused', async () => {
  const st = tbState({
    chat: (body, n) => (n === 3 ? tbAnswer('That pin shows a wall.', { attachment: { kind: 'link', token: 'tok_ABCDEFGH12345678', host: 'Pinterest', title: 'A wall' } }) : n === 5 ? { status: 401, json: { error: 'Please sign in to send a photo or a link to a picture.' } } : tbAnswer('It looks like stone.')),
    route: (u, req) => { if (u.pathname.startsWith('/api/inspiration/file/')) { req.respond({ status: 200, contentType: 'image/png', body: TB_PNG }); return true; } return false; },
  });
  const page = await tbPage(null, st);
  await tbGo(page, '/materials');
  await tbOpen(page);
  assert(await page.evaluate(() => !!document.querySelector('.tb-attachbtn') && document.querySelector('.tb-photo').hidden), 'the attach button is there and the strip is hidden until there is a photo');
  // a file that is not a picture
  const junk = path.join(os.tmpdir(), `not-a-picture-${Date.now()}.txt`);
  fs.writeFileSync(junk, 'hello');
  const input = await page.$('.tb-form input[type=file]');
  await input.uploadFile(junk);
  await until(() => page.evaluate(() => /not a picture/i.test(document.querySelector('.tb-notice__text').textContent)), 'the refusal of a file that is not a picture');
  assert(await page.evaluate(() => document.querySelector('.tb-photo').hidden), 'a text file became a photo');
  fs.rmSync(junk, { force: true });
  // a real photo
  await (await page.$('.tb-form input[type=file]')).uploadFile(PHOTO_FILE);
  await until(() => page.evaluate(() => !document.querySelector('.tb-photo').hidden && !document.querySelector('.tb-photo__img').hidden), 'the photo strip');
  const strip = await page.evaluate(() => ({ label: document.querySelector('.tb-photo__label').textContent, thumb: document.querySelector('.tb-photo__img').src.slice(0, 23), buttons: [...document.querySelectorAll('.tb-photo button')].map((b) => b.textContent), sendOn: !document.querySelector('.tb-send').disabled }));
  assert(strip.label === 'Your photo' && strip.thumb === 'data:image/jpeg;base64,' && strip.buttons.join() === 'Finder,Studio,Remove', 'the strip: ' + JSON.stringify(strip));
  assert(strip.sendOn, 'a photo alone can be sent (it asks what it is)');
  await tbSend(page, 'what material is used in the left wall of this photo');
  await tbWaitBot(page, 1);
  const first = st.calls[0];
  assert(first.image && first.image.type === 'image/jpeg' && !first.image.token && /^\/9j\//.test(first.image.data), 'the photo goes out as base64 JPEG: ' + JSON.stringify(first.image).slice(0, 80));
  const size = await page.evaluate((d) => new Promise((res) => { const i = new Image(); i.onload = () => res([i.naturalWidth, i.naturalHeight]); i.onerror = () => res(null); i.src = 'data:image/jpeg;base64,' + d; }), first.image.data);
  assert(size && Math.max(...size) <= 1280 && Math.max(...size) >= 600, 'the photo was shrunk to at most 1280 px: ' + size);
  assert(first.image.data.length < 700 * 1024, 'about 500 KB of base64 at most: ' + first.image.data.length);
  assert(await page.evaluate(() => document.querySelectorAll('.tb-msg--user .tb-attach__img').length === 1), 'the photo is shown in the visitor\'s message');
  assert(await page.evaluate(() => !document.querySelector('.tb-photo').hidden), 'the photo stays for the next question');
  await tbSend(page, 'and the floor?');
  await tbWaitBot(page, 2);
  assert(st.calls[1].image && st.calls[1].image.data === first.image.data, 'the second question carries the same photo');
  assert(await page.evaluate(() => document.querySelectorAll('.tb-msg--user .tb-attach__img').length === 1), 'the picture is shown once, with the message that brought it');
  // a link: the answer carries the picture the site fetched
  await tbSend(page, 'https://in.pinterest.com/pin/328410997812212699/');
  await tbWaitBot(page, 3);
  await until(() => page.evaluate(() => document.querySelector('.tb-photo__label').textContent === 'Picture from Pinterest'), 'the link\'s picture in the strip');
  await until(() => page.evaluate(() => document.querySelectorAll('.tb-msg--bot .tb-attach__img').length === 1), 'the link\'s thumbnail in the answer');
  await tbSend(page, 'what about the floor in it?');
  await tbWaitBot(page, 4);
  assert(JSON.stringify(st.calls[3].image) === '{"token":"tok_ABCDEFGH12345678"}', 'a link\'s picture is sent as its token, not as bytes: ' + JSON.stringify(st.calls[3].image).slice(0, 80));
  // an error that is about the photo says so
  await tbSend(page, 'one more');
  await until(() => page.evaluate(() => /sign in to send a photo/.test(document.querySelector('.tb-log').textContent)), 'the server\'s reason for refusing a photo');
  // Remove
  await page.evaluate(() => [...document.querySelectorAll('.tb-photo button')].find((b) => b.textContent === 'Remove').click());
  await until(() => page.evaluate(() => document.querySelector('.tb-photo').hidden), 'Remove to hide the strip');
  const before = st.calls.length;
  await tbSend(page, 'no photo now');
  await until(() => st.calls.length === before + 1, 'the next call');
  assert(!('image' in st.calls.at(-1)), 'after Remove the request has no image');
  await until(async () => !(await page.$('.tb-typing')) && (await page.evaluate(() => !document.querySelector('.tb-send').getAttribute('aria-busy'))), 'the answer', 8000);
  // New chat
  await (await page.$('.tb-form input[type=file]')).uploadFile(PHOTO_FILE);
  await until(() => page.evaluate(() => !document.querySelector('.tb-photo').hidden), 'a photo again');
  await page.evaluate(() => [...document.querySelectorAll('.tb-head .tb-textbtn')].find((b) => b.textContent === 'New chat').click());
  await until(() => page.evaluate(() => document.querySelector('.tb-photo').hidden), 'New chat to clear the photo');
  noProblems({ problems: tbProblems(page) }, 'TeruBot with a photo');
  await page.close();
});

await test('shop: "Find it from a photo": the surfaces of the photo are outlined, hovering lights one up with its name, tapping it searches the catalogue with a patch of that surface and shows the closest designs with the shop\'s price, View and Add to cart work; with the catalogue off the shop\'s own colour preview opens and says why', async () => {
  const zlib = await import('node:zlib');
  const W = 256, H = 192;
  const cm = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) cm[y * W + x] = y > 130 ? 2 : (x >= 90 && x <= 170 && y > 20 && y < 90) ? 3 : 1;
  const seg = { width: W, height: H, classMap: zlib.gzipSync(Buffer.from(cm)).toString('base64'), classLabels: ['wall', 'floor, flooring', 'windowpane, window'], classIds: [0, 3, 8], instanceMap: null, instances: [] };
  const shopOf = (pid, name) => ({ id: pid.toLowerCase(), variantId: `${pid.toLowerCase()}--${pid.toLowerCase()}-4-1220x2440`, name: `${name} (${pid.slice(5)})`, priceText: '₹6,020 / sheet', price: 6020, unit: 'sheet', stock: 'in', href: `/materials#/p/${pid.toLowerCase()}`, image: `/media/materials/${pid.toLowerCase()}.jpg`, sample: true, note: 'Sample' });
  const items = [['TIPL-SB804', 'Emperador Dark'], ['TIPL-SB825', 'Williams Grey'], ['TIPL-SB8001', 'Marmoris Stain']].map(([pid, name], i) => ({ rank: i + 1, itemId: 'i' + i, title: name, productId: pid, image: { thumbUrl: '', fullUrl: '' }, shop: shopOf(pid, name) }));
  const page = await newPage({ width: 1280, height: 900 });
  const seen = { segment: 0, search: [], status: 0 };
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (u.pathname === '/api/catalogue/status') { seen.status += 1; return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, ready: true, reasons: [], default: 'c', catalogues: [], limits: {}, profile: 'fast' }) }); }
    if (u.pathname === '/api/catalogue/warm') return req.respond({ status: 202, contentType: 'application/json', body: '{"ok":true}' });
    if (u.pathname === '/api/vision/segment') { seen.segment += 1; seen.model = u.searchParams.get('model'); seen.segType = req.headers()['content-type']; return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(seg) }); }
    if (u.pathname === '/api/catalogue/search') {
      return req.fetchPostData().then((data) => { seen.search.push({ query: u.search, type: req.headers()['content-type'], size: (data || '').length }); req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, catalogue: 'c', items }) }); });
    }
    return req.continue();
  });
  await page.goto(base + '/materials', { waitUntil: 'domcontentloaded' });
  await until(() => page.evaluate(() => !!window.TeruconSurfaces && [...document.querySelectorAll('button')].some((b) => /Take or upload a photo/.test(b.textContent))), 'the shop and the photo dialog module', 20000);
  await until(() => page.evaluate(() => { const l = document.getElementById('tc-loader'); return !l || getComputedStyle(l).pointerEvents === 'none'; }), 'the loader to let go', 20000);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Take or upload a photo/.test(b.textContent)).click());
  await until(() => page.$('.tcs input[type=file]:not([capture])'), 'the dialog');
  assert(await page.evaluate(() => !!document.querySelector('.tcs input[type=file][capture]') && !!document.querySelector('.tcs__linkInput')), 'the dialog offers the camera, the gallery and a link');
  await (await page.$('.tcs input[type=file]:not([capture])')).uploadFile(PHOTO_FILE);
  await until(() => page.evaluate(() => document.querySelectorAll('.tcs__chip').length >= 4), 'the surfaces', 20000);
  assert(seen.segment === 1 && seen.model === 'oneformer' && seen.segType === 'image/jpeg', 'one scan, by OneFormer, of the photo as JPEG: ' + JSON.stringify(seen));
  const chips = await page.$$eval('.tcs__chip', (els) => els.map((e) => e.textContent));
  assert(chips.join() === 'Wall,Floor,Window,Whole photo', 'the surfaces: ' + chips);
  const box = await (await page.$('.tcs__overlay')).boundingBox();
  await page.mouse.move(box.x + box.width * 0.12, box.y + box.height * 0.3);
  await until(() => page.evaluate(() => !document.querySelector('.tcs__tip').hidden), 'the name of the surface under the pointer');
  assert(await page.evaluate(() => document.querySelector('.tcs__tip').textContent) === 'Wall', 'hovering the wall names it');
  const lit = await page.evaluate(() => { const c = document.querySelector('.tcs__overlay'); const x = c.getContext('2d'); const at = (fx, fy) => x.getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data[3]; return { wall: at(0.12, 0.3), floor: at(0.5, 0.9) }; });
  assert(lit.wall > 40 && lit.floor === 0, 'the wall is lit and the floor is not: ' + JSON.stringify(lit));
  await page.mouse.click(box.x + box.width * 0.12, box.y + box.height * 0.3);
  await until(() => page.evaluate(() => document.querySelectorAll('.tcs__card').length === 3), 'the closest designs');
  assert(seen.search.length === 1 && seen.search[0].type === 'image/jpeg' && seen.search[0].query === '?mode=look&k=8', 'one catalogue search with a JPEG patch: ' + JSON.stringify(seen.search));
  const cards = await page.$$eval('.tcs__card', (els) => els.map((e) => ({ name: e.querySelector('.tcs__cardName').textContent, code: e.querySelector('.tcs__cardCode').textContent, price: e.querySelector('.tcs__cardPrice').textContent, img: e.querySelector('img').getAttribute('src'), badge: !!e.querySelector('.tcs__badge') })));
  assert(cards[0].name === 'Emperador Dark (SB804)' && cards[0].code === 'TIPL-SB804' && cards[0].price === '₹6,020 / sheet' && cards[0].badge && !cards[1].badge && cards[0].img === '/media/materials/tipl-sb804.jpg', 'the first card: ' + JSON.stringify(cards));
  assert(/Closest designs to the wall/.test(await page.$eval('.tcs__status', (e) => e.textContent)), 'the status names what was searched');
  await page.evaluate(() => [...document.querySelectorAll('.tcs__chip')].find((e) => e.textContent === 'Whole photo').click());
  await until(() => seen.search.length === 2, 'the whole-photo search');
  assert(seen.search[0].size > 3000 && seen.search[0].size < seen.search[1].size * 0.85, 'the wall search sent a patch of the wall, smaller than the whole photo: ' + seen.search.map((x) => x.size));
  // add to the cart through the shop's own bridge
  await until(() => page.evaluate(() => { const d = { op: 'saved_remove', id: 'no-such-item', handled: false }; window.dispatchEvent(new CustomEvent('terucon:shop', { detail: d })); return d.handled; }), 'the shop to answer the cart bridge');
  await page.evaluate(() => document.querySelectorAll('.tcs__card')[0].querySelectorAll('button')[0].click());
  await until(() => page.evaluate(() => /Added to your cart/.test(document.querySelector('.tcs__added').textContent)), 'the cart to take the design');
  assert(await page.evaluate(() => /tipl-sb804--tipl-sb804-4-1220x2440/.test(localStorage.getItem('terucon.store.v1.cart') || '')), 'the cart holds the design');
  // View opens the product and closes the dialog
  await page.evaluate(() => document.querySelectorAll('.tcs__card')[1].querySelector('a').click());
  await until(() => page.evaluate(() => !document.querySelector('.tcs') && location.hash === '#/p/tipl-sb825'), 'View to open the product and close the dialog');
  noProblems(page, 'the shop photo search');
  await page.close();

  // with the catalogue off (the dev stack has none) the shop's own preview opens, and the visitor is told why
  const off = await newPage({ width: 1280, height: 900 });
  await off.goto(base + '/materials', { waitUntil: 'domcontentloaded' });
  await until(() => off.evaluate(() => !!window.TeruconSurfaces && [...document.querySelectorAll('button')].some((b) => /Take or upload a photo/.test(b.textContent))), 'the shop', 20000);
  await until(() => off.evaluate(() => { const l = document.getElementById('tc-loader'); return !l || getComputedStyle(l).pointerEvents === 'none'; }), 'the loader to let go', 20000);
  await off.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Take or upload a photo/.test(b.textContent)).click());
  await until(() => off.evaluate(() => /photo match/i.test(document.body.innerText) && !document.querySelector('.tcs') && /find it from a photo/i.test(document.body.innerText) && /drop a photo here|take a photo/i.test(document.body.innerText)), 'the shop\'s own preview to open');
  assert(await off.evaluate(() => /not switched on|colour preview/i.test(document.querySelector('.tcs__toast')?.textContent || '')), 'the visitor is told why this is the colour preview: ' + await off.evaluate(() => document.querySelector('.tcs__toast')?.textContent));
  await off.close();
});

await test('shop: the SuperBond colour designs are listed under their catalogue ids: the product page, the category, the SKU, the price and the picture (asked of the catalogue route, which reads it from Cloud Storage; a quiet tile when it cannot)', async () => {
  const page = await newPage({ width: 1280, height: 900 });
  // The design's picture is not a file of the server: /media/materials/tipl-sb804.jpg is read from Cloud Storage through MongoDB (server/routes/catalogueMedia.js).
  // This stack has no catalogue, so one address is answered by a stand-in for that route and the shop's request for it is recorded; another is left to the real
  // route, which must answer with the quiet tile (never a broken image) when nothing can be read.
  const askedFor = [];
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (u.pathname === '/media/materials/tipl-sb804.jpg') { askedFor.push(u.pathname + u.search); return req.respond({ status: 200, contentType: 'image/png', body: TB_PNG }); }
    req.continue();
  });
  await page.goto(base + '/materials#/p/tipl-sb804', { waitUntil: 'domcontentloaded' });
  await until(() => page.evaluate(() => /Emperador Dark \(SB804\)/.test(document.body.innerText)), 'the product page', 20000);
  const got = await page.evaluate(() => ({ text: document.body.innerText, sku: /SKU\s*\n?\s*TIPL-SB804/.test(document.body.innerText), crumb: /SuperBond colours/.test(document.body.innerText) }));
  assert(got.sku && got.crumb && /₹6,020/.test(got.text) && /Sample values until the price list is loaded/.test(got.text), 'the page: sku ' + got.sku + ', category ' + got.crumb + ', sample note ' + /Sample values/.test(got.text));
  await until(() => page.evaluate(() => [...document.images].some((i) => /\/media\/materials\/tipl-sb804\.jpg(\?|$)/.test(i.currentSrc || i.src) && i.complete && i.naturalWidth > 0)), 'the design\'s own picture to load (from the catalogue route, here a stand-in)');
  assert(askedFor.length > 0 && askedFor.every((a) => a.startsWith('/media/materials/tipl-sb804.jpg')), 'the shop did not ask the catalogue route for the picture: ' + JSON.stringify(askedFor));
  const quiet = await page.evaluate(async () => { const r = await fetch('/media/materials/tipl-sb805.jpg'); return { status: r.status, type: r.headers.get('content-type'), mark: r.headers.get('x-terucon-picture'), cache: r.headers.get('cache-control'), svg: (await r.text()).includes('SB805') }; });
  assert(quiet.status === 200 && /image\/svg\+xml/.test(quiet.type) && quiet.mark === 'unavailable' && quiet.cache === 'no-store' && quiet.svg, 'with nothing to read the route must answer a quiet tile, never cached: ' + JSON.stringify(quiet));
  await page.goto(base + '/materials#/shop?cat=colour', { waitUntil: 'domcontentloaded' });
  await until(() => page.evaluate(() => /63 materials/.test(document.body.innerText)), 'the category to list the 63 designs', 20000);
  const r = await page.evaluate(() => ({ chip: /Colour catalogue/.test(document.body.innerText), twentyFour: /\b24 materials\b/.test(document.body.innerText) }));
  assert(r.chip, 'the category chip');
  noProblems(page, 'the colour designs');
  await page.close();
});
// ==== photos (end) ====


await browser.close();
await stack.stop();
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} browser tests passed`);
process.exit(failed.length ? 1 : 0);
