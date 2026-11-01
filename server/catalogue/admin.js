/**
 * What the admin does with the catalogue (target D1: upload and manage designs): create a catalogue, send a PDF or photos, start the
 * processing, watch it, fix an item's label or product code or hide it, and choose which release is live. The web side (token, routes) is
 * server/catalogue/adminRoutes.js; the contract is catalogue/ARCHITECTURE.md sections 4.4, 4.5 and 7.
 *
 * The website never touches a PDF. `createUpload` makes a job (status `draft`) that names the files, and signs one upload address per file
 * for exactly the key `uploads/<jobId>/<safeName>`; the browser sends each file straight to Cloud Storage. `startJob` tells the ingest app on
 * Modal to run the job, which reads it from MongoDB. One job runs at a time: a second is refused while another is queued or running with a
 * heartbeat younger than 10 minutes; an older heartbeat means that job is dead, and it is marked failed so that it stops looking alive.
 *
 * Every write leaves a line in the sign-in's security log (`catalogue.*` events: who from, which catalogue / job / item; never a token).
 */
import crypto from 'node:crypto';
import { findAndUpdate, isDuplicateKey } from '../auth/db.js';
import { CatalogueError } from './errors.js';
import { isStoreDown, project } from './db.js';
import { ITEM_ID, JOB_ID, PRODUCT_ID, RELEASE_ID, SLUG, bad, parseItemPatch, parseNewCatalogue, plainLine, safeNameParts, stampedId } from './validate.js';

/** A queued or running job whose heartbeat is older than this is dead. */
export const STALE_MS = 10 * 60 * 1000;
/** Starting values, chosen and not measured (catalogue/ARCHITECTURE.md section 7). */
export const UPLOAD_LIMITS = Object.freeze({
  pdf: { maxFiles: 5, maxBytes: 300 * 1024 * 1024, types: { 'application/pdf': 'pdf' } },
  photos: { maxFiles: 200, maxBytes: 25 * 1024 * 1024, types: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } },
});
export const UPLOAD_LIFETIME_S = 2 * 60 * 60;
const JOB_OPTIONS = { segmentPhotos: false, captions: true, activate: false };
const JOB_STATUSES = ['draft', 'queued', 'running', 'succeeded', 'failed', 'cancelled'];
const EXTENSIONS = { 'application/pdf': ['pdf'], 'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/webp': ['webp'] };

const CATALOGUE_FIELDS = Object.freeze({ name: 1, kind: 1, note: 1, createdAt: 1, updatedAt: 1, activeRelease: 1, previousRelease: 1, featureVersions: 1, counts: 1 });
const JOB_FIELDS = Object.freeze({ catalogue: 1, kind: 1, status: 1, stage: 1, progress: 1, sources: 1, options: 1, createdAt: 1, startedAt: 1, heartbeatAt: 1, finishedAt: 1, error: 1, cancelRequested: 1, modalCallId: 1, log: 1, result: 1 });
const JOB_LIST_FIELDS = Object.freeze({ log: 0 });
const ITEM_FIELDS = Object.freeze({ catalogue: 1, itemId: 1, status: 1, label: 1, productId: 1, productIdSource: 1, subtype: 1, category: 1, finish: 1, description: 1, dominantHex: 1, captionModel: 1, captionVersion: 1, source: 1, images: 1, attributes: 1, releaseFirst: 1, jobId: 1, createdAt: 1, updatedAt: 1 });
const RELEASE_FIELDS = Object.freeze({ catalogue: 1, createdAt: 1, createdBy: 1, jobId: 1, parent: 1, nItems: 1, featureVersions: 1, pillars: 1, gcsPrefix: 1 });

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/**
 * @param {object} p
 * @param {ReturnType<typeof import('./db.js').createCatalogueDb>} p.db
 * @param {ReturnType<typeof import('./modalClient.js').createModalClient>} p.modal
 * @param {ReturnType<typeof import('./gcsSigner.js').createGcsSigner>} p.signer
 * @param {ReturnType<typeof import('./service.js').createService>} p.service
 * @param {{events: {record: Function}}} p.auth the security log
 * @param {{info: Function, warn: Function}} [p.log]
 * @param {() => number} [p.now]
 */
