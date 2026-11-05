/* The Design Studio's entry: tells the page loader (site/brand/loader.html, data-tc-mode="studio") when it may leave.
 *
 * tools/build-dist.js puts this inline right after the loader on the studio page only. It replaces the generic "the page runtime made
 * its first commit" signal, which is only the shell: the studio is ready when the studio's own first interactive screen exists
 * (swatchroom/public/js/swatchroom-app.js: .sr-studio, or .sr-gate when the studio asks for its passcode) and its style sheet
 * (#swr-skin) has loaded. The studio's own splash is hidden by the studio page's patch so the visitor sees one loader, not two.
 *
 * While the studio's GPU services are cold the loader stays up, for at most CAP_MS from the start (the click on a link to the
 * studio when site/brand/transition.js stored it, otherwise the page load). The answer comes from GET /api/vision/warmup, the
 * studio's own route (swatchroom/server/routes/vision.js + lib/warmth.js): it is answered from the server's record and never wakes
 * a GPU. Anything but a clear "cold" never holds the visitor: 401 (the studio's passcode), 503, other statuses, a network error, an
 * answer that is not the expected JSON, "configured": false, and a pool that nothing is waking all count as "cannot know, do not wait".
 * The loader itself still enforces its minimum of two cycles and leaves at a composed moment (loader.html).
 *
 * Failure: when the studio's server did not answer (the studio's own "did not answer" message) the loader shows its Retry screen; when
 * the studio does not appear at all, the loader's own FAIL_MS timer does.
 */
(function () {
  var w = window;
  var d = document;
  var loader = w.TeruconLoader;
  if (!loader) return;

  var CAP_MS = 10000; // the longest the loader waits for the GPU pool, counted from the start
  var NOTE_LEAD_MS = 1500; // the quiet status line is up this long before the cap
  var NOTE_MIN_MS = 1200; // ...and at least this long when the studio was ready late
  var POLL_MS = 800;
  var IDLE_NOTHING_MS = 1500; // a pool that nothing is waking is believed after this long on the studio page
  var WARM_MARGIN_MS = 20000; // the server's own margin (MODAL_WARM_MARGIN_S default): it counts a wake-up in flight as warm
  var NOTE_TEXT = 'The studio is still waking its models; you can start now.';
  var FAIL_TEXT = 'The studio did not answer. Please check your connection and try again.';

  var started = loader.startedAt;
  var opened = Date.now();
  var ready = false;
  var pool = 'pending'; // pending | cold | warm | skip
  var finished = false;
  var noted = 0;
  var skinbad = false;
  var nothing = 0;
  var timer = 0;
  var observer = null;

  function finish() {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    if (observer) observer.disconnect();
    if (noted) loader.note('');
    try {
      w.TeruconLoader.done();
    } catch (e) {}
  }

  function decide() {
    if (finished || !ready) return;
    if (pool === 'warm' || pool === 'skip') return finish();
    // cold (or no answer yet): keep the loader up until the cap; the status line shows for its last moments
    var now = Date.now();
    var left = started + CAP_MS - now;
    if (left <= NOTE_LEAD_MS && !noted) {
      noted = now;
      loader.note(NOTE_TEXT);
    }
    if (noted && now - noted >= NOTE_MIN_MS && left <= 0) finish();
  }

  // ---- the studio's first interactive screen -------------------------------------------------------------------------------------
  var raf2 = 0;
  function check() {
    if (finished || ready || raf2) return;
    var app = d.querySelector('swatchroom-app');
    if (!app) return;
    if (app.querySelector('.sr-loading .sr-form-error')) {
      finished = true;
      clearInterval(timer);
      if (observer) observer.disconnect();
      loader.fail(FAIL_TEXT);
      return;
    }
    if (!app.querySelector('.sr-studio, .sr-gate')) return;
    var skin = d.getElementById('swr-skin');
    if (skin && !skin.sheet && !skinbad) {
      if (!skin.__tcWatch) {
        skin.__tcWatch = true;
        skin.addEventListener('load', check);
        skin.addEventListener('error', function () {
          skinbad = true;
          check();
        });
      }
      return;
    }
    // two animation frames later the screen has been painted under the loader
    var go = function () {
      ready = true;
      raf2 = 0;
      // the studio is up: what the loader waits for now is the GPU pool, which must never turn into the "taking longer" screen
      loader.hold();
      decide();
    };
    raf2 = 1;
    if (w.requestAnimationFrame)
      w.requestAnimationFrame(function () {
        w.requestAnimationFrame(go);
      });
    else setTimeout(go, 50);
  }

  // ---- is the GPU pool warm? -------------------------------------------------------------------------------------------------------
  function answer(status, body) {
    if (status !== 200 || !body || typeof body !== 'object') return (pool = 'skip');
    if (body.configured === false) return (pool = 'skip');
    var idle = typeof body.idleMs === 'number' ? body.idleMs : null;
    var scaledown = typeof body.scaledownMs === 'number' ? body.scaledownMs : null;
    if (body.warm === true) {
      // the server also says "warm" while a call is in flight, a wake-up included; a pool idle for longer than its own window is
      // only waking, so it is not warm yet
      if (idle !== null && scaledown !== null && idle >= scaledown - WARM_MARGIN_MS) return (pool = 'cold');
      nothing = 0;
      return (pool = 'warm');
    }
    if (body.state === 'waking') {
      nothing = 0;
      return (pool = 'cold');
    }
    if (body.state === 'unknown' || body.state === 'cold') {
      // nothing is waking it (an in-flight wake-up would say "waking"): waiting would not help once the wake-up had time to start
      nothing += 1;
      if (nothing >= 2 && Date.now() - opened >= IDLE_NOTHING_MS) return (pool = 'skip');
      return (pool = 'cold');
    }
    return (pool = 'skip');
  }

  function poll() {
    if (finished || pool === 'warm' || pool === 'skip') return;
    var next = function () {
      decide();
      if (!finished && pool !== 'warm' && pool !== 'skip') setTimeout(poll, POLL_MS);
    };
    try {
      w.fetch('/api/vision/warmup', { cache: 'no-store', credentials: 'same-origin' })
        .then(function (r) {
          if (r.status !== 200) {
            answer(r.status, null);
            return;
          }
          return r.json().then(
            function (j) {
              answer(200, j);
            },
            function () {
              answer(200, null);
            },
          );
        })
        .catch(function () {
          pool = 'skip';
        })
        .then(next);
    } catch (e) {
      pool = 'skip';
      next();
    }
  }

  if (w.MutationObserver) {
    observer = new MutationObserver(check);
    observer.observe(d.documentElement, { childList: true, subtree: true });
  } else {
    setInterval(check, 100);
  }
  timer = setInterval(decide, 250);
  check();
  poll();
})();
