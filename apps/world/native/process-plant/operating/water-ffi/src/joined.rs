//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#exact-consistent-start-of-the-joined-residual
//! The joined residual's exact consistent start on direct KLU, and the
//! joined operator as one stock-IDA system.
//!
//! The start is decision 0013's exit, the network's `consistent_start`, on
//! the joined sparse pattern: the algebraic coordinates are projected onto
//! their constraints by Newton with `dg/dy_a` (every differential coordinate
//! held bitwise, the correction's WRMS with the integrator's weights at most
//! 1), then the rates solve one linear system whose differential rows are
//! `dF/dy'` and whose algebraic rows are `dg/dy`, exact in one pass. The
//! matrices come from the colored assemblies at `cj = 0` and `cj = 1`. No
//! IDACalcIC, no iteration of the rates, no tolerance is loosened: a missed
//! bound refuses, naming the row. No solver algorithm lives here.
use crate::klu::SparseLu;
use leitbild_operating_plant::{
    joined::operator::Joined,
    network::{Failure, Properties},
    thermal::WaterProperties,
};

use std::time::Instant;

fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("joined consistent start: {}", reason.into()))
}

/// Largest magnitude of one class of rows and the first row carrying it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Largest {
    pub value: f64,
    pub row: usize,
}
fn largest(values: impl Iterator<Item = (usize, f64)>) -> Largest {
    values.fold(Largest::default(), |best, (row, v)| {
        let v = v.abs();
        if !best.value.is_nan() && (v.is_nan() || v > best.value) {
            Largest { value: v, row }
        } else {
            best
        }
    })
}

/// What the start did, with its timings.
#[derive(Clone, Debug, Default)]
pub struct Report {
    pub constraint_before: Largest,
    pub constraint_after: Largest,
    pub projection_passes: usize,
    /// Largest scaled change of an algebraic coordinate.
    pub correction: Largest,
    pub correction_wrms: f64,
    /// Every row of `F(t, y, y')` after the rate solve.
    pub residual: Largest,
    /// `dg/dy y'` over the algebraic rows.
    pub constraint_rate: Largest,
    /// Passes of the rate solve on the one factorization (the first exact,
    /// later ones removing round-off only).
    pub rate_passes: usize,
    pub bound: f64,
    pub nonzeros: usize,
    pub colors: usize,
    pub jacobian_s: Vec<f64>,
    pub factor_s: Vec<f64>,
    pub solve_s: Vec<f64>,
}

fn csc_i64(pointers: &[usize], indices: &[usize]) -> (Vec<i64>, Vec<i64>) {
    (
        pointers.iter().map(|p| *p as i64).collect(),
        indices.iter().map(|r| *r as i64).collect(),
    )
}

/// One colored assembly at `(t, y, 0)` with stage coefficient `cj`.
fn assemble<P: Properties + WaterProperties>(
    joined: &mut Joined<P>,
    t: f64,
    cj: f64,
    y: &[f64],
    values: &mut [f64],
    report: &mut Report,
) -> Result<(), Failure> {
    let zero = vec![0.; y.len()];
    let started = Instant::now();
    joined.jacobian(t, cj, y, &zero, values)?;
    report.jacobian_s.push(started.elapsed().as_secs_f64());
    Ok(())
}

