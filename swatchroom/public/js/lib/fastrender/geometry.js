// The maths behind the instant preview, kept out of the GPU code so it can be tested in plain Node.
//
// Every surface the preview paints is a plane, and a plane seen by a pinhole camera maps to the picture by a
// HOMOGRAPHY: m = H * [x, y, 1], (u, v) = (m.x / m.z, m.y / m.z) are the surface's own coordinates in metres for the
// picture point (x, y) in scan pixels. The shaders only ever evaluate that, whether H came from the plane MoGe-2's depth
// was fitted to (planeHomography) or was estimated from the outline of the surface alone (provisional.js).

// Camera convention (fusion.js): X right, Y down, Z forward; a picture point (x, y) in scan pixels is the ray
// r = ((x - cx) / fx, (y - cy) / fy, 1).
//
// plane: { origin, normal, u, v } in camera space (metres), as fusion.js stores it. The point where the ray meets the plane
// is X = r * (n.o) / (n.r), so  u = u.(X - o) = ((n.o)(u.r) - (u.o)(n.r)) / (n.r), the same for v, and w = n.r.
// Returns the three rows of H, 9 numbers, row-major: [Hu, Hv, Hw].
export function planeHomography(plane, intrinsics) {
  const { fx, fy, cx, cy } = intrinsics;
  const n = plane.normal;
  const o = plane.origin;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // a . r  written as a row over [x, y, 1]:  [a0/fx, a1/fy, a2 - a0*cx/fx - a1*cy/fy]
  const row = (a) => [a[0] / fx, a[1] / fy, a[2] - (a[0] * cx) / fx - (a[1] * cy) / fy];
  const rn = row(n);
  const ru = row(plane.u);
  const rv = row(plane.v);
  const no = dot(n, o);
  const uo = dot(plane.u, o);
  const vo = dot(plane.v, o);
  const hu = [0, 1, 2].map((i) => no * ru[i] - uo * rn[i]);
  const hv = [0, 1, 2].map((i) => no * rv[i] - vo * rn[i]);
  return hu.concat(hv, rn);
}

// -> [u, v] in metres, or null when the ray is parallel to the plane.
export function applyHomography(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  if (Math.abs(w) < 1e-9) {
    return null;
  }
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

// Median of values[i] over the pixels where mask[i] is set, looking at most `limit` of them (a stride through the mask,
// so a megapixel wall costs a few thousand reads). Zero or negative values are ignored. null when nothing qualifies.
export function maskedMedian(values, mask, limit) {
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) {
      count += 1;
    }
  }
  if (count === 0) {
    return null;
  }
  const stride = Math.max(1, Math.floor(count / (limit || 4000)));
  const picked = [];
  let seen = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) {
      continue;
    }
    if (seen % stride === 0 && values[i] > 0) {
      picked.push(values[i]);
    }
    seen += 1;
  }
  if (picked.length === 0) {
    return null;
  }
  picked.sort((a, b) => a - b);
  const middle = picked.length >> 1;
  return picked.length % 2 ? picked[middle] : (picked[middle - 1] + picked[middle]) / 2;
}

// The multiplier applied to Marigold's shading. Its shading is max-normalised by the server, so its absolute level means
// nothing; what it does carry is the pattern of light across the surface. Dividing by the surface's own median keeps that
// pattern around 1.0 (so the new finish keeps its catalogue brightness on average and still gets the room's light falloff
// and shadows), and the clamp keeps a deep shadow or a bright spot from turning the texture black or white.
export const SHADING_MIN = 0.35;
export const SHADING_MAX = 1.65;
export function normalisedShading(shading, median) {
  if (!(median > 0)) {
    return 1;
  }
  return Math.min(SHADING_MAX, Math.max(SHADING_MIN, shading / median));
}

// Marigold's absolute scale is lost, so the room's own exposure is read from the photo: a surface the photo shows dark
// stays a little darker than the catalogue sample, a sunlit one a little brighter. Gentle on purpose (an exponent of 0.35
// and a +-25-30% range): the photo's brightness mixes the OLD material's colour with the light.
export const EXPOSURE_REFERENCE = 0.3; // linear luminance of a mid-lit surface
export function exposureFor(medianPhotoLinear) {
  if (!(medianPhotoLinear > 0)) {
    return 1;
  }
  return Math.min(1.25, Math.max(0.7, Math.pow(medianPhotoLinear / EXPOSURE_REFERENCE, 0.35)));
}

// sRGB byte value (0..255) -> linear light 0..1
export function srgbToLinear(byte) {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Perceptual luma (0..1, what the eye compares across an edge) and linear luminance of an RGBA photo at scan size.
export function lumaFromRgba(rgba, width, height) {
  const luma = new Float32Array(width * height);
  const linear = new Float32Array(width * height);
  for (let i = 0, o = 0; i < luma.length; i += 1, o += 4) {
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    luma[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    linear[i] = 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
  }
  return { luma: luma, linear: linear };
}

// How shiny a finish should look. The catalogue has no gloss field, only words, so the finish's own description decides:
// polished, glazed or glossy things catch the room's reflections, matte and chalky ones must not. The value scales the
// highlight the photo's specular residual adds (shaders/swap.glsl.js).
export const SPECULAR_GLOSSY = 0.4;
export const SPECULAR_DEFAULT = 0.12;
export const SPECULAR_MATTE = 0.03;
export function specularFor(item) {
  if (!item) {
    return SPECULAR_DEFAULT;
  }
  const text = [item.name, item.sub, item.about, item.prompt].filter(Boolean).join(" ").toLowerCase();
  if (/\b(matte|chalk|limewash|flat|honed|brushed|unglazed|suede)\b/.test(text)) {
    return SPECULAR_MATTE;
  }
  if (/\b(gloss|glossy|polish|polished|glazed|glass|lacquer|satin|metallic|mirror|burnished|pearl)\b/.test(text)) {
    return SPECULAR_GLOSSY;
  }
  return SPECULAR_DEFAULT;
}
