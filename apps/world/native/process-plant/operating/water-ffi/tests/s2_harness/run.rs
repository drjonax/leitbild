//! The S2 runner's declared run and its record: what one run (settle, hold,
//! hold reference, trip, R0, R1, R2, a contrary case) is asked to do, and
//! everything it reports, in the receipt schema's run layout
//! ([`super::receipt::RUN_SCHEMA`]).
//!
//! Extension points (see `lanes/harness/status.md`):
//! - the runner loop (`advance` over a [`RunSpec`]: forced stops at commands
//!   and owner time events, root returns split into the owners' event roots
//!   and the observation root, `discrete_restart` with the ledger
//!   re-initialised, caps and guards) fills a [`RunRecord`];
//! - the identities and ledgers (`joined/account.rs`, `src/joined_ledger.rs`)
//!   fill `identities` and `ledger`;
//! - CPU attribution fills [`CpuBuckets`].
use super::receipt::{RUN_SCHEMA, missing};
use crate::counts::Counts;
use leitbild_operating_plant::joined::block::Command;
use serde_json::{Value, json};

/// One declared run, from the gates. Every field is set by the caller from
/// the declaration; nothing here has a default.
#[derive(Clone, Debug)]
pub struct RunSpec {
    pub name: String,
    /// Simulated span from the run's start (s).
    pub duration_s: f64,
    /// The capped event window from the start (s): `max_step_s` applies
    /// over it, and it ends at a forced stop where a continuation restarts.
    pub window_s: f64,
    /// Relative tolerance, and the factor on every absolute tolerance.
    pub rtol: f64,
    pub atol_factor: f64,
    /// IDASetMaxStep over the window; `None` leaves stock unbounded.
    pub max_step_s: Option<f64>,
    pub newton_coefficient: f64,
    pub delta_cj_lsetup: f64,
    /// IDASetInitStep at the start and at every restart (G13).
    pub first_step_s: f64,
    pub max_order: usize,
    /// Output interval (s), and the observation interval of the credited
    /// outputs by one root function (`None`: outputs only).
    pub output_s: f64,
    pub observation_s: Option<f64>,
    /// Declared commands at their times (the trip's `TurbineTrip` at 0).
    pub commands: Vec<(f64, Command)>,
    /// Solver-CPU cap and total-CPU guard (s); reaching either fails the run.
    pub solver_cap_s: f64,
    pub total_guard_s: f64,
    /// A step cap reported only (R0's), `None` where none is declared.
    pub report_only_step_cap: Option<i64>,
}

impl RunSpec {
    pub fn json(&self) -> Value {
        json!({"name": self.name, "duration_s": self.duration_s, "window_s": self.window_s,
            "rtol": self.rtol, "atol_factor": self.atol_factor, "max_step_s": self.max_step_s,
            "newton_coefficient": self.newton_coefficient, "delta_cj_lsetup": self.delta_cj_lsetup,
            "first_step_s": self.first_step_s, "max_order": self.max_order,
            "output_s": self.output_s, "observation_s": self.observation_s,
            "observed": self.observation_s.is_some(),
            "continuation": (self.window_s < self.duration_s).then(|| json!({"from_s": self.window_s, "max_step_s": null, "restart": "exact consistent start"})),
            "commands": self.commands.iter().map(|(t, c)| json!({"t_s": t, "command": c})).collect::<Vec<_>>(),
            "solver_cap_s": self.solver_cap_s, "total_guard_s": self.total_guard_s,
            "report_only_step_cap": self.report_only_step_cap})
    }
}

/// Process CPU of one run split by where it was spent (P7). Every bucket is
/// measured on the thread CPU clock around its own calls, except
/// `solver_internals_s`, which is the CPU inside stock `IDASolve` less every
/// callback measured inside it (residual, Jacobian, KLU, roots, ledger).
#[derive(Clone, Debug, Default)]
pub struct CpuBuckets {
    pub solver_internals_s: f64,
    pub residual_s: f64,
    pub jacobian_s: f64,
    /// Jacobian CPU by assembly kind (network local coupling, owner columns,
    /// nuclear partials, the rest), from the joined counters' shares.
    pub jacobian_by_kind: Value,
    pub klu_analyze_and_factor_s: f64,
    pub klu_refactor_s: f64,
    pub klu_solve_s: f64,
    pub consistent_start_s: f64,
    pub root_s: f64,
    pub observation_s: f64,
    pub ledger_s: f64,
    pub account_s: f64,
    pub harness_s: f64,
}

