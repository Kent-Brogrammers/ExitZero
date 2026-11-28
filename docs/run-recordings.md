# Saved simulation runs — proposal for #104

Status: **draft for Connor, Layth, and Chris to review**. The shared additions and
project version below are not implemented or approved merely by this document.
This is the first increment of #104, building on the version 1 project files in
#106. No navigation, movement, hazard, or analytics calculations change.

## First increment

Save at most one finished simulation recording in a project, paired with the
immutable request actually passed to the API. A finished response can have a
completed, incomplete, or timeout outcome. Cancellation does not fabricate a
finished result. Stress/optimization collections and multiple-run history wait.

Opening the project restores the recorded frames, events, and existing analytics
without recomputing them. The editable drawing can differ from the run's input;
playback always uses the run's own input. A new computation produces a new run.
Existing comparison fairness checks remain in place.

## Proposed optional shared result field

Add `recording_metadata?` to SimulationResult in Rust, TypeScript, and the shared
schema. Populate it in both the ordinary and pursuit result constructors, so the
live completion event, direct API, cached jobs, and recorded scenarios preserve
the identity of the engine that actually computed their result.

```json
{
  "recording_metadata": {
    "version": 1,
    "engine_package_version": "0.1.0",
    "engine_revision": null,
    "model_version": "continuous-2d-v1",
    "contract_version": 1,
    "frame_stride_steps": 4
  }
}
```

These values illustrate the proposed shape; they are not metadata for an existing
recording. `engine_package_version` comes from the Rust core package, never the
frontend. `engine_revision` is a full source revision supplied at build time by
`EXITZERO_BUILD_REVISION`; it is null when unavailable. A revision is not inferred
from the current browser checkout, a health request, or a restarted job server.
The build process must only stamp a revision that describes the sources being
built. Unknown/custom working-tree builds remain unverified.

The team must agree the initial model and contract version identifiers and when
to increment them. `frame_stride_steps` records the actual configured stride at
the result constructor; extra outcome/final frames can occur between samples.
Playback continues to use each recorded step and `time_step_seconds`, not a fixed
sample-duration assumption.

Missing metadata remains valid legacy data and means engine identity is unknown.
Incomplete metadata is not filled with guessed values. A known engine revision
plus matching input supports identifying an experiment, not a promise of bitwise
repeatability across compilers, platforms, or versions. A fingerprint is an
integrity/matching aid, not authentication of an edited external file.

Existing clients validate additional result fields strictly, so the frontend,
schema, and backend changes need a coordinated release. Old recordings remain
readable by the updated client.

## Input identity and snapshot

Keep the complete JSON request, including display names. Separately fingerprint
its simulation input with `exitzero-input-v1:sha256:<64 lowercase hex digits>`.
The digest input is UTF-8 `exitzero-input-v1\n` followed by canonical JSON:

- Object keys sorted by UTF-16 code units; JSON strings and finite numbers use
  JavaScript JSON serialization, including normalization of negative zero.
- Arrays retain their order. In particular exact occupants and spawn arrays
  determine recorded numeric IDs; other ordering can affect deterministic ties.
- Object display names and modifier display names are excluded only from the
  fingerprint. IDs, all geometry, populations, seed, opening schedules,
  awareness, hazards, window capabilities, and modifier behavior remain included.
- No engine defaults are injected. Missing optional fields and explicit defaults
  can have different identities. This deliberately conservative request identity
  does not assume their equivalence under an unknown engine version.
- Grid, display units, tracing images, furniture symbols, and playback speed
  are not building input and never enter the fingerprint.

Validation must distinguish a matching input with known engine identity from a
matching input with unverified engine identity, changed input, unsupported run
versions, and a layout-only project. A hash of current dimensions/population is
insufficient. Unknown result versions must not be silently stripped.

## Proposed project version 2

Continue reading layout-only `.exitzero` version 1 files unchanged. A version 2
project optionally embeds a run:

```text
run: {
  format: "exitzero-run",
  version: 1,
  id: <UUID>,
  captured_at: <ISO timestamp>,
  source: "computed" | "saved_demo",
  input: <complete BuildingScenario request snapshot>,
  input_fingerprint: <versioned SHA-256 identity>,
  result: <unchanged SimulationResult including optional recording_metadata>
}
```

Capture the input before dispatch, including template-direct runs. Store a run
only after that request's completion is accepted; stale/cancelled requests cannot
replace it. Old API results can be paired with their known captured request but
remain engine-unverified. Do not guess inputs for an unrelated raw recording.
Bundled demo data stays explicitly identified as a saved demo.

Restore a run only after validating the entire project, result schema, existing
population/event/frame checks, dimensions/time step, and input fingerprint. The
current editor drawing and run input may differ intentionally. Keep them paired
with their own view rather than displaying agents over an unrelated drawing.

The File menu offers an explicit include-recording choice when a run is present.
Keep the current 20 MB project limit initially. Oversized recordings produce an
actionable error and a layout-only saving option; never silently omit a selected
recording. No account, database, archive dependency, or new API endpoint is needed.

## Focused verification after approval

- Same-size inputs differing in geometry, seed, opening schedule, awareness, or
  modifiers do not match; name and JSON-key-order changes do match.
- Exact input, frames, Agent Chat, metrics, image, and furniture survive a clean
  browser round-trip. Rewinding uses the original recorded steps/events.
- Changed editor input cannot overwrite the saved run's request; cancelled and
  failed requests cannot become completed recordings.
- Version 1 projects and legacy results remain readable with honest unknown
  metadata. Invalid references, fingerprints, or oversized files preserve the
  current workspace on rejection.
- Live completion, ordinary calculation, pursuit, and cached-job results carry
  their original Rust engine metadata. Engine stamping does not change outcomes.
