/**
 * The browser behaviour of /admin/catalogue (pages/admin-catalogue.html, target D1): create a catalogue, upload a PDF or
 * photos, watch the processing job, edit an item's label/code/visibility/attributes, and choose which release clients see.
 *
 * Everything here binds to the exact ids already in that page; nothing is built that is not asked for there. The contract
 * this follows is server/catalogue/adminRoutes.js + server/catalogue/admin.js (catalogue/ARCHITECTURE.md section 7,
 * "Admin (Bearer admin token)"): every call needs `Authorization: Bearer <AUTH_ADMIN_TOKEN>`, with no token configured at
 * all the server answers every route 404 ("No such API route."), a wrong token is 401. The error body is always
 * {error: {code, status, message, reason, retryAfter?}}.
 *
 * The one thing this file does that never goes through the website: once POST /uploads has signed an address per file,
 * each file's bytes are PUT straight to that signed Cloud Storage URL (storage.googleapis.com), with exactly the headers
 * the server gave back. The page's CSP ("strict+catalogue-admin") allows exactly that cross-origin connect.
 *
 * The admin token is pasted in by whoever opens this page; it is kept only in memory and in this tab's sessionStorage
 * (not localStorage, and never logged, never put in a URL, never sent anywhere but the /api/catalogue/admin/* calls below).
 */

const TOKEN_KEY = 'catalogueAdminToken';

/** An error from the admin API (or from this page before it ever asked), with the HTTP status and the server's `reason` slug. */
class AdminError extends Error {
  constructor(message, { status = 0, reason = 'error' } = {}) {
    super(message);
    this.name = 'AdminError';
    this.status = status;
    this.reason = reason;
  }
}

const $ = (id) => document.getElementById(id);
const show = (node) => { node.hidden = false; };
const hide = (node) => { node.hidden = true; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Show `message` in a `.notice` element that already exists in the page, as good / bad / info (all defined in the page's own <style>). Blank hides it. */
function setNotice(node, message, kind = 'bad') {
  if (!message) { node.hidden = true; return; }
  node.className = `notice ${kind}`;
  node.textContent = message;
  node.hidden = false;
}

/** Append a one-off error notice at the top of a list container, without disturbing the rows already there. */
function prependNotice(container, message) {
  const p = document.createElement('p');
  p.className = 'notice bad';
  p.textContent = message;
  container.prepend(p);
}

let token = null;
try { token = sessionStorage.getItem(TOKEN_KEY) || null; } catch { /* private window, blocked storage: stay signed out */ }

/**
 * Fetch with the admin token, throwing a readable AdminError on anything but a 2xx. Every write (anything but GET) always
 * sends a JSON body (`{}` when none is given) so Express's json() middleware always sees Content-Type: application/json.
 */
async function api(path, { method = 'GET', body } = {}) {
  if (!token) throw new AdminError('Not connected.', { status: 0, reason: 'client' });
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(`/api/catalogue/admin${path}`, { method, headers, body: payload });
  } catch {
    throw new AdminError('Could not reach the server. Check your connection and try again.', { status: 0, reason: 'network' });
  }
  let json = null;
  try { json = await res.json(); } catch { /* no body, or not JSON */ }
  if (!res.ok) {
    const e = json?.error;
    throw new AdminError(e?.message || (res.status >= 500 ? 'The server had a problem. Please try again in a moment.' : 'Something went wrong. Please try again.'), { status: res.status, reason: e?.reason || 'error' });
  }
  return json;
}

// ====================================================================================================== 1. the token

const tokenInput = $('token-input');
const tokenStatus = $('token-status');
const tokenConnected = $('token-connected');
const tokenForgetBtn = $('token-forget');
const adminSections = $('admin-sections');

function forget() {
  token = null;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  tokenInput.value = '';
  hide(adminSections);
  hide(tokenForgetBtn);
  hide(tokenConnected);
  tokenConnected.textContent = '';
  hide(tokenStatus);
}

async function connect(value) {
  hide(tokenStatus);
  const candidate = (value || '').trim();
  if (!candidate) { setNotice(tokenStatus, 'Paste the admin token first.'); return; }
  const previous = token;
  token = candidate;
  try {
    const overview = await api('/overview');
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* ignore: the tab still works, just won't survive a reload */ }
    applyOverview(overview);
    show(adminSections);
    show(tokenForgetBtn);
    tokenConnected.textContent = 'Connected.';
    show(tokenConnected);
    hide(tokenStatus);
    // first load of the sections that need an explicit call of their own (not carried by the overview)
    await loadJobs().catch(() => {});
    if ($('items-catalogue').value) loadItems({ reset: true }).catch(() => {});
    if ($('releases-catalogue').value) loadReleases().catch(() => {});
  } catch (err) {
    token = previous;
    try { if (!previous) sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
    hide(adminSections);
    const message = err.status === 404
      ? 'No admin token is set up on this server at all (AUTH_ADMIN_TOKEN is not configured), so no token will work here until one is.'
      : err.status === 401
        ? 'That token was not accepted.'
        : (err.message || 'Could not connect.');
    setNotice(tokenStatus, message);
  }
}

$('token-connect').addEventListener('click', () => connect(tokenInput.value));
tokenInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); connect(tokenInput.value); } });
tokenForgetBtn.addEventListener('click', forget);

