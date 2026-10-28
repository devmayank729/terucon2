// Google Cloud Storage, over its plain JSON/XML upload API with fetch(). No new dependency:
// the same Google key already used for Vertex AI (server/google/token.js) carries the
// "cloud-platform" OAuth scope, which also covers Cloud Storage, as long as the service
// account has been granted Storage Object Admin on the bucket (a deployment/IAM step, not a
// code concern — see README).
const googleToken = require("../../google/token");

const API = "https://storage.googleapis.com";

function objectUrl(bucket, key, query) {
  const path =
    API + "/storage/v1/b/" + encodeURIComponent(bucket) + "/o/" + encodeURIComponent(key);
  return query ? path + "?" + query : path;
}

function storageError(message, status) {
  const error = new Error(message);
  error.status = status || 502;
  return error;
}

async function authHeaders(extra) {
  const token = await googleToken.getToken();
  return Object.assign({ Authorization: "Bearer " + token }, extra || {});
}

async function putBuffer(bucket, key, buffer, meta) {
  const contentType = (meta && meta.contentType) || "application/octet-stream";
  const url =
    API +
    "/upload/storage/v1/b/" +
    encodeURIComponent(bucket) +
    "/o?uploadType=media&name=" +
    encodeURIComponent(key);
  const response = await fetch(url, {
    method: "POST",
    headers: await authHeaders({ "Content-Type": contentType }),
    body: buffer,
  });
  if (!response.ok) {
    throw storageError(
      "Cloud Storage write failed (" + response.status + ").",
      response.status,
    );
  }
  return { size: buffer.length };
}

async function getBuffer(bucket, key) {
  const response = await fetch(objectUrl(bucket, key, "alt=media"), {
    headers: await authHeaders(),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw storageError(
      "Cloud Storage read failed (" + response.status + ").",
      response.status,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

async function getStream(bucket, key) {
  const metaResponse = await fetch(objectUrl(bucket, key), {
    headers: await authHeaders(),
  });
  if (metaResponse.status === 404) {
    return null;
  }
  if (!metaResponse.ok) {
    throw storageError(
      "Cloud Storage read failed (" + metaResponse.status + ").",
      metaResponse.status,
    );
  }
  const meta = await metaResponse.json();
  const response = await fetch(objectUrl(bucket, key, "alt=media"), {
    headers: await authHeaders(),
  });
  if (!response.ok || !response.body) {
    throw storageError(
      "Cloud Storage read failed (" + response.status + ").",
      response.status,
    );
  }
  return {
    stream: require("stream").Readable.fromWeb(response.body),
    size: Number(meta.size) || 0,
    contentType: meta.contentType || "application/octet-stream",
  };
}

async function del(bucket, key) {
  const response = await fetch(objectUrl(bucket, key), {
    method: "DELETE",
    headers: await authHeaders(),
  });
  if (!response.ok && response.status !== 404) {
    throw storageError(
      "Cloud Storage delete failed (" + response.status + ").",
      response.status,
    );
  }
}

module.exports = function gcsStorage(config) {
  const bucket = config.storage.gcsBucket;
  if (!bucket) {
    throw new Error("STORAGE_DRIVER is gcs but GCS_BUCKET is not set.");
  }
  return {
    putBuffer: function (key, buffer, meta) {
      return putBuffer(bucket, key, buffer, meta);
    },
    getBuffer: function (key) {
      return getBuffer(bucket, key);
    },
    getStream: function (key) {
      return getStream(bucket, key);
    },
    delete: function (key) {
      return del(bucket, key);
    },
  };
};
