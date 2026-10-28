// What kind of device this is, for the memory limits of canvases. Safari on iPhone / iPad refuses to keep more than about
// 384 MB of canvas memory alive per page (the tab is reloaded when it goes over), and one 4096 x 4096 canvas is 64 MB, so
// the render pipeline's several working canvases (photo, mask, guide, result, blend) at 4K do not fit.
export function isIosSafari() {
  try {
    const ua = navigator.userAgent || "";
    const iosDevice = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    return iosDevice && /WebKit/.test(ua);
  } catch (error) {
    return false;
  }
}

// A phone or tablet: touch input or a narrow viewport.
export function isMobile() {
  try {
    return (navigator.maxTouchPoints || 0) > 0 || window.innerWidth < 768;
  } catch (error) {
    return false;
  }
}

export const IOS_CANVAS_SIDE = 2560;
export const MOBILE_CANVAS_SIDE = 3072;

// The longest side an offscreen working canvas may have here. `requested` is what the settings ask for (2048, or 4096 for
// 4K renders).
export function workingCanvasSide(requested, env) {
  const ios = env ? env.ios : isIosSafari();
  const mobile = env ? env.mobile : isMobile();
  if (ios) {
    return Math.min(requested, IOS_CANVAS_SIDE);
  }
  if (mobile) {
    return Math.min(requested, MOBILE_CANVAS_SIDE);
  }
  return requested;
}

// Gives a canvas's pixel memory back at once instead of waiting for the garbage collector: setting a canvas to 0 x 0
// frees its backing store. Safe to call on anything that is not a canvas.
export function releaseCanvas(canvas) {
  if (canvas && typeof canvas === "object" && "width" in canvas && "height" in canvas) {
    try {
      canvas.width = 0;
      canvas.height = 0;
    } catch (error) {
      // a read-only or transferred canvas: nothing to free
    }
  }
}
