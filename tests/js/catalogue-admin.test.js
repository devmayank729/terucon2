import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { SEED_CATALOGUE, SEED_ITEM_IDS, SEED_RELEASE, startCatalogueApp, makeJpeg } from '../helpers/fakeCatalogueModal.js';

// The catalogue admin API (target D1) through the real server: the token, the uploads (names, sizes, types, signed addresses), a job's life,
// editing an item, and choosing the live release. Modal and Cloud Storage are fakes; the database is the in-memory stand-in.

const TOKEN = 'catalogue-admin-token-'.padEnd(48, 'q');
const ids = SEED_ITEM_IDS;
const MB = 1024 * 1024;
let visitor = 0;
const address = () => ({ 'X-Forwarded-For': `10.150.${Math.floor(visitor / 250)}.${(visitor += 1) % 250}` });

/** The app with the catalogue on, an admin token, and `adm()` to call the admin API as the admin. */
async function startAdminApp(options = {}) {
  const clock = { t: 1_800_000_000_000 };
  const c = await startCatalogueApp({ environ: { AUTH_ADMIN_TOKEN: TOKEN }, now: () => clock.t, signIn: false, ...options });
  const adm = (method, path, body, headers = {}) => c.app.request(`/api/catalogue/admin${path}`, { method, body, headers: { Authorization: `Bearer ${TOKEN}`, ...address(), ...headers } });
  const events = async () => (await c.app.get('/api/auth/admin/events?limit=500', { Authorization: `Bearer ${TOKEN}`, ...address() })).json().events;
  const jobsCol = () => c.db.col('catalogue_jobs');
  const itemsCol = () => c.db.col('catalogue_items');
  const catalogueDoc = async (id = SEED_CATALOGUE) => (await c.db.col('catalogues')).findOne({ _id: id });
  const upload = (body = { catalogue: SEED_CATALOGUE, kind: 'pdf', files: [{ name: 'Superbond colour image.pdf', size: 170 * MB, type: 'application/pdf' }] }) => adm('POST', '/uploads', body);
  const newDraft = async () => (await upload()).json().jobId;
  return { ...c, clock, adm, events, jobsCol, itemsCol, catalogueDoc, upload, newDraft };
}

const everyRoute = [
  ['GET', '/overview'], ['POST', '/check'], ['POST', '/catalogues'], ['POST', '/uploads'], ['POST', '/jobs'], ['GET', '/jobs'], ['GET', '/jobs/job-20261101120000-abc123'], ['POST', '/jobs/job-20261101120000-abc123/cancel'],
  ['GET', `/catalogues/${SEED_CATALOGUE}/items`], ['PATCH', `/catalogues/${SEED_CATALOGUE}/items/${ids[0]}`], ['GET', `/catalogues/${SEED_CATALOGUE}/releases`], ['POST', `/catalogues/${SEED_CATALOGUE}/releases/${SEED_RELEASE}/activate`],
];

