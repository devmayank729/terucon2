import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, afterEach, before, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findPython, pythonCandidates } from '../../server/model/python.js';
import { buildChildEnv, ModelSupervisor } from '../../server/model/supervisor.js';
import { collectLog } from '../helpers/app.js';
import { waitFor } from '../helpers/http.js';

const FAKE_CHILD = fileURLToPath(new URL('../helpers/fakeModelChild.mjs', import.meta.url));
let dir;
let supervisors = [];

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-supervisor-'));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(supervisors.map((s) => s.stop()));
  supervisors = [];
});

let counter = 0;
/** A supervisor running the fake child. `env` is what the child sees (FAKE_* controls it). */
function fakeSupervisor({ env = {}, ...options } = {}) {
  counter += 1;
  const files = { counter: path.join(dir, `count-${counter}`), pid: path.join(dir, `pid-${counter}`), dump: path.join(dir, `env-${counter}.json`) };
  const log = collectLog();
  const states = [];
  const supervisor = new ModelSupervisor({
    root: dir,
    command: process.execPath,
    args: [FAKE_CHILD],
    env: { PATH: process.env.PATH, FAKE_COUNTER: files.counter, FAKE_PID_FILE: files.pid, FAKE_ENV_DUMP: files.dump, ...env },
    log,
    ...options,
  });
  supervisor.on('state', (s) => states.push(s.state));
  supervisors.push(supervisor);
  const starts = () => (fs.existsSync(files.counter) ? fs.statSync(files.counter).size : 0);
  const pid = () => Number(fs.readFileSync(files.pid, 'utf8'));
  return { supervisor, log, states, files, starts, pid };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('start-up protocol', () => {
  test('the READY line gives the address; the child output is passed on with a [model] prefix', async () => {
    const { supervisor, log, states } = fakeSupervisor();
    assert.equal(supervisor.state.state, 'idle');
    supervisor.start();
    assert.equal(supervisor.state.state, 'starting');
    await waitFor(() => supervisor.state.state === 'ready', { what: 'ready' });
    assert.match(supervisor.state.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.deepEqual(states, ['starting', 'ready']);
    await waitFor(() => log.lines.includes('raw [model] hello from stderr'), { what: 'stderr line' });
    assert.ok(log.lines.includes('raw [model] hello from stdout'));
    assert.ok(!log.lines.some((l) => l.includes('TERUCON_MODEL_READY')), 'the protocol line is not echoed');
  });

  test('the READY line is only recognised when it has arrived whole', async () => {
    const { supervisor } = fakeSupervisor({ env: { FAKE_MODE: 'split-ready' } });
    supervisor.start();
    await waitFor(() => supervisor.state.state === 'ready', { what: 'ready' });
    assert.match(supervisor.state.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test('the child gets MODEL_PORT=0, a loopback host, the key, the parent pid and the env file', async () => {
    const dump = path.join(dir, 'dump.json');
    const env = buildChildEnv({ environ: { FAKE_ENV_DUMP: dump }, envFile: '/some/where/.env', key: 'run-key' });
    const { supervisor } = fakeSupervisor({ env });
    supervisor.start();
    await waitFor(() => supervisor.state.state === 'ready');
    const seen = JSON.parse(fs.readFileSync(dump, 'utf8'));
    assert.equal(seen.MODEL_PORT, '0');
    assert.equal(seen.MODEL_HOST, '127.0.0.1');
    assert.equal(seen.MODEL_SERVICE_KEY, 'run-key');
    assert.equal(seen.MODEL_PARENT_PID, String(process.pid));
    assert.equal(seen.TERUCON_ENV_FILE, '/some/where/.env');
    assert.equal(seen.PYTHONUNBUFFERED, '1');
    assert.equal(seen.PYTHONDONTWRITEBYTECODE, '1');
  });

  test('with an explicit environ only that environment (plus the basics) reaches the child', () => {
    process.env.TERUCON_TEST_CANARY = 'leaked';
    try {
      const explicit = buildChildEnv({ environ: { GEMINI_API_KEY: 'k' }, envFile: '/e/.env', key: 'kk' });
      assert.equal(explicit.GEMINI_API_KEY, 'k');
      assert.equal(explicit.TERUCON_TEST_CANARY, undefined);
      assert.equal(explicit.PATH, process.env.PATH);
      assert.deepEqual(Object.keys(explicit).sort(), ['GEMINI_API_KEY', 'MODEL_HOST', 'MODEL_PARENT_PID', 'MODEL_PORT', 'MODEL_SERVICE_KEY', 'PATH', 'PYTHONDONTWRITEBYTECODE', 'PYTHONUNBUFFERED', 'TERUCON_ENV_FILE', ...['LANG', 'LC_ALL', 'SYSTEMROOT', 'TMPDIR'].filter((k) => process.env[k] !== undefined)].sort());
      const inherited = buildChildEnv({ environ: undefined, envFile: '/e/.env', key: 'kk' });
      assert.equal(inherited.TERUCON_TEST_CANARY, 'leaked', 'without an explicit environ the real one is passed on');
    } finally {
      delete process.env.TERUCON_TEST_CANARY;
    }
  });
});

describe('crashes and restarts', () => {
  test('a crash is restarted after a back-off; ready again afterwards', async () => {
    const { supervisor, states, starts, log } = fakeSupervisor({ env: { FAKE_FAIL_RUNS: '2' }, backoffSeconds: [0.01, 0.01, 0.01] });
    supervisor.start();
    await waitFor(() => supervisor.state.state === 'ready', { what: 'ready after two crashes' });
    assert.equal(starts(), 3);
    assert.deepEqual(states, ['starting', 'unavailable', 'starting', 'unavailable', 'starting', 'ready']);
    assert.ok(log.lines.includes('raw [model] about to crash'));
  });

  test('the reason is given while it waits to restart', async () => {
    const { supervisor } = fakeSupervisor({ env: { FAKE_MODE: 'crash' }, backoffSeconds: [60] });
    supervisor.start();
    await waitFor(() => supervisor.state.state === 'unavailable');
    assert.match(supervisor.state.error, /stopped unexpectedly \(exit code 3\)\. Restarting in 60 s\./);
  });

  test('it gives up after the restart limit and stays down with the reason', async () => {
    const { supervisor, starts, states } = fakeSupervisor({ env: { FAKE_MODE: 'crash' }, backoffSeconds: [0.01, 0.01] });
    supervisor.start();
    await waitFor(() => /not restarted any more/.test(supervisor.state.error), { what: 'giving up' });
    assert.equal(starts(), 3, 'the first start and two restarts');
    assert.match(supervisor.state.error, /restarted 2 times/);
    assert.equal(supervisor.state.state, 'unavailable');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(starts(), 3, 'no more starts');
    assert.equal(states.filter((s) => s === 'starting').length, 3);
  });

  test('the default schedule is 1, 2, 4, 8, 16 seconds with five restarts allowed', async () => {
    const { DEFAULT_BACKOFF_SECONDS } = await import('../../server/model/supervisor.js');
    assert.deepEqual(DEFAULT_BACKOFF_SECONDS, [1, 2, 4, 8, 16]);
  });

  test('restarts older than the window are forgotten', async () => {
    let time = 0;
    const { supervisor, starts } = fakeSupervisor({ env: { FAKE_MODE: 'crash' }, backoffSeconds: [0.01, 0.01], windowMs: 1000, clock: () => (time += 5000) });
    supervisor.start();
    await waitFor(() => starts() >= 5, { what: 'more starts than the limit' });
    assert.ok(!supervisor.state.error.includes('not restarted any more'));
  });

  test('a start that never becomes ready times out, is killed, and is not restarted', async () => {
    const { supervisor, starts, pid } = fakeSupervisor({ env: { FAKE_MODE: 'never-ready' }, startTimeoutMs: 300, backoffSeconds: [0.01] });
    supervisor.start();
    await waitFor(() => /did not become ready within \d+ seconds/.test(supervisor.state.error), { what: 'start timeout' });
    assert.match(supervisor.state.error, /MODEL_START_TIMEOUT/);
    const child = pid();
    await waitFor(() => !alive(child), { what: 'the child to be killed' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(starts(), 1);
  });

  test('a program that can not be started at all is reported once, not retried', async () => {
    const { supervisor, states } = fakeSupervisor({ command: path.join(dir, 'no-such-program'), args: [], backoffSeconds: [0.01] });
    supervisor.start();
    await waitFor(() => supervisor.state.state === 'unavailable');
    assert.match(supervisor.state.error, /could not be started \(ENOENT\)/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(states, ['starting', 'unavailable']);
  });
});

describe('stopping', () => {
  test('stop() terminates the child', async () => {
    const { supervisor, pid } = fakeSupervisor();
    supervisor.start();
    await waitFor(() => supervisor.state.state === 'ready');
    const child = pid();
    assert.ok(alive(child));
    await supervisor.stop();
    assert.ok(!alive(child));
    assert.equal(supervisor.state.state, 'unavailable');
  });

  test('a child that ignores SIGTERM is killed after the grace period', async () => {
    const { supervisor, pid } = fakeSupervisor({ env: { FAKE_MODE: 'ignore-term' }, killGraceMs: 200 });
    supervisor.start();
    await waitFor(() => supervisor.state.state === 'ready');
    const child = pid();
    const started = Date.now();
    await supervisor.stop();
    assert.ok(!alive(child));
    assert.ok(Date.now() - started >= 150, 'it waited for the grace period');
  });

  test('stop() cancels a restart that is waiting, and listeners on process "exit" do not pile up', async () => {
    const before = process.listenerCount('exit');
    const { supervisor, starts } = fakeSupervisor({ env: { FAKE_MODE: 'crash' }, backoffSeconds: [0.3] });
    supervisor.start();
    assert.equal(process.listenerCount('exit'), before + 1);
    await waitFor(() => supervisor.state.state === 'unavailable');
    await supervisor.stop();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(starts(), 1);
    assert.equal(process.listenerCount('exit'), before);
  });

  test('stop() before the first start, and twice, are harmless', async () => {
    const { supervisor } = fakeSupervisor();
    await supervisor.stop();
    await supervisor.stop();
  });

  test('stopping while the interpreter is still being looked for spawns nothing', { skip: process.platform === 'win32' }, async () => {
    const root = fs.mkdtempSync(path.join(dir, 'root-a-'));
    fs.mkdirSync(path.join(root, 'model', 'terucon_model'), { recursive: true });
    const spawned = path.join(root, 'spawned');
    const python = path.join(root, 'slow-python');
    // answers the dependency probe after a while; if it is ever asked to run a module, it leaves a note
    fs.writeFileSync(python, `#!/bin/sh\nif [ "$1" = "-m" ]; then echo yes > ${spawned}; exit 0; fi\nsleep 0.4\necho '{"version":[3,12,0],"missing":[]}'\n`, { mode: 0o755 });
    const supervisor = new ModelSupervisor({ root, env: { PATH: '/usr/bin:/bin' }, log: collectLog(), python });
    supervisors.push(supervisor);
    supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await supervisor.stop();
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.ok(!fs.existsSync(spawned), 'nothing was spawned after stop()');
    assert.equal(supervisor.state.error, 'The model service was stopped.');
  });
});

describe('without a usable Python', () => {
  test('a project without model/terucon_model says it is not installed (no restart loop)', async () => {
    const root = fs.mkdtempSync(path.join(dir, 'noinstall-'));
    const supervisor = new ModelSupervisor({ root, env: {}, log: collectLog() });
    supervisors.push(supervisor);
    supervisor.start();
    await waitFor(() => supervisor.state.state === 'unavailable');
    assert.match(supervisor.state.error, /not installed.*model\/terucon_model/);
  });

  test('the Python the user named is the only one tried', { skip: process.platform === 'win32' }, async () => {
    const root = fs.mkdtempSync(path.join(dir, 'named-'));
    fs.mkdirSync(path.join(root, 'model', 'terucon_model'), { recursive: true });
    const supervisor = new ModelSupervisor({ root, env: { PATH: process.env.PATH }, log: collectLog(), python: path.join(root, 'nope') });
    supervisors.push(supervisor);
    supervisor.start();
    await waitFor(() => supervisor.state.state === 'unavailable');
    assert.match(supervisor.state.error, /PYTHON is set to ".*nope", but that could not be run/);
  });
});

describe('finding a Python that has the packages', { skip: process.platform === 'win32' }, () => {
  /** An executable that answers the probe like an interpreter with the given version and missing modules. */
  function fakePython(folder, { version = [3, 12, 1], missing = [] } = {}) {
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'python');
    fs.writeFileSync(file, `#!/bin/sh\necho '${JSON.stringify({ version, missing })}'\n`, { mode: 0o755 });
    return file;
  }
  const freshRoot = () => {
    const root = fs.mkdtempSync(path.join(dir, 'py-'));
    fs.mkdirSync(path.join(root, 'model'));
    return root;
  };

  test('the project venv is preferred over the PATH, then python3, then python', async () => {
    const root = freshRoot();
    const bin = path.join(root, 'bin');
    const onPath = fakePython(bin, { version: [3, 10, 0] });
    fs.copyFileSync(onPath, path.join(bin, 'python3'));
    fs.chmodSync(path.join(bin, 'python3'), 0o755);
    assert.equal((await findPython({ root, env: { PATH: bin } })).label, 'python3');
    fakePython(path.join(root, 'model', '.venv', 'bin'), { version: [3, 11, 4] });
    const found = await findPython({ root, env: { PATH: bin } });
    assert.equal(found.label, path.join('model', '.venv', 'bin', 'python'));
    assert.equal(found.version, '3.11.4');
    assert.deepEqual(found.args, []);
  });

  test('a Python without the packages is skipped for one that has them', async () => {
    const root = freshRoot();
    fakePython(path.join(root, 'model', '.venv', 'bin'), { missing: ['cv2'] });
    const good = fakePython(path.join(root, 'good'));
    const found = await findPython({ root, env: { PATH: path.dirname(good) } });
    assert.equal(found.label, 'python');
    assert.equal(found.version, '3.12.1');
  });

  test('when none has the packages, the message names what is missing and how to fix it', async () => {
    const root = freshRoot();
    fakePython(path.join(root, 'model', '.venv', 'bin'), { missing: ['cv2', 'flask'] });
    const result = await findPython({ root, env: { PATH: path.join(root, 'empty') } });
    assert.match(result.error, /not installed in model\/\.venv\/bin\/python \(missing: cv2, flask\)\. Run: npm run setup:model/);
    assert.match(result.error, /pip install -r model\/requirements\.txt/);
  });

  test('a Python that is too old is said to be too old', async () => {
    const root = freshRoot();
    const old = fakePython(path.join(root, 'old'), { version: [3, 7, 9] });
    const result = await findPython({ root, env: { PATH: path.dirname(old) } });
    assert.match(result.error, /python is Python 3\.7\.9, but the model service needs Python 3\.9 or newer/);
  });

  test('no Python anywhere: say so plainly', async () => {
    const root = freshRoot();
    const result = await findPython({ root, env: { PATH: path.join(root, 'empty') } });
    assert.match(result.error, /^Python was not found, so the model service cannot start\. Install Python 3\.9 or newer, then run: npm run setup:model/);
  });

  test('the candidate list: PYTHON alone; otherwise venvs then the system names (Windows: py -3)', () => {
    assert.deepEqual(pythonCandidates({ root: '/p', python: '/x/py' }), [{ command: '/x/py', args: [], local: false }]);
    assert.deepEqual(pythonCandidates({ root: '/p', platform: 'linux' }).map((c) => c.command), [path.join('/p', 'model', '.venv', 'bin', 'python'), path.join('/p', '.venv', 'bin', 'python'), 'python3', 'python']);
    const win = pythonCandidates({ root: 'C:\\p', platform: 'win32' });
    assert.deepEqual(win.map((c) => c.command).slice(2), ['py', 'python', 'python3']);
    assert.deepEqual(win[2].args, ['-3']);
    assert.ok(win[0].command.endsWith(path.join('Scripts', 'python.exe')));
  });
});
