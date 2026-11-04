/*
 * Mindful icon hiding (see launcher-dock.css for the why and the contract). On a page that has both TeruBot's launcher
 * ("Ask TeruBot", every page) and capture.js's launcher ("Photos from phone", only the Design Studio, Inspiration and
 * Finder pages), this file waits for both, then holds the two real buttons back behind one small toggle: collapsed,
 * one icon shows; a tap reveals both real buttons, exactly as they always were, one tap away. Neither terubot.js nor
 * capture.js is changed: this only toggles a class (`tcd-hidden`, opacity/pointer-events, never the launcher's own
 * position or size) on the two buttons they already built, and reacts to the `is-open` class each already adds to its
 * own root while its panel is open. On a page with only TeruBot (most of the site) this file finds no second launcher
 * within its own wait and leaves TeruBot exactly as it has always been.
 */
(function () {
  'use strict';
  if (window.TeruconLauncherDock) return;
  var doc = document;
  var css = doc.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/brand/launcher-dock.css';
  doc.head.appendChild(css);
  var FIND_TIMEOUT_MS = 8000;
  var POLL_MS = 150;
  var BADGE_POLL_MS = 1000;

  function waitFor(check, timeoutMs) {
    return new Promise(function (resolve) {
      var deadline = Date.now() + timeoutMs;
      (function tick() {
        var v = check();
        if (v) return resolve(v);
        if (Date.now() > deadline) return resolve(null);
        setTimeout(tick, POLL_MS);
      })();
    });
  }

  var SVG = 'http://www.w3.org/2000/svg';
  function plusIcon() {
    var svg = doc.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var path = doc.createElementNS(SVG, 'path');
    path.setAttribute('d', 'M12 5v14M5 12h14');
    svg.appendChild(path);
    return svg;
  }

  function setup(terubotRoot, tbLaunch, capRoot, capLaunch) {
    var dockOpen = false;

    var toggle = doc.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tcd-toggle';
    toggle.setAttribute('aria-haspopup', 'true');
    toggle.appendChild(plusIcon());
    var dot = doc.createElement('span');
    dot.className = 'tcd-dot';
    dot.hidden = true;
    toggle.appendChild(dot);
    terubotRoot.appendChild(toggle);

    var tbOpen = function () { return terubotRoot.classList.contains('is-open'); };
    var capOpen = function () { return capRoot.classList.contains('is-open'); };
    var immersive = function () { return doc.documentElement.classList.contains('swr-immersive'); };

    function setHidden(el, hidden) {
      el.classList.toggle('tcd-hidden', hidden);
      if (hidden) {
        el.setAttribute('tabindex', '-1');
        el.setAttribute('aria-hidden', 'true');
      } else {
        el.removeAttribute('tabindex');
        el.removeAttribute('aria-hidden');
      }
    }

    function updateBadge(panelOpen) {
      var unread = tbLaunch.classList.contains('is-unread');
      var capBadge = capLaunch.querySelector('.cap-badge');
      var hasPhotos = !!capBadge && !capBadge.hidden;
      dot.hidden = dockOpen || panelOpen || !(unread || hasPhotos);
    }

    function render() {
      if (immersive()) {
        // the studio's full-screen working view already places both launchers as small, out-of-the-way icons near
        // the top (terubot.css / capture.css, html.swr-immersive): leave that alone, exactly as it has always been.
        toggle.classList.add('tcd-hidden');
        setHidden(tbLaunch, false);
        setHidden(capLaunch, false);
        return;
      }
      var panelOpen = tbOpen() || capOpen();
      if (panelOpen) dockOpen = false; // a panel just opened: forget the fan, so closing it returns to one quiet icon
      toggle.classList.toggle('tcd-hidden', panelOpen);
      toggle.setAttribute('aria-expanded', String(dockOpen));
      toggle.setAttribute('aria-label', dockOpen ? 'Close quick actions' : 'More ways to get help: Ask TeruBot, and Photos from phone');
      setHidden(tbLaunch, !dockOpen);
      setHidden(capLaunch, !dockOpen);
      updateBadge(panelOpen);
    }

    toggle.addEventListener('click', function () {
      if (tbOpen() || capOpen()) return; // nothing to toggle to while a panel already covers it
      dockOpen = !dockOpen;
      render();
      if (dockOpen) tbLaunch.focus();
    });
    doc.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' && event.key !== 'Esc') return;
      if (!dockOpen || tbOpen() || capOpen()) return;
      dockOpen = false;
      render();
      toggle.focus();
    });
    doc.addEventListener('click', function (event) {
      if (!dockOpen) return;
      if (terubotRoot.contains(event.target) || capRoot.contains(event.target)) return;
      dockOpen = false;
      render();
    });

    if (window.MutationObserver) {
      new MutationObserver(render).observe(terubotRoot, { attributes: true, attributeFilter: ['class'] });
      new MutationObserver(render).observe(capRoot, { attributes: true, attributeFilter: ['class'] });
      new MutationObserver(render).observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] });
    }
    var badgeTimer = setInterval(function () { if (!doc.hidden) updateBadge(tbOpen() || capOpen()); }, BADGE_POLL_MS);
    doc.addEventListener('visibilitychange', function () { if (!doc.hidden) updateBadge(tbOpen() || capOpen()); });
    doc.addEventListener('pagehide', function () { clearInterval(badgeTimer); }, { once: true });

    render();
    window.TeruconLauncherDock = Object.freeze({ isOpen: function () { return dockOpen; } });
  }

  function start() {
    var terubotRoot = doc.getElementById('terubot');
    var tbLaunch = terubotRoot && terubotRoot.querySelector('.tb-launch');
    if (!terubotRoot || !tbLaunch) return; // TeruBot never mounted (should not happen outside the offline/error pages, which do not load this file either)
    waitFor(function () { return doc.querySelector('.cap-root .cap-launch'); }, FIND_TIMEOUT_MS).then(function (capLaunch) {
      if (!capLaunch) return; // no second launcher on this page within a reasonable wait: leave TeruBot exactly as it is
      var capRoot = capLaunch.closest('.cap-root');
      if (!capRoot || window.TeruconLauncherDock) return;
      setup(terubotRoot, tbLaunch, capRoot, capLaunch);
    });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})();
