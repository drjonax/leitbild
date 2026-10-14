//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#extensive-regional-kinetics
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#decay-heat-is-stored-energy-not-delayed-neutron-population
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#poison-memory
//! The joined spine's nuclear block: regional populations, the one
//! material-owned precursor bank, fissile/fertile/poison inventories and the
//! 23 fission plus 2 fertile-capture energy histories of every carrier.
//!
//! Every row is differential: `y' - rhs = 0`. The same current source
//! feedback (fuel temperature, the network's water, boron, Xe/Sm, fertile
//! opacity and the rods' achieved travel) drives the populations, the
//! precursors and the achieved material fissions; those same fissions and
//! the same exposure feed depletion, poisons, capture and the histories.
//! There is no renormalization to nominal power. The composition is the one
//! `hot_spine` carried (operating-hot-spine.md, "What one call computes"),
//! with water now read from the network instead of a second liquid chart.
//!
//! The 9,650 history rows are linear with constant coefficients in their own
//! store and in one event feed: `E' = y F - lambda E`. [`Nuclear::histories`]
//! exposes that structure (memo §6) so a block-analytic Jacobian can give
//! them constant entries; under stock IDA their `cj + lambda` diagonals are
//! eliminated by KLU's pivots, with every store retained in `y`.
use super::{
    block::{Class, Coordinates, Layout},
    packet::Packet,
};
use crate::{
    capture, heat_history, kinetics, network::Failure, poisons, source_feedback as sf,
    thermal::Scalar,
};

const FISSION_GROUPS: usize = 23;
const CAPTURE_GROUPS: usize = 2;
/// Histories per carrier: 23 fission-product then 2 fertile-capture stores.
pub const HISTORIES: usize = FISSION_GROUPS + CAPTURE_GROUPS;
/// Material inventories per carrier, in this order.
pub const MATERIALS: [&str; 6] = ["fissile", "fertile", "I-135", "Xe-135", "Pm-149", "Sm-149"];
const DELAYED: usize = kinetics::DELAYED_GROUPS;

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
/// A history's tangent at zero directions: exactly +0 (its coefficients
/// are nonnegative), the direction heat of an unseeded evaluation.
const UNSEEDED_HEAT: heat_history::Heat = heat_history::Heat {
    prompt_w: 0.,
    delayed_w: 0.,
    retained_input_w: 0.,
};
fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("joined nuclear: {}", reason.into()))
}
fn trial(reason: impl std::fmt::Display) -> Failure {
    Failure::Recoverable(format!("joined nuclear: {reason}"))
}

/// The current water state of one source region's owner cell.
#[derive(Clone, Copy, Debug)]
pub struct RegionWater {
    pub density_kg_m3: Scalar,
    pub boron_ppm_eq: Scalar,
    pub pressure_pa: Scalar,
    pub temperature_k: Scalar,
}

/// One linear history row: `E' = yield * feed - decay * E`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct History {
    /// Local coordinate (and row) of the store.
    pub index: usize,
    pub carrier: usize,
    pub decay_per_s: f64,
    pub retained_joules_per_event: f64,
    pub feed: Feed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Feed {
    /// The carrier's achieved fissions `F_a = sum_i G_ai N_i`.
    Fission,
    /// The carrier's fertile captures `sigma_f * fertile * exposure`.
    Capture,
}

