// The landing hero's louvres ("curtain"), spliced into the page component's class body by the `hero-curtain` step of
// site/patches/home.json (this is a class-body fragment, not a standalone script; tests/js/site-patches.test.js parses it inside a class).
// It replaces the export's buildFins() (the export's own copy stays below as buildFinsOld, unused) and the fin loop of fxHero().
//
// Why: the export opened 14 (7 on a phone) fins by assigning every fin's transform, and two children's opacity, from the frame loop, on
// a wall clock that started 450 ms after mount: under the loader's own slats, and while three.js started up (a 110-170 ms main-thread
// block inside the opening, measured at 4x CPU slowdown, which showed as a jump in the louvres). Here:
//   * the opening is a Web Animation per fin (transform and opacity only, so it keeps running on the compositor while the main thread
//     is busy), started when the page loader leaves (it fires "tc-ld-exit" on window; without a loader, 450 ms after mount as before);
//   * the scroll part (up to 36 degrees more) is assigned only when the hero's progress changes, as one transform per fin and one
//     opacity on the whole set (the export's pointer-follow tilt of the fins is dropped);
//   * fewer, larger fins (9, 5 on a phone) with the same timber as the loader's curtain, a lit edge and a warm light that passes over
//     them while they open;
//   * the 3D façade (the 110-170 ms block when three.js starts) is started after the opening, when the browser is idle, or earlier when
//     its section is about to be seen.
// prefers-reduced-motion (or the Calm setting): the fins are simply at rest, open, from the start.

  finTimber = () => (this.props.louvre ?? 'Bronze') !== 'Bone'
    ? 'linear-gradient(90deg,#160d05 0%,#2a1c10 16%,#4a3322 42%,#6d4d38 50%,#4a3322 58%,#2a1c10 84%,#160d05 100%)'
    : 'linear-gradient(90deg,#b3a592 0%,#d3c6b3 28%,#e4d9c9 50%,#cdbfac 74%,#a89985 100%)';

  buildFins = () => {
    const host = this.q('[data-louvres]'); if (!host) return;
    (this.finAnims || []).forEach(a => { try { a.cancel(); } catch (_) {} });
    this.finAnims = [];
    host.innerHTML = '';
    host.style.perspective = '2400px';
    const n = this.mobile ? 5 : 9;
    const bronze = (this.props.louvre ?? 'Bronze') !== 'Bone';
    const ink = bronze ? '#E1D4C2' : '#291C0E';
    const mk = (css) => { const e = document.createElement('div'); e.style.cssText = css; return e; };
    this.fins = [];
    for (let i = 0; i < n; i++) {
      const f = mk('position:relative;flex:1 1 0;height:100%;transform-style:preserve-3d');
      const g = mk('position:absolute;inset:0;transform-style:preserve-3d;backface-visibility:hidden');
      const face = mk(`position:absolute;top:0;bottom:0;left:-.5px;right:-.5px;background:${this.finTimber()};overflow:hidden;box-shadow:inset 1px 0 0 rgba(245,179,87,.16)`);
      const word = mk(`position:absolute;top:0;bottom:0;left:${-i * 100}%;width:${n * 100}%;display:flex;align-items:center;justify-content:center;font:500 ${this.mobile ? 18 : 15.5}cqw/1 Switzer,Helvetica,Arial,sans-serif;letter-spacing:.02em;color:${ink};white-space:nowrap`);
      word.textContent = 'TERUCON';
      const shade = mk('position:absolute;inset:0;background:#0d0803;opacity:0');
      face.append(word, shade); g.append(face); f.append(g); host.append(f);
      this.fins.push({ f, g, word, shade });
    }
    const light = mk('position:absolute;top:0;bottom:0;left:0;width:100%;pointer-events:none;opacity:0;background:linear-gradient(100deg,transparent 34%,rgba(255,206,140,.08) 43%,rgba(255,226,176,.22) 50%,rgba(255,206,140,.08) 57%,transparent 66%)');
    host.append(light);
    this.finLight = light;
    this.finP = undefined;
    if (this.introBegun) this.playFins(true);
  }

  playFins = (instant) => {
    const F = this.fins || []; if (!F.length) return;
    (this.finAnims || []).forEach(a => { try { a.cancel(); } catch (_) {} });
    const n = F.length, c = (n - 1) / 2;
    const D = instant || this.reduced ? 0 : 1800, S = instant || this.reduced ? 0 : 640;
    this.finAnims = [];
    F.forEach((x, i) => {
      const dd = c ? Math.abs(i - c) / c : 0;
      const o = { duration: D, delay: dd * S, easing: 'cubic-bezier(.65,0,.25,1)', fill: 'both' };
      this.finAnims.push(
        x.g.animate([{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(56deg)' }], o),
        x.shade.animate([{ opacity: 0 }, { opacity: .38 }], o),
        x.word.animate([{ opacity: 1 }, { opacity: 0, offset: .35 }, { opacity: 0 }], o)
      );
    });
    if (D && this.finLight) {
      this.finAnims.push(this.finLight.animate(
        [{ opacity: 0, transform: 'translateX(-100%)' }, { opacity: 1, transform: 'translateX(-35%)', offset: .25 }, { opacity: 1, transform: 'translateX(35%)', offset: .75 }, { opacity: 0, transform: 'translateX(100%)' }],
        { duration: D + S * .6, delay: 120, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'both' }
      ));
    }
  }

  // the opening starts when the page loader leaves (it fires tc-ld-exit); with no loader on the page, 450 ms after mount as before
  waitIntro = () => {
    this.introStart = Infinity;
    const up = !this.reduced && !!window.TeruconLoader && document.documentElement.classList.contains('tc-ld-lock');
    const begin = () => {
      if (this.introBegun) return;
      this.introBegun = true;
      removeEventListener('tc-ld-exit', begin); clearTimeout(this.introTimer);
      this.introStart = performance.now() + (up ? 0 : 450);
      if (up || this.reduced) this.playFins(); else setTimeout(() => this.playFins(), 450);
      if (this.start3D) this.start3D();
    };
    if (up) { addEventListener('tc-ld-exit', begin); this.introTimer = setTimeout(begin, 20000); }
    else begin();
  }

  // the 3D façade is far below the hero: start it after the opening, when idle, or when its section is about to be seen
  lazy3D = () => {
    const host = this.q('[data-3d]');
    const go = () => { if (this.lazyDone) return; this.lazyDone = true; this.init3D(); };
    this.start3D = () => setTimeout(() => { if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 3000 }); else setTimeout(go, 600); }, 2600);
    if (host && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) { io.disconnect(); go(); } }, { rootMargin: '1200px 0px' });
      io.observe(host);
    } else if (!host) go();
  }

  // the scroll part of the opening: written only when the hero's progress changed
  fxFins = (p) => {
    const q = Math.round(p * 400) / 400;
    if (q === this.finP || !this.fins) return;
    this.finP = q;
    const t = q ? `rotateY(${(q * 36).toFixed(2)}deg)` : '';
    for (let i = 0; i < this.fins.length; i++) this.fins[i].f.style.transform = t;
    const host = this.fins[0] && this.fins[0].f.parentNode;
    if (host) host.style.opacity = q > .82 ? (1 - (q - .82) / .18).toFixed(3) : '';
  }
