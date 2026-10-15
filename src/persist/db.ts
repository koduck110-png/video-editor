// ブラウザの中（IndexedDB）に作業内容と素材ファイルを保存する。どこにも送らない。

const DB_NAME = 'kantan-video-editor';
const DB_VERSION = 1;

export interface SavedAsset {
  id: string;
  name: string;
  file: Blob;
}

export interface SavedState {
  project: unknown;
  assetOrder: string[];
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

function run<T>(store: 'assets' | 'state', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error ?? req.error);
        tx.onabort = () => reject(tx.error ?? new Error('aborted'));
      }),
  );
}

export function saveAssetRecord(rec: SavedAsset): Promise<unknown> {
  return run('assets', 'readwrite', (s) => s.put(rec));
}

export function deleteAssetRecord(id: string): Promise<unknown> {
  return run('assets', 'readwrite', (s) => s.delete(id));
}

export function saveStateRecord(state: SavedState): Promise<unknown> {
  return run('state', 'readwrite', (s) => s.put(state, 'current'));
}

export async function loadSaved(): Promise<{ state: SavedState | undefined; assets: SavedAsset[] }> {
  const state = await run<SavedState | undefined>('state', 'readonly', (s) => s.get('current'));
  const assets = await run<SavedAsset[]>('assets', 'readonly', (s) => s.getAll());
  return { state, assets };
}

export async function clearSaved(): Promise<void> {
  await run('assets', 'readwrite', (s) => s.clear());
  await run('state', 'readwrite', (s) => s.clear());
}
