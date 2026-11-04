/**
 * "Find it from a photo" in the shop, for real (targets C4, A1): pick or paste a photo, the models outline its surfaces (OneFormer on Modal, through the
 * Design Studio's own scan route), a surface lights up under the pointer, tapping it searches the real catalogue with a clean patch of that surface, and
 * the closest designs appear below with the shop's price and a link to buy.
 *
 *   window.TeruconSurfaces.open({fallback})   true when this dialog took over; `fallback` is the shop's own colour preview, called when the catalogue
 *                                             search is not available (off, not set up, not signed in)
 *
 * Loaded by the `surfaces-*` steps of site/patches/materials.json. The shop's own sheet is untouched and is what `fallback` opens.
 *
 * What it calls, in order: GET /api/catalogue/status (is search on?) -> POST /api/vision/segment?model=oneformer (the photo, shrunk to 1024 px; answers a
 * class map: which of 150 kinds of thing each pixel is) -> in the browser: connected regions of each class (so "left wall" and "right wall" are two
 * regions) -> on a tap: the largest clean rectangle inside the region is cut from the photo -> POST /api/catalogue/search (that patch) -> each result
 * carries `shop` (server/lib/shopLink.js): the shop product with the same id, its listed price and its picture. If the outlining fails the whole photo
 * can still be searched.
 *
 * Plain ES module, no dependency, no HTML from strings: every piece of text goes in with textContent.
 */
import { CatalogueClientError, friendlyMessage, resizeToJpeg, searchPhoto, status as catalogueStatus, warm } from './client.js';
import { SEGMENT_SIDE, SEGMENT_TIMEOUT_MS, buildRegions, createOverlay, cutPatch, friendlyLabel, largestInnerRect, nameRegions, patchFor, segmentPhoto } from './regions.js';

// the outlining, the regions and the patch are shared with the Finder page (regions.js); they stay importable from here
export { buildRegions, nameRegions, largestInnerRect, patchFor, friendlyLabel };

const state = { el: null, fallback: null, photo: null, token: 0 };

