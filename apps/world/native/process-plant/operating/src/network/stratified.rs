//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressurizer-thermal-state.md#stratified-pzr-cell
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressurizer-thermal-state.md#stratified-pzr-closures
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#bounded-metastable-admission
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hydraulics.md#stratified-ports-and-unilateral-phase-paths
//! The stratified PZR cell: one local-pressure cell with three thermal zones.
//!
//! A non-equilibrium vapor zone `g` sits above two liquid layers: the admitted
//! layer `A` at the bottom, which takes insurge, and the resident layer `R`
//! above it, which carries the free surface. Three saturated, mass-only
//! transit stocks complete the cell: bubbles `b`, spray drops `d` and drop
//! boron `B_d`. There are no internal faces and no internal momenta.
//!
//! The 17 coordinates follow the lead's contract (amendments 2 and 3). The
//! algebraic ones are the roof pressure and the five volumes. The
//! differential ones are the eleven stocks. Given the coordinates, the
//! column is explicit:
//! - each zone's mean density is `M/V`;
//! - heights come from the integral of the piecewise free area;
//! - pressures integrate `ρ g dz` exactly downward from the roof;
//! - each zone's state uses the pressure at its exact volume centroid.
//!
//! The residual pays each zone's volume work once with the rate of its
//! algebraic volume coordinate. It evaluates three caloric inversions and
//! the saturation tuples at `p_s` and `p_AR`. Nothing is iterated, clipped,
//! floored or seeded. Signed Newton trials are evaluated as they are, and
//! metastable departures are reported, never clamped.
//!
//! Ports: the surge mouth at the bottom, and the spray inlet and relief
//! outlet at the roof, which see `p_roof` and the vapor region's content by
//! volume share. Spray joins the drop stock, heated to saturation at entry
//! by condensing vapor from g. The relief is the cell's own restriction:
//! each phase's quasi-steady flux on its native energy adiabat, maximized
//! over the throat pressure, against the receiver's declared backpressure;
//! it makes property calls only while the lift is nonzero. Heater banks
//! deliver their rod sources into the zones they wet by level.
use super::{
    Failure, Properties,
    properties::{self as props, Reuse, Water},
};
use crate::{
    local_flow::{Cell as FaceCell, Phase as FacePhase},
    pzr_field as pf,
    thermal::{Saturation, Scalar, WaterPoint},
};
use serde::Deserialize;

/// Standard gravity of the network's well-balanced face head.
const G: f64 = 9.80665;

/// Number of PZR coordinates, in the contract's order.
pub const COORDINATES: usize = 17;
pub const ROOF_PRESSURE: usize = 0;
pub const VAPOR_VOLUME: usize = 1;
pub const ADMITTED_VOLUME: usize = 2;
pub const RESIDENT_VOLUME: usize = 3;
pub const BUBBLE_VOLUME: usize = 4;
pub const DROP_VOLUME: usize = 5;
pub const VAPOR_MASS: usize = 6;
pub const VAPOR_ENERGY: usize = 7;
pub const ADMITTED_MASS: usize = 8;
pub const ADMITTED_ENERGY: usize = 9;
pub const ADMITTED_BORON: usize = 10;
pub const RESIDENT_MASS: usize = 11;
pub const RESIDENT_ENERGY: usize = 12;
pub const RESIDENT_BORON: usize = 13;
pub const BUBBLE_MASS: usize = 14;
pub const DROP_MASS: usize = 15;
pub const DROP_BORON: usize = 16;
/// IDA id vector of the cell: 0 algebraic, 1 differential.
pub const DIFFERENTIAL: [f64; COORDINATES] = [
    0., 0., 0., 0., 0., 0., 1., 1., 1., 1., 1., 1., 1., 1., 1., 1., 1.,
];

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("stratified PZR: {}", reason.into()))
}
fn recoverable(reason: impl Into<String>) -> Failure {
    Failure::Recoverable(format!("stratified PZR: {}", reason.into()))
}
fn finite(v: Scalar, what: &str) -> Result<Scalar, Failure> {
    if v.value.is_finite() && v.direction.is_finite() {
        Ok(v)
    } else {
        Err(recoverable(format!("nonfinite {what}")))
    }
}
/// `max(x, 0)` with the one-sided directional derivative at exact zero.
fn positive_part(x: Scalar) -> Scalar {
    if x.value > 0. {
        x
    } else if x.value < 0. {
        s(0.)
    } else {
        Scalar::new(0., x.direction.max(0.))
    }
}
fn sqrt(x: Scalar) -> Scalar {
    let v = x.value.sqrt();
    Scalar::new(v, x.direction / (2. * v))
}

/// One band of the free-area profile from the packet's `freeArea`.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Band {
    pub from_m: f64,
    pub to_m: f64,
    pub area_m2: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub enum PortKind {
    /// The surge mouth at the bottom. Insurge enters A and outsurge is
    /// withdrawn selectively from A and R.
    #[serde(rename = "surge")]
    Surge,
    /// The spray inlet at the roof. Arriving liquid joins the drop stock,
    /// heated to saturation at entry by condensing vapor from g.
    #[serde(rename = "spray")]
    Spray,
    /// The relief outlet at the roof. The cell evaluates its restriction
    /// from the device lift and the receiver's backpressure.
    #[serde(rename = "relief")]
    Relief,
}

/// The independent relief device, unchanged from its owner: demand by root
/// on raw PT1, finite lift travel and an effective area per unit lift.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReliefDevice {
    #[serde(rename = "opening_Pa")]
    pub opening_pa: f64,
    #[serde(rename = "reseat_Pa")]
    pub reseat_pa: f64,
    #[serde(rename = "fullStrokes_per_s")]
    pub full_strokes_per_s: f64,
    #[serde(rename = "effectiveAreaPerLift_m2")]
    pub effective_area_per_lift_m2: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Port {
    pub id: String,
    pub kind: PortKind,
    pub elevation_m: f64,
    /// The network face that carries this port's flow; the relief outlet
    /// discharges to a declared receiver boundary and has none.
    pub face: Option<usize>,
    pub bore_m: f64,
    /// Present exactly for a relief port.
    pub relief: Option<ReliefDevice>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tap {
    pub id: String,
    pub elevation_m: f64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Heaters {
    pub bottom_m: f64,
    pub top_m: f64,
    pub displacement_m3: f64,
}

/// The `ld01-pzr-stratified` strict block.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stratified {
    #[serde(rename = "withdrawalScale_m")]
    pub withdrawal_scale_m: f64,
    #[serde(rename = "admittedPreparationThickness_m")]
    pub admitted_preparation_thickness_m: f64,
    /// Exchange coefficient per unit density contrast, not a fluid speed.
    #[serde(rename = "inversionExchangeVelocity_m_s")]
    pub inversion_exchange_velocity_m_s: f64,
    #[serde(rename = "liquidRelaxationTime_s")]
    pub liquid_relaxation_time_s: f64,
    #[serde(rename = "vaporRelaxationTime_s")]
    pub vapor_relaxation_time_s: f64,
    #[serde(rename = "relaxationSensitivity")]
    pub relaxation_sensitivity: [f64; 3],
    #[serde(rename = "bubbleDiameter_m")]
    pub bubble_diameter_m: f64,
    #[serde(rename = "sprayDropDiameter_m")]
    pub spray_drop_diameter_m: f64,
    #[serde(rename = "dropDiameterSensitivity_m")]
    pub drop_diameter_sensitivity_m: [f64; 3],
    #[serde(rename = "resolvabilityFactor")]
    pub resolvability_factor: f64,
}

/// The `ld01-metastable-band` strict block.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Metastable {
    #[serde(rename = "pressureRange_Pa")]
    pub pressure_range_pa: [f64; 2],
    #[serde(rename = "lowerBoundExclusive")]
    pub lower_bound_exclusive: bool,
    #[serde(rename = "liquidSuperheatMax_K")]
    pub liquid_superheat_max_k: f64,
    #[serde(rename = "vaporSubcoolingMax_K")]
    pub vapor_subcooling_max_k: f64,
    #[serde(rename = "trialMax_K")]
    pub trial_max_k: f64,
    #[serde(rename = "creditedMax_K")]
    pub credited_max_k: f64,
    #[serde(rename = "liquidTemperatureMax_K")]
    pub liquid_temperature_max_k: f64,
    #[serde(rename = "liquidPressureCeiling_Pa")]
    pub liquid_pressure_ceiling_pa: f64,
    #[serde(rename = "vaporPressureCeiling_Pa")]
    pub vapor_pressure_ceiling_pa: f64,
}

/// The packet's `pzr.cell` section, embedded unchanged.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Parameters {
    pub index: usize,
    pub bottom_m: f64,
    pub top_m: f64,
    #[serde(rename = "fluidVolume_m3")]
    pub fluid_volume_m3: f64,
    #[serde(rename = "freeArea")]
    pub free_area: Vec<Band>,
    pub ports: Vec<Port>,
    pub taps: Vec<Tap>,
    pub heaters: Heaters,
    pub stratified: Stratified,
    pub metastable: Metastable,
    #[serde(rename = "absorberMassFraction")]
    pub absorber_mass_fraction: f64,
    #[serde(rename = "interfacialLength_m")]
    pub interfacial_length_m: f64,
}

/// Taps the cell reports by identity.
pub const PT1: &str = "PT1";
pub const LT_LOW: &str = "LT.LOW";
pub const LT_HIGH: &str = "LT.HIGH";

fn positive_finite(values: &[(&str, f64)]) -> Result<(), Failure> {
    for (name, v) in values {
        if !(v.is_finite() && *v > 0.) {
            return Err(fatal(format!(
                "{name} must be positive and finite, not {v}"
            )));
        }
    }
    Ok(())
}

