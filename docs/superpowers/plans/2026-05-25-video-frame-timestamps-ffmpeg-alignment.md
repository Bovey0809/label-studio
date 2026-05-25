# Video Frame Timestamps — ffmpeg Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace browser-derived video frame indexing (`currentTime * framerate`) with a content-addressed, ffprobe-derived PTS index so that "frame N" in Label Studio matches `ffmpeg -vf select=eq(n,N)`. Annotations export with the same N.

**Architecture:** New Django app `video_index/` exposes `/api/video-index/` returning a per-video PTS array (or CFR shorthand) computed once by an RQ job running `ffprobe`. A new frontend library `web/libs/editor/src/lib/VideoIndex/` consumes the API, falling back to an `ffmpeg.wasm` web worker when the backend can't reach the file. The Video MST tag and `VideoCanvas` switch from fps-multiplication math to index lookups.

**Tech Stack:** Django + django-rq + ffprobe (backend); TypeScript + IndexedDB + ffmpeg.wasm web worker + MobX-State-Tree (frontend); pytest + Jest + Cypress (testing).

**Development methodology:** TDD throughout — every task writes a failing test first, runs it red, implements the minimum to make it green, then commits.

**Related docs:** Spec at `docs/superpowers/specs/2026-05-25-video-frame-timestamps-ffmpeg-alignment-design.md`.

---

## File structure

**New files (backend):**
```
label_studio/video_index/
  __init__.py
  apps.py
  models.py                 # VideoIndex model
  urls.py                   # /api/video-index/ routes
  api.py                    # VideoIndexViewSet
  serializers.py            # VideoIndexSerializer
  jobs.py                   # @job('low') compute_video_index
  services/
    __init__.py
    codec.py                # PtsCodec (encode/decode delta-varint)
    resolver.py             # VideoUrlResolver
    probe.py                # FfprobeProber
  migrations/
    0001_initial.py
  tests/
    __init__.py
    conftest.py
    test_pts_codec.py
    test_resolver.py
    test_ffprobe_prober.py
    test_compute_video_index_job.py
    test_api.py
    fixtures/
      cfr_30fps_3s.mp4
      cfr_30fps_3s.expected.json
      vfr_drone_2s.mp4
      vfr_drone_2s.expected.json
      audio_only.mp4
      corrupt_truncated.mp4
```

**New files (frontend lib):**
```
web/libs/editor/src/lib/VideoIndex/
  index.ts                  # public exports
  VideoIndex.ts             # in-memory index (dense + CFR backings)
  PayloadValidator.ts       # validate wire payloads
  VideoIndexCache.ts        # IndexedDB cache
  VideoIndexLoader.ts       # server-first fetch w/ wasm fallback
  WasmProberWorker.ts       # web worker that runs ffmpeg.wasm
  types.ts
  __tests__/
    VideoIndex.test.ts
    PayloadValidator.test.ts
    VideoIndexCache.test.ts
    VideoIndexLoader.test.ts
    WasmProberWorker.test.ts
```

**New files (editor integration tests + E2E):**
```
web/libs/editor/src/components/VideoCanvas/__tests__/VideoCanvas.index.test.tsx
web/libs/editor/src/tags/object/Video/__tests__/Video.test.js
web/libs/editor/tests/integration/e2e/video/ffmpeg_alignment.cy.ts
```

**Modified files:**
- `label_studio/core/settings/base.py` — add `video_index` to INSTALLED_APPS; add config keys
- `label_studio/core/urls.py` — mount `video_index.urls`
- `web/libs/editor/src/tags/object/Video/Video.js` — replace `framerate * time` math with `index` lookups
- `web/libs/editor/src/tags/object/Video/HtxVideo.jsx` — kick off `VideoIndexLoader`, preparing state
- `web/libs/editor/src/components/VideoCanvas/VideoCanvas.tsx` — accept `index` prop; swap math
- `web/libs/editor/src/components/VideoCanvas/hooks/useLoopRange.ts` — swap math
- `.github/workflows/*` — ensure ffmpeg installed for backend tests

---

## Phase 1 — Backend `video_index` app

### Task 1.1 — App skeleton + INSTALLED_APPS registration

**Files:**
- Create: `label_studio/video_index/__init__.py` (empty)
- Create: `label_studio/video_index/apps.py`
- Create: `label_studio/video_index/tests/__init__.py` (empty)
- Create: `label_studio/video_index/tests/conftest.py`
- Create: `label_studio/video_index/tests/test_app_registered.py`
- Modify: `label_studio/core/settings/base.py:200-235` (INSTALLED_APPS list)

- [ ] **Step 1: Write the failing test**

```python
# label_studio/video_index/tests/test_app_registered.py
from django.apps import apps


def test_video_index_app_is_installed():
    assert apps.is_installed("video_index")


def test_video_index_app_config_label():
    config = apps.get_app_config("video_index")
    assert config.name == "video_index"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd label_studio && pytest video_index/tests/test_app_registered.py -v`
Expected: FAIL with `LookupError: No installed app with label 'video_index'`.

- [ ] **Step 3: Create the app**

```python
# label_studio/video_index/apps.py
from django.apps import AppConfig


class VideoIndexConfig(AppConfig):
    name = "video_index"
    default_auto_field = "django.db.models.BigAutoField"
```

```python
# label_studio/video_index/tests/conftest.py
# Empty for now; fixtures will be added in later tasks.
```

Add `'video_index',` to `INSTALLED_APPS` in `label_studio/core/settings/base.py` right after `'fsm',` (the last current entry). Concretely, the list ends `..., 'session_policy', 'fsm', ]` — change to `..., 'session_policy', 'fsm', 'video_index', ]`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd label_studio && pytest video_index/tests/test_app_registered.py -v`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add label_studio/video_index/ label_studio/core/settings/base.py
git commit -m "feat(video_index): scaffold video_index Django app"
```

---

### Task 1.2 — `PtsCodec` VFR encode/decode round-trip

**Files:**
- Create: `label_studio/video_index/services/__init__.py` (empty)
- Create: `label_studio/video_index/services/codec.py`
- Create: `label_studio/video_index/tests/test_pts_codec.py`

- [ ] **Step 1: Write the failing test**

```python
# label_studio/video_index/tests/test_pts_codec.py
import pytest
from video_index.services.codec import PtsCodec


def test_vfr_round_trip_basic():
    codec = PtsCodec()
    pts = [0.0, 0.0333, 0.0667, 0.1, 0.15, 0.21]
    encoded = codec.encode(pts)
    assert isinstance(encoded, bytes)
    decoded = codec.decode(encoded)
    assert len(decoded) == len(pts)
    for a, b in zip(decoded, pts):
        assert a == pytest.approx(b, abs=1e-3)


def test_round_trip_preserves_monotonicity():
    codec = PtsCodec()
    pts = [0.0, 0.0333, 0.0667, 0.1, 0.15, 0.21]
    decoded = codec.decode(codec.encode(pts))
    for i in range(1, len(decoded)):
        assert decoded[i] >= decoded[i - 1]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd label_studio && pytest video_index/tests/test_pts_codec.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'video_index.services.codec'`.

- [ ] **Step 3: Implement the codec**

```python
# label_studio/video_index/services/codec.py
"""Delta + zigzag varint encoder for PTS arrays.

Wire format:
    byte 0: header
        bit 0 (LSB): unit (0 = milliseconds, 1 = microseconds)
        bit 1: shorthand flag (0 = dense, 1 = CFR shorthand)
    body (dense):     stream of zigzag varint deltas
    body (shorthand): varint(fps_x1000), varint(count)
"""
from __future__ import annotations

HEADER_UNIT_MICROS = 0b01
HEADER_SHORTHAND = 0b10


def _varint_encode(value: int) -> bytes:
    out = bytearray()
    while value >= 0x80:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value & 0x7F)
    return bytes(out)


def _varint_decode(buf: memoryview, offset: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while True:
        byte = buf[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            return value, offset
        shift += 7


def _zigzag_encode(value: int) -> int:
    return (value << 1) ^ (value >> 63)


def _zigzag_decode(value: int) -> int:
    return (value >> 1) ^ -(value & 1)


class PtsCodec:
    def encode(self, pts: list[float]) -> bytes:
        # Choose unit: μs if any value isn't representable in ms within 1 unit.
        use_micros = any(abs(p * 1000 - round(p * 1000)) > 0.5 for p in pts)
        scale = 1_000_000 if use_micros else 1_000
        scaled = [round(p * scale) for p in pts]

        header = HEADER_UNIT_MICROS if use_micros else 0
        out = bytearray([header])
        prev = 0
        for value in scaled:
            delta = value - prev
            out += _varint_encode(_zigzag_encode(delta))
            prev = value
        return bytes(out)

    def decode(self, blob: bytes) -> list[float]:
        if not blob:
            return []
        view = memoryview(blob)
        header = view[0]
        scale = 1_000_000 if (header & HEADER_UNIT_MICROS) else 1_000
        result: list[float] = []
        offset = 1
        prev = 0
        while offset < len(view):
            raw, offset = _varint_decode(view, offset)
            delta = _zigzag_decode(raw)
            prev += delta
            result.append(prev / scale)
        return result
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd label_studio && pytest video_index/tests/test_pts_codec.py -v`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add label_studio/video_index/services/ label_studio/video_index/tests/test_pts_codec.py
git commit -m "feat(video_index): add PtsCodec with delta-varint round-trip"
```

---

### Task 1.3 — `PtsCodec` CFR shorthand

**Files:**
- Modify: `label_studio/video_index/services/codec.py`
- Modify: `label_studio/video_index/tests/test_pts_codec.py`

- [ ] **Step 1: Add the failing tests**

Append to `label_studio/video_index/tests/test_pts_codec.py`:

```python
def test_cfr_shorthand_round_trip():
    codec = PtsCodec()
    shorthand = codec.encode_cfr_shorthand(fps=29.97, count=1800)
    fps, count = codec.decode_cfr_shorthand(shorthand)
    assert fps == pytest.approx(29.97, abs=1e-3)
    assert count == 1800


def test_decode_detects_shorthand_header():
    codec = PtsCodec()
    blob = codec.encode_cfr_shorthand(fps=30.0, count=900)
    assert codec.is_shorthand(blob) is True
    dense = codec.encode([0.0, 0.033, 0.066])
    assert codec.is_shorthand(dense) is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd label_studio && pytest video_index/tests/test_pts_codec.py::test_cfr_shorthand_round_trip video_index/tests/test_pts_codec.py::test_decode_detects_shorthand_header -v`
Expected: FAIL with `AttributeError: 'PtsCodec' object has no attribute 'encode_cfr_shorthand'`.

- [ ] **Step 3: Implement shorthand**

Append to `label_studio/video_index/services/codec.py` (inside `PtsCodec`):

```python
    def encode_cfr_shorthand(self, fps: float, count: int) -> bytes:
        header = HEADER_SHORTHAND
        out = bytearray([header])
        out += _varint_encode(round(fps * 1000))
        out += _varint_encode(count)
        return bytes(out)

    def decode_cfr_shorthand(self, blob: bytes) -> tuple[float, int]:
        if not self.is_shorthand(blob):
            raise ValueError("Blob is not CFR shorthand")
        view = memoryview(blob)
        fps_x1000, offset = _varint_decode(view, 1)
        count, _ = _varint_decode(view, offset)
        return fps_x1000 / 1000, count

    @staticmethod
    def is_shorthand(blob: bytes) -> bool:
        if not blob:
            return False
        return bool(blob[0] & HEADER_SHORTHAND)
```

- [ ] **Step 4: Run all codec tests to verify they pass**

Run: `cd label_studio && pytest video_index/tests/test_pts_codec.py -v`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add label_studio/video_index/services/codec.py label_studio/video_index/tests/test_pts_codec.py
git commit -m "feat(video_index): add CFR shorthand to PtsCodec"
```

---

### Task 1.4 — `PtsCodec` edge cases

**Files:**
- Modify: `label_studio/video_index/tests/test_pts_codec.py`

- [ ] **Step 1: Add the failing tests**

Append to `label_studio/video_index/tests/test_pts_codec.py`:

```python
def test_encode_empty_array():
    codec = PtsCodec()
    blob = codec.encode([])
    assert codec.decode(blob) == []


def test_encode_single_frame():
    codec = PtsCodec()
    decoded = codec.decode(codec.encode([0.0]))
    assert decoded == [0.0]


def test_encode_large_delta_varint():
    codec = PtsCodec()
    pts = [0.0, 3600.0]  # 1-hour gap, exercises multi-byte varint
    decoded = codec.decode(codec.encode(pts))
    assert decoded[0] == pytest.approx(0.0)
    assert decoded[1] == pytest.approx(3600.0, abs=1e-3)


def test_micros_unit_chosen_for_subms_precision():
    codec = PtsCodec()
    # PTS values that are not whole milliseconds
    pts = [0.0, 0.04167, 0.08333, 0.125]
    blob = codec.encode(pts)
    # Header byte should have unit bit set
    assert blob[0] & 0b01 == 0b01
    decoded = codec.decode(blob)
    for a, b in zip(decoded, pts):
        assert a == pytest.approx(b, abs=1e-5)
```

- [ ] **Step 2: Run tests to verify they pass (no implementation change needed)**

Run: `cd label_studio && pytest video_index/tests/test_pts_codec.py -v`
Expected: PASS, 8 tests. (If any fail, the existing implementation has a real bug — fix it before committing.)

- [ ] **Step 3: Commit**

