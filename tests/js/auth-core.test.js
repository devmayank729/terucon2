import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, SCHEMA, checkPatch, checkValue, nest, SettingsConflictError, SettingsInvalidError } from '../../server/auth/settings.js';
import { ipKey } from '../../server/auth/limits.js';
import { makeKit } from '../helpers/authKit.js';

// One-time codes, sessions, accounts and settings: the services themselves, on the in-memory store, with a clock the test moves.

const start = (kit, raw, extra = {}) => kit.otp.start({ identifier: kit.id(raw), purpose: 'login', ip: '10.0.0.1', ...extra });
const verify = (kit, challengeId, code, extra = {}) => kit.otp.verify({ challengeId, code, purpose: 'login', ip: '10.0.0.1', ...extra });

test('a code goes to the address it was asked for, works once, and is only ever stored as a keyed hash', async () => {
  const kit = makeKit();
  const started = await start(kit, 'Priya@AB.co.in');
  assert.equal(started.ok, true);
  assert.equal(started.channel, 'email');
  assert.equal(started.to, 'p•••••@ab.co.in');
  assert.equal(started.codeLength, 6);
  assert.deepEqual(kit.capture.sent.map((m) => [m.channel, m.to]), [['email', 'priya@ab.co.in']]);
  const code = kit.capture.lastCode();
  assert.match(code, /^\d{6}$/);

  const col = await kit.db.col('challenges');
  const stored = JSON.stringify(await col.findOne({ _id: started.challengeId }));
  assert.equal(stored.includes(code), false, 'the code itself is nowhere in the database');
  assert.match(stored, /"codeHash":"[A-Za-z0-9_-]{43}"/);

  const ok = await verify(kit, started.challengeId, code);
  assert.equal(ok.ok, true);
  assert.equal(ok.challenge.idKey, 'priya@ab.co.in');
  const again = await verify(kit, started.challengeId, code);
  assert.equal(again.ok, false, 'a code is spent when it is used');
  kit.close();
});

test('a code does not work for another purpose, another person, after it expires, or in another shape', async () => {
  const kit = makeKit();
  const started = await start(kit, 'a@x.example');
  const code = kit.capture.lastCode();
  assert.equal((await verify(kit, started.challengeId, code, { purpose: 'delete', userId: 'u1' })).ok, false, 'a sign-in code cannot delete an account');
  assert.equal((await verify(kit, started.challengeId, code, { purpose: 'verify-contact' })).ok, false);
  assert.equal((await verify(kit, started.challengeId, code, { userId: 'someone' })).ok, false, 'a code made for nobody in particular is not for a signed-in person either');
  for (const typed of ['', '12345', '1234567', 'abcdef', '12 34', null, undefined, 123456, ['123456'], { code }]) {
    const r = await verify(kit, started.challengeId, typed);
    assert.equal(r.ok, false, JSON.stringify(typed));
  }
  assert.equal((await verify(kit, 'nope', code)).ok, false);
  assert.equal((await verify(kit, '0'.repeat(32), code)).ok, false);
  assert.equal((await verify(kit, null, code)).ok, false);
  // spaces and dashes in what a person typed are forgiven
  kit.advance(11 * 60 * 1000);
  assert.equal((await verify(kit, started.challengeId, code)).reason, 'expired');
  const fresh = await (async () => { kit.advance(60 * 1000); return start(kit, 'a@x.example'); })();
  assert.equal((await verify(kit, fresh.challengeId, `${kit.capture.lastCode().slice(0, 3)} ${kit.capture.lastCode().slice(3)}`)).ok, true);
  kit.close();
});

test('wrong guesses: five per code, counted before they are checked, and a code is dead after the fifth', async () => {
  const kit = makeKit();
  const started = await start(kit, 'g@x.example');
  const right = kit.capture.lastCode();
  const wrong = right === '000000' ? '111111' : '000000';
  const results = [];
  for (let i = 0; i < 5; i += 1) results.push(await verify(kit, started.challengeId, wrong));
  assert.deepEqual(results.map((r) => r.attemptsLeft), [4, 3, 2, 1, 0]);
  assert.equal(results[4].reason, 'too-many-attempts');
  const late = await verify(kit, started.challengeId, right);
  assert.equal(late.ok, false, 'even the right code does not work once the guesses are used up');
  kit.close();
});

