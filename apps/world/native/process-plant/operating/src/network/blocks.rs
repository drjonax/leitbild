//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#6-solver-properties-and-cost-obligations
//! Block stage-Jacobian assembly `dF/dy + cj*dF/dy'` of the composed network.
//!
//! Each column's exact directional response is evaluated on the elements
//! that read that column only: the owning cell's caloric points, EOS row and
//! face view (or the stratified PZR column and its port view), the stage-one
//! face charts that read it, their receipts, the liquid-carrier sections and
//! rotors, the impulse rows, the stock rows and the PZR rows. Every element
//! is the residual's own constitutive call on the residual's own inputs, in
//! the residual's order, so a column's entries are those the colored
//! assembly obtains for it: one-sided charts at exact-zero stocks or flows
//! follow the column's own seed exactly as there. Elements that do not read
//! the column keep their base values with zero direction.
//!
//! Property directions come from each recovered point's two unit
//! directions, in pressure and in its caloric target, and from each
//! saturation tuple's unit pressure direction. Both are evaluated once per
//! assembly at exactly that point through the same property boundary (exact
//! Gibbs first partials and its disclosed coefficient probes) and combined
//! linearly; nothing survives the assembly. Points recovered from an
//! enthalpy target (births) take the boundary's own direction unheld.
//!
//! The same replay serves a joined operator ([`Replay`]): it mirrors
//! [`Network::evaluate_joined`], with the moving cells' current volumes in
//! the EOS rows, phase fractions, inertances, onset mass rates and the
//! bounded phase-rate closure, and the coupled owners' receipts added after
//! the face charts' as there. After each column's charts a
//! [`LocalCoupling`] gives the coupled owners' receipt directions for that
//! column, and a non-network column enters through its receipt and volume
//! directions ([`NetworkSeed`]).
//!
//! The base pass recomputes every row value and refuses (Fatal) unless each
//! is bitwise the residual's, so this assembly cannot differentiate another
//! composition. A response outside the compiled pattern, or a nonfinite
//! one, refuses. Nothing falls back to another assembly.
use super::{
    Failure, Fluid, Network, PZR_COORDINATES, Properties, Receipts,
    properties::{self as props, BandReport, MetastableBand, Reuse, Water},
    rec, s, selected_phase, stratified,
};
use crate::{
    hydraulics,
    local_flow::{self as flow, Cell, Chart, Phase},
    phase, rotor,
    sparse::Pattern,
    thermal::{Saturation, Scalar, WaterPoint},
};
use std::{cell::RefCell, time::Instant};

type Point = Option<(Water, Water)>;

/// What a column is: one coordinate of a regular cell, of the stratified
/// PZR cell, a phase-path impulse or a rotor momentum.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Owner {
    Cell(usize, Coordinate),
    Pzr,
    Impulse(usize),
    Rotor(usize),
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum Coordinate {
    Pressure,
    Mass(usize),
    Energy(usize),
    Boron,
}

/// Compiled structure of the block assembly, built once: the structural
/// pattern of [`Network::sparse_jacobian`] (so the linear solver's analysis
/// is the colored assembly's) and the element incidence of every column.
pub struct BlockJacobian {
    pub pattern: Pattern,
    owner: Vec<Owner>,
    /// Face layouts whose chart reads a cell (endpoints and pressure segments).
    reading: Vec<Vec<usize>>,
    /// Per phase and regular cell: face layouts of that phase it supports.
    supporting: [Vec<Vec<usize>>; 2],
    /// Sections whose region is the regular cell.
    sections_of: Vec<Vec<usize>>,
    /// Per face layout: sections whose throughput projects its volume flow.
    profiled_by: Vec<Vec<usize>>,
    /// Per section: face layouts whose impulse row receives its force.
    forcing: Vec<Vec<usize>>,
    /// Section of each rotor.
    rotor_section: Vec<usize>,
    /// The stratified cell's port read by the port face.
    port: usize,
}
impl BlockJacobian {
    pub fn columns(&self) -> usize {
        self.owner.len()
    }
}

