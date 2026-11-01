/**
 * What the catalogue search reads from .env / the real environment, in one place. Read by server/config/settings.js (so it follows
 * .env edits like every other setting) and turned into the one flat shape the rest of server/catalogue/ uses. The contract is
 * catalogue/ARCHITECTURE.md, sections 7 and 8.
 *
 * Secrets (CATALOGUE_MODAL_KEY and the optional Modal proxy key and secret) are kept in `settings.catalogueSecrets`, a property that
 * does not show up when settings are listed, spread, printed or turned into JSON, exactly like the sign-in's secrets, so they cannot
 * end up in the banner, a log line or a response by accident. The non-secret half is `settings.catalogue`.
 *
 * With none of the variables set the feature is simply not set up: no warning is produced (the banner line says what is missing);
 * a warning is produced only for a value that is there and wrong.
 *
 * Limits an admin may want to change at run time (searches per hour, how many run at once) are NOT here: they are bounded settings
 * in the database (server/auth/settings.js, `catalogue.*`), changed through the admin API.
 */
import path from 'node:path';

const TRUE = new Set(['1', 'true', 'yes', 'on', 'y']);
const FALSE = new Set(['0', 'false', 'no', 'off', 'n']);
const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export const SEARCH_PROFILES = ['fast', 'balanced', 'full'];
export const DEFAULT_PREFIX = 'catalogue/';
/** The biggest query photo the site takes (the browser sends about 100-400 KB; Modal takes at most 8 MB). */
export const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
/** The long side the browser shrinks every query photo to. */
export const BROWSER_MAX_SIDE = 1024;
/** Starting values for the admin-managed limits (server/auth/settings.js). Chosen, not measured. */
export const LIMIT_DEFAULTS = Object.freeze({ searchPerHour: 60, textPerHour: 120, warmPerHour: 30, perAddress: 4, maxConcurrent: 6 });

const BUCKET = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;
const PREFIX = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,98}$/;
// visible ASCII only: a key with a space or a line break in it would be a header-injection hole
const SECRET = /^[\x21-\x7e]{8,512}$/;

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

/**
 * A Modal app's address: https, or http on this computer for the tests and the dev stack. No user name or password, no query, no
 * fragment (a key in an address ends up in logs). Returned without a trailing slash; '' when blank or not acceptable.
 */
