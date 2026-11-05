/**
 * "Capture from a phone": the logic, with no web code in it. The routes (server/capture/routes.js) check who is asking and pass plain
 * values in; this file decides, stores and answers.
 *
 * Two kinds of person use it:
 *   the requester   signed in on a laptop (or the studio's per-browser owner id when sign-in is off). Makes a link, sees the photos
 *                   that come in, moves them to another page, deletes them. Everything they can reach is filtered by `owner`.
 *   the capturer    anybody with the link, on a phone. May only: read what the link is for, give their details, add photos,
 *                   say they are done. The token in the link is 192 random bits; it is a key to ONE link and to nothing else, and it
 *                   lets nobody read a photo back.
 *
 * Why a retried upload is harmless: a photo's id is `<session>_<id the phone made>`; the database's own unique `_id` refuses a second
 * copy, and the photo counter is only raised when a new photo is really going in (and put back if the write fails).
 */
import { randomId, randomToken } from '../auth/crypto.js';
import { RateLimiter } from '../lib/rateLimit.js';
import { sizeAllowed, sniffImage } from '../lib/inspiration/imageBytes.js';
import { isLocalHostname } from './config.js';
import { isDuplicateKey, StoreUnavailableError } from './db.js';
import { stripMetadata } from './strip.js';
import { CaptureError, cleanCapturer, cleanPhotoMeta, cleanLine, firstName, ID_32, normalizePhone, PHOTO_ID, SERVICE_LABELS, SERVICES, TOKEN } from './validate.js';
import { maskPhone, waLink, WhatsAppError } from './whatsapp.js';

export { StoreUnavailableError };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_OPEN_LINKS = 5;
const MAX_LINK_MESSAGES_PER_SESSION = 3;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** A picture with no photo record that is older than this is what a crash left behind, not a copy still being written. */
const STALE_PICTURE_MS = 60 * 1000;

const isOpen = (session, now) => !session.closedAt && session.expiresAt > now;

/**
 * @param {object} options
 * @param {ReturnType<typeof import('./db.js').createCaptureDb>} options.db
 * @param {() => import('./config.js').CAPTURE_DEFAULTS & {whatsappToken: string}} options.config
 * @param {ReturnType<typeof import('./whatsapp.js').createWhatsApp>} options.whatsapp
 * @param {{info: Function, warn: Function}} [options.log]
 * @param {() => number} [options.now]
 */
