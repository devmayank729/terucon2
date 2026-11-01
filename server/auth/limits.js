/**
 * Counting things to enforce limits. Two kinds, for two jobs:
 *
 *   in memory   a sliding window per network address (`ip`). Cheap, so it can sit in front of every request; a restart clears it
 *               and two server instances do not share it (the site runs as one process).
 *   persisted   a record per event in the database (`consume`, `count`), for limits that must survive a restart and cannot be
 *               dodged by changing address: how many codes one e-mail address or phone number may be sent, how many wrong codes
 *               it may be given, how many text messages the whole site may send in a day.
 *
 * `consume` records first and counts second, then takes its own record back if it went over. Two requests arriving together
 * therefore cannot both slip under a limit: each sees the other's record.
 */
import net from 'node:net';
import { RateLimiter } from '../lib/rateLimit.js';
import { randomId } from './crypto.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function expandIPv6(text) {
  let ip = text;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    ip = `${ip.slice(0, -v4[1].length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups = head;
  if (tail) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  const numbers = groups.map((g) => parseInt(g, 16));
  return numbers.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff) ? null : numbers;
}

/**
 * The key a network address is counted under. An IPv4 address as it is; an IPv4-mapped IPv6 address as its IPv4; any other IPv6
 * address by its first 64 bits, because one customer's line hands out billions of addresses inside a /64 and counting each
 * separately would make every limit a formality.
 */
export function ipKey(raw) {
  let ip = String(raw ?? '').trim();
  if (!ip) return 'unknown';
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  if (net.isIPv4(ip)) return ip;
  if (!net.isIPv6(ip)) return 'unknown';
  const groups = expandIPv6(ip);
  if (!groups) return 'unknown';
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  return `v6:${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}`;
}

export class AuthLimits {
  #db;
  #now;
  #windows;

  /** @param {{db: ReturnType<typeof import('./db.js').createAuthDb>, now?: () => number}} options */
  constructor({ db, now = Date.now }) {
    this.#db = db;
    this.#now = now;
    this.#windows = {
      minute: new RateLimiter({ windowMs: MINUTE, now }),
      hour: new RateLimiter({ windowMs: HOUR, now }),
      day: new RateLimiter({ windowMs: DAY, now }),
    };
  }

  /**
   * Count one request from `ip` against `name`; refuse it (without counting) when `max` is already used up in the window.
   * @param {'minute' | 'hour' | 'day'} per
   * @returns {{ok: boolean, retryAfter: number}}
   */
  ip(name, ip, max, per = 'hour') {
    const key = `${name}:${ipKey(ip)}`;
    const window = this.#windows[per];
    const verdict = window.check(key, max);
    if (!verdict.ok) return verdict;
    window.record(key);
    return { ok: true, retryAfter: 0 };
  }

  /** Whether `ip` still has room under `max`, without using any of it. */
  ipPeek(name, ip, max, per = 'hour') {
    return this.#windows[per].check(`${name}:${ipKey(ip)}`, max);
  }

  /** Use one of an address's allowance (after a failure). */
  ipRecord(name, ip, per = 'hour') {
    this.#windows[per].record(`${name}:${ipKey(ip)}`);
  }

  async #hits() {
    return this.#db.col('hits');
  }

  /** Record one event and refuse it (taking the record back) when more than `max` have happened within `windowMs`. */
  async consume(kind, key, max, windowMs) {
    const col = await this.#hits();
    const k = `${kind}:${key}`;
    const now = this.#now();
    const _id = randomId();
    await col.insertOne({ _id, k, t: now, purgeAt: new Date(now + Math.max(windowMs, DAY) + HOUR) });
    const used = await col.countDocuments({ k, t: { $gt: now - windowMs } });
    if (used <= max) return { ok: true, retryAfter: 0, id: _id };
    await col.deleteOne({ _id });
    const [oldest] = await col.find({ k, t: { $gt: now - windowMs } }).sort({ t: 1 }).limit(1).toArray();
    return { ok: false, retryAfter: oldest ? Math.max(1, Math.ceil((oldest.t + windowMs - now) / 1000)) : Math.ceil(windowMs / 1000) };
  }

  /** Take back an event that `consume` counted (a code that could not be sent should not use up the allowance). */
  async refund(id) {
    const col = await this.#hits();
    await col.deleteOne({ _id: id });
  }

  /** Record one event without checking anything (a wrong code, for instance). */
  async record(kind, key, windowMs = HOUR) {
    const col = await this.#hits();
    const now = this.#now();
    const _id = randomId();
    await col.insertOne({ _id, k: `${kind}:${key}`, t: now, purgeAt: new Date(now + Math.max(windowMs, DAY) + HOUR) });
    return _id;
  }

  /** How many events of this kind happened within the window, and when the window will have room again. */
  async count(kind, key, windowMs) {
    const col = await this.#hits();
    const k = `${kind}:${key}`;
    const now = this.#now();
    const filter = { k, t: { $gt: now - windowMs } };
    const used = await col.countDocuments(filter);
    if (!used) return { used: 0, oldest: null };
    const [oldest] = await col.find(filter).sort({ t: 1 }).limit(1).toArray();
    return { used, oldest: oldest?.t ?? null };
  }

  /** Forget the events of one kind for one key (a successful sign-in clears the wrong codes). */
  async clear(kind, key) {
    const col = await this.#hits();
    await col.deleteMany({ k: `${kind}:${key}` });
  }

  /** Whether `key` has had `max` or more events within the window, and when that stops being true. */
  async locked(kind, key, max, windowMs) {
    const { used, oldest } = await this.count(kind, key, windowMs);
    if (used < max) return { locked: false, retryAfter: 0 };
    return { locked: true, retryAfter: Math.max(1, Math.ceil(((oldest ?? this.#now()) + windowMs - this.#now()) / 1000)) };
  }

  close() {
    for (const window of Object.values(this.#windows)) window.close();
  }
}

export const WINDOWS = { MINUTE, HOUR, DAY };
