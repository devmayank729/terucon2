import assert from 'node:assert/strict';
import test from 'node:test';
import { randomCode, randomId, randomToken, safeEqual, sha256, hmac } from '../../server/auth/crypto.js';
import {
  classifyIdentifier,
  cleanFirm,
  cleanName,
  firmFromDomain,
  isDisposable,
  isFreeMail,
  maskEmail,
  maskPhone,
  normalizeEmail,
  normalizePhone,
  phoneCountryAllowed,
  splitName,
} from '../../server/auth/identifiers.js';

const ZWSP = String.fromCharCode(0x200b); // a zero-width space, written so that the source stays free of invisible characters

// What a person types, before it reaches an e-mail, a text message, a rate-limit key or the CRM.

test('crypto helpers: random values have the right shape, comparisons are by value, codes keep their zeros', () => {
  assert.match(randomToken(), /^[A-Za-z0-9_-]{43}$/);
  assert.match(randomId(), /^[a-f0-9]{32}$/);
  assert.notEqual(randomToken(), randomToken());
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false, 'a different length is simply not equal, it never throws');
  assert.equal(hmac('k1', 'x') === hmac('k2', 'x'), false, 'the secret changes the code hash');
  assert.equal(sha256('x'), sha256('x'));
  for (let i = 0; i < 200; i += 1) assert.match(randomCode(6), /^\d{6}$/);
  // a code below 100000 must still be six characters ("004217"), or half of them would be unguessable-looking but unenterable
  const codes = new Set();
  for (let i = 0; i < 4000; i += 1) codes.add(randomCode(6).startsWith('0'));
  assert.ok(codes.has(true), 'codes that start with 0 are produced');
});

test('e-mail: lower-cased, trimmed, one @, a real domain; everything else is refused, not repaired', () => {
  assert.equal(normalizeEmail('  Rahul.Sharma@Terucon.COM ').value, 'rahul.sharma@terucon.com');
  assert.equal(normalizeEmail('ａｂｃ@example.com').value, 'abc@example.com', 'full-width letters are folded to plain ones');
  assert.equal(normalizeEmail('a+tag@ex-ample.co.in').domain, 'ex-ample.co.in');
  assert.equal(normalizeEmail('user@münchen.de').domain, 'xn--mnchen-3ya.de', 'an international domain becomes its ASCII form');
  const refused = [
    '', 'plain', 'a@b', 'a@b.', '@x.com', 'a@@x.com', 'a@x@y.com', 'a b@x.com', 'a@x .com', '"quoted"@x.com', 'a,b@x.com', 'a;b@x.com',
    'a@x.com\r\nBcc: victim@evil.test', 'a@x.com\nSubject: hi', 'a<b>@x.com', 'a@x.c', 'a@-x.com', 'a@x-.com', 'a@x..com', '.a@x.com', 'a.@x.com',
    'a..b@x.com', '=1+1@x.com', '+x@x.com', '-x@x.com', '@x.com', 'ра@x.com', 'a@1.2.3.4', 'a@[127.0.0.1]', 'a@localhost', `${'a'.repeat(65)}@x.com`, `a@${'b'.repeat(64)}.com`, `a@x.com${ZWSP}`, 'a\u0000@x.com',
    null, undefined, 42, {}, ['a@x.com'], 'a@x.com'.repeat(100),
  ];
  for (const bad of refused) assert.equal(normalizeEmail(bad), null, JSON.stringify(bad));
});

test('e-mail rate key: plus-tags and Gmail dots cannot be used to dodge a limit', () => {
  assert.equal(normalizeEmail('victim+1@x.com').rateKey, 'victim@x.com');
  assert.equal(normalizeEmail('victim+zzz@x.com').rateKey, 'victim@x.com');
  assert.equal(normalizeEmail('v.i.c.t.i.m+a@gmail.com').rateKey, 'victim@gmail.com');
  assert.equal(normalizeEmail('victim@googlemail.com').rateKey, 'victim@gmail.com');
  assert.equal(normalizeEmail('v.ictim@x.com').rateKey, 'v.ictim@x.com', 'dots only count as nothing at Gmail');
  assert.equal(normalizeEmail('x+@x.com').rateKey, 'x@x.com');
  // but the account key stays exact: two addresses are two accounts even when they share a mailbox
  assert.notEqual(normalizeEmail('victim+1@x.com').value, normalizeEmail('victim@x.com').value);
});

