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

  async load(_args: { videoUrl: string }): Promise<VideoIndex> {
    const pollIntervalMs = this.opts.pollIntervalMs ?? 1000;
    while (true) {
      const r = await this.opts.transport.get();
      if (r.status === 200) {
        return this.buildIndex(r.body);
      }
      if (r.status === 202) {
        await sleep(pollIntervalMs);
        continue;
      }
      if (r.status === 409) {
        throw new Error("wasm-fallback-required"); // handled in Task 2.6
      }
      if (r.status === 422) {
        throw new Error(`video index failed: ${r.body?.error ?? "unknown"}`);
      }
      throw new Error(`unexpected status ${r.status}`);
    }
  }

  private buildIndex(payload: IndexPayload): VideoIndex {
    const v = this.validator.validate(payload);
    if (!v.ok) throw new Error(`invalid index payload: ${v.error}`);
    for (const w of v.warnings) console.warn(`[VideoIndex] ${w}`);
    return VideoIndex.fromPayload(payload);
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
