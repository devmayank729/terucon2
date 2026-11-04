# Setting up the catalogue (Finder, catalogue admin, material matching)

**Status: code and tests only.** Everything below is written from the code. None of it has been run against a live Modal account, Google Cloud bucket or
MongoDB; the places where that matters are marked **not verified**. The contract the code follows is `catalogue/ARCHITECTURE.md`.

The catalogue is switched off until you do this. Until then `/finder` says so plainly and the shop keeps its colour demo.

## 1. What runs where

| Piece | Where | What it holds / does |
|---|---|---|
| The website (`npm start`) | your server | The pages, the sign-in, the catalogue gateway. It does no model work and never carries a picture. |
| The Modal app `terucon-catalogue` | modal.com | GPU search (DINOv2 + SigLIP), a small CPU ingest endpoint, the GPU ingest job, and two CPU helpers for your own files. Scales to zero when idle. |
| The Google Cloud bucket | Google Cloud | The durable copy of everything: original PDFs/photos, crops and thumbnails (the browser loads these from here with signed links), the **releases** (vectors + item list), and your uploaded `imports/` folders. |
| MongoDB | the one the studio uses | The items (labels, product codes, hidden flags), the catalogues, the jobs, the live-release pointer. |
| The Modal volume `terucon-catalogue-cache` | modal.com | A copy of the **releases**, so a search container reads them from local storage and downloads nothing. Only ever a cache. |

**Servers you start yourself: still at most two** (`npm start`, and the optional `npm run models`). The catalogue adds none; the Modal app is deployed once.

## 2. What is stored where, and why it is fast

| Thing | Home | Why |
|---|---|---|
| Model weights (DINOv2, SigLIP) | baked into the Modal image | Nothing is downloaded when a container starts (`HF_HUB_OFFLINE=1`). A deploy builds them in once. |
| Releases (vectors) | the bucket (durable) **and** the Modal volume (fast) | A new release is put on the volume when you import it, when an admin upload finishes, or when you run `prime`. A search container reloads the volume before it looks, so it finds a release put there while it was running. If the volume lacks one, the container takes it from the bucket and keeps it. |
| Crops and thumbnails | the bucket only | The browser loads them straight from the bucket with signed links. Putting them on the volume would not make a search faster and the website would still need the bucket. |
| Items, labels, jobs | MongoDB | An admin edit shows at once. |

Nothing in the code fetches anything from Kaggle. The notebook's output is whatever you upload to the bucket yourself (section 7A); the code only reads its layout.

## 3. Google Cloud: one bucket, two service accounts, one CORS rule

1. Create **one bucket**. Its name is `CATALOGUE_GCS_BUCKET` (website and Modal). Everything lives under one folder, `CATALOGUE_GCS_PREFIX` (default `catalogue/`); set the same value on both sides.
2. Create **two service accounts** (never one account for both; the website's key sits on a web server):
   * **Modal's**: read, write, list and delete objects in the bucket, and "Vertex AI User" (captions and the Vertex image/text signals; without Vertex, photo search still works with DINOv2 + SigLIP + colour and text search uses SigLIP only). Its JSON key goes into the Modal secret (section 5).
   * **The website's signer**: read and create objects on that one bucket, nothing else. Its JSON key signs the picture links and the admin's upload links; it is never used to call Google. Its key goes into the website's `.env` as text (`CATALOGUE_GCS_KEY_JSON`, section 6): no key file is kept on the server. The role names are my suggestion for the words in `ARCHITECTURE.md` ("Storage Object Viewer" and "Storage Object Creator" on the bucket); **not checked in a real project**.
3. **CORS on the bucket.** The admin screen sends each PDF/photo from the browser straight to the bucket with a signed `PUT`, and a `PUT` from another origin makes the browser ask first (a preflight). Save this as `cors.json`, put your real site address(es) in `origin`, and apply it:

   ```json
   [{ "origin": ["https://YOUR-SITE.onrender.com", "http://localhost:8080"],
      "method": ["PUT", "GET", "HEAD"],
      "responseHeader": ["Content-Type", "x-goog-content-length-range"],
      "maxAgeSeconds": 3600 }]
   ```
   ```bash
   gcloud storage buckets update gs://YOUR-BUCKET --cors-file=cors.json
   ```
   Google's rule is that every header the browser lists in a preflight must be in `responseHeader`, and `OPTIONS` is not listed under `method`. The upload sends `Content-Type` and `x-goog-content-length-range` (`server/catalogue/gcsSigner.js`). **Not verified:** how Google treats `x-goog-content-length-range` together with CORS (the code's own comment says the same). If an upload is refused in the browser, open the browser's network tab, read the failed preflight, and add the header it names.

