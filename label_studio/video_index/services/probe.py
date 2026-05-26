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
        ffprobe_path: str | None = None,
        timeout_seconds: int | None = None,
    ) -> None:
        from django.conf import settings as _settings
        self.ffprobe_path = ffprobe_path or _settings.VIDEO_INDEX_FFPROBE_PATH
        self.timeout_seconds = (
            timeout_seconds if timeout_seconds is not None else _settings.VIDEO_INDEX_PROBE_TIMEOUT_SECONDS
        )

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

        pts.sort()

        return ProbeResult(pts=pts, codec=codec, width=width, height=height)
