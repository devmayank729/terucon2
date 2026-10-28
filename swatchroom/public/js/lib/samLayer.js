// Reads the SAM layer the room pipeline stored for a photo version (server/lib/samLayer.js writes it): SAM 3's instance
// masks for wall, floor, ceiling, rug, window, door, furniture and a few things hung on or standing against them, on the
// scan's own pixel grid. Format (after gzip): "SAM1", uint32 header length, header JSON, then one bit-packed mask per instance.

export function parseSamLayer(raw) {
  if (!raw || raw.length < 8 || String.fromCharCode(raw[0], raw[1], raw[2], raw[3]) !== "SAM1") {
    throw new Error("That is not a SAM layer file.");
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const headerLength = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + headerLength)));
  const bytesPer = Math.ceil((header.width * header.height) / 8);
  let offset = 8 + headerLength;
  const instances = header.instances.map(function (entry) {
    const mask = new Uint8Array(header.width * header.height);
    for (let i = 0; i < mask.length; i += 1) {
      mask[i] = (raw[offset + (i >> 3)] >> (i & 7)) & 1;
    }
    offset += bytesPer;
    return Object.assign({}, entry, { mask: mask });
  });
  return { width: header.width, height: header.height, instances: instances };
}

export function instancesOfKind(layer, kind) {
  return layer ? layer.instances.filter((instance) => instance.kind === kind) : [];
}
