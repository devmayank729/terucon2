/**
 * Runs the Python model service as a child process and keeps it running.
 *
 * The child binds its port first and then prints one line, `TERUCON_MODEL_READY http://127.0.0.1:<port>`;
 * that line is how we learn the port. Anything else it prints is passed on with a "[model] " prefix.
 * If it exits unexpectedly it is restarted after 1, 2, 4, 8 and 16 seconds; the sixth exit within ten
 * minutes means something is really wrong, so it stays down with the reason. Nothing here ever throws into
 * request handling: the site works without Python, and the state says why the service is missing.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { findPython } from './python.js';

const READY_LINE = /^TERUCON_MODEL_READY\s+(\S+)\s*$/;
const KEEP_FROM_PROCESS = ['PATH', 'SYSTEMROOT', 'LANG', 'LC_ALL', 'TMPDIR'];
export const DEFAULT_BACKOFF_SECONDS = [1, 2, 4, 8, 16];

/**
 * The child's environment. With an explicit `environ` (tests, embedding) nothing else of the real process
 * environment is inherited except what any program needs to start.
 * @param {{environ?: Record<string, string>, envFile: string, key: string}} options
 */
export function buildChildEnv({ environ, envFile, key }) {
  const inherited = environ === undefined ? process.env : { ...Object.fromEntries(KEEP_FROM_PROCESS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])), ...environ };
  return {
    ...inherited,
    TERUCON_ENV_FILE: envFile,
    MODEL_HOST: '127.0.0.1',
    MODEL_PORT: '0',
    MODEL_SERVICE_KEY: key,
    MODEL_PARENT_PID: String(process.pid),
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
}

export class ModelSupervisor extends EventEmitter {
  #opts;
  #child = null;
  #launchSpec = null; // {command, args}, found once and reused by restarts
  #state = { state: 'idle', url: '', error: 'The model service has not been started.' };
  #restarts = []; // when the recent restarts happened
  #restartTimer = null;
  #stopping = false;
  #killOnExit = () => this.#child?.kill('SIGKILL');

  /**
   * @param {object} options
   * @param {string} options.root project folder (the service lives in <root>/model)
   * @param {Record<string, string>} options.env the child's environment (see buildChildEnv)
   * @param {{info: Function, warn: Function, raw: Function}} options.log
   * @param {string} [options.python] explicit interpreter
   * @param {string} [options.command] run this instead of "python -m terucon_model" (tests)
   * @param {string[]} [options.args]
   * @param {number} [options.startTimeoutMs]
   * @param {number[]} [options.backoffSeconds] restart delays; its length is also the restart limit
   * @param {number} [options.windowMs] period the restart limit applies to
   * @param {number} [options.killGraceMs] how long SIGTERM gets before SIGKILL
   * @param {() => number} [options.clock]
   */
  constructor(options) {
    super();
    this.#opts = { startTimeoutMs: 90_000, backoffSeconds: DEFAULT_BACKOFF_SECONDS, windowMs: 600_000, killGraceMs: 3000, clock: Date.now, ...options };
  }

