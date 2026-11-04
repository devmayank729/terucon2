/**
 * The phone page (/capture). A person opened a link from a QR code or a WhatsApp message; this page lets them
 *   1. say who they are (a name is needed; phone, address and place are optional) and, with a button, where they are,
 *   2. take photos inside the page, or choose photos from the gallery, and label each one (room, cabin, ...),
 *   3. send them: one after the other, each with a retry, so a weak connection or a reload loses nothing.
 *
 * The key to the link is the part of the address after the # sign. It is read here, sent as the X-Capture-Token header, and never put in an
 * address that is requested. Photos wait in IndexedDB (queue.js) until the server has them. Everything shown is drawn with textContent, never markup.
 * Nothing on this page uses the requester's cookie: every request is made with credentials omitted.
 */
import { h, icon } from '/inspiration/assets/dom.js';
import { openCamera } from './camera.js';
import { persistent, all as queued, put as queuePut, remove as queueRemove } from './queue.js';
import { PhotoError, prepare } from './resize.js';

const TOKEN = /^[A-Za-z0-9_-]{32}$/;
const TOKEN_KEY = 'terucon.capture.token';
const ME_KEY = 'terucon.capture.me';
const PRESETS = ['Room', 'Cabin', 'Wall', 'Floor', 'Ceiling', 'Door', 'Window', 'Exterior', 'Other'];
const MAX_TAGS = 8;
const RETRY_DELAYS = [1000, 2500, 6000];
const UPLOAD_TIMEOUT_MS = 90_000;
const root = document.getElementById('root');

// ---------------------------------------------------------------------------------------------------------------- small helpers
const safeStorage = {
  get(storage, key) {
    try {
      return globalThis[storage].getItem(key);
    } catch {
      return null;
    }
  },
  set(storage, key, value) {
    try {
      globalThis[storage].setItem(key, value);
    } catch {
      // storage blocked or full: the page works without it
    }
  },
};

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

function base64url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

class ApiError extends Error {
  constructor(status, reason, message, retryAfter = 0) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.retryAfter = retryAfter;
  }
}

function readToken() {
  const fromHash = decodeURIComponent(location.hash.replace(/^#/, '')).trim();
  if (TOKEN.test(fromHash)) {
    safeStorage.set('sessionStorage', TOKEN_KEY, fromHash);
    return fromHash;
  }
  const kept = safeStorage.get('sessionStorage', TOKEN_KEY);
  return kept && TOKEN.test(kept) ? kept : '';
}

const token = readToken();

async function call(path, { method = 'GET', json, body, headers = {}, timeoutMs = 30_000 } = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: { 'X-Capture-Token': token, ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : body,
      signal: abort.signal,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new ApiError(0, 'network', 'There is no connection right now.');
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // an answer without a body
  }
  if (!response.ok) throw new ApiError(response.status, data?.error?.reason ?? '', data?.error?.message ?? 'Something went wrong. Please try again.', Number(response.headers.get('Retry-After')) || 0);
  return data;
}

const duration = (ms) => {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
};

// ---------------------------------------------------------------------------------------------------------------- state
const state = {
  info: null,
  offset: 0, // the server's clock minus this phone's
  remaining: 0,
  items: [], // every photo on the screen, newest last: {id, blob, url, tags, note, status, error, createdAt}
  location: null,
  sending: false,
  wantSend: false,
  dead: false,
};
const refs = {};
let tickTimer = null;

const serverNow = () => Date.now() + state.offset;
const unsent = () => state.items.filter((i) => i.status !== 'sent');
const room = () => Math.max(0, state.remaining - unsent().length);

// ---------------------------------------------------------------------------------------------------------------- screens
/** replaceChildren writes the word "null" for a null child; this leaves nulls out. */
function fill(target, ...nodes) {
  target.replaceChildren(...nodes.filter((n) => n !== null && n !== undefined && n !== false));
}

function screen(...nodes) {
  fill(root, ...nodes);
}

function loadingScreen() {
  screen(h('section', { class: 'hero' }, h('p', { class: 'eyebrow' }, 'Terucon'), h('h1', {}, 'Opening your ', h('em', {}, 'link')), h('p', { class: 'lead' }, 'One moment.')));
}

function deadScreen({ title, text, retry = false, detail = '' }) {
  state.dead = true;
  const waiting = unsent().length;
  screen(
    h(
      'section',
      { class: 'hero' },
      h('p', { class: 'eyebrow' }, 'Terucon'),
      h('h1', {}, title),
      h('p', { class: 'lead' }, text),
      detail ? h('p', { class: 'small' }, detail) : null,
      waiting ? h('p', { class: 'notice bad' }, `${waiting} photo${waiting === 1 ? '' : 's'} on this phone could not be sent. They are kept for a day in case the link is made to work again.`) : null,
      retry ? h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => boot() }, 'Try again')) : null,
    ),
  );
  refs.bar?.remove();
}

