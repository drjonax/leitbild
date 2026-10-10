//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#one-maintained-water-implementation
//! Property boundary of the composed network and exact per-matrix reuse.
//!
//! The pure crate never evaluates water itself. A caller supplies maintained
//! EOS inversions through [`Properties`]. [`Reuse`] keeps one recovered caloric
//! point per volume/phase only for the lifetime of ONE Jacobian assembly and
//! only for bit-identical pressure/target inputs; directions are always
//! re-evaluated. Failure invalidates the slot. Nothing persists across trials.
use super::Failure;
use crate::thermal::{Saturation, Scalar};
use serde::{Deserialize, Serialize};

/// Maintained-EOS values, or the directional derivatives of the same fields.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Water {
    pub pressure_pa: f64,
    pub temperature_k: f64,
    pub density_kg_m3: f64,
    pub internal_energy_j_kg: f64,
    pub enthalpy_j_kg: f64,
    pub cp_j_kg_k: f64,
    pub expansion_per_k: f64,
    pub compressibility_per_pa: f64,
    pub viscosity_pa_s: f64,
    pub conductivity_w_m_k: f64,
}

/// The bounded metastable band (`ld01-metastable-band`) in the packet's
/// field names: the band a property implementation was compiled with must be
/// the packet's, or the network refuses to compile.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MetastableBand {
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

impl From<&super::stratified::Metastable> for MetastableBand {
    fn from(b: &super::stratified::Metastable) -> Self {
        Self {
            pressure_range_pa: b.pressure_range_pa,
            lower_bound_exclusive: b.lower_bound_exclusive,
            liquid_superheat_max_k: b.liquid_superheat_max_k,
            vapor_subcooling_max_k: b.vapor_subcooling_max_k,
            trial_max_k: b.trial_max_k,
            credited_max_k: b.credited_max_k,
            liquid_temperature_max_k: b.liquid_temperature_max_k,
            liquid_pressure_ceiling_pa: b.liquid_pressure_ceiling_pa,
            vapor_pressure_ceiling_pa: b.vapor_pressure_ceiling_pa,
        }
    }
}

/// Where an accepted state lies relative to saturation on its own branch.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub enum Band {
    /// Saturated, or on the stable side of saturation for its branch.
    Stable,
    /// Metastable inside the admitted band; `credited` within `creditedMax_K`.
    Admitted { credited: bool },
    /// Metastable beyond the admitted band (reachable only as a trial state).
    Exceeded,
}
/// Signed departure `T - Tsat(p)` of an accepted state on its branch.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct BandReport {
    pub departure_k: f64,
    pub band: Band,
}

pub trait Properties {
    /// One successfully recovered stable-branch caloric point.
    type Caloric: Copy;
    fn forward(&self, vapor: bool, pressure_pa: f64, temperature_k: f64) -> Result<Water, String>;
    /// Invert at the SAME pressure and specific internal energy (or enthalpy).
    fn caloric(
        &self,
        vapor: bool,
        pressure_pa: f64,
        target: f64,
        enthalpy: bool,
    ) -> Result<Self::Caloric, String>;
    fn values(&self, point: &Self::Caloric) -> Water;
    /// Directional derivative of every field; zero directions return zero.
    fn direction(&self, point: &Self::Caloric, dp: f64, dtarget: f64) -> Result<Water, String>;
    fn saturation(&self, pressure: Scalar) -> Result<Saturation, String>;
    /// The metastable band this implementation was compiled with.
    fn metastable_band(&self) -> Result<MetastableBand, String>;
    /// Band report of an ACCEPTED point; never called inside a residual.
    fn band(&self, point: &Self::Caloric) -> BandReport;
}

type Key = (u64, u64, bool);

