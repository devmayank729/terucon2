/**
 * Finds a Python that can run the model service: the first candidate that starts AND can import every
 * package the service needs. A bare `python3` on a fresh machine usually can not, which is why the
 * packages are checked and not just the interpreter.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_MODULES = ['flask', 'numpy', 'PIL', 'cv2', 'requests', 'google.auth'];
const MIN_PYTHON = [3, 9];
const SETUP_HINT = 'Run: npm run setup:model  (or: pip install -r model/requirements.txt)';

// Prints one JSON line: the interpreter's version and the required modules it can not import.
const PROBE = `
import sys, json, importlib
missing = []
for name in ${JSON.stringify(REQUIRED_MODULES)}:
    try:
        importlib.import_module(name)
    except Exception:
        missing.append(name)
print(json.dumps({"version": list(sys.version_info[:3]), "missing": missing}))
`;

/**
 * The interpreters to try, in order. An explicit `python` (the PYTHON variable) is the only candidate.
 * @returns {{command: string, args: string[], local: boolean}[]} `local`: a path that may simply not exist
 */
export function pythonCandidates({ root, python, platform = process.platform }) {
  if (python) return [{ command: python, args: [], local: false }];
  const win = platform === 'win32';
  const venv = (dir) => path.join(dir, '.venv', win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python');
  const local = [venv(path.join(root, 'model')), venv(root)].map((command) => ({ command, args: [], local: true }));
  const system = win
    ? [{ command: 'py', args: ['-3'] }, { command: 'python', args: [] }, { command: 'python3', args: [] }]
    : [{ command: 'python3', args: [] }, { command: 'python', args: [] }];
  return [...local, ...system.map((c) => ({ ...c, local: false }))];
}

/** How an interpreter is named in messages: inside the project by relative path, elsewhere by file name (no home directories). */
function displayName(command, root) {
  if (!path.isAbsolute(command)) return command;
  const relative = path.relative(root, command);
  return relative.startsWith('..') ? path.basename(command) : relative;
}

function runProbe(candidate, { cwd, env }) {
  return new Promise((resolve) => {
    execFile(candidate.command, [...candidate.args, '-c', PROBE], { cwd, env, timeout: 60_000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ran: false, notFound: err.code === 'ENOENT' });
      try {
        const { version, missing } = JSON.parse(stdout.trim().split('\n').at(-1));
        resolve({ ran: true, version, missing });
      } catch {
        resolve({ ran: false, notFound: false });
      }
    });
  });
}

/**
 * @param {object} options
 * @param {string} options.root project folder
 * @param {string} [options.python] explicit interpreter (PYTHON)
 * @param {Record<string, string>} [options.env] environment to probe with
 * @returns {Promise<{command: string, args: string[], label: string, version: string} | {error: string}>}
 */
export async function findPython({ root, python, env = process.env, platform }) {
  const modelDir = path.join(root, 'model');
  const cwd = fs.existsSync(modelDir) ? modelDir : root;
  const label = (c) => displayName(c.command, root);
  let lacking = null; // a Python that works but is missing packages
  let tooOld = null;
  for (const candidate of pythonCandidates({ root, python, platform })) {
    if (candidate.local && !fs.existsSync(candidate.command)) continue;
    const result = await runProbe(candidate, { cwd, env });
    if (!result.ran) continue;
    const tooOldVersion = result.version[0] < MIN_PYTHON[0] || (result.version[0] === MIN_PYTHON[0] && result.version[1] < MIN_PYTHON[1]);
    if (tooOldVersion) tooOld ??= { candidate, version: result.version.join('.') };
    else if (result.missing.length) lacking ??= { candidate, missing: result.missing };
    else return { command: candidate.command, args: candidate.args, label: label(candidate), version: result.version.join('.') };
  }
  if (lacking) {
    return { error: `The model service needs Python packages that are not installed in ${label(lacking.candidate)} (missing: ${lacking.missing.join(', ')}). ${SETUP_HINT}` };
  }
  if (tooOld) {
    return { error: `${label(tooOld.candidate)} is Python ${tooOld.version}, but the model service needs Python ${MIN_PYTHON.join('.')} or newer. Install a newer Python, then: npm run setup:model` };
  }
  if (python) return { error: `PYTHON is set to "${python}", but that could not be run. Fix PYTHON or remove it.` };
  return { error: `Python was not found, so the model service cannot start. Install Python ${MIN_PYTHON.join('.')} or newer, then run: npm run setup:model` };
}
