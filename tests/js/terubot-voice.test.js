import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { pageCsp } from '../../server/lib/csp.js';
import { cleanForSpeech, detectLanguage, helloPlan, isHinglish, planSpeech, splitSentences, SPEECH_MAX_CHARS } from '../../server/lib/terubot/speech.js';
import { createVoice, VoiceError } from '../../server/lib/terubot/voice.js';
import { describe as describeSettings, loadSettings } from '../../server/config/settings.js';
import { startBotApp } from '../helpers/terubotApp.js';

// TeruBot's voice, without Google: the text that is spoken (what was measured against Google's voices is written down in
// server/lib/terubot/speech.js), the calls to Google (a fake fetch records them), the staging of replies, and the two routes.

const MP3 = Buffer.alloc(900, 9); // stands in for audio (the voice only checks that something came back)
const okResponse = () => ({ ok: true, status: 200, json: async () => ({ audioContent: MP3.toString('base64') }) });
const errResponse = (status, body = {}) => ({ ok: false, status, json: async () => ({ error: body }) });

function fakeGoogle({ configured = true, tokenFails = false } = {}) {
  const state = { invalidated: 0, tokens: 0 };
  return {
    state,
    token: {
      describe: () => ({ configured }),
      getToken: async () => { state.tokens += 1; if (tokenFails) throw new Error('no token'); return `tok-${state.tokens}`; },
      invalidate: () => { state.invalidated += 1; },
    },
  };
}

function makeVoice({ responses = [], google = fakeGoogle(), settings = {}, now } = {}) {
  const calls = [];
  const lines = [];
  const queue = [...responses];
  const fetchImpl = async (url, options) => {
    calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    const next = queue.length ? queue.shift() : okResponse();
    return typeof next === 'function' ? next() : next;
  };
  const voice = createVoice({
    google: () => google,
    settings: () => ({ terubot: { enabled: true, voice: 'Aoede', ...settings } }),
    log: { info: (l) => lines.push(l), warn: (l) => lines.push(l) },
    fetchImpl,
    now,
    endpoint: 'https://tts.test/v1/text:synthesize',
  });
  return { voice, calls, lines, google };
}

