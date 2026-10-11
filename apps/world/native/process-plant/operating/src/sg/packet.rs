//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-generation/thermodynamics.md#s2-secondary-block
//! Typed `secondary` section of the joined packet, and the separate probe
//! section of zero-time receipts. The TypeScript strict compiler
//! (`reference-design-operating-sg.ts`) owns every value; this boundary
//! validates shapes and refuses unknown fields. Values derived from a
//! selection and a law (the relief's effective area, the feed enthalpy) are
//! derived natively with the runtime law, once.
use serde::Deserialize;
use serde_json::Value;

/// The joined packet's `secondary` section.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Section {
    pub scope: String,
    /// In the joined packet's `thermal.secondaries` order.
    #[serde(rename = "steamGenerators")]
    pub steam_generators: Vec<SteamGenerator>,
    pub relief: Relief,
    pub feed: Feed,
    #[serde(rename = "steamAdmission")]
    pub steam_admission: SteamAdmission,
    /// The SG contact law's exchange area and wall constants
    /// (`ld01-sg-contact`), read once for the joined solids' films.
    pub contact: Contact,
    /// Consumed pages and source hashes; not read by the block.
    pub provenance: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SteamGenerator {
    pub id: String,
    /// Total free secondary volume, m³.
    #[serde(rename = "volume_m3")]
    pub volume_m3: f64,
    /// Constant S2 steam demand through the pickup gas (F2 (a)), kg/s.
    #[serde(rename = "steamDemand_kg_s")]
    pub steam_demand_kg_s: f64,
    /// Liquid volume at which the fold crown first uncovers, m³.
    #[serde(rename = "crownLiquidVolume_m3")]
    pub crown_liquid_volume_m3: f64,
    /// Liquid volume at which the upper pickup first covers, m³.
    #[serde(rename = "pickupLiquidVolume_m3")]
    pub pickup_liquid_volume_m3: f64,
    pub reliefs: Vec<Valve>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Valve {
    pub id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Relief {
    #[serde(rename = "crackPressure_Pa")]
    pub crack_pressure_pa: f64,
    #[serde(rename = "fullLiftPressure_Pa")]
    pub full_lift_pressure_pa: f64,
    #[serde(rename = "reseatPressure_Pa")]
    pub reseat_pressure_pa: f64,
    #[serde(rename = "liftLag_s")]
    pub lift_lag_s: f64,
    /// A closing disc seats when its lift falls to `exp(-n)` of full lift,
    /// `n` of the lag's own time constants (lead decision).
    #[serde(rename = "seatLagTimeConstants")]
    pub seat_lag_time_constants: f64,
    #[serde(rename = "backPressure_Pa")]
    pub back_pressure_pa: f64,
    /// F4 (a) with H5: the memory switches when the inlet reaches full lift.
    #[serde(rename = "descendingSwitch")]
    pub descending_switch: DescendingSwitch,
    pub rating: Rating,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub enum DescendingSwitch {
    #[serde(rename = "inletAtFullLift")]
    InletAtFullLift,
}

/// The sizing point that fixes each valve's effective discharge area.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rating {
    #[serde(rename = "massFlow_kg_s")]
    pub mass_flow_kg_s: f64,
    #[serde(rename = "inletPressure_Pa")]
    pub inlet_pressure_pa: f64,
    pub fluid: RatingFluid,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub enum RatingFluid {
    #[serde(rename = "saturatedVapor")]
    SaturatedVapor,
}

/// F3 (a): feed equals steam plus relief outflow, at the recorded state.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Feed {
    pub rule: FeedRule,
    #[serde(rename = "pressure_Pa")]
    pub pressure_pa: f64,
    #[serde(rename = "temperature_K")]
    pub temperature_k: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub enum FeedRule {
    #[serde(rename = "inventoryHolding")]
    InventoryHolding,
}

/// The turbine admission the demand follows after the manual turbine TRIP:
/// the STOP's linear travel to closed.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SteamAdmission {
    #[serde(rename = "stopTravel_s")]
    pub stop_travel_s: f64,
}

/// The SG contact law's exchange area per SG and its wall constants.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Contact {
    #[serde(rename = "exchangeArea_m2")]
    pub exchange_area_m2: f64,
    pub emissivity: f64,
    #[serde(rename = "steelConductivity_W_mK")]
    pub steel_conductivity_w_mk: f64,
    #[serde(rename = "steelDensity_kg_m3")]
    pub steel_density_kg_m3: f64,
    #[serde(rename = "steelCp_J_kgK")]
    pub steel_cp_j_kgk: f64,
}

/// Inputs of zero-time receipts and isolated probes only, never of the
/// joined operator: the selected hot preparation, the held SG primary cell
/// and the tube heat path's geometry and constants. The joined operator takes
/// the preparation from its thermal section and owns the metal and films.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Probe {
    pub preparation: Preparation,
    pub primary: Primary,
    pub tube: Tube,
    pub segments: Vec<Segment>,
    pub provenance: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preparation {
    #[serde(rename = "secondaryPressure_Pa")]
    pub secondary_pressure_pa: f64,
    #[serde(rename = "liquidVolume_m3")]
    pub liquid_volume_m3: f64,
    /// Metal starts at the midpoint of this temperature and the prepared
    /// secondary saturation temperature.
    #[serde(rename = "metalColdTemperature_K")]
    pub metal_cold_temperature_k: f64,
}

/// The prepared SG primary cell held as a probe boundary.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Primary {
    #[serde(rename = "pressure_Pa")]
    pub pressure_pa: f64,
    #[serde(rename = "temperature_K")]
    pub temperature_k: f64,
    #[serde(rename = "flowArea_m2")]
    pub flow_area_m2: f64,
    /// Per SG, in the section's order.
    #[serde(rename = "massFlow_kg_s")]
    pub mass_flow_kg_s: Vec<f64>,
}

/// The tube path's effective thermal diameter (`reference-operating-thermal`).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tube {
    #[serde(rename = "thermalDiameter_m")]
    pub thermal_diameter_m: f64,
}

/// One developed-length metal segment, the same for every SG.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Segment {
    #[serde(rename = "developedStart_m")]
    pub developed_start_m: f64,
    #[serde(rename = "developedEnd_m")]
    pub developed_end_m: f64,
    #[serde(rename = "exchangeArea_m2")]
    pub exchange_area_m2: f64,
    #[serde(rename = "capacity_J_K")]
    pub capacity_j_k: f64,
}
