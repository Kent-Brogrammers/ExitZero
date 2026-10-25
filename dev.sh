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
   Expected: ExitZero Studio welcome page. Open Studio to edit the floor plan.
   Settings shows "Backend online". If it is still compiling, retry there once ready.

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
   Expected: HTTP 200 with computed metrics, animation frames, traffic, and analytics.

Other API endpoints (POST JSON, not browser pages):
   http://127.0.0.1:5173/api/simulate/live
   Body: BuildingScenario. Streams live frames and the completed recording as NDJSON.
   http://127.0.0.1:5173/api/stress-test
   Body: {"building": BuildingScenario, "config": {"max_scenarios": 10,
          "block_each_exit": true, "obstruction_candidates": []}}
   Expected: HTTP 200 with baseline metrics and ranked failure scenarios.
   http://127.0.0.1:5173/api/optimize
   Body: {"building": BuildingScenario, "max_candidates": 10}
   Expected: HTTP 200 with baseline metrics and improving layout candidates.
   BuildingScenario means the full building object, not a quoted string.

Use port 5173 for the app. Port 3001 serves only API routes;
opening http://127.0.0.1:3001/ returns "route not found".

Press Ctrl+C to stop both servers.

EOF
# If either server exits, stop the other and preserve the exit status.
# Poll because macOS ships Bash 3.2, which has no wait -n.
while true; do
    for pid in "${server_pids[@]}"; do
        if ! kill -0 "$pid" 2>/dev/null; then
            if wait "$pid"; then
                exit 0
            else
                exit "$?"
            fi
        fi
    done
    sleep 0.2
done
