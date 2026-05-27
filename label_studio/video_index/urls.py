from django.urls import path

from .api import VideoIndexView

app_name = "video_index"
urlpatterns = [
    path("api/video-index/", VideoIndexView.as_view(), name="video-index"),
]
