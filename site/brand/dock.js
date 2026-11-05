/* Terucon mobile dock: a bottom tab bar with the five destinations, for phones (CSS shows it at widths up to 899 px).
   Plain ES5, no inline code, no external hosts, no dependencies: it works on the website's strict-CSP pages and on the
   exported pages alike. It builds the bar itself; /brand/dock.css styles it. How to include it: /brand/dock.md.
   Opt a page out with <html data-tc-dock="off"> or <meta name="tc-dock" content="off">. */
(function () {
  'use strict';
  if (window.TeruconDock) return;

  // The destinations are not listed here: there is ONE list, in /brand/chrome.js (window.TeruconChrome.destinations); the tabs are the
  // entries with dock: true. Without chrome.js on the page there is no dock.
  var chrome = window.TeruconChrome;
  if (!chrome || !chrome.destinations) return;
  var ITEMS = chrome.destinations.filter(function (d) { return d.dock; });

  var root = document.documentElement;
  var dock = null;
  var hiddenBy = { keyboard: false, api: false };
  var blurTimer = 0;

  function optedOut() {
    if (root.getAttribute('data-tc-dock') === 'off') return true;
    var m = document.querySelector('meta[name="tc-dock"]');
    return !!(m && m.getAttribute('content') === 'off');
  }

  function currentKey() {
    var p = (location.pathname || '/').toLowerCase().replace(/\/+$/, '') || '/';
    for (var i = 0; i < ITEMS.length; i += 1) {
      for (var j = 0; j < ITEMS[i].paths.length; j += 1) {
        var base = ITEMS[i].paths[j];
        if (p === base || p.indexOf(base + '/') === 0) return ITEMS[i].key;
      }
    }
    return '';
  }

  function build() {
    var cur = currentKey();
    var nav = document.createElement('nav');
    nav.className = 'tc-dock';
    nav.setAttribute('aria-label', 'Main');
    nav.setAttribute('data-tc-dock', '');
    var list = document.createElement('div');
    list.className = 'tc-dock__list';
    for (var i = 0; i < ITEMS.length; i += 1) {
      var it = ITEMS[i];
      var a = document.createElement('a');
      a.className = 'tc-dock__item';
      a.href = it.href;
      a.setAttribute('data-tc-dock-key', it.key);
      if (it.key === cur) a.setAttribute('aria-current', 'page');
      a.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + it.icon + '</svg><span class="tc-dock__label"></span>';
      var lab = a.lastChild;
      if (it.pre) {
        // "Design " is dropped on very narrow screens by CSS; the link keeps its full name for screen readers
        a.setAttribute('aria-label', it.label);
        var pre = document.createElement('span');
        pre.className = 'tc-dock__pre';
        pre.textContent = it.pre;
        lab.appendChild(pre);
        lab.appendChild(document.createTextNode(it.label.slice(it.pre.length)));
      } else {
        lab.textContent = it.label;
      }
      list.appendChild(a);
    }
    nav.appendChild(list);
    return nav;
  }

  function isTextField(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      return ['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'file', 'color', 'image', 'hidden'].indexOf(t) === -1;
    }
    return !!el.isContentEditable;
  }

  function sync() {
    if (!dock) return;
    var hide = hiddenBy.keyboard || hiddenBy.api;
    dock.classList.toggle('is-hidden', hide);
    if (hide) dock.setAttribute('aria-hidden', 'true');
    else dock.removeAttribute('aria-hidden');
  }

  // A text box the PAGE focuses by itself (the sign-in page's auto-focused box) does not raise a keyboard on most phones, so it must not hide
  // the bar: only focus that follows a touch, click or key press does. A keyboard that really opens shrinks the visual viewport (onViewport).
  var interacted = false;
  ['touchstart', 'keydown'].forEach(function (name) {
    document.addEventListener(name, function () { interacted = true; }, { capture: true, passive: true, once: true });
  });
  // a tap on a text box that already has focus raises the keyboard without a new focus event
  document.addEventListener('pointerdown', function (e) {
    interacted = true;
    if (isTextField(e.target)) { hiddenBy.keyboard = true; sync(); }
  }, { capture: true, passive: true });

  function onFocusIn(e) {
    clearTimeout(blurTimer);
    if (interacted && isTextField(e.target)) { hiddenBy.keyboard = true; sync(); }
  }
  function onFocusOut() {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(function () {
      hiddenBy.keyboard = interacted && isTextField(document.activeElement);
      sync();
    }, 120);
  }

  function onViewport() {
    // Android Chrome and others resize the visual viewport for the keyboard; pinch-zoom (scale > 1) is not a keyboard
    var vv = window.visualViewport;
    if (!vv || vv.scale > 1.01) return;
    var shrunk = window.innerHeight - vv.height > 160;
    if (shrunk && isTextField(document.activeElement)) { hiddenBy.keyboard = true; sync(); }
    else if (!shrunk && !isTextField(document.activeElement)) { hiddenBy.keyboard = false; sync(); }
  }

  function mount() {
    if (dock || optedOut()) return;
    dock = build();
    root.appendChild(dock); // a child of <html>, after <body>: a page's own re-render of <body> cannot remove it, and a transformed <body> cannot offset it
    root.classList.add('tc-dock-on');
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onViewport);
    window.addEventListener('pageshow', function () { hiddenBy.keyboard = interacted && isTextField(document.activeElement); sync(); });
    // some pages swap their <html> or re-create children after load: keep the bar (and its class) in place
    if (window.MutationObserver) {
      new MutationObserver(function () {
        if (dock.parentNode !== document.documentElement) document.documentElement.appendChild(dock);
        if (!document.documentElement.classList.contains('tc-dock-on')) document.documentElement.classList.add('tc-dock-on');
      }).observe(document.documentElement, { childList: true, attributes: true, attributeFilter: ['class'] });
    }
    sync();
  }

  window.TeruconDock = {
    /* a page can hide the bar for a while (for example under a full-screen view): hide() and show() */
    hide: function () { hiddenBy.api = true; sync(); },
    show: function () { hiddenBy.api = false; sync(); },
    items: ITEMS.map(function (i) { return { key: i.key, href: i.href, label: i.label }; })
  };

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
