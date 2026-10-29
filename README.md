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

**Run simulation** opens a live first run at normal speed. The **Speed** button cycles through 1×, 2×, 4× and 8× while the backend continues running the same physics ticks. **Cancel run** stops the stream and keeps its last frame visible; cancelled runs do not produce a completed recording. The view shows elapsed simulation time and occupant counts without a predicted finish time. When the run ends, the recorded timeline opens at the end; rewind, step, or replay to review what happened.

Evacuation runs stop after 15 simulated seconds without meaningful occupant movement (at least 0.1 m displacement), even if hazards keep spreading or awareness keeps changing. Successful evacuation or shelter arrival resets the timer. Active window preparation and timed traversal pause this timeout; merely being assigned to a window does not. Runs stopped this way are incomplete, retain the occupants still inside as `remaining`, and record `movement_stagnation` without a full-clearance time.

Under **Settings → Agent awareness**, adjust sight range (default 8 m) and communication/yelling range (default 3 m). These settings are saved with the building. A range of 0 disables that behavior. Agents start with exit locations and assume doors and exits are open, including initially blocked exits. Their route maps do not start with the complete wall layout. They learn an opening's state by seeing it or receiving a nearby person's report.

Wall memory records only observed portions within sight range and clear sight lines. Seeing a sliver does not reveal the wall's hidden extent or endpoints, and separate visible patches do not fill an occluded gap. These fragments accumulate as people move; yelling shares the same observed fragments. Near occlusion boundaries, uncertain portions below a centimetre may be omitted rather than revealing hidden material. Route graphs use only remembered fragments and are rebuilt when new knowledge invalidates the current route or an opening changes.

Rectangular obstructions and circular emergency zones also enter each person's route map only after discovery. Visibility uses the nearest surface of an obstruction or hazard, so a large hazard can be noticed without seeing its centre. Yelling requires both range and a clear path: walls, closed doors, and obstructions block reports. Reports travel one hop per physics tick, and newer opening-state reports supersede stale ones. Dijkstra searches each person's belief map again when new information changes it. Actual collision checks always enforce the real world, even for an unseen blockage.

A visible portion of a door or exit is enough to learn its open/closed state;
its midpoint need not be visible or within sight range. Fire/gas reports include
the observed footprint and its revision. Recipients rule out exits covered by
that known danger and immediately replan an affected route, even before seeing
the opening themselves. Unknown hazards and unseen growth remain unknown.
An unsafe destination does not create a solid barrier inside an occupant;
physical closures still wait for people to clear the doorway.

Simulation mode offers **Show Agent Numbers** and a bottom chat notification during live runs. Recorded playback also offers **Show Agent Chat**. Both overlays start closed. Numbers display stable agent IDs plus one. Recorded results optionally include `communication_events`: `{step, event_type, sender_id, recipient_ids, opening_id, blocked}`. A `discovery` records an observer learning a changed state, with no recipients; `shared` records successful new information accepted under the existing local sharing rules, grouped per sender/opening/tick. Missing types in earlier share-only recordings mean `shared`. Repeated states and routine initial open confirmations are omitted, so an ordinary run with no changed opening information has an empty opening-event list. Chat follows simulated time and rewinds with playback; older recordings (including the saved office demo) show an unavailable state. The optional `agent_events` list adds personal dialogue about learned hazards and growth, destinations and reroutes, waiting, window approaches and service, exposure, evacuation and shelter arrival. These comments record actual state changes without broadcasting extra knowledge. Growth alerts are limited to material changes at least five seconds apart. Both lists share the playback timeline. The live stream includes new chat observations, and the completed recording retains them for replay. Chat shows conversational callouts; similar observations within ten simulated seconds share a line with a count of others saying the same thing. Opening state reversals get a fresh line. The unread badge counts these grouped callouts, and the panel keeps the latest 80 visible.

