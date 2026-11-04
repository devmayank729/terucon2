import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { request } from '../helpers/http.js';
import { PROJECT_ROOT, makeProjectRoot, setStudioEnv } from '../helpers/studio.js';
import { loadSettings } from '../../server/config/settings.js';
import { OVERLAY_HEADER, OVERLAY_NAME, listFiles, studioOverlay } from '../../server/middleware/studioOverlay.js';
import { COMMAND, currentHashes, problems, readManifest } from '../../tools/studio-overlay-manifest.js';

// The instant preview's quality overlay (site/overlays/studio/, docs/DESIGN_STUDIO_ARCHITECTURE.md section 12): improved copies of
// 8 of the studio's browser files, served ahead of the studio's own so that swatchroom/ (the copy of the user's project) is not edited.
// This file is the guard. (a) the studio still is what the overlay was merged with, (b) the right bytes go out with the right headers,
// switch included, (c) is tests/js/studio-overlay-behaviour.test.js. To remove the overlay for good: delete site/overlays/studio/
// (these tests then skip themselves), the lines in app.js that mention the overlay, and this file with its sibling.

const OVERLAY_DIR = path.join(PROJECT_ROOT, 'site', 'overlays', 'studio');
const STUDIO_PUBLIC = path.join(PROJECT_ROOT, 'swatchroom', 'public');
const present = fs.existsSync(path.join(OVERLAY_DIR, 'manifest.json'));
const skip = present ? false : 'site/overlays/studio/ is not there: the overlay has been removed';
const read = (file) => fs.readFileSync(file);

// ---------------------------------------------------------------- (a) the studio is still what the overlay was merged with
test('the studio\'s preview files are exactly the ones the overlay was merged with (otherwise: re-merge, then update the manifest)', { skip }, () => {
  const found = problems(PROJECT_ROOT);
  assert.deepEqual(found, [], `\n  ${found.join('\n  ')}\n  (the overlay would otherwise overwrite the studio's newer preview code with a copy of the old one)`);
});

test('the manifest covers EVERY file of fastrender/ and previewScene.js, and every overlaid file replaces one of them', { skip }, () => {
  const manifest = readManifest(PROJECT_ROOT);
  const onDisk = listFiles(path.join(STUDIO_PUBLIC, 'js', 'lib', 'fastrender')).map((f) => `js/lib/fastrender/${f}`).concat('js/lib/previewScene.js').sort();
  assert.deepEqual(Object.keys(manifest.upstream).sort(), onDisk, 'the manifest lists exactly the files that are there');
  assert.ok(onDisk.length >= 14, `the unchanged ones too (sizing, tiers, lru, device, textureStore, previewReason): ${onDisk.length} files`);
  for (const file of Object.keys(manifest.overlay)) assert.ok(file in manifest.upstream, `${file}: an overlaid file must replace a studio file of the same address`);
  assert.equal(Object.keys(manifest.overlay).length, 8);
  for (const hash of [...Object.values(manifest.upstream), ...Object.values(manifest.overlay)]) assert.match(hash, /^[0-9a-f]{64}$/);
});

test('every name the studio imports from an overlaid file is still exported by the overlay (a newer studio can not break it by asking for more)', { skip }, () => {
  const manifest = readManifest(PROJECT_ROOT);
  const overlayed = new Set(Object.keys(manifest.overlay));
  const exportsOf = (relative) => {
    const source = read(path.join(OVERLAY_DIR, relative)).toString('utf8');
    const names = new Set();
    for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
    for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const part of m[1].split(',')) if (part.trim()) names.add(part.trim().split(/\s+as\s+/).pop());
    return names;
  };
  let checked = 0;
  for (const file of listFiles(path.join(STUDIO_PUBLIC, 'js')).map((f) => `js/${f}`).filter((f) => f.endsWith('.js'))) {
    const source = read(path.join(STUDIO_PUBLIC, file)).toString('utf8');
    for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[2]));
      if (!overlayed.has(target)) continue;
      const have = exportsOf(target);
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0];
        if (!name) continue;
        checked += 1;
        assert.ok(have.has(name), `${file} imports { ${name} } from ${target}, which the overlay does not export: re-merge the overlay`);
      }
    }
  }
  assert.ok(checked >= 8, `the studio does import from the overlaid files (${checked} names checked)`);
});