impl Parameters {
    /// Shape and consistency admission of the compiled section. Refuses a
    /// `fluidVolume_m3` that differs from the free-area integral by more
    /// than 1e-9 relative.
    pub fn validate(&self) -> Result<(), Failure> {
        positive_finite(&[
            ("interfacialLength_m", self.interfacial_length_m),
            ("fluidVolume_m3", self.fluid_volume_m3),
        ])?;
        if !(self.bottom_m.is_finite() && self.top_m.is_finite() && self.bottom_m < self.top_m) {
            return Err(fatal("bottom_m must lie below top_m"));
        }
        let [first, .., last] = &self.free_area[..] else {
            return Err(fatal("freeArea needs at least two bands"));
        };
        if first.from_m != self.bottom_m || last.to_m != self.top_m {
            return Err(fatal("freeArea must span bottom_m to top_m"));
        }
        let mut integral = 0.;
        for (j, band) in self.free_area.iter().enumerate() {
            positive_finite(&[("freeArea area_m2", band.area_m2)])?;
            if !(band.from_m.is_finite() && band.to_m.is_finite() && band.from_m < band.to_m) {
                return Err(fatal(format!("freeArea band {j} is not ascending")));
            }
            if j > 0 && self.free_area[j - 1].to_m != band.from_m {
                return Err(fatal(format!("freeArea band {j} is not contiguous")));
            }
            integral += band.area_m2 * (band.to_m - band.from_m);
        }
        if (integral - self.fluid_volume_m3).abs() > 1e-9 * self.fluid_volume_m3 {
            return Err(fatal(format!(
                "fluidVolume_m3 {} differs from the freeArea integral {integral}",
                self.fluid_volume_m3
            )));
        }
        let inside = |z: f64| z.is_finite() && z >= self.bottom_m && z <= self.top_m;
        if self.ports.is_empty() {
            return Err(fatal("the cell needs its surge port"));
        }
        for p in &self.ports {
            positive_finite(&[("port bore_m", p.bore_m)])?;
            if !inside(p.elevation_m) {
                return Err(fatal(format!("port {} lies outside the vessel", p.id)));
            }
        }
        for (j, t) in self.taps.iter().enumerate() {
            if !inside(t.elevation_m) {
                return Err(fatal(format!("tap {} lies outside the vessel", t.id)));
            }
            if self.taps[..j].iter().any(|o| o.id == t.id) {
                return Err(fatal(format!("tap {} is declared twice", t.id)));
            }
        }
        for id in [PT1, LT_LOW, LT_HIGH] {
            self.tap(id)?;
        }
        let h = &self.heaters;
        if !(inside(h.bottom_m) && inside(h.top_m) && h.bottom_m <= h.top_m)
            || !(h.displacement_m3.is_finite() && h.displacement_m3 >= 0.)
        {
            return Err(fatal("invalid heater span"));
        }
        let x = &self.stratified;
        positive_finite(&[
            ("withdrawalScale_m", x.withdrawal_scale_m),
            (
                "admittedPreparationThickness_m",
                x.admitted_preparation_thickness_m,
            ),
            (
                "inversionExchangeVelocity_m_s",
                x.inversion_exchange_velocity_m_s,
            ),
            ("liquidRelaxationTime_s", x.liquid_relaxation_time_s),
            ("vaporRelaxationTime_s", x.vapor_relaxation_time_s),
            ("bubbleDiameter_m", x.bubble_diameter_m),
            ("sprayDropDiameter_m", x.spray_drop_diameter_m),
            ("resolvabilityFactor", x.resolvability_factor),
        ])?;
        for v in x
            .relaxation_sensitivity
            .iter()
            .chain(&x.drop_diameter_sensitivity_m)
        {
            positive_finite(&[("sensitivity", *v)])?;
        }
        if !x.relaxation_sensitivity.contains(&1.)
            || !x
                .drop_diameter_sensitivity_m
                .contains(&x.spray_drop_diameter_m)
        {
            return Err(fatal("sensitivity lists must contain the nominal values"));
        }
        let m = &self.metastable;
        positive_finite(&[
            ("liquidSuperheatMax_K", m.liquid_superheat_max_k),
            ("vaporSubcoolingMax_K", m.vapor_subcooling_max_k),
            ("trialMax_K", m.trial_max_k),
            ("creditedMax_K", m.credited_max_k),
            ("liquidTemperatureMax_K", m.liquid_temperature_max_k),
            ("liquidPressureCeiling_Pa", m.liquid_pressure_ceiling_pa),
            ("vaporPressureCeiling_Pa", m.vapor_pressure_ceiling_pa),
        ])?;
        if !(m.pressure_range_pa[0] > 0. && m.pressure_range_pa[0] < m.pressure_range_pa[1]) {
            return Err(fatal("invalid metastable pressure range"));
        }
        if !(self.absorber_mass_fraction.is_finite() && self.absorber_mass_fraction >= 0.) {
            return Err(fatal("absorberMassFraction must be finite and nonnegative"));
        }
        let count = |kind: PortKind| self.ports.iter().filter(|p| p.kind == kind).count();
        if count(PortKind::Surge) != 1 || count(PortKind::Relief) > 1 {
            return Err(fatal("exactly one surge port and at most one relief port"));
        }
        for p in &self.ports {
            let upper = matches!(p.kind, PortKind::Spray | PortKind::Relief);
            if upper && p.elevation_m != self.top_m {
                return Err(fatal(format!("upper port {} must sit at top_m", p.id)));
            }
            if (p.kind == PortKind::Relief) != p.relief.is_some()
                || (p.kind == PortKind::Surge && p.face.is_none())
            {
                return Err(fatal(format!(
                    "port {}: a relief port declares its device and no other port does; the surge port names its face",
                    p.id
                )));
            }
            if let Some(d) = p.relief {
                positive_finite(&[
                    ("relief opening_Pa", d.opening_pa),
                    ("relief reseat_Pa", d.reseat_pa),
                    ("relief fullStrokes_per_s", d.full_strokes_per_s),
                    (
                        "relief effectiveAreaPerLift_m2",
                        d.effective_area_per_lift_m2,
                    ),
                ])?;
                if d.reseat_pa >= d.opening_pa {
                    return Err(fatal("relief reseat must lie below its opening"));
                }
            }
        }
        let thickness = self.bottom_m + x.admitted_preparation_thickness_m;
        if thickness >= self.top_m {
            return Err(fatal("admitted preparation thickness exceeds the vessel"));
        }
        Ok(())
    }

    /// Elevation of a declared tap.
    pub fn tap(&self, id: &str) -> Result<f64, Failure> {
        self.taps
            .iter()
            .find(|t| t.id == id)
            .map(|t| t.elevation_m)
            .ok_or_else(|| fatal(format!("tap {id} is not declared")))
    }
}

/// The verification cases' declared sensitivity families, as their block
/// lists them beside the nominal values.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SensitivityFamilies {
    pub relaxation: Vec<f64>,
    #[serde(rename = "sprayDrop_m")]
    pub spray_drop_m: Vec<f64>,
    pub bubble_m: Vec<f64>,
}

/// One run's sensitivity selection, taken only from the declared lists.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Case {
    /// Factor applied to both relaxation times.
    pub relaxation_factor: f64,
    pub drop_diameter_m: f64,
    pub bubble_diameter_m: f64,
}
impl Case {
    pub fn nominal(parameters: &Parameters) -> Self {
        Self {
            relaxation_factor: 1.,
            drop_diameter_m: parameters.stratified.spray_drop_diameter_m,
            bubble_diameter_m: parameters.stratified.bubble_diameter_m,
        }
    }
}

/// Piecewise free-area geometry: band start, end, area, volume below the
/// band start and first moment `∫ z A dz` below the band start.
#[derive(Clone, Debug)]
struct Geometry {
    bands: Vec<[f64; 5]>,
}
impl Geometry {
    fn new(p: &Parameters) -> Self {
        let mut bands = Vec::with_capacity(p.free_area.len());
        let (mut volume, mut moment) = (0., 0.);
        for b in &p.free_area {
            bands.push([b.from_m, b.to_m, b.area_m2, volume, moment]);
            volume += b.area_m2 * (b.to_m - b.from_m);
            moment += b.area_m2 * (b.to_m * b.to_m - b.from_m * b.from_m) / 2.;
        }
        Self { bands }
    }
    /// Band of an elevation; a boundary is assigned by the direction's
    /// sign; outside the vessel the end band is extended unclipped.
    fn band_at(&self, z: Scalar) -> usize {
        let last = self.bands.len() - 1;
        for (j, b) in self.bands.iter().enumerate() {
            if z.value < b[1] || j == last {
                if j > 0 && z.value == b[0] && z.direction < 0. {
                    return j - 1;
                }
                return j;
            }
        }
        last
    }
    fn area(&self, z: Scalar) -> f64 {
        self.bands[self.band_at(z)][2]
    }
    /// Volume below elevation `z`.
    fn volume(&self, z: Scalar) -> Scalar {
        let [from, _, area, below, _] = self.bands[self.band_at(z)];
        s(below) + s(area) * (z - s(from))
    }
    /// First moment `∫ z A dz` below elevation `z`.
    fn moment(&self, z: Scalar) -> Scalar {
        let [from, _, area, _, below] = self.bands[self.band_at(z)];
        s(below) + s(area / 2.) * (z * z - s(from * from))
    }
    /// Elevation below which the volume is `v`, the inverse of `volume`.
    fn level(&self, v: Scalar) -> Scalar {
        let last = self.bands.len() - 1;
        let mut j = last;
        for (i, b) in self.bands.iter().enumerate() {
            let top = if i == last {
                f64::INFINITY
            } else {
                self.bands[i + 1][3]
            };
            if v.value < top {
                j = if i > 0 && v.value == b[3] && v.direction < 0. {
                    i - 1
                } else {
                    i
                };
                break;
            }
        }
        let [from, _, area, below, _] = self.bands[j];
        s(from) + (v - s(below)) / s(area)
    }
    /// Volume centroid elevation of `[low, high]`.
    fn centroid(&self, low: Scalar, high: Scalar) -> Scalar {
        (self.moment(high) - self.moment(low)) / (self.volume(high) - self.volume(low))
    }
}

/// Typed view of the 17 PZR coordinates (or their rates), physical units.
#[derive(Clone, Copy, Debug)]
pub struct Coordinates {
    pub roof_pressure: Scalar,
    pub vapor_volume: Scalar,
    pub admitted_volume: Scalar,
    pub resident_volume: Scalar,
    pub bubble_volume: Scalar,
    pub drop_volume: Scalar,
    pub vapor_mass: Scalar,
    pub vapor_energy: Scalar,
    pub admitted_mass: Scalar,
    pub admitted_energy: Scalar,
    pub admitted_boron: Scalar,
    pub resident_mass: Scalar,
    pub resident_energy: Scalar,
    pub resident_boron: Scalar,
    pub bubble_mass: Scalar,
    pub drop_mass: Scalar,
    pub drop_boron: Scalar,
}
impl Coordinates {
    pub fn from_slice(v: &[Scalar]) -> Result<Self, Failure> {
        let v: &[Scalar; COORDINATES] = v
            .try_into()
            .map_err(|_| fatal(format!("{} coordinates, not {COORDINATES}", v.len())))?;
        Ok(Self {
            roof_pressure: v[ROOF_PRESSURE],
            vapor_volume: v[VAPOR_VOLUME],
            admitted_volume: v[ADMITTED_VOLUME],
            resident_volume: v[RESIDENT_VOLUME],
            bubble_volume: v[BUBBLE_VOLUME],
            drop_volume: v[DROP_VOLUME],
            vapor_mass: v[VAPOR_MASS],
            vapor_energy: v[VAPOR_ENERGY],
            admitted_mass: v[ADMITTED_MASS],
            admitted_energy: v[ADMITTED_ENERGY],
            admitted_boron: v[ADMITTED_BORON],
            resident_mass: v[RESIDENT_MASS],
            resident_energy: v[RESIDENT_ENERGY],
            resident_boron: v[RESIDENT_BORON],
            bubble_mass: v[BUBBLE_MASS],
            drop_mass: v[DROP_MASS],
            drop_boron: v[DROP_BORON],
        })
    }
    /// Constant coordinates (zero directions) from physical values.
    pub fn values(v: &[f64; COORDINATES]) -> Self {
        Self::from_slice(&v.map(s)).expect("fixed-size coordinates")
    }
    pub fn to_array(&self) -> [Scalar; COORDINATES] {
        [
            self.roof_pressure,
            self.vapor_volume,
            self.admitted_volume,
            self.resident_volume,
            self.bubble_volume,
            self.drop_volume,
            self.vapor_mass,
            self.vapor_energy,
            self.admitted_mass,
            self.admitted_energy,
            self.admitted_boron,
            self.resident_mass,
            self.resident_energy,
            self.resident_boron,
            self.bubble_mass,
            self.drop_mass,
            self.drop_boron,
        ]
    }
}

/// Exact per-matrix property reuse slots. The vapor and resident zones use
/// the two phase slots of `vapor_and_resident`, the admitted zone the
/// liquid slot of `admitted`; `interface` and `boundary` are saturation
/// points for `p_s` and `p_AR`.
#[derive(Clone, Copy, Debug)]
pub struct Slots {
    pub vapor_and_resident: usize,
    pub admitted: usize,
    pub interface: usize,
    pub boundary: usize,
}

/// Property calls one column evaluation made.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Calls {
    pub inversions: usize,
    pub saturations: usize,
}

/// One zone's state at its centroid pressure, with directions.
#[derive(Clone, Copy, Debug)]
pub struct Zone {
    /// Volume-centroid pressure at which the state is evaluated.
    pub pressure: Scalar,
    pub mass: Scalar,
    /// The algebraic volume coordinate.
    pub volume: Scalar,
    pub specific_energy: Scalar,
    pub temperature: Scalar,
    /// IF97 density at the zone state; its row ties it to `mass/volume`.
    pub density: Scalar,
    pub enthalpy: Scalar,
    pub cp: Scalar,
    pub expansion: Scalar,
    pub compressibility: Scalar,
    pub viscosity: Scalar,
    pub conductivity: Scalar,
}
impl Zone {
    fn new(pressure: Scalar, mass: Scalar, volume: Scalar, u: Scalar, q: Water, d: Water) -> Self {
        let f = Scalar::new;
        Self {
            pressure,
            mass,
            volume,
            specific_energy: u,
            temperature: f(q.temperature_k, d.temperature_k),
            density: f(q.density_kg_m3, d.density_kg_m3),
            enthalpy: f(q.enthalpy_j_kg, d.enthalpy_j_kg),
            cp: f(q.cp_j_kg_k, d.cp_j_kg_k),
            expansion: f(q.expansion_per_k, d.expansion_per_k),
            compressibility: f(q.compressibility_per_pa, d.compressibility_per_pa),
            viscosity: f(q.viscosity_pa_s, d.viscosity_pa_s),
            conductivity: f(q.conductivity_w_m_k, d.conductivity_w_m_k),
        }
    }
    fn water(&self) -> WaterPoint {
        WaterPoint {
            density: self.density,
            viscosity: self.viscosity,
            conductivity: self.conductivity,
            cp: self.cp,
            expansion: self.expansion,
            enthalpy: self.enthalpy,
        }
    }
    /// Stagnant zone phase for the reused interface and conduction laws.
    fn phase(&self, boron: Scalar) -> pf::Phase {
        pf::Phase {
            mass: self.mass,
            volume: self.volume,
            temperature: self.temperature,
            water: self.water(),
            velocity: [s(0.); 2],
            boron_mass: boron,
        }
    }
    /// Isentropic compressibility `κ_T − T α²/(ρ c_p)` of the caloric point.
    fn isentropic_compressibility(&self) -> Scalar {
        self.compressibility
            - self.temperature * self.expansion * self.expansion / (self.density * self.cp)
    }
}

