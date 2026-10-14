//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hydraulics.md#local-pressure-and-phase-path-impulse
//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#s1-declaration-hydraulics-admission
//! Team DONOR's diagnostic probes of the face donor at near-stagnant faces
//! (decision 0015, E2b), on the actual S1 run-5 packet. NOT S1 evidence and
//! no gate: the S1 harness and its declared gates are untouched.
//!
//! Every probe repeats the S1 harness's declared preparation, RCP start and
//! settling, and its event starts, by the same calls in the same order. Stock
//! IDA is then advanced one internal step per call after each segment's first
//! call (which targets the harness's first output, so the initial step is
//! the harness's): stock's step selection does not read the requested time,
//! so the history is the harness's while every accepted step's state, order,
//! step, counters and local-error estimate are recorded. Credited outputs are
//! observed every 0.002 s by one root function, as the harness observes them.
//! The residual and Jacobian callbacks record each Newton attempt (its trial
//! time, iterations, predictor and last iterate) and the face donor signs
//! the latest Jacobian was formed with; nothing here changes a step.
//!
//! The probes: the post-window continuation's cost against R0, a restarted R0
//! and the cap lifted in one history; the 4-5 ms cap cycle; its scaling with
//! the Newton coefficient; stock IDASetDeltaCjLSetup against the decided 0.01
//! coefficient; and the quiet and natural-step cost of both. The comparison of
//! candidate donor laws, which needs a prototype face law that did not land,
//! stays on the evidence branch `claude/ld01-donor` (E2b resolved).
#![cfg(all(feature = "ida", target_os = "macos"))]
// Probe records are parallel arrays indexed together.
#![allow(clippy::needless_range_loop)]
use leitbild_operating_plant::{
    network::{
        Network, PzrPreparation, RotorState, ToleranceClasses, consistent_start,
        packet::Packet,
        prepare::{self, OperatingPoint, Settings},
    },
    rotor::{Shaft, SpeedRequest, Support},
};
use leitbild_operating_water::{
    If97,
    ida::{Advance, Failure, Ida, Initial, KluOrdering, System},
    network::Integrated,
};
use serde_json::{Value, json};
use std::{
    cell::{Cell as Slot, RefCell},
    f64::consts::PI,
    rc::Rc,
};

