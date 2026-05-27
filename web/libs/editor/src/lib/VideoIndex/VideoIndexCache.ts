import type { IndexPayload } from "./types";

const STORE_NAME = "payloads"; // keyed by content_key
const URL_STORE = "by_url"; // keyed by video URL (for instant pre-network lookup)

export class VideoIndexCache {
  private dbPromise: Promise<IDBDatabase>;

  constructor(private readonly dbName: string = "ls-video-index") {
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "content_key" });
        }
        if (!db.objectStoreNames.contains(URL_STORE)) {
          db.createObjectStore(URL_STORE, { keyPath: "url" });
        }
      };
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

  /** Look up a cached payload by the video URL (the key the client knows up front). */
  async getByUrl(url: string): Promise<IndexPayload | undefined> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const req = db.transaction(URL_STORE, "readonly").objectStore(URL_STORE).get(url);
      req.onsuccess = () => resolve((req.result as { url: string; payload: IndexPayload } | undefined)?.payload);
      req.onerror = () => reject(req.error);
    });
  }

  /** Cache a payload under a video URL. Overwrites, so re-indexed videos self-heal. */
  async putByUrl(url: string, payload: IndexPayload): Promise<void> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const req = db.transaction(URL_STORE, "readwrite").objectStore(URL_STORE).put({ url, payload });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}