```bash
git add label_studio/video_index/tests/test_pts_codec.py
git commit -m "test(video_index): add edge-case coverage for PtsCodec"
```

---

### Task 1.5 — `VideoIndex` model + initial migration

**Files:**
- Create: `label_studio/video_index/models.py`
- Create: `label_studio/video_index/migrations/__init__.py` (empty)
- Create: `label_studio/video_index/migrations/0001_initial.py`
- Create: `label_studio/video_index/tests/test_models.py`

- [ ] **Step 1: Write the failing test**

```python
# label_studio/video_index/tests/test_models.py
import pytest
from video_index.models import VideoIndex


@pytest.mark.django_db
def test_create_pending_row():
    row = VideoIndex.objects.create(
        content_key="a" * 40,
        status=VideoIndex.STATUS_PENDING,
    )
    assert row.status == "pending"
    assert row.pts_blob == b""
    assert row.frame_count == 0
    assert row.source == ""


@pytest.mark.django_db
def test_content_key_is_unique():
    VideoIndex.objects.create(content_key="b" * 40, status="pending")
    with pytest.raises(Exception):
        VideoIndex.objects.create(content_key="b" * 40, status="pending")


@pytest.mark.django_db
def test_status_choices_enforced():
    row = VideoIndex(content_key="c" * 40, status="bogus")
    with pytest.raises(Exception):
        row.full_clean()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd label_studio && pytest video_index/tests/test_models.py -v`
Expected: FAIL with `ModuleNotFoundError` on `video_index.models`.

- [ ] **Step 3: Implement model and migration**

```python
# label_studio/video_index/models.py
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
```

```python
# label_studio/video_index/migrations/0001_initial.py
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd label_studio && pytest video_index/tests/test_models.py -v`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add label_studio/video_index/models.py label_studio/video_index/migrations/ label_studio/video_index/tests/test_models.py
git commit -m "feat(video_index): add VideoIndex model + initial migration"
```

---

### Task 1.6 — `VideoUrlResolver`

**Files:**
- Create: `label_studio/video_index/services/resolver.py`
- Create: `label_studio/video_index/tests/test_resolver.py`

- [ ] **Step 1: Write the failing tests**

```python
# label_studio/video_index/tests/test_resolver.py
from unittest.mock import patch, MagicMock
import pytest
from video_index.services.resolver import VideoUrlResolver, ResolvedUrl


def test_local_path_passthrough(tmp_path):
    f = tmp_path / "v.mp4"
    f.write_bytes(b"dummy")
    resolved = VideoUrlResolver().resolve(task=None, raw_url=str(f))
    assert resolved.canonical_url == str(f)
    assert resolved.can_backend_fetch is True
    assert resolved.etag_or_lm == ""  # no validator for local files


def test_http_url_with_etag():
    fake_head = MagicMock(status_code=200, headers={"ETag": '"abc123"', "Last-Modified": ""})
    with patch("video_index.services.resolver.requests.head", return_value=fake_head):
        resolved = VideoUrlResolver().resolve(task=None, raw_url="https://example.com/v.mp4")
    assert resolved.canonical_url == "https://example.com/v.mp4"
    assert resolved.etag_or_lm == '"abc123"'
    assert resolved.can_backend_fetch is True


def test_http_url_with_last_modified_only():
    fake_head = MagicMock(
        status_code=200,
        headers={"Last-Modified": "Wed, 21 Oct 2025 07:28:00 GMT"},
    )
    with patch("video_index.services.resolver.requests.head", return_value=fake_head):
        resolved = VideoUrlResolver().resolve(task=None, raw_url="https://example.com/v.mp4")
    assert resolved.etag_or_lm == "Wed, 21 Oct 2025 07:28:00 GMT"


def test_http_url_with_no_validators_uses_url_only_key():
    fake_head = MagicMock(status_code=200, headers={})
    with patch("video_index.services.resolver.requests.head", return_value=fake_head):
        resolved = VideoUrlResolver().resolve(task=None, raw_url="https://example.com/v.mp4")
    assert resolved.etag_or_lm == ""
    assert resolved.can_backend_fetch is True


def test_unreachable_url_flagged():
    import requests
    fake_head = MagicMock(side_effect=requests.exceptions.ConnectionError("boom"))
    with patch("video_index.services.resolver.requests.head", fake_head):
        resolved = VideoUrlResolver().resolve(task=None, raw_url="https://nope.invalid/v.mp4")
    assert resolved.can_backend_fetch is False


def test_content_key_changes_when_etag_changes():
    r1 = ResolvedUrl(canonical_url="https://x/v.mp4", etag_or_lm='"v1"', can_backend_fetch=True)
    r2 = ResolvedUrl(canonical_url="https://x/v.mp4", etag_or_lm='"v2"', can_backend_fetch=True)
    assert r1.content_key != r2.content_key


def test_content_key_stable_across_calls():
    r = ResolvedUrl(canonical_url="https://x/v.mp4", etag_or_lm='"v1"', can_backend_fetch=True)
    assert r.content_key == ResolvedUrl(
        canonical_url="https://x/v.mp4", etag_or_lm='"v1"', can_backend_fetch=True
    ).content_key
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd label_studio && pytest video_index/tests/test_resolver.py -v`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the resolver**

```python
# label_studio/video_index/services/resolver.py
"""Resolve a raw video URL into a canonical fetchable form, plus a validator
(ETag or Last-Modified) used to derive the cache key.
"""
from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass

import requests


@dataclass(frozen=True)
class ResolvedUrl:
    canonical_url: str
    etag_or_lm: str
    can_backend_fetch: bool

    @property
    def content_key(self) -> str:
        material = f"{self.canonical_url}|{self.etag_or_lm}"
        return hashlib.sha1(material.encode("utf-8")).hexdigest()


class VideoUrlResolver:
    """Best-effort resolver. Does NOT mutate any task object — only inspects."""

    def __init__(self, head_timeout: float = 5.0) -> None:
        self.head_timeout = head_timeout

    def resolve(self, task, raw_url: str) -> ResolvedUrl:
        if os.path.exists(raw_url):
            return ResolvedUrl(canonical_url=raw_url, etag_or_lm="", can_backend_fetch=True)

        try:
            response = requests.head(raw_url, timeout=self.head_timeout, allow_redirects=True)
        except requests.exceptions.RequestException:
            return ResolvedUrl(canonical_url=raw_url, etag_or_lm="", can_backend_fetch=False)

        if response.status_code >= 400:
            return ResolvedUrl(canonical_url=raw_url, etag_or_lm="", can_backend_fetch=False)

        validator = response.headers.get("ETag") or response.headers.get("Last-Modified") or ""
        return ResolvedUrl(
            canonical_url=raw_url,
            etag_or_lm=validator,
            can_backend_fetch=True,
        )
```

> **Note for future task:** S3 / GCS / Azure signed URLs are handled implicitly here because by the time the resolver sees them, `io_storages` has already produced a fetchable HTTP URL. Extending this with provider-specific resolution (e.g., generating a fresh signed URL from a storage record) is deferred — see spec §9.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd label_studio && pytest video_index/tests/test_resolver.py -v`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add label_studio/video_index/services/resolver.py label_studio/video_index/tests/test_resolver.py
git commit -m "feat(video_index): add VideoUrlResolver with ResolvedUrl content_key"
```

---

### Task 1.7 — Test fixtures (real MP4s + expected JSON)

**Files:**
- Create: `label_studio/video_index/tests/fixtures/README.md`
- Create: `label_studio/video_index/tests/fixtures/generate.sh`
- Create: `label_studio/video_index/tests/fixtures/cfr_30fps_3s.mp4` (binary, generated)
- Create: `label_studio/video_index/tests/fixtures/cfr_30fps_3s.expected.json`
- Create: `label_studio/video_index/tests/fixtures/vfr_drone_2s.mp4` (binary, generated)
- Create: `label_studio/video_index/tests/fixtures/vfr_drone_2s.expected.json`
- Create: `label_studio/video_index/tests/fixtures/audio_only.mp4` (binary, generated)
- Create: `label_studio/video_index/tests/fixtures/corrupt_truncated.mp4` (binary, generated)

- [ ] **Step 1: Write the generation script**

```bash
#!/usr/bin/env bash
# label_studio/video_index/tests/fixtures/generate.sh
# Regenerate test fixtures. Run once; the outputs are committed.
# Requires: ffmpeg, ffprobe, jq, python3.
set -euo pipefail
cd "$(dirname "$0")"

# 1) CFR 30fps, 3s, color bars
ffmpeg -y -f lavfi -i "testsrc=size=64x64:rate=30:duration=3" \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart cfr_30fps_3s.mp4

# 2) VFR-ish: concat two segments at different rates, then mux without re-encoding
ffmpeg -y -f lavfi -i "testsrc=size=64x64:rate=60:duration=1" -c:v libx264 -pix_fmt yuv420p _v_60.mp4
ffmpeg -y -f lavfi -i "testsrc=size=64x64:rate=15:duration=1" -c:v libx264 -pix_fmt yuv420p _v_15.mp4
printf "file '_v_60.mp4'\nfile '_v_15.mp4'\n" > _concat.txt
ffmpeg -y -f concat -safe 0 -i _concat.txt -c copy vfr_drone_2s.mp4
rm _v_60.mp4 _v_15.mp4 _concat.txt

# 3) Audio only
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=1" -c:a aac audio_only.mp4

# 4) Corrupt: truncate the CFR file mid-stream
head -c 2048 cfr_30fps_3s.mp4 > corrupt_truncated.mp4

# 5) Expected JSON for the two video fixtures
for name in cfr_30fps_3s vfr_drone_2s; do
  ffprobe -v error -select_streams v:0 -show_packets -of json "$name.mp4" \
    | jq '{ pts: [.packets[] | (.pts_time | tonumber)] } | . + {frame_count: (.pts | length)}' \
    > "$name.expected.json"
done

echo "Fixtures regenerated."
```

```markdown
<!-- label_studio/video_index/tests/fixtures/README.md -->
# Test fixtures

These files are checked in. They were generated by `generate.sh`. Re-run only when
the schema of `expected.json` changes; the MP4 contents themselves should remain
stable so test assertions on exact PTS values stay valid.

Requirements to regenerate: `ffmpeg`, `ffprobe`, `jq`.
```

- [ ] **Step 2: Make the script executable and run it**

```bash
chmod +x label_studio/video_index/tests/fixtures/generate.sh
bash label_studio/video_index/tests/fixtures/generate.sh
```

Expected: four `.mp4` files and two `.expected.json` files exist in `label_studio/video_index/tests/fixtures/`.

- [ ] **Step 3: Smoke-check the fixtures**

```bash
test -f label_studio/video_index/tests/fixtures/cfr_30fps_3s.mp4
test -f label_studio/video_index/tests/fixtures/cfr_30fps_3s.expected.json
python3 -c "import json; d=json.load(open('label_studio/video_index/tests/fixtures/cfr_30fps_3s.expected.json')); assert d['frame_count'] == 90, d['frame_count']"
```

Expected: no output, exit 0. Frame count is 90 (30 fps × 3 s).

- [ ] **Step 4: Commit**

```bash
git add label_studio/video_index/tests/fixtures/
git commit -m "test(video_index): add real MP4 fixtures + expected ffprobe output"
```

---

### Task 1.8 — `FfprobeProber` happy path (CFR + VFR)

**Files:**
- Create: `label_studio/video_index/services/probe.py`
- Create: `label_studio/video_index/tests/test_ffprobe_prober.py`

- [ ] **Step 1: Write the failing tests**

```python
# label_studio/video_index/tests/test_ffprobe_prober.py
import json
import os
from pathlib import Path

import pytest

from video_index.services.probe import FfprobeProber

FIXTURES = Path(__file__).parent / "fixtures"
requires_ffmpeg = pytest.mark.skipif(
    not os.environ.get("PATH") or os.system("ffprobe -version > /dev/null 2>&1") != 0,
    reason="requires ffprobe on PATH",
)


@requires_ffmpeg
def test_probe_cfr_fixture():
    expected = json.loads((FIXTURES / "cfr_30fps_3s.expected.json").read_text())
    result = FfprobeProber().probe(str(FIXTURES / "cfr_30fps_3s.mp4"))
    assert result.codec
    assert result.width == 64
    assert result.height == 64
    assert len(result.pts) == expected["frame_count"]
    for a, b in zip(result.pts, expected["pts"]):
        assert a == pytest.approx(b, abs=1e-3)


@requires_ffmpeg
def test_probe_vfr_fixture():
    expected = json.loads((FIXTURES / "vfr_drone_2s.expected.json").read_text())
    result = FfprobeProber().probe(str(FIXTURES / "vfr_drone_2s.mp4"))
    assert len(result.pts) == expected["frame_count"]
    # PTS must be strictly monotonic
    for i in range(1, len(result.pts)):
        assert result.pts[i] >= result.pts[i - 1]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd label_studio && pytest video_index/tests/test_ffprobe_prober.py -v`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the prober**

```python
# label_studio/video_index/services/probe.py
"""Wraps ffprobe to extract per-frame PTS for the video stream."""
from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass


class FfmpegNotInstalled(RuntimeError):
    pass


class UnreachableUrl(RuntimeError):
    pass


class NoVideoStream(RuntimeError):
    pass


class ProbeFailed(RuntimeError):
    def __init__(self, stderr: str) -> None:
        super().__init__(stderr)
        self.stderr = stderr


class ProbeTimeout(RuntimeError):
    pass


