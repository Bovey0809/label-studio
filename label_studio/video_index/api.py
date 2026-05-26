from django.db import connection, transaction
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .jobs import compute_video_index
from .models import VideoIndex
from .serializers import VideoIndexSerializer
from .services.codec import PtsCodec
from .services.resolver import VideoUrlResolver

REQUIRED_POST_FIELDS = {"content_key", "pts", "frame_count", "duration", "codec", "width", "height"}


def resolve_content_key(task_id, raw_url: str) -> str:
    resolved = VideoUrlResolver().resolve(task=task_id, raw_url=raw_url)
    return resolved.content_key


def _lock_row(content_key: str):
    """SELECT … FOR UPDATE on SQL backends that support it; plain SELECT on SQLite."""
    qs = VideoIndex.objects.filter(content_key=content_key)
    if connection.vendor != "sqlite":
        qs = qs.select_for_update()
    return qs.first()


class VideoIndexView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        raw_url = request.query_params.get("url")
        task_id = request.query_params.get("task")
        if not raw_url:
            return Response({"error": "url is required"}, status=400)

        content_key = resolve_content_key(task_id, raw_url)
        row = VideoIndex.objects.filter(content_key=content_key).first()

        if row is None:
            VideoIndex.objects.create(content_key=content_key, status=VideoIndex.STATUS_PENDING)
            compute_video_index.delay(content_key=content_key, raw_url=raw_url)
            return Response({"status": "pending", "content_key": content_key}, status=202)

        if row.status == VideoIndex.STATUS_READY:
            return Response(VideoIndexSerializer(row).data, status=200)
        if row.status == VideoIndex.STATUS_PENDING:
            return Response({"status": "pending", "content_key": content_key}, status=202)
        if row.status == VideoIndex.STATUS_UNAVAILABLE:
            return Response({"status": "unavailable", "error": row.error}, status=409)
        if row.status == VideoIndex.STATUS_FAILED:
            return Response({"status": "failed", "error": row.error}, status=422)
        return Response({"status": "unknown"}, status=500)

    def post(self, request):
        missing = REQUIRED_POST_FIELDS - set(request.data.keys())
        if missing:
            return Response({"error": f"missing fields: {sorted(missing)}"}, status=400)

        content_key = request.data["content_key"]
        with transaction.atomic():
            row = _lock_row(content_key)

            if row and row.status == VideoIndex.STATUS_READY:
                return Response({"already_ready": True}, status=200)

            blob = PtsCodec().encode([float(p) for p in request.data["pts"]])

            if row is None:
                row = VideoIndex.objects.create(content_key=content_key)

            row.status = VideoIndex.STATUS_READY
            row.pts_blob = blob
            row.frame_count = int(request.data["frame_count"])
            row.duration = float(request.data["duration"])
            row.codec = request.data["codec"]
            row.width = int(request.data["width"])
            row.height = int(request.data["height"])
            row.source = VideoIndex.SOURCE_CLIENT
            row.error = ""
            row.save()

        return Response(VideoIndexSerializer(row).data, status=201)
