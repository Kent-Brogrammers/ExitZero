# ExitZero

A local freeform building evacuation simulator for a four-person hackathon team. The Canvas editor, playback, analytics, and Rust API run real evacuation simulations, blocked-exit stress tests, and bounded opening-widening optimization. Results are exploratory, not certified building-safety predictions.

## Run locally

Install a current stable Rust toolchain with Cargo, rustfmt, and Clippy, plus **Node.js 24 LTS and npm**. Node 22.12+ or 26 also works. Docker, databases, authentication, and external APIs are not needed.

To start both servers from the repository root:

```sh
./dev.sh
```

The script installs frontend dependencies if `node_modules` is missing. Press Ctrl+C to stop both servers; if either server exits, the other stops too. The backend development profile optimizes the app crate while retaining debug symbols and incremental compilation; dependencies keep their usual development settings.

To measure compute time independently of the live view's real-time pacing, run `cargo run --manifest-path backend/Cargo.toml --locked --example benchmark_simulation` from the repository root. This runs the checked-in example with 30 occupants three times. Pass an output JSON path after `--` to save the first result for before/after comparison.

To run them separately, in one terminal:

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

**Run simulation** opens a live first run at normal speed. It shows elapsed simulation time and occupant counts without a predicted finish time. When the run ends, the recorded timeline opens at the end; rewind, step, or replay to review what happened.

Under **Settings → Agent awareness**, adjust sight range (default 8 m) and communication/yelling range (default 3 m). These settings are saved with the building. A range of 0 disables that behavior. Agents start with exit locations and assume doors and exits are open, including initially blocked exits. Their route maps do not start with the complete wall layout. They learn an opening's state by seeing it or receiving a nearby person's report.

Wall memory records only observed portions within sight range and clear sight lines. Seeing a sliver does not reveal the wall's hidden extent or endpoints, and separate visible patches do not fill an occluded gap. These fragments accumulate as people move; yelling shares the same observed fragments. Near occlusion boundaries, uncertain portions below a centimetre may be omitted rather than revealing hidden material. Route graphs use only remembered fragments and are rebuilt when new knowledge invalidates the current route or an opening changes.

Rectangular obstructions and circular emergency zones also enter each person's route map only after discovery. Visibility uses the nearest surface of an obstruction or hazard, so a large hazard can be noticed without seeing its centre. Yelling requires both range and a clear path: walls, closed doors, and obstructions block reports. Reports travel one hop per physics tick, and newer opening-state reports supersede stale ones. Dijkstra searches each person's belief map again when new information changes it. Actual collision checks always enforce the real world, even for an unseen blockage.

Agents reassess routes every two simulated seconds, with checks staggered across the crowd. Each observer estimates nearby people's motion from consecutive visible positions, smoothing speed and direction over roughly 0.6 seconds. As confidence builds over the first second of observation, routing blends current congestion with one-, two-, and three-second motion forecasts. Traffic flowing along the route costs less than slow or stopped traffic; opposing traffic receives no flow discount. Forecasts stop at remembered obstacles and remove predicted arrivals through believed available exits. Losing sight discards the motion estimate, and forecasts never alter real movement or population counts.

A congestion detour must remain materially better across repeated assessments before an agent switches. The saving must exceed 12% of current estimated cost and at least one agent diameter; turning back adds a further 1.75 seconds of walking cost. After changing routes, the agent commits for three simulated seconds before considering another congestion detour. Newly learned blockages or other geometry that invalidates the current route bypass this delay immediately. Newly available alternatives follow the normal confirmation rule. Waypoint shortcuts use the same forecast cost so they preserve useful detours. These are short-term motion estimates, not exact queue waiting-time predictions.

Exit routes target the usable span of each opening, with agent-radius and wall-thickness clearance at the jambs. People can approach different positions across a wide exit and evacuate side by side. Arrival is counted when an agent's centre reaches that span; narrow exits still require people to yield through ordinary crowd avoidance and collision checks. The exit plane applies equally to openings in horizontal, vertical, and angled walls, approached from either side.

