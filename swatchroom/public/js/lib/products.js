// Products and quantity take-off.
// A "product" is created for every render: which finish went onto which surface(s), plus the
// measured or typed-in size, an optional rate, and the computed quantity lines.

import { GROUP_SPECS, ITEM_QTY, SQFT_PER_M2 } from "../data/takeoff.js";
import { findItemGroupKey } from "../data/catalog.js";

// Category, quantity rule, install and care notes for a catalog item (or a notes-only edit).
export function productSpec(item) {
  if (!item) {
    return {
      category: "Custom design",
      qty: { type: "area" },
      install: "",
      care: "",
    };
  }
  const groupSpec = GROUP_SPECS[findItemGroupKey(item.id)] || {
    category: "Finish",
    qty: { type: "area" },
    install: "",
    care: "",
  };
  const qty = Object.assign({}, groupSpec.qty, ITEM_QTY[item.id] || {});
  return {
    category: groupSpec.category,
    qty: qty,
    install: groupSpec.install,
    care: groupSpec.care,
  };
}

export function sqftFromM2(areaM2) {
  return areaM2 * SQFT_PER_M2;
}

export function m2FromSqft(areaSqft) {
  return areaSqft / SQFT_PER_M2;
}

// "190 sq ft (17.6 m²)" or "17.6 m² (190 sq ft)" depending on the preferred unit.
export function formatArea(areaM2, unit) {
  if (!(areaM2 > 0)) {
    return "";
  }
  const metric =
    (areaM2 < 10 ? areaM2.toFixed(1) : String(Math.round(areaM2))) + " m²";
  const imperial =
    Math.round(sqftFromM2(areaM2)).toLocaleString("en-IN") + " sq ft";
  if (unit === "m2") {
    return metric + " (" + imperial + ")";
  }
  return imperial + " (" + metric + ")";
}

function plural(count, word) {
  if (count === 1 || /s$/.test(word)) {
    return count + " " + word;
  }
  return count + " " + word + "s";
}

// Split litres into pack sizes, largest first: 23 L -> "1 x 20 L + 1 x 4 L".
function packsFor(litres, sizes) {
  const parts = [];
  let left = litres;
  const sorted = sizes.slice().sort(function (a, b) {
    return b - a;
  });
  for (let index = 0; index < sorted.length; index += 1) {
    const size = sorted[index];
    const isLast = index === sorted.length - 1;
    const count = isLast ? Math.ceil(left / size) : Math.floor(left / size);
    if (count > 0) {
      parts.push(count + " x " + size + " L");
      left -= count * size;
    }
    if (left <= 0.0001) {
      break;
    }
  }
  return parts.join(" + ");
}

// The size used for a product: the designer's own numbers win over the photo estimate.
export function productSize(product) {
  const measure = product.measure || {};
  const override = product.override || {};
  return {
    areaM2: override.areaM2 > 0 ? override.areaM2 : measure.areaM2 || 0,
    widthM: override.widthM > 0 ? override.widthM : measure.widthM || 0,
    heightM: override.heightM > 0 ? override.heightM : measure.heightM || 0,
    depthM: measure.depthM || 0,
  };
}

