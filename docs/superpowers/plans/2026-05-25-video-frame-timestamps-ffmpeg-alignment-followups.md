# Video frame timestamps — follow-ups

Tracking the deliberately-deferred work from the implementation plan
`docs/superpowers/plans/2026-05-25-video-frame-timestamps-ffmpeg-alignment.md`.

Each item below is real and worth doing, but does not block the
foundation PR. Coverage in unit + integration tests already exercises
every layer (83 tests passing across pytest + Jest).

## 1. Cypress E2E for ffmpeg alignment

**Plan tasks deferred:** 4.1, 4.2, 4.3.

**Why deferred:** The plan's Cypress code used generic
`cy.visit`/`cy.intercept`/`cy.window` style. The existing Cypress
suite under `web/libs/editor/tests/integration/e2e/video/` uses the
custom helper library `@humansignal/frontend-test/helpers/LSF/index`
(e.g., `LabelStudio.params().config(...).data(...).init()`). Wiring
the plan's tests to that helper library is a separate, modestly-sized
task that needs someone fluent in those helpers.

**Suggested test outline when picked up:**

1. **CFR alignment:** load a task that points at
   `cfr_30fps_3s.mp4` (copy from
   `label_studio/video_index/tests/fixtures/`), stub
   `/api/video-index/` to return the precomputed
   `cfr_30fps_3s.expected.json` payload, seek to frame 42, assert
   `videoEl.currentTime` matches `expected.pts[41]` within 1e-2.
2. **VFR alignment:** same with `vfr_drone_2s.mp4` +
   `vfr_drone_2s.expected.json`.
3. **Exported region carries correct frame N:** draw a video region
   at frame 42 (via the existing `VideoView.drawRectRelative` helper),
   serialize the annotation, assert the region's first keyframe is
   `frame: 42`.

**Files to add:**

- `web/libs/editor/tests/integration/e2e/video/ffmpeg_alignment.cy.ts`
- Copies of the two MP4 fixtures and their `.expected.json` siblings
  under `web/libs/editor/tests/integration/e2e/video/fixtures/`.

## 2. Real ffmpeg.wasm wiring inside `WasmProberWorker`

**Plan task partially deferred:** end of Task 2.7.

**Why deferred:** `web/libs/editor/src/lib/VideoIndex/WasmProberWorker.ts`
ships an injectable `WasmBackend` interface and a `defaultBackend`
that throws a clear error. The actual demux loop using
ffmpeg.wasm — extracting PTS from packets without decoding frames —
is its own piece of work and deserves its own design pass (which
ffmpeg.wasm build, message-passing protocol, error mapping). The unit
test in `WasmProberWorker.test.ts` validates the contract via an
injected mock backend, which is enough to keep the rest of the
system testable.

**Suggested approach when picked up:**

- Reuse the ffmpeg.wasm artifact already pulled in by the
  `AudioUltra` audio decoder
  (`web/libs/editor/src/lib/AudioUltra/Media/AudioDecoder.ts`).
- Inside a web worker, run `ffmpeg.run("-i", videoUrl, "-c", "copy",
  "-f", "null", "-")` with `-loglevel` set so frame-level diagnostics
  can be parsed back. Better: use the WASM module directly to iterate
  packets, mirroring the `ffprobe -show_packets` shape the server
  uses.
- Map the worker's response to the `WasmProbeRaw` shape; the existing
  `probeWithWasm()` already wraps that into a `DensePayload`.

## 3. Task-scoped permissions on `/api/video-index/`

**Spec mentioned this in §10's "Files touched" but the implemented
API uses `permission_classes = [IsAuthenticated]` only.**

The spec describes "Permission scoped to task access" for both GET
and POST. The current implementation accepts any authenticated user
because the simplest path forward did not require resolving the
task's project membership. For v1 this is acceptable — video URLs
are already access-controlled at upload time — but a tighter check
is desirable.

**Suggested change when picked up:**

- Parse the `task=<id>` query parameter / POST field, look up the
  task, and check
  `task.project.has_permission(request.user)` (the same pattern
  `io_storages` uses, e.g.,
  `label_studio/io_storages/base_models.py:703`).
- Reject `403 Forbidden` when the user can't access the task.
- Decide whether the `task` parameter should become required.

## 4. GC of stale `VideoIndex` rows

**Spec §9.**

When the only task referencing a `content_key` is deleted (or
re-uploaded with a new etag → new content_key), the old `VideoIndex`
row becomes orphaned. Disk cost is small per row but unbounded over
time. Add a periodic cleanup job that prunes rows whose
`content_key` is no longer referenced by any task.

## 5. Mount `/api/video-index/` in production URLconf

The test settings include `video_index.urls` via
`label_studio/video_index/tests/_urls.py`. The real
`label_studio/core/urls.py` was NOT updated (deferred from Task 1.12)
to avoid stepping on the project's URL ordering. When picked up:

```python
# label_studio/core/urls.py, alongside the other include() lines:
re_path(r'^', include('video_index.urls')),
```

And register the app in production INSTALLED_APPS — already done in
Task 1.1 — so this is a one-line addition.

## 6. SSE/WebSocket push for `pending → ready` transition

**Spec §9.**

The frontend currently polls `GET /api/video-index/` every ~1 second
while a row is `pending`. Pushing the `ready` event over WebSocket
(via the existing label_studio channels setup, if any) would lower
load and shorten worst-case wait. v1 polling is fine.

---

Last updated: 2026-05-26.
