/**
 * Settings, read from .env (and the real environment, which wins).
 *
 * Variable names deliberately match terucon_backend/.env.example, so credentials can be pasted
 * across unchanged: GCP_SERVICE_ACCOUNT_JSON, GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_CLOUD_PROJECT,
 * GOOGLE_CLOUD_LOCATION, GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI.
 *
 * Nothing in here ever logs or returns a secret. publicSettings() is the only thing the browser gets.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAdc, isGoogleApisUrl } from '../lib/adc.js';
import { loadEnvFile } from './envfile.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const MODEL_ENV = {
  image: 'SWATCHROOM_IMAGE_MODEL',
  detect: 'SWATCHROOM_DETECT_MODEL',
  mask: 'SWATCHROOM_MASK_MODEL',
  insight: 'SWATCHROOM_INSIGHT_MODEL',
};

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION = /^[a-z0-9-]{2,40}$/;
const MODEL_NAME = /^[A-Za-z0-9._-]{3,80}$/;
const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const TRUE = new Set(['1', 'true', 'yes', 'on', 'y']);
const FALSE = new Set(['0', 'false', 'no', 'off', 'n']);

/** true / false for the usual spellings; `fallback` for blank or anything else. */
function flag(value, fallback) {
  if (value === undefined || value === null || value.trim() === '') return fallback;
  const v = value.trim().toLowerCase();
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

/** Plain objects with the defaults; loadSettings fills them in. */
function emptySettings(envPath) {
  return {
    envPath,
    envFileFound: false,
    host: '127.0.0.1',
    port: 8080,
    allowedHosts: [],
    google: {
      mode: 'none', // "vertex" (service account / ADC) | "api-key" (AI Studio) | "none"
      projectId: '',
      location: 'global',
      serviceAccount: null,
      serviceAccountSource: '',
      adc: null, // Application Default Credentials: see lib/adc.js
      apiKey: '',
      error: '',
      configured: false,
      clientEmail: '',
    },
    models: {}, // only the ones set explicitly
    segmentationEngine: 'auto',
    edgeRefine: true,
    edgeMethod: 'contour', // contour | watershed (the method contour snapping replaced, kept as a fallback)
    analysisMaxSide: 1536,
    sam: {
      enabled: false,
      backend: 'auto', // auto | sam2 | sam | sam3 | remote
      modelId: 'facebook/sam2.1-hiera-small',
      device: 'auto', // auto | cpu | cuda | mps
      hfToken: '',
      checkpoint: '',
      repoDir: '',
      remoteUrl: '',
      remoteKey: '',
      remoteAuthHeader: 'bearer',
      serverKey: '', // when set, /api/sam/* requires it (for a GPU box that other servers call)
      maxSide: 1024,
      preload: true,
    },
    model: { mode: 'auto', url: '', key: '', startTimeoutSeconds: 90, python: '' }, // the Python model service
    allowCustomGoogleEndpoints: false,
    vertexApiBase: '', // tests only: point Google calls at a local mock
    warnings: [],
  };
}

// ---- parsing -------------------------------------------------------------------

/** JSON.parse that tolerates raw control characters (a pasted newline) inside strings, like Python's strict=False. */
function parseLenientJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    let out = '';
    let inString = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (inString && ch === '\\') {
        out += ch + (text[i + 1] ?? '');
        i += 1;
      } else if (ch === '"') {
        inString = !inString;
        out += ch;
      } else if (inString && ch < ' ') {
        out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
      } else {
        out += ch;
      }
    }
    if (out === text) throw err;
    return JSON.parse(out);
  }
}

function maybeBase64(text) {
  if (text.startsWith('{') || text.length < 40 || /[^A-Za-z0-9+/=_\-\s]/.test(text)) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(text, 'base64'));
  } catch {
    return ''; // any decode failure just means "not base64"
  }
}

