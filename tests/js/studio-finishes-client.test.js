import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { textureOf } from '../../site/catalogue-ui/studio-finishes.js';

// The browser script that adds the catalogue designs to the Design Studio's finish list (site/catalogue-ui/studio-finishes.js) copies what the server sent into
// each finish. Its textureOf() decides what reaches the studio as a `texture` (the instant WebGL preview), so it must refuse anything that is not one of the
// site's own design pictures, and never let a size through under the names the studio quotes to the render model (tileWidthM / tileHeightM).

const GOOD = { url: '/media/materials/tipl-sb804.jpg', previewTileWidthM: 1.22, previewTileHeightM: 0.854, sheen: 'gloss' };

describe('textureOf (the browser script)', () => {
  test('a design picture with its tile size and sheen is kept, as a new object', () => {
    const out = textureOf(GOOD);
    assert.deepEqual(out, GOOD);
    assert.notEqual(out, GOOD);
    assert.deepEqual(textureOf({ ...GOOD, url: '/media/materials/tipl-sb830.jpg?tone=100' }).url, '/media/materials/tipl-sb830.jpg?tone=100', 'the tile-preparation hint is allowed');
    assert.equal(textureOf({ ...GOOD, sheen: undefined }).sheen, undefined, 'no sheen: none stated');
    assert.equal('sheen' in textureOf({ ...GOOD, sheen: 'wet' }), false, 'a word that is not one of the five is dropped, the rest stays');
  });

  test('anything that is not a design picture of this site, or has no usable size, is refused (the finish then renders with the AI only)', () => {
    for (const url of ['https://elsewhere.example/tipl-sb804.jpg', '//elsewhere.example/media/materials/tipl-sb804.jpg', '/media/materials/tipl-sb804.png', '/media/materials/fx-mill.jpg', '/media/materials/../../.env', '/textures/oak-planks.png', '/media/materials/tipl-sb804.jpg?w=320', '/media/materials/tipl-sb804.jpg?tone=1000', '/media/materials/tipl-sb804.jpg?tone=1&x=2', 'javascript:alert(1)', '', null, 5]) {
      assert.equal(textureOf({ ...GOOD, url }), null, String(url));
    }
    for (const bad of [null, undefined, 'x', 5, [], {}]) assert.equal(textureOf(bad), null);
    for (const [w, h] of [[0, 1], [1, 0], [-1, 1], [1, -1], ['wide', 1], [NaN, 1], [11, 1], [1, 11], [undefined, 1]]) assert.equal(textureOf({ ...GOOD, previewTileWidthM: w, previewTileHeightM: h }), null, `${w} x ${h}`);
  });

  test('only the preview\'s own fields are copied: a size under the studio\'s own names never gets through', () => {
    const out = textureOf({ ...GOOD, tileWidthM: 9, tileHeightM: 9, extra: '<script>' });
    assert.deepEqual(Object.keys(out).sort(), ['previewTileHeightM', 'previewTileWidthM', 'sheen', 'url']);
  });
});
