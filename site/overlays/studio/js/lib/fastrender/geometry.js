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
export const SHADING_MIN = 0.2; // DRAFT: was 0.35 / 1.65 - the clamp flattened sun-to-shade contrast
export const SHADING_MAX = 2.5;
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
  // DRAFT: exponent 0.35 -> 0.6 and the clamp 0.7..1.25 -> 0.45..1.5, so a dim room can darken a bright finish far enough
  return Math.min(1.5, Math.max(0.45, Math.pow(medianPhotoLinear / EXPOSURE_REFERENCE, 0.6)));
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
  const lr = new Float32Array(256);
  for (let v = 0; v < 256; v += 1) {
    lr[v] = srgbToLinear(v);
  }
  // DRAFT: also the colour of the room's light, as linear RGB scaled to luminance 1 ("gray world": the mean colour of the photo),
  // clamped to 0.55..1.7 per channel. The renderer applies only part of it (TINT_STRENGTH): the photo's mean colour mixes the
  // light with the colour of its biggest surfaces, so a room that is mostly one strong colour would be tinted wrongly.
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let i = 0, o = 0; i < luma.length; i += 1, o += 4) {
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    luma[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    linear[i] = 0.2126 * lr[r] + 0.7152 * lr[g] + 0.0722 * lr[b];
    sr += lr[r];
    sg += lr[g];
    sb += lr[b];
  }
  const y = 0.2126 * sr + 0.7152 * sg + 0.0722 * sb;
  const clampTint = (v) => Math.min(1.7, Math.max(0.55, v));
  const tint = y > 0 ? [clampTint(sr / y), clampTint(sg / y), clampTint(sb / y)] : [1, 1, 1];
  return { luma: luma, linear: linear, tint: tint };
}

