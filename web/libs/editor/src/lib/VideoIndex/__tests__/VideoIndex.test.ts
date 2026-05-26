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

describe("VideoIndex (CFR shorthand backing)", () => {
  const cfr = { content_key: "k", frame_count: 90, duration: 3.0, codec: "h264", cfr: { fps: 30 } };

  it("timeAt produces 1-based frame * (1/fps)", () => {
    const idx = VideoIndex.fromPayload(cfr);
    expect(idx.timeAt(1)).toBeCloseTo(0.0, 6);
    expect(idx.timeAt(31)).toBeCloseTo(1.0, 6);
    expect(idx.timeAt(90)).toBeCloseTo(89 / 30, 6);
  });

  it("frameAt finds the floor of time*fps + 1", () => {
    const idx = VideoIndex.fromPayload(cfr);
    expect(idx.frameAt(0)).toBe(1);
    expect(idx.frameAt(0.034)).toBe(2);
    expect(idx.frameAt(1.0)).toBe(31);
    expect(idx.frameAt(10)).toBe(90); // past end
  });
});
