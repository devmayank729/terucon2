/*
 * "Photos from your phone", the requester's side (server/capture/, site/capture/). On the Design Studio, Inspiration and Finder pages it adds a
 * launcher; its panel offers two ways to get photos taken by somebody holding a phone:
 *   1. a QR code to scan (the phone opens /capture, takes or chooses photos, labels them, says who and where it is, sends them),
 *   2. the same link sent to a WhatsApp number (the server sends it when the WhatsApp Business account is set up; otherwise the panel opens the
 *      requester's own WhatsApp with the message ready: wa.me).
 * Photos appear in the panel the moment they arrive (the panel asks the server every few seconds while a link is open) and a small pop-up says so on
 * any page. Each photo can be moved to the Design Studio, Inspiration or the Finder, downloaded or deleted.
 *
 * Built by this file (no markup to write), styled by capture.css. Everything is drawn with textContent: nothing that comes from a phone can become markup.
 * On a page that is not one of the three it draws no launcher; it only shows the pop-up, and only while this browser has a link open.
 * Plain script, no dependencies; the QR encoder (qrcode-generator.js, MIT) is loaded the first time a code is drawn.
 */
(function () {
  'use strict';
  if (window.TeruconCapture) return;
  var doc = document;
  var STORE_KEY = 'terucon.capture.v1';
  var HOME = { studio: '/design-studio', inspiration: '/inspiration', finder: '/finder' };
  var LABEL = { studio: 'Design Studio', inspiration: 'Inspiration', finder: 'Finder' };
  var BY_PATH = { '/design-studio': 'studio', '/studio': 'studio', '/swatchroom': 'studio', '/inspiration': 'inspiration', '/import': 'inspiration', '/finder': 'finder', '/point-to-find': 'finder' };
  var path = location.pathname.replace(/\/+$/, '') || '/';
  var service = BY_PATH[path] || null;
  var metaOff = doc.querySelector('meta[name="tc-capture"][content="off"]') || doc.documentElement.getAttribute('data-tc-capture') === 'off';
  if (metaOff) return;

  var state = {
    config: null,
    sessions: [],
    photos: [],
    offset: 0, // the server's clock minus this browser's
    cursor: 0, // createdAt of the newest photo this page has
    open: false,
    method: 'qr',
    busy: false,
    error: '',
    wa: null, // the last "send on WhatsApp" answer
    alertNote: '',
    confirm: '', // a photo or link id that is waiting for "Yes, delete"
    moving: '', // a photo id being handed to another page
    off: false, // the feature is off on this server, or nobody is signed in
    fresh: {}, // photo ids that arrived since the panel was last open
  };
  var refs = {};
  var timer = null;
  var failures = 0;
  var lastSignature = '';

  // ---------------------------------------------------------------------------------------------------------------- helpers
  function el(tag, props) {
    var node = doc.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (key) {
      var v = p[key];
      if (v === false || v === null || v === undefined) return;
      if (key === 'class') node.className = v;
      else if (key === 'text') node.textContent = v;
      else if (key.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(key.slice(2), v);
      else if (key === 'hidden' || key === 'disabled' || key === 'value' || key === 'checked') node[key] = v;
      else node.setAttribute(key, v === true ? '' : String(v));
    });
    for (var i = 2; i < arguments.length; i += 1) append(node, arguments[i]);
    return node;
  }
  function append(node, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) return child.forEach(function (c) { append(node, c); });
    node.appendChild(child && child.nodeType ? child : doc.createTextNode(String(child)));
  }
  var SVG = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    var node = doc.createElementNS(SVG, tag);
    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, String(attrs[k])); });
    return node;
  }
  var ICONS = {
    phone: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2',
    qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v6h-4M14 18v2',
    chat: 'M4 20l1.4-4.2A8 8 0 1 1 8.2 18.6L4 20zM9 11h6M9 14h4',
    check: 'M5 12.5 10 17.5 19 7.5',
    download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
    trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
    copy: 'M9 9h10v11H9zM5 15V4h10',
    arrow: 'M5 12h14M13 6l6 6-6 6',
    camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  };
  function icon(name, size) {
    var s = size || 20;
    var svg = svgEl('svg', { viewBox: '0 0 24 24', width: s, height: s, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' });
    svg.appendChild(svgEl('path', { d: ICONS[name] || ICONS.camera }));
    return svg;
  }

  function store() {
    try {
      var v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      return v && typeof v === 'object' ? v : null;
    } catch (e) {
      return null;
    }
  }
  function saveStore(patch) {
    var v = store() || {};
    Object.keys(patch).forEach(function (k) { v[k] = patch[k]; });
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(v));
    } catch (e) {
      // storage blocked: the pop-up may repeat on the next page, nothing else
    }
    return v;
  }

  function api(url, options) {
    var o = options || {};
    var init = { method: o.method || 'GET', credentials: 'same-origin', cache: 'no-store', headers: {} };
    if (o.json !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(o.json);
    } else if (init.method !== 'GET') {
      init.headers['Content-Type'] = 'application/json';
      if (init.method !== 'DELETE') init.body = '{}';
    }
    return fetch(url, init).then(
      function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok) {
            var e = (data && data.error) || {};
            throw { status: res.status, reason: e.reason || '', message: e.message || 'Something went wrong. Please try again.' };
          }
          return data;
        });
      },
      function () {
        throw { status: 0, reason: 'network', message: 'There is no connection right now.' };
      },
    );
  }

  function serverNow() { return Date.now() + state.offset; }
  function openLinks() { return state.sessions.filter(function (s) { return s.open && s.expiresAt > serverNow() && !s.closedAt; }); }
  function linkFor(svc) { return openLinks().filter(function (s) { return s.service === svc; })[0] || null; }
  function sessionById(id) { return state.sessions.filter(function (s) { return s.id === id; })[0] || null; }
  function ago(ms) {
    var secs = Math.max(0, Math.round((serverNow() - ms) / 1000));
    if (secs < 45) return 'just now';
    var mins = Math.round(secs / 60);
    if (mins < 60) return mins + ' min ago';
    var hours = Math.round(mins / 60);
    if (hours < 24) return hours + ' h ago';
    return Math.round(hours / 24) + ' d ago';
  }
  function left(ms) {
    var mins = Math.max(0, Math.round((ms - serverNow()) / 60000));
    if (mins < 1) return 'less than a minute';
    if (mins < 60) return mins + ' min';
    return Math.floor(mins / 60) + ' h ' + String(mins % 60).padStart(2, '0') + ' min';
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  // ---------------------------------------------------------------------------------------------------------------- the inbox
  function mergeInbox(data) {
    state.offset = data.now - Date.now();
    state.sessions = data.sessions;
    var known = {};
    state.photos.forEach(function (p) { known[p.id] = true; });
    var added = [];
    data.photos.forEach(function (p) {
      if (known[p.id]) return;
      state.photos.push(p);
      added.push(p);
    });
    state.photos.sort(function (a, b) { return a.createdAt - b.createdAt; });
    state.photos.forEach(function (p) { if (p.createdAt > state.cursor) state.cursor = p.createdAt; });
    return added;
  }

  function newest(list) { return list.reduce(function (m, p) { return Math.max(m, p.createdAt); }, 0); }
  function unseenCount() {
    var seen = (store() || {}).seen || 0;
    return state.photos.filter(function (p) { return p.createdAt > seen; }).length;
  }
  function markSeen() {
    var top = Math.max(newest(state.photos), (store() || {}).seen || 0);
    saveStore({ seen: top, toasted: Math.max(top, (store() || {}).toasted || 0) });
    state.fresh = {};
    paintBadge();
  }

  function poll() {
    clearTimeout(timer);
    return api('/api/capture/inbox' + (state.cursor ? '?after=' + state.cursor : '')).then(
      function (data) {
        failures = 0;
        var first = !(store() && store().init);
        var added = mergeInbox(data);
        if (first) {
          // the first time this browser meets the feature, what is already there is not news
          saveStore({ toasted: data.now, seen: data.now, init: true });
        } else {
          var toasted = (store() || {}).toasted || 0;
          var news = added.filter(function (p) { return p.createdAt > toasted; });
          if (news.length) {
            news.forEach(function (p) { state.fresh[p.id] = true; });
            if (state.open) markSeen();
            else toast(news);
            saveStore({ toasted: Math.max(toasted, newest(news)) });
          }
        }
        if (state.open) { renderGot(); updateStatus(); }
        paintBadge();
        schedule();
      },
      function (error) {
        if (error.status === 401 || error.status === 403 || error.reason === 'capture-off') {
          state.off = true;
          if (refs.launch) refs.launch.hidden = true;
          return;
        }
        failures += 1;
        schedule();
      },
    );
  }

  function wanted() {
    if (state.off) return false;
    if (openLinks().length || state.open) return true;
    var until = (store() || {}).watchUntil || 0;
    return until > Date.now();
  }
  function schedule() {
    clearTimeout(timer);
    if (!wanted()) return;
    var base = doc.hidden ? 20000 : openLinks().length ? 3000 : 15000;
    timer = setTimeout(poll, Math.min(60000, base * Math.pow(2, Math.min(failures, 4))));
  }
  doc.addEventListener('visibilitychange', function () {
    if (!doc.hidden && wanted()) poll();
  });

  // ---------------------------------------------------------------------------------------------------------------- the pop-up
  var toastTimer = null;
  function toast(news) {
    if (!refs.root) build();
    clearTimeout(toastTimer);
    if (refs.toast) refs.toast.remove();
    var last = news[news.length - 1];
    var session = sessionById(last.session);
    var who = (session && session.capturer && session.capturer.name) || 'someone';
    var where = LABEL[last.service] || 'Terucon';
    var tags = (last.tags || []).slice(0, 3).join(', ');
    var close = el('button', { type: 'button', class: 'cap-x', 'aria-label': 'Dismiss', onclick: function () { refs.toast.remove(); refs.toast = null; } }, '×');
    var view = el('button', { type: 'button', class: 'cap-btn', onclick: function () {
      if (refs.toast) refs.toast.remove();
      refs.toast = null;
      if (service) openPanel();
      else location.assign(HOME[last.service] + '?capture=1');
    } }, 'View');
    refs.toast = el('div', { class: 'cap-toast', role: 'status' }, el('div', { class: 'grow' }, el('b', {}, plural(news.length, 'new photo', 'new photos') + ' from ' + who), el('span', {}, 'For the ' + where + (tags ? ' · ' + tags : ''))), view, close);
    refs.root.appendChild(refs.toast);
    toastTimer = setTimeout(function () { if (refs.toast) { refs.toast.remove(); refs.toast = null; } }, 12000);
  }

  // ---------------------------------------------------------------------------------------------------------------- building
  function build() {
    if (refs.root) return;
    refs.root = el('div', { class: 'cap-root' + (service === 'studio' ? ' is-studio' : '') });
    doc.body.appendChild(refs.root);
    if (!service) return;
    refs.badge = el('span', { class: 'cap-badge', hidden: true });
    refs.launch = el('button', { type: 'button', class: 'cap-launch', 'aria-haspopup': 'dialog', onclick: openPanel }, icon('phone', 20), el('span', { class: 'cap-label' }, 'Photos from phone'), refs.badge);
    refs.launch.setAttribute('aria-label', 'Get photos from a phone');
    refs.root.appendChild(refs.launch);
    paintBadge();
  }

  function paintBadge() {
    if (!refs.badge) return;
    var n = state.open ? 0 : unseenCount();
    refs.badge.hidden = n === 0;
    refs.badge.textContent = n > 9 ? '9+' : String(n);
    if (refs.launch) refs.launch.setAttribute('aria-label', n ? 'Get photos from a phone (' + plural(n, 'new photo', 'new photos') + ')' : 'Get photos from a phone');
  }

  function openPanel() {
    if (state.open || !service) return;
    state.open = true;
    state.error = '';
    refs.root.classList.add('is-open');
    refs.scrim = el('div', { class: 'cap-scrim', onclick: closePanel });
    refs.get = el('section', { class: 'cap-sec', 'aria-label': 'Get photos' });
    refs.got = el('section', { class: 'cap-sec', 'aria-label': 'Photos that arrived', 'aria-live': 'polite' });
    refs.scroll = el('div', { class: 'cap-scroll' }, refs.get, refs.got);
    refs.panel = el('section', { class: 'cap-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cap-title', tabindex: '-1' },
      el('div', { class: 'cap-head' }, el('h2', { id: 'cap-title' }, 'Photos from your phone'), el('button', { type: 'button', class: 'cap-x', 'aria-label': 'Close', onclick: closePanel }, '×')),
      refs.scroll);
    refs.root.append(refs.scrim, refs.panel);
    refs.panel.addEventListener('keydown', trapKeys);
    doc.addEventListener('keydown', onEscape);
    renderGet();
    renderGot();
    // photos that arrived while the panel was shut are the news: start at them, not at the form above
    if (unseenCount() > 0) setTimeout(function () { if (refs.scroll && refs.got) refs.scroll.scrollTo({ top: Math.max(0, refs.got.offsetTop - 12), behavior: 'smooth' }); }, 80);
    markSeen();
    refs.panel.focus();
    // opening the panel makes sure the page knows what is there now
    poll();
    refs.tick = setInterval(updateStatus, 30000);
  }
  function closePanel() {
    if (!state.open) return;
    state.open = false;
    clearInterval(refs.tick);
    doc.removeEventListener('keydown', onEscape);
    refs.root.classList.remove('is-open');
    if (refs.panel) refs.panel.remove();
    if (refs.scrim) refs.scrim.remove();
    refs.panel = refs.scrim = null;
    if (refs.launch) refs.launch.focus();
    schedule();
  }
  function onEscape(event) {
    if (event.key === 'Escape') closePanel();
  }
  function trapKeys(event) {
    if (event.key !== 'Tab') return;
    var items = [].slice.call(refs.panel.querySelectorAll('button, a[href], input, textarea')).filter(function (n) { return !n.disabled && !n.hidden && n.offsetParent !== null; });
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    if (event.shiftKey && (doc.activeElement === first || doc.activeElement === refs.panel)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  // ---------------------------------------------------------------------------------------------------------------- "get photos"
  function say(text, tone) {
    return text ? el('p', { class: 'cap-note' + (tone ? ' ' + tone : ''), role: tone === 'bad' ? 'alert' : 'status' }, text) : null;
  }

  function createLink(method) {
    if (state.busy) return;
    state.busy = true;
    state.error = '';
    state.method = method;
    state.wa = null;
    renderGet();
    var note = refs.note ? refs.note.value : '';
    api('/api/capture/sessions', { method: 'POST', json: { service: service, note: note } }).then(
      function (data) {
        state.busy = false;
        state.sessions = [data.session].concat(state.sessions.filter(function (s) { return s.id !== data.session.id; }));
        state.config = Object.assign({}, state.config, { link: { ok: true, reachable: data.reachable } });
        // keep watching for the photos on other pages too, until the link ends
        saveStore({ watchUntil: data.session.expiresAt + (Date.now() - serverNow()) + 15 * 60000 });
        renderGet();
        updateStatus();
        schedule();
      },
      function (error) {
        state.busy = false;
        state.error = error.message;
        renderGet();
      },
    );
  }

  function endLink(session) {
    if (state.busy) return;
    state.busy = true;
    api('/api/capture/sessions/' + session.id + '/close', { method: 'POST' }).then(
      function () {
        state.busy = false;
        session.open = false;
        session.closedAt = Date.now();
        state.wa = null;
        renderGet();
        renderGot();
      },
      function (error) {
        state.busy = false;
        state.error = error.message;
        renderGet();
      },
    );
  }

  function copy(text, button) {
    var done = function () {
      var was = button.textContent;
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = was; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    var field = el('textarea', { 'aria-hidden': 'true', tabindex: '-1', class: 'cap-sr' });
    field.value = text;
    refs.root.appendChild(field);
    field.select();
    try {
      doc.execCommand('copy');
      done();
    } catch (e) {
      // the link is shown in the box above: it can be copied by hand
    }
    field.remove();
  }

  function drawQr(link, holder) {
    holder.replaceChildren(el('span', { class: 'cap-spin', role: 'status', 'aria-label': 'Making the code' }));
    return import('/brand/qrcode-generator.js').then(function (m) {
      var qr = m.qrcode(0, 'M');
      qr.addData(link);
      qr.make();
      var n = qr.getModuleCount();
      var quiet = 4;
      var size = n + quiet * 2;
      var svg = svgEl('svg', { viewBox: '0 0 ' + size + ' ' + size, role: 'img', 'aria-label': 'QR code. Scan it with the phone camera to open the photo page.', 'shape-rendering': 'crispEdges' });
      svg.appendChild(svgEl('rect', { width: size, height: size, fill: '#ffffff' }));
      var d = '';
      for (var r = 0; r < n; r += 1) {
        var c = 0;
        while (c < n) {
          if (!qr.isDark(r, c)) { c += 1; continue; }
          var start = c;
          while (c < n && qr.isDark(r, c)) c += 1;
          d += 'M' + (start + quiet) + ' ' + (r + quiet) + 'h' + (c - start) + 'v1h-' + (c - start) + 'z';
        }
      }
      svg.appendChild(svgEl('path', { d: d, fill: '#1a1109' }));
      holder.replaceChildren(svg);
    }).catch(function () {
      holder.replaceChildren(say('The code could not be drawn. Copy the link below and open it on the phone.', 'bad'));
    });
  }

  function sendWhatsApp(session) {
    var value = refs.phone.value.trim();
    if (!value) { refs.phone.focus(); return; }
    if (state.busy) return;
    state.busy = true;
    state.error = '';
    state.wa = null;
    renderGet(true);
    api('/api/capture/sessions/' + session.id + '/whatsapp', { method: 'POST', json: { phone: value } }).then(
      function (data) {
        state.busy = false;
        state.wa = data;
        state.waNumber = value;
        renderGet();
      },
      function (error) {
        state.busy = false;
        state.error = error.message;
        renderGet(true);
      },
    );
  }

  function saveAlert(session, phone) {
    if (state.busy) return;
    state.busy = true;
    state.alertNote = '';
    api('/api/capture/sessions/' + session.id + '/alert', { method: 'PUT', json: { phone: phone } }).then(
      function (data) {
        state.busy = false;
        session.alert = data.alert;
        state.alertNote = data.alert ? 'WhatsApp alerts go to ' + data.alert.to + '.' : 'WhatsApp alerts are off.';
        renderGet();
      },
      function (error) {
        state.busy = false;
        state.alertNote = error.message;
        renderGet();
      },
    );
  }

  function renderGet(keepFocus) {
    if (!refs.get) return;
    var link = linkFor(service);
    var kids = [];
    kids.push(el('h3', {}, link ? 'Your link' : 'Get photos'));
    if (state.error) kids.push(say(state.error, 'bad'));
    if (state.config && state.config.link && state.config.link.ok === false) {
      kids.push(say('This server has no public address set up for the phone link yet. Ask the site owner to set CAPTURE_PUBLIC_URL.', 'bad'));
    }

    if (!link) {
      refs.note = el('textarea', { class: 'cap-in', maxlength: '200', placeholder: 'For example: the front cabin, all four walls', 'aria-label': 'A note for the person taking the photos' });
      kids.push(
        el('p', { class: 'cap-p' }, 'Ask someone on site to take photos with their phone, or take them yourself. They land here, ready for the ', el('b', {}, LABEL[service]), ' and the other pages.'),
        el('label', { class: 'cap-field' }, 'A note for them (optional)', refs.note),
        el('div', { class: 'cap-ways' },
          el('button', { type: 'button', class: 'cap-way', disabled: state.busy, onclick: function () { createLink('qr'); } }, icon('qr', 26), el('span', {}, 'Show a QR code', el('br'), el('small', {}, 'Scan it with any phone camera'))),
          el('button', { type: 'button', class: 'cap-way', disabled: state.busy, onclick: function () { createLink('whatsapp'); } }, icon('chat', 26), el('span', {}, 'Send on WhatsApp', el('br'), el('small', {}, 'Type their number, send the link'))),
        ),
        state.busy ? el('div', { class: 'cap-wait' }, el('span', { class: 'cap-spin' }), 'Making your link…') : null,
        el('p', { class: 'cap-small' }, 'The link works for a limited time, takes a limited number of photos, and only adds photos: nobody who has it can see your project.'),
      );
      refs.get.replaceChildren.apply(refs.get, kids.filter(Boolean));
      return;
    }

    var tabs = el('div', { class: 'cap-tabs', role: 'group', 'aria-label': 'How to share the link' },
      el('button', { type: 'button', class: 'cap-tab', 'aria-pressed': state.method === 'qr' ? 'true' : 'false', onclick: function () { state.method = 'qr'; renderGet(); } }, 'QR code'),
      el('button', { type: 'button', class: 'cap-tab', 'aria-pressed': state.method === 'whatsapp' ? 'true' : 'false', onclick: function () { state.method = 'whatsapp'; renderGet(); } }, 'WhatsApp'));
    kids.push(tabs);

    if (state.method === 'qr') {
      var holder = el('div', { class: 'cap-qr' });
      var url = el('input', { class: 'cap-in cap-link', type: 'text', readonly: true, value: link.link, 'aria-label': 'The link to open on the phone' });
      var copyBtn = el('button', { type: 'button', class: 'cap-btn', onclick: function () { copy(link.link, copyBtn); } }, icon('copy', 18), 'Copy');
      kids.push(
        el('p', { class: 'cap-p' }, 'Point the phone’s camera at the code. The photo page opens in its browser: ', el('b', {}, 'no app to install'), '.'),
        holder,
        state.config && state.config.link && state.config.link.reachable === false ? say('This link starts with an address a phone cannot open (' + new URL(link.link).host + '). A phone can only open it on this same computer. Ask the site owner to set CAPTURE_PUBLIC_URL.', 'bad') : null,
        el('div', { class: 'cap-row' }, url, copyBtn),
      );
      refs.get.replaceChildren.apply(refs.get, kids.filter(Boolean));
      drawQr(link.link, holder);
    } else {
      refs.phone = el('input', { class: 'cap-in', type: 'tel', inputmode: 'tel', autocomplete: 'off', placeholder: '98765 43210', 'aria-label': 'The WhatsApp number to send the link to', value: state.waNumber || '' });
      refs.phone.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); sendWhatsApp(link); } });
      var serverSends = state.config && state.config.whatsapp && state.config.whatsapp.serverSends;
      var cc = (state.config && state.config.whatsapp && state.config.whatsapp.defaultCountryCode) || '91';
      kids.push(
        el('p', { class: 'cap-p' }, 'Type the WhatsApp number of the person who will take the photos. ', serverSends ? 'We send them the link.' : 'WhatsApp opens on your device with the message ready: you press send.'),
        el('div', { class: 'cap-row' }, el('span', { class: 'cap-in cap-prefix', style: null, 'aria-hidden': 'true' }, '+' + cc), refs.phone),
        el('button', { type: 'button', class: 'cap-btn solid', disabled: state.busy, onclick: function () { sendWhatsApp(link); } }, state.busy ? el('span', { class: 'cap-spin' }) : icon('chat', 18), serverSends ? 'Send the link' : 'Prepare the message'),
        el('p', { class: 'cap-small' }, 'No country code typed? +' + cc + ' is added. For another country, start with + and its code.'),
      );
      if (state.wa) {
        if (state.wa.mode === 'sent') kids.push(say('Sent to ' + state.wa.to + '. They get a WhatsApp message with the link. If it does not arrive, send it yourself:', 'good'));
        else kids.push(say('The message to ' + state.wa.to + ' is ready.', 'good'));
        kids.push(el('a', { class: 'cap-btn solid', href: state.wa.waLink, target: '_blank', rel: 'noopener noreferrer' }, icon('chat', 18), state.wa.mode === 'sent' ? 'Open WhatsApp instead' : 'Open WhatsApp and press send'));
      }
      refs.get.replaceChildren.apply(refs.get, kids.filter(Boolean));
      if (!keepFocus && !state.wa) refs.phone.focus();
    }

    // the status line, and the way to be told by WhatsApp
    refs.status = el('div', { class: 'cap-wait' });
    var tail = [refs.status];
    var alertsOn = state.config && state.config.whatsapp && state.config.whatsapp.alerts;
    if (alertsOn) {
      var alertIn = el('input', { class: 'cap-in', type: 'tel', inputmode: 'tel', autocomplete: 'off', placeholder: 'Your WhatsApp number', 'aria-label': 'Your WhatsApp number, to be told when a photo arrives' });
      tail.push(
        el('label', { class: 'cap-field' }, 'Also tell me on WhatsApp when a photo arrives', el('div', { class: 'cap-row' }, alertIn, el('button', { type: 'button', class: 'cap-btn', disabled: state.busy, onclick: function () { saveAlert(link, alertIn.value.trim()); } }, link.alert ? 'Change' : 'Save'))),
        link.alert ? el('p', { class: 'cap-small' }, 'Alerts go to ' + link.alert.to + (link.alert.status === 'failed' ? ' (the last one could not be delivered)' : '') + '. ', el('button', { type: 'button', class: 'cap-btn small', onclick: function () { saveAlert(link, ''); } }, 'Turn off')) : null,
        state.alertNote ? say(state.alertNote) : null,
      );
    } else if (state.config) {
      tail.push(el('p', { class: 'cap-small' }, 'Photos show up here the moment they are sent. WhatsApp alerts are not switched on for this site yet.'));
    }
    tail.push(el('button', { type: 'button', class: 'cap-btn small danger', disabled: state.busy, onclick: function () { endLink(link); } }, 'End this link now'));
    tail.forEach(function (n) { if (n) refs.get.appendChild(n); });
    updateStatus();
  }

  function updateStatus() {
    if (!refs.status || !state.open) return;
    var link = linkFor(service);
    if (!link) return;
    var got = state.photos.filter(function (p) { return p.session === link.id; }).length;
    refs.status.replaceChildren(
      el('span', { class: 'cap-dot' }),
      el('span', {}, got ? plural(got, 'photo', 'photos') + ' received · ' : 'Waiting for photos · ', 'link works for ' + left(link.expiresAt) + ' more'),
    );
  }

  // ---------------------------------------------------------------------------------------------------------------- "received"
  function signature() {
    return JSON.stringify([state.photos.map(function (p) { return p.id; }), state.sessions.map(function (s) { return [s.id, s.open, s.photoCount, s.capturer && s.capturer.name, s.capturer && s.capturer.location && s.capturer.location.at, s.capturer && s.capturer.phone, s.capturer && s.capturer.address, s.capturer && s.capturer.place]; }), state.confirm, state.moving, Object.keys(state.fresh)]);
  }

  function renderGot() {
    if (!refs.got) return;
    var sig = signature();
    if (sig === lastSignature && refs.got.childNodes.length) return;
    lastSignature = sig;
    var groups = {};
    state.photos.forEach(function (p) { (groups[p.session] = groups[p.session] || []).push(p); });
    var ids = Object.keys(groups).sort(function (a, b) {
      var sa = sessionById(a); var sb = sessionById(b);
      var here = (sb && sb.service === service ? 1 : 0) - (sa && sa.service === service ? 1 : 0);
      return here || newest(groups[b]) - newest(groups[a]);
    });
    var kids = [el('h3', {}, 'Photos received')];
    if (!ids.length) {
      kids.push(el('div', { class: 'cap-empty' }, el('p', { class: 'cap-p' }, 'Nothing yet. The moment someone sends photos, they appear here.')));
    }
    ids.forEach(function (id) { kids.push(group(sessionById(id), groups[id])); });
    refs.got.replaceChildren.apply(refs.got, kids);
  }

  function mapLink(location) {
    return 'https://www.google.com/maps?q=' + encodeURIComponent(location.lat + ',' + location.lng);
  }

  function group(session, photos) {
    var c = session && session.capturer;
    var who = el('div', { class: 'cap-who' });
    who.appendChild(el('b', {}, c ? c.name : 'Waiting for details'));
    var line = [session ? 'For the ' + LABEL[session.service] : '', plural(photos.length, 'photo', 'photos'), ago(newest(photos))].filter(Boolean).join(' · ');
    who.appendChild(el('span', {}, line));
    if (c) {
      if (c.phone) who.appendChild(el('span', {}, 'Phone: ', el('a', { href: 'tel:' + c.phone }, c.phone)));
      if (c.address) who.appendChild(el('span', {}, 'Address: ' + c.address));
      if (c.place) who.appendChild(el('span', {}, 'Place: ' + c.place));
      if (c.location) who.appendChild(el('span', {}, 'Location: ', el('a', { href: mapLink(c.location), target: '_blank', rel: 'noopener noreferrer' }, c.location.lat.toFixed(5) + ', ' + c.location.lng.toFixed(5)), c.location.accuracy !== null ? ' (within about ' + c.location.accuracy + ' m)' : '', ' · ' + ago(c.location.at)));
    }
    var grid = el('ul', { class: 'cap-grid' });
    photos.slice().reverse().forEach(function (p) { grid.appendChild(photo(p)); });
    var footer = [];
    if (session) {
      footer.push(state.confirm === session.id
        ? el('div', { class: 'cap-acts' }, el('span', { class: 'cap-small' }, 'Delete this link and all its photos?'), el('button', { type: 'button', class: 'cap-btn small danger', onclick: function () { remove('/api/capture/sessions/' + session.id, function () { state.photos = state.photos.filter(function (p) { return p.session !== session.id; }); state.sessions = state.sessions.filter(function (s) { return s.id !== session.id; }); }); } }, 'Yes, delete'), el('button', { type: 'button', class: 'cap-btn small', onclick: function () { state.confirm = ''; renderGot(); } }, 'Keep'))
        : el('div', { class: 'cap-acts' }, el('button', { type: 'button', class: 'cap-btn small', onclick: function () { state.confirm = session.id; renderGot(); } }, icon('trash', 16), 'Delete all of these')));
    }
    return el('div', { class: 'cap-group' }, who, grid, footer);
  }

  function photo(p) {
    var src = '/api/capture/photos/' + p.id + '/file';
    var actions = ['studio', 'inspiration', 'finder'].map(function (target) {
      return el('button', { type: 'button', class: 'cap-btn', disabled: state.moving === p.id, 'aria-label': 'Use this photo in the ' + LABEL[target], onclick: function () { useIn(p, target); } }, target === service ? 'Use here' : LABEL[target]);
    });
    var del = state.confirm === p.id
      ? [el('button', { type: 'button', class: 'cap-btn danger', onclick: function () { remove('/api/capture/photos/' + p.id, function () { state.photos = state.photos.filter(function (x) { return x.id !== p.id; }); }); } }, 'Yes, delete'), el('button', { type: 'button', class: 'cap-btn', onclick: function () { state.confirm = ''; renderGot(); } }, 'Keep')]
      : [el('a', { class: 'cap-btn', href: src + '?download=1', download: 'terucon-photo', 'aria-label': 'Download this photo' }, icon('download', 15)), el('button', { type: 'button', class: 'cap-btn', 'aria-label': 'Delete this photo', onclick: function () { state.confirm = p.id; renderGot(); } }, icon('trash', 15))];
    return el('li', { class: 'cap-photo' + (state.fresh[p.id] ? ' fresh' : '') },
      el('a', { class: 'cap-pic', href: src, target: '_blank', rel: 'noopener', 'aria-label': 'Open this photo' }, el('img', { src: src, alt: 'A photo sent from a phone' + (p.tags && p.tags.length ? ': ' + p.tags.join(', ') : ''), loading: 'lazy', decoding: 'async' })),
      p.tags && p.tags.length ? el('div', { class: 'cap-tags' }, p.tags.map(function (t) { return el('span', {}, t); })) : null,
      p.note ? el('p', {}, p.note) : null,
      state.moving === p.id ? el('div', { class: 'cap-wait' }, el('span', { class: 'cap-spin' }), 'Moving…') : null,
      el('div', { class: 'cap-acts' }, actions),
      el('div', { class: 'cap-acts' }, del),
    );
  }

  function remove(url, after) {
    api(url, { method: 'DELETE' }).then(
      function () {
        after();
        state.confirm = '';
        renderGot();
        renderGet();
        paintBadge();
      },
      function (error) {
        state.error = error.message;
        state.confirm = '';
        renderGet();
        renderGot();
      },
    );
  }

  // ---------------------------------------------------------------------------------------------------------------- moving a photo to a page
  /**
   * Hand a photo to a page. The three pages already accept a picture from outside: the Design Studio takes it through its own photo input,
   * exactly as if it had been chosen (the way site/inspiration/feed.js does), Inspiration through its import, and the Finder through the one-time
   * hand-over (site/inspiration/handoff.js) that the cropper uses. On the page the person is already on, nothing is reloaded where that can be avoided.
   */
  function useIn(p, target) {
    if (state.moving) return;
    state.moving = p.id;
    state.error = '';
    renderGot();
    fetch('/api/capture/photos/' + p.id + '/file', { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('The photo could not be loaded.');
        return res.blob();
      })
      .then(function (blob) {
        var file = new File([blob], 'terucon-photo.' + ({ 'image/png': 'png', 'image/webp': 'webp' }[blob.type] || 'jpg'), { type: blob.type, lastModified: Date.now() });
        if (target === service && target === 'studio') {
          var input = doc.querySelector('input[data-input="photo"]');
          if (input) {
            var transfer = new DataTransfer();
            transfer.items.add(file);
            input.files = transfer.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return 'here';
          }
        }
        if (target === service && target === 'inspiration' && window.TeruconImport && window.TeruconImport.start) {
          window.TeruconImport.start({ file: file });
          return 'here';
        }
        return import('/inspiration/assets/handoff.js').then(function (handoff) {
          return handoff.stash(blob, { name: file.name }).then(function (code) {
            location.assign(HOME[target] + '?import=' + code);
            return 'away';
          });
        });
      })
      .then(
        function (how) {
          state.moving = '';
          if (how === 'here') closePanel();
          else renderGot();
        },
        function (error) {
          state.moving = '';
          state.error = (error && error.message) || 'The photo could not be moved. Try again.';
          renderGet();
          renderGot();
        },
      );
  }

  // ---------------------------------------------------------------------------------------------------------------- start
  function start() {
    build();
    // /design-studio?capture=1 (a link from the pop-up on another page) opens the panel
    try {
      var params = new URLSearchParams(location.search);
      if (params.get('capture') === '1' && service) {
        params.delete('capture');
        var rest = params.toString();
        history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
        setTimeout(openPanel, 400);
      }
    } catch (e) {
      // an address that cannot be read: the launcher still works
    }
    api('/api/capture/config').then(
      function (config) {
        state.config = config;
        if (state.open) renderGet();
      },
      function (error) {
        if (error.reason === 'capture-off' || error.status === 401 || error.status === 403) {
          state.off = true;
          if (refs.launch) refs.launch.hidden = true;
        }
      },
    );
    // the first look at the inbox waits for the page's own work to settle, so it never competes with the studio's start
    var first = function () { if (wantedAtStart()) poll(); };
    if ('requestIdleCallback' in window) requestIdleCallback(first, { timeout: 2500 });
    else setTimeout(first, 1200);
  }
  function wantedAtStart() {
    if (state.off) return false;
    return Boolean(service) || ((store() || {}).watchUntil || 0) > Date.now();
  }

  window.TeruconCapture = Object.freeze({ open: function () { if (service) openPanel(); }, service: service });
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})();
