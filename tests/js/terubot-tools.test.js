import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { catalogueBridge } from '../../server/lib/terubot/catalogue.js';
import { CatalogueError } from '../../server/catalogue/errors.js';
import { createLimits, MAX_IN_FLIGHT } from '../../server/lib/terubot/limits.js';
import { describe as describeSettings, loadSettings, TERUBOT_DEFAULTS } from '../../server/config/settings.js';
import { startBotApp } from '../helpers/terubotApp.js';

// The tools, what they hand the browser, who is asked, and how often. Google is never called: the model is a script.

const BRONZE = 'superbond-fr-metallic--acp-bronze-4-1220x2440';
const names = (r) => r.json().actions.map((a) => a.type);
/** One round of tool calls, then a closing answer. */
const turn = (calls, text = 'Done.') => [{ calls }, { text }];

describe('data tools', () => {
  test('search_materials: filters, a budget, bad values explained to the model', async () => {
    const app = await startBotApp({
      script: [
        { calls: [{ name: 'search_materials', args: { category: 'stone', max_price: 2300, sort: 'price_asc', limit: 3 } }, { name: 'search_materials', args: { category: 'wood' } }, { name: 'search_materials', args: { query: 'zzzzqqq' } }] },
        { text: 'ok' },
      ],
    });
    try {
      const r = await app.say('stone under 2300');
      const results = app.fake.requests[1].contents.at(-1).parts.map((p) => p.functionResponse.response);
      assert.ok(results[0].results.length >= 1 && results[0].results.length <= 3);
      assert.ok(results[0].results.every((x) => x.category === 'Natural stone' && /^₹/.test(x.showing.price)));
      assert.match(results[0].note, /not a quote/);
      assert.match(results[1].error, /category/);
      assert.equal(results[2].results.length, 0);
      assert.ok(results[2].categories.length >= 5, 'an empty search tells the model what it can browse by');
      assert.equal(r.json().cards.length, results[0].results.length, 'a card for each material the tool returned, and for nothing else');
    } finally {
      await app.stop();
    }
  });

  test('get_material, estimate_quantity, site_guide', async () => {
    const app = await startBotApp({
      script: [
        { calls: [{ name: 'get_material', args: { id: 'kota-stone' } }, { name: 'get_material', args: { id: 'nope' } }, { name: 'estimate_quantity', args: { id: BRONZE, area_sqft: 480 } }, { name: 'estimate_quantity', args: { id: BRONZE, area_sqft: -5 } }, { name: 'estimate_quantity', args: { id: 'terracotta-baguette', area_sqft: 50 } }, { name: 'site_guide' }, { name: 'site_guide', args: { route: '/nowhere' } }] },
        { text: 'ok' },
      ],
    });
    try {
      const r = await app.say('tell me');
      const [kota, none, est, badArea, piece, guide, noPage] = app.fake.requests[1].contents.at(-1).parts.map((p) => p.functionResponse.response);
      assert.equal(kota.productId, 'kota-stone');
      assert.ok(kota.variants.length >= 2 && kota.variants.every((v) => v.id && v.price && v.availability));
      assert.match(none.error, /No material/);
      assert.equal(est.units, 17);
      assert.match(est.note, /not a quote/);
      assert.match(badArea.error, /area_sqft/);
      assert.match(piece.error, /not sold by area/);
      assert.ok(guide.pages.some((p) => p.route === '/my-project' && /DEMO/.test(p.note)));
      assert.ok(guide.pages.every((p) => !/admin|overview/i.test(p.route)));
      assert.match(noPage.error, /No such page/);
      assert.deepEqual(r.json().cards.map((c) => c.pid), ['kota-stone']);
    } finally {
      await app.stop();
    }
  });

  test('the catalogue is off here: its tool is not offered, the prompt says so plainly, and a call to it is refused', async () => {
    const app = await startBotApp({ script: turn([{ name: 'catalogue_search', args: { text: 'oak' } }]) });
    try {
      await app.say('search the catalogue for oak');
      const first = app.fake.requests[0];
      assert.ok(!first.tools.some((t) => t.name === 'catalogue_search'));
      assert.match(first.system, /catalogue search is NOT switched on/);
      assert.match(app.fake.lastToolResults().catalogue_search.error, /no tool called catalogue_search/);
    } finally {
      await app.stop();
    }
  });

  test('every tool is declared in a form Gemini accepts: unique names, OBJECT parameters, enums of strings', async () => {
    const app = await startBotApp({ script: [{ text: 'ok' }] });
    try {
      const me = await app.signIn();
      await app.say('hi', {}, { as: me });
      const tools = app.fake.requests[0].tools;
      const toolNames = tools.map((t) => t.name);
      assert.equal(new Set(toolNames).size, toolNames.length);
      for (const n of ['search_materials', 'get_material', 'estimate_quantity', 'site_guide', 'navigate', 'open_studio', 'cart_add', 'saved_add', 'saved_remove', 'prefill_enquiry', 'get_account_summary']) assert.ok(toolNames.includes(n), n);
      for (const t of tools) {
        assert.equal(t.parameters.type, 'OBJECT');
        assert.ok(t.description.length > 20);
        for (const spec of Object.values(t.parameters.properties ?? {})) if (spec.enum) assert.ok(spec.enum.every((e) => typeof e === 'string'));
      }
    } finally {
      await app.stop();
    }
  });
});

