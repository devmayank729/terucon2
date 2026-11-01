/**
 * Read a request body that is a picture: at most `limit` bytes, within `deadlineMs`, counting as it arrives.
 *
 * It is read whole (a query photo is at most 6 MB, and the browser sends about 100 to 400 KB) and not passed on as a stream, on purpose: the
 * photo is judged by its bytes (validate.judgePhoto, including whether it is cut off) BEFORE Modal is asked anything, so a body that is too
 * big, cut short, or not a photo never costs a GPU call. A stream handed to fetch() would have started the call before the end was known.
 * Memory is bounded by the byte limit times the number of searches the gate lets in (catalogue.maxConcurrent), because the reading happens
 * after a place in the gate was taken.
 */
import { CatalogueError } from './errors.js';

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {{limit: number, deadlineMs: number}} options
 * @returns {Promise<Buffer>}
 */
export function readBody(req, { limit, deadlineMs }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
      if (error) {
        req.pause();
        reject(error);
      } else resolve(value);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) return finish(new CatalogueError(413, 'too-large', `The photo is too large (at most ${Math.floor(limit / 1024 / 1024)} MB).`));
      chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks, size));
    const onError = () => finish(new CatalogueError(400, 'bad-request', 'The photo was cut short on the way. Please try again.'));
    const onClose = () => {
      if (!req.complete) finish(new CatalogueError(400, 'bad-request', 'The photo was cut short on the way. Please try again.'));
    };
    const timer = setTimeout(() => finish(new CatalogueError(408, 'bad-request', 'The photo took too long to arrive. Please try again.')), deadlineMs);
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('close', onClose);
  });
}
