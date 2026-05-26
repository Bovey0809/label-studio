from unittest.mock import patch

import pytest
from rest_framework.test import APIClient

from video_index.models import VideoIndex
from video_index.services.codec import PtsCodec


@pytest.fixture
def client(db, django_user_model):
    user = django_user_model.objects.create_user(email="u@example.com", password="x")
    api = APIClient()
    api.force_authenticate(user=user)
    return api


def _ready_row(content_key="a" * 40):
    return VideoIndex.objects.create(
        content_key=content_key,
        status=VideoIndex.STATUS_READY,
        pts_blob=PtsCodec().encode([0.0, 0.0333]),
        frame_count=2,
        duration=0.0333,
        codec="h264",
        width=64, height=64,
    )


@pytest.mark.django_db
def test_get_returns_200_for_ready_row(client):
    row = _ready_row()
    with patch("video_index.api.resolve_content_key", return_value=row.content_key):
        resp = client.get("/api/video-index/", {"url": "u", "task": 0})
    assert resp.status_code == 200
    assert resp.json()["frame_count"] == 2


@pytest.mark.django_db
def test_get_returns_202_for_pending_row(client):
    row = VideoIndex.objects.create(content_key="b" * 40, status=VideoIndex.STATUS_PENDING)
    with patch("video_index.api.resolve_content_key", return_value=row.content_key):
        resp = client.get("/api/video-index/", {"url": "u", "task": 0})
    assert resp.status_code == 202
    assert resp.json()["status"] == "pending"


@pytest.mark.django_db
def test_get_creates_row_and_enqueues_when_missing(client):
    ck = "c" * 40
    with patch("video_index.api.resolve_content_key", return_value=ck):
        with patch("video_index.api.compute_video_index.delay") as enqueue:
            resp = client.get("/api/video-index/", {"url": "u", "task": 0})
            enqueue.assert_called_once()
    assert resp.status_code == 202
    assert VideoIndex.objects.filter(content_key=ck, status="pending").exists()


@pytest.mark.django_db
def test_get_returns_409_for_unavailable_row(client):
    row = VideoIndex.objects.create(content_key="d" * 40, status=VideoIndex.STATUS_UNAVAILABLE, error="no ffmpeg")
    with patch("video_index.api.resolve_content_key", return_value=row.content_key):
        resp = client.get("/api/video-index/", {"url": "u", "task": 0})
    assert resp.status_code == 409


@pytest.mark.django_db
def test_get_returns_422_for_failed_row(client):
    row = VideoIndex.objects.create(content_key="e" * 40, status=VideoIndex.STATUS_FAILED, error="corrupt")
    with patch("video_index.api.resolve_content_key", return_value=row.content_key):
        resp = client.get("/api/video-index/", {"url": "u", "task": 0})
    assert resp.status_code == 422
