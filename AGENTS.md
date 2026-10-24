# 🚨 EXITZERO — COMPLETE PROJECT CONTEXT
**Stark State Halloween Hackathon 2026**

**Project:** ExitZero  
**Tagline:** Design. Simulate. Stress Test. Optimize.  
**Team Size:** 4 Developers  
**Backend:** Rust  
**Frontend:** React + TypeScript  
**Application:** Local web application  
**Primary Objective:** Build a functional, impressive evacuation simulation and automated vulnerability-analysis prototype.

---

# 1. PROJECT VISION

ExitZero is an interactive building evacuation simulation platform that allows users to design building layouts, simulate crowd movement during evacuations, identify potential bottlenecks, and automatically stress-test different emergency scenarios.

The primary innovation we're pursuing isn't simply visualizing people evacuating a building.

**It's automatically exploring possible failure scenarios, discovering the most vulnerable areas of a building, and evaluating potential improvements.**

Users should be able to create a building, populate it with virtual occupants, run an evacuation, and receive analytical results about how their building performs under different hypothetical conditions.

The application should be intuitive enough for someone without an engineering background to understand.

This is an educational and exploratory engineering tool. It is NOT a certified building-safety platform, and its simplified simulation results must not be presented as validated predictions of real-world evacuation outcomes.

# 2. THE PROBLEM WE'RE SOLVING

Buildings are designed with evacuation routes and emergency exits, but simply having exits doesn't mean every hypothetical evacuation scenario will behave the same way.

Consider these situations:

- A primary emergency exit becomes unavailable.
- A corridor is blocked.
- A building has significantly more occupants than usual.
- Several groups of people converge on the same narrow doorway.
- Certain rooms become disconnected from accessible exits.
- A change to the building layout creates an unexpected bottleneck.

Analyzing how these conditions affect movement can be difficult, especially without specialized simulation software.

ExitZero aims to make exploratory crowd-flow simulation and automated scenario comparison accessible through an interactive interface.

Rather than requiring a user to manually discover every possible problem, the system can generate and test selected failure scenarios automatically.

# 3. THE COMPLETE USER EXPERIENCE

Our finished prototype should support the following workflow.

## Step 1 — Design a Building

The user opens ExitZero and sees a top-down, 2D building editor.

They can:

- Create a rectangular floor-plan grid.
- Draw and remove walls.
- Place doors and walkable corridors.
- Designate emergency exits.
- Add occupant spawn zones.
- Configure population counts.
- Load an example building.
- Save a building configuration.

We are not creating a professional CAD application.

The editor should be simple, responsive, and easy to demonstrate.

## Step 2 — Simulate an Evacuation

The user clicks **Run Simulation**.

The frontend sends the building configuration to the Rust backend.

The simulation engine:

1. Validates the building.
2. Identifies walkable areas and available exits.
3. Creates simulated occupants.
4. Calculates routes toward accessible exits.
5. Moves occupants through the grid.
6. Resolves movement conflicts.
7. Records traffic and congestion-related metrics.
8. Tracks successful evacuations.
9. Identifies unreachable or remaining occupants.
10. Stops on completion or an appropriate termination condition.

The Rust backend returns animation frames and simulation statistics.

The frontend visualizes the movement.

Users should be able to observe occupants navigating corridors, converging on exits, and experiencing congestion.

## Step 3 — Automated Stress Testing

This is our MAIN competitive feature.

The user clicks **Stress Test**.

Instead of manually configuring every possible failure, ExitZero generates multiple hypothetical scenarios.

For example:

- Baseline evacuation with all exits available.
- Exit A disabled.
- Exit B disabled.
- Selected corridor obstructed.
- Population increased.
- Other specifically supported disruptions.

Each scenario is executed using the same Rust simulation engine.

ExitZero collects results and compares performance.

For fair comparisons, preserve equivalent starting conditions and random seeds where appropriate. If stochastic behavior affects outcomes, consider multiple runs rather than treating one random result as definitive.

## Step 4 — Vulnerability Analysis

After the stress tests finish, ExitZero presents an analysis dashboard.

Users can see:

- Baseline evacuation performance.
- Most disruptive exit closure.
- Congestion-related hotspots.
- Occupants successfully evacuated.
- Occupants unable to reach exits.
- Occupants remaining when a run terminates.
- Simulated clearance times for completed evacuations.
- Ranked failure scenarios.
- Differences between baseline and stressed scenarios.

For example, the system might discover that blocking Exit B causes significantly worse results than blocking Exit A.

The application should clearly communicate the conditions that produced those results.

Do not equate simulated traffic counts with scientifically validated crowd density.

## Step 5 — Evaluate Improvements

After identifying a potential problem, the user can modify the building.

For example:

- Widen a doorway.
- Remove an obstruction.
- Add an alternative exit.
- Change a corridor configuration.

Then they rerun the simulation and stress tests.

ExitZero compares the original and modified configurations.

If time allows, our optimization subsystem should automatically evaluate a small set of permitted modifications and identify candidates that improve the chosen simulation metrics.

The goal is to demonstrate measurable improvement under consistent assumptions, not certify that a building is safe.

# 4. WHAT MAKES OUR PROJECT INTERESTING?

ExitZero combines several computer science areas:

**Algorithms**
- Breadth-first search
- Pathfinding
- Graph/grid representation
- Search and optimization

**Simulation**
- Discrete time steps
- Agent-based modeling
- Occupancy constraints
- Movement conflict resolution
- Simplified crowd-flow dynamics

**Optimization**
- Automated scenario generation
- Exhaustive search over small candidate sets
- Objective functions
- Experimental comparisons
- Candidate ranking

**Data Analysis**
- Summary statistics
- Scenario comparison
- Traffic heatmaps
- Bottleneck identification
- Repeatable experiments

**Software Engineering**
- Modular Rust backend
- TypeScript frontend
- Typed JSON contracts
- REST APIs
- Automated testing
- Four-person collaboration

Professional pedestrian simulation systems already exist. We're not claiming to invent evacuation simulation.

Our focus is building a streamlined, interactive workflow centered on automated failure exploration and understandable results.

# 5. THE TECHNOLOGY STACK

## Frontend — TypeScript

- React
- TypeScript
- Vite
- HTML Canvas
- Recharts or an equivalent visualization library
- CSS
- Fetch API

Responsible for:

- Building editor
- Simulation controls
- Animation rendering
- User interaction
- Analytics dashboard
- Charts and heatmaps
- Scenario comparisons

The frontend should NOT independently calculate evacuation physics.

## Backend — Rust

- Rust
- Axum
- Tokio
- Serde
- serde_json

Responsible for:

- Building validation
- Grid representation
- Agent pathfinding
- Movement simulation
- Congestion behavior
- Simulation results
- Automated stress testing
- Layout optimization
- Scenario rankings

The backend owns the actual computations.

No Python services or external AI APIs are required.

## Communication

Use JSON over HTTP.

Planned routes:

- GET /api/health
- POST /api/simulate
- POST /api/stress-test
- POST /api/optimize (stretch feature)

The ongoing boilerplate generation establishes the authoritative data contracts. Inspect the generated schemas and Rust/TypeScript types before implementing features. Do not independently introduce incompatible request or response structures.

# 6. TEAM ASSIGNMENTS

## Developer 1 — Frontend & Floor-Plan Editor
**Assigned: TBD**

Primary responsibility: Building design and simulation playback.

Owns:

- Editable grid
- Walls and doors
- Emergency exits
- Spawn zones
- Editing tools
- Building serialization
- Simulation playback
- Animation controls

Their work should make it possible for a judge to design a building and visually observe an evacuation.

## Developer 2 — Connor
**Rust Simulation Engine**

Primary responsibility: Build the simulation engine that everything else depends on.

Owns:

- Grid navigation
- Walkable and blocked cells
- Pathfinding
- Agent initialization
- Agent movement
- Collision prevention
- Congestion and limited passage capacity
- Termination conditions
- Evacuation metrics
- Simulation frame generation

His simulation must be reusable by both the normal API endpoint and the stress-testing engine.