describe('action tools: a hostile model gets nowhere', () => {
  test('good actions come back exactly as the contract says', async () => {
    const app = await startBotApp({
      script: turn([
        { name: 'cart_add', args: { id: BRONZE, qty: 2 } },
        { name: 'saved_add', args: { id: 'kota-stone' } },
        { name: 'saved_remove', args: { id: 'lime-plaster' } },
        { name: 'prefill_enquiry', args: { type: 'Office interior', name: 'Asha Rao', timeline: '3-6 months', message: 'A clinic reception.' } },
        { name: 'navigate', args: { to: '/materials', material_id: BRONZE } },
      ]),
    });
    try {
      const r = await app.say('Hi, I am Asha Rao. Add two of the bronze ones, save the kota stone, and fill the form for me.');
      assert.equal(r.status, 200);
      const { actions } = r.json();
      assert.deepEqual(actions[0], { type: 'cart_add', id: BRONZE, qty: 2 });
      assert.deepEqual(actions[1], { type: 'saved_add', id: actions[1].id, pid: 'kota-stone' });
      assert.equal(actions[2].type, 'saved_remove');
      assert.deepEqual(actions[3], { type: 'prefill_enquiry', fields: { type: 'Office interior', name: 'Asha Rao', company: '', phone: '', email: '', city: '', area: '', timeline: '3–6 months', message: 'A clinic reception.' } });
      assert.deepEqual(actions.at(-1), { type: 'navigate', to: `/materials#/p/superbond-fr-metallic?v=${BRONZE}` }, 'a move to another page goes last');
      const answers = app.fake.requests[1].contents.at(-1).parts.map((p) => p.functionResponse.response);
      assert.ok(answers.every((a) => a.ok === true && /after your reply|queued/.test(JSON.stringify(a))), 'the model is told it is queued, not done');
    } finally {
      await app.stop();
    }
  });

  test('javascript:, other sites, other paths, huge quantities, unknown ids, actions that do not exist: nothing reaches the browser', async () => {
    const app = await startBotApp({
      script: [
        {
          calls: [
            { name: 'navigate', args: { to: 'javascript:alert(1)' } },
            { name: 'navigate', args: { to: 'https://evil.example/login' } },
            { name: 'navigate', args: { to: '/api/admin/settings' } },
            { name: 'navigate', args: { to: '/materials?q=<script>' } },
            { name: 'cart_add', args: { id: BRONZE, qty: 10000 } },
            { name: 'cart_add', args: { id: 'not-a-product', qty: 1 } },
            { name: 'delete_account', args: {} },
            { name: 'pay', args: { amount: 1 } },
          ],
        },
        {
          calls: [
            { name: 'navigate', args: { to: '/finder', material_id: BRONZE } },
            { name: 'cart_add', args: { id: BRONZE, qty: 1.5 } },
            { name: 'saved_add', args: { id: '../../etc/passwd' } },
            { name: 'prefill_enquiry', args: { type: 'Anything goes', timeline: 'Yesterday' } },
          ],
        },
        { text: 'ok' },
      ],
    });
    try {
      const r = await app.say('do everything');
      assert.equal(r.status, 200);
      assert.deepEqual(r.json().actions, []);
      assert.deepEqual(r.json().cards, []);
      const one = app.fake.requests[1].contents.at(-1).parts.map((p) => p.functionResponse.response);
      const two = app.fake.requests[2].contents.at(-1).parts.map((p) => p.functionResponse.response);
      assert.equal(one.length + two.length, 12);
      assert.ok(one.slice(0, 6).every((a) => a.ok === false), JSON.stringify(one));
      assert.match(one[4].error, /qty/);
      assert.match(one[6].error, /no tool called/);
      assert.match(one[7].error, /no tool called/);
      assert.ok(two.every((a) => a.ok === false), JSON.stringify(two));
    } finally {
      await app.stop();
    }
  });

  test('one move per reply, five cart additions at most, and a model that calls far too much is cut off', async () => {
    const ids = ['kota-stone', 'jaisalmer-limestone', 'gwalior-sandstone', 'sadarahalli-granite', 'lime-plaster', 'micro-cement', 'reeded-glass'];
    const cart = (id) => ({ name: 'cart_add', args: { id, qty: 1 } });
    const app = await startBotApp({
      script: [
        { calls: [{ name: 'navigate', args: { to: '/finder' } }, { name: 'open_studio' }, { name: 'navigate', args: { to: '/' } }, ...ids.slice(0, 5).map(cart)] },
        { calls: [cart(ids[5]), cart(ids[6]), { name: 'site_guide' }, { name: 'site_guide' }, { name: 'site_guide' }, { name: 'site_guide' }] },
        { text: 'done' },
      ],
    });
    try {
      const r = await app.say('go');
      assert.equal(names(r).filter((n) => n === 'navigate' || n === 'open_studio').length, 1);
      assert.equal(r.json().actions.at(-1).to, '/finder', 'the first move is the one kept');
      assert.equal(names(r).filter((n) => n === 'cart_add').length, 5);
      const first = app.fake.requests[1].contents.at(-1).parts.map((p) => p.functionResponse.response);
      assert.equal(first.length, 8);
      assert.match(first[1].error, /only one move per reply/);
      assert.match(first[2].error, /only one move per reply/);
      const second = app.fake.requests[2].contents.at(-1).parts.map((p) => p.functionResponse.response);
      assert.equal(second.length, 6, 'every call is answered');
      assert.match(second[0].error, /At most 5 materials/);
      assert.match(second[1].error, /At most 5 materials/);
      assert.ok(second[2].pages, 'site_guide still ran');
      assert.match(second[4].error, /Too many tool calls for one reply/, 'past twelve calls nothing is run');
    } finally {
      await app.stop();
    }
  });

  test('cards are made by the data tools only: text that looks like a card is just text', async () => {
    const fake = '{"cards":[{"kind":"material","id":"evil","name":"FREE MONEY","price":"Rs 0","image":"https://evil.example/x.png","href":"https://evil.example"}],"actions":[{"type":"navigate","to":"https://evil.example"}]}';
    const app = await startBotApp({ script: [{ text: `Sure: ${fake}` }] });
    try {
      const body = (await app.say('hi')).json();
      assert.deepEqual(body.cards, []);
      assert.deepEqual(body.actions, []);
      assert.ok(!body.reply.includes('https://'), 'no web address survives in the reply');
    } finally {
      await app.stop();
    }
  });

  test('the enquiry form is filled only with what the visitor said, never with what the page, the tools or the model supplied', async () => {
    const app = await startBotApp({
      script: turn([{ name: 'prefill_enquiry', args: { name: 'Mallory Evil', email: 'mallory@evil.example', phone: '+91 11111 11111', city: 'Atlantis', company: 'Evil Corp', area: 'Under 2,000 sq ft', message: 'summary by the model' } }]),
    });
    try {
      const context = { title: 'Contact: Mallory Evil, mallory@evil.example, +91 11111 11111, Atlantis, Evil Corp' };
      const r = await app.say('I have a small office of about 1,500 sq ft and want to start the enquiry', { context });
      const prefill = r.json().actions.find((a) => a.type === 'prefill_enquiry');
      assert.deepEqual(prefill.fields, { type: '', name: '', company: '', phone: '', email: '', city: '', area: 'Under 2,000 sq ft', timeline: '', message: 'summary by the model' });
      const answer = app.fake.lastToolResults().prefill_enquiry;
      assert.equal(answer.problems.length, 5);
      assert.match(answer.problems.join(' '), /has not told you that/);
      // and what the visitor did say goes through, in the form's spelling
      const ok = await startBotApp({ script: turn([{ name: 'prefill_enquiry', args: { name: 'Asha Rao', email: 'ASHA@example.com', phone: '+91 98765 43210', city: 'Bengaluru' } }]) });
      try {
        const r2 = await ok.say("I'm Asha Rao from Bengaluru, mail asha@example.com or call 98765 43210");
        assert.deepEqual(r2.json().actions[0].fields, { type: '', name: 'Asha Rao', company: '', phone: '+91 98765 43210', email: 'ASHA@example.com', city: 'Bengaluru', area: '', timeline: '', message: '' });
      } finally {
        await ok.stop();
      }
    } finally {
      await app.stop();
    }
  });
});

