// Parses a .npy buffer (NumPy's own array format - what's inside every entry of the .npz
// files MoGe-2's /v1/geometry returns, see server/lib/remoteModels/moge2.js). Format (versions
// 1.0 and 2.0, the only ones numpy's own writer produces):
//   bytes 0-5   magic "\x93NUMPY"
//   byte  6     major version
//   byte  7     minor version
//   v1.0: bytes 8-9 header length (uint16 LE); v2.0+: bytes 8-11 (uint32 LE)
//   header      an ASCII Python-dict literal, e.g. "{'descr': '<f4', 'fortran_order': False,
//               'shape': (480, 640, 3), }", space-padded so the data starts 64-byte aligned
//   data        raw bytes, C order (row-major) unless fortran_order is true
const DTYPES = {
  "<f4": Float32Array,
  "<f8": Float64Array,
  "<i4": Int32Array,
  "<i8": BigInt64Array,
  "<u4": Uint32Array,
  "|u1": Uint8Array,
  "|i1": Int8Array,
  "|b1": Uint8Array, // numpy bool: 1 byte, 0 or 1 - truthy checks work the same as on a real bool
};

function parseHeader(text) {
  const descrMatch = /'descr':\s*'([^']+)'/.exec(text);
  const fortranMatch = /'fortran_order':\s*(True|False)/.exec(text);
  const shapeMatch = /'shape':\s*\(([^)]*)\)/.exec(text);
  if (!descrMatch || !fortranMatch || !shapeMatch) {
    throw new Error("Not a recognizable .npy header: " + text.slice(0, 120));
  }
  const shape = shapeMatch[1]
    .split(",")
    .map(function (part) {
      return part.trim();
    })
    .filter(function (part) {
      return part.length > 0;
    })
    .map(Number);
  return {
    descr: descrMatch[1],
    fortranOrder: fortranMatch[1] === "True",
    shape: shape,
  };
}

// buffer: a Node Buffer or Uint8Array holding exactly one .npy file's bytes.
// Returns {dtype, shape, data: <TypedArray>}. "data" is always the real numpy dtype's natural
// TypedArray (Float32Array for '<f4', Uint8Array for a bool mask, ...) - callers that just need
// truthiness (a validity mask) or numeric values (depth, intrinsics) work the same either way.
function parseNpy(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const magic = String.fromCharCode.apply(null, bytes.subarray(1, 6));
  if (bytes[0] !== 0x93 || magic !== "NUMPY") {
    throw new Error("Not an .npy file (bad magic bytes).");
  }
  const majorVersion = bytes[6];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let headerLen;
  let headerStart;
  if (majorVersion === 1) {
    headerLen = view.getUint16(8, true);
    headerStart = 10;
  } else {
    headerLen = view.getUint32(8, true);
    headerStart = 12;
  }
  const headerText = String.fromCharCode.apply(
    null,
    bytes.subarray(headerStart, headerStart + headerLen),
  );
  const header = parseHeader(headerText);
  if (header.fortranOrder) {
    // Every array this project's own request shapes come back as C order; a Fortran-order
    // array would need a transpose this function does not implement - fail loudly rather than
    // silently hand back transposed data.
    throw new Error("Fortran-ordered .npy arrays are not supported.");
  }
  const Ctor = DTYPES[header.descr];
  if (!Ctor) {
    throw new Error("Unsupported .npy dtype: " + header.descr);
  }
  const dataStart = headerStart + headerLen;
  const count = header.shape.reduce(function (a, b) {
    return a * b;
  }, 1);
  const dataBytes = bytes.subarray(dataStart, dataStart + count * Ctor.BYTES_PER_ELEMENT);
  // Copy (not a view) so the returned array survives independently of the larger zip-extracted
  // buffer it came from, and so its byteOffset is guaranteed aligned for the TypedArray ctor.
  const copy = new Uint8Array(dataBytes.length);
  copy.set(dataBytes);
  return {
    dtype: header.descr,
    shape: header.shape,
    data: new Ctor(copy.buffer),
  };
}

module.exports = { parseNpy: parseNpy };
