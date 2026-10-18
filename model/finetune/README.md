# Fine-tuning

There is no training code here yet, and none has been run. This folder is where it goes (data preparation, training
scripts, the notes of a run). What exists today is the evaluation that tells you whether a fine-tune helps, and the places a
fine-tuned model can be plugged in without touching the pipeline.

## Measure first: `../eval/`

`eval/refine_eval.py` scores every route on ground-truth surfaces (IoU and boundary F1), so a candidate model is compared
with the shipped one on the same photos and the same degraded outlines. `eval/sam_oracle.py` gives SAM's ceiling and its
refusal rate; `eval/ade_subset.py` builds the photo set from ADE20K validation shards (`--skip N` passes over the first N qualifying photos per
bucket, which gives a set that does not overlap an earlier one).

Three things learned the hard way, which a fine-tuning experiment should respect:

* **Burned photo sets.** The sets used so far (a 60-photo tuning set, a 40-photo set looked at during development, a 60-photo set
  run once with the final configuration) are spent: a model chosen by looking at them is chosen on its own test data. Build new
  photos for any new round.
* **The frame margin.** ADE20K's labels are missing along the photo frame, so scoring whole masks rewards masks that stop short of the
  frame. `refine_eval.py` ignores a 1% margin (`--frame-margin`); any new metric on these photos must crop the same margin.
* **Simulated outlines.** The numbers come from degraded ground truth standing in for Gemini's outlines; Gemini itself was never
  measured (no credentials were available). A fine-tune of the detector would be the first thing to measure for real.

## Where a fine-tuned model can plug in today

* **SAM 2 / SAM weights: `SAM_MODEL_ID`.** It is passed straight to `transformers`' `from_pretrained`, so it can be a Hugging Face
  repo id or a local directory written by `save_pretrained`. One catch: the backend decides between SAM 2 and the original SAM
  by looking for `sam2` or `sam-2` in that string (`HfSamBackend.kind`), so a local SAM 2 fine-tune should live in a directory
  whose path contains `sam2`, otherwise it is loaded as the original SAM and fails. `SAM_DEVICE` picks cuda, mps or cpu.
* **SAM 3: `SAM_BACKEND=sam3`, `SAM_CHECKPOINT`, `SAM_REPO_DIR`.** Point `SAM_CHECKPOINT` at your own `.pt` and `SAM_REPO_DIR` at the
  `sam3` clone that can load it. Not run here (needs CUDA and the gated base checkpoint).
* **Any other segmentation server: `SAM_BACKEND=remote`, `SAM_REMOTE_URL`.** Anything that answers `GET /health`, `POST /refine` and
  `POST /segment` in the shape of `terucon_model/sam/backends.py` (`RemoteBackend`) can stand in for SAM, on this machine or another.
  That is the least invasive way to try a model that `transformers` cannot load.
* **Gemini detection: `SWATCHROOM_DETECT_MODEL`** picks which Gemini model finds and outlines the surfaces. It accepts a model name
  (letters, digits, `.`, `_`, `-`) and the client builds `…/publishers/google/models/<name>:generateContent`. A **tuned Gemini endpoint**
  (`projects/…/endpoints/<id>`) does not fit either of those, so it cannot be used through this setting today; supporting one means
  changing `endpoint()` in `terucon_model/vertex.py` and the model-name check in it and in `config.py`. Not done.

## Not a hook

The contour snapping and the layering (`segment/snap.py`, `segment/refine.py`) have no learned part and no setting beyond
`EDGE_REFINE` and `EDGE_METHOD`. Their constants were tuned against the evaluation above; change one only with a new
measurement beside it.
