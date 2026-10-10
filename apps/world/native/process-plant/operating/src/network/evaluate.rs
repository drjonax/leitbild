//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hydraulics.md#local-pressure-and-phase-path-impulse
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hydraulics.md#bounded-low-mach-thermal-energy-remains-unchanged
//! One residual/direction evaluation of the composed network.
//!
//! A `seed` evaluates the directional derivative `dF/dy*d + cj*dF/dy'*d` in
//! the same pass as the values. Exact-zero stocks with a nonzero seed follow
//! the explicitly selected one-sided chart, never an epsilon phase.
use super::{
    Failure, Network, Properties,
    properties::{self as props, Reuse, Water},
    rec, s, selected_phase,
};
use crate::{
    hydraulics,
    local_flow::{self as flow, Cell, Phase},
    phase, pzr_field as pf, thermal,
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
            if self.cells[receiver].phase[l.phase].is_some() {
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
        let n = self.cells.len();
        self.receipts.fill([[s(0.); 3]; 2]);
        self.velocity[0].fill([s(0.); 2]);
        self.velocity[1].fill([s(0.); 2]);
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
        let phase_mass: [Vec<thermal::Scalar>; 2] = std::array::from_fn(|k| {
            (0..n)
                .map(|node| {
                    let (mi, _) = self.stock_indices(node, k);
                    self.get(y, seed, mi)
                })
                .collect()
        });
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
                    &self.volumes,
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
            flow::add_mean_velocity(
                &self.projections[l.face],
                c.volume_flow_m3_s,
                &mut self.velocity[l.phase],
            )
            .map_err(|e| Failure::Fatal(e.into()))?;
            if l.face < self.first_pzr_face {
                let flux = [c.mass_flow_kg_s, c.enthalpy_flow_w, c.boron_flow_kg_s];
                for (k, q) in flux.into_iter().enumerate() {
                    self.receipts[f.from][l.phase][k] = self.receipts[f.from][l.phase][k] - q;
                    self.receipts[f.to][l.phase][k] = self.receipts[f.to][l.phase][k] + q;
                }
            }
        }
        self.compose_pzr_field(t, y, seed, &points, reuse.as_deref_mut())?;
        self.compose_sections(y, yp, seed, cj, &points)?;
        self.compose_momentum(t, y, yp, seed, cj, &phase_mass)?;
        self.compose_stocks(y, yp, seed, cj, &points, reuse)?;
        self.counters.evaluation_wall_s += started.elapsed().as_secs_f64();
        Ok(())
    }

    fn compose_pzr_field(
        &mut self,
        t: f64,
        y: &[f64],
        seed: Option<&[f64]>,
        points: &[[Point; 2]],
        mut reuse: Option<&mut Reuse<P::Caloric>>,
    ) -> Result<(), Failure> {
        let begin = self.pzr_begin;
        let mut phases = [[None; 2]; pf::REGIONS];
        let pressure: [thermal::Scalar; pf::REGIONS] =
            std::array::from_fn(|j| self.cells[begin + j].pressure);
        let mut saturation = [thermal::Saturation::default(); pf::REGIONS];
        let mut face_saturation = [thermal::Saturation::default(); pf::FACES];
        for j in 0..pf::REGIONS {
            let node = begin + j;
            let l = self.cell_layout[node];
            for k in 0..2 {
                let Some((q, dq)) = points[node][k] else {
                    continue;
                };
                let mass = self.get(y, seed, l.mass[k]);
                if !selected_phase(mass) {
                    continue;
                }
                let boron = if k == 0 {
                    self.get(y, seed, l.boron)
                } else {
                    s(0.)
                };
                let volume = if k == l.phase {
                    if let Some((born_q, born_dq)) = points[node][1 - k] {
                        s(self.volumes[node])
                            - self.get(y, seed, l.mass[1 - k])
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
            saturation[j] = props::saturation(
                &self.properties,
                pressure[j],
                reuse.as_deref_mut().map(|r| (r, j)),
            )?;
        }
        for (j, sat) in face_saturation.iter_mut().enumerate() {
            let f = &self.faces[self.first_pzr_face + j];
            if f.pressure_segments.len() != 2 {
                return Err(Failure::Fatal(
                    "actual PZR interface requires its two authored centroid segments".into(),
                ));
            }
            let p = flow::pressure_after_segments(f, &self.cells, 1)
                .map_err(|e| Failure::Fatal(e.into()))?;
            *sat = props::saturation(
                &self.properties,
                p,
                reuse.as_deref_mut().map(|r| (r, pf::REGIONS + j)),
            )?;
        }
        let currents: [[thermal::Scalar; 2]; pf::FACES] = std::array::from_fn(|j| {
            std::array::from_fn(|k| {
                self.charts[self.first_pzr_face + j][k].map_or(s(0.), |c| c.mass_flow_kg_s)
            })
        });
        let mut external = [[pf::Sources::default(); 2]; pf::REGIONS];
        for (j, row) in external.iter_mut().enumerate() {
            let node = begin + j;
            for (k, source) in row.iter_mut().enumerate() {
                source.mass = self.receipts[node][k][0];
                source.enthalpy = self.receipts[node][k][1];
                source.boron = self.receipts[node][k][2];
            }
        }
        let inflow = self.surge_to_pzr_face;
        if let Some(c) = self.charts[inflow][0] {
            let node = self.faces[inflow].to;
            let j = node - begin;
            let v = if c.mass_flow_kg_s.value >= 0. {
                [
                    s(0.),
                    c.volume_flow_m3_s / s(self.faces[inflow].flow_area_m2),
                ]
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
            self.trace_field_failure(t, y, seed, &phases, points, error);
            return Err(Failure::Recoverable(error.into()));
        }
        for j in 0..pf::REGIONS {
            let node = begin + j;
            for k in 0..2 {
                let r = self.work.sources[j][k];
                self.receipts[node][k] = [r.mass, r.enthalpy, r.boron];
            }
        }
        Ok(())
    }

    /// Error-only trace of the existing selector, not a second source law.
    fn trace_field_failure(
        &mut self,
        t: f64,
        y: &[f64],
        seed: Option<&[f64]>,
        phases: &[[Option<pf::Phase>; 2]; pf::REGIONS],
        points: &[[Point; 2]],
        error: &str,
    ) {
        let begin = self.pzr_begin;
        let pair = |v: thermal::Scalar| [v.value, v.direction];
        let mut contrasts = Vec::new();
        for (j, f) in self.faces[self.first_pzr_face..].iter().enumerate() {
            let from = f.from - begin;
            let to = f.to - begin;
            let fraction = |i: usize, k: usize| {
                phases[i][k].map_or(s(0.), |p| p.volume / s(self.volumes[begin + i]))
            };
            let contrast =
                fraction(from, 0) * fraction(to, 1) - fraction(to, 0) * fraction(from, 1);
            if contrast.value == 0. && contrast.direction == 0. {
                continue;
            }
            let forward = contrast.value > 0. || (contrast.value == 0. && contrast.direction > 0.);
            let (li, gi) = if forward { (from, to) } else { (to, from) };
            if phases[li][0].is_some() && phases[gi][1].is_some() {
                continue;
            }
            let endpoints: Vec<serde_json::Value> = [from, to]
                .into_iter()
                .map(|i| {
                    let node = begin + i;
                    let states: Vec<serde_json::Value> = (0..2)
                        .map(|k| {
                            let (mi, ui) = self.stock_indices(node, k);
                            json!({"phase":k,"mass_kg":pair(self.get(y,seed,mi)),"energy_j":pair(self.get(y,seed,ui)),"source_volume_m3":phases[i][k].map(|p|pair(p.volume)),"source_present":phases[i][k].is_some(),"property_point_present":points[node][k].is_some(),"leading_enthalpy_j_kg":self.leading_enthalpy[node][k]})
                        })
                        .collect();
                    json!({"region":node,"phase_states":states})
                })
                .collect();
            contrasts.push(json!({"face":self.first_pzr_face+j,"from":f.from,"to":f.to,"contrast":pair(contrast),"liquid_recipient":begin+li,"vapor_recipient":begin+gi,"endpoints":endpoints}));
        }
        let trace = json!({"error":error,"time_s":t,"seeded":seed.is_some(),"contrasts":contrasts});
        self.first_source_failure.get_or_insert(trace.clone());
        self.last_source_failure = Some(trace);
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
                self.rows[index] = (self.rate(yp, seed, cj, index)
                    + rec(e.value.fluid_torque_nm, e.direction.fluid_torque_nm)
                    + s(self.rotor_drag) * omega)
                    / s(self.scales[index]);
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
        let n = self.cells.len();
        let phase_mass_rate: [Vec<thermal::Scalar>; 2] =
            std::array::from_fn(|k| (0..n).map(|node| self.receipts[node][k][0]).collect());
        for li in 0..self.face_layout.len() {
            let l = self.face_layout[li];
            let current = self.charts[l.face][l.phase]
                .ok_or_else(|| Failure::Fatal("face chart missing after source assembly".into()))?;
            let mut force = s(0.);
            if l.phase == 0 {
                for (face, section, w) in &self.section_projection {
                    if *face == l.face {
                        force = force + s(*w) * self.section_drive[*section];
                    }
                }
            }
            self.forces.fill([s(0.); 2]);
            for j in 0..pf::REGIONS {
                self.forces[self.pzr_begin + j] = self.work.sources[j][l.phase].momentum;
            }
            force = force
                + flow::project_nonpressure(&self.projections[l.face], &self.forces)
                    .map_err(|e| Failure::Fatal(e.into()))?;
            // ProvenRest is the prepared all-zero-current case ONLY. This
            // network is not a generic disappearance/reappearance handler.
            // Cold I' uses assembled physical receipts, not an off-row yp.
            let pi = self.get(y, seed, l.index);
            let path = flow::phase_path_kinematics(
                &self.faces[l.face],
                &phase_mass[l.phase],
                &phase_mass_rate[l.phase],
                &self.volumes,
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
}
