import type { IndexPayload } from "./types";

const STORE_NAME = "payloads";

export class VideoIndexCache {
  private dbPromise: Promise<IDBDatabase>;

  constructor(private readonly dbName: string = "ls-video-index") {
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME, { keyPath: "content_key" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async get(content_key: string): Promise<IndexPayload | undefined> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(content_key);
      req.onsuccess = () => resolve(req.result as IndexPayload | undefined);
      req.onerror = () => reject(req.error);
    });
  }

  async put(payload: IndexPayload): Promise<void> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(payload);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}
