//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressurizer-thermal-state.md#preparation-at-600-m-saturated
//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#s1-declaration-hydraulics-admission
//! EOS-consistent hydrostatic preparation of the composed network at a
//! declared operating point. This is a deterministic construction of one
//! prepared state, not an iterative plant solver:
//!
//! 1. The PZR. The stratified cell owner prepares its seventeen coordinates
//!    at the declared roof pressure and level (`stratified::prepare`): all
//!    zones at saturation of the interface, no transit stock, every row zero
//!    to rounding. It returns the column pressure at the surge port.
//! 2. Pressures. Primary and SURGE volumes hold liquid. SURGE follows from the
//!    port face at rest, `p_SURGE = p_port + g*sum(rho_mix*dz)` over the port
//!    face's SURGE segments; then a breadth-first spanning tree of the
//!    regular faces from SURGE, with each face's authored pressure segments
//!    and the mixture density of each segment region: the well-balanced head
//!    of `local_flow`, so every tree face's mixture remainder vanishes at rest
//!    to round-off. Density depends on pressure, so passes repeat to an
//!    explicit fixed-point tolerance. Liquid keeps its prepared specific
//!    internal energy, so its mass becomes `V * rho(p, u)`, and its prepared
//!    tracer concentration.
//! 3. Reported, never zeroed: a loop face's mixture remainder (with
//!    nonuniform temperature, the physical buoyancy drive).
//! 4. The regular stocks overwrite the coordinates compiled by `Network::new`
//!    (see [`overwrite_stocks`]) so that the network reconstructs exactly the
//!    prepared pressure and specific internal energies. Impulses stay zero
//!    and rotor angular momenta stay exactly as compiled; the caller declares
//!    every rotor's drive/shaft state, which the network requires. The
//!    network then evaluates `F(0, y, 0)` itself for the receipt: its rows,
//!    cells and face charts, not a second implementation of its equations.
use super::{
    Failure, Network, PZR_ALGEBRAIC, PZR_COORDINATES, PZR_ENERGY, PZR_MASS, PZR_TRACER, Prepared,
    Properties, PzrPreparation, RotorState, Water,
    packet::{self, FacePacket, Packet},
    stratified,
};
use crate::local_flow::Cell;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::VecDeque;

/// Standard gravity of the well-balanced face head in `local_flow`.
const G: f64 = 9.80665;

/// Declared hydrostatic operating point; the owner packet supplies these
/// values from the wiki. The pump drive request belongs to [`RotorState`].
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct OperatingPoint {
    pub pzr_roof_pressure_pa: f64,
    pub pzr_roof_elevation_m: f64,
    /// Indicated liquid height above `pzr_bottom_elevation_m`.
    pub pzr_level_m: f64,
    /// Declared PZR bottom datum; it must be the compiled cell bottom.
    pub pzr_bottom_elevation_m: f64,
}

impl From<&packet::OperatingPoint> for OperatingPoint {
    /// The packet's speed request is not hydrostatic: it maps to [`RotorState`].
    fn from(point: &packet::OperatingPoint) -> Self {
        Self {
            pzr_roof_pressure_pa: point.pzr_roof_pressure_pa,
            pzr_roof_elevation_m: point.pzr_roof_elevation_m,
            pzr_level_m: point.pzr_level_m,
            pzr_bottom_elevation_m: point.pzr_bottom_elevation_m,
        }
    }
}

/// Every control and acceptance bound of one preparation; none is defaulted.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Settings {
    /// A pass converges when no pressure changes by more than this.
    pub pressure_tolerance_pa: f64,
    pub max_passes: usize,
    /// Agreement bound of the declared datum and roof with the compiled cell.
    pub level_match_m: f64,
    /// Accept only if every evaluated EOS row is at most this.
    pub eos_row_bound: f64,
    /// Accept only if every tree face's mixture remainder is at most this.
    pub tree_face_bound_pa: f64,
    /// Adjacent representable coordinates tried on each side when writing an
    /// exactly reconstructed pressure or specific internal energy.
    pub representation_search: usize,
}

/// One regular cell's prepared stock, liquid then vapor. A zero-mass phase
/// is exactly absent and carries zero specific internal energy.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Stock {
    pub pressure_pa: f64,
    pub mass_kg: [f64; 2],
    pub specific_energy_j_kg: [f64; 2],
    pub tracer_kg_eq: f64,
}

