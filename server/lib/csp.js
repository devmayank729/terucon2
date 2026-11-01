/**
 * A Content-Security-Policy for the pages we write by hand (the sign-in and account pages), built from the page itself.
 *
 * The exported pages (landing, shop, studio, dashboard) build themselves from inline scripts and cannot have a strict policy.
 * These two can, and they are the pages that handle one-time codes and personal details, so they get one: nothing runs except
 * the page's own inline script and style (named by hash, so an injected script is refused by the browser even if some bug let
 * markup in), no other site can be loaded, framed or posted to, and the page cannot be framed by another site.
 *
 * `google: true` also lets the page load Google's sign-in script and its button, from exactly the addresses Google documents
 * (https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid#content_security_policy).
 *
 * `images: [...]` (the Inspiration page, "strict+images") also lets the page show a picture it has just made or opened in the browser
 * (`blob:`) and pictures from exactly the hosts listed ("*.pinimg.com" -> https://*.pinimg.com): the picture hosts of the sites in
 * site/inspiration/sources.js, for the thumbnails of a board. Nothing else; scripts, styles and connections stay as strict as before.
 */
import { createHash } from 'node:crypto';

const hash = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/** The text of every inline <script> (no src) and <style> in a page. */
export function inlineBlocks(html) {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  return { scripts, styles };
}

export function pageCsp(html, { google = false, images = [] } = {}) {
  const { scripts, styles } = inlineBlocks(html);
  const script = ["'self'", ...scripts.map(hash), ...(google ? ['https://accounts.google.com/gsi/client'] : [])];
  const style = ["'self'", ...styles.map(hash), ...(google ? ['https://accounts.google.com/gsi/style'] : [])];
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    `script-src ${script.join(' ')}`,
    `style-src ${style.join(' ')}`,
    `img-src 'self' data:${images.length ? ' blob:' : ''}${images.map((host) => ` https://${host}`).join('')}`,
    "font-src 'self'",
    `connect-src 'self'${google ? ' https://accounts.google.com/gsi/' : ''}`,
    ...(google ? ['frame-src https://accounts.google.com/gsi/'] : []),
  ].join('; ');
}
