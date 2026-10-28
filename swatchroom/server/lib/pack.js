// Packs typed arrays as gzip-compressed raw bytes. No base64 here: unlike python/app.py's
// classMap/mask payloads (which travel embedded inside a JSON response, so they need base64),
// these are stored as plain files (GridFS/GCS, via server/lib/storage.js) and served as-is
// through the existing GET /api/rooms/:id/files/<name> route - the browser fetches the gzip
// bytes directly and inflates them (see public/js/core/api.js's unpackFloat32/unpackBytes).
const zlib = require("zlib");

function packFloat32(array) {
  const buffer = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  return zlib.gzipSync(buffer, { level: 6 });
}

function unpackFloat32(buffer) {
  const raw = zlib.gunzipSync(buffer);
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

// Same idea for uint8 data (region/label maps), matching python/app.py's pack() exactly.
function packUint8(array) {
  return zlib.gzipSync(Buffer.from(array.buffer, array.byteOffset, array.byteLength), {
    level: 6,
  });
}

function unpackUint8(buffer) {
  const raw = zlib.gunzipSync(buffer);
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

// A 0..1 float layer (shading, residual) as 16-bit integers: a sixth of the bytes of the float32 file once gzipped,
// which matters on a phone's connection, and 65535 steps are plenty for a smooth light field (8 bits would band in
// the shadows). public/js/core/api.js's unpackUnit16() reads it back.
function packUnit16(array) {
  const out = new Uint16Array(array.length);
  for (let i = 0; i < array.length; i += 1) {
    const value = array[i];
    out[i] = value <= 0 ? 0 : value >= 1 ? 65535 : Math.round(value * 65535);
  }
  return zlib.gzipSync(Buffer.from(out.buffer, out.byteOffset, out.byteLength), { level: 6 });
}

function unpackUnit16(buffer) {
  const raw = zlib.gunzipSync(buffer);
  const view = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const out = new Float32Array(view.length);
  for (let i = 0; i < view.length; i += 1) {
    out[i] = view[i] / 65535;
  }
  return out;
}

module.exports = {
  packFloat32: packFloat32,
  unpackFloat32: unpackFloat32,
  packUint8: packUint8,
  unpackUint8: unpackUint8,
  packUnit16: packUnit16,
  unpackUnit16: unpackUnit16,
};
