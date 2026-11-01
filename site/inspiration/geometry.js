/**
 * The arithmetic of the crop screen, with no page in it, so it can be tested on its own (tests/js/inspiration-geometry.test.js).
 *
 * Three coordinate systems:
 *   source       the pixels of the decoded picture, as it came
 *   turned       the picture after the person's rotation and flip: what the crop box is drawn on and measured in
 *   screen       CSS pixels in the stage
 * `matrixFor` takes source to turned; a `view` {k, ox, oy} takes turned to screen (screen = turned * k + offset).
 * A box is {x, y, w, h} in turned pixels. Matrices are [a, b, c, d, e, f] like the canvas's setTransform: x' = a x + c y + e, y' = b x + d y + f.
 */

/** The shapes offered. `ratio` is width / height; 'original' means the picture's own, whatever its turn. */
export const PRESETS = [
  { id: 'free', label: 'Free', ratio: null },
  { id: 'original', label: 'Original', ratio: 'original' },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '3:2', label: '3:2', ratio: 3 / 2 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '3:4', label: '3:4', ratio: 3 / 4 },
  { id: '2:3', label: '2:3', ratio: 2 / 3 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
];

/** The smallest side a box may have, in turned pixels. */
export const MIN_SIDE = 48;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// ---- turning the picture

/** The size of the picture after `rot` degrees clockwise (0, 90, 180, 270). */
export function turnedSize(w, h, rot) {
  return rot % 180 === 0 ? { w, h } : { w: h, h: w };
}

function multiply(A, B) {
  // apply B first, then A
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}

/** Source pixels -> turned pixels, for a picture of w x h: mirrored left-right first if `flip`, then turned `rot` degrees clockwise. */
export function matrixFor(rot, flip, w, h) {
  const mirror = flip ? [-1, 0, 0, 1, w, 0] : [1, 0, 0, 1, 0, 0];
  const turn = { 0: [1, 0, 0, 1, 0, 0], 90: [0, 1, -1, 0, h, 0], 180: [-1, 0, 0, -1, w, h], 270: [0, -1, 1, 0, 0, w] }[((rot % 360) + 360) % 360];
  if (!turn) throw new RangeError('rotation must be a multiple of 90');
  return multiply(turn, mirror);
}

/**
 * The turn after one more action, as the person sees it: 'cw' / 'ccw' turn what is on screen a quarter, 'flip' mirrors what is on
 * screen left to right. (Mirroring the screen after a turn is the same as turning the other way after mirroring the photo, which is
 * why a flip also changes `rot`.)
 */
export function nextTurn({ rot, flip }, action) {
  if (action === 'cw') return { rot: (rot + 90) % 360, flip };
  if (action === 'ccw') return { rot: (rot + 270) % 360, flip };
  if (action === 'flip') return { rot: (360 - rot) % 360, flip: !flip };
  throw new RangeError(`unknown action ${action}`);
}

export function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function applyTo([a, b, c, d, e, f], x, y) {
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

/** The box a rectangle becomes under a matrix (the matrices here only turn by right angles and mirror, so it stays a rectangle). */
export function mapRect(M, r) {
  const p = applyTo(M, r.x, r.y);
  const q = applyTo(M, r.x + r.w, r.y + r.h);
  return { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) };
}

// ---- the box

/** Keep a box inside the picture and no smaller than `min`. */
export function clampBox(box, W, H, min = MIN_SIDE) {
  const m = Math.min(min, W, H);
  const w = clamp(box.w, m, W);
  const h = clamp(box.h, m, H);
  return { x: clamp(box.x, 0, W - w), y: clamp(box.y, 0, H - h), w, h };
}

export function moveBox(box, dx, dy, W, H) {
  return { ...box, x: clamp(box.x + dx, 0, W - box.w), y: clamp(box.y + dy, 0, H - box.h) };
}

/** The biggest box of this shape that fits, centred on `around` (a point, default the middle) as far as it can be. */
export function ratioBox(W, H, ratio, around = { x: W / 2, y: H / 2 }) {
  let w = W;
  let h = W / ratio;
  if (h > H) {
    h = H;
    w = H * ratio;
  }
  return clampBox({ x: around.x - w / 2, y: around.y - h / 2, w, h }, W, H, 1);
}

/** Make an existing box this shape, keeping its middle and as much of its size as fits. */
export function reshapeBox(box, W, H, ratio, min = MIN_SIDE) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  let w = Math.sqrt(box.w * box.h * ratio);
  let h = w / ratio;
  const fit = Math.min(1, W / w, H / h);
  w *= fit;
  h *= fit;
  const grow = Math.max(1, Math.min(min, W, H) / Math.min(w, h));
  return clampBox({ x: cx - (w * grow) / 2, y: cy - (h * grow) / 2, w: w * grow, h: h * grow }, W, H, 1);
}

