/** 아주 작은 IndexedDB 키-값 저장소. 내 약 목록은 이 기기 안에만 저장된다 (설계서 B1-3). */
const DB_NAME = "yaksok";
const STORE = "kv";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => {
      db.close();
      resolve(req.result as T);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export const idb = {
  get: <T>(key: string) => run<T | undefined>("readonly", (s) => s.get(key)).catch(() => undefined),
  set: (key: string, value: unknown) => run<void>("readwrite", (s) => s.put(value, key)).catch(() => undefined),
  del: (key: string) => run<void>("readwrite", (s) => s.delete(key)).catch(() => undefined),
};
