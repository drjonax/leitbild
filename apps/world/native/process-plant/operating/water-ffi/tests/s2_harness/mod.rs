//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#s2-declaration-joined-hot-spine-at-power
//! The S2 gate harness (S2-14), included by `s2_gates.rs`.
//!
//! - [`gates`]: the declaration's numbers read as data, with every unread
//!   declared value listed;
//! - [`receipt`]: the receipt schema and the check that refuses an
//!   incomplete receipt;
//! - [`compose`]: the composition at the hot reference and saved states;
//! - [`run`]: a declared run and its record in the schema's run layout;
//! - [`conservation`]: a run's identities and ledger closures, in the
//!   schema's `identities` and `ledger` sections.
#![allow(dead_code)] // Each test crate (s2_gates, s2_conservation) uses its own subset.
pub mod compare;
pub mod compose;
pub mod conservation;
pub mod gates;
pub mod guards;
pub mod meter;
pub mod outputs;
pub mod receipt;
pub mod run;
pub mod runner;
pub mod sequence;
