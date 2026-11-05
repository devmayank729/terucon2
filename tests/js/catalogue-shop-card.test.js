import assert from 'node:assert/strict';
import test from 'node:test';
import { resultCardHtml } from '../../site/catalogue-ui/client.js';

// The Finder's result card (targets C4, A1): a design that is also a shop product opens its shop page and says the listed price, as a sample;
// any other opens the catalogue picture. Nothing from a result is put into the markup unescaped.

const base = { itemId: 'a-p0032-i00', title: 'Emperador Dark', productId: 'TIPL-SB804', finish: 'polished', image: { thumbUrl: 'https://signed.example/t.jpg', fullUrl: 'https://signed.example/f.png', width: 1025, height: 1537 } };

test('a design that is a shop product links to its shop page and shows the listed price as a sample price', () => {
  const html = resultCardHtml({ ...base, shop: { href: '/materials#/p/tipl-sb804?v=x', priceText: '₹6,020 / sheet' } });
  assert.match(html, /href="\/materials#\/p\/tipl-sb804\?v=x"/);
  assert.doesNotMatch(html, /target="_blank"/);
  assert.match(html, /₹6,020 \/ sheet <span class="result-sample">sample price<\/span>/);
  assert.match(html, /TIPL-SB804/);
});

test('any other design opens the picture in a new tab and has no price', () => {
  const html = resultCardHtml({ ...base, shop: null });
  assert.match(html, /href="https:\/\/signed.example\/f.png" target="_blank" rel="noopener"/);
  assert.doesNotMatch(html, /result-price/);
});

test('a shop link that is not a shop product page is ignored, and what is written is escaped', () => {
  const html = resultCardHtml({ ...base, title: '<img src=x onerror=alert(1)>', shop: { href: 'https://evil.example/', priceText: '<b>1</b>' } });
  assert.doesNotMatch(html, /evil\.example/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<b>1<\/b>/);
});
