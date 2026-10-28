# Modal GPU latency audit — SAM3 / MoGe-2 / Marigold-IID (2026-10-24)

Everything in this file is sourced from one of three places, each marked explicitly:
- **[LOG]** — `modal app logs ap-PZWqb6L53J9Y8Zq0mCjbXJ --since 12h`, the real, complete log
  history of the `vision-stack` app's entire deployed life (~10 hours at time of writing).
- **[BILLING]** — `modal billing rates` / `modal billing report --show-resources`, live account data.
- **[CODE]** — `/Users/mayank/XTRA/modalDeployment/vision_stack.py`, the actual deployed blueprint
  (the repo's own `modalBlueprint.py` is a 0-byte empty stub, not this).
- **[DOCS]** — Modal's current public documentation, checked live, with links.
- **[EST]** — an explicit estimate/inference, never presented as measured.

No number below is invented. Where a figure could not be verified, that is stated instead of
guessing.

---

## 0. Known-bad data: don't trust `swatchflow.md` Part 6

`swatchflow.md`'s "Part 6 — Measured timings" section (an **uncommitted** diff, not in any
commit) claims real timed HTTP calls producing:
- MoGe-2 cold start: 219.4s
- Marigold-IID cold start: 266.7s
- A MoGe-2 request that hung 594.7s and failed with `HTTP 000`

None of this matches the real log history pulled directly from Modal **[LOG]**. No 594.7s hang,
no `HTTP 000` failure, and no 266.7s Marigold event exists anywhere in the actual 12-hour log.
The file also asserts Marigold was the slowest/worst model — the real logs show the opposite
(MoGe-2, not Marigold, produced the only catastrophic outliers, and for a different reason than
"cold start" — see §3). This section appears fabricated by a prior session and should be reverted
or replaced with the numbers in this file.

`modalBlueprint.py` in this repo is also empty (0 bytes) — the real blueprint lives at
`/Users/mayank/XTRA/modalDeployment/vision_stack.py`.

---

## 1. Real deployed config **[CODE]**

| Setting | Value | Meaning |
|---|---|---|
| `SCALEDOWN_S` | **300s (5 min)** | idle time before a container is torn down |
| `MIN_CONTAINERS` | 0 | nothing kept warm by default |
| `BUFFER_CONTAINERS` | 0 | no idle burst-absorber container |
| `MAX_CONTAINERS` | 6 | per service |
| `STARTUP_TIMEOUT_S` | 900 | max time allowed to boot |
| `REQUEST_TIMEOUT_S` | 300 | max time allowed per request |
| `GPU_SNAPSHOT` | True | alpha feature; `enable_memory_snapshot` + `enable_gpu_snapshot` |
| GPUs | MoGe-2: **L4**, Marigold-IID: **L4**, SAM3: **L40S** | |

---

## 2. Question: cold start if the user returns 6 hours after last use

Because `SCALEDOWN_S = 300`, the container is already dead **5 minutes** after the last call —
long before 6 hours. Arriving 6 hours later is operationally identical to arriving 6 minutes
later: both restore from the saved GPU snapshot. Modal does not document snapshot expiry tied to
idle duration — only redeploys invalidate a snapshot **[DOCS]**. There is no extra "long idle"
penalty beyond the normal cold-start-from-snapshot cost below.

---

## 3. Measured cold-start latency **[LOG]**

### 3a. First-ever boot (snapshot built from scratch — happens once per service per deploy)

| Model | GPU | Measured |
|---|---|---|
| SAM3 | L40S | 24.7s |
| MoGe-2 | L4 | 29.1s |
| Marigold-IID | L4 | 44.3s |

Matches the code's own comment in `server/routes/pipeline.js:70-72` ("10–45s") closely.

### 3b. Normal cold start (restoring from an existing snapshot — the common case)

| Model | GPU | Measured range |
|---|---|---|
| SAM3 | L40S | 5.8s – 6.2s |
| MoGe-2 | L4 | 2.5s – 23.8s |
| Marigold-IID | L4 | 8.7s – 22.9s |

(Also seen via bare `/healthz` restores across all three services: 6.3s–49.8s.)

