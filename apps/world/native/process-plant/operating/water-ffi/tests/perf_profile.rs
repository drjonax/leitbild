//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#cost-premise-risk-not-a-decision
//! Property-cost profile of the S1 network residual. A measurement only,
//! NOT S1 evidence and not a production path: the declared S1 settling start
//! is advanced one simulated second; every residual callback's `(t, y, y')`
//! is recorded and then replayed value-only on freshly prepared networks.
//! One network times whole residuals in thread CPU; a second, through a
//! delegating wrapper, records every property query by kind with its inputs
//! and wall time. The recorded inputs are then re-timed in isolation, and
//! the caloric inverse's Newton iterates are counted on an oracle that
//! restates its iteration on the public forward point (checked bit for bit
//! against the production inverse, so its count is the production count).
#![cfg(all(feature = "ida", target_os = "macos"))]
use leitbild_operating_plant::{
    network::{
        BandReport, MetastableBand, Network, Properties, RotorState, ToleranceClasses, Water,
        packet::Packet,
        prepare::{self, OperatingPoint, Settings},
    },
    rotor::{Shaft, SpeedRequest, Support},
    thermal::{Saturation, Scalar},
};
use leitbild_operating_water::{
    Branch, CaloricLinearization, Error, If97, WaterPoint,
    ida::{Failure, Ida, Initial, System},
    network::Integrated,
    point,
};
use serde_json::{Value, json};
use std::{cell::RefCell, hint::black_box, rc::Rc, time::Instant};

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
fn cpu() -> f64 {
    let mut t = Timespec {
        seconds: 0,
        nanoseconds: 0,
    };
    // SAFETY: one live stack Timespec matching the C layout; the C library
    // writes it and keeps no pointer.
    let status = unsafe { clock_gettime(16, &mut t) };
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
fn git(args: &[&str]) -> String {
    std::process::Command::new("git")
        .args(args)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .expect("git provenance")
}
const WATER_BUILD: &str = include_str!(concat!(
    env!("LD01_OPERATING_WATER_LIB_DIR"),
    "/water-build.json"
));

/// Kinds of property query, as the network boundary issues them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
enum Kind {
    Forward { vapor: bool },
    Inverse { vapor: bool, enthalpy: bool },
    Direction { vapor: bool },
    Saturation { directional: bool },
}
impl Kind {
    fn name(self) -> String {
        let phase = |v: bool| if v { "vapor" } else { "liquid" };
        match self {
            Self::Forward { vapor } => format!("forward_{}", phase(vapor)),
            Self::Inverse { vapor, enthalpy } => {
                format!("{}_{}", if enthalpy { "ph" } else { "pu" }, phase(vapor))
            }
            Self::Direction { vapor } => format!("caloric_direction_{}", phase(vapor)),
            Self::Saturation { directional } => {
                format!(
                    "saturation_{}",
                    if directional { "direction" } else { "value" }
                )
            }
        }
    }
}
#[derive(Clone, Copy, Debug)]
struct Query {
    kind: Kind,
    pressure: f64,
    /// Specific target, temperature or pressure direction, by kind.
    argument: f64,
    seconds: f64,
}
#[derive(Default)]
struct Ledger {
    recording: bool,
    queries: Vec<Query>,
}
type Shared = Rc<RefCell<Ledger>>;

/// Delegates every query to the maintained IF97 adapter, unchanged.
struct Probe(Shared);
impl Probe {
    fn time<T>(&self, kind: Kind, pressure: f64, argument: f64, f: impl FnOnce() -> T) -> T {
        let started = Instant::now();
        let result = f();
        let seconds = started.elapsed().as_secs_f64();
        let mut ledger = self.0.borrow_mut();
        if ledger.recording {
            ledger.queries.push(Query {
                kind,
                pressure,
                argument,
                seconds,
            });
        }
        result
    }
}
/// The caloric point with its branch, so that its direction can be keyed.
#[derive(Clone, Copy, Debug)]
struct Held {
    vapor: bool,
    point: CaloricLinearization,
}
impl Properties for Probe {
    type Caloric = Held;
    fn forward(&self, vapor: bool, p: f64, t: f64) -> Result<Water, String> {
        self.time(Kind::Forward { vapor }, p, t, || If97.forward(vapor, p, t))
    }
    fn caloric(&self, vapor: bool, p: f64, target: f64, enthalpy: bool) -> Result<Held, String> {
        self.time(Kind::Inverse { vapor, enthalpy }, p, target, || {
            If97.caloric(vapor, p, target, enthalpy)
                .map(|point| Held { vapor, point })
        })
    }
    fn values(&self, point: &Held) -> Water {
        If97.values(&point.point)
    }
    fn direction(&self, point: &Held, dp: f64, de: f64) -> Result<Water, String> {
        let p = If97.values(&point.point).pressure_pa;
        self.time(Kind::Direction { vapor: point.vapor }, p, dp, || {
            If97.direction(&point.point, dp, de)
        })
    }
    fn saturation(&self, pressure: Scalar) -> Result<Saturation, String> {
        let directional = pressure.direction != 0.;
        self.time(
            Kind::Saturation { directional },
            pressure.value,
            pressure.direction,
            || Properties::saturation(&If97, pressure),
        )
    }
    fn metastable_band(&self) -> Result<MetastableBand, String> {
        If97.metastable_band()
    }
    fn band(&self, point: &Held) -> BandReport {
        If97.band(&point.point)
    }
}

/// Records every residual callback's state; delegates unchanged.
struct Recorder<P: Properties> {
    inner: Integrated<P>,
    residuals: Vec<(f64, Vec<f64>, Vec<f64>)>,
    jacobians: Vec<(f64, f64, Vec<f64>, Vec<f64>)>,
}
impl<P: Properties> System for Recorder<P> {
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
        self.residuals.push((t, y.to_vec(), yp.to_vec()));
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
        self.jacobians.push((t, cj, y.to_vec(), yp.to_vec()));
        self.inner.jacobian(t, cj, y, yp, data, rows, pointers)
    }
    fn roots(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        self.inner.roots(t, y, yp, out)
    }
}