/// Exact assembly-local property directions: each point's held unit
/// directions, combined linearly. A delegating implementation of
/// [`Properties`], so the stratified cell owner's own column takes them.
/// Built for one assembly and dropped with it.
pub struct Held<'a, P: Properties> {
    inner: &'a P,
    /// (p, T, rho) bits of a recovered internal-energy point, and its unit
    /// pressure and caloric-target directions.
    points: RefCell<Vec<([u64; 3], Water, Water)>>,
    /// Pressure bits, saturation value and unit pressure direction.
    saturations: RefCell<Vec<(u64, Saturation, Saturation)>>,
}
impl<'a, P: Properties> Held<'a, P> {
    pub fn new(inner: &'a P) -> Self {
        Self {
            inner,
            points: RefCell::new(Vec::new()),
            saturations: RefCell::new(Vec::new()),
        }
    }
}
fn along(a: &Water, b: &Water, dp: f64, de: f64) -> Water {
    let f = |x: f64, y: f64| dp * x + de * y;
    Water {
        pressure_pa: f(a.pressure_pa, b.pressure_pa),
        temperature_k: f(a.temperature_k, b.temperature_k),
        density_kg_m3: f(a.density_kg_m3, b.density_kg_m3),
        internal_energy_j_kg: f(a.internal_energy_j_kg, b.internal_energy_j_kg),
        enthalpy_j_kg: f(a.enthalpy_j_kg, b.enthalpy_j_kg),
        cp_j_kg_k: f(a.cp_j_kg_k, b.cp_j_kg_k),
        expansion_per_k: f(a.expansion_per_k, b.expansion_per_k),
        compressibility_per_pa: f(a.compressibility_per_pa, b.compressibility_per_pa),
        viscosity_pa_s: f(a.viscosity_pa_s, b.viscosity_pa_s),
        conductivity_w_m_k: f(a.conductivity_w_m_k, b.conductivity_w_m_k),
    }
}
fn scaled(value: Scalar, unit: Scalar, dp: f64) -> Scalar {
    Scalar::new(value.value, dp * unit.direction)
}
fn scaled_point(value: WaterPoint, unit: WaterPoint, dp: f64) -> WaterPoint {
    WaterPoint {
        density: scaled(value.density, unit.density, dp),
        viscosity: scaled(value.viscosity, unit.viscosity, dp),
        conductivity: scaled(value.conductivity, unit.conductivity, dp),
        cp: scaled(value.cp, unit.cp, dp),
        expansion: scaled(value.expansion, unit.expansion, dp),
        enthalpy: scaled(value.enthalpy, unit.enthalpy, dp),
    }
}
impl<P: Properties> Properties for Held<'_, P> {
    type Caloric = P::Caloric;
    fn forward(&self, vapor: bool, pressure_pa: f64, temperature_k: f64) -> Result<Water, String> {
        self.inner.forward(vapor, pressure_pa, temperature_k)
    }
    /// Internal-energy targets only: an enthalpy point would share its
    /// (p, T, rho) key with a different direction map.
    fn caloric(
        &self,
        vapor: bool,
        pressure_pa: f64,
        target: f64,
        enthalpy: bool,
    ) -> Result<Self::Caloric, String> {
        if enthalpy {
            return Err(
                "the block assembly holds directions of internal-energy points only".into(),
            );
        }
        self.inner.caloric(vapor, pressure_pa, target, false)
    }
    fn values(&self, point: &Self::Caloric) -> Water {
        self.inner.values(point)
    }
    fn direction(&self, point: &Self::Caloric, dp: f64, dtarget: f64) -> Result<Water, String> {
        if dp == 0. && dtarget == 0. {
            return Ok(Water::default());
        }
        let q = self.inner.values(point);
        let key = [
            q.pressure_pa.to_bits(),
            q.temperature_k.to_bits(),
            q.density_kg_m3.to_bits(),
        ];
        let mut points = self.points.borrow_mut();
        let index = match points.iter().position(|(k, ..)| *k == key) {
            Some(index) => index,
            None => {
                let pressure = self.inner.direction(point, 1., 0.)?;
                let target = self.inner.direction(point, 0., 1.)?;
                points.push((key, pressure, target));
                points.len() - 1
            }
        };
        let (_, pressure, target) = &points[index];
        Ok(along(pressure, target, dp, dtarget))
    }
    fn saturation(&self, pressure: Scalar) -> Result<Saturation, String> {
        if pressure.direction == 0. {
            return self.inner.saturation(pressure);
        }
        let key = pressure.value.to_bits();
        let mut held = self.saturations.borrow_mut();
        let index = match held.iter().position(|(k, ..)| *k == key) {
            Some(index) => index,
            None => {
                let unit = self.inner.saturation(Scalar::new(pressure.value, 1.))?;
                held.push((key, unit, unit));
                held.len() - 1
            }
        };
        let (_, value, unit) = &held[index];
        let dp = pressure.direction;
        Ok(Saturation {
            temperature: scaled(value.temperature, unit.temperature, dp),
            liquid: scaled_point(value.liquid, unit.liquid, dp),
            vapor: scaled_point(value.vapor, unit.vapor, dp),
            surface_tension: scaled(value.surface_tension, unit.surface_tension, dp),
        })
    }
    fn metastable_band(&self) -> Result<MetastableBand, String> {
        self.inner.metastable_band()
    }
    fn band(&self, point: &Self::Caloric) -> BandReport {
        self.inner.band(point)
    }
}

/// One evaluation's values, and during a column pass that column's
/// directions, of every element output the rows read.
#[derive(Clone)]
struct Pass {
    /// Regular cells' face views, then the PZR port view.
    cells: Vec<Cell>,
    points: Vec<[Point; 2]>,
    phase_mass: [Vec<Scalar>; 2],
    /// Supporting cells' phase mass receipts, read by the impulse rows.
    mass_rate: [Vec<Scalar>; 2],
    column: stratified::Column,
    /// Stage-one charts by face and phase, as the coupling reads them.
    charts: Vec<[Option<Chart>; 2]>,
    receipts: Vec<[[Scalar; 3]; 2]>,
    section_drive: Vec<Scalar>,
    rows: Vec<Scalar>,
    /// Base pass: the impulse row's path has exactly zero inertance.
    cold: Vec<bool>,
    /// Regular cells: current free volume, and its rate for a moving cell.
    volume: Vec<Scalar>,
    volume_rate: Vec<Option<Scalar>>,
    /// Regular cells: the liquid tracer amount, as the coupling reads it.
    tracer: Vec<Scalar>,
}
impl Pass {
    fn chart(&self, li: usize) -> Chart {
        self.charts[li / 2][li % 2].expect("every face layout has a stage-one chart")
    }
}

#[derive(Clone, Copy)]
struct Seed {
    column: usize,
    sign: f64,
}

struct Blocks<'a, P: Properties> {
    net: &'a Network<P>,
    held: &'a Held<'a, P>,
    y: &'a [f64],
    yp: &'a [f64],
    cj: f64,
    reuse: Reuse<P::Caloric>,
    zero_rate: Vec<Scalar>,
}

fn recoverable(reason: impl Into<String>) -> Failure {
    Failure::Recoverable(reason.into())
}
fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(reason.into())
}

