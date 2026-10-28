// How big the preview canvas's drawing buffer is. It used to be exactly the scan's size (at most 1024 px on its long
// side), which a 3x-density phone then stretched over a 1170 px wide screen: blocky edges, soft texture. The shaders
// now read the scan's label / depth / shading / alpha textures through normalised coordinates, so the buffer can be
// whatever the screen needs: the frame's CSS width times the device pixel ratio, capped at MAX_PREVIEW_SIDE.
export const MAX_PREVIEW_SIDE = 2048;

// frameWidth / frameHeight: the photo's size on screen in CSS pixels. -> { width, height } in device pixels, same aspect
// as the frame, no side above `cap`, never below 1.
export function previewCanvasSize(frameWidth, frameHeight, devicePixelRatio, cap) {
  const limit = cap || MAX_PREVIEW_SIDE;
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  let width = Math.round(frameWidth * ratio);
  let height = Math.round(frameHeight * ratio);
  const longest = Math.max(width, height);
  if (longest > limit) {
    const scale = limit / longest;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  return { width: Math.max(1, width), height: Math.max(1, height) };
}