fn strict_block(page: &str, fence: &str) -> Value {
    let text = std::fs::read_to_string(page).unwrap_or_else(|e| panic!("{page}: {e}"));
    let open = format!("```{fence}\n");
    let start = text.find(&open).expect("strict block") + open.len();
    let end = start + text[start..].find("\n```").expect("unterminated block");
    serde_json::from_str(&text[start..end]).expect("strict block JSON")
}

/// Network, initial y and y', differential ids and absolute tolerances.
type Prepared<P> = (Network<P>, Vec<f64>, Vec<f64>, Vec<f64>, Vec<f64>);
struct Declared {
    packet: Packet,
    packet_path: String,
    gates: Value,
    wiki: String,
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
            packet,
            packet_path,
            gates,
            wiki,
        }
    }
    fn gate(&self, path: &[&str]) -> f64 {
        path.iter()
            .fold(&self.gates, |v, k| &v[*k])
            .as_f64()
            .unwrap_or_else(|| panic!("gate {path:?}"))
    }
    /// The S1 harness's prepared state (RCPs at rest), tolerances and ids.
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

type States = (
    Vec<(f64, Vec<f64>, Vec<f64>)>,
    Vec<(f64, f64, Vec<f64>, Vec<f64>)>,
    i64,
    Vec<f64>,
);
/// The S1 settling run's first simulated second; every callback state.
fn settle(declared: &Declared) -> States {
    let (network, y0, yp0, ids, atol) = declared.prepared(If97);
    let stocks = network.nonnegative_stocks();
    let system = Recorder {
        inner: Integrated::colored(network).expect("colored assembly"),
        residuals: Vec::new(),
        jacobians: Vec::new(),
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
    ida.advance(1., &mut y, &mut yp).expect("advance");
    let steps = ida.stats().expect("stats").steps;
    let system = ida.system();
    (system.residuals.clone(), system.jacobians.clone(), steps, y)
}

fn quantile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let position = q * (sorted.len() - 1) as f64;
    let (low, high) = (position.floor() as usize, position.ceil() as usize);
    sorted[low] + (sorted[high] - sorted[low]) * (position - low as f64)
}
fn summary(mut values: Vec<f64>, scale: f64) -> Value {
    values.sort_by(f64::total_cmp);
    let n = values.len();
    let mean = values.iter().sum::<f64>() / n.max(1) as f64;
    json!({"n": n, "median": scale * quantile(&values, 0.5), "p95": scale * quantile(&values, 0.95),
        "min": scale * values.first().copied().unwrap_or(f64::NAN),
        "max": scale * values.last().copied().unwrap_or(f64::NAN), "mean": scale * mean})
}

