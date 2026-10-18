// Shared by tests/js/overview-*.test.js. Not a test file.
// makeProject() builds a small, valid, throw-away project in a temp folder: a handful of files, a complete minimal
// catalog, and the real page shell (template, styles, script) copied from docs/overview/, so the generator can be run on it
// without touching the real tree, which other work changes all the time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const write = (root, rel, text) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`);
};

export function minimalCatalog() {
  return {
    meta: {
      title: 'Mini overview', tagline: 'A tiny project', hero: { eyebrow: 'Mini', heading: 'Hello', lead: 'A lead.', facts: [] },
      owners: { website: { label: 'Website (JS)', blurb: '' }, model: { label: 'Model (Python)', blurb: '' }, docs: { label: 'Docs', blurb: '' }, tests: { label: 'Tests', blurb: '' }, tooling: { label: 'Tooling', blurb: '' }, 'site-data': { label: 'Site data', blurb: '' }, private: { label: 'Private', blurb: '' } },
      tags: { Run: 'run', Edit: 'edit', Generated: 'generated', Source: 'source', Private: 'private', Optional: 'optional', Dev: 'dev' },
      languages: ['JavaScript', 'Python', 'JSON', 'HTML', 'CSS', 'Markdown'], generatedFrom: 'test', docs: [], baseline: null, scan: { ignore: [] }, provisional: [],
    },
    files: {
      dirs: { 'src/': 'Source.', 'tests/': 'Tests.', 'docs/': 'Docs.', 'docs/overview/': 'Overview.', 'docs/overview/catalog/': 'Catalog.', 'site/': 'Site.' },
      files: [
        { match: 'package.json', owner: 'tooling', tags: ['Edit'], desc: 'The package.' },
        { match: '.env.example', owner: 'website', tags: ['Edit'], desc: 'The settings template.' },
        { match: 'src/a.js', owner: 'website', tags: ['Run'], desc: 'The JavaScript.' },
        { match: 'src/b.py', owner: 'model', tags: ['Edit'], desc: 'The Python.' },
        { match: 'tests/js/a.test.js', owner: 'tests', tags: ['Dev'], desc: 'A test.' },
        { match: 'site/site.json', owner: 'site-data', tags: ['Edit'], desc: 'The site.' },
        { match: 'docs/PROJECT_OVERVIEW.html', owner: 'docs', tags: ['Generated'], desc: 'The page.' },
        { match: 'docs/overview/*.{html,css,js}', owner: 'docs', tags: ['Edit'], desc: 'The shell.' },
        { match: 'docs/overview/catalog/*.json', owner: 'docs', tags: ['Edit'], desc: 'The catalog.' },
      ],
    },
    architecture: { view: { w: 400, h: 200 }, kinds: { client: 'Browser', server: 'Server' }, nodes: [{ id: 'a', label: 'A', sub: '', kind: 'client', x: 10, y: 10, w: 100, h: 40, summary: 's', responsibilities: [], files: ['src/a.js'], env: [], ports: '' }, { id: 'b', label: 'B', sub: '', kind: 'server', x: 200, y: 10, w: 100, h: 40, summary: 's', responsibilities: [], files: [], env: [], ports: '' }], edges: [{ id: 'e', from: 'a', to: 'b', fromSide: 'r', toSide: 'l', label: 'x' }] },
    flows: { flows: [{ id: 'f', title: 'A flow', summary: 's', steps: [{ title: 'One', text: 't', nodes: ['a'], edges: [], file: 'src/a.js', fn: 'hello' }] }] },
    api: { intro: 'i', errorShape: '{}', groups: [{ id: 'g', title: 'G', blurb: 'b' }], routes: [{ method: 'GET', path: '/api/x', owner: 'JS', group: 'g', guards: ['Host'], summary: 's', request: 'r', response: 'r', errors: [], curl: 'curl x' }] },
    env: {
      precedence: { intro: 'i', steps: [], envFileNote: 'n' }, groups: [{ id: 'g', title: 'G', blurb: 'b' }], notes: [],
      vars: [{ name: 'HOST', group: 'g', default: '127.0.0.1', readBy: 'Node', secret: false, effect: 'Where.' }, { name: 'PORT', group: 'g', default: '8080', readBy: 'Node', secret: false, effect: 'Port.' }, { name: 'SECRET', group: 'g', default: '', readBy: 'both', secret: true, effect: 'Shh.' }, { name: 'TEST_ONLY', group: 'g', default: '', readBy: 'Node', secret: false, notInExample: 'tests only', effect: 'Hidden.' }],
    },
    tests: { intro: 'i', suites: [{ id: 'js', title: 'JS', runner: 'node:test', counter: 'node-test', command: 'npm test', files: ['tests/js/*.test.js'], needs: 'n', proves: ['p'] }], checks: [] },
    troubleshooting: { rows: [] },
    boundary: { intro: 'i', rows: [], seam: { title: 's', points: [] }, finetuning: [], finetuning_intro: 'x' },
    commands: { groups: [{ id: 'run', title: 'Run' }], npm: [{ script: 'start', group: 'run', desc: 'Start.' }, { script: 'test', group: 'run', desc: 'Test.' }], extra: [] },
  };
}

/** @param {{catalog?: (c: object) => void, files?: Record<string, string>}} [options] */
export function makeProject({ catalog: tweak, files = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-test-'));
  write(root, 'package.json', { name: 'mini', version: '1.2.3', scripts: { start: 'node src/a.js', test: 'node --test' }, dependencies: {} });
  write(root, '.env.example', 'HOST=127.0.0.1\n# PORT=8080\nSECRET=\n');
  write(root, 'src/a.js', 'export function hello() { return 1; }\n');
  write(root, 'src/b.py', 'def hi():\n    return 1\n');
  write(root, 'tests/js/a.test.js', "import test from 'node:test';\ntest('one', () => {});\ntest('two', () => {});\n");
  write(root, 'site/site.json', { name: 'Mini', pages: {}, connections: {}, legacy_names: {}, docs: {}, media: {} });
  for (const f of ['template.html', 'overview.css', 'dark-tokens.css', 'theme-boot.js', 'overview.js']) {
    write(root, `docs/overview/${f}`, fs.readFileSync(path.join(ROOT, 'docs/overview', f), 'utf8'));
  }
  const catalog = minimalCatalog();
  if (tweak) tweak(catalog);
  for (const [part, value] of Object.entries(catalog)) write(root, `docs/overview/catalog/${part}.json`, value);
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  return { root, write: (rel, text) => write(root, rel, text), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** run() with its output captured. */
export async function runCli(run, root, argv) {
  const out = [];
  const err = [];
  const code = await run(root, argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
