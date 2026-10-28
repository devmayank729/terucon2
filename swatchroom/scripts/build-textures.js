// Rasterizes public/js/views/swatch.js's tileable catalogue patterns (swatchMarkup with
// forTiling: true) to PNG textures the instant WebGPU/WebGL2 renderer swaps onto surfaces -
// see server/lib/fusion.js and public/js/lib/fastrender/. One-time/offline, like
// scripts/build-terucon-page.js: run it whenever the catalog or a swatch pattern changes, not
// at server start-up.
//
//   node scripts/build-textures.js [item-id ...]
//   (with no arguments, builds every catalog item that has a texture{} entry - see
//   public/js/data/catalog.js's attachTextures())
//
// Needs a real browser, not a lightweight SVG library: these patterns use SVG filters
// (feTurbulence, clipPath + <use>) that smaller/native SVG renderers either don't support or
// (tested directly against @resvg/resvg-js here) crash on outright.
//   npx playwright install chromium
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "public", "textures");
// 8x the pattern's native 160x112 SVG size - a clean integer scale (no resampling blur) at a
// reasonable texture resolution.
const SCALE = 8;
const WIDTH = 160 * SCALE;
const HEIGHT = 112 * SCALE;

async function loadCatalog() {
  const swatchModule = await import(
    pathToFileURL(path.join(root, "public/js/views/swatch.js")).href
  );
  const catalogModule = await import(
    pathToFileURL(path.join(root, "public/js/data/catalog.js")).href
  );
  return { swatchMarkup: swatchModule.swatchMarkup, CATALOG: catalogModule.CATALOG };
}

function collectTileableItems(CATALOG) {
  const seen = new Map();
  Object.keys(CATALOG).forEach(function (kind) {
    CATALOG[kind].forEach(function (group) {
      group.items.forEach(function (item) {
        if (!seen.has(item.id) && item.texture) {
          seen.set(item.id, item);
        }
      });
    });
  });
  return Array.from(seen.values());
}

async function renderOne(page, swatchMarkup, item) {
  const svg = swatchMarkup(item.swatch, item.id, "texture", { forTiling: true });
  await page.setContent(
    "<!doctype html><html><head><style>html,body{margin:0;padding:0;}svg{display:block;width:" +
      WIDTH +
      "px;height:" +
      HEIGHT +
      "px;}</style></head><body>" +
      svg +
      "</body></html>",
  );
  const el = await page.$("svg");
  return el.screenshot({ type: "png" });
}

async function main() {
  const { swatchMarkup, CATALOG } = await loadCatalog();
  const requested = process.argv.slice(2);
  let items = collectTileableItems(CATALOG);
  if (requested.length > 0) {
    const wanted = new Set(requested);
    items = items.filter(function (item) {
      return wanted.has(item.id);
    });
  }
  if (items.length === 0) {
    console.error("No tileable catalog items to build (check the id(s) you passed, if any).");
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });

  let ok = 0;
  for (const item of items) {
    try {
      const buffer = await renderOne(page, swatchMarkup, item);
      fs.writeFileSync(path.join(outDir, item.id + ".png"), buffer);
      ok += 1;
      console.log("OK   " + item.id + ".png (" + Math.round(buffer.length / 1024) + " KB)");
    } catch (error) {
      console.error("FAIL " + item.id + ": " + error.message);
    }
  }

  await browser.close();
  console.log(ok + "/" + items.length + " textures written to " + path.relative(root, outDir));
  if (ok < items.length) {
    process.exitCode = 1;
  }
}

main();
