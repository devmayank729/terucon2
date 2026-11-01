/**
 * Handing the cropped picture to the Design Studio.
 *
 * The studio is a separate page with its own program that we do not edit. It takes a photo through its own hidden file input, as if
 * the person had picked a file, and runs its normal flow (scan, rooms, rendering). So the hand-over is: keep the picture in this
 * browser (IndexedDB, same site, never sent anywhere), go to the studio with a one-time code in the address, and there feed.js puts
 * the picture into that file input. The picture is deleted from the browser as soon as the studio has taken it, and in any case
 * after ten minutes.
 */

export const STUDIO_PATH = '/design-studio';
export const ID_PATTERN = /^[a-f0-9]{32}$/;
const DB = 'terucon-inspiration';
const STORE = 'pending';
const KEEP_MS = 10 * 60 * 1000;

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('no IndexedDB'));
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB failed'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked'));
  });
}

/** Run `work(store)` in one transaction and resolve with what it returns once the transaction has committed. */
function inTransaction(db, mode, work) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    let result;
    try {
      result = work(transaction.objectStore(STORE));
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(result?.result ?? result);
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB was stopped'));
  });
}

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/** Keep a picture for the studio. @returns {Promise<string>} the one-time code */
export async function stash(blob, meta = {}) {
  const db = await openDb();
  try {
    const id = randomId();
    await inTransaction(db, 'readwrite', (store) => {
      // anything left over from earlier (a studio that never opened) goes now
      store.openCursor().onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return;
        if (Date.now() - (cursor.value?.created ?? 0) > 60 * 60 * 1000) cursor.delete();
        cursor.continue();
      };
      return store.put({ blob, meta, created: Date.now() }, id);
    });
    return id;
  } finally {
    db.close();
  }
}

/** Take a stashed picture out (it is deleted in the same step). @returns {Promise<{blob: Blob, meta: object} | null>} null when there is none or it is too old */
export async function take(id) {
  if (!ID_PATTERN.test(String(id))) return null;
  const db = await openDb();
  try {
    let found = null;
    await inTransaction(db, 'readwrite', (store) => {
      const get = store.get(id);
      get.onsuccess = () => {
        found = get.result ?? null;
        if (found) store.delete(id);
      };
      return get;
    });
    if (!found || !(found.blob instanceof Blob) || Date.now() - found.created > KEEP_MS) return null;
    return { blob: found.blob, meta: found.meta ?? {} };
  } finally {
    db.close();
  }
}

/** Keep the picture and go to the Design Studio. Rejects (nothing happens) when the browser will not keep it. */
export async function sendToStudio(blob, meta = {}) {
  const id = await stash(blob, meta);
  location.assign(`${STUDIO_PATH}?import=${id}`);
  return id;
}
