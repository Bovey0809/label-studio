import json
import os
from pathlib import Path

import pytest

from video_index.services.probe import FfprobeProber

FIXTURES = Path(__file__).parent / "fixtures"
requires_ffmpeg = pytest.mark.skipif(
    not os.environ.get("PATH") or os.system("ffprobe -version > /dev/null 2>&1") != 0,
    reason="requires ffprobe on PATH",
)


@requires_ffmpeg
def test_probe_cfr_fixture():
    expected = json.loads((FIXTURES / "cfr_30fps_3s.expected.json").read_text())
    result = FfprobeProber().probe(str(FIXTURES / "cfr_30fps_3s.mp4"))
    assert result.codec
    assert result.width == 64
    assert result.height == 64
    assert len(result.pts) == expected["frame_count"]
    for a, b in zip(result.pts, expected["pts"]):
        assert a == pytest.approx(b, abs=1e-3)


@requires_ffmpeg
def test_probe_vfr_fixture():
    expected = json.loads((FIXTURES / "vfr_drone_2s.expected.json").read_text())
    result = FfprobeProber().probe(str(FIXTURES / "vfr_drone_2s.mp4"))
    assert len(result.pts) == expected["frame_count"]
    # PTS must be strictly monotonic
    for i in range(1, len(result.pts)):
        assert result.pts[i] >= result.pts[i - 1]
