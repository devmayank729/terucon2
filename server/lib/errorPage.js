/**
 * The page a visitor sees when the server itself fails (a 5xx): pages/error.html, the branded "something went wrong" page,
 * or, until that file exists, a small plain page of the same kind. API clients and anything else that did not ask for a web page
 * get the JSON error body instead (server/middleware/errorHandler.js). Neither ever carries a stack trace, a path or a setting:
 * the detail goes to the log only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pageCsp } from './csp.js';

export const ERROR_PAGE = path.join('pages', 'error.html');

const FALLBACK = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Terucon</title><p style="font:16px/1.5 system-ui;max-width:32em;margin:15vh auto;padding:0 20px">Something went wrong on our side. Please try again in a minute, or <a href="/">go back to the home page</a>.</p>';

/** A browser asking for a web page: its Accept names text/html. A client that sends no Accept header at all is not one. */
export function wantsHtml(req) {
  if (req.path === '/api' || req.path.startsWith('/api/')) return false;
  return /\btext\/html\b/i.test(req.headers.accept ?? '');
}

const known = new Map(); // file -> {mtimeMs, html, csp}

/** The branded page and its Content-Security-Policy (from its own inline blocks), or null when pages/error.html is not there. */
function branded(root) {
  if (!root) return null;
  const file = path.join(root, ERROR_PAGE);
  try {
    const { mtimeMs } = fs.statSync(file);
    const cached = known.get(file);
    if (cached?.mtimeMs === mtimeMs) return cached;
    const html = fs.readFileSync(file, 'utf8');
    const entry = { mtimeMs, html, csp: pageCsp(html) };
    known.set(file, entry);
    return entry;
  } catch {
    return null;
  }
}

/**
 * Answer a failure with the page. Never throws.
 * @param {import('express').Response} res
 * @param {{root?: string, status?: number, retryAfter?: number, fallback?: string}} [options] `fallback`: the plain page to send when
 *   pages/error.html is not there (default: the general "something went wrong" one)
 */
export function sendErrorPage(res, { root, status = 500, retryAfter, fallback = FALLBACK } = {}) {
  const page = branded(root);
  res.status(status).set({ 'Cache-Control': 'no-store', ...(retryAfter && { 'Retry-After': String(retryAfter) }) }).type('html');
  if (page) res.set('Content-Security-Policy', page.csp);
  res.send(page ? page.html : fallback);
}
