/**
 * A complete set of the sign-in services on the in-memory store, with a clock the test can move and senders that keep the codes
 * they were asked to send. The services are the real ones; only the store, the clock and the outside world are stand-ins.
 */
import { createAuthDb } from '../../server/auth/db.js';
import { createEvents } from '../../server/auth/events.js';
import { AuthLimits } from '../../server/auth/limits.js';
import { createOtp } from '../../server/auth/otp.js';
import { createSessions } from '../../server/auth/sessions.js';
import { AuthSettings } from '../../server/auth/settings.js';
import { createUsers } from '../../server/auth/users.js';
import { classifyIdentifier } from '../../server/auth/identifiers.js';

export const SECRET = 'test-secret-test-secret-test-secret-0123456789';

/** Senders that remember what they were asked to send. `fail` makes the next send throw. */
export function captureProviders() {
  const sent = [];
  const state = { failNext: 0 };
  const make = (name) => ({
    name: 'capture',
    ready: true,
    async send(message) {
      if (state.failNext > 0) {
        state.failNext -= 1;
        throw new Error(`${name} provider is down`);
      }
      sent.push({ channel: name, ...message });
    },
  });
  const providers = { email: make('email'), sms: make('sms') };
  return {
    providers,
    sent,
    state,
    /** the most recent code sent to this address / number */
    codeFor: (to) => [...sent].reverse().find((m) => m.to === to)?.code,
    lastCode: () => sent.at(-1)?.code,
  };
}

export function makeKit({ start = 1_800_000_000_000 } = {}) {
  const clock = { now: start };
  const now = () => clock.now;
  const log = { lines: [], info(m) { this.lines.push(`info ${m}`); }, warn(m) { this.lines.push(`warn ${m}`); }, error(m) { this.lines.push(`error ${m}`); } };
  const db = createAuthDb({ now });
  const settings = new AuthSettings({ db, now, cacheMs: 0 });
  const limits = new AuthLimits({ db, now });
  const events = createEvents({ db, log, now });
  const capture = captureProviders();
  const otp = createOtp({ db, settings, limits, events, secret: SECRET, providers: () => capture.providers, now, log });
  const sessions = createSessions({ db, settings, now });
  const users = createUsers({ db, now });
  return {
    clock,
    now,
    log,
    db,
    settings,
    limits,
    events,
    otp,
    sessions,
    users,
    capture,
    advance: (ms) => { clock.now += ms; },
    id: (raw) => classifyIdentifier(raw),
    /** sign a person in by the real path: ask for a code, read it from the sender, enter it. Returns the user and a session token. */
    async signIn(raw, { ip = '10.0.0.1' } = {}) {
      const identifier = classifyIdentifier(raw);
      const started = await otp.start({ identifier, purpose: 'login', ip });
      if (!started.ok) throw new Error(`start refused: ${started.reason}`);
      const checked = await otp.verify({ challengeId: started.challengeId, code: capture.codeFor(identifier.key), purpose: 'login', ip });
      if (!checked.ok) throw new Error(`verify refused: ${checked.reason}`);
      const { user, created } = await users.signInOrCreate(identifier.kind, identifier.key);
      const session = await sessions.create({ userId: user._id, ip, userAgent: 'test' });
      return { user, created, token: session.token };
    },
    close() {
      limits.close();
    },
  };
}
