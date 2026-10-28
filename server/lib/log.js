/** One-line logs: "HH:MM:SS  message". */

const two = (n) => String(n).padStart(2, '0');

/**
 * @param {{out?: NodeJS.WritableStream, err?: NodeJS.WritableStream, now?: () => Date}} [options]
 */
export function createLogger({ out = process.stdout, err = process.stderr, now = () => new Date() } = {}) {
  const stamp = () => {
    const d = now();
    return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  };
  return {
    info: (message) => out.write(`${stamp()}  ${message}\n`),
    warn: (message) => err.write(`${stamp()}  ${message}\n`),
    error: (message) => err.write(`${stamp()}  ${message}\n`),
    /** A line that already carries its own timestamp. */
    raw: (line) => out.write(`${line}\n`),
  };
}
