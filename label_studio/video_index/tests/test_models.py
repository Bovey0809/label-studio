import pytest
from video_index.models import VideoIndex


@pytest.mark.django_db
def test_create_pending_row():
    row = VideoIndex.objects.create(
        content_key="a" * 40,
        status=VideoIndex.STATUS_PENDING,
    )
    assert row.status == "pending"
    assert row.pts_blob == b""
    assert row.frame_count == 0
    assert row.source == ""


@pytest.mark.django_db
def test_content_key_is_unique():
    VideoIndex.objects.create(content_key="b" * 40, status="pending")
    with pytest.raises(Exception):
        VideoIndex.objects.create(content_key="b" * 40, status="pending")


@pytest.mark.django_db
def test_status_choices_enforced():
    row = VideoIndex(content_key="c" * 40, status="bogus")
    with pytest.raises(Exception):
        row.full_clean()