Choose **Emergency scenario** in the editor: baseline evacuation, fire, gas leak, or tornado. Use **Place hazard on plan** to position its origin and adjust the radius. The darker core and outer exposure ring are shown on the plan. Fire and gas close doors and exits whose openings intersect the exposure area, including at the start of a run. Fire models a heat/smoke exposure area; gas uses a wider exposure footprint and a lower injury rate. Newly configured catastrophes enable spread or movement by default. Expand **Spread settings** or **Tornado movement settings** to tune the behavior or switch it off. Older layouts without dynamics retain their fixed footprints until enabled.

For a tornado, draw one or more **Tornado zones** with the new layout tool, outside the impact/exposure area. They are walkable shelter destinations, not obstacles. The alarm directs people toward these zones rather than exits. Arrival is recorded as sheltered, separately from evacuated; population totals include both. Shelter arrival abstracts admission into safety, rather than simulating occupancy or shelter capacity inside the zone.

The alarm sounds at the start of the run. Occupants know which response to take and know destination locations, but do not start with the hazard location. They discover danger through sight, physical exposure, or a nearby person's report, using the same visibility and one-hop communication rules as blocked openings. Discovered hazards add strong routing penalties and detour waypoints. Hazard footprints remain traversable so someone already inside can escape. Exposure is integrated over accepted movement and waiting time; injury accumulates gradually, lowers walking speed, and is displayed in orange/red. There are no deaths in this version. Injury levels and rates are illustrative simulation parameters, not medical or building-safety predictions.

The Rust `simulate_with_emergencies` entry point still supports its original static circular exclusion zones. The optional `disaster` and `tornado_zones` fields work through both normal and live simulation APIs, and are saved in layout JSON.

Fire and gas spread as connected circular patches, with seeded random branching and uneven radial growth. Controls set growth rate, new-patch interval, maximum patch count, and maximum patch radius. Gas defaults to faster growth and more frequent branching. Footprints are bounded by workspace extents; this approximation does not model fuel, airflow, diffusion through rooms, or wall-dependent fire spread. Overlapping patches contribute the strongest exposure rather than multiplying injury by patch count.

Tornado controls set travel speed, maximum turning speed, direction-change interval, and extra shelter clearance. A seeded wandering heading turns gradually; steering and braking avoid workspace edges and every tornado zone. Swept movement checks keep the full exposure radius, occupant body margin, and configured extra clearance outside shelters, including between physics ticks. The initial tornado location must also meet that clearance. The scenario random seed controls both repeatable hazards and occupant placement.

Every recorded frame includes the actual `disaster_state` footprints. Live viewing and rewind render those recorded states, with interpolation only between received samples. Agents remember individual sighted or reported patches and their revisions: unseen growth and tornado movement do not silently refresh their route maps. Danger updates can trigger a safety detour without waiting for the normal congestion commitment, while unchanged safe guidance is retained. Injury integrates relative person/hazard movement across each physics tick, and newly affected openings close once bodies clear them.

Building JSON can schedule runtime changes before the catastrophe system supplies them:

```json
{
  "awareness": { "sight_range_metres": 8, "communication_range_metres": 3 },
  "opening_events": [
    { "step": 100, "opening_id": "door_north", "blocked": true },
    { "step": 150, "opening_id": "door_north", "blocked": false }
  ]
}
```

These are optional fields on the existing `BuildingScenario`, not a separate request. Events reference door or exit IDs, are ordered by step, and occur before `max_steps`. Changes take effect at tick boundaries; a closure waits until occupants clear the opening rather than creating a wall inside them. Actual states are recorded in each frame's `blocked_opening_ids`, so live viewing and rewind display closures and reopenings at the corresponding time. Older recordings without this field retain their original layout behavior.

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

| Method | Endpoint           | Request                                                                        | Current response                                               |
| ------ | ------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| GET    | `/api/health`      | None                                                                           | `200 {"status":"ok","service":"exitzero"}`                     |
| POST   | `/api/simulate`    | `BuildingScenario`                                                             | `200 SimulationResult` with actual frames and traffic          |
| POST   | `/api/stress-test` | `{building, config: {max_scenarios, block_each_exit, obstruction_candidates}}` | `200 StressTestResult` with baseline and ranked scenarios      |
| POST   | `/api/optimize`    | `{building, max_candidates}`                                                   | `200 OptimizationResult` with baseline and strict improvements |

