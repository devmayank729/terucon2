// Everything the server needs from the environment (.env), read once at start-up.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

function text(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value.trim();
}

function number(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// The Google service-account key: a file path, or the JSON itself in one variable.
function readServiceAccount() {
  const inline = text("GOOGLE_SERVICE_ACCOUNT_JSON", "");
  const file = text("GOOGLE_APPLICATION_CREDENTIALS", "");
  let raw = "";
  let source = "";
  if (inline) {
    raw = inline;
    source = "GOOGLE_SERVICE_ACCOUNT_JSON";
  } else if (file) {
    const fullPath = path.isAbsolute(file)
      ? file
      : path.join(__dirname, "..", file);
    try {
      raw = fs.readFileSync(fullPath, "utf8");
      source = fullPath;
    } catch (error) {
      return {
        account: null,
        problem:
          "GOOGLE_APPLICATION_CREDENTIALS points to " +
          fullPath +
          ", which could not be read.",
      };
    }
  } else {
    return { account: null, problem: "" };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      account: null,
      problem: "The Google key in " + source + " is not valid JSON.",
    };
  }
  if (
    !parsed ||
    parsed.type !== "service_account" ||
    !parsed.private_key ||
    !parsed.client_email
  ) {
    return {
      account: null,
      problem:
        "The Google key in " +
        source +
        " is not a service-account key (it needs type, private_key and client_email).",
    };
  }
  return {
    account: {
      projectId: parsed.project_id || "",
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
      privateKeyId: parsed.private_key_id || "",
      tokenUri: parsed.token_uri || "https://oauth2.googleapis.com/token",
    },
    problem: "",
  };
}

const serviceAccount = readServiceAccount();
const passcode = text("STUDIO_PASSCODE", "");

