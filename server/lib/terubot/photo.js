/**
 * A photo in a TeruBot conversation: one the visitor attached, or one the site fetched for a link they pasted.
 *
 *   {image: {type: 'image/jpeg', data: '<base64>'}}      a photo sent from the browser (the widget shrinks it first)
 *   a web address in the message text                     the picture behind it, fetched by the inspiration importer (gallery-dl for Pinterest
 *                                                         and the other sites it has a profile for, a plain fetch for a picture link or a page)
 *
 * Both end as {bytes, type}: checked by their own bytes (judgePhoto: a real JPEG, PNG or WebP, not cut off, within size), at most MAX_BYTES.
 * The importer is the same one the Inspiration page uses, with its own safety (public addresses only, one-use tokens, sizes, an hourly limit
 * per account), so TeruBot adds no way to make the server fetch anything.
 *
 * What goes to Gemini is the photo's bytes as an inline part of the visitor's last message. Nothing of it is kept on the server after the answer.
 */
import { findAddresses, classify } from '../../../site/inspiration/sources.js';
import { CatalogueError } from '../../catalogue/errors.js';
import { judgePhoto } from '../../catalogue/validate.js';
import { BadRequest } from './input.js';

/** What the model reads and what the catalogue searches: big enough to see a texture, small enough for a quick answer. */
export const MAX_BYTES = 4 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * @param {unknown} image the `image` field of the request
 * @returns {{bytes: Buffer, type: string, width: number, height: number} | null} null when there is none; throws BadRequest when it is not a usable photo
 */
export function parseUpload(image) {
  if (image === undefined || image === null) return null;
  if (typeof image !== 'object' || Array.isArray(image) || !TYPES.includes(image.type) || typeof image.data !== 'string' || !image.data) {
    throw new BadRequest('A photo is {type: "image/jpeg" | "image/png" | "image/webp", data: <base64>}.');
  }
  if (image.data.length > Math.ceil((MAX_BYTES * 4) / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new BadRequest(`That photo is too large or not valid (at most ${MAX_BYTES / 1024 / 1024} MB).`);
  const bytes = Buffer.from(image.data, 'base64');
  try {
    const judged = judgePhoto(bytes, image.type, { maxBytes: MAX_BYTES });
    return { bytes, ...judged };
  } catch (error) {
    if (error instanceof CatalogueError) throw new BadRequest(error.message);
    throw error;
  }
}

/**
 * The first address in the text that the importer can read as a picture source: {address}; or, when the only addresses are of sites that need a
 * sign-in or are not supported, {refused: <why, in words>}; or null when there is no address at all. Never throws.
 */
export function linkIn(text) {
  let refused = null;
  for (const found of findAddresses(String(text ?? '').slice(0, 4000))) {
    const c = classify(found);
    if (!c) continue;
    if (c.type === 'login' || c.type === 'unsupported') refused ??= c.message ?? 'That site cannot be read.';
    else return { address: found };
  }
  return refused ? { refused } : null;
}

/** The reason a link gave nothing, in words for the visitor and the model. */
const reasonOf = (error) => String(error?.message ?? 'The picture could not be fetched.').slice(0, 220);

/**
 * Fetch the picture a pasted link points at.
 * @param {object} p
 * @param {string} p.address the link (addressIn)
 * @param {{account: string | null, address: string}} p.who the same asker the importer's own routes use
 * @param {{resolve: Function, file: Function} | null | undefined} p.importer ctx.inspiration
 * @returns {Promise<{photo: {bytes: Buffer, type: string, width: number, height: number, token: string, title: string, host: string, kind: string, approximate: boolean}} | {failed: string}>}
 */
export async function photoFromLink({ address, who, importer }) {
  if (!importer) return { failed: 'Fetching a picture from a link is not set up on this site.' };
  let resolved;
  try {
    resolved = await importer.resolve(address, who);
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) return { failed: reasonOf(error) };
    throw error;
  }
  const first = resolved.items?.[0];
  if (!first) return { failed: 'There is no picture at that link.' };
  let file;
  try {
    file = await importer.file(first.token, who);
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) return { failed: reasonOf(error) };
    throw error;
  }
  if (!TYPES.includes(file.type)) return { failed: `That picture is a ${String(file.type).replace('image/', '').toUpperCase()}, which the photo search cannot read. Save it as a JPEG or PNG and attach it.` };
  try {
    const judged = judgePhoto(file.bytes, file.type, { maxBytes: MAX_BYTES });
    return {
      photo: {
        bytes: file.bytes,
        ...judged,
        token: first.token,
        title: String(resolved.title ?? first.title ?? '').slice(0, 120),
        host: String(resolved.source?.label ?? '').slice(0, 60),
        kind: resolved.kind,
        approximate: Boolean(resolved.approximate),
        more: Math.max(0, (resolved.items?.length ?? 1) - 1),
      },
    };
  } catch (error) {
    if (error instanceof CatalogueError) return { failed: error.message };
    throw error;
  }
}

/** The part Vertex takes for a picture. */
export const photoPart = (photo) => ({ inlineData: { mimeType: photo.type, data: photo.bytes.toString('base64') } });