## Developer 3 — Nick
**Rust Stress Testing & Optimization**

Primary responsibility: Automatically discover and evaluate vulnerabilities.

Owns:

- Failure scenario generation
- Single-exit closure experiments
- Selected corridor obstruction tests
- Population stress tests
- Repeated simulation execution
- Baseline comparisons
- Vulnerability rankings
- Candidate layout modification search
- Optimization results

Nick should call Connor's Rust simulation engine directly as a library/module rather than making internal HTTP requests.

Initial implementation should use exhaustive enumeration of a small number of scenarios.

Advanced optimization algorithms are optional.

## Developer 4 — Analytics & Integration
**Assigned: TBD**

Primary responsibility: Explain simulation results and help deliver a fully integrated application.

Owns:

- Evacuation metrics dashboard
- Cell traffic heatmaps
- Vulnerability rankings
- Before/after comparisons
- Scenario selection UI
- Typed API integration
- Loading and error states
- Integration tests
- Demo reliability

Developers 1 and 4 must coordinate frontend components and shared state.

All four developers remain responsible for integration and testing of their work.

# 7. SIMULATION DESIGN

Use a simplified 2D grid-based crowd-flow simulation for the hackathon MVP.

Each grid cell represents a small region of the building.

Cell types include:

- Wall
- Walkable space
- Door
- Exit

Blocked corridors and disabled exits must be respected by the simulation.

Agents have:

- Position
- Identifier
- Evacuation status
- Movement behavior
- A route or navigation field toward an available exit

Initially, a distance-field or BFS-based pathfinding approach is sufficient.

During each simulation step:

1. Determine possible movement.
2. Select desired moves.
3. Resolve conflicts.
4. Update positions.
5. Remove or mark agents that successfully evacuate.
6. Record metrics.
7. Determine whether the simulation should continue.

The simulation must terminate properly even when evacuation is impossible.

Do not fake agent paths, hardcode successful evacuations, or return fabricated metrics.

The visual animation must represent actual simulation output.

# 8. STRESS TESTING DESIGN

The stress tester uses the same simulator as normal evacuation runs.

Conceptual workflow:

Building Configuration
    ↓
Generate Scenarios
    ↓
Run Baseline
    ↓
Run Modified Scenarios
    ↓
Collect Metrics
    ↓
Compare and Rank
    ↓
Return Vulnerability Report

Initial scenario generation:

1. Block each exit individually.
2. Test a small number of selected corridor obstructions.
3. Optionally increase population.

Important ranking considerations:

- Incomplete or failed evacuations must be distinguished from completed ones.
- Unreachable occupants must not be confused with occupants still moving at timeout.
- Clearance time is only meaningful as a full-evacuation metric when all occupants evacuate.
- Results should be compared under consistent experimental conditions.
- Simulations must not run indefinitely.

The first MVP needs reliable blocked-exit stress testing.

More sophisticated scenario search can come later.

# 9. OPTIMIZATION DESIGN

Optimization is a stretch feature after the core simulation and stress testing work.

The optimizer should consider a limited set of candidate modifications.

Examples:

- Move an exit to another valid boundary location.
- Add a valid exit.
- Widen a doorway.
- Remove a permitted obstacle.

Each candidate modification must be validated.

The system should run the same supported scenarios on each candidate and measure whether the results improve.

Initially, exhaustive candidate evaluation is sufficient.

Do not jump straight into genetic algorithms, reinforcement learning, or a machine-learning model.

Those may be interesting future extensions, but they are unnecessary for the initial prototype.

# 10. ANALYTICS DESIGN

The user should understand simulation results without needing to inspect raw JSON.

The dashboard should include:

**Core Metrics**
- Total occupants
- Evacuated occupants
- Unreachable occupants
- Remaining occupants
- Completion status
- Clearance time when applicable

**Visualizations**
- Agent movement playback
- Accumulated cell traffic heatmap
- Baseline vs. stress-test comparison
- Scenario rankings
- Before/after layout comparison

Make sure charts handle incomplete scenarios rather than silently dropping them or assigning misleading clearance times.

