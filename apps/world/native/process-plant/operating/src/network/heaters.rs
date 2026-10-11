//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/heater-equipment.md#electrical-demand-and-achieved-power
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/heater-equipment.md#fixed-metal-and-complementary-contact
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/heater-equipment.md#wet-transition-and-film-sources
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/heater-equipment.md#exposed-gas-radiation-and-condensation
//! The PZR heater rods of the stratified cell (decision 0014).
//!
//! Each bank of `ld01-pzr-heater-banks` is divided into its fixed axial
//! segments (`segments_m`). A segment is one radially lumped 304 steel
//! energy stock (`reference-304-caloric`) whose wall temperature is its
//! steel temperature, as in the offline slice reference. Heat never moves
//! axially between segments. Each segment receives its length share of its
//! bank's delivered Joule power, a declared boundary.
//!
//! The cell gives each segment its wetting by level. The wetted lengths in
//! A's and R's regions contact those zones through the shared CTF wet law
//! (the heater branch of `thermal::liquid_wall`), at the zone's own
//! centroid pressure and state. The self-consistent minimum-film endpoint
//! `Tm = Tmin(304 at Tm)` is solved once per contacted zone. The exposed
//! length contacts the vapor zone through the shared exposed gas law, with
//! g's column point as the donor steam. Every constant comes from
//! `ld01-pzr-heater-contact`.
//!
//! A segment's receipt reaches the cell by its span, with its wet heat and
//! wall vapor per zone as each zone's own contact gives them; its steel receives
//! the opposite of every fluid term. The band enclosure's radiation belongs
//! to the walls module, which owns its shell member; the rods alone have no
//! enclosure, so there an exposed segment of a powered bank refuses by
//! name. Nothing is clipped, floored, defaulted or prescribed.
use super::{
    Failure,
    stratified::{Cell, Column, HeaterReceipt, Wetting, Zone},
};
use crate::thermal::{
    self, Film, FilmBranch, GasContact, HeaterFilm, Saturation, Scalar, WallFlux, WallLaw,
    WallMaterial, WaterPoint, WaterProperties,
};
use serde::Deserialize;

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("PZR heaters: {}", reason.into()))
}
fn recoverable(reason: impl Into<String>) -> Failure {
    Failure::Recoverable(format!("PZR heaters: {}", reason.into()))
}
fn finite(v: Scalar, what: &str) -> Result<Scalar, Failure> {
    if v.value.is_finite() && v.direction.is_finite() {
        Ok(v)
    } else {
        Err(recoverable(format!("nonfinite {what}")))
    }
}
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
/// A contact exists unless its area is exactly zero with zero direction;
/// absent contact evaluates no property.
fn present(x: Scalar) -> bool {
    x.value != 0. || x.direction != 0.
}
/// Agreement within the strict blocks' printed precision.
fn agrees(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-6 * a.abs().max(b.abs())
}

/// One bank of the `ld01-pzr-heater-banks` strict block.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BankBlock {
    pub id: String,
    #[serde(rename = "equivalentRods")]
    pub equivalent_rods: u32,
    #[serde(rename = "rodDiameter_m")]
    pub rod_diameter_m: f64,
    #[serde(rename = "spanBottomAbovePzrBottom_m")]
    pub span_bottom_m: f64,
    #[serde(rename = "spanTopAbovePzrBottom_m")]
    pub span_top_m: f64,
    /// Axial segments above the PZR bottom, contiguous over the span.
    #[serde(rename = "segments_m")]
    pub segments_m: Vec<[f64; 2]>,
    #[serde(rename = "nominalCapacity_W")]
    pub nominal_capacity_w: f64,
    #[serde(rename = "lateralContactArea_m2")]
    pub lateral_contact_area_m2: f64,
    #[serde(rename = "solidDisplacement_m3")]
    pub solid_displacement_m3: f64,
    #[serde(rename = "steelMass_kg")]
    pub steel_mass_kg: f64,
}
/// The `ld01-pzr-heater-banks` strict block.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BanksBlock {
    pub banks: Vec<BankBlock>,
}

