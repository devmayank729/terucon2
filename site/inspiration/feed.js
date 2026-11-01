/**
 * Runs on the Design Studio page. If the address says ?import=<code>, a picture the person cropped is waiting in this browser
 * (handoff.js): wait for the studio's own photo input, put the picture into it and tell it so, exactly as if the person had chosen the
 * file. The studio then does everything it does for any photo; this file knows nothing else about it.
 */
import { ID_PATTERN, take } from './handoff.js';

const SELECTOR = 'input[data-input="photo"]';
// long enough for a studio that asks for its passcode first (STUDIO_REQUIRE_PASSCODE=on): the input appears once it is typed
const WAIT_MS = 5 * 60 * 1000;

function waitForInput() {
  return new Promise((resolve) => {
    const now = document.querySelector(SELECTOR);
    if (now) return resolve(now);
    const watcher = new MutationObserver(() => {
      const found = document.querySelector(SELECTOR);
      if (!found) return;
      watcher.disconnect();
      clearTimeout(timer);
      resolve(found);
    });
    watcher.observe(document.documentElement, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      watcher.disconnect();
      resolve(null);
    }, WAIT_MS);
  });
}

async function feed() {
  const params = new URLSearchParams(location.search);
  const id = params.get('import');
  if (!id) return;
  // the code is single use and must not stay in the address bar or the history
  params.delete('import');
  const rest = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
  if (!ID_PATTERN.test(id)) return;
  let record = null;
  try {
    record = await take(id);
  } catch {
    return;
  }
  if (!record) return;
  const input = await waitForInput();
  if (!input) return;
  const type = record.blob.type || 'image/jpeg';
  const name = typeof record.meta.name === 'string' && /^[\w .-]{1,80}$/.test(record.meta.name) ? record.meta.name : 'inspiration.jpg';
  const transfer = new DataTransfer();
  transfer.items.add(new File([record.blob], name, { type, lastModified: Date.now() }));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

feed();
