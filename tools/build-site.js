#!/usr/bin/env node
// Rebuild the four site pages (pages/*.html) from the pristine Claude Design exports in pages_original/.
//
//   node tools/build-site.js                    rebuild all pages
//   node tools/build-site.js --check            patch in memory and report, write nothing
//   node tools/build-site.js --only studio      rebuild one page (key from site/site.json)
//   node tools/build-site.js --if-missing       build only the pages whose output file is missing (npm start runs this;
//                                               it only looks at the output files, so after changing a patch or an export run a full build)
//   node tools/build-site.js --link-style file  override site.json linkStyle: "route" (/materials) or "file" (materials.html)
//   node tools/build-site.js --out DIR          write the pages to DIR instead (named like the `file` of site.json)
//   node tools/build-site.js --write-golden     rewrite tests/fixtures/pages-golden.json from this build (see below)
//
// What it does, per page: the page definition is data. site/site.json says where each page comes from and
// goes to; site/patches/<key>.json is an ordered list of anchored edits (format: site/patches/README.md);
// site/components.json holds the HTML of the navigation entries the patches add; large injected JS lives
// in site/patches/snippets/. Every anchor must match exactly once, so a re-exported page that no longer
// matches fails loudly (page, step id, anchor text) instead of being half-patched. The patched Design Studio
// app module and its in-browser worker are parsed with `node --check` before they are written.
//
// Always builds from pages_original/, never from its own output, so it is safe to run repeatedly.
// All pages are built in memory first; if any fails, nothing is written.
//
// Golden digests: tests/fixtures/pages-golden.json holds the sha256 of every decoded template and asset of a
// build that was checked against the old Python tool. tests/js/site-golden.test.js rebuilds in memory and
// compares. After an intended change of the patches or of pages_original/, review the pages, then run
// `node tools/build-site.js --write-golden` and commit the new file.
//
// Node built-ins only.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Bundle, PatchError } from './bundle.js';
import { checkPages, loadSite } from './check-links.js';

export { Bundle, PatchError, loadSite };
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LINK_STYLES = ['route', 'file'];

// ---- links ---------------------------------------------------------------------------------------

/** Python's urllib.parse.quote(s): UTF-8 percent-encoding that keeps A-Za-z0-9 _.-~ and "/". */
export function pyQuote(s) {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%2F/g, '/');
}

/**
 * href(pageKey, fragment) for one link style. "route": the page's route ("/materials", "/" for home).
 * "file": the file name of the page (the basename of site.json `file`, e.g. materials.html), percent-encoded;
 * `linkNames` ({pageKey: name}) replaces the names (the equivalence test uses the old flat file names).
 */
export function makeHref(site, style, linkNames = {}) {
  if (!LINK_STYLES.includes(style)) throw new PatchError(`unknown link style ${JSON.stringify(style)} (expected ${LINK_STYLES.join(' or ')})`);
  return (key, fragment = '') => {
    const page = site.pages[key];
    if (!page) throw new PatchError(`unknown page ${JSON.stringify(key)} (site.json pages: ${Object.keys(site.pages).join(', ')})`);
    return style === 'route' ? page.route + fragment : pyQuote(linkNames[key] ?? path.posix.basename(page.file)) + fragment;
  };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Rewrite the design-time names of site.json `legacy_names` ("Design Studio.dc.html", ...) to the links of the site. */
export function relinkText(text, site, href) {
  let total = 0;
  for (const [legacy, key] of Object.entries(site.legacy_names || {})) {
    const target = href(key);
    for (const variant of new Set([pyQuote(legacy), legacy])) {
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}_%.\\-])${escapeRegExp(variant)}(?=[#?"'\`\\s)])`, 'gu');
      text = text.replace(pattern, () => {
        total += 1;
        return target;
      });
    }
  }
  return { text, count: total };
}

// ---- components: the HTML of the entries the patches add --------------------------------------------

