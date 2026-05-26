import { VideoIndex } from "../VideoIndex";

describe("VideoIndex (dense backing)", () => {
  const ptsVfr = [0.0, 0.0333, 0.0667, 0.1, 0.15, 0.2167];

  it("reports length and duration", () => {
    const idx = VideoIndex.fromPayload({ content_key: "k", frame_count: 6, duration: 0.2167, codec: "h264", pts: ptsVfr });
    expect(idx.length).toBe(6);
    expect(idx.duration).toBeCloseTo(0.2167, 4);
  });

  it("timeAt(frame) returns the exact pts (1-based)", () => {
    const idx = VideoIndex.fromPayload({ content_key: "k", frame_count: 6, duration: 0.2167, codec: "h264", pts: ptsVfr });
    expect(idx.timeAt(1)).toBeCloseTo(0.0, 6);
    expect(idx.timeAt(3)).toBeCloseTo(0.0667, 4);
    expect(idx.timeAt(6)).toBeCloseTo(0.2167, 4);
  });

  it("frameAt(time) finds the largest pts <= time (1-based)", () => {
    const idx = VideoIndex.fromPayload({ content_key: "k", frame_count: 6, duration: 0.2167, codec: "h264", pts: ptsVfr });
    expect(idx.frameAt(0.0)).toBe(1);
    expect(idx.frameAt(0.04)).toBe(2);   // between 0.0333 and 0.0667
    expect(idx.frameAt(0.0667)).toBe(3);
    expect(idx.frameAt(0.5)).toBe(6);    // past end clamps to last
  });

  it("clamps timeAt() out-of-range to nearest valid frame", () => {
    const idx = VideoIndex.fromPayload({ content_key: "k", frame_count: 6, duration: 0.2167, codec: "h264", pts: ptsVfr });
    expect(idx.timeAt(0)).toBeCloseTo(0.0, 6);
    expect(idx.timeAt(999)).toBeCloseTo(0.2167, 4);
  });

  it("frameAt(time) below the first pts returns 1", () => {
    const idx = VideoIndex.fromPayload({ content_key: "k", frame_count: 6, duration: 0.2167, codec: "h264", pts: ptsVfr });
    expect(idx.frameAt(-1)).toBe(1);
  });
});
