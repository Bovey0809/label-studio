"""Minimal Django settings used ONLY by video_index tests.

Bypasses the project's heavy `core.settings.label_studio` chain so we can run
new-app tests without installing the full transitive dep tree. The real settings
are used in CI; these are an opt-in test-only shortcut keyed off
`DJANGO_SETTINGS_MODULE=video_index.tests._settings`.
"""
from __future__ import annotations

SECRET_KEY = "video-index-test-secret"
DEBUG = True
USE_TZ = True
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": ":memory:",
    }
}

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.auth",
    "video_index",
]

MIDDLEWARE: list[str] = []
ROOT_URLCONF = "video_index.tests._urls"
TEMPLATES: list[dict] = []

# Settings the video_index app reads (defined in Task 1.14 going forward).
VIDEO_INDEX_FFPROBE_PATH = "ffprobe"
VIDEO_INDEX_PROBE_TIMEOUT_SECONDS = 120
VIDEO_INDEX_MAX_PAYLOAD_BYTES = 5_000_000
