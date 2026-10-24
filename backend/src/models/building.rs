use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cell {
    pub x: u32,
    pub y: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Exit {
    pub id: String,
    pub x: u32,
    pub y: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpawnZone {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildingScenario {
    pub width: u32,
    pub height: u32,
    pub walls: Vec<Cell>,
    pub doors: Vec<Cell>,
    pub exits: Vec<Exit>,
    pub spawn_zones: Vec<SpawnZone>,
    pub blocked_exit_ids: Vec<String>,
    pub blocked_cells: Vec<Cell>,
    pub seed: u64,
    pub max_steps: u32,
}

impl BuildingScenario {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=512).contains(&self.width) || !(1..=512).contains(&self.height) {
            return Err("width and height must be between 1 and 512".into());
        }
        if self.seed > 9_007_199_254_740_991 {
            return Err("seed must be a JavaScript-safe nonnegative integer".into());
        }
        if !(1..=100_000).contains(&self.max_steps) {
            return Err("max_steps must be between 1 and 100000".into());
        }
        let in_bounds = |cell: &Cell| cell.x < self.width && cell.y < self.height;
        for (name, cells) in [
            ("walls", &self.walls),
            ("doors", &self.doors),
            ("blocked_cells", &self.blocked_cells),
        ] {
            let unique: HashSet<_> = cells.iter().copied().collect();
            if cells.iter().any(|cell| !in_bounds(cell)) || unique.len() != cells.len() {
                return Err(format!("{name} must contain unique, in-bounds cells"));
            }
        }
        let walls: HashSet<_> = self.walls.iter().copied().collect();
        let doors: HashSet<_> = self.doors.iter().copied().collect();
        if !walls.is_disjoint(&doors) {
            return Err("doors must not overlap walls; remove wall cells at doorways".into());
        }
        if self.exits.is_empty() {
            return Err("at least one exit is required".into());
        }
        let mut exit_ids = HashSet::new();
        let mut exit_cells = HashSet::new();
        for exit in &self.exits {
            let cell = Cell {
                x: exit.x,
                y: exit.y,
            };
            if exit.id.trim().is_empty()
                || exit.id.chars().count() > 64
                || !exit_ids.insert(&exit.id)
            {
                return Err("exit IDs must be nonempty, unique, and at most 64 characters".into());
            }
            if !in_bounds(&cell)
                || !(exit.x == 0
                    || exit.y == 0
                    || exit.x == self.width - 1
                    || exit.y == self.height - 1)
                || walls.contains(&cell)
                || doors.contains(&cell)
                || !exit_cells.insert(cell)
            {
                return Err("exits must occupy distinct, unobstructed boundary cells".into());
            }
        }
        let blocked_ids: HashSet<_> = self.blocked_exit_ids.iter().collect();
        if blocked_ids.len() != self.blocked_exit_ids.len()
            || blocked_ids.iter().any(|id| !exit_ids.contains(id))
        {
            return Err("blocked_exit_ids must reference distinct existing exits".into());
        }
        if self.spawn_zones.is_empty() {
            return Err("at least one spawn zone is required".into());
        }
        let blocked: HashSet<_> = self.blocked_cells.iter().copied().collect();
        let mut spawn_cells = HashSet::new();
        let mut population = 0_u64;
        for zone in &self.spawn_zones {
            if zone.width == 0
                || zone.height == 0
                || zone.count == 0
                || u64::from(zone.x) + u64::from(zone.width) > u64::from(self.width)
                || u64::from(zone.y) + u64::from(zone.height) > u64::from(self.height)
            {
                return Err("spawn zones must be nonempty rectangles within the building, with positive count".into());
            }
            let mut capacity = 0;
            for y in zone.y..zone.y + zone.height {
                for x in zone.x..zone.x + zone.width {
                    let cell = Cell { x, y };
                    if !spawn_cells.insert(cell) {
                        return Err("spawn zone rectangles must not overlap".into());
                    }
                    if !walls.contains(&cell)
                        && !blocked.contains(&cell)
                        && !exit_cells.contains(&cell)
                    {
                        capacity += 1;
                    }
                }
            }
            if zone.count > capacity {
                return Err(
                    "spawn count exceeds available cells (one initial occupant per valid cell)"
                        .into(),
                );
            }
            population += u64::from(zone.count);
        }
        if population > 10_000 {
            return Err("total population must not exceed 10000".into());
        }
        Ok(())
    }
}
