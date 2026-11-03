/**
 * TeruBot's connection to Gemini on Vertex AI.
 *
 * The Design Studio already has a working one: swatchroom/server/google/{token,vertex}.js (a service-account key traded for an access
 * token, a model fallback chain, retries on quota and temporary errors). It is loaded here, not edited and not copied, with
 * createRequire, the way server/lib/swatchroom.js loads the studio. Because it is the same module the studio uses, the credentials are
 * the studio's (GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_CLOUD_PROJECT, VERTEX_LOCATION in the environment or
 * swatchroom/.env), the token is shared, and the studio may be mounted or not: TeruBot works either way.
 *
 * What vertex.js does with a request (read before relying on it):
 *   - `callModel(request, bodiesFor)` POSTs `bodiesFor(model)[i]` as JSON to `.../models/<model>:generateContent`, unchanged, so
 *     systemInstruction, tools, toolConfig and generationConfig reach Vertex as written.
 *   - A 400 moves on to the NEXT body variant: every variant below keeps the system instruction and the tools and drops only the thinking
 *     setting, so a model that rejects "thinkingLevel" still answers WITH its tools.
 *   - A 404 moves on to the next model of its chain (the chain starts at the model asked for if it is one of its own: gemini-3.8-flash ...).
 *   - 429 and 5xx are retried twice (after 1.5 s and 4 s). The `signal` aborts all of it, the waits included, so one AbortController per
 *     chat request bounds the whole turn.
 *   - It resolves to {response: <the Vertex JSON>, attempt, model: <the id that answered>}; failures are VertexError (.status, .message in
 *     plain language) or, from token.js, a plain Error. Their messages can name the project, so they go to the server log only.
 *
 * Loading studio's config.js runs dotenv on swatchroom/.env: createApp takes its snapshot of the environment first, so those settings
 * never become the website's.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

/** @typedef {'unavailable' | 'timeout' | 'aborted' | 'upstream'} GeminiErrorKind */
export class GeminiError extends Error {
  /** @param {GeminiErrorKind} kind @param {string} message plain language, for the log */
  constructor(kind, message, status = 0) {
    super(message);
    this.name = 'GeminiError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * The request bodies to try for one model, simplest last. Every one has the system instruction, the tools and the tool mode.
 * Gemini 3.x takes a thinking LEVEL (and has no temperature); Gemini 2.x a thinking budget and a temperature.
 */
export function makeBodies(model, { system, contents, tools, toolMode, maxOutputTokens }, legacy) {
  const base = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    ...(tools?.length ? { tools: [{ functionDeclarations: tools }], toolConfig: { functionCallingConfig: { mode: toolMode } } } : {}),
  };
  const plain = { maxOutputTokens };
  return legacy
    ? [{ ...base, generationConfig: { ...plain, temperature: 0.4, thinkingConfig: { thinkingBudget: 0 } } }, { ...base, generationConfig: plain }]
    : [{ ...base, generationConfig: { ...plain, thinkingConfig: { thinkingLevel: 'LOW' } } }, { ...base, generationConfig: plain }];
}

/** The parts of a Vertex answer that the chat loop needs. */
export function readAnswer(response) {
  const candidate = response?.candidates?.[0];
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const text = parts.filter((p) => typeof p?.text === 'string' && p.thought !== true).map((p) => p.text).join('');
  const calls = parts
    .filter((p) => p?.functionCall && typeof p.functionCall.name === 'string')
    .map((p) => ({ id: p.functionCall.id, name: p.functionCall.name, args: p.functionCall.args && typeof p.functionCall.args === 'object' ? p.functionCall.args : {} }));
  const usage = response?.usageMetadata ?? {};
  return {
    text,
    calls,
    // kept exactly as received: Gemini 3.x attaches signatures to the parts that must go back unchanged with the tool results
    content: parts.length ? { role: 'model', parts } : null,
    finishReason: candidate?.finishReason ?? null,
    blocked: response?.promptFeedback?.blockReason ?? null,
    usage: { prompt: usage.promptTokenCount ?? 0, output: usage.candidatesTokenCount ?? 0, thoughts: usage.thoughtsTokenCount ?? 0 },
  };
}

/**
 * @param {object} options
 * @param {string} options.googleDir the folder that holds server/google/vertex.js (the studio: <root>/swatchroom)
 * @param {() => {terubot: {model: string, maxOutputTokens: number}}} options.settings
 * @param {{warn: Function}} [options.log]
 */
export function createGemini({ googleDir, settings, log }) {
  let loaded = null; // {vertex, token, config} | {error}

  function load() {
    if (loaded) return loaded;
    const vertexFile = path.join(path.resolve(googleDir), 'server', 'google', 'vertex.js');
    if (!fs.existsSync(vertexFile)) {
      loaded = { error: 'The Google connection (swatchroom/server/google) is not part of this installation.' };
      return loaded;
    }
    try {
      const need = createRequire(vertexFile);
      loaded = { vertex: need(vertexFile), token: need('./token.js'), config: need('../config.js') };
    } catch (error) {
      log?.warn?.(`terubot  could not load the Google connection: ${String(error?.message ?? error).slice(0, 160)}`);
      loaded = { error: 'The Google connection could not be loaded.' };
    }
    return loaded;
  }

  const modelName = () => settings().terubot.model || load().vertex?.TEXT_MODEL_CHAIN?.[0] || null;

  return {
    /** Whether a Google key (or the machine's own identity) is set up. Reads settings only; never calls Google. */
    describe() {
      const g = load();
      if (g.error) return { configured: false, problem: g.error, model: null };
      const d = g.token.describe();
      return { configured: Boolean(d.configured && (g.config.google.projectId || d.kind === 'metadata')), problem: d.problem || (d.configured ? '' : 'No Google key is set up.'), model: modelName() };
    },

    /**
     * One model turn.
     * @param {object} p
     * @param {string} p.system
     * @param {object[]} p.contents
     * @param {object[]} p.tools function declarations
     * @param {'AUTO' | 'NONE'} p.toolMode
     * @param {AbortSignal} p.signal
     * @param {() => boolean} [p.timedOut] whether `signal` fired because the deadline passed (else the visitor left)
     */
    async generate({ system, contents, tools, toolMode, signal, timedOut = () => false }) {
      const g = load();
      if (g.error) throw new GeminiError('unavailable', g.error);
      const { vertex, config } = g;
      const maxOutputTokens = settings().terubot.maxOutputTokens;
      let result;
      try {
        result = await vertex.callModel({ model: modelName(), location: config.google.location, signal }, (m) => makeBodies(m, { system, contents, tools, toolMode, maxOutputTokens }, vertex.isLegacyModel(m)));
      } catch (error) {
        throw classify(error, signal, timedOut);
      }
      return { ...readAnswer(result.response), model: result.model };
    },
  };
}

/** A failure of the Google call -> the kind the route answers by. */
function classify(error, signal, timedOut) {
  if (error?.name === 'AbortError' || signal?.aborted) return new GeminiError(timedOut() ? 'timeout' : 'aborted', 'The request was cut off.');
  const message = String(error?.message ?? error).slice(0, 240);
  const status = Number.isInteger(error?.status) ? error.status : 0;
  if (error?.name === 'VertexError') {
    if (status === 429 || status >= 500 || status === 400) return new GeminiError('upstream', message, status);
    // 0 (no network, no project), 401, 403 (key, role, API off, billing), 404 (no model): the set-up is wrong or Google is not reachable
    return new GeminiError('unavailable', message, status);
  }
  // token.js: no key, a key Google rejects, or no way to reach Google to sign in
  return new GeminiError('unavailable', message);
}
