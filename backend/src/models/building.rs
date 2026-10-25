use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Wall {
    pub id: String,
    /// Display metadata only; simulation and references use the stable id.
    #[serde(
        default,
        deserialize_with = "deserialize_name",
        skip_serializing_if = "Option::is_none"
    )]
    pub name: Option<String>,
    pub start: Point,
    pub end: Point,
    pub thickness: f64,
}

impl Wall {
    pub fn length(&self) -> f64 {
        (self.end.x - self.start.x).hypot(self.end.y - self.start.y)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Opening {
    pub id: String,
    /// Display metadata only; simulation and references use the stable id.
    #[serde(
        default,
        deserialize_with = "deserialize_name",
        skip_serializing_if = "Option::is_none"
    )]
    pub name: Option<String>,
    pub wall_id: String,
    /// Distance in metres from the wall's start to the beginning of the opening.
    pub offset: f64,
    pub width: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Obstruction {
    pub id: String,
    /// Display metadata only; simulation and references use the stable id.
    #[serde(
        default,
        deserialize_with = "deserialize_name",
        skip_serializing_if = "Option::is_none"
    )]
    pub name: Option<String>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpawnZone {
    pub id: String,
    /// Display metadata only; simulation and references use the stable id.
    #[serde(
        default,
        deserialize_with = "deserialize_name",
        skip_serializing_if = "Option::is_none"
    )]
    pub name: Option<String>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub count: u32,
}

/// Walkable architectural metadata. It is not collision geometry or a floor connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StairArea {
    pub id: String,
    #[serde(
        default,
        deserialize_with = "deserialize_name",
        skip_serializing_if = "Option::is_none"
    )]
    pub name: Option<String>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(
        default,
        deserialize_with = "deserialize_orientation",
        skip_serializing_if = "Option::is_none"
    )]
    pub orientation_degrees: Option<u16>,
}

fn deserialize_orientation<'de, D>(deserializer: D) -> Result<Option<u16>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    u16::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildingScenario {
    /// Workspace extent in metres, not a navigation grid.
    pub width: f64,
    pub height: f64,
    pub walls: Vec<Wall>,
    pub doors: Vec<Opening>,
    pub exits: Vec<Opening>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub windows: Vec<super::WindowOpening>,
    #[serde(
        default,
        deserialize_with = "super::windows::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub window_escape_context: Option<super::WindowEscapeContext>,
    pub spawn_zones: Vec<SpawnZone>,
    pub blocked_exit_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "super::AgentAwareness::is_default")]
    pub awareness: super::AgentAwareness,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub opening_events: Vec<super::OpeningStateChange>,
    pub obstructions: Vec<Obstruction>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stair_areas: Vec<StairArea>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tornado_zones: Vec<Obstruction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disaster: Option<super::Disaster>,
    pub agent_radius: f64,
    pub time_step_seconds: f64,
    pub seed: u64,
    pub max_steps: u32,
}

// Missing names are permitted; a present name must be a string, not null.
pub(super) fn deserialize_name<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}

fn positive(value: f64, maximum: f64) -> bool {
    value.is_finite() && value > 0.0 && value <= maximum
}

fn rectangles_overlap(a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)) -> bool {
    a.0 < b.0 + b.2 && b.0 < a.0 + a.2 && a.1 < b.1 + b.3 && b.1 < a.1 + a.3
}

// Segment/rectangle intersection, used only to validate spawn areas.
fn wall_intersects_rectangle(wall: &Wall, rectangle: (f64, f64, f64, f64)) -> bool {
    let padding = wall.thickness / 2.0;
    let (left, top) = (rectangle.0 - padding, rectangle.1 - padding);
    let (right, bottom) = (
        rectangle.0 + rectangle.2 + padding,
        rectangle.1 + rectangle.3 + padding,
    );
    let (dx, dy) = (wall.end.x - wall.start.x, wall.end.y - wall.start.y);
    let (mut enter, mut leave) = (0.0_f64, 1.0_f64);
    for (p, q) in [
        (-dx, wall.start.x - left),
        (dx, right - wall.start.x),
        (-dy, wall.start.y - top),
        (dy, bottom - wall.start.y),
    ] {
        if p.abs() < 1e-12 {
            if q < 0.0 {
                return false;
            }
        } else {
            let ratio = q / p;
            if p < 0.0 {
                enter = enter.max(ratio);
            } else {
                leave = leave.min(ratio);
            }
            if enter > leave {
                return false;
            }
        }
    }
    true
}

impl BuildingScenario {
    fn contains(&self, point: Point) -> bool {
        point.x.is_finite()
            && point.y.is_finite()
            && point.x >= 0.0
            && point.y >= 0.0
            && point.x <= self.width
            && point.y <= self.height
    }

    fn contains_rectangle(&self, x: f64, y: f64, width: f64, height: f64) -> bool {
        positive(width, 1000.0)
            && positive(height, 1000.0)
            && self.contains(Point { x, y })
            && self.contains(Point {
                x: x + width,
                y: y + height,
            })
    }

