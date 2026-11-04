/**
 * Test support for the catalogue search (server/catalogue/, catalogue/ARCHITECTURE.md): an HTTP fake of BOTH Modal apps, a fake signer, a
 * seeded in-memory catalogue and sample photos. The browser pages' end-to-end tests are meant to use the same pieces:
 *
 *   const fake = await startFakeCatalogueModal();
 *   const { db, reads } = makeMemoryDb();                    // the catalogue database, in memory; `reads` lists every read (to check projections)
 *   await seedCatalogue(db);                                 // catalogue "demo-materials", 12 items, a live release; ids match the fake's canned answers
 *   const app = await startTestApp({ env: fake.env(), catalogue: { db, signer: createFakeSigner() } });
 *   ... a signed-in visitor POSTs makeJpeg() to /api/catalogue/search ...
 *   fake.requests                                            // what Modal was asked, in order (never a photo: only its length, hash and first bytes)
 *   await fake.close(); await app.stop();
 *
 * The fake follows contract section 6: Bearer key (and the optional Modal-Key / Modal-Secret) checked, `GET /healthz` on both apps,
 * `POST /v1/search` (raw photo, query string), `POST /v1/search-text` (JSON), `POST /v1/ingest` and `/v1/ingest/cancel`, answers and errors in
 * the documented shapes. Its search answers are canned and deterministic: the first k of `fake.itemIds` in order, scores falling by a fixed
 * step. Trouble is scripted with fake.next(route, behaviour); a rush is made with fake.hold() / fake.release().
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { createCatalogueDb } from '../../server/catalogue/db.js';
import { startTestApp } from './app.js';

export const FAKE_KEY = 'fake-modal-key-0123456789';
export const SEED_CATALOGUE = 'demo-materials';
export const SEED_RELEASE = 'rel-20261101120000-abc123';
export const SEED_ITEM_IDS = Object.freeze(Array.from({ length: 12 }, (_, i) => `a1b2c3d4e5f6-p${String(i + 1).padStart(4, '0')}-i00`));

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const round = (n) => Math.round(n * 1e4) / 1e4;

/** An error in the shape Modal's apps use (contract section 6). */
export function modalError(status, reason, message = reason) {
  const names = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 409: 'ABORTED', 413: 'INVALID_ARGUMENT', 429: 'RESOURCE_EXHAUSTED', 500: 'INTERNAL', 503: 'UNAVAILABLE' };
  return { error: { code: status, status: names[status] ?? 'UNKNOWN', message, reason } };
}

/** The canned results of a search: the first k ids in order, with scores that fall by a fixed step. */
export function cannedResults({ ids, k, mode = 'look', text = false }) {
  return ids.slice(0, k).map((itemId, i) => {
    const signals = text
      ? { siglip_text: { sim: round(0.31 - i * 0.01), rank: i + 1 }, text_query: { sim: round(0.62 - i * 0.02), rank: i + 1 } }
      : mode === 'colour'
        ? { color_image: { sim: round(0.92 - i * 0.02), rank: i + 1 } }
        : { dino_image: { sim: round(0.71 - i * 0.02), rank: i + 1 }, siglip_image: { sim: round(0.55 - i * 0.015), rank: i + 1 }, color_image: { sim: round(0.9 - i * 0.03), rank: i + 1 } };
    return { rank: i + 1, itemId, finalScore: round(1 - i * 0.04), rrfScore: round(1 / (61 + i)), linearScore: round(1 - i * 0.05), signals };
  });
}

/**
 * Both Modal apps, on two local ports.
 * @param {object} [options]
 * @param {string} [options.key] the bearer key both apps want
 * @param {{key: string, secret: string} | null} [options.proxy] when set, the Modal-Key / Modal-Secret headers are wanted too
 * @param {string[]} [options.itemIds] what searches answer with, in order
 * @param {string[] | null} [options.releases] the releases the search app has: any other is 409 release-missing (null: any)
 */
