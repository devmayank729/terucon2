// What stands in front of a wall, floor or ceiling. A rug on the floor, a sofa against the wall, a picture hung on it, a
// plant, a window or a door in it: their pixels are not part of the surface behind, so neither the instant preview nor the
// AI render may paint the new finish over them.
//
// The scan often drew the surface right across such an object (a rug the scene model did not set apart, a picture frame
// too small to become a region of its own). SAM 3's instance masks (the SAM layer) say where the objects really are;
// carveOccluders() takes those pixels out of the surface's mask as holes. It is applied when a surface is calibrated
// (samCalibrate.js), so the holes live in the scan itself: the outline drawn on the photo, the preview and the AI render's
// mask all agree.
import { countSet, dilate } from "./morph.js";

// Kinds that stand in front of a surface (SAM prompts, server/lib/remoteModels/sam3.js SCENE_PROMPTS).
export const OCCLUDER_KINDS = ["rug", "furniture", "window", "door", "plant", "picture frame", "light fixture"];
export const MIN_OCCLUDER_SCORE = 0.5;
// An object counts as being IN a surface if at least this share of the object's own pixels lie on it (a sofa seen against
// a wall overlaps it; a lamp on the far side of the room that merely shares a bounding box does not).
const MIN_OVERLAP_OF_OBJECT = 0.25;
// Objects are grown by this much before they are cut out: the mask edge sits ON the silhouette, the pixel beside it is
// still the object's shadow / edge.
const GROW = 1;

// -> the instances that overlap `mask` enough to be standing on / in it, with score and kind ok.
export function occludersFor(mask, layer, width, height) {
  if (!layer) {
    return [];
  }
  return layer.instances.filter(function (instance) {
    if (OCCLUDER_KINDS.indexOf(instance.kind) === -1 || instance.score < MIN_OCCLUDER_SCORE) {
      return false;
    }
    let inside = 0;
    for (let i = 0; i < mask.length; i += 1) {
      if (mask[i] && instance.mask[i]) {
        inside += 1;
      }
    }
    return instance.area > 0 && inside / instance.area >= MIN_OVERLAP_OF_OBJECT && inside >= 12;
  });
}

// -> { mask, removed } : `mask` without the occluders' pixels (never deletes more than maxShare of the surface: a "sofa"
// SAM thinks covers the whole wall is SAM being wrong, not a wall hidden entirely).
export function carveOccluders(mask, layer, width, height, maxShare) {
  const occluders = occludersFor(mask, layer, width, height);
  if (occluders.length === 0) {
    return { mask: mask, removed: 0, occluders: [] };
  }
  const union = new Uint8Array(mask.length);
  occluders.forEach(function (instance) {
    for (let i = 0; i < union.length; i += 1) {
      if (instance.mask[i]) {
        union[i] = 1;
      }
    }
  });
  const cut = dilate(union, width, height, GROW);
  const out = new Uint8Array(mask.length);
  let removed = 0;
  for (let i = 0; i < out.length; i += 1) {
    if (mask[i] && cut[i]) {
      removed += 1;
    } else {
      out[i] = mask[i];
    }
  }
  const before = countSet(mask);
  if (before === 0 || removed > before * (maxShare || 0.6)) {
    return { mask: mask, removed: 0, occluders: [] };
  }
  return { mask: out, removed: removed, occluders: occluders };
}
