// The owner's dot: a few pixels in the top corner of the studio that says whether the GPU services
// are asleep, waking up or warm, and how much of a wait was a cold start (a container waking up,
// which is not processing). It exists only for someone signed in at /admin on this device:
//   - swatchroom-app.js mounts it only when GET /api/session says owner: true, so for everyone else
//     this code never runs and nothing is drawn;
//   - the numbers come from GET /api/admin/coldstart, which answers 401 without the admin cookie.
// Tap the dot for the details; tap it again, tap elsewhere or press Escape to close them.

import { cx, h, update } from "../core/dom.js";
import { getJson } from "../core/api.js";
import { lastScan, onScan } from "../lib/ownerTimings.js";
import {
  describeModel,
  describeScan,
  headline,
  overallState,
  SHOWN_WHEN_OFF,
} from "../lib/ownerSummary.js";

const POLL_MS = 2500;
const POLL_HIDDEN_MS = 20000;

// host: the <swatchroom-app> element. Returns { destroy() }.
export function mountOwnerDot(host) {
  const root = document.createElement("div");
  root.className = "sr-owner";
  const state = { snapshot: null, open: false, failed: false };
  let timer = 0;
  let destroyed = false;
  let stopScanListener = null;

  function dotState() {
    return state.failed || !state.snapshot ? "unknown" : overallState(state.snapshot);
  }

  function card() {
    const snapshot = state.snapshot;
    const scan = describeScan(lastScan());
    return h(
      "div",
      { class: "sr-owner-card", role: "dialog", "aria-label": "Model status" },
      h(
        "p",
        { class: "sr-owner-headline" },
        state.failed
          ? "Could not read the model status."
          : snapshot
            ? headline(snapshot)
            : "Reading the model status...",
      ),
      snapshot
        ? h(
            "ul",
            { class: "sr-owner-list" },
            snapshot.models
              .filter(function (model) {
                return model.configured || SHOWN_WHEN_OFF[model.key];
              })
              .map(function (model) {
                const line = describeModel(model);
                return h(
                  "li",
                  { key: model.key, class: cx("sr-owner-row", "is-" + line.state) },
                  h("span", { class: "sr-owner-pip", "aria-hidden": "true" }),
                  h("span", { class: "sr-owner-name" }, line.name),
                  h(
                    "span",
                    { class: cx("sr-owner-text", line.fallback && "is-fallback") },
                    line.text,
                  ),
                );
              }),
          )
        : null,
      scan ? h("p", { class: "sr-owner-scan" }, scan) : null,
      h(
        "p",
        { class: "sr-owner-note" },
        "Cold start = a GPU container waking up. It is waiting time, not processing time.",
      ),
    );
  }

  function render() {
    if (destroyed) {
      return;
    }
    const current = dotState();
    update(root, [
      h("button", {
        key: "dot",
        type: "button",
        class: "sr-owner-dot",
        "data-state": current,
        "aria-label": "Model status, owner only",
        "aria-expanded": state.open ? "true" : "false",
        title: "Model status (owner only)",
        onclick: function (event) {
          event.stopPropagation();
          state.open = !state.open;
          render();
        },
      }),
      state.open ? card() : null,
    ]);
  }

  async function poll() {
    window.clearTimeout(timer);
    if (destroyed) {
      return;
    }
    let delay = document.hidden ? POLL_HIDDEN_MS : POLL_MS;
    try {
      state.snapshot = await getJson("/admin/coldstart");
      state.failed = false;
    } catch (error) {
      if (error && error.httpStatus === 401) {
        // The admin sign-in ended (or never was): this is no longer the owner's browser.
        destroy();
        return;
      }
      state.failed = true;
      delay = POLL_HIDDEN_MS;
    }
    render();
    timer = window.setTimeout(poll, delay);
  }

  function onDocumentPointer(event) {
    if (state.open && !root.contains(event.target)) {
      state.open = false;
      render();
    }
  }

  function onKey(event) {
    if (event.key === "Escape" && state.open) {
      state.open = false;
      render();
    }
  }

  function onVisible() {
    if (!document.hidden) {
      poll();
    }
  }

  function destroy() {
    destroyed = true;
    window.clearTimeout(timer);
    document.removeEventListener("pointerdown", onDocumentPointer, true);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("visibilitychange", onVisible);
    if (stopScanListener) {
      stopScanListener();
    }
    root.remove();
  }

  host.appendChild(root);
  render();
  document.addEventListener("pointerdown", onDocumentPointer, true);
  document.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", onVisible);
  // a finished scan changes the "last scan" line and is a good moment to look again
  stopScanListener = onScan(function () {
    if (state.open) {
      render();
    }
    poll();
  });
  poll();
  return { destroy: destroy };
}
