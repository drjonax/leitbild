//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0013-coarse-local-pressure.md#mechanical-ownership-and-terminology
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hydraulics.md#local-pressure-and-phase-path-impulse
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#actual-local-pressure-pilot-and-step-work-blocker
//! Composed coarse local-pressure network residual `F(t, y, y')`.
//!
//! Two cell kinds. Every regular compiled fluid volume retains liquid and
//! vapor mass/internal energy and liquid tracer, six coordinates; its
//! rigid-volume EOS row recovers the local pressure. The one stratified PZR
//! cell (decision 0014, contract amendment 3) retains seventeen coordinates
//! in the contract order: algebraic `p_roof, V_g, V_A, V_R, V_b, V_d`, then
//! differential `M_g, U_g, M_A, U_A, B_A, M_R, U_R, B_R, M_b, M_d, B_d`. Its
//! rows and its port views belong to the stratified cell owner, reached only
//! through the integration point below. Each phase path retains one
//! generalized hydraulic impulse `Pi = I*Q`. Pump rotors retain angular
//! momentum. Topology, volumes, supports, losses and ports come only from
//! the compiled owner packet; no index or coefficient of a particular plant
//! is hardcoded here. Signed Newton trials are evaluated without clipping;
//! physical admission is a separate account.
mod account;
mod evaluate;
pub mod heaters;
mod jacobian;
pub mod packet;
pub mod prepare;
pub mod properties;
pub mod stratified;
mod structure;
mod tolerance;

pub use account::{Tolerances, empty_energy_ratio};
pub use jacobian::{CscOut, DensePattern, SparseJacobian};
pub use properties::{Band, BandReport, MetastableBand, Properties, Reuse, Water};
pub use tolerance::ToleranceClasses;

use crate::{
    hydraulics::Section,
    local_flow::{Cell, Chart, Face, Phase},
    rotor,
    thermal::Scalar,
};
use serde_json::{Value, json};
use std::time::Instant;

/// Evaluation outcome distinguishing a refused Newton trial from a model error.
#[derive(Debug)]
pub enum Failure {
    /// Constitutive trial unavailable: the integrator may retry; never clip.
    Recoverable(String),
    /// A model/ownership error that no later successful evaluation can hide.
    Fatal(String),
}

/// Six coordinates of one regular cell: `p, M_l, U_l, M_g, U_g, B_l`.
#[derive(Clone, Copy, Debug)]
pub struct CellLayout {
    /// Phase present in the compiled preparation: 0 liquid, 1 vapor.
    pub phase: usize,
    pub base: usize,
    pub boron: usize,
    pub mass: [usize; 2],
    pub energy: [usize; 2],
}
/// Coordinates of the stratified PZR cell, in the contract order.
pub const PZR_COORDINATES: usize = stratified::COORDINATES;
/// Offsets within the PZR block: the algebraic roof pressure and volumes
/// `V_g, V_A, V_R, V_b, V_d`, then the differential masses `M_g, M_A, M_R,
/// M_b, M_d`, internal energies `U_g, U_A, U_R` and tracers `B_A, B_R, B_d`.
pub const PZR_PRESSURE: usize = stratified::ROOF_PRESSURE;
pub const PZR_VOLUME: [usize; 5] = [
    stratified::VAPOR_VOLUME,
    stratified::ADMITTED_VOLUME,
    stratified::RESIDENT_VOLUME,
    stratified::BUBBLE_VOLUME,
    stratified::DROP_VOLUME,
];
pub const PZR_ALGEBRAIC: usize = 6;
pub const PZR_MASS: [usize; 5] = [
    stratified::VAPOR_MASS,
    stratified::ADMITTED_MASS,
    stratified::RESIDENT_MASS,
    stratified::BUBBLE_MASS,
    stratified::DROP_MASS,
];
pub const PZR_ENERGY: [usize; 3] = [
    stratified::VAPOR_ENERGY,
    stratified::ADMITTED_ENERGY,
    stratified::RESIDENT_ENERGY,
];
pub const PZR_TRACER: [usize; 3] = [
    stratified::ADMITTED_BORON,
    stratified::RESIDENT_BORON,
    stratified::DROP_BORON,
];
// The network's algebraic block is exactly the cell's leading zero ids.
const _: () = {
    let mut i = 0;
    while i < PZR_COORDINATES {
        assert!((stratified::DIFFERENTIAL[i] == 0.) == (i < PZR_ALGEBRAIC));
        i += 1;
    }
};
/// The stratified PZR cell: its region index, first coordinate (the
/// algebraic roof pressure) and the one face ending at its surge port.
#[derive(Clone, Copy, Debug)]
pub struct PzrLayout {
    pub cell: usize,
    pub base: usize,
    pub port_face: usize,
}
impl PzrLayout {
    pub fn coordinates(&self) -> std::ops::Range<usize> {
        self.base..self.base + PZR_COORDINATES
    }
}
#[derive(Clone, Copy, Debug)]
pub struct FaceLayout {
    pub phase: usize,
    pub face: usize,
    pub index: usize,
}
struct Hydraulic {
    section: Section,
    region: usize,
    rotor: Option<usize>,
}

