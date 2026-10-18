import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Bundle,
  PatchError,
  buildPage,
  buildSite,
  checkSyntax,
  countOccurrences,
  jsString,
  makeContext,
  makeHref,
  patchText,
  pyQuote,
  relinkText,
  renderComponent,
  scanJsString,
  validatePatchSpec,
} from '../../tools/build-site.js';
import { PAGE_KEYS, PRISTINE, ROOT, SITE, makeTempRoot, memoBuild, removeTempRoot } from './site-helpers.js';

const patchFile = (key) => path.join(ROOT, 'site', 'patches', `${key}.json`);
const readSpec = (key) => JSON.parse(fs.readFileSync(patchFile(key), 'utf8'));
const components = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'components.json'), 'utf8'));
const routeHref = makeHref(SITE, 'route');
const fileHref = makeHref(SITE, 'file');

function leaves(steps, prefix = '') {
  return steps.flatMap((s) => (s.steps ? leaves(s.steps, prefix + s.id + '/') : [{ path: prefix + s.id, step: s }]));
}

const throwsPatch = (fn, ...patterns) =>
  assert.throws(fn, (e) => {
    assert.ok(e instanceof PatchError, `expected a PatchError, got ${e?.name}: ${e?.message}`);
    for (const p of patterns) assert.match(e.message, p);
    return true;
  });

// ---- the real patches ----------------------------------------------------------------------------------

for (const key of PAGE_KEYS) {
  test(`${key}: every step of site/patches/${key}.json is applied, exactly once`, () => {
    const spec = readSpec(key);
    const expected = leaves(spec.steps).map((l) => l.path);
    const got = memoBuild('route').results.find((r) => r.key === key).notes.map((n) => n.split(': ')[0]);
    assert.equal(new Set(got).size, got.length, 'a step was reported twice');
    assert.deepEqual([...got].sort(), [...expected].sort());
    assert.ok(expected.length > 0);
  });

  test(`${key}: the anchors of the template and app steps occur exactly once in the pristine export`, () => {
    const spec = readSpec(key);
    const b = Bundle.load(PRISTINE[key]);
    for (const step of spec.steps) {
      if (step.op === 'inJsString') continue; // inside the worker string: checked by the build itself
      const text = !step.target || step.target === 'template' ? b.template : b.assetText(b.extUuid(step.target.slice(6)));
      for (const l of leaves(step.steps || [step])) {
        if (l.step.anchor === undefined || l.step.op === 'replaceAll') continue;
        assert.equal(countOccurrences(text, l.step.anchor), 1, `${key}/${step.id}/${l.step.id}`);
      }
    }
  });
}

test('every step has a why, ids are unique, every file passes validation', () => {
  for (const key of PAGE_KEYS) {
    const spec = readSpec(key);
    validatePatchSpec(spec, key);
    for (const l of leaves(spec.steps)) assert.ok(l.step.why.length > 10, `${key}/${l.path} needs a real explanation`);
  }
});

test('home: header, menu and footer entries are added once each, as route links', () => {
  const t = memoBuild('route').results.find((r) => r.key === 'home').bundle.template;
  assert.equal(countOccurrences(t, '<a href="/materials" data-m="display:none" style="display:flex;align-items:center;gap:8px'), 1);
  assert.equal(countOccurrences(t, '<a href="/my-project" data-m="display:none" style="display:flex;align-items:center;gap:8px'), 1);
  assert.equal(countOccurrences(t, '>Open My project →</span>'), 1);
  assert.equal(countOccurrences(t, '>Shop materials →</span>'), 1);
  assert.equal(countOccurrences(t, '>Shop materials</a>'), 1);
  assert.ok(t.includes('&quot;mediaGuides&quot;:{&quot;editor&quot;:&quot;boolean&quot;,&quot;default&quot;:false'));
  assert.ok(t.includes('<a data-mstatus="" href="#"'));
  assert.ok(!t.includes('Media%20Brief'));
});

