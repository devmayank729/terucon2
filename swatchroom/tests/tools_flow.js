// Tools, persistence, exports and failure paths.
// usage: node tools_flow.js <device> [url]
const pw = require("./pw");
const path = require("path");
const fs = require("fs");

const device = process.argv[2] || "laptop";
const url =
  process.argv[3] ||
  process.env.SWATCHROOM_URL ||
  "http://127.0.0.1:3000/studio";
const outDir = path.join(__dirname, "shots-tools");
fs.mkdirSync(outDir, { recursive: true });
const touch = !!pw.DEVICES[device].hasTouch;
let step = 0;

async function shot(page, name) {
  step += 1;
  const file = path.join(
    outDir,
    device + "-" + String(step).padStart(2, "0") + "-" + name + ".png",
  );
  await page.screenshot({ path: file });
  console.log("shot", path.basename(file));
}

async function tap(page, x, y) {
  if (touch) {
    await page.touchscreen.tap(x, y);
  } else {
    await page.mouse.click(x, y);
  }
}

async function framePoint(page, u, v) {
  const box = await page.locator("swatchroom-app .sr-frame").boundingBox();
  return { x: box.x + box.width * u, y: box.y + box.height * v };
}

async function connect(page) {
  await page.goto(url);
  await page.waitForSelector(
    "swatchroom-app .sr-empty, swatchroom-app .sr-gate",
    { timeout: 60000 },
  );
  if (await page.locator("swatchroom-app .sr-gate").count()) {
    await page.fill(
      "swatchroom-app #sr-passcode",
      process.env.STUDIO_PASSCODE || "",
    );
    await page.click('swatchroom-app button:has-text("Open the studio")');
    await page.waitForSelector("swatchroom-app .sr-empty", { timeout: 20000 });
  }
}

async function waitScan(page) {
  await page.waitForFunction(
    function () {
      const app = document.querySelector("swatchroom-app");
      return (
        app.querySelector(".sr-frame") &&
        !app.querySelector(".sr-scan-veil") &&
        (app.querySelector(".sr-surface") ||
          app.querySelector(".sr-chip") ||
          app.querySelector(".sr-problem"))
      );
    },
    null,
    { timeout: 300000 },
  );
  await page.waitForTimeout(600);
}

async function chooseTool(page, name) {
  const button = page
    .locator("swatchroom-app .sr-tool", { hasText: name })
    .first();
  await button.click();
  await page.waitForTimeout(300);
}

