/**
 * TeruBot's use of the catalogue search (server/catalogue/): by words only, through the same service, the same checks and the same hourly
 * ceilings as POST /api/catalogue/search-text, for the same kind of asker (a signed-in account; or anybody when sign-in is switched off).
 * When the catalogue is off or not ready the bridge says so (`on: false`) and the tool is not offered to the model at all.
 *
 * Only a few plain fields of each item go to the model (title, category, finish, product code, source name): no picture addresses, no
 * scores. No cards are made from catalogue items: a card is a shop material (cards come from the shop's data only).
 */
import { CatalogueError } from '../../catalogue/errors.js';
import { parseTextBody } from '../../catalogue/validate.js';

/**
 * @param {object} p
 * @param {{service: any} | null | undefined} p.catalogue ctx.catalogue (set when the catalogue routes are mounted)
 * @param {{account: string | null, address: string}} p.asker
 * @param {boolean} p.allowed false when the visitor may not use the catalogue (not signed in while sign-in is required)
 * @param {{warn?: Function}} [p.log]
 * @returns {Promise<{on: boolean, search?: (text: string, limit: number) => Promise<object>}>}
 */
export async function catalogueBridge({ catalogue, asker, allowed, log }) {
  const svc = catalogue?.service;
  if (!svc || !allowed) return { on: false };
  let status;
  try {
    status = await svc.status();
  } catch {
    return { on: false };
  }
  if (!status?.enabled || !status.ready) return { on: false };
  return {
    on: true,
    async search(text, limit) {
      try {
        const body = parseTextBody({ text, k: limit });
        const live = await svc.prepare(body);
        const verdict = svc.check('text', asker);
        if (!verdict.ok) return { available: false, reason: 'The catalogue search has been used a lot in the last hour. Try again in a few minutes.' };
        const release = svc.tryAcquire();
        if (!release) return { available: false, reason: 'The catalogue search is busy right now.' };
        try {
          svc.record('text', asker);
          const found = await svc.searchText({ live, body });
          return {
            available: true,
            catalogue: found.catalogue,
            items: (found.items ?? []).slice(0, limit).map((i) => ({ title: i.title, category: i.category, finish: i.finish, productCode: i.productId, source: i.source?.name })),
            note: 'These are items of the real catalogue, not shop products; there is no price or cart for them.',
          };
        } finally {
          release();
        }
      } catch (error) {
        if (error instanceof CatalogueError) return { available: false, reason: String(error.message).slice(0, 200) };
        log?.warn?.(`terubot  catalogue search failed: ${String(error?.name ?? 'error').slice(0, 40)}`);
        return { available: false, reason: 'The catalogue search is not available right now.' };
      }
    },
  };
}
