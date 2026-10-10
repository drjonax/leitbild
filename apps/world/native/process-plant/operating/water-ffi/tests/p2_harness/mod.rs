//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressurizer-thermal-state.md#stratified-pzr-verification-cases
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressurizer-thermal-state.md#stratified-pzr-cell
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#prospective-accuracy-contract
//! The stratified PZR cell alone as one stock-IDA system, for the P2 cases.
//!
//! Coordinates: the cell's 17 in its contract order, then the relief lift
//! when the case declares the relief outlet (differential, driven by
//! `ReliefDevice::lift_rate`). Surge and spray are the case's recorded
//! boundary flows; an inflow carries its source state's IF97 enthalpy and
//! the copied absorber fraction, an outsurge the port view's φ-weighted
//! liquid. Nothing here is a law of the cell: every row is the cell's own.
//! Relief demand and end of travel are roots on raw PT1 and the lift through
//! `ReliefDevice::roots`; each starts a new handle from the located state and
//! IDACalcIC, as the S1 harness starts an event run. The free-area steps are
//! roots that only record the crossing. Zone masses reaching zero and the
//! mixture reaching the roof are structural roots.
#![allow(dead_code)]
// Zones, ledgers and rows are parallel fixed arrays indexed together.
#![allow(clippy::needless_range_loop)]
use leitbild_operating_plant::{
    network::{
        Failure as CellFailure, Reuse,
        stratified::{
            self as st, Boundary, Cell, Coordinates, Heat, Receipt, ReliefDevice, ReliefMotion,
            ReliefState, Slots, Taps,
        },
    },
    thermal::Scalar,
};
use leitbild_operating_water::{
    CaloricLinearization, If97,
    ida::{Advance, Failure, Ida, Initial, System},
};
use serde_json::{Value, json};
use std::time::Instant;

#[repr(C)]
struct Timespec {
    seconds: i64,
    nanoseconds: i64,
}
unsafe extern "C" {
    fn clock_gettime(clock: i32, out: *mut Timespec) -> i32;
}
fn clock(id: i32) -> f64 {
    let mut t = Timespec {
        seconds: 0,
        nanoseconds: 0,
    };
    // SAFETY: one live stack Timespec matching the C layout; the C library
    // writes it and keeps no pointer.
    let status = unsafe { clock_gettime(id, &mut t) };
    assert_eq!(status, 0, "CPU clock {id} unavailable");
    t.seconds as f64 + t.nanoseconds as f64 * 1e-9
}
/// CLOCK_PROCESS_CPUTIME_ID on macOS, as the S1 harness measures.
pub fn cpu_s() -> f64 {
    clock(12)
}
/// CLOCK_THREAD_CPUTIME_ID on macOS, reported beside it.
pub fn thread_cpu_s() -> f64 {
    clock(16)
}

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn ida_failure(f: CellFailure) -> Failure {
    match f {
        CellFailure::Recoverable(r) => Failure::Recoverable(r),
        CellFailure::Fatal(r) => Failure::Fatal(r),
    }
}
fn text(f: &CellFailure) -> String {
    match f {
        CellFailure::Recoverable(r) => format!("recoverable: {r}"),
        CellFailure::Fatal(r) => format!("fatal: {r}"),
    }
}

/// Exact property reuse inside one Jacobian: the vapor and resident zones
/// share one cell slot (their two phases), the admitted zone has its own.
const SLOTS: Slots = Slots {
    vapor_and_resident: 0,
    admitted: 1,
    interface: 0,
    boundary: 1,
};
/// Index of the relief lift after the cell's coordinates.
pub const LIFT: usize = st::COORDINATES;

/// A recorded test boundary, piecewise linear in time; evaluation outside
/// its declared span is refused, never extrapolated.
#[derive(Clone, Debug)]
pub struct Table(pub Vec<[f64; 2]>);
impl Table {
    pub fn new(points: Vec<[f64; 2]>) -> Result<Self, String> {
        if points.len() < 2
            || points
                .windows(2)
                .any(|w| w[0][0] >= w[1][0] || w[0][0].is_nan())
        {
            return Err(format!(
                "table {points:?} is not strictly increasing in time"
            ));
        }
        if points.iter().flatten().any(|v| !v.is_finite()) {
            return Err("table has a nonfinite entry".into());
        }
        Ok(Self(points))
    }
    pub fn value(&self, t: f64) -> Result<f64, String> {
        let p = &self.0;
        if !(t >= p[0][0] && t <= p[p.len() - 1][0]) {
            return Err(format!(
                "boundary table evaluated at {t} s outside [{}, {}] s",
                p[0][0],
                p[p.len() - 1][0]
            ));
        }
        for w in p.windows(2) {
            let ([t0, v0], [t1, v1]) = (w[0], w[1]);
            if t <= t1 {
                return Ok(v0 + (v1 - v0) * (t - t0) / (t1 - t0));
            }
        }
        unreachable!("t lies inside the table span")
    }
    pub fn times(&self) -> impl Iterator<Item = f64> + '_ {
        self.0.iter().map(|p| p[0])
    }
    /// Exact integral of the piecewise-linear table over [0, t].
    pub fn integral(&self, t: f64) -> f64 {
        let mut total = 0.;
        for w in self.0.windows(2) {
            let ([t0, v0], [t1, v1]) = (w[0], w[1]);
            if t <= t0 {
                break;
            }
            let end = t.min(t1);
            let ve = v0 + (v1 - v0) * (end - t0) / (t1 - t0);
            total += 0.5 * (v0 + ve) * (end - t0);
        }
        total
    }
}

/// One recorded boundary flow at a cell port.
#[derive(Clone, Debug)]
pub struct Flow {
    /// Index in `Parameters::ports`.
    pub port: usize,
    pub table: Table,
    /// `h_IF97` of the recorded source state, evaluated once.
    pub enthalpy_j_kg: f64,
    /// The copied `absorberMassFraction`.
    pub concentration: f64,
}

/// The relief device, its receiver backpressure and its discrete state.
#[derive(Clone, Copy, Debug)]
pub struct Relief {
    pub port: usize,
    pub device: ReliefDevice,
    pub back_pressure_pa: f64,
    pub motion: ReliefMotion,
    pub demand_open: bool,
}