## 4. MongoDB: the same database as the studio

The website reads the catalogue through the studio's MongoDB connection, so it sees **the database named in `swatchroom/.env` `MONGODB_URI`** (its default is `swatchroom`). The Modal side must write to that same database, in the same cluster.

* In the Modal secret, `MONGODB_DB` **wins over a database named inside the URI**. If you set it, set it to the studio's database name. If they differ, an import succeeds and the site never sees the items.
* Atlas only accepts connections from addresses on its Network Access list and Modal containers have no fixed address (details in the header of `catalogue/modal_app.py`). **Not verified from here.**
* The four collections are created by the code, prefixed `terucon_` (`terucon_catalogues`, `terucon_catalogue_items`, `terucon_catalogue_releases`, `terucon_catalogue_jobs`).

## 5. Modal: three secrets, a self-test, a deploy

Run from the `catalogue/` folder, logged in to Modal (`modal setup`):

```bash
modal secret create terucon-catalogue-keys  API_KEYS="$(openssl rand -hex 32),$(openssl rand -hex 32)"
modal secret create terucon-catalogue-gcp   GCP_SERVICE_ACCOUNT_JSON="$(cat modal-service-account.json)" CATALOGUE_GCS_BUCKET=YOUR-BUCKET CATALOGUE_GCS_PREFIX=catalogue/
modal secret create terucon-catalogue-mongo MONGODB_URI='mongodb+srv://USER:PASSWORD@CLUSTER/?retryWrites=true&w=majority' MONGODB_DB=THE-STUDIOS-DATABASE
modal run    modal_app.py::selftest      # one GPU container: loads both models, checks the vector sizes; prints PASS or FAIL
modal deploy modal_app.py                # prints the two web addresses
```

`selftest` and the image build both fail if the SigLIP tokenizer cannot be made (it needs `sentencepiece`, which is now in `requirements.txt` and in the image). The first deploy builds the image and bakes the weights in: it takes a while and is billed as build time.

Cost controls (environment variables read **when you deploy**): `CATALOGUE_GPU_TIER=fast` (L40S first instead of L4), `CATALOGUE_MIN_CONTAINERS=1` (one search container always warm: no cold start, an idle GPU is billed), `CATALOGUE_SCALEDOWN_S` (default 300), `CATALOGUE_REQUIRE_PROXY_AUTH=1`. The search pool never has more than 3 containers. The website sends at most one wake-up call a minute, and only when the catalogue is ready.

## 6. The website's settings (the **root** `.env`, not `swatchroom/.env`)

All are listed, with their effects, in `.env.example` section 8. The ones you must set:

| Setting | Value |
|---|---|
| `CATALOGUE_MODAL_SEARCH_URL`, `CATALOGUE_MODAL_INGEST_URL` | the two addresses `modal deploy` printed |
| `CATALOGUE_MODAL_KEY` | **one** of the two `API_KEYS` from the first secret |
| `CATALOGUE_GCS_BUCKET`, `CATALOGUE_GCS_PREFIX` | the same as in the Modal secret |
| `CATALOGUE_GCS_KEY_JSON` | the website signer's JSON key **as text**, in `.env` itself (no file). The whole downloaded file between **single** quotes, or the same file as base64. Details below. |
| `AUTH_ADMIN_TOKEN` | 32+ random characters; you paste it on the catalogue admin page. Without it the admin API does not exist (404). |

**The signing key in `.env`.** Open the downloaded key file, copy everything, and write it as one setting:

```
CATALOGUE_GCS_KEY_JSON='{"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"...", ...}'
```

