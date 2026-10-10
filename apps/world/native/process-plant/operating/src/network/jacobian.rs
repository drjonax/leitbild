//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#6-solver-properties-and-cost-obligations
//! Stage-Jacobian assembly `dF/dy + cj*dF/dy'` from exact seeded directions,
//! and the exact consistent-rate solve that replaces IDACalcIC.
//!
//! Exact current caloric points are reused only within one assembly. An
//! exact-zero impulse column follows its current force branch: the seed sign
//! is that branch and the output is divided by it (one-sided, disclosed).
use super::{Failure, Network, Properties};
use crate::sparse::{self, Coloring, Pattern};
use serde::Serialize;
use std::time::Instant;

/// A residual `F(t, y, y')` in solver scaling whose consistent rates can be
/// solved exactly: its rows and its dense `dF/dy` and `dF/dy'`, column-major.
/// The network implements it; a standalone cell system can too.
pub trait ConsistentSystem {
    fn system_dimension(&self) -> usize;
    fn rows_at(&mut self, t: f64, y: &[f64], yp: &[f64]) -> Result<Vec<f64>, Failure>;
    fn pencil_at(&mut self, t: f64, y: &[f64], yp: &[f64])
    -> Result<(Vec<f64>, Vec<f64>), Failure>;
}

/// Largest magnitude of one class of rows and the first row carrying it.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Largest {
    pub value: f64,
    pub row: usize,
}
fn largest(values: impl Iterator<Item = (usize, f64)>) -> Largest {
    values.fold(Largest { value: 0., row: 0 }, |best, (row, v)| {
        let v = v.abs();
        if !best.value.is_nan() && (v.is_nan() || v > best.value) {
            Largest { value: v, row }
        } else {
            best
        }
    })
}

/// One exact consistent-rate solve: the algebraic rows `g(y)` before it, and
/// after it every row of `F(t, y, y')` and the constraint rates `dg/dy y'`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ConsistentPair {
    /// The constraint projection that preceded the solve, if any.
    pub projection: Option<Projection>,
    pub constraint: Largest,
    pub residual: Largest,
    pub constraint_rate: Largest,
    pub passes: usize,
    pub bound: f64,
}

/// Exact consistent rates at `y` (decision 0013's exit; it replaces IDACalcIC
/// at t = 0 and at every event). The algebraic rows `g(y)` must already hold
/// to `bound`, which proves the event transaction left `y` consistent. `y'`
/// then solves one linear system: the differential rows are the residual's
/// own rows, `(dF_d/dy') y' = -F_d(y, 0)` over every rate including the
/// algebraic ones, and the algebraic rows are the constraints' time
/// derivative, `(dg/dy) y' = 0`. The constraints (EOS and volume rows) are
/// autonomous, so there is no `dg/dt` term. The rows are linear in `y'`, so
/// one pass is exact; at most `passes` passes are taken as a check. Refuses,
/// Fatal and naming the row, when a bound is missed.
pub fn consistent_rates<S: ConsistentSystem>(
    system: &mut S,
    t: f64,
    y: &[f64],
    differential: &[f64],
    bound: f64,
    passes: usize,
) -> Result<(Vec<f64>, ConsistentPair), Failure> {
    let n = system.system_dimension();
    if y.len() != n || differential.len() != n || !(bound.is_finite() && bound > 0.) || passes == 0
    {
        return Err(Failure::Fatal(
            "consistent-rate layout, bound or passes".into(),
        ));
    }
    let algebraic: Vec<bool> = differential.iter().map(|id| *id == 0.).collect();
    let mut yp = vec![0.; n];
    let rows = system.rows_at(t, y, &yp)?;
    let constraint = largest(
        rows.iter()
            .enumerate()
            .filter(|(i, _)| algebraic[*i])
            .map(|(i, r)| (i, *r)),
    );
    if constraint.value.is_nan() || constraint.value > bound {
        return Err(Failure::Fatal(format!(
            "the state is not consistent before the rate solve: algebraic row {} is {}",
            constraint.row, constraint.value
        )));
    }
    let mut report = None;
    for pass in 1..=passes {
        let (a, b) = system.pencil_at(t, y, &yp)?;
        let rows = system.rows_at(t, y, &yp)?;
        let mut matrix = vec![0.; n * n];
        let mut rhs = vec![0.; n];
        for i in 0..n {
            let source = if algebraic[i] { &a } else { &b };
            for j in 0..n {
                matrix[i * n + j] = source[j * n + i];
            }
            rhs[i] = if algebraic[i] {
                -(0..n).map(|j| a[j * n + i] * yp[j]).sum::<f64>()
            } else {
                -rows[i]
            };
        }
        let step = solve(n, &mut matrix, rhs)?;
        for (v, d) in yp.iter_mut().zip(step) {
            *v += d;
        }
        let rows = system.rows_at(t, y, &yp)?;
        let residual = largest(rows.iter().copied().enumerate());
        let constraint_rate = largest(
            (0..n)
                .filter(|i| algebraic[*i])
                .map(|i| (i, (0..n).map(|j| a[j * n + i] * yp[j]).sum::<f64>())),
        );
        let pair = ConsistentPair {
            projection: None,
            constraint,
            residual,
            constraint_rate,
            passes: pass,
            bound,
        };
        if residual.value <= bound && constraint_rate.value <= bound {
            return Ok((yp, pair));
        }
        report = Some(pair);
    }
    Err(Failure::Fatal(format!(
        "the consistent-rate solve missed its bound: {report:?}"
    )))
}