/// The `reference-304-caloric` record: `cp = a + b T` with its exact
/// quadratic energy from the datum and the selected thermal domain.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Caloric304 {
    #[serde(rename = "density_kg_m3")]
    pub density_kg_m3: f64,
    #[serde(rename = "cpConstant_J_kg_K")]
    pub cp_constant: f64,
    #[serde(rename = "cpLinear_J_kg_K2")]
    pub cp_linear: f64,
    #[serde(rename = "datum_K")]
    pub datum_k: f64,
    #[serde(rename = "minimum_K")]
    pub minimum_k: f64,
    #[serde(rename = "maximum_K")]
    pub maximum_k: f64,
}
impl Caloric304 {
    pub fn validate(&self) -> Result<(), Failure> {
        positive_finite(&[
            ("density_kg_m3", self.density_kg_m3),
            ("datum_K", self.datum_k),
            ("minimum_K", self.minimum_k),
        ])?;
        if !(self.cp_constant.is_finite()
            && self.cp_linear.is_finite()
            && self.maximum_k.is_finite()
            && self.minimum_k < self.maximum_k)
        {
            return Err(fatal("invalid 304 caloric record"));
        }
        // cp is linear, so positive at both ends means positive throughout.
        for t in [self.minimum_k, self.maximum_k] {
            if self.cp(s(t)).value <= 0. {
                return Err(fatal(format!("304 heat capacity is not positive at {t} K")));
            }
        }
        Ok(())
    }
    fn admit(&self, t: f64) -> Result<(), Failure> {
        if t.is_finite() && t >= self.minimum_k && t <= self.maximum_k {
            Ok(())
        } else {
            Err(recoverable(format!(
                "rod steel at {t} K is outside the {}–{} K 304 caloric domain",
                self.minimum_k, self.maximum_k
            )))
        }
    }
    /// `cp(T)`, J/(kg K).
    pub fn cp(&self, t: Scalar) -> Scalar {
        s(self.cp_constant) + s(self.cp_linear) * t
    }
    /// `e(T) = a (T − T0) + b/2 (T² − T0²)` from the datum, J/kg; refuses
    /// outside the domain.
    pub fn specific_energy(&self, t: Scalar) -> Result<Scalar, Failure> {
        self.admit(t.value)?;
        let t0 = self.datum_k;
        Ok(s(self.cp_constant) * (t - s(t0)) + s(self.cp_linear / 2.) * (t * t - s(t0 * t0)))
    }
    /// The exact inverse `T(e)` of the quadratic caloric, with
    /// `dT = de / cp(T)`. The domain is admitted on the energy coordinate,
    /// `e(min) ≤ e ≤ e(max)`, so a state on a bound is not refused for the
    /// inverse's last-bit rounding.
    pub fn temperature(&self, e: Scalar) -> Result<Scalar, Failure> {
        let low = self.specific_energy(s(self.minimum_k))?.value;
        let high = self.specific_energy(s(self.maximum_k))?.value;
        if !(e.value >= low && e.value <= high) {
            return Err(recoverable(format!(
                "rod steel energy {} J/kg is outside the {}–{} K 304 caloric domain [{low}, {high}] J/kg",
                e.value, self.minimum_k, self.maximum_k
            )));
        }
        let (a, b, t0) = (self.cp_constant, self.cp_linear, self.datum_k);
        // b/2 T² + a T − c = 0 with c = e + a T0 + b/2 T0² > 0 on the
        // domain, solved without cancellation.
        let c = e.value + a * t0 + 0.5 * b * t0 * t0;
        let t = 2. * c / (a + (a * a + 2. * b * c).sqrt());
        finite(
            Scalar::new(t, e.direction / (a + b * t)),
            "rod steel temperature",
        )
    }
}

/// The `wet` part of `ld01-pzr-heater-contact`.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WetBlock {
    #[serde(rename = "sensibleCoefficient_W_m2K")]
    pub sensible_coefficient_w_m2_k: f64,
    #[serde(rename = "onsetContactAngle_deg")]
    pub onset_contact_angle_deg: f64,
    #[serde(rename = "wallBirthFraction")]
    pub wall_birth_fraction: f64,
    #[serde(rename = "wallBirthFractionSensitivity")]
    pub wall_birth_fraction_sensitivity: f64,
    #[serde(rename = "bromleyCoefficient")]
    pub bromley_coefficient: f64,
    #[serde(rename = "filmRadiationCoefficient")]
    pub film_radiation_coefficient: f64,
    #[serde(rename = "minimumFilmBounds_K")]
    pub minimum_film_bounds_k: [f64; 2],
    #[serde(rename = "filmConvectionSensitivity")]
    pub film_convection_sensitivity: [f64; 2],
}
/// The `exposed` part of `ld01-pzr-heater-contact`.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExposedBlock {
    #[serde(rename = "gasCoefficient_W_m2K")]
    pub gas_coefficient_w_m2_k: f64,
    #[serde(rename = "gasCoefficientSensitivity")]
    pub gas_coefficient_sensitivity: [f64; 2],
    #[serde(rename = "enclosureEmissivity")]
    pub enclosure_emissivity: f64,
    #[serde(rename = "condensationSpeed_m_s")]
    pub condensation_speed_m_s: f64,
}
/// `k(T) = k0 + k1 T` of the ANL 304 basis.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Conductivity304 {
    #[serde(rename = "constant_W_m_K")]
    pub constant_w_m_k: f64,
    #[serde(rename = "linear_W_m_K2")]
    pub linear_w_m_k2: f64,
}
/// The `ld01-pzr-heater-contact` strict block.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContactBlock {
    pub wet: WetBlock,
    pub exposed: ExposedBlock,
    #[serde(rename = "conductivity304")]
    pub conductivity_304: Conductivity304,
}
impl ContactBlock {
    pub fn validate(&self) -> Result<(), Failure> {
        let (w, x) = (&self.wet, &self.exposed);
        positive_finite(&[
            ("sensibleCoefficient_W_m2K", w.sensible_coefficient_w_m2_k),
            ("onsetContactAngle_deg", w.onset_contact_angle_deg),
            ("wallBirthFraction", w.wall_birth_fraction),
            (
                "wallBirthFractionSensitivity",
                w.wall_birth_fraction_sensitivity,
            ),
            ("bromleyCoefficient", w.bromley_coefficient),
            ("filmRadiationCoefficient", w.film_radiation_coefficient),
            ("gasCoefficient_W_m2K", x.gas_coefficient_w_m2_k),
            ("enclosureEmissivity", x.enclosure_emissivity),
            ("condensationSpeed_m_s", x.condensation_speed_m_s),
            (
                "conductivity304 constant",
                self.conductivity_304.constant_w_m_k,
            ),
        ])?;
        for v in w
            .film_convection_sensitivity
            .iter()
            .chain(&x.gas_coefficient_sensitivity)
        {
            positive_finite(&[("sensitivity factor", *v)])?;
        }
        let [low, high] = w.minimum_film_bounds_k;
        if !(low.is_finite() && high.is_finite() && 0. < low && low < high)
            || w.wall_birth_fraction > 1.
            || w.wall_birth_fraction_sensitivity > 1.
            || w.film_radiation_coefficient > 1.
            || x.enclosure_emissivity > 1.
            || !self.conductivity_304.linear_w_m_k2.is_finite()
        {
            return Err(fatal("invalid ld01-pzr-heater-contact values"));
        }
        Ok(())
    }
}