* **Single quotes, not double.** The `.env` reader takes single-quoted text literally (it may even span lines, so the file pasted as downloaded works), but expands `\n` inside double quotes, which breaks the key. A wrong paste is named, with the fix, in the start-up warnings (`  ! CATALOGUE_GCS_KEY_JSON is not the service-account JSON ...`), in the server log and in the catalogue admin page's **Check**; the text itself is never printed. `/api/catalogue/status` only says `storage-not-configured`.
* **Or base64, no quotes** (nothing to get wrong): `base64 -i the-key.json | tr -d '\n'` on a Mac, then `CATALOGUE_GCS_KEY_JSON=<that output>`.
* After pasting, **delete the downloaded file** (or keep it somewhere outside this folder). `.env` is ignored by git, so it does not go to GitHub, and the key is treated as a secret by the settings code (not in the banner, a warning or a listing of the settings). Changing it in `.env` takes effect on the next request.
* `CATALOGUE_GCS_KEY_FILE` (a path to the file) still works if you prefer a file, but `CATALOGUE_GCS_KEY_JSON` wins if both are set, with a warning.
* Whatever form it takes, **the website has to hold this key to sign links**: signing needs the private key, so it cannot be left off the server. What is avoided is a key *file* sitting in the project folder or on the disk.

**On Render:** nothing is read from GitHub for secrets. Render builds from the repository, but the settings are typed in the service's **Environment** tab. Add `CATALOGUE_GCS_KEY_JSON` there and paste the file's text (or the base64) as the value, **without** surrounding quotes; the other values go in the same place (`render.yaml` lists them with `sync: false`, so Render asks for them and does not read them from the repository). Not deployed from here.

### Where each value comes from

