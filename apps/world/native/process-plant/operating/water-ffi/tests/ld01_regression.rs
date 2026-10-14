//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-spine-at-power
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#exact-consistent-start-of-the-joined-residual
//! LD-01 regression tiers (resume plan P6), NOT evidence and no gate:
//!
//! - `smoke` (tier a, `scripts/ld01-smoke.sh`): on the cached packet named
//!   by its hash and the cached water and SUNDIALS builds, one process runs
//!   the census, Z1 (the composed hot reference and its exact consistent
//!   start), the block-Jacobian oracle on random columns against exact
//!   seeded columns, a short settle from the started state, and the release
//!   restart (turbine trip, holding opening, exact restart) from the settled
//!   state. Its integer counts (steps, residuals, Jacobians, passes,
//!   transactions) and pass/fail flags are compared with the committed
//!   expectation of this platform, `tests/ld01_regression/smoke-<os>-<arch>.json`;
//!   a mismatch prints the differing paths and fails. Changing an
//!   expectation needs the lead's written reason.
//!
//! - `settled_state` (tier b): the pinned settled consistent pair
//!   (`tests/ld01_regression/settled-state.json` names its gzip file beside
//!   it by sha256 and its packet by hash; `y` and `y'` are stored as exact
//!   f64 bits). The residual is evaluated there:
//!   every scaled row must be at most 1e-10, and on the pinned platform the
//!   rows' exact bits must give the pinned digest. Every credited rate of the
//!   S2 settling block (revision 7, per 20 s) is checked against its
//!   threshold; a pin marked provisional names the thresholds it misses and
//!   the test requires exactly those, so a change either way is reported.
//!   `settled_state_pin` makes a pin from a settled state: the exact
//!   consistent start at the settled `y` (stock KLU projection and rate
//!   solve), written compressed with its packet hash to a new file.
//!
//! Single-threaded; nothing is written unless `LD01_SMOKE_RECORD` or
//! `LD01_SETTLED_STATE_OUT` names a new file.
#![cfg(feature = "ida")]
#[path = "common/cpu.rs"]
mod cpu;
#[path = "ld01_regression/wiki.rs"]
mod wiki;

use leitbild_operating_plant::{
    initialization::SurfacePolicy,
    joined::{
        self,
        block::Command,
        blocks::{Classes, JoinedJacobian, jacobian_blocks},
        census,
        nuclear::Nuclear,
        operator::{Joined, RodPort, SecondaryPort},
        packet,
        solids::Solids,
    },
    network::{
        Network, PzrPreparation, RotorState, ToleranceClasses, consistent_start as network_start,
        packet::Packet as NetworkPacket,
        prepare::{self, OperatingPoint, Settings},
    },
    rods::{RodBlock, Section as RodSection},
    rotor::{Shaft, SpeedRequest, Support},
    sg::{packet::Section as SecondarySection, secondary::Secondaries},
};
use leitbild_operating_water::{
    If97,
    ida::{Advance, Ida, Initial},
    joined::{
        Analyses, Discrete, Integrated, Matrices, Restart, consistent_start, discrete_restart,
    },
    network::Integrated as NetworkIntegrated,
};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

// ------------------------------------------------- declared configuration

/// The S1 harness's declared PZR preparation controls (s1_hydraulics.rs).
const PZR: PzrPreparation = PzrPreparation {
    pressure_tolerance_pa: 1e-6,
    max_passes: 50,
};
/// The S1 harness's hydrostatic preparation settings (s1_hydraulics.rs).
const SETTINGS: Settings = Settings {
    pressure_tolerance_pa: 1e-6,
    max_passes: 50,
    level_match_m: 1e-9,
    eos_row_bound: 1e-12,
    tree_face_bound_pa: 1e-6,
    representation_search: 8,
};
/// S2's numerical configuration at every start and restart (claude/ld01-wiki
/// c968921; G13), as the settling probe and the restart check use it.
const NEWTON_COEFFICIENT: f64 = 0.33;
const DELTA_CJ_LSETUP: f64 = 0.1;
const FIRST_STEP_S: f64 = 1e-4;
const ADVANCE_CHUNK_S: f64 = 0.01;
/// The exact consistent start's bound (Z1 and restarts).
const START_BOUND: f64 = 1e-12;

fn rotors() -> Vec<RotorState> {
    vec![
        RotorState {
            support: Support::Supported(SpeedRequest::Nominal),
            shaft: Shaft::Free,
        };
        4
    ]
}

// ----------------------------------------------------------------- inputs

fn sha256(bytes: &[u8]) -> String {
    use std::io::Write;
    use std::process::{Command as Process, Stdio};
    // `shasum` on macOS, coreutils `sha256sum` on Linux.
    let run = |program: &str, args: &[&str]| {
        let mut child = Process::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .ok()?;
        child.stdin.take()?.write_all(bytes).ok()?;
        let out = child.wait_with_output().ok()?;
        out.status.success().then(|| {
            String::from_utf8_lossy(&out.stdout)
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_string()
        })
    };
    run("shasum", &["-a", "256"])
        .or_else(|| run("sha256sum", &[]))
        .expect("shasum or sha256sum")
}

fn packet_bytes() -> (String, Vec<u8>) {
    let path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET")
        .expect("LD01_OPERATING_HOT_SPINE_PACKET names the compiled spine packet");
    let bytes = std::fs::read(&path).expect("packet");
    (path, bytes)
}

