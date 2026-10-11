//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#6-solver-properties-and-cost-obligations
//! Jacobian cost profile on the actual S1 packet, in thread CPU time. A
//! measurement only, NOT S1 or S2 evidence: the S1 prepared state is advanced
//! with the declared configuration and the colored assembly, every stage
//! Jacobian state and matrix is recorded, and the recorded calls are
//! replayed: the colored assembly split into its base evaluation, seeded
//! passes, property directions and scatter; and stock KLU's symbolic
//! analysis, factorization, refactorization, condition estimate and solve on
//! the recorded matrices with SUNDIALS 7.5.0's settings (KLU defaults,
//! COLAMD ordering). Nothing here is a production path.
#![cfg(all(feature = "ida", target_os = "macos"))]
use leitbild_operating_plant::{
    network::{
        BandReport, MetastableBand, Network, Properties, RotorState, SparseJacobian,
        ToleranceClasses, Water,
        packet::Packet,
        prepare::{self, OperatingPoint, Settings},
    },
    rotor::{Shaft, SpeedRequest, Support},
    sparse,
    thermal::{Saturation, Scalar},
};
use leitbild_operating_water::{
    CaloricLinearization, If97,
    ida::{Failure, Ida, Initial, System},
    network::Integrated,
};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    ffi::{c_int, c_void},
    rc::Rc,
};

