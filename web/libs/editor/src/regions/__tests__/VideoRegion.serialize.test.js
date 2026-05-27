import { VideoIndex } from "../../lib/VideoIndex";
import { buildVideoSequenceValue } from "../videoSequenceValue";

// A VFR-ish dense index: 5 frames whose PTS are NOT a clean 1/framerate grid.
const denseIndex = () =>
  VideoIndex.fromPayload({
    content_key: "k",
    frame_count: 5,
    duration: 0.234,
    codec: "h264",
    pts: [0.0, 0.033, 0.067, 0.1, 0.234],
  });

describe("buildVideoSequenceValue", () => {
  it("uses the index frame_count for framesCount when an index is present", () => {
    const value = buildVideoSequenceValue({
      index: denseIndex(),
      framerate: 24,
      length: 6, // a stale 24fps-derived length that must be ignored
      sequence: [{ frame: 1, x: 0 }],
    });
    expect(value.framesCount).toBe(5);
  });

  it("derives keyframe time from index.timeAt(frame), not frame/framerate", () => {
    const value = buildVideoSequenceValue({
      index: denseIndex(),
      framerate: 24,
      length: 5,
      sequence: [{ frame: 5, x: 10 }],
    });
    // ffmpeg PTS of frame 5 is 0.234s; 5/24 = 0.2083s would be the wrong, 24fps answer.
    expect(value.sequence[0].time).toBeCloseTo(0.234, 6);
    expect(value.sequence[0].x).toBe(10); // other keyframe fields preserved
  });

  it("falls back to frame/framerate when no index is present", () => {
    const value = buildVideoSequenceValue({
      index: null,
      framerate: 24,
      length: 100,
      sequence: [{ frame: 12 }],
    });
    expect(value.framesCount).toBe(100);
    expect(value.sequence[0].time).toBeCloseTo(12 / 24, 6);
  });
});