All mock data must be clearly distinguished from actual computation results.

# 11. HACKATHON MVP REQUIREMENTS

The minimum acceptable application must:

1. Display a building floor plan.
2. Allow basic layout editing.
3. Send building configurations to Rust.
4. Simulate occupant movement.
5. Animate actual simulation output.
6. Display evacuation metrics.
7. Automatically test blocked exits.
8. Rank failure scenarios.
9. Display results in the dashboard.

The project is not considered integrated until the complete flow works.

Prioritize this before optional features.

# 12. OPTIONAL FEATURES

Only work on these after the MVP is functioning.

- Automatic optimization of layout changes.
- More sophisticated congestion models.
- Repeated runs with statistical comparisons.
- Additional obstruction scenarios.
- Additional analytics charts.
- Exportable analysis reports.
- More visually polished simulations.

Do not introduce unnecessary complexity to achieve these.

# 13. FEATURES OUT OF SCOPE

We are NOT prioritizing:

- Full 3D buildings
- Multiple floors
- Realistic fire and smoke simulation
- Structural collapse
- Full professional CAD capabilities
- Automatic PDF blueprint recognition
- Training neural networks
- AI chatbots
- Cloud infrastructure
- Authentication systems
- Databases
- Mobile applications

Our objective is a reliable, complete engineering prototype.

# 14. REPOSITORY & COLLABORATION RULES

Another Codex session is currently generating the boilerplate.

Until that process finishes:

- Do not modify repository source files.
- Do not independently scaffold another application.
- Do not rewrite shared types or schemas.
- Do not create additional AGENTS.md files.
- Do not add unnecessary documentation.
- Do not install additional dependencies into the shared repository.
- Do not implement application features against assumed contracts.

Once the scaffold is committed:

- Inspect the authoritative shared JSON schemas.
- Use the existing folder structure.
- Work in your designated subsystem.
- Use feature branches.
- Keep pull requests focused.
- Run relevant tests.
- Coordinate changes to shared contracts.
- Integrate frequently.

The initial GitHub issue plan contains exactly eight development issues, two per developer.

Avoid duplicate issues and unnecessary project-management artifacts.

# 15. OUR FINAL HACKATHON DEMONSTRATION

The demonstration should take approximately 60–120 seconds if the system is responsive enough.

**Opening:**

"What happens when an emergency exit you rely on becomes unavailable?"

**Demonstration:**

1. Load a sample building with two exits and simulated occupants.
2. Run a baseline evacuation.
3. Watch occupants move toward exits.
4. Display evacuation results.
5. Click Stress Test.
6. Automatically simulate alternative exit-closure scenarios.
7. Highlight the worst-performing scenario.
8. Show the resulting traffic/congestion visualization.
9. Modify the building layout.
10. Rerun the analysis.
11. Compare the original and modified results.

**Closing:**

"ExitZero doesn't just visualize evacuations. It helps users explore failure scenarios, discover potential bottlenecks, and test possible improvements."

# 16. DEFINITION OF SUCCESS

We will consider the project successful when:

- The Rust backend runs reliably.
- The TypeScript frontend works.
- Building data transfers correctly.
- Agent movement is genuinely simulated.
- Exit closures produce meaningful changes.
- Automated stress tests complete.
- Scenario results are ranked correctly.
- Analytics communicate the results clearly.
- The application can be demonstrated repeatedly.
- All four developers can explain their contributions.

Accuracy and limitations must be communicated honestly.

The strongest hackathon project is one that works end to end and demonstrates real engineering.

---

# FINAL DIRECTIVE FOR CODEX

Treat this document as project background and shared requirements.

It does not authorize you to modify the repository.

If you are being asked to create GitHub Issues, use this context to understand the project and generate tasks consistent with the existing issue plan.

If you are being asked to implement a specific issue, focus only on that issue and its necessary dependencies.

Do not expand the project scope, create unrelated agent infrastructure, generate unnecessary documentation, or implement another developer's assigned subsystem without authorization.

**Our shared goal: Build ExitZero as a clean, modular, functional Rust + TypeScript evacuation simulation and automated stress-testing application.**