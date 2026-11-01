/**
 * What a downloaded file really is, decided from its first bytes and never from what the other server said it was.
 *
 * A picture is accepted only when it starts like a JPEG, PNG, GIF, WebP or AVIF file. The type we send on is the one found here, so a
 * page cannot hand us HTML or SVG (which can carry scripts) under an image's name. The size in pixels is read from the header too,
 * so a small file that unpacks to a huge picture (a "decompression bomb") is refused before a browser is asked to open it.
 * Nothing is decoded or re-encoded here.
 */

/** The most pixels we pass on. The studio itself shrinks a photo to 4096 pixels on the long side; 64 million is 8000 x 8000. */
export const MAX_PIXELS = 64_000_000;
export const MAX_SIDE = 20000;

const be16 = (b, i) => (b[i] << 8) | b[i + 1];
const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const le16 = (b, i) => b[i] | (b[i + 1] << 8);
const le24 = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

/** JPEG: walk the markers to the first "start of frame", which holds the size. */
function jpegSize(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = be16(b, i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: be16(b, i + 5), width: be16(b, i + 7) };
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

function webpSize(b) {
  const kind = b.toString('latin1', 12, 16);
  if (kind === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  if (kind === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    return { width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
  }
  if (kind === 'VP8X' && b.length >= 30) return { width: 1 + le24(b, 24), height: 1 + le24(b, 27) };
  return null;
}

/** AVIF keeps its size in an "ispe" box near the start. */
function avifSize(b) {
  const at = b.subarray(0, Math.min(b.length, 65536)).indexOf('ispe', 0, 'latin1');
  if (at === -1 || at + 16 > b.length) return null;
  return { width: be32(b, at + 8), height: be32(b, at + 12) };
}

/**
 * @param {Buffer} b the start of the file (the first 64 KB is enough for every format here; more is fine)
 * @returns {{type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/avif', width: number | null, height: number | null} | null}
 *   null when it is not a picture we take
 */
export function sniffImage(b) {
  if (!Buffer.isBuffer(b) || b.length < 12) return null;
  let found = null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) found = { type: 'image/jpeg', ...(jpegSize(b) ?? {}) };
  else if (b[0] === 0x89 && b.toString('latin1', 1, 8) === 'PNG\r\n\x1a\n') found = { type: 'image/png', ...(b.length >= 24 ? { width: be32(b, 16), height: be32(b, 20) } : {}) };
  else if (b.toString('latin1', 0, 6) === 'GIF87a' || b.toString('latin1', 0, 6) === 'GIF89a') found = { type: 'image/gif', ...(b.length >= 10 ? { width: le16(b, 6), height: le16(b, 8) } : {}) };
  else if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') found = { type: 'image/webp', ...(webpSize(b) ?? {}) };
  else if (b.toString('latin1', 4, 8) === 'ftyp' && /^(?:avif|avis)/.test(b.toString('latin1', 8, 12))) found = { type: 'image/avif', ...(avifSize(b) ?? {}) };
  if (!found) return null;
  return { type: found.type, width: found.width || null, height: found.height || null };
}

/** Whether a picture's size is within what we pass on. A size we could not read is allowed here; the byte limit still applies. */
export function sizeAllowed({ width, height }) {
  if (!width || !height) return true;
  return width <= MAX_SIDE && height <= MAX_SIDE && width * height <= MAX_PIXELS;
}
