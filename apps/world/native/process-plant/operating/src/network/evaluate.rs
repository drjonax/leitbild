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
    CellVolume, Failure, Fluid, Network, PZR_COORDINATES, Properties,
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
        reuse: Option<&mut Reuse<P::Caloric>>,
    ) -> Result<(), Failure> {
        self.evaluate_coupled(t, y, yp, seed, cj, reuse, None)
    }

    /// [`Network::evaluate`] with an owner composed through the network's
    /// ports ([`super::ports`]): it reads this evaluation's cells and charts
    /// and adds its receipts before any section, momentum or stock row.
    #[allow(clippy::too_many_arguments)] // The network's stage inputs and its one port.
    pub fn evaluate_coupled(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
        seed: Option<&[f64]>,
        cj: f64,
        reuse: Option<&mut Reuse<P::Caloric>>,
        coupling: Option<&mut dyn super::Coupling>,
    ) -> Result<(), Failure> {
        self.evaluate_joined(t, y, yp, seed, cj, reuse, coupling, &[])
    }

    /// [`Network::evaluate_coupled`] with the moving bodies' cell volumes:
    /// `volumes` is empty (every cell at its compiled volume) or holds one
    /// [`CellVolume`] per regular cell, value and direction. A listed volume
    /// is the cell's in the EOS row, its phase fractions and its face
    /// inertance, and the phase elimination closes on `sum V_k' = V'`, so the
    /// fluid pays the boundary work `-p V'` once. A cell listed exactly at
    /// its compiled volume and at rest (value and direction) is fixed and
    /// evaluates bitwise as [`Network::evaluate_coupled`].
    #[allow(clippy::too_many_arguments)] // The network's stage inputs and its two ports.
    pub fn evaluate_joined(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
        seed: Option<&[f64]>,
        cj: f64,
        mut reuse: Option<&mut Reuse<P::Caloric>>,
        mut coupling: Option<&mut dyn super::Coupling>,
        volumes: &[CellVolume],
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
        if !volumes.is_empty() && volumes.len() != n {
            return Err(Failure::Fatal(format!(
                "{} cell volumes for {n} regular cells",
                volumes.len()
            )));
        }
        for node in 0..n {
            (self.cell_volume[node], self.cell_volume_rate[node]) =
                self.evaluated_volume(node, volumes)?;
        }
        self.receipts.fill([[s(0.); 3]; 2]);
        self.shaft_power = s(0.);
        let mut points: Vec<[Point; 2]> = vec![[None; 2]; n];
        for (node, current_point) in points.iter_mut().enumerate() {
            let (cell, point, row) =
                self.regular_cell(node, y, seed, self.cell_volume[node], reuse.as_deref_mut())?;
            self.cells[node] = cell;
            *current_point = point;
            self.rows[self.cell_layout[node].base] = row;
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
        let volumes = &self.cell_volume[..n];
        let pre_source_mass_rate = vec![s(0.); n];
        self.charts.fill([None; 2]);
        for l in &self.face_layout {
            let pi = self.get(y, seed, l.index);
            let f = &self.faces[l.face];
            let inertance = f.supports.iter().fold(s(0.), |sum, support| {
                sum + phase_mass[l.phase][support.region] / volumes[support.region]
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
        if let Some(coupling) = coupling.as_deref_mut() {
            self.couple(coupling, y, seed, &points, &phase_mass)?;
        }
        self.compose_sections(y, yp, seed, cj, &points)?;
        self.compose_momentum(t, y, yp, seed, cj, &phase_mass)?;
        self.compose_stocks(y, yp, seed, cj, &points, reuse)?;
        self.compose_stratified(column, y, yp, seed, cj, coupling)?;
        self.counters.evaluation_wall_s += started.elapsed().as_secs_f64();
        Ok(())
    }

    /// A regular cell's volume in this evaluation and, for a moving cell,
    /// its rate: the compiled volume unless `volumes` lists the cell off it
    /// or moving.
    fn evaluated_volume(
        &self,
        node: usize,
        volumes: &[CellVolume],
    ) -> Result<(thermal::Scalar, Option<thermal::Scalar>), Failure> {
        let compiled = (s(self.volumes[node]), None);
        let Some(c) = volumes.get(node) else {
            return Ok(compiled);
        };
        let (v, r) = (c.volume_m3, c.rate_m3_s);
        if ![v.value, v.direction, r.value, r.direction]
            .iter()
            .all(|x| x.is_finite())
            || v.value <= 0.
        {
            return Err(Failure::Recoverable(format!(
                "cell {node}: moving volume {v:?} and rate {r:?} are not a finite positive volume"
            )));
        }
        let fixed = v.value == self.volumes[node]
            && v.direction == 0.
            && r.value == 0.
            && r.direction == 0.;
        Ok(if fixed { compiled } else { (v, Some(r)) })
    }

    /// One regular cell at `(y, seed)` with its current volume: its state
    /// (pressure and present phases), each phase's caloric point and its
    /// EOS row, as every evaluation computes them.
    fn regular_cell(
        &self,
        node: usize,
        y: &[f64],
        seed: Option<&[f64]>,
        cell_volume: thermal::Scalar,
        mut reuse: Option<&mut Reuse<P::Caloric>>,
    ) -> Result<(Cell, [Point; 2], thermal::Scalar), Failure> {
        let l = self.cell_layout[node];
        let p = self.get(y, seed, l.base);
        let mut cell = Cell {
            pressure: p,
            phase: [None; 2],
        };
        let mut current_point: [Point; 2] = [None; 2];
        let mut volume = [s(0.); 2];
        for k in 0..2 {
            let mass = self.get(y, seed, l.mass[k]);
            let energy = self.get(y, seed, l.energy[k]);
            let q = if mass.value != 0. {
                Some(props::inverse_for(
                    &self.properties,
                    p,
                    energy / mass,
                    k,
                    false,
                    self.cell_need[node],
                    reuse.as_deref_mut().map(|r| (r, node)),
                )?)
            } else if let Some(h) = self.leading_enthalpy[node][k] {
                Some(props::inverse_for(
                    &self.properties,
                    p,
                    s(h),
                    k,
                    true,
                    self.cell_need[node],
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
        // The row keeps the compiled volume as its scale; a fixed cell's
        // current volume is that same value, so its row is unchanged.
        let row = (volume[0] + volume[1] - cell_volume) / s(self.volumes[node]);
        for k in 0..2 {
            let mass = self.get(y, seed, l.mass[k]);
            if !selected_phase(mass) {
                continue;
            }
            let Some((q, dq)) = current_point[k] else {
                continue;
            };
            let fraction = if k == l.phase {
                s(1.) - volume[1 - k] / cell_volume
            } else {
                volume[k] / cell_volume
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
            cell.phase[k] = Some(Phase {
                fraction,
                density: rec(q.density_kg_m3, dq.density_kg_m3),
                enthalpy: rec(q.enthalpy_j_kg, dq.enthalpy_j_kg),
                boron_concentration,
            });
        }
        Ok((cell, current_point, row))
    }

    /// The fluid view of the regular cells `cells` at `y` (values only, as
    /// an unseeded evaluation with the moving bodies' `volumes` computes
    /// them), handed to `read`: what a root function reads, without the
    /// rest of an evaluation. The network's own state is untouched. Every
    /// other cell holds a NaN pressure and no phase or point, and no face a
    /// chart, so a read beyond `cells` is refused or non-finite, never a
    /// stale value.
    pub fn cells_fluid<R>(
        &self,
        y: &[f64],
        volumes: &[CellVolume],
        cells: &[usize],
        read: impl FnOnce(&Fluid<'_>) -> R,
    ) -> Result<R, Failure> {
        let n = self.pzr.cell;
        if !volumes.is_empty() && volumes.len() != n {
            return Err(Failure::Fatal(format!(
                "{} cell volumes for {n} regular cells",
                volumes.len()
            )));
        }
        let none = s(f64::NAN);
        let mut states = vec![
            Cell {
                pressure: none,
                phase: [None; 2],
            };
            self.cells.len()
        ];
        let mut points: Vec<[Point; 2]> = vec![[None; 2]; n];
        let mut current = vec![none; n];
        let mut mass = [vec![none; n], vec![none; n]];
        let mut tracer = vec![none; n];
        for &node in cells {
            if node >= n {
                return Err(Failure::Fatal(format!(
                    "cell {node} is not one of the {n} regular cells"
                )));
            }
            let (volume, _) = self.evaluated_volume(node, volumes)?;
            let (cell, point, _) = self.regular_cell(node, y, None, volume, None)?;
            states[node] = cell;
            points[node] = point;
            current[node] = volume;
            for (k, m) in mass.iter_mut().enumerate() {
                m[node] = self.get(y, None, self.stock_indices(node, k).0);
            }
            tracer[node] = self.get(y, None, self.cell_layout[node].boron);
        }
        let charts = vec![[None; 2]; self.charts.len()];
        Ok(read(&Fluid {
            cells: &states,
            points: &points,
            liquid_mass: &mass[0],
            vapor_mass: &mass[1],
            tracer: &tracer,
            charts: &charts,
            endpoints: &self.endpoints,
            elevations: &self.elevations,
            volumes: &self.volumes,
            current_volumes: &current,
        }))
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
        // The inertance weight is the phase density M/V: a moving cell's rate
        // numerator is M' - M V'/V, a fixed cell's M'.
        let phase_mass_rate: [Vec<thermal::Scalar>; 2] = std::array::from_fn(|k| {
            (0..n)
                .map(|node| {
                    let receipt = self.receipts[node][k][0];
                    match self.cell_volume_rate[node] {
                        None => receipt,
                        Some(rate) => receipt - phase_mass[k][node] * rate / self.cell_volume[node],
                    }
                })
                .collect()
        });
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
                &self.cell_volume[..n],
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
                        Some(props::inverse_thermodynamic(
                            &self.properties,
                            pressure,
                            hd[k] / md[k],
                            k,
                            true,
                            reuse.as_deref_mut().map(|r| (r, node)),
                        )?)
                    } else if md[k].value == 0. && md[k].direction > 0. {
                        Some(props::inverse_thermodynamic(
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
            let rates = match self.cell_volume_rate[node] {
                None => phase::current_rates(pressure, therm, md, hd),
                Some(rate) => phase::current_rates_with_boundary(pressure, therm, md, hd, rate),
            }
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
            .position(|p| p.face == Some(self.pzr.port_face))
            .ok_or_else(|| Failure::Fatal("the port face has no PZR port".into()))
    }

    /// The stratified cell's port receipts in its port order: the surge
    /// port's is the liquid receipt `self.receipts[pzr]` of its face, and a
    /// spray or relief port, which no face carries, receives none (the
    /// relief's flow is the cell's own restriction). A vapor arrival through
    /// the surge port is outside the composed cell and refuses.
    pub(super) fn pzr_receipts(
        &self,
        surge: [[thermal::Scalar; 3]; 2],
    ) -> Result<Vec<stratified::Receipt>, Failure> {
        let [liquid, vapor] = surge;
        if vapor.iter().any(|q| q.value != 0. || q.direction != 0.) {
            return Err(Failure::Fatal(
                "a vapor receipt through the surge port is outside the composed stratified cell"
                    .into(),
            ));
        }
        let mut receipts =
            vec![stratified::Receipt::zero(); self.stratified.parameters().ports.len()];
        receipts[self.pzr_port()?] = stratified::Receipt {
            mass: liquid[0],
            enthalpy: liquid[1],
            boron: liquid[2],
        };
        Ok(receipts)
    }

    /// The stratified cell's 19 rows on this evaluation's column from its
    /// coordinates, rates, its port receipts and its boundary
    /// (`stratified::residual_on`): the coupled owner's
    /// ([`super::Coupling::pzr_boundary`]) on this column, or without a
    /// coupling the network's own closed one (S1).
    fn compose_stratified(
        &mut self,
        column: stratified::Column,
        y: &[f64],
        yp: &[f64],
        seed: Option<&[f64]>,
        cj: f64,
        coupling: Option<&mut dyn super::Coupling>,
    ) -> Result<(), Failure> {
        let x = self.pzr_coordinates(|i| self.get(y, seed, i))?;
        let rate = self.pzr_coordinates(|i| self.rate(yp, seed, cj, i))?;
        let receipts = self.pzr_receipts(self.receipts[self.pzr.cell])?;
        let scales: [f64; PZR_COORDINATES] = self.scales[self.pzr.coordinates()]
            .try_into()
            .map_err(|_| Failure::Fatal("PZR scale layout".into()))?;
        let coupled = coupling.is_some();
        let boundary = match coupling {
            Some(coupling) => coupling.pzr_boundary(&self.stratified, &column)?,
            None => self.uncoupled_pzr_boundary(),
        };
        let evaluation = self.stratified.residual_on(
            &self.properties,
            column,
            &x,
            &rate,
            &receipts,
            &boundary,
            &scales,
        )?;
        for (index, row) in self.pzr.coordinates().zip(evaluation.rows) {
            self.rows[index] = row;
        }
        if seed.is_none() {
            self.pzr_evaluation = Some(evaluation);
            self.pzr_boundary = Some((boundary, coupled));
        }
        Ok(())
    }
}
