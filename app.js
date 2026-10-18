/**
 * The Terucon web server: the pages, the Materials media, the Google (Vertex / Gemini) proxy for the
 * Design Studio, and a streaming proxy to the Python model service. Start it with `npm start`.
 *
 *   createApp(options)     the Express app, nothing listening and no process spawned
 *   startServer(options)   createApp + listen + start the model service
 */
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, ROOT, SettingsManager } from './server/config/settings.js';
import { GoogleAuth } from './server/lib/googleAuth.js';
import { createLogger } from './server/lib/log.js';
import { SiteMap } from './server/lib/siteMap.js';
import { errorHandler, notFound } from './server/middleware/errorHandler.js';
import { guards } from './server/middleware/guards.js';
import { securityHeaders } from './server/middleware/headers.js';
import { createModel } from './server/model/index.js';
import { createApiRegistry, mountApi } from './server/routes/api.js';
import { mountDocs } from './server/routes/docs.js';
import { mountMedia } from './server/routes/media.js';
import { mountModelRoutes } from './server/routes/model.js';
import { mountPages } from './server/routes/pages.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const CLOSE_GRACE_MS = 2000;

/** The env file: the option, else TERUCON_ENV_FILE, else <root>/.env. A relative path is relative to the project folder. */
function resolveEnvFile(envPath, environ, root) {
  const chosen = envPath || (environ ?? process.env).TERUCON_ENV_FILE;
  return chosen ? path.resolve(root, chosen) : path.join(root, '.env');
}

/**
 * Build the Express app.
 *
 * Tests and embedding pass `environ` (replaces the process environment, which is then not consulted at all)
 * and `envPath` (a temp file) so the real .env and the real Google can never be reached.
 *
 * @param {object} [options]
 * @param {string} [options.root] project folder (site/site.json, pages/, media/, model/); default: this one
 * @param {string} [options.envPath] env file; default TERUCON_ENV_FILE, then <root>/.env
 * @param {Record<string, string>} [options.environ]
 * @param {{mode?: 'auto' | 'external' | 'off', url?: string, key?: string, python?: string, command?: string, args?: string[], startTimeoutMs?: number, backoffSeconds?: number[], killGraceMs?: number}} [options.model]
 *   overrides MODEL_SERVICE & co.; `command`/`args` replace "python -m terucon_model" (tests run a fake child)
 * @param {{info: Function, warn: Function, error: Function, raw: Function}} [options.log]
 * @param {object} [options.vertex] sleep, clock, connectTimeoutMs, readTimeoutMs, maxTotalMs, request: see lib/vertex.js
 * @param {object} [options.auth] now, timeoutMs, request: see lib/googleAuth.js
 * @returns {import('express').Express} with `app.locals.terucon = {settings(), site, model, close()}`
 */
export function createApp({ root = ROOT, envPath, environ, model: modelOptions, log = createLogger(), vertex: vertexOptions = {}, auth: authOptions = {} } = {}) {
  root = path.resolve(root);
  const envFile = resolveEnvFile(envPath, environ, root);
  const manager = new SettingsManager(envFile, environ, root);
  const site = SiteMap.load(root);
  const model = createModel({ root, settings: manager.get().model, overrides: modelOptions, environ, envFile, log });

  let auth = null;
  let authVersion = 0;
  const ctx = {
    root,
    site,
    log,
    model,
    version: VERSION,
    vertexOptions,
    settings: () => manager.get(),
    /** The token source for the current settings; rebuilt when the env file changes. */
    auth() {
      const s = manager.get();
      if (!auth || authVersion !== manager.version) {
        auth = new GoogleAuth(s.google, authOptions);
        authVersion = manager.version;
      }
      return auth;
    },
  };

  const app = express();
  app.disable('x-powered-by');
  // sendFile reads its ETag switch from this setting. A function that makes no tag keeps JSON answers (Gemini
  // renders can be tens of megabytes) from being hashed for nothing, while files still get validators.
  app.set('etag', () => undefined);
  app.set('case sensitive routing', true);
  app.set('strict routing', true);

  app.use(securityHeaders);
  app.use(guards(ctx));
  mountPages(app, ctx);
  mountDocs(app, ctx);
  mountMedia(app, ctx);
  ctx.api = createApiRegistry(app);
  mountApi(app, ctx);
  mountModelRoutes(app, ctx);
  ctx.api.fallback();
  app.use(notFound);
  app.use(errorHandler(ctx));

  app.locals.terucon = { settings: ctx.settings, site, model, close: () => model.close() };
  return app;
}

/**
 * Create the app, listen, and start the model service (unless `startModel` is false).
 * Rejects with the listen error (for example EADDRINUSE).
 * @param {object} [options] everything createApp takes, plus:
 * @param {number} [options.port] default PORT; 0 picks a free one
 * @param {string} [options.host] default HOST
 * @param {boolean} [options.startModel]
 * @returns {Promise<{server: http.Server, app: import('express').Express, port: number, close: () => Promise<void>}>}
 */
export async function startServer({ port, host, startModel = true, ...appOptions } = {}) {
  const app = createApp(appOptions);
  const settings = app.locals.terucon.settings();
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port ?? settings.port, host ?? settings.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (startModel) app.locals.terucon.model.start();

  let closing = null;
  const close = () => {
    closing ??= (async () => {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections();
      const forceful = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS);
      await closed;
      clearTimeout(forceful);
      await app.locals.terucon.close();
    })();
    return closing;
  };
  return { server, app, port: server.address().port, close };
}

function printBanner({ app, port }) {
  const { settings, site } = app.locals.terucon;
  const s = settings();
  const shown = s.host === '127.0.0.1' || s.host === '::1' ? 'localhost' : s.host;
  const url = (route) => `http://${shown}:${port}${route}`;
  const lines = ['', 'Terucon server', `  Site:              ${url(site.pages.home?.route ?? '/')}`];
  if (site.pages.studio) lines.push(`  Design Studio:     ${url(site.pages.studio.route)}`);
  if (site.docs.overview) lines.push(`  Project overview:  ${url(site.docs.overview.route)}`);
  lines.push(`  Settings file:     ${s.envPath}  (${s.envFileFound ? 'found' : 'NOT FOUND - copy .env.example to .env'})`);
  for (const line of describe(s)) lines.push('  ' + line);
  for (const warning of s.warnings) lines.push('  ! ' + warning);
  if (s.host === '0.0.0.0' || s.host === '::') {
    lines.push('  ! HOST makes this server reachable from your network. Anyone who can reach it can use your Google credentials.');
  }
  lines.push('  Press Ctrl+C to stop.', '');
  console.log(lines.join('\n'));
}

async function main() {
  let running;
  try {
    running = await startServer({ startModel: false });
  } catch (err) {
    if (err.syscall === 'listen') {
      console.log(`Could not start on port ${err.port ?? 'PORT'}: ${err.message}\nChange PORT in .env and try again.`);
    } else {
      console.error(`Terucon could not start: ${err.message}`);
    }
    process.exit(1);
  }
  printBanner(running);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      console.log('\nStopping...');
      await running.close();
      process.exit(0);
    });
  }
  running.app.locals.terucon.model.start();
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
