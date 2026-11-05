import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import test, { describe } from 'node:test';
import { briefOf, finishOf, LARGE_FEATURE_TONE_RADIUS, MARKER_RE, PREVIEW_TILE_HEIGHT_M, PREVIEW_TILE_WIDTH_M, referenceRules, STUDIO_KINDS, stripMarker, textureOf, withReference } from '../../server/catalogue/studioFinishes.js';
import { CLAIMS, promptFor, refusal } from '../../tools/describe-designs.js';
import { request } from '../helpers/http.js';
import { makeProjectRoot, setStudioEnv } from '../helpers/studio.js';

// A catalogue design in the Design Studio (targets C1, A1): the finish and its brief, the reference photograph that is added to the render request in
// front of the studio's own route (swatchroom/ is never edited), and the check on what Gemini may say about a design.

const STUDIO = { look: 'A dark brown surface with a web of fine off-white veins.', colours: ['espresso brown', 'warm off-white'], pattern: 'marble-like veining', grain: 'random', scale: 'large', sheen: 'gloss', relief: 'flat', render: 'Paint a dark brown ground with a dense web of fine, branching off-white veins.', model: 'gemini-test', generatedAt: 1 };
const design = (over = {}) => ({ id: 'tipl-sb804', productId: 'TIPL-SB804', code: 'SB804', name: 'Emperador Dark', hex: '#271c1c', studio: STUDIO, ...over });
const PICTURE = { bytes: Buffer.from('not-really-a-jpeg-but-bytes'), type: 'image/jpeg', tag: 'abc' };
const parts3 = () => [{ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }, { inlineData: { mimeType: 'image/png', data: 'BBBB' } }, { inlineData: { mimeType: 'image/jpeg', data: 'CCCC' } }];

