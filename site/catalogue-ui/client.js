/**
 * The one module that talks to the catalogue's client API (server/catalogue/, catalogue/ARCHITECTURE.md section 7). The finder
 * page, the shop's search overlay and the inspiration hand-off's matching hook all import this instead of calling fetch
 * themselves, so the contract (query params, the photo's shape, error reasons) is implemented exactly once.
 *
 * Nothing here talks to Modal, GCS or MongoDB directly: every call is same-origin, to this website's own /api/catalogue/*,
 * which is the gateway (never a proxy of the heavy kind: it mints signed URLs and forwards small requests only).
 */

/** server/catalogue/config.js: MAX_PHOTO_BYTES, BROWSER_MAX_SIDE. Mirrored here, not read from the server (no endpoint for it alone; /api/catalogue/status.limits carries the live values and overrides these once known). */
export const LIMITS = { maxPhotoBytes: 6 * 1024 * 1024, maxSide: 1024 };

/** A refusal from the catalogue API, or from this module before it ever asks (e.g. no camera). `reason` is one of the slugs in catalogue/ARCHITECTURE.md section 7 ("catalogue-off", "not-ready", "no-live-catalogue", "too-large", "bad-image", "bad-request", "rate-limited", "busy", "warming", "modal-unavailable", "modal-timeout", "release-missing", "feature-version-mismatch", "unauthorized") or "network" / "client" for a failure before the server answered. */
export class CatalogueClientError extends Error {
  constructor(message, { reason = 'client', status = 0, retryAfter = null } = {}) {
    super(message);
    this.name = 'CatalogueClientError';
    this.reason = reason;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** A plain-language sentence for a CatalogueClientError, for a status line a visitor reads (never the raw reason slug). */
export function friendlyMessage(err) {
  const r = err?.reason;
  if (r === 'unauthorized') return 'Please sign in again to search the catalogue.';
  if (r === 'catalogue-off' || r === 'modal-not-configured') return 'Catalogue search is not switched on here yet.';
  if (r === 'no-live-catalogue') return 'There is no catalogue to search yet.';
  if (r === 'not-ready' || r === 'storage-not-configured' || r === 'database-unavailable') return 'Catalogue search is not available right now. Please try again in a minute.';
  if (r === 'warming') return 'The search service is waking up. Trying again in a moment…';
  if (r === 'busy') return 'The search is busy right now. Please try again shortly.';
  if (r === 'rate-limited') return 'You have searched a lot in the last hour. Please try again a little later.';
  if (r === 'too-large') return 'That photo is too large. Try a smaller one.';
  if (r === 'bad-image') return 'We could not read that as a photo. Try another one.';
  if (r === 'release-missing' || r === 'feature-version-mismatch' || r === 'modal-unavailable' || r === 'modal-timeout') return 'The catalogue could not be searched just now. Please try again shortly.';
  if (r === 'network') return 'Could not reach the server. Check your connection and try again.';
  return err?.message || 'Something went wrong. Please try again.';
}

/** Parse the site's JSON error body ({error:{code,status,message,reason,retryAfter}}), falling back to a plain message. */
async function errorFrom(res) {
  let body = null;
  try { body = await res.json(); } catch { /* not JSON (e.g. a gateway's own HTML error page) */ }
  const e = body?.error;
  return new CatalogueClientError(e?.message || `The server answered ${res.status}.`, { reason: e?.reason || 'client', status: res.status, retryAfter: e?.retryAfter ?? (res.headers.get('Retry-After') ? Number(res.headers.get('Retry-After')) : null) });
}

async function getJson(path) {
  let res;
  try { res = await fetch(path, { headers: { Accept: 'application/json' } }); }
  catch { throw new CatalogueClientError('Could not reach the server.', { reason: 'network' }); }
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

async function postJson(path, body) {
  let res;
  try { res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }); }
  catch { throw new CatalogueClientError('Could not reach the server.', { reason: 'network' }); }
  if (!res.ok) throw await errorFrom(res);
  return res.status === 204 ? null : res.json();
}

/** GET /api/catalogue/status: {enabled, ready, reasons, default, catalogues, limits, profile}. Cheap; call it once per page load. */
export function status() {
  return getJson('/api/catalogue/status');
}

/** POST /api/catalogue/warm: wakes the search container ahead of a camera/photo search. Fire-and-forget: errors are swallowed (a 429 just means it is already warm or being asked too often). */
export async function warm() {
  try { await postJson('/api/catalogue/warm', {}); } catch { /* best effort */ }
}

/**
 * POST /api/catalogue/search: find the catalogue items closest to a photo (point-and-identify, colour match).
 * @param {object} p
 * @param {Blob} p.photo image/jpeg, image/png or image/webp, at most LIMITS.maxPhotoBytes (resizeToJpeg() below keeps you under it)
 * @param {'look'|'colour'} [p.mode] 'colour' ignores shape and matches by colour alone (target C7)
 * @param {[number, number]} [p.point] [x, y] 0..1, relative to the photo: search one spot on it, not the whole thing (target C4)
 * @param {number} [p.radius] 0..0.5, goes with `point` only (server default 0.12)
 * @param {[number, number, number, number]} [p.box] [x0, y0, x1, y1] 0..1, instead of `point`
 * @param {number} [p.k] 1..20 results (server default 8)
 * @param {string} [p.catalogue] a catalogue id; default: the site's live default
 * @param {string[]} [p.category] @param {string[]} [p.finish]
 */
export async function searchPhoto({ photo, mode, point, box, radius, k, catalogue, category, finish } = {}) {
  if (!(photo instanceof Blob)) throw new CatalogueClientError('No photo to search with.', { reason: 'client' });
  const q = new URLSearchParams();
  if (catalogue) q.set('catalogue', catalogue);
  if (mode) q.set('mode', mode);
  if (k) q.set('k', String(k));
  if (point) q.set('point', `${point[0]},${point[1]}`);
  if (radius) q.set('radius', String(radius));
  if (box) q.set('box', box.join(','));
  if (category?.length) q.set('category', category.join(','));
  if (finish?.length) q.set('finish', finish.join(','));
  const type = photo.type || 'image/jpeg';
  let res;
  try { res = await fetch(`/api/catalogue/search?${q}`, { method: 'POST', headers: { 'Content-Type': type }, body: photo }); }
  catch { throw new CatalogueClientError('Could not reach the server.', { reason: 'network' }); }
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

/** POST /api/catalogue/search-text: find catalogue items by a word or phrase (target C5). */
export function searchText({ text, k, catalogue, category, finish } = {}) {
  if (!text || !text.trim()) throw new CatalogueClientError('Type something to search for.', { reason: 'client' });
  return postJson('/api/catalogue/search-text', { text: text.trim(), k, catalogue, category, finish });
}

// ------------------------------------------------------------------------------------------------ photo preparation

/**
 * Downsize an image to at most `maxSide` px on the long side, apply its EXIF orientation, and re-encode as JPEG
 * (catalogue/ARCHITECTURE.md section 7: "the browser downsizes every query photo ... this also drops GPS and other
 * metadata"). `createImageBitmap` applies EXIF orientation itself ({imageOrientation: 'from-image'} is the default),
 * so the canvas it is drawn into is already right-side up.
 * @param {Blob|File} source
 * @param {number} [maxSide]
 * @returns {Promise<Blob>} image/jpeg
 */
export async function resizeToJpeg(source, maxSide = LIMITS.maxSide) {
  const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the photo'))), 'image/jpeg', 0.86));
    return blob;
  } finally {
    bitmap.close();
  }
}

/** Grab the current frame of a <video> (a live camera stream) as a resized JPEG blob, ready to search with. */
export async function captureFrame(video, maxSide = LIMITS.maxSide) {
  const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
  const w = Math.max(1, Math.round(video.videoWidth * scale));
  const h = Math.max(1, Math.round(video.videoHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(video, 0, 0, w, h);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not capture the frame'))), 'image/jpeg', 0.86));
}

/** Start the back camera if there is one, falling back to the front camera; throws CatalogueClientError('client') with a plain reason if there is none or it is refused. */
export async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new CatalogueClientError('This browser cannot use a camera here.', { reason: 'client' });
  try {
    return await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch (err) {
    if (err?.name === 'NotAllowedError') throw new CatalogueClientError('Camera access was not allowed. You can still upload a photo.', { reason: 'client' });
    throw new CatalogueClientError('The camera could not be started. You can still upload a photo.', { reason: 'client' });
  }
}

// ------------------------------------------------------------------------------------------------ rendering a result

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The markup for one ResultItem (server/catalogue/service.js toResultItem), as the theme's `.result` card (see
 * catalogue-ui.css). `scores.final` is relative (never a percentage, per the architecture): shown only as an order,
 * via the card's position, never as a number.
 * @param {object} item a ResultItem from POST /api/catalogue/search(-text)
 */
export function resultCardHtml(item) {
  const bits = [item.subtype, item.finish].filter(Boolean);
  const meta = bits.length ? esc(bits.join(' · ')) : '';
  const code = item.productId ? `<span class="code">${esc(item.productId)}</span>` : '';
  return `
    <a class="result" href="${esc(item.image?.fullUrl || '#')}" target="_blank" rel="noopener" data-item-id="${esc(item.itemId)}">
      <span class="result-pic"><img src="${esc(item.image?.thumbUrl || '')}" alt="" loading="lazy" width="${item.image?.width || 480}" height="${item.image?.height || 360}"></span>
      <span class="result-body">
        <span class="result-title">${esc(item.title)}</span>
        ${meta ? `<span class="result-meta">${meta}</span>` : ''}
        ${code}
      </span>
    </a>`;
}