const PLACEHOLDER = /\{\{(link:[A-Za-z0-9_-]+|[A-Za-z][A-Za-z0-9_]*)\}\}/g;
const SECTION = /\{\{#([A-Za-z][A-Za-z0-9_]*)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
const ALWAYS_ALLOWED = new Set(['page', 'fragment', 'target']);

/**
 * Expand one `{component, entry?, ...params}` part. `{{name}}` takes the parameter, `{{#name}}..{{/name}}` is kept
 * when the parameter is true, `{{target}}` is the link to `page` (+ `fragment`) and `{{link:KEY}}` the link to page KEY.
 * Anything else, including the pages' own `{{ savedN }}` text, is left alone: only component bodies are expanded.
 */
export function renderComponent(part, components, href, where) {
  const body = components.components?.[part.component];
  if (typeof body !== 'string') {
    throw new PatchError(`[${where}] unknown component ${JSON.stringify(part.component)} (components.json has: ${Object.keys(components.components || {}).join(', ')})`);
  }
  let entry = {};
  if (part.entry !== undefined) {
    entry = components.entries?.[part.entry];
    if (!entry) throw new PatchError(`[${where}] unknown entry ${JSON.stringify(part.entry)} (components.json has: ${Object.keys(components.entries || {}).join(', ')})`);
  }
  const given = Object.fromEntries(Object.entries(part).filter(([k]) => k !== 'component' && k !== 'entry'));
  const params = { ...entry, ...given };

  const used = new Set();
  let html = body.replace(SECTION, (_, name, inner) => {
    used.add(name);
    return params[name] === true ? inner : '';
  });
  html = html.replace(PLACEHOLDER, (_, name) => {
    if (name.startsWith('link:')) return href(name.slice(5));
    used.add(name);
    if (name === 'target') {
      if (typeof params.target === 'string') return params.target;
      if (typeof params.page !== 'string') throw new PatchError(`[${where}] component ${part.component} needs a "page" (or "target") for {{target}}`);
      return href(params.page, params.fragment ?? '');
    }
    const value = params[name];
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new PatchError(`[${where}] component ${part.component}: no value for {{${name}}} (give it in the step or in the entry)`);
    }
    return String(value);
  });
  for (const key of Object.keys(given)) {
    if (!used.has(key) && !ALWAYS_ALLOWED.has(key)) {
      throw new PatchError(`[${where}] component ${part.component} has no {{${key}}} (a typo in the step?)`);
    }
  }
  return html;
}

// ---- JS string literal inside the app (the in-browser worker) ---------------------------------------

const SIMPLE_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0', '\\': '\\', "'": "'", '"': '"', '`': '`' };

/** Decode the quoted JS string literal that begins at text[start] (the opening quote). Returns {value, end} with end after the closing quote. */
export function scanJsString(text, start) {
  const quote = text[start];
  if (quote !== "'" && quote !== '"') throw new PatchError(`no string literal at offset ${start}`);
  let out = '';
  let i = start + 1;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === quote) return { value: out, end: i + 1 };
    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }
    i += 1;
    const esc = text[i];
    if (esc in SIMPLE_ESCAPES && !(esc === '0' && i + 1 < n && /[0-9]/.test(text[i + 1]))) {
      out += SIMPLE_ESCAPES[esc];
      i += 1;
    } else if (esc === 'x') {
      out += String.fromCharCode(hex(text.slice(i + 1, i + 3), 2));
      i += 3;
    } else if (esc === 'u') {
      if (text[i + 1] === '{') {
        const j = text.indexOf('}', i);
        if (j === -1) throw new PatchError('unterminated \\u{...} escape while decoding a string literal');
        out += String.fromCodePoint(hex(text.slice(i + 2, j), 0));
        i = j + 1;
      } else {
        out += String.fromCharCode(hex(text.slice(i + 1, i + 5), 4)); // a surrogate pair stays two UTF-16 units
        i += 5;
      }
    } else if (esc === '\n') {
      i += 1; // line continuation
    } else {
      out += esc;
      i += 1;
    }
  }
  throw new PatchError('unterminated string literal while decoding the worker');
}

function hex(digits, length) {
  if (!/^[0-9a-fA-F]+$/.test(digits) || (length && digits.length !== length)) throw new PatchError(`bad hex escape in a string literal: ${JSON.stringify(digits)}`);
  return parseInt(digits, 16);
}

/** A JS string literal for `value` (JSON is valid JS), kept clear of anything an HTML parser could trip on. */
export function jsString(value) {
  return JSON.stringify(value).split('</').join('<\\/');
}

