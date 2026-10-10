//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-scale-realization.md#high-performance-mathematics-without-changing-the-physical-question
//! Owned direct sparse LU over the verified stock SuiteSparse KLU 2.3.6.
//!
//! `analyze` orders one fixed square CSC pattern once (KLU's 64-bit `klu_l`
//! interface, the index ABI of stock SUNDIALS INT64). `factor` performs KLU's
//! pivoting numerical factorization; `refactor` reuses that pivot sequence for
//! new values on the same pattern; `solve` overwrites one right-hand side with
//! the solution. KLU's own documented controls apply (`klu_l_defaults`: AMD
//! ordering, BTF, max-row scaling, pivot tolerance 0.001, halt at the first
//! zero pivot). A zero pivot or any other KLU failure returns KLU's status and
//! leaves no factorization, so nothing solves with partial or stale factors.
//! `rcond` is KLU's cheap min/max |U_kk| diagnostic of the scaled factors, not
//! a condition number: refactor does not pivot, so the caller judges whether
//! a small value requires a fresh `factor`. No solver algorithm lives here.
use std::{
    ffi::{c_int, c_void},
    fmt,
    ptr::NonNull,
};

/// `Common->status` codes from the admitted `klu.h`.
pub const KLU_OK: i32 = 0;
pub const KLU_SINGULAR: i32 = 1;
pub const KLU_OUT_OF_MEMORY: i32 = -2;
pub const KLU_INVALID: i32 = -3;
pub const KLU_TOO_LARGE: i32 = -4;
const VERSION_MISMATCH: c_int = -100;

#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    /// Rejected at this boundary before reaching KLU.
    Input(String),
    /// `refactor`, `solve` or `rcond` without a current successful factorization.
    NotFactored,
    /// The loaded KLU library is not the admitted 2.3.6 build.
    Version([i32; 3]),
    /// KLU reported `status` from `operation`. For KLU_SINGULAR,
    /// `singular_column` is the original column of the first zero pivot.
    Klu {
        operation: &'static str,
        status: i32,
        singular_column: Option<usize>,
    },
    /// KLU returned a non-finite solution component at this index.
    NonFiniteSolution(usize),
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Input(reason) => write!(f, "KLU input refused: {reason}"),
            Self::NotFactored => write!(f, "KLU has no current factorization"),
            Self::Version(v) => write!(
                f,
                "loaded KLU {}.{}.{} is not admitted 2.3.6",
                v[0], v[1], v[2]
            ),
            Self::Klu {
                operation,
                status,
                singular_column,
            } => write!(
                f,
                "stock KLU {operation} status {status} (singular column {singular_column:?})"
            ),
            Self::NonFiniteSolution(i) => write!(f, "KLU solution component {i} is not finite"),
        }
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

unsafe extern "C" {
    fn operating_klu_analyze(
        n: i64,
        pointers: *mut i64,
        rows: *mut i64,
        status: *mut c_int,
        loaded: *mut c_int,
    ) -> *mut c_void;
    fn operating_klu_free(klu: *mut c_void);
    fn operating_klu_factor(
        klu: *mut c_void,
        pointers: *mut i64,
        rows: *mut i64,
        values: *mut f64,
        singular: *mut i64,
    ) -> c_int;
    fn operating_klu_refactor(
        klu: *mut c_void,
        pointers: *mut i64,
        rows: *mut i64,
        values: *mut f64,
        singular: *mut i64,
    ) -> c_int;
    fn operating_klu_solve(klu: *mut c_void, n: i64, rhs: *mut f64) -> c_int;
    fn operating_klu_rcond(klu: *mut c_void, rcond: *mut f64) -> c_int;
}

/// Symbolic analysis of one fixed pattern plus at most one numerical factor.
pub struct SparseLu {
    handle: NonNull<c_void>,
    pointers: Vec<i64>,
    rows: Vec<i64>,
    factored: bool,
}

impl SparseLu {
    /// Analyze an `n`-by-`n` CSC pattern: `pointers` has `n + 1` entries from
    /// zero, never decreasing, ending at `rows.len()`; each column's rows
    /// strictly increase within `0..n`. The pattern is copied and fixed.
    pub fn analyze(n: usize, pointers: &[i64], rows: &[i64]) -> Result<Self> {
        check_pattern(n, pointers, rows)?;
        let mut pointers = pointers.to_vec();
        let mut rows = rows.to_vec();
        let mut status = 0;
        let mut loaded = [0 as c_int; 3];
        // SAFETY: validated n/pointer/row arrays are live for the call; KLU
        // reads them, copies what it keeps and retains no caller pointer.
        let handle = unsafe {
            operating_klu_analyze(
                n as i64,
                pointers.as_mut_ptr(),
                rows.as_mut_ptr(),
                &mut status,
                loaded.as_mut_ptr(),
            )
        };
        match NonNull::new(handle) {
            Some(handle) => Ok(Self {
                handle,
                pointers,
                rows,
                factored: false,
            }),
            None if status == VERSION_MISMATCH => Err(Error::Version(loaded)),
            None => Err(Error::Klu {
                operation: "analyze",
                status,
                singular_column: None,
            }),
        }
    }

    pub fn dimension(&self) -> usize {
        self.pointers.len() - 1
    }