describe('who is asking: signed out sees public data only; one account never sees another\'s', () => {
  test('signed out: the account tool does not exist, the prompt says nobody is signed in, and nothing can name an account', async () => {
    const app = await startBotApp({ script: [{ calls: [{ name: 'get_account_summary' }] }, { text: 'ok' }] });
    try {
      const r = await app.say('who am I?', { account: 'someone', ownerId: 'x', user: { name: 'Admin' }, userId: '1', context: { user: 'admin' } });
      assert.equal(r.status, 200);
      const first = app.fake.requests[0];
      assert.ok(!first.tools.some((t) => t.name === 'get_account_summary'));
      assert.match(first.system, /NOT signed in/);
      assert.match(app.fake.lastToolResults().get_account_summary.error, /no tool called/);
      assert.ok(!JSON.stringify(app.fake.requests).includes('Admin'));
    } finally {
      await app.stop();
    }
  });

  test('signed in: first name only (no e-mail, no phone, no firm); each account gets its own; the studio rooms are counted for that owner alone', async () => {
    const seen = [];
    const app = await startBotApp({
      script: [(req) => (req.contents.at(-1).parts.some((p) => p.functionResponse) ? { text: 'Hello.' } : { calls: [{ name: 'get_account_summary' }] })],
      terubot: { rooms: async (owner) => { seen.push(owner); return owner === seen[0] ? 3 : 7; } },
    });
    try {
      const asha = await app.signIn({ email: 'asha.private@example.com', name: 'Asha Rao' });
      const ravi = await app.signIn({ email: 'ravi.private@example.com', name: 'Ravi Kumar' });
      const a = await app.say('hello', {}, { as: asha });
      const summaryA = app.fake.lastToolResults().get_account_summary;
      assert.deepEqual(summaryA, { signedIn: true, firstName: 'Asha', savedStudioRooms: 3 });
      assert.match(app.fake.requests.at(-2).system, /The visitor is signed in/);
      await app.say('hello', {}, { as: ravi });
      const summaryB = app.fake.lastToolResults().get_account_summary;
      assert.deepEqual(summaryB, { signedIn: true, firstName: 'Ravi', savedStudioRooms: 7 });
      assert.equal(seen.length, 2);
      assert.notEqual(seen[0], seen[1], 'each account\'s own owner id');
      const everything = JSON.stringify(app.fake.requests);
      for (const secret of ['private@example.com', asha.phone, ravi.phone, 'Test Firm', 'Kumar', 'Rao']) assert.ok(!everything.includes(secret), `${secret} never reaches the model`);
      assert.equal(a.status, 200);
      // a cookie of nobody is a signed-out visitor
      const forged = await app.say('hello', {}, { as: { headers: { Cookie: 'terucon_session=forged-token', 'X-Forwarded-For': '10.1.2.3' } } });
      assert.equal(forged.status, 200);
      assert.ok(!app.fake.requests.at(-1).tools.some((t) => t.name === 'get_account_summary'));
    } finally {
      await app.stop();
    }
  });

  test('a studio count that fails is left out, never an error', async () => {
    const app = await startBotApp({ script: [{ calls: [{ name: 'get_account_summary' }] }, { text: 'ok' }], terubot: { rooms: async () => { throw new Error('mongo down'); } } });
    try {
      const me = await app.signIn({ name: 'Asha Rao' });
      assert.equal((await app.say('hi', {}, { as: me })).status, 200);
      assert.deepEqual(app.fake.lastToolResults().get_account_summary, { signedIn: true, firstName: 'Asha' });
    } finally {
      await app.stop();
    }
  });
});

