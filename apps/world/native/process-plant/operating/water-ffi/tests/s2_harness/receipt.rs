//! The S2 receipt schema: every section a gate-run or smoke receipt carries,
//! as required JSON pointers, and the check that refuses a receipt missing
//! any of them. The schema is the contract between the runner (which fills
//! the runs), the comparisons and gates (which judge them) and the ledgers
//! and identities (which close them); a receipt is written only after
//! [`missing`] is empty.
//!
//! Layout (values `null` only where the schema says a section may be absent):
//!
//! ```text
//! kind, status, verdict
//! declaration   page, gates{fence,page,page_sha256,block,unread}, accuracy{..},
//!               shared{fence,page,page_sha256}, contract{fence,page,page_sha256,block}
//! provenance    app_commit, app_worktree_dirty, wiki, wiki_commit, wiki_commit_named,
//!               packet, packet_sha256, water_build, sundials_prefix, features
//! machine       cpu_model, scheduling, core_class, load_average_start, load_average_end
//! configuration rtol, atol, max_order, newton_coefficient, delta_cj_lsetup,
//!               restart_initial_step_s, klu_ordering, output_s, observation_s,
//!               credited_band_hz, assembly
//! zero_time     composed, settled                      (Z receipts; null until run)
//! runs.<name>   see RUN_SCHEMA
//! comparisons.<name> run, reference, window_s, metrics, within
//! gates[]       id, value, bound, pass, judged, basis
//! work_bound    total_cpu_s, bound_s, within, runs.<name>{solver_cpu_s, solver_cap_s,
//!               total_cpu_s, total_guard_s, cap_reached}
//! cost          process_cpu_s, wall_s
//! ```
use serde_json::{Value, json};

/// Top-level pointers every S2 receipt carries.
pub const TOP_SCHEMA: &[&str] = &[
    "/kind",
    "/status",
    "/verdict",
    "/declaration/page",
    "/declaration/gates/page_sha256",
    "/declaration/gates/block",
    "/declaration/gates/unread",
    "/declaration/accuracy/block",
    "/declaration/accuracy/unread",
    "/declaration/shared/page_sha256",
    "/declaration/contract/block",
    "/provenance/app_commit",
    "/provenance/app_worktree_dirty",
    "/provenance/wiki",
    "/provenance/wiki_commit",
    "/provenance/wiki_commit_named",
    "/provenance/packet",
    "/provenance/packet_sha256",
    "/provenance/water_build",
    "/provenance/sundials_prefix",
    "/provenance/features",
    "/machine/cpu_model",
    "/machine/scheduling",
    "/machine/core_class",
    "/machine/load_average_start",
    "/machine/load_average_end",
    "/configuration/rtol",
    "/configuration/atol",
    "/configuration/max_order",
    "/configuration/newton_coefficient",
    "/configuration/delta_cj_lsetup",
    "/configuration/restart_initial_step_s",
    "/configuration/klu_ordering",
    "/configuration/output_s",
    "/configuration/observation_s",
    "/configuration/credited_band_hz",
    "/configuration/assembly",
    "/zero_time",
    "/runs",
    "/comparisons",
    "/gates",
    "/work_bound/total_cpu_s",
    "/work_bound/bound_s",
    "/work_bound/within",
    "/work_bound/runs",
    "/cost/process_cpu_s",
    "/cost/wall_s",
];

