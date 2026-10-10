//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#6-solver-properties-and-cost-obligations
//! Stage-Jacobian assembly `dF/dy + cj*dF/dy'` from exact seeded directions.
//!
//! Exact current caloric points are reused only within one assembly. An
//! exact-zero impulse column follows its current force branch: the seed sign
//! is that branch and the output is divided by it (one-sided, disclosed).
use super::{Failure, Network, Properties};
use crate::sparse::{self, Coloring, Pattern};
use std::time::Instant;

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
