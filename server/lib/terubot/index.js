/**
 * TeruBot, put together: the shop's data, the site map, the Gemini connection, the limits. The web side (who is asking, the JSON in and
 * out, the status codes) is server/routes/terubot.js; the work of one answer is chat.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChat } from './chat.js';
import { createGemini } from './gemini.js';
import { createImageResolver } from './images.js';
import { createLimits } from './limits.js';
import { loadShop } from './shop.js';

export const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));

/** The enquiry form's choices (server/data/enquiry-form.json, written by tools/extract-products.js). */
export function loadForm(dir = DATA_DIR) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'enquiry-form.json'), 'utf8'));
  return { types: raw.types, timelines: raw.timelines, areas: raw.areas, fields: raw.fields };
}

/** What the visitor is told when the assistant cannot answer, by reason. Plain, short, and it always names something that still works. */
export const OFF_REPLY = {
  setting: 'The assistant is switched off on this site right now. You can still browse the pages, and send an enquiry on the Start a project page.',
  'not-configured': "The assistant isn't set up on this site yet. You can still browse the pages, and send an enquiry on the Start a project page.",
  unreachable: "The assistant can't be reached right now. Please try again in a little while, or send an enquiry on the Start a project page.",
};

/**
 * @param {object} options
 * @param {() => object} options.settings the website's settings, read on every use
 * @param {*} options.site the SiteMap
 * @param {{dir: string} | null} options.dist
 * @param {{info: Function, warn: Function}} options.log
 * @param {string} options.googleDir the folder that holds server/google/vertex.js
 * @param {object} [options.overrides] tests: gemini (a fake with describe() and generate()), shop, form, now
 */
export function createTerubot({ settings, site, dist, log, googleDir, overrides = {} }) {
  const shop = overrides.shop ?? loadShop();
  const form = overrides.form ?? loadForm();
  const images = createImageResolver(dist);
  const gemini = overrides.gemini ?? createGemini({ googleDir, settings, log });
  const limits = createLimits({ limits: () => settings().terubot, now: overrides.now });

  return {
    shop,
    form,
    limits,

    /** Whether the assistant can answer at all: {on: true, model} or {on: false, reason: 'setting' | 'not-configured', problem}. Calls nobody. */
    state() {
      if (!settings().terubot.enabled) return { on: false, reason: 'setting', problem: 'switched off with TERUBOT=off', model: null };
      const g = gemini.describe();
      if (!g.configured) return { on: false, reason: 'not-configured', problem: g.problem, model: null };
      return { on: true, reason: null, problem: '', model: g.model };
    },

    /** One answer. Throws GeminiError (gemini.js) when the model cannot be used. */
    answer({ messages, context, account, catalogue, signal, timedOut }) {
      const t = settings().terubot;
      return runChat({ messages, context, account, catalogue, signal, timedOut, deps: { shop, site, form, images, gemini, maxRounds: t.toolRounds, log } });
    },

    close() {
      limits.close();
    },
  };
}
