#!/usr/bin/env node
/**
 * npm run model: run the Python model service in the foreground, on its own.
 *
 * Useful on a GPU box, in a notebook workflow, or just to look at it. The website normally starts the service
 * itself (MODEL_SERVICE=auto); to use one started this way instead, set MODEL_SERVICE=external and
 * MODEL_SERVICE_URL=http://127.0.0.1:8081 (the default MODEL_PORT) for the website.
 *
 * It reads the same .env as the website (or TERUCON_ENV_FILE). Stop it with Ctrl+C.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings } from '../server/config/settings.js';
import { findPython } from '../server/model/python.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!fs.existsSync(path.join(root, 'model', 'terucon_model'))) {
  console.error('The model service is not in this folder: model/terucon_model is missing. Check that the project folder is complete.');
  process.exit(1);
}

// PYTHON may live in the env file, like every other setting
const envFile = path.resolve(root, process.env.TERUCON_ENV_FILE || '.env');
const python = await findPython({ root, python: loadSettings(envFile, undefined, root).model.python });
if (python.error) {
  console.error(python.error);
  process.exit(1);
}

console.error(`Using ${python.label} (Python ${python.version})`);
const child = spawn(python.command, [...python.args, '-m', 'terucon_model'], {
  cwd: path.join(root, 'model'),
  stdio: 'inherit',
  env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
});
// Ctrl+C reaches the child too (same terminal group); this covers `kill <pid>` of the launcher.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (err) => {
  console.error(`Could not start Python: ${err.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
