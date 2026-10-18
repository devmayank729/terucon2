// Browser tests. Starts tests/dev/stack.mjs (the real site: node app.js + the Python model service, against a mock Google),
// drives Chrome through the real pages, reports.
//
//   cd tests/e2e && npm install && npm test            fast checks (~1 min)
//   npm run test:sam                                    also exercises real SAM 2 (downloads ~180 MB once)
//   CHROME_PATH=/path/to/chrome npm test                if Chrome is somewhere unusual
import puppeteer from 'puppeteer-core';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startStack } from '../dev/stack.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const wantSam = process.argv.includes('--sam');
const chrome = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find((p) => existsSync(p));
if (!chrome) { console.error('Chrome not found. Set CHROME_PATH.'); process.exit(2); }

const room = path.join(root, 'model/tests/fixtures/room.jpg');
if (!existsSync(room)) spawnSync(process.env.PYTHON || 'python3', [path.join(root, 'model/tests/synthetic.py')], { stdio: 'inherit' });

const site = JSON.parse(readFileSync(path.join(root, 'site/site.json'), 'utf8'));
const PAGES = Object.fromEntries(Object.entries(site.pages).map(([k, p]) => [k, p.route]));
const CONNECTIONS = Object.fromEntries(Object.entries(site.connections).filter(([k]) => k in site.pages));

