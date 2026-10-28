/**
 * The Terucon web server: the pages, the Materials media, a small JSON API and, in the same process, the Design Studio
 * (swatchroom/). Start it with `npm start`.
 *
 *   createApp(options)     the Express app, nothing listening, nothing connected
 *   startServer(options)   createApp + listen + start the studio's database connection
 */
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, ROOT, SettingsManager } from './server/config/settings.js';
import { createLogger } from './server/lib/log.js';
import { SiteMap } from './server/lib/siteMap.js';
import { loadSwatchroom } from './server/lib/swatchroom.js';
import { errorHandler, notFound } from './server/middleware/errorHandler.js';
import { guards } from './server/middleware/guards.js';
import { securityHeaders } from './server/middleware/headers.js';
import { studioShield } from './server/lib/studioShield.js';
import { mountAnalytics } from './server/routes/analytics.js';
import { createApiRegistry, mountApi } from './server/routes/api.js';
import { mountDocs } from './server/routes/docs.js';
import { mountMedia } from './server/routes/media.js';
import { comingSoon, mountPages } from './server/routes/pages.js';
import { mountStudioRoutes } from './server/routes/studio.js';

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
 * and `envPath` (a temp file) so the real .env can never be reached.
 *
 * The Design Studio is off unless asked for: loading it reads swatchroom/.env into the process environment and the studio
 * then connects to MongoDB and the GPU services, none of which a test of the pages should do.
 *
 * @param {object} [options]
 * @param {string} [options.root] project folder (site/site.json, pages/, media/, swatchroom/); default: this one
 * @param {string} [options.envPath] env file; default TERUCON_ENV_FILE, then <root>/.env
 * @param {Record<string, string>} [options.environ]
 * @param {{info: Function, warn: Function, error: Function, raw: Function}} [options.log]
 * @param {boolean | {dir?: string}} [options.swatchroom] mount the Design Studio: true for <root>/swatchroom, or {dir}
 * @returns {import('express').Express} with `app.locals.terucon = {settings(), site, studio, studioDir, requirePasscode, close()}`
 */
export function createApp({ root = ROOT, envPath, environ, log = createLogger(), swatchroom = false } = {}) {
  root = path.resolve(root);
  // The studio reads swatchroom/.env into process.env when it is loaded (that is how it is configured). Take this server's
  // view of the environment first, so the studio's PORT, HOST, ... can never become this server's own.
  if (swatchroom && !environ) environ = { ...process.env };
  const envFile = resolveEnvFile(envPath, environ, root);
  const manager = new SettingsManager(envFile, environ, root);
  const site = SiteMap.load(root);
  const studioDir = path.resolve(root, (typeof swatchroom === 'object' && swatchroom.dir) || 'swatchroom');
  // The studio's passcode is off unless STUDIO_REQUIRE_PASSCODE=on; with it off, studioShield (below) stands in front of the studio.
  // Decided once, here: the studio reads its settings only when it is loaded.
  const requirePasscode = manager.get().studio.requirePasscode;
  const studio = swatchroom ? loadSwatchroom({ dir: studioDir, log, requirePasscode }) : null;

  const ctx = {
    root,
    site,
    log,
    version: VERSION,
    settings: () => manager.get(),
    swatchroom: studio,
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', manager.get().trustProxy);
  // sendFile reads its ETag switch from this setting. A function that makes no tag keeps JSON answers from being hashed
  // for nothing, while files still get validators.
  app.set('etag', () => undefined);
  app.set('case sensitive routing', true);
  app.set('strict routing', true);

  app.use(securityHeaders);
  app.use(guards(ctx));
  mountPages(app, ctx);
  mountDocs(app, ctx);
  mountMedia(app, ctx);
  ctx.api = createApiRegistry(app, (apiPath) => studio?.ownsApi(apiPath) ?? false);
  mountApi(app, ctx);
  mountAnalytics(app, ctx);
  mountStudioRoutes(app, ctx);
  // The website's own /api answers its own misses (404 / 405 in its error shape); the studio's /api paths pass on to it.
  ctx.api.fallback();
  // The Design Studio: its /api/* (behind studioShield, or its own passcode when STUDIO_REQUIRE_PASSCODE=on), /js, /css, /fonts, /textures, /admin. After the pages and the
  // website's own API, so "/" and every route above stay the website's; before the Coming soon page, so its misses are
  // answered by the studio.
  let shield = null;
  if (studio && !requirePasscode) {
    shield = studioShield({ store: studio.roomStore(), limits: () => ctx.settings().studio.limits, log });
    app.use(shield);
  }
  if (studio) app.use(studio.app);
  app.use(comingSoon(ctx));
  app.use(notFound);
  app.use(errorHandler(ctx));

  app.locals.terucon = {
    settings: ctx.settings,
    site,
    studio,
    studioDir,
    requirePasscode,
    close: async () => {
      shield?.close();
      await studio?.close();
    },
  };
  return app;
}

/**
 * Create the app, listen, and start the studio's database connection (when the studio is mounted). Rejects with the listen
 * error (for example EADDRINUSE).
 * @param {object} [options] everything createApp takes, plus:
 * @param {number} [options.port] default PORT; 0 picks a free one
 * @param {string} [options.host] default HOST
 * @param {boolean} [options.startStudio] connect the studio's database now (default true); the command line starts it after the banner
 * @returns {Promise<{server: http.Server, app: import('express').Express, port: number, close: () => Promise<void>}>}
 */
export async function startServer({ port, host, startStudio = true, ...appOptions } = {}) {
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
  if (startStudio) app.locals.terucon.studio?.start();

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
  const { settings, site, studio, studioDir } = app.locals.terucon;
  const s = settings();
  const shown = s.host === '127.0.0.1' || s.host === '::1' ? 'localhost' : s.host;
  const url = (route) => `http://${shown}:${port}${route}`;
  const lines = ['', 'Terucon server', `  Site:              ${url(site.pages.home?.route ?? '/')}`];
  if (studio) {
    lines.push(`  Design Studio:     ${url(site.pages.studio.route)}  (Swatchroom, mounted from swatchroom/)`);
    lines.push(`  Studio admin:      ${url('/admin')}`);
    lines.push('  Scan models:       start the local ones with "npm run models" in a second terminal (README, "The scan models")');
  } else {
    lines.push(`  Design Studio:     NOT RUNNING - there is no studio at ${path.relative(ROOT, studioDir) || studioDir}/`);
  }
  if (site.docs.overview) lines.push(`  Project overview:  ${url(site.docs.overview.route)}`);
  lines.push(`  Settings file:     ${s.envPath}  (${s.envFileFound ? 'found' : 'NOT FOUND - copy .env.example to .env'})`);
  if (studio) {
    const studioEnv = path.join(studioDir, '.env');
    lines.push(`  Studio settings:   ${studioEnv}  (${fs.existsSync(studioEnv) ? 'found' : 'NOT FOUND - copy swatchroom/.env.example to swatchroom/.env'})`);
  }
  for (const line of describe(s)) lines.push('  ' + line);
  for (const warning of s.warnings) lines.push('  ! ' + warning);
  for (const warning of studio?.securityWarnings() ?? []) lines.push('  ! ' + warning);
  lines.push('  Press Ctrl+C to stop.', '');
  console.log(lines.join('\n'));
}

async function main() {
  // before the studio is loaded: see createApp
  const environ = { ...process.env };
  const studio = fs.existsSync(path.join(ROOT, 'swatchroom', 'server', 'index.js'));
  let running;
  try {
    running = await startServer({ environ, swatchroom: studio, startStudio: false });
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
  running.app.locals.terucon.studio?.start();
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