/// One projection of a state's algebraic coordinates onto its constraints.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Projection {
    pub before: Largest,
    pub after: Largest,
    /// Largest scaled change of an algebraic coordinate.
    pub correction: Largest,
    /// WRMS of the whole change vector with the integrator's error weights
    /// at the state, as its Newton test measures corrections.
    pub correction_wrms: f64,
    pub passes: usize,
    pub bound: f64,
}

/// Project the algebraic coordinates of `y` onto the constraints `g(y) = 0`
/// with every differential coordinate held bitwise fixed (inventories,
/// impulses, rotor momenta): Newton with the system's own `dg/dy_a`, at most
/// `passes` passes, none when `g` already holds to `bound` (so an exact
/// state is left bitwise unchanged). An integrator's accepted state holds `g`
/// only to its Newton tolerance; an event start needs it exact before its
/// rates are solved. The correction may only remove that slack: its WRMS
/// with the integrator's error `weights` must be at most 1. Refuses, Fatal
/// and naming the row, when either bound is missed.
pub fn project_constraints<S: ConsistentSystem>(
    system: &mut S,
    t: f64,
    y: &mut [f64],
    differential: &[f64],
    weights: &[f64],
    bound: f64,
    passes: usize,
) -> Result<Projection, Failure> {
    let n = system.system_dimension();
    if y.len() != n
        || differential.len() != n
        || weights.len() != n
        || !(bound.is_finite() && bound > 0.)
    {
        return Err(Failure::Fatal(
            "constraint projection layout or bound".into(),
        ));
    }
    let start = y.to_vec();
    let algebraic: Vec<usize> = (0..n).filter(|i| differential[*i] == 0.).collect();
    let zero = vec![0.; n];
    let constraint = |rows: &[f64]| largest(algebraic.iter().map(|i| (*i, rows[*i])));
    let before = constraint(&system.rows_at(t, y, &zero)?);
    let mut after = before;
    let mut correction = Largest { value: 0., row: 0 };
    let mut taken = 0;
    while (after.value.is_nan() || after.value > bound) && taken < passes {
        taken += 1;
        let (a, _) = system.pencil_at(t, y, &zero)?;
        let rows = system.rows_at(t, y, &zero)?;
        let m = algebraic.len();
        let mut matrix = vec![0.; m * m];
        for (r, i) in algebraic.iter().enumerate() {
            for (c, j) in algebraic.iter().enumerate() {
                matrix[r * m + c] = a[j * n + i];
            }
        }
        let step = solve(
            m,
            &mut matrix,
            algebraic.iter().map(|i| -rows[*i]).collect(),
        )?;
        for (d, j) in step.iter().zip(&algebraic) {
            y[*j] += d;
            if d.abs() > correction.value {
                correction = Largest {
                    value: d.abs(),
                    row: *j,
                };
            }
        }
        after = constraint(&system.rows_at(t, y, &zero)?);
    }
    if after.value.is_nan() || after.value > bound {
        return Err(Failure::Fatal(format!(
            "the constraints miss their bound after projection: algebraic row {} is {}",
            after.row, after.value
        )));
    }
    let weighted: Vec<f64> = y
        .iter()
        .zip(&start)
        .zip(weights)
        .map(|((a, b), w)| (a - b) * w)
        .collect();
    let correction_wrms = (weighted.iter().map(|v| v * v).sum::<f64>() / n as f64).sqrt();
    if correction_wrms.is_nan() || correction_wrms > 1. {
        let worst = largest(weighted.iter().copied().enumerate());
        return Err(Failure::Fatal(format!(
            "the constraint projection exceeds the solver's error scale: WRMS {correction_wrms}, largest at row {}",
            worst.row
        )));
    }
    Ok(Projection {
        before,
        after,
        correction,
        correction_wrms,
        passes: taken,
        bound,
    })
}

