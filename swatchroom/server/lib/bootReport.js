// What this server will do with its models, printed once at start so a misconfiguration is visible in the terminal
// instead of looking like "nothing changed". It asks only the LOCAL model service (/health, free); it never calls Modal.
const config = require("../config");

const DEFAULT_MODEL_NAME = "b5-quant";

// -> [{ level: "ok" | "warn", text }]
async function describe(options) {
  const opts = options || {};
  const doFetch = opts.fetch || fetch;
  const lines = [];

  let health = null;
  let problem = "";
  try {
    const answer = await doFetch(config.models.url + "/health", {
      headers: config.models.key ? { "X-Model-Key": config.models.key } : {},
      signal: AbortSignal.timeout(3000),
    });
    if (answer.ok) {
      health = await answer.json();
    } else {
      problem = "it answered " + answer.status;
    }
  } catch (error) {
    problem = "it is not running";
  }
  if (!health) {
    lines.push({
      level: "warn",
      text:
        "Scan model service at " + config.models.url + ": " + problem + ". Photos will be outlined by Gemini only. " +
        "Start it with: cd python && .venv/bin/uvicorn app:app --port 8001",
    });
  } else if (!health.defaultModel) {
    lines.push({
      level: "warn",
      text:
        "Scan model service at " + config.models.url + " is an OLD build (its /health has no defaultModel): it treats " +
        "'b5-quant' as B4. Stop it and start it again from this checkout: cd python && .venv/bin/uvicorn app:app --port 8001",
    });
  } else {
    const loaded = (health.sceneLoaded || []).map(function (id) {
      return String(id).split("/").pop();
    });
    lines.push({
      level: "ok",
      text:
        "Scan model service at " + config.models.url + ": running on " + health.device + ", default model " +
        health.defaultModel + (loaded.length ? ", loaded: " + loaded.join(", ") : ", loading its model in the background") + ".",
    });
  }

  if (config.oneformer.url) {
    lines.push({ level: "ok", text: "HD scan: OneFormer on Modal is set up (ONEFORMER_URL); it races the local model." });
  } else {
    lines.push({
      level: "warn",
      text:
        "HD scan: ONEFORMER_URL is not set, so the scan uses the local model only and OneFormer is never called. " +
        "Deploy modalBlueprint.py (DEPLOY.md) and add ONEFORMER_URL and ANALYZE_URL to .env.",
    });
  }
  if (config.analyze.url) {
    lines.push({ level: "ok", text: "Room analysis: one combined Modal call (ANALYZE_URL)." });
  } else if (config.sam3.url || config.moge2.url || config.marigold.url) {
    lines.push({
      level: "warn",
      text:
        "Room analysis: ANALYZE_URL is not set, so each scanned photo wakes the separate SAM 3 / MoGe-2 / Marigold pools " +
        "(up to three cold starts). The combined pool needs the new modalBlueprint.py deployed.",
    });
  } else {
    lines.push({ level: "warn", text: "Room analysis: no Modal pool is configured; the instant preview uses the provisional estimate only." });
  }
  return lines;
}

async function print() {
  try {
    (await describe()).forEach(function (line) {
      (line.level === "ok" ? console.log : console.warn)("[models] " + line.text);
    });
  } catch (error) {
    console.warn("[models] could not summarise the model setup:", error.message);
  }
}

module.exports = { describe, print, DEFAULT_MODEL_NAME };