| Setting | Where to find it |
|---|---|
| `CATALOGUE_MODAL_SEARCH_URL`, `CATALOGUE_MODAL_INGEST_URL` | Printed by `modal deploy modal_app.py` (run in `catalogue/`), one address per app: the labels in `catalogue/modal_app.py` are `terucon-catalogue-search` and `terucon-catalogue-ingest`, so they should look like `https://<your-workspace>--terucon-catalogue-search.modal.run` (by the pattern of the address your other app, `vision-catalog`, has; the deploy output is the authority). Paste each **exactly as printed, with nothing added after `.modal.run`**: the website adds `/v1/search`, `/v1/ingest` and `/healthz` itself. An address from `visionstack.py` (labels `vision-moge2`, `vision-catalog`, and so on, paths like `/v1/embed`) is a different app with a different interface and does not work here. Until `terucon-catalogue` is deployed, these two do not exist. |
| `CATALOGUE_MODAL_KEY` | One of the values you gave `API_KEYS` when you created the Modal secret `terucon-catalogue-keys` (`openssl rand -hex 32` gives a 64-character one). Modal's command line lists secret **names** only (`modal secret list`), never values. If you did not keep it, make a new one and redeploy: `modal secret create terucon-catalogue-keys API_KEYS="$(openssl rand -hex 32)" --force`, then `modal deploy modal_app.py` again. It must be a key of **this** secret, not of `vision-api-keys` (the other app's). |
| `CATALOGUE_GCS_BUCKET` | Google Cloud Console, **Cloud Storage → Buckets**: the bucket's name, without `gs://`. (Or `gcloud storage buckets list`.) The same value as `CATALOGUE_GCS_BUCKET` in the Modal secret `terucon-catalogue-gcp`. |
| `CATALOGUE_GCS_PREFIX` | Leave `catalogue/`, unless you changed it in the Modal secret: the two must match. |
| `CATALOGUE_GCS_KEY_JSON` | Google Cloud Console, **IAM & Admin → Service Accounts** → the website signer account from section 3 (not Modal's) → **Keys** tab → **Add key → Create new key → JSON**. The file downloads once; Google does not show it again. |
| `AUTH_ADMIN_TOKEN` | You make it up: 32 or more random characters (`openssl rand -hex 24`). |

## 7. Getting the first catalogue in

**A. Your own files, already in the bucket (no laptop download, no Kaggle fetch).** Upload the notebook's whole output folder (the folder that holds `state.sqlite` and `crops/`) to the bucket yourself:

```bash
gcloud storage cp -r "OUTPUT-FOLDER/*" "gs://YOUR-BUCKET/catalogue/imports/superbond-colour/run1/"
```
(`catalogue/` is `CATALOGUE_GCS_PREFIX`.) Then, from `catalogue/`:

```bash
modal run modal_app.py::import_bundle --catalogue superbond-colour --key imports/superbond-colour/run1 --create "Superbond colours" --activate
```
It copies the folder next to the bucket, checks it, publishes it (crops, thumbnails, release, MongoDB), puts the release on the Modal volume, and (with `--activate`) makes it live. Without `--activate` it is stored and not live; make it live from the admin screen or `python -m terucon_catalogue activate --catalogue superbond-colour --release <id>`. Add `--with-pdf` if the original PDF is in the same folder and you want it kept in the bucket. Re-running the same command changes nothing. A damaged folder (a crop that does not match its checksum, for example) stops before anything is written; an item with no usable vectors is left out and the report says so. `--create` is needed only the first time: nothing is created by accident.

**B. The admin screen** (`/admin/catalogue`, behind `AUTH_ADMIN_TOKEN`): create a catalogue, upload a PDF or photos, start processing on Modal, edit labels, choose the live release. When a job finishes, its release is put on the volume too.

**C. Publish from your own computer** (`python -m terucon_catalogue import-bundle --bundle <folder> --catalogue <id>`, needs `MONGODB_URI` and the bucket settings locally). Then run `modal run modal_app.py::prime --catalogue <id>` to copy the live release (and the one before it, for a fast rollback) onto the volume.

## 8. Check it

1. Open `/finder` signed in. If it says "not switched on", read `GET /api/catalogue/status` (needs a signed-in session): `reasons` is one of `off`, `modal-not-configured` (a URL or the key is missing), `storage-not-configured` (the signing key file or bucket), `database-unavailable`, `no-live-catalogue` (nothing is activated yet).
2. On the admin page, **Check** pings both Modal apps, the database and the signing key. It **wakes the apps and is billed**.
3. Search with a photo, then with a spot on a photo, then colour only, then words.
4. Scores are relative to the other results (`finalScore` is min-max normalised); the pages never show them as a percentage.

## 9. What is and is not verified

* **Tested against fakes** (a local folder as the bucket, an in-memory database, a fake Modal): the import, the volume seeding, the search, the gateway, the admin API. 793 Python tests and the JavaScript and browser tests pass.
* **Run once with the real DINOv2 and SigLIP weights**, on a Mac's CPU, on a synthetic six-page PDF: compute, publish, search found the right page in 6 of 6 distorted copies, and a search container reading only the volume made no request to the bucket. Synthetic swatches only: **this says nothing about real material photos**.
* **Never run:** Modal (the app has not been deployed), a real bucket (signed uploads, CORS, signed links), a real MongoDB (the writes use `UpdateOne` with `$setOnInsert`), Vertex AI, and your real catalogue.


## Giving every item the id printed in its catalogue PDF (`assign-ids`)

A catalogue PDF with no text layer (the SuperBond colour catalogue) is imported with no product ids, although every page prints its code under the swatch. Read the codes off the pages once (by eye or any way you trust) into a JSON table like `catalogue/data/superbond-colour-ids.json` (page number -> printed code and printed name; a page that is not a product says `"hide": true`), then:

```
python -m terucon_catalogue assign-ids --catalogue superbond-colour --table catalogue/data/superbond-colour-ids.json            # a dry run: says what would change
python -m terucon_catalogue assign-ids --catalogue superbond-colour --table ... --apply --backup my-backup.json                # writes
python -m terucon_catalogue assign-ids --catalogue superbond-colour --undo my-backup.json                                       # puts it back
modal run catalogue/modal_app.py::prime --catalogue superbond-colour                                                            # puts the new live release on the Modal volume
```

It sets `productId` (`TIPL-` + the code), the label and a few attributes on each item in MongoDB, hides pages that are not products, and writes a new release with the same vectors byte for byte and the ids in its `items.json`, which then becomes the live one (the old one stays for a roll back). It never changes an `itemId`, a picture key or a vector row. A code printed on two pages is one product with two photos. The design is then also a shop product under the same id (`tools/build-shop-catalogue.js`).
