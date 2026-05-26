import { PayloadValidator } from "./PayloadValidator";
import { VideoIndex } from "./VideoIndex";
import type { IndexPayload } from "./types";

export interface TransportResponse { status: number; body: any }
export interface LoaderTransport {
  get(): Promise<TransportResponse>;
  post(body: IndexPayload): Promise<TransportResponse>;
}

export interface LoaderOptions {
  transport: LoaderTransport;
  pollIntervalMs?: number;
  fallbackTimeoutMs?: number;
  wasmProbe?: (videoUrl: string) => Promise<IndexPayload>;
  cache?: { get(k: string): Promise<IndexPayload | undefined>; put(p: IndexPayload): Promise<void> };
}

export class VideoIndexLoader {
  private readonly validator = new PayloadValidator();

  constructor(private readonly opts: LoaderOptions) {}

  async load(args: { videoUrl: string }): Promise<VideoIndex> {
    const pollIntervalMs = this.opts.pollIntervalMs ?? 1000;
    const fallbackTimeoutMs = this.opts.fallbackTimeoutMs ?? 10_000;
    const serverPromise = this.serverPath(pollIntervalMs);
    const wasmPromise = this.wasmPath(args.videoUrl, fallbackTimeoutMs);
    // Suppress unhandled rejections on the abandoned promise after one wins.
    serverPromise.catch(() => {});
    wasmPromise.catch(() => {});
    try {
      return await Promise.any([serverPromise, wasmPromise]);
    } catch (e: any) {
      // AggregateError: all paths failed. Re-throw the server error (most meaningful).
      if (e?.errors) {
        const serverErr = e.errors.find((err: any) => err?.message !== "no-wasm-probe");
        if (serverErr) throw serverErr;
      }
      throw e;
    }
  }

  private async serverPath(pollIntervalMs: number): Promise<VideoIndex> {
    while (true) {
      const r = await this.opts.transport.get();
      if (r.status === 200) return this.buildIndex(r.body);
      if (r.status === 202) { await sleep(pollIntervalMs); continue; }
      if (r.status === 409) throw new Error("server-unavailable");
      if (r.status === 422) throw new Error(`video index failed: ${r.body?.error ?? "unknown"}`);
      throw new Error(`unexpected status ${r.status}`);
    }
  }

  private async wasmPath(videoUrl: string, fallbackTimeoutMs: number): Promise<VideoIndex> {
    if (!this.opts.wasmProbe) {
      // Without a wasm prober configured, wasm path never resolves.
      // Reject so Promise.any can still settle on the server path's result.
      return Promise.reject(new Error("no-wasm-probe"));
    }
    // Race trigger: wait fallbackTimeoutMs unless the server returns 409 sooner.
    const trigger = new Promise<void>((resolve) => setTimeout(resolve, fallbackTimeoutMs));
    // Also trigger immediately on 409. Detect by peeking serverPath errors:
    const immediate = (async () => {
      try { await this.serverPath(/*poll*/ 60_000); }
      catch (e: any) { if (e?.message === "server-unavailable") return; throw e; }
    })().catch(() => {});
    await Promise.race([trigger, immediate]);
    const payload = await this.opts.wasmProbe(videoUrl);
    // Best-effort POST back; ignore POST failure.
    try { await this.opts.transport.post(payload); } catch { /* swallow */ }
    return this.buildIndex(payload);
  }

  private buildIndex(payload: IndexPayload): VideoIndex {
    const v = this.validator.validate(payload);
    if (!v.ok) throw new Error(`invalid index payload: ${v.error}`);
    for (const w of v.warnings) console.warn(`[VideoIndex] ${w}`);
    return VideoIndex.fromPayload(payload);
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
