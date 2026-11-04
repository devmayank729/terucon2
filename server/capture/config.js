/**
 * Settings for "capture from a phone": read from .env (and the real environment, which wins). Nothing secret is in `pub`; the one
 * secret (the WhatsApp Business token) is in `secrets`, which settings.js keeps in a property that is not enumerable, so it is never
 * printed, logged or sent to a page.
 *
 *   CAPTURE                      on (default) / off
 *   CAPTURE_STORE                auto (default: the studio's MongoDB when the studio is mounted, else memory) / mongo / memory. Memory is for a computer with
 *                                no database (tests, a first look): photos are lost at every restart. With MongoDB chosen or implied and not connected,
 *                                nothing is saved and the pages say so.
 *   CAPTURE_PUBLIC_URL           the address a phone opens, for the QR code and the WhatsApp message, for example https://terucon.example.
 *                                Left out, RENDER_EXTERNAL_URL (set by Render itself) is used. It is never taken from the Host header of a
 *                                request, except on this computer (localhost / a private address), where the page warns that a phone cannot open it.
 *   CAPTURE_SESSION_MINUTES      how long a link works (default 120, 5 to 1440)
 *   CAPTURE_MAX_PHOTOS           photos per link (default 30, 1 to 100)
 *   CAPTURE_MAX_PHOTO_MB         the biggest photo the server takes (default 6, 1 to 10). The phone page shrinks a photo to about 1 MB first.
 *   CAPTURE_KEEP_DAYS            how long a photo is kept before it is deleted by itself (default 30, 1 to 365)
 *   CAPTURE_DEFAULT_COUNTRY_CODE the country code added to a WhatsApp number typed without one (default 91)
 *   CAPTURE_LIMIT_SESSIONS       new links per account per hour (default 20)
 *   CAPTURE_LIMIT_UPLOADS        photos per network address per hour (default 300; a phone network shares addresses)
 *   CAPTURE_LIMIT_WHATSAPP       WhatsApp messages sent by the server per account per hour (default 10)
 *   WHATSAPP_TOKEN               the WhatsApp Business Cloud API token (secret)
 *   WHATSAPP_PHONE_NUMBER_ID     the business phone number's id (from Meta's dashboard)
 *   WHATSAPP_API_VERSION         the Graph API version in the address (default v23.0; Meta's examples differ, check the dashboard)
 *   WHATSAPP_TEMPLATE_PHOTO      the approved template that tells the requester a photo arrived (3 variables: who, how many, where)
 *   WHATSAPP_TEMPLATE_LINK       the approved template that sends the link to a number (3 variables: from, link, minutes). Optional: without it
 *                                "send on WhatsApp" opens the requester's own WhatsApp with the message ready (wa.me), which needs no account.
 *   WHATSAPP_TEMPLATE_LANG       the templates' language code (default en)
 */

export const CAPTURE_DEFAULTS = {
  enabled: true,
  publicUrl: '',
  sessionMinutes: 120,
  maxPhotos: 30,
  maxPhotoBytes: 6 * 1024 * 1024,
  keepDays: 30,
  store: 'auto',
  defaultCountryCode: '91',
  limitSessions: 20,
  limitUploads: 300,
  limitWhatsapp: 10,
};

const TRUE = new Set(['1', 'true', 'yes', 'on', 'y']);
const FALSE = new Set(['0', 'false', 'no', 'off', 'n']);
const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function flag(value, fallback) {
  const v = String(value ?? '').trim().toLowerCase();
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  return fallback;
}

function int(value, fallback, lo, hi) {
  const text = String(value ?? '').trim();
  if (!FLOAT.test(text)) return fallback;
  return Math.max(lo, Math.min(hi, Math.trunc(Number(text))));
}

/** Private and loopback hosts: the ones where a phone cannot open the address (or only on the same network). */
export function isLocalHostname(hostname) {
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * An address written in .env -> its origin ("https://host" or "https://host:port"), or null. No user name, no password, no path, no query.
 * http is accepted only for a local host (a phone on the same network, in development).
 */
export function parsePublicUrl(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && isLocalHostname(url.hostname)) return url.origin;
  return null;
}

/**
 * @param {(key: string, fallback?: string) => string} get
 * @param {string[]} warnings
 * @returns {{pub: object, secrets: {whatsappToken: string}}}
 */