test('free and throw-away mailboxes are recognised; a company domain is not', () => {
  for (const d of ['gmail.com', 'yahoo.co.in', 'hotmail.com', 'outlook.com', 'live.in', 'icloud.com', 'yahoo.fr', 'hotmail.de', 'proton.me', 'rediffmail.com']) assert.equal(isFreeMail(d), true, d);
  for (const d of ['terucon.com', 'ab-constructions.co.in', 'studio.design', 'mygmail.com']) assert.equal(isFreeMail(d), false, d);
  assert.equal(isDisposable('mailinator.com'), true);
  assert.equal(isDisposable('x.mailinator.com', ['mailinator.com']), true, 'a sub-domain of a blocked domain is blocked');
  assert.equal(isDisposable('terucon.com'), false);
  assert.equal(isDisposable('evil.test', ['evil.test']), true, 'the admin can add a domain');
  assert.equal(isDisposable('notevil.test', ['evil.test']), false, 'but "notevil.test" is not a sub-domain of "evil.test"');
});

test('phone: Indian mobiles in every common spelling become +91..., other countries need the +, junk is refused', () => {
  for (const ok of ['9876543210', '09876543210', '+91 98765 43210', '91-98765-43210', '(98765) 43210', '919876543210', '+919876543210', '0091 9876543210']) {
    assert.equal(normalizePhone(ok), '+919876543210', ok);
  }
  assert.equal(normalizePhone('+44 7911 123456'), '+447911123456');
  assert.equal(normalizePhone('+1 (415) 555-2671'), '+14155552671');
  const refused = [
    '', '12345', '5876543210', '98765432101', '+91 5876543210', '+91 98765 4321', '+0123456789', '++919876543210', '91+9876543210', '98765-abcde', 'call me', '9876543210; DROP TABLE',
    '+1234567', `+${'9'.repeat(16)}`, '011 2345 6789', '9876543210\n9876543211', null, undefined, 9876543210, {},
  ];
  for (const bad of refused) assert.equal(normalizePhone(bad), null, JSON.stringify(bad));
});

test('the country allow-list for text messages is by calling code, and an empty list allows nobody', () => {
  assert.equal(phoneCountryAllowed('+919876543210', ['91']), true);
  assert.equal(phoneCountryAllowed('+447911123456', ['91']), false);
  assert.equal(phoneCountryAllowed('+447911123456', ['91', '44']), true);
  assert.equal(phoneCountryAllowed('+919876543210', []), false);
  assert.equal(phoneCountryAllowed('+14155552671', ['1']), true);
});

test('classifyIdentifier decides e-mail or phone from what was typed, and never throws', () => {
  assert.deepEqual(classifyIdentifier(' Me@Terucon.com '), { kind: 'email', value: 'me@terucon.com', key: 'me@terucon.com', rateKey: 'me@terucon.com', domain: 'terucon.com' });
  assert.deepEqual(classifyIdentifier('98765 43210'), { kind: 'phone', value: '+919876543210', key: '+919876543210', rateKey: '+919876543210' });
  assert.deepEqual(classifyIdentifier('nobody@'), { error: 'invalid-email' });
  assert.deepEqual(classifyIdentifier('123'), { error: 'invalid-phone' });
  assert.deepEqual(classifyIdentifier('   '), { error: 'empty' });
  for (const odd of [null, undefined, 5, {}, [], { toString: () => 'a@b.co' }]) assert.ok(classifyIdentifier(odd).error, JSON.stringify(odd));
});

