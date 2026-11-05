/**
 * A stand-in for TeruBot's Gemini connection (server/lib/terubot/gemini.js) that follows a script, so the loop, the tools, the validation
 * and the limits can be tested without Google. It answers exactly as the real one's `generate()` does: {text, calls, content, finishReason,
 * blocked, usage, model}. It keeps every request it was given, for the tests to look at.
 *
 *   const fake = createFakeGemini([
 *     { calls: [{ name: 'search_materials', args: { query: 'bronze' } }] },   // round 1: the model asks for a tool
 *     { text: 'Here you go.' },                                                // round 2: the answer
 *   ]);
 *
 * A step may also be a function of the request, or {error: GeminiError}. Past the end of the script the last step repeats.
 */
import { GeminiError } from '../../server/lib/terubot/gemini.js';

export function createFakeGemini(script = [{ text: 'Hello.' }], { configured = true, model = 'gemini-fake-1', problem = '' } = {}) {
  const requests = [];
  const state = { configured, model, problem, delayMs: 0 };
  let n = 0;
  return {
    requests,
    state,
    /** the tool results (functionResponse parts) the model was given in the latest request, by tool name */
    lastToolResults() {
      const last = requests.at(-1);
      const out = {};
      for (const content of last?.contents ?? []) for (const part of content.parts) if (part.functionResponse) out[part.functionResponse.name] = part.functionResponse.response;
      return out;
    },
    describe: () => ({ configured: state.configured, problem: state.problem, model: state.model }),
    async generate(request) {
      requests.push({ ...request, contents: structuredClone(request.contents) });
      if (state.delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, state.delayMs);
          request.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new GeminiError(request.timedOut?.() ? 'timeout' : 'aborted', 'The request was cut off.'));
          }, { once: true });
        });
      }
      let step = script[Math.min(n, script.length - 1)];
      n += 1;
      if (typeof step === 'function') step = await step(request, n);
      if (step.error) throw step.error;
      const calls = (step.calls ?? []).map((c, i) => ({ id: c.id ?? `call-${n}-${i}`, name: c.name, args: c.args ?? {} }));
      const parts = [...(step.text ? [{ text: step.text }] : []), ...calls.map((c) => ({ functionCall: { id: c.id, name: c.name, args: c.args }, thoughtSignature: `sig-${n}` }))];
      return {
        text: step.text ?? '',
        calls,
        content: parts.length ? { role: 'model', parts } : null,
        finishReason: step.finishReason ?? 'STOP',
        blocked: step.blocked ?? null,
        usage: { prompt: 100, output: 20, thoughts: 0 },
        model: step.model ?? state.model,
      };
    },
  };
}
