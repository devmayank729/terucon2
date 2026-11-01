/**
 * Google Cloud Storage "V4 signed URLs", made with Node's crypto and nothing else (no SDK, no network). The browser loads thumbnails
 * and full pictures straight from Cloud Storage with a signed GET, and the admin's PDF goes from the browser straight to Cloud Storage
 * with a signed PUT, so neither ever passes through this server.
 *
 * How a V4 signature is made (https://cloud.google.com/storage/docs/access-control/signed-urls, and checked against the Google SDK
 * google-cloud-storage 3.17.1 by tests/fixtures/gen-gcs-v4-vectors.py, whose output tests/js/catalogue-signer.test.js reproduces byte
 * for byte):
 *
 *   canonical request  METHOD \n /bucket/object \n sorted-query \n headers (each "name:value\n") \n signed-header-names \n UNSIGNED-PAYLOAD
 *   string to sign     GOOG4-RSA-SHA256 \n 20261101T120000Z \n 20261101/auto/storage/goog4_request \n hex(sha256(canonical request))
 *   signature          hex(RSA PKCS#1 v1.5 with SHA-256 over the string to sign), with the service account's private key
 *   URL                https://storage.googleapis.com/bucket/object?<the same sorted query>&X-Goog-Signature=<signature>
 *
 * The encoding is Python's urllib.parse.quote: everything except letters, digits and _ . - ~ is %XX (upper-case) over the UTF-8 bytes,
 * and an object name keeps its slashes. It is NOT encodeURIComponent, which leaves ! * ' ( ) alone.
 *
 * The service account's JSON key (CATALOGUE_GCS_KEY_FILE) is read once, on first use, and kept parsed. The key is only ever used to
 * sign: it is never logged, printed or sent. Use a separate account that can read and create objects on the one bucket and nothing else.
 *
 * `x-goog-content-length-range` is signed into the upload URL so that Cloud Storage itself refuses a body outside the range. That Google
 * accepts the header in a signed PUT is NOT verified here (nothing in this repo talks to Google); the size check Modal makes when it
 * fetches the upload stays the authority.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

export const HOST = 'storage.googleapis.com';
const ALGORITHM = 'GOOG4-RSA-SHA256';
export const MAX_EXPIRES_S = 7 * 24 * 60 * 60;
const RECHECK_MS = 30 * 1000;
const FAILURE_MS = 10 * 1000;
/** A relative object key this site will sign: no leading slash or dot, no "//", no ".." segment, plain characters. */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,300}$/;
const CONTENT_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

