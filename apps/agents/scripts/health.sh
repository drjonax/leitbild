#!/usr/bin/env bash
set -euo pipefail

agents_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$agents_root"

bun run check
bun run type-coverage --strict --ignore-catch --at-least 98

echo 'Agents health checks passed.'