function describeFailure(error) {
  switch (error.reason) {
    case 'unknown-link':
      return { title: 'This link is not valid', text: 'Check that you opened the whole link, or ask the person who sent it for a new one.' };
    case 'expired':
      return { title: 'This link has ended', text: 'Links work for a limited time. Ask the person who sent it for a new one.' };
    case 'closed':
      return { title: 'This link was closed', text: 'The person who asked for photos has ended it. Ask them for a new link.' };
    case 'rate-limit':
      return { title: 'Too many tries', text: error.message, retry: true };
    case 'capture-off':
      return { title: 'Not available', text: 'Adding photos from a phone is switched off on this site.' };
    default:
      return error.status === 0
        ? { title: 'No connection', text: 'This phone is offline or the connection is very weak. Check it and try again.', retry: true }
        : { title: 'Not available right now', text: error.message, retry: true };
  }
}

// ---------------------------------------------------------------------------------------------------------------- the form
function field(label, input, { hint = '', error = null } = {}) {
  return h('label', { class: 'f' }, label, hint ? h('small', {}, hint) : null, input, error);
}

function loadMe() {
  try {
    const me = JSON.parse(safeStorage.get('localStorage', ME_KEY) ?? '{}');
    return me && typeof me === 'object' ? me : {};
  } catch {
    return {};
  }
}

function buildForm() {
  const me = loadMe();
  const text = (v) => (typeof v === 'string' ? v.slice(0, 300) : '');
  refs.name = h('input', { class: 'in', type: 'text', name: 'name', autocomplete: 'name', maxlength: '80', required: true, value: text(me.name), 'aria-describedby': 'err-name' });
  refs.phone = h('input', { class: 'in', type: 'tel', name: 'phone', autocomplete: 'tel', inputmode: 'tel', maxlength: '40', value: text(me.phone), placeholder: '+91 98765 43210' });
  refs.address = h('textarea', { class: 'in', name: 'address', autocomplete: 'street-address', maxlength: '300', rows: '2' });
  refs.address.value = text(me.address);
  refs.place = h('input', { class: 'in', type: 'text', name: 'place', maxlength: '120', placeholder: 'Floor, block, shop name…' });
  refs.nameError = h('p', { class: 'err', id: 'err-name', hidden: true });
  refs.formError = h('p', { class: 'notice bad', role: 'alert', hidden: true });
  for (const input of [refs.name, refs.phone, refs.address, refs.place]) input.addEventListener('input', () => input.classList.remove('bad'));

  refs.locBody = h('div');
  refs.locButton = h('button', { type: 'button', class: 'btn ghost small-btn', onclick: getLocation }, icon('pin', 18), 'Use my current location');
  refs.locView = h('div', { class: 'loc' }, h('b', {}, 'Where you are'), h('p', { class: 'small' }, 'Optional. Your phone will ask your permission, and the real position of this phone is sent, nothing else.'), refs.locBody, refs.locButton);
  renderLocation();

  return h(
    'section',
    { class: 'card', 'aria-labelledby': 'who' },
    h('h2', { id: 'who' }, 'About you and the place'),
    field('Your name', refs.name, { hint: 'So they know who sent the photos.', error: refs.nameError }),
    field('Phone number', refs.phone, { hint: 'Optional, with country code if it is not in India.' }),
    field('Address of the place', refs.address, { hint: 'Optional.' }),
    field('Which part (optional)', refs.place),
    refs.locView,
    refs.formError,
    h('p', { class: 'consent' }, `Your name, the details above and your photos go to ${state.info.requester || 'the person at Terucon'} who asked for them, and nobody else. Photos are kept for ${state.info.keepDays} days unless they delete them sooner. Hidden camera data, such as GPS, is removed from every photo.`),
  );
}

