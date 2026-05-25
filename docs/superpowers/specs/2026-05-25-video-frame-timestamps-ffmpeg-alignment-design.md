# Video frame timestamps — ffmpeg alignment

**Status:** Design approved, pending implementation
**Date:** 2026-05-25
**Author:** brainstormed with Rick (rick@ultralytics.com)
**Scope:** Replace browser-derived video frame indexing in the Label Studio editor with a content-addressed, ffprobe-derived frame index so that annotations produced in LS use the same frame numbering as `ffmpeg -vf select=eq(n,N)`.

---

## 1. Problem

Label Studio's Video tag derives frame numbers from the HTML `<video>` element:

- `frame = round(videoEl.currentTime * framerate)` — `framerate` is a static attribute on the `<Video>` tag (defaults to `24`).
- `videoEl.currentTime` snaps to ~2 ms (`BROWSER_TIME_PRECISION = 0.002`) and is further constrained by the browser's keyframe seek behavior.
- Total frame count is `round(videoEl.duration * framerate)`, where `duration` is browser-reported and can disagree with the container's video stream duration (audio tail, metadata quirks).

Consequences:

- For variable-frame-rate (VFR) videos, "frame N" in LS has no defined relationship to `ffmpeg -vf select=eq(n,N)`. Frames diverge from the very start.
- For constant-frame-rate (CFR) videos with a misdeclared `framerate` attribute, frames drift over time.
- The existing docs in `web/libs/editor/src/tags/object/Video/Video.js:24-50` push the burden onto users by telling them to re-encode every video with ffmpeg before uploading. This design removes that burden.

**Goal:** When LS displays "frame N", that N is the exact same N as `ffmpeg -vf select=eq(n,N)` for the same video. The same N appears in exported annotations.

## 2. Non-goals

- **Pixel-exact display.** LS will continue to use the HTML `<video>` element to draw pixels. The displayed pixels may differ from `ffmpeg -vf select=eq(n,N)` by the browser's seek error. Only the frame *index/timestamp* mapping is guaranteed correct.
- **Migration of existing annotations.** Per scope decision, this is a fresh-start design. Old annotations are out of scope.
- **GC of stale index rows.** Logged as a TODO; not implemented in the first cut.
- **Live/streaming sources.** Index requires a complete, finite file.

## 3. Constraints from scope

| Constraint | Value |
|---|---|
| Alignment depth | Index/timestamp only (not pixel-exact) |
| Frame rate support | VFR + CFR |
| Execution model | Hybrid — server ffmpeg preferred, ffmpeg.wasm fallback |
| Migration | Fresh start, no remap of existing annotations |
| Development methodology | Test-driven (red → green → refactor) |

## 4. Architecture

Three layers communicating through a single wire format. The index is content-addressed so two tasks (or two annotators) referencing the same video reuse the same computed index.

### 4.1 Backend — `label_studio/video_index/`

A new Django app.

**Model — `VideoIndex`:**

| Field | Type | Notes |
|---|---|---|
| `content_key` | `CharField(40)`, primary key | `sha1(resolved_url + etag_or_last_modified)`; URL-only fallback when no validators exist. |
| `pts_blob` | `BinaryField` | Delta-encoded varint bytes. Header byte selects ms vs μs units. CFR shorthand form `{fps, count}` is encoded as a flagged short blob. |
| `frame_count` | `IntegerField` | |
| `duration` | `FloatField` | seconds |
| `codec` | `CharField(32)` | |
| `width`, `height` | `IntegerField` | |
| `status` | `CharField` | `pending` \| `ready` \| `failed` \| `unavailable` |
| `error` | `TextField, blank=True` | ffprobe stderr or resolver error |
| `source` | `CharField` | `server` \| `client` |
| `created_at`, `updated_at` | `DateTimeField` | |

**HTTP API — `/api/video-index/`:**

| Endpoint | Behavior |
|---|---|
| `GET /api/video-index/?url=<url>&task=<id>` | When row is `ready`: `200 {…payload…}`. When row exists with `status=pending`: `202 {status: "pending", content_key}`. When no row exists yet: server creates the row with `status=pending`, enqueues `compute_video_index`, returns `202 {status: "pending", content_key}` (no 404 ever leaves the endpoint). When row is `unavailable`: `409 {status: "unavailable", error}`. When row is `failed`: `422 {status: "failed", error}`. Permission scoped to task access. |
| `POST /api/video-index/` | Accepts client-computed index `{content_key, pts, frame_count, duration, codec, width, height}`. Writes/updates row with `source=client, status=ready`. If row already `ready`, returns `200 {already_ready: true}` and discards body. If row `pending`, cancels Celery task and accepts client result. Permission scoped to task access. |