/// The `ld01-s1-gates` block of the wiki named by `LD01_WIKI_ROOT`.
fn s1_gates() -> Value {
    serde_json::from_str(&s1_gates_text()).unwrap()
}
fn s1_gates_text() -> String {
    let wiki = std::env::var("LD01_WIKI_ROOT").expect("LD01_WIKI_ROOT");
    let page = format!(
        "{wiki}/world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md"
    );
    let text = std::fs::read_to_string(&page).expect("build-readiness.md");
    let open = "```ld01-s1-gates\n";
    let start = text.find(open).expect("ld01-s1-gates") + open.len();
    let end = start + text[start..].find("\n```").unwrap();
    text[start..end].to_string()
}
fn classes(gates: &Value) -> ToleranceClasses {
    let f = |k: &str| gates[k].as_f64().unwrap_or_else(|| panic!("gate {k}"));
    ToleranceClasses {
        relative: f("relativeTolerance"),
        stock_scaled: f("stockScaledAbsolute"),
        tracer_scaled: f("tracerScaledAbsolute"),
        rotor_scaled: f("rotorScaledAbsolute"),
        volume_flow_m3_s: f("volumeFlowAbsolute_m3_s"),
    }
}

/// The deterministic identity of the water and SUNDIALS builds in use.
fn environment(packet_sha256: &str) -> Value {
    let water =
        std::env::var("LD01_OPERATING_WATER_LIB_DIR").expect("LD01_OPERATING_WATER_LIB_DIR");
    let receipt: Value = serde_json::from_slice(
        &std::fs::read(Path::new(&water).join("water-build.json")).expect("water-build.json"),
    )
    .expect("water-build.json shape");
    let prefix =
        std::env::var("LD01_OPERATING_SUNDIALS_PREFIX").expect("LD01_OPERATING_SUNDIALS_PREFIX");
    let config =
        std::fs::read_to_string(Path::new(&prefix).join("include/sundials/sundials_config.h"))
            .unwrap_or_default();
    let version = config
        .lines()
        .find(|l| {
            l.starts_with("#define SUNDIALS_VERSION ")
                || l.starts_with("#define SUNDIALS_VERSION\t")
        })
        .and_then(|l| l.split('"').nth(1))
        .unwrap_or("unknown")
        .to_string();
    json!({
        "packet_sha256": packet_sha256,
        "s1_gates_sha256": sha256(s1_gates_text().as_bytes()),
        "if97_revision": receipt["revision"],
        "water_adapter_sha256": receipt["adapterSha256"],
        "metastable_page_sha256": receipt["metastableBand"]["pageSha256"],
        "sundials_version": version,
    })
}

// ------------------------------------------------------------- composition

/// S1's declared network-only settling from rest, run only to export the
/// settled flows (memo §3 (A)); as `joined_spine.rs`.
fn s1_settled_flows(packet: &NetworkPacket, gates: &Value) -> (Vec<f64>, Vec<f64>, Value) {
    let point = OperatingPoint::from(&packet.preparation.operating_point);
    let (network, prepared, _) =
        prepare::prepare(packet, If97, &point, &rotors(), &SETTINGS).expect("hydrostatic");
    let mut y = prepared.y.clone();
    for i in &network.rotor_index {
        y[*i] = 0.;
    }
    let classes = classes(gates);
    let atol = network.absolute_tolerances(&y, classes).unwrap();
    let rtol = classes.relative;
    let ids = prepared.differential.clone();
    let weights: Vec<f64> = y
        .iter()
        .zip(&atol)
        .map(|(v, a)| 1. / (rtol * v.abs() + a))
        .collect();
    let mut probe = network;
    let (yp, _) = network_start(&mut probe, 0., &mut y, &ids, &weights, 1e-12, 2)
        .expect("S1 exact consistent start");
    let nonnegative = probe.nonnegative_stocks();
    let mut ida = Ida::new(
        NetworkIntegrated::colored(probe).unwrap(),
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: rtol,
        },
    )
    .unwrap();
    ida.set_max_order(gates["maxOrder"].as_u64().unwrap() as usize)
        .unwrap();
    ida.constrain_nonnegative(&nonnegative).unwrap();
    let settling = &gates["settling"];
    let cap = settling["maxSimulated_s"].as_f64().unwrap();
    let window = settling["window_s"].as_f64().unwrap();
    let rotor_rel = settling["rotorSpeedRelative"].as_f64().unwrap();
    let flow_rel = settling["loopFlowRelativeChange"].as_f64().unwrap();
    ida.stop_at(cap).unwrap();
    let face = |id: &str| {
        packet
            .mechanics
            .faces
            .iter()
            .position(|f| f.id == id)
            .unwrap()
    };
    let loops = [face("RETURN.A->DOWN"), face("RETURN.B->DOWN")];
    let (mut yv, mut ypv) = (y.clone(), yp.clone());
    let mut history: Vec<(f64, [f64; 2])> = Vec::new();
    let mut t = 0.;
    let settled_at = loop {
        t += 1.;
        ida.advance(t, &mut yv, &mut ypv)
            .unwrap()
            .reached()
            .unwrap();
        let net = &mut ida.system_mut().network;
        net.evaluate(t, &yv, &ypv, None, 0., None).unwrap();
        let flows = loops.map(|f| net.chart(f, 0).unwrap().mass_flow_kg_s.value);
        let omega: Vec<f64> = net
            .rotor_index
            .iter()
            .map(|i| yv[*i] * net.scales()[*i] / net.rotor_inertia())
            .collect();
        let w0 = net.drive().reference_omega_rad_s;
        history.push((t, flows));
        let earlier = history.iter().rev().find(|h| h.0 <= t - window);
        let rested = earlier.is_some_and(|e| {
            omega.iter().all(|w| ((w - w0) / w0).abs() < rotor_rel)
                && (0..2).all(|k| ((flows[k] - e.1[k]) / flows[k]).abs() < flow_rel)
        });
        if rested {
            break Some(t);
        }
        if t >= cap {
            break None;
        }
    };
    let stats = ida.stats().unwrap();
    let net = &mut ida.system_mut().network;
    net.evaluate(t, &yv, &ypv, None, 0., None).unwrap();
    let flows: Vec<f64> = (0..net.face_count())
        .map(|f| net.chart(f, 0).map_or(0., |c| c.volume_flow_m3_s.value))
        .collect();
    let momenta: Vec<f64> = net
        .rotor_index
        .iter()
        .map(|i| yv[*i] * net.scales()[*i])
        .collect();
    let counts = json!({
        "settled": settled_at.is_some(),
        "steps": stats.steps, "residuals": stats.residuals, "jacobians": stats.jacobians,
        "error_failures": stats.error_failures, "convergence_failures": stats.convergence_failures,
    });
    assert!(settled_at.is_some(), "S1 settling did not rest: {counts}");
    (flows, momenta, counts)
}

