import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import test, { after, before } from 'node:test';
import { authConfig, isLoopbackHost, readAuthEnv } from '../../server/auth/config.js';
import { createProviders, ProviderError } from '../../server/auth/providers/index.js';
import { emailMessage, smsMessage, validSmsTemplate } from '../../server/auth/providers/messages.js';
import { sendSmtp, SmtpError } from '../../server/auth/providers/smtp.js';
import { loadSettings } from '../../server/config/settings.js';

// The senders: an SMTP client against a small pretend mail server, Twilio and a webhook against pretend HTTP, and the settings
// that choose between them.

// ------------------------------------------------------------------------------------------ a pretend SMTP server
function smtpServer({ auth = 'PLAIN LOGIN', starttls = false, tlsContext /* {key, cert} */, implicitTls = false, failAt = null, user = 'mailer', pass = 's3cret' } = {}) {
  const sessions = [];
  const onConnection = (socket) => {
    const session = { commands: [], message: null, authed: false, secure: Boolean(implicitTls) };
    sessions.push(session);
    let current = socket;
    let buffer = '';
    let inData = false;
    let data = '';
    const say = (line) => current.write(`${line}\r\n`);
    const handleLine = (line) => {
      if (inData) {
        if (line === '.') {
          inData = false;
          session.message = data;
          return failAt === 'DATA-END' ? say('554 message refused') : say('250 queued');
        }
        data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
        return undefined;
      }
      session.commands.push(line);
      const verb = line.split(' ')[0].toUpperCase();
      if (failAt === verb) return say(verb === 'RCPT' ? '550 no such user' : '554 refused');
      if (verb === 'EHLO') {
        say('250-mail.test');
        if (starttls && !session.secure) say('250-STARTTLS');
        if (auth && (session.secure || !starttls)) say(`250-AUTH ${auth}`);
        return say('250 8BITMIME');
      }
      if (verb === 'STARTTLS') {
        say('220 ready');
        socket.off('data', onData); // from here the bytes are the handshake, not SMTP lines
        current = new tls.TLSSocket(socket, { isServer: true, ...tlsContext });
        current.on('data', onData);
        session.secure = true;
        return undefined;
      }
      if (verb === 'AUTH') {
        const [, mech, initial] = line.split(' ');
        if (mech.toUpperCase() === 'PLAIN') {
          const [, u, p] = Buffer.from(initial, 'base64').toString().split('\0');
          if (u === user && p === pass) { session.authed = true; return say('235 ok'); }
          return say('535 bad credentials');
        }
        session.loginStep = 'user';
        return say('334 VXNlcm5hbWU6');
      }
      if (session.loginStep === 'user') { session.loginUser = Buffer.from(line, 'base64').toString(); session.loginStep = 'pass'; return say('334 UGFzc3dvcmQ6'); }
      if (session.loginStep === 'pass') {
        session.loginStep = null;
        if (session.loginUser === user && Buffer.from(line, 'base64').toString() === pass) { session.authed = true; return say('235 ok'); }
        return say('535 bad credentials');
      }
      if (verb === 'MAIL' || verb === 'RCPT') return say('250 ok');
      if (verb === 'DATA') { inData = true; data = ''; return say('354 go'); }
      if (verb === 'QUIT') { say('221 bye'); return current.end(); }
      return say('500 what');
    };
    const onData = (chunk) => {
      buffer += chunk.toString('latin1');
      let i;
      while ((i = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        handleLine(line);
      }
    };
    socket.on('error', () => {});
    current.on('data', onData);
    say('220 mail.test ready');
  };
  const server = implicitTls ? tls.createServer({ ...tlsContext }, onConnection) : net.createServer(onConnection);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, sessions, close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))) })));
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-smtp-'));
const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=mail.test', '-addext', 'subjectAltName=DNS:mail.test,IP:127.0.0.1'], { encoding: 'utf8' });
const noTls = made.status !== 0 && 'openssl is not available to make a test certificate';
let tlsContext;
before(() => {
  if (!noTls) tlsContext = { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }; // (a bare secureContext option fails the handshake in this Node)
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const base = { from: 'Terucon <no-reply@terucon.example>', to: 'priya@ab.example', subject: 'Terucon: your code is 123456', text: 'Your Terucon code is 123456\r\n\r\nIt works for 10 minutes.\r\n' };

test('SMTP: a message goes out with the right envelope, headers and body; the login is used', async () => {
  const server = await smtpServer();
  try {
    await sendSmtp({ host: '127.0.0.1', port: server.port, secure: 'none', user: 'mailer', pass: 's3cret', ...base });
    const [s] = server.sessions;
    assert.equal(s.authed, true);
    assert.ok(s.commands.includes('MAIL FROM:<no-reply@terucon.example>'));
    assert.ok(s.commands.includes('RCPT TO:<priya@ab.example>'));
    assert.match(s.message, /^From: Terucon <no-reply@terucon.example>\r\nTo: <priya@ab.example>\r\nSubject: Terucon: your code is 123456\r\n/);
    assert.match(s.message, /Message-ID: <[a-f0-9]{32}@terucon.example>/);
    assert.match(s.message, /Content-Type: text\/plain; charset=us-ascii/);
    assert.match(s.message, /\r\n\r\nYour Terucon code is 123456\r\n/);
    assert.equal(s.message.split('\r\n').filter((l) => /^(To|Cc|Bcc):/i.test(l)).length, 1, 'one recipient, no more');
  } finally {
    await server.close();
  }
});

test('SMTP: AUTH LOGIN is used when PLAIN is not offered; wrong credentials fail the send and say so without the password', async () => {
  const server = await smtpServer({ auth: 'LOGIN' });
  try {
    await sendSmtp({ host: '127.0.0.1', port: server.port, secure: 'none', user: 'mailer', pass: 's3cret', ...base });
    assert.equal(server.sessions[0].authed, true);
    await assert.rejects(sendSmtp({ host: '127.0.0.1', port: server.port, secure: 'none', user: 'mailer', pass: 'wrong', ...base }), (e) => e instanceof SmtpError && /login/.test(e.message) && !/wrong|s3cret/.test(e.message));
  } finally {
    await server.close();
  }
});

test('SMTP: a refused recipient or message is an error; a server that hangs up or says nothing is an error that ends', async () => {
  for (const failAt of ['RCPT', 'DATA', 'MAIL']) {
    const server = await smtpServer({ failAt });
    try {
      await assert.rejects(sendSmtp({ host: '127.0.0.1', port: server.port, secure: 'none', user: 'mailer', pass: 's3cret', ...base }), SmtpError, failAt);
    } finally {
      await server.close();
    }
  }
  const hangUp = net.createServer((s) => s.end());
  await new Promise((r) => hangUp.listen(0, '127.0.0.1', r));
  await assert.rejects(sendSmtp({ host: '127.0.0.1', port: hangUp.address().port, secure: 'none', ...base }), SmtpError);
  hangUp.close();
  const silent = net.createServer(() => {});
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  const started = Date.now();
  await assert.rejects(sendSmtp({ host: '127.0.0.1', port: silent.address().port, secure: 'none', timeoutMs: 400, ...base }), SmtpError);
  assert.ok(Date.now() - started < 3000, 'gave up at the deadline');
  silent.closeAllConnections?.();
  silent.close();
  const nonsense = net.createServer((s) => s.write('this is not smtp\r\n'));
  await new Promise((r) => nonsense.listen(0, '127.0.0.1', r));
  await assert.rejects(sendSmtp({ host: '127.0.0.1', port: nonsense.address().port, secure: 'none', ...base }), SmtpError);
  nonsense.closeAllConnections?.();
  nonsense.close();
});

test('SMTP: nothing a visitor types can become a header or a second recipient', async () => {
  const server = await smtpServer();
  try {
    const attempts = [
      { to: 'victim@x.example\r\nBcc: boss@x.example' },
      { to: 'victim@x.example>\r\nRCPT TO:<other@x.example' },
      { to: 'a@x.example, b@x.example' },
      { to: 'a b@x.example' },
      { to: '<a@x.example>' },
      { to: 'a@x.example\n' },
      { to: '' },
      { from: 'Terucon <no-reply@terucon.example>\r\nBcc: spy@x.example' },
      { from: 'not an address' },
      { subject: 'hello\r\nBcc: spy@x.example' },
      { subject: 'café' },
      { text: 'body\u0000with a nul' },
      { text: 'x\r\n.\r\nMAIL FROM:<spy@x.example>\r\nRCPT TO:<spy@x.example>' },
    ];
    for (const over of attempts) {
      const sessions = server.sessions.length;
      let failed = false;
      try {
        await sendSmtp({ host: '127.0.0.1', port: server.port, secure: 'none', user: 'mailer', pass: 's3cret', ...base, ...over });
      } catch {
        failed = true;
      }
      if (failed) continue;
      // a body that merely contains a dot line is allowed, but it must arrive as text, not as commands
      const s = server.sessions[sessions];
      assert.equal(s.commands.filter((c) => /^RCPT/i.test(c)).length, 1, `one recipient for ${JSON.stringify(over).slice(0, 60)}`);
      assert.equal(s.commands.filter((c) => /^MAIL/i.test(c)).length, 1);
      assert.equal(s.commands.some((c) => /spy@/.test(c)), false);
    }
  } finally {
    await server.close();
  }
});

test('SMTP: the dot-stuffing of a body line that starts with a dot is right', async () => {
  const server = await smtpServer();
  try {
    await sendSmtp({ host: '127.0.0.1', port: server.port, secure: 'none', ...base, text: 'one\r\n.two\r\n..three\r\n' });
    assert.match(server.sessions[0].message, /\r\n\r\none\r\n\.two\r\n\.\.three\r\n/);
  } finally {
    await server.close();
  }
});

test('SMTP: no encryption means this computer only; STARTTLS that cannot start means no send', async () => {
  await assert.rejects(sendSmtp({ host: 'mail.example.com', port: 25, secure: 'none', user: 'a', pass: 'b', ...base }), (e) => e instanceof SmtpError && /unencrypted/.test(e.message));
  const plainOnly = await smtpServer({ starttls: false });
  try {
    await assert.rejects(sendSmtp({ host: '127.0.0.1', port: plainOnly.port, secure: 'starttls', user: 'mailer', pass: 's3cret', ...base }), (e) => /STARTTLS/.test(e.message));
    assert.equal(plainOnly.sessions[0].authed, false, 'the login was never sent over the open connection');
    assert.equal(plainOnly.sessions[0].commands.some((c) => /^AUTH|^MAIL|^RCPT/i.test(c)), false);
  } finally {
    await plainOnly.close();
  }
});

test('SMTP over TLS (from the first byte) and STARTTLS: the certificate is checked', { skip: noTls }, async () => {
  const ca = fs.readFileSync(path.join(dir, 'cert.pem'));
  const implicit = await smtpServer({ implicitTls: true, tlsContext });
  try {
    await sendSmtp({ host: '127.0.0.1', port: implicit.port, secure: 'tls', user: 'mailer', pass: 's3cret', ...base, tlsOptions: { ca } });
    assert.equal(implicit.sessions[0].authed, true);
    const before = implicit.sessions.length;
    await assert.rejects(sendSmtp({ host: '127.0.0.1', port: implicit.port, secure: 'tls', user: 'mailer', pass: 's3cret', ...base }), SmtpError, 'a certificate nobody trusts is refused');
    assert.equal(implicit.sessions.length, before, 'the handshake failed first: the server never saw an SMTP session, so no login was sent');
  } finally {
    await implicit.close();
  }
  const upgrade = await smtpServer({ starttls: true, tlsContext });
  try {
    await sendSmtp({ host: '127.0.0.1', port: upgrade.port, secure: 'starttls', user: 'mailer', pass: 's3cret', ...base, tlsOptions: { ca } });
    const s = upgrade.sessions[0];
    assert.equal(s.secure, true);
    assert.ok(s.commands.indexOf('STARTTLS') < s.commands.findIndex((c) => c.startsWith('AUTH')), 'the login came after the upgrade, not before');
    assert.equal(s.authed, true);
    const before = upgrade.sessions.length;
    await assert.rejects(sendSmtp({ host: '127.0.0.1', port: upgrade.port, secure: 'starttls', user: 'mailer', pass: 's3cret', ...base }), SmtpError);
    assert.equal(upgrade.sessions[before].authed, false, 'an untrusted certificate: no credentials were sent');
  } finally {
    await upgrade.close();
  }
});

// ------------------------------------------------------------------------------------------------ the messages
test('the messages are fixed words plus digits', () => {
  const m = emailMessage({ code: '012345', ttlMinutes: 10, purpose: 'login' });
  assert.equal(m.subject, 'Terucon: your code is 012345');
  assert.match(m.text, /012345/);
  assert.match(m.text, /never tell this code/i);
  assert.match(emailMessage({ code: '1', ttlMinutes: 5, purpose: 'delete' }).text, /delete your Terucon account/);
  assert.doesNotMatch(m.text, /https?:\/\//, 'no link a phisher could imitate');
  assert.match(smsMessage({ code: '012345', ttlMinutes: 10 }), /^012345 is your Terucon verification code\./);
  assert.equal(smsMessage({ code: '9', ttlMinutes: 3, template: 'Use {code} within {minutes} min. {code}' }), 'Use 9 within 3 min. 9');
  assert.equal(validSmsTemplate('{code} is it'), true);
  for (const bad of ['no code here', '', null, 'x{code}'.repeat(100), '{code}\u0000', '{code} ‮']) assert.equal(validSmsTemplate(bad), false, JSON.stringify(bad));
});

// ------------------------------------------------------------------------------------------------ Twilio, webhook
const cfg = (over = {}) => ({
  email: { provider: 'off', from: '', smtp: { host: '', port: 0, secure: '', user: '', pass: '' } },
  sms: { provider: 'off', template: '', twilio: { accountSid: '', authToken: '', from: '', messagingServiceSid: '' }, webhook: { url: '', token: '' } },
  ...over,
});
const log = { info() {} };
const make = (c, extra = {}) => createProviders(c, { log, devAllowed: false, ...extra });

test('Twilio: the call is what Twilio documents, the token stays in the header, a failure is an error without the secret', async () => {
  const seen = [];
  const sid = `AC${'a'.repeat(32)}`;
  const fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response('{}', { status: seen.length === 1 ? 201 : 401 });
  };
  const { sms, problems } = make(cfg({ sms: { provider: 'twilio', template: '', twilio: { accountSid: sid, authToken: 'tok-secret', from: '+14155550100', messagingServiceSid: '' }, webhook: {} } }), { fetch });
  assert.deepEqual(problems, []);
  await sms.send({ to: '+919876543210', code: '123456', ttlMinutes: 10, purpose: 'login' });
  assert.equal(seen[0].url, `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`);
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers.Authorization, `Basic ${Buffer.from(`${sid}:tok-secret`).toString('base64')}`);
  const form = new URLSearchParams(String(seen[0].init.body));
  assert.deepEqual([form.get('To'), form.get('From'), form.get('MessagingServiceSid')], ['+919876543210', '+14155550100', null]);
  assert.match(form.get('Body'), /^123456 is your Terucon verification code/);
  assert.equal(String(seen[0].url).includes('tok-secret'), false);
  await assert.rejects(sms.send({ to: '+919876543210', code: '123456', ttlMinutes: 10, purpose: 'login' }), (e) => e instanceof ProviderError && !/tok-secret/.test(e.message) && e.status === 401);

  const { sms: viaService } = make(cfg({ sms: { provider: 'twilio', template: '', twilio: { accountSid: sid, authToken: 't', from: '', messagingServiceSid: `MG${'b'.repeat(32)}` }, webhook: {} } }), { fetch: async (u, i) => { seen.push({ url: String(u), init: i }); return new Response('{}', { status: 201 }); } });
  await viaService.send({ to: '+919876543210', code: '123456', ttlMinutes: 10, purpose: 'login' });
  const f2 = new URLSearchParams(String(seen.at(-1).init.body));
  assert.deepEqual([f2.get('From'), f2.get('MessagingServiceSid')], [null, `MG${'b'.repeat(32)}`]);
});

test('the SMS webhook: your own URL gets {to, message, code}; http only for this computer; a redirect is not followed', async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response('ok', { status: 200 });
  };
  const { sms, problems } = make(cfg({ sms: { provider: 'webhook', template: 'Terucon: {code} ({minutes} min)', twilio: {}, webhook: { url: 'https://sms.example/hook', token: 'hook-secret' } } }), { fetch });
  assert.deepEqual(problems, []);
  await sms.send({ to: '+919876543210', code: '654321', ttlMinutes: 7, purpose: 'delete' });
  assert.equal(seen[0].url, 'https://sms.example/hook');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer hook-secret');
  assert.equal(seen[0].init.redirect, 'error', 'a redirect to somewhere else is an error, not a second request');
  assert.deepEqual(JSON.parse(seen[0].init.body), { to: '+919876543210', message: 'Terucon: 654321 (7 min)', code: '654321', purpose: 'delete', minutes: 7 });
  for (const url of ['http://sms.example/hook', 'ftp://x', '', 'javascript:alert(1)']) assert.equal(make(cfg({ sms: { provider: 'webhook', template: '', twilio: {}, webhook: { url, token: '' } } })).sms.ready, false, url);
  assert.equal(make(cfg({ sms: { provider: 'webhook', template: '', twilio: {}, webhook: { url: 'http://localhost:9999/hook', token: '' } } })).sms.ready, true, 'http is fine for this computer');
  const failing = make(cfg({ sms: { provider: 'webhook', template: '', twilio: {}, webhook: { url: 'https://sms.example/hook', token: '' } } }), { fetch: async () => new Response('no', { status: 500 }) }).sms;
  await assert.rejects(failing.send({ to: '+919876543210', code: '1', ttlMinutes: 1, purpose: 'login' }), (e) => e.transient === true);
});