/// The exact consistent start of the joined residual at `t`: `y` holds the
/// projected state on success, and the consistent rates are returned.
pub fn consistent_start<P: Properties + WaterProperties>(
    joined: &mut Joined<P>,
    t: f64,
    y: &mut [f64],
    differential: &[f64],
    weights: &[f64],
    bound: f64,
    passes: usize,
) -> Result<(Vec<f64>, Report), Failure> {
    let n = joined.dimension();
    if y.len() != n
        || differential.len() != n
        || weights.len() != n
        || !(bound.is_finite() && bound > 0.)
        || passes == 0
    {
        return Err(fatal("layout, bound or passes"));
    }
    let (pointers, indices, colors) = {
        let (pattern, coloring) = joined
            .structure()
            .ok_or_else(|| fatal("the joined operator has no structure"))?;
        (
            pattern.pointers().to_vec(),
            pattern.indices().to_vec(),
            coloring.count(),
        )
    };
    let nnz = indices.len();
    let mut report = Report {
        bound,
        nonzeros: nnz,
        colors,
        ..Report::default()
    };
    let algebraic: Vec<bool> = differential.iter().map(|d| *d == 0.).collect();
    let zero = vec![0.; n];
    let rows_at = |joined: &mut Joined<P>, y: &[f64], yp: &[f64]| -> Result<Vec<f64>, Failure> {
        joined.evaluate(t, y, yp, None, 0., None)?;
        Ok(joined.rows().iter().map(|r| r.value).collect())
    };
    let constraint = |rows: &[f64]| {
        largest(
            rows.iter()
                .enumerate()
                .filter(|(i, _)| algebraic[*i])
                .map(|(i, r)| (i, *r)),
        )
    };
    let start = y.to_vec();
    let mut rows = rows_at(joined, y, &zero)?;
    report.constraint_before = constraint(&rows);
    report.constraint_after = report.constraint_before;
    let mut values = vec![0.; nnz];
    // 1. Projection of the algebraic coordinates, differential ones held.
    let local: Vec<Option<usize>> = {
        let mut k = 0;
        algebraic
            .iter()
            .map(|a| {
                a.then(|| {
                    k += 1;
                    k - 1
                })
            })
            .collect()
    };
    let m = algebraic.iter().filter(|a| **a).count();
    let mut sub_pointers = vec![0usize];
    let mut sub_rows = Vec::new();
    let mut sub_positions = Vec::new();
    for j in 0..n {
        if !algebraic[j] {
            continue;
        }
        for position in pointers[j]..pointers[j + 1] {
            if let Some(r) = local[indices[position]] {
                sub_rows.push(r);
                sub_positions.push(position);
            }
        }
        sub_pointers.push(sub_rows.len());
    }
    let mut projector: Option<SparseLu> = None;
    while (report.constraint_after.value.is_nan() || report.constraint_after.value > bound)
        && report.projection_passes < passes
    {
        report.projection_passes += 1;
        assemble(joined, t, 0., y, &mut values, &mut report)?;
        let sub: Vec<f64> = sub_positions.iter().map(|p| values[*p]).collect();
        let lu = match projector.as_mut() {
            Some(lu) => lu,
            None => {
                let (p, r) = csc_i64(&sub_pointers, &sub_rows);
                projector.insert(SparseLu::analyze(m, &p, &r).map_err(|e| fatal(e.to_string()))?)
            }
        };
        let started = Instant::now();
        lu.factor(&sub)
            .map_err(|e| fatal(format!("projection: {e}")))?;
        report.factor_s.push(started.elapsed().as_secs_f64());
        let mut rhs: Vec<f64> = (0..n).filter(|i| algebraic[*i]).map(|i| -rows[i]).collect();
        let started = Instant::now();
        lu.solve(&mut rhs)
            .map_err(|e| fatal(format!("projection: {e}")))?;
        report.solve_s.push(started.elapsed().as_secs_f64());
        let mut k = 0;
        for (j, a) in algebraic.iter().enumerate() {
            if *a {
                y[j] += rhs[k];
                if rhs[k].abs() > report.correction.value {
                    report.correction = Largest {
                        value: rhs[k].abs(),
                        row: j,
                    };
                }
                k += 1;
            }
        }
        rows = rows_at(joined, y, &zero)?;
        report.constraint_after = constraint(&rows);
    }
    if report.constraint_after.value.is_nan() || report.constraint_after.value > bound {
        return Err(fatal(format!(
            "constraints miss their bound after projection: {:?}",
            report.constraint_after
        )));
    }
    let weighted: Vec<f64> = y
        .iter()
        .zip(&start)
        .zip(weights)
        .map(|((a, b), w)| (a - b) * w)
        .collect();
    report.correction_wrms = (weighted.iter().map(|v| v * v).sum::<f64>() / n as f64).sqrt();
    if report.correction_wrms.is_nan() || report.correction_wrms > 1. {
        return Err(fatal(format!(
            "the projection exceeds the solver's error scale: WRMS {}",
            report.correction_wrms
        )));
    }
    // 2. The consistent rates: differential rows dF/dy', algebraic rows dg/dy.
    let mut a = vec![0.; nnz];
    assemble(joined, t, 0., y, &mut a, &mut report)?;
    let mut ab = vec![0.; nnz];
    assemble(joined, t, 1., y, &mut ab, &mut report)?;
    let matrix: Vec<f64> = (0..nnz)
        .map(|p| {
            if algebraic[indices[p]] {
                a[p]
            } else {
                ab[p] - a[p]
            }
        })
        .collect();
    let (p, r) = csc_i64(&pointers, &indices);
    let mut lu = SparseLu::analyze(n, &p, &r).map_err(|e| fatal(e.to_string()))?;
    let started = Instant::now();
    lu.factor(&matrix)
        .map_err(|e| fatal(format!("rates: {e}")))?;
    report.factor_s.push(started.elapsed().as_secs_f64());
    // The rows are linear in y', so one pass is exact; further passes, at
    // most `passes`, only remove the first solve's round-off, as the
    // network's dense consistent_rates does.
    let mut yp = vec![0.; n];
    let mut residual = rows.clone();
    let constraint_rate = |yp: &[f64]| {
        let mut rate = vec![0.; n];
        for j in 0..n {
            for position in pointers[j]..pointers[j + 1] {
                rate[indices[position]] += a[position] * yp[j];
            }
        }
        rate
    };
    for pass in 1..=passes {
        let rate = constraint_rate(&yp);
        let mut step: Vec<f64> = (0..n)
            .map(|i| if algebraic[i] { -rate[i] } else { -residual[i] })
            .collect();
        let started = Instant::now();
        lu.solve(&mut step)
            .map_err(|e| fatal(format!("rates: {e}")))?;
        report.solve_s.push(started.elapsed().as_secs_f64());
        for (v, d) in yp.iter_mut().zip(&step) {
            *v += d;
        }
        residual = rows_at(joined, y, &yp)?;
        report.residual = largest(residual.iter().copied().enumerate());
        let rate = constraint_rate(&yp);
        report.constraint_rate = largest(
            rate.iter()
                .enumerate()
                .filter(|(i, _)| algebraic[*i])
                .map(|(i, v)| (i, *v)),
        );
        report.rate_passes = pass;
        if report.residual.value <= bound && report.constraint_rate.value <= bound {
            break;
        }
    }
    if report.residual.value.is_nan()
        || report.residual.value > bound
        || report.constraint_rate.value.is_nan()
        || report.constraint_rate.value > bound
    {
        return Err(fatal(format!(
            "the consistent-rate solve missed its bound: residual {:?}, constraint rate {:?}",
            report.residual, report.constraint_rate
        )));
    }
    Ok((yp, report))
}