/**
 * Drag one handle of a box.
 * @param {{x: number, y: number, w: number, h: number}} start the box when the drag began
 * @param {'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'} handle
 * @param {number} dx how far the pointer moved since then, in turned pixels
 * @param {number} dy
 * @param {{ratio?: number | null, W: number, H: number, min?: number}} limits `ratio`: keep this width / height
 */
export function resizeBox(start, handle, dx, dy, { ratio = null, W, H, min = MIN_SIDE }) {
  const m = Math.min(min, W, H);
  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.includes('n');
  const south = handle.includes('s');
  const sx = east ? 1 : west ? -1 : 0;
  const sy = south ? 1 : north ? -1 : 0;

  if (!ratio) {
    let left = start.x;
    let right = start.x + start.w;
    let top = start.y;
    let bottom = start.y + start.h;
    if (west) left = clamp(start.x + dx, 0, right - m);
    if (east) right = clamp(right + dx, left + m, W);
    if (north) top = clamp(start.y + dy, 0, bottom - m);
    if (south) bottom = clamp(bottom + dy, top + m, H);
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  // the corner (or edge) that stays put
  const ax = sx > 0 ? start.x : sx < 0 ? start.x + start.w : start.x + start.w / 2;
  const ay = sy > 0 ? start.y : sy < 0 ? start.y + start.h : start.y + start.h / 2;
  // Everything is decided as one width: how wide the box may be (the room the photo leaves, in both directions, at this shape),
  // how narrow (the minimum on its shorter side), and how wide the pointer wants it. The height follows, so the shape cannot break.
  const roomW = sx > 0 ? W - ax : sx < 0 ? ax : 2 * Math.min(ax, W - ax);
  const roomH = sy > 0 ? H - ay : sy < 0 ? ay : 2 * Math.min(ay, H - ay);
  const widest = Math.min(roomW, roomH * ratio);
  const narrowest = Math.max(m, m * ratio);
  const wanted = sx && sy ? Math.max(start.w + sx * dx, (start.h + sy * dy) * ratio) : sx ? start.w + sx * dx : (start.h + sy * dy) * ratio;
  const w = widest < narrowest ? widest : clamp(wanted, narrowest, widest);
  const h = w / ratio;
  const x = sx > 0 ? ax : sx < 0 ? ax - w : ax - w / 2;
  const y = sy > 0 ? ay : sy < 0 ? ay - h : ay - h / 2;
  return { x: clamp(x, 0, Math.max(0, W - w)), y: clamp(y, 0, Math.max(0, H - h)), w, h };
}

/** The size the cropped picture is saved at: the box's own size, shrunk (never enlarged) so the long side is at most `maxSide`. */
export function outputSize(box, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(box.w, box.h));
  return { w: Math.max(1, Math.round(box.w * scale)), h: Math.max(1, Math.round(box.h * scale)), scale };
}

// ---- the view

/** Where the whole picture sits in a stage of cw x ch when it is fitted with `pad` pixels of room around it. */
export function fitView(W, H, cw, ch, pad = 28) {
  const k = Math.max(0.01, Math.min((cw - 2 * pad) / W, (ch - 2 * pad) / H));
  return { k, ox: (cw - W * k) / 2, oy: (ch - H * k) / 2 };
}

/** Zoom by `factor` about a point of the stage (so what is under the pointer stays under it). `fit` is the fitted scale; zoom runs from 1x to MAX_ZOOM x of it. */
export function zoomAbout(view, factor, px, py, fit) {
  const k = clamp(view.k * factor, fit * MIN_ZOOM, fit * MAX_ZOOM);
  const ratio = k / view.k;
  return { k, ox: px - (px - view.ox) * ratio, oy: py - (py - view.oy) * ratio };
}

/** Keep the picture where it can be reached: centred while it is smaller than the stage, else never further off than `slack` pixels. */
export function limitPan(view, W, H, cw, ch, slack = 56) {
  const fit = (size, span, offset) => {
    const length = size * view.k;
    if (length <= span - 2 * slack) return (span - length) / 2;
    return clamp(offset, span - length - slack, slack);
  };
  return { ...view, ox: fit(W, cw, view.ox), oy: fit(H, ch, view.oy) };
}

export const toScreen = (view, box) => ({ x: view.ox + box.x * view.k, y: view.oy + box.y * view.k, w: box.w * view.k, h: box.h * view.k });
