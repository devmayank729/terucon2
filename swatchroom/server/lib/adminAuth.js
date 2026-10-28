// Admin dashboard sign-in: a separate email+password, deliberately independent of the studio
// passcode (server/lib/access.js) - the two protect different things and either can be
// changed, disabled or rotated without touching the other. Same signed-cookie pattern as the
// studio passcode (see access.js's comment), just with its own cookie name and secret.
const crypto = require("crypto");
const config = require("../config");

const COOKIE = "swr_admin";
const attempts = new Map();
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function sign(text) {
  return crypto
    .createHmac("sha256", config.sessionSecret + ":admin")
    .update(text)
    .digest("base64url");
}

function makeCookieValue() {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + 7 * 86400000 }),
  ).toString("base64url");
  return payload + "." + sign(payload);
}

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

function sameText(first, second) {
  const a = Buffer.from(String(first));
  const b = Buffer.from(String(second));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isSignedIn(request) {
  const value = readCookies(request)[COOKIE];
  if (!value || value.indexOf(".") === -1) {
    return false;
  }
  const parts = value.split(".");
  if (parts.length !== 2 || !sameText(sign(parts[0]), parts[1])) {
    return false;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    return typeof payload.exp === "number" && payload.exp > Date.now();
  } catch (error) {
    return false;
  }
}

function useSecureCookie(request) {
  if (config.secureCookies === "true") {
    return true;
  }
  if (config.secureCookies === "false") {
    return false;
  }
  return request.secure;
}

function setCookie(request, response) {
  response.cookie(COOKIE, makeCookieValue(), {
    httpOnly: true,
    sameSite: "lax",
    secure: useSecureCookie(request),
    maxAge: 7 * 86400000,
    path: "/",
  });
}

function clearCookie(response) {
  response.clearCookie(COOKIE, { path: "/" });
}

function allowAttempt(request) {
  const key = request.ip || "unknown";
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter(function (time) {
    return now - time < ATTEMPT_WINDOW_MS;
  });
  attempts.set(key, recent);
  return recent.length < MAX_ATTEMPTS;
}

function recordFailure(request) {
  const key = request.ip || "unknown";
  const list = attempts.get(key) || [];
  list.push(Date.now());
  attempts.set(key, list);
}

function checkCredentials(email, password) {
  return (
    sameText((email || "").trim().toLowerCase(), config.admin.email.toLowerCase()) &&
    sameText(password || "", config.admin.password)
  );
}

function requireAdmin(request, response, next) {
  if (isSignedIn(request)) {
    next();
    return;
  }
  response.status(401).json({ error: "Sign in to the admin dashboard first." });
}

module.exports = {
  isSignedIn: isSignedIn,
  setCookie: setCookie,
  clearCookie: clearCookie,
  allowAttempt: allowAttempt,
  recordFailure: recordFailure,
  checkCredentials: checkCredentials,
  requireAdmin: requireAdmin,
};
