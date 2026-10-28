// Prepares the Terucon "Swatchroom" page (exported from Claude Design) to be served by this
// server at "/".
//
//   node scripts/build-terucon-page.js <exported Swatchroom.html> [output.html]
//   (default output: terucon/Swatchroom.html, which the server serves at "/")
//
// The export is a self-unpacking page: a JSON manifest of compressed assets (the page runtime,
// fonts, and the studio, registered as "swatchroomApp") plus the page template. This script
// swaps only the studio asset for a two-line loader that imports /js/swatchroom-app.js from
// this server, so the page always runs the current plain-JavaScript studio. The Terucon
// header, menu, footer and fonts stay exactly as designed.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const root = path.join(__dirname, "..");
const input = process.argv[2];
const output = process.argv[3] || path.join(root, "terucon", "Swatchroom.html");
if (!input) {
  console.error(
    "usage: node scripts/build-terucon-page.js <exported Swatchroom.html> [output.html]",
  );
  process.exit(1);
}

let html = fs.readFileSync(input, "utf8");

function scriptBlock(type) {
  const open = '<script type="' + type + '">';
  const start = html.indexOf(open);
  if (start === -1) {
    throw new Error("This file is not a Claude Design export: missing " + type);
  }
  const bodyStart = start + open.length;
  const bodyEnd = html.indexOf("</script>", bodyStart);
  return {
    bodyStart: bodyStart,
    bodyEnd: bodyEnd,
    text: html.slice(bodyStart, bodyEnd),
  };
}

const resources = JSON.parse(scriptBlock("__bundler/ext_resources").text);
const appEntry = resources.find(function (entry) {
  return entry.id === "swatchroomApp";
});
if (!appEntry) {
  throw new Error('No "swatchroomApp" resource in this export.');
}

const loader = [
  "// Swatchroom loader: the studio comes from the Swatchroom server (plain HTML, CSS and JavaScript).",
  'import(new URL("/js/swatchroom-app.js", window.location.href).href);',
  "",
].join("\n");

const manifestBlock = scriptBlock("__bundler/manifest");
const manifest = JSON.parse(manifestBlock.text);
manifest[appEntry.uuid] = {
  mime: "application/javascript",
  compressed: true,
  data: zlib.gzipSync(Buffer.from(loader), { level: 9 }).toString("base64"),
};
const manifestText = "\n" + JSON.stringify(manifest) + "\n  ";
html =
  html.slice(0, manifestBlock.bodyStart) +
  manifestText +
  html.slice(manifestBlock.bodyEnd);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, html);
console.log(output, Math.round(html.length / 1024) + " KB");