describe('what is said: the text', () => {
  test('numbers: the comma forms are read digit by digit by the voices, so the commas go; money and units are in words', () => {
    const t = cleanForSpeech('It is ₹6,960 / sheet, Rs. 1,25,000 in all, ₹188 per sq ft, 1,200.50 meters, 1,2,3 are items.');
    assert.match(t, /6960 rupees per sheet/);
    assert.match(t, /125000 rupees in all/);
    assert.match(t, /188 rupees per square foot/);
    assert.match(t, /1200\.50 meters/);
    assert.match(t, /1,2,3 are items/, 'a list of single digits is not a number');
    assert.ok(!/₹|Rs\./.test(t));
  });

  test('sizes: 1220 x 2440 mm is "1220 by 2440 millimetres"', () => {
    assert.equal(cleanForSpeech('Size 1220 × 2440 mm, 4mm thick, 50 sq. ft. and 5 sq m'), 'Size 1220 by 2440 millimetres, 4 millimetres thick, 50 square feet and 5 square metres');
    assert.equal(cleanForSpeech('1220x2440'), '1220 by 2440');
  });

  test('codes and letters-words are spelled; the brand name is respelled; emoji, addresses, paths and markdown are gone', () => {
    assert.equal(cleanForSpeech('SB804'), 'S B 8 0 4');
    assert.equal(cleanForSpeech('TIPL-SB804 is an ACP sheet'), 'T I P L, S B 8 0 4 is an A C P sheet');
    assert.equal(cleanForSpeech('Ask TeruBot 😊 about **bronze** at https://x.test/a and /materials#/p/teak now'), 'Ask Teru Bot about bronze at and now');
    assert.equal(cleanForSpeech('- first\n- second\n\nthird'), 'first. second. third');
    assert.equal(cleanForSpeech('Options:\n- a\n- b'), 'Options: a. b');
  });

  test('what real replies showed: a hyphen inside a word is a space, and a dash after a bracket leaves no stray comma', () => {
    assert.equal(cleanForSpeech('Wire-cut Terracotta Tile (Dusk finish) – warm bronze-earth tone'), 'Wire cut Terracotta Tile (Dusk finish), warm bronze earth tone');
    assert.equal(cleanForSpeech('Is it 5 - 10 mm?'), 'Is it 5 - 10 millimetres?', 'a spaced dash between numbers is left alone');
  });

  test('Hindi text gets Hindi words for units and money', () => {
    const t = cleanForSpeech('कीमत ₹6,020 प्रति sq ft है, 1220 x 2440 mm');
    assert.match(t, /6020 रुपये/);
    assert.match(t, /वर्ग फुट/);
    assert.match(t, /1220 बाय 2440 मिलीमीटर/);
  });

  test('the language: Devanagari and Roman Hinglish go to the Hindi voice, English stays English, and one English homograph is not enough', () => {
    assert.equal(detectLanguage('Here are two tiles for your kitchen.'), 'en');
    assert.equal(detectLanguage('नमस्ते, कैसे हैं आप?'), 'hi');
    assert.equal(detectLanguage('Yeh sheet aapke kitchen ke liye bahut achhi hai'), 'hi');
    assert.equal(detectLanguage('Namaste!'), 'hi');
    assert.equal(detectLanguage('Take Main Street to the shop, then turn left.'), 'en');
    assert.equal(detectLanguage('Please do the work to the best of the plan.'), 'en');
    assert.ok(isHinglish('aap kaise hain') && !isHinglish('hello there, how are you today my friend'));
    assert.equal(detectLanguage('This sheet is good, ok? Aap kya sochte hain?'), 'hi', 'an English start with a Hindi question is Hinglish');
  });

  test('sentences end at . ! ? and at the Hindi danda; a point between digits or after e.g. does not end one', () => {
    assert.deepEqual(splitSentences('One. Two! Three? Four।  Five॥'), ['One.', 'Two!', 'Three?', 'Four।', 'Five॥']);
    assert.deepEqual(splitSentences('It is 2.5 mm thick, e.g. for walls. Done.'), ['It is 2.5 mm thick, e.g. for walls.', 'Done.']);
  });
});

