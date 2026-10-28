// WebGL2 backend for the instant material-swap compositor. See webgpu.js for the WebGPU twin (same interface -
// renderer.js is the only thing that picks which one to use) and shaders/swap.glsl.js for the per-pixel algorithm.
import { SWAP_FRAGMENT_GLSL, SWAP_VERTEX_GLSL } from "./shaders/swap.glsl.js";

export const MAX_REGIONS = 16;
const VEC4S_PER_REGION = 5; // see shaders/swap.glsl.js's u_regionData layout
const FLOATS_PER_REGION = VEC4S_PER_REGION * 4;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error("Fast renderer: shader compile failed - " + info);
  }
  return shader;
}

function linkProgram(gl, vertexSource, fragmentSource) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error("Fast renderer: program link failed - " + info);
  }
  return program;
}

// Integer/float single-channel textures, NEAREST-only: integer formats cannot be filtered at all, and 32-bit float
// textures are not filterable on most phones without an extension, so the shader interpolates by hand from texelFetch().
function createDataTexture(gl, internalFormat, format, type, width, height, data) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, data);
  return texture;
}

export function createWebGL2Backend(gl) {
  const program = linkProgram(gl, SWAP_VERTEX_GLSL, SWAP_FRAGMENT_GLSL);
  const vao = gl.createVertexArray(); // no attributes bound - the shader uses gl_VertexID
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); // a 16-bit label row of odd width is not a multiple of 4 bytes

  const uniforms = {
    sizes: gl.getUniformLocation(program, "u_sizes"),
    regionCount: gl.getUniformLocation(program, "u_regionCount"),
    regionData: gl.getUniformLocation(program, "u_regionData"),
    labelTex: gl.getUniformLocation(program, "u_labelTex"),
    depthTex: gl.getUniformLocation(program, "u_depthTex"),
    shadingTex: gl.getUniformLocation(program, "u_shadingTex"),
    alphaTex: gl.getUniformLocation(program, "u_alphaTex"),
    materialTex: gl.getUniformLocation(program, "u_materialTex"),
    residualTex: gl.getUniformLocation(program, "u_residualTex"),
    lumaTex: gl.getUniformLocation(program, "u_lumaTex"),
  };

  let width = 0;
  let height = 0;
  let regionCount = 0;
  const regionData = new Float32Array(MAX_REGIONS * FLOATS_PER_REGION);

  let labelTexture = null;
  let depthTexture = null;
  let shadingTexture = null;
  let residualTexture = null;
  let alphaTexture = null;
  let lumaTexture = null;
  let materialArray = null;
  let materialTileWidth = 0;
  let materialTileHeight = 0;

  function disposeSceneTextures() {
    [labelTexture, depthTexture, shadingTexture, residualTexture, alphaTexture, lumaTexture].forEach(function (texture) {
      if (texture) {
        gl.deleteTexture(texture);
      }
    });
  }

  // scene: {width, height, labelMap: Uint16Array, depth, shading, residual, luma: Float32Array}, all at width x height.
  // Called once per photo version (or rescan); cheap compared to a render, but not meant to run every frame.
  function uploadScene(scene) {
    disposeSceneTextures();
    width = scene.width;
    height = scene.height;
    labelTexture = createDataTexture(gl, gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT, width, height, scene.labelMap);
    depthTexture = createDataTexture(gl, gl.R32F, gl.RED, gl.FLOAT, width, height, scene.depth);
    shadingTexture = createDataTexture(gl, gl.R32F, gl.RED, gl.FLOAT, width, height, scene.shading);
    residualTexture = createDataTexture(gl, gl.R32F, gl.RED, gl.FLOAT, width, height, scene.residual);
    lumaTexture = createDataTexture(gl, gl.R32F, gl.RED, gl.FLOAT, width, height, scene.luma);
    alphaTexture = createDataTexture(gl, gl.R32F, gl.RED, gl.FLOAT, width, height, new Float32Array(width * height));
  }

  // Replaces only the label map (a surface's outline was refined, or the scan was swapped for the HD one): the depth,
  // shading and luma layers stay where they are.
  function setLabels(labelMap) {
    if (!labelTexture) {
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, labelTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED_INTEGER, gl.UNSIGNED_SHORT, labelMap);
  }

  // The "which pixels may be painted" map (1 inside the selected surface, 0 elsewhere).
  function setAlpha(alpha) {
    if (!alphaTexture) {
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, alphaTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.FLOAT, alpha);
  }

  // regions: [{h: [9] (scan px -> metres), invTileWidthM, invTileHeightM, cosRot, sinRot, materialLayer, active,
  //            medianShading, exposure, specStrength}, ...]; index i is label i+1 in the label map. Cheap (nothing is
  // uploaded until render()); call it on every selection / material change.
  function setRegions(regions) {
    regionCount = Math.min(regions.length, MAX_REGIONS);
    regionData.fill(0);
    for (let i = 0; i < regionCount; i += 1) {
      const r = regions[i];
      const b = i * FLOATS_PER_REGION;
      regionData[b + 0] = r.h[0];
      regionData[b + 1] = r.h[1];
      regionData[b + 2] = r.h[2];
      regionData[b + 3] = r.invTileWidthM;
      regionData[b + 4] = r.h[3];
      regionData[b + 5] = r.h[4];
      regionData[b + 6] = r.h[5];
      regionData[b + 7] = r.invTileHeightM;
      regionData[b + 8] = r.h[6];
      regionData[b + 9] = r.h[7];
      regionData[b + 10] = r.h[8];
      regionData[b + 11] = r.materialLayer;
      regionData[b + 12] = r.cosRot;
      regionData[b + 13] = r.sinRot;
      regionData[b + 14] = r.active ? 1 : 0;
      regionData[b + 15] = r.medianShading;
      regionData[b + 16] = r.exposure;
      regionData[b + 17] = r.specStrength;
    }
  }

  function ensureMaterialArray(tileWidth, tileHeight) {
    if (materialArray && materialTileWidth === tileWidth && materialTileHeight === tileHeight) {
      return;
    }
    if (materialArray) {
      gl.deleteTexture(materialArray);
    }
    materialTileWidth = tileWidth;
    materialTileHeight = tileHeight;
    const levels = Math.floor(Math.log2(Math.max(tileWidth, tileHeight))) + 1;
    materialArray = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, materialArray);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.SRGB8_ALPHA8, tileWidth, tileHeight, MAX_REGIONS);
  }

  // imageSource: anything texSubImage3D accepts (ImageBitmap, canvas...), already resized to tileWidth x tileHeight by
  // the caller (renderer.js) - every layer of one array must share one size. The mip chain is rebuilt so the far end of a
  // floor is filtered instead of shimmering.
  function setMaterialLayer(layerIndex, imageSource, tileWidth, tileHeight) {
    ensureMaterialArray(tileWidth, tileHeight);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, materialArray);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY, 0, 0, 0, layerIndex, tileWidth, tileHeight, 1, gl.RGBA, gl.UNSIGNED_BYTE, imageSource,
    );
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  }

  function render() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!labelTexture || !materialArray || regionCount === 0) {
      return;
    }

    gl.enable(gl.BLEND);
    // The shader's output is already premultiplied by its own alpha.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(program);
    gl.bindVertexArray(vao);

    gl.uniform4f(uniforms.sizes, width, height, gl.canvas.width, gl.canvas.height);
    gl.uniform1f(uniforms.regionCount, regionCount);
    gl.uniform4fv(uniforms.regionData, regionData);

    const bindings = [
      [uniforms.labelTex, labelTexture, gl.TEXTURE_2D],
      [uniforms.depthTex, depthTexture, gl.TEXTURE_2D],
      [uniforms.shadingTex, shadingTexture, gl.TEXTURE_2D],
      [uniforms.alphaTex, alphaTexture, gl.TEXTURE_2D],
      [uniforms.materialTex, materialArray, gl.TEXTURE_2D_ARRAY],
      [uniforms.residualTex, residualTexture, gl.TEXTURE_2D],
      [uniforms.lumaTex, lumaTexture, gl.TEXTURE_2D],
    ];
    bindings.forEach(function (entry, unit) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(entry[2], entry[1]);
      gl.uniform1i(entry[0], unit);
    });

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  function readPixelsAsBlob(mimeType, quality) {
    return new Promise(function (resolve) {
      gl.canvas.toBlob(resolve, mimeType, quality);
    });
  }

  function destroy() {
    disposeSceneTextures();
    if (materialArray) {
      gl.deleteTexture(materialArray);
    }
    gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
  }

  return {
    kind: "webgl2",
    maxRegions: MAX_REGIONS,
    uploadScene: uploadScene,
    setLabels: setLabels,
    setAlpha: setAlpha,
    setRegions: setRegions,
    setMaterialLayer: setMaterialLayer,
    render: render,
    readPixelsAsBlob: readPixelsAsBlob,
    destroy: destroy,
  };
}
