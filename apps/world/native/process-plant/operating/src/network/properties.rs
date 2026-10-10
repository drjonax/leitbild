//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md
//! Property boundary of the composed network and exact per-matrix reuse.
//!
//! The pure crate never evaluates water itself. A caller supplies maintained
//! EOS inversions through [`Properties`]. [`Reuse`] keeps one recovered caloric
//! point per volume/phase only for the lifetime of ONE Jacobian assembly and
//! only for bit-identical pressure/target inputs; directions are always
//! re-evaluated. Failure invalidates the slot. Nothing persists across trials.
use super::Failure;
use crate::thermal::{Saturation, Scalar};

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
}

type Key = (u64, u64, bool);

/// Stack-local exact reuse for one Jacobian; never retained across matrices.
pub struct Reuse<C> {
    caloric: Vec<[Option<(Key, C)>; 2]>,
    saturation: Vec<Option<(u64, Saturation)>>,
}
impl<C: Copy> Reuse<C> {
    pub fn new(cells: usize, saturation_points: usize) -> Self {
        Self {
            caloric: vec![[None; 2]; cells],
            saturation: vec![None; saturation_points],
        }
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
