/**
 * WASM バイナリの IndexedDB キャッシュ（ADR-004 §3: 16MB WASM は初回のみ取得し以降キャッシュ）。
 * COOP/COEP 非依存で機能する（isolation 不要, ADR-004）。
 * fetch と組み合わせて「初回=cold / 2回目=温(IndexedDB)」のロード時間差を計測する。
 */
const DB_NAME = "pdf-compressor-wasm-cache";
const STORE = "wasm";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet(key: string): Promise<ArrayBuffer | undefined> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as ArrayBuffer | undefined);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function idbSet(key: string, value: ArrayBuffer): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function idbClear(): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/**
 * key に対応する wasm バイトを返す。IndexedDB になければ url から fetch して保存する。
 * 返り値の fromCache で cold/温を区別する。
 */
export async function loadWasmBytes(
  key: string,
  url: string,
): Promise<{ bytes: ArrayBuffer; loadMs: number; fromCache: boolean }> {
  const t0 = performance.now();
  const cached = await idbGet(key);
  if (cached) {
    return { bytes: cached, loadMs: performance.now() - t0, fromCache: true };
  }
  const res = await fetch(url);
  const bytes = await res.arrayBuffer();
  await idbSet(key, bytes.slice(0)); // 保存用にコピー（元は compile に使う）
  return { bytes, loadMs: performance.now() - t0, fromCache: false };
}
