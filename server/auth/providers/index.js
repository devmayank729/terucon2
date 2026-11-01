/**
 * Turns the .env settings into the two senders the sign-in code uses:
 *   providers.email.send({to, code, ttlMinutes, purpose})
 *   providers.sms.send({to, code, ttlMinutes, purpose})
 * A sender not named in .env is "auto": the console sender on a computer that only this computer can reach (so `npm start` works while you are trying the site), and none anywhere else. Each has `ready`. A sender that is not set up (or is set up wrongly) is `ready: false`, says why in `providers.problems`, and
 * the sign-in page then simply does not offer that way in. Nothing here ever falls back to something less safe.
 *
 * Choices (AUTH_EMAIL_PROVIDER / AUTH_SMS_PROVIDER)
 *   e-mail  smtp      any SMTP service (server/auth/providers/smtp.js)
 *           console    development only: prints the code in the server window. Refused unless the server listens on this computer only
 *                      and NODE_ENV is not production; a code is never put in a response and never in a log on a real server.
 *   sms     twilio     Twilio's Messages API
 *           webhook    POSTs {to, message, code, purpose, minutes} as JSON to your own URL, which hands it to whatever gateway you use
 *                      (MSG91, Fast2SMS ...). This is how an Indian gateway with its own approved text templates is connected.
 *           console    as above
 */
import { sendSmtp } from './smtp.js';
import { DEFAULT_SMS_TEMPLATE, emailMessage, smsMessage, validSmsTemplate } from './messages.js';

export class ProviderError extends Error {
  constructor(message, { status, transient = true } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.transient = transient;
  }
}

const OFF = (what) => ({ name: 'off', ready: false, async send() { throw new ProviderError(`No ${what} service is set up.`, { transient: false }); } });
const LOCAL_URL = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/;
const FROM = /^(?:[A-Za-z0-9 ._'-]{1,60} )?<[^<>\s@]+@[^<>\s@]+\.[A-Za-z]{2,}>$|^[^<>\s@]+@[^<>\s@]+\.[A-Za-z]{2,}$/;

function consoleSender(kind, log) {
  return {
    name: 'console',
    ready: true,
    dev: true,
    async send({ to, code, purpose }) {
      log.info(`auth  [development] ${kind} code for ${to} (${purpose}): ${code}`);
    },
  };
}

export function smtpSender({ host, port, secure, user, pass, from }, { send = sendSmtp, tlsOptions } = {}) {
  return {
    name: 'smtp',
    ready: true,
    async send({ to, code, ttlMinutes, purpose }) {
      const { subject, text } = emailMessage({ code, ttlMinutes, purpose });
      await send({ host, port, secure, user, pass, from, to, subject, text, tlsOptions });
    },
  };
}

export function twilioSender({ accountSid, authToken, from, messagingServiceSid, template }, { fetch = globalThis.fetch } = {}) {
  return {
    name: 'twilio',
    ready: true,
    async send({ to, code, ttlMinutes }) {
      const form = new URLSearchParams({ To: to, Body: smsMessage({ code, ttlMinutes, template }) });
      if (messagingServiceSid) form.set('MessagingServiceSid', messagingServiceSid);
      else form.set('From', from);
      let response;
      try {
        response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
          method: 'POST',
          headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: form,
          signal: AbortSignal.timeout(10000),
        });
      } catch (error) {
        throw new ProviderError(`Twilio could not be reached (${error.name}).`);
      }
      if (response.status !== 201) throw new ProviderError(`Twilio answered ${response.status}.`, { status: response.status, transient: response.status >= 500 || response.status === 429 });
    },
  };
}

export function webhookSmsSender({ url, token, template }, { fetch = globalThis.fetch } = {}) {
  return {
    name: 'webhook',
    ready: true,
    async send({ to, code, ttlMinutes, purpose }) {
      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
          body: JSON.stringify({ to, message: smsMessage({ code, ttlMinutes, template }), code, purpose, minutes: ttlMinutes }),
          signal: AbortSignal.timeout(10000),
        });
      } catch (error) {
        throw new ProviderError(`The SMS webhook could not be reached (${error.name}).`);
      }
      if (!response.ok) throw new ProviderError(`The SMS webhook answered ${response.status}.`, { status: response.status, transient: response.status >= 500 || response.status === 429 });
    },
  };
}

