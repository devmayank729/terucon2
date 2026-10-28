// The remote MoGe-2 server: "how big, and which way?" - the room's 3D shape, in real metres.
// Hits a Modal-hosted vision_stack.py's /v1/geometry endpoint (one of three sibling services -
// MoGe-2, Marigold-IID, SAM 3 - sharing one calling convention: multipart POST, Bearer or
// X-API-Key auth, {error,detail} JSON on failure; see the other two adapters in this folder).
//
// Canonical output every caller (server/lib/fusion.js) actually works with:
//   {
//     width, height,
//     depth: Float32Array[width*height],      // forward distance (Z) at each pixel, metres;
//                                                0 = invalid/unknown
//     intrinsics: {fx, fy, cx, cy},            // pixels; see the unprojection formula below
//     up: null,                                 // this endpoint exposes no gravity/up vector -
//                                                  fusion.js already degrades gracefully without one
//   }
// Camera convention (pinhole, matches the browser renderer's shader exactly - see the plan):
// X right, Y DOWN (image row direction), Z forward. A pixel (px, py) with depth d unprojects
// to world point P = ((px-cx)*d/fx, (py-cy)*d/fy, d). Because Y is down, "world up" is -Y, so
// a floor's normal is close to (0,-1,0) and a ceiling's close to (0,1,0).
const config = require("../../config");
const shared = require("./shared");
const coldStart = require("../coldStart");
const { unzipSync } = require("fflate");
const { parseNpy } = require("../npy");

const NAME = "MoGe-2 server";
const ENV_HINT = "MOGE2_URL";

// POST to MOGE2_URL directly - on Modal, each service (vision_stack.py's @modal.asgi_app) gets
// its own full domain, e.g. "https://<user>--vision-moge2.modal.run/v1/geometry", so the
// configured URL already IS the complete /v1/geometry endpoint; nothing is appended to it
// (confirmed directly: GETting the configured URL as-is returns 405 Method Not Allowed - a
// real FastAPI route that only accepts POST - while appending another "/v1/geometry" on top,
// as this code used to, produced a 404 against a path that doesn't exist).
// multipart fields: image + resolution_level + max_side + include + dtype + compress +
// apply_mask. Returns the raw (unparsed) response body: an .npz (a zip of .npy arrays, see
// server/lib/npy.js), not JSON.
async function call(imageBuffer, options) {
  const form = new FormData();
  form.append("image", new Blob([imageBuffer], { type: "image/jpeg" }), "photo.jpg");
  form.append("resolution_level", String((options && options.resolutionLevel) || 9));
  form.append("max_side", String((options && options.maxSide) || 1280));
  // Only depth + mask + intrinsics are requested: normal/points are not needed (fusion.js
  // reconstructs 3D points itself from depth+intrinsics, matching the shader's own
  // unprojection exactly - see the module comment) and requesting less is less work on a
  // shared GPU, which matters more than saving a local reconstruction step.
  form.append("include", "depth,mask,intrinsics");
  form.append("dtype", "float32");
  form.append("compress", "false");
  form.append("apply_mask", "true");
  // Timed end to end (body included) so the owner can tell a cold container from slow processing -
  // see server/lib/coldStart.js.
  return coldStart.track("moge2", "analyze", options && options.meta, async function () {
    const response = await shared.callMultipart(config.moge2, NAME, "", form, {
      signal: options && options.signal,
    }, ENV_HINT);
    return { response: response, value: Buffer.from(await response.arrayBuffer()) };
  });
}

// Converts the real server's .npz response into the canonical shape above. This is the one
// function that needs to change if the deployed geometry contract ever changes.
function normalize(npzBuffer) {
  let entries;
  try {
    entries = unzipSync(new Uint8Array(npzBuffer));
  } catch (error) {
    throw shared.serviceError(NAME + " did not return a readable .npz file.", 502);
  }
  function array(name) {
    const bytes = entries[name + ".npy"];
    if (!bytes) {
      throw shared.serviceError(NAME + "'s response is missing '" + name + "'.", 502);
    }
    return parseNpy(bytes);
  }

  const sizeHw = array("size_hw").data; // [height, width] of the processed (not original) image
  const height = sizeHw[0];
  const width = sizeHw[1];
  const depthArr = array("depth").data;
  const maskArr = array("mask").data;
  const intr = array("intrinsics").data; // row-major 3x3, normalized: [[fx,0,cx],[0,fy,cy],[0,0,1]]

  const depth = new Float32Array(width * height);
  for (let i = 0; i < depth.length; i += 1) {
    const value = depthArr[i];
    depth[i] = maskArr[i] && Number.isFinite(value) && value > 0 ? value : 0;
  }

  return {
    width: width,
    height: height,
    depth: depth,
    intrinsics: {
      fx: intr[0] * width,
      fy: intr[4] * height,
      cx: intr[2] * width,
      cy: intr[5] * height,
    },
    up: null,
  };
}

