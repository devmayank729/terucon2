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
import { createAuth } from './server/auth/index.js';
import { describe, ROOT, SettingsManager } from './server/config/settings.js';
import { installCrashHandlers } from './server/lib/crash.js';
import { createDist } from './server/lib/delivery.js';
import { createLogger } from './server/lib/log.js';
import { SiteMap } from './server/lib/siteMap.js';
import { loadSwatchroom } from './server/lib/swatchroom.js';
import { errorHandler, notFound } from './server/middleware/errorHandler.js';
import { canonicalApiPath } from './server/middleware/canonical.js';
import { compress } from './server/middleware/compress.js';
import { guards } from './server/middleware/guards.js';
import { securityHeaders } from './server/middleware/headers.js';
import { longLived, TEXTURE_CACHE } from './server/middleware/studioCache.js';
import { studioReference } from './server/lib/studioReference.js';
import { studioShield } from './server/lib/studioShield.js';
import { mountAnalytics } from './server/routes/analytics.js';
import { createApiRegistry, mountApi } from './server/routes/api.js';
import { mountAssets } from './server/routes/assets.js';
import { mountAuthRoutes } from './server/routes/auth.js';
import { mountAuthAdmin } from './server/routes/authAdmin.js';
import { mountBrand } from './server/routes/brand.js';
import { mountCatalogue } from './server/routes/catalogue.js';
import { mountCapture } from './server/routes/capture.js';
import { mountCatalogueUi } from './server/routes/catalogueUi.js';
import { mountDocs } from './server/routes/docs.js';
import { mountEnquiry } from './server/routes/enquiry.js';
import { mountInspiration } from './server/routes/inspiration.js';
import { mountMedia } from './server/routes/media.js';
import { comingSoon, mountPages } from './server/routes/pages.js';
import { mountStudioRoutes } from './server/routes/studio.js';
import { mountTerubot } from './server/routes/terubot.js';

/*
 * DELIVERY POLICY: what is cached for how long, and what is compressed how. Each rule is set in the file named in the last column;
 * this is the one place that lists them all. (Compression = `compress()` in server/middleware/compress.js: br or gzip, 1 KB threshold,
 * never images/video/fonts, never a Range or 304 answer. "Precompressed" = a .br / .gz copy made by tools/build-dist.js.)
 *
 *  What                                        Cache-Control                                         Validators                      Compression                    Set in
 *  ------------------------------------------  ----------------------------------------------------  ------------------------------  -----------------------------  ---------------------------
 *  /, /materials, /design-studio, /my-project  no-cache (members' pages: private, no-cache)          strong ETag per body, 304       precompressed br > gzip        routes/pages.js (dist/pages)
 *   - same, when dist/ is missing              no-cache                                              weak ETag + Last-Modified, 304  on the fly                     routes/pages.js (pages/*.html)
 *  /assets/<name>-<hash12>.<ext>               public, max-age=31536000, immutable                   weak ETag + Last-Modified       precompressed (js/css/svg/json) routes/assets.js (dist/assets)
 *   - a name without a hash                    public, no-cache                                      same                            same                           routes/assets.js
 *  /brand/*, /favicon.ico, /site.webmanifest   public, max-age=86400, stale-while-revalidate=604800  ETag + Last-Modified           on the fly (text types)        routes/brand.js (site/brand)
 *  /media/* (photos, videos; NOT hashed)       public, max-age=604800 (a week), Range works          ETag + Last-Modified            none (already compressed)      routes/media.js
 *  login, account, inspiration, finder, ...    no-cache (members' pages: private, no-cache)          weak ETag + Last-Modified       on the fly                     routes/pages.js (+ docs.js)
 *  /inspiration/assets/*, /catalogue-ui/*      no-cache                                              weak ETag + Last-Modified       on the fly                     routes/inspiration.js, catalogueUi.js
 *  /api/*                                      no-store                                              none (by design)                on the fly, over 1 KB          routes/api.js, lib/errors.js
 *  studio /js /css /admin /favicon.svg         no-cache (the studio's own)                           weak ETag + Last-Modified       on the fly                     swatchroom/server (unchanged)
 *  studio /fonts/*.woff2                       public, max-age=31536000, immutable (the studio's own) weak ETag + Last-Modified      none                           swatchroom/server (unchanged)
 *  studio /textures/*                          public, max-age=604800 (was no-cache)                 weak ETag + Last-Modified       none (png)                     middleware/studioCache.js
 *  5xx errors, 404s of /assets and /brand      no-store                                              none                            on the fly                     lib/errorPage.js, lib/errors.js
 */
const VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const CLOSE_GRACE_MS = 2000;
// Behind a proxy (Render's router, a load balancer) our keep-alive timeout has to be longer than the proxy's idle timeout, or the
// proxy reuses a connection we have just closed and the visitor gets a 502. Node's default is 5 s. 65 s is above the 60 s that
// proxies commonly use (not checked against Render's own setting), and headersTimeout has to be a little longer than that.
const KEEP_ALIVE_TIMEOUT_MS = 65_000;
const HEADERS_TIMEOUT_MS = 66_000;
// Whole REQUEST (headers and body) received within 5 minutes: Node's default, set here so it is on purpose. It does not limit how
// long an answer takes, so the studio's long calls (a scan or a render waits up to 90 s on the GPU services) are not affected;
// it bounds how long a slow or stalled upload (a phone photo, up to the 80 MB body limit) may take to arrive.
const REQUEST_TIMEOUT_MS = 300_000;

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
 * @param {object} [options.auth] sign-in overrides for tests (server/auth/index.js: db, providers, google, firm, zoho, secret)
 * @param {object} [options.inspiration] inspiration-import overrides for tests (server/routes/inspiration.js: fetcher, gallery)
 * @param {object} [options.catalogue] catalogue-search overrides for tests (server/catalogue/index.js: modal, db, signer, now), all optional
 * @param {object} [options.terubot] TeruBot overrides for tests (server/lib/terubot/index.js: gemini, shop, form, now; googleDir; rooms), all optional
 * @param {object} [options.capture] capture-from-a-phone overrides for tests (server/routes/capture.js: db, now, fetch), all optional
 * @returns {import('express').Express} with `app.locals.terucon = {settings(), site, studio, studioDir, requirePasscode, auth, close()}`
 */
