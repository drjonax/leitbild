//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0013-coarse-local-pressure.md#mechanical-ownership-and-terminology
//! spec: world/packs/process-plant/reference-designs/ld-01/model/computational-design-review.md#pressure-realization-approved-10-october (exit 3: a consistent initial pair)
//! EOS-consistent hydrostatic preparation of the composed network at a
//! declared operating point. This is a deterministic construction of one
//! prepared state, not an iterative plant solver:
//!
//! 1. Phases. Primary and SURGE volumes hold liquid. The declared surface,
//!    bottom datum plus level, either coincides with a PZR region boundary
//!    (within `level_match_m`): a sharp interface between saturated liquid
//!    below and saturated vapor above. Or it lies strictly inside one band,
//!    whose regions then hold both saturated phases, liquid below and vapor
//!    above the surface, with vapor volume `V*(top-surface)/(top-bottom)`.
//!    Every phase is saturated at its region's local pressure. A surface
//!    outside the PZR is refused.
//! 2. Pressures. Integrate hydrostatically from the declared roof gauge along
//!    a breadth-first spanning tree of the compiled faces, with each face's
//!    authored pressure segments and the fraction-weighted mixture density of
//!    each segment region: the well-balanced head of `local_flow`, so every
//!    tree face's mixture remainder vanishes at rest to round-off. Density
//!    depends on pressure, so passes repeat to an explicit fixed-point
//!    tolerance. Primary/SURGE liquid keeps its prepared specific internal
//!    energy, so its mass becomes `V * rho(p, u)`. Liquid tracer keeps the
//!    prepared concentration of its region, or, for a region prepared as
//!    vapor, that of the liquid region directly below it.
//! 3. Reported, never zeroed: a loop face's mixture remainder (with
//!    nonuniform temperature, the physical buoyancy drive) and, in a
//!    two-phase band, each phase path's relative buoyancy. The coarse band
//!    is a mixture region, not a resolved stratified surface, so its liquid
//!    is driven toward the band below and its vapor toward the band above.
//! 4. The stocks overwrite the coordinates compiled by `Network::new` (see
//!    [`overwrite_stocks`]) so that the network reconstructs exactly the
//!    prepared pressure and specific internal energies: a saturated phase
//!    lies on the bound of its stable property branch, where one rounding of
//!    `U/M` would cross it. Impulses stay zero and rotor angular momenta stay
//!    exactly as compiled; the caller declares every rotor's drive/shaft
//!    state, which the network requires. The network then evaluates
//!    `F(0, y, 0)` itself for the receipt: its EOS rows, cells and face
//!    charts, not a second implementation of its equations.
use super::{
    Failure, Network, Prepared, Properties, RotorState, Water,
    packet::{self, FacePacket, Packet},
};
use crate::{local_flow::Cell, thermal::Scalar};
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
    /// Indicated liquid height above `pzr_bottom_elevation_m`.
    pub pzr_level_m: f64,
    /// Declared PZR bottom datum; it must be the lowest compiled region bottom.
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
    /// A surface this close to a region boundary is that boundary; also the
    /// datum agreement bound. Below half of every region height.
    pub level_match_m: f64,
    /// Accept only if every evaluated EOS row is at most this.
    pub eos_row_bound: f64,
    /// Accept only if every tree face's mixture remainder is at most this.
    pub tree_face_bound_pa: f64,
    /// Adjacent representable coordinates tried on each side when writing an
    /// exactly reconstructed pressure or specific internal energy.
    pub representation_search: usize,
}

