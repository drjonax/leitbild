//! Bounded test-only actual 38-volume mechanical pilot. This does not join the
//! existing nuclear/solid/SG dynamics or qualify the full hot-spine trajectory.
//! All 38 phase M/U stocks and physical phase impulses have a fixed layout,
//! with no absent-phase temperature. Primary gas drag/phase exchange is isolated;
//! the existing liquid-carrier hydraulic ports do not qualify full mixed flow.
#![cfg(feature = "ida")]
use leitbild_operating_plant::{
    hydraulics::{self, Section},
    local_flow::{self as flow, Cell, Chart, Face, ForceProjection, Phase},
    phase, pzr_field as pf,
    thermal::{self, Scalar, WaterProperties},
};
use leitbild_operating_water::{
    Branch, CaloricLinearization, If97, WaterPoint, directional_ph, directional_pu,
    ida::{Advance, Failure, Ida, Initial, System},
    point, point_ph, point_pu,
};
use serde_json::{Value, json};
use std::time::Instant;
const CELLS: usize = 38;
const PZR_BEGIN: usize = 28;
const FIRST_PZR_FACE: usize = 35;
const RELATIVE_TOLERANCE: f64 = 1e-6;
const ABSOLUTE_TOLERANCE: f64 = 1e-8;
fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn n(v: &Value, k: &str) -> f64 {
    v[k].as_f64().unwrap_or_else(|| panic!("missing {k}"))
}
fn i(v: &Value, k: &str) -> usize {
    v[k].as_u64().unwrap() as usize
}
fn a<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v[k].as_array().unwrap()
}
fn rec(v: f64, d: f64) -> Scalar {
    Scalar::new(v, d)
}
fn selected_phase(mass: Scalar) -> bool {
    mass.value != 0. || mass.direction != 0.
}
fn inverse_water(
    p: Scalar,
    energy: Scalar,
    k: usize,
    enthalpy: bool,
) -> std::result::Result<(WaterPoint, WaterPoint), Failure> {
    let branch = if k == 0 {
        Branch::Liquid
    } else {
        Branch::Vapor
    };
    let result = if p.direction == 0. && energy.direction == 0. {
        if enthalpy {
            point_ph(branch, p.value, energy.value)
        } else {
            point_pu(branch, p.value, energy.value)
        }
        .map(|q| (q, WaterPoint::default()))
    } else if enthalpy {
        directional_ph(branch, p.value, energy.value, p.direction, energy.direction)
    } else {
        directional_pu(branch, p.value, energy.value, p.direction, energy.direction)
    };
    result.map_err(|e| {
        Failure::Recoverable(format!(
            "actual local IF97 inverse p={} specific={} phase={k} h={enthalpy}: {e}",
            p.value, energy.value
        ))
    })
}
#[derive(Clone, Copy)]
struct CaloricSlot {
    key: (u64, u64, usize, bool),
    point: CaloricLinearization,
}
struct JacobianReuse {
    caloric: [[Option<CaloricSlot>; 2]; CELLS],
    saturation: [Option<(u64, thermal::Saturation)>; pf::REGIONS + pf::FACES],
}
impl Default for JacobianReuse {
    fn default() -> Self {
        Self {
            caloric: [[None; 2]; CELLS],
            saturation: [None; pf::REGIONS + pf::FACES],
        }
    }
}
fn inverse_reusing(
    p: Scalar,
    target: Scalar,
    k: usize,
    enthalpy: bool,
    slot: Option<&mut Option<CaloricSlot>>,
) -> std::result::Result<(WaterPoint, WaterPoint), Failure> {
    let Some(slot) = slot else {
        return inverse_water(p, target, k, enthalpy);
    };
    let key = (p.value.to_bits(), target.value.to_bits(), k, enthalpy);
    let point = if let Some(current) = *slot
        && current.key == key
    {
        current.point
    } else {
        *slot = None;
        let branch = if k == 0 {
            Branch::Liquid
        } else {
            Branch::Vapor
        };
        let point = if enthalpy {
            CaloricLinearization::enthalpy(branch, p.value, target.value)
        } else {
            CaloricLinearization::internal_energy(branch, p.value, target.value)
        }
        .map_err(|e| {
            Failure::Recoverable(format!(
                "current caloric point p={} specific={} phase={k} h={enthalpy}: {e}",
                p.value, target.value
            ))
        })?;
        *slot = Some(CaloricSlot { key, point });
        point
    };
    let direction = match point.directional(p.direction, target.direction) {
        Ok(value) => value,
        Err(error) => {
            *slot = None;
            return Err(Failure::Recoverable(format!(
                "current caloric direction: {error}"
            )));
        }
    };
    Ok((point.point(), direction))
}
fn saturation_reusing(
    p: Scalar,
    slot: Option<&mut Option<(u64, thermal::Saturation)>>,
) -> std::result::Result<thermal::Saturation, Failure> {
    let Some(slot) = slot.filter(|_| p.direction == 0.) else {
        return If97
            .saturation(p)
            .map_err(|e| Failure::Recoverable(e.into()));
    };
    let key = p.value.to_bits();
    if let Some((stored, value)) = *slot
        && stored == key
    {
        return Ok(value);
    }
    *slot = None;
    let value = If97
        .saturation(p)
        .map_err(|e| Failure::Recoverable(e.into()))?;
    *slot = Some((key, value));
    Ok(value)
}
fn empty_energy_ratio(energy: f64, allowance: f64) -> std::result::Result<f64, Failure> {
    // Numerical admission only: retain the raw conservative stock, do not
    // manufacture a phase/EOS point or change the exact empty-phase law.
    if !energy.is_finite() || !allowance.is_finite() || allowance <= 0. {
        return Err(Failure::Fatal(
            "invalid empty-energy numerical budget".into(),
        ));
    }
    let ratio = energy.abs() / allowance;
    if ratio > 1. {
        return Err(Failure::Fatal(format!(
            "raw empty-phase energy exceeds unchanged solver budget: U={energy}, allowance={allowance}"
        )));
    }
    Ok(ratio)
}
#[derive(Clone, Copy)]
struct CellLayout {
    phase: usize,
    base: usize,
    boron: usize,
    mass: [usize; 2],
    energy: [usize; 2],
}
#[derive(Clone, Copy)]
struct FaceLayout {
    phase: usize,
    face: usize,
    index: usize,
}
struct Hydraulic {
    section: Section,
    region: usize,
    rotor: Option<usize>,
}
struct Pilot {
    faces: Vec<Face>,
    projections: Vec<Vec<ForceProjection>>,
    cells: Vec<Cell>,
    cell_layout: Vec<CellLayout>,
    face_layout: Vec<FaceLayout>,
    volumes: Vec<f64>,
    sections: Vec<Hydraulic>,
    section_projection: Vec<(usize, usize, f64)>,
    section_drive: Vec<Scalar>,
    rotor_index: Vec<usize>,
    rotor_inertia: f64,
    rotor_drag: f64,
    field: pf::Model,
    work: pf::Work,
    charts: Vec<[Option<Chart>; 2]>,
    face_drive: Vec<[Scalar; 2]>,
    velocity: [Vec<[Scalar; 2]>; 2],
    receipts: Vec<[[Scalar; 3]; 2]>,
    forces: Vec<[Scalar; 2]>,
    scalar_rows: Vec<Scalar>,
    scales: Vec<f64>,
    first_source_failure: Option<Value>,
    last_source_failure: Option<Value>,
    leading_births: Vec<Value>,
    leading_enthalpy: [[Option<f64>; 2]; CELLS],
    leading_liquid_concentration: [Option<f64>; CELLS],
    column_sign: f64,
    jac_column_signs: Vec<f64>,
    first_mechanical_birth: Option<Value>,
    started: Instant,
    evaluations: usize,
    jacobians: usize,
    evaluation_wall: f64,
    jacobian_wall: f64,
    shaft_power: Scalar,
}
impl Pilot {
    fn orphan_energy_owners(&self, y: &[f64]) -> Vec<(usize, usize)> {
        (0..CELLS)
            .flat_map(|node| (0..2).map(move |k| (node, k)))
            .filter(|(node, k)| {
                let (mi, ui) = self.stock_indices(*node, *k);
                y[mi] == 0. && y[ui] != 0.
            })
            .collect()
    }
    fn phase_snapshot(&self, node: usize, k: usize, y: &[f64], yp: &[f64]) -> Value {
        let (mi, ui) = self.stock_indices(node, k);
        json!({"region":node,"phase":k,"mass_kg":y[mi]*self.scales[mi],"internal_energy_j":y[ui]*self.scales[ui],"solver_mass_rate_kg_s":yp[mi]*self.scales[mi],"solver_energy_rate_w":yp[ui]*self.scales[ui],"actual_mass_receipt_kg_s":self.receipts[node][k][0].value,"actual_enthalpy_receipt_w":self.receipts[node][k][1].value,"actual_energy_rhs_w":(yp[ui]-self.scalar_rows[ui].value)*self.scales[ui],"unchanged_solver_energy_allowance_j":self.scales[ui]*(ABSOLUTE_TOLERANCE+RELATIVE_TOLERANCE*y[ui].abs())})
    }
    fn inventory(&self, y: &[f64]) -> std::result::Result<([f64; 4], Value), Failure> {
        let mut total = [0.; 4];
        let mut present = 0;
        let mut absent = 0;
        let mut orphan_energy = Vec::new();
        let mut orphan_abs = 0.;
        let mut orphan_allowance = 0.;
        for node in 0..CELLS {
            for k in 0..2 {
                let (mi, ui) = self.stock_indices(node, k);
                let mass = y[mi] * self.scales[mi];
                let energy = y[ui] * self.scales[ui];
                if !mass.is_finite() || !energy.is_finite() || mass < 0. {
                    return Err(Failure::Fatal(format!(
                        "physical stock admission failed region={node},phase={k},M={mass},U={energy}"
                    )));
                }
                total[0] += mass;
                total[2] += energy;
                if mass == 0. {
                    absent += 1;
                    if energy != 0. {
                        let allowance = self.scales[ui]
                            * (ABSOLUTE_TOLERANCE + RELATIVE_TOLERANCE * y[ui].abs());
                        let ratio = empty_energy_ratio(energy, allowance)?;
                        orphan_abs += energy.abs();
                        orphan_allowance += allowance;
                        orphan_energy.push(json!({"region":node,"phase":k,"raw_internal_energy_j":energy,"unchanged_state_error_allowance_j":allowance,"absolute_error_ratio":ratio}));
                    }
                } else {
                    present += 1;
                }
                if k == 0 {
                    let index = self.cell_layout[node].boron;
                    let b = y[index] * self.scales[index];
                    if !b.is_finite() || b < 0. || (mass == 0. && b != 0.) {
                        return Err(Failure::Fatal(format!(
                            "physical liquid tracer admission failed region={node},M={mass},B={b}"
                        )));
                    }
                    total[1] += b;
                }
            }
        }
        if orphan_abs > orphan_allowance {
            return Err(Failure::Fatal("aggregate absolute empty-phase energy exceeds associated unchanged state-error budgets".into()));
        }
        let mut cold_paths = 0;
        for l in &self.face_layout {
            let inertia = self.faces[l.face].supports.iter().fold(0., |sum, support| {
                let (mi, _) = self.stock_indices(support.region, l.phase);
                sum + y[mi] * self.scales[mi] / self.volumes[support.region]
                    * support.inverse_area_length_per_m
            });
            let pi = y[l.index] * self.scales[l.index];
            if !pi.is_finite()
                || !inertia.is_finite()
                || inertia < 0.
                || (inertia == 0. && pi != 0.)
            {
                return Err(Failure::Fatal(format!(
                    "physical impulse admission failed face={},phase={},I={inertia},Pi={pi}",
                    l.face, l.phase
                )));
            }
            if inertia == 0. {
                cold_paths += 1;
            }
        }
        for index in &self.rotor_index {
            let angular = y[*index] * self.scales[*index];
            if !angular.is_finite() {
                return Err(Failure::Fatal(
                    "nonfinite accepted rotor angular momentum".into(),
                ));
            }
            total[3] += 0.5 * angular * angular / self.rotor_inertia;
        }
        if total.iter().any(|v| !v.is_finite()) {
            return Err(Failure::Fatal(
                "nonfinite accepted total inventory/rotor energy".into(),
            ));
        }
        Ok((
            total,
            json!({"mass_kg":total[0],"boron_kg_eq":total[1],"fluid_internal_energy_j":total[2],"rotor_kinetic_energy_j":total[3],"positive_phase_stocks":present,"exact_zero_mass_phase_stocks":absent,"exact_zero_inertia_paths":cold_paths,"numerical_stock_and_impulse_admission":true,"empty_energy_residuals":{"physical_law":"M=0 requires U=0; raw numerical defects below existing solver error budgets are reported, not reset or used for absent EOS","owners":orphan_energy,"sum_absolute_raw_energy_j":orphan_abs,"sum_associated_state_error_allowances_j":orphan_allowance,"aggregate_absolute_error_ratio":if orphan_allowance==0. {0.}else{orphan_abs/orphan_allowance}}}),
        ))
    }
    fn current_budget(&self, y: &[f64], yp: &[f64]) -> Value {
        let mut mass = 0.;
        let mut boron = 0.;
        let mut energy = 0.;
        let mut rotor = 0.;
        let mut bearing = 0.;
        let mut mass_abs = 0.;
        let mut boron_abs = 0.;
        let mut energy_abs = 0.;
        for node in 0..CELLS {
            for k in 0..2 {
                let (mi, ui) = self.stock_indices(node, k);
                let md = (yp[mi] - self.scalar_rows[mi].value) * self.scales[mi];
                let ud = (yp[ui] - self.scalar_rows[ui].value) * self.scales[ui];
                mass += md;
                energy += ud;
                mass_abs += md.abs();
                energy_abs += ud.abs();
            }
            let index = self.cell_layout[node].boron;
            let bd = (yp[index] - self.scalar_rows[index].value) * self.scales[index];
            boron += bd;
            boron_abs += bd.abs();
        }
        for index in &self.rotor_index {
            let rhs = (yp[*index] - self.scalar_rows[*index].value) * self.scales[*index];
            let omega = y[*index] * self.scales[*index] / self.rotor_inertia;
            rotor += rhs * omega;
            bearing += self.rotor_drag * omega * omega;
        }
        let max_primary_void = self.cells[..PZR_BEGIN]
            .iter()
            .map(|c| c.phase[1].map_or(0., |p| p.fraction.value))
            .fold(0., f64::max);
        let min_pump_liquid = self
            .sections
            .iter()
            .filter(|h| h.rotor.is_some())
            .map(|h| self.cells[h.region].phase[0].map_or(0., |p| p.fraction.value))
            .fold(1., f64::min);
        json!({"mass_receipt_sum_kg_s":mass,"mass_receipt_abs_sum_kg_s":mass_abs,"boron_receipt_sum_kg_eq_s":boron,"boron_receipt_abs_sum_kg_eq_s":boron_abs,"fluid_energy_receipt_sum_w":energy,"fluid_energy_receipt_abs_sum_w":energy_abs,"once_paid_shaft_power_w":self.shaft_power.value,"fluid_energy_minus_shaft_w":energy-self.shaft_power.value,"rotor_energy_rhs_w":rotor,"bearing_loss_w":bearing,"fluid_plus_rotor_plus_bearing_w":energy+rotor+bearing,"max_primary_void_fraction":max_primary_void,"min_pump_liquid_fraction":min_pump_liquid})
    }
    fn endpoint_error_account(
        &self,
        y: &[f64],
        yp: &[f64],
        errors: &[f64],
        weights: &[f64],
        order: i32,
    ) -> Value {
        let mut labels = vec![("", String::new()); y.len()];
        for (node, l) in self.cell_layout.iter().enumerate() {
            labels[l.base] = ("p", format!("p[{node}]"));
            labels[l.boron] = ("B", format!("B_liquid[{node}]"));
            for k in 0..2 {
                labels[l.mass[k]] = ("M", format!("M[{node},{k}]"));
                labels[l.energy[k]] = ("U", format!("U[{node},{k}]"));
            }
        }
        for l in &self.face_layout {
            labels[l.index] = ("Pi", format!("Pi[{},{}]", l.face, l.phase));
        }
        for (r, index) in self.rotor_index.iter().enumerate() {
            labels[*index] = ("rotor", format!("rotor[{r}]"));
        }
        let mut indices: Vec<usize> = (0..y.len()).collect();
        indices.sort_by(|a, b| {
            (errors[*b] * weights[*b])
                .abs()
                .total_cmp(&(errors[*a] * weights[*a]).abs())
        });
        let entry = |j: usize| json!({"index":j,"coordinate":labels[j].1,"category":labels[j].0,"scaled_y":y[j],"physical_y":y[j]*self.scales[j],"physical_rate":yp[j]*self.scales[j],"physical_local_error_estimate":errors[j]*self.scales[j],"stock_reciprocal_scaled_error_weight":weights[j],"weighted_error":errors[j]*weights[j]});
        let categories: Vec<Value> = ["p","M","U","B","Pi","rotor"].iter().map(|category| {
            let members:Vec<usize>=indices.iter().copied().filter(|j|labels[*j].0==*category).collect();
            let square_sum=members.iter().map(|j|(errors[*j]*weights[*j]).powi(2)).sum::<f64>();
            json!({"category":category,"coordinate_count":members.len(),"squared_weighted_error_sum":square_sum,"contribution_to_global_wrms_squared":square_sum/y.len() as f64,"top_coordinates":members.iter().take(3).map(|j|entry(*j)).collect::<Vec<_>>()})
        }).collect();
        let range = |values: Vec<f64>| json!({"min":values.iter().copied().reduce(f64::min),"max":values.iter().copied().reduce(f64::max)});
        let pressure = range(
            self.cell_layout
                .iter()
                .map(|l| y[l.base] * self.scales[l.base])
                .collect(),
        );
        let phase_ranges:Vec<Value>=(0..2).map(|k| {
            let masses:Vec<f64>=(0..CELLS).map(|node|{let(mi,_)=self.stock_indices(node,k);y[mi]*self.scales[mi]}).collect();
            let energies:Vec<f64>=(0..CELLS).map(|node|{let(_,ui)=self.stock_indices(node,k);y[ui]*self.scales[ui]}).collect();
            json!({"phase":k,"positive_mass_min_kg":masses.iter().copied().filter(|m|*m>0.).reduce(f64::min),"mass_kg":range(masses),"internal_energy_j":range(energies),"volume_flow_m3_s":range(self.charts.iter().filter_map(|pair|pair[k].map(|c|c.volume_flow_m3_s.value)).collect())})
        }).collect();
        let wrms = (errors
            .iter()
            .zip(weights)
            .map(|(e, w)| (e * w).powi(2))
            .sum::<f64>()
            / y.len() as f64)
            .sqrt();
        json!({"current_bdf_order":order,"stock_estimated_local_error_wrms":wrms,"meaning":"stock last accepted-step estimated local error times stock current error weights; control uses global WRMS, not a per-coordinate threshold","top_coordinates":indices.iter().take(12).map(|j|entry(*j)).collect::<Vec<_>>(),"categories":categories,"pressure_pa":pressure,"phase_ranges":phase_ranges})
    }
    fn stock_indices(&self, node: usize, k: usize) -> (usize, usize) {
        let l = self.cell_layout[node];
        (l.mass[k], l.energy[k])
    }
    /// Select only exact-zero phases with a positive leading receipt from the
    /// actual current physical face acceleration. No fixed region list, time
    /// threshold, stock seed, or absent-phase property query selects a birth.
    fn select_leading_receipts(
        &mut self,
        y: &[f64],
        yp: &[f64],
    ) -> std::result::Result<(), Failure> {
        self.evaluate(0., y, yp, None, 0., None)?;
        let mut receipts = [[[0.; 3]; 2]; CELLS];
        for l in &self.face_layout {
            let drive = self.face_drive[l.face][l.phase].value;
            let f = &self.faces[l.face];
            let Some(c) = flow::chart(f, &self.cells, l.phase, rec(0., drive))
                .map_err(|e| Failure::Fatal(e.into()))?
            else {
                continue;
            };
            let Some(donor) = c.donor else { continue };
            let receiver = if donor == f.from { f.to } else { f.from };
            if self.cells[receiver].phase[l.phase].is_some() {
                continue;
            }
            let mass = c.mass_flow_kg_s.direction.abs();
            if mass > 0. {
                receipts[receiver][l.phase][0] += mass;
                receipts[receiver][l.phase][1] +=
                    mass * self.cells[donor].phase[l.phase].unwrap().enthalpy.value;
                receipts[receiver][l.phase][2] += mass
                    * self.cells[donor].phase[l.phase]
                        .unwrap()
                        .boron_concentration
                        .value;
            }
        }
        for (node, phases) in receipts.iter().enumerate() {
            for (k, r) in phases.iter().enumerate() {
                if r[0] <= 0. {
                    continue;
                }
                let h = r[1] / r[0];
                let l = self.cell_layout[node];
                let p = y[l.base] * self.scales[l.base];
                let branch = if k == 0 {
                    Branch::Liquid
                } else {
                    Branch::Vapor
                };
                let temp = point_ph(branch, p, h)
                    .map_err(|e| Failure::Fatal(e.to_string()))?
                    .temperature_k;
                self.leading_enthalpy[node][k] = Some(h);
                if k == 0 {
                    self.leading_liquid_concentration[node] = Some(r[2] / r[0]);
                }
                self.leading_births.push(json!({"region":node,"phase":k,"leading_mass_receipt_kg_s2":r[0],"leading_enthalpy_receipt_w_s":r[1],"birth_enthalpy_j_kg":h,"temperature_k":temp,"retained_mass_kg":0.,"retained_energy_j":0.,"selection":"positive leading actual physical face-acceleration receipt at t=0"}));
            }
        }
        Ok(())
    }
    fn get(&self, y: &[f64], column: Option<usize>, index: usize) -> Scalar {
        rec(
            y[index] * self.scales[index],
            if column == Some(index) {
                self.column_sign * self.scales[index]
            } else {
                0.
            },
        )
    }
    fn rate(&self, yp: &[f64], column: Option<usize>, cj: f64, index: usize) -> Scalar {
        rec(
            yp[index] * self.scales[index],
            if column == Some(index) {
                self.column_sign * cj * self.scales[index]
            } else {
                0.
            },
        )
    }
    fn evaluate(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
        column: Option<usize>,
        cj: f64,
        mut reuse: Option<&mut JacobianReuse>,
    ) -> std::result::Result<(), Failure> {
        if self.started.elapsed().as_secs_f64() > 60. {
            return Err(Failure::Fatal(
                "actual mechanical pilot exceeded prospective 60 s callback campaign budget".into(),
            ));
        }
        let started = Instant::now();
        self.evaluations += 1;
        self.receipts.fill([[s(0.); 3]; 2]);
        self.velocity[0].fill([s(0.); 2]);
        self.velocity[1].fill([s(0.); 2]);
        self.shaft_power = s(0.);
        let mut points = [[None; 2]; CELLS];
        for (node, current_point) in points.iter_mut().enumerate() {
            let l = self.cell_layout[node];
            let p = self.get(y, column, l.base);
            self.cells[node] = Cell {
                pressure: p,
                phase: [None; 2],
            };
            {
                let mut volume = [s(0.); 2];
                for k in 0..2 {
                    let mass = self.get(y, column, l.mass[k]);
                    let energy = self.get(y, column, l.energy[k]);
                    let q = if mass.value != 0. {
                        Some(inverse_reusing(
                            p,
                            energy / mass,
                            k,
                            false,
                            reuse.as_deref_mut().map(|r| &mut r.caloric[node][k]),
                        )?)
                    } else if let Some(h) = self.leading_enthalpy[node][k] {
                        Some(inverse_reusing(
                            p,
                            s(h),
                            k,
                            true,
                            reuse.as_deref_mut().map(|r| &mut r.caloric[node][k]),
                        )?)
                    } else {
                        None
                    };
                    current_point[k] = q;
                    if let Some((q, dq)) = q {
                        volume[k] = mass / rec(q.density_kg_m3, dq.density_kg_m3);
                    }
                }
                self.scalar_rows[l.base] =
                    (volume[0] + volume[1] - s(self.volumes[node])) / s(self.volumes[node]);
                for k in 0..2 {
                    let mass = self.get(y, column, l.mass[k]);
                    if !selected_phase(mass) {
                        continue;
                    }
                    let Some((q, dq)) = current_point[k] else {
                        continue;
                    };
                    let fraction = if k == l.phase {
                        s(1.) - volume[1 - k] / s(self.volumes[node])
                    } else {
                        volume[k] / s(self.volumes[node])
                    };
                    self.cells[node].phase[k] = Some(Phase {
                        fraction,
                        density: rec(q.density_kg_m3, dq.density_kg_m3),
                        enthalpy: rec(q.enthalpy_j_kg, dq.enthalpy_j_kg),
                        boron_concentration: if k == 0 {
                            if mass.value != 0. {
                                self.get(y, column, l.boron) / mass
                            } else {
                                s(self.leading_liquid_concentration[node].ok_or_else(||Failure::Recoverable("zero-stock liquid direction requires its responsible tracer receipt".into()))?)
                            }
                        } else {
                            s(0.)
                        },
                    });
                }
            }
        }
        let phase_mass: [[Scalar; CELLS]; 2] = std::array::from_fn(|k| {
            std::array::from_fn(|node| {
                let (mi, _) = self.stock_indices(node, k);
                self.get(y, column, mi)
            })
        });
        let pre_source_mass_rate = [[s(0.); CELLS]; 2];
        self.charts.fill([None; 2]);
        for l in &self.face_layout {
            let pi = self.get(y, column, l.index);
            let f = &self.faces[l.face];
            let inertance = f.supports.iter().fold(s(0.), |sum, support| {
                sum + phase_mass[l.phase][support.region] / s(self.volumes[support.region])
                    * s(support.inverse_area_length_per_m)
            });
            if inertance.value == 0.
                && f.supports
                    .iter()
                    .any(|support| phase_mass[l.phase][support.region].value != 0.)
            {
                return Err(Failure::Recoverable(
                    "signed nonzero phase masses cancelled face inertia; not an empty rest chart"
                        .into(),
                ));
            }
            // Source assembly first needs the exact empty-path rest value.
            // The physical TOTAL-force limit is checked after source assembly;
            // a nonzero-I path always uses its retained impulse, not this value.
            let path = if inertance.value == 0. && pi.value == 0. {
                flow::PathKinematics {
                    inertance_kg_m4: inertance,
                    inertance_rate_kg_m4_s: s(0.),
                    volume_flow_m3_s: s(0.),
                }
            } else {
                flow::phase_path_kinematics(
                    f,
                    &phase_mass[l.phase],
                    &pre_source_mass_rate[l.phase],
                    &self.volumes,
                    pi,
                    s(0.),
                    flow::ColdOnset::Unavailable,
                )
                .map_err(|e| Failure::Recoverable(e.into()))?
            };
            let c = flow::chart_from_path(f, &self.cells, l.phase, pi, path).map_err(|e| {
                let f = &self.faces[l.face];
                Failure::Recoverable(format!(
                    "{e}; t={t},face={},phase={},Pi={},from={} phase={:?},to={} phase={:?}",
                    l.face,
                    l.phase,
                    pi.value,
                    f.from,
                    self.cells[f.from].phase[l.phase],
                    f.to,
                    self.cells[f.to].phase[l.phase]
                ))
            })?;
            self.charts[l.face][l.phase] = Some(c);
            flow::add_mean_velocity(
                &self.projections[l.face],
                c.volume_flow_m3_s,
                &mut self.velocity[l.phase],
            )
            .map_err(|e| Failure::Fatal(e.into()))?;
            if l.face < FIRST_PZR_FACE {
                let f = &self.faces[l.face];
                let flux = [c.mass_flow_kg_s, c.enthalpy_flow_w, c.boron_flow_kg_s];
                for (k, q) in flux.into_iter().enumerate() {
                    self.receipts[f.from][l.phase][k] = self.receipts[f.from][l.phase][k] - q;
                    self.receipts[f.to][l.phase][k] = self.receipts[f.to][l.phase][k] + q;
                }
            }
        }
        let mut phases = [[None; 2]; pf::REGIONS];
        let pressure: [Scalar; pf::REGIONS] =
            std::array::from_fn(|j| self.cells[PZR_BEGIN + j].pressure);
        let mut saturation = [thermal::Saturation::default(); pf::REGIONS];
        let mut face_saturation = [thermal::Saturation::default(); pf::FACES];
        for j in 0..pf::REGIONS {
            let node = PZR_BEGIN + j;
            let l = self.cell_layout[node];
            for k in 0..2 {
                let Some((q, dq)) = points[node][k] else {
                    continue;
                };
                let mi = l.mass[k];
                let mass = self.get(y, column, mi);
                if !selected_phase(mass) {
                    continue;
                }
                let boron = if k == 0 {
                    self.get(y, column, l.boron)
                } else {
                    s(0.)
                };
                let volume = if k == l.phase {
                    if let Some((born_q, born_dq)) = points[node][1 - k] {
                        s(self.volumes[node])
                            - self.get(y, column, l.mass[1 - k])
                                / rec(born_q.density_kg_m3, born_dq.density_kg_m3)
                    } else {
                        s(self.volumes[node])
                    }
                } else {
                    mass / rec(q.density_kg_m3, dq.density_kg_m3)
                };
                phases[j][k] = Some(pf::Phase {
                    mass,
                    volume,
                    temperature: rec(q.temperature_k, dq.temperature_k),
                    water: thermal::WaterPoint {
                        density: rec(q.density_kg_m3, dq.density_kg_m3),
                        viscosity: rec(q.viscosity_pa_s, dq.viscosity_pa_s),
                        conductivity: rec(q.conductivity_w_m_k, dq.conductivity_w_m_k),
                        cp: rec(q.cp_j_kg_k, dq.cp_j_kg_k),
                        expansion: rec(q.expansion_per_k, dq.expansion_per_k),
                        enthalpy: rec(q.enthalpy_j_kg, dq.enthalpy_j_kg),
                    },
                    velocity: self.velocity[k][node],
                    boron_mass: boron,
                });
            }
            saturation[j] = saturation_reusing(
                pressure[j],
                reuse.as_deref_mut().map(|r| &mut r.saturation[j]),
            )?;
        }
        for (j, sat) in face_saturation.iter_mut().enumerate() {
            let f = &self.faces[FIRST_PZR_FACE + j];
            if f.pressure_segments.len() != 2 {
                return Err(Failure::Fatal(
                    "actual PZR interface requires its two authored centroid segments".into(),
                ));
            }
            let p = flow::pressure_after_segments(f, &self.cells, 1)
                .map_err(|e| Failure::Fatal(e.into()))?;
            *sat = saturation_reusing(
                p,
                reuse
                    .as_deref_mut()
                    .map(|r| &mut r.saturation[pf::REGIONS + j]),
            )?;
        }
        let currents: [[Scalar; 2]; pf::FACES] = std::array::from_fn(|j| {
            std::array::from_fn(|k| {
                self.charts[FIRST_PZR_FACE + j][k].map_or(s(0.), |c| c.mass_flow_kg_s)
            })
        });
        let mut external = [[pf::Sources::default(); 2]; pf::REGIONS];
        for (j, row) in external.iter_mut().enumerate() {
            let node = PZR_BEGIN + j;
            for (k, source) in row.iter_mut().enumerate() {
                source.mass = self.receipts[node][k][0];
                source.enthalpy = self.receipts[node][k][1];
                source.boron = self.receipts[node][k][2];
            }
        }
        if let Some(c) = self.charts[34][0] {
            let node = self.faces[34].to;
            let j = node - PZR_BEGIN;
            let v = if c.mass_flow_kg_s.value >= 0. {
                [s(0.), c.volume_flow_m3_s / s(self.faces[34].flow_area_m2)]
            } else {
                self.velocity[0][node]
            };
            external[j][0].momentum = [c.mass_flow_kg_s * v[0], c.mass_flow_kg_s * v[1]];
        }
        let field_result = self.field.evaluate(
            pf::Input {
                pressure: &pressure,
                saturation: &saturation,
                face_saturation: &face_saturation,
                phase: &phases,
                face_mass_flow: &currents,
            },
            &external,
            &mut self.work,
        );
        if let Err(error) = field_result {
            // Error-only trace of the existing selector, not a second source law.
            let pair = |v: Scalar| [v.value, v.direction];
            let mut contrasts = Vec::new();
            for (j, f) in self.faces[FIRST_PZR_FACE..].iter().enumerate() {
                let from = f.from - PZR_BEGIN;
                let to = f.to - PZR_BEGIN;
                let fraction = |i: usize, k: usize| {
                    phases[i][k].map_or(s(0.), |p| p.volume / s(self.volumes[PZR_BEGIN + i]))
                };
                let contrast =
                    fraction(from, 0) * fraction(to, 1) - fraction(to, 0) * fraction(from, 1);
                if contrast.value == 0. && contrast.direction == 0. {
                    continue;
                }
                let forward =
                    contrast.value > 0. || (contrast.value == 0. && contrast.direction > 0.);
                let (li, gi) = if forward { (from, to) } else { (to, from) };
                if phases[li][0].is_some() && phases[gi][1].is_some() {
                    continue;
                }
                let endpoints: Vec<Value> = [from, to]
                    .into_iter()
                    .map(|i| {
                        let node = PZR_BEGIN + i;
                        let states: Vec<Value> = (0..2)
                            .map(|k| {
                                let (mi, ui) = self.stock_indices(node, k);
                                json!({"phase":k,"mass_kg":pair(self.get(y,column,mi)),"energy_j":pair(self.get(y,column,ui)),"source_volume_m3":phases[i][k].map(|p|pair(p.volume)),"source_present":phases[i][k].is_some(),"property_point_present":points[node][k].is_some(),"leading_enthalpy_j_kg":self.leading_enthalpy[node][k]})
                            })
                            .collect();
                        json!({"region":node,"phase_states":states})
                    })
                    .collect();
                contrasts.push(json!({"face":FIRST_PZR_FACE+j,"from":f.from,"to":f.to,"contrast":pair(contrast),"liquid_recipient":PZR_BEGIN+li,"vapor_recipient":PZR_BEGIN+gi,"endpoints":endpoints}));
            }
            let trace = json!({"error":error,"time_s":t,"jacobian_column":column,"column_sign":self.column_sign,"contrasts":contrasts});
            self.first_source_failure.get_or_insert(trace.clone());
            self.last_source_failure = Some(trace);
            return Err(Failure::Recoverable(error.into()));
        }
        for j in 0..pf::REGIONS {
            let node = PZR_BEGIN + j;
            for k in 0..2 {
                let r = self.work.sources[j][k];
                self.receipts[node][k] = [r.mass, r.enthalpy, r.boron];
            }
        }
        for (j, h) in self.sections.iter().enumerate() {
            let liquid = self.cells[h.region].phase[0].ok_or_else(|| {
                Failure::Recoverable("liquid-carrier section has no liquid owner".into())
            });
            let liquid = liquid?;
            let (q, dq) = points[h.region][0].ok_or_else(|| {
                Failure::Recoverable("liquid-carrier section has no liquid EOS point".into())
            })?;
            // Constitutive section throughput is the adjoint of its authored
            // physical force profile. Upwind transported mass is NOT this port.
            let profile = self
                .section_projection
                .iter()
                .filter(|(_, section, _)| *section == j)
                .fold(s(0.), |sum, (face, _, w)| {
                    sum + s(*w) * self.charts[*face][0].unwrap().volume_flow_m3_s
                });
            let current = liquid.density * liquid.fraction * profile;
            let gas_fraction = self.cells[h.region].phase[1].map_or(s(0.), |p| p.fraction);
            let omega = h.rotor.map_or(s(0.), |r| {
                self.get(y, column, self.rotor_index[r]) / s(self.rotor_inertia)
            });
            let input = hydraulics::Input {
                massflow_kg_s: current.value,
                density_kg_m3: q.density_kg_m3,
                viscosity_pa_s: q.viscosity_pa_s,
                pressure_drop_pa: 0.,
                omega_rad_s: omega.value,
                gas_volume_fraction: gas_fraction.value,
            };
            let direction = hydraulics::Input {
                massflow_kg_s: current.direction,
                density_kg_m3: dq.density_kg_m3,
                viscosity_pa_s: dq.viscosity_pa_s,
                pressure_drop_pa: 0.,
                omega_rad_s: omega.direction,
                gas_volume_fraction: gas_fraction.direction,
            };
            let e = h
                .section
                .evaluate(input, direction)
                .map_err(|e| Failure::Recoverable(e.to_string()))?;
            self.section_drive[j] = liquid.fraction
                * rec(
                    e.value.pump_euler_pa - e.value.passive_loss_pa,
                    e.direction.pump_euler_pa - e.direction.passive_loss_pa,
                );
            if let Some(r) = h.rotor {
                self.shaft_power =
                    self.shaft_power + rec(e.value.shaft_power_w, e.direction.shaft_power_w);
                self.receipts[h.region][0][1] = self.receipts[h.region][0][1]
                    + rec(e.value.shaft_power_w, e.direction.shaft_power_w);
                let index = self.rotor_index[r];
                self.scalar_rows[index] = (self.rate(yp, column, cj, index)
                    + rec(e.value.fluid_torque_nm, e.direction.fluid_torque_nm)
                    + s(self.rotor_drag) * omega)
                    / s(self.scales[index]);
            }
        }
        let phase_mass_rate: [[Scalar; CELLS]; 2] =
            std::array::from_fn(|k| std::array::from_fn(|node| self.receipts[node][k][0]));
        for l in &self.face_layout {
            let mut current = self.charts[l.face][l.phase].unwrap();
            let mut force = s(0.);
            if l.face < 33 && l.phase == 0 {
                for (face, section, w) in &self.section_projection {
                    if *face == l.face {
                        force = force + s(*w) * self.section_drive[*section];
                    }
                }
            }
            self.forces.fill([s(0.); 2]);
            for j in 0..pf::REGIONS {
                self.forces[PZR_BEGIN + j] = self.work.sources[j][l.phase].momentum;
            }
            force = force
                + flow::project_nonpressure(&self.projections[l.face], &self.forces)
                    .map_err(|e| Failure::Fatal(e.into()))?;
            // ProvenRest is the prepared all-zero-current case ONLY. This
            // pilot is not a generic disappearance/reappearance handler.
            // Cold I' uses assembled physical receipts, not an off-row yp.
            let path=flow::phase_path_kinematics(&self.faces[l.face],&phase_mass[l.phase],&phase_mass_rate[l.phase],&self.volumes,self.get(y,column,l.index),force+current.pressure_gravity_pa,flow::ColdOnset::ProvenRest)
                .map_err(|e|{
                    self.first_mechanical_birth.get_or_insert(json!({"time_s":t,"face":l.face,"phase":l.phase,"inertance_kg_m4":current.inertance_kg_m4.value,"total_force_pa":(force+current.pressure_gravity_pa).value,"scope":"unsupported exact-zero physical onset; no guessed Q, phase seed or momentum reset"}));
                    Failure::Recoverable(format!("{e}; t={t},face={},phase={}",l.face,l.phase))
                })?;
            current = flow::chart_from_path(
                &self.faces[l.face],
                &self.cells,
                l.phase,
                self.get(y, column, l.index),
                path,
            )
            .map_err(|e| Failure::Recoverable(e.into()))?;
            self.charts[l.face][l.phase] = Some(current);
            self.face_drive[l.face][l.phase] = force + current.pressure_gravity_pa;
            self.scalar_rows[l.index] =
                flow::momentum_residual(self.rate(yp, column, cj, l.index), current, force)
                    .map_err(|e| Failure::Recoverable(e.into()))?
                    / s(self.scales[l.index]);
        }
        for (node, node_points) in points.iter().enumerate() {
            let l = self.cell_layout[node];
            let index = l.boron;
            self.scalar_rows[index] = (self.rate(yp, column, cj, index)
                - self.receipts[node][0][2])
                / s(self.scales[index]);
            {
                let mut therm = [None; 2];
                let pressure = self.get(y, column, l.base);
                let md = std::array::from_fn(|k| self.receipts[node][k][0]);
                let hd = std::array::from_fn(|k| self.receipts[node][k][1]);
                for (k, phase) in therm.iter_mut().enumerate() {
                    let receipt_point = if node_points[k].is_none() {
                        if md[k].value > 0. {
                            Some(inverse_reusing(
                                pressure,
                                hd[k] / md[k],
                                k,
                                true,
                                reuse.as_deref_mut().map(|r| &mut r.caloric[node][k]),
                            )?)
                        } else if md[k].value == 0. && md[k].direction > 0. {
                            Some(inverse_reusing(
                                pressure,
                                s(hd[k].direction / md[k].direction),
                                k,
                                true,
                                reuse.as_deref_mut().map(|r| &mut r.caloric[node][k]),
                            )?)
                        } else {
                            None
                        }
                    } else {
                        node_points[k]
                    };
                    let Some((q, dq)) = receipt_point else {
                        continue;
                    };
                    let rho = rec(q.density_kg_m3, dq.density_kg_m3);
                    let alpha = rec(q.expansion_per_k, dq.expansion_per_k);
                    let kappa = rec(q.compressibility_per_pa, dq.compressibility_per_pa);
                    let temperature = rec(q.temperature_k, dq.temperature_k);
                    *phase = Some(phase::ScalarRatePhase {
                        mass: self.get(y, column, l.mass[k]),
                        density: rho,
                        specific_u: rec(q.internal_energy_j_kg, dq.internal_energy_j_kg),
                        rho_p: rho * kappa,
                        rho_t: -rho * alpha,
                        u_p: (-temperature * alpha + pressure * kappa) / rho,
                        u_t: rec(q.cp_j_kg_k, dq.cp_j_kg_k) - pressure * alpha / rho,
                    });
                }
                let rates = phase::current_rates(pressure, therm, md, hd)
                    .map_err(|e| Failure::Recoverable(e.to_string()))?;
                for (k, mass_rate) in md.iter().enumerate() {
                    self.scalar_rows[l.mass[k]] = (self.rate(yp, column, cj, l.mass[k])
                        - *mass_rate)
                        / s(self.scales[l.mass[k]]);
                    self.scalar_rows[l.energy[k]] = (self.rate(yp, column, cj, l.energy[k])
                        - rates.internal_energy_rate_w[k])
                        / s(self.scales[l.energy[k]]);
                }
            }
        }
        self.evaluation_wall += started.elapsed().as_secs_f64();
        Ok(())
    }
}
impl System for Pilot {
    fn dimension(&self) -> usize {
        self.scales.len()
    }
    fn nonzeros(&self) -> usize {
        self.scales.len() * self.scales.len()
    }
    fn root_count(&self) -> usize {
        0
    }
    fn roots(
        &mut self,
        _: f64,
        _: &[f64],
        _: &[f64],
        _: &mut [f64],
    ) -> std::result::Result<(), Failure> {
        Ok(())
    }
    fn residual(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
        out: &mut [f64],
    ) -> std::result::Result<(), Failure> {
        self.evaluate(t, y, yp, None, 0., None)?;
        for (r, v) in out.iter_mut().zip(&self.scalar_rows) {
            *r = v.value;
        }
        Ok(())
    }
    fn jacobian(
        &mut self,
        t: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        data: &mut [f64],
        rows: &mut [i64],
        ptr: &mut [i64],
    ) -> std::result::Result<(), Failure> {
        // Current Scalar matrix, NOT the full hot-state sparse strategy.
        // At exact birth this is a selected one-sided chart linearization,
        // not a Cartesian derivative across the discontinuous caloric switch.
        let started = Instant::now();
        self.jacobians += 1;
        let size = self.dimension();
        let mut reuse = JacobianReuse::default();
        self.evaluate(t, y, yp, None, 0., Some(&mut reuse))?;
        self.jac_column_signs.fill(1.);
        for layout in &self.face_layout {
            if y[layout.index] == 0. {
                // A zero-current column follows its actual force branch.
                // Reverse the seed and then divide the output by that sign.
                self.jac_column_signs[layout.index] =
                    1_f64.copysign(self.face_drive[layout.face][layout.phase].value);
            }
        }
        for (col, pointer) in ptr.iter_mut().take(size).enumerate() {
            self.column_sign = self.jac_column_signs[col];
            if let Err(error) = self.evaluate(t, y, yp, Some(col), cj, Some(&mut reuse)) {
                self.column_sign = 1.;
                self.jacobian_wall += started.elapsed().as_secs_f64();
                return Err(error);
            }
            *pointer = (col * size) as i64;
            for (row, residual) in self.scalar_rows.iter().enumerate() {
                let j = col * size + row;
                rows[j] = row as i64;
                data[j] = residual.direction / self.column_sign;
            }
        }
        ptr[size] = (size * size) as i64;
        self.column_sign = 1.;
        self.jacobian_wall += started.elapsed().as_secs_f64();
        Ok(())
    }
}
fn build(packet: &Value) -> (Pilot, Vec<f64>, Vec<f64>, Vec<f64>, Vec<f64>) {
    let geometry = &packet["mechanics"];
    let volumes: Vec<f64> = a(geometry, "regions")
        .iter()
        .map(|v| n(v, "volume_m3"))
        .collect();
    assert_eq!(volumes.len(), CELLS);
    let faces: Vec<Face> = a(geometry, "faces")
        .iter()
        .map(|f| Face {
            from: i(f, "from"),
            to: i(f, "to"),
            flow_area_m2: n(f, "flow_area_m2"),
            supports: serde_json::from_value(f["supports"].clone()).unwrap(),
            pressure_segments: serde_json::from_value(f["pressure_segments"].clone()).unwrap(),
        })
        .collect();
    assert_eq!(faces.len(), 48);
    for f in &faces {
        f.validate(CELLS).unwrap();
    }
    let mut projections = vec![Vec::new(); faces.len()];
    for p in a(geometry, "force_projection") {
        projections[i(p, "face")].push(ForceProjection {
            region: i(p, "region"),
            coefficient_per_m2: n(p, "coefficient_per_m2"),
            normal: serde_json::from_value(p["normal"].clone()).unwrap(),
        });
    }
    let mut cell_layout = Vec::new();
    let mut physical = Vec::new();
    let mut scales = Vec::new();
    let mut ids = Vec::new();
    let mut initial_points = Vec::new();
    for node in 0..CELLS {
        let (p, t, mass, u, b, k) = if node < 27 {
            let v = &packet["thermal"]["water"][node];
            (
                n(v, "pressure_pa"),
                n(v, "temperature_k"),
                n(v, "mass_kg"),
                n(v, "energy_j"),
                packet["water_boron_amount_kg_eq"][node].as_f64().unwrap(),
                0,
            )
        } else if node == 27 {
            let v = &packet["external_ports"]["surge_stock"];
            (
                n(v, "pressure_Pa"),
                n(v, "temperature_K"),
                n(v, "mass_kg"),
                n(v, "internalEnergy_J"),
                n(v, "absorberTracer_kgEq"),
                0,
            )
        } else {
            let v = &packet["pzr"]["regions"][node - PZR_BEGIN];
            let k = usize::from(v["initialPhase"] == "vapor");
            (
                n(v, "commonPressure_Pa"),
                n(&v["water"], "T"),
                n(v, "mass_kg"),
                n(
                    v,
                    if k == 0 {
                        "liquidEnergy_J"
                    } else {
                        "vaporEnergy_J"
                    },
                ),
                n(v, "absorberTracer_kgEq"),
                k,
            )
        };
        initial_points.push(
            point(
                if k == 0 {
                    Branch::Liquid
                } else {
                    Branch::Vapor
                },
                p,
                t,
            )
            .unwrap(),
        );
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
        ids.extend([0., 1., 1., 1., 1., 1.]);
    }
    let mut cells = vec![
        Cell {
            pressure: s(0.),
            phase: [None; 2]
        };
        CELLS
    ];
    for node in 0..CELLS {
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
    let mut face_layout = Vec::new();
    for (j, f) in faces.iter().enumerate() {
        let reference_inertia = f.supports.iter().fold(0., |sum, support| {
            sum + initial_points[support.region].density_kg_m3 * support.inverse_area_length_per_m
        });
        for k in 0..2 {
            face_layout.push(FaceLayout {
                phase: k,
                face: j,
                index: physical.len(),
            });
            physical.push(0.);
            scales.push(reference_inertia);
            ids.push(1.);
        }
    }
    let hydraulic = &packet["hydraulics"];
    let pump = &hydraulic["pump"];
    let mut rotor_index = Vec::new();
    let sections: Vec<Hydraulic> = a(hydraulic, "sections")
        .iter()
        .map(|h| {
            let section: Section = serde_json::from_value(h["parameters"].clone()).unwrap();
            let rotor = section.pump.map(|_| {
                let index = physical.len();
                let reference = n(pump, "rotorInertia_kg_m2") * n(pump, "referenceOmega_rad_s");
                physical.push(reference);
                scales.push(reference);
                ids.push(1.);
                let r = rotor_index.len();
                rotor_index.push(index);
                r
            });
            Hydraulic {
                section,
                region: i(h, "region"),
                rotor,
            }
        })
        .collect();
    let section_projection = a(geometry, "section_force_projection")
        .iter()
        .map(|p| (i(p, "face"), i(p, "section"), n(p, "coefficient")))
        .collect();
    let pzr = &packet["pzr"];
    let regions: [pf::Region; pf::REGIONS] = std::array::from_fn(|j| {
        let v = &pzr["regions"][j];
        pf::Region {
            volume_m3: n(v, "volume_m3"),
            axial_area_m2: n(v, "axialArea_m2"),
            height_m: n(v, "top_m") - n(v, "bottom_m"),
            solid_perimeter_m: n(v, "solidPerimeter_m"),
            elevation_m: n(v, "elevation_m"),
        }
    });
    let field_faces: [pf::Face; pf::FACES] = std::array::from_fn(|j| {
        let v = &pzr["faces"][j];
        pf::Face {
            from: i(v, "from"),
            to: i(v, "to"),
            area_m2: n(v, "area_m2"),
            distance_m: n(v, "distance_m"),
            normal: serde_json::from_value(v["normal"].clone()).unwrap(),
        }
    });
    let field = pf::Model::new(
        regions,
        field_faces,
        n(&pzr["selection"], "interfacialLength_m"),
        n(&pzr["selection"], "solidRoughness_m"),
        1.,
    )
    .unwrap();
    let size = scales.len();
    let section_drive = vec![s(0.); sections.len()];
    let y = physical.iter().zip(&scales).map(|(v, s)| v / s).collect();
    let yp = vec![0.; size];
    let atol = vec![ABSOLUTE_TOLERANCE; size];
    (
        Pilot {
            faces,
            projections,
            cells,
            cell_layout,
            face_layout,
            volumes,
            sections,
            section_projection,
            section_drive,
            rotor_index,
            rotor_inertia: n(pump, "rotorInertia_kg_m2"),
            rotor_drag: n(pump, "drag_Nm_per_rad_s"),
            field,
            work: pf::Work::default(),
            charts: vec![[None; 2]; 48],
            face_drive: vec![[s(0.); 2]; 48],
            velocity: [vec![[s(0.); 2]; CELLS], vec![[s(0.); 2]; CELLS]],
            receipts: vec![[[s(0.); 3]; 2]; CELLS],
            forces: vec![[s(0.); 2]; CELLS],
            scalar_rows: vec![s(0.); size],
            scales,
            first_source_failure: None,
            last_source_failure: None,
            leading_births: Vec::new(),
            leading_enthalpy: [[None; 2]; CELLS],
            leading_liquid_concentration: [None; CELLS],
            column_sign: 1.,
            jac_column_signs: vec![1.; size],
            first_mechanical_birth: None,
            started: Instant::now(),
            evaluations: 0,
            jacobians: 0,
            evaluation_wall: 0.,
            jacobian_wall: 0.,
            shaft_power: s(0.),
        },
        y,
        yp,
        ids,
        atol,
    )
}
#[test]
fn changed_void_section_work_uses_physical_profile_not_upwind_mass() {
    // Actual first-section parallel/serial weights, changed void, nonuniform
    // signed face flows and donor densities. This is an independent port-work
    // identity; it does not qualify a two-phase pump constitutive law.
    let weights = [0.5, 0.5, 0.5];
    let flow = [rec(1.2, 0.13), rec(-0.4, 0.07), rec(0.7, -0.11)];
    let aperture = rec(0.73, 0.08);
    let local_density = rec(650., -2.3);
    let drive = rec(2e5, 3e3);
    let profile = weights
        .iter()
        .zip(flow)
        .fold(s(0.), |sum, (w, q)| sum + s(*w) * q);
    let component_massflow = local_density * aperture * profile;
    let port_power = component_massflow / local_density * drive;
    let physical_force_power = weights
        .iter()
        .zip(flow)
        .fold(s(0.), |sum, (w, q)| sum + q * s(*w) * aperture * drive);
    let defect = port_power - physical_force_power;
    assert!(defect.value.abs() <= 8. * f64::EPSILON * port_power.value.abs());
    assert!(defect.direction.abs() <= 8. * f64::EPSILON * port_power.direction.abs());
    let donor_density = [510., 730., 610.];
    let donor_aperture = [0.9, 0.6, 0.82];
    let old_donor_mass = (0..3)
        .map(|j| weights[j] * donor_density[j] * donor_aperture[j] * flow[j].value)
        .sum::<f64>();
    assert!(
        (old_donor_mass / local_density.value * drive.value - port_power.value).abs()
            > 0.01 * port_power.value.abs()
    );
}

#[test]
fn numerical_empty_energy_admission_preserves_raw_values_and_rejects_excess() {
    let raw = [-1.3261133868407258e-45, 0., 10.];
    let before = raw.map(f64::to_bits);
    for energy in raw {
        assert!(empty_energy_ratio(energy, 10.).unwrap() <= 1.);
    }
    assert_eq!(raw.map(f64::to_bits), before);
    assert!(empty_energy_ratio(10.0001, 10.).is_err());
    assert!(empty_energy_ratio(-10.0001, 10.).is_err());
    assert!(empty_energy_ratio(f64::NAN, 10.).is_err());
    assert!(empty_energy_ratio(0., 0.).is_err());
}

fn water_tuple(q: WaterPoint) -> [f64; 13] {
    [
        q.pressure_pa,
        q.temperature_k,
        q.density_kg_m3,
        q.internal_energy_j_kg,
        q.enthalpy_j_kg,
        q.cp_j_kg_k,
        q.cv_j_kg_k,
        q.expansion_per_k,
        q.compressibility_per_pa,
        q.viscosity_pa_s,
        q.conductivity_w_m_k,
        q.saturation_slope_k_pa,
        q.region as f64,
    ]
}
fn saturation_tuple(q: thermal::Saturation) -> [[f64; 2]; 14] {
    let fields = [
        q.temperature,
        q.surface_tension,
        q.liquid.density,
        q.liquid.viscosity,
        q.liquid.conductivity,
        q.liquid.cp,
        q.liquid.expansion,
        q.liquid.enthalpy,
        q.vapor.density,
        q.vapor.viscosity,
        q.vapor.conductivity,
        q.vapor.cp,
        q.vapor.expansion,
        q.vapor.enthalpy,
    ];
    fields.map(|s| [s.value, s.direction])
}

#[test]
fn exact_current_property_reuse_matches_uncached_and_invalidates_every_key() {
    let mut slot = None;
    for (k, p, t) in [
        (0, 15e6, 600.),
        (0, 15.01e6, 600.2),
        (1, 15e6, 630.),
        (1, 15.01e6, 630.2),
    ] {
        let q = point(
            if k == 0 {
                Branch::Liquid
            } else {
                Branch::Vapor
            },
            p,
            t,
        )
        .unwrap();
        for enthalpy in [false, true] {
            let target = if enthalpy {
                q.enthalpy_j_kg
            } else {
                q.internal_energy_j_kg
            };
            for (dp, de) in [(0., 0.), (2e4, 0.), (0., 1000.), (-3e4, 3000.)] {
                let expected = inverse_water(rec(p, dp), rec(target, de), k, enthalpy).unwrap();
                let actual =
                    inverse_reusing(rec(p, dp), rec(target, de), k, enthalpy, Some(&mut slot))
                        .unwrap();
                assert_eq!(water_tuple(actual.0), water_tuple(expected.0));
                assert_eq!(water_tuple(actual.1), water_tuple(expected.1));
                assert_eq!(
                    slot.unwrap().key,
                    (p.to_bits(), target.to_bits(), k, enthalpy)
                );
            }
        }
    }
    assert!(inverse_reusing(s(17e6), s(1e6), 0, false, Some(&mut slot)).is_err());
    assert!(slot.is_none());
    let q = point(Branch::Liquid, 15e6, 600.).unwrap();
    inverse_reusing(
        s(15e6),
        s(q.internal_energy_j_kg),
        0,
        false,
        Some(&mut slot),
    )
    .unwrap();
    assert!(
        inverse_reusing(
            rec(15e6, f64::NAN),
            s(q.internal_energy_j_kg),
            0,
            false,
            Some(&mut slot)
        )
        .is_err()
    );
    assert!(slot.is_none());

    let mut sat = None;
    for p in [15e6, 15e6, 15.01e6] {
        assert_eq!(
            saturation_tuple(saturation_reusing(s(p), Some(&mut sat)).unwrap()),
            saturation_tuple(If97.saturation(s(p)).unwrap())
        );
        assert_eq!(sat.unwrap().0, p.to_bits());
        let before = saturation_tuple(sat.unwrap().1);
        assert_eq!(
            saturation_tuple(saturation_reusing(rec(p, 2e4), Some(&mut sat)).unwrap()),
            saturation_tuple(If97.saturation(rec(p, 2e4)).unwrap())
        );
        assert_eq!(saturation_tuple(sat.unwrap().1), before);
    }
    assert!(saturation_reusing(s(f64::NAN), Some(&mut sat)).is_err());
    assert!(sat.is_none());
}

fn verify_actual_reuse_and_raw_admission(packet: &Value) -> Value {
    // Algebraic evaluation only, at the actual preparation and a changed
    // pressure/energy/reverse-current Newton point. No alternate trajectory,
    // phase seed or changed solver parameter is introduced.
    let started = Instant::now();
    let (mut p, y, yp, _, _) = build(packet);
    p.select_leading_receipts(&y, &yp).unwrap();
    let mut changed = y.clone();
    changed[p.cell_layout[0].base] *= 1.000001;
    changed[p.cell_layout[0].energy[0]] *= 1.000001;
    changed[p.face_layout[0].index] = -1e-6;
    let mut row_comparisons = 0;
    for current in [&y, &changed] {
        // Production uses this exact same stack-local lifetime for one matrix.
        let mut reuse = JacobianReuse::default();
        p.evaluate(0., current, &yp, None, 0., None).unwrap();
        let signs: Vec<f64> = p
            .face_layout
            .iter()
            .map(|l| 1_f64.copysign(p.face_drive[l.face][l.phase].value))
            .collect();
        let mut column_signs = vec![1.; y.len()];
        for (l, sign) in p.face_layout.iter().zip(signs) {
            if current[l.index] == 0. {
                column_signs[l.index] = sign;
            }
        }
        for column in std::iter::once(None).chain((0..y.len()).map(Some)) {
            p.column_sign = column.map_or(1., |j| column_signs[j]);
            p.evaluate(0., current, &yp, column, 1.7, None).unwrap();
            let expected = p.scalar_rows.clone();
            p.evaluate(0., current, &yp, column, 1.7, Some(&mut reuse))
                .unwrap();
            for (actual, expected) in p.scalar_rows.iter().zip(expected) {
                assert_eq!(
                    [actual.value, actual.direction],
                    [expected.value, expected.direction]
                );
                row_comparisons += 1;
            }
        }
    }
    p.column_sign = 1.;
    let (_, ui) = p.stock_indices(27, 1);
    let mut raw = y.clone();
    raw[ui] = -1.3261133868407258e-45 / p.scales[ui];
    let before = raw.clone();
    let (_, admission) = p.inventory(&raw).unwrap();
    assert_eq!(raw, before);
    assert_eq!(
        n(
            &admission["empty_energy_residuals"],
            "sum_absolute_raw_energy_j"
        ),
        1.3261133868407258e-45
    );
    raw[ui] = -2. * ABSOLUTE_TOLERANCE;
    let before = raw.clone();
    assert!(p.inventory(&raw).is_err());
    assert_eq!(raw, before);
    json!({"kind":"actual-exact-reuse-and-nonclipping-admission-preflight","current_points":2,"residual_and_direction_rows_exactly_compared":row_comparisons,"wall_s":started.elapsed().as_secs_f64(),"raw_orphan_admission":admission,"scope":"algebraic preflight outside measured trajectory; exact per-matrix value reuse, current directions re-evaluated, no residual cache or state mutation"})
}

#[test]
#[ignore = "requires actual compiled owner packet, maintained IF97 and stock IDA/KLU"]
fn actual_38_volume_mechanical_trajectory() {
    let path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET").unwrap();
    let packet: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    println!("{}", verify_actual_reuse_and_raw_admission(&packet));
    let preparation_started = Instant::now();
    let (mut system, mut y, mut yp, ids, atol) = build(&packet);
    system.select_leading_receipts(&y, &yp).unwrap();
    let (initial_totals, initial_inventory) = system.inventory(&y).unwrap();
    let preparation_wall = preparation_started.elapsed().as_secs_f64();
    let size = y.len();
    let mut ida = Ida::new(
        system,
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: RELATIVE_TOLERANCE,
        },
    )
    .unwrap();
    let physical: Vec<usize> = ida
        .system()
        .cell_layout
        .iter()
        .flat_map(|l| [l.mass[0], l.mass[1], l.boron])
        .collect();
    ida.constrain_nonnegative(&physical).unwrap();
    let started = Instant::now();
    let mut time = 0.;
    let mut failure = ida.initialize(1e-3, &mut y, &mut yp).err();
    let initialization_wall = started.elapsed().as_secs_f64();
    let advance_started = Instant::now();
    let mut observations = Vec::new();
    let mut advance_segments = Vec::new();
    let mut diagnostic_wall = 0.;
    let mut diagnostic_evaluation_wall = 0.;
    let mut diagnostic_calls = 0;
    let mut output_admission_trace = None;
    let mut affected_owners = Vec::new();
    if failure.is_none() {
        failure = ida.stop_at(2.).err();
    }
    if failure.is_none() {
        for target in [0.001, 0.01, 0.1, 1., 2.] {
            let segment_started = Instant::now();
            let before = ida.stats().unwrap();
            let result = ida
                .advance(target, &mut y, &mut yp)
                .and_then(Advance::reached);
            let segment_wall = segment_started.elapsed().as_secs_f64();
            let after = ida.stats().unwrap();
            advance_segments.push(json!({"requested_time_s":target,"returned_success":result.is_ok(),"internal_time_before_s":before.internal_time,"internal_time_after_s":after.internal_time,"wall_s":segment_wall,"steps":after.steps-before.steps,"residuals":after.residuals-before.residuals,"jacobians":after.jacobians-before.jacobians,"error_failures":after.error_failures-before.error_failures,"last_step_s":after.last_step}));
            match result {
                Ok(t) => {
                    time = t;
                    let diagnostic_started = Instant::now();
                    let p = ida.system_mut();
                    let before_eval = p.evaluation_wall;
                    let before_calls = p.evaluations;
                    let diagnostic = (|| -> std::result::Result<Value, String> {
                        p.evaluate(t, &y, &yp, None, 0., None)
                            .map_err(|e| format!("accepted-output equation evaluation: {e:?}"))?;
                        let (totals, inventory) = match p.inventory(&y) {
                            Ok(value) => value,
                            Err(error) => {
                                affected_owners = p.orphan_energy_owners(&y);
                                output_admission_trace = Some(
                                    json!({"time_s":t,"raw_orphan_energy":affected_owners.iter().map(|(node,k)|p.phase_snapshot(*node,*k,&y,&yp)).collect::<Vec<_>>(),"current_budget":p.current_budget(&y,&yp),"strict_admission_failure":format!("{error:?}")}),
                                );
                                return Err(format!("accepted-output admission: {error:?}"));
                            }
                        };
                        let budget = p.current_budget(&y, &yp);
                        let mass_defect = totals[0] - initial_totals[0];
                        let boron_defect = totals[1] - initial_totals[1];
                        let mass_tolerance = RELATIVE_TOLERANCE * initial_totals[0]
                            + ABSOLUTE_TOLERANCE
                                * p.cell_layout
                                    .iter()
                                    .enumerate()
                                    .map(|(node, _)| {
                                        (0..2)
                                            .map(|k| p.stock_indices(node, k))
                                            .map(|(mi, _)| p.scales[mi])
                                            .sum::<f64>()
                                    })
                                    .sum::<f64>();
                        let boron_tolerance = RELATIVE_TOLERANCE * initial_totals[1]
                            + ABSOLUTE_TOLERANCE
                                * p.cell_layout
                                    .iter()
                                    .map(|l| l.boron)
                                    .map(|index| p.scales[index])
                                    .sum::<f64>();
                        if mass_defect.abs() > mass_tolerance
                            || boron_defect.abs() > boron_tolerance
                        {
                            return Err(format!(
                                "closed mechanical inventory drift M={mass_defect},B={boron_defect}"
                            ));
                        }
                        for (defect, scale) in [
                            ("mass_receipt_sum_kg_s", "mass_receipt_abs_sum_kg_s"),
                            ("boron_receipt_sum_kg_eq_s", "boron_receipt_abs_sum_kg_eq_s"),
                            (
                                "fluid_energy_minus_shaft_w",
                                "fluid_energy_receipt_abs_sum_w",
                            ),
                            (
                                "fluid_plus_rotor_plus_bearing_w",
                                "fluid_energy_receipt_abs_sum_w",
                            ),
                        ] {
                            if n(&budget, defect).abs() > 1e-10 * (1. + n(&budget, scale)) {
                                return Err(format!(
                                    "current reciprocal budget failed {defect}: {}",
                                    n(&budget, defect)
                                ));
                            }
                        }
                        Ok(
                            json!({"time_s":t,"inventory":inventory,"mass_defect_kg":mass_defect,"boron_defect_kg_eq":boron_defect,"mass_error_tolerance_kg":mass_tolerance,"boron_error_tolerance_kg_eq":boron_tolerance,"current_budget":budget}),
                        )
                    })();
                    diagnostic_evaluation_wall += p.evaluation_wall - before_eval;
                    diagnostic_calls += p.evaluations - before_calls;
                    diagnostic_wall += diagnostic_started.elapsed().as_secs_f64();
                    match diagnostic {
                        Ok(value) => observations.push(value),
                        Err(reason) => {
                            failure = Some(reason);
                            break;
                        }
                    }
                }
                Err(e) => {
                    failure = Some(e);
                    break;
                }
            }
        }
    }
    let internal_admission_trace = if failure.is_none() {
        None
    } else {
        let observed = Instant::now();
        let mut internal_y = y.clone();
        let mut internal_yp = yp.clone();
        let mut errors = vec![0.; y.len()];
        let mut weights = vec![0.; y.len()];
        let error_diagnostics = ida.error_diagnostics(&mut errors, &mut weights);
        let snapshot = match ida.current_state(&mut internal_y, &mut internal_yp) {
            Ok(tn) => {
                let p = ida.system_mut();
                let before_eval = p.evaluation_wall;
                let before_calls = p.evaluations;
                let evaluation = p.evaluate(tn, &internal_y, &internal_yp, None, 0., None);
                let account = error_diagnostics.map(|order| {
                    p.endpoint_error_account(&internal_y, &internal_yp, &errors, &weights, order)
                });
                let inventory = p
                    .inventory(&internal_y)
                    .map(|(_, v)| v)
                    .map_err(|e| format!("{e:?}"));
                let value = json!({"time_s":tn,"kind":"stock history evaluated at latest internal accepted endpoint; not output-buffer alias","equation_evaluation":format!("{evaluation:?}"),"matching_owners":affected_owners.iter().map(|(node,k)|p.phase_snapshot(*node,*k,&internal_y,&internal_yp)).collect::<Vec<_>>(),"numerical_inventory":inventory,"current_budget":if evaluation.is_ok(){Some(p.current_budget(&internal_y,&internal_yp))}else{None},"stock_error_account":account});
                diagnostic_evaluation_wall += p.evaluation_wall - before_eval;
                diagnostic_calls += p.evaluations - before_calls;
                value
            }
            Err(error) => json!({"snapshot_failure":error}),
        };
        diagnostic_wall += observed.elapsed().as_secs_f64();
        Some(snapshot)
    };
    let advance_wall = advance_started.elapsed().as_secs_f64();
    let p = ida.system();
    let stats=ida.stats().map(|s|json!({"steps":s.steps,"residuals":s.residuals,"jacobians":s.jacobians,"nonlinear_iterations":s.nonlinear_iterations,"error_failures":s.error_failures,"convergence_failures":s.convergence_failures,"last_step_s":s.last_step,"internal_time_s":s.internal_time}));
    println!(
        "{}",
        json!({"kind":"actual-source-failure-trace","first":p.first_source_failure,"last":p.last_source_failure})
    );
    println!(
        "{}",
        json!({
            "kind":"actual-local-pressure-mechanics-pilot","packet":path,
            "fluid_volumes":CELLS,"faces":48,"phase_paths":96,"unknowns":size,
            "simulation_time_s":time,"wall_s":started.elapsed().as_secs_f64(),
            "preparation_wall_s":preparation_wall,"initialization_wall_s":initialization_wall,
            "advance_wall_s":advance_wall-diagnostic_wall,"diagnostic_wall_s":diagnostic_wall,
            "diagnostic_calls":diagnostic_calls,"evaluation_calls":p.evaluations,
            "evaluation_wall_s":p.evaluation_wall,"solve_evaluation_wall_s":p.evaluation_wall-diagnostic_evaluation_wall,
            "jacobian_calls":p.jacobians,"jacobian_wall_s":p.jacobian_wall,"stats":stats,
            "initial_inventory":initial_inventory,"observations":observations,
            "advance_segments":advance_segments,
            "requested_output_admission":output_admission_trace,"internal_endpoint_admission":internal_admission_trace,
            "leading_births":p.leading_births,"first_mechanical_birth":p.first_mechanical_birth,
            "failure":failure,
            "scope":"test-only actual retained two-phase M/U/B in all38 volumes, local EOS, all96 physical generalized impulses. Existing liquid-carrier primary hydraulic ports use actual gasfraction/derating and adjoint physical throughput/aperture forces; four finite coastdown rotors pay shaft heat once. Actual PZR field; no absent T or epsilon stock. Primary/SURGE gas drag, interphase exchange and explicit advective vector-momentum receipts are isolated in this storage/pressure experiment, NOT a qualified HEM pump or complete mixed-passage mechanics. Current Scalar Jacobian with mass-cancelled phase rates; exact-zero birth/cold-rest is an explicitly selected one-sided/inexact chart, not a universal Cartesian derivative or full hot-state sparse strategy. No joined nuclear/solid/SG dynamics; SURGE passive drag/detailed nozzle loss not composed. NOT full A3 or whole-plant performance."
        })
    );
    assert!(
        failure.is_none(),
        "actual connected advancement blocked: {failure:?}"
    );
    assert_eq!(time, 2.);
}