/// The explicit column of one coordinate set: heights, hydrostatic
/// pressures, zone states, saturation tuples and volumes.
#[derive(Clone, Copy, Debug)]
pub struct Column {
    pub vapor: Zone,
    pub admitted: Zone,
    pub resident: Zone,
    /// Saturation at the free surface pressure `p_s`.
    pub interface_saturation: Saturation,
    /// Saturation at the A/R boundary pressure `p_AR`.
    pub boundary_saturation: Saturation,
    pub roof_pressure: Scalar,
    /// `p_s = p(z_mix)`.
    pub interface_pressure: Scalar,
    /// `p_AR = p(z_AR)`.
    pub boundary_pressure: Scalar,
    /// Pressure at `bottom_m`.
    pub bottom_pressure: Scalar,
    /// `z_AR = z(V_A)`.
    pub boundary_elevation: Scalar,
    /// `z_mix = z(V_A + V_R + V_b)`.
    pub mixture_elevation: Scalar,
    /// `z(V_A + V_R)`.
    pub collapsed_elevation: Scalar,
    /// Mean density of the vapor region, drops included.
    pub vapor_region_density: Scalar,
    /// Mean density of R's region, bubbles included.
    pub resident_region_density: Scalar,
    /// Mean density of A's region.
    pub admitted_region_density: Scalar,
    /// Volume-centroid elevations of the vapor, A and R regions.
    pub centroid_elevation: [Scalar; 3],
    /// `δ_A = z_AR − bottom`.
    pub admitted_thickness: Scalar,
    /// Selective-withdrawal fraction `φ = δ_A²/(δ_A² + h_w²)`.
    pub withdrawal_fraction: Scalar,
    pub admitted_concentration: Scalar,
    pub resident_concentration: Scalar,
    pub bubble_mass: Scalar,
    pub drop_mass: Scalar,
    pub drop_boron: Scalar,
    /// Algebraic transit volume coordinates.
    pub bubble_volume: Scalar,
    pub drop_volume: Scalar,
    /// Free areas at the free surface and at the A/R boundary.
    pub surface_area_m2: f64,
    pub boundary_area_m2: f64,
    pub top_m: f64,
    pub bottom_m: f64,
    pub calls: Calls,
}
impl Column {
    /// Hydrostatic pressure at a fixed elevation in the column.
    pub fn pressure_at(&self, z: f64) -> Scalar {
        let below = |boundary: Scalar| {
            z < boundary.value || (z == boundary.value && boundary.direction > 0.)
        };
        if !below(self.mixture_elevation) {
            self.roof_pressure + s(G) * self.vapor_region_density * (s(self.top_m) - s(z))
        } else if !below(self.boundary_elevation) {
            self.interface_pressure
                + s(G) * self.resident_region_density * (self.mixture_elevation - s(z))
        } else {
            self.boundary_pressure
                + s(G) * self.admitted_region_density * (self.boundary_elevation - s(z))
        }
    }
    /// Total zone volume plus transit volumes minus the vessel volume.
    pub fn volume_defect(&self, volume_m3: f64) -> Scalar {
        self.vapor.volume
            + self.admitted.volume
            + self.resident.volume
            + self.bubble_volume
            + self.drop_volume
            - s(volume_m3)
    }
}

/// Signed receipt of one port into the cell, in `Parameters::ports` order.
#[derive(Clone, Copy, Debug)]
pub struct Receipt {
    pub mass: Scalar,
    pub enthalpy: Scalar,
    pub boron: Scalar,
}
impl Receipt {
    pub fn zero() -> Self {
        Self {
            mass: s(0.),
            enthalpy: s(0.),
            boron: s(0.),
        }
    }
}

/// External heat into each zone (shell and head contact), W.
#[derive(Clone, Copy, Debug)]
pub struct Heat {
    pub vapor: Scalar,
    pub admitted: Scalar,
    pub resident: Scalar,
}
impl Heat {
    pub fn zero() -> Self {
        Self {
            vapor: s(0.),
            admitted: s(0.),
            resident: s(0.),
        }
    }
}

/// One heater bank's sources, evaluated by the heater owner from its rod
/// metal on the wetted and exposed areas the column gives it
/// ([`Cell::heater_wetting`]). The cell routes them into the zones the rods
/// wet; the metal receives the opposite of every term.
#[derive(Clone, Copy, Debug)]
pub struct HeaterReceipt {
    /// The bank's active span on the plant datum.
    pub bottom_m: f64,
    pub top_m: f64,
    /// Heat delivered on A's and R's wetted contact, W (signed), each from
    /// the wall law at that zone's own state.
    pub wet_heat_w: [Scalar; 2],
    /// Wall-born vapor on A's and R's wetted contact, kg/s, into the bubbles.
    pub wet_vapor_kg_s: [Scalar; 2],
    /// Sensible and radiative heat into the vapor zone on the exposed area, W.
    pub exposed_heat_w: Scalar,
    /// Vapor condensed on the exposed rods, kg/s, entering R.
    pub condensate_kg_s: Scalar,
    /// The condensate's liquid enthalpy at wall temperature, J/kg.
    pub condensate_enthalpy_j_kg: Scalar,
}

/// The relief device state the network retains: achieved lift in [0, 1]
/// and the receiver's backpressure, a declared boundary.
#[derive(Clone, Copy, Debug)]
pub struct ReliefState {
    pub lift: Scalar,
    pub back_pressure_pa: Scalar,
}

/// Everything entering the cell that is not a face receipt.
#[derive(Clone, Debug)]
pub struct Boundary {
    pub heat: Heat,
    pub heaters: Vec<HeaterReceipt>,
    /// One receipt per shell band or head, from the wall owner.
    pub walls: Vec<WallReceipt>,
    /// Present exactly when the cell declares a relief port.
    pub relief: Option<ReliefState>,
}
impl Boundary {
    pub fn closed() -> Self {
        Self {
            heat: Heat::zero(),
            heaters: Vec::new(),
            walls: Vec::new(),
            relief: None,
        }
    }
}

/// A wall element of the PZR: a shell band over a span on the plant datum,
/// or one of the flat heads at `bottom_m` and `top_m`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WallElement {
    Band { bottom_m: f64, top_m: f64 },
    BottomHead,
    TopHead,
}

/// One wall element's sources, evaluated by the wall owner from its metal on
/// the contact [`Cell::wall_wetting`] gives it. The cell routes them; the
/// metal receives the opposite of every term.
#[derive(Clone, Copy, Debug)]
pub struct WallReceipt {
    pub element: WallElement,
    /// Heat into the wetted liquid of A and of R, W (signed).
    pub wet_heat_w: [Scalar; 2],
    /// Wall-born vapor from A's and R's contact, kg/s, into the bubbles.
    pub wet_vapor_kg_s: [Scalar; 2],
    /// Heat into the vapor zone on the dry contact, W (signed).
    pub dry_heat_w: Scalar,
    /// Vapor condensed on the dry contact, kg/s, entering R.
    pub condensate_kg_s: Scalar,
    /// The condensate's liquid enthalpy at wall temperature, J/kg.
    pub condensate_enthalpy_j_kg: Scalar,
}

/// Contact of a wall element with the zones, as fractions of its area that
/// sum to one, and for a shell band its lengths.
#[derive(Clone, Copy, Debug)]
pub struct WallWetting {
    pub admitted_fraction: Scalar,
    pub resident_fraction: Scalar,
    /// Dry contact with the vapor zone.
    pub vapor_fraction: Scalar,
    /// The band's lengths by level; `None` for a head.
    pub band: Option<Wetting>,
}

/// One phase's quasi-steady restriction flux on its energy adiabat.
#[derive(Clone, Copy, Debug)]
pub struct Flux {
    /// Mass flux per unit effective area, kg/(m² s).
    pub mass_flux: Scalar,
    pub throat_pressure_pa: Scalar,
    /// The maximum lies above the backpressure.
    pub choked: bool,
    pub saturation_calls: usize,
    pub inversions: usize,
}

/// The relief outflow of one evaluation, for the receiver's account.
#[derive(Clone, Copy, Debug)]
pub struct ReliefFlow {
    pub effective_area_m2: Scalar,
    pub vapor_kg_s: Scalar,
    pub drop_kg_s: Scalar,
    /// Thermal enthalpy carried out: vapor at g's enthalpy, drops at
    /// `h_f,sat(p_s)`.
    pub enthalpy_w: Scalar,
    pub boron_kg_s: Scalar,
    pub vapor: Option<Flux>,
    pub drop: Option<Flux>,
}

/// A heater bank's contact with the column by level.
#[derive(Clone, Copy, Debug)]
pub struct Wetting {
    /// `f_wet`: wetted length over the bank's span.
    pub wet_fraction: Scalar,
    pub wet_length_m: Scalar,
    pub admitted_length_m: Scalar,
    pub resident_length_m: Scalar,
    pub exposed_length_m: Scalar,
}

/// Discrete relief motion; the harness owns the events between them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReliefMotion {
    Closed,
    Opening,
    Open,
    Closing,
}

/// Root functions of the relief: the demand threshold on raw `p_roof` and,
/// while moving, the distance to the end of travel.
#[derive(Clone, Copy, Debug)]
pub struct ReliefRoots {
    pub demand: Scalar,
    pub travel: Option<Scalar>,
}

/// The mechanical-stop transaction at an end-of-travel root, reported per
/// event.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stop {
    pub motion_before: ReliefMotion,
    pub motion_after: ReliefMotion,
    pub lift_before: f64,
    /// Exactly 1 at full lift or 0 on the seat.
    pub lift_after: f64,
    /// `lift_before − lift_after`, removed by the transaction.
    pub defect: f64,
}

impl ReliefDevice {
    /// Mechanical stop at the travel root located by the harness: an opening
    /// lift is set exactly to 1 and becomes `Open`, a closing lift exactly to
    /// 0 and becomes `Closed`. Refuses a motion without travel, or a lift
    /// farther than `root_bound` from its stop, which is not that root.
    pub fn stop(
        &self,
        motion: ReliefMotion,
        lift: &mut f64,
        root_bound: f64,
    ) -> Result<Stop, Failure> {
        let (end, after) = match motion {
            ReliefMotion::Opening => (1., ReliefMotion::Open),
            ReliefMotion::Closing => (0., ReliefMotion::Closed),
            ReliefMotion::Open | ReliefMotion::Closed => {
                return Err(fatal(format!("relief {motion:?} has no travel to stop")));
            }
        };
        let before = *lift;
        let defect = before - end;
        let beyond = defect.is_nan() || defect.abs() > root_bound;
        if !(root_bound.is_finite() && root_bound >= 0.) || beyond {
            return Err(fatal(format!(
                "relief lift {before} is {defect} from its stop, beyond the root bound {root_bound}"
            )));
        }
        *lift = end;
        Ok(Stop {
            motion_before: motion,
            motion_after: after,
            lift_before: before,
            lift_after: end,
            defect,
        })
    }
    /// Lift rate of a motion state, full strokes per second.
    pub fn lift_rate(&self, motion: ReliefMotion) -> f64 {
        match motion {
            ReliefMotion::Opening => self.full_strokes_per_s,
            ReliefMotion::Closing => -self.full_strokes_per_s,
            ReliefMotion::Closed | ReliefMotion::Open => 0.,
        }
    }
    /// With demand open the root is `p_roof − reseat` (falling through zero
    /// closes); with demand closed `p_roof − opening` (rising opens). While
    /// moving, the travel root reaches zero at the end of travel.
    pub fn roots(
        &self,
        roof_pressure: Scalar,
        lift: Scalar,
        demand_open: bool,
        motion: ReliefMotion,
    ) -> ReliefRoots {
        let threshold = if demand_open {
            self.reseat_pa
        } else {
            self.opening_pa
        };
        ReliefRoots {
            demand: roof_pressure - s(threshold),
            travel: match motion {
                ReliefMotion::Opening => Some(s(1.) - lift),
                ReliefMotion::Closing => Some(lift),
                ReliefMotion::Closed | ReliefMotion::Open => None,
            },
        }
    }
}

/// Internal transfers of one evaluation, for receipts and diagnostics.
#[derive(Clone, Copy, Debug)]
pub struct Flows {
    /// Flashing of A and R into bubbles, kg/s.
    pub admitted_flashing: Scalar,
    pub resident_flashing: Scalar,
    /// Condensation of the vapor zone into drops, kg/s.
    pub vapor_condensation: Scalar,
    pub bubble_rise: Scalar,
    pub bubble: Terminal,
    pub drop_fall: Scalar,
    pub drop_boron_fall: Scalar,
    pub drop: Terminal,
    /// Saturation drift heat of the bubbles (paid by R) and drops (by g), W.
    pub transit_drift: [Scalar; 2],
    /// Vapor condensed onto arriving spray at entry, kg/s (negative flashes).
    pub spray_condensation: Scalar,
    /// The relief outflow, when a relief port is declared.
    pub relief: Option<ReliefFlow>,
    /// `p_s'` along the coordinate rates.
    pub interface_pressure_rate: Scalar,
    /// Free-surface exchange (liquid R to vapor), reused law.
    pub interface: pf::Exchange,
    /// Mass-neutral inversion exchange, kg/s each way.
    pub inversion: Scalar,
    /// Potential densities of A and R at `p_AR`.
    pub potential_density: [Scalar; 2],
    /// Conduction into A from R, W.
    pub conduction: Scalar,
    /// `p_k V_k'` paid in each zone's energy row (g, A, R), W.
    pub work: [Scalar; 3],
    /// The physical right-hand side of every stock row; zero for the
    /// algebraic rows. Energy entries exclude the volume work.
    pub sources: [Scalar; COORDINATES],
}

