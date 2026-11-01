/**
 * The crop screen's picture area and tools: the photo on a stage, a box with eight handles and a thirds grid, shapes (1:1, 4:3 ...),
 * quarter turns and a mirror, zoom (wheel, pinch, slider) and pan, and keyboard control. All the arithmetic is in geometry.js.
 *
 * The box is cut from the picture at its full decoded size, not from the smaller one drawn on screen, and the result is never
 * enlarged: at most `maxSide` pixels on the long side (the Design Studio shrinks anything larger to that itself).
 */
import { h, icon } from './dom.js';
import { clampBox, fitView, invert, limitPan, mapRect, matrixFor, MAX_ZOOM, moveBox, nextTurn, outputSize, PRESETS, reshapeBox, resizeBox, toScreen, turnedSize, zoomAbout } from './geometry.js';

const PREVIEW_SIDE = 2560;

const fromImageElement = (blob) =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This picture cannot be opened here.'));
    };
    image.src = url;
  });

/**
 * Open a picture file for cropping.
 * @param {Blob} blob
 * @param {{phone?: boolean}} [options] a phone decodes at most 4096 pixels on the long side, a computer 8192 (the studio keeps 4096 at most)
 * @returns {Promise<{source: CanvasImageSource, preview: CanvasImageSource, width: number, height: number, close: () => void}>}
 */
