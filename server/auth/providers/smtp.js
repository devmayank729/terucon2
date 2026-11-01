/**
 * A small SMTP client for one job: send one plain-text message to one recipient (a one-time code). Works with any SMTP service
 * (Zoho Mail / ZeptoMail, Amazon SES, Brevo, SendGrid, Gmail with an app password ...). No dependency.
 *
 * What it will not do, on purpose:
 *   - send credentials or a code over an unencrypted connection to a host that is not this computer (`secure: 'none'` is refused);
 *   - skip certificate checks (a server certificate that does not match the host fails the send);
 *   - carry anything the caller typed into a header. The recipient must be a plain address (no CR, LF, angle brackets or spaces)
 *     and the subject and body come from fixed templates plus digits, so a header or a second recipient cannot be injected;
 *   - go on after a bad reply, or hang: every step has a deadline.
 *
 * secure: 'tls'       the connection is encrypted from the start (port 465)
 *         'starttls'  plain greeting, then upgraded before anything private is sent (port 587); refused if the server cannot upgrade
 *         'none'      no encryption: only to localhost, for development and tests
 */
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

const LOCAL = new Set(['localhost', '127.0.0.1', '::1']);
const ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[A-Za-z0-9.-]{1,253}$/;

export class SmtpError extends Error {
  constructor(message, { code, transient } = {}) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
    this.transient = transient ?? (typeof code === 'number' && code >= 400 && code < 500);
  }
}

/** Reads SMTP replies (one or many lines, "250-..." until "250 ...") from a socket, one promise per reply. */
function replyReader(socket) {
  let buffer = '';
  let failure = null;
  const waiting = [];

  const take = () => {
    const lines = [];
    let rest = buffer;
    for (;;) {
      const end = rest.indexOf('\r\n');
      if (end === -1) return null;
      const line = rest.slice(0, end);
      rest = rest.slice(end + 2);
      lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        buffer = rest;
        return { code: Number(line.slice(0, 3)), lines };
      }
      if (!/^\d{3}-/.test(line)) throw new SmtpError('The mail server sent something that is not an SMTP reply.');
    }
  };
  const pump = () => {
    while (waiting.length) {
      let reply;
      try {
        reply = take();
      } catch (error) {
        failure = error;
        break;
      }
      if (!reply) break;
      waiting.shift().resolve(reply);
    }
    if (failure) for (const w of waiting.splice(0)) w.reject(failure);
  };
  const onData = (chunk) => {
    buffer += chunk.toString('latin1');
    if (buffer.length > 64 * 1024) failure = new SmtpError('The mail server sent too much.');
    pump();
  };
  const fail = (error) => {
    failure ??= error;
    for (const w of waiting.splice(0)) w.reject(failure);
  };
  const onError = (error) => fail(new SmtpError(`Connection problem: ${error.code ?? error.message}`, { transient: true }));
  const onClose = () => fail(new SmtpError('The mail server closed the connection.', { transient: true }));
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);

  return {
    next() {
      return new Promise((resolve, reject) => {
        if (failure) return reject(failure);
        waiting.push({ resolve, reject });
        pump();
      });
    },
    detach() {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    },
  };
}

