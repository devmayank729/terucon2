// Writes tests/sa.json: a throwaway service-account key for the mock Google server
// (mock_google.py). It is not a Google credential and works nowhere else.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const pair = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const key = {
  type: "service_account",
  project_id: "terucon-demo",
  private_key_id: crypto.randomBytes(8).toString("hex"),
  private_key: pair.privateKey,
  client_email: "swatchroom@terucon-demo.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
};
fs.writeFileSync(path.join(__dirname, "sa.json"), JSON.stringify(key, null, 2));
console.log("Wrote tests/sa.json (test key for the mock server only).");
