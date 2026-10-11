#![cfg(feature = "ida")]
use leitbild_operating_water::ida::{Advance, Failure, Ida, Initial, System};
use std::f64::consts::LN_2;
struct Decay {
    panic: bool,
    fatal: bool,
}
impl System for Decay {
    fn dimension(&self) -> usize {
        2
    }
    fn nonzeros(&self) -> usize {
        3
    }
    fn root_count(&self) -> usize {
        0
    }
    fn roots(&mut self, _: f64, _: &[f64], _: &[f64], _: &mut [f64]) -> Result<(), Failure> {
        Ok(())
    }
    fn residual(&mut self, _: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        assert!(!self.panic, "deliberate boundary panic");
        if self.fatal {
            return Err(Failure::Fatal("deliberate ownership failure".into()));
        }
        out[0] = yp[0] + y[0];
        out[1] = y[1] - 2. * y[0];
        Ok(())
    }
    fn jacobian(
        &mut self,
        _: f64,
        cj: f64,
        _: &[f64],
        _: &[f64],
        data: &mut [f64],
        rows: &mut [i64],
        pointers: &mut [i64],
    ) -> Result<(), Failure> {
        data.copy_from_slice(&[cj + 1., -2., 1.]);
        rows.copy_from_slice(&[0, 1, 1]);
        pointers.copy_from_slice(&[0, 2, 3]);
        Ok(())
    }
}
fn start<S: System>(system: S, y: &[f64], yp: &[f64], relative: f64, absolute: f64) -> Ida<S> {
    Ida::new(
        system,
        Initial {
            time: 0.,
            y,
            yp,
            differential: &[1., 0.],
            absolute_tolerance: &[absolute; 2],
            relative_tolerance: relative,
        },
    )
    .unwrap()
}
fn new(system: Decay, y: &[f64], yp: &[f64]) -> Ida<Decay> {
    start(system, y, yp, 1e-8, 1e-10)
}
fn decay() -> Decay {
    Decay {
        panic: false,
        fatal: false,
    }
}
#[test]
fn stock_ida_initializes_and_advances_an_index_one_system_without_resetting_stock() {
    let mut y = [1., 0.];
    let mut yp = [0.; 2];
    let mut ida = new(
        Decay {
            panic: false,
            fatal: false,
        },
        &y,
        &yp,
    );
    assert!(ida.constrain_nonnegative(&[2]).is_err());
    ida.constrain_nonnegative(&[0]).unwrap();
    ida.initialize(0.1, &mut y, &mut yp).unwrap();
    assert_eq!(y[0], 1.);
    assert!((y[1] - 2.).abs() < 1e-9 && (yp[0] + 1.).abs() < 1e-9);
    ida.stop_at(2.).unwrap();
    for target in [0.13, 0.27, 1., 2.] {
        assert_eq!(
            ida.advance(target, &mut y, &mut yp).unwrap(),
            Advance::Reached(target)
        );
        assert!((y[0] - (-target).exp()).abs() < 2e-8);
        assert!((y[1] - 2. * y[0]).abs() < 1e-8);
    }
    let stats = ida.stats().unwrap();
    assert!(stats.steps > 0 && stats.jacobians > 0);
    assert_eq!(stats.internal_time, 2.);
    assert!(
        ida.advance(3., &mut [0.; 1], &mut yp)
            .unwrap_err()
            .contains("dimension")
    );
}
#[test]
fn callback_panics_and_fatal_errors_never_become_successful_generations() {
    for (panic, fatal) in [(true, false), (false, true)] {
        let mut y = [1., 2.];
        let mut yp = [-1., -2.];
        let mut ida = new(Decay { panic, fatal }, &y, &yp);
        let error = ida.advance(0.1, &mut y, &mut yp).unwrap_err();
        assert!(
            error.contains(if panic {
                "panic caught"
            } else {
                "ownership failure"
            }),
            "{error}"
        );
        assert_eq!(y, [1., 2.]);
        assert!(
            ida.stats().is_ok(),
            "failure diagnostics must remain readable"
        );
        assert!(
            ida.advance(0.2, &mut y, &mut yp)
                .unwrap_err()
                .contains("fail-stopped")
        );
    }
}

