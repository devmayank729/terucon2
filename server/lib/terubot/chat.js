/**
 * One chat turn: the visitor's messages in, a reply with cards and actions out.
 *
 * The loop. The model is called with the conversation and the tool declarations. If it asks for tools, the server runs them (they are
 * data look-ups and builders of checked browser actions: tools.js), appends the model's own turn UNCHANGED and one user turn holding
 * every tool result in the order asked, and calls the model again. At most `maxRounds` rounds of tools; the call after the last round
 * has the tools switched off (mode NONE), so the model has to answer in words. One AbortController (made by the route) bounds the whole
 * turn.
 *
 * Nothing the model writes reaches the browser except as `reply` (cleaned to plain text), `cards` (made from the shop's data by the data
 * tools) and `actions` (rebuilt and re-checked by actions.js).
 */
import { cleanBlock } from './actions.js';
import { contextBlock } from './input.js';
import { buildSystemPrompt } from './prompt.js';
import { createToolbox } from './tools.js';

const MAX_REPLY = 1800;
const MAX_PARALLEL = 8;

/** What a model's text becomes for the widget: plain text, no markup, no links. */
export function plainReply(text) {
  let t = String(text ?? '');
  t = t.replace(/<[^>]*>/g, ''); // HTML tags
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1'); // [label](address) -> label
  t = t.replace(/\b(?:https?|ftp):\/\/\S+/gi, '').replace(/\b(?:javascript|vbscript|data):\S*/gi, '').replace(/\bwww\.\S+/gi, '');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, ''); // headings
  t = t.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2'); // bold
  t = t.replace(/(^|[\s(])\*(?=\S)([^*\n]*?\S)\*(?=[\s).,;:!?]|$)/g, '$1$2'); // italic
  t = t.replace(/^\s*[*•·]\s+/gm, '- '); // bullets
  t = t.replace(/`+/g, '');
  t = t.replace(/[ \t]+([.,;:!?])/g, '$1');
  return cleanBlock(t, MAX_REPLY);
}

const FALLBACK = {
  empty: "Sorry, I couldn't put an answer together for that. Could you ask it another way?",
  blocked: "I can't help with that one. I can help with Terucon's materials, services and website.",
  actionOnly: 'Okay, here you go.',
  cardsOnly: "Here's what I found.",
};

/**
 * @param {object} p
 * @param {{role: 'user' | 'assistant', text: string}[]} p.messages
 * @param {ReturnType<typeof import('./input.js').parseContext>} p.context
 * @param {{signedIn: boolean, firstName?: string, studioRooms?: () => Promise<number | null>}} p.account
 * @param {{on: boolean, search?: Function}} p.catalogue
 * @param {object} p.deps {shop, site, form, images, gemini, maxRounds, log}
 * @param {AbortSignal} p.signal
 * @param {() => boolean} p.timedOut
 */
export async function runChat({ messages, context, account, catalogue, deps, signal, timedOut }) {
  const { shop, site, form, images, gemini, maxRounds, log } = deps;
  const visitorText = messages.filter((m) => m.role === 'user').map((m) => m.text).join('\n');
  const toolbox = createToolbox({ shop, site, form, images, account, catalogue, visitorText, log });
  const system = buildSystemPrompt({ shop, site, signedIn: account.signedIn, catalogueOn: Boolean(catalogue?.on) });

  const contents = messages.map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] }));
  const block = contextBlock(context);
  if (block) contents.at(-1).parts.unshift({ text: block });

  let model = null;
  let rounds = 0;
  const usage = { prompt: 0, output: 0, thoughts: 0 };
  let answer;
  for (;;) {
    const last = rounds >= maxRounds;
    answer = await gemini.generate({ system, contents, tools: toolbox.declarations, toolMode: last ? 'NONE' : 'AUTO', signal, timedOut });
    model = answer.model ?? model;
    for (const k of Object.keys(usage)) usage[k] += answer.usage?.[k] ?? 0;
    if (!answer.calls.length || last || !answer.content) break;
    rounds += 1;
    contents.push(answer.content); // the model's own turn, exactly as it came
    const responses = [];
    for (const [i, call] of answer.calls.entries()) {
      // every call gets an answer (the model expects one each), but only the first MAX_PARALLEL are run
      const result = i < MAX_PARALLEL ? await toolbox.run(call.name, call.args) : { error: 'Too many tool calls at once. Ask again if you still need this.' };
      responses.push({ functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response: result && typeof result === 'object' && !Array.isArray(result) ? result : { result } } });
    }
    contents.push({ role: 'user', parts: responses });
  }

  const cards = toolbox.cards();
  const actions = toolbox.actions();
  let reply = plainReply(answer.text);
  if (!reply) reply = answer.blocked ? FALLBACK.blocked : actions.length ? FALLBACK.actionOnly : cards.length ? FALLBACK.cardsOnly : FALLBACK.empty;
  return { reply, cards, actions, model, rounds, toolsUsed: toolbox.used, usage, finishReason: answer.finishReason };
}
