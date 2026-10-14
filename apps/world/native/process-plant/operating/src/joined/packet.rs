//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#one-actual-package-not-another-plant-definition
//! Typed subset of the compiled spine packet consumed by the joined blocks.
//!
//! The TypeScript compilers own every value. This boundary decodes the hot
//! source, energy, thermal and feedback sections once at composition, with
//! unknown fields refused inside each record so that a renamed compiler
//! field fails loudly. Sibling top-level sections (mechanics, hydraulics,
//! PZR, preparation, provenance) belong to other consumers, chiefly the
//! network's own [`crate::network::packet::Packet`] of the same JSON.
use crate::{kinetics, source_feedback as sf};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Packet {
    pub identity: String,
    pub thermal: Thermal,
    pub hot: Hot,
    pub feedback_metadata: FeedbackMetadata,
    pub feedback_reference: FeedbackReference,
    /// Water owner (network regular cell) of each source region.
    pub source_water: Vec<usize>,
    /// Main flow area of each primary water owner; zero where no wall law
    /// reads a mass flux.
    pub water_flow_area_m2: Vec<f64>,
    pub water_boron_amount_kg_eq: Vec<f64>,
    pub secondary: SecondarySection,
    /// The PZR metal and relief owner's section (G6). A packet compiled
    /// before G6 has none: the PZR owner is then not composed, the cell's
    /// boundary stays closed and a declared relief port refuses.
    #[serde(rename = "pzrMetal")]
    pub pzr_metal: Option<super::pzr::Section>,
}

