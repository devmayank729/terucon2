/**
 * The Finder page (pages/finder.html, target C4 point-and-identify, plus C7 colour match and C5 word search). Everything the
 * page does lives here: it is loaded as a module under a strict Content-Security-Policy ("strict+catalogue" in
 * site/site.json), so there is no inline script on the page at all.
 *
 * The only module this talks to the server through is ./client.js (server/catalogue/, catalogue/ARCHITECTURE.md section 7) —
 * see its own doc comments for the real contract. Nothing else here guesses at the API.
 */
import * as client from './client.js';

// ---------------------------------------------------------------------------------------------------------- elements

const els = {
  status: document.getElementById('status'),
  modePhoto: document.getElementById('mode-photo'),
  modeColour: document.getElementById('mode-colour'),
  modeWords: document.getElementById('mode-words'),
  photoPanel: document.getElementById('photo-panel'),
  wordsPanel: document.getElementById('words-panel'),
  viewfinder: document.getElementById('viewfinder'),
  video: document.getElementById('video'),
  still: document.getElementById('still'),
  reticle: document.getElementById('reticle'),
  hint: document.getElementById('hint'),
  drop: document.getElementById('drop'),
  startCamera: document.getElementById('start-camera'),
  file: document.getElementById('file'),
  photoActions: document.getElementById('photo-actions'),
  goPhoto: document.getElementById('go-photo'),
  wholePhotoBtn: document.getElementById('whole-photo'),
  retake: document.getElementById('retake'),
  wordInput: document.getElementById('word-input'),
  goWords: document.getElementById('go-words'),
  resultsBlock: document.getElementById('results-block'),
  resultsMeta: document.getElementById('results-meta'),
  results: document.getElementById('results'),
};

// ---------------------------------------------------------------------------------------------------------- state

let currentMode = 'photo'; // 'photo' | 'colour' | 'words' — what the three tabs show; 'colour' still uses the camera/upload flow
let liveStream = null; // the MediaStream behind #video, while the camera is open
let stillBlob = null; // the already-resized JPEG behind #still, ready to send as-is
let stillUrl = null; // its object URL, so it can be revoked
let wholePhoto = false; // true once "Search the whole photo" was chosen: the next search omits `point`
let reticleCenter = { xFrac: 0.5, yFrac: 0.5 }; // the reticle's centre, as a fraction of the viewfinder's own box
let persistentNotice = null; // the "catalogue is off/not ready" message, if any: kept showing under any temporary one
let persistentAction = null; // the button that goes with it, if any ({label, run}): "Try again" when the server could not be reached
let flashTimer = null;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// ---------------------------------------------------------------------------------------------------------- #status

function showStatus(message, action) {
  els.status.hidden = false;
  els.status.textContent = message;
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'link';
    button.textContent = action.label;
    button.addEventListener('click', action.run);
    els.status.append(' ', button);
  }
}

function restoreStatus() {
  if (persistentNotice) showStatus(persistentNotice, persistentAction);
  else {
    els.status.hidden = true;
    els.status.textContent = '';
  }
}

/** A message that shows for a while, then gives the status line back to the persistent notice (or hides it). */
function flashStatus(message, ms = 6000) {
  showStatus(message);
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(restoreStatus, ms);
}

// Plain-language sentences for GET /api/catalogue/status's own `reasons` slugs (server/catalogue/service.js). Not the same
// vocabulary as client.friendlyMessage(), which is for a failed search call, not for this page-load check.
const STATUS_REASON_TEXT = {
  off: 'Catalogue search is switched off here right now.',
  'modal-not-configured': 'Catalogue search is not switched on here yet.',
  'storage-not-configured': 'Catalogue search is not available right now. Please try again in a minute.',
  'database-unavailable': 'Catalogue search is not available right now. Please try again in a minute.',
  'no-live-catalogue': 'There is no catalogue to search yet.',
};

function statusMessage(reasons) {
  for (const reason of reasons) if (STATUS_REASON_TEXT[reason]) return STATUS_REASON_TEXT[reason];
  return 'Catalogue search is not available right now. Please try again in a minute.';
}

// ---------------------------------------------------------------------------------------------------------- modes