/// Physical values the network reconstructs from written coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Written {
    pub pressure_pa: f64,
    pub mass_kg: [f64; 2],
    pub internal_energy_j: [f64; 2],
    pub tracer_kg_eq: f64,
    /// Largest step from the nearest coordinate, in representable values.
    pub offset: usize,
}

/// The authored single-phase stock of one region.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct State {
    pub pressure_pa: f64,
    pub temperature_k: f64,
    pub mass_kg: f64,
    pub internal_energy_j: f64,
    pub tracer_kg_eq: f64,
}

/// One prepared present phase.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct PhaseState {
    pub temperature_k: f64,
    pub mass_kg: f64,
    pub internal_energy_j: f64,
    pub volume_m3: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RegionReceipt {
    pub region: usize,
    pub id: String,
    pub before: State,
    pub pressure_pa: f64,
    /// Liquid then vapor; `None` is an exactly absent phase.
    pub phases: [Option<PhaseState>; 2],
    pub tracer_kg_eq: f64,
    /// The network's evaluated EOS row: relative rigid-volume defect.
    pub eos_row: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FaceReceipt {
    pub face: usize,
    pub from: usize,
    pub to: usize,
    pub tree: bool,
    /// Mixture remainder `p_from - p_to - g*sum(rho_mix*dz)` of the network's
    /// own evaluated cells (the PZR side is its port view), as in `local_flow`.
    pub rest_pa: f64,
    /// The network chart's pressure-gravity term per phase path; `None`
    /// without phase inertia.
    pub pressure_gravity_pa: [Option<f64>; 2],
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
    /// SURGE: the tree root, fixed by the port face from the PZR port.
    pub root_region: usize,
    pub port_pressure_pa: f64,
    /// The stratified cell owner's preparation receipt.
    pub pzr: Value,
    /// Largest pressure change of every hydrostatic pass.
    pub pass_changes_pa: Vec<f64>,
    pub regions: Vec<RegionReceipt>,
    pub faces: Vec<FaceReceipt>,
    /// Prepared minus authored primary/SURGE stock; the PZR has no authored stock.
    pub mass_change_kg: f64,
    pub energy_change_j: f64,
    pub tracer_change_kg_eq: f64,
    pub max_eos_row: f64,
    pub max_tree_rest_pa: f64,
    pub max_loop_rest_pa: f64,
    /// Largest phase-path pressure-gravity term of any face.
    pub max_phase_drive_pa: f64,
    /// Largest step from the nearest coordinate needed to reproduce a
    /// prepared pressure or specific internal energy exactly.
    pub representation_offset: usize,
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
    /// Finite values and the compiled cell's datum, roof and height.
    fn validate(&self, cell: &packet::PzrCell, settings: &Settings) -> Result<(), Failure> {
        let values = [
            self.pzr_roof_pressure_pa,
            self.pzr_roof_elevation_m,
            self.pzr_level_m,
            self.pzr_bottom_elevation_m,
        ];
        if !values.iter().all(|v| v.is_finite()) || self.pzr_roof_pressure_pa <= 0. {
            return Err(fatal(format!("invalid operating point {self:?}")));
        }
        if (self.pzr_bottom_elevation_m - cell.bottom_m).abs() > settings.level_match_m
            || (self.pzr_roof_elevation_m - cell.top_m).abs() > settings.level_match_m
        {
            return Err(fatal(format!(
                "declared PZR bottom {} m and roof {} m differ from the compiled cell {}..{} m",
                self.pzr_bottom_elevation_m, self.pzr_roof_elevation_m, cell.bottom_m, cell.top_m
            )));
        }
        if !(self.pzr_level_m > 0. && self.pzr_level_m < cell.top_m - cell.bottom_m) {
            return Err(fatal(format!(
                "level {} m lies outside the PZR {}..{} m",
                self.pzr_level_m, cell.bottom_m, cell.top_m
            )));
        }
        Ok(())
    }
}

/// Search order 0, 1, -1, 2, -2, ... up to `search` representable steps.
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

/// The coordinate nearest `target / scale` whose reconstruction
/// `y * scale` equals `target` exactly, with its step count.
fn coordinate(target: f64, scale: f64, search: usize) -> Option<(f64, usize)> {
    let start = target / scale;
    offsets(search)
        .map(|k| (adjacent(start, k), k.unsigned_abs() as usize))
        .find(|(y, _)| y * scale == target)
}

/// Mass and energy coordinates whose reconstruction gives a mass within the
/// search and exactly the specific internal energy `u`, as the network forms
/// `(y_U * s_U) / (y_M * s_M)`.
fn phase_coordinates(
    mass: f64,
    u: f64,
    [mass_scale, energy_scale]: [f64; 2],
    search: usize,
) -> Option<(f64, f64, usize)> {
    let start = mass / mass_scale;
    for dm in offsets(search) {
        let ym = adjacent(start, dm);
        let m = ym * mass_scale;
        if m.is_nan() || m <= 0. {
            continue;
        }
        let energy = m * u / energy_scale;
        if let Some((yu, du)) = offsets(search)
            .map(|k| (adjacent(energy, k), k))
            .find(|(yu, _)| yu * energy_scale / m == u)
        {
            return Some((ym, yu, dm.unsigned_abs().max(du.unsigned_abs()) as usize));
        }
    }
    None
}

/// Write the regular cells' coordinates of a `Network::new` layout in its
/// compiled scaling so that the network's reconstruction reproduces exactly
/// each stock's pressure and every present phase's specific internal energy;
/// the phase mass is reproduced within `search` representable steps, and
/// liquid tracer to rounding. The PZR block, impulse and rotor coordinates
/// are not touched, and the scales stay those compiled from the packet.
/// Refuses a stock without a present phase, energy without mass, tracer
/// without liquid, or a value no coordinate within `search` steps
/// reproduces. Returns what the network will reconstruct.
pub fn overwrite_stocks<P: Properties>(
    network: &Network<P>,
    y: &mut [f64],
    stocks: &[Stock],
    search: usize,
) -> Result<Vec<Written>, Failure> {
    if stocks.len() != network.cell_layout.len() || y.len() != network.dimension() {
        return Err(fatal("stock/coordinate layout mismatch"));
    }
    let scales = network.scales();
    let mut written = Vec::with_capacity(stocks.len());
    for (node, (layout, stock)) in network.cell_layout.iter().zip(stocks).enumerate() {
        let finite = [stock.pressure_pa, stock.tracer_kg_eq]
            .iter()
            .chain(&stock.mass_kg)
            .chain(&stock.specific_energy_j_kg)
            .all(|v| v.is_finite());
        if !finite
            || stock.pressure_pa <= 0.
            || stock.mass_kg.iter().any(|m| *m < 0.)
            || stock.mass_kg.iter().all(|m| *m == 0.)
            || stock
                .mass_kg
                .iter()
                .zip(&stock.specific_energy_j_kg)
                .any(|(m, u)| *m == 0. && *u != 0.)
            || stock.tracer_kg_eq < 0.
            || (stock.mass_kg[0] == 0. && stock.tracer_kg_eq != 0.)
        {
            return Err(fatal(format!(
                "region {node} stock {stock:?} is not physically present"
            )));
        }
        let unrepresentable = |what: &str| {
            fatal(format!(
                "region {node} {what} is not reproduced by any coordinate within {search} representable steps"
            ))
        };
        let (yp, mut offset) = coordinate(stock.pressure_pa, scales[layout.base], search)
            .ok_or_else(|| unrepresentable("pressure"))?;
        y[layout.base] = yp;
        let mut result = Written {
            pressure_pa: yp * scales[layout.base],
            mass_kg: [0.; 2],
            internal_energy_j: [0.; 2],
            tracer_kg_eq: 0.,
            offset: 0,
        };
        for k in 0..2 {
            let [mi, ui] = [layout.mass[k], layout.energy[k]];
            let (ym, yu) = if stock.mass_kg[k] == 0. {
                (0., 0.)
            } else {
                let (ym, yu, steps) = phase_coordinates(
                    stock.mass_kg[k],
                    stock.specific_energy_j_kg[k],
                    [scales[mi], scales[ui]],
                    search,
                )
                .ok_or_else(|| unrepresentable("specific internal energy"))?;
                offset = offset.max(steps);
                (ym, yu)
            };
            y[mi] = ym;
            y[ui] = yu;
            result.mass_kg[k] = ym * scales[mi];
            result.internal_energy_j[k] = yu * scales[ui];
        }
        y[layout.boron] = stock.tracer_kg_eq / scales[layout.boron];
        result.tracer_kg_eq = y[layout.boron] * scales[layout.boron];
        result.offset = offset;
        if !y[layout.base..layout.base + 6]
            .iter()
            .all(|v| v.is_finite())
        {
            return Err(fatal(format!("region {node} coordinate scaling")));
        }
        written.push(result);
    }
    Ok(written)
}

/// One regular cell's authored owner: liquid at its prepared specific
/// internal energy and tracer concentration.
struct Owner {
    specific_energy: f64,
    /// Liquid tracer per kg of liquid.
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

fn owners<P: Properties>(packet: &Packet, network: &Network<P>) -> Result<Vec<Owner>, Failure> {
    let surge = network.cell_layout.len() - 1;
    (0..network.cell_layout.len())
        .map(|node| {
            if network.cell_layout[node].phase != 0 {
                return Err(fatal(format!("primary/SURGE region {node} is not liquid")));
            }
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
            Ok(Owner {
                specific_energy: before.internal_energy_j / before.mass_kg,
                concentration: before.tracer_kg_eq / before.mass_kg,
                before,
            })
        })
        .collect()
}

/// A liquid cell at pressure `p`: its specific internal energy and caloric
/// point, recovered through the same inversion as the EOS row.
fn cell_state<P: Properties>(
    properties: &P,
    owner: &Owner,
    node: usize,
    pressure: f64,
) -> Result<(f64, Water), Failure> {
    let context = |e: String| fatal(format!("region {node} at {pressure} Pa: {e}"));
    let water = properties.values(
        &properties
            .caloric(false, pressure, owner.specific_energy, false)
            .map_err(context)?,
    );
    if !(water.density_kg_m3.is_finite() && water.density_kg_m3 > 0.) {
        return Err(context(format!("density {}", water.density_kg_m3)));
    }
    Ok((owner.specific_energy, water))
}

struct Tree {
    /// (face, known parent, child) in breadth-first order from the root.
    order: Vec<(usize, usize, usize)>,
    member: Vec<bool>,
}

/// Breadth-first spanning tree over the regular cells' faces in compiled
/// index order. Faces touching the PZR (`cells` and beyond) are not tree
/// faces; the port face fixes the root instead.
fn spanning_tree(faces: &[FacePacket], cells: usize, root: usize) -> Result<Tree, Failure> {
    let mut reached = vec![false; cells];
    reached[root] = true;
    let mut queue = VecDeque::from([root]);
    let mut order = Vec::with_capacity(cells - 1);
    let mut member = vec![false; faces.len()];
    while let Some(node) = queue.pop_front() {
        for (j, f) in faces.iter().enumerate() {
            if f.from >= cells || f.to >= cells {
                continue;
            }
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
            "region {node} is not connected to the PZR surge port"
        )));
    }
    Ok(Tree { order, member })
}

