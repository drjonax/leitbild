//! Stock IDA counters of a run and their sums over restarts, shared by the
//! S1 and S2 gate harnesses (moved unchanged from s1_hydraulics.rs).
//!
//! Include it with `#[path = "common/counts.rs"] mod counts;`.
#![allow(dead_code)] // Each test crate uses its own subset.
use leitbild_operating_water::ida::Stats;
use serde_json::{Value, json};

/// Stock counters at one point of a run.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Counts {
    pub steps: i64,
    pub residuals: i64,
    pub jacobians: i64,
    pub nonlinear_iterations: i64,
    pub error_failures: i64,
    /// IDAGetNumNonlinSolvConvFails ([`CONVERGENCE_FAILURES_COUNTER`]).
    pub convergence_failures: i64,
    pub linear_setups: i64,
}
/// What stock's Newton convergence-failure count counts, as the receipt
/// states it (SUNDIALS 7.5.0 `sunnonlinsol_newton.c`).
pub const CONVERGENCE_FAILURES_COUNTER: &str = "IDAGetNumNonlinSolvConvFails (SUNDIALS 7.5.0): every failed Newton attempt of stock's SUNNonlinSol_Newton, including one retried within the same step with a fresh Jacobian (counted even when that retry converges) and one ended by a recoverable residual or linear-solve failure; the same counter behind H1a's run-4 figures";
impl Counts {
    pub fn of(s: &Stats) -> Self {
        Self {
            steps: s.steps,
            residuals: s.residuals,
            jacobians: s.jacobians,
            nonlinear_iterations: s.nonlinear_iterations,
            error_failures: s.error_failures,
            convergence_failures: s.convergence_failures,
            linear_setups: s.linear_setups,
        }
    }
    /// The counts after `earlier` in the same history (R0's past its
    /// window's end).
    pub fn since(self, earlier: Self) -> Self {
        Self {
            steps: self.steps - earlier.steps,
            residuals: self.residuals - earlier.residuals,
            jacobians: self.jacobians - earlier.jacobians,
            nonlinear_iterations: self.nonlinear_iterations - earlier.nonlinear_iterations,
            error_failures: self.error_failures - earlier.error_failures,
            convergence_failures: self.convergence_failures - earlier.convergence_failures,
            linear_setups: self.linear_setups - earlier.linear_setups,
        }
    }
    /// The counts of one run over two histories: these, then `later`'s
    /// after a restart (stock restarts its counters at IDAReInit).
    pub fn plus(self, later: Self) -> Self {
        Self {
            steps: self.steps + later.steps,
            residuals: self.residuals + later.residuals,
            jacobians: self.jacobians + later.jacobians,
            nonlinear_iterations: self.nonlinear_iterations + later.nonlinear_iterations,
            error_failures: self.error_failures + later.error_failures,
            convergence_failures: self.convergence_failures + later.convergence_failures,
            linear_setups: self.linear_setups + later.linear_setups,
        }
    }
    pub fn json(self) -> Value {
        json!({"steps":self.steps,"residuals":self.residuals,"jacobians":self.jacobians,"nonlinear_iterations":self.nonlinear_iterations,"error_failures":self.error_failures,"convergence_failures":self.convergence_failures,"linear_setups":self.linear_setups})
    }
}

/// A run's stock counters (from its start) and step at one of its outputs,
/// which stock reaches by interpolation, with no forced stop: the step that
/// straddles the output counts before it.
#[derive(Clone, Copy, Debug, Default)]
pub struct Mark {
    pub t: f64,
    pub counts: Counts,
    pub last_step_s: f64,
    pub last_order: i32,
    /// The step stock will attempt next.
    pub current_step_s: f64,
}
