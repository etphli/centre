#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .runtime/swift-tmp
TMPDIR="$PWD/.runtime/swift-tmp" swift test --disable-sandbox --scratch-path .runtime/swift-build --package-path ios