#[repr(C)]
struct Timespec {
    seconds: i64,
    nanoseconds: i64,
}
unsafe extern "C" {
    fn clock_gettime(clock: i32, out: *mut Timespec) -> i32;
    fn pthread_set_qos_class_self_np(class: u32, priority: i32) -> i32;
}
/// QOS_CLASS_USER_INTERACTIVE: asks for a performance core; changes no
/// computation.
fn prefer_performance_core() {
    // SAFETY: plain scalar arguments; affects only this thread's scheduling.
    let status = unsafe { pthread_set_qos_class_self_np(0x21, 0) };
    assert_eq!(status, 0, "thread QoS unavailable");
}
/// CLOCK_THREAD_CPUTIME_ID on macOS.
const THREAD_CPU_CLOCK: i32 = 16;
fn cpu() -> f64 {
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
fn load_average() -> String {
    std::process::Command::new("sysctl")
        .args(["-n", "vm.loadavg"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .expect("load average")
}
fn command(program: &str, args: &[&str]) -> String {
    std::process::Command::new(program)
        .args(args)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|e| panic!("{program}: {e}"))
}
fn sha256_file(path: &str) -> String {
    let out = command("shasum", &["-a", "256", path]);
    out.split_whitespace().next().expect("sha256").to_string()
}

// ---------------------------------------------------------------- KLU ----
// The 64-bit KLU structures of SuiteSparse 7.12.3's klu.h, as linked by the
// verified SUNDIALS prefix. Every field is declared for the C layout; only
// the statistics are read.
#[allow(dead_code)]
#[repr(C)]
struct KluCommon {
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
struct KluSymbolic {
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
struct KluNumeric {
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
fn klu_profile(pointers: &[i64], rows: &[i64], matrices: &[Vec<f64>], repeat: usize) -> Value {
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
struct Tally {
    calls: u64,
    cpu: f64,
}
impl Tally {
    fn add(&mut self, seconds: f64) {
        self.calls += 1;
        self.cpu += seconds;
    }
    fn json(self, per: f64) -> Value {
        json!({"calls_per": self.calls as f64 / per, "ms_per": 1e3 * self.cpu / per,
            "us_per_call": if self.calls == 0 { 0. } else { 1e6 * self.cpu / self.calls as f64 }})
    }
}
#[derive(Default)]
struct Ledger {
    caloric: Tally,
    direction_nonzero: Tally,
    direction_zero: Tally,
    saturation_value: Tally,
    saturation_direction: Tally,
}
type Shared = Rc<RefCell<Ledger>>;
/// The property calls of one production assembly.
#[derive(Clone, Copy)]
struct Calls {
    caloric: Tally,
    direction_nonzero: Tally,
    direction_zero: Tally,
    saturation_value: Tally,
    saturation_direction: Tally,
}
/// Delegates every query to the maintained IF97 adapter, unchanged, and
/// times it by kind.
struct Timed(Shared);
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
type State = (f64, f64, Vec<f64>, Vec<f64>);
type States = Vec<State>;
/// CSC column pointers and row indices.
type Structure = (Vec<i64>, Vec<i64>);
/// A prepared network, its y, y', differential ids and absolute tolerances.
type Prepared<P> = (Network<P>, Vec<f64>, Vec<f64>, Vec<f64>, Vec<f64>);
/// Records every stage-Jacobian state and matrix of a stock IDA run.
struct Recording {
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
fn strict_block(page: &str, fence: &str) -> Value {
    let text = std::fs::read_to_string(page).unwrap_or_else(|e| panic!("{page}: {e}"));
    let open = format!("```{fence}\n");
    let start = text.find(&open).expect("strict block") + open.len();
    let end = start + text[start..].find("\n```").expect("unterminated block");
    serde_json::from_str(&text[start..end]).expect("strict block JSON")
}

struct Declared {
    packet_path: String,
    packet: Packet,
    gates: Value,
}
impl Declared {
    fn load() -> Self {
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
    fn gate(&self, path: &[&str]) -> f64 {
        path.iter()
            .fold(&self.gates, |v, k| &v[*k])
            .as_f64()
            .unwrap_or_else(|| panic!("gate {path:?}"))
    }
    /// The S1 harness's prepared state (RCPs at rest), its absolute
    /// tolerances and differential ids.
    fn prepared<P: Properties>(&self, properties: P) -> Prepared<P> {
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

/// The S1 settling start with the declared order, constraints, stop boundary
/// and IDACalcIC horizon, advanced to each of `outputs`; records every
/// Jacobian state and matrix.
fn settle(declared: &Declared, outputs: &[f64]) -> (States, Vec<Vec<f64>>, Structure, Value) {
    let (network, y0, yp0, ids, atol) = declared.prepared(If97);
    let stocks = network.nonnegative_stocks();
    let states = Rc::new(RefCell::new(Vec::new()));
    let matrices = Rc::new(RefCell::new(Vec::new()));
    let structure = Rc::new(RefCell::new(None));
    let system = Recording {
        inner: Integrated::colored(network).expect("colored assembly"),
        states: states.clone(),
        matrices: matrices.clone(),
        structure: structure.clone(),
    };
    let (mut y, mut yp) = (y0.clone(), yp0.clone());
    let mut ida = Ida::new(
        system,
        Initial {
            time: 0.,
            y: &y0,
            yp: &yp0,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: declared.gate(&["relativeTolerance"]),
        },
    )
    .expect("stock IDA construction");
    ida.set_max_order(declared.gate(&["maxOrder"]) as usize)
        .expect("max order");
    ida.constrain_nonnegative(&stocks).expect("nonnegative");
    ida.stop_at(declared.gate(&["settling", "maxSimulated_s"]))
        .expect("stop");
    ida.initialize(1., &mut y, &mut yp).expect("IDACalcIC");
    let mut marks = Vec::new();
    for &t in outputs {
        let reached = ida.advance(t, &mut y, &mut yp).expect("advance");
        let stats = ida.stats().expect("stats");
        marks.push(
            json!({"t": reached.reached().expect("no roots"), "steps": stats.steps,
            "residuals": stats.residuals, "jacobians": stats.jacobians,
            "nonlinear_iterations": stats.nonlinear_iterations,
            "linear_setups": stats.linear_setups, "last_step_s": stats.last_step,
            "order": stats.last_order}),
        );
    }
    drop(ida);
    let states = Rc::try_unwrap(states).ok().unwrap().into_inner();
    let matrices = Rc::try_unwrap(matrices).ok().unwrap().into_inner();
    let structure = Rc::try_unwrap(structure)
        .ok()
        .unwrap()
        .into_inner()
        .unwrap();
    (states, matrices, structure, json!(marks))
}

/// One colored assembly, replayed in its parts on a timed network.
#[derive(Default, Clone, Copy)]
struct Split {
    production: f64,
    base: f64,
    passes: f64,
    scatter: f64,
    zero_seed_pass: f64,
    value_residual: f64,
    value_residual_warm: f64,
}

fn replay(
    network: &mut Network<Timed>,
    structure: &SparseJacobian,
    (t, cj, y, yp): &State,
    reference: &[f64],
) -> Split {
    let mut split = Split::default();
    let mut production = vec![0.; structure.pattern.nonzeros()];
    let started = cpu();
    network
        .jacobian_colored(*t, *cj, y, yp, structure, &mut production)
        .expect("production colored Jacobian");
    split.production = cpu() - started;
    assert_eq!(
        production.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
        reference.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
        "replayed colored assembly differs from the recorded IDA matrix"
    );
    let mut values = vec![0.; production.len()];
    let mut reuse = network.reuse();
    let started = cpu();
    network
        .evaluate(*t, y, yp, None, 0., Some(&mut reuse))
        .expect("base evaluation");
    split.base = cpu() - started;
    let signs = network.column_signs(y);
    let n = y.len();
    let (mut seed, mut directions) = (vec![0.; n], vec![0.; n]);
    for color in 0..structure.coloring.count() {
        let started = cpu();
        structure
            .coloring
            .seed_into(color, &signs, &mut seed)
            .unwrap();
        network
            .evaluate(*t, y, yp, Some(&seed), *cj, Some(&mut reuse))
            .expect("seeded pass");
        split.passes += cpu() - started;
        for (d, r) in directions.iter_mut().zip(network.rows()) {
            *d = r.direction;
        }
        let started = cpu();
        sparse::scatter(
            &structure.pattern,
            &structure.coloring,
            color,
            &directions,
            &signs,
            &mut values,
        )
        .expect("scatter");
        split.scatter += cpu() - started;
    }
    assert_eq!(
        values.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
        production.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
    );
    // One pass with an all-zero seed on the warm reuse: the arithmetic of a
    // seeded pass with no property direction to evaluate.
    let zero = vec![0.; n];
    let started = cpu();
    network
        .evaluate(*t, y, yp, Some(&zero), *cj, Some(&mut reuse))
        .expect("zero-seed pass");
    split.zero_seed_pass = cpu() - started;
    let started = cpu();
    network
        .evaluate(*t, y, yp, None, 0., None)
        .expect("value residual");
    split.value_residual = cpu() - started;
    let started = cpu();
    network
        .evaluate(*t, y, yp, None, 0., Some(&mut reuse))
        .expect("warm value residual");
    split.value_residual_warm = cpu() - started;
    split
}

/// Writes a new receipt; never overwrites one.
fn write_receipt(path: &str, receipt: &Value) {
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

#[test]
#[ignore = "requires the S1 packet, the wiki gates, maintained IF97 and stock IDA/KLU; cost profile only"]
fn jacobian_profile_s1() {
    prefer_performance_core();
    let declared = Declared::load();
    let load_start = load_average();
    let commit = command("git", &["rev-parse", "HEAD"]);
    let dirty = !command("git", &["status", "--porcelain"]).is_empty();
    // The settling start's first second (its start transient), then on to
    // the declared settling's rest time.
    let outputs = [0.25, 0.5, 1., 2., 5., 10., 20., 46.];
    let (states, matrices, (pointers, rows), marks) = settle(&declared, &outputs);
    let shared: Shared = Rc::default();
    let (mut network, ..) = declared.prepared(Timed(shared.clone()));
    let structure = network.sparse_jacobian().expect("structure");
    let (p64, r64) = structure.pattern.to_i64().unwrap();
    assert_eq!((&p64, &r64), (&pointers, &rows), "recorded structure");

    // Replay every recorded call three times; keep each part's minimum.
    let mut best: Vec<Split> = Vec::new();
    let mut ledgers = Vec::new();
    for (state, matrix) in states.iter().zip(&matrices) {
        let mut parts: Vec<Split> = Vec::new();
        for _ in 0..3 {
            *shared.borrow_mut() = Ledger::default();
            parts.push(replay(&mut network, &structure, state, matrix));
        }
        let min = |f: fn(&Split) -> f64| parts.iter().map(f).fold(f64::INFINITY, f64::min);
        best.push(Split {
            production: min(|s| s.production),
            base: min(|s| s.base),
            passes: min(|s| s.passes),
            scatter: min(|s| s.scatter),
            zero_seed_pass: min(|s| s.zero_seed_pass),
            value_residual: min(|s| s.value_residual),
            value_residual_warm: min(|s| s.value_residual_warm),
        });
        // Property calls of one production assembly at this state.
        *shared.borrow_mut() = Ledger::default();
        let mut v = vec![0.; structure.pattern.nonzeros()];
        let (t, cj, y, yp) = state;
        network
            .jacobian_colored(*t, *cj, y, yp, &structure, &mut v)
            .unwrap();
        let l = shared.borrow();
        ledgers.push(Calls {
            caloric: l.caloric,
            direction_nonzero: l.direction_nonzero,
            direction_zero: l.direction_zero,
            saturation_value: l.saturation_value,
            saturation_direction: l.saturation_direction,
        });
    }
    let calls = states.len() as f64;
    let sum = |f: fn(&Split) -> f64| best.iter().map(f).sum::<f64>() / calls;
    let tally = |pick: fn(&Calls) -> Tally| {
        ledgers
            .iter()
            .map(pick)
            .fold(Tally::default(), |a, b| Tally {
                calls: a.calls + b.calls,
                cpu: a.cpu + b.cpu,
            })
    };
    let colors = structure.coloring.count();
    let klu = klu_profile(&pointers, &rows, &matrices, 5);
    let receipt = json!({
        "kind": "jacobian-profile-s1-NOT-EVIDENCE",
        "team": "JAC",
        "clock": "CLOCK_THREAD_CPUTIME_ID, QOS_CLASS_USER_INTERACTIVE, best of 3 replays per recorded call",
        "app_commit": commit, "app_dirty": dirty,
        "packet": declared.packet_path, "packet_sha256": sha256_file(&declared.packet_path),
        "water_build": serde_json::from_str::<Value>(include_str!(concat!(env!("LD01_OPERATING_WATER_LIB_DIR"), "/water-build.json"))).unwrap(),
        "sundials_prefix": env!("LD01_OPERATING_SUNDIALS_PREFIX"),
        "load_average_start": load_start,
        "run": {"configuration": "S1 settling start: prepared state, RCPs from rest, declared rtol/atol classes, max order, nonnegative stocks, IDACalcIC", "outputs": marks},
        "structure": {"columns": structure.pattern.columns(), "nonzeros": structure.pattern.nonzeros(),
            "colors": colors},
        "colored_jacobian_per_call": {
            "calls": states.len(),
            "residual_evaluations_per_call": colors + 1,
            "production_ms": 1e3 * sum(|s| s.production),
            "base_evaluation_ms": 1e3 * sum(|s| s.base),
            "seeded_passes_ms": 1e3 * sum(|s| s.passes),
            "per_seeded_pass_ms": 1e3 * sum(|s| s.passes) / colors as f64,
            "zero_seed_pass_ms": 1e3 * sum(|s| s.zero_seed_pass),
            "scatter_ms": 1e3 * sum(|s| s.scatter),
            "properties": {
                "caloric_inversions": tally(|l| l.caloric).json(calls),
                "nonzero_directions": tally(|l| l.direction_nonzero).json(calls),
                "zero_directions": tally(|l| l.direction_zero).json(calls),
                "saturation_values": tally(|l| l.saturation_value).json(calls),
                "saturation_directions": tally(|l| l.saturation_direction).json(calls),
            },
        },
        "residual_ms": {"value_only_fresh": 1e3 * sum(|s| s.value_residual),
            "value_only_with_warm_matrix_reuse": 1e3 * sum(|s| s.value_residual_warm)},
        "klu": klu,
        "load_average_end": load_average(),
    });
    let text = serde_json::to_string(&receipt).unwrap();
    println!("{text}");
    if let Ok(path) = std::env::var("LD01_JAC_RECEIPT") {
        write_receipt(&path, &receipt);
    }
}