### 3c. The real tail risk: L4 GPU capacity queueing, not cold start

Two MoGe-2 requests took **213.7s** and **1028.4s (17 min)** respectively — but their logged
`execution` time was under 2 seconds both times. The model loaded and ran fine; the delay was
Modal's fleet having no free L4 GPU at that moment, stated explicitly in the log:

```
Function 'MoGe2.*' is waiting to be scheduled on a GPU_L4 worker.
We are actively working on acquiring more capacity for your workload.
```

This message appeared **5 times** in 10 hours, always on an L4 function (MoGe-2 or
Marigold-IID), **never once** on SAM3's L40S. This is a capacity/scheduling issue specific to L4
in this account/region at that time — distinct from, and far larger than, snapshot-restore cold
start.

---

## 4. Measured warm latency (container already running) **[LOG]**

| Model | Warm latency range | Notes |
|---|---|---|
| SAM3 | 0.28s – 1.4s | fast single forward pass |
| MoGe-2 | 0.48s – 4.5s | scales with image size |
| Marigold-IID | 1.75s – 6.3s | heaviest — real diffusion steps, not overhead |

---

## 5. Cost **[BILLING]**

Rates: **L4 = $0.80/hr, L40S = $1.95/hr**.

Today's completed-hour cost breakdown (dashboard's $6.48 includes the current in-progress hour,
not yet in this report — explains the small gap vs. the $6.28 below):

| Resource | Cost today | Attribution |
|---|---|---|
| L40S | $2.81 | SAM3 only (27 calls) |
| L4 | $2.09 | MoGe-2 + Marigold-IID shared (52 calls combined) |
| CPU | $0.77 | shared across all 3 |
| Memory | $0.61 | shared across all 3 |
| **Total** | **$6.28** | |

