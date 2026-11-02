/**
 * What the process does when something nobody caught goes wrong (`uncaughtException`, `unhandledRejection`).
 *
 * Node's own default is the same end (since Node 15 an unhandled rejection is thrown, and an uncaught exception ends the
 * process) but silent about our side of it: the connections are cut and nothing says which request or why. A process that has
 * hit a bug it did not expect is in an unknown state, so it must not go on serving, but it can still say what happened and
 * let the requests in flight finish: log the error (with the one-line logger of the project), stop accepting new connections
 * and close the server, then leave with a non-zero code so the platform (Render, Docker's restart policy) starts a fresh one.
 * A second failure while closing only adds a log line; a close that takes longer than `graceMs` is not waited for.
 */

/**
 * @param {object} options
 * @param {{error: (message: string) => void}} options.log
 * @param {() => Promise<void>} options.close close the server (app.js: the same close the SIGTERM handler uses)
 * @param {(code: number) => void} [options.exit] default process.exit
 * @param {Pick<NodeJS.Process, 'on' | 'off'>} [options.proc] default process (tests pass an EventEmitter)
 * @param {number} [options.graceMs]
 * @returns {() => void} removes the handlers
 */
export function installCrashHandlers({ log, close, exit = (code) => process.exit(code), proc = process, graceMs = 5000 }) {
  let leaving = false;
  const describe = (reason) => String(reason?.stack ?? reason).replace(/(\w[\w+.-]*:\/\/)[^\s/@]+@/g, '$1***@');
  const fail = (kind) => async (reason) => {
    log.error(`${kind}  ${describe(reason)}`);
    if (leaving) return;
    leaving = true;
    log.error('stopping: this process will exit now so that it can be restarted');
    const timer = setTimeout(() => exit(1), graceMs);
    timer.unref?.();
    try {
      await close();
    } catch (error) {
      log.error(`could not close cleanly: ${describe(error)}`);
    }
    clearTimeout(timer);
    exit(1);
  };
  const onException = fail('uncaught exception');
  const onRejection = fail('unhandled rejection');
  proc.on('uncaughtException', onException);
  proc.on('unhandledRejection', onRejection);
  return () => {
    proc.off('uncaughtException', onException);
    proc.off('unhandledRejection', onRejection);
  };
}
