//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0013-coarse-local-pressure.md#mechanical-ownership-and-terminology
//! spec: world/packs/process-plant/reference-designs/ld-01/model/computational-design-review.md#pressure-realization-approved-10-october (exit 3: a consistent initial pair)
//! EOS-consistent hydrostatic preparation of the composed network at a
//! declared operating point. This is a deterministic construction of one
//! prepared state, not an iterative plant solver:
//!
//! 1. Phases. Primary and SURGE volumes hold liquid. The declared PZR level
//!    selects one existing region boundary as a sharp interface: regions
//!    below hold saturated liquid and regions above saturated vapor, each at
//!    its own local pressure. A level inside a region is refused; the coarse
//!    PZR has no partial fill.
//! 2. Pressures. Integrate hydrostatically from the declared roof gauge along
//!    a breadth-first spanning tree of the compiled faces, using each face's
//!    authored pressure segments and the current phase density of each
//!    segment region: the same well-balanced head as `local_flow`, so every
//!    tree face's pressure-gravity term vanishes at rest to round-off.
//!    Density depends on pressure, so passes repeat to an explicit fixed-point
//!    tolerance. Primary/SURGE liquid keeps its prepared specific internal
//!    energy, so its mass becomes `V * rho(p, u)`; liquid tracer keeps its
//!    prepared concentration.
//! 3. Non-tree (loop) faces keep their pressure-gravity imbalance. With
//!    nonuniform temperature it is the physical buoyancy drive; it is
//!    reported, never zeroed.
//! 4. The stocks overwrite the coordinates compiled by `Network::new` (see
//!    [`overwrite_stocks`]). Impulses stay zero and rotor angular momenta stay
//!    exactly as compiled; the caller declares every rotor's drive/shaft
//!    state, which the network requires. The network then evaluates
//!    `F(0, y, 0)` itself for the receipt: its EOS rows and face charts, not a
//!    second implementation.
use super::{
    Failure, Network, Prepared, Properties, RotorState, Water,
    packet::{FacePacket, Packet},
};
use crate::thermal::Scalar;
use serde::Serialize;
use std::collections::VecDeque;

/// Standard gravity of the well-balanced face head in `local_flow`.
const G: f64 = 9.80665;

/// Declared hydrostatic operating point; the owner packet supplies these
/// values from the wiki. The pump drive request belongs to [`RotorState`].
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct OperatingPoint {
    pub pzr_roof_pressure_pa: f64,
    pub pzr_roof_elevation_m: f64,
    /// Interface height above the PZR bottom datum, the lowest region bottom.
    pub pzr_level_m: f64,
}

/// Every control and acceptance bound of one preparation; none is defaulted.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Settings {
    /// A pass converges when no pressure changes by more than this.
    pub pressure_tolerance_pa: f64,
    pub max_passes: usize,
    /// Largest distance between the declared interface and the region
    /// boundary that represents it; below half of every region height.
    pub level_match_m: f64,
    /// Accept only if every evaluated EOS row is at most this.
    pub eos_row_bound: f64,
    /// Accept only if every tree-face pressure-gravity term is at most this.
    pub tree_face_bound_pa: f64,
}

