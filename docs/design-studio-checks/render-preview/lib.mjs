// Helpers shared by run-all.mjs, site-check.mjs and render.mjs (docs/design-studio-checks/render-preview/README.md).
// Everything here is read-only towards the project: the studio's files (swatchroom/), the overlay (site/overlays/studio/), the photos
// (media/) and the textures are only read; the Chrome profile and every picture go to a folder under the system's temp directory.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..', '..');
const needFromRepo = createRequire(path.join(REPO, 'package.json')); // pngjs: a dependency of the studio, installed by `npm install`
const needFromE2e = createRequire(path.join(REPO, 'tests', 'e2e', 'package.json')); // puppeteer-core: `cd tests/e2e && npm install`

const STUDIO_MODULES = path.join(REPO, 'swatchroom', 'public', 'js', 'lib', 'fastrender');
const OVERLAY_MODULES = path.join(REPO, 'site', 'overlays', 'studio', 'js', 'lib', 'fastrender');
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

/** A fresh folder for pictures and the browser profile, under the system's temp directory. */
export function makeWorkDir(prefix = 'terucon-render-preview-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function chromePath() {
  const found = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chrome was not found. Set CHROME_PATH to it.');
  return found;
}

/**
 * The check's own small web server (read-only). /real/<file> is the studio's own module, /overlay/<file> the module as the website
 * serves it (the overlay's file when there is one, else the studio's), /textures and /media are the studio's textures and the site's
 * photos, /h/ is the harness page. `port` 0 lets the system choose.
 */
export function startHarnessServer({ port = 0, extraMaps = [] } = {}) {
  const maps = [
    ...extraMaps, // e.g. ['/media/materials/', [folder]]: the catalogue designs' photographs at the address the website serves them (design-check.mjs)
    ['/real/', [STUDIO_MODULES]],
    ['/overlay/', [OVERLAY_MODULES, STUDIO_MODULES]],
    ['/textures/', [path.join(REPO, 'swatchroom', 'public', 'textures')]],
    ['/media/', [path.join(REPO, 'media')]],
    ['/h/', [path.join(HERE, 'harness')]],
  ];
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    for (const [prefix, dirs] of maps) {
      if (!url.startsWith(prefix)) continue;
      for (const dir of dirs) {
        const file = path.resolve(dir, url.slice(prefix.length));
        if (!file.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
        return fs.createReadStream(file).pipe(res);
      }
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) }));
  });
}

/** Chrome with WebGPU switched on (it is behind a flag in some versions). The profile lives in `workDir`. */
export async function openBrowser(workDir) {
  const puppeteer = needFromE2e('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    userDataDir: path.join(workDir, 'chrome-profile'),
    args: ['--no-sandbox', '--enable-unsafe-webgpu'],
    defaultViewport: { width: 1700, height: 1200 },
  });
  return browser;
}

/**
 * Draw one scene in the browser and read it back.
 * @param {import('puppeteer-core').Browser} browser
 * @param {{origin: string, query: Record<string, string>, fromSite?: boolean}} options
 *   `query`: root, scene, surface, geom, tex, backend, ... (harness/run.js). `fromSite`: `origin` is a running website, not this check's
 *   server: the harness page and its scenes are answered from this folder, and the modules, textures and photos come from the website.
 * @returns {Promise<{frame: Buffer, overlay: Buffer, info: object, problems: string[], scripts: {url: string, status: number, overlay: string | null}[]}>}
 */
