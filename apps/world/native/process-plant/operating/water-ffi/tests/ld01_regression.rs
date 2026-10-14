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
//! Single-threaded; nothing is written unless `LD01_SMOKE_RECORD` names a
//! new file for the actual counts.
#![cfg(feature = "ida")]
#[path = "common/cpu.rs"]
mod cpu;

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
    joined::{Discrete, Integrated, Restart, consistent_start, discrete_restart},
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
    let wiki = std::env::var("LD01_WIKI_ROOT").expect("LD01_WIKI_ROOT");
    let page = format!(
        "{wiki}/world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md"
    );
    let text = std::fs::read_to_string(&page).expect("build-readiness.md");
    let open = "```ld01-s1-gates\n";
    let start = text.find(open).expect("ld01-s1-gates") + open.len();
    let end = start + text[start..].find("\n```").unwrap();
    serde_json::from_str(&text[start..end]).unwrap()
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
    let (yp, start) = consistent_start(
        &mut joined,
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
            "info": {"packet": path, "z1": z1_info, "oracle": oracle_info, "settle": settle_info, "release_restart": release_info,
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