// ---- syntax check -----------------------------------------------------------------------------------

/** Parse the patched module with node, so a bad edit is caught here and not in somebody's browser. `name` should end in .mjs (the runtime uses top-level await). */
export function checkSyntax(code, name, where = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-syntax-'));
  try {
    const file = path.join(dir, name);
    fs.writeFileSync(file, code, 'utf8');
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 120000 });
    if (r.error) throw new PatchError(`${where}could not run node --check: ${r.error.message}`);
    if (r.status !== 0) throw new PatchError(`${where}patched ${name} does not parse:\n${(r.stderr || '').slice(0, 800)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- patch files --------------------------------------------------------------------------------------

const COMMON_KEYS = ['id', 'op', 'why', 'target'];
const OP_KEYS = {
  relink: ['expect'],
  replace: ['anchor', 'with'],
  insertAfter: ['anchor', 'insert'],
  insertBefore: ['anchor', 'insert'],
  replaceAll: ['anchor', 'with', 'count'],
  insertAfterLeadingComment: ['insert'],
  checkSyntax: ['name'],
  inJsString: ['open', 'steps'],
  group: ['steps'],
};
const REQUIRED = {
  relink: [],
  replace: ['anchor', 'with'],
  insertAfter: ['anchor', 'insert'],
  insertBefore: ['anchor', 'insert'],
  replaceAll: ['anchor', 'with', 'count'],
  insertAfterLeadingComment: ['insert'],
  checkSyntax: ['name'],
  inJsString: ['open', 'steps'],
  group: ['steps'],
};

function validateParts(value, where) {
  if (typeof value === 'string') return;
  if (Array.isArray(value)) return value.forEach((v) => validateParts(v, where));
  if (value && typeof value === 'object' && (typeof value.file === 'string' || typeof value.component === 'string')) return;
  throw new PatchError(`[${where}] a replacement must be a string, a {"file"} / {"component"} part, or a list of those`);
}

/** Check the shape of a patch file; every mistake names the page and the step. */
export function validatePatchSpec(spec, key, nested = false, prefix = key) {
  const steps = nested ? spec : spec?.steps;
  if (!spec || !Array.isArray(steps)) throw new PatchError(`[${key}] patch file needs a "steps" list`);
  if (!nested && spec.page !== key) throw new PatchError(`[${key}] patch file says page ${JSON.stringify(spec.page)}, expected ${JSON.stringify(key)}`);
  const ids = new Set();
  for (const step of steps) {
    const where = `${prefix}/${step?.id ?? '?'}`;
    if (!step || typeof step.id !== 'string' || !step.id) throw new PatchError(`[${prefix}] every step needs an "id"`);
    if (ids.has(step.id)) throw new PatchError(`[${where}] duplicate step id`);
    ids.add(step.id);
    if (!OP_KEYS[step.op]) throw new PatchError(`[${where}] unknown op ${JSON.stringify(step.op)} (known: ${Object.keys(OP_KEYS).join(', ')})`);
    if (typeof step.why !== 'string' || !step.why.trim()) throw new PatchError(`[${where}] every step needs a "why"`);
    const allowed = new Set([...COMMON_KEYS, ...OP_KEYS[step.op]]);
    for (const k of Object.keys(step)) {
      if (!allowed.has(k) && !k.startsWith('_')) throw new PatchError(`[${where}] unknown field ${JSON.stringify(k)} for op ${step.op}`);
    }
    for (const k of REQUIRED[step.op]) if (!(k in step)) throw new PatchError(`[${where}] op ${step.op} needs "${k}"`);
    if (step.target !== undefined && (nested || !(step.target === 'template' || /^asset:[^\s]+$/.test(step.target)))) {
      throw new PatchError(`[${where}] "target" must be "template" or "asset:<ext resource name>" and only on top-level steps`);
    }
    if ('anchor' in step && (typeof step.anchor !== 'string' || !step.anchor)) throw new PatchError(`[${where}] "anchor" must be a non-empty string`);
    if ('with' in step) validateParts(step.with, where);
    if ('insert' in step) validateParts(step.insert, where);
    if ('count' in step && !(Number.isInteger(step.count) && step.count > 0)) throw new PatchError(`[${where}] "count" must be a positive integer`);
    if ('expect' in step && !(Number.isInteger(step.expect) && step.expect >= 0)) throw new PatchError(`[${where}] "expect" must be a non-negative integer`);
    if (step.op === 'inJsString' && !/['"]$/.test(step.open)) throw new PatchError(`[${where}] "open" must end with the opening quote of the string literal, e.g. "var Cn='"`);
    if (step.steps !== undefined) {
      if (!Array.isArray(step.steps)) throw new PatchError(`[${where}] "steps" must be a list`);
      validatePatchSpec(step.steps, key, true, where);
    }
  }
  return spec;
}

// ---- running the steps --------------------------------------------------------------------------------

export function countOccurrences(text, needle) {
  let n = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) n += 1;
  return n;
}

function preview(text, max = 90) {
  return JSON.stringify(text.length > max ? text.slice(0, max) + '…' : text);
}

/** Holds the decoded template and the decoded text of each asset being patched; commit() writes them back into the bundle. */
class Workspace {
  constructor(bundle) {
    this.bundle = bundle;
    this.template = bundle.template;
    this.assets = new Map(); // ext name -> {uuid, original, text}
  }

  asset(name) {
    let a = this.assets.get(name);
    if (!a) {
      const uuid = this.bundle.extUuid(name);
      const text = this.bundle.assetText(uuid);
      a = { uuid, original: text, text };
      this.assets.set(name, a);
    }
    return a;
  }

  scopeFor(target = 'template') {
    if (target === 'template') {
      return { get: () => this.template, set: (v) => { this.template = v; } };
    }
    const a = this.asset(target.slice('asset:'.length));
    return { get: () => a.text, set: (v) => { a.text = v; } };
  }

  commit() {
    this.bundle.template = this.template;
    for (const a of this.assets.values()) if (a.text !== a.original) this.bundle.setAsset(a.uuid, a.text);
  }
}

function readSnippet(ctx, rel, where) {
  const base = path.resolve(ctx.patchesDir);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new PatchError(`[${where}] snippet ${JSON.stringify(rel)} is outside ${base}`);
  if (!fs.existsSync(abs)) throw new PatchError(`[${where}] snippet file not found: ${abs}`);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(abs));
  } catch (e) {
    throw new PatchError(`[${where}] snippet ${rel} is not valid UTF-8`);
  }
}

/** A replacement value (string, {file}, {component}, or a list of those) as text. */
export function expandParts(value, ctx, where) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => expandParts(v, ctx, where)).join('');
  if (typeof value.file === 'string') {
    const text = readSnippet(ctx, value.file, where);
    return value.chomp ? text.replace(/\r?\n$/, '') : text;
  }
  return renderComponent(value, ctx.components, ctx.href, where);
}

/** Replace the one occurrence of `anchor` with `replacement`; any other number of matches is an error. Spliced by index: no `$` patterns. */
function replaceOnce(text, anchor, replacement, where, why) {
  const n = countOccurrences(text, anchor);
  if (n !== 1) throw new PatchError(`[${where}] ${why}: anchor matched ${n} times (expected exactly 1): ${preview(anchor)}`);
  const at = text.indexOf(anchor);
  return text.slice(0, at) + replacement + text.slice(at + anchor.length);
}

const OPS = {
  relink(step, scope, ctx, where) {
    const { text, count } = relinkText(scope.get(), ctx.site, ctx.href);
    if (step.expect !== undefined && count !== step.expect) {
      throw new PatchError(`[${where}] ${step.why}: expected ${step.expect} links to rewrite, found ${count}`);
    }
    scope.set(text);
    return ` (${count} links)`;
  },
  replace(step, scope, ctx, where) {
    const withText = expandParts(step.with, ctx, where);
    scope.set(replaceOnce(scope.get(), step.anchor, withText, where, step.why));
  },
  insertAfter(step, scope, ctx, where) {
    const insert = expandParts(step.insert, ctx, where);
    scope.set(replaceOnce(scope.get(), step.anchor, step.anchor + insert, where, step.why));
  },
  insertBefore(step, scope, ctx, where) {
    const insert = expandParts(step.insert, ctx, where);
    scope.set(replaceOnce(scope.get(), step.anchor, insert + step.anchor, where, step.why));
  },
  replaceAll(step, scope, ctx, where) {
    const text = scope.get();
    const got = countOccurrences(text, step.anchor);
    if (got !== step.count) throw new PatchError(`[${where}] ${step.why}: expected ${step.count} occurrences of ${preview(step.anchor)}, found ${got}`);
    scope.set(text.split(step.anchor).join(expandParts(step.with, ctx, where)));
    return ` (${got})`;
  },
  insertAfterLeadingComment(step, scope, ctx, where) {
    const text = scope.get();
    if (!text.startsWith('/*')) throw new PatchError(`[${where}] ${step.why}: the text does not start with a /* banner comment`);
    const end = text.indexOf('*/');
    if (end === -1) throw new PatchError(`[${where}] ${step.why}: the leading comment is not closed`);
    const at = end + 2;
    scope.set(text.slice(0, at) + expandParts(step.insert, ctx, where) + text.slice(at));
  },
  checkSyntax(step, scope, ctx, where) {
    ctx.checkSyntax(scope.get(), step.name, `[${where}] `);
  },
};

