import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { loadEnvFile, mergedEnvironment, parseEnv } from '../../server/config/envfile.js';

const cases = JSON.parse(fs.readFileSync(new URL('../fixtures/env-cases.json', import.meta.url), 'utf8'));

describe('env file parser', () => {
  test('the forms people paste', () => {
    const r = parseEnv('# c\nA=1\nexport B = two words  # note\nC="x\\ny"\nD=\'{"k":"v\\n"}\'\nE=\nF=a#b\nM=\'a\nb\'\nH=1\nH=2\n');
    assert.equal(r.A, '1');
    assert.equal(r.B, 'two words');
    assert.equal(r.C, 'x\ny');
    assert.equal(r.D, '{"k":"v\\n"}'); // single quotes are literal
    assert.equal(r.E, '');
    assert.equal(r.F, 'a#b'); // '#' without a space before it is part of the value
    assert.equal(r.M, 'a\nb');
    assert.equal(r.H, '2'); // last wins
  });

  test('CRLF line ends and a byte-order mark', () => {
    assert.deepEqual({ ...parseEnv('﻿A=1\r\nB=2\r\n') }, { A: '1', B: '2' });
  });

  test('export with a tab; a # right after the = is part of the value', () => {
    const r = parseEnv('export\tA=1\nB=#not a comment\n');
    assert.equal(r.A, '1');
    assert.equal(r.B, '#not a comment');
  });

  for (const c of cases.parse) {
    test(`shared case: ${c.name}`, () => {
      const parsed = parseEnv(c.text);
      for (const [key, value] of Object.entries(c.expect)) assert.equal(parsed[key], value, key);
    });
  }
});

describe('loading', () => {
  test('a missing file is an empty file', () => {
    assert.deepEqual(loadEnvFile(path.join(os.tmpdir(), 'terucon-no-such-file.env')), {});
  });

  test('a directory is an error, not silently empty', () => {
    assert.throws(() => loadEnvFile(os.tmpdir()), { code: 'EISDIR' });
  });

  test('the environment wins over the file', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-env-')), '.env');
    fs.writeFileSync(file, 'A=file\nB=file\n');
    try {
      assert.deepEqual({ ...mergedEnvironment(file, { B: 'env', C: 'env', D: undefined }) }, { A: 'file', B: 'env', C: 'env' });
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});
