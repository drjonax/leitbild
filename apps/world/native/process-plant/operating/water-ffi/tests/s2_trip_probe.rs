//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#exact-consistent-start-of-the-joined-residual
//! S2-10: the manual turbine TRIP from a settled joined state, run 60 s
//! under S2's draft trip configuration, counting the distinct
//! `discrete_restart` instants by kind with their cost. A NOT-EVIDENCE
//! probe: S2 is not declared, and its gates are not judged here.
//!
//! The run is the draft's trip (revision 6, "Trip"): `LD01.TG` TRIP at the
//! settled state's time t0 (no simultaneous reactor trip), BDF order at most
//! 2, stock's 0.33 Newton coefficient with dcj 0.1 and G13's 1e-4 s first
//! step at every start and restart, the step capped at 20 ms over the 20 s
//! event window, H1's restart at its end, then uncapped in one history to
//! t0 + 60 s. Every event restarts by `discrete_restart` (transactions,
//! time events, bound placement, identity, the exact consistent start on the
//! block Jacobian with cached analyses, IDAReInit); the probe only counts
//! and times them. The composition is `joined_spine.rs`'s, included as a
//! module, so its ignored probes also list in this binary: run this one by
//! its exact name.
//!
//! Environment: the joined spine's (packet, wiki, IF97, SUNDIALS, water)
//! plus `LD01_S2_TRIP_STATE`, a settled state `{t_s, y, yp, packet}` of
//! this packet (`LD01_SETTLED_STATE_OUT` of the decomposition probe), and
//! optionally `LD01_S2_TRIP_RECEIPT`, a new receipt path, and
//! `LD01_S2_TRIP_CPU_CAP_S` (default 1800), the probe's own CPU guard.
#![cfg(all(feature = "ida", target_os = "macos"))]
#[path = "joined_spine.rs"]
mod spine;

use leitbild_operating_plant::joined::block::Command;
use leitbild_operating_water::{
    If97,
    ida::{Advance, Failure, Ida, Initial, KluOrdering, Stats, System},
    joined::{Discrete, Integrated, JoinedSystem, Restart, Restarted, discrete_restart},
};
use serde_json::{Value, json};
use spine::{
    DELTA_CJ_LSETUP, FIRST_STEP_S, NEWTON_COEFFICIENT, Started, started_full_composition, z1,
};
use std::collections::BTreeMap;

/// The draft's trip timing (S2 declaration draft revision 6, "Trip"; G1).
const DURATION_S: f64 = 60.;
/// The S2-D21 check's span: past the first rod seat (t0 + 2.53 s from the
/// provisional settled state).
const SEAT_CHECK_S: f64 = 2.7;
const WINDOW_S: f64 = 20.;
const WINDOW_MAX_STEP_S: f64 = 0.02;
const MAX_ORDER: usize = 2;
/// Output target spacing of one stock IDA_NORMAL call (no step shortened).
const CHUNK_S: f64 = 0.01;
/// Observation spacing of the light samples.
const SAMPLE_S: f64 = 0.1;

fn counts(s: &Stats) -> [i64; 8] {
    [
        s.steps,
        s.residuals,
        s.jacobians,
        s.nonlinear_iterations,
        s.error_failures,
        s.convergence_failures,
        s.linear_setups,
        s.root_evaluations,
    ]
}
const COUNT_NAMES: [&str; 8] = [
    "steps",
    "residuals",
    "jacobians",
    "nonlinear_iterations",
    "error_failures",
    "convergence_failures",
    "linear_setups",
    "root_evaluations",
];
fn named(c: &[i64; 8]) -> Value {
    json!(
        COUNT_NAMES
            .iter()
            .zip(c)
            .map(|(k, v)| (k.to_string(), json!(v)))
            .collect::<serde_json::Map<_, _>>()
    )
}

