/**
 * The import dialog and its screens. One modal, in a shadow root so the page it opens over cannot restyle it (and it cannot
 * restyle the page), with a stylesheet from this site (import.css), so it also works on pages with a strict Content-Security-Policy.
 * Accessible: role="dialog" with a label, focus moves in and is kept in, Escape closes, focus returns to where it was.
 *
 * Every screen is built with h() from dom.js: text goes in as text, never as markup.
 */
import { createCropper } from './cropper.js';
import { h, icon, linkLoaded } from './dom.js';
import { describeFound } from './sources.js';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A short, readable form of an address for the question: host and the start of the path. */
export function shortAddress(address) {
  try {
    const url = new URL(address);
    const path = decodeURIComponent(url.pathname).replace(/\/$/, '');
    const text = `${url.hostname.replace(/^www\./, '')}${path}`;
    return text.length > 64 ? `${text.slice(0, 61)}…` : text;
  } catch {
    return String(address).slice(0, 64);
  }
}

export const isPhone = () => !!globalThis.matchMedia?.('(pointer: coarse)').matches && Math.min(innerWidth, innerHeight) < 600;

/** A "choose a file" button that really is a file input (so it works wherever file inputs do, with no script gesture tricks). */
export function uploadButton(label, onFile, { primary = false, name = 'Choose a photo' } = {}) {
  const input = h('input', { type: 'file', accept: 'image/*,.heic,.heif', class: 'tc-file', 'aria-label': name });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (file) onFile(file);
  });
  return h('label', { class: `tc-btn ${primary ? 'tc-primary' : 'tc-ghost'}` }, icon('upload', 18), h('span', { text: label }), input);
}

