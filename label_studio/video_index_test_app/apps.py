"""Test-only companion app for video_index.

Holds models that exist purely to satisfy test fixtures (e.g., a custom
user model the test client expects). NOT included in
core.settings.label_studio — only the test settings register this app.
"""
from django.apps import AppConfig


class VideoIndexTestAppConfig(AppConfig):
    name = "video_index_test_app"
    default_auto_field = "django.db.models.BigAutoField"