// How shiny a finish should look. The catalogue has no gloss field, only words, so the finish's own description decides:
// polished, glazed or glossy things catch the room's reflections, matte and chalky ones must not. The value scales the
// highlight the photo's specular residual adds (shaders/swap.glsl.js).
export const SPECULAR_GLOSSY = 0.4;
export const SPECULAR_DEFAULT = 0.12;
export const SPECULAR_MATTE = 0.03;
// A finish that states its own sheen (the catalogue designs: Gemini's reading of the design's photograph, as one of these five
// words) is not guessed from its description. The description of a catalogue design always mentions the surface's relief too
// ("The surface is flat and smooth"), and "flat" is one of the matte words below: a glossy design with a flat relief read as matte.
const SPECULAR_BY_SHEEN = {
  matte: SPECULAR_MATTE,
  satin: SPECULAR_DEFAULT,
  "semi-gloss": (SPECULAR_DEFAULT + SPECULAR_GLOSSY) / 2,
  gloss: SPECULAR_GLOSSY,
  metallic: SPECULAR_GLOSSY,
};
export function specularFor(item) {
  if (!item) {
    return SPECULAR_DEFAULT;
  }
  const sheen = item.texture && typeof item.texture.sheen === "string" ? item.texture.sheen : "";
  if (Object.prototype.hasOwnProperty.call(SPECULAR_BY_SHEEN, sheen)) {
    return SPECULAR_BY_SHEEN[sheen];
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

// ---------------------------------------------------------------- a texture's size on the wall
// The real-world size of one tile, in metres, as the preview must repeat it. The studio's own textures state it as
// texture.tileWidthM / tileHeightM, and the studio's AI brief QUOTES those two numbers to the render model ("Tile repeat scale
// must match 1.2 m x 0.84 m", swatchroom/public/js/lib/prompts.js). A finish whose size nobody measured (the catalogue designs:
// a photograph of a sheet, no size on record) therefore states its guess as previewTileWidthM / previewTileHeightM instead, which
// only the preview reads, so the guess never reaches the render model as a fact.
// -> { width, height } or null when the finish states no usable size
export function tileSizeOf(item) {
  const texture = item && item.texture;
  if (!texture) {
    return null;
  }
  const width = Number(texture.tileWidthM) || Number(texture.previewTileWidthM);
  const height = Number(texture.tileHeightM) || Number(texture.previewTileHeightM);
  return width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height) ? { width: width, height: height } : null;
}

// The part of a picture that fills a tile of the shared size (dstW x dstH) with no distortion: the largest window of the tile's
// proportions, in the picture's centre ("cover"). The studio's own textures are the tile's proportions already (10:7), so for
// them this is the whole picture and nothing changes; a photograph of a sheet is portrait (the catalogue's are 800 x 1220), and
// stretching that into a landscape tile squashed every vein and every grain line to a little over half its height.
// -> { sx, sy, sw, sh } in the picture's pixels
export function textureCrop(srcW, srcH, dstW, dstH) {
  const want = dstW / dstH;
  const have = srcW / srcH;
  if (!(srcW > 0 && srcH > 0 && dstW > 0 && dstH > 0) || Math.abs(have - want) < 1e-3) {
    return { sx: 0, sy: 0, sw: srcW, sh: srcH };
  }
  if (have > want) {
    const sw = Math.round(srcH * want);
    return { sx: Math.round((srcW - sw) / 2), sy: 0, sw: sw, sh: srcH };
  }
  const sh = Math.round(srcW / want);
  return { sx: 0, sy: Math.round((srcH - sh) / 2), sw: srcW, sh: sh };
}

// ---------------------------------------------------------------- preparing a photograph of a sheet as a repeating tile
// The studio's own textures are illustrated swatches made to repeat. A catalogue design's texture is a PHOTOGRAPH of a sheet (the website's
// pictures live under /media/), and a photograph is not made to repeat: its tone drifts across the sheet (lighting, vignetting), so every tile
// border is a step in brightness, and the seam repair (renderer.js makeSeamless) turned that step into a dark, blurred grid over the whole wall
// (seen on the teak and the marble, 2026-11-05). Mirroring the tile hides the step but makes a kaleidoscope of a veined marble, so it is not used.
export function isPhotographUrl(url) {
  const path = String(url || "").split(/[?#]/)[0];
  return /(^|\/)media\//.test(path);
}

// Removes the slow brightness drift: each colour channel minus its own very blurred version plus its mean, so the average colour of the design is
// kept and everything finer than about RADIUS x 2.5 pixels (veins, grain, knots, mottling) is left as it was. Three box passes (a close
// approximation of a Gaussian) whose edges are MIRRORED: a wrap-around blur would see the far end of a brightness ramp next to its start and
// leave the ramp's two ends exactly as far apart as they were, which is the step that has to go. In place on RGBA bytes; alpha is not touched.
export const FLATTEN_RADIUS = 40;
// A design with BOLD features (Gemini's scale "large": broad veins, wide bands, big patches, 8 of the 63) would lose them to a radius of 40: the
// website asks for a wider one in the picture's address (?tone=100). tone=0 skips the step. Seen on the white marble SB830 and the slate-blue SB8001.
export function toneRadiusOf(url) {
  const found = /[?&]tone=(\d{1,3})(?:&|#|$)/.exec(String(url || ""));
  return found ? Math.min(200, Number(found[1])) : FLATTEN_RADIUS;
}
const mirrored = (i, n) => (i < 0 ? -i - 1 : i >= n ? 2 * n - i - 1 : i);
function boxBlurMirrored(source, width, height, radius) {
  const temp = new Float32Array(source.length);
  const out = new Float32Array(source.length);
  const span = 2 * radius + 1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let k = -radius; k <= radius; k += 1) {
      sum += source[row + mirrored(k, width)];
    }
    for (let x = 0; x < width; x += 1) {
      temp[row + x] = sum / span;
      sum += source[row + mirrored(x + radius + 1, width)] - source[row + mirrored(x - radius, width)];
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let k = -radius; k <= radius; k += 1) {
      sum += temp[mirrored(k, height) * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = sum / span;
      sum += temp[mirrored(y + radius + 1, height) * width + x] - temp[mirrored(y - radius, height) * width + x];
    }
  }
  return out;
}
export function flattenTone(rgba, width, height, radius) {
  const r = Math.max(1, Math.min(Math.round(radius || FLATTEN_RADIUS), (Math.min(width, height) >> 1) - 1));
  const count = width * height;
  for (let channel = 0; channel < 3; channel += 1) {
    const plane = new Float32Array(count);
    let mean = 0;
    for (let i = 0; i < count; i += 1) {
      plane[i] = rgba[i * 4 + channel];
      mean += plane[i];
    }
    mean /= count;
    let blurred = plane;
    for (let pass = 0; pass < 3; pass += 1) {
      blurred = boxBlurMirrored(blurred, width, height, r);
    }
    for (let i = 0; i < count; i += 1) {
      rgba[i * 4 + channel] = Math.max(0, Math.min(255, Math.round(plane[i] - (blurred[i] - mean))));
    }
  }
  return rgba;
}
