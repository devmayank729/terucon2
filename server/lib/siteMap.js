/**
 * site/site.json: which file is which page, the other names that still resolve, and the media rules.
 * It is the single definition of the site; this module only validates it and answers questions about it.
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MEDIA_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.mp4', '.webm', '.woff', '.woff2', '.avif', '.ico'];

function fail(message) {
  throw new Error(`site/site.json: ${message}`);
}

/** A path from site.json must stay inside the project folder. */
function relativeFile(value, what) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) fail(`${what} must be a relative path inside the project, got ${JSON.stringify(value)}`);
  return value;
}

function route(value, what) {
  if (typeof value !== 'string' || !value.startsWith('/')) fail(`${what} must start with "/", got ${JSON.stringify(value)}`);
  return value;
}

export class SiteMap {
  /** Read and validate `<root>/site/site.json`. */
  static load(root) {
    const file = path.join(root, 'site', 'site.json');
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Could not read ${file}: ${err.message}`);
    }
    return new SiteMap(data, root);
  }

  /** @param {object} data parsed site.json @param {string} root project folder */
  constructor(data, root) {
    this.root = root;
    this.name = String(data.name ?? 'Terucon');
    if (!data.pages || typeof data.pages !== 'object') fail('"pages" is missing');
    this.pages = {};
    for (const [key, p] of Object.entries(data.pages)) {
      this.pages[key] = {
        key,
        label: String(p.label ?? key),
        nav: String(p.nav ?? p.label ?? key),
        description: String(p.description ?? ''),
        route: route(p.route, `pages.${key}.route`),
        file: relativeFile(p.file, `pages.${key}.file`),
        aliases: (p.aliases ?? []).map((a) => route(a, `pages.${key}.aliases`)),
        headers: { ...(p.headers ?? {}) },
        legacy: [],
      };
    }
    for (const [name, key] of Object.entries(data.legacy_names ?? {})) {
      if (!this.pages[key]) fail(`legacy_names.${JSON.stringify(name)} points at an unknown page "${key}"`);
      this.pages[key].legacy.push(name);
    }
    this.docs = {};
    for (const [key, d] of Object.entries(data.docs ?? {})) {
      this.docs[key] = {
        key,
        label: String(d.label ?? key),
        description: String(d.description ?? ''),
        route: route(d.route, `docs.${key}.route`),
        file: relativeFile(d.file, `docs.${key}.file`),
        aliases: (d.aliases ?? []).map((a) => route(a, `docs.${key}.aliases`)),
        headers: {},
        legacy: [],
      };
    }
    const media = data.media ?? {};
    this.media = {
      route: route(media.route ?? '/media', 'media.route'),
      dir: relativeFile(media.dir ?? 'media', 'media.dir'),
      maxAgeSeconds: Number.isFinite(media.maxAgeSeconds) ? media.maxAgeSeconds : 3600,
      extensions: new Set((media.extensions ?? DEFAULT_MEDIA_EXTENSIONS).map((e) => String(e).toLowerCase())),
    };
    this.connections = Object.fromEntries(Object.entries(data.connections ?? {}).filter(([k]) => !k.startsWith('_')));
  }

  /**
   * Lookup table for the pages (or docs): the decoded request path -> what to do with it.
   * Canonical routes serve the file; aliases (301) and legacy design-time names (302) redirect to the route.
   * @param {'pages' | 'docs'} kind
   * @returns {Map<string, {file: string, headers: Record<string, string>} | {redirect: string, status: number}>}
   */
  table(kind) {
    const table = new Map();
    const add = (key, action) => {
      if (table.has(key)) fail(`the name ${JSON.stringify(key)} is used twice`);
      table.set(key, action);
    };
    for (const entry of Object.values(this[kind])) {
      add(entry.route, { file: entry.file, headers: entry.headers });
      for (const alias of entry.aliases) add(alias, { redirect: entry.route, status: 301 });
      for (const name of entry.legacy) add('/' + name, { redirect: entry.route, status: 302 });
    }
    return table;
  }

  /** The public view for /api/site: no file paths and no headers. */
  publicView() {
    return {
      name: this.name,
      pages: Object.values(this.pages).map(({ key, label, nav, description, route: r }) => ({ key, label, nav, description, route: r })),
      docs: Object.values(this.docs).map(({ key, label, description, route: r }) => ({ key, label, description, route: r })),
      connections: this.connections,
    };
  }
}
