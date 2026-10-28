// Framing helpers for renders:
//  - focusCrop: for a small surface, send the model a close crop around it (more pixels on target)
//  - guideImage: the photo with the target tinted magenta and outlined, so the model sees where to work
//  - alignOutput: image models sometimes reframe slightly; find the scale/shift that puts the
//    output back on top of the input before blending
//  - placeOutput: paste the aligned output into the full-size photo

import { makeCanvas, nearestAspectRatio, naturalSize } from "./images.js";

// Returns a crop rectangle in base-image pixels, or null when the surface is big enough
// (more than 22% of the frame) or the crop would be nearly the whole photo.
// region.bbox is in scan pixels (scanWidth x scanHeight); base is W x H.
export function focusCrop(
  region,
  scanWidth,
  scanHeight,
  baseWidth,
  baseHeight,
) {
  const box = region && region.bbox;
  if (!box) {
    return null;
  }
  const scaleX = baseWidth / scanWidth;
  const scaleY = baseHeight / scanHeight;
  const left = box.x0 * scaleX;
  const top = box.y0 * scaleY;
  const right = box.x1 * scaleX;
  const bottom = box.y1 * scaleY;
  const boxWidth = right - left;
  const boxHeight = bottom - top;
  if (boxWidth * boxHeight > baseWidth * baseHeight * 0.22) {
    return null;
  }
  const ratioParts = nearestAspectRatio(baseWidth, baseHeight).split(":");
  const ratio = Number(ratioParts[0]) / Number(ratioParts[1]);
  let cropHeight = Math.max(
    boxHeight * 1.6,
    (boxWidth * 1.6) / ratio,
    baseHeight * 0.5,
    (baseWidth * 0.5) / ratio,
  );
  let cropWidth = cropHeight * ratio;
  if (cropWidth > baseWidth * 0.82 || cropHeight > baseHeight * 0.82) {
    return null;
  }
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const x = Math.round(
    Math.min(baseWidth - cropWidth, Math.max(0, centerX - cropWidth / 2)),
  );
  const y = Math.round(
    Math.min(baseHeight - cropHeight, Math.max(0, centerY - cropHeight / 2)),
  );
  cropWidth = Math.min(baseWidth - x, Math.round(cropWidth));
  cropHeight = Math.min(baseHeight - y, Math.round(cropHeight));
  const upscale = Math.max(1, 1280 / Math.max(cropWidth, cropHeight));
  return {
    x: x,
    y: y,
    w: cropWidth,
    h: cropHeight,
    W: baseWidth,
    H: baseHeight,
    outWidth: Math.round(cropWidth * upscale),
    outHeight: Math.round(cropHeight * upscale),
  };
}

// Cut the crop out of a canvas at outWidth x outHeight. For masks, re-threshold to pure black/white.
export function cutCrop(source, crop, outWidth, outHeight, isMask) {
  const out = makeCanvas(outWidth, outHeight);
  const context = out.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    source,
    crop.x,
    crop.y,
    crop.w,
    crop.h,
    0,
    0,
    outWidth,
    outHeight,
  );
  if (isMask) {
    const pixels = context.getImageData(0, 0, outWidth, outHeight);
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      const value = pixels.data[offset] > 110 ? 255 : 0;
      pixels.data[offset] = value;
      pixels.data[offset + 1] = value;
      pixels.data[offset + 2] = value;
      pixels.data[offset + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
  }
  return out;
}

function toCropX(value, crop) {
  return Math.round(
    Math.min(
      1000,
      Math.max(0, (((value / 1000) * crop.W - crop.x) / crop.w) * 1000),
    ),
  );
}

function toCropY(value, crop) {
  return Math.round(
    Math.min(
      1000,
      Math.max(0, (((value / 1000) * crop.H - crop.y) / crop.h) * 1000),
    ),
  );
}

// Re-express a 0-1000 [x, y] polygon relative to the crop.
export function polygonInCrop(points, crop) {
  if (!points || !crop) {
    return points;
  }
  return points.map(function (point) {
    return [toCropX(point[0], crop), toCropY(point[1], crop)];
  });
}

// Re-express a 0-1000 box relative to the crop.
export function boxInCrop(box, crop) {
  if (!crop) {
    return box;
  }
  return {
    ymin: toCropY(box.ymin, crop),
    xmin: toCropX(box.xmin, crop),
    ymax: toCropY(box.ymax, crop),
    xmax: toCropX(box.xmax, crop),
  };
}