/// Mixture head of a face, `sum(rho_mix * g * dz)` in segment order.
fn head(face: &FacePacket, mixture: impl Fn(usize) -> f64) -> f64 {
    face.pressure_segments.iter().fold(0., |sum, segment| {
        sum + mixture(segment.region) * (G * segment.elevation_change_m)
    })
}

/// One hydrostatic pass: the root from the port face at rest, then every tree
/// face at rest, `p_to = p_from - head`.
fn integrate(
    faces: &[FacePacket],
    tree: &Tree,
    mixture: &[f64],
    root: usize,
    root_pressure: f64,
) -> Vec<f64> {
    let mut pressure = vec![0.; mixture.len()];
    pressure[root] = root_pressure;
    for &(j, parent, child) in &tree.order {
        let f = &faces[j];
        let h = head(f, |region| mixture[region]);
        pressure[child] = if child == f.to {
            pressure[parent] - h
        } else {
            pressure[parent] + h
        };
    }
    pressure
}

/// Mixture density of an evaluated cell exactly as `local_flow` forms it.
fn cell_mixture(cell: &Cell) -> f64 {
    cell.phase
        .iter()
        .flatten()
        .fold(0., |sum, p| sum + p.fraction.value * p.density.value)
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
    port_pressure_pa: f64,
    pzr: Value,
    pass_changes_pa: Vec<f64>,
    owners: Vec<Owner>,
    states: Vec<(f64, Water)>,
    written: Vec<Written>,
    tree: Tree,
}

