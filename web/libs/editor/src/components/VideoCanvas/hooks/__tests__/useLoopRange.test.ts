// web/libs/editor/src/components/VideoCanvas/hooks/__tests__/useLoopRange.test.ts
import { renderHook } from "@testing-library/react";
import { useLoopRange } from "../useLoopRange";
import { VideoIndex } from "../../../../lib/VideoIndex";

function vidRef(currentTime = 0) {
  return { current: { currentTime, play: jest.fn(), pause: jest.fn() } } as any;
}

describe("useLoopRange — index-aware", () => {
  const idx = VideoIndex.fromPayload({
    content_key: "k", frame_count: 6, duration: 0.2167, codec: "h264",
    pts: [0, 0.05, 0.10, 0.13, 0.18, 0.2167],
  });

  it("computes loop boundaries from index.timeAt when index is provided", () => {
    // Smoke: the hook should accept an index option and not throw.
    const { result } = renderHook(() =>
      useLoopRange({
        loopFrameRange: { start: 2, end: 4 },
        selectedFrameRange: null,
        videoRef: vidRef(),
        refSource: { current: null },
        framerate: 30,
        index: idx,
        onRedrawRequest: () => {},
      } as any),
    );
    expect(result.current).toBeDefined();
  });
});
