/**
 * Settings, read from .env (and the real environment, which wins): where the server listens, which Host names it
 * answers to, and whether the website wakes the Design Studio's GPU services early. Nothing in here is a secret. The
 * Design Studio's own settings (database, Google key, GPU services) are in swatchroom/.env.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './envfile.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const TRUE = new Set(['1', 'true', 'yes', 'on', 'y']);
const FALSE = new Set(['0', 'false', 'no', 'off', 'n']);

/** true / false for the usual spellings; `fallback` for blank or anything else. */
function flag(value, fallback) {
  const v = String(value ?? '').trim().toLowerCase();
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  return fallback;
}

/** A whole number clamped to [lo, hi]; `fallback` when the text is not a number (blank included). */
function int(value, fallback, lo, hi) {
  const text = String(value ?? '').trim();
  if (!FLOAT.test(text)) return fallback;
  return Math.max(lo, Math.min(hi, Math.trunc(Number(text))));
}

/** Requests per visitor per hour. The per-address limit is `perAddress` times these (a shared address: an office, a phone network). */
export const LIMIT_DEFAULTS = { ai: 60, vision: 60, pipeline: 40, check: 10, rooms: 600, perAddress: 4 };

/** Plain objects with the defaults; loadSettings fills them in. */
function emptySettings(envPath) {
  return {
    envPath,
    envFileFound: false,
    host: '127.0.0.1',
    port: 8080,
    allowedHosts: [],
    // trust proxy: how many proxies sit in front (Render: 1), as in the studio's own TRUST_PROXY. Used for the visitor's address
    // (rate limits) and for "is this HTTPS" (HSTS, secure cookies).
    trustProxy: 'loopback',
    studio: {
      warmup: true, // wake the studio's GPU services as soon as the landing page opens
      requirePasscode: false, // ask for swatchroom's STUDIO_PASSCODE (it is switched off here by default)
      limits: { ...LIMIT_DEFAULTS }, // requests per visitor per hour, per route group (server/lib/studioShield.js)
    },
    // PostHog for every page. Blank key: the studio's own POSTHOG_KEY (swatchroom/.env) is used, so both land in one project.
    analytics: { key: '', host: '', replay: true, onLocalhost: false },
    warnings: [],
  };
}

/**
 * @param {string} [envPath] the env file; defaults to ROOT/.env
 * @param {Record<string, string>} [environ] replaces the process environment (tests); the file is still read.
 *   Left out, the real process environment is used and wins over the file.
 * @param {string} [root] the project folder, where the default env file lives
 */
export function loadSettings(envPath, environ, root = ROOT) {
  const file = envPath ? path.resolve(envPath) : path.join(root, '.env');
  const env = { ...loadEnvFile(file), ...(environ ?? process.env) };
  const s = emptySettings(file);
  s.envFileFound = fs.existsSync(file);
  const get = (key, fallback = '') => String(env[key] ?? fallback).trim();

  // --- server
  s.host = get('HOST', '127.0.0.1') || '127.0.0.1';
  s.port = int(get('PORT'), 8080, 0, 65535); // 0 = let the system pick (tests)
  s.allowedHosts = get('ALLOWED_HOSTS').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

  // --- Design Studio
  s.studio.warmup = flag(get('STUDIO_WARMUP'), true);
  s.studio.requirePasscode = flag(get('STUDIO_REQUIRE_PASSCODE'), false);
  for (const [name, key] of [['AI', 'ai'], ['VISION', 'vision'], ['PIPELINE', 'pipeline'], ['CHECK', 'check'], ['ROOMS', 'rooms'], ['ADDRESS_FACTOR', 'perAddress']]) {
    s.studio.limits[key] = int(get(`STUDIO_LIMIT_${name}`), LIMIT_DEFAULTS[key], 1, 1000000);
  }

  // --- behind a proxy
  const proxy = get('TRUST_PROXY', 'loopback') || 'loopback';
  s.trustProxy = /^\d+$/.test(proxy) ? Number(proxy) : proxy;

  // --- analytics (PostHog)
  const key = get('POSTHOG_KEY');
  const host = get('POSTHOG_HOST', 'https://us.i.posthog.com') || 'https://us.i.posthog.com';
  if (key && !/^phc_[A-Za-z0-9]{20,}$/.test(key)) s.warnings.push('POSTHOG_KEY does not look like a PostHog project key (phc_...): analytics stays off.');
  else s.analytics.key = key;
  if (/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(host)) s.analytics.host = host;
  else s.warnings.push('POSTHOG_HOST must look like https://us.i.posthog.com: analytics stays off.');
  s.analytics.replay = flag(get('POSTHOG_REPLAY'), true);
  s.analytics.onLocalhost = flag(get('POSTHOG_ON_LOCALHOST'), false);
  return s;
}

/** Human-readable start-up lines for the banner. Contains no secrets. The address itself is shown by the banner. */
export function describe(settings) {
  return [
    settings.studio.warmup
      ? 'Cold start: the landing page and the studio page wake the studio\'s GPU services (STUDIO_WARMUP=off to stop)'
      : 'Cold start: the studio wakes its GPU services only when a photo is scanned (STUDIO_WARMUP=off)',
    settings.studio.requirePasscode
      ? 'Studio passcode: ON (STUDIO_REQUIRE_PASSCODE=on, the passcode is STUDIO_PASSCODE in swatchroom/.env)'
      : 'Studio passcode: off - the studio is open; each browser only sees its own rooms and every visitor is rate limited (README, "Keeping the open studio safe")',
  ];
}

/** Re-reads the env file when it changes, so saving it is enough (HOST and PORT are only used when the server starts). */
export class SettingsManager {
  #stamp;
  #settings;

  /** @param {string} [envPath] @param {Record<string, string>} [environ] @param {string} [root] */
  constructor(envPath, environ, root = ROOT) {
    this.envPath = envPath ? path.resolve(envPath) : path.join(root, '.env');
    this.environ = environ;
    this.root = root;
    this.#settings = loadSettings(this.envPath, environ, root);
    this.#stamp = this.#statStamp();
    /** Counts reloads; anything derived from the settings rebuilds when it changes. */
    this.version = 1;
  }

  #statStamp() {
    try {
      const st = fs.statSync(this.envPath);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  }

  get() {
    const stamp = this.#statStamp();
    if (stamp !== this.#stamp) {
      this.#settings = loadSettings(this.envPath, this.environ, this.root);
      this.#stamp = stamp;
      this.version += 1;
    }
    return this.#settings;
  }
}
