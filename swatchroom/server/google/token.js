// Google access tokens for Vertex AI.
//
// With a service-account key the server signs a short JWT with the key (RS256) and trades it
// at Google's token endpoint for an access token that lasts an hour. Think of the key as an
// ID card and the token as a day pass: the card never leaves the server, the pass is shown at
// every request and renewed a couple of minutes before it runs out.
//
// Without a key, on Google Cloud, the metadata server hands out tokens for the machine's own
// service account.
const crypto = require("crypto");
const config = require("../config");

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const REFRESH_EARLY_SECONDS = 120;
const METADATA_HOST = "http://metadata.google.internal";

let token = null;
let expiresAt = 0;
let pending = null;
let metadataProjectId = "";

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signAssertion(account, tokenUrl) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  if (account.privateKeyId) {
    header.kid = account.privateKeyId;
  }
  const claims = {
    iss: account.clientEmail,
    scope: SCOPE,
    aud: account.tokenUri,
    iat: now,
    exp: now + 3600,
  };
  const unsigned =
    base64Url(JSON.stringify(header)) + "." + base64Url(JSON.stringify(claims));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  let signature;
  try {
    signature = signer.sign(account.privateKey);
  } catch (error) {
    throw new Error(
      "The private key in the Google key file could not be read. Create a new JSON key for the service account.",
    );
  }
  return unsigned + "." + base64Url(signature);
}

function tokenErrorMessage(body, status) {
  const code = body && body.error ? String(body.error) : "http_" + status;
  const description =
    body && body.error_description ? String(body.error_description) : "";
  if (description.indexOf("Invalid JWT Signature") !== -1) {
    return "Google rejected the key signature. The key was probably deleted or disabled; create a new JSON key.";
  }
  if (
    description.indexOf("reasonable timeframe") !== -1 ||
    description.indexOf("iat") !== -1
  ) {
    return "Google rejected the token time. The server clock is off; turn on automatic time sync.";
  }
  if (code === "invalid_grant") {
    return (
      "Google rejected this service account (" +
      (description || "invalid_grant") +
      "). Check that it still exists and is enabled."
    );
  }
  return (
    "Token request failed: " +
    code +
    (description ? " (" + description + ")" : "") +
    "."
  );
}

async function tokenFromKey(account) {
  const tokenUrl = config.google.tokenUrl || account.tokenUri;
  const form = new URLSearchParams();
  form.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  form.set("assertion", signAssertion(account, tokenUrl));
  let response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch (error) {
    throw new Error(
      "The server could not reach Google to sign in. Check its internet connection.",
    );
  }
  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
  }
  if (!response.ok || !body || !body.access_token) {
    throw new Error(tokenErrorMessage(body, response.status));
  }
  return body;
}

async function tokenFromMetadata() {
  let response;
  try {
    response = await fetch(
      METADATA_HOST +
        "/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } },
    );
  } catch (error) {
    throw new Error(
      "No Google key is configured. Set GOOGLE_APPLICATION_CREDENTIALS in .env (see README).",
    );
  }
  if (!response.ok) {
    throw new Error(
      "The Google Cloud metadata server refused a token (" +
        response.status +
        ").",
    );
  }
  return response.json();
}

// "auto" uses the metadata server only where it exists: Cloud Run, App Engine, Functions.
function canUseMetadata() {
  const flag = config.google.useMetadataServer;
  if (config.google.account || flag === "false") {
    return false;
  }
  if (flag === "true") {
    return true;
  }
  return !!(
    process.env.K_SERVICE ||
    process.env.GAE_SERVICE ||
    process.env.FUNCTION_TARGET
  );
}

async function fetchToken() {
  let body;
  if (config.google.account) {
    body = await tokenFromKey(config.google.account);
  } else if (canUseMetadata()) {
    body = await tokenFromMetadata();
  } else {
    throw new Error(
      config.google.problem ||
        "No Google key is configured. Set GOOGLE_APPLICATION_CREDENTIALS in .env (see README).",
    );
  }
  token = body.access_token;
  const lifetime = typeof body.expires_in === "number" ? body.expires_in : 3600;
  expiresAt = Date.now() + (lifetime - REFRESH_EARLY_SECONDS) * 1000;
  return token;
}

// One valid token; callers that arrive together share one refresh.
async function getToken() {
  if (token && Date.now() < expiresAt) {
    return token;
  }
  if (pending) {
    return pending;
  }
  pending = fetchToken();
  try {
    return await pending;
  } finally {
    pending = null;
  }
}

function invalidate() {
  token = null;
  expiresAt = 0;
}

async function projectId() {
  if (config.google.projectId) {
    return config.google.projectId;
  }
  if (metadataProjectId) {
    return metadataProjectId;
  }
  if (!canUseMetadata()) {
    return "";
  }
  try {
    const response = await fetch(
      METADATA_HOST + "/computeMetadata/v1/project/project-id",
      { headers: { "Metadata-Flavor": "Google" } },
    );
    if (response.ok) {
      metadataProjectId = (await response.text()).trim();
    }
  } catch (error) {
    metadataProjectId = "";
  }
  return metadataProjectId;
}

// What the studio shows about the Google connection (never the key itself).
function describe() {
  if (config.google.account) {
    return {
      configured: true,
      kind: "key",
      projectId: config.google.projectId,
      clientEmail: config.google.account.clientEmail,
      problem: "",
    };
  }
  return {
    configured: canUseMetadata() && !config.google.problem,
    kind: canUseMetadata() ? "metadata" : "none",
    projectId: config.google.projectId,
    clientEmail: "",
    problem: config.google.problem,
  };
}

module.exports = {
  getToken: getToken,
  invalidate: invalidate,
  projectId: projectId,
  describe: describe,
};
