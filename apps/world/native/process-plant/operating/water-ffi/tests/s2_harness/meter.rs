//! CPU attribution of an S2 run (RP7, G11): a stock-IDA [`System`] wrapper
//! that times every callback on the thread CPU clock, and the per-call
//! split of each `IDASolve` into the declaration's buckets.
//!
//! [`Metered`] delegates every callback unchanged (KLU ordering, roots and
//! quadratures included), so metering changes no step; it only reads the
//! thread clock around each call. The runner's [`Attribution`] then takes
//! each `IDASolve` call's thread CPU and:
//! - a call that returned at the observation root with `IDAGetNumSteps`
//!   unchanged is observation, in full (the declaration's rule (b));
//! - any other call is solver work: its residual, Jacobian, root-function
//!   and ledger-quadrature callback CPU go to their buckets, and the rest of
//!   the call (stock IDA's own work, stock KLU's setup and solves inside it
//!   included) to `solver_internals_s`;
//! - the output handler (account, credited outputs, D3 at each sample) is
//!   observation (rule (a)); a discrete restart's CPU is `consistent_start_s`
//!   (the exact start's assemblies, KLU and IDAReInit); ledger reads and
//!   closures at outputs are `account_s`; everything else the run's thread
//!   did is `harness_s`. Unattributed CPU is the process CPU outside the run
//!   thread's measured regions.
//!
//! Stock KLU's analyze, factor, refactor and solve run inside `IDASolve`,
//! out of reach of a System wrapper: separating them needs a timing shim on
//! the SUNLinSol_KLU ops in the lead-owned `src/ida.c` (S2-D16; proposal in
//! the HARNESS-B lane). Until then they stay inside `solver_internals_s`, and
//! the receipt prices them from the counts as a diagnostic only.
//!
//! The Jacobian is split by kind from the joined counters' wall shares (the
//! local coupler's tallies and the remaining assembly), scaled to the
//! measured Jacobian CPU.
use crate::{cpu::thread_cpu_s, observe::Observed};
use leitbild_operating_plant::joined::operator::CouplerCounters;
use leitbild_operating_water::{
    ida::{Failure, KluOrdering, System},
    joined::{Integrated, JoinedSystem},
};
use serde_json::{Value, json};

/// Calls and thread CPU of each callback kind.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Tally {
    pub residual: (u64, f64),
    pub jacobian: (u64, f64),
    pub roots: (u64, f64),
    pub quadrature: (u64, f64),
}

impl Tally {
    pub fn since(self, earlier: Self) -> Self {
        let d = |a: (u64, f64), b: (u64, f64)| (a.0 - b.0, a.1 - b.1);
        Self {
            residual: d(self.residual, earlier.residual),
            jacobian: d(self.jacobian, earlier.jacobian),
            roots: d(self.roots, earlier.roots),
            quadrature: d(self.quadrature, earlier.quadrature),
        }
    }
    pub fn cpu(&self) -> f64 {
        self.residual.1 + self.jacobian.1 + self.roots.1 + self.quadrature.1
    }
}

/// Times every callback of the wrapped system.
pub struct Metered<S> {
    pub inner: S,
    pub tally: Tally,
}

impl<S> Metered<S> {
    pub fn new(inner: S) -> Self {
        Self {
            inner,
            tally: Tally::default(),
        }
    }
}

fn timed<T>(slot: &mut (u64, f64), f: impl FnOnce() -> T) -> T {
    let started = thread_cpu_s();
    let out = f();
    slot.0 += 1;
    slot.1 += thread_cpu_s() - started;
    out
}

impl<S: System> System for Metered<S> {
    fn dimension(&self) -> usize {
        self.inner.dimension()
    }
    fn nonzeros(&self) -> usize {
        self.inner.nonzeros()
    }
    fn root_count(&self) -> usize {
        self.inner.root_count()
    }
    fn klu_ordering(&self) -> KluOrdering {
        self.inner.klu_ordering()
    }
    fn quadrature_count(&self) -> usize {
        self.inner.quadrature_count()
    }
    fn residual(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        let inner = &mut self.inner;
        timed(&mut self.tally.residual, || inner.residual(t, y, yp, out))
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
        let inner = &mut self.inner;
        timed(&mut self.tally.jacobian, || {
            inner.jacobian(t, cj, y, yp, data, rows, pointers)
        })
    }
    fn roots(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        let inner = &mut self.inner;
        timed(&mut self.tally.roots, || inner.roots(t, y, yp, out))
    }
    fn quadrature(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
        out: &mut [f64],
    ) -> Result<(), Failure> {
        let inner = &mut self.inner;
        timed(&mut self.tally.quadrature, || {
            inner.quadrature(t, y, yp, out)
        })
    }
}

