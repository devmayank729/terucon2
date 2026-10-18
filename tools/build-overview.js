#!/usr/bin/env node
// Builds docs/PROJECT_OVERVIEW.html: one self-contained page about this project, generated from the tree.
//
//   node tools/build-overview.js            write the page (only when something besides the timestamp changed)
//   node tools/build-overview.js --check    write nothing; exit 1 with a readable list when the catalog and the
//                                           project disagree, or when the committed page is stale
//   node tools/build-overview.js --strict   also fail on catalog paths that are flagged provisional but missing
//
// Facts are scanned: the file tree, line counts, test counts, the routes the Express app registers, the variables in
// .env.example, the pages in site/site.json, the npm scripts. Descriptions are authored, in docs/overview/catalog/*.json.
// The page shell is docs/overview/{template.html,overview.css,dark-tokens.css,overview.js}.
//
// Node built-ins only. The functions are exported so tests/js/overview-*.test.js can run them against temporary projects.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const OUTPUT = 'docs/PROJECT_OVERVIEW.html';
export const OVERVIEW_DIR = 'docs/overview';
export const CATALOG_DIR = 'docs/overview/catalog';
const SELF_PAGE = OUTPUT;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // code-unit order, so the output does not depend on the locale
const posix = (p) => p.split(path.sep).join('/');
const exists = (p) => fs.existsSync(p);
const readText = (p) => fs.readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(readText(p));

// ---------------------------------------------------------------------------------------------------------- scanning

// Mirrors .gitignore. Anything matching here is skipped before it is stat'ed or read, so a private file is never opened.
const IGNORED_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.pytest_cache', '.cache', '.idea', '.vscode', 'coverage', 'credentials', 'models', 'data']);
const IGNORED_FILE = [/^\.env$/, /^\.env\..+$/, /\.pem$/, /-key\.json$/, /^service-account.*\.json$/, /\.pyc$/, /^\.DS_Store$/, /^npm-debug\.log/];
const KEPT_DOTFILES = new Set(['.env.example']);

export function isIgnoredName(name, isDir) {
  if (isDir) return IGNORED_DIRS.has(name);
  if (KEPT_DOTFILES.has(name)) return false;
  return IGNORED_FILE.some((re) => re.test(name));
}

const LANG_BY_EXT = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.py': 'Python', '.json': 'JSON', '.html': 'HTML', '.css': 'CSS',
  '.md': 'Markdown', '.txt': 'Text', '.sh': 'Shell', '.yml': 'YAML', '.yaml': 'YAML', '.toml': 'TOML', '.ipynb': 'Notebook',
};
const MEDIA_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.ico', '.mp4', '.webm', '.svg']);
const BINARY_EXT = new Set([...MEDIA_EXT, '.woff', '.woff2', '.pdf', '.pt', '.pth', '.onnx', '.zip', '.gz', '.bin']);
export const LANGUAGES = ['JavaScript', 'Python', 'JSON', 'HTML', 'CSS', 'Markdown'];

export function languageOf(rel, binary) {
  const ext = path.extname(rel).toLowerCase();
  if (MEDIA_EXT.has(ext) && ext !== '.svg') return 'Media';
  if (binary) return 'Binary';
  return LANG_BY_EXT[ext] || 'Text';
}

function countLines(buf) {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  return buf[buf.length - 1] === 10 ? n : n + 1;
}

/** Every project file with size and line count. `ignore` are extra globs (relative, posix) from the catalog. */
export function scanTree(root, ignore = []) {
  const extra = ignore.map(globToRegExp);
  const files = [];
  const dirs = [];
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => cmp(a.name, b.name));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (isIgnoredName(e.name, true) || extra.some((re) => re.test(r) || re.test(r + '/'))) continue;
        dirs.push(r);
        walk(path.join(abs, e.name), r);
      } else if (e.isFile()) {
        if (isIgnoredName(e.name, false) || extra.some((re) => re.test(r))) continue;
        const buf = fs.readFileSync(path.join(abs, e.name));
        const ext = path.extname(e.name).toLowerCase();
        const binary = BINARY_EXT.has(ext) || buf.subarray(0, 4096).includes(0);
        files.push({ path: r, bytes: buf.length, lines: binary ? null : countLines(buf), lang: languageOf(r, binary), binary });
      }
    }
  };
  walk(root, '');
  files.sort((a, b) => cmp(a.path, b.path));
  dirs.sort(cmp);
  return { files, dirs };
}

// ---------------------------------------------------------------------------------------------------------- globs

export function globToRegExp(glob) {
  let re = '';
  let brace = 0;
  for (let i = 0; i < glob.length; ) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 3; } else { re += '.*'; i += 2; }
      } else { re += '[^/]*'; i += 1; }
    } else if (c === '?') { re += '[^/]'; i += 1; }
    else if (c === '{') { re += '(?:'; brace++; i += 1; }
    else if (c === '}' && brace) { re += ')'; brace--; i += 1; }
    else if (c === ',' && brace) { re += '|'; i += 1; }
    else { re += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&'); i += 1; }
  }
  return new RegExp(`^${re}$`);
}

