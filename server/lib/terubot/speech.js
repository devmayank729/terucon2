/**
 * What TeruBot says aloud, as text: the step before Google's voice (server/lib/terubot/voice.js).
 *
 * A reply on the screen is written for eyes. Read out as it is, it goes wrong in ways that were measured against Google's Chirp 3 HD voices
 * (Hindi and Indian English), not guessed:
 *   - "6,020" and "1,25,000" are read digit by digit ("six zero two zero"); the same numbers without the commas are read as numbers;
 *   - a Hindi voice reads an English reply's numbers in Hindi ("छह हज़ार बीस"), so English goes to the English voice;
 *   - Roman-script Hindi ("Yeh sheet aapke kitchen ke liye achhi hai") is read correctly by the HINDI voice, which also reads the English
 *     words in it; so Devanagari and Roman Hinglish both go to the Hindi voice;
 *   - the brand name came out as Terrobot / Terrabot / Tarubot, and codes such as SB804 are better spelled out.
 * This file does only text: what is spoken, in which language, in which pieces. It calls nobody. A piece is at most a few sentences, the
 * first one short so that sound starts quickly, and the whole is cut after SPEECH_MAX_CHARS (the whole answer stays on the screen).
 */

/** Spoken text, at most this long; past it the rest is "on your screen". */
export const SPEECH_MAX_CHARS = 420;
const PIECE_MAX = 240;
const SHORT_OPENING = 30;
const FIRST_MAX = 160;

export const HELLO_TEXT = 'Hi, I’m TeruBot. How can I help?';

const DEVANAGARI = /[ऀ-ॿ]/;
const STOP = '[.!?।॥]'; // the Hindi full stop (danda) ends a sentence too

/** Spoken lines of TeruBot's own, by the language of the reply. */
const LINES = {
  en: { rest: 'The rest is on your screen.', options: 'I have put the options on your screen.' },
  hi: { rest: 'बाकी जानकारी आपकी स्क्रीन पर है।', options: 'मैंने विकल्प आपकी स्क्रीन पर रख दिए हैं।' },
};

/**
 * Hindi words written in Roman letters that are not English words. Words that are also English (main, to, do, par, hi, fir, the) are left
 * out on purpose: one of them is not enough to call a sentence Hinglish.
 */
const HINGLISH = new Set((
  'hai hain hoon tha thi thay hoga hogi honge hota hoti hote kya kyun kyon kyunki kaise kaisa kaisi kab kahan kaun kitna kitni kitne ' +
  'kis kisi koi aap aapka aapki aapke aapko aapse aapne mera meri mere mujhe mujhko hum humara humari hamara tum tumhara tumhari ' +
  'yeh ye woh iska iski iske isko isme isse uska uski uske usko unka unki inka inki yahan yaha wahan waha aur ya lekin magar isliye toh ' +
  'nahi nahin ka ki ke ko mein liye wala wali wale accha achha acha achhi achhe theek thik bahut bohot thoda thodi zyada jyada abhi kal aaj ' +
  'parso baad pehle phir karna karo kare karein kijiye kijie dijiye dijie dena dene lena lene batao bataiye batana dekho dekhiye dekhna ' +
  'chahiye chahte chahta chahti chahenge sakte sakta sakti sakein milega milegi milenge raha rahi rahe rahega rahegi rahenge gaya gayi gaye ' +
  'namaste namaskar shukriya dhanyavad dhanyawad bilkul zaroor zarur jaroor haan haanji sahi galat kuch kuchh sab sabhi lagta lagti lagega ' +
  'lagegi pasand kimat qeemat daam ghar kamra rasoi dukaan paise rupaye bhi sirf agar'
).split(/\s+/));

/** Is this Latin-script text Roman Hindi (Hinglish)? Two Hindi words, or a very short text that has one. */
export function isHinglish(text) {
  const words = String(text ?? '').toLowerCase().match(/[a-z]+/g) ?? [];
  if (!words.length) return false;
  let hits = 0;
  for (const word of words) if (HINGLISH.has(word)) hits += 1;
  return hits >= 2 || (hits >= 1 && words.length <= 5);
}

/** 'hi' for Devanagari or Roman Hinglish, otherwise 'en'. */
export function detectLanguage(text) {
  const t = String(text ?? '');
  return DEVANAGARI.test(t) || isHinglish(t) ? 'hi' : 'en';
}