test('choosing senders: anything not set up properly is not offered, and says what is wrong', () => {
  assert.equal(make(cfg()).email.ready, false);
  assert.equal(make(cfg()).sms.ready, false);
  assert.deepEqual(make(cfg()).problems, []);
  const smtp = (over) => cfg({ email: { provider: 'smtp', from: 'Terucon <no-reply@terucon.example>', smtp: { host: 'smtp.zoho.in', port: 465, secure: 'tls', user: 'u', pass: 'p', ...over } } });
  assert.equal(make(smtp({})).email.ready, true);
  for (const [over, mention] of [[{ host: '' }, /AUTH_SMTP_HOST/], [{ secure: '' }, /AUTH_SMTP_SECURE/], [{ pass: '' }, /AUTH_SMTP_PASS/]]) {
    const r = make(smtp(over));
    assert.equal(r.email.ready, false);
    assert.match(r.problems.join(), mention);
  }
  for (const from of ['', 'no-reply', 'Terucon <>', 'Terucon <a@b.c>\r\nBcc: x@y.z', '"Terucon" <no-reply@terucon.example>', 'Terucon <no-reply@terucon.example> extra']) {
    assert.equal(make(cfg({ email: { provider: 'smtp', from, smtp: { host: 'h', port: 465, secure: 'tls', user: '', pass: '' } } })).email.ready, false, JSON.stringify(from));
  }
  assert.equal(make(cfg({ sms: { provider: 'twilio', template: '', twilio: { accountSid: 'nope', authToken: 'x', from: '+1', messagingServiceSid: '' }, webhook: {} } })).sms.ready, false);
  assert.equal(make(cfg({ sms: { provider: 'twilio', template: 'no code', twilio: {}, webhook: {} } })).sms.ready, false, 'a text template must carry the code');
  assert.match(make(cfg({ email: { provider: 'bogus', from: '', smtp: {} } })).problems.join(), /not one of/);
});

