/**
 * A sliding-window counter: "at most `limit` hits per `windowMs` for each key". It lives in this process's memory, so a restart
 * clears it and two server instances do not share it (the site runs as one process). Old keys are dropped as they are met and by
 * a sweep, so the map cannot grow without bound.
 */
export class RateLimiter {
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

  /** Whether `key` may do one more thing now, without counting it. */
  check(key, limit) {
    const list = this.#recent(key);
    if (list.length < limit) return { ok: true, retryAfter: 0 };
    return { ok: false, retryAfter: Math.max(1, Math.ceil((list[0] + this.windowMs - this.now()) / 1000)) };
  }

  /** Count one hit for `key`. */
  record(key) {
    const list = this.#recent(key);
    list.push(this.now());
    this.#hits.set(key, list);
  }

  get size() {
    return this.#hits.size;
  }

  close() {
    clearInterval(this.#sweeper);
  }
}