/** Spoken forms of units, per script. */
const WORDS = {
  latin: { rupees: 'rupees', per: 'per', sqft: 'square feet', sqftOne: 'square foot', sqm: 'square metres', sqmOne: 'square metre', mm: 'millimetres', cm: 'centimetres', kg: 'kilograms', by: 'by', times: 'times', percent: 'percent', and: 'and' },
  deva: { rupees: 'रुपये', per: 'प्रति', sqft: 'वर्ग फुट', sqftOne: 'वर्ग फुट', sqm: 'वर्ग मीटर', sqmOne: 'वर्ग मीटर', mm: 'मिलीमीटर', cm: 'सेंटीमीटर', kg: 'किलोग्राम', by: 'बाय', times: 'गुना', percent: 'प्रतिशत', and: 'और' },
};

/** Letters read one by one, and brand names respelled. The brand spellings are a guess at the intended sound: change them here. */
const SPELL = ['ACP', 'BOQ', 'PVC', 'MDF', 'HPL', 'WPC', 'GST', 'SKU', 'TIPL'];
const RESPELL = [[/\bTeruBot\b/gi, 'Teru Bot']];

const spaced = (s) => s.split('').join(' ');

/** Text for the ear: no pictures, no markup, numbers and units in a form the voice reads well. */
export function cleanForSpeech(input, { script = null } = {}) {
  let t = String(input ?? '').normalize('NFC').slice(0, 6000);
  const deva = script ? script === 'deva' : DEVANAGARI.test(t);
  const w = deva ? WORDS.deva : WORDS.latin;
  t = t.replace(/[\p{Extended_Pictographic}︎️]/gu, ' '); // emoji are read out as their names, or not at all
  t = t.replace(/(?<![ऀ-ॿ])‍|‍(?![ऀ-ॿ])/g, '');
  t = t.replace(/https?:\/\/\S+/gi, ' '); // addresses are not read out
  t = t.replace(/(^|\s)\/[A-Za-z0-9]\S*/g, '$1'); // nor are paths of this site (/materials#/p/teak)
  t = t.replace(/^\s*[-•·]\s+/gm, ''); // list bullets
  t = t.replace(/[*_`#>~|]+/g, ' '); // markdown marks
  // 6,020 and 1,25,000 -> 6020 and 125000: the voices read the comma form digit by digit
  t = t.replace(/\d{1,3}(?:,\d{2,3})+(?:\.\d+)?/g, (m) => m.replace(/,/g, ''));
  // money
  t = t.replace(/(?:₹|\bRs\.?|\bINR)\s?(\d+(?:\.\d+)?)/gi, `$1 ${w.rupees}`);
  t = t.replace(/(\d|रुपये|rupees)\s*\/\s*(?=[A-Za-zऀ-ॿ])/g, `$1 ${w.per} `);
  // sizes and units
  // "sq. ft." keeps its last point only when it ends the sentence ("per sq. ft. and ..." must not)
  const dot = '(?:\\.(?=\\s+[a-z0-9,;)]))?';
  t = t.replace(new RegExp(`\\bper\\s+sq\\.?\\s?ft\\b${dot}`, 'gi'), `${w.per} ${w.sqftOne}`).replace(new RegExp(`\\bper\\s+sq\\.?\\s?m\\b${dot}`, 'gi'), `${w.per} ${w.sqmOne}`);
  t = t.replace(new RegExp(`\\bsq\\.?\\s?ft\\b${dot}`, 'gi'), w.sqft).replace(new RegExp(`\\bsq\\.?\\s?m\\b${dot}`, 'gi'), w.sqm).replace(/\bsqft\b/gi, w.sqft);
  t = t.replace(/(\d)\s*[x×]\s*(?=\d)/gi, `$1 ${w.by} `);
  t = t.replace(/×/g, ` ${w.times} `);
  t = t.replace(/(\d)\s?mm\b/g, `$1 ${w.mm}`).replace(/(\d)\s?cm\b/g, `$1 ${w.cm}`).replace(/(\d)\s?kg\b/g, `$1 ${w.kg}`);
  t = t.replace(/(\d)\s?%/g, `$1 ${w.percent}`);
  // codes such as SB804 or TIPL-SB804 are said letter by letter and digit by digit
  t = t.replace(/\b(?:[A-Z]{1,6}-)*[A-Z]{1,6}-?\d{2,6}[A-Z]?\b/g, (code) => code.split('-').filter(Boolean).map(spaced).join(', '));
  for (const word of SPELL) t = t.replace(new RegExp(`\\b${word}\\b`, 'g'), spaced(word));
  for (const [pattern, spoken] of RESPELL) t = t.replace(pattern, spoken);
  t = t.replace(/&/g, ` ${w.and} `).replace(/(?<=[A-Za-z])\/(?=[A-Za-z])/g, ' ');
  t = t.replace(/(?<=[A-Za-z])-(?=[A-Za-z])/g, ' '); // wire-cut, bronze-earth: a hyphen inside a word is read as a hyphen (or not at all)
  t = t.replace(/[–—]/g, ', ').replace(/\s*\n+\s*/g, '. ').replace(/\s+/g, ' ').replace(/\s+([,;:.!?\u0964\u0965])/g, '$1');
  t = t.replace(/([:;,])\s*\./g, '$1').replace(new RegExp(`(${STOP})(\\s*${STOP})+`, 'g'), '$1').trim();
  return t;
}

/** Sentences, each with its own ending. A point between digits, or after e.g. / i.e. / etc., does not end one. */
export function splitSentences(text) {
  const keep = String(text ?? '').replace(/(\d)\.(?=\d)/g, '$1\u0001').replace(/\b(?:e\.g|i\.e|etc|vs|approx|incl)\./gi, (m) => m.replace(/\./g, '\u0002'));
  const pieces = keep.match(new RegExp(`[^.!?।॥]+(?:${STOP}+|$)`, 'g')) ?? [keep];
  return pieces.map((s) => s.replace(/\u0001/g, '.').replace(/\u0002/g, '.').trim()).filter(Boolean);
}

/** A sentence longer than `max` is said in pieces, at a comma, else at a space. */
function breakLong(sentence, max) {
  const out = [];
  let rest = sentence;
  while (rest.length > max) {
    let at = rest.lastIndexOf(', ', max);
    if (at < 40) at = rest.lastIndexOf(' ', max);
    if (at < 40) at = max;
    out.push(rest.slice(0, at + 1).trim());
    rest = rest.slice(at + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * The plan for a reply: pieces to say, each with the language of its voice.
 * @param {object} reply
 * @param {string} reply.text the reply as shown
 * @param {boolean} [reply.hasCards] whether there are cards (a reply with cards and no words is announced)
 * @param {string} [reply.hint] the visitor's last message: the language of a reply that has no words
 * @returns {{lang: 'en' | 'hi', parts: {text: string, lang: 'en' | 'hi'}[]}}
 */
export function planSpeech({ text, hasCards = false, hint = '' }) {
  const shown = String(text ?? '');
  const lang = shown.trim() ? (DEVANAGARI.test(shown) ? 'hi' : isHinglish(shown) ? 'hi' : 'en') : detectLanguage(hint);
  const lines = LINES[lang];
  const spoken = cleanForSpeech(shown, { script: DEVANAGARI.test(shown) ? 'deva' : 'latin' });
  if (!spoken) {
    return hasCards ? { lang, parts: [{ text: lines.options, lang }] } : { lang, parts: [] };
  }
  const sentences = [];
  for (const s of splitSentences(spoken)) for (const piece of breakLong(s, 200)) sentences.push(piece);
  // the first sentence goes out alone, so that sound starts sooner; the rest are packed into pieces of a few sentences
  const parts = [];
  let total = 0;
  let cut = false;
  for (let i = 0; i < sentences.length; i += 1) {
    const sentence = sentences[i];
    if (i > 0 && total + sentence.length > SPEECH_MAX_CHARS) { cut = true; break; }
    total += sentence.length + 1;
    const last = parts.length > 1 ? parts.length - 1 : -1;
    if (i === 0) parts.push(sentence);
    else if (parts.length === 1 && parts[0].length < SHORT_OPENING && parts[0].length + 1 + sentence.length <= FIRST_MAX) parts[0] = `${parts[0]} ${sentence}`; // "Namaste!" is not worth a request of its own
    else if (last > 0 && parts[last].length + 1 + sentence.length <= PIECE_MAX) parts[last] = `${parts[last]} ${sentence}`;
    else parts.push(sentence);
  }
  const out = parts.map((p) => ({ text: p, lang: DEVANAGARI.test(p) ? 'hi' : lang }));
  if (cut) out.push({ text: lines.rest, lang });
  return { lang, parts: out };
}

/** The fixed greeting, said when a live conversation starts. English: the visitor has not said anything yet. */
export function helloPlan() {
  return { lang: 'en', parts: [{ text: cleanForSpeech(HELLO_TEXT, { script: 'latin' }), lang: 'en' }] };
}
