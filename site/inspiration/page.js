/**
 * The Inspiration page (pages/inspiration.html): its search box, the Paste and Import buttons, upload and drag-and-drop, the list of
 * sites, and the "recently imported" list. The import itself is flow.js, the same one the shop's boxes use.
 */
import { importStatus } from './api.js';
import { h } from './dom.js';
import { startImport } from './flow.js';
import { ID_PATTERN, take } from './handoff.js';
import './index.js'; // pasting into the box asks "Import this photo?", like everywhere else
import { detect, supportedSites } from './sources.js';

const $ = (id) => document.getElementById(id);
const input = $('link');
const note = $('detected');
const RECENT_KEY = 'terucon.inspiration.recent';
const RECENT_MAX = 8;

// ---- what the box holds
function say(tone, text) {
  note.className = `detected${tone ? ` is-${tone}` : ''}`;
  note.replaceChildren(...(text ? [h('b', { text })] : []));
}

function describe(value) {
  const text = value.trim();
  if (!text) return say('', '');
  const found = detect(text, { ownHost: location.host });
  if (!found) return say('warn', 'That does not look like a link to a photo or a web page yet.');
  if (found.type === 'login' || found.type === 'unsupported') return say('warn', found.message);
  const what = { source: `${found.source?.label} ${found.shape}`, direct: 'A photo file', page: 'A web page: we will use its main picture' }[found.type];
  return say('', `✓ ${what}`);
}
input.addEventListener('input', () => describe(input.value));

// ---- the recently imported list (this browser only)
function loadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((e) => e && typeof e.url === 'string' && typeof e.thumb === 'string' && e.thumb.startsWith('data:image/')).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}
function saveRecent(list) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    // storage full or blocked: the list just is not kept
  }
}
function renderRecent() {
  const list = loadRecent();
  $('recent-block').hidden = !list.length;
  $('recent').replaceChildren(
    ...list.map((entry) =>
      h(
        'li',
        {},
        h('button', { type: 'button', onclick: () => run(entry.url, { confirm: false }) }, h('img', { src: entry.thumb, alt: '', width: '220', height: '165' }), h('span', {}, entry.label || 'Imported photo', h('small', { text: new Date(entry.when).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) }))),
      ),
    ),
  );
}
async function remember(url, blob, label) {
  try {
    const bitmap = await createImageBitmap(blob, { resizeWidth: 220, resizeQuality: 'medium' });
    const canvas = h('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    const entry = { url, label, thumb: canvas.toDataURL('image/jpeg', 0.7), when: Date.now() };
    saveRecent([entry, ...loadRecent().filter((e) => e.url !== url)]);
    renderRecent();
  } catch {
    // no thumbnail, no entry
  }
}
$('clear-recent').addEventListener('click', () => {
  saveRecent([]);
  renderRecent();
});

// ---- starting an import
async function run(text, { confirm = false } = {}) {
  const found = detect(text, { ownHost: location.host });
  if (!found) {
    say('warn', 'Paste the link to a photo, a Pinterest pin or board, or a web page.');
    input.focus();
    return;
  }
  const address = found.url;
  const result = await startImport({ text, found, confirm, onAccepted: () => (input.value = ''), onCropped: ({ blob, source, action }) => action && remember(address, blob, source) });
  if (result.status === 'downloaded') say('', '✓ Saved to your device.');
  else if (result.status === 'declined' || result.status === 'cancelled') describe(input.value);
  else if (result.status === 'failed') say('warn', 'That did not work. You can try again or upload the photo.');
  describe(input.value);
}

$('go').addEventListener('click', () => {
  const text = input.value.trim();
  if (!text) {
    say('info', 'Paste a link first, or upload a photo.');
    input.focus();
    return;
  }
  run(text);
});

// Enter in the box is handled by index.js (data-import-submit="direct": the person asked, so no second question)

$('paste').addEventListener('click', async () => {
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    say('info', window.matchMedia?.('(pointer: coarse)').matches ? 'Your browser did not let us read the clipboard. Touch and hold in the box, then choose Paste.' : 'Your browser did not let us read the clipboard. Click in the box and press Ctrl+V (or ⌘+V).');
    input.focus();
    return;
  }
  const found = detect(text, { ownHost: location.host });
  input.value = text.trim().slice(0, 2000);
  describe(input.value);
  if (!found) {
    if (text.trim()) say('warn', 'What is on the clipboard does not look like a link to a photo or a web page.');
    else say('info', 'The clipboard is empty. Copy a link first.');
    return;
  }
  // a paste, so the same question as anywhere else
  const address = found.url;
  const result = await startImport({ text, found, onAccepted: () => (input.value = ''), onCropped: ({ blob, source, action }) => action && remember(address, blob, source) });
  if (result.status !== 'sent') describe(input.value);
});

// ---- a photo from the device: the button, or dropped on the card
const card = $('card');
$('file').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (file) startImport({ file });
});
for (const name of ['dragenter', 'dragover']) {
  card.addEventListener(name, (event) => {
    event.preventDefault();
    card.classList.add('is-over');
  });
}
card.addEventListener('dragleave', (event) => {
  if (!card.contains(event.relatedTarget)) card.classList.remove('is-over');
});
card.addEventListener('drop', (event) => {
  event.preventDefault();
  card.classList.remove('is-over');
  const file = [...(event.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/') || /\.(?:heic|heif)$/i.test(f.name));
  if (file) return startImport({ file });
  const text = event.dataTransfer?.getData('text/uri-list') || event.dataTransfer?.getData('text/plain') || '';
  const found = detect(text, { ownHost: location.host });
  if (found) {
    input.value = text.trim().slice(0, 2000);
    describe(input.value);
    return startImport({ text, found, onAccepted: () => (input.value = '') });
  }
  say('warn', 'Drop a photo, or a link to one.');
  return undefined;
});

// ---- the sites list, and whether importing from links works on this server at all
$('sites').replaceChildren(...supportedSites().map((site) => h('li', { text: site.label })), h('li', { class: 'any', text: 'Any photo link' }), h('li', { class: 'any', text: 'Any web page' }));
importStatus()
  .then((status) => {
    if (status.ready) return;
    const box = $('status');
    box.textContent = status.enabled ? 'Importing from links is not set up on this server yet. You can still upload a photo.' : 'Importing from links is switched off. You can still upload a photo.';
    box.hidden = false;
  })
  .catch(() => {});
renderRecent();

// ---- a photo moved here from another page (the phone-capture panel, /brand/capture.js): the one-time code in the address names a picture kept
// in this browser (handoff.js); it is taken out, deleted from the browser, and opened for cropping like any photo the person chose.
(async function receive() {
  const params = new URLSearchParams(location.search);
  const code = params.get('import');
  if (!code) return;
  params.delete('import'); // a single-use code must not stay in the address bar or the history
  const rest = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
  if (!ID_PATTERN.test(code)) return;
  let record = null;
  try {
    record = await take(code);
  } catch {
    return; // the browser would not keep it, or it was already taken
  }
  if (!record) return;
  const name = typeof record.meta.name === 'string' && /^[\w .-]{1,80}$/.test(record.meta.name) ? record.meta.name : 'photo.jpg';
  startImport({ file: new File([record.blob], name, { type: record.blob.type || 'image/jpeg', lastModified: Date.now() }) });
})();
