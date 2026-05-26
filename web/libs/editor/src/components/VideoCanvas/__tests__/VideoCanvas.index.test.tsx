// web/libs/editor/src/components/VideoCanvas/__tests__/VideoCanvas.index.test.tsx
/** Tests that VideoCanvas, when given an `index`, uses index.timeAt/frameAt
 *  instead of `frame/framerate` math. We inspect the refSource exposed via
 *  the forwarded ref. */
import React from "react";
import { render } from "@testing-library/react";
import { VideoCanvas } from "../VideoCanvas";
import { VideoIndex } from "../../../lib/VideoIndex";

function makeIndex() {
  return VideoIndex.fromPayload({
    content_key: "k", frame_count: 6, duration: 0.2167, codec: "h264",
    pts: [0, 0.05, 0.10, 0.13, 0.18, 0.2167],
  });
}

describe("VideoCanvas index-aware seek", () => {
  it("goToFrame(N) sets currentTime to index.timeAt(N)", () => {
    const ref = React.createRef<any>();
    render(<VideoCanvas ref={ref} src="data:," index={makeIndex()} />);
    // currentTime is a setter on the refSource. We mock the underlying
    // videoRef.current to a plain object that records writes.
    const writes: number[] = [];
    Object.defineProperty(ref.current, "currentTime", {
      set: (v: number) => writes.push(v),
      get: () => writes[writes.length - 1] ?? 0,
      configurable: true,
    });
    ref.current.goToFrame(3);
    expect(writes[writes.length - 1]).toBeCloseTo(0.10, 4);
  });
});
