// End-to-end walk through Swatchroom on one device size: add a photo, wait for the scan,
// select two walls, render a finish, zoom, share, materials.
// usage: node flow.js <device> [url] [photo]
const pw = require("./pw");
const path = require("path");
const fs = require("fs");

const device = process.argv[2] || "phone";
const url =
  process.argv[3] ||
  process.env.SWATCHROOM_URL ||
  "http://127.0.0.1:3000/studio";
const photo = process.argv[4] || "room-land.jpg";
const outDir = path.join(__dirname, "shots-new");
fs.mkdirSync(outDir, { recursive: true });
let step = 0;

async function shot(page, name, full) {
  step += 1;
  const file = path.join(
    outDir,
    device + "-" + String(step).padStart(2, "0") + "-" + name + ".png",
  );
  await page.screenshot({ path: file, fullPage: !!full });
  console.log("shot", path.basename(file));
}

async function tapAt(page, x, y) {
  if (pw.DEVICES[device].hasTouch) {
    await page.touchscreen.tap(x, y);
  } else {
    await page.mouse.click(x, y);
  }
}

// Point inside the frame at image-relative coordinates (0-1).
async function framePoint(page, u, v) {
  const box = await page.locator("swatchroom-app .sr-frame").boundingBox();
  return { x: box.x + box.width * u, y: box.y + box.height * v };
}

async function pinch(page, cx, cy, from, to) {
  const client = await page.context().newCDPSession(page);
  const steps = 8;
  function points(distance) {
    return [
      { x: cx - distance / 2, y: cy, id: 1 },
      { x: cx + distance / 2, y: cy, id: 2 },
    ];
  }
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: points(from),
  });
  for (let index = 1; index <= steps; index += 1) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: points(from + ((to - from) * index) / steps),
    });
    await page.waitForTimeout(16);
  }
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

(async function () {
  const browser = await pw.launch();
  const made = await pw.newPage(browser, device);
  const page = made.page;
  const started = Date.now();
  await page.goto(url);
  await page.waitForSelector(
    "swatchroom-app .sr-empty, swatchroom-app .sr-gate",
    { timeout: 60000 },
  );
  if (await page.locator("swatchroom-app .sr-gate").count()) {
    // the server asks for a passcode (STUDIO_PASSCODE)
    await shot(page, "gate");
    await page.fill(
      "swatchroom-app #sr-passcode",
      process.env.STUDIO_PASSCODE || "",
    );
    await page.click('swatchroom-app button:has-text("Open the studio")');
  }
  await page.waitForSelector("swatchroom-app .sr-empty", { timeout: 20000 });
  await page.waitForTimeout(600);
  await shot(page, "empty");
  await page.setInputFiles(
    'swatchroom-app input[type=file][accept="image/*,.heic,.heif"]',
    path.join(__dirname, photo),
  );
  await page.waitForSelector("swatchroom-app .sr-frame", { timeout: 20000 });
  await page.waitForTimeout(1500);
  await shot(page, "scanning");
  const scanStart = Date.now();
  await page.waitForFunction(
    function () {
      const app = document.querySelector("swatchroom-app");
      return (
        !app.querySelector(".sr-scan-veil") &&
        (app.querySelector(".sr-surface") ||
          app.querySelector(".sr-chip") ||
          app.querySelector(".sr-problem"))
      );
    },
    null,
    { timeout: 300000 },
  );
  console.log("scan took", Date.now() - scanStart, "ms");
  await page.waitForTimeout(800);
  await shot(page, "scanned");

  // select the back wall by tapping the photo
  let point = await framePoint(page, 0.5, 0.25);
  await tapAt(page, point.x, point.y);
  await page.waitForTimeout(900);
  await shot(page, "wall-selected");

  // long-press / shift-click to add the left wall
  point = await framePoint(page, 0.12, 0.25);
  if (pw.DEVICES[device].hasTouch) {
    const client = await page.context().newCDPSession(page);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: point.x, y: point.y, id: 1 }],
    });
    await page.waitForTimeout(650);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } else {
    await page.keyboard.down("Shift");
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up("Shift");
  }
  await page.waitForTimeout(800);
  await shot(page, "two-walls");

  // pick a finish
  const tile = page
    .locator("swatchroom-app .sr-tile", { hasText: "Sage" })
    .first();
  await tile.scrollIntoViewIfNeeded();
  await tile.click();
  await page.waitForTimeout(400);
  await shot(page, "finish-chosen");

  await page.click("swatchroom-app .sr-button-render");
  await page.waitForTimeout(700);
  await shot(page, "rendering");
  await page.waitForFunction(
    function () {
      return !document.querySelector("swatchroom-app .sr-render-progress");
    },
    null,
    { timeout: 120000 },
  );
  await page.waitForTimeout(1500);
  await shot(page, "rendered");

  if (pw.DEVICES[device].hasTouch) {
    // pinch to zoom on the photo
    const box = await page.locator("swatchroom-app .sr-well").boundingBox();
    await pinch(page, box.x + box.width / 2, box.y + box.height / 2, 80, 260);
    await page.waitForTimeout(600);
    await shot(page, "pinched");
    const fit = page.locator("swatchroom-app .sr-fit-chip");
    if (await fit.count()) {
      await fit.click();
      await page.waitForTimeout(400);
    }
    // expand the sheet (phones in portrait; landscape uses a side panel)
    if (await page.locator("swatchroom-app .sr-sheet-grabber").count()) {
      await page.click("swatchroom-app .sr-sheet-grabber");
      await page.waitForTimeout(700);
      await shot(page, "sheet-expanded");
      await page.click("swatchroom-app .sr-sheet-grabber");
      await page.waitForTimeout(600);
    } else {
      const column = page.locator("swatchroom-app .sr-finishes.is-column");
      await column.evaluate(function (element) {
        element.scrollTop = element.scrollHeight;
      });
      await page.waitForTimeout(400);
      await shot(page, "panel-scrolled");
    }
  } else {
    await page.keyboard.press("c");
    await page.waitForTimeout(600);
    await shot(page, "compare");
    await page.keyboard.press("c");
  }

  // share dialog
  const shareButton = page
    .locator(
      'swatchroom-app .sr-bar button[aria-label="Share"], swatchroom-app .sr-bar button[aria-label="Export"]',
    )
    .first();
  await shareButton.click();
  await page.waitForTimeout(600);
  await shot(page, "share");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // materials
  if (!(await page.locator("swatchroom-app .sr-toolbar-button").count())) {
    await page.click('swatchroom-app .sr-bar button[aria-label="More"]');
    await page.waitForTimeout(300);
    await page.click("swatchroom-app .sr-menu-item >> text=Materials");
  } else {
    await page.click("swatchroom-app .sr-toolbar-button");
  }
  await page.waitForTimeout(800);
  await shot(page, "materials");
  await page.keyboard.press("Escape");
  console.log(device, "total", Math.round((Date.now() - started) / 1000), "s");
  const calls = await fetch(
    (process.env.MOCK_URL || "http://127.0.0.1:8790") + "/calls",
  )
    .then(function (response) {
      return response.json();
    })
    .catch(function () {
      return [];
    });
  console.log(
    "vertex calls",
    JSON.stringify(
      calls.map(function (call) {
        return call.model + ":" + call.kind;
      }),
    ),
  );
  await browser.close();
})().catch(function (error) {
  console.error("FLOW FAILED", error);
  process.exit(1);
});