    pub fn validate(&self) -> Result<(), String> {
        if !positive(self.width, 1000.0) || !positive(self.height, 1000.0) {
            return Err("workspace dimensions must be finite and between 0 and 1000 metres".into());
        }
        if !positive(self.agent_radius, 2.0) || !positive(self.time_step_seconds, 1.0) {
            return Err(
                "agent_radius must be in (0, 2] metres and time_step_seconds in (0, 1]".into(),
            );
        }
        if self.seed > 9_007_199_254_740_991 || !(1..=100_000).contains(&self.max_steps) {
            return Err(
                "seed must be JavaScript-safe; max_steps must be between 1 and 100000".into(),
            );
        }
        if self.walls.len() > 500
            || self.doors.len() > 1000
            || self.exits.is_empty()
            || self.exits.len() > 1000
            || self.spawn_zones.is_empty()
            || self.spawn_zones.len() > 100
            || self.obstructions.len() > 100
            || self.stair_areas.len() > 100
<<<<<<< HEAD
            || self.windows.len() > 100
=======
            || self.tornado_zones.len() > 100
>>>>>>> connor/catastrophes
        {
            return Err("require 1–1000 exits and 1–100 spawn zones; limits are 500 walls, 1000 doors, 100 obstructions, and 100 stair areas".into());
        }
        for name in self
            .walls
            .iter()
            .map(|v| &v.name)
            .chain(self.doors.iter().map(|v| &v.name))
            .chain(self.exits.iter().map(|v| &v.name))
            .chain(self.windows.iter().map(|v| &v.name))
            .chain(self.spawn_zones.iter().map(|v| &v.name))
            .chain(self.obstructions.iter().map(|v| &v.name))
            .chain(self.stair_areas.iter().map(|v| &v.name))
            .chain(self.tornado_zones.iter().map(|v| &v.name))
            .flatten()
        {
            if name
                .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
                .is_empty()
                || name.chars().count() > 80
            {
                return Err("object names must be nonblank and at most 80 characters".into());
            }
        }
        let mut ids = HashSet::new();
        for id in self
            .walls
            .iter()
            .map(|v| &v.id)
            .chain(self.doors.iter().map(|v| &v.id))
            .chain(self.exits.iter().map(|v| &v.id))
            .chain(self.windows.iter().map(|v| &v.id))
            .chain(self.spawn_zones.iter().map(|v| &v.id))
            .chain(self.obstructions.iter().map(|v| &v.id))
            .chain(self.stair_areas.iter().map(|v| &v.id))
            .chain(self.tornado_zones.iter().map(|v| &v.id))
        {
            if id.trim().is_empty() || id.chars().count() > 64 || !ids.insert(id) {
                return Err(
                    "all element IDs must be unique, nonblank, and at most 64 characters".into(),
                );
            }
        }
        for wall in &self.walls {
            if !self.contains(wall.start)
                || !self.contains(wall.end)
                || wall.length() < 0.1
                || !positive(wall.thickness, 2.0)
            {
                return Err("walls need in-bounds endpoints, length at least 0.1 m, and thickness in (0, 2] m".into());
            }
        }
        let walls: HashMap<_, _> = self.walls.iter().map(|wall| (&wall.id, wall)).collect();
        let mut openings: HashMap<&str, Vec<(f64, f64)>> = HashMap::new();
        let window_openings: Vec<_> = self
            .windows
            .iter()
            .map(|w| Opening {
                id: w.id.clone(),
                name: w.name.clone(),
                wall_id: w.wall_id.clone(),
                offset: w.offset,
                width: w.width,
            })
            .collect();
        for opening in self.doors.iter().chain(&self.exits).chain(&window_openings) {
            let Some(wall) = walls.get(&opening.wall_id) else {
                return Err("openings must reference an existing wall".into());
            };
            if !opening.offset.is_finite()
                || opening.offset < 0.0
                || !positive(opening.width, 1000.0)
                || opening.offset + opening.width > wall.length() + 1e-8
            {
                return Err("opening offsets and widths must fit along their wall".into());
            }
            let intervals = openings.entry(&opening.wall_id).or_default();
            let end = opening.offset + opening.width;
            if intervals
                .iter()
                .any(|&(start, stop)| opening.offset < stop - 1e-8 && start < end - 1e-8)
            {
                return Err(
                    "door, exit and window openings on the same wall must not overlap".into(),
                );
            }
            intervals.push((opening.offset, end));
        }
        if let Some(context) = &self.window_escape_context {
            if !context.floor_elevation_metres.is_finite()
                || !(0.0..=1000.0).contains(&context.floor_elevation_metres)
                || !positive(context.required_clear_height_metres, 1000.0)
            {
                return Err("window escape context needs a finite nonnegative elevation and positive required height".into());
            }
        }
        for window in &self.windows {
            if let Some(escape) = &window.emergency_escape {
                if !positive(escape.clear_width_metres, window.width)
                    || !positive(escape.clear_height_metres, 1000.0)
                    || !escape.preparation_seconds.is_finite()
                    || !(0.0..=100000.0).contains(&escape.preparation_seconds)
                    || !positive(escape.traversal_seconds, 100000.0)
                    || (escape.preparation_seconds / self.time_step_seconds).ceil()
                        > f64::from(u32::MAX - 100_000)
                    || (escape.traversal_seconds / self.time_step_seconds).ceil()
                        > f64::from(u32::MAX - 100_000)
                    || ![-1, 1].contains(&escape.exterior_side)
                {
                    return Err("invalid window escape dimensions, timing or exterior side".into());
                }
            }
        }
        let exit_ids: HashSet<_> = self.exits.iter().map(|exit| &exit.id).collect();
        let blocked: HashSet<_> = self.blocked_exit_ids.iter().collect();
        if blocked.len() != self.blocked_exit_ids.len()
            || blocked.iter().any(|id| !exit_ids.contains(id))
        {
            return Err("blocked_exit_ids must reference distinct existing exits".into());
        }
        for range in [
            self.awareness.sight_range_metres,
            self.awareness.communication_range_metres,
        ] {
            if !range.is_finite() || !(0.0..=1000.0).contains(&range) {
                return Err("awareness ranges must be finite and between 0 and 1000 metres".into());
            }
        }
        let opening_ids: HashSet<_> = self
            .doors
            .iter()
            .chain(&self.exits)
            .map(|o| &o.id)
            .collect();
        let mut seen_events = HashSet::new();
        if self.opening_events.len() > 1000
            || self
                .opening_events
                .windows(2)
                .any(|pair| pair[0].step > pair[1].step)
        {
            return Err("opening_events must contain at most 1000 events ordered by step".into());
        }
        for event in &self.opening_events {
            if event.step >= self.max_steps
                || !opening_ids.contains(&event.opening_id)
                || !seen_events.insert((event.step, &event.opening_id))
            {
                return Err("opening_events must reference existing openings before max_steps, once per opening per step".into());
            }
        }
        for area in &self.stair_areas {
            if !self.contains_rectangle(area.x, area.y, area.width, area.height)
                || area
                    .orientation_degrees
                    .is_some_and(|angle| ![0, 90, 180, 270].contains(&angle))
            {
                return Err(
                    "stair areas need in-bounds rectangles and orientation 0, 90, 180, or 270"
                        .into(),
                );
            }
        }
        if let Some(disaster) = &self.disaster {
            disaster.validate(self)?;
        }
        for zone in &self.tornado_zones {
            if !self.contains_rectangle(zone.x, zone.y, zone.width, zone.height)
                || zone.width <= 2.0 * self.agent_radius
                || zone.height <= 2.0 * self.agent_radius
            {
                return Err(
                    "tornado zones must fit the workspace and be wider than one occupant".into(),
                );
            }
        }
        if self
            .disaster
            .filter(|d| d.kind == super::DisasterKind::Tornado)
            .is_some_and(|disaster| {
                self.tornado_zones.iter().any(|zone| {
                    let x = disaster.center.x.clamp(zone.x, zone.x + zone.width);
                    let y = disaster.center.y.clamp(zone.y, zone.y + zone.height);
                    (x - disaster.center.x).hypot(y - disaster.center.y)
                        <= disaster.exposure_radius()
                            + self.agent_radius
                            + disaster
                                .dynamics
                                .filter(|d| d.enabled)
                                .map_or(0.0, |d| d.shelter_clearance)
                })
            })
        {
            return Err("tornado zones must be outside the tornado exposure area".into());
        }
        for obstacle in &self.obstructions {
            if !self.contains_rectangle(obstacle.x, obstacle.y, obstacle.width, obstacle.height) {
                return Err("obstructions must be positive, in-bounds rectangles".into());
            }
        }
        let mut rectangles = Vec::new();
        let mut population = 0_u64;
        for zone in &self.spawn_zones {
            let rectangle = (zone.x, zone.y, zone.width, zone.height);
            if !self.contains_rectangle(zone.x, zone.y, zone.width, zone.height)
                || zone.count == 0
                || zone.width < 2.0 * self.agent_radius
                || zone.height < 2.0 * self.agent_radius
                || f64::from(zone.count) * std::f64::consts::PI * self.agent_radius.powi(2)
                    > zone.width * zone.height
            {
                return Err("spawn zones need in-bounds area, positive count, and sufficient area for occupant discs".into());
            }
            if rectangles
                .iter()
                .any(|&other| rectangles_overlap(rectangle, other))
                || self
                    .obstructions
                    .iter()
                    .any(|v| rectangles_overlap(rectangle, (v.x, v.y, v.width, v.height)))
                || self
                    .walls
                    .iter()
                    .any(|wall| wall_intersects_rectangle(wall, rectangle))
            {
                return Err(
                    "spawn zones must not overlap each other, walls, or obstructions".into(),
                );
            }
            rectangles.push(rectangle);
            population += u64::from(zone.count);
        }
        if population > 10_000 {
            return Err("total population must not exceed 10000".into());
        }
        Ok(())
    }
}