// Quantity lines for an item at a given size.
// Returns { lines: [[label, text]], summary, primary: {qty, unit} | null, needsArea }.
export function takeoff(item, size) {
  const qty = productSpec(item).qty;
  const area = size && size.areaM2 > 0 ? size.areaM2 : 0;
  const width =
    size && size.widthM > 0 ? size.widthM : area > 0 ? Math.sqrt(area) : 0;
  const height = size && size.heightM > 0 ? size.heightM : 0;
  const depth = size && size.depthM > 0 ? size.depthM : 0;
  const lines = [];
  let summary = "";
  let primary = null;

  if (qty.type === "none") {
    return {
      lines: [],
      summary: "No material needed",
      primary: null,
      needsArea: false,
    };
  }
  if (qty.type === "count") {
    primary = { qty: qty.count, unit: qty.unit };
    lines.push(["Quantity", plural(qty.count, qty.unit.replace(/s$/, ""))]);
    return {
      lines: lines,
      summary: qty.count + " " + qty.unit,
      primary: primary,
      needsArea: false,
    };
  }
  if (!(area > 0)) {
    return {
      lines: [],
      summary: "Add the surface area to calculate",
      primary: null,
      needsArea: true,
    };
  }

  if (qty.type === "paint") {
    const litres = Math.ceil((area * qty.coats) / qty.coverage);
    const primer = Math.ceil(area / qty.primerCoverage);
    primary = { qty: litres, unit: "L paint" };
    lines.push([
      "Paint",
      litres +
        " L for " +
        qty.coats +
        " coats (" +
        qty.coverage +
        " m² per litre per coat)",
    ]);
    lines.push(["Suggested packs", packsFor(litres, [20, 10, 4, 1])]);
    lines.push(["Primer", primer + " L, one coat"]);
    summary = litres + " L paint, " + primer + " L primer";
  } else if (qty.type === "coating") {
    const material = area * qty.perM2;
    const packs = Math.ceil(material / qty.pack);
    primary = { qty: packs, unit: qty.pack + " " + qty.unit + " packs" };
    lines.push([
      "Material",
      Math.ceil(material) +
        " " +
        qty.unit +
        " (about " +
        qty.perM2 +
        " " +
        qty.unit +
        " per m², full system)",
    ]);
    lines.push(["Packs", plural(packs, qty.pack + " " + qty.unit + " pack")]);
    summary =
      Math.ceil(material) + " " + qty.unit + ", " + plural(packs, "pack");
  } else if (qty.type === "panel") {
    const panels = Math.ceil(
      (area * (1 + qty.wastage)) / (qty.panelW * qty.panelH),
    );
    primary = { qty: panels, unit: qty.unit };
    lines.push([
      "Panels",
      panels +
        " " +
        qty.unit +
        " of " +
        qty.panelW +
        " x " +
        qty.panelH +
        " m, including " +
        Math.round(qty.wastage * 100) +
        "% cutting waste",
    ]);
    summary = panels + " " + qty.unit;
  } else if (qty.type === "wallpaper") {
    const rolls = Math.ceil(
      (area * (1 + qty.wastage)) / (qty.rollW * qty.rollL),
    );
    primary = { qty: rolls, unit: "rolls" };
    lines.push([
      "Rolls",
      rolls +
        " rolls of " +
        qty.rollW +
        " x " +
        qty.rollL +
        " m, including " +
        Math.round(qty.wastage * 100) +
        "% for pattern match",
    ]);
    lines.push([
      "Adhesive",
      Math.max(1, Math.ceil(area / 25)) + " kg paste-the-wall adhesive",
    ]);
    summary = rolls + " rolls";
  } else if (qty.type === "boxes") {
    const withWaste = area * (1 + qty.wastage);
    const boxes = Math.ceil(withWaste / qty.boxCoverage);
    primary = { qty: boxes, unit: "boxes" };
    lines.push([
      "Boxes",
      boxes +
        " boxes at " +
        qty.boxCoverage +
        " m² each (" +
        withWaste.toFixed(1) +
        " m² with " +
        Math.round(qty.wastage * 100) +
        "% waste)",
    ]);
    if (qty.underlay) {
      lines.push(["Underlay", Math.ceil(area) + " m²"]);
    }
    summary = boxes + " boxes";
  } else if (qty.type === "tiles") {
    const tiles = Math.ceil(
      (area * (1 + qty.wastage)) / (qty.tileW * qty.tileH),
    );
    const tileSize =
      Math.round(qty.tileW * 1000) +
      " x " +
      Math.round(qty.tileH * 1000) +
      " mm";
    primary = qty.perBox
      ? { qty: Math.ceil(tiles / qty.perBox), unit: "boxes" }
      : { qty: tiles, unit: "tiles" };
    lines.push([
      "Tiles",
      tiles +
        " tiles of " +
        tileSize +
        ", including " +
        Math.round(qty.wastage * 100) +
        "% waste",
    ]);
    if (qty.perBox) {
      lines.push([
        "Boxes",
        Math.ceil(tiles / qty.perBox) + " boxes of " + qty.perBox,
      ]);
    }
    if (qty.adhesive) {
      lines.push([
        "Adhesive",
        Math.ceil((area * 5) / 20) + " bags of 20 kg (about 5 kg per m²)",
      ]);
      lines.push(["Grout", Math.max(1, Math.ceil(area * 0.3)) + " kg"]);
    }
    summary = qty.perBox
      ? tiles + " tiles, " + Math.ceil(tiles / qty.perBox) + " boxes"
      : tiles + " tiles";
  } else if (qty.type === "slabs") {
    const slabs = Math.ceil(
      (area * (1 + qty.wastage)) / (qty.slabW * qty.slabH),
    );
    primary = { qty: slabs, unit: "slabs" };
    lines.push([
      "Slabs",
      slabs +
        " slabs of about " +
        qty.slabW +
        " x " +
        qty.slabH +
        " m, book-matched in pairs",
    ]);
    summary = slabs + " slabs";
  } else if (qty.type === "pieces") {
    const pieces = Math.ceil(area * qty.perM2 * (1 + qty.wastage));
    primary = { qty: Math.ceil(pieces / qty.perBox), unit: "boxes" };
    lines.push([
      qty.unit.charAt(0).toUpperCase() + qty.unit.slice(1),
      pieces +
        " (" +
        qty.perM2 +
        " per m² plus " +
        Math.round(qty.wastage * 100) +
        "% waste)",
    ]);
    lines.push([
      "Boxes",
      Math.ceil(pieces / qty.perBox) + " boxes of " + qty.perBox,
    ]);
    summary = pieces + " " + qty.unit;
  } else if (qty.type === "wainscot") {
    const moulding = Math.ceil(width * 4.2);
    primary = { qty: moulding, unit: "m moulding" };
    lines.push([
      "Moulding",
      moulding + " running metres (dado rail, rails and stiles)",
    ]);
    lines.push(["Paint", Math.ceil((area * 2) / 11) + " L, two coats"]);
    summary = moulding + " m moulding";
  } else if (qty.type === "ceiling") {
    const perimeter =
      width > 0 && depth > 0 ? 2 * (width + depth) : 4 * Math.sqrt(area);
    const boards = Math.ceil((area * 1.1) / 2.88);
    primary = { qty: Math.ceil(area), unit: "m² false ceiling" };
    lines.push(["Gypsum board", boards + " boards of 1.2 x 2.4 m"]);
    lines.push(["Frame", "Galvanised channel for " + Math.ceil(area) + " m²"]);
    if (qty.led) {
      lines.push([
        qty.ledLabel || "LED strip",
        Math.ceil(perimeter) + " m, warm 3000K, with driver",
      ]);
    }
    if (qty.downlightSpacing) {
      lines.push([
        "Downlights",
        Math.ceil(perimeter / qty.downlightSpacing) + " around the lower band",
      ]);
    }
    summary =
      Math.ceil(area) +
      " m² ceiling" +
      (qty.led ? ", " + Math.ceil(perimeter) + " m LED" : "");
  } else if (qty.type === "beams") {
    const beams = Math.max(2, Math.ceil(width / qty.spacing));
    primary = { qty: beams, unit: "beams" };
    lines.push([
      "Beams",
      beams +
        " beams at about " +
        qty.spacing +
        " m spacing, " +
        (depth > 0 ? depth.toFixed(1) + " m long" : "room length"),
    ]);
    summary = beams + " beams";
  } else if (qty.type === "battens") {
    const metres = Math.ceil(area / qty.pitch);
    primary = { qty: metres, unit: "m battens" };
    lines.push([
      "Battens",
      metres +
        " running metres at " +
        Math.round(qty.pitch * 100) +
        " cm pitch",
    ]);
    summary = metres + " m battens";
  } else if (qty.type === "grid") {
    const fittings = Math.max(1, Math.ceil(area / (qty.spacing * qty.spacing)));
    primary = { qty: fittings, unit: qty.unit };
    lines.push([
      "Fittings",
      fittings + " " + qty.unit + " at about " + qty.spacing + " m spacing",
    ]);
    summary = fittings + " " + qty.unit;
  } else if (qty.type === "track") {
    const trackLength = Math.max(1, Math.round(width));
    primary = { qty: qty.spots, unit: "spotlights" };
    lines.push(["Track", trackLength + " m"]);
    lines.push(["Spotlights", String(qty.spots)]);
    summary = trackLength + " m track, " + qty.spots + " spots";
  } else if (qty.type === "curtain") {
    const openingWidth = width > 0 ? width : Math.sqrt(area);
    const drop = height > 0 ? height + 0.3 : 2.7;
    const trackLength = openingWidth + 0.4;
    const widths = Math.max(
      2,
      Math.ceil((trackLength * qty.fullness) / qty.fabricWidth),
    );
    const fabric = Math.ceil(widths * (drop + 0.3));
    primary = { qty: fabric, unit: "m fabric" };
    lines.push([
      "Fabric",
      fabric +
        " m of " +
        qty.fabricWidth +
        " m wide fabric (" +
        widths +
        " widths at " +
        qty.fullness +
        "x fullness)",
    ]);
    lines.push(["Track", trackLength.toFixed(1) + " m"]);
    summary = fabric + " m fabric, " + trackLength.toFixed(1) + " m track";
  } else if (qty.type === "blind") {
    const blindWidth = width > 0 ? width : Math.sqrt(area);
    primary = { qty: Math.ceil(area * 10) / 10, unit: "m² blind" };
    lines.push([
      "Size",
      blindWidth.toFixed(2) +
        " m wide" +
        (height > 0 ? " x " + height.toFixed(2) + " m drop" : ""),
    ]);
    summary = area.toFixed(1) + " m² blind";
  } else if (qty.type === "rug") {
    const sizes = [
      [1.6, 2.3],
      [2, 3],
      [2.4, 3.4],
      [3, 4],
    ];
    let best = sizes[0];
    for (let index = 0; index < sizes.length; index += 1) {
      if (sizes[index][0] * sizes[index][1] <= area * 0.6) {
        best = sizes[index];
      }
    }
    primary = { qty: 1, unit: "rug " + best[0] + " x " + best[1] + " m" };
    lines.push([
      "Recommended size",
      best[0] + " x " + best[1] + " m (about 60% of the floor)",
    ]);
    summary = "Rug " + best[0] + " x " + best[1] + " m";
  } else if (qty.type === "upholstery") {
    const pieceWidth = width > 0 ? width : 2;
    const fabric = Math.max(4, Math.ceil(pieceWidth * 4.5));
    primary = { qty: fabric, unit: "m fabric" };
    lines.push([
      "Fabric",
      fabric +
        " m of 1.4 m wide fabric for a " +
        pieceWidth.toFixed(1) +
        " m wide piece",
    ]);
    summary = fabric + " m fabric";
  } else if (qty.type === "finish") {
    const finished = Math.ceil(area * 1.3 * 10) / 10;
    primary = { qty: finished, unit: "m² finish" };
    lines.push(["Finished surface", finished + " m² including edges"]);
    summary = finished + " m² finish";
  } else {
    primary = { qty: Math.ceil(area * 10) / 10, unit: "m²" };
    summary = "";
  }
  return { lines: lines, summary: summary, primary: primary, needsArea: false };
}