export async function renderScene(browser, { origin, query, fromSite = false }) {
  const page = await browser.newPage();
  const problems = [];
  const scripts = [];
  try {
    page.on('console', (m) => {
      // "Failed to load resource" carries no address: the response handler below names it
      if (['error', 'warning'].includes(m.type()) && !/^Failed to load resource/.test(m.text())) problems.push(`${m.type()}: ${m.text().slice(0, 300)}`);
    });
    page.on('pageerror', (e) => problems.push(`script error: ${String(e).slice(0, 300)}`));
    page.on('response', (r) => {
      if (r.status() >= 400 && !/\/favicon\.ico$/.test(r.url())) problems.push(`http ${r.status()} ${r.url().replace(origin, '')}`);
      if (/\.js(\?|$)/.test(r.url())) scripts.push({ url: r.url().replace(origin, ''), status: r.status(), overlay: r.headers()['x-terucon-overlay'] ?? null });
    });
    if (fromSite) {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const url = new URL(req.url());
        if (url.origin === origin && url.pathname.startsWith('/h/')) {
          const file = path.resolve(HERE, 'harness', url.pathname.slice('/h/'.length));
          if (file.startsWith(path.join(HERE, 'harness') + path.sep) && fs.existsSync(file)) return req.respond({ status: 200, contentType: TYPES[path.extname(file)] || 'text/plain', body: fs.readFileSync(file) });
        }
        return req.continue();
      });
    }
    await page.goto(`${origin}/h/index.html?${new URLSearchParams(query)}`);
    await page.waitForFunction(() => document.title === 'done' || document.title === 'error', { timeout: 60000 });
    if ((await page.title()) === 'error') throw new Error('the page failed: ' + (await page.evaluate(() => document.getElementById('log').textContent)).trim().slice(0, 600));
    await new Promise((r) => setTimeout(r, 150));
    const frame = await (await page.$('#frame')).screenshot({ type: 'png' });
    const overlayUrl = await page.evaluate(() => window.__overlayPng);
    const info = await page.evaluate(() => window.__info);
    return { frame: Buffer.from(frame), overlay: Buffer.from(overlayUrl.split(',')[1], 'base64'), info, problems, scripts };
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------- numbers from two pictures
const readPng = (buffer) => needFromRepo('pngjs').PNG.sync.read(buffer);

/** Compare two renders (the transparent overlay read back from the canvas): on the pixels where either has any colour. */
export function pixelDiff(a, b) {
  const A = readPng(a);
  const B = readPng(b);
  if (A.width !== B.width || A.height !== B.height) return { error: `size mismatch ${A.width}x${A.height} vs ${B.width}x${B.height}` };
  let n = 0;
  let sum = 0;
  let max = 0;
  let over8 = 0;
  let over16 = 0;
  let onlyA = 0;
  let onlyB = 0;
  for (let i = 0; i < A.data.length; i += 4) {
    const aa = A.data[i + 3];
    const ba = B.data[i + 3];
    if (aa > 0 && ba === 0) onlyA += 1;
    if (ba > 0 && aa === 0) onlyB += 1;
    if (aa === 0 && ba === 0) continue;
    n += 1;
    let m = 0;
    for (let c = 0; c < 4; c += 1) m = Math.max(m, Math.abs(A.data[i + c] - B.data[i + c]));
    sum += m;
    if (m > max) max = m;
    if (m > 8) over8 += 1;
    if (m > 16) over16 += 1;
  }
  return { pixelsCompared: n, meanMaxChannelDiff: n ? +(sum / n).toFixed(3) : 0, maxDiff: max, pctOver8: n ? +((100 * over8) / n).toFixed(3) : 0, pctOver16: n ? +((100 * over16) / n).toFixed(3) : 0, onlyInA: onlyA, onlyInB: onlyB };
}

/**
 * How much of the photo's own sun / shade pattern survives on the painted pixels, and the colour of the light (red/green and blue/green
 * of the photo and of the render). `photo` and `composite` are the framed picture and the render over it; `overlay` is the canvas alone.
 */
