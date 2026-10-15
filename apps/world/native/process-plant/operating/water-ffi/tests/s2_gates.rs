//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#s2-declaration-joined-hot-spine-at-power
//! The S2 gate harness on the actual joined packet (S2-14).
//!
//! The configuration, gates and budgets are read as data from their owners:
//! `ld01-s2-gates` and `ld01-s2-accuracy` (the S2 declaration page,
//! `LD01_S2_DECLARATION`), and the values S2 shares from `ld01-s1-gates` and
//! `ld01-accuracy-contract` (the wiki under `LD01_WIKI_ROOT`). Nothing is
//! retuned here. Every receipt carries the full schema of
//! `s2_harness/receipt.rs` and is written only to a new file.
//!
//! - `s2_gate_run` (ignored): the declared sequence; it refuses before any
//!   work unless the gates are pinned, no TBD is open and S1 run 6 and the
//!   zero-time receipts are named.
//! - `s2_smoke` (ignored, M4): a short hold and trip from a saved settled
//!   state through the same runner, NOT evidence.
//! - unit tests on fixtures and synthetic signals: the declaration's reading,
//!   the pin and TBD refusals, the work-bound pre-check, the cap rule, the
//!   comparisons, located-event timing, the settling measure and the
//!   settle-cap fit.
//!
//! The harness needs stock IDAS (`--features quadratures` with the IDAS
//! prefix): every S2 run integrates its conservation ledgers as stock
//! quadratures (K2).
#![cfg(feature = "quadratures")]
#[path = "common/counts.rs"]
mod counts;
#[path = "common/cpu.rs"]
mod cpu;
#[path = "common/filter.rs"]
mod filter;
#[path = "common/observe.rs"]
mod observe;
#[path = "common/provenance.rs"]
mod provenance;
mod s2_harness;
pub use s2_harness::{
    compare, compose, conservation, gates, guards, meter, outputs, receipt, run, runner, sequence,
};

use compare::{Credited, key};
use gates::{Block, Declaration};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Revision 7's blocks and the shared S1 blocks, as the unit tests'
/// fixtures (the harness itself reads the declaration page and the wiki).
const GATES_R7: &str = include_str!("s2_harness/fixtures/ld01-s2-gates-r7.json");
/// The published r7.1 block (spec wiki 80e78b6), pinned by RP1-pin-r7.1.
const GATES_R7_1: &str = include_str!("s2_harness/fixtures/ld01-s2-gates-r7.1.json");
const ACCURACY_R7: &str = include_str!("s2_harness/fixtures/ld01-s2-accuracy-r7.json");
const S1_GATES: &str = include_str!("s2_harness/fixtures/ld01-s1-gates.json");
const CONTRACT: &str = include_str!("s2_harness/fixtures/ld01-accuracy-contract.json");

fn fixture() -> Declaration {
    Declaration {
        gates: Block::from_json("ld01-s2-gates", GATES_R7).unwrap(),
        accuracy: Block::from_json("ld01-s2-accuracy", ACCURACY_R7).unwrap(),
        shared: Block::from_json("ld01-s1-gates", S1_GATES).unwrap(),
        contract: Block::from_json("ld01-accuracy-contract", CONTRACT).unwrap(),
    }
}

/// `gates` with `pointer` set to `value`.
fn with(text: &str, pointer: &str, value: Value) -> Block {
    let mut v: Value = serde_json::from_str(text).unwrap();
    *v.pointer_mut(pointer).unwrap() = value;
    Block::from_json("ld01-s2-gates", &v.to_string()).unwrap()
}

// ------------------------------------------------------- declaration data

/// Zero-time check of the declaration, NOT S2 evidence: the blocks load
/// from their pages and pass the declaration's own checks; the declared
/// SHA-256 the pin compares, the TBD register's state and every value no
/// harness code consumes are printed.
#[test]
#[ignore = "requires the S2 declaration page and the wiki"]
fn s2_declared_gates() {
    let d = Declaration::load().unwrap_or_else(|e| panic!("{e}"));
    let log = std::fs::read_to_string(guards::decision_log_page()).ok();
    let pin = guards::pin(&d.gates, log.as_deref()).unwrap();
    let tbd = guards::tbd_state(&d.gates, log.as_deref()).unwrap();
    compare::Budgets::from(&d).unwrap();
    println!(
        "{}",
        json!({"kind": "s2-declared-gates-NOT-EVIDENCE", "declaration": d.receipt()["page"],
            "pin": pin, "tbd": tbd, "gate_run_refusals": guards::gate_run_refusals(&pin, &tbd),
            "unread": d.unread()})
    );
}

#[test]
fn every_declared_value_is_read_by_pointer_and_the_unread_ones_are_listed() {
    let gates = Block::from_json("ld01-s2-gates", GATES_R7).unwrap();
    assert_eq!(gates.number("/hold/duration_s"), 300.);
    assert_eq!(gates.open_number("/settling/maxCpu_s"), None);
    assert_eq!(gates.open_number("/settling/window_s"), Some(20.));
    assert_eq!(gates.count("/r0ReportOnly/stepCap"), 3750);
    assert!(gates.flag("/trip/requireSeating"));
    assert_eq!(gates.texts("/spectral/states").len(), 2);
    let unread = gates.unread();
    assert!(!unread.contains(&"/hold/duration_s".to_string()));
    assert!(
        unread.contains(&"/ledger/trapezoid".to_string()),
        "{unread:?}"
    );
    // An array is one leaf; an object read whole covers its leaves.
    assert!(!unread.contains(&"/spectral/states".to_string()));
    gates.whole("/directionalCheck");
    assert!(
        !gates
            .unread()
            .iter()
            .any(|p| p.starts_with("/directionalCheck/"))
    );
    // A missing or mistyped key refuses loudly.
    let missing = std::panic::catch_unwind(|| {
        Block::from_json("ld01-s2-gates", GATES_R7)
            .unwrap()
            .number("/hold/notDeclared")
    });
    assert!(missing.is_err());
    let mistyped = std::panic::catch_unwind(|| {
        Block::from_json("ld01-s2-gates", GATES_R7)
            .unwrap()
            .number("/build")
    });
    assert!(mistyped.is_err());
    // The fixture's budgets read from their owners.
    let b = compare::Budgets::from(&fixture()).unwrap();
    assert_eq!(b.power_basis_w, 2_992_500_000.);
    assert_eq!(b.insertion_fractions, [0.1, 0.5, 0.9, 1.0]);
    assert_eq!(b.observation_s, 0.002);
}

#[test]
fn a_fenced_block_is_found_once_and_refused_when_absent_or_repeated() {
    let page = "text\n```ld01-s2-gates\n{\"a\":1}\n```\nmore\n";
    assert_eq!(
        gates::fenced(page, "ld01-s2-gates", "p").unwrap(),
        "{\"a\":1}"
    );
    assert!(gates::fenced(page, "ld01-s2-accuracy", "p").is_err());
    let twice = format!("{page}{page}");
    assert!(gates::fenced(&twice, "ld01-s2-gates", "p").is_err());
    assert!(gates::fenced("```ld01-s2-gates\n{", "ld01-s2-gates", "p").is_err());
}

// ---------------------------------------------------------------- receipts

/// A receipt with every schema section, as the runner assembles one.
fn complete_receipt() -> Value {
    let mut r = json!({});
    for p in receipt::TOP_SCHEMA {
        receipt::put(&mut r, p, Value::Null);
    }
    for p in ["/runs", "/comparisons", "/zero_time", "/work_bound/runs"] {
        receipt::put(&mut r, p, json!({}));
    }
    receipt::put(&mut r, "/gates", json!([]));
    receipt::put(&mut r, "/sequence", json!([]));
    let mut record = run::RunRecord {
        spec: Some(run::RunSpec {
            name: "hold".into(),
            duration_s: 10.,
            window_s: 10.,
            rtol: 1e-5,
            atol_factor: 1.,
            max_step_s: None,
            newton_coefficient: 0.33,
            delta_cj_lsetup: 0.1,
            first_step_s: 1e-4,
            max_order: 2,
            output_s: 0.1,
            observation_s: Some(0.002),
            commands: Vec::new(),
            solver_cap_s: 2.,
            total_guard_s: 3.,
            report_only_step_cap: None,
            caps_report_only: true,
            rods_observed: false,
            domain_exit_stops: true,
        }),
        process_cpu_s: 1.,
        ..run::RunRecord::default()
    };
    record.cpu.residual_s = 0.5;
    record
        .restarts
        .push(json!({"t_s": 0.2, "kind": "time event"}));
    r["runs"]["hold"] = record.json();
    r["comparisons"]["hold_vs_reference"] = json!({"run": "hold", "reference": "holdReference", "window_s": 10., "metrics": {}, "within": true});
    r["gates"] = json!([receipt::gate(
        "hold.cost",
        json!(0.01),
        json!(0.1),
        true,
        true,
        "hold.budget_cpu_s_per_s"
    )]);
    r
}