/// One cell's retained stock: its present phase and physical values.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Stock {
    pub pressure_pa: f64,
    /// 0 liquid, 1 vapor; the other phase is exactly absent.
    pub phase: usize,
    pub mass_kg: f64,
    pub internal_energy_j: f64,
    pub tracer_kg_eq: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct State {
    pub pressure_pa: f64,
    pub temperature_k: f64,
    pub mass_kg: f64,
    pub internal_energy_j: f64,
    pub tracer_kg_eq: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RegionReceipt {
    pub region: usize,
    pub id: String,
    pub authored_phase: usize,
    pub phase: usize,
    pub before: State,
    pub after: State,
    /// Prepared temperature minus saturation at the local pressure (PZR).
    pub saturation_margin_k: Option<f64>,
    /// The network's evaluated EOS row: relative rigid-volume defect.
    pub eos_row: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FaceReceipt {
    pub face: usize,
    pub from: usize,
    pub to: usize,
    pub tree: bool,
    /// The network chart's pressure-gravity term per phase path at rest;
    /// `None` for a path without phase inertia.
    pub pressure_gravity_pa: [Option<f64>; 2],
    pub largest_pa: f64,
}

/// Largest magnitude of one class of residual rows and its first row.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RowClass {
    pub class: &'static str,
    pub max_abs: f64,
    pub row: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Receipt {
    pub operating_point: OperatingPoint,
    pub settings: Settings,
    pub root_region: usize,
    pub interface_elevation_m: f64,
    /// Largest pressure change of every hydrostatic pass.
    pub pass_changes_pa: Vec<f64>,
    pub regions: Vec<RegionReceipt>,
    pub faces: Vec<FaceReceipt>,
    pub mass_change_kg: f64,
    pub energy_change_j: f64,
    pub tracer_change_kg_eq: f64,
    pub max_eos_row: f64,
    pub max_tree_face_pa: f64,
    pub max_loop_face_pa: f64,
    /// Scaled rows of `F(0, y, 0)`: the initial relaxation implied by
    /// `y' = 0`, which consistent initialization still has to resolve.
    pub initial_rows: Vec<RowClass>,
    /// Declared drive/shaft state of every rotor, as evaluated.
    pub rotor_states: Vec<String>,
}

fn fatal(message: impl Into<String>) -> Failure {
    Failure::Fatal(format!("hydrostatic preparation: {}", message.into()))
}

impl Settings {
    fn validate(&self) -> Result<(), Failure> {
        let positive = [
            self.pressure_tolerance_pa,
            self.eos_row_bound,
            self.tree_face_bound_pa,
        ];
        if positive.iter().any(|v| !(v.is_finite() && *v > 0.))
            || self.max_passes == 0
            || !(self.level_match_m.is_finite() && self.level_match_m >= 0.)
        {
            return Err(fatal(format!("invalid settings {self:?}")));
        }
        Ok(())
    }
}

impl OperatingPoint {
    fn validate(&self) -> Result<(), Failure> {
        let values = [
            self.pzr_roof_pressure_pa,
            self.pzr_roof_elevation_m,
            self.pzr_level_m,
        ];
        if !values.iter().all(|v| v.is_finite()) || self.pzr_roof_pressure_pa <= 0. {
            return Err(fatal(format!("invalid operating point {self:?}")));
        }
        Ok(())
    }
}

/// Overwrite the cell coordinates of a `Network::new` layout in its compiled
/// solver scaling: pressure, the present phase's mass and internal energy,
/// exact zero mass and energy for the other phase, and liquid tracer.
/// Impulse and rotor coordinates are not touched, and the scales stay those
/// compiled from the packet. Refuses a stock that is not physically present.
pub fn overwrite_stocks<P: Properties>(
    network: &Network<P>,
    y: &mut [f64],
    stocks: &[Stock],
) -> Result<(), Failure> {
    if stocks.len() != network.cells() || y.len() != network.dimension() {
        return Err(fatal("stock/coordinate layout mismatch"));
    }
    for (node, (layout, stock)) in network.cell_layout.iter().zip(stocks).enumerate() {
        let values = [
            stock.pressure_pa,
            stock.mass_kg,
            stock.internal_energy_j,
            stock.tracer_kg_eq,
        ];
        if !values.iter().all(|v| v.is_finite())
            || stock.pressure_pa <= 0.
            || stock.mass_kg <= 0.
            || stock.tracer_kg_eq < 0.
            || stock.phase > 1
            || (stock.phase == 1 && stock.tracer_kg_eq != 0.)
        {
            return Err(fatal(format!(
                "region {node} stock {stock:?} is not present"
            )));
        }
        let k = stock.phase;
        for (index, value) in [
            (layout.base, stock.pressure_pa),
            (layout.mass[k], stock.mass_kg),
            (layout.energy[k], stock.internal_energy_j),
            (layout.mass[1 - k], 0.),
            (layout.energy[1 - k], 0.),
            (layout.boron, stock.tracer_kg_eq),
        ] {
            y[index] = value / network.scales()[index];
            if !y[index].is_finite() {
                return Err(fatal(format!("region {node} coordinate {index} scaling")));
            }
        }
    }
    Ok(())
}

enum Energy {
    /// Prepared specific internal energy, J/kg.
    Specific(f64),
    /// Saturated present phase at the local pressure.
    Saturated,
}

struct Owner {
    phase: usize,
    authored_phase: usize,
    energy: Energy,
    /// Liquid tracer per kg of liquid; zero for vapor.
    concentration: f64,
    before: State,
}

fn authored(
    pressure_pa: f64,
    temperature_k: f64,
    mass_kg: f64,
    internal_energy_j: f64,
    tracer_kg_eq: f64,
) -> Result<State, Failure> {
    let state = State {
        pressure_pa,
        temperature_k,
        mass_kg,
        internal_energy_j,
        tracer_kg_eq,
    };
    if ![pressure_pa, temperature_k, internal_energy_j, tracer_kg_eq]
        .iter()
        .all(|v| v.is_finite())
        || !(mass_kg.is_finite() && mass_kg > 0.)
    {
        return Err(fatal(format!("authored stock {state:?} is not present")));
    }
    Ok(state)
}

/// The region boundary representing the declared level, and the selected
/// phase of every PZR region (0 liquid below, 1 vapor above).
fn interface(
    packet: &Packet,
    point: &OperatingPoint,
    settings: &Settings,
) -> Result<(f64, Vec<usize>), Failure> {
    let regions = &packet.pzr.regions;
    let datum = regions
        .iter()
        .map(|r| r.bottom_m)
        .fold(f64::INFINITY, f64::min);
    let lowest = regions
        .iter()
        .map(|r| r.top_m - r.bottom_m)
        .fold(f64::INFINITY, f64::min);
    if !(datum.is_finite() && lowest > 2. * settings.level_match_m) {
        return Err(fatal(
            "level_match_m must stay below half of every PZR region height",
        ));
    }
    let requested = datum + point.pzr_level_m;
    let boundary = regions
        .iter()
        .flat_map(|r| [r.bottom_m, r.top_m])
        .fold(None, |best: Option<f64>, b| match best {
            Some(a) if (a - requested).abs() <= (b - requested).abs() => Some(a),
            _ => Some(b),
        })
        .filter(|b| (b - requested).abs() <= settings.level_match_m)
        .ok_or_else(|| {
            fatal(format!(
                "the coarse PZR cannot represent level {} m (interface {requested} m): it is not at a region boundary within {} m, and a region has no partial fill",
                point.pzr_level_m, settings.level_match_m
            ))
        })?;
    let mut phases = Vec::with_capacity(regions.len());
    for (j, r) in regions.iter().enumerate() {
        phases.push(if r.top_m <= boundary + settings.level_match_m {
            0
        } else if r.bottom_m >= boundary - settings.level_match_m {
            1
        } else {
            return Err(fatal(format!(
                "the coarse PZR cannot represent level {} m: region {j} spans {}..{} m across the interface {boundary} m",
                point.pzr_level_m, r.bottom_m, r.top_m
            )));
        });
    }
    Ok((boundary, phases))
}

fn owners<P: Properties>(
    packet: &Packet,
    network: &Network<P>,
    pzr_phase: &[usize],
) -> Result<Vec<Owner>, Failure> {
    let surge = network.pzr_begin() - 1;
    let mut owners = Vec::with_capacity(network.cells());
    for node in 0..network.cells() {
        let authored_phase = network.cell_layout[node].phase;
        let owner = if node <= surge {
            let before = if node < surge {
                let w = &packet.thermal.water[node];
                authored(
                    w.pressure_pa,
                    w.temperature_k,
                    w.mass_kg,
                    w.energy_j,
                    packet.water_boron_amount_kg_eq[node],
                )?
            } else {
                let w = &packet.external_ports.surge_stock;
                authored(
                    w.pressure_pa,
                    w.temperature_k,
                    w.mass_kg,
                    w.internal_energy_j,
                    w.absorber_tracer_kg_eq,
                )?
            };
            if authored_phase != 0 {
                return Err(fatal(format!("primary/SURGE region {node} is not liquid")));
            }
            Owner {
                phase: 0,
                authored_phase,
                energy: Energy::Specific(before.internal_energy_j / before.mass_kg),
                concentration: before.tracer_kg_eq / before.mass_kg,
                before,
            }
        } else {
            let j = node - network.pzr_begin();
            let r = &packet.pzr.regions[j];
            let energy = if authored_phase == 0 {
                r.liquid_energy_j
            } else {
                r.vapor_energy_j
            }
            .ok_or_else(|| fatal(format!("PZR region {j} lacks its authored phase energy")))?;
            let before = authored(
                r.common_pressure_pa,
                r.water.temperature_k,
                r.mass_kg,
                energy,
                r.absorber_tracer_kg_eq,
            )?;
            let phase = pzr_phase[j];
            let concentration = match (phase, authored_phase) {
                (1, _) => 0.,
                (_, 0) => before.tracer_kg_eq / before.mass_kg,
                _ => {
                    return Err(fatal(format!(
                        "PZR region {j} is liquid at the declared level but was prepared as vapor, so it has no prepared liquid tracer concentration"
                    )));
                }
            };
            Owner {
                phase,
                authored_phase,
                energy: Energy::Saturated,
                concentration,
                before,
            }
        };
        owners.push(owner);
    }
    Ok(owners)
}

/// Specific internal energy and caloric point of a present phase at `p`,
/// recovered through the same inversion the network's EOS row uses.
fn phase_state<P: Properties>(
    properties: &P,
    owner: &Owner,
    node: usize,
    pressure: f64,
) -> Result<(f64, Water), Failure> {
    let vapor = owner.phase == 1;
    let context = |e: String| {
        fatal(format!(
            "region {node} phase {} at {pressure} Pa: {e}",
            owner.phase
        ))
    };
    let u = match owner.energy {
        Energy::Specific(u) => u,
        Energy::Saturated => {
            let saturation = properties
                .saturation(Scalar::constant(pressure))
                .map_err(context)?;
            properties
                .forward(vapor, pressure, saturation.temperature.value)
                .map_err(context)?
                .internal_energy_j_kg
        }
    };
    let point = properties
        .caloric(vapor, pressure, u, false)
        .map_err(context)?;
    let water = properties.values(&point);
    if !(water.density_kg_m3.is_finite() && water.density_kg_m3 > 0.) {
        return Err(context(format!("density {}", water.density_kg_m3)));
    }
    Ok((u, water))
}

struct Tree {
    /// (face, known parent, child) in breadth-first order from the root.
    order: Vec<(usize, usize, usize)>,
    member: Vec<bool>,
}

/// Breadth-first spanning tree over faces in compiled index order.
fn spanning_tree(faces: &[FacePacket], cells: usize, root: usize) -> Result<Tree, Failure> {
    let mut reached = vec![false; cells];
    reached[root] = true;
    let mut queue = VecDeque::from([root]);
    let mut order = Vec::with_capacity(cells - 1);
    let mut member = vec![false; faces.len()];
    while let Some(node) = queue.pop_front() {
        for (j, f) in faces.iter().enumerate() {
            let other = if f.from == node {
                f.to
            } else if f.to == node {
                f.from
            } else {
                continue;
            };
            if !reached[other] {
                reached[other] = true;
                member[j] = true;
                order.push((j, node, other));
                queue.push_back(other);
            }
        }
    }
    if let Some(node) = reached.iter().position(|r| !r) {
        return Err(fatal(format!(
            "region {node} is not connected to the PZR roof gauge"
        )));
    }
    Ok(Tree { order, member })
}

/// One hydrostatic pass: root from the roof gauge, then every tree face at
/// rest, `p_to = p_from - sum(rho_segment * g * dz_segment)`.
fn integrate(
    faces: &[FacePacket],
    tree: &Tree,
    density: &[f64],
    root: usize,
    root_pressure: f64,
) -> Vec<f64> {
    let mut pressure = vec![0.; density.len()];
    pressure[root] = root_pressure;
    for &(j, parent, child) in &tree.order {
        let f = &faces[j];
        let head = f.pressure_segments.iter().fold(0., |sum, segment| {
            sum + density[segment.region] * (G * segment.elevation_change_m)
        });
        pressure[child] = if child == f.to {
            pressure[parent] - head
        } else {
            pressure[parent] + head
        };
    }
    pressure
}

/// Largest magnitude and its first index. A NaN is kept as the largest, so
/// it can never pass a bound.
fn largest(values: impl Iterator<Item = f64>) -> (f64, usize) {
    values.enumerate().fold((0., 0), |(best, at), (i, v)| {
        let magnitude = v.abs();
        let replace = !best.is_nan() && (magnitude.is_nan() || magnitude > best);
        if replace { (magnitude, i) } else { (best, at) }
    })
}

/// False for NaN, unlike a negated `>`.
fn at_most(value: f64, bound: f64) -> bool {
    value <= bound
}

/// Parts of the construction the receipt reads back.
struct Construction {
    root: usize,
    boundary: f64,
    pass_changes_pa: Vec<f64>,
    owners: Vec<Owner>,
    states: Vec<(f64, Water)>,
    stocks: Vec<Stock>,
    tree: Tree,
}

/// Build the network from `packet`, declare `rotors` (one per compiled
/// rotor), then construct and evaluate the hydrostatic prepared state at
/// `point`. The returned id vector reflects the declared shaft states. See
/// the module documentation.
pub fn prepare<P: Properties>(
    packet: &Packet,
    properties: P,
    point: &OperatingPoint,
    rotors: &[RotorState],
    settings: &Settings,
) -> Result<(Network<P>, Prepared, Receipt), Failure> {
    settings.validate()?;
    point.validate()?;
    let (mut network, mut prepared) = Network::new(packet, properties)?;
    if rotors.len() != network.rotor_count() {
        return Err(fatal(format!(
            "{} rotor states declared for {} compiled rotors",
            rotors.len(),
            network.rotor_count()
        )));
    }
    for (r, state) in rotors.iter().enumerate() {
        network.set_rotor_state(r, *state);
    }
    let (boundary, pzr_phase) = interface(packet, point, settings)?;
    let owners = owners(packet, &network, &pzr_phase)?;
    let begin = network.pzr_begin();
    let faces = &packet.mechanics.faces;
    let root = packet
        .pzr
        .regions
        .iter()
        .enumerate()
        .filter(|(_, r)| {
            r.bottom_m <= point.pzr_roof_elevation_m && point.pzr_roof_elevation_m <= r.top_m
        })
        .fold(None, |best: Option<(usize, f64)>, (j, r)| match best {
            Some((_, top)) if top >= r.top_m => best,
            _ => Some((j, r.top_m)),
        })
        .map(|(j, _)| begin + j)
        .ok_or_else(|| {
            fatal(format!(
                "roof elevation {} m lies in no PZR region",
                point.pzr_roof_elevation_m
            ))
        })?;
    let roof_leg = point.pzr_roof_elevation_m - packet.pzr.regions[root - begin].elevation_m;
    let tree = spanning_tree(faces, network.cells(), root)?;

    let mut pressure: Vec<f64> = owners.iter().map(|o| o.before.pressure_pa).collect();
    let mut pass_changes_pa = Vec::new();
    let states = loop {
        let states = owners
            .iter()
            .enumerate()
            .map(|(node, owner)| phase_state(network.properties(), owner, node, pressure[node]))
            .collect::<Result<Vec<_>, _>>()?;
        let density: Vec<f64> = states.iter().map(|(_, w)| w.density_kg_m3).collect();
        let root_pressure = point.pzr_roof_pressure_pa + density[root] * (G * roof_leg);
        let next = integrate(faces, &tree, &density, root, root_pressure);
        let (change, _) = largest(next.iter().zip(&pressure).map(|(a, b)| a - b));
        pass_changes_pa.push(change);
        pressure = next;
        if !change.is_finite() {
            return Err(fatal(format!("non-finite pass {pass_changes_pa:?}")));
        }
        if change <= settings.pressure_tolerance_pa {
            break owners
                .iter()
                .enumerate()
                .map(|(node, owner)| phase_state(network.properties(), owner, node, pressure[node]))
                .collect::<Result<Vec<_>, _>>()?;
        }
        if pass_changes_pa.len() == settings.max_passes {
            return Err(fatal(format!(
                "hydrostatic passes did not converge to {} Pa: {pass_changes_pa:?}",
                settings.pressure_tolerance_pa
            )));
        }
    };
    let stocks: Vec<Stock> = states
        .iter()
        .zip(&owners)
        .enumerate()
        .map(|(node, ((u, water), owner))| {
            let mass_kg = network.volume(node) * water.density_kg_m3;
            Stock {
                pressure_pa: pressure[node],
                phase: owner.phase,
                mass_kg,
                internal_energy_j: mass_kg * u,
                tracer_kg_eq: mass_kg * owner.concentration,
            }
        })
        .collect();
    overwrite_stocks(&network, &mut prepared.y, &stocks)?;
    network
        .evaluate(0., &prepared.y, &prepared.yp, None, 0., None)
        .map_err(|e| {
            fatal(format!(
                "the network cannot evaluate the prepared state: {e:?}"
            ))
        })?;
    prepared.differential = network.differential(&prepared.differential);
    let construction = Construction {
        root,
        boundary,
        pass_changes_pa,
        owners,
        states,
        stocks,
        tree,
    };
    let receipt = account(&network, packet, point, settings, construction)?;
    if !at_most(receipt.max_eos_row, settings.eos_row_bound) {
        return Err(fatal(format!(
            "EOS rows are not at round-off: {} > {}",
            receipt.max_eos_row, settings.eos_row_bound
        )));
    }
    if !at_most(receipt.max_tree_face_pa, settings.tree_face_bound_pa) {
        return Err(fatal(format!(
            "tree faces are not at rest: {} Pa > {} Pa",
            receipt.max_tree_face_pa, settings.tree_face_bound_pa
        )));
    }
    Ok((network, prepared, receipt))
}

fn account<P: Properties>(
    network: &Network<P>,
    packet: &Packet,
    point: &OperatingPoint,
    settings: &Settings,
    construction: Construction,
) -> Result<Receipt, Failure> {
    let Construction {
        root,
        boundary,
        pass_changes_pa,
        owners,
        states,
        stocks,
        tree,
    } = construction;
    let rows = network.rows();
    let mut regions = Vec::with_capacity(owners.len());
    for (node, ((owner, (_, water)), stock)) in owners.iter().zip(&states).zip(&stocks).enumerate()
    {
        let saturation_margin_k = match owner.energy {
            Energy::Specific(_) => None,
            Energy::Saturated => {
                let saturation = network
                    .properties()
                    .saturation(Scalar::constant(stock.pressure_pa))
                    .map_err(fatal)?;
                Some(water.temperature_k - saturation.temperature.value)
            }
        };
        regions.push(RegionReceipt {
            region: node,
            id: packet.mechanics.regions[node].id.clone(),
            authored_phase: owner.authored_phase,
            phase: owner.phase,
            before: owner.before,
            after: State {
                pressure_pa: stock.pressure_pa,
                temperature_k: water.temperature_k,
                mass_kg: stock.mass_kg,
                internal_energy_j: stock.internal_energy_j,
                tracer_kg_eq: stock.tracer_kg_eq,
            },
            saturation_margin_k,
            eos_row: rows[network.cell_layout[node].base].value,
        });
    }
    let change = |f: fn(&State) -> f64| {
        regions.iter().map(|r| f(&r.after)).sum::<f64>()
            - regions.iter().map(|r| f(&r.before)).sum::<f64>()
    };
    let mut faces = Vec::with_capacity(packet.mechanics.faces.len());
    for (j, f) in packet.mechanics.faces.iter().enumerate() {
        let mut pressure_gravity_pa = [None; 2];
        for (k, term) in pressure_gravity_pa.iter_mut().enumerate() {
            let chart = network
                .chart(j, k)
                .ok_or_else(|| fatal(format!("face {j} phase {k} has no evaluated chart")))?;
            if chart.inertance_kg_m4.value != 0. {
                *term = Some(chart.pressure_gravity_pa.value);
            }
        }
        faces.push(FaceReceipt {
            face: j,
            from: f.from,
            to: f.to,
            tree: tree.member[j],
            pressure_gravity_pa,
            largest_pa: largest(pressure_gravity_pa.iter().flatten().copied()).0,
        });
    }
    let side = |tree_face: bool| {
        largest(
            faces
                .iter()
                .filter(|f| f.tree == tree_face)
                .map(|f| f.largest_pa),
        )
        .0
    };
    let mut classes: Vec<(&'static str, Vec<usize>)> = [
        "eos",
        "liquid mass",
        "liquid energy",
        "vapor mass",
        "vapor energy",
        "tracer",
        "impulse",
        "rotor",
    ]
    .into_iter()
    .map(|class| (class, Vec::new()))
    .collect();
    for l in &network.cell_layout {
        for (class, index) in [
            l.base,
            l.mass[0],
            l.energy[0],
            l.mass[1],
            l.energy[1],
            l.boron,
        ]
        .into_iter()
        .enumerate()
        {
            classes[class].1.push(index);
        }
    }
    classes[6]
        .1
        .extend(network.face_layout.iter().map(|l| l.index));
    classes[7].1.extend(network.rotor_index.iter().copied());
    let initial_rows = classes
        .into_iter()
        .filter(|(_, indices)| !indices.is_empty())
        .map(|(class, indices)| {
            let (max_abs, at) = largest(indices.iter().map(|&i| rows[i].value));
            RowClass {
                class,
                max_abs,
                row: indices[at],
            }
        })
        .collect::<Vec<_>>();
    Ok(Receipt {
        operating_point: *point,
        settings: *settings,
        root_region: root,
        interface_elevation_m: boundary,
        pass_changes_pa,
        max_eos_row: largest(regions.iter().map(|r| r.eos_row)).0,
        mass_change_kg: change(|s| s.mass_kg),
        energy_change_j: change(|s| s.internal_energy_j),
        tracer_change_kg_eq: change(|s| s.tracer_kg_eq),
        max_tree_face_pa: side(true),
        max_loop_face_pa: side(false),
        regions,
        faces,
        initial_rows,
        rotor_states: (0..network.rotor_count())
            .map(|r| format!("{:?}", network.rotor_state(r)))
            .collect(),
    })
}
