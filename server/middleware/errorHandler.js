/** What is left over after the routes: unknown paths and errors, answered in the project's JSON error shape (a web page for a browser's 5xx). */
import { sendError } from '../lib/errors.js';
import { sendErrorPage, wantsHtml } from '../lib/errorPage.js';

/** Plain 404 for anything that is not a page, a media file or an API route. */
export function notFound(req, res) {
  res.status(404).type('text/plain').send('Not found');
}

/** A connection string in an error message keeps its host but not its password. */
const redact = (text) => String(text).replace(/(\w[\w+.-]*:\/\/)[^\s/@]+@/g, '$1***@');

/**
 * Error-handling middleware (four arguments: Express recognises it by that). Body-parser's errors become
 * 400/413/415 with a sentence a person can read; anything unexpected is a 500 whose detail stays in the log. A visitor's
 * browser (it asked for text/html, and not for /api) gets the branded error page for that 500, everyone else the JSON body.
 * Neither shows the error, its stack or any setting.
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
    ctx.log.error(redact(`error  ${req.method} ${req.path}  ${err.stack ?? err}`));
    if (wantsHtml(req)) return sendErrorPage(res, { root: ctx.root, status: 500 });
    return sendError(res, 500, 'The server hit an unexpected error. Details are in the server window.', 'INTERNAL');
  };
}
