// Runs the Python-side tests (tests/modal_blueprint.test.py, tests/scene_service.test.py) with the first Python that has
// their packages. They need torch / transformers / fastapi / modal, which a Node-only checkout may not have: such a test
// prints SKIP and this script moves on to the next Python, and if none can run it says so and exits 0, so `npm test`
// stays usable everywhere while still running them wherever the models' own environment exists.
//
//   PYTHON=/path/to/python npm run test:python
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const tests = ["tests/modal_blueprint.test.py", "tests/scene_service.test.py"];
const candidates = [
  process.env.PYTHON,
  path.join(root, "python", ".venv", "bin", "python"),
  "python3",
  "python",
].filter(Boolean);

let failed = false;
tests.forEach(function (test) {
  let ran = false;
  for (const python of candidates) {
    if (python.indexOf(path.sep) !== -1 && !fs.existsSync(python)) {
      continue;
    }
    const result = spawnSync(python, [path.join(root, test)], {
      cwd: root,
      encoding: "utf8",
      env: Object.assign({}, process.env, { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" }),
    });
    const output = (result.stdout || "") + (result.stderr || "");
    if (result.error || /^SKIP /m.test(output)) {
      continue; // this Python lacks the packages: try the next one
    }
    ran = true;
    const lines = output.split("\n").filter((line) => /^(PASS|FAIL|all |\d+ check)/.test(line));
    console.log(lines.join("\n") || output.slice(-400));
    if (result.status !== 0) {
      failed = true;
      console.error(output.slice(-1500));
    }
    break;
  }
  if (!ran) {
    console.log("SKIP " + test + ": no Python with its packages (set PYTHON=... to one that has torch, transformers, fastapi, modal)");
  }
});
process.exit(failed ? 1 : 0);