export function readCaptureEnv(get, warnings) {
  const pub = { ...CAPTURE_DEFAULTS };
  pub.enabled = flag(get('CAPTURE'), CAPTURE_DEFAULTS.enabled);

  const configured = get('CAPTURE_PUBLIC_URL');
  const render = get('RENDER_EXTERNAL_URL');
  const fromConfigured = parsePublicUrl(configured);
  if (configured && !fromConfigured) warnings.push('CAPTURE_PUBLIC_URL must look like https://your-site.example (no path; http only for this computer or a private address): it is ignored.');
  pub.publicUrl = fromConfigured ?? parsePublicUrl(render) ?? '';
  pub.publicUrlFrom = fromConfigured ? 'CAPTURE_PUBLIC_URL' : pub.publicUrl ? 'RENDER_EXTERNAL_URL' : '';

  const store = get('CAPTURE_STORE', 'auto').toLowerCase();
  if (['auto', 'mongo', 'memory'].includes(store)) pub.store = store;
  else warnings.push('CAPTURE_STORE must be auto, mongo or memory: auto is used.');

  pub.sessionMinutes = int(get('CAPTURE_SESSION_MINUTES'), CAPTURE_DEFAULTS.sessionMinutes, 5, 1440);
  pub.maxPhotos = int(get('CAPTURE_MAX_PHOTOS'), CAPTURE_DEFAULTS.maxPhotos, 1, 100);
  pub.maxPhotoBytes = int(get('CAPTURE_MAX_PHOTO_MB'), CAPTURE_DEFAULTS.maxPhotoBytes / 1048576, 1, 10) * 1048576;
  pub.keepDays = int(get('CAPTURE_KEEP_DAYS'), CAPTURE_DEFAULTS.keepDays, 1, 365);
  const cc = get('CAPTURE_DEFAULT_COUNTRY_CODE', CAPTURE_DEFAULTS.defaultCountryCode).replace(/^\+/, '');
  if (/^[1-9]\d{0,3}$/.test(cc)) pub.defaultCountryCode = cc;
  else warnings.push('CAPTURE_DEFAULT_COUNTRY_CODE must be digits such as 91: 91 is used.');
  pub.limitSessions = int(get('CAPTURE_LIMIT_SESSIONS'), CAPTURE_DEFAULTS.limitSessions, 1, 10000);
  pub.limitUploads = int(get('CAPTURE_LIMIT_UPLOADS'), CAPTURE_DEFAULTS.limitUploads, 1, 100000);
  pub.limitWhatsapp = int(get('CAPTURE_LIMIT_WHATSAPP'), CAPTURE_DEFAULTS.limitWhatsapp, 0, 1000);

  const token = get('WHATSAPP_TOKEN');
  const phoneNumberId = get('WHATSAPP_PHONE_NUMBER_ID');
  const version = get('WHATSAPP_API_VERSION', 'v23.0');
  const templatePhoto = get('WHATSAPP_TEMPLATE_PHOTO');
  const templateLink = get('WHATSAPP_TEMPLATE_LINK');
  const lang = get('WHATSAPP_TEMPLATE_LANG', 'en');
  const wa = { phoneNumberId: '', version: 'v23.0', templatePhoto: '', templateLink: '', lang: 'en', problem: '' };
  if (phoneNumberId && !/^\d{5,25}$/.test(phoneNumberId)) warnings.push('WHATSAPP_PHONE_NUMBER_ID must be the number-only id from Meta (digits): WhatsApp messages from the server stay off.');
  else wa.phoneNumberId = phoneNumberId;
  if (/^v\d{1,2}\.\d$/.test(version)) wa.version = version;
  else warnings.push('WHATSAPP_API_VERSION must look like v23.0: v23.0 is used.');
  for (const [name, value, key] of [['WHATSAPP_TEMPLATE_PHOTO', templatePhoto, 'templatePhoto'], ['WHATSAPP_TEMPLATE_LINK', templateLink, 'templateLink']]) {
    if (value && !/^[a-z0-9_]{1,512}$/.test(value)) warnings.push(`${name} must be a template name (lower-case letters, digits, underscores): it is ignored.`);
    else wa[key] = value;
  }
  if (/^[a-z]{2}(_[A-Z]{2})?$/.test(lang)) wa.lang = lang;
  else warnings.push('WHATSAPP_TEMPLATE_LANG must be a language code such as en or en_US: en is used.');
  if (token && token.length > 1000) warnings.push('WHATSAPP_TOKEN is far longer than an access token: it is not used.');
  const usableToken = token && token.length <= 1000 ? token : '';
  if ((usableToken || wa.phoneNumberId) && !(usableToken && wa.phoneNumberId)) wa.problem = 'WhatsApp from the server needs both WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID.';
  pub.whatsapp = wa;
  return { pub, secrets: { whatsappToken: usableToken } };
}

/** The settings the capture code reads, combined (the secret is not part of `pub`). */
export function captureConfig(settings) {
  return { ...settings.capture, whatsappToken: settings.captureSecrets?.whatsappToken ?? '' };
}

/** Lines for the start-up banner. No secrets. */
export function describeCapture(settings) {
  const c = settings.capture;
  if (!c.enabled) return ['Capture from a phone: off (CAPTURE=off)'];
  const wa = c.whatsapp;
  const cloud = Boolean(settings.captureSecrets?.whatsappToken && wa.phoneNumberId);
  return [
    `Capture from a phone: on - links last ${c.sessionMinutes} minutes, up to ${c.maxPhotos} photos each, photos kept ${c.keepDays} days${c.store === 'memory' ? ' IN MEMORY ONLY (CAPTURE_STORE=memory: lost at every restart, development only)' : ' in the studio\'s MongoDB'}`,
    c.publicUrl
      ? `Capture link address: ${c.publicUrl} (from ${c.publicUrlFrom})`
      : 'Capture link address: NOT SET - set CAPTURE_PUBLIC_URL to the address a phone opens; until then the link uses the address of the page that asks for it, which a phone can only open on the same network',
    cloud
      ? `WhatsApp from the server: configured (${wa.templatePhoto ? 'photo alert template set' : 'no photo alert template: alerts stay off'}; ${wa.templateLink ? 'link template set' : 'no link template: the link opens WhatsApp for the requester to send'})`
      : 'WhatsApp from the server: not configured - the link is sent through the requester\'s own WhatsApp (wa.me), and there is no WhatsApp alert when a photo arrives',
  ];
}
