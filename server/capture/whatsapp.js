/**
 * WhatsApp, two ways.
 *
 *  1. wa.me link (no account, works today). `https://wa.me/<number>?text=<message>` opens WhatsApp (the app, or WhatsApp Web) on the
 *     requester's own device with that chat and message ready; the requester presses send. The server never relays it, so it cannot be
 *     used to message anybody on its own.
 *  2. The WhatsApp Business Cloud API (needs a Meta business account, a business number and templates Meta has approved; a message
 *     that starts a conversation can only be a template). The request is the one in Meta's documentation:
 *       POST https://graph.facebook.com/<version>/<phone number id>/messages
 *       Authorization: Bearer <token>
 *       {"messaging_product":"whatsapp","to":"<digits>","type":"template",
 *        "template":{"name":"<name>","language":{"code":"en"},"components":[{"type":"body","parameters":[{"type":"text","text":"..."}]}]}}
 *     The answer is {"messages":[{"id":"wamid..."}]}. "Accepted" means Meta took the message; it is not proof that the phone received it.
 *     NOT run against Meta's servers from this repo: it is tested against a stand-in only.
 *
 * Templates to submit for approval (body text; the {{n}} are the variables, none at the very start or end, which Meta refuses):
 *   WHATSAPP_TEMPLATE_PHOTO   "Terucon: {{1}} sent {{2}} photo(s) for your {{3}} request. Open the site to see them."
 *   WHATSAPP_TEMPLATE_LINK    "Hi, {{1}} from Terucon asked you to add photos of a space. Open this link on your phone to take or choose them: {{2}} (works for {{3}} minutes)."
 */
import { cleanLine } from './validate.js';

export class WhatsAppError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.name = 'WhatsAppError';
    this.status = status;
    this.code = code;
  }
}

/** `https://wa.me/<digits>?text=...` for a number already reduced to digits with the country code. */
export function waLink(digits, text) {
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/**
 * A template variable: Meta refuses a new line, a tab and four spaces in a row, and long text. One line, 60 characters at most (a link may be longer).
 * @param {unknown} value @param {number} [max]
 */
export function templateText(value, max = 60) {
  return cleanLine(String(value ?? ''), max) || '-';
}

/** 919876543210 -> "+91••••••3210": enough to recognise a number, not enough to read it out of a log or a screenshot. */
export function maskPhone(digits) {
  const text = String(digits ?? '');
  if (text.length < 8) return '';
  return `+${text.slice(0, 2)}${'•'.repeat(text.length - 6)}${text.slice(-4)}`;
}

/**
 * @param {object} options
 * @param {() => {whatsappToken: string, whatsapp: {phoneNumberId: string, version: string, templatePhoto: string, templateLink: string, lang: string}}} options.config
 * @param {typeof fetch} [options.fetchImpl]
 * @param {{warn: Function}} [options.log]
 */
export function createWhatsApp({ config, fetchImpl = globalThis.fetch, log }) {
  const state = () => {
    const c = config();
    const cloud = Boolean(c.whatsappToken && c.whatsapp.phoneNumberId);
    return { cloud, photoAlerts: cloud && Boolean(c.whatsapp.templatePhoto), linkMessages: cloud && Boolean(c.whatsapp.templateLink) };
  };

  /**
   * @param {object} p
   * @param {string} p.to digits with the country code
   * @param {'photo' | 'link'} p.template which of the two configured templates
   * @param {unknown[]} p.params the template's variables, in order
   * @returns {Promise<{id: string}>}
   */
  async function sendTemplate({ to, template, params }) {
    const c = config();
    const name = template === 'photo' ? c.whatsapp.templatePhoto : c.whatsapp.templateLink;
    if (!state().cloud || !name) throw new WhatsAppError('WhatsApp is not set up on this server.');
    if (!/^\d{8,15}$/.test(to)) throw new WhatsAppError('That is not a WhatsApp number.');
    const url = `https://graph.facebook.com/${c.whatsapp.version}/${c.whatsapp.phoneNumberId}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name, language: { code: c.whatsapp.lang }, components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: templateText(p, 1000) })) }] },
    };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10_000);
    try {
      const response = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${c.whatsappToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: abort.signal });
      const text = await response.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        // not JSON: handled below
      }
      if (!response.ok) {
        const reason = cleanLine(data?.error?.message ?? '', 160) || `HTTP ${response.status}`;
        // the token and the number are never put in a message or a log
        log?.warn(`capture  WhatsApp refused a ${template} message: ${reason}${data?.error?.code ? ` (code ${data.error.code})` : ''}`);
        throw new WhatsAppError(reason, { status: response.status, code: data?.error?.code ?? null });
      }
      const id = data?.messages?.[0]?.id;
      if (typeof id !== 'string') throw new WhatsAppError('WhatsApp answered, but not with a message id.');
      return { id };
    } catch (error) {
      if (error instanceof WhatsAppError) throw error;
      const message = error?.name === 'AbortError' ? 'WhatsApp did not answer in time.' : 'WhatsApp could not be reached.';
      log?.warn(`capture  WhatsApp ${template} message failed: ${message}`);
      throw new WhatsAppError(message);
    } finally {
      clearTimeout(timer);
    }
  }

  return { state, sendTemplate };
}
