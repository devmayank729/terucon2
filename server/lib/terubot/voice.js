/**
 * TeruBot's voice: Google Cloud Text-to-Speech (Chirp 3 HD voices), in place of the browser's own speech.
 *
 * What a visitor can and cannot ask for. There is no "say this" endpoint: a reply that TeruBot has just written is STAGED here (stage()), with
 * the pieces it will be said in (server/lib/terubot/speech.js), and the browser then asks for piece n of staged reply <id>. Nobody can have
 * text of their own read out, so the chat limits (limits.js) are also the limits of this voice. The one fixed phrase, the greeting, is
 * `hello`: it is synthesised once and kept.
 *
 * Google: POST https://texttospeech.googleapis.com/v1/text:synthesize with the studio's own access token (the same service account as the
 * chat's Gemini; loaded through gemini.js, not read twice). The voice is `<locale>-Chirp3-HD-<name>`; the locale is hi-IN for Devanagari and
 * Roman Hinglish, en-IN otherwise (why: speech.js). The name is the TERUBOT_VOICE setting (default Aoede); the same name exists in both
 * locales, so the speaker does not change when the language does. Output is MP3.
 *
 * When Google refuses (the Text-to-Speech API is not enabled for the project, the key may not use it, a bad voice name) the voice marks
 * itself down for a few minutes and says so in the log; the status route then reports it off and the browser uses its own speech. A busy or
 * failing moment is retried twice. Logs hold lengths, languages and times, never the words.
 *
 * Kept in memory: staged replies for 15 minutes (at most 300), synthesised audio (at most 16 MB; the same words in the same voice cost
 * nothing the second time), and at most 6 calls to Google at once.
 */
import crypto from 'node:crypto';
import { helloPlan, planSpeech } from './speech.js';

export const HELLO_ID = 'hello';
const ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const STAGE_TTL_MS = 15 * 60 * 1000;
const MAX_STAGED = 300;
const CACHE_BYTES = 16 * 1024 * 1024;
const MAX_IN_FLIGHT = 6;
const CALL_TIMEOUT_MS = 12000;
const MAX_FETCHES_PER_PIECE = 4;
const DOWN_MS = { refused: 5 * 60 * 1000, auth: 60 * 1000 };
const LOCALES = { hi: 'hi-IN', en: 'en-IN' };