/// The constant structure of the 2,316 precursor and 9,650 history rows,
/// compiled once for a block-analytic Jacobian (JAC's shape). Every row is
/// `x' - (sum coefficient * feed - decay * x) = 0` in physical units; the
/// joined row divides by the layout's row scale. Indices are global joined
/// coordinates.
#[derive(Clone, Debug, PartialEq)]
pub struct LinearTemplate {
    pub rows: Vec<LinearRow>,
    /// `(feed index, rhs coefficient per feed unit)`.
    pub terms: Vec<(usize, f64)>,
    /// Feed `2a` is carrier `a`'s achieved fissions `F_a = sum_i G_ai N_i`,
    /// feed `2a + 1` its fertile captures `sigma_f fertile_a exposure_a`.
    pub feeds: Vec<TemplateFeed>,
    /// Constant uses of the stores elsewhere: `(target, global column,
    /// coefficient)`, physical rhs per unit store.
    pub consumers: Vec<(Target, usize, f64)>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct LinearRow {
    /// Global row, equal to its own coordinate.
    pub row: usize,
    pub decay_per_s: f64,
    /// Its terms in [`LinearTemplate::terms`].
    pub terms: std::ops::Range<usize>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TemplateFeed {
    Fission { carrier: usize },
    Capture { carrier: usize },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    /// A regional population row (global): delayed emission `W_ia lambda C`.
    Row(usize),
    /// A carrier's fuel heat: the released history energy `lambda E`.
    FuelHeat(usize),
    /// A carrier's direct coolant heat (no constant store use at present).
    CoolantHeat(usize),
}

/// The nuclear block's compiled coefficients, read-only.
#[derive(Clone, Copy, Debug)]
pub struct Coefficients<'a> {
    pub capture: capture::Parameters,
    pub poison: &'a poisons::Model,
    pub reference_fertile: &'a [f64],
    pub transfer_rates_per_s: &'a [f64],
    pub emission_fractions: &'a [f64],
    pub outside_fractions: &'a [f64],
    /// Source capsule age at t = 0; the feedback reads `age0 + t`.
    pub capsule_age0_s: f64,
    /// 23 fission then 2 capture groups.
    pub groups: &'a [super::packet::Group],
    pub fission: &'a heat_history::Model,
    pub fertile: &'a heat_history::Model,
    pub prompt_coolant_fraction: f64,
    pub binding_coolant_fraction: f64,
    pub xenon_binding_j: f64,
    pub samarium_binding_j: f64,
    pub xenon_cross_section_m2: f64,
    pub samarium_cross_section_m2: f64,
    pub delayed_yields_per_fission: &'a [[f64; DELAYED]],
    pub precursor_decay_per_s: &'a [[f64; DELAYED]],
}

/// Per-carrier heat and diagnostics of the last evaluation.
#[derive(Clone, Debug, Default)]
pub struct Heat {
    /// Into the carrier's two fuel nodes, split equally by mass (W).
    pub fuel_w: Vec<Scalar>,
    /// Direct coolant deposition of the carrier (W), before its projection.
    pub coolant_w: Vec<Scalar>,
    /// Prompt + retained-input + binding: the event energy release rate.
    pub event_w: Scalar,
    /// Heat actually released into thermal recipients now.
    pub released_w: Scalar,
    /// Rate of change of the retained history energy.
    pub stored_rate_w: Scalar,
}

pub struct Nuclear {
    layout: Layout,
    prepared: Vec<f64>,
    feedback: sf::Model,
    kinetics: kinetics::Model,
    fission: heat_history::Model,
    fertile: heat_history::Model,
    capture: capture::Parameters,
    poison: poisons::Model,
    xenon_cross_section: f64,
    samarium_cross_section: f64,
    xenon_binding_j: f64,
    samarium_binding_j: f64,
    prompt_coolant_fraction: f64,
    binding_coolant_fraction: f64,
    reference_fertile: Vec<f64>,
    transfer_rates: Vec<f64>,
    emission: Vec<f64>,
    outside: Vec<f64>,
    capsule_age0_s: f64,
    /// The compiled groups, fission then capture, for [`Nuclear::histories`].
    groups: Vec<super::packet::Group>,
    /// Per carrier: (network cell, fraction) of its direct coolant heat.
    deposition: Vec<Vec<(usize, f64)>>,
    regions: usize,
    carriers: usize,
    /// Compiled (region, material) supports, kinetics order.
    supports: Vec<kinetics::Support>,
    /// Per material: delayed yields and decay constants (kinetics order).
    delayed_yields: Vec<[f64; DELAYED]>,
    precursor_decay: Vec<[f64; DELAYED]>,
    // Preallocated stage buffers; nothing allocates on the success path.
    work: Work,
}

/// The source feedback's inputs of one evaluation, values only.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct FeedbackInputs {
    pub neutrons: Vec<f64>,
    /// Per carrier: [mean(sqrt(T_node))]^2.
    pub fuel_temperature_k: Vec<f64>,
    /// Per region.
    pub water_density_kg_m3: Vec<f64>,
    pub boron_ppm_eq: Vec<f64>,
    pub pressure_pa: Vec<f64>,
    pub moderator_temperature_k: Vec<f64>,
    /// Per carrier.
    pub fissile_atoms: Vec<f64>,
    pub xenon_atoms: Vec<f64>,
    pub samarium_atoms: Vec<f64>,
    pub capture_loss_change_m2: Vec<f64>,
}

