/**
 * Runs python/gallery_resolve.py (gallery-dl, in the website's own Python environment, python/.venv) for one address.
 *
 * The program fetches whatever it is given, so everything around it is strict:
 *   - it is started without a shell, with a time limit, an output limit and a bare environment (no secrets);
 *   - the request names the one extractor that may run (from the site registry), and the program refuses all others;
 *   - what comes back is read as data: only https picture addresses on the site's own picture hosts (`cdn`) are kept, so an answer
 *     can never point somewhere else.
 * Nothing is downloaded here: the answer is picture addresses, sizes and titles.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isCdnOf } from '../../../site/inspiration/sources.js';

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** An import that failed, with the answer to give. `reason` is a short code the page acts on; `status` is the HTTP status. */
export class ImportError extends Error {
  constructor(reason, status, message, retryAfter) {
    super(message);
    this.reason = reason;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export const MESSAGES = {
  'not-found': [404, 'We could not find that. Check the address, and that it is public.'],
  private: [422, 'That looks private, or it needs a sign-in. Only public pictures can be imported. You can save the picture and upload it instead.'],
  blocked: [502, 'The site did not let us read that just now. Please try again later, or upload the picture instead.'],
  empty: [404, 'We found no picture we can use at that address.'],
  timeout: [504, 'The site took too long to answer. Please try again.'],
  failed: [502, 'We could not read that right now. Please try again later.'],
  unsupported: [422, 'We cannot read that kind of address.'],
};

/** A fresh error for a code in MESSAGES. */
export function failure(reason) {
  const [status, message] = MESSAGES[reason] ?? MESSAGES.failed;
  return new ImportError(MESSAGES[reason] ? reason : 'failed', status, message);
}

/** A title from outside, as plain one-line text. */
const tidy = (text) => (typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, 140) : '');

const httpsUrl = (text) => {
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null;
  } catch {
    return null;
  }
};

/**
 * @param {object} options
 * @param {() => {enabled: boolean, python: string, script: string, limit: number, timeoutMs: number}} options.settings read on every use
 * @param {{warn: Function}} [options.log]
 * @param {typeof execFile} [options.exec] tests
 */
export function createGalleryRunner({ settings, log, exec = execFile }) {
  let home = null;
  /** gallery-dl wants a home folder; a private empty one, never the server's own. */
  const homeDir = () => {
    if (!home) {
      home = path.join(os.tmpdir(), 'terucon-gallery-home');
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    }
    return home;
  };

  return {
    /** Whether the importer can run here: switched on, and its Python and script exist. */
    ready() {
      const cfg = settings();
      return cfg.enabled && fs.existsSync(cfg.python) && fs.existsSync(cfg.script);
    },

    /**
     * @param {{url: string, sourceId: string, extractor: string, follows?: string[], options: object, thumbs?: string, firstOnly?: boolean}} job
     * @returns {Promise<{title: string, extractor: string, items: {url: string, width: number | null, height: number | null, title: string, thumb?: string}[]}>}
     */
    run(job) {
      const cfg = settings();
      const seconds = Math.max(5, Math.floor(cfg.timeoutMs / 1000) - 5); // the program stops itself a little before we would
      const request = JSON.stringify({ url: job.url, allow: [job.extractor], follow: job.follows ?? [], options: job.options ?? {}, thumbs: job.thumbs ?? null, limit: job.firstOnly ? 1 : cfg.limit, seconds });
      return new Promise((resolve, reject) => {
        exec(
          cfg.python,
          [cfg.script, request],
          { cwd: path.dirname(cfg.script), timeout: cfg.timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT_BYTES, env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', HOME: homeDir() }, windowsHide: true },
          (error, stdout) => {
            if (error?.killed) return reject(failure('timeout'));
            if (error && !stdout) {
              log?.warn(`inspiration  the importer did not run: ${error.code ?? error.message}`);
              return reject(new ImportError('not-set-up', 503, 'Importing from links is not set up on this server yet.'));
            }
            try {
              resolve(this.read(stdout, job));
            } catch (e) {
              reject(e);
            }
          },
        );
      });
    },

    /** Read what the program printed. Throws ImportError. */
    read(stdout, job) {
      let answer;
      try {
        answer = JSON.parse(stdout);
      } catch {
        throw failure('failed');
      }
      if (answer?.ok === true) {
        const cap = job.firstOnly ? 1 : settings().limit;
        const seen = new Set();
        const items = [];
        let dropped = 0;
        for (const raw of Array.isArray(answer.items) ? answer.items : []) {
          const url = httpsUrl(raw?.url);
          if (!url || !isCdnOf(job.sourceId, url.hostname) || seen.has(url.href)) {
            dropped += url && !isCdnOf(job.sourceId, url.hostname) ? 1 : 0;
            continue;
          }
          seen.add(url.href);
          const thumb = httpsUrl(raw.thumb);
          const dims = (n) => (Number.isInteger(n) && n > 0 && n <= 100000 ? n : null);
          items.push({
            url: url.href,
            width: dims(raw.width),
            height: dims(raw.height),
            title: tidy(raw.title),
            ...(thumb && isCdnOf(job.sourceId, thumb.hostname) ? { thumb: thumb.href } : {}),
          });
          if (items.length >= cap) break;
        }
        if (dropped) log?.warn(`inspiration  ${job.sourceId}: ${dropped} picture address(es) on a host outside its list were ignored; if every picture of this site is ignored, its "cdn" list in site/inspiration/sources.js is out of date`);
        if (!items.length) throw failure('empty');
        return { title: tidy(answer.title), extractor: String(answer.extractor ?? job.extractor), items };
      }
      if (answer?.reason === 'not-installed') throw new ImportError('not-set-up', 503, 'Importing from links is not set up on this server yet.');
      throw failure(answer?.reason);
    },
  };
}
