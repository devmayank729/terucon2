/**
 * What the sign-in reads from .env / the real environment, in one place. Read by server/config/settings.js (so it follows .env
 * edits like every other setting) and turned into the objects the providers, the CRM and the readiness check expect.
 *
 * Secrets (AUTH_SECRET, the admin token, SMTP password, Twilio token, webhook token, Zoho secret and refresh token) are kept in
 * `settings.authSecrets`, a property that does not show up when settings are listed, spread, printed or turned into JSON, so
 * they cannot end up in the banner, a log line or a response by accident. The non-secret half is `settings.auth`.
 *
 * Everything that is a limit or a switch the admin may reasonably want to change lives in the database settings instead
 * (server/auth/settings.js), not here.
 */

const TRUE = new Set(['1', 'true', 'yes', 'on', 'y']);
const FALSE = new Set(['0', 'false', 'no', 'off', 'n']);

function flag(value, fallback) {
  const v = String(value ?? '').trim().toLowerCase();
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  return fallback;
}

const choice = (value, allowed, fallback) => {
  const v = String(value ?? '').trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
};

export const MIN_SECRET_LENGTH = 32;

/**
 * @param {(key: string, fallback?: string) => string} get reads a trimmed variable
 * @param {string[]} warnings
 * @returns {{pub: object, secrets: object}}
 */
export function readAuthEnv(get, warnings) {
  const port = Number.parseInt(get('AUTH_SMTP_PORT'), 10);
  const smtpPort = Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
  // blank: "auto", which is the console sender on a computer that only this computer can reach (development), and off anywhere else
  const emailProvider = get('AUTH_EMAIL_PROVIDER') ? choice(get('AUTH_EMAIL_PROVIDER'), ['off', 'smtp', 'console'], 'off') : 'auto';
  const smsProvider = get('AUTH_SMS_PROVIDER') ? choice(get('AUTH_SMS_PROVIDER'), ['off', 'twilio', 'webhook', 'console'], 'off') : 'auto';
  if (get('AUTH_EMAIL_PROVIDER') && emailProvider === 'off' && get('AUTH_EMAIL_PROVIDER').toLowerCase() !== 'off') warnings.push(`AUTH_EMAIL_PROVIDER=${get('AUTH_EMAIL_PROVIDER').slice(0, 20)} is not one of off, smtp, console: no e-mail codes can be sent.`);
  if (get('AUTH_SMS_PROVIDER') && smsProvider === 'off' && get('AUTH_SMS_PROVIDER').toLowerCase() !== 'off') warnings.push(`AUTH_SMS_PROVIDER=${get('AUTH_SMS_PROVIDER').slice(0, 20)} is not one of off, twilio, webhook, console: no text-message codes can be sent.`);
  const secure = choice(get('AUTH_SMTP_SECURE'), ['tls', 'starttls', 'none'], smtpPort === 465 ? 'tls' : smtpPort === 587 ? 'starttls' : '');

  const secret = get('AUTH_SECRET');
  const adminToken = get('AUTH_ADMIN_TOKEN');
  if (secret && secret.length < MIN_SECRET_LENGTH) warnings.push(`AUTH_SECRET is shorter than ${MIN_SECRET_LENGTH} characters: it is not used, and sign-in stays off (outside development).`);
  if (adminToken && adminToken.length < MIN_SECRET_LENGTH) warnings.push(`AUTH_ADMIN_TOKEN is shorter than ${MIN_SECRET_LENGTH} characters: the admin API stays off.`);
  const clientId = get('AUTH_GOOGLE_CLIENT_ID');
  if (clientId && !/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(clientId)) warnings.push('AUTH_GOOGLE_CLIENT_ID does not look like a Google OAuth client id (123-abc.apps.googleusercontent.com): Google sign-in stays off.');

  return {
    pub: {
      required: flag(get('AUTH_REQUIRED'), true),
      cookieSecure: choice(get('AUTH_COOKIE_SECURE'), ['auto', 'on', 'off'], 'auto'),
      store: choice(get('AUTH_STORE'), ['auto', 'memory', 'mongo'], 'auto'),
      email: { provider: emailProvider, from: get('AUTH_EMAIL_FROM'), smtp: { host: get('AUTH_SMTP_HOST'), port: smtpPort, secure, user: get('AUTH_SMTP_USER') } },
      sms: {
        provider: smsProvider,
        template: get('AUTH_SMS_TEMPLATE'),
        twilio: { accountSid: get('AUTH_TWILIO_ACCOUNT_SID'), from: get('AUTH_TWILIO_FROM'), messagingServiceSid: get('AUTH_TWILIO_MESSAGING_SERVICE_SID') },
        webhook: { url: get('AUTH_SMS_WEBHOOK_URL') },
      },
      googleClientId: /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(clientId) ? clientId : '',
      crm: choice(get('AUTH_CRM'), ['zoho', 'off'], 'zoho'),
      zoho: { dc: get('ZOHO_DC'), accountsUrl: get('ZOHO_ACCOUNTS_URL'), clientId: get('ZOHO_CLIENT_ID') },
    },
    secrets: {
      secret: secret.length >= MIN_SECRET_LENGTH ? secret : '',
      adminToken: adminToken.length >= MIN_SECRET_LENGTH ? adminToken : '',
      smtpPass: get('AUTH_SMTP_PASS'),
      twilioAuthToken: get('AUTH_TWILIO_AUTH_TOKEN'),
      webhookToken: get('AUTH_SMS_WEBHOOK_TOKEN'),
      zohoClientSecret: get('ZOHO_CLIENT_SECRET'),
      zohoRefreshToken: get('ZOHO_REFRESH_TOKEN'),
    },
  };
}

/** The shapes the providers and the Zoho client take, from settings.auth and settings.authSecrets. */
export function authConfig(settings) {
  const a = settings.auth;
  const s = settings.authSecrets ?? {};
  return {
    required: a.required,
    cookieSecure: a.cookieSecure,
    store: a.store,
    secret: s.secret ?? '',
    adminToken: s.adminToken ?? '',
    googleClientId: a.googleClientId,
    crm: a.crm,
    providers: {
      email: { provider: a.email.provider, from: a.email.from, smtp: { ...a.email.smtp, pass: s.smtpPass ?? '' } },
      sms: { provider: a.sms.provider, template: a.sms.template, twilio: { ...a.sms.twilio, authToken: s.twilioAuthToken ?? '' }, webhook: { ...a.sms.webhook, token: s.webhookToken ?? '' } },
    },
    zoho: { dc: a.zoho.dc, accountsUrl: a.zoho.accountsUrl, clientId: a.zoho.clientId, clientSecret: s.zohoClientSecret ?? '', refreshToken: s.zohoRefreshToken ?? '' },
  };
}

/** A host that only this computer can reach. */
export const isLoopbackHost = (host) => host === '127.0.0.1' || host === '::1' || host === 'localhost';