// ---------------------------------------------------------------------------------------------------------------- location
function renderLocation() {
  const loc = state.location;
  if (!loc) {
    fill(refs.locBody, );
    refs.locButton.disabled = false;
    fill(refs.locButton, icon('pin', 18), 'Use my current location');
    return;
  }
  if (loc.pending) {
    fill(refs.locBody, h('p', { class: 'small', role: 'status' }, 'Finding your position… this can take up to 20 seconds. Stand near a window if it takes long.'));
    refs.locButton.disabled = true;
    return;
  }
  if (loc.error) {
    fill(refs.locBody, h('p', { class: 'err', role: 'alert' }, loc.error));
    refs.locButton.disabled = false;
    fill(refs.locButton, icon('pin', 18), 'Try again');
    return;
  }
  const map = `https://www.google.com/maps?q=${loc.lat},${loc.lng}`;
  fill(refs.locBody, 
    h('p', { class: 'small', role: 'status' }, `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`, loc.accuracy !== null ? ` (within about ${Math.round(loc.accuracy)} m)` : '', ' · taken just now'),
    loc.accuracy !== null && loc.accuracy > 500 ? h('p', { class: 'err' }, 'This position is not very exact. Try again outdoors or near a window.') : null,
    h('p', { class: 'small' }, h('a', { href: map, target: '_blank', rel: 'noopener noreferrer' }, 'Check it on a map'), ' · ', h('button', { type: 'button', class: 'link', onclick: () => ((state.location = null), renderLocation()) }, 'Remove')),
  );
  refs.locButton.disabled = false;
  fill(refs.locButton, icon('pin', 18), 'Update my location');
}

function getLocation() {
  if (!globalThis.isSecureContext) {
    state.location = { error: 'Location only works on a secure (https) address. The photos can still be sent without it.' };
    return renderLocation();
  }
  if (!navigator.geolocation) {
    state.location = { error: 'This browser cannot share a location. The photos can still be sent without it.' };
    return renderLocation();
  }
  state.location = { pending: true };
  renderLocation();
  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.location = { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null, at: serverNow() };
      renderLocation();
    },
    (error) => {
      const why = { 1: 'Location is blocked for this page. Allow location in your browser’s site settings, then tap Try again.', 2: 'This phone could not work out its position. Check that location is switched on, then tap Try again.', 3: 'Finding the position took too long. Move near a window and tap Try again.' };
      state.location = { error: why[error.code] ?? 'The location could not be read.' };
      renderLocation();
    },
    { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
  );
}

// ---------------------------------------------------------------------------------------------------------------- photos on screen
let saveTimer = null;
function persist(item) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (item.status !== 'sent') queuePut({ id: item.id, token, blob: item.blob, tags: item.tags, note: item.note, createdAt: item.createdAt });
  }, 400);
}

