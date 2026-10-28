// WebGL2 (GLSL ES 300) twin of swap.wgsl.js - the exact same algorithm, for browsers without WebGPU. Keep the two in
// sync; this file carries the full explanation.
//
// WHAT IT DRAWS. A transparent overlay, stacked on the photo, that is opaque only over the one selected surface and shows
// the chosen finish there: the finish's texture laid on the surface's plane (so tiles shrink with distance and follow
// the room's perspective), multiplied by the room's own light (so shadows and window falloff stay), with a highlight where
// the photo shows a specular reflection.
//
// RESOLUTION. The canvas is as big as the screen needs (renderer sizing.js: frame width x devicePixelRatio, at most
// 2048 px), NOT the size of the 1024 px scan. Every scan-resolution texture (labels, depth, shading, residual, alpha,
// luma) is therefore read through the pixel's position in scan coordinates, sp = fragCoord / canvasSize * sceneSize:
//   labels  nearest (they are ids),   shading / residual / alpha / luma  bilinear, done by hand from four texelFetch()es
//   because 32-bit float textures are not filterable on most phones without an extension.
//
// EDGES. The selection is a binary mask at scan resolution; drawn naively on a 3x screen it is a staircase of 3 px steps.
// The mask is smoothed with a 5-tap JOINT BILATERAL filter: the centre and four neighbours one scan pixel away are averaged,
// each weighted by how close its photo brightness is to the centre's. Across a real edge in the photo (skirting board,
// ceiling cove, door frame) the weights collapse, so the mask edge snaps to that edge and is anti-aliased along it; across
// flat paint it simply blurs by a fraction of a scan pixel.
//
// UV. Each region has a 3x3 homography H (scan pixels -> metres on the surface), from the fitted plane or, before the room
// has been analysed, from the outline's four corners. Rows are packed in u_regionData; see renderer.js / geometry.js.
// The texture is read with explicit gradients (the same homography, one canvas pixel to the right and one down) from a
// mip-mapped array, so the far end of a floor is filtered down to its average like in any renderer instead of shimmering.

export const SWAP_VERTEX_GLSL = /* glsl */ `#version 300 es
void main() {
  // One oversized triangle covering the viewport - no vertex buffer needed.
  vec2 positions[3] = vec2[3](
    vec2(-1.0, -1.0),
    vec2(3.0, -1.0),
    vec2(-1.0, 3.0)
  );
  gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
}
`;

export const SWAP_FRAGMENT_GLSL = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp usampler2D;

uniform vec4 u_sizes;      // sceneWidth, sceneHeight, canvasWidth, canvasHeight
uniform float u_regionCount;
// per region, 5 vec4s:
//   0: H row 0 (x,y,z), invTileWidthM        1: H row 1 (x,y,z), invTileHeightM     2: H row 2 (x,y,z), materialLayer
//   3: cosRot, sinRot, active, medianShading 4: exposure, specStrength, _, _
uniform vec4 u_regionData[80];

uniform usampler2D u_labelTex;
uniform sampler2D u_depthTex;
uniform sampler2D u_shadingTex;
uniform sampler2D u_residualTex;
uniform sampler2D u_alphaTex;
uniform sampler2D u_lumaTex;
uniform sampler2DArray u_materialTex;

out vec4 fragColor;

const float SHADING_MIN = 0.35;
const float SHADING_MAX = 1.65;
const float LUMA_SIGMA = 0.07;