/**
 * @param {object} config `settings.auth` merged with `settings.authSecrets` (server/config/settings.js)
 * @param {object} options
 * @param {{info: Function}} options.log
 * @param {boolean} options.devAllowed the console senders may be used (server on this computer only, not production)
 * @param {Function} [options.fetch] @param {Function} [options.smtpSend] @param {object} [options.tlsOptions] for tests
 * @returns {{email: ReturnType<typeof smtpSender>, sms: ReturnType<typeof twilioSender>, problems: string[]}}
 */
export function createProviders(config, { log, devAllowed, fetch, smtpSend, tlsOptions } = {}) {
  const problems = [];
  let email = OFF('e-mail');
  let sms = OFF('text-message');

  switch (config.email.provider) {
    case 'off':
      break;
    case 'auto': // not chosen: the console sender where that is safe (this computer only), nothing anywhere else
      if (devAllowed) email = consoleSender('e-mail', log);
      break;
    case 'console':
      if (devAllowed) email = consoleSender('e-mail', log);
      else problems.push('AUTH_EMAIL_PROVIDER=console is only for development: it is refused unless the server listens on this computer only and NODE_ENV is not "production". No e-mail codes can be sent.');
      break;
    case 'smtp': {
      const s = config.email.smtp;
      if (!s.host || !s.port) problems.push('AUTH_EMAIL_PROVIDER=smtp needs AUTH_SMTP_HOST and AUTH_SMTP_PORT.');
      else if (!['tls', 'starttls', 'none'].includes(s.secure)) problems.push('AUTH_SMTP_SECURE must be tls (port 465), starttls (port 587) or none (this computer only).');
      else if (!FROM.test(config.email.from)) problems.push('AUTH_EMAIL_FROM must look like  Terucon <no-reply@your-domain>  (plain ASCII).');
      else if (s.user && !s.pass) problems.push('AUTH_SMTP_USER is set without AUTH_SMTP_PASS.');
      else email = smtpSender({ ...s, from: config.email.from }, { send: smtpSend, tlsOptions });
      break;
    }
    default:
      problems.push(`AUTH_EMAIL_PROVIDER=${String(config.email.provider).slice(0, 20)} is not one of: off, smtp, console.`);
  }

  const template = config.sms.template || DEFAULT_SMS_TEMPLATE;
  if (config.sms.provider !== 'off' && config.sms.provider !== 'auto' && !validSmsTemplate(template)) {
    problems.push('AUTH_SMS_TEMPLATE must contain {code} and be one short plain line.');
  } else {
    switch (config.sms.provider) {
      case 'off':
        break;
      case 'auto':
        if (devAllowed) sms = consoleSender('text-message', log);
        break;
      case 'console':
        if (devAllowed) sms = consoleSender('text-message', log);
        else problems.push('AUTH_SMS_PROVIDER=console is only for development (see AUTH_EMAIL_PROVIDER=console). No text-message codes can be sent.');
        break;
      case 'twilio': {
        const t = config.sms.twilio;
        if (!/^AC[0-9a-f]{32}$/i.test(t.accountSid) || !t.authToken) problems.push('AUTH_SMS_PROVIDER=twilio needs AUTH_TWILIO_ACCOUNT_SID (AC...) and AUTH_TWILIO_AUTH_TOKEN.');
        else if (!/^\+[1-9]\d{7,14}$/.test(t.from) && !/^MG[0-9a-f]{32}$/i.test(t.messagingServiceSid)) problems.push('AUTH_SMS_PROVIDER=twilio needs AUTH_TWILIO_FROM (a number like +14155550100) or AUTH_TWILIO_MESSAGING_SERVICE_SID (MG...).');
        else sms = twilioSender({ ...t, template }, { fetch });
        break;
      }
      case 'webhook': {
        const w = config.sms.webhook;
        if (!/^https:\/\//.test(w.url) && !LOCAL_URL.test(w.url)) problems.push('AUTH_SMS_PROVIDER=webhook needs AUTH_SMS_WEBHOOK_URL starting with https:// (http:// only for this computer).');
        else sms = webhookSmsSender({ ...w, template }, { fetch });
        break;
      }
      default:
        problems.push(`AUTH_SMS_PROVIDER=${String(config.sms.provider).slice(0, 20)} is not one of: off, twilio, webhook, console.`);
    }
  }
  return { email, sms, problems };
}
