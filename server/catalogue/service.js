/**
 * What a catalogue search IS, on the website's side (target C3 / C4 / C7 / C5, the contract is catalogue/ARCHITECTURE.md sections 5 to 7).
 *
 * The website does none of the heavy work. A photo or a sentence goes to the search app on Modal, which answers with item ids and scores;
 * this file turns that into what the browser shows:
 *
 *   1. find the catalogue's live release in MongoDB (id, release and kind only; remembered for 10 seconds),
 *   2. ask Modal for k + 15 results (at most 60), so that designs an admin has hidden can be dropped without leaving the list short,
 *   3. read the matching item documents with ONE query (only the fields a result shows), drop what is not `ok`, keep Modal's order, stop at k,
 *   4. sign a short-lived read address for each picture (the browser loads pictures straight from Cloud Storage; the site never carries them).
 *
 * Titles are computed here, never stored: the admin's label, else the AI's description of the material (marked as such), else "Catalogue
 * page N". `scores.final` is relative to the other results (the notebook min-max normalises each signal), so nothing here ever turns it
 * into a percentage.
 *
 * Also here, because they decide whether a search may happen: the status (cached 10 seconds), the per-account and per-address hourly
 * limits (admin-managed, server/auth/settings.js), and the cap on searches in flight at once.
 */
import { BROWSER_MAX_SIDE, LIMIT_DEFAULTS, MAX_PHOTO_BYTES, SEARCH_PROFILES, catalogueConfig } from './config.js';
import { isStoreDown } from './db.js';
import { CatalogueError } from './errors.js';
import { isSafeKey } from './gcsSigner.js';
import { createGate, Quota } from './quota.js';
import { HEX_COLOUR, ITEM_ID, RELEASE_ID } from './validate.js';

/** How many more results than the page needs are asked for, so hidden designs can be dropped without leaving the list short. */
export const OVERFETCH = 15;
export const FETCH_MAX = 60;
const TTL_MS = 10 * 1000;
const FAIL_TTL_MS = 3 * 1000;
/** A picture address works for this long. */
export const URL_LIFETIME_S = 3600;
/** Addresses are signed at the start of a 15-minute window, so the same picture has the same address all window long and the browser can cache it. */
export const URL_WINDOW_S = 900;
const READABLE_PREFIXES = ['crops/', 'thumbs/'];
const PREPROCESSING = ['perspective_rectified', 'center_crop', 'region', 'text'];
const SIGNAL_NAME = /^[a-z][a-z0-9_]{0,40}$/;

/** The only fields of an item a search result needs. */
export const ITEM_PROJECTION = Object.freeze({
  catalogue: 1,
  itemId: 1,
  status: 1,
  label: 1,
  productId: 1,
  productIdSource: 1,
  subtype: 1,
  category: 1,
  finish: 1,
  dominantHex: 1,
  'source.name': 1,
  'source.page': 1,
  'images.crop.key': 1,
  'images.crop.width': 1,
  'images.crop.height': 1,
  'images.thumb.key': 1,
  attributes: 1,
});

const text = (value, max = 200) => (typeof value === 'string' && value.trim() ? value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim().slice(0, max) : null);
const finiteOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const intOrNull = (value) => (Number.isInteger(value) && value >= 0 && value < 1e7 ? value : null);
const hexList = (value) => (Array.isArray(value) ? value.filter((h) => typeof h === 'string' && HEX_COLOUR.test(h)).slice(0, 12) : []);