#[test]
fn current_snapshot_reads_internal_endpoint_without_changing_interpolant_or_history() {
    let mut y = [1., 2.];
    let mut yp = [-1., -2.];
    let mut ida = new(
        Decay {
            panic: false,
            fatal: false,
        },
        &y,
        &yp,
    );
    ida.initialize(0.1, &mut y, &mut yp).unwrap();
    let requested = ida
        .advance(0.137, &mut y, &mut yp)
        .and_then(Advance::reached)
        .unwrap();
    let output = (y, yp);
    let before = ida.stats().unwrap();
    assert!(
        before.internal_time > requested,
        "test must exercise a genuine interpolated output"
    );
    let mut internal_y = [0.; 2];
    let mut internal_yp = [0.; 2];
    let time = ida
        .current_state(&mut internal_y, &mut internal_yp)
        .unwrap();
    let mut errors = [0.; 2];
    let mut weights = [0.; 2];
    let order = ida.error_diagnostics(&mut errors, &mut weights).unwrap();
    assert!((1..=5).contains(&order));
    assert!(errors.iter().all(|v| v.is_finite()));
    assert!(weights.iter().all(|v| v.is_finite() && *v > 0.));
    let first = (errors, weights);
    assert_eq!(
        ida.error_diagnostics(&mut errors, &mut weights).unwrap(),
        order
    );
    assert_eq!((errors, weights), first);
    assert!(ida.error_diagnostics(&mut [0.; 1], &mut weights).is_err());
    assert_eq!(time, before.internal_time);
    // This later tn accumulates ~2.7e-8 global error under unchanged 1e-8
    // local error control. Snapshot semantics are checked independently below
    // against stock's ordinary output at exactly this internal endpoint.
    assert!((internal_y[0] - (-time).exp()).abs() < 4e-8);
    assert!((internal_y[1] - 2. * internal_y[0]).abs() < 1e-8);
    assert!((internal_yp[0] + internal_y[0]).abs() < 2e-7);
    assert_ne!(internal_y[0], output.0[0]);
    assert_eq!((y, yp), output);
    let after = ida.stats().unwrap();
    assert_eq!(after.steps, before.steps);
    assert_eq!(after.residuals, before.residuals);
    assert_eq!(after.jacobians, before.jacobians);
    assert_eq!(after.internal_time, before.internal_time);
    assert!(ida.current_state(&mut [0.; 1], &mut internal_yp).is_err());
    ida.advance(time, &mut y, &mut yp).unwrap();
    for j in 0..2 {
        assert!((internal_y[j] - y[j]).abs() <= 8. * f64::EPSILON * y[j].abs());
        assert!((internal_yp[j] - yp[j]).abs() <= 8. * f64::EPSILON * yp[j].abs());
    }
    assert_eq!(ida.stats().unwrap().steps, before.steps);
    ida.advance(0.27, &mut y, &mut yp).unwrap();
    // Identical control trajectory without the snapshot: local error control
    // is not a guarantee of a guessed absolute global error at every tn.
    let mut control_y = [1., 2.];
    let mut control_yp = [-1., -2.];
    let mut control = new(
        Decay {
            panic: false,
            fatal: false,
        },
        &control_y,
        &control_yp,
    );
    control
        .initialize(0.1, &mut control_y, &mut control_yp)
        .unwrap();
    for target in [0.137, time, 0.27] {
        control
            .advance(target, &mut control_y, &mut control_yp)
            .unwrap();
    }
    assert_eq!(y, control_y);
    assert_eq!(yp, control_yp);
    let actual = ida.stats().unwrap();
    let expected = control.stats().unwrap();
    assert_eq!(actual.steps, expected.steps);
    assert_eq!(actual.residuals, expected.residuals);
    assert_eq!(actual.jacobians, expected.jacobians);
    assert_eq!(actual.internal_time, expected.internal_time);
}

