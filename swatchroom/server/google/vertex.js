// Vertex AI generateContent, called from the server only.
// - Turns HTTP errors into instructions a designer can act on.
// - Tries simpler request bodies when a model rejects an option (HTTP 400).
// - Walks a fallback chain when a model id is not available (HTTP 404) and remembers the
//   working id for a week, so the next call goes straight to it.
// - Retries briefly on quota (429) and temporary (5xx) errors.
const config = require("../config");
const googleToken = require("./token");

class VertexError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "VertexError";
    this.status = details && details.status ? details.status : 0;
    this.apiStatus = details && details.apiStatus ? details.apiStatus : "";
    this.apiMessage = details && details.apiMessage ? details.apiMessage : "";
    this.model = details && details.model ? details.model : "";
  }
}

// Ordered fallbacks: the first available id in a chain is used.
const TEXT_MODEL_CHAIN = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3-flash",
  "gemini-3.5-flash",
];
const IMAGE_MODEL_CHAIN = [
  "gemini-nano-banana-2.1",
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-lite-image",
];
const PRO_IMAGE_CHAIN = [
  "gemini-3-pro-image",
  "gemini-nano-banana-2.1",
  "gemini-3.1-flash-image",
];

const REMEMBER_MS = 7 * 86400000;
const resolvedModels = new Map();

function rememberedModel(requested) {
  const entry = resolvedModels.get(requested);
  if (!entry || Date.now() - entry.savedAt > REMEMBER_MS) {
    return "";
  }
  return entry.model;
}

function forgetResolvedModels() {
  resolvedModels.clear();
}

function chainFor(model) {
  if (PRO_IMAGE_CHAIN[0] === model) {
    return PRO_IMAGE_CHAIN;
  }
  if (TEXT_MODEL_CHAIN.indexOf(model) !== -1) {
    return TEXT_MODEL_CHAIN.slice(TEXT_MODEL_CHAIN.indexOf(model));
  }
  if (IMAGE_MODEL_CHAIN.indexOf(model) !== -1) {
    return IMAGE_MODEL_CHAIN.slice(IMAGE_MODEL_CHAIN.indexOf(model));
  }
  return [model];
}

// Gemini 2.x still takes temperature and a thinking budget; Gemini 3.x uses thinking levels
// and deprecates temperature, top_p and top_k.
function isLegacyModel(model) {
  return /^gemini-2\./.test(String(model || ""));
}

function endpointFor(projectId, location, model) {
  const place = (location || "global").trim();
  let base = config.google.vertexBaseUrl;
  if (!base) {
    base =
      "https://" +
      (place === "global"
        ? "aiplatform.googleapis.com"
        : place + "-aiplatform.googleapis.com");
  }
  return (
    base +
    "/v1/projects/" +
    encodeURIComponent(projectId) +
    "/locations/" +
    encodeURIComponent(place) +
    "/publishers/google/models/" +
    encodeURIComponent(model) +
    ":generateContent"
  );
}

function explainError(status, apiStatus, apiMessage, context) {
  const model = context.model;
  if (status === 401) {
    return "Google did not accept the server's access token. Check the key in .env.";
  }
  if (status === 403) {
    if (
      apiMessage.indexOf("has not been used") !== -1 ||
      apiMessage.indexOf("is disabled") !== -1
    ) {
      return (
        'The Vertex AI API is turned off for project "' +
        context.projectId +
        '". Enable aiplatform.googleapis.com in the Cloud console, wait a minute, then retry.'
      );
    }
    if (apiMessage.toLowerCase().indexOf("billing") !== -1) {
      return (
        'Billing is not active on project "' +
        context.projectId +
        '". Link a billing account, then retry.'
      );
    }
    return (
      "The service account is not allowed to call " +
      model +
      '. Grant it the "Vertex AI User" role (roles/aiplatform.user) on project "' +
      context.projectId +
      '".'
    );
  }
  if (status === 404) {
    return (
      model +
      ' is not available in location "' +
      context.location +
      '" for this project. Try location "global" or pick another model in Settings.'
    );
  }
  if (status === 429) {
    return (
      "Quota reached for " +
      model +
      ". Wait a few seconds and try again, or request more quota in the Cloud console."
    );
  }
  if (status === 400) {
    return (
      "Vertex AI rejected the request for " +
      model +
      ": " +
      (apiMessage || apiStatus || "invalid argument") +
      "."
    );
  }
  if (status >= 500) {
    return (
      "Vertex AI had a temporary problem (" +
      status +
      "). Try again in a moment."
    );
  }
  return (
    "Request to " +
    model +
    " failed (" +
    status +
    "): " +
    (apiMessage || apiStatus) +
    "."
  );
}

