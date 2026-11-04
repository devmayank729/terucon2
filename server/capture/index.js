/**
 * "Capture from a phone": a person on a laptop asks for photos; somebody with a phone opens a link (from a QR code or WhatsApp), takes or
 * chooses photos, adds a few labels and where they are, and sends them; the photos appear for the requester, on the page they asked from,
 * ready to move to the Design Studio, Inspiration or the Finder. This file puts the parts together; the web routes are in
 * server/capture/routes.js and the pages in site/capture/ (the phone page) and site/brand/capture.js (the requester's side).
 *
 * Not part of the quotation (Terucon_AI_tool.pdf): foundation work for the photo intake of C1, C3 and C4. See TARGETS.md.
 */
import { captureConfig } from './config.js';
import { createCaptureDb } from './db.js';
import { createCaptureService } from './service.js';
import { createWhatsApp } from './whatsapp.js';

/**
 * @param {object} options
 * @param {() => object} options.settings the website's settings, read on every use so .env edits apply
 * @param {import('mongoose').Mongoose | null} [options.mongoose] the studio's mongoose; without it everything lives in memory (tests, no database)
 * @param {{info: Function, warn: Function, error: Function}} options.log
 * @param {() => number} [options.now]
 * @param {object} [options.overrides] tests: `db` (a capture db), `fetch` (what WhatsApp is called with)
 */
export function createCapture({ settings, mongoose = null, log, now = Date.now, overrides = {} }) {
  const config = () => captureConfig(settings());
  const store = config().store;
  const useMongo = overrides.db ? false : store === 'mongo' || (store === 'auto' && Boolean(mongoose));
  const db = overrides.db ?? createCaptureDb({ mongoose: useMongo ? mongoose : null, now, log });
  const whatsapp = createWhatsApp({ config, fetchImpl: overrides.fetch ?? ((...args) => globalThis.fetch(...args)), log });
  const service = createCaptureService({ db, config, whatsapp, log, now });
  return {
    config,
    db,
    whatsapp,
    service,
    close() {
      service.close();
    },
  };
}
