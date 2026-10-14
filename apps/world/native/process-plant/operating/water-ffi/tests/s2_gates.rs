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
pub use s2_harness::{compose, gates, receipt, run};

use gates::{Block, Declaration, solver_cap_s};
use serde_json::{Value, json};

/// Revision 6's `ld01-s2-gates`, as the unit tests' fixture (the harness
/// itself reads the declaration page).
const GATES_FIXTURE: &str = r#"{"sharedFrom":"ld01-s1-gates","maxOrder":2,"referenceToleranceFactor":0.1,"outputInterval_s":0.1,"newtonCoefficient":0.33,"deltaCjLSetup":0.1,"restartInitialStep_s":0.0001,"build":"quadratures","kluOrdering":"AMD","projectedStep_s":{"quiet":0.0045,"window":0.008},"costMeasurement":{"solverCpu":"process CPU less observation, root-return handling and ledger","record":["process","solver","observation","ledger","cpuModel","qosClass","coreClass"],"quietWindow":true},"totalCpu_s":2700,"runCapFactor":2,"totalGuard":{"rule":"solver cap + runCapFactor x observed samples x Z5 per-sample observation and root-return cost"},"identityRelative":1e-09,"preparation":{"pzrHeater":{"beforeK1_W":0,"atPower":"composed-state PZR metal exterior and head loss, computed once, held constant through settling, re-settling and hold"},"pzrRelief":true},"zeroTime":{"maxSolverCpu_s":120,"settledRepeats":["Z6"],"recompositionRepeats":["Z1","Z6"]},"settling":{"maxSimulated_s":null,"maxCpu_s":null,"capBasis":"S2-JOIN fitted approach rates (open)","judgedOn":"credited outputs; uncredited cells, SURGE among them, reported only","window_s":20,"corePowerRelative":0.0001,"cellTemperature_K":0.01,"pzrRoofPressure_Pa":1000,"sgPressure_Pa":1000,"loopFlowRelativeChange":0.0005},"powerBasis":{"mechanism":"A","preparedSourceHeat_W":2928922000,"referenceFissionsRebase":1.02626,"probeSettledPower_W":3005840000,"confirmRelative":0.002,"rebaseAgainAboveConfirm":true,"resettle":true},"hold":{"duration_s":300,"measuredFrom_s":10,"budget_cpu_s_per_s":0.1,"maxResidualsPerStep":1.5,"residualCount":"IDAGetNumResEvals","driftCeiling":{"corePowerRelative":0.002,"averageCoolant_K":0.1,"pzrRoofPressure_Pa":10000,"pzrLevel_m":0.02,"sgPressure_Pa":10000,"sgLiquidVolume_m3":0.1},"averageCoolant":"mass-weighted mean liquid temperature of the 27 primary cells"},"trip":{"duration_s":60,"window_s":20,"wholeTripBudget_cpu_s_per_s":0.35,"requireSeating":true,"referenceSpans":{"R1":"window","R2":"trip"},"projectedRestartsInWindow":40},"referenceCaps_cpu_s":{"holdReference":90,"R0":30,"R1":160,"R2":135},"r0ReportOnlyStepCap":3750,"contrary":{"stuckCluster":{"cluster":"highest worth in the source feedback","duration_s":60},"noTurbineTrip":{"initiation":"LD01.TRIP.MANUAL","holdingCircuitOpen_s":0,"steamDemand":"constant A/B","duration_s":60},"headerReservoir":{"pressure_Pa":6000000,"caps":"the settling caps"},"outputs":"output interval only","maxCpu_s_per_trip_case":42},"spectralStates":["composed","settled"],"directionalCheck":{"relative":1e-06,"norm":"scaled row","coordinateDirections":"all","randomDirectionsPerBlock":20,"scheme":"central","incrementOfScale":1e-05,"kinkRule":"one-sided on the state's side across a C0 kink, donor flip or relief or mode switch","innerSolveRelativeMax":1e-12,"exactAbsence":{"rule":"phase mass exactly 0, or impulse 0 with inertance 0","composedCount":63,"check":"analytic column against the colored path"}},"ledger":{"gate":"IDAS quadrature","boundLocalToleranceUnits":1,"trapezoid":"reported","reportOverTime":true}}"#;

/// Zero-time check of the declaration, NOT S2 evidence: the blocks load
/// from their pages, pass the declaration's own checks, and the derived run
/// caps are printed with every value no harness code consumes yet.
#[test]
#[ignore = "requires the S2 declaration page and the wiki"]
fn s2_declared_gates() {
    let d = Declaration::load().unwrap_or_else(|e| panic!("{e}"));
    let caps: serde_json::Map<String, Value> = [
        "hold",
        "holdReference",
        "trip",
        "R0",
        "R1",
        "R2",
        "zeroTime",
    ]
    .iter()
    .map(|r| (r.to_string(), json!(solver_cap_s(&d.gates, r))))
    .collect();
    println!(
        "{}",
        json!({"kind": "s2-declared-gates-NOT-EVIDENCE", "declaration": d.receipt(),
            "solver_caps_s": caps, "total_cpu_s": d.gates.number("/totalCpu_s"),
            "unread": d.unread()})
    );
}

#[test]
fn every_declared_value_is_read_by_pointer_and_the_unread_ones_are_listed() {
    let gates = Block::from_json("ld01-s2-gates", GATES_FIXTURE).unwrap();
    assert_eq!(gates.number("/hold/duration_s"), 300.);
    assert_eq!(gates.open_number("/settling/maxCpu_s"), None);
    assert_eq!(gates.open_number("/settling/window_s"), Some(20.));
    assert_eq!(gates.count("/r0ReportOnlyStepCap"), 3750);
    assert!(gates.flag("/trip/requireSeating"));
    assert_eq!(gates.texts("/spectralStates"), ["composed", "settled"]);
    // The derived caps follow the work-bound table's bases.
    assert_eq!(solver_cap_s(&gates, "hold"), 60.);
    assert_eq!(solver_cap_s(&gates, "trip"), 42.);
    assert_eq!(solver_cap_s(&gates, "R1"), 160.);
    let unread = gates.unread();
    assert!(!unread.contains(&"/hold/duration_s".to_string()));
    assert!(
        unread.contains(&"/ledger/trapezoid".to_string()),
        "{unread:?}"
    );
    // An array is one leaf; an object read whole covers its leaves.
    assert!(!unread.contains(&"/spectralStates".to_string()));
    assert!(unread.contains(&"/directionalCheck/exactAbsence/composedCount".to_string()));
    // A missing or mistyped key refuses loudly.
    let missing = std::panic::catch_unwind(|| {
        Block::from_json("ld01-s2-gates", GATES_FIXTURE)
            .unwrap()
            .number("/hold/notDeclared")
    });
    assert!(missing.is_err());
    let mistyped = std::panic::catch_unwind(|| {
        Block::from_json("ld01-s2-gates", GATES_FIXTURE)
            .unwrap()
            .number("/build")
    });
    assert!(mistyped.is_err());
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
    // Each level of the schema is checked: top, run, comparison and gate.
    for (pointer, expected) in [
        ("/machine", "/machine/cpu_model"),
        ("/runs/hold/ledger", "/runs/hold/ledger/gate"),
        (
            "/runs/hold/cpu/buckets",
            "/runs/hold/cpu/buckets/klu_solve_s",
        ),
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
