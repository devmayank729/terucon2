import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRecord, CrmError, createCrmOutbox, createZohoClient, zohoAccountsUrl } from '../../server/auth/crm.js';
import { DEFAULTS, nest } from '../../server/auth/settings.js';
import { makeKit } from '../helpers/authKit.js';

// Sending a finished sign-up to Zoho CRM, against a pretend Zoho that records what it was asked and can misbehave.

const CONFIG = { dc: 'in', clientId: 'cid', clientSecret: 'secret-xyz', refreshToken: 'refresh-abc' };

function fakeZoho(kit) {
  const calls = [];
  const leads = new Map(); // id -> record
  const state = { tokens: 0, nextToken: null, tokenHttp: 200, apiDomain: 'https://www.zohoapis.in', script: [], rejectOnce: null, duringUpsert: null };
  let nextId = 1000;
  const reply = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? (typeof init.body === 'string' ? JSON.parse(init.body) : init.body) : null;
    calls.push({ method: init.method ?? 'GET', host: u.host, path: u.pathname, search: u.search, auth: init.headers?.Authorization, body });
    if (u.pathname === '/oauth/v2/token') {
      state.tokens += 1;
      if (state.nextToken === 'error') return reply(200, { error: 'invalid_code' });
      if (state.tokenHttp !== 200) return reply(state.tokenHttp, { error: 'server' });
      return reply(200, { access_token: `tok-${state.tokens}`, api_domain: state.apiDomain, token_type: 'Bearer', expires_in: 3600 });
    }
    const scripted = state.script.shift();
    if (scripted === 'network') throw Object.assign(new Error('socket hang up'), { name: 'FetchError' });
    if (typeof scripted === 'object' && scripted) return reply(scripted.status, scripted.body, scripted.headers);
    if (state.rejectOnce === init.headers?.Authorization) return reply(401, { code: 'INVALID_TOKEN' });
    if (u.pathname.endsWith('/upsert')) {
      await state.duringUpsert?.();
      const record = body.data[0];
      const dup = body.duplicate_check_fields?.[0];
      const existing = dup ? [...leads].find(([, r]) => r[dup] === record[dup]) : null;
      if (!record.Last_Name) return reply(400, { data: [{ code: 'MANDATORY_NOT_FOUND', status: 'error', details: { api_name: 'Last_Name' } }] });
      if (existing) {
        leads.set(existing[0], { ...existing[1], ...record });
        return reply(200, { data: [{ code: 'SUCCESS', status: 'success', action: 'update', details: { id: existing[0] } }] });
      }
      nextId += 1;
      leads.set(String(nextId), record);
      return reply(200, { data: [{ code: 'SUCCESS', status: 'success', action: 'insert', details: { id: String(nextId) } }] });
    }
    if (init.method === 'PUT') {
      const id = u.pathname.split('/').pop();
      if (!leads.has(id)) return reply(400, { data: [{ code: 'INVALID_DATA', status: 'error', details: { api_name: 'id' } }] });
      leads.set(id, { ...leads.get(id), ...body.data[0] });
      return reply(200, { data: [{ code: 'SUCCESS', status: 'success', action: 'update', details: { id } }] });
    }
    if (init.method === 'DELETE') {
      const id = u.searchParams.get('ids');
      leads.delete(id);
      return reply(200, { data: [{ code: 'SUCCESS', status: 'success', details: { id } }] });
    }
    return reply(404, {});
  };
  return { fetch, calls, leads, state };
}

const cfgOf = (over = {}) => nest({ ...DEFAULTS, ...over });

async function completeUser(kit, raw = 'priya@ab-constructions.co.in', extra = {}) {
  const { user } = await kit.signIn(raw);
  const saved = await kit.users.saveProfile(user, { name: 'Priya Sharma', firm: 'AB Constructions', phone: '9876543210', ...extra });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  return saved.user;
}

test('data centres and the address the secret is sent to', () => {
  assert.equal(zohoAccountsUrl({ dc: 'in' }), 'https://accounts.zoho.in');
  assert.equal(zohoAccountsUrl({ dc: 'COM' }), 'https://accounts.zoho.com');
  assert.equal(zohoAccountsUrl({ dc: 'eu' }), 'https://accounts.zoho.eu');
  assert.equal(zohoAccountsUrl({ dc: 'com.au' }), 'https://accounts.zoho.com.au');
  assert.equal(zohoAccountsUrl({ dc: 'ca' }), 'https://accounts.zohocloud.ca');
  assert.equal(zohoAccountsUrl({ dc: 'mars' }), null);
  assert.equal(zohoAccountsUrl({ dc: '' }), null);
  assert.equal(zohoAccountsUrl({ accountsUrl: 'https://accounts.zoho.sa' }), 'https://accounts.zoho.sa', 'a data centre the table does not know can be given in full');
  for (const evil of ['https://evil.example', 'https://accounts.zoho.in.evil.example', 'http://accounts.zoho.in', 'https://accounts.zoho.in/x', 'https://accounts.zoho.in@evil.example', 'https://zoho.in']) {
    assert.equal(zohoAccountsUrl({ accountsUrl: evil }), null, `the refresh token must never be sent to ${evil}`);
  }
});