/// Instantaneous totals for conservation accounting. Every internal
/// transfer has one sender and one recipient, so the totals equal the
/// receipts; the volume work is the hydrostatic remainder.
#[derive(Clone, Copy, Debug)]
pub struct Balance {
    pub mass_kg_s: Scalar,
    /// Zone energy sources, transit energy carried at `h_g`/`h_f(p_s)` and
    /// the transit saturation drift its hosts pay.
    pub energy_w: Scalar,
    pub boron_kg_s: Scalar,
    pub receipt_mass_kg_s: Scalar,
    /// Port enthalpy receipts plus external heat.
    pub receipt_energy_w: Scalar,
    pub receipt_boron_kg_s: Scalar,
    /// `Σ p_k V_k'` over g, A, R, b and d (transit at `p_s`): the column's
    /// gravitational work, reported, not a source.
    pub volume_work_w: Scalar,
}

#[derive(Clone, Copy, Debug)]
pub struct Evaluation {
    /// Scaled rows in coordinate order: the volume row (by fluidVolume_m3),
    /// the three zone and two transit volume rows, then the stock rows.
    pub rows: [Scalar; COORDINATES],
    pub column: Column,
    pub flows: Flows,
    pub balance: Balance,
}

/// A prepared state and the column it evaluates to.
#[derive(Clone, Debug)]
pub struct Preparation {
    pub values: [f64; COORDINATES],
    pub column: Column,
    pub saturation_temperature_k: f64,
    pub pass_changes_pa: Vec<f64>,
}

/// One zone's metastable departure at its own state pressure.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Departure {
    pub pressure_pa: f64,
    pub temperature_k: f64,
    pub saturation_temperature_k: f64,
    /// Signed `T − Tsat(p)`.
    pub departure_k: f64,
    /// Departure into the metastable side: liquid `T − Tsat`, vapor
    /// `Tsat − T`. Positive values are metastable.
    pub metastable_k: f64,
    /// Inside the accepted band, or not metastable.
    pub within_band: bool,
    /// At most the credited departure.
    pub credited: bool,
}

/// Instrument taps and state reports. Never a clamp.
#[derive(Clone, Copy, Debug)]
pub struct Taps {
    pub pt1_pa: Scalar,
    pub level_low_pa: Scalar,
    pub level_high_pa: Scalar,
    /// `p(LT.LOW) − p(LT.HIGH)`.
    pub level_difference_pa: Scalar,
    /// Above `bottom_m`.
    pub collapsed_level_m: Scalar,
    pub mixture_level_m: Scalar,
    /// Vapor, A and R.
    pub departures: [Departure; 3],
    /// Raw A-layer quantities for the harness's resolvability check.
    pub admitted_mass_kg: Scalar,
    pub admitted_thickness_m: Scalar,
    pub saturation_calls: usize,
}

#[derive(Clone, Copy, Debug)]
pub struct Inventory {
    pub mass_kg: Scalar,
    /// Zone internal energy plus transit energy at `h_g`/`h_f(p_s)`.
    pub energy_j: Scalar,
    pub boron_kg: Scalar,
}

/// Explicit geometry and pressures of one coordinate set; no property call.
struct Hydrostatics {
    boundary_elevation: Scalar,
    mixture_elevation: Scalar,
    collapsed_elevation: Scalar,
    vapor_density: Scalar,
    resident_density: Scalar,
    admitted_density: Scalar,
    centroid: [Scalar; 3],
    interface_pressure: Scalar,
    boundary_pressure: Scalar,
    bottom_pressure: Scalar,
    /// Centroid pressures of the vapor, A and R zones.
    pressure: [Scalar; 3],
}

/// Terminal fall or rise of one dispersed sphere in a continuous phase.
#[derive(Clone, Copy, Debug)]
pub struct Terminal {
    pub velocity: Scalar,
    /// Archimedes number `ρ_c Δρ g d³/μ_c²`.
    pub archimedes: Scalar,
    /// Signed relative distance of `Ar` from the drag law's rootless gap
    /// at Re = 1000: positive below or above it, never inside.
    pub gap_margin: f64,
    /// Exact tie at the selected Re = 1000 switch.
    pub tie: bool,
}

/// Lower and upper Archimedes edges of the gap in which the reused
/// Schiller-Naumann balance `(3/4) CdRe(Re) Re = Ar` has no root.
pub fn archimedes_gap() -> [f64; 2] {
    let below = pf::interphase_drag_factor(s(1000_f64.next_down())).0.value;
    let above = pf::interphase_drag_factor(s(1000.)).0.value;
    [0.75 * 1000. * below, 0.75 * 1000. * above]
}

/// Terminal velocity of a sphere of diameter `d` and density `dispersed` in
/// the continuous phase, from the reused Schiller-Naumann factor `CdRe`. The
/// balance `(3/4) CdRe(Re) Re = Ar` increases strictly in Re; it is solved
/// on values by Newton to machine precision and its direction follows from
/// the implicit function. An `Ar` inside the drag law's gap is refused.
fn terminal_velocity(
    d: f64,
    continuous: WaterPoint,
    dispersed: Scalar,
) -> Result<Terminal, Failure> {
    let difference = dispersed - continuous.density;
    let contrast = if difference.value < 0. {
        -difference
    } else {
        difference
    };
    let archimedes = s(G * d * d * d) * continuous.density * contrast
        / (continuous.viscosity * continuous.viscosity);
    finite(archimedes, "terminal-velocity Archimedes number")?;
    if archimedes.value <= 0. {
        return Err(recoverable("terminal velocity needs a density contrast"));
    }
    // In `Re·CdRe(Re) = (4/3) Ar` form.
    let target = s(4. / 3.) * archimedes;
    let balance = |re: f64| {
        let (f, tie) = pf::interphase_drag_factor(Scalar::new(re, 1.));
        (re * f.value, f.value + re * f.direction, tie)
    };
    let [low, high] = archimedes_gap();
    let gap_margin = if archimedes.value < low {
        (low - archimedes.value) / low
    } else if archimedes.value >= high {
        (archimedes.value - high) / high
    } else {
        return Err(recoverable(format!(
            "Archimedes number {} lies in the drag law's rootless gap [{low}, {high})",
            archimedes.value
        )));
    };
    let (re, tie) = if archimedes.value >= high {
        let re = sqrt(target / s(0.44));
        (re, re.value == 1000.)
    } else {
        // Re·CdRe is increasing and convex below 1000; Newton from the
        // Stokes value, which lies right of the root, converges monotonically.
        let mut re = (target.value / 24.).min(1000_f64.next_down());
        let mut converged = false;
        for _ in 0..100 {
            let (value, slope, _) = balance(re);
            let next = re - (value - target.value) / slope;
            if (next - re).abs() <= 4. * f64::EPSILON * re {
                re = next;
                converged = true;
                break;
            }
            re = next;
        }
        if !converged || !(re > 0. && re < 1000.) {
            return Err(fatal(format!("terminal-velocity Newton failed at Re {re}")));
        }
        let (_, slope, tie) = balance(re);
        (Scalar::new(re, target.direction / slope), tie)
    };
    let velocity = re * continuous.viscosity / (continuous.density * s(d));
    Ok(Terminal {
        velocity: finite(velocity, "terminal velocity")?,
        archimedes,
        gap_margin,
        tie,
    })
}

/// RK4 step of the restriction path in `ln p`.
const PATH_LOG_STEP: f64 = 0.02;

/// Specific volume on a phase's energy adiabat at `(p, h)`: the branch's own
/// EOS while single-phase, homogeneous equilibrium inside the saturation
/// dome. Returns the volume and whether the point is wet.
fn path_volume<P: Properties>(
    properties: &P,
    vapor: bool,
    p: Scalar,
    h: Scalar,
    sat: &Saturation,
    calls: &mut usize,
) -> Result<Scalar, Failure> {
    let (hf, hg) = (sat.liquid.enthalpy, sat.vapor.enthalpy);
    // On the saturation boundary the branch is selected by the direction.
    let past = |edge: Scalar, sign: f64| {
        let d = (h - edge) * s(sign);
        d.value > 0. || (d.value == 0. && d.direction >= 0.)
    };
    let single = if vapor { past(hg, 1.) } else { past(hf, -1.) };
    if single {
        *calls += 1;
        let (q, d) =
            props::inverse_thermodynamic(properties, p, h, usize::from(vapor), true, None)?;
        return Ok(s(1.) / Scalar::new(q.density_kg_m3, d.density_kg_m3));
    }
    let quality = (h - hf) / (hg - hf);
    if !(quality.value >= 0. && quality.value <= 1.) {
        return Err(recoverable(format!(
            "restriction path quality {} is outside the dome",
            quality.value
        )));
    }
    Ok((s(1.) - quality) / sat.liquid.density + quality / sat.vapor.density)
}

/// Quasi-steady restriction mass flux from stagnation `(p0, h0)` along the
/// native energy adiabat `dh/dp = v(p, h)`: the phase's own EOS while
/// single-phase and homogeneous equilibrium in the wet region. The flux
/// `ρ √(2 (h0 − h))` is maximized over throat pressures in
/// `[p_back, p0]`. The path is integrated by RK4 on a geometric pressure
/// grid of `PATH_LOG_STEP` in `ln p`, stopped two nodes past the maximum
/// or at `p_back`; an interior maximum is refined by a parabola in `ln p`.
/// The directions are those of the same discrete computation.
pub fn restriction_flux<P: Properties>(
    properties: &P,
    vapor: bool,
    p0: Scalar,
    h0: Scalar,
    p_back: Scalar,
) -> Result<Flux, Failure> {
    if !(p0.value > 0. && p_back.value > 0.) {
        return Err(recoverable("restriction pressures must be positive"));
    }
    if p_back.value > p0.value {
        return Err(recoverable(
            "reverse restriction flow needs the receiver as donor, outside the cell",
        ));
    }
    let mut saturation_calls = 0;
    let mut inversions = 0;
    let sat_at = |p: Scalar, calls: &mut usize| -> Result<Saturation, Failure> {
        *calls += 1;
        properties.saturation_caloric(p).map_err(recoverable)
    };
    if p_back.value == p0.value {
        return Ok(Flux {
            mass_flux: s(0.),
            throat_pressure_pa: p0,
            choked: false,
            saturation_calls,
            inversions,
        });
    }
    let ratio = (-PATH_LOG_STEP).exp();
    let mut p = p0;
    let mut h = h0;
    let mut sat = sat_at(p, &mut saturation_calls)?;
    let mut v = path_volume(properties, vapor, p, h, &sat, &mut inversions)?;
    // Nodes (p, G) from the stagnation point, where G is zero.
    let mut nodes: Vec<(Scalar, Scalar)> = vec![(p, s(0.))];
    let mut falling = 0;
    while p.value > p_back.value && falling < 2 {
        let next = if p.value * ratio > p_back.value {
            p * s(ratio)
        } else {
            p_back
        };
        let dp = next - p;
        let mid = (p + next) * s(0.5);
        let mid_sat = sat_at(mid, &mut saturation_calls)?;
        let k1 = v;
        let k2 = path_volume(
            properties,
            vapor,
            mid,
            h + dp * k1 * s(0.5),
            &mid_sat,
            &mut inversions,
        )?;
        let k3 = path_volume(
            properties,
            vapor,
            mid,
            h + dp * k2 * s(0.5),
            &mid_sat,
            &mut inversions,
        )?;
        let next_sat = sat_at(next, &mut saturation_calls)?;
        let k4 = path_volume(
            properties,
            vapor,
            next,
            h + dp * k3,
            &next_sat,
            &mut inversions,
        )?;
        h = h + dp * (k1 + s(2.) * k2 + s(2.) * k3 + k4) / s(6.);
        p = next;
        sat = next_sat;
        v = path_volume(properties, vapor, p, h, &sat, &mut inversions)?;
        let drop = h0 - h;
        if drop.value <= 0. {
            return Err(recoverable("restriction path gained enthalpy on expansion"));
        }
        let flux = sqrt(s(2.) * drop) / v;
        let rising = flux.value > nodes.last().map_or(0., |n| n.1.value);
        falling = if rising { 0 } else { falling + 1 };
        nodes.push((p, flux));
    }
    let (m, _) = nodes
        .iter()
        .enumerate()
        .fold((0, f64::NEG_INFINITY), |best, (i, n)| {
            if n.1.value > best.1 {
                (i, n.1.value)
            } else {
                best
            }
        });
    let last = nodes.len() - 1;
    let (mass_flux, throat, choked) = if m == last {
        // The maximum is at the backpressure: unchoked.
        (nodes[m].1, nodes[m].0, false)
    } else if m == 0 {
        return Err(recoverable("restriction path has no positive flux"));
    } else {
        // Parabola through three nodes in q = ln p (the last step may be
        // shorter, so the general three-point vertex is used).
        let q = |i: usize| {
            let p = nodes[i].0;
            Scalar::new(p.value.ln(), p.direction / p.value)
        };
        let (x0, x1, x2) = (q(m - 1), q(m), q(m + 1));
        let (y0, y1, y2) = (nodes[m - 1].1, nodes[m].1, nodes[m + 1].1);
        let d01 = (y1 - y0) / (x1 - x0);
        let d12 = (y2 - y1) / (x2 - x1);
        let curvature = (d12 - d01) / (x2 - x0);
        let slope = d01 - curvature * (x0 + x1);
        let vertex = -slope / (s(2.) * curvature);
        let value = y0 + d01 * (vertex - x0) + curvature * (vertex - x0) * (vertex - x1);
        let throat = Scalar::new(vertex.value.exp(), vertex.value.exp() * vertex.direction);
        (value, throat, true)
    };
    Ok(Flux {
        mass_flux: finite(mass_flux, "restriction mass flux")?,
        throat_pressure_pa: throat,
        choked,
        saturation_calls,
        inversions,
    })
}