Agents reassess routes every two simulated seconds, with checks staggered across the crowd. Each observer estimates nearby people's motion from consecutive visible positions, smoothing speed and direction over roughly 0.6 seconds. As confidence builds over the first second of observation, routing blends current congestion with one-, two-, and three-second motion forecasts. Traffic flowing along the route costs less than slow or stopped traffic; opposing traffic receives no flow discount. Forecasts stop at remembered obstacles and remove predicted arrivals through believed available exits. Losing sight discards the motion estimate, and forecasts never alter real movement or population counts.

A congestion detour must remain materially better across repeated assessments before an agent switches. The saving must exceed 12% of current estimated cost and at least one agent diameter; turning back adds a further 1.75 seconds of walking cost. After changing routes, the agent commits for three simulated seconds before considering another congestion detour. Newly learned blockages or other geometry that invalidates the current route bypass this delay immediately. Newly available alternatives follow the normal confirmation rule. Waypoint shortcuts use the same forecast cost so they preserve useful detours. These are short-term motion estimates, not exact queue waiting-time predictions.

Exit routes target the usable span of each opening, with agent-radius and wall-thickness clearance at the jambs. People can approach different positions across a wide exit and evacuate side by side. Arrival is counted when an agent's centre reaches that span; narrow exits still require people to yield through ordinary crowd avoidance and collision checks. The exit plane applies equally to openings in horizontal, vertical, and angled walls, approached from either side.

Choose **Emergency scenario** in the editor: baseline evacuation, fire, gas leak, or tornado. Use **Place hazard on plan** to position its origin and adjust the radius. The darker core and outer exposure ring are shown on the plan. Fire closes doors and exits whose openings intersect the exposure area, including at the start of a run. Gas leaves passages open: agents prefer routes clear of known gas or usable escape windows, then attempt a hazardous exit route if those options are unavailable. Exposure still accumulates injury and slows movement. Fire models a heat/smoke exposure area; gas uses a wider exposure footprint and a lower injury rate. Newly configured catastrophes enable spread or movement by default. Expand **Spread settings** or **Tornado movement settings** to tune the behavior or switch it off. Older layouts without dynamics retain their fixed footprints until enabled.

For a tornado, draw one or more **Tornado zones** outside the impact/exposure area. They are walkable shelter destinations, not obstacles. Select a zone and set **Maximum occupants** in Properties (1–10,000 people). Each zone's optional `max_occupants` defaults to 50, including in older layouts, and is preserved in saved JSON. The alarm directs people toward these zones rather than exits and announces when a shelter fills, triggering routes toward other available shelters. Admission follows deterministic agent order for simultaneous arrivals and never exceeds a shelter's maximum. If accessible shelter capacity is insufficient, the run remains incomplete with unsheltered occupants counted as remaining and no full-clearance time. Arrival is recorded as sheltered, separately from evacuated; population totals include both. Admission abstracts entry into safety rather than simulating people's positions inside the shelter; the configured maximum is not a validated capacity derived from floor area.

The alarm sounds at the start of the run. Occupants know which response to take and know destination locations, but do not start with the hazard location. They discover danger through sight, physical exposure, or a nearby person's report, using the same visibility and one-hop communication rules as blocked openings. Discovered hazards add strong routing penalties and detour waypoints. Hazard footprints remain traversable so someone already inside can escape. Exposure is integrated over accepted movement and waiting time; injury accumulates gradually, lowers walking speed, and is displayed in orange/red. There are no deaths in this version. Injury levels and rates are illustrative simulation parameters, not medical or building-safety predictions.

The Rust `simulate_with_emergencies` entry point still supports its original static circular exclusion zones. The optional `disaster` and `tornado_zones` fields work through both normal and live simulation APIs, and are saved in layout JSON.

Fire ignites connected patches along the exposed edges of areas already burning. Each new patch overlaps existing fire but starts on fresh ground, rather than being hidden inside the source. Seeded branching and uneven patch growth make the fire spread outward from its reached areas. Controls set growth rate, ignition interval, maximum patch count, and maximum patch radius.

