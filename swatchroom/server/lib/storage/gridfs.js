// Stores pipeline layers (depth, shading...) in the same MongoDB GridFS bucket rooms already
// use for photos and renders (see server/db.js, server/routes/rooms.js). A "key" here is the
// same kind of path those use: "<roomId>/<name>".
const db = require("../../db");

async function findOne(key) {
  const found = await db
    .files()
    .find({ filename: key })
    .sort({ uploadDate: -1 })
    .limit(1)
    .toArray();
  return found[0] || null;
}

function putBuffer(key, buffer, meta) {
  return new Promise(function (resolve, reject) {
    const upload = db.files().openUploadStream(key, { metadata: meta || {} });
    upload.on("error", reject);
    upload.on("finish", async function () {
      // Keep at most one copy per key, the same way routes/rooms.js does for room files.
      const older = await db
        .files()
        .find({ filename: key, _id: { $ne: upload.id } })
        .toArray();
      for (const entry of older) {
        try {
          await db.files().delete(entry._id);
        } catch (error) {
          // already gone
        }
      }
      resolve({ size: buffer.length });
    });
    upload.end(buffer);
  });
}

async function getBuffer(key) {
  const file = await findOne(key);
  if (!file) {
    return null;
  }
  const chunks = [];
  const stream = db.files().openDownloadStream(file._id);
  return new Promise(function (resolve, reject) {
    stream.on("data", function (chunk) {
      chunks.push(chunk);
    });
    stream.on("error", reject);
    stream.on("end", function () {
      resolve(Buffer.concat(chunks));
    });
  });
}

async function getStream(key) {
  const file = await findOne(key);
  if (!file) {
    return null;
  }
  return {
    stream: db.files().openDownloadStream(file._id),
    size: file.length,
    contentType:
      (file.metadata && file.metadata.contentType) || "application/octet-stream",
  };
}

async function del(key) {
  const file = await findOne(key);
  if (!file) {
    return;
  }
  try {
    await db.files().delete(file._id);
  } catch (error) {
    // already gone
  }
}

module.exports = function gridfsStorage() {
  return { putBuffer: putBuffer, getBuffer: getBuffer, getStream: getStream, delete: del };
};
