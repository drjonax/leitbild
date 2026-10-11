//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#one-maintained-water-implementation
//! Property boundary of the composed network and exact per-matrix reuse.
//!
//! The pure crate never evaluates water itself. A caller supplies maintained
//! EOS inversions through [`Properties`]. A consumer states what it reads
//! ([`Need`]); fields outside it are not evaluated. Direction maps come from
//! the held point ([`Properties::direction`], [`Properties::partials`]).
//! [`Reuse`] keeps one recovered caloric point per volume/phase, with the
//! target it was recovered from, only for bit-identical pressure/target
//! inputs and only for the lifetime of ONE evaluation set (one Jacobian
//! assembly, or the residual whose state a Jacobian assembly repeats);
//! directions are always re-evaluated. Failure invalidates the slot.
//! Nothing persists across trials.
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

/// What a consumer reads from one recovered caloric point.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub enum Need {
    /// Temperature, density, internal energy, enthalpy, cp, expansion,
    /// compressibility and viscosity. Conductivity is not evaluated: it is
    /// NaN in [`Properties::values`], never zero.
    Thermodynamic,
    /// Every field of [`Water`].
    Complete,
}

/// The specific target a caloric point was recovered from. Points with equal
/// pressure and temperature but different targets have different direction
/// maps.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Target {
    InternalEnergy,
    Enthalpy,
}
impl Target {
    pub fn from_enthalpy(enthalpy: bool) -> Self {
        if enthalpy {
            Self::Enthalpy
        } else {
            Self::InternalEnergy
        }
    }
}

/// The direction maps of one held caloric point: every field's derivative
/// with respect to pressure at fixed specific target, and with respect to
/// the target at fixed pressure; exactly `direction(point, 1, 0)` and
/// `direction(point, 0, 1)`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Partials {
    pub pressure: Water,
    pub target: Water,
}

/// The exact thermodynamic fields of one direction map, bit for bit those of
/// [`Properties::direction`]. Coefficient fields (cp, expansion,
/// compressibility, transport) have no member here, so none can be read.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ThermodynamicDirection {
    pub temperature_k: f64,
    pub density_kg_m3: f64,
    pub internal_energy_j_kg: f64,
    pub enthalpy_j_kg: f64,
}
impl From<Water> for ThermodynamicDirection {
    fn from(w: Water) -> Self {
        Self {
            temperature_k: w.temperature_k,
            density_kg_m3: w.density_kg_m3,
            internal_energy_j_kg: w.internal_energy_j_kg,
            enthalpy_j_kg: w.enthalpy_j_kg,
        }
    }
}
/// Probe-free [`Partials`] of the exact thermodynamic fields.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ThermodynamicPartials {
    pub pressure: ThermodynamicDirection,
    pub target: ThermodynamicDirection,
}

pub trait Properties {
    /// One successfully recovered stable-branch caloric point.
    type Caloric: Copy;
    fn forward(&self, vapor: bool, pressure_pa: f64, temperature_k: f64) -> Result<Water, String>;
    /// Invert at the SAME pressure and specific internal energy (or enthalpy),
    /// evaluating every field ([`Need::Complete`]).
    fn caloric(
        &self,
        vapor: bool,
        pressure_pa: f64,
        target: f64,
        enthalpy: bool,
    ) -> Result<Self::Caloric, String>;
    /// The same inverse evaluating only `need`'s fields; the default
    /// evaluates every field. Values are bit for bit those of `caloric`.
    fn caloric_for(
        &self,
        vapor: bool,
        pressure_pa: f64,
        target: f64,
        enthalpy: bool,
        need: Need,
    ) -> Result<Self::Caloric, String> {
        let _ = need;
        self.caloric(vapor, pressure_pa, target, enthalpy)
    }
    /// The held point with every field evaluated: the point `caloric` returns
    /// for its inputs, without inverting again. The default is the identity,
    /// for implementations whose `caloric_for` is always complete.
    fn complete(&self, point: &Self::Caloric) -> Result<Self::Caloric, String> {
        Ok(*point)
    }
    fn values(&self, point: &Self::Caloric) -> Water;
    /// Directional derivative of every field; zero directions return zero.
    fn direction(&self, point: &Self::Caloric, dp: f64, dtarget: f64) -> Result<Water, String>;
    /// Both direction maps of the held point, a pure function of it.
    fn partials(&self, point: &Self::Caloric) -> Result<Partials, String> {
        Ok(Partials {
            pressure: self.direction(point, 1., 0.)?,
            target: self.direction(point, 0., 1.)?,
        })
    }
    /// The exact thermodynamic fields of `partials`, bit for bit, without the
    /// coefficient probes where the implementation can.
    fn thermodynamic_partials(
        &self,
        point: &Self::Caloric,
    ) -> Result<ThermodynamicPartials, String> {
        let p = self.partials(point)?;
        Ok(ThermodynamicPartials {
            pressure: p.pressure.into(),
            target: p.target.into(),
        })
    }
    fn saturation(&self, pressure: Scalar) -> Result<Saturation, String>;
    /// The saturation tuple's caloric part for a consumer that reads only the
    /// temperature and each endpoint's density and enthalpy: those values and
    /// their directions bit for bit those of `saturation`, the other fields
    /// (cp, expansion, viscosity, conductivity, surface tension) NaN, never
    /// zero. The default is the complete tuple.
    fn saturation_caloric(&self, pressure: Scalar) -> Result<Saturation, String> {
        self.saturation(pressure)
    }
    /// The metastable band this implementation was compiled with.
    fn metastable_band(&self) -> Result<MetastableBand, String>;
    /// Band report of an ACCEPTED point; never called inside a residual.
    fn band(&self, point: &Self::Caloric) -> BandReport;
}