// ====================================================================================================== 2. overview & check

const state = { catalogues: [] };

function renderConfigured(configured) {
  const parts = [['Modal', configured?.modal], ['GCS', configured?.gcs], ['Database', configured?.database]];
  // catalogue-ui.css has no ".tag.bad"; "failed" is the same red (var(--bad)) and is the closest existing modifier to it.
  $('overview-configured').innerHTML = parts.map(([label, ok]) => `<span class="tag ${ok ? 'ok' : 'failed'}">${esc(label)}: ${ok ? 'ready' : 'not set up'}</span>`).join('');
}

function catalogueOptionsHtml(catalogues) {
  if (!catalogues.length) return '<option value="">No catalogues yet</option>';
  return catalogues.map((c) => `<option value="${esc(c.id)}">${esc(c.id)} — ${esc(c.name)}</option>`).join('');
}

function renderCatalogueSelects(catalogues) {
  for (const id of ['upload-catalogue', 'items-catalogue', 'releases-catalogue']) {
    const select = $(id);
    const previous = select.value;
    select.innerHTML = catalogueOptionsHtml(catalogues);
    if (catalogues.some((c) => c.id === previous)) select.value = previous;
  }
}

function renderCataloguesList(catalogues) {
  const node = $('catalogues-list');
  if (!catalogues.length) { node.innerHTML = '<p class="empty">No catalogues yet. Create one below.</p>'; return; }
  node.innerHTML = catalogues.map((c) => `
    <div>
      <strong>${esc(c.id)}</strong>
      <span class="muted">${esc(c.name)}</span>
      <span class="muted">${esc(c.kind)}</span>
      <span class="tag ${c.live ? 'ok' : 'hidden'}">${c.live ? 'Live' : 'Not live'}</span>
      <span class="muted">${c.counts?.items ?? 0} items, ${c.counts?.hidden ?? 0} hidden</span>
    </div>`).join('');
}

function applyOverview(overview) {
  state.catalogues = overview.catalogues || [];
  renderConfigured(overview.configured || {});
  renderCataloguesList(state.catalogues);
  renderCatalogueSelects(state.catalogues);
}

async function refreshOverview() {
  const overview = await api('/overview');
  applyOverview(overview);
  return overview;
}

async function runCheck() {
  if (!window.confirm('Running the check wakes the Modal apps that are set up, which is billed like any other start. Continue?')) return;
  const result = $('check-result');
  result.className = 'notice info';
  result.textContent = 'Checking…';
  result.hidden = false;
  try {
    const body = await api('/check', { method: 'POST' });
    const parts = [['Database', body.database], ['GCS signing', body.gcsSigning], ['Modal search', body.modalSearch], ['Modal ingest', body.modalIngest]];
    const allOk = parts.every(([, p]) => p?.ok);
    result.className = `notice ${allOk ? 'good' : 'bad'}`;
    result.innerHTML = parts.map(([label, p]) => `${esc(label)}: <strong>${p?.ok ? 'ok' : 'failed'}</strong> — ${esc(p?.detail || '')}`).join('<br>') + (body.note ? `<br>${esc(body.note)}` : '');
  } catch (err) {
    result.className = 'notice bad';
    result.textContent = err.message;
  }
}

