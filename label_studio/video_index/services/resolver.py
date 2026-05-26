"""Resolve a raw video URL into a canonical fetchable form, plus a validator
(ETag or Last-Modified) used to derive the cache key.
"""
from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass

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
