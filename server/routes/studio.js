/**
 * What the website adds to the Design Studio (swatchroom/): the early wake-up of its GPU services.
 *
 * The studio's services scale to zero, so the first scan after a quiet spell pays a cold start of 10-45 s. The landing page
 * and the studio page call POST /api/studio/warmup as soon as they open (site/patches/snippets/warmup.js), so the services
 * are usually up before a photo is scanned. The swatchroom does the work (server/lib/swatchroom.js) and skips services that
 * are warm or already starting, so repeated calls cost nothing. It answers at once, with how many services it started.
 *
 * This route is the website's own, not the studio's: the studio's /api/* routes sit behind its passcode, and a visitor who
 * has not signed in yet is exactly who should get the wake-up. STUDIO_WARMUP=off switches it off (a wake-up bills a GPU
 * for a visitor who may never upload a photo).
 */
import express from 'express';

const PAGES = new Set(['landing', 'studio']);

export function mountStudioRoutes(app, ctx) {
  const { api, log } = ctx;

  api.post('/api/studio/warmup', express.json({ limit: '1kb' }), (req, res) => {
    if (!ctx.swatchroom) return res.json({ warming: 0, reason: 'studio-not-running' });
    if (!ctx.settings().studio.warmup) return res.json({ warming: 0, reason: 'switched-off' });
    const page = PAGES.has(req.body?.from) ? req.body.from : 'other';
    const started = ctx.swatchroom.warm();
    if (started.length) log.info(`studio  warm-up from the ${page} page: starting ${started.join(', ')}`);
    return res.json({ warming: started.length });
  });
}
