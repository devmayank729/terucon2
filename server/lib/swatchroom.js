/**
 * The Design Studio (swatchroom/): its Express app is mounted inside this server, so the studio, its API and its
 * cold-start bookkeeping live in one process. The swatchroom's files are loaded, never edited.
 *
 * The swatchroom is a CommonJS package with its own server. `swatchroom/server/index.js` exports its Express app and
 * only starts listening when run directly, so a host has to do the three things its own `start()` does:
 *   1. connect MongoDB, and keep trying (rooms cannot be saved until it is up, but the studio opens meanwhile),
 *   2. mark the pipeline jobs a restart cut short as failed, so the browser stops waiting for them,
 *   3. say what the model setup will be (the local scan service, OneFormer, the room analysis).
 *
 * Loading it reads swatchroom/.env into process.env (its config.js uses dotenv). That is how the studio is configured and
 * it must not leak into this server's own settings: createApp snapshots the environment BEFORE this module loads the
 * swatchroom and builds its settings from the snapshot.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { mongoRoomOwners } from './roomOwners.js';

/**
 * The API routes the swatchroom serves (the mounts in swatchroom/server/index.js). They carry photos, masks and renders as
 * raw image bytes, so the website's "JSON only" rule for writes does not apply to them (server/middleware/guards.js).
 * tests/js/server-studio.test.js checks this list against the swatchroom's own mounts.
 */
export const STUDIO_API_PREFIXES = ['/api/session', '/api/check', '/api/admin', '/api/ai', '/api/rooms', '/api/vision', '/api/pipeline'];

const DATABASE_RETRY_MS = 15000;

/**
 * fetch() that treats any answer but 2xx as a failure. The studio's wake-up (lib/wake.js) records every answer to /healthz as a
 * success, a 401 from a wrong key or a 404 from a stale address included, which would show the service as warm for five
 * minutes while it is not. With a throw here the studio records a failure (its own log line and its owner's dot say so) and the
 * next visitor tries again.
 */
async function healthy(url, init) {
  const answer = await fetch(url, init);
  if (!answer.ok) throw new Error(`/healthz answered ${answer.status}`);
  return answer;
}

/** Whether a request path is one of the studio's API routes (it is a prefix, or below one). */
export function isStudioApi(requestPath) {
  return STUDIO_API_PREFIXES.some((prefix) => requestPath === prefix || requestPath.startsWith(prefix + '/'));
}

/** Hide a user:password in any connection string that ends up in an error message. */
function redact(message) {
  return String(message).replace(/(\w[\w+.-]*:\/\/)[^\s/@]+@/g, '$1***@');
}

/**
 * @param {object} options
 * @param {string} options.dir the swatchroom folder
 * @param {{info: Function, warn: Function}} options.log
 * @param {boolean} [options.requirePasscode] keep the studio's own passcode (its STUDIO_PASSCODE). Left out or false, the passcode
 *   is switched off before the studio reads its settings: the studio's own config treats a variable that is already set (even to
 *   nothing) as final, so its .env cannot turn it back on. Protection then comes from server/lib/studioShield.js.
 * @returns {{
 *   app: import('express').Express,
 *   apiPrefixes: string[],
 *   ownsApi: (requestPath: string) => boolean,
 *   start: () => void,
 *   warm: () => string[],
 *   status: () => {database: boolean},
 *   analytics: () => {key: string, host: string},
 *   roomStore: () => import('./studioShield.js').RoomStore,
 *   securityWarnings: () => string[],
 *   close: () => Promise<void>,
 * }}
 */
