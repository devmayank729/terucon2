/**
 * Moves the service-account key out of .env (GCP_SERVICE_ACCOUNT_JSON) into service-account.json,
 * which the server and the model service pick up on their own. Prints only the shape of the key
 * (never a value): its length, whether it parses, and which required fields are present.
 *
 *   node tools/import-service-account.js          check only
 *   node tools/import-service-account.js --write  also write service-account.json (mode 600)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../server/config/envfile.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = String(loadEnvFile(path.join(root, '.env')).GCP_SERVICE_ACCOUNT_JSON ?? '').trim();
if (!raw) {
  console.log('GCP_SERVICE_ACCOUNT_JSON is empty in .env.');
  process.exit(1);
}

let text = raw;
if (text.length > 1 && text[0] === text.at(-1) && (text[0] === "'" || text[0] === '"')) text = text.slice(1, -1).trim();

/** Same leniency as the server: raw control characters inside strings are escaped before parsing. */
function parse(candidate) {
  try {
    return JSON.parse(candidate);
  } catch {
    let out = '';
    let inString = false;
    for (let i = 0; i < candidate.length; i += 1) {
      const ch = candidate[i];
      if (inString && ch === '\\') {
        out += ch + (candidate[i + 1] ?? '');
        i += 1;
      } else if (ch === '"') {
        inString = !inString;
        out += ch;
      } else if (inString && ch < ' ') out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
      else out += ch;
    }
    return JSON.parse(out);
  }
}

let info = null;
const attempts = [text, text.replace(/\\"/g, '"'), Buffer.from(text, 'base64').toString('utf8')];
for (const candidate of attempts) {
  try {
    const data = parse(candidate);
    if (data && typeof data === 'object') {
      info = data;
      break;
    }
  } catch {
    // try the next form
  }
}

console.log(`length ${raw.length}, starts with ${JSON.stringify(raw.slice(0, 1))}, ends with ${JSON.stringify(raw.slice(-1))}`);
if (!info) {
  console.log('Could not parse it as JSON, as quoted JSON, or as base64. Most likely it was truncated or only part of the file was pasted.');
  process.exit(1);
}
const fields = ['type', 'project_id', 'client_email', 'private_key'];
for (const f of fields) console.log(`  ${f}: ${info[f] ? 'present' : 'MISSING'}`);
console.log(`  private_key has BEGIN PRIVATE KEY: ${String(info.private_key ?? '').includes('BEGIN PRIVATE KEY')}`);
if (fields.some((f) => !info[f])) process.exit(1);

if (process.argv.includes('--write')) {
  const out = path.join(root, 'service-account.json');
  fs.writeFileSync(out, JSON.stringify(info, null, 2) + '\n', { mode: 0o600 });
  console.log(`Wrote ${out}. Now delete the GCP_SERVICE_ACCOUNT_JSON line from .env and restart the server.`);
}
