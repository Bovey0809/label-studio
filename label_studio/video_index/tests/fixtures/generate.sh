#!/usr/bin/env bash
# label_studio/video_index/tests/fixtures/generate.sh
# Regenerate test fixtures. Run once; the outputs are committed.
# Requires: ffmpeg, ffprobe, python3.
set -euo pipefail
cd "$(dirname "$0")"

# 1) CFR 30fps, 3s, color bars
ffmpeg -y -f lavfi -i "testsrc=size=64x64:rate=30:duration=3" \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart cfr_30fps_3s.mp4

# 2) VFR-ish: concat two segments at different rates, then mux without re-encoding
ffmpeg -y -f lavfi -i "testsrc=size=64x64:rate=60:duration=1" -c:v libx264 -pix_fmt yuv420p _v_60.mp4
ffmpeg -y -f lavfi -i "testsrc=size=64x64:rate=15:duration=1" -c:v libx264 -pix_fmt yuv420p _v_15.mp4
printf "file '_v_60.mp4'\nfile '_v_15.mp4'\n" > _concat.txt
ffmpeg -y -f concat -safe 0 -i _concat.txt -c copy vfr_drone_2s.mp4
rm _v_60.mp4 _v_15.mp4 _concat.txt

# 3) Audio only
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=1" -c:a aac audio_only.mp4

# 4) Corrupt: truncate to just the MP4 header bytes so ffprobe cannot find any packets.
#    100 bytes preserves enough of the ftyp/moov box headers to look like an MP4 to magic
#    sniffing, but no audio/video stream data survives, so probing raises.
head -c 100 cfr_30fps_3s.mp4 > corrupt_truncated.mp4

# 5) Expected JSON for the two video fixtures
for name in cfr_30fps_3s vfr_drone_2s; do
  ffprobe -v error -select_streams v:0 -show_packets -of json "$name.mp4" > "_${name}_raw.json"
  python3 - "$name" <<'PY'
import json, sys
name = sys.argv[1]
with open(f"_{name}_raw.json") as f:
    raw = json.load(f)
pts = [float(pkt["pts_time"]) for pkt in raw.get("packets", []) if "pts_time" in pkt]
# Sort to presentation order — ffprobe -show_packets emits in decode order;
# B-frame reordering makes those two differ. Frame N in LS is the Nth frame
# in presentation order, matching `ffmpeg -vf select=eq(n,N)`.
pts.sort()
out = {"pts": pts, "frame_count": len(pts)}
with open(f"{name}.expected.json", "w") as f:
    json.dump(out, f, indent=2)
PY
  rm "_${name}_raw.json"
done

echo "Fixtures regenerated."