test('the console senders print the code, and only on a computer that is not a server', async () => {
  const lines = [];
  const dev = createProviders(cfg({ email: { provider: 'console', from: '', smtp: {} }, sms: { provider: 'console', template: '', twilio: {}, webhook: {} } }), { log: { info: (m) => lines.push(m) }, devAllowed: true });
  assert.equal(dev.email.ready && dev.sms.ready, true);
  await dev.email.send({ to: 'a@x.example', code: '123456', purpose: 'login' });
  assert.match(lines[0], /\[development\] e-mail code for a@x.example \(login\): 123456/);
  const live = createProviders(cfg({ email: { provider: 'console', from: '', smtp: {} }, sms: { provider: 'console', template: '', twilio: {}, webhook: {} } }), { log: { info: (m) => lines.push(m) }, devAllowed: false });
  assert.equal(live.email.ready || live.sms.ready, false);
  assert.equal(live.problems.length, 2);
  await assert.rejects(live.email.send({ to: 'a@x.example', code: '1', purpose: 'login' }));
  assert.equal(lines.length, 1, 'nothing was printed for the refused one');
});

// -------------------------------------------------------------------------------------------- reading .env
test('.env: secrets are kept out of the settings that get listed, logged or sent; short secrets are not used', () => {
  const env = {
    AUTH_SECRET: 'x'.repeat(40), AUTH_ADMIN_TOKEN: 'a'.repeat(40), AUTH_SMTP_PASS: 'smtp-secret', AUTH_TWILIO_AUTH_TOKEN: 'twilio-secret', AUTH_SMS_WEBHOOK_TOKEN: 'hook-secret',
    ZOHO_CLIENT_SECRET: 'zoho-secret', ZOHO_REFRESH_TOKEN: 'zoho-refresh', AUTH_EMAIL_PROVIDER: 'smtp', AUTH_SMTP_HOST: 'smtp.zoho.in', AUTH_SMTP_PORT: '587', ZOHO_DC: 'in', AUTH_GOOGLE_CLIENT_ID: '12345-abc.apps.googleusercontent.com',
  };
  const s = loadSettings('/nonexistent/x.env', env, '/nonexistent');
  for (const secret of ['xxxx', 'aaaa', 'smtp-secret', 'twilio-secret', 'hook-secret', 'zoho-secret', 'zoho-refresh']) {
    assert.equal(JSON.stringify(s).includes(secret), false, `${secret} is not in the settings as listed`);
    assert.equal(JSON.stringify({ ...s }).includes(secret), false);
    assert.equal(String(Object.keys(s)).includes('authSecrets'), false);
  }
  const merged = authConfig(s);
  assert.equal(merged.secret, 'x'.repeat(40));
  assert.equal(merged.providers.email.smtp.pass, 'smtp-secret');
  assert.equal(merged.providers.email.smtp.secure, 'starttls', 'port 587 means STARTTLS unless said otherwise');
  assert.equal(merged.zoho.refreshToken, 'zoho-refresh');
  assert.equal(merged.googleClientId, '12345-abc.apps.googleusercontent.com');
  assert.equal(authConfig(loadSettings('/nonexistent/x.env', { AUTH_SMTP_PORT: '465', AUTH_SMTP_HOST: 'h' }, '/nonexistent')).providers.email.smtp.secure, 'tls');

  const weak = loadSettings('/nonexistent/x.env', { AUTH_SECRET: 'short', AUTH_ADMIN_TOKEN: 'short', AUTH_GOOGLE_CLIENT_ID: 'not-a-client-id', AUTH_EMAIL_PROVIDER: 'carrier-pigeon' }, '/nonexistent');
  assert.equal(authConfig(weak).secret, '');
  assert.equal(authConfig(weak).adminToken, '');
  assert.equal(weak.auth.googleClientId, '');
  assert.equal(weak.auth.email.provider, 'off');
  assert.ok(weak.warnings.some((w) => /AUTH_SECRET is shorter/.test(w)));
  assert.ok(weak.warnings.some((w) => /AUTH_ADMIN_TOKEN is shorter/.test(w)));
  assert.ok(weak.warnings.some((w) => /AUTH_GOOGLE_CLIENT_ID does not look/.test(w)));
  assert.ok(weak.warnings.some((w) => /carrier-pigeon/.test(w)));
  const defaults = loadSettings('/nonexistent/x.env', {}, '/nonexistent');
  assert.deepEqual([defaults.auth.required, defaults.auth.store, defaults.auth.crm, defaults.auth.cookieSecure], [true, 'auto', 'zoho', 'auto'], 'secure by default');
  assert.equal(readAuthEnv((k) => (k === 'AUTH_REQUIRED' ? 'off' : ''), []).pub.required, false);
  assert.deepEqual(['127.0.0.1', '::1', 'localhost', '0.0.0.0', '10.0.0.5', ''].map(isLoopbackHost), [true, true, true, false, false, false]);
});
