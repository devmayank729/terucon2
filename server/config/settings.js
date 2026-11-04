/**
 * Settings, read from .env (and the real environment, which wins): where the server listens, which Host names it
 * answers to, and whether the website wakes the Design Studio's GPU services early. Nothing in here is a secret. The
 * Design Studio's own settings (database, Google key, GPU services) are in swatchroom/.env.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAuthEnv } from '../auth/config.js';
import { describeCatalogue, readCatalogueEnv } from '../catalogue/config.js';
import { CAPTURE_DEFAULTS, describeCapture, readCaptureEnv } from '../capture/config.js';
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

/** TeruBot's starting values. Limits are per hour; see server/lib/terubot/limits.js. */
export const TERUBOT_DEFAULTS = {
  enabled: true,
  model: '', // blank: the first model of the studio's text model chain (swatchroom/server/google/vertex.js), which falls back to the next when it is not available
  voice: 'Aoede', // the speaker of the spoken answers (Google Chirp 3 HD, in Hindi and English); '' = off: the browser's own voice is used
  maxOutputTokens: 1024,
  historyLimit: 12, // messages of the conversation sent to the model (the widget sends at most 12)
  toolRounds: 4, // rounds of tool calls in one answer, after which the model must answer in words
  timeoutMs: 30000, // the whole answer, tool rounds included
  limitAccount: 60, // chat messages per signed-in account per hour
  limitAddress: 120, // per network address per hour, signed in or not (an office or a phone network shares one)
  limitAnonymous: 20, // per network address per hour for visitors who are not signed in
};

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
    // Inspiration import (server/lib/inspiration/): reads a pasted address with gallery-dl (python/gallery_resolve.py, the website's own
    // Python) or, for a picture link or a web page, directly. `python` and `script` are filled in by loadSettings (relative to the project folder).
    inspiration: { enabled: true, python: '', script: '', limit: 40, timeoutMs: 60000, maxFileBytes: 25 * 1024 * 1024 },
    // Sign-in (server/auth/): the non-secret half of what .env says. The secrets are in `authSecrets`, which is not enumerable.
    auth: {},
    // Catalogue search (server/catalogue/): the non-secret half of what .env says, filled in by loadSettings. The keys are in `catalogueSecrets`,
    // which is not enumerable.
    catalogue: {},
    // TeruBot, the website's assistant (server/lib/terubot/): Gemini through the studio's Google key (swatchroom/server/google).
    terubot: { ...TERUBOT_DEFAULTS },
    // Capture from a phone (server/capture/): the non-secret half of what .env says; the WhatsApp token is in `captureSecrets`, which is not enumerable.
    capture: { ...CAPTURE_DEFAULTS },
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

  // --- inspiration import (a pasted address -> a picture to crop)
  const insp = s.inspiration;
  insp.enabled = flag(get('INSPIRATION_IMPORT'), true);
  insp.python = path.resolve(root, get('IMPORTER_PYTHON', 'python/.venv/bin/python') || 'python/.venv/bin/python');
  insp.script = path.resolve(root, get('IMPORTER_SCRIPT', 'python/gallery_resolve.py') || 'python/gallery_resolve.py');
  insp.limit = int(get('INSPIRATION_LIMIT'), 40, 1, 100);
  insp.timeoutMs = int(get('INSPIRATION_TIMEOUT_SECONDS'), 60, 10, 180) * 1000;
  insp.maxFileBytes = int(get('INSPIRATION_MAX_FILE_MB'), 25, 1, 50) * 1024 * 1024;

  // --- sign-in and the CRM (server/auth/config.js)
  const auth = readAuthEnv(get, s.warnings);
  s.auth = auth.pub;
  Object.defineProperty(s, 'authSecrets', { value: Object.freeze(auth.secrets), enumerable: false });

  // --- catalogue search (server/catalogue/config.js): find materials by photo, colour or text
  const catalogue = readCatalogueEnv(get, s.warnings, root);
  s.catalogue = catalogue.pub;
  Object.defineProperty(s, 'catalogueSecrets', { value: Object.freeze(catalogue.secrets), enumerable: false });

  // --- TeruBot (the assistant on every page)
  const bot = s.terubot;
  bot.enabled = flag(get('TERUBOT'), TERUBOT_DEFAULTS.enabled);
  const model = get('TERUBOT_MODEL');
  if (model && !/^[A-Za-z0-9._-]{1,80}$/.test(model)) s.warnings.push('TERUBOT_MODEL is not a model id (letters, digits, . _ -): the default model is used.');
  else bot.model = model;
  const voice = get('TERUBOT_VOICE') || TERUBOT_DEFAULTS.voice;
  if (/^(off|no|false|0)$/i.test(voice)) bot.voice = '';
  else if (/^[A-Za-z]{3,24}$/.test(voice)) bot.voice = voice.charAt(0).toUpperCase() + voice.slice(1).toLowerCase();
  else s.warnings.push('TERUBOT_VOICE is not a voice name (letters only, for example Aoede, or off): the default voice is used.');
  bot.maxOutputTokens = int(get('TERUBOT_MAX_OUTPUT_TOKENS'), TERUBOT_DEFAULTS.maxOutputTokens, 128, 4096);
  bot.historyLimit = int(get('TERUBOT_HISTORY_LIMIT'), TERUBOT_DEFAULTS.historyLimit, 2, 20);
  bot.toolRounds = int(get('TERUBOT_TOOL_ROUNDS'), TERUBOT_DEFAULTS.toolRounds, 1, 6);
  bot.timeoutMs = int(get('TERUBOT_TIMEOUT_SECONDS'), TERUBOT_DEFAULTS.timeoutMs / 1000, 1, 120) * 1000;
  bot.limitAccount = int(get('TERUBOT_LIMIT_ACCOUNT'), TERUBOT_DEFAULTS.limitAccount, 1, 100000);
  bot.limitAddress = int(get('TERUBOT_LIMIT_ADDRESS'), TERUBOT_DEFAULTS.limitAddress, 1, 100000);
  bot.limitAnonymous = int(get('TERUBOT_LIMIT_ANONYMOUS'), TERUBOT_DEFAULTS.limitAnonymous, 1, 100000);
  // --- capture from a phone (a QR code or WhatsApp link; photos come back to the requester)
  const capture = readCaptureEnv(get, s.warnings);
  s.capture = capture.pub;
  Object.defineProperty(s, 'captureSecrets', { value: Object.freeze(capture.secrets), enumerable: false });
  s.nodeEnv = get('NODE_ENV');
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
    ...describeCatalogue(settings),
    ...describeCapture(settings),
    settings.terubot.enabled
      ? `TeruBot (the assistant): on - ${settings.terubot.limitAccount} messages an hour per account, ${settings.terubot.limitAnonymous} per address for visitors not signed in (TERUBOT=off switches it off)`
      : 'TeruBot (the assistant): off (TERUBOT=off)',
    ...(settings.terubot.enabled
      ? [settings.terubot.voice
        ? `TeruBot voice: Google Chirp 3 HD, speaker ${settings.terubot.voice} (needs the Cloud Text-to-Speech API enabled for the Google project; TERUBOT_VOICE=off uses the browser's own voice)`
        : 'TeruBot voice: the browser\'s own (TERUBOT_VOICE=off)']
      : []),
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