function setMode(mode) {
  currentMode = mode;
  els.modePhoto.setAttribute('aria-pressed', String(mode === 'photo'));
  els.modeColour.setAttribute('aria-pressed', String(mode === 'colour'));
  els.modeWords.setAttribute('aria-pressed', String(mode === 'words'));
  els.photoPanel.hidden = mode === 'words';
  els.wordsPanel.hidden = mode !== 'words';
}

els.modePhoto.addEventListener('click', () => setMode('photo'));
els.modeColour.addEventListener('click', () => setMode('colour'));
els.modeWords.addEventListener('click', () => setMode('words'));

// ---------------------------------------------------------------------------------------------------------- the reticle

function updateHint() {
  els.hint.textContent = wholePhoto ? 'Searching the whole photo — tap the frame to pick a spot instead.' : 'Drag the box onto one material, or search the whole photo.';
}

/** Size and place the reticle so its centre sits at (cxPx, cyPx) inside the viewfinder, clamped fully inside it. */
function layoutReticle(cxPx, cyPx) {
  const rect = els.viewfinder.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const size = 0.24 * Math.min(rect.width, rect.height); // the server's default search radius (0.12) as a box side
  const half = size / 2;
  const x = clamp(cxPx, half, rect.width - half);
  const y = clamp(cyPx, half, rect.height - half);
  els.reticle.style.width = `${size}px`;
  els.reticle.style.height = `${size}px`;
  els.reticle.style.left = `${x - half}px`;
  els.reticle.style.top = `${y - half}px`;
  reticleCenter = { xFrac: x / rect.width, yFrac: y / rect.height };
}

function resetReticleCenter() {
  const rect = els.viewfinder.getBoundingClientRect();
  layoutReticle(rect.width / 2, rect.height / 2);
}

let dragOffset = null;
els.reticle.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  wholePhoto = false;
  els.reticle.setPointerCapture(event.pointerId);
  const r = els.reticle.getBoundingClientRect();
  dragOffset = { dx: event.clientX - r.left, dy: event.clientY - r.top };
  updateHint();
});
els.reticle.addEventListener('pointermove', (event) => {
  if (!dragOffset) return;
  const vf = els.viewfinder.getBoundingClientRect();
  const size = els.reticle.offsetWidth;
  layoutReticle(event.clientX - vf.left - dragOffset.dx + size / 2, event.clientY - vf.top - dragOffset.dy + size / 2);
});
for (const evt of ['pointerup', 'pointercancel']) els.reticle.addEventListener(evt, () => (dragOffset = null));
els.reticle.addEventListener('keydown', (event) => {
  const step = 0.02;
  let { xFrac, yFrac } = reticleCenter;
  if (event.key === 'ArrowLeft') xFrac -= step;
  else if (event.key === 'ArrowRight') xFrac += step;
  else if (event.key === 'ArrowUp') yFrac -= step;
  else if (event.key === 'ArrowDown') yFrac += step;
  else return;
  event.preventDefault();
  wholePhoto = false;
  const rect = els.viewfinder.getBoundingClientRect();
  layoutReticle(xFrac * rect.width, yFrac * rect.height);
  updateHint();
});

// clicking the viewfinder itself (not the reticle) while "whole photo" is selected brings the reticle back, at that spot
els.viewfinder.addEventListener('pointerdown', (event) => {
  if (!wholePhoto || event.target === els.reticle) return;
  wholePhoto = false;
  els.reticle.hidden = false;
  const vf = els.viewfinder.getBoundingClientRect();
  layoutReticle(event.clientX - vf.left, event.clientY - vf.top);
  updateHint();
});

els.wholePhotoBtn.addEventListener('click', () => {
  wholePhoto = true;
  els.reticle.hidden = true;
  updateHint();
});

window.addEventListener('resize', () => {
  if (els.viewfinder.hidden || els.reticle.hidden) return;
  const rect = els.viewfinder.getBoundingClientRect();
  layoutReticle(reticleCenter.xFrac * rect.width, reticleCenter.yFrac * rect.height);
});

// ---------------------------------------------------------------------------------------------------------- camera / upload

