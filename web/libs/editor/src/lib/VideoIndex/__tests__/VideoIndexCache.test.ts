/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto";
import { VideoIndexCache } from "../VideoIndexCache";

// Polyfill structuredClone for jsdom environment
if (typeof structuredClone === 'undefined') {
  global.structuredClone = (obj: any) => JSON.parse(JSON.stringify(obj));
}

describe("VideoIndexCache", () => {
  let cache: VideoIndexCache;
  beforeEach(() => { cache = new VideoIndexCache(`test-${Math.random()}`); });

  it("round-trips a payload by content_key", async () => {
    const payload = { content_key: "k1", frame_count: 1, duration: 0, codec: "h264", pts: [0] };
    await cache.put(payload);
    const hit = await cache.get("k1");
    expect(hit?.content_key).toBe("k1");
    expect(hit?.frame_count).toBe(1);
  });

  it("returns undefined for unknown key", async () => {
    expect(await cache.get("nope")).toBeUndefined();
  });

  it("overwrites the same content_key on second put", async () => {
    await cache.put({ content_key: "k2", frame_count: 1, duration: 0, codec: "h264", pts: [0] });
    await cache.put({ content_key: "k2", frame_count: 2, duration: 0, codec: "h264", pts: [0, 0.1] });
    const hit = await cache.get("k2");
    expect(hit?.frame_count).toBe(2);
  });

  it("round-trips a payload by video URL", async () => {
    const payload = { content_key: "ck", frame_count: 5, duration: 1, codec: "h264", pts: [0, 0.2, 0.4, 0.6, 0.8] };
    await cache.putByUrl("/data/local-files/?d=a.mp4", payload);
    const hit = await cache.getByUrl("/data/local-files/?d=a.mp4");
    expect(hit?.content_key).toBe("ck");
    expect(hit?.frame_count).toBe(5);
  });

  it("getByUrl returns undefined for an unknown URL", async () => {
    expect(await cache.getByUrl("/unknown.mp4")).toBeUndefined();
  });

  it("putByUrl overwrites when the same URL is re-indexed (self-healing)", async () => {
    await cache.putByUrl("/v.mp4", { content_key: "old", frame_count: 1, duration: 0, codec: "h264", pts: [0] });
    await cache.putByUrl("/v.mp4", { content_key: "new", frame_count: 3, duration: 0, codec: "h264", pts: [0, 0.1, 0.2] });
    const hit = await cache.getByUrl("/v.mp4");
    expect(hit?.content_key).toBe("new");
    expect(hit?.frame_count).toBe(3);
  });
});
