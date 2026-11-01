import assert from 'node:assert/strict';
import test from 'node:test';
import { allCdnHosts, classify, describeFound, detect, findAddresses, hostMatcher, isCdnOf, LOGIN_SITES, SOURCES, supportedSites } from '../../site/inspiration/sources.js';

// Inspiration import (C3): which kind of address is this, and what is its canonical form? One registry decides, in the browser (to
// ask "import this photo?") and on the server (which re-decides). Nothing here touches the network.

const kindOf = (text) => {
  const found = detect(text);
  return found ? `${found.type}/${found.kind}/${found.source?.id ?? '-'}/${found.shape ?? '-'}` : null;
};
const urlOf = (text) => detect(text)?.url;

test('Pinterest: pins, boards and sections are told apart and rebuilt from their parts', () => {
  assert.equal(kindOf('https://www.pinterest.com/pin/1234567890123456/'), 'source/photo/pinterest/pin');
  assert.equal(urlOf('https://in.pinterest.com/pin/1234567890123456/sent/?invite_code=abc#x'), 'https://www.pinterest.com/pin/1234567890123456/');
  assert.equal(urlOf('https://pinterest.co.uk/pin/99999/'), 'https://www.pinterest.com/pin/99999/');
  assert.equal(kindOf('https://www.pinterest.com/some_one/kitchen-ideas/'), 'source/collection/pinterest/board');
  assert.equal(urlOf('  https://in.pinterest.com/some_one/kitchen-ideas?utm=1#x  '), 'https://www.pinterest.com/some_one/kitchen-ideas/');
  assert.equal(kindOf('https://www.pinterest.com/some_one/kitchen-ideas/island-lights/'), 'source/collection/pinterest/board section');
  assert.equal(urlOf('https://www.pinterest.com/some%20one/caf%C3%A9-ideas/'), 'https://www.pinterest.com/some%20one/caf%C3%A9-ideas/');
  assert.equal(kindOf('https://pin.it/4AbCdEf'), 'source/photo/pinterest-short/short link');
});

test('Pinterest: profiles, search and its own pages are refused with a message, never read as a board', () => {
  for (const text of ['https://www.pinterest.com/some_one/', 'https://www.pinterest.com/some_one/_created/', 'https://www.pinterest.com/some_one/pins/', 'https://www.pinterest.com/ideas/kitchen/', 'https://www.pinterest.com/search/pins/?q=x', 'https://www.pinterest.com/']) {
    const found = detect(text);
    assert.equal(found?.type, 'unsupported', text);
    assert.match(found.message, /Pinterest/, text);
  }
});

test('the other sites: photo or collection, with the address rebuilt', () => {
  assert.equal(kindOf('https://unsplash.com/photos/a-kitchen-with-a-wooden-island-Ab12Cd34Ef5?utm_source=x'), 'source/photo/unsplash/photo');
  assert.equal(urlOf('https://unsplash.com/photos/a-kitchen-Ab12Cd34Ef5?utm_source=x'), 'https://unsplash.com/photos/a-kitchen-Ab12Cd34Ef5');
  assert.equal(kindOf('https://unsplash.com/collections/12345678/modern-interiors'), 'source/collection/unsplash/collection');
  assert.equal(urlOf('https://www.pexels.com/photo/white-wooden-cabinet-1457842/?x=1'), 'https://www.pexels.com/photo/white-wooden-cabinet-1457842/');
  assert.equal(kindOf('https://www.pexels.com/collections/living-rooms-a1b2c3d/'), 'source/collection/pexels/collection');
  assert.equal(urlOf('https://www.flickr.com/photos/12345678@N05/53012345678/in/dateposted/'), 'https://www.flickr.com/photos/12345678@N05/53012345678/');
  assert.equal(kindOf('https://www.flickr.com/photos/some_one/albums/72177720300000000'), 'source/collection/flickr/album');
  assert.equal(kindOf('https://flic.kr/p/2abCdE'), 'source/photo/flickr-short/short link');
  assert.equal(urlOf('https://www.behance.net/gallery/123456789/Minimal-Apartment'), 'https://www.behance.net/gallery/123456789');
  assert.equal(kindOf('https://imgur.com/a/AbCdEfG'), 'source/collection/imgur/album');
  assert.equal(kindOf('https://imgur.com/AbCdEfG'), 'source/photo/imgur/picture');
  assert.equal(urlOf("https://commons.wikimedia.org/wiki/File:Foo_(bar),_1's.jpg"), "https://commons.wikimedia.org/wiki/File:Foo_(bar)%2C_1's.jpg");
});

test('sites that need a sign-in are named as such, and the message points to uploading', () => {
  for (const text of ['https://www.instagram.com/p/AbC123/', 'https://instagr.am/p/x/', 'https://www.facebook.com/photo/?fbid=1', 'https://x.com/someone/status/1', 'https://twitter.com/someone/status/1']) {
    const found = detect(text);
    assert.equal(found?.type, 'login', text);
    assert.match(found.message, /upload/i);
  }
  assert.equal(LOGIN_SITES.length, 3);
});

test('a link to a picture file is "direct", any other page is "page", and a known site\'s unknown page is refused rather than guessed at', () => {
  assert.equal(kindOf('https://example.com/a/b.jpg?x=1'), 'direct/photo/-/-');
  assert.equal(urlOf('http://example.com/a/b.PNG#frag'), 'https://example.com/a/b.PNG');
  assert.equal(kindOf('https://i.pinimg.com/originals/aa/bb/cc.webp'), 'direct/photo/-/-');
  assert.equal(kindOf('https://www.houzz.com/photos/modern-kitchen-phvw-vp~12345'), 'page/photo/-/-');
  assert.equal(detect('https://unsplash.com/s/photos/kitchen')?.type, 'unsupported');
  assert.equal(detect('https://www.behance.net/collection/123456/Interiors')?.type, 'unsupported');
  assert.equal(detect('https://www.flickr.com/photos/some_one/')?.type, 'unsupported');
});