export function createApp({ root = ROOT, envPath, environ, log = createLogger(), swatchroom = false, auth: authOverrides = {}, inspiration: inspirationOverrides = {}, catalogue: catalogueOverrides = {}, terubot: terubotOverrides = {}, capture: captureOverrides = {} } = {}) {
  root = path.resolve(root);
  // The studio reads swatchroom/.env into process.env when it is loaded (that is how it is configured), and so does TeruBot, whose
  // Google connection is the studio's (server/lib/terubot/gemini.js). Take this server's view of the environment first, so the
  // studio's PORT, HOST, ... can never become this server's own.
  if (!environ) environ = { ...process.env };
  const envFile = resolveEnvFile(envPath, environ, root);
  const manager = new SettingsManager(envFile, environ, root);
  const site = SiteMap.load(root);
  const studioDir = path.resolve(root, (typeof swatchroom === 'object' && swatchroom.dir) || 'swatchroom');
  // The studio's passcode is off unless STUDIO_REQUIRE_PASSCODE=on; with it off, studioShield (below) stands in front of the studio.
  // Decided once, here: the studio reads its settings only when it is loaded.
  const requirePasscode = manager.get().studio.requirePasscode;
  const studio = swatchroom ? loadSwatchroom({ dir: studioDir, log, requirePasscode }) : null;

  const dist = createDist(root, log);
  const ctx = {
    root,
    site,
    dist,
    log,
    version: VERSION,
    settings: () => manager.get(),
    swatchroom: studio,
    inspirationOverrides,
    catalogueOverrides,
    terubotOverrides,
    captureOverrides,
  };
  // Sign-in: accounts live in the studio's MongoDB when the studio is mounted, else in memory (AUTH_STORE). The routes a person may be
  // sent to after signing in are exactly the pages of the site map.
  ctx.auth = createAuth({
    settings: ctx.settings,
    mongoose: studio?.mongoose() ?? null,
    nextRoutes: [...Object.values(site.pages).map((p) => p.route), ...Object.values(site.docs).filter((d) => d.access === 'signed-in').map((d) => d.route)],
    log,
    overrides: authOverrides,
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', manager.get().trustProxy);
  // sendFile reads its ETag switch from this setting. A function that makes no tag keeps JSON answers from being hashed
  // for nothing, while files still get validators.
  app.set('etag', () => undefined);
  app.set('case sensitive routing', true);
  app.set('strict routing', true);

  app.use(securityHeaders);
  app.use(compress()); // early, so that everything below that is not precompressed is (server/middleware/compress.js)
  app.use(canonicalApiPath); // before anything that looks for "/api/": see the file
  app.use(guards(ctx));
  mountBrand(app, ctx); // /brand/*, /favicon.ico, /site.webmanifest
  mountAssets(app, ctx); // /assets/*: the built site's files, from dist/
  mountPages(app, ctx);
  mountDocs(app, ctx);
  mountMedia(app, ctx);
  ctx.api = createApiRegistry(app, (apiPath) => studio?.ownsApi(apiPath) ?? false);
  mountApi(app, ctx);
  mountAnalytics(app, ctx);
  mountStudioRoutes(app, ctx);
  mountAuthRoutes(app, ctx);
  mountEnquiry(app, ctx); // before the admin API, which lists what it keeps
  mountAuthAdmin(app, ctx);
  mountInspiration(app, ctx);
  mountCatalogue(app, ctx);
  mountCatalogueUi(app, ctx);
  ctx.terubot = mountTerubot(app, ctx); // after the catalogue: it uses ctx.catalogue when the catalogue is on
  mountCapture(app, ctx); // photos taken on a phone and sent to the person who asked (server/capture/)
  // The website's own /api answers its own misses (404 / 405 in its error shape); the studio's /api paths pass on to it.
  ctx.api.fallback();
  // The Design Studio: its /api/* (behind studioShield, or its own passcode when STUDIO_REQUIRE_PASSCODE=on), /js, /css, /fonts, /textures, /admin. After the pages and the
  // website's own API, so "/" and every route above stay the website's; before the Coming soon page, so its misses are
  // answered by the studio.
  let shield = null;
  // The costly and private studio routes need a signed-in account first (and put it on the request, for the shield to scope rooms by)
  if (studio) app.use(ctx.auth.apiGate);
  if (studio && !requirePasscode) {
    shield = studioShield({ store: studio.roomStore(), limits: () => ctx.auth.studioLimits(), log, identify: (req) => req.terucon?.user?.ownerId ?? null });
    app.use(shield);
  }
  // a render of a catalogue design gets the design's own photograph as one more image (after the shield has counted it, before the studio reads it)
  if (studio) app.use(studioReference({ designs: () => ctx.catalogue?.designs ?? null, limit: studio.aiBodyLimit(), log }));
  // the studio's textures are not worth a round trip per visit (server/middleware/studioCache.js); its other files keep its own policy
  if (studio) app.use(longLived(['/textures'], TEXTURE_CACHE));
  if (studio) app.use(studio.app);
  app.use(comingSoon(ctx));
  app.use(notFound);
  app.use(errorHandler(ctx));

  app.locals.terucon = {
    settings: ctx.settings,
    site,
    studio,
    studioDir,
    root,
    requirePasscode,
    dist,
    auth: ctx.auth,
    catalogue: ctx.catalogue,
    terubot: ctx.terubot,
    capture: ctx.capture,
    close: async () => {
      shield?.close();
      ctx.inspiration.close();
      ctx.catalogue.close();
      ctx.terubot.close();
      ctx.capture.close();
      ctx.auth.close();
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
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port ?? settings.port, host ?? settings.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (startStudio) app.locals.terucon.studio?.start();
  app.locals.terucon.auth.start();

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
  const built = app.locals.terucon.dist.status();
  lines.push(built.enabled ? `  Built site:        dist/ (${built.pages.length} pages, ${built.assets} files, built ${built.builtAt || 'at an unknown time'})` : '  Built site:        NOT BUILT - pages are served from pages/*.html, uncompressed and slow. Run: npm run build:dist');
  // dist/ is a copy: a page rebuilt into pages/ after it (npm run build:site) is not what visitors get until it is rebuilt too
  const newerThanDist = (key) => {
    const file = site.pages[key]?.file;
    try {
      return file ? fs.statSync(path.join(app.locals.terucon.root, file)).mtimeMs > built.builtMs : false;
    } catch {
      return false;
    }
  };
  const older = built.enabled ? built.pages.filter(newerThanDist) : [];
  if (older.length) lines.push(`  ! dist/ is older than pages/ for: ${older.join(', ')}. Visitors get the dist/ version. Run: npm run build:dist`);
  lines.push(`  Settings file:     ${s.envPath}  (${s.envFileFound ? 'found' : 'NOT FOUND - copy .env.example to .env'})`);
  if (studio) {
    const studioEnv = path.join(studioDir, '.env');
    lines.push(`  Studio settings:   ${studioEnv}  (${fs.existsSync(studioEnv) ? 'found' : 'NOT FOUND - copy swatchroom/.env.example to swatchroom/.env'})`);
  }
  for (const line of describe(s)) lines.push('  ' + line);
  const auth = app.locals.terucon.auth.status();
  const ways = [auth.channels.email && 'e-mail codes', auth.channels.sms && 'text-message codes', auth.channels.google && 'Google'].filter(Boolean);
  lines.push(`  Sign-in:           ${auth.ready ? `ready (${ways.join(', ')})` : 'NOT READY - nobody can sign in'}; ${auth.gate ? 'every page but the landing page needs it' : 'GATE OFF (AUTH_REQUIRED=off): every page is open'}; accounts kept ${auth.store === 'mongo' ? 'in MongoDB' : 'in memory only (lost at restart)'}`);
  lines.push(`  CRM:               ${auth.crm.mode === 'off' ? 'off (AUTH_CRM=off)' : auth.crm.credentials ? 'Zoho connected' : 'Zoho credentials not in .env yet - new sign-ups wait in a queue and are sent once they are'}`);
  const bot = app.locals.terucon.terubot.bot.state();
  lines.push(`  TeruBot:           ${bot.on ? `ready (model ${bot.model}, through the studio's Google key)` : s.terubot.enabled ? 'NOT READY - ' + bot.problem : 'off (TERUBOT=off)'}`);
  for (const problem of auth.problems) lines.push('  ! ' + problem);
  if (auth.developmentCodes) lines.push('  ! One-time codes are printed in this window instead of being sent (development only: this computer, not production). To send real ones set AUTH_EMAIL_PROVIDER / AUTH_SMS_PROVIDER in .env.');
  if (auth.developmentSecret) lines.push('  ! AUTH_SECRET is not set: a temporary one is used (development only), so sign-ins end at every restart.');
  if (!auth.adminApi) lines.push('  ! AUTH_ADMIN_TOKEN is not set: the sign-in admin API (rate limits and settings) is off.');
  if (s.nodeEnv === 'production' && s.trustProxy === 'loopback' && s.host !== '127.0.0.1') lines.push('  ! TRUST_PROXY is not set: behind Render or another proxy every visitor looks like the same address, so the per-address limits would block everybody. Set TRUST_PROXY=1.');
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
  // An error nobody caught: say so, finish the requests in flight, and leave with a failure code so the platform restarts us.
  installCrashHandlers({ log: createLogger(), close: running.close });
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