**Services:**

- `services.codec.PtsCodec` — `encode(pts: list[float]) -> bytes`, `decode(bytes) -> list[float]`. Delta + zigzag varint. Header byte: bit 0 = unit (0=ms, 1=μs), bit 1 = CFR shorthand flag. CFR shorthand body is two varints: `fps_x1000`, `count`.
- `services.resolver.VideoUrlResolver` — Given `(task, raw_url)`, returns `ResolvedUrl(canonical_url, etag_or_lm, can_backend_fetch)`. Reuses existing `io_storages` for S3/GCS/Azure signed URLs.
- `services.probe.FfprobeProber` — `probe(canonical_url) -> ProbeResult(pts, codec, width, height)`. Wraps `ffprobe -show_packets -select_streams v:0 -of json -v error`. Configurable timeout (default 120 s). Raises `FfmpegNotInstalled`, `UnreachableUrl`, `NoVideoStream`, `ProbeFailed(stderr)`.

**Celery task — `tasks.compute_video_index(content_key)`:**

1. Acquire serialization on `content_key`: DB `SELECT … FOR UPDATE` (or a Redis lock when running against backends that don't honor row-level locks well). Either is acceptable; pick one and document it in the implementation plan.
2. If row is already `ready`, return immediately.
3. Resolve URL, run prober.
4. Encode pts, update row with `status=ready`. On failure: set `status` per error class (`unavailable` vs `failed`) with `error` populated.

Idempotent: re-running on a `ready` row is a no-op. This is the cancellation mechanism — see §6.3.

### 4.2 Frontend — `web/libs/editor/src/lib/VideoIndex/`

A new library.

| Component | Responsibility |
|---|---|
| `VideoIndex` (class) | In-memory index. Methods: `frameAt(time): number` (1-based, binary search), `timeAt(frame): number`, `length: number`, `duration: number`. Two backings sharing the same interface: dense array (VFR) or `{fps, count}` shorthand (CFR). |
| `VideoIndexLoader` | Orchestrates fetch. Returns `Promise<VideoIndex>` plus a progress event stream. Implements Sequences A–C below. |
| `WasmProberWorker` | Web worker. Boots ffmpeg.wasm, demuxes the video, emits `pts[]`. Reuses the wasm artifact already shipped for `AudioUltra` where binary-compatible (see `web/libs/editor/src/lib/AudioUltra/Media/AudioDecoder.ts`). |
| `VideoIndexCache` | IndexedDB store keyed by `content_key`. Read-through; write on success from either path. |
| `PayloadValidator` | Validates payloads from server and from wasm before they become a `VideoIndex`. Rejects empty, non-monotonic, or malformed; flags (warning, not error) `frame_count !== pts.length`. |

### 4.3 Frontend integration points (modifications)

| File | Change |
|---|---|
| `web/libs/editor/src/tags/object/Video/Video.js` | Add volatile fields `index: VideoIndex \| null`, `indexStatus: 'idle'\|'loading'\|'ready'\|'failed'`. Replace `framerate * time` math (current refs: `Video.js:225`, `Video.js:380`) with `self.index.frameAt(time)` / `self.index.timeAt(frame)`. `framerate` attribute kept as a presentation hint only; warn once if it disagrees with probed value. |
| `web/libs/editor/src/tags/object/Video/HtxVideo.jsx` | Show preparing state while `indexStatus !== 'ready'`. Trigger `VideoIndexLoader` on mount. |
| `web/libs/editor/src/components/VideoCanvas/VideoCanvas.tsx` | Accept `index` prop. `goToFrame(n) → videoRef.currentTime = index.timeAt(n)`. `currentFrame` getter → `index.frameAt(videoRef.currentTime)`. `length → index.length`. Remove `BROWSER_TIME_PRECISION` rounding in the index-aware code path — the index is the precision. |
| `web/libs/editor/src/components/VideoCanvas/hooks/useLoopRange.ts` | Same swap — `mediaTime * framerate` → `index.frameAt(mediaTime)`. |

### 4.4 Wire format

VFR (dense):
```json
{
  "content_key": "ab12…",
  "frame_count": 1234,
  "duration": 41.13,
  "codec": "h264",
  "width": 1920, "height": 1080,
  "pts": [0.0, 0.0333, 0.0667, …]
}
```

CFR (shorthand):
```json
{
  "content_key": "ab12…",
  "frame_count": 1234,
  "duration": 41.13,
  "codec": "h264",
  "width": 1920, "height": 1080,
  "cfr": { "fps": 29.97 }
}
```

Frontend handles both via `VideoIndex.fromPayload(payload)`. The serializer decodes `pts_blob` from storage into the `pts` array (or `cfr` shorthand object) before sending; the wire format is always JSON, the binary blob never leaves the server.

## 5. Data flow

### Sequence A — Happy path (server-side ffmpeg, video reachable)

```
HtxVideo mounts
  → VideoIndexLoader.load(videoUrl, taskId)
  → GET /api/video-index/?url=…&task=…
      ├─ 200 → VideoIndex.fromPayload → MST .index = idx → "ready"
      └─ 202 (or 404 → enqueued → 202)
            → poll every ~1 s
            → server: compute_video_index runs ffprobe, writes row ready
            → next poll → 200 → ready
```

### Sequence B — Backend can't fetch (browser-only signed URL, air-gapped backend)

```
GET → 409 unavailable
  → dispatch WasmProberWorker(videoUrl)
  → worker boots ffmpeg.wasm, emits pts[]
  → frontend POSTs /api/video-index/ with result (best-effort)
  → VideoIndexCache.put(content_key, payload)
  → MST .index = idx → "ready"
```

### Sequence C — Slow server probe (parallel race)

```
GET keeps returning 202 longer than WASM_FALLBACK_TIMEOUT_MS (default 10 s)
  → dispatch WasmProberWorker in parallel
  → whichever finishes first wins
  → the other's result is discarded
  → if server wins after wasm dispatched, worker is terminated
```

### Sequence D — User seeks (steady state)

```
User drags timeline to frame N
  → Video MST.setFrame(N) → VideoCanvas.goToFrame(N)
  → videoRef.currentTime = index.timeAt(N)       # exact PTS, not N/fps
  → browser fires timeupdate at currentTime ≈ pts[N]
  → VideoCanvas reads currentTime → displayed = index.frameAt(currentTime)
  → UI shows N; exported annotation frame === N
```

### Sequence E — Multiple tasks share a video

Two tasks referencing the same resolved URL hit the same `content_key` row. Probe runs once.

### Sequence F — Video replaced (etag changed)

New `content_key` → new row → fresh probe. Stale IndexedDB cache entries are skipped because their key no longer matches.

## 6. Error handling

### 6.1 Index never arrives

| Scenario | Backend response | Frontend behavior |
|---|---|---|
| ffmpeg not installed | Row written `status=unavailable, error="ffmpeg binary not found"`. Subsequent GETs `409`. | Dispatch wasm fallback immediately (no polling). |
| Backend can't reach URL (network, auth) | Prober raises `UnreachableUrl`; status=`unavailable`. | Wasm fallback. |
| ffprobe runs but errors | status=`failed`, stderr in `error`. | Do not wasm-fallback — same binary would likely fail. Show error in annotator UI: "Video index could not be built: <reason>. Annotations disabled." |
| Celery dead / queue stuck | Polling exceeds `WASM_FALLBACK_TIMEOUT_MS`. | Dispatch wasm fallback in parallel. |
| Wasm fallback also fails | n/a | Terminal error UI. Annotation disabled. Existing Sentry link surfaced. |

### 6.2 Index arrives but is wrong

| Scenario | Detection | Behavior |
|---|---|---|
| `pts.length === 0` | `PayloadValidator` | Treated as `failed`. |
| Non-monotonic pts | `PayloadValidator` (`pts[i] >= pts[i-1]`) | `failed`; Sentry log with `content_key`. |
| `frame_count !== pts.length` | `PayloadValidator` | Warning only; `pts.length` wins. |
| `videoEl.duration` differs from `index.duration` by more than the longest inter-frame gap in the index (or 50 ms, whichever is larger) | Loader on first `loadedmetadata` | Console warning; index wins. This is the bug being fixed. Threshold chosen so genuine codec-vs-container drift logs once, but normal browser-PTS jitter doesn't spam warnings. |
| Probed codec is incompatible with the browser | Existing `canPlayUrl` flow | Existing modal; index load wasted but harmless. |

### 6.3 Concurrency

| Scenario | Behavior |
|---|---|
| Two annotators open same task, no index yet | DB `SELECT … FOR UPDATE` (or Redis lock) on `content_key`. Second request sees `pending`, polls. Probe runs once. |
| Wasm POST while server `ready` | Server returns `{already_ready: true}`. Client refetches the server's copy for consistency. |
| Wasm POST while server `pending` | Server accepts the POST inside the same `content_key` lock used by the Celery task, writes `ready, source=client`. When the in-flight Celery task finishes its probe and reaches step 2 (re-checks status), it sees `ready` and returns without overwriting. No explicit task cancellation needed; the locking + idempotency make it safe. |
| Stale IndexedDB cache, file replaced | HEAD on open to refresh etag; `content_key` mismatch → bypass cache. |

### 6.4 Annotation safety

**Hard rule:** Region creation is disabled when `indexStatus !== 'ready'`. Prevents the failure mode where an annotator labels frames using the browser's wrong indexing while the real index is still loading. `IsReadyMixin` is extended to gate on `indexStatus`.

### 6.5 Logging

- Server: existing Django/Sentry pipeline. One structured log per probe: `content_key`, duration_ms, source, status, ffprobe_time_ms.
- Client: existing error reporter. One event per `failed` outcome and per validation warning.
- No PII. URLs hashed to `content_key` at info-level; full URL only at debug.

## 7. Testing — TDD throughout

Every component below gets a failing test FIRST, then implementation. Red → green → refactor.

### 7.1 Test pyramid

```
┌──────────────────────────────────┐
│   E2E (Cypress, ~3 tests)        │  Task open → seek → export
├──────────────────────────────────┤
│   Integration (~10-15 tests)     │  API endpoints; wasm worker against
│                                  │  real fixtures; MST + canvas wired
├──────────────────────────────────┤
│   Unit (~30-40 tests)            │  PtsCodec, VideoIndex, Prober, Resolver,
│                                  │  VideoIndexLoader, validation rules
└──────────────────────────────────┘
```

### 7.2 Backend unit (`label_studio/video_index/tests/`)

| File | Tests written first |
|---|---|
| `test_pts_codec.py` | round-trip CFR; round-trip VFR; CFR shorthand detection; ms vs μs header; monotonicity preserved; empty array; single frame; deltas larger than varint max |
| `test_resolver.py` | local path; S3 signed; GCS signed; Azure SAS; URL with etag; URL with last-modified only; URL with neither (URL-only key); unreachable URL flagged |
| `test_ffprobe_prober.py` (marker: `requires_ffmpeg`) | CFR fixture; VFR fixture; audio-only → `NoVideoStream`; corrupt fixture → `ProbeFailed` with stderr; subprocess timeout |
| `test_compute_video_index_task.py` | success writes ready row; ffmpeg-not-installed writes `unavailable`; unreachable writes `unavailable`; corrupt writes `failed`; idempotent re-run; DB lock serializes concurrent enqueues |
| `test_api.py` | GET 200/202/404/409 matrix; POST overwrites pending → ready; POST rejected without task access; throttle kicks in; serializer emits CFR shorthand when applicable |

### 7.3 Frontend unit (`web/libs/editor/src/lib/VideoIndex/__tests__/`)

| File | Tests |
|---|---|
| `VideoIndex.test.ts` | `frameAt(time)` binary search VFR correctness; boundary frames; `timeAt(frame)` round-trip; CFR shorthand backing matches dense; out-of-range clamps; length; duration |
| `PayloadValidator.test.ts` | empty pts rejected; non-monotonic rejected; frame_count/length mismatch flagged; valid CFR shorthand accepted; missing content_key rejected |
| `VideoIndexLoader.test.ts` | 200 returns index; 202 polls then resolves; 409 dispatches wasm; timeout dispatches wasm in parallel; race winner correct; wasm result POSTed back; failed validation rejects load |
| `VideoIndexCache.test.ts` | put/get round trip; stale entry skipped on etag change; quota-exceeded eviction; concurrent writes resolve cleanly |

### 7.4 Frontend integration

| File | Tests |
|---|---|
| `VideoCanvas.test.tsx` (extend existing) | `goToFrame(N) → videoEl.currentTime = index.timeAt(N)`, NOT `N/framerate`; `currentFrame` uses `index.frameAt(currentTime)`; `length` from `index.length`; loop range uses index; no `BROWSER_TIME_PRECISION` refs remain on the index-aware path |
| `Video.test.js` (new) | MST exposes `index`, `indexStatus`; region creation blocked when not `ready`; framerate-attr disagreement warned; index disposed on task switch |
| `WasmProberWorker.test.ts` | Against three real fixtures (CFR, VFR, audio-only), worker emits expected pts; worker timeout enforced; worker terminates cleanly on cancel |

### 7.5 E2E (`web/libs/editor/tests/integration/e2e/video/`)

| File | Test |
|---|---|
| `ffmpeg_alignment.cy.ts` | (1) load task with CFR fixture, seek to frame 42, assert displayed frame === 42 AND `videoEl.currentTime === expected_pts[42]`; (2) same with VFR fixture; (3) export annotation and assert exported frame matches precomputed expected JSON for `ffmpeg -vf select=eq(n,42)` (no ffmpeg spawned at test time) |

### 7.6 Fixtures (`label_studio/video_index/tests/fixtures/`)

Three small (< 1 MB) MP4s, each with a committed expected JSON:

- `cfr_30fps_3s.mp4` + `.expected.json` — 90 frames, uniform PTS
- `vfr_drone_2s.mp4` + `.expected.json` — irregular PTS (the worst case)
- `audio_only.mp4` — no video stream
- `corrupt_truncated.mp4` — header valid, packets truncated

Fixtures generated once with ffmpeg; expected JSON generated by running ffprobe and committed alongside. CI asserts correctness from JSON without needing ffmpeg installed. `test_ffprobe_prober.py` is the only suite gated on the `requires_ffmpeg` marker.

### 7.7 CI

- Backend job: install `ffmpeg` on the test runner image; `requires_ffmpeg` mark for graceful skip elsewhere.
- Frontend job: include new fixtures in the test asset path.

### 7.8 Performance smoke (non-gating)

One test probes a 60-min CFR fixture (generated on the fly, not committed) and asserts a wall-clock budget. Initial budget loose; tightened once we have a baseline.

## 8. Configuration

| Setting | Default | Notes |
|---|---|---|
| `VIDEO_INDEX_FFPROBE_PATH` | `ffprobe` | Override for non-PATH installations. |
| `VIDEO_INDEX_PROBE_TIMEOUT_SECONDS` | `120` | Server-side ffprobe subprocess timeout. |
| `VIDEO_INDEX_WASM_FALLBACK_TIMEOUT_MS` | `10000` | Frontend timeout before dispatching wasm fallback in parallel. |
| `VIDEO_INDEX_POLL_INTERVAL_MS` | `1000` | GET poll cadence while `pending`. |
| `VIDEO_INDEX_MAX_PAYLOAD_BYTES` | `5_000_000` | Server caps POSTs from wasm; above this, return `413` and rely on server-side compute. |

## 9. Open follow-ups (explicitly deferred)

- **GC of stale `VideoIndex` rows** when no task references their `content_key`. Tracked separately. Out of scope for v1.
- **SSE / WebSocket push for ready notification** in place of polling. Polling is fine for v1.
- **Pixel-exact display** via ffmpeg.wasm decoding. Not a goal here.
- **Migration tool for existing annotations.** Not needed per scope decision (fresh start).

## 10. Files touched (summary)

**New:**
- `label_studio/video_index/` (app: `models.py`, `services/{codec,resolver,probe}.py`, `tasks.py`, `api.py`, `serializers.py`, `urls.py`, `apps.py`, `migrations/`, `tests/`)
- `web/libs/editor/src/lib/VideoIndex/` (`VideoIndex.ts`, `VideoIndexLoader.ts`, `WasmProberWorker.ts`, `VideoIndexCache.ts`, `PayloadValidator.ts`, `__tests__/`)
- `web/libs/editor/tests/integration/e2e/video/ffmpeg_alignment.cy.ts`
- Test fixtures under `label_studio/video_index/tests/fixtures/`

**Modified:**
- `web/libs/editor/src/tags/object/Video/Video.js`
- `web/libs/editor/src/tags/object/Video/HtxVideo.jsx`
- `web/libs/editor/src/components/VideoCanvas/VideoCanvas.tsx`
- `web/libs/editor/src/components/VideoCanvas/hooks/useLoopRange.ts`
- `label_studio/core/settings/` (register the new app, add config keys)
- `label_studio/urls.py` (mount `/api/video-index/`)
- CI workflow files (ffmpeg install, fixture paths)
