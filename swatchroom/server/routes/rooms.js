// Saved rooms.
//   GET    /api/rooms                    newest first: id, name, updatedAt, versionCount
//   GET    /api/rooms/:id                one room record
//   PUT    /api/rooms/:id                create or update a room record (JSON)
//   DELETE /api/rooms/:id                the record and every file of the room
//   PUT    /api/rooms/:id/scan           surface-map details (JSON); labels go in files/scan/labels
//   PUT    /api/rooms/:id/files/<name>   store a file (raw body: a photo, render, mask...)
//   GET    /api/rooms/:id/files/<name>   read it back
const express = require("express");
const config = require("../config");
const db = require("../db");
const Room = require("../models/Room");

const router = express.Router();
const ROOM_ID = /^room-[a-z0-9-]{4,48}$/;
const FILE_NAME = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){0,3}$/;

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function roomId(request) {
  const id = String(request.params.id || "");
  if (!ROOM_ID.test(id)) {
    throw badRequest("That is not a room id.");
  }
  return id;
}

function fileName(request) {
  const parts = request.params.name;
  const name = Array.isArray(parts) ? parts.join("/") : String(parts || "");
  if (!FILE_NAME.test(name) || name.indexOf("..") !== -1) {
    throw badRequest("That is not a file name.");
  }
  return name;
}

// Pick the fields a room record may contain, so a request cannot write anything else.
function cleanRecord(id, body) {
  const record = {
    _id: id,
    name: String(body.name || "Room").slice(0, 120),
    createdAt: Number(body.createdAt) || Date.now(),
    updatedAt: Date.now(),
    photo: body.photo || null,
    versions: Array.isArray(body.versions) ? body.versions.slice(0, 500) : [],
    currentId: String(body.currentId || ""),
    products:
      body.products && typeof body.products === "object" ? body.products : {},
    notes: body.notes && typeof body.notes === "object" ? body.notes : {},
    style: String(body.style || ""),
    optionCount: Number(body.optionCount) || 1,
    counter: body.counter || null,
    scanEngine: String(body.scanEngine || ""),
    scanModel: String(body.scanModel || ""),
  };
  return record;
}

async function findFiles(filter) {
  return db.files().find(filter).sort({ uploadDate: -1 }).toArray();
}

async function deleteFiles(list) {
  for (const entry of list) {
    try {
      await db.files().delete(entry._id);
    } catch (error) {
      // already gone
    }
  }
}

function writeFile(name, buffer, metadata) {
  return new Promise(function (resolve, reject) {
    const upload = db.files().openUploadStream(name, { metadata: metadata });
    upload.on("error", reject);
    upload.on("finish", function () {
      resolve(upload.id);
    });
    upload.end(buffer);
  });
}

// Keep at most ROOM_LIMIT rooms: the oldest go first.
async function pruneRooms(keepId) {
  const count = await Room.countDocuments();
  if (count <= config.limits.rooms) {
    return;
  }
  const extra = await Room.find({ _id: { $ne: keepId } })
    .sort({ updatedAt: 1 })
    .limit(count - config.limits.rooms)
    .select("_id");
  for (const room of extra) {
    await deleteFiles(await findFiles({ "metadata.roomId": room._id }));
    await Room.deleteOne({ _id: room._id });
  }
}

router.get("/", async function (request, response) {
  const rooms = await Room.find()
    .sort({ updatedAt: -1 })
    .limit(60)
    .select("name updatedAt createdAt versions");
  response.json({
    rooms: rooms.map(function (room) {
      return room.summary();
    }),
  });
});

router.get("/:id", async function (request, response) {
  const room = await Room.findById(roomId(request)).lean();
  if (!room) {
    response.status(404).json({ error: "That room is not saved here." });
    return;
  }
  room.id = room._id;
  delete room._id;
  response.json({ room: room });
});

router.put(
  "/:id",
  express.json({ limit: "8mb" }),
  async function (request, response) {
    const id = roomId(request);
    const record = cleanRecord(id, request.body || {});
    const existing = await Room.exists({ _id: id });
    await Room.updateOne({ _id: id }, { $set: record }, { upsert: true });
    if (!existing) {
      pruneRooms(id).catch(function () {});
    }
    response.json({ saved: true, updatedAt: record.updatedAt });
  },
);

router.delete("/:id", async function (request, response) {
  const id = roomId(request);
  await deleteFiles(await findFiles({ "metadata.roomId": id }));
  await Room.deleteOne({ _id: id });
  response.json({ deleted: true });
});

router.put(
  "/:id/scan",
  express.json({ limit: "4mb" }),
  async function (request, response) {
    const id = roomId(request);
    const body = request.body || {};
    const scan = {
      width: Number(body.width) || 0,
      height: Number(body.height) || 0,
      nextIndex: Number(body.nextIndex) || 1,
      metas: Array.isArray(body.metas) ? body.metas : [],
      engine: String(body.engine || ""),
      model: String(body.model || ""),
      savedAt: Date.now(),
    };
    await Room.updateOne(
      { _id: id },
      { $set: { scan: scan }, $setOnInsert: { createdAt: Date.now() } },
      { upsert: true },
    );
    response.json({ saved: true });
  },
);

router.put(
  "/:id/files/*name",
  express.raw({
    type: function () {
      return true;
    },
    limit: config.limits.file,
  }),
  async function (request, response) {
    const id = roomId(request);
    const name = fileName(request);
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw badRequest("The file is empty.");
    }
    const fullName = id + "/" + name;
    const older = await findFiles({ filename: fullName });
    const fileId = await writeFile(fullName, body, {
      roomId: id,
      name: name,
      contentType: String(
        request.headers["content-type"] || "application/octet-stream",
      ).slice(0, 80),
    });
    await deleteFiles(older);
    response.json({ saved: true, id: String(fileId), size: body.length });
  },
);

router.get("/:id/files/*name", async function (request, response) {
  const id = roomId(request);
  const name = fileName(request);
  const found = await findFiles({ filename: id + "/" + name });
  if (found.length === 0) {
    response.status(404).json({ error: "File not found." });
    return;
  }
  const file = found[0];
  const etag = '"' + String(file._id) + '"';
  response.setHeader("ETag", etag);
  response.setHeader("Cache-Control", "private, no-cache");
  if (request.headers["if-none-match"] === etag) {
    response.status(304).end();
    return;
  }
  response.setHeader(
    "Content-Type",
    (file.metadata && file.metadata.contentType) || "application/octet-stream",
  );
  response.setHeader("Content-Length", String(file.length));
  const stream = db.files().openDownloadStream(file._id);
  stream.on("error", function () {
    if (!response.headersSent) {
      response.status(404).end();
    } else {
      response.destroy();
    }
  });
  stream.pipe(response);
});

module.exports = router;