/// Discrete drive and shaft state of one rotor: part of the copyable Run
/// state. Declared explicitly by the caller; there is no default.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RotorState {
    pub support: rotor::Support,
    pub shaft: rotor::Shaft,
}

/// Wall-time and call counters, separated so callers can attribute cost.
#[derive(Clone, Copy, Debug, Default)]
pub struct Counters {
    pub evaluations: usize,
    pub evaluation_wall_s: f64,
    pub jacobians: usize,
    pub jacobian_wall_s: f64,
    /// Stratified columns evaluated, one per residual (each 3 inversions and
    /// 2 saturations).
    pub pzr_columns: usize,
}

/// Caller-declared numerical controls of the stratified cell's preparation
/// at the packet's operating point (`stratified::prepare`); none is defaulted.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct PzrPreparation {
    pub pressure_tolerance_pa: f64,
    pub max_passes: usize,
}

/// Initial coordinates compiled from the packet, in solver scaling.
pub struct Prepared {
    pub y: Vec<f64>,
    pub yp: Vec<f64>,
    /// 1 differential, 0 algebraic, as IDA's id vector.
    pub differential: Vec<f64>,
}

pub struct Network<P: Properties> {
    properties: P,
    faces: Vec<Face>,
    /// Regular cells, then the stratified PZR cell's port view (the last
    /// evaluation's state the port face reads at its mouth).
    cells: Vec<Cell>,
    /// Regular cells only, `0..pzr.cell`.
    pub cell_layout: Vec<CellLayout>,
    pub pzr: PzrLayout,
    /// The stratified cell owner's compiled model (decision 0014).
    stratified: stratified::Cell,
    /// Column of the last value evaluation, for taps and accounts.
    pzr_column: Option<stratified::Column>,
    /// Internal transfers and balance of the last value evaluation.
    pzr_evaluation: Option<stratified::Evaluation>,
    pub face_layout: Vec<FaceLayout>,
    volumes: Vec<f64>,
    sections: Vec<Hydraulic>,
    section_projection: Vec<(usize, usize, f64)>,
    section_drive: Vec<Scalar>,
    pub rotor_index: Vec<usize>,
    rotor_inertia: f64,
    drive: rotor::Parameters,
    rotor_states: Vec<Option<RotorState>>,
    motor: Vec<Option<rotor::Evaluation>>,
    charts: Vec<[Option<Chart>; 2]>,
    face_drive: Vec<[Scalar; 2]>,
    /// Per cell and phase: transported mass, enthalpy and tracer receipts.
    /// The PZR entry is the port receipt the stratified cell takes.
    receipts: Vec<[[Scalar; 3]; 2]>,
    rows: Vec<Scalar>,
    scales: Vec<f64>,
    leading_enthalpy: Vec<[Option<f64>; 2]>,
    leading_liquid_concentration: Vec<Option<f64>>,
    pub leading_births: Vec<Value>,
    pub first_mechanical_birth: Option<Value>,
    pub counters: Counters,
    shaft_power: Scalar,
    wall_budget: Option<(Instant, f64)>,
}

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn rec(v: f64, d: f64) -> Scalar {
    Scalar::new(v, d)
}
fn selected_phase(mass: Scalar) -> bool {
    mass.value != 0. || mass.direction != 0.
}
fn bad(reason: impl Into<String>) -> Failure {
    Failure::Fatal(reason.into())
}