test('sixty guesses at once get five between them (the ceiling is tested in the same step as the count)', async () => {
  const kit = makeKit();
  const started = await start(kit, 'race@x.example');
  const wrong = kit.capture.lastCode() === '000000' ? '111111' : '000000';
  const all = await Promise.all(Array.from({ length: 60 }, () => verify(kit, started.challengeId, wrong)));
  const checked = all.filter((r) => r.reason === 'wrong-code' || (r.reason === 'too-many-attempts' && r.attemptsLeft === 0));
  assert.equal(checked.length, 5, 'only five guesses were ever compared with the code');
  const col = await kit.db.col('challenges');
  assert.equal((await col.findOne({ _id: started.challengeId })).attempts, 5);
  kit.close();
});

test('two requests holding the same right code make one sign-in, not two', async () => {
  const kit = makeKit();
  const started = await start(kit, 'twice@x.example');
  const code = kit.capture.lastCode();
  const results = await Promise.all(Array.from({ length: 25 }, () => verify(kit, started.challengeId, code)));
  assert.equal(results.filter((r) => r.ok).length, 1);
  kit.close();
});

test('a fresh code does not give a fresh allowance: wrong guesses are counted across codes, and the address is locked', async () => {
  const kit = makeKit();
  await kit.settings.update({ 'limits.otpStartPerIdentifierPerHour': 20, 'otp.resendCooldownSeconds': 15, 'limits.failuresBeforeLock': 10 });
  let total = 0;
  let locked = null;
  for (let round = 0; round < 4 && !locked; round += 1) {
    const s = await start(kit, 'lock@x.example');
    if (!s.ok) { locked = s; break; }
    const wrong = kit.capture.lastCode() === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      const r = await verify(kit, s.challengeId, wrong);
      if (r.reason === 'locked') { locked = r; break; }
      total += 1;
    }
    kit.advance(20_000);
  }
  assert.equal(total, 10, 'ten wrong codes in all, however many codes they were spread over');
  assert.ok(locked && locked.status === 429, 'then it is locked');
  assert.equal(locked.reason, 'locked');
  assert.ok(locked.retryAfter > 0 && locked.retryAfter <= 30 * 60);
  const refused = await start(kit, 'lock@x.example');
  assert.equal(refused.reason, 'locked', 'and a new code cannot be asked for either');
  assert.equal((await start(kit, 'someone-else@x.example')).ok, true, 'other addresses are not affected');
  kit.advance(31 * 60 * 1000);
  assert.equal((await start(kit, 'lock@x.example')).ok, true, 'the lock wears off');
  kit.close();
});

test('a right code clears the wrong guesses held against the address', async () => {
  const kit = makeKit();
  const s = await start(kit, 'clear@x.example');
  const right = kit.capture.lastCode();
  for (let i = 0; i < 3; i += 1) await verify(kit, s.challengeId, right === '000000' ? '111111' : '000000');
  assert.equal((await kit.limits.count('otp-fail', 'clear@x.example', 3600_000)).used, 3);
  assert.equal((await verify(kit, s.challengeId, right)).ok, true);
  assert.equal((await kit.limits.count('otp-fail', 'clear@x.example', 3600_000)).used, 0);
  kit.close();
});

test('sending: a cooldown between codes, a cap per address per hour, plus-tags and Gmail dots are one mailbox', async () => {
  const kit = makeKit();
  assert.equal((await start(kit, 'v.ictim@gmail.com')).ok, true);
  const quick = await start(kit, 'victim+1@gmail.com');
  assert.equal(quick.reason, 'cooldown', 'a different spelling of the same mailbox shares the cooldown');
  assert.ok(quick.retryAfter <= 45);
  let sent = 1;
  for (let i = 0; i < 9; i += 1) {
    kit.advance(46_000);
    const r = await start(kit, `victim+${i}@gmail.com`);
    if (r.ok) sent += 1;
    else {
      assert.equal(r.reason, 'rate-limited');
      break;
    }
  }
  assert.equal(sent, 5, 'five codes an hour to one mailbox, however it is spelled');
  assert.equal(kit.capture.sent.length, 5, 'and only five were really sent');
  kit.advance(60 * 60 * 1000);
  assert.equal((await start(kit, 'victim@gmail.com')).ok, true, 'the next hour starts fresh');
  kit.close();
});