/** @typedef {'gone' | 'unavailable' | 'busy' | 'timeout' | 'upstream'} VoiceErrorKind */
export class VoiceError extends Error {
  /** @param {VoiceErrorKind} kind @param {string} message plain language, for the log only */
  constructor(kind, message, status = 0) {
    super(message);
    this.name = 'VoiceError';
    this.kind = kind;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {() => ({token: {getToken: Function, invalidate: Function, describe: Function}} | null)} options.google the studio's Google connection
 * @param {() => {terubot: {enabled: boolean, voice: string}}} options.settings
 * @param {{info: Function, warn: Function}} [options.log]
 * @param {typeof fetch} [options.fetchImpl] tests
 * @param {() => number} [options.now] tests
 * @param {string} [options.endpoint] tests
 */
export function createVoice({ google, settings, log, fetchImpl = fetch, now = Date.now, endpoint = ENDPOINT }) {
  const staged = new Map(); // id -> {parts, expires, fetched: number[]}
  const audio = new Map(); // key -> Buffer, oldest first
  const pending = new Map(); // key -> Promise<Buffer>
  let audioBytes = 0;
  let inFlight = 0;
  let downUntil = 0;
  let hello = null;
  const helloEntry = () => (hello ??= { parts: helloPlan().parts, expires: Infinity, fetched: [] });

  const name = () => settings().terubot.voice;
  const voiceFor = (lang) => `${LOCALES[lang] ?? LOCALES.en}-Chirp3-HD-${name()}`;

  function available() {
    const t = settings().terubot;
    if (!t.enabled || !t.voice || downUntil > now()) return false;
    const g = google();
    if (!g) return false;
    try {
      return Boolean(g.token.describe().configured);
    } catch {
      return false;
    }
  }

  function markDown(kind, why) {
    downUntil = now() + DOWN_MS[kind];
    log?.warn?.(`terubot  voice off for ${Math.round(DOWN_MS[kind] / 60000)} min: ${why}`);
  }

  async function callGoogle(part) {
    const g = google();
    if (!g) throw new VoiceError('unavailable', 'The Google connection is not available.');
    const body = JSON.stringify({
      input: { text: part.text },
      voice: { languageCode: LOCALES[part.lang] ?? LOCALES.en, name: voiceFor(part.lang) },
      audioConfig: { audioEncoding: 'MP3' },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let token;
      try {
        token = await g.token.getToken();
      } catch {
        throw new VoiceError('unavailable', 'No Google access token could be had.');
      }
      let response;
      try {
        response = await fetchImpl(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      } catch (error) {
        if (attempt < 2 && error?.name !== 'TimeoutError') {
          await sleep(400);
          continue;
        }
        throw new VoiceError(error?.name === 'TimeoutError' ? 'timeout' : 'upstream', `Google could not be reached (${error?.name ?? 'error'}).`);
      }
      if (response.ok) {
        const json = await response.json().catch(() => ({}));
        const bytes = Buffer.from(typeof json.audioContent === 'string' ? json.audioContent : '', 'base64');
        if (bytes.length < 200) throw new VoiceError('upstream', 'Google answered without audio.');
        return bytes;
      }
      const error = (await response.json().catch(() => ({})))?.error ?? {};
      const reason = [error.status, ...(Array.isArray(error.details) ? error.details.map((d) => d?.reason) : [])].filter((x) => typeof x === 'string').join(' ').slice(0, 80);
      if (response.status === 401 && attempt === 0) {
        g.token.invalidate();
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await sleep(attempt === 0 ? 400 : 1200);
        continue;
      }
      if (response.status === 429) throw new VoiceError('busy', `Google is out of quota or busy (${reason}).`, 429);
      if (response.status >= 500) throw new VoiceError('upstream', `Google answered ${response.status} (${reason}).`, response.status);
      markDown(response.status === 401 ? 'auth' : 'refused', `Google answered ${response.status} ${reason}`.trim());
      throw new VoiceError('unavailable', `Google refused the request: ${response.status} ${reason}`.trim(), response.status);
    }
    throw new VoiceError('upstream', 'Google did not answer.');
  }

  function remember(key, bytes) {
    audio.set(key, bytes);
    audioBytes += bytes.length;
    for (const [oldKey, old] of audio) {
      if (audioBytes <= CACHE_BYTES) break;
      audio.delete(oldKey);
      audioBytes -= old.length;
    }
  }

  /** The audio of one piece: from memory, or one call to Google (shared by everyone asking for the same words at the same moment). */
  async function synth(part) {
    const key = crypto.createHash('sha1').update(`${voiceFor(part.lang)}\n${part.text}`).digest('hex');
    const known = audio.get(key);
    if (known) {
      audio.delete(key); // newest again
      audio.set(key, known);
      return { bytes: known, cached: true };
    }
    let promise = pending.get(key);
    if (!promise) {
      if (inFlight >= MAX_IN_FLIGHT) throw new VoiceError('busy', 'Too many voice calls at once.');
      inFlight += 1;
      promise = callGoogle(part).then((bytes) => { remember(key, bytes); return bytes; }).finally(() => { inFlight -= 1; pending.delete(key); });
      pending.set(key, promise);
    }
    return { bytes: await promise, cached: false };
  }

  function prune() {
    const t = now();
    for (const [id, entry] of staged) if (entry.expires <= t) staged.delete(id);
    while (staged.size >= MAX_STAGED) staged.delete(staged.keys().next().value);
  }

  return {
    available,
    voice: name,

    /**
     * Get a reply ready to be spoken.
     * @returns {{id: string, parts: {text: string, lang: 'en' | 'hi'}[]} | null} null: the voice is off, or there is nothing to say
     */
    stage({ text, hasCards = false, hint = '' }) {
      if (!available()) return null;
      const plan = planSpeech({ text, hasCards, hint });
      if (!plan.parts.length) return null;
      prune();
      const id = crypto.randomBytes(9).toString('base64url');
      staged.set(id, { parts: plan.parts, expires: now() + STAGE_TTL_MS, fetched: [] });
      return { id, parts: plan.parts };
    },

    /** The greeting's id and pieces (the same for everyone). */
    greeting() {
      return { id: HELLO_ID, parts: helloEntry().parts };
    },

    /**
     * The sound of piece `n` of a staged reply.
     * @returns {Promise<{bytes: Buffer, type: string, cached: boolean, lang: string, chars: number}>}
     * @throws {VoiceError}
     */
    async audio(id, n) {
      if (!available()) throw new VoiceError('unavailable', 'The voice is off.');
      let entry = id === HELLO_ID ? helloEntry() : staged.get(id);
      if (!entry || entry.expires <= now()) {
        staged.delete(id);
        entry = null;
      }
      const part = entry?.parts[n];
      if (!part) throw new VoiceError('gone', 'That speech is not there (any more).');
      entry.fetched[n] = (entry.fetched[n] ?? 0) + 1;
      if (id !== HELLO_ID && entry.fetched[n] > MAX_FETCHES_PER_PIECE) throw new VoiceError('gone', 'That piece has been fetched enough times.');
      const { bytes, cached } = await synth(part);
      return { bytes, type: 'audio/mpeg', cached, lang: part.lang, chars: part.text.length };
    },

    /** For tests and the status line: how many replies are waiting, how much audio is kept. */
    stats: () => ({ staged: staged.size, audioBytes, audioPieces: audio.size, inFlight }),
  };
}