impl<P: Properties> Network<P> {
    /// Compile the network from the owner packet. Returns the network and the
    /// prepared coordinates: regular cells exactly as authored (no
    /// rebalancing here), the PZR cell prepared at the packet's operating
    /// point under the caller's declared controls.
    pub fn new(
        packet: &packet::Packet,
        properties: P,
        pzr_preparation: &PzrPreparation,
    ) -> Result<(Self, Prepared), Failure> {
        let geometry = &packet.mechanics;
        let cell = &packet.pzr.cell;
        let cells_n = geometry.regions.len();
        let volumes: Vec<f64> = geometry.regions.iter().map(|r| r.volume_m3).collect();
        let pzr = cell.index;
        if pzr + 1 != cells_n || volumes[pzr] != cell.fluid_volume_m3 {
            return Err(bad(
                "the stratified PZR cell must be the last compiled region, with its fluid volume",
            ));
        }
        let surge = pzr
            .checked_sub(1)
            .ok_or_else(|| bad("SURGE must precede the PZR"))?;
        if packet.thermal.water.len() != surge || packet.water_boron_amount_kg_eq.len() < surge {
            return Err(bad("primary water owners must precede SURGE"));
        }
        let faces: Vec<Face> = geometry
            .faces
            .iter()
            .map(|f| Face {
                from: f.from,
                to: f.to,
                flow_area_m2: f.flow_area_m2,
                supports: f.supports.clone(),
                pressure_segments: f.pressure_segments.clone(),
            })
            .collect();
        for f in &faces {
            f.validate(cells_n).map_err(bad)?;
        }
        if !geometry.force_projection.is_empty() {
            return Err(bad(
                "no network region owns a nonpressure force; a force projection refuses",
            ));
        }
        // One surge port, whose face ends at the cell. The network composes
        // no spray or relief owner, so those ports refuse here. The PZR side
        // contributes its port view only: no support, segment or other face
        // touches the cell.
        let [port] = &cell.ports[..] else {
            return Err(bad("the stratified PZR cell needs exactly one port"));
        };
        let (stratified::PortKind::Surge, Some(port_face)) = (port.kind, port.face) else {
            return Err(bad(
                "the network composes only the surge port, with its face",
            ));
        };
        let touching: Vec<usize> = (0..faces.len())
            .filter(|j| faces[*j].from == pzr || faces[*j].to == pzr)
            .collect();
        if touching != [port_face]
            || faces[port_face].to != pzr
            || faces[port_face]
                .supports
                .iter()
                .any(|support| support.region == pzr)
            || faces[port_face]
                .pressure_segments
                .iter()
                .any(|segment| segment.region == pzr)
        {
            return Err(bad(
                "exactly the port face may enter the PZR, with SURGE supports and segments only",
            ));
        }
        let mut cell_layout = Vec::with_capacity(pzr);
        let mut physical = Vec::new();
        let mut scales = Vec::new();
        let mut differential = Vec::new();
        let mut initial_points = Vec::with_capacity(pzr);
        for node in 0..pzr {
            let (p, t, mass, u, b) = if node < surge {
                let v = &packet.thermal.water[node];
                (
                    v.pressure_pa,
                    v.temperature_k,
                    v.mass_kg,
                    v.energy_j,
                    packet.water_boron_amount_kg_eq[node],
                )
            } else {
                let v = &packet.external_ports.surge_stock;
                (
                    v.pressure_pa,
                    v.temperature_k,
                    v.mass_kg,
                    v.internal_energy_j,
                    v.absorber_tracer_kg_eq,
                )
            };
            initial_points.push(properties.forward(false, p, t).map_err(bad)?);
            let base = physical.len();
            cell_layout.push(CellLayout {
                phase: 0,
                base,
                boron: base + 5,
                mass: [base + 1, base + 3],
                energy: [base + 2, base + 4],
            });
            physical.extend([p, mass, u, 0., 0., b]);
            scales.extend([p, mass, u, mass, u, if b == 0. { mass * 0.001 } else { b }]);
            differential.extend([0., 1., 1., 1., 1., 1.]);
        }
        let compiled = properties.metastable_band().map_err(bad)?;
        if compiled != MetastableBand::from(&cell.metastable) {
            return Err(bad(format!(
                "packet pzr.cell.metastable {:?} differs from the property implementation's compiled band {compiled:?}",
                cell.metastable
            )));
        }
        let pzr_layout = PzrLayout {
            cell: pzr,
            base: physical.len(),
            port_face,
        };
        let stratified = stratified::Cell::new(cell.clone(), stratified::Case::nominal(cell))?;
        let values = stratified_preparation(packet, &stratified, &properties, pzr_preparation)?;
        scales.extend(pzr_scales(
            &values,
            cell.fluid_volume_m3,
            cell.absorber_mass_fraction,
        )?);
        physical.extend(values);
        differential.extend([0.; PZR_ALGEBRAIC]);
        differential.extend([1.; PZR_COORDINATES - PZR_ALGEBRAIC]);
        let mut cells = vec![
            Cell {
                pressure: s(0.),
                phase: [None; 2]
            };
            cells_n
        ];
        for node in 0..pzr {
            let l = cell_layout[node];
            let q = initial_points[node];
            cells[node].pressure = s(q.pressure_pa);
            cells[node].phase[l.phase] = Some(Phase {
                fraction: s(1.),
                density: s(q.density_kg_m3),
                enthalpy: s(q.enthalpy_j_kg),
                boron_concentration: s(physical[l.boron] / physical[l.mass[l.phase]]),
            });
        }
        let mut face_layout = Vec::with_capacity(2 * faces.len());
        for (j, f) in faces.iter().enumerate() {
            let reference_inertia = f.supports.iter().fold(0., |sum, support| {
                sum + initial_points[support.region].density_kg_m3
                    * support.inverse_area_length_per_m
            });
            for k in 0..2 {
                face_layout.push(FaceLayout {
                    phase: k,
                    face: j,
                    index: physical.len(),
                });
                physical.push(0.);
                scales.push(reference_inertia);
                differential.push(1.);
            }
        }
        let pump = &packet.hydraulics.pump;
        let drive = rotor::Parameters {
            inertia_kg_m2: pump.rotor_inertia_kg_m2,
            drag_nm_per_rad_s: pump.drag_nm_per_rad_s,
            reference_omega_rad_s: pump.reference_omega_rad_s,
            nominal_fluid_power_w: pump.nominal_fluid_power_w,
            tracking_time_s: pump.drive_tracking_time_s,
            torque_cap_factor: pump.drive_torque_cap_factor,
            efficiency: pump.drive_efficiency,
        };
        drive
            .validate()
            .map_err(|e| bad(format!("invalid compiled RCP drive: {e:?}")))?;
        let mut rotor_index = Vec::new();
        let mut sections = Vec::with_capacity(packet.hydraulics.sections.len());
        for h in &packet.hydraulics.sections {
            h.parameters
                .validate()
                .map_err(|e| bad(format!("invalid hydraulic section: {e:?}")))?;
            if h.region >= pzr {
                return Err(bad("liquid-carrier sections may not own the PZR cell"));
            }
            let rotor = h.parameters.pump.map(|_| {
                let index = physical.len();
                let reference = pump.rotor_inertia_kg_m2 * pump.reference_omega_rad_s;
                physical.push(reference);
                scales.push(reference);
                differential.push(1.);
                rotor_index.push(index);
                rotor_index.len() - 1
            });
            sections.push(Hydraulic {
                section: h.parameters,
                region: h.region,
                rotor,
            });
        }
        let mut section_projection = Vec::with_capacity(geometry.section_force_projection.len());
        for p in &geometry.section_force_projection {
            if p.face >= faces.len() || p.section >= sections.len() {
                return Err(bad("section projection face/section index"));
            }
            section_projection.push((p.face, p.section, p.coefficient));
        }
        let size = scales.len();
        let y: Vec<f64> = physical.iter().zip(&scales).map(|(v, s)| v / s).collect();
        let face_count = faces.len();
        let section_count = sections.len();
        Ok((
            Self {
                properties,
                faces,
                cells,
                cell_layout,
                pzr: pzr_layout,
                stratified,
                pzr_column: None,
                pzr_evaluation: None,
                face_layout,
                volumes,
                sections,
                section_projection,
                section_drive: vec![s(0.); section_count],
                rotor_states: vec![None; rotor_index.len()],
                motor: vec![None; rotor_index.len()],
                rotor_index,
                rotor_inertia: pump.rotor_inertia_kg_m2,
                drive,
                charts: vec![[None; 2]; face_count],
                face_drive: vec![[s(0.); 2]; face_count],
                receipts: vec![[[s(0.); 3]; 2]; cells_n],
                rows: vec![s(0.); size],
                scales,
                leading_enthalpy: vec![[None; 2]; pzr],
                leading_liquid_concentration: vec![None; pzr],
                leading_births: Vec::new(),
                first_mechanical_birth: None,
                counters: Counters::default(),
                shaft_power: s(0.),
                wall_budget: None,
            },
            Prepared {
                y,
                yp: vec![0.; size],
                differential,
            },
        ))
    }