const config = {
  port: number("PORT", 3000),
  host: text("HOST", "0.0.0.0"),
  mongoUri: text("MONGODB_URI", "mongodb://127.0.0.1:27017/swatchroom"),

  google: {
    account: serviceAccount.account,
    problem: serviceAccount.problem,
    // On Google Cloud (Cloud Run, GCE) the server can use its own identity instead of a key.
    useMetadataServer: text("GOOGLE_USE_METADATA_SERVER", "auto"),
    projectId: text(
      "GOOGLE_CLOUD_PROJECT",
      serviceAccount.account ? serviceAccount.account.projectId : "",
    ),
    location: text("VERTEX_LOCATION", "global"),
    // Overrides for tests (point both at a mock server).
    tokenUrl: text("GOOGLE_TOKEN_URL", ""),
    vertexBaseUrl: text("VERTEX_BASE_URL", ""),
  },

  models: {
    url: text("MODEL_SERVICE_URL", "http://127.0.0.1:8001").replace(/\/+$/, ""),
    key: text("MODEL_SERVICE_KEY", ""),
  },

  // Remote segmentation model for the room pipeline (server/lib/remoteModels/sam3.js): scores
  // the room's own scan regions, not a scan engine of its own - see pipelineRunner.js.
  sam3: {
    url: text("SAM3_URL", "").replace(/\/+$/, ""),
    key: text("SAM3_KEY", ""),
    authHeader: text("SAM3_AUTH_HEADER", "bearer"),
  },

  // Remote scene-parsing model for the SCAN: OneFormer (Swin-L, ADE20K), the high-accuracy engine that races
  // the local quantized SegFormer-B5 (server/lib/remoteModels/oneformer.js, routes/vision.js). The URL is the
  // complete endpoint, like the three above: https://<ws>--vision-all.modal.run/v1/oneformer (or the dedicated
  // pool's https://<ws>--vision-oneformer.modal.run/v1/oneformer). Unset = the scan runs on the local model only.
  oneformer: {
    url: text("ONEFORMER_URL", "").replace(/\/+$/, ""),
    key: text("ONEFORMER_KEY", ""),
    authHeader: text("ONEFORMER_AUTH_HEADER", "bearer"),
    // Reads the three scales plus mirror for the semantic map: more accurate, about 5x the GPU time.
    tta: text("ONEFORMER_TTA", "off") === "on",
    // The photo is already at most analysisMaxSide (1024) px; OneFormer is told the same bound plus headroom.
    maxSide: number("ONEFORMER_MAX_SIDE", 1536),
  },

  // The combined room analysis (VisionAll's /v1/analyze): MoGe-2 depth + Marigold lighting + SAM 3 masks for one
  // photo in ONE request to ONE pool (server/lib/remoteModels/analyze.js). Unset = the pipeline falls back to the
  // three separate endpoints above, exactly as before.
  analyze: {
    url: text("ANALYZE_URL", "").replace(/\/+$/, ""),
    key: text("ANALYZE_KEY", ""),
    authHeader: text("ANALYZE_AUTH_HEADER", "bearer"),
  },

  // How the server decides whether the Modal pools are warm WITHOUT calling them (calling a scaled-to-zero pool
  // boots a billed GPU). Every Modal call goes through this server, so its own record of the last successful call
  // is a reliable clock: a pool stays up for scaledownS (SCALEDOWN_S in modalBlueprint.py) after its last call.
  vision: {
    scaledownS: number("MODAL_SCALEDOWN_S", 300),
    // Seconds shaved off scaledownS before a pool still counts as warm, so a call is never planned on a pool that
    // is about to be stopped.
    warmMarginS: number("MODAL_WARM_MARGIN_S", 20),
    // "off" (default): GET /api/vision/warmup only reports what the server knows. "on": when the pool looks cold
    // it also sends one /healthz to it (bounded at 9 s) so the 10 s start-up gate can learn the real answer. That
    // boots a billed GPU for every visitor who lands cold, even one who never uploads a photo.
    activeWarmup: text("VISION_ACTIVE_WARMUP", "off") === "on",
  },

  // Remote geometry model: 3D shape of the room, in real metres (MoGe-2).
  moge2: {
    url: text("MOGE2_URL", "").replace(/\/+$/, ""),
    key: text("MOGE2_KEY", ""),
    authHeader: text("MOGE2_AUTH_HEADER", "bearer"),
  },

  // Remote intrinsic-decomposition model: splits a photo into colour (albedo) and light
  // (shading) layers (Marigold-IID).
  marigold: {
    url: text("MARIGOLD_URL", "").replace(/\/+$/, ""),
    key: text("MARIGOLD_KEY", ""),
    authHeader: text("MARIGOLD_AUTH_HEADER", "bearer"),
  },

  // Where room photos, masks, renders and fusion layers (depth, shading...) are stored.
  // "gridfs" (default) needs nothing extra; "gcs" needs GCS_BUCKET and a Google key that can
  // write to it (the same key used for Vertex AI already has the right OAuth scope).
  storage: {
    driver: text("STORAGE_DRIVER", "gridfs"),
    gcsBucket: text("GCS_BUCKET", ""),
  },

  // The "understand this photo" pipeline: SAM 3 + MoGe-2 + Marigold-IID, run once per photo,
  // fused into surfaces the browser can render instantly afterwards.
  pipeline: {
    concurrency: number("PIPELINE_CONCURRENCY", 2),
    // "auto" (default): a model is mocked when its *_URL is not set, so the whole pipeline
    // works end to end before real endpoints exist. "on": always mock. "off": always call the
    // real URL (and fail loudly if one isn't configured).
    mock: text("PIPELINE_MOCK", "auto"),
  },

  passcode: passcode,
  // Signs the studio cookie. Without SESSION_SECRET a new one is made at each start,
  // which only means people enter the passcode again after a restart.
  sessionSecret: text("SESSION_SECRET", crypto.randomBytes(32).toString("hex")),
  sessionDays: number("SESSION_DAYS", 30),
  secureCookies: text("SECURE_COOKIES", "auto"),

  terucon: {
    page: text(
      "TERUCON_PAGE",
      path.join(__dirname, "..", "terucon", "Swatchroom.html"),
    ),
  },

  // The admin dashboard (server/routes/admin.js, public/admin.html): generation logs, live
  // visitor count and model/service health. Its own sign-in, separate from the studio
  // passcode above - defaults match what was asked for, override them in .env for a real
  // deployment.
  admin: {
    email: text("ADMIN_EMAIL", "admin@terucon.in"),
    password: text("ADMIN_PASSWORD", "admin@123"),
  },

  // PostHog product analytics. Both browser pages (public/js/lib/analytics.js, loaded via
  // GET /api/session) and the server itself (server/lib/posthogClient.js) send events when
  // POSTHOG_KEY is set; leaving it blank disables analytics entirely, no code changes needed.
  posthog: {
    key: text("POSTHOG_KEY", ""),
    host: text("POSTHOG_HOST", "https://us.i.posthog.com"),
  },

  limits: {
    aiJson: text("AI_BODY_LIMIT", "40mb"),
    file: text("FILE_BODY_LIMIT", "30mb"),
    rooms: number("ROOM_LIMIT", 200),
  },
};

module.exports = config;
