# ExitZero

A local building evacuation simulator workspace for a four-person hackathon team. The foundation includes a React dashboard, a Rust API, shared contracts, and runnable tests. **Simulation, stress testing, and optimization are not implemented.** Their endpoints validate requests and return structured HTTP `501` errors.

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
  editor/              Developer 1: floor-plan editor
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
  examples/            Valid 30×20 building and explicitly synthetic fixture
```

Keep implementation changes inside your workstream. Review changes to `models/`, `types/`, schemas, examples, dependencies, and `App.tsx` together. Use branches such as `codex/building-editor`, `codex/simulation-engine`, `codex/stress-testing`, and `codex/analytics-integration`.

The dependency direction is `api → feature modules → models`. Stress testing and optimization can call `simulation::simulate(&BuildingScenario) -> Result<SimulationResult, SimulationError>`. The simulation module does not depend on either feature module.

## API

All bodies and property names use JSON and snake_case. Computation requests require `Content-Type: application/json`.

| Method | Endpoint           | Request                                                                         | Current response                                   |
| ------ | ------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------- |
| GET    | `/api/health`      | None                                                                            | `200 {"status":"ok","service":"exitzero"}`         |
| POST   | `/api/simulate`    | `BuildingScenario`                                                              | Validated, then `501`; future `SimulationResult`   |
| POST   | `/api/stress-test` | `{building, config: {max_scenarios, block_each_exit, blocked_cell_candidates}}` | Validated, then `501`; future `StressTestResult`   |
| POST   | `/api/optimize`    | `{building, max_candidates}`                                                    | Validated, then `501`; future `OptimizationResult` |

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

- Coordinates are integer cells with origin at the top left; x increases right and y down. Dimensions are 1–512 each. Exit IDs are unique, nonblank strings of at most 64 characters; exits occupy distinct boundary cells. Walls, doors, and exits must not overlap. A doorway replaces a wall cell; doors are walkable.
- Spawn zones are nonoverlapping, positive-size rectangles within the building. Each has positive `count`, distributed across valid cells, with at most one initial occupant per cell. Walls, blocked cells, and exits cannot be spawn cells. Total population is at most 10,000. Empty population scenarios are not accepted by computation endpoints.
- `blocked_exit_ids` references existing exits. Coordinate lists and blocked ID lists contain no duplicates. All exits may be blocked for a stress scenario.
- `seed` is a nonnegative JavaScript-safe integer (at most `9007199254740991`); `max_steps` is 1–100,000. Stress tests and optimization accept budgets of 1–100 scenarios/candidates. Stress configuration must enable exit blocking or supply cell candidates (at most 100 unique, in-bounds cells).
- Schema validation enforces shapes and ranges. Rust request validation additionally checks geometry, IDs, overlaps, and spawn capacity. Cross-field rules cannot all be expressed in ordinary JSON Schema; validating only the schema is insufficient for running a scenario.
- `evacuated + remaining = total_population`; `trapped` is a subset of `remaining`. `completed` requires zero remaining and a non-null `clearance_steps`. `incomplete` (cannot fully evacuate) and `timeout` (step budget reached) require positive remaining and null clearance. Never interpret a missing clearance as zero.
- Frames contain `step` and `agents: [{id, x, y}]`; steps strictly increase and agent IDs are unique within a frame. `cell_visits[y * width + x]` is accumulated traffic, with exactly `width * height` entries. It is not instantaneous crowd density.
- Stress results contain baseline metrics and scenario IDs, descriptions, **additional** blocker modifications, metrics, rank, and severity. Rank 1 is worst; ties may share a rank. Compare remaining occupants first, trapped occupants second, then clearance steps (null sorts worse than measured clearance). The shared `compare_severity` helper encodes that order. Nick will define severity label thresholds with the stress-testing implementation.

The read-only Canvas shows `shared/examples/building.json`: 30×20, two exits, two spawn zones, 34 occupants. The optional **mock analytics preview** uses `simulation.mock.json`, a separate synthetic 4×3 fixture with two occupants. Those mock numbers do not describe the displayed building and never come from a computation endpoint.

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
| Developer 1 | Add wall, door, exit, and spawn editing                               | Render engine frames with playback controls                     |
| Connor      | Add deterministic occupant spawning and grid navigation               | Implement evacuation ticks, stopping rules, frames, and metrics |
| Nick        | Generate blocked-exit/obstruction scenarios and rank real simulations | Evaluate bounded layout improvement candidates                  |
| Developer 4 | Build result metrics and accumulated-traffic heatmaps                 | Add scenario comparison and end-to-end demo tests               |

Use the checked-in example and mock fixture while features are developed independently. Replace only your module's explicit stub when ready, and test integration against the shared contracts before merging.

Library references: [Axum](https://docs.rs/axum/latest/axum/), [Vite](https://vite.dev/guide/), [Vitest](https://vitest.dev/guide/), and [Recharts](https://recharts.github.io/en-US/api/).