describe('what is said: the plan', () => {
  test('the first sentence goes out alone, the rest are packed into pieces; every piece has its language', () => {
    const plan = planSpeech({ text: 'This is the first sentence of the answer. Second one here. Third one here. Fourth one here.' });
    assert.equal(plan.lang, 'en');
    assert.equal(plan.parts.length, 2);
    assert.equal(plan.parts[0].text, 'This is the first sentence of the answer.');
    assert.equal(plan.parts[1].text, 'Second one here. Third one here. Fourth one here.');
    assert.ok(plan.parts.every((p) => p.lang === 'en'));
  });

  test('a one-word opening ("Namaste!") is joined to the next sentence instead of being a request of its own', () => {
    const plan = planSpeech({ text: 'नमस्ते! यह शीट आपके किचन के लिए बहुत अच्छी रहेगी। इसकी कीमत ₹6,020 है।' });
    assert.equal(plan.lang, 'hi');
    assert.equal(plan.parts[0].text, 'नमस्ते! यह शीट आपके किचन के लिए बहुत अच्छी रहेगी।');
    assert.match(plan.parts[1].text, /6020 रुपये/);
  });

  test('a long answer is cut after SPEECH_MAX_CHARS and says, in its own language, that the rest is on the screen', () => {
    const long = 'This sentence keeps going and going. '.repeat(30);
    const plan = planSpeech({ text: long });
    const said = plan.parts.slice(0, -1).map((p) => p.text).join(' ');
    assert.ok(said.length <= SPEECH_MAX_CHARS + 40, `${said.length} characters`);
    assert.equal(plan.parts.at(-1).text, 'The rest is on your screen.');
    assert.ok(plan.parts.every((p) => p.text.length <= 241), 'no piece is longer than a piece should be');
    const hindi = planSpeech({ text: 'यह एक वाक्य है जो चलता रहता है। '.repeat(30) });
    assert.equal(hindi.parts.at(-1).text, 'बाकी जानकारी आपकी स्क्रीन पर है।');
    assert.equal(hindi.parts.at(-1).lang, 'hi');
  });

  test('a very long sentence is broken at a comma; a Devanagari piece in an English reply goes to the Hindi voice', () => {
    const plan = planSpeech({ text: `${'word '.repeat(30).trim()}, ${'more '.repeat(30).trim()}, and the end. नमस्ते दोस्त।` });
    assert.ok(plan.parts.length >= 2);
    assert.ok(plan.parts.every((p) => p.text.length <= 241));
    assert.equal(plan.lang, 'hi', 'any Devanagari makes the reply Hindi-voiced');
    const mixed = planSpeech({ text: 'Here is a long English sentence that has no Hindi in it at all. And another one. नमस्ते दोस्त।'.repeat(1) });
    assert.ok(mixed.parts.some((p) => /नमस्ते/.test(p.text) && p.lang === 'hi'));
  });

  test('cards and no words: the options line, in the language of what the visitor asked; nothing to say: no parts', () => {
    assert.deepEqual(planSpeech({ text: '', hasCards: true, hint: 'show me tiles' }), { lang: 'en', parts: [{ text: 'I have put the options on your screen.', lang: 'en' }] });
    assert.deepEqual(planSpeech({ text: '', hasCards: true, hint: 'mujhe kuch options dikhao' }).parts, [{ text: 'मैंने विकल्प आपकी स्क्रीन पर रख दिए हैं।', lang: 'hi' }]);
    assert.deepEqual(planSpeech({ text: '   ' }).parts, []);
    assert.deepEqual(planSpeech({ text: '😊 https://x.test' }).parts, []);
  });

  test('the greeting', () => {
    assert.deepEqual(helloPlan().parts, [{ text: 'Hi, I’m Teru Bot. How can I help?', lang: 'en' }]);
  });
});

