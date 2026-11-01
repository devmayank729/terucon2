/**
 * Sending a finished sign-up to Zoho CRM.
 *
 * Three parts:
 *   1. the Zoho client: gets an access token from a refresh token, keeps it for most of its hour, serialises refreshes, and
 *      makes the few calls needed (upsert a record by e-mail, update one by id, delete one);
 *   2. the record builder: turns an account into the fields Zoho expects, with the field names the admin has chosen (a Zoho
 *      organisation can rename or add fields), and always fills Last_Name (Zoho refuses a record without one) and Company;
 *   3. the queue ("outbox"): a sign-up is never sent from inside the sign-up request. It is queued, and a background loop
 *      delivers it, retrying with growing delays when Zoho is slow, rate limiting or down. Nothing is lost while the Zoho
 *      credentials are not in .env yet: jobs wait, and are delivered once the credentials appear.
 *
 * The queue holds no personal data: a job names the account, and the account is read when the job runs, so the CRM always gets
 * the latest details and deleting an account leaves nothing behind in the queue.
 *
 * What is written from Zoho's documentation (checked 2026-10-30):
 *   token   POST {accounts-url}/oauth/v2/token?refresh_token&client_id&client_secret&grant_type=refresh_token
 *           (https://www.zoho.com/crm/developer/docs/api/v6/refresh.html): answers access_token, expires_in 3600, api_domain
 *   upsert  POST {api_domain}/crm/v6/{Module}/upsert  {data:[...], duplicate_check_fields:[...]}
 *           (https://www.zoho.com/crm/developer/docs/api/v6/upsert-records.html): per record code, status, action insert|update, details.id
 *   update  PUT {api_domain}/crm/v6/{Module}/{id}  {data:[{id, ...}]}  (https://www.zoho.com/crm/developer/docs/api/v6/update-records.html)
 *   Leads need Last_Name (https://www.zoho.com/crm/developer/docs/api/v6/insert-records.html); Company is filled too because many
 *   organisations make it mandatory.
 * Written from memory, not from a page I could read, and used only when the admin turns "delete the CRM record" on:
 *   delete  DELETE {api_domain}/crm/v6/{Module}?ids={id}
 */
import { findAndUpdate, isDuplicateKey } from './db.js';
import { splitName } from './identifiers.js';

const ACCOUNTS = {
  com: 'https://accounts.zoho.com',
  us: 'https://accounts.zoho.com',
  in: 'https://accounts.zoho.in',
  eu: 'https://accounts.zoho.eu',
  'com.au': 'https://accounts.zoho.com.au',
  au: 'https://accounts.zoho.com.au',
  jp: 'https://accounts.zoho.jp',
  ca: 'https://accounts.zohocloud.ca',
  'com.cn': 'https://accounts.zoho.com.cn',
  cn: 'https://accounts.zoho.com.cn',
};
// the refresh token and client secret are sent to this address, so it has to be a Zoho accounts address and nothing else
const ACCOUNTS_URL = /^https:\/\/accounts\.(?:zoho\.[a-z]{2,3}(?:\.[a-z]{2,3})?|zohocloud\.ca)$/;
const API_DOMAIN = /^https:\/\/[a-z0-9.-]*zohoapis\.[a-z]{2,3}(?:\.[a-z]{2,3})?$/;

export class CrmError extends Error {
  /** @param {'auth' | 'transient' | 'permanent'} kind */
  constructor(message, kind, { retryAfterMs, code } = {}) {
    super(message);
    this.name = 'CrmError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.code = code;
  }
}

/** The accounts address for a data centre name (in, com, eu, com.au, jp, ca, com.cn) or an explicit Zoho accounts URL. */
export function zohoAccountsUrl({ dc, accountsUrl }) {
  if (accountsUrl) return ACCOUNTS_URL.test(accountsUrl) ? accountsUrl : null;
  return ACCOUNTS[String(dc || '').toLowerCase()] ?? null;
}

/**
 * @param {{dc?: string, accountsUrl?: string, clientId: string, clientSecret: string, refreshToken: string}} config
 * @param {{fetch?: typeof fetch, now?: () => number}} [options]
 */