test('per network address: fifteen codes an hour, counted per /64 for IPv6', async () => {
  const kit = makeKit();
  let allowed = 0;
  for (let i = 0; i < 20; i += 1) if ((await kit.otp.start({ identifier: kit.id(`n${i}@x.example`), purpose: 'login', ip: '203.0.113.9' })).ok) allowed += 1;
  assert.equal(allowed, 15);
  let v6 = 0;
  for (let i = 0; i < 20; i += 1) if ((await kit.otp.start({ identifier: kit.id(`m${i}@x.example`), purpose: 'login', ip: `2001:db8:abcd:12::${i + 1}` })).ok) v6 += 1;
  assert.equal(v6, 15, 'twenty addresses inside one /64 are one visitor');
  assert.equal((await kit.otp.start({ identifier: kit.id('o@x.example'), purpose: 'login', ip: '2001:db8:abcd:13::1' })).ok, true, 'a different /64 is a different visitor');
  assert.equal(ipKey('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(ipKey('2001:db8:abcd:12:1:2:3:4'), 'v6:2001:db8:abcd:12');
  assert.equal(ipKey('2001:0db8:abcd:0012::1'), 'v6:2001:db8:abcd:12');
  assert.equal(ipKey('fe80::1%eth0'), 'v6:fe80:0:0:0');
  assert.equal(ipKey('garbage'), 'unknown');
  assert.equal(ipKey(undefined), 'unknown');
  kit.close();
});

test('text messages: only the countries on the list, and the site-wide daily ceiling holds', async () => {
  const kit = makeKit();
  assert.equal((await start(kit, '+44 7911 123456')).reason, 'country-not-supported');
  assert.equal(kit.capture.sent.length, 0, 'nothing was sent to a country that is not on the list');
  assert.equal((await start(kit, '98765 43210')).ok, true);
  await kit.settings.update({ 'sms.allowedCountryCodes': ['91', '44'], 'limits.smsPerDay': 2, 'limits.otpStartPerIpPerHour': 200 });
  kit.advance(46_000);
  assert.equal((await start(kit, '+44 7911 123456')).ok, true);
  kit.advance(46_000);
  const over = await start(kit, '98765 11111');
  assert.equal(over.reason, 'daily-cap');
  assert.equal(over.status, 503);
  assert.equal(kit.capture.sent.filter((m) => m.channel === 'sms').length, 2);
  assert.equal((await start(kit, 'still-works@x.example')).ok, true, 'e-mail has its own ceiling');
  kit.advance(24 * 60 * 60 * 1000 + 1000);
  assert.equal((await start(kit, '98765 22222')).ok, true, 'tomorrow the ceiling is new');
  await kit.settings.update({ 'sms.allowedCountryCodes': [] });
  kit.advance(46_000);
  assert.equal((await start(kit, '98765 33333')).reason, 'country-not-supported', 'an empty list allows nobody');
  kit.close();
});

test('throw-away addresses and the admin\'s blocked domains are refused', async () => {
  const kit = makeKit();
  assert.equal((await start(kit, 'x@mailinator.com')).reason, 'email-not-allowed');
  await kit.settings.update({ 'email.blockedDomains': ['evil.example'] });
  assert.equal((await start(kit, 'x@evil.example')).reason, 'email-not-allowed');
  assert.equal((await start(kit, 'x@sub.evil.example')).reason, 'email-not-allowed');
  assert.equal((await start(kit, 'x@notevil.example')).ok, true);
  await kit.settings.update({ 'email.blockDisposable': false });
  kit.advance(46_000);
  assert.equal((await start(kit, 'y@mailinator.com')).ok, true, 'the admin can allow them');
  kit.close();
});

test('a channel that is switched off or has no service behind it is not offered, and sends nothing', async () => {
  const kit = makeKit();
  await kit.settings.update({ 'channels.sms': false });
  assert.equal((await start(kit, '98765 43210')).reason, 'channel-unavailable-sms');
  kit.capture.providers.email.ready = false;
  assert.equal((await start(kit, 'a@x.example')).reason, 'channel-unavailable-email');
  assert.equal(kit.capture.sent.length, 0);
  kit.close();
});

test('a send that fails leaves no live code behind and does not use up the allowance', async () => {
  const kit = makeKit();
  kit.capture.state.failNext = 1;
  const failed = await start(kit, 'down@x.example');
  assert.equal(failed.reason, 'send-failed');
  assert.equal(failed.status, 502);
  assert.equal(failed.message.includes('down'), false, 'the provider\'s own error is not shown');
  const col = await kit.db.col('challenges');
  assert.equal(await col.countDocuments({ idKey: 'down@x.example' }), 0);
  assert.equal((await start(kit, 'down@x.example')).ok, true, 'no cooldown or hourly count was held against them');
  kit.close();
});

test('sessions: made once, found by the cookie\'s token only, expire when idle or old, end on request or for everybody', async () => {
  const kit = makeKit();
  const { token } = await kit.sessions.create({ userId: 'u1', ip: '10.0.0.1', userAgent: 'agent\r\nX-Evil: 1' });
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const col = await kit.db.col('sessions');
  const rows = await col.find({}).toArray();
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows[0]).includes(token), false, 'the token itself is not in the database, only its hash');
  assert.equal(rows[0].ua.includes('\r'), false);
  assert.equal((await kit.sessions.resolve(token)).userId, 'u1');
  for (const bad of ['', 'x', null, undefined, token.slice(1), token + 'a', 5, {}]) assert.equal(await kit.sessions.resolve(bad), null, JSON.stringify(bad));

  kit.advance(15 * 24 * 60 * 60 * 1000);
  kit.sessions.forgetCache();
  assert.equal(await kit.sessions.resolve(token), null, 'idle for more than 14 days');
  const busy = await kit.sessions.create({ userId: 'u2', ip: '10.0.0.1', userAgent: 'x' });
  for (let day = 0; day < 31; day += 1) {
    kit.advance(24 * 60 * 60 * 1000);
    kit.sessions.forgetCache();
    const alive = await kit.sessions.resolve(busy.token);
    if (day < 29) assert.ok(alive, `day ${day}`);
    else if (day >= 30) assert.equal(alive, null, 'however often it is used, 30 days is the end');
  }
  const a = await kit.sessions.create({ userId: 'u3', ip: '10.0.0.1', userAgent: 'a' });
  const b = await kit.sessions.create({ userId: 'u3', ip: '10.0.0.2', userAgent: 'b' });
  await kit.sessions.revoke(a.token);
  assert.equal(await kit.sessions.resolve(a.token), null);
  assert.ok(await kit.sessions.resolve(b.token));
  const c = await kit.sessions.create({ userId: 'u3', ip: '10.0.0.3', userAgent: 'c' });
  assert.equal(await kit.sessions.revokeAll('u3', { exceptToken: c.token }), 1, 'everywhere else, but not here');
  assert.equal(await kit.sessions.resolve(b.token), null);
  assert.ok(await kit.sessions.resolve(c.token));
  assert.equal(await kit.sessions.revokeAll('u3'), 1);
  assert.equal(await kit.sessions.resolve(c.token), null);
  kit.close();
});