test('studio: server mode, Automatic engine and the three user-facing strings', () => {
  const { bundle } = memoBuild('route').results.find((r) => r.key === 'studio');
  const app = bundle.assetText(bundle.extUuid('swatchroomApp'));
  assert.ok(app.includes('Start the server (npm start) to use Google Cloud from your .env file'));
  assert.ok(app.includes('Start the server (npm start in the project folder) and open http://localhost:8080/design-studio instead.'));
  assert.ok(app.includes('Paste them into the .env file next to package.json (see .env.example)'));
  assert.ok(app.includes('/* ---- Terucon server mode (added by the site build, site/patches/studio.json)'));
  assert.ok(app.startsWith('/* Swatchroom (Terucon edition)'));
  assert.ok(app.includes('var srSrv=await('));
  assert.ok(app.includes('ht=srDefaults({version:4,'));
  assert.ok(app.includes('fetch(`/api/vertex/generate`'));
  assert.ok(!app.includes('SAM 3.1'));
  // the worker is still one single string literal, now double-quoted and without a raw "</"
  const at = app.indexOf('var Cn="');
  assert.ok(at > 0 && countOccurrences(app, 'var Cn=') === 1);
  const worker = scanJsString(app, at + 'var Cn='.length).value;
  assert.ok(worker.includes('function srIsExterior('));
  assert.ok(worker.includes('function ojBase(e){let t=ij(e);'));
  assert.ok(worker.includes('if(a===0||i.split===`drop`)continue;'));
});

test('nothing the build injects tells users to run a Python file or names the old tools', () => {
  for (const r of memoBuild('route').results) {
    const texts = [r.bundle.template];
    if (r.key === 'studio') texts.push(r.bundle.assetText(r.bundle.extUuid('swatchroomApp')));
    for (const t of texts) {
      assert.doesNotMatch(t, /run\.py|python run|\bpython\b|patch_swatchroom|build_site\.py|terucon_server/i, r.key);
    }
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'site', 'patches', 'snippets'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'site', 'patches', 'snippets', f), 'utf8'), /\.py\b|python/i, f);
  }
});

// ---- links ---------------------------------------------------------------------------------------------

test('pyQuote is urllib.parse.quote', () => {
  assert.equal(pyQuote('Terucon Swatchroom.html'), 'Terucon%20Swatchroom.html');
  assert.equal(pyQuote("a'b(c)!*.html"), 'a%27b%28c%29%21%2A.html');
  assert.equal(pyQuote('é ü~_-.'), '%C3%A9%20%C3%BC~_-.');
  assert.equal(pyQuote('a/b c'), 'a/b%20c');
  assert.equal(pyQuote('x+y&z=1?q#f'), 'x%2By%26z%3D1%3Fq%23f');
  assert.equal(pyQuote('日本.html'), '%E6%97%A5%E6%9C%AC.html');
});

test('makeHref: routes in route style, file names in file style, overridable names, loud on a wrong page', () => {
  assert.equal(routeHref('home'), '/');
  assert.equal(routeHref('home', '#enquire'), '/#enquire');
  assert.equal(routeHref('studio'), '/design-studio');
  assert.equal(fileHref('materials'), 'materials.html');
  assert.equal(fileHref('dashboard', '#x'), 'dashboard.html#x');
  assert.equal(makeHref(SITE, 'file', { studio: 'Terucon Swatchroom.html' })('studio'), 'Terucon%20Swatchroom.html');
  throwsPatch(() => routeHref('nope'), /unknown page "nope"/);
  throwsPatch(() => makeHref(SITE, 'weird'), /unknown link style "weird"/);
});

test('relink rewrites every legacy name, plain and %20 form, with #fragment, ?query, quotes and parentheses', () => {
  const cases = [
    ['href="Design Studio.dc.html"', 'href="/design-studio"', 'href="studio.html"'],
    ['href="Design%20Studio.dc.html#upload"', 'href="/design-studio#upload"', 'href="studio.html#upload"'],
    ["href='Swatchroom.dc.html?x=1&y=2'", "href='/design-studio?x=1&y=2'", "href='studio.html?x=1&y=2'"],
    ['go(`Terucon Home v2.html`)', 'go(`/`)', 'go(`index.html`)'.replace('index.html', 'home.html')],
    ['url(Terucon%20Home%20v2.html)', 'url(/)', 'url(home.html)'],
    ['href="Terucon%20_marketplace.dc.html#/saved" x', 'href="/materials#/saved" x', 'href="materials.html#/saved" x'],
    ['"Terucon landing page.html" "Terucon%20landing%20page.html"', '"/" "/"', '"home.html" "home.html"'],
  ];
  for (const [input, route, file] of cases) {
    assert.equal(relinkText(input, SITE, routeHref).text, route, 'route: ' + input);
    assert.equal(relinkText(input, SITE, fileHref).text, file, 'file: ' + input);
  }
  assert.equal(relinkText(cases.map((c) => c[0]).join(' '), SITE, routeHref).count, 8);
});

