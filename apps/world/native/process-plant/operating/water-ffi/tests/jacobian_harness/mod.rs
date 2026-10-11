//! Shared harness of the Jacobian profile and block-assembly tests on the
//! actual S1 packet: thread CPU clock, stock KLU timings, timed property
//! delegation, the S1 prepared state and a recorded stock-IDA settling run.
//! Measurement support only; nothing here is a production path.
#![allow(dead_code)] // Each test crate uses its own subset.
use leitbild_operating_plant::{
    network::{
        BandReport, MetastableBand, Network, Properties, RotorState, ToleranceClasses, Water,
        consistent_start,
        packet::Packet,
        prepare::{self, OperatingPoint, Settings},
    },
    rotor::{Shaft, SpeedRequest, Support},
    thermal::{Saturation, Scalar},
};
use leitbild_operating_water::{
    CaloricLinearization, If97,
    ida::{Failure, Ida, Initial, Stats, System},
    network::Integrated,
};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    ffi::{c_int, c_void},
    rc::Rc,
};

#[repr(C)]
pub struct Timespec {
    seconds: i64,
    nanoseconds: i64,
}
unsafe extern "C" {
    fn clock_gettime(clock: i32, out: *mut Timespec) -> i32;
    fn pthread_set_qos_class_self_np(class: u32, priority: i32) -> i32;
}
/// QOS_CLASS_USER_INTERACTIVE: asks for a performance core; changes no
/// computation.
pub fn prefer_performance_core() {
    // SAFETY: plain scalar arguments; affects only this thread's scheduling.
    let status = unsafe { pthread_set_qos_class_self_np(0x21, 0) };
    assert_eq!(status, 0, "thread QoS unavailable");
}
/// CLOCK_THREAD_CPUTIME_ID on macOS.
pub const THREAD_CPU_CLOCK: i32 = 16;
pub fn cpu() -> f64 {
    let mut t = Timespec {
        seconds: 0,
        nanoseconds: 0,
    };
    // SAFETY: one live stack Timespec matching the C layout; the C library
    // writes it and keeps no pointer.
    let status = unsafe { clock_gettime(THREAD_CPU_CLOCK, &mut t) };
    assert_eq!(status, 0, "thread CPU clock unavailable");
    t.seconds as f64 + t.nanoseconds as f64 * 1e-9
}
pub fn load_average() -> String {
    std::process::Command::new("sysctl")
        .args(["-n", "vm.loadavg"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .expect("load average")
}
pub fn command(program: &str, args: &[&str]) -> String {
    std::process::Command::new(program)
        .args(args)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|e| panic!("{program}: {e}"))
}
pub fn sha256_file(path: &str) -> String {
    let out = command("shasum", &["-a", "256", path]);
    out.split_whitespace().next().expect("sha256").to_string()
}

// ---------------------------------------------------------------- KLU ----
// The 64-bit KLU structures of SuiteSparse 7.12.3's klu.h, as linked by the
// verified SUNDIALS prefix. Every field is declared for the C layout; only
// the statistics are read.
#[allow(dead_code)]
#[repr(C)]
pub struct KluCommon {
    tol: f64,
    memgrow: f64,
    initmem_amd: f64,
    initmem: f64,
    maxwork: f64,
    btf: c_int,
    ordering: c_int,
    scale: c_int,
    user_order: *mut c_void,
    user_data: *mut c_void,
    halt_if_singular: c_int,
    status: c_int,
    nrealloc: c_int,
    structural_rank: i64,
    numerical_rank: i64,
    singular_col: i64,
    noffdiag: i64,
    flops: f64,
    rcond: f64,
    condest: f64,
    rgrowth: f64,
    work: f64,
    memusage: usize,
    mempeak: usize,
}
#[allow(dead_code)]
#[repr(C)]
pub struct KluSymbolic {
    symmetry: f64,
    est_flops: f64,
    lnz: f64,
    unz: f64,
    block_lnz: *mut f64,
    n: i64,
    nz: i64,
    p: *mut i64,
    q: *mut i64,
    r: *mut i64,
    nzoff: i64,
    nblocks: i64,
    maxblock: i64,
    ordering: i64,
    do_btf: i64,
    structural_rank: i64,
}
#[allow(dead_code)]
#[repr(C)]
pub struct KluNumeric {
    n: i64,
    nblocks: i64,
    lnz: i64,
    unz: i64,
    max_lnz_block: i64,
    max_unz_block: i64,
    pnum: *mut i64,
    pinv: *mut i64,
    lip: *mut i64,
    uip: *mut i64,
    llen: *mut i64,
    ulen: *mut i64,
    lubx: *mut *mut c_void,
    lusize: *mut usize,
    udiag: *mut c_void,
    rs: *mut f64,
    worksize: usize,
    work: *mut c_void,
    xwork: *mut c_void,
    iwork: *mut i64,
    offp: *mut i64,
    offi: *mut i64,
    offx: *mut c_void,
    nzoff: i64,
}
#[link(name = "klu")]
unsafe extern "C" {
    fn klu_l_defaults(common: *mut KluCommon) -> c_int;
    fn klu_l_analyze(
        n: i64,
        ap: *mut i64,
        ai: *mut i64,
        common: *mut KluCommon,
    ) -> *mut KluSymbolic;
    fn klu_l_factor(
        ap: *mut i64,
        ai: *mut i64,
        ax: *mut f64,
        symbolic: *mut KluSymbolic,
        common: *mut KluCommon,
    ) -> *mut KluNumeric;
    fn klu_l_refactor(
        ap: *mut i64,
        ai: *mut i64,
        ax: *mut f64,
        symbolic: *mut KluSymbolic,
        numeric: *mut KluNumeric,
        common: *mut KluCommon,
    ) -> c_int;
    fn klu_l_rcond(
        symbolic: *mut KluSymbolic,
        numeric: *mut KluNumeric,
        common: *mut KluCommon,
    ) -> c_int;
    fn klu_l_flops(
        symbolic: *mut KluSymbolic,
        numeric: *mut KluNumeric,
        common: *mut KluCommon,
    ) -> c_int;
    fn klu_l_solve(
        symbolic: *mut KluSymbolic,
        numeric: *mut KluNumeric,
        ldim: i64,
        nrhs: i64,
        b: *mut f64,
        common: *mut KluCommon,
    ) -> c_int;
    fn klu_l_free_symbolic(symbolic: *mut *mut KluSymbolic, common: *mut KluCommon) -> c_int;
    fn klu_l_free_numeric(numeric: *mut *mut KluNumeric, common: *mut KluCommon) -> c_int;
}

/// KLU timings of one CSC structure over recorded matrices, best of `repeat`.
pub fn klu_profile(pointers: &[i64], rows: &[i64], matrices: &[Vec<f64>], repeat: usize) -> Value {
    let n = pointers.len() as i64 - 1;
    let (mut ap, mut ai) = (pointers.to_vec(), rows.to_vec());
    // SAFETY: KluCommon is a plain C struct that klu_l_defaults fills
    // completely; every pointer handed to KLU below refers to live owned
    // buffers of the declared lengths, retained by KLU only inside the
    // Symbolic/Numeric objects it allocates and that are freed here.
    unsafe {
        let mut common: KluCommon = std::mem::zeroed();
        assert_eq!(klu_l_defaults(&mut common), 1, "klu_l_defaults");
        // SUNLinSol_KLU: SUNKLU_ORDERING_DEFAULT = 1 (COLAMD), else defaults.
        common.ordering = 1;
        let mut analyze = f64::INFINITY;
        let mut symbolic: *mut KluSymbolic = std::ptr::null_mut();
        for _ in 0..repeat {
            if !symbolic.is_null() {
                klu_l_free_symbolic(&mut symbolic, &mut common);
            }
            let started = cpu();
            symbolic = klu_l_analyze(n, ap.as_mut_ptr(), ai.as_mut_ptr(), &mut common);
            analyze = analyze.min(cpu() - started);
            assert!(!symbolic.is_null(), "klu_l_analyze {}", common.status);
        }
        let s = &*symbolic;
        let symbolic_json = json!({"n": s.n, "nz": s.nz, "nblocks": s.nblocks,
            "maxblock": s.maxblock, "nzoff": s.nzoff, "ordering": s.ordering, "do_btf": s.do_btf,
            "structural_rank": s.structural_rank, "estimated_lnz": s.lnz, "estimated_unz": s.unz});
        let mut factor = Vec::new();
        let mut refactor = Vec::new();
        let mut rcond = Vec::new();
        let mut solve = Vec::new();
        let mut factors = Vec::new();
        let mut first = matrices[0].clone();
        let mut numeric: *mut KluNumeric = std::ptr::null_mut();
        let mut best = f64::INFINITY;
        for _ in 0..repeat {
            if !numeric.is_null() {
                klu_l_free_numeric(&mut numeric, &mut common);
            }
            let started = cpu();
            numeric = klu_l_factor(
                ap.as_mut_ptr(),
                ai.as_mut_ptr(),
                first.as_mut_ptr(),
                symbolic,
                &mut common,
            );
            best = best.min(cpu() - started);
            assert!(!numeric.is_null(), "klu_l_factor {}", common.status);
        }
        factor.push(best);
        for matrix in matrices {
            let mut values = matrix.clone();
            // A fresh factorization of this matrix: fill and flops.
            let mut own = klu_l_factor(
                ap.as_mut_ptr(),
                ai.as_mut_ptr(),
                values.as_mut_ptr(),
                symbolic,
                &mut common,
            );
            assert!(!own.is_null(), "klu_l_factor {}", common.status);
            klu_l_flops(symbolic, own, &mut common);
            let o = &*own;
            factors.push(json!({"lnz": o.lnz, "unz": o.unz, "nzoff": o.nzoff,
                "nblocks": o.nblocks, "flops": common.flops,
                "noffdiag": common.noffdiag}));
            klu_l_free_numeric(&mut own, &mut common);
            // SUNDIALS' later setups: klu_l_refactor on the held Numeric, then
            // klu_l_rcond.
            let mut r = f64::INFINITY;
            let mut c = f64::INFINITY;
            for _ in 0..repeat {
                let started = cpu();
                assert_eq!(
                    klu_l_refactor(
                        ap.as_mut_ptr(),
                        ai.as_mut_ptr(),
                        values.as_mut_ptr(),
                        symbolic,
                        numeric,
                        &mut common
                    ),
                    1,
                    "klu_l_refactor {}",
                    common.status
                );
                r = r.min(cpu() - started);
                let started = cpu();
                assert_eq!(klu_l_rcond(symbolic, numeric, &mut common), 1);
                c = c.min(cpu() - started);
            }
            refactor.push(r);
            rcond.push((c, common.rcond));
            let mut x = f64::INFINITY;
            for _ in 0..repeat {
                let mut b = vec![1.; n as usize];
                let started = cpu();
                assert_eq!(
                    klu_l_solve(symbolic, numeric, n, 1, b.as_mut_ptr(), &mut common),
                    1
                );
                x = x.min(cpu() - started);
            }
            solve.push(x);
        }
        klu_l_free_numeric(&mut numeric, &mut common);
        klu_l_free_symbolic(&mut symbolic, &mut common);
        let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
        let max = |v: &[f64]| v.iter().copied().fold(0., f64::max);
        let lu: Vec<f64> = factors
            .iter()
            .map(|f| f["lnz"].as_f64().unwrap() + f["unz"].as_f64().unwrap())
            .collect();
        json!({
            "settings": "klu_l_defaults, ordering 1 (COLAMD), as SUNLinSol_KLU (SUNDIALS 7.5.0)",
            "matrices": matrices.len(),
            "symbolic": symbolic_json,
            "analyze_ms": 1e3 * analyze,
            "factor_ms": 1e3 * factor[0],
            "refactor_ms": {"mean": 1e3 * mean(&refactor), "max": 1e3 * max(&refactor)},
            "rcond_ms": {"mean": 1e3 * mean(&rcond.iter().map(|r| r.0).collect::<Vec<_>>())},
            "rcond": {"min": rcond.iter().map(|r| r.1).fold(f64::INFINITY, f64::min),
                "max": rcond.iter().map(|r| r.1).fold(0., f64::max)},
            "solve_ms": {"mean": 1e3 * mean(&solve), "max": 1e3 * max(&solve)},
            "lnz_plus_unz": {"min": lu.iter().copied().fold(f64::INFINITY, f64::min),
                "max": max(&lu)},
            "nnz_l_plus_u_definition": "Numeric->lnz + Numeric->unz of a fresh klu_l_factor of each matrix (both include the diagonal); Numeric->nzoff, the BTF off-diagonal block entries, is reported beside it",
            "factors": factors,
        })
    }
}

// ---------------------------------------------------------- properties ----
#[derive(Clone, Copy, Debug, Default)]
pub struct Tally {
    pub calls: u64,
    pub cpu: f64,
}
impl Tally {
    pub fn add(&mut self, seconds: f64) {
        self.calls += 1;
        self.cpu += seconds;
    }
    pub fn json(self, per: f64) -> Value {
        json!({"calls_per": self.calls as f64 / per, "ms_per": 1e3 * self.cpu / per,
            "us_per_call": if self.calls == 0 { 0. } else { 1e6 * self.cpu / self.calls as f64 }})
    }
}
#[derive(Default)]
pub struct Ledger {
    pub caloric: Tally,
    pub direction_nonzero: Tally,
    pub direction_zero: Tally,
    pub saturation_value: Tally,
    pub saturation_direction: Tally,
}
pub type Shared = Rc<RefCell<Ledger>>;
/// The property calls of one production assembly.
#[derive(Clone, Copy)]
pub struct Calls {
    pub caloric: Tally,
    pub direction_nonzero: Tally,
    pub direction_zero: Tally,
    pub saturation_value: Tally,
    pub saturation_direction: Tally,
}
/// Delegates every query to the maintained IF97 adapter, unchanged, and
/// times it by kind.
pub struct Timed(pub Shared);
impl Timed {
    fn time<T>(&self, pick: fn(&mut Ledger) -> &mut Tally, f: impl FnOnce() -> T) -> T {
        let started = cpu();
        let result = f();
        let spent = cpu() - started;
        pick(&mut self.0.borrow_mut()).add(spent);
        result
    }
}
impl Properties for Timed {
    type Caloric = CaloricLinearization;
    fn forward(&self, vapor: bool, p: f64, t: f64) -> Result<Water, String> {
        If97.forward(vapor, p, t)
    }
    fn caloric(
        &self,
        vapor: bool,
        p: f64,
        target: f64,
        enthalpy: bool,
    ) -> Result<CaloricLinearization, String> {
        self.time(
            |l| &mut l.caloric,
            || If97.caloric(vapor, p, target, enthalpy),
        )
    }
    fn values(&self, point: &CaloricLinearization) -> Water {
        If97.values(point)
    }
    fn direction(&self, point: &CaloricLinearization, dp: f64, de: f64) -> Result<Water, String> {
        if dp == 0. && de == 0. {
            self.time(|l| &mut l.direction_zero, || If97.direction(point, dp, de))
        } else {
            self.time(
                |l| &mut l.direction_nonzero,
                || If97.direction(point, dp, de),
            )
        }
    }
    fn metastable_band(&self) -> Result<MetastableBand, String> {
        If97.metastable_band()
    }
    fn band(&self, point: &CaloricLinearization) -> BandReport {
        If97.band(point)
    }
    fn saturation(&self, pressure: Scalar) -> Result<Saturation, String> {
        if pressure.direction == 0. {
            self.time(
                |l| &mut l.saturation_value,
                || Properties::saturation(&If97, pressure),
            )
        } else {
            self.time(
                |l| &mut l.saturation_direction,
                || Properties::saturation(&If97, pressure),
            )
        }
    }
}

// ------------------------------------------------------------- harness ----
/// One recorded stage-Jacobian call: (t, cj, y, y').
pub type State = (f64, f64, Vec<f64>, Vec<f64>);
pub type States = Vec<State>;
/// CSC column pointers and row indices.
pub type Structure = (Vec<i64>, Vec<i64>);
/// A prepared network, its y, y', differential ids and absolute tolerances.
pub type Prepared<P> = (Network<P>, Vec<f64>, Vec<f64>, Vec<f64>, Vec<f64>);
/// Records every stage-Jacobian state and matrix of a stock IDA run.
pub struct Recording {
    inner: Integrated<If97>,
    states: Rc<RefCell<States>>,
    matrices: Rc<RefCell<Vec<Vec<f64>>>>,
    structure: Rc<RefCell<Option<Structure>>>,
}
impl System for Recording {
    fn dimension(&self) -> usize {
        self.inner.dimension()
    }
    fn nonzeros(&self) -> usize {
        self.inner.nonzeros()
    }
    fn root_count(&self) -> usize {
        self.inner.root_count()
    }
    fn residual(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        self.inner.residual(t, y, yp, out)
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
        let result = self.inner.jacobian(t, cj, y, yp, data, rows, pointers);
        self.states
            .borrow_mut()
            .push((t, cj, y.to_vec(), yp.to_vec()));
        self.matrices.borrow_mut().push(data.to_vec());
        self.structure
            .borrow_mut()
            .get_or_insert_with(|| (pointers.to_vec(), rows.to_vec()));
        result
    }
    fn roots(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        self.inner.roots(t, y, yp, out)
    }
}

/// The single JSON object inside one fenced strict block of a wiki page.
pub fn strict_block(page: &str, fence: &str) -> Value {
    let text = std::fs::read_to_string(page).unwrap_or_else(|e| panic!("{page}: {e}"));
    let open = format!("```{fence}\n");
    let start = text.find(&open).expect("strict block") + open.len();
    let end = start + text[start..].find("\n```").expect("unterminated block");
    serde_json::from_str(&text[start..end]).expect("strict block JSON")
}

pub struct Declared {
    pub packet_path: String,
    pub packet: Packet,
    pub gates: Value,
}
impl Declared {
    pub fn load() -> Self {
        let packet_path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET").unwrap();
        let wiki = std::env::var("LD01_WIKI_ROOT").unwrap();
        let gates = strict_block(
            &format!(
                "{wiki}/world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md"
            ),
            "ld01-s1-gates",
        );
        let packet = serde_json::from_slice(&std::fs::read(&packet_path).unwrap()).unwrap();
        Self {
            packet_path,
            packet,
            gates,
        }
    }
    pub fn gate(&self, path: &[&str]) -> f64 {
        path.iter()
            .fold(&self.gates, |v, k| &v[*k])
            .as_f64()
            .unwrap_or_else(|| panic!("gate {path:?}"))
    }
    /// The S1 harness's prepared state (RCPs at rest), its absolute
    /// tolerances and differential ids.
    pub fn prepared<P: Properties>(&self, properties: P) -> Prepared<P> {
        let point = OperatingPoint::from(&self.packet.preparation.operating_point);
        let rotors = vec![
            RotorState {
                support: Support::Supported(SpeedRequest::Nominal),
                shaft: Shaft::Free,
            };
            4
        ];
        let settings = Settings {
            pressure_tolerance_pa: 1e-6,
            max_passes: 50,
            level_match_m: 1e-9,
            eos_row_bound: 1e-12,
            tree_face_bound_pa: 1e-6,
            representation_search: 8,
        };
        let (network, prepared, _) =
            prepare::prepare(&self.packet, properties, &point, &rotors, &settings)
                .expect("hydrostatic preparation");
        let mut y0 = prepared.y.clone();
        for index in &network.rotor_index {
            y0[*index] = 0.;
        }
        let atol = network
            .absolute_tolerances(
                &y0,
                ToleranceClasses {
                    relative: self.gate(&["relativeTolerance"]),
                    stock_scaled: self.gate(&["stockScaledAbsolute"]),
                    tracer_scaled: self.gate(&["tracerScaledAbsolute"]),
                    rotor_scaled: self.gate(&["rotorScaledAbsolute"]),
                    volume_flow_m3_s: self.gate(&["volumeFlowAbsolute_m3_s"]),
                },
            )
            .expect("tolerances");
        (network, y0, prepared.yp, prepared.differential, atol)
    }
}

/// The stage-Jacobian assembly a settling run hands to stock IDA.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Assembly {
    Colored,
    Blocks,
}

