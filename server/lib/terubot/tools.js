/**
 * The tools the model may call: what it can look up, and what it can ask the visitor's browser to do.
 *
 * DATA tools read real data and answer in plain facts: search_materials, get_material, estimate_quantity, site_guide,
 * get_account_summary (signed-in only), catalogue_search (only when the catalogue is switched on).
 * ACTION tools change nothing on the server: they only build an instruction for the browser (navigate, open_studio, cart_add,
 * saved_add, saved_remove, prefill_enquiry), checked by actions.js, and say so in their answer ("queued", never "done").
 *
 * What a tool returns is DATA for the model, never an instruction to it; the system prompt says so. Cards (the product tiles under the
 * reply) are made here from the shop's data, from the products the data tools returned: the model's text can not make a card.
 *
 * A toolbox belongs to one chat request: it carries that request's signed-in account (decided from the cookie by the route, never from
 * anything in the request body), the cards and the actions collected so far, and the caps.
 */
import { cleanText, ENQUIRY_KEYS, checkEnquiryFields, finalActions, LIMITS, MAX_QTY, sanitizeAction, wholeNumber } from './actions.js';
import { destinations, siteGuide } from './site.js';
import { normalise } from './shop.js';

const MAX_CARDS = 6;
const MAX_CALLS = 12;
const MAX_RESULT_CHARS = 12000;

const T = { string: 'STRING', number: 'NUMBER', integer: 'INTEGER', boolean: 'BOOLEAN', object: 'OBJECT', array: 'ARRAY' };

