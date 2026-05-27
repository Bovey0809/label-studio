import pytest
from video_index.models import VideoIndex
from video_index.serializers import VideoIndexSerializer
from video_index.services.codec import PtsCodec


@pytest.mark.django_db
def test_serializer_decodes_dense_pts():
    row = VideoIndex.objects.create(
        content_key="d" * 40,
        status=VideoIndex.STATUS_READY,
        pts_blob=PtsCodec().encode([0.0, 0.0333, 0.0667]),
        frame_count=3,
        duration=0.0667,
        codec="h264",
        width=64, height=64,
    )
    data = VideoIndexSerializer(row).data
    assert data["content_key"] == "d" * 40
    assert data["frame_count"] == 3
    assert data["codec"] == "h264"
    assert "pts" in data
    assert "cfr" not in data
    assert len(data["pts"]) == 3
    assert data["pts"][2] == pytest.approx(0.0667, abs=1e-3)


@pytest.mark.django_db
def test_serializer_emits_cfr_shorthand():
    row = VideoIndex.objects.create(
        content_key="e" * 40,
        status=VideoIndex.STATUS_READY,
        pts_blob=PtsCodec().encode_cfr_shorthand(fps=29.97, count=1800),
        frame_count=1800,
        duration=60.0,
        codec="h264",
        width=64, height=64,
    )
    data = VideoIndexSerializer(row).data
    assert "cfr" in data
    assert data["cfr"]["fps"] == pytest.approx(29.97, abs=1e-3)
    assert "pts" not in data