test('the client: one token for many calls, refreshed together, kept for most of the hour', async () => {
  const kit = makeKit();
  const zoho = fakeZoho(kit);
  const client = createZohoClient(CONFIG, { fetch: zoho.fetch, now: kit.now });
  assert.equal(client.ready, true);
  await Promise.all([client.upsert('Leads', { Last_Name: 'A', Email: 'a@x.co' }, ['Email']), client.upsert('Leads', { Last_Name: 'B', Email: 'b@x.co' }, ['Email']), client.upsert('Leads', { Last_Name: 'C', Email: 'c@x.co' }, ['Email'])]);
  assert.equal(zoho.state.tokens, 1, 'three calls at once asked for one token');
  const token = zoho.calls.find((c) => c.path === '/oauth/v2/token');
  assert.equal(token.method, 'POST');
  assert.equal(token.host, 'accounts.zoho.in');
  assert.match(token.search, /grant_type=refresh_token/);
  assert.match(token.search, /refresh_token=refresh-abc/);
  for (const c of zoho.calls.filter((c) => c.path.includes('/crm/'))) {
    assert.equal(c.host, 'www.zohoapis.in', 'calls go to the api_domain Zoho named');
    assert.equal(c.auth, 'Zoho-oauthtoken tok-1');
  }
  kit.advance(40 * 60 * 1000);
  await client.upsert('Leads', { Last_Name: 'D', Email: 'd@x.co' }, ['Email']);
  assert.equal(zoho.state.tokens, 1, 'still the same token 40 minutes on');
  kit.advance(20 * 60 * 1000);
  await client.upsert('Leads', { Last_Name: 'E', Email: 'e@x.co' }, ['Email']);
  assert.equal(zoho.state.tokens, 2, 'renewed before the hour is up');
  const missing = createZohoClient({ ...CONFIG, refreshToken: '' }, { fetch: zoho.fetch });
  assert.equal(missing.ready, false);
  assert.match(missing.problem, /ZOHO_REFRESH_TOKEN/);
  kit.close();
});

test('the client: an expired token is replaced once; wrong credentials are not hammered; a stranger\'s API address is refused', async () => {
  const kit = makeKit();
  const zoho = fakeZoho(kit);
  const client = createZohoClient(CONFIG, { fetch: zoho.fetch, now: kit.now });
  await client.upsert('Leads', { Last_Name: 'A', Email: 'a@x.co' }, ['Email']);
  zoho.state.rejectOnce = 'Zoho-oauthtoken tok-1'; // Zoho revoked the token early
  const r = await client.upsert('Leads', { Last_Name: 'B', Email: 'b@x.co' }, ['Email']);
  assert.ok(r.id);
  assert.equal(zoho.state.tokens, 2, 'a 401 got a new token and the call was repeated once');

  const bad = createZohoClient(CONFIG, { fetch: zoho.fetch, now: kit.now });
  zoho.state.nextToken = 'error';
  const before = zoho.state.tokens;
  await assert.rejects(bad.upsert('Leads', { Last_Name: 'C' }), (e) => e instanceof CrmError && e.kind === 'auth' && !/secret-xyz|refresh-abc/.test(e.message));
  await assert.rejects(bad.upsert('Leads', { Last_Name: 'C' }), (e) => e.kind === 'auth');
  await assert.rejects(bad.upsert('Leads', { Last_Name: 'C' }), (e) => e.kind === 'auth');
  assert.equal(zoho.state.tokens, before + 1, 'three attempts in a row asked Zoho once');

  zoho.state.nextToken = null;
  zoho.state.apiDomain = 'https://evil.example';
  const tricked = createZohoClient(CONFIG, { fetch: zoho.fetch, now: kit.now });
  await assert.rejects(tricked.upsert('Leads', { Last_Name: 'D' }), (e) => e.kind === 'permanent');
  assert.ok(!zoho.calls.some((c) => c.host === 'evil.example'), 'nothing was sent to the address Zoho (or someone in between) named');
  kit.close();
});