/** Python's urllib.parse.quote(text, safe=<safe> + "~"): the unreserved characters and `safe` stay, every other UTF-8 byte is %XX. */
function quote(text, safe) {
  let out = '';
  for (const byte of Buffer.from(String(text), 'utf8')) {
    const ch = String.fromCharCode(byte);
    out += byte < 0x80 && (/[A-Za-z0-9_.\-~]/.test(ch) || safe.includes(ch)) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** An object name as it is written in the URL path: slashes stay. */
export const quoteObjectName = (name) => quote(name, '/');
/** A query name or value: slashes are encoded too. */
export const quoteParam = (value) => quote(value, '');

/** 1793000000000 -> "20261101T120000Z" */
export function v4Timestamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** True when `key` is something this site is willing to put in a signed URL. */
export function isSafeKey(key) {
  return typeof key === 'string' && SAFE_KEY.test(key) && !key.includes('//') && !key.split('/').some((part) => part === '..' || part === '.' || part.startsWith('.'));
}

/**
 * Sign one request. Pure: the same inputs give the same URL, because RSA PKCS#1 v1.5 has no randomness.
 * @param {object} p
 * @param {import('node:crypto').KeyObject} p.privateKey
 * @param {string} p.clientEmail the service account (the signature's credential)
 * @param {string} p.bucket
 * @param {string} p.objectName the full object name (prefix included), not yet encoded
 * @param {string} [p.method] GET or PUT
 * @param {Record<string, string>} [p.headers] headers the caller must send and that are signed (Host is added)
 * @param {number} p.expiresS seconds the URL works for, counted from `nowMs`
 * @param {number} p.nowMs the signing time
 * @returns {{url: string, stringToSign: string, signature: string, signedHeaders: string}}
 */
export function signUrlV4({ privateKey, clientEmail, bucket, objectName, method = 'GET', headers = {}, expiresS, nowMs }) {
  if (!Number.isInteger(expiresS) || expiresS < 1 || expiresS > MAX_EXPIRES_S) throw new RangeError(`expiresS must be a whole number from 1 to ${MAX_EXPIRES_S}`);
  const stamp = v4Timestamp(nowMs);
  const scope = `${stamp.slice(0, 8)}/auto/storage/goog4_request`;
  const credential = `${clientEmail}/${scope}`;

  const merged = new Map();
  for (const [name, value] of Object.entries(headers)) merged.set(name.toLowerCase().trim(), String(value).split(/\s+/).filter(Boolean).join(' '));
  if (!merged.has('host')) merged.set('host', HOST);
  const ordered = [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalHeaders = `${ordered.map(([name, value]) => `${name}:${value}`).join('\n')}\n`;
  const signedHeaders = ordered.map(([name]) => name).join(';');

  const params = {
    'X-Goog-Algorithm': ALGORITHM,
    'X-Goog-Credential': credential,
    'X-Goog-Date': stamp,
    'X-Goog-Expires': String(expiresS),
    'X-Goog-SignedHeaders': signedHeaders,
  };
  const query = Object.entries(params).map(([name, value]) => `${quoteParam(name)}=${quoteParam(value)}`).sort().join('&');
  const resource = `/${bucket}/${quoteObjectName(objectName)}`;
  const canonicalRequest = [method, resource, query, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = [ALGORITHM, stamp, scope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const signature = crypto.createSign('RSA-SHA256').update(stringToSign).sign(privateKey).toString('hex');
  return { url: `https://${HOST}${resource}?${query}&X-Goog-Signature=${signature}`, stringToSign, signature, signedHeaders };
}

/**
 * @param {object} options
 * @param {() => {bucket: string, prefix: string, keyFile: string, gcsProblem?: string}} options.config read on every use, so .env edits apply
 * @param {() => number} [options.now]
 * @param {{warn: Function}} [options.log]
 * @param {(file: string, encoding: string) => string} [options.readFile]
 * @param {(file: string) => {mtimeMs: number, size: number}} [options.stat]
 */
export function createGcsSigner({ config, now = Date.now, log, readFile = fs.readFileSync, stat = fs.statSync }) {
  /** @type {{file: string, stamp: string, checkedAt: number, key: object | null, problem: string}} */
  let cache = null;

  function load() {
    const cfg = config();
    if (cfg.gcsProblem) return { key: null, problem: cfg.gcsProblem === 'prefix' ? 'CATALOGUE_GCS_PREFIX is not usable.' : 'CATALOGUE_GCS_BUCKET is not a bucket name.' };
    if (!cfg.bucket) return { key: null, problem: 'CATALOGUE_GCS_BUCKET is not set.' };
    if (!cfg.keyFile) return { key: null, problem: 'CATALOGUE_GCS_KEY_FILE is not set.' };
    const t = now();
    if (cache && cache.file === cfg.keyFile && t - cache.checkedAt < (cache.key ? RECHECK_MS : FAILURE_MS)) return cache;
    let stamp = '';
    try {
      const st = stat(cfg.keyFile);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      cache = { file: cfg.keyFile, stamp: '', checkedAt: t, key: null, problem: 'The signing key file cannot be read (CATALOGUE_GCS_KEY_FILE).' };
      return cache;
    }
    if (cache && cache.file === cfg.keyFile && cache.stamp === stamp && cache.key) {
      cache.checkedAt = t;
      return cache;
    }
    cache = { file: cfg.keyFile, stamp, checkedAt: t, ...parseKeyFile(readFile, cfg.keyFile) };
    if (!cache.key) log?.warn(`catalogue  ${cache.problem}`);
    return cache;
  }

  function sign(method, key, { contentType, maxBytes, expiresS, stableS = 0 } = {}) {
    const loaded = load();
    if (!loaded.key) throw new Error(loaded.problem);
    if (!isSafeKey(key)) throw new Error('That object key is not allowed.');
    const cfg = config();
    const headers = {};
    if (method === 'PUT') {
      if (typeof contentType !== 'string' || !CONTENT_TYPE.test(contentType)) throw new Error('A content type is needed to sign an upload.');
      if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('A size limit is needed to sign an upload.');
      headers['content-type'] = contentType;
      headers['x-goog-content-length-range'] = `0,${maxBytes}`;
    }
    const t = now();
    // a stable signing time (the start of a window) gives the same URL for the same picture all window long, so the browser can cache it
    const at = stableS ? Math.floor(t / 1000 / stableS) * stableS * 1000 : t;
    const signed = signUrlV4({ privateKey: loaded.key.privateKey, clientEmail: loaded.key.clientEmail, bucket: cfg.bucket, objectName: `${cfg.prefix}${key}`, method, headers, expiresS, nowMs: at });
    return { signed, headers, expiresAt: at + expiresS * 1000 };
  }

  return {
    /** @returns {{ok: boolean, problem: string, clientEmail?: string}} whether signing can work right now (the key file is read and kept) */
    ready() {
      const loaded = load();
      return loaded.key ? { ok: true, problem: '', clientEmail: loaded.key.clientEmail } : { ok: false, problem: loaded.problem };
    },
    /** A URL that lets anyone who holds it read `key` (relative to CATALOGUE_GCS_PREFIX) for `expiresS` seconds. */
    signGet(key, { expiresS = 3600, stableS = 0 } = {}) {
      return sign('GET', key, { expiresS, stableS }).signed.url;
    },
    /** A URL that lets its holder upload exactly `key`, with exactly this content type and a size of 0 to `maxBytes`. */
    signPut(key, { contentType, maxBytes, expiresS = 7200 }) {
      const { signed, headers, expiresAt } = sign('PUT', key, { contentType, maxBytes, expiresS });
      return { url: signed.url, headers: { 'Content-Type': contentType, 'x-goog-content-length-range': headers['x-goog-content-length-range'] }, expiresAt };
    },
    /** Sign a throw-away URL and check the signature with the key's public half: does the key work, is it an RSA key. Billed nothing. */
    selfTest() {
      const loaded = load();
      if (!loaded.key) return { ok: false, detail: loaded.problem };
      try {
        const cfg = config();
        const { stringToSign, signature } = signUrlV4({ privateKey: loaded.key.privateKey, clientEmail: loaded.key.clientEmail, bucket: cfg.bucket, objectName: `${cfg.prefix}self-test`, expiresS: 60, nowMs: now() });
        const ok = crypto.verify('RSA-SHA256', Buffer.from(stringToSign), crypto.createPublicKey(loaded.key.privateKey), Buffer.from(signature, 'hex'));
        return ok ? { ok: true, detail: `Signing works as ${loaded.key.clientEmail}. Whether Google accepts the signature was not tested.` } : { ok: false, detail: 'The key signed something its own public half does not accept.' };
      } catch {
        return { ok: false, detail: 'The key could not sign.' };
      }
    },
  };
}

/** Read and check a service-account JSON file. Never returns or throws the file's contents. */
function parseKeyFile(readFile, file) {
  let json;
  try {
    json = JSON.parse(readFile(file, 'utf8'));
  } catch {
    return { key: null, problem: 'The signing key file is not a readable JSON file (CATALOGUE_GCS_KEY_FILE).' };
  }
  const email = typeof json?.client_email === 'string' ? json.client_email.trim() : '';
  if ((json?.type && json.type !== 'service_account') || !/^[^\s@]{1,100}@[^\s@]{1,100}$/.test(email)) return { key: null, problem: 'The signing key file is not a service-account key (no client_email).' };
  try {
    const privateKey = crypto.createPrivateKey(String(json.private_key ?? ''));
    if (privateKey.asymmetricKeyType !== 'rsa') return { key: null, problem: 'The signing key is not an RSA key.' };
    return { key: { privateKey, clientEmail: email }, problem: '' };
  } catch {
    return { key: null, problem: 'The private key in the signing key file could not be read.' };
  }
}
