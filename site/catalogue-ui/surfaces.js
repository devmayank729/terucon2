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

const SEGMENT_URL = '/api/vision/segment?model=oneformer';
const SEGMENT_SIDE = 1024; // the photo as the models see it
const SEGMENT_TIMEOUT_MS = 100000; // a cold GPU takes up to about a minute
const PATCH_SIDE = 640; // the patch searched: texture needs detail, the catalogue shrinks it again
const MIN_REGION = 0.006; // a region smaller than this share of the photo is not offered
const SKIP = new Set(['sky', 'person', 'tree', 'plant', 'grass', 'flower', 'animal', 'water', 'sea', 'river', 'mountain', 'cloud', 'earth', 'field', 'sand', 'hill', 'rock', 'land', 'bird', 'fish']);
const COLOURS = ['#e1a14b', '#5fb6a5', '#d4695a', '#7f9de0', '#b78ad9', '#8cc56a', '#e08ab8', '#d9c34a'];

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

/** "floor, flooring" -> "Floor"; "windowpane, window" -> "Windowpane". */
export function friendlyLabel(raw) {
  const first = String(raw ?? '').split(',')[0].trim();
  if (!first) return 'Surface';
  const nice = { windowpane: 'Window', building: 'Building facade', 'wall': 'Wall', 'floor': 'Floor', 'ceiling': 'Ceiling', 'pane': 'Glass' }[first.toLowerCase()];
  return nice ?? first.charAt(0).toUpperCase() + first.slice(1);
}

async function gunzipBase64(text) {
  const bin = atob(text);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------------------------------------------------------------------------------------------------------------- regions
/**
 * Connected regions of the class map. `classMap[i]` is 0 (nothing) or 1 + the index of the pixel's class in `labels`; `instanceMap[i]` (optional) is the id
 * of the single window, door or piece of furniture the pixel belongs to (0 for walls, floors and the like). Returns {ids: Uint16Array, regions: [...]}:
 * region k is every pixel of ids with the value k; its area, box, label and class are in regions[k - 1].
 */
export function buildRegions(w, h, classMap, labels, instanceMap = null) {
  const n = w * h;
  const ids = new Uint16Array(n);
  const regions = [];
  const stack = new Int32Array(n);
  const minArea = Math.max(40, Math.round(n * MIN_REGION));
  const same = (a, b) => classMap[a] === classMap[b] && (!instanceMap || instanceMap[a] === instanceMap[b]);
  const seen = new Uint8Array(n);
  for (let start = 0; start < n; start += 1) {
    if (seen[start] || !classMap[start]) continue;
    const cls = classMap[start];
    // flood fill (4-connected) over the pixels of the same class (and the same instance)
    let top = 0;
    let count = 0;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    const members = [];
    stack[top++] = start;
    seen[start] = 1;
    while (top) {
      const p = stack[--top];
      members.push(p);
      count += 1;
      const x = p % w;
      const y = (p - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && !seen[p - 1] && same(p - 1, start)) { seen[p - 1] = 1; stack[top++] = p - 1; }
      if (x < w - 1 && !seen[p + 1] && same(p + 1, start)) { seen[p + 1] = 1; stack[top++] = p + 1; }
      if (y > 0 && !seen[p - w] && same(p - w, start)) { seen[p - w] = 1; stack[top++] = p - w; }
      if (y < h - 1 && !seen[p + w] && same(p + w, start)) { seen[p + w] = 1; stack[top++] = p + w; }
    }
    const raw = labels[cls - 1] ?? '';
    if (count < minArea || SKIP.has(String(raw).split(',')[0].trim().toLowerCase()) || regions.length >= 60000) continue;
    const id = regions.length + 1;
    for (const p of members) ids[p] = id;
    regions.push({ id, cls, raw, label: friendlyLabel(raw), area: count, box: [x0, y0, x1 + 1, y1 + 1] });
  }
  return { ids, regions };
}

/** Name the regions of one kind "Left wall" / "Right wall" (by where their centre is) when there are two or three of them. */
export function nameRegions(regions, w) {
  const byClass = new Map();
  for (const r of regions) {
    r.cx = (r.box[0] + r.box[2]) / 2 / w;
    if (!byClass.has(r.cls)) byClass.set(r.cls, []);
    byClass.get(r.cls).push(r);
  }
  for (const list of byClass.values()) {
    if (list.length < 2 || list.length > 3) continue;
    list.sort((a, b) => a.cx - b.cx);
    const names = list.length === 2 ? ['Left', 'Right'] : ['Left', 'Middle', 'Right'];
    list.forEach((r, i) => { r.label = `${names[i]} ${r.label.charAt(0).toLowerCase()}${r.label.slice(1)}`; });
  }
  return regions;
}

/**
 * The biggest rectangle that lies wholly inside the region (largest rectangle in a histogram, row by row), as [x0, y0, x1, y1] in map pixels, or null when
 * the region has no rectangle worth searching (then the caller uses the region's own box).
 */
export function largestInnerRect(ids, w, h, regionId) {
  const heights = new Int32Array(w);
  let best = null;
  let bestArea = 0;
  const stackX = new Int32Array(w + 1);
  const stackH = new Int32Array(w + 1);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) heights[x] = ids[y * w + x] === regionId ? heights[x] + 1 : 0;
    let top = 0;
    for (let x = 0; x <= w; x += 1) {
      const cur = x === w ? 0 : heights[x];
      let start = x;
      while (top && stackH[top - 1] >= cur) {
        top -= 1;
        const height = stackH[top];
        const left = stackX[top];
        const area = height * (x - left);
        if (area > bestArea) {
          bestArea = area;
          best = [left, y - height + 1, x, y + 1];
        }
        start = left;
      }
      stackX[top] = start;
      stackH[top] = cur;
      top += 1;
    }
  }
  return best;
}

