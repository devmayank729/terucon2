/**
 * Make a photo ready to send: draw it again on a canvas at no more than 2560 pixels on the long side and save it as a JPEG of about a
 * megabyte, instead of the 8 to 12 MB a phone camera makes. Drawing it again also does two things on purpose: it turns the photo the right way
 * up (a phone stores it sideways and adds a note), and it leaves out everything hidden in the file (the camera's Exif block with the phone's
 * position, make and model). The only place a photo carries is the one the person chose with the location button.
 *
 * When the browser cannot read the file (a HEIC photo in Chrome, a damaged file) a JPEG, PNG or WebP that is small enough is sent as it is,
 * and the server takes the hidden data out (server/capture/strip.js); anything else is reported with words a person can act on.
 */
export const MAX_SIDE = 2560;
export const QUALITY = 0.85;

const HEIC = /\.(heic|heif)$/i;
const SENDABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

export class PhotoError extends Error {
  constructor(message, reason) {
    super(message);
    this.reason = reason;
  }
}

async function decode(blob) {
  if ('createImageBitmap' in globalThis) {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      try {
        return await createImageBitmap(blob); // an older browser that does not know the option
      } catch {
        // fall through to an <img>
      }
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * @param {Blob} source a File from the picker, or a Blob from the camera
 * @param {{maxBytes: number}} options the biggest photo the server takes
 * @returns {Promise<{blob: Blob, width: number | null, height: number | null, redrawn: boolean}>}
 */
export async function prepare(source, { maxBytes }) {
  const name = typeof source.name === 'string' ? source.name : '';
  let image;
  try {
    image = await decode(source);
  } catch {
    if (HEIC.test(name) || /hei[cf]/i.test(source.type)) throw new PhotoError('This browser cannot open HEIC photos. Use “Take photo” on this page, or change the camera setting to “Most Compatible”.', 'heic');
    if (SENDABLE.has(source.type) && source.size <= maxBytes) return { blob: source, width: null, height: null, redrawn: false };
    throw new PhotoError('That photo could not be opened. It may be damaged or in a format this browser cannot read.', 'unreadable');
  }
  const width = image.naturalWidth ?? image.width;
  const height = image.naturalHeight ?? image.height;
  if (!width || !height) throw new PhotoError('That photo could not be opened.', 'unreadable');
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d');
  if (!context) throw new PhotoError('This phone could not prepare the photo. Close other tabs and try again.', 'canvas');
  context.fillStyle = '#ffffff'; // a PNG with see-through parts becomes white, not black, in a JPEG
  context.fillRect(0, 0, w, h);
  context.drawImage(image, 0, 0, w, h);
  image.close?.();
  let blob = await toBlob(canvas, 'image/jpeg', QUALITY);
  if (blob && blob.size > maxBytes) blob = await toBlob(canvas, 'image/jpeg', 0.6);
  canvas.width = canvas.height = 0; // let go of the memory now: a phone has little
  if (!blob) throw new PhotoError('This phone could not prepare the photo. Close other tabs and try again.', 'canvas');
  if (blob.size > maxBytes) throw new PhotoError('That photo is still too large after it was made smaller.', 'too-large');
  return { blob, width: w, height: h, redrawn: true };
}