type Key = (u64, u64, bool);

/// One point a [`Reuse`] slot holds: its exact inputs, the target it was
/// recovered from and the fields evaluated.
#[derive(Clone, Copy, Debug)]
pub struct Held<C> {
    pub pressure_pa: f64,
    pub target: f64,
    pub kind: Target,
    pub need: Need,
    pub point: C,
}
#[derive(Clone, Copy, Debug)]
struct Slot<C> {
    key: Key,
    need: Need,
    point: C,
}

/// Stack-local exact reuse for one evaluation set; never retained across
/// matrices or trials.
pub struct Reuse<C> {
    caloric: Vec<[Option<Slot<C>>; 2]>,
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
    /// Empty every slot, keeping the allocation.
    pub fn clear(&mut self) {
        self.caloric.fill([None; 2]);
        self.saturation.fill(None);
        self.restriction.clear();
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
        self.caloric[node][k].map(|slot| slot.key)
    }
    /// The point held for `node` and phase `k`, with its inputs and target.
    pub fn caloric(&self, node: usize, k: usize) -> Option<Held<C>> {
        self.caloric[node][k].map(|slot| Held {
            pressure_pa: f64::from_bits(slot.key.0),
            target: f64::from_bits(slot.key.1),
            kind: Target::from_enthalpy(slot.key.2),
            need: slot.need,
            point: slot.point,
        })
    }
    /// Read-only inspection: exact pressure bits and saturation point held.
    pub fn saturation_entry(&self, index: usize) -> Option<(u64, Saturation)> {
        self.saturation[index]
    }
}

/// Recover a present phase from (p, specific target) with its direction,
/// evaluating every field ([`Need::Complete`]).
pub fn inverse<P: Properties>(
    properties: &P,
    p: Scalar,
    target: Scalar,
    k: usize,
    enthalpy: bool,
    slot: Option<(&mut Reuse<P::Caloric>, usize)>,
) -> Result<(Water, Water), Failure> {
    inverse_for(properties, p, target, k, enthalpy, Need::Complete, slot)
}

/// [`inverse_for`] for a consumer that reads [`Need::Thermodynamic`] fields.
pub fn inverse_thermodynamic<P: Properties>(
    properties: &P,
    p: Scalar,
    target: Scalar,
    k: usize,
    enthalpy: bool,
    slot: Option<(&mut Reuse<P::Caloric>, usize)>,
) -> Result<(Water, Water), Failure> {
    inverse_for(
        properties,
        p,
        target,
        k,
        enthalpy,
        Need::Thermodynamic,
        slot,
    )
}

/// Recover a present phase for a consumer reading `need`'s fields. A
/// nonzero direction needs the complete point: the inverse then evaluates
/// every field, and a held point evaluated for less is completed once in its
/// slot. Values are bit for bit those of the complete inverse.
pub fn inverse_for<P: Properties>(
    properties: &P,
    p: Scalar,
    target: Scalar,
    k: usize,
    enthalpy: bool,
    need: Need,
    slot: Option<(&mut Reuse<P::Caloric>, usize)>,
) -> Result<(Water, Water), Failure> {
    let vapor = k == 1;
    let directed = p.direction != 0. || target.direction != 0.;
    let evaluated = if directed { Need::Complete } else { need };
    let Some((reuse, node)) = slot else {
        let point = properties
            .caloric_for(vapor, p.value, target.value, enthalpy, evaluated)
            .map_err(|e| {
                Failure::Recoverable(format!(
                    "actual local IF97 inverse p={} specific={} phase={k} h={enthalpy}: {e}",
                    p.value, target.value
                ))
            })?;
        let direction = if !directed {
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
    let held = match *entry {
        Some(held) if held.key == key => held,
        _ => {
            *entry = None;
            let point = properties
                .caloric_for(vapor, p.value, target.value, enthalpy, evaluated)
                .map_err(|e| {
                    Failure::Recoverable(format!(
                        "current caloric point p={} specific={} phase={k} h={enthalpy}: {e}",
                        p.value, target.value
                    ))
                })?;
            Slot {
                key,
                need: evaluated,
                point,
            }
        }
    };
    let held = if held.need < evaluated {
        match properties.complete(&held.point) {
            Ok(point) => Slot {
                key,
                need: Need::Complete,
                point,
            },
            Err(error) => {
                *entry = None;
                return Err(Failure::Recoverable(format!(
                    "current caloric completion: {error}"
                )));
            }
        }
    } else {
        held
    };
    *entry = Some(held);
    match properties.direction(&held.point, p.direction, target.direction) {
        Ok(direction) => Ok((properties.values(&held.point), direction)),
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
