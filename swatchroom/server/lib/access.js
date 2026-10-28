// Optional studio passcode. When STUDIO_PASSCODE is set, the studio asks for it once and the
// server remembers the browser with a signed cookie (like a wristband at an event: shown at
// every request, and it cannot be forged without the server's secret).
const crypto = require("crypto");
const config = require("../config");

const COOKIE = "swr_session";
const attempts = new Map();
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function sign(text) {
  return crypto
    .createHmac("sha256", config.sessionSecret)
    .update(text)
    .digest("base64url");
}

function makeCookieValue() {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + config.sessionDays * 86400000 }),
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

function hasValidCookie(request) {
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

function isSignedIn(request) {
  return !config.passcode || hasValidCookie(request);
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
    maxAge: config.sessionDays * 86400000,
    path: "/",
  });
}

function clearCookie(response) {
  response.clearCookie(COOKIE, { path: "/" });
}

// Too many wrong passcodes from one address: wait ten minutes.
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

function checkPasscode(given) {
  return !!config.passcode && sameText(given || "", config.passcode);
}

// Express middleware for every /api route except the session ones.
function requireAccess(request, response, next) {
  if (isSignedIn(request)) {
    next();
    return;
  }
  response
    .status(401)
    .json({ error: "Enter the studio passcode first.", code: "passcode" });
}

module.exports = {
  isSignedIn: isSignedIn,
  setCookie: setCookie,
  clearCookie: clearCookie,
  allowAttempt: allowAttempt,
  recordFailure: recordFailure,
  checkPasscode: checkPasscode,
  requireAccess: requireAccess,
};
