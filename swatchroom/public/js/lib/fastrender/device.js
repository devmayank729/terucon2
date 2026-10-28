// Picks a rendering backend for the fast-render canvas: WebGPU where available, WebGL2
// otherwise, null (meaning every surface in the room falls back to Gemini - see tiers.js) if
// neither works. Every step here can fail for reasons that have nothing to do with this app
// (blocklisted GPU, exhausted contexts, a disabled browser flag) - the same try/catch-and-
// degrade shape detectSurfaces() already uses in public/js/lib/detect.js, just for rendering.
//
// The canvas is configured for real transparency (premultiplied alpha): it is a transparent
// overlay stacked on top of the original photo <img> (see renderer.js), not a redraw of the
// photo itself, so untouched pixels never pass through the GPU at all.
export async function createRenderDevice(canvas) {
  const webgpu = await tryWebGPU(canvas);
  if (webgpu) {
    return webgpu;
  }
  const webgl2 = tryWebGL2(canvas);
  if (webgl2) {
    return webgl2;
  }
  return { kind: null };
}

async function tryWebGPU(canvas) {
  if (!navigator.gpu) {
    return null;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
      return null;
    }
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");
    if (!context) {
      return null;
    }
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device: device, format: format, alphaMode: "premultiplied" });
    return { kind: "webgpu", device: device, context: context, format: format, adapter: adapter };
  } catch (error) {
    return null;
  }
}

function tryWebGL2(canvas) {
  try {
    const context = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      // "keep this render as a version" flattens the canvas with drawImage() some time after
      // the draw call, not necessarily inside the same frame - without this the buffer can be
      // cleared before that read happens.
      preserveDrawingBuffer: true,
    });
    if (!context) {
      return null;
    }
    return { kind: "webgl2", context: context };
  } catch (error) {
    return null;
  }
}
