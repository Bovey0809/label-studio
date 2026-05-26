import type { DensePayload } from "./types";

export interface WasmProbeRaw {
  pts: number[];
  codec: string;
  width: number;
  height: number;
}

export interface WasmBackend {
  probe(videoUrl: string): Promise<WasmProbeRaw>;
}

/** Default backend: spins up the ffmpeg.wasm worker.
 *  Currently a placeholder — see Task 2.7 implementation note.
 *  Wired later in a follow-up task. */
const defaultBackend: WasmBackend = {
  async probe(_videoUrl: string): Promise<WasmProbeRaw> {
    throw new Error("ffmpeg.wasm backend not yet wired; pass an explicit backend for now");
  },
};

export async function probeWithWasm(
  videoUrl: string,
  opts: { backend?: WasmBackend } = {},
): Promise<DensePayload> {
  const backend = opts.backend ?? defaultBackend;
  const raw = await backend.probe(videoUrl);
  if (!raw.pts || raw.pts.length === 0) {
    throw new Error("wasm probe returned no pts");
  }
  return {
    content_key: await hashStringAsync(`wasm|${videoUrl}|${raw.pts.length}|${raw.pts[raw.pts.length - 1]}`),
    frame_count: raw.pts.length,
    duration: raw.pts[raw.pts.length - 1],
    codec: raw.codec,
    width: raw.width,
    height: raw.height,
    pts: raw.pts,
  };
}

async function hashStringAsync(material: string): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle?.digest) {
    const buf = new TextEncoder().encode(material);
    const digest = await crypto.subtle.digest("SHA-1", buf);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Fallback: cheap non-crypto hash for non-secure contexts (tests in jsdom)
  let h = 5381;
  for (let i = 0; i < material.length; i++) h = ((h * 33) ^ material.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}