test('addresses that must never be acted on', () => {
  for (const text of [
    '', undefined, null, 42, 'hello world', 'kitchen island ideas',
    'ftp://example.com/a.jpg', 'javascript:alert(1)', 'file:///etc/passwd', 'data:image/png;base64,AAAA',
    'https://user:pw@example.com/a.jpg', 'https://example.com:8443/a.jpg',
    'http://localhost/a.jpg', 'https://127.0.0.1/a.jpg', 'https://10.0.0.5/a.jpg', 'https://[::1]/a.jpg', 'https://2130706433/a.jpg', 'https://169.254.169.254/latest/meta-data/',
    'https://intranet/a.jpg', 'https://printer.local/a.jpg', 'https://db.internal/a.jpg', 'https://nas.lan/a.jpg',
  ]) assert.equal(detect(text), null, String(text));
  // look-alikes are just other sites, never the site they imitate
  assert.equal(detect('https://pinterest.com.evil.example/pin/123/')?.type, 'page');
  assert.equal(detect('https://evilpinterest.com/pin/123/')?.type, 'page');
  assert.equal(detect('https://www.pinterest.com@evil.example/pin/123/'), null);
});

test('addresses are found inside sentences, without their trailing punctuation, and bare ones get https', () => {
  assert.deepEqual(findAddresses('look at https://www.pexels.com/photo/white-cabinet-1457842/, nice (https://example.com/a.jpg).'), ['https://www.pexels.com/photo/white-cabinet-1457842/', 'https://example.com/a.jpg']);
  assert.equal(urlOf('www.pinterest.com/pin/9999999/'), 'https://www.pinterest.com/pin/9999999/');
  assert.equal(urlOf('pin.it/4AbCdEf'), 'https://pin.it/4AbCdEf');
  assert.deepEqual(findAddresses('see example.com/a.jpg for more'), []); // a bare address only when it is all that was pasted
  assert.equal(findAddresses('x'.repeat(5000)).length, 0);
  assert.ok(findAddresses(`https://example.com/${'a'.repeat(3000)}.jpg`)[0].length <= 2000);
  assert.equal(detect('https://example.com/a.jpg https://www.pinterest.com/pin/123456/')?.type, 'direct', 'the first usable address wins');
});

test('this site\'s own addresses are never offered for import', () => {
  assert.equal(detect('https://terucon.example/materials', { ownHost: 'terucon.example' }), null);
  assert.equal(detect('https://terucon.example:8080/materials', { ownHost: 'terucon.example:8080' })?.type, undefined);
  assert.equal(detect('https://other.example/a.jpg', { ownHost: 'terucon.example' })?.type, 'direct');
});

test('picture hosts: wildcards cover subdomains only, and only the registry\'s own lists count', () => {
  const m = hostMatcher(['*.pinimg.com', 'images.unsplash.com']);
  assert.equal(m('i.pinimg.com'), true);
  assert.equal(m('I.PINIMG.COM'), true);
  assert.equal(m('pinimg.com'), false);
  assert.equal(m('pinimg.com.evil.example'), false);
  assert.equal(m('evilpinimg.com'), false);
  assert.equal(m('images.unsplash.com'), true);
  assert.equal(m('x.images.unsplash.com'), false);
  assert.equal(m(undefined), false);
  assert.equal(isCdnOf('pinterest', 'i.pinimg.com'), true);
  assert.equal(isCdnOf('pinterest', 'images.pexels.com'), false);
  assert.equal(isCdnOf('nope', 'i.pinimg.com'), false);
  assert.ok(allCdnHosts().includes('*.pinimg.com'));
});

test('every shape of every source has an example that classifies as that shape, and every source names its picture hosts', () => {
  for (const source of SOURCES) {
    assert.ok(source.cdn.length, `${source.id} has no picture hosts`);
    for (const shape of source.shapes) {
      const found = detect(shape.example);
      assert.ok(found, `${source.id}/${shape.name}: ${shape.example} is not recognised`);
      assert.equal(found.shape, shape.name, `${source.id}/${shape.name}: ${shape.example} was read as ${found.shape}`);
      assert.equal(found.type, shape.kind === 'none' ? 'unsupported' : 'source', `${source.id}/${shape.name}`);
      if (shape.kind !== 'none') assert.ok(shape.extractor, `${source.id}/${shape.name} names no gallery-dl extractor`);
    }
  }
});

test('the list shown on the page, and the plain phrase for the question', () => {
  const sites = supportedSites();
  assert.deepEqual(sites.map((s) => s.label), ['Pinterest', 'Unsplash', 'Pexels', 'Flickr', 'Behance', 'Imgur', 'Wikimedia Commons']);
  assert.deepEqual(sites.find((s) => s.label === 'Pinterest').kinds, ['photo', 'collection']);
  assert.equal(describeFound(detect('https://www.pinterest.com/pin/123456/')), 'a photo from Pinterest');
  assert.equal(describeFound(detect('https://www.pinterest.com/a_b/c-d/')), 'a Pinterest board');
  assert.equal(describeFound(detect('https://imgur.com/a/AbCdEfG')), 'an Imgur album');
  assert.equal(describeFound(detect('https://example.com/x.jpg')), 'a photo from example.com');
  assert.equal(describeFound(detect('https://www.houzz.com/photos/x')), 'the main picture of a page on houzz.com');
  assert.equal(describeFound(null), '');
  assert.equal(classify('not a url'), null);
});
