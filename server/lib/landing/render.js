/**
 * The landing page's markup: the repeated parts (menus, slides, lists, cards) that site/landing/page.html leaves as {{markers}}.
 * Everything here is a pure function of site/landing/content.json, config.json and the picture index (img/index.json).
 *
 * Pictures: an `img` tag is written only for a picture that is in the index. A picture that is not there (the six project photos, the
 * client logos and TeruBot's face were not delivered with the design) gets its designed fallback instead: a text card, a monogram, a
 * drawn face. So the page never asks for a file that is not there, which is what an error in the browser's console would be.
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/** The <img> for picture `id`, or '' when it is not in the index. `sizes` is what the browser needs to choose a width. */
export function imgTag(c, id, { alt = '', sizes = '100vw', cls = '', eager = false, priority = false, w, h } = {}) {
  const e = c.img[id];
  if (!e) return '';
  const vs = e.variants;
  const src = vs[Math.min(vs.length - 1, Math.floor(vs.length / 2))];
  const srcset = vs.map((v) => `${c.url(v.file)} ${v.w}w`).join(', ');
  return `<img src="${c.url(src.file)}" srcset="${srcset}" sizes="${sizes}" width="${w ?? e.w}" height="${h ?? e.h}" alt="${esc(alt)}"${cls ? ` class="${cls}"` : ''}${eager ? '' : ' loading="lazy" decoding="async"'}${priority ? ' fetchpriority="high"' : ''}>`;
}

const srcsetOf = (c, id) => c.img[id].variants.map((v) => `${c.url(v.file)} ${v.w}w`).join(', ');

export function logo(c, { sizes, w, h, eager }) {
  return (
    imgTag(c, 'logo', { alt: 'Terucon India', sizes, w, h, eager }) ||
    '<span class="logo-t"><b aria-hidden="true">T</b><span>Terucon India</span></span>'
  );
}

/** One hero slide. The first is in the page itself (it is the largest thing on the first screen), the rest come with a template. */
function heroSlide(c, i) {
  const h = c.content.hero[i];
  const L = `hero-0${i + 1}`;
  const M = `${L}-m`;
  const first = i === 0;
  const e = c.img[L];
  const vs = e.variants;
  const src = vs[vs.length - 1];
  return (
    `<div class="slide${first ? ' is-on pre' : ''}" role="group" aria-roledescription="slide" aria-label="${i + 1} of ${c.content.hero.length}: ${esc(h.label)}" aria-hidden="${first ? 'false' : 'true'}">` +
    `<picture><source media="(orientation: portrait)" srcset="${srcsetOf(c, M)}" sizes="100vw">` +
    `<img src="${c.url(src.file)}" srcset="${srcsetOf(c, L)}" sizes="100vw" width="${e.w}" height="${e.h}" alt="${esc(h.alt)}"${first ? ' fetchpriority="high"' : ' decoding="async"'}></picture></div>`
  );
}

const navLink = (n, cls = '') => `<a href="#${n.id}"${cls}>${esc(n.label)}</a>`;

