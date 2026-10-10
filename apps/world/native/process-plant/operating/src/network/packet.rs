//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hydraulics.md#actual-finite-geometry-and-force-placement
//! Typed subset of the compiled owner packet consumed by the network.
//!
//! The TypeScript input compilers own every value; this boundary only
//! validates shapes. Unknown sibling packet fields belong to other consumers.
use crate::{
    hydraulics::Section,
    local_flow::{MomentumSupport, PressureSegment},
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Packet {
    pub mechanics: Mechanics,
    pub thermal: Thermal,
    pub water_boron_amount_kg_eq: Vec<f64>,
    pub external_ports: ExternalPorts,
    pub pzr: Pzr,
    pub hydraulics: Hydraulics,
    pub preparation: Preparation,
}
#[derive(Debug, Deserialize)]
pub struct Preparation {
    #[serde(rename = "operatingPoint")]
    pub operating_point: OperatingPoint,
}
/// Declared prepared-state selections compiled from their wiki owners.
#[derive(Debug, Deserialize)]
pub struct OperatingPoint {
    #[serde(rename = "pzrRoofPressure_Pa")]
    pub pzr_roof_pressure_pa: f64,
    #[serde(rename = "pzrRoofElevation_m")]
    pub pzr_roof_elevation_m: f64,
    /// Indicated level above the PZR bottom datum `pzr_bottom_elevation_m`.
    #[serde(rename = "pzrLevel_m")]
    pub pzr_level_m: f64,
    #[serde(rename = "pzrBottomElevation_m")]
    pub pzr_bottom_elevation_m: f64,
    /// The only selected request is the nominal speed of `hydraulics.pump`.
    #[serde(rename = "rcpSpeedRequest")]
    pub rcp_speed_request: String,
}
#[derive(Debug, Deserialize)]
pub struct Mechanics {
    pub regions: Vec<Region>,
    pub faces: Vec<FacePacket>,
    pub force_projection: Vec<FaceProjection>,
    pub section_force_projection: Vec<SectionProjection>,
}
#[derive(Debug, Deserialize)]
pub struct Region {
    pub id: String,
    pub volume_m3: f64,
    pub elevation_m: f64,
}
#[derive(Debug, Deserialize)]
pub struct FacePacket {
    pub id: String,
    pub from: usize,
    pub to: usize,
    pub flow_area_m2: f64,
    pub supports: Vec<MomentumSupport>,
    pub pressure_segments: Vec<PressureSegment>,
}
#[derive(Debug, Deserialize)]
pub struct FaceProjection {
    pub face: usize,
    pub region: usize,
    pub coefficient_per_m2: f64,
    pub normal: [f64; 2],
}
#[derive(Debug, Deserialize)]
pub struct SectionProjection {
    pub face: usize,
    pub section: usize,
    pub coefficient: f64,
}
#[derive(Debug, Deserialize)]
pub struct Thermal {
    pub water: Vec<WaterOwner>,
}
#[derive(Debug, Deserialize)]
pub struct WaterOwner {
    pub pressure_pa: f64,
    pub temperature_k: f64,
    pub mass_kg: f64,
    pub energy_j: f64,
}
#[derive(Debug, Deserialize)]
pub struct ExternalPorts {
    pub surge_stock: SurgeStock,
}
#[derive(Debug, Deserialize)]
pub struct SurgeStock {
    #[serde(rename = "pressure_Pa")]
    pub pressure_pa: f64,
    #[serde(rename = "temperature_K")]
    pub temperature_k: f64,
    pub mass_kg: f64,
    #[serde(rename = "internalEnergy_J")]
    pub internal_energy_j: f64,
    #[serde(rename = "absorberTracer_kgEq")]
    pub absorber_tracer_kg_eq: f64,
}
#[derive(Debug, Deserialize)]
pub struct Pzr {
    pub regions: Vec<PzrRegion>,
    pub faces: Vec<PzrFace>,
    pub selection: PzrSelection,
}
#[derive(Debug, Deserialize)]
pub struct PzrWater {
    #[serde(rename = "T")]
    pub temperature_k: f64,
}
#[derive(Debug, Deserialize)]
pub struct PzrRegion {
    #[serde(rename = "initialPhase")]
    pub initial_phase: String,
    #[serde(rename = "commonPressure_Pa")]
    pub common_pressure_pa: f64,
    pub water: PzrWater,
    pub mass_kg: f64,
    #[serde(rename = "liquidEnergy_J")]
    pub liquid_energy_j: Option<f64>,
    #[serde(rename = "vaporEnergy_J")]
    pub vapor_energy_j: Option<f64>,
    #[serde(rename = "absorberTracer_kgEq")]
    pub absorber_tracer_kg_eq: f64,
    pub volume_m3: f64,
    #[serde(rename = "axialArea_m2")]
    pub axial_area_m2: f64,
    pub top_m: f64,
    pub bottom_m: f64,
    #[serde(rename = "solidPerimeter_m")]
    pub solid_perimeter_m: f64,
    pub elevation_m: f64,
}
#[derive(Debug, Deserialize)]
pub struct PzrFace {
    pub from: usize,
    pub to: usize,
    pub area_m2: f64,
    pub distance_m: f64,
    pub normal: [f64; 2],
}
#[derive(Debug, Deserialize)]
pub struct PzrSelection {
    #[serde(rename = "interfacialLength_m")]
    pub interfacial_length_m: f64,
    #[serde(rename = "solidRoughness_m")]
    pub solid_roughness_m: f64,
}
#[derive(Debug, Deserialize)]
pub struct Hydraulics {
    pub pump: Pump,
    pub sections: Vec<SectionEntry>,
}
#[derive(Debug, Deserialize)]
pub struct Pump {
    #[serde(rename = "rotorInertia_kg_m2")]
    pub rotor_inertia_kg_m2: f64,
    #[serde(rename = "drag_Nm_per_rad_s")]
    pub drag_nm_per_rad_s: f64,
    #[serde(rename = "referenceOmega_rad_s")]
    pub reference_omega_rad_s: f64,
    #[serde(rename = "nominalFluidPower_W")]
    pub nominal_fluid_power_w: f64,
    #[serde(rename = "driveTrackingTime_s")]
    pub drive_tracking_time_s: f64,
    #[serde(rename = "driveTorqueCapFactor")]
    pub drive_torque_cap_factor: f64,
    #[serde(rename = "driveEfficiency")]
    pub drive_efficiency: f64,
}
#[derive(Debug, Deserialize)]
pub struct SectionEntry {
    pub region: usize,
    pub parameters: Section,
}
