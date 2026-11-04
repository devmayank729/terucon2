/**
 * The Design Studio's instant-preview quality overlay: improved copies of a few of the studio's browser files, served ahead of the
 * studio's own, so swatchroom/ (the copy of the user's separate Swatchroom project) is not edited.
 *
 * The folder site/overlays/studio/js/ mirrors swatchroom/public/js/. Whatever file is in it is served at the same address
 * (site/overlays/studio/js/lib/previewScene.js answers /js/lib/previewScene.js); every other studio file keeps coming from swatchroom/.
 * Mount it at /js in front of the studio's own handler (app.js: app.use('/js', overlay)). Like the website's other files it is served
 * from a FIXED LIST of names, here the files found in that folder when the server starts: a request is answered only when its path is
 * exactly one of them (GET or HEAD); everything else, whatever it looks like, falls through. The studio's browser code imports those
 * files by relative address, so nothing in swatchroom/ changes.
 *
 * Switch it off with STUDIO_PREVIEW_OVERLAY=off (read on every request, so saving .env is enough); remove it by deleting the folder
 * (with no folder this is a silent no-op, and so is every test project that has no site/overlays/). What is overlaid, why, and how it
 * is kept honest when swatchroom/ is re-copied: docs/DESIGN_STUDIO_ARCHITECTURE.md, section 12, and tests/js/studio-overlay.test.js.
 *
 * The files go out with the studio's own policy for its /js files (swatchroom/server/index.js: Cache-Control: no-cache, plus the weak
 * ETag and Last-Modified that Express's file sending adds, which is what the studio's own static handler uses too): the browser asks
 * each time and gets a cheap 304. Switching the overlay off therefore shows the studio's own file on the next load, with no stale copy
 * left in the browser. `X-Terucon-Overlay` says which answers came from here (the studio's own never carry it).
 */
import fs from 'node:fs';
import path from 'node:path';

/** The header an overlaid file carries (and the studio's own never does). */
export const OVERLAY_HEADER = 'X-Terucon-Overlay';
export const OVERLAY_NAME = 'studio-preview';

/** Every file below `dir`, as paths relative to it with forward slashes, sorted. Names that start with a dot (.DS_Store, ...) are not files of the overlay. */
export function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

/**
 * @param {object} options
 * @param {string} options.root the project folder (the overlay is <root>/site/overlays/studio)
 * @param {() => boolean} [options.enabled] asked on every request; false = the studio's own files are served (default: on)
 * @returns {import('express').RequestHandler & {dir: string, files: string[], present: boolean, enabled: () => boolean}}
 *   `files` are the overlaid addresses, e.g. '/js/lib/previewScene.js'; with no overlay folder `present` is false and the handler passes everything on.
 *   Mount it with app.use('/js', overlay).
 */
export function studioOverlay({ root, enabled = () => true }) {
  const dir = path.join(path.resolve(root), 'site', 'overlays', 'studio');
  const jsDir = path.join(dir, 'js');
  const relative = listFiles(jsDir);
  const byPath = new Map(relative.map((file) => [`/${file}`, path.join(jsDir, ...file.split('/'))])); // the address below /js -> the file
  const files = relative.map((file) => `/js/${file}`);
  const handler = (req, res, next) => {
    const file = req.method === 'GET' || req.method === 'HEAD' ? byPath.get(req.path) : undefined;
    if (!file || !enabled()) return next();
    return res.sendFile(file, { cacheControl: false, headers: { 'Cache-Control': 'no-cache', [OVERLAY_HEADER]: OVERLAY_NAME } }, (error) => {
      if (error && !res.headersSent) next(error.code === 'ENOENT' ? undefined : error); // a file that vanished falls through to the studio's own
    });
  };
  return Object.assign(handler, { dir, files, present: byPath.size > 0, enabled });
}