Errors have the shape `{"error":{"code":"validation_error","message":"..."}}`. Invalid scenario semantics and failed occupant placement return `422`; JSON syntax, shape, and content-type errors preserve Axum's relevant `4xx` status with code `invalid_json`. The frontend validates successful response shapes against the shared schemas and exposes `ApiError` with `status`, `code`, and `message`; network errors use status `0`.

The studio uses `POST /api/simulate/live` with a `BuildingScenario` body. Its `application/x-ndjson` response emits `SimulationStreamEvent` objects, one per line: `{type: "frame", frame}` during computation, followed by `{type: "complete", result}` containing the ordinary `SimulationResult` and recording. Errors after streaming starts use `{type: "error", error: {code, message}}`. Frames are paced by their simulated timestamps; disconnecting cancels the worker. The batch `/api/simulate` endpoint remains available to integrations.

From the repository root, with both servers running:

```sh
curl http://127.0.0.1:3001/api/health
curl http://127.0.0.1:5173/api/health
curl -i http://127.0.0.1:3001/api/simulate \
  -H 'Content-Type: application/json' \
  --data-binary @shared/examples/building.json
```

The first two return the same health JSON; the last returns `200` with computed metrics, animation frames, weighted traffic samples, and per-agent analytics.

## Contracts

`shared/schemas/contracts.schema.json` uses JSON Schema draft 7. Its root validates a building; `$defs` contains every named API contract. Rust types live in `backend/src/models/`; matching TypeScript interfaces live in `frontend/src/types/simulation.ts`. Shared fixture tests exercise the same JSON on both sides. Keep all three contract representations in sync.

- Geometry uses finite, continuous metre coordinates: origin at the top left, x right, y down. Workspace extents are in `(0, 1000]` metres. There is no navigation grid or cell snapping. Element IDs are globally unique, nonblank strings of at most 64 characters.
- Walls have `id`, `start: {x, y}`, `end: {x, y}`, and `thickness`. They can run at any angle, must be at least 0.1 m long, and have thickness in `(0, 2]` m. Endpoints lie within the workspace; the visible wall stroke extends half its thickness on each side of the centreline.
- Doors and exits are openings `{id, wall_id, offset, width}`. Offset is the distance in metres from the wall's start to the beginning of the opening. The opening must fit along its wall; openings on the same wall cannot overlap. Solid wall sections include their physical half-thickness and rounded end caps; discs must clear the full wall and jamb shapes. The editor renders the same solid sections, including disabled exits.
- Exits are attached to walls, including walls drawn inside the workspace extent. The workspace rectangle is a drawing extent, not the building boundary. Validation does not yet infer enclosed rooms or prove that an exit connects to outdoors; those topology checks belong to the simulation workstream.
- Spawn zones are axis-aligned rectangles `{id, x, y, width, height, count}` with positive dimensions/count and no overlap with walls, other spawn zones, or obstructions. `agent_radius` is in `(0, 2]` metres. Zones must fit the occupant diameter and have at least the summed area of occupant discs. This is a preliminary capacity check, not a packing guarantee: Connor's initialization must place occupants without collisions or return a meaningful placement error. Total population is at most 10,000.
- `obstructions` contains physical rectangles `{id, x, y, width, height}`. `blocked_exit_ids` references existing exits without duplicates. Stress configuration uses `obstruction_candidates`; each candidate is an additional rectangle evaluated against an unchanged baseline. Candidates must have unique IDs and individually pass building validation. Stress-result modifications use `added_obstructions` and additional `blocked_exit_ids`.
- `seed` is a nonnegative JavaScript-safe integer (at most `9007199254740991`); `max_steps` is 1–100,000. `time_step_seconds` is in `(0, 1]` and gives simulated time per frame step. Stress tests and optimization accept budgets of 1–100 scenarios/candidates. Limits are 500 walls, 1,000 doors, 1,000 exits, 100 spawn zones, and 100 obstructions.
- JSON Schema validates shapes and numeric ranges, including draft layouts with no exits or occupants. The editor also checks geometric relationships. Rust computation validation requires at least one exit and one spawn zone and checks bounds, references, opening overlap, spawn areas, and obstruction geometry. The schema alone is insufficient for running a layout.
- `evacuated + remaining = total_population`; `trapped` is a subset of `remaining`. `completed` requires zero remaining and non-null `clearance_steps`. `incomplete` and `timeout` require positive remaining and null clearance. Never interpret missing clearance as zero.
- Frames contain `step` and `agents: [{id, x, y}]`, with continuous agent positions. Steps strictly increase and agent IDs are unique per frame. Playback can interpolate positions between frames using `time_step_seconds`. `traffic_samples: [{x, y, visits}]` is a sparse collection of weighted world positions representing accumulated traffic, not instantaneous density; analytics can render these as a smooth heatmap. Result dimensions are metre extents.
- Stress results contain baseline metrics and scenario IDs, descriptions, additional blocker modifications, metrics, rank, and severity. Rank 1 is worst; ties may share a rank. Compare remaining occupants first, trapped occupants second, then clearance steps (null sorts worse than measured clearance). The shared `compare_severity` helper encodes that order. Severity labels are exploratory heuristics; incomplete runs remain distinct from measured full clearances.

