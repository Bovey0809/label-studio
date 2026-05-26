from pathlib import Path
from unittest.mock import patch

import pytest

from video_index.jobs import compute_video_index
from video_index.models import VideoIndex
from video_index.services.codec import PtsCodec
from video_index.services.probe import (
    FfmpegNotInstalled,
    NoVideoStream,
    ProbeFailed,
    ProbeResult,
    UnreachableUrl,
)

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def pending_row(db):
    return VideoIndex.objects.create(
        content_key="a" * 40,
        status=VideoIndex.STATUS_PENDING,
    )


@pytest.mark.django_db
def test_job_writes_ready_row(pending_row):
    fake_result = ProbeResult(pts=[0.0, 0.0333, 0.0667], codec="h264", width=64, height=64)
    with patch("video_index.jobs.FfprobeProber") as Prober:
        Prober.return_value.probe.return_value = fake_result
        with patch("video_index.jobs.VideoUrlResolver") as Resolver:
            Resolver.return_value.resolve.return_value.canonical_url = "u"
            Resolver.return_value.resolve.return_value.can_backend_fetch = True
            compute_video_index(content_key=pending_row.content_key, raw_url="u")

    pending_row.refresh_from_db()
    assert pending_row.status == VideoIndex.STATUS_READY
    assert pending_row.frame_count == 3
    assert pending_row.codec == "h264"
    assert PtsCodec().decode(pending_row.pts_blob) == pytest.approx([0.0, 0.0333, 0.0667], abs=1e-3)
    assert pending_row.source == VideoIndex.SOURCE_SERVER


@pytest.mark.django_db
def test_job_handles_ffmpeg_not_installed(pending_row):
    with patch("video_index.jobs.VideoUrlResolver") as Resolver:
        Resolver.return_value.resolve.return_value.canonical_url = "u"
        Resolver.return_value.resolve.return_value.can_backend_fetch = True
        with patch("video_index.jobs.FfprobeProber") as Prober:
            Prober.return_value.probe.side_effect = FfmpegNotInstalled("nope")
            compute_video_index(content_key=pending_row.content_key, raw_url="u")
    pending_row.refresh_from_db()
    assert pending_row.status == VideoIndex.STATUS_UNAVAILABLE
    assert "nope" in pending_row.error


@pytest.mark.django_db
def test_job_handles_unreachable_url(pending_row):
    with patch("video_index.jobs.VideoUrlResolver") as Resolver:
        Resolver.return_value.resolve.return_value.canonical_url = "u"
        Resolver.return_value.resolve.return_value.can_backend_fetch = False
        compute_video_index(content_key=pending_row.content_key, raw_url="u")
    pending_row.refresh_from_db()
    assert pending_row.status == VideoIndex.STATUS_UNAVAILABLE


@pytest.mark.django_db
def test_job_handles_probe_failed(pending_row):
    with patch("video_index.jobs.VideoUrlResolver") as Resolver:
        Resolver.return_value.resolve.return_value.canonical_url = "u"
        Resolver.return_value.resolve.return_value.can_backend_fetch = True
        with patch("video_index.jobs.FfprobeProber") as Prober:
            Prober.return_value.probe.side_effect = ProbeFailed("bad pixels")
            compute_video_index(content_key=pending_row.content_key, raw_url="u")
    pending_row.refresh_from_db()
    assert pending_row.status == VideoIndex.STATUS_FAILED
    assert "bad pixels" in pending_row.error


@pytest.mark.django_db
def test_job_idempotent_on_ready_row(pending_row):
    pending_row.status = VideoIndex.STATUS_READY
    pending_row.frame_count = 999
    pending_row.save()
    with patch("video_index.jobs.FfprobeProber") as Prober:
        compute_video_index(content_key=pending_row.content_key, raw_url="u")
        Prober.assert_not_called()
    pending_row.refresh_from_db()
    assert pending_row.frame_count == 999