describe('limits: 429 with retryAfterSec', () => {
  test('per account: the next one is refused, and another account is not affected', async () => {
    const app = await startBotApp({ script: [{ text: 'ok' }], env: 'TERUBOT_LIMIT_ACCOUNT=2\n' });
    try {
      const a = await app.signIn();
      const b = await app.signIn();
      assert.equal((await app.say('1', {}, { as: a })).status, 200);
      assert.equal((await app.say('2', {}, { as: a })).status, 200);
      const refused = await app.say('3', {}, { as: a });
      assert.equal(refused.status, 429);
      const body = refused.json();
      assert.deepEqual(Object.keys(body).sort(), ['error', 'retryAfterSec']);
      assert.ok(Number.isInteger(body.retryAfterSec) && body.retryAfterSec >= 1 && body.retryAfterSec <= 3600);
      assert.equal(refused.headers['retry-after'], String(body.retryAfterSec));
      assert.equal(app.fake.requests.length, 2, 'the refused one never reached the model');
      assert.equal((await app.say('1', {}, { as: b })).status, 200);
    } finally {
      await app.stop();
    }
  });

  test('visitors who are not signed in have a lower ceiling per address; another address is not affected', async () => {
    const app = await startBotApp({ script: [{ text: 'ok' }], env: 'TERUBOT_LIMIT_ANONYMOUS=2\nTERUBOT_LIMIT_ADDRESS=50\n' });
    try {
      const from = (ip) => ({ ip });
      assert.equal((await app.say('1', {}, from('10.5.5.5'))).status, 200);
      assert.equal((await app.say('2', {}, from('10.5.5.5'))).status, 200);
      assert.equal((await app.say('3', {}, from('10.5.5.5'))).status, 429);
      assert.equal((await app.say('1', {}, from('10.6.6.6'))).status, 200);
    } finally {
      await app.stop();
    }
  });

  test('one address shared by several accounts has its own ceiling', async () => {
    const app = await startBotApp({ script: [{ text: 'ok' }], env: 'TERUBOT_LIMIT_ADDRESS=3\nTERUBOT_LIMIT_ACCOUNT=50\n' });
    try {
      const people = [await app.signIn(), await app.signIn(), await app.signIn(), await app.signIn()];
      const sameAddress = people.map((p) => ({ headers: { ...p.headers, 'X-Forwarded-For': '10.8.8.8' } }));
      const results = [];
      for (const p of sameAddress) results.push((await app.say('hi', {}, { as: p })).status);
      assert.deepEqual(results, [200, 200, 200, 429]);
    } finally {
      await app.stop();
    }
  });

  test('refused messages are logged without who or what; AI-off answers use up nothing', async () => {
    const app = await startBotApp({ script: [{ text: 'ok' }], env: 'TERUBOT_LIMIT_ANONYMOUS=1\n' });
    try {
      assert.equal((await app.say('1', {}, { ip: '10.9.9.9' })).status, 200);
      assert.equal((await app.say('SECRET-TEXT', {}, { ip: '10.9.9.9' })).status, 429);
      assert.ok(app.log.lines.some((l) => /rate limit: anon/.test(l)));
      assert.ok(!app.log.lines.join('\n').includes('SECRET-TEXT'));
    } finally {
      await app.stop();
    }
    const off = await startBotApp({ script: [{ text: 'ok' }], env: 'TERUBOT=off\nTERUBOT_LIMIT_ANONYMOUS=1\n' });
    try {
      for (let i = 0; i < 4; i += 1) assert.equal((await off.say('hi', {}, { ip: '10.9.9.9' })).json().aiOn, false);
      off.writeEnv('TERUBOT_LIMIT_ANONYMOUS=1\n');
      assert.equal((await off.say('hi', {}, { ip: '10.9.9.9' })).status, 200, 'the off answers did not count');
    } finally {
      await off.stop();
    }
  });

  test('the number of chats in flight is capped', () => {
    const limits = createLimits({ limits: () => ({ limitAccount: 5, limitAddress: 5, limitAnonymous: 5 }) });
    try {
      const held = Array.from({ length: MAX_IN_FLIGHT }, () => limits.enter());
      assert.ok(held.every(Boolean));
      assert.equal(limits.enter(), null);
      held[0]();
      held[0]();
      assert.equal(limits.inFlight(), MAX_IN_FLIGHT - 1, 'giving a place back twice counts once');
      assert.ok(limits.enter());
    } finally {
      limits.close();
    }
  });

  test('the window slides: a message counts for an hour', () => {
    let now = 1_000_000;
    const limits = createLimits({ limits: () => ({ limitAccount: 1, limitAddress: 9, limitAnonymous: 9 }), now: () => now });
    try {
      assert.equal(limits.take({ account: 'a', address: 'x' }).ok, true);
      const no = limits.take({ account: 'a', address: 'x' });
      assert.equal(no.ok, false);
      assert.equal(no.bucket, 'acct');
      assert.equal(no.retryAfterSec, 3600);
      now += 3600_001;
      assert.equal(limits.take({ account: 'a', address: 'x' }).ok, true);
    } finally {
      limits.close();
    }
  });
});