// the guard itself, on a throw-away copy: each way the studio can drift is named in words, with the command that makes it right
function tempTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-overlay-guard-'));
  const lib = path.join(root, 'swatchroom', 'public', 'js', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.cpSync(path.join(STUDIO_PUBLIC, 'js', 'lib', 'fastrender'), path.join(lib, 'fastrender'), { recursive: true });
  fs.copyFileSync(path.join(STUDIO_PUBLIC, 'js', 'lib', 'previewScene.js'), path.join(lib, 'previewScene.js'));
  fs.cpSync(OVERLAY_DIR, path.join(root, 'site', 'overlays', 'studio'), { recursive: true });
  return { root, lib, overlay: path.join(root, 'site', 'overlays', 'studio'), remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('the guard fails, in words and with the command to run, when the studio changes an overlaid file, a file the overlay depends on, adds one or removes one', { skip }, () => {
  const tree = tempTree();
  try {
    assert.deepEqual(problems(tree.root), [], 'a faithful copy passes');
    const touch = (file) => fs.appendFileSync(path.join(tree.lib, file), '\n// a newer version of the studio\n');
    touch('fastrender/webgl2.js');
    touch('fastrender/sizing.js');
    fs.writeFileSync(path.join(tree.lib, 'fastrender', 'newThing.js'), 'export const x = 1;\n');
    fs.rmSync(path.join(tree.lib, 'fastrender', 'tiers.js'));
    const found = problems(tree.root);
    assert.equal(found.length, 4, found.join('\n'));
    assert.match(found.join('\n'), /upstream changed js\/lib\/fastrender\/webgl2\.js \(an overlaid file: its improvements must be merged/);
    assert.match(found.join('\n'), /upstream changed js\/lib\/fastrender\/sizing\.js \(not overlaid, but the overlaid files depend on its interfaces\)/);
    assert.match(found.join('\n'), /upstream added js\/lib\/fastrender\/newThing\.js/);
    assert.match(found.join('\n'), /upstream removed js\/lib\/fastrender\/tiers\.js/);
    for (const line of found) assert.ok(line.includes(COMMAND), `every message names the command: ${line}`);
  } finally {
    tree.remove();
  }
});

test('the guard also notices an overlay file that was edited, removed or added without the manifest', { skip }, () => {
  const tree = tempTree();
  try {
    fs.appendFileSync(path.join(tree.overlay, 'js', 'lib', 'previewScene.js'), '\n// edited\n');
    fs.rmSync(path.join(tree.overlay, 'js', 'lib', 'fastrender', 'webgpu.js'));
    fs.writeFileSync(path.join(tree.overlay, 'js', 'lib', 'fastrender', 'extra.js'), 'export {};\n');
    const found = problems(tree.root).join('\n');
    assert.match(found, /overlay file js\/lib\/previewScene\.js was edited after the manifest was written/);
    assert.match(found, /overlay file js\/lib\/fastrender\/webgpu\.js is missing/);
    assert.match(found, /overlay has a new file js\/lib\/fastrender\/extra\.js/);
  } finally {
    tree.remove();
  }
});

test('hidden files (.DS_Store, which Finder drops into any folder it opens) are neither part of the guard nor served', { skip }, () => {
  const tree = tempTree();
  try {
    for (const folder of [path.join(tree.lib, 'fastrender'), path.join(tree.lib, 'fastrender', 'shaders'), tree.lib, tree.overlay, path.join(tree.overlay, 'js'), path.join(tree.overlay, 'js', 'lib')]) fs.writeFileSync(path.join(folder, '.DS_Store'), 'x');
    assert.deepEqual(problems(tree.root), [], 'a stray .DS_Store breaks nothing');
    assert.ok(!Object.keys(currentHashes(tree.root).overlay).some((f) => f.includes('.DS_Store')));
    const overlay = studioOverlay({ root: tree.root });
    assert.ok(overlay.files.length === 8 && !overlay.files.some((f) => f.includes('.DS_Store')), 'and none is an overlaid address: ' + overlay.files.join(' '));
  } finally {
    tree.remove();
  }
});

test('currentHashes() is what the manifest records (so the command writes what the test checks)', { skip }, () => {
  const manifest = readManifest(PROJECT_ROOT);
  const now = currentHashes(PROJECT_ROOT);
  assert.deepEqual(now.upstream, manifest.upstream);
  assert.deepEqual(now.overlay, manifest.overlay);
});

// ---------------------------------------------------------------- the switch
test('STUDIO_PREVIEW_OVERLAY: on unless switched off; blank or unreadable means on', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-overlay-env-'));
  const file = path.join(dir, '.env');
  try {
    const value = (text) => {
      fs.writeFileSync(file, text);
      return loadSettings(file, {}, dir).studio.previewOverlay;
    };
    assert.equal(value(''), true);
    assert.equal(value('STUDIO_PREVIEW_OVERLAY=\n'), true, 'blank means the default');
    assert.equal(value('STUDIO_PREVIEW_OVERLAY=maybe\n'), true, 'anything unreadable keeps the improved preview');
    for (const on of ['on', 'ON', 'true', '1', 'yes']) assert.equal(value(`STUDIO_PREVIEW_OVERLAY=${on}\n`), true, on);
    for (const off of ['off', 'OFF', 'false', '0', 'no', 'n']) assert.equal(value(`STUDIO_PREVIEW_OVERLAY=${off}\n`), false, off);
    assert.equal(loadSettings(file, { STUDIO_PREVIEW_OVERLAY: 'off' }, dir).studio.previewOverlay, false, 'the real environment wins over the file, like every setting');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with no site/overlays/ folder the overlay is a silent no-op: nothing is served from it and everything passes on', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-overlay-none-'));
  try {
    const overlay = studioOverlay({ root });
    assert.equal(overlay.present, false);
    assert.deepEqual(overlay.files, []);
    let passed = 0;
    overlay({ method: 'GET', url: '/lib/previewScene.js' }, {}, () => (passed += 1));
    assert.equal(passed, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- (b) the bytes that are served
// The real website with the real studio mounted (a copy of swatchroom/server with no .env, the real browser files by link), the real
// overlay folder linked in, and nothing else real: no database, no Google, no GPU service.
let served = null;
if (present) {
  setStudioEnv({});
  delete process.env.PORT;
  delete process.env.HOST;
  const project = makeProjectRoot(); // site/site.json and the pages only: no overlay, as in every other studio test
  fs.mkdirSync(path.join(project.root, 'site', 'overlays'), { recursive: true });
  fs.symlinkSync(OVERLAY_DIR, path.join(project.root, 'site', 'overlays', 'studio'), 'dir');
  const envPath = path.join(project.root, 'test.env');
  fs.writeFileSync(envPath, '');
  const { createApp } = await import('../../app.js');
  const { createAuthDb } = await import('../../server/auth/db.js');
  const { captureProviders, SECRET } = await import('../helpers/authKit.js');
  const lines = [];
  const log = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m), raw: (m) => lines.push(m) };
  const app = createApp({ root: project.root, envPath, environ: {}, swatchroom: true, log, auth: { db: createAuthDb({}), providers: captureProviders().providers, secret: SECRET } });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  createRequire(path.join(project.studioDir, 'server', 'index.js'))('mongoose').set('bufferCommands', false);
  served = { project, envPath, app, server, port: server.address().port, lines };
  test.after(async () => {
    await new Promise((resolve) => (server.closeAllConnections(), server.close(resolve)));
    await app.locals.terucon.close();
    fs.unlinkSync(path.join(project.root, 'site', 'overlays', 'studio')); // the link, not the folder
    project.remove();
  });
}
const get = (p, headers = {}, method = 'GET') => request(served.port, { path: p, headers, method });
const manifest = present ? readManifest(PROJECT_ROOT) : null;
const OVERLAID = present ? Object.keys(manifest.overlay) : [];

test('the overlaid addresses answer with the overlay\'s bytes, the studio\'s policy and their own marker; compressed they decode to the same bytes', { skip }, async () => {
  assert.equal(OVERLAID.length, 8);
  assert.deepEqual(served.app.locals.terucon.studioOverlay.files, OVERLAID.map((f) => `/${f}`).sort());
  const reference = await get('/js/lib/fastrender/sizing.js');
  for (const file of OVERLAID) {
    const r = await get(`/${file}`);
    assert.equal(r.status, 200, file);
    assert.deepEqual(r.buffer, read(path.join(OVERLAY_DIR, file)), `${file}: the overlay's bytes`);
    assert.notDeepEqual(r.buffer, read(path.join(STUDIO_PUBLIC, file)), `${file}: not the studio's`);
    assert.equal(r.headers[OVERLAY_HEADER.toLowerCase()], OVERLAY_NAME, file);
    assert.equal(r.headers['content-type'], reference.headers['content-type'], `${file}: the studio's content type`);
    assert.equal(r.headers['cache-control'], 'no-cache', `${file}: the studio's own policy for its /js files`);
    assert.ok(r.headers.etag && r.headers['last-modified'], `${file}: validators`);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', `${file}: the website's headers still apply`);
    const again = await get(`/${file}`, { 'If-None-Match': r.headers.etag });
    assert.equal(again.status, 304, `${file}: a browser that asks again gets the cheap answer`);
    const head = await get(`/${file}`, {}, 'HEAD');
    assert.equal(head.status, 200, `${file}: HEAD`);
    assert.equal(head.buffer.length, 0);
    for (const [coding, decode] of [['br', zlib.brotliDecompressSync], ['gzip', zlib.gunzipSync]]) {
      const c = await get(`/${file}`, { 'Accept-Encoding': coding });
      assert.equal(c.headers['content-encoding'], coding, `${file} ${coding}`);
      assert.deepEqual(decode(c.buffer), r.buffer, `${file} ${coding}: the decoded bytes are the overlay's`);
      assert.equal(c.headers.etag, r.headers.etag, `${file} ${coding}: the validator is kept`);
    }
  }
});

test('every other studio file still comes from swatchroom/, byte for byte, with the same kind of headers and no marker', { skip }, async () => {
  const sample = await get(`/${OVERLAID[0]}`);
  const files = ['js/lib/fastrender/sizing.js', 'js/lib/fastrender/tiers.js', 'js/lib/fastrender/lru.js', 'js/lib/fastrender/textureStore.js', 'js/lib/fastrender/previewReason.js', 'js/lib/fastrender/device.js',
    'js/views/stage.js', 'js/views/studio.js', 'js/lib/regions.js', 'js/lib/geometryFacts.js', 'js/swatchroom-app.js'];
  for (const file of files) {
    assert.ok(!OVERLAID.includes(file), file);
    const r = await get(`/${file}`);
    assert.equal(r.status, 200, file);
    assert.deepEqual(r.buffer, read(path.join(STUDIO_PUBLIC, file)), `${file}: the studio's own bytes`);
    assert.equal(r.headers[OVERLAY_HEADER.toLowerCase()], undefined, `${file}: no marker`);
    assert.equal(r.headers['content-type'], sample.headers['content-type'], `${file}: same content type`);
    assert.equal(r.headers['cache-control'], sample.headers['cache-control'], `${file}: same cache policy`);
    assert.ok(r.headers.etag && r.headers['last-modified'], `${file}: validators`);
  }
  // other kinds of studio files are not touched either
  assert.equal((await get('/css/swatchroom.css')).headers[OVERLAY_HEADER.toLowerCase()], undefined);
  assert.equal((await get('/textures/brick.png')).status, 200);
});

test('only a GET or HEAD of a file in the overlay is answered from it: misses, other methods, traversal and the manifest are not', { skip }, async () => {
  const miss = await get('/js/lib/fastrender/no-such-file.js', { Accept: 'text/html' });
  assert.equal(miss.status, 404);
  assert.equal(miss.headers[OVERLAY_HEADER.toLowerCase()], undefined);
  assert.notEqual((await request(served.port, { method: 'POST', path: '/js/lib/previewScene.js', body: {} })).status, 200);
  assert.notEqual((await request(served.port, { method: 'PUT', path: '/js/lib/previewScene.js', body: {} })).status, 200);
  for (const evil of ['/js/lib/fastrender/../../../../site/overlays/studio/manifest.json', '/js/%2e%2e/%2e%2e/manifest.json', '/js/lib/%2e%2e/%2e%2e/%2e%2e/server/index.js', '/js/lib/fastrender/shaders/', '/js/lib/fastrender', '/js/']) {
    const r = await request(served.port, { path: evil });
    assert.ok(!/"upstream"|require\("express"\)|require\('express'\)/.test(r.text), `${evil}: ${r.status} leaked nothing`);
    assert.equal(r.headers[OVERLAY_HEADER.toLowerCase()], undefined, evil);
  }
  for (const manifestPath of ['/manifest.json', '/js/manifest.json', '/overlays/studio/manifest.json', '/site/overlays/studio/manifest.json']) {
    assert.ok(!(await get(manifestPath)).text.includes('"upstream"'), `${manifestPath} is not served`);
  }
  assert.equal(served.lines.filter((l) => /overlay/i.test(l)).length, 0, 'the overlay says nothing in the log');
});

test('STUDIO_PREVIEW_OVERLAY=off in the env file brings the studio\'s own files back on the very next request, and on brings the overlay back', { skip }, async () => {
  const file = 'js/lib/fastrender/webgl2.js';
  const overlaid = await get(`/${file}`);
  assert.equal(overlaid.headers[OVERLAY_HEADER.toLowerCase()], OVERLAY_NAME);
  fs.writeFileSync(served.envPath, 'STUDIO_PREVIEW_OVERLAY=off\n');
  try {
    for (const f of OVERLAID) {
      const r = await get(`/${f}`);
      assert.equal(r.status, 200, f);
      assert.deepEqual(r.buffer, read(path.join(STUDIO_PUBLIC, f)), `${f}: with the switch off the studio's own bytes come back`);
      assert.equal(r.headers[OVERLAY_HEADER.toLowerCase()], undefined, f);
    }
    const original = await get(`/${file}`);
    assert.notEqual(original.headers.etag, overlaid.headers.etag, 'a browser holding the overlay\'s copy is told it changed (no stale copy)');
    const revalidated = await get(`/${file}`, { 'If-None-Match': overlaid.headers.etag });
    assert.equal(revalidated.status, 200, 'the overlay\'s validator does not match the studio\'s file');
    assert.deepEqual(revalidated.buffer, read(path.join(STUDIO_PUBLIC, file)));
  } finally {
    fs.writeFileSync(served.envPath, 'STUDIO_PREVIEW_OVERLAY=on\n');
  }
  const back = await get(`/${file}`);
  assert.deepEqual(back.buffer, read(path.join(OVERLAY_DIR, file)));
  assert.equal(back.headers.etag, overlaid.headers.etag);
  assert.equal((await get(`/${file}`, { 'If-None-Match': back.headers.etag })).status, 304);
});
