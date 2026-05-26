from django.contrib.auth.base_user import AbstractBaseUser, BaseUserManager
from django.contrib.auth.models import PermissionsMixin
from django.db import models


class EmailUserManager(BaseUserManager):
    """Manager for the test-only EmailUser model."""

    def create_user(self, email, password=None, **extra_fields):
        if not email:
            raise ValueError("email is required")
        email = self.normalize_email(email)
        user = self.model(email=email, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        return self.create_user(email, password, **extra_fields)


class EmailUser(AbstractBaseUser, PermissionsMixin):
    """Minimal custom user model that uses email as the unique identifier.

    Used only in the video_index test settings so that tests can call
    ``create_user(email=..., password=...)`` without a username argument.
    This model is NOT used in production.
    """

    email = models.EmailField(unique=True)
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = []

    objects = EmailUserManager()

    class Meta:
        app_label = "video_index"


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