/// One run's heater sensitivity selection, taken only from the block.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HeaterCase {
    /// `chi`: the block's nominal value or its contrary sensitivity.
    pub wall_birth_fraction: f64,
    /// 1 (the selected law) or one of the block's film convection factors.
    pub film_convection_factor: f64,
    /// 1 (the selected law) or one of the block's gas coefficient factors.
    pub gas_coefficient_factor: f64,
}
impl HeaterCase {
    pub fn nominal(contact: &ContactBlock) -> Self {
        Self {
            wall_birth_fraction: contact.wet.wall_birth_fraction,
            film_convection_factor: 1.,
            gas_coefficient_factor: 1.,
        }
    }
    pub fn validate(&self, contact: &ContactBlock) -> Result<(), Failure> {
        let w = &contact.wet;
        let declared = |v: f64, list: &[f64]| v == 1. || list.contains(&v);
        if !(self.wall_birth_fraction == w.wall_birth_fraction
            || self.wall_birth_fraction == w.wall_birth_fraction_sensitivity)
            || !declared(self.film_convection_factor, &w.film_convection_sensitivity)
            || !declared(
                self.gas_coefficient_factor,
                &contact.exposed.gas_coefficient_sensitivity,
            )
        {
            return Err(fatal(format!(
                "heater case {self:?} is not in the declared sensitivities"
            )));
        }
        Ok(())
    }
}

/// A bank compiled onto the plant datum.
#[derive(Clone, Debug)]
pub struct HeaterBank {
    pub id: String,
    pub rods: u32,
    pub rod_diameter_m: f64,
    /// Active span on the plant datum; its length is the Bromley rod length.
    pub bottom_m: f64,
    pub top_m: f64,
    pub nominal_capacity_w: f64,
    pub lateral_area_m2: f64,
    pub steel_mass_kg: f64,
    pub displacement_m3: f64,
    /// This bank's entries in [`Heaters::segments`].
    pub segments: std::ops::Range<usize>,
}

/// One fixed rod segment: one lumped steel energy coordinate.
#[derive(Clone, Copy, Debug)]
pub struct Segment {
    pub bank: usize,
    /// Span on the plant datum.
    pub bottom_m: f64,
    pub top_m: f64,
    /// The bank's steel mass, lateral area and Joule power by length share.
    pub steel_mass_kg: f64,
    pub lateral_area_m2: f64,
    pub power_share: f64,
}

/// The coordinates the heaters add: one differential steel energy (J,
/// from the 304 datum) per segment, in [`Heaters::segments`] order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Census {
    pub coordinates: Vec<String>,
    pub differential: usize,
    pub algebraic: usize,
}

/// A contacted liquid zone's state with its saturation tuple and the
/// self-consistent minimum-film endpoint, shared by every segment.
#[derive(Clone, Copy, Debug)]
pub struct LiquidContact {
    /// The zone's centroid pressure and state.
    pub pressure: Scalar,
    pub temperature: Scalar,
    pub point: WaterPoint,
    /// Saturation at the zone's own pressure.
    pub saturation: Saturation,
    /// `Tm = Tmin(304 properties at Tm)`, with its implicit direction.
    pub minimum_film: Scalar,
    material: WallMaterial,
}
impl LiquidContact {
    /// The 304 properties at the self-consistent endpoint, which every PZR
    /// wet law in this zone uses for its minimum-film selector.
    pub fn material(&self) -> WallMaterial {
        self.material
    }
}

