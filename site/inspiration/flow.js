/**
 * The whole import, start to finish, as one function: an address in, a cropped photo in the Design Studio (or, if the person
 * chooses that instead, the Finder, target C3) out.
 *
 *   detect (sources.js) -> "Import this photo?" -> the server resolves it (api.js) -> pick one if there are several ->
 *   fetch it -> crop it (cropper.js, ui.js) -> keep it and go there (handoff.js)
 *
 * It is the same for a paste into the shop's search box, the shop's assistant and the Inspiration page; the callers differ only in
 * what they pass in. A picture the person uploads themselves joins the same path at the crop.
 */
import { ImportFailure, fetchPicture, resolveAddress } from './api.js';
import { decodePicture } from './cropper.js';
import { sendToFinder, sendToStudio } from './handoff.js';
import { detect } from './sources.js';
import { createUI, isPhone } from './ui.js';

const ui = createUI({ styleHref: new URL('./import.css', import.meta.url).href });
let running = false;

export const isBusy = () => running;

const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'photo';

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const WHAT_NEXT = {
  signin: { title: 'Please sign in', actions: [{ label: 'Sign in', value: 'signin', primary: true }, { label: 'Close', value: null }] },
};

/**
 * @param {object} options
 * @param {string} [options.text] what was pasted or typed (an address, or text that has one)
 * @param {ReturnType<typeof detect>} [options.found] what detect() made of it (done here when left out)
 * @param {boolean} [options.confirm] ask "Import this photo?" first (default: yes; the Inspiration page's own button says no, the person just asked)
 * @param {() => void} [options.onAccepted] the person said yes (the shop empties the search box here)
 * @param {(info: {blob: Blob, width: number, height: number, source: string, action: string}) => void} [options.onCropped] the person is done cropping
 * @param {File | Blob} [options.file] start from a picture the person has, not an address
 * @param {boolean} [options.sendToStudio] after cropping, go to the Design Studio (default true)
 * @param {boolean} [options.offerFinder] offer "Find similar materials" on the crop screen, next to Download (default true)
 * @returns {Promise<{status: 'sent' | 'downloaded' | 'declined' | 'cancelled' | 'failed' | 'busy' | 'ignored'}>}
 */
export async function startImport(options = {}) {
  if (running) return { status: 'busy' };
  const found = options.found ?? (options.text ? detect(options.text, { ownHost: location.host }) : null);
  if (!found && !options.file) return { status: 'ignored' };
  running = true;
  const controller = new AbortController();
  let keepOpen = false;
  try {
    await ui.open();
    const outcome = await journey({ ...options, found }, controller, (value) => {
      keepOpen = value;
    });
    return outcome;
  } finally {
    running = false;
    if (!keepOpen) ui.close();
  }
}