/** Give the viewfinder box the shape of the picture it shows, so the reticle's place in the box is its place in the picture (a phone's camera is tall, not 4:3). */
function fitViewfinder() {
  const source = !els.video.hidden && els.video.videoWidth ? { w: els.video.videoWidth, h: els.video.videoHeight } : { w: els.still.naturalWidth, h: els.still.naturalHeight };
  if (!source.w || !source.h) return;
  els.viewfinder.style.setProperty('--vf-ar', String(source.w / source.h));
  if (els.viewfinder.hidden || els.reticle.hidden) return;
  const rect = els.viewfinder.getBoundingClientRect();
  layoutReticle(reticleCenter.xFrac * rect.width, reticleCenter.yFrac * rect.height);
}
els.video.addEventListener('loadedmetadata', fitViewfinder);
els.video.addEventListener('resize', fitViewfinder);
els.still.addEventListener('load', fitViewfinder);

function stopCamera() {
  if (liveStream) {
    for (const track of liveStream.getTracks()) track.stop();
    liveStream = null;
  }
  els.video.srcObject = null;
}

function openViewfinder() {
  els.drop.hidden = true;
  els.viewfinder.hidden = false;
  els.photoActions.hidden = false;
  wholePhoto = false;
  els.reticle.hidden = false;
  resetReticleCenter();
  updateHint();
}

els.startCamera.addEventListener('click', async () => {
  try {
    const stream = await client.openCamera();
    if (stillUrl) {
      URL.revokeObjectURL(stillUrl);
      stillUrl = null;
    }
    stillBlob = null;
    els.still.hidden = true;
    liveStream = stream;
    els.video.srcObject = stream;
    els.video.hidden = false;
    try {
      await els.video.play();
    } catch {
      /* some browsers resolve play() late; the stream still shows once it is ready */
    }
    openViewfinder();
    fitViewfinder();
  } catch (err) {
    flashStatus(err instanceof client.CatalogueClientError ? client.friendlyMessage(err) : 'The camera could not be started. You can still upload a photo.');
  }
});

/** Resize a File/Blob and show it as the still photo — used for an upload and for a photo handed over from Inspiration. */
async function useStillSource(fileOrBlob) {
  let resized;
  try {
    resized = await client.resizeToJpeg(fileOrBlob);
  } catch {
    flashStatus('We could not read that as a photo. Try another one.');
    return;
  }
  stopCamera();
  if (stillUrl) URL.revokeObjectURL(stillUrl);
  stillBlob = resized;
  stillUrl = URL.createObjectURL(resized);
  els.still.src = stillUrl;
  els.still.hidden = false;
  els.video.hidden = true;
  openViewfinder();
}

els.file.addEventListener('change', async () => {
  const file = els.file.files?.[0];
  els.file.value = '';
  if (file) await useStillSource(file);
});

els.retake.addEventListener('click', () => {
  stopCamera();
  if (stillUrl) {
    URL.revokeObjectURL(stillUrl);
    stillUrl = null;
  }
  stillBlob = null;
  els.still.src = '';
  els.still.hidden = true;
  els.video.hidden = true;
  els.viewfinder.hidden = true;
  els.photoActions.hidden = true;
  els.drop.hidden = false;
  els.file.value = '';
  wholePhoto = false;
  els.reticle.hidden = true;
});

// ---------------------------------------------------------------------------------------------------------- results

function renderResults(res) {
  els.results.replaceChildren();
  const items = res?.items ?? [];
  for (const item of items) {
    const li = document.createElement('li');
    li.innerHTML = client.resultCardHtml(item);
    els.results.appendChild(li);
  }
  els.resultsMeta.textContent = items.length === 0 ? 'No close matches yet — try a different spot, a wider view, or describe it in words instead.' : `${items.length} match${items.length === 1 ? '' : 'es'}`;
  els.resultsBlock.hidden = false;
}

function setBusy(button, busy, label = 'Searching…') {
  if (busy) {
    button.dataset.label = button.textContent;
    button.replaceChildren(Object.assign(document.createElement('span'), { className: 'spinner' }), document.createTextNode(' ' + label));
  } else if (button.dataset.label !== undefined) {
    button.textContent = button.dataset.label;
    delete button.dataset.label;
  }
  button.disabled = busy;
}

const setDisabled = (buttons, disabled) => buttons.forEach((b) => (b.disabled = disabled));