test('relink leaves look-alikes alone', () => {
  for (const s of ['xDesign Studio.dc.html"', 'my-Design Studio.dc.html"', '.Design Studio.dc.html"', '%Design Studio.dc.html"', 'Design Studio.dc.html.bak"', 'Design Studio.dc.htmlx"', 'Design Studio dc html"', 'Media%20Brief.dc.html"']) {
    assert.deepEqual(relinkText(s, SITE, routeHref), { text: s, count: 0 }, s);
  }
});

// ---- components ----------------------------------------------------------------------------------------

test('components render exactly the markup the old Python helpers wrote', () => {
  const header = (target, hide) =>
    `<a href="${target}"${hide ? ' data-m="display:none"' : ''} style="display:flex;align-items:center;gap:8px;color:inherit;font:500 13px/1 Switzer,Helvetica,Arial,sans-serif" style-hover="color:inherit;opacity:.75">Materials</a>`;
  assert.equal(renderComponent({ component: 'headerLink', entry: 'materials' }, components, routeHref, 't'), header('/materials', false));
  assert.equal(renderComponent({ component: 'headerLink', entry: 'materials', mobileHide: true }, components, routeHref, 't'), header('/materials', true));
  assert.equal(renderComponent({ component: 'headerLink', entry: 'materials', mobileHide: true }, components, fileHref, 't'), header('materials.html', true));
  assert.equal(
    renderComponent({ component: 'menuCard', entry: 'project' }, components, routeHref, 't'),
    '<a href="/my-project" style="display:flex;flex-direction:column;gap:10px;padding:26px;border:1px solid rgba(225,212,194,.2);color:#E1D4C2" style-hover="border-color:#E1D4C2;color:#E1D4C2"><span style="font:500 10.5px/1 Switzer,Helvetica,Arial,sans-serif;letter-spacing:.22em;text-transform:uppercase;color:#A78D78">Your project</span><span style="font:300 clamp(26px,2.4vw,36px)/1.1 Zodiak,Georgia,serif">Open My project →</span><span style="font:400 14px/1.5 Switzer,Helvetica,Arial,sans-serif;color:#BEB5A9">Your design, decisions, quote and materials in one place.</span></a>',
  );
  assert.equal(
    renderComponent({ component: 'footerLink', entry: 'project' }, components, routeHref, 't'),
    '<a href="/my-project" style="align-self:flex-start;font:400 15px/1.5 Switzer,sans-serif;color:#E1D4C2" style-hover="color:#FFFFFF">My project</a>',
  );
  assert.equal(
    renderComponent({ component: 'footerLinkUnderlined', entry: 'materials', label: 'Shop materials' }, components, routeHref, 't'),
    '<a href="/materials" style="align-self:flex-start;font:400 15px/1.5 Switzer,Helvetica,Arial,sans-serif;color:#E1D4C2;background:linear-gradient(#E1D4C2,#E1D4C2) 0 100%/0 1px no-repeat;transition:background-size .5s cubic-bezier(.2,.7,.2,1),color .3s" style-hover="background-size:100% 1px;color:#FFFFFF">Shop materials</a>',
  );
});

test('components: fragment, literal target, {{link:KEY}}, parameters of the step win over the entry', () => {
  const comps = {
    components: { a: '<a href="{{target}}">{{label}}</a>', b: '<a href="{{link:studio}}#x">{{label}}</a>{{#flag}}!{{/flag}}' },
    entries: { e: { page: 'materials', label: 'E' } },
  };
  const r = (part, href = routeHref) => renderComponent(part, comps, href, 'test');
  assert.equal(r({ component: 'a', entry: 'e' }), '<a href="/materials">E</a>');
  assert.equal(r({ component: 'a', entry: 'e', fragment: '#/saved', label: 'Saved' }), '<a href="/materials#/saved">Saved</a>');
  assert.equal(r({ component: 'a', entry: 'e' }, fileHref), '<a href="materials.html">E</a>');
  assert.equal(r({ component: 'a', target: 'https://example.org/', label: 'X' }), '<a href="https://example.org/">X</a>');
  assert.equal(r({ component: 'b', label: 'B' }), '<a href="/design-studio#x">B</a>');
  assert.equal(r({ component: 'b', label: 'B', flag: true }), '<a href="/design-studio#x">B</a>!');
  assert.equal(r({ component: 'b', label: '$& $1', flag: false }), '<a href="/design-studio#x">$& $1</a>', 'values are inserted literally');
});

