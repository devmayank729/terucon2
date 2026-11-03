/* Terucon: one loader across the click on "Design Studio" and the studio's own start-up.
 *
 * A click on any same-origin link to the Design Studio (header, dock, menu, buttons, plain links) closes the loader's curtain over
 * the current page at once, starts the studio's wake-up, remembers the click time (sessionStorage "tc-go") and then navigates.
 * The studio page's loader (site/brand/loader.html, data-tc-mode="studio") reads that time and continues the same animation
 * instead of restarting it, and its two-cycle minimum counts from the click. Everything is plain DOM and CSSOM: no inline style,
 * no inline handler, so it works under the strict Content-Security-Policy of the hand-written pages.
 *
 * Include on every page, once:   <script src="/brand/transition.js" defer></script>
 * (the built pages get it from site/brand/head.html). A page that has no loader of its own gets the loader's style sheet
 * (/brand/loader.css) from this script. Left alone: Ctrl/Cmd/Shift/Alt clicks, middle and right buttons, target other than
 * _self, download links, clicks on a link to the studio from inside the studio. If navigation has not started within SAFETY_MS
 * for any reason, it starts then.
 *
 * The MARKUP constant is generated from loader.html by `node site/brand/build-loader.mjs`; do not edit it by hand.
 */
(function () {
  'use strict';
  var w = window;
  var d = document;
  if (w.TeruconTransition) return;

  // the Design Studio's address and its aliases (site/site.json, page "studio"), lower case; tests/js/brand-loader.test.js compares them
  var STUDIO = ['/design-studio', '/design-studio.html', '/studio', '/swatchroom', '/terucon swatchroom.html'];
  var CLOSE_MS = 650; // the curtain closing; the stage appears when it has (loader.html uses the same number for the studio page)
  var NAV_AFTER_MS = 560; // navigate once the curtain is all but closed
  var REDUCED_NAV_MS = 140; // with reduced motion there is no curtain: a short beat so the loader is seen, then navigate
  var SAFETY_MS = 1500; // navigate no later than this after the click, whatever else happened
  var RESTORE_MS = 20000; // the navigation never committed: give the page back
  var GO_KEY = 'tc-go';
  var WARM_KEY = 'terucon.warmup'; // the same key and one-a-minute rule as the page snippet (site/patches/snippets/warmup.js)

  /*loader-markup:start*/
  var MARKUP = "<div id=\"tc-loader\" role=\"status\" aria-live=\"polite\" aria-busy=\"true\"><span class=\"tc-ld-sr\">Loading Terucon</span><div class=\"tc-ld-stage\"><div class=\"tc-ld-fig\" aria-hidden=\"true\"><svg class=\"tc-ld-art\" viewBox=\"0 0 862 552\" focusable=\"false\"><path class=\"v\" d=\"M12 136L355 12V537L282 498V165L12 250Z\"/><path class=\"v\" d=\"M450 243L585 272V468L450 478Z\"/><path class=\"p\" d=\"M-70 557H932M12 597H850M12 585V609M850 585V609M6 603L18 591M844 603L856 591\"/><path class=\"d d1\" d=\"M12 136L355 12V537L282 498V165L12 250Z\"/><path class=\"d d2\" d=\"M12 250L108 280L205 233V205L282 165M205 205V465L282 498\"/><path class=\"d d3\" d=\"M402 196Q402 174 426 170L650 98L852 158L836 172L450 243\"/><path class=\"d d4\" d=\"M402 196V522Q402 528 412 528L640 522L826 479L448 480\"/><path class=\"d d5\" d=\"M450 243L585 272V468L450 478V243M498 257V474M545 266V471M450 322L585 318\"/><path class=\"d d6\" d=\"M598 268V468M612 264V468M627 259V468M641 255V468M656 250V468M670 246V468M684 241V468M699 237V468M713 232V468M728 228V468M742 223V468M756 219V468\"/></svg><svg class=\"tc-ld-led-art\" viewBox=\"0 0 862 552\" focusable=\"false\"><path class=\"a g\" d=\"M205 205V465\"/><path class=\"a g\" d=\"M367 215V520\"/><path class=\"a g\" d=\"M402 196V524\"/><path class=\"a g\" d=\"M355 12L640 98\"/><path class=\"a g\" d=\"M424 171L650 98\"/><path class=\"a g\" d=\"M545 252L695 210\"/><path class=\"a g\" d=\"M572 268L757 218\"/><path class=\"a\" d=\"M205 205V465\"/><path class=\"a\" d=\"M367 215V520\"/><path class=\"a\" d=\"M402 196V524\"/><path class=\"a\" d=\"M355 12L640 98\"/><path class=\"a\" d=\"M424 171L650 98\"/><path class=\"a\" d=\"M545 252L695 210\"/><path class=\"a\" d=\"M572 268L757 218\"/></svg><img class=\"tc-ld-mark\" src=\"/brand/logo-mark-256.webp\" srcset=\"/brand/logo-mark-256.webp 256w,/brand/logo-mark-512.webp 512w\" sizes=\"(min-width:700px) 320px,70vw\" width=\"862\" height=\"552\" alt=\"\" decoding=\"async\" fetchpriority=\"high\"><div class=\"tc-ld-hide\"></div><div class=\"tc-ld-scan\"></div></div><p class=\"tc-ld-name\" aria-hidden=\"true\">Terucon</p><p class=\"tc-ld-tag\" aria-hidden=\"true\">Interiors for businesses</p><div class=\"tc-ld-led\" aria-hidden=\"true\"><i></i></div><p class=\"tc-ld-status\"></p><div class=\"tc-ld-fail\"><p class=\"tc-ld-ft\">This page is taking longer than usual</p><p class=\"tc-ld-fm\">Please check your connection and try again.</p><div class=\"tc-ld-fa\"><button type=\"button\" class=\"tc-ld-retry\">Retry</button><a class=\"tc-ld-home\" href=\"/\">Go to the home page</a></div></div><div class=\"tc-ld-glow\" aria-hidden=\"true\"></div></div><div class=\"tc-ld-curtain\" aria-hidden=\"true\"></div></div>";
  /*loader-markup:end*/

  var going = false;
  var navigated = false;
  var overlay = null;
  var timers = []; // everything still waiting: a page restored from the back/forward cache must not run these (it would navigate again)
  function later(fn, ms) {
    timers.push(w.setTimeout(fn, ms));
  }
  var cssReady = !!w.TeruconLoader; // a built page carries the loader's style inline

  function isStudio(pathname) {
    var p = '';
    try {
      p = decodeURIComponent(pathname).toLowerCase();
    } catch (e) {
      p = String(pathname).toLowerCase();
    }
    if (p.length > 1 && p.charAt(p.length - 1) === '/') p = p.slice(0, -1);
    return STUDIO.indexOf(p) !== -1;
  }

  // the link a click went to, when this script should take it over; null otherwise
  function studioLink(e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
    var el = e.target;
    var a = el && el.closest ? el.closest('a[href]') : null;
    if (!a) return null;
    var target = a.getAttribute('target');
    if (target && target !== '_self') return null;
    if (a.hasAttribute('download')) return null;
    var u;
    try {
      u = new URL(a.href, w.location.href);
    } catch (x) {
      return null;
    }
    if (u.origin !== w.location.origin || !isStudio(u.pathname)) return null;
    if (isStudio(w.location.pathname)) return null; // already in the studio: the link does what it always did
    return u;
  }

  // same request, same one-a-minute limit per tab as the page snippet, so the studio page's own call is skipped
  function warm() {
    var n = Date.now();
    var last = 0;
    try {
      last = Number(w.sessionStorage.getItem(WARM_KEY) || 0);
    } catch (e) {}
    if (n - last < 60000) return;
    try {
      w.sessionStorage.setItem(WARM_KEY, String(n));
    } catch (e) {}
    try {
      w.fetch('/api/studio/warmup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: w.location.pathname === '/' ? 'landing' : 'studio' }),
        keepalive: true,
      }).catch(function () {});
    } catch (e) {}
  }

  // puts the loader over the page; returns how long to leave it up before navigating (0: nothing was shown, navigate at once)
  function cover() {
    if (!cssReady || !MARKUP || d.getElementById('tc-loader') || !d.body) return 0;
    var reduce = w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var holder = d.createElement('div');
    holder.innerHTML = MARKUP;
    var el = holder.firstElementChild;
    if (!el) return 0;
    var host = el.querySelector('.tc-ld-curtain');
    var n = w.innerWidth < 600 ? 5 : 9;
    var mid = (n - 1) / 2;
    var i;
    var s;
    host.style.setProperty('--m', String(mid));
    for (i = 0; i < n; i++) {
      s = d.createElement('i');
      s.style.setProperty('--k', String(Math.abs(i - mid)));
      host.appendChild(s);
    }
    host.appendChild(d.createElement('b'));
    el.setAttribute('data-tc-from', 'click');
    el.classList.add('tc-ld-in', 'tc-ld-on');
    if (reduce) el.classList.add('tc-ld-held');
    d.documentElement.classList.add('tc-ld-lock');
    d.body.appendChild(el);
    overlay = el;
    if (!reduce) {
      later(function () {
        if (overlay === el) el.classList.add('tc-ld-held');
      }, CLOSE_MS);
    }
    try {
      new Image().src = '/brand/logo-mark-256.webp'; // the studio page's loader finds it in the cache
    } catch (e) {}
    return reduce ? REDUCED_NAV_MS : NAV_AFTER_MS;
  }

  function restore() {
    while (timers.length) w.clearTimeout(timers.pop());
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    d.documentElement.classList.remove('tc-ld-lock');
    going = false;
    navigated = false;
  }

  function leaveFor(url) {
    if (going) return;
    going = true;
    try {
      w.sessionStorage.setItem(GO_KEY, JSON.stringify({ t: Date.now(), to: url }));
    } catch (e) {}
    warm();
    var wait = cover();
    var nav = function () {
      if (navigated) return;
      navigated = true;
      w.location.assign(url);
    };
    if (wait) later(nav, wait);
    else nav();
    later(nav, SAFETY_MS);
    later(function () {
      if (going && overlay) restore();
    }, RESTORE_MS);
  }

  d.addEventListener(
    'click',
    function (e) {
      var u = studioLink(e);
      if (!u) return;
      e.preventDefault();
      leaveFor(u.href);
    },
    true,
  );

  // coming back with the browser's Back button can show this page from the cache, with the overlay still on it
  w.addEventListener('pageshow', function (e) {
    if (e.persisted) restore();
  });

  if (!cssReady) {
    var link = d.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/brand/loader.css';
    link.addEventListener('load', function () {
      cssReady = true;
    });
    (d.head || d.documentElement).appendChild(link);
  }

  w.TeruconTransition = { studioPaths: STUDIO.slice(), isStudio: isStudio };
})();
