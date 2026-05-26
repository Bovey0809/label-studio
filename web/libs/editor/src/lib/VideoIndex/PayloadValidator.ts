import type { IndexPayload } from "./types";

export interface ValidationResult {
  ok: boolean;
  error?: string;
  warnings: string[];
}

export class PayloadValidator {
  validate(payload: IndexPayload | unknown): ValidationResult {
    const warnings: string[] = [];
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "payload is not an object", warnings };
    }
    const p = payload as Partial<IndexPayload>;
    if (typeof p.content_key !== "string" || !p.content_key) {
      return { ok: false, error: "missing content_key", warnings };
    }
    if ("cfr" in p && p.cfr) {
      if (typeof p.cfr.fps !== "number" || p.cfr.fps <= 0) {
        return { ok: false, error: "invalid cfr.fps", warnings };
      }
      return { ok: true, warnings };
    }
    const pts = (p as { pts?: number[] }).pts;
    if (!Array.isArray(pts) || pts.length === 0) {
      return { ok: false, error: "pts must be non-empty array", warnings };
    }
    for (let i = 1; i < pts.length; i++) {
      if (pts[i] < pts[i - 1]) {
        return { ok: false, error: "pts must be monotonic non-decreasing", warnings };
      }
    }
    if (typeof p.frame_count === "number" && p.frame_count !== pts.length) {
      warnings.push(`frame_count (${p.frame_count}) disagrees with pts.length (${pts.length}); using pts.length`);
    }
    return { ok: true, warnings };
  }
}
