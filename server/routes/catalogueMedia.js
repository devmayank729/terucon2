/**
 * The pictures of the catalogue designs (targets A1, C1, C4): /media/materials/tipl-sb804.jpg is read from Google Cloud Storage, through the design's
 * record in MongoDB (server/catalogue/designs.js), when somebody asks for it. No picture of a catalogue design is a file of this project or of this
 * server any more: the 63 files that used to sit in media/materials/ are gone. The address did not change, so the shop, TeruBot, the Finder and the
 * Design Studio's finish list all keep asking for the same path.
 *
 *   GET /media/materials/tipl-sb804.jpg          the 800 px picture (the 320 px thumbnail while a design has none of its own)
 *   GET /media/materials/tipl-sb804.jpg?w=320    the 320 px thumbnail (any ?w= up to 400)
 *   GET /media/materials/tipl-sb804.jpg?tile=1   a seamlessly-tileable crop of the same picture (target C1: the Design Studio's instant preview;
 *                                                 see server/lib/tileTexture.js for why a plain photo needs this and server/catalogue/studioFinishes.js
 *                                                 for where the address is given to the studio). Computed once per picture and kept in memory.
 *
 * Only a design the database lists is answered (the id is checked against the list, never put in a bucket address), so this is not a way to read
 * the bucket. Public, like the files it replaces: they were public product pictures. A design that is not listed is a plain 404; a design whose
 * picture the bucket did not give (no database, no signing key, Cloud Storage down) is answered with a neutral tile that says so, never cached,
 * so the shop shows a quiet square instead of a broken image and the next visit tries again. A `?tile=1` request that cannot be made seamless
 * (the picture is not a JPEG, or the crop failed) quietly falls back to the plain picture rather than fail: a non-tiling preview beats none.
 */
import { SLUG } from '../catalogue/designs.js';
import { notFound } from '../middleware/errorHandler.js';
import { makeSeamlessTile } from '../lib/tileTexture.js';

const FILE = /^(tipl-[a-z]{2,4}\d{2,5})\.jpg$/;
const THUMB_MAX_W = 400;
const FRESH_S = 3600;
const STALE_S = 86400;

// The seamless crop is real CPU work (a JPEG decode, a few pixel passes, a re-encode): keep each design's result
// in memory, keyed to the picture it was made from (found.tag), so a changed picture makes a new one and an
// unchanged one never recomputes. Bounded and FIFO, not a true LRU: 63 designs' worth is a few MB at most, and
// this is a cache for repeat requests of the same small set, not a general-purpose store.
const TILE_CACHE_MAX = 128;
const tileCache = new Map();
function cachedTile(key, make) {
  const hit = tileCache.get(key);
  if (hit) return hit;
  const made = make();
  tileCache.set(key, made);
  if (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  return made;
}

const escapeXml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

/** A quiet 2:3 tile in the design's colour (or a neutral one) with its code: what stands in for a picture that could not be read. */
export function tileSvg(code, hex) {
  const fill = /^#[0-9a-f]{6}$/i.test(hex ?? '') ? hex : '#d8d1c6';
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(fill.slice(i, i + 2), 16));
  const ink = r * 0.299 + g * 0.587 + b * 0.114 > 150 ? '#2b2118' : '#f4eee6';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 480" role="img" aria-label="${escapeXml(code)}: picture not available right now"><rect width="320" height="480" fill="${fill}"/><text x="160" y="236" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="26" font-weight="600" letter-spacing="2" fill="${ink}">${escapeXml(code)}</text><text x="160" y="266" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="13" fill="${ink}" opacity="0.7">picture not available right now</text></svg>`;
}

/** The handler for /media/materials/:file. Calls next() for anything that is not a catalogue design's picture (the static media route then answers). */
export function catalogueImageHandler(ctx) {
  return async (req, res, next) => {
    const match = FILE.exec(req.params.file ?? '');
    if (!match || !SLUG.test(match[1])) return next();
    const designs = ctx.catalogue?.designs;
    if (!designs) return next();
    const slug = match[1];
    try {
      const all = await designs.list();
      const design = all.find((d) => d.id === slug);
      // a catalogue that lists designs and not this one: no such picture. A catalogue that lists nothing is not set up (or empty): the quiet tile below
      if (!design && all.length) return notFound(req, res);
      if (!design) throw Object.assign(new Error('no catalogue'), { name: 'NoCatalogue' });
      const tiling = req.query.tile === '1';
      const wanted = Number.parseInt(String(req.query.w ?? ''), 10);
      const size = tiling ? 'card' : Number.isFinite(wanted) && wanted > 0 && wanted <= THUMB_MAX_W ? 'thumb' : 'card';
      const found = await designs.image(slug, size);
      if (!found) {
        res.status(200).set({ 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store', 'X-Terucon-Picture': 'unavailable' }).send(tileSvg(design.code, design.hex));
        return;
      }
      let { bytes, type, tag } = found;
      if (tiling && found.type === 'image/jpeg') {
        try {
          const made = cachedTile(`${slug}:${found.tag}`, () => makeSeamlessTile(found.bytes));
          bytes = made.buffer;
          tag = `${found.tag}-tile`;
        } catch (error) {
          ctx.log?.warn?.(`catalogue tile of ${slug} could not be made, serving the plain picture: ${String(error?.message ?? error).slice(0, 80)}`);
        }
      }
      const etag = `"${tag}"`;
      res.set({ 'Content-Type': type, 'Cache-Control': `public, max-age=${FRESH_S}, stale-while-revalidate=${STALE_S}`, ETag: etag });
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.set('Content-Length', String(bytes.length));
      res.end(bytes);
    } catch (error) {
      // the database is down or the catalogue is not set up: the same quiet tile, and never a cached one
      const code = slug.replace(/^tipl-/, '').toUpperCase();
      res.status(200).set({ 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store', 'X-Terucon-Picture': 'unavailable' }).send(tileSvg(code, null));
      if (error?.name !== 'NoCatalogue') ctx.log?.warn?.(`catalogue  picture of ${slug} not available: ${String(error?.name ?? 'error').slice(0, 40)}`);
    }
  };
}