#[repr(C)]
struct Timespec {
    seconds: i64,
    nanoseconds: i64,
}
unsafe extern "C" {
    fn clock_gettime(clock: i32, out: *mut Timespec) -> i32;
}
/// CLOCK_PROCESS_CPUTIME_ID on macOS, as the S1 harness measures.
fn cpu_s() -> f64 {
    let mut t = Timespec {
        seconds: 0,
        nanoseconds: 0,
    };
    // SAFETY: one live stack Timespec matching the C layout; the C library
    // writes it and keeps no pointer.
    let status = unsafe { clock_gettime(12, &mut t) };
    assert_eq!(status, 0, "process CPU clock unavailable");
    t.seconds as f64 + t.nanoseconds as f64 * 1e-9
}
fn load_average() -> String {
    std::process::Command::new("sysctl")
        .args(["-n", "vm.loadavg"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .expect("load average")
}
fn git(args: &[&str]) -> String {
    std::process::Command::new("git")
        .args(args)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .expect("git provenance")
}

/// The single JSON object inside one fenced strict block of a wiki page.
fn strict_block(page: &str, fence: &str) -> Value {
    let text = std::fs::read_to_string(page).unwrap_or_else(|e| panic!("{page}: {e}"));
    let open = format!("```{fence}\n");
    let start = text
        .find(&open)
        .unwrap_or_else(|| panic!("{page} has no ```{fence} block"))
        + open.len();
    let end = start + text[start..].find("\n```").expect("unterminated block");
    serde_json::from_str(&text[start..end]).unwrap_or_else(|e| panic!("{fence}: {e}"))
}
fn num(v: &Value, path: &[&str]) -> f64 {
    path.iter()
        .fold(v, |x, k| &x[*k])
        .as_f64()
        .unwrap_or_else(|| panic!("declared value {path:?}"))
}

/// The harness's declared preparation controls.
const PZR: PzrPreparation = PzrPreparation {
    pressure_tolerance_pa: 1e-6,
    max_passes: 50,
};
const CONSISTENT_ROW_BOUND: f64 = 1e-12;
/// Stock IDA's Newton coefficient (SUNDIALS 7.5.0 EPCON).
const STOCK_NEWTON: f64 = 0.33;

fn running(network: &mut Network<If97>) {
    for r in 0..network.rotor_count() {
        network.set_rotor_state(
            r,
            RotorState {
                support: Support::Supported(SpeedRequest::Nominal),
                shaft: Shaft::Free,
            },
        );
    }
}
fn fresh(packet: &Packet) -> Network<If97> {
    let (mut network, _) = Network::new(packet, If97, &PZR).expect("network");
    running(&mut network);
    network
}
fn error_weights(y: &[f64], rtol: f64, atol: &[f64]) -> Vec<f64> {
    y.iter()
        .zip(atol)
        .map(|(v, a)| 1. / (rtol * v.abs() + a))
        .collect()
}

/// The credited outputs at one observed state, as the harness reads them.
#[derive(Clone, Copy, Debug, Default)]
struct Credited {
    t: f64,
    roof_pa: f64,
    level_m: f64,
    core_dp_pa: f64,
    loop_kg_s: [f64; 2],
}
struct Taps {
    loop_faces: [usize; 2],
    lower: usize,
    upper: usize,
}
fn read_credited(network: &Network<If97>, taps: &Taps, t: f64) -> Credited {
    let pzr = network.pzr_taps().expect("PZR taps");
    Credited {
        t,
        roof_pa: pzr.pt1_pa.value,
        level_m: pzr.collapsed_level_m.value,
        core_dp_pa: network.cell(taps.lower).pressure.value
            - network.cell(taps.upper).pressure.value,
        loop_kg_s: taps
            .loop_faces
            .map(|f| network.chart(f, 0).map_or(0., |c| c.mass_flow_kg_s.value)),
    }
}

/// Settled start shared by every probe: the harness's preparation and
/// declared settling, reproduced call for call.
struct Base {
    packet_path: String,
    wiki: String,
    packet: Packet,
    gates: Value,
    budgets: Value,
    atol: Vec<f64>,
    ids: Vec<f64>,
    ys: Vec<f64>,
    settle: Value,
    taps: Taps,
    labels: Vec<(&'static str, String)>,
    scales: Vec<f64>,
    face_ids: Vec<String>,
    /// Liquid impulse coordinate of each face.
    pi: Vec<usize>,
    out_dir: std::path::PathBuf,
}
fn base() -> Base {
    let packet_path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET").unwrap();
    let wiki = std::env::var("LD01_WIKI_ROOT").unwrap();
    let model = format!("{wiki}/world/packs/process-plant/reference-designs/ld-01/model");
    let gates = strict_block(&format!("{model}/build-readiness.md"), "ld01-s1-gates");
    let budgets = strict_block(
        &format!("{model}/operating-hot-spine.md"),
        "ld01-accuracy-contract",
    );
    let packet: Packet =
        serde_json::from_slice(&std::fs::read(&packet_path).unwrap()).expect("packet");
    let point = OperatingPoint::from(&packet.preparation.operating_point);
    let rotors = vec![
        RotorState {
            support: Support::Supported(SpeedRequest::Nominal),
            shaft: Shaft::Free,
        };
        4
    ];
    let settings = Settings {
        pressure_tolerance_pa: PZR.pressure_tolerance_pa,
        max_passes: PZR.max_passes,
        level_match_m: 1e-9,
        eos_row_bound: 1e-12,
        tree_face_bound_pa: 1e-6,
        representation_search: 8,
    };
    let (mut network, prepared, _) =
        prepare::prepare(&packet, If97, &point, &rotors, &settings).expect("preparation");
    let mut y0 = prepared.y.clone();
    for index in &network.rotor_index {
        y0[*index] = 0.;
    }
    let rtol = num(&gates, &["relativeTolerance"]);
    let atol = network
        .absolute_tolerances(
            &y0,
            ToleranceClasses {
                relative: rtol,
                stock_scaled: num(&gates, &["stockScaledAbsolute"]),
                tracer_scaled: num(&gates, &["tracerScaledAbsolute"]),
                rotor_scaled: num(&gates, &["rotorScaledAbsolute"]),
                volume_flow_m3_s: num(&gates, &["volumeFlowAbsolute_m3_s"]),
            },
        )
        .expect("tolerances");
    let face = |id: &str| {
        packet
            .mechanics
            .faces
            .iter()
            .position(|f| f.id == id)
            .unwrap()
    };
    let region = |id: &str| {
        packet
            .mechanics
            .regions
            .iter()
            .position(|r| r.id == id)
            .unwrap()
    };
    let taps = Taps {
        loop_faces: [face("RETURN.A->DOWN"), face("RETURN.B->DOWN")],
        lower: region("LOWER"),
        upper: region("UPPER"),
    };
    let labels = network.labels();
    let scales = network.scales().to_vec();
    let mut pi = vec![0; network.face_count()];
    for l in &network.face_layout {
        if l.phase == 0 {
            pi[l.face] = l.index;
        }
    }
    // The declared settling run, as the harness makes it: from the exact
    // consistent prepared pair, no roots, outputs every 1 s, stopped at the
    // declared mechanical rest.
    let ids = prepared.differential.clone();
    let mut y = y0.clone();
    let weights = error_weights(&y0, rtol, &atol);
    let (yp, _) = consistent_start(
        &mut network,
        0.,
        &mut y,
        &ids,
        &weights,
        CONSISTENT_ROW_BOUND,
        2,
    )
    .expect("prepared pair");
    let omega0 = network.drive().reference_omega_rad_s;
    let log = Rc::new(RefCell::new(Log::new(pi.clone())));
    let system = Recorder {
        inner: Integrated::colored(network).expect("colored"),
        roots: 0,
        next: Rc::new(Slot::new(f64::INFINITY)),
        log,
        refresh: Refresh::Fresh,
        stored: None,
        counts: RefreshCounts::default(),
    };
    let mut ida = Ida::new(
        system,
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: rtol,
        },
    )
    .expect("IDA");
    ida.set_max_order(num(&gates, &["maxOrder"]) as usize)
        .unwrap();
    let stocks = ida.system().inner.network.nonnegative_stocks();
    ida.constrain_nonnegative(&stocks).unwrap();
    let max_s = num(&gates, &["settling", "maxSimulated_s"]);
    ida.stop_at(max_s).unwrap();
    let window = num(&gates, &["settling", "window_s"]);
    let rotor_rel = num(&gates, &["settling", "rotorSpeedRelative"]);
    let flow_rel = num(&gates, &["settling", "loopFlowRelativeChange"]);
    let mut yp = yp;
    let mut samples: Vec<(f64, [f64; 2], Vec<f64>)> = Vec::new();
    let started = cpu_s();
    let mut k = 1;
    loop {
        let target = if k as f64 >= max_s { max_s } else { k as f64 };
        let t = ida
            .advance(target, &mut y, &mut yp)
            .expect("settling advance")
            .reached()
            .expect("settling declares no roots");
        let net = &mut ida.system_mut().inner.network;
        net.evaluate(t, &y, &yp, None, 0., None).expect("sample");
        let flows = taps
            .loop_faces
            .map(|f| net.chart(f, 0).map_or(0., |c| c.mass_flow_kg_s.value));
        let omega: Vec<f64> = net
            .rotor_index
            .iter()
            .map(|i| y[*i] * net.scales()[*i] / net.rotor_inertia())
            .collect();
        samples.push((t, flows, omega));
        let last = samples.last().unwrap();
        let settled = samples
            .iter()
            .rev()
            .find(|s| s.0 <= last.0 - window)
            .is_some_and(|earlier| {
                last.2
                    .iter()
                    .all(|w| ((w - omega0) / omega0).abs() < rotor_rel)
                    && (0..2).all(|j| ((last.1[j] - earlier.1[j]) / last.1[j]).abs() < flow_rel)
            });
        if settled {
            break;
        }
        assert!(t < max_s, "settling did not reach the declared rest");
        k += 1;
    }
    let stats = ida.stats().unwrap();
    let net = &mut ida.system_mut().inner.network;
    net.evaluate(0., &y, &yp, None, 0., None).unwrap();
    let credited = read_credited(net, &taps, samples.last().unwrap().0);
    let settle = json!({"t_s":credited.t,"steps":stats.steps,"error_failures":stats.error_failures,"convergence_failures":stats.convergence_failures,"cpu_s":cpu_s()-started,
        "roof_pa":credited.roof_pa,"level_m":credited.level_m,"core_dp_pa":credited.core_dp_pa,"loop_kg_s":credited.loop_kg_s,
        "run5_reproduced":credited.roof_pa==14940076.109451132 && credited.loop_kg_s==[9062.793405051447, 9060.439006708266] && stats.steps==223});
    // Receipts go to the packet's diagnostics directory, or to an explicit
    // scratch directory for a trial run of the probe itself.
    let out_dir = std::env::var("LD01_DONOR_PROBE_OUT").map_or_else(
        |_| {
            std::path::Path::new(&packet_path)
                .parent()
                .unwrap()
                .join("diagnostics")
        },
        std::path::PathBuf::from,
    );
    Base {
        face_ids: packet
            .mechanics
            .faces
            .iter()
            .map(|f| f.id.clone())
            .collect(),
        packet_path,
        wiki,
        packet,
        gates,
        budgets,
        atol,
        ids,
        ys: y,
        settle,
        taps,
        labels,
        scales,
        pi,
        out_dir,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Event {
    Hold,
    Seizure,
    Supply,
}
/// The harness's event start: a fresh network with the event applied, the
/// settled state (seized rotor momentum zeroed) and the differential ids.
fn event(base: &Base, kind: Event) -> (Network<If97>, Vec<f64>, Vec<f64>) {
    let mut n = fresh(&base.packet);
    let mut y = base.ys.clone();
    let ids = match kind {
        Event::Hold => base.ids.clone(),
        Event::Supply => {
            n.set_rotor_state(
                num(&base.gates, &["supplyLoss", "rotor"]) as usize,
                RotorState {
                    support: Support::Unsupported,
                    shaft: Shaft::Free,
                },
            );
            base.ids.clone()
        }
        Event::Seizure => {
            n.seize(num(&base.gates, &["seizure", "rotor"]) as usize, &mut y)
                .expect("seizure");
            n.differential(&base.ids)
        }
    };
    (n, y, ids)
}

fn signs(pi: &[usize], y: &[f64]) -> Vec<i8> {
    pi.iter()
        .map(|i| {
            if y[*i] > 0. {
                1
            } else if y[*i] < 0. {
                -1
            } else {
                0
            }
        })
        .collect()
}
/// One Newton attempt: consecutive residual calls at one trial time,
/// including a retry at the same time with a fresh Jacobian.
#[derive(Clone)]
struct Attempt {
    t: f64,
    calls: usize,
    jacobians: usize,
    first: Vec<f64>,
    last: Vec<f64>,
    /// Faces whose liquid impulse sign at an iterate differs from the sign
    /// the latest Jacobian was formed with.
    mismatched: Vec<usize>,
    /// Faces whose sign changed between the predictor and an iterate.
    newton_flips: Vec<usize>,
    refused: bool,
}
struct Log {
    pi: Vec<usize>,
    attempts: Vec<Attempt>,
    jacobian_signs: Option<Vec<i8>>,
    jacobian_times: Vec<f64>,
}
impl Log {
    fn new(pi: Vec<usize>) -> Self {
        Self {
            pi,
            attempts: Vec::new(),
            jacobian_signs: None,
            jacobian_times: Vec::new(),
        }
    }
    fn mismatch(&self, y: &[f64]) -> Vec<usize> {
        let s = signs(&self.pi, y);
        self.jacobian_signs.as_ref().map_or(Vec::new(), |j| {
            (0..s.len()).filter(|f| s[*f] != j[*f]).collect()
        })
    }
    fn residual(&mut self, t: f64, y: &[f64], refused: bool) {
        let mismatched = self.mismatch(y);
        match self.attempts.last_mut() {
            Some(a) if a.t == t => {
                a.calls += 1;
                a.last.copy_from_slice(y);
                a.refused |= refused;
                let (s0, s) = (signs(&self.pi, &a.first), signs(&self.pi, y));
                for f in 0..s.len() {
                    if s[f] != s0[f] && !a.newton_flips.contains(&f) {
                        a.newton_flips.push(f);
                    }
                }
                for f in mismatched {
                    if !a.mismatched.contains(&f) {
                        a.mismatched.push(f);
                    }
                }
            }
            _ => self.attempts.push(Attempt {
                t,
                calls: 1,
                jacobians: 0,
                first: y.to_vec(),
                last: y.to_vec(),
                mismatched,
                newton_flips: Vec::new(),
                refused,
            }),
        }
    }
    fn jacobian(&mut self, t: f64, y: &[f64]) {
        self.jacobian_signs = Some(signs(&self.pi, y));
        self.jacobian_times.push(t);
        let mismatched = self.mismatch(y);
        if let Some(a) = self.attempts.last_mut()
            && a.t == t
        {
            a.jacobians += 1;
            // The iterations after this setup use the new matrix.
            a.mismatched = mismatched;
        }
    }
}
/// Delegates every stock callback unchanged; records the residual and
/// Jacobian calls; declares `roots` (0 or 1) observation root functions
/// g = t - next.
struct Recorder<S> {
    inner: S,
    roots: usize,
    next: Rc<Slot<f64>>,
    log: Rc<RefCell<Log>>,
    refresh: Refresh,
    stored: Option<Stored>,
    counts: RefreshCounts,
}
/// The iteration-matrix policy of a run (JAC's candidate 1, emulated in the
/// probe without a kernel change).
#[derive(Clone, Copy, Debug, PartialEq)]
enum Refresh {
    /// Stock: every setup assembles `M = dF/dy + cj dF/dy'` at its state.
    Fresh,
    /// A setup at an attempt's start (stock's first-step or cj-ratio
    /// trigger) recombines the stored `A + cj B` of the last assembly, with
    /// no evaluation; a Newton-failure retry (a setup after further residual
    /// calls at the same trial time, stock's jbad) and the first setup after
    /// a (re)initialization assemble `A` and `B` at their own state.
    CjLinear,
    /// As `CjLinear`, but also assembling at the first setup after any
    /// failed attempt (an attempt whose trial time is not later than the
    /// previous attempt's), which bounds the stored pair's staleness: after
    /// a recombined setup stock counts the matrix as current, so a Newton
    /// failure never reaches its own fresh retry.
    CjLinearBounded,
    /// As `CjLinearBounded`, and also assembling when the stored pair is
    /// older than this many seconds of simulated time (JAC's age cap).
    CjLinearAged(f64),
}
/// The last assembly's `A = dF/dy`, `B = dF/dy'`, structure and state.
struct Stored {
    a: Vec<f64>,
    b: Vec<f64>,
    rows: Vec<i64>,
    pointers: Vec<i64>,
    t: f64,
    y: Vec<f64>,
    yp: Vec<f64>,
}
#[derive(Clone, Copy, Debug, Default)]
struct RefreshCounts {
    /// Setups that assembled (one assembly of A and B in production).
    assemblies: i64,
    /// Setups recombined from the stored A and B.
    recombinations: i64,
    /// Recombinations whose (t, y, y') equals the stored state bitwise.
    identical_state: i64,
    /// Setups at a Newton-failure retry.
    retries: i64,
    /// Setups whose (t, y, y') equals the previous setup's bitwise, under
    /// any policy (where an exact recombination always applies).
    identical_any: i64,
}
impl<S: System> System for Recorder<S> {
    fn dimension(&self) -> usize {
        self.inner.dimension()
    }
    /// The wrapped system's own KLU ordering (AMD on every joined system).
    fn klu_ordering(&self) -> KluOrdering {
        self.inner.klu_ordering()
    }
    fn nonzeros(&self) -> usize {
        self.inner.nonzeros()
    }
    fn root_count(&self) -> usize {
        self.roots
    }
    fn residual(
        &mut self,
        time: f64,
        y: &[f64],
        yp: &[f64],
        out: &mut [f64],
    ) -> Result<(), Failure> {
        let r = self.inner.residual(time, y, yp, out);
        self.log.borrow_mut().residual(time, y, r.is_err());
        r
    }
    fn jacobian(
        &mut self,
        time: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        data: &mut [f64],
        rows: &mut [i64],
        pointers: &mut [i64],
    ) -> Result<(), Failure> {
        let (retry, after_failure) = {
            let log = self.log.borrow();
            let n = log.attempts.len();
            let retry = log
                .attempts
                .last()
                .is_some_and(|a| a.t == time && a.calls > 1);
            let after_failure = n >= 2 && log.attempts[n - 2].t >= log.attempts[n - 1].t;
            (retry, after_failure)
        };
        self.log.borrow_mut().jacobian(time, y);
        let identical = self
            .stored
            .as_ref()
            .is_some_and(|s| s.t == time && s.y == y && s.yp == yp);
        self.counts.identical_any += i64::from(identical);
        self.counts.retries += i64::from(retry);
        let recombine = match self.refresh {
            Refresh::Fresh => false,
            Refresh::CjLinear => !retry || identical,
            Refresh::CjLinearBounded => (!retry && !after_failure) || identical,
            Refresh::CjLinearAged(age) => {
                let young = self.stored.as_ref().is_some_and(|s| time - s.t <= age);
                (!retry && !after_failure && young) || identical
            }
        };
        match (self.refresh, &self.stored) {
            (
                Refresh::CjLinear | Refresh::CjLinearBounded | Refresh::CjLinearAged(_),
                Some(stored),
            ) if recombine => {
                for ((d, a), b) in data.iter_mut().zip(&stored.a).zip(&stored.b) {
                    *d = a + cj * b;
                }
                rows.copy_from_slice(&stored.rows);
                pointers.copy_from_slice(&stored.pointers);
                self.counts.recombinations += 1;
                self.counts.identical_state += i64::from(identical);
                Ok(())
            }
            (Refresh::CjLinear | Refresh::CjLinearBounded | Refresh::CjLinearAged(_), _) => {
                // A, then A + B, by the same colored assembly at cj 0 and 1.
                self.inner.jacobian(time, 0., y, yp, data, rows, pointers)?;
                let a = data.to_vec();
                self.inner.jacobian(time, 1., y, yp, data, rows, pointers)?;
                let b: Vec<f64> = data.iter().zip(&a).map(|(m, a)| m - a).collect();
                // A fresh setup returns the assembly's own M(cj) bit for bit.
                self.inner.jacobian(time, cj, y, yp, data, rows, pointers)?;
                self.stored = Some(Stored {
                    a,
                    b,
                    rows: rows.to_vec(),
                    pointers: pointers.to_vec(),
                    t: time,
                    y: y.to_vec(),
                    yp: yp.to_vec(),
                });
                self.counts.assemblies += 1;
                Ok(())
            }
            (Refresh::Fresh, _) => {
                self.inner.jacobian(time, cj, y, yp, data, rows, pointers)?;
                self.stored = Some(Stored {
                    a: Vec::new(),
                    b: Vec::new(),
                    rows: Vec::new(),
                    pointers: Vec::new(),
                    t: time,
                    y: y.to_vec(),
                    yp: yp.to_vec(),
                });
                self.counts.assemblies += 1;
                Ok(())
            }
        }
    }
    fn roots(&mut self, time: f64, _: &[f64], _: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        out.fill(time - self.next.get());
        Ok(())
    }
}

/// One accepted step of stock IDA, recorded at the return after it.
#[derive(Clone)]
struct Step {
    t: f64,
    h: f64,
    order: i32,
    next_h: f64,
    next_order: i32,
    y: Vec<f64>,
    yp: Vec<f64>,
    /// Cumulative counters of the current history: steps, residuals,
    /// Jacobians, error-test failures, convergence failures.
    counts: [i64; 5],
    /// Stock's local-error estimate of this step times its error weights.
    weighted_error: Vec<f64>,
    /// More than one step since the previous record (only the last kept).
    gap: bool,
}

enum After {
    None,
    /// H1: forced stop at the window's end, exact consistent start, stock
    /// coefficient, no cap, for this many seconds.
    Restart(f64),
    /// Run 4's E4: the cap lifted in the same history, no reinitialization.
    Lift(f64),
    /// The exact consistent start at the window's end, as H1's, but keeping
    /// the window's step cap, with this Newton coefficient and dcj (stock's
    /// 0.25 set explicitly when `None`), for this many seconds.
    Resume {
        duration_s: f64,
        newton: f64,
        dcj: Option<f64>,
        refresh: Refresh,
    },
}
struct Plan<'a> {
    rtol: f64,
    atol: &'a [f64],
    window_s: f64,
    max_step_s: f64,
    newton: Option<f64>,
    after: After,
    /// Fine credited observation interval over the whole run.
    observe_s: Option<f64>,
    /// IDASetDeltaCjLSetup at every start and restart; `None` keeps stock's.
    dcj: Option<f64>,
    /// The iteration-matrix policy.
    refresh: Refresh,
    step_cap: i64,
    cpu_cap_s: f64,
}
struct Trace {
    steps: Vec<Step>,
    attempts: Vec<Attempt>,
    jacobian_times: Vec<f64>,
    fine: Vec<Credited>,
    window_counts: Option<[i64; 5]>,
    end_s: f64,
    window_s: f64,
    failure: Option<String>,
    cpu_s: f64,
    total_steps: i64,
    total_error_failures: i64,
    total_convergence_failures: i64,
    total_jacobians: i64,
    total_residuals: i64,
    /// The integrated network's own evaluation counts and wall times.
    network: leitbild_operating_plant::network::Counters,
    refresh: RefreshCounts,
    /// The refresh counts at the window's end, when the run restarted there.
    refresh_window: Option<RefreshCounts>,
}

fn counts(s: &leitbild_operating_water::ida::Stats) -> [i64; 5] {
    [
        s.steps,
        s.residuals,
        s.jacobians,
        s.error_failures,
        s.convergence_failures,
    ]
}

/// Advance one plan from an event start, one internal step per call after
/// each segment's first call.
fn run(base: &Base, kind: Event, plan: Plan<'_>) -> Trace {
    let started = cpu_s();
    let (mut network, mut y, ids) = event(base, kind);
    let weights = error_weights(&y, plan.rtol, plan.atol);
    let (mut yp, _) = consistent_start(
        &mut network,
        0.,
        &mut y,
        &ids,
        &weights,
        CONSISTENT_ROW_BOUND,
        2,
    )
    .expect("event start");
    let output = num(&base.gates, &["outputInterval_s"]);
    let duration = match plan.after {
        After::None => 0.,
        After::Restart(d) | After::Lift(d) => d,
        After::Resume { duration_s, .. } => duration_s,
    };
    let end_s = plan.window_s + duration;
    let log = Rc::new(RefCell::new(Log::new(base.pi.clone())));
    let next = Rc::new(Slot::new(end_s + 1.));
    let (mut probe, dt) = match plan.observe_s {
        Some(dt) => (Some(event(base, kind).0), dt),
        None => (None, f64::NAN),
    };
    // Observation times j*dt strictly inside (0, end), skipping the forced
    // stops at the window's end and the run's end.
    let mut j = 0usize;
    let mut arm = |next: &Slot<f64>| {
        if !dt.is_finite() {
            return;
        }
        loop {
            j += 1;
            let t = j as f64 * dt;
            if (t - plan.window_s).abs() < 1e-9 {
                continue;
            }
            // A finite time past the run's end: stock refuses a nonfinite root value.
            next.set(if t < end_s - 1e-9 { t } else { end_s + 1. });
            return;
        }
    };
    arm(&next);
    let system = Recorder {
        inner: Integrated::colored(network).expect("colored"),
        roots: 1,
        next: next.clone(),
        log: log.clone(),
        refresh: plan.refresh,
        stored: None,
        counts: RefreshCounts::default(),
    };
    let mut ida = Ida::new(
        system,
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: plan.atol,
            relative_tolerance: plan.rtol,
        },
    )
    .expect("IDA");
    let max_order = num(&base.gates, &["maxOrder"]) as usize;
    ida.set_max_order(max_order).unwrap();
    if plan.max_step_s.is_finite() {
        ida.set_max_step(plan.max_step_s).unwrap();
    }
    if let Some(c) = plan.newton {
        ida.set_nonlinear_convergence_coefficient(c).unwrap();
    }
    if let Some(d) = plan.dcj {
        ida.set_delta_cj_lsetup(d).unwrap();
    }
    let stocks = ida.system().inner.network.nonnegative_stocks();
    ida.constrain_nonnegative(&stocks).unwrap();
    ida.stop_at(plan.window_s).unwrap();
    let mut fine = Vec::new();
    let observe = |probe: &mut Option<Network<If97>>, t: f64, y: &[f64], yp: &[f64]| {
        probe.as_mut().map(|p| {
            p.evaluate(t, y, yp, None, 0., None).expect("observation");
            read_credited(p, &base.taps, t)
        })
    };
    if let Some(c) = observe(&mut probe, 0., &y, &yp) {
        fine.push(c);
    }
    let n = y.len();
    let (mut ys, mut yps, mut errors, mut ewt) =
        (vec![0.; n], vec![0.; n], vec![0.; n], vec![0.; n]);
    let mut steps: Vec<Step> = Vec::new();
    let mut segment = 0;
    let mut first_call = true;
    let mut t_now = 0.;
    let mut last_steps = 0;
    let mut window_counts = None;
    let mut refresh_window = None;
    let mut prior = [0i64; 5];
    let mut failure = None;
    loop {
        let horizon = if segment == 0 { plan.window_s } else { end_s };
        // A segment's first call targets the harness's next output, k * the
        // output interval, so stock's initial step is the harness's.
        let target = if first_call {
            let k = (t_now / output).round() + 1.;
            if k >= (horizon / output).round() {
                horizon
            } else {
                k * output
            }
        } else {
            ida.stats().unwrap().internal_time.max(t_now) + 1e-9
        };
        let outcome = ida.advance(target, &mut y, &mut yp);
        let (t, root) = match outcome {
            Ok(Advance::Reached(t)) => (t, false),
            Ok(Advance::Root { time, .. }) => (time, true),
            Err(e) => {
                failure = Some(e);
                break;
            }
        };
        first_call = false;
        t_now = t;
        let stats = ida.stats().unwrap();
        if stats.steps > last_steps {
            let tn = ida.current_state(&mut ys, &mut yps).unwrap();
            ida.error_diagnostics(&mut errors, &mut ewt).unwrap();
            steps.push(Step {
                t: tn,
                h: stats.last_step,
                order: stats.last_order,
                next_h: stats.current_step,
                next_order: stats.current_order,
                y: ys.clone(),
                yp: yps.clone(),
                counts: std::array::from_fn(|i| prior[i] + counts(&stats)[i]),
                weighted_error: errors.iter().zip(&ewt).map(|(e, w)| e * w).collect(),
                gap: stats.steps > last_steps + 1,
            });
            last_steps = stats.steps;
        }
        if root {
            if let Some(c) = observe(&mut probe, t, &y, &yp) {
                fine.push(c);
            }
            arm(&next);
            continue;
        }
        let total = steps.last().map_or(0, |s| s.counts[0]);
        if total > plan.step_cap {
            failure = Some(format!("step cap {} reached at t={t}", plan.step_cap));
            break;
        }
        if cpu_s() - started > plan.cpu_cap_s {
            failure = Some(format!("CPU cap {} s reached at t={t}", plan.cpu_cap_s));
            break;
        }
        if segment == 0 && t >= plan.window_s - 1e-12 {
            if let Some(c) = observe(&mut probe, t, &y, &yp) {
                fine.push(c);
            }
            window_counts = Some(counts(&stats));
            match plan.after {
                After::None => break,
                After::Lift(_) => {
                    ida.remove_max_step().unwrap();
                    ida.stop_at(end_s).unwrap();
                    segment = 1;
                }
                After::Restart(_) | After::Resume { .. } => {
                    // H1's restart, as the harness makes it (a resume keeps
                    // the window's cap at its own coefficient and dcj).
                    let (newton, dcj, cap, refresh) = match plan.after {
                        After::Resume {
                            newton,
                            dcj,
                            refresh,
                            ..
                        } => (newton, Some(dcj.unwrap_or(0.25)), plan.max_step_s, refresh),
                        _ => (STOCK_NEWTON, plan.dcj, f64::INFINITY, plan.refresh),
                    };
                    refresh_window = Some(ida.system().counts);
                    ida.system_mut().refresh = refresh;
                    let weights = error_weights(&y, plan.rtol, plan.atol);
                    let mut projected = y.clone();
                    let (rates, _) = consistent_start(
                        &mut ida.system_mut().inner.network,
                        t,
                        &mut projected,
                        &ids,
                        &weights,
                        CONSISTENT_ROW_BOUND,
                        2,
                    )
                    .expect("window-end restart");
                    prior = counts(&stats);
                    ida.reinitialize(t, &projected, &rates).unwrap();
                    // A restarted history assembles its first matrix.
                    ida.system_mut().stored = None;
                    ida.set_nonlinear_convergence_coefficient(newton).unwrap();
                    if let Some(d) = dcj {
                        ida.set_delta_cj_lsetup(d).unwrap();
                    }
                    ida.set_max_step(cap).unwrap();
                    ida.set_max_order(max_order).unwrap();
                    ida.constrain_nonnegative(&stocks).unwrap();
                    ida.stop_at(end_s).unwrap();
                    y.copy_from_slice(&projected);
                    yp.copy_from_slice(&rates);
                    segment = 1;
                    first_call = true;
                    last_steps = 0;
                }
            }
            continue;
        }
        if segment == 1 && t >= end_s - 1e-12 {
            if let Some(c) = observe(&mut probe, t, &y, &yp) {
                fine.push(c);
            }
            break;
        }
    }
    let stats = ida.stats().unwrap();
    let network = ida.system().inner.network.counters;
    let refresh = ida.system().counts;
    let total = |i: usize| prior[i] + counts(&stats)[i];
    let log = log.borrow();
    Trace {
        steps,
        attempts: log.attempts.clone(),
        jacobian_times: log.jacobian_times.clone(),
        fine,
        window_counts,
        end_s,
        window_s: plan.window_s,
        failure,
        cpu_s: cpu_s() - started,
        total_steps: total(0),
        total_residuals: total(1),
        total_jacobians: total(2),
        total_error_failures: total(3),
        total_convergence_failures: total(4),
        network,
        refresh,
        refresh_window,
    }
}

// ---- Analysis ----

fn category(labels: &[(&'static str, String)], i: usize) -> &'static str {
    labels[i].0
}
/// Squared weighted-error shares by category and the top coordinates.
fn attribution(base: &Base, weighted: &[f64], top: usize) -> Value {
    let total: f64 = weighted.iter().map(|v| v * v).sum();
    let mut by: Vec<(&str, f64)> = Vec::new();
    for (i, v) in weighted.iter().enumerate() {
        let c = category(&base.labels, i);
        match by.iter_mut().find(|(k, _)| *k == c) {
            Some(e) => e.1 += v * v,
            None => by.push((c, v * v)),
        }
    }
    by.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut order: Vec<usize> = (0..weighted.len()).collect();
    order.sort_by(|a, b| weighted[*b].abs().total_cmp(&weighted[*a].abs()));
    let wrms = (total / weighted.len() as f64).sqrt();
    json!({"wrms":wrms,
        "category_share":by.iter().filter(|(_, v)| *v > 0.).map(|(k, v)| json!([k, v / total])).collect::<Vec<_>>(),
        "top":order.iter().take(top).map(|i| json!([base.labels[*i].1, weighted[*i], (weighted[*i].powi(2)/total)])).collect::<Vec<_>>()})
}
/// The face whose donor-adjacent stocks a coordinate belongs to, if any:
/// the coordinate is M, U or B of a cell at either end of a face.
fn cell_of(base: &Base, network: &Network<If97>, i: usize) -> Option<usize> {
    for (node, l) in network.cell_layout.iter().enumerate() {
        if i == l.boron || l.mass.contains(&i) || l.energy.contains(&i) {
            return Some(node);
        }
    }
    let _ = base;
    network
        .pzr
        .coordinates()
        .contains(&i)
        .then_some(network.pzr.cell)
}
/// Donor switches between consecutive accepted steps, per face.
fn switches(base: &Base, steps: &[Step]) -> Vec<Vec<(usize, f64)>> {
    // For each step index, the faces whose liquid impulse sign changed since
    // the previous step, with the step's time.
    let mut out = vec![Vec::new(); steps.len()];
    for k in 1..steps.len() {
        let (a, b) = (
            signs(&base.pi, &steps[k - 1].y),
            signs(&base.pi, &steps[k].y),
        );
        for f in 0..a.len() {
            if a[f] != b[f] && a[f] != 0 && b[f] != 0 {
                out[k].push((f, steps[k].t));
            }
        }
    }
    out
}
fn high_pass_rms(series: &[f64], dt: f64, cutoff_hz: f64) -> f64 {
    // Series minus its zero-phase 4th-order Butterworth low-pass, as the
    // harness's above-band content.
    if series.len() < 4 {
        return f64::NAN;
    }
    let x: Vec<f64> = series.iter().map(|v| v - series[0]).collect();
    let low = zero_phase_lowpass(&x, cutoff_hz, dt);
    let d: Vec<f64> = x.iter().zip(&low).map(|(a, b)| a - b).collect();
    (d.iter().map(|v| v * v).sum::<f64>() / d.len() as f64).sqrt()
}
fn butterworth(cutoff_hz: f64, dt: f64) -> [[f64; 5]; 2] {
    let (s, c) = (2. * PI * cutoff_hz * dt).sin_cos();
    [
        1. / (2. * (PI / 8.).cos()),
        1. / (2. * (3. * PI / 8.).cos()),
    ]
    .map(|q| {
        let alpha = s / (2. * q);
        let a0 = 1. + alpha;
        [
            (1. - c) / 2. / a0,
            (1. - c) / a0,
            (1. - c) / 2. / a0,
            -2. * c / a0,
            (1. - alpha) / a0,
        ]
    })
}
fn cascade(x: &mut [f64], sections: &[[f64; 5]; 2]) {
    for &[b0, b1, b2, a1, a2] in sections {
        let first = x[0];
        let mut z2 = (b2 - a2) * first;
        let mut z1 = (b1 - a1) * first + z2;
        for v in x.iter_mut() {
            let input = *v;
            let out = b0 * input + z1;
            z1 = b1 * input - a1 * out + z2;
            z2 = b2 * input - a2 * out;
            *v = out;
        }
    }
}
fn zero_phase_lowpass(x: &[f64], cutoff_hz: f64, dt: f64) -> Vec<f64> {
    let n = x.len();
    let pad = ((5. / cutoff_hz / dt).round() as usize).min(n - 1);
    let sections = butterworth(cutoff_hz, dt);
    let mut ext: Vec<f64> = (1..=pad).rev().map(|i| 2. * x[0] - x[i]).collect();
    ext.extend_from_slice(x);
    ext.extend((1..=pad).map(|i| 2. * x[n - 1] - x[n - 1 - i]));
    cascade(&mut ext, &sections);
    ext.reverse();
    cascade(&mut ext, &sections);
    ext.reverse();
    ext[pad..pad + n].to_vec()
}
/// The trace's fine credited series over [from, to].
fn fine_between(trace: &Trace, from: f64, to: f64) -> Vec<Credited> {
    trace
        .fine
        .iter()
        .filter(|c| c.t >= from - 1e-9 && c.t <= to + 1e-9)
        .copied()
        .collect()
}
fn content(trace: &Trace, from: f64, to: f64, dt: f64, cutoff: f64) -> Value {
    let s = fine_between(trace, from, to);
    let pick = |f: fn(&Credited) -> f64| -> f64 {
        high_pass_rms(&s.iter().map(f).collect::<Vec<_>>(), dt, cutoff)
    };
    json!({"interval_s":[from,to],"observations":s.len(),"above_band_rms":{"core_dp_pa":pick(|c| c.core_dp_pa),"roof_pa":pick(|c| c.roof_pa),"loop_a_kg_s":pick(|c| c.loop_kg_s[0]),"loop_b_kg_s":pick(|c| c.loop_kg_s[1])}})
}
/// Steps per one-second bin over [from, to).
fn per_second(steps: &[Step], from: f64, to: f64) -> Vec<usize> {
    let bins = (to - from).round() as usize;
    let mut out = vec![0; bins];
    for s in steps {
        if s.t > from && s.t <= to + 1e-12 {
            let b = (((s.t - from) - 1e-12).max(0.)).floor() as usize;
            if b < bins {
                out[b] += 1;
            }
        }
    }
    out
}

/// Liquid phase transport state of a face's two ends at an evaluated
/// network: (rho*alpha, rho*alpha*h, rho*alpha*c) from, to.
fn ends(network: &Network<If97>, base: &Base, face: usize) -> Option<[[f64; 3]; 2]> {
    let f = &base.packet.mechanics.faces[face];
    let side = |node: usize| {
        network.cell(node).phase[0].map(|p| {
            let ra = p.fraction.value * p.density.value;
            [ra, ra * p.enthalpy.value, ra * p.boron_concentration.value]
        })
    };
    Some([side(f.from)?, side(f.to)?])
}

/// The continuation diagnosis of one event: per-step and per-attempt
/// records over [window, window + post], with the attribution of every
/// error-test failure and every accepted step's error to its coordinates,
/// and the donor switches of every face.
fn interval_report(base: &Base, kind: Event, trace: &Trace, from: f64, to: f64) -> Value {
    let mut probe = event(base, kind).0;
    let rtol = num(&base.gates, &["relativeTolerance"]);
    let dt = num(&base.gates, &["comparison", "observation_s"]);
    let cutoff = num(&base.budgets, &["uncreditedAbove_Hz"]);
    let sw = switches(base, &trace.steps);
    let in_interval = |s: &Step| s.t > from + 1e-12 && s.t <= to + 1e-12;
    let indices: Vec<usize> = (0..trace.steps.len())
        .filter(|k| in_interval(&trace.steps[*k]))
        .collect();
    // Per-face switch counts over the interval and per second.
    let faces = base.pi.len();
    let mut per_face = vec![0usize; faces];
    let bins = (to - from).round() as usize;
    let mut per_face_second = vec![vec![0usize; bins]; faces];
    for k in &indices {
        for (f, t) in &sw[*k] {
            per_face[*f] += 1;
            let b = ((t - from - 1e-12).max(0.)).floor() as usize;
            if b < bins {
                per_face_second[*f][b] += 1;
            }
        }
    }
    // Step records.
    let mut step_rows = Vec::new();
    let mut donor_limited = 0;
    let mut acoustic_limited = 0;
    let mut other_limited = 0;
    let mut category_totals: Vec<(String, f64)> = Vec::new();
    for k in &indices {
        let s = &trace.steps[*k];
        let prev = &trace.steps[k - 1];
        let failures = [s.counts[3] - prev.counts[3], s.counts[4] - prev.counts[4]];
        let total: f64 = s.weighted_error.iter().map(|v| v * v).sum();
        let mut order: Vec<usize> = (0..s.weighted_error.len()).collect();
        order.sort_by(|a, b| {
            s.weighted_error[*b]
                .abs()
                .total_cmp(&s.weighted_error[*a].abs())
        });
        let top = order[0];
        // Class of the dominant component: a stock of a cell at either end
        // of a face whose donor switched in this step or the previous one
        // is donor-adjacent; an impulse or pressure is acoustic/mechanical.
        let recent: Vec<usize> = sw[*k].iter().chain(&sw[k - 1]).map(|(f, _)| *f).collect();
        let adjacent_cells: Vec<usize> = recent
            .iter()
            .flat_map(|f| {
                let face = &base.packet.mechanics.faces[*f];
                [face.from, face.to]
            })
            .collect();
        let class = match cell_of(base, &probe, top) {
            Some(cell) if adjacent_cells.contains(&cell) => "donor-adjacent stock",
            Some(_) => "other stock",
            None => match category(&base.labels, top) {
                "Pi" | "p" => "impulse or pressure",
                _ => "other",
            },
        };
        match class {
            "donor-adjacent stock" => donor_limited += 1,
            "impulse or pressure" => acoustic_limited += 1,
            _ => other_limited += 1,
        }
        for (i, v) in s.weighted_error.iter().enumerate() {
            let name = category(&base.labels, i).to_string();
            match category_totals.iter_mut().find(|(c, _)| *c == name) {
                Some(e) => e.1 += v * v / total,
                None => category_totals.push((name, v * v / total)),
            }
        }
        // Kink strength of each switching face at this step's state.
        let mut kinks = Vec::new();
        if !sw[*k].is_empty() {
            probe
                .evaluate(s.t, &s.y, &s.yp, None, 0., None)
                .expect("probe at step");
            for (f, _) in &sw[*k] {
                let Some([a, b]) = ends(&probe, base, *f) else {
                    continue;
                };
                let chart = probe.chart(*f, 0);
                let inertance = chart.map_or(f64::NAN, |c| c.inertance_kg_m4.value);
                let q_rate = s.yp[base.pi[*f]] * base.scales[base.pi[*f]] / inertance;
                kinks.push(json!({"face":base.face_ids[*f],"d_rho_alpha_kg_m3":a[0]-b[0],"d_rho_alpha_h_j_m3":a[1]-b[1],"d_rho_alpha_c_kg_m3":a[2]-b[2],"q_rate_m3_s2":q_rate,
                    "jump_mass_rate_kg_s2":(a[0]-b[0])*q_rate,"jump_energy_rate_w_s":(a[1]-b[1])*q_rate}));
            }
        }
        step_rows.push(json!({"t":s.t,"h":s.h,"order":s.order,"next_h":s.next_h,"next_order":s.next_order,"gap":s.gap,
            "error_failures":failures[0],"convergence_failures":failures[1],
            "wrms":(total/s.weighted_error.len() as f64).sqrt(),
            "top":order.iter().take(3).map(|i| json!([base.labels[*i].1, s.weighted_error[*i]])).collect::<Vec<_>>(),
            "dominant_class":class,
            "switched":sw[*k].iter().map(|(f,_)| base.face_ids[*f].clone()).collect::<Vec<_>>(),"kinks":kinks}));
    }
    // Failed attempts in the interval. Stock retries a failed attempt from
    // the same accepted state with a smaller step, so an attempt failed
    // exactly when the next attempt's trial time is not later; otherwise it
    // was accepted. Its starting state is the last accepted attempt before
    // it in the attempt sequence. The kind comes from the stock counters
    // between the recorded accepted steps around it: exact where only one
    // kind occurred.
    let mut failed = Vec::new();
    let attempts = &trace.attempts;
    let accepted_flags = accepted_attempts(attempts);
    let mut last_accepted: Option<f64> = None;
    let step_at = |t: f64| {
        trace
            .steps
            .iter()
            .find(|s| (s.t - t).abs() <= 1e-12 * t.abs().max(1.))
    };
    for i in 0..attempts.len() {
        let a = &attempts[i];
        if accepted_flags[i] {
            last_accepted = Some(a.t);
            continue;
        }
        if a.t <= from + 1e-12 || a.t > to + 1e-9 {
            continue;
        }
        let Some(from_t) = last_accepted else {
            continue;
        };
        let following = (i + 1..attempts.len())
            .find(|j| accepted_flags[*j])
            .map(|j| attempts[j].t);
        let (Some(prev), next) = (step_at(from_t), following.and_then(step_at)) else {
            continue;
        };
        let w = error_weights(&prev.y, rtol, base.atol.as_slice());
        let correction: Vec<f64> = a
            .last
            .iter()
            .zip(&a.first)
            .zip(&w)
            .map(|((l, f), w)| (l - f) * w)
            .collect();
        let kinds = next.map(|f| [f.counts[3] - prev.counts[3], f.counts[4] - prev.counts[4]]);
        let kind = match kinds {
            Some([e, 0]) if e > 0 => "error test",
            Some([0, c]) if c > 0 => "convergence",
            Some(_) => "mixed (see counters)",
            None => "unknown",
        };
        failed.push(json!({"t":a.t,"from_t":from_t,"h_attempt":a.t-from_t,"h_accepted_after":following.map(|t| t - from_t),"newton_iterations":a.calls,"jacobians":a.jacobians,"refused_evaluation":a.refused,
            "mismatched_faces":a.mismatched.iter().map(|f| base.face_ids[*f].clone()).collect::<Vec<_>>(),
            "newton_sign_flips":a.newton_flips.iter().map(|f| base.face_ids[*f].clone()).collect::<Vec<_>>(),
            "kind":kind,"counters_to_next_accepted":kinds,
            "correction_attribution":attribution(base, &correction, 4)}));
    }
    category_totals.sort_by(|a, b| b.1.total_cmp(&a.1));
    let first = indices.first().map(|k| &trace.steps[*k]);
    let last = indices.last().map(|k| &trace.steps[*k]);
    let nonzero: Vec<Value> = (0..faces)
        .filter(|f| per_face[*f] > 0)
        .map(|f| json!({"face":base.face_ids[f],"switches":per_face[f],"per_second":per_face_second[f]}))
        .collect();
    let order1 = indices
        .iter()
        .filter(|k| trace.steps[**k].order == 1)
        .count();
    // Near-stagnant faces' flow over the interval from the accepted steps.
    let flow_stats: Vec<Value> = (0..faces)
        .filter(|f| per_face[*f] > 0)
        .map(|f| {
            let q: Vec<f64> = indices
                .iter()
                .map(|k| trace.steps[*k].y[base.pi[f]])
                .collect();
            let max = q.iter().fold(0., |m: f64, v| m.max(v.abs()));
            let mean = q.iter().sum::<f64>() / q.len() as f64;
            json!({"face":base.face_ids[f],"scaled_impulse_mean":mean,"scaled_impulse_max_abs":max,"note":"scaled impulse is Pi/I_reference, the volume flow in m3/s at the reference inertia"})
        })
        .collect();
    json!({"interval_s":[from,to],"steps":indices.len(),"steps_per_second":per_second(&trace.steps, from, to),
        "order1_steps":order1,
        "error_failures":last.zip(trace.steps.get(indices.first().map_or(0,|k|k-1))).map(|(l,p)| l.counts[3]-p.counts[3]),
        "convergence_failures":last.zip(trace.steps.get(indices.first().map_or(0,|k|k-1))).map(|(l,p)| l.counts[4]-p.counts[4]),
        "first_step":first.map(|s| json!({"t":s.t,"h":s.h,"order":s.order})),
        "last_step":last.map(|s| json!({"t":s.t,"h":s.h,"order":s.order,"next_h":s.next_h,"next_order":s.next_order})),
        "dominant_error_class_counts":{"donor_adjacent_stock":donor_limited,"impulse_or_pressure":acoustic_limited,"other":other_limited},
        "error_share_by_category_mean":category_totals.iter().map(|(c, v)| json!([c, v / indices.len().max(1) as f64])).collect::<Vec<_>>(),
        "donor_switches":nonzero,"switching_face_flows":flow_stats,
        "content":[content(trace, from, (from+2.).min(to), dt, cutoff), content(trace, (from+2.).min(to), to, dt, cutoff)],
        "failed_attempts":failed,"steps_detail":step_rows})
}

/// Whether each Newton attempt was accepted: stock retries a failed attempt
/// with a smaller step from the same state, so an attempt failed exactly
/// when the next attempt's trial time is not later. The last attempt of a
/// completed run was accepted.
fn accepted_attempts(attempts: &[Attempt]) -> Vec<bool> {
    (0..attempts.len())
        .map(|i| attempts.get(i + 1).is_none_or(|b| b.t > attempts[i].t))
        .collect()
}
fn trace_summary(trace: &Trace) -> Value {
    json!({"steps":trace.total_steps,"residuals":trace.total_residuals,"jacobians":trace.total_jacobians,"error_failures":trace.total_error_failures,"convergence_failures":trace.total_convergence_failures,
        "window_counts":trace.window_counts,"recorded_steps":trace.steps.len(),"gaps":trace.steps.iter().filter(|s| s.gap).count(),
        "attempts":trace.attempts.len(),"jacobian_setups":trace.jacobian_times.len(),"end_s":trace.end_s,"window_s":trace.window_s,
        "failure":trace.failure,"cpu_s":trace.cpu_s,
        "last_step":trace.steps.last().map(|s| json!({"t":s.t,"h":s.h,"order":s.order}))})
}
/// Steps of a trace whose interval starts at or after `from` (the harness's
/// R0 count: the step straddling the mark counts before it).
fn steps_starting_after(trace: &Trace, from: f64) -> usize {
    trace
        .steps
        .iter()
        .filter(|s| s.t - s.h >= from - 1e-12)
        .count()
}

fn write(base: &Base, name: &str, receipt: &Value) {
    let path = base.out_dir.join(name);
    assert!(
        !path.exists(),
        "{} exists; research receipts are never overwritten",
        path.display()
    );
    std::fs::write(&path, serde_json::to_vec_pretty(receipt).unwrap()).unwrap();
    println!("wrote {}", path.display());
}
fn provenance(base: &Base) -> Value {
    json!({"app_commit":git(&["rev-parse","HEAD"]),"app_worktree_dirty":!git(&["status","--porcelain"]).is_empty(),
        "app_diff":git(&["diff"]),"app_untracked":git(&["ls-files","--others","--exclude-standard"]),
        "probe_sha256":std::process::Command::new("shasum").args(["-a","256",file!()]).current_dir(env!("CARGO_MANIFEST_DIR")).output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default(),
        "packet":base.packet_path,"wiki":base.wiki,"load_average_start":load_average(),
        "settling":base.settle})
}

/// Diagnosis 1: what costs the post-window continuation. For each event,
/// the run-5 window run restarted at the window's end (H1) and continued
/// 10 s; R0 (never capped, one history); R0 forced to stop and restart at
/// the window's end (isolates the restart); and the window run with the cap
/// lifted in the same history (run 4's E4, isolating the restart from the
/// window's retained state).
#[test]
#[ignore = "diagnostic probe, NOT S1 evidence; requires the actual packet, the wiki, maintained IF97 and stock IDA/KLU"]
fn donor_continuation_diagnosis() {
    let cpu0 = cpu_s();
    let base = base();
    assert_eq!(
        base.settle["run5_reproduced"],
        json!(true),
        "{}",
        base.settle
    );
    let rtol = num(&base.gates, &["relativeTolerance"]);
    let cap = num(&base.gates, &["eventWindow", "maxStep_s"]);
    let tight = STOCK_NEWTON * num(&base.gates, &["eventWindow", "newtonCoefficientFactor"]);
    let post = num(&base.gates, &["recovery", "postWindow_s"]);
    let dt = num(&base.gates, &["comparison", "observation_s"]);
    let mut events = serde_json::Map::new();
    for (name, kind, window) in [
        (
            "rcp_seizure",
            Event::Seizure,
            num(&base.gates, &["seizure", "duration_s"]),
        ),
        (
            "rcp_supply_loss",
            Event::Supply,
            num(&base.gates, &["supplyLoss", "duration_s"]),
        ),
    ] {
        let plan = |window_s: f64, max_step_s: f64, newton: Option<f64>, after: After| Plan {
            rtol,
            atol: &base.atol,
            window_s,
            max_step_s,
            newton,
            after,
            observe_s: Some(dt),
            dcj: None,
            refresh: Refresh::Fresh,
            step_cap: 20_000,
            cpu_cap_s: 600.,
        };
        let h1 = run(
            &base,
            kind,
            plan(window, cap, Some(tight), After::Restart(post)),
        );
        let r0 = run(
            &base,
            kind,
            plan(window + post, f64::INFINITY, None, After::None),
        );
        let r0_restart = run(
            &base,
            kind,
            plan(window, f64::INFINITY, None, After::Restart(post)),
        );
        let lift = run(
            &base,
            kind,
            plan(window, cap, Some(tight), After::Lift(post)),
        );
        let span = window + post;
        let reproduction = json!({"h1_window_steps":h1.window_counts.map(|c| c[0]),"h1_continuation_steps":h1.total_steps-h1.window_counts.map_or(0,|c| c[0]),
            "r0_steps_from_window_end":steps_starting_after(&r0, window),"r0_total_steps":r0.total_steps,
            "run5":if kind == Event::Seizure {json!({"window_steps":595,"continuation_steps":137,"r0_interval_steps":45,"r0_total_steps":373})} else {json!({"window_steps":1508,"continuation_steps":38,"r0_interval_steps":13,"r0_total_steps":104})}});
        let r0_at_window = r0
            .steps
            .iter()
            .rfind(|s| s.t <= window + 1e-12)
            .map(|s| json!({"t":s.t,"h":s.h,"order":s.order,"next_h":s.next_h}));
        events.insert(name.into(), json!({"window_s":window,"post_window_s":post,"reproduction":reproduction,
            "runs":{"h1_window_restart":trace_summary(&h1),"r0_never_capped":trace_summary(&r0),"r0_restarted_at_window_end":trace_summary(&r0_restart),"window_then_cap_lifted":trace_summary(&lift)},
            "r0_step_at_window_end":r0_at_window,
            "continuation":{
                "h1_window_restart":interval_report(&base, kind, &h1, window, span),
                "r0_never_capped":interval_report(&base, kind, &r0, window, span),
                "r0_restarted_at_window_end":interval_report(&base, kind, &r0_restart, window, span),
                "window_then_cap_lifted":interval_report(&base, kind, &lift, window, span)}}));
    }
    let receipt = json!({"kind":"donor-continuation-diagnosis-NOT-EVIDENCE","provenance":provenance(&base),
        "method":"the S1 harness's preparation, settling and event starts reproduced call for call (run 5's settled state, window and R0 step counts checked); stock IDA advanced one internal step per call after each segment's first call, which targets the harness's first output so the initial step is the harness's; stock step selection does not read the requested time, so every history is the harness's while each accepted step's time, step, order, counters and stock local-error estimate times error weights are recorded; credited outputs observed every 0.002 s by one root function; the residual and Jacobian callbacks record each Newton attempt (trial time, iterations, predictor and last iterate) and the liquid donor signs (sign of each face's liquid impulse) the latest Jacobian was formed with; a failed attempt's coordinates are attributed by its last iterate minus its predictor times the error weights of the preceding accepted state; a donor switch is a change of a face's liquid impulse sign between consecutive accepted steps",
        "events":events,"cpu_s_total":cpu_s()-cpu0,"load_average_end":load_average()});
    write(&base, "donor-continuation-diagnosis.json", &receipt);
}

/// The 31 Hz analysis of one capped seizure run over [2, 10] s: steps, the
/// core-DP content above the credited band, donor switches, and the Newton
/// attempts against the donor signs of the Jacobian they used, with the
/// accepted states' residual as the Newton-error proxy.
fn cycle_report(base: &Base, trace: &Trace, faces_of_interest: &[usize]) -> Value {
    let rtol = num(&base.gates, &["relativeTolerance"]);
    let dt = num(&base.gates, &["comparison", "observation_s"]);
    let cutoff = num(&base.budgets, &["uncreditedAbove_Hz"]);
    let (from, to) = (2., trace.window_s);
    let steps: Vec<&Step> = trace
        .steps
        .iter()
        .filter(|s| s.t > from && s.t <= to + 1e-12)
        .collect();
    let mut hs: Vec<f64> = steps.iter().map(|s| s.h).collect();
    hs.sort_by(f64::total_cmp);
    let order1 = steps.iter().filter(|s| s.order == 1).count();
    // Core DP content over [5, 10]: the S1 diagnostics' high-pass (series
    // minus its centred 0.1 s mean) and the harness's above-band content.
    let fine = fine_between(trace, 5., to);
    let x: Vec<f64> = fine.iter().map(|c| c.core_dp_pa).collect();
    let m = x.len();
    let centred: Vec<f64> = (0..m)
        .map(|k| {
            let (a, b) = (k.saturating_sub(25), (k + 25).min(m - 1));
            x[k] - x[a..=b].iter().sum::<f64>() / (b - a + 1) as f64
        })
        .collect();
    let crossings: Vec<f64> = (0..m - 1)
        .filter(|k| centred[*k] * centred[k + 1] < 0.)
        .map(|k| fine[k].t)
        .collect();
    let zero_crossing_hz = if crossings.len() > 2 {
        (crossings.len() - 1) as f64 / (2. * (crossings[crossings.len() - 1] - crossings[0]))
    } else {
        f64::NAN
    };
    let rms = |v: &[f64]| (v.iter().map(|q| q * q).sum::<f64>() / v.len() as f64).sqrt();
    // Donor switches between accepted steps over [2, 10].
    let sw = switches(base, &trace.steps);
    let mut per_face = vec![0usize; base.pi.len()];
    for (k, s) in trace.steps.iter().enumerate() {
        if s.t > from && s.t <= to + 1e-12 {
            for (f, _) in &sw[k] {
                per_face[*f] += 1;
            }
        }
    }
    let switched: Vec<Value> = (0..base.pi.len())
        .filter(|f| per_face[*f] > 0)
        .map(|f| json!({"face":base.face_ids[f],"switches":per_face[f],"per_s":per_face[f] as f64/(to-from)}))
        .collect();
    // Newton attempts over [2, 10] and the Jacobian's donor signs.
    let accepted = accepted_attempts(&trace.attempts);
    let mut by_face = Vec::new();
    for &f in faces_of_interest {
        let (mut n_mis, mut n_ok, mut it_mis, mut it_ok) = (0usize, 0usize, 0usize, 0usize);
        for (a, ok) in trace.attempts.iter().zip(&accepted) {
            if !*ok || a.t <= from || a.t > to + 1e-12 {
                continue;
            }
            if a.mismatched.contains(&f) {
                n_mis += 1;
                it_mis += a.calls;
            } else {
                n_ok += 1;
                it_ok += a.calls;
            }
        }
        by_face.push(json!({"face":base.face_ids[f],"accepted_attempts_with_jacobian_on_the_other_donor":n_mis,"accepted_attempts_on_the_jacobian_donor":n_ok,
            "mean_newton_iterations":{"other_donor":it_mis as f64/n_mis.max(1) as f64,"jacobian_donor":it_ok as f64/n_ok.max(1) as f64}}));
    }
    let jacobians = trace
        .jacobian_times
        .iter()
        .filter(|t| **t > from && **t <= to)
        .count();
    // Newton-error proxy at accepted states over [5, 10]: the residual's
    // differential rows times the step and the error weights (the state
    // error a residual r implies through dF/dy' ~ cj I), signed against the
    // face-32 donor sign, split by whether the Jacobian the attempt used had
    // the other donor.
    let mut probe = event(base, Event::Seizure).0;
    let neck_face = base
        .face_ids
        .iter()
        .position(|f| f == "HOUSING.MAIN->HOUSING.NECK")
        .unwrap();
    let neck_cell = base.packet.mechanics.faces[neck_face].to;
    let neck_u = probe.cell_layout[neck_cell].energy[0];
    let neck_m = probe.cell_layout[neck_cell].mass[0];
    let rows_of_interest = [base.pi[0], base.pi[neck_face], neck_u, neck_m];
    let mut proxy: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
    let mut locked: [[Vec<f64>; 4]; 2] = Default::default();
    let attempt_of = |t: f64| {
        trace
            .attempts
            .iter()
            .zip(&accepted)
            .find(|(a, ok)| **ok && (a.t - t).abs() <= 1e-12 * t.abs().max(1.))
            .map(|(a, _)| a)
    };
    for s in trace.steps.iter().filter(|s| s.t > 5. && s.t <= to + 1e-12) {
        let Some(a) = attempt_of(s.t) else { continue };
        probe
            .evaluate(s.t, &s.y, &s.yp, None, 0., None)
            .expect("probe residual");
        let w = error_weights(&s.y, rtol, &base.atol);
        let rows = probe.rows();
        let e: Vec<f64> = (0..s.y.len())
            .filter(|i| base.ids[*i] == 1.)
            .map(|i| s.h * rows[i].value * w[i])
            .collect();
        let class = usize::from(a.mismatched.contains(&neck_face));
        proxy[class].push((e.iter().map(|v| v * v).sum::<f64>() / e.len() as f64).sqrt());
        let sign = f64::from(signs(&base.pi, &s.y)[neck_face]);
        for (j, i) in rows_of_interest.iter().enumerate() {
            locked[class][j].push(s.h * rows[*i].value * w[*i] * sign);
        }
    }
    let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len().max(1) as f64;
    let names = ["Pi[0,0]", "Pi[32,0]", "U[NECK,0]", "M[NECK,0]"];
    let phase_locked = |c: usize| -> Value {
        names
            .iter()
            .enumerate()
            .map(|(j, n)| (n.to_string(), json!({"mean_signed_by_neck_donor":mean(&locked[c][j]),"mean_abs":mean(&locked[c][j].iter().map(|v| v.abs()).collect::<Vec<_>>())})))
            .collect::<serde_json::Map<_, _>>()
            .into()
    };
    json!({"steps":trace.total_steps,"failure":trace.failure,"cpu_s":trace.cpu_s,"jacobians":trace.total_jacobians,
        "steps_2_10_s":steps.len(),"h_min":hs.first(),"h_median":hs.get(hs.len()/2),"h_max":hs.last(),"order1_share":order1 as f64/steps.len().max(1) as f64,
        "core_dp_5_10_s":{"centred_high_pass_rms_pa":rms(&centred),"centred_high_pass_max_abs_pa":centred.iter().fold(0.,|a: f64,b| a.max(b.abs())),"zero_crossing_hz":zero_crossing_hz,
            "above_band_rms_pa":high_pass_rms(&x, dt, cutoff)},
        "donor_switches_2_10_s":switched,
        "newton_2_10_s":{"jacobian_setups":jacobians,"faces":by_face},
        "newton_error_proxy_5_10_s":{"definition":"WRMS over differential rows of h * residual row * error weight at the accepted state, from a probe evaluation; classes by whether the accepted attempt's Jacobian had the other HOUSING.NECK donor","jacobian_donor":{"steps":proxy[0].len(),"mean_wrms":mean(&proxy[0])},"other_donor":{"steps":proxy[1].len(),"mean_wrms":mean(&proxy[1])},
            "rows_signed_by_neck_donor":{"jacobian_donor":phase_locked(0),"other_donor":phase_locked(1)}}})
}

/// Diagnosis 2: the 31 Hz cycle at 4-5 ms caps (decision 0015, E2b),
/// reproduced on the seizure window from the exact start, as the S1
/// diagnostics' cap probe ran it: caps 4, 4.5, 5 and 6 ms at stock's Newton
/// coefficient and 5 ms at a ten times tighter one, 10 s each.
#[test]
#[ignore = "diagnostic probe, NOT S1 evidence; requires the actual packet, the wiki, maintained IF97 and stock IDA/KLU"]
fn donor_cap_cycle_probe() {
    let cpu0 = cpu_s();
    let base = base();
    assert_eq!(base.settle["run5_reproduced"], json!(true));
    let rtol = num(&base.gates, &["relativeTolerance"]);
    let dt = num(&base.gates, &["comparison", "observation_s"]);
    let window = num(&base.gates, &["seizure", "duration_s"]);
    let faces: Vec<usize> = [
        "UPPER->HOUSING.MAIN",
        "HOUSING.MAIN->HOUSING.NECK",
        "HOT.A.JUNCTION->SURGE",
        "SURGE->PZR.SURGE.MOUTH",
    ]
    .iter()
    .map(|id| base.face_ids.iter().position(|f| f == id).unwrap())
    .collect();
    let mut runs = serde_json::Map::new();
    for (name, cap, newton) in [
        ("hmax_4ms", 0.004, None),
        ("hmax_4p5ms", 0.0045, None),
        ("hmax_5ms", 0.005, None),
        ("hmax_6ms", 0.006, None),
        ("hmax_5ms_newton_0p033", 0.005, Some(0.033)),
    ] {
        let trace = run(
            &base,
            Event::Seizure,
            Plan {
                rtol,
                atol: &base.atol,
                window_s: window,
                max_step_s: cap,
                newton,
                after: After::None,
                observe_s: Some(dt),
                dcj: None,
                refresh: Refresh::Fresh,
                step_cap: 50_000,
                cpu_cap_s: 600.,
            },
        );
        runs.insert(name.into(), json!({"max_step_s":cap,"newton_coefficient":newton.unwrap_or(STOCK_NEWTON),"report":cycle_report(&base, &trace, &faces)}));
    }
    let receipt = json!({"kind":"donor-cap-cycle-probe-NOT-EVIDENCE","provenance":provenance(&base),
        "method":"the S1 seizure from the settled state by the harness's exact start, capped by IDASetMaxStep over its 10 s window, recorded step by step as in donor-continuation-diagnosis; donor switches are sign changes of a face's liquid impulse between accepted steps; a Newton attempt uses the Jacobian of the latest setup, whose donor signs are recorded at that setup",
        "runs":runs,"cpu_s_total":cpu_s()-cpu0,"load_average_end":load_average()});
    write(&base, "donor-cap-cycle.json", &receipt);
}

/// Diagnosis 4: does the 4.5-5 ms cycle scale with the Newton tolerance?
/// The capped seizure of diagnosis 2 at exact upwind with stock's Newton
/// coefficient divided by 1, 3.3, 10, 33 and 100. A cycle fed by the
/// accepted Newton error shrinks with the coefficient; one of the exact
/// BDF2 map would not.
#[test]
#[ignore = "diagnostic probe, NOT S1 evidence; requires the actual packet, the wiki, maintained IF97 and stock IDA/KLU"]
fn donor_newton_scaling_probe() {
    let cpu0 = cpu_s();
    let base = base();
    assert_eq!(base.settle["run5_reproduced"], json!(true));
    let rtol = num(&base.gates, &["relativeTolerance"]);
    let dt = num(&base.gates, &["comparison", "observation_s"]);
    let window = num(&base.gates, &["seizure", "duration_s"]);
    let faces: Vec<usize> = [
        "UPPER->HOUSING.MAIN",
        "HOUSING.MAIN->HOUSING.NECK",
        "HOT.A.JUNCTION->SURGE",
        "SURGE->PZR.SURGE.MOUTH",
    ]
    .iter()
    .map(|id| base.face_ids.iter().position(|f| f == id).unwrap())
    .collect();
    let mut runs = serde_json::Map::new();
    for cap in [0.0045, 0.005] {
        for coefficient in [0.33, 0.1, 0.033, 0.01, 0.0033] {
            let trace = run(
                &base,
                Event::Seizure,
                Plan {
                    rtol,
                    atol: &base.atol,
                    window_s: window,
                    max_step_s: cap,
                    newton: Some(coefficient),
                    after: After::None,
                    observe_s: Some(dt),
                    dcj: None,
                    refresh: Refresh::Fresh,
                    step_cap: 50_000,
                    cpu_cap_s: 600.,
                },
            );
            let report = cycle_report(&base, &trace, &faces);
            runs.insert(
                format!("hmax_{}ms_newton_{coefficient}", cap * 1e3),
                json!({"max_step_s":cap,"newton_coefficient":coefficient,"steps":report["steps"],"residuals":trace.total_residuals,"jacobians":trace.total_jacobians,
                    "newton_iterations_per_step":trace.total_residuals as f64/trace.total_steps as f64,"h_median":report["h_median"],
                    "core_dp_5_10_s":report["core_dp_5_10_s"],"donor_switches_2_10_s":report["donor_switches_2_10_s"],
                    "newton_error_proxy_5_10_s":{"jacobian_donor":report["newton_error_proxy_5_10_s"]["jacobian_donor"],"other_donor":report["newton_error_proxy_5_10_s"]["other_donor"]},
                    "cpu_s":trace.cpu_s,"failure":trace.failure}),
            );
        }
    }
    let receipt = json!({"kind":"donor-newton-scaling-probe-NOT-EVIDENCE","provenance":provenance(&base),
        "method":"the capped S1 seizure of donor-cap-cycle at exact upwind, stock IDA with IDASetNonlinConvCoef set before the first step to the listed coefficient; content and switches as there",
        "runs":runs,"cpu_s_total":cpu_s()-cpu0,"load_average_end":load_average()});
    write(&base, "donor-newton-scaling.json", &receipt);
}

/// One run's Newton and Jacobian cost: stock's counts and residual-equivalent
/// evaluations (a colored Jacobian costs one value evaluation plus one seeded
/// evaluation per color), per step and per simulated second over `span_s`.
fn cost(trace: &Trace, colors: usize, span_s: f64) -> Value {
    let equivalents = trace.total_residuals + trace.total_jacobians * (colors as i64 + 1);
    json!({"steps":trace.total_steps,"residuals":trace.total_residuals,"jacobians":trace.total_jacobians,
        "error_failures":trace.total_error_failures,"convergence_failures":trace.total_convergence_failures,
        "newton_iterations_per_step":trace.total_residuals as f64/trace.total_steps.max(1) as f64,
        "jacobians_per_step":trace.total_jacobians as f64/trace.total_steps.max(1) as f64,
        "residuals_per_simulated_s":trace.total_residuals as f64/span_s,
        "residual_equivalents":equivalents,"residual_equivalents_per_simulated_s":equivalents as f64/span_s,
        "network_evaluation_wall_s":trace.network.evaluation_wall_s,"network_jacobian_wall_s":trace.network.jacobian_wall_s,
        "cpu_s":trace.cpu_s,"failure":trace.failure})
}
fn colors(base: &Base) -> usize {
    fresh(&base.packet)
        .sparse_jacobian()
        .expect("structure")
        .coloring
        .count()
}

/// Diagnosis 5: stock IDASetDeltaCjLSetup against the decided 0.01 Newton
/// coefficient (E2b resolved). The 4.5 and 5 ms capped seizure of diagnosis
/// 2 at stock's and the window's coefficient (0.33, 0.033) with dcj from
/// stock's 0.25 down to 0, beside 0.01 at stock's dcj: whether a smaller
/// dcj removes the cycle, monotonically, and at what Newton and Jacobian
/// cost.
#[test]
#[ignore = "diagnostic probe, NOT S1 evidence; requires the actual packet, the wiki, maintained IF97 and stock IDA/KLU"]
fn donor_delta_cj_probe() {
    let cpu0 = cpu_s();
    let base = base();
    assert_eq!(base.settle["run5_reproduced"], json!(true));
    let rtol = num(&base.gates, &["relativeTolerance"]);
    let dt = num(&base.gates, &["comparison", "observation_s"]);
    let window = num(&base.gates, &["seizure", "duration_s"]);
    let colors = colors(&base);
    let faces: Vec<usize> = [
        "UPPER->HOUSING.MAIN",
        "HOUSING.MAIN->HOUSING.NECK",
        "HOT.A.JUNCTION->SURGE",
        "SURGE->PZR.SURGE.MOUTH",
    ]
    .iter()
    .map(|id| base.face_ids.iter().position(|f| f == id).unwrap())
    .collect();
    let mut cases: Vec<(f64, f64, Option<f64>)> = Vec::new();
    for cap in [0.0045, 0.005] {
        cases.push((cap, 0.01, None));
        for coefficient in [STOCK_NEWTON, 0.033] {
            for dcj in [0.25, 0.1, 0.05, 0.02, 0.01, 0.] {
                cases.push((cap, coefficient, Some(dcj)));
            }
        }
    }
    let mut runs = Vec::new();
    for (cap, coefficient, dcj) in cases {
        let trace = run(
            &base,
            Event::Seizure,
            Plan {
                rtol,
                atol: &base.atol,
                window_s: window,
                max_step_s: cap,
                newton: Some(coefficient),
                after: After::None,
                observe_s: Some(dt),
                dcj,
                refresh: Refresh::Fresh,
                step_cap: 50_000,
                cpu_cap_s: 900.,
            },
        );
        let report = cycle_report(&base, &trace, &faces);
        runs.push(json!({"max_step_s":cap,"newton_coefficient":coefficient,"dcj":dcj.unwrap_or(0.25),"dcj_set":dcj.is_some(),
            "cost":cost(&trace, colors, window),"h_median":report["h_median"],"core_dp_5_10_s":report["core_dp_5_10_s"],
            "donor_switches_2_10_s":report["donor_switches_2_10_s"],
            "newton_error_proxy_5_10_s_wrms":report["newton_error_proxy_5_10_s"]["jacobian_donor"]["mean_wrms"]}));
    }
    let receipt = json!({"kind":"donor-delta-cj-probe-NOT-EVIDENCE","provenance":provenance(&base),
        "method":"the capped S1 seizure of donor-cap-cycle at exact upwind; stock IDASetNonlinConvCoef and IDASetDeltaCjLSetup set before the first step (dcj 0.25 is stock's default, set explicitly; dcj 0 sets the iteration matrix up at every change of cj); content above the 2 Hz band of core DP over 5-10 s as there; residual equivalents count a colored Jacobian as one value evaluation plus one seeded evaluation per color",
        "colors":colors,"runs":runs,"cpu_s_total":cpu_s()-cpu0,"load_average_end":load_average()});
    write(&base, "donor-delta-cj.json", &receipt);
}

/// Diagnosis 6: the quiet and natural-step cost of the decided 0.01 Newton
/// coefficient and of smaller dcj values, against stock: the S1 60 s hold
/// (steps measured from 10 s, as the harness measures them) and the
/// never-capped seizure and supply-loss runs (R0's configuration) over their
/// window and recovery interval, all from the settled state.
#[test]
#[ignore = "diagnostic probe, NOT S1 evidence; requires the actual packet, the wiki, maintained IF97 and stock IDA/KLU"]
fn donor_quiet_cost_probe() {
    let cpu0 = cpu_s();
    let base = base();
    assert_eq!(base.settle["run5_reproduced"], json!(true));
    let rtol = num(&base.gates, &["relativeTolerance"]);
    let colors = colors(&base);
    let hold_s = num(&base.gates, &["hold", "duration_s"]);
    let from_s = num(&base.gates, &["hold", "measuredFrom_s"]);
    let post = num(&base.gates, &["recovery", "postWindow_s"]);
    let settings: [(&str, Option<f64>, Option<f64>); 5] = [
        ("stock", None, None),
        ("newton_0.01", Some(0.01), None),
        ("dcj_0.05", None, Some(0.05)),
        ("dcj_0.01", None, Some(0.01)),
        ("dcj_0", None, Some(0.)),
    ];
    let mut out = serde_json::Map::new();
    for (name, newton, dcj) in settings {
        let mut cases = serde_json::Map::new();
        for (case, kind, span) in [
            ("hold", Event::Hold, hold_s),
            (
                "rcp_seizure_never_capped",
                Event::Seizure,
                num(&base.gates, &["seizure", "duration_s"]) + post,
            ),
            (
                "rcp_supply_loss_never_capped",
                Event::Supply,
                num(&base.gates, &["supplyLoss", "duration_s"]) + post,
            ),
        ] {
            let trace = run(
                &base,
                kind,
                Plan {
                    rtol,
                    atol: &base.atol,
                    window_s: span,
                    max_step_s: f64::INFINITY,
                    newton,
                    after: After::None,
                    observe_s: None,
                    dcj,
                    refresh: Refresh::Fresh,
                    step_cap: 50_000,
                    cpu_cap_s: 900.,
                },
            );
            let mut c = cost(&trace, colors, span);
            if kind == Event::Hold {
                let measured = trace.steps.iter().filter(|s| s.t > from_s + 1e-12).count();
                c["steps_per_s_measured_from"] =
                    json!({"from_s":from_s,"steps_per_s":measured as f64/(span-from_s)});
                c["run5_hold"] =
                    json!({"steps":54,"residuals":59,"jacobians":14,"steps_per_s_measured":0.62});
            }
            cases.insert(case.into(), c);
        }
        out.insert(name.into(), json!({"newton_coefficient":newton.unwrap_or(STOCK_NEWTON),"dcj":dcj.unwrap_or(0.25),"cases":cases}));
    }
    let receipt = json!({"kind":"donor-quiet-cost-probe-NOT-EVIDENCE","provenance":provenance(&base),
        "method":"from the S1 settled state by the harness's exact start, never capped: the 60 s hold and the seizure and supply-loss events over window plus recovery (R0's configuration), at stock settings, the decided 0.01 Newton coefficient, and stock's coefficient with smaller dcj; stock counts and residual equivalents (colored Jacobian = 1 + colors evaluations)",
        "colors":colors,"settings":out,"cpu_s_total":cpu_s()-cpu0,"load_average_end":load_average()});
    write(&base, "donor-quiet-cost.json", &receipt);
}

/// One scalar decay, y' = -y, for the setter's own checks.
struct Decay;
impl System for Decay {
    fn dimension(&self) -> usize {
        1
    }
    fn nonzeros(&self) -> usize {
        1
    }
    fn root_count(&self) -> usize {
        0
    }
    fn roots(&mut self, _: f64, _: &[f64], _: &[f64], _: &mut [f64]) -> Result<(), Failure> {
        Ok(())
    }
    fn residual(&mut self, _: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        out[0] = yp[0] + y[0];
        Ok(())
    }
    fn jacobian(
        &mut self,
        _: f64,
        cj: f64,
        _: &[f64],
        _: &[f64],
        data: &mut [f64],
        rows: &mut [i64],
        pointers: &mut [i64],
    ) -> Result<(), Failure> {
        data[0] = 1. + cj;
        rows[0] = 0;
        pointers.copy_from_slice(&[0, 1]);
        Ok(())
    }
}
fn decay(dcj: Option<f64>) -> leitbild_operating_water::ida::Stats {
    let (mut y, mut yp) = (vec![1.], vec![-1.]);
    let mut ida = Ida::new(
        Decay,
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &[1.],
            absolute_tolerance: &[1e-10],
            relative_tolerance: 1e-6,
        },
    )
    .unwrap();
    if let Some(d) = dcj {
        ida.set_delta_cj_lsetup(d).unwrap();
    }
    ida.advance(5., &mut y, &mut yp).unwrap().reached().unwrap();
    assert!((y[0] - (-5_f64).exp()).abs() < 1e-4, "{}", y[0]);
    ida.stats().unwrap()
}
/// The IDASetDeltaCjLSetup setter admits stock's range [0, 1), refuses the
/// values stock would silently replace by its default, is configurable only
/// at a segment start, and dcj 0 sets the iteration matrix up at least as
/// often as stock's 0.25.
#[test]
fn the_delta_cj_setter_admits_stocks_range_and_refuses_its_silent_default() {
    let initial = || {
        Ida::new(
            Decay,
            Initial {
                time: 0.,
                y: &[1.],
                yp: &[-1.],
                differential: &[1.],
                absolute_tolerance: &[1e-10],
                relative_tolerance: 1e-6,
            },
        )
        .unwrap()
    };
    let mut ida = initial();
    for bad in [1., 1.5, -0.1, f64::NAN, f64::INFINITY] {
        assert!(ida.set_delta_cj_lsetup(bad).is_err(), "{bad}");
    }
    for good in [0., 0.1, 0.25, 0.999] {
        ida.set_delta_cj_lsetup(good).unwrap();
    }
    let (mut y, mut yp) = (vec![1.], vec![-1.]);
    ida.advance(0.1, &mut y, &mut yp).unwrap();
    assert!(
        ida.set_delta_cj_lsetup(0.1).is_err(),
        "configurable only at a segment start"
    );
    let (stock, every) = (decay(None), decay(Some(0.)));
    assert_eq!(
        decay(Some(0.25)).linear_setups,
        stock.linear_setups,
        "0.25 is stock's own default"
    );
    assert!(
        every.linear_setups >= stock.linear_setups,
        "dcj 0: {} setups, stock {}",
        every.linear_setups,
        stock.linear_setups
    );
}

/// Diagnosis 7: where between stock's dcj 0.25 and 0.1 the cap cycle stops,
/// and the quiet and natural-step cost of the dcj values that stop it: the
/// 4.5 and 5 ms capped seizure at stock's Newton coefficient with dcj 0.2,
/// 0.15 and 0.125, and the hold and never-capped events of diagnosis 6 with
/// dcj 0.2, 0.15 and 0.1.
#[test]
#[ignore = "diagnostic probe, NOT S1 evidence; requires the actual packet, the wiki, maintained IF97 and stock IDA/KLU"]
fn donor_delta_cj_threshold_probe() {
    let cpu0 = cpu_s();
    let base = base();
    assert_eq!(base.settle["run5_reproduced"], json!(true));
    let rtol = num(&base.gates, &["relativeTolerance"]);
    let dt = num(&base.gates, &["comparison", "observation_s"]);
    let window = num(&base.gates, &["seizure", "duration_s"]);
    let post = num(&base.gates, &["recovery", "postWindow_s"]);
    let hold_s = num(&base.gates, &["hold", "duration_s"]);
    let from_s = num(&base.gates, &["hold", "measuredFrom_s"]);
    let colors = colors(&base);
    let faces: Vec<usize> = ["UPPER->HOUSING.MAIN", "HOUSING.MAIN->HOUSING.NECK"]
        .iter()
        .map(|id| base.face_ids.iter().position(|f| f == id).unwrap())
        .collect();
    let plan = |window_s: f64, max_step_s: f64, observe_s: Option<f64>, dcj: f64| Plan {
        rtol,
        atol: &base.atol,
        window_s,
        max_step_s,
        newton: None,
        after: After::None,
        observe_s,
        dcj: Some(dcj),
        refresh: Refresh::Fresh,
        step_cap: 50_000,
        cpu_cap_s: 900.,
    };
    let mut capped = Vec::new();
    for cap in [0.0045, 0.005] {
        for dcj in [0.2, 0.15, 0.125] {
            let trace = run(&base, Event::Seizure, plan(window, cap, Some(dt), dcj));
            let report = cycle_report(&base, &trace, &faces);
            capped.push(json!({"max_step_s":cap,"dcj":dcj,"cost":cost(&trace, colors, window),"h_median":report["h_median"],"core_dp_5_10_s":report["core_dp_5_10_s"],
                "newton_error_proxy_5_10_s_wrms":report["newton_error_proxy_5_10_s"]["jacobian_donor"]["mean_wrms"]}));
        }
    }
    let mut natural = serde_json::Map::new();
    for dcj in [0.2, 0.15, 0.1] {
        let mut cases = serde_json::Map::new();
        for (case, kind, span) in [
            ("hold", Event::Hold, hold_s),
            ("rcp_seizure_never_capped", Event::Seizure, window + post),
            (
                "rcp_supply_loss_never_capped",
                Event::Supply,
                num(&base.gates, &["supplyLoss", "duration_s"]) + post,
            ),
        ] {
            let trace = run(&base, kind, plan(span, f64::INFINITY, None, dcj));
            let mut c = cost(&trace, colors, span);
            if kind == Event::Hold {
                let measured = trace.steps.iter().filter(|s| s.t > from_s + 1e-12).count();
                c["steps_per_s_measured_from"] =
                    json!({"from_s":from_s,"steps_per_s":measured as f64/(span-from_s)});
            }
            cases.insert(case.into(), c);
        }
        natural.insert(
            format!("dcj_{dcj}"),
            json!({"dcj":dcj,"newton_coefficient":STOCK_NEWTON,"cases":cases}),
        );
    }
    let receipt = json!({"kind":"donor-delta-cj-threshold-probe-NOT-EVIDENCE","provenance":provenance(&base),
        "method":"as donor-delta-cj (capped seizure, stock Newton coefficient, dcj set before the first step) and donor-quiet-cost (never capped, from the settled state), at the listed dcj",
        "colors":colors,"capped_seizure":capped,"natural":natural,"cpu_s_total":cpu_s()-cpu0,"load_average_end":load_average()});
    write(&base, "donor-delta-cj-threshold.json", &receipt);
}

/// Diagnosis 8: does either remedy stop a cycle that has already formed?
/// The 4.5 and 5 ms capped seizure at stock settings for 5 s, where the cycle
/// is established, then restarted there by the exact consistent start with
/// the cap kept, for 5 s more: at stock settings (does a plain restart
/// alone stop it?), at stock's coefficient with dcj 0.15 and 0.1, and at the
/// 0.01 coefficient with stock's dcj. Content over 7-10 s.
#[test]
#[ignore = "diagnostic probe, NOT S1 evidence; requires the actual packet, the wiki, maintained IF97 and stock IDA/KLU"]
fn donor_established_cycle_probe() {
    let cpu0 = cpu_s();
    let base = base();
    assert_eq!(base.settle["run5_reproduced"], json!(true));
    let rtol = num(&base.gates, &["relativeTolerance"]);
    let dt = num(&base.gates, &["comparison", "observation_s"]);
    let cutoff = num(&base.budgets, &["uncreditedAbove_Hz"]);
    let colors = colors(&base);
    let mut runs = Vec::new();
    for cap in [0.0045, 0.005] {
        for (name, newton, dcj) in [
            ("stock", STOCK_NEWTON, None),
            ("dcj_0.15", STOCK_NEWTON, Some(0.15)),
            ("dcj_0.1", STOCK_NEWTON, Some(0.1)),
            ("newton_0.01", 0.01, None),
        ] {
            let trace = run(
                &base,
                Event::Seizure,
                Plan {
                    rtol,
                    atol: &base.atol,
                    window_s: 5.,
                    max_step_s: cap,
                    newton: None,
                    after: After::Resume {
                        duration_s: 5.,
                        newton,
                        dcj,
                        refresh: Refresh::Fresh,
                    },
                    observe_s: Some(dt),
                    dcj: None,
                    refresh: Refresh::Fresh,
                    step_cap: 50_000,
                    cpu_cap_s: 900.,
                },
            );
            let rms = |a: f64, b: f64| {
                let x: Vec<f64> = fine_between(&trace, a, b)
                    .iter()
                    .map(|c| c.core_dp_pa)
                    .collect();
                high_pass_rms(&x, dt, cutoff)
            };
            let resumed: Vec<&Step> = trace.steps.iter().filter(|s| s.t > 5. + 1e-12).collect();
            runs.push(json!({"max_step_s":cap,"resume":name,"newton_coefficient":newton,"dcj":dcj.unwrap_or(0.25),
                "core_dp_above_band_rms_pa":{"before_restart_2_5_s":rms(2., 5.),"after_restart_7_10_s":rms(7., 10.)},
                "resumed_steps":resumed.len(),"resumed_residuals":trace.total_residuals-trace.window_counts.map_or(0,|c| c[1]),"resumed_jacobians":trace.total_jacobians-trace.window_counts.map_or(0,|c| c[2]),
                "cost":cost(&trace, colors, 10.)}));
        }
    }
    let receipt = json!({"kind":"donor-established-cycle-probe-NOT-EVIDENCE","provenance":provenance(&base),
        "method":"the capped S1 seizure at stock settings to 5 s, then the exact consistent start there (H1's restart) keeping the cap, with the listed Newton coefficient and dcj set before the resumed first step; harness above-band (2 Hz) core-DP RMS before (2-5 s) and after (7-10 s) the restart",
        "runs":runs,"cpu_s_total":cpu_s()-cpu0,"load_average_end":load_average()});
    write(&base, "donor-established-cycle.json", &receipt);
}

/// The harness's E0/E1 comparison of the credited outputs of `a` - `b` over
/// [0, window]: zero-phase 4th-order Butterworth low-pass of each observed
/// difference at the credited band; roof bias the mean |filtered|, roof
/// noise the deviation of the filtered roof error's change between output
/// samples, level/core DP/loop flow the max |filtered|.
fn compare(base: &Base, a: &Trace, b: &Trace, window_s: f64) -> Value {
    let dt = num(&base.gates, &["comparison", "observation_s"]);
    let output = num(&base.gates, &["outputInterval_s"]);
    let cutoff = num(&base.budgets, &["uncreditedAbove_Hz"]);
    let n = (window_s / dt).round() as usize;
    let grid = |t: &Trace| -> Option<Vec<Credited>> {
        let s = t.fine.get(..=n)?.to_vec();
        s.iter()
            .enumerate()
            .all(|(j, c)| (c.t - j as f64 * dt).abs() <= 1e-9)
            .then_some(s)
    };
    let (Some(sa), Some(sb)) = (grid(a), grid(b)) else {
        return json!({"evaluable":false});
    };
    let per_output = (output / dt).round() as usize;
    let diff = |pick: fn(&Credited) -> f64| -> Vec<f64> {
        let raw: Vec<f64> = sa.iter().zip(&sb).map(|(p, q)| pick(p) - pick(q)).collect();
        zero_phase_lowpass(&raw, cutoff, dt)
    };
    let max_abs = |v: &[f64]| v.iter().fold(0., |m: f64, x| m.max(x.abs()));
    let roof = diff(|c| c.roof_pa);
    let outputs: Vec<f64> = roof.iter().step_by(per_output).copied().collect();
    let changes: Vec<f64> = outputs.windows(2).map(|w| w[1] - w[0]).collect();
    let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
    let dev = |v: &[f64]| {
        let m = mean(v);
        (v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / v.len() as f64).sqrt()
    };
    json!({"evaluable":true,"window_s":window_s,
        "pzr_roof_bias_pa":mean(&roof.iter().map(|x| x.abs()).collect::<Vec<_>>()),
        "pzr_roof_sample_noise_pa":dev(&changes),
        "pzr_level_m":max_abs(&diff(|c| c.level_m)),
        "core_dp_pa":max_abs(&diff(|c| c.core_dp_pa)),
        "loop_flow_kg_s":max_abs(&diff(|c| c.loop_kg_s[0])).max(max_abs(&diff(|c| c.loop_kg_s[1])))})
}
fn refresh_json(c: &RefreshCounts) -> Value {
    json!({"assemblies":c.assemblies,"recombinations":c.recombinations,"recombinations_at_identical_state":c.identical_state,
        "newton_failure_retries":c.retries,"setups_at_identical_state_any_policy":c.identical_any})
}
/// Largest raw difference of two runs' fine credited series on a common
/// observation grid, over [from, to].
fn raw_difference(a: &Trace, b: &Trace, from: f64, to: f64) -> Value {
    let (sa, sb) = (fine_between(a, from, to), fine_between(b, from, to));
    if sa.len() != sb.len() || sa.iter().zip(&sb).any(|(p, q)| (p.t - q.t).abs() > 1e-9) {
        return json!({"comparable":false});
    }
    let max = |f: fn(&Credited) -> f64| {
        sa.iter()
            .zip(&sb)
            .map(|(p, q)| (f(p) - f(q)).abs())
            .fold(0., f64::max)
    };
    json!({"comparable":true,"interval_s":[from,to],"core_dp_pa":max(|c| c.core_dp_pa),"roof_pa":max(|c| c.roof_pa),"level_m":max(|c| c.level_m),
        "loop_kg_s":max(|c| c.loop_kg_s[0]).max(max(|c| c.loop_kg_s[1]))})
}

/// JAC's candidate 1, the cj-linear refresh: `M = A + cj B` recombined from
/// the last assembly at a setup triggered by a cj change or a first step,
/// and assembled fresh only at a Newton-failure retry or a (re)start. At
/// dcj 0.1 and stock's Newton coefficient: (1) the 4.5 and 5 ms capped
/// seizure, (2) the established cycle resumed at 5 s with the cap kept,
/// (3) the S1 seizure and supply-loss window runs restarted at their ends
/// (H1) and continued 10 s, the restart ramp, and (4) the hold and the
/// never-capped seizure. Each beside the same run assembling every setup.
#[test]
#[ignore = "diagnostic probe, NOT S1 evidence; requires the actual packet, the wiki, maintained IF97 and stock IDA/KLU"]
fn donor_cj_linear_probe() {
    let cpu0 = cpu_s();
    let base = base();
    assert_eq!(base.settle["run5_reproduced"], json!(true));
    let rtol = num(&base.gates, &["relativeTolerance"]);
    let dt = num(&base.gates, &["comparison", "observation_s"]);
    let cutoff = num(&base.budgets, &["uncreditedAbove_Hz"]);
    let window = num(&base.gates, &["seizure", "duration_s"]);
    let supply = num(&base.gates, &["supplyLoss", "duration_s"]);
    let post = num(&base.gates, &["recovery", "postWindow_s"]);
    let hold_s = num(&base.gates, &["hold", "duration_s"]);
    let cap_window = num(&base.gates, &["eventWindow", "maxStep_s"]);
    let tight = STOCK_NEWTON * num(&base.gates, &["eventWindow", "newtonCoefficientFactor"]);
    let colors = colors(&base);
    let dcj = Some(0.1);
    let faces: Vec<usize> = ["UPPER->HOUSING.MAIN", "HOUSING.MAIN->HOUSING.NECK"]
        .iter()
        .map(|id| base.face_ids.iter().position(|f| f == id).unwrap())
        .collect();
    let policies = [
        ("fresh", Refresh::Fresh),
        ("cj_linear", Refresh::CjLinear),
        ("cj_linear_bounded", Refresh::CjLinearBounded),
    ];
    let row = |trace: &Trace, span: f64| json!({"cost":cost(trace, colors, span),"refresh":refresh_json(&trace.refresh),"refresh_window":trace.refresh_window.as_ref().map(refresh_json)});
    let rms = |trace: &Trace, a: f64, b: f64| {
        let x: Vec<f64> = fine_between(trace, a, b)
            .iter()
            .map(|c| c.core_dp_pa)
            .collect();
        high_pass_rms(&x, dt, cutoff)
    };
    // (1) The capped seizure.
    let mut capped = Vec::new();
    for cap in [0.0045, 0.005] {
        for (name, refresh) in policies {
            let t = run(
                &base,
                Event::Seizure,
                Plan {
                    rtol,
                    atol: &base.atol,
                    window_s: window,
                    max_step_s: cap,
                    newton: None,
                    after: After::None,
                    observe_s: Some(dt),
                    dcj,
                    refresh,
                    step_cap: 50_000,
                    cpu_cap_s: 900.,
                },
            );
            let report = cycle_report(&base, &t, &faces);
            capped.push(json!({"max_step_s":cap,"policy":name,"core_dp_5_10_s":report["core_dp_5_10_s"],"newton_error_proxy_5_10_s_wrms":report["newton_error_proxy_5_10_s"]["jacobian_donor"]["mean_wrms"],"run":row(&t, window)}));
        }
    }
    // (2) The established cycle: stock settings to 5 s, resumed at dcj 0.1.
    let mut established = Vec::new();
    for cap in [0.0045, 0.005] {
        for (name, refresh) in policies {
            let t = run(
                &base,
                Event::Seizure,
                Plan {
                    rtol,
                    atol: &base.atol,
                    window_s: 5.,
                    max_step_s: cap,
                    newton: None,
                    after: After::Resume {
                        duration_s: 5.,
                        newton: STOCK_NEWTON,
                        dcj,
                        refresh,
                    },
                    observe_s: Some(dt),
                    dcj: None,
                    refresh: Refresh::Fresh,
                    step_cap: 50_000,
                    cpu_cap_s: 900.,
                },
            );
            let resumed = t.refresh_window.map(|w| RefreshCounts {
                assemblies: t.refresh.assemblies - w.assemblies,
                recombinations: t.refresh.recombinations - w.recombinations,
                identical_state: t.refresh.identical_state - w.identical_state,
                retries: t.refresh.retries - w.retries,
                identical_any: t.refresh.identical_any - w.identical_any,
            });
            established.push(json!({"max_step_s":cap,"policy":name,"core_dp_above_band_rms_pa":{"before_restart_2_5_s":rms(&t, 2., 5.),"after_restart_7_10_s":rms(&t, 7., 10.)},
                "resumed_refresh":resumed.as_ref().map(refresh_json),"resumed_convergence_failures":t.total_convergence_failures-t.window_counts.map_or(0,|c| c[4]),
                "resumed_error_failures":t.total_error_failures-t.window_counts.map_or(0,|c| c[3]),"run":row(&t, 10.)}));
        }
    }
    // (3) The S1 window runs restarted at their ends (the restart ramp).
    let mut ramps = Vec::new();
    for (case, kind, w) in [
        ("rcp_seizure", Event::Seizure, window),
        ("rcp_supply_loss", Event::Supply, supply),
    ] {
        let mut traces = Vec::new();
        for (name, refresh) in policies {
            let t = run(
                &base,
                kind,
                Plan {
                    rtol,
                    atol: &base.atol,
                    window_s: w,
                    max_step_s: cap_window,
                    newton: Some(tight),
                    after: After::Restart(post),
                    observe_s: Some(dt),
                    dcj,
                    refresh,
                    step_cap: 50_000,
                    cpu_cap_s: 900.,
                },
            );
            let cont = |i: usize| match i {
                0 => t.total_steps - t.window_counts.map_or(0, |c| c[0]),
                3 => t.total_error_failures - t.window_counts.map_or(0, |c| c[3]),
                _ => t.total_convergence_failures - t.window_counts.map_or(0, |c| c[4]),
            };
            let resumed = t.refresh_window.map(|w| RefreshCounts {
                assemblies: t.refresh.assemblies - w.assemblies,
                recombinations: t.refresh.recombinations - w.recombinations,
                identical_state: t.refresh.identical_state - w.identical_state,
                retries: t.refresh.retries - w.retries,
                identical_any: t.refresh.identical_any - w.identical_any,
            });
            ramps.push(json!({"case":case,"policy":name,"continuation":{"steps":cont(0),"error_failures":cont(3),"convergence_failures":cont(4),"refresh":resumed.as_ref().map(refresh_json)},
                "window_refresh":t.refresh_window.as_ref().map(refresh_json),"run":row(&t, w + post)}));
            traces.push(t);
        }
        // R1 as declared: the 2.5 ms cap and the window's coefficient, fresh.
        let r1 = run(
            &base,
            kind,
            Plan {
                rtol,
                atol: &base.atol,
                window_s: w,
                max_step_s: num(&base.gates, &["eventReference", "maxStep_s"]),
                newton: Some(tight),
                after: After::None,
                observe_s: Some(dt),
                dcj,
                refresh: Refresh::Fresh,
                step_cap: 50_000,
                cpu_cap_s: 900.,
            },
        );
        let versus: Vec<Value> = policies.iter().zip(&traces).map(|((name, _), t)| json!({"policy":name,"window_versus_r1":compare(&base, t, &r1, w)})).collect();
        ramps.push(json!({"case":case,"r1_steps":r1.total_steps,"contract_versus_r1":versus,
            "raw_difference_from_fresh":policies.iter().zip(&traces).skip(1).map(|((name, _), t)| json!({"policy":name,"window":raw_difference(t, &traces[0], 0., w),"continuation":raw_difference(t, &traces[0], w, w + post)})).collect::<Vec<_>>()}));
    }
    // (4) The hold and the never-capped seizure.
    let mut natural = Vec::new();
    for (case, kind, span) in [
        ("hold", Event::Hold, hold_s),
        ("rcp_seizure_never_capped", Event::Seizure, window + post),
    ] {
        for (name, refresh) in policies {
            let t = run(
                &base,
                kind,
                Plan {
                    rtol,
                    atol: &base.atol,
                    window_s: span,
                    max_step_s: f64::INFINITY,
                    newton: None,
                    after: After::None,
                    observe_s: None,
                    dcj,
                    refresh,
                    step_cap: 50_000,
                    cpu_cap_s: 900.,
                },
            );
            natural.push(json!({"case":case,"policy":name,"run":row(&t, span)}));
        }
    }
    let receipt = json!({"kind":"donor-cj-linear-probe-NOT-EVIDENCE","provenance":provenance(&base),
        "method":"JAC's cj-linear refresh emulated in the probe's IDA wrapper, no kernel change: a fresh setup assembles A = M(cj=0) and A + B = M(cj=1) by the network's colored assembly (two passes here; one assembly in production) and keeps them with the structure and state; a setup called right after an attempt's first residual (stock's first-step or cj-ratio trigger) recombines M = A + cj B from the stored pair with no evaluation; a setup after further residual calls at the same trial time (stock's Newton-failure retry, jbad) and the first setup after a (re)initialization assemble fresh. dcj 0.1 and stock's Newton coefficient everywhere except the H1 window's own tightened coefficient; the fresh policy assembles every setup as stock does. identical-state counts compare the setup's (t, y, y') bitwise with the stored assembly's (cj_linear) or the previous setup's (any policy)",
        "colors":colors,"dcj":0.1,"capped_seizure":capped,"established_cycle":established,"restart_ramps":ramps,"natural":natural,"cpu_s_total":cpu_s()-cpu0,"load_average_end":load_average()});
    write(&base, "donor-cj-linear.json", &receipt);
}

/// JAC's age cap on the bounded cj-linear refresh: assemble also when the
/// stored pair is older than 1 s or 0.25 s, beside fresh and the bounded
/// rule, at dcj 0.1: the never-capped seizure (where the bounded rule still
/// had more failures than fresh), the H1 seizure ramp against R1, the 4.5
/// and 5 ms capped seizure, and the hold.
#[test]
#[ignore = "diagnostic probe, NOT S1 evidence; requires the actual packet, the wiki, maintained IF97 and stock IDA/KLU"]
fn donor_cj_linear_age_probe() {
    let cpu0 = cpu_s();
    let base = base();
    assert_eq!(base.settle["run5_reproduced"], json!(true));
    let rtol = num(&base.gates, &["relativeTolerance"]);
    let dt = num(&base.gates, &["comparison", "observation_s"]);
    let cutoff = num(&base.budgets, &["uncreditedAbove_Hz"]);
    let window = num(&base.gates, &["seizure", "duration_s"]);
    let post = num(&base.gates, &["recovery", "postWindow_s"]);
    let hold_s = num(&base.gates, &["hold", "duration_s"]);
    let cap_window = num(&base.gates, &["eventWindow", "maxStep_s"]);
    let r1_cap = num(&base.gates, &["eventReference", "maxStep_s"]);
    let tight = STOCK_NEWTON * num(&base.gates, &["eventWindow", "newtonCoefficientFactor"]);
    let colors = colors(&base);
    let dcj = Some(0.1);
    let policies = [
        ("fresh", Refresh::Fresh),
        ("cj_linear_bounded", Refresh::CjLinearBounded),
        ("cj_linear_bounded_age_1s", Refresh::CjLinearAged(1.)),
        ("cj_linear_bounded_age_0.25s", Refresh::CjLinearAged(0.25)),
    ];
    let plan = |w: f64,
                cap: f64,
                newton: Option<f64>,
                after: After,
                observe: Option<f64>,
                refresh: Refresh| Plan {
        rtol,
        atol: &base.atol,
        window_s: w,
        max_step_s: cap,
        newton,
        after,
        observe_s: observe,
        dcj,
        refresh,
        step_cap: 50_000,
        cpu_cap_s: 900.,
    };
    let summary = |t: &Trace, span: f64| json!({"cost":cost(t, colors, span),"refresh":refresh_json(&t.refresh)});
    let r1 = run(
        &base,
        Event::Seizure,
        plan(
            window,
            r1_cap,
            Some(tight),
            After::None,
            Some(dt),
            Refresh::Fresh,
        ),
    );
    let mut out = serde_json::Map::new();
    for (name, refresh) in policies {
        let natural = run(
            &base,
            Event::Seizure,
            plan(
                window + post,
                f64::INFINITY,
                None,
                After::None,
                None,
                refresh,
            ),
        );
        let ramp = run(
            &base,
            Event::Seizure,
            plan(
                window,
                cap_window,
                Some(tight),
                After::Restart(post),
                Some(dt),
                refresh,
            ),
        );
        let hold = run(
            &base,
            Event::Hold,
            plan(hold_s, f64::INFINITY, None, After::None, None, refresh),
        );
        let mut capped = serde_json::Map::new();
        for cap in [0.0045, 0.005] {
            let t = run(
                &base,
                Event::Seizure,
                plan(window, cap, None, After::None, Some(dt), refresh),
            );
            let x: Vec<f64> = fine_between(&t, 5., window)
                .iter()
                .map(|c| c.core_dp_pa)
                .collect();
            capped.insert(format!("hmax_{}ms", cap * 1e3), json!({"core_dp_above_band_rms_5_10_s_pa":high_pass_rms(&x, dt, cutoff),"run":summary(&t, window)}));
        }
        let cont = |i: usize| match i {
            0 => ramp.total_steps - ramp.window_counts.map_or(0, |c| c[0]),
            3 => ramp.total_error_failures - ramp.window_counts.map_or(0, |c| c[3]),
            _ => ramp.total_convergence_failures - ramp.window_counts.map_or(0, |c| c[4]),
        };
        out.insert(name.into(), json!({"seizure_never_capped":summary(&natural, window + post),
            "h1_seizure_ramp":{"run":summary(&ramp, window + post),"continuation":{"steps":cont(0),"error_failures":cont(3),"convergence_failures":cont(4)},
                "window_versus_r1":compare(&base, &ramp, &r1, window)},
            "hold":summary(&hold, hold_s),"capped_seizure":capped}));
    }
    let receipt = json!({"kind":"donor-cj-linear-age-probe-NOT-EVIDENCE","provenance":provenance(&base),
        "method":"as donor-cj-linear, adding JAC's age cap to the bounded rule: a setup also assembles when the stored pair's time is more than the given simulated seconds before the setup's",
        "colors":colors,"dcj":0.1,"r1_steps":r1.total_steps,"policies":out,"cpu_s_total":cpu_s()-cpu0,"load_average_end":load_average()});
    write(&base, "donor-cj-linear-age.json", &receipt);
}