/** The function declarations for Gemini. `catalogueOn` and `signedIn` decide which tools exist at all for this request. */
export function toolDeclarations({ shop, site, form, catalogueOn, signedIn }) {
  const ids = (list) => list.map((x) => x.id);
  const routes = [...destinations(site).keys()];
  const declarations = [
    {
      name: 'search_materials',
      description:
        "Search the Terucon shop's materials (ACP sheets, terracotta, stone, glass, timber and HPL, lime and micro-cement, fixings). Put the materials and looks the visitor named in `query`; put a budget in max_price/min_price (rupees, per unit as listed), not in `query`. Returns the best matches with the shop's listed prices; a card for each appears under your reply, so do not repeat every detail in your text.",
      parameters: {
        type: T.object,
        properties: {
          query: { type: T.string, description: 'Words to match: material, finish, colour, use. Example: "bronze facade", "oak slat panel". Leave out for a plain browse by filter.' },
          category: { type: T.string, enum: ids(shop.categories), description: 'Only this category.' },
          colour: { type: T.string, enum: ids(shop.colours), description: 'Only this colour family.' },
          application: { type: T.string, enum: ids(shop.applications), description: 'Only materials used for this.' },
          performance: { type: T.string, enum: ids(shop.performance), description: 'Only materials with this performance.' },
          max_price: { type: T.number, description: 'Rupees per unit (sheet, pack, bag ...) as the shop lists it.' },
          min_price: { type: T.number, description: 'Rupees per unit as the shop lists it.' },
          in_stock_only: { type: T.boolean, description: 'Leave out variants the shop shows as out of stock.' },
          sort: { type: T.string, enum: ['relevance', 'price_asc', 'price_desc'] },
          limit: { type: T.integer, description: 'How many materials to return, 1 to 6 (default 4).' },
        },
      },
    },
    {
      name: 'get_material',
      description:
        'Everything the shop lists about one material: description, specifications, every finish / thickness / size with its price and availability. `id` is a variant id or product id from search_materials, or from the visitor\'s cart or saved list. A card for it appears under your reply.',
      parameters: { type: T.object, properties: { id: { type: T.string, description: 'A variant id or product id.' } }, required: ['id'] },
    },
    {
      name: 'estimate_quantity',
      description:
        'How many units (sheets, packs, bags ...) cover an area, with 10% wastage unless told otherwise, and what that costs at the shop\'s listed price before GST. Only for materials sold by area. An estimate, not a quote.',
      parameters: {
        type: T.object,
        properties: {
          id: { type: T.string, description: 'A variant id or product id.' },
          area_sqft: { type: T.number, description: 'The area in square feet. For a wall of 40 ft by 12 ft that is 480.' },
          waste_percent: { type: T.number, description: 'Wastage in percent, 0 to 50 (default 10).' },
        },
        required: ['id', 'area_sqft'],
      },
    },
    {
      name: 'site_guide',
      description: 'What each page of the Terucon website does and who can open it. Use it before sending a visitor somewhere, or when they ask what the site offers.',
      parameters: { type: T.object, properties: { route: { type: T.string, enum: routes, description: 'One page only; leave out for all of them.' } } },
    },
    {
      name: 'navigate',
      description:
        'Take the visitor\'s browser to a page of this website, after your reply. Use it when they ask to go somewhere or when showing a page is the best answer. For the materials page you may add `material_id` (opens that material) or `search` (opens the shop search for those words). One move per reply.',
      parameters: {
        type: T.object,
        properties: {
          to: { type: T.string, enum: routes, description: 'The page.' },
          material_id: { type: T.string, description: 'With /materials: open this material (a variant id or product id).' },
          search: { type: T.string, description: 'With /materials: show the shop search for these words.' },
          view: { type: T.string, enum: ['cart', 'saved', 'compare'], description: 'With /materials: open the visitor\'s cart, saved list or compare list.' },
        },
        required: ['to'],
      },
    },
    { name: 'open_studio', description: 'Open the Design Studio (photograph a room, try finishes on it). Same as navigating there; one move per reply.', parameters: { type: T.object, properties: {} } },
    {
      name: 'cart_add',
      description: 'Put a material in the visitor\'s shop cart (in their browser, after your reply). Only when they asked for it. Quantity is a whole number from 1 to 99. Nothing is bought or paid.',
      parameters: {
        type: T.object,
        properties: { id: { type: T.string, description: 'A variant id (best) or a product id.' }, qty: { type: T.integer, description: 'Units, 1 to 99.' } },
        required: ['id'],
      },
    },
    {
      name: 'saved_add',
      description: 'Save a material to the visitor\'s Saved list in the shop (in their browser, after your reply). Only when they asked for it.',
      parameters: { type: T.object, properties: { id: { type: T.string, description: 'A variant id or product id.' } }, required: ['id'] },
    },
    {
      name: 'saved_remove',
      description: 'Take a material off the visitor\'s Saved list. Only when they asked for it.',
      parameters: { type: T.object, properties: { id: { type: T.string, description: 'A variant id or product id.' } }, required: ['id'] },
    },
    {
      name: 'prefill_enquiry',
      description:
        'Fill in the Start a project form (the /start-project page) for the visitor (in their browser, after your reply). They read it and press send themselves; nothing is sent for them. Fill ONLY what the visitor told you in this conversation: never guess or invent a name, number, e-mail, company or city. Leave a field out if you do not know it.',
      parameters: {
        type: T.object,
        properties: {
          type: { type: T.string, enum: form.types, description: 'What the project is.' },
          name: { type: T.string, description: 'Their full name, as they gave it.' },
          company: { type: T.string, description: 'Their company, as they gave it.' },
          phone: { type: T.string, description: 'Their phone number, as they gave it.' },
          email: { type: T.string, description: 'Their e-mail address, as they gave it.' },
          city: { type: T.string, description: 'Their city, as they gave it.' },
          area: { type: T.string, enum: form.areas, description: 'The approximate area of the project.' },
          timeline: { type: T.string, enum: form.timelines, description: 'When they want to start.' },
          message: { type: T.string, description: 'A short note about the project, in the visitor\'s words, up to 600 characters.' },
        },
      },
    },
  ];
  if (signedIn) {
    declarations.splice(4, 0, {
      name: 'get_account_summary',
      description: 'What is known about the signed-in visitor: their first name and a few counts. No contact details.',
      parameters: { type: T.object, properties: {} },
    });
  }
  if (catalogueOn) {
    declarations.splice(3, 0, {
      name: 'catalogue_search',
      description:
        'Search the real Terucon catalogue (the uploaded product catalogue) by words. Returns catalogue items. Use it when the visitor asks for something the shop search does not cover, or for the catalogue itself.',
      parameters: {
        type: T.object,
        properties: { text: { type: T.string, description: 'What to look for, in words.' }, limit: { type: T.integer, description: '1 to 6 (default 4).' } },
        required: ['text'],
      },
    });
  }
  return declarations;
}

