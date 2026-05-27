"""Pre-warm video indexes so they're ready before a labeler opens the task.

Called right after tasks are created on import. Best-effort and fully async:
it only enqueues jobs (never probes inline), so it never slows or breaks import.
"""
from __future__ import annotations

import logging

from .jobs import prewarm_video_index

logger = logging.getLogger(__name__)


def video_data_keys(data_types) -> list[str]:
    """Data keys whose object tag is a <Video> (from project.data_types)."""
    return [key for key, tag_type in (data_types or {}).items() if tag_type == "Video"]


def prewarm_video_indexes(project, tasks) -> int:
    """Enqueue an index job for every video URL in the given tasks.

    `project` only needs a `data_types` dict; each task only needs a `data` dict.
    Returns the number of jobs enqueued. Never raises — pre-warming is best-effort.
    """
    keys = video_data_keys(getattr(project, "data_types", None))
    if not keys:
        return 0

    count = 0
    for task in tasks:
        data = getattr(task, "data", None) or {}
        for key in keys:
            url = data.get(key)
            if isinstance(url, str) and url:
                try:
                    prewarm_video_index.delay(raw_url=url)
                    count += 1
                except Exception:  # noqa: BLE001 - never let pre-warming break import
                    logger.exception("failed to enqueue video index pre-warm for %s", url)
    return count