$('run-check').addEventListener('click', runCheck);

// ====================================================================================================== 3. create a catalogue

async function createCatalogue() {
  const status = $('create-status');
  hide(status);
  const body = { id: $('new-id').value.trim(), name: $('new-name').value.trim(), kind: $('new-kind').value, note: $('new-note').value.trim() || undefined };
  try {
    await api('/catalogues', { method: 'POST', body });
    $('new-id').value = '';
    $('new-name').value = '';
    $('new-note').value = '';
    $('new-kind').value = 'materials';
    setNotice(status, `Catalogue "${body.id}" created.`, 'good');
    await refreshOverview();
  } catch (err) {
    setNotice(status, err.message, 'bad');
  }
}

$('create-go').addEventListener('click', createCatalogue);

// ====================================================================================================== 4. upload a PDF or photos

let uploadFiles = [];
let currentUploadJobId = null;

function tagClassForUpload(status) {
  if (status === 'done') return 'ok';
  if (status === 'failed') return 'failed';
  if (status === 'chosen') return 'queued';
  return 'running'; // signing, uploading
}
const UPLOAD_LABEL = { chosen: 'Chosen', signing: 'Signing', uploading: 'Uploading', done: 'Done', failed: 'Failed' };

function renderUploadList() {
  const node = $('upload-list');
  if (!uploadFiles.length) { node.hidden = true; node.innerHTML = ''; return; }
  node.hidden = false;
  node.innerHTML = uploadFiles.map((f) => `
    <div>
      <span>${esc(f.name)}</span>
      <span class="muted">${(f.size / 1024 / 1024).toFixed(2)} MB</span>
      <span class="tag ${tagClassForUpload(f.status)}">${esc(UPLOAD_LABEL[f.status] || f.status)}</span>
      ${f.message ? `<span class="muted">${esc(f.message)}</span>` : ''}
    </div>`).join('');
}

function onFilesChosen(e) {
  uploadFiles = [...e.target.files].map((file) => ({ file, name: file.name, size: file.size, type: file.type, status: 'chosen', message: '' }));
  currentUploadJobId = null;
  hide($('upload-start-job'));
  hide($('upload-status'));
  renderUploadList();
  $('upload-chosen').textContent = uploadFiles.length ? `${uploadFiles.length} file${uploadFiles.length === 1 ? '' : 's'} chosen` : '';
  $('upload-go').disabled = uploadFiles.length === 0;
}

/** PUT one file to its signed Cloud Storage address, with exactly the headers the server gave for it. Never through this website. */
async function putOne(upload, row) {
  try {
    const res = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: row.file });
    row.status = res.ok ? 'done' : 'failed';
    row.message = res.ok ? '' : `Upload failed (storage answered ${res.status}).`;
  } catch {
    row.status = 'failed';
    row.message = 'Could not reach storage.';
  }
  renderUploadList();
  return { ok: row.status === 'done', name: row.name, message: row.message };
}

async function uploadAll() {
  const status = $('upload-status');
  hide(status);
  const catalogue = $('upload-catalogue').value;
  if (!catalogue) { setNotice(status, 'Choose a catalogue first.'); return; }
  if (!uploadFiles.length) return;
  const kind = $('upload-kind').value;
  const options = { segmentPhotos: $('opt-segment').checked, captions: $('opt-captions').checked, activate: $('opt-activate').checked };
  $('upload-go').disabled = true;
  uploadFiles.forEach((f) => { f.status = 'signing'; f.message = ''; });
  renderUploadList();
  let signed;
  try {
    signed = await api('/uploads', { method: 'POST', body: { catalogue, kind, options, files: uploadFiles.map((f) => ({ name: f.name, size: f.size, type: f.type })) } });
  } catch (err) {
    uploadFiles.forEach((f) => { f.status = 'failed'; f.message = err.message; });
    renderUploadList();
    setNotice(status, `Could not sign the upload: ${err.message}`, 'bad');
    $('upload-go').disabled = false;
    return;
  }
  currentUploadJobId = signed.jobId;
  uploadFiles.forEach((f) => { f.status = 'uploading'; });
  renderUploadList();
  const results = await Promise.all(signed.uploads.map((u, i) => putOne(u, uploadFiles[i])));
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    setNotice(status, `${failed.length} of ${results.length} file(s) could not be uploaded: ${failed.map((f) => `${f.name} (${f.message})`).join('; ')}`, 'bad');
    $('upload-go').disabled = false;
    return;
  }
  setNotice(status, 'All files uploaded. Start processing when ready.', 'good');
  show($('upload-start-job'));
}