describe('the finish and its brief', () => {
  test('a described design: its name, code, look, colours, pattern, direction, scale, sheen and relief, and the marker once at the end', () => {
    const text = briefOf(design());
    assert.match(text, /"Emperador Dark" \(code SB804\)/);
    assert.match(text, /How it looks: A dark brown surface/);
    assert.match(text, /Colours: espresso brown, warm off-white\. Pattern: marble-like veining\. Paint a dark brown ground/);
    assert.match(text, /wanders in every direction/, 'grain: random has its own sentence');
    assert.match(briefOf(design({ studio: { ...STUDIO, grain: 'none' } })), /no fixed direction/, 'and so does none');
    assert.match(text, /large-scale pattern/);
    assert.match(text, /glossy/);
    assert.match(text, /flat and smooth/);
    assert.equal(text.match(new RegExp(MARKER_RE.source, 'g')).length, 1);
    assert.ok(text.endsWith('[[terucon-design:TIPL-SB804]]'));
    // nothing in it states a size, a material, a performance or a price: only what the picture shows
    assert.equal(CLAIMS.exec(text.replace('Terucon catalogue', '')), null, `a claim slipped in: ${CLAIMS.exec(text)?.[0]}`);
  });

  test('a design Gemini has not described yet still has a brief: its colour, and the reference photograph as the authority', () => {
    const text = briefOf(design({ studio: null }));
    assert.match(text, /dominant colour is close to #271c1c/);
    assert.match(text, /exactly from the reference photograph/);
    assert.match(briefOf(design({ studio: null, hex: null })), /colour, pattern and finish exactly from the reference photograph/);
  });

  test('every direction, scale, sheen and relief has a sentence (no "undefined" anywhere), and the combinations read differently', () => {
    const seen = new Set();
    for (const grain of ['none', 'vertical', 'horizontal', 'diagonal', 'random']) for (const scale of ['fine', 'medium', 'large']) for (const sheen of ['matte', 'satin', 'semi-gloss', 'gloss', 'metallic']) for (const relief of ['flat', 'fine texture', 'pronounced texture', 'embossed']) {
      const t = briefOf(design({ studio: { ...STUDIO, grain, scale, sheen, relief } }));
      assert.ok(!/undefined/.test(t), `${grain} ${scale} ${sheen} ${relief}`);
      seen.add(t);
    }
    assert.equal(seen.size, 5 * 3 * 5 * 4, 'every combination is its own text');
  });

  test('the finish carries what the studio\'s list needs and nothing secret; the kinds are wall, door and furniture', () => {
    const f = finishOf(design());
    assert.deepEqual(Object.keys(f).sort(), ['about', 'code', 'described', 'hex', 'id', 'image', 'name', 'productId', 'prompt', 'sub', 'texture']);
    assert.equal(f.sub, 'SB804 · marble-like veining, gloss');
    assert.equal(f.image, '/media/materials/tipl-sb804.jpg?w=320');
    assert.deepEqual([...STUDIO_KINDS], ['wall', 'door', 'furniture']);
  });
});

describe('the instant preview\'s texture of a design (target C1: WebGL2 / WebGPU in the browser, beside the AI render)', () => {
  test('a design\'s texture is its own photograph, with the preview\'s tile size and the sheen Gemini read: and never a tileWidthM / tileHeightM', () => {
    const medium = design({ studio: { ...STUDIO, scale: 'medium' } }); // (the fixture's own scale is 'large', which asks for the wider tone radius: below)
    const texture = textureOf(medium);
    assert.deepEqual(texture, { url: '/media/materials/tipl-sb804.jpg', previewTileWidthM: 1.22, previewTileHeightM: 0.854, sheen: 'gloss' });
    // the studio QUOTES tileWidthM / tileHeightM to the render model as a measured repeat ("Tile repeat scale must match ..."): this size is a guess
    // (the catalogue records no size), so it must be under other names, or the AI brief would state an invented measurement
    assert.ok(!('tileWidthM' in texture) && !('tileHeightM' in texture));
    assert.equal(PREVIEW_TILE_WIDTH_M, 1.22);
    assert.equal(PREVIEW_TILE_HEIGHT_M, 0.854);
    assert.ok(Math.abs(PREVIEW_TILE_HEIGHT_M / PREVIEW_TILE_WIDTH_M - 0.7) < 0.001, 'the proportions of every texture of the preview, 10:7');
    // a design Gemini has not described has a texture too (the photograph is the texture), with no sheen to state
    assert.deepEqual(textureOf(design({ studio: null })), { url: '/media/materials/tipl-sb804.jpg', previewTileWidthM: 1.22, previewTileHeightM: 0.854 });
    // it is the 800 px picture (no ?w=320 thumbnail), at the address the server answers from Cloud Storage
    assert.ok(!/\?/.test(texture.url));
    // a design with BOLD features asks the browser for a wider lighting-drift removal (?tone=): 40 smudged them (SB830, SB8001). The other 55 of 63 keep the default.
    assert.equal(LARGE_FEATURE_TONE_RADIUS, 100);
    assert.equal(textureOf(design({ studio: { ...STUDIO, scale: 'large' } })).url, '/media/materials/tipl-sb804.jpg?tone=100');
    for (const scale of ['fine', 'medium']) assert.equal(textureOf(design({ studio: { ...STUDIO, scale } })).url, '/media/materials/tipl-sb804.jpg', scale);
  });

  test('the finish carries it, one per design, and the same texture for every kind of surface (the studio gives each kind its own item id)', () => {
    assert.deepEqual(finishOf(design()).texture, textureOf(design()));
    assert.deepEqual(finishOf(design({ id: 'tipl-cmt6001', productId: 'TIPL-CMT6001', code: 'CMT6001', studio: { ...STUDIO, scale: 'fine' } })).texture.url, '/media/materials/tipl-cmt6001.jpg');
  });

  test('rule 13 tells the render model that a preview in the guide image is a stand-in: take its convergence and light, not its repeat size or tile joins', () => {
    const rules = referenceRules(design(), 4);
    assert.match(rules, /13\. Scale the pattern from the room/);
    assert.match(rules, /If Image 3 carries a perspective preview of this design inside the outline, it is a stand-in: take only its line convergence and the room's light from it, never its repeat size or the joins of its tiles\./);
    assert.match(rules, /14\. Keep the sample's sheen/, 'rule 14 follows, the numbering is unchanged');
    // the lite model sends no guide image: Image 3 is then the reference photograph itself, and the sentence about a preview in Image 3 must not be there
    const lite = referenceRules(design(), 3);
    assert.ok(!/stand-in/.test(lite) && !/preview/.test(lite), 'no sentence about a preview when there is no guide image');
    assert.match(lite, /13\. Scale the pattern from the room.*unless the brief asks for joints\.\n14\./s, 'rule 13 otherwise as before');
  });
});

describe('withReference: the photograph as one more image', () => {
  test('it is the last image, numbered from the images already there, with four rules that use that number', () => {
    const body = { parts: parts3(), brief: `Image 1 is 100 x 100 px.\nDetails: ${briefOf(design())}\nKeep everything outside the white mask.`, systemPrompt: 'THE STUDIO RULES' };
    const before = JSON.stringify(body);
    const out = withReference(design(), PICTURE, body);
    assert.equal(JSON.stringify(body), before, 'the request that was given is not changed');
    assert.equal(out.imageNumber, 4);
    assert.equal(out.parts.length, 4);
    assert.deepEqual(out.parts.at(-1), { inlineData: { mimeType: 'image/jpeg', data: PICTURE.bytes.toString('base64') } });
    assert.deepEqual(out.parts.slice(0, 3), body.parts, 'the studio\'s own images come first, in order');
    assert.ok(!MARKER_RE.test(out.brief), 'the marker is gone');
    assert.match(out.brief, /Details: Apply the Terucon catalogue design/, 'the rest of the brief is as it was');
    assert.match(out.brief, /Material reference: Image 4 is the sample photograph of "Emperador Dark" \(SB804\); follow rules 11 to 14/);
    assert.ok(out.systemPrompt.startsWith('THE STUDIO RULES\n'));
    for (const rule of ['11. Reproduce what Image 4 shows', '12. Image 4 is a sample photograph, not a picture to paste', '13. Scale the pattern from the room', '14. Keep the sample\'s sheen and relief']) assert.ok(out.systemPrompt.includes(rule), rule);
    assert.match(out.systemPrompt, /lit by the light of Image 1/, 'the room\'s light, not the sample\'s');
    assert.match(out.systemPrompt, /If Image 3 carries a perspective preview of this design/, 'with a guide image (the reference is Image 4) the stand-in sentence is there');
  });

  test('the lite model sends no guide image: the photograph is Image 3, and the rules say so', () => {
    const out = withReference(design(), PICTURE, { parts: parts3().slice(0, 2), brief: briefOf(design()), systemPrompt: 'S' });
    assert.equal(out.imageNumber, 3);
    assert.match(out.systemPrompt, /11\. Reproduce what Image 3 shows/);
    assert.ok(!/Image 4/.test(out.systemPrompt + out.brief));
    assert.ok(!/stand-in/.test(out.systemPrompt), 'Image 3 is the reference here: nothing may call it a preview');
  });

  test('only the marker (and the space before it) is taken out of a text', () => {
    assert.equal(stripMarker('a  b [[terucon-design:TIPL-SB804]]\nc'), 'a  b\nc');
    assert.equal(stripMarker('no marker  here'), 'no marker  here');
    assert.match(referenceRules(design(), 7), /Image 7/);
  });
});

describe('the middleware in front of the studio\'s own /api/ai/generate', () => {
  setStudioEnv({ AI_BODY_LIMIT: '40mb' });
  delete process.env.PORT;
  delete process.env.HOST;
  const project = makeProjectRoot();

  async function boot(store) {
    const { createApp } = await import('../../app.js');
    const { createAuthDb } = await import('../../server/auth/db.js');
    const { captureProviders, SECRET } = await import('../helpers/authKit.js');
    const { signInVia } = await import('../helpers/signIn.js');
    const capture = captureProviders();
    const lines = [];
    const log = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m), raw: (m) => lines.push(m) };
    const app = createApp({ root: project.root, swatchroom: true, log, auth: { db: createAuthDb({}), providers: capture.providers, secret: SECRET }, catalogue: { designs: store } });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const need = createRequire(path.join(project.studioDir, 'server', 'index.js'));
    need('mongoose').set('bufferCommands', false);
    // the studio's own route calls vertex.callModel(request, makeBodies): keep what it would have sent to Google
    const vertex = need(path.join(project.studioDir, 'server', 'google', 'vertex.js'));
    const sent = [];
    vertex.callModel = async (request, makeBodies) => {
      sent.push({ request, bodies: makeBodies(request.model) });
      return { response: { candidates: [] }, attempt: 1, model: request.model };
    };
    const member = await signInVia((p, o = {}) => request(port, { path: p, ...o }), capture);
    const post = (body, headers = {}) => request(port, { method: 'POST', path: '/api/ai/generate', headers: { ...member.headers, ...headers }, body });
    return { app, port, sent, lines, post, anonymous: (body) => request(port, { method: 'POST', path: '/api/ai/generate', body }), stop: async () => { await new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))); await app.locals.terucon.close(); } };
  }

  const renderBody = (extra = {}) => ({ task: 'image', model: 'gemini-3.1-flash-image', location: 'global', parts: parts3(), brief: `Image 1 is 10 x 10 px.\nDetails: ${briefOf(design())}\nKeep everything outside the mask.`, systemPrompt: 'THE STUDIO RULES', aspectRatio: '3:2', imageSize: '2K', ...extra });
  const textOf = (body) => body.contents[0].parts.at(-1).text;
  const images = (body) => body.contents[0].parts.filter((p) => p.inlineData);
  const found = { get: async (slug) => (slug === 'tipl-sb804' ? design() : null), image: async () => PICTURE };

  test('a render with the marker reaches the studio\'s route with the photograph attached, the rules added and the marker gone', async () => {
    const t = await boot(found);
    try {
      const r = await t.post(renderBody());
      assert.equal(r.status, 200, r.text);
      assert.equal(t.sent.length, 1);
      const body = t.sent[0].bodies[0];
      assert.equal(images(body).length, 4, 'the room, the mask, the guide and the sample');
      assert.equal(images(body)[3].inlineData.data, PICTURE.bytes.toString('base64'));
      assert.ok(!MARKER_RE.test(textOf(body)), 'no marker is sent to Google');
      assert.match(textOf(body), /Material reference: Image 4/);
      assert.match(body.systemInstruction.parts[0].text, /^THE STUDIO RULES\n[\s\S]*14\. Keep the sample's sheen/);
      assert.match(t.lines.join('\n'), /TIPL-SB804: reference photograph attached as Image 4/);
    } finally {
      await t.stop();
    }
  });

  test('a render without the marker, a json task and any other route pass through exactly as they were', async () => {
    const t = await boot(found);
    try {
      const plain = renderBody({ brief: 'Image 1 is 10 x 10 px.\nDetails: Repaint the wall.' });
      assert.equal((await t.post(plain)).status, 200);
      const body = t.sent[0].bodies[0];
      assert.equal(images(body).length, 3);
      assert.equal(textOf(body), plain.brief);
      assert.equal(body.systemInstruction.parts[0].text, 'THE STUDIO RULES');
      const json = { task: 'json', model: 'gemini-3.8-flash', contents: [{ role: 'user', parts: [{ text: `x ${briefOf(design())}` }] }] };
      assert.equal((await t.post(json)).status, 200);
      assert.match(JSON.stringify(t.sent[1].bodies[0].contents), /terucon-design:TIPL-SB804/, 'only a render is touched');
    } finally {
      await t.stop();
    }
  });

  test('a design that is unknown, a picture that cannot be read and a store that fails each leave the render going with the text brief, marker removed', async () => {
    for (const [what, store, expect] of [
      ['unknown', { get: async () => null, image: async () => PICTURE }, /the design is not in the catalogue/],
      ['no picture', { get: async () => design(), image: async () => null }, /the picture could not be read/],
      ['store fails', { get: async () => { throw new Error('database down'); }, image: async () => PICTURE }, /no reference photograph attached/],
    ]) {
      const t = await boot(store);
      try {
        assert.equal((await t.post(renderBody())).status, 200, what);
        const body = t.sent[0].bodies[0];
        assert.equal(images(body).length, 3, what);
        assert.ok(!MARKER_RE.test(textOf(body)), `${what}: the marker must never reach Google`);
        assert.match(t.lines.join('\n'), expect, what);
        assert.match(textOf(body), /Apply the Terucon catalogue design "Emperador Dark"/, `${what}: the text brief is still there`);
      } finally {
        await t.stop();
      }
    }
  });

  test('nobody is read before they are signed in, and a request the studio would refuse is still refused', async () => {
    let asked = 0;
    const t = await boot({ get: async () => (asked += 1, design()), image: async () => PICTURE });
    try {
      assert.equal((await t.anonymous(renderBody())).status, 401);
      assert.equal(asked, 0, 'no lookup for a stranger');
      const bad = await t.post({ task: 'image', model: 'gemini-3.1-flash-image', brief: 'x', systemPrompt: 'y', parts: [] });
      assert.equal(bad.status, 400, 'the studio\'s own validation (no parts) still answers');
    } finally {
      await t.stop();
    }
  });

  test.after(() => project.remove());
});

