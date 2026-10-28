// Gemini through the Swatchroom server. The browser prepares the photo, mask and brief; the
// server adds the Google key, chooses the request shape for each model, falls back to older
// models when a newer one is not available, and retries.

import { ApiError, postJson } from "../core/api.js";
import { logModel, publicText } from "../core/modelLog.js";

// Resolves to { response, attempt, model }. Throws ApiError; for Gemini errors .status is the
// status Vertex AI returned (404 not available, 429 quota...).
export function generate(request, signal) {
  const startedAt = Date.now();
  return postJson("/ai/generate", request, signal).then(function (answer) {
    logModel("ai:" + request.task, {
      requested: request.model,
      used: answer.model,
      attempt: answer.attempt,
      ms: Date.now() - startedAt,
    });
    return answer;
  });
}

export function forgetResolvedModels() {
  return postJson("/ai/forget-models", {});
}

export function isGeminiError(error) {
  return error instanceof ApiError && error.name === "VertexError";
}

// Text and images from a response, skipping thought parts.
export function readResponse(response) {
  const result = {
    texts: [],
    images: [],
    finishReason: "",
    blockReason: "",
    usage: response && response.usageMetadata ? response.usageMetadata : null,
  };
  if (!response) {
    return result;
  }
  if (response.promptFeedback && response.promptFeedback.blockReason) {
    result.blockReason = response.promptFeedback.blockReason;
  }
  const candidates = Array.isArray(response.candidates)
    ? response.candidates
    : [];
  if (candidates.length === 0) {
    return result;
  }
  const first = candidates[0];
  result.finishReason = first.finishReason || "";
  const parts =
    first.content && Array.isArray(first.content.parts)
      ? first.content.parts
      : [];
  parts.forEach(function (part) {
    if (part.thought === true) {
      return;
    }
    if (typeof part.text === "string" && part.text.trim() !== "") {
      result.texts.push(part.text);
    }
    if (part.inlineData && part.inlineData.data) {
      result.images.push({
        mimeType: part.inlineData.mimeType || "image/png",
        data: part.inlineData.data,
      });
    }
  });
  return result;
}

const FINISH_REASONS = {
  IMAGE_SAFETY: "the result was blocked by image safety filters",
  SAFETY: "the request was blocked by safety filters",
  PROHIBITED_CONTENT: "the request was flagged as prohibited content",
  RECITATION: "the output resembled protected content",
  MAX_TOKENS: "the model ran out of output tokens",
  IMAGE_OTHER: "the model could not produce an image for this request",
  NO_IMAGE: "the model answered without an image",
};

// The model id is logged to the console, not shown: the page only says "The AI".
export function noImageMessage(parsed, model) {
  console.warn("[swatchroom] no image from model:", model, parsed.blockReason || parsed.finishReason);
  const reason = parsed.blockReason || parsed.finishReason;
  const said = parsed.texts.join(" ").trim();
  const quote = said ? ' It said: "' + publicText(said.slice(0, 240)) + '"' : "";
  if (reason && reason !== "STOP") {
    return (
      "The AI returned no image: " +
      (FINISH_REASONS[reason] || reason) +
      "." +
      quote
    );
  }
  return (
    "The AI returned no image." +
    (said ? quote : " Try rephrasing the notes or render again.")
  );
}

// Parse JSON from model text, tolerating code fences and a cut-off ending.
export function parseJsonText(text) {
  let clean = String(text || "").trim();
  clean = clean
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(clean);
  } catch (error) {
    // try the repairs below
  }
  const start = clean.search(/[[{]/);
  const end = Math.max(clean.lastIndexOf("]"), clean.lastIndexOf("}"));
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(clean.slice(start, end + 1));
    } catch (error) {
      // try closing a cut-off list
    }
  }
  if (start !== -1 && clean.charAt(start) === "[") {
    const lastObject = clean.lastIndexOf("}");
    if (lastObject > start) {
      try {
        return JSON.parse(clean.slice(start, lastObject + 1) + "]");
      } catch (error) {
        // give up below
      }
    }
  }
  throw new Error("The model did not return readable JSON.");
}
