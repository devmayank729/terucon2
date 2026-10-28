// Which model did what: real model names go to the browser console for debugging, and
// anything shown on the page goes through publicText() so vendor and model names, internal
// addresses and shell hints stay hidden.

// "service" replacements read as a noun phrase ("AI service key"); the rest as an adjective.
function service(match, offset, whole) {
  const lead = whole.slice(0, offset).trimEnd();
  return !lead || /[.!?:(]$/.test(lead) ? "The AI service" : "AI service";
}

const REPLACEMENTS = [
  [/\s*Start it with:.*?(?:\.(?=\s|$)|$)/gi, ""],
  [/https?:\/\/[^\s)"']*[^\s)"'.,;]/gi, "the server"],
  [/\bGOOGLE_[A-Z0-9_]+/g, "the server credentials"],
  [/\b(?:SAM3|MOGE2|MARIGOLD|MODEL_SERVICE)_[A-Z]+\b/g, "the server setting"],
  [/\bgemini(?:[\w-]|\.\d)*/gi, "AI"],
  [/\bnano[ -]?banana(?:[ -]?(?:\d+(?:\.\d+)*|pro|lite)\b)*/gi, "AI"],
  [/\bvertex ai\b/gi, service],
  [/\baiplatform(?:[\w-]|\.\w)*/gi, service],
  [/\bgoogle(?: cloud)?\b/gi, service],
  [/\bsegformer\b(?:[ -]?b\d)?/gi, "scene model"],
  [/\bsam 3\b/gi, "Surface check"],
  [/\bmoge-2\b/gi, "3D shape"],
  [/\bmarigold-iid\b/gi, "Colour and light"],
];

export function publicText(text) {
  let out = String(text == null ? "" : text);
  REPLACEMENTS.forEach(function (pair) {
    out = out.replace(pair[0], pair[1]);
  });
  return out
    .replace(/\b(AI|AI service)\s+\1\b/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function logModel(task, details) {
  console.info("[swatchroom] model in use:", task, details || {});
}

export function logModelError(task, error, details) {
  console.warn(
    "[swatchroom] model error:",
    task,
    Object.assign({ message: error && error.message }, details || {}),
    error,
  );
}