    pub fn dimension(&self) -> usize {
        self.scales.len()
    }
    pub fn cells(&self) -> usize {
        self.cells.len()
    }
    pub fn face_count(&self) -> usize {
        self.faces.len()
    }
    pub fn scales(&self) -> &[f64] {
        &self.scales
    }
    /// Current residual rows (value and direction) of the last evaluation.
    pub fn rows(&self) -> &[Scalar] {
        &self.rows
    }
    pub fn face_drive(&self, face: usize, phase: usize) -> Scalar {
        self.face_drive[face][phase]
    }
    /// Phase-path chart of the last evaluation (flows, head), read-only.
    pub fn chart(&self, face: usize, phase: usize) -> Option<Chart> {
        self.charts[face][phase]
    }
    /// Cell state of the last evaluation (pressure, phase fractions), read-only.
    pub fn cell(&self, node: usize) -> Cell {
        self.cells[node]
    }
    pub fn volume(&self, node: usize) -> f64 {
        self.volumes[node]
    }
    pub fn pzr_cell(&self) -> usize {
        self.pzr.cell
    }
    pub fn rotor_inertia(&self) -> f64 {
        self.rotor_inertia
    }
    pub fn properties(&self) -> &P {
        &self.properties
    }
    /// Prospective campaign guard: evaluations fail Fatal after this wall time.
    pub fn set_wall_budget(&mut self, seconds: f64) {
        self.wall_budget = Some((Instant::now(), seconds));
    }
    /// Phase `k` mass and energy coordinates of a regular cell.
    pub fn stock_indices(&self, node: usize, k: usize) -> (usize, usize) {
        let l = self.cell_layout[node];
        (l.mass[k], l.energy[k])
    }
    /// Every retained mass and tracer coordinate, regular cells and the PZR:
    /// the stocks an integrator constrains to be nonnegative.
    pub fn nonnegative_stocks(&self) -> Vec<usize> {
        let mut stocks: Vec<usize> = self
            .cell_layout
            .iter()
            .flat_map(|l| [l.mass[0], l.mass[1], l.boron])
            .collect();
        stocks.extend(
            PZR_MASS
                .iter()
                .chain(&PZR_TRACER)
                .map(|offset| self.pzr.base + offset),
        );
        stocks.sort_unstable();
        stocks
    }
    fn get(&self, y: &[f64], seed: Option<&[f64]>, index: usize) -> Scalar {
        rec(
            y[index] * self.scales[index],
            seed.map_or(0., |d| d[index]) * self.scales[index],
        )
    }
    fn rate(&self, yp: &[f64], seed: Option<&[f64]>, cj: f64, index: usize) -> Scalar {
        rec(
            yp[index] * self.scales[index],
            seed.map_or(0., |d| d[index]) * cj * self.scales[index],
        )
    }
    /// Exact per-assembly reuse slots: every regular cell, then the
    /// stratified cell's two caloric nodes and two saturation points.
    pub fn reuse(&self) -> Reuse<P::Caloric> {
        Reuse::new(self.pzr.cell + 2, 2)
    }
    /// The stratified cell's reuse slots in [`Network::reuse`].
    fn pzr_slots(&self) -> stratified::Slots {
        stratified::Slots {
            vapor_and_resident: self.pzr.cell,
            admitted: self.pzr.cell + 1,
            interface: 0,
            boundary: 1,
        }
    }
    /// The stratified cell owner's compiled model.
    pub fn stratified(&self) -> &stratified::Cell {
        &self.stratified
    }
    /// Column of the last value evaluation.
    pub fn pzr_column(&self) -> Option<&stratified::Column> {
        self.pzr_column.as_ref()
    }
    /// Transfers and balance of the last value evaluation of the PZR rows.
    pub fn pzr_evaluation(&self) -> Option<&stratified::Evaluation> {
        self.pzr_evaluation.as_ref()
    }
    pub fn drive(&self) -> &rotor::Parameters {
        &self.drive
    }
    pub fn rotor_count(&self) -> usize {
        self.rotor_index.len()
    }
    pub fn rotor_state(&self, r: usize) -> Option<RotorState> {
        self.rotor_states[r]
    }
    /// Declare or change one rotor's discrete drive/shaft state (an event).
    pub fn set_rotor_state(&mut self, r: usize, state: RotorState) {
        self.rotor_states[r] = Some(state);
    }
    /// Last evaluated drive law of one rotor (motor torque, heats, branch).
    pub fn motor(&self, r: usize) -> Option<rotor::Evaluation> {
        self.motor[r]
    }
    /// Ideal seizure transaction: lock the shaft, set its retained angular
    /// momentum to zero in `y`, and return the one-time removed energy credit.
    pub fn seize(&mut self, r: usize, y: &mut [f64]) -> Result<rotor::Locking, Failure> {
        let state = self.rotor_states[r]
            .ok_or_else(|| bad("rotor state must be declared before seizure"))?;
        let index = self.rotor_index[r];
        let omega = y[index] * self.scales[index] / self.rotor_inertia;
        let locking = self
            .drive
            .lock(state.shaft, omega)
            .map_err(|e| bad(format!("seizure refused: {e:?}")))?;
        self.rotor_states[r] = Some(RotorState {
            support: state.support,
            shaft: locking.shaft,
        });
        y[index] = 0.;
        Ok(locking)
    }
    /// Current IDA id vector: a locked rotor's speed row is algebraic.
    pub fn differential(&self, prepared: &[f64]) -> Vec<f64> {
        let mut ids = prepared.to_vec();
        for (r, index) in self.rotor_index.iter().enumerate() {
            if matches!(
                self.rotor_states[r],
                Some(RotorState {
                    shaft: rotor::Shaft::Locked,
                    ..
                })
            ) {
                ids[*index] = 0.;
            }
        }
        ids
    }
    /// Prepared scope string for receipts: what this network does and omits.
    pub fn scope() -> Value {
        json!(
            "composed coarse local-pressure network: retained two-phase M/U/B in every regular volume with local EOS, one stratified PZR cell (decision 0014) reached through its port view, one generalized impulse per phase path, compiled liquid-carrier sections and finite rotors; primary/SURGE gas drag and interphase exchange are not composed; not a joined nuclear/thermal/SG plant"
        )
    }
}