/// One recorded settling run.
pub struct Settled {
    pub states: States,
    pub matrices: Vec<Vec<f64>>,
    pub structure: Structure,
    /// Per output: time and stock counters.
    pub marks: Value,
    /// Per output: the returned y.
    pub outputs: Vec<Vec<f64>>,
    pub absolute_tolerance: Vec<f64>,
    pub relative_tolerance: f64,
    pub stats: Stats,
    /// Thread CPU of the IDA calls (initialization and advances).
    pub cpu_s: f64,
}

/// The S1 settling start with the declared order, constraints, stop boundary
/// and IDACalcIC horizon, advanced to each of `outputs` with `assembly`;
/// records every Jacobian state and matrix.
pub fn settle(declared: &Declared, outputs: &[f64], assembly: Assembly) -> Settled {
    let (network, y0, yp0, ids, atol) = declared.prepared(If97);
    let stocks = network.nonnegative_stocks();
    let states = Rc::new(RefCell::new(Vec::new()));
    let matrices = Rc::new(RefCell::new(Vec::new()));
    let structure = Rc::new(RefCell::new(None));
    let inner = match assembly {
        Assembly::Colored => Integrated::colored(network).expect("colored assembly"),
        Assembly::Blocks => Integrated::blocks(network).expect("block assembly"),
    };
    let system = Recording {
        inner,
        states: states.clone(),
        matrices: matrices.clone(),
        structure: structure.clone(),
    };
    let rtol = declared.gate(&["relativeTolerance"]);
    let (mut y, mut yp) = (y0.clone(), yp0.clone());
    let mut ida = Ida::new(
        system,
        Initial {
            time: 0.,
            y: &y0,
            yp: &yp0,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: rtol,
        },
    )
    .expect("stock IDA construction");
    ida.set_max_order(declared.gate(&["maxOrder"]) as usize)
        .expect("max order");
    ida.constrain_nonnegative(&stocks).expect("nonnegative");
    ida.stop_at(declared.gate(&["settling", "maxSimulated_s"]))
        .expect("stop");
    let started = cpu();
    ida.initialize(1., &mut y, &mut yp).expect("IDACalcIC");
    let mut marks = Vec::new();
    let mut returned = Vec::new();
    for &t in outputs {
        let reached = ida.advance(t, &mut y, &mut yp).expect("advance");
        let stats = ida.stats().expect("stats");
        marks.push(
            json!({"t": reached.reached().expect("no roots"), "steps": stats.steps,
            "residuals": stats.residuals, "jacobians": stats.jacobians,
            "nonlinear_iterations": stats.nonlinear_iterations,
            "convergence_failures": stats.convergence_failures,
            "error_failures": stats.error_failures,
            "linear_setups": stats.linear_setups, "last_step_s": stats.last_step,
            "order": stats.last_order}),
        );
        returned.push(y.clone());
    }
    let cpu_s = cpu() - started;
    let stats = ida.stats().expect("stats");
    drop(ida);
    let states = Rc::try_unwrap(states).ok().unwrap().into_inner();
    let matrices = Rc::try_unwrap(matrices).ok().unwrap().into_inner();
    let structure = Rc::try_unwrap(structure)
        .ok()
        .unwrap()
        .into_inner()
        .unwrap();
    Settled {
        states,
        matrices,
        structure,
        marks: json!(marks),
        outputs: returned,
        absolute_tolerance: atol,
        relative_tolerance: rtol,
        stats,
        cpu_s,
    }
}

