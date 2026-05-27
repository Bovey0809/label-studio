"""Resolve a raw video URL into a canonical fetchable form, plus a validator
(ETag or Last-Modified) used to derive the cache key.
"""
from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from urllib.parse import parse_qs, unquote, urlparse

import requests


@dataclass(frozen=True)
class ResolvedUrl:
    canonical_url: str
    etag_or_lm: str
    can_backend_fetch: bool

    @property
    def content_key(self) -> str:
        material = f"{self.canonical_url}|{self.etag_or_lm}"
        return hashlib.sha1(material.encode("utf-8")).hexdigest()


class VideoUrlResolver:
    """Best-effort resolver. Does NOT mutate any task object — only inspects."""

    def __init__(self, head_timeout: float = 5.0) -> None:
        self.head_timeout = head_timeout

    def resolve(self, task, raw_url: str) -> ResolvedUrl:
        if os.path.exists(raw_url):
            return ResolvedUrl(canonical_url=raw_url, etag_or_lm="", can_backend_fetch=True)

        local = self._resolve_local_files(raw_url)
        if local is not None:
            return local

        media = self._resolve_media_files(raw_url)
        if media is not None:
            return media

        try:
            response = requests.head(raw_url, timeout=self.head_timeout, allow_redirects=True)
        except requests.exceptions.RequestException:
            return ResolvedUrl(canonical_url=raw_url, etag_or_lm="", can_backend_fetch=False)

        if response.status_code >= 400:
            return ResolvedUrl(canonical_url=raw_url, etag_or_lm="", can_backend_fetch=False)

        validator = response.headers.get("ETag") or response.headers.get("Last-Modified") or ""
        return ResolvedUrl(
            canonical_url=raw_url,
            etag_or_lm=validator,
            can_backend_fetch=True,
        )

    def _resolve_local_files(self, raw_url: str) -> ResolvedUrl | None:
        """Map a LS local-storage URL to the file on disk so ffprobe can read it
        directly. Works for both relative ("/data/local-files/?d=rel") and absolute
        proxy URLs — only the path + ?d= query matter, never the host. Returns None
        if this isn't a local-files URL (caller falls through to the HTTP path)."""
        from django.conf import settings as _settings

        if not getattr(_settings, "LOCAL_FILES_SERVING_ENABLED", False):
            return None
        doc_root = getattr(_settings, "LOCAL_FILES_DOCUMENT_ROOT", "") or ""
        if not doc_root:
            return None

        parsed = urlparse(raw_url)
        if not parsed.path.rstrip("/").endswith("/data/local-files"):
            return None

        rel = (parse_qs(parsed.query).get("d") or [""])[0]
        if not rel:
            return None

        root = os.path.normpath(doc_root)
        candidate = os.path.normpath(os.path.join(root, rel))
        # Path-traversal guard: the resolved file must stay inside the doc root.
        if candidate != root and not candidate.startswith(root + os.sep):
            return ResolvedUrl(canonical_url=raw_url, etag_or_lm="", can_backend_fetch=False)
        if not os.path.exists(candidate):
            return ResolvedUrl(canonical_url=raw_url, etag_or_lm="", can_backend_fetch=False)

        # mtime as the validator → re-encoding the file yields a new content_key.
        validator = str(int(os.path.getmtime(candidate)))
        return ResolvedUrl(canonical_url=candidate, etag_or_lm=validator, can_backend_fetch=True)

    def _resolve_media_files(self, raw_url: str) -> ResolvedUrl | None:
        """Map a served-media URL to its file under MEDIA_ROOT so ffprobe can read
        it directly. This covers imported/uploaded videos (e.g. the "import mp4"
        flow serves them at "/data/upload/<project>/<file>"). Mirrors
        _resolve_local_files: host-agnostic (path only), with a path-traversal
        guard and mtime validator. Returns None when the URL is not a media URL
        (caller falls through to the HTTP path)."""
        from django.conf import settings as _settings

        media_url = getattr(_settings, "MEDIA_URL", "") or ""
        media_root = getattr(_settings, "MEDIA_ROOT", "") or ""
        if not media_url or not media_root:
            return None

        path = unquote(urlparse(raw_url).path)
        # local-files is a separate mechanism handled above; never treat it as media.
        if "/data/local-files" in path:
            return None
        if not path.startswith(media_url):
            return None

        rel = path[len(media_url):].lstrip("/")
        if not rel:
            return None

        root = os.path.normpath(media_root)
        candidate = os.path.normpath(os.path.join(root, rel))
        # Path-traversal guard: the resolved file must stay inside MEDIA_ROOT.
        if candidate != root and not candidate.startswith(root + os.sep):
            return ResolvedUrl(canonical_url=raw_url, etag_or_lm="", can_backend_fetch=False)
        if not os.path.exists(candidate):
            return ResolvedUrl(canonical_url=raw_url, etag_or_lm="", can_backend_fetch=False)

        validator = str(int(os.path.getmtime(candidate)))
        return ResolvedUrl(canonical_url=candidate, etag_or_lm=validator, can_backend_fetch=True)
