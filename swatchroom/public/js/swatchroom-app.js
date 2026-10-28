// Registers <swatchroom-app>. The element draws the studio into its own light DOM and links
// its stylesheet once, so it drops into any page: the Terucon site, or the plain studio page.
//
// Optional attribute: server="https://studio.example.com" when the page is served from a
// different site than the Swatchroom server.

import { h, update } from "./core/dom.js";
import {
  getJson,
  postJson,
  sendJson,
  setApiBase,
  whenSignedOut,
} from "./core/api.js";
import { loadSettings, saveSettings } from "./lib/settings.js";
import { Studio } from "./views/studio.js";
import { gateView } from "./views/gate.js";
import { mountOwnerDot } from "./views/ownerDot.js";
import { createSplash } from "./views/splash.js";
import { initAnalytics } from "./lib/analytics.js";
import { GATE_MAX_MS, runStartupGate } from "./lib/startupGate.js";

const STYLE_ID = "swr-skin";

function linkStyles() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const link = document.createElement("link");
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  link.href = new URL("../css/swatchroom.css", import.meta.url).href;
  (document.head || document.documentElement).appendChild(link);
}

// Height of a sticky site header above the studio (0 when standalone), so the studio fills
// exactly the rest of the screen.
function measureTopOffset(element) {
  const header = document.querySelector("header[data-nav]");
  if (header && header.getBoundingClientRect().height > 0) {
    return Math.round(header.getBoundingClientRect().height);
  }
  const top = element.getBoundingClientRect().top + window.scrollY;
  return Math.max(0, Math.min(160, Math.round(top)));
}

class SwatchroomApp extends HTMLElement {
  connectedCallback() {
    clearTimeout(this.unmountTimer);
    linkStyles();
    const element = this;
    function updateOffset() {
      element.style.setProperty("--swr-top", measureTopOffset(element) + "px");
    }
    updateOffset();
    if (!this.resizeListener) {
      this.resizeListener = updateOffset;
      window.addEventListener("resize", this.resizeListener);
    }
    if (this.mount) {
      return;
    }
    if (this.getAttribute("server")) {
      setApiBase(this.getAttribute("server"));
    }
    this.mount = document.createElement("div");
    this.mount.className = "swr-root";
    this.appendChild(this.mount);
    // "Powered by Terucon India": up before anything else is fetched, down when the start-up gate has closed
    this.splash = createSplash(this);
    // null until the start-up gate has answered; then true (Modal's vision engine is warm) or false (cold, unreachable
    // or no answer within 10 s). The scan races its two engines differently for each (lib/segmentRace.js).
    this.modalIsWarm = null;
    this.modalGate = null;
    this.settings = loadSettings();
    this.session = null;
    this.gate = { passcode: "", error: "", busy: false };
    whenSignedOut(function () {
      if (element.studio) {
        element.showGate(
          "Your studio session ended. Enter the passcode again.",
        );
      }
    });
    this.start();
  }

  disconnectedCallback() {
    const element = this;
    clearTimeout(this.unmountTimer);
    // Hosts sometimes move the element; only clean up if it stays detached.
    this.unmountTimer = setTimeout(function () {
      if (!element.isConnected && element.mount) {
        if (element.studio) {
          element.studio.destroy();
          element.studio = null;
        }
        if (element.ownerDot) {
          element.ownerDot.destroy();
          element.ownerDot = null;
        }
        element.mount = null;
        element.textContent = "";
        if (element.resizeListener) {
          window.removeEventListener("resize", element.resizeListener);
          element.resizeListener = null;
        }
      }
    }, 1500);
  }

  // What the studio's parts can ask of the app: settings, server info, sign out.
  appContext() {
    const element = this;
    return {
      get settings() {
        return element.settings;
      },
      get session() {
        return element.session;
      },
      setSettings: function (next) {
        element.settings = next;
        saveSettings(next);
      },
      // A photo is about to be scanned: boot the Modal pools the room pipeline will need in the same wave as the scan
      // (server/lib/wake.js). Never called because a page opened - a cold start is billed from its first second.
      warmup: function () {
        element.warmupPipeline();
      },
      get modalIsWarm() {
        return element.modalIsWarm;
      },
      // the studio reports what it learned from a real call (OneFormer answered in time, or did not)
      setModalWarm: function (value) {
        element.setModalWarm(value);
      },
      signOut: function () {
        sendJson("DELETE", "/session")
          .catch(function () {
            return null;
          })
          .then(function () {
            element.showGate("");
          });
      },
    };
  }