/// The stratified cell owner's preparation at the declared point: the PZR
/// block written exactly into `y`, its surge-port pressure and its receipt.
pub struct StratifiedPreparation {
    pub port_pressure_pa: f64,
    pub receipt: Value,
}

impl<P: Properties> Network<P> {
    /// `stratified::prepare` at the declared roof pressure and level, written
    /// into `y` so that the network reconstructs exactly the roof pressure,
    /// every volume and every zone's `U/M`. The surge-port pressure is the
    /// written coordinates' own column at the port elevation.
    fn prepare_stratified(
        &self,
        point: &OperatingPoint,
        settings: &Settings,
        y: &mut [f64],
    ) -> Result<StratifiedPreparation, Failure> {
        let cell = &self.stratified;
        let preparation = cell.prepare(
            &self.properties,
            point.pzr_roof_pressure_pa,
            point.pzr_level_m,
            settings.pressure_tolerance_pa,
            settings.max_passes,
        )?;
        let range = self.pzr.coordinates();
        let scales: [f64; PZR_COORDINATES] = self.scales()[range.clone()]
            .try_into()
            .map_err(|_| fatal("PZR scale layout"))?;
        let written = stratified::Cell::coordinates(
            &preparation.values,
            &scales,
            settings.representation_search,
        )?;
        y[range].copy_from_slice(&written);
        let mut values = [0.; PZR_COORDINATES];
        for ((v, w), s) in values.iter_mut().zip(written).zip(scales) {
            *v = w * s;
        }
        // Representable steps of each written coordinate from the nearest
        // `value / scale` (all nonnegative), and the zones' exact U/M.
        let steps: Vec<u64> = written
            .iter()
            .zip(preparation.values.iter().zip(scales))
            .map(|(w, (v, s))| w.to_bits().abs_diff((v / s).to_bits()))
            .collect();
        let specific_energy_exact: Vec<bool> = PZR_MASS[..3]
            .iter()
            .zip(PZR_ENERGY)
            .map(|(m, e)| values[e] / values[*m] == preparation.values[e] / preparation.values[*m])
            .collect();
        let x = stratified::Coordinates::values(&values);
        let column = cell.column(&self.properties, &x, None)?;
        let port = cell
            .parameters()
            .ports
            .iter()
            .find(|p| p.face == Some(self.pzr.port_face))
            .ok_or_else(|| fatal("the port face has no PZR port"))?;
        let port_pressure_pa = column.pressure_at(port.elevation_m).value;
        let zone = |z: &stratified::Zone| json!({"pressure_pa":z.pressure.value,"temperature_k":z.temperature.value,"mass_kg":z.mass.value,"volume_m3":z.volume.value,"specific_energy_j_kg":z.specific_energy.value,"density_kg_m3":z.density.value});
        Ok(StratifiedPreparation {
            port_pressure_pa,
            receipt: json!({"prepared":preparation.values,"written":values,"representation_steps":steps,"specific_energy_exact":specific_energy_exact,"saturation_temperature_k":preparation.saturation_temperature_k,"pass_changes_pa":preparation.pass_changes_pa,"roof_pressure_pa":column.roof_pressure.value,"interface_pressure_pa":column.interface_pressure.value,"bottom_pressure_pa":column.bottom_pressure.value,"port_pressure_pa":port_pressure_pa,"mixture_level_m":column.mixture_elevation.value-column.bottom_m,"collapsed_level_m":column.collapsed_elevation.value-column.bottom_m,"admitted_thickness_m":column.admitted_thickness.value,"zones":{"vapor":zone(&column.vapor),"admitted":zone(&column.admitted),"resident":zone(&column.resident)}}),
        })
    }
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
    point.validate(&packet.pzr.cell, settings)?;
    let (mut network, mut prepared) = Network::new(
        packet,
        properties,
        &PzrPreparation {
            pressure_tolerance_pa: settings.pressure_tolerance_pa,
            max_passes: settings.max_passes,
        },
    )?;
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
    let pzr = network.prepare_stratified(point, settings, &mut prepared.y)?;
    let owners = owners(packet, &network)?;
    let faces = &packet.mechanics.faces;
    let cells = network.cell_layout.len();
    let port = &faces[network.pzr.port_face];
    let root = port.from;
    let tree = spanning_tree(faces, cells, root)?;
    let states_at = |pressure: &[f64]| {
        owners
            .iter()
            .enumerate()
            .map(|(node, owner)| cell_state(network.properties(), owner, node, pressure[node]))
            .collect::<Result<Vec<_>, _>>()
    };