  /** @returns {{state: 'idle' | 'starting' | 'ready' | 'unavailable', url: string, error: string}} */
  get state() {
    return { ...this.#state };
  }

  start() {
    if (this.#state.state !== 'idle') return;
    process.on('exit', this.#killOnExit);
    this.#launch();
  }

  /** Stop the child (SIGTERM, then SIGKILL after the grace period) and everything scheduled. */
  async stop() {
    this.#stopping = true;
    clearTimeout(this.#restartTimer);
    process.off('exit', this.#killOnExit);
    const child = this.#child;
    if (child) await this.#terminate(child);
    this.#state = { state: 'unavailable', url: '', error: 'The model service was stopped.' };
  }

  #setState(state, url = '', error = '') {
    this.#state = { state, url, error };
    this.emit('state', this.state);
  }

  async #launch() {
    this.#setState('starting');
    try {
      if (!this.#launchSpec) {
        const spec = await this.#chooseCommand();
        if (this.#stopping) return;
        if (spec.error) return this.#setState('unavailable', '', spec.error);
        this.#launchSpec = spec;
      }
      if (!this.#stopping) this.#spawn(this.#launchSpec);
    } catch (err) {
      this.#setState('unavailable', '', `The model service could not be started: ${err.message}`);
    }
  }

  async #chooseCommand() {
    const { root, command, args = [], python, env, log } = this.#opts;
    if (command) return { command, args };
    if (!fs.existsSync(path.join(root, 'model', 'terucon_model'))) {
      return { error: 'The model service is not installed: the folder model/terucon_model is missing. Check that the project folder is complete.' };
    }
    const found = await findPython({ root, python, env });
    if (found.error) return found;
    log.info(`[model] using ${found.label} (Python ${found.version})`);
    return { command: found.command, args: [...found.args, '-m', 'terucon_model'] };
  }

  #spawn({ command, args }) {
    const { root, env, log, startTimeoutMs } = this.#opts;
    const modelDir = path.join(root, 'model');
    const child = spawn(command, args, { cwd: fs.existsSync(modelDir) ? modelDir : root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const run = { ready: false, abandoned: false, timer: null };
    this.#child = child;
    run.timer = setTimeout(() => {
      if (run.ready) return;
      run.abandoned = true; // a slow start is not a crash: do not restart it in a loop
      this.#setState('unavailable', '', `The model service did not become ready within ${Math.round(startTimeoutMs / 1000)} seconds. The first start can be slow (Python libraries, models); raise MODEL_START_TIMEOUT if it needs longer.`);
      this.#terminate(child);
    }, startTimeoutMs);

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const match = run.ready ? null : READY_LINE.exec(line);
      if (!match) return log.raw(`[model] ${line}`);
      clearTimeout(run.timer);
      run.ready = true;
      if (!this.#stopping && this.#child === child) this.#setState('ready', match[1]);
    });
    readline.createInterface({ input: child.stderr }).on('line', (line) => log.raw(`[model] ${line}`));

    child.once('error', (err) => {
      // the program could not be started at all (it vanished since it was found): restarting will not help
      if (this.#child !== child) return;
      clearTimeout(run.timer);
      this.#child = null;
      this.#setState('unavailable', '', `The model service could not be started (${err.code ?? err.message}).`);
    });
    child.once('exit', (code, signal) => this.#onExit(child, run, code, signal));
  }

  #onExit(child, run, code, signal) {
    clearTimeout(run.timer);
    if (this.#child !== child) return;
    this.#child = null;
    if (this.#stopping || run.abandoned) return;
    const why = code === null ? `signal ${signal}` : `exit code ${code}`;
    const { backoffSeconds, windowMs, clock } = this.#opts;
    const now = clock();
    this.#restarts = this.#restarts.filter((t) => now - t < windowMs);
    if (this.#restarts.length >= backoffSeconds.length) {
      this.#setState('unavailable', '', `The model service stopped unexpectedly (${why}) again and was restarted ${this.#restarts.length} times in the last ${Math.round(windowMs / 60_000)} minutes, so it is not restarted any more. The [model] lines above say what went wrong.`);
      return;
    }
    const delay = backoffSeconds[this.#restarts.length];
    this.#restarts.push(now);
    this.#setState('unavailable', '', `The model service stopped unexpectedly (${why}). Restarting in ${delay} s.`);
    this.#restartTimer = setTimeout(() => this.#launch(), delay * 1000);
  }

  /** SIGTERM, then SIGKILL once the grace period is over; resolves when the process is gone. */
  #terminate(child) {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return resolve();
      const killer = setTimeout(() => child.kill('SIGKILL'), this.#opts.killGraceMs);
      child.once('exit', () => {
        clearTimeout(killer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}
