/**
 * The photos a phone has taken and not yet sent, kept in the browser's own storage (IndexedDB) so that a phone that reloads the page, loses
 * the connection or switches apps does not lose them. Nothing here leaves the phone: the photos are sent by capture-page.js and removed from
 * here the moment the server has them.
 *
 * Where IndexedDB is not allowed (some private windows, some in-app browsers) the same calls work from memory for as long as the page is
 * open, and `persistent` says which of the two it is, so the page can say "keep this page open until the photos are sent".
 */
const DB = 'terucon-capture';
const STORE = 'items';
const KEEP_MS = 24 * 60 * 60 * 1000;

let dbPromise = null;
const memory = new Map();
export let persistent = true;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('no IndexedDB'));
    let request;
    try {
      request = indexedDB.open(DB, 1);
    } catch (error) {
      return reject(error);
    }
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB failed'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked'));
  }).catch((error) => {
    persistent = false;
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

/** Run `work(store)` in one transaction; resolves with what `work` returns once the transaction has committed. */
async function run(mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let result;
    const transaction = db.transaction(STORE, mode);
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

/** @param {{id: string, token: string, blob: Blob, tags: string[], note: string, createdAt: number}} item */
export async function put(item) {
  memory.set(item.id, item);
  try {
    await run('readwrite', (store) => store.put(item));
  } catch {
    persistent = false; // kept in memory only
  }
}

/** Every unsent photo of one link (a photo of another link, or older than a day, is not returned and is cleaned away). */
export async function all(token) {
  let found = [];
  try {
    found = await run('readonly', (store) => store.getAll());
  } catch {
    found = [...memory.values()];
  }
  const now = Date.now();
  const stale = found.filter((item) => now - (item.createdAt ?? 0) > KEEP_MS);
  for (const item of stale) remove(item.id);
  return found.filter((item) => item.token === token && now - (item.createdAt ?? 0) <= KEEP_MS).sort((a, b) => a.createdAt - b.createdAt);
}

export async function remove(id) {
  memory.delete(id);
  try {
    await run('readwrite', (store) => store.delete(id));
  } catch {
    // nothing to remove from
  }
}