// ---------------------------------------------------------------------------------------------------------------- small helpers
function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function button(label, cls, onClick) {
  const b = h('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

// ---------------------------------------------------------------------------------------------------------------- the dialog
function close() {
  state.token += 1;
  if (state.photo?.url) URL.revokeObjectURL(state.photo.url);
  state.photo = null;
  if (state.el) state.el.remove();
  state.el = null;
  document.documentElement.classList.remove('tcs-open');
  document.removeEventListener('keydown', onKey, true);
}
function onKey(e) {
  if (e.key === 'Escape' && state.el) { e.stopPropagation(); close(); }
}

function build() {
  const root = h('div', 'tcs');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Find it from a photo');
  const scrim = h('div', 'tcs__scrim');
  scrim.addEventListener('click', close);
  const sheet = h('div', 'tcs__sheet');
  const head = h('div', 'tcs__head');
  const titles = h('div', 'tcs__titles');
  titles.appendChild(h('span', 'tcs__eyebrow', 'Photo match'));
  titles.appendChild(h('span', 'tcs__title', 'Find it from a photo.'));
  head.appendChild(titles);
  head.appendChild(button('Close ×', 'tcs__close', close));
  const body = h('div', 'tcs__body');
  const foot = h('p', 'tcs__foot', 'Your photo is sent to our servers to outline its surfaces and search the catalogue. It is not saved to your account or added to a project.');
  sheet.append(head, body, foot);
  root.append(scrim, sheet);
  return { root, body, sheet };
}

function setBody(nodes) {
  state.ui.body.replaceChildren(...nodes);
}

function pickView(note) {
  const wrap = h('div', 'tcs__pick');
  if (note) wrap.appendChild(h('p', 'tcs__note', note));
  const drop = h('div', 'tcs__drop');
  drop.appendChild(h('span', 'tcs__dropTitle', 'Drop a photo here'));
  drop.appendChild(h('span', 'tcs__dropText', 'A façade you walked past, a room you like, a sample in your hand, or a screenshot from a mood board. We outline each surface so you can tap the one you want.'));
  const row = h('div', 'tcs__row');
  const gallery = h('input');
  gallery.type = 'file';
  gallery.accept = 'image/*';
  gallery.hidden = true;
  const camera = h('input');
  camera.type = 'file';
  camera.accept = 'image/*';
  camera.setAttribute('capture', 'environment');
  camera.hidden = true;
  for (const input of [gallery, camera]) input.addEventListener('change', () => { const f = input.files?.[0]; input.value = ''; if (f) start(f); });
  row.appendChild(button('Choose a photo', 'tcs__btn tcs__btn--main', () => gallery.click()));
  row.appendChild(button('Take a photo', 'tcs__btn', () => camera.click()));
  drop.append(row, gallery, camera);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('is-over'); const f = [...(e.dataTransfer?.files ?? [])].find((x) => /^image\//.test(x.type)); if (f) start(f); });
  wrap.appendChild(drop);

  const link = h('form', 'tcs__link');
  const input = h('input', 'tcs__linkInput');
  input.type = 'url';
  input.placeholder = 'Or paste a link to a photo (Pinterest, a web page, a picture address)';
  input.setAttribute('aria-label', 'Link to a photo');
  input.autocomplete = 'off';
  const go = h('button', 'tcs__btn', 'Use link');
  go.type = 'submit';
  link.append(input, go);
  link.addEventListener('submit', (e) => { e.preventDefault(); if (input.value.trim()) startFromLink(input.value.trim(), go); });
  wrap.appendChild(link);
  setBody([wrap]);
}

async function startFromLink(address, goButton) {
  const mine = ++state.token;
  goButton.disabled = true;
  goButton.textContent = 'Fetching…';
  try {
    const api = await import('/inspiration/assets/api.js');
    const found = await api.resolveAddress(address);
    const first = found?.items?.[0];
    if (!first) throw new Error('There is no picture at that link.');
    const blob = await api.fetchPicture(first.token);
    if (mine !== state.token) return;
    start(blob);
  } catch (error) {
    if (mine !== state.token) return;
    pickView(error?.message || 'That link could not be read. Save the picture and upload it instead.');
  }
}

/** A photo was chosen: show it, outline its surfaces, make it tappable. */
async function start(file) {
  const mine = ++state.token;
  const alive = () => mine === state.token && state.el;
  setBody([h('p', 'tcs__busy', 'Reading your photo…')]);
  let small;
  let bitmap;
  try {
    small = await resizeToJpeg(file, SEGMENT_SIDE);
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    if (alive()) pickView('We could not read that file as a photo. Try a JPEG or PNG.');
    return;
  }
  if (!alive()) return;
  if (state.photo?.url) URL.revokeObjectURL(state.photo.url);
  const url = URL.createObjectURL(small);
  state.photo = { url, small, bitmap, regions: null, ids: null, w: 0, h: 0, selected: 0 };

  const stage = h('div', 'tcs__stage');
  const frame = h('div', 'tcs__frame');
  const img = h('img', 'tcs__img');
  img.alt = 'Your photo';
  img.src = url;
  img.draggable = false;
  const overlay = h('canvas', 'tcs__overlay');
  const tip = h('span', 'tcs__tip');
  tip.hidden = true;
  frame.append(img, overlay, tip);
  const status = h('p', 'tcs__status', 'Outlining the surfaces… the first photo can take up to a minute while the models wake up.');
  status.setAttribute('role', 'status');
  const chips = h('div', 'tcs__chips');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Surfaces in the photo');
  const side = h('div', 'tcs__side');
  const results = h('div', 'tcs__results');
  results.setAttribute('aria-live', 'polite');
  side.append(status, chips, button('Try another photo', 'tcs__btn tcs__again', () => pickView()), results);
  stage.append(frame, side);
  setBody([stage]);
  state.photo.ui = { frame, img, overlay, tip, status, chips, results };

  warm().catch(() => {});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEGMENT_TIMEOUT_MS);
  try {
    const seg = await segmentPhoto(small, controller.signal);
    if (!alive() || state.photo?.url !== url) return;
    const { ids, regions } = buildRegions(seg.width, seg.height, seg.classMap, seg.labels, seg.instanceMap);
    nameRegions(regions, seg.width);
    Object.assign(state.photo, { ids, regions, w: seg.width, h: seg.height });
    wire();
    status.textContent = regions.length ? 'Tap or hover a surface in the photo to find it in the catalogue.' : 'No separate surfaces were found. Search the whole photo instead.';
  } catch (error) {
    if (!alive() || state.photo?.url !== url) return;
    status.textContent = friendlyMessage(error);
  } finally {
    clearTimeout(timer);
  }
  if (alive() && state.photo?.url === url) addWholeChip();
}

function addWholeChip() {
  const { chips } = state.photo.ui;
  const b = button('Whole photo', 'tcs__chip', () => searchRegion(null));
  chips.appendChild(b);
}

/** Hover, tap and the chips, once the regions are known. */
function wire() {
  const p = state.photo;
  const { overlay, tip, chips } = p.ui;
  const map = createOverlay(overlay, { ids: p.ids, w: p.w, h: p.h, regions: p.regions });
  const regionAt = (e) => map.regionAt(e.clientX, e.clientY);
  const paint = map.paint;
  let hover = null;
  overlay.addEventListener('pointermove', (e) => {
    const region = regionAt(e);
    if (region !== hover) { hover = region; paint(hover, p.regions[p.selected - 1]); }
    overlay.classList.toggle('is-hit', Boolean(region));
    tip.hidden = !region;
    if (region) {
      const fr = p.ui.frame.getBoundingClientRect();
      tip.textContent = region.label;
      tip.style.left = `${Math.min(e.clientX - fr.left + 14, fr.width - 110)}px`;
      tip.style.top = `${Math.max(e.clientY - fr.top - 34, 4)}px`;
    }
  });
  overlay.addEventListener('pointerleave', () => { hover = null; tip.hidden = true; paint(null, p.regions[p.selected - 1]); });
  overlay.addEventListener('click', (e) => {
    const region = regionAt(e) ?? hover;
    if (region) searchRegion(region);
  });
  p.paint = (selected) => paint(null, selected);
  // chips: the same regions, for a keyboard or a finger that misses
  const list = [...p.regions].sort((a, b) => b.area - a.area).slice(0, 10);
  for (const region of list) {
    const b = button(region.label, 'tcs__chip', () => searchRegion(region));
    b.dataset.region = String(region.id);
    chips.appendChild(b);
  }
  paint(null, null);
}

/** Cut the region's patch from the photo, search the catalogue with it, show the closest designs. */
async function searchRegion(region) {
  const p = state.photo;
  if (!p) return;
  const mine = state.token;
  p.selected = region ? region.id : 0;
  p.paint?.(region);
  for (const b of p.ui.chips.querySelectorAll('.tcs__chip')) b.classList.toggle('is-on', region ? b.dataset.region === String(region.id) : !b.dataset.region);
  const { results, status } = p.ui;
  const what = region ? region.label.toLowerCase() : 'your photo';
  status.textContent = `Looking for the closest designs to the ${what}…`;
  results.replaceChildren(h('p', 'tcs__busy', 'Searching the catalogue…'));
  try {
    let blob = p.small;
    let clean = true;
    if (region) {
      const cut = await cutPatch(p.bitmap, p.ids, p.w, p.h, region);
      clean = cut.clean;
      blob = cut.blob;
    }
    const found = await searchPhoto({ photo: blob, mode: 'look', k: 8 });
    if (mine !== state.token || state.photo !== p) return;
    status.textContent = region ? `Closest designs to the ${what}${clean ? '' : ' (this surface is small or broken up, so the match is rougher)'}:` : 'Closest designs to your photo:';
    showResults(found.items ?? [], results);
  } catch (error) {
    if (mine !== state.token || state.photo !== p) return;
    status.textContent = friendlyMessage(error);
    results.replaceChildren();
  }
}

// ---------------------------------------------------------------------------------------------------------------- results
function addToCart(shop, note) {
  const detail = { op: 'cart_add', id: shop.variantId, pid: shop.id, qty: 1, handled: false };
  try { window.dispatchEvent(new CustomEvent('terucon:shop', { detail })); } catch { /* the shop is not listening */ }
  note.textContent = detail.handled ? (detail.ok ? 'Added to your cart.' : detail.message || 'Could not add that.') : 'Open the product to add it.';
}

function showResults(items, host) {
  if (!items.length) {
    host.replaceChildren(h('p', 'tcs__note', 'Nothing in the catalogue is close to that. Try another surface.'));
    return;
  }
  const grid = h('ol', 'tcs__grid');
  items.forEach((item, i) => {
    const li = h('li', 'tcs__card');
    const shop = item.shop;
    const pic = h('img', 'tcs__cardImg');
    pic.alt = '';
    pic.loading = 'lazy';
    pic.src = shop?.image || item.image?.thumbUrl || '';
    pic.addEventListener('error', () => pic.removeAttribute('src'));
    li.appendChild(pic);
    const info = h('div', 'tcs__cardInfo');
    if (i === 0) info.appendChild(h('span', 'tcs__badge', 'Closest'));
    info.appendChild(h('span', 'tcs__cardName', shop?.name ?? item.title));
    if (item.productId) info.appendChild(h('span', 'tcs__cardCode', item.productId));
    if (shop) {
      info.appendChild(h('span', 'tcs__cardPrice', shop.priceText));
      info.appendChild(h('span', 'tcs__cardNote', shop.stock === 'out' ? 'Out of stock · sample price' : shop.stock === 'low' ? 'Low stock · sample price' : 'Sample price until the price list is loaded'));
      const row = h('div', 'tcs__row');
      const view = h('a', 'tcs__btn tcs__btn--main', 'View');
      view.href = shop.href;
      view.addEventListener('click', (e) => {
        e.preventDefault();
        close();
        window.location.hash = shop.href.slice(shop.href.indexOf('#'));
      });
      const note = h('span', 'tcs__added');
      const add = button('Add to cart', 'tcs__btn', () => addToCart(shop, note));
      add.disabled = shop.stock === 'out';
      row.append(view, add);
      info.append(row, note);
    } else {
      info.appendChild(h('span', 'tcs__cardNote', 'In the catalogue, not in the shop yet'));
    }
    li.appendChild(info);
    grid.appendChild(li);
  });
  host.replaceChildren(grid);
}

function toast(text) {
  const t = h('p', 'tcs__toast', text);
  t.setAttribute('role', 'status');
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 7000);
}

// ---------------------------------------------------------------------------------------------------------------- opening
/**
 * @param {{fallback?: () => void}} [options]
 * @returns {boolean} true: this dialog is open
 */
function open({ fallback } = {}) {
  if (state.el) return true;
  state.fallback = fallback ?? null;
  state.ui = build();
  state.el = state.ui.root;
  document.body.appendChild(state.el);
  document.documentElement.classList.add('tcs-open');
  document.addEventListener('keydown', onKey, true);
  setBody([h('p', 'tcs__busy', 'One moment…')]);
  catalogueStatus().then((s) => {
    if (!state.el) return;
    if (!s?.enabled || !s.ready) throw new CatalogueClientError(friendlyMessage({ reason: s?.reasons?.[0] ?? 'not-ready' }), { reason: 'off' });
    pickView();
    warm().catch(() => {});
  }).catch((error) => {
    if (!state.el) return;
    // no real search here: the shop's own colour preview is what the visitor gets, and is told why
    const why = error instanceof CatalogueClientError ? error.message : 'Catalogue search is not available right now.';
    close();
    if (state.fallback) state.fallback();
    toast(`${why} This is the colour preview.`);
  });
  return true;
}

window.TeruconSurfaces = { open, close };
export { open, close };
