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
  var SPEECH_URL = '/api/terubot/speech?id=';
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
  var FORM_PAGES = ['/start-project']; // pages to read and fill in: the chat does not reopen over them (see leave() and mount())
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
  var ICON_WAVE = ['M4 10v4', 'M8 6.5v11', 'M12 3.5v17', 'M16 7.5v9', 'M20 10v4'];
  var ICON_CLIP = ['M20.5 11.2l-8.1 8.1a5.2 5.2 0 0 1-7.4-7.4l8.4-8.4a3.5 3.5 0 0 1 4.9 4.9l-8.4 8.4a1.8 1.8 0 0 1-2.5-2.5l7.7-7.7'];

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
      msgs.push({ role: m.role, text: str(m.text, 4000), cards: m.role === 'bot' ? cleanCards(m.cards) : [], notes: m.role === 'bot' ? cleanNotes(m.notes) : [], err: !!m.err, ph: m.ph === 1 });
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
      out.msgs.push({ role: m.role, text: m.text, cards: m.cards, notes: m.notes, err: m.err, ph: m.thumb || m.attach || m.ph ? 1 : 0 }); // a picture is not kept in the tab, only that there was one
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
  var talkBtn, liveEl, liveTextEl, liveSkipBtn;
  var live = false, liveStep = '', silentRuns = 0, lastAnswered = false; // the live conversation (see "live conversation" below)
  var built = false, isOpen = false, busy = false, prevFocus = null, typingEl = null;
  var gen = 0; // bumped by "New chat" so an answer to an old conversation is dropped
  var inflight = null, blockedUntil = 0, blockTimer = 0;
  var status = { known: false, aiOn: null, signedIn: null, unreachable: false, voice: false }; // voice: Google's voice is on (the server says)
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
        status.voice = !!(j && j.voice === true);
        if (talkBtn) talkBtn.hidden = !talkAvailable(); // the voice may be the reason Talk can be offered (a browser with no speech of its own)
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
      if (msg.thumb) wrap.appendChild(photoNode(msg.thumb, 'Your photo'));
      else if (msg.ph) wrap.appendChild(el('p', 'tb-attach__gone', 'Photo attached'));
      wrap.appendChild(el('p', 'tb-bubble', msg.text));
      return wrap;
    }
    if (msg.attach) wrap.appendChild(photoNode(msg.attach.thumb || '', msg.attach.host ? 'Picture from ' + msg.attach.host : 'Picture from the link', msg.attach.host));
    else if (msg.ph) wrap.appendChild(el('p', 'tb-attach__gone', 'Picture from a link'));
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
    var empty = !inputEl.value.trim() && !photo;
    sendBtn.disabled = busy || blocked || empty;
    inputEl.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight + 2, 132) + 'px';
  }

  // ---- photos: attached by the visitor, or fetched by the site for a link they pasted -------------------------------------------
  // `photo` is the picture of this conversation: it goes with every message until it is removed or "New chat". An attached picture is shrunk
  // here (longest side PHOTO_SIDE, JPEG) and sent as base64; a picture the site fetched for a link stays on the server for a few minutes and is
  // sent as its token. A thumbnail is a small data: address (the strict pages allow those; they do not all allow blob: pictures).
  var PHOTO_SIDE = 1280;
  var photo = null; // {kind: 'upload' | 'link', type, data, thumb, token, host, full (a Blob, kept for the Finder and the studio), shown}
  var photoStripEl = null, photoThumbEl = null, photoLabelEl = null, photoInputEl = null, attachBtn = null, photoBusy = false;

  function cleanAttachment(a) {
    if (!a || typeof a !== 'object' || a.kind !== 'link' || typeof a.token !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(a.token)) return null;
    return { token: a.token, host: oneLine(a.host, 60) };
  }
  /** Draw a picture (a File, a pasted image, a fetched Blob) at most `side` px on its longest side. cb(error text | null, canvas). */
  function drawSmall(blob, side, cb) {
    var done = function (src, w, h) {
      if (!w || !h) { cb('That file is not a picture this browser can read. Try a JPEG or PNG.'); return; }
      var k = Math.min(1, side / Math.max(w, h));
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * k));
      c.height = Math.max(1, Math.round(h * k));
      var x = c.getContext('2d');
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, c.width, c.height);
      try { x.drawImage(src, 0, 0, c.width, c.height); } catch (e) { cb('That picture could not be read.'); return; }
      cb(null, c);
    };
    if (window.createImageBitmap) {
      window.createImageBitmap(blob).then(function (bmp) { done(bmp, bmp.width, bmp.height); }, function () { fromReader(); });
    } else {
      fromReader();
    }
    function fromReader() {
      var r = new FileReader();
      r.onerror = function () { cb('That file could not be read.'); };
      r.onload = function () {
        var im = new Image();
        im.onload = function () { done(im, im.naturalWidth, im.naturalHeight); };
        im.onerror = function () { cb('That file is not a picture this browser can read. Try a JPEG or PNG.'); };
        im.src = r.result;
      };
      r.readAsDataURL(blob);
    }
  }
  /** cb(error | null, {data: base64 JPEG of the shrunken picture, thumb: a 120 px data: address}) */
  function shrinkPhoto(blob, cb) {
    drawSmall(blob, PHOTO_SIDE, function (err, big) {
      if (err) { cb(err); return; }
      var k = 120 / Math.max(big.width, big.height);
      var t = document.createElement('canvas');
      t.width = Math.max(1, Math.round(big.width * k));
      t.height = Math.max(1, Math.round(big.height * k));
      t.getContext('2d').drawImage(big, 0, 0, t.width, t.height);
      var url = big.toDataURL('image/jpeg', 0.82);
      var comma = url.indexOf(',');
      if (comma < 0 || url.indexOf('data:image/jpeg') !== 0) { cb('This browser could not prepare that picture.'); return; }
      cb(null, { data: url.slice(comma + 1), thumb: t.toDataURL('image/jpeg', 0.7) });
    });
  }
  function photoNode(thumb, label, host) {
    var f = el('figure', 'tb-attach');
    if (thumb) {
      var im = el('img', 'tb-attach__img');
      im.alt = label;
      im.width = 96;
      im.src = thumb;
      f.appendChild(im);
    }
    f.appendChild(el('figcaption', 'tb-attach__cap', host && thumb ? label : thumb ? '' : label));
    return f;
  }
  function renderPhoto() {
    if (!photoStripEl) return;
    photoStripEl.hidden = !photo && !photoBusy;
    if (photoBusy && !photo) { photoThumbEl.removeAttribute('src'); photoThumbEl.hidden = true; photoLabelEl.textContent = 'Reading the picture…'; }
    if (photo) {
      photoThumbEl.hidden = !photo.thumb;
      if (photo.thumb) photoThumbEl.src = photo.thumb;
      photoLabelEl.textContent = photo.kind === 'link' ? 'Picture from ' + (photo.host || 'your link') : 'Your photo';
    }
    var btns = photoStripEl.querySelectorAll('button');
    for (var i = 0; i < btns.length; i += 1) btns[i].hidden = !photo;
    updateControls();
  }
  function clearPhoto() {
    photo = null;
    photoBusy = false;
    renderPhoto();
  }
  function photoProblem(text) {
    photoBusy = false;
    renderPhoto();
    showNotice('photo', text);
    setTimeout(function () { hideNotice('photo'); }, 6000);
  }
  function attachFile(file) {
    if (!file || busy) return;
    if (!/^image\//i.test(file.type || '')) { photoProblem('That file is not a picture. Choose a JPEG or PNG photo.'); return; }
    if (file.size > 40 * 1024 * 1024) { photoProblem('That picture is very large. Choose a smaller one.'); return; }
    hideNotice('photo');
    photoBusy = true;
    renderPhoto();
    shrinkPhoto(file, function (err, out) {
      if (err) { photoProblem(err); return; }
      photoBusy = false;
      photo = { kind: 'upload', type: 'image/jpeg', data: out.data, thumb: out.thumb, token: '', host: '', full: file, shown: false };
      renderPhoto();
      if (inputEl) inputEl.focus();
    });
  }
  /** A picture the site fetched for a link in the answer: keep its token for the next messages, fetch it once for the thumbnail and the hand-over. */
  function takeLinkPhoto(att, msg) {
    var mine = { kind: 'link', type: 'image/jpeg', data: '', thumb: '', token: att.token, host: att.host, full: null, shown: true };
    photo = mine;
    renderPhoto();
    fetch('/api/inspiration/file/' + encodeURIComponent(att.token), { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('gone'); return r.blob(); })
      .then(function (blob) {
        mine.full = blob;
        drawSmall(blob, 120, function (err, c) {
          if (err) return;
          mine.thumb = c.toDataURL('image/jpeg', 0.7);
          if (msg) { msg.attach.thumb = mine.thumb; refreshMessage(msg); }
          if (photo === mine) renderPhoto();
        });
      })
      .catch(function () { /* the thumbnail is a nicety; the conversation goes on without it */ });
  }
  /** Take the photo to the Finder or the Design Studio, with the hand-over the Inspiration page uses (site/inspiration/handoff.js). */
  function handOff(where) {
    if (!photo) return;
    var mine = photo;
    var go = function (blob) {
      import('/inspiration/assets/handoff.js').then(function (m) {
        return where === 'studio' ? m.sendToStudio(blob, { from: 'terubot' }) : m.sendToFinder(blob, { from: 'terubot' });
      }).catch(function () { photoProblem('This browser would not keep the picture for the next page. Save it and upload it there.'); });
    };
    if (mine.full) { go(mine.full); return; }
    fetch('/api/inspiration/file/' + encodeURIComponent(mine.token), { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('gone'); return r.blob(); })
      .then(function (blob) { mine.full = blob; go(blob); })
      .catch(function () { photoProblem('That picture is no longer available. Paste the link again.'); });
  }
  function pickedFile(e) {
    var list = e.clipboardData && e.clipboardData.files ? e.clipboardData.files : e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files : null;
    if (!list) return null;
    for (var i = 0; i < list.length; i += 1) if (/^image\//i.test(list[i].type || '')) return list[i];
    return null;
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
    var payload = { messages: history(), context: pageContext() };
    if (live && playerAvailable()) payload.speak = true; // a live conversation: have the answer made ready for Google's voice (the server leaves it out when the voice is off, and brings it back by itself)
    var hadPhoto = !!photo;
    if (photo) payload.image = photo.kind === 'link' ? { token: photo.token } : { type: photo.type, data: photo.data };
    var body = JSON.stringify(payload);
    fetch(CHAT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, credentials: 'same-origin', body: body, signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        return r.text().then(function (t) {
          var j = null;
          try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
          return { status: r.status, ok: r.ok, json: j, retryAfter: r.headers.get('Retry-After'), hadPhoto: hadPhoto };
        });
      })
      .then(function (res) {
        clearTimeout(timer);
        if (myGen !== gen) return;
        busy = false;
        hideTyping();
        handleResponse(res);
        if (live && !lastAnswered) endLive(); // the chat says why (too many messages, sign in, the AI is off, ...): do not listen on
        updateControls();
      })
      .catch(function () {
        clearTimeout(timer);
        if (myGen !== gen) return;
        busy = false;
        hideTyping();
        status.unreachable = !timedOut;
        if (!timedOut) describeStatus();
        if (live) endLive();
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
    lastAnswered = false;
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
      failMessage(res.hadPhoto ? errorText(j, 'Please sign in to send a photo.') : 'Please sign in to chat with TeruBot.', false, { href: '/login', label: 'Sign in' });
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
    var spoken = cleanSpeech(j.speech);
    if (spoken) { msg.speech = spoken; status.voice = true; } // not saved with the conversation: it is only for the answer that has just arrived
    var att = cleanAttachment(j.attachment);
    if (att) { msg.attach = { host: att.host, thumb: '' }; takeLinkPhoto(att, msg); }
    appendMessage(msg);
    lastAnswered = true;
    var leaving = runActions(msg, actions);
    if (!isOpen && launchEl) launchEl.classList.add('is-unread');
    saveState();
    if (!leaving) afterReply(msg);
  }

  function submit(text) {
    var t = str(text, 100000).replace(/\r\n?/g, '\n').trim();
    if (!t || busy || blockedUntil > now()) return false;
    if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT);
    if (live) { abortMic(); stopSpeaking(); setLiveStep('thinking'); } // typed, or heard: either way the answer is next
    var um = { role: 'user', text: t, cards: [], notes: [], err: false };
    if (photo && !photo.shown) { um.thumb = photo.thumb; photo.shown = true; }
    appendMessage(um);
    saveState();
    request();
    return true;
  }
  function submitInput() {
    var t = inputEl.value;
    if (!t.trim() && photo) t = 'What is this, and what in the shop looks like it?';
    if (submit(t)) {
      inputEl.value = '';
      autosize();
      updateControls();
      return true;
    }
    return false;
  }

  // ---- what TeruBot does on the page: each action leaves a visible "Done:" line, and what can be undone has an Undo ------------
  function addNote(msg, note) {
    msg.notes.push(note);
    refreshMessage(msg);
  }
  function placeName(path) {
    var p = path.split('#')[0].split('?')[0];
    return PLACES[p] || PLACES[p.length > 1 ? p.replace(/\/+$/, '') : p] || path;
  }
  /** A page the visitor has come to read and fill in (the project form). The chat never opens by itself over it. */
  function isFormPage(pathname) {
    var p = String(pathname || '').toLowerCase().replace(/\.html$/, '').replace(/\/+$/, '');
    return FORM_PAGES.indexOf(p) !== -1;
  }
  function leave(path, keepOpen) {
    var next, cur;
    try { next = new URL(path, window.location.href); cur = window.location; } catch (e) { return; }
    var samePage = next.pathname === cur.pathname && next.search === cur.search;
    // reopen the panel on the next page, but only when the page really changes, and not when the page is a form the visitor has to
    // read and check (the project form): there the chat would sit on top of the very thing they came for. This is decided by where we
    // are going, not by which action took us (a plain "navigate" to /start-project used to reopen it); mount() checks it again on arrival
    state.resume = !samePage && keepOpen !== false && !isFormPage(next.pathname);
    saveState();
    endLive(); // the page is about to go: no more listening, no more speaking (a new page starts without either)
    window.location.assign(path);
  }
  /** Does what the answer asks for; true when it started a page change (the page is about to go). */
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
    if (!navigation) return false;
    if (navigation.type === 'navigate') {
      addNote(msg, { kind: 'done', text: 'Done: opening ' + placeName(navigation.to) + '. The Back button brings you back here.' });
      saveState();
      leave(navigation.to);
      return true;
    } else if (navigation.type === 'open_studio') {
      addNote(msg, { kind: 'done', text: 'Done: opening the Design Studio. The Back button brings you back here.' });
      saveState();
      leave('/design-studio');
      return true;
    } else if (navigation.type === 'prefill_enquiry') {
      var s = sess();
      var ok = !!s && storeSet(s, PREFILL_KEY, JSON.stringify({ v: 1, source: 'terubot', at: now(), fields: navigation.fields }));
      if (!ok) {
        addNote(msg, { kind: 'failed', text: 'I could not keep your details for the form (this browser blocks storage), so I did not open it.' });
        saveState();
        return false;
      }
      addNote(msg, { kind: 'done', text: 'Done: your details are filled in on the project form and I am opening it. Nothing is sent until you submit it.' });
      saveState();
      leave('/start-project', false);
      return true;
    }
    return false;
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
        silentRuns = 0;
        inputEl.value = (micBase + ' ' + finalText).trim();
        autosize();
        updateControls();
        var sent = submitInput(); // the older assistants sent what they heard at once; so does this one
        if (live && !sent) endLive('I could not send that just now. Tap Talk to try again.');
      } else if (live) {
        if (err && err !== 'no-speech') endLive(micMessage(err));
        else if ((silentRuns += 1) >= SILENT_LIMIT) endLive('I did not hear anything, so I stopped listening. Tap Talk to start again.');
        else setTimeout(listenLive, 150); // the browser ends a quiet listen by itself: listen again
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

  // ---- live conversation: talk, and be answered aloud, like a call ---------------------------------------------------------
  // Listen (the browser's speech recognition) -> send what was heard -> say the answer aloud -> listen again. The microphone is never open
  // while TeruBot speaks (it would hear itself); tap Skip to interrupt. It ends on End, on closing the panel, on New chat, on leaving the
  // page, on a hidden tab, after three quiet listens, and on any answer that is not an answer (too many messages, sign in, the AI is off,
  // the server cannot be reached). Only the text goes to TeruBot, as with typing.
  //
  // THE VOICE. When the server says Google's voice is on (status.voice), a live chat asks for the answer to be staged ({speak: true}); the
  // reply then carries {speech: {id, parts: [{text, lang}]}} (the pieces, cleaned and respelled for the ear, with the language of each:
  // English, Hindi or Hinglish) and each piece is fetched as MP3 from /api/terubot/speech/<id>/<n> and played in order, the next one
  // already on its way while the current one plays. Any piece that cannot be fetched or played is said by the browser's own voice instead
  // (a Hindi one for Hindi), so a conversation never goes silent; where Google's voice is off, the browser's voice says everything, as it
  // did before. Nothing that is late is ever played: Skip, End, a new chat, a hidden tab or a new answer drops every fetch and sound.
  var SILENT_LIMIT = 3;
  var SPEECH_MAX_CHARS = 420; // the browser's voice reads an answer for its first few sentences; the whole of it is on the screen
  var FETCH_TIMEOUT = 20000;
  var HELLO = 'Hi, I’m TeruBot. How can I help?';
  var DEVANAGARI = /[ऀ-ॿ]/;
  var speakGen = 0, speakTimer = 0, voiceObjs = {}, voicesHooked = false;
  var audioEl = null, audioUrl = '', silenceUrl = '', speakFetches = [];

  function synthAvailable() {
    return !!(window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function');
  }
  function playerAvailable() {
    return typeof window.Audio === 'function' && typeof window.fetch === 'function' && typeof window.Blob === 'function' && !!window.URL && typeof window.URL.createObjectURL === 'function';
  }
  function serverVoiceUsable() { return status.voice === true && playerAvailable(); }
  function talkAvailable() { return (synthAvailable() || serverVoiceUsable()) && micAvailable(); }

  /** The pieces the server staged for a reply, or null: {id, parts: [{text, lang}]}. */
  function cleanSpeech(x) {
    if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !/^[A-Za-z0-9_-]{4,40}$/.test(x.id) || !Array.isArray(x.parts)) return null;
    var parts = [];
    for (var i = 0; i < x.parts.length && i < 10; i += 1) {
      var p = x.parts[i];
      if (!p || typeof p.text !== 'string' || !p.text.trim()) return null;
      parts.push({ text: p.text.slice(0, 600), lang: p.lang === 'hi' ? 'hi' : 'en' });
    }
    return parts.length ? { id: x.id, parts: parts } : null;
  }

  /** What the browser's own voice says for a piece of text (when Google's voice is off or fails): no addresses, no markdown, the first few sentences. */
  function speakable(text) {
    var t = str(text, 4000);
    t = t.replace(/https?:\/\/\S+/gi, ' '); // addresses are not read out
    t = t.replace(/(^|\s)\/[A-Za-z0-9]\S*/g, '$1'); // nor are paths of this site (/materials#/p/teak)
    t = t.replace(/^\s*[-•·]\s+/gm, ''); // list bullets
    t = t.replace(/[*_`#>~|]+/g, ' '); // markdown marks
    t = t.replace(/\d{1,3}(?:,\d{2,3})+(?:\.\d+)?/g, function (m) { return m.replace(/,/g, ''); }); // 6,020 and 1,25,000 are read digit by digit; 6020 is not
    t = t.replace(/₹\s?(\d[\d,]*(?:\.\d+)?)/g, '$1 rupees').replace(/\bRs\.?\s?(\d[\d,]*(?:\.\d+)?)/gi, '$1 rupees');
    t = t.replace(/\bper\s+sq\.?\s?ft\b/gi, 'per square foot').replace(/\bper\s+sq\.?\s?m\b/gi, 'per square metre');
    t = t.replace(/\bsq\.?\s?ft\b/gi, 'square feet').replace(/\bsq\.?\s?m\b/gi, 'square metres').replace(/×/g, ' times ');
    t = t.replace(/[–—]/g, ', ').replace(/\s*\n+\s*/g, '. ').replace(/\s+/g, ' ').replace(/([.!?।])(\s*[.!?।])+/g, '$1').trim();
    if (!t) return [];
    var hindi = DEVANAGARI.test(t);
    t = t.replace(/(\d)\.(?=\d)/g, '$1\u0001'); // a point between digits (2.5, 1200.50) is not the end of a sentence
    var sentences = t.match(/[^.!?।]+(?:[.!?।]+|$)/g) || [t];
    var out = [], len = 0, cut = false;
    for (var i = 0; i < sentences.length; i += 1) {
      var sentence = sentences[i].trim();
      if (!sentence) continue;
      if (len + sentence.length > SPEECH_MAX_CHARS && out.length) { cut = true; break; }
      len += sentence.length + 1;
      while (sentence.length > 200) { // a very long sentence is said in pieces (some browsers stop a long utterance part-way)
        var at = sentence.lastIndexOf(', ', 200);
        if (at < 40) at = sentence.lastIndexOf(' ', 200);
        if (at < 40) at = 200;
        out.push(sentence.slice(0, at + 1).trim());
        sentence = sentence.slice(at + 1).trim();
      }
      if (sentence) out.push(sentence);
    }
    if (cut) out.push(hindi ? 'बाकी जानकारी आपकी स्क्रीन पर है।' : 'The rest is on your screen.');
    for (var k = 0; k < out.length; k += 1) out[k] = out[k].replace(/\u0001/g, '.');
    return out;
  }

  // ---- the browser's own voice (the fallback) ----
  function pickVoice(lang) {
    lang = lang === 'hi' ? 'hi' : 'en';
    if (voiceObjs[lang] !== undefined) return voiceObjs[lang];
    var list = [];
    try { list = window.speechSynthesis.getVoices() || []; } catch (e) { list = []; }
    var prefs = lang === 'hi' ? ['hi-in'] : ['en-in', 'en-gb', 'en-us', 'en-au'], best = null, bestScore = -1;
    for (var i = 0; i < list.length; i += 1) {
      var tag = String(list[i].lang || '').toLowerCase().replace('_', '-');
      var rank = prefs.indexOf(tag);
      if (rank < 0 && tag.indexOf(lang) !== 0) continue;
      var score = (rank < 0 ? 1 : 10 - rank) * 10 + (list[i].localService ? 0 : 3) + (/natural|neural|google|premium|enhanced/i.test(String(list[i].name || '')) ? 4 : 0);
      if (score > bestScore) { bestScore = score; best = list[i]; }
    }
    voiceObjs[lang] = best; // null: the browser's own default voice
    return best;
  }
  function hookVoices() {
    // the list of voices arrives after the page has loaded in some browsers: choose again when it does
    if (voicesHooked || !synthAvailable()) return;
    voicesHooked = true;
    try { window.speechSynthesis.addEventListener('voiceschanged', function () { voiceObjs = {}; }); } catch (e) { /* no event: the first list is used */ }
  }
  /** One piece in the browser's voice; calls advance() when it is said (or cannot be). Nothing from an older speech (a changed `mine`) goes on. */
  function speakPiece(piece, lang, mine, advance) {
    var u;
    try { u = new window.SpeechSynthesisUtterance(piece); } catch (e) { advance(); return; }
    var v = pickVoice(lang);
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = lang === 'hi' ? 'hi-IN' : 'en-IN';
    var moved = false;
    var step = function () { if (moved || mine !== speakGen) return; moved = true; clearTimeout(speakTimer); advance(); };
    u.onend = step;
    u.onerror = step;
    // a voice that never says it has finished must not hold the conversation: the time the words need, plus a margin
    speakTimer = setTimeout(step, Math.max(4000, piece.length * 140 + 3000));
    try { window.speechSynthesis.speak(u); } catch (e) { step(); }
  }
  /** Say the pieces one after the other in the browser's voice, then call done(). An interrupted or replaced speech never calls it. */
  function speakChunks(chunks, done, lang) {
    hookVoices();
    stopSpeaking(); // the old speech is replaced first: if the browser reports its cancelled piece at once, nothing continues it
    speakGen += 1;
    var mine = speakGen, i = 0;
    var finish = function () { speakGen += 1; done(); };
    if (!synthAvailable()) { finish(); return; }
    function next() {
      if (mine !== speakGen) return;
      if (i >= chunks.length) { finish(); return; }
      var piece = chunks[i];
      i += 1;
      speakPiece(piece, lang, mine, next);
    }
    next();
  }

  // ---- Google's voice: fetched pieces, played in order ----
  function silentWav() {
    // 0.1 s of silence (8 kHz, 8 bit, mono): played once inside the tap that starts a conversation, to unlock the player (iPhone Safari)
    var n = 800, bytes = new Uint8Array(44 + n), view = new DataView(bytes.buffer), i;
    var tag = function (at, text) { for (var k = 0; k < text.length; k += 1) bytes[at + k] = text.charCodeAt(k); };
    tag(0, 'RIFF'); view.setUint32(4, 36 + n, true); tag(8, 'WAVE'); tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
    tag(36, 'data'); view.setUint32(40, n, true);
    for (i = 0; i < n; i += 1) bytes[44 + i] = 128;
    return new Blob([bytes], { type: 'audio/wav' });
  }
  function unlockAudio() {
    if (!serverVoiceUsable()) return;
    try {
      if (!audioEl) audioEl = new window.Audio();
      if (!silenceUrl) silenceUrl = window.URL.createObjectURL(silentWav());
      audioEl.onended = null;
      audioEl.onerror = null;
      audioEl.src = silenceUrl;
      var p = audioEl.play();
      if (p && typeof p.catch === 'function') p.catch(function () { /* not allowed here: the browser's own voice is the fallback */ });
    } catch (e) { /* no audio here */ }
  }
  function stopAudio() {
    if (audioEl) {
      audioEl.onended = null; // set first: pausing or emptying the player must not look like "finished" or "failed"
      audioEl.onerror = null;
      try { audioEl.pause(); } catch (e) { /* nothing was playing */ }
    }
    if (audioUrl) { try { window.URL.revokeObjectURL(audioUrl); } catch (e) { /* already gone */ } audioUrl = ''; }
  }
  function abortFetches() {
    var list = speakFetches;
    speakFetches = [];
    for (var i = 0; i < list.length; i += 1) { try { list[i].abort(); } catch (e) { /* already finished */ } }
  }
  function fetchPiece(id, n) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    if (ctl) speakFetches.push(ctl);
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, FETCH_TIMEOUT);
    var p = fetch(SPEECH_URL + encodeURIComponent(id) + '&n=' + n, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        if (!r.ok) throw new Error('speech ' + r.status);
        return r.blob();
      })
      .then(function (b) {
        clearTimeout(timer);
        if (!b || b.size < 200) throw new Error('speech empty');
        return b;
      }, function (e) { clearTimeout(timer); throw e; });
    p.catch(function () { /* looked at when its turn to be played comes */ });
    return p;
  }
  /** Play one fetched piece; onEnd() when it is over, onFail() when the player could not play it. A replaced speech (a changed `mine`) calls neither. */
  function playBlob(blob, chars, mine, onEnd, onFail) {
    var over = false;
    var finish = function (ok) {
      if (over || mine !== speakGen) return;
      over = true;
      clearTimeout(speakTimer);
      stopAudio();
      (ok ? onEnd : onFail)();
    };
    try {
      if (!audioEl) audioEl = new window.Audio();
      stopAudio();
      audioUrl = window.URL.createObjectURL(blob);
      audioEl.onended = function () { finish(true); };
      audioEl.onerror = function () { finish(false); };
      audioEl.src = audioUrl;
      speakTimer = setTimeout(function () { finish(true); }, Math.max(8000, chars * 160 + 6000)); // a player that stalls must not hold the conversation
      var p = audioEl.play();
      if (p && typeof p.catch === 'function') p.catch(function () { finish(false); });
    } catch (e) { finish(false); }
  }
  /** Say the staged pieces in Google's voice, then call done(). A piece that fails is said by the browser's voice. */
  function speakParts(speech, done) {
    hookVoices();
    stopSpeaking();
    speakGen += 1;
    var mine = speakGen, i = 0, jobs = [];
    var job = function (k) { if (k < speech.parts.length && !jobs[k]) jobs[k] = fetchPiece(speech.id, k); return jobs[k]; };
    function next() {
      if (mine !== speakGen) return;
      if (i >= speech.parts.length) { speakGen += 1; done(); return; }
      var at = i;
      i += 1;
      var part = speech.parts[at];
      var first = job(at);
      job(at + 1); // the next piece is on its way while this one is played
      var fallback = function () {
        if (mine !== speakGen) return;
        if (synthAvailable()) speakPiece(part.text, part.lang, mine, next); else next();
      };
      first.then(function (blob) {
        if (mine !== speakGen) return; // late: Skip, End or a newer answer got here first
        playBlob(blob, part.text.length, mine, next, fallback);
      }, fallback);
    }
    next();
  }

  function primeSpeech() {
    // iPhone Safari lets sound start only inside a tap: say nothing, once, inside the tap that starts the conversation
    if (synthAvailable()) { try { var u = new window.SpeechSynthesisUtterance(' '); u.volume = 0; window.speechSynthesis.speak(u); } catch (e) { /* no speech here */ } }
    unlockAudio();
  }
  function stopSpeaking() {
    speakGen += 1; // whatever was waiting for the end of the speech is dropped
    clearTimeout(speakTimer);
    abortFetches();
    stopAudio();
    try { if (synthAvailable()) window.speechSynthesis.cancel(); } catch (e) { /* nothing was playing */ }
  }

  function setLiveStep(step) {
    liveStep = step;
    if (!liveEl) return;
    liveEl.hidden = !live;
    liveEl.setAttribute('data-step', live ? step : '');
    liveTextEl.textContent = step === 'listening' ? 'Listening… go ahead and speak' : step === 'thinking' ? 'Thinking…' : step === 'speaking' ? 'Speaking…' : '';
    liveSkipBtn.hidden = step !== 'speaking';
    talkBtn.setAttribute('aria-pressed', live ? 'true' : 'false');
    talkBtn.title = live ? 'End the live conversation' : 'Talk to TeruBot: speak, and hear the answer';
  }
  function listenLive() {
    if (!live || !isOpen || listening) return;
    if (busy) { setLiveStep('thinking'); return; } // an answer is still on its way: it brings us back here
    setLiveStep('listening');
    inputEl.value = '';
    autosize();
    startMic();
  }
  function startLive() {
    if (live || !talkAvailable()) return;
    if (blockedUntil > now()) return;
    if (status.known && status.aiOn === false) { micStatusEl.textContent = 'TeruBot’s AI is not set up on this site yet, so there is nobody to talk to for now.'; micStatusEl.hidden = false; return; }
    live = true;
    silentRuns = 0;
    micStatusEl.hidden = true;
    primeSpeech();
    if (busy) { setLiveStep('thinking'); return; }
    if (!state.msgs.length) { // a fresh chat: say hello, like picking up a call
      setLiveStep('speaking');
      var then = function () { setTimeout(listenLive, 300); };
      if (serverVoiceUsable()) speakParts({ id: 'hello', parts: [{ text: HELLO, lang: 'en' }] }, then);
      else speakChunks([HELLO], then, 'en');
    } else listenLive();
  }
  function endLive(message) {
    var was = live;
    live = false;
    abortMic();
    stopSpeaking();
    setLiveStep('');
    if (was && message && micStatusEl) { micStatusEl.textContent = message; micStatusEl.hidden = false; }
  }
  /** An answer has arrived: in a live conversation, say it, then listen again. */
  function afterReply(msg) {
    if (!live) return;
    var again = function () { setTimeout(listenLive, 300); }; // a moment after the voice stops, so the microphone does not hear its tail
    if (msg.speech && playerAvailable()) { setLiveStep('speaking'); speakParts(msg.speech, again); return; }
    var chunks = speakable(msg.text || (msg.cards && msg.cards.length ? 'I have put the options on your screen.' : ''));
    if (!chunks.length) { listenLive(); return; }
    setLiveStep('speaking');
    speakChunks(chunks, again, DEVANAGARI.test(chunks.join(' ')) ? 'hi' : 'en');
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
    talkBtn = el('button', 'tb-textbtn tb-talk');
    talkBtn.type = 'button';
    talkBtn.setAttribute('aria-pressed', 'false');
    talkBtn.title = 'Talk to TeruBot: speak, and hear the answer';
    talkBtn.appendChild(icon(ICON_WAVE));
    talkBtn.appendChild(el('span', null, 'Talk'));
    talkBtn.hidden = !talkAvailable(); // a page that forbids the microphone (the studio, the Finder) or a browser without speech has no Talk
    talkBtn.addEventListener('click', function () { if (live) endLive(); else startLive(); });
    head.appendChild(talkBtn);
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

    liveEl = el('div', 'tb-live');
    liveEl.hidden = true;
    liveEl.setAttribute('role', 'group');
    liveEl.setAttribute('aria-label', 'Live conversation');
    var orb = el('span', 'tb-live__orb');
    orb.setAttribute('aria-hidden', 'true');
    liveEl.appendChild(orb);
    liveTextEl = el('span', 'tb-live__text');
    liveEl.appendChild(liveTextEl);
    liveSkipBtn = el('button', 'tb-textbtn', 'Skip');
    liveSkipBtn.type = 'button';
    liveSkipBtn.hidden = true;
    liveSkipBtn.setAttribute('aria-label', 'Stop speaking and listen');
    liveSkipBtn.addEventListener('click', function () { if (!live) return; stopSpeaking(); listenLive(); });
    liveEl.appendChild(liveSkipBtn);
    var liveEnd = el('button', 'tb-textbtn', 'End');
    liveEnd.type = 'button';
    liveEnd.setAttribute('aria-label', 'End the live conversation');
    liveEnd.addEventListener('click', function () { endLive(); });
    liveEl.appendChild(liveEnd);
    panelEl.appendChild(liveEl);

    photoStripEl = el('div', 'tb-photo');
    photoStripEl.hidden = true;
    photoThumbEl = el('img', 'tb-photo__img');
    photoThumbEl.alt = '';
    photoThumbEl.hidden = true;
    photoStripEl.appendChild(photoThumbEl);
    photoLabelEl = el('span', 'tb-photo__label');
    photoLabelEl.setAttribute('role', 'status');
    photoStripEl.appendChild(photoLabelEl);
    [['Finder', 'Find similar materials in the Finder', function () { handOff('finder'); }], ['Studio', 'Use this photo in the Design Studio', function () { handOff('studio'); }], ['Remove', 'Remove the photo', function () { clearPhoto(); if (inputEl) inputEl.focus(); }]].forEach(function (b) {
      var btn = el('button', 'tb-textbtn', b[0]);
      btn.type = 'button';
      btn.title = b[1];
      btn.setAttribute('aria-label', b[1]);
      btn.hidden = true;
      btn.addEventListener('click', b[2]);
      photoStripEl.appendChild(btn);
    });
    panelEl.appendChild(photoStripEl);

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
    inputEl.addEventListener('paste', function (e) { var f = pickedFile(e); if (f) { e.preventDefault(); attachFile(f); } });
    panelEl.addEventListener('dragover', function (e) { if (e.dataTransfer && e.dataTransfer.types && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) e.preventDefault(); });
    panelEl.addEventListener('drop', function (e) { var f = pickedFile(e); if (f) { e.preventDefault(); attachFile(f); } });
    formEl.appendChild(inputEl);
    photoInputEl = el('input');
    photoInputEl.type = 'file';
    photoInputEl.accept = 'image/*';
    photoInputEl.hidden = true;
    photoInputEl.setAttribute('aria-hidden', 'true');
    photoInputEl.tabIndex = -1;
    photoInputEl.addEventListener('change', function () { var f = photoInputEl.files && photoInputEl.files[0]; photoInputEl.value = ''; if (f) attachFile(f); });
    formEl.appendChild(photoInputEl);
    attachBtn = el('button', 'tb-roundbtn tb-attachbtn');
    attachBtn.type = 'button';
    attachBtn.setAttribute('aria-label', 'Attach a photo');
    attachBtn.title = 'Attach a photo, or paste a link to one';
    attachBtn.appendChild(icon(ICON_CLIP));
    attachBtn.addEventListener('click', function () { photoInputEl.click(); });
    formEl.appendChild(attachBtn);
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
    setLiveStep('');

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
    endLive();
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
    endLive();
    abortMic();
    busy = false;
    state.msgs = [];
    state.resume = false;
    clearPhoto();
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
      // TeruBot sent the visitor to this page: the conversation is still open, except over a form (a flag left by an older page or a
      // second tab must not put the chat on top of the form either; the launcher is there and the conversation is kept)
      if (!isFormPage(window.location.pathname)) open();
    }
  }

  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden' && live) endLive(); });
  window.addEventListener('pagehide', function () { stopSpeaking(); });

  window.TeruBot = {
    open: function (opts) { open(opts); },
    close: function () { close(); },
    ask: function (text) { return ask(text); },
    isOpen: function () { return isOpen; }
  };

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
