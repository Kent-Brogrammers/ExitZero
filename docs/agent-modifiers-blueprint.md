# Agent modifiers blueprint

Status: static modifier foundation implemented as `static-modifiers-v1`. The shared schema and Rust/TypeScript models define accepted fields. The editor uses **Edit → Agent personalities…** to choose allowed modifiers for automatic spawning, and the agent inspector shows the recorded personality and walking speed during live runs and playback. Explicit occupant/group assignments remain supported by the JSON contract. Dynamic fear, assistance, and injury transitions remain deferred.

Speed variation is separate from modifier composition: `agent_speed_variation` is an optional fractional uniform spread in [0, 0.2]. New evacuation presets and blank layouts use 0.05 (±5%); omission/zero preserves legacy speeds. Each source identity gets a fixed seeded multiplier, independent of placement and group assignment. Pursuit rejects an explicit nonzero spread.

An additional typed `avoidance_priority_multiplier` in [0.25, 4] defaults to 1 and composes multiplicatively with a single final cap. Higher priority shifts reciprocal avoidance and collision-correction responsibility to other moving people. Aggressive agents can make others yield but cannot overlap bodies or pass obstacles. Presets are Older, Scared, Aggressive, Calm, and Limited mobility; saved numeric values remain authoritative.

The app defaults ordinary evacuation layouts to all saved presets allowed. It saves full numeric definitions and `spawn_modifier_ids` before a run. The Rust spawner first selects occupants using `personality_fraction` (default 0.3), then chooses one allowed modifier per selected occupant with equal probability, using a separate source-identity random stream (domain 4 for exact occupants, 5 for zone occupants). Canonically sorting the allow list preserves assignments when the list is reordered. An empty allow list makes every occupant neutral; omission in raw API input retains legacy/manual assignment semantics. Automatic and explicit assignments cannot be combined. The dialog converts the layout to automatic assignment when saved.

Live HTTP streams send one `initialized` event containing the actual immutable assignments before the first frame. The completed recording retains the same metadata. The inspector reads that output rather than inferring personality from current editor settings.

## Goal

Give occupants composable modifiers that affect both how they move and how they make decisions. An occupant can have several modifiers, such as **older + scared + broken leg**, rather than belonging to one exclusive personality class.

Separate movement capability, decision preferences, and descriptive labels. Age and injury labels do not establish a person's actual abilities or behavior. Presets are editable, illustrative experiment settings, not validated models of demographic groups, psychology, or medical conditions.

Start with static modifiers assigned before a run. Dynamic fear, helping others, group following, recovery, and changes caused by new injuries can be considered after the first version works.

## Existing engine foundations

- `crates/exitzero-core/src/simulation/agent.rs` owns runtime occupants and deterministic placement. Exact occupants receive numeric IDs first, followed by occupants from spawn zones.
- `motion.rs` currently uses a common walking speed of 1.3 m/s and acceleration of 2.0 m/s². `mod.rs` also uses that common speed for movement budgets and corrections.
- `catastrophe.rs` accumulates hazard exposure and injury. Movement already applies the illustrative injury slowdown `1 - 0.75 × injury`.
- `awareness.rs` and `perception.rs` maintain personal knowledge. `navigation.rs` routes through that knowledge; `congestion.rs` adds local traffic forecasts, hazard costs, and route-switch commitment.
- `heatmap.rs` measures crowd delay using a common reference speed. This must become occupant-specific when modifiers are introduced.

Extend this engine in `exitzero-core`. The frontend configures modifiers and displays actual output; it does not calculate movement or decisions. Normal runs, live runs, stress tests, and optimization must use the same modifier resolution.

## Modifier parameters

Use a small typed parameter set rather than arbitrary scripts or a separate movement algorithm for each preset. All multiplier defaults are 1; reaction delay defaults to 0 seconds. The initial ranges below are proposed numerical guardrails, not human performance estimates.

