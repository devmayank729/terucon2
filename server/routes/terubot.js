/**
 * TeruBot, the assistant on every page.
 *
 *   GET  /api/terubot/status   {aiOn, model, signedIn}                         never calls Gemini
 *   POST /api/terubot/chat     {messages, context}  ->  {aiOn, reply, cards, actions, model}
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
 * Logging: one line per chat with lengths, model, time, tool names and the status. Never the text of a message or a reply.
 */
import path from 'node:path';
import express from 'express';
import { StoreUnavailableError } from '../auth/index.js';
import { catalogueBridge } from '../lib/terubot/catalogue.js';
import { GeminiError } from '../lib/terubot/gemini.js';
import { BadRequest, parseContext, parseMessages } from '../lib/terubot/input.js';
import { createTerubot, OFF_REPLY } from '../lib/terubot/index.js';

const json = express.json({ limit: '64kb', strict: true });
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
  const bot = createTerubot({ settings: ctx.settings, site: ctx.site, dist: ctx.dist, log, googleDir, overrides });
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
      res.json({ aiOn: state.on, model: state.on ? state.model : null, signedIn: Boolean(user) });
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
        return fail(400, tooBig ? 'That request is too large.' : 'The request body is not valid JSON.');
      }
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

      // One deadline for the whole turn; also stop when the visitor goes away.
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, t.timeoutMs);
      res.on('close', () => {
        if (!finished) controller.abort();
      });

      const signedIn = Boolean(user);
      const usable = signedIn || !ctx.auth.required();
      const catalogue = await catalogueBridge({ catalogue: ctx.catalogue, asker: { account: user ? (user.ownerId ?? user._id) : null, address }, allowed: usable, log });
      const account = { signedIn, firstName: firstNameOf(user), studioRooms: user ? studioRooms(user) : undefined };

      const out = await bot.answer({ messages: parsed.messages, context: parsed.context, account, catalogue, signal: controller.signal, timedOut: () => timedOut });
      log.info(`terubot  chat ok  ${signedIn ? 'signed-in' : 'visitor'}  in=${parsed.messages.at(-1).text.length} chars  out=${out.reply.length} chars  model=${out.model}  rounds=${out.rounds}  tools=${out.toolsUsed.join(',') || '-'}  cards=${out.cards.length} actions=${out.actions.length}  tokens=${out.usage.prompt}/${out.usage.output}+${out.usage.thoughts}  ${Date.now() - started} ms`);
      finished = true;
      return res.json({ aiOn: true, reply: out.reply, cards: out.cards, actions: out.actions, model: out.model });
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

  return { close: () => bot.close(), bot };
}