  setModalWarm(value) {
    this.modalIsWarm = !!value;
    if (this.studio) {
      this.studio.modalIsWarm = this.modalIsWarm;
    }
  }

  async start() {
    this.renderLoading("");
    const splash = this.splash;
    // The gate asks the server whether Modal is warm while the session loads. The server answers from its own record
    // of its last Modal call, so this never wakes a GPU; GATE_MAX_MS is the longest the splash can ever stay up.
    const gate = runStartupGate({
      check: function () {
        return getJson("/vision/warmup");
      },
      maxMs: GATE_MAX_MS,
      onTick: function (state) {
        splash.update(state);
      },
    });
    let sessionError = null;
    try {
      this.session = await getJson("/session");
    } catch (error) {
      sessionError = error;
    }
    const result = await gate;
    this.modalGate = result;
    this.modalIsWarm = result.modalIsWarm;
    if (sessionError) {
      this.renderLoading(
        "The Swatchroom server did not answer (" +
          sessionError.message +
          "). Check that it is running, then reload.",
      );
      await splash.close();
      return;
    }
    initAnalytics(this.session.posthog);
    if (this.session.passcodeRequired && !this.session.signedIn) {
      this.showGate("");
    } else {
      this.openStudio();
      this.showOwnerDot();
    }
    await splash.close();
  }

  // The cold-start dot, only in the browser of someone signed in at /admin (the session says so).
  showOwnerDot() {
    if (this.ownerDot || !this.session || !this.session.owner) {
      return;
    }
    this.ownerDot = mountOwnerDot(this);
  }

  // Starts the room pipeline's cold GPU containers while a photo is being scanned (server/routes/pipeline.js's
  // /pipeline/warmup), so they are up by the time the scan is done instead of after it. Only the studio calls this,
  // only when a photo is added or scanned: opening the page does NOT, because a GPU pool is billed from the moment it
  // boots and most people who open the page never upload a photo. The server wakes only the pools that are cold and
  // not already starting. Best-effort and silent; Settings > Check shows real connectivity.
  warmupPipeline() {
    const now = Date.now();
    if (this.lastWarmup && now - this.lastWarmup < 20000) {
      return;
    }
    this.lastWarmup = now;
    postJson("/pipeline/warmup", { reason: "scan" }).catch(function () {});
  }

  renderLoading(problem) {
    update(
      this.mount,
      h(
        "main",
        { class: "sr-loading" },
        h(
          "p",
          { class: "sr-wordmark sr-wordmark-large" },
          "Swatch",
          h("em", null, "room"),
        ),
        problem
          ? h("p", { class: "sr-form-error", role: "alert" }, problem)
          : h("p", { class: "sr-loading-note" }, "Opening the studio…"),
      ),
    );
  }

  openStudio() {
    if (this.studio) {
      return;
    }
    this.mount.textContent = "";
    this.studio = new Studio(this.mount, this.appContext());
  }

  showGate(message) {
    if (this.studio) {
      this.studio.destroy();
      this.studio = null;
    }
    this.mount.textContent = "";
    this.gate = { passcode: "", error: message || "", busy: false };
    this.renderGate();
  }

  renderGate() {
    const element = this;
    update(
      this.mount,
      gateView({
        passcode: this.gate.passcode,
        error: this.gate.error,
        busy: this.gate.busy,
        serverProblem: "",
        onPasscode: function (value) {
          element.gate.passcode = value;
          element.gate.error = "";
          element.renderGate();
        },
        onSubmit: function () {
          element.submitPasscode();
        },
      }),
    );
  }

  async submitPasscode() {
    if (this.gate.busy) {
      return;
    }
    this.gate.busy = true;
    this.gate.error = "";
    this.renderGate();
    try {
      await postJson("/session", { passcode: this.gate.passcode });
      this.session = await getJson("/session");
      this.gate.busy = false;
      this.openStudio();
      this.showOwnerDot();
    } catch (error) {
      this.gate.busy = false;
      this.gate.error = error.message;
      this.renderGate();
    }
  }
}

if (!customElements.get("swatchroom-app")) {
  customElements.define("swatchroom-app", SwatchroomApp);
}