/// An S1 event applied at the settled state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    /// The declared rotor's ideal seizure transaction (its row turns algebraic).
    Seizure,
    /// The declared rotor's drive supply withdrawn, shaft free.
    SupplyLoss,
}

/// From a settled state: apply `event`, solve the exact consistent start
/// (S1's restart, no IDACalcIC) and advance stock IDA with `assembly` to
/// `duration` in steps of `interval`, recording every Jacobian.
pub fn event(
    declared: &Declared,
    settled: &[f64],
    event: Event,
    assembly: Assembly,
    duration: f64,
    interval: f64,
) -> Settled {
    let (mut network, _, _, ids, atol) = declared.prepared(If97);
    let stocks = network.nonnegative_stocks();
    let rtol = declared.gate(&["relativeTolerance"]);
    let mut y = settled.to_vec();
    let ids = match event {
        Event::Seizure => {
            let rotor = declared.gate(&["seizure", "rotor"]) as usize;
            network.seize(rotor, &mut y).expect("seizure");
            network.differential(&ids)
        }
        Event::SupplyLoss => {
            let rotor = declared.gate(&["supplyLoss", "rotor"]) as usize;
            network.set_rotor_state(
                rotor,
                RotorState {
                    support: Support::Unsupported,
                    shaft: Shaft::Free,
                },
            );
            ids
        }
    };
    let weights: Vec<f64> = y
        .iter()
        .zip(&atol)
        .map(|(v, a)| 1. / (rtol * v.abs() + a))
        .collect();
    let (yp, _) = consistent_start(&mut network, 0., &mut y, &ids, &weights, 1e-12, 2)
        .expect("exact consistent start");
    let states = Rc::new(RefCell::new(Vec::new()));
    let matrices = Rc::new(RefCell::new(Vec::new()));
    let structure = Rc::new(RefCell::new(None));
    let inner = match assembly {
        Assembly::Colored => Integrated::colored(network).expect("colored assembly"),
        Assembly::Blocks => Integrated::blocks(network).expect("block assembly"),
    };
    let system = Recording {
        inner,
        states: states.clone(),
        matrices: matrices.clone(),
        structure: structure.clone(),
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
    .expect("stock IDA construction");
    ida.set_max_order(declared.gate(&["maxOrder"]) as usize)
        .expect("max order");
    ida.constrain_nonnegative(&stocks).expect("nonnegative");
    ida.stop_at(duration).expect("stop");
    let (mut y, mut yp) = (y.clone(), yp.clone());
    let started = cpu();
    let mut marks = Vec::new();
    let mut returned = Vec::new();
    let steps = (duration / interval).round() as usize;
    for k in 1..=steps {
        let t = duration * k as f64 / steps as f64;
        let reached = ida.advance(t, &mut y, &mut yp).expect("advance");
        let stats = ida.stats().expect("stats");
        marks.push(
            json!({"t": reached.reached().expect("no roots"), "steps": stats.steps,
            "jacobians": stats.jacobians, "nonlinear_iterations": stats.nonlinear_iterations,
            "convergence_failures": stats.convergence_failures}),
        );
        returned.push(y.clone());
    }
    let cpu_s = cpu() - started;
    let stats = ida.stats().expect("stats");
    drop(ida);
    Settled {
        states: Rc::try_unwrap(states).ok().unwrap().into_inner(),
        matrices: Rc::try_unwrap(matrices).ok().unwrap().into_inner(),
        structure: Rc::try_unwrap(structure)
            .ok()
            .unwrap()
            .into_inner()
            .unwrap(),
        marks: json!(marks),
        outputs: returned,
        absolute_tolerance: atol,
        relative_tolerance: rtol,
        stats,
        cpu_s,
    }
}

/// Writes a new receipt; never overwrites one.
pub fn write_receipt(path: &str, receipt: &Value) {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .unwrap_or_else(|e| panic!("receipt {path} must be new: {e}"));
    file.write_all(serde_json::to_string_pretty(receipt).unwrap().as_bytes())
        .unwrap();
    file.write_all(b"\n").unwrap();
}
