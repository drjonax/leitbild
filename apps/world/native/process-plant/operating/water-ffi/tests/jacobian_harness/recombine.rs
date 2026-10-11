//! Measurement of the cj-linear iteration-matrix refresh (JAC item 9).
//! NOT a production path and not adopted: the lead asked for it to be
//! measured on the cap-cycle probes and a restart ramp first.
//!
//! The stage matrix is exactly linear in `cj`: `M(cj) = A + cj B`, with
//! `A = dF/dy` and `B = dF/dy'` at the state of evaluation. `Recombined`
//! wraps any system. At a full evaluation it returns the inner system's own
//! `M(cj)`, bit for bit, and keeps `A = M(0)` and `B = M(1) - M(0)` from two
//! more inner calls at the same state. When the policy allows it, a later
//! call returns `A + cj B` from those kept matrices instead of evaluating.
//!
//! Policies:
//! - `Fresh`: always evaluate (the stock behaviour). It counts how often a
//!   call's `(t, y, y')` repeats the last full evaluation's bits.
//! - `Identical`: recombine only at a bitwise-identical `(t, y, y')`. The
//!   matrices are then exact for the new `cj`, so this is always safe.
//! - `Forward`: recombine at an attempt-start setup: a call at a later
//!   time than the kept evaluation, right after that attempt's first
//!   residual, with no residual since at a later time. Stock's Newton
//!   evaluates the residual at the new prediction first and then sets up,
//!   so a refresh triggered only by the cj ratio (or a first step) appears
//!   this way. A retry after a failed Newton iteration with a stale matrix
//!   comes after further residuals at the same time, and a retry after a
//!   reduced step comes at an earlier time; both get a full evaluation. So
//!   does every call after `invalidate`, which the caller invokes at each
//!   discrete restart. The kept matrices are then stale in `(t, y, y')`,
//!   which is what the measurement must judge.
//!
//! Full evaluations cost three inner calls here. The measurement counts
//! them as one; only the counts, not this cost, are its result.
use leitbild_operating_water::ida::{Failure, KluOrdering, System};
use std::{cell::RefCell, rc::Rc};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy {
    Fresh,
    Identical,
    Forward,
}

#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct Counts {
    /// Every Jacobian call stock IDA made.
    pub calls: u64,
    /// Calls answered by evaluating the inner system.
    pub full: u64,
    /// Calls answered by `A + cj B` from the kept matrices.
    pub recombined: u64,
    /// Calls, under any policy, whose `(t, y, y')` repeated the kept full
    /// evaluation's bits.
    pub identical_state: u64,
}

pub struct Recombined<S> {
    pub inner: S,
    pub policy: Policy,
    pub counts: Rc<RefCell<Counts>>,
    kept: Option<Kept>,
    /// Latest residual time, and the residuals evaluated at it.
    latest_residual: f64,
    at_latest: u64,
    /// Time of the previous Jacobian call.
    last_call: Option<u64>,
}
struct Kept {
    t: u64,
    y: Vec<u64>,
    yp: Vec<u64>,
    a: Vec<f64>,
    b: Vec<f64>,
    rows: Vec<i64>,
    pointers: Vec<i64>,
}

impl<S> Recombined<S> {
    pub fn new(inner: S, policy: Policy, counts: Rc<RefCell<Counts>>) -> Self {
        Self {
            inner,
            policy,
            counts,
            kept: None,
            latest_residual: f64::NEG_INFINITY,
            at_latest: 0,
            last_call: None,
        }
    }
    /// Forget the kept matrices: the residual's discrete branch changed.
    pub fn invalidate(&mut self) {
        self.kept = None;
    }
}

fn bits(v: &[f64]) -> Vec<u64> {
    v.iter().map(|x| x.to_bits()).collect()
}

impl<S: System> System for Recombined<S> {
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
    fn residual(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        if t > self.latest_residual {
            self.latest_residual = t;
            self.at_latest = 1;
        } else if t == self.latest_residual {
            self.at_latest += 1;
        }
        self.inner.residual(t, y, yp, out)
    }
    fn roots(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        self.inner.roots(t, y, yp, out)
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
        let mut counts = self.counts.borrow_mut();
        counts.calls += 1;
        let identical = self
            .kept
            .as_ref()
            .is_some_and(|k| k.t == t.to_bits() && k.y == bits(y) && k.yp == bits(yp));
        if identical {
            counts.identical_state += 1;
        }
        let recombine = match self.policy {
            Policy::Fresh => false,
            Policy::Identical => identical,
            Policy::Forward => self.kept.as_ref().is_some_and(|k| {
                identical
                    || (t > f64::from_bits(k.t)
                        && t == self.latest_residual
                        && self.at_latest == 1
                        && self.last_call.is_none_or(|c| c != t.to_bits()))
            }),
        };
        self.last_call = Some(t.to_bits());
        if recombine {
            let k = self.kept.as_ref().unwrap();
            for ((d, a), b) in data.iter_mut().zip(&k.a).zip(&k.b) {
                *d = a + cj * b;
            }
            rows.copy_from_slice(&k.rows);
            pointers.copy_from_slice(&k.pointers);
            counts.recombined += 1;
            return Ok(());
        }
        drop(counts);
        let mut a = vec![0.; data.len()];
        let mut one = vec![0.; data.len()];
        self.inner.jacobian(t, 0., y, yp, &mut a, rows, pointers)?;
        self.inner
            .jacobian(t, 1., y, yp, &mut one, rows, pointers)?;
        self.inner.jacobian(t, cj, y, yp, data, rows, pointers)?;
        let b: Vec<f64> = one.iter().zip(&a).map(|(m, a)| m - a).collect();
        self.kept = Some(Kept {
            t: t.to_bits(),
            y: bits(y),
            yp: bits(yp),
            a,
            b,
            rows: rows.to_vec(),
            pointers: pointers.to_vec(),
        });
        self.counts.borrow_mut().full += 1;
        Ok(())
    }
}
