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

/// Stock KLU's AMD ordering against its default COLAMD on S1's own solves:
/// the declared settling run to 46 s and the seizure and supply-loss
/// continuations for 2 s, on the block assembly. The lead's condition for
/// using AMD beyond the joined solves: S1's results stay inside tolerance.
/// Reported in IDA's error weights `1/(rtol |y| + atol)` at the outputs.
#[test]
#[ignore = "requires the S1 packet, the wiki gates, maintained IF97 and stock IDA/KLU; measurement"]
fn amd_against_colamd_on_s1() {
    use leitbild_operating_water::ida::KluOrdering;
    prefer_performance_core();
    let declared = Declared::load();
    let commit = command("git", &["rev-parse", "HEAD"]);
    let dirty = !command("git", &["status", "--porcelain"]).is_empty();
    let rtol = declared.gate(&["relativeTolerance"]);
    let (.., atol) = declared.prepared(leitbild_operating_water::If97);
    let weighted = |a: &[Vec<f64>], b: &[Vec<f64>]| {
        a.iter()
            .zip(b)
            .map(|(x, y)| {
                x.iter()
                    .zip(y)
                    .zip(&atol)
                    .map(|((p, q), at)| (p - q).abs() / (rtol * p.abs() + at))
                    .fold(0., f64::max)
            })
            .fold(0., f64::max)
    };
    let outputs = [1., 5., 20., 46.];
    let colamd = settle_ordered(&declared, &outputs, Assembly::Blocks, KluOrdering::Colamd);
    let amd = settle_ordered(&declared, &outputs, Assembly::Blocks, KluOrdering::Amd);
    let stats = |s: &Settled| {
        json!({"steps": s.stats.steps, "jacobians": s.stats.jacobians,
            "linear_setups": s.stats.linear_setups, "nonlinear_iterations": s.stats.nonlinear_iterations,
            "convergence_failures": s.stats.convergence_failures, "error_failures": s.stats.error_failures,
            "cpu_s": s.cpu_s})
    };
    let settled = colamd.outputs.last().unwrap().clone();
    let mut events = Vec::new();
    for kind in [Event::Seizure, Event::SupplyLoss] {
        let c = event_ordered(
            &declared,
            &settled,
            kind,
            Assembly::Blocks,
            2.,
            0.1,
            KluOrdering::Colamd,
        );
        let a = event_ordered(
            &declared,
            &settled,
            kind,
            Assembly::Blocks,
            2.,
            0.1,
            KluOrdering::Amd,
        );
        events.push(
            json!({"event": format!("{kind:?}"), "colamd": stats(&c), "amd": stats(&a),
            "max_weighted_difference": weighted(&c.outputs, &a.outputs)}),
        );
    }
    let receipt = json!({
        "kind": "s1-klu-ordering-drift-NOT-EVIDENCE",
        "team": "JAC",
        "status": "measurement of stock KLU's AMD ordering on S1's solves; S1/P2 keep COLAMD unless this stays inside tolerance",
        "app_commit": commit, "app_dirty": dirty,
        "packet": declared.packet_path,
        "settling": {"outputs_s": outputs, "colamd": stats(&colamd), "amd": stats(&amd),
            "max_weighted_difference": weighted(&colamd.outputs, &amd.outputs)},
        "events": events,
    });
    println!("{}", serde_json::to_string(&receipt).unwrap());
    if let Ok(path) = std::env::var("LD01_JAC_RECEIPT") {
        write_receipt(&path, &receipt);
    }
}
