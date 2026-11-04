/**
 * The link between the catalogue and the shop (targets A1, C4): a catalogue design whose product id is TIPL-SB804 is the shop product
 * `tipl-sb804` (tools/build-shop-catalogue.js lists every design of the SuperBond colour catalogue in the shop under its product id in lower
 * case). So a catalogue search result can say what the shop lists for it, with no table to keep in step: the id IS the link.
 *
 * The price is what the shop lists. For the catalogue designs that is a SAMPLE price (the shop's own sheet rate, until Terucon's price list is
 * loaded), which the block says in words so no screen presents it as a quote.
 */
import { loadShop } from './terubot/shop.js';

let cached = null;
/** The shop as the server knows it (server/data/products.json), loaded once. */
export const defaultShop = () => (cached ??= loadShop());

export const SAMPLE_PRICE_NOTE = 'Sample price: the price list is not loaded yet.';

/**
 * @param {import('./terubot/shop.js').Shop} shop
 * @param {string | null | undefined} productId a catalogue product id such as TIPL-SB804
 * @returns {{id: string, variantId: string, name: string, price: number, priceText: string, unit: string, stock: string, href: string, image: string | null, sample: boolean, note: string | null} | null}
 */
export function shopBlockFor(shop, productId) {
  if (typeof productId !== 'string' || !/^TIPL-[A-Z]{2,4}\d{2,5}$/.test(productId)) return null;
  const product = shop.byProduct.get(productId.toLowerCase());
  if (!product || product.catalogueId !== productId) return null;
  const variant = product.variants.find((v) => v.id === product.defaultVariant) ?? product.variants[0];
  if (!variant) return null;
  return {
    id: product.id,
    variantId: variant.id,
    name: shop.nameOf(product, variant),
    price: variant.price,
    priceText: variant.priceText,
    unit: product.unit,
    stock: variant.stock,
    href: `/materials#/p/${product.id}?v=${encodeURIComponent(variant.id)}`,
    // a design's picture is read from Cloud Storage through MongoDB (server/routes/catalogueMedia.js); a result card needs the 320 px thumbnail
    image: variant.image ? `/${variant.image}?w=320` : null,
    sample: true,
    note: SAMPLE_PRICE_NOTE,
  };
}

/** The same answer with a `shop` block on every item that is also a shop product (null on the others). */
export function withShop(answer, shop) {
  if (!answer || !Array.isArray(answer.items)) return answer;
  return { ...answer, items: answer.items.map((item) => ({ ...item, shop: shopBlockFor(shop, item.productId) })) };
}
