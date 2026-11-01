/**
 * Pasting an address into a box that wants it. A page marks such a box with `data-import-urls`: the shop's search box and its
 * assistant, the Inspiration page's own box. When something with a photo address in it is pasted there (or Enter is pressed on
 * an address that was typed), the "Import this photo?" question opens. Nothing else about those boxes is touched: the pasted text stays
 * in the box until the person says yes, and then it is taken out, so a search or a question is never made out of an address.
 *
 * `data-import-submit="direct"` on a box makes Enter in it start the import without the question (the Inspiration page's own box).
 *
 * Loaded by the pages as <script type="module" src="/inspiration/assets/index.js">. Everything goes through one function,
 * startImport (flow.js), also reachable as window.TeruconImport.start.
 */
import { isBusy, startImport } from './flow.js';
import { detect } from './sources.js';

const SELECTOR = '[data-import-urls]';

/** Set a box's text the way a person typing would, so the page's own code (a framework's change handler) sees it. */
function setValue(field, value) {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

/** The box without the address that was pasted into it. */
function withoutAddress(field, text) {
  const address = text.trim();
  setValue(field, field.value.replace(address, '').replace(/\s{2,}/g, ' ').trim());
}

function offer(field, text, found, { confirm = true } = {}) {
  return startImport({ text, found, confirm, onAccepted: () => withoutAddress(field, text) }).then((result) => {
    if (result.status !== 'busy' && field.isConnected) field.focus({ preventScroll: true });
    return result;
  });
}

const fieldOf = (event) => (event.target instanceof Element ? event.target.closest(SELECTOR) : null);

function onPaste(event) {
  const field = fieldOf(event);
  if (!field || isBusy()) return;
  const text = event.clipboardData?.getData('text/plain') ?? '';
  const found = detect(text, { ownHost: location.host });
  if (!found) return;
  // not prevented: the text lands in the box first, as it always would; the question comes after
  setTimeout(() => offer(field, text, found), 0);
}

function onKeyDown(event) {
  if (event.key !== 'Enter' || event.isComposing || event.shiftKey || isBusy()) return;
  const field = fieldOf(event);
  if (!field) return;
  const value = String(field.value ?? '').trim();
  const found = value ? detect(value, { ownHost: location.host }) : null;
  // only when the whole box is the address: "oak veneer https://..." is still a search
  if (!found || !/^\S+$/.test(value)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  // a box that is itself the import box (the Inspiration page) marks Enter as the person asking: no second question
  offer(field, value, found, { confirm: field.dataset.importSubmit !== 'direct' });
}

export function install() {
  if (globalThis.TeruconImport) return globalThis.TeruconImport;
  document.addEventListener('paste', onPaste, true);
  document.addEventListener('keydown', onKeyDown, true);
  globalThis.TeruconImport = Object.freeze({ start: startImport, detect: (text) => detect(text, { ownHost: location.host }) });
  return globalThis.TeruconImport;
}

install();
