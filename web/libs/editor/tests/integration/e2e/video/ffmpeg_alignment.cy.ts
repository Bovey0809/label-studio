import { Labels, LabelStudio, VideoView } from "@humansignal/frontend-test/helpers/LSF/index";
import { simpleVideoConfig, simpleVideoData } from "../../data/video_segmentation/regions";

/**
 * Regression test for ffmpeg frame alignment.
 *
 * The editor fetches a server-computed VideoIndex (the real ffmpeg PTS table) and
 * must use it — not the tag's static `framerate` — for both the total frame count
 * and per-keyframe timestamps in the serialized result. Otherwise annotations made
 * in Label Studio do not line up with ffmpeg's frame indexing (most visibly on
 * variable-frame-rate video).
 *
 * We stub /api/video-index/ with an index that is deliberately NOT a 24fps grid
 * (11 frames spaced 0.5s apart) so the index-driven values are unmistakably
 * different from the framerate fallback:
 *   - framesCount: 11 (index) vs ~131 (24fps over this clip)
 *   - frame 1 time: 0.0 (index pts[0]) vs 1/24 ≈ 0.0417 (framerate)
 *   - frame 3 time: 1.0 (index pts[2]) vs 3/24 = 0.125 (framerate)
 */

const INDEX_PTS = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];

const stubVideoIndex = () => {
  cy.intercept("GET", "**/api/video-index/**", {
    statusCode: 200,
    body: {
      content_key: "e2e-fixture",
      frame_count: INDEX_PTS.length,
      duration: 5.0,
      codec: "h264",
      width: 1280,
      height: 720,
      pts: INDEX_PTS,
    },
  }).as("videoIndex");
};

// Region creation is gated on the index being ready; make sure it loaded.
const expectIndexReady = () => {
  cy.window().should((win: any) => {
    const video = win.Htx.annotationStore.selected.objects.find((o: any) => o.type === "video");
    expect(video.indexStatus).to.eq("ready");
    expect(video.index).to.not.eq(null);
  });
};

describe("Video ffmpeg frame alignment", () => {
  it("serializes framesCount and keyframe time from the index, not the framerate", () => {
    stubVideoIndex();

    LabelStudio.params().config(simpleVideoConfig).data(simpleVideoData).withResult([]).init();
    LabelStudio.waitForObjectsReady();
    cy.wait("@videoIndex");
    expectIndexReady();

    Labels.select("Label 1");
    VideoView.drawRectRelative(0.2, 0.2, 0.5, 0.5);

    LabelStudio.serialize().then((result: any[]) => {
      const region = result.find((r) => r.type === "videorectangle");
      expect(region, "a video rectangle was created").to.exist;
      // framesCount must be the index length, not the 24fps-derived count.
      expect(region.value.framesCount).to.eq(INDEX_PTS.length);
      const first = region.value.sequence[0];
      expect(first.frame).to.eq(1);
      // index pts[0] = 0, NOT 1/24 ≈ 0.0417
      expect(first.time).to.eq(0);
    });
  });

  it("seeking to a frame stores that frame's ffmpeg PTS as its time", () => {
    stubVideoIndex();

    LabelStudio.params().config(simpleVideoConfig).data(simpleVideoData).withResult([]).init();
    LabelStudio.waitForObjectsReady();
    cy.wait("@videoIndex");
    expectIndexReady();

    Labels.select("Label 1");
    VideoView.clickAtFrame(3);
    VideoView.drawRectRelative(0.3, 0.3, 0.4, 0.4);

    LabelStudio.serialize().then((result: any[]) => {
      const region = result.find((r) => r.type === "videorectangle");
      const first = region.value.sequence[0];
      expect(first.frame).to.eq(3);
      // index pts[2] = 1.0, NOT 3/24 = 0.125
      expect(first.time).to.eq(INDEX_PTS[first.frame - 1]);
      expect(first.time).to.eq(1.0);
    });
  });
});