#[test]
fn stock_constraints_reject_negative_inventory_without_rewriting_it() {
    let mut y = [-1., -2.];
    let mut yp = [1., 2.];
    let mut ida = new(
        Decay {
            panic: false,
            fatal: false,
        },
        &y,
        &yp,
    );
    ida.constrain_nonnegative(&[0]).unwrap();
    assert!(ida.initialize(0.1, &mut y, &mut yp).is_err());
    assert_eq!(y, [-1., -2.]);
    assert_eq!(yp, [1., 2.]);
    assert!(
        ida.advance(0.1, &mut y, &mut yp)
            .unwrap_err()
            .contains("fail-stopped")
    );

    // No implicit positivity rule: clearing the explicit stock constraint
    // restores the mathematical signed test problem, not an inventory floor.
    let mut ida = new(
        Decay {
            panic: false,
            fatal: false,
        },
        &y,
        &yp,
    );
    ida.constrain_nonnegative(&[0]).unwrap();
    ida.constrain_nonnegative(&[]).unwrap();
    ida.initialize(0.1, &mut y, &mut yp).unwrap();
    assert_eq!(y[0], -1.);
}

#[test]
fn stock_options_admit_valid_values_and_refuse_invalid_ones_before_a_segment() {
    let mut y = [1., 2.];
    let mut yp = [-1., -2.];
    let mut ida = new(decay(), &y, &yp);
    for order in 1..=5 {
        ida.set_max_order(order).unwrap();
    }
    // Stock IDA owns the order range: nonpositive or above its allocated 5.
    for order in [0, 6] {
        let error = ida.set_max_order(order).unwrap_err();
        assert!(error.contains("stock IDA status -22"), "{error}");
    }
    assert!(
        ida.set_max_order(usize::MAX)
            .unwrap_err()
            .contains("exceeds C int")
    );
    for step in [1e-6, 0.5, f64::INFINITY] {
        ida.set_max_step(step).unwrap();
    }
    // Stock reads 0 as unbounded and admits NaN: neither is a bound.
    for step in [0., -0., -1., f64::NAN, f64::NEG_INFINITY] {
        assert!(
            ida.set_max_step(step)
                .unwrap_err()
                .contains("must be positive")
        );
    }
    for coefficient in [1e-3, 1., 0.33] {
        ida.set_nonlinear_convergence_coefficient(coefficient)
            .unwrap();
    }
    for coefficient in [0., -0.1, f64::NAN, f64::INFINITY] {
        let error = ida
            .set_nonlinear_convergence_coefficient(coefficient)
            .unwrap_err();
        assert!(error.contains("finite and positive"), "{error}");
    }
    ida.set_linear_solution_scaling(false).unwrap();
    ida.set_linear_solution_scaling(true).unwrap();
    ida.initialize(0.1, &mut y, &mut yp).unwrap();
    assert_eq!(
        ida.advance(0.5, &mut y, &mut yp).unwrap(),
        Advance::Reached(0.5)
    );
    // A started segment refuses every option and consistent initialization;
    // the refusals leave the handle usable.
    let refusals = [
        ida.set_max_order(3).unwrap_err(),
        ida.set_max_step(1.).unwrap_err(),
        ida.set_linear_solution_scaling(true).unwrap_err(),
        ida.set_nonlinear_convergence_coefficient(0.1).unwrap_err(),
        ida.initialize(0.6, &mut y, &mut yp).unwrap_err(),
    ];
    for error in refusals {
        assert!(error.contains("construction or reinitializ"), "{error}");
    }
    assert_eq!(
        ida.advance(1., &mut y, &mut yp).unwrap(),
        Advance::Reached(1.)
    );
    assert!((y[0] - (-1_f64).exp()).abs() < 2e-8);
    ida.reinitialize(1., &y.clone(), &yp.clone()).unwrap();
    ida.set_max_order(2).unwrap();
    ida.set_max_step(0.1).unwrap();
}

