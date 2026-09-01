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
  expectedSha256?: string,
): Promise<{ bytes: ArrayBuffer; loadMs: number; fromCache: boolean }> {
  const t0 = performance.now();
  const cached = await idbGet(key);
  if (cached) {
    // 保存時に検証済みのため信頼する（cold fetch 時のみ検証）。
    return { bytes: cached, loadMs: performance.now() - t0, fromCache: true };
  }
  const res = await fetch(url);
  const bytes = await res.arrayBuffer();
  // CDN 等の外部取得はサプライチェーン対策として SHA-256 で整合性検証する（ADR-004）。
  if (expectedSha256) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (hex !== expectedSha256) {
      throw new Error(`WASM integrity check failed for ${key} (expected ${expectedSha256}, got ${hex})`);
    }
  }
  await idbSet(key, bytes.slice(0)); // 保存用にコピー（元は compile に使う）
  return { bytes, loadMs: performance.now() - t0, fromCache: false };
}
