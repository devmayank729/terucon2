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
/**
 * Sign this window in the way a visitor does: ask for a code, read it (the stack prints it in its window), enter it, fill in the
 * sign-up form. Every page but the landing page is for members, so a test that walks the site starts here. Each call comes from its
 * own "network address" (X-Forwarded-For), so the per-address limits never decide a test.
 */
const signInPage = async (p, stk) => {
  signIns += 1;
  const email = `visitor${signIns}-${Date.now()}@example.com`;
  const ip = `10.66.${Math.floor(signIns / 250)}.${(signIns % 250) + 1}`;
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
    if (name === 'dashboard') {  // the dashboard keeps some links inside its own views ("My design" holds the studio link)
      for (const view of ['studio', 'materials']) {
        await page.evaluate((v) => { location.hash = '#/' + v; }, view);
        await sleep(700);
        hrefs = hrefs.concat(await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'))));
      }
    }
    for (const other of CONNECTIONS[name]) {
      assert(hrefs.some((h) => pathOf(h) === PAGES[other]), `${name} has no link to ${other} (${PAGES[other]})`);
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
  await go(page, 'TERUCON', '/', { scope: 'header' });
  await go(page, 'Materials', '/materials', { scope: 'header' });
  await go(page, 'Design Studio', '/design-studio', { scope: 'header' });
  await go(page, 'My project', '/my-project', { scope: 'header' });
  await page.goto(base + '/design-studio', { waitUntil: 'domcontentloaded' });
  await sleep(600);
  await go(page, 'Materials', '/materials', { scope: 'header' });
  await page.goto(base + '/design-studio', { waitUntil: 'domcontentloaded' });
  await sleep(600);
  await go(page, 'Start a project', '/#enquire', { scope: 'header' });
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
  await go(page, 'Try it with your photo', '/design-studio');
  await sleep(1500);
  await page.evaluate(() => document.querySelector('header button[aria-label="Open menu"]').click());
  await sleep(1200);
  const cards = await page.evaluate(() => [...document.querySelectorAll('[data-menu] a')].map((a) => a.textContent.replace(/\s+/g, ' ').trim()));
  assert(cards.some((c) => c.startsWith('07 · Design Studio') || /You are here/.test(c)) && cards.some((c) => /Shop materials/.test(c)) && cards.some((c) => /My project/.test(c)), 'the phone menu lacks a card: ' + JSON.stringify(cards));
  await go(page, 'Materials', '/materials', { scope: '[data-menu]' }); // the card's eyebrow comes first: "Materials" "Shop materials →"
  await page.close();
});

await test('the studio opens inside the site: its splash, then its sign-in, then the studio', async () => {
  const page = await newPage();
  await page.goto(base + '/design-studio', { waitUntil: 'domcontentloaded' });
  await until(() => page.evaluate(() => !!document.querySelector('.swr-splash')), 'the "Powered by Terucon India" splash', 5000);
  const splash = await page.evaluate(() => document.querySelector('.swr-splash').innerText);
  assert(/Powered by/i.test(splash) && /Terucon India/.test(splash), 'the splash: ' + splash);
  await until(() => page.evaluate(() => /Sign in to the studio/.test(document.body.innerText) && !document.querySelector('.swr-splash')), 'the sign-in after the splash', 15000);
  assert(await page.evaluate(() => !!document.querySelector('header[data-nav]')), 'the studio sits under the site header');
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

await test('the shop: the search box and the assistant box both ask; "Not now" keeps the text, "Yes" takes the address out and goes on to the crop', async () => {
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
  // the assistant's box (opened from the search overlay, which is still open)
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Ask by voice/.test(b.textContent))?.click());
  await until(() => page.$('[data-import-urls][aria-label="Type a question"]'), 'the assistant box', 8000);
  await pasteInto(page, '[data-import-urls][aria-label="Type a question"]', 'https://www.flickr.com/photos/12345678@N05/53012345678/');
  await until(() => dialogText(page, '.tc-title'), 'the question in the assistant');
  assert(/photo from Flickr/.test(await dialogText(page, '.tc-text')), 'the assistant question is wrong');
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

await test('landing header: the chapter label ("03 Shell to handover") never sits on the logo or the links; it shows from 1366 px and is hidden below', async () => {
  for (const width of [1100, 1280, 1366, 1440, 1680]) {
    const page = await newPage({ width, height: 800 }, stack, { signedIn: false });
    try {
      await page.goto(base + '/', { waitUntil: 'networkidle2' });
      await sleep(800);
      for (const section of ['transform', 'enquire']) {
        await page.evaluate((key) => window.scrollTo(0, document.querySelector(`[data-sec="${key}"]`).getBoundingClientRect().top + scrollY + 40), section);
        await sleep(1200);
        const seen = await page.evaluate(() => {
          const label = document.querySelector('header [data-chapter]');
          const shown = getComputedStyle(label).display !== 'none' && Number(getComputedStyle(label).opacity) > 0.05;
          const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
          const others = [...document.querySelectorAll('header img, header nav a, header nav button')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; }).map((e) => ({ what: (e.textContent || e.alt || 'logo').trim().slice(0, 20), ...box(e) }));
          const mine = box(label);
          return { shown, text: label.textContent, mine, hits: others.filter((o) => o.l < mine.r - 1 && mine.l < o.r - 1 && o.t < mine.b && mine.t < o.b).map((o) => o.what), clipped: label.querySelector('[data-cht]').scrollWidth > label.querySelector('[data-cht]').clientWidth };
        });
        assert(seen.hits.length === 0, `at ${width} px, on "${seen.text}", the label covers: ${seen.hits.join(', ')}`);
        assert(seen.shown === (width >= 1366), `at ${width} px the label should be ${width >= 1366 ? 'shown' : 'hidden'} (shown: ${seen.shown})`);
        if (seen.shown) assert(!seen.clipped, `at ${width} px the label "${seen.text}" is cut short`);
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

await browser.close();
await stack.stop();
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} browser tests passed`);
process.exit(failed.length ? 1 : 0);
