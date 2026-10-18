/**
 * The Python model service as the rest of the server sees it: one object that starts it (or just connects to
 * one that is already running), says whether it is usable and why not, proxies requests to it, and shuts it down.
 */
import crypto from 'node:crypto';
import { createModelClient, unavailableMessage } from './client.js';
import { buildChildEnv, ModelSupervisor } from './supervisor.js';

function samSummary(sam) {
  if (!sam?.enabled) return 'off';
  if (sam.status === 'ready') return `ready${sam.model ? `, ${sam.model}` : ''}`;
  return sam.status === 'error' ? `error: ${sam.error}` : (sam.status ?? 'unknown');
}

/**
 * @param {object} options
 * @param {string} options.root project folder
 * @param {object} options.settings settings.model (mode, url, key, startTimeoutSeconds, python)
 * @param {object} [options.overrides] createApp's `model` option: mode, url, key, python, command, args, startTimeoutMs, backoffSeconds, killGraceMs,
 *   probeTtlMs (how long a health check is reused), probeTimeoutMs
 * @param {Record<string, string>} [options.environ] the explicit environment createApp was given, if any
 * @param {string} options.envFile the env file the child must read too
 * @param {{info: Function, warn: Function, raw: Function}} options.log
 */
export function createModel({ root, settings, overrides = {}, environ, envFile, log }) {
  const mode = overrides.mode ?? settings.mode;
  const url = (overrides.url ?? settings.url).replace(/\/+$/, '');
  let key = overrides.key ?? settings.key;
  if (mode === 'auto' && !key) key = crypto.randomBytes(24).toString('hex'); // fresh per run: only this server can call its child

  let supervisor = null;
  if (mode === 'auto') {
    supervisor = new ModelSupervisor({
      root,
      env: buildChildEnv({ environ, envFile, key }),
      log,
      python: overrides.python ?? settings.python,
      command: overrides.command,
      args: overrides.args,
      startTimeoutMs: overrides.startTimeoutMs ?? settings.startTimeoutSeconds * 1000,
      backoffSeconds: overrides.backoffSeconds,
      killGraceMs: overrides.killGraceMs,
    });
  }

  const resolve = () => {
    if (mode === 'off') return { state: 'off' };
    if (mode === 'external') {
      return url ? { state: 'ready', url } : { state: 'unavailable', error: 'MODEL_SERVICE=external needs MODEL_SERVICE_URL (for example http://127.0.0.1:8081).' };
    }
    return supervisor.state;
  };
  const client = createModelClient({ mode, resolve, key, probeTtlMs: overrides.probeTtlMs, probeTimeoutMs: overrides.probeTimeoutMs });

  async function logReady(where) {
    const status = await client.status();
    if (status.status === 'ready') log.info(`[model] ready at ${where}  (SAM: ${samSummary(status.health.sam)})`);
    else log.warn(`[model] unavailable: ${unavailableMessage(status)}`);
  }

  supervisor?.on('state', (state) => {
    client.invalidate();
    if (state.state === 'starting') log.info('[model] starting the model service');
    else if (state.state === 'ready') logReady(state.url);
    else if (state.state === 'unavailable') log.warn(`[model] unavailable: ${state.error}  The site keeps working; the Design Studio uses its in-browser parser meanwhile.`);
  });

  return {
    mode,
    status: client.status,
    forward: client.forward,
    unavailableMessage,
    /** The address of the running service, or '' when there is none. */
    url: () => (resolve().state === 'ready' ? resolve().url : ''),
    /** Begin running (auto) or checking (external) the service. Returns at once; poll status() for the outcome. */
    start() {
      if (supervisor) supervisor.start();
      else if (mode === 'external') logReady(url || '(no address)');
    },
    async close() {
      await supervisor?.stop();
    },
  };
}