function modalUrl(raw, name, warnings) {
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    warnings.push(`${name} is not an address: the catalogue cannot use it.`);
    return '';
  }
  const local = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if (url.protocol !== 'https:' && !local) {
    warnings.push(`${name} must start with https:// : the catalogue cannot use it.`);
    return '';
  }
  if (url.username || url.password || url.search || url.hash) {
    warnings.push(`${name} must be a plain address, with no user name, password, query or fragment: the catalogue cannot use it.`);
    return '';
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function secret(raw, name, warnings) {
  if (!raw) return '';
  if (!SECRET.test(raw)) {
    warnings.push(`${name} must be 8 to 512 visible characters with no spaces: it is not used.`);
    return '';
  }
  return raw;
}

/** 'catalogue/' for blank, otherwise the prefix with exactly one trailing slash; null when it is not a safe prefix. */
function prefixOf(raw) {
  const text = (raw || DEFAULT_PREFIX).trim();
  const withSlash = text.endsWith('/') ? text : `${text}/`;
  if (!PREFIX.test(withSlash.slice(0, -1)) || withSlash.includes('//') || withSlash.split('/').some((part) => part === '..' || part === '.')) return null;
  return withSlash;
}

/**
 * @param {(key: string, fallback?: string) => string} get reads a trimmed variable
 * @param {string[]} warnings
 * @param {string} root the project folder, for a relative key-file path
 * @returns {{pub: object, secrets: object}}
 */
export function readCatalogueEnv(get, warnings, root) {
  const rawSwitch = get('CATALOGUE');
  if (rawSwitch && !TRUE.has(rawSwitch.toLowerCase()) && !FALSE.has(rawSwitch.toLowerCase())) warnings.push(`CATALOGUE=${rawSwitch.slice(0, 20)} is not on or off: the catalogue stays on.`);

  const modalKey = secret(get('CATALOGUE_MODAL_KEY'), 'CATALOGUE_MODAL_KEY', warnings);
  const proxyKey = secret(get('CATALOGUE_MODAL_PROXY_KEY'), 'CATALOGUE_MODAL_PROXY_KEY', warnings);
  const proxySecret = secret(get('CATALOGUE_MODAL_PROXY_SECRET'), 'CATALOGUE_MODAL_PROXY_SECRET', warnings);
  if (Boolean(get('CATALOGUE_MODAL_PROXY_KEY')) !== Boolean(get('CATALOGUE_MODAL_PROXY_SECRET'))) warnings.push('CATALOGUE_MODAL_PROXY_KEY and CATALOGUE_MODAL_PROXY_SECRET go together: neither is sent until both are set.');

  let bucket = get('CATALOGUE_GCS_BUCKET');
  let gcsProblem = '';
  if (bucket && !BUCKET.test(bucket)) {
    warnings.push('CATALOGUE_GCS_BUCKET is not a bucket name (lower-case letters, digits, dots, dashes, underscores): pictures cannot be signed.');
    gcsProblem = 'bucket';
    bucket = '';
  }
  const prefix = prefixOf(get('CATALOGUE_GCS_PREFIX'));
  if (prefix === null) {
    warnings.push('CATALOGUE_GCS_PREFIX must be a folder-like name such as catalogue/ (letters, digits, dots, dashes, underscores and slashes; no "..", no leading slash): pictures cannot be signed.');
    gcsProblem ||= 'prefix';
  }
  const keyFile = get('CATALOGUE_GCS_KEY_FILE') ? path.resolve(root, get('CATALOGUE_GCS_KEY_FILE')) : '';

  const profileRaw = get('CATALOGUE_SEARCH_PROFILE').toLowerCase();
  if (profileRaw && !SEARCH_PROFILES.includes(profileRaw)) warnings.push(`CATALOGUE_SEARCH_PROFILE=${profileRaw.slice(0, 20)} is not one of ${SEARCH_PROFILES.join(', ')}: fast is used.`);

  return {
    pub: {
      enabled: flag(rawSwitch, true),
      modal: {
        searchUrl: modalUrl(get('CATALOGUE_MODAL_SEARCH_URL'), 'CATALOGUE_MODAL_SEARCH_URL', warnings),
        ingestUrl: modalUrl(get('CATALOGUE_MODAL_INGEST_URL'), 'CATALOGUE_MODAL_INGEST_URL', warnings),
        // a floor of 200 ms is only there so a test of the slow-start path does not have to wait; a real cold start takes tens of seconds
        timeoutMs: int(get('CATALOGUE_MODAL_TIMEOUT_MS'), 60000, 200, 300000),
        proxy: Boolean(proxyKey && proxySecret),
      },
      gcs: { bucket, prefix: prefix ?? DEFAULT_PREFIX, keyFile, problem: gcsProblem },
      profile: SEARCH_PROFILES.includes(profileRaw) ? profileRaw : 'fast',
    },
    secrets: { modalKey, proxyKey: proxyKey && proxySecret ? proxyKey : '', proxySecret: proxyKey && proxySecret ? proxySecret : '' },
  };
}

/** The flat shape the rest of server/catalogue/ reads, from settings.catalogue and settings.catalogueSecrets. */
export function catalogueConfig(settings) {
  const c = settings.catalogue ?? {};
  const m = c.modal ?? {};
  const g = c.gcs ?? {};
  const s = settings.catalogueSecrets ?? {};
  return {
    switchedOn: c.enabled !== false,
    searchUrl: m.searchUrl ?? '',
    ingestUrl: m.ingestUrl ?? '',
    timeoutMs: m.timeoutMs ?? 60000,
    key: s.modalKey ?? '',
    proxyKey: s.proxyKey ?? '',
    proxySecret: s.proxySecret ?? '',
    bucket: g.bucket ?? '',
    prefix: g.prefix ?? DEFAULT_PREFIX,
    keyFile: g.keyFile ?? '',
    gcsProblem: g.problem ?? '',
    profile: c.profile ?? 'fast',
  };
}

/** What is set up, as booleans. `enabled` means the switch is on and the search app can be reached; the rest is checked when it is used. */
export function configured(cfg) {
  const modalSearch = Boolean(cfg.searchUrl && cfg.key);
  const modalIngest = Boolean(cfg.ingestUrl && cfg.key);
  const gcs = Boolean(cfg.bucket && cfg.keyFile && !cfg.gcsProblem);
  return { switchedOn: cfg.switchedOn, modalSearch, modalIngest, gcs, enabled: cfg.switchedOn && modalSearch };
}

/** The names a person still has to put in .env for searching to work, in the order the example file lists them. */
export function missingForSearch(cfg) {
  const missing = [];
  if (!cfg.searchUrl) missing.push('CATALOGUE_MODAL_SEARCH_URL');
  if (!cfg.key) missing.push('CATALOGUE_MODAL_KEY');
  if (!cfg.bucket) missing.push('CATALOGUE_GCS_BUCKET');
  if (!cfg.keyFile) missing.push('CATALOGUE_GCS_KEY_FILE');
  return missing;
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return '?';
  }
};

/** Start-up banner lines. Contains no secrets: only host names, the bucket name and which names are missing. */
export function describeCatalogue(settings) {
  const cfg = catalogueConfig(settings);
  if (!cfg.switchedOn) return ['Catalogue search: off (CATALOGUE=off); the shop keeps its colour demo'];
  const missing = missingForSearch(cfg);
  if (missing.length) {
    const none = missing.length === 4 && !cfg.ingestUrl;
    return [`Catalogue search: ${none ? 'not set up' : 'NOT READY'}; the shop keeps its colour demo (missing in .env: ${missing.join(', ')})`];
  }
  return [
    `Catalogue search: on; search app ${hostOf(cfg.searchUrl)}, ingest app ${cfg.ingestUrl ? hostOf(cfg.ingestUrl) : 'NOT SET (admin uploads need CATALOGUE_MODAL_INGEST_URL)'}, pictures from bucket ${cfg.bucket} under ${cfg.prefix}, profile ${cfg.profile}${settings.catalogue?.modal?.proxy ? ', Modal proxy auth on' : ''}`,
  ];
}