const hasWildcard = (p) => /[*?{]/.test(p);
/** Higher = more specific. An exact path beats any glob; among globs the one with more literal characters wins. */
export function specificity(pattern) {
  if (!hasWildcard(pattern)) return 1e6 + pattern.length;
  const wild = (pattern.match(/\*\*|\*|\?|\{/g) || []).length;
  const literal = pattern.replace(/\*\*|\*|\?|[{},]/g, '').length;
  return literal * 10 - wild * 40;
}

/** Index entries once: {entry, re, score}. */
export function compileEntries(entries) {
  return entries.map((entry, order) => ({ entry, order, re: globToRegExp(entry.match), score: specificity(entry.match) }));
}

export function bestEntry(rel, compiled) {
  let best = null;
  for (const c of compiled) {
    if (!c.re.test(rel)) continue;
    if (!best || c.score > best.score || (c.score === best.score && c.order < best.order)) best = c;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------- catalog

const CATALOG_PARTS = ['meta', 'files', 'architecture', 'flows', 'api', 'env', 'tests', 'troubleshooting', 'boundary', 'commands'];

export function loadCatalog(root) {
  const dir = path.join(root, CATALOG_DIR);
  const catalog = {};
  for (const part of CATALOG_PARTS) {
    const file = path.join(dir, `${part}.json`);
    if (!exists(file)) throw new Error(`catalog part missing: ${posix(path.relative(root, file))}`);
    try { catalog[part] = readJson(file); } catch (e) { throw new Error(`${posix(path.relative(root, file))} is not valid JSON: ${e.message}`); }
  }
  return catalog;
}

// ---------------------------------------------------------------------------------------------------------- validation

const problem = (check, message) => ({ check, message });

/** Check 1 and 2: every scanned file is described, every catalog entry matches something. */
export function checkFiles(scan, catalog, { strict = false } = {}) {
  const problems = [];
  const warnings = [];
  const entries = catalog.files.files;
  const compiled = compileEntries(entries);
  const provisional = compileProvisional(catalog.meta);

  const undocumented = scan.files.filter((f) => f.path !== SELF_PAGE && !bestEntry(f.path, compiled));
  for (const f of undocumented) problems.push(problem(1, `file not described in the catalog: ${f.path}`));

  for (const c of compiled) {
    if (c.entry.virtual || c.entry.match === SELF_PAGE) continue; // the page itself does not exist before its first build
    const hit = scan.files.some((f) => c.re.test(f.path));
    if (!hit) {
      const msg = `catalog entry matches no file: ${c.entry.match}`;
      if (!strict && (c.entry.provisional || isProvisional(c.entry.match, provisional))) warnings.push(`provisional, not in the tree yet: ${c.entry.match}`);
      else problems.push(problem(2, msg));
    }
  }

  const dirSet = new Set(scan.dirs);
  for (const d of Object.keys(catalog.files.dirs || {})) {
    const name = d.replace(/\/$/, '');
    const entry = catalog.files.dirs[d];
    if (entry && entry.virtual) continue;
    if (!dirSet.has(name)) {
      if (!strict && isProvisional(name, provisional)) warnings.push(`provisional, not in the tree yet: ${d}`);
      else problems.push(problem(2, `catalog directory does not exist: ${d}`));
    }
  }
  for (const d of scan.dirs) {
    if (!d.includes('/') && !(`${d}/` in (catalog.files.dirs || {}))) problems.push(problem(1, `top-level directory not described in the catalog: ${d}/`));
  }
  return { problems, warnings };
}

function compileProvisional(meta) {
  return (meta.provisional || []).map((p) => ({ glob: p.glob, re: globToRegExp(p.glob), reason: p.reason }));
}
function isProvisional(rel, provisional) {
  return provisional.some((p) => p.re.test(rel) || p.re.test(rel.replace(/\/$/, '')) || p.re.test(`${rel.replace(/\/$/, '')}/x`));
}

/** Everything the catalog says about files outside files.json: diagram nodes, flow steps, boundary rows, test suites. */
export function collectReferences(catalog) {
  const refs = [];
  for (const n of catalog.architecture.nodes || []) for (const f of n.files || []) refs.push({ where: `architecture node "${n.id}"`, path: f });
  for (const fl of catalog.flows.flows || []) {
    (fl.steps || []).forEach((s, i) => { if (s.file) refs.push({ where: `flow "${fl.id}" step ${i + 1}`, path: s.file, fn: s.fn }); });
  }
  for (const b of catalog.boundary.rows || []) for (const f of b.files || []) refs.push({ where: `boundary row "${b.piece}"`, path: f });
  for (const g of catalog.boundary.finetuning || []) if (g.file) refs.push({ where: `fine-tuning point "${g.title}"`, path: g.file, fn: g.fn });
  for (const s of catalog.tests.suites || []) for (const f of s.files || []) refs.push({ where: `test suite "${s.id}"`, path: f });
  return refs;
}

/** Check 1b: every path the catalog mentions exists, and every named function is really in that file. */
export function checkReferences(root, scan, catalog, { strict = false } = {}) {
  const problems = [];
  const warnings = [];
  const provisional = compileProvisional(catalog.meta);
  const fileSet = new Set(scan.files.map((f) => f.path));
  const dirSet = new Set(scan.dirs);
  for (const ref of collectReferences(catalog)) {
    const p = ref.path;
    const isDir = p.endsWith('/');
    const found = hasWildcard(p) ? scan.files.some((f) => globToRegExp(p).test(f.path)) : isDir ? dirSet.has(p.slice(0, -1)) : fileSet.has(p);
    if (!found) {
      if (!strict && isProvisional(p, provisional)) warnings.push(`provisional, not in the tree yet: ${p} (${ref.where})`);
      else problems.push(problem(2, `${ref.where} points at a path that does not exist: ${p}`));
      continue;
    }
    if (ref.fn && !hasWildcard(p) && !isDir) {
      const name = String(ref.fn).replace(/\(.*$/, '').split('.').pop();
      const text = readText(path.join(root, p));
      if (!new RegExp(`(?<![A-Za-z0-9_$])${name.replace(/[$]/g, '\\$')}(?![A-Za-z0-9_$])`).test(text)) {
        if (!strict && isProvisional(p, provisional)) warnings.push(`provisional, function not found yet: ${ref.fn} in ${p} (${ref.where})`);
        else problems.push(problem(2, `${ref.where} names ${ref.fn}, which is not in ${p}`));
      }
    }
  }
  return { problems, warnings };
}

/** Schema checks that keep the authored data well formed (owners, tags, required fields). */
export function checkSchema(catalog) {
  const problems = [];
  const owners = new Set(Object.keys(catalog.meta.owners || {}));
  const tags = new Set(Object.keys(catalog.meta.tags || {}));
  const need = (obj, keys, where) => keys.forEach((k) => { if (obj[k] === undefined || obj[k] === '' || obj[k] === null) problems.push(problem(0, `${where} is missing "${k}"`)); });
  catalog.files.files.forEach((f) => {
    need(f, ['match', 'desc', 'owner'], `files entry ${f.match || '?'}`);
    if (f.owner && !owners.has(f.owner)) problems.push(problem(0, `files entry ${f.match}: unknown owner "${f.owner}"`));
    (f.tags || []).forEach((t) => { if (!tags.has(t)) problems.push(problem(0, `files entry ${f.match}: unknown tag "${t}"`)); });
  });
  const nodeIds = new Set((catalog.architecture.nodes || []).map((n) => n.id));
  (catalog.architecture.edges || []).forEach((e) => {
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) problems.push(problem(0, `edge ${e.id}: unknown node ${!nodeIds.has(e.from) ? e.from : e.to}`));
  });
  const edgeIds = new Set((catalog.architecture.edges || []).map((e) => e.id));
  (catalog.flows.flows || []).forEach((fl) => (fl.steps || []).forEach((s, i) => {
    (s.nodes || []).forEach((n) => { if (!nodeIds.has(n)) problems.push(problem(0, `flow ${fl.id} step ${i + 1}: unknown node ${n}`)); });
    (s.edges || []).forEach((e) => { if (!edgeIds.has(e)) problems.push(problem(0, `flow ${fl.id} step ${i + 1}: unknown edge ${e}`)); });
  }));
  (catalog.api.routes || []).forEach((r) => need(r, ['method', 'path', 'owner', 'summary'], `api route ${r.method} ${r.path}`));
  (catalog.env.vars || []).forEach((v) => need(v, ['name', 'group', 'readBy', 'effect'], `env var ${v.name}`));
  return problems;
}

// ---------------------------------------------------------------------------------------------------------- env vars

/** Names assigned in .env.example, including the commented-out examples (`# NAME=value`). */
export function parseEnvExample(text) {
  const names = [];
  const re = /^[ \t]*#?[ \t]*([A-Z][A-Z0-9_]*)[ \t]*=/gm;
  let m;
  while ((m = re.exec(text))) if (!names.includes(m[1])) names.push(m[1]);
  return names;
}

/** Check 4. Every name in .env.example is described; every described name is in it unless it carries `notInExample`. */
export function checkEnv(catalogVars, exampleNames) {
  const problems = [];
  const seen = new Set();
  const inExample = new Set(exampleNames);
  for (const v of catalogVars) {
    if (seen.has(v.name)) problems.push(problem(4, `env var described twice: ${v.name}`));
    seen.add(v.name);
    if (v.notInExample) {
      if (inExample.has(v.name)) problems.push(problem(4, `${v.name} is in .env.example, but the catalog says it is not (notInExample: "${v.notInExample}")`));
    } else if (!inExample.has(v.name)) {
      problems.push(problem(4, `${v.name} is described in the catalog but missing from .env.example (add it there, or give the entry a "notInExample" reason)`));
    }
  }
  for (const n of exampleNames) if (!seen.has(n)) problems.push(problem(4, `${n} is in .env.example but not described in the catalog`));
  return problems;
}

// ---------------------------------------------------------------------------------------------------------- routes

export const normalizeRoute = (method, p) => `${String(method).toUpperCase()} ${p.length > 1 ? p.replace(/\/+$/, '') : p}`;

function joinPath(prefix, p) {
  const rooted = p.startsWith('/') || p === '' ? p : `/${p}`;
  const joined = `${prefix === '/' ? '' : prefix}${rooted === '/' ? '' : rooted}`;
  return joined === '' ? '/' : joined;
}

/** Walks an Express 5 router stack. `mountOf(layer)` returns the path a nested router was mounted at. */
export function walkStack(stack, mountOf, prefix = '') {
  const out = [];
  for (const layer of stack || []) {
    if (layer.route) {
      const paths = [].concat(layer.route.path);
      let methods = Object.keys(layer.route.methods || {}).filter((m) => layer.route.methods[m]);
      if (methods.length > 8) methods = ['ALL'];
      else if (methods.includes('get')) methods = methods.filter((m) => m !== 'head');
      for (const p of paths) for (const m of methods) out.push({ method: m.toUpperCase(), path: joinPath(prefix, String(p)) });
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      for (const mp of [].concat(mountOf(layer) ?? '?')) out.push(...walkStack(layer.handle.stack, mountOf, joinPath(prefix, String(mp))));
    }
  }
  return out;
}

const CATCH_ALL = /^\/?(?:\*[A-Za-z_]*|\{\/?\*[A-Za-z_]*\})$/;

/**
 * Starts the real app the way a test would (model service off, a temporary env file, an explicit empty environment) and
 * reads the routes it registered. Never throws: returns {routes: null, warning} when the app cannot be imported yet.
 */
export async function readExpressRoutes(root, { createOptions } = {}) {
  const appFile = path.join(root, 'app.js');
  if (!exists(appFile)) return { routes: null, warning: 'app.js does not exist yet, so the registered routes could not be compared' };
  let restore = () => {};
  let tmp = '';
  try {
    const req = createRequire(appFile);
    const express = req('express');
    const mounts = new WeakMap();
    // Express 5 does not keep the path a router was mounted at, so every Router#use is recorded while the app is built.
    const target = typeof express.Router.prototype.use === 'function' ? express.Router.prototype : express.Router;
    const original = target.use;
    target.use = function patchedUse(...args) {
      const before = this.stack.length;
      const result = original.apply(this, args);
      const first = typeof args[0] === 'string' || Array.isArray(args[0]) ? args[0] : '/';
      for (let i = before; i < this.stack.length; i++) mounts.set(this.stack[i], first);
      return result;
    };
    restore = () => { target.use = original; };

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-overview-'));
    const envPath = path.join(tmp, 'overview.env');
    fs.writeFileSync(envPath, '');
    const mod = await import(`${pathToFileURL(appFile).href}?overview=${Date.now()}`);
    if (typeof mod.createApp !== 'function') return { routes: null, warning: 'app.js does not export createApp(), so the registered routes could not be compared' };
    const options = createOptions ? createOptions({ envPath, root }) : { root, envPath, environ: { TERUCON_ENV_FILE: envPath, MODEL_SERVICE: 'off' }, model: { mode: 'off' } };
    const app = await mod.createApp(options);
    const stack = (app.router && app.router.stack) || (app._router && app._router.stack);
    if (!stack) return { routes: null, warning: 'the Express app exposes no router stack' };
    const routes = walkStack(stack, (layer) => (mounts.has(layer) ? mounts.get(layer) : '?'));
    const closer = (app.locals && app.locals.terucon && app.locals.terucon.close) || app.close;
    if (typeof closer === 'function') { try { await closer.call(app); } catch { /* nothing was started */ } }
    return { routes };
  } catch (e) {
    return { routes: null, warning: `app.js could not be started for the route check (${String(e && e.message || e).split('\n')[0]})` };
  } finally {
    restore();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Python routes, read from the Flask decorators in model/terucon_model (the service cannot be started here). */
export function readPythonRoutes(root) {
  const dir = path.join(root, 'model/terucon_model');
  if (!exists(dir)) return { routes: null, warning: 'model/terucon_model does not exist yet, so the Python routes could not be compared' };
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory() && !isIgnoredName(e.name, true)) walk(abs);
      else if (e.isFile() && e.name.endsWith('.py')) {
        const text = readText(abs);
        const re = /@\w+\.(get|post|put|delete|patch|route)\(\s*["']([^"']+)["']([^)]*)\)/g;
        let m;
        while ((m = re.exec(text))) {
          if (m[1] === 'route') {
            const methods = /methods\s*=\s*\[([^\]]*)\]/.exec(m[3]);
            for (const meth of methods ? methods[1].match(/[A-Za-z]+/g) : ['GET']) out.push({ method: meth.toUpperCase(), path: m[2] });
          } else out.push({ method: m[1].toUpperCase(), path: m[2] });
        }
      }
    }
  };
  walk(dir);
  return { routes: out };
}

/** Check 3. `registered` and `python` may be null (could not be read): then that half is skipped, not failed. */
export function checkRoutes(catalogRoutes, registered, python, site = null) {
  const problems = [];
  const siteRoutes = site ? siteRoutePaths(site) : [];
  const at = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  for (const r of catalogRoutes) {
    if (r.siteRef && site) {
      const actual = at(site, r.siteRef);
      if (actual !== r.path) problems.push(problem(3, `catalog route ${r.method} ${r.path} should be ${actual === undefined ? 'removed (site.json has no ' + r.siteRef + ')' : actual} according to site.json ${r.siteRef}`));
    }
  }
  const key = (r) => normalizeRoute(r.method, r.path);
  const dup = new Set();
  for (const r of catalogRoutes) {
    if (dup.has(key(r))) problems.push(problem(3, `route described twice in the catalog: ${key(r)}`));
    dup.add(key(r));
  }
  const compare = (owner, actual, label) => {
    if (!actual) return;
    const expected = catalogRoutes.filter((r) => r.owner === owner && !r.derived);
    const have = new Map(actual.filter((r) => !CATCH_ALL.test(r.path)).map((r) => [key(r), r]));
    for (const r of expected) {
      if (!have.has(key(r))) {
        const all = actual.some((a) => a.method === 'ALL' && a.path === r.path);
        if (!all) problems.push(problem(3, `catalog route ${key(r)} (${owner}) is not registered by ${label}`));
      }
    }
    const known = new Set([...expected.map(key), ...catalogRoutes.filter((r) => r.owner === owner).map(key)]);
    const derived = new Set(siteRoutes.map((p) => `GET ${p}`));
    for (const [k, r] of have) {
      if (r.method === 'ALL' && catalogRoutes.some((c) => c.path === r.path)) continue;
      if (!known.has(k) && !derived.has(k)) problems.push(problem(3, `${label} registers ${k}, which the catalog does not describe`));
    }
  };
  compare('JS', registered, 'the Express app (app.js)');
  compare('Python', python, 'the model service (model/terucon_model)');
  return problems;
}

/** The URLs the site.json pages answer on (route, aliases, legacy names, docs). Used to tell derived routes from stray ones. */
export function siteRoutePaths(site) {
  const out = new Set();
  for (const p of Object.values(site.pages || {})) { out.add(p.route); (p.aliases || []).forEach((a) => out.add(a)); }
  for (const name of Object.keys(site.legacy_names || {})) out.add(`/${name}`);
  for (const d of Object.values(site.docs || {})) { out.add(d.route); (d.aliases || []).forEach((a) => out.add(a)); }
  return [...out];
}

// ---------------------------------------------------------------------------------------------------------- tests

const COUNTERS = {
  'node-test': /^[ \t]*(?:test|it)(?:\.(?:skip|todo|only))?[ \t]*\(/gm,
  'py-def': /^[ \t]*(?:async[ \t]+)?def[ \t]+test_/gm,
  'await-test': /\bawait test\(/g,
};

export function countTests(root, suites, files) {
  return suites.map((s) => {
    const counter = COUNTERS[s.counter];
    if (!counter) throw new Error(`test suite ${s.id}: unknown counter "${s.counter}"`);
    const res = (s.files || []).map(globToRegExp);
    const matched = files.filter((f) => res.some((re) => re.test(f.path)));
    const perFile = matched.map((f) => {
      const text = readText(path.join(root, f.path));
      return { path: f.path, count: (text.match(new RegExp(counter.source, counter.flags)) || []).length };
    });
    return { ...s, perFile, count: perFile.reduce((a, b) => a + b.count, 0) };
  });
}

// ---------------------------------------------------------------------------------------------------------- site facts

/**
 * Soft dependency: tools/check-links.js (checkPages). Reduced to {from: {to: {linked, required}}}; `linked` is null
 * when the built page is missing. Returns matrix null when the tool is not there or fails.
 */
export async function readLinkMatrix(root, site) {
  const tool = path.join(root, 'tools/check-links.js');
  if (!exists(tool)) return { matrix: null, warning: 'tools/check-links.js is not there yet, so the connection matrix shows only what site.json requires' };
  try {
    const mod = await import(pathToFileURL(tool).href);
    const result = mod.checkPages({ root, site });
    return { matrix: buildMatrix(site, result) };
  } catch (e) {
    return { matrix: null, warning: `tools/check-links.js could not be used (${String(e && e.message || e).split('\n')[0]}), so the connection matrix shows only what site.json requires` };
  }
}

/** `result` is the checkPages() object: {pages: {key: {exists, linkedPages: [...]}}}. */
export function buildMatrix(site, result) {
  const keys = Object.keys(site.pages);
  const out = {};
  for (const from of keys) {
    const page = result && result.pages && result.pages[from];
    const required = (site.connections && site.connections[from]) || [];
    out[from] = {};
    for (const to of keys) {
      if (to === from) continue;
      out[from][to] = { linked: page && page.exists ? (page.linkedPages || []).includes(to) : null, required: required.includes(to) };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------- data

const AUTHORED_EXCLUDE_TAGS = new Set(['Generated', 'Source', 'Lock']);

function describeFiles(scan, catalog) {
  const compiled = compileEntries(catalog.files.files);
  const rows = [];
  const groups = new Map();
  for (const f of scan.files) {
    const hit = bestEntry(f.path, compiled);
    if (!hit) continue;
    const e = hit.entry;
    const self = f.path === SELF_PAGE;
    const base = { path: f.path, lang: f.lang, bytes: self ? null : f.bytes, lines: self ? null : f.lines, owner: e.owner, tags: e.tags || [], desc: e.desc, self: self || undefined, provisional: e.provisional || undefined };
    if (e.summarize) {
      let g = groups.get(e.match);
      if (!g) {
        g = { path: e.match, group: true, count: 0, bytes: 0, lines: null, lang: f.lang, owner: e.owner, tags: e.tags || [], desc: e.desc, names: [], dir: path.posix.dirname(f.path) };
        groups.set(e.match, g);
      }
      g.count++; g.bytes += f.bytes; g.names.push(path.posix.basename(f.path));
      if (f.lines !== null) g.lines = (g.lines || 0) + f.lines;
    } else rows.push(base);
  }
  for (const e of catalog.files.files) {
    if (e.virtual && !hasWildcard(e.match)) rows.push({ path: e.match, lang: 'Text', bytes: null, lines: null, owner: e.owner, tags: e.tags || [], desc: e.desc, virtual: true });
  }
  return [...rows, ...groups.values()].sort((a, b) => cmp(a.path, b.path));
}

/** dirs may be written as a string or as {desc, virtual}; the page gets one shape. */
export function normalizeDirs(dirs) {
  const out = {};
  for (const [k, v] of Object.entries(dirs || {})) out[k] = typeof v === 'string' ? { desc: v } : { desc: v.desc, virtual: v.virtual || undefined };
  return out;
}

function summarize(files, catalog) {
  const flat = [];
  for (const f of files) {
    if (f.self || f.virtual) continue;
    if (f.group) flat.push({ ...f, authored: false });
    else flat.push({ ...f, authored: f.lines !== null && !(f.tags || []).some((t) => AUTHORED_EXCLUDE_TAGS.has(t)) });
  }
  const sum = (arr, key) => arr.reduce((a, b) => a + (b[key] || 0), 0);
  const byLang = {};
  for (const f of flat) {
    const l = f.lang;
    const slot = (byLang[l] ||= { files: 0, lines: 0, bytes: 0, authoredFiles: 0, authoredLines: 0 });
    const n = f.group ? f.count : 1;
    slot.files += n; slot.bytes += f.bytes || 0; slot.lines += f.lines || 0;
    if (f.authored) { slot.authoredFiles += n; slot.authoredLines += f.lines || 0; }
  }
  const authored = flat.filter((f) => f.authored);
  const byOwner = {};
  for (const f of flat) {
    const slot = (byOwner[f.owner] ||= { files: 0, lines: 0, authoredLines: 0 });
    slot.files += f.group ? f.count : 1; slot.lines += f.lines || 0;
    if (f.authored) slot.authoredLines += f.lines || 0;
  }
  const js = byLang.JavaScript ? byLang.JavaScript.authoredLines : 0;
  const py = byLang.Python ? byLang.Python.authoredLines : 0;
  const runtime = (lang) => authored.filter((f) => f.lang === lang && f.owner !== 'tests').reduce((a, b) => a + b.lines, 0);
  return {
    totals: { files: sum(flat.map((f) => ({ n: f.group ? f.count : 1 })), 'n'), lines: sum(flat, 'lines'), bytes: sum(flat, 'bytes'), authoredLines: sum(authored, 'lines') },
    byLang, byOwner,
    scoreboard: {
      js, py, jsShare: js + py ? js / (js + py) : 0,
      runtimeJs: runtime('JavaScript'), runtimePy: runtime('Python'),
      baseline: catalog.meta.baseline || null,
    },
  };
}

function readPackage(root) {
  const pkg = readJson(path.join(root, 'package.json'));
  return { name: pkg.name, version: pkg.version, scripts: pkg.scripts || {}, dependencies: pkg.dependencies || {}, engines: pkg.engines || {} };
}

function checkScripts(pkg, catalog) {
  const problems = [];
  const described = new Set();
  for (const c of catalog.commands.npm || []) {
    if (described.has(c.script)) problems.push(problem(0, `npm script described twice: ${c.script}`));
    described.add(c.script);
    if (!(c.script in pkg.scripts)) problems.push(problem(2, `catalog describes npm script "${c.script}", which package.json does not have`));
  }
  for (const s of Object.keys(pkg.scripts)) if (!described.has(s)) problems.push(problem(1, `npm script "${s}" is not described in the catalog (docs/overview/catalog/commands.json)`));
  return problems;
}

function readSite(root) {
  const file = path.join(root, 'site/site.json');
  if (!exists(file)) return null;
  return readJson(file);
}

/**
 * Collects everything: scan, catalog, derived facts, and the problems found on the way.
 * Options: strict, skipRoutes (don't start the app), skipLinks (don't run check-links), createOptions.
 */
export async function collect(root, options = {}) {
  const catalog = loadCatalog(root);
  const scan = scanTree(root, catalog.meta.scan?.ignore || []);
  // The page lists itself, with no size or lines (they would change every time it is written), whether or not it exists yet:
  // otherwise the first build and the second would differ and the page would look stale straight after it was written.
  if (!scan.files.some((f) => f.path === SELF_PAGE)) {
    scan.files.push({ path: SELF_PAGE, bytes: 0, lines: 0, lang: 'HTML', binary: false });
    scan.files.sort((a, b) => cmp(a.path, b.path));
  }
  const problems = [];
  const warnings = [];

  problems.push(...checkSchema(catalog));
  const f = checkFiles(scan, catalog, options);
  problems.push(...f.problems); warnings.push(...f.warnings);
  const r = checkReferences(root, scan, catalog, options);
  problems.push(...r.problems); warnings.push(...r.warnings);

  const pkgFile = path.join(root, 'package.json');
  const pkg = exists(pkgFile) ? readPackage(root) : { name: 'terucon', version: '', scripts: {}, dependencies: {}, engines: {} };
  problems.push(...checkScripts(pkg, catalog));

  const envFile = path.join(root, '.env.example');
  const envNames = exists(envFile) ? parseEnvExample(readText(envFile)) : [];
  if (!exists(envFile)) problems.push(problem(4, '.env.example does not exist'));
  problems.push(...checkEnv(catalog.env.vars, envNames));

  const site = readSite(root);
  if (!site) problems.push(problem(0, 'site/site.json does not exist'));

  let registered = null;
  let python = null;
  const catalogRoutes = catalog.api.routes;
  if (!options.skipRoutes) {
    const ex = await readExpressRoutes(root, { createOptions: options.createOptions });
    if (ex.warning) warnings.push(ex.warning);
    registered = ex.routes;
    const py = readPythonRoutes(root);
    if (py.warning) warnings.push(py.warning);
    python = py.routes;
    problems.push(...checkRoutes(catalogRoutes, registered, python, site));
  }

  let matrix = null;
  if (site && !options.skipLinks) {
    const lm = await readLinkMatrix(root, site);
    if (lm.warning) warnings.push(lm.warning);
    matrix = lm.matrix;
  }

  const testSuites = countTests(root, catalog.tests.suites, scan.files);
  for (const s of testSuites) if (s.perFile.length === 0 && !s.provisional) {
    if (!options.strict && isProvisional(s.files[0] || '', compileProvisional(catalog.meta))) warnings.push(`provisional, no files yet: test suite ${s.id}`);
    else problems.push(problem(2, `test suite "${s.id}" matches no file (${(s.files || []).join(', ')})`));
  }

  const files = describeFiles(scan, catalog);
  const sums = summarize(files, catalog);
  const verified = (r2) => {
    const k = normalizeRoute(r2.method, r2.path);
    const list = r2.owner === 'JS' ? registered : python;
    if (!list || r2.derived) return null;
    return list.some((x) => normalizeRoute(x.method, x.path) === k || (x.method === 'ALL' && x.path === r2.path));
  };

  const data = {
    schema: 1,
    meta: {
      title: catalog.meta.title, tagline: catalog.meta.tagline, hero: catalog.meta.hero, owners: catalog.meta.owners, tags: catalog.meta.tags,
      languages: catalog.meta.languages, version: pkg.version, packageName: pkg.name, node: pkg.engines.node || '', baseline: catalog.meta.baseline || null,
      docs: catalog.meta.docs || [], generatedFrom: catalog.meta.generatedFrom,
    },
    stats: { files: sums.totals.files, lines: sums.totals.lines, authoredLines: sums.totals.authoredLines, routes: catalogRoutes.length, tests: testSuites.reduce((a, b) => a + b.count, 0), envVars: catalog.env.vars.length, pages: site ? Object.keys(site.pages).length : 0 },
    site: site && {
      name: site.name, linkStyle: site.linkStyle,
      pages: Object.entries(site.pages).map(([key, p]) => ({ key, label: p.label, nav: p.nav, description: p.description, route: p.route, source: p.source, file: p.file, aliases: p.aliases || [], headers: p.headers || {}, sourceExists: exists(path.join(root, p.source)), fileExists: exists(path.join(root, p.file)) })),
      legacy: site.legacy_names || {}, docs: site.docs || {}, media: site.media || {}, connections: Object.fromEntries(Object.entries(site.connections || {}).filter(([k]) => !k.startsWith('_'))), matrix,
    },
    dirs: normalizeDirs(catalog.files.dirs), files, byLang: sums.byLang, byOwner: sums.byOwner, scoreboard: sums.scoreboard,
    architecture: catalog.architecture,
    flows: catalog.flows.flows,
    api: { intro: catalog.api.intro, errorShape: catalog.api.errorShape, groups: catalog.api.groups, routes: catalogRoutes.map((r2) => ({ ...r2, verified: verified(r2) })), checkedAgainst: { express: registered !== null, python: python !== null } },
    env: { precedence: catalog.env.precedence, groups: catalog.env.groups, notes: catalog.env.notes, vars: catalog.env.vars },
    tests: { intro: catalog.tests.intro, suites: testSuites, checks: catalog.tests.checks || [], total: testSuites.reduce((a, b) => a + b.count, 0) },
    scripts: (catalog.commands.npm || []).map((c) => ({ ...c, cmd: pkg.scripts[c.script] || '' })),
    commands: { groups: catalog.commands.groups, extra: catalog.commands.extra },
    troubleshooting: catalog.troubleshooting.rows,
    boundary: catalog.boundary,
  };
  return { data, problems, warnings, scan, catalog };
}

// ---------------------------------------------------------------------------------------------------------- render

const U2028 = /\u2028/g;
const U2029 = /\u2029/g;
/** JSON that is safe inside <script type="application/json">: no `<`, `>` or `&`, so `</script>` and `<!--` cannot appear. */
export function embedJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(U2028, '\\u2028').replace(U2029, '\\u2029');
}

export function darkTokensCss(tokens) {
  const body = tokens.trim();
  return `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${body.replace(/\s*\n\s*/g, ' ')} color-scheme: dark; } }\n:root[data-theme="dark"] { ${body.replace(/\s*\n\s*/g, ' ')} color-scheme: dark; }`;
}

export function renderHtml(root, data, { generatedAt = new Date().toISOString() } = {}) {
  const dir = path.join(root, OVERVIEW_DIR);
  const template = readText(path.join(dir, 'template.html'));
  const css = readText(path.join(dir, 'overview.css')).replace('/* @@DARK_TOKENS@@ */', () => darkTokensCss(readText(path.join(dir, 'dark-tokens.css'))));
  const script = readText(path.join(dir, 'overview.js'));
  if (/<\/script/i.test(script)) throw new Error('docs/overview/overview.js contains "</script", which would end the inline script early');
  const boot = readText(path.join(dir, 'theme-boot.js'));
  const slots = { '{{TITLE}}': escapeHtml(data.meta.title), '{{GENERATED}}': escapeHtml(generatedAt), '{{THEME_BOOT}}': boot, '{{STYLE}}': css, '{{DATA}}': embedJson(data), '{{SCRIPT}}': script };
  let html = template;
  for (const [slot, value] of Object.entries(slots)) {
    if (!html.includes(slot)) throw new Error(`docs/overview/template.html has no ${slot} slot`);
    html = html.split(slot).join('\u0000' + slot);   // protect against a value that itself contains a slot name
  }
  for (const [slot, value] of Object.entries(slots)) html = html.split('\u0000' + slot).join(value);
  return html;
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const GENERATED_META = /(<meta name="generated" content=")[^"]*(")/;
/** The one place the time appears. Two pages that differ only here count as the same page. */
export const stripTimestamp = (html) => html.replace(GENERATED_META, '$1$2');

export function isStale(committed, fresh) {
  return stripTimestamp(committed) !== stripTimestamp(fresh);
}

// ---------------------------------------------------------------------------------------------------------- main

/** git's idea of the project files, to make sure the scanner never opened something git would ignore. Null if git is unavailable. */
export function gitVisibleFiles(root) {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  return new Set(r.stdout.split('\0').filter(Boolean));
}

export function checkPrivacy(root, scan) {
  const visible = gitVisibleFiles(root);
  if (!visible) return [];
  return scan.files.filter((f) => f.path !== SELF_PAGE && !visible.has(f.path)).map((f) => problem(0, `the scanner read ${f.path}, which git ignores (add it to IGNORED_* in tools/build-overview.js)`));
}

export async function run(root, argv, io = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) }) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const check = flags.has('--check');
  const strict = flags.has('--strict');
  const { data, problems, warnings, scan } = await collect(root, { strict, skipRoutes: flags.has('--no-routes'), skipLinks: flags.has('--no-links') });
  if (!flags.has('--no-git')) problems.push(...checkPrivacy(root, scan));

  const out = path.join(root, OUTPUT);
  let html = '';
  let stale = false;
  if (!problems.length) {
    html = renderHtml(root, data);
    stale = !exists(out) || isStale(readText(out), html);
    if (check && stale) problems.push(problem(5, `${OUTPUT} is stale: regenerate it with "node tools/build-overview.js" and commit it`));
  }

  for (const w of warnings) io.err(`warning: ${w}`);
  if (problems.length) {
    const labels = { 0: 'catalog format', 1: 'undocumented', 2: 'ghost entries', 3: 'routes', 4: 'environment variables', 5: 'generated page' };
    io.err(`\n${problems.length} problem${problems.length === 1 ? '' : 's'} with the project overview:`);
    for (const check of [1, 2, 3, 4, 5, 0]) {
      const list = problems.filter((p) => p.check === check);
      if (!list.length) continue;
      io.err(`\n  ${labels[check]}`);
      for (const p of list) io.err(`    - ${p.message}`);
    }
    io.err('\nFix the catalog in docs/overview/catalog/ (or the project), then run: node tools/build-overview.js');
    return 1;
  }
  if (check) { io.out(`overview ok: ${data.stats.files} files, ${data.stats.routes} routes, ${data.stats.tests} tests, ${data.stats.envVars} variables${warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? '' : 's'})` : ''}`); return 0; }
  if (!stale && !flags.has('--force')) { io.out(`${OUTPUT} is up to date (${data.stats.files} files, ${data.stats.routes} routes, ${data.stats.tests} tests)`); return 0; }
  fs.writeFileSync(out, html);
  io.out(`wrote ${OUTPUT}  (${(html.length / 1024).toFixed(0)} KB; ${data.stats.files} files, ${data.stats.routes} routes, ${data.stats.tests} tests, ${data.stats.envVars} variables)`);
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  run(ROOT, process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => { console.error(e && e.stack || e); process.exit(2); },
  );
}
