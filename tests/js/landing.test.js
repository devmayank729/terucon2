// The landing page ("/"): what server/lib/landing/ builds from site/landing/ and how server/routes/landing.js serves it.
// Real files, real server (the temp project is a copy of site/landing); no browser here (tests/e2e/run.mjs drives Chrome through it).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import zlib from 'node:zlib';
import { startServer } from '../../app.js';
import { buildLanding, LandingError, minifyCss, trimJs } from '../../server/lib/landing/index.js';
import { check as checkPictures } from '../../tools/optimize-landing.mjs';
import { collectLog } from '../helpers/app.js';
import { captureProviders, SECRET } from '../helpers/authKit.js';
import { request } from '../helpers/http.js';
import { makeTempRoot, PROJECT_ROOT } from '../helpers/tempRoot.js';

const FIXED = () => new Date('2026-01-01T00:00:00Z');
const build = (root = PROJECT_ROOT) => buildLanding({ root, now: FIXED });
const text = (b) => b.html.toString('utf8');
const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([a-zA-Z][\w:-]*)(?:="([^"]*)")?/g)].map((m) => [m[1], m[2] ?? '']));
const tagsOf = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'g'))].map((m) => ({ raw: m[0], ...attrs(m[1]) }));
const site = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'site/site.json'), 'utf8'));
const ROUTES = new Set([...Object.values(site.pages).map((p) => p.route), ...Object.values(site.docs).map((d) => d.route)]);