    let mut pressure: Vec<f64> = owners.iter().map(|o| o.before.pressure_pa).collect();
    let mut pass_changes_pa = Vec::new();
    let states = loop {
        let mixture: Vec<f64> = states_at(&pressure)?
            .iter()
            .map(|(_, water)| water.density_kg_m3)
            .collect();
        let root_pressure = pzr.port_pressure_pa + head(port, |region| mixture[region]);
        let next = integrate(faces, &tree, &mixture, root, root_pressure);
        let (change, _) = largest(next.iter().zip(&pressure).map(|(a, b)| a - b));
        pass_changes_pa.push(change);
        pressure = next;
        if !change.is_finite() {
            return Err(fatal(format!("non-finite pass {pass_changes_pa:?}")));
        }
        if change <= settings.pressure_tolerance_pa {
            // The final states belong to the pressures the network will
            // reconstruct from its scaled coordinates.
            for (p, layout) in pressure.iter_mut().zip(&network.cell_layout) {
                let scale = network.scales()[layout.base];
                *p = *p / scale * scale;
            }
            break states_at(&pressure)?;
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
            let mass = network.volume(node) * water.density_kg_m3;
            Stock {
                pressure_pa: pressure[node],
                mass_kg: [mass, 0.],
                specific_energy_j_kg: [*u, 0.],
                tracer_kg_eq: mass * owner.concentration,
            }
        })
        .collect();
    let written = overwrite_stocks(
        &network,
        &mut prepared.y,
        &stocks,
        settings.representation_search,
    )?;
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
        port_pressure_pa: pzr.port_pressure_pa,
        pzr: pzr.receipt,
        pass_changes_pa,
        owners,
        states,
        written,
        tree,
    };
    let receipt = account(&network, packet, point, settings, construction)?;
    if !at_most(receipt.max_eos_row, settings.eos_row_bound) {
        return Err(fatal(format!(
            "EOS rows are not at round-off: {} > {}",
            receipt.max_eos_row, settings.eos_row_bound
        )));
    }
    if !at_most(receipt.max_tree_rest_pa, settings.tree_face_bound_pa) {
        return Err(fatal(format!(
            "tree faces are not at rest: {} Pa > {} Pa",
            receipt.max_tree_rest_pa, settings.tree_face_bound_pa
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
        port_pressure_pa,
        pzr,
        pass_changes_pa,
        owners,
        states,
        written,
        tree,
    } = construction;
    let rows = network.rows();
    let mut regions = Vec::with_capacity(owners.len());
    for (node, ((owner, (_, water)), stock)) in owners.iter().zip(&states).zip(&written).enumerate()
    {
        regions.push(RegionReceipt {
            region: node,
            id: packet.mechanics.regions[node].id.clone(),
            before: owner.before,
            pressure_pa: stock.pressure_pa,
            phases: [
                Some(PhaseState {
                    temperature_k: water.temperature_k,
                    mass_kg: stock.mass_kg[0],
                    internal_energy_j: stock.internal_energy_j[0],
                    volume_m3: stock.mass_kg[0] / water.density_kg_m3,
                }),
                None,
            ],
            tracer_kg_eq: stock.tracer_kg_eq,
            eos_row: rows[network.cell_layout[node].base].value,
        });
    }
    let before = |f: fn(&State) -> f64| regions.iter().map(|r| f(&r.before)).sum::<f64>();
    let after = |f: fn(&PhaseState) -> f64| {
        regions
            .iter()
            .flat_map(|r| r.phases.iter().flatten())
            .map(f)
            .sum::<f64>()
    };
    let cells: Vec<Cell> = (0..network.cells())
        .map(|node| network.cell(node))
        .collect();
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
            // The port face fixes the root: part of the construction.
            tree: tree.member[j] || j == network.pzr.port_face,
            rest_pa: cells[f.from].pressure.value
                - cells[f.to].pressure.value
                - head(f, |region| cell_mixture(&cells[region])),
            pressure_gravity_pa,
        });
    }
    let rest = |tree_face: bool| {
        largest(
            faces
                .iter()
                .filter(|f| f.tree == tree_face)
                .map(|f| f.rest_pa),
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
        "pzr pressure and volume",
        "pzr mass",
        "pzr energy",
        "pzr tracer",
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
    let base = network.pzr.base;
    classes[8].1.extend(base..base + PZR_ALGEBRAIC);
    classes[9].1.extend(PZR_MASS.iter().map(|o| base + o));
    classes[10].1.extend(PZR_ENERGY.iter().map(|o| base + o));
    classes[11].1.extend(PZR_TRACER.iter().map(|o| base + o));
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
        port_pressure_pa,
        pzr,
        pass_changes_pa,
        max_eos_row: largest(regions.iter().map(|r| r.eos_row)).0,
        mass_change_kg: after(|p| p.mass_kg) - before(|s| s.mass_kg),
        energy_change_j: after(|p| p.internal_energy_j) - before(|s| s.internal_energy_j),
        tracer_change_kg_eq: regions.iter().map(|r| r.tracer_kg_eq).sum::<f64>()
            - before(|s| s.tracer_kg_eq),
        max_tree_rest_pa: rest(true),
        max_loop_rest_pa: rest(false),
        representation_offset: written.iter().map(|w| w.offset).fold(0, usize::max),
        max_phase_drive_pa: largest(
            faces
                .iter()
                .flat_map(|f| f.pressure_gravity_pa.iter().flatten().copied()),
        )
        .0,
        regions,
        faces,
        initial_rows,
        rotor_states: (0..network.rotor_count())
            .map(|r| format!("{:?}", network.rotor_state(r)))
            .collect(),
    })
}