impl<P: Properties> Network<P> {
    /// PT1, the LT pressures, levels and zone departures of the last value
    /// evaluation's column (`stratified::taps`).
    pub fn pzr_taps(&self) -> Result<stratified::Taps, Failure> {
        let column = self
            .pzr_column
            .as_ref()
            .ok_or_else(|| bad("the PZR taps need an evaluated column"))?;
        self.stratified.taps(&self.properties, column)
    }
    /// Band reports of the last value evaluation's vapor, A and R zone
    /// states from the property implementation: accepted states only.
    pub fn pzr_band_reports(&self) -> Result<[BandReport; 3], Failure> {
        let column = self
            .pzr_column
            .as_ref()
            .ok_or_else(|| bad("the PZR band reports need an evaluated column"))?;
        let report = |zone: &stratified::Zone, vapor: bool| -> Result<BandReport, Failure> {
            let point = self
                .properties
                .caloric(
                    vapor,
                    zone.pressure.value,
                    zone.specific_energy.value,
                    false,
                )
                .map_err(Failure::Recoverable)?;
            Ok(self.properties.band(&point))
        };
        Ok([
            report(&column.vapor, true)?,
            report(&column.admitted, false)?,
            report(&column.resident, false)?,
        ])
    }
}

/// Prepared physical PZR coordinates at the packet's operating point
/// (`stratified::prepare`), in the contract order. The roof pressure is the
/// declared one at the cell top.
fn stratified_preparation<P: Properties>(
    packet: &packet::Packet,
    cell: &stratified::Cell,
    properties: &P,
    controls: &PzrPreparation,
) -> Result<[f64; PZR_COORDINATES], Failure> {
    let point = &packet.preparation.operating_point;
    let parameters = cell.parameters();
    if point.pzr_roof_elevation_m != parameters.top_m
        || point.pzr_bottom_elevation_m != parameters.bottom_m
    {
        return Err(bad(format!(
            "declared PZR roof {} m and bottom {} m are not the compiled cell's {}..{} m",
            point.pzr_roof_elevation_m,
            point.pzr_bottom_elevation_m,
            parameters.bottom_m,
            parameters.top_m
        )));
    }
    Ok(cell
        .prepare(
            properties,
            point.pzr_roof_pressure_pa,
            point.pzr_level_m,
            controls.pressure_tolerance_pa,
            controls.max_passes,
        )?
        .values)
}