test('components fail loudly: unknown component, entry, missing value, unused parameter, no page', () => {
  const comps = { components: { a: '<a href="{{target}}">{{label}}</a>' }, entries: { e: { page: 'home', label: 'E' } } };
  const r = (part) => renderComponent(part, comps, routeHref, 'home/step');
  throwsPatch(() => r({ component: 'zzz' }), /\[home\/step\] unknown component "zzz"/);
  throwsPatch(() => r({ component: 'a', entry: 'zzz' }), /unknown entry "zzz"/);
  throwsPatch(() => r({ component: 'a', page: 'home' }), /no value for \{\{label\}\}/);
  throwsPatch(() => r({ component: 'a', label: 'x' }), /needs a "page"/);
  throwsPatch(() => r({ component: 'a', entry: 'e', lable: 'typo' }), /no \{\{lable\}\}/);
  throwsPatch(() => r({ component: 'a', page: 'nope', label: 'x' }), /unknown page "nope"/);
});

test('only component bodies have placeholders: the pages\' own {{ savedN }} is untouched in anchors and text', () => {
  const steps = [{ id: 'x', op: 'insertAfter', why: 'keep the mustache', anchor: 'Saved{{ savedN }}</a>', insert: ['{{ also }} {{target}}', { component: 'headerLink', entry: 'project' }] }];
  const out = patchText('<a>Saved{{ savedN }}</a>', steps).text;
  assert.ok(out.startsWith('<a>Saved{{ savedN }}</a>{{ also }} {{target}}<a href="/my-project"'));
});

// ---- the operations, on plain strings ------------------------------------------------------------------

test('replace / insertAfter / insertBefore / replaceAll', () => {
  const run = (text, steps) => patchText(text, steps.map((s, i) => ({ id: `s${i}`, why: 'test step', ...s })));
  assert.equal(run('a[X]b', [{ op: 'replace', anchor: '[X]', with: '<1>' }]).text, 'a<1>b');
  assert.equal(run('a[X]b', [{ op: 'insertAfter', anchor: '[X]', insert: '+' }]).text, 'a[X]+b');
  assert.equal(run('a[X]b', [{ op: 'insertBefore', anchor: '[X]', insert: '+' }]).text, 'a+[X]b');
  assert.equal(run('a.a.a', [{ op: 'replaceAll', anchor: 'a', with: 'bb', count: 3 }]).text, 'bb.bb.bb');
  assert.equal(run('aaa', [{ op: 'replaceAll', anchor: 'aa', with: 'b', count: 1 }]).text, 'ba', 'non-overlapping, like str.count');
  assert.equal(run('abc', [{ op: 'replace', anchor: 'b', with: '' }]).text, 'ac');
  const notes = run('x', [{ op: 'replaceAll', anchor: 'x', with: 'y', count: 1 }, { op: 'relink', expect: 0 }]).notes;
  assert.deepEqual(notes, ['s0: test step (1)', 's1: test step (0 links)']);
});

test('replacement text is literal: $&, $\', $`, $$ and $1 come through unchanged', () => {
  const evil = "$& $' $` $$ $1 ${x}";
  const run = (steps) => patchText('a[X]b', steps.map((s, i) => ({ id: `s${i}`, why: 'test step', ...s }))).text;
  assert.equal(run([{ op: 'replace', anchor: '[X]', with: evil }]), 'a' + evil + 'b');
  assert.equal(run([{ op: 'insertAfter', anchor: '[X]', insert: evil }]), 'a[X]' + evil + 'b');
  assert.equal(run([{ op: 'insertBefore', anchor: '[X]', insert: evil }]), 'a' + evil + '[X]b');
  assert.equal(run([{ op: 'replaceAll', anchor: 'a', with: evil, count: 1 }]), evil + '[X]b');
});