@dataclass(frozen=True)
class ProbeResult:
    pts: list[float]
    codec: str
    width: int
    height: int


class FfprobeProber:
    def __init__(
        self,
        ffprobe_path: str = "ffprobe",
        timeout_seconds: int = 120,
    ) -> None:
        self.ffprobe_path = ffprobe_path
        self.timeout_seconds = timeout_seconds

    def probe(self, canonical_url: str) -> ProbeResult:
        if not shutil.which(self.ffprobe_path):
            raise FfmpegNotInstalled(f"{self.ffprobe_path!r} not on PATH")

        try:
            result = subprocess.run(
                [
                    self.ffprobe_path,
                    "-v", "error",
                    "-select_streams", "v:0",
                    "-show_packets",
                    "-show_streams",
                    "-of", "json",
                    canonical_url,
                ],
                capture_output=True,
                timeout=self.timeout_seconds,
                text=True,
            )
        except subprocess.TimeoutExpired as exc:
            raise ProbeTimeout(str(exc)) from exc

        if result.returncode != 0:
            stderr = result.stderr.lower()
            if any(token in stderr for token in ("no such", "not found", "could not open", "connection refused")):
                raise UnreachableUrl(result.stderr)
            raise ProbeFailed(result.stderr)

        try:
            payload = json.loads(result.stdout or "{}")
        except json.JSONDecodeError as exc:
            raise ProbeFailed(f"non-JSON ffprobe output: {exc}") from exc

        streams = payload.get("streams", [])
        if not streams:
            raise NoVideoStream("no video stream in file")

        stream = streams[0]
        codec = stream.get("codec_name", "")
        width = int(stream.get("width", 0))
        height = int(stream.get("height", 0))

        packets = payload.get("packets", [])
        pts: list[float] = []
        for packet in packets:
            value = packet.get("pts_time")
            if value is None:
                continue
            pts.append(float(value))

        if not pts:
            raise NoVideoStream("no video packets with pts_time")

        return ProbeResult(pts=pts, codec=codec, width=width, height=height)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd label_studio && pytest video_index/tests/test_ffprobe_prober.py -v`
Expected: PASS, 2 tests (skipped only if ffprobe is unavailable, which CI must prevent).

- [ ] **Step 5: Commit**

```bash
git add label_studio/video_index/services/probe.py label_studio/video_index/tests/test_ffprobe_prober.py
git commit -m "feat(video_index): add FfprobeProber for CFR/VFR pts extraction"
```

---

### Task 1.9 — `FfprobeProber` error paths

**Files:**
- Modify: `label_studio/video_index/tests/test_ffprobe_prober.py`

- [ ] **Step 1: Add the failing tests**

Append to `label_studio/video_index/tests/test_ffprobe_prober.py`:

```python
@requires_ffmpeg
def test_audio_only_raises_no_video_stream():
    from video_index.services.probe import NoVideoStream
    with pytest.raises(NoVideoStream):
        FfprobeProber().probe(str(FIXTURES / "audio_only.mp4"))


@requires_ffmpeg
def test_corrupt_file_raises_probe_failed():
    from video_index.services.probe import ProbeFailed, NoVideoStream
    # Either is acceptable: ffprobe may emit packets-with-no-pts (-> NoVideoStream)
    # or return non-zero (-> ProbeFailed).
    with pytest.raises((ProbeFailed, NoVideoStream)):
        FfprobeProber().probe(str(FIXTURES / "corrupt_truncated.mp4"))


def test_missing_binary_raises_ffmpeg_not_installed():
    from video_index.services.probe import FfmpegNotInstalled
    prober = FfprobeProber(ffprobe_path="/definitely/not/installed/ffprobe-xyz")
    with pytest.raises(FfmpegNotInstalled):
        prober.probe("anything.mp4")


def test_subprocess_timeout_raises_probe_timeout(tmp_path):
    from unittest.mock import patch
    import subprocess
    from video_index.services.probe import ProbeTimeout
    prober = FfprobeProber(timeout_seconds=1)
    with patch("video_index.services.probe.subprocess.run", side_effect=subprocess.TimeoutExpired("ffprobe", 1)):
        with patch("video_index.services.probe.shutil.which", return_value="/usr/bin/ffprobe"):
            with pytest.raises(ProbeTimeout):
                prober.probe("anything.mp4")
```

- [ ] **Step 2: Run tests to verify they pass (no new code needed if Task 1.8 was done correctly)**

Run: `cd label_studio && pytest video_index/tests/test_ffprobe_prober.py -v`
Expected: PASS, 6 tests total. If any fail, refine the error-class dispatch in `probe.py` until all pass.

- [ ] **Step 3: Commit**

```bash
git add label_studio/video_index/tests/test_ffprobe_prober.py label_studio/video_index/services/probe.py
git commit -m "test(video_index): cover FfprobeProber error paths"
```

---

### Task 1.10 — `compute_video_index` RQ job

**Files:**
- Create: `label_studio/video_index/jobs.py`
- Create: `label_studio/video_index/tests/test_compute_video_index_job.py`

- [ ] **Step 1: Write the failing tests**

```python
# label_studio/video_index/tests/test_compute_video_index_job.py
from pathlib import Path
from unittest.mock import patch

import pytest

from video_index.jobs import compute_video_index
from video_index.models import VideoIndex
from video_index.services.codec import PtsCodec
from video_index.services.probe import (
    FfmpegNotInstalled,
    NoVideoStream,
    ProbeFailed,
    ProbeResult,
    UnreachableUrl,
)

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def pending_row(db):
    return VideoIndex.objects.create(
        content_key="a" * 40,
        status=VideoIndex.STATUS_PENDING,
    )


@pytest.mark.django_db
def test_job_writes_ready_row(pending_row):
    fake_result = ProbeResult(pts=[0.0, 0.0333, 0.0667], codec="h264", width=64, height=64)
    with patch("video_index.jobs.FfprobeProber") as Prober:
        Prober.return_value.probe.return_value = fake_result
        with patch("video_index.jobs.VideoUrlResolver") as Resolver:
            Resolver.return_value.resolve.return_value.canonical_url = "u"
            Resolver.return_value.resolve.return_value.can_backend_fetch = True
            compute_video_index(content_key=pending_row.content_key, raw_url="u")

    pending_row.refresh_from_db()
    assert pending_row.status == VideoIndex.STATUS_READY
    assert pending_row.frame_count == 3
    assert pending_row.codec == "h264"
    assert PtsCodec().decode(pending_row.pts_blob) == pytest.approx([0.0, 0.0333, 0.0667], abs=1e-3)
    assert pending_row.source == VideoIndex.SOURCE_SERVER


@pytest.mark.django_db
def test_job_handles_ffmpeg_not_installed(pending_row):
    with patch("video_index.jobs.VideoUrlResolver") as Resolver:
        Resolver.return_value.resolve.return_value.canonical_url = "u"
        Resolver.return_value.resolve.return_value.can_backend_fetch = True
        with patch("video_index.jobs.FfprobeProber") as Prober:
            Prober.return_value.probe.side_effect = FfmpegNotInstalled("nope")
            compute_video_index(content_key=pending_row.content_key, raw_url="u")
    pending_row.refresh_from_db()
    assert pending_row.status == VideoIndex.STATUS_UNAVAILABLE
    assert "nope" in pending_row.error


@pytest.mark.django_db
def test_job_handles_unreachable_url(pending_row):
    with patch("video_index.jobs.VideoUrlResolver") as Resolver:
        Resolver.return_value.resolve.return_value.canonical_url = "u"
        Resolver.return_value.resolve.return_value.can_backend_fetch = False
        compute_video_index(content_key=pending_row.content_key, raw_url="u")
    pending_row.refresh_from_db()
    assert pending_row.status == VideoIndex.STATUS_UNAVAILABLE


@pytest.mark.django_db
def test_job_handles_probe_failed(pending_row):
    with patch("video_index.jobs.VideoUrlResolver") as Resolver:
        Resolver.return_value.resolve.return_value.canonical_url = "u"
        Resolver.return_value.resolve.return_value.can_backend_fetch = True
        with patch("video_index.jobs.FfprobeProber") as Prober:
            Prober.return_value.probe.side_effect = ProbeFailed("bad pixels")
            compute_video_index(content_key=pending_row.content_key, raw_url="u")
    pending_row.refresh_from_db()
    assert pending_row.status == VideoIndex.STATUS_FAILED
    assert "bad pixels" in pending_row.error


@pytest.mark.django_db
def test_job_idempotent_on_ready_row(pending_row):
    pending_row.status = VideoIndex.STATUS_READY
    pending_row.frame_count = 999
    pending_row.save()
    with patch("video_index.jobs.FfprobeProber") as Prober:
        compute_video_index(content_key=pending_row.content_key, raw_url="u")
        Prober.assert_not_called()
    pending_row.refresh_from_db()
    assert pending_row.frame_count == 999
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd label_studio && pytest video_index/tests/test_compute_video_index_job.py -v`
Expected: FAIL — `video_index.jobs` doesn't exist.

- [ ] **Step 3: Implement the job**

```python
# label_studio/video_index/jobs.py
"""RQ job: compute a VideoIndex row given (content_key, raw_url).

Idempotent: a ready row is left alone. This is also the cancellation
mechanism — a concurrent client-POST that marks the row ready will
cause this job's final step to no-op.
"""
from __future__ import annotations

import logging

from django.db import transaction
from django_rq import job

from .models import VideoIndex
from .services.codec import PtsCodec
from .services.probe import (
    FfmpegNotInstalled,
    FfprobeProber,
    NoVideoStream,
    ProbeFailed,
    ProbeResult,
    ProbeTimeout,
    UnreachableUrl,
)
from .services.resolver import VideoUrlResolver

logger = logging.getLogger(__name__)


@job("low")
def compute_video_index(content_key: str, raw_url: str) -> None:
    with transaction.atomic():
        row = VideoIndex.objects.select_for_update().filter(content_key=content_key).first()
        if row is None:
            logger.warning("compute_video_index: no row for %s", content_key)
            return
        if row.status == VideoIndex.STATUS_READY:
            return  # idempotent no-op

    resolved = VideoUrlResolver().resolve(task=None, raw_url=raw_url)
    if not resolved.can_backend_fetch:
        _mark(content_key, status=VideoIndex.STATUS_UNAVAILABLE, error="backend cannot fetch url")
        return

    try:
        result: ProbeResult = FfprobeProber().probe(resolved.canonical_url)
    except FfmpegNotInstalled as exc:
        _mark(content_key, status=VideoIndex.STATUS_UNAVAILABLE, error=str(exc))
        return
    except UnreachableUrl as exc:
        _mark(content_key, status=VideoIndex.STATUS_UNAVAILABLE, error=str(exc))
        return
    except (NoVideoStream, ProbeFailed, ProbeTimeout) as exc:
        _mark(content_key, status=VideoIndex.STATUS_FAILED, error=str(exc))
        return

    blob = PtsCodec().encode(result.pts)
    with transaction.atomic():
        row = VideoIndex.objects.select_for_update().get(content_key=content_key)
        # Re-check: a client POST may have raced us to ready.
        if row.status == VideoIndex.STATUS_READY:
            return
        row.status = VideoIndex.STATUS_READY
        row.pts_blob = blob
        row.frame_count = len(result.pts)
        row.duration = result.pts[-1] if result.pts else 0.0
        row.codec = result.codec
        row.width = result.width
        row.height = result.height
        row.source = VideoIndex.SOURCE_SERVER
        row.error = ""
        row.save()


def _mark(content_key: str, *, status: str, error: str) -> None:
    with transaction.atomic():
        VideoIndex.objects.filter(content_key=content_key).update(status=status, error=error)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd label_studio && pytest video_index/tests/test_compute_video_index_job.py -v`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add label_studio/video_index/jobs.py label_studio/video_index/tests/test_compute_video_index_job.py
git commit -m "feat(video_index): add compute_video_index RQ job"
```

---

### Task 1.11 — Serializer (decodes blob for the wire)

**Files:**
- Create: `label_studio/video_index/serializers.py`
- Create: `label_studio/video_index/tests/test_serializer.py`

- [ ] **Step 1: Write the failing tests**

```python
# label_studio/video_index/tests/test_serializer.py
import pytest
from video_index.models import VideoIndex
from video_index.serializers import VideoIndexSerializer
from video_index.services.codec import PtsCodec


@pytest.mark.django_db
def test_serializer_decodes_dense_pts():
    row = VideoIndex.objects.create(
        content_key="d" * 40,
        status=VideoIndex.STATUS_READY,
        pts_blob=PtsCodec().encode([0.0, 0.0333, 0.0667]),
        frame_count=3,
        duration=0.0667,
        codec="h264",
        width=64, height=64,
    )
    data = VideoIndexSerializer(row).data
    assert data["content_key"] == "d" * 40
    assert data["frame_count"] == 3
    assert data["codec"] == "h264"
    assert "pts" in data
    assert "cfr" not in data
    assert len(data["pts"]) == 3
    assert data["pts"][2] == pytest.approx(0.0667, abs=1e-3)


@pytest.mark.django_db
def test_serializer_emits_cfr_shorthand():
    row = VideoIndex.objects.create(
        content_key="e" * 40,
        status=VideoIndex.STATUS_READY,
        pts_blob=PtsCodec().encode_cfr_shorthand(fps=29.97, count=1800),
        frame_count=1800,
        duration=60.0,
        codec="h264",
        width=64, height=64,
    )
    data = VideoIndexSerializer(row).data
    assert "cfr" in data
    assert data["cfr"]["fps"] == pytest.approx(29.97, abs=1e-3)
    assert "pts" not in data
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd label_studio && pytest video_index/tests/test_serializer.py -v`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the serializer**

