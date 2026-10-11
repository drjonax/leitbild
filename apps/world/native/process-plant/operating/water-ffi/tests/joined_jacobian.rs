//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#6-solver-properties-and-cost-obligations
//! The joined S2 operator's stage Jacobian at the hot reference, zero-time.
//! A measurement only, NOT S2 evidence: S2 is not declared, and the SG
//! secondary and rod owners are pending, so their ports hold the packet's
//! prepared views and travel. The colored assembly of the joined pattern
//! (one exact seeded joined evaluation per color, the operator's own loop)
//! is the reference matrix; stock KLU is timed on it with nnz(L+U) (Z5).
#![cfg(all(feature = "ida", target_os = "macos"))]
mod jacobian_harness;
use jacobian_harness::*;
use leitbild_operating_plant::sparse::{self, Coloring, Pattern};
use serde_json::{Value, json};

#[test]
#[ignore = "requires the S1 packet, the wiki gates, maintained IF97 and stock IDA/KLU; zero-time measurement"]
fn joined_colored_reference_and_klu() {
    prefer_performance_core();
    let full = std::env::var("LD01_JAC_PREPARED_PORTS").is_err();
    let declared = Declared::load();
    let load_start = load_average();
    let commit = command("git", &["rev-parse", "HEAD"]);
    let dirty = !command("git", &["status", "--porcelain"]).is_empty();
    let settled = settle(&declared, &[46.], Assembly::Blocks)
        .outputs
        .pop()
        .unwrap();
    let JoinedHot {
        mut joined,
        y,
        flowing,
        ..
    } = joined_hot(&declared, &settled, full);
    let n = joined.dimension();
    let zero = vec![0.; n];
    let started = cpu();
    let columns = joined.structural_pattern().expect("joined pattern");
    let pattern = Pattern::from_columns(n, &columns).expect("pattern");
    let coloring = Coloring::greedy(&pattern);
    coloring.verify(&pattern).expect("coloring");
    let compile_s = cpu() - started;
    let mut row_counts = vec![0usize; n];
    for &r in pattern.indices() {
        row_counts[r] += 1;
    }
    // One value and one seeded joined residual, best of 5.
    let time = |f: &mut dyn FnMut()| {
        (0..5)
            .map(|_| {
                let s = cpu();
                f();
                cpu() - s
            })
            .fold(f64::INFINITY, f64::min)
    };
    let value_s = time(&mut || {
        joined.evaluate(0., &y, &zero, None, 0., None).unwrap();
    });
    let seed: Vec<f64> = (0..n).map(|i| if i % 7 == 0 { 1. } else { 0. }).collect();
    let seeded_s = time(&mut || {
        joined
            .evaluate(0., &y, &zero, Some(&seed), 20., None)
            .unwrap();
    });
    // The colored reference at cj = 20 /s: the operator's own loop.
    let cj = 20.;
    let signs = {
        let o = joined.offsets();
        let mut s = vec![1.; n];
        joined.evaluate(0., &y, &zero, None, 0., None).unwrap();
        s[..o.nuclear].copy_from_slice(&joined.network.column_signs(&y[..o.nuclear]));
        s
    };
    let mut values = vec![0.; pattern.nonzeros()];
    let mut seeded = vec![0.; n];
    let mut directions = vec![0.; n];
    let started = cpu();
    let mut reuse = joined.network.reuse();
    joined
        .evaluate(0., &y, &zero, None, 0., Some(&mut reuse))
        .unwrap();
    for color in 0..coloring.count() {
        coloring.seed_into(color, &signs, &mut seeded).unwrap();
        joined
            .evaluate(0., &y, &zero, Some(&seeded), cj, Some(&mut reuse))
            .unwrap();
        for (d, r) in directions.iter_mut().zip(joined.rows()) {
            *d = r.direction;
        }
        sparse::scatter(&pattern, &coloring, color, &directions, &signs, &mut values)
            .unwrap_or_else(|e| panic!("color {color}: {e}"));
    }
    let colored_s = cpu() - started;
    let (pointers, rows) = pattern.to_i64().unwrap();
    let klu = klu_profile(&pointers, &rows, &[values.clone()], 3);
    let klu_amd = klu_profile_ordered(&pointers, &rows, &[values.clone()], 3, 0);
    // Diagnostic: the same matrix with its exactly zero stored entries
    // dropped, i.e. the factorization of the dependencies this state has.
    let mut nz_columns = vec![Vec::new(); n];
    let mut nz_values = Vec::new();
    for (j, column) in nz_columns.iter_mut().enumerate() {
        let span = pattern.pointers()[j]..pattern.pointers()[j + 1];
        for (row, value) in pattern.indices()[span.clone()].iter().zip(&values[span]) {
            if *value != 0. || *row == j {
                column.push(*row);
                nz_values.push(*value);
            }
        }
    }
    let state_pattern = Pattern::from_columns(n, &nz_columns).unwrap();
    let (sp, sr) = state_pattern.to_i64().unwrap();
    let klu_state = klu_profile(&sp, &sr, &[nz_values], 3);
    let zeros = values.iter().filter(|v| **v == 0.).count();
    let offsets = joined.offsets();
    let receipt = json!({
        "kind": "s2-z5-joined-colored-reference-NOT-EVIDENCE",
        "team": "JAC",
        "status": if full { "zero-time measurement at the hot reference; S2 is not declared; the SG secondary and rod owners composed from the joined packet's sections" } else { "zero-time measurement at the hot reference; S2 is not declared; the SG secondary and rod ports hold the packet's prepared views and travel" },
        "clock": "CLOCK_THREAD_CPUTIME_ID, QOS_CLASS_USER_INTERACTIVE",
        "app_commit": commit, "app_dirty": dirty,
        "packet": declared.packet_path, "packet_sha256": sha256_file(&declared.packet_path),
        "water_build": serde_json::from_str::<Value>(include_str!(concat!(env!("LD01_OPERATING_WATER_LIB_DIR"), "/water-build.json"))).unwrap(),
        "load_average_start": load_start,
        "composition": {"dimension": n, "offsets": offsets, "flowing_preparation": flowing},
        "pattern": {"nonzeros": pattern.nonzeros(), "max_row_nonzeros": row_counts.iter().max(),
            "colors": coloring.count(), "compile_s": compile_s},
        "residual_ms": {"value": 1e3 * value_s, "seeded": 1e3 * seeded_s},
        "colored_jacobian_ms": 1e3 * colored_s, "cj_per_s": cj,
        "klu": klu,
        "klu_amd_ordering_diagnostic": klu_amd,
        "stored_exact_zeros": zeros,
        "klu_on_this_state_nonzeros_diagnostic": klu_state,
        "load_average_end": load_average(),
    });
    println!("{}", serde_json::to_string(&receipt).unwrap());
    if let Ok(path) = std::env::var("LD01_JAC_RECEIPT") {
        write_receipt(&path, &receipt);
    }
}
