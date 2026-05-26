from django.conf import settings


def test_default_ffprobe_path():
    assert settings.VIDEO_INDEX_FFPROBE_PATH == "ffprobe"


def test_default_probe_timeout():
    assert settings.VIDEO_INDEX_PROBE_TIMEOUT_SECONDS == 120


def test_default_max_payload_bytes():
    assert settings.VIDEO_INDEX_MAX_PAYLOAD_BYTES == 5_000_000