test('the record: names split, Last_Name and Company always filled, fields renamed or left out as the admin chose', () => {
  const user = { name: 'Priya Kumari Sharma', email: 'priya@ab.co.in', emailKey: 'priya@ab.co.in', phone: '+919876543210', firm: 'AB Constructions' };
  const record = buildRecord(user, cfgOf());
  assert.deepEqual(record, {
    Last_Name: 'Sharma',
    First_Name: 'Priya Kumari',
    Email: 'priya@ab.co.in',
    Mobile: '+919876543210',
    Company: 'AB Constructions',
    Lead_Source: 'Terucon website sign-up',
    Description: 'Signed up on the Terucon website. E-mail verified: yes. Phone verified: no. Firm given by the person.',
  });
  const single = buildRecord({ name: 'Cher', email: 'c@x.co', individual: true }, cfgOf());
  assert.equal(single.Last_Name, 'Cher');
  assert.equal('First_Name' in single, false);
  assert.equal(single.Company, 'Individual', 'Zoho wants a company; someone with no firm gets the admin\'s text');
  assert.match(single.Description, /individual/);
  const renamed = buildRecord(user, cfgOf({ 'crm.field.phone': 'Phone', 'crm.field.company': 'Firm__c', 'crm.field.description': '', 'crm.field.firstName': '' }));
  assert.equal(renamed.Phone, '+919876543210');
  assert.equal(renamed.Firm__c, 'AB Constructions');
  assert.equal('Description' in renamed, false);
  assert.equal('First_Name' in renamed, false);
  const long = buildRecord({ name: `${'a'.repeat(200)}`, email: 'e@x.co', firm: 'F'.repeat(300) }, cfgOf());
  assert.ok(long.Last_Name.length <= 80 && long.Company.length <= 100);
});

test('a finished sign-up is queued, sent with an e-mail duplicate check, and its Zoho id remembered; a later change updates that record', async () => {
  const kit = makeKit();
  const zoho = fakeZoho(kit);
  const client = createZohoClient(CONFIG, { fetch: zoho.fetch, now: kit.now });
  const outbox = createCrmOutbox({ db: kit.db, settings: kit.settings, users: kit.users, events: kit.events, zoho: () => client, now: kit.now, log: kit.log });
  const user = await completeUser(kit);
  assert.equal(await outbox.enqueue(user._id), true);
  await outbox.tick();
  const upsert = zoho.calls.find((c) => c.path.endsWith('/upsert'));
  assert.equal(upsert.body.duplicate_check_fields[0], 'Email');
  assert.equal(upsert.body.data[0].Last_Name, 'Sharma');
  assert.equal(upsert.body.data[0].Company, 'AB Constructions');
  assert.equal(upsert.body.trigger, undefined, 'the CRM\'s own workflows still run for a new lead');
  const stored = await kit.users.byId(user._id);
  assert.ok(stored.crmId, 'the Zoho id is kept');

  await kit.users.saveProfile(stored, { firm: 'AB Constructions Pvt Ltd' });
  await outbox.enqueue(user._id);
  await outbox.tick();
  const put = zoho.calls.find((c) => c.method === 'PUT');
  assert.equal(put.path, `/crm/v6/Leads/${stored.crmId}`);
  assert.equal(put.body.data[0].id, stored.crmId);
  assert.equal(put.body.data[0].Company, 'AB Constructions Pvt Ltd');
  assert.equal(zoho.leads.size, 1, 'one lead, not two');
  assert.deepEqual((await outbox.stats()).pending, 0);
  kit.close();
});

test('until the credentials exist nothing is sent and nothing is lost; once they exist the queue is delivered', async () => {
  const kit = makeKit();
  const zoho = fakeZoho(kit);
  let client = createZohoClient({ ...CONFIG, refreshToken: '' }, { fetch: zoho.fetch, now: kit.now });
  const outbox = createCrmOutbox({ db: kit.db, settings: kit.settings, users: kit.users, events: kit.events, zoho: () => client, now: kit.now, log: kit.log });
  const a = await completeUser(kit, 'a@one.example');
  const b = await completeUser(kit, 'b@two.example');
  await outbox.enqueue(a._id);
  await outbox.enqueue(b._id);
  assert.deepEqual(await outbox.tick(), { sent: 0, waiting: true });
  assert.equal(zoho.calls.length, 0, 'not one request left the server');
  assert.equal((await outbox.stats()).pending, 2);

  client = createZohoClient(CONFIG, { fetch: zoho.fetch, now: kit.now }); // the admin pasted the credentials into .env
  await outbox.tick();
  assert.equal(zoho.leads.size, 2);
  assert.equal((await outbox.stats()).pending, 0);
  kit.close();
});