/** Run a search, show its results, and cope with a refusal: a plain message, and (for 'busy'/'warming' with a wait time) one quiet retry. */
async function runSearch(doSearch, { trigger, disable }) {
  setDisabled(disable, true);
  setBusy(trigger, true);
  try {
    const res = await doSearch();
    renderResults(res);
  } catch (err) {
    const message = err instanceof client.CatalogueClientError ? client.friendlyMessage(err) : 'Something went wrong. Please try again.';
    const retryAfter = err instanceof client.CatalogueClientError && (err.reason === 'busy' || err.reason === 'warming') ? Number(err.retryAfter) : 0;
    flashStatus(message, retryAfter > 0 ? Math.max(4000, retryAfter * 1000) : 6000);
    if (retryAfter > 0 && retryAfter <= 30) setTimeout(() => runSearch(doSearch, { trigger, disable }), retryAfter * 1000);
  } finally {
    setBusy(trigger, false);
    setDisabled(disable, false);
  }
}

els.goPhoto.addEventListener('click', async () => {
  let photo;
  try {
    photo = liveStream ? await client.captureFrame(els.video) : stillBlob;
  } catch {
    flashStatus('Could not capture the photo. Try again.');
    return;
  }
  if (!(photo instanceof Blob)) {
    flashStatus('Show it a photo first: use the camera or upload one.');
    return;
  }
  const point = wholePhoto ? undefined : [reticleCenter.xFrac, reticleCenter.yFrac];
  await runSearch(() => client.searchPhoto({ photo, mode: currentMode === 'colour' ? 'colour' : 'look', point, k: 8 }), { trigger: els.goPhoto, disable: [els.goPhoto, els.retake, els.wholePhotoBtn] });
});

function doWordsSearch() {
  const text = els.wordInput.value;
  runSearch(() => client.searchText({ text, k: 8 }), { trigger: els.goWords, disable: [els.goWords] });
}
els.goWords.addEventListener('click', doWordsSearch);
els.wordInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    doWordsSearch();
  }
});

// ---------------------------------------------------------------------------------------------------------- inspiration hand-off

/** A photo cropped on the Inspiration page can arrive here as ?import=<id> (site/inspiration/flow.js, "Find similar materials"). */
async function tryInspirationImport() {
  const id = new URLSearchParams(location.search).get('import');
  if (!id) return;
  try {
    const { take } = await import('/inspiration/assets/handoff.js');
    const found = await take(id);
    history.replaceState(null, '', location.pathname);
    if (found?.blob) await useStillSource(found.blob);
  } catch {
    // expired, already used, or the module failed to load: fall back to the normal empty state, no error shown
    try {
      history.replaceState(null, '', location.pathname);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------------------------------------- start-up

/** Ask the server whether the catalogue can be searched, and say so plainly if not. Re-run by the "Try again" button after a connection failure. */
async function checkStatus() {
  const statusButtons = [els.modePhoto, els.modeColour, els.modeWords, els.goPhoto, els.goWords];
  try {
    const st = await client.status();
    if (!st?.enabled || !st?.ready) {
      persistentNotice = statusMessage(st?.reasons || []);
      persistentAction = null;
      showStatus(persistentNotice);
      setDisabled(statusButtons, true);
    } else {
      persistentNotice = null;
      persistentAction = null;
      restoreStatus();
      setDisabled(statusButtons, false);
    }
  } catch (err) {
    // status() does not normally throw on a 200; this covers a network failure, or a real refusal (e.g. the session
    // ended), reaching it at all — client.friendlyMessage() already has the right sentence for either
    persistentNotice = err instanceof client.CatalogueClientError ? client.friendlyMessage(err) : 'Catalogue search is not available right now. Please try again in a minute.';
    persistentAction = err?.reason === 'unauthorized' ? { label: 'Sign in', run: () => location.assign('/login?next=' + encodeURIComponent(location.pathname)) } : { label: 'Try again', run: checkStatus };
    showStatus(persistentNotice, persistentAction);
    setDisabled(statusButtons, true);
  }
}

async function init() {
  client.warm(); // fire-and-forget; errors are already swallowed inside client.js
  await checkStatus();
  await tryInspirationImport();
}

init();
