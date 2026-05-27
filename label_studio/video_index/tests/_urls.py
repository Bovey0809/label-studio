"""URLconf for the minimal test settings."""
from django.urls import include, path

urlpatterns = [
    path("", include("video_index.urls")),
]