#[test]
fn the_receipt_schema_names_every_section_and_refuses_a_gap() {
    let r = complete_receipt();
    assert_eq!(receipt::missing(&r), Vec::<String>::new());
    assert_eq!(
        r["runs"]["hold"]["restart_count_by_kind"]["time event"],
        json!(1)
    );
    assert_eq!(r["runs"]["hold"]["cpu"]["attributed_fraction"], json!(0.5));
    // Stock KLU inside IDASolve is null until the lead's timing shim.
    assert_eq!(
        r["runs"]["hold"]["cpu"]["buckets"]["klu_solve_s"],
        Value::Null
    );
    // Each level of the schema is checked: top, run, comparison and gate.
    for (pointer, expected) in [
        ("/machine", "/machine/cpu_model"),
        ("/declaration/pin", "/declaration/pin"),
        ("/runs/hold/ledger", "/runs/hold/ledger/gate"),
        (
            "/runs/hold/cpu/buckets",
            "/runs/hold/cpu/buckets/klu_solve_s",
        ),
        ("/runs/hold/domain", "/runs/hold/domain"),
        (
            "/comparisons/hold_vs_reference/within",
            "/comparisons/hold_vs_reference/within",
        ),
        ("/gates/0/basis", "/gates/0/basis"),
    ] {
        let mut gap = r.clone();
        let (parent, key) = pointer.rsplit_once('/').unwrap();
        gap.pointer_mut(parent)
            .and_then(|v| v.as_object_mut())
            .map(|m| m.remove(key))
            .or_else(|| {
                gap.pointer_mut(parent)
                    .and_then(|v| v.as_array_mut())
                    .map(|a| Some(a.remove(key.parse().unwrap())))
            })
            .unwrap();
        let missing = receipt::missing(&gap);
        assert!(
            missing.iter().any(|m| m == expected),
            "{pointer}: {missing:?}"
        );
    }
    // A run without its declared spec lacks its configuration.
    let bare = run::RunRecord::default();
    assert!(
        bare.gaps()
            .iter()
            .any(|g| g.ends_with("/configuration/duration_s"))
    );
    // An incomplete receipt is never written, and no receipt is overwritten.
    let dir = std::env::temp_dir().join(format!("s2-receipt-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("receipt.json");
    assert!(receipt::write(&path, &json!({})).is_err());
    assert!(!path.exists());
    receipt::write(&path, &r).unwrap();
    assert!(receipt::write(&path, &r).is_err());
    std::fs::remove_dir_all(&dir).unwrap();
}

// ----------------------------------------------------- pin, TBD, work bound

#[test]
fn the_pin_refuses_unless_the_declared_sha_equals_the_logged_rp1_row() {
    let gates = Block::from_json("ld01-s2-gates", GATES_R7).unwrap();
    let declared = guards::declared_sha256(&gates).unwrap();
    assert_eq!(declared.len(), 64);
    // No log, a log without a pin row, and a wrong pin all refuse.
    for log in [
        None,
        Some("| ID | Date | Decision |\n| --- | --- | --- |\n| RP1 | 14 Oct | Frozen gates |\n"),
        Some(&*format!(
            "| RP1-pin | 15 Oct | ld01-s2-gates frozen | sha256 {} |\n",
            "0".repeat(64)
        )),
    ] {
        let pin = guards::pin(&gates, log).unwrap();
        assert_eq!(pin["pinned"], json!(false), "{pin}");
        assert!(!guards::gate_run_refusals(&pin, &json!({})).is_empty());
    }
    // The matching row pins; the last matching row in page order counts.
    let log = format!(
        "| RP1-pin | 15 Oct | ld01-s2-gates frozen | sha256 {} |\n| RP1-pin | 16 Oct | ld01-s2-gates re-pinned | sha256 {declared} |\n",
        "a".repeat(64)
    );
    let pin = guards::pin(&gates, Some(&log)).unwrap();
    assert_eq!(pin["pinned"], json!(true), "{pin}");
    assert_eq!(pin["frozen_sha256"], json!(declared));
    // A row naming two SHA values is ambiguous and refuses.
    let two = format!("| RP1-pin | x | ld01-s2-gates | {declared} {declared} |\n");
    assert!(guards::pin(&gates, Some(&two)).is_err());
    // Filling a TBD leaves the declared SHA unchanged (a fill is not a
    // revision); changing any declared value changes it.
    let filled = with(GATES_R7, "/caps_cpu_s/trip", json!(42.));
    assert_eq!(guards::declared_sha256(&filled).unwrap(), declared);
    assert_ne!(
        guards::sha256_bytes(guards::canonical(&filled.value).as_bytes()).unwrap(),
        guards::sha256_bytes(guards::canonical(&gates.value).as_bytes()).unwrap()
    );
    let changed = with(GATES_R7, "/hold/budget_cpu_s_per_s", json!(0.2));
    assert_ne!(guards::declared_sha256(&changed).unwrap(), declared);
    // Canonical JSON sorts keys at every level.
    assert_eq!(
        guards::canonical(&json!({"b": [1, {"d": 2, "c": 3}], "a": null})),
        r#"{"a":null,"b":[1,{"c":3,"d":2}]}"#
    );
}

#[test]
fn a_gate_run_refuses_while_a_tbd_is_open_unlogged_or_undeclared() {
    let gates = Block::from_json("ld01-s2-gates", GATES_R7).unwrap();
    let declared = guards::declared_sha256(&gates).unwrap();
    let pin_row = format!("| RP1-pin | 15 Oct | ld01-s2-gates frozen | sha256 {declared} |\n");
    let pin = guards::pin(&gates, Some(&pin_row)).unwrap();
    // Revision 7 as drafted: every listed TBD is open.
    let tbd = guards::tbd_state(&gates, Some(&pin_row)).unwrap();
    let listed = gates.value["tbd"].as_object().unwrap().len();
    assert!(listed >= 17, "{tbd}");
    let open = tbd["open"].as_array().unwrap().len();
    assert_eq!(open, listed, "{tbd}");
    let refusals = guards::gate_run_refusals(&pin, &tbd);
    assert_eq!(refusals.len(), listed, "{refusals:?}");
    assert!(
        refusals
            .iter()
            .any(|r| r.contains("totalGuard.perSampleObservation_s"))
    );
    // Every TBD filled: an unlogged fill still refuses; a fill row naming
    // the key and a receipt SHA admits it.
    let mut v: Value = serde_json::from_str(GATES_R7).unwrap();
    let keys: Vec<String> = v["tbd"].as_object().unwrap().keys().cloned().collect();
    for k in &keys {
        *v.pointer_mut(&guards::dotted_pointer(k)).unwrap() = json!(1.0);
    }
    let all = Block::from_json("ld01-s2-gates", &v.to_string()).unwrap();
    assert_eq!(guards::declared_sha256(&all).unwrap(), declared);
    let tbd = guards::tbd_state(&all, Some(&pin_row)).unwrap();
    assert_eq!(tbd["unlogged_fills"], json!(listed));
    assert_eq!(guards::gate_run_refusals(&pin, &tbd).len(), listed);
    let mut log = pin_row.clone();
    for (i, k) in keys.iter().enumerate() {
        log.push_str(&format!(
            "| S2-F{i} | 16 Oct | fill {k} | receipt sha256 {} |\n",
            "b".repeat(64)
        ));
    }
    let tbd = guards::tbd_state(&all, Some(&log)).unwrap();
    assert_eq!(tbd["closed"], json!(true), "{tbd}");
    assert!(guards::gate_run_refusals(&pin, &tbd).is_empty());
    // A reopened value (S2-F01r's form: a row superseding the fill, with no
    // SHA) is unlogged until its own fill row; then that row counts, never
    // the superseded one.
    let logged = |log: &str| {
        let tbd = guards::tbd_state(&all, Some(log)).unwrap();
        let row = tbd["fills"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["key"] == "derivedTolerance.value_kg_s")
            .map(|f| f["logged_row"].clone())
            .unwrap();
        (row, tbd["unlogged_fills"].clone())
    };
    let first = keys
        .iter()
        .position(|k| k == "derivedTolerance.value_kg_s")
        .unwrap();
    assert_eq!(logged(&log), (json!(format!("S2-F{first}")), json!(0)));
    let reopened = format!(
        "{log}| S2-F{first}r | 17 Oct | the guide-current class value is open again | rule changed | Superseded: S2-F{first} |\n"
    );
    assert_eq!(logged(&reopened), (Value::Null, json!(1)));
    let refill = format!(
        "{reopened}| S2-F99 | 17 Oct | refill derivedTolerance.value_kg_s | receipt sha256 {} |\n",
        "c".repeat(64)
    );
    assert_eq!(logged(&refill), (json!("S2-F99"), json!(0)));
    // A null the register does not list refuses as undeclared.
    let stray = with(&v.to_string(), "/hold/duration_s", Value::Null);
    let tbd = guards::tbd_state(&stray, Some(&log)).unwrap();
    assert_eq!(tbd["undeclared_nulls"], json!(["/hold/duration_s"]));
    assert!(!guards::gate_run_refusals(&pin, &tbd).is_empty());
}

#[test]
fn a_run_that_does_not_fit_the_remaining_bound_is_not_started_and_s2_is_incomplete() {
    let gates = Block::from_json("ld01-s2-gates", GATES_R7).unwrap();
    let mut work = guards::WorkBound::new(&gates);
    assert_eq!(work.bound_s, 2700.);
    work.charge("S1 run 6", 1100.);
    work.charge("zero-time receipts", 150.);
    assert_eq!(work.admit("hold", 1400.), guards::Admission::Start);
    work.charge("hold", 1400.);
    let refused = work.admit("trip", 60.);
    assert_eq!(
        refused,
        guards::Admission::Incomplete {
            remaining_s: 50.,
            guard_s: 60.
        }
    );
    // An unbounded guard never starts.
    assert!(matches!(
        work.admit("R0", f64::INFINITY),
        guards::Admission::Incomplete { .. }
    ));
    let j = work.json();
    assert_eq!(j["within"], json!(true));
    assert_eq!(j["not_started"].as_array().unwrap().len(), 2);
    assert!(
        j["rule"]
            .as_str()
            .unwrap()
            .contains("incomplete, not failed")
    );
}

#[test]
fn declared_caps_are_read_as_data_and_refused_below_the_cap_rule() {
    let gates = Block::from_json("ld01-s2-gates", GATES_R7).unwrap();
    // Declared values: the hold's 60 is 2 x 0.1 x 300.
    let hold = guards::declared_cap(&gates, "hold", 300.).unwrap();
    assert_eq!(hold["cap_s"], json!(60.));
    assert_eq!(hold["floor_s"], json!(60.));
    // Open caps refuse while TBD.
    assert!(
        guards::declared_cap(&gates, "trip", 60.)
            .unwrap_err()
            .contains("open")
    );
    // A fill below 2 x budget (0.35 x 60 = 21) refuses; R1's floor is 160.
    let low = with(GATES_R7, "/caps_cpu_s/trip", json!(41.));
    assert!(guards::declared_cap(&low, "trip", 60.).is_err());
    let ok = with(GATES_R7, "/caps_cpu_s/trip", json!(42.));
    assert_eq!(
        guards::declared_cap(&ok, "trip", 60.).unwrap()["cap_s"],
        json!(42.)
    );
    let r1 = with(GATES_R7, "/caps_cpu_s/R1", json!(100.));
    assert!(guards::declared_cap(&r1, "R1", 20.).is_err());
    // The total guard needs the per-sample observation cost (TBD(HARNESS)).
    assert!(guards::total_guard(&gates, 60., 150_000.).is_err());
    let observed = with(
        GATES_R7,
        "/totalGuard/perSampleObservation_s",
        json!(0.0013),
    );
    assert!((guards::total_guard(&observed, 60., 150_000.).unwrap() - 450.).abs() < 1e-9);
}

#[test]
fn a_pressure_driven_current_takes_the_pressure_class_through_its_own_sensitivity() {
    // Three coordinates: pressures p0, p1 (atol 2 and 4) and an algebraic
    // current m (row 2): g = 3 m - 0.5 p0 + 0.5 p1 (m = (p0 - p1)/6), plus
    // a non-pressure coordinate 3 the row also reads.
    // CSC by column: col 0 rows {2}, col 1 rows {2}, col 2 rows {2},
    // col 3 rows {2, 3}.
    let pointers = [0, 1, 2, 3, 5];
    let rows = [2, 2, 2, 2, 3];
    let values = [-0.5, 0.5, 3., 100., 1.];
    let pressure = [true, true, false, false];
    let atol = [2., 4., 1e-8, 1e-8];
    let d = compose::derived_tolerances(&pointers, &rows, &values, &[2], &pressure, &atol).unwrap();
    // |dm/dp0| = |dm/dp1| = 1/6; the larger product is p1's: 4/6.
    assert!((d[0].0 - 4. / 6.).abs() < 1e-15, "{d:?}");
    assert!((d[0].1 - 1. / 6.).abs() < 1e-15);
    assert_eq!(d[0].2, 1);
    // A row without its diagonal, or reading no pressure, refuses.
    let no_diagonal = [-0.5, 0.5, 0., 100., 1.];
    assert!(
        compose::derived_tolerances(&pointers, &rows, &no_diagonal, &[2], &pressure, &atol)
            .is_err()
    );
    assert!(
        compose::derived_tolerances(&pointers, &rows, &values, &[2], &[false; 4], &atol).is_err()
    );
}

#[test]
fn d3_a_ends_a_run_only_where_the_predicate_does_not_admit_the_state() {
    use runner::{D3, d3_exit};
    // Inside the compiled domain, and in the extension while the margin
    // holds (S2-D23 as revised): the run continues.
    for admitted in [
        D3::Admitted {
            extended: false,
            margin_holds: false,
        },
        D3::Admitted {
            extended: true,
            margin_holds: true,
        },
    ] {
        assert_eq!(d3_exit(&admitted), None);
    }
    // Outside with the 1 % margin failed: the labelled margin exit.
    let failed = D3::Unsupported {
        margin_holds: false,
        exit: "density".into(),
    };
    assert_eq!(d3_exit(&failed), Some("D3 (a) margin exit"));
    let outside = D3::Unsupported {
        margin_holds: true,
        exit: "pressure".into(),
    };
    assert_eq!(d3_exit(&outside), Some("D3 (a) source-domain exit"));
}

#[test]
fn the_windows_external_receipts_are_checked_by_kind_and_charged() {
    let dir = std::env::temp_dir().join(format!("s2-external-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = |name: &str, v: Value| {
        let p = dir.join(name);
        std::fs::write(&p, v.to_string()).unwrap();
        p.to_str().unwrap().to_string()
    };
    let s1 = file(
        "s1.json",
        json!({"kind": "s1-hydraulics-admission", "verdict": "PASS: all S1 gates met", "app_commit": "abc"}),
    );
    let z6 = file(
        "z6.json",
        json!({"verdict": "GO: every gated Z6 predicate holds at this state"}),
    );
    let z7 = file("z7.json", json!({"failures": 0, "kind": "s2-z7"}));
    let z2 = file("z2.json", json!({"kind": "z2"}));
    let manifest: BTreeMap<String, Value> = [
        (
            "S1run6".to_string(),
            json!({"receipt": s1, "process_cpu_s": 19.0}),
        ),
        (
            "Z6composed".to_string(),
            json!({"receipt": z6, "process_cpu_s": 36.0}),
        ),
        (
            "Z7".to_string(),
            json!({"receipt": z7, "process_cpu_s": 65.0}),
        ),
        ("Z2".to_string(), json!({"receipt": z2, "reused": true})),
    ]
    .into();
    let (out, charges, refusals) =
        sequence::check_external(&manifest, &["S1run6", "Z6composed", "Z7", "Z2"], "abc");
    assert!(refusals.is_empty(), "{refusals:?}");
    assert_eq!(charges.iter().map(|c| c.1).sum::<f64>(), 120.);
    assert_eq!(out["Z2"]["reused"], json!(true));
    assert_eq!(out["S1run6"]["sha256"].as_str().unwrap().len(), 64);
    // Another app commit, a missing entry and an unmeasured run refuse.
    let (_, _, refusals) = sequence::check_external(&manifest, &["S1run6", "Z5"], "def");
    assert_eq!(refusals.len(), 2, "{refusals:?}");
    let mut unmeasured = manifest.clone();
    unmeasured.insert("Z7".into(), json!({"receipt": z7}));
    let (_, _, refusals) = sequence::check_external(&unmeasured, &["Z7"], "abc");
    assert_eq!(refusals.len(), 1, "{refusals:?}");
    // A red gate (Z6 NO-GO, Z3's margin not holding) is recorded, never a
    // refusal; S1 run 6 not passing refuses (above).
    let failing = file(
        "z6-no.json",
        json!({"verdict": "NO-GO: a resolved positive real part"}),
    );
    let z3 = file(
        "z3.json",
        json!({"z3_envelope": {"every_point_holds_with_water_term_doubled": false}}),
    );
    let mut nogo = manifest.clone();
    nogo.insert(
        "Z6composed".into(),
        json!({"receipt": failing, "process_cpu_s": 1.0}),
    );
    nogo.insert(
        "Z3settled".into(),
        json!({"receipt": z3, "process_cpu_s": 1.8}),
    );
    let (out, _, refusals) = sequence::check_external(&nogo, &["Z6composed", "Z3settled"], "abc");
    assert!(refusals.is_empty(), "{refusals:?}");
    assert_eq!(out["Z6composed"]["pass"], json!(false));
    assert_eq!(out["Z3settled"]["pass"], json!(false));
    let notz3 = file("z3-wrong.json", json!({"kind": "something else"}));
    nogo.insert(
        "Z3composed".into(),
        json!({"receipt": notz3, "process_cpu_s": 1.0}),
    );
    let (_, _, refusals) = sequence::check_external(&nogo, &["Z3composed"], "abc");
    assert_eq!(refusals.len(), 1, "{refusals:?}");
    // The zero-time gates in the verdict: red Z3, green Z7, Z1 judged,
    // an absent gate red, a reported one not judged.
    let z7 = sequence::check_external(&manifest, &["Z7"], "abc").0["Z7"].clone();
    let zero_time = json!({
        "composed": {"z1": {"residual": 2e-14, "constraint_rate": 1e-14, "bound": 1e-12}},
        "settled": {"z1": {"residual": 3e-13, "constraint_rate": 2e-12, "bound": 1e-12}},
        "external_phase1": {"Z7": z7}, "external_phase2": {"Z3settled": out["Z3settled"].clone()}});
    let gates = sequence::zero_time_gates(&zero_time);
    let verdict = |id: &str| {
        gates
            .iter()
            .find(|g| g["id"] == id)
            .map(|g| (g["pass"].clone(), g["judged"].clone()))
    };
    assert_eq!(
        verdict("zero_time.Z1.composed"),
        Some((json!(true), json!(true)))
    );
    assert_eq!(
        verdict("zero_time.Z1.settled"),
        Some((json!(false), json!(true)))
    );
    assert_eq!(
        verdict("zero_time.Z3.settled"),
        Some((json!(false), json!(true)))
    );
    assert_eq!(verdict("zero_time.Z7"), Some((json!(true), json!(true))));
    assert_eq!(
        verdict("zero_time.Z6.settled"),
        Some((json!(false), json!(true)))
    );
    assert_eq!(verdict("zero_time.Z2"), Some((json!(false), json!(false))));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn s2_d24r_takes_the_tightest_credited_budget_times_the_sensitivity() {
    // The rule from the published r7.1 block (pinned by RP1-pin-r7.1):
    // its class and rule text, the value open, the credited budgets the
    // comparison reads.
    let mut d = fixture();
    d.gates = Block::from_json("ld01-s2-gates", GATES_R7_1).unwrap();
    assert_eq!(
        guards::declared_sha256(&d.gates).unwrap(),
        "d4a6a84cf60e2038074f51db6fd4f07ffe14429cae36438287bd680f889fb88c"
    );
    let rule = compose::DerivedRule::from(&d).unwrap().unwrap();
    assert_eq!(rule.class, "rods/GuideCurrent");
    assert_eq!(rule.declared_kg_s, None);
    assert!(
        rule.rule
            .starts_with("atol_m = the tightest credited budget")
    );
    // Core DP's budget (50 Pa) and an SG pressure budget for the second
    // output below.
    let outputs = [
        (key::CORE_DP_PA, vec![0, 1]),
        (key::SG_PRESSURE_PA, vec![4]),
    ];
    let credited = rule.credited(&outputs).unwrap();
    assert_eq!(credited[0].budget_pa, 50.);
    let sg = credited[1].budget_pa;
    assert!(sg > 50., "{sg}");
    assert!(
        rule.credited(&[("pzr_roof_pa", vec![0])]).is_err(),
        "an output without an absolute budget refuses"
    );
    // Synthetic CSC, coordinates p0, p1 (core DP's, scaled 1e6 and 2e6 Pa),
    // m (row 2, scale 0.5 kg/s), q (scale 1), p4 (the SG output's, 1e6 Pa),
    // p5 (an uncredited pressure, 1e6 Pa):
    // row 2: 3 m - 0.5 p0 + 0.5 p1 + 100 q, so dm/dp0 = 1/6 scaled,
    //   = (1/6)(0.5/1e6) kg/s per Pa;
    // row 3: q - 2 p4 + 0.1 p1 (reads core DP's p1 and the SG output's p4);
    // row 5: p5 + m (reads m only, no credited output's coordinate).
    let scales = [1e6, 2e6, 0.5, 1., 1e6, 1e6];
    // Columns: 0 {2}, 1 {2, 3}, 2 {2, 5}, 3 {2, 3}, 4 {3}, 5 {5}.
    let pointers = [0, 1, 3, 5, 7, 8, 9];
    let rows = [2, 2, 3, 2, 5, 2, 3, 3, 5];
    let values = [-0.5, 0.5, 0.1, 3., 1., 100., 1., -2., 1.];
    let determined =
        compose::determined_tolerances(&pointers, &rows, &values, &[2, 3], &credited, &scales)
            .unwrap();
    // Row 2 determines core DP alone: 50 Pa x |dm/dp| over its columns
    // (p0's is the larger in SI units).
    let m = &determined[0];
    assert_eq!(m.len(), 1);
    assert_eq!(m[0].column, 0);
    let dm_dp = (0.5 / 3.) * 0.5 / 1e6;
    assert!((m[0].sensitivity - dm_dp).abs() < 1e-22, "{m:?}");
    assert!((m[0].tolerance - 50. * dm_dp).abs() < 1e-20);
    assert_eq!(m[0].output, key::CORE_DP_PA);
    // Row 3 reads both outputs' coordinates: the tightest comes first.
    let q = &determined[1];
    assert_eq!(q.len(), 2);
    assert!(q[0].tolerance <= q[1].tolerance, "{q:?}");
    let core: f64 = 50. * 0.1 * 1. / 2e6;
    let sg_tolerance = sg * 2. * 1. / 1e6;
    assert!(
        (q[0].tolerance - core.min(sg_tolerance)).abs() < 1e-18,
        "{q:?}"
    );
    // A row that reads no credited output's coordinate refuses, as does a
    // row without its diagonal.
    assert!(
        compose::determined_tolerances(&pointers, &rows, &values, &[5], &credited, &scales)
            .is_err()
    );
    let no_diagonal = [-0.5, 0.5, 0.1, 0., 1., 100., 1., -2., 1.];
    assert!(
        compose::determined_tolerances(&pointers, &rows, &no_diagonal, &[2], &credited, &scales)
            .is_err()
    );
}

#[test]
fn a_handed_over_state_is_read_back_bit_for_bit() {
    let dir = std::env::temp_dir().join(format!("s2-state-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let packet = compose::PacketFile {
        path: "/packet.json".into(),
        bytes: Vec::new(),
        sha256: "0".repeat(64),
    };
    // Values whose shortest decimal is long, and one subnormal.
    let y: Vec<f64> = (1..200)
        .map(|k| (k as f64).sqrt() * 1e-3 + 1. / 3.)
        .chain([f64::MIN_POSITIVE / 7., -0.1 - 0.2])
        .collect();
    let yp: Vec<f64> = y.iter().map(|v| v.sin() * 1e-9).collect();
    let start = runner::Start {
        t: 522.000000001,
        y: y.clone(),
        yp: yp.clone(),
        from: "test".into(),
        accepted: true,
    };
    let path = dir.join("state.json");
    sequence::write_state(&path, &packet, &start).unwrap();
    assert!(sequence::write_state(&path, &packet, &start).is_err());
    let (t, y2, yp2) = compose::saved_state(path.to_str().unwrap(), &packet, y.len());
    assert_eq!(t, start.t);
    assert!(y.iter().zip(&y2).all(|(a, b)| a.to_bits() == b.to_bits()));
    assert!(yp.iter().zip(&yp2).all(|(a, b)| a.to_bits() == b.to_bits()));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn admission_is_judged_on_accepted_steps_not_on_the_interpolant() {
    // A near-empty stock (the PZR drop mass) on three accepted steps, all
    // admitted (>= 0), with an interpolant that dips below zero between the
    // first two (as stock IDA's dense output may: its constraints hold on
    // accepted steps only), and outputs every 0.1 s.
    let steps = [(0.0, 2e-7), (0.35, 1e-7), (0.9, 3e-7)];
    let interpolant = |t: f64| -> f64 {
        if t < 0.35 {
            2e-7 - 1e-6 * (t * (0.35 - t)) / 0.03
        } else {
            1e-7 + 2e-7 * (t - 0.35) / 0.55
        }
    };
    let admitted = |v: f64| v >= 0.;
    assert!(
        !admitted(interpolant(0.2)),
        "the interpolant dips below zero at 0.2 s"
    );
    let judge = |steps: &[(f64, f64)]| -> Result<usize, String> {
        let mut c = runner::Closures::default();
        let mut judged = 0;
        let mut next = 1;
        for (tn, value) in steps.iter().skip(1) {
            // The outputs every 0.1 s up to this accepted step.
            let last = (tn / 0.1).floor() as usize;
            for k in next..=last {
                c.output(k as f64 * 0.1);
            }
            next = last + 1;
            let covered = c.accepted(*tn);
            if !covered.is_empty() {
                if !admitted(*value) {
                    return Err(format!("stock {value} at the accepted step {tn} s"));
                }
                judged += covered.len();
            }
        }
        Ok(judged)
    };
    // Judged on the accepted steps: every output passes.
    assert_eq!(judge(&steps), Ok(9));
    // An admitted-step violation still fails.
    let violated = [(0.0, 2e-7), (0.35, -1e-9), (0.9, 3e-7)];
    assert!(judge(&violated).is_err());
    // Outputs wait across a root return: none is judged until an accepted step.
    let mut c = runner::Closures::default();
    c.output(0.1);
    assert_eq!(c.pending_len(), 1);
    assert_eq!(c.accepted(0.12), vec![0.1]);
    assert_eq!(c.judged, vec![(0.12, 1)]);
}

#[test]
fn a_references_ledger_counts_in_the_contracts_tolerance_units_and_a_declared_limit_is_an_exit() {
    let spec = |rtol: f64, atol_factor: f64| run::RunSpec {
        name: "x".into(),
        duration_s: 1.,
        window_s: 1.,
        rtol,
        atol_factor,
        max_step_s: None,
        newton_coefficient: 0.33,
        delta_cj_lsetup: 0.1,
        first_step_s: 1e-4,
        max_order: 2,
        output_s: 0.1,
        observation_s: None,
        commands: Vec::new(),
        solver_cap_s: 1.,
        total_guard_s: 1.,
        report_only_step_cap: None,
        caps_report_only: false,
        rods_observed: false,
        domain_exit_stops: true,
    };
    let contract = vec![1e-8, 2e-8];
    let tight: Vec<f64> = contract.iter().map(|a| a * 0.1).collect();
    // R2 (rtol/100, atol x 0.1): the contract's tolerances (DR-P3-GATE-2).
    let (a, r, reference) =
        runner::ledger_tolerances(&spec(1e-7, 0.1), (&contract, 1e-5), (&tight, 1e-7));
    assert!(reference && a == contract.as_slice() && r == 1e-5);
    // A declared run keeps its own, which are the contract's.
    let (a, r, reference) =
        runner::ledger_tolerances(&spec(1e-5, 1.), (&contract, 1e-5), (&contract, 1e-5));
    assert!(!reference && a == contract.as_slice() && r == 1e-5);
    // The SG crown guard's refusal is the run's declared limit, not a failure.
    let refusal = "roots restart: S2 domain exit (unsupported): SG.B crown first uncovery at t = 531.87 s, V_l = 71.25 m³";
    assert_eq!(
        runner::declared_limit(refusal).as_deref(),
        Some(
            "S2 domain exit (unsupported): SG.B crown first uncovery at t = 531.87 s, V_l = 71.25 m³"
        )
    );
    assert_eq!(runner::declared_limit("stock IDA status -3"), None);
}

// ------------------------------------------------- comparisons (synthetic)

/// Credited series on the grid `origin + j dt`, each key's instances from
/// `f(key, instance, t)`.
fn synthetic(
    origin: f64,
    dt: f64,
    n: usize,
    instances: &[(&'static str, usize)],
    f: &dyn Fn(&str, usize, f64) -> f64,
) -> Credited {
    let mut c = Credited::default();
    for j in 0..=n {
        let t = j as f64 * dt;
        let sample: Vec<(&str, Vec<f64>)> = instances
            .iter()
            .map(|(k, m)| (*k, (0..*m).map(|i| f(k, i, t)).collect()))
            .collect();
        c.push(origin + t, &sample).unwrap();
    }
    c
}

const ALL: [(&str, usize); 11] = [
    (key::CORE_POWER_W, 1),
    (key::REGIONAL_FRACTION, 3),
    (key::FUEL_DOPPLER_K, 3),
    (key::CORE_CELL_K, 2),
    (key::AVERAGE_COOLANT_K, 1),
    (key::PZR_ROOF_PA, 1),
    (key::PZR_LEVEL_M, 1),
    (key::CORE_DP_PA, 1),
    (key::LOOP_FLOW_KG_S, 2),
    (key::SG_PRESSURE_PA, 2),
    (key::SG_LIQUID_M3, 2),
];

fn base(k: &str, i: usize, _t: f64) -> f64 {
    match k {
        key::CORE_POWER_W => 2.9925e9,
        key::REGIONAL_FRACTION => 1. / 3.,
        key::PZR_ROOF_PA => 1.55e7,
        key::SG_PRESSURE_PA => 6.36e6 + i as f64,
        _ => 500. + i as f64,
    }
}

#[test]
fn the_comparison_takes_the_contract_metrics_of_the_filtered_difference() {
    let d = fixture();
    let b = compare::Budgets::from(&d).unwrap();
    let (origin, dt, n) = (600., b.observation_s, 5000);
    let reference = synthetic(origin, dt, n, &ALL, &base);
    // Offsets well inside the band: a constant roof bias of 300 Pa, a
    // 0.2 Hz SG pressure wave of 1,500 Pa, core power 2.0e6 W (6.7e-4 of
    // the basis), one regional fraction 5e-4; and 20 Hz content on the
    // level that the filter removes.
    let run = synthetic(origin, dt, n, &ALL, &|k, i, t| {
        base(k, i, t)
            + match (k, i) {
                (key::PZR_ROOF_PA, _) => 300.,
                (key::SG_PRESSURE_PA, 1) => 1500. * (2. * std::f64::consts::PI * 0.2 * t).sin(),
                (key::CORE_POWER_W, _) => 2.0e6,
                (key::REGIONAL_FRACTION, 2) => 5e-4,
                (key::PZR_LEVEL_M, _) => 0.05 * (2. * std::f64::consts::PI * 20. * t).sin(),
                _ => 0.,
            }
    });
    let m = compare::compare(&run, &reference, origin, 0., 10., &b);
    let v = |k: &str| m["metrics"][k]["value"].as_f64().unwrap();
    assert_eq!(m["evaluable"], json!(true), "{m}");
    assert!((v("pzr_roof_bias_pa") - 300.).abs() < 1e-6, "{m}");
    assert!(v("pzr_roof_sample_noise_pa") < 1e-6);
    assert!((v("sg_pressure_pa") - 1500.).abs() < 5., "{m}");
    assert!((v("core_power_relative") - 2.0e6 / 2.9925e9).abs() < 1e-9);
    assert!((v("regional_fraction") - 5e-4).abs() < 1e-9);
    // 20 Hz is ten times the cutoff: the 4th-order filter, twice, leaves
    // about 1e-8 of it.
    assert!(v("pzr_level_m") < 1e-6, "{m}");
    assert_eq!(m["within"], json!(true), "{m}");
    // One output over its budget fails the comparison; a missing output
    // makes it not evaluable.
    let over = synthetic(origin, dt, n, &ALL, &|k, i, t| {
        base(k, i, t) + if k == key::SG_PRESSURE_PA { 2500. } else { 0. }
    });
    let m = compare::compare(&over, &reference, origin, 0., 10., &b);
    assert_eq!(m["within"], json!(false));
    assert!(m["metrics"]["sg_pressure_pa"]["value"].as_f64().unwrap() > 2000.);
    let missing = synthetic(origin, dt, n, &ALL[..5], &base);
    let m = compare::compare(&missing, &reference, origin, 0., 10., &b);
    assert_eq!(m["evaluable"], json!(false));
    // A series off the grid or too short is refused, not compared.
    let short = synthetic(origin, dt, 100, &ALL, &base);
    let m = compare::compare(&short, &reference, origin, 0., 10., &b);
    assert_eq!(m["evaluable"], json!(false));
}

#[test]
fn rod_insertion_times_interpolate_and_compare_by_time_difference() {
    let d = fixture();
    let b = compare::Budgets::from(&d).unwrap();
    let (origin, dt) = (10., 0.002);
    let fall = |delay: f64| {
        move |_: &str, _: usize, t: f64| -> f64 {
            // Released at 0.2 s + delay, uniform 2 m/s from 2.8 m.
            (2.8 - 2. * (t - 0.2 - delay).max(0.)).max(0.)
        }
    };
    let run = synthetic(origin, dt, 1000, &[(key::ROD_TRAVEL_M, 2)], &fall(0.));
    let reference = synthetic(origin, dt, 1000, &[(key::ROD_TRAVEL_M, 2)], &fall(0.03));
    let seats: BTreeMap<usize, f64> = [(0, origin + 1.6), (1, origin + 1.6)].into();
    let late: BTreeMap<usize, f64> = [(0, origin + 1.63), (1, origin + 1.63)].into();
    let a = compare::insertion_times(&run, origin, 2.8, &b.insertion_fractions, &seats).unwrap();
    // 0.1 of 2.8 m is 0.28 m: 0.2 + 0.14 s.
    assert!((a[0][0].unwrap() - 0.34).abs() < 1e-9, "{a:?}");
    assert!((a[0][1].unwrap() - 0.9).abs() < 1e-9);
    assert!((a[0][3].unwrap() - 1.6).abs() < 1e-12);
    let r =
        compare::insertion_times(&reference, origin, 2.8, &b.insertion_fractions, &late).unwrap();
    let v = compare::compare_timing(&a, &r, &b);
    assert!(
        (v["max_abs_s"].as_f64().unwrap() - 0.03).abs() < 1e-9,
        "{v}"
    );
    assert_eq!(v["within"], json!(true));
    // 0.06 s is beyond thresholdTiming_s; a seat in one run only is a miss.
    let slow = synthetic(origin, dt, 1000, &[(key::ROD_TRAVEL_M, 2)], &fall(0.06));
    let s = compare::insertion_times(&slow, origin, 2.8, &b.insertion_fractions, &seats).unwrap();
    assert_eq!(compare::compare_timing(&a, &s, &b)["within"], json!(false));
    let unseated =
        compare::insertion_times(&run, origin, 2.8, &b.insertion_fractions, &BTreeMap::new())
            .unwrap();
    let v = compare::compare_timing(&a, &unseated, &b);
    assert_eq!(v["misses"].as_array().unwrap().len(), 2);
    assert_eq!(v["within"], json!(false));
}

// ----------------------------------------------- settling and the cap fit

#[test]
fn the_stuck_cluster_is_the_highest_worth_with_ties_reported() {
    use sequence::{highest_worth, population_weights};
    let (k, ties) = highest_worth(&[1e-3, 3e-3, 2e-3, 3e-3]).unwrap();
    assert_eq!((k, ties), (1, vec![1, 3]), "exact ties: the lowest index");
    assert!(highest_worth(&[]).is_err());
    assert!(highest_worth(&[1e-3, f64::NAN]).is_err());
    let w = population_weights(&[1., 3.], 2).unwrap();
    assert!((w[0] - 0.1).abs() < 1e-15 && (w[1] - 0.9).abs() < 1e-15);
    assert!(population_weights(&[0., 0.], 1).is_err());
    assert!(population_weights(&[-1., 2.], 1).is_err());
    assert_eq!(guards::cap_key("stuckCluster").unwrap(), "contraryTripEach");
}

#[test]
fn a_clusters_worth_is_the_weighted_rod_reactivity_its_insertion_removes() {
    use leitbild_operating_plant::{joined::nuclear::FeedbackInputs, source_feedback as sf};
    // Two synthetic sectors over the whole active height, three clusters:
    // A in sector 0, B shared, C in sector 1; all withdrawn (travel 4 m).
    let parameters: sf::Parameters = serde_json::from_value(json!({
        "generation_time_s": 2e-5, "nu_effective": 2.43, "doppler_per_sqrt_k": -1.15e-3,
        "water_worth": 0.15, "boron_per_ppm_eq": -8e-5, "rod_worth": 0.1,
        "sigma_xe_m2": 2e-22, "sigma_sm_m2": 4e-24, "capsule_births_per_s": 0.,
        "capsule_decay_per_s": 1e-8, "inserted_active_bottom_m": -2., "rod_active_length_m": 4.,
        "rod_maximum_travel_m": 4.,
        "domains": {"fuel_temperature_k": {"minimum": 500, "maximum": 1800},
            "moderator_temperature_k": {"minimum": 550, "maximum": 610},
            "pressure_pa": {"minimum": 1.4e7, "maximum": 1.6e7}, "density_ratio": {"minimum": 0.85, "maximum": 1.1},
            "boron_ppm_eq": {"minimum": 0, "maximum": 2500}, "fissile_ratio": {"minimum": 0.95, "maximum": 1},
            "reactivity": {"minimum": -0.3, "maximum": 0.15}, "maximum_additional_reference_exposure_s": 1e5}}))
    .unwrap();
    let region = |weights: [f64; 3]| sf::Region {
        rho_base: 0.,
        reference_density_kg_m3: 700.,
        reference_boron_ppm_eq: 0.,
        reference_rod_overlap: 0.,
        source_weight: 0.5,
        z0_m: -2.,
        z1_m: 2.,
        rod_weights: weights.to_vec(),
    };
    let gamma = 1. / (2.43 * 2e-5);
    let support = |region: usize| sf::Support {
        region,
        material: 0,
        production_reference_per_s: gamma,
        exposure_per_population_s_m2: 0.,
        fuel_importance: 1.,
    };
    let model = sf::Model::new(
        parameters,
        vec![region([0.5, 0.5, 0.]), region([0., 0.5, 0.5])],
        vec![sf::Material {
            reference_fissile_atoms: 1.,
            reference_fuel_temperature_k: 900.,
            reference_xenon_atoms: 0.,
            reference_samarium_atoms: 0.,
            reference_nonpoison_capture_opacity_m2: 0.,
        }],
        vec![support(0), support(1)],
    )
    .unwrap();
    let inputs = FeedbackInputs {
        neutrons: vec![1., 3.],
        fuel_temperature_k: vec![900.],
        water_density_kg_m3: vec![700., 700.],
        boron_ppm_eq: vec![0., 0.],
        pressure_pa: vec![1.5e7, 1.5e7],
        moderator_temperature_k: vec![580., 580.],
        fissile_atoms: vec![1.],
        xenon_atoms: vec![0.],
        samarium_atoms: vec![0.],
        capture_loss_change_m2: vec![0.],
    };
    let worths = |power| {
        let w = sequence::population_weights(&inputs.neutrons, power).unwrap();
        sequence::cluster_worths(&model, &inputs, &[4., 4., 4.], &w).unwrap()
    };
    // Full insertion adds overlap w_ik in each sector: worth = 0.1 sum_i W_i w_ik.
    for (got, want) in worths(2).iter().zip([0.005, 0.05, 0.045]) {
        assert!((got - want).abs() < 1e-15, "{got} vs {want}");
    }
    for (got, want) in worths(1).iter().zip([0.0125, 0.05, 0.0375]) {
        assert!((got - want).abs() < 1e-15, "{got} vs {want}");
    }
    assert_eq!(sequence::highest_worth(&worths(2)).unwrap(), (1, vec![1]));
    // A cluster already seated adds nothing.
    let w = sequence::population_weights(&inputs.neutrons, 2).unwrap();
    let seated = sequence::cluster_worths(&model, &inputs, &[0., 4., 4.], &w).unwrap();
    assert_eq!(seated[0], 0.);
    assert!(sequence::cluster_worths(&model, &inputs, &[4., 4.], &w).is_err());
}

#[test]
fn trailing_ranges_are_the_window_max_minus_min() {
    let x: Vec<f64> = (0..200)
        .map(|k| ((k * 37) % 101) as f64 * 0.5 - (k as f64 * 0.1).sin())
        .collect();
    for n in [1, 7, 50] {
        let fast = compare::trailing_ranges(&x, n);
        assert_eq!(fast.len(), x.len() - n);
        for (k, r) in fast.iter().enumerate() {
            let w = &x[k..=k + n];
            let brute = w.iter().copied().fold(f64::NEG_INFINITY, f64::max)
                - w.iter().copied().fold(f64::INFINITY, f64::min);
            assert_eq!(*r, brute);
        }
    }
}

/// A settling signal per quantity instance: an exponentially decaying
/// 0.05 Hz oscillation of amplitude `a0 * scale`, rate `k`, about `base`.
fn settling(origin: f64, dt: f64, seconds: f64, k: f64) -> (Credited, Vec<compare::Quantity>) {
    let q = compare::settling_quantities(&fixture());
    let instances: Vec<(&'static str, usize)> = q.iter().map(|q| (q.key, 2)).collect();
    let mut keys = instances.clone();
    keys.dedup();
    let thresholds: BTreeMap<&str, (f64, bool)> = q
        .iter()
        .map(|q| (q.key, (q.threshold, q.relative)))
        .collect();
    let n = (seconds / dt).round() as usize;
    let c = synthetic(origin, dt, n, &keys, &|key, i, t| {
        let (threshold, relative) = thresholds[key];
        let base = 1000. + i as f64;
        let scale = if relative {
            threshold * base
        } else {
            threshold
        };
        base + 50. * scale * (-k * t).exp() * (2. * std::f64::consts::PI * 0.05 * t).sin()
    });
    (c, q)
}

#[test]
fn the_settled_judgement_takes_each_quantitys_last_window_range() {
    let (dt, window, cutoff) = (0.1, 20., 2.);
    // 50 x threshold at t = 0 decaying at 0.02 /s: below the threshold
    // (range about 2 x amplitude) after ln(100)/0.02 = 230 s.
    let (early, q) = settling(0., dt, 150., 0.02);
    let (is, v) = compare::settled(&early, &q, window, dt, cutoff);
    assert!(!is, "{v}");
    let (late, q) = settling(0., dt, 400., 0.02);
    let (is, v) = compare::settled(&late, &q, window, dt, cutoff);
    assert!(is, "{v}");
    assert_eq!(v["quantities"].as_array().unwrap().len(), 2 * q.len());
    // Too short for a window: not evaluable, never settled.
    let (short, q) = settling(0., dt, 10., 0.02);
    assert!(!compare::settled(&short, &q, window, dt, cutoff).0);
}

#[test]
fn the_exponential_fit_recovers_rate_and_crossing() {
    let t: Vec<f64> = (0..100).map(|k| 300. + k as f64).collect();
    let r: Vec<f64> = t.iter().map(|t| 7. * (-0.01 * (t - 300.)).exp()).collect();
    let f = compare::Exponential::fit(&t, &r).unwrap();
    assert!((f.k_per_s - 0.01).abs() < 1e-12 && (f.a - 7.).abs() < 1e-10);
    assert!(f.rms_log_residual < 1e-12);
    // 7 e^{-0.01 (t-300)} = 1 at t = 300 + 100 ln 7.
    assert!((f.reaches(1.).unwrap() - (300. + 100. * 7_f64.ln())).abs() < 1e-8);
    // A growing range never reaches its threshold; a zero range refuses.
    let grow: Vec<f64> = r.iter().rev().copied().collect();
    assert!(
        compare::Exponential::fit(&t, &grow)
            .unwrap()
            .reaches(1.)
            .is_none()
    );
    let mut zero = r.clone();
    zero[5] = 0.;
    assert!(compare::Exponential::fit(&t, &zero).is_err());
}

#[test]
fn the_settle_cap_fit_is_twice_the_fitted_crossing_and_its_cpu() {
    let (dt, window, cutoff) = (0.1, 20., 2.);
    let (run, q) = settling(0., dt, 200., 0.02);
    // A CPU trace of 0.5 CPU-s per simulated second.
    let cpu: Vec<(f64, f64)> = run.t.iter().map(|t| (*t, 0.5 * t)).collect();
    let fit = compare::settle_cap_fit(&run, 0., &cpu, &q, window, dt, cutoff);
    assert_eq!(fit["evaluable"], json!(true), "{fit}");
    // The fitted rate is the envelope's, 0.02 /s, within the fit's
    // oscillation; t_fit near ln(50 x 2 / 1)/0.02 = 230 s (range over a
    // 20 s window of the decaying wave is about 2 x envelope).
    for f in fit["fits"].as_array().unwrap() {
        let k = f["k_per_s"].as_f64().unwrap();
        assert!((k - 0.02).abs() < 0.004, "{f}");
        assert!(f["inputs_every_1s"].as_array().unwrap().len() >= 70);
    }
    let t_fit = fit["t_fit_s"].as_f64().unwrap();
    assert!((180. ..280.).contains(&t_fit), "{fit}");
    assert_eq!(fit["cap_simulated_s"].as_f64().unwrap(), 2. * t_fit);
    // Beyond the run's end the CPU is extrapolated at the last half's rate.
    assert_eq!(fit["cpu_extrapolated"], json!(true));
    assert!((fit["cap_cpu_s"].as_f64().unwrap() - 2. * 0.5 * t_fit).abs() < 1e-6);
    // A growing quantity refuses the fit.
    let (grow, q) = settling(0., dt, 200., -0.01);
    let fit = compare::settle_cap_fit(&grow, 0., &cpu, &q, window, dt, cutoff);
    assert_eq!(fit["evaluable"], json!(false));
    assert!(fit["t_fit_s"].is_null());
}

#[test]
fn the_holds_drift_is_each_filtered_outputs_departure_from_its_start_value() {
    let d = fixture();
    let ceilings = compare::drift_ceilings(&d);
    let keys: Vec<(&'static str, usize)> = ceilings.iter().map(|(k, _, _)| (*k, 1)).collect();
    // A 5 kPa roof ramp over 300 s and 0.15 m^3 on the SG volume.
    let run = synthetic(0., 0.1, 3000, &keys, &|k, _, t| {
        1000.
            + match k {
                key::PZR_ROOF_PA => 5000. * t / 300.,
                key::SG_LIQUID_M3 => 0.15 * t / 300.,
                _ => 0.,
            }
    });
    let v = compare::drift(&run, 0., 10., &ceilings, 0.1, 2.);
    let roof = v["outputs"][key::PZR_ROOF_PA]["value"].as_f64().unwrap();
    assert!((roof - 5000. * 290. / 300.).abs() < 1., "{v}");
    assert_eq!(
        v["within"],
        json!(false),
        "the SG volume drifts 0.145 > 0.1"
    );
}

// --------------------------------------------------------------- the runs

/// M4: a smoke run, NOT evidence. From the saved settled state
/// (`LD01_S2_SETTLED_STATE`): a hold of `LD01_S2_SMOKE_HOLD_S` (10 s) with
/// its rtol/10 reference, and the trip for `LD01_S2_SMOKE_TRIP_S` (2 s; the
/// rod seat is at about 2.53 s) with R1, R0 and R2 over the same span
/// (`LD01_S2_SMOKE_RUNS`, default all six). The full receipt schema is
/// written to `$LD01_RECEIPTS/harness-b/` (`LD01_S2_SMOKE_RECEIPT` names
/// the file). Caps are reported only; `LD01_S2_RUN_CPU_GUARD_S` bounds each
/// run.
#[test]
#[ignore = "NOT-EVIDENCE smoke (M4): requires the joined packet, a settled state, the S2 declaration, the wiki, IF97 and stock IDAS/KLU"]
fn s2_smoke() {
    use sequence::{Harness, Mode, judge_hold, saved_start, state_receipt};
    let env = |k: &str, default: f64| -> f64 {
        std::env::var(k).map_or(default, |v| v.parse().unwrap_or_else(|_| panic!("{k}={v}")))
    };
    let hold_s = env("LD01_S2_SMOKE_HOLD_S", 10.);
    let trip_s = env("LD01_S2_SMOKE_TRIP_S", 2.);
    let runs: Vec<String> = std::env::var("LD01_S2_SMOKE_RUNS")
        .unwrap_or_else(|_| "hold,holdReference,trip,R1,R0,R2".into())
        .split(',')
        .map(str::to_string)
        .collect();
    let path = sequence::receipt_path(
        "harness-b",
        &std::env::var("LD01_S2_SMOKE_RECEIPT")
            .expect("LD01_S2_SMOKE_RECEIPT names the new receipt file"),
    );
    assert!(
        !path.exists(),
        "receipts are never overwritten: {}",
        path.display()
    );
    let mut h = Harness::new(Mode::Smoke).unwrap_or_else(|e| panic!("{e}"));
    let log = std::fs::read_to_string(guards::decision_log_page()).ok();
    let pin = guards::pin(&h.d.gates, log.as_deref()).unwrap();
    let tbd = guards::tbd_state(&h.d.gates, log.as_deref()).unwrap();
    let refusals = guards::gate_run_refusals(&pin, &tbd);
    // The composed state's zero-time entry, then the saved settled state.
    let composed = h.compose("composed-state receipt");
    let composed_entry = json!({"from": "the composed state", "z1": composed.receipt["start"],
        "derived_tolerances": composed.receipt["derived_tolerances"],
        "dimension": composed.receipt["dimension"], "algebraic": composed.receipt["algebraic"],
        "cpu_s": composed.cpu_s});
    let dimension = composed.y.len();
    drop(composed);
    let state = std::env::var("LD01_S2_SETTLED_STATE").expect("LD01_S2_SETTLED_STATE");
    let start = saved_start(&state, &h.packet, dimension);
    let settled_entry = state_receipt(&mut h, &start, "settled-state receipt");
    let mut done: BTreeMap<String, runner::Run> = BTreeMap::new();
    for name in &runs {
        let duration = match name.as_str() {
            "hold" | "holdReference" => hold_s,
            _ => trip_s,
        };
        let spec = if name == "stuckCluster" {
            h.stuck_cluster_spec(duration, &start).map(|(spec, _)| spec)
        } else {
            h.spec(name, duration)
        }
        .unwrap_or_else(|e| panic!("{e}"));
        if let Some(run) = h.run(&spec, &start, None) {
            println!(
                "{}",
                json!({"run": name, "reached_s": run.record.reached_s, "failure": run.record.failure,
                    "exit": run.record.exit, "process_cpu_s": run.record.process_cpu_s,
                    "attributed_fraction": run.record.json()["cpu"]["attributed_fraction"],
                    "restarts": run.record.restarts.len(), "counts": run.record.counts.json()})
            );
            done.insert(name.clone(), run);
        }
    }
    let mut comparisons = serde_json::Map::new();
    let mut gates_out = Vec::new();
    if let Some(hold) = done.get("hold") {
        gates_out.extend(judge_hold(
            &h,
            hold,
            done.get("holdReference"),
            &mut comparisons,
        ));
    }
    if let Some(trip) = done.get("trip") {
        gates_out.extend(sequence::judge_trip_declared_and_information(
            &h,
            trip,
            done.get("R0"),
            done.get("R1"),
            done.get("R2"),
            &mut comparisons,
        ));
    }
    // The per-sample observation cost, a preview of TBD(HARNESS) (loaded;
    // not a fill: fills are quiet-window best-of).
    let per_sample: BTreeMap<String, Value> = done
        .iter()
        .map(|(k, r)| {
            let samples = (r.record.outputs + r.record.observations) as f64;
            (k.clone(), json!(r.attribution.observation() / samples))
        })
        .collect();
    let fractions: Vec<f64> = done
        .values()
        .map(|r| {
            r.record.json()["cpu"]["attributed_fraction"]
                .as_f64()
                .unwrap_or(0.)
        })
        .collect();
    let worst_fraction = fractions.iter().copied().fold(f64::INFINITY, f64::min);
    let min_fraction = h.d.gates.number("/costMeasurement/attributedMinFraction");
    h.d.gates.whole("/costMeasurement");
    let mut r = h.receipt(
        "s2-smoke-NOT-EVIDENCE",
        "NOT-EVIDENCE smoke (S2-14 M4): a short hold and trip from a saved settled state on the S2 harness; S2 is not declared (revision 7 draft, TBDs open), caps are reported only and no gate is judged",
        "not judged (smoke)",
        pin,
        tbd,
        json!({"composed": composed_entry, "settled": settled_entry,
            "external": "Z2-Z7 are other lanes' receipts; a gate run names them (LD01_S2_ZERO_TIME_RECEIPTS)"}),
        Value::Object(comparisons),
        gates_out,
    );
    r["smoke"] = json!({"hold_s": hold_s, "trip_s": trip_s, "runs": runs,
        "trip_note": "the trip runs LD01_S2_SMOKE_TRIP_S from the settled state; this build carries S2-D21's seat restarts (rod seat at about 2.53 s); D3 (a) ends a run at the first state it does not admit (S2-D23 revised)",
        "declaration_page": h.d.receipt()["page"],
        "domain_exit_stops": std::env::var("LD01_S2_SMOKE_DOMAIN_EXIT").as_deref() != Ok("report"),
        "gate_run_refusals_now": refusals,
        "per_sample_observation_s_preview": per_sample,
        "attributed_fraction": {"worst": worst_fraction, "declared_min": min_fraction, "met": worst_fraction >= min_fraction}});
    receipt::write(&path, &r).unwrap_or_else(|e| panic!("{e}"));
    println!(
        "{}",
        json!({"receipt": path, "attributed_fraction_worst": worst_fraction, "gates": r["gates"].as_array().map(|g| g.iter().map(|x| json!([x["id"], x["pass"]])).collect::<Vec<_>>()),
            "work_bound": r["work_bound"]["total_cpu_s"], "cost": r["cost"]})
    );
    assert!(
        worst_fraction >= min_fraction,
        "CPU attribution {worst_fraction} below {min_fraction}"
    );
}

/// The gate run's refusals before any work: the pin, the TBD register and
/// the external receipts this phase needs.
fn gate_refusals(
    h: &mut sequence::Harness,
    required: &[&str],
) -> (Value, Value, Result<Value, Vec<String>>, Vec<String>) {
    let log = std::fs::read_to_string(guards::decision_log_page()).ok();
    let pin = guards::pin(&h.d.gates, log.as_deref()).unwrap();
    let tbd = guards::tbd_state(&h.d.gates, log.as_deref()).unwrap();
    let mut refusals = guards::gate_run_refusals(&pin, &tbd);
    let app = provenance::git_provenance()["app_commit"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let external = sequence::external_receipts(h, &app, required);
    if let Err(e) = &external {
        refusals.extend(e.iter().cloned());
    }
    (pin, tbd, external, refusals)
}

/// S2-15 phase 1, in the quiet window after S1 run 6, Z5, Z6 and Z7: it
/// refuses before any work unless the gates are pinned, no TBD is open and
/// the window's receipts pass (`LD01_S2_EXTERNAL_MANIFEST`); then the
/// composed-state receipts and the settle under its cap. It writes the
/// settled state (`LD01_S2_GATE_STATE_OUT`, S2-07 format with exact bits)
/// for the settled Z3/Z6 and phase 2, and the hand-over
/// (`LD01_S2_GATE_PHASE1_OUT`). Lead only.
#[test]
#[ignore = "S2-15 gate run phase 1: lead only, quiet window"]
fn s2_gate_prepare() {
    use sequence::{Harness, Mode, composed_start, settle, state_receipt};
    let mut h = Harness::new(Mode::Gate).unwrap_or_else(|e| panic!("{e}"));
    let (pin, tbd, external, refusals) = gate_refusals(
        &mut h,
        &["S1run6", "Z5", "Z6composed", "Z7", "Z2", "Z3composed", "Z4"],
    );
    assert!(
        refusals.is_empty(),
        "the S2 gate run refuses: {refusals:#?}"
    );
    let state_out = std::path::PathBuf::from(
        std::env::var("LD01_S2_GATE_STATE_OUT").expect("LD01_S2_GATE_STATE_OUT"),
    );
    let phase_out = std::path::PathBuf::from(
        std::env::var("LD01_S2_GATE_PHASE1_OUT").expect("LD01_S2_GATE_PHASE1_OUT"),
    );
    assert!(
        !state_out.exists() && !phase_out.exists(),
        "never overwritten"
    );
    let composed = h.compose("composed-state receipts");
    let start = composed_start(&composed);
    let derived = composed.receipt["derived_tolerances"].clone();
    drop(composed);
    let mut composed_entry = state_receipt(&mut h, &start, "composed-state receipts");
    composed_entry["derived_tolerances"] = derived;
    let mut zero_time = json!({"composed": composed_entry, "external_phase1": external.unwrap()});
    let (status, state) = match settle(&mut h, &start) {
        Some((run, judgement)) => {
            zero_time["settle"] = judgement.clone();
            if judgement["settled"] == json!(true) {
                sequence::write_state(&state_out, &h.packet, &run.end)
                    .unwrap_or_else(|e| panic!("{e}"));
                (
                    "settled".to_string(),
                    json!({"path": state_out, "sha256": provenance::sha256_file(state_out.to_str().unwrap()).ok(), "t_s": run.end.t}),
                )
            } else {
                (
                    "incomplete: not settled within the settling cap".into(),
                    Value::Null,
                )
            }
        }
        None => ("incomplete: the settle did not run".into(), Value::Null),
    };
    let dry = sequence::dry_run().unwrap_or_else(|e| panic!("{e}"));
    let kind = if dry {
        "s2-gate-dry-run-phase-1"
    } else {
        "s2-gate-run-phase-1"
    };
    let phase = json!({"kind": kind, "dry_run": dry, "status": status, "settled_state": state,
        "pin": pin, "tbd": tbd, "zero_time": zero_time, "handover": h.handover(),
        "process_cpu_s": cpu::process_cpu_s(), "app_commit": provenance::git_provenance()["app_commit"]});
    std::fs::write(&phase_out, serde_json::to_vec_pretty(&phase).unwrap()).unwrap();
    println!(
        "{}",
        json!({"status": phase["status"], "settled_state": phase["settled_state"], "work_bound": h.work.json()})
    );
}

/// S2-15 phase 2: from phase 1's hand-over (`LD01_S2_GATE_PHASE1`) and
/// settled state, after the settled Z3/Z6 (in the manifest): the settled
/// receipts, the hold and its reference, the trip with R0, R1 and R2 (each
/// judged up to its labelled D3 (a) exit and continued for information),
/// the contrary cases; every run pre-checked against the remaining work
/// bound. The full receipt to `$LD01_RECEIPTS/integ/<LD01_S2_GATE_RECEIPT>`.
/// Lead only, quiet window.
#[test]
#[ignore = "S2-15 gate run phase 2: lead only, quiet window"]
fn s2_gate_run() {
    use sequence::{Harness, Mode, judge_hold, saved_start, state_receipt};
    let mut h = Harness::new(Mode::Gate).unwrap_or_else(|e| panic!("{e}"));
    let phase_path = std::env::var("LD01_S2_GATE_PHASE1").expect("LD01_S2_GATE_PHASE1");
    let phase: Value = serde_json::from_slice(&std::fs::read(&phase_path).expect("phase 1"))
        .expect("phase 1 json");
    let dry = sequence::dry_run().unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        phase["dry_run"],
        json!(dry),
        "a gate run starts only from a gate phase 1, a dry run only from a dry one (RP12)"
    );
    assert_eq!(
        phase["status"],
        json!("settled"),
        "phase 1 did not settle: {}",
        phase["status"]
    );
    assert_eq!(
        phase["app_commit"],
        provenance::git_provenance()["app_commit"],
        "phase 1 ran at another app commit"
    );
    let state_path = phase["settled_state"]["path"].as_str().unwrap().to_string();
    assert_eq!(
        provenance::sha256_file(&state_path).ok().as_deref(),
        phase["settled_state"]["sha256"].as_str(),
        "the settled state changed since phase 1"
    );
    h.restore(&phase["handover"])
        .unwrap_or_else(|e| panic!("{e}"));
    let (pin, tbd, external, refusals) = gate_refusals(&mut h, &["Z6settled", "Z3settled"]);
    assert!(
        refusals.is_empty(),
        "the S2 gate run refuses: {refusals:#?}"
    );
    assert_eq!(
        pin["declared_sha256"], phase["pin"]["declared_sha256"],
        "the pin changed between phases"
    );
    let name = std::env::var("LD01_S2_GATE_RECEIPT").expect("LD01_S2_GATE_RECEIPT");
    let path = sequence::receipt_path(if dry { "dry" } else { "integ" }, &name);
    assert!(!path.exists(), "never overwritten");
    let composed = h.compose("settled-state receipts");
    let dimension = composed.y.len();
    drop(composed);
    let settled = saved_start(&state_path, &h.packet, dimension);
    let mut zero_time = phase["zero_time"].clone();
    zero_time["settled"] = state_receipt(&mut h, &settled, "settled-state receipts");
    zero_time["external_phase2"] = external.unwrap();
    let mut comparisons = serde_json::Map::new();
    let mut gates_out = Vec::new();
    let mut status = "complete".to_string();
    let d = &h.d.gates;
    let (hold_s, trip_s) = (d.number("/hold/duration_s"), d.number("/trip/duration_s"));
    let window = d.number("/trip/window_s");
    let post = h.d.shared.number("/recovery/postWindow_s");
    let no_trip_s = d.number("/contrary/noTurbineTrip/duration_s");
    let (hold_s, trip_s, r0_s, r1_s, r2_s) = if dry {
        sequence::dry_durations(d)
    } else {
        (hold_s, trip_s, window + post, window, trip_s)
    };
    let mut done: BTreeMap<String, runner::Run> = BTreeMap::new();
    for (name, duration) in [
        ("hold", hold_s),
        ("holdReference", hold_s),
        ("trip", trip_s),
        ("R0", r0_s),
        ("R1", r1_s),
        ("R2", r2_s),
        ("noTurbineTrip", no_trip_s),
    ] {
        let spec = h.spec(name, duration).unwrap_or_else(|e| panic!("{e}"));
        match h.run(&spec, &settled, None) {
            Some(run) => {
                println!(
                    "{}",
                    json!({"run": name, "reached_s": run.record.reached_s, "failure": run.record.failure,
                        "exit": run.record.exit, "process_cpu_s": run.record.process_cpu_s})
                );
                done.insert(name.into(), run);
            }
            None => {
                status = format!("incomplete: {name} not started (work bound)");
                break;
            }
        }
    }
    // G7's stuck cluster: the highest-worth cluster at the settled state
    // keeps its grip through the trip (Command::StuckCluster, CONTRARY).
    if status == "complete" {
        let duration = h.d.gates.number("/contrary/stuckCluster/duration_s");
        match h.stuck_cluster_spec(duration, &settled) {
            Ok((spec, _)) => match h.run(&spec, &settled, None) {
                Some(run) => {
                    println!(
                        "{}",
                        json!({"run": "stuckCluster", "reached_s": run.record.reached_s, "failure": run.record.failure,
                            "exit": run.record.exit, "process_cpu_s": run.record.process_cpu_s})
                    );
                    done.insert("stuckCluster".into(), run);
                }
                None => status = "incomplete: stuckCluster not started (work bound)".into(),
            },
            Err(e) => {
                h.sequence
                    .push(json!({"run": "stuckCluster", "started": false, "reason": e}));
                status = "incomplete: contrary case stuckCluster not selected".into();
            }
        }
    }
    // The 6 MPa header reservoir moved to S5 (lead decision S2-D28): no wiki
    // law yet holds the SG steam boundary at a reservoir pressure. Recorded,
    // never run, and not counted against S2's completeness.
    h.d.gates.whole("/contrary/headerReservoir");
    h.sequence.push(json!({"run": "headerReservoir", "started": false, "moved": "S5",
        "reason": "moved to S5 by S2-D28: no selected law holds the SG steam boundary at a reservoir pressure (MS.ISO effective areas unsized; an imposed SG pressure is excluded by the S2 secondary block)"}));
    if let Some(hold) = done.get("hold") {
        gates_out.extend(judge_hold(
            &h,
            hold,
            done.get("holdReference"),
            &mut comparisons,
        ));
    }
    if let Some(trip) = done.get("trip") {
        gates_out.extend(sequence::judge_trip_declared_and_information(
            &h,
            trip,
            done.get("R0"),
            done.get("R1"),
            done.get("R2"),
            &mut comparisons,
        ));
    }
    gates_out.extend(sequence::zero_time_gates(&zero_time));
    let passed = gates_out
        .iter()
        .filter(|g| g["judged"] == json!(true))
        .all(|g| g["pass"] == json!(true));
    let verdict = if status != "complete" {
        "incomplete".to_string()
    } else if passed {
        "PASS".to_string()
    } else {
        "FAIL".to_string()
    };
    let (kind, status, verdict) = if dry {
        (
            "s2-gate-dry-run",
            format!("DRY RUN (RP12), NOT EVIDENCE, reduced durations: {status}"),
            format!("DRY RUN, NOT EVIDENCE: {verdict}"),
        )
    } else {
        ("s2-gate-run", status, verdict)
    };
    let mut r = h.receipt(
        kind,
        &status,
        &verdict,
        pin,
        tbd,
        zero_time,
        Value::Object(comparisons),
        gates_out,
    );
    r["phase1"] = json!({"path": phase_path, "sha256": provenance::sha256_file(&phase_path).ok(),
        "process_cpu_s": phase["process_cpu_s"]});
    receipt::write(&path, &r).unwrap_or_else(|e| panic!("{e}"));
}

/// Z5 at the S2-15 start (quiet window): the projection's unit costs and the
/// per-sample observation cost, thread-CPU best-of `LD01_S2_Z5_ROUNDS` (5)
/// rounds at the composed state of the frozen tuple, as revision 7's TBD
/// register asks ("Z5 thread-CPU best-of in the quiet window at the frozen
/// code"):
/// - the value residual and the block Jacobian (System callbacks of the
///   integrated operator), stock KLU AMD factor, refactor and solve on the
///   block pattern, `c_s = stepResiduals × (residual + solve)` and
///   `c_J = Jacobian + refactor` as the projection prices them;
/// - the exact consistent start on the block matrices with its cached
///   symbolic analyses (a restart's start);
/// - one dense-output sample as the runner takes it: the interpolant read,
///   the account, the credited outputs and D3 (a).
///
/// The receipt (`$LD01_RECEIPTS/integ/<LD01_S2_Z5_RECEIPT>`) carries the
/// three fill values. NOT a gate: a measurement for the fills.
#[test]
#[ignore = "Z5 unit costs at the S2-15 start: quiet window"]
fn s2_z5_unit_costs() {
    use leitbild_operating_water::{
        ida::{Ida, Initial, System},
        joined::{Integrated, Matrices, consistent_start},
        joined_ledger::Ledgered,
        klu::SparseLu,
    };
    let rounds: usize = std::env::var("LD01_S2_Z5_ROUNDS").map_or(5, |v| v.parse().unwrap());
    let name = std::env::var("LD01_S2_Z5_RECEIPT").expect("LD01_S2_Z5_RECEIPT");
    let path = sequence::receipt_path("integ", &name);
    assert!(!path.exists(), "never overwritten");
    let mut h = sequence::Harness::new(sequence::Mode::Gate).unwrap_or_else(|e| panic!("{e}"));
    let c = h.compose("Z5");
    let compose::Composed {
        mut joined,
        y,
        yp,
        ids,
        atol,
        rtol,
        structure,
        mut analyses,
        ..
    } = c;
    let best = |v: &[f64]| v.iter().copied().fold(f64::INFINITY, f64::min);
    let timed = |f: &mut dyn FnMut()| {
        let t0 = cpu::thread_cpu_s();
        f();
        cpu::thread_cpu_s() - t0
    };
    // The exact consistent start (cached analyses, as at a restart).
    let weights = compose::error_weights(&y, rtol, &atol);
    let mut starts = Vec::new();
    for _ in 0..rounds {
        let mut y1 = y.clone();
        starts.push(timed(&mut || {
            consistent_start(
                &mut joined,
                Matrices::Blocks {
                    structure: &structure,
                    analyses: &mut analyses,
                },
                0.,
                &mut y1,
                &ids,
                &weights,
                compose::START_BOUND,
                2,
            )
            .expect("consistent start");
        }));
    }
    let mut integrated = Integrated::from_blocks(joined, structure, analyses).unwrap();
    let n = y.len();
    let nnz = integrated.nonzeros();
    let (mut out, mut data) = (vec![0.; n], vec![0.; nnz]);
    let (mut rows, mut pointers) = (vec![0i64; nnz], vec![0i64; n + 1]);
    let cj = 1. / h.d.gates.number("/observationInterval_s");
    let (mut residuals, mut jacobians) = (Vec::new(), Vec::new());
    for _ in 0..rounds {
        residuals.push(timed(&mut || {
            integrated.residual(0., &y, &yp, &mut out).unwrap()
        }));
        jacobians.push(timed(&mut || {
            integrated
                .jacobian(0., cj, &y, &yp, &mut data, &mut rows, &mut pointers)
                .unwrap()
        }));
    }
    let mut lu = SparseLu::analyze(n, &pointers, &rows).expect("KLU analyze");
    let (mut factors, mut refactors, mut solves) = (Vec::new(), Vec::new(), Vec::new());
    for _ in 0..rounds {
        factors.push(timed(&mut || lu.factor(&data).expect("factor")));
        refactors.push(timed(&mut || lu.refactor(&data).expect("refactor")));
        let mut rhs = out.clone();
        solves.push(timed(&mut || lu.solve(&mut rhs).expect("solve")));
    }
    // One dense-output sample as the runner takes it, after one step.
    let reader = h.reader().clone();
    let ledgered = Ledgered::new(integrated, cpu::thread_cpu_s).unwrap();
    let mut ida = Ida::new(
        meter::Metered::new(ledgered),
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
    ida.set_max_order(h.d.gates.count("/maxOrder") as usize)
        .unwrap();
    runner::restart_configuration(&h.d)
        .configure(&mut ida)
        .unwrap();
    let (mut ys, mut yps) = (y.clone(), yp.clone());
    let reached = ida
        .advance_one_step(1., &mut ys, &mut yps)
        .unwrap()
        .reached()
        .unwrap();
    let mut samples = Vec::new();
    for _ in 0..rounds {
        let at = 0.5 * reached;
        samples.push(timed(&mut || {
            ida.dense(at, &mut ys, &mut yps).unwrap();
            let account = ida.system_mut().inner.account(at, &ys, &yps).unwrap();
            let joined = &ida.system().inner.integrated.joined;
            let values = reader.read(joined, &ys, false).unwrap();
            let admitted = outputs::admit(joined, &h.extension, at);
            std::hint::black_box((account, values, admitted.is_ok()));
        }));
    }
    let k = h.d.gates.number("/projection/stepResiduals");
    let (f, s, j, r) = (
        best(&residuals),
        best(&solves),
        best(&jacobians),
        best(&refactors),
    );
    let unit = json!({"residual_s": f, "jacobian_s": j, "klu_factor_s": best(&factors), "klu_refactor_s": r,
        "klu_solve_s": s, "c_s_s": k * (f + s), "c_J_s": j + r,
        "rule": "thread-CPU best-of in the quiet window at the frozen code; c_s = stepResiduals x (residual + KLU solve), c_J = block Jacobian + KLU AMD refactor"});
    let receipt = json!({"kind": "s2-z5-unit-costs", "status": "zero-time measurement for the S2-15 fills (Z5); not a gate",
        "provenance": h.header()["provenance"], "machine": h.header()["machine"], "rounds": rounds, "cj_per_s": cj,
        "rounds_s": {"residual": residuals, "jacobian": jacobians, "klu_factor": factors, "klu_refactor": refactors,
            "klu_solve": solves, "consistent_start": starts, "dense_sample": samples},
        "fill_values": {"projection.unitCosts": unit,
            "projection.consistentStart_cpu_s": best(&starts),
            "totalGuard.perSampleObservation_s": best(&samples)},
        "notes": {"consistent_start": "best-of at the composed state on cached analyses; the S2-10 median over its restarts (loaded) was 0.065 s and a 52-rod seat start 0.25 s",
            "dense_sample": "interpolant read + account + credited outputs (no rods) + D3 (a), as the runner samples"},
        "process_cpu_s": cpu::process_cpu_s()});
    std::fs::write(&path, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    println!(
        "{}",
        json!({"receipt": path, "fill_values": receipt["fill_values"]})
    );
}

#[test]
fn a_run_end_hands_on_the_accepted_step_never_an_interpolant() {
    // DR-P3-GATE-3: the settled sample at 523 s lies inside the step reaching
    // 524.6 s; the interpolant there dips below a near-empty stock's zero
    // (S2-15 r7.1, phase 2's start), the accepted step does not.
    let (ys, yps) = (vec![1., -1.4e-26], vec![0., 0.]);
    let (y, yp) = (vec![1., 2e-9], vec![0., 1e-12]);
    let (t, y2, yp2, accepted) = runner::end_state((523., &ys, &yps), (524.6, &y, &yp), false);
    assert_eq!((t, y2, yp2, accepted), (524.6, y.clone(), yp.clone(), true));
    // A sample on a root return has no accepted step: not accepted, and
    // never written as a hand-over.
    let (t, y3, yp3, accepted) = runner::end_state((523., &ys, &yps), (523.2, &y, &yp), true);
    assert_eq!((t, &y3, accepted), (523., &ys, false));
    let dir = std::env::temp_dir().join(format!("s2-gate3-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let packet = compose::PacketFile {
        path: "/packet.json".into(),
        bytes: Vec::new(),
        sha256: "0".repeat(64),
    };
    let interpolant = runner::Start {
        t,
        y: y3,
        yp: yp3,
        from: "a root return".into(),
        accepted,
    };
    let refused = sequence::write_state(&dir.join("state.json"), &packet, &interpolant);
    assert!(refused.is_err_and(|e| e.contains("DR-P3-GATE-3")));
    assert!(!dir.join("state.json").exists());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn the_trip_is_compared_only_where_both_runs_reached() {
    // S2-15 r7.1: the trip's declared part ends at its D3 (a) exit at
    // 24.274 s, R2's at 24.284 s; the after-window span ends at the trip's.
    assert_eq!(
        sequence::reference_spans(20., 60., 24.274, 24.284, true),
        vec![(0., 20.), (20., 24.274)]
    );
    // And at the reference's when it ends first.
    assert_eq!(
        sequence::reference_spans(20., 60., 24.284, 24.274, true),
        vec![(0., 20.), (20., 24.274)]
    );
    // R1 over the window only; whole runs to the declared duration.
    assert_eq!(
        sequence::reference_spans(20., 60., 60., 20., false),
        vec![(0., 20.)]
    );
    assert_eq!(
        sequence::reference_spans(20., 60., 60., 60., true),
        vec![(0., 20.), (20., 60.)]
    );
    // An exit inside the window shortens the window span.
    assert_eq!(
        sequence::reference_spans(20., 60., 15., 60., true),
        vec![(0., 15.)]
    );
}

#[test]
fn the_dry_run_is_declared_shorter_and_never_evidence() {
    // RP12: the trip, R0 and R2 run past the window far enough to cover
    // the S2 trip's D3 (a) exit (24.3 s); the hold past its measured-from
    // time; R1 is the window.
    let g = Block::from_json("ld01-s2-gates", GATES_R7_1).unwrap();
    let (hold, trip, r0, r1, r2) = sequence::dry_durations(&g);
    assert_eq!((hold, trip, r0, r1, r2), (12., 26., 26., 20., 26.));
    assert!(trip > 24.3 && hold < g.number("/hold/duration_s"));
}
