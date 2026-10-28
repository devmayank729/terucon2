/**
 * Headers every response carries, errors and refusals included.
 *  - nosniff and no-referrer: as before.
 *  - X-Frame-Options and frame-ancestors: no other site can show a page of ours inside a frame (clickjacking). Our own pages can.
 *    There is deliberately no wider Content-Security-Policy: the pages are Claude Design bundles that build themselves from
 *    inline scripts and styles, which a strict policy would break.
 *  - HSTS: only on an HTTPS request, so a browser that has met the site over HTTPS keeps using it. `req.secure` is true behind a
 *    proxy only when TRUST_PROXY is set (README).
 */
export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
}