pub use integrated::Integrated;

mod integrated {
    use crate::ida::{Failure, System};
    use leitbild_operating_plant::{
        joined::operator::Joined,
        network::{self, Properties},
        thermal::WaterProperties,
    };

    fn failure(f: network::Failure) -> Failure {
        match f {
            network::Failure::Recoverable(reason) => Failure::Recoverable(reason),
            network::Failure::Fatal(reason) => Failure::Fatal(reason),
        }
    }

    /// The joined operator as one stock-IDA system, with its colored sparse
    /// Jacobian. A partial composition (a prepared port) is refused.
    pub struct Integrated<P: Properties> {
        pub joined: Joined<P>,
        rows: Vec<i64>,
        pointers: Vec<i64>,
    }
    impl<P: Properties + WaterProperties> Integrated<P> {
        pub fn new(joined: Joined<P>) -> Result<Self, String> {
            if !joined.integrable() {
                return Err(
                    "a joined operator with a prepared SG or rod port cannot be integrated".into(),
                );
            }
            let (pattern, _) = joined
                .structure()
                .ok_or("the joined operator has no structure")?;
            let (pointers, rows) = pattern.to_i64()?;
            Ok(Self {
                joined,
                rows,
                pointers,
            })
        }
    }
    impl<P: Properties + WaterProperties> System for Integrated<P> {
        fn dimension(&self) -> usize {
            self.joined.dimension()
        }
        fn nonzeros(&self) -> usize {
            self.rows.len()
        }
        /// The owners' root functions, read once at construction.
        fn root_count(&self) -> usize {
            self.joined.root_count()
        }
        fn roots(
            &mut self,
            time: f64,
            y: &[f64],
            yp: &[f64],
            out: &mut [f64],
        ) -> Result<(), Failure> {
            self.joined.roots(time, y, yp, out).map_err(failure)
        }
        fn residual(
            &mut self,
            time: f64,
            y: &[f64],
            yp: &[f64],
            out: &mut [f64],
        ) -> Result<(), Failure> {
            self.joined
                .evaluate(time, y, yp, None, 0., None)
                .map_err(failure)?;
            for (r, v) in out.iter_mut().zip(self.joined.rows()) {
                *r = v.value;
            }
            Ok(())
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
            rows.copy_from_slice(&self.rows);
            pointers.copy_from_slice(&self.pointers);
            self.joined.jacobian(time, cj, y, yp, data).map_err(failure)
        }
    }
}