/// One cell's prepared stock, liquid then vapor. A zero-mass phase is
/// exactly absent and carries zero specific internal energy.
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
    /// Temperature minus saturation at the local pressure (PZR phases).
    pub saturation_margin_k: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RegionReceipt {
    pub region: usize,
    pub id: String,
    pub authored_phase: usize,
    pub before: State,
    pub pressure_pa: f64,
    /// Prepared vapor volume fraction: 0 liquid, 1 vapor, else two-phase.
    pub vapor_fraction: f64,
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
    /// own evaluated cells, as in `local_flow`.
    pub rest_pa: f64,
    /// The network chart's pressure-gravity term per phase path, including
    /// relative buoyancy in a two-phase region; `None` without phase inertia.
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
    pub root_region: usize,
    pub surface_elevation_m: f64,
    /// The surface is a region boundary (sharp interface).
    pub on_boundary: bool,
    /// Largest pressure change of every hydrostatic pass.
    pub pass_changes_pa: Vec<f64>,
    pub regions: Vec<RegionReceipt>,
    pub faces: Vec<FaceReceipt>,
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
    fn validate(&self) -> Result<(), Failure> {
        let values = [
            self.pzr_roof_pressure_pa,
            self.pzr_roof_elevation_m,
            self.pzr_level_m,
            self.pzr_bottom_elevation_m,
        ];
        if !values.iter().all(|v| v.is_finite()) || self.pzr_roof_pressure_pa <= 0. {
            return Err(fatal(format!("invalid operating point {self:?}")));
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

/// Write the cell coordinates of a `Network::new` layout in its compiled
/// scaling so that the network's reconstruction reproduces exactly each
/// stock's pressure and every present phase's specific internal energy; the
/// phase mass is reproduced within `search` representable steps, and liquid
/// tracer to rounding. Impulse and rotor coordinates are not touched, and
/// the scales stay those compiled from the packet. Refuses a stock without a
/// present phase, energy without mass, tracer without liquid, or a value no
/// coordinate within `search` steps reproduces. Returns what the network
/// will reconstruct.
pub fn overwrite_stocks<P: Properties>(
    network: &Network<P>,
    y: &mut [f64],
    stocks: &[Stock],
    search: usize,
) -> Result<Vec<Written>, Failure> {
    if stocks.len() != network.cells() || y.len() != network.dimension() {
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

enum Content {
    /// Primary/SURGE liquid at its prepared specific internal energy, J/kg.
    Liquid { specific_energy: f64 },
    /// PZR region: saturated phases at the local pressure with this vapor
    /// volume fraction (0 liquid, 1 vapor, between: a two-phase band).
    Saturated { vapor_fraction: f64 },
}

struct Owner {
    content: Content,
    authored_phase: usize,
    /// Liquid tracer per kg of liquid; zero without liquid.
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

struct Interface {
    surface_m: f64,
    on_boundary: bool,
    /// Vapor volume fraction of every PZR region, local order.
    vapor_fraction: Vec<f64>,
}

/// The declared surface and the vapor volume fraction of every PZR region.
fn interface(
    packet: &Packet,
    point: &OperatingPoint,
    settings: &Settings,
) -> Result<Interface, Failure> {
    let regions = &packet.pzr.regions;
    let bottom = regions
        .iter()
        .map(|r| r.bottom_m)
        .fold(f64::INFINITY, f64::min);
    let top = regions
        .iter()
        .map(|r| r.top_m)
        .fold(f64::NEG_INFINITY, f64::max);
    let lowest = regions
        .iter()
        .map(|r| r.top_m - r.bottom_m)
        .fold(f64::INFINITY, f64::min);
    if !(bottom.is_finite() && top.is_finite() && lowest > 2. * settings.level_match_m) {
        return Err(fatal(
            "level_match_m must stay below half of every PZR region height",
        ));
    }
    if (point.pzr_bottom_elevation_m - bottom).abs() > settings.level_match_m {
        return Err(fatal(format!(
            "declared PZR bottom datum {} m differs from the lowest compiled region bottom {bottom} m",
            point.pzr_bottom_elevation_m
        )));
    }
    let requested = point.pzr_bottom_elevation_m + point.pzr_level_m;
    if !(requested >= bottom - settings.level_match_m && requested <= top + settings.level_match_m)
    {
        return Err(fatal(format!(
            "level {} m puts the surface at {requested} m, outside the PZR {bottom}..{top} m",
            point.pzr_level_m
        )));
    }
    let nearest = regions
        .iter()
        .flat_map(|r| [r.bottom_m, r.top_m])
        .fold(bottom, |best, b| {
            if (b - requested).abs() < (best - requested).abs() {
                b
            } else {
                best
            }
        });
    let on_boundary = (nearest - requested).abs() <= settings.level_match_m;
    let surface_m = if on_boundary { nearest } else { requested };
    let vapor_fraction = regions
        .iter()
        .map(|r| {
            if r.top_m <= surface_m + settings.level_match_m {
                0.
            } else if r.bottom_m >= surface_m - settings.level_match_m {
                1.
            } else {
                (r.top_m - surface_m) / (r.top_m - r.bottom_m)
            }
        })
        .collect();
    Ok(Interface {
        surface_m,
        on_boundary,
        vapor_fraction,
    })
}

/// Liquid tracer concentration of every PZR region holding liquid, resolved
/// bottom-up: its own prepared value, or for a region prepared as vapor the
/// value of the liquid region directly below it (top equals its bottom).
fn pzr_concentrations(
    packet: &Packet,
    authored_phase: &[usize],
    vapor_fraction: &[f64],
    settings: &Settings,
) -> Result<Vec<f64>, Failure> {
    let regions = &packet.pzr.regions;
    let mut order: Vec<usize> = (0..regions.len()).collect();
    order.sort_by(|a, b| regions[*a].bottom_m.total_cmp(&regions[*b].bottom_m));
    let mut concentration: Vec<Option<f64>> = vec![None; regions.len()];
    for j in order {
        let r = &regions[j];
        concentration[j] = Some(if vapor_fraction[j] == 1. {
            0.
        } else if authored_phase[j] == 0 {
            r.absorber_tracer_kg_eq / r.mass_kg
        } else {
            let below: Vec<usize> = packet
                .pzr
                .faces
                .iter()
                .filter_map(|f| match (f.from == j, f.to == j) {
                    (true, _) => Some(f.to),
                    (_, true) => Some(f.from),
                    _ => None,
                })
                .filter(|&i| (regions[i].top_m - r.bottom_m).abs() <= settings.level_match_m)
                .collect();
            match below[..] {
                [i] if vapor_fraction[i] < 1. => concentration[i].ok_or_else(|| {
                    fatal(format!("PZR region {i} concentration unresolved below {j}"))
                })?,
                _ => {
                    return Err(fatal(format!(
                        "PZR region {j} holds liquid at the declared level but was prepared as vapor, and no single liquid region lies directly below it to give a prepared liquid tracer concentration"
                    )));
                }
            }
        });
    }
    concentration
        .into_iter()
        .map(|c| c.ok_or_else(|| fatal("unresolved PZR concentration")))
        .collect()
}

fn owners<P: Properties>(
    packet: &Packet,
    network: &Network<P>,
    interface: &Interface,
    settings: &Settings,
) -> Result<Vec<Owner>, Failure> {
    let begin = network.pzr_begin();
    let authored_phase: Vec<usize> = network.cell_layout.iter().map(|l| l.phase).collect();
    let concentration = pzr_concentrations(
        packet,
        &authored_phase[begin..],
        &interface.vapor_fraction,
        settings,
    )?;
    let mut owners = Vec::with_capacity(network.cells());
    for (node, &phase) in authored_phase.iter().enumerate() {
        let owner = if node < begin {
            let before = if node + 1 < begin {
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
            if phase != 0 {
                return Err(fatal(format!("primary/SURGE region {node} is not liquid")));
            }
            Owner {
                content: Content::Liquid {
                    specific_energy: before.internal_energy_j / before.mass_kg,
                },
                authored_phase: phase,
                concentration: before.tracer_kg_eq / before.mass_kg,
                before,
            }
        } else {
            let j = node - begin;
            let r = &packet.pzr.regions[j];
            let energy = if phase == 0 {
                r.liquid_energy_j
            } else {
                r.vapor_energy_j
            }
            .ok_or_else(|| fatal(format!("PZR region {j} lacks its authored phase energy")))?;
            Owner {
                content: Content::Saturated {
                    vapor_fraction: interface.vapor_fraction[j],
                },
                authored_phase: phase,
                concentration: concentration[j],
                before: authored(
                    r.common_pressure_pa,
                    r.water.temperature_k,
                    r.mass_kg,
                    energy,
                    r.absorber_tracer_kg_eq,
                )?,
            }
        };
        owners.push(owner);
    }
    Ok(owners)
}

/// Present phases of one cell at pressure `p`: specific internal energy and
/// caloric point, recovered through the same inversion as the EOS row, the
/// phase volume fractions and the fraction-weighted mixture density.
struct CellState {
    phases: [Option<(f64, Water)>; 2],
    fraction: [f64; 2],
    mixture: f64,
}

fn cell_state<P: Properties>(
    properties: &P,
    owner: &Owner,
    node: usize,
    pressure: f64,
) -> Result<CellState, Failure> {
    let context = |e: String| fatal(format!("region {node} at {pressure} Pa: {e}"));
    let recover = |vapor: bool, u: f64| -> Result<(f64, Water), Failure> {
        let water = properties.values(
            &properties
                .caloric(vapor, pressure, u, false)
                .map_err(context)?,
        );
        if !(water.density_kg_m3.is_finite() && water.density_kg_m3 > 0.) {
            return Err(context(format!("density {}", water.density_kg_m3)));
        }
        Ok((u, water))
    };
    let (phases, fraction) = match owner.content {
        Content::Liquid { specific_energy } => {
            ([Some(recover(false, specific_energy)?), None], [1., 0.])
        }
        Content::Saturated { vapor_fraction } => {
            let saturation = properties
                .saturation(Scalar::constant(pressure))
                .map_err(context)?
                .temperature
                .value;
            let mut phases = [None; 2];
            for (k, present) in [vapor_fraction < 1., vapor_fraction > 0.]
                .into_iter()
                .enumerate()
            {
                if present {
                    let vapor = k == 1;
                    let u = properties
                        .forward(vapor, pressure, saturation)
                        .map_err(context)?
                        .internal_energy_j_kg;
                    phases[k] = Some(recover(vapor, u)?);
                }
            }
            (phases, [1. - vapor_fraction, vapor_fraction])
        }
    };
    let mixture = phases
        .iter()
        .zip(fraction)
        .fold(0., |sum, (phase, f)| match phase {
            Some((_, water)) => sum + f * water.density_kg_m3,
            None => sum,
        });
    Ok(CellState {
        phases,
        fraction,
        mixture,
    })
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

/// Mixture head of a face, `sum(rho_mix * g * dz)` in segment order.
fn head(face: &FacePacket, mixture: impl Fn(usize) -> f64) -> f64 {
    face.pressure_segments.iter().fold(0., |sum, segment| {
        sum + mixture(segment.region) * (G * segment.elevation_change_m)
    })
}

/// One hydrostatic pass: root from the roof gauge, then every tree face at
/// rest, `p_to = p_from - head`.
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
    interface: Interface,
    pass_changes_pa: Vec<f64>,
    owners: Vec<Owner>,
    states: Vec<CellState>,
    written: Vec<Written>,
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
    let interface = interface(packet, point, settings)?;
    let owners = owners(packet, &network, &interface, settings)?;
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
        let mixture: Vec<f64> = states_at(&pressure)?.iter().map(|s| s.mixture).collect();
        let root_pressure = point.pzr_roof_pressure_pa + mixture[root] * (G * roof_leg);
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
        .map(|(node, (state, owner))| {
            let volume = network.volume(node);
            let vapor_volume = volume * state.fraction[1];
            let volumes = [volume - vapor_volume, vapor_volume];
            let mut stock = Stock {
                pressure_pa: pressure[node],
                mass_kg: [0.; 2],
                specific_energy_j_kg: [0.; 2],
                tracer_kg_eq: 0.,
            };
            for (k, phase) in state.phases.iter().enumerate() {
                if let Some((u, water)) = phase {
                    stock.mass_kg[k] = volumes[k] * water.density_kg_m3;
                    stock.specific_energy_j_kg[k] = *u;
                }
            }
            stock.tracer_kg_eq = stock.mass_kg[0] * owner.concentration;
            stock
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
        interface,
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
        interface,
        pass_changes_pa,
        owners,
        states,
        written,
        tree,
    } = construction;
    let rows = network.rows();
    let mut regions = Vec::with_capacity(owners.len());
    for (node, ((owner, state), stock)) in owners.iter().zip(&states).zip(&written).enumerate() {
        let saturation = match owner.content {
            Content::Liquid { .. } => None,
            Content::Saturated { .. } => Some(
                network
                    .properties()
                    .saturation(Scalar::constant(stock.pressure_pa))
                    .map_err(fatal)?
                    .temperature
                    .value,
            ),
        };
        let mut phases = [None; 2];
        for (k, phase) in state.phases.iter().enumerate() {
            if let Some((_, water)) = phase {
                phases[k] = Some(PhaseState {
                    temperature_k: water.temperature_k,
                    mass_kg: stock.mass_kg[k],
                    internal_energy_j: stock.internal_energy_j[k],
                    volume_m3: stock.mass_kg[k] / water.density_kg_m3,
                    saturation_margin_k: saturation.map(|t| water.temperature_k - t),
                });
            }
        }
        regions.push(RegionReceipt {
            region: node,
            id: packet.mechanics.regions[node].id.clone(),
            authored_phase: owner.authored_phase,
            before: owner.before,
            pressure_pa: stock.pressure_pa,
            vapor_fraction: state.fraction[1],
            phases,
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
            tree: tree.member[j],
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
        surface_elevation_m: interface.surface_m,
        on_boundary: interface.on_boundary,
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
