import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { detect, SOURCES } from '../../site/inspiration/sources.js';

// Inspiration import (C3): the contract between our registry (site/inspiration/sources.js) and the gallery-dl that is installed
// (python/requirements.txt pins it). It runs the real program, but never touches the network: it asks which extractor an address
// reaches (a match on the address alone) and which settings that extractor's code reads. Skipped when python/.venv is not set up:
//
//   python3 -m venv python/.venv && python/.venv/bin/pip install -r python/requirements.txt
//
// This is what makes "the regex picks the right request" a checked fact: if gallery-dl is upgraded and an address starts reaching a
// different extractor, or stops reading an option we set, this fails here instead of quietly returning the wrong picture.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PYTHON = path.join(ROOT, 'python/.venv/bin/python');
const SCRIPT = path.join(ROOT, 'python/gallery_resolve.py');
const skip = !fs.existsSync(PYTHON) && 'python/.venv is not set up (see the comment at the top of this file)';

const python = (args, input) => spawnSync(PYTHON, args, { encoding: 'utf8', input, env: { PATH: process.env.PATH, PYTHONWARNINGS: 'ignore' }, timeout: 60000 });
const find = (url) => JSON.parse(python([SCRIPT, '--find', url]).stdout).extractor;

const SHAPES = SOURCES.flatMap((source) => source.shapes.filter((shape) => shape.extractor).map((shape) => ({ source, shape })));

test('every shape of every source reaches exactly the gallery-dl extractor the registry names', { skip }, () => {
  assert.ok(SHAPES.length >= 15);
  for (const { source, shape } of SHAPES) {
    const canonical = detect(shape.example)?.url;
    assert.ok(canonical, `${source.id}/${shape.name}: example not recognised`);
    assert.equal(find(canonical), shape.extractor, `${source.id}/${shape.name}: ${canonical}`);
  }
});

test('a short link may lead only to extractors that exist, and the registry names them', { skip }, () => {
  const short = SHAPES.find(({ shape }) => shape.follows?.length);
  assert.ok(short, 'a short link shape names what it follows');
  const reached = new Set([find('https://www.pinterest.com/pin/123456/'), find('https://www.pinterest.com/some_one/kitchen-ideas/')]);
  assert.deepEqual([...short.shape.follows].sort(), [...reached].sort());
});

test('addresses that gallery-dl would fetch blindly (a picture link, a generic page) are not on any allow list', { skip }, () => {
  const allowed = new Set(SHAPES.map(({ shape }) => shape.extractor));
  for (const url of ['https://example.com/a.jpg', 'https://images.example.com/photo-1', 'https://www.houzz.com/photos/x']) {
    const key = find(url);
    assert.ok(key === null || !allowed.has(key), `${url} reached ${key}`);
  }
  // and the program itself refuses to run an extractor that is not on the list it is given
  const refused = JSON.parse(python([SCRIPT, JSON.stringify({ url: 'https://example.com/a.jpg', allow: ['pinterest:pin'], options: {}, limit: 3, seconds: 10 })]).stdout);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'unsupported');
  const wrong = JSON.parse(python([SCRIPT, JSON.stringify({ url: 'https://www.pinterest.com/pin/123456/', allow: ['unsplash:image'], options: {}, limit: 3, seconds: 10 })]).stdout);
  assert.equal(wrong.reason, 'unsupported', 'a real extractor that is not the one named is refused too');
});

test('every option we set is one the extractor\'s code really reads', { skip }, () => {
  const wanted = SOURCES.filter((s) => Object.keys(s.options).length).map((s) => ({ id: s.id, url: detect(s.shapes.find((sh) => sh.extractor).example).url, options: Object.keys(s.options) }));
  const snippet = `
import json, sys, inspect
from gallery_dl import extractor
out = {}
for job in json.load(sys.stdin):
    found = extractor.find(job["url"])
    source = inspect.getsource(sys.modules[type(found).__module__])
    out[job["id"]] = {name: ('"%s"' % name) in source or ("'%s'" % name) in source for name in job["options"]}
print(json.dumps(out))
`;
  const run = python(['-c', snippet], JSON.stringify(wanted));
  const reads = JSON.parse(run.stdout);
  for (const job of wanted) for (const name of job.options) assert.equal(reads[job.id][name], true, `${job.id}: gallery-dl's code never reads the option "${name}"`);
});

test('the resolver script reports a clean failure for a request it cannot use', { skip }, () => {
  for (const request of ['not json', '[]', '{"url": 5, "allow": []}', JSON.stringify({ url: 'https://www.pinterest.com/pin/1/' })]) {
    const answer = JSON.parse(python([SCRIPT, request]).stdout);
    assert.equal(answer.ok, false, request);
    assert.equal(answer.reason, 'failed', request);
  }
  assert.equal(python([SCRIPT]).status, 0, 'always exits 0: the website reads the JSON');
});
