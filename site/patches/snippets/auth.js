// Sign-in on the exported pages (the account and sign-in pages themselves are written by hand and do not use this).
//  1. The header link to the account page says "Sign in" for somebody who is not signed in (only the landing page can be open to
//     them) and keeps saying "Account" for a member. It asks GET /api/auth/me, which is a plain yes / no and never sends any detail.
//  2. If one of the website's own requests is answered "please sign in" (the session ended while the page was open, for instance
//     in another tab), the visitor is taken to the sign-in page, and back here afterwards, instead of seeing the page's own error.
// Plain ES5 on purpose: it runs inside every exported page, whatever the page's own code does. Also: no camelCase name directly
// before an "=" (a variable, not a property after a dot): the exported pages' runtime rewrites those in the whole page text
// (it thinks they are HTML attributes, ` viewBox=`), which turns `var realFetch = ...` into a syntax error. tests/js/site-patches.test.js checks.
(function () {
  if (window.__terucon_auth) return;
  window.__terucon_auth = true;
  var nativefetch = window.fetch;

  if (typeof nativefetch === 'function') {
    window.fetch = function () {
      return nativefetch.apply(this, arguments).then(function (res) {
        if (res && res.status === 401) {
          try {
            res.clone().json().then(function (body) {
              if (body && body.code === 'auth-required') location.assign('/login?next=' + encodeURIComponent(location.pathname));
            }).catch(function () {});
          } catch (e) {}
        }
        return res;
      });
    };
  }

  function relabel() {
    var links = document.querySelectorAll('a[data-terucon-account]');
    if (!links.length || typeof nativefetch !== 'function') return;
    nativefetch('/api/auth/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (me) {
        if (!me || me.authenticated !== false) return;
        for (var i = 0; i < links.length; i += 1) {
          links[i].textContent = 'Sign in';
          links[i].setAttribute('href', '/login');
        }
      })
      .catch(function () {});
  }

  // the dashboard's profile menu has a "Sign out" item that only linked to the home page: the patch renamed it and marked it, and
  // here it is sent to the account page, where signing out (and deleting the account) are
  document.addEventListener('click', function (e) {
    var item = e.target && e.target.closest ? e.target.closest('[data-terucon-account-menu]') : null;
    if (!item) return;
    e.preventDefault();
    location.assign('/account');
  }, true);

  // the exported pages draw their header after they load, so look again a little later
  if (document.readyState === 'complete') relabel();
  else window.addEventListener('load', relabel);
  setTimeout(relabel, 1500);
  setTimeout(relabel, 4000);
})();
