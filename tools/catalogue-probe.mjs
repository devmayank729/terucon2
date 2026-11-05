#!/usr/bin/env node
// Send photos (or a sentence) to the REAL catalogue search app on Modal and keep each RAW answer, so the closest-item search can be measured
// (catalogue/tools/accuracy_eval.py reads the saved answers; catalogue/ARCHITECTURE.md section 5.1).
//
//   node tools/catalogue-probe.mjs <jobs.json> --release rel-YYYYMMDDHHMMSS-xxxxxx [--catalogue superbond-colour] [--out <folder>] [--again]
//
//   jobs.json: [{ "name": "A_box", "file": "real_patch_A.jpg", "query": { "profile": "full", "k": 60, "box": [0, 0, 1, 1] } },
//               { "name": "T_oak", "text": "light oak wood laminate", "query": { "k": 60 } }]
//   `file` is read relative to the jobs file; `query` takes mode, profile, k, point, radius, box, category, finish (the search app's own parameters).
//   Answers go to <out>/<name>.json as { job, answer } (default <out> = an `answers` folder next to the jobs file); a name that already has an answer is skipped
//   unless --again. Calls are sent ONE AT A TIME (the GPU wakes slowly: the first one may take about 20 s) and a busy or waking answer is retried up to 3 times.
//
// What it reads: the Modal address and key from .env (the same settings the website uses), in memory, to make the calls; it prints a line per call (name, time, how
// the photo was prepared, the first three item ids) and never a key or an address. Each call is a real search on a real GPU: it costs a little and counts nothing
// against any visitor's limit. Keep a probe to a few dozen calls. It reads nothing from MongoDB and writes nothing anywhere but <out>.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

/**
 * Run the jobs one after another.
 * @param {object} p
 * @param {Array<{name: string, file?: string, text?: string, query?: object}>} p.jobs
 * @param {string} p.dir where the jobs' photos are
 * @param {string} p.out where the answers are written
 * @param {ReturnType<typeof import('../server/catalogue/modalClient.js').createModalClient>} p.modal
 * @param {string} p.release the live release id
 * @param {string} [p.catalogue]
 * @param {boolean} [p.again] ask again for a name that already has an answer
 * @param {(line: string) => void} [p.print]
 * @param {(ms: number) => Promise<void>} [p.sleep]
 * @returns {Promise<{calls: number, saved: string[], skipped: string[], failed: string[]}>}
 */
export async function runJobs({ jobs, dir, out, modal, release, catalogue = 'superbond-colour', again = false, print = console.log, sleep = wait }) {
  fs.mkdirSync(out, { recursive: true });
  const result = { calls: 0, saved: [], skipped: [], failed: [] };
  for (const job of jobs) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(String(job.name ?? ''))) throw new Error(`A job needs a plain name (letters, digits, dot, dash, underscore), got ${JSON.stringify(job.name)?.slice(0, 40)}.`);
    const target = path.join(out, `${job.name}.json`);
    if (fs.existsSync(target) && !again) {
      result.skipped.push(job.name);
      print(`skip (have it) ${job.name}`);
      continue;
    }
    const started = Date.now();
    let answer = null;
    for (let attempt = 1; attempt <= 3 && !answer; attempt += 1) {
      try {
        result.calls += 1;
        if (job.text) answer = await modal.searchText({ catalogue, release, text: job.text, k: job.query?.k ?? 60 });
        else {
          const file = path.resolve(dir, job.file ?? '');
          const type = TYPES[path.extname(file).toLowerCase()];
          if (!type) throw new Error(`${job.name}: a photo must be .jpg, .png or .webp`);
          answer = await modal.search({ bytes: fs.readFileSync(file), contentType: type, query: { catalogue, release, mode: 'look', profile: 'full', k: 60, ...job.query } });
        }
      } catch (error) {
        const waiting = error?.reason === 'warming' || error?.reason === 'busy';
        print(`  ${job.name}: attempt ${attempt} ${error?.reason ?? error?.name ?? 'failed'}${waiting && attempt < 3 ? ', trying again' : ''}`);
        if (!waiting) break;
        await sleep((error.retryAfter ?? 5) * 1000);
      }
    }
    if (!answer) {
      result.failed.push(job.name);
      print(`FAILED ${job.name}`);
      continue;
    }
    fs.writeFileSync(target, JSON.stringify({ job, answer }, null, 1));
    result.saved.push(job.name);
    const top = answer.results.slice(0, 3).map((r) => String(r.itemId).slice(-9)).join(' ');
    print(`${job.name} ${Date.now() - started} ms ${answer.query?.preprocessing ?? '?'} ${answer.results.length} results, first ${top}, ${(answer.query?.warnings ?? []).length} warnings`);
  }
  print(`live calls made: ${result.calls}`);
  return result;
}

async function cli(argv) {
  const args = argv.slice(2);
  const value = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : null);
  const jobsFile = args.find((a, i) => !a.startsWith('--') && !['--release', '--catalogue', '--out'].includes(args[i - 1]));
  const release = value('--release');
  if (!jobsFile || !/^rel-\d{14}-[0-9a-f]{6}$/.test(release ?? '')) {
    console.log('usage: node tools/catalogue-probe.mjs <jobs.json> --release rel-YYYYMMDDHHMMSS-xxxxxx [--catalogue <id>] [--out <folder>] [--again]');
    return 1;
  }
  const { SettingsManager } = await import(pathToFileURL(path.join(ROOT, 'server/config/settings.js')).href);
  const { catalogueConfig } = await import(pathToFileURL(path.join(ROOT, 'server/catalogue/config.js')).href);
  const { createModalClient } = await import(pathToFileURL(path.join(ROOT, 'server/catalogue/modalClient.js')).href);
  const manager = new SettingsManager(path.join(ROOT, '.env'), { ...process.env }, ROOT);
  const modal = createModalClient({ target: () => catalogueConfig(manager.get()), log: { warn: (m) => console.log('WARN', String(m).slice(0, 120)), info() {} } });
  if (!modal.configured().search) {
    console.log('The search app is not set up in .env (CATALOGUE_MODAL_SEARCH_URL and CATALOGUE_MODAL_KEY).');
    return 1;
  }
  const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
  const dir = path.dirname(path.resolve(jobsFile));
  const result = await runJobs({ jobs, dir, out: value('--out') ?? path.join(dir, 'answers'), modal, release, catalogue: value('--catalogue') ?? 'superbond-colour', again: args.includes('--again') });
  return result.failed.length ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv).then((code) => process.exit(code), (error) => {
    const message = String(error?.message ?? '');
    console.log('probe stopped:', error?.name ?? 'Error', /[{"]/.test(message) ? '' : message.slice(0, 160)); // never echo a message that might carry a setting's text
    process.exit(1);
  });
}
