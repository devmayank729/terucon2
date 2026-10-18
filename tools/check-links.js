#!/usr/bin/env node
// Check the built pages (pages/*.html) against site/site.json.
//
//   node tools/check-links.js            human readable, exit 1 on any problem
//   node tools/check-links.js --json     machine readable (the project overview uses it)
//   node tools/check-links.js --dir DIR  check the pages in DIR instead of the `file` paths of site.json
//   node tools/check-links.js --link-style file   accept links to the page files (default: linkStyle of site.json)
//
// Three checks, on the page template inside each bundle (assets are not looked at):
//   links        every same-site href/src is a known route, alias or existing media file (or, in the `file` link style, a page file)
//   connections  every page links to each page listed for it in site.json `connections`
//                (the whole template is searched: the dashboard keeps some links inside its own views)
//   names        no design-time name is left over (".dc.html", "Media%20Brief", the legacy names of site.json)
//
// Node built-ins only. tools/build-site.js runs the `links` check after every build.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Bundle } from './bundle.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Names that must never survive a build, besides the legacy names listed in site.json. */
export const DESIGN_TIME_FRAGMENTS = ['.dc.html', 'Media%20Brief', 'Terucon%20Home%20v2', 'landing%20page'];

const NOT_SAME_SITE = ['http:', 'https:', 'tel:', 'mailto:', 'data:', 'blob:', 'javascript:', '//', 'about:'];
const BUNDLER_ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-/;
// href="..." / src="..." that start with a path (not "#", "?" or a {{ template }}); the target ends at #, ? or the closing quote
const LINK_ATTR = /(?:href|src)=["']([^"'{}#?][^"'{}]*?)(?:[#?][^"']*)?["']/g;

export function loadSite(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, 'site', 'site.json'), 'utf8'));
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Every same-site-looking link target of a template (decoded), in document order, with duplicates. */
export function collectLinks(template) {
  const links = [];
  for (const m of template.matchAll(LINK_ATTR)) links.push(safeDecode(m[1]));
  return links;
}

const stripSlash = (s) => s.replace(/^\.?\/+/, '');

/**
 * What a link target may be, built from site.json: `resolve(target)` gives {kind, page?} or {kind:'unknown'}.
 * Routes, aliases (what the server answers), docs and existing media files are known in both link styles; the page
 * files themselves ("home.html", "pages/studio.html") only in the `file` style, because the server serves none of
 * them under that name (pages/ is never served).
 */
export function makeResolver(site, root = ROOT, linkStyle = site.linkStyle || 'route') {
  const known = new Map(); // normalised target -> {kind, page}
  const add = (target, kind, page) => {
    if (target) known.set(stripSlash(safeDecode(target)), { kind, page });
  };
  for (const [key, spec] of Object.entries(site.pages)) {
    add(spec.route, 'route', key); // "/" normalises to ""
    for (const alias of spec.aliases || []) add(alias, 'alias', key);
    if (linkStyle === 'file') {
      add(spec.file, 'file', key);
      add(path.posix.basename(spec.file), 'file', key);
    }
  }
  for (const doc of Object.values(site.docs || {})) {
    add(doc.route, 'doc');
    for (const alias of doc.aliases || []) add(alias, 'doc');
  }
  const mediaDir = site.media?.dir || 'media';
  const mediaRoute = stripSlash(site.media?.route || '/media');
  const homeKeys = Object.entries(site.pages).filter(([, s]) => s.route === '/').map(([k]) => k);

  return function resolve(target) {
    if (NOT_SAME_SITE.some((p) => target.startsWith(p))) return { kind: 'external' };
    if (BUNDLER_ASSET_ID.test(target)) return { kind: 'asset' };
    if (target === '/') return { kind: 'route', page: homeKeys[0] };
    const t = stripSlash(target);
    for (const prefix of new Set([mediaRoute, 'media', mediaDir])) {
      if (t.startsWith(prefix + '/')) {
        const rel = t.slice(prefix.length + 1);
        const abs = path.resolve(root, mediaDir, rel);
        const inside = abs.startsWith(path.resolve(root, mediaDir) + path.sep);
        return inside && fs.existsSync(abs) ? { kind: 'media' } : { kind: 'missing-media', detail: `${mediaDir}/${rel}` };
      }
    }
    return known.get(t) || { kind: 'unknown' };
  };
}

