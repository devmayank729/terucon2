/* Terucon site chrome: the ONE header (a floating pill) on every page and, on a laptop, a collapsible left sidebar with the
   site's destinations (not on the landing page). Phones keep the bottom dock (/brand/dock.js), which reads its five destinations
   from the list below.
   Plain ES5, synchronous, no framework, no inline code, no external host: it runs on the strict-CSP pages and on the exported
   pages alike. It builds its own markup and appends it to <html> (like dock.js), so a page re-rendering <body> cannot remove it.
   Styled by /brand/chrome.css. What a page can set, and how to include it: /brand/chrome.md.

   A page can say, on its <html> tag (nothing else needs writing):
     data-tc-chrome="off"      no chrome at all
     data-tc-sidebar="off"     header only (sign-in, coming soon, error)
     data-tc-title="Finder"    the title in the header's centre (default: the name of the destination the page is)
     data-tc-account="off"     no account button, and no request for who is signed in (error and offline pages) */
(function () {
  'use strict';
  if (window.TeruconChrome) return;
  var root = document.documentElement;
  if (root.getAttribute('data-tc-chrome') === 'off') return;

  /* ---- the ONE list of destinations ----------------------------------------------------------------------------------------------
     key; label; href (the route); paths (this page, whatever it is called: the old names too); ai (the small "AI" badge);
     side (a row in the sidebar); nav (a link in the landing page's pill); dock (a tab of the phone dock); pre (the part of a
     label the dock drops on very narrow phones). tools/check-links.js and tests/js/site-chrome.test.js read this block: keep it valid JSON. */
  // BEGIN destinations
  var DEST = [
    {"key": "home", "label": "Home", "href": "/", "paths": ["/", "/index.html"], "ai": false, "side": true, "nav": false, "dock": false},
    {"key": "materials", "label": "Materials", "href": "/materials", "paths": ["/materials", "/materials.html", "/market_place_1.html"], "ai": false, "side": true, "nav": true, "dock": true},
    {"key": "studio", "label": "Design Studio", "pre": "Design ", "href": "/design-studio", "paths": ["/design-studio", "/design-studio.html", "/studio", "/swatchroom", "/terucon swatchroom.html"], "ai": true, "side": true, "nav": true, "dock": true},
    {"key": "inspiration", "label": "Inspiration", "href": "/inspiration", "paths": ["/inspiration", "/inspiration.html", "/import"], "ai": false, "side": true, "nav": true, "dock": true},
    {"key": "finder", "label": "Finder", "href": "/finder", "paths": ["/finder", "/finder.html", "/point-to-find"], "ai": false, "side": true, "nav": true, "dock": true},
    {"key": "project", "label": "My project", "href": "/my-project", "paths": ["/my-project", "/my-project.html"], "ai": false, "side": true, "nav": true, "dock": true},
    {"key": "account", "label": "Account", "href": "/account", "paths": ["/account", "/account.html", "/profile"], "ai": false, "side": true, "nav": true, "dock": false}
  ];
  // END destinations
  var CTA = { label: 'Start a project', href: '/start-project' };

  var ICON = {
    home: '<path d="M4 11.2 12 4l8 7.2"/><path d="M6 10v9.5h12V10"/><path d="M10 19.5v-5h4v5"/>',
    materials: '<path d="M12 3.2 20.3 8 12 12.8 3.7 8z"/><path d="m3.7 12 8.3 4.8 8.3-4.8"/><path d="m3.7 16 8.3 4.8 8.3-4.8"/>',
    studio: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M12 12 4.4 7.7M12 12l7.6-4.3M12 12v8.6"/>',
    inspiration: '<path d="M12 3.5c.5 4.3 2.2 6 6.5 6.5-4.3.5-6 2.2-6.5 6.5-.5-4.3-2.2-6-6.5-6.5 4.3-.5 6-2.2 6.5-6.5z"/><path d="M18.5 16.5c.2 1.6.9 2.3 2.5 2.5-1.6.2-2.3.9-2.5 2.5-.2-1.6-.9-2.3-2.5-2.5 1.6-.2 2.3-.9 2.5-2.5z"/>',
    finder: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.4 15.4 5.1 5.1"/><circle cx="10.5" cy="10.5" r="1.6"/>',
    project: '<path d="M9 4h6a1 1 0 0 1 1 1v1.5H8V5a1 1 0 0 1 1-1z"/><path d="M8 5.2H6.5A1.5 1.5 0 0 0 5 6.7v12.8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V6.7a1.5 1.5 0 0 0-1.5-1.5H16"/><path d="M8.5 11.5h7M8.5 15h7"/>',
    account: '<circle cx="12" cy="8.5" r="3.6"/><path d="M4.8 20c.8-3.6 3.8-5.4 7.2-5.4s6.4 1.8 7.2 5.4"/>',
    arrow: '<path d="M7 17 17 7"/><path d="M8.5 7H17v8.5"/>',
    chevron: '<path d="m15 6-6 6 6 6"/>',
    saved: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.4a4.3 4.3 0 0 1 7.5 2.4C19.5 15.4 12 20 12 20z"/>',
    cart: '<path d="M5.25 8.25h13.5l-.85 11.1a1.75 1.75 0 0 1-1.75 1.65H7.85a1.75 1.75 0 0 1-1.75-1.65z"/><path d="M9 10.5V7.25a3 3 0 0 1 6 0v3.25"/>'
  };
  function svg(name, extra) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"' + (extra || '') + '>' + ICON[name] + '</svg>';
  }

  /* ---- which page is this ------------------------------------------------------------------------------------------------------ */
  function currentKey() {
    var p = (location.pathname || '/').toLowerCase().replace(/\/+$/, '') || '/';
    for (var i = 0; i < DEST.length; i += 1) {
      for (var j = 0; j < DEST[i].paths.length; j += 1) {
        var base = DEST[i].paths[j];
        if (p === base || (base !== '/' && p.indexOf(base + '/') === 0)) return DEST[i].key;
      }
    }
    return '';
  }
  function dest(key) {
    for (var i = 0; i < DEST.length; i += 1) if (DEST[i].key === key) return DEST[i];
    return null;
  }
  function attr(name) { return root.getAttribute(name) || ''; }

  var key = currentKey();
  var landing = key === 'home';
  var sideOn = !landing && attr('data-tc-sidebar') !== 'off';
  var accountOn = attr('data-tc-account') !== 'off';
  var over = landing || key === 'materials'; // the page's own picture fills the top of the screen: the pill floats over it
  var title = attr('data-tc-title') || (key && !landing ? dest(key).label : '');

  /* ---- the sidebar's remembered state (localStorage can throw: private windows, blocked site data) ------------------------------- */
  var PREF_KEY = key === 'project' ? 'tc-side-project' : 'tc-side'; // the dashboard has its own rail: its icon rail is the default there
  function readPref() {
    try {
      var v = window.localStorage.getItem(PREF_KEY);
      return v === '1' ? true : v === '0' ? false : null;
    } catch (e) { return null; }
  }
  function writePref(collapsed) {
    try { window.localStorage.setItem(PREF_KEY, collapsed ? '1' : '0'); } catch (e) { /* not remembered: still works */ }
  }
  var pref = sideOn ? readPref() : null;
  var narrow = window.matchMedia ? window.matchMedia('(max-width: 1099px)') : null;
  var collapsed = pref !== null ? pref : (key === 'project' || !!(narrow && narrow.matches));

  /* ---- classes on <html>: set now, before <body> is parsed, so the page's room for the chrome exists at the first paint --------- */
  function classes() {
    var c = root.classList;
    c.add('tc-chrome-on');
    c.toggle('tc-land', landing);
    c.toggle('tc-over', over);
    c.toggle('tc-side-on', sideOn);
    c.toggle('tc-side-rail', sideOn && collapsed);
    if (key) c.add('tc-p-' + key);
  }
  classes();

  /* ---- who is signed in: ONE request for the whole page, shared (the landing page's own script asks the same thing) ------------- */
  var mePromise = null;
  function whenMe() {
    if (!mePromise) {
      mePromise = (accountOn && typeof window.fetch === 'function'
        ? window.fetch('/api/auth/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
          .then(function (r) { return r.ok ? r.json() : null; })
        : Promise.resolve(null)
      ).catch(function () { return null; });
    }
    return mePromise;
  }

  /* ---- markup ----------------------------------------------------------------------------------------------------------------- */
  function h(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html) e.innerHTML = html;
    return e;
  }
  function aiBadge() { return '<span class="tc-ai" aria-hidden="true">AI</span>'; }

  var hdr = null, side = null, toggle = null, card = null, acct = null;
  var shop = { saved: null, cart: null }, menuBtn = null;

  function buildHeader() {
    var el = h('header', 'tc-hdr');
    el.setAttribute('data-tc-chrome', 'header');
    var html = '<a class="tc-hdr__logo" href="' + (landing ? '#top' : '/') + '" aria-label="Terucon India, home">' +
      // the wordmark; on a narrow phone (up to 419 px, chrome.css) the emblem alone, so the logo, the account and the call to action all fit
      '<picture><source media="(max-width: 419px)" srcset="/brand/logo-mark-128.webp 128w, /brand/logo-mark-256.webp 256w" sizes="44px">' +
      '<img src="/brand/logo-header-320.webp" srcset="/brand/logo-header-160.webp 160w, /brand/logo-header-320.webp 320w, /brand/logo-header-480.webp 480w" ' +
      'sizes="164px" width="164" height="28" alt="Terucon India" decoding="async"></picture></a>';
    html += '<div class="tc-hdr__mid">';
    if (landing) {
      html += '<nav class="tc-hdr__nav" aria-label="Main">';
      for (var i = 0; i < DEST.length; i += 1) {
        var d = DEST[i];
        if (!d.nav) continue;
        html += '<a class="tc-hdr__link" href="' + d.href + '" data-tc-key="' + d.key + '"' + (d.key === 'account' ? ' data-terucon-account=""' : '') + '>' + d.label + (d.ai ? aiBadge() : '') + '</a>';
      }
      html += '</nav>';
    } else {
      html += '<p class="tc-hdr__title"></p>';
    }
    html += '</div><div class="tc-hdr__end">';
    if (key === 'materials') {
      html += '<div class="tc-hdr__shop">' +
        '<button type="button" class="tc-ib tc-hdr__saved" aria-label="Saved" data-tc-shop="saved">' + svg('saved') + '<span class="tc-ib__n" data-n="0"></span></button>' +
        '<button type="button" class="tc-ib tc-hdr__cart" aria-label="Cart" data-tc-shop="cart">' + svg('cart') + '<span class="tc-ib__n" data-n="0"></span></button></div>';
    }
    if (!landing && accountOn) {
      html += '<a class="tc-ib tc-hdr__acct" href="/account" aria-label="Account"><span class="tc-av">' + svg('account') + '</span></a>';
    }
    html += '<a class="tc-cta" href="' + CTA.href + '"><span>' + CTA.label + '</span><span class="tc-cta__go" aria-hidden="true">' + svg('arrow') + '</span></a>';
    if (landing) {
      html += '<button type="button" class="tc-ib tc-ib--menu" aria-label="Open menu" aria-haspopup="dialog"><span class="tc-ib__label">Menu</span><span class="tc-burger" aria-hidden="true"></span></button>';
    }
    html += '</div>';
    el.innerHTML = html;
    var t = el.querySelector('.tc-hdr__title');
    if (t) t.textContent = title;
    acct = el.querySelector('.tc-hdr__acct');
    shop.saved = el.querySelector('[data-tc-shop="saved"]');
    shop.cart = el.querySelector('[data-tc-shop="cart"]');
    menuBtn = el.querySelector('.tc-ib--menu');
    return el;
  }

  function buildSide() {
    var el = h('div', 'tc-side'); // a plain box: the <nav> inside it is the landmark
    el.setAttribute('data-tc-chrome', 'sidebar');
    var nav = h('nav', 'tc-side__scroll');
    nav.setAttribute('aria-label', 'Site');
    var rows = '';
    for (var i = 0; i < DEST.length; i += 1) {
      var d = DEST[i];
      if (!d.side) continue;
      rows += '<li><a class="tc-side__row" href="' + d.href + '" data-tc-key="' + d.key + '"' + (d.key === key ? ' aria-current="page"' : '') + '>' +
        svg(d.key) + '<span class="tc-side__text">' + d.label + '</span>' + (d.ai ? aiBadge() : '') + '</a></li>';
    }
    nav.innerHTML = '<p class="tc-side__label">Terucon</p><ul class="tc-side__list">' + rows + '</ul>';
    el.appendChild(nav);
    toggle = h('button', 'tc-side__toggle', svg('chevron'));
    toggle.type = 'button';
    el.appendChild(toggle);
    card = h('a', 'tc-side__card', '<span class="tc-av">' + svg('account') + '</span><span class="tc-side__who"><span class="tc-side__name">Account</span><span class="tc-side__sub"></span></span>');
    card.href = '/account';
    el.appendChild(card);
    return el;
  }

  /* ---- collapse / expand ------------------------------------------------------------------------------------------------------ */
  function paintToggle() {
    if (!toggle) return;
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.setAttribute('aria-label', collapsed ? 'Show the full menu' : 'Make the menu smaller');
    var rows = side.querySelectorAll('.tc-side__row');
    for (var i = 0; i < rows.length; i += 1) {
      // the words are not drawn on the rail, so they come as a tooltip
      if (collapsed) rows[i].setAttribute('title', rows[i].querySelector('.tc-side__text').textContent);
      else rows[i].removeAttribute('title');
    }
  }
  function setCollapsed(next, remember) {
    if (next === collapsed) return;
    collapsed = next;
    if (remember) { pref = next; writePref(next); }
    classes();
    paintToggle();
    // pages that lay themselves out from the window's width (the dashboard, the studio) look again: a size changed without the window changing
    try { window.dispatchEvent(new Event('resize')); } catch (e) { /* very old browsers */ }
  }
  function onNarrowChange() { if (pref === null && key !== 'project') setCollapsed(!!narrow.matches, false); }

  /* ---- the person ------------------------------------------------------------------------------------------------------------- */
  function initials(user) {
    var words = String(user.name || '').replace(/\s+/g, ' ').trim().split(' ');
    var s = words[0] ? words[0].charAt(0) : '';
    if (words.length > 1) s += words[words.length - 1].charAt(0);
    return (s || String(user.email || '?').charAt(0)).toUpperCase();
  }
  function paintMe(me) {
    var signedIn = !!(me && me.authenticated && me.user);
    var signedOut = !!(me && me.authenticated === false);
    var user = signedIn ? me.user : null;
    var name = user ? String(user.name || '').trim() : '';
    if (acct) {
      var av = acct.querySelector('.tc-av');
      if (signedIn) {
        av.textContent = initials(user);
        acct.setAttribute('href', '/account');
        acct.setAttribute('aria-label', name ? 'Account, ' + name : 'Account');
      } else if (signedOut) {
        acct.setAttribute('href', '/login');
        acct.setAttribute('aria-label', 'Sign in');
      }
    }
    if (card) {
      var cav = card.querySelector('.tc-av');
      var nm = card.querySelector('.tc-side__name');
      var sub = card.querySelector('.tc-side__sub');
      if (signedIn) {
        cav.textContent = initials(user);
        nm.textContent = name || String(user.email || user.phone || 'Account');
        sub.textContent = String(user.firm || (name ? user.email || user.phone : '') || '');
        card.setAttribute('href', '/account');
      } else if (signedOut) {
        nm.textContent = 'Sign in';
        sub.textContent = 'Not signed in';
        card.setAttribute('href', '/login');
      }
      // on the icon rail only the avatar is drawn: the link still has a name
      card.setAttribute('aria-label', signedIn ? 'Account, ' + (name || 'signed in') : signedOut ? 'Sign in' : 'Account');
    }
    if (landing && signedOut) {
      var links = hdr.querySelectorAll('a[data-terucon-account]');
      for (var i = 0; i < links.length; i += 1) { links[i].textContent = 'Sign in'; links[i].setAttribute('href', '/login'); }
    }
  }

  /* ---- the shop's Saved and Cart: their numbers are React state inside the exported page, so these two buttons only mirror them and
     forward the click to the originals in the export's own (hidden) header. Nothing the page owns is moved. ---------------------------- */
  var shopWatch = null, shopQueued = false;
  function origHeader() { return document.querySelector('header[data-nav]'); }
  function origLink(href) { var n = origHeader(); return n ? n.querySelector('a[href="' + href + '"]') : null; }
  // the number inside the link (React draws it in a nested span); anything that is not a plain number (the template's own {{ ... }}
  // placeholder, before the page has drawn it) counts as 0
  function countOf(a) {
    if (!a) return '0';
    var spans = a.querySelectorAll('span');
    var t = spans.length ? String(spans[spans.length - 1].textContent || '').trim() : '';
    return /^\d{1,3}$/.test(t) ? t : '0';
  }
  function paintCount(btn, label, n, ariaLabel) {
    if (!btn) return;
    var badge = btn.querySelector('.tc-ib__n');
    if (badge.getAttribute('data-n') !== n) { badge.setAttribute('data-n', n); badge.textContent = n; }
    var text = ariaLabel || (label + (n !== '0' ? ', ' + n : ''));
    if (btn.getAttribute('aria-label') !== text) btn.setAttribute('aria-label', text);
  }
  function syncShop() {
    shopQueued = false;
    var saved = origLink('#/saved') || origLink('/materials#/saved');
    var cart = origLink('#/cart');
    paintCount(shop.saved, 'Saved', countOf(saved));
    paintCount(shop.cart, 'Cart', countOf(cart), cart && cart.getAttribute('aria-label'));
  }
  // The export draws (and may redraw) its header and its counts itself, so ONE observer on the document looks for changes; each burst of
  // changes costs one frame callback that reads two links. Nothing is held between calls: the nodes are looked up again every time.
  function startShop() {
    if (!window.MutationObserver) return;
    shopWatch = new MutationObserver(function () {
      if (shopQueued) return;
      shopQueued = true;
      (window.requestAnimationFrame || window.setTimeout)(syncShop);
    });
    shopWatch.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label'] });
    syncShop();
  }
  function forward(href, hashFallback) {
    var a = origLink(href) || (href === '#/saved' ? origLink('/materials#/saved') : null);
    if (a) a.click();
    else window.location.hash = hashFallback;
  }

  /* ---- the landing page's Menu: its overlay is React state in the export, so the click goes to the export's own button --------------- */
  function forwardMenu() {
    var n = origHeader();
    var b = n && (n.querySelector('[data-menu-btn]') || n.querySelector('button[aria-expanded]'));
    if (b) b.click();
  }

  /* ---- mount ------------------------------------------------------------------------------------------------------------------ */
  function mount() {
    hdr = buildHeader();
    root.appendChild(hdr);
    if (sideOn) {
      side = buildSide();
      root.appendChild(side);
      paintToggle();
      toggle.addEventListener('click', function () { setCollapsed(!collapsed, true); });
      if (narrow) { if (narrow.addEventListener) narrow.addEventListener('change', onNarrowChange); else if (narrow.addListener) narrow.addListener(onNarrowChange); }
    }
    if (menuBtn) menuBtn.addEventListener('click', forwardMenu);
    if (shop.saved) shop.saved.addEventListener('click', function () { forward('#/saved', '#/saved'); });
    if (shop.cart) shop.cart.addEventListener('click', function () { forward('#/cart', '#/cart'); });
    if (shop.saved || shop.cart) startShop();
    whenMe().then(paintMe);
    // some pages swap their <html> children or its class after load: keep the chrome (and its classes) in place
    if (window.MutationObserver) {
      new MutationObserver(function () {
        if (hdr.parentNode !== root) root.appendChild(hdr);
        if (side && side.parentNode !== root) root.appendChild(side);
        if (!root.classList.contains('tc-chrome-on')) classes();
      }).observe(root, { childList: true, attributes: true, attributeFilter: ['class'] });
    }
  }

  window.TeruconChrome = {
    /* the destinations: the phone dock builds its tabs from the ones with dock: true */
    destinations: DEST.map(function (d) {
      return { key: d.key, label: d.label, pre: d.pre || '', href: d.href, paths: d.paths.slice(), ai: d.ai, side: d.side, nav: d.nav, dock: d.dock, icon: ICON[d.key] };
    }),
    current: key,
    cta: CTA,
    whenMe: whenMe,
    /* collapse or expand the sidebar from a page's own code (remembered like the button) */
    setSidebarCollapsed: function (c) { if (sideOn) setCollapsed(!!c, true); },
    sidebarCollapsed: function () { return sideOn && collapsed; }
  };

  mount();
})();
