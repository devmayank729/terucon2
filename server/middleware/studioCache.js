/**
 * Cache policy for the Design Studio's files, from outside (swatchroom/ is a verbatim copy and is never edited).
 *
 * The studio's own static handler (swatchroom/server/index.js) sends `no-cache` for everything but .woff2 (a year, immutable).
 * `no-cache` plus the validators it also sends (ETag, Last-Modified) is the right thing for its /js and /css and /admin: those
 * file names carry no hash, so a browser must ask each time, and the answer is a cheap 304. It is poor for /textures: about 60 PNG
 * of 150-700 KB, loaded one by one as finishes are picked, that change almost never. Each one cost a round trip on every visit.
 *
 * So for the paths in `longLived` a `Cache-Control: no-cache` the studio set is replaced by the policy below, on a 200 or 304 only (an error is
 * never given a lifetime) and only when the studio asked for no-cache (its immutable fonts are left as they are).
 */

/** Textures are not content-hashed, so not `immutable`: a changed texture shows up within a week. */
export const TEXTURE_CACHE = 'public, max-age=604800';

/**
 * @param {string[]} prefixes URL prefixes, e.g. ['/textures']
 * @param {string} policy the Cache-Control value to use
 */
export function longLived(prefixes, policy) {
  return (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !prefixes.some((p) => req.path.startsWith(`${p}/`))) return next();
    const writeHead = res.writeHead;
    // The studio sets its headers while the file is being sent, after this middleware has run: change them as they go out.
    res.writeHead = function patchedWriteHead(...args) {
      const status = typeof args[0] === 'number' ? args[0] : this.statusCode;
      if ((status === 200 || status === 304) && String(this.getHeader('Cache-Control')).toLowerCase() === 'no-cache') this.setHeader('Cache-Control', policy);
      return writeHead.apply(this, args);
    };
    next();
  };
}
