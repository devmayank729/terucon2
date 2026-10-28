// PostHog in the browser. Loaded from `posthog` in GET /api/session's response (see
// server/routes/session.js) - the project key is meant to be public (a write-only ingestion
// key, by PostHog's own design), so no extra round trip is needed to fetch it. Does nothing at
// all when the server has no POSTHOG_KEY configured.
let initPromise = null;

function loadScript(src) {
  return new Promise(function (resolve, reject) {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = function () {
      resolve();
    };
    script.onerror = function () {
      reject(new Error("Could not load " + src));
    };
    document.head.appendChild(script);
  });
}

// init({ key, host }), called once per page. `host` is the API host PostHog assigned the
// project (e.g. https://us.i.posthog.com); PostHog serves the library itself from the matching
// "-assets" subdomain, which is what the official snippet derives this same way.
export function initAnalytics(posthogConfig) {
  if (initPromise) {
    return initPromise;
  }
  if (!posthogConfig || !posthogConfig.key) {
    initPromise = Promise.resolve();
    return initPromise;
  }
  const host = posthogConfig.host || "https://us.i.posthog.com";
  const assetsUrl = host.replace(".i.posthog.com", "-assets.i.posthog.com") + "/static/array.js";
  initPromise = loadScript(assetsUrl)
    .then(function () {
      if (window.posthog && window.posthog.init) {
        window.posthog.init(posthogConfig.key, {
          api_host: host,
          person_profiles: "identified_only",
          capture_pageview: true,
        });
      }
    })
    .catch(function (error) {
      console.warn("Analytics did not load:", error.message);
    });
  return initPromise;
}

export function track(event, properties) {
  if (window.posthog && window.posthog.capture) {
    window.posthog.capture(event, properties || {});
  }
}
