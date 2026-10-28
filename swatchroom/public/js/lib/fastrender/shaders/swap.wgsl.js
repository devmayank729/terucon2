// WebGPU shader for the instant material-swap compositor. See swap.glsl.js for the WebGL2 version of exactly the same
// algorithm and for the full explanation (resolution decoupling, the joint bilateral edge, the homography, the shading
// normalisation and the highlight). Keep the two in sync.
//
// This canvas is a transparent, premultiplied-alpha OVERLAY stacked on top of the original photo <img> (see device.js,
// renderer.js) - it never reads or redraws the photo itself. Untouched pixels are fully transparent (alpha 0); the photo
// underneath shows through via ordinary browser compositing, not a manual blend in this shader.
//
// Colour space: materialTex is an rgba8unorm-srgb texture, so sampling it returns an already-linear colour; that is
// multiplied by the room's light (linear) and added to the highlight (linear), then explicitly re-encoded to sRGB before
// output. Output is premultiplied (rgb already multiplied by alpha), matching the context's alphaMode.
export const SWAP_WGSL = /* wgsl */ `
struct Globals {
  sceneWidth: f32,
  sceneHeight: f32,
  canvasWidth: f32,
  canvasHeight: f32,
  regionCount: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> globals: Globals;
// per region, 5 vec4s:
//   0: H row 0 (x,y,z), invTileWidthM        1: H row 1 (x,y,z), invTileHeightM     2: H row 2 (x,y,z), materialLayer
//   3: cosRot, sinRot, active, medianShading 4: exposure, specStrength, _, _
@group(0) @binding(1) var<uniform> regionData: array<vec4<f32>, 80>;
@group(0) @binding(2) var labelTex: texture_2d<u32>;
@group(0) @binding(3) var depthTex: texture_2d<f32>;
@group(0) @binding(4) var shadingTex: texture_2d<f32>;
@group(0) @binding(5) var alphaTex: texture_2d<f32>;
@group(0) @binding(6) var materialTex: texture_2d_array<f32>;
@group(0) @binding(7) var materialSampler: sampler;
@group(0) @binding(8) var residualTex: texture_2d<f32>;
@group(0) @binding(9) var lumaTex: texture_2d<f32>;

const TRANSPARENT = vec4<f32>(0.0, 0.0, 0.0, 0.0);
const SHADING_MIN = 0.35;
const SHADING_MAX = 1.65;
const LUMA_SIGMA = 0.07;

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
  // One oversized triangle covering the viewport - no vertex buffer needed.
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  return vec4<f32>(positions[vertexIndex], 0.0, 1.0);
}

fn linearToSrgbChannel(c: f32) -> f32 {
  if (c <= 0.0031308) {
    return c * 12.92;
  }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

fn clampTexel(p: vec2<i32>) -> vec2<i32> {
  let limit = vec2<i32>(i32(globals.sceneWidth) - 1, i32(globals.sceneHeight) - 1);
  return clamp(p, vec2<i32>(0, 0), limit);
}

// Bilinear read of a scan-resolution float texture at sp (scan pixels, texel centres at +0.5).
fn bilinear(tex: texture_2d<f32>, sp: vec2<f32>) -> f32 {
  let q = sp - vec2<f32>(0.5, 0.5);
  let f = fract(q);
  let i = vec2<i32>(floor(q));
  let a = textureLoad(tex, clampTexel(i), 0).r;
  let b = textureLoad(tex, clampTexel(i + vec2<i32>(1, 0)), 0).r;
  let c = textureLoad(tex, clampTexel(i + vec2<i32>(0, 1)), 0).r;
  let d = textureLoad(tex, clampTexel(i + vec2<i32>(1, 1)), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// 5-tap joint bilateral filter of the selection mask, guided by the photo's brightness.
fn edgeAlpha(sp: vec2<f32>) -> f32 {
  let centreLuma = bilinear(lumaTex, sp);
  var weightSum = 0.0;
  var alphaSum = 0.0;
  for (var k = 0; k < 5; k = k + 1) {
    var offset = vec2<f32>(0.0, 0.0);
    if (k == 1) { offset = vec2<f32>(1.0, 0.0); }
    if (k == 2) { offset = vec2<f32>(-1.0, 0.0); }
    if (k == 3) { offset = vec2<f32>(0.0, 1.0); }
    if (k == 4) { offset = vec2<f32>(0.0, -1.0); }
    let p = sp + offset;
    let dl = bilinear(lumaTex, p) - centreLuma;
    var tap = 0.6;
    if (k == 0) { tap = 1.0; }
    let w = tap * exp(-(dl * dl) / (2.0 * LUMA_SIGMA * LUMA_SIGMA));
    weightSum = weightSum + w;
    alphaSum = alphaSum + w * bilinear(alphaTex, p);
  }
  return alphaSum / weightSum;
}

struct Tile {
  uv: vec2<f32>,
  ok: bool,
};

// The surface's own coordinates (metres, rotated by the finish's rotation, in tile units) for scan position sp.
fn tileUv(sp: vec2<f32>, r0: vec4<f32>, r1: vec4<f32>, r2: vec4<f32>, r3: vec4<f32>) -> Tile {
  let h = vec3<f32>(sp, 1.0);
  let w = dot(r2.xyz, h);
  var result: Tile;
  result.ok = abs(w) > 1e-7;
  var divisor = 1.0;
  if (result.ok) { divisor = w; }
  let metres = vec2<f32>(dot(r0.xyz, h), dot(r1.xyz, h)) / divisor;
  let rotatedU = metres.x * r3.x - metres.y * r3.y;
  let rotatedV = metres.x * r3.y + metres.y * r3.x;
  result.uv = vec2<f32>(rotatedU * r0.w, rotatedV * r1.w);
  return result;
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  // WebGPU's fragCoord already has (0,0) at the top-left, like every texture here
  let canvasSize = vec2<f32>(globals.canvasWidth, globals.canvasHeight);
  let sceneSize = vec2<f32>(globals.sceneWidth, globals.sceneHeight);
  let sp = fragCoord.xy / canvasSize * sceneSize; // position in scan pixels

  let centre = clampTexel(vec2<i32>(floor(sp)));
  let labelId = i32(textureLoad(labelTex, centre, 0).r);
  if (labelId <= 0 || labelId > i32(globals.regionCount)) {
    return TRANSPARENT;
  }
  let base = (labelId - 1) * 5;
  let r0 = regionData[base];
  let r1 = regionData[base + 1];
  let r2 = regionData[base + 2];
  let r3 = regionData[base + 3];
  let r4 = regionData[base + 4];
  if (r3.z < 0.5) {
    return TRANSPARENT; // no finish on this region right now
  }
  if (textureLoad(depthTex, centre, 0).r <= 0.0) {
    return TRANSPARENT; // the geometry had no usable depth here (mirror, glass)
  }

  // cheap early-out far from the selection: no alpha at the pixel or at its four neighbours
  let nearAlpha = textureLoad(alphaTex, centre, 0).r
    + textureLoad(alphaTex, clampTexel(centre + vec2<i32>(1, 0)), 0).r
    + textureLoad(alphaTex, clampTexel(centre + vec2<i32>(-1, 0)), 0).r
    + textureLoad(alphaTex, clampTexel(centre + vec2<i32>(0, 1)), 0).r
    + textureLoad(alphaTex, clampTexel(centre + vec2<i32>(0, -1)), 0).r;
  if (nearAlpha <= 0.0) {
    return TRANSPARENT;
  }
  let alpha = edgeAlpha(sp);
  if (alpha <= 0.004) {
    return TRANSPARENT;
  }

  let here = tileUv(sp, r0, r1, r2, r3);
  if (!here.ok) {
    return TRANSPARENT;
  }
  // how far the texture moves across one canvas pixel: the same mapping one pixel to the right and one down
  let scanPerPixel = sceneSize / canvasSize;
  let right = tileUv(sp + vec2<f32>(scanPerPixel.x, 0.0), r0, r1, r2, r3);
  let below = tileUv(sp + vec2<f32>(0.0, scanPerPixel.y), r0, r1, r2, r3);
  var duvdx = vec2<f32>(0.0, 0.0);
  var duvdy = vec2<f32>(0.0, 0.0);
  if (right.ok) { duvdx = right.uv - here.uv; }
  if (below.ok) { duvdy = below.uv - here.uv; }

  let layer = i32(floor(r2.w + 0.5));
  let material = textureSampleGrad(materialTex, materialSampler, here.uv, layer, duvdx, duvdy).rgb;

  // the room's light: Marigold's shading relative to this surface's own median, clamped, times the exposure the photo shows
  let shading = bilinear(shadingTex, sp);
  let lightScale = clamp(shading / max(r3.w, 1e-4), SHADING_MIN, SHADING_MAX) * r4.x;
  // a highlight where the photo shows a specular reflection (Marigold's residual layer)
  let residual = bilinear(residualTex, sp);
  let highlight = r4.y * smoothstep(0.25, 0.8, residual);

  let lit = material * lightScale + vec3<f32>(highlight, highlight, highlight);
  let litSrgb = vec3<f32>(
    linearToSrgbChannel(lit.x),
    linearToSrgbChannel(lit.y),
    linearToSrgbChannel(lit.z),
  );
  return vec4<f32>(litSrgb * alpha, alpha);
}
`;