async function analyze(imageBuffer, options) {
  return normalize(await call(imageBuffer, options));
}

// ---------------------------------------------------------------- mock (no MOGE2_URL set)
//
// Ray-casts a synthetic box room (back wall, floor, ceiling, two side walls) so fusion.js has
// *exact known ground truth* to fit planes against and compare its result to - independent of
// the real MoGe-2 server. Bypasses normalize() entirely and builds the canonical shape directly.
function castBoxRoom(width, height, options) {
  const opts = options || {};
  const fovDeg = opts.fovDeg || 60;
  const halfW = (opts.roomWidth || 4) / 2; // x: -halfW .. +halfW
  const eyeHeight = opts.eyeHeight || 1.5; // camera is this far above the floor (+Y)
  const ceilingHeight = opts.ceilingHeight || 1.1; // camera is this far below the ceiling (-Y)
  const roomDepth = opts.roomDepth || 5; // z: 0 (camera) .. roomDepth (back wall)

  const fx = width / (2 * Math.tan((fovDeg * Math.PI) / 360));
  const fy = fx;
  const cx = width / 2;
  const cy = height / 2;

  const depth = new Float32Array(width * height);
  const normals = new Float32Array(width * height * 3);
  // Which synthetic face each pixel hit (0 none, 1 floor, 2 ceiling, 3 left, 4 right, 5 back).
  // A mock-only convenience (tests and the SAM-unavailable fallback can use it); not part of
  // the canonical MoGe-2 shape.
  const surface = new Uint8Array(width * height);

  function test(t, x, y, z, valid, surfaceId, normal, best) {
    if (t > 1e-6 && t < best.t && valid(x, y, z)) {
      best.t = t;
      best.surface = surfaceId;
      best.normal = normal;
    }
  }

  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const dx = (px + 0.5 - cx) / fx;
      const dy = (py + 0.5 - cy) / fy;
      const len = Math.sqrt(dx * dx + dy * dy + 1);
      const rx = dx / len;
      const ry = dy / len;
      const rz = 1 / len;

      const best = { t: Infinity, surface: 0, normal: [0, 0, 0] };
      if (ry > 1e-6) {
        const t = eyeHeight / ry;
        test(t, rx * t, eyeHeight, rz * t, function (x, y, z) {
          return Math.abs(x) <= halfW && z <= roomDepth;
        }, 1, [0, -1, 0], best);
      }
      if (ry < -1e-6) {
        const t = -ceilingHeight / ry;
        test(t, rx * t, -ceilingHeight, rz * t, function (x, y, z) {
          return Math.abs(x) <= halfW && z <= roomDepth;
        }, 2, [0, 1, 0], best);
      }
      if (rx < -1e-6) {
        const t = -halfW / rx;
        test(t, -halfW, ry * t, rz * t, function (x, y, z) {
          return y >= -ceilingHeight && y <= eyeHeight && z <= roomDepth;
        }, 3, [1, 0, 0], best);
      }
      if (rx > 1e-6) {
        const t = halfW / rx;
        test(t, halfW, ry * t, rz * t, function (x, y, z) {
          return y >= -ceilingHeight && y <= eyeHeight && z <= roomDepth;
        }, 4, [-1, 0, 0], best);
      }
      {
        const t = roomDepth / rz;
        test(t, rx * t, ry * t, roomDepth, function (x, y) {
          return Math.abs(x) <= halfW && y >= -ceilingHeight && y <= eyeHeight;
        }, 5, [0, 0, -1], best);
      }

      const index = py * width + px;
      depth[index] = best.t === Infinity ? 0 : rz * best.t;
      surface[index] = best.surface;
      normals[index * 3] = best.normal[0];
      normals[index * 3 + 1] = best.normal[1];
      normals[index * 3 + 2] = best.normal[2];
    }
  }

  return {
    width: width,
    height: height,
    depth: depth,
    normals: normals,
    surface: surface,
    intrinsics: { fx: fx, fy: fy, cx: cx, cy: cy },
    up: [0, -1, 0],
  };
}

async function mock(imageBuffer, width, height, options) {
  return castBoxRoom(width, height, options);
}

module.exports = {
  call: call,
  normalize: normalize,
  analyze: analyze,
  mock: mock,
  castBoxRoom: castBoxRoom,
};
