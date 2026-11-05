/* The catalogue's designs in the Design Studio's finish list (targets C1, A1).
 *
 * The studio (swatchroom/, a verbatim copy: never edited) builds its finish picker from one object, CATALOG, in /js/data/catalog.js, and draws each card
 * from code. This file is the studio's loader step (the `catalogue-loader` step of site/patches/studio.json replaces the studio page's loader with one that
 * runs addCatalogueFinishes() first and starts the studio after it, whatever the outcome):
 *
 *   1. asks GET /api/catalogue/studio-finishes (the designs from MongoDB: name, code, the brief for the render model, the address of the picture);
 *   2. adds them to CATALOG as a group "Terucon catalogue", first in the list, for the kinds of surface the server names. The studio is not started yet, so
 *      it builds its index of finishes after they are in it (it builds that index once, the first time it looks a finish up);
 *   3. while the studio runs, puts the design's real photograph on its card (the studio draws cards in code and has no picture type): a card whose text
 *      names a catalogue id (TIPL-SB804) gets an <img> of /media/materials/tipl-sb804.jpg?w=320, which the server reads from Cloud Storage.
 *
 * Each kind of surface gets its own item (the studio forgets the selected finish when its kind is not the clicked surface's: itemFitsKind in studio.js),
 * so the id is the design's for a wall and `<id>-door`, `<id>-furniture` for the others. Each item carries a `texture` (the design's own photograph, see
 * textureOf() below) so the instant in-browser preview (WebGL2 / WebGPU) draws it the moment it is picked, like the studio's own finishes; before 2026-11-05 these
 * items had none and could only be rendered by the AI. Both paths stay: Render sends the AI the same design with its photograph as a reference, added by the
 * server (server/lib/studioReference.js).
 *
 * A failure at any step leaves the studio exactly as it was: no group, no error shown.
 */

const ENDPOINT = '/api/catalogue/studio-finishes';
const WAIT_MS = 4000;
const CARD_ID = /\b(TIPL-[A-Z]{2,4}\d{2,5})\b/;

const SHEENS = ['matte', 'satin', 'semi-gloss', 'gloss', 'metallic'];

/**
 * The texture of one finish, from what the server sent, or null (the finish then renders with the AI only, exactly as before). Only what the preview reads is
 * copied, and checked: the picture must be one of the site's design pictures, the size a positive number. The size is named previewTile*: the studio's own
 * tileWidthM / tileHeightM are quoted to the render model as a measured repeat (swatchroom/public/js/lib/prompts.js), and this one is an assumption.
 */
export function textureOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const width = Number(raw.previewTileWidthM);
  const height = Number(raw.previewTileHeightM);
  if (typeof raw.url !== 'string' || !/^\/media\/materials\/tipl-[a-z]{2,4}\d{2,5}\.jpg(\?tone=\d{1,3})?$/.test(raw.url)) return null;
  if (!(width > 0 && width <= 10 && height > 0 && height <= 10)) return null;
  const texture = { url: raw.url, previewTileWidthM: width, previewTileHeightM: height };
  if (SHEENS.includes(raw.sheen)) texture.sheen = raw.sheen;
  return texture;
}

/** @returns {Promise<{added: number, state: string}>} */
export async function addCatalogueFinishes() {
  if (window.TeruconStudioCatalogue) return { added: window.TeruconStudioCatalogue.added, state: 'already' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WAIT_MS);
  let data;
  try {
    const answer = await fetch(ENDPOINT, { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!answer.ok) return { added: 0, state: `http-${answer.status}` };
    data = await answer.json();
  } catch {
    return { added: 0, state: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
  if (!data || !Array.isArray(data.finishes) || !data.finishes.length || !Array.isArray(data.kinds)) return { added: 0, state: String(data?.state ?? 'empty') };

  let catalog;
  try {
    ({ CATALOG: catalog } = await import('/js/data/catalog.js'));
  } catch {
    return { added: 0, state: 'no-catalog' };
  }
  const byKind = {};
  for (const kind of data.kinds) {
    if (!Array.isArray(catalog[kind])) continue;
    const items = [];
    for (const f of data.finishes) {
      if (typeof f.id !== 'string' || typeof f.name !== 'string' || typeof f.prompt !== 'string') continue;
      const texture = textureOf(f.texture);
      items.push({
        id: kind === 'wall' ? f.id : `${f.id}-${kind}`,
        name: f.name,
        sub: String(f.sub ?? ''),
        about: String(f.about ?? ''),
        mode: 'surface',
        swatch: { type: 'paint', hex: /^#[0-9a-f]{6}$/i.test(f.hex ?? '') ? f.hex : '#cfc7bb' },
        prompt: f.prompt,
        catalogue: true,
        // a fresh object per item: the studio may keep or change an item without touching the one of another kind
        ...(texture ? { texture: { ...texture } } : {}),
      });
    }
    if (!items.length) continue;
    catalog[kind].unshift({ group: String(data.group ?? 'Terucon catalogue'), items });
    byKind[kind] = items.length;
  }
  const images = new Map(data.finishes.filter((f) => typeof f.productId === 'string' && typeof f.image === 'string' && f.image.startsWith('/media/materials/')).map((f) => [f.productId, { src: f.image, hex: f.hex }]));
  window.TeruconStudioCatalogue = { added: data.finishes.length, kinds: byKind, images };
  watchCards(images);
  return { added: data.finishes.length, state: 'ok' };
}

/** Put each design's photograph on its card, and keep doing it while the studio redraws its lists. */
function watchCards(images) {
  let queued = false;
  const pass = () => {
    queued = false;
    for (const tile of document.querySelectorAll('.sr-tile[title*="TIPL-"]')) {
      const art = tile.querySelector('.sr-tile-art');
      if (!art || art.querySelector('img.tc-design-photo')) continue;
      const found = CARD_ID.exec(tile.getAttribute('title') ?? '');
      const picture = found && images.get(found[1]);
      if (!picture) continue;
      const img = document.createElement('img');
      img.className = 'tc-design-photo';
      img.alt = '';
      img.decoding = 'async';
      img.loading = 'lazy';
      img.draggable = false;
      Object.assign(img.style, { display: 'block', width: '100%', height: '100%', objectFit: 'cover' });
      img.addEventListener('error', () => {
        img.remove();
        if (picture.hex) art.style.background = picture.hex; // the card keeps the design's colour
      });
      img.src = picture.src;
      art.replaceChildren(img);
    }
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(pass);
  };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();
}
