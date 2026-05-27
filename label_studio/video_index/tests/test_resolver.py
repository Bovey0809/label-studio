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


def test_local_files_url_maps_to_document_root(tmp_path, settings):
    """A LS local-storage URL (/data/local-files/?d=rel) resolves to the file on
    disk so the backend ffprobes it directly — no HTTP fetch, no auth needed."""
    root = tmp_path / "docroot"
    root.mkdir()
    (root / "sub").mkdir()
    f = root / "sub" / "clip.mp4"
    f.write_bytes(b"dummy")
    settings.LOCAL_FILES_SERVING_ENABLED = True
    settings.LOCAL_FILES_DOCUMENT_ROOT = str(root)

    resolved = VideoUrlResolver().resolve(task=None, raw_url="/data/local-files/?d=sub/clip.mp4")
    assert resolved.canonical_url == str(f)
    assert resolved.can_backend_fetch is True


def test_local_files_url_is_host_agnostic(tmp_path, settings):
    """An absolute proxy URL (e.g. AutoDL) maps by path+query, ignoring the host."""
    root = tmp_path / "docroot"
    root.mkdir()
    f = root / "clip.mp4"
    f.write_bytes(b"dummy")
    settings.LOCAL_FILES_SERVING_ENABLED = True
    settings.LOCAL_FILES_DOCUMENT_ROOT = str(root)

    resolved = VideoUrlResolver().resolve(
        task=None,
        raw_url="https://region-x.autodl.com:8443/data/local-files/?d=clip.mp4",
    )
    assert resolved.canonical_url == str(f)
    assert resolved.can_backend_fetch is True


def test_local_files_path_traversal_blocked(tmp_path, settings):
    """A ?d= that escapes the document root must not resolve to the outside file."""
    root = tmp_path / "docroot"
    root.mkdir()
    secret = tmp_path / "secret.mp4"
    secret.write_bytes(b"nope")
    settings.LOCAL_FILES_SERVING_ENABLED = True
    settings.LOCAL_FILES_DOCUMENT_ROOT = str(root)

    resolved = VideoUrlResolver().resolve(task=None, raw_url="/data/local-files/?d=../secret.mp4")
    assert resolved.canonical_url != str(secret)
    assert resolved.can_backend_fetch is False


def test_local_files_url_ignored_when_serving_disabled(tmp_path, settings):
    root = tmp_path / "docroot"
    root.mkdir()
    (root / "clip.mp4").write_bytes(b"dummy")
    settings.LOCAL_FILES_SERVING_ENABLED = False
    settings.LOCAL_FILES_DOCUMENT_ROOT = str(root)
    # Falls through to the HTTP path; a relative URL can't be fetched.
    resolved = VideoUrlResolver().resolve(task=None, raw_url="/data/local-files/?d=clip.mp4")
    assert resolved.can_backend_fetch is False


def test_uploaded_media_url_maps_to_media_root(tmp_path, settings):
    """An imported/uploaded file served at /data/upload/<...> resolves to its path
    under MEDIA_ROOT so the backend ffprobes it directly — no HTTP fetch/auth."""
    media = tmp_path / "media"
    (media / "upload" / "6").mkdir(parents=True)
    f = media / "upload" / "6" / "clip.mp4"
    f.write_bytes(b"dummy")
    settings.MEDIA_URL = "/data/"
    settings.MEDIA_ROOT = str(media)

    resolved = VideoUrlResolver().resolve(task=None, raw_url="/data/upload/6/clip.mp4")
    assert resolved.canonical_url == str(f)
    assert resolved.can_backend_fetch is True


def test_uploaded_media_url_is_host_agnostic(tmp_path, settings):
    media = tmp_path / "media"
    (media / "upload" / "6").mkdir(parents=True)
    f = media / "upload" / "6" / "clip.mp4"
    f.write_bytes(b"dummy")
    settings.MEDIA_URL = "/data/"
    settings.MEDIA_ROOT = str(media)

    resolved = VideoUrlResolver().resolve(
        task=None, raw_url="https://region-x.autodl.com:8443/data/upload/6/clip.mp4"
    )
    assert resolved.canonical_url == str(f)
    assert resolved.can_backend_fetch is True


def test_uploaded_media_url_decodes_filename(tmp_path, settings):
    media = tmp_path / "media"
    (media / "upload" / "6").mkdir(parents=True)
    f = media / "upload" / "6" / "a b.mp4"
    f.write_bytes(b"dummy")
    settings.MEDIA_URL = "/data/"
    settings.MEDIA_ROOT = str(media)

    resolved = VideoUrlResolver().resolve(task=None, raw_url="/data/upload/6/a%20b.mp4")
    assert resolved.canonical_url == str(f)
    assert resolved.can_backend_fetch is True


def test_media_path_traversal_blocked(tmp_path, settings):
    media = tmp_path / "media"
    media.mkdir()
    secret = tmp_path / "secret.mp4"
    secret.write_bytes(b"nope")
    settings.MEDIA_URL = "/data/"
    settings.MEDIA_ROOT = str(media)

    resolved = VideoUrlResolver().resolve(task=None, raw_url="/data/../secret.mp4")
    assert resolved.canonical_url != str(secret)
    assert resolved.can_backend_fetch is False


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
