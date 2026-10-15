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

use leitbild_operating_plant::joined::{block::Command, post_trip_domain};
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
    at_cap: Option<(i64, i64, f64, f64)>,
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
        } else if r["owner"] == "pzr" && r["command"].is_null() {
            if !kinds.contains(&"PZR relief".to_string()) {
                kinds.push("PZR relief".to_string());
            }
            relief.push(json!({"valve": "PZR relief", "demand_root": r["demand_root"], "travel_root": r["travel_root"],
                "before": r["before"], "after": r["after"], "stop": r["stop"]}));
        } else if r["event"] == "STOP ramp end" {
            kinds.push("ramp end".to_string());
        } else if r["command"] == "TurbineTrip"
            || r["turbine_trip_s"].is_number()
            || (r["owner"] == "pzr" && !r["command"].is_null())
        {
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
    // The PZR block's relief (G6): its demand and travel roots.
    if joined.root_count() == labels.len() + 2 {
        labels.extend(["PZR relief:demand".into(), "PZR relief:travel".into()]);
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
        mut joined,
        y: y_composed,
        yp: yp_composed,
        ids,
        network_ids,
        mut atol,
        rtol,
        structure,
        analyses,
        receipt: preparation,
        ..
    } = started_full_composition();
    // The state's exact bits where the file carries them (S2-07's pin),
    // otherwise its floats.
    let vector = |k: &str| -> Vec<f64> {
        match state[format!("{k}_bits")].as_array() {
            Some(bits) => bits
                .iter()
                .map(|b| f64::from_bits(u64::from_str_radix(b.as_str().unwrap(), 16).unwrap()))
                .collect(),
            None => state[k]
                .as_array()
                .unwrap_or_else(|| panic!("settled {k}"))
                .iter()
                .map(|v| v.as_f64().unwrap())
                .collect(),
        }
    };
    let (mut y, mut yp) = (vector("y"), vector("yp"));
    // `LD01_S2_TRIP_ATOL_P_BASIS=relative` takes atol_p as rtol x |p| at the
    // plena (RODCOST's V1 basis, 155 Pa) instead of the pressure
    // coordinates' own absolute tolerance (decision 0013's class, rtol /
    // kappa_s); the receipt names the basis.
    let relative_basis = match std::env::var("LD01_S2_TRIP_ATOL_P_BASIS").as_deref() {
        Ok("relative") => Some(rtol),
        Ok("absolute") | Err(_) => None,
        Ok(other) => panic!("LD01_S2_TRIP_ATOL_P_BASIS {other}: absolute or relative"),
    };
    // S2-D24: the guide currents' derived tolerance class, from the model's
    // Jacobian at the composed state (declared), and the same at the
    // settled state (reported only).
    let derived_at = |joined: &mut leitbild_operating_plant::joined::operator::Joined<
        leitbild_operating_water::If97,
    >,
                      t: f64,
                      y: &[f64],
                      yp: &[f64]| {
        derived_guide_current_tolerance(joined, &structure, t, y, yp, &atol, relative_basis)
    };
    let derived = if std::env::var("LD01_S2_TRIP_G12_GUIDE_CURRENTS").is_ok() {
        None
    } else {
        Some(derived_at(&mut joined, 0., &y_composed, &yp_composed))
    };
    let derived_settled = derived_at(&mut joined, state["t_s"].as_f64().unwrap(), &y, &yp);
    let g12_guide_atol: Vec<f64> = derived_settled.indices.iter().map(|i| atol[*i]).collect();
    if let Some(d) = &derived {
        for i in &d.indices {
            atol[*i] = d.scaled;
        }
    }
    let derived_receipt = json!({
        "decision": "S2-D24: atol_m = atol_p x |dm/d(dp)| from the model Jacobian at the composed state (rods/GuideCurrent only)",
        "atol_p_basis": if relative_basis.is_some() { "rtol x |p| at the plena (RODCOST V1's 155 Pa basis)" } else { "the pressure coordinates' own absolute tolerance (decision 0013: rtol / isentropic compressibility)" },
        "g12_class_kept": derived.is_none(),
        "applied": derived.as_ref().map(DerivedTolerance::receipt),
        "at_settled_state_reported_only": derived_settled.receipt(),
        "g12_scaled_before": g12_guide_atol.first(),
    });
    let preparation_cpu_s = z1::cpu_s() - started;
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
    // D3 (a) along the trajectory (lead decision S2-D23): the packet's
    // `post_trip_domain` record, or for a pre-D3 packet the compiled section
    // in LD01_POST_TRIP_DOMAIN; without either the samples carry no D3 entry.
    let d3 = post_trip_record();
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
    // D3 (a) along the run (S2-D23 as approved): the first accepted output
    // where the doubled-water-term margin fails, and the first where the
    // state is admitted by neither the compiled domains nor the extension
    // (the labelled D3 exit; the run continues for information).
    let mut d3_first_margin_fail: Option<f64> = None;
    let mut d3_exit: Option<(f64, String)> = None;
    let mut d3_samples = 0usize;
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
                        } else if l.starts_with("PZR") {
                            "PZR relief".to_string()
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
                "at_cap": s.at_cap.map(|(st, j, at, cpu)| json!({"steps": st, "jacobians": j, "t_s": at - t0, "solver_cpu_s": cpu}))})
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
                    segment.at_cap = Some((st.steps, st.jacobians, t, segment.solver_cpu_s));
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
                    let d3_sample = d3.as_ref().map(|(e, reference)| {
                        let mut v = d3_at(j, e, reference, t);
                        let admission = j
                            .region_phases()
                            .map_err(|f| post_trip_domain::Error::Phase(format!("{f:?}")))
                            .and_then(|phase| {
                                post_trip_domain::admit_accepted(
                                    j.nuclear(),
                                    &phase,
                                    e,
                                    j.travel(),
                                    t,
                                    0.,
                                )
                            });
                        v["admission"] = match &admission {
                            Ok(a) => json!({"domain": a.domain, "margin_holds": a.margin.holds}),
                            Err(err) => json!({"unsupported": format!("{err:?}")}),
                        };
                        d3_samples += 1;
                        if d3_first_margin_fail.is_none()
                            && v["margin_water_doubled"]["holds"] == json!(false)
                        {
                            d3_first_margin_fail = Some(t - t0);
                        }
                        if d3_exit.is_none()
                            && let Err(err) = &admission
                        {
                            d3_exit = Some((t - t0, format!("{err:?}")));
                        }
                        v
                    });
                    samples.push(json!({"t_s": t - t0, "released_w": j.heats().nuclear.released_w.value, "d3": d3_sample,
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
    let d3_summary = json!({"record": d3.as_ref().map(|(e, _)| json!(e)), "samples": d3_samples,
        "first_doubled_margin_failure_s": d3_first_margin_fail,
        "d3_exit": d3_exit.as_ref().map(|(t, e)| json!({"t_s": t, "label": "D3 (a) EXIT: the run ends here under S2-D23; continued to the end for information only", "verdict": e})),
        "rule": "S2-D23 as approved: the extension holds per accepted state while the doubled-water-term margin >= the record's shutdown_margin_minimum; a state admitted by neither the compiled domains nor the extension is the labelled exit"});
    let receipt = json!({
        "kind": "s2-10-trip-probe",
        "status": "NOT-EVIDENCE probe; S2 is not declared and no gate is judged; PREVIEW (critic H4): recorded before any TBD fill. The start is the state named in settled_state; its composition (G6 PZR block, packet) is the packet's",
        "provenance": spine::provenance(),
        "preparation": preparation,
        "settled_state": {"path": state_path, "sha256": spine::sha256(&state_bytes), "t_s": t0},
        "derived_tolerance": derived_receipt,
        "d3": d3_summary,
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

/// D3 (a)'s record and the regions' reference water densities, if the run
/// names one (see `trip`).
fn post_trip_record() -> Option<(post_trip_domain::Extension, Vec<f64>)> {
    let (_, bytes) = spine::packet_bytes();
    let raw: Value = serde_json::from_slice(&bytes).expect("packet json");
    let record = match raw.get("post_trip_domain") {
        Some(v) => v.clone(),
        None => serde_json::from_slice(
            &std::fs::read(std::env::var_os("LD01_POST_TRIP_DOMAIN")?)
                .expect("post-trip domain file"),
        )
        .expect("post-trip domain json"),
    };
    let reference = raw["feedback_metadata"]["regions"]
        .as_array()
        .expect("feedback regions")
        .iter()
        .map(|r| r["reference_density_kg_m3"].as_f64().unwrap())
        .collect();
    Some((
        serde_json::from_value(record).expect("post-trip domain record"),
        reference,
    ))
}

/// D3 (a) at one accepted output (after the joined evaluation there): the
/// compiled-domain admission that decides under S2-D23 (no extension), and
/// the margin of the source-free operator with the water term doubled and
/// nominal (`delta*` from the 24 x 24 pencil by dggev).
fn d3_at(
    j: &leitbild_operating_plant::joined::operator::Joined<leitbild_operating_water::If97>,
    extension: &post_trip_domain::Extension,
    reference: &[f64],
    t: f64,
) -> Value {
    use leitbild_operating_plant::source_feedback as sf;
    let n = j.nuclear();
    let at = post_trip_domain::AcceptedConditions::of(n, j.travel(), t);
    let feedback = n.feedback();
    let mut out = sf::Output::new(
        feedback.region_count(),
        feedback.material_count(),
        feedback.support_count(),
    );
    let original = match feedback.validate_accepted(&at.neutrons, at.conditions(), t, &mut out) {
        Ok(()) => json!("inside"),
        Err(e) => json!(format!("{e:?}")),
    };
    let margin = |e: &post_trip_domain::Extension| -> Value {
        match post_trip_domain::margin_at(
            feedback,
            n.kinetics(),
            post_trip_domain::fixed(n),
            &at.neutrons,
            at.conditions(),
            e,
        ) {
            Ok(m) => {
                let r = m.reactivity_gain.len();
                let mut g = vec![0.; r * r];
                for i in 0..r {
                    g[i * r + i] = m.reactivity_gain[i];
                }
                let delta = leitbild_operating_water::spectrum::decompose(r, &m.operator, &g)
                    .map(|s| {
                        s.modes
                            .iter()
                            .map(|x| x.lambda.re)
                            .fold(f64::INFINITY, f64::min)
                    })
                    .ok();
                json!({"holds": m.holds, "margin_dk_k": delta})
            }
            Err(e) => json!({"error": format!("{e:?}")}),
        }
    };
    let mut nominal = *extension;
    nominal.margin_water_term_factor = 1.;
    let water = j.region_water();
    let ratio: Vec<f64> = water
        .iter()
        .zip(reference)
        .map(|(w, r)| w.density_kg_m3.value / r)
        .collect();
    let fold = |v: &mut dyn Iterator<Item = f64>, max: bool| {
        v.fold(
            if max {
                f64::NEG_INFINITY
            } else {
                f64::INFINITY
            },
            |a, b| {
                if max { a.max(b) } else { a.min(b) }
            },
        )
    };
    json!({"original_domain": original,
        "density_ratio_max": fold(&mut ratio.iter().copied(), true),
        "pressure_min_pa": fold(&mut water.iter().map(|w| w.pressure_pa.value), false),
        "moderator_k_min": fold(&mut water.iter().map(|w| w.temperature_k.value), false),
        "fuel_feedback_k_max": fold(&mut j.fuel_feedback_temperatures().iter().map(|x| x.value), true),
        "margin_water_doubled": margin(extension), "margin_water_nominal": margin(&nominal)})
}

/// S3-D1 measurement (NOT-EVIDENCE): two C0 held-input changes, the SG
/// owner's STOP ramp start (the TG TRIP command to the secondary owner
/// only, so no rod root is armed) and the ramp's end 0.3 s later, applied
/// after 1 s of quiet history from the settled state by the two policies an
/// event policy can choose:
/// (a) `discrete_restart` at each (exact start, IDAReInit, 1e-4 s first
///     step), and
/// (b) stop exactly at each (`stop_at`), let the owner take the change and
///     continue the retained BDF history (no reinitialization; the steam
///     demand is continuous in value, only its slope changes),
/// plus (c) the same stops with no change. Each runs 0.5 s past the first
/// change; the receipt compares counts, solver CPU and the end states in the
/// integrator's error weights. `LD01_S3D1_RECEIPT` names a new receipt. A
/// change that arms a root function (the full TG TRIP arms the rods'
/// release roots) cannot be continued this way: stock IDA reports the
/// root function's jump as a root at the first step.
#[test]
#[ignore = "NOT-EVIDENCE S3-D1 measurement: requires the joined packet, a settled state, the wiki, IF97 and stock IDA/KLU"]
fn s3_d1_restart_against_stop_and_continue_at_a_c0_kink() {
    let state_path = std::env::var("LD01_S2_TRIP_STATE").expect("LD01_S2_TRIP_STATE");
    let receipt_path = std::env::var_os("LD01_S3D1_RECEIPT");
    if let Some(p) = &receipt_path {
        assert!(
            !std::path::Path::new(p).exists(),
            "receipts are never overwritten"
        );
    }
    let state: Value =
        serde_json::from_slice(&std::fs::read(&state_path).expect("state")).expect("state json");
    let vector = |k: &str| -> Vec<f64> {
        state[k]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect()
    };
    let t0 = state["t_s"].as_f64().unwrap();
    let quiet_s = 1.;
    let after_s = 0.5;
    let restart = Restart {
        newton_coefficient: NEWTON_COEFFICIENT,
        delta_cj_lsetup: DELTA_CJ_LSETUP,
        first_step_s: FIRST_STEP_S,
        start_bound: 1e-12,
        start_passes: 2,
        // Lead decision S2-D21: P_tx after an owner transaction.
        transaction_passes: 12,
        bound_placement: 1e-12,
    };
    // `refine` divides both tolerances (the reference: the restart policy
    // at rtol/10, as S2's hold reference).
    let run = |policy: &str, refine: f64| -> Value {
        let Started {
            joined,
            ids,
            network_ids,
            atol,
            rtol,
            structure,
            analyses,
            ..
        } = started_full_composition();
        let (atol, rtol): (Vec<f64>, f64) =
            (atol.iter().map(|a| a / refine).collect(), rtol / refine);
        let labels: Vec<String> = joined
            .layouts()
            .iter()
            .flat_map(|(_, l)| l.labels.clone())
            .collect();
        let (mut y, mut yp) = (vector("y"), vector("yp"));
        let nonnegative = joined.network.nonnegative_stocks();
        let mut ida = Ida::new(
            Integrated::from_blocks(joined, structure, analyses).unwrap(),
            Initial {
                time: t0,
                y: &y,
                yp: &yp,
                differential: &ids,
                absolute_tolerance: &atol,
                relative_tolerance: rtol,
            },
        )
        .unwrap();
        ida.set_max_order(MAX_ORDER).unwrap();
        ida.constrain_nonnegative(&nonnegative).unwrap();
        restart.configure(&mut ida).unwrap();
        let t1 = t0 + quiet_s;
        ida.stop_at(t1).unwrap();
        let mut t = t0;
        while t < t1 {
            t = ida
                .advance((t + 0.1).min(t1), &mut y, &mut yp)
                .unwrap()
                .reached()
                .unwrap();
        }
        let before = ida.stats().unwrap();
        let h_before = before.current_step;
        let started = z1::cpu_s();
        let mut restart_cpu = 0.;
        // Counts accumulate over IDAReInit segments (a restart zeroes them).
        let mut total = [0i64; 8];
        let base = counts(&before);
        let mut segment_base = base;
        let mut add = |ida: &Ida<Integrated<leitbild_operating_water::If97>>, from: [i64; 8]| {
            let c = counts(&ida.stats().unwrap());
            for k in 0..8 {
                total[k] += c[k] - from[k];
            }
        };
        let change = |ida: &mut Ida<Integrated<leitbild_operating_water::If97>>,
                      t: f64,
                      y: &mut Vec<f64>,
                      first: bool|
         -> f64 {
            match policy {
                "stop only" => 0.,
                _ => {
                    let joined = &mut ida.system_mut().joined;
                    if first {
                        joined
                            .secondary_mut()
                            .unwrap()
                            .command(t, Command::TurbineTrip)
                            .unwrap();
                    } else {
                        let done = joined.time_events(t, y).unwrap();
                        assert_eq!(done.len(), 1, "the ramp end");
                    }
                    if policy == "restart" {
                        let timer = z1::cpu_s();
                        discrete_restart(
                            ida,
                            t,
                            Discrete::TimeEvent,
                            y,
                            &network_ids,
                            &atol,
                            rtol,
                            &restart,
                        )
                        .unwrap();
                        z1::cpu_s() - timer
                    } else {
                        0.
                    }
                }
            }
        };
        add(&ida, segment_base);
        restart_cpu += change(&mut ida, t1, &mut y, true);
        segment_base = if policy == "restart" { [0; 8] } else { base };
        let end = t1 + after_s;
        let ramp_end = t1 + 0.3;
        let mut ramp_done = false;
        while t < end {
            let stop = if ramp_done { end } else { ramp_end };
            ida.stop_at(stop).unwrap();
            t = ida
                .advance((t + 0.01).min(stop), &mut y, &mut yp)
                .unwrap()
                .reached()
                .unwrap();
            if !ramp_done && t == ramp_end {
                ramp_done = true;
                if policy == "restart" {
                    add(&ida, segment_base);
                    segment_base = [0; 8];
                }
                restart_cpu += change(&mut ida, t, &mut y, false);
            }
        }
        add(&ida, segment_base);
        let after = ida.stats().unwrap();
        json!({"policy": policy, "tolerance_divisor": refine, "h_before_s": h_before, "restart_cpu_s": restart_cpu,
            "cpu_s_to_end": z1::cpu_s() - started,
            "counts_after_change": named(&total),
            "last_step_s": after.last_step, "y": y, "atol": atol, "rtol": rtol, "labels": labels})
    };
    let runs: Vec<Value> = [
        ("restart", 1.),
        ("stop and continue", 1.),
        ("stop only", 1.),
        ("restart", 10.),
    ]
    .into_iter()
    .map(|(p, f)| run(p, f))
    .collect();
    let y_of = |r: &Value| -> Vec<f64> {
        r["y"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect()
    };
    let rtol = runs[0]["rtol"].as_f64().unwrap();
    let atol: Vec<f64> = runs[0]["atol"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    let labels: Vec<String> = runs[0]["labels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    // Each policy's end state against the refined reference, in the
    // contract's error weights.
    let against = |y: &[f64], reference: &[f64]| -> Value {
        let (mut sum, mut max, mut at) = (0., 0_f64, 0usize);
        for i in 0..y.len() {
            let w = 1. / (rtol * reference[i].abs() + atol[i]);
            let d = (y[i] - reference[i]) * w;
            sum += d * d;
            if d.abs() > max {
                (max, at) = (d.abs(), i);
            }
        }
        json!({"wrms_in_error_weights": (sum / y.len() as f64).sqrt(), "max_weighted": max, "max_at": labels[at]})
    };
    let reference = y_of(&runs[3]);
    let receipt = json!({
        "kind": "s3-d1-c0-kink-policy-measurement",
        "status": "NOT-EVIDENCE measurement for the S3-D1 event-policy draft; provisional settled state (pre-G18)",
        "provenance": spine::provenance(),
        "settled_state": state_path, "quiet_history_s": quiet_s, "after_change_s": after_s,
        "change": "the SG owner's STOP ramp (TG TRIP to the secondary owner only): steam demand ramps linearly to zero over 0.3 s; two C0 kinks (start, end), no rod involvement",
        "runs": runs.iter().map(|r| json!({"policy": r["policy"], "tolerance_divisor": r["tolerance_divisor"], "h_before_s": r["h_before_s"], "restart_cpu_s": r["restart_cpu_s"],
            "cpu_s_to_end": r["cpu_s_to_end"], "counts_after_change": r["counts_after_change"], "last_step_s": r["last_step_s"]})).collect::<Vec<_>>(),
        "against_the_rtol_over_10_restart_reference_at_end": {
            "restart": against(&y_of(&runs[0]), &reference),
            "stop_and_continue": against(&y_of(&runs[1]), &reference),
            "stop_only_no_change": against(&y_of(&runs[2]), &reference)},
    });
    println!("{}", serde_json::to_string(&receipt).unwrap());
    if let Some(p) = &receipt_path {
        std::fs::write(p, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    }
}

/// S2-D24's derived class for the rods' guide currents at one state.
struct DerivedTolerance {
    t_s: f64,
    /// The guide-current coordinates (= their passage rows).
    indices: Vec<usize>,
    scaled: f64,
    atol_m_kg_s: f64,
    atol_p_pa: f64,
    /// |dm/d(dp)| per cluster (kg/s per Pa), and the class value (the
    /// smallest: the tightest tolerance).
    sensitivity: Vec<f64>,
    class_sensitivity: f64,
    pressures: [String; 2],
    same_sign_rows: usize,
}
impl DerivedTolerance {
    fn receipt(&self) -> Value {
        let mut s = self.sensitivity.clone();
        s.sort_by(f64::total_cmp);
        json!({"state_t_s": self.t_s, "coordinates": self.indices.len(),
            "atol_p_pa": self.atol_p_pa, "pressures": self.pressures,
            "sensitivity_kg_s_per_pa": {"class_value_min": self.class_sensitivity, "median": s[s.len() / 2], "max": s[s.len() - 1]},
            "atol_m_kg_s": self.atol_m_kg_s, "scaled": self.scaled,
            "rows_with_same_sign_pressure_partials": self.same_sign_rows,
            "rodcost_fit_kg_s_per_pa": 4.8e-6})
    }
}

/// atol_m = atol_p x |dm/d(dp)| (S2-D24) from the block Jacobian A = dF/dy at
/// (t, y, yp): per guide-current row, the implicit sensitivity of the
/// current to its two plena, dm/dp_j = -(dR/dp_j)/(dR/dm), and the
/// difference sensitivity (dm/dp_a - dm/dp_b)/2; atol_p is the pressure
/// class's own absolute tolerance at those plena. The class value takes the
/// smallest sensitivity over the clusters.
fn derived_guide_current_tolerance(
    joined: &mut leitbild_operating_plant::joined::operator::Joined<leitbild_operating_water::If97>,
    structure: &leitbild_operating_plant::joined::blocks::JoinedJacobian,
    t: f64,
    y: &[f64],
    yp: &[f64],
    atol: &[f64],
    relative_basis: Option<f64>,
) -> DerivedTolerance {
    use leitbild_operating_plant::joined::blocks::{Classes, jacobian_blocks};
    let mut values = vec![0.; structure.pattern.nonzeros()];
    jacobian_blocks(joined, structure, t, 0., y, yp, &mut values, Classes::ALL)
        .expect("block Jacobian");
    let scales = joined.scales();
    let classes: Vec<(String, String)> = joined
        .layouts()
        .iter()
        .flat_map(|(owner, l)| {
            l.labels
                .iter()
                .zip(&l.classes)
                .map(move |(label, class)| (format!("{owner}/{class:?}"), label.clone()))
        })
        .collect();
    let guide: Vec<usize> = (0..classes.len())
        .filter(|i| classes[*i].0 == "rods/GuideCurrent")
        .collect();
    let is_guide: std::collections::BTreeSet<usize> = guide.iter().copied().collect();
    let pressure = |j: usize| classes[j].0 == "network/CellPressure";
    // Per guide row: its own diagonal and its pressure partials.
    let mut rows: BTreeMap<usize, (f64, Vec<(usize, f64)>)> = BTreeMap::new();
    let (pointers, indices) = (structure.pattern.pointers(), structure.pattern.indices());
    for j in 0..classes.len() {
        for q in pointers[j]..pointers[j + 1] {
            let r = indices[q];
            if !is_guide.contains(&r) {
                continue;
            }
            let e = rows.entry(r).or_default();
            if r == j {
                e.0 = values[q];
            } else if pressure(j) && values[q] != 0. {
                e.1.push((j, values[q]));
            }
        }
    }
    let mut sensitivity = Vec::new();
    let mut same_sign = 0;
    let mut plena: Option<[usize; 2]> = None;
    for r in &guide {
        let (diagonal, partials) = &rows[r];
        assert!(*diagonal != 0., "guide row {r} has no own partial");
        let mut d: Vec<(usize, f64)> = partials
            .iter()
            .map(|(j, a)| (*j, -(a / scales[*j]) / (diagonal / scales[*r])))
            .collect();
        d.sort_by(|a, b| b.1.abs().total_cmp(&a.1.abs()));
        assert!(d.len() >= 2, "guide row {r} reads fewer than two plena");
        let (a, b) = (d[0], d[1]);
        if a.1.signum() == b.1.signum() {
            same_sign += 1;
        }
        let (high, low) = if a.1 >= b.1 { (a, b) } else { (b, a) };
        plena.get_or_insert([high.0, low.0]);
        sensitivity.push(((high.1 - low.1) / 2.).abs());
    }
    let [pa, pb] = plena.expect("guide currents");
    let atol_p_pa = match relative_basis {
        Some(rtol) => rtol * (y[pa] * scales[pa]).abs().min((y[pb] * scales[pb]).abs()),
        None => (atol[pa] * scales[pa]).min(atol[pb] * scales[pb]),
    };
    let class_sensitivity = sensitivity.iter().copied().fold(f64::INFINITY, f64::min);
    let atol_m_kg_s = atol_p_pa * class_sensitivity;
    let scaled_by_index: Vec<f64> = guide.iter().map(|i| atol_m_kg_s / scales[*i]).collect();
    let scaled = scaled_by_index[0];
    assert!(
        scaled_by_index.iter().all(|s| *s == scaled),
        "the guide currents share one scale"
    );
    DerivedTolerance {
        t_s: t,
        indices: guide,
        scaled,
        atol_m_kg_s,
        atol_p_pa,
        sensitivity,
        class_sensitivity,
        pressures: [classes[pa].1.clone(), classes[pb].1.clone()],
        same_sign_rows: same_sign,
    }
}
