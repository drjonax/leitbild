//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#6-solver-properties-and-cost-obligations
//! The cj-linear iteration-matrix refresh (JAC item 9), measured on S1's
//! restart ramps: the declared rotor's seizure and supply loss, continued
//! from the settled state by stock IDA on the block assembly. It compares
//! three refresh policies (see `jacobian_harness::recombine`): full
//! evaluations, recombinations, Newton and error-test failures and steps,
//! and the trajectory against the fresh policy in IDA's own error weights.
//! A measurement only, NOT adopted and NOT evidence; the cap-cycle probes
//! are DONOR's.
#![cfg(all(feature = "ida", target_os = "macos"))]
mod jacobian_harness;
use jacobian_harness::{recombine::Policy, *};
use serde_json::json;

#[test]
#[ignore = "requires the S1 packet, the wiki gates, maintained IF97 and stock IDA/KLU; measurement"]
fn cj_linear_refresh_on_s1_restart_ramps() {
    prefer_performance_core();
    let declared = Declared::load();
    let commit = command("git", &["rev-parse", "HEAD"]);
    let dirty = !command("git", &["status", "--porcelain"]).is_empty();
    let settled = settle(&declared, &[46.], Assembly::Blocks)
        .outputs
        .pop()
        .unwrap();
    let rtol = declared.gate(&["relativeTolerance"]);
    let (.., atol) = declared.prepared(leitbild_operating_water::If97);
    let (duration, interval) = (2., 0.1);
    let mut cases = Vec::new();
    for kind in [Event::Seizure, Event::SupplyLoss] {
        let mut fresh: Option<Vec<Vec<f64>>> = None;
        let mut runs = Vec::new();
        for policy in [Policy::Fresh, Policy::Identical, Policy::Forward] {
            let (outputs, stats, counts, cpu_s, marks) =
                event_recombined(&declared, &settled, kind, duration, interval, policy);
            // The largest weighted difference from the fresh trajectory at
            // the outputs, in IDA's error weights 1/(rtol |y| + atol).
            let weighted = fresh.as_ref().map(|f| {
                f.iter()
                    .zip(&outputs)
                    .map(|(a, b)| {
                        a.iter()
                            .zip(b)
                            .zip(&atol)
                            .map(|((x, y), at)| (x - y).abs() / (rtol * x.abs() + at))
                            .fold(0., f64::max)
                    })
                    .fold(0., f64::max)
            });
            runs.push(json!({"policy": format!("{policy:?}"), "counts": counts,
                "steps": stats.steps, "jacobian_calls": stats.jacobians,
                "linear_setups": stats.linear_setups,
                "nonlinear_iterations": stats.nonlinear_iterations,
                "convergence_failures": stats.convergence_failures,
                "error_failures": stats.error_failures, "residuals": stats.residuals,
                "cpu_s": cpu_s, "max_weighted_difference_from_fresh": weighted,
                "marks": marks}));
            if policy == Policy::Fresh {
                fresh = Some(outputs);
            }
        }
        cases.push(json!({"event": format!("{kind:?}"), "duration_s": duration, "runs": runs}));
    }
    let receipt = json!({
        "kind": "s2-cj-linear-refresh-restart-ramp-NOT-EVIDENCE",
        "team": "JAC",
        "status": "measurement on S1's restart ramps; the refresh is not adopted",
        "app_commit": commit, "app_dirty": dirty,
        "packet": declared.packet_path,
        "cases": cases,
    });
    println!("{}", serde_json::to_string(&receipt).unwrap());
    if let Ok(path) = std::env::var("LD01_JAC_RECEIPT") {
        write_receipt(&path, &receipt);
    }
}