describe('what Gemini may say about a design (tools/describe-designs.js)', () => {
  const ok = { look: 'A copper-coloured surface with a fine metallic shimmer.', colours: ['warm copper'], pattern: 'fine speckle', grain: 'none', scale: 'fine', sheen: 'metallic', relief: 'fine texture', render: 'Render a warm copper surface with dense, minute metallic flecks and a soft, even sheen.' };

  test('appearance passes, including a metal named as a colour or a look', () => {
    assert.equal(refusal(ok), '');
    assert.equal(refusal({ ...ok, look: 'A brushed-steel look in cool grey with a soft bronze undertone.' }), '');
    assert.equal(refusal({ ...ok, look: 'A pattern composed of fine speckles over a warm ground.' }), '');
  });

  test('a size, a material, a performance, a price or "made of" is refused, and so is a missing or foreign field', () => {
    for (const text of ['It is 12 mm thick.', 'Made of aluminium composite.', 'A durable, scratch-proof laminate.', 'A waterproof surface.', 'Fire resistant.', 'An affordable choice.', 'A premium finish.', 'Looks like real granite or limestone.', 'Surface made from recycled resin.', 'About 120 cm wide.']) {
      assert.notEqual(refusal({ ...ok, look: text }), '', text);
      assert.notEqual(refusal({ ...ok, render: text }), '', `render: ${text}`);
    }
    assert.notEqual(refusal({ ...ok, colours: ['copper', '6 mm brass'] }), '');
    assert.notEqual(refusal({ ...ok, sheen: 'shiny' }), '');
    assert.notEqual(refusal({ ...ok, relief: undefined }), '');
    assert.notEqual(refusal({ ...ok, look: 'x'.repeat(400) }), '', 'a long text is refused, never cut in the middle of a sentence');
    assert.notEqual(refusal({ ...ok, render: 'y'.repeat(800) }), '');
  });

  test('the question tells Gemini to describe appearance only, to ignore the photograph\'s own lighting, and not to write "made of"', () => {
    const q = promptFor('Emperador Dark', 'SB804');
    for (const phrase of ['Describe ONLY what you can SEE', 'Never say what it is made of', 'ignore any lighting gradient', 'Never write "made of"', 'Positive instructions only']) assert.ok(q.includes(phrase), phrase);
    assert.match(promptFor('A', 'B', 'it contains "fire"'), /Your previous answer was refused because it contains "fire"/);
    assert.ok(!promptFor('A', 'B').includes('previous answer'));
  });
});
