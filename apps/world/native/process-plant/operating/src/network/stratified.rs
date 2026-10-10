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
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Port {
    pub id: String,
    pub kind: PortKind,
    pub elevation_m: f64,
    pub face: usize,
    pub bore_m: f64,
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
        let surge = self
            .ports
            .iter()
            .filter(|p| p.kind == PortKind::Surge)
            .count();
        if surge != 1 {
            return Err(fatal("exactly one surge port is required"));
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

/// One run's sensitivity selection, taken only from the declared lists.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Case {
    /// Factor applied to both relaxation times.
    pub relaxation_factor: f64,
    pub drop_diameter_m: f64,
}
impl Case {
    pub fn nominal(parameters: &Parameters) -> Self {
        Self {
            relaxation_factor: 1.,
            drop_diameter_m: parameters.stratified.spray_drop_diameter_m,
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

/// External heat into each zone (heater, wall), W.
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
    pub fn new(parameters: Parameters, case: Case) -> Result<Self, Failure> {
        parameters.validate()?;
        let x = &parameters.stratified;
        if !x.relaxation_sensitivity.contains(&case.relaxation_factor)
            || !x
                .drop_diameter_sensitivity_m
                .contains(&case.drop_diameter_m)
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
        heat: Heat,
        scales: &[f64; COORDINATES],
        reuse: Option<(&mut Reuse<P::Caloric>, Slots)>,
    ) -> Result<Evaluation, Failure> {
        let column = self.column(properties, x, reuse)?;
        self.residual_on(column, x, rate, receipts, heat, scales)
    }

    /// The rows of [`Cell::residual`] on a column already evaluated at the
    /// same coordinates `x`; it makes no property call. `residual` is
    /// `column` followed by this, so both give bitwise identical rows.
    pub fn residual_on(
        &self,
        c: Column,
        x: &Coordinates,
        rate: &Coordinates,
        receipts: &[Receipt],
        heat: Heat,
        scales: &[f64; COORDINATES],
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
            }
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
        let bubble = terminal_velocity(x_params.bubble_diameter_m, sat.liquid, sat.vapor.density)?;
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
