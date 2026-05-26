import { probeWithWasm, type WasmBackend } from "../WasmProberWorker";

describe("WasmProberWorker (contract)", () => {
  it("invokes the backend and assembles an IndexPayload", async () => {
    const backend: WasmBackend = {
      async probe() {
        return { pts: [0, 0.05, 0.1], codec: "h264", width: 64, height: 64 };
      },
    };
    const result = await probeWithWasm("https://example.com/v.mp4", { backend });
    expect(result.content_key).toBeTruthy();
    expect(result.frame_count).toBe(3);
    expect((result as any).pts).toEqual([0, 0.05, 0.1]);
  });

  it("derives content_key from url + length for browser-only key", async () => {
    const backend: WasmBackend = {
      async probe() { return { pts: [0], codec: "h264", width: 1, height: 1 }; },
    };
    const a = await probeWithWasm("https://x/a.mp4", { backend });
    const b = await probeWithWasm("https://x/b.mp4", { backend });
    expect(a.content_key).not.toBe(b.content_key);
  });

  it("rejects when backend returns no pts", async () => {
    const backend: WasmBackend = {
      async probe() { return { pts: [], codec: "h264", width: 1, height: 1 }; },
    };
    await expect(probeWithWasm("u", { backend })).rejects.toThrow(/no pts/i);
  });
});