/** The patch to search for a region, in map pixels: its inner rectangle when that is big enough, else its box. */
export function patchFor(ids, w, h, region) {
  const inner = largestInnerRect(ids, w, h, region.id);
  const big = inner && (inner[2] - inner[0]) >= w * 0.08 && (inner[3] - inner[1]) >= h * 0.08 && (inner[2] - inner[0]) * (inner[3] - inner[1]) >= region.area * 0.12;
  const rect = big ? inner : region.box;
  // a little inside, so the patch does not touch the neighbour
  const dx = Math.round((rect[2] - rect[0]) * 0.04);
  const dy = Math.round((rect[3] - rect[1]) * 0.04);
  return { rect: [rect[0] + dx, rect[1] + dy, rect[2] - dx, rect[3] - dy], clean: Boolean(big) };
}

// ---------------------------------------------------------------------------------------------------------------- the model call
async function segment(blob, signal) {
  let res;
  try {
    res = await fetch(SEGMENT_URL, { method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob, credentials: 'same-origin', signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new CatalogueClientError('The models took too long. You can still search the whole photo.', { reason: 'timeout' });
    throw new CatalogueClientError('Could not reach the server. Check your connection.', { reason: 'network' });
  }
  if (!res.ok) {
    let message = '';
    try { const j = await res.json(); message = typeof j?.error === 'string' ? j.error : j?.error?.message ?? ''; } catch { /* not JSON */ }
    throw new CatalogueClientError(res.status === 401 ? 'Please sign in again.' : res.status === 429 ? 'The studio models have been used a lot in the last hour. You can still search the whole photo.' : message || 'The models could not outline this photo. You can still search the whole photo.', { reason: res.status === 401 ? 'unauthorized' : 'segment', status: res.status });
  }
  const j = await res.json();
  if (!j || !j.width || !j.height || typeof j.classMap !== 'string' || !Array.isArray(j.classLabels)) throw new CatalogueClientError('The models gave an answer this page cannot read.', { reason: 'segment' });
  const classMap = await gunzipBase64(j.classMap);
  const instanceMap = typeof j.instanceMap === 'string' ? await gunzipBase64(j.instanceMap) : null;
  if (classMap.length !== j.width * j.height) throw new CatalogueClientError('The models gave an answer this page cannot read.', { reason: 'segment' });
  return { width: j.width, height: j.height, classMap, instanceMap, labels: j.classLabels };
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
    const seg = await segment(small, controller.signal);
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
  overlay.width = p.w;
  overlay.height = p.h;
  const ctx = overlay.getContext('2d');
  const image = ctx.createImageData(p.w, p.h);
  const regionAt = (e) => {
    const r = overlay.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * p.w);
    const y = Math.floor(((e.clientY - r.top) / r.height) * p.h);
    if (x < 0 || y < 0 || x >= p.w || y >= p.h) return null;
    const id = p.ids[y * p.w + x];
    return id ? p.regions[id - 1] : null;
  };
  const paint = (hover, selected) => {
    image.data.fill(0);
    const draw = (region, alpha) => {
      if (!region) return;
      const c = COLOURS[region.cls % COLOURS.length];
      const rr = parseInt(c.slice(1, 3), 16), gg = parseInt(c.slice(3, 5), 16), bb = parseInt(c.slice(5, 7), 16);
      const [x0, y0, x1, y1] = region.box;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          if (p.ids[y * p.w + x] !== region.id) continue;
          const o = (y * p.w + x) * 4;
          image.data[o] = rr; image.data[o + 1] = gg; image.data[o + 2] = bb; image.data[o + 3] = alpha;
        }
      }
    };
    draw(selected, 120);
    if (hover && hover !== selected) draw(hover, 95);
    ctx.putImageData(image, 0, 0);
  };
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
      const { rect, clean: isClean } = patchFor(p.ids, p.w, p.h, region);
      clean = isClean;
      const sx = p.bitmap.width / p.w;
      const sy = p.bitmap.height / p.h;
      const rw = Math.max(32, Math.round((rect[2] - rect[0]) * sx));
      const rh = Math.max(32, Math.round((rect[3] - rect[1]) * sy));
      const k = Math.min(1, PATCH_SIDE / Math.max(rw, rh));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(32, Math.round(rw * k));
      canvas.height = Math.max(32, Math.round(rh * k));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(p.bitmap, Math.round(rect[0] * sx), Math.round(rect[1] * sy), rw, rh, 0, 0, canvas.width, canvas.height);
      blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('patch'))), 'image/jpeg', 0.9));
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
