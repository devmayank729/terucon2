// Exports: the current image, a before/after pair, and a design board with the materials list.
// On phones these go through the system share sheet (WhatsApp, Mail, Drive...) when available.

import { swatchMarkup } from "../views/swatch.js";
import {
  canvasToBlob,
  loadImage,
  makeCanvas,
  triggerDownload,
} from "./images.js";
import {
  formatArea,
  productName,
  productSize,
  productSpec,
  takeoff,
} from "./products.js";

const INK = "#291C0E";
const MUTED = "#6E473B";
const PAPER = "#E9E0D3";
const LINE = "rgba(41,28,14,.18)";

function fontsReady() {
  try {
    return document.fonts && document.fonts.ready
      ? document.fonts.ready
      : Promise.resolve();
  } catch (error) {
    return Promise.resolve();
  }
}

function display(size, weight) {
  return (weight || 300) + " " + size + "px Zodiak, Georgia, serif";
}

function ui(size, weight) {
  return (
    (weight || 400) + " " + size + "px Switzer, Helvetica, Arial, sans-serif"
  );
}

// Draw an image to cover a box (like CSS object-fit: cover).
function drawCover(context, image, x, y, width, height) {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const cropWidth = width / scale;
  const cropHeight = height / scale;
  context.drawImage(
    image,
    (sourceWidth - cropWidth) / 2,
    (sourceHeight - cropHeight) / 2,
    cropWidth,
    cropHeight,
    x,
    y,
    width,
    height,
  );
}

