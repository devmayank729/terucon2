/**
 * Compression for the answers nothing precompressed: the hand-written pages, the JSON API and the Design Studio's own files
 * (swatchroom/server serves its /js, /css, /admin and /api itself and may not be edited, so it is wrapped from outside, here,
 * before it).
 *
 * The `compression` package does the work (brotli when the client accepts it, else gzip). Brotli runs at quality 5, not the
 * package's 4 and not the 11 of the build: measured on the studio's 125 KB studio.js, quality 4 made 32.3 KB (bigger than gzip's
 * 31.1 KB), quality 5 made 29.8 KB in 1.5 ms; quality 11 is for files compressed once at build time, not for answers made on every request).
 * What is added around it:
 *  - Smaller than 1 KB: left alone (compression would make it bigger or no smaller).
 *  - Already-compressed types (images, video, fonts, PDFs, zip) are never touched: `compressible` knows them by type.
 *  - Left alone on purpose: a response that already has a Content-Encoding (the built pages and assets carry their own
 *    .br / .gz copy and say so), one that marked itself `res.locals.skipCompression` (the same code, for the plain copy that has a
 *    strong ETag, which a transformed body must not keep), `Cache-Control: no-transform`, a 206 / Content-Range answer (compressing
 *    a byte range corrupts it), HEAD, 304, and a live event stream (compression would hold it back).
 *  - Validators: the studio's files keep their weak ETag and Last-Modified (a weak tag stays true for a compressed copy); the JSON API
 *    has no ETag by design (app.js); `Vary: Accept-Encoding` is added by the package to every compressible answer.
 */
import compression from 'compression';
import zlib from 'node:zlib';

export const COMPRESS_THRESHOLD = '1kb';
export const BROTLI_QUALITY = 5;

/** @returns {import('express').RequestHandler} */
export function compress() {
  return compression({
    threshold: COMPRESS_THRESHOLD,
    brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } },
    filter(req, res) {
      if (res.locals?.skipCompression) return false;
      if (res.statusCode === 206 || res.getHeader('Content-Range')) return false;
      if (String(res.getHeader('Content-Type') ?? '').startsWith('text/event-stream')) return false;
      return compression.filter(req, res);
    },
  });
}
