import { types } from "mobx-state-tree";
import { VideoIndex } from "../../../../lib/VideoIndex";

// Lazy import after MST stubs are in place
const VideoModule = require("../Video.js");

describe("Video MST integration", () => {
  it("exposes index and indexStatus volatile fields", () => {
    // Smoke: the MST factory should expose the volatile fields. We instantiate
    // the bare Model (no full store wiring) and assert defaults exist.
    const Model = VideoModule.VideoModelFactoryForTests
      ? VideoModule.VideoModelFactoryForTests()
      : null;
    expect(Model).toBeTruthy();
    const inst = Model.create({ type: "video" });
    expect(inst.index).toBeNull();
    expect(inst.indexStatus).toBe("idle");
  });

  it("setIndex transitions indexStatus to 'ready'", () => {
    const Model = VideoModule.VideoModelFactoryForTests();
    const inst = Model.create({ type: "video" });
    const idx = VideoIndex.fromPayload({
      content_key: "k", frame_count: 1, duration: 0, codec: "h264", pts: [0],
    });
    inst.setIndex(idx);
    expect(inst.indexStatus).toBe("ready");
    expect(inst.index).toBe(idx);
  });

  it("setIndex sets length to the index frame count", () => {
    const Model = VideoModule.VideoModelFactoryForTests();
    const inst = Model.create({ type: "video" });
    const idx = VideoIndex.fromPayload({
      content_key: "k", frame_count: 142, duration: 4.968, codec: "h264", pts: Array.from({ length: 142 }, (_, i) => i * 0.033),
    });
    inst.setIndex(idx);
    expect(inst.length).toBe(142);
  });

  it("setLength keeps the index frame count when an index is present", () => {
    const Model = VideoModule.VideoModelFactoryForTests();
    const inst = Model.create({ type: "video" });
    const idx = VideoIndex.fromPayload({
      content_key: "k", frame_count: 142, duration: 4.968, codec: "h264", pts: Array.from({ length: 142 }, (_, i) => i * 0.033),
    });
    inst.setIndex(idx);
    // The canvas may report a stale framerate-derived length (e.g. duration*24=114);
    // with an index present the model must keep the true frame count.
    inst.setLength(114);
    expect(inst.length).toBe(142);
  });

  it("setLength uses the given value when no index is present", () => {
    const Model = VideoModule.VideoModelFactoryForTests();
    const inst = Model.create({ type: "video" });
    inst.setLength(114);
    expect(inst.length).toBe(114);
  });

  it("setIndexStatus('failed') leaves index null and ready=false", () => {
    const Model = VideoModule.VideoModelFactoryForTests();
    const inst = Model.create({ type: "video" });
    inst.setIndexStatus("failed");
    expect(inst.indexStatus).toBe("failed");
    expect(inst.index).toBeNull();
  });

  it("addVideoRegion is a no-op when indexStatus is not 'ready'", () => {
    const Model = VideoModule.VideoModelFactoryForTests();
    const inst = Model.create({ type: "video" });
    // indexStatus defaults to "idle"
    const result = inst.addVideoRegion({});
    expect(result).toBeUndefined();
  });
});