function runSteps(steps, scopeFor, ctx, prefix, notes) {
  for (const step of steps) {
    const where = `${prefix}/${step.id}`;
    const scope = scopeFor(step);
    if (step.op === 'group') {
      runSteps(step.steps, () => scope, ctx, where, notes);
    } else if (step.op === 'inJsString') {
      const text = scope.get();
      if (countOccurrences(text, step.open) !== 1) {
        throw new PatchError(`[${where}] ${step.why}: could not find the string literal ${preview(step.open)} exactly once (found ${countOccurrences(text, step.open)})`);
      }
      const quoteAt = text.indexOf(step.open) + step.open.length - 1;
      const { value, end } = scanJsString(text, quoteAt);
      let inner = value;
      runSteps(step.steps, () => ({ get: () => inner, set: (v) => { inner = v; } }), ctx, where, notes);
      scope.set(text.slice(0, quoteAt) + jsString(inner) + text.slice(end));
    } else {
      const extra = OPS[step.op](step, scope, ctx, where) || '';
      notes.push(`${where.slice(where.indexOf('/') + 1)}: ${step.why}${extra}`);
    }
  }
}

/** Run steps on a plain string (no bundle): the building block of the engine, handy for trying a patch. Returns {text, notes}. */
export function patchText(text, steps, opts = {}) {
  validatePatchSpec({ page: 'text', steps }, 'text');
  const ctx = opts.ctx || makeContext(opts);
  let current = text;
  const notes = [];
  runSteps(steps, () => ({ get: () => current, set: (v) => { current = v; } }), ctx, 'text', notes);
  return { text: current, notes };
}

