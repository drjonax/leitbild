//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/feedback-and-actuation-basis.md#selected-hot-response-and-capture-convention
//! Current hot source feedback from immutable compiled physical coefficients.
//! No reference calibration, equilibrium reset, JSON stage decoding or solver.
//! Values and ONE current direction are evaluated together without allocation.
//! Signed finite neutron/isotope trials are distinct from accepted admission.
use crate::thermal::Scalar;
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bounds {
    pub minimum: f64,
    pub maximum: f64,
}
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Domains {
    pub fuel_temperature_k: Bounds,
    pub moderator_temperature_k: Bounds,
    pub pressure_pa: Bounds,
    pub density_ratio: Bounds,
    pub boron_ppm_eq: Bounds,
    pub fissile_ratio: Bounds,
    pub reactivity: Bounds,
    pub maximum_additional_reference_exposure_s: f64,
}
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Parameters {
    pub generation_time_s: f64,
    pub nu_effective: f64,
    pub doppler_per_sqrt_k: f64,
    pub water_worth: f64,
    pub boron_per_ppm_eq: f64,
    pub rod_worth: f64,
    pub sigma_xe_m2: f64,
    pub sigma_sm_m2: f64,
    pub capsule_births_per_s: f64,
    pub capsule_decay_per_s: f64,
    pub inserted_active_bottom_m: f64,
    pub rod_active_length_m: f64,
    pub rod_maximum_travel_m: f64,
    pub domains: Domains,
}
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Region {
    pub rho_base: f64,
    pub reference_density_kg_m3: f64,
    pub reference_boron_ppm_eq: f64,
    pub reference_rod_overlap: f64,
    pub source_weight: f64,
    pub z0_m: f64,
    pub z1_m: f64,
    /// Existing actual52-rod sector incidence divided by its SUM ONCE.
    pub rod_weights: Vec<f64>,
}
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Material {
    pub reference_fissile_atoms: f64,
    pub reference_fuel_temperature_k: f64,
    pub reference_xenon_atoms: f64,
    pub reference_samarium_atoms: f64,
    pub reference_nonpoison_capture_opacity_m2: f64,
}
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Support {
    pub region: usize,
    pub material: usize,
    pub production_reference_per_s: f64,
    pub exposure_per_population_s_m2: f64,
    pub fuel_importance: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct Conditions<'a> {
    /// Derived [mean(sqrt(T_node))]^2; NOT mean(T_node) or an extra state.
    pub fuel_temperature_k: &'a [Scalar],
    pub water_density_kg_m3: &'a [Scalar],
    pub boron_ppm_eq: &'a [Scalar],
    pub pressure_pa: &'a [Scalar],
    pub moderator_temperature_k: &'a [Scalar],
    pub fissile_atoms: &'a [Scalar],
    pub xenon_atoms: &'a [Scalar],
    pub samarium_atoms: &'a [Scalar],
    /// Actual-minus-reference NONPOISON opacity from its one capture owner.
    pub capture_loss_change_m2: &'a [Scalar],
    pub achieved_rod_travel_m: &'a [Scalar],
    pub capsule_age_s: Scalar,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct RegionFeedback {
    pub reactivity: Scalar,
    pub external_source_per_s: Scalar,
}
/// One region's reactivity split into the terms [`Model::evaluate`] sums,
/// values only: the base, the rods, the water density, the boron, and per
/// supporting material the Doppler, fissile-production and capture-opacity
/// (non-poison, xenon and samarium) terms summed over the region's supports.
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct ReactivityTerms {
    pub base: f64,
    pub rods: f64,
    pub water_density: f64,
    pub boron: f64,
    pub doppler: f64,
    pub fissile: f64,
    pub nonpoison_capture: f64,
    pub xenon: f64,
    pub samarium: f64,
}
impl ReactivityTerms {
    pub fn total(&self) -> f64 {
        self.base
            + self.rods
            + self.water_density
            + self.boron
            + self.doppler
            + self.fissile
            + self.nonpoison_capture
            + self.xenon
            + self.samarium
    }
}
#[derive(Clone, Copy, Debug, Default)]
pub struct PoisonCapture {
    pub xenon: Scalar,
    pub samarium: Scalar,
}
#[derive(Clone, Debug)]
pub struct Output {
    pub regions: Vec<RegionFeedback>,
    pub fissions_per_population_s: Vec<Scalar>,
    pub carrier_fissions_per_s: Vec<Scalar>,
    pub exposure_per_m2_s: Vec<Scalar>,
    pub poison_capture_per_s: Vec<PoisonCapture>,
    pub rod_overlap: Vec<Scalar>,
}
impl Output {
    /// Allocate once at construction, never during stage evaluation.
    pub fn new(regions: usize, materials: usize, supports: usize) -> Self {
        Self {
            regions: vec![RegionFeedback::default(); regions],
            fissions_per_population_s: vec![Scalar::default(); supports],
            carrier_fissions_per_s: vec![Scalar::default(); materials],
            exposure_per_m2_s: vec![Scalar::default(); materials],
            poison_capture_per_s: vec![PoisonCapture::default(); materials],
            rod_overlap: vec![Scalar::default(); regions],
        }
    }
}
/// Partials of [`Model::evaluate`] at one state ([`Model::partials`]).
#[derive(Clone, Debug, Default)]
pub struct Partials {
    /// Per support, in support order.
    pub supports: Vec<SupportPartials>,
    /// Per region, in region order.
    pub regions: Vec<RegionPartials>,
    /// Per material, in material order.
    pub materials: Vec<MaterialPartials>,
}
/// One support's fission conversion and its region's reactivity slopes in
/// the support's material inputs.
#[derive(Clone, Copy, Debug, Default)]
pub struct SupportPartials {
    /// `G = G_ref fissile / fissile_ref`, fissions per population per s.
    pub production_per_s: f64,
    /// `dG/d fissile`.
    pub production_fissile: f64,
    /// Exposure per population, m^-2.
    pub exposure: f64,
    /// d rho_region / d fuel temperature (1/K).
    pub fuel_temperature: f64,
    /// d rho_region / d fissile atoms.
    pub fissile: f64,
    /// d rho_region / d capture-loss change (1/m2).
    pub capture_loss: f64,
    /// d rho_region / d xenon atoms and samarium atoms.
    pub xenon: f64,
    pub samarium: f64,
}
/// One region's reactivity slopes in its water and the rods' travel.
#[derive(Clone, Debug, Default)]
pub struct RegionPartials {
    /// d rho / d water density (m3/kg) and d rho / d boron ppm-eq.
    pub water_density: f64,
    pub boron: f64,
    /// `(rod, d rho / d achieved travel)` for every rod weighting the region.
    pub rods: Vec<(usize, f64)>,
}
/// One material's poison capture `sigma X N_poison` slopes: the cross
/// sections and the poison inventories at this state.
#[derive(Clone, Copy, Debug, Default)]
pub struct MaterialPartials {
    pub xenon_capture_per_xenon: f64,
    pub samarium_capture_per_samarium: f64,
    pub xenon: f64,
    pub samarium: f64,
}

/// One core region's coolant phase on an accepted state (owner answer B1,
/// 15 Oct 2026): the liquid's departure from saturation and the vapour its
/// coolant cell holds.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct RegionPhase {
    /// `T_l - Tsat(p)` of the region's coolant [K].
    pub saturation_departure_k: f64,
    /// Vapour mass in the region's coolant cell [kg].
    pub vapor_kg: f64,
}