describe('the build', () => {
  const b = build();
  const html = text(b);

  test('builds, and the same files give the same bytes', () => {
    assert.ok(b);
    assert.equal(build().etag, b.etag);
    assert.ok(Buffer.compare(build().html, b.html) === 0);
  });

  test('size budgets: the page, its brotli copy, the script and the first screen', () => {
    assert.ok(b.html.length < 130 * 1024, `page ${b.html.length} bytes`);
    assert.ok(b.htmlBr.length < 24 * 1024, `page, brotli: ${b.htmlBr.length} bytes`);
    assert.ok(b.report.jsBytes < 20 * 1024, `script ${b.report.jsBytes} bytes`);
    assert.ok(b.report.cssBytes < 50 * 1024, `css ${b.report.cssBytes} bytes`);
    // what a phone fetches before the first screen is complete: the page, the body font, the logo, the portrait hero picture Chrome picks on a 412 px phone (800 w)
    const img = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'site/landing/img/index.json'), 'utf8'));
    const hero = img['hero-01-m'].variants.find((v) => v.w === 800);
    const logo = img.logo.variants.find((v) => v.w === 264);
    const font = [...b.assets.values()].find((a) => a.type === 'font/woff2' && a.body.length > 25000 && a.body.length < 35000);
    const first = b.htmlBr.length + hero.bytes + logo.bytes + font.body.length;
    assert.ok(first < 220 * 1024, `first screen ${(first / 1024).toFixed(0)} KB`);
  });

  test('every address the page asks for under /lp/ is built, and nothing is built that no page uses', () => {
    const asked = new Set([...html.matchAll(/\/lp\/([A-Za-z0-9._-]+)/g)].map((m) => m[1]));
    for (const name of asked) assert.ok(b.assets.has(name), `${name} is not built`);
    const unused = [...b.assets.keys()].filter((n) => !asked.has(n) && !n.startsWith('later-'));
    // the picture variants a template or a <picture> names are all in the page; what is left would be dead weight
    assert.deepEqual(unused, [], `built but never named: ${unused.join(', ')}`);
  });

  test('nothing is fetched from another site: no external script, stylesheet, font, picture or frame', () => {
    const external = (u) => /^(https?:)?\/\//.test(u);
    for (const t of tagsOf(html, 'script')) assert.ok(!t.src || !external(t.src), `script ${t.src}`);
    for (const t of tagsOf(html, 'link')) assert.ok(!t.href || !external(t.href), `link ${t.href}`);
    for (const t of tagsOf(html, 'img')) assert.ok(!external(t.src), `img ${t.src}`);
    for (const t of tagsOf(html, 'source')) assert.ok(!/https?:/.test(t.srcset || ''), 'source srcset');
    assert.ok(!/<iframe|<embed|<object/.test(html));
    const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
    assert.ok(!/url\(\s*["']?(https?:)?\/\//.test(css), 'a url() in the css points at another site');
    assert.ok(!/fonts\.googleapis|fonts\.gstatic|unpkg\.com|cdn\./.test(html));
  });

  test('every picture has an alt, a width and a height; only the first slide is loaded eagerly, once, with high priority', () => {
    const imgs = tagsOf(html.replace(/<template[\s\S]*?<\/template>/g, ''), 'img');
    assert.ok(imgs.length > 25);
    for (const i of imgs) {
      assert.ok('alt' in i, `no alt: ${i.src}`);
      assert.ok(i.width && i.height, `no size: ${i.src}`);
      assert.ok(i.srcset && i.sizes, `no srcset/sizes: ${i.src}`);
    }
    const eager = imgs.filter((i) => i.loading !== 'lazy');
    assert.deepEqual(eager.map((i) => i.alt), ['Terucon India', 'Contemporary commercial building with a bronze ACP façade at dusk'], 'the logo and the first hero picture are the only eager pictures');
    assert.equal(imgs.filter((i) => i.fetchpriority === 'high').length, 1);
    // the first hero picture is also named in <head>, before the inline stylesheet, for each orientation (matching the <picture>, so it is fetched once)
    const pre = tagsOf(html, 'link').filter((l) => l.rel === 'preload' && l.as === 'image');
    assert.deepEqual(pre.map((l) => l.media), ['(orientation: landscape)', '(orientation: portrait)']);
    for (const l of pre) {
      assert.equal(l.fetchpriority, 'high');
      assert.equal(l.imagesizes, '100vw');
      assert.ok(html.indexOf(l.raw) < html.indexOf('<style>'), 'the preload comes before the stylesheet');
    }
    const portrait = html.match(/<source media="\(orientation: portrait\)" srcset="([^"]+)"/)[1];
    assert.equal(pre[1].imagesrcset, portrait, 'the portrait preload names the same candidates as the <picture>');
    assert.equal(pre[0].imagesrcset, imgs[1].srcset, 'the landscape preload names the same candidates as the first <img>');
  });

  test('no inline event handlers, no style attributes, no javascript: addresses', () => {
    assert.ok(!/\son[a-z]+="/i.test(html), 'an on...= attribute');
    assert.ok(!/\sstyle="/.test(html.replace(/<template[\s\S]*?<\/template>/g, '')), 'a style attribute');
    assert.ok(!/javascript:/i.test(html));
  });

  test('ids are unique, every #address and every aria-controls / aria-describedby points at something', () => {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'duplicate id');
    for (const m of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(m[1]), `#${m[1]} has no target`);
    for (const m of html.matchAll(/aria-(?:controls|describedby|labelledby)="([^"]+)"/g)) for (const id of m[1].split(' ')) assert.ok(ids.includes(id), `aria points at #${id}`);
  });

  test('the site\'s own addresses are routes of the site map; the Design Studio button goes to this site, not to terucon.in', () => {
    const own = [...html.matchAll(/<a\b[^>]*\shref="(\/[^"#?]*)"/g)].map((m) => m[1]);
    assert.ok(own.includes('/design-studio'));
    for (const href of own) assert.ok(ROUTES.has(href), `${href} is not a route of site/site.json`);
    for (const href of ['/materials', '/design-studio', '/inspiration', '/finder', '/my-project', '/login']) assert.ok(own.includes(href), `${href} is not linked (the platform links)`);
    assert.ok(!html.includes('terucon.in/design-studio'), 'a button still points at terucon.in/design-studio');
    // what exists only on the company\'s current website keeps its address there (decided 2026-11-10)
    assert.ok(html.includes('https://terucon.in/acp-sheets/') && html.includes('https://terucon.in/projects/'));
  });

  test('no domain is claimed while config.json has no siteUrl: no canonical, og:url, og:image, no address in the structured data', () => {
    assert.ok(!/rel="canonical"/.test(html) && !/og:url/.test(html) && !/og:image/.test(html));
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    const nodes = Object.fromEntries(ld['@graph'].map((n) => [n['@type'], n]));
    assert.equal(nodes.GeneralContractor.name, 'Terucon India Private Limited');
    assert.equal(nodes.GeneralContractor.telephone, '+91-63601-65982');
    assert.ok(!JSON.stringify(ld).includes('terucon.in'), 'a terucon.in address in the structured data');
    assert.equal(nodes.FAQPage.mainEntity.length, 7);
    for (const q of nodes.FAQPage.mainEntity) assert.ok(html.includes(q.acceptedAnswer.text.replace(/&/g, '&amp;')) || html.includes(q.acceptedAnswer.text), 'a structured-data answer is not on the page');
    assert.match(html, /<html lang="en-IN">/);
  });

  test('with a siteUrl in config.json the canonical, og:url and the structured-data addresses turn on', () => {
    const temp = copyLanding();
    try {
      const cfgFile = path.join(temp.root, 'site/landing/config.json');
      const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, siteUrl: 'https://example.test/' }));
      const h = text(build(temp.root));
      assert.match(h, /<link rel="canonical" href="https:\/\/example\.test\/">/);
      assert.match(h, /<meta property="og:url" content="https:\/\/example\.test\/">/);
      assert.match(h, /"@id":"https:\/\/example\.test\/#org"/);
    } finally {
      temp.cleanup();
    }
  });

  test('the enquiry form saves on this site and has no WhatsApp in it; the honeypot and the service choices are there', () => {
    const form = html.match(/<form class="form" id="enquiry"[\s\S]*?<\/form>/)[0];
    assert.ok(!/wa\.me|whatsapp/i.test(form), 'WhatsApp in the form');
    assert.ok(!/whatsapp/i.test(html.match(/<div class="sent"[\s\S]*?<\/div>\s*<\/div>/)[0]), 'WhatsApp in the thank-you');
    assert.match(form, /name="website"[^>]*tabindex="-1"/);
    assert.equal((form.match(/type="radio" name="service"/g) || []).length, 8);
    assert.ok(/Phone number \*/.test(form) && !/WhatsApp number/.test(form));
    assert.ok(!/action=/.test(form), 'a form action: it is sent by landing.js');
  });

  test('pictures that were not delivered (project photos, client logos, TeruBot\'s face) are not asked for: a text card, a monogram, a drawn face', () => {
    assert.ok(!/images\/projects|images\/clients|terubot\.png/.test(html));
    assert.equal((html.match(/class="pj[ "]/g) || []).length, 6);
    assert.ok(!/class="pm"/.test(html), 'a project picture frame without a picture');
    assert.equal((html.match(/<b aria-hidden="true">[A-Z]{1,2}<\/b>/g) || []).length, 21, 'seven monograms, three copies for the loop');
    assert.match(html, /class="bot__face"/);
  });

  test('a project photo that IS in the index is used: the frame, srcset and alt appear, nothing else changes', () => {
    const temp = copyLanding();
    try {
      const idxFile = path.join(temp.root, 'site/landing/img/index.json');
      const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
      idx['project-trends'] = JSON.parse(JSON.stringify(idx['journal-fitout-14-weeks']));
      fs.writeFileSync(idxFile, JSON.stringify(idx));
      const h = text(build(temp.root));
      assert.equal((h.match(/class="pm"/g) || []).length, 1);
      assert.match(h, /class="pj has-img"[^>]*data-cats="Retail">/);
    } finally {
      temp.cleanup();
    }
  });

  test('a picture that the index names but the folder lacks stops the build with a message that says what to run', () => {
    const temp = copyLanding();
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(temp.root, 'site/landing/img/index.json'), 'utf8'));
      fs.rmSync(path.join(temp.root, 'site/landing/img', idx['hero-01'].variants[0].file));
      assert.throws(() => build(temp.root), (e) => e instanceof LandingError && /optimize-landing/.test(e.message));
    } finally {
      temp.cleanup();
    }
  });

  test('a project folder without site/landing/ builds nothing (the site keeps its own landing page)', () => {
    const temp = makeTempRoot();
    try {
      assert.equal(buildLanding({ root: temp.root }), null);
    } finally {
      temp.cleanup();
    }
  });

  test('the committed picture variants are current: every file is there, named for its own hash, nothing extra', () => {
    assert.deepEqual(checkPictures(), []);
  });

  test('the words: six disciplines, six shades, four directions, seven questions, three notes, four slides', () => {
    assert.equal((html.match(/<details class="d"/g) || []).length, 6);
    assert.equal((html.match(/class="shade"/g) || []).length, 6);
    assert.equal((html.match(/class="th"/g) || []).length, 4);
    assert.equal((html.match(/<details class="q"/g) || []).length, 7);
    assert.equal((html.match(/class="jc"/g) || []).length, 3);
    assert.equal((html.match(/class="pk"/g) || []).length, 4);
    assert.equal((html.match(/role="group" aria-roledescription="slide"/g) || []).length, 4, 'one in the page, three in the template');
  });
});

