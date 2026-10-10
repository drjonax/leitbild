//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hydraulics.md#local-pressure-and-phase-path-impulse
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hydraulics.md#bounded-low-mach-thermal-energy-remains-unchanged
//! One residual/direction evaluation of the composed network.
//!
//! A `seed` evaluates the directional derivative `dF/dy*d + cj*dF/dy'*d` in
//! the same pass as the values. Exact-zero stocks with a nonzero seed follow
//! the explicitly selected one-sided chart, never an epsilon phase. The
//! stratified PZR cell enters only through its integration point: its column
//! gives the port view the port face reads, and its rows take the port
//! receipts.
use super::{
    Failure, Network, PZR_COORDINATES, Properties,
    properties::{self as props, Reuse, Water},
    rec, s, selected_phase, stratified,
};
use crate::{
    hydraulics,
    local_flow::{self as flow, Cell, Phase},
    phase, rotor, thermal,
};
use serde_json::json;
use std::time::Instant;

type Point = Option<(Water, Water)>;

impl<P: Properties> Network<P> {
    /// Select only exact-zero phases with a positive leading receipt from the
    /// actual current physical face acceleration. No fixed region list, time
    /// threshold, stock seed, or absent-phase property query selects a birth.
    pub fn select_leading_receipts(&mut self, y: &[f64], yp: &[f64]) -> Result<(), Failure> {
        self.evaluate(0., y, yp, None, 0., None)?;
        let n = self.cells.len();
        let mut receipts = vec![[[0.; 3]; 2]; n];
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
            // The stratified cell takes every port receipt into its zones.
            if receiver == self.pzr.cell || self.cells[receiver].phase[l.phase].is_some() {
                continue;
            }
            let mass = c.mass_flow_kg_s.direction.abs();
            if mass > 0. {
                let donor_phase = self.cells[donor].phase[l.phase]
                    .ok_or_else(|| Failure::Fatal("leading donor phase absent".into()))?;
                receipts[receiver][l.phase][0] += mass;
                receipts[receiver][l.phase][1] += mass * donor_phase.enthalpy.value;
                receipts[receiver][l.phase][2] += mass * donor_phase.boron_concentration.value;
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
                let point = self
                    .properties
                    .caloric(k == 1, p, h, true)
                    .map_err(Failure::Fatal)?;
                let temperature = self.properties.values(&point).temperature_k;
                self.leading_enthalpy[node][k] = Some(h);
                if k == 0 {
                    self.leading_liquid_concentration[node] = Some(r[2] / r[0]);
                }
                self.leading_births.push(json!({"region":node,"phase":k,"leading_mass_receipt_kg_s2":r[0],"leading_enthalpy_receipt_w_s":r[1],"birth_enthalpy_j_kg":h,"temperature_k":temperature,"retained_mass_kg":0.,"retained_energy_j":0.,"selection":"positive leading actual physical face-acceleration receipt at t=0"}));
            }
        }
        Ok(())
    }

    /// Evaluate all residual rows into `rows()`; with `seed`, also directions.
    pub fn evaluate(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
        seed: Option<&[f64]>,
        cj: f64,
        mut reuse: Option<&mut Reuse<P::Caloric>>,
    ) -> Result<(), Failure> {
        if let Some((started, seconds)) = self.wall_budget
            && started.elapsed().as_secs_f64() > seconds
        {
            return Err(Failure::Fatal(format!(
                "network exceeded its prospective {seconds} s evaluation campaign budget"
            )));
        }
        let started = Instant::now();
        self.counters.evaluations += 1;
        let n = self.pzr.cell;
        self.receipts.fill([[s(0.); 3]; 2]);
        self.shaft_power = s(0.);
        let mut points: Vec<[Point; 2]> = vec![[None; 2]; n];
        for (node, current_point) in points.iter_mut().enumerate() {
            let l = self.cell_layout[node];
            let p = self.get(y, seed, l.base);
            self.cells[node] = Cell {
                pressure: p,
                phase: [None; 2],
            };
            let mut volume = [s(0.); 2];
            for k in 0..2 {
                let mass = self.get(y, seed, l.mass[k]);
                let energy = self.get(y, seed, l.energy[k]);
                let q = if mass.value != 0. {
                    Some(props::inverse(
                        &self.properties,
                        p,
                        energy / mass,
                        k,
                        false,
                        reuse.as_deref_mut().map(|r| (r, node)),
                    )?)
                } else if let Some(h) = self.leading_enthalpy[node][k] {
                    Some(props::inverse(
                        &self.properties,
                        p,
                        s(h),
                        k,
                        true,
                        reuse.as_deref_mut().map(|r| (r, node)),
                    )?)
                } else {
                    None
                };
                current_point[k] = q;
                if let Some((q, dq)) = q {
                    volume[k] = mass / rec(q.density_kg_m3, dq.density_kg_m3);
                }
            }
            self.rows[l.base] =
                (volume[0] + volume[1] - s(self.volumes[node])) / s(self.volumes[node]);
            for k in 0..2 {
                let mass = self.get(y, seed, l.mass[k]);
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
                let boron_concentration = if k == 0 {
                    if mass.value != 0. {
                        self.get(y, seed, l.boron) / mass
                    } else {
                        s(self.leading_liquid_concentration[node].ok_or_else(|| {
                            Failure::Recoverable(
                                "zero-stock liquid direction requires its responsible tracer receipt"
                                    .into(),
                            )
                        })?)
                    }
                } else {
                    s(0.)
                };
                self.cells[node].phase[k] = Some(Phase {
                    fraction,
                    density: rec(q.density_kg_m3, dq.density_kg_m3),
                    enthalpy: rec(q.enthalpy_j_kg, dq.enthalpy_j_kg),
                    boron_concentration,
                });
            }
        }
        // The stratified cell's column and the port view its port face reads.
        let column = self.stratified_column(y, seed, reuse.as_deref_mut())?;
        self.cells[self.pzr.cell] = self.stratified.port_view(&column, self.pzr_port()?)?;
        // Supports are regular cells only (validated at compile time).
        let phase_mass: [Vec<thermal::Scalar>; 2] = std::array::from_fn(|k| {
            (0..n)
                .map(|node| {
                    let (mi, _) = self.stock_indices(node, k);
                    self.get(y, seed, mi)
                })
                .collect()
        });
        let volumes = &self.volumes[..n];
        let pre_source_mass_rate = vec![s(0.); n];
        self.charts.fill([None; 2]);
        for l in &self.face_layout {
            let pi = self.get(y, seed, l.index);
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
                    &pre_source_mass_rate,
                    volumes,
                    pi,
                    s(0.),
                    flow::ColdOnset::Unavailable,
                )
                .map_err(|e| Failure::Recoverable(e.into()))?
            };
            let c = flow::chart_from_path(f, &self.cells, l.phase, pi, path).map_err(|e| {
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
            let flux = [c.mass_flow_kg_s, c.enthalpy_flow_w, c.boron_flow_kg_s];
            for (k, q) in flux.into_iter().enumerate() {
                self.receipts[f.from][l.phase][k] = self.receipts[f.from][l.phase][k] - q;
                self.receipts[f.to][l.phase][k] = self.receipts[f.to][l.phase][k] + q;
            }
        }
        self.compose_sections(y, yp, seed, cj, &points)?;
        self.compose_momentum(t, y, yp, seed, cj, &phase_mass)?;
        self.compose_stocks(y, yp, seed, cj, &points, reuse)?;
        self.compose_stratified(column, y, yp, seed, cj)?;
        self.counters.evaluation_wall_s += started.elapsed().as_secs_f64();
        Ok(())
    }

    fn compose_sections(
        &mut self,
        y: &[f64],
        yp: &[f64],
        seed: Option<&[f64]>,
        cj: f64,
        points: &[[Point; 2]],
    ) -> Result<(), Failure> {
        for j in 0..self.sections.len() {
            let region = self.sections[j].region;
            let liquid = self.cells[region].phase[0].ok_or_else(|| {
                Failure::Recoverable("liquid-carrier section has no liquid owner".into())
            })?;
            let (q, dq) = points[region][0].ok_or_else(|| {
                Failure::Recoverable("liquid-carrier section has no liquid EOS point".into())
            })?;
            // Constitutive section throughput is the adjoint of its authored
            // physical force profile. Upwind transported mass is NOT this port.
            let mut profile = s(0.);
            for (face, section, w) in &self.section_projection {
                if *section == j {
                    let chart = self.charts[*face][0].ok_or_else(|| {
                        Failure::Fatal("section projection face has no liquid chart".into())
                    })?;
                    profile = profile + s(*w) * chart.volume_flow_m3_s;
                }
            }
            let current = liquid.density * liquid.fraction * profile;
            let gas_fraction = self.cells[region].phase[1].map_or(s(0.), |p| p.fraction);
            let omega = self.sections[j].rotor.map_or(s(0.), |r| {
                self.get(y, seed, self.rotor_index[r]) / s(self.rotor_inertia)
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
            let e = self.sections[j]
                .section
                .evaluate(input, direction)
                .map_err(|e| Failure::Recoverable(e.to_string()))?;
            self.section_drive[j] = liquid.fraction
                * rec(
                    e.value.pump_euler_pa - e.value.passive_loss_pa,
                    e.direction.pump_euler_pa - e.direction.passive_loss_pa,
                );
            if let Some(r) = self.sections[j].rotor {
                let shaft = rec(e.value.shaft_power_w, e.direction.shaft_power_w);
                self.shaft_power = self.shaft_power + shaft;
                self.receipts[region][0][1] = self.receipts[region][0][1] + shaft;
                let index = self.rotor_index[r];
                let state = self.rotor_states[r].ok_or_else(|| {
                    Failure::Fatal("rotor drive/shaft state must be declared".into())
                })?;
                let law = self
                    .drive
                    .evaluate(
                        state.support,
                        state.shaft,
                        rotor::Input {
                            omega_rad_s: omega,
                            angular_momentum_rate_nm: self.rate(yp, seed, cj, index),
                            fluid_torque_nm: rec(
                                e.value.fluid_torque_nm,
                                e.direction.fluid_torque_nm,
                            ),
                        },
                    )
                    .map_err(|e| match e {
                        rotor::Error::InvalidInput | rotor::Error::NonfiniteResult => {
                            Failure::Recoverable(format!("rotor trial: {e:?}"))
                        }
                        _ => Failure::Fatal(format!("rotor law: {e:?}")),
                    })?;
                self.rows[index] = match law.rotor {
                    rotor::RotorRow::Free { residual_nm } => residual_nm / s(self.scales[index]),
                    rotor::RotorRow::Locked { residual_rad_s, .. } => {
                        residual_rad_s / s(self.drive.reference_omega_rad_s)
                    }
                };
                if seed.is_none() {
                    self.motor[r] = Some(law);
                }
            }
        }
        Ok(())
    }

    fn compose_momentum(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
        seed: Option<&[f64]>,
        cj: f64,
        phase_mass: &[Vec<thermal::Scalar>; 2],
    ) -> Result<(), Failure> {
        let n = self.pzr.cell;
        let phase_mass_rate: [Vec<thermal::Scalar>; 2] =
            std::array::from_fn(|k| (0..n).map(|node| self.receipts[node][k][0]).collect());
        for li in 0..self.face_layout.len() {
            let l = self.face_layout[li];
            let current = self.charts[l.face][l.phase]
                .ok_or_else(|| Failure::Fatal("face chart missing after source assembly".into()))?;
            // Liquid-carrier section drives are the only nonpressure forces.
            let mut force = s(0.);
            if l.phase == 0 {
                for (face, section, w) in &self.section_projection {
                    if *face == l.face {
                        force = force + s(*w) * self.section_drive[*section];
                    }
                }
            }
            // ProvenRest is the prepared all-zero-current case ONLY. This
            // network is not a generic disappearance/reappearance handler.
            // Cold I' uses assembled physical receipts, not an off-row yp.
            let pi = self.get(y, seed, l.index);
            let path = flow::phase_path_kinematics(
                &self.faces[l.face],
                &phase_mass[l.phase],
                &phase_mass_rate[l.phase],
                &self.volumes[..n],
                pi,
                force + current.pressure_gravity_pa,
                flow::ColdOnset::ProvenRest,
            )
            .map_err(|e| {
                self.first_mechanical_birth.get_or_insert(json!({"time_s":t,"face":l.face,"phase":l.phase,"inertance_kg_m4":current.inertance_kg_m4.value,"total_force_pa":(force+current.pressure_gravity_pa).value,"scope":"unsupported exact-zero physical onset; no guessed Q, phase seed or momentum reset"}));
                Failure::Recoverable(format!("{e}; t={t},face={},phase={}", l.face, l.phase))
            })?;
            let chart = flow::chart_from_path(&self.faces[l.face], &self.cells, l.phase, pi, path)
                .map_err(|e| Failure::Recoverable(e.into()))?;
            self.charts[l.face][l.phase] = Some(chart);
            self.face_drive[l.face][l.phase] = force + chart.pressure_gravity_pa;
            self.rows[l.index] =
                flow::momentum_residual(self.rate(yp, seed, cj, l.index), chart, force)
                    .map_err(|e| Failure::Recoverable(e.into()))?
                    / s(self.scales[l.index]);
        }
        Ok(())
    }

    fn compose_stocks(
        &mut self,
        y: &[f64],
        yp: &[f64],
        seed: Option<&[f64]>,
        cj: f64,
        points: &[[Point; 2]],
        mut reuse: Option<&mut Reuse<P::Caloric>>,
    ) -> Result<(), Failure> {
        for (node, node_points) in points.iter().enumerate() {
            let l = self.cell_layout[node];
            let index = l.boron;
            self.rows[index] = (self.rate(yp, seed, cj, index) - self.receipts[node][0][2])
                / s(self.scales[index]);
            let mut therm = [None; 2];
            let pressure = self.get(y, seed, l.base);
            let md = std::array::from_fn(|k| self.receipts[node][k][0]);
            let hd = std::array::from_fn(|k| self.receipts[node][k][1]);
            for (k, phase) in therm.iter_mut().enumerate() {
                let receipt_point = if node_points[k].is_none() {
                    if md[k].value > 0. {
                        Some(props::inverse(
                            &self.properties,
                            pressure,
                            hd[k] / md[k],
                            k,
                            true,
                            reuse.as_deref_mut().map(|r| (r, node)),
                        )?)
                    } else if md[k].value == 0. && md[k].direction > 0. {
                        Some(props::inverse(
                            &self.properties,
                            pressure,
                            s(hd[k].direction / md[k].direction),
                            k,
                            true,
                            reuse.as_deref_mut().map(|r| (r, node)),
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
                    mass: self.get(y, seed, l.mass[k]),
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
                self.rows[l.mass[k]] =
                    (self.rate(yp, seed, cj, l.mass[k]) - *mass_rate) / s(self.scales[l.mass[k]]);
                self.rows[l.energy[k]] = (self.rate(yp, seed, cj, l.energy[k])
                    - rates.internal_energy_rate_w[k])
                    / s(self.scales[l.energy[k]]);
            }
        }
        Ok(())
    }

    /// The stratified cell's coordinates (or rates) in physical units.
    fn pzr_coordinates(
        &self,
        values: impl Fn(usize) -> thermal::Scalar,
    ) -> Result<stratified::Coordinates, Failure> {
        let x: Vec<thermal::Scalar> = self.pzr.coordinates().map(values).collect();
        stratified::Coordinates::from_slice(&x)
    }

    /// The stratified cell's column at the current coordinates: three zone
    /// inversions and two saturations, once per residual
    /// (`stratified::column`).
    fn stratified_column(
        &mut self,
        y: &[f64],
        seed: Option<&[f64]>,
        reuse: Option<&mut Reuse<P::Caloric>>,
    ) -> Result<stratified::Column, Failure> {
        let x = self.pzr_coordinates(|i| self.get(y, seed, i))?;
        let slots = self.pzr_slots();
        let column = self
            .stratified
            .column(&self.properties, &x, reuse.map(|r| (r, slots)))?;
        self.counters.pzr_columns += 1;
        if seed.is_none() {
            self.pzr_column = Some(column);
        }
        Ok(column)
    }
    /// The cell's port read by the port face.
    fn pzr_port(&self) -> Result<usize, Failure> {
        self.stratified
            .parameters()
            .ports
            .iter()
            .position(|p| p.face == self.pzr.port_face)
            .ok_or_else(|| Failure::Fatal("the port face has no PZR port".into()))
    }

    /// The stratified cell's 17 rows on this evaluation's column from its
    /// coordinates, rates and the liquid port receipt `self.receipts[pzr]`
    /// (`stratified::residual_on`, no property call). S1 composes no zone
    /// heat; a vapor arrival through the surge port is outside the composed
    /// cell and refuses.
    fn compose_stratified(
        &mut self,
        column: stratified::Column,
        y: &[f64],
        yp: &[f64],
        seed: Option<&[f64]>,
        cj: f64,
    ) -> Result<(), Failure> {
        let x = self.pzr_coordinates(|i| self.get(y, seed, i))?;
        let rate = self.pzr_coordinates(|i| self.rate(yp, seed, cj, i))?;
        let [liquid, vapor] = self.receipts[self.pzr.cell];
        if vapor.iter().any(|q| q.value != 0. || q.direction != 0.) {
            return Err(Failure::Fatal(
                "a vapor receipt through the surge port is outside the composed stratified cell"
                    .into(),
            ));
        }
        let receipts = [stratified::Receipt {
            mass: liquid[0],
            enthalpy: liquid[1],
            boron: liquid[2],
        }];
        let scales: [f64; PZR_COORDINATES] = self.scales[self.pzr.coordinates()]
            .try_into()
            .map_err(|_| Failure::Fatal("PZR scale layout".into()))?;
        let evaluation = self.stratified.residual_on(
            column,
            &x,
            &rate,
            &receipts,
            stratified::Heat::zero(),
            &scales,
        )?;
        for (index, row) in self.pzr.coordinates().zip(evaluation.rows) {
            self.rows[index] = row;
        }
        if seed.is_none() {
            self.pzr_evaluation = Some(evaluation);
        }
        Ok(())
    }
}
