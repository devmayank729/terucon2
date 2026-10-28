// Talking to the Swatchroom server. Every call goes to /api on the same site, with the studio
// cookie when a passcode is set.
//
// Errors come back as ApiError with the server's message, so the studio can show it as is.

import { logModelError, publicText } from "./modelLog.js";

export class ApiError extends Error {
  constructor(message, details) {
    super(message);
    this.name = details && details.name ? details.name : "ApiError";
    this.rawMessage = details && details.rawMessage ? details.rawMessage : message;
    this.httpStatus = details && details.httpStatus ? details.httpStatus : 0;
    // For Gemini errors: the status Vertex AI returned (404 = model not available...).
    this.status = details && details.status ? details.status : 0;
    this.apiStatus = details && details.apiStatus ? details.apiStatus : "";
    this.apiMessage = details && details.apiMessage ? details.apiMessage : "";
    this.model = details && details.model ? details.model : "";
    this.code = details && details.code ? details.code : "";
  }
}

let baseUrl = "";
let onSignedOut = null;

// The studio may sit on a page served from somewhere else (rare): point it at the server.
export function setApiBase(url) {
  baseUrl = String(url || "").replace(/\/+$/, "");
}

export function apiUrl(path) {
  return baseUrl + "/api" + path;
}

// Called when the server says the passcode is needed again (cookie expired).
export function whenSignedOut(callback) {
  onSignedOut = callback;
}

async function readError(response) {
  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
  }
  const message =
    body && body.error
      ? body.error
      : response.status === 404
        ? "The server does not know this request. Is the Swatchroom server up to date?"
        : "The server answered " + response.status + ".";
  // The page only ever sees the scrubbed text; the original (with real model names, quota
  // details...) goes to the console for debugging.
  const route = response.url.replace(/^https?:\/\/[^/]+/, "");
  if (/^\/api\/(ai|vision|pipeline|check)\b/.test(route)) {
    logModelError(route, new Error(message), {
      httpStatus: response.status,
      model: body && body.model ? body.model : undefined,
      apiStatus: body && body.apiStatus ? body.apiStatus : undefined,
      apiMessage: body && body.apiMessage ? body.apiMessage : undefined,
    });
  }
  const error = new ApiError(publicText(message), {
    rawMessage: message,
    name: body && body.name ? body.name : "ApiError",
    httpStatus: response.status,
    status: body && body.status ? body.status : 0,
    apiStatus: body && body.apiStatus ? body.apiStatus : "",
    apiMessage: body && body.apiMessage ? body.apiMessage : "",
    model: body && body.model ? body.model : "",
    code: body && body.code ? body.code : "",
  });
  if (response.status === 401 && error.code === "passcode" && onSignedOut) {
    onSignedOut();
  }
  return error;
}

async function send(path, options) {
  let response;
  try {
    response = await fetch(
      apiUrl(path),
      Object.assign({ credentials: "same-origin" }, options),
    );
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw error;
    }
    throw new ApiError(
      "Could not reach the Swatchroom server. Check the connection and try again.",
      { httpStatus: 0 },
    );
  }
  if (!response.ok) {
    throw await readError(response);
  }
  return response;
}

export async function getJson(path, signal) {
  const response = await send(path, { method: "GET", signal: signal });
  return response.json();
}

export async function sendJson(method, path, body, signal) {
  const response = await send(path, {
    method: method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body === undefined ? {} : body),
    signal: signal,
  });
  return response.json();
}

export function postJson(path, body, signal) {
  return sendJson("POST", path, body, signal);
}

// Send a Blob or bytes as the request body (photos, renders, masks).
export async function sendBytes(method, path, data, contentType, signal) {
  const response = await send(path, {
    method: method,
    headers: { "Content-Type": contentType || "application/octet-stream" },
    body: data,
    signal: signal,
  });
  return response.json();
}

// Read a stored file back. Resolves to a Blob, or null when it does not exist.
export async function getBlob(path, signal) {
  try {
    const response = await send(path, { method: "GET", signal: signal });
    return await response.blob();
  } catch (error) {
    if (error instanceof ApiError && error.httpStatus === 404) {
      return null;
    }
    throw error;
  }
}

// Fusion layers (depth, shading...) are plain gzip files, fetched with getBlob() - unlike
// unpackBytes() below, there is no base64 layer, because these never travel inside JSON.
// Raw gzip bytes of a stored file, e.g. the SAM layer (lib/samLayer.js reads the format).
export async function unpackGzip(blob) {
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unpackFloat32(blob) {
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Float32Array(buffer);
}

// Shading and residual layers are 16-bit integers, gzipped (server/lib/pack.js packUnit16): 0..65535 -> 0..1.
export async function unpackUnit16(blob) {
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  const raw = new Uint16Array(buffer);
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    out[i] = raw[i] / 65535;
  }
  return out;
}

// The server sends masks and label maps as base64 of gzip bytes. Unpack them.
export async function unpackBytes(base64) {
  const binary = atob(base64);
  const packed = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    packed[index] = binary.charCodeAt(index);
  }
  const stream = new Blob([packed])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}