## Edit a layout

The example is a 30×20 m workspace with angled and straight walls, two exits, two doorways, and two spawn zones containing 34 occupants.

- Choose **Wall** and drag to draw at any angle. Nearby endpoints snap together to help join walls; positions do not snap to a grid.
- Choose **Door** or **Exit** and click near a wall. Openings attach to that wall. Adjust their width and offset in the inspector.
- Choose **Spawn zone** or **Obstruction** and drag a rectangle. Select a spawn zone to set its occupant count.
- Use **Select / move** to drag elements. Drag a selected wall's endpoint to reshape it. Moving a wall carries its openings with it; deleting a wall removes its openings and stale blocked-exit references.
- Use the element dropdown and numeric inspector for precise coordinates and dimensions. Select an exit to toggle whether it is blocked. Invalid edits are rejected with an explanation.
- **Undo/Redo** restores up to 50 edits. Canvas keyboard shortcuts: Delete/Backspace removes the selection, Escape cancels a gesture/selection, and Ctrl/Cmd+Z undoes (Shift redoes).
- **New layout** creates an empty draft; **Load example** restores the sample. **Export JSON** saves the current layout locally; **Import JSON** loads a continuous-geometry layout under 2 MB. Draft layouts can be saved before exits and occupants are added. Layouts live in memory until exported.

API requests use the current edited layout. Computation buttons remain disabled until it has exits, occupants, and valid geometry. Run Simulation records actual movement; Analytics shows its metrics and a world-coordinate heatmap weighted by accumulated visits. Stress Test compares independently modified layouts against its own baseline.

Optimize evaluates a bounded set of valid door/exit widenings. Compare the ranked metrics and preview candidate geometry before applying a layout. Applying clears previous simulation/stress results; Run Simulation then measures the applied layout. The comparison retains the original optimization baseline. An empty candidate list means no strict improvement was found within the budget.

`simulation.mock.json` is a synthetic contract-test fixture. The optional synthetic playback preview is explicitly labeled and is separate from API computations.

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

## Simulation analytics handoff

Real simulation responses include optional `analytics` (older saved results and synthetic fixtures may omit it). The matching interfaces are `AgentStatistics` and `SimulationAnalytics` in `frontend/src/types/simulation.ts`.

- `analytics.agents` includes every initial occupant, joined to animation frames by `id`. `distance_metres` sums actual accepted movement at every physics tick, including detours, independently of sampled playback frames.
- `evacuation_step`, `evacuation_seconds`, and successful `exit_id` are null for occupants that did not evacuate. `elapsed_seconds` stops at evacuation or at the end of the run. Simulated seconds use `step * time_step_seconds`, not server runtime.
- `waiting_steps` counts ticks where collision checks rejected the proposed movement; `waiting_seconds` converts those ticks to seconds. Waiting can be caused by another agent or static geometry. An occupant with no route does not accumulate collision waiting. `route_found` reflects the most recent route search using that agent's opening knowledge; false describes failure of the sampled navigation graph, not proof of entrapment.
- `median_evacuation_seconds` summarizes **evacuated occupants only**, including on incomplete runs; it is null if nobody evacuated. Display it alongside evacuated/remaining counts. `simulated_seconds`, `total_distance_metres`, and `total_waiting_seconds` provide run totals. These counters are not inferred from animation frames or traffic samples.

