import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { pageCsp, inlineBlocks } from '../../server/lib/csp.js';
import { SiteMap } from '../../server/lib/siteMap.js';
import { PROJECT_ROOT } from '../helpers/tempRoot.js';
import { startTestApp } from '../helpers/app.js';

// "As soon as the visitor tries to move away from the landing page, show the sign-in page": every page but the landing page is for
// members, whatever way the address is written.

const site = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'site', 'site.json'), 'utf8'));
const members = Object.values(site.pages).filter((p) => p.access === 'signed-in');

describe('the gate in front of the pages', () => {
  let app;
  let member;
  before(async () => {
    app = await startTestApp();
    member = await app.signIn();
  });
  after(() => app.stop());

  test('the landing page is open; the shop, studio and project pages are for members; the account page too', async () => {
    assert.equal((await app.get('/')).status, 200);
    assert.deepEqual(members.map((p) => p.route).sort(), ['/design-studio', '/materials', '/my-project']);
    for (const route of [...members.map((p) => p.route), '/account']) {
      const r = await app.get(route);
      assert.equal(r.status, 302, route);
      assert.equal(r.headers.location, `/login?next=${encodeURIComponent(route)}`, route);
      assert.equal(r.headers['cache-control'], 'no-store', 'a redirect is never kept');
      assert.equal(r.text.includes('page '), false, 'none of the page came with it');
      assert.equal((await app.get(route, member.headers)).status, 200, `${route} for a member`);
    }
  });

  test('HEAD is gated like GET', async () => {
    assert.equal((await app.request('/materials', { method: 'HEAD' })).status, 302);
    assert.equal((await app.request('/materials', { method: 'HEAD', headers: member.headers })).status, 200);
  });

  test('every other way of writing the address ends at the gate, never at the page', async () => {
    const variants = [
      '/materi%61ls', '/%6Daterials', '/materials/', '/Materials', '/MATERIALS', '/materials%2f', '/materials?x=1', '/materials#top', '/materials.html',
      '/market_place_1.html', '/design-studio.html', '/studio', '/swatchroom', '/Studio', '/Terucon%20Swatchroom.html', '/my-project.html', '/Terucon%20Client%20Dashboard%20v3.html', '/MY-PROJECT',
      '/profile', '/account.html', '/Account', '/%61ccount', '/Design%20Studio.dc.html',
    ];
    for (const p of variants) {
      let r = await app.get(p);
      let hops = 0;
      while ([301, 302].includes(r.status) && hops < 5 && !r.headers.location.startsWith('/login')) {
        r = await app.get(r.headers.location);
        hops += 1;
      }
      assert.equal(r.status, 302, `${p} ended at ${r.status}`);
      assert.match(r.headers.location, /^\/login\?next=%2F(materials|design-studio|my-project|account)$/, p);
      assert.equal(r.text.includes('page '), false, `${p}: no page content`);
    }
  });

  test('the sign-in page is open, has its aliases, and its own strict policy', async () => {
    const login = await app.get('/login');
    assert.equal(login.status, 200);
    assert.equal(login.headers['cache-control'], 'no-cache');
    const csp = login.headers['content-security-policy'];
    assert.equal(csp, pageCsp(login.text, { google: true }), 'the policy is built from the page that was served');
    assert.match(csp, /^default-src 'none'/);
    assert.match(csp, /script-src 'self'.* https:\/\/accounts\.google\.com\/gsi\/client/);
    assert.match(csp, /frame-ancestors 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
    assert.equal(login.headers['referrer-policy'], 'strict-origin-when-cross-origin');
    assert.equal(login.headers['x-frame-options'], 'SAMEORIGIN');
    for (const alias of ['/signin', '/sign-in', '/signup', '/sign-up', '/register', '/login.html']) {
      const r = await app.get(alias);
      assert.equal(r.status, 301, alias);
      assert.equal(r.headers.location, '/login');
    }
    const account = await app.get('/account', member.headers);
    assert.equal(account.status, 200);
    assert.doesNotMatch(account.headers['content-security-policy'], /google/, 'the account page does not talk to Google');
    assert.equal(account.headers['cache-control'], 'private, no-cache');
    assert.equal(account.headers.vary, 'Cookie');
  });

  test('a page for members is never cached for somebody else', async () => {
    const r = await app.get('/materials', member.headers);
    assert.equal(r.headers['cache-control'], 'private, no-cache');
    assert.match(r.headers.vary, /Cookie/);
  });

  test('a member whose sign-up form is not finished is sent to finish it, not let in', async () => {
    const half = await app.signIn({ finish: false });
    const r = await app.get('/design-studio', half.headers);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/login?next=%2Fdesign-studio&step=profile');
    assert.equal((await app.get('/account', half.headers)).headers.location, '/login?next=%2Faccount&step=profile');
  });

  test('the project overview and the Coming soon page stay public (they are not the members\' pages)', async () => {
    assert.equal((await app.get('/project-overview')).status, 200);
    assert.equal((await app.get('/nothing-here-yet', { Accept: 'text/html' })).status, 404, 'an unknown address still gets the Coming soon page, with a 404 status');
  });
});

describe('with the gate switched off (development only) the pages are open and the server says so', () => {
  test('AUTH_REQUIRED=off', async () => {
    const app = await startTestApp({ environ: { AUTH_REQUIRED: 'off' } });
    try {
      for (const route of ['/materials', '/design-studio', '/my-project']) assert.equal((await app.get(route)).status, 200, route);
      assert.equal((await app.get('/api/health')).json().auth.gate, false);
      assert.equal(app.app.locals.terucon.auth.status().gate, false);
    } finally {
      await app.stop();
    }
  });
});

describe('the site map', () => {
  test('access is "public" unless a page says "signed-in", and anything else is refused', () => {
    const map = SiteMap.load(PROJECT_ROOT);
    assert.equal(map.pages.home.access, 'public');
    assert.equal(map.pages.materials.access, 'signed-in');
    assert.equal(map.docs.login.access, 'public');
    assert.equal(map.docs.account.access, 'signed-in');
    assert.equal(map.docs.login.csp, 'strict+google');
    assert.equal(map.docs.overview.access, 'public');
    const bad = (patch) => () => new SiteMap({ ...site, pages: { ...site.pages, home: { ...site.pages.home, ...patch } } }, PROJECT_ROOT);
    assert.throws(bad({ access: 'members' }), /access must be/);
    assert.throws(bad({ access: 5 }), /access must be/);
    const badDoc = () => new SiteMap({ ...site, docs: { ...site.docs, login: { ...site.docs.login, csp: 'loose' } } }, PROJECT_ROOT);
    assert.throws(badDoc, /csp must be/);
    const table = map.table('pages');
    assert.equal(table.get('/materials').access, 'signed-in');
    assert.equal(table.get('/materials').route, '/materials');
    assert.equal(table.get('/materials.html').redirect, '/materials', 'an alias leads to the route, where the gate is');
  });
});

describe('the policy of the hand-written pages', () => {
  test('inline script and style are named by hash; a page with an injected script would not match', () => {
    const html = '<style>a{}</style><script>var x=1</script><script src="/y.js"></script><script type="module">import 1</script>';
    const blocks = inlineBlocks(html);
    assert.deepEqual(blocks.scripts, ['var x=1', 'import 1']);
    assert.deepEqual(blocks.styles, ['a{}']);
    const csp = pageCsp(html);
    assert.equal(csp.includes('sha256-'), true);
    assert.equal(csp.split("'sha256-").length - 1, 3);
    assert.doesNotMatch(csp, /google/);
    assert.match(pageCsp(html, { google: true }), /https:\/\/accounts\.google\.com\/gsi\/client/);
    assert.notEqual(pageCsp(html), pageCsp(`${html}<script>evil()</script>`), 'the policy follows the page: an added script is a different hash');
  });

  test('the real pages: one inline script, one inline style, nothing that builds markup from data', () => {
    for (const name of ['login', 'account']) {
      const html = fs.readFileSync(path.join(PROJECT_ROOT, 'pages', `${name}.html`), 'utf8');
      const { scripts, styles } = inlineBlocks(html);
      assert.equal(scripts.length, 1, `${name}: one script`);
      assert.equal(styles.length, 1, `${name}: one style`);
      for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'setAttribute(\'style\'', 'javascript:', 'srcdoc']) {
        assert.equal(scripts[0].includes(banned), false, `${name}: ${banned}`);
      }
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${name}: no inline event handlers (the policy would block them, and they are an injection route)`);
      assert.doesNotMatch(html, /\sstyle\s*=/i, `${name}: no style attributes in the markup (the policy has no 'unsafe-inline')`);
      assert.doesNotMatch(html, /<script[^>]*\ssrc=/i, `${name}: no script is loaded from the markup (the sign-in page adds Google's itself, only when Google is switched on)`);
    }
  });
});