test('trouble at Zoho: slow down and retry; stop on a refusal that retrying cannot fix; credentials problems wait without using up the retries', async () => {
  const kit = makeKit();
  const zoho = fakeZoho(kit);
  const client = createZohoClient(CONFIG, { fetch: zoho.fetch, now: kit.now });
  const outbox = createCrmOutbox({ db: kit.db, settings: kit.settings, users: kit.users, events: kit.events, zoho: () => client, now: kit.now, log: kit.log });
  const user = await completeUser(kit);
  await outbox.enqueue(user._id);

  zoho.state.script = [{ status: 429, body: {}, headers: { 'Retry-After': '120' } }];
  await outbox.tick();
  const col = await kit.db.col('outbox');
  let job = await col.findOne({ userId: user._id });
  assert.equal(job.status, 'pending');
  assert.equal(job.nextAt, kit.now() + 120_000, 'Zoho\'s Retry-After was obeyed');
  assert.deepEqual(await outbox.tick(), { sent: 0 }, 'not due yet');

  kit.advance(121_000);
  zoho.state.script = ['network'];
  await outbox.tick();
  job = await col.findOne({ userId: user._id });
  assert.equal(job.status, 'pending');
  assert.equal(job.attempts, 2);
  assert.equal(job.nextAt, kit.now() + 5 * 60_000, 'delays grow');

  kit.advance(6 * 60_000);
  zoho.state.script = [{ status: 500, body: {} }];
  await outbox.tick();
  kit.advance(31 * 60_000);
  await outbox.tick();
  job = await col.findOne({ userId: user._id });
  assert.equal(job.status, 'sent', 'it got through in the end');
  assert.equal(zoho.leads.size, 1);

  // a refusal that retrying cannot fix: wrong field name
  const other = await completeUser(kit, 'x@other.example');
  await kit.settings.update({ 'crm.field.company': 'Not A Field' }).catch((e) => assert.match(e.message, /API field name/));
  zoho.state.script = [{ status: 400, body: { data: [{ code: 'INVALID_DATA', status: 'error', details: { api_name: 'Company' } }] } }];
  await outbox.enqueue(other._id);
  await outbox.tick();
  const failed = await col.findOne({ userId: other._id });
  assert.equal(failed.status, 'failed');
  assert.match(failed.lastError, /INVALID_DATA/);
  assert.equal((await outbox.stats()).failed, 1);
  assert.equal(await outbox.retryFailed(), 1, 'the admin can send it again once the cause is fixed');
  await outbox.tick();
  assert.equal((await col.findOne({ userId: other._id })).status, 'sent');

  // wrong credentials: the job waits, its attempts are not used up
  const third = await completeUser(kit, 'y@third.example');
  const broken = createZohoClient(CONFIG, { fetch: async (u, i) => (new URL(u).pathname === '/oauth/v2/token' ? new Response(JSON.stringify({ error: 'invalid_code' }), { status: 200 }) : zoho.fetch(u, i)), now: kit.now });
  const waiting = createCrmOutbox({ db: kit.db, settings: kit.settings, users: kit.users, events: kit.events, zoho: () => broken, now: kit.now, log: kit.log });
  await waiting.enqueue(third._id);
  await waiting.tick();
  const held = await col.findOne({ userId: third._id });
  assert.equal(held.status, 'pending');
  assert.equal(held.attempts, 0);
  assert.ok(held.nextAt > kit.now());
  assert.ok(kit.log.lines.some((l) => /crm\.failed/.test(l) && /credentials/.test(l)), 'the owner is told');
  kit.close();
});

test('an account changed while it was being sent is sent again', async () => {
  const kit = makeKit();
  const zoho = fakeZoho(kit);
  const client = createZohoClient(CONFIG, { fetch: zoho.fetch, now: kit.now });
  const outbox = createCrmOutbox({ db: kit.db, settings: kit.settings, users: kit.users, events: kit.events, zoho: () => client, now: kit.now, log: kit.log });
  const user = await completeUser(kit);
  await outbox.enqueue(user._id);
  const col = await kit.db.col('outbox');
  // pretend a worker has claimed it (status sending), then the person edits their profile
  await col.updateOne({ userId: user._id }, { $set: { status: 'sending', leaseUntil: kit.now() + 60_000, attempts: 1 } });
  const claimedRev = (await col.findOne({ userId: user._id })).rev;
  await outbox.enqueue(user._id);
  const during = await col.findOne({ userId: user._id });
  assert.equal(during.status, 'sending', 'the running job is not disturbed');
  assert.equal(during.rev, claimedRev + 1, 'but it is marked as out of date');
  kit.close();
});

