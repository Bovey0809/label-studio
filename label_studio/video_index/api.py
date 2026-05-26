from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .jobs import compute_video_index
from .models import VideoIndex
from .serializers import VideoIndexSerializer
from .services.resolver import VideoUrlResolver


def resolve_content_key(task_id: int | None, raw_url: str) -> str:
    """Return the content_key that should be looked up for (task, url).

    Split out so tests can monkeypatch it without spinning up real URL fetches.
    """
    resolved = VideoUrlResolver().resolve(task=task_id, raw_url=raw_url)
    return resolved.content_key


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
