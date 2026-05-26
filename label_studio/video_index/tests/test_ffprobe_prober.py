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


@requires_ffmpeg
def test_audio_only_raises_no_video_stream():
    from video_index.services.probe import NoVideoStream
    with pytest.raises(NoVideoStream):
        FfprobeProber().probe(str(FIXTURES / "audio_only.mp4"))


@requires_ffmpeg
def test_corrupt_file_raises_probe_failed():
    from video_index.services.probe import ProbeFailed, NoVideoStream
    # Either is acceptable: ffprobe may emit packets-with-no-pts (-> NoVideoStream)
    # or return non-zero (-> ProbeFailed).
    with pytest.raises((ProbeFailed, NoVideoStream)):
        FfprobeProber().probe(str(FIXTURES / "corrupt_truncated.mp4"))


def test_missing_binary_raises_ffmpeg_not_installed():
    from video_index.services.probe import FfmpegNotInstalled
    prober = FfprobeProber(ffprobe_path="/definitely/not/installed/ffprobe-xyz")
    with pytest.raises(FfmpegNotInstalled):
        prober.probe("anything.mp4")


def test_subprocess_timeout_raises_probe_timeout(tmp_path):
    from unittest.mock import patch
    import subprocess
    from video_index.services.probe import ProbeTimeout
    prober = FfprobeProber(timeout_seconds=1)
    with patch("video_index.services.probe.subprocess.run", side_effect=subprocess.TimeoutExpired("ffprobe", 1)):
        with patch("video_index.services.probe.shutil.which", return_value="/usr/bin/ffprobe"):
            with pytest.raises(ProbeTimeout):
                prober.probe("anything.mp4")
