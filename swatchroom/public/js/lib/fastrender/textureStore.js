// The catalogue textures the preview may need, decoded and ready: a small least-recently-used store. A texture the
// designer has looked at, or one the finishes list is about to show (prefetch), is already in memory when they pick it,
// so choosing a finish costs no network round trip and no decode: it is a layer upload and one frame. The store is bounded
// because a phone cannot keep a hundred decoded bitmaps alive; the oldest one is closed when a new one needs the room.
import { createLru } from "./lru.js";

// load(url) -> Promise<ImageBitmap-like> (anything with an optional close()). `max` bitmaps are kept.
export function createTextureStore(load, max) {
  const cache = createLru(max || 40, function (url, entry) {
    if (entry && entry.bitmap && typeof entry.bitmap.close === "function") {
      entry.bitmap.close();
    }
  });
  const pending = new Map();

  // The bitmap if it is already in memory (counts as a use), else undefined. Synchronous on purpose.
  function peek(url) {
    const entry = cache.get(url);
    return entry ? entry.bitmap : undefined;
  }

  function get(url) {
    const hit = peek(url);
    if (hit) {
      return Promise.resolve(hit);
    }
    if (pending.has(url)) {
      return pending.get(url);
    }
    const promise = load(url).then(
      function (bitmap) {
        pending.delete(url);
        cache.set(url, { bitmap: bitmap });
        return bitmap;
      },
      function (error) {
        pending.delete(url); // a failed load is retried next time, not cached as a dead end
        throw error;
      },
    );
    pending.set(url, promise);
    return promise;
  }

  // Starts loading the ones that are neither in memory nor on their way. Never throws, never blocks.
  function prefetch(urls) {
    let started = 0;
    (urls || []).forEach(function (url) {
      if (url && !cache.has(url) && !pending.has(url)) {
        started += 1;
        get(url).catch(function () {});
      }
    });
    return started;
  }

  return {
    peek: peek,
    get: get,
    prefetch: prefetch,
    has: (url) => cache.has(url),
    keys: () => cache.keys(),
    get size() {
      return cache.size;
    },
    pendingCount: () => pending.size,
  };
}
