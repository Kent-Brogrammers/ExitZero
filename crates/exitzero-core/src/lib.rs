//! ExitZero's shared simulation, analysis, and continuous-geometry contracts.
//!
//! Synchronous entry points run without an HTTP server, display, or async runtime.
//! Application hosts own worker admission, live pacing, and output transport.

pub mod models;
pub mod optimization;
pub mod simulation;
pub mod stress_testing;