describe('minifiers', () => {
  test('minifyCss drops comments (a quote inside one is no string), keeps strings and calc() spaces, and the semicolon before }', () => {
    const out = minifyCss('/* a "quote\' in a comment */\n.a  >  .b { margin: 0 auto ; width: calc(100% - 4px) ; font-family: "Geist  Mono" , serif ; }\n');
    assert.equal(out, '.a>.b{margin:0 auto;width:calc(100% - 4px);font-family:"Geist  Mono",serif}');
  });
  test('trimJs removes full-line comments and indentation and nothing else', () => {
    assert.equal(trimJs("  // note\n  var a = 'x // not a comment';\n    b();\n"), "var a = 'x // not a comment';\nb();");
  });
});

/** A temp project that holds the real site/landing (and the snippets it uses): changes to it never touch the real one. */
function copyLanding() {
  const temp = makeTempRoot();
  for (const rel of ['site/landing', 'site/patches/snippets']) fs.cpSync(path.join(PROJECT_ROOT, rel), path.join(temp.root, rel), { recursive: true });
  return temp;
}

async function startApp({ landing = true, env = '' } = {}) {
  const temp = landing ? copyLanding() : makeTempRoot();
  fs.writeFileSync(temp.envPath, env);
  const log = collectLog();
  const capture = captureProviders();
  const started = await startServer({ root: temp.root, envPath: temp.envPath, environ: {}, log, port: 0, host: '127.0.0.1', auth: { providers: capture.providers, secret: SECRET } });
  const call = (p, options = {}) => request(started.port, { path: p, ...options });
  return {
    ...started,
    ...temp,
    log,
    get: (p, headers) => call(p, { headers }),
    post: (p, body, headers) => call(p, { method: 'POST', body, headers }),
    call,
    async stop() {
      await started.close();
      temp.cleanup();
    },
  };
}