/** Remember an async answer for `ttlMs` (and a failure for `failMs`); callers that arrive together share one call. */
function memo(fn, { ttlMs = TTL_MS, failMs = FAIL_TTL_MS, now }) {
  let at = -Infinity;
  let value;
  let error = null;
  let pending = null;
  const get = () => {
    if (pending) return pending;
    if (now() - at < (error ? failMs : ttlMs)) return error ? Promise.reject(error) : Promise.resolve(value);
    pending = fn()
      .then(
        (v) => {
          value = v;
          error = null;
          at = now();
          return v;
        },
        (e) => {
          error = e;
          at = now();
          throw e;
        },
      )
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  get.clear = () => {
    at = -Infinity;
    error = null;
  };
  return get;
}

function titleOf(doc) {
  const label = text(doc.label, 120);
  if (label) return { title: label, titleSource: 'label' };
  const caption = text(doc.subtype, 120);
  if (caption) return { title: caption, titleSource: 'caption' };
  const page = intOrNull(doc.source?.page);
  return { title: page === null ? 'Catalogue item' : `Catalogue page ${page}`, titleSource: 'page' };
}

/**
 * @param {object} options
 * @param {() => object} options.settings the website's settings, read on every use
 * @param {{settings: {saved: () => Record<string, any>}}} options.auth for the admin-managed limits
 * @param {ReturnType<typeof import('./db.js').createCatalogueDb>} options.db
 * @param {ReturnType<typeof import('./modalClient.js').createModalClient>} options.modal
 * @param {ReturnType<typeof import('./gcsSigner.js').createGcsSigner>} options.signer
 * @param {{info: Function, warn: Function}} [options.log]
 * @param {() => number} [options.now]
 */
export function createService({ settings, auth, db, modal, signer, log, now = Date.now }) {
  const config = () => catalogueConfig(settings());
  const quota = new Quota({ now });

  /** The admin's saved limits, else the starting values. Synchronous: it only reads what the settings last loaded. */
  function limits() {
    const saved = auth?.settings?.saved?.() ?? {};
    const pick = (key, fallback) => (Number.isInteger(saved[key]) ? saved[key] : fallback);
    return {
      searchPerHour: pick('catalogue.limit.searchPerHour', LIMIT_DEFAULTS.searchPerHour),
      textPerHour: pick('catalogue.limit.textPerHour', LIMIT_DEFAULTS.textPerHour),
      warmPerHour: pick('catalogue.limit.warmPerHour', LIMIT_DEFAULTS.warmPerHour),
      perAddress: pick('catalogue.limit.addressFactor', LIMIT_DEFAULTS.perAddress),
      maxConcurrent: pick('catalogue.maxConcurrent', LIMIT_DEFAULTS.maxConcurrent),
    };
  }
  const gate = createGate(() => limits().maxConcurrent);

  const quotaPairs = (group, asker) => {
    const l = limits();
    const each = group === 'search' ? l.searchPerHour : group === 'text' ? l.textPerHour : l.warmPerHour;
    const pairs = [[`ip:${asker.address}:${group}`, each * l.perAddress]];
    if (asker.account) pairs.unshift([`v:${asker.account}:${group}`, each]);
    return pairs;
  };

  const loggedAt = new Map();
  const logOnce = (key, message) => {
    if (now() - (loggedAt.get(key) ?? -Infinity) < 10 * 60 * 1000) return;
    loggedAt.set(key, now());
    log?.warn(message);
  };

  // ------------------------------------------------------------------------------------------------ what is live
  /** The live catalogues, oldest first: {id, name, kind, items, release}. */
  const liveList = memo(
    async () => {
      const col = await db.col('catalogues');
      const docs = await col.find({ activeRelease: { $ne: null } }, { projection: { name: 1, kind: 1, counts: 1, activeRelease: 1, createdAt: 1 } }).sort({ createdAt: 1 }).limit(50).toArray();
      return docs
        .filter((d) => typeof d.activeRelease === 'string' && RELEASE_ID.test(d.activeRelease))
        .map((d) => ({ id: d._id, name: text(d.name, 80) ?? d._id, kind: text(d.kind, 20) ?? 'other', items: Math.max(0, (intOrNull(d.counts?.items) ?? 0) - (intOrNull(d.counts?.hidden) ?? 0)), release: d.activeRelease }));
    },
    { now },
  );

  const lookups = new Map();
  /** One catalogue's live release, from MongoDB (id, release, kind and name only), remembered for 10 seconds. null when it is not live. */
  function lookup(slug) {
    if (!lookups.has(slug)) {
      if (lookups.size >= 200) lookups.delete(lookups.keys().next().value);
      lookups.set(
        slug,
        memo(
          async () => {
            const col = await db.col('catalogues');
            const doc = await col.findOne({ _id: slug }, { projection: { activeRelease: 1, kind: 1, name: 1 } });
            if (!doc || typeof doc.activeRelease !== 'string') return null;
            if (!RELEASE_ID.test(doc.activeRelease)) {
              logOnce(`release:${slug}`, `catalogue  ${slug} has a live release that is not a release id; it is not searched`);
              return null;
            }
            return { id: doc._id, release: doc.activeRelease, kind: text(doc.kind, 20) ?? 'other', name: text(doc.name, 80) ?? doc._id };
          },
          { now },
        ),
      );
    }
    return lookups.get(slug)();
  }

  const pickDefault = (list) => list.find((c) => c.kind === 'materials') ?? list[0] ?? null;

  /** Forget what was remembered about the catalogues (after an admin changes one). */
  function invalidate() {
    liveList.clear();
    for (const entry of lookups.values()) entry.clear();
    statusEntry = null;
  }

  // ------------------------------------------------------------------------------------------------ status
  let statusEntry = null;

  async function computeStatus() {
    const cfg = config();
    const shared = { limits: { maxPhotoBytes: MAX_PHOTO_BYTES, maxSide: BROWSER_MAX_SIDE }, profile: cfg.profile };
    if (!cfg.switchedOn) return { value: { enabled: false, ready: false, reasons: ['off'], default: null, catalogues: [], ...shared }, short: false };
    if (!modal.configured().search) return { value: { enabled: false, ready: false, reasons: ['modal-not-configured'], default: null, catalogues: [], ...shared }, short: false };
    const reasons = [];
    if (!signer.ready().ok) reasons.push('storage-not-configured');
    let list = [];
    let short = false;
    try {
      list = await liveList();
    } catch (error) {
      if (!isStoreDown(error)) logOnce('status-db', `catalogue  reading the catalogues failed (${String(error?.name ?? 'error').slice(0, 40)})`);
      reasons.push('database-unavailable');
      short = true;
    }
    if (!short && !list.length) reasons.push('no-live-catalogue');
    const chosen = pickDefault(list);
    return {
      value: { enabled: true, ready: reasons.length === 0, reasons, default: chosen?.id ?? null, catalogues: list.map(({ id, name, kind, items }) => ({ id, name, kind, items })), ...shared },
      short,
    };
  }

  /** The answer of GET /api/catalogue/status. Cheap: remembered for 10 seconds (3 when the database was down), and for as long as .env is unchanged. */
  async function status() {
    const ref = settings();
    if (statusEntry?.ref === ref) {
      if (statusEntry.pending) return statusEntry.pending;
      if (now() - statusEntry.at < (statusEntry.short ? FAIL_TTL_MS : TTL_MS)) return statusEntry.value;
    }
    const entry = { ref, at: now(), value: null, short: false, pending: null };
    statusEntry = entry;
    entry.pending = computeStatus().then((r) => {
      entry.value = r.value;
      entry.short = r.short;
      entry.at = now();
      entry.pending = null;
      return r.value;
    });
    return entry.pending;
  }

  // ------------------------------------------------------------------------------------------------ may a search happen?
  function assertEnabled() {
    if (!config().switchedOn || !modal.configured().search) throw new CatalogueError(503, 'catalogue-off', 'Catalogue search is not switched on here.');
  }

  /**
   * Everything that has to be true before a search is worth starting, in the order of cheapness: switched on, pictures can be signed, the
   * catalogue asked for (or the default one) has a live release. Throws the CatalogueError to send.
   * @returns {Promise<{id: string, release: string, kind: string, name: string}>}
   */
  async function prepare({ catalogue } = {}) {
    assertEnabled();
    if (!signer.ready().ok) throw new CatalogueError(503, 'not-ready', 'Catalogue pictures cannot be shown right now. Please try again later.');
    try {
      let id = catalogue;
      if (!id) {
        id = pickDefault(await liveList())?.id;
        if (!id) throw new CatalogueError(503, 'no-live-catalogue', 'There is no catalogue to search yet.');
      }
      const found = await lookup(id);
      if (!found) throw new CatalogueError(catalogue ? 404 : 503, 'no-live-catalogue', 'That catalogue is not available.');
      return found;
    } catch (error) {
      if (isStoreDown(error)) throw new CatalogueError(503, 'not-ready', 'The catalogue is not available right now. Please try again in a minute.');
      throw error;
    }
  }

  const rateLimited = (verdict) => new CatalogueError(429, 'rate-limited', 'You have searched a lot in the last hour. Please try again a little later.', { retryAfter: verdict.retryAfter });

  // ------------------------------------------------------------------------------------------------ pictures
  const urls = new Map();
  /** A signed read address for a picture key, or null when the key is not one the browser may be given (only crops/ and thumbs/). */
  function pictureUrl(key) {
    if (typeof key !== 'string' || !isSafeKey(key) || !READABLE_PREFIXES.some((p) => key.startsWith(p))) return null;
    const window = Math.floor(now() / 1000 / URL_WINDOW_S);
    const slot = `${window}|${key}`;
    let url = urls.get(slot);
    if (!url) {
      try {
        url = signer.signGet(key, { expiresS: URL_LIFETIME_S + URL_WINDOW_S, stableS: URL_WINDOW_S });
      } catch {
        logOnce('sign', 'catalogue  a picture address could not be signed (is the signing key usable? Admin > check)');
        return null;
      }
      if (urls.size >= 4000) urls.delete(urls.keys().next().value);
      urls.set(slot, url);
    }
    return url;
  }

  // ------------------------------------------------------------------------------------------------ results
  function toResultItem(doc, result, rank) {
    const { title, titleSource } = titleOf(doc);
    const signals = {};
    if (result.signals && typeof result.signals === 'object') {
      for (const [name, v] of Object.entries(result.signals).slice(0, 12)) {
        if (SIGNAL_NAME.test(name)) signals[name] = { sim: finiteOrNull(v?.sim), rank: intOrNull(v?.rank) };
      }
    }
    const crop = doc.images?.crop;
    const attributes = {};
    if (doc.attributes && typeof doc.attributes === 'object' && !Array.isArray(doc.attributes)) {
      for (const [name, v] of Object.entries(doc.attributes).slice(0, 20)) if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) attributes[name] = v;
    }
    return {
      rank,
      itemId: doc.itemId,
      catalogue: doc.catalogue,
      title,
      titleSource,
      productId: text(doc.productId, 40),
      productIdSource: doc.productIdSource === 'pdf-text' || doc.productIdSource === 'admin' ? doc.productIdSource : null,
      category: text(doc.category, 80),
      finish: text(doc.finish, 80),
      subtype: text(doc.subtype, 120),
      dominantHex: hexList(doc.dominantHex),
      source: { name: text(doc.source?.name, 200), page: intOrNull(doc.source?.page) },
      image: { thumbUrl: pictureUrl(doc.images?.thumb?.key), fullUrl: pictureUrl(crop?.key), width: intOrNull(crop?.width), height: intOrNull(crop?.height) },
      scores: { final: finiteOrNull(result.finalScore), signals },
      attributes,
    };
  }

  /** Modal's ordered ids -> the items to show, in the same order, at most k. */
  async function enrich(live, results, k) {
    const wanted = [];
    let unknown = 0;
    for (const r of results.slice(0, 100)) {
      if (r && typeof r === 'object' && typeof r.itemId === 'string' && ITEM_ID.test(r.itemId)) wanted.push(r);
      else unknown += 1;
    }
    let docs = [];
    if (wanted.length) {
      try {
        const col = await db.col('catalogue_items');
        docs = await col.find({ _id: { $in: wanted.map((r) => `${live.id}|${r.itemId}`) } }, { projection: ITEM_PROJECTION }).toArray();
      } catch (error) {
        if (isStoreDown(error)) throw new CatalogueError(503, 'not-ready', 'The catalogue is not available right now. Please try again in a minute.');
        throw error;
      }
    }
    const byId = new Map(docs.map((d) => [d._id, d]));
    const items = [];
    let hidden = 0;
    for (const r of wanted) {
      const doc = byId.get(`${live.id}|${r.itemId}`);
      if (!doc || doc.catalogue !== live.id) {
        unknown += 1;
      } else if (doc.status !== 'ok') {
        hidden += 1;
      } else if (items.length < k) {
        items.push(toResultItem(doc, r, items.length + 1));
      }
    }
    return { items, hidden, unknown };
  }

  function summary(answer, cfg, fallbackProfile) {
    const q = answer.query && typeof answer.query === 'object' ? answer.query : {};
    const warnings = Array.isArray(q.warnings) ? q.warnings.map((w) => text(w, 200)).filter(Boolean).slice(0, 5) : [];
    return {
      query: {
        preprocessing: PREPROCESSING.includes(q.preprocessing) ? q.preprocessing : null,
        dominantHex: hexList(q.dominantHex),
        profile: SEARCH_PROFILES.includes(answer.profile) ? answer.profile : fallbackProfile,
        signals: Array.isArray(q.signals) ? q.signals.filter((s) => typeof s === 'string' && SIGNAL_NAME.test(s)).slice(0, 12) : [],
      },
      warnings,
    };
  }

  async function finish(live, mode, k, answer, started, fallbackProfile) {
    const { items, hidden, unknown } = await enrich(live, answer.results, k);
    const total = Date.now() - started;
    log?.info(`catalogue  search ${live.id} mode=${mode} k=${k}: ${items.length} shown, ${hidden} hidden, ${unknown} unknown to the database, ${total} ms`);
    const { query, warnings } = summary(answer, config(), fallbackProfile);
    return { ok: true, catalogue: live.id, release: live.release, mode, items, query: { ...query, timingsMs: { total } }, warnings };
  }

  return {
    config,
    limits,
    status,
    assertEnabled,
    prepare,
    invalidate,
    pictureUrl,

    /** Whether this asker may do one more of `group` (search | text | warm) now. Counts nothing. */
    check(group, asker) {
      const verdict = quota.check(quotaPairs(group, asker));
      return verdict.ok ? verdict : { ...verdict, error: rateLimited(verdict) };
    },
    /** Count one of `group` for this asker. Returns a function that takes it back. */
    record(group, asker) {
      return quota.record(quotaPairs(group, asker).map(([key]) => key));
    },
    /** A place among the searches in flight (give it back with the returned function), or null when all are taken. */
    tryAcquire: () => gate.tryAcquire(),
    inFlight: () => gate.active(),

    /**
     * Search by photo. The photo was judged already (validate.judgePhoto).
     * @param {{live: {id: string, release: string}, params: ReturnType<typeof import('./validate.js').parseSearchParams>, bytes: Buffer, type: string}} p
     */
    async searchPhoto({ live, params, bytes, type }) {
      const started = Date.now();
      const cfg = config();
      const answer = await modal.search({
        bytes,
        contentType: type,
        query: { catalogue: live.id, release: live.release, mode: params.mode, profile: cfg.profile, k: Math.min(FETCH_MAX, params.k + OVERFETCH), point: params.point, radius: params.radius, box: params.box, category: params.category, finish: params.finish },
      });
      return finish(live, params.mode, params.k, answer, started, cfg.profile);
    },

    /** Search by words. @param {{live: object, body: ReturnType<typeof import('./validate.js').parseTextBody>}} p */
    async searchText({ live, body }) {
      const started = Date.now();
      const cfg = config();
      const request = { catalogue: live.id, release: live.release, text: body.text, k: Math.min(FETCH_MAX, body.k + OVERFETCH) };
      if (body.category.length) request.category = body.category.join(',');
      if (body.finish.length) request.finish = body.finish.join(',');
      const answer = await modal.searchText(request);
      return finish(live, typeof answer.mode === 'string' && /^[a-z]{2,12}$/.test(answer.mode) ? answer.mode : 'look', body.k, answer, started, cfg.profile);
    },

    /** Wake the search container (nobody waits for it). @returns {Promise<{warmed: boolean}>} */
    async warm() {
      const st = await status();
      if (!st.ready) return { warmed: false };
      return { warmed: modal.warm() };
    },

    close() {
      quota.close();
    },
  };
}
