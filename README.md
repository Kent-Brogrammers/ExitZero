# ExitZero

A local freeform building evacuation simulator workspace for a four-person hackathon team. The foundation includes an interactive Canvas floor-plan editor, a React dashboard, a Rust API, shared contracts, and runnable tests. **Simulation, stress testing, and optimization are not implemented.** Their endpoints validate requests and return structured HTTP `501` errors.

## Run locally

Install a current stable Rust toolchain with Cargo, rustfmt, and Clippy, plus **Node.js 24 LTS and npm**. Node 22.12+ or 26 also works. Docker, databases, authentication, and external APIs are not needed.

In one terminal, from the repository root:

```sh
cd backend
cargo run --locked
```

In another:

```sh
cd frontend
npm ci
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The header should show **Backend online**. If the backend starts later, use **Retry**.

The API binds to `127.0.0.1:3001`. Vite proxies `/api` to it and requires port `5173` to be available. The frontend defaults to `/api`; override its public API base URL when needed:

```sh
VITE_API_BASE_URL=http://127.0.0.1:3001/api npm run dev
```

For production builds, provide that variable to `npm run build` instead; Vite embeds it at build time. `npm run preview` serves the built frontend and does not use the development proxy, so use a direct API base URL and configure backend CORS for your chosen preview origin before testing that mode. The initial CORS allowlist covers only `http://localhost:5173` and `http://127.0.0.1:5173`.

## Structure and ownership

```text
frontend/src/
  editor/              Developer 1: freeform floor-plan editor
  simulation/          Developer 1: Canvas playback
  analytics/           Developer 4: charts and scenario comparison
  services/            Developer 4: typed API client and integration tests
  types/               Shared TypeScript contracts and schema tests
  App.tsx              Shared dashboard integration
backend/src/
  api/                 Shared Axum routes and error mapping
  models/              Shared Rust contracts and validation
  simulation/          Connor: simulation engine
  stress_testing/      Nick: scenario generation and evaluation
  optimization/        Nick: candidate layout comparison
backend/tests/         API and contract integration tests
shared/
  schemas/             JSON Schema definitions for requests and responses
  examples/            Valid 30×20 m building and explicitly synthetic fixture
```

Keep implementation changes inside your workstream. Review changes to `models/`, `types/`, schemas, examples, dependencies, and `App.tsx` together. Use branches such as `[name]/building-editor`, `[name]/simulation-engine`, `[name]/stress-testing`, and `[name]/analytics-integration`.

The dependency direction is `api → feature modules → models`. Stress testing and optimization can call `simulation::simulate(&BuildingScenario) -> Result<SimulationResult, SimulationError>`. The simulation module does not depend on either feature module.

## API

All bodies and property names use JSON and snake_case. Computation requests require `Content-Type: application/json`.

| Method | Endpoint           | Request                                                                        | Current response                                   |
| ------ | ------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------- |
| GET    | `/api/health`      | None                                                                           | `200 {"status":"ok","service":"exitzero"}`         |
| POST   | `/api/simulate`    | `BuildingScenario`                                                             | Validated, then `501`; future `SimulationResult`   |
| POST   | `/api/stress-test` | `{building, config: {max_scenarios, block_each_exit, obstruction_candidates}}` | Validated, then `501`; future `StressTestResult`   |
| POST   | `/api/optimize`    | `{building, max_candidates}`                                                   | Validated, then `501`; future `OptimizationResult` |

Errors have the shape `{"error":{"code":"validation_error","message":"..."}}`. Invalid scenario semantics return `422`; JSON syntax, shape, and content-type errors preserve Axum's relevant `4xx` status with code `invalid_json`. Unimplemented computation returns `501` with code `not_implemented`. No fake results are returned. The frontend validates successful response shapes against the shared schemas and exposes `ApiError` with `status`, `code`, and `message`; network errors use status `0`.

From the repository root, with both servers running:

```sh
curl http://127.0.0.1:3001/api/health
curl http://127.0.0.1:5173/api/health
curl -i http://127.0.0.1:3001/api/simulate \
  -H 'Content-Type: application/json' \
  --data-binary @shared/examples/building.json
```

The first two return the same health JSON; the last returns `501`.

## Contracts

`shared/schemas/contracts.schema.json` uses JSON Schema draft 7. Its root validates a building; `$defs` contains every named API contract. Rust types live in `backend/src/models/`; matching TypeScript interfaces live in `frontend/src/types/simulation.ts`. Shared fixture tests exercise the same JSON on both sides. Keep all three contract representations in sync.

