/**
 * The real server with TeruBot's Gemini replaced by a script (tests/helpers/fakeGemini.js). Same shape as tests/helpers/app.js
 * (startTestApp) plus `terubot` overrides and the helpers a TeruBot test needs: chat(), status().
 */
import fs from 'node:fs';
import { startServer } from '../../app.js';
import { collectLog } from './app.js';
import { captureProviders, SECRET } from './authKit.js';
import { createFakeGemini } from './fakeGemini.js';
import { request } from './http.js';
import { signInVia } from './signIn.js';
import { makeTempRoot } from './tempRoot.js';

/**
 * @param {object} [options]
 * @param {object[]} [options.script] steps for the fake Gemini
 * @param {object} [options.gemini] a fake Gemini of your own (default: createFakeGemini(script))
 * @param {string} [options.env] text of the env file
 * @param {Record<string, string>} [options.environ]
 * @param {object} [options.terubot] more overrides (rooms, googleDir, now ...)
 * @param {object} [options.catalogue] catalogue overrides (tests/helpers/fakeCatalogueModal.js)
 * @param {object} [options.inspiration] the inspiration import's fakes ({gallery, fetcher}, as in tests/js/inspiration-routes.test.js)
 */
export async function startBotApp({ script, gemini, env = '', environ = {}, terubot = {}, catalogue = {}, inspiration } = {}) {
  const temp = makeTempRoot();
  fs.writeFileSync(temp.envPath, env);
  const log = collectLog();
  const capture = captureProviders();
  const fake = gemini ?? createFakeGemini(script);
  const started = await startServer({
    root: temp.root,
    envPath: temp.envPath,
    environ,
    log,
    port: 0,
    host: '127.0.0.1',
    auth: { providers: capture.providers, secret: SECRET },
    catalogue,
    ...(inspiration ? { inspiration } : {}),
    terubot: { gemini: fake, ...terubot },
  });
  const call = (path, options = {}) => request(started.port, { path, ...options });
  const signIn = (options) => signInVia(call, capture, options);
  let anon = 0;
  return {
    ...started,
    ...temp,
    log,
    capture,
    fake,
    signIn,
    request: call,
    /** POST /api/terubot/chat as `as` ({headers} from signIn) or as a visitor from its own address */
    chat(body, { as, ip } = {}) {
      const headers = { ...(as?.headers ?? { 'X-Forwarded-For': ip ?? `10.99.${Math.floor(++anon / 250)}.${(anon % 250) + 1}` }) };
      return call('/api/terubot/chat', { method: 'POST', body, headers });
    },
    status({ as } = {}) {
      return call('/api/terubot/status', { headers: as?.headers ?? {} });
    },
    say(text, extra = {}, options) {
      return this.chat({ messages: [{ role: 'user', text }], ...extra }, options);
    },
    writeEnv(text) {
      fs.writeFileSync(temp.envPath, text);
    },
    async stop() {
      await started.close();
      temp.cleanup();
    },
  };
}