test('an anchor that matches 0 times or 2 times fails loudly with page, step id and the anchor text', () => {
  const step = (anchor, op = 'replace') => ({ id: 'my-step', op, why: 'because of the thing', anchor, [op === 'replace' ? 'with' : 'insert']: 'x' });
  throwsPatch(() => patchText('abc', [step('zzz')]), /\[text\/my-step\]/, /because of the thing/, /anchor matched 0 times \(expected exactly 1\)/, /"zzz"/);
  throwsPatch(() => patchText('abab', [step('ab')]), /\[text\/my-step\]/, /anchor matched 2 times \(expected exactly 1\)/, /"ab"/);
  throwsPatch(() => patchText('abab', [step('ab', 'insertAfter')]), /matched 2 times/);
  throwsPatch(() => patchText('abab', [step('zz', 'insertBefore')]), /matched 0 times/);
  const long = 'q'.repeat(300);
  throwsPatch(() => patchText('abc', [step(long)]), new RegExp(`"${'q'.repeat(90)}…"`));
  throwsPatch(() => patchText('abab', [{ id: 'r', op: 'replaceAll', why: 'count', anchor: 'ab', with: 'x', count: 3 }]), /\[text\/r\] count: expected 3 occurrences of "ab", found 2/);
  throwsPatch(() => patchText('a.dc.html', [{ id: 'l', op: 'relink', why: 'links', expect: 4 }]), /expected 4 links to rewrite, found 0/);
});

test('the same failures name the page and the step when they happen in a real build', () => {
  const dash = (steps) => ({ page: 'dashboard', steps: steps.map((s, i) => ({ id: `step-${i}`, why: 'a test step', ...s })) });
  const failing = dash([{ op: 'replace', anchor: 'THIS TEXT IS NOT IN THE DASHBOARD', with: 'x' }]);
  throwsPatch(() => buildPage('dashboard', { patches: { dashboard: failing } }), /\[dashboard\/step-0\]/, /matched 0 times/, /THIS TEXT IS NOT IN THE DASHBOARD/);
  const twice = dash([{ op: 'replace', anchor: '<a ', with: '<a ' }]);
  throwsPatch(() => buildPage('dashboard', { patches: { dashboard: twice } }), /\[dashboard\/step-0\]/, /matched \d+ times \(expected exactly 1\)/);
  const inApp = {
    page: 'studio',
    steps: [{ id: 'app', op: 'group', why: 'the app', target: 'asset:swatchroomApp', steps: [{ id: 'gone', op: 'replace', why: 'an anchor that vanished', anchor: 'function noSuchFunctionInTheApp(){', with: 'x' }] }],
  };
  throwsPatch(() => buildPage('studio', { patches: { studio: inApp } }), /\[studio\/app\/gone\]/, /an anchor that vanished/, /matched 0 times/);
});

test('insertAfterLeadingComment needs a banner comment and inserts after its first */', () => {
  const step = [{ id: 'b', op: 'insertAfterLeadingComment', why: 'after the banner', insert: '\nRUNTIME' }];
  assert.equal(patchText('/* banner */\ncode /* x */', step).text, '/* banner */\nRUNTIME\ncode /* x */');
  throwsPatch(() => patchText('code /* x */', step), /does not start with a \/\* banner comment/);
  throwsPatch(() => patchText('/* never closed', step), /not closed/);
});

test('inJsString edits the decoded value of a string literal and writes it back as a "..." literal', () => {
  const src = "var A=1;var Cn='line1\\nline2 \\x41\\u0042\\u{1F600} </script> it\\'s \\\\ \\\nnext';var B=2;";
  const steps = [
    {
      id: 'w',
      op: 'inJsString',
      why: 'edit the worker',
      open: "var Cn='",
      steps: [
        { id: 'a', op: 'replace', why: 'edit', anchor: 'line1\nline2 AB\u{1F600} </script> it\'s \\ next', with: 'NEW "q" </b>' },
      ],
    },
  ];
  assert.equal(patchText(src, steps).text, 'var A=1;var Cn="NEW \\"q\\" <\\/b>";var B=2;');
  throwsPatch(() => patchText(src, [{ ...steps[0], open: "var Zz='" }]), /could not find the string literal "var Zz='" exactly once \(found 0\)/);
  throwsPatch(() => patchText(src + src, steps), /exactly once \(found 2\)/);
  throwsPatch(() => patchText("var Cn='never closed", steps), /unterminated string literal/);
});

