// Gives every browser an anonymous id, so the admin dashboard can count "how many people are
// live" and attribute log lines to a visitor without anyone signing in. Not a security
// boundary (unlike the passcode or admin cookies) - just a counting tag, so it is a plain
// readable cookie with a long lifetime.
const crypto = require("crypto");

const COOKIE = "swr_vid";
const MAX_AGE_MS = 400 * 86400000;

function readCookies(request) {
  const header = request.headers.cookie || "";
  const cookies = {};
  header.split(";").forEach(function (part) {
    const index = part.indexOf("=");
    if (index > 0) {
      cookies[part.slice(0, index).trim()] = decodeURIComponent(
        part.slice(index + 1).trim(),
      );
    }
  });
  return cookies;
}

// Express middleware: ensures request.visitorId is set (and the cookie exists for next time).
function tagVisitor(request, response, next) {
  const existing = readCookies(request)[COOKIE];
  const visitorId =
    existing && /^[a-f0-9]{32}$/.test(existing)
      ? existing
      : crypto.randomBytes(16).toString("hex");
  request.visitorId = visitorId;
  if (existing !== visitorId) {
    response.cookie(COOKIE, visitorId, {
      httpOnly: false,
      sameSite: "lax",
      maxAge: MAX_AGE_MS,
      path: "/",
    });
  }
  next();
}

module.exports = { tagVisitor: tagVisitor };