test('an admin who shortens the session lifetime shortens sessions that already exist', async () => {
  const kit = makeKit();
  const { token } = await kit.sessions.create({ userId: 'u1', ip: '10.0.0.1', userAgent: 'x' });
  kit.advance(5 * 24 * 60 * 60 * 1000);
  kit.sessions.forgetCache();
  assert.ok(await kit.sessions.resolve(token));
  await kit.settings.update({ 'session.idleDays': 1, 'session.maxDays': 3 });
  kit.sessions.forgetCache();
  assert.equal(await kit.sessions.resolve(token), null);
  kit.close();
});

test('accounts: the first verified e-mail makes one; signing in again finds it; an unproved claim is never a way in', async () => {
  const kit = makeKit();
  const first = await kit.users.signInOrCreate('email', 'priya@ab.co.in');
  assert.equal(first.created, true);
  assert.equal(first.user.profileComplete, false);
  assert.match(first.user.ownerId, /^[a-f0-9]{32}$/);
  const again = await kit.users.signInOrCreate('email', 'priya@ab.co.in');
  assert.equal(again.created, false);
  assert.equal(again.user._id, first.user._id);

  // the pre-account-takeover trap: an attacker signs up with their own phone and types the victim's address as theirs
  const attacker = (await kit.users.signInOrCreate('phone', '+919999900001')).user;
  const saved = await kit.users.saveProfile(attacker, { name: 'Mallory Kumar', email: 'victim@firm.example', firm: 'Evil Ltd' });
  assert.equal(saved.ok, true);
  assert.equal(saved.user.emailClaim, 'victim@firm.example');
  assert.equal(saved.user.emailKey, undefined, 'it is only a claim');
  // later the victim proves the address with a code: they get an account of their own, not the attacker's
  const victim = await kit.users.signInOrCreate('email', 'victim@firm.example');
  assert.equal(victim.created, true);
  assert.notEqual(victim.user._id, attacker._id);
  const after = await kit.users.byId(attacker._id);
  assert.equal(after.emailClaim, undefined, 'and the claim is taken off the attacker\'s account');
  assert.equal(after.email, undefined);
  assert.equal(after.profileComplete, false);
  assert.equal((await kit.users.findByVerified('email', 'victim@firm.example'))._id, victim.user._id);
  kit.close();
});

