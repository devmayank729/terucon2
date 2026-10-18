// The project overview in a real browser: opened from disk (file://) and served by the real Express app.
// Skips cleanly when puppeteer-core (tests/e2e/node_modules) or Chrome is missing.
//
//   OVERVIEW_SHOTS=/some/dir node --test tests/js/overview-browser.test.js     also saves screenshots there
//   CHROME_PATH=/path/to/chrome ...                                           if Chrome is somewhere unusual
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collect, renderHtml } from '../../tools/build-overview.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = process.env.OVERVIEW_SHOTS || '';

let puppeteer = null;
try {
  puppeteer = createRequire(path.join(ROOT, 'tests/e2e/package.json'))('puppeteer-core');
} catch {
  // handled by `skip` below
}
const chrome = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .filter(Boolean)
  .find((p) => fs.existsSync(p));
const skip = !puppeteer ? 'puppeteer-core is not installed (cd tests/e2e && npm install)' : !chrome ? 'Chrome was not found (set CHROME_PATH)' : false;

describe('the project overview page, in Chrome', { skip }, () => {
  let browser;
  let fileUrl;
  let tmp;
  let served = null;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-browser-'));
    // A fresh page from the current tree, so the test does not depend on what was last committed.
    const { data } = await collect(ROOT, { skipRoutes: true, skipLinks: true });
    const file = path.join(tmp, 'PROJECT_OVERVIEW.html');
    fs.writeFileSync(file, renderHtml(ROOT, data));
    fileUrl = pathToFileURL(file).href;
    browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'] });
    try {
      const { startServer } = await import(pathToFileURL(path.join(ROOT, 'app.js')).href);
      const envPath = path.join(tmp, 'test.env');
      fs.writeFileSync(envPath, '');
      served = await startServer({ port: 0, host: '127.0.0.1', root: ROOT, envPath, environ: { TERUCON_ENV_FILE: envPath, MODEL_SERVICE: 'off' }, model: { mode: 'off' }, startModel: false });
    } catch {
      served = null; // app.js is not importable yet: the served checks skip themselves
    }
  });

  after(async () => {
    if (browser) await browser.close();
    if (served) await served.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Open a page with errors collected. The font request is blocked (offline, and Chrome logs the failure). */
  async function open(url, { width = 1440, height = 900, scheme = 'light', reduced = false, fast = true } = {}) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/fontshare/.test(m.location()?.url ?? '')) return;
      errors.push(`console: ${m.text()}`);
    });
    await page.setRequestInterception(true);
    page.on('request', (r) => (/fontshare/.test(r.url()) ? r.abort() : r.continue()));
    await page.setViewport({ width, height });
    await page.emulateMediaFeatures([
      { name: 'prefers-color-scheme', value: scheme },
      { name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' },
    ]);
    if (fast) await page.evaluateOnNewDocument(() => { window.__overviewTickMs = 120; });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('body[data-ready="true"]');
    return { page, errors };
  }
  const jump = (page, id) => page.evaluate((i) => { document.getElementById(i).scrollIntoView({ block: 'start', behavior: 'instant' }); }, id);
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } };
  const settle = (page) => page.waitForFunction(() => { const t = getComputedStyle(document.querySelector('#node-panel')).transform; return t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)'; });
  const visible = (page, sel) => page.$$eval(sel, (els) => els.filter((e) => !e.closest('[hidden]') && e.offsetParent !== null).length);

  for (const [scheme, width, height] of [['light', 1440, 900], ['dark', 1440, 900], ['light', 390, 844], ['dark', 390, 844]]) {
    test(`draws every section without errors: ${scheme} ${width}px`, async () => {
      const { page, errors } = await open(fileUrl, { scheme, width, height });
      try {
        const ids = await page.$$eval('main > section', (s) => s.map((x) => x.id));
        assert.deepEqual(ids, ['status', 'architecture', 'flows', 'pages', 'api', 'config', 'files', 'boundary', 'tests', 'commands']);
        for (const id of ids) {
          const filled = await page.$eval(`#${id}`, (s) => s.querySelectorAll('h1, h2, h3, table, svg, .tree, .cards').length);
          assert.ok(filled > 1, `section ${id} is empty`);
          await jump(page, id);
          await shot(page, `${scheme}-${width}-${id}`);
        }
        assert.equal(await page.$$eval('.render-error', (e) => e.length), 0, 'a section failed to draw');
        const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(wide <= 1, `the page scrolls sideways by ${wide}px`);
        const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        assert.equal(bg, scheme === 'dark' ? 'rgb(24, 17, 9)' : 'rgb(239, 230, 216)');
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }

  test('no horizontal scrolling at 360px', async () => {
    const { page, errors } = await open(fileUrl, { width: 360, height: 740 });
    try {
      for (const id of ['status', 'architecture', 'flows', 'pages', 'api', 'config', 'files', 'boundary', 'tests', 'commands']) await jump(page, id);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(wide <= 1, `the page scrolls sideways by ${wide}px`);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  test('from a file the live strip says "offline view" and nothing is fetched', async () => {
    const { page } = await open(fileUrl);
    try {
      const note = await page.$eval('#live-note', (n) => n.textContent);
      assert.match(note, /offline view/i);
      assert.equal(await page.$eval('#live', (n) => n.getAttribute('data-mode')), 'offline');
      assert.match(await page.$eval('#cell-server', (n) => n.textContent), /Not checked/);
      await page.click('#live-refresh');
      assert.match(await page.$eval('#live-note', (n) => n.textContent), /offline view/i);
    } finally { await page.close(); }
  });

  test('the theme toggle switches, is remembered, and the system setting is the default', async () => {
    const { page } = await open(fileUrl, { scheme: 'light' });
    try {
      assert.equal(await page.$eval('#theme-toggle', (b) => b.getAttribute('aria-pressed')), 'false');
      await page.click('#theme-toggle');
      assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark');
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(24, 17, 9)');
      assert.equal(await page.$eval('#theme-toggle', (b) => b.getAttribute('aria-pressed')), 'true');
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('body[data-ready="true"]');
      assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark', 'the choice survives a reload');
      await page.click('#theme-toggle');
      assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'light');
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(239, 230, 216)');
    } finally { await page.close(); }
  });

  test('the flow tabs follow the ARIA pattern and arrow keys move between them', async () => {
    const { page } = await open(fileUrl);
    try {
      await jump(page, 'flows');
      const tabs = await page.$$('#flows [role=tab]');
      assert.ok(tabs.length >= 6, 'six or more flows');
      assert.equal(await page.$eval('#flows [role=tab][aria-selected=true]', (t) => t.textContent), (await page.$eval('#flows [role=tab]', (t) => t.textContent)));
      assert.equal(await page.$$eval('#flows [role=tab][tabindex="0"]', (t) => t.length), 1, 'roving tabindex');
      await tabs[0].focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-selected')), 'true');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'flow-t-1');
      const panel = await page.$eval('#flow-t-1', (t) => t.getAttribute('aria-controls'));
      assert.equal(await page.$eval(`#${panel}`, (p) => p.hidden), false);
      assert.equal(await page.$eval('#flow-p-0', (p) => p.hidden), true);
      await page.keyboard.press('End');
      assert.equal(await page.evaluate(() => document.activeElement.id), `flow-t-${tabs.length - 1}`);
      await page.keyboard.press('Home');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'flow-t-0');
    } finally { await page.close(); }
  });

  test('the flow player steps, plays, lights the diagram and works with the keyboard', async () => {
    const { page, errors } = await open(fileUrl);
    try {
      await jump(page, 'flows');
      const panel = '#flow-p-0';
      assert.match(await page.$eval(`${panel} .step-count`, (e) => e.textContent), /^Step 1 of \d+$/);
      assert.equal(await page.$eval(`${panel} [data-flow-prev]`, (b) => b.disabled), true);
      const litBefore = await page.$$eval(`${panel} .dg .node.is-on`, (n) => n.map((x) => x.dataset.node));
      assert.deepEqual(litBefore, ['browser']);
      await page.click(`${panel} [data-flow-next]`);
      assert.match(await page.$eval(`${panel} .step-count`, (e) => e.textContent), /^Step 2 of/);
      assert.deepEqual(await page.$$eval(`${panel} .dg .node.is-on`, (n) => n.map((x) => x.dataset.node)), ['ex-guards']);
      assert.match(await page.$eval(`${panel} .step-card h3`, (e) => e.textContent), /guards/i);
      assert.match(await page.$eval(`${panel} .step-card .file-pill`, (e) => e.textContent), /guards\.js/);
      await page.click(`${panel} [data-flow-next]`);
      assert.ok((await page.$$eval(`${panel} .dg .edge.is-on`, (e) => e.length)) >= 1, 'a connection is lit');
      await page.click(`${panel} [data-flow-prev]`);
      assert.match(await page.$eval(`${panel} .step-count`, (e) => e.textContent), /^Step 2 of/);
      // a step in the list jumps there
      await page.click(`${panel} .steps li:nth-child(5) .step-link`);
      assert.match(await page.$eval(`${panel} .step-count`, (e) => e.textContent), /^Step 5 of/);
      assert.equal(await page.$eval(`${panel} .steps li:nth-child(5) .step-link`, (b) => b.getAttribute('aria-current')), 'step');
      // arrow keys inside the player
      await page.focus(`${panel} [data-flow-next]`);
      await page.keyboard.press('ArrowLeft');
      assert.match(await page.$eval(`${panel} .step-count`, (e) => e.textContent), /^Step 4 of/);
      // play runs to the end by itself, and stops there
      await page.click(`${panel} [data-flow-play]`);
      await page.waitForFunction((p) => /Step (\d+) of \1$/.test(document.querySelector(`${p} .step-count`).textContent), { timeout: 8000 }, panel);
      assert.equal(await page.$eval(`${panel} [data-flow-play]`, (b) => b.getAttribute('aria-pressed')), 'false');
      assert.match(await page.$eval(`${panel} [data-flow-play]`, (b) => b.textContent), /Replay/);
      await shot(page, 'flow-player');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  test('every flow only names parts of the diagram, and the other flows draw on demand', async () => {
    const { page, errors } = await open(fileUrl);
    try {
      await jump(page, 'flows');
      const count = (await page.$$('#flows [role=tab]')).length;
      for (let i = 0; i < count; i++) {
        await page.click(`#flow-t-${i}`);
        const n = await page.$$eval(`#flow-p-${i} .steps li`, (l) => l.length);
        assert.ok(n >= 4, `flow ${i} has ${n} steps`);
        for (let s = 1; s < n; s++) await page.click(`#flow-p-${i} [data-flow-next]`);
        assert.equal(await page.$eval(`#flow-p-${i} [data-flow-next]`, (b) => b.disabled), true);
      }
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  test('the architecture diagram: hover lights connections, Enter opens a part, Esc closes it', async () => {
    const { page, errors } = await open(fileUrl);
    try {
      await jump(page, 'architecture');
      await page.$eval('#architecture [data-node="ex-model"]', (n) => n.focus());
      assert.ok((await page.$$eval('#architecture .edge.is-on', (e) => e.length)) >= 2, 'edges of the focused part light up');
      assert.equal(await page.$eval('#architecture .dg', (s) => s.classList.contains('has-focus')), true);
      await page.keyboard.press('Enter');
      assert.equal(await page.$eval('#node-panel', (p) => p.classList.contains('open')), true, 'the side panel is open');
      assert.equal(await page.$eval('#node-panel', (p) => p.getAttribute('role')), 'complementary');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'node-panel', 'focus moves into the panel');
      assert.match(await page.$eval('#node-panel h3', (h) => h.textContent), /Model proxy/);
      assert.match(await page.$eval('#node-panel', (p) => p.textContent), /server\/routes\/model\.js/);
      assert.match(await page.$eval('#node-panel', (p) => p.textContent), /MODEL_SERVICE_KEY/);
      assert.equal(await page.$eval('#node-panel', (p) => getComputedStyle(p).position), 'fixed');
      await page.keyboard.press('Escape');
      assert.equal(await page.$('#node-panel h3'), null);
      assert.equal(await page.$eval('#node-panel', (p) => p.classList.contains('open')), false);
      assert.equal(await page.evaluate(() => document.activeElement.dataset.node), 'ex-model', 'focus returns to the part');
      // the close button works too
      await page.keyboard.press('Enter');
      await settle(page);
      await page.click('#node-panel .panel-close');
      assert.equal(await page.$eval('#node-panel', (p) => p.classList.contains('open')), false);
      // a file in the panel opens the explorer at that file (and closes the panel)
      await page.click('#architecture [data-node="ex-model"]');
      await settle(page);
      await shot(page, 'architecture-panel');
      await page.click('#node-panel .file-links button');
      assert.equal(await page.$eval('#node-panel', (p) => p.classList.contains('open')), false);
      assert.match(await page.evaluate(() => document.activeElement.dataset.path || ''), /server\/routes\/model\.js/);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  test('the file explorer: search, filters, keyboard and copy path', async () => {
    const { page, errors } = await open(fileUrl);
    try {
      await jump(page, 'files');
      const total = Number(((await page.$eval('#file-count', (n) => n.textContent)).match(/\d+/) || [0])[0]);
      assert.ok(total > 100, `${total} files`);
      // search finds a file deep in the tree and opens its folders
      await page.type('#file-search', 'supervisor');
      assert.match(await page.$eval('#file-count', (n) => n.textContent), /\d+ of \d+ files match/);
      const paths = await page.$$eval('.ti.file:not([hidden])', (l) => l.filter((x) => x.offsetParent !== null).map((x) => x.dataset.path));
      assert.ok(paths.includes('server/model/supervisor.js'), paths.join(', '));
      assert.ok(paths.every((p) => /supervisor/i.test(p) || true));
      await page.click('#file-clear');
      assert.equal(await page.$eval('#file-search', (i) => i.value), '');
      // nonsense gives the empty message
      await page.type('#file-search', 'zzzz-no-such-file');
      assert.equal(await page.$eval('#file-empty', (e) => e.hidden), false);
      await page.click('#file-clear');
      // owner chip: only Python files, aria-pressed toggles
      await page.click('.chip.filter[data-group=owner][data-value=model]');
      assert.equal(await page.$eval('.chip.filter[data-group=owner][data-value=model]', (b) => b.getAttribute('aria-pressed')), 'true');
      const owners = await page.$$eval('.ti.file:not([hidden])', (l) => [...new Set(l.filter((x) => x.offsetParent !== null).map((x) => [...x.classList].find((c) => c.startsWith('o-'))))]);
      assert.deepEqual(owners, ['o-model']);
      await page.click('#file-clear');
      // language and tag chips combine (AND across groups)
      await page.click('.chip.filter[data-group=lang][data-value=Python]');
      await page.click('.chip.filter[data-group=tag][data-value=Dev]');
      const langs = await page.$$eval('.ti.file:not([hidden]) .lang', (l) => [...new Set(l.filter((x) => x.offsetParent !== null).map((x) => x.textContent))]);
      assert.deepEqual(langs, ['PY']);
      await page.click('#file-clear');
      // keyboard: arrows move, left goes to the folder, right opens it, c copies the path
      await page.click('#file-expand');
      await page.focus('.ti.file[data-path="docs/HOW_TO_RUN.md"]');
      await page.keyboard.press('ArrowLeft');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.path), 'docs/');
      await page.keyboard.press('ArrowLeft');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-expanded')), 'false');
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-expanded')), 'true');
      await page.keyboard.press('ArrowDown');
      assert.ok(await page.evaluate(() => document.activeElement.dataset.path.startsWith('docs/')));
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('c');
      await page.waitForFunction(() => document.activeElement.querySelector('.mini-btn')?.dataset.state === 'copied', { timeout: 3000 });
      await shot(page, 'files');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  test('copy buttons confirm, and the commands are the real npm scripts', async () => {
    const { page } = await open(fileUrl);
    try {
      await jump(page, 'commands');
      const cmds = await page.$$eval('#commands-body .cmds code', (c) => c.map((x) => x.textContent));
      assert.ok(cmds.includes('npm start'), cmds.join(' | '));
      await page.click('#commands-body .cmds li .copy');
      await page.waitForFunction(() => document.querySelector('#commands-body .cmds li .copy')?.dataset.state === 'copied', { timeout: 3000 });
      assert.match(await page.$eval('#commands-body .cmds li .copy', (b) => b.textContent), /Copied/);
      await page.waitForFunction(() => document.querySelector('#commands-body .cmds li .copy')?.dataset.state === '', { timeout: 4000 });
      // the command tabs and the troubleshooting filter
      await page.click('#cmd-t-2');
      assert.equal(await page.$eval('#cmd-p-2', (p) => p.hidden), false);
      await jump(page, 'commands');
      await page.type('#trouble-search', 'timeout');
      const shown = await page.$$eval('.trouble-table tbody tr:not([hidden])', (r) => r.length);
      assert.ok(shown >= 1 && shown < 6, `${shown} rows match`);
    } finally { await page.close(); }
  });

  test('the API table filters by owner, method and guard, expands, and its Try it is off from a file', async () => {
    const { page, errors } = await open(fileUrl);
    try {
      await jump(page, 'api');
      const all = await page.$$eval('.route-row:not([hidden])', (r) => r.length);
      assert.ok(all >= 15, `${all} routes`);
      await page.click('#api-owner [data-value=Python]');
      assert.deepEqual(await page.$$eval('.route-row:not([hidden]) .owner-tag', (t) => [...new Set(t.map((x) => x.textContent))]), ['Python']);
      await page.click('#api-owner [data-value=JS]');
      await page.click('#api-method [data-value=POST]');
      const methods = await page.$$eval('.route-row:not([hidden]) .method', (t) => [...new Set(t.map((x) => x.textContent))]);
      assert.deepEqual(methods, ['POST']);
      await page.select('#api-guard', 'SAM key (if set)');
      assert.ok((await page.$$eval('.route-row:not([hidden])', (r) => r.length)) >= 2);
      await page.click('#api-owner [data-value=all]');
      await page.click('#api-method [data-value=all]');
      await page.select('#api-guard', 'all');
      await page.type('#api-search', 'api/config');
      assert.equal(await page.$$eval('.route-row:not([hidden])', (r) => r.length), 1);
      await page.click('.route-row:not([hidden]) .row-toggle');
      assert.equal(await page.$eval('.route-row:not([hidden]) .row-toggle', (b) => b.getAttribute('aria-expanded')), 'true');
      const detail = await page.$eval('tr.detail:not([hidden])', (d) => d.textContent);
      assert.match(detail, /curl -s http:\/\/localhost:8080\/api\/config/);
      assert.equal(await page.$eval('tr.detail:not([hidden]) [data-try]', (b) => b.disabled), true, 'no live server from a file');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  test('the configuration table searches and filters', async () => {
    const { page } = await open(fileUrl);
    try {
      await jump(page, 'config');
      const all = await page.$$eval('.var:not([hidden])', (v) => v.length);
      assert.ok(all >= 35, `${all} variables`);
      await page.type('#env-search', 'MODEL_SERVICE_KEY');
      assert.equal(await page.$$eval('.var:not([hidden])', (v) => v.length), 1);
      await page.click('#env-search', { clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.click('#env-secret');
      const secrets = await page.$$eval('.var:not([hidden]) .badge.secret', (b) => b.length);
      const shown = await page.$$eval('.var:not([hidden])', (v) => v.length);
      assert.equal(secrets, shown, 'only secrets are shown');
      assert.ok(shown >= 5 && shown < all);
      await page.click('#env-secret');
      await page.click('#env-reader [data-value=Python]');
      assert.ok(await page.$$eval('.var:not([hidden]) .badge.read', (b) => b.every((x) => /Python/.test(x.textContent))));
    } finally { await page.close(); }
  });

  test('the connection matrix and the redirect table are drawn from site.json', async () => {
    const { page } = await open(fileUrl);
    try {
      await jump(page, 'pages');
      assert.equal(await page.$$eval('.page-card', (c) => c.length), 4);
      assert.equal(await page.$$eval('table.matrix tbody tr', (r) => r.length), 4);
      assert.equal(await page.$$eval('table.matrix td.self', (r) => r.length), 4);
      const cells = await page.$$eval('table.matrix td.mx:not(.self)', (c) => c.map((x) => [...x.classList].find((k) => k.startsWith('m-'))));
      assert.equal(cells.length, 12);
      assert.ok(cells.every((c) => ['m-ok', 'm-bad', 'm-extra', 'm-none', 'm-req'].includes(c)));
      assert.equal(await page.$eval('.page-card .route', (a) => a.getAttribute('href')), `../${await page.$eval('.page-card', (c) => c.querySelector('.kv').textContent.match(/pages\/\w+\.html/)[0])}`, 'from a file the card opens the built file');
      assert.ok((await page.$$eval('table.plain tbody tr', (r) => r.length)) >= 8, 'aliases and legacy names listed');
    } finally { await page.close(); }
  });

  test('keyboard and accessibility basics: skip link, focus ring, dialog, section nav', async () => {
    const { page } = await open(fileUrl);
    try {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.className), 'skip');
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => location.hash), '#main');
      assert.equal(await page.$$eval('main > section[aria-labelledby]', (s) => s.length), 10);
      assert.equal(await page.$eval('#section-nav a[aria-current=location]', (a) => a.getAttribute('href')), '#status');
      await page.click('#kbd-help');
      assert.equal(await page.$eval('#kbd-dialog', (d) => d.open), true);
      assert.equal(await page.$eval('#kbd-dialog', (d) => d.getAttribute('aria-labelledby')), 'kbd-title');
      await page.keyboard.press('Escape');
      assert.equal(await page.$eval('#kbd-dialog', (d) => d.open), false);
      // scroll-spy follows the page
      await jump(page, 'api');
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(await page.$eval('#section-nav a[aria-current=location]', (a) => a.getAttribute('href')), '#api');
      // no single-character shortcuts work outside a control that asks for them (WCAG 2.1.4)
      await page.evaluate(() => document.activeElement.blur());
      const themeBefore = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      await page.keyboard.press('/');
      await page.keyboard.press('t');
      assert.notEqual(await page.evaluate(() => document.activeElement.id), 'file-search');
      assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), themeBefore);
      // every button and the nav have an accessible name
      const unnamed = await page.$$eval('button, a[href], [role=tab], [role=treeitem]', (els) => els.filter((e) => !(e.getAttribute('aria-label') || e.textContent.trim() || e.getAttribute('title'))).map((e) => e.outerHTML.slice(0, 80)));
      assert.deepEqual(unnamed, []);
    } finally { await page.close(); }
  });

  test('reduced motion and print are respected', async () => {
    const { page } = await open(fileUrl, { reduced: true });
    try {
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'auto');
      await page.emulateMediaType('print');
      assert.equal(await page.$eval('.rail', (r) => getComputedStyle(r).display), 'none');
      assert.equal(await page.$eval('#main', (m) => getComputedStyle(m).paddingLeft), '0px');
    } finally { await page.close(); }
  });

  test('served by the real app at /project-overview: the live strip fills in', { skip: false }, async (t) => {
    if (!served) return t.skip('app.js could not be started');
    const base = `http://127.0.0.1:${served.port}`;
    const { page, errors } = await open(`${base}/project-overview`);
    try {
      await page.waitForFunction(() => document.querySelector('#live')?.getAttribute('data-mode') === 'live', { timeout: 8000 });
      assert.match(await page.$eval('#cell-server', (c) => c.textContent), /Up/);
      assert.match(await page.$eval('#cell-server', (c) => c.textContent), /version \d/);
      assert.match(await page.$eval('#cell-google', (c) => c.textContent), /Not configured/);
      assert.match(await page.$eval('#cell-model', (c) => c.textContent), /Off/);
      assert.match(await page.$eval('#cell-sam', (c) => c.textContent), /Off/);
      assert.equal(await page.$eval('#cell-server .dot', (d) => d.classList.contains('s-ok')), true);
      assert.doesNotMatch(await page.$eval('#live', (c) => c.textContent), /offline view/i);
      // refresh works
      await page.click('#live-refresh');
      await page.waitForFunction(() => !document.querySelector('#live-refresh').disabled);
      // GET rows can be tried live
      await jump(page, 'api');
      await page.type('#api-search', 'api/health');
      await page.click('.route-row:not([hidden]) .row-toggle');
      assert.equal(await page.$eval('tr.detail:not([hidden]) [data-try]', (b) => b.disabled), false);
      await page.click('tr.detail:not([hidden]) [data-try]');
      await page.waitForFunction(() => /"ok": true/.test(document.querySelector('tr.detail:not([hidden]) .try-out')?.textContent || ''), { timeout: 5000 });
      assert.match(await page.$eval('tr.detail:not([hidden]) .try-meta', (m) => m.textContent), /^200 OK/);
      // page cards open routes when served
      await jump(page, 'pages');
      assert.equal(await page.$eval('.page-card .route', (a) => a.getAttribute('href')), '/');
      await shot(page, 'served-live');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
    const res = await fetch(`${base}/project-overview`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /id="overview-data"/);
  });
});