impl<P: Properties> Blocks<'_, P> {
    fn get(&self, seed: Option<Seed>, i: usize) -> Scalar {
        let d = match seed {
            Some(seed) if seed.column == i => seed.sign,
            _ => 0.,
        };
        rec(self.y[i] * self.net.scales[i], d * self.net.scales[i])
    }
    fn rate(&self, seed: Option<Seed>, i: usize) -> Scalar {
        let d = match seed {
            Some(seed) if seed.column == i => seed.sign,
            _ => 0.,
        };
        rec(
            self.yp[i] * self.net.scales[i],
            d * self.cj * self.net.scales[i],
        )
    }

    /// A regular cell's caloric points, face view and EOS row, as the
    /// residual's cell loop composes them.
    fn cell(
        &mut self,
        node: usize,
        seed: Option<Seed>,
        cell_volume: Scalar,
    ) -> Result<(Cell, [Point; 2], Scalar), Failure> {
        let net = self.net;
        let l = net.cell_layout[node];
        let p = self.get(seed, l.base);
        let mut cell = Cell {
            pressure: p,
            phase: [None; 2],
        };
        let mut volume = [s(0.); 2];
        let mut point: [Point; 2] = [None; 2];
        for (k, slot) in point.iter_mut().enumerate() {
            let mass = self.get(seed, l.mass[k]);
            let energy = self.get(seed, l.energy[k]);
            let q = if mass.value != 0. {
                Some(props::inverse(
                    self.held,
                    p,
                    energy / mass,
                    k,
                    false,
                    Some((&mut self.reuse, node)),
                )?)
            } else if let Some(h) = net.leading_enthalpy[node][k] {
                // A birth's enthalpy point takes the boundary's own direction.
                Some(props::inverse(
                    &net.properties,
                    p,
                    s(h),
                    k,
                    true,
                    Some((&mut self.reuse, node)),
                )?)
            } else {
                None
            };
            *slot = q;
            if let Some((q, dq)) = q {
                volume[k] = mass / rec(q.density_kg_m3, dq.density_kg_m3);
            }
        }
        // The row keeps the compiled volume as its scale.
        let eos = (volume[0] + volume[1] - cell_volume) / s(net.volumes[node]);
        for k in 0..2 {
            let mass = self.get(seed, l.mass[k]);
            if !selected_phase(mass) {
                continue;
            }
            let Some((q, dq)) = point[k] else {
                continue;
            };
            let fraction = if k == l.phase {
                s(1.) - volume[1 - k] / cell_volume
            } else {
                volume[k] / cell_volume
            };
            let boron_concentration = if k == 0 {
                if mass.value != 0. {
                    self.get(seed, l.boron) / mass
                } else {
                    s(net.leading_liquid_concentration[node].ok_or_else(|| {
                        recoverable(
                            "zero-stock liquid direction requires its responsible tracer receipt",
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
        Ok((cell, point, eos))
    }

    fn pzr_coordinates(
        &self,
        value: impl Fn(usize) -> Scalar,
    ) -> Result<stratified::Coordinates, Failure> {
        let x: Vec<Scalar> = self.net.pzr.coordinates().map(value).collect();
        stratified::Coordinates::from_slice(&x)
    }

    /// The stratified cell's column and the port view its port face reads.
    fn pzr(
        &mut self,
        seed: Option<Seed>,
        port: usize,
    ) -> Result<(stratified::Column, Cell), Failure> {
        let net = self.net;
        let x = self.pzr_coordinates(|i| self.get(seed, i))?;
        let slots = net.pzr_slots();
        let column = net
            .stratified
            .column(self.held, &x, Some((&mut self.reuse, slots)))?;
        let view = net.stratified.port_view(&column, port)?;
        Ok((column, view))
    }

    /// One stage-one face chart, as the residual composes the receipts.
    fn chart(&self, li: usize, pass: &Pass, seed: Option<Seed>) -> Result<Chart, Failure> {
        let net = self.net;
        let n = net.pzr.cell;
        let l = net.face_layout[li];
        let pi = self.get(seed, l.index);
        let f = &net.faces[l.face];
        let inertance = f.supports.iter().fold(s(0.), |sum, support| {
            sum + pass.phase_mass[l.phase][support.region] / pass.volume[support.region]
                * s(support.inverse_area_length_per_m)
        });
        if inertance.value == 0.
            && f.supports
                .iter()
                .any(|support| pass.phase_mass[l.phase][support.region].value != 0.)
        {
            return Err(recoverable(
                "signed nonzero phase masses cancelled face inertia; not an empty rest chart",
            ));
        }
        let path = if inertance.value == 0. && pi.value == 0. {
            flow::PathKinematics {
                inertance_kg_m4: inertance,
                inertance_rate_kg_m4_s: s(0.),
                volume_flow_m3_s: s(0.),
            }
        } else {
            flow::phase_path_kinematics(
                f,
                &pass.phase_mass[l.phase],
                &self.zero_rate,
                &pass.volume[..n],
                pi,
                s(0.),
                flow::ColdOnset::Unavailable,
            )
            .map_err(recoverable)?
        };
        flow::chart_from_path(f, &pass.cells, l.phase, pi, path).map_err(|e| {
            recoverable(format!(
                "{e}; block assembly, face={}, phase={}, Pi={}",
                l.face, l.phase, pi.value
            ))
        })
    }

    /// One liquid-carrier section: its drive and, with a rotor, its shaft
    /// power and rotor row, as the residual composes them.
    #[allow(clippy::type_complexity)]
    fn section(
        &self,
        j: usize,
        pass: &Pass,
        seed: Option<Seed>,
        profile_of: &[(usize, f64)],
    ) -> Result<(Scalar, Option<(usize, Scalar, Scalar)>), Failure> {
        let net = self.net;
        let region = net.sections[j].region;
        let liquid = pass.cells[region].phase[0]
            .ok_or_else(|| recoverable("liquid-carrier section has no liquid owner"))?;
        let (q, dq) = pass.points[region][0]
            .ok_or_else(|| recoverable("liquid-carrier section has no liquid EOS point"))?;
        let mut profile = s(0.);
        for (face, w) in profile_of {
            profile = profile + s(*w) * pass.chart(2 * face).volume_flow_m3_s;
        }
        let current = liquid.density * liquid.fraction * profile;
        let gas_fraction = pass.cells[region].phase[1].map_or(s(0.), |p| p.fraction);
        let omega = net.sections[j].rotor.map_or(s(0.), |r| {
            self.get(seed, net.rotor_index[r]) / s(net.rotor_inertia)
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
        let e = net.sections[j]
            .section
            .evaluate(input, direction)
            .map_err(|e| recoverable(e.to_string()))?;
        let drive = liquid.fraction
            * rec(
                e.value.pump_euler_pa - e.value.passive_loss_pa,
                e.direction.pump_euler_pa - e.direction.passive_loss_pa,
            );
        let Some(r) = net.sections[j].rotor else {
            return Ok((drive, None));
        };
        let shaft = rec(e.value.shaft_power_w, e.direction.shaft_power_w);
        let index = net.rotor_index[r];
        let state =
            net.rotor_states[r].ok_or_else(|| fatal("rotor drive/shaft state must be declared"))?;
        let law = net
            .drive
            .evaluate(
                state.support,
                state.shaft,
                rotor::Input {
                    omega_rad_s: omega,
                    angular_momentum_rate_nm: self.rate(seed, index),
                    fluid_torque_nm: rec(e.value.fluid_torque_nm, e.direction.fluid_torque_nm),
                },
            )
            .map_err(|e| match e {
                rotor::Error::InvalidInput | rotor::Error::NonfiniteResult => {
                    recoverable(format!("rotor trial: {e:?}"))
                }
                _ => fatal(format!("rotor law: {e:?}")),
            })?;
        let row = match law.rotor {
            rotor::RotorRow::Free { residual_nm } => residual_nm / s(net.scales[index]),
            rotor::RotorRow::Locked { residual_rad_s, .. } => {
                residual_rad_s / s(net.drive.reference_omega_rad_s)
            }
        };
        Ok((drive, Some((index, shaft, row))))
    }

    /// One impulse row and whether its path has exactly zero inertance.
    /// `reuse_chart` takes the pass's stage-one chart for a path of nonzero
    /// inertance: there the stage-two kinematics give the same inertance
    /// and `Q = Pi/I`, the only path fields [`flow::chart_from_path`] reads,
    /// so the stage-two chart is the stage-one chart bitwise.
    fn momentum(
        &self,
        li: usize,
        pass: &Pass,
        seed: Option<Seed>,
        forced_by: &[(usize, f64)],
        reuse_chart: bool,
    ) -> Result<(Scalar, bool), Failure> {
        let net = self.net;
        let n = net.pzr.cell;
        let l = net.face_layout[li];
        let current = pass.chart(li);
        let mut force = s(0.);
        if l.phase == 0 {
            for (section, w) in forced_by {
                force = force + s(*w) * pass.section_drive[*section];
            }
        }
        let rate = self.rate(seed, l.index);
        if reuse_chart {
            let row = flow::momentum_residual(rate, current, force).map_err(recoverable)?
                / s(net.scales[l.index]);
            return Ok((row, false));
        }
        let pi = self.get(seed, l.index);
        let path = flow::phase_path_kinematics(
            &net.faces[l.face],
            &pass.phase_mass[l.phase],
            &pass.mass_rate[l.phase],
            &pass.volume[..n],
            pi,
            force + current.pressure_gravity_pa,
            flow::ColdOnset::ProvenRest,
        )
        .map_err(|e| {
            recoverable(format!(
                "{e}; block assembly, face={}, phase={}",
                l.face, l.phase
            ))
        })?;
        let cold = path.inertance_kg_m4.value == 0.;
        let chart = flow::chart_from_path(&net.faces[l.face], &pass.cells, l.phase, pi, path)
            .map_err(recoverable)?;
        let row = flow::momentum_residual(rate, chart, force).map_err(recoverable)?
            / s(net.scales[l.index]);
        Ok((row, cold))
    }

    /// One regular cell's boron, mass and energy rows, in that order with
    /// the phases interleaved: `[B, M_l, U_l, M_g, U_g]`.
    fn stocks(
        &mut self,
        node: usize,
        pass: &Pass,
        seed: Option<Seed>,
    ) -> Result<[Scalar; 5], Failure> {
        let net = self.net;
        let l = net.cell_layout[node];
        let index = l.boron;
        let boron = (self.rate(seed, index) - pass.receipts[node][0][2]) / s(net.scales[index]);
        let mut therm = [None; 2];
        let pressure = self.get(seed, l.base);
        let md: [Scalar; 2] = std::array::from_fn(|k| pass.receipts[node][k][0]);
        let hd: [Scalar; 2] = std::array::from_fn(|k| pass.receipts[node][k][1]);
        for (k, phase) in therm.iter_mut().enumerate() {
            // Receipt points are births: the boundary's own direction.
            let receipt_point = if pass.points[node][k].is_none() {
                if md[k].value > 0. {
                    Some(props::inverse(
                        &net.properties,
                        pressure,
                        hd[k] / md[k],
                        k,
                        true,
                        Some((&mut self.reuse, node)),
                    )?)
                } else if md[k].value == 0. && md[k].direction > 0. {
                    Some(props::inverse(
                        &net.properties,
                        pressure,
                        s(hd[k].direction / md[k].direction),
                        k,
                        true,
                        Some((&mut self.reuse, node)),
                    )?)
                } else {
                    None
                }
            } else {
                pass.points[node][k]
            };
            let Some((q, dq)) = receipt_point else {
                continue;
            };
            let rho = rec(q.density_kg_m3, dq.density_kg_m3);
            let alpha = rec(q.expansion_per_k, dq.expansion_per_k);
            let kappa = rec(q.compressibility_per_pa, dq.compressibility_per_pa);
            let temperature = rec(q.temperature_k, dq.temperature_k);
            *phase = Some(phase::ScalarRatePhase {
                mass: self.get(seed, l.mass[k]),
                density: rho,
                specific_u: rec(q.internal_energy_j_kg, dq.internal_energy_j_kg),
                rho_p: rho * kappa,
                rho_t: -rho * alpha,
                u_p: (-temperature * alpha + pressure * kappa) / rho,
                u_t: rec(q.cp_j_kg_k, dq.cp_j_kg_k) - pressure * alpha / rho,
            });
        }
        let rates = match pass.volume_rate[node] {
            None => phase::current_rates(pressure, therm, md, hd),
            Some(rate) => phase::current_rates_with_boundary(pressure, therm, md, hd, rate),
        }
        .map_err(|e| recoverable(e.to_string()))?;
        let mut rows = [boron, s(0.), s(0.), s(0.), s(0.)];
        for (k, mass_rate) in md.iter().enumerate() {
            rows[1 + 2 * k] = (self.rate(seed, l.mass[k]) - *mass_rate) / s(net.scales[l.mass[k]]);
            rows[2 + 2 * k] = (self.rate(seed, l.energy[k]) - rates.internal_energy_rate_w[k])
                / s(net.scales[l.energy[k]]);
        }
        Ok(rows)
    }

    /// A regular cell's phase mass rate as the impulse rows read it: the
    /// mass receipt, less `M V'/V` for a moving cell (the inertance weight
    /// is the phase density `M/V`).
    fn mass_rate(&self, pass: &Pass, k: usize, node: usize) -> Scalar {
        let receipt = pass.receipts[node][k][0];
        match pass.volume_rate[node] {
            None => receipt,
            Some(rate) => receipt - pass.phase_mass[k][node] * rate / pass.volume[node],
        }
    }

    /// The stratified cell's 17 rows on the pass's column and port receipt.
    fn pzr_rows(
        &self,
        pass: &Pass,
        seed: Option<Seed>,
    ) -> Result<[Scalar; PZR_COORDINATES], Failure> {
        let net = self.net;
        let x = self.pzr_coordinates(|i| self.get(seed, i))?;
        let rate = self.pzr_coordinates(|i| self.rate(seed, i))?;
        let [liquid, vapor] = pass.receipts[net.pzr.cell];
        if vapor.iter().any(|q| q.value != 0. || q.direction != 0.) {
            return Err(fatal(
                "a vapor receipt through the surge port is outside the composed stratified cell",
            ));
        }
        let receipts = [stratified::Receipt {
            mass: liquid[0],
            enthalpy: liquid[1],
            boron: liquid[2],
        }];
        let scales: [f64; PZR_COORDINATES] = net.scales[net.pzr.coordinates()]
            .try_into()
            .map_err(|_| fatal("PZR scale layout"))?;
        Ok(net
            .stratified
            .residual_on(
                self.held,
                pass.column,
                &x,
                &rate,
                &receipts,
                &stratified::Boundary::closed(),
                &scales,
            )?
            .rows)
    }
}

/// Per-section projection lists in the residual's order: each section's
/// projected faces with weights, and each face's forcing sections.
struct Projection {
    profile: Vec<Vec<(usize, f64)>>,
    force: Vec<Vec<(usize, f64)>>,
}

impl<P: Properties> Network<P> {
    fn projection(&self) -> Projection {
        let mut profile = vec![Vec::new(); self.sections.len()];
        let mut force = vec![Vec::new(); self.faces.len()];
        for (face, section, w) in &self.section_projection {
            profile[*section].push((*face, *w));
            force[*face].push((*section, *w));
        }
        Projection { profile, force }
    }

    /// Compile the structural pattern once (the colored assembly's) and the
    /// element incidence of every column.
    pub fn block_jacobian(&self) -> Result<BlockJacobian, Failure> {
        let n = self.dimension();
        let pattern =
            Pattern::from_columns(n, &self.structural_pattern()).map_err(Failure::Fatal)?;
        let mut owner = vec![None; n];
        for (node, l) in self.cell_layout.iter().enumerate() {
            owner[l.base] = Some(Owner::Cell(node, Coordinate::Pressure));
            owner[l.boron] = Some(Owner::Cell(node, Coordinate::Boron));
            for k in 0..2 {
                owner[l.mass[k]] = Some(Owner::Cell(node, Coordinate::Mass(k)));
                owner[l.energy[k]] = Some(Owner::Cell(node, Coordinate::Energy(k)));
            }
        }
        for i in self.pzr.coordinates() {
            owner[i] = Some(Owner::Pzr);
        }
        for (li, l) in self.face_layout.iter().enumerate() {
            owner[l.index] = Some(Owner::Impulse(li));
        }
        for (r, index) in self.rotor_index.iter().enumerate() {
            owner[*index] = Some(Owner::Rotor(r));
        }
        let owner = owner
            .into_iter()
            .enumerate()
            .map(|(i, o)| o.ok_or_else(|| fatal(format!("coordinate {i} has no block owner"))))
            .collect::<Result<Vec<_>, _>>()?;
        if self
            .face_layout
            .iter()
            .enumerate()
            .any(|(li, l)| li != 2 * l.face + l.phase)
        {
            return Err(fatal("face layouts must be ordered by face, then phase"));
        }
        let cells = self.cells.len();
        let mut reading = vec![Vec::new(); cells];
        let mut supporting = [
            vec![Vec::new(); self.pzr.cell],
            vec![Vec::new(); self.pzr.cell],
        ];
        for (li, l) in self.face_layout.iter().enumerate() {
            let f = &self.faces[l.face];
            let mut read = vec![f.from, f.to];
            read.extend(f.pressure_segments.iter().map(|p| p.region));
            read.sort_unstable();
            read.dedup();
            for c in read {
                reading[c].push(li);
            }
            for support in &f.supports {
                let list = &mut supporting[l.phase][support.region];
                if list.last() != Some(&li) {
                    list.push(li);
                }
            }
        }
        let projection = self.projection();
        let mut sections_of = vec![Vec::new(); self.pzr.cell];
        let mut rotor_section = vec![usize::MAX; self.rotor_index.len()];
        for (j, h) in self.sections.iter().enumerate() {
            sections_of[h.region].push(j);
            if let Some(r) = h.rotor {
                rotor_section[r] = j;
            }
        }
        let mut profiled_by = vec![Vec::new(); self.face_layout.len()];
        let mut forcing = vec![Vec::new(); self.sections.len()];
        for (j, faces) in projection.profile.iter().enumerate() {
            for (face, _) in faces {
                let li = 2 * face;
                if profiled_by[li].last() != Some(&j) {
                    profiled_by[li].push(j);
                }
                if forcing[j].last() != Some(&li) {
                    forcing[j].push(li);
                }
            }
        }
        for list in profiled_by.iter_mut().chain(forcing.iter_mut()) {
            list.sort_unstable();
            list.dedup();
        }
        let port = self
            .stratified
            .parameters()
            .ports
            .iter()
            .position(|p| p.face == Some(self.pzr.port_face))
            .ok_or_else(|| fatal("the port face has no PZR port"))?;
        Ok(BlockJacobian {
            pattern,
            owner,
            reading,
            supporting,
            sections_of,
            profiled_by,
            forcing,
            rotor_section,
            port,
        })
    }

    /// Block assembly into `values`, in the order of `structure.pattern`'s
    /// stored entries. Refuses when its base pass does not reproduce the
    /// residual bitwise, or when a column responds outside the pattern.
    pub fn jacobian_blocks(
        &mut self,
        t: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        structure: &BlockJacobian,
        values: &mut [f64],
    ) -> Result<(), Failure> {
        let started = Instant::now();
        self.counters.jacobians += 1;
        let result = (|| {
            let n = self.dimension();
            if structure.columns() != n || values.len() != structure.pattern.nonzeros() {
                return Err(fatal("block assembly layout"));
            }
            let mut reuse = self.reuse();
            self.evaluate(t, y, yp, None, 0., Some(&mut reuse))?;
            let held = Held::new(&self.properties);
            let mut replay = Replay::new(&*self, &held, y, yp, cj, reuse, structure, false)?;
            let pointers = structure.pattern.pointers();
            let indices = structure.pattern.indices();
            let mut response = Vec::new();
            let mut dense = vec![0.; n];
            for j in 0..n {
                response.clear();
                replay.column(j, None, &mut response)?;
                for &(row, v) in &response {
                    dense[row] = v;
                }
                let stored = &indices[pointers[j]..pointers[j + 1]];
                let sign = replay.sign(j);
                for (position, row) in (pointers[j]..pointers[j + 1]).zip(stored) {
                    let v = dense[*row];
                    if !v.is_finite() {
                        return Err(fatal(format!(
                            "block column {j}: nonfinite response {v} at row {row}"
                        )));
                    }
                    values[position] = v / sign;
                }
                for &(row, v) in &response {
                    if v != 0. && stored.binary_search(&row).is_err() {
                        return Err(fatal(format!(
                            "block column {j}: response {v} at row {row}, which the pattern does not store; it omits a dependency"
                        )));
                    }
                    dense[row] = 0.;
                }
            }
            Ok(())
        })();
        self.counters.jacobian_wall_s += started.elapsed().as_secs_f64();
        result
    }
}

/// The coupled owners' response to one network column of a block
/// assembly: S2-JOIN's `couple_local` on the joined operator.
pub trait LocalCoupling {
    /// Called once per column after its stage-one charts and receipts, with
    /// this column's fluid state (base values with this column's
    /// directions) and the regular cells whose state and the faces whose
    /// liquid chart flux moved. Adds the coupled receipts' directions for
    /// this column into `receipts`; their values are not read.
    fn local(
        &mut self,
        cells: &[usize],
        faces: &[usize],
        fluid: &Fluid<'_>,
        receipts: &mut Receipts<'_>,
    ) -> Result<(), Failure>;
}

/// The directions one non-network column of a joined operator gives the
/// network: receipts into regular cells and moving cell volumes.
#[derive(Clone, Debug, Default)]
pub struct NetworkSeed {
    /// `(regular cell, [phase][mass, enthalpy, tracer] receipt directions)`.
    pub receipts: Vec<(usize, [[f64; 3]; 2])>,
    /// `(regular cell, d volume, d volume rate)`.
    pub volumes: Vec<(usize, f64, f64)>,
}

/// The network's element replay at one base evaluation, for the network's
/// own block assembly and for a joined operator's.
pub struct Replay<'a, P: Properties> {
    blocks: Blocks<'a, P>,
    structure: &'a BlockJacobian,
    projection: Projection,
    base: Pass,
    pass: Pass,
    signs: Vec<f64>,
    work: Work,
}

/// Per-column scratch lists.
#[derive(Default)]
struct Work {
    responded: Vec<(usize, f64)>,
    cells: Vec<usize>,
    faces: Vec<usize>,
    charts: Vec<usize>,
    receipts: Vec<usize>,
    sections: Vec<usize>,
    impulses: Vec<usize>,
    stocks: Vec<usize>,
    volumes: Vec<usize>,
    coupled: Vec<[[Scalar; 3]; 2]>,
}

impl<'a, P: Properties> Replay<'a, P> {
    /// The replay at the network's last evaluation, which must have been at
    /// `(y, y')` with `reuse` as its matrix reuse; `coupled` names an
    /// evaluation with a coupling (its receipts are then the network's
    /// coupled receipts of that evaluation). Refuses unless the base pass
    /// reproduces every network row bitwise.
    #[allow(clippy::too_many_arguments)] // The network's stage inputs and its compiled structure.
    pub fn new(
        net: &'a Network<P>,
        held: &'a Held<'a, P>,
        y: &'a [f64],
        yp: &'a [f64],
        cj: f64,
        reuse: Reuse<P::Caloric>,
        structure: &'a BlockJacobian,
        coupled: bool,
    ) -> Result<Self, Failure> {
        let n = net.dimension();
        if y.len() != n || yp.len() != n || structure.columns() != n {
            return Err(fatal("block replay layout"));
        }
        let mut blocks = Blocks {
            net,
            held,
            y,
            yp,
            cj,
            reuse,
            zero_rate: vec![s(0.); net.pzr.cell],
        };
        let projection = net.projection();
        let base = blocks.base(structure, &projection, coupled)?;
        if let Some(row) =
            (0..n).find(|i| base.rows[*i].value.to_bits() != net.rows[*i].value.to_bits())
        {
            return Err(fatal(format!(
                "the block assembly does not reproduce residual row {row}: {} against {}",
                base.rows[row].value, net.rows[row].value
            )));
        }
        Ok(Self {
            blocks,
            structure,
            projection,
            pass: base.clone(),
            base,
            signs: net.column_signs(y),
            work: Work {
                coupled: vec![[[s(0.); 3]; 2]; net.pzr.cell],
                ..Work::default()
            },
        })
    }

    /// The seed sign of network column `j` (an exact-zero impulse follows
    /// its current force branch); its entries are the response over it.
    pub fn sign(&self, j: usize) -> f64 {
        self.signs[j]
    }

    /// Network column `j`'s response: `(network row, direction)` along the
    /// column's seed sign, and through `hook` the coupled owners'.
    pub fn column(
        &mut self,
        j: usize,
        hook: Option<&mut dyn LocalCoupling>,
        response: &mut Vec<(usize, f64)>,
    ) -> Result<(), Failure> {
        let seed = Seed {
            column: j,
            sign: self.signs[j],
        };
        self.run(Some(seed), None, hook, response)
    }

    /// A non-network column's response through its receipt and volume
    /// directions; `hook` gives the coupled owners' response to the cells
    /// and faces that moved.
    pub fn external(
        &mut self,
        seed: &NetworkSeed,
        hook: Option<&mut dyn LocalCoupling>,
        response: &mut Vec<(usize, f64)>,
    ) -> Result<(), Failure> {
        self.run(None, Some(seed), hook, response)
    }

    fn run(
        &mut self,
        seed: Option<Seed>,
        external: Option<&NetworkSeed>,
        hook: Option<&mut dyn LocalCoupling>,
        response: &mut Vec<(usize, f64)>,
    ) -> Result<(), Failure> {
        let Self {
            blocks,
            structure,
            projection,
            base,
            pass,
            work,
            ..
        } = self;
        let net = blocks.net;
        let regular = net.pzr.cell;
        let pzr = net.pzr.cell;
        let w = work;
        w.responded.clear();
        w.cells.clear();
        w.faces.clear();
        w.charts.clear();
        w.receipts.clear();
        w.sections.clear();
        w.impulses.clear();
        w.stocks.clear();
        w.volumes.clear();
        let mut pzr_seeded = false;
        let moved = |a: Scalar| a.direction != 0.;
        let owner = seed.map(|s| structure.owner[s.column]);
        let view_moved = |cell: &Cell, base: &Cell| {
            moved(cell.pressure)
                || cell.phase.iter().flatten().any(|p| {
                    moved(p.fraction)
                        || moved(p.density)
                        || moved(p.enthalpy)
                        || moved(p.boron_concentration)
                })
                || cell
                    .phase
                    .iter()
                    .zip(&base.phase)
                    .any(|(a, b)| a.is_some() != b.is_some())
        };
        match owner {
            Some(Owner::Cell(node, coordinate)) => {
                let (cell, point, eos) = blocks.cell(node, seed, pass.volume[node])?;
                let viewed = view_moved(&cell, &base.cells[node]);
                pass.cells[node] = cell;
                pass.points[node] = point;
                w.responded
                    .push((net.cell_layout[node].base, eos.direction));
                if viewed {
                    w.charts.extend_from_slice(&structure.reading[node]);
                }
                match coordinate {
                    Coordinate::Mass(k) => {
                        pass.phase_mass[k][node] = blocks.get(seed, net.cell_layout[node].mass[k]);
                        w.charts.extend_from_slice(&structure.supporting[k][node]);
                    }
                    Coordinate::Boron => {
                        pass.tracer[node] = blocks.get(seed, net.cell_layout[node].boron);
                    }
                    Coordinate::Pressure | Coordinate::Energy(_) => {}
                }
                w.cells.push(node);
                w.receipts.push(node);
                w.sections.extend_from_slice(&structure.sections_of[node]);
                w.stocks.push(node);
            }
            Some(Owner::Pzr) => {
                let (column, view) = blocks.pzr(seed, structure.port)?;
                pass.column = column;
                pass.cells[pzr] = view;
                w.charts.extend_from_slice(&structure.reading[pzr]);
                pzr_seeded = true;
            }
            Some(Owner::Impulse(li)) => {
                w.charts.push(li);
                w.impulses.push(li);
            }
            Some(Owner::Rotor(r)) => w.sections.push(structure.rotor_section[r]),
            None => {}
        }
        if let Some(external) = external {
            for &(node, dv, dr) in &external.volumes {
                if node >= regular {
                    return Err(fatal(format!(
                        "a moving volume of cell {node} is not a regular cell"
                    )));
                }
                let v = base.volume[node];
                pass.volume[node] = Scalar::new(v.value, dv);
                let rate = base.volume_rate[node].map_or(0., |r| r.value);
                pass.volume_rate[node] = Some(Scalar::new(rate, dr));
                let (cell, point, eos) = blocks.cell(node, None, pass.volume[node])?;
                let viewed = view_moved(&cell, &base.cells[node]);
                pass.cells[node] = cell;
                pass.points[node] = point;
                w.responded
                    .push((net.cell_layout[node].base, eos.direction));
                if viewed {
                    w.charts.extend_from_slice(&structure.reading[node]);
                    w.sections.extend_from_slice(&structure.sections_of[node]);
                }
                for k in 0..2 {
                    w.charts.extend_from_slice(&structure.supporting[k][node]);
                }
                w.volumes.push(node);
                w.cells.push(node);
                w.receipts.push(node);
                w.stocks.push(node);
            }
            for (node, d) in &external.receipts {
                if *node >= regular {
                    return Err(fatal(format!(
                        "a receipt into cell {node} is not a regular cell"
                    )));
                }
                for (target, d) in pass.receipts[*node].iter_mut().zip(d) {
                    for (q, d) in target.iter_mut().zip(d) {
                        q.direction += d;
                    }
                }
                w.receipts.push(*node);
            }
        }
        w.charts.sort_unstable();
        w.charts.dedup();
        // Stage-one charts and their receipts, in the residual's order.
        for &li in &w.charts {
            let chart = blocks.chart(li, pass, seed)?;
            let l = net.face_layout[li];
            pass.charts[l.face][l.phase] = Some(chart);
            let f = &net.faces[l.face];
            let flux = [
                chart.mass_flow_kg_s,
                chart.enthalpy_flow_w,
                chart.boron_flow_kg_s,
            ];
            if flux.iter().any(|q| moved(*q)) {
                for (k, q) in flux.into_iter().enumerate() {
                    pass.receipts[f.from][l.phase][k].direction -= q.direction;
                    pass.receipts[f.to][l.phase][k].direction += q.direction;
                }
                w.receipts.extend([f.from, f.to]);
                if l.phase == 0 {
                    w.faces.push(l.face);
                }
            }
            if moved(chart.volume_flow_m3_s) {
                w.sections.extend_from_slice(&structure.profiled_by[li]);
            }
            if moved(chart.pressure_gravity_pa) || base.cold[li] {
                w.impulses.push(li);
            }
        }
        // The coupled owners' receipts for this column, after the charts'.
        if let Some(hook) = hook {
            w.cells.sort_unstable();
            w.cells.dedup();
            w.faces.sort_unstable();
            w.faces.dedup();
            if !w.cells.is_empty() || !w.faces.is_empty() {
                let fluid = Fluid {
                    cells: &pass.cells,
                    points: &pass.points,
                    liquid_mass: &pass.phase_mass[0],
                    vapor_mass: &pass.phase_mass[1],
                    tracer: &pass.tracer,
                    charts: &pass.charts,
                    endpoints: &net.endpoints,
                    elevations: &net.elevations,
                    volumes: &net.volumes,
                    current_volumes: &pass.volume,
                };
                w.coupled.fill([[s(0.); 3]; 2]);
                hook.local(
                    &w.cells,
                    &w.faces,
                    &fluid,
                    &mut Receipts::new(&mut w.coupled),
                )?;
                for (node, r) in w.coupled.iter().enumerate() {
                    if r.iter().flatten().any(|q| moved(*q)) {
                        for (target, r) in pass.receipts[node].iter_mut().zip(r) {
                            for (q, r) in target.iter_mut().zip(r) {
                                q.direction += r.direction;
                            }
                        }
                        w.receipts.push(node);
                    }
                }
            }
        }
        w.sections.sort_unstable();
        w.sections.dedup();
        for &k in &w.sections {
            let (drive, rotor) = blocks.section(k, pass, seed, &projection.profile[k])?;
            pass.section_drive[k] = drive;
            if let Some((index, shaft, row)) = rotor {
                if moved(shaft) {
                    let region = net.sections[k].region;
                    pass.receipts[region][0][1].direction += shaft.direction;
                    w.receipts.push(region);
                }
                w.responded.push((index, row.direction));
            }
            if moved(drive) {
                w.impulses.extend_from_slice(&structure.forcing[k]);
            }
        }
        w.receipts.sort_unstable();
        w.receipts.dedup();
        for &c in &w.receipts {
            if c < regular {
                for k in 0..2 {
                    pass.mass_rate[k][c] = blocks.mass_rate(pass, k, c);
                }
                w.stocks.push(c);
                // A zero-inertance path's onset reads its supports' mass rates.
                for k in 0..2 {
                    if moved(pass.mass_rate[k][c]) {
                        w.impulses.extend(
                            structure.supporting[k][c]
                                .iter()
                                .filter(|li| base.cold[**li]),
                        );
                    }
                }
            }
        }
        w.impulses.sort_unstable();
        w.impulses.dedup();
        for &li in &w.impulses {
            let face = net.face_layout[li].face;
            let (row, _) =
                blocks.momentum(li, pass, seed, &projection.force[face], !base.cold[li])?;
            w.responded.push((net.face_layout[li].index, row.direction));
        }
        w.stocks.sort_unstable();
        w.stocks.dedup();
        for &c in &w.stocks {
            let rows = blocks.stocks(c, pass, seed)?;
            let l = net.cell_layout[c];
            for (i, row) in [l.boron, l.mass[0], l.energy[0], l.mass[1], l.energy[1]]
                .into_iter()
                .zip(rows)
            {
                w.responded.push((i, row.direction));
            }
        }
        if pzr_seeded || w.receipts.binary_search(&pzr).is_ok() {
            let rows = blocks.pzr_rows(pass, seed)?;
            for (i, row) in net.pzr.coordinates().zip(rows) {
                w.responded.push((i, row.direction));
            }
        }
        response.extend_from_slice(&w.responded);
        // Restore the base pass.
        match owner {
            Some(Owner::Cell(node, _)) => {
                pass.cells[node] = base.cells[node];
                pass.points[node] = base.points[node];
                for k in 0..2 {
                    pass.phase_mass[k][node] = base.phase_mass[k][node];
                }
                pass.tracer[node] = base.tracer[node];
            }
            Some(Owner::Pzr) => {
                pass.column = base.column;
                pass.cells[pzr] = base.cells[pzr];
            }
            _ => {}
        }
        for &node in &w.volumes {
            pass.volume[node] = base.volume[node];
            pass.volume_rate[node] = base.volume_rate[node];
            pass.cells[node] = base.cells[node];
            pass.points[node] = base.points[node];
        }
        for &li in &w.charts {
            let l = net.face_layout[li];
            pass.charts[l.face][l.phase] = base.charts[l.face][l.phase];
        }
        for &k in &w.sections {
            pass.section_drive[k] = base.section_drive[k];
        }
        for &c in &w.receipts {
            pass.receipts[c] = base.receipts[c];
            if c < regular {
                for k in 0..2 {
                    pass.mass_rate[k][c] = base.mass_rate[k][c];
                }
            }
        }
        Ok(())
    }
}

impl<P: Properties> Blocks<'_, P> {
    /// Every element at the base values, in the residual's order
    /// ([`Network::evaluate_joined`]).
    fn base(
        &mut self,
        structure: &BlockJacobian,
        projection: &Projection,
        coupled: bool,
    ) -> Result<Pass, Failure> {
        let net = self.net;
        let n = net.pzr.cell;
        let volume: Vec<Scalar> = net.cell_volume.clone();
        let volume_rate: Vec<Option<Scalar>> = net.cell_volume_rate.clone();
        if volume
            .iter()
            .chain(volume_rate.iter().flatten())
            .any(|v| v.direction != 0.)
        {
            return Err(fatal(
                "the base evaluation's cell volumes carry a direction",
            ));
        }
        let mut cells = Vec::with_capacity(net.cells.len());
        let mut points = Vec::with_capacity(n);
        let mut eos = Vec::with_capacity(n);
        for (node, v) in volume.iter().enumerate() {
            let (cell, point, row) = self.cell(node, None, *v)?;
            cells.push(cell);
            points.push(point);
            eos.push(row);
        }
        let (column, view) = self.pzr(None, structure.port)?;
        cells.push(view);
        let phase_mass: [Vec<Scalar>; 2] = std::array::from_fn(|k| {
            (0..n)
                .map(|node| self.get(None, net.cell_layout[node].mass[k]))
                .collect()
        });
        let tracer: Vec<Scalar> = (0..n)
            .map(|node| self.get(None, net.cell_layout[node].boron))
            .collect();
        let layouts = net.face_layout.len();
        let mut pass = Pass {
            cells,
            points,
            phase_mass,
            mass_rate: [vec![s(0.); n], vec![s(0.); n]],
            column,
            charts: vec![[None; 2]; net.faces.len()],
            receipts: vec![[[s(0.); 3]; 2]; net.cells.len()],
            section_drive: vec![s(0.); net.sections.len()],
            rows: vec![s(0.); net.dimension()],
            cold: vec![false; layouts],
            volume,
            volume_rate,
            tracer,
        };
        for li in 0..layouts {
            let chart = self.chart(li, &pass, None)?;
            let l = net.face_layout[li];
            pass.charts[l.face][l.phase] = Some(chart);
            let f = &net.faces[l.face];
            let flux = [
                chart.mass_flow_kg_s,
                chart.enthalpy_flow_w,
                chart.boron_flow_kg_s,
            ];
            for (k, q) in flux.into_iter().enumerate() {
                pass.receipts[f.from][l.phase][k] = pass.receipts[f.from][l.phase][k] - q;
                pass.receipts[f.to][l.phase][k] = pass.receipts[f.to][l.phase][k] + q;
            }
        }
        if coupled {
            // The coupled owners' receipts of the same evaluation, added as
            // Network::couple adds them.
            for node in 0..n {
                for k in 0..2 {
                    for j in 0..3 {
                        let c = net.coupled_receipts[node][k][j];
                        if c.direction != 0. {
                            return Err(fatal(
                                "the base evaluation's coupled receipts carry a direction",
                            ));
                        }
                        pass.receipts[node][k][j] = pass.receipts[node][k][j] + c;
                    }
                }
            }
        }
        for j in 0..net.sections.len() {
            let (drive, rotor) = self.section(j, &pass, None, &projection.profile[j])?;
            pass.section_drive[j] = drive;
            if let Some((index, shaft, row)) = rotor {
                let region = net.sections[j].region;
                pass.receipts[region][0][1] = pass.receipts[region][0][1] + shaft;
                pass.rows[index] = row;
            }
        }
        for k in 0..2 {
            for node in 0..n {
                pass.mass_rate[k][node] = self.mass_rate(&pass, k, node);
            }
        }
        for li in 0..layouts {
            let face = net.face_layout[li].face;
            let (row, cold) = self.momentum(li, &pass, None, &projection.force[face], false)?;
            pass.rows[net.face_layout[li].index] = row;
            pass.cold[li] = cold;
        }
        for (node, row) in eos.into_iter().enumerate() {
            pass.rows[net.cell_layout[node].base] = row;
        }
        for node in 0..n {
            let rows = self.stocks(node, &pass, None)?;
            let l = net.cell_layout[node];
            for (i, row) in [l.boron, l.mass[0], l.energy[0], l.mass[1], l.energy[1]]
                .into_iter()
                .zip(rows)
            {
                pass.rows[i] = row;
            }
        }
        let rows = self.pzr_rows(&pass, None)?;
        for (i, row) in net.pzr.coordinates().zip(rows) {
            pass.rows[i] = row;
        }
        Ok(pass)
    }
}
