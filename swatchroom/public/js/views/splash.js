// The first thing anyone sees: a full-screen "Powered by Terucon India" splash with a progress bar and a status line,
// shown while the start-up gate (lib/startupGate.js) finds out whether the Modal vision engine is warm. It sits on top of
// everything until the gate closes (at most 10 s) and then fades out. Styled in css/swatchroom.css (".swr-splash").
//
//   const splash = createSplash(parent);
//   splash.update({ progress: 0.4, status: "Initializing 3D AI Vision Engine..." });
//   await splash.close();

const DEFAULT_STATUS = "Initializing 3D AI Vision Engine...";

export function createSplash(parent) {
  const doc = parent.ownerDocument || document;
  const root = doc.createElement("div");
  root.className = "swr-splash";
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  root.setAttribute("aria-label", "Powered by Terucon India");
  root.innerHTML =
    '<div class="swr-splash-inner">' +
    '<p class="swr-splash-mark">Swatch<em>room</em></p>' +
    '<p class="swr-splash-powered">Powered by</p>' +
    '<p class="swr-splash-brand">Terucon India</p>' +
    '<div class="swr-splash-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
    '<div class="swr-splash-bar"></div></div>' +
    '<p class="swr-splash-status"></p>' +
    "</div>";
  const track = root.querySelector(".swr-splash-track");
  const bar = root.querySelector(".swr-splash-bar");
  const status = root.querySelector(".swr-splash-status");
  status.textContent = DEFAULT_STATUS;
  bar.style.setProperty("--p", "0");
  parent.appendChild(root);

  let closing = null;

  function update(state) {
    if (closing) {
      return;
    }
    if (typeof state.progress === "number") {
      const clamped = Math.min(1, Math.max(0, state.progress));
      bar.style.setProperty("--p", String(clamped));
      track.setAttribute("aria-valuenow", String(Math.round(clamped * 100)));
    }
    if (state.status && status.textContent !== state.status) {
      status.textContent = state.status;
    }
  }

  // Fades the splash out and removes it. Resolves when it is gone.
  function close() {
    if (closing) {
      return closing;
    }
    closing = new Promise(function (resolve) {
      bar.style.setProperty("--p", "1");
      root.classList.add("is-leaving");
      function done() {
        root.removeEventListener("transitionend", done);
        if (root.parentNode) {
          root.parentNode.removeChild(root);
        }
        resolve();
      }
      root.addEventListener("transitionend", done);
      // transitionend does not fire when the page is hidden or motion is reduced to nothing
      setTimeout(done, 700);
    });
    return closing;
  }

  return { element: root, update: update, close: close };
}
