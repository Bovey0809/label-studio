import { VideoIndexLoader, type LoaderTransport } from "../VideoIndexLoader";

function makeTransport(responses: Array<() => Promise<{ status: number; body: any }>>): LoaderTransport {
  let i = 0;
  return {
    async get() { return responses[i++ < responses.length ? i - 1 : responses.length - 1](); },
    async post(_body: any) { return { status: 201, body: { ok: true } }; },
  };
}

describe("VideoIndexLoader — server happy path", () => {
  it("resolves with a VideoIndex on 200", async () => {
    const t = makeTransport([
      async () => ({ status: 200, body: { content_key: "k", frame_count: 3, duration: 0.1, codec: "h264", pts: [0, 0.05, 0.1] } }),
    ]);
    const loader = new VideoIndexLoader({ transport: t, pollIntervalMs: 5, fallbackTimeoutMs: 60_000 });
    const idx = await loader.load({ videoUrl: "u" });
    expect(idx.length).toBe(3);
  });

  it("polls on 202 until 200", async () => {
    const t = makeTransport([
      async () => ({ status: 202, body: { status: "pending", content_key: "k" } }),
      async () => ({ status: 202, body: { status: "pending", content_key: "k" } }),
      async () => ({ status: 200, body: { content_key: "k", frame_count: 1, duration: 0, codec: "h264", pts: [0] } }),
    ]);
    const loader = new VideoIndexLoader({ transport: t, pollIntervalMs: 1, fallbackTimeoutMs: 60_000 });
    const idx = await loader.load({ videoUrl: "u" });
    expect(idx.length).toBe(1);
  });

  it("rejects on a 422 (failed)", async () => {
    const t = makeTransport([async () => ({ status: 422, body: { status: "failed", error: "corrupt" } })]);
    const loader = new VideoIndexLoader({ transport: t, pollIntervalMs: 1, fallbackTimeoutMs: 60_000 });
    await expect(loader.load({ videoUrl: "u" })).rejects.toThrow(/corrupt/i);
  });
});

describe("VideoIndexLoader — cache", () => {
  const payload = (ck: string, n: number) => ({
    content_key: ck,
    frame_count: n,
    duration: 0.1,
    codec: "h264",
    pts: Array.from({ length: n }, (_, i) => i * 0.05),
  });

  it("returns the cached index instantly (does not wait for the server)", async () => {
    const store = new Map<string, any>([["u", payload("k", 3)]]);
    // Server would return a DIFFERENT index; the resolved value must be the cached one,
    // proving load() did not block on (or use) the server for its result.
    const t = makeTransport([async () => ({ status: 200, body: payload("k", 9) })]);
    const cache = { get: async (url: string) => store.get(url), put: jest.fn(async () => {}) };
    const loader = new VideoIndexLoader({ transport: t, cache, pollIntervalMs: 1, fallbackTimeoutMs: 60_000 });

    const idx = await loader.load({ videoUrl: "u" });
    expect(idx.length).toBe(3); // cached, not the server's 9
  });

  it("write-through caches the server payload (keyed by url) on a miss", async () => {
    const puts: Array<[string, any]> = [];
    const t = makeTransport([async () => ({ status: 200, body: payload("k", 2) })]);
    const cache = { get: async () => undefined, put: async (url: string, p: any) => { puts.push([url, p]); } };
    const loader = new VideoIndexLoader({ transport: t, cache, pollIntervalMs: 1, fallbackTimeoutMs: 60_000 });

    const idx = await loader.load({ videoUrl: "u" });
    expect(idx.length).toBe(2);
    expect(puts).toEqual([["u", payload("k", 2)]]);
  });

  it("revalidates a cache hit in the background and re-applies a changed index", async () => {
    const store = new Map<string, any>([["u", payload("OLD", 3)]]);
    const t = makeTransport([async () => ({ status: 200, body: payload("NEW", 5) })]);
    const revalidated: any[] = [];
    const cache = { get: async (url: string) => store.get(url), put: async (url: string, p: any) => { store.set(url, p); } };
    const loader = new VideoIndexLoader({
      transport: t, cache, pollIntervalMs: 1, fallbackTimeoutMs: 60_000,
      onRevalidated: (idx) => revalidated.push(idx),
    });

    const idx = await loader.load({ videoUrl: "u" });
    expect(idx.length).toBe(3); // instant: stale cached value

    await new Promise((r) => setTimeout(r, 30)); // let background revalidation run
    expect(revalidated).toHaveLength(1);
    expect(revalidated[0].length).toBe(5);
    expect(store.get("u").content_key).toBe("NEW");
  });

  it("does not re-apply when revalidation finds the same content_key", async () => {
    const store = new Map<string, any>([["u", payload("same", 3)]]);
    const t = makeTransport([async () => ({ status: 200, body: payload("same", 3) })]);
    const revalidated: any[] = [];
    const cache = { get: async (url: string) => store.get(url), put: async () => {} };
    const loader = new VideoIndexLoader({
      transport: t, cache, pollIntervalMs: 1, fallbackTimeoutMs: 60_000,
      onRevalidated: (idx) => revalidated.push(idx),
    });

    await loader.load({ videoUrl: "u" });
    await new Promise((r) => setTimeout(r, 30));
    expect(revalidated).toHaveLength(0);
  });
});

describe("VideoIndexLoader — wasm fallback", () => {
  it("dispatches wasm probe on 409 and POSTs the result back", async () => {
    const posts: any[] = [];
    const transport: LoaderTransport = {
      async get() { return { status: 409, body: { status: "unavailable", error: "no ffmpeg" } }; },
      async post(body) { posts.push(body); return { status: 201, body: { ok: true } }; },
    };
    const wasmProbe = jest.fn().mockResolvedValue({
      content_key: "k", frame_count: 2, duration: 0.05, codec: "h264", pts: [0, 0.05],
    });
    const loader = new VideoIndexLoader({ transport, pollIntervalMs: 1, fallbackTimeoutMs: 60_000, wasmProbe });
    const idx = await loader.load({ videoUrl: "u" });
    expect(idx.length).toBe(2);
    expect(wasmProbe).toHaveBeenCalledTimes(1);
    expect(posts).toHaveLength(1);
    expect(posts[0].content_key).toBe("k");
  });

  it("races wasm against server when polling exceeds fallbackTimeoutMs", async () => {
    let gets = 0;
    const transport: LoaderTransport = {
      async get() {
        gets++;
        // Stay 202 indefinitely so wasm has to win.
        return { status: 202, body: { status: "pending", content_key: "k" } };
      },
      async post() { return { status: 201, body: {} }; },
    };
    const wasmProbe = jest.fn().mockResolvedValue({
      content_key: "k", frame_count: 1, duration: 0, codec: "h264", pts: [0],
    });
    const loader = new VideoIndexLoader({ transport, pollIntervalMs: 5, fallbackTimeoutMs: 20, wasmProbe });
    const idx = await loader.load({ videoUrl: "u" });
    expect(idx.length).toBe(1);
    expect(wasmProbe).toHaveBeenCalledTimes(1);
    expect(gets).toBeGreaterThanOrEqual(1); // server was being polled in parallel
  });
});