/// One restriction evaluation held for a matrix: the flux and throat
/// pressure with their exact partials with respect to `(p0, h0, p_back)`,
/// the derivatives of the same discrete computation `restriction_flux`
/// differentiates. The lift enters outside the flux, linearly.
#[derive(Clone, Copy, Debug)]
pub struct HeldFlux {
    pub mass_flux: f64,
    pub mass_flux_partials: [f64; 3],
    pub throat_pressure_pa: f64,
    pub throat_partials: [f64; 3],
    pub choked: bool,
    pub saturation_calls: usize,
    pub inversions: usize,
}

/// The restriction at constant inputs with its three exact partials: one
/// pass of [`restriction_flux`] per unit input direction.
pub fn restriction_partials<P: Properties>(
    properties: &P,
    vapor: bool,
    p0: f64,
    h0: f64,
    p_back: f64,
) -> Result<HeldFlux, Failure> {
    let mut held: Option<HeldFlux> = None;
    let mut partials = [0.; 3];
    let mut throat = [0.; 3];
    // The three passes share one property boundary: each state once.
    let shared = props::Shared::new(properties);
    for k in 0..3 {
        let unit = |j: usize, v: f64| Scalar::new(v, if j == k { 1. } else { 0. });
        let f = restriction_flux(&shared, vapor, unit(0, p0), unit(1, h0), unit(2, p_back))?;
        partials[k] = f.mass_flux.direction;
        throat[k] = f.throat_pressure_pa.direction;
        let h = held.get_or_insert(HeldFlux {
            mass_flux: f.mass_flux.value,
            mass_flux_partials: [0.; 3],
            throat_pressure_pa: f.throat_pressure_pa.value,
            throat_partials: [0.; 3],
            choked: f.choked,
            saturation_calls: 0,
            inversions: 0,
        });
        if h.mass_flux.to_bits() != f.mass_flux.value.to_bits() || h.choked != f.choked {
            return Err(fatal("restriction value depends on its direction"));
        }
        h.saturation_calls += f.saturation_calls;
        h.inversions += f.inversions;
    }
    let mut held = held.ok_or_else(|| fatal("restriction partials not evaluated"))?;
    held.mass_flux_partials = partials;
    held.throat_partials = throat;
    Ok(held)
}

impl HeldFlux {
    /// The flux at directed inputs by the chain rule; no property call.
    pub fn at(&self, p0: Scalar, h0: Scalar, p_back: Scalar) -> Flux {
        let d = [p0.direction, h0.direction, p_back.direction];
        let dot = |g: &[f64; 3]| g[0] * d[0] + g[1] * d[1] + g[2] * d[2];
        Flux {
            mass_flux: Scalar::new(self.mass_flux, dot(&self.mass_flux_partials)),
            throat_pressure_pa: Scalar::new(self.throat_pressure_pa, dot(&self.throat_partials)),
            choked: self.choked,
            saturation_calls: 0,
            inversions: 0,
        }
    }
}

/// The restriction for one residual. With a matrix reuse, every column
/// takes the held value and partials of its exact base point, evaluated
/// once per matrix, and the chain rule. Without one, a plain or directional
/// pass of the same computation, equal to the chain rule to roundoff.
fn relief_flux<P: Properties>(
    properties: &P,
    vapor: bool,
    p0: Scalar,
    h0: Scalar,
    p_back: Scalar,
    reuse: Option<&mut Reuse<P::Caloric>>,
) -> Result<Flux, Failure> {
    match reuse {
        Some(reuse) => {
            let key = [
                u64::from(vapor),
                p0.value.to_bits(),
                h0.value.to_bits(),
                p_back.value.to_bits(),
            ];
            let held = match reuse.held_restriction(key) {
                Some(held) => held,
                None => {
                    let held =
                        restriction_partials(properties, vapor, p0.value, h0.value, p_back.value)?;
                    reuse.hold_restriction(key, held);
                    held
                }
            };
            Ok(held.at(p0, h0, p_back))
        }
        _ => restriction_flux(properties, vapor, p0, h0, p_back),
    }
}

/// `max(0, min(a, b) − c)` style overlap length of `[low, high]` with
/// `[bottom, top]`, with one-sided directions at exact ties.
fn overlap(low: f64, high: f64, bottom: Scalar, top: Scalar) -> Scalar {
    let upper = if top.value < high || (top.value == high && top.direction < 0.) {
        top
    } else {
        s(high)
    };
    let lower = if bottom.value > low || (bottom.value == low && bottom.direction > 0.) {
        bottom
    } else {
        s(low)
    };
    positive_part(upper - lower)
}

/// Exact representation search shared with the network's preparation.
fn offsets(search: usize) -> impl Iterator<Item = i64> {
    std::iter::once(0).chain((1..=search as i64).flat_map(|k| [k, -k]))
}
fn adjacent(value: f64, steps: i64) -> f64 {
    (0..steps.unsigned_abs()).fold(value, |v, _| {
        if steps > 0 {
            v.next_up()
        } else {
            v.next_down()
        }
    })
}
fn coordinate(target: f64, scale: f64, search: usize) -> Option<f64> {
    let start = target / scale;
    offsets(search)
        .map(|k| adjacent(start, k))
        .find(|y| y * scale == target)
}

/// The stratified cell compiled from its packet section.
#[derive(Clone, Debug)]
pub struct Cell {
    parameters: Parameters,
    geometry: Geometry,
    case: Case,
}

impl Cell {
    /// The cell for a case from the strict block's own lists; the bubble
    /// diameter is then the nominal one.
    pub fn new(parameters: Parameters, case: Case) -> Result<Self, Failure> {
        Self::for_case(parameters, case, None)
    }

    /// The cell for a case drawn from the verification cases' declared
    /// `sensitivityFamilies`. Each family member must also be a case of the
    /// strict block where that block lists one; the bubble diameter is the
    /// nominal or a member of the declared bubble family.
    pub fn for_case(
        parameters: Parameters,
        case: Case,
        families: Option<&SensitivityFamilies>,
    ) -> Result<Self, Failure> {
        parameters.validate()?;
        let x = &parameters.stratified;
        if let Some(f) = families
            && (f
                .relaxation
                .iter()
                .any(|v| !x.relaxation_sensitivity.contains(v))
                || f.spray_drop_m
                    .iter()
                    .any(|v| !x.drop_diameter_sensitivity_m.contains(v))
                || f.bubble_m.iter().any(|v| !(v.is_finite() && *v > 0.)))
        {
            return Err(fatal(format!(
                "declared sensitivity families {f:?} disagree with the strict block"
            )));
        }
        let bubble = case.bubble_diameter_m == x.bubble_diameter_m
            || families.is_some_and(|f| f.bubble_m.contains(&case.bubble_diameter_m));
        if !x.relaxation_sensitivity.contains(&case.relaxation_factor)
            || !x
                .drop_diameter_sensitivity_m
                .contains(&case.drop_diameter_m)
            || !bubble
        {
            return Err(fatal(format!(
                "case {case:?} is not in the declared sensitivity lists"
            )));
        }
        let geometry = Geometry::new(&parameters);
        Ok(Self {
            parameters,
            geometry,
            case,
        })
    }
    pub fn parameters(&self) -> &Parameters {
        &self.parameters
    }
    pub fn case(&self) -> Case {
        self.case
    }
    /// Free area at an elevation (the band above an exact boundary).
    pub fn free_area(&self, z: f64) -> f64 {
        self.geometry.area(s(z))
    }
    /// Volume below an elevation, the integral of the free area.
    pub fn volume_below(&self, z: Scalar) -> Scalar {
        self.geometry.volume(z)
    }
    /// Elevation below which the volume is `v`.
    pub fn level(&self, v: Scalar) -> Scalar {
        self.geometry.level(v)
    }

    fn hydrostatics(&self, x: &Coordinates) -> Result<Hydrostatics, Failure> {
        let geometry = &self.geometry;
        let (bottom, top) = (s(self.parameters.bottom_m), s(self.parameters.top_m));
        let boundary = geometry.level(x.admitted_volume);
        let mixture = geometry.level(x.admitted_volume + x.resident_volume + x.bubble_volume);
        let collapsed = geometry.level(x.admitted_volume + x.resident_volume);
        let vapor_density = (x.vapor_mass + x.drop_mass) / (x.vapor_volume + x.drop_volume);
        let resident_density =
            (x.resident_mass + x.bubble_mass) / (x.resident_volume + x.bubble_volume);
        let admitted_density = x.admitted_mass / x.admitted_volume;
        let centroid = [
            geometry.centroid(mixture, top),
            geometry.centroid(bottom, boundary),
            geometry.centroid(boundary, mixture),
        ];
        let g = s(G);
        let interface = x.roof_pressure + g * vapor_density * (top - mixture);
        let boundary_pressure = interface + g * resident_density * (mixture - boundary);
        let bottom_pressure = boundary_pressure + g * admitted_density * (boundary - bottom);
        let pressure = [
            x.roof_pressure + g * vapor_density * (top - centroid[0]),
            boundary_pressure + g * admitted_density * (boundary - centroid[1]),
            interface + g * resident_density * (mixture - centroid[2]),
        ];
        for v in [
            boundary,
            mixture,
            collapsed,
            interface,
            boundary_pressure,
            bottom_pressure,
        ]
        .iter()
        .chain(&pressure)
        .chain(&centroid)
        {
            finite(*v, "column geometry or pressure")?;
        }
        Ok(Hydrostatics {
            boundary_elevation: boundary,
            mixture_elevation: mixture,
            collapsed_elevation: collapsed,
            vapor_density,
            resident_density,
            admitted_density,
            centroid,
            interface_pressure: interface,
            boundary_pressure,
            bottom_pressure,
            pressure,
        })
    }