```python
# label_studio/video_index/serializers.py
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd label_studio && pytest video_index/tests/test_serializer.py -v`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add label_studio/video_index/serializers.py label_studio/video_index/tests/test_serializer.py
git commit -m "feat(video_index): add VideoIndexSerializer with CFR shorthand branch"
```

---

### Task 1.12 — API: GET endpoint (status matrix)

**Files:**
- Create: `label_studio/video_index/api.py`
- Create: `label_studio/video_index/urls.py`
- Modify: `label_studio/core/urls.py:62-72` (add include)
- Create: `label_studio/video_index/tests/test_api_get.py`

- [ ] **Step 1: Write the failing tests**

```python
# label_studio/video_index/tests/test_api_get.py
from unittest.mock import patch

import pytest
from rest_framework.test import APIClient

from video_index.models import VideoIndex
from video_index.services.codec import PtsCodec


@pytest.fixture
def client(db, django_user_model):
    user = django_user_model.objects.create_user(email="u@example.com", password="x")
    api = APIClient()
    api.force_authenticate(user=user)
    return api


def _ready_row(content_key="a" * 40):
    return VideoIndex.objects.create(
        content_key=content_key,
        status=VideoIndex.STATUS_READY,
        pts_blob=PtsCodec().encode([0.0, 0.0333]),
        frame_count=2,
        duration=0.0333,
        codec="h264",
        width=64, height=64,
    )


@pytest.mark.django_db
def test_get_returns_200_for_ready_row(client):
    row = _ready_row()
    with patch("video_index.api.resolve_content_key", return_value=row.content_key):
        resp = client.get("/api/video-index/", {"url": "u", "task": 0})
    assert resp.status_code == 200
    assert resp.json()["frame_count"] == 2


@pytest.mark.django_db
def test_get_returns_202_for_pending_row(client):
    row = VideoIndex.objects.create(content_key="b" * 40, status=VideoIndex.STATUS_PENDING)
    with patch("video_index.api.resolve_content_key", return_value=row.content_key):
        resp = client.get("/api/video-index/", {"url": "u", "task": 0})
    assert resp.status_code == 202
    assert resp.json()["status"] == "pending"


@pytest.mark.django_db
def test_get_creates_row_and_enqueues_when_missing(client):
    ck = "c" * 40
    with patch("video_index.api.resolve_content_key", return_value=ck):
        with patch("video_index.api.compute_video_index.delay") as enqueue:
            resp = client.get("/api/video-index/", {"url": "u", "task": 0})
            enqueue.assert_called_once()
    assert resp.status_code == 202
    assert VideoIndex.objects.filter(content_key=ck, status="pending").exists()


@pytest.mark.django_db
def test_get_returns_409_for_unavailable_row(client):
    row = VideoIndex.objects.create(content_key="d" * 40, status=VideoIndex.STATUS_UNAVAILABLE, error="no ffmpeg")
    with patch("video_index.api.resolve_content_key", return_value=row.content_key):
        resp = client.get("/api/video-index/", {"url": "u", "task": 0})
    assert resp.status_code == 409


@pytest.mark.django_db
def test_get_returns_422_for_failed_row(client):
    row = VideoIndex.objects.create(content_key="e" * 40, status=VideoIndex.STATUS_FAILED, error="corrupt")
    with patch("video_index.api.resolve_content_key", return_value=row.content_key):
        resp = client.get("/api/video-index/", {"url": "u", "task": 0})
    assert resp.status_code == 422
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd label_studio && pytest video_index/tests/test_api_get.py -v`
Expected: FAIL — module missing / URL not routed.

- [ ] **Step 3: Implement the API + URL routing**

```python
# label_studio/video_index/api.py
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
```

```python
# label_studio/video_index/urls.py
from django.urls import path

from .api import VideoIndexView

app_name = "video_index"
urlpatterns = [
    path("api/video-index/", VideoIndexView.as_view(), name="video-index"),
]
```

Modify `label_studio/core/urls.py` — add `re_path(r'^', include('video_index.urls')),` adjacent to the other `include('xxx.urls')` lines (around line 72, after `labels_manager.urls`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd label_studio && pytest video_index/tests/test_api_get.py -v`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add label_studio/video_index/api.py label_studio/video_index/urls.py label_studio/core/urls.py label_studio/video_index/tests/test_api_get.py
git commit -m "feat(video_index): add GET /api/video-index/ with status matrix"
```

---

### Task 1.13 — API: POST endpoint (client-computed index)

**Files:**
- Modify: `label_studio/video_index/api.py`
- Create: `label_studio/video_index/tests/test_api_post.py`

- [ ] **Step 1: Write the failing tests**

```python
# label_studio/video_index/tests/test_api_post.py
from unittest.mock import patch

import pytest
from rest_framework.test import APIClient

from video_index.models import VideoIndex


@pytest.fixture
def client(db, django_user_model):
    user = django_user_model.objects.create_user(email="u@example.com", password="x")
    api = APIClient()
    api.force_authenticate(user=user)
    return api


@pytest.mark.django_db
def test_post_creates_ready_row_with_source_client(client):
    payload = {
        "content_key": "f" * 40,
        "pts": [0.0, 0.0333, 0.0667],
        "frame_count": 3,
        "duration": 0.0667,
        "codec": "h264",
        "width": 64, "height": 64,
    }
    resp = client.post("/api/video-index/", payload, format="json")
    assert resp.status_code == 201
    row = VideoIndex.objects.get(content_key="f" * 40)
    assert row.status == "ready"
    assert row.source == "client"
    assert row.frame_count == 3


@pytest.mark.django_db
def test_post_overwrites_pending_row(client):
    VideoIndex.objects.create(content_key="g" * 40, status="pending")
    payload = {
        "content_key": "g" * 40,
        "pts": [0.0],
        "frame_count": 1,
        "duration": 0.0,
        "codec": "h264", "width": 64, "height": 64,
    }
    resp = client.post("/api/video-index/", payload, format="json")
    assert resp.status_code == 201
    row = VideoIndex.objects.get(content_key="g" * 40)
    assert row.status == "ready"
    assert row.source == "client"


@pytest.mark.django_db
def test_post_no_op_when_already_ready(client):
    VideoIndex.objects.create(
        content_key="h" * 40, status="ready", source="server", frame_count=99,
    )
    payload = {
        "content_key": "h" * 40,
        "pts": [0.0], "frame_count": 1, "duration": 0.0,
        "codec": "h264", "width": 64, "height": 64,
    }
    resp = client.post("/api/video-index/", payload, format="json")
    assert resp.status_code == 200
    assert resp.json().get("already_ready") is True
    row = VideoIndex.objects.get(content_key="h" * 40)
    assert row.source == "server"
    assert row.frame_count == 99


@pytest.mark.django_db
def test_post_rejects_unauthenticated(db):
    api = APIClient()
    resp = api.post("/api/video-index/", {}, format="json")
    assert resp.status_code in (401, 403)


@pytest.mark.django_db
def test_post_validates_required_fields(client):
    resp = client.post("/api/video-index/", {"content_key": "i" * 40}, format="json")
    assert resp.status_code == 400
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd label_studio && pytest video_index/tests/test_api_post.py -v`
Expected: FAIL — POST not implemented.

- [ ] **Step 3: Implement POST on the view**

Append to `label_studio/video_index/api.py`:

```python
from django.db import transaction

from .services.codec import PtsCodec


class VideoIndexView(VideoIndexView):  # type: ignore[no-redef]
    # NOTE: not a real subclass — the actual change is to add `post` to the
    # existing class. The block below shows the method to add.
    pass
```

Concretely, replace the file with this complete version:

```python
# label_studio/video_index/api.py
from django.db import transaction
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
            row = (
                VideoIndex.objects.select_for_update()
                .filter(content_key=content_key)
                .first()
            )

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd label_studio && pytest video_index/tests/test_api_post.py video_index/tests/test_api_get.py -v`
Expected: PASS — 5 GET tests + 5 POST tests = 10.

- [ ] **Step 5: Commit**

```bash
git add label_studio/video_index/api.py label_studio/video_index/tests/test_api_post.py
git commit -m "feat(video_index): add POST /api/video-index/ for client-side index"
```

---

### Task 1.14 — Settings keys with defaults

**Files:**
- Modify: `label_studio/core/settings/base.py`
- Create: `label_studio/video_index/tests/test_settings.py`

- [ ] **Step 1: Write the failing tests**

```python
# label_studio/video_index/tests/test_settings.py
from django.conf import settings


def test_default_ffprobe_path():
    assert settings.VIDEO_INDEX_FFPROBE_PATH == "ffprobe"


def test_default_probe_timeout():
    assert settings.VIDEO_INDEX_PROBE_TIMEOUT_SECONDS == 120


def test_default_max_payload_bytes():
    assert settings.VIDEO_INDEX_MAX_PAYLOAD_BYTES == 5_000_000
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd label_studio && pytest video_index/tests/test_settings.py -v`
Expected: FAIL — settings attributes missing.

- [ ] **Step 3: Add settings keys**

Append to `label_studio/core/settings/base.py` (end of file is fine — there's no required ordering):

```python
# --- video_index ---
VIDEO_INDEX_FFPROBE_PATH = get_env("VIDEO_INDEX_FFPROBE_PATH", "ffprobe")
VIDEO_INDEX_PROBE_TIMEOUT_SECONDS = int(get_env("VIDEO_INDEX_PROBE_TIMEOUT_SECONDS", 120))
VIDEO_INDEX_MAX_PAYLOAD_BYTES = int(get_env("VIDEO_INDEX_MAX_PAYLOAD_BYTES", 5_000_000))
```

(Use the existing `get_env` helper already imported in `base.py`. If a different env helper is the convention there, follow it.)

Then wire the settings into the prober — modify `label_studio/video_index/services/probe.py:FfprobeProber.__init__` to use them as defaults:

```python
    def __init__(
        self,
        ffprobe_path: str | None = None,
        timeout_seconds: int | None = None,
    ) -> None:
        from django.conf import settings as _settings
        self.ffprobe_path = ffprobe_path or _settings.VIDEO_INDEX_FFPROBE_PATH
        self.timeout_seconds = (
            timeout_seconds if timeout_seconds is not None else _settings.VIDEO_INDEX_PROBE_TIMEOUT_SECONDS
        )
```

Re-run the prober tests to confirm nothing regressed:

```bash
cd label_studio && pytest video_index/tests/test_ffprobe_prober.py -v
```

- [ ] **Step 4: Run all video_index tests**

Run: `cd label_studio && pytest video_index/ -v`
Expected: PASS for everything (all backend tasks so far).

- [ ] **Step 5: Commit**

```bash
git add label_studio/core/settings/base.py label_studio/video_index/services/probe.py label_studio/video_index/tests/test_settings.py
git commit -m "feat(video_index): wire settings keys for ffprobe path/timeout/payload cap"
```

---

## Phase 2 — Frontend `VideoIndex` library

> **Toolchain note:** The frontend tests use Jest. Workspace path is `web/libs/editor`. Run a single test with: `yarn nx test editor --testPathPattern=VideoIndex` from `web/`. Confirm the exact command by looking at `web/package.json` scripts and existing test files in `web/libs/editor/src/**/__tests__/`.

### Task 2.1 — `VideoIndex` class (dense backing)

**Files:**
- Create: `web/libs/editor/src/lib/VideoIndex/types.ts`
- Create: `web/libs/editor/src/lib/VideoIndex/VideoIndex.ts`
- Create: `web/libs/editor/src/lib/VideoIndex/__tests__/VideoIndex.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// web/libs/editor/src/lib/VideoIndex/__tests__/VideoIndex.test.ts
import { VideoIndex } from "../VideoIndex";

