use super::{BuildingScenario, Point};
use serde::{Deserialize, Serialize};

/// Optional fictional Halloween mode. Speeds and distances use metres/seconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PursuitConfig {
    pub stalker_start: Point,
    pub stalker_speed: f64,
    pub survivor_speed: f64,
    pub capture_radius: f64,
    pub avoidance_radius: f64,
}

impl PursuitConfig {
    pub fn validate(&self, building: &BuildingScenario) -> Result<(), String> {
        let point = self.stalker_start;
        if !point.x.is_finite()
            || !point.y.is_finite()
            || point.x < 0.0
            || point.y < 0.0
            || point.x > building.width
            || point.y > building.height
            || !self.stalker_speed.is_finite()
            || !(0.1..=3.0).contains(&self.stalker_speed)
            || !self.survivor_speed.is_finite()
            || !(0.1..=3.0).contains(&self.survivor_speed)
            || !self.capture_radius.is_finite()
            || self.capture_radius < 2.0 * building.agent_radius
            || self.capture_radius > 2.0 * building.agent_radius + 1.0
            || !self.avoidance_radius.is_finite()
            || self.avoidance_radius < self.capture_radius
            || self.avoidance_radius > 20.0
        {
            return Err("pursuit requires an in-bounds stalker start, speeds in [0.1, 3] m/s, a body-sized capture radius, and avoidance radius up to 20 m".into());
        }
        if building.disaster.is_some()
            || building
                .spawn_zones
                .iter()
                .map(|z| u64::from(z.count))
                .sum::<u64>()
                > 64
        {
            return Err("Halloween pursuit is a separate mode, with at most 64 survivors and no simultaneous disaster".into());
        }
        if building
            .windows
            .iter()
            .any(|w| w.emergency_escape.as_ref().is_some_and(|e| e.enabled))
        {
            return Err("Halloween pursuit currently uses doors and exits; emergency window service is available in ordinary evacuation mode".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CaughtAgent {
    pub agent_id: u32,
    pub step: u32,
    /// Exact accepted position when caught; absent in older recordings.
    #[serde(
        default,
        deserialize_with = "super::windows::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub position: Option<Point>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PursuitEventType {
    Sighting,
    Warning,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PursuitEvent {
    pub step: u32,
    pub event_type: PursuitEventType,
    pub sender_id: u32,
    pub recipient_ids: Vec<u32>,
    /// Observed/reported position, never an unseen update of the stalker.
    pub position: Point,
}

/// Survivors stay in frame.agents; the stalker is a separate actor and is never
/// counted as an occupant or an evacuation. Caught IDs are cumulative.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PursuitFrame {
    pub stalker: Point,
    pub escaped: u32,
    pub caught: Vec<CaughtAgent>,
    /// Cumulative, bounded first sightings and successful first warnings.
    #[serde(
        default,
        deserialize_with = "super::windows::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub events: Option<Vec<PursuitEvent>>,
}

impl PursuitFrame {
    pub(super) fn validate_recording(
        &self,
        step: u32,
        total: u32,
        width: f64,
        height: f64,
        previous: Option<&Self>,
    ) -> Result<(), String> {
        let in_bounds = |p: Point| {
            p.x.is_finite()
                && p.y.is_finite()
                && p.x >= 0.0
                && p.y >= 0.0
                && p.x <= width
                && p.y <= height
        };
        let capture_key = |c: &CaughtAgent| (c.agent_id, c.step, c.position.map(|p| (p.x, p.y)));
        if self
            .caught
            .iter()
            .any(|c| c.position.is_some_and(|p| !in_bounds(p)))
            || previous.is_some_and(|p| {
                p.caught.iter().any(|old| {
                    !self
                        .caught
                        .iter()
                        .any(|c| capture_key(c) == capture_key(old))
                })
            })
        {
            return Err("capture positions must be in bounds and remain fixed".into());
        }
        if previous.is_some_and(|p| p.events.is_some() != self.events.is_some()) {
            return Err("pursuit events must be recorded consistently".into());
        }
        let Some(events) = &self.events else {
            return Ok(());
        };
        let key = |e: &PursuitEvent| {
            (
                e.step,
                e.event_type,
                e.sender_id,
                e.recipient_ids.clone(),
                e.position.x,
                e.position.y,
            )
        };
        let old = previous.and_then(|p| p.events.as_deref()).unwrap_or(&[]);
        let mut seen = std::collections::BTreeSet::new();
        let mut warned = std::collections::BTreeSet::new();
        if events.len() > 128
            || events.len() < old.len()
            || old.iter().zip(events).any(|(a, b)| key(a) != key(b))
            || events.windows(2).any(|p| p[0].step > p[1].step)
            || events.iter().any(|e| {
                let recipients: std::collections::BTreeSet<_> =
                    e.recipient_ids.iter().copied().collect();
                e.step > step
                    || e.sender_id >= total
                    || !in_bounds(e.position)
                    || recipients.len() != e.recipient_ids.len()
                    || recipients.contains(&e.sender_id)
                    || recipients.iter().any(|&id| id >= total)
                    || match e.event_type {
                        PursuitEventType::Sighting => {
                            !recipients.is_empty() || !seen.insert(e.sender_id)
                        }
                        PursuitEventType::Warning => {
                            recipients.is_empty() || recipients.iter().any(|&id| !warned.insert(id))
                        }
                    }
            })
        {
            return Err("invalid or repeated pursuit sighting/warning events".into());
        }
        Ok(())
    }
}
