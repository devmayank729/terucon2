/**
 * One spelling of /api.
 *
 * The Design Studio is a separate Express app, and Express matches routes without regard to capitals unless told otherwise. This
 * server's own routing is case sensitive, and so is every protection in front of the studio (the JSON-only and Origin guards,
 * the rate limits and room ownership of studioShield, the sign-in gate): they all look for "/api/". So a request to /API/rooms or
 * /Api/ai/... used to slide past all of them and be answered by the studio. (Found by sending exactly that: five writes to
 * /api/rooms/... were stopped after two, five to /API/rooms/... never were.)
 *
 * The cure is not to make every protection case-insensitive but to make sure only one spelling can reach them: a path that is
 * "/api" in any other capitals is answered 404 here, before anything else looks at it. Other tricks (a double slash, an encoded
 * letter, dot segments) never matched the studio's routes at all; tests/js/auth-attacks.test.js proves it.
 */
import { sendError } from '../lib/errors.js';

const API_ANY_CASE = /^\/api(?:\/|$)/i;
const API_EXACT = /^\/api(?:\/|$)/;

export function canonicalApiPath(req, res, next) {
  if (API_ANY_CASE.test(req.path) && !API_EXACT.test(req.path)) return sendError(res, 404, 'No such API route.');
  return next();
}