/** Dot-stuff and CRLF-normalise a message body for the DATA command. */
function dataBlock(text) {
  return text
    .replace(/\r?\n/g, '\r\n')
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

/**
 * @param {object} o
 * @param {string} o.host @param {number} o.port @param {'tls' | 'starttls' | 'none'} o.secure
 * @param {string} [o.user] @param {string} [o.pass]
 * @param {string} o.from "name <a@b.c>" or "a@b.c"  @param {string} o.to a plain address
 * @param {string} o.subject @param {string} o.text
 * @param {number} [o.timeoutMs] for the whole send
 * @param {object} [o.tlsOptions] extra tls.connect options (tests pass their own CA)
 */
export async function sendSmtp({ host, port, secure, user, pass, from, to, subject, text, timeoutMs = 20000, tlsOptions = {} }) {
  const fromAddress = /<([^<>\s]+)>\s*$/.exec(from)?.[1] ?? from;
  if (!ADDRESS.test(to) || !ADDRESS.test(fromAddress)) throw new SmtpError('The sender or recipient is not a plain e-mail address.', { transient: false });
  // the subject and sender are one printable ASCII line; the body is printable ASCII with line breaks (CRLF or LF) and nothing else
  const body = text.replace(/\r\n/g, '\n');
  if (!/^[\x20-\x7e]*$/.test(from + subject) || !/^[\x20-\x7e\n]*$/.test(body)) throw new SmtpError('The message may only contain plain ASCII text.', { transient: false });
  if (secure === 'none' && !LOCAL.has(host)) throw new SmtpError('Refusing to send over an unencrypted connection to a remote mail server.', { transient: false });

  let socket;
  const deadline = setTimeout(() => socket?.destroy(new Error('timeout')), timeoutMs);
  try {
    socket = secure === 'tls' ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, ...tlsOptions }) : net.connect({ host, port });
    let reader = replyReader(socket);
    const expect = async (codes, what) => {
      const reply = await reader.next();
      if (!codes.includes(reply.code)) throw new SmtpError(`The mail server refused ${what} (${reply.code}).`, { code: reply.code });
      return reply;
    };
    const command = async (line, codes, what) => {
      socket.write(`${line}\r\n`);
      return expect(codes, what);
    };
    const hello = `[${net.isIP(host) ? host : '127.0.0.1'}]`;

    await expect([220], 'the connection');
    let caps = (await command(`EHLO ${hello}`, [250], 'EHLO')).lines.map((l) => l.slice(4).toUpperCase());
    if (secure === 'starttls') {
      if (!caps.some((c) => c === 'STARTTLS')) throw new SmtpError('The mail server does not offer STARTTLS; not sending without encryption.', { transient: false });
      await command('STARTTLS', [220], 'STARTTLS');
      reader.detach();
      socket = tls.connect({ socket, host, servername: net.isIP(host) ? undefined : host, ...tlsOptions }); // `host` is what the certificate is checked against
      reader = replyReader(socket);
      await new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', reject);
      });
      caps = (await command(`EHLO ${hello}`, [250], 'EHLO')).lines.map((l) => l.slice(4).toUpperCase());
    }
    if (user) {
      if (caps.some((c) => c.startsWith('AUTH') && /\bPLAIN\b/.test(c))) {
        await command(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass ?? ''}`).toString('base64')}`, [235], 'the login');
      } else if (caps.some((c) => c.startsWith('AUTH') && /\bLOGIN\b/.test(c))) {
        await command('AUTH LOGIN', [334], 'the login');
        await command(Buffer.from(user).toString('base64'), [334], 'the login');
        await command(Buffer.from(pass ?? '').toString('base64'), [235], 'the login');
      } else {
        throw new SmtpError('The mail server offers no login method this client can use.', { transient: false });
      }
    }
    await command(`MAIL FROM:<${fromAddress}>`, [250], 'the sender');
    await command(`RCPT TO:<${to}>`, [250, 251], 'the recipient');
    await command('DATA', [354], 'the message');
    const domain = fromAddress.split('@')[1];
    const message = [
      `From: ${from}`,
      `To: <${to}>`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
      `Message-ID: <${crypto.randomBytes(16).toString('hex')}@${domain}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=us-ascii',
      'Content-Transfer-Encoding: 7bit',
      'Auto-Submitted: auto-generated',
      '',
      dataBlock(body),
    ].join('\r\n');
    socket.write(`${message}\r\n.\r\n`);
    await expect([250], 'the message');
    await new Promise((resolve) => socket.write('QUIT\r\n', resolve)); // polite, and flushed before the socket is closed below
  } catch (error) {
    if (error instanceof SmtpError) throw error;
    throw new SmtpError(`Could not reach the mail server: ${error.code ?? error.message}`, { transient: true });
  } finally {
    clearTimeout(deadline);
    socket?.destroy();
  }
}