export function sections(c) {
  const { content, cfg } = c;
  const out = {};
  const phoneDigits = cfg.phone.replace(/\D/g, '');
  const wa = (text) => `https://wa.me/${phoneDigits}?text=${encodeURIComponent(text)}`;

  out.nav_desktop = content.nav.slice(1).map((n) => navLink(n)).join('');
  out.nav_menu = content.nav
    .map((n, i) => `<a href="#${n.id}"><span class="n">${String(i + 1).padStart(2, '0')}</span><span><b>${esc(n.label)}</b><small>${esc(n.sub)}</small></span></a>`)
    .join('');
  out.platform_menu = content.platform.map((p) => `<a class="pill" href="${esc(p.href)}">${esc(p.label)}</a>`).join('');
  out.platform_footer = content.platform.map((p) => `<a href="${esc(p.href)}">${esc(p.label)}</a>`).join('');
  out.footer_nav = content.nav.map((n) => navLink(n)).join('');

  out.logo = logo(c, { sizes: '132px', w: 132, h: 84, eager: true });
  out.footer_logo = logo(c, { sizes: '190px', w: 190, h: 120 });

  // ---- hero ----
  out.hero_slide_1 = heroSlide(c, 0);
  out.hero_more = content.hero.slice(1).map((_, i) => heroSlide(c, i + 1)).join('');
  out.hero_cap_1 = esc(content.hero[0].cap);
  out.hero_picker = content.hero
    .map((h, i) => `<button class="pk" type="button" aria-label="Slide ${i + 1} of ${content.hero.length}: ${esc(h.label)}" aria-current="${i === 0}" data-cap="${esc(h.cap)}"><span class="pk__bar" aria-hidden="true"><span class="pk__f"></span></span><span class="pk__l"><span class="pk__n">0${i + 1}</span><span class="pk__t">${esc(h.label)}</span></span></button>`)
    .join('');

  // ---- clients: three copies for the seamless loop, the copies hidden from screen readers; a monogram when there is no logo ----
  const clientLi = (cl, dup) => {
    const initials = cl.name.split(' ').map((x) => x[0]).join('').slice(0, 2).toUpperCase();
    const logoImg = imgTag(c, `client-${cl.slug}`, { alt: '', sizes: '160px', w: 160, h: 60 });
    return `<li${dup ? ' aria-hidden="true"' : ''}><span class="mq__m">${logoImg || `<b aria-hidden="true">${esc(initials)}</b>`}</span><span class="mq__n">${esc(cl.name)}</span></li>`;
  };
  out.clients = [0, 1, 2].flatMap((r) => content.clients.map((cl) => clientLi(cl, r > 0))).join('');

  // ---- disciplines ----
  out.disc_list = content.disciplines
    .map((d, i) => {
      const alt = `${d.title} by Terucon India`;
      return (
        `<details class="d" name="disc"${i === 0 ? ' open' : ''} data-t="${esc(d.title)}"><summary><span class="n">0${i + 1}</span><h3>${esc(d.title)}</h3><span class="sign" aria-hidden="true"></span></summary>` +
        `<div class="d__p"><div class="d__img">${imgTag(c, `disc-${d.slug}`, { alt, sizes: '100vw', w: 1200, h: 1500 })}</div>` +
        `<p class="d__s">${esc(d.summary)}</p><p class="d__d">${esc(d.detail)}</p>` +
        `<ul class="d__t" aria-label="Scope">${d.scope.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` +
        `<button class="d__go" type="button" data-s="${esc(d.title)}">Discuss this service <span aria-hidden="true">→</span></button></div></details>`
      );
    })
    .join('');
  out.disc_stack = content.disciplines
    .map((d, i) => imgTag(c, `disc-${d.slug}`, { alt: `${d.title} by Terucon India`, sizes: '(min-width:1440px) 620px, 42vw', cls: i === 0 ? 'on' : '', w: 1200, h: 1500 }))
    .join('');
  out.disc_title_1 = esc(content.disciplines[0].title);

  // ---- material library ----
  out.shades = content.shades
    .map((s) => {
      const text = `Hi, I am interested in ${s.code} ${s.name} from the Superbond ACP catalogue. Please share price and availability.`;
      return (
        `<li><a class="shade" href="${esc(wa(text))}" target="_blank" rel="noopener"><span class="shade__m">${imgTag(c, `shade-${s.code.toLowerCase()}`, { alt: `${s.code} ${s.name} Superbond ACP sheet`, sizes: '(min-width:1024px) 220px, 44vw', w: 1000, h: 1000 })}</span>` +
        `<span class="shade__c"><span>${esc(s.code)}</span><span aria-hidden="true">↗</span></span><span class="shade__n">${esc(s.name)}</span><span class="shade__s">CMT Series · Price on request</span></a></li>`
      );
    })
    .join('');

  // ---- signature work: the first project is the featured one (landing.js moves that on when a filter is chosen) ----
  out.filters = content.filters
    .map((f, i) => {
      const n = content.projects.filter((p) => f === 'All' || p.cats.includes(f)).length;
      return `<button class="fb" type="button" data-f="${esc(f)}" aria-pressed="${i === 0}">${esc(f)}<span aria-hidden="true">${String(n).padStart(2, '0')}</span></button>`;
    })
    .join('');
  out.projects = content.projects
    .map((p, i) => {
      const hasImg = !!c.img[`project-${p.slug}`];
      const img = hasImg ? `<div class="pm">${imgTag(c, `project-${p.slug}`, { alt: `${p.title} — ${p.scope}`, sizes: '(min-width:1100px) 460px, 100vw' })}</div>` : '';
      return (
        `<article class="pj${hasImg ? ' has-img' : ''}${i === 0 ? ' is-feature' : ''}" data-cats="${esc(p.cats.join('|'))}">${img}<div class="pj__body"><div class="pj__h">` +
        `<p class="pj__k">Featured · ${esc(p.sector)}</p><p class="pj__meta"><span>${esc(p.loc)}</span><span>${esc(p.sector)}</span></p>` +
        `<h3>${esc(p.title)}</h3><p class="pj__s">${esc(p.scope)}</p></div>` +
        `<dl><dt>Location</dt><dd>${esc(p.loc)}</dd><dt>Delivered</dt><dd>${esc(p.services)}</dd></dl></div></article>`
      );
    })
    .join('');

  // ---- studio directions ----
  out.dir_main = content.directions
    .map((d, i) => imgTag(c, `studio-${d.slug}`, { alt: `AI visualisation of a reception finished in ${d.label}`, sizes: '(min-width:1440px) 620px, (min-width:900px) 45vw, 100vw', cls: i === 0 ? 'on' : '', w: 1600, h: 1200 }))
    .join('');
  out.dir_label_1 = esc(content.directions[0].label);
  out.dir_tabs = content.directions
    .map((d, i) => `<button class="th" type="button" data-l="${esc(d.label)}" aria-pressed="${i === 0}"><span class="th__m">${imgTag(c, `studio-${d.slug}`, { alt: '', sizes: '160px', w: 400, h: 300 })}</span><span class="th__t">${esc(d.label)}</span></button>`)
    .join('');

  out.firm_img = imgTag(c, 'firm-material-desk', { alt: 'ACP swatches, stone and timber samples laid out with architectural drawings', sizes: '(min-width:1440px) 620px, (min-width:900px) 45vw, 100vw', w: 1600, h: 1280 });

  // ---- journal ----
  out.journal = content.journal
    .map((j) => `<article data-reveal><a class="jc" href="#journal"><span class="jm">${imgTag(c, `journal-${j.slug}`, { alt: j.alt, sizes: '(min-width:1100px) 430px, 100vw', w: 1500, h: 1000 })}</span><span class="jc__m"><span>${esc(j.tag)}</span><span>${esc(j.read)}</span></span><h3>${esc(j.title)}</h3><span class="jc__s">${esc(j.summary)}</span></a></article>`)
    .join('');

  // ---- the form's service chips (radio buttons: no script needed to choose one) ----
  out.chips = content.services
    .map((s, i) => `<label class="chip"><input type="radio" name="service" value="${esc(s)}"${i === 0 ? ' checked' : ''}><span>${esc(s)}</span></label>`)
    .join('');

  // ---- questions (native <details>: no script) ----
  out.faq = content.faq
    .map((f, i) => `<details class="q" name="faq"${i === 0 ? ' open' : ''}><summary><h4>${esc(f.q)}</h4><span class="sign" aria-hidden="true"></span></summary><p>${esc(f.a)}</p></details>`)
    .join('');

  // ---- the closing picture (and the film, only when config.json gives an address for one) ----
  out.film =
    imgTag(c, 'film-poster', { alt: '', sizes: '100vw', w: 1920, h: 1200 }) +
    (cfg.filmUrl ? `<video data-src="${esc(cfg.filmUrl)}" preload="none" loop muted playsinline aria-hidden="true"></video>` : '');

  out.studioPath = esc(cfg.studioPath);
  out.ext = esc(cfg.externalBase);
  out.phone = esc(cfg.phone);
  out.phoneDigits = phoneDigits;
  out.phoneDisplay = esc(cfg.phoneDisplay);
  out.email = esc(cfg.email);
  out.pdf = esc(cfg.brochurePdf);
  out.heroMs = String(Math.round((Number(cfg.heroSeconds) >= 3 && Number(cfg.heroSeconds) <= 30 ? Number(cfg.heroSeconds) : 6.5) * 1000));
  out.year = String(c.year);
  return out;
}

