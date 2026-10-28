// MongoDB connection and the GridFS bucket that holds photos, renders and masks.
// Room records (names, versions, materials) live in the "rooms" collection; their images
// live in GridFS ("files" bucket), filed under the room id like papers in a folder.
const mongoose = require("mongoose");
const config = require("./config");

let bucket = null;
let state = { connected: false, error: "" };

mongoose.set("strictQuery", true);
mongoose.connection.on("disconnected", function () {
  state.connected = false;
});
mongoose.connection.on("connected", function () {
  state.connected = true;
  state.error = "";
});

async function connect() {
  try {
    await mongoose.connect(config.mongoUri, {
      serverSelectionTimeoutMS: 8000,
    });
    bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: "files",
    });
    await mongoose.connection.db
      .collection("files.files")
      .createIndex({ "metadata.roomId": 1 });
    state.connected = true;
  } catch (error) {
    state.connected = false;
    state.error = error.message;
    throw error;
  }
}

function files() {
  if (!bucket) {
    throw new Error("MongoDB is not connected.");
  }
  return bucket;
}

function status() {
  return {
    connected: state.connected && mongoose.connection.readyState === 1,
    error: state.error,
    database: mongoose.connection.name || "",
  };
}

module.exports = { connect: connect, files: files, status: status };
