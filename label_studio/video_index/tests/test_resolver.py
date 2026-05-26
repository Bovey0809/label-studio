from unittest.mock import patch, MagicMock
import pytest
from video_index.services.resolver import VideoUrlResolver, ResolvedUrl


def test_local_path_passthrough(tmp_path):
    f = tmp_path / "v.mp4"
    f.write_bytes(b"dummy")
    resolved = VideoUrlResolver().resolve(task=None, raw_url=str(f))
    assert resolved.canonical_url == str(f)
    assert resolved.can_backend_fetch is True
    assert resolved.etag_or_lm == ""  # no validator for local files


def test_http_url_with_etag():
    fake_head = MagicMock(status_code=200, headers={"ETag": '"abc123"', "Last-Modified": ""})
    with patch("video_index.services.resolver.requests.head", return_value=fake_head):
        resolved = VideoUrlResolver().resolve(task=None, raw_url="https://example.com/v.mp4")
    assert resolved.canonical_url == "https://example.com/v.mp4"
    assert resolved.etag_or_lm == '"abc123"'
    assert resolved.can_backend_fetch is True


def test_http_url_with_last_modified_only():
    fake_head = MagicMock(
        status_code=200,
        headers={"Last-Modified": "Wed, 21 Oct 2025 07:28:00 GMT"},
    )
    with patch("video_index.services.resolver.requests.head", return_value=fake_head):
        resolved = VideoUrlResolver().resolve(task=None, raw_url="https://example.com/v.mp4")
    assert resolved.etag_or_lm == "Wed, 21 Oct 2025 07:28:00 GMT"


def test_http_url_with_no_validators_uses_url_only_key():
    fake_head = MagicMock(status_code=200, headers={})
    with patch("video_index.services.resolver.requests.head", return_value=fake_head):
        resolved = VideoUrlResolver().resolve(task=None, raw_url="https://example.com/v.mp4")
    assert resolved.etag_or_lm == ""
    assert resolved.can_backend_fetch is True


def test_unreachable_url_flagged():
    import requests
    fake_head = MagicMock(side_effect=requests.exceptions.ConnectionError("boom"))
    with patch("video_index.services.resolver.requests.head", fake_head):
        resolved = VideoUrlResolver().resolve(task=None, raw_url="https://nope.invalid/v.mp4")
    assert resolved.can_backend_fetch is False


def test_content_key_changes_when_etag_changes():
    r1 = ResolvedUrl(canonical_url="https://x/v.mp4", etag_or_lm='"v1"', can_backend_fetch=True)
    r2 = ResolvedUrl(canonical_url="https://x/v.mp4", etag_or_lm='"v2"', can_backend_fetch=True)
    assert r1.content_key != r2.content_key


def test_content_key_stable_across_calls():
    r = ResolvedUrl(canonical_url="https://x/v.mp4", etag_or_lm='"v1"', can_backend_fetch=True)
    assert r.content_key == ResolvedUrl(
        canonical_url="https://x/v.mp4", etag_or_lm='"v1"', can_backend_fetch=True
    ).content_key