/** The text of a JSON-LD block that is safe inside <script> (no "</script>", no U+2028). */
export const jsonLd = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function structuredData(c) {
  const { content, cfg } = c;
  const site = cfg.siteUrl ? cfg.siteUrl.replace(/\/$/, '') : '';
  const org = {
    '@type': 'GeneralContractor',
    ...(site && { '@id': `${site}/#org`, url: `${site}/` }),
    name: 'Terucon India Private Limited',
    alternateName: 'Terucon India',
    telephone: cfg.phone.replace(/^\+91/, '+91-').replace(/^(\+91-)(\d{5})(\d{5})$/, '$1$2-$3'),
    email: cfg.email,
    foundingDate: '2021',
    priceRange: '₹₹₹',
    address: { '@type': 'PostalAddress', streetAddress: 'No. 4, No. 49/7, 80 Feet Road, 8th Block, Anjanapura BDA Layout', addressLocality: 'Bengaluru', addressRegion: 'Karnataka', postalCode: '560108', addressCountry: 'IN' },
    areaServed: ['Bengaluru', 'Karnataka'],
    openingHours: 'Mo-Sa 09:30-18:30',
    knowsAbout: ['ACP cladding', 'Façades', 'Commercial interiors', 'False ceiling', 'Gypsum partitions', 'Flooring', 'Civil works', 'Painting', 'Aluminium fabrication', 'Glazing'],
  };
  const faq = { '@type': 'FAQPage', mainEntity: content.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) };
  return { '@context': 'https://schema.org', '@graph': [org, faq] };
}