/// The SG owner's section, read here only for its contact record
/// (`ld01-sg-contact`): the tube steel the joined solids' films share with
/// the secondary contact, and the exchange area their segments must tile.
/// The SG owner decodes and validates the rest of its section.
#[derive(Debug, Deserialize)]
pub struct SecondarySection {
    pub contact: crate::sg::packet::Contact,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hot {
    pub identity: String,
    pub source: Source,
    pub energy: Energy,
    /// The preparation's own primary chart; the joined operator reads the
    /// network's water instead and does not consume this section.
    pub fluid: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub regions: Vec<kinetics::RegionParameters>,
    pub materials: Vec<kinetics::MaterialParameters>,
    pub transfers: Vec<kinetics::Transfer>,
    pub supports: Vec<kinetics::Support>,
    pub inputs: SourceInputs,
    pub exposure_per_population_s_m2: Vec<f64>,
    pub stationary_state: Vec<f64>,
    pub prepared_state: Vec<f64>,
}

/// The prepared constitutive inputs of the kinetics block. Transfer rates,
/// emission and outside fractions are the fixed-pose compiled values; the
/// regional reactivity/source and the fission conversion are recomputed by
/// the source feedback at every evaluation.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceInputs {
    pub regions: Vec<kinetics::RegionInput>,
    pub transfer_rates_per_s: Vec<f64>,
    pub fissions_per_population_s: Vec<f64>,
    pub emission_fractions: Vec<f64>,
    pub outside_fractions: Vec<f64>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Group {
    pub decay_per_s: f64,
    pub retained_joules_per_event: f64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Energy {
    pub fission_joules_per_event: f64,
    pub fission_cross_section_m2: f64,
    pub fertile_cross_section_m2: f64,
    pub fertile_binding_joules_per_capture: f64,
    pub xenon_binding_joules_per_capture: f64,
    pub samarium_binding_joules_per_capture: f64,
    pub xenon_cross_section_m2: f64,
    pub samarium_cross_section_m2: f64,
    pub binding_coolant_fraction: f64,
    pub prompt_fission_coolant_fraction: f64,
    pub fission_groups: Vec<Group>,
    pub capture_groups: Vec<Group>,
    pub poison_decay_per_s: [f64; 3],
    pub poison_yields_per_fission: [f64; 4],
    pub carriers: Vec<Carrier>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Carrier {
    pub id: String,
    pub fuel_store_ids: [String; 2],
    pub fuel_node_fractions: [f64; 2],
    pub clad_store_id: String,
    pub original_fissile_atoms: f64,
    pub original_fertile_atoms: f64,
    pub fissile_atoms: f64,
    pub fertile_atoms: f64,
    pub spent_fissions: f64,
    pub capture_product_atoms: f64,
    pub expected_exposure_per_m2_s: f64,
    pub expected_fissions_per_s: f64,
    pub expected_fuel_w: f64,
    pub expected_coolant_w: f64,
    /// 23 fission-product then 2 fertile-capture energy stores (J).
    pub stores_j: Vec<f64>,
    /// I-135, Xe-135, Pm-149, Sm-149 nuclei.
    pub poison_atoms: [f64; 4],
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Thermal {
    pub identity: String,
    pub coefficients: serde_json::Value,
    pub fuel_bands: Vec<FuelBand>,
    pub helium: Vec<Helium>,
    pub core_contacts: Vec<CoreContact>,
    pub passive_contacts: Vec<PassiveContact>,
    pub plenum_contacts: Vec<PlenumContact>,
    pub sg_segments: Vec<SgSegment>,
    pub water: Vec<WaterOwner>,
    pub secondaries: Vec<SecondaryStock>,
    pub passive_stores: Vec<PassiveStore>,
    pub direct_water_source_w: Vec<f64>,
    pub source_total_w: f64,
    pub surface_algebraic_count: usize,
    pub scope: String,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Geometry {
    pub fuel_radius_m: f64,
    pub clad_inner_radius_m: f64,
    pub clad_outer_radius_m: f64,
    pub rod_length_m: f64,
    pub rods: f64,
    pub helium_volume_m3: f64,
    pub helium_nr_j_k: f64,
    pub accommodation: f64,
    pub fuel_emissivity: f64,
    pub clad_emissivity: f64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FuelBand {
    pub id: String,
    pub helium: usize,
    pub fuel_store_ids: [String; 2],
    pub clad_store_id: String,
    pub fuel_temperatures_k: [f64; 2],
    pub clad_temperature_k: f64,
    pub fuel_masses_kg: [f64; 2],
    pub fuel_energies_j: [f64; 2],
    pub clad_mass_kg: f64,
    pub clad_energy_j: f64,
    /// Prepared receipt only; the current source is recomputed.
    pub source_w: [f64; 2],
    /// Unsolved initial guesses of fuel surface, clad inner and clad outer.
    pub surface_seed_k: [f64; 3],
    pub geometry: Geometry,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Helium {
    pub id: String,
    pub volume_m3: f64,
    pub nr_j_k: f64,
    pub temperature_k: f64,
    pub energy_j: f64,
    pub capacity_j_k: f64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoreContact {
    pub band: usize,
    pub water: usize,
    pub area_m2: f64,
    pub hydraulic_diameter_m: f64,
    pub flow_area_m2: f64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PassiveContact {
    pub store_id: String,
    pub water: usize,
    pub area_m2: f64,
    pub wall_log_radius_m: f64,
    pub surface: String,
    pub liquid_h_w_m2_k: f64,
    pub gas_h_w_m2_k: f64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlenumContact {
    pub helium: usize,
    pub store_id: String,
    pub area_m2: f64,
    pub inner_radius_m: f64,
    pub conduction_factor: f64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SgSegment {
    pub id: String,
    pub primary: usize,
    pub secondary: usize,
    pub developed_start_m: f64,
    pub developed_end_m: f64,
    pub area_m2: f64,
    pub thermal_diameter_m: f64,
    pub primary_flow_area_m2: f64,
    pub temperature_k: f64,
    pub energy_j: f64,
    pub capacity_j_k: f64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WaterOwner {
    pub id: String,
    pub pressure_pa: f64,
    pub temperature_k: f64,
    pub volume_m3: f64,
    pub mass_kg: f64,
    pub energy_j: f64,
}

/// The SG secondary preparation (memo §2; owned by the secondary block).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecondaryStock {
    pub id: String,
    pub pressure_pa: f64,
    pub temperature_k: f64,
    pub liquid_volume_m3: f64,
    pub volume_m3: f64,
    pub mass_kg: f64,
    pub energy_j: f64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PassiveStore {
    pub id: String,
    pub material: String,
    pub energy_j: f64,
    pub capacity_j_k: f64,
    pub temperature_k: f64,
    pub mass_kg: f64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FeedbackMetadata {
    pub parameters: sf::Parameters,
    pub regions: Vec<sf::Region>,
    pub materials: Vec<sf::Material>,
    pub supports: Vec<sf::Support>,
}

/// The prepared feedback conditions. Only the rod pose and the source
/// capsule age are consumed: every other condition is recomputed from the
/// current state at each evaluation.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FeedbackReference {
    #[serde(rename = "fuelTemperature_K")]
    pub fuel_temperature_k: Vec<f64>,
    #[serde(rename = "waterDensity_kg_m3")]
    pub water_density_kg_m3: Vec<f64>,
    #[serde(rename = "pressure_Pa")]
    pub pressure_pa: Vec<f64>,
    #[serde(rename = "moderatorTemperature_K")]
    pub moderator_temperature_k: Vec<f64>,
    #[serde(rename = "boron_ppmEq")]
    pub boron_ppm_eq: Vec<f64>,
    #[serde(rename = "achievedRodTravel_m")]
    pub achieved_rod_travel_m: Vec<f64>,
    #[serde(rename = "fissileAtoms")]
    pub fissile_atoms: Vec<f64>,
    #[serde(rename = "xenonAtoms")]
    pub xenon_atoms: Vec<f64>,
    #[serde(rename = "samariumAtoms")]
    pub samarium_atoms: Vec<f64>,
    #[serde(rename = "captureLossChange_m2")]
    pub capture_loss_change_m2: Vec<f64>,
    #[serde(rename = "capsuleAge_s")]
    pub capsule_age_s: f64,
}
