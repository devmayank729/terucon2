/** Start the real server for a test: temp project folder, temp env file, explicit environment, nothing shared. */
import fs from 'node:fs';
import { startServer } from '../../app.js';
import { captureProviders, SECRET } from './authKit.js';
import { request } from './http.js';
import { signInVia } from './signIn.js';
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
 * @param {object} [options.inspiration] inspiration-import overrides (a fake `fetcher` and `gallery`; see server/routes/inspiration.js)
 * @param {object} [options.catalogue] catalogue-search overrides (`modal`, `db`, `signer`, `now`; see server/catalogue/index.js and tests/helpers/fakeCatalogueModal.js)
 * @param {object} [options.auth] sign-in overrides (server/auth/index.js). By default the app gets code senders that keep what they
 *   send (`app.capture`) and a test secret, so `app.signIn()` works; the sign-in gate itself is NOT switched off.
 */
export async function startTestApp({ env = '', environ = {}, auth = {}, inspiration = {}, catalogue = {} } = {}) {
  const temp = makeTempRoot();
  fs.writeFileSync(temp.envPath, env);
  const log = collectLog();
  const capture = captureProviders();
  const started = await startServer({ root: temp.root, envPath: temp.envPath, environ, log, port: 0, host: '127.0.0.1', auth: { providers: capture.providers, secret: SECRET, ...auth }, inspiration, catalogue });
  const call = (path, options = {}) => request(started.port, { path, ...options });
  const signIn = (options) => signInVia(call, capture, options);
  return {
    ...started,
    ...temp,
    log,
    capture,
    signIn,
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
