// Server-side PostHog events, mirroring what server/lib/eventLog.js writes to Mongo for the
// admin dashboard. Disabled with no code changes when POSTHOG_KEY is unset (config.posthog.key
// is read once at start-up, same pattern as the rest of config.js).
const config = require("../config");

let client = null;
if (config.posthog.key) {
  const { PostHog } = require("posthog-node");
  client = new PostHog(config.posthog.key, {
    host: config.posthog.host,
    flushAt: 1,
    flushInterval: 0,
  });
}

function capture(distinctId, event, properties) {
  if (!client) {
    return;
  }
  try {
    client.capture({
      distinctId: distinctId || "anonymous",
      event: event,
      properties: properties || {},
    });
  } catch (error) {
    // analytics must never break the request it describes
  }
}

module.exports = { capture: capture, enabled: !!client };