describe('the voice: calls to Google', () => {
  test('a staged reply is fetched piece by piece: the request is the one Google documents, with the right voice for the language', async () => {
    const { voice, calls, google } = makeVoice();
    const staged = voice.stage({ text: 'Here are two lovely tiles for your kitchen wall. They come in a matt finish and a gloss one.' });
    assert.equal(staged.parts.length, 2);
    assert.match(staged.id, /^[A-Za-z0-9_-]{8,}$/);
    const first = await voice.audio(staged.id, 0);
    assert.equal(first.type, 'audio/mpeg');
    assert.equal(first.cached, false);
    assert.ok(first.bytes.equals(MP3));
    await voice.audio(staged.id, 1);
    const hindi = voice.stage({ text: 'नमस्ते दोस्त, यह शीट आपके किचन के लिए अच्छी है।' });
    await voice.audio(hindi.id, 0);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, 'https://tts.test/v1/text:synthesize');
    assert.equal(calls[0].headers.Authorization, 'Bearer tok-1');
    assert.deepEqual(calls[0].body, { input: { text: 'Here are two lovely tiles for your kitchen wall.' }, voice: { languageCode: 'en-IN', name: 'en-IN-Chirp3-HD-Aoede' }, audioConfig: { audioEncoding: 'MP3' } });
    assert.deepEqual(calls[2].body.voice, { languageCode: 'hi-IN', name: 'hi-IN-Chirp3-HD-Aoede' });
    assert.equal(google.state.tokens >= 1, true);
  });

  test('the voice name is the setting', async () => {
    const { voice, calls } = makeVoice({ settings: { voice: 'Kore' } });
    const staged = voice.stage({ text: 'Hello there.' });
    await voice.audio(staged.id, 0);
    assert.equal(calls[0].body.voice.name, 'en-IN-Chirp3-HD-Kore');
  });

  test('the same words in the same voice are made once: the second time is from memory, and so is the greeting', async () => {
    const { voice, calls } = makeVoice();
    const a = voice.stage({ text: 'Same words.' });
    const b = voice.stage({ text: 'Same words.' });
    assert.notEqual(a.id, b.id);
    assert.equal((await voice.audio(a.id, 0)).cached, false);
    assert.equal((await voice.audio(b.id, 0)).cached, true);
    assert.equal(calls.length, 1);
    await voice.audio('hello', 0);
    assert.equal((await voice.audio('hello', 0)).cached, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.input.text, 'Hi, I’m Teru Bot. How can I help?');
  });

  test('two requests for the same words at the same moment share one call to Google', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { voice, calls } = makeVoice({ responses: [async () => { await gate; return okResponse(); }] });
    const a = voice.stage({ text: 'Shared words.' });
    const b = voice.stage({ text: 'Shared words.' });
    const both = Promise.all([voice.audio(a.id, 0), voice.audio(b.id, 0)]);
    release();
    await both;
    assert.equal(calls.length, 1);
  });

  test('a busy Google (429) is tried again; a stale token (401) is replaced once; both then succeed', async () => {
    const slow = makeVoice({ responses: [errResponse(429, { status: 'RESOURCE_EXHAUSTED' }), okResponse()] });
    const s = slow.voice.stage({ text: 'Retry me.' });
    assert.ok((await slow.voice.audio(s.id, 0)).bytes.length > 0);
    assert.equal(slow.calls.length, 2);
    const stale = makeVoice({ responses: [errResponse(401, { status: 'UNAUTHENTICATED' }), okResponse()] });
    const t = stale.voice.stage({ text: 'New token please.' });
    await stale.voice.audio(t.id, 0);
    assert.equal(stale.google.state.invalidated, 1);
    assert.equal(stale.calls[1].headers.Authorization, 'Bearer tok-2');
  });

  test('Google refusing (the API is not enabled, 403): unavailable, the voice turns itself off for a while and says why in the log, with no words in it', async () => {
    let clock = 1_000_000;
    const { voice, lines } = makeVoice({ responses: [errResponse(403, { status: 'PERMISSION_DENIED', message: 'secret project name', details: [{ reason: 'SERVICE_DISABLED' }] })], now: () => clock });
    assert.equal(voice.available(), true);
    const s = voice.stage({ text: 'These exact words must never reach the log.' });
    await assert.rejects(() => voice.audio(s.id, 0), (e) => e instanceof VoiceError && e.kind === 'unavailable' && e.status === 403);
    assert.equal(voice.available(), false);
    assert.equal(voice.stage({ text: 'Anything.' }), null, 'nothing is staged while the voice is down');
    assert.ok(lines.some((l) => /voice off for 5 min/.test(l) && /PERMISSION_DENIED SERVICE_DISABLED/.test(l)), lines.join('\n'));
    assert.ok(!lines.join('\n').match(/exact words|secret project/));
    clock += 6 * 60 * 1000;
    assert.equal(voice.available(), true, 'tried again after a while');
  });

  test('a failing Google (500 three times) is a plain upstream failure; an answer without audio is too', async () => {
    const down = makeVoice({ responses: [errResponse(503), errResponse(503), errResponse(503)] });
    const s = down.voice.stage({ text: 'Fails.' });
    await assert.rejects(() => down.voice.audio(s.id, 0), (e) => e.kind === 'upstream');
    assert.equal(down.voice.available(), true, 'a bad moment does not switch the voice off');
    const empty = makeVoice({ responses: [{ ok: true, status: 200, json: async () => ({}) }] });
    const t = empty.voice.stage({ text: 'Silent.' });
    await assert.rejects(() => empty.voice.audio(t.id, 0), (e) => e.kind === 'upstream');
  });

  test('off: switched off by the setting, TeruBot off, no Google key, no token', async () => {
    assert.equal(makeVoice({ settings: { voice: '' } }).voice.available(), false);
    assert.equal(makeVoice({ settings: { enabled: false } }).voice.available(), false);
    assert.equal(makeVoice({ google: fakeGoogle({ configured: false }) }).voice.available(), false);
    const noToken = makeVoice({ google: fakeGoogle({ tokenFails: true }) });
    const s = noToken.voice.stage({ text: 'No token.' });
    await assert.rejects(() => noToken.voice.audio(s.id, 0), (e) => e.kind === 'unavailable');
    assert.equal(createVoice({ google: () => null, settings: () => ({ terubot: { enabled: true, voice: 'Aoede' } }) }).available(), false);
  });

  test('only what was staged can be had: unknown ids, pieces that do not exist, expired replies and over-fetched pieces are gone', async () => {
    let clock = 5_000;
    const { voice } = makeVoice({ now: () => clock });
    const s = voice.stage({ text: 'One. Two three four five six seven eight nine ten.' });
    await assert.rejects(() => voice.audio('nosuchid1', 0), (e) => e.kind === 'gone');
    await assert.rejects(() => voice.audio(s.id, 9), (e) => e.kind === 'gone');
    for (let i = 0; i < 4; i += 1) await voice.audio(s.id, 0);
    await assert.rejects(() => voice.audio(s.id, 0), (e) => e.kind === 'gone');
    const t = voice.stage({ text: 'Soon gone.' });
    clock += 16 * 60 * 1000;
    await assert.rejects(() => voice.audio(t.id, 0), (e) => e.kind === 'gone');
  });

  test('too many calls to Google at once: the extra one is "busy", not queued', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const slow = async () => { await gate; return okResponse(); };
    const { voice } = makeVoice({ responses: Array.from({ length: 7 }, () => slow) });
    const running = [];
    for (let i = 0; i < 6; i += 1) {
      const s = voice.stage({ text: `Words number ${i} here.` });
      running.push(voice.audio(s.id, 0));
    }
    const extra = voice.stage({ text: 'One more than allowed.' });
    await assert.rejects(() => voice.audio(extra.id, 0), (e) => e.kind === 'busy');
    release();
    await Promise.all(running);
  });
});