    /// The explicit column: 3 zone inversions and the saturation tuples at
    /// `p_s` and `p_AR`.
    pub fn column<P: Properties>(
        &self,
        properties: &P,
        x: &Coordinates,
        mut reuse: Option<(&mut Reuse<P::Caloric>, Slots)>,
    ) -> Result<Column, Failure> {
        let h = self.hydrostatics(x)?;
        let zone = |pressure: Scalar,
                    mass: Scalar,
                    volume: Scalar,
                    energy: Scalar,
                    vapor: bool,
                    slot: Option<(&mut Reuse<P::Caloric>, usize)>| {
            let u = energy / mass;
            let (q, d) = props::inverse(properties, pressure, u, usize::from(vapor), false, slot)?;
            Ok::<_, Failure>(Zone::new(pressure, mass, volume, u, q, d))
        };
        let vapor = zone(
            h.pressure[0],
            x.vapor_mass,
            x.vapor_volume,
            x.vapor_energy,
            true,
            reuse
                .as_mut()
                .map(|(r, k)| (&mut **r, k.vapor_and_resident)),
        )?;
        let admitted = zone(
            h.pressure[1],
            x.admitted_mass,
            x.admitted_volume,
            x.admitted_energy,
            false,
            reuse.as_mut().map(|(r, k)| (&mut **r, k.admitted)),
        )?;
        let resident = zone(
            h.pressure[2],
            x.resident_mass,
            x.resident_volume,
            x.resident_energy,
            false,
            reuse
                .as_mut()
                .map(|(r, k)| (&mut **r, k.vapor_and_resident)),
        )?;
        let interface_saturation = props::saturation(
            properties,
            h.interface_pressure,
            reuse.as_mut().map(|(r, k)| (&mut **r, k.interface)),
        )?;
        let boundary_saturation = props::saturation(
            properties,
            h.boundary_pressure,
            reuse.as_mut().map(|(r, k)| (&mut **r, k.boundary)),
        )?;
        let thickness = h.boundary_elevation - s(self.parameters.bottom_m);
        let scale = self.parameters.stratified.withdrawal_scale_m;
        let withdrawal = thickness * thickness / (thickness * thickness + s(scale * scale));
        Ok(Column {
            vapor,
            admitted,
            resident,
            interface_saturation,
            boundary_saturation,
            roof_pressure: x.roof_pressure,
            interface_pressure: h.interface_pressure,
            boundary_pressure: h.boundary_pressure,
            bottom_pressure: h.bottom_pressure,
            boundary_elevation: h.boundary_elevation,
            mixture_elevation: h.mixture_elevation,
            collapsed_elevation: h.collapsed_elevation,
            vapor_region_density: h.vapor_density,
            resident_region_density: h.resident_density,
            admitted_region_density: h.admitted_density,
            centroid_elevation: h.centroid,
            admitted_thickness: thickness,
            withdrawal_fraction: finite(withdrawal, "withdrawal fraction")?,
            admitted_concentration: x.admitted_boron / x.admitted_mass,
            resident_concentration: x.resident_boron / x.resident_mass,
            bubble_mass: x.bubble_mass,
            drop_mass: x.drop_mass,
            drop_boron: x.drop_boron,
            bubble_volume: x.bubble_volume,
            drop_volume: x.drop_volume,
            surface_area_m2: self.geometry.area(h.mixture_elevation),
            boundary_area_m2: self.geometry.area(h.boundary_elevation),
            top_m: self.parameters.top_m,
            bottom_m: self.parameters.bottom_m,
            calls: Calls {
                inversions: 3,
                saturations: 2,
            },
        })
    }

    /// The cell as a face chart sees it at a port: the column pressure at
    /// the port elevation and, for the submerged surge mouth, the liquid
    /// withdrawn by an outsurge, the φ-weighted A/R mixture.
    pub fn port_view(&self, column: &Column, port: usize) -> Result<FaceCell, Failure> {
        let p = self
            .parameters
            .ports
            .get(port)
            .ok_or_else(|| fatal(format!("port {port} is not declared")))?;
        match p.kind {
            PortKind::Spray | PortKind::Relief => {
                if column.mixture_elevation.value >= p.elevation_m {
                    return Err(recoverable(format!(
                        "mixture level reaches upper port {}: the solid-PZR structural limit",
                        p.id
                    )));
                }
                // The vapor region's content: vapor from g and drops by
                // volume share, at the column pressure of the port.
                let alpha = column.drop_volume / (column.vapor.volume + column.drop_volume);
                let sat = &column.interface_saturation;
                let drops = (column.drop_mass.value != 0.).then(|| FacePhase {
                    fraction: alpha,
                    density: sat.liquid.density,
                    enthalpy: sat.liquid.enthalpy,
                    boron_concentration: column.drop_boron / column.drop_mass,
                });
                Ok(FaceCell {
                    pressure: column.pressure_at(p.elevation_m),
                    phase: [
                        drops,
                        Some(FacePhase {
                            fraction: s(1.) - alpha,
                            density: column.vapor.density,
                            enthalpy: column.vapor.enthalpy,
                            boron_concentration: s(0.),
                        }),
                    ],
                })
            }
            PortKind::Surge => {
                if p.elevation_m >= column.mixture_elevation.value {
                    return Err(recoverable(format!(
                        "surge port {} is above the mixture level",
                        p.id
                    )));
                }
                let phi = column.withdrawal_fraction;
                let (a, r) = (&column.admitted, &column.resident);
                let rest = s(1.) - phi;
                let density = s(1.) / (phi / a.density + rest / r.density);
                Ok(FaceCell {
                    pressure: column.pressure_at(p.elevation_m),
                    phase: [
                        Some(FacePhase {
                            fraction: s(1.),
                            density,
                            enthalpy: phi * a.enthalpy + rest * r.enthalpy,
                            boron_concentration: phi * column.admitted_concentration
                                + rest * column.resident_concentration,
                        }),
                        None,
                    ],
                })
            }
        }
    }

    /// A heater bank's contact by level: its span `[bottom_m, top_m]` wetted
    /// over its overlap with the mixture column `[bottom, z_mix]`, the wetted
    /// length split between A's region `[bottom, z_AR]` and R's, and the
    /// exposed rest. Continuous in the levels.
    pub fn heater_wetting(
        &self,
        column: &Column,
        bottom_m: f64,
        top_m: f64,
    ) -> Result<Wetting, Failure> {
        let p = &self.parameters;
        if !(bottom_m >= p.bottom_m && bottom_m < top_m && top_m <= p.top_m) {
            return Err(fatal(format!(
                "contact span {bottom_m}..{top_m} m is outside the vessel"
            )));
        }
        let admitted = overlap(bottom_m, top_m, s(p.bottom_m), column.boundary_elevation);
        let resident = overlap(
            bottom_m,
            top_m,
            column.boundary_elevation,
            column.mixture_elevation,
        );
        let wet = admitted + resident;
        let span = s(top_m - bottom_m);
        Ok(Wetting {
            wet_fraction: wet / span,
            wet_length_m: wet,
            admitted_length_m: admitted,
            resident_length_m: resident,
            exposed_length_m: span - wet,
        })
    }

    /// A wall element's contact by level. A shell band is wetted over its
    /// overlap with A's region `[bottom, z_AR]` and R's `[z_AR, z_mix]` and
    /// dry above `z_mix`, as a heater bank is. The bottom head contacts the
    /// lowest zone present at `bottom_m` and the top head the vapor zone; a
    /// mixture level reaching the top head is the solid-PZR structural limit.
    pub fn wall_wetting(
        &self,
        column: &Column,
        element: WallElement,
    ) -> Result<WallWetting, Failure> {
        let one = |zone: usize| {
            let mut f = [s(0.); 3];
            f[zone] = s(1.);
            WallWetting {
                admitted_fraction: f[0],
                resident_fraction: f[1],
                vapor_fraction: f[2],
                band: None,
            }
        };
        match element {
            WallElement::Band { bottom_m, top_m } => {
                let w = self.heater_wetting(column, bottom_m, top_m)?;
                let span = s(top_m - bottom_m);
                Ok(WallWetting {
                    admitted_fraction: w.admitted_length_m / span,
                    resident_fraction: w.resident_length_m / span,
                    vapor_fraction: w.exposed_length_m / span,
                    band: Some(w),
                })
            }
            WallElement::BottomHead => {
                let bottom = self.parameters.bottom_m;
                Ok(if column.boundary_elevation.value > bottom {
                    one(0)
                } else if column.mixture_elevation.value > bottom {
                    one(1)
                } else {
                    one(2)
                })
            }
            WallElement::TopHead => {
                if column.mixture_elevation.value >= self.parameters.top_m {
                    return Err(recoverable(
                        "mixture level reaches the top head: the solid-PZR structural limit",
                    ));
                }
                Ok(one(2))
            }
        }
    }

    /// The 17 scaled rows from coordinates `x`, their rates and the signed
    /// port receipts. `scales` are the coordinate scales; the volume row is
    /// scaled by `fluidVolume_m3`, every other row by its coordinate scale.
    #[allow(clippy::too_many_arguments)]
    pub fn residual<P: Properties>(
        &self,
        properties: &P,
        x: &Coordinates,
        rate: &Coordinates,
        receipts: &[Receipt],
        boundary: &Boundary,
        scales: &[f64; COORDINATES],
        reuse: Option<(&mut Reuse<P::Caloric>, Slots)>,
    ) -> Result<Evaluation, Failure> {
        let mut reuse = reuse;
        let column = self.column(properties, x, reuse.as_mut().map(|(r, k)| (&mut **r, *k)))?;
        self.residual_on_reusing(
            properties,
            column,
            x,
            rate,
            receipts,
            boundary,
            scales,
            reuse.map(|(r, _)| r),
        )
    }

    /// The rows of [`Cell::residual`] on a column already evaluated at the
    /// same coordinates `x`, without a matrix reuse.
    #[allow(clippy::too_many_arguments)]
    pub fn residual_on<P: Properties>(
        &self,
        properties: &P,
        c: Column,
        x: &Coordinates,
        rate: &Coordinates,
        receipts: &[Receipt],
        boundary: &Boundary,
        scales: &[f64; COORDINATES],
    ) -> Result<Evaluation, Failure> {
        self.residual_on_reusing(properties, c, x, rate, receipts, boundary, scales, None)
    }