/// Stack-local exact reuse for one Jacobian; never retained across matrices.
pub struct Reuse<C> {
    caloric: Vec<[Option<(Key, C)>; 2]>,
    saturation: Vec<Option<(u64, Saturation)>>,
    /// Stratified-cell restriction evaluations with their exact partials,
    /// keyed by the exact bits of their inputs.
    restriction: Vec<([u64; 4], super::stratified::HeldFlux)>,
}
impl<C: Copy> Reuse<C> {
    pub fn new(cells: usize, saturation_points: usize) -> Self {
        Self {
            caloric: vec![[None; 2]; cells],
            saturation: vec![None; saturation_points],
            restriction: Vec::new(),
        }
    }
    pub(crate) fn held_restriction(&self, key: [u64; 4]) -> Option<super::stratified::HeldFlux> {
        self.restriction
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, held)| *held)
    }
    pub(crate) fn hold_restriction(&mut self, key: [u64; 4], held: super::stratified::HeldFlux) {
        self.restriction.retain(|(k, _)| *k != key);
        self.restriction.push((key, held));
    }
    /// Read-only inspection: exact (p bits, target bits, enthalpy) key held.
    pub fn caloric_key(&self, node: usize, k: usize) -> Option<(u64, u64, bool)> {
        self.caloric[node][k].map(|(key, _)| key)
    }
    /// Read-only inspection: exact pressure bits and saturation point held.
    pub fn saturation_entry(&self, index: usize) -> Option<(u64, Saturation)> {
        self.saturation[index]
    }
}

/// Recover a present phase from (p, specific target) with its direction.
pub fn inverse<P: Properties>(
    properties: &P,
    p: Scalar,
    target: Scalar,
    k: usize,
    enthalpy: bool,
    slot: Option<(&mut Reuse<P::Caloric>, usize)>,
) -> Result<(Water, Water), Failure> {
    let vapor = k == 1;
    let Some((reuse, node)) = slot else {
        let point = properties
            .caloric(vapor, p.value, target.value, enthalpy)
            .map_err(|e| {
                Failure::Recoverable(format!(
                    "actual local IF97 inverse p={} specific={} phase={k} h={enthalpy}: {e}",
                    p.value, target.value
                ))
            })?;
        let direction = if p.direction == 0. && target.direction == 0. {
            Water::default()
        } else {
            properties
                .direction(&point, p.direction, target.direction)
                .map_err(|e| {
                    Failure::Recoverable(format!(
                        "actual local IF97 inverse p={} specific={} phase={k} h={enthalpy}: {e}",
                        p.value, target.value
                    ))
                })?
        };
        return Ok((properties.values(&point), direction));
    };
    let entry = &mut reuse.caloric[node][k];
    let key = (p.value.to_bits(), target.value.to_bits(), enthalpy);
    let point = match *entry {
        Some((stored, point)) if stored == key => point,
        _ => {
            *entry = None;
            let point = properties
                .caloric(vapor, p.value, target.value, enthalpy)
                .map_err(|e| {
                    Failure::Recoverable(format!(
                        "current caloric point p={} specific={} phase={k} h={enthalpy}: {e}",
                        p.value, target.value
                    ))
                })?;
            *entry = Some((key, point));
            point
        }
    };
    match properties.direction(&point, p.direction, target.direction) {
        Ok(direction) => Ok((properties.values(&point), direction)),
        Err(error) => {
            *entry = None;
            Err(Failure::Recoverable(format!(
                "current caloric direction: {error}"
            )))
        }
    }
}

/// Saturation at a local pressure; value-only calls may reuse exact points.
pub fn saturation<P: Properties>(
    properties: &P,
    p: Scalar,
    slot: Option<(&mut Reuse<P::Caloric>, usize)>,
) -> Result<Saturation, Failure> {
    let Some((reuse, index)) = slot.filter(|_| p.direction == 0.) else {
        return properties.saturation(p).map_err(Failure::Recoverable);
    };
    let entry = &mut reuse.saturation[index];
    let key = p.value.to_bits();
    if let Some((stored, value)) = *entry
        && stored == key
    {
        return Ok(value);
    }
    *entry = None;
    let value = properties.saturation(p).map_err(Failure::Recoverable)?;
    *entry = Some((key, value));
    Ok(value)
}