export function loadSwatchroom({ dir, log, requirePasscode = false }) {
  const entry = path.join(path.resolve(dir), 'server', 'index.js');
  if (!fs.existsSync(entry)) throw new Error(`The Design Studio was not found: expected ${entry}`);
  const need = createRequire(entry);
  const here = (...parts) => path.join(path.dirname(entry), ...parts);

  if (!requirePasscode) process.env.STUDIO_PASSCODE = '';
  const app = need(entry);
  // the same module instances the app uses (CommonJS caches by file), so the cold-start record is shared
  const config = need(here('config.js'));
  const db = need(here('db.js'));
  const wake = need(here('lib', 'wake.js'));
  const bootReport = need(here('lib', 'bootReport.js'));
  const googleToken = need(here('google', 'token.js'));

  let retry = null;
  let closed = false;

  async function reconcileStaleJobs() {
    try {
      const PipelineJob = need(here('models', 'PipelineJob.js'));
      await PipelineJob.updateMany(
        { status: { $in: ['queued', 'running'] } },
        { $set: { status: 'failed', error: 'Interrupted by a server restart.', finishedAt: Date.now() } },
      );
    } catch {
      // best effort, as in the swatchroom: a real database problem shows up in the connection retry
    }
  }

  async function connectDatabase() {
    if (closed) return;
    try {
      await db.connect();
      log.info(`studio  MongoDB connected: ${db.status().database}`);
      await reconcileStaleJobs();
    } catch (error) {
      if (closed) return;
      log.warn(`studio  MongoDB is not reachable (${redact(error.message)}). Retrying in ${DATABASE_RETRY_MS / 1000} seconds; the studio opens meanwhile but cannot save rooms.`);
      retry = setTimeout(connectDatabase, DATABASE_RETRY_MS);
      retry.unref?.();
    }
  }

  return {
    app,
    apiPrefixes: STUDIO_API_PREFIXES,
    ownsApi: isStudioApi,

    /** Connect MongoDB (not awaited), check the Google key, and report the model setup. Call once the server listens. */
    start() {
      connectDatabase();
      const google = googleToken.describe();
      if (!google.configured) log.warn(`studio  ${google.problem || 'No Google key: set GOOGLE_APPLICATION_CREDENTIALS in swatchroom/.env to enable Gemini.'}`);
      bootReport
        .describe()
        .then((lines) => lines.forEach((line) => (line.level === 'ok' ? log.info : log.warn)(`studio  ${line.text}`)))
        .catch((error) => log.warn(`studio  could not summarise the model setup: ${error.message}`));
    },

    /**
     * Start the cold start of every GPU service a studio visit will use: the scan model (OneFormer) and the pools the room
     * pipeline calls. The swatchroom's own wake-up (lib/wake.js) does the work and keeps the record the studio's start-up gate
     * reads; it skips services that are warm or already starting and only sends /healthz, so a repeat call costs nothing.
     * On a scan the swatchroom wakes only the pipeline pools (the scan request itself wakes OneFormer); here nothing has
     * been requested yet, so OneFormer is woken too. Fire and forget; returns the names of the services started (an answer
     * that is not 2xx is recorded as a failed wake-up, see healthy()).
     */
    warm() {
      return wake.wake({ pools: [['oneformer', config.oneformer], ...wake.pipelinePools()], scanUsesOneFormer: false, fetch: healthy });
    },

    status: () => ({ database: db.status().connected }),

    /** The studio's own PostHog project key and host (its POSTHOG_KEY / POSTHOG_HOST); the key is public by PostHog's design. */
    analytics: () => ({ key: config.posthog.key, host: config.posthog.host }),

    /** The list of who owns which room, in the studio's database (server/lib/roomOwners.js). */
    roomStore: () => mongoRoomOwners({ mongoose: need('mongoose'), Room: need(here('models', 'Room.js')) }),

    /** Things in the studio's settings that are unsafe once the site is reachable by others. Plain sentences, no secrets. */
    securityWarnings() {
      const warnings = [];
      if (config.admin.password === 'admin@123') warnings.push('The studio admin (/admin) still has the built-in password: set ADMIN_PASSWORD in swatchroom/.env.');
      if (!process.env.SESSION_SECRET) warnings.push('SESSION_SECRET is not set in swatchroom/.env: admin sign-ins end at every restart.');
      return warnings;
    },

    async close() {
      closed = true;
      clearTimeout(retry);
      try {
        await need('mongoose').disconnect();
      } catch {
        // nothing to disconnect
      }
    },
  };
}
