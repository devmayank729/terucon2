// Saved rooms, kept on the Swatchroom server (MongoDB) so they open on any device.
//   room record   name, versions (without images), materials, notes...   /api/rooms/:id
//   files         photos, renders, masks, the thumbnail                   /api/rooms/:id/files/...
//   surface map   details in the record, label map as files/scan/labels

import {
  ApiError,
  apiUrl,
  getBlob,
  getJson,
  sendBytes,
  sendJson,
} from "../core/api.js";

export function newRoomId() {
  return (
    "room-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 8)
  );
}

function filePath(key) {
  const slash = key.indexOf("/");
  const roomId = key.slice(0, slash);
  const name = key.slice(slash + 1);
  return "/rooms/" + encodeURIComponent(roomId) + "/files/" + name;
}

// key: "<room id>/<name>", for example "room-abc/v0/raw" or "room-abc/thumb".
export function putFile(key, value) {
  let body = value;
  let type = "application/octet-stream";
  if (value instanceof Blob) {
    type = value.type || type;
  } else if (ArrayBuffer.isView(value)) {
    body = new Blob([value]);
  } else if (value instanceof ArrayBuffer) {
    body = new Blob([value]);
  }
  return sendBytes("PUT", filePath(key), body, type);
}

// A stored file as a Blob, or null when it was never saved.
export function getFile(key) {
  return getBlob(filePath(key));
}

export async function getFileBytes(key) {
  const blob = await getFile(key);
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

// Address of a stored file, for <img src>.
export function fileUrl(key) {
  return apiUrl(filePath(key));
}

export async function saveScan(roomId, serialised) {
  const labels = serialised.labelMap;
  await putFile(
    roomId + "/scan/labels",
    new Uint8Array(labels.buffer, labels.byteOffset, labels.byteLength),
  );
  await sendJson("PUT", "/rooms/" + encodeURIComponent(roomId) + "/scan", {
    width: serialised.width,
    height: serialised.height,
    nextIndex: serialised.nextIndex,
    metas: serialised.metas,
    engine: serialised.engine,
    model: serialised.model,
  });
}

// The saved surface map of a room record, or null.
export async function loadScan(room) {
  if (!room || !room.scan || !room.scan.width) {
    return null;
  }
  const bytes = await getFileBytes(room.id + "/scan/labels");
  if (!bytes || bytes.byteLength !== room.scan.width * room.scan.height * 2) {
    return null;
  }
  return Object.assign({}, room.scan, {
    labelMap: new Uint16Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / 2,
    ),
  });
}

export function saveRoom(record) {
  return sendJson("PUT", "/rooms/" + encodeURIComponent(record.id), record);
}

export async function loadRoom(roomId) {
  try {
    const answer = await getJson("/rooms/" + encodeURIComponent(roomId));
    return answer.room;
  } catch (error) {
    if (error instanceof ApiError && error.httpStatus === 404) {
      return null;
    }
    throw error;
  }
}

// Saved rooms, newest first: { id, name, updatedAt, versionCount }.
export async function listRooms() {
  const answer = await getJson("/rooms");
  return answer.rooms || [];
}

export function deleteRoom(roomId) {
  return sendJson("DELETE", "/rooms/" + encodeURIComponent(roomId));
}