    /// The rows of [`Cell::residual`] on a column already evaluated at the
    /// same coordinates `x`. Its only property calls are the relief
    /// restriction's, while the relief has lift; with `reuse` they are made
    /// once per exact base point of the matrix and its directed columns
    /// take the held partials. `residual` is `column` followed by this with
    /// the same reuse, so both give bitwise identical rows.
    #[allow(clippy::too_many_arguments)]
    pub fn residual_on_reusing<P: Properties>(
        &self,
        properties: &P,
        c: Column,
        x: &Coordinates,
        rate: &Coordinates,
        receipts: &[Receipt],
        boundary: &Boundary,
        scales: &[f64; COORDINATES],
        mut reuse: Option<&mut Reuse<P::Caloric>>,
    ) -> Result<Evaluation, Failure> {
        if receipts.len() != self.parameters.ports.len() {
            return Err(fatal(format!(
                "{} receipts for {} ports",
                receipts.len(),
                self.parameters.ports.len()
            )));
        }
        let (g, a, r) = (c.vapor, c.admitted, c.resident);
        let sat = c.interface_saturation;
        let edge = c.boundary_saturation;
        let (hf, hg) = (sat.liquid.enthalpy, sat.vapor.enthalpy);
        let x_params = &self.parameters.stratified;
        let theta_l = s(x_params.liquid_relaxation_time_s * self.case.relaxation_factor);
        let theta_g = s(x_params.vapor_relaxation_time_s * self.case.relaxation_factor);

        // Stock sources: mass, energy (without volume work) and boron.
        let mut mass = [s(0.); 3];
        let mut energy = [s(0.); 3];
        let mut boron = [s(0.); 2];
        const GV: usize = 0;
        const AV: usize = 1;
        const RV: usize = 2;
        let mut bubbles = s(0.);
        let mut drops = s(0.);
        let mut drop_boron = s(0.);
        let mut spray_condensation = s(0.);
        let mut receipt = [s(0.); 3];
        for (port, rec) in self.parameters.ports.iter().zip(receipts) {
            for (total, v) in receipt.iter_mut().zip([rec.mass, rec.enthalpy, rec.boron]) {
                *total = *total + finite(v, "port receipt")?;
            }
            match port.kind {
                PortKind::Surge => {
                    let w = rec.mass;
                    if w.value > 0. || (w.value == 0. && w.direction > 0.) {
                        mass[AV] = mass[AV] + w;
                        energy[AV] = energy[AV] + rec.enthalpy;
                        boron[0] = boron[0] + rec.boron;
                    } else {
                        let from_a = c.withdrawal_fraction * w;
                        mass[AV] = mass[AV] + from_a;
                        energy[AV] = energy[AV] + from_a * a.enthalpy;
                        boron[0] = boron[0] + from_a * c.admitted_concentration;
                        mass[RV] = mass[RV] + (w - from_a);
                        energy[RV] = energy[RV] + (rec.enthalpy - from_a * a.enthalpy);
                        boron[1] = boron[1] + (rec.boron - from_a * c.admitted_concentration);
                    }
                }
                PortKind::Spray => {
                    let w = rec.mass;
                    if w.value > 0. || (w.value == 0. && w.direction >= 0.) {
                        // Heating to saturation at entry: a cold spray condenses
                        // vapor from g at g's enthalpy, a hot one flashes into g
                        // at h_g,sat. The saturated drops join the drop stock.
                        let deficit = w * hf - rec.enthalpy;
                        let cold =
                            deficit.value > 0. || (deficit.value == 0. && deficit.direction >= 0.);
                        let vapor_enthalpy = if cold { g.enthalpy } else { hg };
                        let condensed = deficit / (vapor_enthalpy - hf);
                        mass[GV] = mass[GV] - condensed;
                        energy[GV] = energy[GV] - condensed * vapor_enthalpy;
                        drops = drops + w + condensed;
                        drop_boron = drop_boron + rec.boron;
                        spray_condensation = spray_condensation + condensed;
                    } else {
                        // Reverse flow draws the vapor region's content by
                        // volume share; the drops carry h_f,sat and the boron.
                        let alpha = x.drop_volume / (x.vapor_volume + x.drop_volume);
                        let share = alpha * sat.liquid.density
                            / (alpha * sat.liquid.density + (s(1.) - alpha) * g.density);
                        drops = drops + share * w;
                        drop_boron = drop_boron + rec.boron;
                        mass[GV] = mass[GV] + (s(1.) - share) * w;
                        energy[GV] = energy[GV] + (rec.enthalpy - share * w * hf);
                    }
                }
                PortKind::Relief => {
                    if [rec.mass, rec.enthalpy, rec.boron]
                        .iter()
                        .any(|v| v.value != 0. || v.direction != 0.)
                    {
                        return Err(fatal(
                            "a relief port's flow is the cell's own restriction; its receipt must be zero",
                        ));
                    }
                }
            }
        }

        // The relief outlet draws the vapor region by volume share through
        // each phase's own restriction against the receiver's backpressure.
        let relief_port = self
            .parameters
            .ports
            .iter()
            .find(|p| p.kind == PortKind::Relief);
        let relief = match (relief_port, boundary.relief) {
            (None, None) => None,
            (Some(port), Some(state)) => {
                let device = port
                    .relief
                    .ok_or_else(|| fatal("relief port without its device"))?;
                let area = state.lift * s(device.effective_area_per_lift_m2);
                let mut flow = ReliefFlow {
                    effective_area_m2: area,
                    vapor_kg_s: s(0.),
                    drop_kg_s: s(0.),
                    enthalpy_w: s(0.),
                    boron_kg_s: s(0.),
                    vapor: None,
                    drop: None,
                };
                if area.value != 0. || area.direction != 0. {
                    if c.mixture_elevation.value >= port.elevation_m {
                        return Err(recoverable(format!(
                            "mixture level reaches the relief port {}: the solid-PZR structural limit",
                            port.id
                        )));
                    }
                    let alpha = x.drop_volume / (x.vapor_volume + x.drop_volume);
                    let back = state.back_pressure_pa;
                    let vapor = relief_flux(
                        properties,
                        true,
                        c.roof_pressure,
                        g.enthalpy,
                        back,
                        reuse.as_deref_mut(),
                    )?;
                    flow.vapor_kg_s = (s(1.) - alpha) * area * vapor.mass_flux;
                    flow.vapor = Some(vapor);
                    if x.drop_volume.value != 0. || x.drop_volume.direction != 0. {
                        let drop =
                            relief_flux(properties, false, c.roof_pressure, hf, back, reuse)?;
                        flow.drop_kg_s = alpha * area * drop.mass_flux;
                        flow.drop = Some(drop);
                    }
                    let concentration = if x.drop_mass.value != 0. {
                        x.drop_boron / x.drop_mass
                    } else {
                        s(0.)
                    };
                    flow.enthalpy_w = flow.vapor_kg_s * g.enthalpy + flow.drop_kg_s * hf;
                    flow.boron_kg_s = flow.drop_kg_s * concentration;
                    mass[GV] = mass[GV] - flow.vapor_kg_s;
                    energy[GV] = energy[GV] - flow.vapor_kg_s * g.enthalpy;
                    drops = drops - flow.drop_kg_s;
                    drop_boron = drop_boron - flow.boron_kg_s;
                    receipt[0] = receipt[0] - flow.vapor_kg_s - flow.drop_kg_s;
                    receipt[1] = receipt[1] - flow.enthalpy_w;
                    receipt[2] = receipt[2] - flow.boron_kg_s;
                }
                Some(flow)
            }
            _ => {
                return Err(fatal(
                    "the relief state is given exactly when a relief port is declared",
                ));
            }
        };

        // Heater banks: wet sources into A and R by wetted length, wall-born
        // vapor into the bubble stock, exposed heat and condensation with g.
        let absent = |v: Scalar| v.value == 0. && v.direction == 0.;
        for heater in &boundary.heaters {
            let w = self.heater_wetting(&c, heater.bottom_m, heater.top_m)?;
            for (k, (zone, length)) in [(AV, w.admitted_length_m), (RV, w.resident_length_m)]
                .into_iter()
                .enumerate()
            {
                let (q, gamma) = (heater.wet_heat_w[k], heater.wet_vapor_kg_s[k]);
                if absent(length) && !(absent(q) && absent(gamma)) {
                    return Err(fatal(format!(
                        "heater span [{}, {}] m delivers wet sources to a zone it does not touch",
                        heater.bottom_m, heater.top_m
                    )));
                }
                mass[zone] = mass[zone] - gamma;
                energy[zone] = energy[zone] + q - gamma * hg;
                bubbles = bubbles + gamma;
                receipt[1] = receipt[1] + q;
            }
            let j = heater.condensate_kg_s;
            if absent(w.exposed_length_m) && !(absent(heater.exposed_heat_w) && absent(j)) {
                return Err(fatal(format!(
                    "heater span [{}, {}] m delivers exposed sources without exposed length",
                    heater.bottom_m, heater.top_m
                )));
            }
            energy[GV] = energy[GV] + heater.exposed_heat_w - j * g.enthalpy;
            mass[GV] = mass[GV] - j;
            mass[RV] = mass[RV] + j;
            energy[RV] = energy[RV] + j * heater.condensate_enthalpy_j_kg;
            receipt[1] = receipt[1] + heater.exposed_heat_w - j * g.enthalpy
                + j * heater.condensate_enthalpy_j_kg;
        }

        // Shell bands and heads: wet heat and wall vapor into the liquid zone
        // each contacts, the vapor into the bubble stock, dry heat and
        // condensation with g, the condensate into R.
        for wall in &boundary.walls {
            let w = self.wall_wetting(&c, wall.element)?;
            for (k, (zone, share)) in [(AV, w.admitted_fraction), (RV, w.resident_fraction)]
                .into_iter()
                .enumerate()
            {
                let (q, gamma) = (wall.wet_heat_w[k], wall.wet_vapor_kg_s[k]);
                if absent(share) && !(absent(q) && absent(gamma)) {
                    return Err(fatal(format!(
                        "wall {:?} delivers wet sources to a zone it does not contact",
                        wall.element
                    )));
                }
                mass[zone] = mass[zone] - gamma;
                energy[zone] = energy[zone] + q - gamma * hg;
                bubbles = bubbles + gamma;
                receipt[1] = receipt[1] + q;
            }
            let j = wall.condensate_kg_s;
            if absent(w.vapor_fraction) && !(absent(wall.dry_heat_w) && absent(j)) {
                return Err(fatal(format!(
                    "wall {:?} delivers dry sources without dry contact",
                    wall.element
                )));
            }
            energy[GV] = energy[GV] + wall.dry_heat_w - j * g.enthalpy;
            mass[GV] = mass[GV] - j;
            mass[RV] = mass[RV] + j;
            energy[RV] = energy[RV] + j * wall.condensate_enthalpy_j_kg;
            receipt[1] =
                receipt[1] + wall.dry_heat_w - j * g.enthalpy + j * wall.condensate_enthalpy_j_kg;
        }

        // Bulk relaxation on each zone's own metastable excess. A liquid
        // layer is measured against saturation at its own top; the vapor
        // zone against saturation at the free surface.
        let flash_a = a.mass * positive_part(a.enthalpy - edge.liquid.enthalpy)
            / ((hg - edge.liquid.enthalpy) * theta_l);
        let flash_r = r.mass * positive_part(r.enthalpy - hf) / ((hg - hf) * theta_l);
        let condense = g.mass * positive_part(hg - g.enthalpy) / ((hg - hf) * theta_g);
        mass[AV] = mass[AV] - flash_a;
        energy[AV] = energy[AV] - flash_a * hg;
        mass[RV] = mass[RV] - flash_r;
        energy[RV] = energy[RV] - flash_r * hg;
        bubbles = bubbles + flash_a + flash_r;
        mass[GV] = mass[GV] - condense;
        energy[GV] = energy[GV] - condense * hf;
        drops = drops + condense;

        // Transit: bubbles rise through R's region, drops fall through the
        // vapor region, both at their terminal velocities.
        let bubble = terminal_velocity(self.case.bubble_diameter_m, sat.liquid, sat.vapor.density)?;
        let drop = terminal_velocity(self.case.drop_diameter_m, sat.vapor, sat.liquid.density)?;
        let rise = c.bubble_mass * bubble.velocity / (c.mixture_elevation - c.boundary_elevation);
        let vapor_height = s(c.top_m) - c.mixture_elevation;
        let fall = c.drop_mass * drop.velocity / vapor_height;
        let boron_fall = c.drop_boron * drop.velocity / vapor_height;
        bubbles = bubbles - rise;
        mass[GV] = mass[GV] + rise;
        energy[GV] = energy[GV] + rise * hg;
        drops = drops - fall;
        drop_boron = drop_boron - boron_fall;
        mass[RV] = mass[RV] + fall;
        energy[RV] = energy[RV] + fall * hf;
        boron[1] = boron[1] + boron_fall;

        // Free-surface exchange between R and the vapor zone.
        let interface = pf::exchange(
            self.parameters.interfacial_length_m,
            r.phase(x.resident_boron),
            g.phase(s(0.)),
            s(c.surface_area_m2),
            sat,
        );
        interface.liquid.check().map_err(recoverable)?;
        interface.vapor.check().map_err(recoverable)?;
        mass[RV] = mass[RV] + interface.liquid.mass;
        energy[RV] = energy[RV] + interface.liquid.enthalpy;
        mass[GV] = mass[GV] + interface.vapor.mass;
        energy[GV] = energy[GV] + interface.vapor.enthalpy;

        // Inversion exchange on potential densities at p_AR: each layer's
        // own M/V reduced with its isentropic compressibility. Conduction.
        let pab = c.boundary_pressure;
        let potential = |z: &Zone| {
            z.mass / z.volume * (s(1.) - z.isentropic_compressibility() * (z.pressure - pab))
        };
        let potential_density = [potential(&a), potential(&r)];
        let inversion = s(c.boundary_area_m2 * x_params.inversion_exchange_velocity_m_s)
            * positive_part(potential_density[1] - potential_density[0]);
        let carried = inversion * (r.enthalpy - a.enthalpy);
        let carried_boron = inversion * (c.resident_concentration - c.admitted_concentration);
        energy[AV] = energy[AV] + carried;
        energy[RV] = energy[RV] - carried;
        boron[0] = boron[0] + carried_boron;
        boron[1] = boron[1] - carried_boron;
        let distance = c.centroid_elevation[2] - c.centroid_elevation[1];
        let conduction = pf::conduction(
            a.phase(x.admitted_boron),
            r.phase(x.resident_boron),
            s(c.boundary_area_m2) / distance,
        );
        energy[AV] = energy[AV] + conduction;
        energy[RV] = energy[RV] - conduction;

        let heat = boundary.heat;
        energy[GV] = energy[GV] + heat.vapor;
        energy[AV] = energy[AV] + heat.admitted;
        energy[RV] = energy[RV] + heat.resident;

        // Saturation drift of the mass-only transit stocks, paid by their
        // host regions: Q = M (dh_sat/dp − v_sat) p_s'. Along saturation
        // dh/dp = v (1 − T α) + c_p dTsat/dp, with the Clapeyron slope of
        // the same tuple. p_s' follows the explicit p_s along the rates.
        let vapor_region_volume = x.vapor_volume + x.drop_volume;
        let vapor_density_rate = (rate.vapor_mass + rate.drop_mass
            - c.vapor_region_density * (rate.vapor_volume + rate.drop_volume))
            / vapor_region_volume;
        let mixture_rate = (rate.admitted_volume + rate.resident_volume + rate.bubble_volume)
            / s(c.surface_area_m2);
        let interface_pressure_rate = rate.roof_pressure
            + s(G)
                * (vapor_density_rate * (s(c.top_m) - c.mixture_elevation)
                    - c.vapor_region_density * mixture_rate);
        let tsat = sat.temperature;
        let slope = tsat * (s(1.) / sat.vapor.density - s(1.) / sat.liquid.density) / (hg - hf);
        let drift = |w: &WaterPoint| {
            let v = s(1.) / w.density;
            v * (s(1.) - tsat * w.expansion) + w.cp * slope - v
        };
        let transit_drift = [
            x.bubble_mass * drift(&sat.vapor) * interface_pressure_rate,
            x.drop_mass * drift(&sat.liquid) * interface_pressure_rate,
        ];
        energy[RV] = energy[RV] - transit_drift[0];
        energy[GV] = energy[GV] - transit_drift[1];

        // Zone volume work, paid once with the algebraic volume rates.
        let work = [
            g.pressure * rate.vapor_volume,
            a.pressure * rate.admitted_volume,
            r.pressure * rate.resident_volume,
        ];

        let mut sources = [s(0.); COORDINATES];
        sources[VAPOR_MASS] = mass[GV];
        sources[VAPOR_ENERGY] = energy[GV];
        sources[ADMITTED_MASS] = mass[AV];
        sources[ADMITTED_ENERGY] = energy[AV];
        sources[ADMITTED_BORON] = boron[0];
        sources[RESIDENT_MASS] = mass[RV];
        sources[RESIDENT_ENERGY] = energy[RV];
        sources[RESIDENT_BORON] = boron[1];
        sources[BUBBLE_MASS] = bubbles;
        sources[DROP_MASS] = drops;
        sources[DROP_BORON] = drop_boron;

        let rates = rate.to_array();
        let mut rows = [s(0.); COORDINATES];
        rows[ROOF_PRESSURE] =
            c.volume_defect(self.parameters.fluid_volume_m3) / s(self.parameters.fluid_volume_m3);
        rows[VAPOR_VOLUME] = (x.vapor_volume - g.mass / g.density) / s(scales[VAPOR_VOLUME]);
        rows[ADMITTED_VOLUME] =
            (x.admitted_volume - a.mass / a.density) / s(scales[ADMITTED_VOLUME]);
        rows[RESIDENT_VOLUME] =
            (x.resident_volume - r.mass / r.density) / s(scales[RESIDENT_VOLUME]);
        rows[BUBBLE_VOLUME] =
            (x.bubble_volume - x.bubble_mass / sat.vapor.density) / s(scales[BUBBLE_VOLUME]);
        rows[DROP_VOLUME] =
            (x.drop_volume - x.drop_mass / sat.liquid.density) / s(scales[DROP_VOLUME]);
        for i in VAPOR_MASS..COORDINATES {
            let paid = match i {
                VAPOR_ENERGY => work[0],
                ADMITTED_ENERGY => work[1],
                RESIDENT_ENERGY => work[2],
                _ => s(0.),
            };
            rows[i] = (rates[i] + paid - sources[i]) / s(scales[i]);
        }
        for row in &rows {
            finite(*row, "residual row")?;
        }
        let heat_total = heat.vapor + heat.admitted + heat.resident;
        let balance = Balance {
            mass_kg_s: mass[GV] + mass[AV] + mass[RV] + bubbles + drops,
            energy_w: energy[GV]
                + energy[AV]
                + energy[RV]
                + bubbles * hg
                + drops * hf
                + transit_drift[0]
                + transit_drift[1],
            boron_kg_s: boron[0] + boron[1] + drop_boron,
            receipt_mass_kg_s: receipt[0],
            receipt_energy_w: receipt[1] + heat_total,
            receipt_boron_kg_s: receipt[2],
            volume_work_w: work[0]
                + work[1]
                + work[2]
                + c.interface_pressure * (rate.bubble_volume + rate.drop_volume),
        };
        Ok(Evaluation {
            rows,
            column: c,
            flows: Flows {
                admitted_flashing: flash_a,
                resident_flashing: flash_r,
                vapor_condensation: condense,
                bubble_rise: rise,
                bubble,
                drop_fall: fall,
                drop_boron_fall: boron_fall,
                drop,
                transit_drift,
                spray_condensation,
                relief,
                interface_pressure_rate,
                interface,
                inversion,
                potential_density,
                conduction,
                work,
                sources,
            },
            balance,
        })
    }