/// The full composition at the hot reference before its consistent start
/// (memo §3 (A)-(C)): S1-settled flows transferred by the flowing
/// preparation, the SG secondary and rod owners, prepared owners and
/// initialized surfaces.
struct Composed {
    joined: Joined<If97>,
    y: Vec<f64>,
    ids: Vec<f64>,
    network_ids: Vec<f64>,
    atol: Vec<f64>,
    rtol: f64,
    counts: Value,
}
fn composed(bytes: &[u8], gates: &Value) -> Composed {
    let network_packet: NetworkPacket = serde_json::from_slice(bytes).expect("network packet");
    let joined_packet: packet::Packet = serde_json::from_slice(bytes).expect("joined packet");
    let raw: Value = serde_json::from_slice(bytes).expect("packet json");
    let (flows, momenta, s1) = s1_settled_flows(&network_packet, gates);
    let point = OperatingPoint::from(&network_packet.preparation.operating_point);
    let (mut network, mut prepared, hydrostatic) =
        prepare::prepare(&network_packet, If97, &point, &rotors(), &SETTINGS).expect("hydrostatic");
    prepare::compose_flows(
        &mut network,
        &network_packet,
        &mut prepared.y,
        hydrostatic.port_pressure_pa,
        &flows,
        &momenta,
        &SETTINGS,
    )
    .expect("flowing preparation");
    let network_ids = prepared.differential.clone();
    let section: SecondarySection =
        serde_json::from_value(raw["secondary"].clone()).expect("secondary section");
    let rods: RodSection = serde_json::from_value(raw["rods"].clone()).expect("rods section");
    let mut joined = Joined::new(
        network,
        &network_packet,
        &joined_packet,
        If97,
        SecondaryPort::Owner(Box::new(
            Secondaries::new(&section, &joined_packet.thermal.secondaries, &If97)
                .expect("SG secondary owner"),
        )),
        RodPort::Owner(Box::new(
            RodBlock::from_packet(&rods, &network_packet).expect("rod owner"),
        )),
    )
    .expect("joined operator");
    let mut y = joined.prepared(&prepared.y).unwrap();
    let ids = joined.differential(&network_ids);
    let owners = joined
        .prepare_owners(0., &mut y)
        .expect("owner preparation");
    let surfaces = joined
        .initialize_surfaces(
            0.,
            &mut y,
            SurfacePolicy {
                maximum_residual_w: 1e-3,
                maximum_correction_k: 1e-6,
                maximum_iterations: 16,
                maximum_backtracks: 12,
            },
        )
        .expect("surfaces");
    let classes = classes(gates);
    let n_net = joined.offsets().nuclear;
    let mut atol = joined
        .network
        .absolute_tolerances(&y[..n_net], classes)
        .unwrap();
    // G12: S1's scaled absolute floor for every new coordinate class.
    atol.resize(y.len(), classes.stock_scaled);
    let counts = json!({
        "s1_settling": s1,
        "dimension": y.len(),
        "algebraic": ids.iter().filter(|v| **v == 0.).count(),
        "owner_transactions": owners.len(),
        "surface_sets": surfaces.len(),
        "surface_max_iterations": surfaces.iter().map(|s| s.iterations).max(),
    });
    Composed {
        joined,
        y,
        ids,
        network_ids,
        atol,
        rtol: classes.relative,
        counts,
    }
}
fn weights(y: &[f64], atol: &[f64], rtol: f64) -> Vec<f64> {
    y.iter()
        .zip(atol)
        .map(|(v, a)| 1. / (rtol * v.abs() + a))
        .collect()
}

// ------------------------------------------------------------ expectations

fn platform() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}
fn expectation_path(kind: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/ld01_regression")
        .join(format!("{kind}-{}.json", platform()))
}
/// `path = value` for every leaf of `v`.
fn flatten(prefix: &str, v: &Value, out: &mut Map<String, Value>) {
    match v {
        Value::Object(m) => {
            for (k, x) in m {
                flatten(
                    &format!("{prefix}{}{k}", if prefix.is_empty() { "" } else { "." }),
                    x,
                    out,
                );
            }
        }
        _ => {
            out.insert(prefix.to_string(), v.clone());
        }
    }
}
/// The differing leaves of `expected` and `actual`, as `-`/`+` lines.
fn diff(expected: &Value, actual: &Value) -> Vec<String> {
    let (mut e, mut a) = (Map::new(), Map::new());
    flatten("", expected, &mut e);
    flatten("", actual, &mut a);
    let keys: std::collections::BTreeSet<&String> = e.keys().chain(a.keys()).collect();
    let mut lines = Vec::new();
    for k in keys {
        match (e.get(k), a.get(k)) {
            (Some(x), Some(y)) if x == y => {}
            (x, y) => {
                if let Some(x) = x {
                    lines.push(format!("- {k} = {x}"));
                }
                if let Some(y) = y {
                    lines.push(format!("+ {k} = {y}"));
                }
            }
        }
    }
    lines
}
fn record(kind: &str, actual: &Value) {
    if let Some(path) = std::env::var_os("LD01_SMOKE_RECORD") {
        let path = Path::new(&path);
        assert!(!path.exists(), "never overwritten: {}", path.display());
        std::fs::write(path, serde_json::to_vec_pretty(actual).unwrap()).unwrap();
        eprintln!("{kind}: actual counts recorded at {}", path.display());
    }
}
fn compare(kind: &str, actual: &Value) {
    record(kind, actual);
    let path = expectation_path(kind);
    let expected: Value = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).expect("expectation shape"),
        Err(_) => panic!(
            "no committed {kind} expectation for {}: {} (record one with LD01_SMOKE_RECORD and commit it with the lead's reason)",
            platform(),
            path.display()
        ),
    };
    let lines = diff(&expected, actual);
    assert!(
        lines.is_empty(),
        "{kind} differs from {}:\n{}",
        path.display(),
        lines.join("\n")
    );
}