/// One segment's sources in one evaluation.
#[derive(Clone, Copy, Debug)]
pub struct SegmentRates {
    pub receipt: HeaterReceipt,
    /// The steel's energy rate `P − (fluid receipts)`, W.
    pub metal_rate: Scalar,
    /// The fluid's total energy receipt as the cell books it:
    /// `q + Q_exposed − j h_g + j h_l(Tw)`, W.
    pub fluid_energy_w: Scalar,
    /// Steel and wall temperature, K.
    pub temperature: Scalar,
    pub wetting: Wetting,
    /// Contact areas with A, R and the vapor zone; they sum to the
    /// segment's lateral area.
    pub areas: [Scalar; 3],
    pub joule_w: f64,
    /// Per-area laws; `None` where the contact area is exactly zero.
    pub admitted: Option<WallFlux>,
    pub resident: Option<WallFlux>,
    pub exposed: Option<GasContact>,
}

/// All segments' sources of one evaluation.
#[derive(Clone, Debug)]
pub struct Rates {
    pub segments: Vec<SegmentRates>,
    /// The contacted A and R zones, when some segment wets them.
    pub contacts: [Option<LiquidContact>; 2],
    /// Saturation calls made: one per contacted liquid zone and one per
    /// exposed segment's dew point.
    pub saturation_calls: usize,
}
impl Rates {
    pub fn receipts(&self) -> Vec<HeaterReceipt> {
        self.segments.iter().map(|r| r.receipt).collect()
    }
    pub fn metal_rates(&self) -> Vec<Scalar> {
        self.segments.iter().map(|r| r.metal_rate).collect()
    }
}

fn values(w: WaterPoint) -> WaterPoint {
    WaterPoint {
        density: s(w.density.value),
        viscosity: s(w.viscosity.value),
        conductivity: s(w.conductivity.value),
        cp: s(w.cp.value),
        expansion: s(w.expansion.value),
        enthalpy: s(w.enthalpy.value),
    }
}
/// 304 properties at a steel temperature: `k(T)`, density and `cp(T)`.
pub(crate) fn material_304(
    caloric: &Caloric304,
    contact: &ContactBlock,
    t: Scalar,
) -> WallMaterial {
    let k = &contact.conductivity_304;
    WallMaterial {
        conductivity: s(k.constant_w_m_k) + s(k.linear_w_m_k2) * t,
        density: caloric.density_kg_m3,
        cp: caloric.cp(t),
    }
}

/// The self-consistent minimum-film endpoint `Tm = Tmin(304 at Tm)` at
/// one liquid state. `Tm − Tmin` increases on the selector's bounds,
/// which bracket it; values are bisected to machine precision and the
/// direction follows the implicit function. `minimum_film` reads only
/// the material and the bounds, which every bank shares.
fn minimum_film_endpoint(
    caloric: &Caloric304,
    contact: &ContactBlock,
    law: &dyn Fn(WallMaterial) -> WallLaw,
    pressure: Scalar,
    bulk_t: Scalar,
    sat: Saturation,
) -> Result<(Scalar, WallMaterial), Failure> {
    let failed = |e: &str| recoverable(format!("minimum-film endpoint: {e}"));
    let at = |t: Scalar, p: Scalar, tl: Scalar, sat: Saturation| {
        thermal::minimum_film(p, tl, law(material_304(caloric, contact, t)), sat).map_err(failed)
    };
    let (pv, tv, sv) = (s(pressure.value), s(bulk_t.value), saturation_values(sat));
    let residual = |t: f64| at(s(t), pv, tv, sv).map(|f| t - f.value);
    let [mut low, mut high] = contact.wet.minimum_film_bounds_k;
    if !(residual(low)? <= 0. && residual(high)? >= 0.) {
        return Err(failed("the selector bounds do not bracket Tm"));
    }
    for _ in 0..64 {
        let mid = 0.5 * (low + high);
        if mid <= low || mid >= high {
            break;
        }
        if residual(mid)? > 0. {
            high = mid;
        } else {
            low = mid;
        }
    }
    let root = 0.5 * (low + high);
    let fixed = at(s(root), pressure, bulk_t, sat)?;
    let seeded = at(Scalar::new(root, 1.), pv, tv, sv)?;
    let slope = 1. - seeded.direction;
    if !(slope.is_finite() && slope > 0.) {
        return Err(failed("singular self-consistent endpoint"));
    }
    let tm = Scalar::new(root, fixed.direction / slope);
    Ok((tm, material_304(caloric, contact, tm)))
}

