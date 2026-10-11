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
mod jacobian_harness;
use jacobian_harness::*;
use leitbild_operating_plant::{
    network::{Network, SparseJacobian},
    sparse,
};
use serde_json::{Value, json};
use std::rc::Rc;

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
    let Settled {
        states,
        matrices,
        structure: (pointers, rows),
        marks,
        ..
    } = settle(&declared, &outputs, Assembly::Colored);
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
