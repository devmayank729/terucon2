/**
 * TeruBot, the assistant on every page.
 *
 *   GET  /api/terubot/status   {aiOn, model, signedIn}                         never calls Gemini
 *   POST /api/terubot/chat     {messages, context, speak?}  ->  {aiOn, reply, cards, actions, model, speech?}
 *   GET  /api/terubot/speech?id=<id>&n=<n>                   ->  audio/mpeg: piece n of a reply that was staged for speaking (see below)
 *
 * Public: a visitor who is not signed in may use it (the landing page is public) and then it knows public data only. Signed in, it also
 * knows the visitor's first name. Who is asking is decided HERE from the session cookie; nothing in the request body can name an account.
 *
 * Answers (all JSON; errors are flat {error}, the shape the assistant widget reads, not the nested one of the studio and catalogue routes):
 *   200 {aiOn: true, reply, cards, actions, model}      an answer
 *   200 {aiOn: false, reply, cards: [], actions: []}    the assistant is not available: switched off (TERUBOT=off), no Google key, or Google
 *                                                       cannot be reached / does not accept the key (the reason is in the server log)
 *   400 {error}                                         the request is not the shape above
 *   429 {error, retryAfterSec}                          too many messages (per account, per address, or too many chats at once)
 *   502 {error}                                         Google answered with an error, or too slowly: try again
 *   500 {error}                                         a bug (details in the server log only)
 * The status codes that come from the guards in front of every /api write (415 not JSON, 403 cross-origin) keep the site's nested shape.
 *
 * The voice (server/lib/terubot/voice.js, speech.js): a chat that sends `speak: true` (a live conversation) gets `speech: {id, parts: [{text,
 * lang}]}` back when Google's voice is on: the pieces the reply will be said in, already cleaned for the ear. The browser asks for each
 * piece as audio. There is no endpoint that speaks arbitrary text: only replies TeruBot has just written (and the greeting, id `hello`).
 *   200 audio/mpeg                      the sound of the piece
 *   404 {error}                         no such reply or piece (expired after 15 minutes, or fetched too many times)
 *   429 {error}                         the voice is busy; 502 {error} Google failed; 503 {error} the voice is off (the browser then uses its own)
 *
 * Logging: one line per chat with lengths, model, time, tool names and the status. Never the text of a message or a reply.
 */
import path from 'node:path';
import express from 'express';
import { StoreUnavailableError } from '../auth/index.js';
import { RateLimiter } from '../lib/rateLimit.js';
import { catalogueBridge } from '../lib/terubot/catalogue.js';
import { GeminiError } from '../lib/terubot/gemini.js';
import { VoiceError } from '../lib/terubot/voice.js';
import { BadRequest, parseContext, parseMessages } from '../lib/terubot/input.js';
import { createTerubot, OFF_REPLY } from '../lib/terubot/index.js';
import { linkIn, parseUpload, photoFromLink } from '../lib/terubot/photo.js';

/** A message with a photo is the photo (base64, at most 4 MB of picture) plus a few KB of words. The widget shrinks photos to about 300 KB first. */
const json = express.json({ limit: '6mb', strict: true });
/** New photos (attached, or fetched for a link) per hour: each one costs a model call with a picture and a catalogue search. */
const PHOTOS_PER_ACCOUNT_PER_HOUR = 20;
const PHOTOS_PER_ADDRESS_PER_HOUR = 40;
/** The deadline of a whole turn with a photo (the widget gives up at 60 s). */
const PHOTO_TURN_MS = 50 * 1000;
const runMiddleware = (middleware, req, res) => new Promise((resolve, reject) => middleware(req, res, (error) => (error ? reject(error) : resolve())));
const clip = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 160);

