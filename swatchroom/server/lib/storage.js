// Where pipeline layers (and, later, anything else large) are stored. "gridfs" (default)
// reuses the same MongoDB bucket rooms already store photos in; "gcs" talks to a Google Cloud
// Storage bucket instead. Both drivers implement the same four methods, so callers never know
// which one is active.
//
//   putBuffer(key, buffer, meta) -> {size}
//   getBuffer(key)               -> Buffer, or null if the key does not exist
//   getStream(key)                -> {stream, size, contentType}, or null
//   delete(key)                   -> void
const config = require("../config");

let instance = null;

function storage() {
  if (!instance) {
    instance =
      config.storage.driver === "gcs"
        ? require("./storage/gcs")(config)
        : require("./storage/gridfs")(config);
  }
  return instance;
}

module.exports = { storage: storage };