/// A liquid contact on 304 steel for any heater-film wet law: the zone's
/// state with its saturation and the self-consistent minimum-film endpoint.
/// The rods pass a bank's law and the walls of a vessel without rods their
/// own; `minimum_film` reads only the material and the shared bounds.
#[allow(clippy::too_many_arguments)]
pub(crate) fn contact_on_304(
    caloric: &Caloric304,
    contact: &ContactBlock,
    law: &dyn Fn(WallMaterial) -> WallLaw,
    pressure: Scalar,
    temperature: Scalar,
    point: WaterPoint,
    saturation: Saturation,
) -> Result<LiquidContact, Failure> {
    let (minimum_film, material) =
        minimum_film_endpoint(caloric, contact, law, pressure, temperature, saturation)?;
    Ok(LiquidContact {
        pressure,
        temperature,
        point,
        saturation,
        minimum_film,
        material,
    })
}

fn saturation_values(sat: Saturation) -> Saturation {
    Saturation {
        temperature: s(sat.temperature.value),
        liquid: values(sat.liquid),
        vapor: values(sat.vapor),
        surface_tension: s(sat.surface_tension.value),
    }
}
/// A zone's column water point, the same tuple the cell evaluated.
pub fn zone_point(zone: &Zone) -> WaterPoint {
    WaterPoint {
        density: zone.density,
        viscosity: zone.viscosity,
        conductivity: zone.conductivity,
        cp: zone.cp,
        expansion: zone.expansion,
        enthalpy: zone.enthalpy,
    }
}

/// The heater banks of one stratified cell, compiled from their blocks.
#[derive(Clone, Debug)]
pub struct Heaters {
    banks: Vec<HeaterBank>,
    segments: Vec<Segment>,
    caloric: Caloric304,
    contact: ContactBlock,
    case: HeaterCase,
}

impl Heaters {
    /// Admits the blocks against each other and against the cell's heater
    /// section: contiguous segments over each span, the span inside the
    /// cell's heater span, and the areas, masses and displacements
    /// consistent with the rods within the blocks' printed precision.
    pub fn new(
        cell: &Cell,
        block: &BanksBlock,
        caloric: Caloric304,
        contact: ContactBlock,
        case: HeaterCase,
    ) -> Result<Self, Failure> {
        caloric.validate()?;
        contact.validate()?;
        case.validate(&contact)?;
        let p = cell.parameters();
        if block.banks.is_empty() {
            return Err(fatal("no heater banks"));
        }
        let mut banks = Vec::with_capacity(block.banks.len());
        let mut segments = Vec::new();
        let mut displacement = 0.;
        for (index, b) in block.banks.iter().enumerate() {
            if block.banks[..index].iter().any(|o| o.id == b.id) {
                return Err(fatal(format!("bank {} is declared twice", b.id)));
            }
            positive_finite(&[
                ("rodDiameter_m", b.rod_diameter_m),
                ("nominalCapacity_W", b.nominal_capacity_w),
                ("lateralContactArea_m2", b.lateral_contact_area_m2),
                ("solidDisplacement_m3", b.solid_displacement_m3),
                ("steelMass_kg", b.steel_mass_kg),
            ])?;
            let length = b.span_top_m - b.span_bottom_m;
            if b.equivalent_rods == 0
                || !(b.span_bottom_m.is_finite() && b.span_bottom_m >= 0. && length > 0.)
            {
                return Err(fatal(format!("bank {} has no rods or no span", b.id)));
            }
            let (bottom, top) = (p.bottom_m + b.span_bottom_m, p.bottom_m + b.span_top_m);
            if bottom < p.heaters.bottom_m || top > p.heaters.top_m {
                return Err(fatal(format!(
                    "bank {} lies outside the cell's heater span",
                    b.id
                )));
            }
            let rods = f64::from(b.equivalent_rods);
            let section = rods * std::f64::consts::PI * b.rod_diameter_m * b.rod_diameter_m / 4.;
            if !agrees(
                rods * std::f64::consts::PI * b.rod_diameter_m * length,
                b.lateral_contact_area_m2,
            ) || !agrees(section * length, b.solid_displacement_m3)
                || !agrees(
                    caloric.density_kg_m3 * b.solid_displacement_m3,
                    b.steel_mass_kg,
                )
            {
                return Err(fatal(format!(
                    "bank {} area, displacement and steel mass disagree with its rods",
                    b.id
                )));
            }
            displacement += b.solid_displacement_m3;
            let (Some(first), Some(last)) = (b.segments_m.first(), b.segments_m.last()) else {
                return Err(fatal(format!("bank {} declares no segments", b.id)));
            };
            if first[0] != b.span_bottom_m || last[1] != b.span_top_m {
                return Err(fatal(format!("bank {} segments must cover its span", b.id)));
            }
            let start = segments.len();
            for (j, [from, to]) in b.segments_m.iter().copied().enumerate() {
                if !(from.is_finite() && to.is_finite() && from < to)
                    || (j > 0 && b.segments_m[j - 1][1] != from)
                {
                    return Err(fatal(format!(
                        "bank {} segments must ascend contiguously",
                        b.id
                    )));
                }
                let share = (to - from) / length;
                segments.push(Segment {
                    bank: index,
                    bottom_m: p.bottom_m + from,
                    top_m: p.bottom_m + to,
                    steel_mass_kg: b.steel_mass_kg * share,
                    lateral_area_m2: b.lateral_contact_area_m2 * share,
                    power_share: share,
                });
            }
            banks.push(HeaterBank {
                id: b.id.clone(),
                rods: b.equivalent_rods,
                rod_diameter_m: b.rod_diameter_m,
                bottom_m: bottom,
                top_m: top,
                nominal_capacity_w: b.nominal_capacity_w,
                lateral_area_m2: b.lateral_contact_area_m2,
                steel_mass_kg: b.steel_mass_kg,
                displacement_m3: b.solid_displacement_m3,
                segments: start..segments.len(),
            });
        }
        if !agrees(displacement, p.heaters.displacement_m3) {
            return Err(fatal(format!(
                "bank displacement {displacement} m³ differs from the cell's {} m³",
                p.heaters.displacement_m3
            )));
        }
        Ok(Self {
            banks,
            segments,
            caloric,
            contact,
            case,
        })
    }

