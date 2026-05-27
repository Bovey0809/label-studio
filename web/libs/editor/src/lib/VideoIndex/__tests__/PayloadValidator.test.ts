import { PayloadValidator } from "../PayloadValidator";

describe("PayloadValidator", () => {
  it("accepts a valid dense payload", () => {
    const v = new PayloadValidator();
    const result = v.validate({
      content_key: "k", frame_count: 3, duration: 0.1,
      codec: "h264", pts: [0, 0.05, 0.1],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a valid CFR shorthand payload", () => {
    const v = new PayloadValidator();
    const result = v.validate({
      content_key: "k", frame_count: 90, duration: 3.0,
      codec: "h264", cfr: { fps: 30 },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects empty pts array", () => {
    const v = new PayloadValidator();
    const result = v.validate({ content_key: "k", frame_count: 0, duration: 0, codec: "h264", pts: [] });
    expect(result.ok).toBe(false);
  });

  it("rejects non-monotonic pts", () => {
    const v = new PayloadValidator();
    const result = v.validate({
      content_key: "k", frame_count: 3, duration: 0.1, codec: "h264",
      pts: [0.0, 0.05, 0.04],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/monotonic/i);
  });

  it("warns but accepts when frame_count disagrees with pts.length", () => {
    const v = new PayloadValidator();
    const result = v.validate({
      content_key: "k", frame_count: 99, duration: 0.1, codec: "h264",
      pts: [0, 0.05, 0.1],
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some(w => /frame_count/i.test(w))).toBe(true);
  });

  it("rejects missing content_key", () => {
    const v = new PayloadValidator();
    // @ts-expect-error intentional bad input
    const result = v.validate({ frame_count: 1, duration: 0, codec: "h264", pts: [0] });
    expect(result.ok).toBe(false);
  });
});
