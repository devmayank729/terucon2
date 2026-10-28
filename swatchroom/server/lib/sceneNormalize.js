// Turns a per-pixel ADE20K class map from any engine into the one shape the browser's scene worker reads, the shape
// python/app.py's /scene/segment has always sent:
//   classMap    Uint8Array[width*height]   0 = no class, otherwise 1 + the index of the pixel's class in classLabels
//   classLabels string[]                   the names of the classes that occur, SegFormer's spelling
// so scene.worker.js consumes the local SegFormer-B5 and Modal's OneFormer interchangeably.
//
// OneFormer's ids are the same 150 ADE20K classes in the same order but ten names are spelled differently
// (server/lib/ade20k.js), and the worker groups classes by name: ids go through that table, never through the names the
// model server happens to send.
const zlib = require("zlib");
const { ADE20K_NAMES } = require("./ade20k");

const CLASS_COUNT = ADE20K_NAMES.length;

// labelMap: Uint8Array of ADE20K ids (0..149). Ids outside that range count as "no class".
function toSceneSchema(labelMap) {
  const present = new Uint8Array(CLASS_COUNT);
  for (let i = 0; i < labelMap.length; i += 1) {
    const id = labelMap[i];
    if (id < CLASS_COUNT) {
      present[id] = 1;
    }
  }
  const classIds = [];
  const compact = new Uint8Array(CLASS_COUNT);
  for (let id = 0; id < CLASS_COUNT; id += 1) {
    if (present[id]) {
      classIds.push(id);
      compact[id] = classIds.length; // 1-based, like the Python service
    }
  }
  const classMap = new Uint8Array(labelMap.length);
  for (let i = 0; i < labelMap.length; i += 1) {
    const id = labelMap[i];
    classMap[i] = id < CLASS_COUNT ? compact[id] : 0;
  }
  return {
    classMap: classMap,
    classIds: classIds,
    classLabels: classIds.map(function (id) {
      return ADE20K_NAMES[id];
    }),
  };
}

// The "thing" instances of a panoptic segmentation, one id per object: a pixel of a door, a window or a piece of
// furniture carries the id of THAT door, window or sofa, so two sofas side by side stay two surfaces; every "stuff"
// pixel (wall, floor, sky...) is 0. segmentMap: Uint8Array of panoptic segment ids (0 = void).
function thingInstanceMap(segmentMap, segments) {
  const isThing = new Uint8Array(256);
  segments.forEach(function (segment) {
    if (segment.isThing && segment.id > 0 && segment.id < 256) {
      isThing[segment.id] = 1;
    }
  });
  const out = new Uint8Array(segmentMap.length);
  for (let i = 0; i < segmentMap.length; i += 1) {
    out[i] = isThing[segmentMap[i]] ? segmentMap[i] : 0;
  }
  return out;
}

// gzip + base64 of raw bytes, python/app.py's pack(), which the browser unpacks with core/api.js's unpackBytes().
function packBytes(array) {
  return zlib
    .gzipSync(Buffer.from(array.buffer, array.byteOffset, array.byteLength), { level: 6 })
    .toString("base64");
}

module.exports = {
  CLASS_COUNT: CLASS_COUNT,
  toSceneSchema: toSceneSchema,
  thingInstanceMap: thingInstanceMap,
  packBytes: packBytes,
};