Gas stays a single cloud at its original position. Its radius grows at the configured metres per second until the maximum cloud radius; it never spawns extra patches. Older gas layouts with multi-patch settings remain readable, but those branching controls are ignored. Fire examines all current frontiers in all directions, favors nearby wall surfaces, and periodically fills inward. Each pod respects Maximum patch radius; neighboring cores limit further growth to avoid piling up in the same area. New cores remain connected to existing fire, and their centres cannot jump across a solid wall, though open doorways can carry spread. These are illustrative geometric rules, not fuel, airflow, or combustion physics. Both hazards are clipped to workspace extents for display. Overlapping fire patches contribute the strongest exposure rather than multiplying injury by patch count.

Tornado controls set travel speed, maximum turning speed, direction-change interval, and extra shelter clearance. A seeded wandering heading turns gradually; steering and braking avoid workspace edges and every tornado zone. Swept movement checks keep the full exposure radius, occupant body margin, and configured extra clearance outside shelters, including between physics ticks. The initial tornado location must also meet that clearance. The scenario random seed controls both repeatable hazards and occupant placement.

Hazard fills render above spawn regions; overlapping patches share a single fill per layer so their opacity does not accumulate. Every recorded frame includes the actual `disaster_state` footprints. Live viewing and rewind render those recorded states, with interpolation only between received samples. Agents remember individual sighted or reported patches and their revisions: unseen growth and tornado movement do not silently refresh their route maps. Danger updates can trigger a safety detour without waiting for the normal congestion commitment, while unchanged safe guidance is retained. Injury integrates relative person/hazard movement across each physics tick, and newly affected openings close once bodies clear them.

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

## Exact occupant placement

Use **Spawn zone → Place occupant** to set exact starting centres. Select a marker
to move, rename, delete, duplicate, or edit its coordinates in feet. Draw Zone and
Fill Room remain available. All placements participate in undo/redo, local saving,
templates, and JSON export/import.

Building JSON optionally stores `placed_occupants: [{"id":"occupant-a","name":"Reception","x":3.125,"y":4.625}]`
in metres. IDs remain stable editor references. Each recording assigns numeric
agent IDs to these entries in saved array order starting at zero, then assigns IDs
to seeded area occupants. Editing or removing entries can change numbering in a
later run; an existing recording retains its own IDs. No result fields change.

Rust reserves exact bodies first and samples area occupants around them. Exact
positions are never randomized or silently moved. Bodies must fit inside the
workspace, clear real walls/closed openings/windows/furniture, and not overlap
each other. Area sampling can still fail if too little clear space remains. The
combined population limit is 10,000 (64 in Halloween pursuit). Layouts without
placed occupants retain the existing seeded behavior. Seating/activity states are
a separate future feature.

## Deploy on Render (one Docker web service)