test('the sign-up form: a name and a firm (or "individual") and both contact details; a verified detail is never changed by typing', async () => {
  const kit = makeKit();
  const { user } = await kit.users.signInOrCreate('email', 'a@one.example');
  const bad = [
    [{ name: '<b>x</b>' }, 'name'],
    [{ name: '' }, 'name'],
    [{ firm: '<img src=x>' }, 'firm'],
    [{ phone: '12345' }, 'phone'],
    [{ phone: 'call me' }, 'phone'],
  ];
  for (const [input, field] of bad) {
    const r = await kit.users.saveProfile(user, input);
    assert.deepEqual([r.ok, r.field], [false, field], JSON.stringify(input));
  }
  const partial = await kit.users.saveProfile(user, { name: 'Anil Rao' });
  assert.equal(partial.user.profileComplete, false);
  assert.deepEqual(kit.users.missingFields(partial.user, true), ['phone', 'firm']);
  const done = await kit.users.saveProfile(partial.user, { phone: '98765 43210', individual: true });
  assert.equal(done.user.profileComplete, true);
  assert.equal(done.becameComplete, true);
  assert.equal(done.user.phone, '+919876543210');
  assert.equal(done.user.phoneClaim, '+919876543210');
  assert.equal(done.user.phoneKey, undefined, 'typed, not proved');
  // typing another address over a verified one does nothing
  const tried = await kit.users.saveProfile(done.user, { email: 'someone-else@two.example' });
  assert.equal(tried.user.email, 'a@one.example');
  assert.equal(tried.user.emailKey, 'a@one.example');
  // asking for a firm can be switched off
  const relaxed = await kit.users.saveProfile((await kit.users.signInOrCreate('email', 'b@two.example')).user, { name: 'Bina Das', phone: '9876500001' }, { requireFirm: false });
  assert.equal(relaxed.user.profileComplete, true);
  kit.close();
});