| Parameter                           | Proposed individual and resolved range | Effect                                                                              |
| ----------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| `speed_multiplier`                  | [0.1, 2]                               | Scales the occupant's uninjured walking speed and every final movement speed limit. |
| `acceleration_multiplier`           | [0.1, 2]                               | Scales acceleration toward desired velocity.                                        |
| `reaction_delay_seconds`            | [0, 30]                                | Adds an initial delay before voluntary evacuation movement.                         |
| `hazard_cost_multiplier`            | [0.25, 4]                              | Scales soft routing penalties for personally known hazards.                         |
| `crowd_cost_multiplier`             | [0, 4]                                 | Scales the cost of observed/forecast congestion when comparing routes.              |
| `reassessment_interval_multiplier`  | [0.25, 4]                              | Scales the normal periodic route reassessment interval.                             |
| `route_switch_threshold_multiplier` | [0.25, 4]                              | Scales the improvement required before switching to a congestion detour.            |

For example, increasing hazard cost can favor a longer path around a known exposure area; increasing crowd cost can favor a quieter exit. Reducing the switch threshold makes an agent more willing to change a valid route. These preferences operate on available alternatives and do not guarantee a different outcome in every layout.

Preserve the existing routing cost units and nonnegative edge costs. Weight hazard and congestion components separately. Apply the same parameters to graph searches, route comparisons, and waypoint shortcuts so shortcuts do not undo a chosen detour. Keep mandatory route eligibility rules, including the current safe-route preference, intact.

Sight and communication ranges initially retain the existing scenario-wide settings. A personality must not reveal unseen closures, hazards, or another person's private information. Hazard preferences apply only after discovery or an accepted report.

## Preset ideas

Presets populate explicit numeric modifiers that users can inspect and edit. Choose their actual numeric values during implementation and tuning; only the neutral preset is defined here.

| Preset     | Suggested configuration                                                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Neutral    | All multipliers 1, reaction delay 0; reproduces current behavior.                                                                                   |
| Scared     | An illustrative combination of longer reaction delay, higher known-hazard cost, and a lower route-switch threshold. Speed is configured separately. |
| Young      | An editable movement preset; no automatic assumptions about judgment, knowledge, or risk-taking.                                                    |
| Older      | An editable reduced-speed/acceleration preset; decision preferences remain neutral unless separately configured.                                    |
| Broken leg | An illustrative reduced-speed/acceleration modifier, independent of fear or age. It does not initialize hazard injury.                              |

A user can combine a mobility preset with scared or create a custom modifier. Display the resulting effective parameters before running. A label alone has no computational effect; the saved numeric values drive the simulation.

## Proposed configuration and assignment

Coordinate additions across `shared/schemas/contracts.schema.json`, `crates/exitzero-core/src/models/`, and `frontend/src/types/simulation.ts` in a later implementation. Keep existing building and result fields compatible.

Proposed additions:

- `BuildingScenario.agent_modifiers`: optional array of modifier definitions. Each has a unique `id`, a display `name`, and optional parameters from the table above. Store full definitions in the building so saved experiments do not depend on changing application presets.
- `PlacedOccupant.modifier_ids`: optional list of references to those definitions. Omission or an empty list means neutral.
- `SpawnZone.modifier_groups`: optional array of `{ count, modifier_ids }` groups. Each occupant belongs to one group, whose modifier list can combine several effects. If omitted, everyone in the zone is neutral.

Illustrative partial building JSON (supply the remaining required scenario fields):

```json
{
  "agent_modifiers": [
    {
      "id": "limited_mobility",
      "name": "Broken leg — illustrative",
      "speed_multiplier": 0.5,
      "acceleration_multiplier": 0.6
    },
    {
      "id": "fearful",
      "name": "Scared — illustrative",
      "reaction_delay_seconds": 2,
      "hazard_cost_multiplier": 1.5,
      "route_switch_threshold_multiplier": 0.8
    }
  ],
  "placed_occupants": [
    {
      "id": "person_a",
      "x": 4,
      "y": 6,
      "modifier_ids": ["limited_mobility", "fearful"]
    }
  ]
}
```

