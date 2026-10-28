// Shared Playwright helpers for the Swatchroom walk-throughs.
const playwright = require("playwright");
const chromium = playwright.chromium;

const DEVICES = {
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  },
  phoneSmall: {
    viewport: { width: 360, height: 740 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 13; SM-A145) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  },
  phoneLand: {
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  },
  tablet: {
    viewport: { width: 820, height: 1180 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Tab) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  },
  laptop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  smallLaptop: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 },
};

async function launch() {
  return chromium.launch({
    // Playwright's own Chromium unless CHROMIUM_PATH points at another one.
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
}

async function newPage(browser, deviceName) {
  const context = await browser.newContext(DEVICES[deviceName]);
  const page = await context.newPage();
  page.on("console", function (message) {
    if (message.type() === "error" || message.type() === "warning") {
      console.log(
        "[" + deviceName + " console " + message.type() + "]",
        message.text().slice(0, 300),
      );
    }
  });
  page.on("pageerror", function (error) {
    console.log("[" + deviceName + " pageerror]", String(error).slice(0, 400));
  });
  return { context: context, page: page };
}

module.exports = { launch: launch, newPage: newPage, DEVICES: DEVICES };
