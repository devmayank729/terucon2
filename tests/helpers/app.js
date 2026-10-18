/** Start the real server for a test: temp project folder, temp env file, explicit environment, nothing shared. */
import fs from 'node:fs';
import { startServer } from '../../app.js';
import { request } from './http.js';
import { makeTempRoot } from './tempRoot.js';

/** A logger that keeps what it is given. */
export function collectLog() {
  const lines = [];
  const add = (level) => (message) => lines.push(`${level} ${message}`);
  return { lines, info: add('info'), warn: add('warn'), error: add('error'), raw: add('raw') };
}

/**
 * @param {object} [options]
 * @param {string} [options.env] text of the env file
 * @param {Record<string, string>} [options.environ] the process environment the server sees (default: empty)
 * @param {object} [options.model] default: switched off
 * @param {object} [options.vertex] see createApp
 * @param {object} [options.auth] see createApp
 * @param {boolean} [options.startModel]
 */
export async function startTestApp({ env = '', environ = {}, model = { mode: 'off' }, vertex, auth, startModel = false } = {}) {
  const temp = makeTempRoot();
  fs.writeFileSync(temp.envPath, env);
  const log = collectLog();
  const started = await startServer({ root: temp.root, envPath: temp.envPath, environ, model, vertex, auth, log, port: 0, host: '127.0.0.1', startModel });
  const call = (path, options = {}) => request(started.port, { path, ...options });
  return {
    ...started,
    ...temp,
    log,
    request: call,
    get: (path, headers) => call(path, { headers }),
    post: (path, body, headers) => call(path, { method: 'POST', body, headers }),
    /** Rewrite the env file (the server notices on its next request). */
    writeEnv(text) {
      fs.writeFileSync(temp.envPath, text);
    },
    async stop() {
      await started.close();
      temp.cleanup();
    },
  };
}