export async function startFakeCatalogueModal({ key = FAKE_KEY, proxy = null, itemIds = [...SEED_ITEM_IDS], releases = null } = {}) {
  const requests = [];
  const script = new Map();
  const state = { inFlight: 0, maxInFlight: 0, itemIds: [...itemIds], calls: 0 };
  let gate = null;
  const sockets = new Set();

  const routeOf = (app, method, path) => {
    if (path === '/healthz') return `healthz-${app}`;
    if (app === 'search' && method === 'POST' && path === '/v1/search') return 'search';
    if (app === 'search' && method === 'POST' && path === '/v1/search-text') return 'search-text';
    if (app === 'ingest' && method === 'POST' && path === '/v1/ingest') return 'ingest';
    if (app === 'ingest' && method === 'POST' && path === '/v1/ingest/cancel') return 'ingest-cancel';
    return null;
  };

  const send = (res, status, body, headers = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
    res.end(text);
  };

  async function handle(app, req, res) {
    const url = new URL(req.url, 'http://fake');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const route = routeOf(app, req.method, url.pathname);
    const authorized = req.headers.authorization === `Bearer ${key}` && (!proxy || (req.headers['modal-key'] === proxy.key && req.headers['modal-secret'] === proxy.secret));
    let json = null;
    if (/json/.test(req.headers['content-type'] ?? '')) {
      try {
        json = JSON.parse(body.toString('utf8'));
      } catch {
        json = null;
      }
    }
    const record = {
      app,
      route,
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      contentType: req.headers['content-type'] ?? null,
      bodyBytes: body.length,
      bodySha256: body.length ? sha256(body) : null,
      bodyHead: body.subarray(0, 4).toString('hex'),
      json,
      authorized,
      sentProxyHeaders: Boolean(req.headers['modal-key'] || req.headers['modal-secret']),
      at: Date.now(),
    };
    requests.push(record);
    if (!authorized) return send(res, 401, modalError(401, 'unauthorized', 'The key was not accepted.'));
    if (!route) return send(res, 404, modalError(404, 'not-found', 'No such route.'));

    const scripted = script.get(route)?.shift() ?? script.get('*')?.shift();
    const searching = route === 'search' || route === 'search-text';
    if (searching) {
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    }
    try {
      if (searching && gate) await gate.promise;
      if (scripted?.delayMs) await new Promise((resolve) => setTimeout(resolve, scripted.delayMs));
      if (scripted?.hang) return await new Promise(() => {}); // never answers; the test's close() ends it
      if (scripted?.destroy) return req.socket.destroy();
      if (scripted?.raw !== undefined) return send(res, scripted.status ?? 200, scripted.raw);
      if (scripted?.body || scripted?.status >= 400 || scripted?.reason) {
        const status = scripted.status ?? 500;
        return send(res, status, scripted.body ?? modalError(status, scripted.reason ?? 'error'), scripted.retryAfter ? { 'Retry-After': String(scripted.retryAfter) } : {});
      }
      return answer(route, record, res, json);
    } finally {
      if (searching) state.inFlight -= 1;
    }
  }

  function answer(route, record, res, json) {
    if (route === 'healthz-search') return send(res, 200, { ok: true, ready: true, device: 'cpu', loadedReleases: [], expectedFeatureVersions: {}, containerAgeS: 3 });
    if (route === 'healthz-ingest') return send(res, 200, { ok: true, version: 'fake-1' });
    if (route === 'ingest') {
      if (typeof json?.jobId !== 'string') return send(res, 400, modalError(400, 'bad-request', 'jobId is needed'));
      state.calls += 1;
      return send(res, 202, { ok: true, callId: `fake-call-${state.calls}` });
    }
    if (route === 'ingest-cancel') return send(res, 200, { ok: true });
    // searches
    const text = route === 'search-text';
    const q = text ? json ?? {} : record.query;
    const release = q.release;
    if (releases && !releases.includes(release)) return send(res, 409, modalError(409, 'release-missing', 'That release is not in storage.'));
    if (!text && !/^image\/(jpeg|png|webp)/.test(record.contentType ?? '')) return send(res, 400, modalError(400, 'bad-image', 'Not a photo.'));
    if (!text && record.bodyBytes === 0) return send(res, 400, modalError(400, 'bad-image', 'Empty photo.'));
    const k = Math.max(1, Math.min(60, Number(q.k) || 8));
    const mode = text ? 'look' : q.mode === 'colour' ? 'colour' : 'look';
    const results = cannedResults({ ids: state.itemIds, k, mode, text });
    return send(res, 200, {
      ok: true,
      catalogue: q.catalogue,
      release,
      mode,
      profile: text ? 'fast' : q.profile ?? 'fast',
      query: {
        preprocessing: text ? 'text' : q.point || q.box ? 'region' : 'center_crop',
        dominantHex: ['#8a6a4a', '#d9c3a0'],
        signals: Object.keys(results[0]?.signals ?? {}),
        weights: {},
        timingsMs: { prepare: 3, encode: 20, vertex: 0, describe: 0, fuse: 1, total: 25 },
        warnings: [],
      },
      results,
    });
  }

  const apps = {};
  for (const name of ['search', 'ingest']) {
    const server = http.createServer((req, res) => {
      handle(name, req, res).catch(() => {
        if (!res.headersSent) send(res, 500, modalError(500, 'fake-failed'));
      });
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    apps[name] = { server, url: `http://127.0.0.1:${server.address().port}`, port: server.address().port };
  }

  const fake = {
    key,
    proxy,
    searchUrl: apps.search.url,
    ingestUrl: apps.ingest.url,
    /** every request either app got, in order: {app, route, method, path, query, contentType, bodyBytes, bodySha256, bodyHead, json, authorized, at} */
    requests,
    state,
    /** the requests of one route, e.g. fake.of('search') */
    of: (route) => requests.filter((r) => r.route === route),
    /**
     * Script the answer to the next request of `route` ('search', 'search-text', 'healthz-search', 'healthz-ingest', 'ingest', 'ingest-cancel' or '*'):
     * {status, reason} an error in Modal's shape, {status, body} anything, {raw} text that is not JSON, {retryAfter}, {delayMs}, {hang: true}, {destroy: true}.
     */
    next(route, behaviour) {
      if (!script.has(route)) script.set(route, []);
      script.get(route).push(behaviour);
      return fake;
    },
    /** Searches wait (and count as in flight) until release() is called. */
    hold() {
      if (gate) return;
      gate = { promise: null, open: null };
      gate.promise = new Promise((resolve) => {
        gate.open = resolve;
      });
    },
    release() {
      gate?.open();
      gate = null;
    },
    inFlight: () => state.inFlight,
    maxInFlight: () => state.maxInFlight,
    async waitForInFlight(n, timeoutMs = 5000) {
      const until = Date.now() + timeoutMs;
      while (state.inFlight < n) {
        if (Date.now() > until) throw new Error(`the fake Modal never had ${n} searches in flight (has ${state.inFlight})`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    /** What searches answer with, in order. */
    setItemIds(ids) {
      state.itemIds = [...ids];
    },
    reset() {
      requests.length = 0;
      script.clear();
      state.maxInFlight = 0;
    },
    /** The text of an env file that points the website at this fake (add a bucket and key file for the real signer). */
    env(extra = {}) {
      const lines = { CATALOGUE_MODAL_SEARCH_URL: fake.searchUrl, CATALOGUE_MODAL_INGEST_URL: fake.ingestUrl, CATALOGUE_MODAL_KEY: key, CATALOGUE_GCS_BUCKET: 'test-bucket', ...(proxy ? { CATALOGUE_MODAL_PROXY_KEY: proxy.key, CATALOGUE_MODAL_PROXY_SECRET: proxy.secret } : {}), ...extra };
      return `${Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
    },
    async close() {
      gate?.open();
      for (const socket of sockets) socket.destroy();
      await Promise.all(Object.values(apps).map((a) => new Promise((resolve) => a.server.close(resolve))));
    },
  };
  return fake;
}

// ------------------------------------------------------------------------------------------------------------- signer

/** A signer that signs nothing: deterministic addresses, a record of what was signed, and switches for "not ready". */
export function createFakeSigner({ ok = true, problem = 'The signing key is not set up.', host = 'https://signed.example' } = {}) {
  const calls = [];
  const signer = {
    calls,
    ok,
    ready: () => (signer.ok ? { ok: true, problem: '', clientEmail: 'fake@terucon-test.iam.example' } : { ok: false, problem }),
    signGet(key, options = {}) {
      calls.push({ method: 'GET', key, ...options });
      if (!signer.ok) throw new Error(problem);
      return `${host}/get/${key}?expires=${options.expiresS ?? 3600}&sig=fake`;
    },
    signPut(key, options) {
      calls.push({ method: 'PUT', key, ...options });
      if (!signer.ok) throw new Error(problem);
      return { url: `${host}/put/${key}?sig=fake`, headers: { 'Content-Type': options.contentType, 'x-goog-content-length-range': `0,${options.maxBytes}` }, expiresAt: Date.now() + (options.expiresS ?? 7200) * 1000 };
    },
    selfTest: () => (signer.ok ? { ok: true, detail: 'The fake signer works.' } : { ok: false, detail: problem }),
  };
  return signer;
}

// ------------------------------------------------------------------------------------------------------------ the data

/** An in-memory catalogue database; `reads` collects every read so a test can check that each one has a projection. */
export function makeMemoryDb({ now } = {}) {
  const reads = [];
  const db = createCatalogueDb({ now, observe: (event) => reads.push(event) });
  return { db, reads };
}

/**
 * A live catalogue: its document, one release with pillars, and `ids.length` items. The first item has a label and a product code, the
 * second only an AI description, the third nothing (so its title is "Catalogue page 3").
 * @param {ReturnType<typeof createCatalogueDb>} db
 * @param {object} [options]
 * @param {string} [options.catalogue]
 * @param {string} [options.release]
 * @param {string[]} [options.ids]
 * @param {string[]} [options.hidden] item ids that are hidden
 * @param {Record<string, object>} [options.overrides] fields to merge into an item
 * @param {boolean} [options.live] false: the catalogue exists but has no live release
 * @param {number} [options.createdAt]
 */
export async function seedCatalogue(db, { catalogue = SEED_CATALOGUE, release = SEED_RELEASE, ids = [...SEED_ITEM_IDS], hidden = [], overrides = {}, live = true, createdAt = 1_793_000_000_000, name = 'Demo materials', kind = 'materials' } = {}) {
  const catalogues = await db.col('catalogues');
  const items = await db.col('catalogue_items');
  const releases = await db.col('catalogue_releases');
  const featureVersions = { dino: 'dino-v1', siglip: 'siglip-v1', color: 'color-v1' };
  await releases.insertOne({ _id: release, catalogue, createdAt, createdBy: 'ingest', jobId: null, parent: null, nItems: ids.length, featureVersions, pillars: { dino: { count: ids.length, dim: 3072 }, siglip: { count: ids.length, dim: 1152 }, color: { count: ids.length, dim: 396 } }, gcsPrefix: `releases/${catalogue}/${release}/`, manifestSha256: 'ab'.repeat(32) });
  await catalogues.insertOne({ _id: catalogue, name, kind, note: null, createdAt, updatedAt: createdAt, activeRelease: live ? release : null, previousRelease: null, featureVersions: live ? featureVersions : null, counts: { items: ids.length, hidden: hidden.length } });
  for (const [i, itemId] of ids.entries()) {
    const page = i + 1;
    const doc = {
      _id: `${catalogue}|${itemId}`,
      catalogue,
      itemId,
      status: hidden.includes(itemId) ? 'hidden' : 'ok',
      label: i === 0 ? 'Emperor Dark' : null,
      productId: i === 0 ? 'SB804' : null,
      productIdSource: i === 0 ? 'admin' : null,
      subtype: i === 1 ? 'Warm oak laminate' : null,
      category: i % 2 ? 'laminate' : 'paint',
      finish: i % 3 ? 'matte' : 'gloss',
      description: null,
      dominantHex: ['#8a6a4a', '#d9c3a0'],
      proportions: [0.7, 0.3],
      captionModel: null,
      captionVersion: null,
      source: { name: 'Superbond colour image.pdf', sha256: 'cd'.repeat(32), page, itemIndex: 0, bbox: [26.8, 15, 568.2, 827], idBbox: null, pageWidth: 595, pageHeight: 842, rotation: 0, method: 'full-page', matchType: null, matchRelation: null, matchCost: null, inpainted: false, pdfProductId: null },
      images: { crop: { key: `crops/${catalogue}/${itemId}.png`, width: 541, height: 812, sha256: 'ef'.repeat(32), bytes: 123456 }, thumb: { key: `thumbs/${catalogue}/${itemId}.jpg`, width: 320, height: 480, bytes: 20480 } },
      attributes: {},
      releaseFirst: release,
      jobId: null,
      createdAt,
      updatedAt: createdAt,
      ...overrides[itemId],
    };
    await items.insertOne(doc);
  }
  return { catalogue, release, ids };
}

// ------------------------------------------------------------------------------------------------------- sample photos

/** A JPEG with a real header (size, markers) and an end marker, `extra` bytes of filler; `cut` leaves the end off. */
export function makeJpeg({ width = 800, height = 600, extra = 600, cut = false } = {}) {
  const u16 = (n) => Buffer.from([(n >> 8) & 255, n & 255]);
  const filler = Buffer.alloc(extra, 0x11);
  const parts = [
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0]), u16(16), Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([0xff, 0xc0]), u16(17), Buffer.from([8]), u16(height), u16(width), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    Buffer.from([0xff, 0xda]), u16(12), Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]),
    filler,
  ];
  if (!cut) parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A PNG with a real header and end chunk. `cut` leaves the end off. */
export function makePng({ width = 800, height = 600, extra = 600, cut = false } = {}) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.alloc(extra, 0x22))];
  if (!cut) parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** A WebP (extended format) with a real header. `cut` makes the file shorter than its own size field says. */
export function makeWebp({ width = 800, height = 600, extra = 600, cut = false } = {}) {
  const le24 = (n) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255]);
  const vp8x = Buffer.concat([Buffer.from('VP8X', 'latin1'), Buffer.from([10, 0, 0, 0]), Buffer.from([0, 0, 0, 0]), le24(width - 1), le24(height - 1)]);
  const data = Buffer.concat([Buffer.from('WEBP', 'latin1'), vp8x, Buffer.from('ALPH', 'latin1'), Buffer.from([extra & 255, (extra >> 8) & 255, 0, 0]), Buffer.alloc(extra, 0x33)]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length, 0);
  const whole = Buffer.concat([Buffer.from('RIFF', 'latin1'), size, data]);
  return cut ? whole.subarray(0, whole.length - 100) : whole;
}

// ------------------------------------------------------------------------------------------------------- a whole test app

/**
 * The website with the catalogue switched on, against a fake Modal, a seeded in-memory catalogue and a fake signer; plus one signed-in visitor.
 * @param {object} [options]
 * @param {object} [options.modal] options for startFakeCatalogueModal
 * @param {object | false} [options.seed] options for seedCatalogue; false: an empty catalogue database
 * @param {Record<string, string>} [options.env] extra variables for the env file
 * @param {string} [options.rawEnv] extra text for the env file
 * @param {object} [options.signer] a signer (default: a fake one)
 * @param {() => number} [options.now] the catalogue's clock
 * @param {Record<string, string>} [options.environ] the process environment the server sees
 * @param {boolean} [options.signIn] sign a visitor in (default true)
 * @param {object} [options.db] a catalogue database of your own (then nothing is seeded)
 */
export async function startCatalogueApp({ modal = {}, seed = {}, env = {}, rawEnv = '', signer = createFakeSigner(), now, environ = {}, signIn = true, db: dbOverride, fetch: fetchOverride } = {}) {
  const fake = await startFakeCatalogueModal(modal);
  const { db, reads } = dbOverride ? { db: dbOverride, reads: [] } : makeMemoryDb({ now });
  if (seed && !dbOverride) await seedCatalogue(db, seed);
  // `fetch` stands in for Cloud Storage when the designs' pictures are read (server/catalogue/designs.js)
  const app = await startTestApp({ env: fake.env(env) + rawEnv, environ, catalogue: { db, signer, ...(now ? { now } : {}), ...(fetchOverride ? { fetch: fetchOverride } : {}) } });
  const me = signIn ? await app.signIn() : null;
  const photo = (body = makeJpeg(), { query = '', type = 'image/jpeg', headers = {}, as = me } = {}) =>
    app.request(`/api/catalogue/search${query ? `?${query}` : ''}`, { method: 'POST', headers: { ...(as?.headers ?? {}), 'Content-Type': type, ...headers }, body });
  return {
    app,
    fake,
    db,
    reads,
    signer,
    me,
    photo,
    text: (body, { as = me, headers = {} } = {}) => app.post('/api/catalogue/search-text', body, { ...(as?.headers ?? {}), ...headers }),
    status: ({ as = me } = {}) => app.get('/api/catalogue/status', as?.headers),
    async stop() {
      await app.stop();
      await fake.close();
    },
  };
}