// Centroid (0-1000) and area share of a region relative to the crop.
export function regionFactsInCrop(region, scanWidth, scanHeight, crop) {
  const centerX =
    (((region.centroid.x / scanWidth) * crop.W - crop.x) / crop.w) * 1000;
  const centerY =
    (((region.centroid.y / scanHeight) * crop.H - crop.y) / crop.h) * 1000;
  return {
    centerX: Math.min(1000, Math.max(0, centerX)),
    centerY: Math.min(1000, Math.max(0, centerY)),
    areaShare: Math.min(
      1,
      (region.areaShare * crop.W * crop.H) / (crop.w * crop.h),
    ),
  };
}

// How much of the perspective preview shows inside the outline of the guide image.
export const GUIDE_PREVIEW_OPACITY = 0.35;

// The photo with the target tinted magenta and its edge outlined in solid magenta.
// preview (optional): a canvas the size of the photo holding the instant 3D preview of the finish (transparent outside the
// surface). Inside the outline it is blended in at GUIDE_PREVIEW_OPACITY instead of the flat tint, so the model can see how
// the tile lines converge and how the room's light falls on the surface; a faint tint stays so the target is still marked.
export function guideImage(photoCanvas, maskCanvasAtSameSize, preview) {
  const width = photoCanvas.width;
  const height = photoCanvas.height;
  const out = makeCanvas(width, height);
  const context = out.getContext("2d", { willReadFrequently: true });
  context.drawImage(photoCanvas, 0, 0);
  const maskData = maskCanvasAtSameSize
    .getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, width, height).data;
  const image = context.getImageData(0, 0, width, height);
  const previewData =
    preview && preview.width === width && preview.height === height
      ? preview.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data
      : null;
  const radius = Math.max(2, Math.round(Math.min(width, height) * 0.003));
  const inside = new Uint8Array(width * height);
  for (let index = 0; index < inside.length; index += 1) {
    inside[index] = maskData[index * 4] > 127 ? 1 : 0;
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!inside[index]) {
        continue;
      }
      let onEdge = false;
      for (let step = 1; step <= radius && !onEdge; step += 1) {
        if (
          x - step < 0 ||
          !inside[index - step] ||
          x + step >= width ||
          !inside[index + step] ||
          y - step < 0 ||
          !inside[index - step * width] ||
          y + step >= height ||
          !inside[index + step * width]
        ) {
          onEdge = true;
        }
      }
      const offset = index * 4;
      if (onEdge) {
        image.data[offset] = 255;
        image.data[offset + 1] = 0;
        image.data[offset + 2] = 200;
      } else if (previewData && previewData[offset + 3] > 0) {
        // the preview (shaded, in perspective) at 35% over the photo, plus a faint magenta wash that marks the target
        const mix = GUIDE_PREVIEW_OPACITY * (previewData[offset + 3] / 255);
        const tint = 0.12;
        for (let channel = 0; channel < 3; channel += 1) {
          const photo = image.data[offset + channel];
          const shown = previewData[offset + channel];
          const wash = channel === 0 ? 255 : channel === 1 ? 0 : 200;
          const blended = photo * (1 - mix) + shown * mix;
          image.data[offset + channel] = Math.round(blended * (1 - tint) + wash * tint);
        }
      } else {
        image.data[offset] = Math.round(image.data[offset] * 0.55 + 114.75);
        image.data[offset + 1] = Math.round(image.data[offset + 1] * 0.55);
        image.data[offset + 2] = Math.round(image.data[offset + 2] * 0.55 + 90);
      }
    }
  }
  context.putImageData(image, 0, 0);
  return out;
}

// ---------------------------------------------------------------- output alignment

function grayAt(image, width, height) {
  const canvas = makeCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;
  const gray = new Float32Array(width * height);
  for (let index = 0; index < gray.length; index += 1) {
    gray[index] =
      0.299 * data[index * 4] +
      0.587 * data[index * 4 + 1] +
      0.114 * data[index * 4 + 2];
  }
  return gray;
}

// Normalise to zero mean / unit spread over the valid pixels.
function normalise(gray, valid) {
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let index = 0; index < gray.length; index += 1) {
    if (valid[index]) {
      sum += gray[index];
      sumSquares += gray[index] * gray[index];
      count += 1;
    }
  }
  const mean = count ? sum / count : 0;
  const spread = Math.sqrt(
    Math.max(1, count ? sumSquares / count - mean * mean : 1),
  );
  for (let index = 0; index < gray.length; index += 1) {
    gray[index] = (gray[index] - mean) / spread;
  }
  return gray;
}