function wait(milliseconds, signal) {
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(resolve, milliseconds);
    if (signal) {
      signal.addEventListener(
        "abort",
        function () {
          clearTimeout(timer);
          const error = new Error("Aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true },
      );
    }
  });
}

// One POST to generateContent. Resolves to the parsed JSON response.
async function postGenerate(request) {
  const projectId = await googleToken.projectId();
  if (!projectId) {
    throw new VertexError(
      "The server does not know the Google Cloud project. Set GOOGLE_CLOUD_PROJECT in .env.",
      { model: request.model },
    );
  }
  const context = Object.assign({ projectId: projectId }, request);
  const url = endpointFor(projectId, request.location, request.model);
  const token = await googleToken.getToken();
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify(request.body),
      signal: request.signal,
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw error;
    }
    throw new VertexError(
      "The server could not reach Vertex AI. Check its internet connection.",
      { model: request.model },
    );
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    payload = null;
  }
  if (!response.ok) {
    if (response.status === 401) {
      googleToken.invalidate();
    }
    const apiError = payload && payload.error ? payload.error : {};
    const apiStatus = apiError.status || "";
    const apiMessage = apiError.message || "";
    throw new VertexError(
      explainError(response.status, apiStatus, apiMessage, context),
      {
        status: response.status,
        apiStatus: apiStatus,
        apiMessage: apiMessage,
        model: request.model,
      },
    );
  }
  return payload;
}

// Try each body in turn; a 400 moves on to the next (simpler) body. Quota and server errors
// are retried twice with a short pause.
async function postWithVariants(request, bodies) {
  let lastError = null;
  for (let attempt = 0; attempt < bodies.length; attempt += 1) {
    for (let retry = 0; retry < 3; retry += 1) {
      try {
        const response = await postGenerate(
          Object.assign({}, request, { body: bodies[attempt] }),
        );
        return { response: response, attempt: attempt };
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof VertexError &&
          (error.status === 429 || error.status >= 500) &&
          retry < 2;
        if (retryable) {
          await wait(retry === 0 ? 1500 : 4000, request.signal);
          continue;
        }
        break;
      }
    }
    const canSimplify =
      lastError instanceof VertexError &&
      lastError.status === 400 &&
      attempt < bodies.length - 1;
    if (!canSimplify) {
      throw lastError;
    }
  }
  throw lastError;
}

// Call a model with fallbacks. bodiesFor(model) returns the request bodies to try for that
// model. Resolves to { response, attempt, model } where model is the id that answered.
async function callModel(request, bodiesFor) {
  const remembered = rememberedModel(request.model);
  const chain = chainFor(request.model);
  let index =
    remembered && chain.indexOf(remembered) !== -1
      ? chain.indexOf(remembered)
      : 0;
  while (true) {
    const model = chain[index];
    try {
      const result = await postWithVariants(
        Object.assign({}, request, { model: model }),
        bodiesFor(model),
      );
      if (model !== request.model) {
        resolvedModels.set(request.model, {
          model: model,
          savedAt: Date.now(),
        });
      }
      result.model = model;
      return result;
    } catch (error) {
      const notAvailable =
        error instanceof VertexError &&
        error.status === 404 &&
        index < chain.length - 1;
      if (notAvailable) {
        index += 1;
        continue;
      }
      throw error;
    }
  }
}

// ------------------------------------------------------------------ request bodies

