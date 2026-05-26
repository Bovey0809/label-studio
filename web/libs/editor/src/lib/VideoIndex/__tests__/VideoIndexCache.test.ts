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
});
