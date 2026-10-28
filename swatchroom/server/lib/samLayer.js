// SAM 3's instance masks for one photo, kept. The room pipeline used to read them once, turn them into a score per
// region and throw the pixels away; now they are stored next to the depth and shading layers (one small gzip file per
// photo version) so that everything that benefits from a precise outline can use them WITHOUT another call to Modal:
//   - Stage B fits each plane on the part of a region SAM agrees with, rugs and furniture left out (pipelineRunner.js)
//   - a wall that SAM sees as two instances at different angles is proposed as two planes (planeSplit.js)
//   - the browser carves rugs, furniture, windows and doors out of the wall / floor they stand on (occlusion.js)
//   - tapping a surface snaps its edges to the matching instance (samCalibrate.js)
//
// A layer is { width, height, instances: [{ id, kind, label, score, box:[x0,y0,x1,y1], area, mask: Uint8Array }] } on
// the scan's own pixel grid. Instances of different kinds overlap (a rug lies inside the floor instance), so they are
// stored one mask each, not as a label map.
//
// File format (before gzip): "SAM1", uint32 header length, header JSON (width, height, instances without masks),
// then one bit-packed mask per instance (row-major, bit 0 = least significant), ceil(width*height/8) bytes each.
// public/js/lib/samLayer.js reads the same bytes in the browser.
const zlib = require("zlib");
const resample = require("./resample");

const MAGIC = "SAM1";
const MIN_SCORE = 0.35;
// An instance smaller than this share of the photo is dust, not a surface or an obstruction.
const MIN_AREA_SHARE = 0.0015;
const MAX_PER_KIND = {
  wall: 8,
  floor: 3,
  ceiling: 3,
  rug: 4,
  window: 8,
  door: 6,
  furniture: 10,
  plant: 6,
  "picture frame": 8,
  "light fixture": 6,
};

function boxAndArea(mask, width, height) {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  let area = 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (mask[row + x]) {
        area += 1;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { area: area, box: area ? [x0, y0, x1 + 1, y1 + 1] : [0, 0, 0, 0] };
}

// detections: sam3.normalize()'s [{kind, label, score, mask}] at srcWidth x srcHeight -> a layer at the scan's grid.
function build(detections, srcWidth, srcHeight, width, height) {
  const kept = {};
  const instances = [];
  (detections || [])
    .filter(function (detection) {
      return detection.score >= MIN_SCORE && MAX_PER_KIND[detection.kind];
    })
    .sort(function (a, b) {
      return b.score - a.score;
    })
    .forEach(function (detection) {
      const count = kept[detection.kind] || 0;
      if (count >= MAX_PER_KIND[detection.kind]) {
        return;
      }
      const mask = resample.resampleNearest(detection.mask, srcWidth, srcHeight, width, height, Uint8Array);
      const stats = boxAndArea(mask, width, height);
      if (stats.area < width * height * MIN_AREA_SHARE) {
        return;
      }
      kept[detection.kind] = count + 1;
      instances.push({
        id: detection.kind + "-" + (count + 1),
        kind: detection.kind,
        label: detection.label || detection.kind,
        score: detection.score,
        box: stats.box,
        area: stats.area,
        mask: mask,
      });
    });
  return { width: width, height: height, instances: instances };
}

function pack(layer) {
  const bytesPer = Math.ceil((layer.width * layer.height) / 8);
  const header = Buffer.from(
    JSON.stringify({
      width: layer.width,
      height: layer.height,
      instances: layer.instances.map(function (instance) {
        return {
          id: instance.id,
          kind: instance.kind,
          label: instance.label,
          score: Math.round(instance.score * 1000) / 1000,
          box: instance.box,
          area: instance.area,
        };
      }),
    }),
    "utf8",
  );
  const lengthBytes = Buffer.alloc(4);
  lengthBytes.writeUInt32LE(header.length, 0);
  const masks = Buffer.alloc(bytesPer * layer.instances.length);
  layer.instances.forEach(function (instance, index) {
    const base = index * bytesPer;
    for (let i = 0; i < instance.mask.length; i += 1) {
      if (instance.mask[i]) {
        masks[base + (i >> 3)] |= 1 << (i & 7);
      }
    }
  });
  return zlib.gzipSync(Buffer.concat([Buffer.from(MAGIC, "ascii"), lengthBytes, header, masks]), { level: 6 });
}

function unpack(gzipped) {
  const raw = zlib.gunzipSync(gzipped);
  if (raw.length < 8 || raw.toString("ascii", 0, 4) !== MAGIC) {
    throw new Error("That is not a SAM layer file.");
  }
  const headerLength = raw.readUInt32LE(4);
  const header = JSON.parse(raw.toString("utf8", 8, 8 + headerLength));
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

function ofKind(layer, kind) {
  return layer ? layer.instances.filter((instance) => instance.kind === kind) : [];
}

module.exports = {
  build: build,
  pack: pack,
  unpack: unpack,
  ofKind: ofKind,
  boxAndArea: boxAndArea,
  MIN_SCORE: MIN_SCORE,
};
