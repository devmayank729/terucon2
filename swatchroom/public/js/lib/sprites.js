// Pre-rendered overlay layers for the stage, built once per scan so hovering and selecting
// only needs a few drawImage calls:
//   allEdges  thin coloured outlines of every surface
//   map       every surface tinted in its colour (the "surface map")
//   per region: hover tint, select tint and a white edge mask (filled with marching ants)

import { makeCanvas } from "./images.js";
import { traceLoops } from "./outlines.js";

export const SELECT_RGB = [210, 174, 109];

// Vector outline of a region (smooth loops in scan pixels), or null if it cannot be traced: the
// stage then draws that region's bitmap edge instead.
function loopsOf(labelMap, region, width, height) {
  try {
    return traceLoops(labelMap, region.index, width, height, region.bbox);
  } catch (error) {
    return null;
  }
}

export function buildSprites(scan) {
  const width = scan.width;
  const height = scan.height;
  const labelMap = scan.labelMap;
  const byIndex = scan.byIndex;
  const allEdges = makeCanvas(width, height);
  const map = makeCanvas(width, height);
  const edgePixels = allEdges.getContext("2d").createImageData(width, height);
  const mapPixels = map.getContext("2d").createImageData(width, height);
  const parts = {};
  scan.regions.forEach(function (region) {
    const boxWidth = region.bbox.x1 - region.bbox.x0;
    const boxHeight = region.bbox.y1 - region.bbox.y0;
    const hover = makeCanvas(boxWidth, boxHeight);
    const select = makeCanvas(boxWidth, boxHeight);
    const edge = makeCanvas(boxWidth, boxHeight);
    parts[region.index] = {
      region: region,
      hover: hover,
      select: select,
      edge: edge,
      hoverData: hover.getContext("2d").createImageData(boxWidth, boxHeight),
      selectData: select.getContext("2d").createImageData(boxWidth, boxHeight),
      edgeData: edge.getContext("2d").createImageData(boxWidth, boxHeight),
      boxWidth: boxWidth,
    };
  });
  function labelAt(x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      return -1;
    }
    return labelMap[y * width + x];
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const index = labelMap[pixel];
      if (index === 0) {
        continue;
      }
      const region = byIndex[index];
      const part = parts[index];
      if (!region || !part) {
        continue;
      }
      const nearEdge =
        labelAt(x - 1, y) !== index ||
        labelAt(x + 1, y) !== index ||
        labelAt(x, y - 1) !== index ||
        labelAt(x, y + 1) !== index ||
        labelAt(x - 2, y) !== index ||
        labelAt(x + 2, y) !== index ||
        labelAt(x, y - 2) !== index ||
        labelAt(x, y + 2) !== index;
      const wideEdge =
        nearEdge ||
        labelAt(x - 3, y) !== index ||
        labelAt(x + 3, y) !== index ||
        labelAt(x, y - 3) !== index ||
        labelAt(x, y + 3) !== index;
      const color = region.color;
      const offset = pixel * 4;
      const local =
        ((y - region.bbox.y0) * part.boxWidth + (x - region.bbox.x0)) * 4;
      mapPixels.data[offset] = color[0];
      mapPixels.data[offset + 1] = color[1];
      mapPixels.data[offset + 2] = color[2];
      mapPixels.data[offset + 3] = nearEdge ? 240 : 150;
      part.hoverData.data[local] = color[0];
      part.hoverData.data[local + 1] = color[1];
      part.hoverData.data[local + 2] = color[2];
      part.hoverData.data[local + 3] = wideEdge ? 255 : 112;
      part.selectData.data[local] = SELECT_RGB[0];
      part.selectData.data[local + 1] = SELECT_RGB[1];
      part.selectData.data[local + 2] = SELECT_RGB[2];
      part.selectData.data[local + 3] = 58;
      if (nearEdge) {
        edgePixels.data[offset] = color[0];
        edgePixels.data[offset + 1] = color[1];
        edgePixels.data[offset + 2] = color[2];
        edgePixels.data[offset + 3] = 150;
        part.edgeData.data[local] = 255;
        part.edgeData.data[local + 1] = 255;
        part.edgeData.data[local + 2] = 255;
        part.edgeData.data[local + 3] = 255;
      }
    }
  }
  allEdges.getContext("2d").putImageData(edgePixels, 0, 0);
  map.getContext("2d").putImageData(mapPixels, 0, 0);
  const regions = {};
  const order = [];
  Object.keys(parts).forEach(function (key) {
    const part = parts[key];
    part.hover.getContext("2d").putImageData(part.hoverData, 0, 0);
    part.select.getContext("2d").putImageData(part.selectData, 0, 0);
    part.edge.getContext("2d").putImageData(part.edgeData, 0, 0);
    regions[part.region.id] = {
      bbox: part.region.bbox,
      hover: part.hover,
      select: part.select,
      edge: part.edge,
      color: part.region.color,
      loops: loopsOf(labelMap, part.region, width, height),
      path: null, // the loops as a Path2D, made the first time the stage draws them
    };
    order.push(part.region.id);
  });
  return {
    width: width,
    height: height,
    allEdges: allEdges,
    map: map,
    regions: regions,
    order: order, // region ids, the order the outlines are drawn in
  };
}

// Diagonal stripes in the selection colour, scrolled to make marching ants.
export function antsPattern(context) {
  const tile = makeCanvas(12, 12);
  const tileContext = tile.getContext("2d");
  tileContext.fillStyle = "rgb(28, 24, 18)";
  tileContext.fillRect(0, 0, 12, 12);
  tileContext.fillStyle = "rgb(" + SELECT_RGB.join(",") + ")";
  tileContext.beginPath();
  tileContext.moveTo(0, 0);
  tileContext.lineTo(6, 0);
  tileContext.lineTo(12, 6);
  tileContext.lineTo(12, 12);
  tileContext.closePath();
  tileContext.fill();
  tileContext.beginPath();
  tileContext.moveTo(0, 6);
  tileContext.lineTo(6, 12);
  tileContext.lineTo(0, 12);
  tileContext.closePath();
  tileContext.fill();
  return context.createPattern(tile, "repeat");
}
