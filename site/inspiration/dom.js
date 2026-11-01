/**
 * Building page elements without ever writing markup: every string goes in as text or as an attribute value, so nothing that comes
 * from outside (a picture's title, an address, a message from the server) can become a tag or a script.
 */

/**
 * @param {string} tag
 * @param {Record<string, unknown>} [props] `class`, `text`, `style` (an object, set property by property), `on<event>` functions,
 *   `hidden`/`disabled`/`checked`/`value` (properties), anything else an attribute (false/null/undefined leave it out)
 * @param {...(Node | string | null | false | undefined)} children
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'style') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'hidden' || key === 'disabled' || key === 'checked' || key === 'value') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Stroke icons, 24 x 24. */
const ICONS = {
  rotateLeft: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5',
  rotateRight: 'M21 12a9 9 0 1 1-3-6.7M21 4v5h-5',
  flip: 'M12 3v18M8 7 3 12l5 5V7zM16 7l5 5-5 5V7z',
  reset: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5',
  zoomOut: 'M5 12h14',
  zoomIn: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5 10 17.5 19 7.5',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  upload: 'M12 16V4M7 9l5-5 5 5M5 20h14',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9.5h.01',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  alert: 'M12 4 2.5 20h19L12 4zM12 10v4M12 17h.01',
  clipboard: 'M9 4h6v3H9zM7 5.5H5.5v15h13v-15H17',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5l5 5',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
};

/** An inline SVG icon (decorative: hidden from screen readers; put the words on the button). */
export function icon(name, size = 20) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.image);
  svg.append(path);
  return svg;
}

/** Wait for a stylesheet link to load (or give up after `ms`, so a missing file never blocks the screen). */
export function linkLoaded(link, ms = 2500) {
  return new Promise((resolve) => {
    if (link.sheet) return resolve();
    const done = () => resolve();
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
    setTimeout(done, ms);
  });
}
