/* TeruBot: the one assistant of the site, on every page. A launcher ("Ask TeruBot") at the bottom right and a chat panel that is built the
   first time it opens. Plain ES5, no dependencies, no inline code, no external hosts, nothing built from HTML strings: it works on the
   website's strict-CSP pages and on the exported pages alike. /brand/terubot.css styles it. How to include it and what it does: /brand/terubot.md.

   The server it talks to (server/, not this file): POST /api/terubot/chat and GET /api/terubot/status. Everything that comes back is
   untrusted: text goes in with textContent only, actions are accepted from a fixed list, addresses must be paths on this site.

   Opt a page out with <html data-terubot="off"> or <meta name="terubot" content="off">. */
(function () {
  'use strict';
  if (window.TeruBot) return;
  var root = document.documentElement;
  var optMeta = document.querySelector('meta[name="terubot"]');
  if (root.getAttribute('data-terubot') === 'off' || (optMeta && optMeta.getAttribute('content') === 'off')) return;

  // ---- constants ------------------------------------------------------------------------------------------------------
  var CHAT_URL = '/api/terubot/chat';
  var STATUS_URL = '/api/terubot/status';
  var STORE_KEY = 'terucon.terubot.v1'; // sessionStorage: the conversation of this tab
  var PREFILL_KEY = 'terucon.enquiry.prefill'; // sessionStorage: the project form reads this (documented in terubot.md)
  var PENDING_KEY = 'terucon.terubot.pending'; // sessionStorage: shop changes waiting for the shop page to open
  var SHOP_CART_KEY = 'terucon.store.v1.cart'; // localStorage, written by the shop: [{vid, qty}]
  var SHOP_SAVED_KEY = 'terucon.store.v1.saved'; // localStorage, written by the shop: [{pid, vid}]
  var PENDING_MAX_AGE = 2 * 60 * 60 * 1000;
  var MAX_SENT = 12; // messages sent to the server
  var MAX_TEXT = 2000; // characters per message sent
  var MAX_KEPT = 60; // messages kept in the tab
  var MAX_ACTIONS = 8;
  var REQUEST_TIMEOUT = 60000;
  var ENQUIRY_FIELDS = ['type', 'name', 'company', 'phone', 'email', 'city', 'area', 'timeline', 'message'];
  var SUGGESTIONS = ['Find a material', 'Try the Design Studio with my photo', 'Start a project'];
  var GREETING = 'Hi, I’m TeruBot. I can help you find a material, try the Design Studio with your own photo, or start a project. What would you like to do?';
  var PLACES = { '/': 'the home page', '/materials': 'the shop', '/finder': 'the Finder', '/inspiration': 'Inspiration', '/design-studio': 'the Design Studio', '/my-project': 'My project', '/start-project': 'the project form', '/account': 'your account' };
  var SVGNS = 'http://www.w3.org/2000/svg';

  // ---- small helpers --------------------------------------------------------------------------------------------------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function icon(paths, cls) {
    var s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    if (cls) s.setAttribute('class', cls);
    for (var i = 0; i < paths.length; i += 1) {
      var p = document.createElementNS(SVGNS, paths[i].charAt(0) === 'c' ? 'circle' : 'path');
      if (paths[i].charAt(0) === 'c') {
        var c = paths[i].slice(1).split(',');
        p.setAttribute('cx', c[0]); p.setAttribute('cy', c[1]); p.setAttribute('r', c[2]);
        p.setAttribute('fill', 'currentColor'); p.setAttribute('stroke', 'none');
      } else {
        p.setAttribute('d', paths[i]);
      }
      s.appendChild(p);
    }
    return s;
  }
  var ICON_CHAT = ['M4 5.8A2.8 2.8 0 0 1 6.8 3h10.4A2.8 2.8 0 0 1 20 5.8v7.4a2.8 2.8 0 0 1-2.8 2.8H11l-4.1 3.5c-.6.5-1.4.1-1.4-.7V16h0A2.8 2.8 0 0 1 4 13.2z', 'c9,9.5,1.1', 'c12,9.5,1.1', 'c15,9.5,1.1'];
  var ICON_MIC = ['M12 3.5a2.75 2.75 0 0 1 2.75 2.75v5.5a2.75 2.75 0 0 1-5.5 0v-5.5A2.75 2.75 0 0 1 12 3.5z', 'M6 11a6 6 0 0 0 12 0', 'M12 17v3.5'];
  var ICON_SEND = ['M12 19V5', 'm5.5 11.5 6.5-6.5 6.5 6.5'];
  var ICON_CLOSE = ['M6 6l12 12', 'M18 6 6 18'];

  function str(v, max) {
    if (typeof v !== 'string') return '';
    // control characters out (tabs and newlines stay where the text allows them), length capped
    var s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    return s.length > max ? s.slice(0, max) : s;
  }
  function oneLine(v, max) { return str(v, max * 2).replace(/\s+/g, ' ').trim().slice(0, max); }
  function now() { return Date.now(); }
  function isPhone() { return !!(window.matchMedia && window.matchMedia('(max-width: 719px)').matches); }

  function storeGet(storage, key) {
    try { return storage.getItem(key); } catch (e) { return null; }
  }
  function storeSet(storage, key, value) {
    try { storage.setItem(key, value); return true; } catch (e) { return false; }
  }
  function storeDel(storage, key) {
    try { storage.removeItem(key); } catch (e) { /* storage blocked */ }
  }
  function readJson(storage, key) {
    var raw = storeGet(storage, key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  function sess() { try { return window.sessionStorage; } catch (e) { return null; } }
  function loc() { try { return window.localStorage; } catch (e) { return null; } }

  // ---- what a server answer may contain (all of it untrusted) ----------------------------------------------------------
  /** A path on this site ("/finder", "/materials#/p/x"), or null. No scheme, no host, no "//", no backslash, not an /api address. */
  function safePath(p) {
    if (typeof p !== 'string' || p.length > 400) return null;
    if (p.charAt(0) !== '/' || p.charAt(1) === '/' || p.charAt(1) === '\\') return null;
    if (/[\u0000-\u001f\u007f\\]/.test(p)) return null;
    var u;
    try { u = new URL(p, window.location.origin); } catch (e) { return null; }
    if (u.origin !== window.location.origin) return null;
    if (/^\/api(\/|$)/i.test(u.pathname)) return null;
    return u.pathname + u.search + u.hash;
  }
  function safeImage(p) {
    var path = safePath(p);
    if (!path || path.length > 300 || !/\.(?:jpe?g|png|webp|avif|gif)$/i.test(path.split('#')[0].split('?')[0])) return '';
    return path;
  }
  function safeId(v) {
    return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:\-]{0,119}$/.test(v) ? v : '';
  }
  function cleanCards(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && out.length < 6; i += 1) {
      var c = list[i];
      if (!c || typeof c !== 'object' || c.kind !== 'material') continue;
      var id = safeId(c.id);
      var name = oneLine(c.name, 120);
      var href = safePath(c.href);
      if (!id || !name || !href) continue;
      out.push({ id: id, name: name, variant: oneLine(c.variant, 120), price: oneLine(c.price, 60), image: safeImage(c.image), href: href });
    }
    return out;
  }
  /** The actions we know how to do, each with its fields checked; anything else is dropped. */
  function cleanActions(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && out.length < MAX_ACTIONS; i += 1) {
      var a = list[i];
      if (!a || typeof a !== 'object') continue;
      if (a.type === 'navigate') {
        var to = safePath(a.to);
        if (to) out.push({ type: 'navigate', to: to });
      } else if (a.type === 'open_studio') {
        out.push({ type: 'open_studio' });
      } else if (a.type === 'cart_add') {
        var cid = safeId(a.id);
        var qty = Math.floor(Number(a.qty == null ? 1 : a.qty));
        if (cid && isFinite(qty) && qty >= 1 && qty <= 99) out.push({ type: 'cart_add', id: cid, qty: qty });
      } else if (a.type === 'saved_add' || a.type === 'saved_remove') {
        var sid = safeId(a.id);
        if (sid) out.push({ type: a.type, id: sid, pid: safeId(a.pid) });
      } else if (a.type === 'prefill_enquiry') {
        var fields = {}, any = false;
        if (a.fields && typeof a.fields === 'object') {
          for (var k = 0; k < ENQUIRY_FIELDS.length; k += 1) {
            var f = ENQUIRY_FIELDS[k];
            var v = typeof a.fields[f] === 'string' ? str(a.fields[f], 2000).trim() : '';
            // "" means "leave that box alone": only what was really given is written for the form
            if (v) { fields[f] = v; any = true; }
          }
        }
        if (any) out.push({ type: 'prefill_enquiry', fields: fields });
      }
    }
    return out;
  }

  // ---- the conversation, kept in this tab -----------------------------------------------------------------------------
  // message: { role: 'user' | 'bot', text, cards: [], notes: [{kind: 'done'|'queued'|'failed'|'info', text, link?: {href, label}}], err?, retry? }
  var state = { msgs: [], resume: false };
  var memoryOnly = null; // when sessionStorage is blocked, the conversation lives here for the life of the page

  function cleanNotes(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && out.length < 12; i += 1) {
      var n = list[i];
      if (!n || typeof n !== 'object') continue;
      var kind = n.kind === 'queued' || n.kind === 'failed' || n.kind === 'info' ? n.kind : 'done';
      var t = oneLine(n.text, 400);
      if (!t) continue;
      var note = { kind: kind, text: t };
      var lh = n.link && safePath(n.link.href);
      if (lh) note.link = { href: lh, label: oneLine(n.link.label, 60) || 'Open' };
      out.push(note);
    }
    return out;
  }
  function loadState() {
    var s = sess();
    var d = s ? readJson(s, STORE_KEY) : memoryOnly;
    if (!d || d.v !== 1 || !Array.isArray(d.msgs)) return;
    var msgs = [];
    for (var i = 0; i < d.msgs.length && msgs.length < MAX_KEPT; i += 1) {
      var m = d.msgs[i];
      if (!m || (m.role !== 'user' && m.role !== 'bot')) continue;
      msgs.push({ role: m.role, text: str(m.text, 4000), cards: m.role === 'bot' ? cleanCards(m.cards) : [], notes: m.role === 'bot' ? cleanNotes(m.notes) : [], err: !!m.err });
    }
    state.msgs = msgs;
    state.resume = d.resume === true;
  }
  function saveState() {
    var out = { v: 1, resume: !!state.resume, msgs: [] };
    var from = Math.max(0, state.msgs.length - MAX_KEPT);
    for (var i = from; i < state.msgs.length; i += 1) {
      var m = state.msgs[i];
      if (m.retry) continue; // a failed attempt is not part of the record
      out.msgs.push({ role: m.role, text: m.text, cards: m.cards, notes: m.notes, err: m.err });
    }
    var s = sess();
    if (s) { if (!storeSet(s, STORE_KEY, JSON.stringify(out))) memoryOnly = out; } else memoryOnly = out;
  }

  // ---- what the page knows: sent with every message (and nothing else) -------------------------------------------------
  function shopCart() {
    var l = loc(), list = l ? readJson(l, SHOP_CART_KEY) : null, out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && out.length < 40; i += 1) {
      var line = list[i], id = line && safeId(String(line.vid || ''));
      var qty = Math.floor(Number(line && line.qty));
      if (id && qty >= 1 && qty <= 9999) out.push({ id: id, qty: qty });
    }
    return out;
  }
  function shopSaved() {
    var l = loc(), list = l ? readJson(l, SHOP_SAVED_KEY) : null, out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && out.length < 60; i += 1) {
      var id = list[i] && (safeId(String(list[i].vid || '')) || safeId(String(list[i].pid || ''))); // the variant id, like the cart's and the actions'
      if (id && out.indexOf(id) < 0) out.push(id);
    }
    return out;
  }
  function pageContext() {
    return {
      path: window.location.pathname,
      title: oneLine(document.title, 200),
      cart: shopCart(),
      saved: shopSaved(),
      viewport: isPhone() ? 'phone' : 'desktop'
    };
  }
  function history() {
    var out = [];
    for (var i = 0; i < state.msgs.length; i += 1) {
      var m = state.msgs[i];
      if (m.err || m.retry || !m.text) continue;
      out.push({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text.length > MAX_TEXT ? m.text.slice(0, MAX_TEXT) : m.text });
    }
    return out.slice(-MAX_SENT);
  }

  // ---- the shop: cart and saved list ------------------------------------------------------------------------------------
  // The shop keeps them in its own React state and in localStorage (keys above), validated against a catalogue that only the shop page
  // has. So: on the shop page the change is made by the page itself (it answers a "terucon:shop" event); from any other page the
  // change is queued here and the shop applies it when it opens. TeruBot says which of the two happened.
  function readQueue() {
    var s = sess(), list = s ? readJson(s, PENDING_KEY) : null, out = [], t = now();
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i += 1) {
      var q = list[i];
      if (!q || (q.op !== 'cart_add' && q.op !== 'saved_add' && q.op !== 'saved_remove')) continue;
      if (!safeId(q.id) || typeof q.at !== 'number' || t - q.at > PENDING_MAX_AGE || q.at > t + 60000) continue;
      out.push({ op: q.op, id: q.id, pid: safeId(q.pid), qty: q.op === 'cart_add' ? Math.max(1, Math.min(99, Math.floor(Number(q.qty)) || 1)) : undefined, at: q.at, ref: typeof q.ref === 'string' ? q.ref : '' });
    }
    return out;
  }
  function writeQueue(list) {
    var s = sess();
    if (!s) return false;
    if (!list.length) { storeDel(s, PENDING_KEY); return true; }
    return storeSet(s, PENDING_KEY, JSON.stringify(list));
  }
  function onShopPage() {
    return /^\/(materials|materials\.html|market_place_1\.html)\/?$/i.test(window.location.pathname);
  }
  function shopLink(label) {
    return { href: '/materials', label: label || 'Open the shop' };
  }
  function cardName(id, cards) {
    for (var i = 0; cards && i < cards.length; i += 1) if (cards[i].id === id) return cards[i].name;
    return '';
  }
  var refCounter = 0;
  /** Ask the shop page to make the change now. Returns the shop's answer, or null when no shop page answered. */
  function askShop(op, id, qty, pid) {
    var detail = { op: op, id: id, pid: pid || '', qty: qty, handled: false, ok: false, label: '', message: '', undo: null };
    try { window.dispatchEvent(new CustomEvent('terucon:shop', { detail: detail })); } catch (e) { return null; }
    return detail.handled ? detail : null;
  }

  // ---- the widget -------------------------------------------------------------------------------------------------------
  var rootEl, launchEl, panelEl, scrimEl, titleEl, subEl, noticeEl, noticeTextEl, noticeActEl, logEl, chipsEl, formEl, inputEl, micBtn, micStatusEl, sendBtn;
  var built = false, isOpen = false, busy = false, prevFocus = null, typingEl = null;
  var gen = 0; // bumped by "New chat" so an answer to an old conversation is dropped
  var inflight = null, blockedUntil = 0, blockTimer = 0;
  var status = { known: false, aiOn: null, signedIn: null, unreachable: false };
  var statusAsked = false;
  var rec = null, listening = false, micBase = '';

  function setSub() {
    if (!subEl) return;
    var t = 'Materials, the studio, projects';
    if (status.unreachable) t = 'Can’t be reached right now';
    else if (status.known && status.aiOn === false) t = 'The AI is off';
    subEl.textContent = t;
  }
  function showNotice(kind, text, actionLabel, actionFn) {
    if (!noticeEl) return;
    noticeTextEl.textContent = text;
    noticeEl.setAttribute('data-kind', kind);
    if (actionLabel) {
      noticeActEl.textContent = actionLabel;
      noticeActEl.hidden = false;
      noticeActEl.onclick = actionFn;
    } else {
      noticeActEl.hidden = true;
      noticeActEl.onclick = null;
    }
    noticeEl.hidden = false;
  }
  function hideNotice(kind) {
    if (!noticeEl || noticeEl.hidden) return;
    if (kind && noticeEl.getAttribute('data-kind') !== kind) return;
    noticeEl.hidden = true;
  }
  function describeStatus() {
    setSub();
    if (status.unreachable) {
      showNotice('down', 'TeruBot can’t be reached right now. Check your connection, then try again.', 'Try again', function () { checkStatus(true); });
    } else if (status.known && status.aiOn === false) {
      showNotice('off', 'TeruBot’s AI is not set up on this site yet, so it can’t answer questions for now.', 'Check again', function () { checkStatus(true); });
    } else {
      hideNotice('down');
      hideNotice('off');
    }
  }
  function checkStatus(force) {
    if (statusAsked && !force) return;
    statusAsked = true;
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 10000);
    fetch(STATUS_URL, { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('status ' + r.status);
        return r.json();
      })
      .then(function (j) {
        status.known = true;
        status.unreachable = false;
        status.aiOn = !!(j && j.aiOn === true);
        status.signedIn = j && typeof j.signedIn === 'boolean' ? j.signedIn : null;
        describeStatus();
      })
      .catch(function () {
        clearTimeout(timer);
        status.unreachable = true;
        describeStatus();
      });
  }

  function scrollEnd() {
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  }
  function noteNode(msg, note) {
    var n = el('div', 'tb-note tb-note--' + note.kind);
    n.appendChild(el('span', 'tb-note__text', note.text));
    if (note.link) {
      var a = el('a', null, note.link.label);
      a.href = note.link.href;
      n.appendChild(a);
    }
    if (note.undo) {
      var b = el('button', null, 'Undo');
      b.type = 'button';
      b.addEventListener('click', function () {
        var fn = note.undo;
        note.undo = null;
        var res = null;
        try { res = fn(); } catch (e) { res = null; }
        note.kind = res && res.ok ? 'info' : 'failed';
        note.text = res && res.text ? oneLine(res.text, 300) : 'I could not undo that.';
        delete note.link;
        refreshMessage(msg);
        saveState();
      });
      n.appendChild(b);
    }
    return n;
  }
  function cardNode(c) {
    var li = el('li');
    var a = el('a', 'tb-card');
    a.href = c.href;
    var img;
    if (c.image) {
      img = el('img', 'tb-card__img');
      img.alt = '';
      img.width = 56;
      img.height = 56;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', function () { img.removeAttribute('src'); img.className = 'tb-card__img tb-card__img--none'; });
      img.src = c.image;
    } else {
      img = el('span', 'tb-card__img tb-card__img--none');
    }
    a.appendChild(img);
    var body = el('span', 'tb-card__body');
    body.appendChild(el('span', 'tb-card__name', c.name));
    if (c.variant) body.appendChild(el('span', 'tb-card__variant', c.variant));
    if (c.price) body.appendChild(el('span', 'tb-card__price', c.price));
    a.appendChild(body);
    a.appendChild(el('span', 'tb-card__go', '›'));
    li.appendChild(a);
    return li;
  }
  function messageNode(msg) {
    var wrap = el('div', 'tb-msg ' + (msg.role === 'user' ? 'tb-msg--user' : 'tb-msg--bot') + (msg.err ? ' tb-msg--err' : ''));
    if (msg.role === 'user') {
      wrap.appendChild(el('p', 'tb-bubble', msg.text));
      return wrap;
    }
    if (msg.text) wrap.appendChild(el('p', 'tb-text', msg.text));
    if (msg.cards && msg.cards.length) {
      var ul = el('ul', 'tb-cards');
      for (var i = 0; i < msg.cards.length; i += 1) ul.appendChild(cardNode(msg.cards[i]));
      wrap.appendChild(ul);
    }
    if (msg.notes) for (var j = 0; j < msg.notes.length; j += 1) wrap.appendChild(noteNode(msg, msg.notes[j]));
    if (msg.retry) {
      var rb = el('button', 'tb-textbtn', 'Try again');
      rb.type = 'button';
      rb.addEventListener('click', function () {
        if (busy || !isOpen) return;
        removeMessage(msg);
        request();
      });
      wrap.appendChild(rb);
    }
    return wrap;
  }
  function refreshMessage(msg) {
    if (!msg._el || !logEl) return;
    var fresh = messageNode(msg);
    msg._el.parentNode.replaceChild(fresh, msg._el);
    msg._el = fresh;
  }
  function appendMessage(msg) {
    state.msgs.push(msg);
    if (state.msgs.length > MAX_KEPT * 2) state.msgs.splice(0, state.msgs.length - MAX_KEPT);
    if (logEl) {
      msg._el = messageNode(msg);
      if (typingEl && typingEl.parentNode === logEl) logEl.insertBefore(msg._el, typingEl);
      else logEl.appendChild(msg._el);
      scrollEnd();
    }
    updateChips();
    return msg;
  }
  function removeMessage(msg) {
    var i = state.msgs.indexOf(msg);
    if (i >= 0) state.msgs.splice(i, 1);
    if (msg._el && msg._el.parentNode) msg._el.parentNode.removeChild(msg._el);
    updateChips();
  }
  function greetingNode() {
    var g = el('div', 'tb-msg tb-msg--bot');
    g.setAttribute('data-greeting', '');
    g.appendChild(el('p', 'tb-text', GREETING));
    return g;
  }
  /** Rebuild the whole list (first open, "New chat"). The live region is switched off while it fills, so a screen reader does not read the old chat out. */
  function renderLog() {
    logEl.setAttribute('aria-live', 'off');
    while (logEl.firstChild) logEl.removeChild(logEl.firstChild);
    typingEl = null;
    if (!state.msgs.length) logEl.appendChild(greetingNode());
    for (var i = 0; i < state.msgs.length; i += 1) {
      state.msgs[i]._el = messageNode(state.msgs[i]);
      logEl.appendChild(state.msgs[i]._el);
    }
    if (busy) showTyping();
    scrollEnd();
    setTimeout(function () { if (logEl) logEl.setAttribute('aria-live', 'polite'); }, 50);
  }
  function showTyping() {
    if (typingEl || !logEl) return;
    typingEl = el('div', 'tb-typing');
    typingEl.setAttribute('role', 'status');
    typingEl.appendChild(el('span', 'tb-sr', 'TeruBot is writing'));
    typingEl.appendChild(el('i'));
    typingEl.appendChild(el('i'));
    typingEl.appendChild(el('i'));
    logEl.appendChild(typingEl);
    scrollEnd();
  }
  function hideTyping() {
    if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
    typingEl = null;
  }
  function updateChips() {
    if (!chipsEl) return;
    var hasUser = false;
    for (var i = 0; i < state.msgs.length; i += 1) if (state.msgs[i].role === 'user') { hasUser = true; break; }
    chipsEl.hidden = hasUser;
  }
  function updateControls() {
    if (!sendBtn) return;
    var blocked = blockedUntil > now();
    var empty = !inputEl.value.trim();
    sendBtn.disabled = busy || blocked || empty;
    inputEl.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight + 2, 132) + 'px';
  }

  // ---- sending ----------------------------------------------------------------------------------------------------------
  function plainSeconds(s) {
    if (s < 90) return s + (s === 1 ? ' second' : ' seconds');
    var m = Math.ceil(s / 60);
    return 'about ' + m + (m === 1 ? ' minute' : ' minutes');
  }
  function startBlock(secs) {
    blockedUntil = now() + secs * 1000;
    clearInterval(blockTimer);
    var tick = function () {
      var left = Math.ceil((blockedUntil - now()) / 1000);
      if (left <= 0) {
        clearInterval(blockTimer);
        blockedUntil = 0;
        hideNotice('slow');
        updateControls();
        return;
      }
      showNotice('slow', 'TeruBot is getting a lot of messages. You can send the next one in ' + plainSeconds(left) + '.');
      updateControls();
    };
    tick();
    blockTimer = setInterval(tick, 1000);
  }
  function failMessage(text, retry, link) {
    var m = { role: 'bot', text: text, cards: [], notes: [], err: true, retry: !!retry };
    if (link) m.notes.push({ kind: 'info', text: 'Signing in takes a minute.', link: link });
    appendMessage(m);
    if (!retry) saveState();
  }
  function request() {
    var myGen = gen;
    busy = true;
    showTyping();
    updateControls();
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    inflight = ctl;
    var timedOut = false;
    var timer = setTimeout(function () { timedOut = true; if (ctl) ctl.abort(); }, REQUEST_TIMEOUT);
    var body = JSON.stringify({ messages: history(), context: pageContext() });
    fetch(CHAT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, credentials: 'same-origin', body: body, signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        return r.text().then(function (t) {
          var j = null;
          try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
          return { status: r.status, ok: r.ok, json: j, retryAfter: r.headers.get('Retry-After') };
        });
      })
      .then(function (res) {
        clearTimeout(timer);
        if (myGen !== gen) return;
        busy = false;
        hideTyping();
        handleResponse(res);
        updateControls();
      })
      .catch(function () {
        clearTimeout(timer);
        if (myGen !== gen) return;
        busy = false;
        hideTyping();
        status.unreachable = !timedOut;
        if (!timedOut) describeStatus();
        failMessage(timedOut ? 'TeruBot took too long to answer. Please try again.' : 'TeruBot can’t be reached right now. Check your connection, then try again.', true);
        updateControls();
      });
  }
  function errorText(j, fallback) {
    // the server's own errors are {error: "text"}; the site's guards (not JSON, cross-site) answer {error: {code, status, message}}
    var raw = j && j.error;
    var e = typeof raw === 'string' ? oneLine(raw, 200) : raw && typeof raw === 'object' && typeof raw.message === 'string' ? oneLine(raw.message, 200) : '';
    return e || fallback;
  }
  function handleResponse(res) {
    var j = res.json;
    if (res.status === 429) {
      var secs = Math.floor(Number(j && j.retryAfterSec));
      if (!(secs >= 1)) secs = Math.floor(Number(res.retryAfter)); // the Retry-After header says the same
      if (!(secs >= 1)) secs = 30;
      secs = Math.min(secs, 3600);
      startBlock(secs);
      failMessage('TeruBot is getting a lot of messages. Please try again in ' + plainSeconds(secs) + '.', false);
      return;
    }
    if (res.status === 401) {
      failMessage('Please sign in to chat with TeruBot.', false, { href: '/login', label: 'Sign in' });
      return;
    }
    if (res.status === 403 || res.status === 415) {
      failMessage(errorText(j, 'TeruBot could not accept that request from this page.'), false);
      return;
    }
    if (res.status === 400) {
      failMessage(errorText(j, 'TeruBot could not use that message.') + ' Please change it and try again.', false);
      return;
    }
    if (!res.ok || !j || typeof j !== 'object') {
      failMessage(res.status === 502 ? 'TeruBot’s AI service is not answering right now. Please try again in a moment.' : 'Something went wrong on our side. Please try again in a moment.', true);
      return;
    }
    if (j.aiOn === false) {
      status.known = true;
      status.aiOn = false;
      status.unreachable = false;
      describeStatus();
      var offText = oneLine(j.reply, 600);
      appendMessage({ role: 'bot', text: offText || 'TeruBot’s AI is not set up on this site yet.', cards: [], notes: [], err: false });
      saveState();
      return;
    }
    if (status.aiOn !== true || status.unreachable) { status.known = true; status.aiOn = true; status.unreachable = false; describeStatus(); }
    var text = typeof j.reply === 'string' ? str(j.reply, 4000).trim() : '';
    var cards = cleanCards(j.cards);
    var actions = cleanActions(j.actions);
    var msg = { role: 'bot', text: text || (cards.length || actions.length ? '' : 'TeruBot had nothing to say to that.'), cards: cards, notes: [], err: false };
    appendMessage(msg);
    runActions(msg, actions);
    if (!isOpen && launchEl) launchEl.classList.add('is-unread');
    saveState();
  }

  function submit(text) {
    var t = str(text, 100000).replace(/\r\n?/g, '\n').trim();
    if (!t || busy || blockedUntil > now()) return false;
    if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT);
    appendMessage({ role: 'user', text: t, cards: [], notes: [], err: false });
    saveState();
    request();
    return true;
  }
  function submitInput() {
    var t = inputEl.value;
    if (submit(t)) {
      inputEl.value = '';
      autosize();
      updateControls();
    }
  }

  // ---- what TeruBot does on the page: each action leaves a visible "Done:" line, and what can be undone has an Undo ------------
  function addNote(msg, note) {
    msg.notes.push(note);
    refreshMessage(msg);
  }
  function placeName(path) {
    var p = path.split('#')[0].split('?')[0];
    return PLACES[p] || path;
  }
  function leave(path, keepOpen) {
    var next, cur;
    try { next = new URL(path, window.location.href); cur = window.location; } catch (e) { return; }
    var samePage = next.pathname === cur.pathname && next.search === cur.search;
    // reopen the panel on the next page, but only when the page really changes, and not when the page is a form the visitor has to
    // read and check (the project form): there the chat would sit on top of the very thing TeruBot has just filled in
    state.resume = !samePage && keepOpen !== false;
    saveState();
    window.location.assign(path);
  }
  function runActions(msg, actions) {
    var navigation = null;
    for (var i = 0; i < actions.length; i += 1) {
      var a = actions[i];
      if (a.type === 'cart_add' || a.type === 'saved_add' || a.type === 'saved_remove') {
        shopAction(msg, a);
      } else if (!navigation) {
        navigation = a; // one trip per answer, done last, after the lines above are written down
      }
    }
    if (!navigation) return;
    if (navigation.type === 'navigate') {
      addNote(msg, { kind: 'done', text: 'Done: opening ' + placeName(navigation.to) + '. The Back button brings you back here.' });
      saveState();
      leave(navigation.to);
    } else if (navigation.type === 'open_studio') {
      addNote(msg, { kind: 'done', text: 'Done: opening the Design Studio. The Back button brings you back here.' });
      saveState();
      leave('/design-studio');
    } else if (navigation.type === 'prefill_enquiry') {
      var s = sess();
      var ok = !!s && storeSet(s, PREFILL_KEY, JSON.stringify({ v: 1, source: 'terubot', at: now(), fields: navigation.fields }));
      if (!ok) {
        addNote(msg, { kind: 'failed', text: 'I could not keep your details for the form (this browser blocks storage), so I did not open it.' });
        saveState();
        return;
      }
      addNote(msg, { kind: 'done', text: 'Done: your details are filled in on the project form and I am opening it. Nothing is sent until you submit it.' });
      saveState();
      leave('/start-project', false);
    }
  }
  function shopAction(msg, a) {
    var name = cardName(a.id, msg.cards) || 'this item';
    var verb = a.type === 'cart_add' ? 'cart' : 'saved list';
    var res = askShop(a.type, a.id, a.qty, a.pid);
    if (res) {
      var label = oneLine(res.label, 140) || name;
      if (res.ok) {
        var nt = { kind: 'done', text: 'Done: ' + (res.message ? oneLine(res.message, 260) : (a.type === 'cart_add' ? 'added ' + a.qty + ' × ' + label + ' to your cart.' : a.type === 'saved_add' ? label + ' is in your saved list.' : label + ' is out of your saved list.')) };
        if (typeof res.undo === 'function') nt.undo = res.undo;
        addNote(msg, nt);
      } else {
        addNote(msg, { kind: 'failed', text: 'I could not do that: ' + (oneLine(res.message, 260) || 'the shop did not accept it.') });
      }
      return;
    }
    // no shop page answered: queue it for the shop
    var queue = readQueue();
    refCounter += 1;
    var ref = String(now()) + '-' + refCounter;
    queue.push({ op: a.type, id: a.id, pid: a.pid || '', qty: a.qty, at: now(), ref: ref });
    if (!writeQueue(queue)) {
      addNote(msg, { kind: 'failed', text: 'I could not do that: this browser blocks the storage I would need to keep it for the shop.' });
      return;
    }
    var what = a.type === 'cart_add' ? 'add ' + a.qty + ' × ' + name + ' to your cart' : a.type === 'saved_add' ? 'save ' + name + ' to your saved list' : 'take ' + name + ' out of your saved list';
    var qn = { kind: 'queued', text: 'Not done yet: I will ' + what + ' when you open the shop. Nothing in your ' + verb + ' has changed so far.', link: shopLink('Open the shop') };
    qn.undo = function () {
      var rest = readQueue().filter(function (q) { return q.ref !== ref; });
      writeQueue(rest);
      return { ok: true, text: 'Undone: I will not ' + what + '.' };
    };
    addNote(msg, qn);
  }

  // The shop tells us what it did with queued changes when it opens.
  window.addEventListener('terucon:shop-applied', function (ev) {
    var items = ev && ev.detail && Array.isArray(ev.detail.items) ? ev.detail.items : [];
    if (!items.length) return;
    var notes = [];
    for (var i = 0; i < items.length && notes.length < 8; i += 1) {
      var it = items[i];
      if (!it || typeof it !== 'object') continue;
      var text = oneLine(it.text, 300);
      if (!text) continue;
      notes.push({ kind: it.ok ? 'done' : 'failed', text: (it.ok ? 'Done: ' : 'I could not do that: ') + text });
    }
    if (!notes.length) return;
    // what was "not done yet" is now done (or refused): the old promises come out of the chat, the new lines say what happened
    for (var q = state.msgs.length - 1; q >= 0; q -= 1) {
      var old = state.msgs[q];
      if (old.role !== 'bot' || !old.notes || !old.notes.length) continue;
      var kept = old.notes.filter(function (n) { return n.kind !== 'queued'; });
      if (kept.length === old.notes.length) continue;
      old.notes = kept;
      if (!old.text && !old.cards.length && !kept.length) removeMessage(old); else refreshMessage(old);
    }
    var msg = { role: 'bot', text: '', cards: [], notes: notes, err: false };
    appendMessage(msg);
    saveState();
    if (!isOpen && launchEl) launchEl.classList.add('is-unread');
  });

  // ---- voice input: the browser's own speech recognition, hidden where it cannot work --------------------------------------
  function micAvailable() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return false;
    // a page that forbids the microphone (the Design Studio and the Finder send Permissions-Policy: microphone=()) would only fail
    var pp = document.permissionsPolicy || document.featurePolicy;
    if (pp && typeof pp.allowsFeature === 'function') {
      try { if (!pp.allowsFeature('microphone')) return false; } catch (e) { /* ask the browser instead */ }
    }
    return true;
  }
  function micMessage(code) {
    if (code === 'not-allowed' || code === 'service-not-allowed') return 'The microphone is blocked. Allow it in your browser’s site settings, or type instead.';
    if (code === 'no-speech') return 'I didn’t catch anything. Tap the microphone and try again, or type.';
    if (code === 'audio-capture') return 'No microphone was found. You can type instead.';
    if (code === 'network') return 'Your browser’s speech service couldn’t be reached. You can type instead.';
    return 'Voice input stopped. You can type instead.';
  }
  function setListening(on) {
    listening = on;
    micBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    micBtn.setAttribute('aria-label', on ? 'Stop listening' : 'Speak your message');
    micBtn.title = on ? 'Stop listening' : 'Speak your message';
  }
  function startMic() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    micStatusEl.hidden = true;
    var r;
    try { r = new SR(); } catch (e) { micStatusEl.textContent = 'Voice input couldn’t start here. You can type instead.'; micStatusEl.hidden = false; return; }
    rec = r;
    r.lang = 'en-IN';
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    var finalText = '', err = '', cancelled = false;
    micBase = inputEl.value.trim();
    r.onresult = function (e) {
      var fin = '', interim = '';
      for (var i = e.resultIndex; i < e.results.length; i += 1) {
        var t = e.results[i][0].transcript;
        if (e.results[i].isFinal) fin += t; else interim += t;
      }
      if (fin) finalText = (finalText + ' ' + fin).trim();
      inputEl.value = (micBase + ' ' + finalText + ' ' + interim).replace(/\s+/g, ' ').trim();
      autosize();
      updateControls();
    };
    r.onerror = function (e) { err = e && e.error ? e.error : 'error'; if (err === 'aborted') cancelled = true; };
    r.onend = function () {
      if (rec === r) rec = null;
      setListening(false);
      if (cancelled && !finalText) { updateControls(); return; }
      if (finalText) {
        inputEl.value = (micBase + ' ' + finalText).trim();
        autosize();
        updateControls();
        submitInput(); // the older assistants sent what they heard at once; so does this one
      } else if (err) {
        micStatusEl.textContent = micMessage(err);
        micStatusEl.hidden = false;
      } else {
        micStatusEl.textContent = micMessage('no-speech');
        micStatusEl.hidden = false;
      }
    };
    try {
      r.start();
      setListening(true);
    } catch (e) {
      rec = null;
      setListening(false);
      micStatusEl.textContent = 'Voice input couldn’t start here. You can type instead.';
      micStatusEl.hidden = false;
    }
  }
  function stopMic() {
    if (rec) { try { rec.stop(); } catch (e) { /* already stopped */ } }
  }
  function abortMic() {
    if (rec) { var r = rec; rec = null; try { r.abort(); } catch (e) { /* already stopped */ } }
    if (micBtn) setListening(false);
  }

  // ---- building the panel (the first time it opens) ----------------------------------------------------------------------
  function focusables() {
    var list = panelEl.querySelectorAll('a[href], button, textarea, [tabindex]:not([tabindex="-1"])');
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      var n = list[i];
      if (n.disabled || n.hidden || n.getAttribute('aria-hidden') === 'true') continue;
      var r = n.getClientRects();
      if (!r.length) continue; // not displayed (a hidden parent)
      out.push(n);
    }
    return out;
  }
  function onPanelKey(e) {
    // the page's own shortcuts (the shop closes its menu on Escape) must not fire from inside the panel
    e.stopPropagation();
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Tab') {
      var f = focusables();
      if (!f.length) { e.preventDefault(); return; }
      var first = f[0], last = f[f.length - 1], cur = document.activeElement;
      if (e.shiftKey && (cur === first || cur === panelEl || !panelEl.contains(cur))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (cur === last || !panelEl.contains(cur))) { e.preventDefault(); first.focus(); }
    }
  }
  function build() {
    if (built) return;
    built = true;
    scrimEl = el('div', 'tb-scrim');
    scrimEl.hidden = true;
    scrimEl.addEventListener('click', close);

    panelEl = el('section', 'tb-panel');
    panelEl.id = 'terubot-panel';
    panelEl.hidden = true;
    panelEl.tabIndex = -1;
    panelEl.setAttribute('role', 'dialog');
    panelEl.setAttribute('aria-labelledby', 'terubot-title');
    panelEl.addEventListener('keydown', onPanelKey);
    // keystrokes and clicks inside the panel belong to the panel (the studio and the shop listen on the window)
    panelEl.addEventListener('keyup', function (e) { e.stopPropagation(); });
    panelEl.addEventListener('keypress', function (e) { e.stopPropagation(); });

    var head = el('header', 'tb-head');
    var mark = el('span', 'tb-head__mark');
    mark.appendChild(icon(ICON_CHAT));
    head.appendChild(mark);
    var ht = el('div', 'tb-head__text');
    titleEl = el('h2', 'tb-title', 'TeruBot');
    titleEl.id = 'terubot-title';
    titleEl.tabIndex = -1;
    subEl = el('span', 'tb-sub');
    ht.appendChild(titleEl);
    ht.appendChild(subEl);
    head.appendChild(ht);
    var fresh = el('button', 'tb-textbtn', 'New chat');
    fresh.type = 'button';
    fresh.addEventListener('click', newChat);
    head.appendChild(fresh);
    var closeBtn = el('button', 'tb-iconbtn');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close TeruBot');
    closeBtn.appendChild(icon(ICON_CLOSE));
    closeBtn.addEventListener('click', close);
    head.appendChild(closeBtn);
    panelEl.appendChild(head);

    noticeEl = el('div', 'tb-notice');
    noticeEl.hidden = true;
    noticeEl.setAttribute('role', 'status');
    noticeTextEl = el('span', 'tb-notice__text');
    noticeActEl = el('button');
    noticeActEl.type = 'button';
    noticeActEl.hidden = true;
    noticeEl.appendChild(noticeTextEl);
    noticeEl.appendChild(noticeActEl);
    panelEl.appendChild(noticeEl);

    logEl = el('div', 'tb-log');
    logEl.setAttribute('role', 'log');
    logEl.setAttribute('aria-live', 'polite');
    logEl.setAttribute('aria-label', 'Conversation with TeruBot');
    panelEl.appendChild(logEl);

    chipsEl = el('div', 'tb-chips');
    chipsEl.setAttribute('role', 'group');
    chipsEl.setAttribute('aria-label', 'Suggestions');
    SUGGESTIONS.forEach(function (s) {
      var c = el('button', 'tb-chip', s);
      c.type = 'button';
      c.addEventListener('click', function () { submit(s); });
      chipsEl.appendChild(c);
    });
    panelEl.appendChild(chipsEl);

    micStatusEl = el('p', 'tb-mic-status');
    micStatusEl.hidden = true;
    micStatusEl.setAttribute('role', 'status');
    panelEl.appendChild(micStatusEl);

    formEl = el('form', 'tb-form');
    formEl.addEventListener('submit', function (e) { e.preventDefault(); submitInput(); });
    inputEl = el('textarea', 'tb-input');
    inputEl.rows = 1;
    inputEl.maxLength = MAX_TEXT;
    inputEl.placeholder = 'Type your question…';
    inputEl.setAttribute('aria-label', 'Message TeruBot');
    inputEl.setAttribute('enterkeyhint', 'send');
    inputEl.autocomplete = 'off';
    inputEl.addEventListener('input', function () { autosize(); updateControls(); });
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        submitInput();
      }
    });
    formEl.appendChild(inputEl);
    micBtn = el('button', 'tb-roundbtn');
    micBtn.type = 'button';
    micBtn.setAttribute('aria-pressed', 'false');
    micBtn.setAttribute('aria-label', 'Speak your message');
    micBtn.title = 'Speak your message';
    micBtn.appendChild(icon(ICON_MIC));
    micBtn.hidden = !micAvailable();
    micBtn.addEventListener('click', function () { if (listening) stopMic(); else startMic(); });
    formEl.appendChild(micBtn);
    sendBtn = el('button', 'tb-roundbtn tb-send');
    sendBtn.type = 'submit';
    sendBtn.setAttribute('aria-label', 'Send');
    sendBtn.title = 'Send';
    sendBtn.appendChild(icon(ICON_SEND));
    formEl.appendChild(sendBtn);
    panelEl.appendChild(formEl);
    panelEl.appendChild(el('p', 'tb-foot', 'TeruBot can make mistakes. Check prices and details before you order.'));

    rootEl.appendChild(scrimEl);
    rootEl.appendChild(panelEl);
    renderLog();
    updateChips();
    setSub();
    updateControls();
  }

  // ---- open, close, new chat ---------------------------------------------------------------------------------------------
  function onViewport() {
    var vv = window.visualViewport;
    if (!vv || !isOpen || !isPhone()) { rootEl.classList.remove('is-kb'); return; }
    var kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    if (kb > 80) {
      rootEl.style.setProperty('--tb-kb', kb + 'px');
      rootEl.style.setProperty('--tb-vvh', Math.round(vv.height) + 'px');
      rootEl.classList.add('is-kb');
    } else {
      rootEl.classList.remove('is-kb');
    }
  }
  function open(opts) {
    if (!rootEl) { pending = function () { open(opts); }; return; }
    build();
    var phone = isPhone();
    if (!isOpen) {
      prevFocus = document.activeElement && document.activeElement !== document.body ? document.activeElement : launchEl;
      isOpen = true;
      rootEl.classList.add('is-open');
      launchEl.setAttribute('aria-expanded', 'true');
      launchEl.classList.remove('is-unread');
      panelEl.hidden = false;
      panelEl.setAttribute('aria-modal', phone ? 'true' : 'false');
      scrimEl.hidden = !phone;
      logEl.scrollTop = logEl.scrollHeight;
      if (!statusAsked) checkStatus(false);
      if (window.visualViewport) { window.visualViewport.addEventListener('resize', onViewport); window.visualViewport.addEventListener('scroll', onViewport); }
    }
    if (opts && typeof opts.draft === 'string' && !inputEl.value) {
      inputEl.value = str(opts.draft, MAX_TEXT);
      autosize();
      updateControls();
    }
    // on a phone, focusing the box would raise the keyboard over half the sheet before the person has read anything
    if (phone && !(opts && opts.draft)) titleEl.focus(); else { inputEl.focus(); try { inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length); } catch (e) { /* not selectable */ } }
    if (opts && opts.mic && micAvailable() && !listening) startMic();
  }
  function close() {
    if (!isOpen) return;
    abortMic();
    isOpen = false;
    rootEl.classList.remove('is-open');
    rootEl.classList.remove('is-kb');
    launchEl.setAttribute('aria-expanded', 'false');
    panelEl.hidden = true;
    scrimEl.hidden = true;
    if (window.visualViewport) { window.visualViewport.removeEventListener('resize', onViewport); window.visualViewport.removeEventListener('scroll', onViewport); }
    var back = prevFocus && document.contains(prevFocus) && !prevFocus.disabled ? prevFocus : launchEl;
    prevFocus = null;
    try { back.focus(); } catch (e) { launchEl.focus(); }
  }
  function newChat() {
    gen += 1;
    if (inflight) { try { inflight.abort(); } catch (e) { /* done already */ } inflight = null; }
    abortMic();
    busy = false;
    state.msgs = [];
    state.resume = false;
    writeQueue([]); // a change TeruBot promised for the shop is dropped with the chat that promised it
    saveState();
    clearInterval(blockTimer);
    blockedUntil = 0;
    hideNotice('slow');
    micStatusEl.hidden = true;
    inputEl.value = '';
    autosize();
    renderLog();
    updateChips();
    updateControls();
    inputEl.focus();
  }
  function ask(text) {
    open();
    return submit(text);
  }

  // ---- the launcher: cheap, and the only thing built at page load ---------------------------------------------------------
  var pending = null;
  function mount() {
    if (rootEl) return;
    loadState();
    rootEl = el('div', 'tb-root');
    rootEl.id = 'terubot';
    // the Design Studio's working view keeps its Share button, zoom control and status line along the bottom edge, and the studio's code
    // cannot be given a variable to set: the stylesheet lifts the launcher there (see .is-studio in terubot.css)
    if (/^\/(design-studio|studio|swatchroom)\/?$/i.test(window.location.pathname)) rootEl.classList.add('is-studio');
    launchEl = el('button', 'tb-launch');
    launchEl.type = 'button';
    launchEl.setAttribute('aria-haspopup', 'dialog');
    launchEl.setAttribute('aria-expanded', 'false');
    launchEl.setAttribute('aria-controls', 'terubot-panel');
    var mk = el('span', 'tb-launch__mark');
    mk.appendChild(icon(ICON_CHAT));
    launchEl.appendChild(mk);
    launchEl.appendChild(el('span', 'tb-launch__label', 'Ask TeruBot'));
    launchEl.addEventListener('click', function () { open(); });
    rootEl.appendChild(launchEl);
    root.appendChild(rootEl); // a child of <html>, like the phone dock: a page that re-renders its <body> cannot take it away
    if (window.MutationObserver) {
      new MutationObserver(function () { if (rootEl.parentNode !== document.documentElement) document.documentElement.appendChild(rootEl); }).observe(document.documentElement, { childList: true });
    }
    if (pending) { var p = pending; pending = null; p(); }
    else if (state.resume) {
      state.resume = false;
      saveState();
      open(); // TeruBot sent the visitor to this page: the conversation is still open
    }
  }

  window.TeruBot = {
    open: function (opts) { open(opts); },
    close: function () { close(); },
    ask: function (text) { return ask(text); },
    isOpen: function () { return isOpen; }
  };

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