/** @param {{styleHref: string}} options */
export function createUI({ styleHref }) {
  let host = null;
  let shadow = null;
  let overlay = null;
  let card = null;
  let current = null;
  let returnFocusTo = null;
  let scrollWas = null;
  let ready = null;

  function mount() {
    host = h('div', { id: 'terucon-import', style: { position: 'fixed', inset: '0', zIndex: '2147483000' } });
    shadow = host.attachShadow({ mode: 'open' });
    const link = h('link', { rel: 'stylesheet', href: styleHref });
    card = h('div', { class: 'tc-card', role: 'dialog', 'aria-modal': 'true', tabindex: '-1' });
    overlay = h('div', { class: 'tc-overlay', hidden: true }, card);
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay && current?.dismissOutside) current.onCancel?.();
    });
    shadow.append(link, overlay);
    host.addEventListener('keydown', onKey);
    document.body.append(host);
    return linkLoaded(link);
  }

  function onKey(event) {
    event.stopPropagation(); // the page under the dialog has its own keys (Escape closes its menus); none of them are for us
    if (event.key === 'Escape') {
      event.preventDefault();
      current?.onCancel?.();
    } else if (event.key === 'Tab') {
      const items = [...card.querySelectorAll(FOCUSABLE)];
      if (!items.length) return event.preventDefault();
      const active = shadow.activeElement;
      if (event.shiftKey && (active === items[0] || active === card || !active)) {
        event.preventDefault();
        items.at(-1).focus();
      } else if (!event.shiftKey && active === items.at(-1)) {
        event.preventDefault();
        items[0].focus();
      }
    } else if (event.key === 'Enter' && current?.onEnter) {
      const target = event.composedPath()[0];
      if (!(target instanceof Element) || !target.closest('button, a, input, label, [role="button"]')) {
        event.preventDefault();
        current.onEnter();
      }
    }
    return undefined;
  }

  /** Put a screen in the dialog (opening it if it is closed). */
  function show(node, { kind = '', label, onCancel = null, dismissOutside = false, onEnter = null }) {
    card.className = `tc-card ${kind}`;
    card.setAttribute('aria-label', label);
    card.replaceChildren(node);
    current = { onCancel, dismissOutside, onEnter };
    if (overlay.hidden) {
      returnFocusTo = document.activeElement;
      scrollWas = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      overlay.hidden = false;
    }
    const first = node.querySelector('[data-autofocus]') ?? node.querySelector(FOCUSABLE) ?? card;
    first.focus({ preventScroll: true });
  }

  /**
   * Show a screen and wait for it to finish. `build(finish, onCleanup)` returns the screen; however it ends (a button, Escape, a click
   * outside) `finish` runs once, the cleanup registered with `onCleanup` runs, and the promise settles with the value (null for a dismissal).
   */
  const screen = (kind, label, build, options = {}) =>
    new Promise((resolve) => {
      let cleanup = null;
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        cleanup?.();
        resolve(value);
      };
      const node = build(finish, (fn) => {
        cleanup = fn;
      });
      show(node, { kind, label, onCancel: () => finish(null), dismissOutside: options.dismissOutside ?? false, onEnter: options.onEnter ? () => options.onEnter(finish) : null });
    });

  const closeButton = (finish) => h('button', { type: 'button', class: 'tc-x', 'aria-label': 'Close', title: 'Close', onclick: () => finish(null) }, icon('close', 18));

  return {
    /** Mount the dialog (once) and wait for its stylesheet. */
    open() {
      ready ??= mount();
      return ready;
    },

    /** Hide the dialog and give the page back. */
    close() {
      if (!overlay || overlay.hidden) return;
      overlay.hidden = true;
      current = null;
      card.replaceChildren();
      document.documentElement.style.overflow = scrollWas ?? '';
      if (returnFocusTo instanceof HTMLElement && returnFocusTo.isConnected) returnFocusTo.focus({ preventScroll: true });
    },

    /** "Import this photo?" -> 'yes' | null */
    ask({ found }) {
      const collection = found.kind === 'collection';
      const title = collection ? 'Import a photo from this?' : 'Import this photo?';
      return screen(
        'tc-small',
        title,
        (finish) =>
          h(
            'div',
            { class: 'tc-pane' },
            closeButton(finish),
            h('span', { class: 'tc-badge' }, icon('link', 22)),
            h('h2', { class: 'tc-title', text: title }),
            h('p', { class: 'tc-text', text: `You pasted a link to ${describeFound(found)}. ${collection ? 'You will pick one photo from it, then crop it.' : 'You can crop it before it goes to the Design Studio.'}` }),
            found.type === 'page' ? h('p', { class: 'tc-note', text: 'This is a web page, not a photo file, so we will use the main picture the page shows.' }) : null,
            h('p', { class: 'tc-chip-address', title: found.url }, icon('image', 16), h('span', { text: shortAddress(found.url) })),
            h('div', { class: 'tc-actions' }, h('button', { type: 'button', class: 'tc-btn tc-primary', 'data-autofocus': '', onclick: () => finish('yes') }, icon('check', 18), h('span', { text: 'Yes, import it' })), h('button', { type: 'button', class: 'tc-btn tc-ghost', onclick: () => finish(null) }, 'Not now')),
          ),
        { dismissOutside: true, onEnter: (finish) => finish('yes') },
      );
    },

    /** A message with buttons. `actions`: [{label, value, primary?, upload?}]; `upload` makes it a file chooser whose value is the chosen File. -> value | null */
    message({ title, text, tone = 'info', actions }) {
      return screen(
        'tc-small',
        title,
        (finish) =>
          h(
            'div',
            { class: 'tc-pane' },
            closeButton(finish),
            h('span', { class: `tc-badge tc-${tone}` }, icon(tone === 'error' ? 'alert' : tone === 'lock' ? 'lock' : 'image', 22)),
            h('h2', { class: 'tc-title', text: title }),
            h('p', { class: 'tc-text', text }),
            h(
              'div',
              { class: 'tc-actions' },
              ...actions.map((a, i) =>
                a.upload
                  ? uploadButton(a.label, (file) => finish(file), { primary: a.primary })
                  : h('button', { type: 'button', class: `tc-btn ${a.primary ? 'tc-primary' : 'tc-ghost'}`, 'data-autofocus': i === 0 ? '' : null, onclick: () => finish(a.value) }, a.icon ? icon(a.icon, 18) : null, h('span', { text: a.label })),
              ),
            ),
          ),
        { dismissOutside: true },
      );
    },

    /** Something is happening. Returns {update(title, text), onCancel(fn)}; the screen stays until another replaces it. */
    progress({ title, text = '', onCancel }) {
      const heading = h('h2', { class: 'tc-title', text: title });
      const detail = h('p', { class: 'tc-text', text });
      const pane = h('div', { class: 'tc-pane tc-center', 'aria-live': 'polite' }, h('span', { class: 'tc-spinner', 'aria-hidden': 'true' }), heading, detail, onCancel ? h('button', { type: 'button', class: 'tc-btn tc-ghost', onclick: () => onCancel() }, 'Cancel') : null);
      show(pane, { kind: 'tc-small', label: title, onCancel: onCancel ?? null });
      return {
        update(nextTitle, nextText = '') {
          heading.textContent = nextTitle;
          detail.textContent = nextText;
        },
      };
    },

    /** Choose one picture of several. -> the item | null */
    pick({ title, source, items }) {
      const heading = title || `Choose a photo`;
      return screen(
        'tc-wide',
        heading,
        (finish) =>
          h(
            'div',
            { class: 'tc-pane tc-picker' },
            closeButton(finish),
            h('h2', { class: 'tc-title', text: heading }),
            h('p', { class: 'tc-text', text: `${items.length} photos from ${source}. Choose the one you want to use.` }),
            h(
              'div',
              { class: 'tc-grid', role: 'list' },
              ...items.map((item, i) =>
                h(
                  'button',
                  { type: 'button', role: 'listitem', class: 'tc-tile', 'aria-label': item.title ? `Use photo ${i + 1}: ${item.title}` : `Use photo ${i + 1}`, 'data-autofocus': i === 0 ? '' : null, onclick: () => finish(item) },
                  item.preview ? h('img', { src: item.preview, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false' }) : h('span', { class: 'tc-tile-empty' }, icon('image', 28)),
                  item.title ? h('span', { class: 'tc-tile-title', text: item.title }) : null,
                ),
              ),
            ),
            h('div', { class: 'tc-actions' }, h('button', { type: 'button', class: 'tc-btn tc-ghost', onclick: () => finish(null) }, 'Cancel')),
          ),
        { dismissOutside: true },
      );
    },

    /**
     * The crop screen. -> {action: 'use' | 'download', blob, width, height} | null (the picture is released either way)
     * @param {{picture: object, source: string, canDownload?: boolean, useLabel?: string}} options
     */
    crop({ picture, source, canDownload = true, useLabel = 'Use in Design Studio' }) {
      const phone = isPhone();
      return screen(
        'tc-crop-screen',
        'Crop your photo',
        (finish, onCleanup) => {
          let busy = false;
          const info = h('span', { class: 'tc-size', 'aria-live': 'polite' });
          const problem = h('p', { class: 'tc-problem', role: 'alert', hidden: true });
          const cropper = createCropper({
            picture,
            phone,
            onChange: ({ width, height }) => {
              info.textContent = `${width} × ${height} px`;
            },
          });
          onCleanup(() => cropper.destroy()); // whichever way the screen ends: a button, Escape, or the close mark
          const leave = finish;
          const go = async (action) => {
            if (busy) return;
            busy = true;
            problem.hidden = true;
            pane.classList.add('is-busy');
            try {
              const made = await cropper.render();
              leave({ action, ...made });
            } catch (error) {
              busy = false;
              pane.classList.remove('is-busy');
              problem.textContent = error?.message || 'The cropped photo could not be made.';
              problem.hidden = false;
            }
          };
          const pane = h(
            'div',
            { class: 'tc-pane tc-cropper' },
            h('header', { class: 'tc-head' }, h('div', {}, h('h2', { class: 'tc-title', text: 'Crop your photo' }), h('p', { class: 'tc-sub', text: source ? `From ${source}` : 'Drag the corners, or pick a shape' })), h('button', { type: 'button', class: 'tc-x', 'aria-label': 'Close without using the photo', title: 'Close', onclick: () => leave(null) }, icon('close', 18))),
            cropper.element,
            problem,
            h(
              'footer',
              { class: 'tc-foot' },
              h('span', { class: 'tc-meta' }, info, h('span', { class: 'tc-dot', text: '·' }), h('span', { text: 'JPEG' })),
              h(
                'div',
                { class: 'tc-actions' },
                h('button', { type: 'button', class: 'tc-btn tc-ghost', onclick: () => leave(null) }, 'Cancel'),
                canDownload ? h('button', { type: 'button', class: 'tc-btn tc-ghost', onclick: () => go('download') }, icon('download', 18), h('span', { text: 'Download' })) : null,
                h('button', { type: 'button', class: 'tc-btn tc-primary', 'data-autofocus': '', onclick: () => go('use') }, icon('check', 18), h('span', { text: useLabel })),
              ),
            ),
          );
          queueMicrotask(() => cropper.focus());
          return pane;
        },
        {},
      );
    },
  };
}