/// Peak observed order and step over 400 outputs of the decay on [0, 10].
fn capped_trajectory(order: Option<usize>, step: Option<f64>) -> (i32, f64, i64) {
    let mut y = [1., 2.];
    let mut yp = [-1., -2.];
    let mut ida = start(decay(), &y, &yp, 1e-10, 1e-12);
    if let Some(order) = order {
        ida.set_max_order(order).unwrap();
    }
    if let Some(step) = step {
        ida.set_max_step(step).unwrap();
    }
    ida.initialize(0.01, &mut y, &mut yp).unwrap();
    let (mut highest, mut longest, mut worst) = (0, 0_f64, 0_f64);
    for i in 1..=400 {
        let t = 0.025 * f64::from(i);
        assert_eq!(
            ida.advance(t, &mut y, &mut yp).unwrap(),
            Advance::Reached(t)
        );
        let stats = ida.stats().unwrap();
        highest = highest.max(stats.last_order).max(stats.current_order);
        longest = longest.max(stats.last_step).max(stats.current_step);
        worst = worst.max((y[0] - (-t).exp()).abs());
    }
    // Measured 2.2e-8 at order 2 and below 3e-10 otherwise (rtol 1e-10):
    // local error control, not a global-error guarantee.
    assert!(
        worst < 5e-8,
        "order {order:?} step {step:?}: worst error {worst:e}"
    );
    let stats = ida.stats().unwrap();
    assert!(stats.linear_setups > 0 && stats.linear_setups <= stats.nonlinear_iterations);
    assert_eq!(stats.root_evaluations, 0);
    (highest, longest, stats.steps)
}

#[test]
fn maximum_order_and_step_caps_are_observed_in_stock_statistics() {
    let (free_order, free_step, free_steps) = capped_trajectory(None, None);
    assert!(
        free_order > 2,
        "smooth decay must exceed the cap; reached {free_order}"
    );
    let (order, _, steps) = capped_trajectory(Some(2), None);
    assert_eq!(order, 2, "stock never exceeds the requested maximum order");
    assert!(
        steps > free_steps,
        "order 2 needs more steps ({steps} vs {free_steps})"
    );
    let (_, step, steps) = capped_trajectory(None, Some(0.01));
    assert!(
        free_step > 0.01,
        "unbounded steps grow beyond the cap ({free_step})"
    );
    assert!(
        step <= 0.01 * (1. + 1e-12),
        "stock step {step} exceeds the bound"
    );
    assert!(steps >= 1000);
}

#[test]
fn removing_the_step_bound_continues_the_active_history_unbounded() {
    let mut y = [1., 2.];
    let mut yp = [-1., -2.];
    // Tolerances whose natural BDF2 step exceeds the 10 ms cap.
    let mut ida = start(decay(), &y, &yp, 1e-5, 1e-7);
    ida.set_max_order(2).unwrap();
    ida.set_max_step(0.01).unwrap();
    ida.stop_at(1.).unwrap();
    let mut capped = 0_f64;
    for i in 1..=10 {
        let t = f64::from(i) / 10.;
        assert_eq!(
            ida.advance(t, &mut y, &mut yp).unwrap(),
            Advance::Reached(t)
        );
        let stats = ida.stats().unwrap();
        capped = capped.max(stats.last_step).max(stats.current_step);
    }
    assert!(capped <= 0.01 * (1. + 1e-12), "capped step {capped}");
    let window = ida.stats().unwrap();
    assert!(window.steps >= 100, "{} steps under the cap", window.steps);
    // Setting or lowering a bound mid-segment stays refused; removing it is
    // admitted and leaves the handle usable.
    let error = ida.set_max_step(0.5).unwrap_err();
    assert!(error.contains("construction or reinitializ"), "{error}");
    ida.remove_max_step().unwrap();
    ida.stop_at(10.).unwrap();
    let mut longest = 0_f64;
    for i in 11..=100 {
        let t = f64::from(i) / 10.;
        assert_eq!(
            ida.advance(t, &mut y, &mut yp).unwrap(),
            Advance::Reached(t)
        );
        longest = longest.max(ida.stats().unwrap().last_step);
    }
    let after = ida.stats().unwrap();
    // The same history continues: counters are not restarted, steps grow
    // past the lifted cap, and the 9 s need far fewer than the 900 capped.
    assert!(longest > 0.01, "longest step after removal {longest}");
    assert!(after.steps > window.steps);
    assert!(
        after.steps - window.steps < 900,
        "{}",
        after.steps - window.steps
    );
    assert!((y[0] - (-10_f64).exp()).abs() < 1e-6, "{}", y[0]);
}

