// The surface outlines on the photo must be drawn at the screen's own pixel density and must stay
// drawn. Regression test for a bug that only showed on phones: every studio re-render stripped the
// overlay canvas's width/height attributes (core/dom.js), which reset it to 300 x 150 and blanked
// it; with no mouse hover to redraw it, the outlines vanished after the scan or were redrawn tiny
// and stretched over the photo. Also checks that the owner's dot is NOT drawn for an ordinary visitor.
// usage: node overlay_flow.js <device> [url] [photo]      (same setup as flow.js)
const pw = require("./pw");
const path = require("path");

const device = process.argv[2] || "phone";
const url = process.argv[3] || process.env.SWATCHROOM_URL || "http://127.0.0.1:3000/studio";
const photo = process.argv[4] || "room-port.jpg";
const failures = [];

function check(name, ok, detail) {
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + (detail || "")));
  if (!ok) {
    failures.push(name);
  }
}

// The overlay canvas against the frame it covers: its buffer size and how many pixels are painted.
async function overlay(page) {
  return page.evaluate(function () {
    const stage = document.querySelector("swatchroom-app").studio.stage;
    const canvas = stage.canvasElement;
    const frame = stage.frameElement.getBoundingClientRect();
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] > 0) {
        painted += 1;
      }
    }
    return {
      width: canvas.width,
      height: canvas.height,
      frameWidth: frame.width,
      frameHeight: frame.height,
      ratio: window.devicePixelRatio || 1,
      painted: painted,
    };
  });
}

function atScreenDensity(state) {
  const expected = state.frameWidth * Math.min(state.ratio, 4096 / Math.max(state.frameWidth, state.frameHeight));
  return Math.abs(state.width - expected) <= 3;
}

(async function () {
  const browser = await pw.launch();
  const made = await pw.newPage(browser, device);
  const page = made.page;
  await page.goto(url);
  await page.waitForSelector("swatchroom-app .sr-empty, swatchroom-app .sr-gate", { timeout: 60000 });
  if (await page.locator("swatchroom-app .sr-gate").count()) {
    await page.fill("swatchroom-app #sr-passcode", process.env.STUDIO_PASSCODE || "");
    await page.click('swatchroom-app button:has-text("Open the studio")');
  }
  await page.waitForSelector("swatchroom-app .sr-empty", { timeout: 20000 });
  await page.setInputFiles(
    'swatchroom-app input[type=file][accept="image/*,.heic,.heif"]',
    path.resolve(__dirname, photo),
  );
  await page.waitForSelector("swatchroom-app .sr-frame", { timeout: 20000 });
  await page.waitForFunction(
    function () {
      const app = document.querySelector("swatchroom-app");
      return (
        !app.querySelector(".sr-scan-veil") &&
        (app.querySelector(".sr-surface") || app.querySelector(".sr-chip") || app.querySelector(".sr-problem"))
      );
    },
    null,
    { timeout: 300000 },
  );
  await page.waitForTimeout(1200);

  let state = await overlay(page);
  check("the outlines are drawn as soon as the scan is done (no tap needed)", state.painted > 1000, JSON.stringify(state));
  check("the overlay is at the screen's pixel density", atScreenDensity(state), JSON.stringify(state));

  // anything that re-renders the studio (the room pipeline's status polling does it every 1.5 s)
  await page.evaluate(function () {
    document.querySelector("swatchroom-app").studio.requestRender();
  });
  await page.waitForTimeout(400);
  state = await overlay(page);
  check("a plain re-render does not blank or shrink the overlay", state.painted > 1000 && atScreenDensity(state), JSON.stringify(state));

  const box = await page.locator("swatchroom-app .sr-frame").boundingBox();
  const x = box.x + box.width * 0.5;
  const y = box.y + box.height * 0.7;
  if (pw.DEVICES[device].hasTouch) {
    await page.touchscreen.tap(x, y);
  } else {
    await page.mouse.click(x, y);
  }
  await page.waitForTimeout(700);
  await page.evaluate(function () {
    document.querySelector("swatchroom-app").studio.requestRender();
  });
  await page.waitForTimeout(400);
  state = await overlay(page);
  check("a selected surface stays drawn through a re-render", state.painted > 1000 && atScreenDensity(state), JSON.stringify(state));
  await page.waitForTimeout(1500);
  state = await overlay(page);
  check("and while its outline is animating", state.painted > 1000 && atScreenDensity(state), JSON.stringify(state));

  check("the owner's dot is not drawn for an ordinary visitor", (await page.locator(".sr-owner-dot").count()) === 0);

  await browser.close();
  console.log(failures.length ? "\nFAILED: " + failures.join("; ") : "\nall overlay checks passed");
  process.exit(failures.length ? 1 : 0);
})().catch(function (error) {
  console.error(error);
  process.exit(1);
});