impl<S: JoinedSystem> JoinedSystem for Metered<S> {
    type Properties = S::Properties;
    fn integrated(&self) -> &Integrated<S::Properties> {
        self.inner.integrated()
    }
    fn integrated_mut(&mut self) -> &mut Integrated<S::Properties> {
        self.inner.integrated_mut()
    }
}

impl<S: JoinedSystem> JoinedSystem for Observed<S> {
    type Properties = S::Properties;
    fn integrated(&self) -> &Integrated<S::Properties> {
        self.inner.integrated()
    }
    fn integrated_mut(&mut self) -> &mut Integrated<S::Properties> {
        self.inner.integrated_mut()
    }
}

/// The run's CPU by the declaration's attribution rule, accumulated per
/// `IDASolve` call and per handler.
#[derive(Clone, Debug, Default)]
pub struct Attribution {
    pub solver_internals_s: f64,
    pub residual: (u64, f64),
    pub jacobian: (u64, f64),
    pub roots: (u64, f64),
    pub quadrature: (u64, f64),
    pub consistent_start_s: f64,
    pub observation_handler_s: f64,
    /// Rule (b): whole `IDASolve` calls returning at an observation root
    /// with no step taken.
    pub observation_returns: (u64, f64),
    pub account_s: f64,
    /// Solver calls (any call that is not an observation return).
    pub solver_calls: (u64, f64),
    /// CPU of each solver call by window part: [window, after it].
    pub solver_by_part: [f64; 2],
    pub restarts_by_part: [f64; 2],
}

impl Attribution {
    /// One `IDASolve` call: its thread CPU, its callbacks' tally, and
    /// whether it was an observation-only return.
    pub fn call(&mut self, cpu_s: f64, callbacks: Tally, observation_only: bool, part: usize) {
        if observation_only {
            self.observation_returns.0 += 1;
            self.observation_returns.1 += cpu_s;
            return;
        }
        let add = |a: &mut (u64, f64), b: (u64, f64)| {
            a.0 += b.0;
            a.1 += b.1;
        };
        add(&mut self.residual, callbacks.residual);
        add(&mut self.jacobian, callbacks.jacobian);
        add(&mut self.roots, callbacks.roots);
        add(&mut self.quadrature, callbacks.quadrature);
        self.solver_internals_s += cpu_s - callbacks.cpu();
        self.solver_calls.0 += 1;
        self.solver_calls.1 += cpu_s;
        self.solver_by_part[part] += cpu_s;
    }
    pub fn restart(&mut self, cpu_s: f64, part: usize) {
        self.consistent_start_s += cpu_s;
        self.restarts_by_part[part] += cpu_s;
    }
    pub fn observation(&self) -> f64 {
        self.observation_handler_s + self.observation_returns.1
    }
    /// Solver CPU as G11 defines it, over the measured parts: solver calls
    /// (less the ledger's quadrature) and restarts.
    pub fn solver_s(&self) -> f64 {
        self.solver_calls.1 - self.quadrature.1 + self.consistent_start_s
    }
}

/// The Jacobian CPU by assembly kind: each kind's share of the joined
/// counters' Jacobian wall time over the run, applied to the measured CPU.
pub fn jacobian_by_kind(
    jacobian_cpu_s: f64,
    wall_s: f64,
    calls: usize,
    coupler: CouplerCounters,
) -> Value {
    let kinds = [
        ("network_local_coupling", coupler.local),
        ("solid_owner_columns", coupler.solid_columns),
        ("secondary_owner_columns", coupler.secondary_columns),
        ("rod_owner_columns", coupler.rod_columns),
        ("fuel_heat_columns", coupler.fuel_heat_columns),
        ("secondary_heat_columns", coupler.secondary_heat_columns),
    ];
    let named: f64 = kinds.iter().map(|(_, t)| t.wall_s).sum();
    let share = |w: f64| {
        if wall_s > 0. {
            jacobian_cpu_s * w / wall_s
        } else {
            0.
        }
    };
    let mut out = serde_json::Map::new();
    for (k, t) in kinds {
        out.insert(
            k.into(),
            json!({"calls": t.calls, "wall_s": t.wall_s, "cpu_s": share(t.wall_s)}),
        );
    }
    out.insert(
        "inside_local: solids, rods".into(),
        json!({"solids_wall_s": coupler.local_solids.wall_s, "rods_wall_s": coupler.local_rods.wall_s}),
    );
    out.insert(
        "rest (network-own columns, nuclear partials, assembly)".into(),
        json!({"wall_s": wall_s - named, "cpu_s": share(wall_s - named)}),
    );
    out.insert(
        "basis".into(),
        json!({"jacobians": calls, "jacobian_wall_s": wall_s, "jacobian_cpu_s": jacobian_cpu_s,
            "rule": "each kind's share of the block Jacobian's wall time (joined counters, local coupler tallies), applied to the Jacobian callbacks' measured thread CPU"}),
    );
    Value::Object(out)
}
