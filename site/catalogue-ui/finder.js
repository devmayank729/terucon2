/**
 * The Finder page (pages/finder.html, target C4 point-and-identify, plus C7 colour match and C5 word search). Everything the
 * page does lives here: it is loaded as a module under a strict Content-Security-Policy ("strict+catalogue" in
 * site/site.json), so there is no inline script on the page at all.
 *
 * The only module this talks to the server through is ./client.js (server/catalogue/, catalogue/ARCHITECTURE.md section 7) —
 * see its own doc comments for the real contract. Nothing else here guesses at the API.
 *
 * "Search the whole photo" outlines the photo into its items (POST /api/vision/segment, the same OneFormer call as the shop's "Find it from a photo": the
 * outlining, regions and patch-cutting live in ./regions.js, shared with ./surfaces.js). A tap on an item cuts the largest clean rectangle inside it and
 * searches the catalogue with that, through client.searchPhoto(), and the results appear in the same block as for "Find it". The photo is always in one of
 * four modes (photoMode below): 'spot' (the box, "Find it" searches under it), 'outlining' (the models are working), 'regions' (the items are tappable) or
 * 'fallback' (outlining failed or found nothing: "Find it" and "Search the whole photo anyway" search the whole photo).
 */
import * as client from './client.js';
import { SEGMENT_TIMEOUT_MS, buildRegions, createOverlay, cutPatch, nameRegions, regionColour, segmentPhoto } from './regions.js';

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
  outline: document.getElementById('outline'),
  outlineTip: document.getElementById('outline-tip'),
  outlinePanel: document.getElementById('outline-panel'),
  outlineStatus: document.getElementById('outline-status'),
  outlineCancel: document.getElementById('outline-cancel'),
  outlineSignin: document.getElementById('outline-signin'),
  outlineRetry: document.getElementById('outline-retry'),
  outlineAnyway: document.getElementById('outline-anyway'),
  outlineSpot: document.getElementById('outline-spot'),
  outlineChips: document.getElementById('outline-chips'),
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
let stillOriginal = null; // the photo as it came (the file, or the camera frame): the patch of an item is cut from it, at full detail
let wholePhoto = false; // true in the 'regions' and 'fallback' modes: the next "Find it" omits `point`
let photoMode = 'spot'; // 'spot' | 'outlining' | 'regions' | 'fallback', see the note at the top
let searchable = true; // false while the catalogue is off or unreachable (the search buttons are disabled then)
// the whole-photo outlining: `token` changes whenever it is started, cancelled or the photo goes away (an answer for an older token is dropped);
// `result` is the outlined photo ({blob, ids, regions, w, h}) kept for the current photo, so asking again costs no second call to the models
const outline = { token: 0, controller: null, timer: null, result: null, map: null, bitmap: null, hover: null, selected: 0, searchSeq: 0 };
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