const rupees = (n) => Number.isFinite(n) && n >= 0 && n <= 100_000_000;
const digits = (s) => String(s).replace(/\D/g, '');

/**
 * @param {object} deps
 * @param {import('./shop.js').Shop} deps.shop
 * @param {*} deps.site the SiteMap
 * @param {{types: string[], timelines: string[], areas: string[]}} deps.form
 * @param {{urlFor: (image: string | null) => string, forVariant: (v: object) => string}} deps.images
 * @param {{signedIn: boolean, firstName?: string, studioRooms?: () => Promise<number | null>}} deps.account decided by the route from the session cookie
 * @param {{on: boolean, search?: (text: string, limit: number) => Promise<object>}} deps.catalogue
 * @param {string} deps.visitorText everything the visitor typed in this conversation (not what the assistant or the page said)
 * @param {{warn: Function}} [deps.log]
 */
export function createToolbox({ shop, site, form, images, account, catalogue, visitorText, log }) {
  const deps = { site, shop, form };
  const declarations = toolDeclarations({ shop, site, form, catalogueOn: Boolean(catalogue?.on), signedIn: account.signedIn });
  const names = new Set(declarations.map((d) => d.name));
  const cards = new Map();
  /** @type {object[]} */
  const actions = [];
  const used = [];
  let calls = 0;
  const said = normalise(visitorText);
  const saidDigits = digits(visitorText);

  const addCard = (p, v) => {
    if (cards.size >= MAX_CARDS && !cards.has(v.id)) return;
    if (!cards.has(v.id)) cards.set(v.id, shop.card(p, v, images.forVariant));
  };

  /** Queue an action for the browser after checking it again; returns what the model is told. */
  function queue(raw, extra = {}) {
    const checked = sanitizeAction(raw, deps);
    if (!checked.ok) return { ok: false, error: checked.error };
    const a = checked.action;
    const count = (...types) => actions.filter((x) => types.includes(x.type)).length;
    if ((a.type === 'navigate' || a.type === 'open_studio') && count('navigate', 'open_studio') >= 1) return { ok: false, error: 'You already chose a page to open in this reply: only one move per reply.' };
    if (a.type === 'cart_add') {
      if (count('cart_add') >= LIMITS.cartAdds) return { ok: false, error: `At most ${LIMITS.cartAdds} materials can be added to the cart in one reply.` };
      if (actions.some((x) => x.type === 'cart_add' && x.id === a.id)) return { ok: false, error: 'That material is already being added in this reply.' };
    }
    if ((a.type === 'saved_add' || a.type === 'saved_remove') && count('saved_add', 'saved_remove') >= LIMITS.saves) return { ok: false, error: `At most ${LIMITS.saves} saved-list changes in one reply.` };
    if (actions.length >= LIMITS.actions) return { ok: false, error: 'Too many actions in one reply.' };
    if (a.type === 'prefill_enquiry') {
      const have = actions.find((x) => x.type === 'prefill_enquiry');
      if (have) {
        for (const k of ENQUIRY_KEYS) if (a.fields[k]) have.fields[k] = a.fields[k];
        return { ok: true, queued: 'prefill_enquiry', ...extra };
      }
    }
    actions.push(a);
    return { ok: true, queued: a.type, ...extra };
  }

  const need = (args, key) => (typeof args?.[key] === 'string' ? args[key].trim() : '');
  const oneOf = (value, list) => (value === undefined || value === null || value === '' ? undefined : list.includes(value) ? value : null);

  const executors = {
    search_materials(args = {}) {
      const query = cleanText(args.query ?? '', 200);
      const category = oneOf(args.category, shop.categories.map((c) => c.id));
      const colour = oneOf(args.colour, shop.colours.map((c) => c.id));
      const application = oneOf(args.application, shop.applications.map((c) => c.id));
      const performance = oneOf(args.performance, shop.performance.map((c) => c.id));
      const bad = [['category', category], ['colour', colour], ['application', application], ['performance', performance]].filter(([, v]) => v === null).map(([k]) => k);
      if (bad.length) return { error: `Not a valid value for: ${bad.join(', ')}. Use the values listed for each parameter.` };
      for (const k of ['max_price', 'min_price']) if (args[k] !== undefined && args[k] !== null && !rupees(Number(args[k]))) return { error: `${k} must be a number of rupees.` };
      const sort = ['relevance', 'price_asc', 'price_desc'].includes(args.sort) ? args.sort : 'relevance';
      const found = shop.search({
        query,
        category,
        colour,
        application,
        performance,
        minPrice: args.min_price === undefined || args.min_price === null ? undefined : Number(args.min_price),
        maxPrice: args.max_price === undefined || args.max_price === null ? undefined : Number(args.max_price),
        inStockOnly: args.in_stock_only === true,
        sort,
        limit: wholeNumber(args.limit) ?? 4,
      });
      for (const r of found.results) addCard(r.product, r.variant);
      const out = {
        totalMatches: found.total,
        results: found.results.map(shop.resultView),
        note: "Prices are the shop's listed prices per unit (the shop is a preview with sample values), not a quote.",
      };
      if (found.ignoredWords.length) out.wordsNotInTheCatalogue = found.ignoredWords;
      if (!found.results.length) {
        out.hint = 'Nothing matched. Try fewer or different words, or browse by category.';
        out.categories = shop.categories.map((c) => ({ id: c.id, name: c.name }));
      }
      return out;
    },

    get_material(args = {}) {
      const found = shop.resolve(args.id);
      if (!found) return { error: 'No material with that id. Use search_materials to find one.' };
      addCard(found.product, found.variant);
      return { ...shop.productView(found.product, found.variant), note: "Prices are the shop's listed prices (a preview with sample values), not a quote." };
    },

    estimate_quantity(args = {}) {
      const found = shop.resolve(args.id);
      if (!found) return { error: 'No material with that id.' };
      const area = Number(args.area_sqft);
      if (!Number.isFinite(area) || area <= 0 || area > 1_000_000) return { error: 'area_sqft must be a number of square feet, above 0.' };
      const waste = args.waste_percent === undefined || args.waste_percent === null ? 10 : Number(args.waste_percent);
      if (!Number.isFinite(waste) || waste < 0 || waste > 50) return { error: 'waste_percent must be from 0 to 50.' };
      return shop.estimate(found.product, found.variant, area, waste);
    },

    site_guide(args = {}) {
      const route = typeof args.route === 'string' ? args.route : undefined;
      const pages = siteGuide(site, { route });
      if (route && !pages.length) return { error: 'No such page. Call site_guide without a route to see them all.' };
      return { pages };
    },

    navigate(args = {}) {
      let to = need(args, 'to');
      const materialId = need(args, 'material_id');
      const search = cleanText(args.search ?? '', 80);
      const view = need(args, 'view');
      if (materialId || search || view) {
        if (to !== '/materials') return { ok: false, error: 'material_id, search and view only work with to="/materials".' };
        if (view) {
          if (!['cart', 'saved', 'compare'].includes(view)) return { ok: false, error: 'view must be cart, saved or compare.' };
          to = `/materials#/${view}`;
        } else if (materialId) {
          const found = shop.resolve(materialId);
          if (!found) return { ok: false, error: 'No material with that id.' };
          to = `/materials#/p/${found.product.id}?v=${encodeURIComponent(found.variant.id)}`;
        } else {
          to = `/materials#/shop?q=${encodeURIComponent(search)}`;
        }
      }
      return queue({ type: 'navigate', to }, { note: 'The visitor\'s browser will open this after your reply.' });
    },

    open_studio() {
      return queue({ type: 'open_studio' }, { note: 'The visitor\'s browser will open the Design Studio after your reply (it asks them to sign in first if they are not).' });
    },

    cart_add(args = {}) {
      const found = shop.resolve(args.id);
      if (!found) return { ok: false, error: 'No material with that id.' };
      const result = queue({ type: 'cart_add', id: found.variant.id, qty: args.qty ?? 1 }, { material: shop.nameOf(found.product, found.variant), variant: found.variant.label, price: found.variant.priceText });
      if (result.ok) {
        addCard(found.product, found.variant);
        result.note = 'The visitor\'s browser will add it to their cart after your reply. The shop may lower the quantity if it has less in stock. Nothing is paid.';
      } else if (/qty/.test(result.error ?? '')) result.error += '. For a larger quantity, suggest the enquiry form.';
      return result;
    },

    saved_add(args = {}) {
      const found = shop.resolve(args.id);
      if (!found) return { ok: false, error: 'No material with that id.' };
      const result = queue({ type: 'saved_add', id: found.variant.id }, { material: shop.nameOf(found.product, found.variant) });
      if (result.ok) addCard(found.product, found.variant);
      return result;
    },

    saved_remove(args = {}) {
      const found = shop.resolve(args.id);
      if (!found) return { ok: false, error: 'No material with that id.' };
      return queue({ type: 'saved_remove', id: found.variant.id }, { material: shop.nameOf(found.product, found.variant) });
    },

    prefill_enquiry(args = {}) {
      const { fields, problems } = checkEnquiryFields(args, form);
      const unsaid = [];
      // Contact details are filled only from what the visitor typed themselves: never from the page, a tool result or the model's guess.
      for (const key of ['name', 'company', 'city']) if (fields[key] && !said.includes(normalise(fields[key]))) unsaid.push(key);
      if (fields.email && !visitorText.toLowerCase().includes(fields.email.toLowerCase())) unsaid.push('email');
      if (fields.phone) {
        const d = digits(fields.phone);
        const core = d.length > 10 ? d.slice(-10) : d;
        if (!saidDigits.includes(core)) unsaid.push('phone');
      }
      for (const key of unsaid) fields[key] = '';
      const result = queue({ type: 'prefill_enquiry', fields });
      const notes = [...problems.map((p) => `Left out - ${p}.`), ...unsaid.map((k) => `Left out - ${k}: the visitor has not told you that in this conversation.`)];
      if (result.ok) {
        result.filled = ENQUIRY_KEYS.filter((k) => fields[k]);
        result.note = 'The visitor\'s browser will fill these in on the Start a project page after your reply. They check it and send it themselves; nothing has been sent.';
      }
      if (notes.length) result.problems = notes;
      return result;
    },

    get_account_summary: async () => {
      if (!account.signedIn) return { signedIn: false, note: 'The visitor is not signed in.' };
      let rooms = null;
      try {
        rooms = (await account.studioRooms?.()) ?? null;
      } catch {
        rooms = null;
      }
      return { signedIn: true, firstName: account.firstName || null, ...(rooms === null ? {} : { savedStudioRooms: rooms }) };
    },

    catalogue_search: async (args = {}) => {
      if (!catalogue?.on || !catalogue.search) return { available: false, reason: 'The real catalogue search is not switched on on this site yet.' };
      const text = cleanText(args.text ?? '', 300);
      if (!text) return { error: 'text is empty.' };
      return catalogue.search(text, Math.max(1, Math.min(6, wholeNumber(args.limit) ?? 4)));
    },
  };

  /** Run one call from the model. Never throws: a failure is an answer the model can read. */
  async function run(name, args) {
    calls += 1;
    if (calls > MAX_CALLS) return { error: 'Too many tool calls for one reply. Answer with what you have.' };
    if (!names.has(name) || !Object.hasOwn(executors, name)) return { error: `There is no tool called ${String(name).slice(0, 40)}.` };
    used.push(name);
    try {
      const result = await executors[name](args && typeof args === 'object' && !Array.isArray(args) ? args : {});
      const text = JSON.stringify(result);
      if (text.length > MAX_RESULT_CHARS) return { ...result, variants: undefined, note: 'Result shortened.', ...{ truncated: true } };
      return result;
    } catch (error) {
      log?.warn?.(`terubot  tool ${name} failed: ${String(error?.message ?? error).slice(0, 120)}`);
      return { error: 'That tool failed. Answer without it.' };
    }
  }

  return {
    declarations,
    run,
    used,
    /** The cards for the reply, in the order they were found. */
    cards: () => [...cards.values()],
    /** The actions for the reply, checked once more. */
    actions: () => finalActions(actions, deps),
  };
}

export { MAX_QTY };