/// An event or prepared start: [`project_constraints`], then
/// [`consistent_rates`] at the projected state.
pub fn consistent_start<S: ConsistentSystem>(
    system: &mut S,
    t: f64,
    y: &mut [f64],
    differential: &[f64],
    weights: &[f64],
    bound: f64,
    passes: usize,
) -> Result<(Vec<f64>, ConsistentPair), Failure> {
    let projection = project_constraints(system, t, y, differential, weights, bound, passes)?;
    let (yp, mut pair) = consistent_rates(system, t, y, differential, bound, passes)?;
    pair.projection = Some(projection);
    Ok((yp, pair))
}

/// Dense Gaussian elimination with partial pivoting, row-major `matrix`.
fn solve(n: usize, matrix: &mut [f64], mut rhs: Vec<f64>) -> Result<Vec<f64>, Failure> {
    for k in 0..n {
        let pivot = (k..n)
            .max_by(|a, b| matrix[a * n + k].abs().total_cmp(&matrix[b * n + k].abs()))
            .unwrap_or(k);
        if !matrix[pivot * n + k].is_normal() {
            return Err(Failure::Fatal(format!(
                "singular consistent-rate system at column {k}"
            )));
        }
        if pivot != k {
            for j in 0..n {
                matrix.swap(k * n + j, pivot * n + j);
            }
            rhs.swap(k, pivot);
        }
        for i in k + 1..n {
            let factor = matrix[i * n + k] / matrix[k * n + k];
            if factor != 0. {
                for j in k..n {
                    matrix[i * n + j] -= factor * matrix[k * n + j];
                }
                rhs[i] -= factor * rhs[k];
            }
        }
    }
    let mut x = vec![0.; n];
    for i in (0..n).rev() {
        let sum: f64 = (i + 1..n).map(|j| matrix[i * n + j] * x[j]).sum();
        x[i] = (rhs[i] - sum) / matrix[i * n + i];
    }
    if x.iter().any(|v| !v.is_finite()) {
        return Err(Failure::Fatal("nonfinite consistent rates".into()));
    }
    Ok(x)
}

impl<P: Properties> ConsistentSystem for Network<P> {
    fn system_dimension(&self) -> usize {
        self.dimension()
    }
    fn rows_at(&mut self, t: f64, y: &[f64], yp: &[f64]) -> Result<Vec<f64>, Failure> {
        self.evaluate(t, y, yp, None, 0., None)?;
        Ok(self.rows.iter().map(|r| r.value).collect())
    }
    fn pencil_at(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
    ) -> Result<(Vec<f64>, Vec<f64>), Failure> {
        let n = self.dimension();
        let mut dense = |cj: f64| -> Result<Vec<f64>, Failure> {
            let (mut data, mut rows, mut pointers) =
                (vec![0.; n * n], vec![0i64; n * n], vec![0i64; n + 1]);
            self.jacobian_dense(
                t,
                cj,
                y,
                yp,
                CscOut {
                    data: &mut data,
                    rows: &mut rows,
                    pointers: &mut pointers,
                },
            )?;
            Ok(data)
        };
        let a = dense(0.)?;
        let ab = dense(1.)?;
        let b = ab.iter().zip(&a).map(|(x, y)| x - y).collect();
        Ok((a, b))
    }
}

