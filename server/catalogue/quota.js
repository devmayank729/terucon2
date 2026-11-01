/**
 * Two small counters for the catalogue search.
 *
 *   Quota  "at most `limit` hits per hour for each key", a sliding window kept in this process's memory like the Design Studio's
 *          (server/lib/studioShield.js): a restart clears it and two instances do not share it. Unlike the studio's it can take a hit
 *          back, because a search that was turned away as "busy" before any work was done should not use up a person's hour.
 *   Gate   "at most `max` at once": how many searches may be inside the Modal call at a time. `max` is read on every use, so the
 *          admin's change applies at once.
 */

export class Quota {
  #hits = new Map();
  #sweeper;

  /** @param {{windowMs?: number, now?: () => number}} [options] */
  constructor({ windowMs = 3600000, now = Date.now } = {}) {
    this.windowMs = windowMs;
    this.now = now;
    this.#sweeper = setInterval(() => this.#sweep(), Math.min(windowMs, 600000));
    this.#sweeper.unref?.();
  }

  #recent(key) {
    const cutoff = this.now() - this.windowMs;
    const list = (this.#hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.#hits.set(key, list);
    else this.#hits.delete(key);
    return list;
  }

  #sweep() {
    for (const key of [...this.#hits.keys()]) this.#recent(key);
  }

  /**
   * Whether every `[key, limit]` has room for one more hit now. Counts nothing.
   * @returns {{ok: boolean, retryAfter: number, key?: string}} the key that is full, and how long until it has room
   */
  check(pairs) {
    for (const [key, limit] of pairs) {
      const list = this.#recent(key);
      if (list.length >= limit) return { ok: false, key, retryAfter: Math.max(1, Math.ceil((list[0] + this.windowMs - this.now()) / 1000)) };
    }
    return { ok: true, retryAfter: 0 };
  }

  /** Count one hit on each key. Returns a function that takes exactly those hits back (once). */
  record(keys) {
    const t = this.now();
    for (const key of keys) {
      const list = this.#recent(key);
      list.push(t);
      this.#hits.set(key, list);
    }
    let taken = false;
    return () => {
      if (taken) return;
      taken = true;
      for (const key of keys) {
        const list = this.#hits.get(key);
        const at = list?.lastIndexOf(t) ?? -1;
        if (at !== -1) list.splice(at, 1);
      }
    };
  }

  get size() {
    return this.#hits.size;
  }

  close() {
    clearInterval(this.#sweeper);
  }
}

/** @param {() => number} max the current ceiling */
export function createGate(max) {
  let active = 0;
  return {
    /** A function that gives the place back (safe to call twice), or null when every place is taken. */
    tryAcquire() {
      if (active >= max()) return null;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
      };
    },
    active: () => active,
  };
}
