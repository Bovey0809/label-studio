"""Pre-warming: when video tasks are imported, enqueue index jobs so the index
is ready before the labeler opens the task (no "Preparing video index…" wait)."""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from video_index.models import VideoIndex
from video_index.prewarm import prewarm_video_indexes, video_data_keys

FIXTURES = Path(__file__).parent / "fixtures"


def _project(data_types):
    return SimpleNamespace(id=1, data_types=data_types)


def _task(data):
    return SimpleNamespace(id=1, data=data)


def test_video_data_keys_selects_only_video_object_tags():
    keys = video_data_keys({"video": "Video", "caption": "Text", "audio": "Audio"})
    assert keys == ["video"]


def test_prewarm_enqueues_one_job_per_video_url():
    project = _project({"video": "Video", "caption": "Text"})
    tasks = [
        _task({"video": "/data/local-files/?d=a.mp4", "caption": "hi"}),
        _task({"video": "/data/local-files/?d=b.mp4"}),
    ]
    with patch("video_index.prewarm.prewarm_video_index") as job:
        count = prewarm_video_indexes(project, tasks)
    assert count == 2
    enqueued = [c.kwargs.get("raw_url") or c.args[0] for c in job.delay.call_args_list]
    assert enqueued == ["/data/local-files/?d=a.mp4", "/data/local-files/?d=b.mp4"]


def test_prewarm_noop_when_config_has_no_video():
    project = _project({"text": "Text"})
    tasks = [_task({"text": "hello"})]
    with patch("video_index.prewarm.prewarm_video_index") as job:
        count = prewarm_video_indexes(project, tasks)
    assert count == 0
    job.delay.assert_not_called()


def test_prewarm_skips_missing_or_nonstring_urls():
    project = _project({"video": "Video"})
    tasks = [_task({}), _task({"video": None}), _task({"video": 123}), _task({"video": "ok.mp4"})]
    with patch("video_index.prewarm.prewarm_video_index") as job:
        count = prewarm_video_indexes(project, tasks)
    assert count == 1
    assert job.delay.call_count == 1


@pytest.mark.django_db
def test_prewarm_job_creates_ready_row_for_real_video():
    from video_index.jobs import prewarm_video_index

    path = str(FIXTURES / "cfr_30fps_3s.mp4")
    prewarm_video_index(raw_url=path)

    row = VideoIndex.objects.get()
    assert row.status == VideoIndex.STATUS_READY
    assert row.frame_count == 90  # cfr_30fps_3s.mp4 == 90 frames


@pytest.mark.django_db
def test_prewarm_job_is_idempotent_for_ready_rows():
    from video_index.jobs import prewarm_video_index

    path = str(FIXTURES / "cfr_30fps_3s.mp4")
    prewarm_video_index(raw_url=path)
    row = VideoIndex.objects.get()
    updated_at = row.updated_at

    # Second call must not recompute a ready row.
    with patch("video_index.jobs.FfprobeProber") as Prober:
        prewarm_video_index(raw_url=path)
        Prober.return_value.probe.assert_not_called()
    row.refresh_from_db()
    assert row.updated_at == updated_at