// Pixels far from the edited area and away from the borders: these should match between
// input and output, so they drive the alignment.
function stablePixels(mask, width, height) {
  const canvas = makeCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.drawImage(mask, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;
  const edited = new Uint8Array(width * height);
  for (let index = 0; index < edited.length; index += 1) {
    edited[index] = data[index * 4] > 8 ? 1 : 0;
  }
  const reach = Math.max(1, Math.ceil(Math.max(width, height) * 0.035));
  const rows = new Uint8Array(width * height);
  const grown = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    let last = -1e9;
    for (let x = 0; x < width; x += 1) {
      if (edited[y * width + x]) {
        last = x;
      }
      if (x - last <= reach) {
        rows[y * width + x] = 1;
      }
    }
    last = 1e9;
    for (let x = width - 1; x >= 0; x -= 1) {
      if (edited[y * width + x]) {
        last = x;
      }
      if (last - x <= reach) {
        rows[y * width + x] = 1;
      }
    }
  }
  for (let x = 0; x < width; x += 1) {
    let last = -1e9;
    for (let y = 0; y < height; y += 1) {
      if (rows[y * width + x]) {
        last = y;
      }
      if (y - last <= reach) {
        grown[y * width + x] = 1;
      }
    }
    last = 1e9;
    for (let y = height - 1; y >= 0; y -= 1) {
      if (rows[y * width + x]) {
        last = y;
      }
      if (last - y <= reach) {
        grown[y * width + x] = 1;
      }
    }
  }
  const marginX = Math.ceil(width * 0.04);
  const marginY = Math.ceil(height * 0.04);
  const valid = new Uint8Array(width * height);
  let count = 0;
  for (let y = marginY; y < height - marginY; y += 1) {
    for (let x = marginX; x < width - marginX; x += 1) {
      const index = y * width + x;
      if (!grown[index]) {
        valid[index] = 1;
        count += 1;
      }
    }
  }
  return { valid: valid, count: count };
}

function level(input, output, mask, width) {
  const height = Math.max(8, Math.round((width * input.height) / input.width));
  const stable = stablePixels(mask, width, height);
  if (stable.count < width * height * 0.1) {
    return null;
  }
  return {
    width: width,
    height: height,
    valid: stable.valid,
    inputGray: normalise(grayAt(input, width, height), stable.valid),
    outputGray: normalise(grayAt(output, width, height), stable.valid),
  };
}

// Mean absolute difference between input and the transformed output over stable pixels.
// params = [scaleX, scaleY, shiftX, shiftY] (shifts as a fraction of the size).
function alignmentError(lv, params) {
  const width = lv.width;
  const height = lv.height;
  let error = 0;
  let count = 0;
  const scaleX = params[0];
  const scaleY = params[1];
  const originX = width / 2 + params[2] * width - 0.5;
  const originY = height / 2 + params[3] * height - 0.5;
  for (let y = 0; y < height; y += 1) {
    const sourceY = (y + 0.5 - height / 2) * scaleY + originY;
    const outsideY = sourceY < 0 || sourceY > height - 1.001;
    const y0 = outsideY ? 0 : sourceY | 0;
    const fractionY = sourceY - y0;
    const row = y * width;
    for (let x = y & 1; x < width; x += 2) {
      const index = row + x;
      if (!lv.valid[index]) {
        continue;
      }
      count += 1;
      const sourceX = (x + 0.5 - width / 2) * scaleX + originX;
      if (outsideY || sourceX < 0 || sourceX > width - 1.001) {
        error += 1;
        continue;
      }
      const x0 = sourceX | 0;
      const fractionX = sourceX - x0;
      const at = y0 * width + x0;
      const out = lv.outputGray;
      const sample =
        (out[at] * (1 - fractionX) + out[at + 1] * fractionX) *
          (1 - fractionY) +
        (out[at + width] * (1 - fractionX) + out[at + width + 1] * fractionX) *
          fractionY;
      error += Math.abs(lv.inputGray[index] - sample);
    }
  }
  return count > 40 ? error / count : 9;
}