    pub fn banks(&self) -> &[HeaterBank] {
        &self.banks
    }
    pub fn segments(&self) -> &[Segment] {
        &self.segments
    }
    pub fn caloric(&self) -> &Caloric304 {
        &self.caloric
    }
    pub fn case(&self) -> HeaterCase {
        self.case
    }

    /// One differential steel energy per segment; nothing algebraic.
    pub fn census(&self) -> Census {
        Census {
            coordinates: self
                .segments
                .iter()
                .map(|g| {
                    format!(
                        "heater {} [{}, {}] m steel energy U (J)",
                        self.banks[g.bank].id, g.bottom_m, g.top_m
                    )
                })
                .collect(),
            differential: self.segments.len(),
            algebraic: 0,
        }
    }

    fn bank(&self, id: &str) -> Result<usize, Failure> {
        self.banks
            .iter()
            .position(|b| b.id == id)
            .ok_or_else(|| fatal(format!("bank {id} is not declared")))
    }

    /// The selected continuous split of an accepted nominal-voltage
    /// request `P` in `[0, C_normal + C_backup]`: `normal = min(P,
    /// C_normal)` and `backup = max(P − C_normal, 0)`, in bank order. A
    /// request outside the range is rejected, not reinterpreted.
    pub fn bank_powers(&self, request_w: f64) -> Result<Vec<f64>, Failure> {
        let (normal, backup) = (self.bank("normal")?, self.bank("backup")?);
        let capacity = self.banks[normal].nominal_capacity_w;
        let total = capacity + self.banks[backup].nominal_capacity_w;
        if self.banks.len() != 2 || !(request_w.is_finite() && (0. ..=total).contains(&request_w)) {
            return Err(fatal(format!(
                "heater request {request_w} W is outside its accepted range [0, {total}] W"
            )));
        }
        let mut powers = vec![0.; 2];
        powers[normal] = request_w.min(capacity);
        powers[backup] = (request_w - capacity).max(0.);
        Ok(powers)
    }

    /// Every segment's steel energy at one uniform steel temperature.
    pub fn prepared_energy(&self, temperature_k: f64) -> Result<Vec<f64>, Failure> {
        let e = self.caloric.specific_energy(s(temperature_k))?.value;
        Ok(self.segments.iter().map(|g| g.steel_mass_kg * e).collect())
    }

    /// Steel temperatures from the segments' energy coordinates.
    pub fn temperatures(&self, metal: &[Scalar]) -> Result<Vec<Scalar>, Failure> {
        if metal.len() != self.segments.len() {
            return Err(fatal(format!(
                "{} steel energies for {} segments",
                metal.len(),
                self.segments.len()
            )));
        }
        self.segments
            .iter()
            .zip(metal)
            .map(|(g, u)| self.caloric.temperature(*u / s(g.steel_mass_kg)))
            .collect()
    }

    /// The bank's heater wet law with a given steel material.
    fn law(&self, bank: usize, material: WallMaterial) -> WallLaw {
        let (b, w) = (&self.banks[bank], &self.contact.wet);
        WallLaw {
            diameter_m: b.rod_diameter_m,
            film: Film::Heater(HeaterFilm {
                sensible_w_m2_k: w.sensible_coefficient_w_m2_k,
                onset_contact_angle_deg: w.onset_contact_angle_deg,
                wall_birth_fraction: self.case.wall_birth_fraction,
                minimum_film_bounds_k: w.minimum_film_bounds_k,
                film: FilmBranch::Vertical {
                    coefficient: w.bromley_coefficient,
                    length_m: b.top_m - b.bottom_m,
                    convection_factor: self.case.film_convection_factor,
                },
            }),
            emissivity: w.film_radiation_coefficient,
            material,
        }
    }