describe('the catalogue bridge', () => {
  const asker = { account: 'owner-1', address: '1.2.3.4' };
  const service = (over = {}) => ({
    status: async () => ({ enabled: true, ready: true }),
    prepare: async () => ({ id: 'cat', release: 'rel-20260101000000-abcdef' }),
    check: () => ({ ok: true }),
    tryAcquire: () => () => {},
    record() {},
    searchText: async () => ({ catalogue: 'cat', items: [{ title: 'Oak', category: 'wood', finish: 'matte', productId: 'OK-1', source: { name: 'cat.pdf' }, image: { fullUrl: 'https://signed.example/x' }, scores: { final: 0.9 } }] }),
    ...over,
  });

  test('off or not allowed: not offered', async () => {
    assert.deepEqual(await catalogueBridge({ catalogue: null, asker, allowed: true }), { on: false });
    assert.deepEqual(await catalogueBridge({ catalogue: { service: service() }, asker, allowed: false }), { on: false });
    assert.deepEqual(await catalogueBridge({ catalogue: { service: service({ status: async () => ({ enabled: false, ready: false }) }) }, asker, allowed: true }), { on: false });
    assert.deepEqual(await catalogueBridge({ catalogue: { service: service({ status: async () => ({ enabled: true, ready: false }) }) }, asker, allowed: true }), { on: false });
    assert.deepEqual(await catalogueBridge({ catalogue: { service: service({ status: async () => { throw new Error('db'); } }) }, asker, allowed: true }), { on: false });
  });

  test('on: a few plain fields come back, no picture addresses or scores; the catalogue\'s own limits apply', async () => {
    const bridge = await catalogueBridge({ catalogue: { service: service() }, asker, allowed: true });
    assert.equal(bridge.on, true);
    const out = await bridge.search('oak', 3);
    assert.deepEqual(out.items, [{ title: 'Oak', category: 'wood', finish: 'matte', productCode: 'OK-1', source: 'cat.pdf' }]);
    assert.ok(!JSON.stringify(out).includes('signed.example'));
    const limited = await (await catalogueBridge({ catalogue: { service: service({ check: () => ({ ok: false, error: new CatalogueError(429, 'rate-limit', 'x') }) }) }, asker, allowed: true })).search('oak', 3);
    assert.equal(limited.available, false);
    const broken = await (await catalogueBridge({ catalogue: { service: service({ searchText: async () => { throw new CatalogueError(503, 'not-ready', 'Not ready.'); } }) }, asker, allowed: true })).search('oak', 3);
    assert.deepEqual(broken, { available: false, reason: 'Not ready.' });
    const crashed = await (await catalogueBridge({ catalogue: { service: service({ searchText: async () => { throw new TypeError('secret detail'); } }) }, asker, allowed: true })).search('oak', 3);
    assert.ok(!JSON.stringify(crashed).includes('secret'));
  });
});

