#!/usr/bin/env bash
# Run Jest unit tests for the editor library.
# Usage: scripts/test-frontend.sh [jest args]
#   e.g. scripts/test-frontend.sh libs/editor/src/lib/VideoIndex/__tests__/VideoIndex.test.ts
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${REPO_ROOT}/web"

exec node_modules/.bin/jest --config libs/editor/jest.config.js "$@"