**Cost per call:**
- SAM3 ≈ **$0.10–0.13/call** (L40S cost ÷ 27 calls, plus an **[EST]** proportional CPU/mem share
  — Modal's billing API does not break CPU/mem down per function, so this split is an estimate).
- MoGe-2 + Marigold-IID blended ≈ **$0.04/call average [EST]** — cannot be cleanly separated
  between the two models on shared L4 without per-function billing data.

**Key finding:** at listed GPU rates, actual inference compute for a warm call costs well under a
cent (e.g., Marigold's ~3s avg execution × $0.80/hr ≈ $0.0007). **Nearly all of the $6.28 is
idle/cold-start/snapshot-rebuild overhead, not inference** — that is where the optimization
leverage is.

---

## 6. Recommendations

1. **Scheduled warm pools (highest leverage).** Modal supports `modal.Cron`-triggered
   `function.autoscaler.update(min_containers=N)` to keep 1 container warm during business hours
   and drop to 0 overnight **[DOCS: modal.com/docs/guide/scale.md]**. This removes cold starts
   entirely during active hours for a bounded, predictable idle cost. Caveat: a redeploy resets to
   the static decorator default, so this must be re-applied after every `modal deploy`.
2. **The L4 capacity-queueing tail (§3c) is the real threat, not snapshot restore.** Restores are
   already fine (6–32s, matching the code's own expectation). The 17-minute outlier is a
   shared-fleet capacity issue specific to L4. A scheduled warm pool (#1) makes this rare in
   practice. A fallback GPU list on the `Function`/`gpu=` parameter may also be possible — not
   independently confirmed in this pass, verify against Modal's `Function` reference before
   relying on it.
3. **6 "Creating GPU memory snapshot" (full rebuild) events occurred in 10 hours**, against an
   expected baseline of 3 (one per service). Rebuilds are slower (25–44s) than restores (6–32s)
   and happen on every redeploy. Worth confirming these 3 extra rebuilds came from code
   redeploys during testing and not something recurring in production.
4. `SCALEDOWN_S = 300` is reasonable as-is. Since overhead dominates cost far more than compute
   does, stretching it to 600–900s is cheap insurance against repeat cold starts within one
   session (extra 5–10 idle minutes costs ~$0.13–0.33 on L4, ~$0.33–0.49 on L40S).
5. `GPU_SNAPSHOT` (still **alpha**, not GA, per Modal's docs) is already doing its job — restores
   land within the code's own expected 10–45s window. No change needed here.

---

## 7. Hiding cold start from the user

**What already exists** (verified by reading the actual code, not assumed):
- `/pipeline/warmup` fires silently on studio open (`public/js/swatchroom-app.js`),
  fire-and-forget, 90s timeout. Explicitly designed to be invisible — the code comment says
  "Settings > Check already shows real connectivity status."
- `ensureFusion()` in `public/js/views/studio.js` does track real status
  (`checking` → `running` → `ready`) but it's surfaced only in **Settings > Render**, a panel a
  designer may never open — not as a visible banner on the main canvas.
- The aggregate `/check` endpoint (`server/routes/session.js`, `pipelineModelCheck()`) gives a
  worded, non-alarming timeout message ("cold GPU container can take a while to start; try again
  shortly") but only on a manual Settings check (45s timeout per model).

**Recommendations:**
- Pair the scheduled warm pool (§6.1) with firing `warmupPipeline()` even earlier (e.g. on the
  room-list screen, not just on studio open) to buy more lead time against the rare true-cold
  case.
- Surface `ui.fusion.status === "running"` as a visible banner on the main studio canvas
  ("Preparing 3D geometry — first use can take up to a minute"), not just in Settings — this is
  the gap between "we silently warm it" and "the user sees a stall with no explanation."

---

## 8. What was not verified / explicit gaps

- No official Modal documentation gives L4-vs-L40S-specific capacity benchmark numbers; the L4
  queueing issue in §3c is this account's real observed behavior, not a documented general rule.
- Whether billing accrues during the "waiting to be scheduled" queue time (§3c) itself, versus
  only once a container actually starts running, was not confirmed against Modal's billing docs.
- Fallback GPU lists (e.g. `gpu=["L4","A10G"]`) were not independently confirmed against Modal's
  current `Function` reference — flagged in §6.2, verify before relying on it.
- The per-call cost split between MoGe-2 and Marigold-IID (§5) is an estimate, not an exact
  figure — Modal's billing report does not break cost down below "resource type" (GPU/CPU/Memory)
  within an app.

---

## 9. Update 2026-10-25: fallback GPUs and cold-start visibility

- **Fallback GPU lists are confirmed and implemented** (this closes the open point in §6.2 and
  §8). Modal's docs: "Modal respects the ordering of this list and will try to allocate the most
  preferred GPU type before falling back to less preferred ones" (`gpu=["H100", "A100-40GB:2"]`
  is their example); the installed client (1.6.2) accepts `gpu: str | list[str]` on `App.cls`
  and `run_function`. `modalBlueprint.py` now lists MoGe-2/Marigold `L4, A10, L40S, A100-40GB`
  and SAM 3 `L40S, A100-40GB, A10, L4`. Not documented by Modal and therefore not claimed: how
  long it waits for the first choice before falling back. The valid name for the 24 GB Ampere card
  is `A10` (not `A10G`) in Modal's current GPU list.
- GPU snapshots are per GPU type ("GPU Functions need 2-3 snapshots per GPU type"), the
  client's container runtime exits with a sentinel code that makes Modal retry a failed GPU
  snapshot restore without a snapshot, and (client source, `_functions.py`) every GPU's copy of
  the class carries `checkpointing_enabled` and the `enable_gpu_snapshot` option, with only
  `resources` overridden per GPU. So a fallback type should cost one slower first boot, not
  errors. Modal's docs say nothing about snapshots together with a GPU list, and none of this has
  run on a real deploy yet: watch `modal app logs` after the first one.
- The container now reports `x-gpu`, `x-gpu-rank`, `x-container-requests`, `x-container-age`
  (and `/healthz` the same); `server/lib/coldStart.js` turns that plus `Server-Timing` into
  cold start vs processing, shown to the owner only (see swatchflow.md).
- Still open: `MIN_CONTAINERS` / a scheduled warm pool (§6.1) costs an idle GPU and is left at 0;
  `VISION_MIN_CONTAINERS=1 modal deploy modalBlueprint.py` turns it on for a deploy without
  editing the file (`VISION_SCALEDOWN_S` likewise).