/// Pointers, relative to `/runs/<name>`, every run carries.
pub const RUN_SCHEMA: &[&str] = &[
    // What was declared for this run.
    "/configuration/duration_s",
    "/configuration/window_s",
    "/configuration/rtol",
    "/configuration/atol_factor",
    "/configuration/max_step_s",
    "/configuration/newton_coefficient",
    "/configuration/delta_cj_lsetup",
    "/configuration/max_order",
    "/configuration/observed",
    "/configuration/continuation",
    // How it ended.
    "/reached_s",
    "/failure",
    "/cap_reached",
    // Stock counters: the whole run, the window and the continuation.
    "/counts",
    "/window_counts",
    "/continuation_counts",
    // Every discrete restart: time, kind, transactions, consistent start.
    "/restarts",
    "/restart_count_by_kind",
    // CPU attribution (P7): buckets summing to at least 95 % of process CPU.
    "/cpu/process_s",
    "/cpu/solver_s",
    "/cpu/attributed_s",
    "/cpu/attributed_fraction",
    "/cpu/buckets/solver_internals_s",
    "/cpu/buckets/residual_s",
    "/cpu/buckets/jacobian_s",
    "/cpu/buckets/jacobian_by_kind",
    "/cpu/buckets/klu_analyze_and_factor_s",
    "/cpu/buckets/klu_refactor_s",
    "/cpu/buckets/klu_solve_s",
    "/cpu/buckets/consistent_start_s",
    "/cpu/buckets/root_s",
    "/cpu/buckets/observation_s",
    "/cpu/buckets/ledger_s",
    "/cpu/buckets/account_s",
    "/cpu/buckets/harness_s",
    "/cpu/clock",
    // Conservation: the identities at every accepted sample and the IDAS
    // ledgers at every output (G8, P5, K2).
    "/identities/bound_relative",
    "/identities/unit_energy",
    "/identities/primary_mass",
    "/identities/primary_boron",
    "/identities/sg_mass",
    "/ledger/gate",
    "/ledger/bound_local_tolerance_units",
    "/ledger/closures",
    "/ledger/reinitialised_at_s",
    "/ledger/trapezoid",
    // Observation and the credited outputs' summary.
    "/samples/outputs",
    "/samples/observations",
    "/credited",
];

/// Pointers, relative to `/comparisons/<name>`, every comparison carries.
pub const COMPARISON_SCHEMA: &[&str] = &["/run", "/reference", "/window_s", "/metrics", "/within"];

/// Pointers, relative to each `/gates/<i>`, every gate verdict carries.
pub const GATE_SCHEMA: &[&str] = &["/id", "/value", "/bound", "/pass", "/judged", "/basis"];

/// Every schema pointer the receipt lacks, `runs`, `comparisons` and
/// `gates` entries included. A key present with value `null` counts as
/// present: the schema names where `null` is a declared answer.
pub fn missing(receipt: &Value) -> Vec<String> {
    let mut out: Vec<String> = TOP_SCHEMA
        .iter()
        .filter(|p| receipt.pointer(p).is_none())
        .map(|p| p.to_string())
        .collect();
    let mut nested = |section: &str, schema: &[&str]| {
        if let Some(map) = receipt.pointer(section).and_then(Value::as_object) {
            for (name, entry) in map {
                for p in schema {
                    if entry.pointer(p).is_none() {
                        out.push(format!("{section}/{name}{p}"));
                    }
                }
            }
        }
    };
    nested("/runs", RUN_SCHEMA);
    nested("/comparisons", COMPARISON_SCHEMA);
    if let Some(gates) = receipt.pointer("/gates").and_then(Value::as_array) {
        for (i, g) in gates.iter().enumerate() {
            for p in GATE_SCHEMA {
                if g.pointer(p).is_none() {
                    out.push(format!("/gates/{i}{p}"));
                }
            }
        }
    } else if receipt.pointer("/gates").is_some() {
        out.push("/gates (not an array)".into());
    }
    out
}

/// Set `pointer` (with every missing parent object) in `receipt`.
pub fn put(receipt: &mut Value, pointer: &str, value: Value) {
    let mut at = receipt;
    let parts: Vec<&str> = pointer.trim_start_matches('/').split('/').collect();
    for (i, part) in parts.iter().enumerate() {
        if !at.is_object() {
            *at = json!({});
        }
        let map = at.as_object_mut().unwrap();
        if i + 1 == parts.len() {
            map.insert(part.to_string(), value);
            return;
        }
        at = map.entry(part.to_string()).or_insert_with(|| json!({}));
    }
}

/// A gate verdict entry: `judged` false reports the value without judging
/// it (a report-only quantity or an unevaluable gate, whose `pass` is false).
pub fn gate(id: &str, value: Value, bound: Value, pass: bool, judged: bool, basis: &str) -> Value {
    json!({"id": id, "value": value, "bound": bound, "pass": pass, "judged": judged, "basis": basis})
}

/// Write the receipt to a NEW file; refuses an incomplete receipt and never
/// overwrites one.
pub fn write(path: &std::path::Path, receipt: &Value) -> Result<(), String> {
    let gaps = missing(receipt);
    if !gaps.is_empty() {
        return Err(format!(
            "the receipt lacks {} schema entries: {gaps:?}",
            gaps.len()
        ));
    }
    if path.exists() {
        return Err(format!(
            "receipts are never overwritten: {}",
            path.display()
        ));
    }
    std::fs::write(path, serde_json::to_vec_pretty(receipt).unwrap())
        .map_err(|e| format!("{}: {e}", path.display()))
}