    /// A liquid contact at any state: saturation at its pressure (one call)
    /// and the self-consistent minimum-film endpoint.
    pub fn liquid_contact_at<P: WaterProperties>(
        &self,
        pressure: Scalar,
        temperature: Scalar,
        point: WaterPoint,
        props: &P,
    ) -> Result<LiquidContact, Failure> {
        let saturation = props.saturation(pressure).map_err(|e| {
            recoverable(format!(
                "liquid contact saturation at {} Pa: {e}",
                pressure.value
            ))
        })?;
        let law = |m: WallMaterial| self.law(0, m);
        contact_on_304(
            &self.caloric,
            &self.contact,
            &law,
            pressure,
            temperature,
            point,
            saturation,
        )
    }
    /// A column liquid zone as the rods contact it: its centroid pressure
    /// and its own column water point.
    pub fn liquid_contact<P: WaterProperties>(
        &self,
        zone: &Zone,
        props: &P,
    ) -> Result<LiquidContact, Failure> {
        self.liquid_contact_at(zone.pressure, zone.temperature, zone_point(zone), props)
    }

    /// The wet law per square metre of one bank's rods at a wall
    /// temperature, in a stagnant pool (the heater law has no flow term).
    pub fn wet_flux<P: WaterProperties>(
        &self,
        bank: usize,
        contact: &LiquidContact,
        wall_t: Scalar,
        props: &P,
    ) -> Result<WallFlux, Failure> {
        thermal::liquid_wall_current(
            props,
            contact.pressure,
            contact.temperature,
            wall_t,
            s(0.),
            self.law(bank, contact.material),
            contact.saturation,
            contact.point,
        )
        .map_err(|e| {
            recoverable(format!(
                "{} wet contact at {} Pa, liquid {} K, wall {} K: {e}",
                self.banks[bank].id,
                contact.pressure.value,
                contact.temperature.value,
                wall_t.value
            ))
        })
    }

    /// The exposed gas law per square metre against the vapor zone, with
    /// g's column point as the donor steam; one dew-point saturation call.
    pub fn exposed_flux<P: WaterProperties>(
        &self,
        vapor: &Zone,
        wall_t: Scalar,
        props: &P,
    ) -> Result<GasContact, Failure> {
        if vapor.mass.value <= 0. {
            return Err(recoverable(
                "an exposed heater segment needs the vapor zone",
            ));
        }
        let x = &self.contact.exposed;
        let point = zone_point(vapor);
        thermal::gas_contact(
            props,
            vapor.pressure,
            vapor.temperature,
            wall_t,
            x.gas_coefficient_w_m2_k * self.case.gas_coefficient_factor,
            x.condensation_speed_m_s,
            Some(|| Ok(point)),
        )
        .map_err(|e| {
            recoverable(format!(
                "exposed contact at {} Pa, gas {} K, wall {} K: {e}",
                vapor.pressure.value, vapor.temperature.value, wall_t.value
            ))
        })
    }

    /// The contacted liquid zones of one evaluation, A then R: a zone gets
    /// its contact (one saturation call and its minimum-film endpoint)
    /// exactly when some segment wets it.
    pub fn contacts<P: WaterProperties>(
        &self,
        column: &Column,
        wetting: &[Wetting],
        props: &P,
    ) -> Result<[Option<LiquidContact>; 2], Failure> {
        let contact = |wets: bool, zone: &Zone| -> Result<Option<LiquidContact>, Failure> {
            if wets {
                self.liquid_contact(zone, props).map(Some)
            } else {
                Ok(None)
            }
        };
        Ok([
            contact(
                wetting.iter().any(|w| present(w.admitted_length_m)),
                &column.admitted,
            )?,
            contact(
                wetting.iter().any(|w| present(w.resident_length_m)),
                &column.resident,
            )?,
        ])
    }