export function lightMetrics(photo, composite, overlay) {
  const P = readPng(photo);
  const C = readPng(composite);
  const O = readPng(overlay);
  const W = O.width;
  const H = O.height;
  const lin = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const lum = (img) => {
    const out = new Float32Array(W * H);
    for (let i = 0; i < W * H; i += 1) out[i] = 0.2126 * lin(img.data[i * 4]) + 0.7152 * lin(img.data[i * 4 + 1]) + 0.0722 * lin(img.data[i * 4 + 2]);
    return out;
  };
  const box = (a, r) => {
    const tmp = new Float32Array(W * H);
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y += 1) {
      let s = 0;
      for (let k = -r; k <= r; k += 1) s += a[y * W + Math.min(W - 1, Math.max(0, k))];
      for (let x = 0; x < W; x += 1) {
        tmp[y * W + x] = s / (2 * r + 1);
        s += a[y * W + Math.min(W - 1, x + r + 1)] - a[y * W + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < W; x += 1) {
      let s = 0;
      for (let k = -r; k <= r; k += 1) s += tmp[Math.min(H - 1, Math.max(0, k)) * W + x];
      for (let y = 0; y < H; y += 1) {
        out[y * W + x] = s / (2 * r + 1);
        s += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
      }
    }
    return out;
  };
  if (P.width !== W || P.height !== H || C.width !== W || C.height !== H) return { error: `the photo (${P.width}x${P.height}), the render (${C.width}x${C.height}) and the canvas (${W}x${H}) must be one size: run with dpr=1 and the photo's width` };
  const lp = box(lum(P), 6);
  const lc = box(lum(C), 6);
  const idx = [];
  for (let i = 0; i < W * H; i += 1) {
    if (O.data[i * 4 + 3] === 255) {
      const x = i % W;
      const y = (i / W) | 0;
      if (x > 8 && y > 8 && x < W - 8 && y < H - 8) idx.push(i);
    }
  }
  if (!idx.length) return { painted: 0 };
  const xs = idx.map((i) => Math.log(lp[i]));
  const ys = idx.map((i) => Math.log(lc[i]));
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const quantile = (a, p) => a.slice().sort((u, v) => u - v)[Math.floor(p * (a.length - 1))];
  const ratio = (a) => +Math.exp(quantile(a, 0.9) - quantile(a, 0.1)).toFixed(2);
  const rgbMean = (img) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const i of idx) {
      r += lin(img.data[i * 4]);
      g += lin(img.data[i * 4 + 1]);
      b += lin(img.data[i * 4 + 2]);
    }
    return [r / idx.length, g / idx.length, b / idx.length];
  };
  const pr = rgbMean(P);
  const cr = rgbMean(C);
  return {
    painted: idx.length,
    corrLogLight: +(sxy / Math.sqrt(sxx * syy)).toFixed(3),
    sunShadeRatioP90_P10_photo: ratio(xs),
    sunShadeRatioP90_P10_render: ratio(ys),
    RG_photo: +(pr[0] / pr[1]).toFixed(3),
    RG_render: +(cr[0] / cr[1]).toFixed(3),
    BG_photo: +(pr[2] / pr[1]).toFixed(3),
    BG_render: +(cr[2] / cr[1]).toFixed(3),
  };
}

/** Tiles of pictures with a label each, as one JPEG (drawn by the browser: nothing else is needed). */
export async function makeGrid(browser, items, { scale = 0.6, cols = 2, quality = 0.82 } = {}) {
  const page = await browser.newPage();
  try {
    const images = items.map((i) => ({ label: i.label, b64: i.png.toString('base64') }));
    const dataUrl = await page.evaluate(
      async (imgs, sc, columns, q) => {
        const loaded = await Promise.all(imgs.map(async (i) => { const im = new Image(); im.src = 'data:image/png;base64,' + i.b64; await im.decode(); return im; }));
        const cw = Math.round(loaded[0].width * sc);
        const ch = Math.round(loaded[0].height * sc);
        const pad = 4;
        const lab = 18;
        const rows = Math.ceil(imgs.length / columns);
        const c = document.createElement('canvas');
        c.width = columns * (cw + pad) + pad;
        c.height = rows * (ch + lab + pad) + pad;
        const g = c.getContext('2d');
        g.fillStyle = '#111';
        g.fillRect(0, 0, c.width, c.height);
        g.font = '13px monospace';
        g.imageSmoothingQuality = 'high';
        loaded.forEach((im, i) => {
          const x = pad + (i % columns) * (cw + pad);
          const y = pad + Math.floor(i / columns) * (ch + lab + pad);
          g.drawImage(im, 0, 0, im.width, im.height, x, y + lab, cw, ch);
          g.fillStyle = '#fff';
          g.fillText(imgs[i].label, x + 2, y + 13);
        });
        return c.toDataURL('image/jpeg', q);
      },
      images,
      scale,
      cols,
      quality,
    );
    return Buffer.from(dataUrl.split(',')[1], 'base64');
  } finally {
    await page.close();
  }
}