#[derive(Default)]
struct Work {
    feedback: Option<sf::Output>,
    fuel_t: Vec<Scalar>,
    fissile: Vec<Scalar>,
    xenon: Vec<Scalar>,
    samarium: Vec<Scalar>,
    opacity: Vec<Scalar>,
    density: Vec<Scalar>,
    boron: Vec<Scalar>,
    pressure: Vec<Scalar>,
    moderator: Vec<Scalar>,
    neutrons: Vec<Scalar>,
    state_value: Vec<f64>,
    state_direction: Vec<f64>,
    rate_value: Vec<f64>,
    rate_direction: Vec<f64>,
    region_value: Vec<kinetics::RegionInput>,
    region_direction: Vec<kinetics::RegionInput>,
    production_value: Vec<f64>,
    production_direction: Vec<f64>,
    zero_transfer: Vec<f64>,
    zero_emission: Vec<f64>,
    zero_outside: Vec<f64>,
    fission_value: Vec<f64>,
    fission_direction: Vec<f64>,
    history_value: Vec<f64>,
    history_direction: Vec<f64>,
    history_rate_value: Vec<f64>,
    history_rate_direction: Vec<f64>,
}

impl Nuclear {
    /// Compile once from the packet: the same models and checks the retired
    /// hot spine's workspace made. `water_cells` is the network's regular
    /// cell count.
    pub fn new(packet: &Packet, water_cells: usize) -> Result<Self, Failure> {
        let source = &packet.hot.source;
        let energy = &packet.hot.energy;
        let meta = &packet.feedback_metadata;
        let feedback = sf::Model::new(
            meta.parameters,
            meta.regions.clone(),
            meta.materials.clone(),
            meta.supports.clone(),
        )
        .map_err(|e| fatal(format!("source feedback: {e}")))?;
        let kinetics = kinetics::Model::new(
            source.regions.clone(),
            source.materials.clone(),
            source.transfers.clone(),
            source.supports.clone(),
        )
        .map_err(|e| fatal(format!("kinetics: {e}")))?;
        let groups = |g: &[super::packet::Group]| {
            g.iter()
                .map(|g| heat_history::Group {
                    decay_per_s: g.decay_per_s,
                    retained_joules_per_event: g.retained_joules_per_event,
                })
                .collect::<Vec<_>>()
        };
        let fission = heat_history::Model::new(
            energy.fission_joules_per_event,
            groups(&energy.fission_groups),
        )
        .map_err(|e| fatal(format!("fission history: {e}")))?;
        let capture_energy: f64 = energy
            .capture_groups
            .iter()
            .map(|g| g.retained_joules_per_event)
            .sum();
        let fertile = heat_history::Model::new(capture_energy, groups(&energy.capture_groups))
            .map_err(|e| fatal(format!("capture history: {e}")))?;
        let capture = capture::Parameters {
            cross_section_m2: energy.fertile_cross_section_m2,
            binding_joules_per_capture: energy.fertile_binding_joules_per_capture,
        };
        capture
            .validate()
            .map_err(|e| fatal(format!("capture: {e}")))?;
        let poison = poisons::Model::new(poisons::Parameters {
            decay_per_s: energy.poison_decay_per_s,
            direct_atoms_per_fission: energy.poison_yields_per_fission,
        })
        .map_err(|e| fatal(format!("poisons: {e}")))?;
        let r = source.regions.len();
        let a = energy.carriers.len();
        let inputs = &source.inputs;
        if r == 0
            || a == 0
            || feedback.region_count() != r
            || feedback.material_count() != a
            || kinetics.state_dimension() != r + DELAYED * a
            || kinetics.region_count() != r
            || kinetics.material_count() != a
            || kinetics.support_count() != feedback.support_count()
            || inputs.transfer_rates_per_s.len() != kinetics.transfer_count()
            || inputs.emission_fractions.len() != feedback.support_count()
            || inputs.outside_fractions.len() != a
            || fission.dimension() != FISSION_GROUPS
            || fertile.dimension() != CAPTURE_GROUPS
            || source.prepared_state.len() != r + DELAYED * a
            || packet.source_water.len() != r
            || packet.source_water.iter().any(|j| *j >= water_cells)
            || energy
                .carriers
                .iter()
                .any(|c| c.stores_j.len() != HISTORIES)
            || feedback.rod_count() != packet.feedback_reference.achieved_rod_travel_m.len()
        {
            return Err(fatal("inconsistent nuclear allocation"));
        }
        if inputs
            .transfer_rates_per_s
            .iter()
            .chain(&inputs.emission_fractions)
            .chain(&inputs.outside_fractions)
            .any(|v| !v.is_finite() || *v < 0.)
            || [
                energy.xenon_cross_section_m2,
                energy.samarium_cross_section_m2,
                energy.xenon_binding_joules_per_capture,
                energy.samarium_binding_joules_per_capture,
            ]
            .iter()
            .any(|v| !v.is_finite() || *v < 0.)
            || [
                energy.binding_coolant_fraction,
                energy.prompt_fission_coolant_fraction,
            ]
            .iter()
            .any(|v| !v.is_finite() || !(0. ..=1.).contains(v))
        {
            return Err(fatal("invalid nuclear coefficient"));
        }
        // Direct coolant deposition: the carrier's current emission shares,
        // projected through each region's water owner (the retired hot
        // spine's map).
        let mut deposition = vec![std::collections::BTreeMap::new(); a];
        for (k, support) in source.supports.iter().enumerate() {
            *deposition[support.material]
                .entry(packet.source_water[support.region])
                .or_insert(0.) += inputs.emission_fractions[k];
        }
        let deposition: Vec<Vec<(usize, f64)>> = deposition
            .into_iter()
            .map(|m| m.into_iter().collect())
            .collect();
        for (carrier, d) in deposition.iter().enumerate() {
            let total: f64 = d.iter().map(|(_, f)| f).sum();
            if (total - 1.).abs() > 1e-12 {
                return Err(fatal(format!(
                    "carrier {carrier} deposits {total} of its coolant heat inside the water"
                )));
            }
        }
        let reference_fertile: Vec<f64> = energy.carriers.iter().map(|c| c.fertile_atoms).collect();
        if reference_fertile.iter().any(|v| !v.is_finite() || *v <= 0.) {
            return Err(fatal("nonpositive reference fertile inventory"));
        }
        // Layout: N, C (the kinetics state order), materials, histories.
        let mut layout = Layout::default();
        let mut prepared = Vec::with_capacity(r + DELAYED * a + 6 * a + HISTORIES * a);
        let mut push = |layout: &mut Layout, label: String, class: Class, value: f64| {
            layout.push(label, class, true, value, value);
            prepared.push(value);
        };
        for (i, v) in source.prepared_state[..r].iter().enumerate() {
            push(
                &mut layout,
                format!("N[{i}]"),
                Class::RegionalPopulation,
                *v,
            );
        }
        for (k, v) in source.prepared_state[r..].iter().enumerate() {
            let (m, g) = (k / DELAYED, k % DELAYED);
            push(
                &mut layout,
                format!("C[{}][{g}]", energy.carriers[m].id),
                Class::Precursor,
                *v,
            );
        }
        let material_classes = [
            Class::Fissile,
            Class::Fertile,
            Class::Iodine,
            Class::Xenon,
            Class::Promethium,
            Class::Samarium,
        ];
        for c in &energy.carriers {
            let values = [
                c.fissile_atoms,
                c.fertile_atoms,
                c.poison_atoms[0],
                c.poison_atoms[1],
                c.poison_atoms[2],
                c.poison_atoms[3],
            ];
            for ((name, class), v) in MATERIALS.iter().zip(material_classes).zip(values) {
                push(&mut layout, format!("{name}[{}]", c.id), class, v);
            }
        }
        for c in &energy.carriers {
            for (g, v) in c.stores_j.iter().enumerate() {
                let class = if g < FISSION_GROUPS {
                    Class::FissionHistory
                } else {
                    Class::CaptureHistory
                };
                push(&mut layout, format!("E[{}][{g}]", c.id), class, *v);
            }
        }
        layout.validate("joined nuclear")?;
        let h = HISTORIES;
        let work = Work {
            feedback: Some(sf::Output::new(r, a, feedback.support_count())),
            fuel_t: vec![s(0.); a],
            fissile: vec![s(0.); a],
            xenon: vec![s(0.); a],
            samarium: vec![s(0.); a],
            opacity: vec![s(0.); a],
            density: vec![s(0.); r],
            boron: vec![s(0.); r],
            pressure: vec![s(0.); r],
            moderator: vec![s(0.); r],
            neutrons: vec![s(0.); r],
            state_value: vec![0.; r + DELAYED * a],
            state_direction: vec![0.; r + DELAYED * a],
            rate_value: vec![0.; r + DELAYED * a],
            rate_direction: vec![0.; r + DELAYED * a],
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
            production_value: vec![0.; feedback.support_count()],
            production_direction: vec![0.; feedback.support_count()],
            zero_transfer: vec![0.; kinetics.transfer_count()],
            zero_emission: vec![0.; feedback.support_count()],
            zero_outside: vec![0.; a],
            fission_value: vec![0.; a],
            fission_direction: vec![0.; a],
            history_value: vec![0.; h],
            history_direction: vec![0.; h],
            history_rate_value: vec![0.; h],
            history_rate_direction: vec![0.; h],
        };
        Ok(Self {
            layout,
            prepared,
            feedback,
            kinetics,
            fission,
            fertile,
            capture,
            poison,
            xenon_cross_section: energy.xenon_cross_section_m2,
            samarium_cross_section: energy.samarium_cross_section_m2,
            xenon_binding_j: energy.xenon_binding_joules_per_capture,
            samarium_binding_j: energy.samarium_binding_joules_per_capture,
            prompt_coolant_fraction: energy.prompt_fission_coolant_fraction,
            binding_coolant_fraction: energy.binding_coolant_fraction,
            reference_fertile,
            transfer_rates: inputs.transfer_rates_per_s.clone(),
            emission: inputs.emission_fractions.clone(),
            outside: inputs.outside_fractions.clone(),
            capsule_age0_s: packet.feedback_reference.capsule_age_s,
            groups: energy
                .fission_groups
                .iter()
                .chain(&energy.capture_groups)
                .copied()
                .collect(),
            deposition,
            regions: r,
            carriers: a,
            supports: source.supports.clone(),
            delayed_yields: source
                .materials
                .iter()
                .map(|m| m.delayed_yields_per_fission)
                .collect(),
            precursor_decay: source
                .materials
                .iter()
                .map(|m| m.decay_constants_per_s)
                .collect(),
            work,
        })
    }

