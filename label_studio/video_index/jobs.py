"""RQ job: compute a VideoIndex row given (content_key, raw_url).

Idempotent: a ready row is left alone. This is also the cancellation
mechanism — a concurrent client-POST that marks the row ready will
cause this job's final step to no-op.
"""
from __future__ import annotations

import logging

from django.db import connection, transaction
from django_rq import job

from .models import VideoIndex
from .services.codec import PtsCodec
from .services.probe import (
    FfmpegNotInstalled,
    FfprobeProber,
    NoVideoStream,
    ProbeFailed,
    ProbeResult,
    ProbeTimeout,
    UnreachableUrl,
)
from .services.resolver import VideoUrlResolver

logger = logging.getLogger(__name__)


@job("low")
def prewarm_video_index(raw_url: str) -> None:
    """Resolve a video URL, create its row if missing, and compute the index.

    Used to pre-warm indexes at import time. Resolving (which may HEAD a remote
    URL) happens here in the worker, never in the import request path.
    """
    resolved = VideoUrlResolver().resolve(task=None, raw_url=raw_url)
    content_key = resolved.content_key
    row, _ = VideoIndex.objects.get_or_create(
        content_key=content_key,
        defaults={"status": VideoIndex.STATUS_PENDING},
    )
    if row.status == VideoIndex.STATUS_READY:
        return  # already warmed
    compute_video_index(content_key=content_key, raw_url=raw_url)


@job("low")
def compute_video_index(content_key: str, raw_url: str) -> None:
    with transaction.atomic():
        qs = VideoIndex.objects.filter(content_key=content_key)
        # SELECT FOR UPDATE is correct in production (PostgreSQL) but SQLite
        # does not support it — skip the locking clause on SQLite so tests pass.
        if connection.vendor != "sqlite":
            qs = qs.select_for_update()
        row = qs.first()
        if row is None:
            logger.warning("compute_video_index: no row for %s", content_key)
            return
        if row.status == VideoIndex.STATUS_READY:
            return  # idempotent no-op

    resolved = VideoUrlResolver().resolve(task=None, raw_url=raw_url)
    if not resolved.can_backend_fetch:
        _mark(content_key, status=VideoIndex.STATUS_UNAVAILABLE, error="backend cannot fetch url")
        return

    try:
        result: ProbeResult = FfprobeProber().probe(resolved.canonical_url)
    except FfmpegNotInstalled as exc:
        _mark(content_key, status=VideoIndex.STATUS_UNAVAILABLE, error=str(exc))
        return
    except UnreachableUrl as exc:
        _mark(content_key, status=VideoIndex.STATUS_UNAVAILABLE, error=str(exc))
        return
    except (NoVideoStream, ProbeFailed, ProbeTimeout) as exc:
        _mark(content_key, status=VideoIndex.STATUS_FAILED, error=str(exc))
        return

    blob = PtsCodec().encode(result.pts)
    with transaction.atomic():
        qs2 = VideoIndex.objects.filter(content_key=content_key)
        if connection.vendor != "sqlite":
            qs2 = qs2.select_for_update()
        row = qs2.get()
        # Re-check: a client POST may have raced us to ready.
        if row.status == VideoIndex.STATUS_READY:
            return
        row.status = VideoIndex.STATUS_READY
        row.pts_blob = blob
        row.frame_count = len(result.pts)
        row.duration = result.pts[-1] if result.pts else 0.0
        row.codec = result.codec
        row.width = result.width
        row.height = result.height
        row.source = VideoIndex.SOURCE_SERVER
        row.error = ""
        row.save()


def _mark(content_key: str, *, status: str, error: str) -> None:
    with transaction.atomic():
        VideoIndex.objects.filter(content_key=content_key).update(status=status, error=error)