test('masks show enough to recognise your own address and number', () => {
  assert.equal(maskEmail('rahul@terucon.com'), 'r•••••@terucon.com');
  assert.equal(maskPhone('+919876543210'), '+91 ••••• ••210');
  assert.equal(maskPhone('+447911123456'), '+44 ••••• ••456');
  assert.equal(maskEmail('nonsense'), '');
  assert.equal(maskPhone('nonsense'), '');
});

test('names: letters in any script, no markup, no control characters, no empty names', () => {
  assert.equal(cleanName('  Rahul   Sharma '), 'Rahul Sharma');
  assert.equal(cleanName("Anne-Marie O'Neil"), "Anne-Marie O'Neil");
  assert.equal(cleanName('राहुल शर्मा'), 'राहुल शर्मा');
  assert.equal(cleanName('Dr. A. Khan (Terucon)'), 'Dr. A. Khan (Terucon)');
  for (const bad of ['', '   ', '=cmd|calc', '+91 98765', '-Bob', '@Bob', '(Bob)', '<script>alert(1)</script>', 'Bob<b>', '12345', '....', 'a'.repeat(81), 'Bob\u0000', 'x{{7*7}}', '${jndi:ldap://x}', 'Bob; DROP', null, undefined, 7, {}]) {
    assert.equal(cleanName(bad), null, JSON.stringify(bad));
  }
  assert.equal(cleanName(`Bob${ZWSP}Smith`), 'Bob Smith', 'zero-width characters are swapped for a space, so they cannot hide');
});

test('firms: a little more punctuation than a person, never markup or a link', () => {
  assert.equal(cleanFirm('  Sharma & Sons Interiors (P) Ltd. '), 'Sharma & Sons Interiors (P) Ltd.');
  assert.equal(cleanFirm('A/B Studio + Co'), 'A/B Studio + Co');
  for (const bad of ['', '=HYPERLINK(1)', '+Acme', '-Acme', '@Acme', '(Acme)', '<img src=x onerror=alert(1)>', 'www.spam.example', 'visit http://spam.example', '//evil', '""', 'a'.repeat(101), '=HYPERLINK("x")', null, 5]) {
    assert.equal(cleanFirm(bad), null, JSON.stringify(bad));
  }
});

test('splitName: the last word is the last name, because the CRM insists on one', () => {
  assert.deepEqual(splitName('Rahul Sharma'), { first: 'Rahul', last: 'Sharma' });
  assert.deepEqual(splitName('Mary Anne Smith'), { first: 'Mary Anne', last: 'Smith' });
  assert.deepEqual(splitName('Cher'), { first: '', last: 'Cher' });
});

test('a firm name is suggested from a business domain, and from nothing else', () => {
  assert.equal(firmFromDomain('terucon.com'), 'Terucon');
  assert.equal(firmFromDomain('terucon.co.in'), 'Terucon');
  assert.equal(firmFromDomain('mail.ab-constructions.co.in'), 'Ab Constructions');
  assert.equal(firmFromDomain('sharma_interiors.in'), 'Sharma Interiors');
  assert.equal(firmFromDomain('gmail.com'), null);
  assert.equal(firmFromDomain('yahoo.co.in'), null);
  assert.equal(firmFromDomain('mailinator.com'), null);
  assert.equal(firmFromDomain('co.in'), null, 'a public suffix alone has no firm in it');
  assert.equal(firmFromDomain('firm.example'), 'Firm', 'a firm called Firm: "firm" is only a suffix word under a two-letter country code');
  assert.equal(firmFromDomain('acme.com.au'), 'Acme');
  assert.equal(firmFromDomain('123.com'), null, 'a number is not a name');
  assert.equal(firmFromDomain('xn--mnchen-3ya.de'), null, 'punycode is not shown to people as a name');
  assert.equal(firmFromDomain('blocked.test', ['blocked.test']), null);
  assert.equal(firmFromDomain(''), null);
});