async function startProcessing() {
  const status = $('upload-status');
  if (!currentUploadJobId) return;
  try {
    await api('/jobs', { method: 'POST', body: { jobId: currentUploadJobId } });
    setNotice(status, 'Processing started. See the Jobs list below.', 'good');
    hide($('upload-start-job'));
    currentUploadJobId = null;
    uploadFiles = [];
    renderUploadList();
    $('upload-files').value = '';
    $('upload-chosen').textContent = '';
    $('upload-go').disabled = true;
    await loadJobs();
  } catch (err) {
    setNotice(status, err.message, 'bad');
  }
}

$('upload-files').addEventListener('change', onFilesChosen);
$('upload-go').addEventListener('click', uploadAll);
$('upload-start-job').addEventListener('click', startProcessing);

// ====================================================================================================== 5. jobs

function jobTagClass(jobStatus) {
  if (jobStatus === 'succeeded') return 'ok';
  if (jobStatus === 'failed') return 'failed';
  if (jobStatus === 'cancelled') return 'hidden';
  return jobStatus === 'running' ? 'running' : 'queued'; // queued, draft
}

function progressHtml(progress) {
  if (!progress || !progress.total) return '';
  const pct = Math.max(0, Math.min(100, Math.round((progress.done / progress.total) * 100)));
  return `<div class="job-progress">
    <div class="progress"><span data-pct="${pct}"></span></div>
    <p class="muted job-note">${progress.done}/${progress.total}${progress.message ? ' — ' + esc(progress.message) : ''}</p>
  </div>`;
}

function jobRowHtml(j) {
  const canStart = j.status === 'draft' || j.status === 'failed';
  const canCancel = j.status === 'draft' || j.status === 'queued' || j.status === 'running';
  return `
    <div class="is-click" data-job-row="${esc(j._id)}">
      <strong>${esc(j._id)}</strong>
      <span class="muted">${esc(j.catalogue)}</span>
      <span class="tag ${jobTagClass(j.status)}">${esc(j.status)}</span>
      ${progressHtml(j.progress)}
      <span class="actions-row push tight">
        ${canStart ? `<button type="button" class="btn ghost small" data-job-start="${esc(j._id)}">Start</button>` : ''}
        ${canCancel ? `<button type="button" class="btn ghost small" data-job-cancel="${esc(j._id)}">Cancel</button>` : ''}
      </span>
    </div>
    <div hidden data-job-detail="${esc(j._id)}"></div>`;
}

function renderJobsList(jobs) {
  const node = $('jobs-list');
  if (!jobs.length) { node.innerHTML = '<p class="empty">No jobs yet.</p>'; return; }
  node.innerHTML = jobs.map(jobRowHtml).join('');
  // the progress bars' widths: the page's strict policy refuses a style="" attribute in markup, but setting a style from script is allowed
  node.querySelectorAll('.progress > span[data-pct]').forEach((bar) => { bar.style.width = `${Number(bar.dataset.pct) || 0}%`; });
  node.querySelectorAll('[data-job-start]').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); startJobFromList(btn.dataset.jobStart); }));
  node.querySelectorAll('[data-job-cancel]').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); cancelJobFromList(btn.dataset.jobCancel); }));
  node.querySelectorAll('[data-job-row]').forEach((row) => row.addEventListener('click', () => toggleJobDetail(row.dataset.jobRow)));
}

async function loadJobs() {
  const node = $('jobs-list');
  try {
    const { jobs } = await api('/jobs');
    renderJobsList(jobs);
  } catch (err) {
    node.innerHTML = `<p class="notice bad">${esc(err.message)}</p>`;
  }
}