/// The integrated operator with a ledger of its root-function calls: an
/// FNV-1a digest of every call's time and root values, in order, and their
/// process CPU. Every other call is forwarded unchanged (the KLU ordering
/// included); the probe reaches the operator through it as before.
struct RootLedger {
    inner: Integrated<If97>,
    digest: u64,
    calls: usize,
    cpu_s: f64,
}
impl RootLedger {
    fn new(inner: Integrated<If97>) -> Self {
        Self {
            inner,
            digest: 0xcbf2_9ce4_8422_2325,
            calls: 0,
            cpu_s: 0.,
        }
    }
    fn json(&self) -> Value {
        json!({"calls": self.calls, "cpu_s": self.cpu_s,
            "digest": format!("{:016x}", self.digest),
            "digest_of": "FNV-1a over each root call's time bits then its root values' bits, in call order"})
    }
}
impl std::ops::Deref for RootLedger {
    type Target = Integrated<If97>;
    fn deref(&self) -> &Integrated<If97> {
        &self.inner
    }
}
impl std::ops::DerefMut for RootLedger {
    fn deref_mut(&mut self) -> &mut Integrated<If97> {
        &mut self.inner
    }
}
impl System for RootLedger {
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
        self.inner.jacobian(t, cj, y, yp, data, rows, pointers)
    }
    fn roots(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        let started = z1::cpu_s();
        let result = self.inner.roots(t, y, yp, out);
        self.cpu_s += z1::cpu_s() - started;
        self.calls += 1;
        for word in std::iter::once(t.to_bits()).chain(out.iter().map(|v| v.to_bits())) {
            for byte in word.to_le_bytes() {
                self.digest = (self.digest ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3);
            }
        }
        result
    }
    fn klu_ordering(&self) -> KluOrdering {
        self.inner.klu_ordering()
    }
    fn quadrature_count(&self) -> usize {
        self.inner.quadrature_count()
    }
    fn quadrature(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
        out: &mut [f64],
    ) -> Result<(), Failure> {
        self.inner.quadrature(t, y, yp, out)
    }
}
impl JoinedSystem for RootLedger {
    type Properties = If97;
    fn integrated(&self) -> &Integrated<If97> {
        &self.inner
    }
    fn integrated_mut(&mut self) -> &mut Integrated<If97> {
        &mut self.inner
    }
}

/// One integration segment between two restarts.
#[derive(Default)]
struct Segment {
    from_s: f64,
    to_s: f64,
    counts: [i64; 8],
    solver_cpu_s: f64,
    /// Steps and Jacobians at the first output where the last step reached
    /// the window cap (chunk resolution), and that output's time.
    at_cap: Option<(i64, i64, f64)>,
    max_step_s: f64,
}

/// What a restart instant's transactions and roots were, as kinds.
fn kinds_of(
    restarted: &Restarted,
    discrete: &str,
    roots: &[(usize, i32)],
    root_labels: &[String],
) -> (Vec<String>, Value) {
    let mut kinds = Vec::new();
    let mut seats = Vec::new();
    let mut releases = 0;
    let mut lifts = Vec::new();
    let mut relief = Vec::new();
    let mut other = Vec::new();
    for t in &restarted.transactions {
        let r = &t.receipt;
        if let Some(events) = r["rods"].as_array() {
            for e in events {
                match e["event"].as_str() {
                    Some("grip release") => releases += 1,
                    Some("seat") => seats.push(e["cluster"].clone()),
                    Some("lift-off") => lifts.push(e["cluster"].clone()),
                    _ => other.push(e.clone()),
                }
            }
        } else if let Some(events) = r["relief"].as_array() {
            for e in events {
                relief.push(json!({"valve": e["valve"], "threshold": e["threshold"], "direction": e["direction"],
                    "before": e["before"], "after": e["after"], "superseded": e["superseded"]}));
            }
        } else if r["event"] == "STOP ramp end" {
            kinds.push("ramp end".to_string());
        } else if r["command"] == "TurbineTrip" || r["turbine_trip_s"].is_number() {
            if !kinds.contains(&"command".to_string()) {
                kinds.push("command".to_string());
            }
        } else {
            other.push(r.clone());
        }
    }
    if releases > 0 {
        kinds.push("opening".into());
    }
    if !seats.is_empty() {
        kinds.push("rod seat group".into());
    }
    if !lifts.is_empty() {
        kinds.push("rod lift-off".into());
    }
    // SG relief roots per SG and threshold, from the located roots' labels.
    let mut sg_kinds: Vec<String> = roots
        .iter()
        .filter_map(|(i, d)| {
            let l = &root_labels[*i];
            l.starts_with("SG.").then(|| format!("SG relief {l} {d:+}"))
        })
        .collect();
    sg_kinds.sort();
    sg_kinds.dedup();
    let sgs: Vec<String> = {
        let mut s: Vec<String> = roots
            .iter()
            .filter_map(|(i, _)| {
                let l = &root_labels[*i];
                l.starts_with("SG.")
                    .then(|| l.split('.').nth(1).unwrap_or("?").to_string())
            })
            .collect();
        s.sort();
        s.dedup();
        s
    };
    for g in &sgs {
        kinds.push(format!("SG relief SG.{g}"));
    }
    if discrete == "H1" {
        kinds.push("H1 window end".into());
    }
    if kinds.is_empty() || !other.is_empty() {
        kinds.push("other".into());
    }
    (
        kinds,
        json!({"seated_clusters": seats, "released_clusters": releases, "lift_off_clusters": lifts,
            "relief": relief, "relief_roots": sg_kinds, "other": other}),
    )
}