/// The production inverse's iteration restated on the public forward point
/// (the identity oracle of `thermo_identity.rs`), counting caloric states:
/// both bracket ends, every Newton iterate, then the one full point.
fn iterations(
    branch: Branch,
    p: f64,
    target: f64,
    enthalpy: bool,
) -> Result<(WaterPoint, usize), Error> {
    let value = |q: WaterPoint| {
        if enthalpy {
            q.enthalpy_j_kg
        } else {
            q.internal_energy_j_kg
        }
    };
    let partial = |q: WaterPoint| {
        if enthalpy {
            q.cp_j_kg_k
        } else {
            q.cp_j_kg_k - q.pressure_pa * q.expansion_per_k / q.density_kg_m3
        }
    };
    let (mut low, mut high) = match branch {
        Branch::Liquid => (
            point(branch, p, 273.15)?,
            point(Branch::SaturatedLiquid, p, 0.)?,
        ),
        _ => (
            point(Branch::SaturatedVapor, p, 0.)?,
            point(branch, p, 1073.15)?,
        ),
    };
    if !(value(low) < target && target < value(high)) {
        // Endpoint or metastable targets: not on the oracle's stable path.
        return Err(Error::Domain);
    }
    let mut t = low.temperature_k
        + (high.temperature_k - low.temperature_k) * (target - value(low))
            / (value(high) - value(low));
    for k in 0..64 {
        let q = point(branch, p, t)?;
        let defect = value(q) - target;
        let ut = partial(q);
        if defect.abs() <= 2e-12 * target.abs().max(ut * q.temperature_k).max(1.) {
            return Ok((q, k + 1));
        }
        if defect < 0. {
            low = q;
        } else {
            high = q;
        }
        let proposed = t - defect / ut;
        t = if proposed > low.temperature_k && proposed < high.temperature_k {
            proposed
        } else {
            (low.temperature_k + high.temperature_k) / 2.
        };
    }
    Err(Error::NativeFailure)
}
fn bits(q: &WaterPoint) -> [u64; 12] {
    [
        q.pressure_pa.to_bits(),
        q.temperature_k.to_bits(),
        q.density_kg_m3.to_bits(),
        q.internal_energy_j_kg.to_bits(),
        q.enthalpy_j_kg.to_bits(),
        q.cp_j_kg_k.to_bits(),
        q.cv_j_kg_k.to_bits(),
        q.expansion_per_k.to_bits(),
        q.compressibility_per_pa.to_bits(),
        q.viscosity_pa_s.to_bits(),
        q.conductivity_w_m_k.to_bits(),
        q.saturation_slope_k_pa.to_bits(),
    ]
}

/// Re-time one recorded query in isolation: the best of `repeats` wall times.
fn isolated(q: &Query, repeats: usize) -> f64 {
    let mut best = f64::INFINITY;
    for _ in 0..repeats {
        let started = Instant::now();
        match q.kind {
            Kind::Forward { vapor } => {
                black_box(
                    If97.forward(vapor, black_box(q.pressure), black_box(q.argument))
                        .ok(),
                );
            }
            Kind::Inverse { vapor, enthalpy } => {
                black_box(
                    If97.caloric(
                        vapor,
                        black_box(q.pressure),
                        black_box(q.argument),
                        enthalpy,
                    )
                    .ok(),
                );
            }
            Kind::Saturation { .. } => {
                black_box(
                    Properties::saturation(&If97, Scalar::new(black_box(q.pressure), q.argument))
                        .ok(),
                );
            }
            // Directions need their held point; timed in situ only.
            Kind::Direction { .. } => return f64::NAN,
        }
        best = best.min(started.elapsed().as_secs_f64());
    }
    best
}