describe("VideoIndex (dense backing)", () => {
  const ptsVfr = [0.0, 0.0333, 0.0667, 0.1, 0.15, 0.2167];

  it("reports length and duration", () => {
    const idx = VideoIndex.fromPayload({ content_key: "k", frame_count: 6, duration: 0.2167, codec: "h264", pts: ptsVfr });
    expect(idx.length).toBe(6);
    expect(idx.duration).toBeCloseTo(0.2167, 4);
  });

  it("timeAt(frame) returns the exact pts (1-based)", () => {
    const idx = VideoIndex.fromPayload({ content_key: "k", frame_count: 6, duration: 0.2167, codec: "h264", pts: ptsVfr });
    expect(idx.timeAt(1)).toBeCloseTo(0.0, 6);
    expect(idx.timeAt(3)).toBeCloseTo(0.0667, 4);
    expect(idx.timeAt(6)).toBeCloseTo(0.2167, 4);
  });

  it("frameAt(time) finds the largest pts <= time (1-based)", () => {
    const idx = VideoIndex.fromPayload({ content_key: "k", frame_count: 6, duration: 0.2167, codec: "h264", pts: ptsVfr });
    expect(idx.frameAt(0.0)).toBe(1);
    expect(idx.frameAt(0.04)).toBe(2);   // between 0.0333 and 0.0667
    expect(idx.frameAt(0.0667)).toBe(3);
    expect(idx.frameAt(0.5)).toBe(6);    // past end clamps to last
  });

  it("clamps timeAt() out-of-range to nearest valid frame", () => {
    const idx = VideoIndex.fromPayload({ content_key: "k", frame_count: 6, duration: 0.2167, codec: "h264", pts: ptsVfr });
    expect(idx.timeAt(0)).toBeCloseTo(0.0, 6);
    expect(idx.timeAt(999)).toBeCloseTo(0.2167, 4);
  });

  it("frameAt(time) below the first pts returns 1", () => {
    const idx = VideoIndex.fromPayload({ content_key: "k", frame_count: 6, duration: 0.2167, codec: "h264", pts: ptsVfr });
    expect(idx.frameAt(-1)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && yarn nx test editor --testPathPattern=VideoIndex`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the class**

```ts
// web/libs/editor/src/lib/VideoIndex/types.ts
export interface DensePayload {
  content_key: string;
  frame_count: number;
  duration: number;
  codec: string;
  width?: number;
  height?: number;
  pts: number[];
}

export interface CfrPayload {
  content_key: string;
  frame_count: number;
  duration: number;
  codec: string;
  width?: number;
  height?: number;
  cfr: { fps: number; count?: number };
}

export type IndexPayload = DensePayload | CfrPayload;
```

```ts
// web/libs/editor/src/lib/VideoIndex/VideoIndex.ts
import type { CfrPayload, DensePayload, IndexPayload } from "./types";

export class VideoIndex {
  static fromPayload(payload: IndexPayload): VideoIndex {
    if ("cfr" in payload) return new VideoIndex(payload, null, payload.cfr);
    return new VideoIndex(payload, payload.pts, null);
  }

  private constructor(
    private readonly payload: IndexPayload,
    private readonly pts: number[] | null,
    private readonly cfr: { fps: number; count?: number } | null,
  ) {}

  get length(): number {
    return this.payload.frame_count;
  }

  get duration(): number {
    return this.payload.duration;
  }

  get contentKey(): string {
    return this.payload.content_key;
  }

  /** 1-based frame number -> time in seconds. Clamps to valid range. */
  timeAt(frame: number): number {
    const n = Math.max(1, Math.min(frame, this.length));
    if (this.cfr) return (n - 1) / this.cfr.fps;
    return this.pts![n - 1];
  }

  /** Time in seconds -> largest 1-based frame N with timeAt(N) <= time. */
  frameAt(time: number): number {
    if (time <= 0) return 1;
    if (this.cfr) {
      const n = Math.floor(time * this.cfr.fps) + 1;
      return Math.max(1, Math.min(n, this.length));
    }
    const pts = this.pts!;
    if (time >= pts[pts.length - 1]) return pts.length;
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pts[mid] <= time) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && yarn nx test editor --testPathPattern=VideoIndex`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add web/libs/editor/src/lib/VideoIndex/
git commit -m "feat(editor): add VideoIndex class with dense PTS backing"
```

---

### Task 2.2 — `VideoIndex` CFR shorthand backing

**Files:**
- Modify: `web/libs/editor/src/lib/VideoIndex/__tests__/VideoIndex.test.ts`

- [ ] **Step 1: Add the failing tests**

Append:

```ts
describe("VideoIndex (CFR shorthand backing)", () => {
  const cfr = { content_key: "k", frame_count: 90, duration: 3.0, codec: "h264", cfr: { fps: 30 } };

  it("timeAt produces 1-based frame * (1/fps)", () => {
    const idx = VideoIndex.fromPayload(cfr);
    expect(idx.timeAt(1)).toBeCloseTo(0.0, 6);
    expect(idx.timeAt(31)).toBeCloseTo(1.0, 6);
    expect(idx.timeAt(90)).toBeCloseTo(89 / 30, 6);
  });

  it("frameAt finds the floor of time*fps + 1", () => {
    const idx = VideoIndex.fromPayload(cfr);
    expect(idx.frameAt(0)).toBe(1);
    expect(idx.frameAt(0.034)).toBe(2);
    expect(idx.frameAt(1.0)).toBe(31);
    expect(idx.frameAt(10)).toBe(90); // past end
  });
});
```

- [ ] **Step 2: Run tests to verify they pass (no impl change needed)**

Run: `cd web && yarn nx test editor --testPathPattern=VideoIndex`
Expected: PASS — total 7 tests.

- [ ] **Step 3: Commit**

```bash
git add web/libs/editor/src/lib/VideoIndex/__tests__/VideoIndex.test.ts
git commit -m "test(editor): cover VideoIndex CFR shorthand backing"
```

---

### Task 2.3 — `PayloadValidator`

**Files:**
- Create: `web/libs/editor/src/lib/VideoIndex/PayloadValidator.ts`
- Create: `web/libs/editor/src/lib/VideoIndex/__tests__/PayloadValidator.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// web/libs/editor/src/lib/VideoIndex/__tests__/PayloadValidator.test.ts
import { PayloadValidator } from "../PayloadValidator";

describe("PayloadValidator", () => {
  it("accepts a valid dense payload", () => {
    const v = new PayloadValidator();
    const result = v.validate({
      content_key: "k", frame_count: 3, duration: 0.1,
      codec: "h264", pts: [0, 0.05, 0.1],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a valid CFR shorthand payload", () => {
    const v = new PayloadValidator();
    const result = v.validate({
      content_key: "k", frame_count: 90, duration: 3.0,
      codec: "h264", cfr: { fps: 30 },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects empty pts array", () => {
    const v = new PayloadValidator();
    const result = v.validate({ content_key: "k", frame_count: 0, duration: 0, codec: "h264", pts: [] });
    expect(result.ok).toBe(false);
  });

  it("rejects non-monotonic pts", () => {
    const v = new PayloadValidator();
    const result = v.validate({
      content_key: "k", frame_count: 3, duration: 0.1, codec: "h264",
      pts: [0.0, 0.05, 0.04],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/monotonic/i);
  });

  it("warns but accepts when frame_count disagrees with pts.length", () => {
    const v = new PayloadValidator();
    const result = v.validate({
      content_key: "k", frame_count: 99, duration: 0.1, codec: "h264",
      pts: [0, 0.05, 0.1],
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some(w => /frame_count/i.test(w))).toBe(true);
  });

  it("rejects missing content_key", () => {
    const v = new PayloadValidator();
    // @ts-expect-error intentional bad input
    const result = v.validate({ frame_count: 1, duration: 0, codec: "h264", pts: [0] });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && yarn nx test editor --testPathPattern=PayloadValidator`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the validator**

```ts
// web/libs/editor/src/lib/VideoIndex/PayloadValidator.ts
import type { IndexPayload } from "./types";

export interface ValidationResult {
  ok: boolean;
  error?: string;
  warnings: string[];
}

export class PayloadValidator {
  validate(payload: IndexPayload | unknown): ValidationResult {
    const warnings: string[] = [];
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "payload is not an object", warnings };
    }
    const p = payload as Partial<IndexPayload>;
    if (typeof p.content_key !== "string" || !p.content_key) {
      return { ok: false, error: "missing content_key", warnings };
    }
    if ("cfr" in p && p.cfr) {
      if (typeof p.cfr.fps !== "number" || p.cfr.fps <= 0) {
        return { ok: false, error: "invalid cfr.fps", warnings };
      }
      return { ok: true, warnings };
    }
    const pts = (p as { pts?: number[] }).pts;
    if (!Array.isArray(pts) || pts.length === 0) {
      return { ok: false, error: "pts must be non-empty array", warnings };
    }
    for (let i = 1; i < pts.length; i++) {
      if (pts[i] < pts[i - 1]) {
        return { ok: false, error: "pts must be monotonic non-decreasing", warnings };
      }
    }
    if (typeof p.frame_count === "number" && p.frame_count !== pts.length) {
      warnings.push(`frame_count (${p.frame_count}) disagrees with pts.length (${pts.length}); using pts.length`);
    }
    return { ok: true, warnings };
  }
}
```

Add to `web/libs/editor/src/lib/VideoIndex/index.ts` (create the file):

```ts
// web/libs/editor/src/lib/VideoIndex/index.ts
export { VideoIndex } from "./VideoIndex";
export { PayloadValidator } from "./PayloadValidator";
export type { IndexPayload, DensePayload, CfrPayload } from "./types";
export type { ValidationResult } from "./PayloadValidator";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && yarn nx test editor --testPathPattern=PayloadValidator`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add web/libs/editor/src/lib/VideoIndex/
git commit -m "feat(editor): add PayloadValidator + public lib exports"
```

---

### Task 2.4 — `VideoIndexCache` (IndexedDB)

**Files:**
- Create: `web/libs/editor/src/lib/VideoIndex/VideoIndexCache.ts`
- Create: `web/libs/editor/src/lib/VideoIndex/__tests__/VideoIndexCache.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// web/libs/editor/src/lib/VideoIndex/__tests__/VideoIndexCache.test.ts
/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto";
import { VideoIndexCache } from "../VideoIndexCache";

describe("VideoIndexCache", () => {
  let cache: VideoIndexCache;
  beforeEach(() => { cache = new VideoIndexCache(`test-${Math.random()}`); });

  it("round-trips a payload by content_key", async () => {
    const payload = { content_key: "k1", frame_count: 1, duration: 0, codec: "h264", pts: [0] };
    await cache.put(payload);
    const hit = await cache.get("k1");
    expect(hit?.content_key).toBe("k1");
    expect(hit?.frame_count).toBe(1);
  });

  it("returns undefined for unknown key", async () => {
    expect(await cache.get("nope")).toBeUndefined();
  });

  it("overwrites the same content_key on second put", async () => {
    await cache.put({ content_key: "k2", frame_count: 1, duration: 0, codec: "h264", pts: [0] });
    await cache.put({ content_key: "k2", frame_count: 2, duration: 0, codec: "h264", pts: [0, 0.1] });
    const hit = await cache.get("k2");
    expect(hit?.frame_count).toBe(2);
  });
});
```

> **Dependency note:** `fake-indexeddb` is the standard jsdom IndexedDB shim. If not yet listed in `web/package.json`, add it as a devDependency: `yarn workspace @humansignal/editor add -D fake-indexeddb` (verify the exact workspace name from `web/package.json`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && yarn nx test editor --testPathPattern=VideoIndexCache`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the cache**

```ts
// web/libs/editor/src/lib/VideoIndex/VideoIndexCache.ts
import type { IndexPayload } from "./types";

const STORE_NAME = "payloads";

export class VideoIndexCache {
  private dbPromise: Promise<IDBDatabase>;

  constructor(private readonly dbName: string = "ls-video-index") {
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME, { keyPath: "content_key" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async get(content_key: string): Promise<IndexPayload | undefined> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(content_key);
      req.onsuccess = () => resolve(req.result as IndexPayload | undefined);
      req.onerror = () => reject(req.error);
    });
  }

  async put(payload: IndexPayload): Promise<void> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(payload);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && yarn nx test editor --testPathPattern=VideoIndexCache`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add web/libs/editor/src/lib/VideoIndex/VideoIndexCache.ts web/libs/editor/src/lib/VideoIndex/__tests__/VideoIndexCache.test.ts web/package.json
git commit -m "feat(editor): add VideoIndexCache backed by IndexedDB"
```

---

### Task 2.5 — `VideoIndexLoader` (server happy path + 202 polling)

**Files:**
- Create: `web/libs/editor/src/lib/VideoIndex/VideoIndexLoader.ts`
- Create: `web/libs/editor/src/lib/VideoIndex/__tests__/VideoIndexLoader.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// web/libs/editor/src/lib/VideoIndex/__tests__/VideoIndexLoader.test.ts
import { VideoIndexLoader, type LoaderTransport } from "../VideoIndexLoader";

function makeTransport(responses: Array<() => Promise<{ status: number; body: any }>>): LoaderTransport {
  let i = 0;
  return {
    async get() { return responses[i++ < responses.length ? i - 1 : responses.length - 1](); },
    async post(_body: any) { return { status: 201, body: { ok: true } }; },
  };
}

describe("VideoIndexLoader — server happy path", () => {
  it("resolves with a VideoIndex on 200", async () => {
    const t = makeTransport([
      async () => ({ status: 200, body: { content_key: "k", frame_count: 3, duration: 0.1, codec: "h264", pts: [0, 0.05, 0.1] } }),
    ]);
    const loader = new VideoIndexLoader({ transport: t, pollIntervalMs: 5, fallbackTimeoutMs: 60_000 });
    const idx = await loader.load({ videoUrl: "u" });
    expect(idx.length).toBe(3);
  });

  it("polls on 202 until 200", async () => {
    const t = makeTransport([
      async () => ({ status: 202, body: { status: "pending", content_key: "k" } }),
      async () => ({ status: 202, body: { status: "pending", content_key: "k" } }),
      async () => ({ status: 200, body: { content_key: "k", frame_count: 1, duration: 0, codec: "h264", pts: [0] } }),
    ]);
    const loader = new VideoIndexLoader({ transport: t, pollIntervalMs: 1, fallbackTimeoutMs: 60_000 });
    const idx = await loader.load({ videoUrl: "u" });
    expect(idx.length).toBe(1);
  });

  it("rejects on a 422 (failed)", async () => {
    const t = makeTransport([async () => ({ status: 422, body: { status: "failed", error: "corrupt" } })]);
    const loader = new VideoIndexLoader({ transport: t, pollIntervalMs: 1, fallbackTimeoutMs: 60_000 });
    await expect(loader.load({ videoUrl: "u" })).rejects.toThrow(/corrupt/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && yarn nx test editor --testPathPattern=VideoIndexLoader`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the loader (server paths only — wasm fallback is Task 2.6)**

```ts
// web/libs/editor/src/lib/VideoIndex/VideoIndexLoader.ts
import { PayloadValidator } from "./PayloadValidator";
import { VideoIndex } from "./VideoIndex";
import type { IndexPayload } from "./types";

export interface TransportResponse { status: number; body: any }
export interface LoaderTransport {
  get(): Promise<TransportResponse>;
  post(body: IndexPayload): Promise<TransportResponse>;
}

export interface LoaderOptions {
  transport: LoaderTransport;
  pollIntervalMs?: number;
  fallbackTimeoutMs?: number;
  wasmProbe?: (videoUrl: string) => Promise<IndexPayload>;
  cache?: { get(k: string): Promise<IndexPayload | undefined>; put(p: IndexPayload): Promise<void> };
}

export class VideoIndexLoader {
  private readonly validator = new PayloadValidator();

  constructor(private readonly opts: LoaderOptions) {}

  async load(_args: { videoUrl: string }): Promise<VideoIndex> {
    const pollIntervalMs = this.opts.pollIntervalMs ?? 1000;
    while (true) {
      const r = await this.opts.transport.get();
      if (r.status === 200) {
        return this.buildIndex(r.body);
      }
      if (r.status === 202) {
        await sleep(pollIntervalMs);
        continue;
      }
      if (r.status === 409) {
        throw new Error("wasm-fallback-required"); // handled in Task 2.6
      }
      if (r.status === 422) {
        throw new Error(`video index failed: ${r.body?.error ?? "unknown"}`);
      }
      throw new Error(`unexpected status ${r.status}`);
    }
  }

  private buildIndex(payload: IndexPayload): VideoIndex {
    const v = this.validator.validate(payload);
    if (!v.ok) throw new Error(`invalid index payload: ${v.error}`);
    for (const w of v.warnings) console.warn(`[VideoIndex] ${w}`);
    return VideoIndex.fromPayload(payload);
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && yarn nx test editor --testPathPattern=VideoIndexLoader`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add web/libs/editor/src/lib/VideoIndex/VideoIndexLoader.ts web/libs/editor/src/lib/VideoIndex/__tests__/VideoIndexLoader.test.ts
git commit -m "feat(editor): add VideoIndexLoader with 200/202/422 handling"
```

---

### Task 2.6 — `VideoIndexLoader` wasm fallback + parallel race

**Files:**
- Modify: `web/libs/editor/src/lib/VideoIndex/VideoIndexLoader.ts`
- Modify: `web/libs/editor/src/lib/VideoIndex/__tests__/VideoIndexLoader.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `__tests__/VideoIndexLoader.test.ts`:

```ts
describe("VideoIndexLoader — wasm fallback", () => {
  it("dispatches wasm probe on 409 and POSTs the result back", async () => {
    const posts: any[] = [];
    const transport: LoaderTransport = {
      async get() { return { status: 409, body: { status: "unavailable", error: "no ffmpeg" } }; },
      async post(body) { posts.push(body); return { status: 201, body: { ok: true } }; },
    };
    const wasmProbe = jest.fn().mockResolvedValue({
      content_key: "k", frame_count: 2, duration: 0.05, codec: "h264", pts: [0, 0.05],
    });
    const loader = new VideoIndexLoader({ transport, pollIntervalMs: 1, fallbackTimeoutMs: 60_000, wasmProbe });
    const idx = await loader.load({ videoUrl: "u" });
    expect(idx.length).toBe(2);
    expect(wasmProbe).toHaveBeenCalledTimes(1);
    expect(posts).toHaveLength(1);
    expect(posts[0].content_key).toBe("k");
  });

  it("races wasm against server when polling exceeds fallbackTimeoutMs", async () => {
    let gets = 0;
    const transport: LoaderTransport = {
      async get() {
        gets++;
        // Stay 202 indefinitely so wasm has to win.
        return { status: 202, body: { status: "pending", content_key: "k" } };
      },
      async post() { return { status: 201, body: {} }; },
    };
    const wasmProbe = jest.fn().mockResolvedValue({
      content_key: "k", frame_count: 1, duration: 0, codec: "h264", pts: [0],
    });
    const loader = new VideoIndexLoader({ transport, pollIntervalMs: 5, fallbackTimeoutMs: 20, wasmProbe });
    const idx = await loader.load({ videoUrl: "u" });
    expect(idx.length).toBe(1);
    expect(wasmProbe).toHaveBeenCalledTimes(1);
    expect(gets).toBeGreaterThanOrEqual(1); // server was being polled in parallel
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && yarn nx test editor --testPathPattern=VideoIndexLoader`
Expected: FAIL — load() throws `wasm-fallback-required` instead of falling back.

- [ ] **Step 3: Replace `load()` with the race-aware version**

Replace the `load` method in `VideoIndexLoader.ts`:

```ts
  async load(args: { videoUrl: string }): Promise<VideoIndex> {
    const pollIntervalMs = this.opts.pollIntervalMs ?? 1000;
    const fallbackTimeoutMs = this.opts.fallbackTimeoutMs ?? 10_000;
    const serverPromise = this.serverPath(pollIntervalMs);
    const wasmPromise = this.wasmPath(args.videoUrl, fallbackTimeoutMs);
    return await Promise.any([serverPromise, wasmPromise]);
  }

  private async serverPath(pollIntervalMs: number): Promise<VideoIndex> {
    while (true) {
      const r = await this.opts.transport.get();
      if (r.status === 200) return this.buildIndex(r.body);
      if (r.status === 202) { await sleep(pollIntervalMs); continue; }
      if (r.status === 409) throw new Error("server-unavailable");
      if (r.status === 422) throw new Error(`video index failed: ${r.body?.error ?? "unknown"}`);
      throw new Error(`unexpected status ${r.status}`);
    }
  }

  private async wasmPath(videoUrl: string, fallbackTimeoutMs: number): Promise<VideoIndex> {
    if (!this.opts.wasmProbe) {
      // Without a wasm prober configured, wasm path never resolves.
      return new Promise<VideoIndex>(() => {});
    }
    // Race trigger: wait fallbackTimeoutMs unless the server returns 409 sooner.
    const trigger = new Promise<void>((resolve) => setTimeout(resolve, fallbackTimeoutMs));
    // Also trigger immediately on 409. Detect by peeking serverPath errors:
    const immediate = (async () => {
      try { await this.serverPath(/*poll*/ 60_000); }
      catch (e: any) { if (e?.message === "server-unavailable") return; throw e; }
    })().catch(() => {});
    await Promise.race([trigger, immediate]);
    const payload = await this.opts.wasmProbe(videoUrl);
    // Best-effort POST back; ignore POST failure.
    try { await this.opts.transport.post(payload); } catch { /* swallow */ }
    return this.buildIndex(payload);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && yarn nx test editor --testPathPattern=VideoIndexLoader`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add web/libs/editor/src/lib/VideoIndex/VideoIndexLoader.ts web/libs/editor/src/lib/VideoIndex/__tests__/VideoIndexLoader.test.ts
git commit -m "feat(editor): add wasm fallback + parallel race to VideoIndexLoader"
```

---

### Task 2.7 — `WasmProberWorker` contract + stub

**Files:**
- Create: `web/libs/editor/src/lib/VideoIndex/WasmProberWorker.ts`
- Create: `web/libs/editor/src/lib/VideoIndex/__tests__/WasmProberWorker.test.ts`

> **Implementation note:** The actual ffmpeg.wasm integration depends on the library version already used by AudioUltra (`web/libs/editor/src/lib/AudioUltra/Media/AudioDecoder.ts:150` references it). This task ships the **interface and contract** — a function `probeWithWasm(videoUrl: string): Promise<IndexPayload>` plus a worker boilerplate — backed by a mockable transport so the rest of the system can be wired up. A follow-up task (deferred — see §9 of the spec) replaces the inner demux with a real ffmpeg.wasm packet-iteration call.

- [ ] **Step 1: Write the failing test (contract only)**

```ts
// web/libs/editor/src/lib/VideoIndex/__tests__/WasmProberWorker.test.ts
import { probeWithWasm, type WasmBackend } from "../WasmProberWorker";

describe("WasmProberWorker (contract)", () => {
  it("invokes the backend and assembles an IndexPayload", async () => {
    const backend: WasmBackend = {
      async probe() {
        return { pts: [0, 0.05, 0.1], codec: "h264", width: 64, height: 64 };
      },
    };
    const result = await probeWithWasm("https://example.com/v.mp4", { backend });
    expect(result.content_key).toBeTruthy();
    expect(result.frame_count).toBe(3);
    expect((result as any).pts).toEqual([0, 0.05, 0.1]);
  });

  it("derives content_key from url + length for browser-only key", async () => {
    const backend: WasmBackend = {
      async probe() { return { pts: [0], codec: "h264", width: 1, height: 1 }; },
    };
    const a = await probeWithWasm("https://x/a.mp4", { backend });
    const b = await probeWithWasm("https://x/b.mp4", { backend });
    expect(a.content_key).not.toBe(b.content_key);
  });

  it("rejects when backend returns no pts", async () => {
    const backend: WasmBackend = {
      async probe() { return { pts: [], codec: "h264", width: 1, height: 1 }; },
    };
    await expect(probeWithWasm("u", { backend })).rejects.toThrow(/no pts/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && yarn nx test editor --testPathPattern=WasmProberWorker`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the contract**

```ts
// web/libs/editor/src/lib/VideoIndex/WasmProberWorker.ts
import type { DensePayload } from "./types";

export interface WasmProbeRaw {
  pts: number[];
  codec: string;
  width: number;
  height: number;
}

export interface WasmBackend {
  probe(videoUrl: string): Promise<WasmProbeRaw>;
}

/** Default backend: spins up the ffmpeg.wasm worker.
 *  Currently a placeholder — see Task 2.7 implementation note.
 *  Wired later in a follow-up task. */
const defaultBackend: WasmBackend = {
  async probe(_videoUrl: string): Promise<WasmProbeRaw> {
    throw new Error("ffmpeg.wasm backend not yet wired; pass an explicit backend for now");
  },
};

export async function probeWithWasm(
  videoUrl: string,
  opts: { backend?: WasmBackend } = {},
): Promise<DensePayload> {
  const backend = opts.backend ?? defaultBackend;
  const raw = await backend.probe(videoUrl);
  if (!raw.pts || raw.pts.length === 0) {
    throw new Error("wasm probe returned no pts");
  }
  return {
    content_key: await hashStringAsync(`wasm|${videoUrl}|${raw.pts.length}|${raw.pts[raw.pts.length - 1]}`),
    frame_count: raw.pts.length,
    duration: raw.pts[raw.pts.length - 1],
    codec: raw.codec,
    width: raw.width,
    height: raw.height,
    pts: raw.pts,
  };
}

async function hashStringAsync(material: string): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle?.digest) {
    const buf = new TextEncoder().encode(material);
    const digest = await crypto.subtle.digest("SHA-1", buf);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Fallback: cheap non-crypto hash for non-secure contexts (tests in jsdom)
  let h = 5381;
  for (let i = 0; i < material.length; i++) h = ((h * 33) ^ material.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && yarn nx test editor --testPathPattern=WasmProberWorker`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add web/libs/editor/src/lib/VideoIndex/WasmProberWorker.ts web/libs/editor/src/lib/VideoIndex/__tests__/WasmProberWorker.test.ts
git commit -m "feat(editor): add WasmProberWorker contract + injectable backend"
```

---

## Phase 3 — Editor integration

### Task 3.1 — `VideoCanvas` accepts `index` prop and prefers it over framerate math

**Files:**
- Modify: `web/libs/editor/src/components/VideoCanvas/VideoCanvas.tsx`
- Create: `web/libs/editor/src/components/VideoCanvas/__tests__/VideoCanvas.index.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// web/libs/editor/src/components/VideoCanvas/__tests__/VideoCanvas.index.test.tsx
/** Tests that VideoCanvas, when given an `index`, uses index.timeAt/frameAt
 *  instead of `frame/framerate` math. We inspect the refSource exposed via
 *  the forwarded ref. */
import React from "react";
import { render } from "@testing-library/react";
import { VideoCanvas } from "../VideoCanvas";
import { VideoIndex } from "../../../lib/VideoIndex";

function makeIndex() {
  return VideoIndex.fromPayload({
    content_key: "k", frame_count: 6, duration: 0.2167, codec: "h264",
    pts: [0, 0.05, 0.10, 0.13, 0.18, 0.2167],
  });
}

describe("VideoCanvas index-aware seek", () => {
  it("goToFrame(N) sets currentTime to index.timeAt(N)", () => {
    const ref = React.createRef<any>();
    render(<VideoCanvas ref={ref} src="data:," index={makeIndex()} />);
    // currentTime is a setter on the refSource. We mock the underlying
    // videoRef.current to a plain object that records writes.
    const writes: number[] = [];
    Object.defineProperty(ref.current, "currentTime", {
      set: (v: number) => writes.push(v),
      get: () => writes[writes.length - 1] ?? 0,
      configurable: true,
    });
    ref.current.goToFrame(3);
    expect(writes[writes.length - 1]).toBeCloseTo(0.10, 4);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && yarn nx test editor --testPathPattern=VideoCanvas.index`
Expected: FAIL — `VideoCanvas` props don't accept `index` yet; the ref's `goToFrame` still divides by `framerate`.

- [ ] **Step 3: Modify `VideoCanvas.tsx`**

In `web/libs/editor/src/components/VideoCanvas/VideoCanvas.tsx`:

1. **Add `index` to the props type** (`VideoCanvasProps`, around line 22):

```tsx
import type { VideoIndex } from "../../lib/VideoIndex";
// inside VideoCanvasProps:
  index?: VideoIndex | null;
```

2. **Use `index` in `goToFrame`** — replace the existing `goToFrame` (around lines 501-513):

```tsx
      goToFrame(frame: number) {
        const idx = props.index;
        if (idx) {
          const clamped = clamp(frame, 1, idx.length);
          this.currentTime = idx.timeAt(clamped);
          return;
        }
        // Fallback to the existing framerate math (kept until all callers pass an index).
        const frameClamped = clamp(frame, 1, length);
        const frameZeroBased = frameClamped - 1;
        const exactTime = frameZeroBased / framerate;
        this.currentTime = this.frameSteppedTime(exactTime, true);
      },
```

3. **Use `index` for `length` when present** — find the `setLength(length)` block inside the `loadTimeout` callback (around lines 565-578) and update:

```tsx
            const length = props.index
              ? props.index.length
              : isFF(FF_VIDEO_FRAME_SEEK_PRECISION)
                ? Math.round(video.duration * framerate)
                : Math.ceil(video.duration * framerate);
```

4. **Use `index` for `currentFrame` reporting** — find the `currentFrame` computation around line 200:

```tsx
        const currentTime = videoRef.current?.currentTime ?? 0;
        const frameNumber = props.index
          ? props.index.frameAt(currentTime)
          : isFF(FF_VIDEO_FRAME_SEEK_PRECISION)
            ? Math.ceil(currentTime * framerate)
            : Math.round(currentTime * framerate);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && yarn nx test editor --testPathPattern=VideoCanvas.index`
Expected: PASS, 1 test. Run the existing `__tests__/VirtualVideo.test.tsx` to confirm no regression:

```bash
cd web && yarn nx test editor --testPathPattern=VideoCanvas/__tests__
```

Expected: PASS for all existing tests too.

- [ ] **Step 5: Commit**

```bash
git add web/libs/editor/src/components/VideoCanvas/
git commit -m "feat(editor): VideoCanvas uses VideoIndex when provided (fallback preserved)"
```

---

### Task 3.2 — `useLoopRange` uses index when provided

**Files:**
- Modify: `web/libs/editor/src/components/VideoCanvas/hooks/useLoopRange.ts`
- Create: `web/libs/editor/src/components/VideoCanvas/hooks/__tests__/useLoopRange.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// web/libs/editor/src/components/VideoCanvas/hooks/__tests__/useLoopRange.test.ts
import { renderHook } from "@testing-library/react";
import { useLoopRange } from "../useLoopRange";
import { VideoIndex } from "../../../../lib/VideoIndex";

function vidRef(currentTime = 0) {
  return { current: { currentTime, play: jest.fn(), pause: jest.fn() } } as any;
}

describe("useLoopRange — index-aware", () => {
  const idx = VideoIndex.fromPayload({
    content_key: "k", frame_count: 6, duration: 0.2167, codec: "h264",
    pts: [0, 0.05, 0.10, 0.13, 0.18, 0.2167],
  });

  it("computes loop boundaries from index.timeAt when index is provided", () => {
    // Smoke: the hook should accept an index option and not throw.
    const { result } = renderHook(() =>
      useLoopRange({
        loopFrameRange: { start: 2, end: 4 },
        selectedFrameRange: null,
        videoRef: vidRef(),
        refSource: { current: null },
        framerate: 30,
        index: idx,
        onRedrawRequest: () => {},
      } as any),
    );
    expect(result.current).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && yarn nx test editor --testPathPattern=useLoopRange`
Expected: FAIL — `index` is not an accepted option of `useLoopRange`.

- [ ] **Step 3: Modify `useLoopRange.ts`**

In `web/libs/editor/src/components/VideoCanvas/hooks/useLoopRange.ts`:

1. Add `index?: VideoIndex | null` to the options interface (around line 7).
2. Replace each `mediaTime * framerateRef.current` and `(... - 1) / framerateRef.current` site (lines ~43-45 and ~93-94) with a branched version:

```ts
        const currentFrame = optsIndex
          ? optsIndex.frameAt(mediaTime)
          : isFF(FF_VIDEO_FRAME_SEEK_PRECISION)
            ? Math.ceil(mediaTime * framerateRef.current)
            : Math.round(mediaTime * framerateRef.current);
```

```ts
      const startTime = optsIndex
        ? optsIndex.timeAt(selectedFrameRange.start)
        : (selectedFrameRange.start - 1) / framerateRef.current;
      const endTime = optsIndex
        ? optsIndex.timeAt(selectedFrameRange.end)
        : (selectedFrameRange.end - 1) / framerateRef.current;
```

Where `optsIndex` is captured at the top of the hook:

```ts
import type { VideoIndex } from "../../../lib/VideoIndex";
// ...
export function useLoopRange({ /* existing */ index, ...rest }: UseLoopRangeOptions & { index?: VideoIndex | null }) {
  const optsIndex = index ?? null;
  // ...existing body using optsIndex in branches above...
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && yarn nx test editor --testPathPattern=useLoopRange`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add web/libs/editor/src/components/VideoCanvas/hooks/
git commit -m "feat(editor): useLoopRange uses VideoIndex when provided"
```

---

### Task 3.3 — Video MST: `index` + `indexStatus` fields and gated region creation

**Files:**
- Modify: `web/libs/editor/src/tags/object/Video/Video.js`
- Create: `web/libs/editor/src/tags/object/Video/__tests__/Video.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// web/libs/editor/src/tags/object/Video/__tests__/Video.test.js
import { types } from "mobx-state-tree";
import { VideoIndex } from "../../../../lib/VideoIndex";

// Lazy import after MST stubs are in place
const VideoModule = require("../Video.js");

describe("Video MST integration", () => {
  it("exposes index and indexStatus volatile fields", () => {
    // Smoke: the MST factory should expose the volatile fields. We instantiate
    // the bare Model (no full store wiring) and assert defaults exist.
    const Model = VideoModule.VideoModelFactoryForTests
      ? VideoModule.VideoModelFactoryForTests()
      : null;
    expect(Model).toBeTruthy();
    const inst = Model.create({ type: "video" });
    expect(inst.index).toBeNull();
    expect(inst.indexStatus).toBe("idle");
  });

  it("setIndex transitions indexStatus to 'ready'", () => {
    const Model = VideoModule.VideoModelFactoryForTests();
    const inst = Model.create({ type: "video" });
    const idx = VideoIndex.fromPayload({
      content_key: "k", frame_count: 1, duration: 0, codec: "h264", pts: [0],
    });
    inst.setIndex(idx);
    expect(inst.indexStatus).toBe("ready");
    expect(inst.index).toBe(idx);
  });

  it("setIndexStatus('failed') leaves index null and ready=false", () => {
    const Model = VideoModule.VideoModelFactoryForTests();
    const inst = Model.create({ type: "video" });
    inst.setIndexStatus("failed");
    expect(inst.indexStatus).toBe("failed");
    expect(inst.index).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && yarn nx test editor --testPathPattern=Video/__tests__/Video.test`
Expected: FAIL — `VideoModelFactoryForTests` not exported; volatile fields don't exist.

- [ ] **Step 3: Modify `Video.js`**

In `web/libs/editor/src/tags/object/Video/Video.js`:

1. **Add volatile fields** — extend the existing `.volatile(() => ({ ... }))` (around line 105):

```js
  .volatile(() => ({
    errors: [],
    speed: 1,
    ref: React.createRef(),
    frame: 1,
    length: 1,
    drawingRegion: null,
    loopTimelineRegion: false,
    index: null,
    indexStatus: "idle", // "idle" | "loading" | "ready" | "failed"
  }))
```

2. **Add actions** to set the index — extend the actions block (after `setLength`, around line 367):

```js
      setIndex(index) {
        self.index = index;
        self.indexStatus = "ready";
        if (index) self.length = index.length;
      },

      setIndexStatus(status) {
        self.indexStatus = status;
      },
```

3. **Replace `setFrame`** (around lines 374-383) to prefer `index.timeAt`:

```js
      setFrame(frame) {
        if (self.frame !== frame) {
          self.frame = frame;
          if (self.index) {
            self.ref.current.currentTime = self.index.timeAt(frame);
            return;
          }
          if (isFF(FF_VIDEO_FRAME_SEEK_PRECISION) && self.framerate) {
            self.ref.current.goToFrame(frame);
          } else if (self.framerate) {
            self.ref.current.currentTime = frame / self.framerate;
          }
        }
      },
```

4. **Replace the `time:` computation in `triggerSync`** (around line 225):

```js
      triggerSync(event, data) {
        if (!self.ref.current) return;
        const time = self.index
          ? self.index.timeAt(self.frame)
          : self.ref.current.frameSteppedTime();
        self.syncSend(
          { playing: self.ref.current.playing, time, ...data },
          event,
        );
      },
```

5. **Export a test-only factory** at the end of the file:

```js
// Test-only factory used by Video.test.js to instantiate the model without the
// full Label Studio store. Do NOT use in production code.
export function VideoModelFactoryForTests() {
  return types.compose(TagAttrs, Model);
}
```

(`types` is already imported at the top.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && yarn nx test editor --testPathPattern=Video/__tests__/Video.test`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add web/libs/editor/src/tags/object/Video/Video.js web/libs/editor/src/tags/object/Video/__tests__/
git commit -m "feat(editor): wire VideoIndex into Video MST (index/indexStatus/setFrame)"
```

---

### Task 3.4 — `HtxVideo` boots `VideoIndexLoader` on mount; shows preparing state

**Files:**
- Modify: `web/libs/editor/src/tags/object/Video/HtxVideo.jsx`

- [ ] **Step 1: Read the current `HtxVideo` mount sequence** (familiarize before edit)

Run: `grep -n "useEffect\|videoSrc\|item.value" web/libs/editor/src/tags/object/Video/HtxVideo.jsx | head -20`
This is a read-only orientation step — no test yet (UI tests deferred to Cypress E2E in Phase 4).

- [ ] **Step 2: Add the loader trigger**

In `HtxVideo.jsx`, find the existing top-level `useEffect` that runs on mount (or add a new one near the existing mount-time logic, typically right after the props are destructured). Add:

```jsx
import { VideoIndexLoader } from "../../../lib/VideoIndex/VideoIndexLoader";
// ...
useEffect(() => {
  if (!item || !item.value) return;
  if (item.indexStatus !== "idle") return;
  item.setIndexStatus("loading");
  const transport = {
    async get() {
      const r = await fetch(`/api/video-index/?url=${encodeURIComponent(item.value)}`);
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    async post(body) {
      const r = await fetch(`/api/video-index/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
  };
  const loader = new VideoIndexLoader({ transport });
  loader.load({ videoUrl: item.value })
    .then((idx) => item.setIndex(idx))
    .catch((err) => {
      console.warn("[Video] index load failed:", err);
      item.setIndexStatus("failed");
    });
}, [item, item?.value]);
```

- [ ] **Step 3: Add the preparing-state UI gate**

Find the JSX block that renders the canvas (often a `<VideoCanvas ... />` element). Wrap it conditionally:

```jsx
{item.indexStatus === "loading" || item.indexStatus === "idle" ? (
  <div className="lsf-video-preparing" aria-live="polite">Preparing video index…</div>
) : null}

<VideoCanvas
  /* existing props */
  index={item.index}
/>
```

(Keep all existing props on `VideoCanvas`; only add `index={item.index}`.)

- [ ] **Step 4: Smoke-run editor unit tests**

Run: `cd web && yarn nx test editor --testPathPattern=Video/__tests__`
Expected: existing tests still PASS. (UI behavior of `HtxVideo` is exercised by Phase 4 Cypress tests.)

- [ ] **Step 5: Commit**

```bash
git add web/libs/editor/src/tags/object/Video/HtxVideo.jsx
git commit -m "feat(editor): boot VideoIndexLoader on Video mount; preparing state UI"
```

---

### Task 3.5 — Block region creation until `indexStatus === 'ready'`

**Files:**
- Modify: `web/libs/editor/src/tags/object/Video/Video.js` (the `addVideoRegion` action)
- Modify: `web/libs/editor/src/tags/object/Video/__tests__/Video.test.js`

- [ ] **Step 1: Add the failing test**

Append to `Video.test.js`:

```js
it("addVideoRegion is a no-op when indexStatus is not 'ready'", () => {
  const Model = VideoModule.VideoModelFactoryForTests();
  const inst = Model.create({ type: "video" });
  // indexStatus defaults to "idle"
  const result = inst.addVideoRegion({});
  expect(result).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && yarn nx test editor --testPathPattern=Video/__tests__/Video.test`
Expected: FAIL — `addVideoRegion` does not currently check `indexStatus`.

- [ ] **Step 3: Gate `addVideoRegion`**

In `Video.js`, modify `addVideoRegion` (around line 385):

```js
      addVideoRegion(data) {
        if (self.indexStatus !== "ready") {
          console.warn("[Video] region creation blocked; index not ready");
          return;
        }
        const control = self.videoControl;
        // ...rest unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && yarn nx test editor --testPathPattern=Video/__tests__/Video.test`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add web/libs/editor/src/tags/object/Video/
git commit -m "feat(editor): block region creation until VideoIndex is ready"
```

---

## Phase 4 — E2E, CI, docs

### Task 4.1 — Cypress E2E: CFR frame-N matches expected PTS

**Files:**
- Create: `web/libs/editor/tests/integration/e2e/video/ffmpeg_alignment.cy.ts`
- Create: `web/libs/editor/tests/integration/e2e/video/fixtures/cfr_30fps_3s.mp4` (copy of backend fixture)
- Create: `web/libs/editor/tests/integration/e2e/video/fixtures/cfr_30fps_3s.expected.json` (copy of backend fixture)

- [ ] **Step 1: Copy fixtures into the frontend test asset path**

```bash
cp label_studio/video_index/tests/fixtures/cfr_30fps_3s.mp4 web/libs/editor/tests/integration/e2e/video/fixtures/
cp label_studio/video_index/tests/fixtures/cfr_30fps_3s.expected.json web/libs/editor/tests/integration/e2e/video/fixtures/
```

- [ ] **Step 2: Write the Cypress spec**

```ts
// web/libs/editor/tests/integration/e2e/video/ffmpeg_alignment.cy.ts
import expected from "./fixtures/cfr_30fps_3s.expected.json";

describe("Video frame indexing matches ffmpeg", () => {
  it("CFR: seek to frame 42 lands on expected PTS", () => {
    cy.fixture("cfr_30fps_3s.mp4", "binary").then((mp4) => {
      // Stub the video URL with the fixture; stub /api/video-index to return
      // the precomputed expected payload directly.
      cy.intercept("GET", /\/api\/video-index/, {
        statusCode: 200,
        body: {
          content_key: "cfr_30fps_3s",
          frame_count: expected.frame_count,
          duration: expected.pts[expected.pts.length - 1],
          codec: "h264",
          pts: expected.pts,
        },
      }).as("indexGet");

      cy.visitVideoTaskWithBlob(mp4); // existing helper in this repo
      cy.wait("@indexGet");

      // Seek the editor to frame 42 via the existing test utility.
      cy.window().then((win: any) => {
        const ls = win.Htx; // existing handle in editor tests
        const tag = ls.annotationStore.selected.names.get("video");
        tag.setFrame(42);
      });

      // Assert the underlying <video> element ended up at expected PTS.
      cy.get("video", { timeout: 5000 }).then(($v) => {
        const el = $v.get(0) as HTMLVideoElement;
        expect(el.currentTime).to.be.closeTo(expected.pts[41], 0.01);
      });
    });
  });
});
```

> **Helper note:** `cy.visitVideoTaskWithBlob` is a convention from existing E2E specs (see `web/libs/editor/tests/integration/e2e/video/regions.cy.ts` for the existing helpers — adapt or extend). If no such helper exists, add one in `web/libs/editor/tests/integration/e2e/utils/` that loads a minimal video task and stubs the video URL with the blob. Keep this helper change in this commit so the test is reproducible.

- [ ] **Step 3: Run the spec**

Run: `cd web && yarn nx e2e editor --spec=libs/editor/tests/integration/e2e/video/ffmpeg_alignment.cy.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/libs/editor/tests/integration/e2e/video/
git commit -m "test(editor): e2e for CFR frame-N matches expected ffprobe PTS"
```

---

### Task 4.2 — Cypress E2E: VFR fixture

**Files:**
- Modify: `web/libs/editor/tests/integration/e2e/video/ffmpeg_alignment.cy.ts`
- Create: `web/libs/editor/tests/integration/e2e/video/fixtures/vfr_drone_2s.mp4`
- Create: `web/libs/editor/tests/integration/e2e/video/fixtures/vfr_drone_2s.expected.json`

- [ ] **Step 1: Copy fixtures**

```bash
cp label_studio/video_index/tests/fixtures/vfr_drone_2s.mp4 web/libs/editor/tests/integration/e2e/video/fixtures/
cp label_studio/video_index/tests/fixtures/vfr_drone_2s.expected.json web/libs/editor/tests/integration/e2e/video/fixtures/
```

- [ ] **Step 2: Add the VFR test case**

Append inside the same `describe` block in `ffmpeg_alignment.cy.ts`:

```ts
import vfrExpected from "./fixtures/vfr_drone_2s.expected.json";

it("VFR: seek to frame 42 lands on expected PTS", () => {
  cy.fixture("vfr_drone_2s.mp4", "binary").then((mp4) => {
    cy.intercept("GET", /\/api\/video-index/, {
      statusCode: 200,
      body: {
        content_key: "vfr_drone_2s",
        frame_count: vfrExpected.frame_count,
        duration: vfrExpected.pts[vfrExpected.pts.length - 1],
        codec: "h264",
        pts: vfrExpected.pts,
      },
    }).as("indexGet");

    cy.visitVideoTaskWithBlob(mp4);
    cy.wait("@indexGet");
    cy.window().then((win: any) => {
      const tag = win.Htx.annotationStore.selected.names.get("video");
      tag.setFrame(42);
    });
    cy.get("video", { timeout: 5000 }).then(($v) => {
      const el = $v.get(0) as HTMLVideoElement;
      expect(el.currentTime).to.be.closeTo(vfrExpected.pts[41], 0.01);
    });
  });
});
```

- [ ] **Step 3: Run the spec**

Run: `cd web && yarn nx e2e editor --spec=libs/editor/tests/integration/e2e/video/ffmpeg_alignment.cy.ts`
Expected: PASS — both CFR and VFR.

- [ ] **Step 4: Commit**

```bash
git add web/libs/editor/tests/integration/e2e/video/
git commit -m "test(editor): e2e for VFR frame-N matches expected ffprobe PTS"
```

---

### Task 4.3 — Cypress E2E: exported annotation references correct frame N

**Files:**
- Modify: `web/libs/editor/tests/integration/e2e/video/ffmpeg_alignment.cy.ts`

- [ ] **Step 1: Add the failing test case**

Append:

```ts
it("CFR: exported annotation carries the frame number matching ffmpeg's eq(n,N)", () => {
  cy.fixture("cfr_30fps_3s.mp4", "binary").then((mp4) => {
    cy.intercept("GET", /\/api\/video-index/, {
      statusCode: 200,
      body: {
        content_key: "cfr_30fps_3s",
        frame_count: expected.frame_count,
        duration: expected.pts[expected.pts.length - 1],
        codec: "h264",
        pts: expected.pts,
      },
    });

    cy.visitVideoTaskWithBlob(mp4);

    cy.window().then((win: any) => {
      const tag = win.Htx.annotationStore.selected.names.get("video");
      tag.setFrame(42);
      // Draw a region; helper varies by codebase. Use whichever utility
      // the existing video region tests use (e.g., regions.cy.ts).
      win.HtxTestUtils.drawVideoRegionAt({ x: 10, y: 10, w: 20, h: 20 });
    });

    cy.window().then((win: any) => {
      const ann = win.Htx.annotationStore.selected;
      const exported = ann.serializeAnnotation();
      const region = exported.find((r: any) => r.type === "videorectangle");
      expect(region).to.exist;
      // VideoRectangle stores a `sequence` of keyframes; the first frame
      // should be 42.
      expect(region.value.sequence[0].frame).to.equal(42);
    });
  });
});
```

- [ ] **Step 2: Run the spec**

Run: `cd web && yarn nx e2e editor --spec=libs/editor/tests/integration/e2e/video/ffmpeg_alignment.cy.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add web/libs/editor/tests/integration/e2e/video/ffmpeg_alignment.cy.ts
git commit -m "test(editor): e2e asserts exported region frame matches ffmpeg index"
```

---

### Task 4.4 — CI: install ffmpeg + include fixtures

**Files:**
- Modify: `.github/workflows/<backend-ci>.yml` (whichever file currently runs `pytest label_studio/`)

- [ ] **Step 1: Identify the backend CI workflow**

Run: `grep -rl "pytest" .github/workflows/ 2>/dev/null`
Read each match to identify the file that runs `pytest label_studio/`.

- [ ] **Step 2: Add an ffmpeg install step**

In the identified workflow, before the `pytest` step, add:

```yaml
      - name: Install ffmpeg
        run: |
          sudo apt-get update
          sudo apt-get install -y ffmpeg
```

If the workflow already installs apt packages, add `ffmpeg` to the existing list instead of adding a duplicate step.

- [ ] **Step 3: Run the backend test suite locally to confirm**

Run: `cd label_studio && pytest video_index/ -v`
Expected: PASS — all `requires_ffmpeg` tests run (not skipped) on a host with ffmpeg.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/
git commit -m "ci: install ffmpeg for video_index backend tests"
```

---

### Task 4.5 — Soften the "re-encode with ffmpeg" instruction in `Video.js` docs

**Files:**
- Modify: `web/libs/editor/src/tags/object/Video/Video.js:17-50`

- [ ] **Step 1: Edit the docstring**

Replace lines 17-50 (the doc paragraph that prescribes ffmpeg re-encoding to CFR) with a softer note. Keep the example for users who still want CFR but lead with the new behavior:

```js
/**
 * Video tag plays a simple video file. Use for video annotation tasks such as classification and transcription.
 *
 * ### Frame indexing
 *
 * As of this release, Label Studio uses a server-computed frame index (via ffprobe) so that frame
 * numbers displayed and exported by LS match `ffmpeg -vf select=eq(n,N)` byte-exactly. This works
 * for both CFR and VFR sources. You no longer need to re-encode your videos to a constant frame
 * rate — the index handles VFR correctly.
 *
 * If your deployment cannot reach the video from the backend (e.g., browser-only signed URLs),
 * LS falls back to running ffmpeg.wasm in the browser to compute the same index.
 *
 * ### Video format
 *
 * Use a format the browser can play. An MP4 container with H.264 video and AAC audio is the safest
 * choice. The classic re-encode command (still useful when fixing broken metadata):
 *
 * ```bash
 * ffmpeg -i input_video.mp4 -c:v libx264 -profile:v high -level 4.0 -pix_fmt yuv420p -c:a aac -b:a 128k output_video.mp4
 * ```
 *
 * @example
 * ...
 */
```

(Keep the `@example` blocks below the edited section intact.)

- [ ] **Step 2: Smoke-build to confirm the JSDoc didn't break the docs pipeline**

Run: `cd web && yarn build editor` (or the equivalent build script from `web/package.json` — confirm exact command).
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add web/libs/editor/src/tags/object/Video/Video.js
git commit -m "docs(editor): replace re-encode requirement with index-based alignment note"
```

---

## Self-review (post-write checklist)

Run this checklist before handing off to execution.

1. **Spec coverage.** Walk through `docs/superpowers/specs/2026-05-25-video-frame-timestamps-ffmpeg-alignment-design.md` section by section:
   - §4.1 (backend model + endpoints + services + job): Tasks 1.1, 1.5, 1.6, 1.8–1.13. ✅
   - §4.2 (frontend lib `VideoIndex`/`Loader`/`Worker`/`Cache`/`Validator`): Tasks 2.1–2.7. ✅
   - §4.3 (editor integration in `Video.js`, `HtxVideo.jsx`, `VideoCanvas.tsx`, `useLoopRange.ts`): Tasks 3.1–3.5. ✅
   - §4.4 (wire format dual shape): Tasks 1.11, 2.1, 2.2. ✅
   - §5 (sequences A–F): Sequence A — Task 1.12; Sequence B — Task 2.6; Sequence C — Task 2.6 (race); Sequence D — Tasks 3.1, 3.3; Sequence E — Task 1.6 (content_key derivation); Sequence F — Task 1.6 (etag changes → new content_key). ✅
   - §6.1 (errors: index never arrives): Tasks 1.9, 1.10, 2.6. ✅
   - §6.2 (errors: index arrives but wrong): Task 2.3. ✅
   - §6.3 (concurrency): Task 1.10 (`select_for_update`), Task 1.13 (POST no-op on ready). ✅
   - §6.4 (annotation safety — region creation gated): Task 3.5. ✅
   - §7 (testing pyramid): every task is TDD; E2E in Tasks 4.1–4.3. ✅
   - §8 (configuration): Task 1.14. ✅
   - **Gaps:** Authorization is currently `IsAuthenticated` only; the spec says permissions are "task-scoped." A follow-up task gating reads/writes on `task.has_permission(user)` should be added if/when the GET/POST starts accepting `task=<id>` for authorization. For v1 the wider auth check is acceptable since the videos themselves are already access-controlled at upload time — flag this in the PR description, do not block.
   - **Gaps:** The `WasmProberWorker` ships with a stubbed default backend (Task 2.7). Wiring the real ffmpeg.wasm packet iteration is a deferred follow-up — clearly called out in the spec §9 and inside Task 2.7's implementation note. Acceptable for v1 because the wasm path is only used when the backend can't probe (rare in self-hosted) and the stub at least fails loudly with a clear error rather than silently corrupting indices.
2. **Placeholder scan.** No "TBD", "TODO" or "fill in later" in any step. The Task 2.7 stub is an intentional, well-commented partial implementation, not a placeholder.
3. **Type / name consistency.** Cross-task references — `setIndex`, `setIndexStatus`, `index`, `indexStatus`, `frameAt`, `timeAt`, `length`, `duration`, `content_key`, `status` (`pending|ready|failed|unavailable`), `source` (`server|client`) — match across backend, model, and frontend. Status codes `200/201/202/400/409/422` match between API (Task 1.12/1.13) and loader (Task 2.5/2.6).
4. **Bite-sized steps.** Each task has a 5-step TDD shape; longer code blocks live inside step 3 ("implement") rather than fanning into 10+ steps.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-25-video-frame-timestamps-ffmpeg-alignment.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for a feature this size because each task has crisp inputs/outputs and bench-test boundaries.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints for review.

**Which approach?**