function drawContain(context, image, x, y, width, height) {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.drawImage(
    image,
    x + (width - drawWidth) / 2,
    y + (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
  return {
    x: x + (width - drawWidth) / 2,
    y: y + (height - drawHeight) / 2,
    width: drawWidth,
    height: drawHeight,
  };
}

function tag(context, text, x, y) {
  context.font = ui(26, 500);
  const width = context.measureText(text).width + 36;
  context.fillStyle = "rgba(31,21,10,.72)";
  roundRect(context, x, y, width, 48, 24);
  context.fill();
  context.fillStyle = "#F3EDE4";
  context.textBaseline = "middle";
  context.fillText(text, x + 18, y + 25);
}

function roundRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

function wrapText(context, text, maxWidth) {
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let line = "";
  words.forEach(function (word) {
    const attempt = line ? line + " " + word : word;
    if (context.measureText(attempt).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = attempt;
    }
  });
  if (line) {
    lines.push(line);
  }
  return lines;
}

// Draw a catalog swatch as an image (its SVG markup, loaded like any picture).
async function swatchImage(item) {
  const markup = swatchMarkup(item.swatch, item.id, "board").replace(
    "<svg ",
    '<svg width="320" height="224" ',
  );
  return loadImage(
    "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup),
  );
}

export async function beforeAfterImage(beforeUrl, afterUrl, label) {
  await fontsReady();
  const before = await loadImage(beforeUrl);
  const after = await loadImage(afterUrl);
  const portrait = before.naturalHeight > before.naturalWidth;
  const panelWidth = portrait ? 1080 : 1600;
  const panelHeight = Math.round(
    (panelWidth * before.naturalHeight) / before.naturalWidth,
  );
  const gap = 16;
  const canvas = portrait
    ? makeCanvas(panelWidth * 2 + gap, panelHeight)
    : makeCanvas(panelWidth, panelHeight * 2 + gap);
  const context = canvas.getContext("2d");
  context.fillStyle = PAPER;
  context.fillRect(0, 0, canvas.width, canvas.height);
  drawCover(context, before, 0, 0, panelWidth, panelHeight);
  const afterX = portrait ? panelWidth + gap : 0;
  const afterY = portrait ? 0 : panelHeight + gap;
  drawCover(context, after, afterX, afterY, panelWidth, panelHeight);
  tag(context, "Before", 24, 24);
  tag(context, "After" + (label ? ": " + label : ""), afterX + 24, afterY + 24);
  return canvasToBlob(canvas, "image/jpeg", 0.92);
}

// A design board: before, after, and every product with its quantity.
export async function designBoard(options) {
  await fontsReady();
  const before = await loadImage(options.beforeUrl);
  const after = await loadImage(options.afterUrl);
  const width = 2400;
  const margin = 96;
  const photoGap = 32;
  const photoWidth = (width - margin * 2 - photoGap) / 2;
  const photoHeight = Math.round(
    Math.min(
      photoWidth * 1.25,
      (photoWidth * before.naturalHeight) / before.naturalWidth,
    ),
  );
  const products = options.products || [];
  const rowHeight = 168;
  const listTop = margin + 150 + photoHeight + 110;
  const height = listTop + Math.max(1, products.length) * rowHeight + 200;
  const canvas = makeCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = PAPER;
  context.fillRect(0, 0, width, height);
  context.textBaseline = "alphabetic";

  context.fillStyle = INK;
  context.font = display(72);
  context.fillText(options.title || "Design board", margin, margin + 70);
  context.font = ui(28, 500);
  context.fillStyle = MUTED;
  const date = new Date().toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const meta = "Terucon Design Studio, Swatchroom concept, " + date;
  context.fillText(
    meta,
    width - margin - context.measureText(meta).width,
    margin + 66,
  );

  const photosTop = margin + 130;
  context.save();
  roundRect(context, margin, photosTop, photoWidth, photoHeight, 6);
  context.clip();
  drawCover(context, before, margin, photosTop, photoWidth, photoHeight);
  context.restore();
  context.save();
  roundRect(
    context,
    margin + photoWidth + photoGap,
    photosTop,
    photoWidth,
    photoHeight,
    6,
  );
  context.clip();
  drawCover(
    context,
    after,
    margin + photoWidth + photoGap,
    photosTop,
    photoWidth,
    photoHeight,
  );
  context.restore();
  tag(context, "Before", margin + 24, photosTop + 24);
  tag(context, "Proposed", margin + photoWidth + photoGap + 24, photosTop + 24);

  context.fillStyle = INK;
  context.font = display(48);
  context.fillText("Materials", margin, listTop - 30);
  context.strokeStyle = LINE;
  context.lineWidth = 2;
  let y = listTop;
  if (products.length === 0) {
    context.font = ui(30);
    context.fillStyle = MUTED;
    context.fillText("No materials in this version yet.", margin, y + 60);
  }
  for (let index = 0; index < products.length; index += 1) {
    const product = products[index];
    context.beginPath();
    context.moveTo(margin, y);
    context.lineTo(width - margin, y);
    context.stroke();
    if (product.item) {
      try {
        const chip = await swatchImage(product.item);
        context.save();
        roundRect(context, margin, y + 24, 170, 120, 4);
        context.clip();
        drawContain(context, chip, margin - 2, y + 22, 174, 124);
        context.restore();
      } catch (error) {
        // the list still works without the chip
      }
    }
    const textLeft = margin + 210;
    context.fillStyle = INK;
    context.font = ui(34, 500);
    context.fillText(productName(product), textLeft, y + 64);
    context.fillStyle = MUTED;
    context.font = ui(26);
    const spec = productSpec(product.item);
    context.fillText(
      spec.category +
        (product.item ? ", " + product.item.sub : "") +
        ". On " +
        product.regionLabel.toLowerCase() +
        ".",
      textLeft,
      y + 106,
    );
    const size = productSize(product);
    const quantity = takeoff(product.item, size);
    const right = [
      size.areaM2 > 0 ? formatArea(size.areaM2, options.areaUnit) : "",
      quantity.summary,
    ]
      .filter(Boolean)
      .join(", ");
    context.fillStyle = INK;
    context.font = ui(28, 500);
    const lines = wrapText(context, right, 760);
    lines.slice(0, 2).forEach(function (line, lineIndex) {
      context.fillText(
        line,
        width - margin - context.measureText(line).width,
        y + 64 + lineIndex * 40,
      );
    });
    y += rowHeight;
  }
  context.beginPath();
  context.moveTo(margin, y);
  context.lineTo(width - margin, y);
  context.stroke();
  context.fillStyle = MUTED;
  context.font = ui(24);
  context.fillText(
    "Concept render. Quantities are planning estimates from one photo; a Terucon designer confirms materials, feasibility and cost on site.",
    margin,
    y + 70,
  );
  return canvasToBlob(canvas, "image/jpeg", 0.9);
}

// Share a file through the system sheet when possible, else download it.
export async function shareOrDownload(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type || "image/jpeg" });
  try {
    if (
      navigator.canShare &&
      navigator.canShare({ files: [file] }) &&
      navigator.share
    ) {
      await navigator.share({ files: [file], title: title || filename });
      return "shared";
    }
  } catch (error) {
    if (error && error.name === "AbortError") {
      return "cancelled";
    }
  }
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  setTimeout(function () {
    URL.revokeObjectURL(url);
  }, 4000);
  return "downloaded";
}

export function canShareFiles() {
  try {
    const probe = new File(
      [new Blob(["x"], { type: "image/jpeg" })],
      "probe.jpg",
      { type: "image/jpeg" },
    );
    return !!(
      navigator.canShare &&
      navigator.share &&
      navigator.canShare({ files: [probe] })
    );
  } catch (error) {
    return false;
  }
}
