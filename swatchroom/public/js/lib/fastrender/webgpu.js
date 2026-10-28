// WebGPU backend for the instant material-swap compositor. See webgl2.js for the WebGL2 twin (same interface -
// renderer.js is the only thing that picks which one to use) and shaders/swap.wgsl.js for the per-pixel algorithm.
import { SWAP_WGSL } from "./shaders/swap.wgsl.js";

export const MAX_REGIONS = 16;
const VEC4S_PER_REGION = 5; // see shaders/swap.wgsl.js's regionData layout
const FLOATS_PER_REGION = VEC4S_PER_REGION * 4;
const GLOBALS_FLOATS = 8; // sceneWidth, sceneHeight, canvasWidth, canvasHeight, regionCount, pad x3

// Mip levels are made by drawing each level from the one above it with a linear sampler. The target is an sRGB texture, so
// the averaging happens in linear light, like the WebGL2 backend's generateMipmap().
const MIP_WGSL = /* wgsl */ `
@group(0) @binding(0) var mipSampler: sampler;
@group(0) @binding(1) var mipSource: texture_2d<f32>;
struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let p = positions[index];
  var out: VertexOut;
  out.position = vec4<f32>(p, 0.0, 1.0);
  out.uv = vec2<f32>((p.x + 1.0) * 0.5, 1.0 - (p.y + 1.0) * 0.5);
  return out;
}
@fragment
fn fs(in: VertexOut) -> @location(0) vec4<f32> {
  return textureSample(mipSource, mipSampler, in.uv);
}
`;

