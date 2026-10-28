/**
 * GET /api/analytics: where the browser should send its PostHog events, or `{enabled: false}`.
 *
 * Every page (site/patches/snippets/analytics.js) asks this once. The key is a PostHog project key (phc_...), which PostHog
 * designed to be public (it can only write events), so serving it is normal; it is not baked into the built pages, so the
 * pages and their digests stay the same across projects. The key is the website's POSTHOG_KEY, else the studio's own
 * (swatchroom/.env), so the pages and the studio land in one PostHog project.
 *
 * No answer is "enabled" when there is no key, when the key or host is malformed, or when the site is opened on this computer
 * only (localhost): a developer's own test clicks would otherwise fill the real project. POSTHOG_ON_LOCALHOST=on lifts that.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const KEY = /^phc_[A-Za-z0-9]{20,}$/;
const HOST = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/;

/** @returns {{enabled: false} | {enabled: true, key: string, host: string, replay: boolean}} */
export function analyticsFor(ctx, hostname) {
  const own = ctx.settings().analytics;
  const studio = ctx.swatchroom?.analytics() ?? { key: '', host: '' };
  const key = own.key || studio.key;
  const host = own.key ? own.host : studio.host || own.host;
  if (!KEY.test(key) || !HOST.test(host)) return { enabled: false };
  if (LOCAL_HOSTS.has(hostname) && !own.onLocalhost) return { enabled: false };
  return { enabled: true, key, host, replay: own.replay };
}

export function mountAnalytics(app, ctx) {
  ctx.api.get('/api/analytics', (req, res) => res.json(analyticsFor(ctx, req.hostname)));
}
