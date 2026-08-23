#!/usr/bin/env bash
# Compatibility entry point for the old test command. The real harness uses
# GNOME 50's supported in-process automation API and fails on assertion errors.
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec make -C "$TESTS_DIR/.." test
