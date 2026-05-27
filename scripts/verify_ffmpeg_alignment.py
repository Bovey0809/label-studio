"""Manual verification: does Label Studio's video index land on the SAME
frames ffmpeg does?

For each video we:
  1. Run the REAL server-side prober (video_index.services.probe.FfprobeProber),
     which is what builds the index the editor consumes. It yields `pts`, the
     presentation timestamp of each frame in display order. The editor's
     VideoIndex.timeAt(N) returns pts[N] and seeks the <video> element there.
  2. Independently ask ffprobe for every decoded frame's presentation
     timestamp (-show_frames), sort into display order -> ground truth.
  3. Assert the two timestamp arrays match element-for-element. If they do,
     then "frame N" in Label Studio == "frame N" in ffmpeg, for every N.

Run inside the ls-test:min image (has django + our code + ffmpeg).
"""
from __future__ import annotations

import json
import subprocess
import sys

import django

django.setup()  # DJANGO_SETTINGS_MODULE is set by the caller

from video_index.services.codec import PtsCodec  # noqa: E402
from video_index.services.probe import FfprobeProber  # noqa: E402


def ffmpeg_ground_truth(path: str) -> list[float]:
    """Every video frame's presentation timestamp, in display order."""
    out = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_frames",
            "-show_entries", "frame=pts_time,best_effort_timestamp_time",
            "-of", "json",
            path,
        ],
        capture_output=True, text=True, check=True,
    )
    frames = json.loads(out.stdout).get("frames", [])
    ts: list[float] = []
    for fr in frames:
        v = fr.get("pts_time", fr.get("best_effort_timestamp_time"))
        if v is not None:
            ts.append(float(v))
    ts.sort()  # display order
    return ts


def verify(path: str) -> bool:
    print(f"\n{'=' * 70}\n{path}\n{'=' * 70}")

    # 1. What Label Studio will actually use:
    result = FfprobeProber().probe(path)
    ls_pts = result.pts
    print(f"  LS prober      : {len(ls_pts)} frames  codec={result.codec} "
          f"{result.width}x{result.height}")

    # 2. Independent ffmpeg ground truth:
    gt = ffmpeg_ground_truth(path)
    print(f"  ffmpeg frames  : {len(gt)} frames")

    # 3. Compare.
    if len(ls_pts) != len(gt):
        print(f"  FAIL: frame-count mismatch ({len(ls_pts)} vs {len(gt)})")
        return False

    max_diff = max((abs(a - b) for a, b in zip(ls_pts, gt)), default=0.0)
    print(f"  max per-frame timestamp diff: {max_diff:.9f}s")

    # Show a few sample frames the way the editor would index them.
    n = len(ls_pts)
    samples = sorted({0, 1, n // 2, n - 2, n - 1} & set(range(n)))
    print("  sample  LS timeAt(N)   ffmpeg frame N")
    for i in samples:
        print(f"    N={i:<5d} {ls_pts[i]:>11.6f}s   {gt[i]:>11.6f}s")

    # 4. Wire-format round-trip: this is the exact blob the editor decodes.
    codec = PtsCodec()
    decoded = codec.decode(codec.encode(ls_pts))
    rt_diff = max((abs(a - b) for a, b in zip(ls_pts, decoded)), default=0.0)
    print(f"  PtsCodec round-trip (server encode -> editor decode) diff: "
          f"{rt_diff:.9f}s  ({len(codec.encode(ls_pts))} bytes for {len(ls_pts)} frames)")

    # Equal to within float32-ish tolerance (pts_time is printed to ~1e-6).
    ok = max_diff <= 1e-3 and rt_diff <= 1e-3
    print(f"  RESULT: {'PASS — same frames' if ok else 'FAIL — drift detected'}")
    return ok


def main() -> int:
    paths = sys.argv[1:]
    if not paths:
        print("usage: verify_ffmpeg_alignment.py <video> [video ...]")
        return 2
    results = {p: verify(p) for p in paths}
    print(f"\n{'=' * 70}\nSUMMARY")
    for p, ok in results.items():
        print(f"  {'PASS' if ok else 'FAIL'}  {p}")
    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
