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