describe('settings', () => {
  const read = (environ) => loadSettings('/nonexistent/terucon.env', environ, '/tmp');

  test('the defaults, the clamps, and a bad model name is a warning not a crash', () => {
    assert.deepEqual(read({}).terubot, TERUBOT_DEFAULTS);
    assert.deepEqual(read({}).warnings, []);
    const t = read({ TERUBOT: 'off', TERUBOT_MODEL: 'gemini-x.1', TERUBOT_MAX_OUTPUT_TOKENS: '99999', TERUBOT_HISTORY_LIMIT: '0', TERUBOT_TOOL_ROUNDS: '50', TERUBOT_TIMEOUT_SECONDS: 'abc', TERUBOT_LIMIT_ACCOUNT: '5', TERUBOT_LIMIT_ADDRESS: '-3', TERUBOT_LIMIT_ANONYMOUS: '2.9' }).terubot;
    assert.deepEqual(t, { enabled: false, model: 'gemini-x.1', voice: 'Aoede', maxOutputTokens: 4096, historyLimit: 2, toolRounds: 6, timeoutMs: 30000, limitAccount: 5, limitAddress: 1, limitAnonymous: 2 });
    const bad = read({ TERUBOT_MODEL: 'x; rm -rf /' });
    assert.equal(bad.terubot.model, '');
    assert.equal(bad.warnings.length, 1);
    assert.ok(describeSettings(read({})).some((l) => /TeruBot/.test(l)));
    assert.ok(describeSettings(read({ TERUBOT: 'off' })).some((l) => /TeruBot.*off/.test(l)));
  });
});
