// Starts the Design Studio's cold start early. The studio's GPU services scale to zero and take 10-45 s to wake;
// asking the website to wake them as soon as the landing page (or the studio page itself) opens means they are
// usually up by the time a photo is scanned. The server does the waking (POST /api/studio/warmup, server/routes/studio.js),
// skips services that are already warm or starting, and answers at once; nothing here waits for it or shows anything.
(function () {
  var KEY = 'terucon.warmup';
  var now = Date.now();
  var last = 0;
  try {
    last = Number(sessionStorage.getItem(KEY) || 0);
  } catch (e) {}
  // one request a minute per tab is plenty: the server keeps its own record of what is warm
  if (now - last < 60000) return;
  try {
    sessionStorage.setItem(KEY, String(now));
  } catch (e) {}
  try {
    fetch('/api/studio/warmup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: location.pathname === '/' ? 'landing' : 'studio' }),
      keepalive: true,
    }).catch(function () {});
  } catch (e) {}
})();
