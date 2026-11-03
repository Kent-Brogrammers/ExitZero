#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

for command in cargo node npm; do
    if ! command -v "$command" >/dev/null 2>&1; then
        echo "Missing required command: $command" >&2
        exit 1
    fi
done

if [[ ! -d "$project_dir/frontend/node_modules" ]]; then
    echo "Installing frontend dependencies..."
    (cd "$project_dir/frontend" && npm ci)
fi

# The shared launcher discovers the bound backend port before starting Vite.
exec node "$project_dir/frontend/dev.mjs" "$@"