function refine(lv, start) {
  let best = start.slice();
  let bestError = alignmentError(lv, best);
  let steps = [0.006, 0.006, 1.5 / lv.width, 1.5 / lv.height];
  for (let iteration = 0; iteration < 60; iteration += 1) {
    let improved = false;
    for (let parameter = 0; parameter < 4; parameter += 1) {
      for (let sign = -1; sign <= 1; sign += 2) {
        const candidate = best.slice();
        candidate[parameter] += sign * steps[parameter];
        const error = alignmentError(lv, candidate);
        if (error < bestError) {
          bestError = error;
          best = candidate;
          improved = true;
        }
      }
    }
    if (!improved) {
      steps = steps.map(function (step) {
        return step / 2;
      });
      if (steps[0] < 0.0005) {
        break;
      }
    }
  }
  return best;
}

// Find how the model's output maps back onto the input. input is the canvas sent, output the
// decoded image, mask the mask canvas sent. Returns { sx, sy, tx, ty, err, err0, skip }.
export function alignOutput(input, output, mask) {
  const identity = { sx: 1, sy: 1, tx: 0, ty: 0, err: 0, err0: 0, skip: true };
  try {
    const coarse = level(input, output, mask, 80);
    if (!coarse) {
      return identity;
    }
    const inputRatio = input.width / input.height;
    const outputSize = naturalSize(output);
    const outputRatio = outputSize.width / outputSize.height;
    const stretches = [[1, 1]];
    if (Math.abs(Math.log(inputRatio / outputRatio)) > 0.02) {
      stretches.push(
        [inputRatio / outputRatio, 1],
        [1, outputRatio / inputRatio],
      );
    }
    let best = [1, 1, 0, 0];
    let bestError = alignmentError(coarse, best);
    stretches.forEach(function (stretch) {
      for (let scale = 0.92; scale < 1.0801; scale += 0.01) {
        for (let shiftY = -5; shiftY <= 5; shiftY += 1) {
          for (let shiftX = -5; shiftX <= 5; shiftX += 1) {
            const params = [
              stretch[0] * scale,
              stretch[1] * scale,
              shiftX / coarse.width,
              shiftY / coarse.height,
            ];
            const error = alignmentError(coarse, params);
            if (error < bestError) {
              bestError = error;
              best = params;
            }
          }
        }
      }
    });
    let finest = coarse;
    const medium = level(input, output, mask, 192);
    if (medium) {
      best = refine(medium, best);
      finest = medium;
    }
    const fine = medium && level(input, output, mask, 384);
    if (fine) {
      best = refine(fine, best);
      finest = fine;
    }
    let error = alignmentError(finest, best);
    const untouched = alignmentError(finest, [1, 1, 0, 0]);
    if (error > untouched) {
      best = [1, 1, 0, 0];
      error = untouched;
    }
    return {
      sx: best[0],
      sy: best[1],
      tx: best[2],
      ty: best[3],
      err: error,
      err0: untouched,
      skip: false,
    };
  } catch (problem) {
    return identity;
  }
}

// Paste the aligned model output into a copy of the base photo (into the crop when there is one).
export function placeOutput(base, output, alignment, crop) {
  const width = base.width;
  const height = base.height;
  const out = makeCanvas(width, height);
  const context = out.getContext("2d");
  context.drawImage(base, 0, 0);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  const rectX = crop ? crop.x : 0;
  const rectY = crop ? crop.y : 0;
  const rectWidth = crop ? crop.w : width;
  const rectHeight = crop ? crop.h : height;
  const size = naturalSize(output);
  context.save();
  context.beginPath();
  context.rect(rectX, rectY, rectWidth, rectHeight);
  context.clip();
  context.setTransform(
    rectWidth / (size.width * alignment.sx),
    0,
    0,
    rectHeight / (size.height * alignment.sy),
    rectX + (0.5 - (0.5 + alignment.tx) / alignment.sx) * rectWidth,
    rectY + (0.5 - (0.5 + alignment.ty) / alignment.sy) * rectHeight,
  );
  context.drawImage(output, 0, 0);
  context.restore();
  return out;
}

// True when the output's aspect ratio is noticeably different from the input's.
export function aspectChanged(
  inputWidth,
  inputHeight,
  outputWidth,
  outputHeight,
) {
  return (
    Math.abs(
      Math.log(inputWidth / inputHeight / (outputWidth / outputHeight)),
    ) > 0.035
  );
}