/** Accept raw JSON, JSON wrapped in stray quotes, or base64 of the JSON file. Null when it is none of them. */
function decodeJsonBlob(text) {
  let t = text.trim();
  if (t.length >= 2 && t[0] === t.at(-1) && (t[0] === "'" || t[0] === '"')) t = t.slice(1, -1).trim();
  if (!t) return null;
  for (const candidate of [t, maybeBase64(t)]) {
    if (!candidate) continue;
    try {
      const data = parseLenientJson(candidate);
      if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch {
      // not JSON: try the next form
    }
  }
  return null;
}

function checkServiceAccount(info, allowCustom) {
  if (info.type !== 'service_account') return 'the JSON is not a service-account key (its "type" must be "service_account")';
  const missing = ['client_email', 'private_key'].filter((k) => !info[k]);
  if (missing.length) return 'the service-account key is missing: ' + missing.join(', ');
  if (!String(info.private_key).includes('BEGIN PRIVATE KEY')) return 'private_key is not a PKCS#8 PEM key; create a new JSON key for the service account';
  if (info.token_uri && !allowCustom && !isGoogleApisUrl(info.token_uri)) return 'token_uri in the key does not point at googleapis.com, so it was refused';
  return '';
}

/** Where a key file is looked for when no variable names one: the project folder, then Render's secret-file folder. */
const DEFAULT_KEY_FILES = ['service-account.json', 'credentials/service-account.json', '/etc/secrets/service-account.json'];
function defaultKeyFile(root) {
  return DEFAULT_KEY_FILES.map((f) => path.resolve(root, f)).find((f) => fs.existsSync(f)) ?? '';
}

function expandHome(file, env, explicit) {
  if (file !== '~' && !file.startsWith('~/') && !file.startsWith('~\\')) return file;
  const home = env.HOME || env.USERPROFILE || (explicit ? '' : os.homedir());
  return home ? path.join(home, file.slice(1)) : file;
}

/**
 * @param {string} [envPath] the env file; defaults to ROOT/.env
 * @param {Record<string, string>} [environ] replaces the process environment (tests); the file is still read.
 *   Left out, the real process environment is used and wins over the file.
 * @param {string} [root] where relative credential paths are resolved from
 */
export function loadSettings(envPath, environ, root = ROOT) {
  const file = envPath ? path.resolve(envPath) : path.join(root, '.env');
  const explicit = environ !== undefined;
  const env = { ...loadEnvFile(file), ...(environ ?? process.env) };
  const s = emptySettings(file);
  s.envFileFound = fs.existsSync(file);
  const w = s.warnings;
  const get = (key, fallback = '') => String(env[key] ?? fallback).trim();

  // --- server
  s.host = get('HOST', '127.0.0.1') || '127.0.0.1';
  s.port = int(get('PORT'), 8080, 0, 65535); // 0 = let the system pick (tests)
  s.allowedHosts = get('ALLOWED_HOSTS').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  s.allowCustomGoogleEndpoints = flag(get('TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS'), false) || false;
  s.vertexApiBase = s.allowCustomGoogleEndpoints ? get('TERUCON_VERTEX_API_BASE').replace(/\/+$/, '') : '';

  // --- Google credentials
  const g = s.google;
  let projectEnv = get('GOOGLE_CLOUD_PROJECT');
  const location = get('GOOGLE_CLOUD_LOCATION', 'global') || 'global';
  if (LOCATION.test(location)) g.location = location;
  else w.push("GOOGLE_CLOUD_LOCATION is not a valid location name; using 'global'.");

  const saText = get('GCP_SERVICE_ACCOUNT_JSON') || get('GOOGLE_SERVICE_ACCOUNT_JSON');
  let saSource = saText ? 'GCP_SERVICE_ACCOUNT_JSON' : '';
  let info = null;
  if (saText) {
    info = decodeJsonBlob(saText);
    if (info === null) g.error = 'GCP_SERVICE_ACCOUNT_JSON is set but is not valid JSON. Paste the whole key file on ONE line inside single quotes.';
  }
  if (info === null && !g.error) {
    const filePath = get('GOOGLE_APPLICATION_CREDENTIALS') || get('GCP_SERVICE_ACCOUNT_FILE') || defaultKeyFile(root);
    if (filePath) {
      let fp = expandHome(filePath, env, explicit);
      if (!path.isAbsolute(fp)) fp = path.join(root, fp);
      try {
        info = decodeJsonBlob(fs.readFileSync(fp, 'utf8'));
        saSource = `file ${path.basename(fp)}`;
        if (info === null) g.error = `${path.basename(fp)} is not valid JSON.`;
      } catch {
        g.error = `The credentials file ${fp} could not be read.`;
      }
    }
  }
  if (info === null && !g.error && projectEnv && (projectEnv.trimStart().startsWith('{') || projectEnv.includes('PRIVATE KEY'))) {
    // A known mix-up: the whole key pasted into GOOGLE_CLOUD_PROJECT. Use it, but say so.
    info = decodeJsonBlob(projectEnv);
    if (info !== null) {
      saSource = 'GOOGLE_CLOUD_PROJECT (misplaced)';
      w.push(
        'A service-account key was found in GOOGLE_CLOUD_PROJECT. It works, but please move it to ' +
          'GCP_SERVICE_ACCOUNT_JSON and put only the project id (for example my-project-123) in GOOGLE_CLOUD_PROJECT. ' +
          'Consider rotating the key, since it sat in a general-purpose variable.',
      );
      projectEnv = '';
    }
  }
  if (info !== null && !g.error) {
    const problem = checkServiceAccount(info, s.allowCustomGoogleEndpoints);
    if (problem) {
      g.error = problem;
      info = null;
    }
  }
  if (info !== null) {
    g.serviceAccount = info;
    g.serviceAccountSource = saSource;
  }

  if (projectEnv && !PROJECT_ID.test(projectEnv)) {
    w.push('GOOGLE_CLOUD_PROJECT does not look like a project id (6-30 lowercase letters, digits, hyphens); ignoring it.');
    projectEnv = '';
  }
  g.projectId = projectEnv || info?.project_id || get('GCLOUD_PROJECT') || get('GCP_PROJECT');

  g.apiKey = get('GEMINI_API_KEY') || get('GOOGLE_API_KEY');
  const useVertex = flag(get('GOOGLE_GENAI_USE_VERTEXAI'), null);

  if (!g.error) {
    const adc = useVertex === true && g.serviceAccount === null ? detectAdc(env, { explicit, allowCustom: s.allowCustomGoogleEndpoints }) : null;
    if (useVertex === false) {
      g.mode = g.apiKey ? 'api-key' : 'none';
      if (!g.apiKey) g.error = 'GOOGLE_GENAI_USE_VERTEXAI=false needs GEMINI_API_KEY to be set.';
    } else if (g.serviceAccount !== null) {
      g.mode = 'vertex';
    } else if (adc?.error) {
      g.error = adc.error;
    } else if (adc) {
      g.mode = 'vertex';
      g.adc = adc;
    } else if (g.apiKey) {
      g.mode = 'api-key';
      if (useVertex === true) w.push('GOOGLE_GENAI_USE_VERTEXAI=true but no service account was found; using GEMINI_API_KEY instead.');
    } else if (useVertex === true) {
      g.error = 'Vertex AI needs a service account: set GCP_SERVICE_ACCOUNT_JSON (or GOOGLE_APPLICATION_CREDENTIALS).';
    }
  }
  if (g.mode === 'vertex' && !g.projectId) {
    g.error = 'Could not work out the Google Cloud project id. Set GOOGLE_CLOUD_PROJECT (for example my-project-123).';
    g.mode = 'none';
  }
  g.configured = g.mode !== 'none' && !g.error;
  g.clientEmail = info?.client_email ?? '';

  // --- model overrides (only when explicitly set)
  for (const [role, variable] of Object.entries(MODEL_ENV)) {
    const value = get(variable);
    if (value && MODEL_NAME.test(value)) s.models[role] = value;
    else if (value) w.push(`${variable} has an invalid model name and was ignored.`);
  }

  // --- segmentation
  let engine = get('SEGMENTATION_ENGINE', 'auto').toLowerCase() || 'auto';
  if (!['auto', 'terucon', 'sam', 'scene', 'gemini'].includes(engine)) {
    w.push(`SEGMENTATION_ENGINE='${engine}' is not one of auto, terucon, sam, scene, gemini; using auto.`);
    engine = 'auto';
  }
  s.segmentationEngine = engine;
  s.edgeRefine = flag(get('EDGE_REFINE'), true) !== false;
  let method = get('EDGE_METHOD', 'contour').toLowerCase() || 'contour';
  if (!['contour', 'watershed'].includes(method)) {
    w.push(`EDGE_METHOD='${method}' is not one of contour, watershed; using contour.`);
    method = 'contour';
  }
  s.edgeMethod = method;
  s.analysisMaxSide = int(get('ANALYSIS_MAX_SIDE'), 1536, 512, 3072);

  // --- SAM (optional; it runs inside the model service, which reads the same variables)
  const m = s.sam;
  m.enabled = Boolean(flag(get('SAM_ENABLED'), false));
  let backend = get('SAM_BACKEND', 'auto').toLowerCase() || 'auto';
  if (!['auto', 'sam2', 'sam', 'sam3', 'remote'].includes(backend)) {
    w.push(`SAM_BACKEND='${backend}' is not one of auto, sam2, sam, sam3, remote; using auto.`);
    backend = 'auto';
  }
  m.backend = backend;
  m.modelId = get('SAM_MODEL_ID', 'facebook/sam2.1-hiera-small') || 'facebook/sam2.1-hiera-small';
  m.device = (get('SAM_DEVICE', 'auto') || 'auto').toLowerCase();
  m.hfToken = get('HF_TOKEN') || get('HUGGING_FACE_HUB_TOKEN');
  m.checkpoint = get('SAM_CHECKPOINT');
  m.repoDir = get('SAM_REPO_DIR');
  m.remoteUrl = get('SAM_REMOTE_URL').replace(/\/+$/, '');
  m.remoteKey = get('SAM_REMOTE_KEY');
  m.remoteAuthHeader = ['x-api-key', 'x_api_key'].includes(get('SAM_REMOTE_AUTH_HEADER').toLowerCase()) ? 'x-api-key' : 'bearer';
  m.serverKey = get('SAM_SERVER_KEY');
  m.maxSide = int(get('SAM_MAX_SIDE'), 1024, 256, 2048);
  m.preload = Boolean(flag(get('SAM_PRELOAD'), true));
  if (m.remoteUrl && backend === 'auto') m.backend = 'remote';
  if (m.enabled && m.backend === 'remote' && !m.remoteUrl) {
    w.push('SAM_BACKEND=remote needs SAM_REMOTE_URL.');
    m.enabled = false;
  }

  // --- the Python model service (read once at start-up: it decides whether a child process is spawned)
  const svc = s.model;
  svc.mode = get('MODEL_SERVICE', 'auto').toLowerCase() || 'auto';
  if (!['auto', 'external', 'off'].includes(svc.mode)) {
    w.push(`MODEL_SERVICE='${svc.mode}' is not one of auto, external, off; using auto.`);
    svc.mode = 'auto';
  }
  svc.url = get('MODEL_SERVICE_URL').replace(/\/+$/, '');
  if (svc.url && !/^https?:\/\/[^/\s]+/i.test(svc.url)) {
    w.push('MODEL_SERVICE_URL is not an http(s) address (for example http://127.0.0.1:8081); ignoring it.');
    svc.url = '';
  }
  svc.key = get('MODEL_SERVICE_KEY');
  svc.startTimeoutSeconds = int(get('MODEL_START_TIMEOUT'), 90, 5, 900);
  svc.python = get('PYTHON');
  if (svc.mode === 'external' && !svc.url) w.push('MODEL_SERVICE=external needs MODEL_SERVICE_URL (for example http://127.0.0.1:8081).');
  return s;
}

/** The only view of the settings the browser may see: no secret ever goes in here. */
export function publicSettings(settings, samStatus, modelStatus) {
  const g = settings.google;
  const model = { mode: modelStatus.mode, status: modelStatus.status };
  if (modelStatus.error) model.error = modelStatus.error;
  return {
    version: '1',
    server: true,
    google: {
      configured: g.configured,
      mode: g.mode,
      projectId: g.projectId,
      clientEmail: g.clientEmail,
      location: g.location,
      error: g.error,
    },
    models: Object.fromEntries(Object.entries(settings.models).filter(([, v]) => v)),
    segmentation: {
      engine: settings.segmentationEngine,
      edgeRefine: settings.edgeRefine,
      edgeMethod: settings.edgeMethod,
      analysisMaxSide: settings.analysisMaxSide,
    },
    sam: samStatus ?? samFallback(settings, modelStatus),
    warnings: [...settings.warnings],
    model,
  };
}

/** What the Design Studio is told about SAM while the model service that would run it cannot answer. */
export function samFallback(settings, modelStatus) {
  const enabled = settings.sam.enabled;
  const sam = { enabled, status: enabled && modelStatus.status !== 'off' ? 'unavailable' : 'off', backend: '', model: '', interactive: false, textPrompts: false };
  if (sam.status === 'unavailable' && modelStatus.error) sam.error = modelStatus.error;
  return sam;
}

/** Human-readable startup lines. Contains no secrets. */
export function describe(settings) {
  const g = settings.google;
  const lines = [];
  if (g.mode === 'vertex') {
    const who = g.clientEmail || (g.adc ? 'application default credentials' : 'service account');
    lines.push(`Google: Vertex AI as ${who}  (project ${g.projectId || '?'}, location ${g.location})`);
  } else if (g.mode === 'api-key') {
    lines.push('Google: Gemini API key (AI Studio)');
  } else {
    lines.push(g.error ? `Google: ${g.error}` : 'Google: not configured - fill in .env (see .env.example)');
  }
  const m = settings.sam;
  lines.push(m.enabled ? `SAM: enabled, backend=${m.backend}, model=${m.backend !== 'remote' ? m.modelId : m.remoteUrl}` : 'SAM: off (optional; set SAM_ENABLED=true to use it)');
  lines.push(`Segmentation: engine=${settings.segmentationEngine}, edge refinement=${settings.edgeRefine ? 'on, ' + settings.edgeMethod : 'off'}`);
  const svc = settings.model;
  lines.push(
    svc.mode === 'off'
      ? 'Model service: off (MODEL_SERVICE=off); surfaces are found in the browser'
      : svc.mode === 'external'
        ? `Model service: external, ${svc.url || 'MODEL_SERVICE_URL is missing'}`
        : 'Model service: Python, started with the server',
  );
  return lines;
}

/** Re-reads the env file when it changes, so pasting a key and reloading the page is enough. */
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
    /** Counts reloads; anything derived from the settings (the token cache) rebuilds when it changes. */
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
