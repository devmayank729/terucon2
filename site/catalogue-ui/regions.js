/**
 * The parts of "outline the photo, tap an item, find it in the catalogue" that the shop's dialog (surfaces.js) and the Finder page (finder.js) share, so
 * the two cannot drift apart (target C4):
 *
 *   segmentPhoto(blob, signal)   POST /api/vision/segment?model=oneformer: the photo (already at most 1024 px) -> a class map, which of 150 kinds of thing each pixel is
 *   buildRegions / nameRegions   the class map -> connected regions ("Left wall" / "Right wall"), small ones and sky, people, plants ... left out
 *   patchFor / cutPatch          the largest clean rectangle inside a region, cut from the photo as a JPEG, ready for POST /api/catalogue/search
 *   createOverlay                paint the regions on a <canvas> laid over the photo, and say which region is under a point
 *
 * Plain ES module, no dependency, no HTML from strings. Served from /catalogue-ui/assets/ (server/routes/catalogueUi.js: the name is in its list).
 */
import { CatalogueClientError } from './client.js';

export const SEGMENT_URL = '/api/vision/segment?model=oneformer';
export const SEGMENT_SIDE = 1024; // the photo as the models see it
export const SEGMENT_TIMEOUT_MS = 100000; // a cold GPU takes up to about a minute
export const PATCH_SIDE = 640; // the patch searched: texture needs detail, the catalogue shrinks it again
const MIN_REGION = 0.006; // a region smaller than this share of the photo is not offered
const SKIP = new Set(['sky', 'person', 'tree', 'plant', 'grass', 'flower', 'animal', 'water', 'sea', 'river', 'mountain', 'cloud', 'earth', 'field', 'sand', 'hill', 'rock', 'land', 'bird', 'fish']);
export const COLOURS = ['#e1a14b', '#5fb6a5', '#d4695a', '#7f9de0', '#b78ad9', '#8cc56a', '#e08ab8', '#d9c34a'];

/** The colour a region is drawn in. */
export const regionColour = (region) => COLOURS[region.cls % COLOURS.length];

/** "floor, flooring" -> "Floor"; "windowpane, window" -> "Window". */
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

/**
 * Cut a region's patch from the photo as a JPEG. `bitmap` is the photo (any size: the map's pixels are scaled to it); `ids`, `w`, `h` are buildRegions' map.
 * @returns {Promise<{blob: Blob, clean: boolean}>} `clean`: false when the region is small or broken up, so the patch is its whole box and the match is rougher
 */
export async function cutPatch(bitmap, ids, w, h, region) {
  const { rect, clean } = patchFor(ids, w, h, region);
  const sx = bitmap.width / w;
  const sy = bitmap.height / h;
  const rw = Math.max(32, Math.round((rect[2] - rect[0]) * sx));
  const rh = Math.max(32, Math.round((rect[3] - rect[1]) * sy));
  const k = Math.min(1, PATCH_SIDE / Math.max(rw, rh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(32, Math.round(rw * k));
  canvas.height = Math.max(32, Math.round(rh * k));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, Math.round(rect[0] * sx), Math.round(rect[1] * sy), rw, rh, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('patch'))), 'image/jpeg', 0.9));
  return { blob, clean };
}

// ---------------------------------------------------------------------------------------------------------------- the model call
/**
 * Ask the models to outline a photo. Throws CatalogueClientError: reason 'unauthorized' (401), 'network' (could not reach the server), 'timeout' (the
 * request was aborted: by the caller's own timer, or by the caller giving up: the caller knows which), or 'segment' (anything else: `status` is the HTTP status).
 * @param {Blob} blob image/jpeg, at most SEGMENT_SIDE px on the long side
 * @param {AbortSignal} [signal]
 */
export async function segmentPhoto(blob, signal) {
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

// ---------------------------------------------------------------------------------------------------------------- the overlay
/**
 * Paint regions on a <canvas> that lies exactly over the photo, and find the region under a point. The canvas gets the map's own size (w x h); the page's CSS
 * stretches it over the photo.
 *
 *   paint(hover, selected)       draws `selected` and (when it is another one) `hover`, each in its own colour, over what is already there
 *   regionAt(clientX, clientY)   the region under that point of the screen, or null
 *
 * `base`: draw every region faintly first and trace the edges between them, so the photo is visibly cut into items before anything is touched (a phone has
 * no hover). Without it the canvas is empty until a region is hovered or selected, which is how the shop's dialog has always looked.
 * @param {HTMLCanvasElement} canvas
 * @param {{ids: Uint16Array, w: number, h: number, regions: object[], base?: boolean}} map
 */
export function createOverlay(canvas, { ids, w, h, regions, base = false }) {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(w, h);
  const rgb = (region) => {
    const c = regionColour(region);
    return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  };
  let resting = null; // what the canvas looks like with nothing touched
  if (base) {
    resting = new Uint8ClampedArray(w * h * 4);
    const t = Math.max(1, Math.round(w / 300)); // the edge is about one screen pixel wide on a phone
    for (const region of regions) {
      const [rr, gg, bb] = rgb(region);
      const [x0, y0, x1, y1] = region.box;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          if (ids[y * w + x] !== region.id) continue;
          const edge = x < t || y < t || x >= w - t || y >= h - t
            ? false // the picture's own border is not an edge between two things
            : ids[y * w + x - t] !== region.id || ids[y * w + x + t] !== region.id || ids[(y - t) * w + x] !== region.id || ids[(y + t) * w + x] !== region.id;
          const o = (y * w + x) * 4;
          resting[o] = rr; resting[o + 1] = gg; resting[o + 2] = bb; resting[o + 3] = edge ? 235 : 46;
        }
      }
    }
  }
  const regionAt = (clientX, clientY) => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const x = Math.floor(((clientX - r.left) / r.width) * w);
    const y = Math.floor(((clientY - r.top) / r.height) * h);
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    const id = ids[y * w + x];
    return id ? regions[id - 1] : null;
  };
  const paint = (hover, selected) => {
    if (resting) image.data.set(resting);
    else image.data.fill(0);
    const draw = (region, alpha) => {
      if (!region) return;
      const [rr, gg, bb] = rgb(region);
      const [x0, y0, x1, y1] = region.box;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          if (ids[y * w + x] !== region.id) continue;
          const o = (y * w + x) * 4;
          // over the faint base the highlight is stronger, but an edge pixel stays an edge
          if (resting && image.data[o + 3] === 235) continue;
          image.data[o] = rr; image.data[o + 1] = gg; image.data[o + 2] = bb; image.data[o + 3] = alpha;
        }
      }
    };
    draw(selected, resting ? 150 : 120);
    if (hover && hover !== selected) draw(hover, resting ? 115 : 95);
    ctx.putImageData(image, 0, 0);
  };
  return { regionAt, paint };
}
