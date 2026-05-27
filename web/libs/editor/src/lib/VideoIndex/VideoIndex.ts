import type { CfrPayload, DensePayload, IndexPayload } from "./types";

export class VideoIndex {
  static fromPayload(payload: IndexPayload): VideoIndex {
    if ("cfr" in payload) return new VideoIndex(payload, null, payload.cfr);
    return new VideoIndex(payload, payload.pts, null);
  }

  private constructor(
    private readonly payload: IndexPayload,
    private readonly pts: number[] | null,
    private readonly cfr: { fps: number; count?: number } | null,
  ) {}

  /** The raw payload this index was built from (for write-through caching). */
  toPayload(): IndexPayload {
    return this.payload;
  }

  get length(): number {
    return this.payload.frame_count;
  }

  get duration(): number {
    return this.payload.duration;
  }

  get contentKey(): string {
    return this.payload.content_key;
  }

  /** 1-based frame number -> time in seconds. Clamps to valid range. */
  timeAt(frame: number): number {
    const n = Math.max(1, Math.min(frame, this.length));
    if (this.cfr) return (n - 1) / this.cfr.fps;
    return this.pts![n - 1];
  }

  /** Time in seconds -> largest 1-based frame N with timeAt(N) <= time. */
  frameAt(time: number): number {
    if (time <= 0) return 1;
    if (this.cfr) {
      const n = Math.floor(time * this.cfr.fps) + 1;
      return Math.max(1, Math.min(n, this.length));
    }
    const pts = this.pts!;
    if (time >= pts[pts.length - 1]) return pts.length;
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pts[mid] <= time) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}
