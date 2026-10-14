//! Observation by one stock root function, shared by the S1 and S2 gate
//! harnesses (moved from s1_hydraulics.rs). [`Observed`] delegates every
//! stock-IDA callback of the system it wraps unchanged, the KLU ordering
//! and quadratures included, and appends one root function g = t - next
//! after the wrapped system's own roots; [`Clock`] arms its times.
//!
//! Include it with `#[path = "common/observe.rs"] mod observe;`.
#![allow(dead_code)] // Each test crate uses its own subset.
use leitbild_operating_water::ida::{Failure, KluOrdering, System};
use std::{cell::Cell as Slot, rc::Rc};

/// `span` is a whole number, at least one, of `unit`s, to rounding.
pub fn whole(span: f64, unit: f64) -> bool {
    let n = (span / unit).round();
    n >= 1. && (n * unit - span).abs() <= 1e-9 * span
}

/// Delegates every stock-IDA callback unchanged (the KLU ordering and the
/// quadratures included) and, when observing, declares one root function
/// g = t - next after the wrapped system's own roots. Stock IDA locates its
/// zeros on its own interpolant after each step and returns there, so
/// observing changes no step, order, Newton iteration or Jacobian. A root
/// return reports the observation in its last direction ([`Observed::split`]).
pub struct Observed<S> {
    pub inner: S,
    pub next: Option<Rc<Slot<f64>>>,
    /// The wrapped system's own root count, read once.
    own: usize,
}
impl<S: System> Observed<S> {
    /// The S1 harness's observation: the wrapped system declares no roots of
    /// its own.
    pub fn new(inner: S, next: Option<Rc<Slot<f64>>>) -> Self {
        assert_eq!(
            inner.root_count(),
            0,
            "the observed system declares roots of its own"
        );
        Self::after_roots(inner, next)
    }
    /// Observation after the wrapped system's own root functions (the S2
    /// harness: the joined owners' event roots come first).
    pub fn after_roots(inner: S, next: Option<Rc<Slot<f64>>>) -> Self {
        let own = inner.root_count();
        Self { inner, next, own }
    }
    /// The wrapped system's root directions and whether the observation
    /// root was located, from one root return's directions.
    pub fn split<'a>(&self, directions: &'a [i32]) -> (&'a [i32], bool) {
        let (own, observation) = directions.split_at(self.own);
        (own, observation.first().is_some_and(|d| *d != 0))
    }
}
impl<S: System> System for Observed<S> {
    fn dimension(&self) -> usize {
        self.inner.dimension()
    }
    fn nonzeros(&self) -> usize {
        self.inner.nonzeros()
    }
    fn root_count(&self) -> usize {
        self.own + usize::from(self.next.is_some())
    }
    fn klu_ordering(&self) -> KluOrdering {
        self.inner.klu_ordering()
    }
    fn quadrature_count(&self) -> usize {
        self.inner.quadrature_count()
    }
    fn quadrature(
        &mut self,
        time: f64,
        y: &[f64],
        yp: &[f64],
        out: &mut [f64],
    ) -> Result<(), Failure> {
        self.inner.quadrature(time, y, yp, out)
    }
    fn residual(
        &mut self,
        time: f64,
        y: &[f64],
        yp: &[f64],
        out: &mut [f64],
    ) -> Result<(), Failure> {
        self.inner.residual(time, y, yp, out)
    }
    fn jacobian(
        &mut self,
        time: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        data: &mut [f64],
        rows: &mut [i64],
        pointers: &mut [i64],
    ) -> Result<(), Failure> {
        self.inner.jacobian(time, cj, y, yp, data, rows, pointers)
    }
    fn roots(&mut self, time: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        let (own, observation) = out.split_at_mut(self.own);
        if self.own > 0 {
            self.inner.roots(time, y, yp, own)?;
        }
        match (&self.next, observation.is_empty()) {
            (Some(next), false) => {
                observation.fill(time - next.get());
                Ok(())
            }
            (None, true) => Ok(()),
            _ => Err(Failure::Fatal(
                "root evaluation without an observation clock".into(),
            )),
        }
    }
}
/// Fine observation times j*dt over [0, window], skipping the output grid
/// that `advance` targets reach; `next` is the root function's time.
pub struct Clock {
    pub next: Rc<Slot<f64>>,
    dt: f64,
    per_output: usize,
    /// Index of the window's end; observations by root lie below it.
    end: usize,
    /// A time past the run's end, never reached.
    never: f64,
    j: usize,
}
impl Clock {
    pub fn new(dt: f64, output_s: f64, window_s: f64, never: f64) -> Self {
        assert!(
            whole(output_s, dt) && output_s / dt >= 2. && whole(window_s, output_s),
            "fine observation grid: {dt} s within {output_s} s outputs over {window_s} s"
        );
        Self {
            next: Rc::new(Slot::new(never)),
            dt,
            per_output: (output_s / dt).round() as usize,
            end: (window_s / dt).round() as usize,
            never,
            j: 0,
        }
    }
    /// Arm the next observation strictly inside an output interval.
    pub fn arm(&mut self) {
        self.j += 1;
        while self.j.is_multiple_of(self.per_output) {
            self.j += 1;
        }
        self.next.set(if self.j < self.end {
            self.j as f64 * self.dt
        } else {
            self.never
        });
    }
}