/// Caller-owned compressed-sparse-column output of one stage Jacobian.
pub struct CscOut<'a> {
    pub data: &'a mut [f64],
    pub rows: &'a mut [i64],
    pub pointers: &'a mut [i64],
}

/// Compiled sparse structure and its column coloring, built once.
pub struct SparseJacobian {
    pub pattern: Pattern,
    pub coloring: Coloring,
}

/// Complete n*n column structure; retained only to check sparse assembly.
pub struct DensePattern;
impl DensePattern {
    pub fn nonzeros(n: usize) -> usize {
        n * n
    }
}

impl<P: Properties> Network<P> {
    /// Branch signs of the seeded columns after a value evaluation at `y`.
    pub fn column_signs(&self, y: &[f64]) -> Vec<f64> {
        let mut signs = vec![1.; self.scales.len()];
        for layout in &self.face_layout {
            if y[layout.index] == 0. {
                signs[layout.index] =
                    1_f64.copysign(self.face_drive[layout.face][layout.phase].value);
            }
        }
        signs
    }

    /// Dense column-by-column assembly into CSC arrays sized n*n.
    pub fn jacobian_dense(
        &mut self,
        t: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        out: CscOut<'_>,
    ) -> Result<(), Failure> {
        let CscOut {
            data,
            rows,
            pointers,
        } = out;
        let started = Instant::now();
        self.counters.jacobians += 1;
        let size = self.dimension();
        let mut reuse = self.reuse();
        let result = (|| {
            self.evaluate(t, y, yp, None, 0., Some(&mut reuse))?;
            let signs = self.column_signs(y);
            let mut seed = vec![0.; size];
            for (col, pointer) in pointers.iter_mut().take(size).enumerate() {
                seed[col] = signs[col];
                let evaluated = self.evaluate(t, y, yp, Some(&seed), cj, Some(&mut reuse));
                seed[col] = 0.;
                evaluated?;
                *pointer = (col * size) as i64;
                for (row, residual) in self.rows.iter().enumerate() {
                    let j = col * size + row;
                    rows[j] = row as i64;
                    data[j] = residual.direction / signs[col];
                }
            }
            pointers[size] = (size * size) as i64;
            Ok(())
        })();
        self.counters.jacobian_wall_s += started.elapsed().as_secs_f64();
        result
    }

    /// Compile the structural pattern once and color its columns.
    pub fn sparse_jacobian(&self) -> Result<SparseJacobian, Failure> {
        let columns = self.structural_pattern();
        let pattern = Pattern::from_columns(self.dimension(), &columns).map_err(Failure::Fatal)?;
        let coloring = Coloring::greedy(&pattern);
        coloring.verify(&pattern).map_err(Failure::Fatal)?;
        Ok(SparseJacobian { pattern, coloring })
    }

    /// Colored assembly: one exact seeded evaluation per color, scattered
    /// into `values` in the order of `structure.pattern`'s stored entries.
    /// An omitted structural dependency is refused, never dropped.
    pub fn jacobian_colored(
        &mut self,
        t: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        structure: &SparseJacobian,
        values: &mut [f64],
    ) -> Result<(), Failure> {
        let started = Instant::now();
        self.counters.jacobians += 1;
        let size = self.dimension();
        let mut reuse = self.reuse();
        let result = (|| {
            self.evaluate(t, y, yp, None, 0., Some(&mut reuse))?;
            let signs = self.column_signs(y);
            let mut seed = vec![0.; size];
            let mut directions = vec![0.; size];
            for color in 0..structure.coloring.count() {
                structure
                    .coloring
                    .seed_into(color, &signs, &mut seed)
                    .map_err(Failure::Fatal)?;
                self.evaluate(t, y, yp, Some(&seed), cj, Some(&mut reuse))?;
                for (d, r) in directions.iter_mut().zip(&self.rows) {
                    *d = r.direction;
                }
                sparse::scatter(
                    &structure.pattern,
                    &structure.coloring,
                    color,
                    &directions,
                    &signs,
                    values,
                )
                .map_err(Failure::Fatal)?;
            }
            Ok(())
        })();
        self.counters.jacobian_wall_s += started.elapsed().as_secs_f64();
        result
    }
}