For a zone with count 20, groups could assign 12 neutral occupants, 5 scared occupants, and 3 occupants with both scared and limited mobility. Counts must add to exactly 20. This configures the existing population rather than adding people.

Validation must reject unknown modifier references, duplicate IDs within an assignment, duplicate definition IDs, nonfinite values, out-of-range parameters, and nonpositive or noninteger group counts. A present group list must be nonempty and sum exactly to the zone's count. Propose at most 64 definitions per building, 64 references per assignment, and no more groups than occupants in a zone; use the existing ID conventions. Do not silently discard invalid effects or normalize counts.

## Resolution and runtime state

Resolve each occupant's modifiers once during initialization:

1. Start with neutral parameters.
2. Sort referenced modifiers by ID for stable floating-point evaluation order. Multiply multipliers together and add reaction delays.
3. Clamp the combined values once to the proposed resolved ranges. Show any effective cap in the editor and record the resolved values. Do not clamp between modifiers or allow duplicate references to stack accidentally.
4. Store immutable resolved parameters on the runtime agent, separately from mutable injury, knowledge, velocity, and reaction state.

For the current ordinary evacuation engine:

```text
uninjured_speed = 1.3 m/s × resolved.speed_multiplier
effective_speed = uninjured_speed × (1 - 0.75 × hazard_injury)
effective_acceleration = 2.0 m/s² × resolved.acceleration_multiplier
reaction_steps = ceil(resolved.reaction_delay_seconds / time_step_seconds)
```

Keep the existing `injury` output as accumulated hazard injury. A pre-existing mobility modifier is not exposure or newly acquired injury and must not be counted twice. The first version requires positive walking speed; fully immobile occupants and assistance need a separate design.

Apply effective speed consistently to desired velocity, acceleration handling, movement budgets, collision corrections, local escape movement, exit arrival, and window approach movement. An emergency or correction path must not bypass the occupant's cap. Review every use of `WALKING_SPEED`, including observation/forecast speed clamps: observers must accommodate faster measured motion without reading another person's hidden modifier values.

During initial reaction delay, voluntary desired velocity is zero. Occupants still have physical bodies, perceive information, receive reports, and accumulate real exposure. Collision constraints remain active. Reaction time is distinct from collision-rejected waiting time and congestion. Convert the reassessment interval to at least one physics tick; profiles never change the global time step.

Preferences never relax wall, obstruction, body separation, swept-segment, or disabled-opening checks. Keep the scenario-wide agent radius initially. A newly discovered invalid route bypasses the ordinary reassessment interval and commitment delay; a modifier cannot force commitment to a blocked passage.

Keep resolution and parameter composition in a small private `simulation/modifiers.rs` module, with serializable definitions in the existing core models. Pass resolved decision parameters into route queries rather than mutating shared navigation state. Geometry graphs can remain shared for equal geometry and radius. Any cached weighted route/cost result must also account for the decision parameters that affect it.

## Repeatable assignment and fair comparisons

Preserve current placement and numeric ID ordering. Assign zone groups through a deterministic permutation of local occupant ordinals, using a separate random stream derived from the scenario seed and stable zone ID. Specify the stable seed derivation in implementation tests; do not use process-randomized hashing. Changing a modifier must not consume placement randomness or move anyone's initial position.

Keep source identities available internally: placed occupant ID, or zone ID plus local ordinal. Numeric frame IDs remain unchanged. Reordering group declarations must not change assignments: canonicalize each group's modifier list, merge equivalent groups, and sort groups by their canonical lists before applying the deterministic allocation.

Stress-test and optimization comparisons preserve assignments, modifier definitions, seed, and equivalent starting conditions. Do not silently relocate occupants when a modified layout makes their initial placement invalid; report the scenario failure under the existing error handling. An explicit population change is a separate experiment and should state its assignment policy.

## Termination, analytics, and playback