const HINTS = {
  spot: 'Drag the box onto one material, or search the whole photo.',
  outlining: 'Outlining the items in your photo… the first time can take up to a minute.',
  regions: 'Tap an item to find similar materials.',
  fallback: 'Tap the frame to pick a spot, or search the whole photo.',
};
function updateHint() {
  els.hint.textContent = HINTS[photoMode] ?? HINTS.spot;
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

// clicking the viewfinder itself (not the reticle) after the outlining failed brings the reticle back, at that spot (in the 'regions' mode a tap picks an item instead)
els.viewfinder.addEventListener('pointerdown', (event) => {
  if (photoMode !== 'fallback' || event.target === els.reticle) return;
  setPhotoMode('spot');
  const vf = els.viewfinder.getBoundingClientRect();
  layoutReticle(event.clientX - vf.left, event.clientY - vf.top);
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
  resetOutline();
  resetReticleCenter();
}

els.startCamera.addEventListener('click', async () => {
  try {
    const stream = await client.openCamera();
    if (stillUrl) {
      URL.revokeObjectURL(stillUrl);
      stillUrl = null;
    }
    stillBlob = null;
    stillOriginal = null;
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

/** Show a photo (`resized`: the JPEG to send, `original`: what it was made from, kept for cutting sharper patches) as the still, in place of the camera's video. */
function showStill(resized, original) {
  if (stillUrl) URL.revokeObjectURL(stillUrl);
  stillBlob = resized;
  stillOriginal = original;
  stillUrl = URL.createObjectURL(resized);
  els.still.src = stillUrl;
  els.still.hidden = false;
  els.video.hidden = true;
}

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
  showStill(resized, fileOrBlob);
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
  stillOriginal = null;
  els.still.src = '';
  els.still.hidden = true;
  els.video.hidden = true;
  els.viewfinder.hidden = true;
  els.photoActions.hidden = true;
  els.drop.hidden = false;
  els.file.value = '';
  resetOutline();
  els.reticle.hidden = true;
});

// ---------------------------------------------------------------------------------------------------------- outlining the whole photo

/** Which of the panel's buttons show: `names` are the ids' suffixes. */
function showOutlineButtons(...names) {
  const buttons = { cancel: els.outlineCancel, signin: els.outlineSignin, retry: els.outlineRetry, anyway: els.outlineAnyway, spot: els.outlineSpot };
  for (const [name, button] of Object.entries(buttons)) button.hidden = !names.includes(name);
}

const setOutlineStatus = (text) => (els.outlineStatus.textContent = text);

/** Put the photo in one of its four modes: what shows over it, which buttons are there, what "Find it" does (see the note at the top). */
function setPhotoMode(next) {
  photoMode = next;
  wholePhoto = next === 'regions' || next === 'fallback';
  els.reticle.hidden = next !== 'spot';
  els.viewfinder.classList.toggle('is-outlining', next === 'outlining');
  els.outline.hidden = next !== 'regions';
  els.outlineTip.hidden = true;
  els.outlinePanel.hidden = next === 'spot';
  els.photoActions.classList.toggle('is-below-panel', next !== 'spot');
  els.outlineChips.hidden = next !== 'regions';
  if (next === 'spot') {
    showOutlineButtons();
    setOutlineStatus('');
    outline.hover = null;
    outline.selected = 0;
    const rect = els.viewfinder.getBoundingClientRect();
    if (rect.width && rect.height) layoutReticle(reticleCenter.xFrac * rect.width, reticleCenter.yFrac * rect.height);
  }
  // while the models work nothing else can start; the buttons go back to what the catalogue's state allows
  setDisabled([els.goPhoto, els.wholePhotoBtn], next === 'outlining' || !searchable);
  updateHint();
}

/** Forget everything about the outlining (the photo changed or went away): stop a call in flight, drop its answer and the patches' source, go back to the box. */
function resetOutline() {
  outline.token += 1;
  outline.searchSeq += 1;
  if (outline.controller) outline.controller.abort();
  clearTimeout(outline.timer);
  outline.controller = null;
  outline.result = null;
  outline.map = null;
  if (outline.bitmap) outline.bitmap.close();
  outline.bitmap = null;
  els.outlineChips.replaceChildren();
  setBusy(els.wholePhotoBtn, false);
  setPhotoMode('spot');
}

/** "Cancel" and "Pick a spot instead": back to the box. The call to the models, if one is running, is dropped without a word. */
function backToSpot() {
  outline.token += 1;
  outline.searchSeq += 1;
  if (outline.controller) outline.controller.abort();
  clearTimeout(outline.timer);
  outline.controller = null;
  setBusy(els.wholePhotoBtn, false);
  setPhotoMode('spot');
}

/** With the camera live, regions over moving video mean nothing: take the current frame, show it as the still and switch the camera off. */
async function freezePhoto() {
  if (!liveStream) return stillBlob;
  const frame = await client.captureFrame(els.video);
  stopCamera();
  showStill(frame, frame);
  return frame;
}

/** The plain sentence for an outlining that failed (never the server's own words), and whether trying again could help. */
function outlineFailure(err) {
  const status = err?.status ?? 0;
  if (err?.reason === 'unauthorized' || status === 401) return { message: 'Please sign in again to outline the photo.', signin: true };
  if (status === 429) return { message: 'Outlining has been used a lot in the last hour.', retry: false };
  if (err?.reason === 'timeout') return { message: 'Outlining took too long.', retry: true };
  if (err?.reason === 'network') return { message: 'Could not reach the server. Check your connection.', retry: true };
  if (status >= 500 || status === 404) return { message: 'The outlining service is not available right now.', retry: true };
  return { message: 'We could not outline this photo.', retry: true };
}

/** Outlining failed or found nothing: say so, and offer the old whole-photo search (and the box). */
function outlineFailed({ message, signin = false, retry = false }) {
  setPhotoMode('fallback');
  setOutlineStatus(`${message} You can still search the whole photo, or pick a spot.`);
  showOutlineButtons(...(signin ? ['signin'] : retry ? ['retry'] : []), 'anyway', 'spot');
}

/** "Search the whole photo": outline the photo into its items. */
async function startOutlining() {
  if (!searchable || photoMode === 'outlining') return;
  if (photoMode === 'regions') return; // already outlined: the items are there to tap
  if (outline.result) {
    showRegions(); // outlined before (then "Pick a spot instead"): the same photo, so the models are not asked again
    return;
  }
  const token = ++outline.token;
  setPhotoMode('outlining');
  setBusy(els.wholePhotoBtn, true, 'Outlining…');
  showOutlineButtons('cancel');
  setOutlineStatus('Outlining the items in your photo… the first time can take up to a minute while the models wake up.');
  let photo;
  try {
    photo = await freezePhoto();
  } catch {
    if (token !== outline.token) return;
    backToSpot();
    flashStatus('Could not capture the photo. Try again.');
    return;
  }
  if (token !== outline.token) return;
  if (!(photo instanceof Blob)) {
    backToSpot();
    flashStatus('Show it a photo first: use the camera or upload one.');
    return;
  }
  const controller = new AbortController();
  outline.controller = controller;
  outline.timer = setTimeout(() => controller.abort(), SEGMENT_TIMEOUT_MS);
  client.warm(); // the search service wakes while the models work; errors are swallowed inside client.js
  try {
    const seg = await segmentPhoto(photo, controller.signal);
    if (token !== outline.token) return;
    const { ids, regions } = buildRegions(seg.width, seg.height, seg.classMap, seg.labels, seg.instanceMap);
    nameRegions(regions, seg.width);
    if (!regions.length) {
      setBusy(els.wholePhotoBtn, false);
      outlineFailed({ message: 'We could not find separate items in this photo.' });
      return;
    }
    outline.result = { blob: photo, ids, regions, w: seg.width, h: seg.height };
    setBusy(els.wholePhotoBtn, false);
    showRegions();
  } catch (err) {
    if (token !== outline.token) return; // cancelled, or the photo went away: nothing to say
    setBusy(els.wholePhotoBtn, false);
    outlineFailed(outlineFailure(err));
  } finally {
    if (token === outline.token) {
      clearTimeout(outline.timer);
      outline.controller = null;
    }
  }
}

// ---- the items

const selectedRegion = () => outline.result?.regions[outline.selected - 1] ?? null;
const repaint = () => outline.map?.paint(outline.hover, selectedRegion());

/** The photo is outlined: paint the items over it and make them tappable (by pointer, and by the buttons below for a keyboard or a finger that misses). */
function showRegions() {
  const r = outline.result;
  outline.map = createOverlay(els.outline, { ids: r.ids, w: r.w, h: r.h, regions: r.regions, base: true });
  outline.hover = null;
  outline.selected = 0;
  els.outlineChips.replaceChildren();
  for (const region of [...r.regions].sort((a, b) => b.area - a.area).slice(0, 10)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.region = String(region.id);
    chip.setAttribute('aria-pressed', 'false');
    const dot = document.createElement('span');
    dot.className = 'chip-dot';
    dot.style.background = regionColour(region);
    chip.append(dot, document.createTextNode(region.label));
    const light = (on) => { outline.hover = on ? region : null; repaint(); };
    chip.addEventListener('mouseenter', () => light(true));
    chip.addEventListener('mouseleave', () => light(false));
    chip.addEventListener('focus', () => light(true));
    chip.addEventListener('blur', () => light(false));
    chip.addEventListener('click', () => searchRegion(region));
    els.outlineChips.appendChild(chip);
  }
  setPhotoMode('regions');
  showOutlineButtons('spot');
  setOutlineStatus('Tap an item in the photo to find similar materials. “Find it” searches the whole photo.');
  repaint();
}

els.outline.addEventListener('pointermove', (event) => {
  if (!outline.map) return;
  const region = outline.map.regionAt(event.clientX, event.clientY);
  if (region !== outline.hover) {
    outline.hover = region;
    repaint();
  }
  els.outline.classList.toggle('is-hit', Boolean(region));
  els.outlineTip.hidden = !region || event.pointerType !== 'mouse';
  if (region && event.pointerType === 'mouse') {
    const frame = els.viewfinder.getBoundingClientRect();
    els.outlineTip.textContent = region.label;
    els.outlineTip.style.left = `${Math.max(4, Math.min(event.clientX - frame.left + 14, frame.width - 110))}px`;
    els.outlineTip.style.top = `${Math.max(event.clientY - frame.top - 34, 4)}px`;
  }
});
els.outline.addEventListener('pointerleave', () => {
  outline.hover = null;
  els.outlineTip.hidden = true;
  els.outline.classList.remove('is-hit');
  repaint();
});
els.outline.addEventListener('click', (event) => {
  const region = outline.map?.regionAt(event.clientX, event.clientY) ?? outline.hover;
  if (region) searchRegion(region);
  else setOutlineStatus('That part of the photo is not one of the items. Tap one of the coloured items, or pick a spot instead.');
});

/** The photo to cut an item's patch from: the original at full detail (the 1024 px copy that went to the models is the fallback). */
async function patchSource() {
  if (outline.bitmap) return outline.bitmap;
  let bitmap;
  try {
    bitmap = await createImageBitmap(stillOriginal ?? stillBlob, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await createImageBitmap(stillBlob, { imageOrientation: 'from-image' });
  }
  outline.bitmap = bitmap;
  return bitmap;
}

/** A tap on an item: cut the largest clean rectangle inside it, search the catalogue with it, show the closest materials. */
async function searchRegion(region) {
  const r = outline.result;
  if (!r || photoMode !== 'regions') return;
  const seq = ++outline.searchSeq;
  const stale = () => seq !== outline.searchSeq || outline.result !== r || photoMode !== 'regions';
  outline.selected = region.id;
  repaint();
  for (const chip of els.outlineChips.children) chip.setAttribute('aria-pressed', String(chip.dataset.region === String(region.id)));
  const what = region.label.toLowerCase();
  setOutlineStatus(`Looking for materials like the ${what}…`);
  try {
    const { blob, clean } = await cutPatch(await patchSource(), r.ids, r.w, r.h, region);
    if (stale()) return;
    const res = await client.searchPhoto({ photo: blob, mode: currentMode === 'colour' ? 'colour' : 'look', k: 8 });
    if (stale()) return;
    renderResults(res, { forWhat: `the ${what}`, scroll: true });
    setOutlineStatus(`Showing materials like the ${what}${clean ? '' : ' (this item is small or broken up, so the match is rougher)'}. Tap another item to search again.`);
  } catch (err) {
    if (stale()) return;
    const { message, retryAfter } = searchFailure(err);
    setOutlineStatus(message);
    if (retryAfter > 0 && retryAfter <= 30) setTimeout(() => { if (!stale()) searchRegion(region); }, retryAfter * 1000);
  }
}

els.wholePhotoBtn.addEventListener('click', startOutlining);
els.outlineCancel.addEventListener('click', backToSpot);
els.outlineSpot.addEventListener('click', backToSpot);
els.outlineRetry.addEventListener('click', startOutlining);
els.outlineSignin.addEventListener('click', () => location.assign('/login?next=' + encodeURIComponent(location.pathname)));
els.outlineAnyway.addEventListener('click', () => findIt(els.outlineAnyway, { scroll: true }));

// ---------------------------------------------------------------------------------------------------------- results

/** `forWhat`: what was searched, when it was one item of the photo ("the floor"): said in the line above the cards. `scroll`: bring the cards into view (the buttons are far above them on a phone). */
function renderResults(res, { forWhat = '', scroll = false } = {}) {
  els.results.replaceChildren();
  const items = res?.items ?? [];
  for (const item of items) {
    const li = document.createElement('li');
    li.innerHTML = client.resultCardHtml(item);
    els.results.appendChild(li);
  }
  if (items.length === 0) els.resultsMeta.textContent = forWhat ? `No close matches for ${forWhat} yet — tap another item, or pick a spot instead.` : 'No close matches yet — try a different spot, a wider view, or describe it in words instead.';
  else els.resultsMeta.textContent = `${items.length} match${items.length === 1 ? '' : 'es'}${forWhat ? ` for ${forWhat}` : ''}`;
  els.resultsBlock.hidden = false;
  if (scroll) {
    try {
      els.resultsBlock.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    } catch {
      /* no scrolling here: the cards are still on the page */
    }
  }
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

/** What to tell the visitor when a search was refused, and how many seconds to wait before one quiet retry (0: none) — for 'busy' and 'warming', which say how long. */
function searchFailure(err) {
  const message = err instanceof client.CatalogueClientError ? client.friendlyMessage(err) : 'Something went wrong. Please try again.';
  const retryAfter = err instanceof client.CatalogueClientError && (err.reason === 'busy' || err.reason === 'warming') ? Number(err.retryAfter) : 0;
  return { message, retryAfter: retryAfter > 0 ? retryAfter : 0 };
}

/** Run a search, show its results, and cope with a refusal: a plain message, and (for 'busy'/'warming' with a wait time) one quiet retry. */
async function runSearch(doSearch, { trigger, disable, scroll = false }) {
  setDisabled(disable, true);
  setBusy(trigger, true);
  try {
    const res = await doSearch();
    renderResults(res, { scroll });
  } catch (err) {
    const { message, retryAfter } = searchFailure(err);
    flashStatus(message, retryAfter > 0 ? Math.max(4000, retryAfter * 1000) : 6000);
    if (retryAfter > 0 && retryAfter <= 30) setTimeout(() => runSearch(doSearch, { trigger, disable, scroll }), retryAfter * 1000);
  } finally {
    setBusy(trigger, false);
    setDisabled(disable, false);
  }
}

/** "Find it" (or "Search the whole photo anyway"): search with the box's spot, or, once the whole photo was chosen, with no spot. */
async function findIt(trigger = els.goPhoto, { scroll = false } = {}) {
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
  await runSearch(() => client.searchPhoto({ photo, mode: currentMode === 'colour' ? 'colour' : 'look', point, k: 8 }), { trigger, disable: [els.goPhoto, els.retake, els.wholePhotoBtn, els.outlineAnyway], scroll });
}
els.goPhoto.addEventListener('click', () => findIt());

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
  const statusButtons = [els.modePhoto, els.modeColour, els.modeWords, els.goPhoto, els.wholePhotoBtn, els.goWords];
  try {
    const st = await client.status();
    if (!st?.enabled || !st?.ready) {
      persistentNotice = statusMessage(st?.reasons || []);
      persistentAction = null;
      showStatus(persistentNotice);
      searchable = false;
      setDisabled(statusButtons, true);
    } else {
      persistentNotice = null;
      persistentAction = null;
      restoreStatus();
      searchable = true;
      setDisabled(statusButtons, false);
    }
  } catch (err) {
    // status() does not normally throw on a 200; this covers a network failure, or a real refusal (e.g. the session
    // ended), reaching it at all — client.friendlyMessage() already has the right sentence for either
    persistentNotice = err instanceof client.CatalogueClientError ? client.friendlyMessage(err) : 'Catalogue search is not available right now. Please try again in a minute.';
    persistentAction = err?.reason === 'unauthorized' ? { label: 'Sign in', run: () => location.assign('/login?next=' + encodeURIComponent(location.pathname)) } : { label: 'Try again', run: checkStatus };
    showStatus(persistentNotice, persistentAction);
    searchable = false;
    setDisabled(statusButtons, true);
  }
}

async function init() {
  client.warm(); // fire-and-forget; errors are already swallowed inside client.js
  await checkStatus();
  await tryInspirationImport();
}

init();
