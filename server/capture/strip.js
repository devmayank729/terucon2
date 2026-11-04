/**
 * Take the hidden personal data out of a photo before it is stored: the camera's EXIF block (which holds the GPS position of
 * the phone, its make and model, and often the owner's name), XMP and text blocks. The picture itself is not decoded or
 * re-encoded: only the blocks around it are left out, so no pixel changes and no image library is needed.
 *
 * The phone page already draws every photo again through a canvas, which drops all of this. This is the second layer, for the
 * photo the page could not redraw (a format the browser cannot decode) and for anyone who calls the upload route without the page.
 * The location a person chooses to share is the one the "Use my location" button reads, nothing else.
 *
 * Returns null when the file is not well formed (cut short, a block that runs past the end, no start or end): the upload is then
 * refused instead of storing something nobody can open.
 */

// ---- JPEG: keep JFIF (APP0), the colour profile (APP2) and Adobe's colour flag (APP14); drop Exif/XMP (APP1), the other APPn and comments.
const KEEP_JPEG_APP = new Set([0xe0, 0xe2, 0xee]);

function stripJpeg(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const parts = [b.subarray(0, 2)];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1];
    while (marker === 0xff && i + 2 < b.length) {
      i += 1; // fill bytes
      marker = b[i + 1];
    }
    if (marker === undefined) return null;
    if (marker === 0xd9) {
      parts.push(b.subarray(i, i + 2));
      return Buffer.concat(parts);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      parts.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > b.length) return null;
    const length = (b[i + 2] << 8) | b[i + 3];
    if (length < 2 || i + 2 + length > b.length) return null;
    const end = i + 2 + length;
    if (marker === 0xda) {
      // Start of scan: the compressed picture follows, byte for byte, up to the first real end marker. Inside compressed data every
      // 0xFF is followed by 0x00 or a restart marker, so the first FF D9 is the end of the picture. Whatever comes after it (some
      // phones append a video or a thumbnail to a photo) is not kept.
      const eoi = b.indexOf(Buffer.from([0xff, 0xd9]), end);
      if (eoi === -1) return null;
      parts.push(b.subarray(i, eoi + 2));
      return Buffer.concat(parts);
    }
    const isApp = marker >= 0xe0 && marker <= 0xef;
    if (!((isApp && !KEEP_JPEG_APP.has(marker)) || marker === 0xfe)) parts.push(b.subarray(i, end));
    i = end;
  }
  return null;
}

// ---- PNG: drop eXIf and the text blocks (tEXt, zTXt, iTXt) and the time stamp (tIME).
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function stripPng(b) {
  if (b.length < 33 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const parts = [b.subarray(0, 8)];
  let i = 8;
  let first = true;
  while (i + 12 <= b.length) {
    const length = b.readUInt32BE(i);
    const type = b.toString('latin1', i + 4, i + 8);
    const end = i + 12 + length;
    if (length > 0x7fffffff || end > b.length || !/^[A-Za-z]{4}$/.test(type)) return null;
    if (first && type !== 'IHDR') return null;
    first = false;
    if (!PNG_DROP.has(type)) parts.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') return i === b.length ? Buffer.concat(parts) : null;
  }
  return null;
}

// ---- WebP: a RIFF file. Drop the EXIF and XMP chunks and clear their two flags in the VP8X header.
function stripWebp(b) {
  if (b.length < 20 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const riffSize = b.readUInt32LE(4);
  if (riffSize + 8 !== b.length && riffSize + 9 !== b.length) return null;
  const chunks = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = b.toString('latin1', i, i + 4);
    const size = b.readUInt32LE(i + 4);
    const padded = size + (size & 1);
    const end = i + 8 + padded;
    if (end > b.length + 1 || i + 8 + size > b.length) return null;
    if (type !== 'EXIF' && type !== 'XMP ') {
      const chunk = Buffer.from(b.subarray(i, Math.min(end, b.length)));
      if (type === 'VP8X') {
        if (size < 10) return null;
        chunk[8] &= ~(0x08 | 0x04); // the EXIF and XMP flags
      }
      chunks.push(chunk.length === 8 + padded ? chunk : Buffer.concat([chunk, Buffer.alloc(8 + padded - chunk.length)]));
    }
    i = end;
  }
  if (!chunks.length) return null;
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

/** @param {Buffer} bytes @param {'image/jpeg' | 'image/png' | 'image/webp'} type @returns {Buffer | null} */
export function stripMetadata(bytes, type) {
  if (!Buffer.isBuffer(bytes)) return null;
  if (type === 'image/jpeg') return stripJpeg(bytes);
  if (type === 'image/png') return stripPng(bytes);
  if (type === 'image/webp') return stripWebp(bytes);
  return null;
}