- Geometry uses finite, continuous metre coordinates: origin at the top left, x right, y down. Workspace extents are in `(0, 1000]` metres. There is no navigation grid or cell snapping. Element IDs are globally unique, nonblank strings of at most 64 characters.
- Walls have `id`, `start: {x, y}`, `end: {x, y}`, and `thickness`. They can run at any angle, must be at least 0.1 m long, and have thickness in `(0, 2]` m. Endpoints lie within the workspace; the visible wall stroke extends half its thickness on each side of the centreline.
- Doors and exits are openings `{id, wall_id, offset, width}`. Offset is the distance in metres from the wall's start to the beginning of the opening. The opening must fit along its wall; openings on the same wall cannot overlap. The editor cuts openings visually through walls. The engine must apply the same opening geometry for collisions and routing.
- Exits are attached to walls, including walls drawn inside the workspace extent. The workspace rectangle is a drawing extent, not the building boundary. Validation does not yet infer enclosed rooms or prove that an exit connects to outdoors; those topology checks belong to the simulation workstream.
- Spawn zones are axis-aligned rectangles `{id, x, y, width, height, count}` with positive dimensions/count and no overlap with walls, other spawn zones, or obstructions. `agent_radius` is in `(0, 2]` metres. Zones must fit the occupant diameter and have at least the summed area of occupant discs. This is a preliminary capacity check, not a packing guarantee: Connor's initialization must place occupants without collisions or return a meaningful placement error. Total population is at most 10,000.
- `obstructions` contains physical rectangles `{id, x, y, width, height}`. `blocked_exit_ids` references existing exits without duplicates. Stress configuration uses `obstruction_candidates`; each candidate is an additional rectangle evaluated against an unchanged baseline. Candidates must have unique IDs and individually pass building validation. Stress-result modifications use `added_obstructions` and additional `blocked_exit_ids`.
- `seed` is a nonnegative JavaScript-safe integer (at most `9007199254740991`); `max_steps` is 1–100,000. `time_step_seconds` is in `(0, 1]` and gives simulated time per frame step. Stress tests and optimization accept budgets of 1–100 scenarios/candidates. Limits are 500 walls, 1,000 doors, 1,000 exits, 100 spawn zones, and 100 obstructions.
- JSON Schema validates shapes and numeric ranges, including draft layouts with no exits or occupants. The editor also checks geometric relationships. Rust computation validation requires at least one exit and one spawn zone and checks bounds, references, opening overlap, spawn areas, and obstruction geometry. The schema alone is insufficient for running a layout.
- `evacuated + remaining = total_population`; `trapped` is a subset of `remaining`. `completed` requires zero remaining and non-null `clearance_steps`. `incomplete` and `timeout` require positive remaining and null clearance. Never interpret missing clearance as zero.
- Frames contain `step` and `agents: [{id, x, y}]`, with continuous agent positions. Steps strictly increase and agent IDs are unique per frame. Playback can interpolate positions between frames using `time_step_seconds`. `traffic_samples: [{x, y, visits}]` is a sparse collection of weighted world positions representing accumulated traffic, not instantaneous density; analytics can render these as a smooth heatmap. Result dimensions are metre extents.
- Stress results contain baseline metrics and scenario IDs, descriptions, additional blocker modifications, metrics, rank, and severity. Rank 1 is worst; ties may share a rank. Compare remaining occupants first, trapped occupants second, then clearance steps (null sorts worse than measured clearance). The shared `compare_severity` helper encodes that order. Nick will define severity thresholds during implementation.

## Edit a layout

The example is a 30×20 m workspace with angled and straight walls, two exits, two doorways, and two spawn zones containing 34 occupants.

- Choose **Wall** and drag to draw at any angle. Nearby endpoints snap together to help join walls; positions do not snap to a grid.
- Choose **Door** or **Exit** and click near a wall. Openings attach to that wall. Adjust their width and offset in the inspector.
- Choose **Spawn zone** or **Obstruction** and drag a rectangle. Select a spawn zone to set its occupant count.
- Use **Select / move** to drag elements. Drag a selected wall's endpoint to reshape it. Moving a wall carries its openings with it; deleting a wall removes its openings and stale blocked-exit references.
- Use the element dropdown and numeric inspector for precise coordinates and dimensions. Select an exit to toggle whether it is blocked. Invalid edits are rejected with an explanation.
- **Undo/Redo** restores up to 50 edits. Canvas keyboard shortcuts: Delete/Backspace removes the selection, Escape cancels a gesture/selection, and Ctrl/Cmd+Z undoes (Shift redoes).
- **New layout** creates an empty draft; **Load example** restores the sample. **Export JSON** saves the current layout locally; **Import JSON** loads a continuous-geometry layout under 2 MB. Draft layouts can be saved before exits and occupants are added. Layouts live in memory until exported.

API requests use the current edited layout. Computation buttons remain disabled until it has exits, occupants, and valid geometry. The three endpoints still return `501`; no movement, pathfinding, stress testing, or optimization algorithm has been implemented.

The optional **mock analytics preview** uses `simulation.mock.json`, a separate synthetic 4×3 m fixture with two occupants. Those numbers do not describe the edited building and never come from a computation endpoint.

## Verify

```sh
cd backend
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked
```

In `frontend/`:

```sh
npm run verify
```

This checks formatting, ESLint, mocked API/schema tests, strict TypeScript, and the production build. `npm run typecheck`, `npm test`, and `npm run lint` also run separately. Format changes with `cargo fmt` and `npm run format`. Commit `Cargo.lock` and `package-lock.json` for reproducible installs. Build outputs and installed dependencies are ignored.

## Next work

| Developer   | First feature                                                         | Following feature                                               |
| ----------- | --------------------------------------------------------------------- | --------------------------------------------------------------- |
| Developer 1 | Extend and harden freeform layout editing                             | Render engine frames with playback controls                     |
| Connor      | Add deterministic spawning and continuous-space navigation            | Implement evacuation ticks, stopping rules, frames, and metrics |
| Nick        | Generate blocked-exit/obstruction scenarios and rank real simulations | Evaluate bounded layout improvement candidates                  |
| Developer 4 | Build result metrics and world-space traffic heatmaps                 | Add scenario comparison and end-to-end demo tests               |

Use the checked-in example and mock fixture while features are developed independently. Replace only your module's explicit stub when ready, and test integration against the shared contracts before merging.

Library references: [Axum](https://docs.rs/axum/latest/axum/), [Vite](https://vite.dev/guide/), [Vitest](https://vitest.dev/guide/), and [Recharts](https://recharts.github.io/en-US/api/).
