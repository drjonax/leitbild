//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0013-coarse-local-pressure.md#mechanical-ownership-and-terminology
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hydraulics.md#local-pressure-and-phase-path-impulse
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#actual-local-pressure-pilot-and-step-work-blocker
//! Composed coarse local-pressure network residual `F(t, y, y')`.
//!
//! Every compiled fluid volume retains liquid and vapor mass/internal energy
//! and liquid tracer; its rigid-volume EOS row recovers the local pressure.
//! Each phase path retains one generalized hydraulic impulse `Pi = I*Q`.
//! Pump rotors retain angular momentum. Topology, volumes, supports, losses
//! and projections come only from the compiled owner packet; no index or
//! coefficient of a particular plant is hardcoded here. Signed Newton trials
//! are evaluated without clipping; physical admission is a separate account.
mod account;
mod evaluate;
mod jacobian;
pub mod packet;
pub mod properties;
mod structure;
mod tolerance;

pub use account::{Tolerances, empty_energy_ratio};
pub use jacobian::{CscOut, DensePattern, SparseJacobian};
pub use properties::{Properties, Reuse, Water};
pub use tolerance::ToleranceClasses;

use crate::{
    hydraulics::Section,
    local_flow::{Cell, Chart, Face, ForceProjection, Phase},
    pzr_field as pf, rotor,
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

#[derive(Clone, Copy, Debug)]
pub struct CellLayout {
    /// Phase present in the compiled preparation: 0 liquid, 1 vapor.
    pub phase: usize,
    pub base: usize,
    pub boron: usize,
    pub mass: [usize; 2],
    pub energy: [usize; 2],
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
    projections: Vec<Vec<ForceProjection>>,
    cells: Vec<Cell>,
    pub cell_layout: Vec<CellLayout>,
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
    field: pf::Model,
    work: pf::Work,
    pzr_begin: usize,
    first_pzr_face: usize,
    surge_to_pzr_face: usize,
    charts: Vec<[Option<Chart>; 2]>,
    face_drive: Vec<[Scalar; 2]>,
    velocity: [Vec<[Scalar; 2]>; 2],
    receipts: Vec<[[Scalar; 3]; 2]>,
    forces: Vec<[Scalar; 2]>,
    rows: Vec<Scalar>,
    scales: Vec<f64>,
    leading_enthalpy: Vec<[Option<f64>; 2]>,
    leading_liquid_concentration: Vec<Option<f64>>,
    pub leading_births: Vec<Value>,
    pub first_source_failure: Option<Value>,
    pub last_source_failure: Option<Value>,
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
    /// prepared coordinates exactly as authored (no rebalancing here).
    pub fn new(packet: &packet::Packet, properties: P) -> Result<(Self, Prepared), Failure> {
        let geometry = &packet.mechanics;
        let cells_n = geometry.regions.len();
        let volumes: Vec<f64> = geometry.regions.iter().map(|r| r.volume_m3).collect();
        let pzr_begin = geometry
            .regions
            .iter()
            .position(|r| r.id.starts_with("PZR."))
            .ok_or_else(|| bad("packet has no PZR region"))?;
        if geometry.regions[pzr_begin..]
            .iter()
            .any(|r| !r.id.starts_with("PZR."))
            || cells_n - pzr_begin != pf::REGIONS
            || packet.pzr.regions.len() != pf::REGIONS
            || packet.pzr.faces.len() != pf::FACES
        {
            return Err(bad("PZR regions must be the contiguous compiled tail"));
        }
        let surge = pzr_begin
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
        let first_pzr_face = faces
            .iter()
            .position(|f| f.from >= pzr_begin && f.to >= pzr_begin)
            .ok_or_else(|| bad("no PZR internal face"))?;
        if faces.len() - first_pzr_face != pf::FACES
            || faces[first_pzr_face..]
                .iter()
                .zip(&packet.pzr.faces)
                .any(|(f, p)| f.from - pzr_begin != p.from || f.to - pzr_begin != p.to)
            || faces[..first_pzr_face]
                .iter()
                .any(|f| f.from >= pzr_begin && f.to >= pzr_begin)
        {
            return Err(bad("PZR internal faces must match the PZR field order"));
        }
        let inflow: Vec<usize> = (0..first_pzr_face)
            .filter(|j| faces[*j].from < pzr_begin && faces[*j].to >= pzr_begin)
            .collect();
        let [surge_to_pzr_face] = inflow[..] else {
            return Err(bad("exactly one external face must enter the PZR"));
        };
        if faces[..first_pzr_face]
            .iter()
            .any(|f| f.from >= pzr_begin && f.to < pzr_begin)
        {
            return Err(bad(
                "an external face may not leave the PZR toward the primary",
            ));
        }
        let mut projections = vec![Vec::new(); faces.len()];
        for p in &geometry.force_projection {
            projections
                .get_mut(p.face)
                .ok_or_else(|| bad("force projection face index"))?
                .push(ForceProjection {
                    region: p.region,
                    coefficient_per_m2: p.coefficient_per_m2,
                    normal: p.normal,
                });
        }
        let mut cell_layout = Vec::with_capacity(cells_n);
        let mut physical = Vec::new();
        let mut scales = Vec::new();
        let mut differential = Vec::new();
        let mut initial_points = Vec::with_capacity(cells_n);
        for node in 0..cells_n {
            let (p, t, mass, u, b, k) = if node < surge {
                let v = &packet.thermal.water[node];
                (
                    v.pressure_pa,
                    v.temperature_k,
                    v.mass_kg,
                    v.energy_j,
                    packet.water_boron_amount_kg_eq[node],
                    0,
                )
            } else if node == surge {
                let v = &packet.external_ports.surge_stock;
                (
                    v.pressure_pa,
                    v.temperature_k,
                    v.mass_kg,
                    v.internal_energy_j,
                    v.absorber_tracer_kg_eq,
                    0,
                )
            } else {
                let v = &packet.pzr.regions[node - pzr_begin];
                let k = match v.initial_phase.as_str() {
                    "liquid" => 0,
                    "vapor" => 1,
                    _ => return Err(bad("PZR initial phase must be liquid or vapor")),
                };
                let energy = if k == 0 {
                    v.liquid_energy_j
                } else {
                    v.vapor_energy_j
                }
                .ok_or_else(|| bad("PZR region lacks its prepared phase energy"))?;
                (
                    v.common_pressure_pa,
                    v.water.temperature_k,
                    v.mass_kg,
                    energy,
                    v.absorber_tracer_kg_eq,
                    k,
                )
            };
            initial_points.push(properties.forward(k == 1, p, t).map_err(bad)?);
            let base = physical.len();
            cell_layout.push(CellLayout {
                phase: k,
                base,
                boron: base + 5,
                mass: [base + 1, base + 3],
                energy: [base + 2, base + 4],
            });
            physical.extend([
                p,
                if k == 0 { mass } else { 0. },
                if k == 0 { u } else { 0. },
                if k == 1 { mass } else { 0. },
                if k == 1 { u } else { 0. },
                b,
            ]);
            scales.extend([p, mass, u, mass, u, if b == 0. { mass * 0.001 } else { b }]);
            differential.extend([0., 1., 1., 1., 1., 1.]);
        }
        let mut cells = vec![
            Cell {
                pressure: s(0.),
                phase: [None; 2]
            };
            cells_n
        ];
        for node in 0..cells_n {
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
            if h.region >= pzr_begin {
                return Err(bad("liquid-carrier sections may not own PZR regions"));
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
            if p.face >= first_pzr_face || p.section >= sections.len() {
                return Err(bad("section projections must target non-PZR faces"));
            }
            section_projection.push((p.face, p.section, p.coefficient));
        }
        let regions: [pf::Region; pf::REGIONS] = std::array::from_fn(|j| {
            let v = &packet.pzr.regions[j];
            pf::Region {
                volume_m3: v.volume_m3,
                axial_area_m2: v.axial_area_m2,
                height_m: v.top_m - v.bottom_m,
                solid_perimeter_m: v.solid_perimeter_m,
                elevation_m: v.elevation_m,
            }
        });
        let field_faces: [pf::Face; pf::FACES] = std::array::from_fn(|j| {
            let v = &packet.pzr.faces[j];
            pf::Face {
                from: v.from,
                to: v.to,
                area_m2: v.area_m2,
                distance_m: v.distance_m,
                normal: v.normal,
            }
        });
        let field = pf::Model::new(
            regions,
            field_faces,
            packet.pzr.selection.interfacial_length_m,
            packet.pzr.selection.solid_roughness_m,
            1.,
        )
        .map_err(bad)?;
        let size = scales.len();
        let y: Vec<f64> = physical.iter().zip(&scales).map(|(v, s)| v / s).collect();
        let face_count = faces.len();
        let section_count = sections.len();
        Ok((
            Self {
                properties,
                faces,
                projections,
                cells,
                cell_layout,
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
                field,
                work: pf::Work::default(),
                pzr_begin,
                first_pzr_face,
                surge_to_pzr_face,
                charts: vec![[None; 2]; face_count],
                face_drive: vec![[s(0.); 2]; face_count],
                velocity: [vec![[s(0.); 2]; cells_n], vec![[s(0.); 2]; cells_n]],
                receipts: vec![[[s(0.); 3]; 2]; cells_n],
                forces: vec![[s(0.); 2]; cells_n],
                rows: vec![s(0.); size],
                scales,
                leading_enthalpy: vec![[None; 2]; cells_n],
                leading_liquid_concentration: vec![None; cells_n],
                leading_births: Vec::new(),
                first_source_failure: None,
                last_source_failure: None,
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
    pub fn properties(&self) -> &P {
        &self.properties
    }
    /// Prospective campaign guard: evaluations fail Fatal after this wall time.
    pub fn set_wall_budget(&mut self, seconds: f64) {
        self.wall_budget = Some((Instant::now(), seconds));
    }
    pub fn stock_indices(&self, node: usize, k: usize) -> (usize, usize) {
        let l = self.cell_layout[node];
        (l.mass[k], l.energy[k])
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
    fn saturation_points(&self) -> usize {
        pf::REGIONS + pf::FACES
    }
    pub fn reuse(&self) -> Reuse<P::Caloric> {
        Reuse::new(self.cells.len(), self.saturation_points())
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
            "composed coarse local-pressure network: retained two-phase M/U/B in every compiled volume, local EOS, one generalized impulse per phase path, compiled liquid-carrier sections and finite rotors; primary/SURGE gas drag and interphase exchange are not composed; not a joined nuclear/thermal/SG plant"
        )
    }
}
