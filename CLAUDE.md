# Terucon: working agreement

The goal of this project is the quotation in `Terucon_AI_tool.pdf` (TIPL-PROP-02 Rev. 2). `TARGETS.md` lists every target in it, what exists, what is left, the evidence, and a suggested order to work in.

1. **Before any task**, read `TARGETS.md` and say which target(s) the task serves (or that it serves none).
2. **After the task**, update `TARGETS.md`: the target's status and evidence, its "Remaining" list, the counts in "Where we stand", the "Start here" order if it changed, and a dated line in the change log. State what was verified and what was not. Then run `node tools/build-overview.js`: the overview records every file's size, so after any edit to `TARGETS.md` or `CLAUDE.md` the "project overview is current" step of `npm test` fails until you do.
3. **Count only what is real.** Statuses are Done / Partly done / Demo screen only / Not done / Later. A screen on hard-coded data, or a button that only changes its own state, is "Demo screen only", never "Done". "Done" means real logic that has run at least against mocks; say so when nothing has run against live services.
4. **Work done outside this repo** (fine-tuning, accounts, deals) can only be ticked on the user's word: mark it "per you" with the date and list the evidence still to attach.
5. If the PDF and `TARGETS.md` disagree, the PDF wins: fix the file.
6. A new file in the project root needs a line in `docs/overview/catalog/files.json`, then `node tools/build-overview.js`, or the "project overview is current" step of `npm test` fails.
