/**
 * Application Default Credentials, found without any dependency and without a network call.
 *
 * Two sources are supported, in the order google-auth tries them:
 *   - the file `gcloud auth application-default login` writes (type "authorized_user": a refresh token), and
 *   - the metadata server of Google Compute Engine, Cloud Run, App Engine and Cloud Functions.
 * Not supported: impersonated_service_account and external_account (workload identity) files.
 *
 * Detection runs at settings time, so it only looks at the environment and one file. Everything is read
 * from the `env` it is given; when that environment was passed in explicitly (tests, embedding) the real
 * home directory and the machine's DMI data are never consulted, so nothing outside it can leak in.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const METADATA_DEFAULT_HOST = 'metadata.google.internal';
const GOOGLE_HOST = /^https:\/\/([a-z0-9-]+\.)*googleapis\.com(:\d+)?(\/|$)/;
/** True for https URLs on googleapis.com (and its subdomains): the only token endpoints accepted by default. */
export function isGoogleApisUrl(url) {
  return GOOGLE_HOST.test(String(url));
}

// Variables the Google serverless runtimes set; the metadata server is always there when one of them is.
const SERVERLESS_MARKERS = ['K_SERVICE', 'CLOUD_RUN_JOB', 'GAE_ENV', 'GAE_RUNTIME', 'FUNCTION_TARGET'];

/** @returns {string} the gcloud configuration directory, or '' when it cannot be worked out */
function gcloudConfigDir(env, explicit) {
  if (env.CLOUDSDK_CONFIG) return env.CLOUDSDK_CONFIG;
  if (process.platform === 'win32') return env.APPDATA ? path.join(env.APPDATA, 'gcloud') : path.join(env.SystemDrive || 'C:', 'gcloud');
  const home = env.HOME || env.USERPROFILE || (explicit ? '' : os.homedir());
  return home ? path.join(home, '.config', 'gcloud') : '';
}

/** True when this process looks like it runs on Google's infrastructure (so a metadata server answers). */
function onGoogleCloud(env, explicit) {
  if (env.NO_GCE_CHECK === 'true') return false;
  if (env.GCE_METADATA_HOST || env.GCE_METADATA_ROOT) return true;
  if (SERVERLESS_MARKERS.some((name) => env[name])) return true;
  if (explicit || process.platform !== 'linux') return false;
  try {
    return fs.readFileSync('/sys/class/dmi/id/product_name', 'utf8').trim().startsWith('Google');
  } catch {
    return false;
  }
}

/**
 * @param {Record<string, string>} env the settings environment (file overlaid by the environment)
 * @param {{explicit: boolean, allowCustom: boolean}} options
 * @returns {null | {kind: 'gcloud', file: string, allowCustom: boolean} | {kind: 'metadata', host: string} | {error: string}}
 *   null when there is nothing to use; `error` when a login file exists but cannot be used
 */
export function detectAdc(env, { explicit, allowCustom }) {
  const dir = gcloudConfigDir(env, explicit);
  const file = dir ? path.join(dir, 'application_default_credentials.json') : '';
  if (file && fs.existsSync(file)) {
    const { error } = readAuthorizedUser(file, allowCustom);
    return error ? { error } : { kind: 'gcloud', file, allowCustom };
  }
  if (onGoogleCloud(env, explicit)) return { kind: 'metadata', host: env.GCE_METADATA_HOST || env.GCE_METADATA_ROOT || METADATA_DEFAULT_HOST };
  return null;
}

/**
 * Read and check the gcloud login file.
 * @returns {{info: Record<string, string>} | {error: string}}
 */
export function readAuthorizedUser(file, allowCustom) {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { error: 'The gcloud login file could not be read. Run: gcloud auth application-default login' };
  }
  if (info?.type !== 'authorized_user') {
    return { error: `The gcloud credentials file is of type "${info?.type ?? 'unknown'}", which is not supported here. Use GCP_SERVICE_ACCOUNT_JSON, or run: gcloud auth application-default login` };
  }
  if (!info.client_id || !info.client_secret || !info.refresh_token) {
    return { error: 'The gcloud login file is incomplete. Run: gcloud auth application-default login' };
  }
  if (info.token_uri && !allowCustom && !isGoogleApisUrl(info.token_uri)) {
    return { error: 'token_uri in the gcloud login file does not point at googleapis.com, so it was refused' };
  }
  return { info };
}