    pub fn nonzeros(&self) -> usize {
        self.rows.len()
    }

    pub fn is_factored(&self) -> bool {
        self.factored
    }

    /// Fresh pivoting factorization of CSC `values` on the analyzed pattern.
    pub fn factor(&mut self, values: &[f64]) -> Result<()> {
        self.check_values(values)?;
        self.factored = false;
        let mut singular = -1;
        // SAFETY: the owned pattern and caller values have the analyzed
        // lengths; KLU only reads them (documented inputs) during the call.
        let status = unsafe {
            operating_klu_factor(
                self.handle.as_ptr(),
                self.pointers.as_mut_ptr(),
                self.rows.as_mut_ptr(),
                values.as_ptr().cast_mut(),
                &mut singular,
            )
        };
        self.settle("factor", status, singular)
    }

    /// New values on the factored pattern with the previous pivot sequence.
    /// Failure (for example an exact zero pivot) discards the factorization.
    pub fn refactor(&mut self, values: &[f64]) -> Result<()> {
        self.check_values(values)?;
        if !self.factored {
            return Err(Error::NotFactored);
        }
        self.factored = false;
        let mut singular = -1;
        // SAFETY: as for factor; the Numeric object exists because factored.
        let status = unsafe {
            operating_klu_refactor(
                self.handle.as_ptr(),
                self.pointers.as_mut_ptr(),
                self.rows.as_mut_ptr(),
                values.as_ptr().cast_mut(),
                &mut singular,
            )
        };
        self.settle("refactor", status, singular)
    }

    /// Overwrite finite `rhs` with the solution x of A x = rhs.
    pub fn solve(&mut self, rhs: &mut [f64]) -> Result<()> {
        if !self.factored {
            return Err(Error::NotFactored);
        }
        check_finite("right-hand side", rhs, self.dimension())?;
        // SAFETY: rhs has exactly n entries and is overwritten in place; the
        // factorization is current because `factored` is set only on success.
        let status = unsafe {
            operating_klu_solve(
                self.handle.as_ptr(),
                self.dimension() as i64,
                rhs.as_mut_ptr(),
            )
        };
        if status != KLU_OK {
            return Err(Error::Klu {
                operation: "solve",
                status,
                singular_column: None,
            });
        }
        match rhs.iter().position(|v| !v.is_finite()) {
            Some(i) => Err(Error::NonFiniteSolution(i)),
            None => Ok(()),
        }
    }

    /// KLU's cheap reciprocal pivot-growth diagnostic min/max |U_kk|.
    pub fn rcond(&mut self) -> Result<f64> {
        if !self.factored {
            return Err(Error::NotFactored);
        }
        let mut rcond = f64::NAN;
        // SAFETY: the current Symbolic/Numeric objects are only read.
        let status = unsafe { operating_klu_rcond(self.handle.as_ptr(), &mut rcond) };
        if status == KLU_OK {
            Ok(rcond)
        } else {
            Err(Error::Klu {
                operation: "rcond",
                status,
                singular_column: None,
            })
        }
    }

    fn check_values(&self, values: &[f64]) -> Result<()> {
        check_finite("values", values, self.nonzeros())
    }

    fn settle(&mut self, operation: &'static str, status: c_int, singular: i64) -> Result<()> {
        if status == KLU_OK {
            self.factored = true;
            return Ok(());
        }
        let singular_column = usize::try_from(singular)
            .ok()
            .filter(|&column| status == KLU_SINGULAR && column < self.dimension());
        Err(Error::Klu {
            operation,
            status,
            singular_column,
        })
    }
}

impl Drop for SparseLu {
    fn drop(&mut self) {
        // SAFETY: the handle came from a successful analyze and is freed once.
        unsafe { operating_klu_free(self.handle.as_ptr()) }
    }
}

fn check_pattern(n: usize, pointers: &[i64], rows: &[i64]) -> Result<()> {
    let refuse = |reason: String| Err(Error::Input(reason));
    if n == 0 || i64::try_from(n).is_err() {
        return refuse(format!("dimension {n} must be positive and fit i64"));
    }
    if pointers.len() != n + 1 || pointers[0] != 0 || !pointers.is_sorted() {
        return refuse(format!(
            "{n}+1 column pointers must start at 0 and never decrease"
        ));
    }
    if usize::try_from(pointers[n]).ok() != Some(rows.len()) {
        return refuse(format!(
            "last column pointer {} for {} rows",
            pointers[n],
            rows.len()
        ));
    }
    for (column, span) in pointers.windows(2).enumerate() {
        let entries = &rows[span[0] as usize..span[1] as usize];
        if entries.windows(2).any(|pair| pair[0] >= pair[1])
            || entries.iter().any(|&row| row < 0 || row >= n as i64)
        {
            return refuse(format!(
                "column {column} rows must strictly increase within 0..{n}"
            ));
        }
    }
    Ok(())
}

fn check_finite(name: &str, values: &[f64], expected: usize) -> Result<()> {
    if values.len() != expected {
        return Err(Error::Input(format!(
            "{name} length {}, expected {expected}",
            values.len()
        )));
    }
    match values.iter().position(|v| !v.is_finite()) {
        Some(i) => Err(Error::Input(format!("{name} entry {i} is not finite"))),
        None => Ok(()),
    }
}