    /// One segment's receipt and steel energy rate from the column, the
    /// segment's wetting (`Cell::heater_wetting` over its span), its steel
    /// energy coordinate, its bank's delivered Joule power and the shared
    /// zone contacts of [`Heaters::contacts`]. The steel rate excludes the
    /// band enclosure's radiation, which the walls module owns and adds
    /// (`walls::Walls::rates`).
    #[allow(clippy::too_many_arguments)]
    pub fn segment_rates<P: WaterProperties>(
        &self,
        index: usize,
        column: &Column,
        wetting: &Wetting,
        metal: Scalar,
        bank_power_w: f64,
        contacts: &[Option<LiquidContact>; 2],
        props: &P,
    ) -> Result<SegmentRates, Failure> {
        let g = self
            .segments
            .get(index)
            .ok_or_else(|| fatal(format!("segment {index} is not declared")))?;
        let w = wetting;
        let bank = &self.banks[g.bank];
        if !bank_power_w.is_finite() {
            return Err(fatal(format!("bank {} power is not finite", bank.id)));
        }
        let joule = bank_power_w * g.power_share;
        let t = self.caloric.temperature(metal / s(g.steel_mass_kg))?;
        let length = s(g.top_m - g.bottom_m);
        let area = |l: Scalar| s(g.lateral_area_m2) * l / length;
        let areas = [
            area(w.admitted_length_m),
            area(w.resident_length_m),
            area(w.exposed_length_m),
        ];
        let wet = |a: Scalar, c: &Option<LiquidContact>| -> Result<Option<WallFlux>, Failure> {
            match (present(a), c) {
                (false, _) => Ok(None),
                (true, Some(c)) => self.wet_flux(g.bank, c, t, props).map(Some),
                (true, None) => Err(fatal(format!(
                    "{} segment [{}, {}] m wets a zone without its contact",
                    bank.id, g.bottom_m, g.top_m
                ))),
            }
        };
        let on_admitted = wet(areas[0], &contacts[0])?;
        let on_resident = wet(areas[1], &contacts[1])?;
        let exposed = if present(areas[2]) {
            Some(self.exposed_flux(&column.vapor, t, props)?)
        } else {
            None
        };
        // Per zone, as the cell routes them: A's and R's own contact.
        let mut wet_heat = [s(0.); 2];
        let mut wet_vapor = [s(0.); 2];
        for (z, (a, q)) in [(areas[0], on_admitted), (areas[1], on_resident)]
            .into_iter()
            .enumerate()
        {
            if let Some(q) = q {
                wet_heat[z] = finite(a * q.heat, "heater wet heat")?;
                wet_vapor[z] = finite(a * q.vapor_mass, "heater wall vapor")?;
            }
        }
        // No condensate carries no enthalpy: its product with j is zero.
        let (exposed_heat, condensate, condensate_enthalpy) = match exposed {
            None => (s(0.), s(0.), s(0.)),
            Some(x) => match x.condensation {
                None => (areas[2] * x.sensible, s(0.), s(0.)),
                Some(c) => (areas[2] * x.sensible, areas[2] * c.mass, c.liquid_enthalpy),
            },
        };
        let fluid = wet_heat[0] + wet_heat[1] + exposed_heat - condensate * column.vapor.enthalpy
            + condensate * condensate_enthalpy;
        let receipt = HeaterReceipt {
            bottom_m: g.bottom_m,
            top_m: g.top_m,
            wet_heat_w: wet_heat,
            wet_vapor_kg_s: wet_vapor,
            exposed_heat_w: finite(exposed_heat, "heater exposed heat")?,
            condensate_kg_s: finite(condensate, "heater condensate")?,
            condensate_enthalpy_j_kg: finite(condensate_enthalpy, "condensate enthalpy")?,
        };
        Ok(SegmentRates {
            receipt,
            metal_rate: finite(s(joule) - fluid, "heater steel rate")?,
            fluid_energy_w: fluid,
            temperature: t,
            wetting: *w,
            areas,
            joule_w: joule,
            admitted: on_admitted,
            resident: on_resident,
            exposed,
        })
    }

    /// Every segment's receipt and steel energy rate from the column, the
    /// steel energy coordinates (in segment order) and each bank's
    /// delivered Joule power (in bank order), for rods without the walls
    /// module. These rods have no enclosure, so an exposed segment of a
    /// powered bank refuses by name; with the walls module use
    /// `walls::Walls::rates`, which supplies the shell member.
    pub fn rates<P: WaterProperties>(
        &self,
        cell: &Cell,
        column: &Column,
        metal: &[Scalar],
        bank_power_w: &[f64],
        props: &P,
    ) -> Result<Rates, Failure> {
        if metal.len() != self.segments.len() || bank_power_w.len() != self.banks.len() {
            return Err(fatal(format!(
                "{} steel energies and {} bank powers are required",
                self.segments.len(),
                self.banks.len()
            )));
        }
        let wetting = self
            .segments
            .iter()
            .map(|g| cell.heater_wetting(column, g.bottom_m, g.top_m))
            .collect::<Result<Vec<_>, _>>()?;
        let contacts = self.contacts(column, &wetting, props)?;
        let mut saturation_calls = contacts.iter().flatten().count();
        let mut segments = Vec::with_capacity(self.segments.len());
        for (j, (g, w)) in self.segments.iter().zip(&wetting).enumerate() {
            if w.exposed_length_m.value > 0. && bank_power_w[g.bank] != 0. {
                return Err(recoverable(format!(
                    "{} segment [{}, {}] m is exposed while powered: shell radiation recipient not owned",
                    self.banks[g.bank].id, g.bottom_m, g.top_m
                )));
            }
            let out = self.segment_rates(
                j,
                column,
                w,
                metal[j],
                bank_power_w[g.bank],
                &contacts,
                props,
            )?;
            saturation_calls += usize::from(out.exposed.is_some());
            segments.push(out);
        }
        Ok(Rates {
            segments,
            contacts,
            saturation_calls,
        })
    }
}
