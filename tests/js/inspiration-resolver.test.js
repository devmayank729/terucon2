import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Inspiration import (C3): python/gallery_resolve.py with a PRETEND gallery_dl (a folder with a gallery_dl package that finds
// extractors by address and prints what gallery-dl -j prints), so the program's own logic is tested deterministically and offline:
// the allow list, the one hop of a short link, what is dropped, thumbnails, and the options handed to gallery-dl.
// (The real gallery-dl's address matching is checked in inspiration-gallery-contract.test.js; the real thing ran live by hand.)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'python/gallery_resolve.py');
const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;

const FIND = `
class E:
    def __init__(self, category, subcategory):
        self.category, self.subcategory = category, subcategory

def find(url):
    if "pin.it/" in url: return E("pinterest", "pinit")
    if "/pin/" in url: return E("pinterest", "pin")
    if "pinterest.com/some_one/" in url: return E("pinterest", "board")
    if "unsplash.com/photos" in url: return E("unsplash", "image")
    if "loop.example/" in url: return E("pinterest", "pinit")
    return None
`;

/** @param {string} main what the pretend "python -m gallery_dl" does; it can read `url`, `argv` and `config` (the settings file it was given) */
function resolver(main) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-fake-gdl-'));
  fs.mkdirSync(path.join(dir, 'gallery_dl'));
  fs.writeFileSync(path.join(dir, 'gallery_dl', '__init__.py'), '');
  fs.writeFileSync(path.join(dir, 'gallery_dl', 'extractor.py'), FIND);
  fs.writeFileSync(path.join(dir, 'gallery_dl', '__main__.py'), `import json, sys\nargv = sys.argv[1:]\nurl = argv[-1]\nconfig = json.load(open(argv[argv.index("-c") + 1]))\n${main}\n`);
  return (request) => {
    const run = spawnSync(python, [SCRIPT, JSON.stringify({ limit: 3, seconds: 10, options: {}, ...request })], { env: { PATH: process.env.PATH, PYTHONPATH: dir }, encoding: 'utf8' });
    return { status: run.status, answer: JSON.parse(run.stdout), stderr: run.stderr };
  };
}
const skip = !python && 'no python3';
const PIN = 'https://www.pinterest.com/pin/123456/';

test('what gallery-dl is asked: no default config, our own settings file, the metadata dump, a range', { skip }, () => {
  const run = resolver(`
assert "--config-ignore" in argv and "-j" in argv and "-g" not in argv, argv
assert argv[argv.index("--range") + 1] == "1-3", argv
print(json.dumps([[2, {"title": json.dumps(config["extractor"]["pinterest"]) + json.dumps(config["cache"])}], [3, "https://i.pinimg.com/originals/a/1.jpg", {"extension": "jpg"}]]))
`);
  const { status, answer } = run({ url: PIN, allow: ['pinterest:pin'], options: { videos: false, stories: false } });
  assert.equal(status, 0);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.title, '{"videos": false, "stories": false}{"file": null}', 'the site\'s options reach gallery-dl, and its cache is off');
});

test('only pictures come out: story text, video playlists, video and audio files are dropped; sizes, titles and small pictures are read from the metadata', { skip }, () => {
  const run = resolver(`
print(json.dumps([
  [2, {"board": {"name": "Kitchen\\u0007 ideas"}}],
  [3, "https://i.pinimg.com/originals/a/1.jpg", {"extension": "jpg", "width": 1080, "height": 1620, "title": "", "description": "  A  warm\\nkitchen ", "images": {"474x": {"url": "https://i.pinimg.com/474x/a/1.jpg"}, "orig": {"url": "x"}}}],
  [3, "https://i.pinimg.com/originals/a/1.jpg", {"extension": "jpg"}],
  [3, "text:Some story text", {"extension": "txt"}],
  [3, "ytdl:https://v.pinimg.com/x.m3u8", {"extension": "mp4"}],
  [3, "https://v.pinimg.com/x.mp4", {"extension": "mp4"}],
  [3, "https://i.pinimg.com/originals/a/2.png", {"extension": "PNG", "width": "640", "height": True}],
  [3, "https://i.pinimg.com/originals/a/3.webp", {"extension": "webp"}],
  [3, "https://i.pinimg.com/originals/a/4.jpg", {"extension": "jpg"}],
  [6, "https://elsewhere.example/queued", {}],
]))
`);
  const { answer } = run({ url: PIN, allow: ['pinterest:pin'], thumbs: 'pinterest' });
  assert.equal(answer.ok, true);
  assert.equal(answer.title, 'Kitchen ideas');
  assert.deepEqual(answer.items.map((i) => i.url), ['https://i.pinimg.com/originals/a/1.jpg', 'https://i.pinimg.com/originals/a/2.png', 'https://i.pinimg.com/originals/a/3.webp'], 'three at most, once each, pictures only');
  assert.deepEqual([answer.items[0].width, answer.items[0].height, answer.items[0].title, answer.items[0].thumb], [1080, 1620, 'A warm kitchen', 'https://i.pinimg.com/474x/a/1.jpg']);
  assert.deepEqual([answer.items[1].width, answer.items[1].height], [640, null], 'a size that is not a number is not a size');
});

