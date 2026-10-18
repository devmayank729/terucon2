#!/usr/bin/env node
// Read and rewrite the self-extracting HTML bundles Claude Design exports.
//
// A bundle is a normal HTML file whose real page lives in three <script> blocks:
//
//   __bundler/manifest       {uuid: {mime, compressed, data(base64[gzip])}}  every asset
//   __bundler/template       the page source as one JSON string (assets referenced by uuid)
//   __bundler/ext_resources  [{id, uuid}]  logical names such as "swatchroomApp"
//
// Everything else in the file (the loader, the thumbnail) is left byte-for-byte alone,
// and only the blocks that were changed are rewritten, so an unmodified bundle
// round-trips to exactly the same bytes (see `node tools/bundle.js roundtrip FILE`).
//
//   node tools/bundle.js roundtrip FILE...     every file must re-render byte-identical
//   node tools/bundle.js unpack FILE OUTDIR    template.html, assets/<uuid>.<ext>, index.json
//
// Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

export class BundleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BundleError';
  }
}

/** An anchored edit did not match exactly once (the page changed, or was exported again). */
export class PatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PatchError';
  }
}

// Strict like Python's read_text(encoding="utf-8"): invalid bytes are an error, a BOM is kept.
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function decodeUtf8(buf) {
  return STRICT_UTF8.decode(buf);
}

/** The text between `<script type="__bundler/NAME">\n` and the next `\n  </script>`. */
function findBlock(text, name) {
  const open = `<script type="__bundler/${name}">\n`;
  const close = '\n  </script>';
  const at = text.indexOf(open);
  if (at === -1) throw new BundleError(`bundle block '${name}' not found`);
  const start = at + open.length;
  const end = text.indexOf(close, start);
  if (end === -1) throw new BundleError(`bundle block '${name}' not found`);
  return { start, end };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class Bundle {
  constructor(text, file = null) {
    this.path = file ? path.resolve(file) : null;
    this._text = text;
    this._manifest = JSON.parse(this._block('manifest'));
    this._ext = JSON.parse(this._block('ext_resources') || '[]');
    this._template = JSON.parse(this._block('template'));
    this._templateDirty = false;
  }

  // ---- loading -----------------------------------------------------------
  static load(file) {
    return new Bundle(decodeUtf8(fs.readFileSync(file)), file);
  }

  _block(name) {
    const { start, end } = findBlock(this._text, name);
    return this._text.slice(start, end);
  }

  // ---- template ----------------------------------------------------------
  get template() {
    return this._template;
  }

  set template(value) {
    if (value !== this._template) {
      this._template = value;
      this._templateDirty = true;
    }
  }

  // ---- assets ------------------------------------------------------------
  get uuids() {
    return Object.keys(this._manifest);
  }

  _entry(uuid) {
    const entry = this._manifest[uuid];
    if (!entry) throw new BundleError(`asset ${uuid} is not in the manifest`);
    return entry;
  }

  mime(uuid) {
    return this._entry(uuid).mime;
  }

  isCompressed(uuid) {
    return Boolean(this._entry(uuid).compressed);
  }

  /** The decoded (base64, then gunzipped when flagged) bytes of one asset, as a Buffer. */
  asset(uuid) {
    const entry = this._entry(uuid);
    const raw = Buffer.from(entry.data, 'base64');
    return entry.compressed ? zlib.gunzipSync(raw) : raw;
  }

  assetText(uuid) {
    return decodeUtf8(this.asset(uuid));
  }

  extUuid(extId) {
    for (const e of this._ext) if (e.id === extId) return e.uuid;
    throw new BundleError(`ext resource '${extId}' not found`);
  }

  /** {logical name: uuid} */
  extIds() {
    return Object.fromEntries(this._ext.map((e) => [e.id, e.uuid]));
  }

  /** Replace one asset's payload, keeping its mime type and compression flag. */
  setAsset(uuid, data) {
    const entry = this._entry(uuid);
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const payload = entry.compressed ? gzipLikePython(bytes) : bytes;
    const b64 = payload.toString('base64');
    const pattern = new RegExp(
      `("${escapeRegExp(uuid)}":\\{"mime":"[^"]*","compressed":(?:true|false),"data":")[^"]*(")`,
    );
    const { start, end } = findBlock(this._text, 'manifest');
    const body = this._text.slice(start, end);
    const m = pattern.exec(body);
    if (!m) throw new BundleError(`asset ${uuid} not found in manifest text`);
    const dataStart = m.index + m[1].length;
    const dataEnd = m.index + m[0].length - m[2].length;
    const newBody = body.slice(0, dataStart) + b64 + body.slice(dataEnd);
    this._text = this._text.slice(0, start) + newBody + this._text.slice(end);
    entry.data = b64;
  }

  // ---- output ------------------------------------------------------------
  // Matches the exporter: plain JSON, non-ASCII kept, "</" escaped so a
  // "</script>" inside the page can never close the host <script>.
  static encodeTemplate(template) {
    return JSON.stringify(template).split('</').join('<\\u002F');
  }

  render() {
    let text = this._text;
    if (this._templateDirty) {
      const { start, end } = findBlock(text, 'template');
      text = text.slice(0, start) + Bundle.encodeTemplate(this._template) + text.slice(end);
    }
    return text;
  }

  save(file = null) {
    const target = file ? path.resolve(file) : this.path;
    if (!target) throw new BundleError('no path to save to');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, this.render(), 'utf8');
    return target;
  }
}