test('the sign-up form is finished only when the second contact detail is CONFIRMED, wherever a code can be sent to it', async () => {
  const kit = makeKit();
  const both = { requireFirm: true, confirm: { email: true, phone: true } };
  const { user } = await kit.users.signInOrCreate('email', 'a@one.example');
  const typed = (await kit.users.saveProfile(user, { name: 'Anil Rao', phone: '98765 43210', individual: true }, both)).user;
  assert.equal(typed.profileComplete, false);
  assert.deepEqual(kit.users.missingFields(typed, both), ['phone-confirm']);
  assert.deepEqual(kit.users.publicView(typed, both).needs, ['phone-confirm']);
  assert.deepEqual(kit.users.missingFields(typed, { requireFirm: true, confirm: { email: true, phone: false } }), [], 'no way to text a code: the typed number is enough, it just cannot sign anybody in yet');
  assert.deepEqual(kit.users.missingFields(typed, true), [], 'the older boolean form still means "a firm is needed" only');
  const confirmed = await kit.users.attachVerified(user._id, 'phone', '+919876543210');
  assert.equal(confirmed.ok, true);
  assert.equal((await kit.users.setComplete(user._id, both)).becameComplete, true);
  assert.deepEqual(kit.users.missingFields((await kit.users.byId(user._id)), both), []);
  // the other way round: a person who signed up with a number types an e-mail address
  const byPhone = (await kit.users.signInOrCreate('phone', '+919811100001')).user;
  const typedMail = (await kit.users.saveProfile(byPhone, { name: 'Bina Das', email: 'bina@two.example', individual: true }, both)).user;
  assert.deepEqual(kit.users.missingFields(typedMail, both), ['email-confirm']);
  kit.close();
});

test('proving a contact detail: it becomes the account\'s sign-in, claims elsewhere go, and a detail that is taken is refused', async () => {
  const kit = makeKit();
  const a = (await kit.users.signInOrCreate('email', 'a@one.example')).user;
  const b = (await kit.users.signInOrCreate('email', 'b@two.example')).user;
  const claimed = (await kit.users.saveProfile(b, { phone: '98765 43210' })).user;
  assert.equal(claimed.phoneClaim, '+919876543210');
  const ok = await kit.users.attachVerified(a._id, 'phone', '+919876543210');
  assert.equal(ok.ok, true);
  assert.equal(ok.user.phoneKey, '+919876543210');
  assert.equal((await kit.users.byId(b._id)).phoneClaim, undefined, 'b\'s unproved claim to that number is removed');
  assert.equal((await kit.users.findByVerified('phone', '+919876543210'))._id, a._id);
  const taken = await kit.users.attachVerified(b._id, 'phone', '+919876543210');
  assert.deepEqual([taken.ok, taken.reason], [false, 'taken']);
  const changed = await kit.users.attachVerified(a._id, 'email', 'a2@one.example');
  assert.equal(changed.user.emailKey, 'a2@one.example', 'a verified address is replaced only by proving the new one');
  assert.equal(await kit.users.findByVerified('email', 'a@one.example'), null, 'the old address no longer signs in');
  kit.close();
});

test('Google: matched by account id, then by the same verified e-mail; a second Google account on that e-mail is a conflict; new accounts start unfinished', async () => {
  const kit = makeKit();
  const g = { sub: 'sub-1', email: 'rahul@firm.example', name: 'Rahul Jain', hd: 'firm.example' };
  const made = await kit.users.signInOrCreateGoogle(g);
  assert.equal(made.created, true);
  assert.equal(made.user.emailKey, 'rahul@firm.example');
  assert.equal(made.user.googleHd, 'firm.example');
  assert.equal(kit.users.firmHint(made.user).name, 'Firm', 'the workspace domain gives the firm suggestion');
  assert.equal(made.user.profileComplete, false, 'phone and firm are still to be asked');
  const again = await kit.users.signInOrCreateGoogle({ ...g, email: 'renamed@firm.example' });
  assert.equal(again.user._id, made.user._id, 'by account id, even if the address changed');
  assert.equal((await kit.users.signInOrCreateGoogle({ ...g, sub: 'sub-2' })).conflict, true);
  const member = (await kit.users.signInOrCreate('email', 'old@member.example')).user;
  const linked = await kit.users.signInOrCreateGoogle({ sub: 'sub-3', email: 'old@member.example', name: 'Old Member', hd: null });
  assert.equal(linked.user._id, member._id, 'an existing member with the same verified e-mail is signed in, not duplicated');
  assert.equal(linked.linked, true);
  assert.equal((await kit.users.signInOrCreateGoogle({ sub: 'sub-9', email: 'new@x.example', name: null, hd: null }, { signupOpen: false })).closed, true);
  kit.close();
});