float linearToSrgbChannel(float c) {
  if (c <= 0.0031308) {
    return c * 12.92;
  }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

ivec2 clampTexel(ivec2 p) {
  return clamp(p, ivec2(0), ivec2(u_sizes.xy) - 1);
}

// Bilinear read of a scan-resolution float texture at sp (scan pixels, texel centres at +0.5).
float bilinear(sampler2D tex, vec2 sp) {
  vec2 q = sp - 0.5;
  vec2 f = fract(q);
  ivec2 i = ivec2(floor(q));
  float a = texelFetch(tex, clampTexel(i), 0).r;
  float b = texelFetch(tex, clampTexel(i + ivec2(1, 0)), 0).r;
  float c = texelFetch(tex, clampTexel(i + ivec2(0, 1)), 0).r;
  float d = texelFetch(tex, clampTexel(i + ivec2(1, 1)), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// 5-tap joint bilateral filter of the selection mask, guided by the photo's brightness.
float edgeAlpha(vec2 sp) {
  float centreLuma = bilinear(u_lumaTex, sp);
  float weightSum = 0.0;
  float alphaSum = 0.0;
  for (int k = 0; k < 5; k++) {
    vec2 offset = vec2(0.0);
    if (k == 1) offset = vec2(1.0, 0.0);
    if (k == 2) offset = vec2(-1.0, 0.0);
    if (k == 3) offset = vec2(0.0, 1.0);
    if (k == 4) offset = vec2(0.0, -1.0);
    vec2 p = sp + offset;
    float dl = bilinear(u_lumaTex, p) - centreLuma;
    float w = (k == 0 ? 1.0 : 0.6) * exp(-(dl * dl) / (2.0 * LUMA_SIGMA * LUMA_SIGMA));
    weightSum += w;
    alphaSum += w * bilinear(u_alphaTex, p);
  }
  return alphaSum / weightSum;
}

// The surface's own coordinates (metres, rotated by the finish's rotation, in tile units) for scan position sp.
vec2 tileUv(vec2 sp, vec4 r0, vec4 r1, vec4 r2, vec4 r3, out bool ok) {
  float w = dot(r2.xyz, vec3(sp, 1.0));
  ok = abs(w) > 1e-7;
  vec2 metres = vec2(dot(r0.xyz, vec3(sp, 1.0)), dot(r1.xyz, vec3(sp, 1.0))) / (ok ? w : 1.0);
  float rotatedU = metres.x * r3.x - metres.y * r3.y;
  float rotatedV = metres.x * r3.y + metres.y * r3.x;
  return vec2(rotatedU * r0.w, rotatedV * r1.w);
}

void main() {
  // gl_FragCoord has (0,0) at the BOTTOM-left; every texture here is in image-row order (0,0 top-left), so flip once.
  vec2 canvasSize = u_sizes.zw;
  vec2 frag = vec2(gl_FragCoord.x, canvasSize.y - gl_FragCoord.y);
  vec2 sp = frag / canvasSize * u_sizes.xy; // position in scan pixels

  ivec2 centre = clampTexel(ivec2(floor(sp)));
  int labelId = int(texelFetch(u_labelTex, centre, 0).r);
  if (labelId <= 0 || labelId > int(u_regionCount)) {
    fragColor = vec4(0.0);
    return;
  }
  int base = (labelId - 1) * 5;
  vec4 r0 = u_regionData[base];
  vec4 r1 = u_regionData[base + 1];
  vec4 r2 = u_regionData[base + 2];
  vec4 r3 = u_regionData[base + 3];
  vec4 r4 = u_regionData[base + 4];
  if (r3.z < 0.5) {
    fragColor = vec4(0.0); // no finish on this region right now
    return;
  }
  if (texelFetch(u_depthTex, centre, 0).r <= 0.0) {
    fragColor = vec4(0.0); // the geometry had no usable depth here (mirror, glass)
    return;
  }

  // cheap early-out far from the selection: no alpha at the pixel or at its four neighbours
  float nearAlpha = texelFetch(u_alphaTex, centre, 0).r
    + texelFetch(u_alphaTex, clampTexel(centre + ivec2(1, 0)), 0).r
    + texelFetch(u_alphaTex, clampTexel(centre + ivec2(-1, 0)), 0).r
    + texelFetch(u_alphaTex, clampTexel(centre + ivec2(0, 1)), 0).r
    + texelFetch(u_alphaTex, clampTexel(centre + ivec2(0, -1)), 0).r;
  if (nearAlpha <= 0.0) {
    fragColor = vec4(0.0);
    return;
  }
  float alpha = edgeAlpha(sp);
  if (alpha <= 0.004) {
    fragColor = vec4(0.0);
    return;
  }

  bool ok;
  vec2 uv = tileUv(sp, r0, r1, r2, r3, ok);
  if (!ok) {
    fragColor = vec4(0.0);
    return;
  }
  // how far the texture moves across one canvas pixel: the same mapping one pixel to the right and one down
  vec2 scanPerPixel = u_sizes.xy / canvasSize;
  bool okx;
  bool oky;
  vec2 duvdx = tileUv(sp + vec2(scanPerPixel.x, 0.0), r0, r1, r2, r3, okx) - uv;
  vec2 duvdy = tileUv(sp + vec2(0.0, scanPerPixel.y), r0, r1, r2, r3, oky) - uv;
  if (!okx) duvdx = vec2(0.0);
  if (!oky) duvdy = vec2(0.0);

  float layer = floor(r2.w + 0.5);
  vec3 material = textureGrad(u_materialTex, vec3(uv, layer), duvdx, duvdy).rgb;

  // the room's light: Marigold's shading relative to this surface's own median, clamped, times the exposure the photo shows
  float shading = bilinear(u_shadingTex, sp);
  float lightScale = clamp(shading / max(r3.w, 1e-4), SHADING_MIN, SHADING_MAX) * r4.x;
  // a highlight where the photo shows a specular reflection (Marigold's residual layer)
  float residual = bilinear(u_residualTex, sp);
  float highlight = r4.y * smoothstep(0.25, 0.8, residual);

  vec3 lit = material * lightScale + vec3(highlight);
  vec3 litSrgb = vec3(
    linearToSrgbChannel(lit.x),
    linearToSrgbChannel(lit.y),
    linearToSrgbChannel(lit.z)
  );
  fragColor = vec4(litSrgb * alpha, alpha);
}
`;
