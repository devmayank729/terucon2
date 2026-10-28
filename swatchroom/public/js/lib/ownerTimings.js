// How long each part of the last scan took, kept in memory so the owner-only dot can show where the
// time went (public/js/views/ownerDot.js). Nothing is sent anywhere and nothing is drawn unless the
// dot is on screen; for everyone else this is just a few numbers that are overwritten by the next scan.

let last = null;
const listeners = new Set();

// timings: { prepMs, segmentMs, segmentLoadMs, segmentDevice, outlinesMs, buildMs, totalMs, ... }
export function recordScan(timings) {
  last = Object.assign({ at: Date.now() }, timings);
  listeners.forEach(function (listener) {
    try {
      listener(last);
    } catch (error) {
      // a broken listener must never break a scan
    }
  });
}

export function lastScan() {
  return last;
}

export function onScan(listener) {
  listeners.add(listener);
  return function () {
    listeners.delete(listener);
  };
}
