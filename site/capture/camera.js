/**
 * The camera inside the page. Opens the phone's camera as a live picture in this page (getUserMedia), takes as many photos as the person
 * wants, and gives each one back as a JPEG. The person is never sent to the phone's camera app: a phone that is short of memory can throw a
 * heavy page away while that app is in front, and then the photo never arrives. Here the page stays in front the whole time.
 *
 * Cannot be used: a page that is not on https (browsers allow the camera only there, and on localhost), a browser inside another app that does
 * not allow it, permission refused, no camera, a camera another app is using. `openCamera` then resolves with {ok: false, reason, message} and
 * the page offers the gallery picker instead. Nothing is guessed: the reason is the browser's own error name.
 */
import { h } from '/inspiration/assets/dom.js';

const MESSAGES = {
  insecure: 'The camera only works on a secure (https) address. You can still choose photos from your gallery.',
  unsupported: 'This browser cannot open the camera from a web page (some apps’ built-in browsers cannot). Open this link in Chrome or Safari, or choose photos from your gallery.',
  denied: 'The camera is blocked for this page. Allow the camera in your browser’s site settings and try again, or choose photos from your gallery.',
  missing: 'No camera was found on this device. You can choose photos from your gallery.',
  busy: 'The camera is being used by another app. Close it and try again, or choose photos from your gallery.',
  other: 'The camera could not be started. You can choose photos from your gallery.',
};

const failure = (reason) => ({ ok: false, reason, message: MESSAGES[reason] ?? MESSAGES.other });

/** The reason for a getUserMedia error, from its name. */
export function reasonFor(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'missing';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'busy';
    default:
      return 'other';
  }
}

async function getStream(facing) {
  const tries = [{ video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }, { video: true, audio: false }];
  let last;
  for (const constraints of tries) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      last = error;
      if (reasonFor(error) === 'denied') break;
    }
  }
  throw last;
}

/**
 * @param {object} options
 * @param {(blob: Blob) => Promise<void> | void} options.onShot called with each photo (a JPEG Blob)
 * @param {() => number} options.room how many more photos the link takes, so the camera can say so
 * @returns {Promise<{ok: true, close: () => void, closed: Promise<void>} | {ok: false, reason: string, message: string}>}
 */
export async function openCamera({ onShot, room }) {
  if (!globalThis.isSecureContext) return failure('insecure');
  if (!navigator.mediaDevices?.getUserMedia) return failure('unsupported');
  let facing = 'environment';
  let stream;
  try {
    stream = await getStream(facing);
  } catch (error) {
    return failure(reasonFor(error));
  }

  const video = h('video', { playsinline: '', muted: '', autoplay: '', 'aria-label': 'Camera view' });
  video.muted = true;
  video.playsInline = true;
  const flash = h('div', { class: 'flash' });
  const count = h('span', { class: 'count', 'aria-live': 'polite' });
  const shutter = h('button', { type: 'button', class: 'shutter', 'aria-label': 'Take photo' });
  const flip = h('button', { type: 'button', class: 'btn' }, 'Flip');
  const done = h('button', { type: 'button', class: 'btn' }, 'Done');
  const note = h('div', { class: 'cam-top' });
  const root = h('div', { class: 'cam', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Camera' }, video, flash, note, h('div', { class: 'cam-bar' }, count, shutter, h('div', { class: 'row' }, flip, done)));
  document.body.append(root);
  document.documentElement.classList.add('cam-open');

  let closed = false;
  let taken = 0;
  let resolveClosed;
  const closedPromise = new Promise((resolve) => (resolveClosed = resolve));
  const stop = () => stream?.getTracks().forEach((track) => track.stop());
  const close = () => {
    if (closed) return;
    closed = true;
    stop();
    root.remove();
    document.documentElement.classList.remove('cam-open');
    document.removeEventListener('visibilitychange', onHidden);
    document.removeEventListener('keydown', onKey);
    resolveClosed();
  };
  // a phone that leaves the page takes the camera away; give it back to the system at once rather than hold it
  const onHidden = () => {
    if (document.hidden) close();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  document.addEventListener('visibilitychange', onHidden);
  document.addEventListener('keydown', onKey);

  const showCount = () => {
    count.textContent = taken ? `${taken} taken` : '';
    shutter.disabled = room() <= 0;
    note.replaceChildren(...(room() <= 0 ? [h('span', { class: 'notice' }, 'This link is full.')] : []));
  };
  const attach = async () => {
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      // autoplay refused: the picture starts at the first tap on the shutter, which counts as a gesture
    }
  };
  await attach();
  showCount();

  shutter.addEventListener('click', async () => {
    if (closed || room() <= 0 || !video.videoWidth) return;
    shutter.disabled = true;
    const scale = Math.min(1, 2560 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    flash.classList.remove('go');
    void flash.offsetWidth;
    flash.classList.add('go');
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    canvas.width = canvas.height = 0;
    if (blob) {
      taken += 1;
      try {
        await onShot(blob);
      } catch {
        // the page reports its own problems; the camera stays open
      }
    }
    showCount();
  });
  flip.addEventListener('click', async () => {
    facing = facing === 'environment' ? 'user' : 'environment';
    stop();
    try {
      stream = await getStream(facing);
      await attach();
    } catch (error) {
      note.replaceChildren(h('span', { class: 'notice bad' }, MESSAGES[reasonFor(error)]));
      close();
    }
  });
  done.addEventListener('click', close);
  shutter.focus();
  return { ok: true, close, closed: closedPromise };
}