/// Root labels in the operator's root order: the secondary owner's (per
/// SG, per valve the four thresholds, then the crown and pickup guards),
/// then the rod owner's (one per cluster).
fn root_labels(
    joined: &leitbild_operating_plant::joined::operator::Joined<leitbild_operating_water::If97>,
) -> Vec<String> {
    let layouts = joined.layouts();
    let mut labels = Vec::new();
    for (owner, layout) in &layouts {
        if *owner == "secondary" {
            let mut sg: Option<String> = None;
            let mut valves: Vec<String> = Vec::new();
            let flush = |sg: &Option<String>, valves: &mut Vec<String>, out: &mut Vec<String>| {
                if let Some(g) = sg {
                    for v in valves.iter() {
                        for t in ["Crack", "FullLift", "Reseat", "Seat"] {
                            out.push(format!("{v}:{t}"));
                        }
                    }
                    out.push(format!("SG.{g}:crown guard"));
                    out.push(format!("SG.{g}:pickup guard"));
                }
                valves.clear();
            };
            for l in &layout.labels {
                if let Some(rest) = l.strip_prefix("SG.")
                    && l.ends_with(".M_s")
                {
                    flush(&sg, &mut valves, &mut labels);
                    sg = Some(rest.trim_end_matches(".M_s").to_string());
                } else if let Some(v) = l.strip_suffix(".lift") {
                    valves.push(v.to_string());
                }
            }
            flush(&sg, &mut valves, &mut labels);
        }
    }
    for (owner, layout) in &layouts {
        if *owner == "rods" {
            for l in &layout.labels {
                if let Some(id) = l.strip_prefix("y[") {
                    labels.push(format!("rod {}", id.trim_end_matches(']')));
                }
            }
        }
    }
    labels
}