export function createCaptureService({ db, config, whatsapp, log, now = Date.now }) {
  const sessionsLimit = new RateLimiter({ windowMs: HOUR, now });
  const whatsappLimit = new RateLimiter({ windowMs: HOUR, now });
  const recipientLimit = new RateLimiter({ windowMs: DAY, now });
  const uploadsLimit = new RateLimiter({ windowMs: HOUR, now });
  const readsLimit = new RateLimiter({ windowMs: HOUR, now });
  const tokenFailures = new RateLimiter({ windowMs: 10 * MINUTE, now });
  const limiters = [sessionsLimit, whatsappLimit, recipientLimit, uploadsLimit, readsLimit, tokenFailures];

  const sessions = () => db.col('capture_sessions');
  const photos = () => db.col('capture_photos');
  const files = () => db.col('capture_files');

  const purgeAt = () => new Date(now() + config().keepDays * DAY);

  /** Refuse (429) when `key` has used up `limit` in the limiter's window; otherwise count it. */
  function spend(limiter, key, limit, message) {
    const verdict = limiter.check(key, limit);
    if (!verdict.ok) throw new CaptureError(429, 'rate-limit', message, { retryAfter: verdict.retryAfter });
    limiter.record(key);
  }

  // ---------------------------------------------------------------------------------------------------- what leaves this file

  function photoView(p) {
    return { id: p._id, session: p.session, service: p.service, tags: p.tags ?? [], note: p.note ?? '', type: p.type, width: p.width ?? null, height: p.height ?? null, bytes: p.bytes, createdAt: p.createdAt };
  }

  /** What the requester sees of a link. `link` only while the link still works (the token is what makes it work). */
  function sessionView(s, { base = null } = {}) {
    const open = isOpen(s, now());
    return {
      id: s._id,
      service: s.service,
      note: s.note ?? '',
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      closedAt: s.closedAt ?? null,
      open,
      photoCount: s.photoCount ?? 0,
      maxPhotos: s.maxPhotos,
      capturer: s.capturer ?? null,
      doneAt: s.doneAt ?? null,
      alert: s.notifyPhone ? { to: maskPhone(s.notifyPhone), status: s.notifyStatus ?? 'waiting' } : null,
      ...(open && base ? { link: `${base}/capture#${s.token}` } : {}),
    };
  }

  /**
   * The address the phone opens. CAPTURE_PUBLIC_URL (or Render's own address); only on this computer the page's own address, and then
   * `reachable` is false so the page says a phone cannot open it. Anything else refuses: a Host header is whatever the caller wrote.
   */
  function linkBase(requestOrigin) {
    const c = config();
    if (c.publicUrl) return { base: c.publicUrl, reachable: !isLocalHostname(new URL(c.publicUrl).hostname) };
    if (requestOrigin) {
      let host;
      try {
        host = new URL(requestOrigin).hostname;
      } catch {
        host = '';
      }
      if (host && isLocalHostname(host)) return { base: requestOrigin, reachable: false };
    }
    throw new CaptureError(503, 'no-public-url', 'The address a phone should open is not set up on this server yet. Ask the site owner to set CAPTURE_PUBLIC_URL.');
  }

  // ---------------------------------------------------------------------------------------------------- the requester

  async function createSession(owner, { service, note, requesterName }, requestOrigin) {
    if (!SERVICES.includes(service)) throw new CaptureError(400, 'bad-service', 'Choose the Design Studio, Inspiration or the Finder.');
    const { base, reachable } = linkBase(requestOrigin);
    const c = config();
    spend(sessionsLimit, owner, c.limitSessions, 'You have made a lot of links in the last hour. Please wait a little.');
    const t = now();
    const col = await sessions();
    const open = await col.countDocuments({ owner, closedAt: null, expiresAt: { $gt: t } });
    if (open >= MAX_OPEN_LINKS) throw new CaptureError(409, 'too-many-open', `You already have ${MAX_OPEN_LINKS} links open. End one before making another.`);
    const doc = {
      _id: randomId(),
      token: randomToken(24),
      owner,
      service,
      note: cleanLine(note, 200),
      requesterName: firstName(requesterName),
      createdAt: t,
      expiresAt: t + c.sessionMinutes * MINUTE,
      closedAt: null,
      maxPhotos: c.maxPhotos,
      photoCount: 0,
      capturer: null,
      doneAt: null,
      notifyPhone: null,
      notifyStatus: null,
      firstNotifiedAt: null,
      doneNotifiedAt: null,
      linkMessages: 0,
      purgeAt: purgeAt(),
    };
    await col.insertOne(doc);
    return { session: sessionView(doc, { base }), reachable };
  }

  async function ownedSession(owner, id) {
    if (!ID_32.test(String(id))) throw new CaptureError(404, 'not-found', 'That link does not exist.');
    const s = await (await sessions()).findOne({ _id: id, owner });
    if (!s) throw new CaptureError(404, 'not-found', 'That link does not exist.');
    return s;
  }

  async function getSession(owner, id, requestOrigin) {
    const s = await ownedSession(owner, id);
    return { session: sessionView(s, { base: safeBase(requestOrigin) }) };
  }

  /** The base for links in a listing: a listing must work even when no address is configured (it then has no links). */
  function safeBase(requestOrigin) {
    try {
      return linkBase(requestOrigin).base;
    } catch {
      return null;
    }
  }

  async function closeSession(owner, id) {
    const s = await ownedSession(owner, id);
    if (!s.closedAt) await (await sessions()).updateOne({ _id: s._id, owner }, { $set: { closedAt: now() } });
    return { ok: true };
  }

  async function deleteFilesOf(ids) {
    const col = await files();
    for (let i = 0; i < ids.length; i += 500) await col.deleteMany({ _id: { $in: ids.slice(i, i + 500) } });
  }

  async function deleteSession(owner, id) {
    const s = await ownedSession(owner, id);
    const ps = await (await photos()).find({ session: s._id, owner }).toArray();
    await deleteFilesOf(ps.map((p) => p._id));
    await (await photos()).deleteMany({ session: s._id, owner });
    await (await sessions()).deleteOne({ _id: s._id, owner });
    return { ok: true, deleted: ps.length };
  }

  async function deletePhoto(owner, photoId) {
    if (!PHOTO_ID.test(String(photoId))) throw new CaptureError(404, 'not-found', 'That photo does not exist.');
    const p = await (await photos()).findOne({ _id: photoId, owner });
    if (!p) throw new CaptureError(404, 'not-found', 'That photo does not exist.');
    await (await files()).deleteOne({ _id: p._id });
    await (await photos()).deleteOne({ _id: p._id, owner });
    return { ok: true };
  }

  /** Delete everything an owner has here (their account was deleted). */
  async function deleteAllOf(owner) {
    if (!db.connected()) return 0;
    const ps = await (await photos()).find({ owner }).toArray();
    await deleteFilesOf(ps.map((p) => p._id));
    await (await photos()).deleteMany({ owner });
    await (await sessions()).deleteMany({ owner });
    return ps.length;
  }

  async function photoFile(owner, photoId) {
    if (!PHOTO_ID.test(String(photoId))) throw new CaptureError(404, 'not-found', 'That photo does not exist.');
    const p = await (await photos()).findOne({ _id: photoId, owner });
    const f = p ? await (await files()).findOne({ _id: p._id }) : null;
    if (!p || !f || typeof f.data !== 'string') throw new CaptureError(404, 'not-found', 'That photo does not exist.');
    return { type: p.type, bytes: Buffer.from(f.data, 'base64') };
  }

  /**
   * The requester's links and photos. `after` is the `createdAt` of the newest photo they already have (0: the latest 60). A photo
   * made in the same millisecond as `after` comes again, so the page keeps the ids it has shown.
   */
  async function inbox(owner, { after = 0 } = {}, requestOrigin) {
    const t = now();
    const base = safeBase(requestOrigin);
    const ss = await (await sessions()).find({ owner }).sort({ createdAt: -1 }).limit(40).toArray();
    const pc = await photos();
    let ps;
    if (after > 0) ps = await pc.find({ owner, createdAt: { $gte: after } }).sort({ createdAt: 1 }).limit(100).toArray();
    else ps = (await pc.find({ owner }).sort({ createdAt: -1 }).limit(60).toArray()).reverse();
    return { now: t, sessions: ss.map((s) => sessionView(s, { base })), photos: ps.map(photoView) };
  }

  /** Where the requester is told when a photo arrives, by WhatsApp. `phone` null turns it off. */
  async function setAlert(owner, id, phone) {
    const s = await ownedSession(owner, id);
    if (phone === null || phone === '' || phone === undefined) {
      await (await sessions()).updateOne({ _id: s._id, owner }, { $set: { notifyPhone: null, notifyStatus: null } });
      return { alert: null };
    }
    const digits = normalizePhone(phone, config().defaultCountryCode);
    if (!digits) throw new CaptureError(400, 'bad-phone', 'That WhatsApp number does not look right. Enter it with the country code, for example +91 98765 43210.');
    if (!whatsapp.state().photoAlerts) throw new CaptureError(503, 'whatsapp-off', 'WhatsApp alerts are not set up on this server. You will still see the photos here as soon as they arrive.');
    await (await sessions()).updateOne({ _id: s._id, owner }, { $set: { notifyPhone: digits, notifyStatus: 'waiting' } });
    return { alert: { to: maskPhone(digits), status: 'waiting' } };
  }

  /**
   * Send the link to a number. With the Cloud API and a link template the server sends it; otherwise it answers with the wa.me address
   * and the requester sends the message from their own WhatsApp. The wa.me address is in the answer either way, as the fallback.
   */
  async function sendLink(owner, id, { phone, requesterName }, requestOrigin) {
    const s = await ownedSession(owner, id);
    if (!isOpen(s, now())) throw new CaptureError(410, 'closed', 'This link has ended. Make a new one.');
    const digits = normalizePhone(phone, config().defaultCountryCode);
    if (!digits) throw new CaptureError(400, 'bad-phone', 'That WhatsApp number does not look right. Enter it with the country code, for example +91 98765 43210.');
    const { base } = linkBase(requestOrigin);
    const link = `${base}/capture#${s.token}`;
    const minutes = Math.max(1, Math.round((s.expiresAt - now()) / MINUTE));
    const from = firstName(requesterName) || 'Someone';
    const text = `Hi, ${from} from Terucon asked you to add photos of a space. Open this link on your phone to take or choose them: ${link} (works for ${minutes} minutes).`;
    const fallback = waLink(digits, text);
    const c = config();
    if (!whatsapp.state().linkMessages || c.limitWhatsapp === 0) return { mode: 'link', waLink: fallback, to: maskPhone(digits) };

    // the server sends it: slow down every way this could be misused to message strangers
    spend(whatsappLimit, owner, c.limitWhatsapp, 'You have sent a lot of WhatsApp messages in the last hour. Please wait a little.');
    spend(recipientLimit, digits, 2, 'That number has already been sent links twice today. Share the link another way, or try again tomorrow.');
    const claimed = await (await sessions()).updateOne({ _id: s._id, owner, linkMessages: { $lt: MAX_LINK_MESSAGES_PER_SESSION } }, { $inc: { linkMessages: 1 } });
    if (!claimed.matchedCount) throw new CaptureError(429, 'rate-limit', 'This link has already been sent three times. Share it another way, or make a new link.');
    try {
      await whatsapp.sendTemplate({ to: digits, template: 'link', params: [from, link, String(minutes)] });
    } catch (error) {
      if (!(error instanceof WhatsAppError)) throw error;
      throw new CaptureError(502, 'whatsapp-failed', `WhatsApp did not take the message (${error.message}). You can open WhatsApp and send it yourself.`, {});
    }
    return { mode: 'sent', to: maskPhone(digits), waLink: fallback };
  }

  // ---------------------------------------------------------------------------------------------------- the capturer

  /** The link a token belongs to. Unknown, mistyped and not-a-token all look the same from outside. */
  async function byToken(token, address) {
    const key = address ?? 'unknown';
    const verdict = tokenFailures.check(key, 30);
    if (!verdict.ok) throw new CaptureError(429, 'rate-limit', 'Too many wrong links from this connection. Please wait a few minutes.', { retryAfter: verdict.retryAfter });
    const s = typeof token === 'string' && TOKEN.test(token) ? await (await sessions()).findOne({ token }) : null;
    if (!s) {
      tokenFailures.record(key);
      throw new CaptureError(404, 'unknown-link', 'This link is not valid. Ask the person who sent it for a new one.');
    }
    if (s.closedAt) throw new CaptureError(410, 'closed', 'This link has been closed. Ask for a new one.');
    if (s.expiresAt <= now()) throw new CaptureError(410, 'expired', 'This link has expired. Ask for a new one.');
    return s;
  }

  async function info(token, address) {
    spend(readsLimit, `ip:${address ?? 'unknown'}`, 600, 'Too many requests from this connection. Please wait a little.');
    const s = await byToken(token, address);
    return { service: s.service, serviceLabel: SERVICE_LABELS[s.service], requester: s.requesterName || '', note: s.note ?? '', expiresAt: s.expiresAt, maxPhotos: s.maxPhotos, remaining: Math.max(0, s.maxPhotos - (s.photoCount ?? 0)), maxPhotoBytes: config().maxPhotoBytes, detailsSaved: Boolean(s.capturer), serverNow: now(), keepDays: config().keepDays };
  }

  async function saveCapturer(token, input, address) {
    spend(readsLimit, `ip:${address ?? 'unknown'}`, 600, 'Too many requests from this connection. Please wait a little.');
    const s = await byToken(token, address);
    const capturer = cleanCapturer(input, { defaultCountryCode: config().defaultCountryCode, now: now() });
    await (await sessions()).updateOne({ _id: s._id, closedAt: null }, { $set: { capturer } });
    return { ok: true, capturer };
  }

  /**
   * @param {string} token
   * @param {{cid: string, meta: string, bytes: Buffer}} photo cid: the id the phone made for this photo (a retry sends the same one)
   * @param {string} [address] the phone's network address, for the limit
   */
  async function addPhoto(token, { cid, meta, bytes }, address) {
    spend(uploadsLimit, `ip:${address ?? 'unknown'}`, config().limitUploads, 'Too many photos from this connection in the last hour. Please wait a little.');
    if (!ID_32.test(String(cid))) throw new CaptureError(400, 'bad-photo-id', 'The photo has no valid id.');
    const c = config();
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new CaptureError(400, 'empty', 'The photo was empty.');
    if (bytes.length > c.maxPhotoBytes) throw new CaptureError(413, 'too-large', `That photo is larger than ${Math.round(c.maxPhotoBytes / 1048576)} MB.`);
    const found = sniffImage(bytes);
    if (!found || !PHOTO_TYPES.has(found.type)) throw new CaptureError(415, 'bad-image', 'That file is not a JPEG, PNG or WebP photo.');
    if (!sizeAllowed(found)) throw new CaptureError(413, 'too-large-pixels', 'That photo is too large in pixels.');
    const photoMeta = cleanPhotoMeta(meta);
    const s = await byToken(token, address);
    if (!s.capturer) throw new CaptureError(409, 'details-needed', 'Please enter your name before sending photos.');
    const clean = stripMetadata(bytes, found.type);
    if (!clean) throw new CaptureError(400, 'bad-image', 'That photo could not be read. It may be damaged.');
    const size = sniffImage(clean) ?? found;

    const id = `${s._id}_${cid}`;
    const pc = await photos();
    const fc = await files();
    const left = () => Math.max(0, s.maxPhotos - (s.photoCount ?? 0));
    const existing = await pc.findOne({ _id: id });
    if (existing) return { photo: photoView(existing), duplicate: true, remaining: left() };

    // The photo's id is the lock. The picture is written first, under that id, and only one copy of a photo can write it. A copy that arrives while another
    // is being stored (a phone that timed out and tried again) therefore never touches the place counter, so it can neither use a second place nor be told
    // "full" about a photo that is in fact being stored.
    const t = now();
    const keep = purgeAt();
    const picture = { data: clean.toString('base64'), createdAt: t, purgeAt: keep };
    try {
      await fc.insertOne({ _id: id, ...picture });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const winner = await pc.findOne({ _id: id });
      if (winner) return { photo: photoView(winner), duplicate: true, remaining: left() };
      // a picture with no photo record: another copy still being written, or what a crash left behind. Only a stale one is taken over; the filter makes two
      // takeovers race safely (one matches, the other does not)
      const old = await fc.findOne({ _id: id });
      const took = old && t - (old.createdAt ?? 0) > STALE_PICTURE_MS ? await fc.updateOne({ _id: id, createdAt: old.createdAt ?? null }, { $set: picture }) : { matchedCount: 0 };
      if (!took.matchedCount) throw new CaptureError(409, 'in-progress', 'That photo is arriving already. Trying again.', { retryAfter: 1 });
    }
    const dropPicture = () => fc.deleteOne({ _id: id }).catch(() => {});

    const reserved = await (await sessions()).updateOne({ _id: s._id, closedAt: null, expiresAt: { $gt: t }, photoCount: { $lt: s.maxPhotos } }, { $inc: { photoCount: 1 }, $set: { lastPhotoAt: t } });
    if (!reserved.matchedCount) {
      await dropPicture();
      const again = await (await sessions()).findOne({ _id: s._id });
      if (!again || again.closedAt) throw new CaptureError(410, 'closed', 'This link has been closed. Ask for a new one.');
      if (again.expiresAt <= t) throw new CaptureError(410, 'expired', 'This link has expired. Ask for a new one.');
      throw new CaptureError(409, 'full', `This link takes up to ${s.maxPhotos} photos and it is full. Ask for a new link to send more.`);
    }
    try {
      const doc = { _id: id, session: s._id, owner: s.owner, service: s.service, tags: photoMeta.tags, note: photoMeta.note, type: found.type, width: size.width ?? null, height: size.height ?? null, bytes: clean.length, createdAt: t, purgeAt: keep };
      await pc.insertOne(doc);
      afterPhoto(s, id).catch((error) => log?.warn(`capture  alert step failed: ${String(error?.message ?? error).slice(0, 120)}`));
      return { photo: photoView(doc), duplicate: false, remaining: Math.max(0, left() - 1) };
    } catch (error) {
      // the place and the picture are given back: nothing half-stored stays
      await dropPicture();
      await (await sessions()).updateOne({ _id: s._id }, { $inc: { photoCount: -1 } }).catch(() => {});
      throw error;
    }
  }

  /** The capturer says they are finished: one message to the requester if there were several photos. */
  async function done(token, address) {
    spend(readsLimit, `ip:${address ?? 'unknown'}`, 600, 'Too many requests from this connection. Please wait a little.');
    const s = await byToken(token, address);
    const col = await sessions();
    await col.updateOne({ _id: s._id }, { $set: { doneAt: now() } });
    const latest = await col.findOne({ _id: s._id });
    if (latest?.notifyPhone && (latest.photoCount ?? 0) > 1) {
      const claimed = await col.updateOne({ _id: s._id, doneNotifiedAt: null }, { $set: { doneNotifiedAt: now() } });
      if (claimed.matchedCount) alertRequester(latest, latest.photoCount).catch((error) => log?.warn(`capture  alert step failed: ${String(error?.message ?? error).slice(0, 120)}`));
    }
    return { ok: true, photoCount: latest?.photoCount ?? 0 };
  }

  // ---------------------------------------------------------------------------------------------------- telling the requester

  async function afterPhoto(s) {
    if (!s.notifyPhone) return;
    const claimed = await (await sessions()).updateOne({ _id: s._id, firstNotifiedAt: null }, { $set: { firstNotifiedAt: now() } });
    if (!claimed.matchedCount) return;
    const latest = await (await sessions()).findOne({ _id: s._id });
    await alertRequester(latest ?? s, 1);
  }

  async function alertRequester(s, count) {
    if (!s.notifyPhone) return;
    const col = await sessions();
    try {
      await whatsapp.sendTemplate({ to: s.notifyPhone, template: 'photo', params: [s.capturer?.name || 'Someone', String(count), SERVICE_LABELS[s.service] ?? 'Terucon'] });
      await col.updateOne({ _id: s._id }, { $set: { notifyStatus: 'sent' } });
    } catch (error) {
      await col.updateOne({ _id: s._id }, { $set: { notifyStatus: 'failed' } }).catch(() => {});
      if (!(error instanceof WhatsAppError)) throw error;
    }
  }

  return {
    createSession,
    getSession,
    closeSession,
    deleteSession,
    deletePhoto,
    deleteAllOf,
    photoFile,
    inbox,
    setAlert,
    sendLink,
    info,
    saveCapturer,
    addPhoto,
    done,
    linkBase,
    close() {
      for (const l of limiters) l.close();
    },
  };
}