// --------------------------------------------------------------- the smoke

/// Seeded column `j` of `dF/dy + cj dF/dy'` against the block assembly's
/// column, relative to the seeded column's largest entry.
fn oracle(
    joined: &mut Joined<If97>,
    y: &[f64],
    yp: &[f64],
    columns: usize,
    seed: u64,
) -> (Value, Value) {
    let n = y.len();
    let cj = 20.;
    let structure = JoinedJacobian::compile(joined, 0., y).expect("block compile");
    let pattern = &structure.pattern;
    let mut values = vec![0.; pattern.nonzeros()];
    jacobian_blocks(joined, &structure, 0., cj, y, yp, &mut values, Classes::ALL)
        .expect("block assembly");
    let mut state = seed;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state % n as u64) as usize
    };
    let picked: std::collections::BTreeSet<usize> = (0..columns).map(|_| next()).collect();
    let (mut worst, mut outside) = (0_f64, 0usize);
    let mut direction = vec![0.; n];
    for &j in &picked {
        direction.fill(0.);
        direction[j] = 1.;
        joined
            .evaluate(0., y, yp, Some(&direction), cj, None)
            .expect("seeded column");
        let exact: Vec<f64> = joined.rows().iter().map(|r| r.direction).collect();
        let scale = exact.iter().fold(0_f64, |m, v| m.max(v.abs())).max(1e-300);
        let mut assembled = vec![0.; n];
        for q in pattern.pointers()[j]..pattern.pointers()[j + 1] {
            assembled[pattern.indices()[q]] = values[q];
        }
        for (i, (e, b)) in exact.iter().zip(&assembled).enumerate() {
            if *e != 0. && pattern.position(i, j).is_none() {
                outside += 1;
            }
            worst = worst.max((e - b).abs() / scale);
        }
    }
    (
        json!({"columns": picked.len(), "outside_pattern": outside, "within_1e-9": worst <= 1e-9}),
        json!({"worst_column_relative": worst, "pattern_nonzeros": pattern.nonzeros()}),
    )
}

