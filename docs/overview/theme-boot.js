(function () {
  try {
    var t = localStorage.getItem('terucon-overview-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage can be blocked; the system setting applies */ }
})();