function cardFor(item) {
  const badge = h('span', { class: 'badge' });
  const why = h('p', { class: 'why', role: 'alert', hidden: true });
  const chips = h('div', { class: 'tags', role: 'group', 'aria-label': 'Labels for this photo' });
  const note = h('input', { class: 'in noteln', type: 'text', maxlength: '200', placeholder: 'A note (optional)', 'aria-label': 'Note for this photo', value: item.note });
  const remove = h('button', { type: 'button', class: 'x', 'aria-label': 'Remove this photo', onclick: () => removeItem(item) }, '×');
  const li = h('li', { class: 'shot' }, h('div', { class: 'pic' }, h('img', { src: item.url, alt: 'A photo you added', decoding: 'async' }), badge, remove), chips, note, why);
  const customIn = h('input', { class: 'tagin', type: 'text', maxlength: '30', placeholder: '+ your label', 'aria-label': 'Add your own label' });
  const has = (tag) => item.tags.some((t) => t.toLowerCase() === tag.toLowerCase());
  const buttons = new Map();
  const chipFor = (tag) => {
    const button = h('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': 'false',
      onclick: () => {
        const at = item.tags.findIndex((t) => t.toLowerCase() === tag.toLowerCase());
        if (at >= 0) item.tags.splice(at, 1);
        else if (item.tags.length < MAX_TAGS) item.tags.push(tag);
        persist(item);
        sync();
      },
    }, tag);
    buttons.set(tag.toLowerCase(), button);
    return button;
  };
  const build = () => {
    buttons.clear();
    const custom = item.tags.filter((t) => !PRESETS.some((p) => p.toLowerCase() === t.toLowerCase()));
    chips.replaceChildren(...[...PRESETS, ...custom].map(chipFor), customIn);
  };
  const addCustom = () => {
    const typed = customIn.value.replace(/\s+/g, ' ').trim();
    customIn.value = '';
    if (!typed || has(typed) || item.tags.length >= MAX_TAGS) return;
    item.tags.push(PRESETS.find((p) => p.toLowerCase() === typed.toLowerCase()) ?? typed);
    persist(item);
    build();
    sync();
  };
  customIn.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addCustom();
    }
  });
  customIn.addEventListener('blur', addCustom);
  note.addEventListener('input', () => {
    item.note = note.value;
    persist(item);
  });
  const sync = () => {
    const locked = item.status === 'sending' || item.status === 'sent';
    for (const [key, button] of buttons) {
      button.setAttribute('aria-pressed', has(key) ? 'true' : 'false');
      button.disabled = locked || (!has(key) && item.tags.length >= MAX_TAGS);
    }
    customIn.hidden = locked;
    note.disabled = locked;
  };
  const paint = () => {
    const locked = item.status === 'sending' || item.status === 'sent';
    li.className = `shot ${item.status}`;
    badge.replaceChildren(...(item.status === 'sending' ? [h('span', { class: 'spin' }), 'Sending'] : item.status === 'sent' ? ['✓ Sent'] : item.status === 'failed' ? ['Not sent'] : ['Ready']));
    remove.hidden = locked;
    why.hidden = !(item.status === 'failed' && item.error);
    why.textContent = item.error || '';
    sync();
  };
  build();
  item.paint = paint;
  item.el = li;
  paint();
  return li;
}

function renderGrid() {
  fill(refs.grid, ...state.items.map((item) => item.el ?? cardFor(item)));
  refs.gridWrap.hidden = state.items.length === 0;
  renderBar();
}

function removeItem(item) {
  if (item.status === 'sending') return;
  URL.revokeObjectURL(item.url);
  state.items = state.items.filter((i) => i !== item);
  queueRemove(item.id);
  renderGrid();
  renderAddButtons();
}

function addItem(blob, { tags = [], note = '', id = randomId(), createdAt = Date.now(), restored = false } = {}) {
  const item = { id, blob, url: URL.createObjectURL(blob), tags: [...tags], note, status: 'queued', error: '', createdAt };
  state.items.push(item);
  if (refs.status?.classList.contains('good')) say('');
  if (!restored) queuePut({ id, token, blob, tags: item.tags, note, createdAt });
  renderGrid();
  renderAddButtons();
  return item;
}

function say(text, tone = '') {
  refs.status.className = `notice${tone ? ` ${tone}` : ''}`;
  refs.status.textContent = text;
  refs.status.hidden = !text;
}