// One-line quantity for cards and lists.
export function productHeadline(product, unit) {
  const size = productSize(product);
  const result = takeoff(product.item, size);
  if (product.status === "estimating" && result.needsArea) {
    return "Estimating quantity…";
  }
  const areaText = size.areaM2 > 0 ? formatArea(size.areaM2, unit) : "";
  if (result.needsArea) {
    return product.status === "failed"
      ? "Add the area to calculate"
      : result.summary;
  }
  if (
    !areaText ||
    result.primary === null ||
    productSpec(product.item).qty.type === "count"
  ) {
    return result.summary;
  }
  return areaText + ", " + result.summary;
}

// Amount for a product when a rate is set, else 0.
export function productAmount(product) {
  const result = takeoff(product.item, productSize(product));
  if (product.rate > 0 && result.primary) {
    return Math.round(product.rate * result.primary.qty);
  }
  return 0;
}

// Turn "20 kg packs" into "20 kg pack" for "per ..." labels.
export function unitSingular(unit) {
  const text = unit.replace(/^\d+(\.\d+)?\s/, "");
  const words = text.split(" ");
  const last = words[words.length - 1];
  if (/(ss|us)$/.test(last) || last.length < 3) {
    return text;
  }
  words[words.length - 1] = last
    .replace(/(xes|ches|shes)$/, function (match) {
      return match.slice(0, -2);
    })
    .replace(/([^s])s$/, "$1");
  return words.join(" ");
}