Pending reaction timers are legitimate future activity. They must not trigger an early no-routes or stagnation stop by themselves. Very slow but progressing agents must not be mistaken for stationary agents solely because they miss a fixed distance threshold; audit existing progress thresholds against effective speed. `max_steps` still bounds every run, including one that ends before a reaction timer expires.

For modified runs, compute crowd slowdown relative to each occupant's effective uncongested speed, including current injury. Exclude initial reaction waits and window service waits from crowd-delay accumulation. Preserve the existing neighbor/visibility criterion; a lower preferred speed alone is not congestion. Keep reaction delay separate from the existing collision-wait statistic.

When all resolved parameters are neutral, retain the existing timing policies and congestion semantics to preserve current recordings and regression expectations. Apply modifier-aware progress and delay policies to runs with active nonneutral parameters and identify their semantics in the recorded model version. Any general correction to injury-only congestion measurements should be a separate change.

Propose optional result metadata containing the modifier model version, saved definitions, and each numeric agent ID's assigned modifiers and resolved parameters. Store this once per recording rather than on every position in every frame. Old recordings without metadata should display “modifier information unavailable.” Per-person inspection should explain configured effects and actual route/reaction events; chat must not invent internal fear or reasons that were never recorded.

Retain population accounting: `evacuated + sheltered + remaining == total_population`, with `trapped` a subset of `remaining`. Reaction delay, mobility limits, or personal failure to find a route do not prove topological entrapment. Incomplete runs keep null full-clearance metrics. Keep stress rankings comparable across the same configured population.

## Integration boundaries

Emergency windows retain their existing explicit `all_agents_can_traverse` scenario assumption. A broken-leg label does not establish whether a person can traverse a window. Per-person traversal capability and service times need a later coordinated extension; the UI must continue showing the current assumption when using modifiers.

The fictional pursuit engine has its own configured survivor speed and movement path. Until that path explicitly supports modifiers, reject active nonneutral modifier assignments in pursuit mode with a meaningful validation error. Do not silently ignore them or alter pursuit's existing neutral behavior.

## Implementation boundaries and follow-up

1. **Shared contracts:** agree on names/ranges, add optional configuration and recording metadata in all three contract representations, and add shared fixtures and validation coverage. Old layouts resolve to neutral.
2. **Connor — engine:** implement resolution, stable assignment, reaction state, per-person motion limits, weighted route decisions, termination adjustments, and congestion normalization in core. Keep the current simulation entry points.
3. **Frontend owners:** maintain the Edit-menu allow-list dialog, editable effects, saved-layout support, and recorded/live inspection. Render actual backend movement and decisions.
4. **Nick and integration owners:** verify assignments persist through stress testing/optimization and explain population assumptions and outcomes in comparisons.

These are implementation handoffs, not new GitHub issues. Dynamic fear transitions, following/helping behavior, assistance devices, per-person body sizes, and demographic calibration remain deferred.

Acceptance checks for that implementation:

- Omitted modifiers and explicit neutral assignments reproduce current engine output, apart from optional metadata, under the same toolchain and inputs.
- Composition has documented caps and is independent of declaration/reference order. Invalid references, duplicate assignments, invalid values, and inconsistent population groups fail clearly.
- The same seed produces the same positions and assignments; changing only modifiers leaves initial positions intact. Stress scenarios preserve equivalent occupants.
- A movement-limited occupant respects its speed cap through turns, collision corrections, exits, emergency escape paths, and hazard slowdown.
- Controlled alternative-route fixtures demonstrate changes from hazard/crowd preferences and route-switch thresholds. They use the same geometry, positions, and knowledge, isolating decisions from speed.
- Known closures force rerouting regardless of commitment; unseen hazards remain unknown. No modifier permits collisions or access to a physically blocked exit.
- Reaction timers and slow progress do not cause premature termination or false congestion; a step-limit run still ends with honest remaining/trapped counts.
- Normal and live runs agree for identical settings; recordings preserve modifier metadata. Old layouts/recordings load, and unsupported pursuit combinations fail explicitly.

See [Personalities](personalities.md) for the current presets, Curious discovery behavior, and the percentage control.