test('accounts that never finished the form are cleaned up after a week', async () => {
  const kit = makeKit();
  await kit.users.signInOrCreate('email', 'ghost@x.example');
  const done = (await kit.users.signInOrCreate('email', 'real@x.example')).user;
  await kit.users.saveProfile(done, { name: 'Real Person', phone: '9876543210', individual: true });
  kit.advance(6 * 24 * 60 * 60 * 1000);
  assert.equal(await kit.users.removeIncompleteOlderThan(7), 0);
  kit.advance(2 * 24 * 60 * 60 * 1000);
  assert.equal(await kit.users.removeIncompleteOlderThan(7), 1);
  assert.equal(await kit.users.findByVerified('email', 'ghost@x.example'), null);
  assert.ok(await kit.users.findByVerified('email', 'real@x.example'));
  kit.close();
});

test('the public view of an account has no internal ids and says what is still missing', async () => {
  const kit = makeKit();
  const { user } = await kit.users.signInOrCreate('email', 'v@x.example');
  const view = kit.users.publicView(user);
  assert.deepEqual(Object.keys(view).sort(), ['email', 'emailVerified', 'firm', 'googleLinked', 'individual', 'name', 'needs', 'phone', 'phoneVerified', 'profileComplete']);
  assert.deepEqual(view.needs, ['name', 'phone', 'firm']);
  assert.equal(JSON.stringify(view).includes(user.ownerId), false);
  assert.equal(JSON.stringify(view).includes(user._id), false);
  kit.close();
});

// ------------------------------------------------------------------------------------------------------- settings

test('settings: every value has a type, a default and bounds, and a bad save changes nothing', async () => {
  const kit = makeKit();
  const before = await kit.settings.describe();
  assert.equal(before.values['limits.otpStartPerIpPerHour'], 15);
  assert.equal(before.schema.length, SCHEMA.length);
  assert.ok(before.schema.every((s) => s.label && s.group && s.type));

  const bad = [
    { 'limits.otpStartPerIpPerHour': 0 },
    { 'limits.otpStartPerIpPerHour': 1_000_000_000 },
    { 'limits.otpStartPerIpPerHour': 1.5 },
    { 'limits.otpStartPerIpPerHour': '20' },
    { 'limits.otpStartPerIpPerHour': null, 'nope.not-a-setting': 1 },
    { 'otp.ttlMinutes': 0 },
    { 'otp.ttlMinutes': 99999 },
    { 'otp.maxAttempts': 1 },
    { 'otp.maxAttempts': 500 },
    { 'signup.open': 'yes' },
    { 'firm.lookup': 'everything' },
    { 'sms.allowedCountryCodes': 'all' },
    { 'sms.allowedCountryCodes': ['*'] },
    { 'sms.allowedCountryCodes': ['+91'] },
    { 'sms.allowedCountryCodes': Array.from({ length: 50 }, (_, i) => String(100 + i)) },
    { 'email.blockedDomains': ['not a domain'] },
    { 'email.blockedDomains': [5] },
    { 'crm.field.lastName': '' },
    { 'crm.field.email': 'Email; DROP' },
    { 'crm.field.email': '__proto__' + ' x' },
    { 'crm.leadSource': '<script>' },
    { 'crm.leadSource': 'x'.repeat(61) },
    { 'crm.module': 'Accounts' },
    { 'session.idleDays': 60, 'session.maxDays': 30 },
    JSON.parse('{"__proto__": {"polluted": true}}'), // as it arrives over the wire: a real property called __proto__
    JSON.parse('{"constructor": {"prototype": {}}}'),
  ];
  for (const patch of bad) {
    await assert.rejects(kit.settings.update(patch), SettingsInvalidError, JSON.stringify(patch));
  }
  assert.deepEqual((await kit.settings.describe()).values, before.values, 'nothing was saved');
  assert.equal({}.polluted, undefined);

  assert.equal(checkPatch([]).ok, false);
  assert.equal(checkPatch(null).ok, false);
  assert.equal(checkPatch('x').ok, false);
  kit.close();
});