#[test]
#[ignore = "requires the S1 packet, the wiki gates, maintained IF97 and stock IDA/KLU; cost report only"]
fn s1_network_residual_property_profile() {
    prefer_performance_core();
    let load_start = load_average();
    let declared = Declared::load();
    let (residual_states, jacobian_states, steps, _) = settle(&declared);

    // Whole value-only residuals in thread CPU, best of `repeats` per state,
    // on a network that sees the plain maintained adapter.
    let (mut plain, ..) = declared.prepared(If97);
    let repeats = 5;
    let mut residual_cpu = Vec::with_capacity(residual_states.len());
    let mut digest = 0xcbf2_9ce4_8422_2325u64;
    for (t, y, yp) in &residual_states {
        let mut best = f64::INFINITY;
        for _ in 0..repeats {
            let started = cpu();
            plain
                .evaluate(*t, y, yp, None, 0., None)
                .expect("replayed residual");
            best = best.min(cpu() - started);
        }
        residual_cpu.push(best);
        for r in plain.rows() {
            for byte in r.value.to_bits().to_le_bytes() {
                digest = (digest ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3);
            }
        }
    }
    // The same residuals through the delegating probe: every query in situ.
    let ledger: Shared = Rc::default();
    let (mut probed, ..) = declared.prepared(Probe(ledger.clone()));
    let mut per_residual: Vec<std::collections::BTreeMap<Kind, (usize, f64)>> = Vec::new();
    let mut queries: Vec<Query> = Vec::new();
    for (t, y, yp) in &residual_states {
        ledger.borrow_mut().recording = true;
        probed
            .evaluate(*t, y, yp, None, 0., None)
            .expect("probed residual");
        let mut ledger = ledger.borrow_mut();
        ledger.recording = false;
        let mut tally = std::collections::BTreeMap::new();
        for q in ledger.queries.drain(..) {
            let entry = tally.entry(q.kind).or_insert((0, 0.));
            entry.0 += 1;
            entry.1 += q.seconds;
            queries.push(q);
        }
        per_residual.push(tally);
    }
    let kinds: std::collections::BTreeSet<Kind> = queries.iter().map(|q| q.kind).collect();
    let mut by_kind = serde_json::Map::new();
    for kind in &kinds {
        let selected: Vec<&Query> = queries.iter().filter(|q| q.kind == *kind).collect();
        let counts: Vec<f64> = per_residual
            .iter()
            .map(|t| t.get(kind).map_or(0., |c| c.0 as f64))
            .collect();
        let in_situ: Vec<f64> = selected.iter().map(|q| q.seconds).collect();
        let alone: Vec<f64> = selected
            .iter()
            .map(|q| isolated(q, 5))
            .filter(|v| v.is_finite())
            .collect();
        let pressures: Vec<f64> = selected.iter().map(|q| q.pressure).collect();
        by_kind.insert(
            kind.name(),
            json!({"per_residual": summary(counts, 1.), "in_situ_us": summary(in_situ, 1e6),
                "isolated_best_of_5_us": summary(alone, 1e6), "pressure_pa": summary(pressures, 1.)}),
        );
    }
    // Iterations and component costs of the recorded caloric inverses.
    let mut newton = Vec::new();
    let mut checked = 0;
    let mut forward_us = Vec::new();
    for q in queries.iter() {
        let Kind::Inverse { vapor, enthalpy } = q.kind else {
            continue;
        };
        let branch = if vapor { Branch::Vapor } else { Branch::Liquid };
        if let Ok((oracle, count)) = iterations(branch, q.pressure, q.argument, enthalpy) {
            let production = If97
                .caloric(vapor, q.pressure, q.argument, enthalpy)
                .map(|c| c.point())
                .expect("production inverse");
            assert_eq!(bits(&oracle), bits(&production), "oracle iteration differs");
            checked += 1;
            newton.push(count as f64);
            let mut best = f64::INFINITY;
            for _ in 0..5 {
                let started = Instant::now();
                black_box(
                    point(
                        branch,
                        black_box(q.pressure),
                        black_box(oracle.temperature_k),
                    )
                    .ok(),
                );
                best = best.min(started.elapsed().as_secs_f64());
            }
            forward_us.push(best);
        }
    }
    // Residual CPU attributed: in-situ query wall time per residual.
    let property_share: Vec<f64> = per_residual
        .iter()
        .zip(&residual_cpu)
        .map(|(t, cpu)| t.values().map(|c| c.1).sum::<f64>() / cpu)
        .collect();
    let property_seconds: Vec<f64> = per_residual
        .iter()
        .map(|t| t.values().map(|c| c.1).sum::<f64>())
        .collect();
    // The colored Jacobians at their recorded states, production assembly.
    let structure = plain.sparse_jacobian().expect("structure");
    let mut values = vec![0.; structure.pattern.nonzeros()];
    let mut jacobian_cpu = Vec::new();
    let mut jacobian_digest = 0xcbf2_9ce4_8422_2325u64;
    for (t, cj, y, yp) in &jacobian_states {
        let mut best = f64::INFINITY;
        for _ in 0..3 {
            let started = cpu();
            plain
                .jacobian_colored(*t, *cj, y, yp, &structure, &mut values)
                .expect("colored Jacobian");
            best = best.min(cpu() - started);
        }
        jacobian_cpu.push(best);
        for v in &values {
            for byte in v.to_bits().to_le_bytes() {
                jacobian_digest =
                    (jacobian_digest ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3);
            }
        }
    }
    let water: Value = serde_json::from_str(WATER_BUILD).unwrap();
    let receipt = json!({
        "kind": "perf-s1-network-residual-property-profile-NOT-EVIDENCE",
        "clock": {"residual": "CLOCK_THREAD_CPUTIME_ID, best of 5 per state",
            "queries": "wall (mach_absolute_time) per query; isolated re-times best of 5"},
        "packet": declared.packet_path,
        "wiki": declared.wiki,
        "app_commit": git(&["rev-parse", "HEAD"]),
        "app_worktree_dirty": !git(&["status", "--porcelain"]).is_empty(),
        "water_build": water,
        "load_average_start": load_start,
        "load_average_end": load_average(),
        "segment": "S1 settling start, RCPs at rest, declared order/tolerances, t = 0..1 s",
        "steps": steps,
        "unknowns": plain.dimension(),
        "residual_states": residual_states.len(),
        "residual_value_digest": format!("{digest:016x}"),
        "residual_cpu_us": summary(residual_cpu.clone(), 1e6),
        "property_wall_us_per_residual": summary(property_seconds, 1e6),
        "property_share_of_residual": summary(property_share, 1.),
        "queries": by_kind,
        "caloric_inverse": {"checked_against_oracle": checked,
            "newton_iterates": summary(newton, 1.),
            "caloric_states_per_inverse": "2 bracket ends + Newton iterates, then one full forward point",
            "full_forward_point_at_root_us": summary(forward_us, 1e6)},
        "jacobian": {"states": jacobian_states.len(), "colors": structure.coloring.count(),
            "cpu_ms": summary(jacobian_cpu, 1e3), "digest": format!("{jacobian_digest:016x}")},
    });
    let text = serde_json::to_string_pretty(&receipt).unwrap();
    println!("{text}");
    if let Ok(path) = std::env::var("LD01_PERF_RECEIPT") {
        assert!(
            !std::path::Path::new(&path).exists(),
            "{path} exists; receipts are never overwritten"
        );
        std::fs::write(&path, text + "\n").unwrap();
    }
}
