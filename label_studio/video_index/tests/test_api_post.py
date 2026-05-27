from unittest.mock import patch

import pytest
from rest_framework.test import APIClient

from video_index.models import VideoIndex


@pytest.fixture
def client(db, django_user_model):
    user = django_user_model.objects.create_user(email="u@example.com", password="x")
    api = APIClient()
    api.force_authenticate(user=user)
    return api


@pytest.mark.django_db
def test_post_creates_ready_row_with_source_client(client):
    payload = {
        "content_key": "f" * 40,
        "pts": [0.0, 0.0333, 0.0667],
        "frame_count": 3,
        "duration": 0.0667,
        "codec": "h264",
        "width": 64, "height": 64,
    }
    resp = client.post("/api/video-index/", payload, format="json")
    assert resp.status_code == 201
    row = VideoIndex.objects.get(content_key="f" * 40)
    assert row.status == "ready"
    assert row.source == "client"
    assert row.frame_count == 3


@pytest.mark.django_db
def test_post_overwrites_pending_row(client):
    VideoIndex.objects.create(content_key="g" * 40, status="pending")
    payload = {
        "content_key": "g" * 40,
        "pts": [0.0],
        "frame_count": 1,
        "duration": 0.0,
        "codec": "h264", "width": 64, "height": 64,
    }
    resp = client.post("/api/video-index/", payload, format="json")
    assert resp.status_code == 201
    row = VideoIndex.objects.get(content_key="g" * 40)
    assert row.status == "ready"
    assert row.source == "client"


@pytest.mark.django_db
def test_post_no_op_when_already_ready(client):
    VideoIndex.objects.create(
        content_key="h" * 40, status="ready", source="server", frame_count=99,
    )
    payload = {
        "content_key": "h" * 40,
        "pts": [0.0], "frame_count": 1, "duration": 0.0,
        "codec": "h264", "width": 64, "height": 64,
    }
    resp = client.post("/api/video-index/", payload, format="json")
    assert resp.status_code == 200
    assert resp.json().get("already_ready") is True
    row = VideoIndex.objects.get(content_key="h" * 40)
    assert row.source == "server"
    assert row.frame_count == 99


@pytest.mark.django_db
def test_post_rejects_unauthenticated(db):
    api = APIClient()
    resp = api.post("/api/video-index/", {}, format="json")
    assert resp.status_code in (401, 403)


@pytest.mark.django_db
def test_post_validates_required_fields(client):
    resp = client.post("/api/video-index/", {"content_key": "i" * 40}, format="json")
    assert resp.status_code == 400
