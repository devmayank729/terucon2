/* Terucon mobile dock: a bottom tab bar with the five destinations, for phones (CSS shows it at widths up to 899 px).
   Plain ES5, no inline code, no external hosts, no dependencies: it works on the website's strict-CSP pages and on the
   exported pages alike. It builds the bar itself; /brand/dock.css styles it. How to include it: /brand/dock.md.
   Opt a page out with <html data-tc-dock="off"> or <meta name="tc-dock" content="off">. */
(function () {
  'use strict';
  if (window.TeruconDock) return;

  var ITEMS = [
    { key: 'materials', href: '/materials', label: 'Materials', paths: ['/materials', '/materials.html', '/market_place_1.html'],
      icon: '<path d="M12 3.2 20.3 8 12 12.8 3.7 8z"/><path d="m3.7 12 8.3 4.8 8.3-4.8"/><path d="m3.7 16 8.3 4.8 8.3-4.8"/>' },
    { key: 'studio', href: '/design-studio', label: 'Design Studio', pre: 'Design ', paths: ['/design-studio', '/design-studio.html', '/studio', '/swatchroom'],
      icon: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M12 12 4.4 7.7M12 12l7.6-4.3M12 12v8.6"/>' },
    { key: 'inspiration', href: '/inspiration', label: 'Inspiration', paths: ['/inspiration', '/inspiration.html', '/import'],
      icon: '<path d="M12 3.5c.5 4.3 2.2 6 6.5 6.5-4.3.5-6 2.2-6.5 6.5-.5-4.3-2.2-6-6.5-6.5 4.3-.5 6-2.2 6.5-6.5z"/><path d="M18.5 16.5c.2 1.6.9 2.3 2.5 2.5-1.6.2-2.3.9-2.5 2.5-.2-1.6-.9-2.3-2.5-2.5 1.6-.2 2.3-.9 2.5-2.5z"/>' },
    { key: 'finder', href: '/finder', label: 'Finder', paths: ['/finder', '/finder.html', '/point-to-find'],
      icon: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.4 15.4 5.1 5.1"/><circle cx="10.5" cy="10.5" r="1.6"/>' },
    { key: 'project', href: '/my-project', label: 'My project', paths: ['/my-project', '/my-project.html'],
      icon: '<path d="M9 4h6a1 1 0 0 1 1 1v1.5H8V5a1 1 0 0 1 1-1z"/><path d="M8 5.2H6.5A1.5 1.5 0 0 0 5 6.7v12.8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V6.7a1.5 1.5 0 0 0-1.5-1.5H16"/><path d="M8.5 11.5h7M8.5 15h7"/>' }
  ];

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
