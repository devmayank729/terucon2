// A small least-recently-used cache: a Map keeps insertion order, so re-inserting a key on every read makes the first key
// the oldest. Used for the catalogue textures (renderer.js): a phone cannot keep a hundred decoded textures alive, but the
// handful the designer is flicking between must stay instant.
export function createLru(max, onEvict) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) {
        return undefined;
      }
      const value = map.get(key);
      map.delete(key);
      map.set(key, value); // now the newest
      return value;
    },
    // like get() but does not count as a use
    peek(key) {
      return map.get(key);
    },
    has(key) {
      return map.has(key);
    },
    set(key, value) {
      if (map.has(key)) {
        map.delete(key);
      }
      map.set(key, value);
      while (map.size > max) {
        const oldest = map.keys().next().value;
        const evicted = map.get(oldest);
        map.delete(oldest);
        if (onEvict) {
          onEvict(oldest, evicted);
        }
      }
      return value;
    },
    delete(key) {
      if (map.has(key)) {
        const value = map.get(key);
        map.delete(key);
        if (onEvict) {
          onEvict(key, value);
        }
      }
    },
    clear() {
      Array.from(map.keys()).forEach((key) => this.delete(key));
    },
    keys() {
      return Array.from(map.keys());
    },
    get size() {
      return map.size;
    },
  };
}
