// Unit tests for npy.js, run with: node server/lib/npy.test.js
//
// Builds its own .npy fixtures with a small encoder (below, test-only - not shipped, npy.js
// only ever needs to read, never write) rather than needing Python/numpy at test time. That
// encoder's output was itself cross-checked during development against a real numpy-written
// .npz (float32 depth with +Infinity holes, a bool mask, a normalized 3x3 intrinsics matrix,
// multi-dimensional arrays) and parsed correctly - these tests check the same shapes and edge
// cases, just without a Python dependency to run them.
const assert = require("node:assert/strict");
const { parseNpy } = require("./npy");

let passed = 0;
const pending = [];
function test(name, fn) {
  pending.push({ name: name, fn: fn });
}
async function runAll() {
  for (const entry of pending) {
    try {
      await entry.fn();
      passed += 1;
      console.log("PASS " + entry.name);
    } catch (error) {
      console.error("FAIL " + entry.name);
      console.error(error);
      process.exitCode = 1;
    }
  }
  console.log("\n" + passed + "/" + pending.length + " test case(s) passed");
}

// A minimal, spec-correct .npy (v1.0) encoder for float32/uint8 arrays - just enough to build
// test fixtures.
function encodeNpy(data, shape, dtype) {
  const shapeStr = shape.length === 1 ? "(" + shape[0] + ",)" : "(" + shape.join(", ") + ")";
  let header =
    "{'descr': '" + dtype + "', 'fortran_order': False, 'shape': " + shapeStr + ", }";
  const prefixLen = 10; // magic(6) + version(2) + headerLen(2)
  const pad = (64 - ((prefixLen + header.length + 1) % 64)) % 64;
  header += " ".repeat(pad) + "\n";
  const headerBytes = Buffer.from(header, "ascii");
  const magic = Buffer.from([0x93, ...Buffer.from("NUMPY", "ascii"), 1, 0]);
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16LE(headerBytes.length, 0);
  const dataBuf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.concat([magic, lenBuf, headerBytes, dataBuf]);
}

test("parses a 1D float32 array", function () {
  const data = new Float32Array([1.5, -2.25, 3.0, 0]);
  const npy = encodeNpy(data, [4], "<f4");
  const result = parseNpy(npy);
  assert.equal(result.dtype, "<f4");
  assert.deepEqual(result.shape, [4]);
  assert.ok(result.data instanceof Float32Array);
  assert.deepEqual(Array.from(result.data), [1.5, -2.25, 3.0, 0]);
});

test("parses a multi-dimensional float32 array (shape preserved, data flat C-order)", function () {
  const data = new Float32Array([1, 2, 3, 4, 5, 6]); // logically 2x3
  const npy = encodeNpy(data, [2, 3], "<f4");
  const result = parseNpy(npy);
  assert.deepEqual(result.shape, [2, 3]);
  assert.deepEqual(Array.from(result.data), [1, 2, 3, 4, 5, 6]);
});

test("parses a uint8 (numpy-bool-like) array", function () {
  const data = new Uint8Array([1, 0, 1, 1, 0]);
  const npy = encodeNpy(data, [5], "|b1");
  const result = parseNpy(npy);
  assert.equal(result.dtype, "|b1");
  assert.ok(result.data instanceof Uint8Array);
  assert.deepEqual(Array.from(result.data), [1, 0, 1, 1, 0]);
});

test("preserves +Infinity (how masked-out MoGe-2 depth pixels are represented)", function () {
  const data = new Float32Array([1.5, Infinity, 2.5]);
  const npy = encodeNpy(data, [3], "<f4");
  const result = parseNpy(npy);
  assert.equal(result.data[1], Infinity);
});

test("rejects a bad magic number instead of misreading garbage", function () {
  const bad = Buffer.from("not an npy file at all, just text");
  assert.throws(function () {
    parseNpy(bad);
  }, /magic/i);
});

test("rejects an unsupported dtype instead of silently misinterpreting bytes", function () {
  const data = new Float32Array([1, 2]);
  const npy = encodeNpy(data, [2], "<c16"); // complex128 - deliberately unsupported
  assert.throws(function () {
    parseNpy(npy);
  }, /dtype/i);
});

runAll();
