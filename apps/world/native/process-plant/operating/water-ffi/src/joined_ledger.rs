//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-spine-at-power
//! The joined operator with its conservation ledgers as stock IDAS
//! quadratures (G8, P5, K2).
//!
//! [`Ledgered`] is the joined [`Integrated`] system unchanged (residual,
//! Jacobian, roots and KLU ordering are delegated) plus one quadrature per
//! boundary term of the unit's account (`joined::account`): the primary's
//! net mass and boron receipts, each SG's feed, steam and relief mass and
//! energy, and the unit's event energy, motor work and bearing loss. Stock
//! IDAS integrates them over the accepted steps with `IDASetQuadErrCon`
//! false, so they never enter the error test and the state trajectory is
//! the one without them. At every discrete restart the ledger is carried:
//! its value at the restart time is read before `IDAReInit` and stock
//! `IDAQuadReInit` starts the next segment from it ([`restart_ledger`]).
//!
//! The integrand is evaluated at each converged step, a state the residual
//! may not have evaluated; a refusal there is fatal and recorded as the
//! ledger's own, never recoverable, so IDAS never retries a step on its
//! account (the trajectory would then depend on the ledger). No solver
//! algorithm or physical law lives here: the boundary terms are the
//! account's, read from the operator's own evaluation.
use crate::{
    ida::{Failure, Ida, KluOrdering, System},
    joined::{Integrated, JoinedSystem},
};
use leitbild_operating_plant::{
    joined::account::{Account, Plan},
    network::{self, Properties},
    thermal::WaterProperties,
};

/// Ledger integrand evaluations and their CPU on the harness's clock.
#[derive(Clone, Copy, Debug, Default)]
pub struct Counters {
    pub calls: usize,
    pub cpu_s: f64,
}

/// The joined system with its IDAS ledgers.
pub struct Ledgered<P: Properties> {
    pub integrated: Integrated<P>,
    pub plan: Plan,
    pub counters: Counters,
    /// The ledger integrand's refusal of a converged step, if any: the
    /// reason and the step's time.
    pub refusal: Option<(String, f64)>,
    /// The CPU clock the counters read (the harness's thread clock); this
    /// crate keeps no clock of its own.
    clock: fn() -> f64,
}

impl<P: Properties + WaterProperties> Ledgered<P> {
    /// The ledgers' plan is compiled from the integrated operator.
    pub fn new(integrated: Integrated<P>, clock: fn() -> f64) -> Result<Self, String> {
        let plan = Plan::new(&integrated.joined).map_err(message)?;
        Ok(Self {
            integrated,
            plan,
            counters: Counters::default(),
            refusal: None,
            clock,
        })
    }
    /// The ledgers' names, in quadrature order.
    pub fn names(&self) -> Vec<String> {
        self.plan.ledger_names()
    }
    /// The account at `(t, y, y')`, evaluated on the integrated operator.
    pub fn account(&mut self, t: f64, y: &[f64], yp: &[f64]) -> Result<Account, String> {
        self.integrated
            .joined
            .account(&self.plan, t, y, yp)
            .map_err(message)
    }
}

fn message(f: network::Failure) -> String {
    match f {
        network::Failure::Recoverable(r) | network::Failure::Fatal(r) => r,
    }
}

impl<P: Properties + WaterProperties> System for Ledgered<P> {
    fn dimension(&self) -> usize {
        self.integrated.dimension()
    }
    fn nonzeros(&self) -> usize {
        self.integrated.nonzeros()
    }
    fn root_count(&self) -> usize {
        self.integrated.root_count()
    }
    fn klu_ordering(&self) -> KluOrdering {
        self.integrated.klu_ordering()
    }
    fn residual(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        self.integrated.residual(t, y, yp, out)
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
        self.integrated.jacobian(t, cj, y, yp, data, rows, pointers)
    }
    fn roots(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        self.integrated.roots(t, y, yp, out)
    }
    fn quadrature_count(&self) -> usize {
        self.plan.ledger_names().len()
    }
    fn quadrature(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
        out: &mut [f64],
    ) -> Result<(), Failure> {
        let started = (self.clock)();
        let result = self.account(t, y, yp);
        self.counters.calls += 1;
        self.counters.cpu_s += (self.clock)() - started;
        match result {
            Ok(account) if account.boundary.len() == out.len() => {
                out.copy_from_slice(&account.boundary);
                Ok(())
            }
            Ok(account) => Err(Failure::Fatal(format!(
                "ledger integrand length {} for {} quadratures",
                account.boundary.len(),
                out.len()
            ))),
            Err(reason) => {
                let reason =
                    format!("ledger integrand refused the converged step at t={t} s ({reason})");
                self.refusal = Some((reason.clone(), t));
                Err(Failure::Fatal(reason))
            }
        }
    }
}

impl<P: Properties + WaterProperties> JoinedSystem for Ledgered<P> {
    type Properties = P;
    fn integrated(&self) -> &Integrated<P> {
        &self.integrated
    }
    fn integrated_mut(&mut self) -> &mut Integrated<P> {
        &mut self.integrated
    }
}

/// One ledger segment: where it starts and the ledger carried into it.
#[derive(Clone, Debug)]
pub struct Segment {
    pub started_s: f64,
    pub started_q: Vec<f64>,
}

/// Start the ledgers on a new handle at its start time (stock
/// `IDAQuadInit`), from `q0` (zero at a run's start).
pub fn start_ledger<S: System>(ida: &mut Ida<S>, t: f64, q0: Vec<f64>) -> Result<Segment, String> {
    ida.initialize_quadratures(&q0)?;
    Ok(Segment {
        started_s: t,
        started_q: q0,
    })
}

/// The ledger at `t`: the segment's carried value before its first
/// advance, otherwise stock `IDAGetQuad` at the last returned time, which
/// must be `t`.
pub fn ledger_at<S: System>(ida: &Ida<S>, segment: &Segment, t: f64) -> Result<Vec<f64>, String> {
    if t == segment.started_s {
        return Ok(segment.started_q.clone());
    }
    let mut q = vec![0.; segment.started_q.len()];
    let returned = ida.quadratures(&mut q)?;
    if returned != t {
        return Err(format!(
            "ledger read at {t} s, but the last return was {returned} s"
        ));
    }
    Ok(q)
}

/// The ledger across a discrete restart at `t`: `carried` is
/// [`ledger_at`]`(t)` read before the restart; after `discrete_restart`
/// (which ran `IDAReInit`), stock `IDAQuadReInit` starts the next segment
/// from it. A transaction moves energy only between stores the inventory
/// holds (a seat's arrival energy into its fitting), so nothing is added.
pub fn restart_ledger<S: System>(
    ida: &mut Ida<S>,
    t: f64,
    carried: Vec<f64>,
) -> Result<Segment, String> {
    ida.reinitialize_quadratures(&carried)?;
    Ok(Segment {
        started_s: t,
        started_q: carried,
    })
}