const results = [];
const test = async (name, fn) => {
  const t0 = Date.now();
  try { await fn(); results.push([name, true, Date.now() - t0]); console.log(`  ok    ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  catch (e) { results.push([name, false, Date.now() - t0]); console.log(`  FAIL  ${name}\n        ${String(e.message || e).split('\n').join('\n        ')}`); }
};
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

const stack = await startStack({ port: 0, sam: wantSam ? 'real' : 'off' });
const base = stack.base;
console.log(`stack up at ${base}${wantSam ? ' (real SAM 2)' : ''}; model service: ${stack.config.model.status}\n`);
const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1440, height: 900 } });

// Every page we open records what a visitor would notice going wrong: script errors, console errors, same-origin 4xx/5xx.
// KNOWN_GAPS are reported, not failed. They come from the Claude Design exports themselves, identical in pages_original/:
// the Materials page has `<img src="{{ c.img }}">` inside its own <sc-for> template, which Chrome requests once, literally,
// before the page's runtime fills the template in. The real images load; nothing visible is wrong.
// The dashboard builds `media/materials/<id>.jpg` for each material; every one is embedded in the exports except fx-mill
// (the aluminium support frame), whose photo was never exported. Add media/materials/fx-mill.jpg and delete this entry.
const KNOWN_GAPS = [/\/%7B%7B(%20|\+| )[^/]*%7D%7D$/, /\/media\/materials\/fx-mill\.jpg$/];
const newPage = async () => {
  const p = await browser.newPage();
  p.problems = [];
  p.gaps = [];
  p.on('pageerror', (e) => p.problems.push('script error: ' + String(e).slice(0, 200)));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) p.problems.push('console error: ' + m.text().slice(0, 200)); });
  p.on('response', (r) => {
    const u = r.url();
    if (u.startsWith(base) && r.status() >= 400) {
      const line = `${r.status()} ${u.replace(base, '')}`;
      (KNOWN_GAPS.some((re) => re.test(u)) ? p.gaps : p.problems).push('http ' + line);
    }
  });
  return p;
};
const noProblems = (page, what) => assert(page.problems.length === 0, `${what}: ${page.problems.join('; ')}`);
const pathOf = (h) => { try { return decodeURI(new URL(h, base).pathname); } catch { return h; } };

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
    if (page.gaps.length) console.log(`        note: ${name} made requests that 404 (known, see KNOWN_GAPS in this file):\n          ${[...new Set(page.gaps)].join('\n          ')}`);
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

await test('old addresses redirect to the pages: file names (301), design-time names (302)', async () => {
  const page = await newPage();
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  const rows = [];
  for (const [key, p] of Object.entries(site.pages)) for (const a of p.aliases || []) rows.push([a, 301, p.route]);
  for (const [legacy, key] of Object.entries(site.legacy_names)) rows.push(['/' + legacy, 302, site.pages[key].route]);
  const got = await page.evaluate(async (list) => Promise.all(list.map(async ([p]) => { const r = await fetch(p.split('/').map(encodeURIComponent).join('/'), { redirect: 'manual' }); return [p, r.type, r.status]; })), rows);
  // fetch(redirect:'manual') hides the status of a redirect (opaqueredirect), so follow it instead and compare where it ended up
  const ended = await page.evaluate(async (list) => Promise.all(list.map(async ([p]) => { const r = await fetch(p.split('/').map(encodeURIComponent).join('/')); return [p, r.status, new URL(r.url).pathname, r.redirected]; })), rows);
  const bad = ended.filter(([p, status, finalPath, redirected], i) => status !== 200 || finalPath !== rows[i][2] || !redirected);
  assert(bad.length === 0, 'redirects wrong: ' + JSON.stringify(bad));
  assert(got.every(([, type]) => type === 'opaqueredirect'), 'a redirect was not a redirect: ' + JSON.stringify(got));
  await page.close();
});

await test('secrets and source code are never served', async () => {
  const page = await newPage();
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  const paths = ['/.env', '/.env.example', '/app.js', '/package.json', '/package-lock.json', '/server/config/settings.js', '/site/site.json', '/site/patches/studio.json', '/model/terucon_model/config.py',
    '/tools/build-site.js', '/tests/e2e/run.mjs', '/node_modules/express/package.json', '/pages/home.html', '/pages_original/index.html', '/docs/HOW_TO_RUN.md',
    '/README.md', '/.git/config', '/media/../.env', '/media/%2e%2e/.env', '/media/..%2f.env', '/site.json', '/run.py', '/terucon_server/config.py'];
  const codes = await page.evaluate(async (ps) => Promise.all(ps.map(async (p) => [p, (await fetch(p)).status])), paths);
  const leaked = codes.filter(([, c]) => c !== 404);
  assert(leaked.length === 0, 'served: ' + JSON.stringify(leaked));
  await page.close();
});

await test('the project overview opens, is linked from the site map, and shows the live server', async () => {
  const route = site.docs.overview.route;
  const page = await newPage();
  const r = await page.goto(base + route, { waitUntil: 'networkidle2' });
  assert(r.status() === 200, `${route} -> ${r.status()}`);
  await sleep(1200);
  const text = await page.evaluate(() => document.body.innerText);
  assert(/Terucon/.test(text) && /Express/.test(text) && /Python/.test(text), 'the overview does not describe the Express + Python architecture');
  assert(!/offline view/i.test(text), 'the overview does not see the live server');
  noProblems(page, 'overview');
  await page.close();
});

await test('the API answers as the Studio expects, and never contains a secret', async () => {
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; };
  const cfg = await get('/api/config');
  const j = JSON.parse(cfg.text);
  assert(j.server === true && j.google.configured && j.google.mode === 'vertex', 'config: ' + cfg.text.slice(0, 300));
  assert(j.model && ['ready', 'starting'].includes(j.model.status), 'the model service is not up: ' + JSON.stringify(j.model));
  assert(!/PRIVATE KEY|private_key|TESTKEYNOTREAL/.test(cfg.text), 'a secret is in /api/config');
  const h = JSON.parse((await get('/api/health')).text);
  assert(h.ok === true && h.google === true, 'health: ' + JSON.stringify(h));
  const s = JSON.parse((await get('/api/site')).text);
  assert(s.pages.length === Object.keys(PAGES).length, '/api/site lists ' + s.pages.length + ' pages');
  assert(!/pages\/|\.html/.test(JSON.stringify(s.pages)), '/api/site leaks file names');
  const sam = await get('/api/sam/health');
  assert(sam.status === 200, '/api/sam/health -> ' + sam.status);
});

let studioPage;
await test('Design Studio opens already connected (no key screen) and reads the server config', async () => {
  studioPage = await newPage();
  studioPage.__direct = [];
  studioPage.on('request', (r) => { if (/googleapis\.com/.test(r.url())) studioPage.__direct.push(r.url()); });
  await studioPage.goto(base + '/design-studio', { waitUntil: 'networkidle2' });
  await sleep(1200);
  const text = await studioPage.evaluate(() => document.body.innerText);
  assert(!/Connect your Google Cloud key/.test(text), 'the key screen is showing');
  assert(/terucon-test-project/.test(text), 'the connected project is not shown');
  assert(await studioPage.$('input[type=file]'), 'no photo input');
});

await test('a photo is scanned by the Python model service through the server into named surfaces', async () => {
  const api = [];
  studioPage.on('response', (r) => { if (/\/api\/segment/.test(r.url())) api.push(r.status()); });
  await (await studioPage.$('input[type=file]')).uploadFile(room);
  await studioPage.waitForFunction(() => /Surfaces by/i.test(document.querySelector('swatchroom-app')?.innerText || ''), { timeout: 60000 });
  const t = await studioPage.evaluate(() => document.querySelector('swatchroom-app').innerText.replace(/\s+/g, ' '));
  for (const n of ['Back wall', 'Left wall', 'Right wall', 'Floor', 'Ceiling', 'Window', 'Door', 'Sofa']) assert(t.includes(n), `missing surface: ${n}`);
  assert(/GEMINI-3\.8-FLASH \+ (EDGE SNAPPING|SAM)/i.test(t), 'the engine is not named: ' + t.slice(-200));
  assert(api.includes(200), 'the scan did not go through /api/segment: ' + JSON.stringify(api));
});

await test('a finish renders into the selected surface; Google is only ever called by the server', async () => {
  await studioPage.evaluate(() => [...document.querySelectorAll('swatchroom-app button')].find((x) => /^Floor\b/.test(x.innerText.trim())).click());
  await sleep(800);
  await studioPage.evaluate(() => [...document.querySelectorAll('swatchroom-app button')].find((x) => /Herringbone oak/.test(x.innerText)).click());
  await sleep(500);
  await studioPage.evaluate(() => [...document.querySelectorAll('swatchroom-app button')].find((x) => /^\s*Render\b/.test(x.innerText) && !x.disabled).click());
  await studioPage.waitForFunction(() => /V1\s+Herringbone oak/i.test(document.querySelector('swatchroom-app')?.innerText.replace(/\s+/g, ' ') || ''), { timeout: 60000 });
  assert(studioPage.__direct.length === 0, 'the page called Google directly: ' + studioPage.__direct.join(', '));
  const calls = await (await fetch(stack.mock + '/__calls')).json();
  assert(calls.generate.some((c) => c.model === 'gemini-nano-banana-2.1'), 'the render model was not called');
  // Express signs one token (renders) and the Python model service signs its own (detection): two exchanges, each cached for the run.
  assert(calls.tokens === 2, `expected two token exchanges (website + model service), saw ${calls.tokens}`);
  noProblems(studioPage, 'design studio');
});

if (wantSam) {
  await test('SAM: the scan reports it and the Pick tool uses it', async () => {
    const page = await newPage();
    const api = [];
    page.on('response', (r) => { if (/\/api\/(segment|sam)/.test(r.url())) api.push(r.url().replace(base, '') + ' ' + r.status()); });
    await page.goto(base + '/design-studio', { waitUntil: 'networkidle2' });
    await page.waitForFunction(async () => (await (await fetch('/api/sam/health')).json()).status === 'ok', { timeout: 120000 });
    await (await page.$('input[type=file]')).uploadFile(room);
    await page.waitForFunction(() => /Surfaces by/i.test(document.querySelector('swatchroom-app')?.innerText || ''), { timeout: 90000 });
    const t = await page.evaluate(() => document.querySelector('swatchroom-app').innerText.replace(/\s+/g, ' '));
    assert(/SAM 2\.1/i.test(t), 'SAM not named in: ' + t.slice(-160));
    await page.evaluate(() => [...document.querySelectorAll('swatchroom-app button')].find((x) => x.innerText.trim() === 'Pick').click());
    await sleep(2000);
    const box = await page.evaluate(() => { const c = [...document.querySelectorAll('swatchroom-app canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0].getBoundingClientRect(); return { x: c.x, y: c.y, w: c.width, h: c.height }; });
    await page.mouse.click(box.x + box.w * 0.51, box.y + box.h * 0.66);
    await sleep(3000);
    assert(api.some((a) => a.startsWith('/api/sam/refine') && a.endsWith('200')), 'Pick did not call /api/sam/refine: ' + api.join(', '));
    await page.close();
  });
}

await browser.close();
await stack.stop();

// A second site with the model service switched off: the website must still work, and say plainly why scanning is unavailable.
const noModel = await startStack({ port: 0, model: 'off' });
await test('without the Python model service the website still works and scanning explains itself', async () => {
  try {
    const cfg = await (await fetch(noModel.base + '/api/config')).json();
    assert(cfg.model.status === 'off', 'model status: ' + JSON.stringify(cfg.model));
    for (const route of Object.values(PAGES)) assert((await fetch(noModel.base + route)).status === 200, route + ' failed');
    const seg = await fetch(noModel.base + '/api/segment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: 'x' }) });
    const body = await seg.json();
    assert(seg.status === 503 && /switched off|MODEL_SERVICE/i.test(body.error.message), `segment -> ${seg.status} ${JSON.stringify(body)}`);
    const sam = await (await fetch(noModel.base + '/api/sam/health')).json();
    assert(sam.status === 'unavailable' || sam.status === 'off', 'sam health: ' + JSON.stringify(sam));
  } finally {
    await noModel.stop();
  }
});

const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