/// Owner answer B1: pressure no longer stands in for single-phase validity.
/// On an accepted state every core region's coolant must be single-phase
/// liquid below saturation with no vapour in its coolant cell; the first
/// region that fails is a kinetics-domain exit (`OutsideDomain("phase
/// absence", region)`). A check only: no equation, coefficient or tolerance
/// changes.
pub fn phase_absence(phase: &[RegionPhase]) -> Result<(), Error> {
    match phase
        .iter()
        .position(|r| !(r.saturation_departure_k < 0. && r.vapor_kg == 0.))
    {
        Some(i) => Err(Error::OutsideDomain("phase absence", i)),
        None => Ok(()),
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    InvalidMetadata(&'static str),
    Length(&'static str),
    InvalidValue(&'static str, usize),
    OutsideDomain(&'static str, usize),
    NonfiniteResult,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "current hot source feedback: {self:?}")
    }
}
impl std::error::Error for Error {}
#[derive(Clone, Debug)]
pub struct Model {
    parameters: Parameters,
    regions: Vec<Region>,
    materials: Vec<Material>,
    supports: Vec<Support>,
    rods: usize,
}
fn s(value: f64) -> Scalar {
    Scalar::constant(value)
}
fn finite(value: Scalar) -> bool {
    value.value.is_finite() && value.direction.is_finite()
}
fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-12 * a.abs().max(b.abs()).max(1.)
}
fn check(values: &[Scalar], length: usize, name: &'static str) -> Result<(), Error> {
    if values.len() != length {
        return Err(Error::Length(name));
    }
    if let Some(i) = values.iter().position(|v| !finite(*v)) {
        return Err(Error::InvalidValue(name, i));
    }
    Ok(())
}
fn sqrt(value: Scalar) -> Result<Scalar, Error> {
    if !finite(value) || value.value <= 0. {
        return Err(Error::InvalidMetadata(
            "unavailable square-root fuel temperature",
        ));
    }
    let root = value.value.sqrt();
    Ok(Scalar::new(root, value.direction / (2. * root)))
}
fn exp(value: Scalar) -> Scalar {
    let e = value.value.exp();
    Scalar::new(e, e * value.direction)
}
/// TS owner's selected right-travel branch at geometric knots. This is not
/// a universal central directional derivative across the overlap kink.
fn overlap(lo: f64, hi: f64, bottom: Scalar, length: f64) -> Scalar {
    let top = bottom.value + length;
    let value = (hi.min(top) - lo.max(bottom.value)).max(0.);
    let slope = if value > 0. {
        f64::from(top < hi) - f64::from(bottom.value >= lo)
    } else if top == lo {
        1.
    } else {
        0.
    };
    Scalar::new(value, slope * bottom.direction)
}

impl Model {
    pub fn new(
        parameters: Parameters,
        regions: Vec<Region>,
        materials: Vec<Material>,
        supports: Vec<Support>,
    ) -> Result<Self, Error> {
        let p = parameters;
        if regions.is_empty() || materials.is_empty() || supports.is_empty() {
            return Err(Error::InvalidMetadata("empty source"));
        }
        if ![
            p.generation_time_s,
            p.nu_effective,
            p.water_worth,
            p.rod_worth,
            p.sigma_xe_m2,
            p.sigma_sm_m2,
            p.capsule_decay_per_s,
            p.rod_active_length_m,
            p.rod_maximum_travel_m,
        ]
        .iter()
        .all(|v| v.is_finite() && *v > 0.)
            || p.nu_effective <= 1.
            || !p.doppler_per_sqrt_k.is_finite()
            || p.doppler_per_sqrt_k >= 0.
            || !p.boron_per_ppm_eq.is_finite()
            || p.boron_per_ppm_eq >= 0.
            || !p.inserted_active_bottom_m.is_finite()
            || !p.capsule_births_per_s.is_finite()
            || p.capsule_births_per_s < 0.
        {
            return Err(Error::InvalidMetadata("coefficient"));
        }
        for b in [
            p.domains.fuel_temperature_k,
            p.domains.moderator_temperature_k,
            p.domains.pressure_pa,
            p.domains.density_ratio,
            p.domains.boron_ppm_eq,
            p.domains.fissile_ratio,
            p.domains.reactivity,
        ] {
            if !b.minimum.is_finite() || !b.maximum.is_finite() || b.minimum >= b.maximum {
                return Err(Error::InvalidMetadata("domain"));
            }
        }
        if p.domains.fuel_temperature_k.minimum <= 0.
            || p.domains.density_ratio.minimum <= 0.
            || p.domains.fissile_ratio.minimum <= 0.
            || !p
                .domains
                .maximum_additional_reference_exposure_s
                .is_finite()
            || p.domains.maximum_additional_reference_exposure_s <= 0.
        {
            return Err(Error::InvalidMetadata("positive domain"));
        }
        let rods = regions[0].rod_weights.len();
        if rods == 0 {
            return Err(Error::InvalidMetadata("no actual rod incidence"));
        }
        for r in &regions {
            if ![r.rho_base, r.z0_m, r.z1_m].iter().all(|v| v.is_finite())
                || r.z1_m <= r.z0_m
                || !r.reference_density_kg_m3.is_finite()
                || r.reference_density_kg_m3 <= 0.
                || ![
                    r.reference_boron_ppm_eq,
                    r.reference_rod_overlap,
                    r.source_weight,
                ]
                .iter()
                .all(|v| v.is_finite() && *v >= 0.)
                || r.reference_rod_overlap > 1.
                || r.source_weight > 1.
                || r.rod_weights.len() != rods
                || !r.rod_weights.iter().all(|v| v.is_finite() && *v >= 0.)
                || !close(r.rod_weights.iter().sum(), 1.)
            {
                return Err(Error::InvalidMetadata("region/normalized rod incidence"));
            }
        }
        if !close(regions.iter().map(|r| r.source_weight).sum(), 1.) {
            return Err(Error::InvalidMetadata("capsule projection"));
        }
        for a in &materials {
            if ![a.reference_fissile_atoms, a.reference_fuel_temperature_k]
                .iter()
                .all(|v| v.is_finite() && *v > 0.)
                || ![
                    a.reference_xenon_atoms,
                    a.reference_samarium_atoms,
                    a.reference_nonpoison_capture_opacity_m2,
                ]
                .iter()
                .all(|v| v.is_finite() && *v >= 0.)
            {
                return Err(Error::InvalidMetadata("material reference"));
            }
        }
        let mut seen = BTreeSet::new();
        let mut importance = vec![0.; regions.len()];
        let mut g = vec![0.; regions.len()];
        for e in &supports {
            if e.region >= regions.len()
                || e.material >= materials.len()
                || !seen.insert((e.region, e.material))
                || ![
                    e.production_reference_per_s,
                    e.exposure_per_population_s_m2,
                    e.fuel_importance,
                ]
                .iter()
                .all(|v| v.is_finite() && *v >= 0.)
            {
                return Err(Error::InvalidMetadata("source/material support"));
            }
            importance[e.region] += e.fuel_importance;
            g[e.region] += e.production_reference_per_s;
        }
        let gamma = 1. / (p.nu_effective * p.generation_time_s);
        if importance.iter().any(|v| !close(*v, 1.)) || g.iter().any(|v| !close(*v, gamma)) {
            return Err(Error::InvalidMetadata(
                "regional importance/common neutron normalization",
            ));
        }
        Ok(Self {
            parameters,
            regions,
            materials,
            supports,
            rods,
        })
    }
    pub fn region_count(&self) -> usize {
        self.regions.len()
    }
    pub fn material_count(&self) -> usize {
        self.materials.len()
    }
    pub fn support_count(&self) -> usize {
        self.supports.len()
    }
    pub fn rod_count(&self) -> usize {
        self.rods
    }
    fn check_conditions(&self, c: Conditions<'_>, neutrons: &[Scalar]) -> Result<(), Error> {
        check(neutrons, self.regions.len(), "neutrons")?;
        for (name, v) in [
            ("water_density", c.water_density_kg_m3),
            ("boron", c.boron_ppm_eq),
            ("pressure", c.pressure_pa),
            ("moderator_temperature", c.moderator_temperature_k),
        ] {
            check(v, self.regions.len(), name)?;
        }
        for (name, v) in [
            ("fuel_temperature", c.fuel_temperature_k),
            ("fissile", c.fissile_atoms),
            ("xenon", c.xenon_atoms),
            ("samarium", c.samarium_atoms),
            ("capture_delta", c.capture_loss_change_m2),
        ] {
            check(v, self.materials.len(), name)?;
        }
        check(c.achieved_rod_travel_m, self.rods, "rod travel")?;
        if !finite(c.capsule_age_s) {
            return Err(Error::InvalidValue("capsule age", 0));
        }
        Ok(())
    }
    /// Outputs are invalid after ANY error. Caller must discard the failed
    /// stage; there is no silent fallback to the preceding successful input.
    pub fn evaluate(
        &self,
        neutrons: &[Scalar],
        c: Conditions<'_>,
        out: &mut Output,
    ) -> Result<(), Error> {
        self.check_conditions(c, neutrons)?;
        let p = self.parameters;
        let r = self.regions.len();
        let a = self.materials.len();
        if out.regions.len() != r
            || out.rod_overlap.len() != r
            || out.fissions_per_population_s.len() != self.supports.len()
            || out.carrier_fissions_per_s.len() != a
            || out.exposure_per_m2_s.len() != a
            || out.poison_capture_per_s.len() != a
        {
            return Err(Error::Length("output"));
        }
        out.carrier_fissions_per_s.fill(s(0.));
        out.exposure_per_m2_s.fill(s(0.));
        let born = s(p.capsule_births_per_s) * exp(-s(p.capsule_decay_per_s) * c.capsule_age_s);
        for (i, region) in self.regions.iter().enumerate() {
            let rod = region
                .rod_weights
                .iter()
                .zip(c.achieved_rod_travel_m)
                .map(|(w, travel)| {
                    s(*w / (region.z1_m - region.z0_m))
                        * overlap(
                            region.z0_m,
                            region.z1_m,
                            s(p.inserted_active_bottom_m) + *travel,
                            p.rod_active_length_m,
                        )
                })
                .fold(s(0.), |sum, v| sum + v);
            out.rod_overlap[i] = rod;
            let density = c.water_density_kg_m3[i] / s(region.reference_density_kg_m3);
            out.regions[i] = RegionFeedback {
                reactivity: s(region.rho_base)
                    - s(p.rod_worth) * (rod - s(region.reference_rod_overlap))
                    + s(p.water_worth) * (density - s(1.))
                    + s(p.boron_per_ppm_eq)
                        * (c.boron_ppm_eq[i] * density - s(region.reference_boron_ppm_eq)),
                external_source_per_s: s(region.source_weight) * born,
            };
        }
        for (k, e) in self.supports.iter().enumerate() {
            let i = e.region;
            let a = e.material;
            let material = self.materials[a];
            let g = s(e.production_reference_per_s) * c.fissile_atoms[a]
                / s(material.reference_fissile_atoms);
            let h = s(e.exposure_per_population_s_m2);
            out.fissions_per_population_s[k] = g;
            out.carrier_fissions_per_s[a] = out.carrier_fissions_per_s[a] + g * neutrons[i];
            out.exposure_per_m2_s[a] = out.exposure_per_m2_s[a] + h * neutrons[i];
            let opacity = c.capture_loss_change_m2[a]
                + s(p.sigma_xe_m2) * (c.xenon_atoms[a] - s(material.reference_xenon_atoms))
                + s(p.sigma_sm_m2) * (c.samarium_atoms[a] - s(material.reference_samarium_atoms));
            out.regions[i].reactivity = out.regions[i].reactivity
                + s(p.doppler_per_sqrt_k * e.fuel_importance)
                    * (sqrt(c.fuel_temperature_k[a])?
                        - s(material.reference_fuel_temperature_k.sqrt()))
                + s(p.generation_time_s)
                    * (s(p.nu_effective - 1.) * (g - s(e.production_reference_per_s))
                        - h * opacity);
        }
        for a in 0..self.materials.len() {
            out.poison_capture_per_s[a] = PoisonCapture {
                xenon: s(p.sigma_xe_m2) * out.exposure_per_m2_s[a] * c.xenon_atoms[a],
                samarium: s(p.sigma_sm_m2) * out.exposure_per_m2_s[a] * c.samarium_atoms[a],
            };
        }
        if out
            .regions
            .iter()
            .any(|v| !finite(v.reactivity) || !finite(v.external_source_per_s))
            || out
                .fissions_per_population_s
                .iter()
                .chain(&out.carrier_fissions_per_s)
                .chain(&out.exposure_per_m2_s)
                .chain(&out.rod_overlap)
                .any(|v| !finite(*v))
            || out
                .poison_capture_per_s
                .iter()
                .any(|v| !finite(v.xenon) || !finite(v.samarium))
        {
            return Err(Error::NonfiniteResult);
        }
        Ok(())
    }
    /// [`Model::evaluate`]'s region reactivities split into their terms, at
    /// the values of `c` (directions ignored), for a reactivity
    /// decomposition. Each term is the same formula `evaluate` composes, so
    /// a region's [`ReactivityTerms::total`] equals its reactivity to
    /// roundoff of the summation order.
    pub fn reactivity_terms(
        &self,
        c: Conditions<'_>,
        out: &mut [ReactivityTerms],
    ) -> Result<(), Error> {
        let p = self.parameters;
        if out.len() != self.regions.len() {
            return Err(Error::Length("reactivity terms"));
        }
        for (i, region) in self.regions.iter().enumerate() {
            let rod: f64 = region
                .rod_weights
                .iter()
                .zip(c.achieved_rod_travel_m)
                .map(|(w, travel)| {
                    *w / (region.z1_m - region.z0_m)
                        * overlap(
                            region.z0_m,
                            region.z1_m,
                            s(p.inserted_active_bottom_m + travel.value),
                            p.rod_active_length_m,
                        )
                        .value
                })
                .sum();
            let density = c.water_density_kg_m3[i].value / region.reference_density_kg_m3;
            out[i] = ReactivityTerms {
                base: region.rho_base,
                rods: -p.rod_worth * (rod - region.reference_rod_overlap),
                water_density: p.water_worth * (density - 1.),
                boron: p.boron_per_ppm_eq
                    * (c.boron_ppm_eq[i].value * density - region.reference_boron_ppm_eq),
                ..ReactivityTerms::default()
            };
        }
        for e in &self.supports {
            let (i, a) = (e.region, e.material);
            let material = self.materials[a];
            let g = e.production_reference_per_s * c.fissile_atoms[a].value
                / material.reference_fissile_atoms;
            let h = e.exposure_per_population_s_m2;
            let fuel = c.fuel_temperature_k[a].value;
            if !(fuel.is_finite() && fuel > 0.) {
                return Err(Error::InvalidMetadata(
                    "unavailable square-root fuel temperature",
                ));
            }
            let t = &mut out[i];
            t.doppler += p.doppler_per_sqrt_k
                * e.fuel_importance
                * (fuel.sqrt() - material.reference_fuel_temperature_k.sqrt());
            t.fissile +=
                p.generation_time_s * (p.nu_effective - 1.) * (g - e.production_reference_per_s);
            t.nonpoison_capture -= p.generation_time_s * h * c.capture_loss_change_m2[a].value;
            t.xenon -= p.generation_time_s
                * h
                * p.sigma_xe_m2
                * (c.xenon_atoms[a].value - material.reference_xenon_atoms);
            t.samarium -= p.generation_time_s
                * h
                * p.sigma_sm_m2
                * (c.samarium_atoms[a].value - material.reference_samarium_atoms);
        }
        Ok(())
    }
    /// Exact partials of [`Model::evaluate`]'s outputs at the values of
    /// `c` (directions are ignored), for an analytic block Jacobian: per
    /// support its fission conversion `G` and its fissile slope, its
    /// exposure weight and the slopes of its region's reactivity in its
    /// material's fuel temperature, fissile, capture-loss change, xenon and
    /// samarium; per region the reactivity slopes in water density, boron
    /// and each weighted rod's achieved travel, the rod overlap taking the
    /// same selected right-travel branch as `evaluate`; per material the
    /// poison capture slopes. Each slope is the derivative of the same
    /// formula `evaluate` composes. Pressure and moderator temperature
    /// enter only the domain checks, so they have no slope.
    pub fn partials(&self, c: Conditions<'_>, out: &mut Partials) -> Result<(), Error> {
        let neutrons = vec![s(0.); self.regions.len()];
        self.check_conditions(c, &neutrons)?;
        let p = self.parameters;
        out.supports.clear();
        out.regions.clear();
        out.materials.clear();
        for (i, region) in self.regions.iter().enumerate() {
            let mut rods = Vec::new();
            for (rod, (w, travel)) in region
                .rod_weights
                .iter()
                .zip(c.achieved_rod_travel_m)
                .enumerate()
            {
                if *w == 0. {
                    continue;
                }
                let bottom = s(p.inserted_active_bottom_m) + Scalar::new(travel.value, 1.);
                let slope =
                    overlap(region.z0_m, region.z1_m, bottom, p.rod_active_length_m).direction;
                rods.push((
                    rod,
                    -p.rod_worth * (*w / (region.z1_m - region.z0_m)) * slope,
                ));
            }
            let density = c.water_density_kg_m3[i].value / region.reference_density_kg_m3;
            out.regions.push(RegionPartials {
                water_density: (p.water_worth + p.boron_per_ppm_eq * c.boron_ppm_eq[i].value)
                    / region.reference_density_kg_m3,
                boron: p.boron_per_ppm_eq * density,
                rods,
            });
        }
        for e in &self.supports {
            let material = self.materials[e.material];
            let a = e.material;
            let production_fissile =
                e.production_reference_per_s / material.reference_fissile_atoms;
            let root = sqrt(Scalar::new(c.fuel_temperature_k[a].value, 1.))?;
            let h = e.exposure_per_population_s_m2;
            out.supports.push(SupportPartials {
                production_per_s: e.production_reference_per_s * c.fissile_atoms[a].value
                    / material.reference_fissile_atoms,
                production_fissile,
                exposure: h,
                fuel_temperature: p.doppler_per_sqrt_k * e.fuel_importance * root.direction,
                fissile: p.generation_time_s * (p.nu_effective - 1.) * production_fissile,
                capture_loss: -p.generation_time_s * h,
                xenon: -p.generation_time_s * h * p.sigma_xe_m2,
                samarium: -p.generation_time_s * h * p.sigma_sm_m2,
            });
        }
        for a in 0..self.materials.len() {
            out.materials.push(MaterialPartials {
                xenon_capture_per_xenon: p.sigma_xe_m2,
                samarium_capture_per_samarium: p.sigma_sm_m2,
                xenon: c.xenon_atoms[a].value,
                samarium: c.samarium_atoms[a].value,
            });
        }
        let finite_all = out
            .supports
            .iter()
            .flat_map(|e| {
                [
                    e.production_per_s,
                    e.production_fissile,
                    e.fuel_temperature,
                    e.fissile,
                    e.capture_loss,
                    e.xenon,
                    e.samarium,
                ]
            })
            .chain(out.regions.iter().flat_map(|r| {
                [r.water_density, r.boron]
                    .into_iter()
                    .chain(r.rods.iter().map(|(_, v)| *v))
            }))
            .all(f64::is_finite);
        if !finite_all {
            return Err(Error::NonfiniteResult);
        }
        Ok(())
    }
    /// The compiled accepted-state domains.
    pub fn domains(&self) -> Domains {
        self.parameters.domains
    }
    /// Additional achieved fissions/Fref SINCE this immutable prepared baseline.
    /// Original30-day spent stocks remain separate and are never reset here.
    pub fn validate_accepted(
        &self,
        neutrons: &[Scalar],
        c: Conditions<'_>,
        additional_reference_exposure_s: f64,
        out: &mut Output,
    ) -> Result<(), Error> {
        self.validate_accepted_within(
            neutrons,
            c,
            additional_reference_exposure_s,
            out,
            self.parameters.domains,
        )
    }
    /// [`Model::validate_accepted`] against `domains`: the compiled ones, or
    /// the D3 (a) post-trip extension while its checked shutdown margin holds
    /// (`joined::post_trip_domain`, the only other caller).
    pub fn validate_accepted_within(
        &self,
        neutrons: &[Scalar],
        c: Conditions<'_>,
        additional_reference_exposure_s: f64,
        out: &mut Output,
        domains: Domains,
    ) -> Result<(), Error> {
        self.evaluate(neutrons, c, out)?;
        let within = |v: f64, b: Bounds, name: &'static str, i: usize| {
            if v < b.minimum || v > b.maximum {
                Err(Error::OutsideDomain(name, i))
            } else {
                Ok(())
            }
        };
        let d = domains;
        if !additional_reference_exposure_s.is_finite()
            || additional_reference_exposure_s < 0.
            || additional_reference_exposure_s > d.maximum_additional_reference_exposure_s
        {
            return Err(Error::OutsideDomain("additional reference exposure", 0));
        }
        if c.capsule_age_s.value < 0. {
            return Err(Error::OutsideDomain("capsule age", 0));
        }
        for (i, n) in neutrons.iter().enumerate() {
            if n.value < 0. {
                return Err(Error::OutsideDomain("neutrons", i));
            }
        }
        for (i, travel) in c.achieved_rod_travel_m.iter().enumerate() {
            within(
                travel.value,
                Bounds {
                    minimum: 0.,
                    maximum: self.parameters.rod_maximum_travel_m,
                },
                "rod travel",
                i,
            )?;
        }
        for (a, m) in self.materials.iter().enumerate() {
            within(
                c.fuel_temperature_k[a].value,
                d.fuel_temperature_k,
                "fuel temperature",
                a,
            )?;
            within(
                c.fissile_atoms[a].value / m.reference_fissile_atoms,
                d.fissile_ratio,
                "fissile ratio",
                a,
            )?;
            if c.xenon_atoms[a].value < 0.
                || c.samarium_atoms[a].value < 0.
                || m.reference_nonpoison_capture_opacity_m2 + c.capture_loss_change_m2[a].value < 0.
            {
                return Err(Error::OutsideDomain("finite capture inventory", a));
            }
        }
        for (i, r) in self.regions.iter().enumerate() {
            within(
                c.water_density_kg_m3[i].value / r.reference_density_kg_m3,
                d.density_ratio,
                "density ratio",
                i,
            )?;
            within(c.boron_ppm_eq[i].value, d.boron_ppm_eq, "boron", i)?;
            within(c.pressure_pa[i].value, d.pressure_pa, "pressure", i)?;
            within(
                c.moderator_temperature_k[i].value,
                d.moderator_temperature_k,
                "moderator temperature",
                i,
            )?;
            within(
                out.regions[i].reactivity.value,
                d.reactivity,
                "reactivity",
                i,
            )?;
        }
        Ok(())
    }
}
