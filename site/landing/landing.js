// Terucon landing page: behaviour only. The page is complete HTML without this file (it is loaded with `defer`); this adds the
// slideshow, the menu, the accordions, the project filter, the enquiry form and the assistant. Plain ES2017, no dependencies.
(function () {
  'use strict';
  var d = document, w = window;
  var $ = function (s, r) { return (r || d).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || d).querySelectorAll(s)); };
  var mm = function (q) { return !!(w.matchMedia && w.matchMedia(q).matches); };
  var reduce = mm('(prefers-reduced-motion: reduce)');
  var canHover = mm('(hover: hover)');
  var raf = w.requestAnimationFrame ? function (f) { w.requestAnimationFrame(f); } : function (f) { setTimeout(f, 16); };
  var idle = w.requestIdleCallback ? function (f, t) { w.requestIdleCallback(f, { timeout: t }); } : function (f) { setTimeout(f, 400); };
  var script = d.currentScript;

  // ---- menu (below 1200 px) ------------------------------------------------------------------------------------------
  var menu = $('#menu'), burger = $('#burger');
  function setMenu(open) {
    menu.hidden = !open;
    burger.setAttribute('aria-expanded', String(open));
    d.body.style.overflow = open ? 'hidden' : '';
  }
  burger.addEventListener('click', function () { setMenu(menu.hidden); });
  menu.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
  d.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !menu.hidden) { setMenu(false); burger.focus(); } });
  var wide = w.matchMedia && w.matchMedia('(min-width:1200px)');
  if (wide && wide.addEventListener) wide.addEventListener('change', function (e) { if (e.matches) setMenu(false); });

  // ---- the section being read: underline in the header (only the sections the header links to) -----------------------------
  if ('IntersectionObserver' in w) {
    var links = $$('.nav a');
    var spy = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        links.forEach(function (a) { a.setAttribute('aria-current', String(a.getAttribute('href') === '#' + e.target.id)); });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    ['overview'].concat(links.map(function (a) { return a.getAttribute('href').slice(1); })).forEach(function (id) { var s = d.getElementById(id); if (s) spy.observe(s); });
  }

  // ---- hero slideshow ------------------------------------------------------------------------------------------------
  var hero = $('#overview'), picks = $$('.pk'), n = picks.length, idx = 0, prev = -1;
  var ms = Number(hero.getAttribute('data-ms')) || 6500;
  var paused = reduce, injected = false, held = { hover: false, off: false, hid: false };
  var pauseBtn = $('#hero-pause'), cap = $('#hero-cap');
  var caps = picks.map(function (b) { return b.getAttribute('data-cap'); });
  hero.style.setProperty('--ms', ms + 'ms');

  function inject() {
    if (injected) return;
    injected = true;
    var t = $('#hero-more');
    if (t && t.content) $('#slides').appendChild(t.content);
  }
  // the progress bar of the shown slide: it runs (and its end moves on) while playing, and is simply full while paused
  function restartBar() {
    var cur = picks[idx];
    cur.classList.remove('run', 'fin');
    void cur.offsetWidth;
    cur.classList.add(paused ? 'fin' : 'run');
  }
  function go(i) {
    inject();
    if (i !== idx) { prev = idx; idx = i; }
    $$('.slide').forEach(function (s, k) {
      s.classList.toggle('is-on', k === idx);
      s.classList.toggle('was', k === prev && k !== idx);
      s.classList.remove('pre');
      s.setAttribute('aria-hidden', k === idx ? 'false' : 'true');
    });
    picks.forEach(function (b, k) {
      b.setAttribute('aria-current', String(k === idx));
      b.classList.toggle('done', k < idx);
    });
    cap.firstChild.textContent = '0' + (idx + 1);
    cap.lastChild.textContent = ' / 0' + n + ' — ' + caps[idx];
    restartBar();
  }
  function step(dir) { go((idx + dir + n) % n); }
  function setHeld() {
    hero.classList.toggle('is-held', held.hover || held.off || held.hid);
  }
  function setPaused(p) {
    paused = p;
    hero.classList.toggle('is-paused', p);
    pauseBtn.setAttribute('aria-pressed', String(p));
    pauseBtn.setAttribute('aria-label', p ? 'Play slideshow' : 'Pause slideshow');
    cap.setAttribute('aria-live', p ? 'polite' : 'off');
    if (!p) restartBar();
    setHeld();
  }
  picks.forEach(function (b, k) { b.addEventListener('click', function () { go(k); }); });
  $('#hero-prev').addEventListener('click', function () { step(-1); });
  $('#hero-next').addEventListener('click', function () { step(1); });
  pauseBtn.addEventListener('click', function () { setPaused(!paused); });
  $('.picker').addEventListener('keydown', function (e) {
    var k = e.key, i = null;
    if (k === 'ArrowRight') i = (idx + 1) % n; else if (k === 'ArrowLeft') i = (idx + n - 1) % n; else if (k === 'Home') i = 0; else if (k === 'End') i = n - 1;
    if (i === null) return;
    e.preventDefault();
    go(i);
    picks[i].focus();
  });
  $('.picker').addEventListener('animationend', function (e) { if (e.animationName === 'fill') step(1); });
  var tx = null, ty = 0;
  hero.addEventListener('touchstart', function (e) { var t = e.touches[0]; if (t) { tx = t.clientX; ty = t.clientY; } }, { passive: true });
  hero.addEventListener('touchend', function (e) {
    var t = e.changedTouches[0];
    if (tx === null || !t) return;
    var dx = t.clientX - tx, dy = t.clientY - ty;
    tx = null;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.2) step(dx < 0 ? 1 : -1);
  }, { passive: true });
  if (canHover) {
    var ctl = $('#hero-ctl');
    ctl.addEventListener('mouseenter', function () { held.hover = true; setHeld(); });
    ctl.addEventListener('mouseleave', function () { held.hover = false; setHeld(); });
  }
  d.addEventListener('visibilitychange', function () { held.hid = d.hidden; setHeld(); });
  if ('IntersectionObserver' in w) new IntersectionObserver(function (es) { held.off = !es[0].isIntersecting; setHeld(); }).observe(hero);
  var first = $('.slide');
  if (reduce) first.classList.remove('pre'); else raf(function () { raf(function () { first.classList.remove('pre'); }); });
  hero.classList.toggle('is-paused', paused);
  pauseBtn.setAttribute('aria-pressed', String(paused));
  pauseBtn.setAttribute('aria-label', paused ? 'Play slideshow' : 'Pause slideshow');
  cap.setAttribute('aria-live', paused ? 'polite' : 'off');
  restartBar();
  var afterLoad = function () { idle(inject, 2500); };
  if (d.readyState === 'complete') afterLoad(); else w.addEventListener('load', afterLoad, { once: true });

  // ---- disciplines (native <details>; this keeps one open and moves the picture) ------------------------------------------
  var ds = $$('.d'), shots = $$('.disc__fig img'), dn = $('#disc-n'), dt = $('#disc-t');
  ds.forEach(function (el, k) {
    el.querySelector('summary').addEventListener('click', function (e) { if (el.open) e.preventDefault(); });
    el.addEventListener('toggle', function () {
      if (!el.open) return;
      ds.forEach(function (o) { if (o !== el) o.open = false; });
      shots.forEach(function (s, j) { s.classList.toggle('on', j === k); });
      dn.textContent = '0' + (k + 1);
      dt.textContent = el.getAttribute('data-t');
    });
  });
  $$('.d__go').forEach(function (b) {
    b.addEventListener('click', function () {
      var chip = $$('.chip input').filter(function (i) { return i.value === b.getAttribute('data-s'); })[0];
      if (chip) chip.checked = true;
      resetSent();
      $('#engage').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
    });
  });

  // ---- projects: the first one shown is the featured one -------------------------------------------------------------
  var pjs = $$('.pj'), fbs = $$('.fb');
  fbs.forEach(function (b) {
    b.addEventListener('click', function () {
      var f = b.getAttribute('data-f'), shown = null;
      pjs.forEach(function (p) {
        var ok = f === 'All' || p.getAttribute('data-cats').split('|').indexOf(f) > -1;
        p.hidden = !ok;
        p.classList.remove('is-feature');
        if (ok && !shown) shown = p;
      });
      if (shown) shown.classList.add('is-feature');
      fbs.forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    });
  });

  // ---- studio directions ---------------------------------------------------------------------------------------------
  var ths = $$('.th'), dimgs = $$('.dirs__main img'), dlab = $('#dir-label');
  ths.forEach(function (b, k) {
    b.addEventListener('click', function () {
      ths.forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      dimgs.forEach(function (im, j) { im.classList.toggle('on', j === k); });
      dlab.textContent = b.getAttribute('data-l');
    });
  });

  // ---- enquiry form: saved on this site (POST /api/enquiry); nothing is sent to WhatsApp ---------------------------------
  var form = $('#enquiry'), sent = $('#sent'), send = $('#send');
  function resetSent() { if (!sent.hidden) { sent.hidden = true; form.hidden = false; } }
  $('#sent-again').addEventListener('click', function () { form.reset(); resetSent(); $('input[name=name]', form).focus(); });
  function fieldError(name, bad) {
    var f = form.elements[name], m = $('#e-' + name);
    f.setAttribute('aria-invalid', String(bad));
    m.hidden = !bad;
    return bad;
  }
  function failure(text) {
    var m = $('#form-err');
    m.textContent = text;
    m.hidden = false;
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = function (k) { return (form.elements[k].value || '').trim(); };
    var bad = [fieldError('name', !v('name')), fieldError('phone', v('phone').replace(/\D/g, '').length < 10), fieldError('details', !v('details'))];
    if (bad.indexOf(true) > -1) { form.querySelector('[aria-invalid=true]').focus(); return; }
    $('#form-err').hidden = true;
    var svc = $('input[name=service]:checked', form);
    var phone = v('phone'), digits = phone.replace(/\D/g, '');
    var lines = ['Service: ' + (svc ? svc.value : 'Not chosen')];
    [['Scope', 'scope'], ['Budget', 'budget'], ['Timeline', 'timeline'], ['Approx. area (sq ft)', 'area']].forEach(function (p) { if (v(p[1])) lines.push(p[0] + ': ' + v(p[1])); });
    lines.push('', 'Details: ' + v('details'));
    var body = { source: 'landing', name: v('name'), phone: /^\d{10}$/.test(phone.replace(/[\s-]/g, '')) ? '+91 ' + digits : phone, email: v('email'), city: v('city'), message: lines.join('\n'), website: v('website') };
    send.disabled = true;
    send.firstChild.textContent = 'Sending… ';
    fetch('/api/enquiry', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return null; }).then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (r) {
        if (!r.ok) { failure((r.j && r.j.error && r.j.error.message) || 'Something went wrong. Please try again, or call us.'); return; }
        $('#sent-name').textContent = v('name').split(/\s+/)[0] || 'there';
        $('#sent-ref').textContent = r.j && r.j.reference ? ' Your reference is ' + r.j.reference + '.' : '';
        form.hidden = true;
        sent.hidden = false;
        sent.setAttribute('tabindex', '-1');
        sent.focus();
      })
      .catch(function () { failure('We could not reach the server. Check your connection and try again, or call us.'); })
      .then(function () { send.disabled = false; send.firstChild.textContent = 'Send enquiry '; });
  });

  // ---- scroll reveal: only what starts below the first screen is hidden, and only once the observer has said so --------------
  if (!reduce && 'IntersectionObserver' in w) {
    var rev = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        var t = e.target;
        if (e.isIntersecting) { if (t.classList.contains('rv')) t.classList.add('in'); rev.unobserve(t); } else if (!t.classList.contains('rv')) t.classList.add('rv');
      });
    }, { rootMargin: '0px 0px -6% 0px' });
    $$('[data-reveal]').forEach(function (t) { rev.observe(t); });
  }

  // ---- the assistant: the site's real TeruBot, fetched on the first tap (nothing of it is downloaded before) ---------------
  var bot = $('#bot'), loading = null, botOn = false;
  function loadBot() {
    if (w.TeruBot) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise(function (ok, no) {
      var l = d.createElement('link');
      l.rel = 'stylesheet';
      l.href = '/brand/terubot.css';
      d.head.appendChild(l);
      var s = d.createElement('script');
      s.src = '/brand/terubot.js';
      s.onload = function () { w.TeruBot ? ok() : no(); };
      s.onerror = no;
      d.head.appendChild(s);
    });
    loading.catch(function () { loading = null; });
    return loading;
  }
  function openBot() {
    loadBot().then(function () { botOn = true; bot.hidden = true; w.TeruBot.open(); }, function () { location.hash = '#engage'; });
  }
  $$('#bot,[data-bot]').forEach(function (b) {
    b.addEventListener('click', function () { setMenu(false); openBot(); });
    ['pointerenter', 'focus', 'touchstart'].forEach(function (ev) { b.addEventListener(ev, loadBot, { once: true, passive: true }); });
  });
  // TeruBot sent this visitor here ("resume" in its tab state): fetch it now so the conversation opens again, as it does on every other page
  try {
    var kept = JSON.parse(w.sessionStorage.getItem('terucon.terubot.v1') || 'null');
    if (kept && kept.v === 1 && kept.resume === true) loadBot().then(function () { botOn = true; bot.hidden = true; }, function () {});
  } catch (e) { /* no session storage: nothing to resume */ }
  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    raf(function () { ticking = false; if (!botOn) bot.hidden = !(w.scrollY > w.innerHeight * 0.55) || !menu.hidden; });
  }
  w.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ---- what waits for a real visitor: analytics and the studio's early wake-up (site/patches/snippets) --------------------
  var later = script && script.getAttribute('data-later'), asked = false;
  function ask() {
    if (asked || !later) return;
    asked = true;
    var s = d.createElement('script');
    s.src = later;
    s.async = true;
    d.head.appendChild(s);
  }
  ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach(function (ev) { w.addEventListener(ev, ask, { once: true, passive: true }); });
  setTimeout(ask, 15000);

  // ---- small things --------------------------------------------------------------------------------------------------
  var yr = $('#yr');
  if (yr) yr.textContent = String(new Date().getFullYear());
  var film = $('video[data-src]');
  if (film && 'IntersectionObserver' in w) {
    var fio = new IntersectionObserver(function (es) {
      if (!es[0].isIntersecting) { film.pause(); return; }
      if (!film.src) { film.muted = true; film.src = film.getAttribute('data-src'); }
      film.play().then(function () { film.classList.add('on'); }, function () {});
    }, { rootMargin: '500px 0px' });
    fio.observe(film);
  }
})();