    /// Prepared state at roof pressure `roof_pressure_pa` with the surface
    /// `level_m` above `bottom_m`: the interface on that level, A the liquid
    /// within the preparation thickness of the bottom, every zone at
    /// `Tsat(p_s)`, both layers at the absorber concentration and no transit
    /// stock. The masses solve the volume rows: each pass recomputes the
    /// column's pressures from the masses, each zone's `u` at `Tsat(p_s)`
    /// and its pressure, and its mass from the density the caloric inverse
    /// recovers from that `(p, u)`, until no pressure changes by more than
    /// the tolerance. The recovered temperatures equal `Tsat(p_s)` within
    /// the inverse's own convergence bound.
    pub fn prepare<P: Properties>(
        &self,
        properties: &P,
        roof_pressure_pa: f64,
        level_m: f64,
        pressure_tolerance_pa: f64,
        max_passes: usize,
    ) -> Result<Preparation, Failure> {
        let p = &self.parameters;
        let mixture = p.bottom_m + level_m;
        let boundary = p.bottom_m + p.stratified.admitted_preparation_thickness_m;
        if !(roof_pressure_pa.is_finite() && roof_pressure_pa > 0.)
            || !(boundary < mixture && mixture < p.top_m)
            || !(pressure_tolerance_pa.is_finite() && pressure_tolerance_pa > 0.)
        {
            return Err(fatal(format!(
                "preparation level {level_m} m or roof pressure {roof_pressure_pa} Pa is outside the cell"
            )));
        }
        let volume = |z: f64| self.geometry.volume(s(z)).value;
        let volumes = [
            p.fluid_volume_m3 - volume(mixture),
            volume(boundary),
            volume(mixture) - volume(boundary),
        ];
        let roof = properties
            .saturation(s(roof_pressure_pa))
            .map_err(recoverable)?;
        let mut density = [
            roof.vapor.density.value,
            roof.liquid.density.value,
            roof.liquid.density.value,
        ];
        let mut specific = [0.; 3];
        let mut temperature = 0.;
        let mut previous: Option<[f64; 4]> = None;
        let mut pass_changes_pa = Vec::new();
        let values = |density: [f64; 3], specific: [f64; 3]| {
            let mut v = [0.; COORDINATES];
            v[ROOF_PRESSURE] = roof_pressure_pa;
            v[VAPOR_VOLUME] = volumes[0];
            v[ADMITTED_VOLUME] = volumes[1];
            v[RESIDENT_VOLUME] = volumes[2];
            let masses = [0, 1, 2].map(|k| density[k] * volumes[k]);
            v[VAPOR_MASS] = masses[0];
            v[VAPOR_ENERGY] = masses[0] * specific[0];
            v[ADMITTED_MASS] = masses[1];
            v[ADMITTED_ENERGY] = masses[1] * specific[1];
            v[ADMITTED_BORON] = masses[1] * p.absorber_mass_fraction;
            v[RESIDENT_MASS] = masses[2];
            v[RESIDENT_ENERGY] = masses[2] * specific[2];
            v[RESIDENT_BORON] = masses[2] * p.absorber_mass_fraction;
            v
        };
        loop {
            let h = self.hydrostatics(&Coordinates::values(&values(density, specific)))?;
            let pressures = [
                h.interface_pressure.value,
                h.pressure[0].value,
                h.pressure[1].value,
                h.pressure[2].value,
            ];
            let change = previous.map_or(f64::INFINITY, |old| {
                old.iter()
                    .zip(&pressures)
                    .map(|(a, b)| (a - b).abs())
                    .fold(0., f64::max)
            });
            if previous.is_some() {
                pass_changes_pa.push(change);
            }
            if change <= pressure_tolerance_pa {
                break;
            }
            if pass_changes_pa.len() >= max_passes {
                return Err(fatal(format!(
                    "preparation did not converge to {pressure_tolerance_pa} Pa: {pass_changes_pa:?}"
                )));
            }
            previous = Some(pressures);
            temperature = properties
                .saturation(s(pressures[0]))
                .map_err(recoverable)?
                .temperature
                .value;
            for k in 0..3 {
                let (vapor, p) = (k == 0, pressures[k + 1]);
                let u = properties
                    .forward(vapor, p, temperature)
                    .map_err(recoverable)?
                    .internal_energy_j_kg;
                // The density the running cell recovers from exactly this
                // (p, U/M), so the prepared volume rows vanish to rounding.
                let point = properties
                    .caloric(vapor, p, u, false)
                    .map_err(recoverable)?;
                density[k] = properties.values(&point).density_kg_m3;
                specific[k] = u;
            }
        }
        let values = values(density, specific);
        let column = self.column(properties, &Coordinates::values(&values), None)?;
        Ok(Preparation {
            values,
            column,
            saturation_temperature_k: temperature,
            pass_changes_pa,
        })
    }

    /// Scaled coordinates that reproduce exactly the roof pressure, every
    /// volume, and every zone's specific internal energy `U/M`, as the
    /// residual reconstructs `y·scale`. Masses and boron are reproduced
    /// within `search` representable steps.
    pub fn coordinates(
        values: &[f64; COORDINATES],
        scales: &[f64; COORDINATES],
        search: usize,
    ) -> Result<[f64; COORDINATES], Failure> {
        let mut y = [0.; COORDINATES];
        let missing = |what: &str| {
            fatal(format!(
                "{what} has no exact coordinate within {search} steps"
            ))
        };
        for i in [
            ROOF_PRESSURE,
            VAPOR_VOLUME,
            ADMITTED_VOLUME,
            RESIDENT_VOLUME,
            BUBBLE_VOLUME,
            DROP_VOLUME,
            ADMITTED_BORON,
            RESIDENT_BORON,
            BUBBLE_MASS,
            DROP_MASS,
            DROP_BORON,
        ] {
            y[i] =
                coordinate(values[i], scales[i], search).ok_or_else(|| missing("a coordinate"))?;
        }
        for (m, e) in [
            (VAPOR_MASS, VAPOR_ENERGY),
            (ADMITTED_MASS, ADMITTED_ENERGY),
            (RESIDENT_MASS, RESIDENT_ENERGY),
        ] {
            let u = values[e] / values[m];
            let start = values[m] / scales[m];
            let found = offsets(search).find_map(|dm| {
                let ym = adjacent(start, dm);
                let mass = ym * scales[m];
                let energy = mass * u / scales[e];
                offsets(search)
                    .map(|du| adjacent(energy, du))
                    .find(|yu| yu * scales[e] / mass == u)
                    .map(|yu| (ym, yu))
            });
            let (ym, yu) = found.ok_or_else(|| missing("a specific internal energy"))?;
            y[m] = ym;
            y[e] = yu;
        }
        Ok(y)
    }

    /// PT1, the LT pressure difference, levels and signed departures of
    /// every zone at its own state pressure (3 value-only saturation calls).
    pub fn taps<P: Properties>(&self, properties: &P, column: &Column) -> Result<Taps, Failure> {
        let p = &self.parameters;
        let low = column.pressure_at(p.tap(LT_LOW)?);
        let high = column.pressure_at(p.tap(LT_HIGH)?);
        let band = &p.metastable;
        let departure = |zone: &Zone, vapor: bool| -> Result<Departure, Failure> {
            let pressure = zone.pressure.value;
            let tsat = properties
                .saturation(s(pressure))
                .map_err(recoverable)?
                .temperature
                .value;
            let t = zone.temperature.value;
            let departure_k = t - tsat;
            let metastable_k = if vapor { -departure_k } else { departure_k };
            let in_range = pressure <= band.pressure_range_pa[1]
                && if band.lower_bound_exclusive {
                    pressure > band.pressure_range_pa[0]
                } else {
                    pressure >= band.pressure_range_pa[0]
                };
            let limit = if vapor {
                band.vapor_subcooling_max_k
            } else {
                band.liquid_superheat_max_k
            };
            let within_band = metastable_k <= 0.
                || (in_range
                    && metastable_k <= limit
                    && (vapor || t <= band.liquid_temperature_max_k));
            Ok(Departure {
                pressure_pa: pressure,
                temperature_k: t,
                saturation_temperature_k: tsat,
                departure_k,
                metastable_k,
                within_band,
                credited: metastable_k <= band.credited_max_k,
            })
        };
        Ok(Taps {
            pt1_pa: column.pressure_at(p.tap(PT1)?),
            level_low_pa: low,
            level_high_pa: high,
            level_difference_pa: low - high,
            collapsed_level_m: column.collapsed_elevation - s(p.bottom_m),
            mixture_level_m: column.mixture_elevation - s(p.bottom_m),
            departures: [
                departure(&column.vapor, true)?,
                departure(&column.admitted, false)?,
                departure(&column.resident, false)?,
            ],
            admitted_mass_kg: column.admitted.mass,
            admitted_thickness_m: column.admitted_thickness,
            saturation_calls: 3,
        })
    }

    /// Total mass, energy and boron of the cell for conservation accounting.
    pub fn inventory(&self, x: &Coordinates, column: &Column) -> Inventory {
        let sat = &column.interface_saturation;
        Inventory {
            mass_kg: x.vapor_mass + x.admitted_mass + x.resident_mass + x.bubble_mass + x.drop_mass,
            energy_j: x.vapor_energy
                + x.admitted_energy
                + x.resident_energy
                + x.bubble_mass * sat.vapor.enthalpy
                + x.drop_mass * sat.liquid.enthalpy,
            boron_kg: x.admitted_boron + x.resident_boron + x.drop_boron,
        }
    }
}