/** The first name, if the account has one that looks like a name. */
export function firstNameOf(user) {
  const first = String(user?.name ?? '').trim().split(/\s+/)[0] ?? '';
  return /^[\p{L}\p{M}'.-]{1,30}$/u.test(first) ? first : '';
}

export function mountTerubot(app, ctx) {
  const { api, log } = ctx;
  const overrides = ctx.terubotOverrides ?? {};
  // The Google connection is the studio's: <root>/swatchroom. A project folder without one (a test) simply has the assistant off.
  const googleDir = overrides.googleDir ?? path.join(ctx.root, 'swatchroom');
  const bot = createTerubot({ settings: ctx.settings, site: ctx.site, dist: ctx.dist, log, googleDir, mediaDir: path.join(ctx.root, 'media', 'materials'), overrides });
  const photoLimits = { account: new RateLimiter({ windowMs: 3600000 }), address: new RateLimiter({ windowMs: 3600000 }) };
  let roomStore = null;

  /** The signed-in account of this request, or null. A broken account store means "not signed in", never an error. */
  async function whoIs(req) {
    try {
      const found = await ctx.auth.resolve(req);
      return found?.user ?? null;
    } catch (error) {
      if (error instanceof StoreUnavailableError) return null;
      throw error;
    }
  }

  const studioRooms = (user) => {
    if (overrides.rooms) return () => overrides.rooms(user.ownerId);
    if (!ctx.swatchroom) return undefined;
    return async () => {
      roomStore ??= ctx.swatchroom.roomStore();
      return roomStore.ready() ? (await roomStore.listOwned(user.ownerId)).length : null;
    };
  };

  const off = (res, reason) => res.json({ aiOn: false, reply: OFF_REPLY[reason] ?? OFF_REPLY.unreachable, cards: [], actions: [] });

  api.get('/api/terubot/status', async (req, res, next) => {
    try {
      const state = bot.state();
      const user = await whoIs(req);
      res.json({ aiOn: state.on, model: state.on ? state.model : null, signedIn: Boolean(user), voice: state.on && bot.voice.available() });
    } catch (error) {
      next(error);
    }
  });

  api.post('/api/terubot/chat', async (req, res) => {
    const started = Date.now();
    const t = ctx.settings().terubot;
    let release = null;
    let timer = null;
    const controller = new AbortController();
    let timedOut = false;
    let finished = false;
    const fail = (status, error, extra = {}) => {
      finished = true;
      return res.status(status).json({ error, ...extra });
    };
    try {
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return fail(403, 'Cross-site requests are not allowed.');

      // the body: JSON, small. Its problems are answered here, in this route's own shape.
      try {
        await runMiddleware(json, req, res);
      } catch (error) {
        const tooBig = error?.type === 'entity.too.large';
        return fail(400, tooBig ? 'That request is too large. A photo can be at most 4 MB.' : 'The request body is not valid JSON.');
      }
      // 6 MB is for a message that carries a photo; a message without one is as small as it always was
      if (!req.body?.image && Buffer.byteLength(JSON.stringify(req.body ?? {})) > 64 * 1024) return fail(400, 'That request is too large.');
      let parsed;
      try {
        parsed = { ...parseMessages(req.body, { historyLimit: t.historyLimit }), context: parseContext(req.body?.context, { site: ctx.site, shop: bot.shop }) };
      } catch (error) {
        if (error instanceof BadRequest) return fail(400, error.message);
        throw error;
      }

      const state = bot.state();
      if (!state.on) {
        if (state.reason !== 'setting') log.warn(`terubot  not available: ${clip(state.problem)}`);
        finished = true;
        return off(res, state.reason);
      }

      const user = await whoIs(req);
      const address = req.ip ?? 'unknown';
      const taken = bot.limits.take({ account: user ? (user.ownerId ?? user._id) : null, address });
      if (!taken.ok) {
        log.warn(`terubot  rate limit: ${taken.bucket} is out of messages for this hour`);
        res.set('Retry-After', String(taken.retryAfterSec));
        return fail(429, 'You have sent a lot of messages in the last hour. Please try again in a little while.', { retryAfterSec: taken.retryAfterSec });
      }
      release = bot.limits.enter();
      if (!release) {
        res.set('Retry-After', '3');
        return fail(429, 'The assistant is busy right now. Please try again in a moment.', { retryAfterSec: 3 });
      }

      // One deadline for the whole turn; also stop when the visitor goes away. A turn with a photo is allowed longer: the search container may have to
      // wake up (up to about 20 s) between two model calls. It is re-armed once the photo is known (below), the clock starting again.
      const arm = (ms) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, ms);
      };
      arm(t.timeoutMs);
      res.on('close', () => {
        if (!finished) controller.abort();
      });

      const signedIn = Boolean(user);
      const usable = signedIn || !ctx.auth.required();
      const account = user ? (user.ownerId ?? user._id) : null;

      // A photo: attached by the visitor, kept from an earlier turn (a fetched one by its token), or fetched now for a link in the message.
      // It needs an account like the catalogue does (the photo goes to a model and to a search).
      const text = parsed.messages.at(-1).text;
      const image = req.body?.image;
      const link = linkIn(text); // a link in the message wins over a photo kept from an earlier turn
      let photo = null;
      let linkNote = '';
      let attachment = null;
      if ((image !== undefined && image !== null) || link?.address) {
        if (!usable) return fail(401, 'Please sign in to send a photo or a link to a picture.');
        const asker = { account, address };
        const spend = () => {
          const keys = [[photoLimits.account, `u:${account}`, PHOTOS_PER_ACCOUNT_PER_HOUR], [photoLimits.address, `ip:${address}`, PHOTOS_PER_ADDRESS_PER_HOUR]].filter(([, key]) => !key.endsWith(':null'));
          for (const [limiter, key, limit] of keys) {
            const room = limiter.check(key, limit);
            if (!room.ok) return room.retryAfter;
          }
          for (const [limiter, key] of keys) limiter.record(key);
          return 0;
        };
        if (link?.address) {
          const wait = spend();
          if (wait) return fail(429, 'You have sent a lot of photos in the last hour. Please try again in a little while.', { retryAfterSec: wait });
          const got = await photoFromLink({ address: link.address, who: asker, importer: ctx.inspiration });
          if (got.photo) {
            photo = got.photo;
            attachment = { kind: 'link', token: got.photo.token, host: got.photo.host, title: got.photo.title, width: got.photo.width, height: got.photo.height, more: got.photo.more };
          } else {
            linkNote = got.failed;
          }
        } else if (typeof image?.token === 'string') {
          // a photo fetched for a link earlier in this chat: the importer still holds it for a few minutes
          try {
            const file = await ctx.inspiration.file(image.token, asker);
            photo = { ...parseUpload({ type: file.type, data: file.bytes.toString('base64') }), host: 'a link pasted earlier in this chat' };
          } catch (error) {
            if (error?.status) linkNote = 'The picture from the earlier link is no longer available; ask them to paste the link again or attach the picture.';
            else if (error instanceof BadRequest) linkNote = error.message;
            else throw error;
          }
        } else if (image !== undefined && image !== null) {
          try {
            photo = parseUpload(image);
          } catch (error) {
            if (error instanceof BadRequest) return fail(400, error.message);
            throw error;
          }
          const wait = spend();
          if (wait) return fail(429, 'You have sent a lot of photos in the last hour. Please try again in a little while.', { retryAfterSec: wait });
        }
      } else if (link?.refused) {
        linkNote = link.refused;
      }
      const catalogue = await catalogueBridge({ catalogue: ctx.catalogue, asker: { account, address }, allowed: usable, log, shop: bot.shop });
      if (photo) {
        arm(Math.max(t.timeoutMs, PHOTO_TURN_MS));
        if (catalogue.on) ctx.catalogue.service.warm().catch(() => {}); // wake the search container while the model is looking at the photo
      }
      const accountInfo = { signedIn, firstName: firstNameOf(user), studioRooms: user ? studioRooms(user) : undefined };

      const out = await bot.answer({ messages: parsed.messages, context: parsed.context, account: accountInfo, catalogue, photo, linkNote, signal: controller.signal, timedOut: () => timedOut });
      log.info(`terubot  chat ok  ${signedIn ? 'signed-in' : 'visitor'}  in=${parsed.messages.at(-1).text.length} chars  out=${out.reply.length} chars  model=${out.model}  rounds=${out.rounds}  tools=${out.toolsUsed.join(',') || '-'}  cards=${out.cards.length} actions=${out.actions.length}  tokens=${out.usage.prompt}/${out.usage.output}+${out.usage.thoughts}  ${Date.now() - started} ms`);
      finished = true;
      // In a live conversation the reply is staged for Google's voice: the pieces to say, never any text of the visitor's
      const speech = req.body?.speak === true ? bot.voice.stage({ text: out.reply, hasCards: out.cards.length > 0, hint: parsed.messages.at(-1).text }) : null;
      return res.json({ aiOn: true, reply: out.reply, cards: out.cards, actions: out.actions, model: out.model, ...(attachment ? { attachment } : {}), ...(speech ? { speech } : {}) });
    } catch (error) {
      if (error instanceof GeminiError) {
        if (error.kind === 'aborted') {
          finished = true;
          return; // the visitor left: nobody to answer
        }
        log.warn(`terubot  chat failed  kind=${error.kind}${error.status ? ` status=${error.status}` : ''}  ${clip(error.message)}  ${Date.now() - started} ms`);
        if (error.kind === 'unavailable') {
          finished = true;
          return off(res, 'unreachable');
        }
        if (error.kind === 'timeout') return fail(502, 'The assistant took too long to answer. Please try again.');
        return fail(502, 'The assistant could not answer just now. Please try again in a moment.');
      }
      log.error(`terubot  chat crashed  ${clip(error?.stack ?? error)}`);
      if (res.headersSent) return res.destroy();
      return fail(500, 'Something went wrong on our side. Please try again.');
    } finally {
      clearTimeout(timer);
      release?.();
    }
  });

  api.get('/api/terubot/speech', async (req, res) => {
    const started = Date.now();
    const fail = (status, error) => res.status(status).json({ error });
    try {
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return fail(403, 'Cross-site requests are not allowed.');
      const id = typeof req.query.id === 'string' ? req.query.id : '';
      const n = typeof req.query.n === 'string' && /^\d{1,2}$/.test(req.query.n) ? Number(req.query.n) : -1;
      if (!/^[A-Za-z0-9_-]{4,40}$/.test(id) || n < 0) return fail(404, 'There is no such speech.');
      if (!ctx.settings().terubot.enabled) return fail(503, 'The voice is off.');
      const out = await bot.voice.audio(id, n);
      log.info(`terubot  speech ok  lang=${out.lang}  ${out.chars} chars  ${Math.round(out.bytes.length / 1024)} KB  ${out.cached ? 'from memory' : 'from Google'}  ${Date.now() - started} ms`);
      res.set({ 'Content-Type': out.type, 'Content-Length': String(out.bytes.length) });
      return res.end(out.bytes);
    } catch (error) {
      if (error instanceof VoiceError) {
        if (error.kind !== 'gone') log.warn(`terubot  speech failed  kind=${error.kind}${error.status ? ` status=${error.status}` : ''}  ${clip(error.message)}  ${Date.now() - started} ms`);
        if (error.kind === 'gone') return fail(404, 'That speech is not available any more.');
        if (error.kind === 'busy') { res.set('Retry-After', '3'); return fail(429, 'The voice is busy right now.'); }
        if (error.kind === 'unavailable') return fail(503, 'The voice is off right now.');
        return fail(502, 'The voice could not be made just now.');
      }
      log.error(`terubot  speech crashed  ${clip(error?.stack ?? error)}`);
      if (res.headersSent) return res.destroy();
      return fail(500, 'Something went wrong on our side.');
    }
  });

  return { close: () => { bot.close(); photoLimits.account.close(); photoLimits.address.close(); }, bot };
}