test('scanJsString / jsString', () => {
  const dec = (lit) => scanJsString(lit, 0);
  assert.deepEqual(dec("'a\\tb'rest"), { value: 'a\tb', end: 6 });
  assert.equal(dec("'\\x41\\u0042\\u{43}\\u{1F600}\\uD83D\\uDE00'").value, 'ABC\u{1F600}\u{1F600}');
  assert.equal(dec("'\\q\\`\\\"\\''").value, 'q`"\'');
  assert.equal(dec("'a\\\nb'").value, 'ab', 'line continuation');
  assert.equal(dec("'\\0'").value, '\0');
  assert.equal(dec("'\\01'").value, '01', 'a \\0 followed by a digit is the digit, as the old tool read it');
  assert.equal(dec('"double \\" quoted"').value, 'double " quoted');
  throwsPatch(() => dec("'\\u12'"), /bad hex escape/);
  throwsPatch(() => dec("'abc"), /unterminated/);
  throwsPatch(() => dec('abc'), /no string literal/);
  assert.equal(jsString('a"b\\</script>é₹\n'), '"a\\"b\\\\<\\/script>é₹\\n"');
});

test('checkSyntax: a module with top-level await passes, a syntax error is reported with the step', () => {
  checkSyntax('var x = await Promise.resolve(1);\nexport {};', 'ok.mjs');
  throwsPatch(() => checkSyntax('var x = ;', 'app.mjs', '[studio/app/check-syntax] '), /\[studio\/app\/check-syntax\] patched app\.mjs does not parse/, /SyntaxError/);
  throwsPatch(() => patchText('var = 1', [{ id: 'c', op: 'checkSyntax', why: 'parse it', name: 'x.mjs' }]), /\[text\/c\] patched x\.mjs does not parse/);
});