// ---- building ------------------------------------------------------------------------------------------

/**
 * Everything a build needs, from options:
 *   root, site (object), linkStyle ('route'|'file'), linkNames ({pageKey: file name}), patchesDir,
 *   patches ({pageKey: spec object}, replaces the files), components (object, replaces components.json),
 *   checkSyntax (function, default: node --check).
 */
export function makeContext(opts = {}) {
  const root = path.resolve(opts.root || ROOT);
  const site = opts.site || loadSite(root);
  const style = opts.linkStyle || site.linkStyle || 'route';
  const patchesDir = path.resolve(opts.patchesDir || path.join(root, 'site', 'patches'));
  const componentsFile = opts.componentsFile || path.join(root, 'site', 'components.json');
  const components = opts.components || (fs.existsSync(componentsFile) ? JSON.parse(fs.readFileSync(componentsFile, 'utf8')) : { components: {}, entries: {} });
  return {
    root,
    site,
    style,
    href: makeHref(site, style, opts.linkNames),
    patchesDir,
    patches: opts.patches || {},
    components,
    checkSyntax: opts.checkSyntax || checkSyntax,
  };
}

export function loadPatchSpec(key, ctx) {
  let spec = ctx.patches[key];
  if (!spec) {
    const file = path.join(ctx.patchesDir, `${key}.json`);
    if (!fs.existsSync(file)) throw new PatchError(`[${key}] no patch file: ${file}`);
    try {
      spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new PatchError(`[${key}] ${file} is not valid JSON: ${e.message}`);
    }
  }
  return validatePatchSpec(spec, key);
}

