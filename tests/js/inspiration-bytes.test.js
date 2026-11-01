import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_PIXELS, sizeAllowed, sniffImage } from '../../server/lib/inspiration/imageBytes.js';
import { pageImages } from '../../server/lib/inspiration/pageImages.js';

// Inspiration import (C3): a downloaded file is judged by its first bytes, never by what the other server called it.

const u16 = (n) => Buffer.from([(n >> 8) & 255, n & 255]);
const u32 = (n) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const le16 = (n) => Buffer.from([n & 255, (n >> 8) & 255]);
const le24 = (n) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255]);

const jpeg = (w, h) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), u16(16), Buffer.alloc(14), Buffer.from([0xff, 0xc0]), u16(17), Buffer.from([8]), u16(h), u16(w), Buffer.alloc(20)]);
const png = (w, h) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from('IHDR'), u32(w), u32(h), Buffer.alloc(20)]);
const gif = (w, h) => Buffer.concat([Buffer.from('GIF89a'), le16(w), le16(h), Buffer.alloc(10)]);
const webpX = (w, h) => Buffer.concat([Buffer.from('RIFF'), u32(40), Buffer.from('WEBPVP8X'), u32(10), Buffer.alloc(4), le24(w - 1), le24(h - 1), Buffer.alloc(10)]);
const webpLossy = (w, h) => Buffer.concat([Buffer.from('RIFF'), u32(40), Buffer.from('WEBPVP8 '), u32(10), Buffer.alloc(3), Buffer.from([0x9d, 0x01, 0x2a]), le16(w), le16(h), Buffer.alloc(10)]);
const webpLossless = (w, h) => {
  const bits = (w - 1) | ((h - 1) << 14);
  return Buffer.concat([Buffer.from('RIFF'), u32(40), Buffer.from('WEBPVP8L'), u32(10), Buffer.from([0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >> 24) & 255]), Buffer.alloc(10)]);
};
const avif = (w, h) => Buffer.concat([u32(24), Buffer.from('ftypavif'), Buffer.alloc(8), u32(20), Buffer.from('ispe'), u32(0), u32(w), u32(h)]);

test('JPEG, PNG, GIF, WebP (three kinds) and AVIF are recognised with their real size', () => {
  assert.deepEqual(sniffImage(jpeg(3000, 2000)), { type: 'image/jpeg', width: 3000, height: 2000 });
  assert.deepEqual(sniffImage(png(640, 480)), { type: 'image/png', width: 640, height: 480 });
  assert.deepEqual(sniffImage(gif(320, 200)), { type: 'image/gif', width: 320, height: 200 });
  assert.deepEqual(sniffImage(webpX(4000, 3000)), { type: 'image/webp', width: 4000, height: 3000 });
  assert.deepEqual(sniffImage(webpLossy(1024, 768)), { type: 'image/webp', width: 1024, height: 768 });
  assert.deepEqual(sniffImage(webpLossless(800, 600)), { type: 'image/webp', width: 800, height: 600 });
  assert.deepEqual(sniffImage(avif(1920, 1080)), { type: 'image/avif', width: 1920, height: 1080 });
});

test('a JPEG\'s size is found past other segments, and a JPEG whose size cannot be read is still a JPEG', () => {
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), u16(10), Buffer.alloc(8)]);
  const withExif = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xc2]), u16(17), Buffer.from([8]), u16(90), u16(160), Buffer.alloc(20)]);
  assert.deepEqual(sniffImage(withExif), { type: 'image/jpeg', width: 160, height: 90 });
  assert.deepEqual(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(40).fill(0)])), { type: 'image/jpeg', width: null, height: null });
});

test('everything that is not one of those pictures is refused, whatever it was called', () => {
  const refused = {
    html: Buffer.from('<!doctype html><html><script>alert(1)</script></html>'),
    svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>'),
    heic: Buffer.concat([u32(24), Buffer.from('ftypheic'), Buffer.alloc(16)]),
    mp4: Buffer.concat([u32(24), Buffer.from('ftypisom'), Buffer.alloc(16)]),
    pdf: Buffer.from('%PDF-1.7 ....................'),
    zip: Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Array(20).fill(1)]),
    bmp: Buffer.from('BM' + 'x'.repeat(40)),
    riffWave: Buffer.concat([Buffer.from('RIFF'), u32(40), Buffer.from('WAVEfmt '), Buffer.alloc(20)]),
    tiny: Buffer.from([0xff, 0xd8, 0xff]),
    empty: Buffer.alloc(0),
  };
  for (const [name, bytes] of Object.entries(refused)) assert.equal(sniffImage(bytes), null, name);
  for (const nope of [null, undefined, 'a string', 12, {}]) assert.equal(sniffImage(nope), null);
});

test('size limits: a small file that unpacks to a huge picture is refused before a browser is asked to open it', () => {
  assert.equal(sizeAllowed({ width: 4000, height: 3000 }), true);
  assert.equal(sizeAllowed({ width: 8000, height: 8000 }), true);
  assert.equal(8000 * 8000 <= MAX_PIXELS, true);
  assert.equal(sizeAllowed({ width: 9000, height: 9000 }), false);
  assert.equal(sizeAllowed({ width: 30000, height: 10 }), false);
  assert.equal(sizeAllowed({ width: null, height: null }), true, 'a size that could not be read is limited by the byte limit instead');
});

// ---- a page's own named picture

test('a page\'s picture: Open Graph first, then Twitter, link rel and JSON-LD; relative and http addresses made absolute https', () => {
  const html = `<html><head>
    <title>Fallback &amp; title</title>
    <meta name="twitter:image" content="/img/twitter.jpg">
    <meta property="og:image" content="http://cdn.example.com/og.jpg?a=1&amp;b=2">
    <meta property="og:title" content="A &quot;Modern&quot; kitchen">
    <link rel="image_src" href="//cdn.example.com/linked.jpg">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Article","image":["https://cdn.example.com/ld1.jpg",{"url":"https://cdn.example.com/ld2.jpg"}]}]}</script>
  </head></html>`;
  const page = pageImages(html, 'https://www.example.com/blog/post');
  assert.deepEqual(page.images, ['https://cdn.example.com/og.jpg?a=1&b=2', 'https://www.example.com/img/twitter.jpg', 'https://cdn.example.com/linked.jpg', 'https://cdn.example.com/ld1.jpg', 'https://cdn.example.com/ld2.jpg']);
  assert.equal(page.title, 'A "Modern" kitchen');
});

test('a page with nothing usable gives nothing; hostile values are dropped, never followed', () => {
  assert.deepEqual(pageImages('<p>no head</p>', 'https://example.com/').images, []);
  const hostile = `<meta property="og:image" content="javascript:alert(1)"><meta property="og:image" content="data:image/png;base64,AAAA"><meta property="og:image" content="file:///etc/passwd"><meta property="og:image" content="https://u:p@example.com/a.jpg"><script type="application/ld+json">{ not json</script><meta property="og:image" content="${'https://example.com/' + 'a'.repeat(3000)}">`;
  assert.deepEqual(pageImages(hostile, 'https://example.com/').images, []);
  const many = Array.from({ length: 20 }, (_, i) => `<meta property="og:image" content="https://example.com/${i}.jpg">`).join('');
  assert.equal(pageImages(many, 'https://example.com/').images.length, 6);
  assert.equal(pageImages(`<title>${'x'.repeat(500)}</title>`, 'https://example.com/').title.length, 140);
});