function createDataTexture(device, format, width, height) {
  return device.createTexture({
    size: { width: width, height: height },
    format: format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
}

// Unlike copyBufferToTexture(), writeTexture()'s bytesPerRow has no 256-byte alignment requirement - it only has to be at
// least width * bytesPerPixel, so no manual row padding is needed here.
function writeData(device, texture, data, width, height, bytesPerPixel) {
  device.queue.writeTexture(
    { texture: texture },
    data,
    { bytesPerRow: width * bytesPerPixel, rowsPerImage: height },
    { width: width, height: height },
  );
}

export function createWebGPUBackend(device, context, format) {
  device.addEventListener("uncapturederror", function (event) {
    console.error("[webgpu uncaptured error]", event.error.message);
  });
  const module = device.createShaderModule({ code: SWAP_WGSL });

  const sampler = device.createSampler({
    addressModeU: "repeat",
    addressModeV: "repeat",
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
  });

  const globalsBuffer = device.createBuffer({
    size: GLOBALS_FLOATS * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const regionBuffer = device.createBuffer({
    size: MAX_REGIONS * FLOATS_PER_REGION * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  let width = 0;
  let height = 0;
  let regionCount = 0;
  const regionData = new Float32Array(MAX_REGIONS * FLOATS_PER_REGION);
  const globalsData = new Float32Array(GLOBALS_FLOATS);

  let labelTexture = null;
  let depthTexture = null;
  let shadingTexture = null;
  let residualTexture = null;
  let alphaTexture = null;
  let lumaTexture = null;
  let materialArray = null;
  let materialTileWidth = 0;
  let materialTileHeight = 0;
  let bindGroup = null;
  let pipeline = null;
  let mipPipeline = null;
  let mipSampler = null;

  function disposeSceneTextures() {
    [labelTexture, depthTexture, shadingTexture, residualTexture, alphaTexture, lumaTexture].forEach(function (texture) {
      if (texture) {
        texture.destroy();
      }
    });
  }

  function rebuildBindGroupIfReady() {
    if (
      !labelTexture || !depthTexture || !shadingTexture || !residualTexture || !alphaTexture || !lumaTexture || !materialArray
    ) {
      bindGroup = null;
      return;
    }
    bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalsBuffer } },
        { binding: 1, resource: { buffer: regionBuffer } },
        { binding: 2, resource: labelTexture.createView() },
        { binding: 3, resource: depthTexture.createView() },
        { binding: 4, resource: shadingTexture.createView() },
        { binding: 5, resource: alphaTexture.createView() },
        { binding: 6, resource: materialArray.createView({ dimension: "2d-array" }) },
        { binding: 7, resource: sampler },
        { binding: 8, resource: residualTexture.createView() },
        { binding: 9, resource: lumaTexture.createView() },
      ],
    });
  }

  pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: module, entryPoint: "vs_main" },
    fragment: {
      module: module,
      entryPoint: "fs_main",
      targets: [
        {
          format: format,
          blend: {
            // The shader's output is already premultiplied by its own alpha.
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });

  function writeGlobals() {
    globalsData[0] = width;
    globalsData[1] = height;
    globalsData[2] = context.canvas.width;
    globalsData[3] = context.canvas.height;
    globalsData[4] = regionCount;
    device.queue.writeBuffer(globalsBuffer, 0, globalsData);
  }

  // scene: {width, height, labelMap: Uint16Array, depth, shading, residual, luma: Float32Array}, all at width x height.
  function uploadScene(scene) {
    disposeSceneTextures();
    width = scene.width;
    height = scene.height;

    labelTexture = createDataTexture(device, "r16uint", width, height);
    depthTexture = createDataTexture(device, "r32float", width, height);
    shadingTexture = createDataTexture(device, "r32float", width, height);
    residualTexture = createDataTexture(device, "r32float", width, height);
    lumaTexture = createDataTexture(device, "r32float", width, height);
    alphaTexture = createDataTexture(device, "r32float", width, height);

    writeData(device, labelTexture, scene.labelMap, width, height, 2);
    writeData(device, depthTexture, scene.depth, width, height, 4);
    writeData(device, shadingTexture, scene.shading, width, height, 4);
    writeData(device, residualTexture, scene.residual, width, height, 4);
    writeData(device, lumaTexture, scene.luma, width, height, 4);
    writeData(device, alphaTexture, new Float32Array(width * height), width, height, 4);

    writeGlobals();
    rebuildBindGroupIfReady();
  }

  function setLabels(labelMap) {
    if (labelTexture) {
      writeData(device, labelTexture, labelMap, width, height, 2);
    }
  }

  function setAlpha(alpha) {
    if (!alphaTexture) {
      return;
    }
    writeData(device, alphaTexture, alpha, width, height, 4);
  }

  // regions: see webgl2.js's setRegions(); index i is label i+1 in the label map.
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
    device.queue.writeBuffer(regionBuffer, 0, regionData);
  }

  function ensureMaterialArray(tileWidth, tileHeight) {
    if (materialArray && materialTileWidth === tileWidth && materialTileHeight === tileHeight) {
      return;
    }
    if (materialArray) {
      materialArray.destroy();
    }
    materialTileWidth = tileWidth;
    materialTileHeight = tileHeight;
    materialArray = device.createTexture({
      size: { width: tileWidth, height: tileHeight, depthOrArrayLayers: MAX_REGIONS },
      format: "rgba8unorm-srgb",
      mipLevelCount: Math.floor(Math.log2(Math.max(tileWidth, tileHeight))) + 1,
      usage:
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    rebuildBindGroupIfReady();
  }

  function ensureMipPipeline() {
    if (mipPipeline) {
      return;
    }
    const mipModule = device.createShaderModule({ code: MIP_WGSL });
    mipPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: mipModule, entryPoint: "vs" },
      fragment: { module: mipModule, entryPoint: "fs", targets: [{ format: "rgba8unorm-srgb" }] },
      primitive: { topology: "triangle-list" },
    });
    mipSampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  }

  // Fills mip levels 1.. of one layer from level 0.
  function generateMips(layerIndex) {
    ensureMipPipeline();
    const levels = materialArray.mipLevelCount;
    const encoder = device.createCommandEncoder();
    for (let level = 1; level < levels; level += 1) {
      const source = materialArray.createView({
        dimension: "2d",
        baseMipLevel: level - 1,
        mipLevelCount: 1,
        baseArrayLayer: layerIndex,
        arrayLayerCount: 1,
      });
      const target = materialArray.createView({
        dimension: "2d",
        baseMipLevel: level,
        mipLevelCount: 1,
        baseArrayLayer: layerIndex,
        arrayLayerCount: 1,
      });
      const group = device.createBindGroup({
        layout: mipPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: mipSampler },
          { binding: 1, resource: source },
        ],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      });
      pass.setPipeline(mipPipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    }
    device.queue.submit([encoder.finish()]);
  }

  // imageSource: an ImageBitmap (or canvas) already resized to tileWidth x tileHeight by the caller - every layer of one
  // array must share one size.
  //
  // Deliberately NOT copyExternalImageToTexture(): verified directly (a synthetic-room render test) that it fails
  // validation here with "[Invalid Texture]... CopyTextureForBrowser", which then poisons every later WebGPU call on the
  // same device - an environment/driver limitation around GPU-backed copy sources. Going through an ImageData byte copy +
  // writeTexture() instead (the path already proven reliable for every other texture here) sidesteps it entirely.
  function setMaterialLayer(layerIndex, imageSource, tileWidth, tileHeight) {
    ensureMaterialArray(tileWidth, tileHeight);
    const temp = new OffscreenCanvas(tileWidth, tileHeight);
    const context2d = temp.getContext("2d");
    context2d.drawImage(imageSource, 0, 0, tileWidth, tileHeight);
    const pixels = context2d.getImageData(0, 0, tileWidth, tileHeight).data;
    device.queue.writeTexture(
      { texture: materialArray, origin: { x: 0, y: 0, z: layerIndex } },
      pixels,
      { bytesPerRow: tileWidth * 4, rowsPerImage: tileHeight },
      { width: tileWidth, height: tileHeight },
    );
    generateMips(layerIndex);
  }

  function render() {
    writeGlobals(); // the canvas may have been resized since the last frame
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    if (bindGroup && regionCount > 0) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  async function readPixelsAsBlob(mimeType, quality) {
    return new Promise(function (resolve) {
      context.canvas.toBlob(resolve, mimeType, quality);
    });
  }

  function destroy() {
    disposeSceneTextures();
    if (materialArray) {
      materialArray.destroy();
    }
    globalsBuffer.destroy();
    regionBuffer.destroy();
  }

  return {
    kind: "webgpu",
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