    pub fn layout(&self) -> &Layout {
        &self.layout
    }
    pub fn prepared(&self) -> &[f64] {
        &self.prepared
    }
    pub fn regions(&self) -> usize {
        self.regions
    }
    pub fn carriers(&self) -> usize {
        self.carriers
    }
    pub fn feedback(&self) -> &sf::Model {
        &self.feedback
    }
    pub fn kinetics(&self) -> &kinetics::Model {
        &self.kinetics
    }
    /// The water cells receiving each carrier's direct coolant heat.
    pub fn deposition(&self) -> &[Vec<(usize, f64)>] {
        &self.deposition
    }
    /// The compiled (region, material) supports.
    pub fn supports(&self) -> &[kinetics::Support] {
        &self.supports
    }
    /// Every compiled coefficient the rows read, read-only.
    pub fn coefficients(&self) -> Coefficients<'_> {
        Coefficients {
            capture: self.capture,
            poison: &self.poison,
            reference_fertile: &self.reference_fertile,
            transfer_rates_per_s: &self.transfer_rates,
            emission_fractions: &self.emission,
            outside_fractions: &self.outside,
            capsule_age0_s: self.capsule_age0_s,
            groups: &self.groups,
            fission: &self.fission,
            fertile: &self.fertile,
            prompt_coolant_fraction: self.prompt_coolant_fraction,
            binding_coolant_fraction: self.binding_coolant_fraction,
            xenon_binding_j: self.xenon_binding_j,
            samarium_binding_j: self.samarium_binding_j,
            xenon_cross_section_m2: self.xenon_cross_section,
            samarium_cross_section_m2: self.samarium_cross_section,
            delayed_yields_per_fission: &self.delayed_yields,
            precursor_decay_per_s: &self.precursor_decay,
        }
    }
    /// The precursor and history rows' constant structure, with this
    /// block's coordinates starting at global index `offset`.
    pub fn linear_template(&self, offset: usize) -> LinearTemplate {
        let a = self.carriers;
        let mut t = LinearTemplate {
            rows: Vec::with_capacity(DELAYED * a + HISTORIES * a),
            terms: Vec::with_capacity(DELAYED * a + HISTORIES * a),
            feeds: (0..a)
                .flat_map(|carrier| {
                    [
                        TemplateFeed::Fission { carrier },
                        TemplateFeed::Capture { carrier },
                    ]
                })
                .collect(),
            consumers: Vec::new(),
        };
        // C'_ag = sum_i nu_ag G_ai N_i - lambda C = nu_ag F_a - lambda C.
        for m in 0..a {
            for g in 0..DELAYED {
                let k = t.terms.len();
                t.terms.push((2 * m, self.delayed_yields[m][g]));
                t.rows.push(LinearRow {
                    row: offset + self.precursor(m, g),
                    decay_per_s: self.precursor_decay[m][g],
                    terms: k..k + 1,
                });
            }
        }
        for m in 0..a {
            for (g, group) in self.groups.iter().enumerate() {
                let feed = if g < FISSION_GROUPS { 2 * m } else { 2 * m + 1 };
                let k = t.terms.len();
                t.terms.push((feed, group.retained_joules_per_event));
                t.rows.push(LinearRow {
                    row: offset + self.history(m, g),
                    decay_per_s: group.decay_per_s,
                    terms: k..k + 1,
                });
                t.consumers.push((
                    Target::FuelHeat(m),
                    offset + self.history(m, g),
                    group.decay_per_s,
                ));
            }
        }
        // Delayed emission into the regional populations.
        for (k, support) in self.supports.iter().enumerate() {
            for g in 0..DELAYED {
                t.consumers.push((
                    Target::Row(offset + support.region),
                    offset + self.precursor(support.material, g),
                    self.emission[k] * self.precursor_decay[support.material][g],
                ));
            }
        }
        t
    }
    /// Local index of carrier `a`'s precursor group `g`.
    pub fn precursor(&self, a: usize, g: usize) -> usize {
        self.regions + DELAYED * a + g
    }
    /// Local index of carrier `a`'s material inventory `k` ([`MATERIALS`]).
    pub fn material(&self, a: usize, k: usize) -> usize {
        self.regions + DELAYED * self.carriers + 6 * a + k
    }
    /// Local index of carrier `a`'s history store `g`.
    pub fn history(&self, a: usize, g: usize) -> usize {
        self.regions + DELAYED * self.carriers + 6 * self.carriers + HISTORIES * a + g
    }
    /// Every linear history row with its constant coefficients and feed.
    pub fn histories(&self) -> Vec<History> {
        let mut out = Vec::with_capacity(HISTORIES * self.carriers);
        for a in 0..self.carriers {
            for (g, group) in self.groups.iter().enumerate() {
                let feed = if g < FISSION_GROUPS {
                    Feed::Fission
                } else {
                    Feed::Capture
                };
                out.push(History {
                    index: self.history(a, g),
                    carrier: a,
                    decay_per_s: group.decay_per_s,
                    retained_joules_per_event: group.retained_joules_per_event,
                    feed,
                });
            }
        }
        out
    }

    /// Every own row (physical units) and the carriers' heat at these
    /// coordinates and conditions. `fuel_t` is each carrier's feedback
    /// temperature (the mean-sqrt functional of its two fuel nodes),
    /// `water` the owner cell of each source region, `travel` the rods'
    /// achieved travel and `t` the simulated time since preparation.
    #[allow(clippy::too_many_arguments)] // One block's stage: its coordinates and three ports.
    pub fn rows(
        &mut self,
        t: f64,
        x: Coordinates<'_>,
        fuel_t: &[Scalar],
        water: &[RegionWater],
        travel: &[Scalar],
        rows: &mut [Scalar],
        heat: &mut Heat,
    ) -> Result<(), Failure> {
        let (r, a) = (self.regions, self.carriers);
        if x.len() != self.layout.len()
            || rows.len() != self.layout.len()
            || fuel_t.len() != a
            || water.len() != r
            || travel.len() != self.feedback.rod_count()
        {
            return Err(fatal("stage length"));
        }
        heat.fuel_w.resize(a, s(0.));
        heat.coolant_w.resize(a, s(0.));
        // An unseeded evaluation carries zero directions everywhere: its
        // rows' and heats' directions are exactly +0 without the tangent
        // laws (which are linear in those zero directions), so it evaluates
        // the values only.
        let seeded = x.seeded();
        let w = &mut self.work;
        let mut out = w.feedback.take().ok_or_else(|| fatal("feedback buffer"))?;
        let result = (|| {
            for (i, water) in water.iter().enumerate() {
                w.neutrons[i] = x.value(i);
                w.density[i] = water.density_kg_m3;
                w.boron[i] = water.boron_ppm_eq;
                w.pressure[i] = water.pressure_pa;
                w.moderator[i] = water.temperature_k;
            }
            let m0 = r + DELAYED * a;
            w.fuel_t.copy_from_slice(fuel_t);
            for c in 0..a {
                w.fissile[c] = x.value(m0 + 6 * c);
                w.xenon[c] = x.value(m0 + 6 * c + 3);
                w.samarium[c] = x.value(m0 + 6 * c + 5);
                w.opacity[c] = s(self.capture.cross_section_m2)
                    * (x.value(m0 + 6 * c + 1) - s(self.reference_fertile[c]));
            }
            self.feedback
                .evaluate(
                    &w.neutrons,
                    sf::Conditions {
                        fuel_temperature_k: &w.fuel_t,
                        water_density_kg_m3: &w.density,
                        boron_ppm_eq: &w.boron,
                        pressure_pa: &w.pressure,
                        moderator_temperature_k: &w.moderator,
                        fissile_atoms: &w.fissile,
                        xenon_atoms: &w.xenon,
                        samarium_atoms: &w.samarium,
                        capture_loss_change_m2: &w.opacity,
                        achieved_rod_travel_m: travel,
                        capsule_age_s: s(self.capsule_age0_s + t),
                    },
                    &mut out,
                )
                .map_err(trial)?;
            // These SAME current rho/G drive populations, precursors and
            // fissions: feedback is not a parallel diagnostic.
            for i in 0..m0 {
                let v = x.value(i);
                w.state_value[i] = v.value;
                if seeded {
                    w.state_direction[i] = v.direction;
                }
            }
            for i in 0..r {
                w.region_value[i] = kinetics::RegionInput {
                    reactivity: out.regions[i].reactivity.value,
                    external_source_per_s: out.regions[i].external_source_per_s.value,
                };
                if seeded {
                    w.region_direction[i] = kinetics::RegionInput {
                        reactivity: out.regions[i].reactivity.direction,
                        external_source_per_s: out.regions[i].external_source_per_s.direction,
                    };
                }
            }
            for (k, g) in out.fissions_per_population_s.iter().enumerate() {
                w.production_value[k] = g.value;
                if seeded {
                    w.production_direction[k] = g.direction;
                }
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
                    &w.state_value,
                    inputs,
                    &mut w.rate_value,
                    &mut w.fission_value,
                )
                .map_err(trial)?;
            if seeded {
                self.kinetics
                    .directional_derivative(
                        &w.state_value,
                        inputs,
                        &w.state_direction,
                        direction,
                        &mut w.rate_direction,
                        &mut w.fission_direction,
                    )
                    .map_err(trial)?;
            } else {
                w.rate_direction.fill(0.);
                w.fission_direction.fill(0.);
                w.history_rate_direction.fill(0.);
            }
            for (i, row) in rows.iter_mut().enumerate().take(m0) {
                *row = x.rate(i) - Scalar::new(w.rate_value[i], w.rate_direction[i]);
            }
            heat.event_w = s(0.);
            heat.released_w = s(0.);
            heat.stored_rate_w = s(0.);
            for c in 0..a {
                let fissions = Scalar::new(w.fission_value[c], w.fission_direction[c]);
                let exposure = out.exposure_per_m2_s[c];
                let fertile = x.value(m0 + 6 * c + 1);
                let cap = self
                    .capture
                    .rates(fertile.value, exposure.value)
                    .map_err(trial)?;
                let dc = if seeded {
                    self.capture
                        .tangent(
                            fertile.value,
                            exposure.value,
                            fertile.direction,
                            exposure.direction,
                        )
                        .map_err(trial)?
                } else {
                    capture::Receipt {
                        captures_per_s: 0.,
                        target_rate_per_s: 0.,
                        product_rate_per_s: 0.,
                        binding_w: 0.,
                    }
                };
                let base = m0 + 6 * c;
                rows[base] = x.rate(base) + fissions;
                rows[base + 1] =
                    x.rate(base + 1) - Scalar::new(cap.target_rate_per_s, dc.target_rate_per_s);
                let inventories = [2, 3, 4, 5].map(|k| x.value(base + k));
                let captures = [
                    s(0.),
                    s(self.xenon_cross_section) * exposure,
                    s(0.),
                    s(self.samarium_cross_section) * exposure,
                ];
                let mut pr = [0.; 4];
                let mut dp = [0.; 4];
                let pv = inventories.map(|v| v.value);
                let pd = inventories.map(|v| v.direction);
                let pi = poisons::Input {
                    fissions_per_s: fissions.value,
                    capture_per_s: captures.map(|v| v.value),
                };
                self.poison.rates(&pv, pi, &mut pr).map_err(trial)?;
                if seeded {
                    self.poison
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
                        .map_err(trial)?;
                }
                for k in 0..4 {
                    rows[base + 2 + k] = x.rate(base + 2 + k) - Scalar::new(pr[k], dp[k]);
                }
                let h0 = m0 + 6 * a + HISTORIES * c;
                for g in 0..HISTORIES {
                    let q = x.value(h0 + g);
                    w.history_value[g] = q.value;
                    if seeded {
                        w.history_direction[g] = q.direction;
                    }
                }
                let f = self
                    .fission
                    .rates(
                        &w.history_value[..FISSION_GROUPS],
                        fissions.value,
                        &mut w.history_rate_value[..FISSION_GROUPS],
                    )
                    .map_err(trial)?;
                let df = if seeded {
                    self.fission
                        .tangent(
                            &w.history_direction[..FISSION_GROUPS],
                            fissions.direction,
                            &mut w.history_rate_direction[..FISSION_GROUPS],
                        )
                        .map_err(trial)?
                } else {
                    UNSEEDED_HEAT
                };
                let cf = self
                    .fertile
                    .rates(
                        &w.history_value[FISSION_GROUPS..],
                        cap.captures_per_s,
                        &mut w.history_rate_value[FISSION_GROUPS..],
                    )
                    .map_err(trial)?;
                let dcf = if seeded {
                    self.fertile
                        .tangent(
                            &w.history_direction[FISSION_GROUPS..],
                            dc.captures_per_s,
                            &mut w.history_rate_direction[FISSION_GROUPS..],
                        )
                        .map_err(trial)?
                } else {
                    UNSEEDED_HEAT
                };
                for g in 0..HISTORIES {
                    let rate = Scalar::new(w.history_rate_value[g], w.history_rate_direction[g]);
                    heat.stored_rate_w = heat.stored_rate_w + rate;
                    rows[h0 + g] = x.rate(h0 + g) - rate;
                }
                let prompt = Scalar::new(f.prompt_w, df.prompt_w);
                let delayed = Scalar::new(f.delayed_w + cf.delayed_w, df.delayed_w + dcf.delayed_w);
                let binding = Scalar::new(cap.binding_w, dc.binding_w)
                    + s(self.xenon_binding_j) * out.poison_capture_per_s[c].xenon
                    + s(self.samarium_binding_j) * out.poison_capture_per_s[c].samarium;
                heat.fuel_w[c] = s(1. - self.prompt_coolant_fraction) * prompt
                    + delayed
                    + s(1. - self.binding_coolant_fraction) * binding;
                heat.coolant_w[c] = s(self.prompt_coolant_fraction) * prompt
                    + s(self.binding_coolant_fraction) * binding;
                heat.released_w = heat.released_w + heat.fuel_w[c] + heat.coolant_w[c];
                heat.event_w = heat.event_w
                    + prompt
                    + Scalar::new(
                        f.retained_input_w + cf.retained_input_w,
                        df.retained_input_w + dcf.retained_input_w,
                    )
                    + binding;
            }
            if rows
                .iter()
                .chain(&heat.fuel_w)
                .chain(&heat.coolant_w)
                .chain([&heat.event_w, &heat.released_w, &heat.stored_rate_w])
                .any(|v| !(v.value.is_finite() && v.direction.is_finite()))
            {
                return Err(trial("nonfinite nuclear row or heat"));
            }
            Ok(())
        })();
        w.feedback = Some(out);
        result
    }

    /// The source feedback output of the last evaluation (reactivities,
    /// fissions, exposures, rod overlap), for receipts and Z3.
    pub fn feedback_output(&self) -> Option<&sf::Output> {
        self.work.feedback.as_ref()
    }
    /// The source feedback's inputs of the last evaluation, values only, for
    /// a reactivity decomposition ([`sf::Model::reactivity_terms`]).
    pub fn feedback_inputs(&self) -> FeedbackInputs {
        let v = |x: &[Scalar]| x.iter().map(|s| s.value).collect();
        let w = &self.work;
        FeedbackInputs {
            neutrons: v(&w.neutrons),
            fuel_temperature_k: v(&w.fuel_t),
            water_density_kg_m3: v(&w.density),
            boron_ppm_eq: v(&w.boron),
            pressure_pa: v(&w.pressure),
            moderator_temperature_k: v(&w.moderator),
            fissile_atoms: v(&w.fissile),
            xenon_atoms: v(&w.xenon),
            samarium_atoms: v(&w.samarium),
            capture_loss_change_m2: v(&w.opacity),
        }
    }
}
