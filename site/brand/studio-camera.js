/*
 * The Design Studio's "Take a photo", without leaving the page.
 *
 * Why this exists. The studio's camera button opens a file input with capture="environment" (swatchroom/public/js/views/studio.js:
 * `cameraInput`). On a phone that hands the screen to the operating system's camera app, and the browser tab goes to the background while
 * the photo is taken. A page as heavy as the studio can be thrown away by the phone in that time (the studio's own notes: iPhone Safari
 * reloads a tab at about 384 MB), and then the person comes back to a freshly loaded page and the photo never arrives: "the website
 * reloaded". This script keeps the person on the page: it takes over the click on that one input and opens the camera inside the page
 * (getUserMedia), then gives the studio the picture exactly as if a file had been chosen (the same way site/inspiration/feed.js does).
 *
 * swatchroom/ is a verbatim copy and is not touched: everything here listens from outside.
 *
 * When the in-page camera cannot be used (no getUserMedia, permission refused, no camera, a browser view inside another app) the person
 * is offered the phone's camera app (the old way), or the gallery. A phone that does reload during that hand-off leaves a note in
 * sessionStorage, and the next load says what happened instead of leaving the person guessing.
 */
(function () {
  'use strict';
  if (window.__terucon_studio_camera) return;
  window.__terucon_studio_camera = true;

  var CAMERA_INPUT = 'input[data-input="camera"]';
  var PHOTO_INPUT = 'input[data-input="photo"]';
  var PENDING_KEY = 'terucon.cameraHandoff';
  var PENDING_MAX_MS = 15 * 60 * 1000;
  var MAX_SIDE = 3072; // the studio's own limit for a phone (PHONE_ORIGINAL_MAX_SIDE): no point keeping more
  var QUALITY = 0.9;
  var STYLE_ID = 'tc-studio-camera-style';

  var overlay = null;
  var video = null;
  var shutter = null;
  var panel = null;
  var stream = null;
  var target = null; // the studio's camera input the click was meant for
  var opener = null; // what had the focus before, so closing gives it back
  var bypass = false; // the next click on the camera input is the phone's camera app being asked for on purpose

  var CSS = [
    '.tcc{position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483000;display:flex;flex-direction:column;background:#120b04;color:#E1D4C2;font:500 15px/1.4 Switzer,Helvetica,Arial,sans-serif;height:100vh;height:100dvh;touch-action:none}',
    '.tcc *{box-sizing:border-box}',
    '.tcc-video{flex:1 1 auto;min-height:0;width:100%;object-fit:contain;background:#000}',
    '.tcc-bar{flex:none;display:flex;align-items:center;justify-content:center;padding:16px 16px calc(16px + env(safe-area-inset-bottom,0px));background:#120b04}',
    '.tcc-shutter{width:76px;height:76px;padding:0;border-radius:50%;border:4px solid #E1D4C2;background:rgba(225,212,194,.16);cursor:pointer}',
    '.tcc-shutter::after{content:"";display:block;width:54px;height:54px;margin:auto;border-radius:50%;background:#E1D4C2}',
    '.tcc-shutter:disabled{opacity:.35;cursor:default}',
    '.tcc-close{position:absolute;left:12px;top:calc(10px + env(safe-area-inset-top,0px));width:48px;height:48px;padding:0;border-radius:50%;border:1px solid rgba(225,212,194,.45);background:rgba(18,11,4,.62);color:#E1D4C2;font:300 26px/1 Switzer,Helvetica,Arial,sans-serif;cursor:pointer}',
    '.tcc-panel{position:absolute;left:0;right:0;top:0;bottom:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:72px 24px 24px;background:#120b04;text-align:center}',
    '.tcc-panel[hidden]{display:none}',
    '.tcc-panel p{margin:0 0 6px;max-width:30em;font-size:16px}',
    '.tcc-btn{min-height:48px;width:min(100%,320px);padding:0 20px;border-radius:999px;border:1px solid rgba(225,212,194,.5);background:transparent;color:#E1D4C2;font:500 15px/1 Switzer,Helvetica,Arial,sans-serif;cursor:pointer}',
    '.tcc-btn.tcc-solid{background:#E1D4C2;color:#291C0E;border-color:#E1D4C2}',
    '.tcc button:focus-visible{outline:2px solid #F0B060;outline-offset:3px}',
    '.tcc-note{position:fixed;left:12px;right:12px;bottom:calc(var(--tc-dock-h,0px) + env(safe-area-inset-bottom,0px) + 16px);z-index:2147482000;display:flex;align-items:flex-start;gap:12px;max-width:520px;margin:0 auto;padding:14px 8px 14px 16px;border-radius:16px;background:#291C0E;color:#E1D4C2;border:1px solid rgba(225,212,194,.35);box-shadow:0 8px 30px rgba(0,0,0,.35);font:500 14px/1.45 Switzer,Helvetica,Arial,sans-serif}',
    '.tcc-note p{margin:0;flex:1 1 auto}',
    '.tcc-note button{flex:none;min-width:44px;min-height:44px;padding:0 10px;border:0;border-radius:12px;background:transparent;color:#E1D4C2;font:500 14px/1 Switzer,Helvetica,Arial,sans-serif;cursor:pointer}',
  ].join('\n');

  function addStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function button(label, className, onclick) {
    var node = make('button', className, label);
    node.type = 'button';
    node.addEventListener('click', onclick);
    return node;
  }

  function canUseCamera() {
    return window.isSecureContext !== false && !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
  }

  // ---- the note a phone-side reload leaves, and what it says on the next load
  function storeGet() {
    try { return window.sessionStorage.getItem(PENDING_KEY); } catch (e) { return null; }
  }
  function storeSet(value) {
    try { window.sessionStorage.setItem(PENDING_KEY, value); } catch (e) { /* private window: no note, no harm */ }
  }
  function storeClear() {
    try { window.sessionStorage.removeItem(PENDING_KEY); } catch (e) { /* nothing to clear */ }
  }

  function markHandoff() {
    storeSet(String(Date.now()));
    // coming back to this very page (no reload) and nothing arriving means the person cancelled: forget the note
    var back = function () {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', back);
      window.setTimeout(function () { if (storeGet()) storeClear(); }, 4000);
    };
    document.addEventListener('visibilitychange', back);
  }

  function showLostNote() {
    var at = Number(storeGet());
    storeClear();
    if (!at || Date.now() - at > PENDING_MAX_MS) return;
    try { if (window.posthog && typeof window.posthog.capture === 'function') window.posthog.capture('studio_camera_handoff_lost'); } catch (e) { /* analytics is optional */ }
    addStyle();
    var note = make('div', 'tcc-note');
    note.setAttribute('role', 'status');
    note.appendChild(make('p', '', 'Your phone reloaded this page while its camera app was open, so the photo did not arrive. Try again, or choose the photo from your gallery with "New photo".'));
    note.appendChild(button('Close', '', function () { if (note.parentNode) note.parentNode.removeChild(note); }));
    document.body.appendChild(note);
  }

  // ---- the overlay
  function stopStream() {
    if (!stream) return;
    var tracks = stream.getTracks();
    for (var i = 0; i < tracks.length; i += 1) tracks[i].stop();
    stream = null;
    if (video) video.srcObject = null;
  }

  function onKey(event) {
    if (!overlay) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    var items = overlay.querySelectorAll('button:not([disabled])');
    var visible = [];
    for (var i = 0; i < items.length; i += 1) if (items[i].offsetParent !== null) visible.push(items[i]);
    if (!visible.length) return;
    var first = visible[0];
    var last = visible[visible.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }

  function onHidden() {
    // a camera left running behind a tab that is no longer shown is only memory; the person can open it again
    if (document.visibilityState === 'hidden' && overlay) close();
  }

  function close() {
    stopStream();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onHidden);
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = video = shutter = panel = null;
    var back = opener;
    opener = null;
    if (back && typeof back.focus === 'function') { try { back.focus(); } catch (e) { /* gone from the page */ } }
  }

  function callNativeCamera() {
    var input = target;
    close();
    if (!input) return;
    bypass = true;
    input.click(); // a click the person just made, so the phone's camera app may open
    bypass = false;
  }

  function chooseFromGallery() {
    var input = document.querySelector(PHOTO_INPUT);
    close();
    if (input) input.click();
  }

  function fail(message) {
    if (!overlay) return;
    stopStream();
    panel.textContent = '';
    panel.appendChild(make('p', '', message));
    panel.appendChild(button('Open the camera app', 'tcc-btn tcc-solid', callNativeCamera));
    panel.appendChild(button('Choose from gallery', 'tcc-btn', chooseFromGallery));
    panel.hidden = false;
    var first = panel.querySelector('button');
    if (first) first.focus();
  }

  function explain(error) {
    var name = error && error.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera access was not allowed. You can allow it in your browser settings, use the camera app, or choose a photo from your gallery.';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device. You can choose a photo from your gallery instead.';
    if (name === 'NotReadableError' || name === 'AbortError') return 'The camera is busy in another app. Close that app, or use the camera app or your gallery.';
    return 'The camera could not be started here. You can use the camera app or choose a photo from your gallery.';
  }

  function hand(input, file) {
    // the studio listens on the input's own change event and takes the first file, exactly as for a chosen picture
    var transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function shoot() {
    if (!video || !video.videoWidth || !video.videoHeight) return;
    var width = video.videoWidth;
    var height = video.videoHeight;
    var scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    shutter.disabled = true;
    canvas.toBlob(function (blob) {
      canvas.width = canvas.height = 0; // iPhone Safari keeps canvas memory until it is told to let go
      if (!blob) { shutter.disabled = false; fail('The photo could not be saved. You can use the camera app or choose a photo from your gallery.'); return; }
      var input = target;
      try {
        var file = new File([blob], 'camera-' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14) + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
        hand(input, file);
        close();
      } catch (error) {
        fail('This browser could not pass the photo on. You can use the camera app or choose a photo from your gallery.');
      }
    }, 'image/jpeg', QUALITY);
  }

  function open(input) {
    if (overlay) return;
    addStyle();
    target = input;
    opener = document.activeElement;
    overlay = make('div', 'tcc');
    overlay.setAttribute('data-tc-camera', '');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Take a photo');
    video = make('video', 'tcc-video');
    video.setAttribute('playsinline', '');
    video.setAttribute('autoplay', '');
    video.muted = true;
    var bar = make('div', 'tcc-bar');
    shutter = button('', 'tcc-shutter', shoot);
    shutter.setAttribute('aria-label', 'Take photo');
    shutter.disabled = true;
    bar.appendChild(shutter);
    var closer = button('×', 'tcc-close', close);
    closer.setAttribute('aria-label', 'Close camera');
    panel = make('div', 'tcc-panel');
    panel.hidden = true;
    overlay.appendChild(video);
    overlay.appendChild(bar);
    overlay.appendChild(panel);
    overlay.appendChild(closer);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('visibilitychange', onHidden);
    shutter.focus();

    var mine = overlay;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1920 } }, audio: false }).then(function (opened) {
      if (overlay !== mine) { var spare = opened.getTracks(); for (var i = 0; i < spare.length; i += 1) spare[i].stop(); return; } // closed while the permission question was open
      stream = opened;
      video.srcObject = opened;
      var ready = function () { if (shutter && video && video.videoWidth) shutter.disabled = false; };
      video.addEventListener('loadedmetadata', ready);
      video.addEventListener('playing', ready);
      var started = video.play();
      if (started && typeof started.catch === 'function') started.catch(function () { /* the stream shows once it is ready */ });
      ready();
    }, function (error) {
      if (overlay === mine) fail(explain(error));
    });
  }

  // The studio's camera button clicks its own hidden input. Listening in the capture phase, before the studio's own code could act,
  // lets this cancel the phone's camera app (a cancelled click opens no picker) and open the camera here instead.
  document.addEventListener('click', function (event) {
    var input = event.target;
    if (!input || input.nodeType !== 1 || typeof input.matches !== 'function' || !input.matches(CAMERA_INPUT)) return;
    if (bypass || !canUseCamera()) { markHandoff(); return; } // the old way: the phone's camera app takes over
    event.preventDefault();
    event.stopImmediatePropagation();
    open(input);
  }, true);

  // a photo that did arrive: no note
  document.addEventListener('change', function (event) {
    var input = event.target;
    if (input && input.nodeType === 1 && typeof input.matches === 'function' && input.matches(CAMERA_INPUT)) storeClear();
  }, true);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showLostNote);
  else showLostNote();
})();