/// Decay with three root functions: a falling state crossing y0 = 0.5, a
/// rising time crossing t = 0.3 and an algebraic function that never crosses.
struct Crossings(Decay);
impl System for Crossings {
    fn dimension(&self) -> usize {
        self.0.dimension()
    }
    fn nonzeros(&self) -> usize {
        self.0.nonzeros()
    }
    fn root_count(&self) -> usize {
        3
    }
    fn roots(&mut self, t: f64, y: &[f64], _: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        out.copy_from_slice(&[y[0] - 0.5, t - 0.3, y[1] + 1.]);
        Ok(())
    }
    fn residual(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        self.0.residual(t, y, yp, out)
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
        self.0.jacobian(t, cj, y, yp, data, rows, pointers)
    }
}

#[test]
fn roots_stop_at_known_crossings_and_reinitialization_follows_the_analytic_bounce() {
    let mut y = [1., 0.];
    let mut yp = [0.; 2];
    let mut ida = start(Crossings(decay()), &y, &yp, 1e-10, 1e-12);
    ida.initialize(0.01, &mut y, &mut yp).unwrap();
    let Advance::Root { time, directions } = ida.advance(2., &mut y, &mut yp).unwrap() else {
        panic!("time crossing expected first");
    };
    assert!((time - 0.3).abs() < 1e-9, "{time}");
    assert_eq!(directions, [0, 1, 0]);
    assert!((y[0] - (-time).exp()).abs() < 1e-9);
    let Advance::Root { time, directions } = ida.advance(2., &mut y, &mut yp).unwrap() else {
        panic!("state crossing expected");
    };
    assert!((time - LN_2).abs() < 1e-8, "{time}");
    assert_eq!(directions, [-1, 0, 0]);
    assert!((y[0] - 0.5).abs() < 1e-9 && (y[1] - 1.).abs() < 1e-9);
    assert!(ida.stats().unwrap().root_evaluations > 0);
    // Discrete event: the inventory jumps back to 1 at the root; y1 and the
    // derivative guesses are deliberately stale, so IDACalcIC must repair them.
    let mut event = time;
    for expected_root in [Some(2. * LN_2), None] {
        let restart = [1., y[1]];
        ida.reinitialize(event, &restart, &[0., 0.]).unwrap();
        assert_eq!(ida.stats().unwrap().steps, 0, "stock counters restart");
        y = restart;
        yp = [0.; 2];
        ida.initialize(event + 0.01, &mut y, &mut yp).unwrap();
        assert_eq!(y[0], 1.);
        assert!((y[1] - 2.).abs() < 1e-10 && (yp[0] + 1.).abs() < 1e-10);
        match (ida.advance(2., &mut y, &mut yp).unwrap(), expected_root) {
            (Advance::Root { time, directions }, Some(root)) => {
                assert!((time - root).abs() < 1e-8, "{time} vs {root}");
                assert_eq!(directions, [-1, 0, 0]);
                event = time;
            }
            (Advance::Reached(time), None) => {
                assert_eq!(time, 2.);
                let analytic = (-(2. - 2. * LN_2)).exp();
                assert!((y[0] - analytic).abs() < 1e-8, "{} vs {analytic}", y[0]);
                assert!((y[1] - 2. * y[0]).abs() < 1e-10);
            }
            (outcome, expected) => panic!("{outcome:?} when expecting root {expected:?}"),
        }
    }
}

