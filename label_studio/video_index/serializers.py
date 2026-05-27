from rest_framework import serializers

from .models import VideoIndex
from .services.codec import PtsCodec


class VideoIndexSerializer(serializers.ModelSerializer):
    pts = serializers.SerializerMethodField()
    cfr = serializers.SerializerMethodField()

    class Meta:
        model = VideoIndex
        fields = [
            "content_key", "frame_count", "duration", "codec",
            "width", "height", "status", "pts", "cfr",
        ]

    def _codec(self) -> PtsCodec:
        return PtsCodec()

    def get_pts(self, obj: VideoIndex):
        blob = bytes(obj.pts_blob or b"")
        if not blob or self._codec().is_shorthand(blob):
            return None
        return self._codec().decode(blob)

    def get_cfr(self, obj: VideoIndex):
        blob = bytes(obj.pts_blob or b"")
        if not blob or not self._codec().is_shorthand(blob):
            return None
        fps, count = self._codec().decode_cfr_shorthand(blob)
        return {"fps": fps, "count": count}

    def to_representation(self, instance):
        data = super().to_representation(instance)
        # Drop the unused branch so the wire shape is exactly one of {pts, cfr}.
        if data.get("pts") is None:
            data.pop("pts", None)
        if data.get("cfr") is None:
            data.pop("cfr", None)
        return data
