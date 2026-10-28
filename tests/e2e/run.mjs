// Browser tests. Starts tests/dev/stack.mjs (the real website with the real Design Studio mounted in it, against mock GPU
// services, no database and no Google key), drives Chrome through the real pages, reports.
//
//   cd tests/e2e && npm install && npm test            (about a minute)
//   CHROME_PATH=/path/to/chrome npm test               if Chrome is somewhere unusual
import puppeteer from 'puppeteer-core';
import { existsSync, readFileSync } from 'node:fs';
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
  const t0 = Date.now();
  try { await fn(); results.push([name, true, Date.now() - t0]); console.log(`  ok    ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  catch (e) { results.push([name, false, Date.now() - t0]); console.log(`  FAIL  ${name}\n        ${String(e.message || e).split('\n').join('\n        ')}`); }
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
const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1440, height: 900 } });

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
const BY_DESIGN = [[401, /\/api\/vision\/warmup$/], [503, /\/api\/vision\/warmup$/], [500, /\/api\/rooms(\/|$)/]];
const newPage = async (viewport) => {
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
    if (u.startsWith(base) && r.status() >= 400) {
      const line = `${r.status()} ${u.replace(base, '')}`;
      const known = KNOWN_GAPS.some((re) => re.test(u)) || BY_DESIGN.some(([status, re]) => status === r.status() && re.test(new URL(u).pathname));
      (known ? p.gaps : p.problems).push('http ' + line);
    }
  });
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
    const page = await newPage();
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
    const page = await newPage();
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
  await sleep(2500);
  const box = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find((x) => x.textContent.trim().startsWith('Try it with your photo'));
    const r = a.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: innerHeight, visible: getComputedStyle(a).visibility !== 'hidden' && Number(getComputedStyle(a.parentElement.parentElement).opacity) > 0.9 };
  });
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

await browser.close();
await stack.stop();
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} browser tests passed`);
process.exit(failed.length ? 1 : 0);
