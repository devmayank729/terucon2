#!/usr/bin/env node
/**
 * Makes a short clip of each candidate voice for TeruBot, in English, Hindi and Hinglish, so a person can listen and choose TERUBOT_VOICE.
 *
 *   node tools/voice-samples.mjs                          the default shortlist
 *   node tools/voice-samples.mjs Aoede,Kore,Puck           these voices
 *   node tools/voice-samples.mjs --out ~/Desktop/voices    where to write (default: <temp folder>/terucon-voice-samples)
 *
 * It writes one MP3 per voice and language and an index.html with a player for each. It calls Google Cloud Text-to-Speech with the same key as
 * the chat (swatchroom/.env), through the same text preparation as the live voice (server/lib/terubot/speech.js), so what you hear is what a
 * visitor would. Google bills Text-to-Speech per character spoken (a few hundred characters per voice here). The Text-to-Speech API must be enabled.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { planSpeech } from '../server/lib/terubot/speech.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = path.resolve(outAt >= 0 ? args[outAt + 1] : path.join(os.tmpdir(), 'terucon-voice-samples'));
const names = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out')[0];
const VOICES = (names ? names.split(',') : ['Aoede', 'Kore', 'Leda', 'Sulafat', 'Achernar', 'Puck', 'Charon', 'Orus']).map((v) => v.trim()).filter((v) => /^[A-Za-z]{3,24}$/.test(v));
const LINES = [
  ['English', 'Hi, I’m TeruBot. This SuperBond sheet, SB804, is 1220 × 2440 mm and costs about ₹6,020 a sheet. Would you like to see similar designs?'],
  ['Hindi', 'नमस्ते, मैं टेरूबॉट हूँ। यह शीट आपके किचन के लिए बहुत अच्छी रहेगी, और इसकी कीमत लगभग ₹6,020 प्रति शीट है। क्या आप और डिज़ाइन देखना चाहेंगे?'],
  ['Hinglish', 'Namaste, main TeruBot hoon. Yeh sheet aapke kitchen ke liye bahut achhi rahegi, aur iska price around ₹6,020 per sheet hai. Kya aap similar designs dekhna chahenge?'],
];

if (!fs.existsSync(path.join(root, 'swatchroom', 'server', 'google', 'token.js'))) {
  console.error('The Google connection (swatchroom/server/google) is not part of this installation.');
  process.exit(1);
}
const need = createRequire(path.join(root, 'swatchroom', 'server', 'google', 'token.js'));
const token = need('./token.js');
if (!token.describe().configured) {
  console.error('No Google key is set up (GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_JSON in swatchroom/.env).');
  process.exit(1);
}

fs.mkdirSync(out, { recursive: true });
const html = ['<!doctype html><meta charset="utf-8"><title>TeruBot voices</title><style>body{font:16px system-ui;max-width:760px;margin:2rem auto;padding:0 1rem}h2{margin-top:2rem}audio{display:block;margin:.3rem 0 .9rem;width:100%}small{color:#666}</style><h1>TeruBot voices</h1><p>Set the one you like in <code>.env</code> as <code>TERUBOT_VOICE=Name</code>.</p>'];
const bearer = await token.getToken();
for (const voice of VOICES) {
  html.push(`<h2>${voice}</h2>`);
  for (const [label, text] of LINES) {
    const plan = planSpeech({ text });
    const clips = [];
    for (const part of plan.parts) {
      const locale = part.lang === 'hi' ? 'hi-IN' : 'en-IN';
      const response = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { text: part.text }, voice: { languageCode: locale, name: `${locale}-Chirp3-HD-${voice}` }, audioConfig: { audioEncoding: 'MP3' } }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json.audioContent) {
        const reason = [json?.error?.status, ...(json?.error?.details ?? []).map((d) => d?.reason)].filter(Boolean).join(' ');
        console.error(`${voice} / ${label}: Google answered ${response.status} ${reason}`);
        if (response.status === 403) console.error('The Cloud Text-to-Speech API is probably not enabled for the project of this key.');
        clips.length = 0;
        break;
      }
      clips.push(Buffer.from(json.audioContent, 'base64'));
    }
    if (!clips.length) continue;
    const file = `${voice}-${label}.mp3`;
    fs.writeFileSync(path.join(out, file), Buffer.concat(clips)); // MP3 frames can simply follow one another
    html.push(`<div><b>${label}</b> <small>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</small><audio controls preload="none" src="${file}"></audio></div>`);
    console.log(`${voice} / ${label}: ${file}`);
  }
}
fs.writeFileSync(path.join(out, 'index.html'), html.join('\n'));
console.log(`\nOpen ${path.join(out, 'index.html')} to listen.`);