async function addFiles(files) {
  const list = [...files];
  if (!list.length) return;
  const allowed = room();
  if (allowed <= 0) return say(`This link takes up to ${state.info.maxPhotos} photos and it is full.`, 'bad');
  const take = list.slice(0, allowed);
  if (list.length > take.length) say(`Only ${allowed} more photo${allowed === 1 ? '' : 's'} fit${allowed === 1 ? 's' : ''} on this link, so ${list.length - take.length} ${list.length - take.length === 1 ? 'was' : 'were'} left out.`, 'bad');
  else say('');
  refs.pick.disabled = true;
  let first = null;
  for (const file of take) {
    say(`Preparing ${file.name || 'photo'}…`);
    try {
      const prepared = await prepare(file, { maxBytes: state.info.maxPhotoBytes });
      const item = addItem(prepared.blob);
      first ??= item;
    } catch (error) {
      say(error instanceof PhotoError ? error.message : 'That photo could not be added.', 'bad');
    }
  }
  refs.pick.disabled = false;
  if (first && refs.status.className.indexOf('bad') < 0) say('');
  first?.el?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
}

async function takePhotos() {
  say('');
  if (room() <= 0) return say(`This link takes up to ${state.info.maxPhotos} photos and it is full.`, 'bad');
  const camera = await openCamera({ onShot: (blob) => addItem(blob), room });
  if (!camera.ok) {
    say(camera.message, 'bad');
    return;
  }
  await camera.closed;
  renderAddButtons();
}

function renderAddButtons() {
  const full = room() <= 0;
  refs.camera.disabled = full;
  refs.pickLabel.classList.toggle('disabled', full);
  refs.pick.disabled = full;
  refs.left.textContent = full ? 'This link is full.' : `You can add ${room()} more photo${room() === 1 ? '' : 's'}.`;
}

// ---------------------------------------------------------------------------------------------------------------- sending
function detailsFromForm() {
  const name = refs.name.value.replace(/\s+/g, ' ').trim();
  const out = { name, phone: refs.phone.value.trim(), address: refs.address.value.replace(/\s+/g, ' ').trim(), place: refs.place.value.replace(/\s+/g, ' ').trim() };
  const loc = state.location;
  out.location = loc && !loc.pending && !loc.error ? { lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy, at: loc.at } : null;
  return out;
}

function showFormError(message, input) {
  refs.formError.textContent = message;
  refs.formError.hidden = !message;
  if (input) {
    input.classList.add('bad');
    input.focus();
  }
}

async function saveDetails() {
  const details = detailsFromForm();
  if ([...details.name].length < 2 || !/\p{L}/u.test(details.name)) {
    refs.nameError.textContent = 'Please enter your name.';
    refs.nameError.hidden = false;
    showFormError('Your name is needed before the photos can be sent.', refs.name);
    refs.name.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return false;
  }
  refs.nameError.hidden = true;
  showFormError('');
  try {
    await call('/api/capture/s/details', { method: 'PUT', json: details });
  } catch (error) {
    if (error.reason === 'stale-location') {
      state.location = null;
      renderLocation();
      showFormError('Your location was too old to use. Tap “Use my current location” again, or send without it.');
      return false;
    }
    if (error.status === 400) {
      showFormError(error.message, error.reason === 'bad-phone' ? refs.phone : error.reason === 'bad-name' ? refs.name : null);
      return false;
    }
    throw error;
  }
  safeStorage.set('localStorage', ME_KEY, JSON.stringify({ name: details.name, phone: details.phone, address: details.address }));
  return true;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Send one photo, trying again on a weak connection. Returns 'sent', 'failed' (a person can retry), or 'dead' (the link is over). */
async function sendOne(item) {
  item.status = 'sending';
  item.error = '';
  item.paint();
  let last = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
    try {
      const meta = base64url(JSON.stringify({ tags: item.tags, note: item.note.trim() }));
      const answer = await call('/api/capture/s/photos', { method: 'POST', body: item.blob, headers: { 'Content-Type': item.blob.type || 'image/jpeg', 'X-Photo-Id': item.id, 'X-Photo-Meta': meta }, timeoutMs: UPLOAD_TIMEOUT_MS });
      item.status = 'sent';
      state.remaining = answer.remaining;
      queueRemove(item.id);
      item.paint();
      return 'sent';
    } catch (error) {
      last = error;
      if (error.status === 410 || error.reason === 'unknown-link') {
        item.status = 'failed';
        item.error = describeFailure(error).text;
        item.paint();
        return 'dead';
      }
      const worthRetrying = error.status === 0 || error.status === 429 || error.status >= 500 || error.reason === 'in-progress';
      if (!worthRetrying || attempt === RETRY_DELAYS.length) break;
      await pause(Math.max(RETRY_DELAYS[attempt], error.retryAfter * 1000));
    }
  }
  item.status = 'failed';
  item.error = last?.status === 0 ? 'No connection. Tap Send to try again.' : last?.message || 'This photo did not send.';
  item.paint();
  return 'failed';
}

