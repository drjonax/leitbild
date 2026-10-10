//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#what-one-call-computes
//! Connected current-state hot thermal/source residual/RHS operator.
//! One call composes current feedback, actual event-fed history, reciprocal
//! finite heat receipts and local retained-mass continuity. External ports
//! remain explicit. No fixed-power heater, steady-state reset, JSON stage work,
//! solver, absent-phase floor or automatically successful startup lives here.
//! Nuclear, isotope and history outputs are RHS vectors; thermal/caloric and
//! continuity outputs are residuals. This is not the complete unit F(t,y,ydot).
//! Current geometry/emission/transfer inputs are the prepared fixed pose. A rod
//! feedback direction alone is not a joined moving-rod displacement derivative.
use crate::{
    capture, heat_history, kinetics, poisons, pressure, source_feedback as sf,
    thermal::{self, Scalar, WaterProperties},
};

pub type Result<T> = std::result::Result<T, String>;
fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn finite(v: Scalar) -> bool {
    v.value.is_finite() && v.direction.is_finite()
}
#[derive(Clone, Copy, Debug)]
pub struct WaterChart {
    pub mass: Scalar,
    pub energy: Scalar,
    pub density: Scalar,
    pub projection: pressure::Region,
    /// Exact current value/direction tuple from this same fluid-chart call.
    /// Thermal contacts reuse it only inside this evaluation, not across time.
    pub thermal: thermal::WaterPoint,
}
pub trait Properties: WaterProperties {
    fn fixed_liquid(
        &self,
        volume: f64,
        pressure: Scalar,
        temperature: Scalar,
    ) -> Result<WaterChart>;
}
#[derive(Clone, Debug)]
pub struct FlowTerm {
    pub edge: usize,
    pub weight: f64,
}
#[derive(Clone, Debug)]
pub struct Contact {
    pub water: usize,
    pub area: f64,
    pub diameter: f64,
    pub flow_area: f64,
    pub flow: Vec<FlowTerm>,
}
#[derive(Clone, Debug)]
pub struct Band {
    pub geometry: thermal::FuelGeometry,
    pub helium: usize,
    pub fuel_mass: [f64; 2],
    pub clad_mass: f64,
    pub contacts: Vec<Contact>,
    pub deposition: Vec<(usize, f64)>,
}
#[derive(Clone, Copy, Debug)]
pub struct PassiveContact {
    pub solid: usize,
    pub water: usize,
    pub area: f64,
    pub liquid_h: f64,
    pub log_radius: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct PlenumContact {
    pub helium: usize,
    pub solid: usize,
    pub area: f64,
    pub radius: f64,
    pub conduction_factor: f64,
}
#[derive(Clone, Debug)]
pub struct SgSegment {
    pub contact: Contact,
    pub secondary: usize,
    pub start: f64,
    pub end: f64,
    pub capacity: f64,
}
#[derive(Debug)]
pub struct Heat {
    pub fission: heat_history::Model,
    pub fertile: heat_history::Model,
    pub capture: capture::Parameters,
    pub binding_coolant_fraction: f64,
    pub prompt_coolant_fraction: f64,
    pub xenon_binding_j: f64,
    pub samarium_binding_j: f64,
    pub xenon_cross_section: f64,
    pub samarium_cross_section: f64,
    pub poison: poisons::Model,
}
#[derive(Debug)]
pub struct Model {
    pub feedback: sf::Model,
    pub heat: Heat,
    pub bands: Vec<Band>,
    pub helium_nr: Vec<f64>,
    pub passive_mass: Vec<f64>,
    pub passive_contacts: Vec<PassiveContact>,
    pub plenum_contacts: Vec<PlenumContact>,
    pub sg: Vec<SgSegment>,
    pub volumes: Vec<f64>,
    pub source_water: Vec<usize>,
    pub edges: Vec<pressure::Edge>,
    pub secondaries: usize,
    pub reference_fertile: Vec<f64>,
    pub kinetics: kinetics::Model,
    pub transfer_rates: Vec<f64>,
    pub emission: Vec<f64>,
    pub outside: Vec<f64>,
}
#[derive(Clone, Copy, Debug)]
pub struct FuelState {
    pub inner: Scalar,
    pub outer: Scalar,
    pub surface: Scalar,
    pub clad_inner: Scalar,
    pub clad_mean: Scalar,
    pub clad_outer: Scalar,
}
#[derive(Clone, Copy, Debug)]
pub struct Material {
    pub fissile: Scalar,
    pub fertile: Scalar,
    pub iodine: Scalar,
    pub xenon: Scalar,
    pub promethium: Scalar,
    pub samarium: Scalar,
}
#[derive(Clone, Copy, Debug)]
pub struct Secondary {
    pub pressure: Scalar,
    pub temperature: Scalar,
    pub liquid_volume: Scalar,
    pub steam_present: bool,
}
#[derive(Clone, Copy, Debug)]
pub struct State<'a> {
    pub fuel: &'a [FuelState],
    pub helium_t: &'a [Scalar],
    pub passive_t: &'a [Scalar],
    pub sg_t: &'a [Scalar],
    pub fuel_u: &'a [[Scalar; 3]],
    pub helium_u: &'a [Scalar],
    pub passive_u: &'a [Scalar],
    pub sg_u: &'a [Scalar],
    pub pressure: &'a [Scalar],
    /// Differential inventory, not freshly inferred from p/T on every call.
    pub water_mass: &'a [Scalar],
    pub water_t: &'a [Scalar],
    pub water_u: &'a [Scalar],
    pub boron_amount: &'a [Scalar],
    pub face_flow: &'a [Scalar],
    pub neutron_population: &'a [Scalar],
    pub material: &'a [Material],
    pub precursors: &'a [Scalar],
    /// Fission then fertile-capture reservoirs, in the unchanged selected order.
    pub history: &'a [Vec<Scalar>],
    pub rods: &'a [Scalar],
    pub age: Scalar,
    pub secondary: &'a [Secondary],
}
#[derive(Clone, Copy, Debug)]
pub struct Rates<'a> {
    pub fuel: &'a [[Scalar; 3]],
    pub helium: &'a [Scalar],
    pub passive: &'a [Scalar],
    pub sg: &'a [Scalar],
    pub water_mass: &'a [Scalar],
    pub water: &'a [Scalar],
    pub boron: &'a [Scalar],
}
/// Actual same-time boundary receipts, not prescribed pressure or heat success.
/// Positive values enter the named owner. The provider owns donor enthalpy and
/// tracer concentration. Shaft work must carry the matching rotor debit later.
#[derive(Clone, Copy, Debug)]
pub struct External<'a> {
    pub mass: &'a [Scalar],
    pub energy: &'a [Scalar],
    pub boron: &'a [Scalar],
}
#[derive(Debug)]
pub struct Work {
    pub feedback: sf::Output,
    pub water: Vec<WaterChart>,
    fuel_feedback: Vec<Scalar>,
    density: Vec<Scalar>,
    boron: Vec<Scalar>,
    p: Vec<Scalar>,
    t: Vec<Scalar>,
    fissile: Vec<Scalar>,
    xenon: Vec<Scalar>,
    samarium: Vec<Scalar>,
    opacity: Vec<Scalar>,
    pub fuel_heat: Vec<Scalar>,
    pub coolant_heat: Vec<Scalar>,
    pub history_rates: Vec<Vec<Scalar>>,
    history_value: Vec<f64>,
    history_direction: Vec<f64>,
    rate_value: Vec<f64>,
    rate_direction: Vec<f64>,
    pub fuel_rhs: Vec<[Scalar; 3]>,
    pub helium_rhs: Vec<Scalar>,
    pub passive_rhs: Vec<Scalar>,
    pub sg_rhs: Vec<Scalar>,
    pub water_rhs: Vec<Scalar>,
    pub boron_rhs: Vec<Scalar>,
    pub secondary_heat: Vec<Scalar>,
    pub surface: Vec<[Scalar; 3]>,
    pub fuel_residual: Vec<[Scalar; 3]>,
    pub helium_residual: Vec<Scalar>,
    pub passive_residual: Vec<Scalar>,
    pub sg_residual: Vec<Scalar>,
    pub water_residual: Vec<Scalar>,
    pub continuity: Vec<Scalar>,
    pub caloric: Vec<Scalar>,
    pub mass_caloric: Vec<Scalar>,
    saturation: Vec<thermal::Saturation>,
    needs_saturation: Vec<bool>,
    pub boron_residual: Vec<Scalar>,
    pub event_heat: Scalar,
    pub released_heat: Scalar,
    pub stored_history_rate: Scalar,
    pub fuel_caloric: Vec<[Scalar; 3]>,
    pub helium_caloric: Vec<Scalar>,
    pub passive_caloric: Vec<Scalar>,
    pub sg_caloric: Vec<Scalar>,
    source_value: Vec<f64>,
    source_direction: Vec<f64>,
    source_rate_value: Vec<f64>,
    source_rate_direction: Vec<f64>,
    region_value: Vec<kinetics::RegionInput>,
    region_direction: Vec<kinetics::RegionInput>,
    production_value: Vec<f64>,
    production_direction: Vec<f64>,
    zero_transfer: Vec<f64>,
    zero_emission: Vec<f64>,
    zero_outside: Vec<f64>,
    fission_value: Vec<f64>,
    fission_direction: Vec<f64>,
    pub nuclear_rates: Vec<Scalar>,
    pub poison_rates: Vec<[Scalar; 4]>,
    pub fissile_rates: Vec<Scalar>,
    pub fertile_rates: Vec<Scalar>,
    pub capture_product_rates: Vec<Scalar>,
}
impl Model {
    /// Compile once. Actual source normalization and material identity checks
    /// belong to the package constructor; runtime arrays are numeric identities.
    pub fn workspace(&self) -> Result<Work> {
        let a = self.bands.len();
        let n = self.volumes.len();
        let r = self.source_water.len();
        let h = self.heat.fission.dimension() + self.heat.fertile.dimension();
        if a == 0
            || n == 0
            || r == 0
            || self.feedback.material_count() != a
            || self.feedback.region_count() != r
            || self.reference_fertile.len() != a
            || self.kinetics.state_dimension() != r + 6 * a
            || self.kinetics.region_count() != r
            || self.kinetics.material_count() != a
            || self.kinetics.support_count() != self.feedback.support_count()
            || self.transfer_rates.len() != self.kinetics.transfer_count()
            || self.emission.len() != self.feedback.support_count()
            || self.outside.len() != a
            || self
                .transfer_rates
                .iter()
                .chain(&self.emission)
                .chain(&self.outside)
                .any(|v| !v.is_finite() || *v < 0.)
            || [
                self.heat.xenon_cross_section,
                self.heat.samarium_cross_section,
                self.heat.xenon_binding_j,
                self.heat.samarium_binding_j,
            ]
            .iter()
            .any(|v| !v.is_finite() || *v < 0.)
            || self
                .reference_fertile
                .iter()
                .any(|v| !v.is_finite() || *v <= 0.)
            || self.heat.fission.dimension() != 23
            || self.heat.fertile.dimension() != 2
            || self.volumes.iter().any(|v| !v.is_finite() || *v <= 0.)
            || self.source_water.iter().any(|i| *i >= n)
            || self
                .edges
                .iter()
                .any(|e| e.from >= n || e.to >= n || e.from == e.to)
            || [
                self.heat.binding_coolant_fraction,
                self.heat.prompt_coolant_fraction,
            ]
            .iter()
            .any(|v| !v.is_finite() || !(0. ..=1.).contains(v))
        {
            return Err("invalid connected hot allocation".into());
        }
        self.heat.capture.validate().map_err(error)?;
        let contact = |c: &Contact| {
            c.water < n
                && c.area.is_finite()
                && c.area > 0.
                && c.diameter.is_finite()
                && c.diameter > 0.
                && c.flow_area.is_finite()
                && c.flow_area > 0.
                && !c.flow.is_empty()
                && c.flow
                    .iter()
                    .all(|t| t.edge < self.edges.len() && t.weight.is_finite())
        };
        for b in &self.bands {
            if b.helium >= self.helium_nr.len()
                || !b
                    .fuel_mass
                    .iter()
                    .chain([&b.clad_mass])
                    .all(|m| m.is_finite() && *m > 0.)
                || b.contacts.is_empty()
                || !b.contacts.iter().all(contact)
                || b.deposition
                    .iter()
                    .any(|(i, f)| *i >= n || !f.is_finite() || *f < 0.)
                || (b.deposition.iter().map(|(_, f)| f).sum::<f64>() - 1.).abs() > 1e-12
            {
                return Err("invalid finite band/contact/deposition".into());
            }
        }
        if self
            .helium_nr
            .iter()
            .chain(&self.passive_mass)
            .any(|v| !v.is_finite() || *v <= 0.)
            || self.passive_contacts.iter().any(|c| {
                c.solid >= self.passive_mass.len()
                    || c.water >= n
                    || !c.area.is_finite()
                    || c.area <= 0.
                    || !c.liquid_h.is_finite()
                    || c.liquid_h <= 0.
                    || !c.log_radius.is_finite()
                    || c.log_radius < 0.
            })
            || self.plenum_contacts.iter().any(|c| {
                c.helium >= self.helium_nr.len()
                    || c.solid >= self.passive_mass.len()
                    || ![c.area, c.radius, c.conduction_factor]
                        .iter()
                        .all(|x| x.is_finite() && *x > 0.)
            })
            || self.sg.iter().any(|c| {
                !contact(&c.contact)
                    || c.secondary >= self.secondaries
                    || !c.capacity.is_finite()
                    || c.capacity <= 0.
                    || !c.start.is_finite()
                    || !c.end.is_finite()
                    || c.start >= c.end
            })
        {
            return Err("invalid finite passive/SG contact".into());
        }
        let z = |k| vec![Scalar::default(); k];
        let mut needs_saturation = vec![false; n];
        for c in self
            .bands
            .iter()
            .flat_map(|b| &b.contacts)
            .chain(self.sg.iter().map(|g| &g.contact))
        {
            needs_saturation[c.water] = true;
        }
        Ok(Work {
            feedback: sf::Output::new(r, a, self.feedback.support_count()),
            water: vec![
                WaterChart {
                    mass: s(0.),
                    energy: s(0.),
                    density: s(0.),
                    projection: pressure::Region::default(),
                    thermal: thermal::WaterPoint::default()
                };
                n
            ],
            fuel_feedback: z(a),
            density: z(r),
            boron: z(r),
            p: z(r),
            t: z(r),
            fissile: z(a),
            xenon: z(a),
            samarium: z(a),
            opacity: z(a),
            fuel_heat: z(a),
            coolant_heat: z(a),
            history_rates: vec![z(h); a],
            history_value: vec![0.; h],
            history_direction: vec![0.; h],
            rate_value: vec![0.; h],
            rate_direction: vec![0.; h],
            fuel_rhs: vec![[s(0.); 3]; a],
            helium_rhs: z(self.helium_nr.len()),
            passive_rhs: z(self.passive_mass.len()),
            sg_rhs: z(self.sg.len()),
            water_rhs: z(n),
            boron_rhs: z(n),
            secondary_heat: z(self.secondaries),
            surface: vec![[s(0.); 3]; a],
            fuel_residual: vec![[s(0.); 3]; a],
            helium_residual: z(self.helium_nr.len()),
            passive_residual: z(self.passive_mass.len()),
            sg_residual: z(self.sg.len()),
            water_residual: z(n),
            continuity: z(n),
            caloric: z(n),
            mass_caloric: z(n),
            saturation: vec![thermal::Saturation::default(); n],
            needs_saturation,
            boron_residual: z(n),
            event_heat: s(0.),
            released_heat: s(0.),
            stored_history_rate: s(0.),
            fuel_caloric: vec![[s(0.); 3]; a],
            helium_caloric: z(self.helium_nr.len()),
            passive_caloric: z(self.passive_mass.len()),
            sg_caloric: z(self.sg.len()),
            source_value: vec![0.; r + 6 * a],
            source_direction: vec![0.; r + 6 * a],
            source_rate_value: vec![0.; r + 6 * a],
            source_rate_direction: vec![0.; r + 6 * a],
            region_value: vec![
                kinetics::RegionInput {
                    reactivity: 0.,
                    external_source_per_s: 0.
                };
                r
            ],
            region_direction: vec![
                kinetics::RegionInput {
                    reactivity: 0.,
                    external_source_per_s: 0.
                };
                r
            ],
            production_value: vec![0.; self.emission.len()],
            production_direction: vec![0.; self.emission.len()],
            zero_transfer: vec![0.; self.transfer_rates.len()],
            zero_emission: vec![0.; self.emission.len()],
            zero_outside: vec![0.; a],
            fission_value: vec![0.; a],
            fission_direction: vec![0.; a],
            nuclear_rates: z(r + 6 * a),
            poison_rates: vec![[s(0.); 4]; a],
            fissile_rates: z(a),
            fertile_rates: z(a),
            capture_product_rates: z(a),
        })
    }
    fn mass_flux(&self, c: &Contact, x: State<'_>) -> Scalar {
        c.flow
            .iter()
            .fold(s(0.), |a, t| a + x.face_flow[t.edge] * s(t.weight))
            / s(c.flow_area)
    }
    pub fn evaluate<P: Properties>(
        &self,
        props: &P,
        x: State<'_>,
        d: Rates<'_>,
        ext: External<'_>,
        w: &mut Work,
    ) -> Result<()> {
        let a = self.bands.len();
        let n = self.volumes.len();
        let h = self.heat.fission.dimension() + self.heat.fertile.dimension();
        if x.fuel.len() != a
            || x.material.len() != a
            || x.history.len() != a
            || x.history.iter().any(|v| v.len() != h)
            || x.precursors.len() != 6 * a
            || x.fuel_u.len() != a
            || x.helium_u.len() != self.helium_nr.len()
            || x.passive_u.len() != self.passive_mass.len()
            || x.sg_u.len() != self.sg.len()
            || x.helium_t.len() != self.helium_nr.len()
            || x.passive_t.len() != self.passive_mass.len()
            || x.sg_t.len() != self.sg.len()
            || x.water_t.len() != n
            || x.pressure.len() != n
            || x.water_mass.len() != n
            || x.water_u.len() != n
            || x.boron_amount.len() != n
            || x.face_flow.len() != self.edges.len()
            || x.secondary.len() != self.secondaries
            || x.neutron_population.len() != self.source_water.len()
            || d.fuel.len() != a
            || d.helium.len() != x.helium_t.len()
            || d.passive.len() != x.passive_t.len()
            || d.sg.len() != x.sg_t.len()
            || d.water.len() != n
            || d.water_mass.len() != n
            || d.boron.len() != n
            || ext.mass.len() != n
            || ext.energy.len() != n
            || ext.boron.len() != n
        {
            return Err("connected hot stage length".into());
        }
        if !ext
            .mass
            .iter()
            .chain(ext.energy)
            .chain(ext.boron)
            .chain(d.fuel.iter().flatten())
            .chain(d.helium)
            .chain(d.passive)
            .chain(d.sg)
            .chain(d.water)
            .chain(d.boron)
            .chain(d.water_mass)
            .copied()
            .all(finite)
        {
            return Err("nonfinite hot external/rate input".into());
        }
        // Public diagnostic vectors can be inspected by callers. If a caller
        // resized one, refuse explicitly instead of indexing an invalid buffer.
        if w.fuel_rhs.len() != a
            || w.fuel_heat.len() != a
            || w.coolant_heat.len() != a
            || w.history_rates.len() != a
            || w.history_rates.iter().any(|v| v.len() != h)
            || w.surface.len() != a
            || w.fuel_residual.len() != a
            || w.fuel_caloric.len() != a
            || w.poison_rates.len() != a
            || w.fissile_rates.len() != a
            || w.fertile_rates.len() != a
            || w.capture_product_rates.len() != a
            || w.water.len() != n
            || w.water_rhs.len() != n
            || w.water_residual.len() != n
            || w.continuity.len() != n
            || w.caloric.len() != n
            || w.mass_caloric.len() != n
            || w.boron_rhs.len() != n
            || w.boron_residual.len() != n
            || w.helium_rhs.len() != x.helium_t.len()
            || w.helium_residual.len() != x.helium_t.len()
            || w.helium_caloric.len() != x.helium_t.len()
            || w.passive_rhs.len() != x.passive_t.len()
            || w.passive_residual.len() != x.passive_t.len()
            || w.passive_caloric.len() != x.passive_t.len()
            || w.sg_rhs.len() != x.sg_t.len()
            || w.sg_residual.len() != x.sg_t.len()
            || w.sg_caloric.len() != x.sg_t.len()
            || w.secondary_heat.len() != self.secondaries
            || w.nuclear_rates.len() != self.kinetics.state_dimension()
        {
            return Err("connected hot workspace length".into());
        }
        for (i, v) in self.volumes.iter().enumerate() {
            if !finite(x.water_mass[i]) || x.water_mass[i].value == 0. {
                return Err("hot single-phase inventory unavailable".into());
            }
            w.water[i] = props.fixed_liquid(*v, x.pressure[i], x.water_t[i])?;
            w.mass_caloric[i] = x.water_mass[i] - w.water[i].mass;
            w.caloric[i] = x.water_u[i] - x.water_mass[i] * (w.water[i].energy / w.water[i].mass);
            if w.needs_saturation[i] {
                w.saturation[i] = props.saturation(x.pressure[i]).map_err(error)?;
            }
            w.water_rhs[i] = ext.energy[i];
            w.boron_rhs[i] = ext.boron[i];
            w.continuity[i] = ext.mass[i];
        }
        for (i, j) in self.source_water.iter().enumerate() {
            w.density[i] = x.water_mass[*j] / s(self.volumes[*j]);
            w.boron[i] = s(1e6) * x.boron_amount[*j] / x.water_mass[*j];
            w.p[i] = x.pressure[*j];
            w.t[i] = x.water_t[*j];
        }
        for (i, f) in x.fuel.iter().enumerate() {
            w.fuel_feedback[i] =
                thermal::fuel_feedback_temperature(f.inner, f.outer).map_err(error)?;
            w.fissile[i] = x.material[i].fissile;
            w.xenon[i] = x.material[i].xenon;
            w.samarium[i] = x.material[i].samarium;
            w.opacity[i] = s(self.heat.capture.cross_section_m2)
                * (x.material[i].fertile - s(self.reference_fertile[i]));
        }
        self.feedback
            .evaluate(
                x.neutron_population,
                sf::Conditions {
                    fuel_temperature_k: &w.fuel_feedback,
                    water_density_kg_m3: &w.density,
                    boron_ppm_eq: &w.boron,
                    pressure_pa: &w.p,
                    moderator_temperature_k: &w.t,
                    fissile_atoms: &w.fissile,
                    xenon_atoms: &w.xenon,
                    samarium_atoms: &w.samarium,
                    capture_loss_change_m2: &w.opacity,
                    achieved_rod_travel_m: x.rods,
                    capsule_age_s: x.age,
                },
                &mut w.feedback,
            )
            .map_err(error)?;
        // Feedback is not a parallel diagnostic: these SAME current rho/G
        // values drive regional populations, material precursors and fissions.
        for (i, v) in x.neutron_population.iter().chain(x.precursors).enumerate() {
            w.source_value[i] = v.value;
            w.source_direction[i] = v.direction;
        }
        for i in 0..self.source_water.len() {
            w.region_value[i] = kinetics::RegionInput {
                reactivity: w.feedback.regions[i].reactivity.value,
                external_source_per_s: w.feedback.regions[i].external_source_per_s.value,
            };
            w.region_direction[i] = kinetics::RegionInput {
                reactivity: w.feedback.regions[i].reactivity.direction,
                external_source_per_s: w.feedback.regions[i].external_source_per_s.direction,
            };
        }
        for (i, v) in w.feedback.fissions_per_population_s.iter().enumerate() {
            w.production_value[i] = v.value;
            w.production_direction[i] = v.direction;
        }
        let inputs = kinetics::Inputs {
            regions: &w.region_value,
            transfer_rates_per_s: &self.transfer_rates,
            fissions_per_population_s: &w.production_value,
            emission_fractions: &self.emission,
            outside_fractions: &self.outside,
        };
        let direction = kinetics::Inputs {
            regions: &w.region_direction,
            transfer_rates_per_s: &w.zero_transfer,
            fissions_per_population_s: &w.production_direction,
            emission_fractions: &w.zero_emission,
            outside_fractions: &w.zero_outside,
        };
        self.kinetics
            .rates(
                &w.source_value,
                inputs,
                &mut w.source_rate_value,
                &mut w.fission_value,
            )
            .map_err(error)?;
        self.kinetics
            .directional_derivative(
                &w.source_value,
                inputs,
                &w.source_direction,
                direction,
                &mut w.source_rate_direction,
                &mut w.fission_direction,
            )
            .map_err(error)?;
        for i in 0..w.nuclear_rates.len() {
            w.nuclear_rates[i] = Scalar::new(w.source_rate_value[i], w.source_rate_direction[i]);
        }
        w.helium_rhs.fill(s(0.));
        w.passive_rhs.fill(s(0.));
        w.secondary_heat.fill(s(0.));
        w.event_heat = s(0.);
        w.released_heat = s(0.);
        w.stored_history_rate = s(0.);
        for (i, b) in self.bands.iter().enumerate() {
            let fissions = Scalar::new(w.fission_value[i], w.fission_direction[i]);
            let exposure = w.feedback.exposure_per_m2_s[i];
            let cap = self
                .heat
                .capture
                .rates(x.material[i].fertile.value, exposure.value)
                .map_err(error)?;
            let dc = self
                .heat
                .capture
                .tangent(
                    x.material[i].fertile.value,
                    exposure.value,
                    x.material[i].fertile.direction,
                    exposure.direction,
                )
                .map_err(error)?;
            w.fissile_rates[i] = -fissions;
            w.fertile_rates[i] = Scalar::new(cap.target_rate_per_s, dc.target_rate_per_s);
            w.capture_product_rates[i] = Scalar::new(cap.product_rate_per_s, dc.product_rate_per_s);
            let m = x.material[i];
            let inventories = [m.iodine, m.xenon, m.promethium, m.samarium];
            let captures = [
                s(0.),
                s(self.heat.xenon_cross_section) * exposure,
                s(0.),
                s(self.heat.samarium_cross_section) * exposure,
            ];
            let mut pr = [0.; 4];
            let mut dp = [0.; 4];
            let pv = inventories.map(|v| v.value);
            let pd = inventories.map(|v| v.direction);
            let pi = poisons::Input {
                fissions_per_s: fissions.value,
                capture_per_s: captures.map(|v| v.value),
            };
            self.heat.poison.rates(&pv, pi, &mut pr).map_err(error)?;
            self.heat
                .poison
                .tangent(
                    &pv,
                    pi,
                    &pd,
                    poisons::InputDirection {
                        fissions_per_s: fissions.direction,
                        capture_per_s: captures.map(|v| v.direction),
                    },
                    &mut dp,
                )
                .map_err(error)?;
            for k in 0..4 {
                w.poison_rates[i][k] = Scalar::new(pr[k], dp[k]);
            }
            for (g, q) in x.history[i].iter().enumerate() {
                w.history_value[g] = q.value;
                w.history_direction[g] = q.direction;
            }
            let f = self
                .heat
                .fission
                .rates(
                    &w.history_value[..23],
                    fissions.value,
                    &mut w.rate_value[..23],
                )
                .map_err(error)?;
            let df = self
                .heat
                .fission
                .tangent(
                    &w.history_direction[..23],
                    fissions.direction,
                    &mut w.rate_direction[..23],
                )
                .map_err(error)?;
            let c = self
                .heat
                .fertile
                .rates(
                    &w.history_value[23..],
                    cap.captures_per_s,
                    &mut w.rate_value[23..],
                )
                .map_err(error)?;
            let dc_heat = self
                .heat
                .fertile
                .tangent(
                    &w.history_direction[23..],
                    dc.captures_per_s,
                    &mut w.rate_direction[23..],
                )
                .map_err(error)?;
            for g in 0..h {
                w.history_rates[i][g] = Scalar::new(w.rate_value[g], w.rate_direction[g]);
                w.stored_history_rate = w.stored_history_rate + w.history_rates[i][g];
            }
            let prompt = Scalar::new(f.prompt_w, df.prompt_w);
            let delayed = Scalar::new(f.delayed_w + c.delayed_w, df.delayed_w + dc_heat.delayed_w);
            let binding = Scalar::new(cap.binding_w, dc.binding_w)
                + s(self.heat.xenon_binding_j) * w.feedback.poison_capture_per_s[i].xenon
                + s(self.heat.samarium_binding_j) * w.feedback.poison_capture_per_s[i].samarium;
            w.fuel_heat[i] = s(1. - self.heat.prompt_coolant_fraction) * prompt
                + delayed
                + s(1. - self.heat.binding_coolant_fraction) * binding;
            w.coolant_heat[i] = s(self.heat.prompt_coolant_fraction) * prompt
                + s(self.heat.binding_coolant_fraction) * binding;
            w.released_heat = w.released_heat + w.fuel_heat[i] + w.coolant_heat[i];
            w.event_heat = w.event_heat
                + prompt
                + Scalar::new(
                    f.retained_input_w + c.retained_input_w,
                    df.retained_input_w + dc_heat.retained_input_w,
                )
                + binding;
            for (j, fraction) in &b.deposition {
                w.water_rhs[*j] = w.water_rhs[*j] + s(*fraction) * w.coolant_heat[i];
            }
            let v = x.fuel[i];
            let mut wall = s(0.);
            let density = b.clad_mass
                / (std::f64::consts::PI
                    * (b.geometry.clad_outer_radius_m.powi(2)
                        - b.geometry.clad_inner_radius_m.powi(2))
                    * b.geometry.rod_length_m
                    * b.geometry.rods);
            for c in &b.contacts {
                let q = thermal::liquid_wall_current(
                    props,
                    x.pressure[c.water],
                    x.water_t[c.water],
                    v.clad_outer,
                    self.mass_flux(c, x),
                    thermal::WallLaw {
                        diameter_m: c.diameter,
                        film: thermal::Film::Core,
                        emissivity: b.geometry.clad_emissivity,
                        material: thermal::core_wall_material(v.clad_mean, density)
                            .map_err(error)?,
                    },
                    w.saturation[c.water],
                    w.water[c.water].thermal,
                )
                .map_err(error)?;
                if q.vapor_mass.value != 0. || q.vapor_mass.direction != 0. {
                    return Err("hot primary phase birth needs active phase transaction".into());
                }
                let heat = q.heat * s(c.area);
                wall = wall + heat;
                w.water_rhs[c.water] = w.water_rhs[c.water] + heat;
            }
            let q = thermal::fuel_heat_rates(
                &b.geometry,
                thermal::FuelTemperatures {
                    inner_mean: v.inner,
                    outer_mean: v.outer,
                    fuel_surface: v.surface,
                    helium: x.helium_t[b.helium],
                    clad_inner: v.clad_inner,
                    clad_mean: v.clad_mean,
                    clad_outer: v.clad_outer,
                },
                [w.fuel_heat[i] * s(0.5); 2],
                wall,
            )
            .map_err(error)?;
            w.fuel_rhs[i] = [q.fuel_inner, q.fuel_outer, q.clad];
            w.surface[i] = q.surface_residuals;
            w.helium_rhs[b.helium] = w.helium_rhs[b.helium] + q.helium;
            w.fuel_caloric[i] = [
                x.fuel_u[i][0]
                    - s(b.fuel_mass[0])
                        * thermal::fuel_caloric(v.inner)
                            .map_err(error)?
                            .specific_energy,
                x.fuel_u[i][1]
                    - s(b.fuel_mass[1])
                        * thermal::fuel_caloric(v.outer)
                            .map_err(error)?
                            .specific_energy,
                x.fuel_u[i][2]
                    - s(b.clad_mass)
                        * thermal::clad_caloric(v.clad_mean)
                            .map_err(error)?
                            .specific_energy,
            ];
            for k in 0..3 {
                w.fuel_residual[i][k] = d.fuel[i][k] - w.fuel_rhs[i][k];
            }
        }
        for c in &self.passive_contacts {
            let q = thermal::nonfuel_wall(
                x.passive_t[c.solid],
                x.water_t[c.water],
                s(c.area),
                c.liquid_h,
                c.log_radius,
            )
            .map_err(error)?;
            w.passive_rhs[c.solid] = w.passive_rhs[c.solid] - q;
            w.water_rhs[c.water] = w.water_rhs[c.water] + q;
        }
        for c in &self.plenum_contacts {
            let q = thermal::helium_to_plenum(
                x.helium_t[c.helium],
                x.passive_t[c.solid],
                c.area,
                c.radius,
                c.conduction_factor,
            )
            .map_err(error)?;
            w.helium_rhs[c.helium] = w.helium_rhs[c.helium] - q;
            w.passive_rhs[c.solid] = w.passive_rhs[c.solid] + q;
        }
        for (i, c) in self.sg.iter().enumerate() {
            let q = thermal::liquid_wall_current(
                props,
                x.pressure[c.contact.water],
                x.water_t[c.contact.water],
                x.sg_t[i],
                self.mass_flux(&c.contact, x),
                thermal::WallLaw {
                    diameter_m: c.contact.diameter,
                    film: thermal::Film::Tube,
                    emissivity: 0.3,
                    material: thermal::WallMaterial {
                        conductivity: s(15.),
                        density: 8000.,
                        cp: s(500.),
                    },
                },
                w.saturation[c.contact.water],
                w.water[c.contact.water].thermal,
            )
            .map_err(error)?;
            if q.vapor_mass.value != 0. || q.vapor_mass.direction != 0. {
                return Err("hot SG-primary phase birth needs active phase transaction".into());
            }
            let primary_to_metal = -q.heat * s(c.contact.area);
            let sec = x.secondary[c.secondary];
            let out = thermal::secondary_wall(
                props,
                sec.pressure,
                sec.temperature,
                x.sg_t[i],
                sec.liquid_volume,
                c.start,
                c.end,
                c.contact.area,
                c.contact.diameter,
                sec.steam_present,
            )
            .map_err(error)?;
            w.water_rhs[c.contact.water] = w.water_rhs[c.contact.water] - primary_to_metal;
            w.sg_rhs[i] = primary_to_metal - out;
            w.secondary_heat[c.secondary] = w.secondary_heat[c.secondary] + out;
            w.sg_residual[i] = d.sg[i] - w.sg_rhs[i];
            w.sg_caloric[i] = x.sg_u[i] - s(c.capacity) * (x.sg_t[i] - s(273.15));
        }
        for (e, c) in self.edges.iter().enumerate() {
            let q = x.face_flow[e];
            let donor = if q.value >= 0. { c.from } else { c.to };
            let heat = q * w.water[donor].projection.enthalpy;
            let tracer = q * x.boron_amount[donor] / x.water_mass[donor];
            w.water_rhs[c.from] = w.water_rhs[c.from] - heat;
            w.water_rhs[c.to] = w.water_rhs[c.to] + heat;
            w.continuity[c.from] = w.continuity[c.from] - q;
            w.continuity[c.to] = w.continuity[c.to] + q;
            w.boron_rhs[c.from] = w.boron_rhs[c.from] - tracer;
            w.boron_rhs[c.to] = w.boron_rhs[c.to] + tracer;
        }
        for i in 0..n {
            w.continuity[i] = d.water_mass[i] - w.continuity[i];
            w.water_residual[i] = d.water[i] - w.water_rhs[i];
            w.boron_residual[i] = d.boron[i] - w.boron_rhs[i];
        }
        for i in 0..self.helium_nr.len() {
            w.helium_residual[i] = d.helium[i] - w.helium_rhs[i];
            w.helium_caloric[i] = x.helium_u[i] - s(1.5 * self.helium_nr[i]) * x.helium_t[i];
        }
        for i in 0..self.passive_mass.len() {
            w.passive_residual[i] = d.passive[i] - w.passive_rhs[i];
            w.passive_caloric[i] = x.passive_u[i]
                - s(self.passive_mass[i])
                    * thermal::clad_caloric(x.passive_t[i])
                        .map_err(error)?
                        .specific_energy;
        }
        if !w
            .fuel_rhs
            .iter()
            .flatten()
            .chain(&w.helium_rhs)
            .chain(&w.passive_rhs)
            .chain(&w.sg_rhs)
            .chain(&w.water_rhs)
            .chain(&w.boron_rhs)
            .chain(&w.continuity)
            .chain(&w.caloric)
            .chain(&w.mass_caloric)
            .chain(&w.secondary_heat)
            .chain(w.surface.iter().flatten())
            .chain(w.fuel_residual.iter().flatten())
            .chain(&w.helium_residual)
            .chain(&w.passive_residual)
            .chain(&w.sg_residual)
            .chain(&w.water_residual)
            .chain(&w.boron_residual)
            .chain(w.fuel_caloric.iter().flatten())
            .chain(&w.helium_caloric)
            .chain(&w.passive_caloric)
            .chain(&w.sg_caloric)
            .chain(&w.nuclear_rates)
            .chain(w.poison_rates.iter().flatten())
            .chain(&w.fissile_rates)
            .chain(&w.fertile_rates)
            .chain(&w.capture_product_rates)
            .chain(w.history_rates.iter().flatten())
            .chain([&w.event_heat, &w.released_heat, &w.stored_history_rate])
            .copied()
            .all(finite)
        {
            return Err("nonfinite connected hot residual".into());
        }
        Ok(())
    }
}