async function toggleJobDetail(id) {
  const detail = [...$('jobs-list').querySelectorAll('[data-job-detail]')].find((n) => n.dataset.jobDetail === id);
  if (!detail) return;
  if (!detail.hidden) { hide(detail); return; }
  show(detail);
  detail.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const job = await api(`/jobs/${encodeURIComponent(id)}`);
    const lines = [`Status: ${job.status}${job.stage ? ` (${job.stage})` : ''}`, job.error ? `Error: ${job.error}` : '', `Sources: ${(job.sources || []).map((s) => s.name).join(', ') || 'none'}`].filter(Boolean);
    const log = (job.log || []).map((l) => `[${l.level || 'info'}] ${l.msg || ''}`).join('\n');
    detail.innerHTML = `<pre class="log">${esc(lines.join('\n'))}${log ? '\n\n' + esc(log) : ''}</pre>`;
  } catch (err) {
    detail.innerHTML = `<p class="notice bad">${esc(err.message)}</p>`;
  }
}

async function startJobFromList(id) {
  try {
    await api('/jobs', { method: 'POST', body: { jobId: id } });
    await loadJobs();
  } catch (err) {
    prependNotice($('jobs-list'), err.message);
  }
}

async function cancelJobFromList(id) {
  try {
    await api(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    await loadJobs();
  } catch (err) {
    prependNotice($('jobs-list'), err.message);
  }
}

$('jobs-refresh').addEventListener('click', () => loadJobs());

// ====================================================================================================== 6. items

const itemsById = new Map();
let itemsCursor = null;
let itemsQTimer = null;
let editing = null; // { catalogueId, itemId }

function itemRowHtml(it) {
  const thumb = it.thumbUrl
    ? `<img class="thumb" src="${esc(it.thumbUrl)}" alt="" loading="lazy">`
    : '<span class="thumb"></span>';
  return `
    <div>
      ${thumb}
      <span>${esc(it.label || it.itemId)}</span>
      <span class="muted">${esc(it.productId || 'no code')}</span>
      <span class="tag ${it.status === 'hidden' ? 'hidden' : 'ok'}">${it.status === 'hidden' ? 'Hidden' : 'Visible'}</span>
      <button type="button" class="btn ghost small push" data-item-edit="${esc(it.itemId)}">Edit</button>
    </div>`;
}

async function loadItems({ reset }) {
  const catalogue = $('items-catalogue').value;
  const node = $('items-list');
  if (!catalogue) { node.innerHTML = '<p class="empty">Choose a catalogue.</p>'; hide($('items-more')); return; }
  if (reset) { itemsCursor = null; itemsById.clear(); node.innerHTML = '<p class="empty">Loading…</p>'; }
  const q = $('items-q').value.trim();
  const params = new URLSearchParams({ limit: '50' });
  if (q) params.set('q', q);
  if (!reset && itemsCursor) params.set('after', itemsCursor);
  try {
    const { items, next } = await api(`/catalogues/${encodeURIComponent(catalogue)}/items?${params}`);
    itemsCursor = next;
    items.forEach((it) => itemsById.set(it.itemId, it));
    if (reset) node.innerHTML = items.length ? '' : '<p class="empty">No items found.</p>';
    if (items.length) node.insertAdjacentHTML('beforeend', items.map(itemRowHtml).join(''));
    node.querySelectorAll('[data-item-edit]').forEach((btn) => btn.addEventListener('click', () => openEdit(catalogue, btn.dataset.itemEdit)));
    $('items-more').hidden = !next;
  } catch (err) {
    if (reset) { node.innerHTML = `<p class="notice bad">${esc(err.message)}</p>`; hide($('items-more')); }
    else prependNotice(node, err.message);
  }
}

function openEdit(catalogueId, itemId) {
  const item = itemsById.get(itemId);
  if (!item) return;
  editing = { catalogueId, itemId };
  $('edit-label').value = item.label || '';
  $('edit-productId').value = item.productId || '';
  $('edit-attributes').value = JSON.stringify(item.attributes || {}, null, 2);
  hide($('edit-status'));
  show($('item-edit'));
  $('item-edit').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function applyItemPatch(catalogueId, itemId, patch) {
  return api(`/catalogues/${encodeURIComponent(catalogueId)}/items/${encodeURIComponent(itemId)}`, { method: 'PATCH', body: patch });
}

async function saveEdit() {
  if (!editing) return;
  const status = $('edit-status');
  hide(status);
  const item = itemsById.get(editing.itemId);
  const patch = {};
  const label = $('edit-label').value.trim();
  if (label !== (item.label || '')) patch.label = label || null;
  const productId = $('edit-productId').value.trim();
  if (productId !== (item.productId || '')) patch.productId = productId || null;
  const attrsText = $('edit-attributes').value.trim();
  let attributes;
  if (attrsText) {
    try {
      attributes = JSON.parse(attrsText);
    } catch {
      setNotice(status, 'Attributes must be valid JSON.', 'bad');
      return;
    }
    if (attributes === null || typeof attributes !== 'object' || Array.isArray(attributes)) {
      setNotice(status, 'Attributes must be a plain JSON object, e.g. {"Colour":"oak"}.', 'bad');
      return;
    }
  } else {
    attributes = {};
  }
  if (JSON.stringify(attributes) !== JSON.stringify(item.attributes || {})) patch.attributes = attributes;
  if (!Object.keys(patch).length) { setNotice(status, 'Nothing changed.', 'info'); return; }
  try {
    await applyItemPatch(editing.catalogueId, editing.itemId, patch);
    setNotice(status, 'Saved.', 'good');
    await loadItems({ reset: true });
  } catch (err) {
    setNotice(status, err.message, 'bad');
  }
}

async function setItemStatus(value) {
  if (!editing) return;
  const status = $('edit-status');
  try {
    await applyItemPatch(editing.catalogueId, editing.itemId, { status: value });
    setNotice(status, value === 'hidden' ? 'Hidden from clients.' : 'Shown to clients.', 'good');
    await loadItems({ reset: true });
  } catch (err) {
    setNotice(status, err.message, 'bad');
  }
}

$('items-catalogue').addEventListener('change', () => loadItems({ reset: true }));
$('items-q').addEventListener('input', () => {
  clearTimeout(itemsQTimer);
  itemsQTimer = setTimeout(() => loadItems({ reset: true }), 300);
});
$('items-more').addEventListener('click', () => loadItems({ reset: false }));
$('edit-save').addEventListener('click', saveEdit);
$('edit-hide').addEventListener('click', () => setItemStatus('hidden'));
$('edit-show').addEventListener('click', () => setItemStatus('ok'));
$('edit-cancel').addEventListener('click', () => { hide($('item-edit')); editing = null; });

// ====================================================================================================== 7. releases

function releaseRowHtml(r) {
  const pillars = r.pillars && typeof r.pillars === 'object' ? Object.keys(r.pillars).join(', ') : '';
  const tag = r.active ? '<span class="tag ok">Live</span>' : r.previous ? '<span class="tag running">Previous</span>' : '';
  return `
    <div>
      <strong>${esc(r.id)}</strong>
      <span class="muted">${esc(new Date(r.createdAt).toLocaleString())}</span>
      <span class="muted">${r.nItems ?? 0} items</span>
      <span class="muted">${esc(pillars || 'no search vectors')}</span>
      ${tag}
      ${r.active ? '' : `<button type="button" class="btn small push" data-release-activate="${esc(r.id)}">Activate</button>`}
    </div>`;
}

async function loadReleases() {
  const catalogue = $('releases-catalogue').value;
  const node = $('releases-list');
  if (!catalogue) { node.innerHTML = '<p class="empty">Choose a catalogue.</p>'; return; }
  node.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const { releases } = await api(`/catalogues/${encodeURIComponent(catalogue)}/releases`);
    node.innerHTML = releases.length ? releases.map(releaseRowHtml).join('') : '<p class="empty">No releases yet.</p>';
    node.querySelectorAll('[data-release-activate]').forEach((btn) => btn.addEventListener('click', () => activateRelease(catalogue, btn.dataset.releaseActivate)));
  } catch (err) {
    node.innerHTML = `<p class="notice bad">${esc(err.message)}</p>`;
  }
}

async function activateRelease(catalogue, releaseId) {
  try {
    await api(`/catalogues/${encodeURIComponent(catalogue)}/releases/${encodeURIComponent(releaseId)}/activate`, { method: 'POST' });
    await loadReleases();
    await refreshOverview();
  } catch (err) {
    prependNotice($('releases-list'), err.message);
  }
}

$('releases-catalogue').addEventListener('change', () => loadReleases());

// ====================================================================================================== init

if (token) {
  tokenInput.value = token;
  connect(token);
}
