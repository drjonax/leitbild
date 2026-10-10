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
}
pub struct Initial<'a> {
    pub time: f64,
    pub y: &'a [f64],
    pub yp: &'a [f64],
    pub differential: &'a [f64],
    pub absolute_tolerance: &'a [f64],
    pub relative_tolerance: f64,
}
#[derive(Debug)]
pub struct Stats {
    pub steps: i64,
    pub residuals: i64,
    pub jacobians: i64,
    pub nonlinear_iterations: i64,
    pub error_failures: i64,
    pub convergence_failures: i64,
    pub last_step: f64,
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
    fn operating_ida_stats(ida: *mut c_void, stats: *mut c_long, last_step: *mut f64) -> c_int;
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
pub struct Ida<S: System> {
    handle: NonNull<c_void>,
    context: Box<Context<S>>,
    time: f64,
    failed: bool,
}
impl<S: System> Ida<S> {
    pub fn new(system: S, initial: Initial<'_>) -> Result<Self> {
        let n = system.dimension();
        let nnz = system.nonzeros();
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
    pub fn initialize(&mut self, horizon: f64, y: &mut [f64], yp: &mut [f64]) -> Result<()> {
        if self.failed {
            return Err("IDA handle is fail-stopped".into());
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
    pub fn advance(&mut self, target: f64, y: &mut [f64], yp: &mut [f64]) -> Result<f64> {
        if self.failed {
            return Err("IDA handle is fail-stopped".into());
        }
        self.buffers(y, yp)?;
        if !target.is_finite() || target <= self.time {
            return Err("IDA target must be in the future".into());
        }
        let status = unsafe {
            operating_ida_advance(
                self.handle.as_ptr(),
                target,
                &mut self.time,
                y.as_mut_ptr(),
                yp.as_mut_ptr(),
            )
        };
        let result = self.check(status);
        self.failed = result.is_err();
        result?;
        Ok(self.time)
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
        let mut counts = [0 as c_long; 6];
        let mut step = 0.;
        let status =
            unsafe { operating_ida_stats(self.handle.as_ptr(), counts.as_mut_ptr(), &mut step) };
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
            last_step: step,
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