export function createZohoClient(config, { fetch: doFetch = globalThis.fetch, now = Date.now } = {}) {
  const accounts = zohoAccountsUrl(config);
  const ready = Boolean(accounts && config.clientId && config.clientSecret && config.refreshToken);
  let token = null; // {value, apiDomain, until}
  let refreshing = null;
  let blockedUntil = 0;

  async function refresh() {
    if (now() < blockedUntil) throw new CrmError('Zoho refused the credentials a moment ago; waiting before asking again.', 'auth');
    const url = new URL('/oauth/v2/token', accounts);
    url.search = new URLSearchParams({ refresh_token: config.refreshToken, client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'refresh_token' }).toString();
    let response;
    try {
      response = await doFetch(url, { method: 'POST', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000), redirect: 'error' });
    } catch (error) {
      throw new CrmError(`Zoho's sign-in service could not be reached (${error.name}).`, 'transient');
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
      blockedUntil = now() + 5 * 60 * 1000;
      throw new CrmError(`Zoho did not give an access token (${body.error ?? response.status}). Check ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN and ZOHO_DC.`, 'auth');
    }
    const apiDomain = API_DOMAIN.test(body.api_domain ?? '') ? body.api_domain : null;
    if (!apiDomain) throw new CrmError('Zoho named an API address that is not a Zoho address; not using it.', 'permanent');
    const lifetime = Math.min(Number(body.expires_in) || 3600, 3600) * 1000;
    token = { value: body.access_token, apiDomain, until: now() + lifetime - 5 * 60 * 1000 };
    return token;
  }

  async function access() {
    if (token && now() < token.until) return token;
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function call(method, path, { body, query } = {}, retried = false) {
    const { value, apiDomain } = await access();
    const url = new URL(path, apiDomain);
    if (query) url.search = new URLSearchParams(query).toString();
    let response;
    try {
      response = await doFetch(url, {
        method,
        headers: { Authorization: `Zoho-oauthtoken ${value}`, Accept: 'application/json', ...(body && { 'Content-Type': 'application/json' }) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
    } catch (error) {
      throw new CrmError(`Zoho could not be reached (${error.name}).`, 'transient');
    }
    if (response.status === 401 && !retried) {
      token = null; // expired or revoked early: get a new one, once
      return call(method, path, { body, query }, true);
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (response.status === 401) throw new CrmError('Zoho refused the access token.', 'auth');
    if (response.status === 429 || response.status >= 500) throw new CrmError(`Zoho answered ${response.status}.`, 'transient', { retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined });
    if (response.status === 204) return { data: [] };
    const first = json?.data?.[0];
    if (!response.ok && !first) throw new CrmError(`Zoho answered ${response.status} (${json?.code ?? 'no details'}).`, 'permanent', { code: json?.code });
    return json ?? {};
  }

  /** The outcome of one record in a Zoho answer; throws for a record Zoho refused. */
  function outcome(answer, what) {
    const entry = answer?.data?.[0];
    if (!entry) throw new CrmError(`Zoho's answer to ${what} had no result.`, 'permanent');
    if (entry.code === 'SUCCESS' || entry.status === 'success') return { id: entry.details?.id ?? null, action: entry.action ?? null };
    const kind = ['TOO_MANY_REQUESTS', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE'].includes(entry.code) ? 'transient' : ['INVALID_TOKEN', 'AUTHENTICATION_FAILURE', 'OAUTH_SCOPE_MISMATCH'].includes(entry.code) ? 'auth' : 'permanent';
    throw new CrmError(`Zoho refused ${what}: ${entry.code ?? 'unknown'}${entry.details?.api_name ? ` (${entry.details.api_name})` : ''}.`, kind, { code: entry.code });
  }

  return {
    ready,
    problem: ready ? null : 'ZOHO_DC (or ZOHO_ACCOUNTS_URL), ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_REFRESH_TOKEN are all needed.',
    /** Create the record, or update the one that already has this e-mail address. */
    async upsert(module, record, duplicateCheckFields) {
      const body = { data: [record], ...(duplicateCheckFields?.length && { duplicate_check_fields: duplicateCheckFields }) };
      return outcome(await call('POST', `/crm/v6/${module}/upsert`, { body }), 'the record');
    },
    async update(module, id, record) {
      return outcome(await call('PUT', `/crm/v6/${module}/${encodeURIComponent(id)}`, { body: { data: [{ id, ...record }] } }), 'the update');
    },
    async remove(module, id) {
      return outcome(await call('DELETE', `/crm/v6/${module}`, { query: { ids: id } }), 'the delete');
    },
  };
}

// ---------------------------------------------------------------------------------------------------- the record

const cut = (text, max) => String(text ?? '').slice(0, max);

/**
 * The fields to send for an account. `cfg` is the sign-in settings (crm.field.* hold the Zoho field names; an empty name means
 * "do not send that one"). Last_Name and Company are always filled.
 */
export function buildRecord(user, cfg) {
  const field = cfg.crm.field;
  const { first, last } = splitName(user.name || user.email || 'Unknown');
  const record = {};
  const put = (name, value) => {
    if (name && value) record[name] = value;
  };
  record[field.lastName] = cut(last, 80);
  put(field.firstName, cut(first, 40));
  put(field.email, cut(user.email, 100));
  put(field.phone, cut(user.phone, 30));
  put(field.company, cut(user.firm || cfg.crm.companyWhenNoFirm, 100));
  put(field.leadSource, cut(cfg.crm.leadSource, 100));
  put(
    field.description,
    `Signed up on the Terucon website. E-mail verified: ${user.emailKey ? 'yes' : 'no'}. Phone verified: ${user.phoneKey ? 'yes' : 'no'}. ${user.individual ? 'Signed up as an individual.' : user.firm ? 'Firm given by the person.' : ''}`.trim(),
  );
  return record;
}

// ---------------------------------------------------------------------------------------------------- the queue

const MINUTE = 60 * 1000;
const RETRY_DELAYS = [1 * MINUTE, 5 * MINUTE, 30 * MINUTE, 2 * 60 * MINUTE, 6 * 60 * MINUTE, 12 * 60 * MINUTE, 24 * 60 * MINUTE];
const MAX_ATTEMPTS = 12;
const QUEUE_LIMIT = 50000;
const syncId = (userId) => `sync:${userId}`;

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('./db.js').createAuthDb>} deps.db
 * @param {{get: () => Promise<any>}} deps.settings
 * @param {ReturnType<typeof import('./users.js').createUsers>} deps.users
 * @param {ReturnType<typeof import('./events.js').createEvents>} deps.events
 * @param {() => ReturnType<typeof createZohoClient>} deps.zoho the current client (it follows .env changes)
 * @param {boolean} [deps.enabled] AUTH_CRM is not "off"
 * @param {{info: Function, warn: Function}} [deps.log]
 * @param {() => number} [deps.now]
 */
export function createCrmOutbox({ db, settings, users, events, zoho, enabled = true, log, now = Date.now }) {
  let timer = null;
  let running = false;
  let queueFullLogged = false;

  const outbox = () => db.col('outbox');

  /** Queue (or re-queue) the sending of an account's current details. Never throws: a sign-up must not fail because of the CRM. */
  async function enqueue(userId) {
    try {
      const cfg = await settings.get();
      if (!enabled || !cfg.crm.enabled) return false;
      const col = await outbox();
      if ((await col.countDocuments({ status: { $in: ['pending', 'sending'] } })) >= QUEUE_LIMIT) {
        if (!queueFullLogged) log?.warn(`auth  the CRM queue holds ${QUEUE_LIMIT} unsent sign-ups; not queueing more until Zoho is connected`);
        queueFullLogged = true;
        return false;
      }
      const t = now();
      const _id = syncId(userId);
      try {
        await col.updateOne({ _id, status: { $ne: 'sending' } }, { $set: { userId, op: 'sync', status: 'pending', attempts: 0, nextAt: t, lastError: null }, $setOnInsert: { createdAt: t }, $inc: { rev: 1 } }, { upsert: true });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        await col.updateOne({ _id }, { $inc: { rev: 1 } }); // being sent right now: note that there is something newer to send afterwards
      }
      setImmediate(() => tick().catch(() => {}));
      return true;
    } catch (error) {
      log?.warn(`auth  could not queue the CRM update: ${String(error.message).slice(0, 120)}`);
      return false;
    }
  }

  /** An account was deleted: drop what is still waiting for it, and (if the admin says so) queue the removal of its CRM record. */
  async function forget(user) {
    try {
      const col = await outbox();
      await col.deleteMany({ userId: user._id });
      const cfg = await settings.get();
      if (enabled && cfg.crm.enabled && cfg.crm.deleteOnAccountDelete && user.crmId) {
        await col.insertOne({ _id: `delete:${user._id}`, userId: user._id, op: 'delete', crmId: user.crmId, module: cfg.crm.module, status: 'pending', attempts: 0, nextAt: now(), rev: 1, createdAt: now() });
        setImmediate(() => tick().catch(() => {}));
      }
    } catch (error) {
      log?.warn(`auth  could not clear the CRM queue for a deleted account: ${String(error.message).slice(0, 120)}`);
    }
  }

  async function deliver(job, cfg, client) {
    const module = cfg.crm.module;
    if (job.op === 'delete') {
      await client.remove(job.module ?? module, job.crmId);
      return;
    }
    const user = await users.byId(job.userId);
    if (!user || !user.profileComplete) return; // gone, or no longer a finished sign-up: nothing to send
    const record = buildRecord(user, cfg);
    const emailField = cfg.crm.field.email;
    let result;
    if (user.crmId) {
      try {
        result = await client.update(module, user.crmId, record);
      } catch (error) {
        if (!(error instanceof CrmError) || error.kind !== 'permanent') throw error;
        result = await client.upsert(module, record, emailField && record[emailField] ? [emailField] : []); // the record was deleted in the CRM: make it again
      }
    } else {
      result = await client.upsert(module, record, emailField && record[emailField] ? [emailField] : []);
    }
    if (result.id && result.id !== user.crmId) await (await db.col('users')).updateOne({ _id: user._id }, { $set: { crmId: result.id, crmSyncedAt: now() } });
    else await (await db.col('users')).updateOne({ _id: user._id }, { $set: { crmSyncedAt: now() } });
  }

  async function finish(col, job, error) {
    const t = now();
    if (!error) {
      const done = await findAndUpdate(col, { _id: job._id, rev: job.rev }, { $set: { status: 'sent', sentAt: t, lastError: null }, $unset: { leaseUntil: '' } }, { returnDocument: 'after' });
      if (!done) await col.updateOne({ _id: job._id }, { $set: { status: 'pending', nextAt: t, attempts: 0 } }); // changed while it was being sent: send again
      else if (job.op === 'delete') await col.deleteOne({ _id: job._id });
      else await events.record('crm.sent', { userId: job.userId });
      return;
    }
    const message = String(error.message).slice(0, 240);
    if (error instanceof CrmError && error.kind === 'auth') {
      // the credentials are the problem, not this job: keep it, try again later, and do not use up its attempts
      await col.updateOne({ _id: job._id }, { $set: { status: 'pending', nextAt: t + 15 * MINUTE, lastError: message, attempts: Math.max(0, job.attempts - 1) }, $unset: { leaseUntil: '' } });
      await events.record('crm.failed', { detail: `credentials: ${message}` });
      return;
    }
    const permanent = !(error instanceof CrmError) ? false : error.kind === 'permanent';
    if (permanent || job.attempts >= MAX_ATTEMPTS) {
      await col.updateOne({ _id: job._id }, { $set: { status: 'failed', lastError: message, failedAt: t }, $unset: { leaseUntil: '' } });
      await events.record('crm.failed', { userId: job.userId, detail: message });
      return;
    }
    const delay = error.retryAfterMs ?? RETRY_DELAYS[Math.min(job.attempts - 1, RETRY_DELAYS.length - 1)];
    await col.updateOne({ _id: job._id }, { $set: { status: 'pending', nextAt: t + delay, lastError: message }, $unset: { leaseUntil: '' } });
  }

  /** Deliver what is due. Safe to call at any time; does nothing while Zoho is not set up. */
  async function tick({ max = 10 } = {}) {
    if (running || !enabled) return { sent: 0 };
    const client = zoho();
    if (!client.ready) return { sent: 0, waiting: true };
    running = true;
    let handled = 0;
    try {
      const cfg = await settings.get();
      if (!cfg.crm.enabled) return { sent: 0 };
      const col = await outbox();
      await col.updateMany({ status: 'sending', leaseUntil: { $lt: now() } }, { $set: { status: 'pending' } });
      for (; handled < max; handled += 1) {
        const job = await findAndUpdate(col, { status: 'pending', nextAt: { $lte: now() } }, { $set: { status: 'sending', leaseUntil: now() + 2 * MINUTE }, $inc: { attempts: 1 } }, { sort: { nextAt: 1 }, returnDocument: 'after' });
        if (!job) break;
        try {
          await deliver(job, cfg, client);
          await finish(col, job, null);
        } catch (error) {
          await finish(col, job, error);
        }
      }
    } finally {
      running = false;
    }
    return { sent: handled };
  }

  async function stats() {
    const col = await outbox();
    const count = (status) => col.countDocuments({ status });
    return { pending: await count('pending'), sending: await count('sending'), failed: await count('failed'), sent: await count('sent') };
  }

  /** Put failed jobs back in the queue (after the cause, e.g. a wrong field name, has been fixed). */
  async function retryFailed() {
    const col = await outbox();
    const { modifiedCount } = await col.updateMany({ status: 'failed' }, { $set: { status: 'pending', attempts: 0, nextAt: now(), lastError: null } });
    setImmediate(() => tick().catch(() => {}));
    return modifiedCount;
  }

  /** Queue every finished account that was never sent (for sign-ups made before the CRM was switched on). */
  async function backfill({ limit = 1000 } = {}) {
    const col = await db.col('users');
    const rows = await col.find({ profileComplete: true, crmId: { $exists: false } }).limit(limit).toArray();
    let queued = 0;
    for (const user of rows) if (await enqueue(user._id)) queued += 1;
    return queued;
  }

  return {
    enqueue,
    forget,
    tick,
    stats,
    retryFailed,
    backfill,
    start(everyMs = 30 * 1000) {
      if (timer) return;
      timer = setInterval(() => tick().catch((error) => log?.warn(`auth  CRM delivery stopped early: ${String(error.message).slice(0, 120)}`)), everyMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
