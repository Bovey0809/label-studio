from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True
    dependencies = []

    operations = [
        migrations.CreateModel(
            name="VideoIndex",
            fields=[
                ("content_key", models.CharField(max_length=40, primary_key=True, serialize=False)),
                ("pts_blob", models.BinaryField(default=b"")),
                ("frame_count", models.IntegerField(default=0)),
                ("duration", models.FloatField(default=0.0)),
                ("codec", models.CharField(blank=True, default="", max_length=32)),
                ("width", models.IntegerField(default=0)),
                ("height", models.IntegerField(default=0)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("pending", "pending"),
                            ("ready", "ready"),
                            ("failed", "failed"),
                            ("unavailable", "unavailable"),
                        ],
                        default="pending",
                        max_length=16,
                    ),
                ),
                ("error", models.TextField(blank=True, default="")),
                (
                    "source",
                    models.CharField(
                        blank=True,
                        choices=[("server", "server"), ("client", "client"), ("", "")],
                        default="",
                        max_length=16,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={"db_table": "video_index", "indexes": [models.Index(fields=["status"], name="video_index_status_idx")]},
        ),
    ]