/// What a flowing preparation wrote and what it leaves unbalanced.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FlowReceipt {
    /// Largest pressure change of every pass.
    pub pass_changes_pa: Vec<f64>,
    /// Per face: liquid volume flow written (m3/s), its impulse (Pa s), the
    /// face's total liquid drive `Pi'` at the written state (Pa), and whether
    /// the face is a tree face (balanced by construction) or the port face.
    pub faces: Vec<FlowFace>,
    /// Largest |drive| over the tree faces: round-off by construction.
    pub max_tree_drive_pa: f64,
    /// Largest |drive| over the remaining faces: the cycles' imbalance at
    /// the transferred flows, left for physical settling.
    pub max_cycle_drive_pa: f64,
    /// Written minus the hydrostatic preparation's primary/SURGE stock.
    pub mass_change_kg: f64,
    pub energy_change_j: f64,
    pub tracer_change_kg_eq: f64,
    pub representation_offset: usize,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FlowFace {
    pub face: usize,
    pub tree: bool,
    pub port: bool,
    pub volume_flow_m3_s: f64,
    pub impulse_pa_s: f64,
    pub drive_pa: f64,
}

/// Memo §3 (B): the hydrostatic preparation extended to declared liquid
/// volume flows. `y` is a hydrostatically prepared state of `network`
/// ([`prepare`]): its PZR block and every regular cell's specific internal
/// energy and tracer concentration are kept. Each face's liquid impulse is
/// written as `I(rho) Q` from its supports' current liquid masses, each
/// rotor's angular momentum as given, and the regular cells' pressures are
/// integrated along the same spanning tree so that every tree face's total
/// drive (pressure, gravity, pump head and passive loss at those flows)
/// vanishes; the root SURGE follows the port face at rest. Density follows
/// pressure, so passes repeat to the settings' pressure tolerance. Cycle
/// faces keep their imbalance, reported, for physical settling. Nothing
/// else is solved: no flow is adjusted and no stock is balanced.
pub fn compose_flows<P: Properties>(
    network: &mut Network<P>,
    packet: &Packet,
    y: &mut [f64],
    port_pressure_pa: f64,
    volume_flows_m3_s: &[f64],
    rotor_momenta: &[f64],
    settings: &Settings,
) -> Result<FlowReceipt, Failure> {
    settings.validate()?;
    let faces = &packet.mechanics.faces;
    let cells = network.cell_layout.len();
    if y.len() != network.dimension()
        || volume_flows_m3_s.len() != faces.len()
        || rotor_momenta.len() != network.rotor_count()
        || volume_flows_m3_s
            .iter()
            .chain(rotor_momenta)
            .any(|v| !v.is_finite())
    {
        return Err(fatal("flowing preparation layout or values"));
    }
    let scales = network.scales().to_vec();
    let value = |y: &[f64], i: usize| y[i] * scales[i];
    // The hydrostatic preparation's own owners: specific energy and tracer
    // concentration of each regular cell's liquid.
    let mut before = [0.; 3];
    let mut owners = Vec::with_capacity(cells);
    for (node, l) in network.cell_layout.iter().enumerate() {
        let (m, u, b) = (
            value(y, l.mass[0]),
            value(y, l.energy[0]),
            value(y, l.boron),
        );
        if m.is_nan() || m <= 0. || value(y, l.mass[1]) != 0. {
            return Err(fatal(format!(
                "region {node} is not a prepared liquid cell"
            )));
        }
        before[0] += m;
        before[1] += u;
        before[2] += b;
        owners.push((u / m, b / m));
    }
    for (r, index) in network.rotor_index.clone().iter().enumerate() {
        y[*index] = rotor_momenta[r] / scales[*index];
    }
    let port = &faces[network.pzr.port_face];
    let root = port.from;
    let tree = spanning_tree(faces, cells, root)?;
    let mut pressure: Vec<f64> = network
        .cell_layout
        .iter()
        .map(|l| value(y, l.base))
        .collect();
    let mut pass_changes_pa = Vec::new();
    let mut written;
    loop {
        let states: Vec<Water> = owners
            .iter()
            .enumerate()
            .map(|(node, (u, _))| {
                let owner = Owner {
                    specific_energy: *u,
                    concentration: 0.,
                    before: State {
                        pressure_pa: pressure[node],
                        temperature_k: 0.,
                        mass_kg: 0.,
                        internal_energy_j: 0.,
                        tracer_kg_eq: 0.,
                    },
                };
                cell_state(network.properties(), &owner, node, pressure[node]).map(|(_, w)| w)
            })
            .collect::<Result<_, _>>()?;
        let stocks: Vec<Stock> = states
            .iter()
            .zip(&owners)
            .enumerate()
            .map(|(node, (water, (u, concentration)))| {
                let mass = network.volume(node) * water.density_kg_m3;
                Stock {
                    pressure_pa: pressure[node],
                    mass_kg: [mass, 0.],
                    specific_energy_j_kg: [*u, 0.],
                    tracer_kg_eq: mass * concentration,
                }
            })
            .collect();
        written = overwrite_stocks(network, y, &stocks, settings.representation_search)?;
        for (j, f) in faces.iter().enumerate() {
            let inertance: f64 = f
                .supports
                .iter()
                .map(|s| {
                    written[s.region].mass_kg[0] / network.volume(s.region)
                        * s.inverse_area_length_per_m
                })
                .sum();
            let liquid = network.face_layout[2 * j].index;
            let vapor = network.face_layout[2 * j + 1].index;
            y[liquid] = inertance * volume_flows_m3_s[j] / scales[liquid];
            y[vapor] = 0.;
        }
        let zero = vec![0.; y.len()];
        network
            .evaluate(0., y, &zero, None, 0., None)
            .map_err(|e| fatal(format!("the flowing state cannot be evaluated: {e:?}")))?;
        let mixture: Vec<f64> = (0..cells)
            .map(|node| cell_mixture(&network.cell(node)))
            .collect();
        let mut next = pressure.clone();
        next[root] = port_pressure_pa + head(port, |region| mixture[region]);
        for &(j, parent, child) in &tree.order {
            let f = &faces[j];
            let drive = network.face_drive(j, 0).value;
            // drive = p_from - p_to - head + force; hold head and force.
            let difference = pressure[f.from] - pressure[f.to] - drive;
            next[child] = if child == f.to {
                next[parent] - difference
            } else {
                next[parent] + difference
            };
        }
        let (change, _) = largest(next.iter().zip(&pressure).map(|(a, b)| a - b));
        pass_changes_pa.push(change);
        if !change.is_finite() {
            return Err(fatal(format!(
                "non-finite flowing pass {pass_changes_pa:?}"
            )));
        }
        let converged = change <= settings.pressure_tolerance_pa;
        if !converged && pass_changes_pa.len() == settings.max_passes {
            return Err(fatal(format!(
                "flowing passes did not converge to {} Pa: {pass_changes_pa:?}",
                settings.pressure_tolerance_pa
            )));
        }
        if converged {
            break;
        }
        for (p, (n, l)) in pressure
            .iter_mut()
            .zip(next.iter().zip(&network.cell_layout))
        {
            let scale = scales[l.base];
            *p = *n / scale * scale;
        }
    }
    let flow_faces: Vec<FlowFace> = faces
        .iter()
        .enumerate()
        .map(|(j, _)| FlowFace {
            face: j,
            tree: tree.member[j],
            port: j == network.pzr.port_face,
            volume_flow_m3_s: volume_flows_m3_s[j],
            impulse_pa_s: value(y, network.face_layout[2 * j].index),
            drive_pa: network.face_drive(j, 0).value,
        })
        .collect();
    let drive = |tree: bool| {
        largest(
            flow_faces
                .iter()
                .filter(|f| f.tree == tree && !f.port)
                .map(|f| f.drive_pa),
        )
        .0
    };
    let after = written.iter().fold([0.; 3], |a, w| {
        [
            a[0] + w.mass_kg[0],
            a[1] + w.internal_energy_j[0],
            a[2] + w.tracer_kg_eq,
        ]
    });
    Ok(FlowReceipt {
        max_tree_drive_pa: drive(true),
        max_cycle_drive_pa: drive(false),
        faces: flow_faces,
        pass_changes_pa,
        mass_change_kg: after[0] - before[0],
        energy_change_j: after[1] - before[1],
        tracer_change_kg_eq: after[2] - before[2],
        representation_offset: written.iter().map(|w| w.offset).fold(0, usize::max),
    })
}