async function send() {
  if (state.sending || state.dead) return;
  say('');
  state.sending = true;
  state.wantSend = true;
  renderBar();
  let wake = null;
  try {
    wake = await navigator.wakeLock?.request('screen');
  } catch {
    // the screen may sleep; the retries still run
  }
  try {
    let ok;
    try {
      ok = await saveDetails();
    } catch (error) {
      if (error.status === 410 || error.reason === 'unknown-link') return deadScreen(describeFailure(error));
      say(error.status === 0 ? 'There is no connection. Tap Send when it is back.' : error.message, 'bad');
      return;
    }
    if (!ok) {
      state.wantSend = false;
      return;
    }
    const tried = new Set();
    let inARow = 0;
    for (;;) {
      const next = state.items.find((i) => (i.status === 'queued' || i.status === 'failed') && !tried.has(i));
      if (!next) break;
      tried.add(next);
      const result = await sendOne(next);
      if (result === 'dead') return deadScreen({ title: 'This link has ended', text: 'Ask the person who sent it for a new one.' });
      inARow = result === 'sent' ? 0 : inARow + 1;
      if (inARow >= 2) break; // the connection is probably gone: do not spend minutes failing every photo; the rest wait for the next press
    }
    const left = state.items.filter((i) => i.status === 'failed' || i.status === 'queued').length;
    if (left) {
      say(`${left} photo${left === 1 ? '' : 's'} did not send. Tap Send to try again.`, 'bad');
    } else {
      state.wantSend = false;
      try {
        await call('/api/capture/s/done', { method: 'POST', json: {} });
      } catch {
        // the photos are sent; only the summary message to the requester was missed
      }
      const total = state.items.filter((i) => i.status === 'sent').length;
      say(`All done. ${total} photo${total === 1 ? '' : 's'} sent${state.info.requester ? ` to ${state.info.requester}` : ''}. You can add more below.`, 'good');
    }
  } finally {
    state.sending = false;
    wake?.release?.().catch(() => {});
    renderBar();
    renderAddButtons();
  }
}

function renderBar() {
  const waiting = unsent().length;
  refs.bar.hidden = waiting === 0 && !state.sending; // nothing to send: no bar over the page
  refs.send.disabled = state.sending || state.dead || waiting === 0;
  fill(refs.send, ...(state.sending ? [h('span', { class: 'spin' }), 'Sending…'] : [icon('upload', 18), waiting ? `Send ${waiting} photo${waiting === 1 ? '' : 's'}` : 'Add a photo to send']));
  refs.barNote.textContent = !persistent && waiting ? 'Keep this page open until the photos are sent.' : '';
  refs.barNote.hidden = !refs.barNote.textContent;
}

function tick() {
  if (!refs.expires || state.dead) return;
  const left = state.info.expiresAt - serverNow();
  if (left <= 0) return deadScreen({ title: 'This link has ended', text: 'Ask the person who sent it for a new one.' });
  refs.expires.textContent = `Link works for ${duration(left)} more`;
}