The analytics team can use these fields for distance/wait distributions and evacuation-time charts without changing simulation logic. Stress-test responses currently retain their existing aggregate metric contract; adding per-scenario analytics requires coordination with that workstream.

## Ongoing ownership

### Emergency windows (Issue #43)

Use **Window** beside Door/Exit to place solid glazing on any wall angle. Select,
move, rename, delete and edit width/offset with the existing Properties workflow.
Creation and single selection keep Properties closed. Windows remain separate
stable records even when touching; doors, exits and windows cannot overlap.
JSON without windows remains compatible.

The optional `windows[].emergency_escape` config explicitly specifies enabled,
open/break preparation, clear width/height, preparation/traversal seconds, exterior
side and exterior availability. `window_escape_context` must explicitly assert
zero floor elevation, homogeneous traversal capability and a required clear
height. The inspector's initial 5 s / 3 s timings and 1.2 m / 1 m height inputs
are editable modeling examples, **not validated safety estimates**. Glazing is
opaque; ordinary/disabled windows remain solid.

For this conservative MVP, Rust considers fallback windows **only when every
normal exit is physically blocked**. Failed sampled navigation is not proof that
normal exits are unreachable. An isolated room with an unblocked exit elsewhere
therefore does not yet activate fallback. In this fallback phase, the model uses
global window locations and actual geometry; it does not model individual window
discovery, hesitation, injuries, climbing ability differences or multiple floors.

Exterior side is the sign of `(-dy/L, dx/L)` from the parent wall's start/end.
The user must identify the exterior; workspace boundaries do not establish it.
Both approach and landing discs must fit inside the drawing workspace, and Rust
checks the entire crossing against walls, obstructions and hazards. Leave drawing
space outside exterior walls. Usable width creates a centered aperture with jamb
clearance; no intact wall can be bypassed.

Agents queue by arrival at the holding lane, then stable ID for ties in a tick.
Collision-checked staging positions extend inward along the wall normal, reserving
the service lane for its FIFO head. Tight layouts without staging space can still
stall or time out; the engine never moves occupants through barriers to clear a
queue. Preparation runs once per window:
intact → opening → open, or intact → breaking → broken. Preparation takes
`ceil(preparation_seconds / time_step_seconds)` ticks (zero allowed). One agent
traverses at a time, for at least `ceil(traversal_seconds / time_step_seconds)` ticks,
also respecting the walking speed cap, whole-body movement checks and occupant
collisions. Actual delays can therefore be longer. Service time is not counted
as collision waiting. A reopened normal exit releases queued/approaching agents;
an active crossing finishes rather than jumping back. Started preparation is
shared and continues while the run is active.

The prepared aperture is reserved for its authorized traverser. General walking
and perception retain the opaque wall model at windows, including prepared ones;
glass transparency and individual discovery are future modeling work. At least
one normal exit remains required by building validation.

`window_states` records physical phases, FIFO IDs and active traversal/deadlines
in live and saved frames. Playback uses these states, never a frontend escape
animation. Amber rings indicate queue members; green rings indicate a traverser.
Per-agent `escape_route` and optional `evacuated_by_route` distinguish normal exits
from windows; `exit_id` retains its normal-exit meaning. Legacy recordings have no
invented route breakdown. Remaining/trapped accounting and severity order are
preserved; eligible-but-unreached windows do not prove occupants trapped. Stress
and optimization calls clone configuration and create fresh service state per run.

| Developer   | First feature                                                   | Following feature                                     |
| ----------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| Developer 1 | Freeform layout editing                                         | Real-frame playback controls                          |
| Connor      | Deterministic spawning, continuous navigation, and collisions   | Evacuation ticks, stopping rules, frames, and metrics |
| Nick        | Blocked-exit/obstruction scenarios and real simulation rankings | Bounded layout improvement candidates                 |
| Developer 4 | Result metrics and world-space traffic heatmaps                 | Scenario/optimization comparison and API integration  |

Use the checked-in example for real end-to-end verification and the labeled synthetic fixtures for focused contract/UI tests. Keep changes within the assigned workstream and test shared-contract integration before merging.

Library references: [Axum](https://docs.rs/axum/latest/axum/), [Vite](https://vite.dev/guide/), [Vitest](https://vitest.dev/guide/), and [Recharts](https://recharts.github.io/en-US/api/).
