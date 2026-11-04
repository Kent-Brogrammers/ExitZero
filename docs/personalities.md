# ExitZero personalities

Configure these in **Edit → Agent personalities…**. All six presets are allowed by default. By default, each occupant has a **30% chance** of receiving one allowed personality; the rest are neutral. Change **Occupants with a personality (%)** from 0 to 100 to control this. Small populations may differ from exactly 30%. Each allowed personality has equal chance among selected occupants.

Assignments and individual walking speed variation are seeded and repeatable. Changing personality settings does not change initial positions. Settings apply to the next run. Click an occupant during live playback or a recording to inspect their actual personality and walking speed.

| Personality | Default effects |
| --- | --- |
| Neutral | Normal movement and routing; no personality modifier. |
| Older | Walking speed ×0.70; acceleration ×0.65. |
| Scared | Walking speed ×0.25; acceleration ×0.40; initial reaction wait 4 seconds; known-hazard cost ×2; route-switch threshold ×0.65. |
| Aggressive | Walking speed ×1.15; crowd avoidance cost ×0.25; reassessment interval ×0.60; avoidance priority ×3. Other moving occupants yield more; collisions and walls still apply. |
| Calm | Known-hazard cost ×1.40; crowd avoidance cost ×1.50; route-switch threshold ×1.25. |
| Limited mobility | Walking speed ×0.45; acceleration ×0.50. Does not add hazard injury. |
| Curious | Searches for an emergency before leaving. Must personally see it; reports alone do not satisfy curiosity. Uses exploratory routes through its own learned geometry, without receiving the emergency location. Once seen, normal evacuation resumes. With no configured emergency, behaves normally. |

The base walking speed is **1.3 m/s**, multiplied by the personality's speed effect and the occupant's seeded speed variation (normally ±5%). Acquired hazard injury can reduce it further. The inspector displays the resulting walking speed in the selected display units. Crowding can make actual movement slower than this preferred speed.

Curious occupants may remain until the step limit if they cannot discover the emergency, including when vision is disabled or no exploratory route is available. They do not teleport, traverse blocked geometry, or automatically count as trapped. They retain hazard exposure and physical collision constraints while searching. Emergency windows cannot bypass the discovery requirement. An exit closure alone is not a fire/gas/tornado emergency.

Preset effects can be adjusted under **Adjust effects**. These are illustrative simulation behaviors, not calibrated demographic or psychological predictions. Personalities apply to ordinary evacuation scenarios; the fictional Pursuit mode retains its separate survivor movement settings. Emergency-window traversal capability remains a scenario-wide assumption.