/** Patch one page in memory. Returns {key, bundle, notes}; the bundle's render() is the finished page. */
export function buildPage(key, opts = {}) {
  const ctx = opts.ctx || makeContext(opts);
  const page = ctx.site.pages[key];
  if (!page) throw new PatchError(`unknown page ${JSON.stringify(key)} (site.json pages: ${Object.keys(ctx.site.pages).join(', ')})`);
  const src = path.resolve(ctx.root, page.source);
  if (!fs.existsSync(src)) throw new PatchError(`[${key}] missing pristine export: ${src}`);
  const spec = loadPatchSpec(key, ctx);
  const bundle = Bundle.load(src);
  const ws = new Workspace(bundle);
  const notes = [];
  runSteps(spec.steps, (step) => ws.scopeFor(step.target), ctx, key, notes);
  ws.commit();
  return { key, bundle, notes };
}

/** Where a page is written: its `file` under root, or, with `outDir`, the same file name inside outDir. */
export function outputPath(site, key, root = ROOT, outDir = null) {
  const file = site.pages[key].file;
  return outDir ? path.join(path.resolve(outDir), path.basename(file)) : path.join(root, file);
}

/**
 * Build pages. Returns {results:[{key, ok, notes, error?, bundle?}], problems, ok}. Writes the pages unless
 * `check`; nothing is written if any page failed to patch. The link check (every same-site href/src is a known
 * page or an existing media file) runs on the built templates; its problems are reported after the pages are written.
 */
export function buildSite(opts = {}) {
  const ctx = makeContext(opts);
  const keys = opts.keys || Object.keys(ctx.site.pages);
  const results = [];
  for (const key of keys) {
    try {
      const { bundle, notes } = buildPage(key, { ctx });
      results.push({ key, ok: true, notes, bundle });
    } catch (error) {
      if (!(error instanceof PatchError) && !(error?.name === 'BundleError')) throw error;
      results.push({ key, ok: false, notes: [], error: error.message });
    }
  }
  const failed = results.some((r) => !r.ok);
  let problems = [];
  if (!failed) {
    const templates = Object.fromEntries(results.map((r) => [r.key, r.bundle.template]));
    problems = checkPages({ root: ctx.root, site: ctx.site, linkStyle: ctx.style, keys, templates, checks: ['links'] }).problems;
    if (!opts.check) {
      for (const r of results) {
        const target = outputPath(ctx.site, r.key, ctx.root, opts.outDir);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const tmp = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, r.bundle.render(), 'utf8');
        fs.renameSync(tmp, target);
      }
    }
  }
  return { ctx, results, problems, ok: !failed && problems.length === 0 };
}

// ---- golden digests --------------------------------------------------------------------------------------

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** {pageKey: {template, assets:{uuid: sha256}}} of a built bundle (decoded template text, decompressed asset bytes). */
export function digestBundle(bundle) {
  return {
    template: sha256(Buffer.from(bundle.template, 'utf8')),
    assets: Object.fromEntries(bundle.uuids.map((u) => [u, sha256(bundle.asset(u))])),
  };
}

export const GOLDEN_FILE = path.join('tests', 'fixtures', 'pages-golden.json');

/** Build every page in memory in both link styles and return the golden document. */
export function goldenDocument(opts = {}) {
  const pages = {};
  for (const style of LINK_STYLES) {
    const built = buildSite({ ...opts, linkStyle: style, check: true });
    if (!built.ok) throw new PatchError(`cannot write golden digests, the ${style} build failed:\n${describeFailures(built)}`);
    for (const r of built.results) {
      const d = digestBundle(r.bundle);
      pages[r.key] ??= { templates: {}, assets: d.assets };
      pages[r.key].templates[style] = d.template;
      if (JSON.stringify(pages[r.key].assets) !== JSON.stringify(d.assets)) throw new PatchError(`[${r.key}] assets differ between link styles`);
    }
  }
  return {
    _comment:
      'sha256 of the decoded template (per link style) and of every decompressed asset of each built page. ' +
      'When first written they were equal, decoded, to the output of the Python tool this build replaced (with the npm start wordings); only the banner comment of the studio runtime differed. ' +
      'Regenerate after an intended change with: node tools/build-site.js --write-golden',
    format: 1,
    pages,
  };
}

