// Calling convention shared by every remote model server (SAM 3, MoGe-2, Marigold-IID): a
// {url, key, authHeader} config block (see server/config.js), bearer or x-api-key auth, and the
// same connectivity/auth-error wording so a designer sees the same kind of explanation no
// matter which server is missing or down.
function serviceError(message, status) {
  const error = new Error(message);
  error.status = status || 502;
  return error;
}

function authHeaders(modelConfig, extra) {
  const headers = Object.assign({}, extra || {});
  if (modelConfig.key) {
    if (modelConfig.authHeader === "x-api-key") {
      headers["x-api-key"] = modelConfig.key;
    } else {
      headers.Authorization = "Bearer " + modelConfig.key;
    }
  }
  return headers;
}

// The fetch + connectivity/auth error handling every call here shares. Returns the raw
// Response; callers read the body however suits that endpoint (JSON, or .arrayBuffer() for a
// binary .npz/.zip response).
async function call(modelConfig, name, path, init, envHint) {
  if (!modelConfig.url) {
    throw serviceError(
      "No " + name + " is configured." + (envHint ? " Set " + envHint + " in .env." : ""),
      404,
    );
  }
  let response;
  try {
    response = await fetch(
      modelConfig.url + path,
      Object.assign({}, init, { headers: authHeaders(modelConfig, init.headers) }),
    );
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw error;
    }
    throw serviceError("Could not reach the " + name + " at " + modelConfig.url + ".", 503);
  }
  if (response.status === 401 || response.status === 403) {
    throw serviceError("The " + name + " rejected the API key (" + response.status + ").", 502);
  }
  return response;
}

// Reads the {error, detail} JSON body vision_stack.py's SecurityMiddleware/exception handlers
// always send on a non-2xx response, and throws a readable error; does nothing on success.
async function throwOnError(response, name) {
  if (response.ok) {
    return;
  }
  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
  }
  const detail = body && (body.detail || body.error || body.message);
  throw serviceError(
    name +
      " failed (" +
      response.status +
      ")" +
      (detail
        ? ": " + (typeof detail === "string" ? detail : JSON.stringify(detail))
        : "."),
    response.status === 409 ? 409 : 502,
  );
}

async function readJson(response, name) {
  await throwOnError(response, name);
  try {
    return await response.json();
  } catch (error) {
    throw serviceError(name + " returned a response that was not valid JSON.", 502);
  }
}

// POSTs (or, with requestBody undefined, GETs) JSON to a remote model server and returns its
// parsed JSON body. `envHint` names the .env variable to mention when the server isn't
// configured at all (e.g. "MOGE2_URL").
async function callJson(modelConfig, name, path, requestBody, options, envHint) {
  const init = Object.assign(
    {
      method: requestBody === undefined ? "GET" : "POST",
      headers: requestBody === undefined ? {} : { "Content-Type": "application/json" },
    },
    options || {},
  );
  if (requestBody !== undefined && init.body === undefined) {
    init.body = JSON.stringify(requestBody);
  }
  const response = await call(modelConfig, name, path, init, envHint);
  return readJson(response, name);
}

// POSTs a multipart/form-data body (fetch sets the Content-Type, including the boundary,
// automatically for a FormData body - do not set it manually) and returns the raw Response on
// success. The caller reads the body however that endpoint's contract requires: MoGe-2's
// /v1/geometry and Marigold-IID's /v1/decompose return binary (.npz / .zip), not JSON.
async function callMultipart(modelConfig, name, path, formData, options, envHint) {
  const init = Object.assign({ method: "POST", body: formData }, options || {});
  const response = await call(modelConfig, name, path, init, envHint);
  await throwOnError(response, name);
  return response;
}

module.exports = {
  serviceError: serviceError,
  authHeaders: authHeaders,
  readJson: readJson,
  callJson: callJson,
  callMultipart: callMultipart,
};
