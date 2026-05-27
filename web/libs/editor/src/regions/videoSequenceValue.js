/**
 * Build the serialized `value` for a video region's sequence.
 *
 * When a ffmpeg-derived VideoIndex is present it is the source of truth for both
 * the total frame count and per-keyframe timestamps, so exported annotations line
 * up with ffmpeg's frame indexing (including variable-frame-rate video). Without
 * an index we fall back to the tag's static framerate.
 *
 * Pure and dependency-free so it can be unit-tested without the editor MST tree.
 *
 * @param {object} args
 * @param {{ length: number, timeAt: (frame: number) => number } | null} args.index
 * @param {number} args.framerate
 * @param {number} args.length   fallback frame count when no index is present
 * @param {Array<{ frame: number }>} args.sequence
 * @returns {{ framesCount: number, sequence: Array<object> }}
 */
export function buildVideoSequenceValue({ index, framerate, length, sequence }) {
  return {
    framesCount: index ? index.length : length,
    sequence: sequence.map((keyframe) => ({
      ...keyframe,
      time: index ? index.timeAt(keyframe.frame) : keyframe.frame / framerate,
    })),
  };
}