// ---- command line ----------------------------------------------------------------------------------------

function describeFailures(built) {
  const lines = [];
  for (const r of built.results) if (!r.ok) lines.push(`FAIL  ${r.key}\n      ${r.error.replace(/\n/g, '\n      ')}`);
  for (const p of built.problems) lines.push(`link problem: [${p.page}] ${p.message}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { check: false, only: null, ifMissing: false, linkStyle: null, out: null, writeGolden: false, root: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const take = () => {
      if (eq !== -1) return arg.slice(eq + 1);
      i += 1;
      if (i >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[i];
    };
    if (flag === '--check') args.check = true;
    else if (flag === '--only') args.only = take();
    else if (flag === '--if-missing') args.ifMissing = true;
    else if (flag === '--link-style') args.linkStyle = take();
    else if (flag === '--out') args.out = take();
    else if (flag === '--write-golden') args.writeGolden = true;
    else if (flag === '--root') args.root = take();
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

const USAGE =
  'usage: node tools/build-site.js [--check] [--only KEY] [--if-missing] [--link-style route|file] [--out DIR] [--write-golden]\n' +
  'Rebuilds pages/*.html from pages_original/ with the patches in site/patches/ (see the top of tools/build-site.js).';

export function main(argv, { log = console.log } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    log(USAGE);
    return 0;
  }
  const root = path.resolve(args.root || ROOT);
  if (args.linkStyle && !LINK_STYLES.includes(args.linkStyle)) {
    console.error(`--link-style must be one of ${LINK_STYLES.join(', ')}`);
    return 2;
  }
  let site;
  try {
    site = loadSite(root);
  } catch (e) {
    console.error(`cannot read site/site.json in ${root}: ${e.message}`);
    return 1;
  }
  if (args.only && !site.pages[args.only]) {
    console.error(`unknown page ${JSON.stringify(args.only)}; site.json pages: ${Object.keys(site.pages).join(', ')}`);
    return 2;
  }

  if (args.writeGolden) {
    try {
      const doc = goldenDocument({ root, site });
      const target = path.join(root, GOLDEN_FILE);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(doc, null, 2) + '\n', 'utf8');
      log(`wrote ${GOLDEN_FILE} (${Object.keys(doc.pages).length} pages, route and file link styles)`);
      return 0;
    } catch (e) {
      if (!(e instanceof PatchError)) throw e;
      console.error(e.message);
      return 1;
    }
  }

  let keys = args.only ? [args.only] : Object.keys(site.pages);
  if (args.ifMissing) {
    // only look at the output files: this runs before every `npm start`
    keys = keys.filter((k) => !fs.existsSync(outputPath(site, k, root, args.out)));
    if (keys.length === 0) return 0;
    log(`building missing pages: ${keys.map((k) => site.pages[k].file).join(', ')}`);
  }

  const built = buildSite({ root, site, keys, check: args.check, outDir: args.out, linkStyle: args.linkStyle || undefined });
  for (const r of built.results) {
    const shown = args.out ? path.join(args.out, path.basename(site.pages[r.key].file)) : site.pages[r.key].file;
    if (r.ok) {
      log(`OK    ${shown}`);
      for (const n of r.notes) log(`        - ${n}`);
    } else {
      log(`FAIL  ${shown}\n      ${r.error.replace(/\n/g, '\n      ')}`);
    }
  }
  if (built.results.some((r) => !r.ok)) {
    log('\nBuild FAILED: no page was written.');
    return 1;
  }
  if (built.problems.length) {
    log('\nLink check FAILED:');
    for (const p of built.problems) log(`  - ${site.pages[p.page].file}: ${p.message}`);
    return 1;
  }
  log(`\nLink check: every same-site link in the ${args.check ? 'patched' : 'rebuilt'} pages points at an existing page or media file (link style: ${built.ctx.style}).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
