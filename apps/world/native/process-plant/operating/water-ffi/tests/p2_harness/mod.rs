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
//! `ReliefDevice::roots`; an end of travel is `ReliefDevice::stop`. Every run
//! starts, at t = 0 and at every relief event, from the exact consistent pair
//! of `consistent_start` on this system's own rows; IDACalcIC is never
//! called. A case without the relief outlet keeps the packet's declared port
//! closed and unarmed: no lift coordinate, no root, never any flow. The
//! free-area steps are roots that only record the crossing. Zone masses
//! reaching zero and the mixture reaching the roof are structural roots.
//!
//! The PZR metal joins every LD-01 case: the heater rods' segments and the
//! shell and head elements, one steel energy each, after the cell's
//! coordinates and the lift. Their sources are `walls::Walls::rates` on the
//! same column; each bank delivers the split of the case's recorded heater
//! request until the common isolator opens, and nothing before or after. A
//! steel element reaching the 304 domain's maximum is a root that ends the
//! run on that applicability limit.
#![allow(dead_code)]
// Zones, ledgers and rows are parallel fixed arrays indexed together.
#![allow(clippy::needless_range_loop)]
use leitbild_operating_plant::{
    network::{
        ConsistentSystem, Failure as CellFailure, Reuse, consistent_start,
        heaters::Heaters,
        stratified::{
            self as st, Boundary, Cell, Coordinates, Heat, Receipt, ReliefDevice, ReliefMotion,
            ReliefState, Slots, Taps,
        },
        walls::{MetalRates, Walls},
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
/// The integrator's ledger (request 4, K2): stock IDAS quadratures of
/// mass, port energy, boron, Joule, exterior loss, hydrostatic remainder and
/// the transit drifts of b, d and b_A.
pub const LEDGER: usize = 9;
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
/// `armed` is the case's `relief: true`: only then does the outlet carry a
/// lift coordinate and roots; otherwise the declared port stays closed.
#[derive(Clone, Copy, Debug)]
pub struct Relief {
    pub port: usize,
    pub device: ReliefDevice,
    pub back_pressure_pa: f64,
    pub motion: ReliefMotion,
    pub demand_open: bool,
    pub armed: bool,
}

/// The PZR metal: heater rod segments and wall elements, one steel energy
/// coordinate each (rods first, in `Heaters::segments` order, then the
/// elements in `Walls::elements` order).
#[derive(Clone)]
pub struct Metal {
    pub heaters: Heaters,
    pub walls: Walls,
    /// The case's recorded heater request, W; none leaves the banks unpowered.
    pub request: Option<Table>,
    /// The common isolator has opened: no bank delivers power.
    pub isolated: bool,
    /// Each coordinate's steel energy at the 304 domain's maximum, J.
    pub limit_energy_j: Vec<f64>,
}
impl Metal {
    pub fn rods(&self) -> usize {
        self.heaters.segments().len()
    }
    pub fn count(&self) -> usize {
        self.rods() + self.walls.elements().len()
    }
    /// Each bank's delivered Joule power at `t`.
    pub fn bank_powers(&self, t: f64) -> Result<Vec<f64>, CellFailure> {
        match (&self.request, self.isolated) {
            (Some(table), false) => self
                .heaters
                .bank_powers(table.value(t).map_err(CellFailure::Fatal)?),
            _ => Ok(vec![0.; self.heaters.banks().len()]),
        }
    }
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
    /// A steel coordinate reaching the 304 domain's maximum temperature.
    SteelLimit(usize),
    /// Gate 5's instantaneous LT indication falling through the cutout's
    /// switching level: from here the lagged, sampled indication can first
    /// satisfy the low-level predicate, so the run stops at every sample.
    LowLevel,
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
            Root::SteelLimit(i) => format!("steel coordinate {i} at the 304 domain maximum"),
            Root::LowLevel => "LT indication at the cutout's switching level".into(),
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
    /// Ledger integrand evaluations (stock IDAS quadratures).
    pub quadratures: u64,
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
    /// The PZR metal, present in every LD-01 case.
    pub metal: Option<Metal>,
    /// Roots that are always active: free-area edges and structural limits.
    pub fixed_roots: Vec<Root>,
    /// Gate 5's cutout while its switching level is still watched by root.
    pub cutout_watch: Option<Cutout>,
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
    /// First metal coordinate, and the metal's rows, sources and powers.
    pub metal_base: usize,
    pub metal_rows: Vec<Scalar>,
    pub metal: Option<MetalRates>,
    pub bank_powers_w: Vec<f64>,
    pub metal_energy_j: Vec<f64>,
}
impl Evaluated {
    pub fn row(&self, i: usize) -> Scalar {
        if i < st::COORDINATES {
            self.ev.rows[i]
        } else if i < self.metal_base {
            self.lift_row
        } else {
            self.metal_rows[i - self.metal_base]
        }
    }
}

impl CellSystem {
    /// The integrator's ledger integrands (request 4, K2), from the same
    /// evaluation the residual makes: the cell's mass, port-energy and boron
    /// receipts, the Joule delivery, the exterior loss, the hydrostatic
    /// remainder and the two transit drifts. Port energy is the cell's energy
    /// receipt less what the metal hands the fluid.
    pub fn ledger_rates(
        &self,
        t: f64,
        y: &[f64],
        yp: &[f64],
    ) -> Result<[f64; LEDGER], CellFailure> {
        let e = self.evaluate(t, y, yp, None, None)?;
        let b = &e.ev.balance;
        let (joule, exterior, fluid) = match &e.metal {
            Some(r) => (
                e.bank_powers_w.iter().sum::<f64>(),
                r.walls.iter().map(|w| w.exterior_w.value).sum::<f64>(),
                r.rods.iter().map(|g| g.fluid_energy_w.value).sum::<f64>()
                    + r.walls.iter().map(|w| w.fluid_energy_w.value).sum::<f64>(),
            ),
            None => (0., 0., 0.),
        };
        let f = &e.ev.flows;
        let drift = [
            f.transit_drift[0].value,
            f.transit_drift[1].value,
            f.admitted_transit_drift.value,
        ];
        Ok([
            b.receipt_mass_kg_s.value,
            b.receipt_energy_w.value - fluid,
            b.receipt_boron_kg_s.value,
            joule,
            exterior,
            b.volume_work_w.value,
            drift[0],
            drift[1],
            drift[2],
        ])
    }
    pub fn n(&self) -> usize {
        self.scales.len()
    }
    pub fn differential(&self) -> Vec<f64> {
        let mut ids = st::DIFFERENTIAL.to_vec();
        if self.armed() {
            ids.push(1.);
        }
        ids.extend(vec![1.; self.metal.as_ref().map_or(0, |m| m.count())]);
        ids
    }
    /// First metal coordinate: after the cell's and the lift.
    pub fn metal_base(&self) -> usize {
        st::COORDINATES + usize::from(self.armed())
    }
    /// The case declares the relief outlet: the lift is a coordinate.
    pub fn armed(&self) -> bool {
        self.relief.is_some_and(|r| r.armed)
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
        if let Some(m) = &self.metal {
            let base = self.metal_base();
            roots.extend((base..base + m.count()).map(Root::SteelLimit));
        }
        if self.cutout_watch.is_some() {
            roots.push(Root::LowLevel);
        }
        if let Some(r) = self.relief.as_ref().filter(|r| r.armed) {
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
        mut reuse: Option<&mut Reuse<CaloricLinearization>>,
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
        let column = self
            .cell
            .column(&If97, &x, reuse.as_deref_mut().map(|r| (r, SLOTS)))?;
        let receipts = self.receipts(t, &column)?;
        let (lift, lift_row, relief) = match &self.relief {
            // The declared outlet of a case without it: closed, unarmed.
            Some(r) if !r.armed => (
                s(0.),
                s(0.),
                Some(ReliefState {
                    lift: s(0.),
                    back_pressure_pa: s(r.back_pressure_pa),
                }),
            ),
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
        // The metal on the same column: rods and walls, coupled by the band
        // enclosures, at each bank's delivered power.
        let metal_base = self.metal_base();
        let (metal_rows, metal, bank_powers_w, metal_energy_j) = match &self.metal {
            Some(m) => {
                let k = m.count();
                let energy: Vec<Scalar> = (metal_base..metal_base + k)
                    .map(|i| Scalar::new(y[i] * sc[i], dir(i, false)))
                    .collect();
                let powers = m.bank_powers(t)?;
                let rates = m.walls.rates(
                    &self.cell,
                    &column,
                    &m.heaters,
                    &energy[..m.rods()],
                    &powers,
                    &energy[m.rods()..],
                    &If97,
                )?;
                let mut sources = rates.rod_metal_rates();
                sources.extend(rates.wall_metal_rates());
                let rows: Vec<Scalar> = (0..k)
                    .map(|j| {
                        let i = metal_base + j;
                        (Scalar::new(yp[i] * sc[i], dir(i, true)) - sources[j]) / s(sc[i])
                    })
                    .collect();
                let values = energy.iter().map(|e| e.value).collect();
                (rows, Some(rates), powers, values)
            }
            None => (Vec::new(), None, Vec::new(), Vec::new()),
        };
        let boundary = Boundary {
            heat: Heat::zero(),
            heaters: metal
                .as_ref()
                .map_or_else(Vec::new, |r| r.heater_receipts()),
            walls: metal.as_ref().map_or_else(Vec::new, |r| r.wall_receipts()),
            relief,
        };
        let ev = self.cell.residual_on_reusing(
            &If97,
            column,
            &x,
            &rate,
            &receipts,
            &boundary,
            &self.cell_scales(),
            reuse,
        )?;
        Ok(Evaluated {
            ev,
            lift,
            lift_row,
            receipts,
            x,
            rate,
            metal_base,
            metal_rows,
            metal,
            bank_powers_w,
            metal_energy_j,
        })
    }

    /// PT1 (the roof tap is `top_m`, so `p_roof`), collapsed and mixture
    /// levels above the bottom, from the coordinates alone.
    pub fn observe(&self, t: f64, y: &[f64]) -> [f64; 4] {
        let v = |i: usize| y[i] * self.scales[i];
        let bottom = self.cell.parameters().bottom_m;
        let collapsed = self
            .cell
            .level(s(v(st::ADMITTED_VOLUME) + v(st::RESIDENT_VOLUME)))
            .value;
        let mixture = self
            .cell
            .level(s(v(st::ADMITTED_VOLUME)
                + v(st::ADMITTED_BUBBLE_VOLUME)
                + v(st::RESIDENT_VOLUME)
                + v(st::BUBBLE_VOLUME)))
            .value;
        [
            t,
            v(st::ROOF_PRESSURE),
            collapsed - bottom,
            mixture - bottom,
        ]
    }
    /// The cutout's calibrated LT indication from the column's tap
    /// pressures at the coordinates, unlagged and unquantized.
    fn lt_indication_m(&self, y: &[f64], c: &Cutout) -> Result<f64, String> {
        let xv: Vec<Scalar> = (0..st::COORDINATES)
            .map(|i| Scalar::new(y[i] * self.scales[i], 0.))
            .collect();
        let x = Coordinates::from_slice(&xv).map_err(|f| text(&f))?;
        let column = self.cell.column(&If97, &x, None).map_err(|f| text(&f))?;
        let taps = self.cell.taps(&If97, &column).map_err(|f| text(&f))?;
        Ok(c.level(taps.level_difference_pa.value))
    }
    pub fn root_values(&self, y: &[f64], roots: &[Root], out: &mut [f64]) -> Result<(), String> {
        let v = |i: usize| y[i] * self.scales[i];
        let mixture = self
            .cell
            .level(s(v(st::ADMITTED_VOLUME)
                + v(st::ADMITTED_BUBBLE_VOLUME)
                + v(st::RESIDENT_VOLUME)
                + v(st::BUBBLE_VOLUME)))
            .value;
        let boundary = self
            .cell
            .level(s(v(st::ADMITTED_VOLUME) + v(st::ADMITTED_BUBBLE_VOLUME)))
            .value;
        let top = self.cell.parameters().top_m;
        for (o, root) in out.iter_mut().zip(roots) {
            *o = match root {
                Root::MixtureEdge(e) => mixture - e,
                Root::BoundaryEdge(e) => boundary - e,
                Root::ZoneMass(i) => v(*i),
                Root::MixtureTop => mixture - top,
                Root::SteelLimit(i) => {
                    let m = self.metal.as_ref().ok_or("steel root without metal")?;
                    v(*i) - m.limit_energy_j[*i - self.metal_base()]
                }
                Root::LowLevel => {
                    let c = self
                        .cutout_watch
                        .ok_or("low-level root without a watched cutout")?;
                    // The predicate is `round(level/q) <= round(setting/q)`,
                    // which first holds below setting + q/2.
                    self.lt_indication_m(y, &c)? - (c.setting_m + 0.5 * c.quantum_m)
                }
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

/// The exact consistent-rate solve on this system's own rows: the rows, and
/// the dense pencil `dF/dy`, `dF/dy'` from seeded columns, one matrix reuse
/// per pencil half.
impl ConsistentSystem for CellSystem {
    fn system_dimension(&self) -> usize {
        self.n()
    }
    fn rows_at(&mut self, t: f64, y: &[f64], yp: &[f64]) -> Result<Vec<f64>, CellFailure> {
        let e = self.evaluate(t, y, yp, None, None)?;
        Ok((0..self.n()).map(|i| e.row(i).value).collect())
    }
    fn pencil_at(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
    ) -> Result<(Vec<f64>, Vec<f64>), CellFailure> {
        let n = self.n();
        let (mut a, mut b) = (vec![0.; n * n], vec![0.; n * n]);
        let (mut ra, mut rb) = (Reuse::new(2, 2), Reuse::new(2, 2));
        for j in 0..n {
            let ea = self.evaluate(t, y, yp, Some((j, 0.)), Some(&mut ra))?;
            let eb = self.evaluate(t, y, yp, Some((j, 1.)), Some(&mut rb))?;
            for i in 0..n {
                a[j * n + i] = ea.row(i).direction;
                b[j * n + i] = eb.row(i).direction - ea.row(i).direction;
            }
        }
        Ok((a, b))
    }
}

/// The system with the root list frozen for one handle.
pub struct Segment {
    pub system: CellSystem,
    pub roots: Vec<Root>,
    /// Start of this handle's segment and its ledger there.
    pub started_s: f64,
    pub started_q: [f64; LEDGER],
    /// The ledger integrand's refusal of a converged step, if any.
    pub ledger_refusal: Option<String>,
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
    fn quadrature_count(&self) -> usize {
        LEDGER
    }
    /// Stock IDAS calls this at each converged step, a state the residual
    /// has not evaluated. A refusal there is fatal and recorded as the
    /// ledger's own: a recoverable one would make IDAS retry the step and
    /// change the trajectory the residual alone would take.
    fn quadrature(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        self.system.counters.quadratures += 1;
        match self.system.ledger_rates(t, y, yp) {
            Ok(q) => {
                out.copy_from_slice(&q);
                Ok(())
            }
            Err(f) => {
                let reason = format!(
                    "ledger integrand refused the converged step at t={t} s ({})",
                    text(&f)
                );
                self.ledger_refusal = Some(reason.clone());
                Err(Failure::Fatal(reason))
            }
        }
    }
}

/// The integrator's ledger at `t`: the handle's start value before its
/// first advance, otherwise stock IDAGetQuad at the last returned time,
/// which must be `t`.
fn ledger_at(ida: &Ida<Segment>, t: f64) -> Result<[f64; LEDGER], String> {
    let segment = ida.system();
    if t == segment.started_s {
        return Ok(segment.started_q);
    }
    let mut q = [0.; LEDGER];
    let returned = ida.quadratures(&mut q)?;
    if returned != t {
        return Err(format!("ledger read at {t} s, but the last return was {returned} s"));
    }
    Ok(q)
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
    /// g, A, R, b, d and b_A, kg.
    pub masses: [f64; 6],
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
    /// The bulk bubble exchange (request 4, K1): `W_x`, the bubble stock
    /// condensed into R, kg/s, and its Weber number for the domain disclosure.
    pub bubble_condensation_kg_s: f64,
    pub bubble_exchange_weber: f64,
    /// Zone A's stock (amendment 6): its condensation `W_xA` into A and the
    /// survivors crossing into b at the A–R boundary, kg/s.
    pub admitted_bubble_condensation_kg_s: f64,
    pub bubble_crossing_kg_s: f64,
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
    /// Saturation drift heat of b (paid by R), d (by g) and b_A (by A), W.
    pub transit_drift_w: [f64; 3],
    /// Instantaneous identities: internal totals minus receipts.
    pub identity: [f64; 3],
    pub inventory: [f64; 3],
    /// The integrator's ledger at this time: the quadratures since t = 0.
    pub ledger_q: [f64; LEDGER],
    /// Inventory energy minus `p_s (V_b + V_d)`: zone and transit internal energy.
    pub internal_energy_j: f64,
    /// Solver tolerance of the mass, energy and boron totals at this state.
    pub tolerance: [f64; 3],
    pub max_abs_scaled_row: f64,
    /// Metal: total steel energy, delivered Joule power, exterior loss and
    /// the fluid's receipts from the metal, W; rod and wall temperatures;
    /// each bank's `f_wet` and exposed length; the metal identity
    /// `Σ steel rates + Σ fluid receipts + exterior − Joule` (the enclosure
    /// sums to zero), W.
    pub metal_energy_j: f64,
    pub rod_energy_j: f64,
    pub joule_w: f64,
    pub exterior_w: f64,
    pub metal_fluid_w: f64,
    pub rod_temperature_k: Vec<f64>,
    pub wall_temperature_k: Vec<f64>,
    pub bank_wet_fraction: Vec<f64>,
    pub bank_exposed_m: Vec<f64>,
    pub metal_identity_w: f64,
    /// Acquired LT: lagged DP, indicated and quantized level, and whether
    /// the common isolator has opened.
    pub lt_dp_acquired_pa: Option<f64>,
    pub lt_indication_m: Option<f64>,
    pub isolated: bool,
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
        x.admitted_bubble_mass.value,
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
    let mut metal_fields = (
        0.,
        0.,
        0.,
        0.,
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        0.,
    );
    let mut rod_energy = 0.;
    let mut metal_tolerance = 0.;
    if let (Some(m), Some(r)) = (&system.metal, &e.metal) {
        rod_energy = e.metal_energy_j[..m.rods()].iter().sum();
        let base = system.metal_base();
        metal_tolerance = (base..base + m.count())
            .map(|i| rtol * (y[i] * sc[i]).abs() + atol[i] * sc[i])
            .sum();
        let joule: f64 = e.bank_powers_w.iter().sum();
        let exterior: f64 = r.walls.iter().map(|w| w.exterior_w.value).sum();
        let fluid: f64 = r.rods.iter().map(|g| g.fluid_energy_w.value).sum::<f64>()
            + r.walls.iter().map(|w| w.fluid_energy_w.value).sum::<f64>();
        let rates: f64 = r
            .rod_metal_rates()
            .iter()
            .chain(&r.wall_metal_rates())
            .map(|q| q.value)
            .sum();
        let banks = m.heaters.banks();
        let mut wet = vec![0.; banks.len()];
        let mut exposed = vec![0.; banks.len()];
        for (g, seg) in m.heaters.segments().iter().zip(&r.rods) {
            wet[g.bank] += seg.wetting.wet_length_m.value;
            exposed[g.bank] += seg.wetting.exposed_length_m.value;
        }
        for (b, bank) in banks.iter().enumerate() {
            wet[b] /= bank.top_m - bank.bottom_m;
        }
        metal_fields = (
            e.metal_energy_j.iter().sum(),
            joule,
            exterior,
            fluid,
            r.rods.iter().map(|g| g.temperature.value).collect(),
            r.walls.iter().map(|w| w.temperature.value).collect(),
            wet,
            exposed,
            rates + fluid + exterior - joule,
        );
    }
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
        bubble_condensation_kg_s: f.bubble_exchange.condensation.value,
        bubble_exchange_weber: f.bubble_exchange.weber.value,
        admitted_bubble_condensation_kg_s: f.admitted_bubble_exchange.condensation.value,
        bubble_crossing_kg_s: f.bubble_crossing.value,
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
        transit_drift_w: [
            f.transit_drift[0].value,
            f.transit_drift[1].value,
            f.admitted_transit_drift.value,
        ],
        identity: [
            b.mass_kg_s.value - b.receipt_mass_kg_s.value,
            b.energy_w.value - b.receipt_energy_w.value,
            b.boron_kg_s.value - b.receipt_boron_kg_s.value,
        ],
        inventory: [inv.mass_kg.value, inv.energy_j.value, inv.boron_kg.value],
        ledger_q: [0.; LEDGER],
        internal_energy_j: inv.energy_j.value
            - c.interface_pressure.value
                * (x.bubble_volume.value + x.drop_volume.value + x.admitted_bubble_volume.value),
        tolerance: [
            tol(&[
                st::VAPOR_MASS,
                st::ADMITTED_MASS,
                st::RESIDENT_MASS,
                st::BUBBLE_MASS,
                st::DROP_MASS,
                st::ADMITTED_BUBBLE_MASS,
            ]),
            tol(&[st::VAPOR_ENERGY, st::ADMITTED_ENERGY, st::RESIDENT_ENERGY]) + metal_tolerance,
            tol(&[st::ADMITTED_BORON, st::RESIDENT_BORON, st::DROP_BORON]),
        ],
        max_abs_scaled_row: max_row,
        metal_energy_j: metal_fields.0,
        rod_energy_j: rod_energy,
        joule_w: metal_fields.1,
        exterior_w: metal_fields.2,
        metal_fluid_w: metal_fields.3,
        rod_temperature_k: metal_fields.4,
        wall_temperature_k: metal_fields.5,
        bank_wet_fraction: metal_fields.6,
        bank_exposed_m: metal_fields.7,
        metal_identity_w: metal_fields.8,
        isolated: system.metal.as_ref().is_some_and(|m| m.isolated),
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
    /// The contract comparison's observation interval (`ld01-s1-gates`
    /// `comparison.observation_s`); every `output_s / observation_s`-th
    /// observation is a full sample.
    pub observation_s: f64,
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
    /// Bound and passes of every consistent pair (the S1 lead ruling).
    pub consistent_bound: f64,
    pub consistent_passes: usize,
    /// Largest lift defect a travel root may hand `ReliefDevice::stop`.
    pub lift_root_bound: f64,
    /// Stock IDA's first step after every event restart (request 4, K4).
    pub event_restart_first_step_s: f64,
    /// The low-level heater cutout chain (gate 5).
    pub cutout: Option<Cutout>,
}

/// The low-level heater cutout of gate 5: the electronic differential level
/// sampled at the output interval (its lag integrated exactly between
/// samples for a linear input), quantized, its predicate held for the
/// persistence, then the common isolator's contact delay. Three identical
/// healthy channels vote as one.
#[derive(Clone, Copy, Debug)]
pub struct Cutout {
    pub setting_m: f64,
    pub persistence_s: f64,
    pub contact_delay_s: f64,
    pub lag_s: f64,
    pub quantum_m: f64,
    /// Fixed calibration densities, gravity and tap span.
    pub liquid_reference_kg_m3: f64,
    pub vapor_reference_kg_m3: f64,
    pub gravity_m_s2: f64,
    pub span_m: f64,
}
impl Cutout {
    /// Indicated level from the acquired DP, before quantization.
    pub fn level(&self, dp: f64) -> f64 {
        (dp - self.vapor_reference_kg_m3 * self.gravity_m_s2 * self.span_m)
            / ((self.liquid_reference_kg_m3 - self.vapor_reference_kg_m3) * self.gravity_m_s2)
    }
    /// The quantized indication in counts of `quantum_m`.
    pub fn counts(&self, level: f64) -> i64 {
        (level / self.quantum_m).round() as i64
    }
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
    /// The ledger's integrand refused a converged step the residual never
    /// evaluated (request 4, K2). The run stops there rather than letting
    /// stock IDAS retry, which would change the trajectory; this is not a
    /// physics stop.
    LedgerFailure {
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
    /// The cutout chain's record follows the handle counters.
    /// Every integrator handle's own stock counters, in order.
    pub handle_stats: Vec<Value>,
    /// Smoke diagnostic only: each accepted step's end inside the probed
    /// window, `[t_n, h, order, steps, inventory_kg, mass_receipt_kg_s, handle]`.
    pub step_probe: Vec<Value>,
    pub cutout: Option<Value>,
    /// `[t, PT1, collapsed level, mixture level]` every `observation_s`,
    /// from the coordinates alone (no property call).
    pub observations: Vec<[f64; 4]>,
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

/// What a new handle starts with besides its state: its stop boundary, the
/// first step of an event restart (K4) and the ledger carried so far (K2).
struct HandleStart {
    stop: f64,
    first_step: Option<f64>,
    ledger: [f64; LEDGER],
}

fn new_handle(
    system: CellSystem,
    t: f64,
    y: &[f64],
    yp: &[f64],
    spec: &RunSpec,
    start: HandleStart,
) -> Result<Ida<Segment>, String> {
    let HandleStart {
        stop,
        first_step,
        ledger: q0,
    } = start;
    let ids = system.differential();
    let roots = system.roots_active();
    let mut ida = Ida::new(
        Segment {
            system,
            roots,
            started_s: t,
            started_q: q0,
            ledger_refusal: None,
        },
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
    if let Some(h) = first_step {
        ida.set_init_step(h)?;
    }
    ida.initialize_quadratures(&q0)?;
    ida.stop_at(stop)?;
    Ok(ida)
}

/// The exact consistent pair at a segment start, t = 0 or an event: the
/// algebraic coordinates projected onto the constraints within the run's
/// own error weights, then the exact rates. Never IDACalcIC.
fn start(
    system: &mut CellSystem,
    t: f64,
    y: &mut [f64],
    spec: &RunSpec,
) -> Result<(Vec<f64>, Value), String> {
    let ids = system.differential();
    let weights: Vec<f64> = y
        .iter()
        .zip(&spec.atol)
        .map(|(v, a)| 1. / (spec.rtol * v.abs() + a))
        .collect();
    let (yp, pair) = consistent_start(
        system,
        t,
        y,
        &ids,
        &weights,
        spec.consistent_bound,
        spec.consistent_passes,
    )
    .map_err(|e| format!("consistent pair at t={t} s: {}", text(&e)))?;
    Ok((yp, json!({"t":t,"pair":pair})))
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

/// A discrete change at a known time.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Pending {
    IsolatorOpen,
}
impl Pending {
    fn label(&self) -> &'static str {
        match self {
            Pending::IsolatorOpen => "heater isolator opened",
        }
    }
}

/// The cutout's acquisition chain.
#[derive(Clone, Copy, Debug, Default)]
struct Acquired {
    /// Last regular sample: time, input DP and acquired DP.
    previous: Option<(f64, f64, f64)>,
    since: Option<f64>,
    cause: Option<f64>,
}

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
        absorb(out, &mut totals, ida);
    }
    out.totals = totals;
    out.reached_s = t;
    out.y = y.to_vec();
    out.yp = yp.to_vec();
}
/// Add a handle's counters to the run before it is replaced.
fn absorb(out: &mut Run, totals: &mut Totals, ida: &Ida<Segment>) {
    if let Ok(s) = ida.stats() {
        totals.add(&s);
        out.handle_stats.push(json!({"from_s":ida.system().started_s,"steps":s.steps,"jacobians":s.jacobians,"residuals":s.residuals,
            "error_test_failures":s.error_failures,"convergence_failures":s.convergence_failures,"nonlinear_iterations":s.nonlinear_iterations,"last_step_s":s.last_step,"last_order":s.last_order}));
    }
    let c = &ida.system().system.counters;
    out.counters.residuals += c.residuals;
    out.counters.jacobians += c.jacobians;
    out.counters.residual_wall_s += c.residual_wall_s;
    out.counters.jacobian_wall_s += c.jacobian_wall_s;
    out.counters.root_calls += c.root_calls;
    out.counters.quadratures += c.quadratures;
}

/// Integrate one declared run from the prepared state `y0` at rest.
pub fn run(mut system: CellSystem, y0: &[f64], spec: &RunSpec) -> Run {
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
        handle_stats: Vec::new(),
        step_probe: Vec::new(),
        cutout: None,
        observations: Vec::new(),
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
    let next_stop = |pending: &[(f64, Pending)], t: f64| -> f64 {
        let fixed = breaks.iter().copied().find(|b| *b > t).unwrap();
        pending
            .iter()
            .map(|p| p.0)
            .filter(|p| *p > t)
            .fold(fixed, f64::min)
    };
    let mut pending: Vec<(f64, Pending)> = Vec::new();
    let mut acquired = Acquired::default();
    let mut diagnostic = 0.;
    let mut totals = Totals::default();
    // Gate 5's cutout: its switching level is watched by root from t = 0.
    system.cutout_watch = spec.cutout;
    match start(&mut system, t, &mut y, spec) {
        Ok((rates, pair)) => {
            yp = rates;
            out.initializations.push(pair);
        }
        Err(e) => {
            finish(
                &mut out,
                End::Failure {
                    reason: format!("initial consistent pair: {e}"),
                },
                None,
                &totals,
                t,
                &y,
                &yp,
            );
            return out;
        }
    }
    let mut ida = match new_handle(
        system,
        t,
        &y,
        &yp,
        spec,
        HandleStart {
            stop: next_stop(&pending, t),
            first_step: None,
            ledger: [0.; LEDGER],
        },
    ) {
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
        smp.ledger_q = ledger_at(ida, t)?;
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
    let mut last_accepted = f64::NEG_INFINITY;
    let check_accepted = |out: &mut Run,
                          ida: &Ida<Segment>,
                          diagnostic: &mut f64,
                          last_accepted: &mut f64|
     -> Option<(u8, String)> {
        let d = cpu_s();
        let mut ya = vec![0.; n];
        let mut ypa = vec![0.; n];
        let result = match ida.current_state(&mut ya, &mut ypa) {
            Ok(ta) if ta > *last_accepted => {
                *last_accepted = ta;
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
    // The cutout's acquisition on one regular sample; schedules the isolator.
    let acquire = |out: &mut Run,
                   acquired: &mut Acquired,
                   pending: &mut Vec<(f64, Pending)>,
                   t: f64|
     -> Option<f64> {
        let c = spec.cutout?;
        let last = out.samples.last_mut()?;
        let u = last.lt_dp_pa;
        let dp = match acquired.previous {
            None => u,
            Some((t0, u0, a0)) => {
                let d = t - t0;
                let slope = (u - u0) / d;
                let decay = (-d / c.lag_s).exp();
                u + ((a0 - u0) + slope * c.lag_s) * decay - slope * c.lag_s
            }
        };
        acquired.previous = Some((t, u, dp));
        let counts = c.counts(c.level(dp));
        last.lt_dp_acquired_pa = Some(dp);
        last.lt_indication_m = Some(counts as f64 * c.quantum_m);
        if acquired.cause.is_some() {
            return None;
        }
        if counts <= c.counts(c.setting_m) {
            let since = *acquired.since.get_or_insert(t);
            if t - since >= c.persistence_s - 1e-9 {
                acquired.cause = Some(t);
                let open = t + c.contact_delay_s;
                pending.push((open, Pending::IsolatorOpen));
                out.cutout = Some(
                    json!({"predicate_since_s":since,"cause_s":t,"isolator_open_s":open,"indication_m":counts as f64 * c.quantum_m,
                    "settings":{"setting_m":c.setting_m,"persistence_s":c.persistence_s,"contact_delay_s":c.contact_delay_s,"lag_s":c.lag_s,"quantum_m":c.quantum_m,
                        "liquid_reference_kg_m3":c.liquid_reference_kg_m3,"vapor_reference_kg_m3":c.vapor_reference_kg_m3,"gravity_m_s2":c.gravity_m_s2,"span_m":c.span_m}}),
                );
                return Some(open);
            }
        } else {
            acquired.since = None;
        }
        None
    };
    out.observations.push(ida.system().system.observe(t, &y));
    let ratio = (spec.output_s / spec.observation_s).round() as u64;
    // Once the low-level root has armed the cutout and until it causes the
    // isolator, the run stops at every regular sample, where the declared
    // acquisition is evaluated: the isolator's stop, 0.05 s after a sample,
    // is then never behind the integrator.
    let mut watching = false;
    let mut armed_at: Option<f64> = None;
    let stop_after = |pending: &[(f64, Pending)], t: f64, watching: bool| -> f64 {
        let stop = next_stop(pending, t);
        if watching {
            let index = ((t / spec.observation_s + 1e-6).floor() as u64 / ratio + 1) * ratio;
            stop.min(index as f64 * spec.observation_s)
        } else {
            stop
        }
    };
    assert!(
        ratio >= 1 && (ratio as f64 * spec.observation_s - spec.output_s).abs() <= 1e-12,
        "the output interval must be a whole number of observations"
    );
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
            acquire(&mut out, &mut acquired, &mut pending, t);
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
    // `k` counts observations; every `ratio`-th is a full sample.
    let mut k: u64 = 1;
    // Handles whose first advance has been taken.
    let mut primed = 0;
    // Smoke diagnostic: the accepted steps' ends inside `LD01_P2_STEP_PROBE`
    // ("from_s,to_s"), read after every advance. It only reads the
    // integrator's current state.
    let probe: Option<(f64, f64)> = std::env::var("LD01_P2_STEP_PROBE").ok().map(|w| {
        let v: Vec<f64> = w.split(',').map(|x| x.parse().expect("probe window")).collect();
        (v[0], v[1])
    });
    let mut probed = f64::NEG_INFINITY;
    loop {
        let next_output = k as f64 * spec.observation_s;
        let stop = stop_after(&pending, t, watching);
        let target = next_output.min(stop).min(spec.duration_s);
        // Stock IDA's first step is 0.001 of the distance to its first
        // target. A handle's first target is therefore the next regular
        // output (or stop), with the observation as the stop boundary, so the
        // comparison's 2 ms observation grid does not set the first step.
        let horizon = ((k.div_ceil(ratio) * ratio) as f64 * spec.observation_s)
            .min(stop)
            .min(spec.duration_s);
        let advanced = if primed < out.handles && horizon > target {
            primed = out.handles;
            let first = ida
                .stop_at(target)
                .and_then(|()| ida.advance(horizon, &mut y, &mut yp));
            match first {
                Ok(a) => {
                    let now = match a {
                        Advance::Reached(tr) => tr,
                        Advance::Root { time, .. } => time,
                    };
                    if stop > now {
                        ida.stop_at(stop).map(|()| a)
                    } else {
                        Ok(a)
                    }
                }
                Err(e) => Err(e),
            }
        } else {
            primed = out.handles;
            ida.advance(target, &mut y, &mut yp)
        };
        if let Some((from, to)) = probe
            && let Ok(st) = ida.stats()
        {
            let mut ya = vec![0.; n];
            let mut ypa = vec![0.; n];
            if let Ok(tn) = ida.current_state(&mut ya, &mut ypa)
                && tn >= from
                && tn <= to
                && tn != probed
                && let Ok(smp) = sample(&ida.system().system, tn, &ya, &ypa, &spec.atol, spec.rtol)
            {
                probed = tn;
                out.step_probe.push(json!([tn, st.last_step, st.last_order, st.steps, smp.inventory[0], smp.receipt[0], out.handles]));
            }
        }
        // A pure observation: record it and continue without a sample.
        if let Ok(Advance::Reached(tr)) = advanced
            && (tr - next_output).abs() <= 1e-9 * next_output.max(1.)
            && !k.is_multiple_of(ratio)
            && tr < stop
            && tr < spec.duration_s
        {
            t = tr;
            out.observations.push(ida.system().system.observe(t, &y));
            k += 1;
            continue;
        }
        let end = match advanced {
            Ok(Advance::Reached(tr)) => {
                t = tr;
                let on_grid = (t - next_output).abs() <= 1e-9 * next_output.max(1.);
                if on_grid {
                    out.observations.push(ida.system().system.observe(t, &y));
                }
                let regular = on_grid && k.is_multiple_of(ratio);
                let due: Vec<Pending> = pending
                    .iter()
                    .filter(|p| (p.0 - t).abs() <= 1e-12 * t.max(1.))
                    .map(|p| p.1)
                    .collect();
                pending.retain(|p| (p.0 - t).abs() > 1e-12 * t.max(1.));
                let label = (!due.is_empty())
                    .then(|| due.iter().map(|d| d.label()).collect::<Vec<_>>().join("; "));
                let mut end = None;
                match record(&mut out, &ida, &totals, t, &y, &yp, label, &mut diagnostic) {
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
                    && let Some((rule, reason)) =
                        check_accepted(&mut out, &ida, &mut diagnostic, &mut last_accepted)
                {
                    end = Some(stop_rule_end(spec, rule, reason));
                }
                if end.is_none() && on_grid {
                    k += 1;
                }
                if end.is_none()
                    && regular
                    && let Some(open) = acquire(&mut out, &mut acquired, &mut pending, t)
                {
                    watching = false;
                    if let Some(c) = out.cutout.as_mut() {
                        c["armed_by_root_s"] = json!(armed_at);
                    }
                    if let Err(e) = ida.stop_at(stop_after(&pending, t, watching)) {
                        end = Some(End::Failure {
                            reason: format!("isolator stop at {open} s: {e}"),
                        });
                    }
                }
                if end.is_none() {
                    if t >= spec.duration_s {
                        end = Some(if spec.limit {
                            End::Limit {
                                label: "maxDuration_s reached".into(),
                            }
                        } else {
                            End::Completed
                        });
                    } else if !due.is_empty() {
                        let mut next = ida.system().system.clone();
                        for d in &due {
                            match d {
                                Pending::IsolatorOpen => {
                                    if let Some(m) = next.metal.as_mut() {
                                        m.isolated = true;
                                    }
                                }
                            }
                        }
                        let ledger = ledger_at(&ida, t);
                        absorb(&mut out, &mut totals, &ida);
                        next.counters = Counters::default();
                        match ledger.and_then(|q| start(&mut next, t, &mut y, spec).map(|r| (r, q))) {
                            Ok(((rates, pair), q)) => {
                                yp = rates;
                                out.initializations.push(pair);
                                match new_handle(
                                    next,
                                    t,
                                    &y,
                                    &yp,
                                    spec,
                                    HandleStart {
                                        stop: stop_after(&pending, t, watching),
                                        first_step: Some(spec.event_restart_first_step_s),
                                        ledger: q,
                                    },
                                ) {
                                    Ok(h) => {
                                        ida = h;
                                        out.handles += 1;
                                    }
                                    Err(e) => {
                                        end = Some(End::Failure {
                                            reason: format!("handle at t={t} s: {e}"),
                                        })
                                    }
                                }
                            }
                            Err(e) => {
                                end = Some(End::Failure {
                                    reason: format!("start at t={t} s: {e}"),
                                })
                            }
                        }
                    } else if t >= stop
                        && let Err(e) = ida.stop_at(stop_after(&pending, t, watching))
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
                let demand = fired
                    .iter()
                    .find(|(r, _)| *r == Root::Demand)
                    .map(|(_, d)| *d);
                let travel = fired.iter().any(|(r, _)| *r == Root::Travel);
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
                        Root::SteelLimit(_) => {
                            out.structural.push(json!({"t":t,"root":root.label(),"direction":d,"sample":smp.as_ref().map(sample_json)}));
                            end = Some(End::Limit {
                                label: format!(
                                    "steel-range applicability limit: {} at t={t} s",
                                    root.label()
                                ),
                            });
                        }
                        Root::Demand | Root::Travel | Root::LowLevel => {}
                    }
                }
                if end.is_none() && (demand.is_some() || travel) {
                    let mut next = ida.system().system.clone();
                    let scale = next.scales[LIFT];
                    let located = y[LIFT] * scale;
                    let (before, after, rate, stop) = {
                        let relief = next
                            .relief
                            .as_mut()
                            .expect("relief roots imply an armed outlet");
                        let before = (relief.demand_open, relief.motion);
                        let mut stop = None;
                        if travel {
                            let mut lift = located;
                            match relief
                                .device
                                .stop(relief.motion, &mut lift, spec.lift_root_bound)
                            {
                                Ok(report) => {
                                    relief.motion = report.motion_after;
                                    y[LIFT] = lift / scale;
                                    stop = Some(report);
                                }
                                Err(e) => {
                                    end = Some(End::Failure {
                                        reason: format!("mechanical stop at t={t} s: {}", text(&e)),
                                    })
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
                        (before, after, relief.device.lift_rate(relief.motion), stop)
                    };
                    let mut event = json!({"t":t,"pt1_pa":y[st::ROOF_PRESSURE]*next.scales[st::ROOF_PRESSURE],
                        "demand_root":demand,"travel_root":travel,
                        "before":{"demand_open":before.0,"motion":format!("{:?}",before.1)},
                        "after":{"demand_open":after.0,"motion":format!("{:?}",after.1)},
                        "lift_located":located,
                        "stop":stop.map(|r| json!({"motion_before":format!("{:?}",r.motion_before),"motion_after":format!("{:?}",r.motion_after),
                            "lift_before":r.lift_before,"lift_after":r.lift_after,"defect":r.defect})),
                        "lift_rate_per_s":rate});
                    if end.is_none() {
                        let ledger = ledger_at(&ida, t);
                        absorb(&mut out, &mut totals, &ida);
                        next.counters = Counters::default();
                        match ledger.and_then(|q| start(&mut next, t, &mut y, spec).map(|r| (r, q))) {
                            Ok(((rates, pair), q)) => {
                                yp = rates;
                                event["consistent_pair"] = pair["pair"].clone();
                                out.initializations.push(pair);
                                match new_handle(
                                    next,
                                    t,
                                    &y,
                                    &yp,
                                    spec,
                                    HandleStart {
                                        stop: stop_after(&pending, t, watching),
                                        first_step: Some(spec.event_restart_first_step_s),
                                        ledger: q,
                                    },
                                ) {
                                    Ok(h) => {
                                        ida = h;
                                        out.handles += 1;
                                    }
                                    Err(e) => {
                                        end = Some(End::Failure {
                                            reason: format!("relief event handle at t={t} s: {e}"),
                                        })
                                    }
                                }
                            }
                            Err(e) => {
                                end = Some(End::Failure {
                                    reason: format!("relief event start: {e}"),
                                })
                            }
                        }
                    }
                    out.relief_events.push(event);
                }
                // The cutout's switching level crossed downward: restart here
                // without the root and stop at every sample from now on.
                if end.is_none() && fired.iter().any(|(r, d)| *r == Root::LowLevel && *d < 0) {
                    let mut next = ida.system().system.clone();
                    next.cutout_watch = None;
                    watching = acquired.cause.is_none();
                    armed_at = Some(t);
                    let ledger = ledger_at(&ida, t);
                    absorb(&mut out, &mut totals, &ida);
                    next.counters = Counters::default();
                    match ledger.and_then(|q| start(&mut next, t, &mut y, spec).map(|r| (r, q))) {
                        Ok(((rates, pair), q)) => {
                            yp = rates;
                            out.initializations.push(pair);
                            match new_handle(
                                next,
                                t,
                                &y,
                                &yp,
                                spec,
                                HandleStart {
                                    stop: stop_after(&pending, t, watching),
                                    first_step: Some(spec.event_restart_first_step_s),
                                    ledger: q,
                                },
                            ) {
                                Ok(h) => {
                                    ida = h;
                                    out.handles += 1;
                                }
                                Err(e) => {
                                    end = Some(End::Failure {
                                        reason: format!("cutout arming handle at t={t} s: {e}"),
                                    })
                                }
                            }
                        }
                        Err(e) => {
                            end = Some(End::Failure {
                                reason: format!("cutout arming start at t={t} s: {e}"),
                            })
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
                Some(if let Some(refusal) = &ida.system().ledger_refusal {
                    End::LedgerFailure {
                        reason: format!("{refusal}; {reason}"),
                    }
                } else if spec.limit {
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
    let mut j = json!({"t":s.t,"event":s.event,"pt1_pa":s.pt1_pa,"p_s_pa":s.interface_pa,"p_bottom_pa":s.bottom_pa,"lt_dp_pa":s.lt_dp_pa,
        "mixture_level_m":s.mixture_level_m,"collapsed_level_m":s.collapsed_level_m,"z_ar_m":s.boundary_elevation_m,"delta_a_m":s.admitted_thickness_m,"phi":s.withdrawal_fraction,
        "mass_kg":{"g":s.masses[0],"A":s.masses[1],"R":s.masses[2],"b":s.masses[3],"d":s.masses[4],"bA":s.masses[5]},"drop_boron_kg":s.drop_boron_kg,
        "temperature_k":{"g":s.temperatures_k[0],"A":s.temperatures_k[1],"R":s.temperatures_k[2]},
        "departure_k":{"g":s.departure_k[0],"A":s.departure_k[1],"R":s.departure_k[2]},
        "drop_velocity_m_s":s.drop_velocity_m_s,"bubble_velocity_m_s":s.bubble_velocity_m_s,"gap_margin":s.gap_margin,
        "rain_kg_s":s.rain_kg_s,"bubble_rise_kg_s":s.rise_kg_s,"spray_condensation_kg_s":s.spray_condensation_kg_s,
        "flashing_kg_s":{"A":s.flashing_kg_s[0],"R":s.flashing_kg_s[1]},"vapor_condensation_kg_s":s.vapor_condensation_kg_s,
        "interface_evaporation_kg_s":s.interface_evaporation_kg_s,"inversion_kg_s":s.inversion_kg_s,"conduction_w":s.conduction_w,
        "surge_kg_s":s.surge_kg_s,"spray_kg_s":s.spray_kg_s,
        "relief":{"lift":s.lift,"demand_open":s.demand_open,"motion":s.motion,"vapor_kg_s":s.relief_vapor_kg_s,"drop_kg_s":s.relief_drop_kg_s,"boron_kg_s":s.relief_boron_kg_s},
        "metal":{"energy_j":s.metal_energy_j,"joule_w":s.joule_w,"exterior_w":s.exterior_w,"fluid_receipts_w":s.metal_fluid_w,"identity_w":s.metal_identity_w,
            "rod_temperature_k":s.rod_temperature_k,"wall_temperature_k":s.wall_temperature_k,"bank_wet_fraction":s.bank_wet_fraction,"bank_exposed_m":s.bank_exposed_m,"isolated":s.isolated},
        "lt":{"dp_acquired_pa":s.lt_dp_acquired_pa,"indication_m":s.lt_indication_m},
        "steps":s.steps,"last_step_s":s.last_step_s,"order":s.order,"error_test_failures":s.error_failures,"convergence_failures":s.convergence_failures});
    j["bubble_exchange"] = json!({"condensation_kg_s":s.bubble_condensation_kg_s,"weber":s.bubble_exchange_weber,
        "admitted_condensation_kg_s":s.admitted_bubble_condensation_kg_s,"crossing_kg_s":s.bubble_crossing_kg_s});
    j
}

/// Conservation ledgers over the samples (request 4, K2). The gated one is
/// the integrator's: inventory change against the stock IDAS quadratures of
/// the residual's own boundary terms, which follow the accepted steps, so it
/// drifts only by Newton residual and roundoff. The trapezoid of the sampled
/// receipts over outputs, events and breakpoints is reported beside it, with
/// its difference from the quadratures. Energy is fluid internal energy
/// (zones plus transit at u_sat) plus steel energy, against port receipts
/// plus electrical delivery minus exterior loss minus the hydrostatic
/// remainder; the transit drifts are reported.
pub fn ledger(run: &Run, surge: Option<&Table>, spray: Option<&Table>, bound: f64) -> Value {
    let samples = &run.samples;
    let Some(first) = samples.first() else {
        return json!(null);
    };
    // Quadrature totals since the first sample: mass, energy, boron.
    let quad = |x: &Sample| {
        let d: Vec<f64> = (0..LEDGER).map(|i| x.ledger_q[i] - first.ledger_q[i]).collect();
        [d[0], d[1] + d[3] - d[4] - d[5], d[2]]
    };
    let held = |x: &Sample| {
        [
            x.inventory[0] - first.inventory[0],
            (x.internal_energy_j + x.metal_energy_j) - (first.internal_energy_j + first.metal_energy_j),
            x.inventory[2] - first.inventory[2],
        ]
    };
    let mut integral = [0.; 3];
    let mut work = 0.;
    let mut joule = 0.;
    let mut exterior = 0.;
    let mut drift = [0.; 3];
    let mut relief = [0.; 3];
    let mut worst = [[0.; 3]; 2];
    let mut worst_ratio = [[0.; 3]; 2];
    let mut identity = [0_f64; 3];
    let mut previous = first;
    for s in samples.iter().skip(1) {
        let dt = s.t - previous.t;
        if dt < 0. {
            continue;
        }
        // Ports only: the cell's receipts less what the metal hands the fluid.
        let port = |x: &Sample| [x.receipt[0], x.receipt[1] - x.metal_fluid_w, x.receipt[2]];
        let (a, b) = (port(s), port(previous));
        for i in 0..3 {
            integral[i] += 0.5 * dt * (a[i] + b[i]);
        }
        work += 0.5 * dt * (s.volume_work_w + previous.volume_work_w);
        joule += 0.5 * dt * (s.joule_w + previous.joule_w);
        exterior += 0.5 * dt * (s.exterior_w + previous.exterior_w);
        for i in 0..3 {
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
        let h = held(s);
        let q = quad(s);
        let trapezoid = [integral[0], integral[1] + joule - exterior - work, integral[2]];
        for i in 0..3 {
            for (k, receipts) in [q, trapezoid].iter().enumerate() {
                let closure = (h[i] - receipts[i]).abs();
                worst[k][i] = f64::max(worst[k][i], closure);
                worst_ratio[k][i] = f64::max(worst_ratio[k][i], closure / s.tolerance[i]);
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
    let h = held(last);
    let q = quad(last);
    let lq: Vec<f64> = (0..LEDGER).map(|i| last.ledger_q[i] - first.ledger_q[i]).collect();
    let trapezoid = [integral[0], integral[1] + joule - exterior - work, integral[2]];
    json!({"t_s":t,"bound_solver_tolerances":bound,"method":"gated: inventory change minus the stock IDAS quadratures of the residual's boundary terms (request 4, K2); reported: minus the trapezoid of the sampled receipts over outputs, root events and breakpoints. Energy as fluid internal energy (zones plus transit at u_sat) plus steel energy, against port receipts plus electrical delivery minus exterior loss minus the hydrostatic remainder",
        "mass":{"inventory_change_kg":h[0],"receipts_kg":q[0],"closure_kg":h[0]-q[0],"max_abs_closure_kg":worst[0][0],"max_closure_over_solver_tolerance":worst_ratio[0][0],"solver_tolerance_kg":last.tolerance[0],"within_solver_tolerance":worst_ratio[0][0] <= bound,"max_instantaneous_identity_kg_s":identity[0]},
        "energy":{"internal_energy_change_j":last.internal_energy_j-first.internal_energy_j,"metal_energy_change_j":last.metal_energy_j-first.metal_energy_j,
            "rod_energy_change_j":last.rod_energy_j-first.rod_energy_j,"wall_energy_change_j":(last.metal_energy_j-last.rod_energy_j)-(first.metal_energy_j-first.rod_energy_j),
            "electrical_j":lq[3],"exterior_loss_j":lq[4],"port_receipts_j":lq[1],"hydrostatic_remainder_j":lq[5],"transit_drift_j":{"bubbles_paid_by_R":lq[6],"drops_paid_by_g":lq[7],"admitted_bubbles_paid_by_A":lq[8]},
            "closure_j":h[1]-q[1],"max_abs_closure_j":worst[0][1],"max_closure_over_solver_tolerance":worst_ratio[0][1],"within_solver_tolerance":worst_ratio[0][1] <= bound,"solver_tolerance_j":last.tolerance[1],"max_instantaneous_identity_w":identity[1]},
        "boron":{"inventory_change_kg":h[2],"receipts_kg":q[2],"closure_kg":h[2]-q[2],"max_abs_closure_kg":worst[0][2],"max_closure_over_solver_tolerance":worst_ratio[0][2],"solver_tolerance_kg":last.tolerance[2],"within_solver_tolerance":worst_ratio[0][2] <= bound,"max_instantaneous_identity_kg_s":identity[2]},
        "trapezoid":{
            "mass":{"receipts_kg":trapezoid[0],"closure_kg":h[0]-trapezoid[0],"max_abs_closure_kg":worst[1][0],"max_closure_over_solver_tolerance":worst_ratio[1][0],"minus_quadrature_kg":trapezoid[0]-q[0]},
            "energy":{"electrical_j":joule,"exterior_loss_j":exterior,"port_receipts_j":integral[1],"hydrostatic_remainder_j":work,"transit_drift_j":{"bubbles_paid_by_R":drift[0],"drops_paid_by_g":drift[1],"admitted_bubbles_paid_by_A":drift[2]},
                "closure_j":h[1]-trapezoid[1],"max_abs_closure_j":worst[1][1],"max_closure_over_solver_tolerance":worst_ratio[1][1],"minus_quadrature_j":trapezoid[1]-q[1]},
            "boron":{"receipts_kg":trapezoid[2],"closure_kg":h[2]-trapezoid[2],"max_abs_closure_kg":worst[1][2],"max_closure_over_solver_tolerance":worst_ratio[1][2],"minus_quadrature_kg":trapezoid[2]-q[2]}},
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
        End::LedgerFailure { reason } => json!({"kind":"ledger failure","reason":reason}),
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
        "harness_counters":{"residual_calls":run.counters.residuals,"jacobian_calls":run.counters.jacobians,"residual_wall_s":run.counters.residual_wall_s,"jacobian_wall_s":run.counters.jacobian_wall_s,"root_calls":run.counters.root_calls,"quadrature_calls":run.counters.quadratures},
        "consistent_pairs":run.initializations,"max_abs_scaled_row_at_samples":max_row,
        "metastable_peaks":Value::Object(peaks),"accepted_step_checks":run.accepted_checks,
        "min_drag_gap_margin":min_gap,"min_admitted_mass_kg":{"value":min_a.0,"at_s":min_a.1},
        "relief_events":run.relief_events,"area_step_crossings":run.area_crossings,"structural_events":run.structural,
        "credited_departure_overruns":run.uncredited,"resolvability_reports":run.resolvability,
        "handle_stats":run.handle_stats,"step_probe":run.step_probe,"cutout":run.cutout,"observations":run.observations.len(),
        "samples":run.samples.len(),"series":series})
}