// ---------------------------------------------------------------------------------------------------------------- start
function ready(info) {
  state.dead = false;
  state.info = info;
  state.offset = info.serverNow - Date.now();
  state.remaining = info.remaining;

  refs.status = h('p', { class: 'notice', role: 'status', hidden: true });
  refs.left = h('p', { class: 'small' });
  refs.expires = h('li');
  refs.camera = h('button', { type: 'button', class: 'btn', onclick: takePhotos }, icon('camera', 20), 'Take photos');
  refs.pick = h('input', { type: 'file', accept: 'image/*', multiple: true, 'aria-label': 'Choose photos from your gallery', onchange: (event) => addFiles(event.target.files).finally(() => (event.target.value = '')) });
  refs.pickLabel = h('label', { class: 'btn ghost file-label' }, icon('image', 20), 'Choose from gallery', refs.pick);
  refs.grid = h('ul', { class: 'grid' });
  refs.gridWrap = h('section', { class: 'card', 'aria-labelledby': 'shots', hidden: true }, h('h2', { id: 'shots' }, 'Your photos'), h('p', { class: 'small' }, 'Tap a label to say what each photo shows. You can add your own.'), refs.grid);
  refs.send = h('button', { type: 'button', class: 'btn', onclick: send });
  refs.barNote = h('p', { class: 'status', hidden: true });
  refs.bar = h('div', { class: 'bar' }, h('div', { class: 'bar-in' }, refs.barNote, refs.send));

  const who = info.requester || 'Someone at Terucon';
  screen(
    h('section', { class: 'hero' }, h('p', { class: 'eyebrow' }, info.serviceLabel ? `For the ${info.serviceLabel}` : 'Terucon'), h('h1', {}, 'Add ', h('em', {}, 'photos')), h('p', { class: 'lead' }, `${who} asked for photos of a space. Take them here, label them, and send.`)),
    info.note ? h('div', { class: 'request' }, h('b', {}, 'They asked'), info.note) : null,
    h('ul', { class: 'meta' }, refs.expires, h('li', {}, `Up to ${info.maxPhotos} photos`)),
    buildForm(),
    h(
      'section',
      { class: 'card', 'aria-labelledby': 'add' },
      h('h2', { id: 'add' }, 'Photos'),
      h('p', { class: 'small' }, '“Take photos” keeps you on this page, so nothing is lost. “Choose from gallery” can pick several at once.'),
      h('div', { class: 'row' }, refs.camera, refs.pickLabel),
      refs.left,
      refs.status,
    ),
    refs.gridWrap,
  );
  document.body.append(refs.bar);
  renderAddButtons();
  renderBar();
  tick();
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, 20_000);
}

async function restore() {
  let saved = [];
  try {
    saved = await queued(token);
  } catch {
    return;
  }
  const keep = saved.slice(0, state.remaining);
  for (const item of keep) if (item.blob instanceof Blob) addItem(item.blob, { id: item.id, tags: Array.isArray(item.tags) ? item.tags : [], note: typeof item.note === 'string' ? item.note : '', createdAt: item.createdAt, restored: true });
  if (keep.length) say(`${keep.length} photo${keep.length === 1 ? '' : 's'} from earlier on this phone ${keep.length === 1 ? 'is' : 'are'} ready to send.`);
}

async function boot() {
  if (!token) {
    return deadScreen({ title: 'This link is not complete', text: 'Open the whole link or scan the QR code again. If it came in a message, make sure you tapped the full link.' });
  }
  loadingScreen();
  try {
    ready(await call('/api/capture/s/info'));
  } catch (error) {
    return deadScreen(describeFailure(error));
  }
  await restore();
}

window.addEventListener('online', () => {
  if (state.wantSend && !state.sending && !state.dead) send();
});
window.addEventListener('beforeunload', (event) => {
  if (state.sending || (!persistent && unsent().length)) {
    event.preventDefault();
    event.returnValue = '';
  }
});

boot();