#[test]
#[ignore = "LD-01 smoke (scripts/ld01-smoke.sh): requires the joined packet, the wiki, IF97 and stock IDA/KLU"]
fn smoke() {
    let started = cpu::process_cpu_s();
    let load_start = cpu::load_average();
    let mut phase_cpu = Map::new();
    let mut lap = {
        let mut last = started;
        move |name: &str, phases: &mut Map<String, Value>| {
            let now = cpu::process_cpu_s();
            phases.insert(name.into(), json!(now - last));
            last = now;
        }
    };
    let expected: Value = std::fs::read(expectation_path("smoke"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    let settle_s = expected["settle_s"].as_f64().unwrap_or(1.);
    let columns = expected["oracle_columns"].as_u64().unwrap_or(200) as usize;
    let (path, bytes) = packet_bytes();
    let packet_sha256 = sha256(&bytes);
    let environment = environment(&packet_sha256);
    if let Some(want) = expected["environment"]["packet_sha256"].as_str() {
        assert_eq!(
            packet_sha256, want,
            "the smoke's cached packet is named by its hash: {path} is not {want}"
        );
    }
    let gates = s1_gates();
    let wiki_root = std::env::var("LD01_WIKI_ROOT").expect("LD01_WIKI_ROOT");
    let wiki = wiki::provenance(Path::new(&wiki_root)).expect("wiki provenance");

    // Census against memo Table 1.1.
    let census = {
        let network_packet: NetworkPacket = serde_json::from_slice(&bytes).expect("network packet");
        let joined_packet: packet::Packet = serde_json::from_slice(&bytes).expect("joined packet");
        let (network, prepared) = Network::new(&network_packet, If97, &PZR).expect("network");
        let cells = network.cell_layout.len();
        let nuclear = Nuclear::new(&joined_packet, cells).expect("nuclear block");
        let solids = Solids::new(&joined_packet, cells).expect("solids block");
        let network_layout = joined::network_layout(&network);
        let k_ids = nuclear.layout().ids();
        let s_ids = solids.layout().ids();
        let c = census::census(
            &[
                census::Composed {
                    owner: "network",
                    layout: &network_layout,
                    differential: &prepared.differential,
                },
                census::Composed {
                    owner: "nuclear",
                    layout: nuclear.layout(),
                    differential: &k_ids,
                },
                census::Composed {
                    owner: "solids",
                    layout: solids.layout(),
                    differential: &s_ids,
                },
            ],
            &[joined::pending_secondary(), joined::pending_rods()],
        );
        json!({"composed": c.composed, "with_pending": c.with_pending, "histories": nuclear.histories().len()})
    };
    lap("census", &mut phase_cpu);

    // Z1: the composed hot reference and its exact consistent start.
    let Composed {
        mut joined,
        mut y,
        ids,
        network_ids,
        atol,
        rtol,
        counts: composition,
    } = composed(&bytes, &gates);
    lap("composition", &mut phase_cpu);
    let start_weights = weights(&y, &atol, rtol);
    // The start's own matrices: the block assembly with cached analyses
    // (lead decision S2-D4).
    let structure = JoinedJacobian::compile(&mut joined, 0., &y).expect("block structure");
    let mut analyses = Analyses::default();
    let (yp, start) = consistent_start(
        &mut joined,
        Matrices::Blocks {
            structure: &structure,
            analyses: &mut analyses,
        },
        0.,
        &mut y,
        &ids,
        &start_weights,
        START_BOUND,
        3,
    )
    .expect("exact consistent start");
    let z1 = json!({
        "projection_passes": start.projection_passes, "rate_passes": start.rate_passes,
        "residual_within_bound": start.residual.value <= START_BOUND,
        "constraint_rate_within_bound": start.constraint_rate.value <= START_BOUND,
    });
    let z1_info = json!({"residual": start.residual.value, "constraint_rate": start.constraint_rate.value, "correction_wrms": start.correction_wrms});
    lap("z1_consistent_start", &mut phase_cpu);

    // The block Jacobian against exact seeded columns.
    let (oracle_counts, oracle_info) = oracle(&mut joined, &y, &yp, columns, 0x9e37_79b9_7f4a_7c15);
    lap("oracle", &mut phase_cpu);

    // A short settle from the started state, as the settling probe.
    let nonnegative = joined.network.nonnegative_stocks();
    let evaluations_before = joined.counters;
    let mut ida = Ida::new(
        Integrated::with_blocks(joined, 0., &y).expect("block-assembled joined system"),
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: rtol,
        },
    )
    .expect("stock IDA");
    ida.set_max_order(2).unwrap();
    ida.constrain_nonnegative(&nonnegative).unwrap();
    let restart = Restart {
        newton_coefficient: NEWTON_COEFFICIENT,
        delta_cj_lsetup: DELTA_CJ_LSETUP,
        first_step_s: FIRST_STEP_S,
        start_bound: START_BOUND,
        start_passes: 2,
        bound_placement: 1e-12,
    };
    restart.configure(&mut ida).unwrap();
    ida.stop_at(settle_s).unwrap();
    let (mut ys, mut yps) = (y.clone(), yp.clone());
    let mut t = 0.;
    let mut failure = Value::Null;
    while t < settle_s {
        let target = (t + ADVANCE_CHUNK_S).min(settle_s);
        match ida.advance(target, &mut ys, &mut yps) {
            Ok(Advance::Reached(time)) => t = time,
            Ok(Advance::Root { time, directions }) => {
                failure = json!(format!("a root at {time} s: {directions:?}"));
                break;
            }
            Err(e) => {
                failure = json!(e);
                break;
            }
        }
    }
    let st = ida.stats().unwrap();
    let c = ida.system().joined.counters;
    let settle = json!({
        "reached": t >= settle_s, "failure": failure,
        "steps": st.steps, "residuals": st.residuals, "jacobians": st.jacobians,
        "nonlinear_iterations": st.nonlinear_iterations, "linear_setups": st.linear_setups,
        "error_failures": st.error_failures, "convergence_failures": st.convergence_failures,
        "last_order": st.last_order,
        "system_residuals": c.residuals - evaluations_before.residuals,
        "system_jacobians": c.jacobians - evaluations_before.jacobians,
    });
    let settle_info = json!({"reached_s": t, "last_step_s": st.last_step});
    lap("settle", &mut phase_cpu);

    // The release restart from the settled state: the manual turbine trip,
    // then the holding opening at its stop, restarted exactly.
    let algebraic = |ids: &[f64]| ids.iter().filter(|v| **v == 0.).count();
    let held = algebraic(&ida.system().joined.differential(&network_ids));
    let trip = ida
        .system_mut()
        .joined
        .command(t, &mut ys, Command::TurbineTrip)
        .expect("turbine trip");
    let open = ida
        .system()
        .joined
        .next_time_event(t)
        .expect("the holding opening");
    let restarted = discrete_restart(
        &mut ida,
        open,
        Discrete::TimeEvent,
        &mut ys,
        &network_ids,
        &atol,
        rtol,
        &restart,
    )
    .expect("release restart");
    let released = restarted
        .transactions
        .iter()
        .filter_map(|d| d.receipt["rods"].as_array())
        .flatten()
        .filter(|r| r["event"] == "grip release")
        .count();
    let clusters = ida.system().joined.rods().map_or(0, |r| r.clusters());
    let report = &restarted.report;
    let release = json!({
        "trip_transactions": trip.len(),
        "opening_transactions": restarted.transactions.len(),
        "released_clusters": released, "clusters": clusters,
        "algebraic_before": held,
        "algebraic_after": algebraic(&ida.system().joined.differential(&network_ids)),
        "placements": restarted.placements.len(),
        "projection_passes": report.projection_passes, "rate_passes": report.rate_passes,
        "residual_within_bound": report.residual.value <= START_BOUND,
        "constraint_rate_within_bound": report.constraint_rate.value <= START_BOUND,
    });
    let release_info = json!({"opening_s": open, "residual": report.residual.value, "constraint_rate": report.constraint_rate.value});
    lap("release_restart", &mut phase_cpu);

    let total = cpu::process_cpu_s() - started;
    let actual = json!({
        "kind": "ld01-smoke",
        "platform": platform(),
        "settle_s": settle_s,
        "oracle_columns": columns,
        "environment": environment,
        "counts": {"census": census, "composition": composition, "z1": z1, "oracle": oracle_counts,
            "settle": settle, "release_restart": release},
    });
    println!(
        "{}",
        serde_json::to_string(&json!({
            "smoke": actual,
            "info": {"packet": path, "wiki": wiki, "z1": z1_info, "oracle": oracle_info, "settle": settle_info, "release_restart": release_info,
                "process_cpu_s": total, "phase_cpu_s": phase_cpu, "load_average": [load_start, cpu::load_average()],
                "scheduling": cpu::SCHEDULING}
        }))
        .unwrap()
    );
    compare("smoke", &actual);
}

/// The mismatch report names every changed, added and removed count.
#[test]
fn a_count_mismatch_prints_each_differing_path() {
    let expected =
        json!({"counts": {"settle": {"steps": 1403, "jacobians": 508}, "z1": {"rate_passes": 2}}});
    let actual = json!({"counts": {"settle": {"steps": 1404, "jacobians": 508}, "oracle": {"columns": 200}}});
    assert_eq!(
        diff(&expected, &actual),
        vec![
            "+ counts.oracle.columns = 200",
            "- counts.settle.steps = 1403",
            "+ counts.settle.steps = 1404",
            "- counts.z1.rate_passes = 2",
        ]
    );
    assert!(diff(&expected, &expected).is_empty());
}

// ------------------------------------------------------- the settled state

/// The S2 settling block's credited outputs (revision 7, (E)) and their
/// thresholds per 20 s: (name, threshold, relative to the value).
const SETTLING: [(&str, f64, bool); 8] = [
    ("core_power", 6.9e-5, true),
    ("average_coolant_k", 3.4e-3, false),
    ("core_cell_liquid_k", 0.01, false),
    ("pt1_pa", 345., false),
    ("sg_pressure_pa", 345., false),
    ("pzr_level_m", 7e-4, false),
    ("sg_liquid_m3", 3.4e-3, false),
    ("loop_flow", 5e-4, true),
];
const SETTLING_WINDOW_S: f64 = 20.;
const ROW_BOUND: f64 = 1e-10;

/// The credited outputs at `(t, y)`: each name of [`SETTLING`] with one
/// value per instance (cells, SGs, loops).
fn credited(
    joined: &mut Joined<If97>,
    network_packet: &NetworkPacket,
    t: f64,
    y: &[f64],
    yp: &[f64],
) -> Vec<(&'static str, Vec<f64>)> {
    use leitbild_operating_plant::network::Properties;
    joined
        .evaluate(t, y, yp, None, 0., None)
        .expect("credited state");
    let released = joined.heats().nuclear.released_w.value;
    let net = &joined.network;
    let regions = &network_packet.mechanics.regions;
    let (mut mass, mut weighted, mut core) = (0., 0., Vec::new());
    for (c, l) in net.cell_layout.iter().enumerate() {
        let id = regions[c].id.as_str();
        let p = y[l.base] * net.scales()[l.base];
        let m = y[l.mass[0]] * net.scales()[l.mass[0]];
        let u = y[l.energy[0]] * net.scales()[l.energy[0]];
        let q = net
            .properties()
            .caloric(false, p, u / m, false)
            .expect("cell caloric");
        let temperature = net.properties().values(&q).temperature_k;
        // The 27 primary cells: every regular cell but SURGE.
        if id != "SURGE" {
            mass += m;
            weighted += m * temperature;
        }
        if id.starts_with("CORE.") {
            core.push(temperature);
        }
    }
    let taps = net.pzr_taps().expect("PZR taps");
    let face = |id: &str| {
        network_packet
            .mechanics
            .faces
            .iter()
            .position(|f| f.id == id)
            .unwrap_or_else(|| panic!("face {id}"))
    };
    let loops: Vec<f64> = ["RETURN.A->DOWN", "RETURN.B->DOWN"]
        .iter()
        .map(|f| {
            net.chart(face(f), 0)
                .expect("loop chart")
                .mass_flow_kg_s
                .value
        })
        .collect();
    let (mut sg_p, mut sg_v) = (Vec::new(), Vec::new());
    let mut k = 0;
    for (owner, layout) in joined.layouts() {
        for (i, label) in layout.labels.iter().enumerate() {
            if owner == "secondary" && label.ends_with(".p_s") {
                sg_p.push(y[k] * layout.scales[i]);
            }
            if owner == "secondary" && label.ends_with(".V_l") {
                sg_v.push(y[k] * layout.scales[i]);
            }
            k += 1;
        }
    }
    vec![
        ("core_power", vec![released]),
        ("average_coolant_k", vec![weighted / mass]),
        ("core_cell_liquid_k", core),
        ("pt1_pa", vec![taps.pt1_pa.value]),
        ("sg_pressure_pa", sg_p),
        ("pzr_level_m", vec![taps.collapsed_level_m.value]),
        ("sg_liquid_m3", sg_v),
        ("loop_flow", loops),
    ]
}

/// Each credited output's change over the settling window at the pair's
/// exact rates (`y'`), by a central difference along `y'` of half-width
/// `h`, against its threshold: (name, worst change, threshold, holds).
fn settling_rates(
    joined: &mut Joined<If97>,
    network_packet: &NetworkPacket,
    t: f64,
    y: &[f64],
    yp: &[f64],
) -> Vec<(&'static str, f64, f64, bool)> {
    let h = 0.01;
    let shifted =
        |sign: f64| -> Vec<f64> { y.iter().zip(yp).map(|(v, r)| v + sign * h * r).collect() };
    let at = credited(joined, network_packet, t, y, yp);
    let ahead = credited(joined, network_packet, t + h, &shifted(1.), yp);
    let behind = credited(joined, network_packet, t - h, &shifted(-1.), yp);
    // Leave the operator evaluated at the pair itself.
    credited(joined, network_packet, t, y, yp);
    SETTLING
        .iter()
        .map(|(name, threshold, relative)| {
            let find =
                |v: &[(&str, Vec<f64>)]| v.iter().find(|(n, _)| n == name).unwrap().1.clone();
            let (a, b, c) = (find(&at), find(&ahead), find(&behind));
            assert_eq!(a.len(), b.len());
            let worst = a
                .iter()
                .zip(b.iter().zip(&c))
                .map(|(v, (p, m))| {
                    let change = (p - m) / (2. * h) * SETTLING_WINDOW_S;
                    if *relative {
                        (change / v).abs()
                    } else {
                        change.abs()
                    }
                })
                .fold(0., f64::max);
            (*name, worst, *threshold, worst <= *threshold)
        })
        .collect()
}

/// Exact f64 bits as hex: serde_json's default float parsing is best
/// effort (it may land one ULP off), so a pinned state is stored by bits.
fn bits(v: &[f64]) -> Vec<String> {
    v.iter().map(|x| format!("{:016x}", x.to_bits())).collect()
}
fn from_bits(v: &Value) -> Vec<f64> {
    v.as_array()
        .expect("bits array")
        .iter()
        .map(|x| {
            f64::from_bits(
                u64::from_str_radix(x.as_str().expect("hex bits"), 16).expect("hex bits"),
            )
        })
        .collect()
}

/// FNV-1a over the exact bits of every row value.
fn digest(rows: &[f64]) -> String {
    let mut h = 0xcbf2_9ce4_8422_2325_u64;
    for v in rows {
        for b in v.to_bits().to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("{h:#018x}")
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    use std::io::Write;
    use std::process::{Command as Process, Stdio};
    let mut child = Process::new("gzip")
        .args(["-9", "-n", "-c"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("gzip");
    let mut input = child.stdin.take().unwrap();
    let data = bytes.to_vec();
    let writer = std::thread::spawn(move || input.write_all(&data));
    let out = child.wait_with_output().expect("gzip");
    writer.join().unwrap().expect("gzip input");
    assert!(out.status.success(), "gzip");
    out.stdout
}
fn gunzip(path: &Path) -> Vec<u8> {
    let out = std::process::Command::new("gzip")
        .args(["-dc"])
        .arg(path)
        .output()
        .expect("gzip");
    assert!(out.status.success(), "gzip -dc {}", path.display());
    out.stdout
}

/// The composed operator at the packet and the S1 gates, for evaluating a
/// stored state (its own composed coordinates are discarded).
fn operator(bytes: &[u8], gates: &Value) -> (Composed, NetworkPacket) {
    let network_packet: NetworkPacket = serde_json::from_slice(bytes).expect("network packet");
    (composed(bytes, gates), network_packet)
}

/// Make a settled-state pin (tier b) from a settled `{packet, t_s, y, yp}`
/// state (`LD01_SETTLED_STATE_SOURCE`, e.g. a settling probe's
/// `LD01_SETTLED_STATE_OUT`): the exact consistent start at its `y`, written
/// gzip-compressed (`-n`, reproducible) to the new file
/// `LD01_SETTLED_STATE_OUT`. Prints the pin's summary for
/// `tests/ld01_regression/settled-state.json`.
#[test]
#[ignore = "makes a settled-state pin: requires the joined packet, the wiki, IF97, stock IDA/KLU and a settled state"]
fn settled_state_pin() {
    let source_path =
        std::env::var("LD01_SETTLED_STATE_SOURCE").expect("LD01_SETTLED_STATE_SOURCE");
    let out =
        PathBuf::from(std::env::var("LD01_SETTLED_STATE_OUT").expect("LD01_SETTLED_STATE_OUT"));
    assert!(!out.exists(), "never overwritten: {}", out.display());
    let source_bytes = std::fs::read(&source_path).expect("settled state");
    let source: Value = serde_json::from_slice(&source_bytes).expect("settled state shape");
    let (_, bytes) = packet_bytes();
    let packet_sha256 = sha256(&bytes);
    let named = source["packet"].as_str().unwrap_or("");
    assert!(
        named.contains(&packet_sha256[..8]),
        "the state names packet {named}, not this packet ({packet_sha256})"
    );
    let gates = s1_gates();
    let (
        Composed {
            mut joined,
            ids,
            atol,
            rtol,
            ..
        },
        network_packet,
    ) = operator(&bytes, &gates);
    let t = source["t_s"].as_f64().expect("t_s");
    let vector = |k: &str| -> Vec<f64> {
        source[k]
            .as_array()
            .unwrap_or_else(|| panic!("{k}"))
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect()
    };
    let (mut y, yp_settled) = (vector("y"), vector("yp"));
    assert_eq!(y.len(), joined.dimension());
    joined
        .evaluate(t, &y, &yp_settled, None, 0., None)
        .expect("settled residual");
    let settled_rows = joined
        .rows()
        .iter()
        .fold(0_f64, |m, r| m.max(r.value.abs()));
    let start_weights = weights(&y, &atol, rtol);
    let structure = JoinedJacobian::compile(&mut joined, t, &y).expect("block structure");
    let mut analyses = Analyses::default();
    let (yp, report) = consistent_start(
        &mut joined,
        Matrices::Blocks {
            structure: &structure,
            analyses: &mut analyses,
        },
        t,
        &mut y,
        &ids,
        &start_weights,
        START_BOUND,
        3,
    )
    .expect("exact consistent start at the settled state");
    joined.evaluate(t, &y, &yp, None, 0., None).unwrap();
    let rows: Vec<f64> = joined.rows().iter().map(|r| r.value).collect();
    let rates = settling_rates(&mut joined, &network_packet, t, &y, &yp);
    let pin = json!({
        "kind": "ld01-settled-state-pin",
        "status": "NOT-EVIDENCE regression pin; S2 is not declared",
        "packet_sha256": packet_sha256,
        "source": {"file": source_path, "sha256": sha256(&source_bytes), "max_abs_scaled_row_as_settled": settled_rows},
        "start": {"projection_passes": report.projection_passes, "rate_passes": report.rate_passes,
            "correction_wrms": report.correction_wrms, "residual": report.residual.value, "constraint_rate": report.constraint_rate.value},
        "t_s": t, "y_bits": bits(&y), "yp_bits": bits(&yp),
    });
    let compressed = gzip(&serde_json::to_vec(&pin).unwrap());
    std::fs::write(&out, &compressed).unwrap();
    let misses: Vec<&str> = rates.iter().filter(|r| !r.3).map(|r| r.0).collect();
    println!(
        "{}",
        json!({
            "file": out.file_name().unwrap().to_string_lossy(), "sha256": sha256(&compressed), "bytes": compressed.len(),
            "packet_sha256": packet_sha256, "t_s": t,
            "provisional": !misses.is_empty(), "known_misses": misses,
            "digest": {platform(): digest(&rows)},
            "max_abs_scaled_row": rows.iter().fold(0_f64, |m, r| m.max(r.abs())),
            "rates_per_20_s": rates.iter().map(|r| (r.0.to_string(), json!({"change": r.1, "threshold": r.2, "holds": r.3}))).collect::<Map<String, Value>>(),
            "source": pin["source"], "start": pin["start"],
        })
    );
}

#[test]
#[ignore = "settled-state regression: requires the joined packet, the wiki, IF97 and stock IDA/KLU"]
fn settled_state() {
    let pin_path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ld01_regression/settled-state.json");
    let pin: Value = serde_json::from_slice(&std::fs::read(&pin_path).expect("settled-state pin"))
        .expect("pin shape");
    let file = pin_path.with_file_name(pin["file"].as_str().expect("the pinned state's file"));
    let compressed = std::fs::read(&file).expect("pinned state file");
    assert_eq!(
        sha256(&compressed),
        pin["sha256"].as_str().unwrap(),
        "{} is not the pinned state",
        file.display()
    );
    let state: Value = serde_json::from_slice(&gunzip(&file)).expect("pinned state shape");
    let (_, bytes) = packet_bytes();
    let packet_sha256 = sha256(&bytes);
    assert_eq!(
        packet_sha256,
        pin["packet_sha256"].as_str().unwrap(),
        "the pin's packet"
    );
    assert_eq!(state["packet_sha256"], pin["packet_sha256"]);
    let gates = s1_gates();
    let (Composed { mut joined, .. }, network_packet) = operator(&bytes, &gates);
    let t = state["t_s"].as_f64().unwrap();
    let (y, yp) = (from_bits(&state["y_bits"]), from_bits(&state["yp_bits"]));
    joined
        .evaluate(t, &y, &yp, None, 0., None)
        .expect("residual at the pinned state");
    let rows: Vec<f64> = joined.rows().iter().map(|r| r.value).collect();
    let (worst_row, worst) = rows.iter().enumerate().fold((0, 0_f64), |(i, m), (k, r)| {
        if r.abs() > m || r.is_nan() {
            (k, r.abs())
        } else {
            (i, m)
        }
    });
    let label = joined
        .layouts()
        .iter()
        .flat_map(|(o, l)| l.labels.iter().map(move |x| format!("{o}/{x}")))
        .nth(worst_row)
        .unwrap_or_default();
    let rates = settling_rates(&mut joined, &network_packet, t, &y, &yp);
    let misses: Vec<&str> = rates.iter().filter(|r| !r.3).map(|r| r.0).collect();
    let found_digest = digest(&rows);
    let pinned_digest = pin["digest"][platform()].as_str();
    println!(
        "{}",
        json!({"max_abs_scaled_row": worst, "at": label, "digest": found_digest, "pinned_digest": pinned_digest,
            "rates_per_20_s": rates.iter().map(|r| (r.0.to_string(), json!({"change": r.1, "threshold": r.2, "holds": r.3}))).collect::<Map<String, Value>>(),
            "misses": misses, "provisional": pin["provisional"]})
    );
    let mut problems = Vec::new();
    if worst.is_nan() || worst > ROW_BOUND {
        problems.push(format!(
            "the scaled residual is {worst:e} at {label} (bound {ROW_BOUND:e})"
        ));
    }
    if let Some(d) = pinned_digest
        && d != found_digest
    {
        problems.push(format!(
            "the rows' bits changed on {} ({found_digest}, pinned {d}): a non-bitwise change at the pinned state needs the lead's reason and a re-pin",
            platform()
        ));
    }
    let known: Vec<&str> = pin["known_misses"]
        .as_array()
        .map(|v| v.iter().filter_map(|x| x.as_str()).collect())
        .unwrap_or_default();
    if misses != known {
        problems.push(format!(
            "settling thresholds missed: {misses:?}; the pin (provisional: {}) records {known:?}",
            pin["provisional"]
        ));
    }
    assert!(
        problems.is_empty(),
        "settled-state regression:\n{}",
        problems.join("\n")
    );
}

/// Wiki provenance: git's own tree hash of the directory read, a named
/// commit accepted only when its tree is that hash, a checkout's HEAD.
#[test]
fn wiki_provenance_verifies_a_named_commit_against_the_tree() {
    let git = |cwd: &Path, args: &[&str]| {
        let out = std::process::Command::new("git")
            .current_dir(cwd)
            .args([
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    let temporary = std::env::temp_dir().join(format!("ld01-wiki-test-{}", std::process::id()));
    let (repository, archive) = (temporary.join("repository"), temporary.join("archive"));
    for d in [&repository.join("world/a"), &archive.join("world/a")] {
        std::fs::create_dir_all(d).unwrap();
    }
    for root in [&repository, &archive] {
        std::fs::write(root.join("index.md"), "# Index\n").unwrap();
        std::fs::write(root.join("world/a/page.md"), "page\n").unwrap();
        std::fs::write(root.join("world/a-b.md"), "sorted before a/\n").unwrap();
    }
    git(&temporary, &["init", "-q", "repository"]);
    git(&repository, &["add", "-A"]);
    git(&repository, &["commit", "-q", "-m", "first"]);
    let first = git(&repository, &["rev-parse", "HEAD"]);
    std::fs::write(repository.join("index.md"), "# Second\n").unwrap();
    git(&repository, &["commit", "-q", "-am", "second"]);
    let second = git(&repository, &["rev-parse", "HEAD"]);
    let repo = repository.to_string_lossy().to_string();
    let verified = wiki::provenance_with(&archive, Some(&first[..7]), Some(&repo)).unwrap();
    assert_eq!(verified["commit"], json!(first));
    assert_eq!(
        verified["tree"],
        json!(git(
            &repository,
            &["rev-parse", &format!("{first}^{{tree}}")]
        ))
    );
    let refused = wiki::provenance_with(&archive, Some(&second), Some(&repo)).unwrap_err();
    assert!(refused.contains("has tree"), "{refused}");
    assert!(wiki::provenance_with(&archive, Some(&first), None).is_err());
    assert_eq!(
        wiki::provenance_with(&archive, None, None).unwrap()["commit"],
        Value::Null
    );
    let head = wiki::provenance_with(&repository, None, None).unwrap();
    assert_eq!(
        (head["commit"].clone(), head["basis"].clone()),
        (json!(second), json!("checkout HEAD, files match its tree"))
    );
    std::fs::remove_dir_all(&temporary).unwrap();
}
