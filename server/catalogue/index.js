/**
 * Catalogue search for the Terucon website: find materials in a real catalogue by photo, colour or words (targets C3, C4, C7, C5), and let
 * the admin upload a catalogue (target D1). This file puts the parts together; the web routes are in server/routes/catalogue.js and the
 * contract everything is built against is catalogue/ARCHITECTURE.md.
 *
 * The website is a thin gateway on purpose. It runs no model, parses no PDF, holds no vectors and never carries a picture: the search
 * runs on Modal (GPU), the data lives in MongoDB and Google Cloud Storage, and the browser loads pictures from Cloud Storage with signed
 * addresses (and sends the admin's PDF there with a signed upload address). What this process does is small: check who is asking, limit
 * how much, validate, ask Modal, read a few documents, sign a few addresses.
 *
 * With no CATALOGUE_* variables in .env the feature is off, every route says so, and the rest of the site behaves exactly as before.
 */
import { createAdmin } from './admin.js';
import { catalogueConfig } from './config.js';
import { createCatalogueDb } from './db.js';
import { createGcsSigner } from './gcsSigner.js';
import { createModalClient } from './modalClient.js';
import { createService } from './service.js';

/**
 * @param {object} options
 * @param {() => object} options.settings the website's settings (server/config/settings.js), read on every use so .env edits apply
 * @param {object} options.auth the sign-in (server/auth/index.js): the admin token check, the security log, the admin-managed limits
 * @param {import('mongoose').Mongoose | null} [options.mongoose] the studio's mongoose; without it the catalogue lives in memory (tests, no database)
 * @param {{info: Function, warn: Function, error: Function}} options.log
 * @param {() => number} [options.now]
 * @param {object} [options.overrides] tests: `modal` (a fake Modal client), `db` (a catalogue db), `signer` (a fake signer)
 */
export function createCatalogue({ settings, auth, mongoose = null, log, now = Date.now, overrides = {} }) {
  const config = () => catalogueConfig(settings());
  const db = overrides.db ?? createCatalogueDb({ mongoose, now, log });
  const signer = overrides.signer ?? createGcsSigner({ config, now, log });
  const modal = overrides.modal ?? createModalClient({ target: config, log, now });
  const service = createService({ settings, auth, db, modal, signer, log, now });
  const admin = createAdmin({ db, modal, signer, service, auth, log, now });
  return {
    config,
    db,
    signer,
    modal,
    service,
    admin,
    now,
    close() {
      service.close();
    },
  };
}
