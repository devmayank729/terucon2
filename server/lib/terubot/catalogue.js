/**
 * TeruBot's use of the catalogue search (server/catalogue/): by words, and by a region of a photo the visitor sent, through the same service,
 * the same checks and the same hourly ceilings as POST /api/catalogue/search-text and /search, for the same kind of asker (a signed-in
 * account; or anybody when sign-in is switched off). When the catalogue is off or not ready the bridge says so (`on: false`) and the tools
 * are not offered to the model at all.
 *
 * Only a few plain fields of each item go to the model (title, category, finish, product code, source name, and what the shop lists for it):
 * no picture addresses, no scores. A card is a shop material (cards come from the shop's data only): a catalogue item that is also a shop
 * product (its product id is the shop product's id, server/lib/shopLink.js) gets one, so the visitor sees the picture, the listed price and a
 * link to the product page.
 */
import { CatalogueError } from '../../catalogue/errors.js';
import { judgePhoto, parseSearchParams, parseTextBody } from '../../catalogue/validate.js';
import { defaultShop, shopBlockFor } from '../shopLink.js';

/**
 * @param {object} p
 * @param {{service: any} | null | undefined} p.catalogue ctx.catalogue (set when the catalogue routes are mounted)
 * @param {{account: string | null, address: string}} p.asker
 * @param {boolean} p.allowed false when the visitor may not use the catalogue (not signed in while sign-in is required)
 * @param {{warn?: Function}} [p.log]
 * @returns {Promise<{on: boolean, search?: (text: string, limit: number) => Promise<object>}>}
 */
export async function catalogueBridge({ catalogue, asker, allowed, log, shop = defaultShop() }) {
  const svc = catalogue?.service;
  if (!svc || !allowed) return { on: false };
  let status;
  try {
    status = await svc.status();
  } catch {
    return { on: false };
  }
  if (!status?.enabled || !status.ready) return { on: false };
  /** The few plain fields of an item the model may read; `shop` is what the shop lists for it, or null. */
  const view = (i) => {
    const listed = shopBlockFor(shop, i.productId);
    return {
      title: i.title,
      productCode: i.productId,
      category: i.category,
      finish: i.finish,
      source: i.source?.name,
      ...(listed ? { shop: { productId: listed.id, variantId: listed.variantId, name: listed.name, listedPrice: listed.priceText, availability: listed.stock === 'out' ? 'out of stock' : listed.stock === 'low' ? 'low stock' : 'in stock', priceNote: listed.note } } : {}),
    };
  };
  const NOTE = 'These are items of the real catalogue. Where an item has a `shop` entry it is also in the shop at that listed price (a sample price until the price list is loaded), and a card for it appears under your reply; the others have no price or cart.';

  /** Run one search through the service's own gates; `work(live, release)` does the search. */
  async function gated(group, body, work) {
    try {
      const live = await svc.prepare(body);
      const verdict = svc.check(group, asker);
      if (!verdict.ok) return { available: false, reason: 'The catalogue search has been used a lot in the last hour. Try again in a few minutes.' };
      const release = svc.tryAcquire();
      if (!release) return { available: false, reason: 'The catalogue search is busy right now.' };
      try {
        svc.record(group, asker);
        return await work(live);
      } finally {
        release();
      }
    } catch (error) {
      if (error instanceof CatalogueError) return { available: false, reason: String(error.message).slice(0, 200) };
      log?.warn?.(`terubot  catalogue search failed: ${String(error?.name ?? 'error').slice(0, 40)}`);
      return { available: false, reason: 'The catalogue search is not available right now.' };
    }
  }

  return {
    on: true,
    async search(text, limit) {
      let body;
      try {
        body = parseTextBody({ text, k: limit });
      } catch (error) {
        return { available: false, reason: String(error?.message ?? 'That search cannot be run.').slice(0, 200) };
      }
      return gated('text', body, async (live) => {
        const found = await svc.searchText({ live, body });
        return { available: true, catalogue: found.catalogue, items: (found.items ?? []).slice(0, limit).map(view), note: NOTE };
      });
    },

    /**
     * The items that look most like a region of a photo.
     * @param {{bytes: Buffer, type: string, box?: number[], limit: number}} p `box` is x0,y0,x1,y1, each 0 to 1 (the whole photo when left out)
     */
    async searchPhoto({ bytes, type, box, limit }) {
      let params;
      let photo;
      try {
        params = parseSearchParams({ mode: 'look', k: String(limit), ...(box ? { box: box.map((n) => n.toFixed(4)).join(',') } : {}) });
        photo = judgePhoto(bytes, type);
      } catch (error) {
        return { available: false, reason: String(error?.message ?? 'That photo cannot be searched.').slice(0, 200) };
      }
      return gated('search', params, async (live) => {
        const found = await svc.searchPhoto({ live, params, bytes, type: photo.type });
        return { available: true, catalogue: found.catalogue, items: (found.items ?? []).slice(0, limit).map(view), note: NOTE };
      });
    },
  };
}