export async function decodePicture(blob, { phone = false } = {}) {
  const cap = phone ? 4096 : 8192;
  const bitmaps = [];
  let source;
  try {
    const first = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const long = Math.max(first.width, first.height);
    if (long > cap) {
      const k = cap / long;
      first.close();
      source = await createImageBitmap(blob, { imageOrientation: 'from-image', resizeWidth: Math.round(first.width * k), resizeHeight: Math.round(first.height * k), resizeQuality: 'high' });
    } else source = first;
    bitmaps.push(source);
  } catch {
    // the plain way: an <img> element (older browsers), drawn once onto a canvas the size we will work at
    const image = await fromImageElement(blob);
    const long = Math.max(image.naturalWidth, image.naturalHeight);
    const k = Math.min(1, cap / long);
    const canvas = h('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * k));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * k));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    source = canvas;
  }
  let preview = source;
  const long = Math.max(source.width, source.height);
  if (long > PREVIEW_SIDE && typeof createImageBitmap === 'function') {
    try {
      const k = PREVIEW_SIDE / long;
      preview = await createImageBitmap(source, { resizeWidth: Math.round(source.width * k), resizeHeight: Math.round(source.height * k), resizeQuality: 'high' });
      bitmaps.push(preview);
    } catch {
      preview = source;
    }
  }
  return { source, preview, width: source.width, height: source.height, close: () => bitmaps.forEach((b) => b.close?.()) };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const OPPOSITE_SHAPE = (ratio) => PRESETS.find((p) => typeof p.ratio === 'number' && Math.abs(p.ratio - 1 / ratio) < 1e-9);

/**
 * @param {object} options
 * @param {Awaited<ReturnType<typeof decodePicture>>} options.picture
 * @param {boolean} [options.phone]
 * @param {(info: {width: number, height: number, changed: boolean}) => void} [options.onChange] the saved size, whenever it may have changed
 */
export function createCropper({ picture, phone = false, onChange = () => {} }) {
  const { source, preview } = picture;
  const SW = source.width;
  const SH = source.height;
  const previewScale = preview.width / SW;
  const pad = phone ? 22 : 30;
  const state = { rot: 0, flip: false, ratioId: 'free', box: { x: 0, y: 0, w: SW, h: SH }, zoom: 1, pan: { x: 0, y: 0 } };

  const turned = () => turnedSize(SW, SH, state.rot);
  const matrix = () => matrixFor(state.rot, state.flip, SW, SH);
  const ratioNow = () => {
    const preset = PRESETS.find((p) => p.id === state.ratioId);
    if (!preset || preset.ratio === null) return null;
    const { w, h: tall } = turned();
    return preset.ratio === 'original' ? w / tall : preset.ratio;
  };

  // ---- the elements
  const canvas = h('canvas', { class: 'tc-canvas', 'aria-hidden': 'true' });
  const readout = h('output', { class: 'tc-readout' });
  const lines = [1, 2].flatMap((n) => [h('i', { class: 'tc-line tc-vline', style: { left: `${(n * 100) / 3}%` } }), h('i', { class: 'tc-line tc-hline', style: { top: `${(n * 100) / 3}%` } })]);
  const handles = HANDLES.map((id) => h('i', { class: `tc-handle tc-handle-${id}`, 'data-h': id }));
  const box = h('div', { class: 'tc-box', tabindex: '0', role: 'group', 'aria-label': 'Crop area. Arrow keys move it; hold Alt and use the arrow keys to resize it; plus and minus zoom.' }, ...lines, ...handles, readout);
  const stage = h('div', { class: 'tc-stage' }, canvas, box);

  const chips = PRESETS.map((p) => h('button', { type: 'button', class: 'tc-chip', 'data-ratio': p.id, 'aria-pressed': p.id === state.ratioId ? 'true' : 'false', onclick: () => setRatio(p.id) }, p.label));
  const tool = (name, label, run) => h('button', { type: 'button', class: 'tc-tool', 'aria-label': label, title: label, onclick: run }, icon(name, 19));
  const zoomInput = h('input', { type: 'range', class: 'tc-zoom', min: '100', max: String(MAX_ZOOM * 100), step: '1', value: '100', 'aria-label': 'Zoom', oninput: (event) => setZoom(Number(event.target.value) / 100) });
  const bar = h(
    'div',
    { class: 'tc-bar' },
    h('div', { class: 'tc-chips', role: 'group', 'aria-label': 'Shape of the crop' }, ...chips),
    h(
      'div',
      { class: 'tc-tools' },
      tool('rotateLeft', 'Turn left', () => turn('ccw')),
      tool('rotateRight', 'Turn right', () => turn('cw')),
      tool('flip', 'Mirror', () => turn('flip')),
      h('span', { class: 'tc-zoomgroup' }, tool('zoomOut', 'Zoom out', () => setZoom(state.zoom / 1.25)), zoomInput, tool('zoomIn', 'Zoom in', () => setZoom(state.zoom * 1.25))),
      tool('reset', 'Start again', reset),
    ),
  );
  const element = h('div', { class: 'tc-crop' }, stage, bar);

  // ---- layout and drawing
  let cw = 0;
  let ch = 0;
  let dpr = 1;
  let fit = 1;
  let frame = 0;
  let needsImage = true;
  let destroyed = false;

  function measure() {
    const rect = stage.getBoundingClientRect();
    cw = rect.width;
    ch = rect.height;
    dpr = Math.min(globalThis.devicePixelRatio || 1, 2.5);
    const { w, h: tall } = turned();
    if (cw > 0 && ch > 0) fit = fitView(w, tall, cw, ch, pad).k;
  }

  /** The current view, with the pan kept where the picture can be reached. */
  function view() {
    const { w, h: tall } = turned();
    const k = fit * state.zoom;
    const wanted = { k, ox: (cw - w * k) / 2 + state.pan.x, oy: (ch - tall * k) / 2 + state.pan.y };
    const limited = limitPan(wanted, w, tall, cw, ch);
    state.pan = { x: limited.ox - (cw - w * k) / 2, y: limited.oy - (ch - tall * k) / 2 };
    return limited;
  }

  function schedule(image = false) {
    needsImage ||= image;
    if (!frame && !destroyed) frame = requestAnimationFrame(draw);
  }

  function draw() {
    frame = 0;
    if (destroyed || cw <= 0 || ch <= 0) return;
    const v = view();
    if (needsImage) {
      needsImage = false;
      const w = Math.max(1, Math.round(cw * dpr));
      const tall = Math.max(1, Math.round(ch * dpr));
      if (canvas.width !== w || canvas.height !== tall) {
        canvas.width = w;
        canvas.height = tall;
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, tall);
      const m = matrix();
      const k = v.k * dpr;
      ctx.setTransform(k * m[0], k * m[1], k * m[2], k * m[3], k * m[4] + v.ox * dpr, k * m[5] + v.oy * dpr);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      // the smaller copy is enough until the screen shows the picture larger than it has pixels for
      ctx.drawImage(k > previewScale * 1.1 ? source : preview, 0, 0, SW, SH);
    }
    const s = toScreen(v, state.box);
    Object.assign(box.style, { left: `${s.x}px`, top: `${s.y}px`, width: `${s.w}px`, height: `${s.h}px` });
    const out = outputSize(state.box, maxSide());
    readout.textContent = `${out.w} × ${out.h}`;
  }

  const maxSide = () => (phone ? 3072 : 4096);
  const emit = () => {
    const out = outputSize(state.box, maxSide());
    onChange({ width: out.w, height: out.h, changed: state.rot !== 0 || state.flip || state.box.w !== turned().w || state.box.h !== turned().h });
  };

  function syncChips() {
    for (const chip of chips) chip.setAttribute('aria-pressed', chip.dataset.ratio === state.ratioId ? 'true' : 'false');
  }
  function syncZoom() {
    zoomInput.value = String(Math.round(state.zoom * 100));
  }

  // ---- changes
  function setBox(next) {
    state.box = next;
    schedule();
    emit();
  }

  function setRatio(id) {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    state.ratioId = id;
    syncChips();
    const { w, h: tall } = turned();
    const ratio = ratioNow();
    setBox(ratio ? reshapeBox(state.box, w, tall, ratio) : state.box);
  }

  function setZoom(next, px = cw / 2, py = ch / 2) {
    const target = clamp(next, 1, MAX_ZOOM);
    const v = view();
    const moved = zoomAbout(v, (target * fit) / v.k, px, py, fit);
    const { w, h: tall } = turned();
    state.zoom = moved.k / fit;
    state.pan = { x: moved.ox - (cw - w * moved.k) / 2, y: moved.oy - (ch - tall * moved.k) / 2 };
    syncZoom();
    schedule(true);
  }

  function turn(action) {
    const asSource = mapRect(invert(matrix()), state.box); // which part of the photo the box is on
    const was = ratioNow();
    Object.assign(state, nextTurn({ rot: state.rot, flip: state.flip }, action));
    state.box = mapRect(matrix(), asSource);
    // a locked shape turns with the photo (3:2 becomes 2:3)
    if (was && action !== 'flip') {
      const preset = PRESETS.find((p) => p.id === state.ratioId);
      if (typeof preset?.ratio === 'number') state.ratioId = OPPOSITE_SHAPE(preset.ratio)?.id ?? state.ratioId;
    }
    state.pan = { x: 0, y: 0 };
    measure();
    syncChips();
    schedule(true);
    emit();
  }

  function reset() {
    Object.assign(state, { rot: 0, flip: false, ratioId: 'free', zoom: 1, pan: { x: 0, y: 0 }, box: { x: 0, y: 0, w: SW, h: SH } });
    measure();
    syncChips();
    syncZoom();
    schedule(true);
    emit();
  }

  // ---- the pointer: drag a handle, drag the box, drag the picture, pinch
  const pointers = new Map();
  let drag = null;
  let pinch = null;

  function pinchStart() {
    const [a, b] = [...pointers.values()];
    pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: state.zoom };
    drag = null;
  }

  stage.addEventListener('pointerdown', (event) => {
    if (event.button > 0 || destroyed) return;
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) return pinchStart();
    if (pointers.size > 2) return undefined;
    const handle = event.target instanceof Element ? event.target.dataset.h : undefined;
    const onBox = event.target instanceof Element && event.target.closest('.tc-box');
    drag = { mode: handle ? 'resize' : onBox ? 'move' : 'pan', handle, x: event.clientX, y: event.clientY, box: { ...state.box }, pan: { ...state.pan } };
    element.classList.add('is-dragging');
    if (onBox || handle) box.focus({ preventScroll: true });
    event.preventDefault();
    return undefined;
  });

  stage.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const rect = stage.getBoundingClientRect();
      setZoom(pinch.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance), (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top);
      return;
    }
    if (!drag) return;
    const v = view();
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    const { w, h: tall } = turned();
    if (drag.mode === 'pan') {
      state.pan = { x: drag.pan.x + dx, y: drag.pan.y + dy };
      schedule(true);
    } else if (drag.mode === 'move') {
      setBox(moveBox(drag.box, dx / v.k, dy / v.k, w, tall));
    } else {
      setBox(resizeBox(drag.box, drag.handle, dx / v.k, dy / v.k, { ratio: ratioNow(), W: w, H: tall }));
    }
  });

  const release = (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) {
      drag = null;
      element.classList.remove('is-dragging');
    }
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);
  stage.addEventListener('lostpointercapture', release);

  stage.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0018));
      setZoom(state.zoom * factor, event.clientX - rect.left, event.clientY - rect.top);
    },
    { passive: false },
  );

  // ---- the keyboard, on the box
  box.addEventListener('keydown', (event) => {
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    const { w, h: tall } = turned();
    if (arrows) {
      event.preventDefault();
      event.stopPropagation();
      const step = (event.shiftKey ? 10 : 1) / view().k;
      setBox(event.altKey ? resizeBox(state.box, 'se', arrows[0] * step, arrows[1] * step, { ratio: ratioNow(), W: w, H: tall }) : moveBox(state.box, arrows[0] * step, arrows[1] * step, w, tall));
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      setZoom(state.zoom * 1.25);
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      setZoom(state.zoom / 1.25);
    } else if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      turn(event.shiftKey ? 'ccw' : 'cw');
    }
  });

  const observer = new ResizeObserver(() => {
    measure();
    schedule(true);
  });
  observer.observe(stage);
  measure();
  schedule(true);
  emit();

  return {
    element,
    setRatio,
    turn,
    reset,
    setZoom,
    focus: () => box.focus({ preventScroll: true }),
    /** The cropped picture as a JPEG. */
    async render({ quality = 0.92 } = {}) {
      const out = outputSize(clampBox(state.box, turned().w, turned().h, 1), maxSide());
      const target = h('canvas');
      target.width = out.w;
      target.height = out.h;
      const ctx = target.getContext('2d');
      ctx.fillStyle = '#ffffff'; // a JPEG has no see-through: a transparent PNG gets a white ground
      ctx.fillRect(0, 0, out.w, out.h);
      const m = matrix();
      ctx.setTransform(out.scale, 0, 0, out.scale, -state.box.x * out.scale, -state.box.y * out.scale);
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, 0, 0);
      const blob = await new Promise((resolve) => target.toBlob(resolve, 'image/jpeg', quality));
      if (!blob) throw new Error('The cropped picture could not be made. Try a smaller crop.');
      return { blob, width: out.w, height: out.h };
    },
    state: () => ({ ...state, box: { ...state.box } }),
    destroy() {
      destroyed = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      picture.close();
    },
  };
}
