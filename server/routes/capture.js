/**
 * Capture from a phone: mounts the routes (server/capture/routes.js) and keeps the pieces on `ctx.capture` so that deleting an account can
 * delete its photos too. `ctx.captureOverrides` (createApp's `capture` option) is for tests: a capture database, a clock, a fake fetch for WhatsApp.
 */
import { createCapture } from '../capture/index.js';
import { mountCaptureRoutes } from '../capture/routes.js';

export function mountCapture(app, ctx) {
  const { db, now, fetch } = ctx.captureOverrides ?? {};
  const capture = createCapture({ settings: ctx.settings, mongoose: ctx.swatchroom?.mongoose() ?? null, log: ctx.log, now, overrides: { db, fetch } });
  ctx.capture = capture;
  mountCaptureRoutes(app, ctx, capture);
  return capture;
}