test('only the extractor the request names runs: another site, a picture link and an unknown address are refused before anything runs', { skip }, () => {
  const run = resolver('print("NEVER RUNS"); sys.exit(1)');
  for (const request of [
    { url: PIN, allow: ['unsplash:image'] },
    { url: 'https://unsplash.com/photos/abc', allow: ['pinterest:pin'] },
    { url: 'https://example.com/a.jpg', allow: ['pinterest:pin'] },
    { url: PIN, allow: [] },
  ]) assert.equal(run(request).answer.reason, 'unsupported', JSON.stringify(request));
});

test('a short link is followed once, and only to what the request says it may lead to', { skip }, () => {
  const run = resolver(`
if "pin.it/" in url:
    print(json.dumps([[6, "https://www.pinterest.com/some_one/kitchen-ideas/", {}]]))
else:
    print(json.dumps([[3, "https://i.pinimg.com/originals/a/1.jpg", {"extension": "jpg"}], [3, "https://i.pinimg.com/originals/a/2.jpg", {"extension": "jpg"}]]))
`);
  const short = { url: 'https://pin.it/4AbCdEf', allow: ['pinterest:pinit'] };
  const led = run({ ...short, follow: ['pinterest:pin', 'pinterest:board'] }).answer;
  assert.equal(led.ok, true, JSON.stringify(led));
  assert.equal(led.items.length, 2, 'the board the short link led to');
  assert.equal(run({ ...short, follow: ['pinterest:pin'] }).answer.reason, 'unsupported', 'a board is not on this request\'s follow list');
  assert.equal(run(short).answer.reason, 'unsupported', 'no follow list: no hop');
  // a link that leads to another link is not followed again
  const loop = resolver('print(json.dumps([[6, "https://loop.example/again", {}]]))');
  assert.equal(loop({ url: 'https://pin.it/4AbCdEf', allow: ['pinterest:pinit'], follow: ['pinterest:pinit'] }).answer.ok, false);
});

test('reasons from gallery-dl\'s own messages, nothing found, a timeout, and a missing gallery-dl', { skip }, () => {
  const fails = (message, code = 4) => resolver(`print(${JSON.stringify(message)}, file=sys.stderr)\nsys.exit(${code})`);
  const ask = { url: PIN, allow: ['pinterest:pin'] };
  assert.equal(fails('[pinterest][error] NotFoundError: pin')(ask).answer.reason, 'not-found');
  assert.equal(fails('[pinterest][error] HttpError: 404 Not Found')(ask).answer.reason, 'not-found');
  assert.equal(fails('[instagram][error] AuthenticationError: login required')(ask).answer.reason, 'private');
  assert.equal(fails('[pinterest][error] HttpError: 429 Too Many Requests')(ask).answer.reason, 'blocked');
  assert.equal(fails('something odd')(ask).answer.reason, 'failed');
  assert.equal(resolver('print("[]")')(ask).answer.reason, 'empty');
  assert.equal(resolver('print(json.dumps([[2, {"title": "x"}]]))')(ask).answer.reason, 'empty');
  assert.equal(resolver('import time\ntime.sleep(30)')({ ...ask, seconds: 5 }).answer.reason, 'timeout');
  const bare = spawnSync(python, [SCRIPT, JSON.stringify({ ...ask, limit: 3, seconds: 5 })], { env: { PATH: process.env.PATH, PYTHONPATH: '' }, encoding: 'utf8' });
  const answer = JSON.parse(bare.stdout);
  // on a machine that really has gallery-dl installed this would be a real run: only the "not installed" case is checked
  if (answer.reason === 'not-installed') assert.deepEqual(answer, { ok: false, reason: 'not-installed' });
});