async function journey(options, controller, holdOpen) {
  const phone = isPhone();
  let found = options.found;
  let source = found?.source?.label ?? (found ? found.host : '');
  let name = `${slug(source)}-inspiration.jpg`;

  /** A picture the person has: open it for cropping. */
  const crop = async (blob, label) => {
    ui.progress({ title: 'Opening the photo…' });
    let picture;
    try {
      picture = await decodePicture(blob, { phone });
    } catch {
      return failed(new ImportFailure('This file could not be opened as a photo. Try a JPEG, PNG or WebP picture.', { reason: 'not-an-image' }));
    }
    const result = await ui.crop({ picture, source: label || source, findLabel: options.offerFinder === false ? null : 'Find similar materials' });
    if (!result) return { status: 'cancelled' };
    options.onCropped?.({ blob: result.blob, width: result.width, height: result.height, source: label || source, action: result.action });
    if (result.action === 'download') {
      download(result.blob, name);
      return { status: 'downloaded' };
    }
    if (result.action === 'find') {
      ui.progress({ title: 'Opening the Finder…', text: 'Your cropped photo goes in to match against the real catalogue.' });
      holdOpen(true); // the page is about to change; the dialog stays until it does
      try {
        await sendToFinder(result.blob, { name, source: label || source });
        return { status: 'sent' };
      } catch {
        holdOpen(false);
        const next = await ui.message({ title: 'We could not pass the photo on', text: 'Your browser would not keep the photo for the Finder. Download it, then upload it there.', tone: 'error', actions: [{ label: 'Download the photo', value: 'download', primary: true, icon: 'download' }, { label: 'Close', value: null }] });
        if (next === 'download') download(result.blob, name);
        return { status: next === 'download' ? 'downloaded' : 'failed' };
      }
    }
    if (options.sendToStudio === false) return { status: 'sent' };
    ui.progress({ title: 'Opening the Design Studio…', text: 'Your cropped photo goes in as a new photo.' });
    holdOpen(true); // the page is about to change; the dialog stays until it does
    try {
      await sendToStudio(result.blob, { name, source: label || source });
      return { status: 'sent' };
    } catch {
      holdOpen(false);
      const next = await ui.message({ title: 'We could not pass the photo on', text: 'Your browser would not keep the photo for the Design Studio. Download it, then add it in the studio with “New photo”.', tone: 'error', actions: [{ label: 'Download the photo', value: 'download', primary: true, icon: 'download' }, { label: 'Close', value: null }] });
      if (next === 'download') download(result.blob, name);
      return { status: next === 'download' ? 'downloaded' : 'failed' };
    }
  };

  /** Something went wrong: say what in plain words and offer the way on. */
  async function failed(error) {
    const reason = error instanceof ImportFailure ? error.reason : 'failed';
    const retry = !['signin', 'login', 'unsupported', 'not-an-image', 'not-set-up', 'off', 'private'].includes(reason);
    const actions = [];
    if (reason === 'signin') actions.push({ label: 'Sign in', value: 'signin', primary: true });
    else {
      actions.push({ label: 'Upload a photo instead', upload: true, primary: !retry });
      if (retry && found) actions.unshift({ label: 'Try again', value: 'retry', primary: true });
    }
    actions.push({ label: 'Close', value: null });
    const choice = await ui.message({ title: reason === 'signin' ? 'Please sign in' : 'We could not import that', text: error instanceof Error ? error.message : 'Something went wrong. Please try again.', tone: 'error', actions });
    if (choice === 'signin') {
      holdOpen(true);
      location.assign(`/login?next=${encodeURIComponent(location.pathname)}`);
      return { status: 'failed' };
    }
    if (choice === 'retry') return fromAddress();
    if (choice instanceof Blob) return crop(choice, 'your device');
    return { status: 'failed' };
  }

  async function fromAddress() {
    ui.progress({ title: 'Finding the photo…', text: 'This can take a few seconds.', onCancel: () => controller.abort() });
    try {
      const resolved = await resolveAddress(options.text ?? found.url, controller.signal);
      source = resolved.source?.label || source;
      name = `${slug(source)}-inspiration.jpg`;
      let item = resolved.items[0];
      if (resolved.kind === 'collection' && resolved.items.length > 1) {
        item = await ui.pick({ title: resolved.title, source, items: resolved.items });
        if (!item) return { status: 'cancelled' };
      }
      ui.progress({ title: 'Getting the photo…', text: resolved.approximate ? 'We are using the main picture the page shows.' : '', onCancel: () => controller.abort() });
      const blob = await fetchPicture(item.token, controller.signal);
      return await crop(blob, source);
    } catch (error) {
      if (error?.name === 'AbortError') return { status: 'cancelled' };
      if (error instanceof ImportFailure) return failed(error);
      return failed(new ImportFailure('Something went wrong. Please try again.'));
    }
  }

  // a picture the person already has
  if (options.file) return crop(options.file, 'your device');

  // a site that shows nothing without signing in, or a page that is not a picture: say so, offer to upload
  if (found.type === 'login' || found.type === 'unsupported') {
    const choice = await ui.message({ title: found.type === 'login' ? `${found.source.label} needs a sign-in` : 'We cannot import that one', text: found.message, tone: found.type === 'login' ? 'lock' : 'info', actions: [{ label: 'Upload a photo instead', upload: true, primary: true }, { label: 'Close', value: null }] });
    return choice instanceof Blob ? crop(choice, 'your device') : { status: 'declined' };
  }

  if (options.confirm !== false) {
    const answer = await ui.ask({ found });
    if (answer !== 'yes') return { status: 'declined' };
  }
  options.onAccepted?.();
  return fromAddress();
}
