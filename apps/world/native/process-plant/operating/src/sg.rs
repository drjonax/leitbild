//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-generation/thermodynamics.md#s2-secondary-block
//! S2 steam-generator secondary owner, one bulk-equilibrium volume per SG.
//!
//! Each SG keeps the selected representation of the SG owner: total water
//! mass and internal energy as differential stocks, pressure and liquid
//! volume as algebraic coordinates of the saturated chart, no riser,
//! downcomer, separator or dome. Heat reaches the water only through the
//! developed-length metal, whose films the joined solids own. The S2
//! boundaries are the recorded selections: the constant A/B steam demand
//! through the pickup gas (F2 (a)) with its STOP ramp at the turbine trip
//! (G2), the inventory-holding feed (F3 (a)) and two spring reliefs per SG
//! with the full-lift branch switch (F4 (a), H5) and the disc seat.
//!
//! [`secondary`] implements the joined `Secondary` block; [`relief`] is the
//! valve characteristic; [`tube`] is the tube heat path as a tested function
//! for zero-time receipts; [`packet`] is the strict compiler's typed section.
pub mod packet;
pub mod relief;
pub mod secondary;
pub mod tube;

pub use relief::{Branch, Characteristic, Threshold, Transition, Valve};
pub use secondary::{Boundary, Derived, Properties, Secondaries, SteamGenerator, chart};
pub use tube::{PrimaryPort, Segment, Stationary, Tube};