(async function () {
  const browser = await pw.launch();
  const made = await pw.newPage(browser, device);
  const page = made.page;
  const context = made.context;
  await connect(page);
  await page.setInputFiles(
    'swatchroom-app input[type=file][accept="image/*,.heic,.heif"]',
    path.join(__dirname, "room-land.jpg"),
  );
  await waitScan(page);
  await shot(page, "scanned");

  // ---- Outline tool: add the rug as a custom area
  await chooseTool(page, "Outline");
  const corners = [
    [0.36, 0.86],
    [0.64, 0.86],
    [0.7, 0.98],
    [0.3, 0.98],
  ];
  for (const corner of corners) {
    const point = await framePoint(page, corner[0], corner[1]);
    await tap(page, point.x, point.y);
    await page.waitForTimeout(150);
  }
  await shot(page, "outline-points");
  await page.click('swatchroom-app .sr-tool-options button:text-is("Finish")');
  await page.waitForTimeout(700);
  await shot(page, "outline-done");

  // ---- Brush: erase part of the selected custom area
  if (touch) {
    // the sheet now shows finishes for the new area; edit its shape from the header
    await page.click(
      'swatchroom-app button[aria-label="Edit the shape of this surface"]',
    );
    await page.waitForTimeout(300);
  } else {
    await chooseTool(page, "Brush");
  }
  const from = await framePoint(page, 0.4, 0.9);
  const to = await framePoint(page, 0.6, 0.92);
  if (touch) {
    const client = await context.newCDPSession(page);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: from.x, y: from.y, id: 1 }],
    });
    for (let index = 1; index <= 10; index += 1) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: from.x + ((to.x - from.x) * index) / 10,
            y: from.y + ((to.y - from.y) * index) / 10,
            id: 1,
          },
        ],
      });
    }
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } else {
    await page.click('swatchroom-app .sr-tool-options button:text-is("Erase")');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.mouse.up();
  }
  await page.waitForTimeout(500);
  await shot(page, "brushed");
  await page.click('swatchroom-app .sr-tool-options button:text-is("Done")');
  await page.waitForTimeout(300);

  // ---- Pick (SlimSAM in the browser)
  if (touch) {
    await page.click('swatchroom-app button[aria-label="Close finishes"]');
    await page.waitForTimeout(400);
  }
  await chooseTool(page, "Pick");
  await page.waitForFunction(
    function () {
      const text = document.querySelector(
        "swatchroom-app .sr-tool-options-text",
      );
      return (
        text &&
        (/Tap the thing|Click the thing/.test(text.textContent) ||
          /could not start/.test(text.textContent))
      );
    },
    null,
    { timeout: 240000 },
  );
  let point = await framePoint(page, 0.5, 0.45);
  await tap(page, point.x, point.y);
  await page.waitForFunction(
    function () {
      const text = document.querySelector(
        "swatchroom-app .sr-tool-options-text",
      );
      return (
        text &&
        /point/.test(text.textContent) &&
        !/Updating/.test(text.textContent)
      );
    },
    null,
    { timeout: 120000 },
  );
  await page.waitForTimeout(400);
  await shot(page, "pick-preview");
  await page.click(
    'swatchroom-app .sr-tool-options button:text-is("New surface")',
  );
  await page.waitForTimeout(700);
  await shot(page, "pick-accepted");

  // ---- Undo / redo
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+z" : "Control+z",
  );
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(300);

  // ---- Render with a 429 once (retry), 2 options, floor finish
  await fetch(
    (process.env.MOCK_URL || "http://127.0.0.1:8790") + "/reset",
  ).catch(function () {});
  point = await framePoint(page, 0.15, 0.95);
  await tap(page, point.x, point.y);
  await page.waitForTimeout(600);
  const tile = page
    .locator("swatchroom-app .sr-tile", { hasText: "Herringbone oak" })
    .first();
  if (await tile.count()) {
    await tile.scrollIntoViewIfNeeded();
    await tile.click();
  } else {
    await page.locator("swatchroom-app .sr-tile").nth(1).click();
  }
  if (!touch) {
    await page
      .locator("swatchroom-app .sr-segment", { hasText: "2" })
      .first()
      .click();
  }
  await page.click("swatchroom-app .sr-button-render");
  await page.waitForFunction(
    function () {
      return !document.querySelector("swatchroom-app .sr-render-progress");
    },
    null,
    { timeout: 180000 },
  );
  await page.waitForTimeout(1200);
  await shot(page, "floor-rendered");

  // ---- Product dialog
  if (!touch) {
    const current = page.locator("swatchroom-app .sr-current-product");
    if (await current.count()) {
      await current.click();
      await page.waitForTimeout(700);
      await shot(page, "product");
      await page.keyboard.press("Escape");
    }
  }

  // ---- Exports: design board and before/after downloads
  const shareButton = page
    .locator(
      'swatchroom-app .sr-bar button[aria-label="Share"], swatchroom-app .sr-bar button[aria-label="Export"]',
    )
    .first();
  for (const which of ["Design board", "Before and after"]) {
    await shareButton.click();
    await page.waitForTimeout(400);
    const downloadPromise = page.waitForEvent("download", { timeout: 60000 });
    await page.click("swatchroom-app .sr-share-option >> text=" + which);
    const download = await downloadPromise;
    const target = path.join(
      outDir,
      device + "-" + download.suggestedFilename(),
    );
    await download.saveAs(target);
    console.log("downloaded", path.basename(target), fs.statSync(target).size);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }

  // ---- Settings check
  if (touch) {
    await page.click('swatchroom-app .sr-bar button[aria-label="More"]');
    await page.click("swatchroom-app .sr-menu-item >> text=Settings");
  } else {
    await page.click('swatchroom-app .sr-bar button[aria-label="Settings"]');
  }
  await page.waitForTimeout(400);
  await page.click("swatchroom-app .sr-tab >> text=Check");
  await page.click("swatchroom-app >> text=Check everything");
  await page.waitForFunction(
    function () {
      return document.querySelectorAll("swatchroom-app .sr-check").length >= 6;
    },
    null,
    { timeout: 60000 },
  );
  await page.waitForTimeout(500);
  await shot(page, "settings-check");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);

  // ---- Persistence: reload and reopen the room (saved in MongoDB)
  await page.reload();
  await page.waitForSelector("swatchroom-app .sr-recent-open", {
    timeout: 30000,
  });
  await shot(page, "recent-rooms");
  await page.click("swatchroom-app .sr-recent-open");
  await page.waitForSelector("swatchroom-app .sr-frame", { timeout: 30000 });
  await page.waitForTimeout(2000);
  const restored = await page.evaluate(function () {
    return {
      films: document.querySelectorAll("swatchroom-app .sr-film").length,
      chip:
        (document.querySelector("swatchroom-app .sr-version-chip") || {})
          .textContent || "",
      surfaces: document.querySelectorAll(
        "swatchroom-app .sr-surface, swatchroom-app .sr-chip",
      ).length,
    };
  });
  console.log("restored room:", JSON.stringify(restored));
  await shot(page, "room-reopened");
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
    "calls",
    JSON.stringify(
      calls.map(function (call) {
        return call.model + ":" + call.kind;
      }),
    ),
  );
  await browser.close();
})().catch(function (error) {
  console.error("TOOLS FLOW FAILED", error);
  process.exit(1);
});