#[test]
fn reinitialization_after_an_imposed_discontinuity_retains_options_and_constraints() {
    let mut y = [1., 2.];
    let mut yp = [-1., -2.];
    let mut ida = new(decay(), &y, &yp);
    ida.set_max_order(3).unwrap();
    ida.constrain_nonnegative(&[0]).unwrap();
    ida.initialize(0.1, &mut y, &mut yp).unwrap();
    ida.stop_at(1.).unwrap();
    assert_eq!(
        ida.advance(1., &mut y, &mut yp).unwrap(),
        Advance::Reached(1.)
    );
    assert!(ida.stats().unwrap().steps > 0);
    let jump = [3., y[1]];
    ida.reinitialize(1., &jump, &yp).unwrap();
    let restarted = ida.stats().unwrap();
    assert_eq!((restarted.steps, restarted.internal_time), (0, 1.));
    y = jump;
    ida.initialize(1.1, &mut y, &mut yp).unwrap();
    assert_eq!(y[0], 3.);
    assert!((y[1] - 6.).abs() < 1e-9 && (yp[0] + 3.).abs() < 1e-8);
    for t in [1.25, 1.5, 2., 3.] {
        assert_eq!(
            ida.advance(t, &mut y, &mut yp).unwrap(),
            Advance::Reached(t)
        );
        // Measured at most 1.09e-7 after the restart under rtol 1e-8.
        assert!((y[0] - 3. * (1. - t).exp()).abs() < 3e-7, "t={t}: {}", y[0]);
        assert!((y[1] - 2. * y[0]).abs() < 1e-8);
        assert!(
            ida.stats().unwrap().last_order <= 3,
            "maximum order is retained"
        );
    }
    assert!(
        ida.reinitialize(f64::NAN, &y, &yp)
            .unwrap_err()
            .contains("finite")
    );
    assert!(
        ida.reinitialize(3., &[1.], &yp)
            .unwrap_err()
            .contains("dimension")
    );
    assert!(ida.reinitialize(3., &[f64::INFINITY, 0.], &yp).is_err());
    assert_eq!(
        ida.advance(3.5, &mut y, &mut yp).unwrap(),
        Advance::Reached(3.5)
    );
    // The retained stock constraint refuses a negative restarted inventory.
    ida.reinitialize(3.5, &[-1., -2.], &[1., 2.]).unwrap();
    let (mut y, mut yp) = ([-1., -2.], [1., 2.]);
    assert!(ida.initialize(3.6, &mut y, &mut yp).is_err());
    assert_eq!(y, [-1., -2.]);
    assert!(
        ida.reinitialize(3.5, &[1., 2.], &[-1., -2.])
            .unwrap_err()
            .contains("fail-stopped")
    );
}

/// Root-function failure modes: recoverable, non-finite, panic and fatal.
struct BrokenRoots(u8);
impl System for BrokenRoots {
    fn dimension(&self) -> usize {
        2
    }
    fn nonzeros(&self) -> usize {
        3
    }
    fn root_count(&self) -> usize {
        1
    }
    fn roots(&mut self, _: f64, _: &[f64], _: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        match self.0 {
            0 => Err(Failure::Recoverable("unavailable root trial".into())),
            1 => {
                out[0] = f64::NAN;
                Ok(())
            }
            2 => panic!("deliberate root panic"),
            _ => Err(Failure::Fatal("deliberate root ownership failure".into())),
        }
    }
    fn residual(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        decay().residual(t, y, yp, out)
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
        decay().jacobian(t, cj, y, yp, data, rows, pointers)
    }
}

#[test]
fn root_function_failures_are_fatal_rather_than_retried() {
    let expected = [
        "cannot be retried",
        "root function 0 is not finite",
        "panic caught at IDA root boundary",
        "deliberate root ownership failure",
    ];
    for (mode, reason) in expected.into_iter().enumerate() {
        let mut y = [1., 2.];
        let mut yp = [-1., -2.];
        let mut ida = start(BrokenRoots(mode as u8), &y, &yp, 1e-8, 1e-10);
        let error = ida.advance(0.5, &mut y, &mut yp).unwrap_err();
        assert!(error.contains(reason), "{error}");
        assert_eq!(y, [1., 2.]);
        assert!(ida.stats().is_ok());
        assert!(
            ida.advance(0.6, &mut y, &mut yp)
                .unwrap_err()
                .contains("fail-stopped")
        );
    }
}