impl CpuBuckets {
    pub fn attributed(&self) -> f64 {
        self.solver_internals_s
            + self.residual_s
            + self.jacobian_s
            + self.klu_analyze_and_factor_s
            + self.klu_refactor_s
            + self.klu_solve_s
            + self.consistent_start_s
            + self.root_s
            + self.observation_s
            + self.ledger_s
            + self.account_s
            + self.harness_s
    }
    /// Solver CPU as the declaration defines it: process CPU less
    /// observation, root-return handling and the ledger (G11).
    pub fn solver(&self, process_s: f64) -> f64 {
        process_s - self.observation_s - self.ledger_s - self.account_s
    }
    pub fn json(&self, process_s: f64, clock: &str) -> Value {
        let attributed = self.attributed();
        json!({"process_s": process_s, "solver_s": self.solver(process_s), "attributed_s": attributed,
            "attributed_fraction": attributed / process_s, "clock": clock,
            "buckets": {"solver_internals_s": self.solver_internals_s, "residual_s": self.residual_s,
                "jacobian_s": self.jacobian_s, "jacobian_by_kind": self.jacobian_by_kind,
                "klu_analyze_and_factor_s": self.klu_analyze_and_factor_s, "klu_refactor_s": self.klu_refactor_s,
                "klu_solve_s": self.klu_solve_s, "consistent_start_s": self.consistent_start_s,
                "root_s": self.root_s, "observation_s": self.observation_s, "ledger_s": self.ledger_s,
                "account_s": self.account_s, "harness_s": self.harness_s}})
    }
}

/// Everything one run reports, in the receipt's run layout.
#[derive(Clone, Debug, Default)]
pub struct RunRecord {
    pub spec: Option<RunSpec>,
    pub reached_s: f64,
    pub failure: Option<String>,
    pub cap_reached: bool,
    pub counts: Counts,
    pub window_counts: Option<Counts>,
    pub continuation_counts: Option<Counts>,
    /// One entry per discrete restart: `{t_s, kind, transactions,
    /// placements, consistent_start, ledger_reinitialised, cpu_s}`.
    pub restarts: Vec<Value>,
    pub process_cpu_s: f64,
    pub cpu: CpuBuckets,
    pub clock: String,
    /// `{bound_relative, unit_energy, primary_mass, primary_boron, sg_mass}`
    /// from the joined account at every accepted sample.
    pub identities: Value,
    /// `{gate, bound_local_tolerance_units, closures, reinitialised_at_s,
    /// trapezoid}` from the IDAS ledger at every output.
    pub ledger: Value,
    pub outputs: usize,
    pub observations: usize,
    /// The credited outputs' summary (the series stay in the run).
    pub credited: Value,
}

impl RunRecord {
    /// Restarts by kind (a restart's `kind` field), for the receipt.
    pub fn restart_count_by_kind(&self) -> Value {
        let mut by = serde_json::Map::new();
        for r in &self.restarts {
            let kind = r["kind"].as_str().unwrap_or("unnamed").to_string();
            let n = by.get(&kind).and_then(Value::as_u64).unwrap_or(0);
            by.insert(kind, json!(n + 1));
        }
        Value::Object(by)
    }
    pub fn json(&self) -> Value {
        let spec = self.spec.as_ref().map(RunSpec::json).unwrap_or(Value::Null);
        let identity = |k: &str| self.identities.get(k).cloned().unwrap_or(Value::Null);
        let ledger = |k: &str| self.ledger.get(k).cloned().unwrap_or(Value::Null);
        json!({"configuration": spec,
            "reached_s": self.reached_s, "failure": self.failure, "cap_reached": self.cap_reached,
            "counts": self.counts.json(), "window_counts": self.window_counts.map(Counts::json),
            "continuation_counts": self.continuation_counts.map(Counts::json),
            "restarts": self.restarts, "restart_count_by_kind": self.restart_count_by_kind(),
            "cpu": self.cpu.json(self.process_cpu_s, &self.clock),
            "identities": {"bound_relative": identity("bound_relative"), "unit_energy": identity("unit_energy"),
                "primary_mass": identity("primary_mass"), "primary_boron": identity("primary_boron"), "sg_mass": identity("sg_mass")},
            "ledger": {"gate": ledger("gate"), "bound_local_tolerance_units": ledger("bound_local_tolerance_units"),
                "closures": ledger("closures"), "reinitialised_at_s": ledger("reinitialised_at_s"), "trapezoid": ledger("trapezoid")},
            "samples": {"outputs": self.outputs, "observations": self.observations},
            "credited": self.credited})
    }
    /// The run's own schema gaps (a run without a spec lacks its
    /// configuration's keys).
    pub fn gaps(&self) -> Vec<String> {
        let mut receipt = json!({"runs": {}});
        receipt["runs"]["run"] = self.json();
        missing(&receipt)
            .into_iter()
            .filter(|p| p.starts_with("/runs/"))
            .collect::<Vec<_>>()
            .into_iter()
            .filter(|p| RUN_SCHEMA.iter().any(|s| p.ends_with(s)))
            .collect()
    }
}
