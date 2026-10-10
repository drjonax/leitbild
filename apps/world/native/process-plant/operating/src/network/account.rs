//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0013-coarse-local-pressure.md#numerical-absence-is-measured-not-projected
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hydraulics.md#bounded-low-mach-thermal-energy-remains-unchanged
//! Read-only physical admission and receipt accounting of accepted states.
//!
//! Nothing here mutates a coordinate. Exact-zero phase energy residue is
//! reported against the unchanged per-state solver error scale, never reset.
use super::{Failure, Network, Properties};
use serde_json::{Value, json};

/// Solver error scaling used for numerical admission of empty-phase energy.
#[derive(Clone, Copy, Debug)]
pub struct Tolerances<'a> {
    pub relative: f64,
    pub absolute: &'a [f64],
}

/// Numerical admission only: retain the raw conservative stock, do not
/// manufacture a phase/EOS point or change the exact empty-phase law.
pub fn empty_energy_ratio(energy: f64, allowance: f64) -> Result<f64, Failure> {
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

impl<P: Properties> Network<P> {
    pub fn orphan_energy_owners(&self, y: &[f64]) -> Vec<(usize, usize)> {
        (0..self.cells.len())
            .flat_map(|node| (0..2).map(move |k| (node, k)))
            .filter(|(node, k)| {
                let (mi, ui) = self.stock_indices(*node, *k);
                y[mi] == 0. && y[ui] != 0.
            })
            .collect()
    }

    pub fn phase_snapshot(
        &self,
        node: usize,
        k: usize,
        y: &[f64],
        yp: &[f64],
        tolerance: Tolerances<'_>,
    ) -> Value {
        let (mi, ui) = self.stock_indices(node, k);
        json!({"region":node,"phase":k,"mass_kg":y[mi]*self.scales[mi],"internal_energy_j":y[ui]*self.scales[ui],"solver_mass_rate_kg_s":yp[mi]*self.scales[mi],"solver_energy_rate_w":yp[ui]*self.scales[ui],"actual_mass_receipt_kg_s":self.receipts[node][k][0].value,"actual_enthalpy_receipt_w":self.receipts[node][k][1].value,"actual_energy_rhs_w":(yp[ui]-self.rows[ui].value)*self.scales[ui],"unchanged_solver_energy_allowance_j":self.scales[ui]*(tolerance.absolute[ui]+tolerance.relative*y[ui].abs())})
    }

    /// Admit accepted stocks: [mass, boron, fluid internal energy, rotor KE].
    pub fn inventory(
        &self,
        y: &[f64],
        tolerance: Tolerances<'_>,
    ) -> Result<([f64; 4], Value), Failure> {
        let mut total = [0.; 4];
        let mut present = 0;
        let mut absent = 0;
        let mut orphan_energy = Vec::new();
        let mut orphan_abs = 0.;
        let mut orphan_allowance = 0.;
        for node in 0..self.cells.len() {
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
                            * (tolerance.absolute[ui] + tolerance.relative * y[ui].abs());
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

    /// Current reciprocal mass/boron/energy/rotor budget of the last evaluation.
    pub fn current_budget(&self, y: &[f64], yp: &[f64]) -> Value {
        let mut mass = 0.;
        let mut boron = 0.;
        let mut energy = 0.;
        let mut rotor = 0.;
        let mut bearing = 0.;
        let mut mass_abs = 0.;
        let mut boron_abs = 0.;
        let mut energy_abs = 0.;
        for node in 0..self.cells.len() {
            for k in 0..2 {
                let (mi, ui) = self.stock_indices(node, k);
                let md = (yp[mi] - self.rows[mi].value) * self.scales[mi];
                let ud = (yp[ui] - self.rows[ui].value) * self.scales[ui];
                mass += md;
                energy += ud;
                mass_abs += md.abs();
                energy_abs += ud.abs();
            }
            let index = self.cell_layout[node].boron;
            let bd = (yp[index] - self.rows[index].value) * self.scales[index];
            boron += bd;
            boron_abs += bd.abs();
        }
        let mut motor_work = 0.;
        let mut electric = 0.;
        let mut motor_heat = 0.;
        for (r, index) in self.rotor_index.iter().enumerate() {
            let omega = y[*index] * self.scales[*index] / self.rotor_inertia;
            if let Some(law) = self.motor[r] {
                // dL/dt from the accepted rate; the row residual is not a rate.
                rotor += yp[*index] * self.scales[*index] * omega;
                bearing += law.drag_torque_nm.value * omega;
                motor_work += law.motor_work_w.value;
                electric += law.electric_w.value;
                motor_heat += law.motor_heat_w.value;
            }
        }
        let max_primary_void = self.cells[..self.pzr_begin]
            .iter()
            .map(|c| c.phase[1].map_or(0., |p| p.fraction.value))
            .fold(0., f64::max);
        let min_pump_liquid = self
            .sections
            .iter()
            .filter(|h| h.rotor.is_some())
            .map(|h| self.cells[h.region].phase[0].map_or(0., |p| p.fraction.value))
            .fold(1., f64::min);
        json!({"mass_receipt_sum_kg_s":mass,"mass_receipt_abs_sum_kg_s":mass_abs,"boron_receipt_sum_kg_eq_s":boron,"boron_receipt_abs_sum_kg_eq_s":boron_abs,"fluid_energy_receipt_sum_w":energy,"fluid_energy_receipt_abs_sum_w":energy_abs,"once_paid_shaft_power_w":self.shaft_power.value,"fluid_energy_minus_shaft_w":energy-self.shaft_power.value,"rotor_energy_rate_w":rotor,"bearing_loss_w":bearing,"motor_work_w":motor_work,"motor_electric_w":electric,"motor_conversion_heat_w":motor_heat,"fluid_plus_rotor_plus_bearing_minus_motor_w":energy+rotor+bearing-motor_work,"max_primary_void_fraction":max_primary_void,"min_pump_liquid_fraction":min_pump_liquid})
    }

    /// Coordinate labels: (category, label) for receipts and error accounts.
    pub fn labels(&self) -> Vec<(&'static str, String)> {
        let mut labels = vec![("", String::new()); self.scales.len()];
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
        labels
    }

    pub fn endpoint_error_account(
        &self,
        y: &[f64],
        yp: &[f64],
        errors: &[f64],
        weights: &[f64],
        order: i32,
    ) -> Value {
        let labels = self.labels();
        let mut indices: Vec<usize> = (0..y.len()).collect();
        indices.sort_by(|a, b| {
            (errors[*b] * weights[*b])
                .abs()
                .total_cmp(&(errors[*a] * weights[*a]).abs())
        });
        let entry = |j: usize| json!({"index":j,"coordinate":labels[j].1,"category":labels[j].0,"scaled_y":y[j],"physical_y":y[j]*self.scales[j],"physical_rate":yp[j]*self.scales[j],"physical_local_error_estimate":errors[j]*self.scales[j],"stock_reciprocal_scaled_error_weight":weights[j],"weighted_error":errors[j]*weights[j]});
        let categories: Vec<Value> = ["p", "M", "U", "B", "Pi", "rotor"]
            .iter()
            .map(|category| {
                let members: Vec<usize> = indices
                    .iter()
                    .copied()
                    .filter(|j| labels[*j].0 == *category)
                    .collect();
                let square_sum = members
                    .iter()
                    .map(|j| (errors[*j] * weights[*j]).powi(2))
                    .sum::<f64>();
                json!({"category":category,"coordinate_count":members.len(),"squared_weighted_error_sum":square_sum,"contribution_to_global_wrms_squared":square_sum/y.len() as f64,"top_coordinates":members.iter().take(3).map(|j|entry(*j)).collect::<Vec<_>>()})
            })
            .collect();
        let range = |values: Vec<f64>| json!({"min":values.iter().copied().reduce(f64::min),"max":values.iter().copied().reduce(f64::max)});
        let pressure = range(
            self.cell_layout
                .iter()
                .map(|l| y[l.base] * self.scales[l.base])
                .collect(),
        );
        let phase_ranges: Vec<Value> = (0..2)
            .map(|k| {
                let masses: Vec<f64> = (0..self.cells.len())
                    .map(|node| {
                        let (mi, _) = self.stock_indices(node, k);
                        y[mi] * self.scales[mi]
                    })
                    .collect();
                let energies: Vec<f64> = (0..self.cells.len())
                    .map(|node| {
                        let (_, ui) = self.stock_indices(node, k);
                        y[ui] * self.scales[ui]
                    })
                    .collect();
                json!({"phase":k,"positive_mass_min_kg":masses.iter().copied().filter(|m|*m>0.).reduce(f64::min),"mass_kg":range(masses),"internal_energy_j":range(energies),"volume_flow_m3_s":range(self.charts.iter().filter_map(|pair|pair[k].map(|c|c.volume_flow_m3_s.value)).collect())})
            })
            .collect();
        let wrms = (errors
            .iter()
            .zip(weights)
            .map(|(e, w)| (e * w).powi(2))
            .sum::<f64>()
            / y.len() as f64)
            .sqrt();
        json!({"current_bdf_order":order,"stock_estimated_local_error_wrms":wrms,"meaning":"stock last accepted-step estimated local error times stock current error weights; control uses global WRMS, not a per-coordinate threshold","top_coordinates":indices.iter().take(12).map(|j|entry(*j)).collect::<Vec<_>>(),"categories":categories,"pressure_pa":pressure,"phase_ranges":phase_ranges})
    }
}