/// Rotor speed w (differential until it seizes), angle q' = w and algebraic
/// power P = 3w. Seizure replaces the row w' + w = 0 by the constraint w = 0;
/// the CSC structure is the same in both modes.
struct Rotor {
    seized: bool,
}
impl System for Rotor {
    fn dimension(&self) -> usize {
        3
    }
    fn nonzeros(&self) -> usize {
        5
    }
    fn root_count(&self) -> usize {
        0
    }
    fn roots(&mut self, _: f64, _: &[f64], _: &[f64], _: &mut [f64]) -> Result<(), Failure> {
        Ok(())
    }
    fn residual(&mut self, _: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        out[0] = if self.seized { y[0] } else { yp[0] + y[0] };
        out[1] = yp[1] - y[0];
        out[2] = y[2] - 3. * y[0];
        Ok(())
    }
    fn jacobian(
        &mut self,
        _: f64,
        cj: f64,
        _: &[f64],
        _: &[f64],
        data: &mut [f64],
        rows: &mut [i64],
        pointers: &mut [i64],
    ) -> Result<(), Failure> {
        let speed = if self.seized { 1. } else { cj + 1. };
        data.copy_from_slice(&[speed, -1., -3., cj, 1.]);
        rows.copy_from_slice(&[0, 1, 2, 1, 2]);
        pointers.copy_from_slice(&[0, 3, 4, 5]);
        Ok(())
    }
}
fn rotor(seized: bool, time: f64, y: &[f64], yp: &[f64]) -> Ida<Rotor> {
    Ida::new(
        Rotor { seized },
        Initial {
            time,
            y,
            yp,
            differential: &[1., 1., 0.],
            absolute_tolerance: &[1e-12; 3],
            relative_tolerance: 1e-10,
        },
    )
    .unwrap()
}

#[test]
fn a_seized_coordinate_becomes_algebraic_at_reinitialization() {
    let mut y = [1., 0., 3.];
    let mut yp = [-1., 1., 0.];
    let mut ida = rotor(false, 0., &y, &yp);
    ida.initialize(0.01, &mut y, &mut yp).unwrap();
    assert_eq!(
        ida.advance(0.5, &mut y, &mut yp).unwrap(),
        Advance::Reached(0.5)
    );
    let speed = (-0.5_f64).exp();
    assert!((y[0] - speed).abs() < 1e-9 && (y[1] - (1. - speed)).abs() < 1e-9);
    assert!((y[2] - 3. * y[0]).abs() < 1e-10);
    let angle = y[1];
    // Control: the seized equation with unchanged identity is unsatisfiable,
    // because IDACalcIC holds differential values and w' no longer appears.
    let (mut held_y, mut held_yp) = (y, yp);
    let mut control = rotor(true, 0.5, &held_y, &held_yp);
    assert!(control.initialize(0.51, &mut held_y, &mut held_yp).is_err());
    // The event: the rotor seizes at 0.5 s; speed becomes an algebraic row.
    ida.system_mut().seized = true;
    ida.reinitialize(0.5, &y, &yp).unwrap();
    for refused in [&[0., 1.][..], &[0., 1., 0.5], &[0., 1., f64::NAN]] {
        assert!(ida.set_differential(refused).unwrap_err().contains("0/1"));
    }
    ida.set_differential(&[0., 1., 0.]).unwrap();
    ida.initialize(0.51, &mut y, &mut yp).unwrap();
    assert_eq!(y[1], angle, "differential angle is held by IDACalcIC");
    assert!(y[0].abs() < 1e-14 && y[2].abs() < 1e-14 && yp[1].abs() < 1e-14);
    for t in [0.75, 1., 2.] {
        assert_eq!(
            ida.advance(t, &mut y, &mut yp).unwrap(),
            Advance::Reached(t)
        );
        assert!(y[0].abs() < 1e-12 && y[2].abs() < 1e-12, "t={t}: {y:?}");
        assert!(
            (y[1] - angle).abs() < 1e-12,
            "seized angle stays at {angle}: {}",
            y[1]
        );
    }
    let error = ida.set_differential(&[1., 1., 0.]).unwrap_err();
    assert!(error.contains("construction or reinitializ"), "{error}");
}

