// A stand-in for `python -m terucon_model`, driven by environment variables, so the supervisor can be tested
// without Python. It speaks the real start-up protocol: bind first, then print one TERUCON_MODEL_READY line.
//
//   FAKE_MODE        serve (default) | split-ready | crash | never-ready | ignore-term
//   FAKE_COUNTER     a file; each start appends a byte to it, so a test can count starts
//   FAKE_FAIL_RUNS   in "serve" mode, exit with code 3 on the first N starts (counted through FAKE_COUNTER)
//   FAKE_PID_FILE    receives this process's pid
//   FAKE_ENV_DUMP    receives the environment this process was given, as JSON
//   FAKE_SAM         "off": report SAM as disabled in /health
import fs from 'node:fs';
import { SAM_STATE, startFakeModelService } from './fakeModelService.js';

const mode = process.env.FAKE_MODE ?? 'serve';
if (process.env.FAKE_COUNTER) fs.appendFileSync(process.env.FAKE_COUNTER, 'x');
const run = process.env.FAKE_COUNTER ? fs.statSync(process.env.FAKE_COUNTER).size : 1;
if (process.env.FAKE_PID_FILE) fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
if (process.env.FAKE_ENV_DUMP) fs.writeFileSync(process.env.FAKE_ENV_DUMP, JSON.stringify(process.env));

console.log('hello from stdout');
console.error('hello from stderr');

const done = () => process.exit(0);
if (mode !== 'ignore-term') process.on('SIGTERM', done);
else process.on('SIGTERM', () => console.error('ignoring SIGTERM'));
process.on('SIGINT', done);

if (mode === 'crash' || (mode === 'serve' && run <= Number(process.env.FAKE_FAIL_RUNS ?? 0))) {
  console.error('about to crash');
  process.exit(3);
}
if (mode === 'never-ready') {
  setInterval(() => {}, 1000); // alive, binds nothing, says nothing
} else {
  const key = process.env.MODEL_SERVICE_KEY ?? '';
  const sam = process.env.FAKE_SAM === 'off' ? { ...SAM_STATE, enabled: false, status: 'off' } : SAM_STATE;
  const service = await startFakeModelService({ key, sam });
  const line = `TERUCON_MODEL_READY ${service.url}\n`;
  if (mode === 'split-ready') {
    process.stdout.write(line.slice(0, 20));
    setTimeout(() => process.stdout.write(line.slice(20)), 150);
  } else {
    process.stdout.write(line);
  }
}
