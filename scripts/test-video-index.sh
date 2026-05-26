#!/usr/bin/env bash
# Run video_index tests inside the ls-test:min Docker image.
# Usage: scripts/test-video-index.sh [pytest args]
#   e.g. scripts/test-video-index.sh video_index/tests/test_pts_codec.py -v
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

exec docker run --rm \
  -v "${REPO_ROOT}":/app \
  -w /app/label_studio \
  -e DJANGO_SETTINGS_MODULE=video_index.tests._settings \
  ls-test:min \
  pytest -p no:cacheprovider "$@"