#[test]
fn an_explicit_first_step_is_admitted_before_a_segment_and_refused_after() {
    let mut y = [1., 2.];
    let mut yp = [-1., 0.];
    let mut ida = new(decay(), &y, &yp);
    assert!(ida.set_init_step(0.).is_err());
    assert!(ida.set_init_step(f64::NAN).is_err());
    ida.set_init_step(1e-4).unwrap();
    ida.advance(1., &mut y, &mut yp).unwrap().reached().unwrap();
    assert!((y[0] - (-1f64).exp()).abs() < 1e-6);
    assert!(ida.set_init_step(1e-4).is_err());
}

/// IDAS quadratures excluded from the error test: `q' = y0` integrates the
/// decay exactly, and the state trajectory equals the one without them.
#[cfg(feature = "quadratures")]
struct Ledgered(Decay);
#[cfg(feature = "quadratures")]
impl System for Ledgered {
    fn dimension(&self) -> usize {
        self.0.dimension()
    }
    fn nonzeros(&self) -> usize {
        self.0.nonzeros()
    }
    fn root_count(&self) -> usize {
        0
    }
    fn roots(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        self.0.roots(t, y, yp, out)
    }
    fn residual(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        self.0.residual(t, y, yp, out)
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
        self.0.jacobian(t, cj, y, yp, data, rows, pointers)
    }
    fn quadrature_count(&self) -> usize {
        1
    }
    fn quadrature(&mut self, _: f64, y: &[f64], _: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        out[0] = y[0];
        Ok(())
    }
}
#[cfg(feature = "quadratures")]
#[test]
fn idas_quadratures_follow_the_steps_and_leave_the_trajectory_unchanged() {
    let (y0, yp0) = ([1., 2.], [-1., 0.]);
    let (mut y, mut yp) = (y0, yp0);
    let mut plain = new(decay(), &y, &yp);
    plain
        .advance(2., &mut y, &mut yp)
        .unwrap()
        .reached()
        .unwrap();
    let (mut z, mut zp) = (y0, yp0);
    let mut ledgered = Ida::new(
        Ledgered(decay()),
        Initial {
            time: 0.,
            y: &z,
            yp: &zp,
            differential: &[1., 0.],
            absolute_tolerance: &[1e-10; 2],
            relative_tolerance: 1e-8,
        },
    )
    .unwrap();
    assert!(leitbild_operating_water::ida::quadratures_linked());
    assert!(ledgered.initialize_quadratures(&[0., 0.]).is_err());
    ledgered.initialize_quadratures(&[0.5]).unwrap();
    assert!(ledgered.initialize_quadratures(&[0.5]).is_err());
    ledgered
        .advance(2., &mut z, &mut zp)
        .unwrap()
        .reached()
        .unwrap();
    assert_eq!(y.map(f64::to_bits), z.map(f64::to_bits));
    let mut q = [0.];
    assert_eq!(ledgered.quadratures(&mut q).unwrap(), 2.);
    // The integrator's own quadrature of its own y0: 1 - y0(2) plus the start.
    assert!((q[0] - (0.5 + 1. - z[0])).abs() < 1e-7);
    assert!(ledgered.quadratures(&mut [0., 0.]).is_err());
    assert!(plain.quadratures(&mut q).is_err());
}

#[cfg(not(feature = "quadratures"))]
#[test]
fn stock_ida_refuses_a_ledger_rather_than_emulating_one() {
    assert!(!leitbild_operating_water::ida::quadratures_linked());
    let (y, yp) = ([1., 2.], [-1., 0.]);
    let mut ida = new(decay(), &y, &yp);
    let error = ida.initialize_quadratures(&[0.]).unwrap_err();
    assert!(error.contains("stock IDA has no quadratures"), "{error}");
    assert!(ida.quadratures(&mut [0.]).is_err());
}
