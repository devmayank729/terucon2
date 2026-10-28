// Image helpers: decoding, resizing, encoding, masks and the "selection only" blend.
//
// Every temporary canvas a helper makes is released (width = height = 0) as soon as it has been drawn from: Safari on an
// iPhone keeps all canvas memory of a page alive until the garbage collector comes by and reloads the tab at about 384 MB.
import { releaseCanvas } from "./platform.js";

export function loadImage(url) {
  return new Promise(function (resolve, reject) {
    const image = new Image();
    image.decoding = "async";
    image.onload = function () {
      resolve(image);
    };
    image.onerror = function () {
      reject(new Error("The image could not be decoded."));
    };
    image.src = url;
  });
}

// Read a File the person picked. Explains HEIC trouble instead of failing silently.
export async function loadImageFile(file) {
  if (!file || !file.type || file.type.indexOf("image/") !== 0) {
    const looksHeic = file && /\.(heic|heif)$/i.test(file.name || "");
    if (!looksHeic) {
      throw new Error("Choose an image file (JPG, PNG or WebP).");
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await loadImage(url);
  } catch (error) {
    const heic =
      /heic|heif/i.test(file.type || "") ||
      /\.(heic|heif)$/i.test(file.name || "");
    throw new Error(
      heic
        ? "This browser cannot read HEIC photos. Export the photo as JPEG first (on iPhone: Settings, Camera, Formats, Most Compatible)."
        : "This image could not be opened. Try saving it as JPEG or PNG.",
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function makeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

export function fitInside(width, height, maxSide) {
  const longest = Math.max(width, height);
  if (longest <= maxSide) {
    return { width: width, height: height };
  }
  const scale = maxSide / longest;
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

// Draws an image or canvas at width x height. A photo that is more than twice too big is halved
// step by step first: one 4-to-1 draw lets a browser that only scales bilinearly (Safari ignores
// imageSmoothingQuality) skip source pixels, which puts shimmer on every edge that the scene model
// and the edge snapping then have to work from. Steps of at most 2-to-1 average like a box filter.
export function drawToCanvas(image, width, height) {
  const canvas = makeCanvas(width, height);
  let source = image;
  let size = naturalSize(image);
  while (size.width / 2 >= canvas.width && size.height / 2 >= canvas.height) {
    const half = makeCanvas(size.width / 2, size.height / 2);
    const halfContext = half.getContext("2d");
    halfContext.imageSmoothingEnabled = true;
    halfContext.imageSmoothingQuality = "high";
    halfContext.drawImage(source, 0, 0, half.width, half.height);
    source = half;
    size = { width: half.width, height: half.height };
  }
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function naturalSize(image) {
  return {
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
  };
}

// Downscale so the longest side is at most maxSide.
export function canvasAtMost(image, maxSide) {
  const size = naturalSize(image);
  const fitted = fitInside(size.width, size.height, maxSide);
  return drawToCanvas(image, fitted.width, fitted.height);
}

// Base64 (no data: prefix) of a canvas.
export function canvasToBase64(canvas, mimeType, quality) {
  const dataUrl = canvas.toDataURL(mimeType || "image/jpeg", quality || 0.92);
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

export function canvasToBlob(canvas, mimeType, quality) {
  return new Promise(function (resolve, reject) {
    canvas.toBlob(
      function (blob) {
        if (!blob) {
          reject(new Error("Could not encode the image."));
          return;
        }
        resolve(blob);
      },
      mimeType || "image/jpeg",
      quality || 0.94,
    );
  });
}

export async function base64ToBlob(data, mimeType) {
  const response = await fetch("data:" + mimeType + ";base64," + data);
  return response.blob();
}

const ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
];

// The supported aspect ratio closest to width x height (compared in log space).
export function nearestAspectRatio(width, height) {
  const target = Math.log(width / height);
  let best = ASPECT_RATIOS[0];
  let bestDistance = Infinity;
  ASPECT_RATIOS.forEach(function (ratio) {
    const parts = ratio.split(":");
    const distance = Math.abs(
      Math.log(Number(parts[0]) / Number(parts[1])) - target,
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      best = ratio;
    }
  });
  return best;
}

// Black and white mask canvas (white = target) at outWidth x outHeight, grown by `grow` pixels
// so the edit reaches right into corners.
export function maskCanvas(
  mask,
  maskWidth,
  maskHeight,
  outWidth,
  outHeight,
  grow,
) {
  const small = makeCanvas(maskWidth, maskHeight);
  const smallContext = small.getContext("2d");
  const pixels = smallContext.createImageData(maskWidth, maskHeight);
  for (let index = 0; index < mask.length; index += 1) {
    const value = mask[index] ? 255 : 0;
    const offset = index * 4;
    pixels.data[offset] = value;
    pixels.data[offset + 1] = value;
    pixels.data[offset + 2] = value;
    pixels.data[offset + 3] = 255;
  }
  smallContext.putImageData(pixels, 0, 0);

  const out = makeCanvas(outWidth, outHeight);
  const context = out.getContext("2d", { willReadFrequently: true });
  context.fillStyle = "#000";
  context.fillRect(0, 0, outWidth, outHeight);
  context.imageSmoothingEnabled = true;
  context.globalCompositeOperation = "lighten";
  const radius = Math.max(0, Math.round(grow || 0));
  if (radius > 0) {
    for (let step = 0; step < 12; step += 1) {
      const angle = (step / 12) * Math.PI * 2;
      context.drawImage(
        small,
        Math.cos(angle) * radius,
        Math.sin(angle) * radius,
        outWidth,
        outHeight,
      );
    }
  }
  context.drawImage(small, 0, 0, outWidth, outHeight);
  context.globalCompositeOperation = "source-over";
  const result = context.getImageData(0, 0, outWidth, outHeight);
  for (let offset = 0; offset < result.data.length; offset += 4) {
    const value = result.data[offset] > 110 ? 255 : 0;
    result.data[offset] = value;
    result.data[offset + 1] = value;
    result.data[offset + 2] = value;
    result.data[offset + 3] = 255;
  }
  context.putImageData(result, 0, 0);
  releaseCanvas(small);
  return out;
}

function blurCanvas(source, radius) {
  const out = makeCanvas(source.width, source.height);
  const context = out.getContext("2d");
  if (typeof context.filter === "string" && radius > 0) {
    context.filter = "blur(" + radius + "px)";
    context.drawImage(source, 0, 0);
    context.filter = "none";
    return out;
  }
  // Safari before 18 has no canvas filter: blur by shrinking and enlarging.
  const factor = Math.max(1, Math.round(radius));
  const small = makeCanvas(source.width / factor, source.height / factor);
  const smallContext = small.getContext("2d");
  smallContext.imageSmoothingEnabled = true;
  smallContext.drawImage(source, 0, 0, small.width, small.height);
  context.imageSmoothingEnabled = true;
  context.drawImage(small, 0, 0, out.width, out.height);
  releaseCanvas(small);
  return out;
}

// Put the render back onto the base photo only inside the (slightly feathered) union mask.
// regionMask is a Uint8Array at maskWidth x maskHeight.
export function blendIntoBase(
  baseCanvas,
  renderCanvas,
  regionMask,
  maskWidth,
  maskHeight,
) {
  const width = baseCanvas.width;
  const height = baseCanvas.height;
  const shortSide = Math.min(width, height);
  const grow = Math.max(2, Math.round(shortSide * 0.003));
  const feather = Math.max(1.5, shortSide * 0.003);
  const grown = maskCanvas(regionMask, maskWidth, maskHeight, width, height, grow);
  const soft = blurCanvas(grown, feather);
  releaseCanvas(grown);

  const alpha = makeCanvas(width, height);
  const alphaContext = alpha.getContext("2d");
  const softPixels = soft
    .getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, width, height);
  const alphaPixels = alphaContext.createImageData(width, height);
  for (let offset = 0; offset < softPixels.data.length; offset += 4) {
    alphaPixels.data[offset] = 255;
    alphaPixels.data[offset + 1] = 255;
    alphaPixels.data[offset + 2] = 255;
    alphaPixels.data[offset + 3] = softPixels.data[offset];
  }
  alphaContext.putImageData(alphaPixels, 0, 0);

  const cut = makeCanvas(width, height);
  const cutContext = cut.getContext("2d");
  cutContext.imageSmoothingEnabled = true;
  cutContext.imageSmoothingQuality = "high";
  cutContext.drawImage(renderCanvas, 0, 0, width, height);
  cutContext.globalCompositeOperation = "destination-in";
  cutContext.drawImage(alpha, 0, 0);

  const out = makeCanvas(width, height);
  const context = out.getContext("2d");
  context.drawImage(baseCanvas, 0, 0);
  context.drawImage(cut, 0, 0);
  releaseCanvas(soft);
  releaseCanvas(alpha);
  releaseCanvas(cut);
  return out;
}

// Upscale a low-resolution mask (from Pick) to the scan size with nearest neighbour.
export function resizeMask(mask, fromWidth, fromHeight, toWidth, toHeight) {
  if (fromWidth === toWidth && fromHeight === toHeight) {
    return mask;
  }
  const out = new Uint8Array(toWidth * toHeight);
  for (let y = 0; y < toHeight; y += 1) {
    const sourceY = Math.min(
      fromHeight - 1,
      Math.floor((y / toHeight) * fromHeight),
    );
    for (let x = 0; x < toWidth; x += 1) {
      const sourceX = Math.min(
        fromWidth - 1,
        Math.floor((x / toWidth) * fromWidth),
      );
      out[y * toWidth + x] = mask[sourceY * fromWidth + sourceX];
    }
  }
  return out;
}

// Decode a PNG mask (base64 or data URL) into a Uint8Array at width x height.
export function decodeMask(maskData, width, height) {
  return new Promise(function (resolve, reject) {
    const image = new Image();
    image.onload = function () {
      const canvas = makeCanvas(width, height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.imageSmoothingEnabled = true;
      context.drawImage(image, 0, 0, width, height);
      const data = context.getImageData(0, 0, width, height).data;
      const mask = new Uint8Array(width * height);
      let count = 0;
      for (let index = 0; index < mask.length; index += 1) {
        if (data[index * 4] > 127 && data[index * 4 + 3] > 0) {
          mask[index] = 1;
          count += 1;
        }
      }
      resolve({ mask: mask, count: count });
    };
    image.onerror = function () {
      reject(new Error("A mask could not be decoded."));
    };
    image.src =
      String(maskData).indexOf("data:") === 0
        ? maskData
        : "data:image/png;base64," + maskData;
  });
}

export function triggerDownload(url, filename) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