describe('the token', () => {
  test('with no AUTH_ADMIN_TOKEN set, every admin route answers 404 as if it were not there', async () => {
    const c = await startCatalogueApp({ signIn: false });
    try {
      for (const [method, path] of everyRoute) {
        for (const headers of [{}, { Authorization: `Bearer ${TOKEN}` }, { Authorization: 'Bearer ' }]) {
          const r = await c.app.request(`/api/catalogue/admin${path}`, { method, body: method === 'GET' ? undefined : {}, headers: { ...headers, ...address() } });
          assert.equal(r.status, 404, `${method} ${path}`);
          assert.equal(r.json().error.message, 'No such API route.');
        }
      }
      assert.equal(c.fake.requests.length, 0);
    } finally {
      await c.stop();
    }
  });

  test('wrong tokens are refused with 401, counted per address in the sign-in admin\'s counter, and then the address is shut out', async () => {
    const a = await startAdminApp();
    try {
      for (const [method, path] of everyRoute) {
        const r = await a.adm(method, path, method === 'GET' ? undefined : {}, { Authorization: 'Bearer nope' });
        assert.equal(r.status, 401, `${method} ${path}`);
        assert.equal(r.json().error.reason, 'unauthorized');
        assert.match(r.headers['www-authenticate'], /^Bearer/);
      }
      for (const headers of [{}, { Authorization: TOKEN }, { Authorization: `Basic ${Buffer.from(`admin:${TOKEN}`).toString('base64')}` }, { Authorization: `bearer ${TOKEN}` }, { Authorization: `Bearer ${TOKEN}x` }, { Authorization: `Bearer ${TOKEN.slice(1)}` }]) {
        assert.equal((await a.adm('GET', '/overview', undefined, { Authorization: '', ...headers })).status, 401, JSON.stringify(headers).slice(0, 30));
      }
      assert.equal((await a.adm('GET', `/overview?token=${TOKEN}`, undefined, { Authorization: '' })).status, 401, 'never in the address');
      assert.equal((await a.adm('GET', '/overview')).status, 200);
      // twenty wrong tries from one address, across the sign-in admin API and this one: then even the right token is refused there
      const mine = { 'X-Forwarded-For': '198.51.100.99' };
      for (let i = 0; i < 12; i += 1) await a.c?.app;
      for (let i = 0; i < 12; i += 1) await a.app.request('/api/auth/admin/settings', { headers: { Authorization: `Bearer guess-${i}`, ...mine } });
      let last;
      for (let i = 0; i < 12; i += 1) last = await a.adm('GET', '/overview', undefined, { Authorization: `Bearer guess-${i}`, ...mine });
      assert.equal(last.status, 429);
      assert.ok(Number(last.headers['retry-after']) > 0);
      assert.equal((await a.adm('GET', '/overview', undefined, mine)).status, 429, 'brute force does not get a free pass at the end');
      assert.equal((await a.app.request('/api/auth/admin/settings', { headers: { Authorization: `Bearer ${TOKEN}`, ...mine } })).status, 429, 'the one counter covers both admin APIs');
      assert.equal((await a.adm('GET', '/overview', undefined, { 'X-Forwarded-For': '198.51.100.100' })).status, 200, 'other addresses are unaffected');
      const log = await a.events();
      assert.ok(log.filter((e) => e.type === 'admin.denied').length >= 20);
      assert.equal(JSON.stringify(log).includes(TOKEN), false);
      assert.equal(a.app.log.lines.join('\n').includes(TOKEN), false);
    } finally {
      await a.stop();
    }
  });

  test('the usual web rules: JSON only, same site only, the right method, one spelling of the path', async () => {
    const a = await startAdminApp();
    try {
      assert.equal((await a.adm('POST', '/catalogues', '{"id":"x"}', { 'Content-Type': 'text/plain' })).status, 415);
      assert.equal((await a.adm('POST', '/catalogues', { id: 'x' }, { Origin: 'https://evil.example' })).status, 403, 'a page on another site cannot drive the admin API, token or not');
      assert.equal((await a.adm('POST', '/catalogues', { id: 'x' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
      assert.equal((await a.adm('PATCH', `/catalogues/${SEED_CATALOGUE}/items/${ids[0]}`, '{}', { 'Content-Type': 'text/plain' })).status, 415);
      assert.equal((await a.adm('POST', '/overview', {})).status, 405);
      assert.equal((await a.adm('DELETE', '/jobs', undefined, { 'Content-Type': 'application/json' })).status, 405);
      assert.equal((await a.adm('GET', '/nothing-here')).status, 404);
      assert.equal((await a.app.request('/API/catalogue/admin/overview', { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 404);
      assert.equal((await a.adm('POST', '/catalogues', '{"id":')).status, 400);
    } finally {
      await a.stop();
    }
  });
});

describe('overview and check', () => {
  test('the overview lists catalogues, the last 20 jobs and what is set up, and never calls Modal', async () => {
    const a = await startAdminApp();
    try {
      for (let i = 0; i < 22; i += 1) {
        a.clock.t += 1000;
        await a.newDraft();
      }
      const r = await a.adm('GET', '/overview');
      assert.equal(r.status, 200);
      assert.equal(r.headers['cache-control'], 'no-store');
      const body = r.json();
      assert.deepEqual(body.configured, { modal: true, modalSearch: true, modalIngest: true, gcs: true, database: true });
      assert.equal(body.catalogues.length, 1);
      assert.deepEqual([body.catalogues[0]._id, body.catalogues[0].id, body.catalogues[0].live, body.catalogues[0].activeRelease, body.catalogues[0].counts], [SEED_CATALOGUE, SEED_CATALOGUE, true, SEED_RELEASE, { items: 12, hidden: 0 }]);
      assert.equal(body.jobs.length, 20);
      assert.ok(body.jobs[0].createdAt > body.jobs[19].createdAt, 'newest first');
      assert.ok(body.jobs.every((j) => !('log' in j)), 'the list leaves out each job\'s log');
      assert.equal(a.fake.requests.length, 0, 'the overview does not call Modal');
    } finally {
      await a.stop();
    }
  });

  test('the overview still answers when the database is down, and says so', async () => {
    const down = { kind: 'memory', connected: () => false, ready: async () => { throw new Error('x'); }, col: async () => { const { StoreUnavailableError } = await import('../../server/catalogue/db.js'); throw new StoreUnavailableError(); } };
    const a = await startAdminApp({ db: down });
    try {
      const r = await a.adm('GET', '/overview');
      assert.equal(r.status, 200);
      assert.deepEqual([r.json().catalogues, r.json().jobs, r.json().configured.database], [[], [], false]);
      assert.equal((await a.upload()).status, 503);
    } finally {
      await a.stop();
    }
  });

  test('check pings both Modal apps, the database and the signing key, and says that it woke them', async () => {
    const a = await startAdminApp();
    try {
      const r = await a.adm('POST', '/check', {});
      assert.equal(r.status, 200);
      const body = r.json();
      assert.equal(body.billed, true);
      assert.match(body.note, /woke the Modal apps.*billed/);
      for (const part of ['database', 'gcsSigning', 'modalSearch', 'modalIngest']) assert.equal(body[part].ok, true, part);
      assert.match(body.modalSearch.detail, /ready yes, device cpu/);
      assert.match(body.modalIngest.detail, /version fake-1/);
      assert.deepEqual(a.fake.requests.map((q) => `${q.app} ${q.path}`).sort(), ['ingest /healthz', 'search /healthz']);
      // each part fails on its own
      a.fake.next('healthz-search', { status: 500, reason: 'internal' });
      a.signer.ok = false;
      const bad = (await a.adm('POST', '/check', {})).json();
      assert.deepEqual([bad.modalSearch.ok, bad.modalIngest.ok, bad.gcsSigning.ok, bad.database.ok], [false, true, false, true]);
      assert.equal(bad.modalSearch.reason, 'modal-unavailable');
    } finally {
      await a.stop();
    }
  });

  test('check on an app that is not set up says what is missing and calls nothing', async () => {
    const a = await startAdminApp({ env: { CATALOGUE_MODAL_INGEST_URL: '' } });
    try {
      const body = (await a.adm('POST', '/check', {})).json();
      assert.equal(body.modalIngest.ok, false);
      assert.match(body.modalIngest.detail, /CATALOGUE_MODAL_INGEST_URL/);
      assert.equal(a.fake.requests.filter((q) => q.app === 'ingest').length, 0);
      assert.equal((await a.adm('GET', '/overview')).json().configured.modal, false);
    } finally {
      await a.stop();
    }
  });
});

describe('creating a catalogue', () => {
  test('the id, name, kind and note are checked; the catalogue starts with nothing live; a repeat is refused', async () => {
    const a = await startAdminApp();
    try {
      const bad = [{}, { id: 'A', name: 'x', kind: 'materials' }, { id: 'ab c', name: 'x', kind: 'materials' }, { id: 'a', name: 'x', kind: 'materials' }, { id: '-ab', name: 'x', kind: 'materials' }, { id: 'x'.repeat(40), name: 'x', kind: 'materials' }, { id: 'a/../b', name: 'x', kind: 'materials' },
        { id: 'new-one', name: '', kind: 'materials' }, { id: 'new-one', name: 'x'.repeat(81), kind: 'materials' }, { id: 'new-one', name: 'bad\u0000name', kind: 'materials' }, { id: 'new-one', name: 'ok', kind: 'furniture' }, { id: 'new-one', name: 'ok' }, { id: 'new-one', name: 'ok', kind: 'paint', note: 'x'.repeat(301) }, { id: 'new-one', name: 5, kind: 'paint' }, []];
      for (const body of bad) assert.equal((await a.adm('POST', '/catalogues', body)).status, 400, JSON.stringify(body).slice(0, 60));
      const ok = await a.adm('POST', '/catalogues', { id: 'exterior-2026', name: '  Exterior finishes  ', kind: 'exterior', note: 'Façades' });
      assert.equal(ok.status, 201);
      assert.deepEqual([ok.json().id, ok.json().name, ok.json().kind, ok.json().note, ok.json().live, ok.json().counts], ['exterior-2026', 'Exterior finishes', 'exterior', 'Façades', false, { items: 0, hidden: 0 }]);
      const doc = await a.catalogueDoc('exterior-2026');
      assert.deepEqual([doc.activeRelease, doc.previousRelease, doc.featureVersions, doc.createdAt, doc.updatedAt], [null, null, null, a.clock.t, a.clock.t]);
      const again = await a.adm('POST', '/catalogues', { id: 'exterior-2026', name: 'Other', kind: 'other' });
      assert.equal(again.status, 409);
      assert.equal(again.json().error.reason, 'exists');
      assert.equal((await a.adm('POST', '/catalogues', { id: 'quiet-one', name: 'No note', kind: 'other' })).json().note, null);
      assert.ok((await a.events()).some((e) => e.type === 'catalogue.created' && e.detail === 'exterior-2026'));
      // it is not live, so clients do not see it
      assert.deepEqual((await a.status({ as: await a.app.signIn() })).json().catalogues.map((x) => x.id), [SEED_CATALOGUE]);
    } finally {
      await a.stop();
    }
  });
});

describe('uploads', () => {
  const pdf = (over = {}) => ({ name: 'Superbond colour image.pdf', size: 170 * MB, type: 'application/pdf', ...over });
  const photo = (over = {}) => ({ name: 'living room.jpg', size: 3 * MB, type: 'image/jpeg', ...over });

  test('a PDF: a draft job is made and one signed address, for exactly one key, with the headers the browser must send', async () => {
    const a = await startAdminApp();
    try {
      const r = await a.upload();
      assert.equal(r.status, 201, r.text);
      assert.equal(r.headers['cache-control'], 'no-store');
      const body = r.json();
      assert.match(body.jobId, /^job-\d{14}-[0-9a-f]{6}$/);
      assert.equal(body.expiresAt, a.clock.t + 7200 * 1000);
      assert.equal(body.uploads.length, 1);
      const [u] = body.uploads;
      assert.deepEqual([u.name, u.safeName, u.method], ['Superbond colour image.pdf', 'Superbond_colour_image.pdf', 'PUT']);
      assert.equal(u.key, `uploads/${body.jobId}/Superbond_colour_image.pdf`, 'the key is relative: the signer adds the prefix');
      assert.equal(u.url, `https://signed.example/put/${u.key}?sig=fake`);
      assert.deepEqual(u.headers, { 'Content-Type': 'application/pdf', 'x-goog-content-length-range': `0,${300 * MB}` });
      assert.deepEqual(a.signer.calls.map(({ method, key, contentType, maxBytes, expiresS }) => ({ method, key, contentType, maxBytes, expiresS })), [{ method: 'PUT', key: u.key, contentType: 'application/pdf', maxBytes: 300 * MB, expiresS: 7200 }]);
      const job = await (await a.jobsCol()).findOne({ _id: body.jobId });
      assert.deepEqual([job.status, job.stage, job.catalogue, job.kind, job.cancelRequested, job.modalCallId, job.error, job.startedAt, job.heartbeatAt, job.finishedAt, job.result, job.log, job.createdAt], ['draft', 'waiting', SEED_CATALOGUE, 'pdf', false, null, null, null, null, null, null, [], a.clock.t]);
      assert.deepEqual(job.sources, [{ key: u.key, name: 'Superbond colour image.pdf', bytes: 170 * MB, sha256: null, kind: 'pdf' }]);
      assert.deepEqual(job.options, { segmentPhotos: false, captions: true, activate: false });
      assert.equal(a.fake.requests.length, 0, 'the website never touches the PDF, and Modal hears nothing yet');
      assert.ok((await a.events()).some((e) => e.type === 'catalogue.upload' && e.detail.startsWith(body.jobId)));
    } finally {
      await a.stop();
    }
  });

  test('photos: limits of their own, names made safe and unique, options checked', async () => {
    const a = await startAdminApp();
    try {
      const names = ['living room.jpg', 'Living Room.JPG', '../../etc/passwd.png', 'C:\\Users\\me\\My Plan (final).webp', '.hidden.jpeg', 'ünïcode — name.jpg', '日本語.png'];
      const types = ['image/jpeg', 'image/jpeg', 'image/png', 'image/webp', 'image/jpeg', 'image/jpeg', 'image/png'];
      const r = await a.upload({ catalogue: SEED_CATALOGUE, kind: 'photos', options: { segmentPhotos: true, captions: false }, files: names.map((name, i) => ({ name, size: 5 * MB, type: types[i] })) });
      assert.equal(r.status, 201, r.text);
      const keys = r.json().uploads.map((u) => u.key.replace(/^uploads\/job-\d{14}-[0-9a-f]{6}\//, ''));
      assert.deepEqual(keys, ['living_room.jpg', 'Living_Room-2.jpg', 'passwd.png', 'My_Plan_final.webp', 'hidden.jpg', 'n_nicode_name.jpg', 'file.png']);
      assert.deepEqual(r.json().uploads.map((u) => u.headers['x-goog-content-length-range']), Array(7).fill(`0,${25 * MB}`));
      assert.deepEqual(r.json().uploads.map((u) => u.name), ['living room.jpg', 'Living Room.JPG', 'passwd.png', 'My Plan (final).webp', '.hidden.jpeg', 'ünïcode — name.jpg', '日本語.png'], 'the name the browser gave, minus any folder, for it to match its files');
      const job = await (await a.jobsCol()).findOne({ _id: r.json().jobId });
      assert.deepEqual([job.kind, job.options, job.sources.every((s) => s.kind === 'image')], ['photos', { segmentPhotos: true, captions: false, activate: false }, true]);
      const many = Array.from({ length: 200 }, (_, i) => photo({ name: `p${i}.jpg` }));
      assert.equal((await a.upload({ catalogue: SEED_CATALOGUE, kind: 'photos', files: many })).status, 201);
      assert.equal((await a.upload({ catalogue: SEED_CATALOGUE, kind: 'photos', files: [...many, photo()] })).status, 400, '201 photos are too many');
    } finally {
      await a.stop();
    }
  });

  test('everything wrong is refused before a job is made or an address signed', async () => {
    const a = await startAdminApp();
    try {
      const base = { catalogue: SEED_CATALOGUE, kind: 'pdf', files: [pdf()] };
      const bad = {
        'no body': null, 'a list': [], 'no catalogue': { ...base, catalogue: undefined }, 'a catalogue that is not a name': { ...base, catalogue: 'Not A Slug' }, 'no kind': { ...base, kind: undefined }, 'an unknown kind': { ...base, kind: 'video' },
        'no files': { ...base, files: undefined }, 'an empty list': { ...base, files: [] }, 'files that is not a list': { ...base, files: 'a.pdf' }, 'a file that is not an object': { ...base, files: ['a.pdf'] }, 'six PDFs': { ...base, files: Array.from({ length: 6 }, (_, i) => pdf({ name: `a${i}.pdf` })) },
        'a text file': { ...base, files: [pdf({ name: 'notes.txt', type: 'text/plain' })] }, 'a PDF that says it is an image': { ...base, files: [pdf({ type: 'image/jpeg' })] }, 'a photo type in a PDF job': { ...base, files: [photo()] },
        'an executable': { ...base, files: [pdf({ name: 'run.exe', type: 'application/x-msdownload' })] }, 'a PDF named .exe': { ...base, files: [pdf({ name: 'virus.exe' })] }, 'no extension': { ...base, files: [pdf({ name: 'catalogue' })] }, 'a double extension that ends wrong': { ...base, files: [pdf({ name: 'a.pdf.exe' })] },
        'no name': { ...base, files: [pdf({ name: undefined })] }, 'an empty name': { ...base, files: [pdf({ name: '   ' })] }, 'a name of 301 characters': { ...base, files: [pdf({ name: `${'a'.repeat(297)}.pdf` })] },
        'no size': { ...base, files: [pdf({ size: undefined })] }, 'size 0': { ...base, files: [pdf({ size: 0 })] }, 'a negative size': { ...base, files: [pdf({ size: -5 })] }, 'a fractional size': { ...base, files: [pdf({ size: 1.5 })] }, 'a size as text': { ...base, files: [pdf({ size: '5' })] }, 'a PDF over 300 MB': { ...base, files: [pdf({ size: 300 * MB + 1 })] },
        'a photo over 25 MB': { catalogue: SEED_CATALOGUE, kind: 'photos', files: [photo({ size: 25 * MB + 1 })] }, 'a GIF': { catalogue: SEED_CATALOGUE, kind: 'photos', files: [photo({ name: 'a.gif', type: 'image/gif' })] }, 'a PDF in a photo job': { catalogue: SEED_CATALOGUE, kind: 'photos', files: [pdf()] },
        'a name that does not match its type': { catalogue: SEED_CATALOGUE, kind: 'photos', files: [photo({ name: 'a.png' })] }, 'an unknown option': { ...base, options: { turbo: true } }, 'an option that is not true or false': { ...base, options: { captions: 'yes' } }, 'options that are a list': { ...base, options: [] },
      };
      for (const [what, body] of Object.entries(bad)) {
        const r = await a.upload(body);
        assert.equal(r.status, 400, what);
        assert.equal(r.json().error.reason, 'bad-request', what);
      }
      assert.equal((await a.upload({ ...base, catalogue: 'no-such-catalogue' })).status, 404);
      assert.equal(a.signer.calls.length, 0, 'nothing was signed');
      assert.equal((await (await a.jobsCol()).find({}).toArray()).length, 0, 'no job was made');
      // sizes exactly at the limit are fine, and the type is case-insensitive
      assert.equal((await a.upload({ ...base, files: [pdf({ size: 300 * MB, type: 'Application/PDF' })] })).status, 201);
      const big = await a.adm('POST', '/uploads', { ...base, junk: 'x'.repeat(130 * 1024) });
      assert.equal(big.status, 413);
    } finally {
      await a.stop();
    }
  });

  test('if the signing key is not usable, nothing is made and the admin is told how to find out why', async () => {
    const a = await startAdminApp();
    try {
      a.signer.ok = false;
      const r = await a.upload();
      assert.equal(r.status, 503);
      assert.equal(r.json().error.reason, 'storage-not-configured');
      assert.match(r.json().error.message, /check/i);
      assert.equal((await (await a.jobsCol()).find({}).toArray()).length, 0);
    } finally {
      await a.stop();
    }
  });
});

describe('a job\'s life', () => {
  test('a draft is started: queued, with a heartbeat, handed to Modal; a second job waits while it runs', async () => {
    const a = await startAdminApp();
    try {
      const first = await a.newDraft();
      const second = await a.newDraft();
      const started = await a.adm('POST', '/jobs', { jobId: first });
      assert.equal(started.status, 202, started.text);
      assert.deepEqual([started.json().ok, started.json().job.status, started.json().job.modalCallId, started.json().job.heartbeatAt], [true, 'queued', 'fake-call-1', a.clock.t]);
      assert.deepEqual(a.fake.of('ingest').map((q) => q.json), [{ jobId: first }]);
      assert.equal(a.fake.of('ingest')[0].authorized, true);
      // the Modal side moves it on and keeps its heartbeat going
      const jobs = await a.jobsCol();
      await jobs.updateOne({ _id: first }, { $set: { status: 'running', stage: 'extract', heartbeatAt: a.clock.t } });
      const busy = await a.adm('POST', '/jobs', { jobId: second });
      assert.equal(busy.status, 409);
      assert.equal(busy.json().error.reason, 'busy');
      assert.match(busy.json().error.message, new RegExp(first));
      assert.equal(a.fake.of('ingest').length, 1, 'Modal was not asked again');
      assert.equal((await jobs.findOne({ _id: second })).status, 'draft', 'and the second stays a draft');
      a.clock.t += 9 * 60 * 1000;
      assert.equal((await a.adm('POST', '/jobs', { jobId: second })).status, 409, 'nine minutes of silence is still alive');
      // when the first finishes, the second may go
      await jobs.updateOne({ _id: first }, { $set: { status: 'succeeded', finishedAt: a.clock.t } });
      assert.equal((await a.adm('POST', '/jobs', { jobId: second })).status, 202);
      assert.ok((await a.events()).some((e) => e.type === 'catalogue.job-start' && e.detail === second));
    } finally {
      await a.stop();
    }
  });

  test('a job that stopped answering for ten minutes is dead: the next job takes over and the dead one is marked failed', async () => {
    const a = await startAdminApp();
    try {
      const first = await a.newDraft();
      const second = await a.newDraft();
      await a.adm('POST', '/jobs', { jobId: first });
      const jobs = await a.jobsCol();
      await jobs.updateOne({ _id: first }, { $set: { status: 'running' } });
      a.clock.t += 10 * 60 * 1000 + 1000;
      const r = await a.adm('POST', '/jobs', { jobId: second });
      assert.equal(r.status, 202, r.text);
      const dead = await jobs.findOne({ _id: first });
      assert.equal(dead.status, 'failed');
      assert.match(dead.error, /stopped answering.*10 minutes/);
      assert.equal(dead.finishedAt, a.clock.t);
      assert.equal((await jobs.findOne({ _id: second })).status, 'queued');
    } finally {
      await a.stop();
    }
  });

  test('only a draft can be started, and a failed job is started again to resume', async () => {
    const a = await startAdminApp();
    try {
      const jobs = await a.jobsCol();
      for (const status of ['queued', 'running', 'succeeded', 'cancelled']) {
        const id = await a.newDraft();
        await jobs.updateOne({ _id: id }, { $set: { status, heartbeatAt: null } });
        const r = await a.adm('POST', '/jobs', { jobId: id });
        assert.equal(r.status, 409, status);
        assert.equal(r.json().error.reason, 'bad-state', status);
        await jobs.updateOne({ _id: id }, { $set: { status: 'cancelled' } });
      }
      assert.equal(a.fake.of('ingest').length, 0);
      const failed = await a.newDraft();
      await jobs.updateOne({ _id: failed }, { $set: { status: 'failed', error: 'Modal fell over', finishedAt: a.clock.t } });
      const r = await a.adm('POST', '/jobs', { jobId: failed });
      assert.equal(r.status, 202);
      assert.deepEqual([r.json().job.status, r.json().job.error, r.json().job.finishedAt], ['queued', null, null]);
      assert.equal((await a.adm('POST', '/jobs', { jobId: 'job-20260101000000-ffffff' })).status, 404);
      for (const body of [{}, { jobId: 'nope' }, { jobId: 5 }, { jobId: null }, []]) assert.equal((await a.adm('POST', '/jobs', body)).status, 400, JSON.stringify(body));
    } finally {
      await a.stop();
    }
  });

  test('if Modal cannot be reached the job goes back to what it was, with the reason, and is never stuck queued', async () => {
    const a = await startAdminApp({ rawEnv: 'CATALOGUE_MODAL_TIMEOUT_MS=300\n' });
    try {
      const jobs = await a.jobsCol();
      const id = await a.newDraft();
      for (const [what, behaviour, status, reason] of [['a server error', { status: 500, reason: 'internal' }, 503, 'modal-unavailable'], ['a refused key', { status: 401, reason: 'unauthorized' }, 503, 'modal-unavailable'], ['a dropped connection', { destroy: true }, 503, 'modal-unavailable'], ['no answer in time', { hang: true }, 503, 'warming'], ['a full queue', { status: 503, reason: 'busy' }, 503, 'busy']]) {
        a.fake.next('ingest', behaviour);
        const r = await a.adm('POST', '/jobs', { jobId: id });
        assert.equal(r.status, status, what);
        assert.equal(r.json().error.reason, reason, what);
        assert.match(r.json().error.message, /could not be started/, what);
        const job = await jobs.findOne({ _id: id });
        assert.deepEqual([job.status, job.heartbeatAt, job.modalCallId], ['draft', null, null], what);
        assert.match(job.error, /could not be started/);
      }
      assert.equal((await a.adm('POST', '/jobs', { jobId: id })).status, 202, 'and it can be started again');
      assert.equal((await jobs.findOne({ _id: id })).error, null);
      // a failed job that cannot be resumed goes back to failed, not to draft
      const failed = await a.newDraft();
      await jobs.updateOne({ _id: id }, { $set: { status: 'succeeded' } });
      await jobs.updateOne({ _id: failed }, { $set: { status: 'failed', error: 'old' } });
      a.fake.next('ingest', { status: 500, reason: 'internal' });
      await a.adm('POST', '/jobs', { jobId: failed });
      assert.equal((await jobs.findOne({ _id: failed })).status, 'failed');
    } finally {
      await a.stop();
    }
  });

  test('with the ingest app not set up, starting says so and changes nothing', async () => {
    const a = await startAdminApp({ env: { CATALOGUE_MODAL_INGEST_URL: '' } });
    try {
      const id = await a.newDraft();
      const r = await a.adm('POST', '/jobs', { jobId: id });
      assert.equal(r.status, 503);
      assert.equal(r.json().error.reason, 'modal-not-configured');
      assert.equal((await (await a.jobsCol()).findOne({ _id: id })).status, 'draft');
    } finally {
      await a.stop();
    }
  });

  test('two jobs started at the same moment: exactly one goes', async () => {
    const a = await startAdminApp();
    try {
      const [x, y] = [await a.newDraft(), await a.newDraft()];
      a.fake.next('ingest', { delayMs: 150 });
      const results = await Promise.all([a.adm('POST', '/jobs', { jobId: x }), a.adm('POST', '/jobs', { jobId: y })]);
      assert.deepEqual(results.map((r) => r.status).sort(), [202, 409]);
      const jobs = await a.jobsCol();
      const states = [(await jobs.findOne({ _id: x })).status, (await jobs.findOne({ _id: y })).status].sort();
      assert.deepEqual(states, ['draft', 'queued']);
      assert.equal(a.fake.of('ingest').length, 1);
    } finally {
      await a.stop();
    }
  });

  test('cancel: a draft is simply cancelled; a queued or running job is asked to stop; a finished one cannot be', async () => {
    const a = await startAdminApp();
    try {
      const jobs = await a.jobsCol();
      const draft = await a.newDraft();
      const r = await a.adm('POST', `/jobs/${draft}/cancel`, {});
      assert.equal(r.status, 200);
      assert.deepEqual([r.json().ok, r.json().notified, r.json().job.status, r.json().job.finishedAt], [true, false, 'cancelled', a.clock.t]);
      assert.equal(a.fake.requests.length, 0, 'Modal does not know a draft');
      assert.equal((await a.adm('POST', `/jobs/${draft}/cancel`, {})).status, 409, 'cancelled already');

      const live = await a.newDraft();
      await a.adm('POST', '/jobs', { jobId: live });
      const asked = await a.adm('POST', `/jobs/${live}/cancel`, {});
      assert.equal(asked.status, 200);
      assert.deepEqual([asked.json().notified, asked.json().job.cancelRequested, asked.json().job.status], [true, true, 'queued']);
      assert.deepEqual(a.fake.of('ingest-cancel').map((q) => q.json), [{ jobId: live }]);
      await jobs.updateOne({ _id: live }, { $set: { status: 'running' } });
      a.fake.next('ingest-cancel', { status: 500, reason: 'internal' });
      const down = await a.adm('POST', `/jobs/${live}/cancel`, {});
      assert.equal(down.status, 200, 'the request is recorded on the job even when Modal cannot be told');
      assert.deepEqual([down.json().notified, down.json().job.cancelRequested], [false, true]);
      await jobs.updateOne({ _id: live }, { $set: { status: 'succeeded' } });
      assert.equal((await a.adm('POST', `/jobs/${live}/cancel`, {})).status, 409);
      assert.equal((await a.adm('POST', '/jobs/job-20260101000000-ffffff/cancel', {})).status, 404);
      assert.equal((await a.adm('POST', '/jobs/not-a-job/cancel', {})).status, 400);
      assert.equal((await a.events()).filter((e) => e.type === 'catalogue.job-cancel').length, 3);
    } finally {
      await a.stop();
    }
  });

  test('jobs are listed newest first and filtered; one job comes with its log', async () => {
    const a = await startAdminApp();
    try {
      const jobs = await a.jobsCol();
      const made = [];
      for (let i = 0; i < 4; i += 1) {
        a.clock.t += 1000;
        made.push(await a.newDraft());
      }
      await jobs.updateOne({ _id: made[1] }, { $set: { status: 'succeeded', log: [{ t: 1, level: 'info', msg: 'done' }] } });
      const list = (await a.adm('GET', '/jobs')).json().jobs;
      assert.deepEqual(list.map((j) => j._id), [...made].reverse());
      assert.ok(list.every((j) => !('log' in j)));
      assert.deepEqual((await a.adm('GET', '/jobs?limit=2')).json().jobs.map((j) => j._id), [made[3], made[2]]);
      assert.deepEqual((await a.adm('GET', '/jobs?status=succeeded')).json().jobs.map((j) => j._id), [made[1]]);
      assert.equal((await a.adm('GET', `/jobs?catalogue=${SEED_CATALOGUE}`)).json().jobs.length, 4);
      assert.equal((await a.adm('GET', '/jobs?catalogue=other-one')).json().jobs.length, 0);
      for (const query of ['status=bogus', 'limit=0', 'limit=101', 'limit=x', 'limit=1&limit=2', 'catalogue=BAD SLUG']) assert.equal((await a.adm('GET', `/jobs?${query}`)).status, 400, query);
      const one = await a.adm('GET', `/jobs/${made[1]}`);
      assert.equal(one.status, 200);
      assert.deepEqual(one.json().log, [{ t: 1, level: 'info', msg: 'done' }]);
      assert.equal(one.json().sources.length, 1);
      assert.equal((await a.adm('GET', '/jobs/job-20260101000000-ffffff')).status, 404);
      assert.equal((await a.adm('GET', '/jobs/..%2F..%2Fetc')).status, 400);
    } finally {
      await a.stop();
    }
  });
});

describe('items', () => {
  test('they are listed by item id, page by page, with pictures signed, and every read has a projection', async () => {
    const a = await startAdminApp();
    try {
      a.reads.length = 0;
      const seen = [];
      let after;
      let pages = 0;
      for (;;) {
        const r = await a.adm('GET', `/catalogues/${SEED_CATALOGUE}/items?limit=5${after ? `&after=${after}` : ''}`);
        assert.equal(r.status, 200, r.text);
        pages += 1;
        seen.push(...r.json().items.map((i) => i.itemId));
        if (pages === 1) {
          const first = r.json().items[0];
          assert.deepEqual([first.id, first.label, first.productId, first.thumbUrl], [`${SEED_CATALOGUE}|${ids[0]}`, 'Emperor Dark', 'SB804', `https://signed.example/get/thumbs/${SEED_CATALOGUE}/${ids[0]}.jpg?expires=4500&sig=fake`]);
          assert.ok(first.source && first.images && first.createdAt, 'the whole item');
          assert.equal('proportions' in first, false);
        }
        after = r.json().next;
        if (!after) break;
      }
      assert.deepEqual(seen, ids);
      assert.equal(pages, 3);
      assert.ok(a.reads.length > 0 && a.reads.every((read) => read.options?.projection || read.op === 'count'));
      const hidden = await (await a.itemsCol()).updateOne({ _id: `${SEED_CATALOGUE}|${ids[2]}` }, { $set: { status: 'hidden' } });
      assert.equal(hidden.modifiedCount, 1);
      assert.deepEqual((await a.adm('GET', `/catalogues/${SEED_CATALOGUE}/items?status=hidden`)).json().items.map((i) => i.itemId), [ids[2]]);
      assert.equal((await a.adm('GET', `/catalogues/${SEED_CATALOGUE}/items?status=ok&limit=100`)).json().items.length, 11);
      assert.equal((await a.adm('GET', `/catalogues/${SEED_CATALOGUE}/items?limit=100`)).json().next, null);
    } finally {
      await a.stop();
    }
  });

  test('a text filter finds the start of a label, product code or description (or of a word in it), and can only ever mean the text it was given', async () => {
    const a = await startAdminApp();
    try {
      const items = await a.itemsCol();
      await items.updateOne({ _id: `${SEED_CATALOGUE}|${ids[3]}` }, { $set: { label: 'Wood (aged) [dark] 50% a.b*c', productId: 'AB-12/x' } });
      const find = async (q) => (await a.adm('GET', `/catalogues/${SEED_CATALOGUE}/items?q=${encodeURIComponent(q)}`)).json().items.map((i) => i.itemId);
      assert.deepEqual(await find('emperor'), [ids[0]], 'the start of a label, any case');
      assert.deepEqual(await find('DARK'), [ids[0], ids[3]], 'the start of a word');
      assert.deepEqual(await find('sb8'), [ids[0]], 'a product code');
      assert.deepEqual(await find('lamin'), [ids[1]], 'the AI description, from a word in it');
      assert.deepEqual(await find('mperor'), [], 'the middle of a word is not the start of one');
      assert.deepEqual(await find('ab-12/'), [ids[3]], 'dashes and slashes mean themselves');
      assert.deepEqual(await find('(aged) [dark] 50% a.b*c'), [ids[3]], 'so do brackets, a dot and a star');
      for (const attack of ['.*', '^', '$', '(', '[', '\\', 'a|b', '(?:x)+$', '.+', '{1}', '(.*)*$']) assert.deepEqual(await find(attack), [], `${attack} is text, not a pattern`);
      assert.deepEqual(await find('emperor dark'), [ids[0]]);
      assert.equal((await a.adm('GET', `/catalogues/${SEED_CATALOGUE}/items?q=${'x'.repeat(61)}`)).status, 400);
      assert.deepEqual(await find('   '), ids, 'blank means no filter');
      assert.equal((await a.adm('GET', `/catalogues/${SEED_CATALOGUE}/items?q=a&q=b`)).status, 400);
      const both = await a.adm('GET', `/catalogues/${SEED_CATALOGUE}/items?q=dark&status=hidden`);
      assert.deepEqual(both.json().items, []);
    } finally {
      await a.stop();
    }
  });

  test('the query and the path are checked; an unknown catalogue is 404', async () => {
    const a = await startAdminApp();
    try {
      for (const query of ['status=maybe', 'limit=0', 'limit=101', 'limit=-1', 'limit=1.5', 'after=not%20an%20id', 'after=../x', `after=${ids[0]}&after=${ids[1]}`]) assert.equal((await a.adm('GET', `/catalogues/${SEED_CATALOGUE}/items?${query}`)).status, 400, query);
      assert.equal((await a.adm('GET', '/catalogues/no-such-one/items')).status, 404);
      assert.equal((await a.adm('GET', '/catalogues/BAD%20SLUG/items')).status, 400);
    } finally {
      await a.stop();
    }
  });
});

describe('editing an item', () => {
  const patch = (a, itemId, body, catalogue = SEED_CATALOGUE) => a.adm('PATCH', `/catalogues/${catalogue}/items/${itemId}`, body);

  test('label, product code, visibility and attributes are changed, validated, and shown to clients at once', async () => {
    const a = await startAdminApp({ seed: { overrides: { [ids[4]]: { source: { name: 'x.pdf', page: 5, pdfProductId: 'PDF-77' } } } } });
    try {
      const me = await a.app.signIn();
      const items = await a.itemsCol();
      const doc = (id) => items.findOne({ _id: `${SEED_CATALOGUE}|${id}` });
      // label
      const r = await patch(a, ids[2], { label: '  Teak veneer  ' });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual([r.json().id, r.json().label, r.json().itemId], [`${SEED_CATALOGUE}|${ids[2]}`, 'Teak veneer', ids[2]]);
      assert.equal((await a.photo(makeJpeg(), { as: me, query: 'k=3' })).json().items[2].title, 'Teak veneer');
      assert.equal((await patch(a, ids[2], { label: 'x'.repeat(120) })).status, 200);
      assert.equal((await patch(a, ids[2], { label: null })).json().label, null);
      assert.equal((await patch(a, ids[2], { label: '   ' })).json().label, null, 'blank clears it');
      for (const label of ['x'.repeat(121), 'line\nbreak', 'bell\u0007', 'bidi\u202e', 5, {}, ['a']]) assert.equal((await patch(a, ids[2], { label })).status, 400, JSON.stringify(label));
      // product code: an admin's code is marked as the admin's; clearing brings back the PDF's, or nothing
      const code = await patch(a, ids[4], { productId: ' sb-805 / x ' });
      assert.equal(code.status, 200);
      assert.deepEqual([code.json().productId, code.json().productIdSource], ['sb-805 / x', 'admin']);
      const cleared = await patch(a, ids[4], { productId: null });
      assert.deepEqual([cleared.json().productId, cleared.json().productIdSource], ['PDF-77', 'pdf-text']);
      const none = await patch(a, ids[0], { productId: '' });
      assert.deepEqual([none.json().productId, none.json().productIdSource], [null, null], 'nothing is ever invented');
      for (const productId of ['-leading-dash', 'x'.repeat(41), 'semi;colon', 'ünï', '<b>', '../x', 5, [], {}]) assert.equal((await patch(a, ids[0], { productId })).status, 400, JSON.stringify(productId));
      assert.equal((await patch(a, ids[0], { productId: 'x'.repeat(40) })).status, 200);
      // attributes
      const attrs = { Colour: 'oak', widthMm: 1200, 'Fire rated': true, notes: null, 'a-b_c d': 'ok' };
      assert.deepEqual((await patch(a, ids[5], { attributes: attrs })).json().attributes, attrs);
      assert.deepEqual((await patch(a, ids[5], { attributes: {} })).json().attributes, {}, 'the whole object is replaced');
      const twenty = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
      assert.equal((await patch(a, ids[5], { attributes: twenty })).status, 200);
      for (const attributes of [{ ...twenty, k20: 1 }, { $set: 1 }, { 'a.b': 1 }, { '': 1 }, { '1st': 1 }, { __proto__x: 1 }, { constructor: 1 }, { prototype: 1 }, { ok: {} }, { ok: [] }, { ok: 'x'.repeat(201) }, { ok: 'bell\u0007' }, { [`k${'x'.repeat(40)}`]: 1 }, [], 'x', null, 5]) assert.equal((await patch(a, ids[5], { attributes })).status, 400, JSON.stringify(attributes).slice(0, 50));
      const proto = await a.adm('PATCH', `/catalogues/${SEED_CATALOGUE}/items/${ids[5]}`, '{"attributes": {"__proto__": {"polluted": true}}}', { 'Content-Type': 'application/json' });
      assert.equal(proto.status, 400);
      assert.equal({}.polluted, undefined);
      // the shape of the request
      for (const body of [{}, { nothing: 1 }, { label: 'x', status: 'ok', extra: 1 }, { _id: 'x' }, { itemId: 'x' }, { images: {} }, { catalogue: 'other-one' }, { status: 'deleted' }, { status: 'OK' }, { status: true }, []]) assert.equal((await patch(a, ids[1], body)).status, 400, JSON.stringify(body));
      assert.equal((await patch(a, 'ffffffffffff-p0099-i00', { label: 'x' })).status, 404);
      assert.equal((await patch(a, 'not an id', { label: 'x' })).status, 400);
      assert.equal((await patch(a, ids[0], { label: 'x' }, 'no-such-one')).status, 404);
      assert.equal((await patch(a, ids[0], { label: 'x' }, 'BAD SLUG')).status, 400);
      assert.equal((await doc(ids[1])).label, null, 'a refused request changes nothing');
      assert.ok((await a.events()).some((e) => e.type === 'catalogue.item-edit' && e.detail.includes(ids[4]) && e.detail.includes('productId')));
      assert.equal((await a.events()).some((e) => JSON.stringify(e).includes(TOKEN)), false);
    } finally {
      await a.stop();
    }
  });

  test('hiding and showing keep the catalogue\'s counts right, and a hidden design leaves the search results', async () => {
    const a = await startAdminApp();
    try {
      const me = await a.app.signIn();
      const hiddenCount = async () => (await a.catalogueDoc()).counts;
      assert.deepEqual(await hiddenCount(), { items: 12, hidden: 0 });
      assert.equal((await patch(a, ids[0], { status: 'hidden' })).json().status, 'hidden');
      assert.deepEqual(await hiddenCount(), { items: 12, hidden: 1 });
      assert.equal((await patch(a, ids[1], { status: 'hidden' })).status, 200);
      assert.deepEqual(await hiddenCount(), { items: 12, hidden: 2 });
      assert.equal((await patch(a, ids[1], { status: 'hidden' })).status, 200);
      assert.deepEqual(await hiddenCount(), { items: 12, hidden: 2 }, 'hiding what is hidden changes nothing');
      assert.equal((await patch(a, ids[1], { label: 'still hidden' })).status, 200);
      assert.deepEqual(await hiddenCount(), { items: 12, hidden: 2 });
      const status = (await a.status({ as: me })).json();
      assert.equal(status.catalogues[0].items, 10, 'the shop shows what is left');
      const results = (await a.photo(makeJpeg(), { as: me, query: 'k=3' })).json().items.map((i) => i.itemId);
      assert.deepEqual(results, [ids[2], ids[3], ids[4]]);
      assert.equal((await patch(a, ids[0], { status: 'ok' })).json().status, 'ok');
      assert.deepEqual(await hiddenCount(), { items: 12, hidden: 1 });
      assert.equal((await a.photo(makeJpeg(), { as: me, query: 'k=1' })).json().items[0].itemId, ids[0]);
    } finally {
      await a.stop();
    }
  });
});

describe('releases', () => {
  const NEXT = 'rel-20261102120000-def456';
  const EMPTY = 'rel-20261103120000-000000';

  async function twoReleases(a) {
    const releases = await a.db.col('catalogue_releases');
    await releases.insertOne({ _id: NEXT, catalogue: SEED_CATALOGUE, createdAt: 1_793_100_000_000, createdBy: 'ingest', jobId: null, parent: SEED_RELEASE, nItems: 12, featureVersions: { dino: 'dino-v2' }, pillars: { dino: { count: 12, dim: 3072 } }, gcsPrefix: `releases/${SEED_CATALOGUE}/${NEXT}/`, manifestSha256: 'ab'.repeat(32) });
    await releases.insertOne({ _id: EMPTY, catalogue: SEED_CATALOGUE, createdAt: 1_793_200_000_000, createdBy: 'cli', jobId: null, parent: NEXT, nItems: 12, featureVersions: {}, pillars: {}, gcsPrefix: `releases/${SEED_CATALOGUE}/${EMPTY}/`, manifestSha256: 'ab'.repeat(32) });
  }

  test('they are listed newest first with the live and the previous one marked', async () => {
    const a = await startAdminApp();
    try {
      await twoReleases(a);
      const r = await a.adm('GET', `/catalogues/${SEED_CATALOGUE}/releases`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.json().releases.map((x) => [x.id, x.active, x.previous]), [[EMPTY, false, false], [NEXT, false, false], [SEED_RELEASE, true, false]]);
      assert.deepEqual([r.json().activeRelease, r.json().previousRelease], [SEED_RELEASE, null]);
      assert.deepEqual(Object.keys(r.json().releases[2].pillars), ['dino', 'siglip', 'color']);
      assert.equal((await a.adm('GET', '/catalogues/no-such-one/releases')).status, 404);
    } finally {
      await a.stop();
    }
  });

  test('activating a release makes it live, remembers the old one, and activating that one again is the rollback', async () => {
    const a = await startAdminApp();
    try {
      await twoReleases(a);
      const me = await a.app.signIn();
      assert.equal((await a.photo(makeJpeg(), { as: me })).status, 200);
      assert.equal(a.fake.of('search')[0].query.release, SEED_RELEASE);
      await (await a.itemsCol()).updateOne({ _id: `${SEED_CATALOGUE}|${ids[0]}` }, { $set: { status: 'hidden' } });
      const up = await a.adm('POST', `/catalogues/${SEED_CATALOGUE}/releases/${NEXT}/activate`, {});
      assert.equal(up.status, 200, up.text);
      assert.deepEqual([up.json().ok, up.json().changed, up.json().catalogue.activeRelease, up.json().catalogue.previousRelease, up.json().catalogue.featureVersions], [true, true, NEXT, SEED_RELEASE, { dino: 'dino-v2' }]);
      assert.equal((await a.photo(makeJpeg(), { as: me })).status, 200);
      assert.equal(a.fake.of('search')[1].query.release, NEXT, 'clients search the new release at once');
      const back = await a.adm('POST', `/catalogues/${SEED_CATALOGUE}/releases/${SEED_RELEASE}/activate`, {});
      assert.deepEqual([back.json().catalogue.activeRelease, back.json().catalogue.previousRelease, back.json().catalogue.featureVersions.siglip], [SEED_RELEASE, NEXT, 'siglip-v1'], 'the rollback');
      assert.equal((await a.photo(makeJpeg(), { as: me })).status, 200);
      assert.equal(a.fake.of('search')[2].query.release, SEED_RELEASE);
      const same = await a.adm('POST', `/catalogues/${SEED_CATALOGUE}/releases/${SEED_RELEASE}/activate`, {});
      assert.deepEqual([same.status, same.json().changed], [200, false]);
      assert.equal((await a.catalogueDoc()).previousRelease, NEXT, 'doing it twice does not forget the previous one');
      const events = await a.events();
      assert.equal(events.filter((e) => e.type === 'catalogue.release-activate').length, 2);
    } finally {
      await a.stop();
    }
  });

  test('the counts follow the live release: its size, and the hidden designs among its own', async () => {
    const a = await startAdminApp();
    try {
      await twoReleases(a);
      const items = await a.itemsCol();
      // one design first appeared in the newer release
      await items.updateOne({ _id: `${SEED_CATALOGUE}|${ids[11]}` }, { $set: { releaseFirst: NEXT, status: 'hidden' } });
      await items.updateOne({ _id: `${SEED_CATALOGUE}|${ids[10]}` }, { $set: { status: 'hidden' } });
      const releases = await a.db.col('catalogue_releases');
      await releases.updateOne({ _id: SEED_RELEASE }, { $set: { nItems: 11 } });
      await a.adm('POST', `/catalogues/${SEED_CATALOGUE}/releases/${NEXT}/activate`, {});
      assert.deepEqual((await a.catalogueDoc()).counts, { items: 12, hidden: 2 });
      await a.adm('POST', `/catalogues/${SEED_CATALOGUE}/releases/${SEED_RELEASE}/activate`, {});
      assert.deepEqual((await a.catalogueDoc()).counts, { items: 11, hidden: 1 }, 'the older release does not have the newer design');
    } finally {
      await a.stop();
    }
  });

  test('a release that does not exist, belongs elsewhere or has no vectors cannot be made live', async () => {
    const a = await startAdminApp();
    try {
      await twoReleases(a);
      await seedOther(a);
      const activate = (catalogue, release) => a.adm('POST', `/catalogues/${catalogue}/releases/${release}/activate`, {});
      assert.equal((await activate(SEED_CATALOGUE, 'rel-20260101000000-ffffff')).status, 404);
      assert.equal((await activate(SEED_CATALOGUE, 'rel-20261105120000-aaaaaa')).status, 404, 'a release of another catalogue is not found here');
      assert.equal((await activate('no-such-one', NEXT)).status, 404);
      const noPillars = await activate(SEED_CATALOGUE, EMPTY);
      assert.equal(noPillars.status, 409);
      assert.equal(noPillars.json().error.reason, 'no-pillars');
      for (const bad of ['nope', 'rel-1', '../x']) assert.equal((await activate(SEED_CATALOGUE, bad)).status, 400, bad);
      assert.equal((await a.catalogueDoc()).activeRelease, SEED_RELEASE, 'nothing changed');
    } finally {
      await a.stop();
    }
  });
});

async function seedOther(a) {
  const { seedCatalogue } = await import('../helpers/fakeCatalogueModal.js');
  await seedCatalogue(a.db, { catalogue: 'second-one', release: 'rel-20261105120000-aaaaaa', ids: ['bbbbbbbbbbbb-p0001-i00'], name: 'Second', kind: 'paint' });
}