/**
 * gzip level 9 with no timestamp. zlib writes the host's OS code into the header (3 on Linux,
 * 11 on Windows); Python writes 255 (unknown). Use 255 so the bytes do not depend on the platform.
 */
export function gzipLikePython(bytes) {
  const out = zlib.gzipSync(bytes, { level: 9 });
  out[4] = out[5] = out[6] = out[7] = 0; // mtime
  out[9] = 255; // OS: unknown
  return out;
}

// ---- command line ----------------------------------------------------------
export function roundtrip(files, log = console.log) {
  let bad = 0;
  for (const f of files) {
    const original = decodeUtf8(fs.readFileSync(f));
    const b = new Bundle(original, f);
    const okPlain = b.render() === original;
    // force the template through the encoder as well
    b._templateDirty = true;
    const okTemplate = b.render() === original;
    const ok = okPlain && okTemplate;
    log(`${ok ? 'OK  ' : 'FAIL'} ${f}  (untouched=${okPlain}, template re-encoded=${okTemplate})`);
    if (!ok) bad += 1;
  }
  return bad ? 1 : 0;
}

export function unpack(src, out, log = console.log) {
  const b = Bundle.load(src);
  fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(out, 'template.html'), b.template, 'utf8');
  const ext = Object.fromEntries(Object.entries(b.extIds()).map(([k, v]) => [v, k]));
  const suffixes = { 'text/javascript': '.js', 'application/javascript': '.js', 'text/css': '.css' };
  const index = {};
  for (const u of b.uuids) {
    index[u] = { mime: b.mime(u), ext: ext[u] ?? null };
    fs.writeFileSync(path.join(out, 'assets', u + (suffixes[b.mime(u)] ?? '.bin')), b.asset(u));
  }
  fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(index, null, 1), 'utf8');
  log(`unpacked ${b.uuids.length} assets to ${out}`);
  return 0;
}

function main(argv) {
  if (argv.length >= 2 && argv[0] === 'roundtrip') return roundtrip(argv.slice(1));
  if (argv.length === 3 && argv[0] === 'unpack') return unpack(argv[1], argv[2]);
  console.log(
    'usage:\n  node tools/bundle.js roundtrip FILE...\n  node tools/bundle.js unpack FILE OUTDIR\n\n' +
      'Reads and rewrites the self-extracting HTML bundles Claude Design exports (see the top of this file).',
  );
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