#[test]
#[ignore = "NOT-EVIDENCE S2-10 probe: requires the joined packet, a settled state, the wiki, IF97 and stock IDA/KLU"]
fn s2_trip_probe_counts_the_restart_instants_by_kind() {
    let receipt_path = std::env::var_os("LD01_S2_TRIP_RECEIPT");
    if let Some(p) = &receipt_path {
        assert!(
            !std::path::Path::new(p).exists(),
            "receipts are never overwritten"
        );
    }
    let receipt = trip(DURATION_S);
    if let Some(p) = &receipt_path {
        std::fs::write(p, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    }
    println!(
        "{}",
        serde_json::to_string(&json!({"failure": receipt["failure"], "reached_s": receipt["reached_s"],
        "restart_instants": receipt["restart_instants"], "rods": {"seated": receipt["rods"]["seated"], "groups": receipt["rods"]["seat_groups"].as_array().map(|g| g.len()),
        "most_bitwise_trajectory_groups": receipt["rods"]["most_bitwise_trajectory_groups"]}, "totals": receipt["totals"], "cpu": receipt["cpu"]["window"]}))
        .unwrap()
    );
}

/// Lead decision S2-D21 on the actual trip: the first rod seat (all 52
/// clusters at one located instant) restarts exactly. The rod owner is the
/// one transacted owner; the start takes at most the declared 12 passes,
/// its WRMS guard leaves out the rods' algebraic coordinates (each seated
/// body's speed and guide current) and reports their correction, and the
/// constraint and rate bounds hold at 1e-12. NOT-EVIDENCE; about 40 CPU-s.
#[test]
#[ignore = "NOT-EVIDENCE S2-D21 check: requires the joined packet, a settled state, the wiki, IF97 and stock IDA/KLU"]
fn the_rod_seat_restarts_exactly_after_its_transaction() {
    let receipt = trip(SEAT_CHECK_S);
    let summary = |r: &Value| {
        json!({"t_s": r["t_s"], "kinds": r["kinds"], "failed": r["failed"], "start": r["start"],
        "transacted": r["transacted"], "passes_allowed": r["passes_allowed"]})
    };
    let restarts = receipt["restarts"].as_array().unwrap();
    println!(
        "{}",
        serde_json::to_string(
            &json!({"failure": receipt["failure"], "reached_s": receipt["reached_s"],
            "restarts": restarts.iter().map(summary).collect::<Vec<_>>()})
        )
        .unwrap()
    );
    assert!(receipt["failure"].is_null(), "{}", receipt["failure"]);
    let seat = restarts
        .iter()
        .find(|r| {
            r["kinds"]
                .as_array()
                .is_some_and(|k| k.contains(&json!("rod seat group")))
        })
        .expect("a rod seat within the check");
    assert_eq!(
        seat["detail"]["seated_clusters"].as_array().unwrap().len(),
        52
    );
    assert_eq!(seat["transacted"], json!(["rods"]));
    assert_eq!(seat["passes_allowed"], json!(12));
    let start = &seat["start"];
    assert!(start["projection_passes"].as_u64().unwrap() <= 12);
    assert!(start["residual"].as_f64().unwrap() <= 1e-12);
    assert!(start["constraint_rate"].as_f64().unwrap() <= 1e-12);
    assert!(start["correction_wrms"].as_f64().unwrap() <= 1.);
    // Each seated body's speed and guide current: 2 x 52 exempt coordinates.
    assert_eq!(start["exempt"]["coordinates"], json!(104));
    // Every other restart before it is ordinary: 2 passes, nothing exempt.
    for r in restarts.iter().take_while(|r| r["t_s"] != seat["t_s"]) {
        assert_eq!(r["passes_allowed"], json!(2), "{}", summary(r));
        assert!(r["start"]["exempt"].is_null());
    }
}

/// The trip from `LD01_S2_TRIP_STATE` over `duration_s` (the window's
/// timing unchanged), as one receipt.
fn trip(duration_s: f64) -> Value {
    let started = z1::cpu_s();
    let state_path = std::env::var("LD01_S2_TRIP_STATE").expect("LD01_S2_TRIP_STATE");
    let cpu_cap_s: f64 =
        std::env::var("LD01_S2_TRIP_CPU_CAP_S").map_or(1800., |v| v.parse().unwrap());
    let start_passes: usize =
        std::env::var("LD01_S2_TRIP_START_PASSES").map_or(2, |v| v.parse().unwrap());
    let state_bytes = std::fs::read(&state_path).expect("settled state");
    let state: Value = serde_json::from_slice(&state_bytes).expect("settled state json");
    let (packet_path, _) = spine::packet_bytes();
    assert_eq!(
        state["packet"].as_str(),
        Some(packet_path.as_str()),
        "the settled state belongs to another packet"
    );
    let Started {
        joined,
        ids,
        network_ids,
        atol,
        rtol,
        structure,
        analyses,
        receipt: preparation,
        ..
    } = started_full_composition();
    let preparation_cpu_s = z1::cpu_s() - started;
    let vector = |k: &str| -> Vec<f64> {
        state[k]
            .as_array()
            .unwrap_or_else(|| panic!("settled {k}"))
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect()
    };
    let (mut y, mut yp) = (vector("y"), vector("yp"));
    let t0 = state["t_s"].as_f64().expect("settled t_s");
    assert_eq!(y.len(), joined.dimension(), "settled state layout");
    let o = joined.offsets();
    let clusters = joined.rods().expect("rod owner").clusters();
    let labels = root_labels(&joined);
    assert_eq!(labels.len(), joined.root_count(), "root labels");
    let layouts = joined.layouts();
    // Every coordinate's owner, label and class, in joined order.
    let coordinates: Vec<(String, String)> = layouts
        .iter()
        .flat_map(|(owner, l)| {
            l.labels
                .iter()
                .zip(&l.classes)
                .map(move |(label, class)| (format!("{owner}/{class:?}"), label.clone()))
        })
        .collect();
    let index_of = |suffix: &str| -> Vec<(String, usize)> {
        let mut k = 0;
        let mut out = Vec::new();
        for (_, l) in &layouts {
            for label in &l.labels {
                if label.ends_with(suffix) {
                    out.push((label.clone(), k));
                }
                k += 1;
            }
        }
        out
    };
    let pressures = index_of(".p_s");
    let liquid = index_of(".V_l");
    let lifts = index_of(".lift");
    let scales = joined.scales();
    let cluster_ids: Vec<String> = layouts
        .iter()
        .filter(|(o, _)| *o == "rods")
        .flat_map(|(_, l)| l.labels.iter())
        .filter_map(|l| {
            l.strip_prefix("y[")
                .map(|s| s.trim_end_matches(']').to_string())
        })
        .collect();
    let nonnegative = joined.network.nonnegative_stocks();
    let restart = Restart {
        newton_coefficient: NEWTON_COEFFICIENT,
        delta_cj_lsetup: DELTA_CJ_LSETUP,
        first_step_s: FIRST_STEP_S,
        start_bound: 1e-12,
        // The restarts' declared passes (the release restart's); a
        // diagnostic run may name others, and the receipt says so.
        start_passes,
        // Lead decision S2-D21: P_tx after an owner transaction.
        transaction_passes: 12,
        bound_placement: 1e-12,
    };
    let mut ida = Ida::new(
        RootLedger::new(Integrated::from_blocks(joined, structure, analyses).expect("integrable")),
        Initial {
            time: t0,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: rtol,
        },
    )
    .expect("stock IDA");
    // Every joined solve is on AMD (decision 0013; COLAMD is unusable on
    // the exact pattern).
    assert_eq!(ida.system().klu_ordering(), KluOrdering::Amd);
    ida.set_max_order(MAX_ORDER).unwrap();
    ida.constrain_nonnegative(&nonnegative).unwrap();
    // Cluster trajectories grouped by bitwise-equal (travel, speed).
    let groups = |y: &[f64]| -> Vec<Vec<usize>> {
        let mut by: BTreeMap<(u64, u64), Vec<usize>> = BTreeMap::new();
        for c in 0..clusters {
            let b = o.rods + 3 * c;
            by.entry((y[b].to_bits(), y[b + 1].to_bits()))
                .or_default()
                .push(c);
        }
        by.into_values().collect()
    };
    let mut most_groups = (0usize, t0);
    let mut first_split: Option<f64> = None;
    let mut restarts: Vec<Value> = Vec::new();
    let mut samples: Vec<Value> = Vec::new();
    let mut segments: Vec<Segment> = Vec::new();
    let mut observation_cpu_s = 0.;
    let mut restart_cpu_s = [0., 0.]; // window, after
    let mut solver_cpu_s = [0., 0.];
    let mut failure: Option<String> = None;
    let end = t0 + duration_s;
    let window_end = t0 + WINDOW_S;
    // One restart: the transactions and the exact start by discrete_restart.
    let do_restart = |ida: &mut Ida<RootLedger>,
                      t: f64,
                      discrete: Discrete<'_>,
                      name: &str,
                      y: &mut Vec<f64>,
                      yp: &mut Vec<f64>,
                      roots: Vec<(usize, i32)>,
                      before: Option<Segment>,
                      restarts: &mut Vec<Value>|
     -> Result<f64, String> {
        let pre = groups(y);
        let y_before = y.clone();
        let timer = z1::cpu_s();
        let restarted = match discrete_restart(
            ida,
            t,
            discrete,
            y,
            &network_ids,
            &atol,
            rtol,
            &restart,
        ) {
            Ok(r) => r,
            Err(e) => {
                let located: Vec<String> = roots
                    .iter()
                    .map(|(i, d)| format!("{} {d:+}", labels[*i]))
                    .collect();
                let message = format!("{name} restart with roots {located:?}: {e}");
                // Where the refused start moved the state: each
                // coordinate's change from the located state, over the
                // integrator's weight there (algebraic: the projection's
                // correction; differential: the transactions'), by class.
                let ids_after = ida.system().joined.differential(&network_ids);
                let mut by_class: BTreeMap<String, (usize, f64, f64, String)> = BTreeMap::new();
                let mut changed = Vec::new();
                for i in 0..y.len() {
                    let w = 1. / (rtol * y_before[i].abs() + atol[i]);
                    let c = (y[i] - y_before[i]) * w;
                    if c == 0. {
                        continue;
                    }
                    let kind = if ids_after[i] == 0. {
                        "algebraic"
                    } else {
                        "differential"
                    };
                    let e = by_class
                        .entry(format!("{kind} {}", coordinates[i].0))
                        .or_default();
                    e.0 += 1;
                    e.1 += c * c;
                    if c.abs() > e.2 {
                        e.2 = c.abs();
                        e.3 = coordinates[i].1.clone();
                    }
                    changed.push((c.abs(), i));
                }
                changed.sort_by(|a, b| b.0.total_cmp(&a.0));
                // The refused instant's kinds, from its located roots.
                let mut kinds: Vec<String> = roots
                    .iter()
                    .map(|(i, d)| {
                        let l = &labels[*i];
                        if l.starts_with("rod ") {
                            if *d < 0 { "rod seat group" } else { "rod root" }.to_string()
                        } else {
                            format!("SG relief SG.{}", l.split('.').nth(1).unwrap_or("?"))
                        }
                    })
                    .collect();
                kinds.sort();
                kinds.dedup();
                if kinds.is_empty() {
                    kinds.push(name.to_string());
                }
                let rooted: Vec<String> = roots
                    .iter()
                    .filter(|(i, _)| labels[*i].starts_with("rod "))
                    .map(|(i, _)| labels[*i].trim_start_matches("rod ").to_string())
                    .collect();
                restarts.push(json!({
                        "index": restarts.len(), "t_s": t - t0, "discrete": name, "failed": message,
                        "kinds": kinds, "rod_clusters_rooted": rooted,
                        "roots": roots.iter().map(|(i, d)| json!({"root": labels[*i], "direction": d})).collect::<Vec<_>>(),
                        "trajectory_groups_before": pre.len(),
                        "refused_start_state_change": {
                            "note": "y as the refused start left it against the located state; WRMS over all coordinates = sqrt(sum / n)",
                            "n": y.len(),
                            "by_class": by_class.into_iter().map(|(k, (count, sum, max, at))| (k, json!({"coordinates": count, "weighted_square_sum": sum, "max_weighted": max, "at": at}))).collect::<serde_json::Map<_, _>>(),
                            "largest": changed.iter().take(20).map(|(c, i)| json!({"label": coordinates[*i].1, "class": coordinates[*i].0,
                                "weighted": c, "before": y_before[*i], "after": y[*i], "algebraic": ids_after[*i] == 0.})).collect::<Vec<_>>()},
                        "segment_before": before.map(|s| json!({"from_s": s.from_s - t0, "to_s": s.to_s - t0, "counts": named(&s.counts), "solver_cpu_s": s.solver_cpu_s})),
                    }));
                return Err(message);
            }
        };
        let cpu = z1::cpu_s() - timer;
        yp.copy_from_slice(&restarted.yp);
        let (kinds, detail) = kinds_of(&restarted, name, &roots, &labels);
        let r = &restarted.report;
        let algebraic = ida
            .system()
            .joined
            .differential(&network_ids)
            .iter()
            .filter(|v| **v == 0.)
            .count();
        let segment = before.map(|s| {
            json!({"from_s": s.from_s - t0, "to_s": s.to_s - t0, "counts": named(&s.counts),
                "solver_cpu_s": s.solver_cpu_s, "max_step_s": s.max_step_s,
                "at_cap": s.at_cap.map(|(st, j, at)| json!({"steps": st, "jacobians": j, "t_s": at - t0}))})
        });
        restarts.push(json!({
            "index": restarts.len(), "t_s": t - t0, "discrete": name, "kinds": kinds, "detail": detail,
            "roots": roots.iter().map(|(i, d)| json!({"root": labels[*i], "direction": d})).collect::<Vec<_>>(),
            "placements": restarted.placements.len(),
            "transacted": restarted.transacted, "passes_allowed": restarted.passes_allowed,
            "trajectory_groups_before": pre.len(),
            "algebraic_after": algebraic,
            "start": {"assembly": r.assembly, "projection_passes": r.projection_passes, "rate_passes": r.rate_passes,
                "analyses_made": r.analyses, "assemblies": r.jacobian_s.len(),
                "assembly_wall_s": r.jacobian_s.iter().sum::<f64>(), "klu_analyze_wall_s": r.analyze_s.iter().sum::<f64>(),
                "klu_factor_wall_s": r.factor_s.iter().sum::<f64>(), "klu_solve_wall_s": r.solve_s.iter().sum::<f64>(),
                "residual": r.residual.value, "constraint_rate": r.constraint_rate.value,
                "correction_wrms": r.correction_wrms,
                "exempt": r.exempt.map(|e| json!({"coordinates": e.coordinates, "wrms": e.wrms,
                    "max_weighted": e.max.value, "max_at": coordinates[e.max.row].1}))},
            "restart_cpu_s": cpu,
            "segment_before": segment,
        }));
        Ok(cpu)
    };
    // t0: the manual turbine TRIP, restarted at once (its ramp's kink).
    let cpu = do_restart(
        &mut ida,
        t0,
        Discrete::Command(Command::TurbineTrip),
        "command",
        &mut y,
        &mut yp,
        Vec::new(),
        None,
        &mut restarts,
    )
    .expect("the trip command's restart");
    restart_cpu_s[0] += cpu;
    ida.set_max_step(WINDOW_MAX_STEP_S).unwrap();
    let mut t = t0;
    let mut in_window = true;
    let mut segment = Segment {
        from_s: t0,
        ..Segment::default()
    };
    let mut next_sample = t0;
    let close = |ida: &Ida<RootLedger>, mut s: Segment, to: f64| {
        let st = ida.stats().unwrap();
        s.counts = counts(&st);
        s.to_s = to;
        s
    };
    let mut totals = [[0i64; 8]; 2];
    let mut add = |s: &Segment, w: usize| {
        for (a, b) in totals[w].iter_mut().zip(&s.counts) {
            *a += b;
        }
    };
    loop {
        if z1::cpu_s() - started > cpu_cap_s {
            failure = Some(format!(
                "probe CPU guard {cpu_cap_s} s reached at t0 + {} s",
                t - t0
            ));
            break;
        }
        let event = ida.system().joined.next_time_event(t);
        let boundary = if in_window { window_end.min(end) } else { end };
        let stop = event.map_or(boundary, |e| e.min(boundary));
        if let Err(e) = ida.stop_at(stop) {
            failure = Some(format!("stop at {stop}: {e}"));
            break;
        }
        let target = stop.min(t + CHUNK_S);
        let timer = z1::cpu_s();
        let outcome = ida.advance(target, &mut y, &mut yp);
        let spent = z1::cpu_s() - timer;
        solver_cpu_s[usize::from(!in_window)] += spent;
        segment.solver_cpu_s += spent;
        let timer = z1::cpu_s();
        match outcome {
            Ok(Advance::Reached(time)) => {
                t = time;
                let st = ida.stats().unwrap();
                segment.max_step_s = segment.max_step_s.max(st.last_step);
                if segment.at_cap.is_none() && st.last_step >= WINDOW_MAX_STEP_S * (1. - 1e-9) {
                    segment.at_cap = Some((st.steps, st.jacobians, t));
                }
                let g = groups(&y);
                if g.len() > most_groups.0 {
                    most_groups = (g.len(), t);
                }
                if g.len() > 1 && first_split.is_none() {
                    first_split = Some(t);
                }
                if t >= next_sample - 1e-12 || t == stop {
                    // What limits the step: stock's current local-error
                    // estimate over its weights, largest coordinates.
                    let (mut errors, mut weights) = (vec![0.; y.len()], vec![0.; y.len()]);
                    let limiting: Vec<Value> =
                        match ida.error_diagnostics(&mut errors, &mut weights) {
                            Ok(_) => {
                                let mut e: Vec<(f64, usize)> = errors
                                    .iter()
                                    .zip(&weights)
                                    .enumerate()
                                    .map(|(i, (e, w))| ((e * w).abs(), i))
                                    .collect();
                                e.sort_by(|a, b| b.0.total_cmp(&a.0));
                                e.iter()
                                    .take(3)
                                    .map(|(v, i)| json!([coordinates[*i].1, v]))
                                    .collect()
                            }
                            Err(_) => Vec::new(),
                        };
                    let cumulative = counts(&st);
                    let j = &mut ida.system_mut().joined;
                    j.evaluate(t, &y, &yp, None, 0., None).unwrap();
                    let travel: Vec<f64> = (0..clusters)
                        .map(|c| y[o.rods + 3 * c] * scales[o.rods + 3 * c])
                        .collect();
                    let speed: Vec<f64> = (0..clusters)
                        .map(|c| y[o.rods + 3 * c + 1] * scales[o.rods + 3 * c + 1])
                        .collect();
                    let spread = |v: &[f64]| {
                        v.iter().cloned().fold(f64::NEG_INFINITY, f64::max)
                            - v.iter().cloned().fold(f64::INFINITY, f64::min)
                    };
                    let value = |(l, i): &(String, usize)| json!([l, y[*i] * scales[*i]]);
                    samples.push(json!({"t_s": t - t0, "released_w": j.heats().nuclear.released_w.value,
                        "sg_pressure_pa": pressures.iter().map(value).collect::<Vec<_>>(),
                        "sg_liquid_m3": liquid.iter().map(value).collect::<Vec<_>>(),
                        "relief_lift": lifts.iter().map(value).collect::<Vec<_>>(),
                        "rod_travel_m": [travel.iter().cloned().fold(f64::INFINITY, f64::min), travel.iter().cloned().fold(f64::NEG_INFINITY, f64::max)],
                        "rod_travel_spread_m": spread(&travel), "rod_speed_m_s": [speed.iter().cloned().fold(f64::INFINITY, f64::min), spread(&speed)],
                        "trajectory_groups": g.len(), "last_step_s": st.last_step, "order": st.last_order,
                        "segment_counts": cumulative, "local_error_largest": limiting}));
                    next_sample += SAMPLE_S;
                }
                observation_cpu_s += z1::cpu_s() - timer;
                if t == stop {
                    let w = usize::from(!in_window);
                    let closed = close(&ida, std::mem::take(&mut segment), t);
                    add(&closed, w);
                    let (discrete, name) = if event == Some(t) {
                        (Discrete::TimeEvent, "time event")
                    } else if in_window && t == window_end && t < end {
                        (Discrete::TimeEvent, "H1")
                    } else {
                        segments.push(closed);
                        break;
                    };
                    match do_restart(
                        &mut ida,
                        t,
                        discrete,
                        name,
                        &mut y,
                        &mut yp,
                        Vec::new(),
                        Some(closed),
                        &mut restarts,
                    ) {
                        // H1's restart opens the recovery interval.
                        Ok(cpu) => restart_cpu_s[if name == "H1" { 1 } else { w }] += cpu,
                        Err(e) => {
                            failure = Some(format!("restart at t0 + {} s: {e}", t - t0));
                            break;
                        }
                    }
                    if name == "H1" {
                        // H1: the window's cap ends with it.
                        in_window = false;
                        ida.remove_max_step().unwrap();
                    }
                    segment = Segment {
                        from_s: t,
                        ..Segment::default()
                    };
                }
            }
            Ok(Advance::Root { time, directions }) => {
                observation_cpu_s += z1::cpu_s() - timer;
                t = time;
                let w = usize::from(!in_window);
                let closed = close(&ida, std::mem::take(&mut segment), t);
                add(&closed, w);
                let roots: Vec<(usize, i32)> = directions
                    .iter()
                    .enumerate()
                    .filter(|(_, d)| **d != 0)
                    .map(|(i, d)| (i, *d))
                    .collect();
                match do_restart(
                    &mut ida,
                    t,
                    Discrete::Roots(&directions),
                    "roots",
                    &mut y,
                    &mut yp,
                    roots,
                    Some(closed),
                    &mut restarts,
                ) {
                    Ok(cpu) => restart_cpu_s[w] += cpu,
                    Err(e) => {
                        failure = Some(format!("restart at t0 + {} s: {e}", t - t0));
                        break;
                    }
                }
                segment = Segment {
                    from_s: t,
                    ..Segment::default()
                };
            }
            Err(e) => {
                failure = Some(format!("stock IDA at t0 + {} s: {e}", t - t0));
                let closed = close(&ida, std::mem::take(&mut segment), t);
                add(&closed, usize::from(!in_window));
                segments.push(closed);
                break;
            }
        }
    }
    let joined = &ida.system().joined;
    let c = joined.counters;
    let total_cpu_s = z1::cpu_s() - started;
    // Restart instants by kind, in the window and over the trip.
    let mut by_kind: BTreeMap<String, [usize; 2]> = BTreeMap::new();
    for r in &restarts {
        let w = usize::from(r["t_s"].as_f64().unwrap() >= WINDOW_S);
        for k in r["kinds"].as_array().unwrap() {
            by_kind.entry(k.as_str().unwrap().to_string()).or_default()[w] += 1;
        }
    }
    let instants = |w: usize| {
        restarts
            .iter()
            .filter(|r| usize::from(r["t_s"].as_f64().unwrap() >= WINDOW_S) == w)
            .count()
    };
    let seat_groups: Vec<Value> = restarts
        .iter()
        .filter(|r| {
            !r["detail"]["seated_clusters"]
                .as_array()
                .is_none_or(|a| a.is_empty())
        })
        .map(|r| json!({"t_s": r["t_s"], "clusters": r["detail"]["seated_clusters"]}))
        .collect();
    let seated: usize = seat_groups
        .iter()
        .map(|g| g["clusters"].as_array().unwrap().len())
        .sum();
    let final_groups: Vec<Vec<String>> = groups(&y)
        .into_iter()
        .map(|g| g.into_iter().map(|c| cluster_ids[c].clone()).collect())
        .collect();
    let window_cpu = solver_cpu_s[0] + restart_cpu_s[0];
    let receipt = json!({
        "kind": "s2-10-trip-probe",
        "status": "NOT-EVIDENCE probe; S2 is not declared and no gate is judged. PROVISIONAL: from the pre-G18 settled state, whose p_s starts about 0.7 MPa below the 6.36 MPa design value, so SG relief cycles are undercounted; the PZR boundary is closed (G6 pending), so no PZR relief can root",
        "provenance": spine::provenance(),
        "preparation": preparation,
        "settled_state": {"path": state_path, "sha256": spine::sha256(&state_bytes), "t_s": t0},
        "configuration": {"source": "S2 declaration draft revision 6, Trip, and its block (maxOrder 2, newtonCoefficient 0.33, deltaCjLSetup 0.1, restartInitialStep_s 1e-4)",
            "duration_s": duration_s, "window_s": WINDOW_S, "window_max_step_s": WINDOW_MAX_STEP_S, "max_order": MAX_ORDER,
            "newton_coefficient": NEWTON_COEFFICIENT, "delta_cj_lsetup": DELTA_CJ_LSETUP, "first_step_s": FIRST_STEP_S,
            "relative_tolerance": rtol, "start_passes": start_passes,
            "start_passes_note": if start_passes == 2 { "the restarts' declared 2 passes" } else { "DIAGNOSTIC: not the declared 2 passes" },
            "transaction_passes": 12, "transaction_rule": "lead decision S2-D21: after an owner transaction that changed one of its differential coordinates, up to 12 passes, the WRMS guard over every coordinate but the transacted owners' algebraic ones (reported)",
            "h1": "restart by the exact consistent start at the window's end, then no step cap",
            "chunk_s": CHUNK_S, "sample_s": SAMPLE_S, "jacobian": "block (claude/ld01-r-restart, lead decision S2-D4)", "klu_ordering": "AMD"},
        "failure": failure,
        "reached_s": t - t0,
        "restart_instants": {"window": instants(0), "after_window": instants(1), "by_kind_window_after": by_kind},
        "rods": {"clusters": clusters, "seated": seated, "seat_groups": seat_groups,
            "most_bitwise_trajectory_groups": most_groups.0, "most_groups_at_s": most_groups.1 - t0,
            "first_split_s": first_split.map(|s| s - t0), "final_bitwise_groups": final_groups},
        "totals": {"window": named(&totals[0]), "after_window": named(&totals[1])},
        "last_segment": segments.last().map(|s| json!({"from_s": s.from_s - t0, "to_s": s.to_s - t0, "counts": named(&s.counts),
            "solver_cpu_s": s.solver_cpu_s, "max_step_s": s.max_step_s})),
        "cpu": {"process_total_s": total_cpu_s, "preparation_s": preparation_cpu_s,
            "window": {"solver_s": solver_cpu_s[0], "restarts_s": restart_cpu_s[0], "solver_plus_restarts_s": window_cpu,
                "per_simulated_s": window_cpu / WINDOW_S.min((t - t0).max(1e-9))},
            "after_window": {"solver_s": solver_cpu_s[1], "restarts_s": restart_cpu_s[1]},
            "trip_per_simulated_s": (window_cpu + solver_cpu_s[1] + restart_cpu_s[1]) / (t - t0).max(1e-9),
            "observation_s": observation_cpu_s,
            "roots": ida.system().json(),
            "joined_counters": c,
            "residual_wall_s_per_call": c.residual_wall_s / c.residuals.max(1) as f64,
            "jacobian_wall_s_per_call": c.jacobian_wall_s / c.jacobians.max(1) as f64,
            "load_average_end": String::from_utf8_lossy(&std::process::Command::new("sysctl").args(["-n","vm.loadavg"]).output().unwrap().stdout).trim().to_string()},
        "restarts": restarts,
        "samples": samples,
    });
    receipt
}