export function createAdmin({ db, modal, signer, service, auth, log, now = Date.now }) {
  const record = (type, ip, detail) => auth?.events?.record(type, { ip, detail });
  const notFound = (what) => new CatalogueError(404, 'not-found', `${what} was not found.`);

  /** Wrap a database failure into the 503 the routes send. */
  async function guarded(fn) {
    try {
      return await fn();
    } catch (error) {
      if (isStoreDown(error)) throw new CatalogueError(503, 'not-ready', 'The catalogue database is not connected right now.');
      throw error;
    }
  }
  const col = (name) => db.col(name);

  async function requireCatalogue(id, projection = { _id: 1 }) {
    if (!SLUG.test(id)) throw bad('That is not a catalogue name.');
    const doc = await (await col('catalogues')).findOne({ _id: id }, { projection });
    if (!doc) throw notFound('That catalogue');
    return doc;
  }

  // ------------------------------------------------------------------------------------------------ overview and check
  async function overview() {
    const configured = { modal: false, modalSearch: modal.configured().search, modalIngest: modal.configured().ingest, gcs: signer.ready().ok, database: db.connected() };
    configured.modal = configured.modalSearch && configured.modalIngest;
    let catalogues = [];
    let jobs = [];
    try {
      catalogues = (await (await col('catalogues')).find({}, { projection: CATALOGUE_FIELDS }).sort({ createdAt: 1 }).limit(100).toArray()).map((doc) => ({ ...doc, id: doc._id, live: typeof doc.activeRelease === 'string' }));
      jobs = await (await col('catalogue_jobs')).find({}, { projection: JOB_LIST_FIELDS }).sort({ createdAt: -1 }).limit(20).toArray();
    } catch (error) {
      if (!isStoreDown(error)) throw error;
      configured.database = false;
    }
    return { catalogues, jobs, configured };
  }

  async function check() {
    const t0 = Date.now();
    const databaseCheck = (async () => {
      try {
        await (await col('catalogues')).find({}, { projection: { _id: 1 } }).limit(1).toArray();
        return { ok: true, ms: Date.now() - t0, detail: `The ${db.kind === 'mongo' ? 'MongoDB' : 'in-memory'} catalogue database answers.` };
      } catch (error) {
        return { ok: false, ms: Date.now() - t0, detail: isStoreDown(error) ? 'The catalogue database is not connected.' : 'Reading the catalogue database failed.' };
      }
    })();
    const ping = (app) => (modal.configured()[app] ? modal.ping(app) : Promise.resolve({ ok: false, ms: 0, detail: `The ${app} service is not set up (${app === 'search' ? 'CATALOGUE_MODAL_SEARCH_URL' : 'CATALOGUE_MODAL_INGEST_URL'} and CATALOGUE_MODAL_KEY).` }));
    const [database, modalSearch, modalIngest] = await Promise.all([databaseCheck, ping('search'), ping('ingest')]);
    const gcsSigning = signer.selfTest();
    return { database, gcsSigning, modalSearch, modalIngest, billed: true, note: 'This check woke the Modal apps that are set up. A started app is billed until it has been idle for a few minutes, like any other start.' };
  }

  // ------------------------------------------------------------------------------------------------ catalogues
  async function createCatalogue(body, ip) {
    const { id, name, kind, note } = parseNewCatalogue(body);
    const t = now();
    try {
      await (await col('catalogues')).insertOne({ _id: id, name, kind, note, createdAt: t, updatedAt: t, activeRelease: null, previousRelease: null, featureVersions: null, counts: { items: 0, hidden: 0 } });
    } catch (error) {
      if (isDuplicateKey(error)) throw new CatalogueError(409, 'exists', 'There is already a catalogue with that id.');
      throw error;
    }
    service.invalidate();
    await record('catalogue.created', ip, id);
    return { id, name, kind, note, activeRelease: null, previousRelease: null, live: false, counts: { items: 0, hidden: 0 }, createdAt: t };
  }

  // ------------------------------------------------------------------------------------------------ uploads
  /** The files of an upload request, checked one by one. Returns what the job document and the signed addresses are made from. */
  function checkFiles(kind, files) {
    const limits = UPLOAD_LIMITS[kind];
    if (!Array.isArray(files) || !files.length) throw bad('"files" must list the files to send.');
    if (files.length > limits.maxFiles) throw bad(`At most ${limits.maxFiles} ${kind === 'pdf' ? 'PDFs' : 'photos'} can be sent in one job.`);
    const used = new Set();
    return files.map((file, i) => {
      const where = `File ${i + 1}`;
      if (file === null || typeof file !== 'object' || Array.isArray(file)) throw bad(`${where} must be {name, size, type}.`);
      const type = typeof file.type === 'string' ? file.type.trim().toLowerCase() : '';
      if (!limits.types[type]) throw bad(kind === 'pdf' ? `${where} must be a PDF (application/pdf).` : `${where} must be a JPEG, PNG or WebP photo.`);
      if (typeof file.name !== 'string' || !file.name.trim() || file.name.length > 300) throw bad(`${where} needs a name.`);
      const { stem, ext } = safeNameParts(file.name);
      if (!EXTENSIONS[type].includes(ext)) throw bad(`${where} ("${stem.slice(0, 30)}") must have a name that ends in .${limits.types[type]}.`);
      if (!Number.isInteger(file.size) || file.size < 1) throw bad(`${where} needs its size in bytes.`);
      if (file.size > limits.maxBytes) throw bad(`${where} is larger than the ${Math.floor(limits.maxBytes / 1024 / 1024)} MB a ${kind === 'pdf' ? 'PDF' : 'photo'} may be.`);
      let safe = `${stem}.${limits.types[type]}`;
      for (let n = 2; used.has(safe.toLowerCase()); n += 1) safe = `${stem}-${n}.${limits.types[type]}`;
      used.add(safe.toLowerCase());
      return { declared: plainLine(file.name.split(/[\\/]/).pop(), 200, `${where}'s name`) ?? safe, safe, type, size: file.size };
    });
  }

  function checkOptions(options) {
    if (options === undefined || options === null) return { ...JOB_OPTIONS };
    if (typeof options !== 'object' || Array.isArray(options)) throw bad('"options" must be an object.');
    const out = { ...JOB_OPTIONS };
    for (const [name, value] of Object.entries(options)) {
      if (!(name in JOB_OPTIONS)) throw bad(`"${name.slice(0, 30)}" is not an option (${Object.keys(JOB_OPTIONS).join(', ')}).`);
      if (typeof value !== 'boolean') throw bad(`The option "${name}" must be true or false.`);
      out[name] = value;
    }
    return out;
  }

  async function createUpload(body, ip) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('Send {catalogue, kind, options?, files}.');
    if (typeof body.catalogue !== 'string' || !SLUG.test(body.catalogue)) throw bad('"catalogue" must be the id of a catalogue.');
    if (body.kind !== 'pdf' && body.kind !== 'photos') throw bad('"kind" must be pdf or photos.');
    const options = checkOptions(body.options);
    const files = checkFiles(body.kind, body.files);
    if (!signer.ready().ok) throw new CatalogueError(503, 'storage-not-configured', `Uploads cannot be signed yet: ${signer.ready().problem} Run the admin check.`);
    await guarded(() => requireCatalogue(body.catalogue));
    const t = now();
    const jobId = stampedId('job', t, crypto.randomBytes(3).toString('hex'));
    let uploads;
    try {
      uploads = files.map((f) => {
        const key = `uploads/${jobId}/${f.safe}`;
        const signed = signer.signPut(key, { contentType: f.type, maxBytes: UPLOAD_LIMITS[body.kind].maxBytes, expiresS: UPLOAD_LIFETIME_S });
        return { name: f.declared, safeName: f.safe, key, url: signed.url, method: 'PUT', headers: signed.headers };
      });
    } catch {
      throw new CatalogueError(503, 'storage-not-configured', 'Uploads could not be signed. Run the admin check.');
    }
    await guarded(async () =>
      (await col('catalogue_jobs')).insertOne({
        _id: jobId,
        catalogue: body.catalogue,
        kind: body.kind,
        status: 'draft',
        stage: 'waiting',
        progress: { done: 0, total: 0, message: '' },
        sources: files.map((f, i) => ({ key: uploads[i].key, name: f.declared, bytes: f.size, sha256: null, kind: body.kind === 'pdf' ? 'pdf' : 'image' })),
        options,
        createdAt: t,
        startedAt: null,
        heartbeatAt: null,
        finishedAt: null,
        error: null,
        cancelRequested: false,
        modalCallId: null,
        log: [],
        result: null,
      }),
    );
    await record('catalogue.upload', ip, `${jobId} ${body.catalogue} ${body.kind} ${files.length} file${files.length === 1 ? '' : 's'}`);
    return { jobId, expiresAt: t + UPLOAD_LIFETIME_S * 1000, uploads };
  }

  // ------------------------------------------------------------------------------------------------ jobs
  const idOf = (id) => {
    if (typeof id !== 'string' || !JOB_ID.test(id)) throw bad('That is not a job id.');
    return id;
  };

  /** The jobs that are queued or running, other than `exceptId`. */
  async function activeJobs(jobs, exceptId) {
    return jobs.find({ status: { $in: ['queued', 'running'] }, _id: { $ne: exceptId } }, { projection: { status: 1, heartbeatAt: 1 } }).limit(20).toArray();
  }

  async function startJob(body, ip) {
    const jobId = idOf(body?.jobId);
    if (!modal.configured().ingest) throw new CatalogueError(503, 'modal-not-configured', 'The upload processing service is not set up (CATALOGUE_MODAL_INGEST_URL and CATALOGUE_MODAL_KEY).');
    return guarded(async () => {
      const jobs = await col('catalogue_jobs');
      const job = await jobs.findOne({ _id: jobId }, { projection: { status: 1, catalogue: 1, error: 1 } });
      if (!job) throw notFound('That job');
      // draft starts it; failed starts it again, which resumes it (paid work already done is not repeated: contract 4.5)
      if (job.status !== 'draft' && job.status !== 'failed') throw new CatalogueError(409, 'bad-state', `This job is ${job.status}, so it cannot be started.`);
      const t = now();
      const others = await activeJobs(jobs, jobId);
      const alive = (o) => t - (o.heartbeatAt ?? 0) < STALE_MS;
      const running = others.find(alive);
      if (running) throw new CatalogueError(409, 'busy', `Another job (${running._id}) is still ${running.status}. One job runs at a time.`);
      for (const dead of others) {
        // a job that stopped answering is over; marking it says so (and only if nothing changed since we looked)
        await jobs.updateOne({ _id: dead._id, status: dead.status, heartbeatAt: dead.heartbeatAt ?? null }, { $set: { status: 'failed', error: `It stopped answering (no sign of life for ${Math.round(STALE_MS / 60000)} minutes) and was set aside when ${jobId} was started.`, finishedAt: t } });
      }
      const back = job.status;
      const claimed = await findAndUpdate(jobs, { _id: jobId, status: back }, { $set: { status: 'queued', stage: 'waiting', error: null, cancelRequested: false, heartbeatAt: t, finishedAt: null, modalCallId: null } }, { returnDocument: 'after' });
      if (!claimed) throw new CatalogueError(409, 'bad-state', 'This job was started by someone else a moment ago.');
      const revert = (message) => jobs.updateOne({ _id: jobId, status: 'queued' }, { $set: { status: back, error: message, heartbeatAt: null } });
      // two admins starting two jobs at the same moment both got this far: the one that claimed later gives way
      const rivals = (await activeJobs(jobs, jobId)).filter((o) => alive(o) && (o.status === 'running' || (o.heartbeatAt ?? 0) < t || ((o.heartbeatAt ?? 0) === t && o._id < jobId)));
      if (rivals.length) {
        await revert(null);
        throw new CatalogueError(409, 'busy', `Another job (${rivals[0]._id}) was started at the same moment. One job runs at a time.`);
      }
      try {
        const { callId } = await modal.startIngest(jobId);
        if (callId) await jobs.updateOne({ _id: jobId }, { $set: { modalCallId: callId } });
      } catch (error) {
        // never stuck "queued": it goes back to what it was, with the reason (only if nothing has picked it up meanwhile)
        const message = `It could not be started: ${error.message} If it did start anyway, look at the job list before starting it again.`;
        await revert(message);
        log?.warn(`catalogue  starting ${jobId} failed (${error.reason ?? 'error'}); it is back to ${back}`);
        throw new CatalogueError(error.status ?? 503, error.reason ?? 'modal-unavailable', message, { retryAfter: error.retryAfter });
      }
      await record('catalogue.job-start', ip, jobId);
      return jobs.findOne({ _id: jobId }, { projection: JOB_LIST_FIELDS });
    });
  }

  async function listJobs({ status, catalogue, limit = 20 } = {}) {
    const filter = {};
    if (status !== undefined) {
      if (!JOB_STATUSES.includes(status)) throw bad(`"status" must be one of ${JOB_STATUSES.join(', ')}.`);
      filter.status = status;
    }
    if (catalogue !== undefined) {
      if (!SLUG.test(catalogue)) throw bad('"catalogue" is not a catalogue name.');
      filter.catalogue = catalogue;
    }
    return guarded(async () => ({ jobs: await (await col('catalogue_jobs')).find(filter, { projection: JOB_LIST_FIELDS }).sort({ createdAt: -1 }).limit(limit).toArray() }));
  }

  async function getJob(id) {
    return guarded(async () => {
      const job = await (await col('catalogue_jobs')).findOne({ _id: idOf(id) }, { projection: JOB_FIELDS });
      if (!job) throw notFound('That job');
      return job;
    });
  }

  async function cancelJob(id, ip) {
    const jobId = idOf(id);
    return guarded(async () => {
      const jobs = await col('catalogue_jobs');
      const job = await jobs.findOne({ _id: jobId }, { projection: { status: 1 } });
      if (!job) throw notFound('That job');
      const t = now();
      if (job.status === 'draft') {
        const done = await jobs.updateOne({ _id: jobId, status: 'draft' }, { $set: { status: 'cancelled', finishedAt: t } });
        if (!done.modifiedCount) throw new CatalogueError(409, 'bad-state', 'This job was started a moment ago; cancel it again.');
        await record('catalogue.job-cancel', ip, `${jobId} draft`);
        return { ok: true, notified: false, job: await jobs.findOne({ _id: jobId }, { projection: JOB_LIST_FIELDS }) };
      }
      if (job.status !== 'queued' && job.status !== 'running') throw new CatalogueError(409, 'bad-state', `This job is already ${job.status}.`);
      await jobs.updateOne({ _id: jobId, status: job.status }, { $set: { cancelRequested: true } });
      let notified = false;
      if (modal.configured().ingest) {
        try {
          await modal.cancelIngest(jobId);
          notified = true;
        } catch (error) {
          log?.warn(`catalogue  could not tell the ingest service to cancel ${jobId} (${error.reason ?? 'error'}); the request is recorded on the job`);
        }
      }
      await record('catalogue.job-cancel', ip, `${jobId} ${job.status}${notified ? '' : ' (service not told)'}`);
      return { ok: true, notified, job: await jobs.findOne({ _id: jobId }, { projection: JOB_LIST_FIELDS }) };
    });
  }

  // ------------------------------------------------------------------------------------------------ items
  const withThumb = (doc) => {
    const { _id, ...rest } = project(doc, ITEM_FIELDS);
    return { id: _id, ...rest, thumbUrl: service.pictureUrl(doc.images?.thumb?.key) };
  };

  /** How many items a catalogue shows, and how many of those are hidden: of the live release when there is one (an older release has fewer items). */
  async function computeCounts(catalogueId, activeId) {
    const items = await col('catalogue_items');
    if (!activeId) return { items: await items.countDocuments({ catalogue: catalogueId }), hidden: await items.countDocuments({ catalogue: catalogueId, status: 'hidden' }) };
    const releases = await (await col('catalogue_releases')).find({ catalogue: catalogueId }, { projection: { parent: 1, nItems: 1 } }).toArray();
    const byId = new Map(releases.map((r) => [r._id, r]));
    const chain = [];
    for (let at = byId.get(activeId), guard = 0; at && guard < 1000; at = at.parent ? byId.get(at.parent) : null, guard += 1) chain.push(at._id);
    const active = byId.get(activeId);
    return {
      items: Number.isInteger(active?.nItems) ? active.nItems : await items.countDocuments({ catalogue: catalogueId }),
      // an item belongs to the release that first had it and to every release built on that one
      hidden: chain.length ? await items.countDocuments({ catalogue: catalogueId, status: 'hidden', releaseFirst: { $in: chain } }) : 0,
    };
  }

  async function listItems(catalogueId, query = {}) {
    await guarded(() => requireCatalogue(catalogueId));
    const filter = { catalogue: catalogueId };
    if (query.status !== undefined) {
      if (query.status !== 'ok' && query.status !== 'hidden') throw bad('"status" must be ok or hidden.');
      filter.status = query.status;
    }
    if (query.after !== undefined) {
      if (!ITEM_ID.test(query.after)) throw bad('"after" must be an item id from a previous page.');
      filter._id = { $gt: `${catalogueId}|${query.after}` };
    }
    if (query.q !== undefined) {
      const q = query.q.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim();
      if (q.length > 60) throw bad('"q" can be at most 60 characters.');
      if (q) {
        // the start of the field or of a word in it, case ignored; the text is escaped, so it can only ever mean itself
        const rx = { $regex: `(^|[^A-Za-z0-9])${escapeRegex(q)}`, $options: 'i' };
        filter.$or = [{ label: rx }, { productId: rx }, { subtype: rx }];
      }
    }
    const limit = query.limit === undefined ? 50 : query.limit;
    return guarded(async () => {
      const docs = await (await col('catalogue_items')).find(filter, { projection: ITEM_FIELDS }).sort({ _id: 1 }).limit(limit + 1).toArray();
      const page = docs.slice(0, limit);
      return { items: page.map(withThumb), next: docs.length > limit ? page.at(-1).itemId : null };
    });
  }

  async function patchItem(catalogueId, itemId, body, ip) {
    if (!ITEM_ID.test(itemId ?? '')) throw bad('That is not an item id.');
    const patch = parseItemPatch(body);
    return guarded(async () => {
      await requireCatalogue(catalogueId);
      const items = await col('catalogue_items');
      const _id = `${catalogueId}|${itemId}`;
      const before = await items.findOne({ _id, catalogue: catalogueId }, { projection: { status: 1, 'source.pdfProductId': 1 } });
      if (!before) throw notFound('That item');
      const set = { updatedAt: now() };
      for (const name of ['label', 'status', 'attributes']) if (name in patch) set[name] = patch[name];
      if ('productId' in patch) {
        if (patch.productId !== null) {
          set.productId = patch.productId;
          set.productIdSource = 'admin';
        } else {
          // clearing the admin's code brings back the one read from the PDF's text, if there was one; it is never invented
          const fromPdf = before.source?.pdfProductId;
          set.productId = typeof fromPdf === 'string' && PRODUCT_ID.test(fromPdf) ? fromPdf : null;
          set.productIdSource = set.productId ? 'pdf-text' : null;
        }
      }
      const after = await findAndUpdate(items, { _id, catalogue: catalogueId }, { $set: set }, { returnDocument: 'after' });
      if (!after) throw notFound('That item');
      if ('status' in patch && patch.status !== before.status) {
        const catalogues = await col('catalogues');
        const cat = await catalogues.findOne({ _id: catalogueId }, { projection: { activeRelease: 1 } });
        await catalogues.updateOne({ _id: catalogueId }, { $set: { counts: await computeCounts(catalogueId, cat?.activeRelease ?? null), updatedAt: now() } });
        service.invalidate();
      }
      await record('catalogue.item-edit', ip, `${catalogueId} ${itemId} ${Object.keys(patch).join(',')}`);
      return withThumb(after);
    });
  }

  // ------------------------------------------------------------------------------------------------ releases
  async function listReleases(catalogueId) {
    return guarded(async () => {
      const cat = await requireCatalogue(catalogueId, { activeRelease: 1, previousRelease: 1 });
      const releases = await (await col('catalogue_releases')).find({ catalogue: catalogueId }, { projection: RELEASE_FIELDS }).sort({ createdAt: -1 }).limit(100).toArray();
      return { releases: releases.map((r) => ({ ...r, id: r._id, active: r._id === cat.activeRelease, previous: r._id === cat.previousRelease })), activeRelease: cat.activeRelease ?? null, previousRelease: cat.previousRelease ?? null };
    });
  }

  async function activateRelease(catalogueId, releaseId, ip) {
    if (!RELEASE_ID.test(releaseId ?? '')) throw bad('That is not a release id.');
    return guarded(async () => {
      const cat = await requireCatalogue(catalogueId, { activeRelease: 1, previousRelease: 1 });
      const release = await (await col('catalogue_releases')).findOne({ _id: releaseId, catalogue: catalogueId }, { projection: { nItems: 1, featureVersions: 1, pillars: 1 } });
      if (!release) throw notFound('That release');
      const pillars = release.pillars && typeof release.pillars === 'object' ? Object.keys(release.pillars) : [];
      if (!pillars.length) throw new CatalogueError(409, 'no-pillars', 'That release has no search vectors, so it cannot be made live.');
      const catalogues = await col('catalogues');
      if (cat.activeRelease === releaseId) return { ok: true, changed: false, catalogue: await catalogues.findOne({ _id: catalogueId }, { projection: CATALOGUE_FIELDS }) };
      const counts = await computeCounts(catalogueId, releaseId);
      const won = await findAndUpdate(
        catalogues,
        { _id: catalogueId, activeRelease: cat.activeRelease ?? null },
        { $set: { activeRelease: releaseId, previousRelease: cat.activeRelease ?? cat.previousRelease ?? null, featureVersions: release.featureVersions ?? null, counts, updatedAt: now() } },
        { returnDocument: 'after' },
      );
      if (!won) throw new CatalogueError(409, 'conflict', 'The live release was changed by someone else a moment ago. Reload and try again.');
      service.invalidate();
      await record('catalogue.release-activate', ip, `${catalogueId} ${releaseId} (was ${cat.activeRelease ?? 'none'})`);
      return { ok: true, changed: true, catalogue: project(won, CATALOGUE_FIELDS) };
    });
  }

  return { overview, check, createCatalogue, createUpload, startJob, listJobs, getJob, cancelJob, listItems, patchItem, listReleases, activateRelease };
}