// A JSON answer from a text model.
// Gemini 3.x: thinking level LOW with a schema, then schema only, then plain JSON.
// Gemini 2.x: temperature with thinking off.
function jsonBodies(model, contents, schema, maxTokens) {
  const limit = maxTokens || 8192;
  if (isLegacyModel(model)) {
    return [
      {
        contents: contents,
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: limit,
          responseMimeType: "application/json",
          responseSchema: schema || undefined,
          thinkingConfig: { thinkingBudget: 0 },
        },
      },
      {
        contents: contents,
        generationConfig: {
          maxOutputTokens: limit,
          responseMimeType: "application/json",
        },
      },
    ];
  }
  const bodies = [];
  if (schema) {
    bodies.push({
      contents: contents,
      generationConfig: {
        maxOutputTokens: limit,
        responseMimeType: "application/json",
        responseSchema: schema,
        thinkingConfig: { thinkingLevel: "LOW" },
      },
    });
    bodies.push({
      contents: contents,
      generationConfig: {
        maxOutputTokens: limit,
        responseMimeType: "application/json",
        responseSchema: schema,
      },
    });
  }
  bodies.push({
    contents: contents,
    generationConfig: {
      maxOutputTokens: limit,
      responseMimeType: "application/json",
    },
  });
  bodies.push({ contents: contents });
  return bodies;
}

// Pixel masks from Gemini 2.5 (the optional "Pixel masks" detection setting).
function maskBodies(model, contents) {
  if (isLegacyModel(model)) {
    return [
      {
        contents: contents,
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 32768,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 0 },
        },
      },
      {
        contents: contents,
        generationConfig: { temperature: 0.5, maxOutputTokens: 32768 },
      },
    ];
  }
  return jsonBodies(model, contents, null, 32768);
}

// An edited image. parts: the photo, mask and guide images; brief: the text for this render.
function imageBodies(model, parts, brief, systemPrompt, aspectRatio, size) {
  const lite = String(model).indexOf("lite") !== -1;
  const system = { parts: [{ text: systemPrompt }] };
  const content = [{ role: "user", parts: parts.concat([{ text: brief }]) }];
  const bodies = [];
  if (!lite && size) {
    bodies.push({
      systemInstruction: system,
      contents: content,
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: aspectRatio, imageSize: size },
      },
    });
    if (size === "4K") {
      bodies.push({
        systemInstruction: system,
        contents: content,
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio: aspectRatio, imageSize: "2K" },
        },
      });
    }
  }
  bodies.push({
    systemInstruction: system,
    contents: content,
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: aspectRatio },
    },
  });
  bodies.push({
    systemInstruction: system,
    contents: content,
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  });
  bodies.push({
    contents: [
      {
        role: "user",
        parts: parts.concat([{ text: systemPrompt + "\n\n" + brief }]),
      },
    ],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  });
  return bodies;
}

// A tiny request used by Settings > Check to see that a model is reachable.
async function probeModel(location, model, wantsImage) {
  const body = {
    contents: [
      { role: "user", parts: [{ text: "Reply with the single word OK." }] },
    ],
    generationConfig: wantsImage
      ? { responseModalities: ["TEXT", "IMAGE"], maxOutputTokens: 64 }
      : { maxOutputTokens: 16 },
  };
  try {
    await postGenerate({ location: location, model: model, body: body });
    return { status: "ok", detail: "Reachable and allowed." };
  } catch (error) {
    if (error instanceof VertexError && error.status === 400) {
      return {
        status: "ok",
        detail:
          "Reachable (the probe request itself was rejected, which is fine).",
      };
    }
    return { status: "error", detail: error.message };
  }
}

module.exports = {
  VertexError: VertexError,
  TEXT_MODEL_CHAIN: TEXT_MODEL_CHAIN,
  IMAGE_MODEL_CHAIN: IMAGE_MODEL_CHAIN,
  callModel: callModel,
  jsonBodies: jsonBodies,
  maskBodies: maskBodies,
  imageBodies: imageBodies,
  probeModel: probeModel,
  forgetResolvedModels: forgetResolvedModels,
  isLegacyModel: isLegacyModel,
};