/// Solver scales of the PZR block per class (contract amendment 4): the
/// prepared roof pressure; each zone volume, mass and energy by its own
/// prepared value, so a prepared zone is exactly `y = 1`; the transit
/// volumes, zero at preparation, by the cell's fluid volume; transit masses
/// by their host zone's mass scale (bubbles by the vapor zone, drops by the
/// resident layer); and every tracer by its host mass scale times the
/// packet's absorber fraction. A zero zone volume or absorber fraction has
/// no declared scale class and refuses.
fn pzr_scales(
    values: &[f64; PZR_COORDINATES],
    fluid_volume_m3: f64,
    absorber_mass_fraction: f64,
) -> Result<[f64; PZR_COORDINATES], Failure> {
    if absorber_mass_fraction == 0. {
        return Err(bad("zero-absorber tracer scale has no declared class"));
    }
    let [vg, va, vr, vb, vd] = PZR_VOLUME;
    if [vg, va, vr].iter().any(|i| values[*i] == 0.) {
        return Err(bad("a zero prepared PZR zone volume has no declared scale"));
    }
    let mut scales = *values;
    scales[vb] = fluid_volume_m3;
    scales[vd] = fluid_volume_m3;
    let [mg, ma, mr, mb, md] = PZR_MASS;
    scales[mb] = values[mg];
    scales[md] = values[mr];
    for (tracer, host) in PZR_TRACER.into_iter().zip([ma, mr, md]) {
        scales[tracer] = scales[host] * absorber_mass_fraction;
    }
    if scales.iter().any(|v| !v.is_finite() || *v <= 0.) {
        return Err(bad(format!(
            "prepared PZR coordinates give a nonpositive scale: {scales:?}"
        )));
    }
    Ok(scales)
}
