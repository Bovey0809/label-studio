from django.db import models


class VideoIndex(models.Model):
    STATUS_PENDING = "pending"
    STATUS_READY = "ready"
    STATUS_FAILED = "failed"
    STATUS_UNAVAILABLE = "unavailable"
    STATUS_CHOICES = [
        (STATUS_PENDING, "pending"),
        (STATUS_READY, "ready"),
        (STATUS_FAILED, "failed"),
        (STATUS_UNAVAILABLE, "unavailable"),
    ]

    SOURCE_SERVER = "server"
    SOURCE_CLIENT = "client"
    SOURCE_CHOICES = [
        (SOURCE_SERVER, "server"),
        (SOURCE_CLIENT, "client"),
        ("", ""),
    ]

    content_key = models.CharField(max_length=40, primary_key=True)
    pts_blob = models.BinaryField(default=b"")
    frame_count = models.IntegerField(default=0)
    duration = models.FloatField(default=0.0)
    codec = models.CharField(max_length=32, blank=True, default="")
    width = models.IntegerField(default=0)
    height = models.IntegerField(default=0)
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default=STATUS_PENDING)
    error = models.TextField(blank=True, default="")
    source = models.CharField(max_length=16, choices=SOURCE_CHOICES, default="", blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "video_index"
        indexes = [models.Index(fields=["status"])]
