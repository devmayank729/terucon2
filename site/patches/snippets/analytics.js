// PostHog on every page. It asks the website where to send events (GET /api/analytics, server/routes/analytics.js), so no key is
// written into the pages; when the answer is "not enabled" (no key, or the site is open on this computer only) nothing is loaded
// and nothing is sent. Plain ES5 on purpose: it runs inside every exported page, whatever the page's own code does.
//
// What is recorded: page views and leaves, a "cta_click" for every link or button (its words and where it goes; on the My project
// page only where it goes), a "form_submit" for every form (never what was typed), page speed, script errors, and the studio's
// own events (swatchroom-app.js calls window.posthog.capture). Session replay is on when the server says so, with every letter and
// every field masked and every photo, canvas and video blocked, so a room photo is never recorded.
// A browser that sends Do Not Track or Global Privacy Control is left alone.
(function () {
  if (window.__terucon_analytics) return;
  window.__terucon_analytics = true;
  var nav = navigator;
  if (nav.doNotTrack === '1' || window.doNotTrack === '1' || nav.globalPrivacyControl) return;

  var path = location.pathname.replace(/\/+$/, '') || '/';
  var PAGES = { '/': 'home', '/index.html': 'home', '/materials': 'materials', '/design-studio': 'studio', '/my-project': 'dashboard' };
  var page = PAGES[path] || (path === '/coming-soon' ? 'coming-soon' : 'other');

  function cookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? m[1] : '';
  }

  function label(el) {
    // The words on a link or button. Never read on the My project page: it shows a client's own project.
    if (page === 'dashboard') return '';
    var text = (el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return text.length > 60 ? text.slice(0, 60) : text;
  }

  function target(el) {
    var href = el.getAttribute && el.getAttribute('href');
    if (!href) return {};
    if (/^(mailto|tel|sms):/i.test(href)) return { href_kind: href.split(':')[0].toLowerCase() };
    try {
      var url = new URL(href, location.href);
      if (url.host !== location.host) return { href_kind: 'external', href_host: url.host };
      return { href_kind: 'page', href_path: url.pathname + url.hash };
    } catch (e) {
      return {};
    }
  }

  function wire(ph) {
    document.addEventListener(
      'click',
      function (e) {
        var el = e.target && e.target.closest ? e.target.closest('a,button,[role="button"]') : null;
        if (!el) return;
        var props = target(el);
        var text = label(el);
        if (!text && !props.href_kind) return;
        props.label = text;
        props.page_type = page;
        props.area = (el.closest('header') && 'header') || (el.closest('footer') && 'footer') || (el.closest('nav') && 'menu') || 'page';
        ph.capture('cta_click', props);
      },
      true
    );
    document.addEventListener(
      'submit',
      function (e) {
        var form = e.target;
        ph.capture('form_submit', { form: (form && (form.id || form.getAttribute('name') || form.getAttribute('data-form'))) || 'form', page_type: page });
      },
      true
    );
  }

  function start(config) {
    if (!config || !config.enabled || !config.key || !config.host) return;
    var script = document.createElement('script');
    script.async = true;
    script.src = config.host.replace('.i.posthog.com', '-assets.i.posthog.com') + '/static/array.js';
    script.onload = function () {
      var ph = window.posthog;
      if (!ph || !ph.init || ph.__loaded) return; // already started by something else on the page
      ph.init(config.key, {
        api_host: config.host,
        person_profiles: 'identified_only',
        autocapture: false, // the events above say what matters, without the page's own text
        capture_pageview: true,
        capture_pageleave: true,
        capture_performance: true,
        capture_exceptions: true,
        disable_surveys: true,
        disable_session_recording: !config.replay,
        secure_cookie: location.protocol === 'https:',
        session_recording: {
          maskAllInputs: true,
          maskTextSelector: '*',
          blockSelector: 'img,canvas,video,picture,svg image',
        },
        loaded: function (p) {
          // the studio's own server events are keyed by this id (swr_vid), so the two sides can be joined
          var vid = cookie('swr_vid');
          p.register({ site: 'terucon', page_type: page, visitor_id: vid || undefined });
        },
      });
      wire(ph);
    };
    document.head.appendChild(script);
  }

  function ask() {
    fetch('/api/analytics', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(start)
      .catch(function () {});
  }

  if (document.readyState === 'complete') ask();
  else window.addEventListener('load', ask);
})();