describe('GET /', () => {
  let app;
  let page;
  before(async () => {
    app = await startApp();
    page = build(app.root);
  });
  after(() => app.stop());

  test('the new landing page, with brotli, a strong ETag per body, no-cache and Vary', async () => {
    const r = await app.get('/', { 'Accept-Encoding': 'br' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(r.headers['content-encoding'], 'br');
    assert.equal(r.headers['cache-control'], 'no-cache');
    assert.equal(r.headers.etag, `"${page.etag}-br"`);
    assert.match(r.headers.vary, /Accept-Encoding/);
    assert.equal(Number(r.headers['content-length']), r.buffer.length);
    const html = zlib.brotliDecompressSync(r.buffer).toString('utf8');
    assert.ok(html.includes('one accountable team.'));
    assert.ok(r.buffer.length < page.html.length / 4);
    assert.ok(app.log.lines.some((l) => /landing\s+built/.test(l)), app.log.lines.join('\n'));
  });

  test('gzip and plain bodies carry the same page and their own validators', async () => {
    const gz = await app.get('/', { 'Accept-Encoding': 'gzip, deflate' });
    const plain = await app.get('/');
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(gz.headers.etag, `"${page.etag}-gz"`);
    assert.equal(plain.headers.etag, `"${page.etag}"`);
    assert.equal(zlib.gunzipSync(gz.buffer).toString('utf8'), plain.text);
    assert.equal(plain.text, page.html.toString('utf8'));
  });

  test('a matching If-None-Match gets 304 with no body; a different one gets the page', async () => {
    const first = await app.get('/', { 'Accept-Encoding': 'br' });
    const again = await app.get('/', { 'Accept-Encoding': 'br', 'If-None-Match': first.headers.etag });
    assert.equal(again.status, 304);
    assert.equal(again.buffer.length, 0);
    const other = await app.get('/', { 'Accept-Encoding': 'br', 'If-None-Match': '"nope"' });
    assert.equal(other.status, 200);
    const wrongCoding = await app.get('/', { 'Accept-Encoding': 'gzip', 'If-None-Match': first.headers.etag });
    assert.equal(wrongCoding.status, 200, 'the tag of the brotli body does not validate the gzip body');
  });

  test('HEAD answers with the headers of GET and no body', async () => {
    const r = await app.call('/', { method: 'HEAD', headers: { 'Accept-Encoding': 'br' } });
    assert.equal(r.status, 200);
    assert.equal(r.buffer.length, 0);
    assert.equal(r.headers['content-encoding'], 'br');
  });

  test('/index.html goes to /, with the query kept', async () => {
    const r = await app.get('/index.html?utm=x');
    assert.equal(r.status, 301);
    assert.equal(r.headers.location, '/?utm=x');
  });

  test('every file the page asks for is served: fonts and pictures for a year and immutable, the script in the coding asked for', async () => {
    const names = [...page.html.toString('utf8').matchAll(/\/lp\/([A-Za-z0-9._-]+)/g)].map((m) => m[1]);
    const seen = new Map();
    for (const name of new Set(names)) {
      const r = await app.get(`/lp/${name}`, { 'Accept-Encoding': 'br' });
      assert.equal(r.status, 200, name);
      assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable', name);
      assert.match(name, /-[0-9a-f]{12}\.(webp|woff2|js)$/, 'every name carries a hash');
      seen.set(path.extname(name), r);
      if (name.endsWith('.js')) assert.equal(r.headers['content-encoding'], 'br');
      else assert.equal(r.headers['content-encoding'], undefined, 'pictures and fonts are not compressed twice');
    }
    assert.equal(seen.get('.woff2').headers['content-type'], 'font/woff2');
    assert.equal(seen.get('.webp').headers['content-type'], 'image/webp');
    assert.match(seen.get('.js').headers['content-type'], /^text\/javascript/);
    assert.match(seen.get('.js').headers.vary, /Accept-Encoding/);
  });

  test('the script served in brotli is the one built, and its gzip and plain forms decode to the same text', async () => {
    const name = [...page.assets.keys()].find((n) => n.startsWith('landing-'));
    const br = zlib.brotliDecompressSync((await app.get(`/lp/${name}`, { 'Accept-Encoding': 'br' })).buffer);
    const gz = zlib.gunzipSync((await app.get(`/lp/${name}`, { 'Accept-Encoding': 'gzip' })).buffer);
    const plain = (await app.get(`/lp/${name}`)).buffer;
    assert.ok(br.equals(plain) && gz.equals(plain));
    assert.ok(plain.toString('utf8').includes('/api/enquiry'));
    assert.ok(!plain.toString('utf8').includes('wa.me'), 'the script does not open WhatsApp');
  });

  test('an unknown name, a path trick and a name from another folder are plain 404s (never the Coming soon page)', async () => {
    for (const p of ['/lp/nothing.webp', '/lp/..%2f..%2fapp.js', '/lp/%2e%2e%2fsite.json', '/lp/index.json', '/lp/', '/lp/landing.css']) {
      const r = await app.get(p);
      assert.equal(r.status, 404, p);
      assert.ok(!/coming soon/i.test(r.text), p);
    }
  });

  test('the later script (analytics and the studio warm-up) is one file, and the page tells landing.js where it is', async () => {
    const h = page.html.toString('utf8');
    const later = h.match(/data-later="(\/lp\/later-[0-9a-f]{12}\.js)"/)[1];
    const body = (await app.get(later)).text;
    assert.ok(body.includes('/api/studio/warmup') && body.includes('/api/analytics'));
    assert.ok(/<script src="\/lp\/landing-[0-9a-f]{12}\.js" defer data-later=/.test(h));
  });

  test('LANDING=classic hands "/" back to the site map\'s own page when .env says so (no restart), and removing it brings the new one back', async () => {
    assert.ok((await app.get('/')).text.includes('one accountable team.'));
    fs.writeFileSync(app.envPath, 'LANDING=classic\n');
    const classic = await app.get('/');
    assert.equal(classic.status, 200);
    assert.ok(!classic.text.includes('one accountable team.'));
    assert.match(classic.text, /<title>home<\/title>/, 'the temp project\'s page for the site map\'s "home"');
    assert.equal((await app.get('/index.html')).status, 301, 'the site map\'s alias keeps working');
    assert.equal((await app.get('/lp/' + [...page.assets.keys()][0])).status, 200, 'the files stay, so a cached new page keeps working');
    fs.writeFileSync(app.envPath, '');
    assert.ok((await app.get('/')).text.includes('one accountable team.'));
  });

  test('the enquiry the page sends is accepted: source "landing", the service and details in the message, the honeypot empty', async () => {
    const body = { source: 'landing', name: 'Asha Rao', phone: '+91 9876543210', email: 'asha@example.com', city: 'Whitefield, Bengaluru', message: 'Service: Commercial Interiors\nBudget: ₹25–50 lakh\n\nDetails: Four-storey office.', website: '' };
    const r = await app.post('/api/enquiry', body);
    assert.equal(r.status, 201, r.text);
    assert.match(r.json().reference, /^TR-[A-Z0-9]{6}$/);
    const bot = await app.post('/api/enquiry', { ...body, website: 'http://spam.example' });
    assert.equal(bot.status, 201, 'a filled honeypot gets the same thank-you');
  });
});

describe('without site/landing', () => {
  let app;
  before(async () => {
    app = await startApp({ landing: false });
  });
  after(() => app.stop());
  test('"/" is the site map\'s page and /lp/ is nothing', async () => {
    assert.match((await app.get('/')).text, /<title>home<\/title>/);
    assert.equal((await app.get('/lp/anything.webp')).status, 404);
    assert.ok(!app.log.lines.some((l) => /landing/.test(l)), app.log.lines.join('\n'));
  });
});

describe('a landing that cannot be built', () => {
  let app;
  before(async () => {
    // a page with a marker nobody makes: the build failure is an error line and "/" is still answered by the site map
    const t = makeTempRoot();
    for (const rel of ['site/landing', 'site/patches/snippets']) fs.cpSync(path.join(PROJECT_ROOT, rel), path.join(t.root, rel), { recursive: true });
    fs.writeFileSync(path.join(t.root, 'site/landing/page.html'), '<p>{{noSuchMarker}}</p>');
    fs.writeFileSync(t.envPath, '');
    const log = collectLog();
    const capture = captureProviders();
    const started = await startServer({ root: t.root, envPath: t.envPath, environ: {}, log, port: 0, host: '127.0.0.1', auth: { providers: capture.providers, secret: SECRET } });
    app = { ...started, t, log, get: (p) => request(started.port, { path: p }) };
  });
  after(async () => {
    await app.close();
    app.t.cleanup();
  });
  test('the error is logged with the marker\'s name, and the old landing page keeps answering "/"', async () => {
    assert.ok(app.log.lines.some((l) => l.startsWith('error') && /noSuchMarker/.test(l)), app.log.lines.join('\n'));
    assert.match((await app.get('/')).text, /<title>home<\/title>/);
  });
});