Create a [Render Web Service](https://render.com/docs/docker) from this repository.
Select **Docker**, use the repository root as the build context, and `./Dockerfile`
as the Dockerfile path. Choose the Free instance and set the health check path to
`/api/health`. Leave the Docker command override empty; no separate build/start
commands or frontend service are needed.

The image builds both apps, then runs only a stripped release Rust binary and the
static frontend as a non-root user. Axum serves the site, assets, navigation
fallback, API, and live NDJSON streams on the same origin. It binds to `0.0.0.0`
using Render's `PORT` (image default `10000`; local Rust fallback `3001`). Keep
`VITE_API_BASE_URL=/api`, which is set during the image build. The image sets
`EXITZERO_FRONTEND_DIR=/app/frontend` and one compute worker to limit concurrent
simulation memory use on a 512 MB instance. Large populations, long recordings,
and stress batches can still exceed that budget; use modest demo runs.

To try the production service locally with Docker:

```sh
docker build -t exitzero .
docker run --rm -p 10000:10000 --memory=512m exitzero
```

Open `http://localhost:10000`; `/api/health` should return the usual health JSON.
For a different port, set `-e PORT=8080 -p 8080:8080` instead. `./dev.sh` and the
Vite proxy remain unchanged. Outside Docker, setting `EXITZERO_FRONTEND_DIR` to
the absolute path of `frontend/dist` enables the same frontend serving; omit it
for the existing API-only development server.

Layouts/templates remain browser-local; server job history is in memory and is
lost on restart. Free services can sleep when idle, so the first visit may take
longer. See [Render's free-service limits](https://render.com/docs/free).

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

The studio uses `POST /api/simulate/live` with a `BuildingScenario` body. Its `application/x-ndjson` response emits `SimulationStreamEvent` objects, one per line: `{type: "frame", frame}` during computation, followed by `{type: "complete", result}` containing the ordinary `SimulationResult` and recording. Errors after streaming starts use `{type: "error", error: {code, message}}`. New dialogue is streamed as `{type: "chat", communication_events, agent_events}` after its corresponding frame. Frames are paced by their simulated timestamps; disconnecting cancels the worker. Clients can supply an optional `?run_id=<unique ID>` (1–64 letters, digits, hyphens or underscores). During that run, `POST /api/simulate/live/{run_id}/speed` accepts and returns `LiveSpeedControl`: `{speed: 1 | 2 | 4 | 8}`. Speed changes affect wall-clock pacing, preserving physics time steps and simulated metrics; completed or disconnected runs release their controls. The batch `/api/simulate` endpoint remains available to integrations.

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
- Spawn zones retain `{id, x, y, width, height, count}` and may add `polygon: [{x,y}, ...]` plus `holes: [[{x,y}, ...], ...]`. Rectangle fields are the exact polygon bounding box; omitted polygons preserve older rectangular layouts. Boundaries must be simple, with 3-512 vertices and at most 32 nonoverlapping interior holes. Region interiors cannot overlap, although bounding boxes may. Rust deterministically samples only whole occupant discs inside the actual region, outside holes, and clear of physical obstacles. Disc area is a preliminary capacity check; impossible placement returns a meaningful error. Total population remains at most 10,000.
- `obstructions` contains physical rectangles `{id, x, y, width, height}`. `blocked_exit_ids` references existing exits without duplicates. Stress configuration uses `obstruction_candidates`; each candidate is an additional rectangle evaluated against an unchanged baseline. Candidates must have unique IDs and individually pass building validation. Stress-result modifications use `added_obstructions` and additional `blocked_exit_ids`.
- `seed` is a nonnegative JavaScript-safe integer (at most `9007199254740991`); `max_steps` is 1–100,000. `time_step_seconds` is in `(0, 1]` and gives simulated time per frame step. Stress tests and optimization accept budgets of 1–100 scenarios/candidates. Limits are 500 walls, 1,000 doors, 1,000 exits, 100 spawn zones, and 100 obstructions.
- JSON Schema validates shapes and numeric ranges, including draft layouts with no exits or occupants. The editor also checks geometric relationships. Rust computation validation requires at least one exit and one spawn zone and checks bounds, references, opening overlap, spawn areas, and obstruction geometry. The schema alone is insufficient for running a layout.
- `evacuated + remaining = total_population`; `trapped` is a subset of `remaining`. `completed` requires zero remaining and non-null `clearance_steps`. `incomplete` and `timeout` require positive remaining and null clearance. Never interpret missing clearance as zero.
- Frames contain `step` and `agents: [{id, x, y}]`, with continuous agent positions. Steps strictly increase and agent IDs are unique per frame. Playback can interpolate positions between frames using `time_step_seconds`. `traffic_samples: [{x, y, visits}]` is a sparse collection of weighted world positions representing accumulated traffic, not instantaneous density; analytics can render these as a smooth heatmap. Result dimensions are metre extents.
- Stress results contain baseline metrics and scenario IDs, descriptions, additional blocker modifications, metrics, rank, and severity. Rank 1 is worst; ties may share a rank. Compare remaining occupants first, trapped occupants second, then clearance steps (null sorts worse than measured clearance). The shared `compare_severity` helper encodes that order. Severity labels are exploratory heuristics; incomplete runs remain distinct from measured full clearances.

## Halloween — The Pursuit

The Templates gallery includes an editable single-floor suburban house for a fictional Halloween game. Run Simulation uses Rust navigation, swept wall/furniture collision checks and survivor collision resolution. The red mask pursues reachable survivors; survivors penalize routes near a visible stalker. A fixed seed reproduces spawn positions and outcomes. The optional `pursuit` building setting contains `stalker_start`, `stalker_speed`, `survivor_speed`, `capture_radius` and `avoidance_radius`, in metres and seconds. The start must be physically clear. This mode supports up to 64 survivors, without simultaneous fire/gas/tornado hazards.

Recorded/live frames add optional `pursuit: {stalker, escaped, caught: [{agent_id, step}]}`. The stalker is a separate actor, excluded from survivor population. Caught survivors leave `agents`; capture requires actual swept proximity through clear geometry. Timeline counts distinguish **Escaped / Caught / Remaining active**. For compatibility, ordinary result `remaining` still counts everyone who did not evacuate, including caught survivors; a pursuit with captures is not a completed evacuation. Standard safety stress/optimization controls are disabled for this game, with a dedicated read-only outcome in the Analytics view.

Caught records optionally include their exact `position`; playback keeps a stationary red × there, separate from the red masked stalker and active population. Older recordings without positions retain their counts without invented markers. Optional cumulative `pursuit.events` record first line-of-sight sightings and successful first warnings, with steps, stable sender/recipient IDs, and the observed location. The Agent Chat panel shows these during live pursuit and follows recorded time on rewind. Reports use the ordinary communication range and physical line-of-sight rule, travel one hop per tick, and guide routing using the last known location rather than hidden stalker updates. Repeated sightings and location refreshes do not spam the log.

Halloween accents are inherited only while the pursuit configuration is active; ordinary Studio/blueprint appearance returns when it is removed or another template is loaded. No appearance preferences are overwritten. Catches occur on first swept body contact (two agent radii, capped by the legacy `capture_radius` setting), through clear geometry, without an attack delay. The survivor freezes at the contact position; the next tick immediately retargets the stalker.

The house starts with the west bedroom door and garage access blocked, plus a blocked garage side exit. Occupants without a normal route reuse the existing emergency-window preparation, FIFO queue and timed collision-checked traversal. The bedroom sash opens; the garage window requires breaking. Other windows remain solid glazing. Window states and escape-route totals are recorded for playback. Limited map discovery, opening chat, injury and calibrated crowd behavior remain in ordinary evacuation modes. This is a playful simulation, not a safety assessment.

## Edit a layout

The example is a 30×20 m workspace with angled and straight walls, two exits, two doorways, and two spawn zones containing 34 occupants.

- Choose **Wall** and drag to draw at any angle. Endpoints snap to nearby endpoints, corners, and wall segments so custom room dividers join exactly. Room fill also recognizes existing wall joins whose thicknesses overlap; an actual gap still leaves rooms connected. Grid snapping is optional.
- Choose **Door** and click near a wall. A door with an enclosed room on one side and exterior space on the other automatically becomes an exit. Close the wall perimeter first; the workspace edge does not define the exterior. Interior doors remain doors, and wall/opening edits refresh classifications while preserving IDs and blocked states. Adjust width and offset in Properties.
- Under **Spawn zone**, choose **Draw Polygon** and click corners, then click the first corner or press Enter to finish. Escape cancels. **Draw Zone** still draws rectangles. **Fill Room** creates one polygon matching the room boundary, with holes for enclosed inner rooms. Select a region to edit its count, move it, or scale its bounds. Furniture and walls remain excluded by Rust placement checks. **Obstruction** draws a rectangle.
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

Use **Window** beside Door to place solid glazing on any wall angle. Select,
move, rename, delete and edit width/offset with the existing Properties workflow.
Creation and single selection keep Properties closed. Windows remain separate
stable records even when touching; doors, exits and windows cannot overlap.
JSON without windows remains compatible.

Newly placed windows and older windows without escape settings default to enabled emergency escape, break preparation,
an available exterior landing, and ground-floor traversal assumptions. The
exterior direction points away from occupants, or away from the rest of the plan
when no occupants are placed yet. Missing escape settings are also defaulted by the Rust simulator for direct API requests. Explicitly disabled windows and explicit capability/landing overrides remain unchanged. Existing saved settings remain editable;
switching an older window's escape checkbox on supplies the other required
checkbox settings in the same action.

The optional `windows[].emergency_escape` config explicitly specifies enabled,
open/break preparation, clear width/height, preparation/traversal seconds, exterior
side and exterior availability. A missing `window_escape_context` defaults to
zero floor elevation, all occupants able to traverse, and 1 m required clear
height. Explicit context settings override these defaults. The inspector's initial 5 s / 3 s timings and 1.2 m / 1 m height inputs
are editable modeling examples, **not validated safety estimates**. Glazing is
opaque; ordinary/disabled windows remain solid.

Agents try fallback windows when every normal exit is physically blocked, or
when their own learned layout and danger reports yield no normal route avoiding
fire/gas. A gas barrier can trigger fallback while the exit itself stays open.
Each occupant first searches for a normal detour; people with a clear exit route
continue using it while cut-off groups try eligible windows. Failed sampled
navigation justifies trying another escape option, not classifying people as
trapped. Window approach routing also avoids hazard footprints, allowing someone
already exposed to move outward. In this fallback phase, the model still uses
global window locations and actual geometry; it does not model individual window
discovery, hesitation, climbing ability differences or multiple floors.

Exterior side is the sign of `(-dy/L, dx/L)` from the parent wall's start/end.
The user must identify the exterior; workspace boundaries do not establish it.
Properties labels each direction as left/right/up/down and warns if the arrow
points toward every occupied spawn rectangle. The suggested direction is a setup
hint, not a topology check; it leaves existing selections unchanged until chosen.
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

Fire or gas closing the last normal exit also activates fallback. Window service
rechecks the current hazard footprints before starting a crossing. If a growing
hazard covers the service lane or landing, approaching and queued occupants are
released to choose another eligible window. An occupant already crossing
continues without teleporting; exposure and injury still accumulate. Injury
speed limits apply while approaching and traversing windows. Tornado response
uses shelter zones and never activates emergency window escape.

`window_states` records physical phases, FIFO IDs and active traversal/deadlines
in live and saved frames. Playback uses these states, never a frontend escape
animation. Amber rings indicate queue members; green rings indicate a traverser.
The readout also counts assigned people still approaching and displays backend
rejection reasons: disabled escape, missing capability assumptions, blocked or
out-of-bounds landings, hazards, and unreachable indoor approaches. Older
recordings omit these optional diagnostics. A corrected two-room layout with
outward-facing windows is available in `shared/examples/window-escape.json`;
import it and block the normal exit or add a hazard to test window fallback.
Per-agent `escape_route` and optional `evacuated_by_route` distinguish normal exits
from windows; `exit_id` retains its normal-exit meaning. Legacy recordings have no
invented route breakdown. Remaining/trapped accounting and severity order are
preserved; eligible-but-unreached windows do not prove occupants trapped. Stress
and optimization calls clone configuration and create fresh service state per run.

| Developer | First feature                                                   | Following feature                                     |
| --------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| Chris     | Freeform layout editing                                         | Real-frame playback controls                          |
| Connor    | Deterministic spawning, continuous navigation, and collisions   | Evacuation ticks, stopping rules, frames, and metrics |
| Nick      | Blocked-exit/obstruction scenarios and real simulation rankings | Bounded layout improvement candidates                 |
| Layth     | Result metrics and world-space traffic heatmaps                 | Scenario/optimization comparison and API integration  |

Use the checked-in example for real end-to-end verification and the labeled synthetic fixtures for focused contract/UI tests. Keep changes within the assigned workstream and test shared-contract integration before merging.

Library references: [Axum](https://docs.rs/axum/latest/axum/), [Vite](https://vite.dev/guide/), [Vitest](https://vitest.dev/guide/), and [Recharts](https://recharts.github.io/en-US/api/).
