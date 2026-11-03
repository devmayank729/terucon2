#!/usr/bin/env node
// Keeps the loader's three copies of one thing in step:
//   site/brand/loader.css    the loader's style sheet (the one you edit; also served at /brand/loader.css for pages that have no
//                            loader of their own: transition.js links it)
//   site/brand/loader.html   its first <style> block is a copy of loader.css (inline, so the loader paints with the first bytes of a
//                            page); the markup in it is the one you edit
//   site/brand/transition.js its MARKUP constant is a copy of the loader's markup (between the loader-markup markers)
//
//   node site/brand/build-loader.mjs           rewrite loader.html's style block and transition.js's MARKUP
//   node site/brand/build-loader.mjs --check   exit 1 (and say what) when either is out of date; writes nothing
//
// tests/js/brand-loader.test.js runs the same check, so a change to loader.css or the markup that skips this fails `npm test`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(here, name), 'utf8');

/** The element #tc-loader as one string: from its opening tag up to the script block, source lines trimmed and joined. */
export function markupOf(html) {
  const start = html.indexOf('<div id="tc-loader"');
  const end = html.indexOf('<script>', start);
  if (start === -1 || end === -1) throw new Error('loader.html: markup not found');
  return html
    .slice(start, end)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('');
}

/** What the two files should contain: { loaderHtml, transitionJs, markup }. */
export function build(dir = here) {
  const get = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
  const css = get('loader.css').replace(/\s+$/, '');
  let html = get('loader.html');
  // the first <style> block holds the loader's sheet; the one inside <noscript> is separate and never touched
  const styleRe = /<style>[\s\S]*?<\/style>/;
  if (!styleRe.test(html)) throw new Error('loader.html has no <style> block');
  html = html.replace(styleRe, () => `<style>\n${css}\n</style>`);
  const markup = markupOf(html);
  let js = get('transition.js');
  const markRe = /\/\*loader-markup:start\*\/[\s\S]*?\/\*loader-markup:end\*\//;
  if (!markRe.test(js)) throw new Error('transition.js has no loader-markup markers');
  js = js.replace(markRe, () => `/*loader-markup:start*/\n  var MARKUP = ${JSON.stringify(markup)};\n  /*loader-markup:end*/`);
  return { loaderHtml: html, transitionJs: js, markup };
}

/** Names of the files that are not what build() says they should be. */
export function stale(dir = here) {
  const get = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
  const { loaderHtml, transitionJs } = build(dir);
  const out = [];
  if (loaderHtml !== get('loader.html')) out.push('loader.html (its <style> block is not loader.css)');
  if (transitionJs !== get('transition.js')) out.push('transition.js (MARKUP is not the loader markup)');
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = stale();
  if (process.argv.includes('--check')) {
    if (out.length) {
      console.error(`out of date: ${out.join('; ')}\nrun: node site/brand/build-loader.mjs`);
      process.exit(1);
    }
    console.log('loader.css, loader.html and transition.js are in step.');
  } else {
    const { loaderHtml, transitionJs } = build();
    fs.writeFileSync(path.join(here, 'loader.html'), loaderHtml);
    fs.writeFileSync(path.join(here, 'transition.js'), transitionJs);
    console.log(out.length ? `rewrote: ${out.join('; ')}` : 'already in step.');
  }
}