/** Check one template. Returns {links, linkedPages, problems:[{check, message}]}. */
export function checkTemplate(pageKey, template, site, { root = ROOT, resolve = makeResolver(site, root) } = {}) {
  const problems = [];
  const linkedPages = new Set();
  let count = 0;

  // 1. links
  for (const target of collectLinks(template)) {
    const r = resolve(target);
    if (r.kind === 'external' || r.kind === 'asset') continue;
    count += 1;
    if (r.kind === 'missing-media') problems.push({ check: 'links', message: `missing media file ${r.detail} (linked as ${JSON.stringify(target)})` });
    else if (r.kind === 'unknown') problems.push({ check: 'links', message: `link to unknown page ${JSON.stringify(target)}` });
    else if (r.page) linkedPages.add(r.page);
  }

  // 2. connections
  for (const wanted of site.connections?.[pageKey] || []) {
    if (!linkedPages.has(wanted)) {
      problems.push({ check: 'connections', message: `does not link to '${wanted}' (${site.pages[wanted]?.route ?? '?'}), site.json connections require it` });
    }
  }

  // 3. design-time names (a name inside a longer leftover name, such as ".dc.html" in "Design%20Studio.dc.html", is reported once)
  const names = new Set(DESIGN_TIME_FRAGMENTS);
  for (const legacy of Object.keys(site.legacy_names || {})) {
    names.add(legacy);
    names.add(encodeURIComponent(legacy).replace(/%2F/g, '/'));
  }
  const found = [...names].filter((name) => template.includes(name));
  for (const name of found) {
    if (found.some((other) => other !== name && other.includes(name))) continue;
    const at = template.indexOf(name);
    const context = template.slice(Math.max(0, at - 30), at + name.length + 20).replace(/\s+/g, ' ');
    problems.push({ check: 'names', message: `leftover design-time name ${JSON.stringify(name)}: …${context}…` });
  }
  return { links: count, linkedPages: [...linkedPages].sort(), problems };
}

/**
 * Check the built pages. `templates` is {pageKey: template text}; when omitted the pages are read from
 * disk: `dir` (a folder holding the built files, named like site.json `file`) or the `file` paths under `root`.
 * `linkStyle` (default: site.json) says whether links may name the page files (`file`) or only routes and aliases (`route`).
 * `keys` limits which pages are checked (links may still point at any page of the site). `checks` limits which checks count ('links', 'connections', 'names'; default all).
 */
export function checkPages({ root = ROOT, site = loadSite(root), linkStyle = site.linkStyle || 'route', keys = null, dir = null, templates = null, checks = null } = {}) {
  const resolve = makeResolver(site, root, linkStyle);
  const pages = {};
  const problems = [];
  for (const key of keys || Object.keys(site.pages)) {
    const spec = site.pages[key];
    const file = dir ? path.join(dir, path.basename(spec.file)) : path.join(root, spec.file);
    let template;
    if (templates) {
      template = templates[key];
    } else if (fs.existsSync(file)) {
      template = Bundle.load(file).template;
    } else {
      pages[key] = { file: spec.file, exists: false, links: 0, linkedPages: [], problems: [{ check: 'links', message: `page file not found: ${file}` }] };
      problems.push({ page: key, check: 'links', message: `page file not found: ${file}` });
      continue;
    }
    const r = checkTemplate(key, template, site, { root, resolve });
    const mine = checks ? r.problems.filter((p) => checks.includes(p.check)) : r.problems;
    pages[key] = { file: spec.file, exists: true, links: r.links, linkedPages: r.linkedPages, problems: mine };
    for (const p of mine) problems.push({ page: key, ...p });
  }
  return { ok: problems.length === 0, pages, problems };
}

function main(argv) {
  const json = argv.includes('--json');
  const dirAt = argv.indexOf('--dir');
  const rootAt = argv.indexOf('--root');
  const styleAt = argv.indexOf('--link-style');
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: node tools/check-links.js [--json] [--dir PAGES_DIR] [--root PROJECT_ROOT] [--link-style route|file]');
    return 0;
  }
  const root = rootAt !== -1 ? path.resolve(argv[rootAt + 1]) : ROOT;
  const dir = dirAt !== -1 ? path.resolve(argv[dirAt + 1]) : null;
  const linkStyle = styleAt !== -1 ? argv[styleAt + 1] : undefined;
  if (linkStyle !== undefined && !['route', 'file'].includes(linkStyle)) {
    console.error('--link-style must be one of route, file');
    return 2;
  }
  const result = checkPages({ root, dir, linkStyle });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  for (const [key, p] of Object.entries(result.pages)) {
    console.log(`${p.problems.length ? 'FAIL' : 'OK  '}  ${p.file}  (${p.links} same-site links; links to: ${p.linkedPages.join(', ') || 'nothing'})`);
    for (const pr of p.problems) console.log(`        - [${pr.check}] ${pr.message}`);
  }
  if (result.ok) console.log('\nLink check: links resolve, the connections of site.json hold, no design-time names are left.');
  else console.log(`\nLink check FAILED: ${result.problems.length} problem(s).`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
