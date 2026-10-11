//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#6-solver-properties-and-cost-obligations
//! Owned, opt-in boundary to the explicitly linked stock IDA/KLU build.
//! No solver implementation, numerical fallback, or physical model lives here.
use std::{
    ffi::{c_int, c_long, c_void},
    panic::{AssertUnwindSafe, catch_unwind},
    ptr::NonNull,
};

#[derive(Debug)]
pub enum Failure {
    /// Constitutive trial unavailable: IDA may retry, never clip the state.
    Recoverable(String),
    /// A model/ownership error cannot be hidden by a later successful callback.
    Fatal(String),
}
pub type Result<T> = std::result::Result<T, String>;
pub trait System {
    fn dimension(&self) -> usize;
    fn nonzeros(&self) -> usize;
    /// Number of root functions g(t,y,yp), read once at construction. A
    /// system without discrete-event roots states 0 explicitly.
    fn root_count(&self) -> usize;
    fn residual(
        &mut self,
        time: f64,
        y: &[f64],
        yp: &[f64],
        out: &mut [f64],
    ) -> std::result::Result<(), Failure>;
    /// Fill the complete CSC structure and values of dF/dy+cj*dF/dyp.
    #[allow(clippy::too_many_arguments)] // Mirrors IDALsJacFn without another adapter object.
    fn jacobian(
        &mut self,
        time: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        data: &mut [f64],
        rows: &mut [i64],
        pointers: &mut [i64],
    ) -> std::result::Result<(), Failure>;
    /// Fill all `root_count` finite root-function values. Stock IDA cannot
    /// retry a root evaluation, so every failure here is fatal to the handle.
    fn roots(
        &mut self,
        time: f64,
        y: &[f64],
        yp: &[f64],
        out: &mut [f64],
    ) -> std::result::Result<(), Failure>;
}
/// Successful `advance` outcome; the output buffers hold the state at `time`.
#[derive(Clone, Debug, PartialEq)]
pub enum Advance {
    /// IDA_SUCCESS at the requested target or IDA_TSTOP_RETURN at the armed
    /// stop boundary; the returned time distinguishes them.
    Reached(f64),
    /// IDA_ROOT_RETURN at a located root. `directions` is IDAGetRootInfo per
    /// root function: +1 rising, -1 falling through zero, 0 no root found.
    Root { time: f64, directions: Vec<i32> },
}
impl Advance {
    /// Time reached by a system that declares no roots; a root is an error.
    pub fn reached(self) -> Result<f64> {
        match self {
            Self::Reached(time) => Ok(time),
            Self::Root { time, directions } => Err(format!(
                "unexpected stock IDA root return at {time} s: {directions:?}"
            )),
        }
    }
}
pub struct Initial<'a> {
    pub time: f64,
    pub y: &'a [f64],
    pub yp: &'a [f64],
    pub differential: &'a [f64],
    pub absolute_tolerance: &'a [f64],
    pub relative_tolerance: f64,
}
/// Stock counters. `reinitialize` (IDAReInit) restarts the integrator
/// counts; the Jacobian count restarts at the next stock setup.
#[derive(Debug)]
pub struct Stats {
    pub steps: i64,
    pub residuals: i64,
    pub jacobians: i64,
    pub nonlinear_iterations: i64,
    pub error_failures: i64,
    pub convergence_failures: i64,
    /// IDAGetNumLinSolvSetups: iteration-matrix setups (KLU factorizations).
    pub linear_setups: i64,
    /// IDAGetNumGEvals: root-function evaluations.
    pub root_evaluations: i64,
    /// IDAGetLastOrder: BDF order of the last accepted step (0 before any).
    pub last_order: i32,
    /// IDAGetCurrentOrder: order stock will attempt next.
    pub current_order: i32,
    pub last_step: f64,
    /// IDAGetCurrentStep: step stock will attempt next.
    pub current_step: f64,
    pub internal_time: f64,
}
type Residual = unsafe extern "C" fn(*mut c_void, f64, *const f64, *const f64, *mut f64) -> c_int;
type Jacobian = unsafe extern "C" fn(
    *mut c_void,
    f64,
    f64,
    *const f64,
    *const f64,
    *mut f64,
    *mut i64,
    *mut i64,
) -> c_int;
type Roots = unsafe extern "C" fn(*mut c_void, f64, *const f64, *const f64, *mut f64) -> c_int;
const IDA_SUCCESS: c_int = 0;
const IDA_TSTOP_RETURN: c_int = 1;
const IDA_ROOT_RETURN: c_int = 2;
unsafe extern "C" {
    fn operating_ida_create(
        n: i64,
        nnz: i64,
        t: f64,
        rtol: f64,
        atol: *const f64,
        ids: *const f64,
        y: *const f64,
        yp: *const f64,
        f: Residual,
        j: Jacobian,
        nroots: c_int,
        g: Roots,
        user: *mut c_void,
        status: *mut c_int,
    ) -> *mut c_void;
    fn operating_ida_free(ida: *mut c_void);
    fn operating_ida_initialize(ida: *mut c_void, horizon: f64, y: *mut f64, yp: *mut f64)
    -> c_int;
    fn operating_ida_advance(
        ida: *mut c_void,
        target: f64,
        time: *mut f64,
        y: *mut f64,
        yp: *mut f64,
    ) -> c_int;
    fn operating_ida_stats(
        ida: *mut c_void,
        counts: *mut c_long,
        orders: *mut c_int,
        steps: *mut f64,
    ) -> c_int;
    fn operating_ida_max_order(ida: *mut c_void, order: c_int) -> c_int;
    fn operating_ida_max_step(ida: *mut c_void, step: f64) -> c_int;
    fn operating_ida_solution_scaling(ida: *mut c_void, enabled: c_int) -> c_int;
    fn operating_ida_newton_coefficient(ida: *mut c_void, coefficient: f64) -> c_int;
    fn operating_ida_reinitialize(ida: *mut c_void, t: f64, y: *const f64, yp: *const f64)
    -> c_int;
    fn operating_ida_root_directions(ida: *mut c_void, directions: *mut c_int) -> c_int;
    fn operating_ida_differential(ida: *mut c_void, ids: *const f64) -> c_int;
    fn operating_ida_stop_at(ida: *mut c_void, target: f64) -> c_int;
    fn operating_ida_nonnegative(ida: *mut c_void, flags: *const f64) -> c_int;
    fn operating_ida_current_time(ida: *mut c_void, time: *mut f64) -> c_int;
    fn operating_ida_current_state(
        ida: *mut c_void,
        time: *mut f64,
        y: *mut f64,
        yp: *mut f64,
    ) -> c_int;
    fn operating_ida_error_diagnostics(
        ida: *mut c_void,
        errors: *mut f64,
        weights: *mut f64,
        order: *mut c_int,
    ) -> c_int;
}
struct Context<S> {
    system: S,
    n: usize,
    nnz: usize,
    roots: usize,
    fatal: Option<String>,
    last_trial: Option<String>,
}
impl<S> Context<S> {
    fn status(&mut self, result: std::thread::Result<std::result::Result<(), Failure>>) -> c_int {
        match result {
            Ok(Ok(())) => 0,
            Ok(Err(Failure::Recoverable(reason))) => {
                self.last_trial = Some(reason);
                1
            }
            Ok(Err(Failure::Fatal(reason))) => {
                self.fatal.get_or_insert(reason);
                -1
            }
            Err(_) => {
                self.fatal
                    .get_or_insert("panic caught at IDA callback boundary".into());
                -1
            }
        }
    }
    /// Root evaluations have no stock retry path and must be finite.
    fn root_status(
        &mut self,
        result: std::thread::Result<std::result::Result<(), Failure>>,
        values: &[f64],
    ) -> c_int {
        let reason = match result {
            Ok(Ok(())) => match values.iter().position(|v| !v.is_finite()) {
                None => return 0,
                Some(i) => format!("root function {i} is not finite ({})", values[i]),
            },
            Ok(Err(Failure::Recoverable(reason))) => {
                format!("root function cannot be retried by stock IDA: {reason}")
            }
            Ok(Err(Failure::Fatal(reason))) => reason,
            Err(_) => "panic caught at IDA root boundary".into(),
        };
        self.fatal.get_or_insert(reason);
        -1
    }
}
unsafe extern "C" fn residual<S: System>(
    user: *mut c_void,
    t: f64,
    y: *const f64,
    yp: *const f64,
    out: *mut f64,
) -> c_int {
    // SAFETY: C retains the stable Box until the IDA handle is destroyed.
    let c = unsafe { &mut *user.cast::<Context<S>>() };
    if c.fatal.is_some() {
        return -1;
    }
    let result = catch_unwind(AssertUnwindSafe(|| unsafe {
        c.system.residual(
            t,
            std::slice::from_raw_parts(y, c.n),
            std::slice::from_raw_parts(yp, c.n),
            std::slice::from_raw_parts_mut(out, c.n),
        )
    }));
    c.status(result)
}
unsafe extern "C" fn jacobian<S: System>(
    user: *mut c_void,
    t: f64,
    cj: f64,
    y: *const f64,
    yp: *const f64,
    data: *mut f64,
    rows: *mut i64,
    pointers: *mut i64,
) -> c_int {
    let c = unsafe { &mut *user.cast::<Context<S>>() };
    if c.fatal.is_some() {
        return -1;
    }
    let result = catch_unwind(AssertUnwindSafe(|| unsafe {
        c.system.jacobian(
            t,
            cj,
            std::slice::from_raw_parts(y, c.n),
            std::slice::from_raw_parts(yp, c.n),
            std::slice::from_raw_parts_mut(data, c.nnz),
            std::slice::from_raw_parts_mut(rows, c.nnz),
            std::slice::from_raw_parts_mut(pointers, c.n + 1),
        )
    }));
    c.status(result)
}
unsafe extern "C" fn roots<S: System>(
    user: *mut c_void,
    t: f64,
    y: *const f64,
    yp: *const f64,
    out: *mut f64,
) -> c_int {
    // SAFETY: as for residual; stock passes nrtfn = Context::roots values.
    let c = unsafe { &mut *user.cast::<Context<S>>() };
    if c.fatal.is_some() {
        return -1;
    }
    let out = unsafe { std::slice::from_raw_parts_mut(out, c.roots) };
    let result = catch_unwind(AssertUnwindSafe(|| unsafe {
        c.system.roots(
            t,
            std::slice::from_raw_parts(y, c.n),
            std::slice::from_raw_parts(yp, c.n),
            out,
        )
    }));
    c.root_status(result, out)
}
pub struct Ida<S: System> {
    handle: NonNull<c_void>,
    context: Box<Context<S>>,
    time: f64,
    failed: bool,
    /// Set by the first `advance` after construction or reinitialization.
    started: bool,
}
impl<S: System> Ida<S> {
    pub fn new(system: S, initial: Initial<'_>) -> Result<Self> {
        let n = system.dimension();
        let nnz = system.nonzeros();
        let root_count = system.root_count();
        let nroots = c_int::try_from(root_count)
            .map_err(|_| format!("{root_count} IDA root functions exceed C int"))?;
        if n == 0
            || nnz == 0
            || n > i64::MAX as usize
            || nnz > i64::MAX as usize
            || [
                initial.y,
                initial.yp,
                initial.differential,
                initial.absolute_tolerance,
            ]
            .iter()
            .any(|v| v.len() != n)
            || !initial.time.is_finite()
            || !initial.relative_tolerance.is_finite()
            || initial.relative_tolerance <= 0.
            || initial.y.iter().chain(initial.yp).any(|v| !v.is_finite())
            || initial
                .absolute_tolerance
                .iter()
                .any(|v| !v.is_finite() || *v <= 0.)
            || initial.differential.iter().any(|v| *v != 0. && *v != 1.)
        {
            return Err("invalid IDA dimensions/state/tolerances/differential identity".into());
        }
        let mut context = Box::new(Context {
            system,
            n,
            nnz,
            roots: root_count,
            fatal: None,
            last_trial: None,
        });
        let mut status = 0;
        let handle = unsafe {
            operating_ida_create(
                n as i64,
                nnz as i64,
                initial.time,
                initial.relative_tolerance,
                initial.absolute_tolerance.as_ptr(),
                initial.differential.as_ptr(),
                initial.y.as_ptr(),
                initial.yp.as_ptr(),
                residual::<S>,
                jacobian::<S>,
                nroots,
                roots::<S>,
                (&mut *context as *mut Context<S>).cast(),
                &mut status,
            )
        };
        let handle = NonNull::new(handle)
            .ok_or_else(|| format!("stock IDA construction failed ({status})"))?;
        Ok(Self {
            handle,
            context,
            time: initial.time,
            failed: false,
            started: false,
        })
    }
    fn buffers(&self, y: &[f64], yp: &[f64]) -> Result<()> {
        if y.len() != self.context.n || yp.len() != self.context.n {
            Err("IDA output dimension".into())
        } else {
            Ok(())
        }
    }
    fn check(&self, status: c_int) -> Result<()> {
        if let Some(reason) = &self.context.fatal {
            return Err(format!("fatal IDA callback: {reason}"));
        }
        if status < 0 {
            return Err(format!(
                "stock IDA status {status}; last unavailable trial: {:?}",
                self.context.last_trial
            ));
        }
        Ok(())
    }
    /// Stock IDACalcIC (IDA_YA_YDP_INIT) at a segment start: after
    /// construction or `reinitialize`, before `advance`. Stock history after
    /// a step holds scaled derivatives, not an initial-condition guess.
    pub fn initialize(&mut self, horizon: f64, y: &mut [f64], yp: &mut [f64]) -> Result<()> {
        if self.failed {
            return Err("IDA handle is fail-stopped".into());
        }
        if self.started {
            return Err(
                "IDA consistent initialization requires construction or reinitialize first".into(),
            );
        }
        self.buffers(y, yp)?;
        if !horizon.is_finite() || horizon <= self.time {
            return Err("IDA initialization horizon must be in the future".into());
        }
        let status = unsafe {
            operating_ida_initialize(
                self.handle.as_ptr(),
                horizon,
                y.as_mut_ptr(),
                yp.as_mut_ptr(),
            )
        };
        let result = self.check(status);
        self.failed = result.is_err();
        result
    }
    /// Advance toward `target` with stock IDA_NORMAL. A located root of a
    /// declared root function returns early as `Advance::Root`.
    pub fn advance(&mut self, target: f64, y: &mut [f64], yp: &mut [f64]) -> Result<Advance> {
        if self.failed {
            return Err("IDA handle is fail-stopped".into());
        }
        self.buffers(y, yp)?;
        if !target.is_finite() || target <= self.time {
            return Err("IDA target must be in the future".into());
        }
        self.started = true;
        let status = unsafe {
            operating_ida_advance(
                self.handle.as_ptr(),
                target,
                &mut self.time,
                y.as_mut_ptr(),
                yp.as_mut_ptr(),
            )
        };
        let result = self.check(status).and_then(|()| self.outcome(status));
        self.failed = result.is_err();
        result
    }
    fn outcome(&self, status: c_int) -> Result<Advance> {
        match status {
            IDA_SUCCESS | IDA_TSTOP_RETURN => Ok(Advance::Reached(self.time)),
            IDA_ROOT_RETURN => {
                let mut directions = vec![0 as c_int; self.context.roots];
                let code = unsafe {
                    operating_ida_root_directions(self.handle.as_ptr(), directions.as_mut_ptr())
                };
                self.check(code)?;
                Ok(Advance::Root {
                    time: self.time,
                    directions,
                })
            }
            other => Err(format!("unadmitted stock IDA solve status {other}")),
        }
    }
    /// Restart stock history at `time` from (`y`, `yp`) after a physical
    /// discrete event (IDAReInit). Tolerances, differential identity,
    /// constraints, roots, the KLU linear solver, Jacobian callback, an armed
    /// stop boundary and options are retained; stock counters restart. This
    /// does not make the restarted state consistent: call `initialize` when
    /// algebraic values or derivatives must be recomputed (IDACalcIC).
    pub fn reinitialize(&mut self, time: f64, y: &[f64], yp: &[f64]) -> Result<()> {
        if self.failed {
            return Err("IDA handle is fail-stopped".into());
        }
        self.buffers(y, yp)?;
        if !time.is_finite() || y.iter().chain(yp).any(|v| !v.is_finite()) {
            return Err("IDA reinitialization requires a finite time and state".into());
        }
        let status = unsafe {
            operating_ida_reinitialize(self.handle.as_ptr(), time, y.as_ptr(), yp.as_ptr())
        };
        let result = self.check(status);
        self.failed = result.is_err();
        result?;
        self.time = time;
        self.started = false;
        Ok(())
    }
    /// IDASetId on this instance after a structural discrete event, such as a
    /// seized rotor whose rate row becomes algebraic: 1 marks a differential
    /// and 0 an algebraic coordinate. Allowed only at a segment start (after
    /// construction or `reinitialize`, before `advance`); follow it with
    /// `initialize` so IDACalcIC recomputes the new algebraic values and the
    /// differential derivatives. Changing the residual equations themselves
    /// through `system_mut` belongs at the same reinitialization.
    pub fn set_differential(&mut self, ids: &[f64]) -> Result<()> {
        self.configurable("differential identity")?;
        if ids.len() != self.context.n || ids.iter().any(|v| *v != 0. && *v != 1.) {
            return Err("IDA differential identity needs one 0/1 value per coordinate".into());
        }
        let code = unsafe { operating_ida_differential(self.handle.as_ptr(), ids.as_ptr()) };
        self.check(code)
    }
    /// Options configure the next integration segment only. Stock reads the
    /// Newton coefficient at its first step and cannot safely lower an active
    /// BDF order, so every option is refused once `advance` has started; only
    /// `remove_max_step` may lift a step bound mid-segment.
    fn configurable(&self, option: &str) -> Result<()> {
        if self.failed {
            Err("IDA handle is fail-stopped".into())
        } else if self.started {
            Err(format!(
                "IDA {option} may change only after construction or reinitialization, before advance"
            ))
        } else {
            Ok(())
        }
    }
    /// IDASetMaxOrd; stock admits 1 through its allocated maximum order 5.
    pub fn set_max_order(&mut self, order: usize) -> Result<()> {
        self.configurable("maximum order")?;
        let order = c_int::try_from(order)
            .map_err(|_| format!("IDA maximum order {order} exceeds C int"))?;
        let code = unsafe { operating_ida_max_order(self.handle.as_ptr(), order) };
        self.check(code)
    }
    /// IDASetMaxStep: a positive bound on |h|; +inf removes the bound
    /// explicitly. Stock's zero sentinel for "unbounded" and NaN are refused.
    pub fn set_max_step(&mut self, step: f64) -> Result<()> {
        self.configurable("maximum step")?;
        if step.is_nan() || step <= 0. {
            return Err(format!("IDA maximum step {step} must be positive"));
        }
        let code = unsafe { operating_ida_max_step(self.handle.as_ptr(), step) };
        self.check(code)
    }
    /// Remove the IDASetMaxStep bound, also between advances of an active
    /// segment: the end of a capped window continues the same history with no
    /// reinitialization. Stock reads the bound at every step-size selection,
    /// so the removal applies from the next one. Setting or lowering a bound
    /// stays refused once `advance` has started (`set_max_step`), because
    /// stock would not re-limit the step it has already selected.
    pub fn remove_max_step(&mut self) -> Result<()> {
        if self.failed {
            return Err("IDA handle is fail-stopped".into());
        }
        let code = unsafe { operating_ida_max_step(self.handle.as_ptr(), f64::INFINITY) };
        self.check(code)
    }
    /// IDASetLinearSolutionScaling for the matrix-based KLU solver (stock
    /// enables it): rescale linear solutions after a changed cj.
    pub fn set_linear_solution_scaling(&mut self, enabled: bool) -> Result<()> {
        self.configurable("linear solution scaling")?;
        let code =
            unsafe { operating_ida_solution_scaling(self.handle.as_ptr(), c_int::from(enabled)) };
        self.check(code)
    }
    /// IDASetNonlinConvCoef: finite positive Newton convergence coefficient.
    pub fn set_nonlinear_convergence_coefficient(&mut self, coefficient: f64) -> Result<()> {
        self.configurable("nonlinear convergence coefficient")?;
        if !coefficient.is_finite() || coefficient <= 0. {
            return Err(format!(
                "IDA nonlinear convergence coefficient {coefficient} must be finite and positive"
            ));
        }
        let code = unsafe { operating_ida_newton_coefficient(self.handle.as_ptr(), coefficient) };
        self.check(code)
    }
    /// Only actual intervention/event boundaries and the final horizon require
    /// a forced endpoint. Ordinary observation calls use IDA interpolation.
    pub fn stop_at(&mut self, target: f64) -> Result<()> {
        if self.failed || !target.is_finite() || target <= self.time {
            return Err("invalid IDA stop boundary".into());
        }
        let code = unsafe { operating_ida_stop_at(self.handle.as_ptr(), target) };
        self.check(code)
    }
    pub fn system(&self) -> &S {
        &self.context.system
    }
    /// Read the stock solution history at its latest internal accepted endpoint.
    /// Ordinary `advance` buffers may instead hold an earlier requested-time
    /// interpolant. Independent native scratch avoids overwriting either those
    /// buffers or solver history. No step, tolerance or failure status changes.
    pub fn current_state(&self, y: &mut [f64], yp: &mut [f64]) -> Result<f64> {
        self.buffers(y, yp)?;
        let mut time = 0.;
        let status = unsafe {
            operating_ida_current_state(
                self.handle.as_ptr(),
                &mut time,
                y.as_mut_ptr(),
                yp.as_mut_ptr(),
            )
        };
        if status < 0 {
            return Err(format!("stock IDA current-state query failed ({status})"));
        }
        Ok(time)
    }
    /// Copy stock's current local-error estimate and reciprocal error weights.
    /// These are diagnostics of its current history, not errors of the last
    /// requested-time interpolant. Reading them does not change that history,
    /// numerical settings or a failed solve's status. Returns current BDF order.
    pub fn error_diagnostics(&self, errors: &mut [f64], weights: &mut [f64]) -> Result<i32> {
        self.buffers(errors, weights)?;
        let mut order = 0;
        let status = unsafe {
            operating_ida_error_diagnostics(
                self.handle.as_ptr(),
                errors.as_mut_ptr(),
                weights.as_mut_ptr(),
                &mut order,
            )
        };
        if status < 0 {
            return Err(format!(
                "stock IDA error-diagnostic query failed ({status})"
            ));
        }
        Ok(order)
    }
    /// Reuse caller-owned scratch for diagnostics at a successfully returned
    /// solution. This does not expose IDA's state or clear a failed solve.
    /// Changing physical parameters, equations or dimensions requires a new
    /// handle/reinitialization; do not mutate them behind active solver history.
    pub fn system_mut(&mut self) -> &mut S {
        &mut self.context.system
    }
    /// Ask stock IDA to admit only nonnegative values at these physical stock
    /// indices. This does not floor inventories or restrict signed model trials.
    /// Internal energy has an EOS datum and must not be constrained by habit.
    pub fn constrain_nonnegative(&mut self, indices: &[usize]) -> Result<()> {
        if self.failed || indices.iter().any(|i| *i >= self.context.n) {
            return Err("invalid IDA nonnegative stock indices".into());
        }
        let mut flags = vec![0.; self.context.n];
        for i in indices {
            flags[*i] = 1.;
        }
        let code = unsafe {
            operating_ida_nonnegative(
                self.handle.as_ptr(),
                if indices.is_empty() {
                    std::ptr::null()
                } else {
                    flags.as_ptr()
                },
            )
        };
        let result = self.check(code);
        self.failed = result.is_err();
        result
    }
    #[allow(clippy::unnecessary_cast)] // C long varies by host ABI.
    pub fn stats(&self) -> Result<Stats> {
        let mut counts = [0 as c_long; 8];
        let mut orders = [0 as c_int; 2];
        let mut steps = [0.; 2];
        let status = unsafe {
            operating_ida_stats(
                self.handle.as_ptr(),
                counts.as_mut_ptr(),
                orders.as_mut_ptr(),
                steps.as_mut_ptr(),
            )
        };
        // Diagnostic counters remain inspectable after a model fail-stop.
        // Native query success is not solve success and must not clear fatal.
        if status < 0 {
            return Err(format!("stock IDA statistics query failed ({status})"));
        }
        let mut internal_time = 0.;
        let status =
            unsafe { operating_ida_current_time(self.handle.as_ptr(), &mut internal_time) };
        if status < 0 {
            return Err(format!("stock IDA time query failed ({status})"));
        }
        Ok(Stats {
            steps: counts[0] as i64,
            residuals: counts[1] as i64,
            jacobians: counts[2] as i64,
            nonlinear_iterations: counts[3] as i64,
            error_failures: counts[4] as i64,
            convergence_failures: counts[5] as i64,
            linear_setups: counts[6] as i64,
            root_evaluations: counts[7] as i64,
            last_order: orders[0],
            current_order: orders[1],
            last_step: steps[0],
            current_step: steps[1],
            internal_time,
        })
    }
}
impl<S: System> Drop for Ida<S> {
    fn drop(&mut self) {
        unsafe {
            operating_ida_free(self.handle.as_ptr());
        }
    }
}
