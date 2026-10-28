// Gemini on Vertex AI, on behalf of the studio. The browser prepares the images and the text;
// the server adds the Google credentials, picks the request shape for each model, walks the
// model fallbacks and retries. The key never leaves the server.
//
//   POST /api/ai/generate        { task, model, location, ... } -> { response, attempt, model }
//        task "json"   { contents, schema, maxTokens }            outlines, measurements
//        task "masks"  { contents }                               legacy pixel masks
//        task "image"  { parts, brief, systemPrompt, aspectRatio, imageSize }   renders
//   POST /api/ai/forget-models   next requests try the newest models first again
const express = require("express");
const config = require("../config");
const vertex = require("../google/vertex");
const eventLog = require("../lib/eventLog");
const posthog = require("../lib/posthogClient");

const router = express.Router();
const MODEL_ID = /^[a-z0-9][a-z0-9.\-]{2,80}$/;
const LOCATION = /^[a-z0-9-]{2,40}$/;
const IMAGE_SIZES = ["", "1K", "2K", "4K"];

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function readModel(value) {
  const model = String(value || "").trim();
  if (!MODEL_ID.test(model)) {
    throw badRequest("Choose a valid model id in Settings.");
  }
  return model;
}

function readLocation(value) {
  const location = String(value || config.google.location).trim();
  if (!LOCATION.test(location)) {
    throw badRequest("That Vertex AI location is not valid.");
  }
  return location;
}

function readContents(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest("The request has no content.");
  }
  return value;
}

function bodiesFor(task, body) {
  if (task === "json") {
    const contents = readContents(body.contents);
    const schema =
      body.schema && typeof body.schema === "object" ? body.schema : null;
    const maxTokens = Math.min(65536, Number(body.maxTokens) || 8192);
    return function (model) {
      return vertex.jsonBodies(model, contents, schema, maxTokens);
    };
  }
  if (task === "masks") {
    const contents = readContents(body.contents);
    return function (model) {
      return vertex.maskBodies(model, contents);
    };
  }
  if (task === "image") {
    const parts = readContents(body.parts);
    const brief = String(body.brief || "");
    const systemPrompt = String(body.systemPrompt || "");
    const aspectRatio = String(body.aspectRatio || "1:1");
    const imageSize =
      IMAGE_SIZES.indexOf(body.imageSize) !== -1 ? body.imageSize : "2K";
    if (!brief || !systemPrompt) {
      throw badRequest("The render request is missing its brief.");
    }
    return function (model) {
      return vertex.imageBodies(
        model,
        parts,
        brief,
        systemPrompt,
        aspectRatio,
        imageSize,
      );
    };
  }
  throw badRequest("Unknown task.");
}

router.post(
  "/generate",
  express.json({ limit: config.limits.aiJson }),
  async function (request, response) {
    const body = request.body || {};
    const task = String(body.task || "");
    const model = readModel(body.model);
    const location = readLocation(body.location);
    const makeBodies = bodiesFor(task, body);
    const startedAt = Date.now();
    // Stop the Google request if the designer cancels (the browser closes the request).
    const controller = new AbortController();
    response.on("close", function () {
      if (!response.writableEnded) {
        controller.abort();
      }
    });
    try {
      const answer = await vertex.callModel(
        { model: model, location: location, signal: controller.signal },
        makeBodies,
      );
      console.log(
        "[ai] " + task + " ok: requested " + model + ", used " + answer.model +
          " (attempt " + answer.attempt + ", " + (Date.now() - startedAt) + "ms)",
      );
      eventLog.log({
        type: "generate",
        action: task,
        model: answer.model,
        status: "ok",
        statusCode: 200,
        durationMs: Date.now() - startedAt,
        visitorId: request.visitorId,
        ip: request.ip,
      });
      posthog.capture(request.visitorId, "generation", {
        task: task,
        model: answer.model,
        durationMs: Date.now() - startedAt,
      });
      response.json({
        response: answer.response,
        attempt: answer.attempt,
        model: answer.model,
      });
    } catch (error) {
      if (error && error.name === "AbortError") {
        if (!response.headersSent) {
          response.status(499).end();
        }
        return;
      }
      if (error instanceof vertex.VertexError) {
        console.warn(
          "[ai] " + task + " failed: requested " + model + ", model " + (error.model || model) +
            ", status " + error.status + ": " + error.message,
        );
        eventLog.log({
          type: "generate",
          action: task,
          model: error.model || model,
          status: "error",
          statusCode: 502,
          durationMs: Date.now() - startedAt,
          error: error.message,
          visitorId: request.visitorId,
          ip: request.ip,
        });
        posthog.capture(request.visitorId, "generation_failed", {
          task: task,
          model: error.model || model,
          error: error.message,
        });
        response.status(502).json({
          error: error.message,
          name: "VertexError",
          status: error.status,
          apiStatus: error.apiStatus,
          apiMessage: error.apiMessage,
          model: error.model,
        });
        return;
      }
      eventLog.log({
        type: "generate",
        action: task,
        model: model,
        status: "error",
        statusCode: (error && error.status) || 500,
        durationMs: Date.now() - startedAt,
        error: (error && error.message) || "Server error.",
        visitorId: request.visitorId,
        ip: request.ip,
      });
      throw error;
    }
  },
);

router.post("/forget-models", function (request, response) {
  vertex.forgetResolvedModels();
  response.json({ done: true });
});

module.exports = router;