// Quantity rules that also need a width (curtains, blinds, upholstery...).
export const NEEDS_WIDTH = {
  curtain: true,
  blind: true,
  upholstery: true,
  track: true,
  wainscot: true,
  beams: true,
};

export const MODE_LABELS = {
  surface: "Replaces the surface finish",
  add: "Added to the surface",
  restyle: "Same piece, new material",
  remove: "Removal",
  custom: "Custom edit from notes",
};

export function productName(product) {
  return product.item ? product.item.name : "Custom edit";
}

// Bill of materials as CSV text (UTF-8 BOM added by the caller).
export function materialsCsv(products) {
  const rows = [
    [
      "Surface",
      "Product",
      "Category",
      "Spec",
      "Area (m²)",
      "Area (sq ft)",
      "Quantity",
      "Unit",
      "Rate",
      "Amount",
      "Details",
    ],
  ];
  products.forEach(function (product) {
    const size = productSize(product);
    const result = takeoff(product.item, size);
    const spec = productSpec(product.item);
    const quantity = result.primary ? result.primary.qty : "";
    const rate = product.rate > 0 ? product.rate : "";
    const amount = rate && quantity ? Math.round(rate * quantity) : "";
    rows.push([
      product.regionLabel,
      productName(product),
      spec.category,
      product.item ? product.item.sub : product.notes || "",
      size.areaM2 > 0 ? size.areaM2.toFixed(2) : "",
      size.areaM2 > 0 ? Math.round(sqftFromM2(size.areaM2)) : "",
      quantity,
      result.primary ? result.primary.unit : "",
      rate,
      amount,
      result.lines
        .map(function (line) {
          return line[0] + ": " + line[1];
        })
        .join("; "),
    ]);
  });
  return rows
    .map(function (row) {
      return row
        .map(function (cell) {
          const text = String(cell === null || cell === undefined ? "" : cell);
          if (/[",\n]/.test(text)) {
            return '"' + text.replace(/"/g, '""') + '"';
          }
          return text;
        })
        .join(",");
    })
    .join("\n");
}