describe('the routes', () => {
  const settingsFor = (over = {}) => () => ({ terubot: { enabled: true, voice: 'Aoede', ...over } });
  async function startVoiceApp({ responses = [], script = [{ text: 'Here are two tiles. नमस्ते।' }], settings } = {}) {
    const calls = [];
    const app = await startBotApp({ script, terubot: { voice: createVoice({ google: () => fakeGoogle(), settings: settings ?? settingsFor(), fetchImpl: async (url, o) => { calls.push({ url, body: JSON.parse(o.body) }); const next = responses.shift(); return next ?? okResponse(); } }) } });
    return { app, calls };
  }

  test('status says whether Google\'s voice is on', async () => {
    const { app } = await startVoiceApp();
    try {
      assert.equal((await app.status()).json().voice, true);
    } finally {
      await app.stop();
    }
    const off = await startVoiceApp({ settings: settingsFor({ voice: '' }) });
    try {
      assert.equal((await off.app.status()).json().voice, false);
    } finally {
      await off.app.stop();
    }
  });

  test('a chat without speak:true is as it always was; with speak:true the reply carries the pieces, and each piece is audio', async () => {
    const { app, calls } = await startVoiceApp();
    try {
      const plain = (await app.say('hi')).json();
      assert.ok(!('speech' in plain));
      const r = (await app.say('hi', { speak: true })).json();
      assert.equal(r.reply, 'Here are two tiles. नमस्ते।');
      assert.equal(r.speech.parts.length, 1);
      assert.equal(r.speech.parts[0].lang, 'hi');
      assert.match(r.speech.id, /^[A-Za-z0-9_-]{8,}$/);
      const audio = await app.request(`/api/terubot/speech?id=${r.speech.id}&n=0`);
      assert.equal(audio.status, 200);
      assert.equal(audio.headers['content-type'], 'audio/mpeg');
      assert.equal(audio.headers['cache-control'], 'no-store');
      assert.ok(audio.buffer.equals(MP3));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.voice.name, 'hi-IN-Chirp3-HD-Aoede');
      const logged = app.log.lines.join('\n');
      assert.ok(/terubot  speech ok  lang=hi/.test(logged), logged);
      assert.ok(!logged.includes('नमस्ते') && !logged.includes('two tiles'), 'the words are not in the log');
    } finally {
      await app.stop();
    }
  });

  test('the greeting is served without a chat; nothing else can be asked for: no such id, bad ids, cross-site, wrong method', async () => {
    const { app } = await startVoiceApp();
    try {
      const hello = await app.request('/api/terubot/speech?id=hello&n=0');
      assert.equal(hello.status, 200);
      assert.equal((await app.request('/api/terubot/speech?id=hello&n=1')).status, 404);
      assert.equal((await app.request('/api/terubot/speech?id=nosuchreply&n=0')).status, 404);
      assert.equal((await app.request('/api/terubot/speech?id=..%2Fetc&n=0')).status, 404);
      assert.equal((await app.request('/api/terubot/speech?id=hello&n=-1')).status, 404);
      assert.equal((await app.request('/api/terubot/speech')).status, 404);
      assert.equal((await app.request('/api/terubot/speech?id[]=hello&n=0')).status, 404);
      assert.equal((await app.request('/api/terubot/speech?id=hello&n=0', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
      assert.equal((await app.request('/api/terubot/speech?id=hello&n=0', { method: 'POST', body: {} })).status, 405);
    } finally {
      await app.stop();
    }
  });

  test('Google refusing gives the browser a plain 503 (it then uses its own voice) and the chat itself carries on without a speech', async () => {
    const { app } = await startVoiceApp({ responses: [errResponse(403, { status: 'PERMISSION_DENIED' })] });
    try {
      const r = (await app.say('hi', { speak: true })).json();
      const refused = await app.request(`/api/terubot/speech?id=${r.speech.id}&n=0`);
      assert.equal(refused.status, 503);
      assert.deepEqual(refused.json(), { error: 'The voice is off right now.' });
      const next = (await app.say('again', { speak: true })).json();
      assert.ok(!('speech' in next), 'while the voice is down nothing is staged');
      assert.equal((await app.status()).json().voice, false);
      assert.equal(next.aiOn, true);
    } finally {
      await app.stop();
    }
  });

  test('the setting TERUBOT_VOICE: a name, off, a typo', () => {
    const load = (value) => loadSettings('/nonexistent.env', value === undefined ? {} : { TERUBOT_VOICE: value }, '/tmp');
    assert.equal(load().terubot.voice, 'Aoede');
    assert.equal(load('kore').terubot.voice, 'Kore');
    assert.equal(load('off').terubot.voice, '');
    const bad = load('../x');
    assert.equal(bad.terubot.voice, 'Aoede');
    assert.ok(bad.warnings.some((w) => /TERUBOT_VOICE/.test(w)));
    assert.ok(describeSettings(load()).some((l) => /TeruBot voice: Google Chirp 3 HD, speaker Aoede/.test(l)));
    assert.ok(describeSettings(load('off')).some((l) => /TeruBot voice: the browser/.test(l)));
  });

  test('the hand-written pages may play the audio (media-src), and nothing wider', () => {
    const csp = pageCsp('<html><body></body></html>');
    assert.match(csp, /media-src 'self' blob:(;|$)/);
    assert.match(csp, /default-src 'none'/);
  });
});
