/**
 * Sign a new person in through the real endpoints: ask for a code, read it from the capturing sender, enter it, and (unless
 * `finish: false`) fill in the sign-up form. Used by every test that has to get past the sign-in gate, so the gate is never
 * switched off in a test: it is walked through.
 */
let counter = 0;

/**
 * @param {(path: string, options?: object) => Promise<{status: number, text: string, headers: object, json: () => any}>} call a request to the running server
 * @param {{codeFor: (to: string) => string | undefined}} capture the code senders from tests/helpers/authKit.js
 * @returns {Promise<{cookie: string, headers: Record<string, string>, email: string}>}
 */
export async function signInVia(call, capture, { email, finish = true, name = 'Test Visitor' } = {}) {
  counter += 1;
  const who = email ?? `visitor${counter}-${Date.now()}@example.com`;
  // a different "network address" for each person, so the per-address limits of one test never decide another
  const ip = { 'X-Forwarded-For': `10.77.${Math.floor(counter / 250) % 250}.${(counter % 250) + 1}` };
  const begun = await call('/api/auth/start', { method: 'POST', body: { identifier: who }, headers: ip });
  if (begun.status !== 200) throw new Error(`sign-in start refused: ${begun.status} ${begun.text}`);
  const verified = await call('/api/auth/verify', { method: 'POST', body: { challengeId: begun.json().challengeId, code: capture.codeFor(who) }, headers: ip });
  if (verified.status !== 200) throw new Error(`sign-in verify refused: ${verified.status} ${verified.text}`);
  const cookie = verified.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
  const headers = { Cookie: cookie, ...ip };
  // each person has a mobile number of their own (a confirmed number belongs to one account only)
  const phone = `98${String(counter).padStart(8, '0')}`;
  if (finish) {
    const saved = await call('/api/auth/profile', { method: 'POST', headers, body: { name, phone, firm: 'Test Firm' } });
    if (saved.status !== 200) throw new Error(`profile refused: ${saved.status} ${saved.text}`);
    // where a code can be sent to the second contact detail it has to be confirmed before the sign-up counts as finished
    for (const need of saved.json().user.needs ?? []) {
      if (!need.endsWith('-confirm')) continue;
      const kind = need.replace('-confirm', '');
      const value = saved.json().user[kind];
      const started = await call('/api/auth/contact/start', { method: 'POST', headers, body: { kind, value } });
      if (started.status !== 200) throw new Error(`confirming the ${kind} did not start: ${started.status} ${started.text}`);
      const done = await call('/api/auth/contact/confirm', { method: 'POST', headers, body: { challengeId: started.json().challengeId, code: capture.codeFor(value) } });
      if (done.status !== 200) throw new Error(`confirming the ${kind} was refused: ${done.status} ${done.text}`);
    }
  }
  return { cookie, headers, email: who, phone: `+91${phone}` };
}