test('settings: a good save takes effect at once, can be put back, and is kept as the difference from the defaults', async () => {
  const kit = makeKit();
  const saved = await kit.settings.update({ 'limits.otpStartPerIpPerHour': 30, 'sms.allowedCountryCodes': ['91', ' 44 ', '91'], 'crm.field.phone': 'Phone', 'firm.lookup': 'domain' });
  assert.equal(saved.values['limits.otpStartPerIpPerHour'], 30);
  assert.deepEqual(saved.values['sms.allowedCountryCodes'], ['91', '44'], 'tidied, de-duplicated');
  assert.deepEqual(saved.changed.sort(), ['crm.field.phone', 'firm.lookup', 'limits.otpStartPerIpPerHour', 'sms.allowedCountryCodes'].sort());
  assert.equal((await kit.settings.get()).limits.otpStartPerIpPerHour, 30);
  assert.equal((await kit.settings.get()).crm.field.phone, 'Phone');
  const back = await kit.settings.update({ 'limits.otpStartPerIpPerHour': null, 'crm.field.phone': 'Mobile' });
  assert.equal(back.values['limits.otpStartPerIpPerHour'], DEFAULTS['limits.otpStartPerIpPerHour']);
  assert.equal(back.changed.includes('crm.field.phone'), false, 'a value equal to its default is not kept as a change');
  const col = await kit.db.col('settings');
  const doc = await col.findOne({ _id: 'main' });
  assert.deepEqual(Object.keys(JSON.parse(doc.valuesJson)).sort(), ['firm.lookup', 'sms.allowedCountryCodes']);
  assert.equal(doc.version, 2, 'one version per save');
  kit.close();
});

test('settings: two admins saving at once are not allowed to overwrite each other silently', async () => {
  const kit = makeKit();
  await kit.settings.update({ 'otp.ttlMinutes': 5 });
  const results = await Promise.allSettled([kit.settings.update({ 'otp.maxAttempts': 4 }), kit.settings.update({ 'otp.maxAttempts': 6 }), kit.settings.update({ 'otp.resendCooldownSeconds': 60 })]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
  const conflicts = results.filter((r) => r.status === 'rejected' && r.reason instanceof SettingsConflictError).length;
  assert.equal(fulfilled + conflicts, 3, 'each either saved or was told to reload');
  assert.ok(fulfilled >= 1);
  const now = await kit.settings.describe();
  assert.equal(now.values['otp.ttlMinutes'], 5, 'the first save survived all of them');
  kit.close();
});

test('settings: a stored value that no longer passes its rule is ignored, not used', async () => {
  const kit = makeKit();
  const col = await kit.db.col('settings');
  await col.insertOne({ _id: 'main', version: 1, updatedAt: 1, valuesJson: JSON.stringify({ 'limits.otpStartPerIpPerHour': 0, 'otp.ttlMinutes': 'forever', 'unknown.key': 1, 'otp.maxAttempts': 7 }) });
  const cfg = await kit.settings.get();
  assert.equal(cfg.limits.otpStartPerIpPerHour, 15);
  assert.equal(cfg.otp.ttlMinutes, 10);
  assert.equal(cfg.otp.maxAttempts, 7);
  await col.updateOne({ _id: 'main' }, { $set: { valuesJson: 'this is not json' } });
  kit.settings.forget();
  assert.equal((await kit.settings.get()).otp.maxAttempts, 5, 'broken storage falls back to the defaults');
  kit.close();
});

test('settings helpers: values are checked one by one, nested for code, and every schema entry is self-consistent', () => {
  assert.deepEqual(nest({ 'a.b': 1, 'a.c': 2, d: 3 }), { a: { b: 1, c: 2 }, d: 3 });
  for (const s of SCHEMA) {
    assert.equal(checkValue(s, s.default).ok, true, `${s.key}: the default passes its own rule`);
    if (s.type === 'int') {
      assert.ok(s.min <= s.default && s.default <= s.max, `${s.key}: the default is inside the bounds`);
      assert.equal(checkValue(s, s.min - 1).ok, false, `${s.key}: below the minimum is refused`);
      assert.equal(checkValue(s, s.max + 1).ok, false, `${s.key}: above the maximum is refused`);
    }
  }
  assert.equal(new Set(SCHEMA.map((s) => s.key)).size, SCHEMA.length, 'no key twice');
});
