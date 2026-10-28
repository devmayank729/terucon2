/* The overview page. Everything on it is drawn from the JSON embedded in the page (#overview-data), which
   tools/build-overview.js writes from the real tree and docs/overview/catalog/*.json. Text from the data is only ever
   put into the page with textContent, never as HTML. */
(function () {
  'use strict';

  var DATA = JSON.parse(document.getElementById('overview-data').textContent);
  var LIVE = /^https?:$/.test(location.protocol);
  var SVGNS = 'http://www.w3.org/2000/svg';
  var NF = new Intl.NumberFormat('en-US');
  var root = document.documentElement;

  /* ------------------------------------------------------------------------------------------------ helpers */
  function el(tag, props) {
    var node = document.createElement(tag);
    apply(node, props, Array.prototype.slice.call(arguments, 2));
    return node;
  }
  function svg(tag, props) {
    var node = document.createElementNS(SVGNS, tag);
    apply(node, props, Array.prototype.slice.call(arguments, 2));
    return node;
  }
  function apply(node, props, kids) {
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'class') node.setAttribute('class', v);
        else if (k === 'text') node.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; });
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    add(node, kids);
  }
  function add(node, kids) {
    kids.forEach(function (c) {
      if (c === undefined || c === null || c === false) return;
      if (Array.isArray(c)) add(node, c);
      else node.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    });
  }
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  /* `code` spans in a sentence */
  function rich(text) {
    var frag = document.createDocumentFragment();
    String(text).split('`').forEach(function (part, i) {
      if (!part) return;
      frag.appendChild(i % 2 ? el('code', { text: part }) : document.createTextNode(part));
    });
    return frag;
  }
  function num(n) { return NF.format(n); }
  function bytes(n) {
    if (n === null || n === undefined) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function ownerLabel(id) { return (DATA.meta.owners[id] || {}).label || id; }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function announce(msg) {
    var r = $('#live-region');
    r.textContent = '';
    setTimeout(function () { r.textContent = msg; }, 30);
  }
  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* blocked */ } }
  function reducedMotion() { return window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; }

  /* copy to clipboard, with a fallback for pages without clipboard access (file://, headless) */
  function copyText(text, btn, label) {
    function done(ok) {
      if (!btn) return;
      var span = btn.querySelector('.lbl');
      btn.dataset.state = ok ? 'copied' : 'failed';
      if (span) {
        var old = btn.dataset.label || span.textContent;
        btn.dataset.label = old;
        span.textContent = ok ? 'Copied' : 'Select and copy';
      }
      announce(ok ? 'Copied ' + (label || text) : 'Could not copy automatically');
      clearTimeout(btn._t);
      btn._t = setTimeout(function () {
        btn.dataset.state = '';
        if (span) span.textContent = btn.dataset.label;
      }, 1700);
    }
    function fallback() {
      var ta = el('textarea', { 'aria-hidden': 'true', tabindex: '-1', style: 'position:fixed;left:-9999px;top:0;opacity:0' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      done(ok);
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    else fallback();
  }
  function copyButton(text, label, cls) {
    return el('button', { type: 'button', class: 'copy ' + (cls || ''), 'aria-label': 'Copy ' + (label || text), onclick: function (e) { copyText(text, e.currentTarget, label); } },
      icon('copy'), el('span', { class: 'lbl', text: 'Copy' }));
  }
  function icon(name) {
    var paths = {
      copy: 'M7 3.5h7a1.5 1.5 0 0 1 1.5 1.5v8M4.5 6.5h7A1.5 1.5 0 0 1 13 8v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 15V8a1.5 1.5 0 0 1 1.5-1.5z',
      caret: 'M7 4.5 12.5 10 7 15.5',
      play: 'M6.5 4.5v11l9-5.5z',
      pause: 'M6.5 4.5v11M13.5 4.5v11',
      prev: 'M12 4.5 6.5 10l5.5 5.5',
      next: 'M8 4.5 13.5 10 8 15.5',
      refresh: 'M16 10a6 6 0 1 1-1.9-4.4M16 3.5v3.3h-3.3',
      link: 'M8.5 11.5l3-3M7 9.5l-1.4 1.4a2.4 2.4 0 0 0 3.4 3.4L10.4 13M13 10.5l1.4-1.4A2.4 2.4 0 0 0 11 5.7L9.6 7.1',
      check: 'M4.5 10.5l3.5 3.5 7.5-8',
      cross: 'M5.5 5.5l9 9M14.5 5.5l-9 9',
      dash: 'M6 10h8',
      open: 'M8 4.5H5A1.5 1.5 0 0 0 3.5 6v9A1.5 1.5 0 0 0 5 16.5h9a1.5 1.5 0 0 0 1.5-1.5v-3M11 3.5h5.5V9M16.5 3.5 9 11'
    };
    var fill = name === 'play' ? 'currentColor' : 'none';
    return svg('svg', { viewBox: '0 0 20 20', width: 16, height: 16, 'aria-hidden': 'true', class: 'ico' },
      svg('path', { d: paths[name], fill: fill, stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  }
  function badge(text, cls, title) { return el('span', { class: 'badge ' + (cls || ''), text: text, title: title }); }
  function ownerChip(id) {
    return el('span', { class: 'owner o-' + id }, el('i', { class: 'od', 'aria-hidden': 'true' }), ownerLabel(id));
  }
  var LANG_CODE = { JavaScript: 'JS', Python: 'PY', JSON: 'JSON', HTML: 'HTML', CSS: 'CSS', Markdown: 'MD', Text: 'TXT', Media: 'MEDIA', Binary: 'BIN', Shell: 'SH' };
  function langBadge(lang) { return el('span', { class: 'lang l-' + slug(lang), title: lang, text: LANG_CODE[lang] || lang }); }

  /* ------------------------------------------------------------------------------------------------ tabs */
  var allTabs = [];
  /* ARIA tabs with automatic activation. tabs: [{id, label, count?, render(panel) | panel(node)}] */
  function Tabs(host, tabs, opts) {
    opts = opts || {};
    var uid = opts.id || 'tabs-' + Math.random().toString(36).slice(2, 7);
    var list = el('div', { class: 'tablist', role: 'tablist', 'aria-label': opts.label || 'Tabs' });
    var panels = [];
    var buttons = [];
    var current = -1;
    tabs.forEach(function (t, i) {
      var btn = el('button', { type: 'button', role: 'tab', id: uid + '-t-' + i, 'aria-controls': uid + '-p-' + i, 'aria-selected': 'false', tabindex: '-1', class: 'tab' },
        el('span', { text: t.label }), t.count !== undefined ? el('span', { class: 'tab-count', text: String(t.count) }) : null);
      btn.addEventListener('click', function () { select(i, true); });
      btn.addEventListener('keydown', function (e) {
        var n = tabs.length, to = -1;
        if (e.key === 'ArrowRight') to = (i + 1) % n;
        else if (e.key === 'ArrowLeft') to = (i - 1 + n) % n;
        else if (e.key === 'Home') to = 0;
        else if (e.key === 'End') to = n - 1;
        if (to > -1) { e.preventDefault(); select(to, true); }
      });
      var panel = el('div', { role: 'tabpanel', id: uid + '-p-' + i, 'aria-labelledby': uid + '-t-' + i, class: 'tabpanel', hidden: true, tabindex: '0' });
      panel.appendChild(el('h3', { class: 'print-title', text: t.label }));
      if (t.panel) panel.appendChild(t.panel);
      list.appendChild(btn);
      buttons.push(btn);
      panels.push(panel);
    });
    host.appendChild(list);
    panels.forEach(function (p) { host.appendChild(p); });
    var rendered = {};
    function select(i, focus) {
      if (i === current) { if (focus) buttons[i].focus(); return; }
      current = i;
      buttons.forEach(function (b, j) {
        var on = j === i;
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
        panels[j].hidden = !on;
      });
      if (!rendered[i] && tabs[i].render) { rendered[i] = true; tabs[i].render(panels[i]); }
      if (focus) buttons[i].focus();
      if (opts.onSelect) opts.onSelect(i, tabs[i]);
    }
    select(opts.initial || 0, false);
    /* printing shows every panel, so every panel has to be drawn */
    function renderAll() { tabs.forEach(function (t, i) { if (!rendered[i] && t.render) { rendered[i] = true; t.render(panels[i]); } }); }
    allTabs.push(renderAll);
    return { select: select, buttons: buttons, panels: panels, current: function () { return current; }, host: host, renderAll: renderAll };
  }

  /* ------------------------------------------------------------------------------------------------ theme */
  function effectiveTheme() {
    var t = root.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') return t;
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function paintThemeButton() {
    var dark = effectiveTheme() === 'dark';
    var b = $('#theme-toggle');
    b.setAttribute('aria-pressed', dark ? 'true' : 'false');
    b.setAttribute('aria-label', dark ? 'Dark theme is on. Switch to light.' : 'Light theme is on. Switch to dark.');
    $('#theme-label').textContent = dark ? 'Light' : 'Dark';
  }
  function toggleTheme() {
    var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    store('terucon-overview-theme', next);
    paintThemeButton();
    announce(next === 'dark' ? 'Dark theme' : 'Light theme');
  }
  function initTheme() {
    paintThemeButton();
    $('#theme-toggle').addEventListener('click', toggleTheme);
    if (window.matchMedia) {
      var mq = matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () { paintThemeButton(); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
    }
  }

  /* ------------------------------------------------------------------------------------------------ hero + live status */
  function renderHero() {
    var m = DATA.meta, s = DATA.stats;
    var host = clear($('#hero'));
    host.appendChild(el('p', { class: 'kicker', text: m.hero.eyebrow }));
    host.appendChild(el('h1', { id: 'h-status', text: m.hero.heading }));
    host.appendChild(el('p', { class: 'lead', text: m.hero.lead }));
    var facts = el('dl', { class: 'facts' });
    [
      [num(s.files), 'files'],
      [num(s.authoredLines), 'lines written by hand'],
      [num(s.routes), 'routes'],
      [num(s.tests), 'tests'],
      [num(s.envVars), 'settings'],
      [num(s.pages), 'pages']
    ].forEach(function (f) { facts.appendChild(el('div', null, el('dd', { text: f[0] }), el('dt', { text: f[1] }))); });
    host.appendChild(facts);
    host.appendChild(el('ul', { class: 'stack' }, m.hero.facts.map(function (f) {
      return el('li', null, el('b', { text: f.label }), el('span', { text: f.value }));
    })));
  }

  var live = { cells: {}, status: null, button: null, note: null, busy: false };
  function renderLiveShell() {
    var host = clear($('#live'));
    var head = el('div', { class: 'live-head' },
      el('h2', { id: 'h-live', class: 'live-title', text: 'Live status' }),
      el('div', { class: 'live-tools' },
        el('span', { class: 'live-when', id: 'live-when', 'aria-live': 'polite' }),
        live.button = el('button', { type: 'button', class: 'btn ghost', id: 'live-refresh', onclick: function () { checkLive(); } }, icon('refresh'), el('span', { class: 'lbl', text: 'Refresh' }))));
    var grid = el('div', { class: 'cells' });
    [['server', 'Server']].forEach(function (c) {
      var dot = el('span', { class: 'dot s-idle', 'aria-hidden': 'true' });
      var value = el('div', { class: 'cell-value', text: 'Not checked' });
      var detail = el('div', { class: 'cell-detail', text: '' });
      live.cells[c[0]] = { dot: dot, value: value, detail: detail };
      grid.appendChild(el('div', { class: 'cell', id: 'cell-' + c[0] }, dot, el('div', null, el('div', { class: 'cell-label', text: c[1] }), value, detail)));
    });
    live.note = el('p', { class: 'live-note', id: 'live-note' });
    host.appendChild(head);
    host.appendChild(grid);
    host.appendChild(live.note);
  }
  function setCell(name, state, value, detail) {
    var c = live.cells[name];
    c.dot.className = 'dot s-' + state;
    c.value.textContent = value;
    c.detail.textContent = detail || '';
    c.dot.parentNode.setAttribute('data-state', state);
  }
  function offline(reason) {
    ['server'].forEach(function (n) { setCell(n, 'idle', 'Not checked', ''); });
    live.note.textContent = 'Offline view. ' + reason;
    $('#live').setAttribute('data-mode', 'offline');
    $('#live-when').textContent = '';
  }
  function fetchJson(url, ms) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 4000);
    return fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error(url + ' answered ' + r.status);
      return r.json();
    }, function (e) { clearTimeout(timer); throw e; });
  }
  function checkLive() {
    if (!LIVE) { offline('This page was opened from a file, so it cannot ask a server. Start the website (npm start) and open /project-overview to see this strip fill in.'); return; }
    if (live.busy) return;
    live.busy = true;
    live.button.disabled = true;
    live.button.querySelector('.lbl').textContent = 'Checking';
    fetchJson('/api/health').catch(function (e) { return { __error: e }; }).then(function (health) {
      live.busy = false;
      live.button.disabled = false;
      live.button.querySelector('.lbl').textContent = 'Refresh';
      if (health.__error) {
        offline('This page is served, but /api/health did not answer, so there is no live data. Is the website running?');
        return;
      }
      $('#live').setAttribute('data-mode', 'live');
      $('#live-when').textContent = 'Checked ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setCell('server', health.ok ? 'ok' : 'bad', health.ok ? 'Up' : 'Not healthy', health.version ? 'version ' + health.version : '');
      live.note.textContent = 'Live data from this server (same origin). No secret is ever shown here.';
      announce('Live status updated');
    });
  }

  /* ------------------------------------------------------------------------------------------------ the diagram */
  function Diagram(host, opts) {
    opts = opts || {};
    var arch = DATA.architecture;
    var nodes = {};
    arch.nodes.forEach(function (n) { nodes[n.id] = n; });
    var children = {};
    arch.nodes.forEach(function (n) { if (n.parent) (children[n.parent] = children[n.parent] || []).push(n.id); });
    function family(id) { return [id].concat(children[id] || []); }

    var root = svg('svg', { class: 'dg', viewBox: '0 0 ' + arch.view.w + ' ' + arch.view.h, role: 'group', 'aria-label': 'Architecture diagram. ' + arch.nodes.length + ' parts; each can be opened.', preserveAspectRatio: 'xMidYMid meet' });
    var defs = svg('defs', null,
      marker('arr-n', 'arrow-n'), marker('arr-a', 'arrow-a'));
    root.appendChild(defs);
    function marker(id, cls) {
      return svg('marker', { id: (opts.prefix || 'd') + '-' + id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto' }, svg('path', { d: 'M0 0.8 10 5 0 9.2z', class: cls }));
    }
    var pfx = (opts.prefix || 'd') + '-';

    var layerContainers = svg('g', { class: 'layer-containers' });
    var layerEdges = svg('g', { class: 'layer-edges' });
    var layerNodes = svg('g', { class: 'layer-nodes' });
    root.appendChild(layerContainers);
    root.appendChild(layerNodes);
    root.appendChild(layerEdges);

    var nodeEls = {}, edgeEls = {};
    var pending = [];

    /* nodes */
    arch.nodes.forEach(function (n) {
      var cls = 'node k-' + n.kind + (n.optional ? ' optional' : '') + (n.container ? ' container' : '') + (n.parent ? ' child' : '');
      var g = svg('g', { class: cls, 'data-node': n.id, tabindex: opts.interactive === false ? null : '0', role: opts.interactive === false ? null : 'button',
        'aria-label': opts.interactive === false ? null : n.label + (n.sub ? ', ' + n.sub : '') + '. ' + (arch.kinds[n.kind] || '') + (n.optional ? ', optional' : '') + '. Press Enter for details.' });
      g.appendChild(svg('rect', { class: 'halo', x: n.x - 3, y: n.y - 3, width: n.w + 6, height: n.h + 6, rx: 12 }));
      g.appendChild(svg('rect', { class: 'box', x: n.x, y: n.y, width: n.w, height: n.h, rx: n.container ? 12 : 9 }));
      if (n.vertical) {
        var vt = svg('text', { class: 'lbl-v', x: n.x + n.w / 2, y: n.y + n.h / 2, transform: 'rotate(-90 ' + (n.x + n.w / 2) + ' ' + (n.y + n.h / 2) + ')', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
        vt.textContent = n.label.toUpperCase();
        g.appendChild(vt);
      } else if (n.container) {
        var t1 = svg('text', { class: 'lbl', x: n.x + 14, y: n.y + 26 }); t1.textContent = n.label;
        g.appendChild(t1);
        if (n.sub) {
          var t2 = svg('text', { class: 'sub', x: n.x + n.w - 14, y: n.y + 26, 'text-anchor': 'end' }); t2.textContent = n.sub;
          g.appendChild(t2);
          defer(t2, n.w * 0.34);
        }
        defer(t1, n.w * 0.6);
      } else {
        var two = !!n.sub;
        var a = svg('text', { class: 'lbl', x: n.x + 12, y: n.y + (two ? n.h / 2 - 3 : n.h / 2 + 4) }); a.textContent = n.label;
        g.appendChild(a); defer(a, n.w - 24);
        if (two) {
          var b = svg('text', { class: 'sub', x: n.x + 12, y: n.y + n.h / 2 + 13 }); b.textContent = n.sub;
          g.appendChild(b); defer(b, n.w - 24);
        }
        if (n.optional && n.w >= 170) { var o = svg('text', { class: 'opt', x: n.x + n.w - 10, y: n.y + 12, 'text-anchor': 'end' }); o.textContent = 'optional'; g.appendChild(o); } /* a narrower box has no room for the word; its dashed outline says it */
      }
      (n.container ? layerContainers : layerNodes).appendChild(g);
      nodeEls[n.id] = g;
      if (opts.interactive !== false) {
        g.addEventListener('mouseenter', function () { hover(n.id); });
        g.addEventListener('mouseleave', function () { hover(null); });
        g.addEventListener('focus', function () { hover(n.id); });
        g.addEventListener('blur', function () { hover(null); });
        g.addEventListener('click', function () { if (opts.onSelect) opts.onSelect(n.id); });
        g.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (opts.onSelect) opts.onSelect(n.id); } });
      }
    });

    function defer(t, max) { pending.push([t, max]); }
    function fit(t, max) {
      try {
        var w = t.getComputedTextLength();
        if (w > max && w > 0) t.style.fontSize = (parseFloat(getComputedStyle(t).fontSize) * max / w).toFixed(2) + 'px';
      } catch (e) { /* not laid out yet */ }
    }
    function fitAll() { pending.forEach(function (p) { fit(p[0], p[1]); }); }

    /* edges: spread the anchors that share one side of one node */
    var groups = {};
    arch.edges.forEach(function (e) {
      (groups[e.from + '|' + e.fromSide] = groups[e.from + '|' + e.fromSide] || []).push({ e: e, end: 'from' });
      (groups[e.to + '|' + e.toSide] = groups[e.to + '|' + e.toSide] || []).push({ e: e, end: 'to' });
    });
    var anchors = {};
    Object.keys(groups).forEach(function (key) {
      var parts = key.split('|'), n = nodes[parts[0]], side = parts[1], list = groups[key];
      list.sort(function (a, b) {
        var oa = nodes[a.end === 'from' ? a.e.to : a.e.from], ob = nodes[b.end === 'from' ? b.e.to : b.e.from];
        var ka = side === 't' || side === 'b' ? oa.x + oa.w / 2 : oa.y + oa.h / 2, kb = side === 't' || side === 'b' ? ob.x + ob.w / 2 : ob.y + ob.h / 2;
        return ka - kb;
      });
      list.forEach(function (item, i) {
        var f = (i + 1) / (list.length + 1), p;
        if (side === 'l') p = [n.x, n.y + n.h * f];
        else if (side === 'r') p = [n.x + n.w, n.y + n.h * f];
        else if (side === 't') p = [n.x + n.w * f, n.y];
        else p = [n.x + n.w * f, n.y + n.h];
        anchors[item.e.id + '|' + item.end] = p;
      });
    });
    var NORMAL = { l: [-1, 0], r: [1, 0], t: [0, -1], b: [0, 1] };
    arch.edges.forEach(function (e) {
      var p1 = anchors[e.id + '|from'], p2 = anchors[e.id + '|to'];
      var d1 = NORMAL[e.fromSide], d2 = NORMAL[e.toSide];
      var dist = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      var c = Math.max(26, Math.min(150, dist * 0.42));
      var c1 = [p1[0] + d1[0] * c, p1[1] + d1[1] * c], c2 = [p2[0] + d2[0] * c, p2[1] + d2[1] * c];
      var d = 'M' + p1.join(' ') + ' C' + c1.join(' ') + ' ' + c2.join(' ') + ' ' + p2.join(' ');
      var la = e.labelAt || {};
      var mid = bez(p1, c1, c2, p2, la.t === undefined ? 0.5 : la.t);
      var g = svg('g', { class: 'edge' + (e.dashed ? ' dashed' : '') + (e.always ? ' always' : ''), 'data-edge': e.id });
      var title = svg('title'); title.textContent = nodes[e.from].label + ' to ' + nodes[e.to].label + ': ' + e.label;
      g.appendChild(title);
      g.appendChild(svg('path', { class: 'line', d: d, 'marker-end': 'url(#' + pfx + 'arr-n)', fill: 'none' }));
      var lab = svg('g', { class: 'elabel' + (e.noLabel ? ' none' : '') });
      var txt = svg('text', { x: mid[0] + (la.dx || 0), y: mid[1] + 4 + (la.dy || 0), 'text-anchor': la.anchor || 'middle' }); txt.textContent = e.label;
      lab.appendChild(txt);
      g.appendChild(lab);
      layerEdges.appendChild(g);
      edgeEls[e.id] = g;
    });
    function bez(p0, p1, p2, p3, t) {
      var u = 1 - t;
      return [0, 1].map(function (i) { return u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i]; });
    }

    /* state: a persistent highlight (selection or flow step) and a transient hover */
    var base = { nodes: [], edges: [], neighbours: true };
    var hovering = null;
    function paint(state) {
      var on = {}, near = {}, eon = {};
      var any = state && (state.nodes.length || state.edges.length);
      (state ? state.nodes : []).forEach(function (id) { family(id).forEach(function (f) { on[f] = true; }); });
      (state ? state.edges : []).forEach(function (id) { eon[id] = true; });
      if (state && state.neighbours) {
        arch.edges.forEach(function (e) {
          var touches = on[e.from] || on[e.to];
          if (touches && state.nodes.length) { eon[e.id] = true; if (!on[e.from]) near[e.from] = true; if (!on[e.to]) near[e.to] = true; }
        });
      }
      root.classList.toggle('has-focus', !!any);
      Object.keys(nodeEls).forEach(function (id) {
        nodeEls[id].classList.toggle('is-on', !!on[id]);
        nodeEls[id].classList.toggle('is-near', !!near[id] && !on[id]);
      });
      Object.keys(edgeEls).forEach(function (id) {
        var isOn = !!eon[id];
        edgeEls[id].classList.toggle('is-on', isOn);
        edgeEls[id].querySelector('.line').setAttribute('marker-end', 'url(#' + pfx + (isOn ? 'arr-a' : 'arr-n') + ')');
        if (isOn) layerEdges.appendChild(edgeEls[id]);
      });
    }
    function hover(id) {
      hovering = id;
      paint(id ? { nodes: [id], edges: [], neighbours: true } : base);
    }
    function setActive(state) {
      base = { nodes: state.nodes || [], edges: state.edges || [], neighbours: !!state.neighbours };
      if (!hovering) paint(base);
      if (state.scrollTo !== false) scrollTo(base.nodes);
    }
    function scrollTo(ids) {
      var sc = host;
      if (!ids.length || sc.scrollWidth <= sc.clientWidth + 2) return;
      var xs = ids.map(function (i) { return nodes[i].x; }), xe = ids.map(function (i) { return nodes[i].x + nodes[i].w; });
      var mid = (Math.min.apply(null, xs) + Math.max.apply(null, xe)) / 2 / arch.view.w;
      var left = mid * root.getBoundingClientRect().width - sc.clientWidth / 2;
      sc.scrollTo({ left: Math.max(0, left), behavior: reducedMotion() ? 'auto' : 'smooth' });
    }

    host.appendChild(root);
    paint(base);
    requestAnimationFrame(fitAll);
    return { svg: root, setActive: setActive, nodes: nodeEls, edges: edgeEls, refit: fitAll };
  }

  /* ------------------------------------------------------------------------------------------------ section: architecture */
  var archDiagram;
  function renderArchitecture() {
    var host = clear($('#architecture-body'));
    var a = DATA.architecture;
    host.appendChild(el('p', { class: 'sec-lede' }, rich('The browser, the Express website with the Design Studio mounted in it, and the services around the studio, with the files and settings behind each part. Hover or focus a part to see what it talks to; click it, or press Enter, to open a side panel with its files, responsibilities and variables. Dashed outlines are optional.')));
    var wrap = el('div', { class: 'arch' });
    var scroll = el('div', { class: 'dg-scroll', tabindex: '-1' });
    var panel = el('aside', { class: 'panel', id: 'node-panel', role: 'complementary', 'aria-label': 'Part details', tabindex: '-1' });
    wrap.appendChild(el('div', { class: 'dg-wrap' }, scroll, legend()));
    host.appendChild(wrap);
    host.appendChild(panel);
    var selected = null, trigger = null;
    archDiagram = Diagram(scroll, { prefix: 'a', onSelect: function (id) { select(id, true); } });
    function select(id, fromDiagram) {
      var closing = selected === id || !id;
      if (!closing && fromDiagram) trigger = archDiagram.nodes[id];
      selected = closing ? null : id;
      archDiagram.setActive(selected ? { nodes: [selected], edges: [], neighbours: true, scrollTo: false } : {});
      panelFor(panel, selected, function () { select(null); });
      if (selected) {
        announce('Showing details for ' + a.nodes.filter(function (n) { return n.id === selected; })[0].label);
        panel.focus({ preventScroll: true });
      } else if (trigger) { trigger.focus({ preventScroll: true }); trigger = null; }
    }
    panelFor(panel, null);
    host.appendChild(el('div', { class: 'parts', role: 'group', 'aria-label': 'Parts of the system' },
      el('span', { class: 'parts-label', text: 'Parts' }),
      a.nodes.filter(function (n) { return !n.vertical; }).map(function (n) {
        return el('button', { type: 'button', class: 'chip part k-' + n.kind, onclick: function (e) { trigger = e.currentTarget; selected = null; select(n.id); }, 'aria-label': 'Details of ' + n.label }, n.label);
      })));
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && selected && !$('#kbd-dialog').open) select(null);
    });
  }
  function legend() {
    var k = DATA.architecture.kinds;
    return el('ul', { class: 'legend', 'aria-label': 'Legend' },
      ['client', 'server', 'service', 'data', 'external', 'tool'].map(function (id) {
        return el('li', null, el('span', { class: 'sw k-' + id, 'aria-hidden': 'true' }), k[id]);
      }),
      el('li', null, el('span', { class: 'sw optional', 'aria-hidden': 'true' }), 'Optional'));
  }
  function panelFor(panel, id, onClose) {
    clear(panel);
    var a = DATA.architecture;
    panel.classList.toggle('open', !!id);
    if (!id) return;
    var n = a.nodes.filter(function (x) { return x.id === id; })[0];
    var main = el('div', { class: 'panel-main' });
    var side = el('div', { class: 'panel-side' });
    main.appendChild(el('p', { class: 'kicker', text: a.kinds[n.kind] + (n.optional ? ' / optional' : '') }));
    main.appendChild(el('h3', { text: n.label }));
    main.appendChild(el('p', { class: 'panel-sum', text: n.summary }));
    if (n.responsibilities.length) {
      main.appendChild(el('h4', { text: 'Responsibilities' }));
      main.appendChild(el('ul', { class: 'bullets' }, n.responsibilities.map(function (r) { return el('li', { text: r }); })));
    }
    if (n.files.length) {
      side.appendChild(el('h4', { text: 'Files' }));
      side.appendChild(el('ul', { class: 'file-links' }, n.files.map(function (f) {
        return el('li', null, el('button', { type: 'button', class: 'linkish mono small', onclick: function () { onClose(); revealPath(f); } }, f));
      })));
    }
    if (n.env.length) {
      side.appendChild(el('h4', { text: 'Environment variables' }));
      side.appendChild(el('div', { class: 'chips' }, n.env.map(function (v) {
        return el('button', { type: 'button', class: 'chip mono', onclick: function () { onClose(); revealEnv(v); } }, v);
      })));
    }
    if (n.ports) {
      side.appendChild(el('h4', { text: 'Address' }));
      side.appendChild(el('p', { class: 'mono small', text: n.ports }));
    }
    var fam = [id].concat(a.nodes.filter(function (x) { return x.parent === id; }).map(function (x) { return x.id; }));
    var edges = a.edges.filter(function (e) { return fam.indexOf(e.from) > -1 || fam.indexOf(e.to) > -1; });
    var byId = {};
    a.nodes.forEach(function (x) { byId[x.id] = x; });
    if (edges.length) {
      side.appendChild(el('h4', { text: 'Connected to' }));
      side.appendChild(el('ul', { class: 'conn' }, edges.map(function (e) {
        var out = fam.indexOf(e.from) > -1;
        var other = byId[out ? e.to : e.from];
        return el('li', null, el('span', { class: 'arrow', 'aria-hidden': 'true', text: out ? '\u2192' : '\u2190' }),
          el('span', { class: 'sr-only', text: out ? 'to ' : 'from ' }), el('b', { text: other.label }), el('span', { class: 'muted', text: ' ' + e.label }));
      })));
    }
    panel.appendChild(el('button', { type: 'button', class: 'panel-close', 'aria-label': 'Close details', onclick: onClose }, icon('cross')));
    panel.appendChild(main);
    panel.appendChild(side);
  }

  /* ------------------------------------------------------------------------------------------------ section: flows */
  function renderFlows() {
    var host = clear($('#flows-body'));
    host.appendChild(el('p', { class: 'sec-lede', text: 'Pick a flow, then step through it. Each step lights up the parts and connections involved and names the file and function where it happens.' }));
    var flows = DATA.flows;
    var tabsHost = el('div', { class: 'flow-tabs' });
    host.appendChild(tabsHost);
    var players = [];
    var tabs = Tabs(tabsHost, flows.map(function (f, i) {
      return { id: f.id, label: f.title, render: function (panel) { players[i] = FlowPlayer(panel, f); } };
    }), { id: 'flow', label: 'Request flows', onSelect: function (i) { players.forEach(function (p, j) { if (p && j !== i) p.pause(); }); } });
    renderFlows.tabs = tabs;
  }
  function FlowPlayer(panel, flow) {
    var step = 0, timer = null;
    var uid = 'fp-' + flow.id;
    panel.appendChild(el('p', { class: 'flow-sum', text: flow.summary }));
    var layout = el('div', { class: 'flow', role: 'group', 'aria-label': flow.title + ', step by step', tabindex: '-1' });
    var dgHost = el('div', { class: 'dg-scroll flow-dg' });
    var card = el('div', { class: 'step-card', 'aria-live': 'polite' });
    var controls = el('div', { class: 'player-controls' });
    var prev = el('button', { type: 'button', class: 'btn', 'data-flow-prev': '', onclick: function () { go(step - 1, true); } }, icon('prev'), el('span', { class: 'lbl', text: 'Prev' }));
    var play = el('button', { type: 'button', class: 'btn primary', 'data-flow-play': '', 'aria-pressed': 'false', onclick: toggle }, icon('play'), el('span', { class: 'lbl', text: 'Play' }));
    var next = el('button', { type: 'button', class: 'btn', 'data-flow-next': '', onclick: function () { go(step + 1, true); } }, el('span', { class: 'lbl', text: 'Next' }), icon('next'));
    var count = el('span', { class: 'step-count', 'aria-hidden': 'true' });
    var bar = el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 1, 'aria-valuemax': flow.steps.length, 'aria-label': 'Step' }, el('i'));
    controls.appendChild(prev); controls.appendChild(play); controls.appendChild(next); controls.appendChild(count);
    var list = el('ol', { class: 'steps' }, flow.steps.map(function (s, i) {
      return el('li', null, el('button', { type: 'button', class: 'step-link', 'aria-current': 'false', onclick: function () { go(i, true); } },
        el('span', { class: 'sn', text: String(i + 1) }), el('span', { class: 'st', text: s.title }),
        el('span', { class: 'print-text', text: s.text + ' (' + s.file + (s.fn ? ', ' + s.fn : '') + ')' })));
    }));
    layout.appendChild(dgHost);
    layout.appendChild(controls);
    layout.appendChild(bar);
    layout.appendChild(el('div', { class: 'flow-bottom' }, card, el('nav', { class: 'steps-nav', 'aria-label': 'Steps of ' + flow.title }, list)));
    panel.appendChild(layout);
    var dg = Diagram(dgHost, { prefix: uid, interactive: false });
    layout.addEventListener('keydown', function (e) {
      if (e.target.closest && e.target.closest('input, textarea, select')) return;
      if (e.key === 'ArrowRight' && !e.target.closest('[role=tablist]')) { e.preventDefault(); go(step + 1, false); }
      else if (e.key === 'ArrowLeft' && !e.target.closest('[role=tablist]')) { e.preventDefault(); go(step - 1, false); }
    });
    function render() {
      var s = flow.steps[step];
      dg.setActive({ nodes: s.nodes, edges: s.edges, neighbours: false });
      count.textContent = 'Step ' + (step + 1) + ' of ' + flow.steps.length;
      bar.setAttribute('aria-valuenow', step + 1);
      bar.setAttribute('aria-valuetext', 'Step ' + (step + 1) + ' of ' + flow.steps.length);
      bar.firstChild.style.width = ((step + 1) / flow.steps.length * 100) + '%';
      prev.disabled = step === 0;
      next.disabled = step === flow.steps.length - 1;
      $$('.step-link', list).forEach(function (b, i) {
        b.setAttribute('aria-current', i === step ? 'step' : 'false');
        b.parentNode.classList.toggle('done', i < step);
      });
      clear(card);
      card.appendChild(el('p', { class: 'kicker', text: 'Step ' + (step + 1) }));
      card.appendChild(el('h3', { text: s.title }));
      card.appendChild(el('p', { text: s.text }));
      var meta = el('div', { class: 'step-meta' });
      meta.appendChild(el('span', { class: 'file-pill' },
        el('button', { type: 'button', class: 'linkish mono', onclick: function () { revealPath(s.file); }, title: 'Show in the file explorer' }, s.file),
        s.fn ? el('code', { class: 'fn', text: s.fn + (/^[A-Z]/.test(s.fn) ? '' : '()') }) : null));
      var edgeNames = (s.edges || []).map(function (id) { return DATA.architecture.edges.filter(function (e) { return e.id === id; })[0]; }).filter(Boolean);
      if (edgeNames.length) meta.appendChild(el('ul', { class: 'step-edges', 'aria-label': 'Connections used' }, edgeNames.map(function (e) { return el('li', { text: e.label }); })));
      card.appendChild(meta);
      var nodeNames = s.nodes.map(function (id) { return DATA.architecture.nodes.filter(function (n) { return n.id === id; })[0].label; });
      card.appendChild(el('p', { class: 'step-parts' }, el('span', { class: 'muted', text: 'Parts involved: ' }), nodeNames.join(', ')));
    }
    function go(i, focusCard) {
      step = Math.max(0, Math.min(flow.steps.length - 1, i));
      render();
      if (step === flow.steps.length - 1) pause();
    }
    function tick() {
      if (step >= flow.steps.length - 1) { pause(); return; }
      go(step + 1);
    }
    function start() {
      if (step >= flow.steps.length - 1) { step = 0; render(); }
      play.setAttribute('aria-pressed', 'true');
      setLabel('Pause', 'pause');
      timer = setInterval(tick, window.__overviewTickMs || 3400); /* the override is for the browser test */
    }
    function pause() {
      if (timer) { clearInterval(timer); timer = null; }
      play.setAttribute('aria-pressed', 'false');
      setLabel(step >= flow.steps.length - 1 ? 'Replay' : 'Play', 'play');
    }
    function setLabel(text, ico) {
      clear(play);
      play.appendChild(icon(ico)); play.appendChild(el('span', { class: 'lbl', text: text }));
    }
    function toggle() { if (timer) pause(); else start(); }
    render();
    return { pause: pause, go: go, el: layout };
  }

  /* ------------------------------------------------------------------------------------------------ section: pages */
  function pageHref(p) {
    if (LIVE) return p.route;
    return '../' + p.file;
  }
  function renderPages() {
    var host = clear($('#pages-body'));
    var site = DATA.site;
    host.appendChild(el('p', { class: 'sec-lede' }, rich('One file, `site/site.json`, defines the four pages: their routes, where each comes from, the redirects and the links every page must contain. Express serves from it, the build writes from it, and the link check reads it.')));
    var cards = el('div', { class: 'cards' });
    site.pages.forEach(function (p) {
      var head = el('div', { class: 'card-head' }, el('h3', { text: p.nav }), el('a', { class: 'route mono', href: pageHref(p), target: '_blank', rel: 'noopener', 'aria-label': 'Open ' + p.label + ' (' + p.route + ') in a new tab' }, p.route, icon('open')));
      var rows = el('dl', { class: 'kv' },
        row('Page', p.label),
        row('Source export', p.source, !p.sourceExists && 'missing'),
        row('Built file', p.file, !p.fileExists && 'not built yet'),
        row('Aliases', p.aliases.length ? p.aliases.join('   ') : 'none'),
        row('Headers', Object.keys(p.headers).length ? Object.keys(p.headers).map(function (k) { return k + ': ' + p.headers[k]; }).join('\n') : 'none'));
      cards.appendChild(el('article', { class: 'card page-card' }, head, el('p', { class: 'card-desc', text: p.description }), rows,
        el('p', { class: 'card-foot' }, el('a', { class: 'btn ghost', href: pageHref(p), target: '_blank', rel: 'noopener' }, icon('open'), el('span', { class: 'lbl', text: 'Open page' })))));
    });
    function row(k, v, flag) {
      return el('div', null, el('dt', { text: k }), el('dd', { class: k === 'Headers' || k === 'Aliases' || k.indexOf('Source') === 0 || k.indexOf('Built') === 0 ? 'mono small pre' : '' }, v, flag ? badge(flag, 'warn') : null));
    }
    host.appendChild(cards);

    var two = el('div', { class: 'two' });
    two.appendChild(matrixBlock(site));
    two.appendChild(redirectBlock(site));
    host.appendChild(two);
  }
  function matrixBlock(site) {
    var keys = site.pages.map(function (p) { return p.key; });
    var label = {};
    site.pages.forEach(function (p) { label[p.key] = p.nav; });
    var box = el('div', { class: 'block' });
    box.appendChild(el('h3', { text: 'Who links to whom' }));
    var measured = !!site.matrix;
    box.appendChild(el('p', { class: 'muted small', text: measured ? 'Read from the built pages by tools/check-links.js. Every required link is present when no cell is red.' : 'The built pages were not available, so this shows only what site.json requires.' }));
    var table = el('table', { class: 'matrix' });
    var thead = el('thead', null, el('tr', null, el('th', { scope: 'col', class: 'corner', text: 'From \\ to' }), keys.map(function (k) { return el('th', { scope: 'col', text: label[k] }); })));
    var tbody = el('tbody');
    keys.forEach(function (from) {
      var tr = el('tr', null, el('th', { scope: 'row', text: label[from] }));
      keys.forEach(function (to) {
        if (from === to) { tr.appendChild(el('td', { class: 'mx self', 'aria-label': label[from] + ' to itself: not applicable' }, '–')); return; }
        var cell = (site.matrix && site.matrix[from] && site.matrix[from][to]) || { linked: null, required: (site.connections[from] || []).indexOf(to) > -1 };
        var state, glyph, word;
        if (cell.linked === true) { state = cell.required ? 'ok' : 'extra'; glyph = 'check'; word = cell.required ? 'linked, required' : 'linked, not required'; }
        else if (cell.linked === false) { state = cell.required ? 'bad' : 'none'; glyph = cell.required ? 'cross' : 'dash'; word = cell.required ? 'missing, required' : 'not linked, not required'; }
        else { state = cell.required ? 'req' : 'none'; glyph = cell.required ? 'check' : 'dash'; word = cell.required ? 'required, not measured' : 'not required'; }
        tr.appendChild(el('td', { class: 'mx m-' + state, 'aria-label': label[from] + ' to ' + label[to] + ': ' + word, title: word }, icon(glyph), el('span', { class: 'mx-word', text: { ok: 'linked', extra: 'linked', bad: 'missing', none: '', req: 'required' }[state] })));
      });
      tbody.appendChild(tr);
    });
    table.appendChild(thead); table.appendChild(tbody);
    box.appendChild(el('div', { class: 'table-scroll' }, table));
    box.appendChild(el('ul', { class: 'legend small', 'aria-label': 'Legend' },
      el('li', null, el('span', { class: 'sw m-ok', 'aria-hidden': 'true' }), 'Linked, as required'),
      el('li', null, el('span', { class: 'sw m-bad', 'aria-hidden': 'true' }), 'Required but missing'),
      el('li', null, el('span', { class: 'sw m-extra', 'aria-hidden': 'true' }), 'Linked, not required'),
      el('li', null, el('span', { class: 'sw m-none', 'aria-hidden': 'true' }), 'Neither')));
    return box;
  }
  function redirectBlock(site) {
    var box = el('div', { class: 'block' });
    box.appendChild(el('h3', { text: 'Aliases and old names' }));
    box.appendChild(el('p', { class: 'muted small', text: 'Aliases answer 301 and point at the canonical route. Design-time names from the original exports answer 302. Names are compared decoded.' }));
    var rows = [];
    site.pages.forEach(function (p) { p.aliases.forEach(function (a) { rows.push([a, p.route, '301', 'alias']); }); });
    Object.keys(site.legacy).forEach(function (n) {
      var p = site.pages.filter(function (x) { return x.key === site.legacy[n]; })[0];
      rows.push(['/' + n, p ? p.route : '?', '302', 'design-time name']);
    });
    Object.keys(site.docs).forEach(function (k) {
      var d = site.docs[k];
      (d.aliases || []).forEach(function (a) { rows.push([a, d.route, '301', 'alias']); });
    });
    var table = el('table', { class: 'plain' },
      el('thead', null, el('tr', null, ['Address', 'Goes to', 'Code', 'Kind'].map(function (h) { return el('th', { scope: 'col', text: h }); }))),
      el('tbody', null, rows.map(function (r) { return el('tr', null, el('td', { class: 'mono small', text: r[0] }), el('td', { class: 'mono small', text: r[1] }), el('td', null, badge(r[2], r[2] === '301' ? 'perm' : 'temp')), el('td', { class: 'small', text: r[3] })); })));
    box.appendChild(el('div', { class: 'table-scroll' }, table));
    return box;
  }

  /* ------------------------------------------------------------------------------------------------ section: API */
  function renderApi() {
    var host = clear($('#api-body'));
    var api = DATA.api;
    host.appendChild(el('p', { class: 'sec-lede', text: api.intro }));
    var q = { text: '', owner: 'all', method: 'all', guard: 'all' };
    var guards = [];
    api.routes.forEach(function (r) { r.guards.forEach(function (g) { if (guards.indexOf(g) < 0) guards.push(g); }); });

    var bar = el('div', { class: 'toolbar', role: 'search' });
    var search = el('input', { type: 'search', id: 'api-search', class: 'input', placeholder: 'Filter routes, e.g. warmup, health, 404', 'aria-label': 'Filter routes' });
    bar.appendChild(el('label', { class: 'field grow' }, el('span', { class: 'sr-only', text: 'Filter routes' }), search));
    // an owner is offered only when some route has it (today every route is Express's)
    var owners = [['all', 'All'], ['JS', 'Express (JS)']].concat(api.routes.some(function (r) { return r.owner === 'Python'; }) ? [['Python', 'Python']] : []);
    bar.appendChild(segmented('Owner', 'api-owner', owners, function (v) { q.owner = v; apply2(); }));
    bar.appendChild(segmented('Method', 'api-method', [['all', 'Any'], ['GET', 'GET'], ['POST', 'POST']], function (v) { q.method = v; apply2(); }));
    var gsel = el('select', { id: 'api-guard', class: 'input select', 'aria-label': 'Guard' }, el('option', { value: 'all', text: 'Any guard' }), guards.map(function (g) { return el('option', { value: g, text: g }); }));
    gsel.addEventListener('change', function () { q.guard = gsel.value; apply2(); });
    bar.appendChild(gsel);
    host.appendChild(bar);
    var status = el('p', { class: 'count', id: 'api-count', 'aria-live': 'polite' });
    host.appendChild(status);

    var groupEls = [];
    api.groups.forEach(function (g) {
      var routes = api.routes.filter(function (r) { return r.group === g.id; });
      if (!routes.length) return;
      var sec = el('section', { class: 'api-group', 'aria-labelledby': 'api-g-' + g.id }, el('h3', { id: 'api-g-' + g.id, text: g.title }), el('p', { class: 'muted small', text: g.blurb }));
      var table = el('table', { class: 'api' },
        el('thead', null, el('tr', null, ['Method', 'Path', 'Owner', 'Guards', 'What it does', ''].map(function (h, i) { return el('th', { scope: 'col', class: i === 5 ? 'sr-only-col' : '', text: h }); }))));
      var body = el('tbody');
      var rowsEls = routes.map(function (r, i) { return routeRow(r, g.id + '-' + i, body); });
      table.appendChild(body);
      sec.appendChild(el('div', { class: 'table-scroll' }, table));
      host.appendChild(sec);
      groupEls.push({ sec: sec, rows: rowsEls });
    });
    host.appendChild(el('details', { class: 'errshape' }, el('summary', { text: 'The error shape' }),
      el('p', { class: 'small' }, rich('Every JSON error from the website\'s own API looks like this. `status` is a Google-style name; `message` is written for a person. (The Design Studio\'s own API, behind its passcode, answers with its own `{error: "..."}`.)')),
      el('pre', { class: 'code' }, el('code', { text: api.errorShape || '' }))));

    search.addEventListener('input', function () { q.text = search.value.trim().toLowerCase(); apply2(); });
    function apply2() {
      var shown = 0, total = 0;
      groupEls.forEach(function (g) {
        var any = 0;
        g.rows.forEach(function (r) {
          total++;
          var d = r.data;
          var ok = (q.owner === 'all' || d.owner === q.owner) && (q.method === 'all' || d.method === q.method) && (q.guard === 'all' || d.guards.indexOf(q.guard) > -1) &&
            (!q.text || r.hay.indexOf(q.text) > -1);
          r.tr.hidden = !ok;
          r.detail.hidden = !ok || r.btn.getAttribute('aria-expanded') !== 'true';
          if (ok) { any++; shown++; }
        });
        g.sec.hidden = any === 0;
      });
      status.textContent = shown === total ? total + ' routes' : shown + ' of ' + total + ' routes';
    }
    apply2();
  }
  function segmented(label, id, options, onChange) {
    var g = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': label, id: id });
    var btns = options.map(function (o, i) {
      var b = el('button', { type: 'button', role: 'radio', 'aria-checked': i === 0 ? 'true' : 'false', tabindex: i === 0 ? '0' : '-1', 'data-value': o[0], class: 'seg-btn', text: o[1] });
      b.addEventListener('click', function () { choose(i); });
      b.addEventListener('keydown', function (e) {
        var to = -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = (i + 1) % btns.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = (i - 1 + btns.length) % btns.length;
        if (to > -1) { e.preventDefault(); choose(to); btns[to].focus(); }
      });
      return b;
    });
    function choose(i) {
      btns.forEach(function (b, j) { b.setAttribute('aria-checked', j === i ? 'true' : 'false'); b.tabIndex = j === i ? 0 : -1; });
      onChange(options[i][0]);
    }
    btns.forEach(function (b) { g.appendChild(b); });
    return el('div', { class: 'seg-wrap' }, el('span', { class: 'seg-label', text: label }), g);
  }
  function routeRow(r, uid, body) {
    var detailId = 'api-d-' + uid;
    var path = r.display || r.path;
    var btn = el('button', { type: 'button', class: 'row-toggle', 'aria-expanded': 'false', 'aria-controls': detailId, 'aria-label': 'Details of ' + r.method + ' ' + path }, icon('caret'));
    var tr = el('tr', { class: 'route-row' },
      el('td', null, el('span', { class: 'method m-' + r.method.toLowerCase(), text: r.method })),
      el('td', { class: 'mono path' }, el('span', { text: path }), r.verified === true ? el('span', { class: 'verified', title: 'Registered by the running app, checked when this page was built' }, icon('check'), el('span', { class: 'sr-only', text: 'verified' })) : null),
      el('td', null, el('span', { class: 'owner-tag ' + (r.owner === 'JS' ? 'js' : 'py'), text: r.owner === 'JS' ? 'Express' : 'Python', title: r.owner === 'JS' ? 'Registered by app.js' : 'Internal model service' })),
      el('td', null, el('div', { class: 'chips tight' }, r.guards.map(function (g) { return el('span', { class: 'chip static', text: g }); }))),
      el('td', { class: 'summary', text: r.summary }),
      el('td', { class: 'tog' }, btn));
    var detail = el('tr', { class: 'detail', id: detailId, hidden: true });
    var cell = el('td', { colspan: 6 });
    detail.appendChild(cell);
    function fill() {
      clear(cell);
      var inner = el('div', { class: 'detail-grid' });
      inner.appendChild(el('div', null, el('h4', { text: 'Request' }), el('p', { class: 'small', text: r.request })));
      inner.appendChild(el('div', null, el('h4', { text: 'Response' }), el('p', { class: 'small', text: r.response })));
      if (r.errors && r.errors.length) inner.appendChild(el('div', null, el('h4', { text: 'Errors' }), el('ul', { class: 'errs' }, r.errors.map(function (e) { return el('li', null, el('b', { class: 'mono', text: String(e.status) }), ' ' + e.when); }))));
      var curl = el('div', { class: 'curl' }, el('h4', { text: 'Example' }), el('div', { class: 'cmd' }, el('code', { class: 'mono', text: r.curl }), copyButton(r.curl, 'the curl command for ' + r.method + ' ' + path)));
      inner.appendChild(curl);
      if (r.tryIt) {
        var out = el('pre', { class: 'code try-out', 'aria-live': 'polite', hidden: true });
        var meta = el('p', { class: 'small muted try-meta' });
        var tryBtn = el('button', { type: 'button', class: 'btn', 'data-try': r.path, disabled: !LIVE, onclick: function () {
          tryBtn.disabled = true; meta.textContent = 'Asking ' + r.path + ' …';
          var t0 = performance.now();
          fetch(r.path, { cache: 'no-store' }).then(function (res) {
            return res.text().then(function (txt) {
              var ms = Math.round(performance.now() - t0);
              var pretty = txt;
              try { pretty = JSON.stringify(JSON.parse(txt), null, 2); } catch (e) { /* not JSON */ }
              out.hidden = false;
              out.textContent = pretty.length > 6000 ? pretty.slice(0, 6000) + '\n… (' + num(pretty.length - 6000) + ' more characters)' : pretty;
              meta.textContent = res.status + ' ' + res.statusText + ', ' + ms + ' ms, ' + (res.headers.get('content-type') || '');
            });
          }).catch(function (e) {
            out.hidden = true; meta.textContent = 'No answer: ' + (e && e.message || e);
          }).then(function () { tryBtn.disabled = false; });
        } }, icon('play'), el('span', { class: 'lbl', text: 'Try it' }));
        inner.appendChild(el('div', { class: 'try' }, el('h4', { text: 'Try it' }), LIVE ? el('p', { class: 'small muted', text: 'Calls this server from your browser.' }) : el('p', { class: 'small muted', text: 'Open this page through the running website (/project-overview) to call it live.' }), tryBtn, meta, out));
      }
      cell.appendChild(inner);
    }
    var hay = [r.method, path, r.owner, r.guards.join(' '), r.summary, r.request, r.response, (r.errors || []).map(function (e) { return e.status + ' ' + e.when; }).join(' ')].join(' ').toLowerCase();
    btn.addEventListener('click', function () {
      var open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open && !cell.firstChild) fill();
      detail.hidden = !open;
      tr.classList.toggle('open', open);
    });
    body.appendChild(tr);
    body.appendChild(detail);
    return { tr: tr, detail: detail, btn: btn, data: r, hay: hay };
  }

  /* ------------------------------------------------------------------------------------------------ section: configuration */
  var envRows = {};
  function renderConfig() {
    var host = clear($('#config-body'));
    var env = DATA.env;
    host.appendChild(el('p', { class: 'sec-lede' }, rich('Both programs read the same settings. `.env.example` documents every one of them; this table is checked against it.')));

    var prec = el('div', { class: 'prec' });
    prec.appendChild(el('h3', { text: 'Which value wins' }));
    prec.appendChild(el('p', { class: 'muted', text: env.precedence.intro }));
    prec.appendChild(el('ol', { class: 'prec-steps' }, env.precedence.steps.map(function (s, i) {
      return el('li', null, el('span', { class: 'pn', 'aria-hidden': 'true', text: String(i + 1) }), el('div', null, el('b', { text: s.title }), el('p', { class: 'small', text: s.text })));
    })));
    prec.appendChild(el('p', { class: 'note' }, el('b', { text: 'TERUCON_ENV_FILE. ' }), env.precedence.envFileNote));
    host.appendChild(prec);

    var q = { text: '', reader: 'all', secret: false };
    var bar = el('div', { class: 'toolbar', role: 'search' });
    var search = el('input', { type: 'search', id: 'env-search', class: 'input', placeholder: 'Search variables, e.g. port, studio, host', 'aria-label': 'Search variables' });
    bar.appendChild(el('label', { class: 'field grow' }, el('span', { class: 'sr-only', text: 'Search variables' }), search));
    // a reader is offered only when some variable has it (today Node reads them all)
    var readers = [['all', 'All'], ['Node', 'Node']].concat(['Python', 'both'].filter(function (r) { return env.vars.some(function (v) { return v.readBy === r; }); }).map(function (r) { return [r, r === 'both' ? 'Both' : r]; }));
    bar.appendChild(segmented('Read by', 'env-reader', readers, function (v) { q.reader = v; run(); }));
    var sec = el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'env-secret' }), el('span', { text: 'Secrets only' }));
    bar.appendChild(sec);
    host.appendChild(bar);
    var count = el('p', { class: 'count', id: 'env-count', 'aria-live': 'polite' });
    host.appendChild(count);
    var groups = [];
    env.groups.forEach(function (g) {
      var vars = env.vars.filter(function (v) { return v.group === g.id; });
      if (!vars.length) return;
      var secEl = el('section', { class: 'env-group', 'aria-labelledby': 'env-g-' + g.id }, el('h3', { id: 'env-g-' + g.id, text: g.title }), el('p', { class: 'muted small', text: g.blurb }));
      var list = el('div', { class: 'vars' });
      var rows = vars.map(function (v) {
        var node = el('article', { class: 'var', id: 'var-' + v.name },
          el('div', { class: 'var-name' }, el('code', { class: 'mono', text: v.name }), copyButton(v.name, v.name, 'mini')),
          el('div', { class: 'var-badges' }, badge({ Node: 'Node', Python: 'Python', both: 'Node + Python' }[v.readBy], 'read r-' + v.readBy, 'Read by ' + v.readBy), v.secret ? badge('Secret', 'secret', 'Never sent to the browser or logged') : null),
          el('div', { class: 'var-default' }, el('span', { class: 'k', text: 'Default' }), el('code', { class: 'mono small', text: v.default })),
          el('p', { class: 'var-effect' }, v.effect, v.aliases && v.aliases.length ? el('span', { class: 'aliases' }, ' Also read as ', v.aliases.map(function (a, i) { return [i ? ', ' : '', el('code', { text: a })]; })) : null,
            v.notInExample ? el('span', { class: 'aliases' }, ' Not in .env.example: ' + v.notInExample + '.') : null));
        list.appendChild(node);
        var hay = [v.name, (v.aliases || []).join(' '), v.group, v.default, v.readBy, v.effect, v.secret ? 'secret' : ''].join(' ').toLowerCase();
        envRows[v.name] = node;
        return { node: node, v: v, hay: hay };
      });
      secEl.appendChild(list);
      host.appendChild(secEl);
      groups.push({ sec: secEl, rows: rows });
    });
    function run() {
      var shown = 0, total = 0;
      groups.forEach(function (g) {
        var any = 0;
        g.rows.forEach(function (r) {
          total++;
          var ok = (!q.text || r.hay.indexOf(q.text) > -1) && (q.reader === 'all' || r.v.readBy === q.reader || (q.reader !== 'both' && r.v.readBy === 'both')) && (!q.secret || r.v.secret);
          r.node.hidden = !ok;
          if (ok) { any++; shown++; }
        });
        g.sec.hidden = !any;
      });
      count.textContent = shown === total ? total + ' variables' : shown + ' of ' + total + ' variables';
    }
    search.addEventListener('input', function () { q.text = search.value.trim().toLowerCase(); run(); });
    $('input', sec).addEventListener('change', function (e) { q.secret = e.target.checked; run(); });
    run();
    host.appendChild(el('ul', { class: 'bullets muted small' }, env.notes.map(function (n) { return el('li', { text: n }); })));
    renderConfig.search = search;
    renderConfig.reset = function () { search.value = ''; q.text = ''; run(); };
  }
  function revealEnv(name) {
    var node = envRows[name];
    if (!node) return;
    if (node.hidden) { renderConfig.reset(); }
    node.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
    node.classList.add('flash');
    setTimeout(function () { node.classList.remove('flash'); }, 2200);
    announce('Showing ' + name);
  }

  /* ------------------------------------------------------------------------------------------------ section: files */
  var tree = { api: null };
  function renderFiles() {
    var host = clear($('#files-body'));
    host.appendChild(el('p', { class: 'sec-lede' }, rich('Every file in the project, from a scan of the tree. Facts (lines, size) are measured; descriptions are written in `docs/overview/catalog/files.json`, and `npm test` fails when a file is missing from it.')));
    host.appendChild(scoreboard());
    host.appendChild(explorer());
  }

  /* migration scoreboard */
  function scoreboard() {
    var sc = DATA.scoreboard, bl = DATA.meta.baseline;
    var box = el('div', { class: 'score', 'aria-labelledby': 'score-h' });
    box.appendChild(el('h3', { id: 'score-h', text: 'Migration scoreboard' }));
    box.appendChild(el('p', { class: 'muted small', text: 'Lines written by hand. Built pages, exports, lock files and media are not counted. The JavaScript-to-Python share is for the two languages only.' }));
    var grid = el('div', { class: 'score-grid' });

    /* donut: JS vs Python (authored) */
    var total = sc.js + sc.py;
    var jsShare = total ? sc.js / total : 0;
    var R = 52, C = 2 * Math.PI * R;
    var donut = svg('svg', { viewBox: '0 0 140 140', class: 'donut', role: 'img', 'aria-label': 'JavaScript ' + Math.round(jsShare * 100) + ' percent, Python ' + Math.round((1 - jsShare) * 100) + ' percent of hand-written code lines' },
      svg('circle', { cx: 70, cy: 70, r: R, class: 'ring py', fill: 'none', 'stroke-width': 18 }),
      svg('circle', { cx: 70, cy: 70, r: R, class: 'ring js', fill: 'none', 'stroke-width': 18, 'stroke-dasharray': (C * jsShare).toFixed(2) + ' ' + C.toFixed(2), transform: 'rotate(-90 70 70)' }));
    var t1 = svg('text', { x: 70, y: 68, 'text-anchor': 'middle', class: 'dn' }); t1.textContent = Math.round(jsShare * 100) + '%';
    var t2 = svg('text', { x: 70, y: 86, 'text-anchor': 'middle', class: 'dl' }); t2.textContent = 'JavaScript';
    donut.appendChild(t1); donut.appendChild(t2);
    grid.appendChild(el('figure', { class: 'fig' }, donut,
      el('figcaption', null,
        el('ul', { class: 'legend col' },
          el('li', null, el('span', { class: 'sw js', 'aria-hidden': 'true' }), el('b', { text: 'JavaScript ' }), num(sc.js) + ' lines (' + num(sc.runtimeJs) + ' runtime, ' + num(sc.js - sc.runtimeJs) + ' tests)'),
          el('li', null, el('span', { class: 'sw py', 'aria-hidden': 'true' }), el('b', { text: 'Python ' }), num(sc.py) + ' lines (' + num(sc.runtimePy) + ' runtime, ' + num(sc.py - sc.runtimePy) + ' tests)')))));

    /* bars: authored lines by language */
    var langs = DATA.meta.languages.map(function (l) { return [l, (DATA.byLang[l] || {}).authoredLines || 0, (DATA.byLang[l] || {}).authoredFiles || 0]; });
    var max = Math.max.apply(null, langs.map(function (l) { return l[1]; }).concat([1]));
    var bars = el('div', { class: 'bars', role: 'list', 'aria-label': 'Hand-written lines by language' });
    langs.forEach(function (l) {
      bars.appendChild(el('div', { class: 'bar-row', role: 'listitem' },
        el('span', { class: 'bar-label' }, langBadge(l[0]), el('span', { text: l[0] })),
        el('span', { class: 'bar-track' }, el('i', { class: 'bar-fill l-' + slug(l[0]), style: 'width:' + Math.max(l[1] ? 1.5 : 0, l[1] / max * 100).toFixed(1) + '%' })),
        el('span', { class: 'bar-val', text: num(l[1]) }),
        el('span', { class: 'bar-files', text: l[2] + (l[2] === 1 ? ' file' : ' files') })));
    });
    grid.appendChild(el('div', { class: 'fig' }, bars));

    /* before / after */
    if (bl) {
      var before = bl.python.total, now = sc.py;
      var scale = Math.max(before, sc.js + sc.py, 1);
      function stack(label, py, js) {
        return el('div', { class: 'cmp-row' }, el('span', { class: 'cmp-label', text: label }),
          el('span', { class: 'cmp-track' }, el('i', { class: 'cs py', style: 'width:' + (py / scale * 100).toFixed(1) + '%', title: 'Python ' + num(py) }), el('i', { class: 'cs js', style: 'width:' + (js / scale * 100).toFixed(1) + '%', title: 'JavaScript ' + num(js) })),
          el('span', { class: 'cmp-val', text: num(py) + ' Python / ' + num(js) + ' JS' }));
      }
      grid.appendChild(el('div', { class: 'fig wide' },
        el('h4', { text: 'Before and after' }),
        stack('Before, ' + bl.date, before, bl.javascript.total),
        stack('Now', now, sc.js),
        el('p', { class: 'muted small', text: 'Before: the website, build tools, evaluation and tests were all Python (' + num(bl.python.total) + ' lines, ' + bl.pythonTests + ' tests). Now only the model code is. The earlier figure was measured by hand and is kept as a fixed record.' })));
    }
    box.appendChild(grid);
    return box;
  }

  /* explorer */
  function explorer() {
    var files = DATA.files;
    var wrap = el('div', { class: 'explorer' });
    wrap.appendChild(el('h3', { text: 'File explorer', id: 'explorer-h' }));
    var state = { q: '', owner: {}, lang: {}, tag: {} };
    var OTHER = 'Other';
    var mainLangs = DATA.meta.languages;
    function langKey(l) { return mainLangs.indexOf(l) > -1 ? l : OTHER; }

    var bar = el('div', { class: 'toolbar', role: 'search' });
    var search = el('input', { type: 'search', id: 'file-search', class: 'input', placeholder: 'Search files, descriptions and tags', 'aria-label': 'Search files' });
    bar.appendChild(el('label', { class: 'field grow' }, el('span', { class: 'sr-only', text: 'Search files' }), search));
    bar.appendChild(el('button', { type: 'button', class: 'btn ghost', id: 'file-expand', text: 'Expand all' }));
    bar.appendChild(el('button', { type: 'button', class: 'btn ghost', id: 'file-collapse', text: 'Collapse all' }));
    bar.appendChild(el('button', { type: 'button', class: 'btn ghost', id: 'file-clear', text: 'Clear filters' }));
    wrap.appendChild(bar);

    var chipsBox = el('div', { class: 'chip-groups' });
    function chipGroup(label, key, items, mk) {
      var g = el('div', { class: 'chip-group', role: 'group', 'aria-label': label }, el('span', { class: 'chip-group-label', text: label }));
      items.forEach(function (it) {
        var b = el('button', { type: 'button', class: 'chip filter', 'aria-pressed': 'false', 'data-group': key, 'data-value': it.id }, mk(it));
        b.addEventListener('click', function () {
          state[key][it.id] = !state[key][it.id];
          b.setAttribute('aria-pressed', state[key][it.id] ? 'true' : 'false');
          refresh();
        });
        g.appendChild(b);
      });
      chipsBox.appendChild(g);
    }
    var usedOwners = Object.keys(DATA.meta.owners).filter(function (o) { return files.some(function (f) { return f.owner === o; }); });
    chipGroup('Owner', 'owner', usedOwners.map(function (o) { return { id: o }; }), function (it) { return [el('i', { class: 'od o-' + it.id, 'aria-hidden': 'true' }), ownerLabel(it.id)]; });
    var langIds = mainLangs.concat([OTHER]).filter(function (l) { return files.some(function (f) { return langKey(f.lang) === l; }); });
    chipGroup('Language', 'lang', langIds.map(function (l) { return { id: l }; }), function (it) { return it.id; });
    var tagIds = Object.keys(DATA.meta.tags).filter(function (t) { return files.some(function (f) { return f.tags.indexOf(t) > -1; }); });
    chipGroup('Tag', 'tag', tagIds.map(function (t) { return { id: t }; }), function (it) { return it.id; });
    wrap.appendChild(chipsBox);
    var counter = el('p', { class: 'count', id: 'file-count', 'aria-live': 'polite' });
    wrap.appendChild(counter);

    /* build the tree */
    var rootNode = { name: '', path: '', dirs: {}, files: [], parent: null, level: 0 };
    function dirNode(path) {
      var node = rootNode;
      if (!path) return node;
      path.split('/').forEach(function (part, i, arr) {
        var p = arr.slice(0, i + 1).join('/');
        if (!node.dirs[part]) node.dirs[part] = { name: part, path: p, dirs: {}, files: [], parent: node, level: node.level + 1 };
        node = node.dirs[part];
      });
      return node;
    }
    files.forEach(function (f) {
      if (f.group) { dirNode(f.dir).files.push(f); return; }
      var i = f.path.lastIndexOf('/');
      dirNode(i < 0 ? '' : f.path.slice(0, i)).files.push(f);
    });
    Object.keys(DATA.dirs).forEach(function (d) { if (DATA.dirs[d].virtual) dirNode(d.replace(/\/$/, '')); });
    function tally(node) {
      node.count = 0; node.lines = 0; node.authored = 0;
      node.files.forEach(function (f) { node.count += f.group ? f.count : 1; node.lines += f.lines || 0; });
      Object.keys(node.dirs).forEach(function (k) { var c = tally(node.dirs[k]); node.count += c.count; node.lines += c.lines; });
      return node;
    }
    tally(rootNode);

    var ul = el('ul', { class: 'tree', role: 'tree', 'aria-labelledby': 'explorer-h' });
    var items = [];
    var openState = {};
    function build(node, parentUl) {
      Object.keys(node.dirs).sort(cmp).forEach(function (k) {
        var d = node.dirs[k];
        var info = DATA.dirs[d.path + '/'] || null;
        var li = el('li', { role: 'treeitem', class: 'ti dir', 'aria-expanded': 'false', 'aria-level': d.level, tabindex: '-1', 'data-path': d.path + '/' });
        var row = el('div', { class: 'row' },
          el('span', { class: 'caret' }, icon('caret')),
          el('span', { class: 'name mono', text: d.name + '/' }),
          el('span', { class: 'desc', text: info ? info.desc : '' }),
          el('span', { class: 'meta' }, info && info.virtual ? badge('local only', 'virtual') : el('span', { class: 'mn', text: num(d.count) + (d.count === 1 ? ' file' : ' files') }), d.lines ? el('span', { class: 'mn', text: num(d.lines) + ' lines' }) : null),
          el('span', { class: 'acts' }, el('button', { type: 'button', class: 'mini-btn', tabindex: '-1', 'aria-label': 'Copy path of ' + d.path + '/', onclick: function (e) { e.stopPropagation(); copyText(d.path + '/', e.currentTarget, d.path + '/'); } }, icon('copy'))));
        var childUl = el('ul', { role: 'group', class: 'tg', hidden: true });
        li.appendChild(row);
        li.appendChild(childUl);
        parentUl.appendChild(li);
        var item = { li: li, row: row, kind: 'dir', node: d, ul: childUl, path: d.path + '/', hay: (d.path + ' ' + (info ? info.desc : '')).toLowerCase(), children: [] };
        items.push(item);
        li._item = item;
        row.addEventListener('click', function () { focusItem(item); toggle(item); });
        build(d, childUl);
      });
      node.files.slice().sort(function (a, b) { return cmp(a.path, b.path); }).forEach(function (f) {
        var name = f.group ? f.path.slice(f.path.lastIndexOf('/') + 1) : f.path.slice(f.path.lastIndexOf('/') + 1);
        var li = el('li', { role: 'treeitem', class: 'ti file o-' + f.owner + (f.virtual ? ' virt' : '') + (f.self ? ' self' : ''), 'aria-level': node.level + 1, tabindex: '-1', 'data-path': f.path });
        var tagEls = f.tags.map(function (t) { return el('span', { class: 'tag t-' + slug(t), text: t }); });
        var meta = f.group
          ? [el('span', { class: 'mn', text: num(f.count) + ' files' }), el('span', { class: 'mn', text: bytes(f.bytes) })]
          : f.virtual ? [badge('local only', 'virtual')] : f.self ? [el('span', { class: 'mn', text: 'this page' })] : [f.lines !== null ? el('span', { class: 'mn', text: num(f.lines) + ' lines' }) : null, el('span', { class: 'mn', text: bytes(f.bytes) })];
        var row = el('div', { class: 'row' },
          el('span', { class: 'caret blank' }),
          el('span', { class: 'name mono', text: name }),
          el('span', { class: 'desc' }, f.desc, f.group ? el('span', { class: 'names', title: f.names.join(', '), text: ' ' + f.names.slice(0, 6).join(', ') + (f.names.length > 6 ? ', …' : '') }) : null, f.provisional ? badge('provisional', 'warn') : null),
          el('span', { class: 'meta' }, langBadge(f.lang), meta),
          el('span', { class: 'tags' }, ownerChip(f.owner), tagEls),
          el('span', { class: 'acts' }, el('button', { type: 'button', class: 'mini-btn', tabindex: '-1', 'aria-label': 'Copy path of ' + f.path, onclick: function (e) { e.stopPropagation(); copyText(f.path, e.currentTarget, f.path); } }, icon('copy'))));
        li.appendChild(row);
        parentUl.appendChild(li);
        var item = { li: li, row: row, kind: 'file', file: f, path: f.path, hay: [f.path, f.desc, f.tags.join(' '), ownerLabel(f.owner), f.lang, f.virtual ? 'local only private' : ''].join(' ').toLowerCase() };
        items.push(item);
        li._item = item;
        row.addEventListener('click', function () { focusItem(item); });
      });
    }
    build(rootNode, ul);
    var emptyEl = el('p', { class: 'empty', id: 'file-empty', hidden: true, text: 'No file matches. Clear a filter or change the search.' });
    var rootless = el('div', { class: 'tree-wrap' }, ul, emptyEl);
    wrap.appendChild(rootless);
    wrap.appendChild(el('p', { class: 'muted small tree-note' },
      'Not listed: ', el('code', { text: '.git/' }), ', ', el('code', { text: 'node_modules/' }), ', ', el('code', { text: '__pycache__/' }), ' and anything git ignores. ',
      DATA.stats.files + ' files in total; media and exports are summarised by pattern.'));

    /* behaviour */
    function setOpen(item, open) {
      item.li.setAttribute('aria-expanded', open ? 'true' : 'false');
      item.ul.hidden = !open;
    }
    function toggle(item) { if (item.kind !== 'dir') return; var open = item.li.getAttribute('aria-expanded') !== 'true'; setOpen(item, open); openState[item.path] = open; }
    var focused = null;
    function focusItem(item, doFocus) {
      if (focused) focused.li.tabIndex = -1;
      focused = item;
      item.li.tabIndex = 0;
      if (doFocus) item.li.focus({ preventScroll: false });
    }
    function visibleItems() { return items.filter(function (it) { return !it.li.hidden && ancestorsOpen(it); }); }
    function ancestorsOpen(it) {
      var p = it.li.parentNode;
      while (p && p !== ul) {
        if (p.hidden) return false;
        var holder = p.parentNode;
        if (!holder || holder.hidden) return false;
        p = holder.parentNode;
      }
      return true;
    }
    function parentDir(it) {
      var up = it.li.parentNode.closest('li.dir');
      return up ? up._item : null;
    }
    ul.addEventListener('keydown', function (e) {
      var li = e.target.closest ? e.target.closest('li.ti') : null;
      if (!li || e.target.tagName === 'BUTTON') return;
      var it = li._item, vis = visibleItems(), i = vis.indexOf(it), to = null;
      if (e.key === 'ArrowDown') to = vis[Math.min(vis.length - 1, i + 1)];
      else if (e.key === 'ArrowUp') to = vis[Math.max(0, i - 1)];
      else if (e.key === 'Home') to = vis[0];
      else if (e.key === 'End') to = vis[vis.length - 1];
      else if (e.key === 'ArrowRight') {
        if (it.kind === 'dir') { if (it.li.getAttribute('aria-expanded') !== 'true') { setOpen(it, true); openState[it.path] = true; } else to = vis[i + 1]; }
      } else if (e.key === 'ArrowLeft') {
        if (it.kind === 'dir' && it.li.getAttribute('aria-expanded') === 'true') { setOpen(it, false); openState[it.path] = false; }
        else to = parentDir(it);
      } else if (e.key === 'Enter' || e.key === ' ') {
        if (it.kind === 'dir') toggle(it); else copyText(it.path, it.row.querySelector('.mini-btn'), it.path);
      } else if (e.key === 'c' && !e.ctrlKey && !e.metaKey) copyText(it.path, it.row.querySelector('.mini-btn'), it.path);
      else return;
      e.preventDefault();
      if (to) focusItem(to, true);
    });

    function anyFilter() {
      return !!state.q || ['owner', 'lang', 'tag'].some(function (k) { return Object.keys(state[k]).some(function (x) { return state[k][x]; }); });
    }
    function chipOk(f) {
      var sel = function (k) { return Object.keys(state[k]).filter(function (x) { return state[k][x]; }); };
      var o = sel('owner'), l = sel('lang'), t = sel('tag');
      if (o.length && o.indexOf(f.owner) < 0) return false;
      if (l.length && l.indexOf(langKey(f.lang)) < 0) return false;
      if (t.length && !t.some(function (x) { return f.tags.indexOf(x) > -1; })) return false;
      return true;
    }
    function refresh() {
      var tokens = state.q.split(/\s+/).filter(Boolean);
      var filtering = anyFilter();
      var shown = 0;
      /* pass 1: files */
      var dirMatch = {};
      items.forEach(function (it) {
        if (it.kind === 'dir') {
          dirMatch[it.path] = tokens.length && tokens.every(function (t) { return it.hay.indexOf(t) > -1; });
        }
      });
      items.forEach(function (it) {
        if (it.kind !== 'file') return;
        var inDirMatch = Object.keys(dirMatch).some(function (p) { return dirMatch[p] && it.path.indexOf(p) === 0; });
        var ok = chipOk(it.file) && (!tokens.length || inDirMatch || tokens.every(function (t) { return it.hay.indexOf(t) > -1; }));
        it.visible = ok;
        it.li.hidden = !ok;
        if (ok) shown += it.file.group ? it.file.count : 1;
      });
      /* pass 2: folders, deepest first */
      var dirs = items.filter(function (i) { return i.kind === 'dir'; }).sort(function (a, b) { return b.path.length - a.path.length; });
      dirs.forEach(function (d) {
        var any = Array.prototype.some.call(d.ul.children, function (c) { return !c.hidden; });
        d.li.hidden = filtering ? !any : false;
        if (filtering) { setOpen(d, any); } else { setOpen(d, !!openState[d.path]); }
      });
      emptyEl.hidden = shown > 0 || !filtering;
      counter.textContent = filtering ? shown + ' of ' + DATA.stats.files + ' files match' : DATA.stats.files + ' files';
      if (!focused || focused.li.hidden || !ancestorsOpen(focused)) { var v = visibleItems()[0]; if (v) focusItem(v); }
    }
    search.addEventListener('input', function () { state.q = search.value.trim().toLowerCase(); refresh(); });
    $('#file-expand', wrap).addEventListener('click', function () { items.forEach(function (it) { if (it.kind === 'dir') { setOpen(it, true); openState[it.path] = true; } }); });
    $('#file-collapse', wrap).addEventListener('click', function () { items.forEach(function (it) { if (it.kind === 'dir') { setOpen(it, false); openState[it.path] = false; } }); refresh(); });
    $('#file-clear', wrap).addEventListener('click', clearFilters);
    function clearFilters() {
      state.q = ''; search.value = '';
      ['owner', 'lang', 'tag'].forEach(function (k) { state[k] = {}; });
      $$('.chip.filter', wrap).forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
      refresh();
    }

    /* open a path from anywhere on the page */
    function reveal(path) {
      clearFilters();
      var target = null;
      var glob = /[*?{]/.test(path);
      if (glob) {
        var dirPart = path.slice(0, path.lastIndexOf('/') + 1);
        target = items.filter(function (it) { return it.path === dirPart; })[0];
        if (!target) {
          var prefix = path.split(/[*?{]/)[0];
          target = items.filter(function (it) { return it.kind === 'file' && it.path.indexOf(prefix) === 0; })[0];
        }
      } else target = items.filter(function (it) { return it.path === path; })[0];
      if (!target) { announce('Not found in the explorer: ' + path); return; }
      var d = parentDir(target);
      while (d) { setOpen(d, true); openState[d.path] = true; d = parentDir(d); }
      if (target.kind === 'dir') { setOpen(target, true); openState[target.path] = true; }
      focusItem(target);
      $('#files').scrollIntoView({ behavior: 'auto', block: 'start' });
      target.li.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
      target.row.classList.add('flash');
      setTimeout(function () { target.row.classList.remove('flash'); }, 2400);
      target.li.focus({ preventScroll: true });
      announce('Showing ' + path);
    }
    tree.api = { reveal: reveal, search: search, clear: clearFilters };
    refresh();
    return wrap;
  }
  function revealPath(path) { if (tree.api) tree.api.reveal(path); }

  /* ------------------------------------------------------------------------------------------------ section: boundary */
  function renderBoundary() {
    var host = clear($('#boundary-body'));
    var b = DATA.boundary;
    host.appendChild(el('blockquote', { class: 'pull', text: b.intro }));
    var table = el('table', { class: 'plain boundary' },
      el('thead', null, el('tr', null, ['Piece', 'Lives in', 'Why there', 'Files'].map(function (h) { return el('th', { scope: 'col', text: h }); }))),
      el('tbody', null, b.rows.map(function (r) {
        return el('tr', { class: 'bl-' + r.lives.toLowerCase() },
          el('th', { scope: 'row', text: r.piece }),
          el('td', null, el('span', { class: 'owner-tag ' + (r.lives === 'JS' ? 'js' : 'py'), text: r.lives === 'JS' ? 'JavaScript' : 'Python' })),
          el('td', { text: r.why }),
          el('td', null, el('ul', { class: 'file-links' }, r.files.map(function (f) { return el('li', null, el('button', { type: 'button', class: 'linkish mono small', onclick: function () { revealPath(f); } }, f)); }))));
      })));
    host.appendChild(el('div', { class: 'table-scroll' }, table));

    if (b.seam && b.seam.points && b.seam.points.length) {
      host.appendChild(el('div', { class: 'block seam' }, el('h3', { text: b.seam.title }), el('ul', { class: 'bullets' }, b.seam.points.map(function (p) { return el('li', null, rich(p)); }))));
    }

    if (b.finetuning && b.finetuning.length) {
      var ft = el('div', { class: 'finetune' });
      ft.appendChild(el('h3', { text: 'Where fine-tuning plugs into model/' }));
      ft.appendChild(el('p', { class: 'muted', text: b.finetuning_intro }));
      ft.appendChild(el('ol', { class: 'plug' }, b.finetuning.map(function (p, i) {
        return el('li', null, el('span', { class: 'pn', 'aria-hidden': 'true', text: String(i + 1) }), el('div', null,
          el('b', { text: p.title }), el('p', { class: 'small', text: p.text }),
          el('button', { type: 'button', class: 'linkish mono small', onclick: function () { revealPath(p.file); } }, p.file), p.fn ? el('code', { class: 'fn', text: p.fn }) : null));
      })));
      host.appendChild(ft);
    }
  }

  /* ------------------------------------------------------------------------------------------------ section: tests */
  function renderTests() {
    var host = clear($('#tests-body'));
    var t = DATA.tests;
    host.appendChild(el('p', { class: 'sec-lede' }, t.intro, ' ', el('b', { text: num(t.total) + ' tests' }), ' are counted from the test files.'));
    var tabsHost = el('div', { class: 'test-tabs' });
    host.appendChild(tabsHost);
    var descOf = {};
    DATA.files.forEach(function (f) { descOf[f.path] = f.desc; });
    var tabs = t.suites.map(function (s) {
      return { id: s.id, label: s.title, count: s.count, render: function (panel) {
        panel.appendChild(el('div', { class: 'suite-head' },
          el('div', { class: 'big' }, el('b', { text: num(s.count) }), el('span', { text: 'tests' })),
          el('div', null, el('p', { class: 'kicker', text: s.runner }),
            el('div', { class: 'cmd' }, el('code', { class: 'mono', text: s.command }), copyButton(s.command, s.command)),
            s.also ? el('p', { class: 'small muted' }, 'Or: ', el('code', { text: s.also })) : null,
            el('p', { class: 'small' }, el('b', { text: 'Needs: ' }), s.needs))));
        panel.appendChild(el('h4', { text: 'What it proves' }));
        panel.appendChild(el('ul', { class: 'bullets' }, s.proves.map(function (p) { return el('li', { text: p }); })));
        if (s.perFile.length) {
          panel.appendChild(el('h4', { text: 'Files' }));
          panel.appendChild(el('div', { class: 'table-scroll' }, el('table', { class: 'plain' },
            el('thead', null, el('tr', null, [el('th', { scope: 'col', text: 'Test file' }), el('th', { scope: 'col', text: 'Tests', class: 'num' }), el('th', { scope: 'col', text: 'Covers' })])),
            el('tbody', null, s.perFile.map(function (f) {
              return el('tr', null, el('td', null, el('button', { type: 'button', class: 'linkish mono small', onclick: function () { revealPath(f.path); } }, f.path)), el('td', { class: 'num', text: String(f.count) }), el('td', { class: 'small', text: descOf[f.path] || '' }));
            })))));
        }
      } };
    });
    tabs.push({ id: 'checks', label: 'Checks', count: t.checks ? t.checks.length : 3, render: function (panel) {
      panel.appendChild(el('p', { class: 'muted', text: 'Not tests but they fail the build the same way: they keep the generated and the authored parts of the project in agreement.' }));
      t.checks.forEach(function (c) {
        panel.appendChild(el('div', { class: 'check-card' }, el('h4', { text: c.title }), el('div', { class: 'cmd' }, el('code', { class: 'mono', text: c.command }), copyButton(c.command, c.command)), el('p', { class: 'small', text: c.proves })));
      });
    } });
    Tabs(tabsHost, tabs, { id: 'tests', label: 'Test suites' });
  }

  /* ------------------------------------------------------------------------------------------------ section: commands */
  function renderCommands() {
    var host = clear($('#commands-body'));
    var cm = DATA.commands;
    function npmCmd(s) { return s === 'start' || s === 'test' ? 'npm ' + s : 'npm run ' + s; }
    var tabsHost = el('div', { class: 'cmd-tabs' });
    host.appendChild(tabsHost);
    var tabs = cm.groups.map(function (g) {
      var mine = DATA.scripts.filter(function (s) { return s.group === g.id; });
      var extra = cm.extra.filter(function (x) { return x.group === g.id; });
      return { id: g.id, label: g.title, count: mine.length + extra.length, render: function (panel) {
        var list = el('ul', { class: 'cmds' });
        mine.forEach(function (s) {
          list.appendChild(el('li', { class: s.primary ? 'primary' : '' },
            el('div', { class: 'cmd' }, el('code', { class: 'mono', text: npmCmd(s.script) }), copyButton(npmCmd(s.script), npmCmd(s.script))),
            el('p', { text: s.desc }),
            el('p', { class: 'under mono small', text: s.cmd })));
        });
        extra.forEach(function (x) {
          list.appendChild(el('li', null, el('div', { class: 'cmd' }, el('code', { class: 'mono', text: x.cmd }), copyButton(x.cmd, x.cmd)), el('p', { text: x.desc })));
        });
        panel.appendChild(list);
      } };
    });
    Tabs(tabsHost, tabs, { id: 'cmd', label: 'Command groups' });

    /* troubleshooting */
    var ts = el('div', { class: 'trouble' });
    ts.appendChild(el('h3', { id: 'trouble-h', text: 'Troubleshooting' }));
    var rows = DATA.troubleshooting;
    var areas = []; rows.forEach(function (r) { if (areas.indexOf(r.area) < 0) areas.push(r.area); });
    var q = { text: '', area: 'all' };
    var bar = el('div', { class: 'toolbar', role: 'search' });
    var search = el('input', { type: 'search', id: 'trouble-search', class: 'input', placeholder: 'Search what you see, e.g. 503, port, key', 'aria-label': 'Search troubleshooting' });
    bar.appendChild(el('label', { class: 'field grow' }, el('span', { class: 'sr-only', text: 'Search troubleshooting' }), search));
    bar.appendChild(segmented('Area', 'trouble-area', [['all', 'All']].concat(areas.map(function (a) { return [a, a]; })), function (v) { q.area = v; run(); }));
    ts.appendChild(bar);
    var count = el('p', { class: 'count', 'aria-live': 'polite' });
    ts.appendChild(count);
    var body = el('tbody');
    var trs = rows.map(function (r) {
      var tr = el('tr', null, el('th', { scope: 'row' }, el('span', { class: 'area', text: r.area }), el('span', { class: 'sym', text: r.symptom })), el('td', { text: r.cause === '-' ? '' : r.cause }), el('td', null, rich(r.fix)));
      body.appendChild(tr);
      return { tr: tr, r: r, hay: [r.area, r.symptom, r.cause, r.fix, r.keywords].join(' ').toLowerCase() };
    });
    ts.appendChild(el('div', { class: 'table-scroll' }, el('table', { class: 'plain trouble-table' },
      el('thead', null, el('tr', null, ['You see', 'Why', 'Do this'].map(function (h) { return el('th', { scope: 'col', text: h }); }))), body)));
    function run() {
      var shown = 0;
      trs.forEach(function (t) {
        var ok = (q.area === 'all' || t.r.area === q.area) && (!q.text || t.hay.indexOf(q.text) > -1);
        t.tr.hidden = !ok; if (ok) shown++;
      });
      count.textContent = shown === trs.length ? trs.length + ' entries' : shown + ' of ' + trs.length + ' entries';
    }
    search.addEventListener('input', function () { q.text = search.value.trim().toLowerCase(); run(); });
    run();
    host.appendChild(ts);
  }

  /* ------------------------------------------------------------------------------------------------ footer */
  function renderFooter() {
    var gen = (document.querySelector('meta[name="generated"]') || {}).content || '';
    var when = gen ? new Date(gen) : null;
    var host = clear($('#footer'));
    host.appendChild(el('p', null, 'Generated from the project tree',
      when && !isNaN(when) ? [' on ', el('time', { datetime: gen, text: when.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) })] : null,
      '. The numbers are scanned; the descriptions are written in ', el('code', { text: 'docs/overview/catalog/' }), '.'));
    host.appendChild(el('p', null, 'To regenerate: ', el('code', { text: 'npm run build:overview' }), '  (', el('code', { text: 'node tools/build-overview.js' }), '). To verify without writing: ', el('code', { text: 'node tools/build-overview.js --check' }), '.'));
    host.appendChild(el('p', { class: 'doc-paths' }, 'More: ', DATA.meta.docs.map(function (d, i) { return [i ? '  ' : '', el('code', { text: d.path }), ' ', el('span', { class: 'muted', text: '(' + d.note + ')' })]; })));
  }

  /* ------------------------------------------------------------------------------------------------ nav + keys */
  function initNav() {
    var links = $$('#section-nav a');
    var map = {};
    links.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
    var ids = Object.keys(map);
    var current = null;
    function mark(id) {
      if (id === current) return;
      current = id;
      links.forEach(function (a) { if (a === map[id]) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current'); });
      var a = map[id];
      var ol = a.closest('ol');
      if (ol && ol.scrollWidth > ol.clientWidth + 2) ol.scrollTo({ left: a.offsetLeft - ol.clientWidth / 2 + a.offsetWidth / 2, behavior: 'auto' });
    }
    function spy() {
      var y = window.innerHeight * 0.3, best = ids[0];
      ids.forEach(function (id) {
        var s = document.getElementById(id);
        if (s && s.getBoundingClientRect().top <= y) best = id;
      });
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) best = ids[ids.length - 1];
      mark(best);
    }
    var ticking = false;
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(function () { ticking = false; spy(); }); } }, { passive: true });
    window.addEventListener('resize', spy);
    links.forEach(function (a) { a.addEventListener('click', function () { mark(a.getAttribute('href').slice(1)); }); });
    spy();
  }
  function initKeys() {
    var dlg = $('#kbd-dialog');
    $('#kbd-help').addEventListener('click', function () { if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', ''); });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  }

  /* ------------------------------------------------------------------------------------------------ go */
  function run(name, fn) {
    try { fn(); } catch (e) {
      if (window.console) console.error('overview: ' + name + ' failed', e);
      var host = document.getElementById(name);
      if (host) host.appendChild(el('p', { class: 'render-error', role: 'alert', text: 'This section could not be drawn (' + (e && e.message || e) + ').' }));
    }
  }
  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  initTheme();
  run('hero', renderHero);
  run('live', function () { renderLiveShell(); checkLive(); });
  run('architecture-body', renderArchitecture);
  run('flows-body', renderFlows);
  run('pages-body', renderPages);
  run('api-body', renderApi);
  run('config-body', renderConfig);
  run('files-body', renderFiles);
  run('boundary-body', renderBoundary);
  run('tests-body', renderTests);
  run('commands-body', renderCommands);
  run('footer', renderFooter);
  initNav();
  initKeys();
  window.addEventListener('beforeprint', function () { allTabs.forEach(function (draw) { try { draw(); } catch (e) { /* a panel that cannot draw is left out */ } }); });
  document.body.setAttribute('data-ready', 'true');
})();
