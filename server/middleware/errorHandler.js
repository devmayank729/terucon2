/** What is left over after the routes: unknown paths and errors, answered in the project's JSON error shape. */
import { sendError } from '../lib/errors.js';

/** Plain 404 for anything that is not a page, a media file or an API route. */
export function notFound(req, res) {
  res.status(404).type('text/plain').send('Not found');
}

/**
 * Error-handling middleware (four arguments: Express recognises it by that). Body-parser's errors become
 * 400/413/415 with a sentence a person can read; anything unexpected is a 500 whose detail stays in the log.
 */
export function errorHandler(ctx) {
  return (err, req, res, next) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err.type === 'entity.parse.failed') return sendError(res, 400, 'The request body is not valid JSON.');
    if (err.type === 'entity.too.large') return sendError(res, 413, 'The request is too large (the limit is 80 MB).');
    if (err.type === 'charset.unsupported' || err.type === 'encoding.unsupported') return sendError(res, 415, 'Send application/json encoded as UTF-8.');
    if (err.type === 'request.aborted' || err.type === 'request.size.invalid') return sendError(res, 400, 'The request body was cut short.');
    const status = err.status ?? err.statusCode;
    if (Number.isInteger(status) && status >= 400 && status < 500) return sendError(res, status, err.expose === false ? 'Bad request.' : err.message);
    ctx.log.error(`error  ${req.method} ${req.path}  ${err.stack ?? err}`);
    return sendError(res, 500, 'The server hit an unexpected error. Details are in the server window.', 'INTERNAL');
  };
}