test('a change made while a send is in flight is not lost: the job goes round again with the newer details', async () => {
  const kit = makeKit();
  const zoho = fakeZoho(kit);
  const client = createZohoClient(CONFIG, { fetch: zoho.fetch, now: kit.now });
  const outbox = createCrmOutbox({ db: kit.db, settings: kit.settings, users: kit.users, events: kit.events, zoho: () => client, now: kit.now, log: kit.log });
  const user = await completeUser(kit);
  await outbox.enqueue(user._id);
  zoho.state.duringUpsert = async () => {
    zoho.state.duringUpsert = null;
    const fresh = await kit.users.byId(user._id);
    await kit.users.saveProfile(fresh, { firm: 'Renamed Firm' });
    await outbox.enqueue(user._id); // the person edits their profile while Zoho is still working on the first send
  };
  await outbox.tick();
  const col = await kit.db.col('outbox');
  // the first send was not allowed to count as "done" (a newer version existed), so the same pass went round again with the new details
  assert.equal(zoho.calls.filter((c) => c.path.endsWith('/upsert')).length, 1);
  assert.equal(zoho.calls.filter((c) => c.method === 'PUT').length, 1, 'the second trip updated the record the first one made');
  assert.equal((await col.findOne({ userId: user._id })).status, 'sent');
  assert.equal(zoho.leads.size, 1);
  assert.equal([...zoho.leads.values()][0].Company, 'Renamed Firm', 'the CRM ends up with the newer details');
  kit.close();
});

test('deleting an account removes what is waiting for it; the CRM record is deleted only when the admin says so', async () => {
  const kit = makeKit();
  const zoho = fakeZoho(kit);
  const client = createZohoClient(CONFIG, { fetch: zoho.fetch, now: kit.now });
  const outbox = createCrmOutbox({ db: kit.db, settings: kit.settings, users: kit.users, events: kit.events, zoho: () => client, now: kit.now, log: kit.log });
  const col = await kit.db.col('outbox');

  const pending = await completeUser(kit, 'p@pending.example');
  await outbox.enqueue(pending._id);
  await outbox.forget(await kit.users.byId(pending._id));
  assert.equal(await col.countDocuments({ userId: pending._id }), 0, 'no job (and so no personal data) is left behind');

  const synced = await completeUser(kit, 's@synced.example');
  await outbox.enqueue(synced._id);
  await outbox.tick();
  const withId = await kit.users.byId(synced._id);
  await outbox.forget(withId);
  await outbox.tick();
  assert.equal(zoho.leads.has(withId.crmId), true, 'by default the sales team\'s record is left alone');
  assert.equal(zoho.calls.some((c) => c.method === 'DELETE'), false);

  await kit.settings.update({ 'crm.deleteOnAccountDelete': true });
  await outbox.forget(withId);
  const job = await col.findOne({ userId: synced._id });
  assert.deepEqual({ op: job.op, crmId: job.crmId }, { op: 'delete', crmId: withId.crmId });
  assert.equal(JSON.stringify(job).includes('s@synced.example'), false, 'the delete job carries no personal data');
  await outbox.tick();
  const del = zoho.calls.find((c) => c.method === 'DELETE');
  assert.equal(del.search, `?ids=${withId.crmId}`);
  assert.equal(zoho.leads.has(withId.crmId), false);
  assert.equal(await col.countDocuments({ userId: synced._id }), 0);
  kit.close();
});

test('switched off in settings: nothing is queued; backfill queues finished accounts that were never sent', async () => {
  const kit = makeKit();
  const zoho = fakeZoho(kit);
  const client = createZohoClient(CONFIG, { fetch: zoho.fetch, now: kit.now });
  const outbox = createCrmOutbox({ db: kit.db, settings: kit.settings, users: kit.users, events: kit.events, zoho: () => client, now: kit.now, log: kit.log });
  await kit.settings.update({ 'crm.enabled': false });
  const early = await completeUser(kit, 'e@early.example');
  assert.equal(await outbox.enqueue(early._id), false);
  assert.deepEqual(await outbox.tick(), { sent: 0 });
  await kit.settings.update({ 'crm.enabled': true });
  assert.equal(await outbox.backfill(), 1);
  await outbox.tick();
  assert.equal(zoho.leads.size, 1);
  assert.equal(await outbox.backfill(), 0, 'already sent');
  const off = createCrmOutbox({ db: kit.db, settings: kit.settings, users: kit.users, events: kit.events, zoho: () => client, enabled: false, now: kit.now, log: kit.log });
  assert.equal(await off.enqueue(early._id), false, 'AUTH_CRM=off');
  kit.close();
});