test('patch files are validated: unknown op or field, duplicate ids, missing why / anchor, bad snippet parts', () => {
  const v = (steps, page = 'dashboard') => validatePatchSpec({ page, steps }, 'dashboard');
  const ok = { id: 'a', op: 'replace', why: 'w', anchor: 'x', with: 'y' };
  v([ok]);
  throwsPatch(() => v([{ ...ok, op: 'swap' }]), /\[dashboard\/a\] unknown op "swap"/);
  throwsPatch(() => v([{ ...ok, ancor: 'x' }]), /unknown field "ancor"/);
  throwsPatch(() => v([ok, ok]), /duplicate step id/);
  throwsPatch(() => v([{ ...ok, why: '' }]), /needs a "why"/);
  throwsPatch(() => v([{ id: 'a', op: 'replace', why: 'w', with: 'y' }]), /needs "anchor"/);
  throwsPatch(() => v([{ ...ok, anchor: '' }]), /non-empty/);
  throwsPatch(() => v([{ ...ok, with: { oops: 1 } }]), /a replacement must be/);
  throwsPatch(() => v([{ id: 'a', op: 'replaceAll', why: 'w', anchor: 'x', with: 'y', count: 0 }]), /positive integer/);
  throwsPatch(() => v([{ id: 'g', op: 'group', why: 'w', steps: [{ ...ok, target: 'template' }] }]), /only on top-level steps/);
  throwsPatch(() => v([{ ...ok, target: 'somewhere' }]), /"template" or "asset:/);
  throwsPatch(() => v([{ id: 'g', op: 'inJsString', why: 'w', open: 'var x=', steps: [] }]), /must end with the opening quote/);
  throwsPatch(() => v([ok], 'home'), /says page "home", expected "dashboard"/);
  throwsPatch(() => validatePatchSpec({ page: 'dashboard' }, 'dashboard'), /needs a "steps" list/);
  v([{ ...ok, _note: 'underscore keys are comments' }]);
});

test('snippets: read verbatim, chomp drops one newline, a path outside site/patches is refused, a missing file is named', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-snip-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), 'A\n');
    const run = (insert) => patchText('[x]', [{ id: 's', op: 'insertAfter', why: 'snippet', anchor: '[x]', insert }], { patchesDir: dir }).text;
    assert.equal(run({ file: 'a.js' }), '[x]A\n');
    assert.equal(run([{ file: 'a.js', chomp: true }, '|']), '[x]A|');
    throwsPatch(() => run({ file: '../a.js' }), /outside/);
    throwsPatch(() => run({ file: 'missing.js' }), /snippet file not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- breaking things on purpose -------------------------------------------------------------------------

test('a syntax error in the studio runtime snippet is caught by the node --check step, and nothing is written', () => {
  const root = makeTempRoot();
  const out = path.join(root, 'out');
  try {
    const snippet = path.join(root, 'site', 'patches', 'snippets', 'studio-server-runtime.js');
    const good = fs.readFileSync(snippet, 'utf8');
    assert.ok(good.includes('function srSamName(){'));
    fs.writeFileSync(snippet, good.replace('function srSamName(){', 'function srSamName({'));
    throwsPatch(() => buildPage('studio', { root }), /\[studio\/app\/check-syntax\]/, /patched app\.mjs does not parse/, /SyntaxError/);
    const built = buildSite({ root, outDir: out });
    assert.equal(built.ok, false);
    assert.equal(built.results.filter((r) => !r.ok).length, 1);
    assert.match(built.results.find((r) => r.key === 'studio').error, /app\.mjs does not parse/);
    assert.equal(fs.existsSync(out), false, 'a failed build writes no page at all, not even the pages that were fine');
  } finally {
    removeTempRoot(root);
  }
});

test('a syntax error in the worker snippet is caught by its own check step', () => {
  const root = makeTempRoot();
  try {
    const snippet = path.join(root, 'site', 'patches', 'snippets', 'worker-exterior-classes.js');
    fs.writeFileSync(snippet, fs.readFileSync(snippet, 'utf8').replace('function srIsExterior(e,t,n){', 'function srIsExterior(e,t,n{'));
    throwsPatch(() => buildPage('studio', { root }), /\[studio\/worker\/check-syntax\]/, /patched worker\.mjs does not parse/);
  } finally {
    removeTempRoot(root);
  }
});

test('an edited anchor in a patch file on disk fails the build of that page with its id', () => {
  const root = makeTempRoot();
  try {
    const file = path.join(root, 'site', 'patches', 'materials.json');
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    spec.steps.find((s) => s.id === 'footer-project').anchor += ' (the export changed)';
    fs.writeFileSync(file, JSON.stringify(spec, null, 2));
    const built = buildSite({ root, check: true });
    assert.equal(built.ok, false);
    const bad = built.results.filter((r) => !r.ok);
    assert.deepEqual(bad.map((r) => r.key), ['materials']);
    assert.match(bad[0].error, /\[materials\/footer-project\] footer: My project link: anchor matched 0 times/);
    assert.match(bad[0].error, /\(the export changed\)/);
  } finally {
    removeTempRoot(root);
  }
});

test('a missing patch file, invalid JSON and a missing export are reported by page', () => {
  const root = makeTempRoot();
  try {
    fs.rmSync(path.join(root, 'site', 'patches', 'home.json'));
    throwsPatch(() => buildPage('home', { root }), /\[home\] no patch file/);
    fs.writeFileSync(path.join(root, 'site', 'patches', 'home.json'), '{ not json');
    throwsPatch(() => buildPage('home', { root }), /\[home\].*is not valid JSON/);
    const site = { ...SITE, pages: { ...SITE.pages, home: { ...SITE.pages.home, source: 'pages_original/gone.html' } } };
    throwsPatch(() => buildPage('home', { root, site }), /\[home\] missing pristine export/);
    throwsPatch(() => buildPage('nope', { root }), /unknown page "nope"/);
  } finally {
    removeTempRoot(root);
  }
});

test('the studio patch with its own copy of the snippets builds to the same bytes of text as the real one', () => {
  const root = makeTempRoot();
  try {
    const mine = buildPage('studio', { root });
    const real = memoBuild('route').results.find((r) => r.key === 'studio');
    assert.equal(mine.bundle.template, real.bundle.template);
    const app = mine.bundle.extUuid('swatchroomApp');
    assert.ok(mine.bundle.asset(app).equals(real.bundle.asset(app)));
  } finally {
    removeTempRoot(root);
  }
});

test('makeContext defaults: link style from site.json, overridable', () => {
  assert.equal(makeContext().style, SITE.linkStyle);
  assert.equal(makeContext({ linkStyle: 'file' }).style, 'file');
  assert.equal(memoBuild('file').ctx.style, 'file');
});

test('the snippets are plain JavaScript that parses on its own (as a module)', () => {
  const dir = path.join(ROOT, 'site', 'patches', 'snippets');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.deepEqual(files.sort(), ['studio-server-runtime.js', 'worker-exterior-classes.js']);
  for (const f of files) checkSyntax(fs.readFileSync(path.join(dir, f), 'utf8'), f.replace(/\.js$/, '.mjs'), `[${f}] `);
});
