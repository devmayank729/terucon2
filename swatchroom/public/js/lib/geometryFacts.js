// What the room pipeline measured about ONE surface, in the terms a text brief can use: how big it is in metres, which way
// it faces, how far it is, what the camera's field of view is. The AI render used to know none of this (the 3D layers fed
// only the instant preview); with it Gemini is told the real scale of the tiles and the real convergence of the lines
// instead of guessing both from a flat photo. Pure, tested in tests/geometry.test.js.
import { planeHomography } from "./fastrender/geometry.js";

function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return 0;
  }
  const position = fraction * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.min(sorted.length - 1, low + 1);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

const round = (value, places) => Math.round(value * Math.pow(10, places)) / Math.pow(10, places);

// region: a scan region (mask, kind); fusionRegion: { plane: {origin, normal, u, v}, confidence } for it;
// intrinsics: {fx, fy, cx, cy} in scan pixels; scan: { width, height }.
// -> null when there is no measured plane (a provisional estimate is not a measurement), else
//    { widthM, heightM, normal: [nx, ny, nz], distanceM, fovDeg, focalPx (in scan pixels), orientation, confidence }
// widthM / heightM are the extent of the VISIBLE part of the surface along its two in-plane axes (2nd to 98th percentile,
// so a stray pixel does not stretch it): width/height for a wall, width/depth for a floor or ceiling.
export function surfaceGeometry(region, fusionRegion, intrinsics, scan) {
  if (!region || !fusionRegion || !fusionRegion.plane || fusionRegion.provisional || !intrinsics) {
    return null;
  }
  const plane = fusionRegion.plane;
  const h = planeHomography(plane, intrinsics);
  const us = [];
  const vs = [];
  const width = scan.width;
  const mask = region.mask;
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) {
      count += 1;
    }
  }
  if (count < 50) {
    return null;
  }
  const stride = Math.max(1, Math.floor(count / 4000));
  let seen = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) {
      continue;
    }
    if (seen % stride === 0) {
      const x = (i % width) + 0.5;
      const y = Math.floor(i / width) + 0.5;
      const w = h[6] * x + h[7] * y + h[8];
      if (Math.abs(w) > 1e-9) {
        us.push((h[0] * x + h[1] * y + h[2]) / w);
        vs.push((h[3] * x + h[4] * y + h[5]) / w);
      }
    }
    seen += 1;
  }
  if (us.length < 20) {
    return null;
  }
  us.sort((a, b) => a - b);
  vs.sort((a, b) => a - b);
  const widthM = percentile(us, 0.98) - percentile(us, 0.02);
  const heightM = percentile(vs, 0.98) - percentile(vs, 0.02);
  const n = plane.normal;
  const o = plane.origin;
  const distanceM = Math.abs(n[0] * o[0] + n[1] * o[1] + n[2] * o[2]);
  if (!(widthM > 0.05 && heightM > 0.05 && widthM < 60 && heightM < 60)) {
    return null; // a plane fit gone wrong: better to say nothing than to say nonsense
  }
  return {
    widthM: round(widthM, 2),
    heightM: round(heightM, 2),
    normal: [round(n[0], 2), round(n[1], 2), round(n[2], 2)],
    distanceM: round(distanceM, 1),
    fovDeg: round((2 * Math.atan(scan.width / (2 * intrinsics.fx)) * 180) / Math.PI, 0),
    focalPx: intrinsics.fx,
    orientation: region.kind === "floor" || region.kind === "ceiling" ? "deep" : "tall",
    confidence: fusionRegion.confidence,
  };
}

// The same facts for the image actually sent to the model: its focal length in ITS pixels. scale = pixels of the sent image
// per pixel of the scan (a crop is magnified; the whole photo is just resized).
export function geometryForImage(facts, scale, extra) {
  if (!facts) {
    return null;
  }
  return Object.assign({}, facts, {
    focalPxImage: Math.round(facts.focalPx * scale),
  }, extra || {});
}
