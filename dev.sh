#!/usr/bin/env bash
set -euo pipefail

# Give each server its own process group so cleanup includes its children.
set -m

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

server_pids=()
cleanup() {
    trap - EXIT INT TERM
    for pid in "${server_pids[@]}"; do
        kill -TERM -- "-$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Starting backend..."
(cd "$project_dir/backend" && exec cargo run --locked) &
server_pids+=("$!")

echo "Starting frontend..."
(cd "$project_dir/frontend" && exec npm run dev) &
server_pids+=("$!")

cat <<'EOF'

ExitZero development checklist (wait for both servers to finish starting)

1. Open the app:
   http://127.0.0.1:5173
   Expected: dashboard and floor plan; header shows "Backend online".
   If the backend is still compiling, click Retry once it starts.

2. Check the backend directly:
   http://127.0.0.1:3001/api/health
   Expected: {"status":"ok","service":"exitzero"}

3. Check the frontend's API proxy:
   http://127.0.0.1:5173/api/health
   Expected: the same health JSON.

4. Test the simulation API from another terminal:
EOF
printf '   curl -i http://127.0.0.1:5173/api/simulate -H '\''Content-Type: application/json'\'' --data-binary @%q\n' "$project_dir/shared/examples/building.json"
cat <<'EOF'
   Currently expected: HTTP 501 with code "not_implemented".
   The simulation engine is still a stub.

Other API endpoints (POST JSON, not browser pages):
   http://127.0.0.1:5173/api/stress-test
   http://127.0.0.1:5173/api/optimize
   These also return 501 for valid requests until implemented.

Use port 5173 for the app. Port 3001 serves only API routes;
opening http://127.0.0.1:3001/ returns "route not found".

Press Ctrl+C to stop both servers.

EOF
# If either server exits, stop the other and preserve the exit status.
wait -n "${server_pids[@]}"