/// Root functions of one integration segment.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Root {
    /// `z_mix − edge` at an internal free-area band edge.
    MixtureEdge(f64),
    /// `z_AR − edge`.
    BoundaryEdge(f64),
    /// A zone's mass coordinate reaching zero (structural).
    ZoneMass(usize),
    /// `z_mix − top_m`: the solid-PZR limit (structural).
    MixtureTop,
    /// Relief demand threshold on raw PT1 (`ReliefDevice::roots`).
    Demand,
    /// Relief end of travel while moving (`ReliefDevice::roots`).
    Travel,
}
impl Root {
    pub fn label(&self) -> String {
        match self {
            Root::MixtureEdge(e) => format!("mixture level at {e} m"),
            Root::BoundaryEdge(e) => format!("A/R boundary at {e} m"),
            Root::ZoneMass(i) => format!("zone mass coordinate {i} at zero"),
            Root::MixtureTop => "mixture level at the roof".into(),
            Root::Demand => "relief demand threshold".into(),
            Root::Travel => "relief end of travel".into(),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Counters {
    pub residuals: u64,
    pub jacobians: u64,
    pub residual_wall_s: f64,
    pub jacobian_wall_s: f64,
    pub root_calls: u64,
}

/// The cell as one stock-IDA system.
#[derive(Clone)]
pub struct CellSystem {
    pub cell: Cell,
    /// Coordinate scales: the cell's 17, then the lift's full stroke.
    pub scales: Vec<f64>,
    pub surge: Option<Flow>,
    pub spray: Option<Flow>,
    pub relief: Option<Relief>,
    /// Roots that are always active: free-area edges and structural limits.
    pub fixed_roots: Vec<Root>,
    pub counters: Counters,
}

/// One full evaluation of the system at a state.
pub struct Evaluated {
    pub ev: st::Evaluation,
    pub lift: Scalar,
    pub lift_row: Scalar,
    pub receipts: Vec<Receipt>,
    pub x: Coordinates,
    pub rate: Coordinates,
}
impl Evaluated {
    pub fn row(&self, i: usize) -> Scalar {
        if i < st::COORDINATES {
            self.ev.rows[i]
        } else {
            self.lift_row
        }
    }
}

impl CellSystem {
    pub fn n(&self) -> usize {
        self.scales.len()
    }
    pub fn differential(&self) -> Vec<f64> {
        let mut ids = st::DIFFERENTIAL.to_vec();
        if self.relief.is_some() {
            ids.push(1.);
        }
        ids
    }
    pub fn cell_scales(&self) -> [f64; st::COORDINATES] {
        let mut out = [0.; st::COORDINATES];
        out.copy_from_slice(&self.scales[..st::COORDINATES]);
        out
    }
    /// The active roots: the fixed list, then the relief's demand and, while
    /// the lift moves, its end of travel.
    pub fn roots_active(&self) -> Vec<Root> {
        let mut roots = self.fixed_roots.clone();
        if let Some(r) = &self.relief {
            roots.push(Root::Demand);
            if matches!(r.motion, ReliefMotion::Opening | ReliefMotion::Closing) {
                roots.push(Root::Travel);
            }
        }
        roots
    }

    fn receipts(&self, t: f64, column: &st::Column) -> Result<Vec<Receipt>, CellFailure> {
        let ports = &self.cell.parameters().ports;
        let mut out = vec![Receipt::zero(); ports.len()];
        if let Some(f) = &self.surge {
            let w = f.table.value(t).map_err(CellFailure::Fatal)?;
            out[f.port] = if w > 0. {
                Receipt {
                    mass: s(w),
                    enthalpy: s(w * f.enthalpy_j_kg),
                    boron: s(w * f.concentration),
                }
            } else if w < 0. {
                // The donor is the cell: the port view's φ-weighted liquid.
                let view = self.cell.port_view(column, f.port)?;
                let liquid = view.phase[0].ok_or_else(|| {
                    CellFailure::Fatal("surge port view has no liquid donor".into())
                })?;
                Receipt {
                    mass: s(w),
                    enthalpy: s(w) * liquid.enthalpy,
                    boron: s(w) * liquid.boron_concentration,
                }
            } else {
                Receipt::zero()
            };
        }
        if let Some(f) = &self.spray {
            let w = f.table.value(t).map_err(CellFailure::Fatal)?;
            if w < 0. {
                return Err(CellFailure::Fatal(
                    "reverse spray flow is outside the verification cases".into(),
                ));
            }
            out[f.port] = Receipt {
                mass: s(w),
                enthalpy: s(w * f.enthalpy_j_kg),
                boron: s(w * f.concentration),
            };
        }
        Ok(out)
    }

    /// Rows at `(t, y, y')`; with `seed = (j, cj)` the directions are the
    /// column `j` of `dF/dy + cj dF/dy'`.
    pub fn evaluate(
        &self,
        t: f64,
        y: &[f64],
        yp: &[f64],
        seed: Option<(usize, f64)>,
        reuse: Option<&mut Reuse<CaloricLinearization>>,
    ) -> Result<Evaluated, CellFailure> {
        let sc = &self.scales;
        let dir = |i: usize, rate: bool| match seed {
            Some((j, cj)) if j == i => {
                if rate {
                    cj * sc[i]
                } else {
                    sc[i]
                }
            }
            _ => 0.,
        };
        let xv: Vec<Scalar> = (0..st::COORDINATES)
            .map(|i| Scalar::new(y[i] * sc[i], dir(i, false)))
            .collect();
        let rv: Vec<Scalar> = (0..st::COORDINATES)
            .map(|i| Scalar::new(yp[i] * sc[i], dir(i, true)))
            .collect();
        let x = Coordinates::from_slice(&xv)?;
        let rate = Coordinates::from_slice(&rv)?;
        let column = self.cell.column(&If97, &x, reuse.map(|r| (r, SLOTS)))?;
        let receipts = self.receipts(t, &column)?;
        let (lift, lift_row, relief) = match &self.relief {
            Some(r) => {
                let lift = Scalar::new(y[LIFT] * sc[LIFT], dir(LIFT, false));
                let lift_rate = Scalar::new(yp[LIFT] * sc[LIFT], dir(LIFT, true));
                let row = (lift_rate - s(r.device.lift_rate(r.motion))) / s(sc[LIFT]);
                (
                    lift,
                    row,
                    Some(ReliefState {
                        lift,
                        back_pressure_pa: s(r.back_pressure_pa),
                    }),
                )
            }
            None => (s(0.), s(0.), None),
        };
        let boundary = Boundary {
            heat: Heat::zero(),
            heaters: Vec::new(),
            relief,
        };
        let ev = self.cell.residual_on(
            &If97,
            column,
            &x,
            &rate,
            &receipts,
            &boundary,
            &self.cell_scales(),
        )?;
        Ok(Evaluated {
            ev,
            lift,
            lift_row,
            receipts,
            x,
            rate,
        })
    }

    pub fn root_values(&self, y: &[f64], roots: &[Root], out: &mut [f64]) -> Result<(), String> {
        let v = |i: usize| y[i] * self.scales[i];
        let mixture = self
            .cell
            .level(s(v(st::ADMITTED_VOLUME)
                + v(st::RESIDENT_VOLUME)
                + v(st::BUBBLE_VOLUME)))
            .value;
        let boundary = self.cell.level(s(v(st::ADMITTED_VOLUME))).value;
        let top = self.cell.parameters().top_m;
        for (o, root) in out.iter_mut().zip(roots) {
            *o = match root {
                Root::MixtureEdge(e) => mixture - e,
                Root::BoundaryEdge(e) => boundary - e,
                Root::ZoneMass(i) => v(*i),
                Root::MixtureTop => mixture - top,
                Root::Demand | Root::Travel => {
                    let r = self
                        .relief
                        .as_ref()
                        .ok_or("relief root without a relief outlet")?;
                    let roots = r.device.roots(
                        s(v(st::ROOF_PRESSURE)),
                        s(v(LIFT)),
                        r.demand_open,
                        r.motion,
                    );
                    if *root == Root::Demand {
                        roots.demand.value
                    } else {
                        roots
                            .travel
                            .ok_or("travel root while the lift is at rest")?
                            .value
                    }
                }
            };
        }
        Ok(())
    }
}

/// The system with the root list frozen for one handle.
pub struct Segment {
    pub system: CellSystem,
    pub roots: Vec<Root>,
}
impl System for Segment {
    fn dimension(&self) -> usize {
        self.system.n()
    }
    fn nonzeros(&self) -> usize {
        self.system.n() * self.system.n()
    }
    fn root_count(&self) -> usize {
        self.roots.len()
    }
    fn residual(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        let started = Instant::now();
        let e = self
            .system
            .evaluate(t, y, yp, None, None)
            .map_err(ida_failure)?;
        for (i, o) in out.iter_mut().enumerate() {
            *o = e.row(i).value;
        }
        let c = &mut self.system.counters;
        c.residuals += 1;
        c.residual_wall_s += started.elapsed().as_secs_f64();
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
        pointers: &mut [i64],
    ) -> Result<(), Failure> {
        let started = Instant::now();
        let n = self.system.n();
        let mut reuse = Reuse::new(2, 2);
        for j in 0..n {
            let e = self
                .system
                .evaluate(t, y, yp, Some((j, cj)), Some(&mut reuse))
                .map_err(ida_failure)?;
            pointers[j] = (j * n) as i64;
            for i in 0..n {
                rows[j * n + i] = i as i64;
                data[j * n + i] = e.row(i).direction;
            }
        }
        pointers[n] = (n * n) as i64;
        let c = &mut self.system.counters;
        c.jacobians += 1;
        c.jacobian_wall_s += started.elapsed().as_secs_f64();
        Ok(())
    }
    fn roots(&mut self, _: f64, y: &[f64], _: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        self.system.counters.root_calls += 1;
        self.system
            .root_values(y, &self.roots, out)
            .map_err(Failure::Fatal)
    }
}

/// One accepted-state sample, physical units.
#[derive(Clone, Debug, Default)]
pub struct Sample {
    pub t: f64,
    pub event: Option<String>,
    pub pt1_pa: f64,
    pub interface_pa: f64,
    pub bottom_pa: f64,
    pub lt_dp_pa: f64,
    pub mixture_level_m: f64,
    pub collapsed_level_m: f64,
    pub boundary_elevation_m: f64,
    pub admitted_thickness_m: f64,
    pub withdrawal_fraction: f64,
    pub masses: [f64; 5],
    pub drop_boron_kg: f64,
    pub temperatures_k: [f64; 3],
    pub departure_k: [f64; 3],
    pub metastable_k: [f64; 3],
    pub within_band: [bool; 3],
    pub credited: [bool; 3],
    pub zone_pressures_pa: [f64; 3],
    pub drop_velocity_m_s: f64,
    pub bubble_velocity_m_s: f64,
    pub gap_margin: f64,
    pub rain_kg_s: f64,
    pub rise_kg_s: f64,
    pub spray_condensation_kg_s: f64,
    pub flashing_kg_s: [f64; 2],
    pub vapor_condensation_kg_s: f64,
    pub interface_evaporation_kg_s: f64,
    pub inversion_kg_s: f64,
    pub conduction_w: f64,
    pub surge_kg_s: f64,
    pub spray_kg_s: f64,
    pub lift: f64,
    pub demand_open: bool,
    pub motion: String,
    pub relief_vapor_kg_s: f64,
    pub relief_drop_kg_s: f64,
    pub relief_boron_kg_s: f64,
    pub relief_enthalpy_w: f64,
    pub receipt: [f64; 3],
    pub volume_work_w: f64,
    pub transit_drift_w: [f64; 2],
    /// Instantaneous identities: internal totals minus receipts.
    pub identity: [f64; 3],
    pub inventory: [f64; 3],
    /// Inventory energy minus `p_s (V_b + V_d)`: zone and transit internal energy.
    pub internal_energy_j: f64,
    /// Solver tolerance of the mass, energy and boron totals at this state.
    pub tolerance: [f64; 3],
    pub max_abs_scaled_row: f64,
    pub steps: i64,
    pub error_failures: i64,
    pub convergence_failures: i64,
    pub last_step_s: f64,
    pub order: i32,
}

/// Evaluate a sample; a failure at an accepted state is a property refusal.
pub fn sample(
    system: &CellSystem,
    t: f64,
    y: &[f64],
    yp: &[f64],
    atol: &[f64],
    rtol: f64,
) -> Result<Sample, String> {
    let e = system
        .evaluate(t, y, yp, None, None)
        .map_err(|f| text(&f))?;
    let c = &e.ev.column;
    let taps: Taps = system.cell.taps(&If97, c).map_err(|f| text(&f))?;
    let f = &e.ev.flows;
    let b = &e.ev.balance;
    let inv = system.cell.inventory(&e.x, c);
    let x = &e.x;
    let masses = [
        x.vapor_mass.value,
        x.admitted_mass.value,
        x.resident_mass.value,
        x.bubble_mass.value,
        x.drop_mass.value,
    ];
    let sc = &system.scales;
    let tol = |idx: &[usize]| -> f64 {
        idx.iter()
            .map(|i| rtol * (y[*i] * sc[*i]).abs() + atol[*i] * sc[*i])
            .sum()
    };
    let relief = f.relief;
    let flow_at = |flow: &Option<Flow>| flow.as_ref().map_or(0., |f| e.receipts[f.port].mass.value);
    let max_row = (0..system.n())
        .map(|i| e.row(i).value.abs())
        .fold(0., f64::max);
    Ok(Sample {
        t,
        event: None,
        pt1_pa: taps.pt1_pa.value,
        interface_pa: c.interface_pressure.value,
        bottom_pa: c.bottom_pressure.value,
        lt_dp_pa: taps.level_difference_pa.value,
        mixture_level_m: taps.mixture_level_m.value,
        collapsed_level_m: taps.collapsed_level_m.value,
        boundary_elevation_m: c.boundary_elevation.value,
        admitted_thickness_m: c.admitted_thickness.value,
        withdrawal_fraction: c.withdrawal_fraction.value,
        masses,
        drop_boron_kg: x.drop_boron.value,
        temperatures_k: [
            c.vapor.temperature.value,
            c.admitted.temperature.value,
            c.resident.temperature.value,
        ],
        departure_k: taps.departures.map(|d| d.departure_k),
        metastable_k: taps.departures.map(|d| d.metastable_k),
        within_band: taps.departures.map(|d| d.within_band),
        credited: taps.departures.map(|d| d.credited),
        zone_pressures_pa: taps.departures.map(|d| d.pressure_pa),
        drop_velocity_m_s: f.drop.velocity.value,
        bubble_velocity_m_s: f.bubble.velocity.value,
        gap_margin: f.bubble.gap_margin.min(f.drop.gap_margin),
        rain_kg_s: f.drop_fall.value,
        rise_kg_s: f.bubble_rise.value,
        spray_condensation_kg_s: f.spray_condensation.value,
        flashing_kg_s: [f.admitted_flashing.value, f.resident_flashing.value],
        vapor_condensation_kg_s: f.vapor_condensation.value,
        interface_evaporation_kg_s: -f.interface.liquid.mass.value,
        inversion_kg_s: f.inversion.value,
        conduction_w: f.conduction.value,
        surge_kg_s: flow_at(&system.surge),
        spray_kg_s: flow_at(&system.spray),
        lift: e.lift.value,
        demand_open: system.relief.is_some_and(|r| r.demand_open),
        motion: system
            .relief
            .map_or_else(|| "none".into(), |r| format!("{:?}", r.motion)),
        relief_vapor_kg_s: relief.map_or(0., |r| r.vapor_kg_s.value),
        relief_drop_kg_s: relief.map_or(0., |r| r.drop_kg_s.value),
        relief_boron_kg_s: relief.map_or(0., |r| r.boron_kg_s.value),
        relief_enthalpy_w: relief.map_or(0., |r| r.enthalpy_w.value),
        receipt: [
            b.receipt_mass_kg_s.value,
            b.receipt_energy_w.value,
            b.receipt_boron_kg_s.value,
        ],
        volume_work_w: b.volume_work_w.value,
        transit_drift_w: f.transit_drift.map(|q| q.value),
        identity: [
            b.mass_kg_s.value - b.receipt_mass_kg_s.value,
            b.energy_w.value - b.receipt_energy_w.value,
            b.boron_kg_s.value - b.receipt_boron_kg_s.value,
        ],
        inventory: [inv.mass_kg.value, inv.energy_j.value, inv.boron_kg.value],
        internal_energy_j: inv.energy_j.value
            - c.interface_pressure.value * (x.bubble_volume.value + x.drop_volume.value),
        tolerance: [
            tol(&[
                st::VAPOR_MASS,
                st::ADMITTED_MASS,
                st::RESIDENT_MASS,
                st::BUBBLE_MASS,
                st::DROP_MASS,
            ]),
            tol(&[st::VAPOR_ENERGY, st::ADMITTED_ENERGY, st::RESIDENT_ENERGY]),
            tol(&[st::ADMITTED_BORON, st::RESIDENT_BORON, st::DROP_BORON]),
        ],
        max_abs_scaled_row: max_row,
        ..Sample::default()
    })
}

/// Declared configuration of one run.
#[derive(Clone)]
pub struct RunSpec {
    pub label: String,
    pub rtol: f64,
    pub atol: Vec<f64>,
    pub max_order: usize,
    pub duration_s: f64,
    pub output_s: f64,
    /// Boundary breakpoints inside (0, duration]; IDA stops at each.
    pub breakpoints: Vec<f64>,
    pub nonnegative: Vec<usize>,
    pub cpu_cap_s: f64,
    /// Process CPU time at which the set's bound is reached.
    pub set_deadline_cpu_s: f64,
    /// Nominal and refined runs: stop rules 2 and 7 apply.
    pub credited: bool,
    /// Limit runs (gate 8) end at their first limit and report it.
    pub limit: bool,
    pub resolvability_factor: f64,
}

#[derive(Clone, Debug, Default)]
pub struct Totals {
    pub steps: i64,
    pub residuals: i64,
    pub jacobians: i64,
    pub nonlinear_iterations: i64,
    pub error_failures: i64,
    pub convergence_failures: i64,
    pub linear_setups: i64,
    pub root_evaluations: i64,
}
impl Totals {
    fn add(&mut self, s: &leitbild_operating_water::ida::Stats) {
        self.steps += s.steps;
        self.residuals += s.residuals;
        self.jacobians += s.jacobians;
        self.nonlinear_iterations += s.nonlinear_iterations;
        self.error_failures += s.error_failures;
        self.convergence_failures += s.convergence_failures;
        self.linear_setups += s.linear_setups;
        self.root_evaluations += s.root_evaluations;
    }
    fn json(&self) -> Value {
        json!({"steps":self.steps,"residuals":self.residuals,"jacobians":self.jacobians,"nonlinear_iterations":self.nonlinear_iterations,"error_test_failures":self.error_failures,"convergence_failures":self.convergence_failures,"linear_setups":self.linear_setups,"root_evaluations":self.root_evaluations})
    }
}

/// How a run ended.
#[derive(Clone, Debug, PartialEq)]
pub enum End {
    Completed,
    /// A D1 stop rule fired on an accepted state or event.
    StopRule {
        rule: u8,
        reason: String,
    },
    /// A limit run reached a declared limit.
    Limit {
        label: String,
    },
    CpuCap,
    SetBound,
    /// The solver or a harness admission failed.
    Failure {
        reason: String,
    },
}

pub struct Run {
    pub label: String,
    pub samples: Vec<Sample>,
    /// Accepted internal step endpoints checked against the band.
    pub accepted_checks: usize,
    pub accepted_peaks: [(f64, f64); 3],
    pub accepted_band_violation: Option<String>,
    pub relief_events: Vec<Value>,
    pub area_crossings: Vec<Value>,
    pub structural: Vec<Value>,
    pub initializations: Vec<Value>,
    pub resolvability: Vec<Value>,
    pub uncredited: Vec<Value>,
    pub end: End,
    pub totals: Totals,
    pub handles: usize,
    pub counters: Counters,
    pub cpu_s: f64,
    pub thread_cpu_s: f64,
    pub diagnostic_cpu_s: f64,
    pub wall_s: f64,
    pub y: Vec<f64>,
    pub yp: Vec<f64>,
    pub reached_s: f64,
}

fn new_handle(
    system: CellSystem,
    t: f64,
    y: &[f64],
    yp: &[f64],
    spec: &RunSpec,
    stop: f64,
) -> Result<Ida<Segment>, String> {
    let ids = system.differential();
    let roots = system.roots_active();
    let mut ida = Ida::new(
        Segment { system, roots },
        Initial {
            time: t,
            y,
            yp,
            differential: &ids,
            absolute_tolerance: &spec.atol,
            relative_tolerance: spec.rtol,
        },
    )?;
    ida.set_max_order(spec.max_order)?;
    ida.constrain_nonnegative(&spec.nonnegative)?;
    ida.stop_at(stop)?;
    Ok(ida)
}

/// IDACalcIC at a segment start and the scaled residual right after it.
fn calcic(
    ida: &mut Ida<Segment>,
    t: f64,
    horizon: f64,
    y: &mut [f64],
    yp: &mut [f64],
) -> Result<Value, String> {
    let n = ida.system().system.n();
    let rows = |ida: &Ida<Segment>, y: &[f64], yp: &[f64]| -> Result<Vec<f64>, String> {
        let e = ida
            .system()
            .system
            .evaluate(t, y, yp, None, None)
            .map_err(|f| text(&f))?;
        Ok((0..n).map(|i| e.row(i).value).collect())
    };
    let before = rows(ida, y, yp).ok();
    let (y0, yp0) = (y.to_vec(), yp.to_vec());
    ida.initialize(horizon, y, yp)?;
    let after = rows(ida, y, yp).map_err(|e| format!("post-CalcIC residual: {e}"))?;
    let (largest, row) = after
        .iter()
        .enumerate()
        .map(|(i, r)| (r.abs(), i))
        .fold((0., 0), |b, x| if x.0 > b.0 { x } else { b });
    let pre = before
        .as_ref()
        .map(|b| b.iter().map(|r| r.abs()).fold(0., f64::max));
    let dy = (0..n).map(|i| (y[i] - y0[i]).abs()).fold(0., f64::max);
    let dyp: Vec<f64> = (0..n).map(|i| yp[i] - yp0[i]).collect();
    Ok(
        json!({"t":t,"max_abs_scaled_row":largest,"row":row,"pre_calcic_max_abs_scaled_row":pre,
        "post_rows":after,"pre_rows":before,"max_abs_y_change":dy,"yp_change":dyp}),
    )
}

/// Accepted-state stop rules on a sample. Returns the rule and reason.
fn stop_rules(sample: &Sample, spec: &RunSpec, admitted_atol_kg: f64) -> Option<(u8, String)> {
    let names = ["vapor", "admitted", "resident"];
    for k in 0..3 {
        if !sample.within_band[k] {
            return Some((
                1,
                format!(
                    "{} zone departure {:.4} K (metastable {:.4} K) at {:.0} Pa is beyond the admitted band at t={} s",
                    names[k],
                    sample.departure_k[k],
                    sample.metastable_k[k],
                    sample.zone_pressures_pa[k],
                    sample.t
                ),
            ));
        }
    }
    if spec.credited {
        for k in 0..3 {
            if !sample.credited[k] {
                return Some((
                    2,
                    format!(
                        "credited {} departure {:.4} K above creditedMax_K at nominal theta at t={} s",
                        names[k], sample.metastable_k[k], sample.t
                    ),
                ));
            }
        }
        if sample.masses[1] < spec.resolvability_factor * admitted_atol_kg {
            return Some((
                7,
                format!(
                    "A-layer resolvability report at t={} s: M_A={} kg < {} x atol {} kg (delta_A {} m)",
                    sample.t,
                    sample.masses[1],
                    spec.resolvability_factor,
                    admitted_atol_kg,
                    sample.admitted_thickness_m
                ),
            ));
        }
    }
    None
}

/// Integrate one declared run from the prepared state `y0` at rest.
pub fn run(system: CellSystem, y0: &[f64], spec: &RunSpec) -> Run {
    let started = cpu_s();
    let thread_started = thread_cpu_s();
    let wall = Instant::now();
    let n = system.n();
    let admitted_atol_kg = spec.atol[st::ADMITTED_MASS] * system.scales[st::ADMITTED_MASS];
    let mut out = Run {
        label: spec.label.clone(),
        samples: Vec::new(),
        accepted_checks: 0,
        accepted_peaks: [(f64::NEG_INFINITY, 0.); 3],
        accepted_band_violation: None,
        relief_events: Vec::new(),
        area_crossings: Vec::new(),
        structural: Vec::new(),
        initializations: Vec::new(),
        resolvability: Vec::new(),
        uncredited: Vec::new(),
        end: End::Completed,
        totals: Totals::default(),
        handles: 0,
        counters: Counters::default(),
        cpu_s: 0.,
        thread_cpu_s: 0.,
        diagnostic_cpu_s: 0.,
        wall_s: 0.,
        y: y0.to_vec(),
        yp: vec![0.; n],
        reached_s: 0.,
    };
    let mut y = y0.to_vec();
    let mut yp = vec![0.; n];
    let mut t = 0.;
    let mut breaks: Vec<f64> = spec
        .breakpoints
        .iter()
        .copied()
        .filter(|b| *b > 0. && *b < spec.duration_s)
        .collect();
    breaks.push(spec.duration_s);
    breaks.sort_by(f64::total_cmp);
    breaks.dedup();
    let next_break = |t: f64| breaks.iter().copied().find(|b| *b > t).unwrap();
    let mut diagnostic = 0.;
    fn finish(
        out: &mut Run,
        end: End,
        ida: Option<&Ida<Segment>>,
        totals: &Totals,
        t: f64,
        y: &[f64],
        yp: &[f64],
    ) {
        out.end = end;
        let mut totals = totals.clone();
        if let Some(ida) = ida {
            if let Ok(s) = ida.stats() {
                totals.add(&s);
            }
            let c = &ida.system().system.counters;
            out.counters.residuals += c.residuals;
            out.counters.jacobians += c.jacobians;
            out.counters.residual_wall_s += c.residual_wall_s;
            out.counters.jacobian_wall_s += c.jacobian_wall_s;
            out.counters.root_calls += c.root_calls;
        }
        out.totals = totals;
        out.reached_s = t;
        out.y = y.to_vec();
        out.yp = yp.to_vec();
    }
    let mut totals = Totals::default();
    let mut ida = match new_handle(system, t, &y, &yp, spec, next_break(t)) {
        Ok(h) => h,
        Err(e) => {
            finish(
                &mut out,
                End::Failure {
                    reason: format!("construction: {e}"),
                },
                None,
                &totals,
                t,
                &y,
                &yp,
            );
            return out;
        }
    };
    out.handles = 1;
    match calcic(&mut ida, t, spec.output_s, &mut y, &mut yp) {
        Ok(v) => out.initializations.push(v),
        Err(e) => {
            finish(
                &mut out,
                End::Failure {
                    reason: format!("initial CalcIC: {e}"),
                },
                Some(&ida),
                &totals,
                t,
                &y,
                &yp,
            );
            return out;
        }
    }
    let record = |out: &mut Run,
                  ida: &Ida<Segment>,
                  totals: &Totals,
                  t: f64,
                  y: &[f64],
                  yp: &[f64],
                  event: Option<String>,
                  diagnostic: &mut f64|
     -> Result<Sample, String> {
        let d = cpu_s();
        let mut smp = sample(&ida.system().system, t, y, yp, &spec.atol, spec.rtol)?;
        if let Ok(stats) = ida.stats() {
            smp.steps = totals.steps + stats.steps;
            smp.error_failures = totals.error_failures + stats.error_failures;
            smp.convergence_failures = totals.convergence_failures + stats.convergence_failures;
            smp.last_step_s = stats.last_step;
            smp.order = stats.last_order;
        }
        smp.event = event;
        out.samples.push(smp.clone());
        *diagnostic += cpu_s() - d;
        Ok(smp)
    };
    // Accepted internal endpoint: band and peaks only.
    let mut last_accepted = f64::NEG_INFINITY;
    let mut check_accepted =
        |out: &mut Run, ida: &Ida<Segment>, diagnostic: &mut f64| -> Option<(u8, String)> {
            let d = cpu_s();
            let mut ya = vec![0.; n];
            let mut ypa = vec![0.; n];
            let result = match ida.current_state(&mut ya, &mut ypa) {
                Ok(ta) if ta > last_accepted => {
                    last_accepted = ta;
                    out.accepted_checks += 1;
                    match sample(&ida.system().system, ta, &ya, &ypa, &spec.atol, spec.rtol) {
                        Ok(smp) => {
                            for k in 0..3 {
                                if smp.metastable_k[k] > out.accepted_peaks[k].0 {
                                    out.accepted_peaks[k] = (smp.metastable_k[k], ta);
                                }
                            }
                            stop_rules(&smp, spec, admitted_atol_kg)
                        }
                        Err(e) => Some((
                            1,
                            format!("property refusal at the accepted state t={ta} s: {e}"),
                        )),
                    }
                }
                _ => None,
            };
            *diagnostic += cpu_s() - d;
            result
        };
    match record(
        &mut out,
        &ida,
        &totals,
        t,
        &y,
        &yp,
        Some("initial".into()),
        &mut diagnostic,
    ) {
        Ok(smp) => {
            if let Some((rule, reason)) = stop_rules(&smp, spec, admitted_atol_kg) {
                finish(
                    &mut out,
                    End::StopRule { rule, reason },
                    Some(&ida),
                    &totals,
                    t,
                    &y,
                    &yp,
                );
                return out;
            }
        }
        Err(e) => {
            finish(
                &mut out,
                End::StopRule {
                    rule: 1,
                    reason: format!("property refusal at the initial state: {e}"),
                },
                Some(&ida),
                &totals,
                t,
                &y,
                &yp,
            );
            return out;
        }
    }
    let mut k: u64 = 1;
    loop {
        let next_output = k as f64 * spec.output_s;
        let stop = next_break(t);
        let target = next_output.min(stop).min(spec.duration_s);
        let advanced = ida.advance(target, &mut y, &mut yp);
        let end = match advanced {
            Ok(Advance::Reached(tr)) => {
                t = tr;
                let mut end = None;
                match record(&mut out, &ida, &totals, t, &y, &yp, None, &mut diagnostic) {
                    Ok(smp) => {
                        reports(&mut out, &smp, spec, admitted_atol_kg);
                        if let Some((rule, reason)) = stop_rules(&smp, spec, admitted_atol_kg) {
                            end = Some(stop_rule_end(spec, rule, reason));
                        }
                    }
                    Err(e) => {
                        end = Some(stop_rule_end(
                            spec,
                            1,
                            format!("property refusal at an accepted output t={t} s: {e}"),
                        ))
                    }
                }
                if end.is_none()
                    && let Some((rule, reason)) = check_accepted(&mut out, &ida, &mut diagnostic)
                {
                    end = Some(stop_rule_end(spec, rule, reason));
                    if out.accepted_band_violation.is_none() {
                        out.accepted_band_violation = Some(format!("{rule}"));
                    }
                }
                if end.is_none() {
                    if t >= next_output - 1e-9 * spec.output_s {
                        k += 1;
                    }
                    if t >= spec.duration_s {
                        end = Some(if spec.limit {
                            End::Limit {
                                label: "maxDuration_s reached".into(),
                            }
                        } else {
                            End::Completed
                        });
                    } else if t >= stop
                        && let Err(e) = ida.stop_at(next_break(t))
                    {
                        end = Some(End::Failure {
                            reason: format!("stop boundary: {e}"),
                        });
                    }
                }
                end
            }
            Ok(Advance::Root { time, directions }) => {
                t = time;
                let roots = ida.system().roots.clone();
                let fired: Vec<(Root, i32)> = roots
                    .iter()
                    .zip(&directions)
                    .filter(|(_, d)| **d != 0)
                    .map(|(r, d)| (*r, *d))
                    .collect();
                let label = fired
                    .iter()
                    .map(|(r, d)| {
                        format!(
                            "{} ({})",
                            r.label(),
                            if *d > 0 { "rising" } else { "falling" }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("; ");
                let mut end = None;
                let mut refusal = None;
                let smp = match record(
                    &mut out,
                    &ida,
                    &totals,
                    t,
                    &y,
                    &yp,
                    Some(label.clone()),
                    &mut diagnostic,
                ) {
                    Ok(smp) => Some(smp),
                    Err(e) => {
                        end = Some(stop_rule_end(
                            spec,
                            1,
                            format!("property refusal at a root t={t} s: {e}"),
                        ));
                        refusal = Some(e);
                        None
                    }
                };
                let stats = ida.stats().ok();
                for (root, d) in &fired {
                    match root {
                        Root::MixtureEdge(e) | Root::BoundaryEdge(e) => {
                            out.area_crossings.push(json!({"t":t,"root":root.label(),"edge_m":e,"direction":d,
                                "level":if matches!(root, Root::MixtureEdge(_)) {"mixture"} else {"A/R boundary"},
                                "steps":stats.as_ref().map(|s| totals.steps + s.steps),
                                "error_test_failures":stats.as_ref().map(|s| totals.error_failures + s.error_failures),
                                "convergence_failures":stats.as_ref().map(|s| totals.convergence_failures + s.convergence_failures),
                                "last_step_s":stats.as_ref().map(|s| s.last_step)}));
                        }
                        Root::ZoneMass(_) | Root::MixtureTop => {
                            out.structural.push(json!({"t":t,"root":root.label(),"direction":d,"sample":smp.as_ref().map(sample_json),"sample_refusal":refusal}));
                            end = Some(if spec.limit {
                                End::Limit {
                                    label: format!("structural event: {}", root.label()),
                                }
                            } else {
                                End::StopRule {
                                    rule: 3,
                                    reason: format!(
                                        "PZR structural event at t={t} s: {}",
                                        root.label()
                                    ),
                                }
                            });
                        }
                        Root::Demand | Root::Travel => {}
                    }
                }
                let demand = fired
                    .iter()
                    .find(|(r, _)| *r == Root::Demand)
                    .map(|(_, d)| *d);
                let travel = fired.iter().any(|(r, _)| *r == Root::Travel);
                if end.is_none() && (demand.is_some() || travel) {
                    let mut next = ida.system().system.clone();
                    let relief = next
                        .relief
                        .as_mut()
                        .expect("relief roots imply a relief outlet");
                    let before = (relief.demand_open, relief.motion);
                    let located = y[LIFT] * next.scales[LIFT];
                    let mut set_lift = None;
                    if travel {
                        match relief.motion {
                            ReliefMotion::Opening => {
                                relief.motion = ReliefMotion::Open;
                                set_lift = Some(1.);
                            }
                            ReliefMotion::Closing => {
                                relief.motion = ReliefMotion::Closed;
                                set_lift = Some(0.);
                            }
                            m => {
                                end = Some(End::Failure {
                                    reason: format!("travel root while {m:?}"),
                                });
                            }
                        }
                    }
                    if let Some(d) = demand {
                        let expected = if relief.demand_open { -1 } else { 1 };
                        if d != expected {
                            end = Some(End::Failure {
                                reason: format!(
                                    "relief demand root crossed in direction {d} with demand_open={}",
                                    relief.demand_open
                                ),
                            });
                        }
                        relief.demand_open = !relief.demand_open;
                        relief.motion = match (relief.demand_open, relief.motion) {
                            (true, ReliefMotion::Closed | ReliefMotion::Closing) => {
                                ReliefMotion::Opening
                            }
                            (false, ReliefMotion::Open | ReliefMotion::Opening) => {
                                ReliefMotion::Closing
                            }
                            (_, m) => m,
                        };
                    }
                    let after = (relief.demand_open, relief.motion);
                    let rate = relief.device.lift_rate(relief.motion);
                    if let Some(stop_value) = set_lift {
                        // The mechanical stop the located root reached.
                        y[LIFT] = stop_value / next.scales[LIFT];
                    }
                    yp[LIFT] = rate / next.scales[LIFT];
                    out.relief_events.push(json!({"t":t,"pt1_pa":y[st::ROOF_PRESSURE]*next.scales[st::ROOF_PRESSURE],
                        "demand_root":demand,"travel_root":travel,
                        "before":{"demand_open":before.0,"motion":format!("{:?}",before.1)},
                        "after":{"demand_open":after.0,"motion":format!("{:?}",after.1)},
                        "lift_located":located,"lift_set":set_lift,"stop_adjustment":set_lift.map(|v| (v - located).abs()),
                        "lift_rate_per_s":rate}));
                    if end.is_none() {
                        if let Ok(s) = ida.stats() {
                            totals.add(&s);
                        }
                        let c = &ida.system().system.counters;
                        out.counters.residuals += c.residuals;
                        out.counters.jacobians += c.jacobians;
                        out.counters.residual_wall_s += c.residual_wall_s;
                        out.counters.jacobian_wall_s += c.jacobian_wall_s;
                        out.counters.root_calls += c.root_calls;
                        next.counters = Counters::default();
                        match new_handle(next, t, &y, &yp, spec, next_break(t)) {
                            Ok(h) => {
                                ida = h;
                                out.handles += 1;
                                match calcic(&mut ida, t, t + spec.output_s, &mut y, &mut yp) {
                                    Ok(v) => out.initializations.push(v),
                                    Err(e) => {
                                        end = Some(End::Failure {
                                            reason: format!(
                                                "CalcIC after the relief event at t={t} s: {e}"
                                            ),
                                        })
                                    }
                                }
                            }
                            Err(e) => {
                                end = Some(End::Failure {
                                    reason: format!("relief reinitialization at t={t} s: {e}"),
                                })
                            }
                        }
                    }
                }
                if end.is_none()
                    && let Some(smp) = &smp
                    && let Some((rule, reason)) = stop_rules(smp, spec, admitted_atol_kg)
                {
                    end = Some(stop_rule_end(spec, rule, reason));
                }
                end
            }
            Err(e) => {
                let reason = format!(
                    "IDA stopped at t={} s: {e}",
                    ida.stats().map_or(t, |s| s.internal_time)
                );
                Some(if spec.limit {
                    End::Limit {
                        label: classify_limit(&reason),
                    }
                } else {
                    End::Failure { reason }
                })
            }
        };
        if let Some(end) = end {
            finish(&mut out, end, Some(&ida), &totals, t, &y, &yp);
            break;
        }
        let now = cpu_s();
        if now - started > spec.cpu_cap_s {
            finish(&mut out, End::CpuCap, Some(&ida), &totals, t, &y, &yp);
            break;
        }
        if now > spec.set_deadline_cpu_s {
            finish(&mut out, End::SetBound, Some(&ida), &totals, t, &y, &yp);
            break;
        }
    }
    out.cpu_s = cpu_s() - started;
    out.thread_cpu_s = thread_cpu_s() - thread_started;
    out.diagnostic_cpu_s = diagnostic;
    out.wall_s = wall.elapsed().as_secs_f64();
    out
}

fn stop_rule_end(spec: &RunSpec, rule: u8, reason: String) -> End {
    if spec.limit && rule == 1 {
        End::Limit {
            label: format!("property-domain edge: {reason}"),
        }
    } else {
        End::StopRule { rule, reason }
    }
}

/// Runs that are not credited report credited-departure overruns and A-layer
/// resolvability instead of stopping on them (sensitivities are reported,
/// not gated; limit runs report).
fn reports(out: &mut Run, sample: &Sample, spec: &RunSpec, admitted_atol_kg: f64) {
    if spec.credited {
        return;
    }
    let names = ["vapor", "admitted", "resident"];
    for k in 0..3 {
        if !sample.credited[k] && sample.within_band[k] {
            match out.uncredited.iter_mut().find(|v| v["zone"] == names[k]) {
                Some(v) => {
                    v["last_s"] = json!(sample.t);
                    v["samples"] = json!(v["samples"].as_u64().unwrap_or(0) + 1);
                    if sample.metastable_k[k] > v["peak_k"].as_f64().unwrap_or(0.) {
                        v["peak_k"] = json!(sample.metastable_k[k]);
                        v["peak_s"] = json!(sample.t);
                    }
                }
                None => out.uncredited.push(json!({"zone":names[k],"first_s":sample.t,"last_s":sample.t,"samples":1,"peak_k":sample.metastable_k[k],"peak_s":sample.t})),
            }
        }
    }
    if sample.masses[1] < spec.resolvability_factor * admitted_atol_kg
        && out.resolvability.len() < 1000
    {
        out.resolvability.push(json!({"t":sample.t,"M_A_kg":sample.masses[1],"delta_A_m":sample.admitted_thickness_m,"atol_M_A_kg":admitted_atol_kg}));
    }
}

/// Label a solver stop of a limit run by what the last trial reported.
fn classify_limit(reason: &str) -> String {
    let kind = if reason.contains("TrialBand") {
        "property-domain edge: a metastable trial beyond the bounded trial band (no accepted state past it)"
    } else if reason.contains("Domain") {
        "property-domain edge: an IF97 domain refusal (no accepted state past it)"
    } else if reason.contains("solid-PZR") {
        "structural limit: the mixture level reached an upper port (solid PZR)"
    } else {
        "solver stop that is not a declared limit"
    };
    format!("{kind}; {reason}")
}

pub fn sample_json(s: &Sample) -> Value {
    json!({"t":s.t,"event":s.event,"pt1_pa":s.pt1_pa,"p_s_pa":s.interface_pa,"p_bottom_pa":s.bottom_pa,"lt_dp_pa":s.lt_dp_pa,
        "mixture_level_m":s.mixture_level_m,"collapsed_level_m":s.collapsed_level_m,"z_ar_m":s.boundary_elevation_m,"delta_a_m":s.admitted_thickness_m,"phi":s.withdrawal_fraction,
        "mass_kg":{"g":s.masses[0],"A":s.masses[1],"R":s.masses[2],"b":s.masses[3],"d":s.masses[4]},"drop_boron_kg":s.drop_boron_kg,
        "temperature_k":{"g":s.temperatures_k[0],"A":s.temperatures_k[1],"R":s.temperatures_k[2]},
        "departure_k":{"g":s.departure_k[0],"A":s.departure_k[1],"R":s.departure_k[2]},
        "drop_velocity_m_s":s.drop_velocity_m_s,"bubble_velocity_m_s":s.bubble_velocity_m_s,"gap_margin":s.gap_margin,
        "rain_kg_s":s.rain_kg_s,"bubble_rise_kg_s":s.rise_kg_s,"spray_condensation_kg_s":s.spray_condensation_kg_s,
        "flashing_kg_s":{"A":s.flashing_kg_s[0],"R":s.flashing_kg_s[1]},"vapor_condensation_kg_s":s.vapor_condensation_kg_s,
        "interface_evaporation_kg_s":s.interface_evaporation_kg_s,"inversion_kg_s":s.inversion_kg_s,"conduction_w":s.conduction_w,
        "surge_kg_s":s.surge_kg_s,"spray_kg_s":s.spray_kg_s,
        "relief":{"lift":s.lift,"demand_open":s.demand_open,"motion":s.motion,"vapor_kg_s":s.relief_vapor_kg_s,"drop_kg_s":s.relief_drop_kg_s,"boron_kg_s":s.relief_boron_kg_s},
        "steps":s.steps,"last_step_s":s.last_step_s,"order":s.order,"error_test_failures":s.error_failures,"convergence_failures":s.convergence_failures})
}

/// Conservation ledger over the samples: inventory change against the
/// trapezoidal integral of the receipts on outputs, events and breakpoints.
pub fn ledger(run: &Run, surge: Option<&Table>, spray: Option<&Table>) -> Value {
    let samples = &run.samples;
    let Some(first) = samples.first() else {
        return json!(null);
    };
    let mut integral = [0.; 3];
    let mut work = 0.;
    let mut drift = [0.; 2];
    let mut relief = [0.; 3];
    let mut worst = [0.; 3];
    let mut worst_ratio = [0.; 3];
    let mut identity = [0_f64; 3];
    let mut previous = first;
    for s in samples.iter().skip(1) {
        let dt = s.t - previous.t;
        if dt < 0. {
            continue;
        }
        for i in 0..3 {
            integral[i] += 0.5 * dt * (s.receipt[i] + previous.receipt[i]);
        }
        work += 0.5 * dt * (s.volume_work_w + previous.volume_work_w);
        for i in 0..2 {
            drift[i] += 0.5 * dt * (s.transit_drift_w[i] + previous.transit_drift_w[i]);
        }
        relief[0] += 0.5
            * dt
            * (s.relief_vapor_kg_s
                + s.relief_drop_kg_s
                + previous.relief_vapor_kg_s
                + previous.relief_drop_kg_s);
        relief[1] += 0.5 * dt * (s.relief_enthalpy_w + previous.relief_enthalpy_w);
        relief[2] += 0.5 * dt * (s.relief_boron_kg_s + previous.relief_boron_kg_s);
        let closure = [
            s.inventory[0] - first.inventory[0] - integral[0],
            (s.internal_energy_j - first.internal_energy_j) - (integral[1] - work),
            s.inventory[2] - first.inventory[2] - integral[2],
        ];
        for i in 0..3 {
            if closure[i].abs() > worst[i] {
                worst[i] = closure[i].abs();
            }
            let ratio = closure[i].abs() / s.tolerance[i];
            if ratio > worst_ratio[i] {
                worst_ratio[i] = ratio;
            }
            identity[i] = identity[i].max(s.identity[i].abs());
        }
        previous = s;
    }
    let last = samples.last().unwrap();
    let t = last.t;
    // The recorded tables integrate exactly; the trapezoid on their
    // breakpoints must reproduce them.
    let exact_surge = surge.map(|tb| tb.integral(t));
    let exact_spray = spray.map(|tb| tb.integral(t));
    let final_closure = [
        last.inventory[0] - first.inventory[0] - integral[0],
        (last.internal_energy_j - first.internal_energy_j) - (integral[1] - work),
        last.inventory[2] - first.inventory[2] - integral[2],
    ];
    json!({"t_s":t,"method":"inventory change minus the trapezoidal integral of the cell's receipts over outputs, root events and breakpoints; energy as internal energy (zones plus transit at u_sat) against receipts minus the hydrostatic remainder",
        "mass":{"inventory_change_kg":last.inventory[0]-first.inventory[0],"receipts_kg":integral[0],"closure_kg":final_closure[0],"max_abs_closure_kg":worst[0],"max_closure_over_solver_tolerance":worst_ratio[0],"solver_tolerance_kg":last.tolerance[0],"within_solver_tolerance":worst_ratio[0] <= 1.,"max_instantaneous_identity_kg_s":identity[0]},
        "energy":{"internal_energy_change_j":last.internal_energy_j-first.internal_energy_j,"receipts_j":integral[1],"hydrostatic_remainder_j":work,"transit_drift_j":{"bubbles_paid_by_R":drift[0],"drops_paid_by_g":drift[1]},"closure_j":final_closure[1],"max_abs_closure_j":worst[1],"max_closure_over_solver_tolerance":worst_ratio[1],"solver_tolerance_j":last.tolerance[1],"max_instantaneous_identity_w":identity[1]},
        "boron":{"inventory_change_kg":last.inventory[2]-first.inventory[2],"receipts_kg":integral[2],"closure_kg":final_closure[2],"max_abs_closure_kg":worst[2],"max_closure_over_solver_tolerance":worst_ratio[2],"solver_tolerance_kg":last.tolerance[2],"within_solver_tolerance":worst_ratio[2] <= 1.,"max_instantaneous_identity_kg_s":identity[2]},
        "relief_out":{"mass_kg":relief[0],"enthalpy_j":relief[1],"boron_kg":relief[2]},
        "recorded_tables_exact":{"surge_kg":exact_surge,"spray_kg":exact_spray}})
}

/// Per-run summary for receipts.
pub fn run_json(run: &Run, stride: usize) -> Value {
    let names = ["vapor", "admitted", "resident"];
    let mut peaks = serde_json::Map::new();
    for k in 0..3 {
        let (value, t) = run.samples.iter().map(|s| (s.metastable_k[k], s.t)).fold(
            (f64::NEG_INFINITY, 0.),
            |b, x| if x.0 > b.0 { x } else { b },
        );
        let (low, tl) = run
            .samples
            .iter()
            .map(|s| (s.departure_k[k], s.t))
            .fold((f64::INFINITY, 0.), |b, x| if x.0 < b.0 { x } else { b });
        let (high, th) = run.samples.iter().map(|s| (s.departure_k[k], s.t)).fold(
            (f64::NEG_INFINITY, 0.),
            |b, x| if x.0 > b.0 { x } else { b },
        );
        peaks.insert(
            names[k].into(),
            json!({"peak_metastable_k":value,"at_s":t,"signed_departure_min_k":low,"min_at_s":tl,"signed_departure_max_k":high,"max_at_s":th,
                "accepted_step_peak_metastable_k":run.accepted_peaks[k].0,"accepted_step_peak_at_s":run.accepted_peaks[k].1}),
        );
    }
    let end = match &run.end {
        End::Completed => json!({"kind":"completed"}),
        End::StopRule { rule, reason } => json!({"kind":"stop rule","rule":rule,"reason":reason}),
        End::Limit { label } => json!({"kind":"limit","label":label}),
        End::CpuCap => json!({"kind":"run CPU cap reached"}),
        End::SetBound => json!({"kind":"set CPU bound reached"}),
        End::Failure { reason } => json!({"kind":"failure","reason":reason}),
    };
    let series: Vec<Value> = run
        .samples
        .iter()
        .enumerate()
        .filter(|(i, s)| s.event.is_some() || i % stride.max(1) == 0)
        .map(|(_, s)| sample_json(s))
        .collect();
    let max_row = run
        .samples
        .iter()
        .map(|s| s.max_abs_scaled_row)
        .fold(0., f64::max);
    let min_gap = run
        .samples
        .iter()
        .map(|s| s.gap_margin)
        .fold(f64::INFINITY, f64::min);
    let min_a = run
        .samples
        .iter()
        .map(|s| (s.masses[1], s.t))
        .fold((f64::INFINITY, 0.), |b, x| if x.0 < b.0 { x } else { b });
    json!({"label":run.label,"end":end,"reached_s":run.reached_s,"totals":run.totals.json(),"handles":run.handles,
        "cpu_s":run.cpu_s,"thread_cpu_s":run.thread_cpu_s,"diagnostic_cpu_s":run.diagnostic_cpu_s,"solver_cpu_s":run.cpu_s-run.diagnostic_cpu_s,"wall_s":run.wall_s,
        "harness_counters":{"residual_calls":run.counters.residuals,"jacobian_calls":run.counters.jacobians,"residual_wall_s":run.counters.residual_wall_s,"jacobian_wall_s":run.counters.jacobian_wall_s,"root_calls":run.counters.root_calls},
        "initializations":run.initializations,"max_abs_scaled_row_at_samples":max_row,
        "metastable_peaks":Value::Object(peaks),"accepted_step_checks":run.accepted_checks,
        "min_drag_gap_margin":min_gap,"min_admitted_mass_kg":{"value":min_a.0,"at_s":min_a.1},
        "relief_events":run.relief_events,"area_step_crossings":run.area_crossings,"structural_events":run.structural,
        "credited_departure_overruns":run.uncredited,"resolvability_reports":run.resolvability,
        "samples":run.samples.len(),"series":series})
}
