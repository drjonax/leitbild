//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-scale-realization.md#high-performance-mathematics-without-changing-the-physical-question
//! Stock KLU direct solves on small known systems, repeated refactorization,
//! singular detection, refused inputs and cost at the composed plant's dense
//! (n=328) and sparse (n=6000) scales. Test matrices only, no plant physics.
#![cfg(feature = "ida")]
use leitbild_operating_water::klu::{Error, KLU_SINGULAR, SparseLu};
use std::time::Instant;

/// Fixed CSC pattern with values, built from column-major dense storage.
struct Csc {
    n: usize,
    pointers: Vec<i64>,
    rows: Vec<i64>,
    values: Vec<f64>,
}
impl Csc {
    fn dense(n: usize, column_major: &[f64]) -> Self {
        let mut csc = Self::empty(n);
        for column in column_major.chunks(n) {
            for (row, &value) in column.iter().enumerate() {
                if value != 0. {
                    csc.rows.push(row as i64);
                    csc.values.push(value);
                }
            }
            csc.pointers.push(csc.rows.len() as i64);
        }
        csc
    }
    fn empty(n: usize) -> Self {
        Self {
            n,
            pointers: vec![0],
            rows: Vec::new(),
            values: Vec::new(),
        }
    }
    fn analyze(&self) -> SparseLu {
        SparseLu::analyze(self.n, &self.pointers, &self.rows).unwrap()
    }
    fn product(&self, x: &[f64]) -> Vec<f64> {
        let mut out = vec![0.; self.n];
        for (column, span) in self.pointers.windows(2).enumerate() {
            for p in span[0] as usize..span[1] as usize {
                out[self.rows[p] as usize] += self.values[p] * x[column];
            }
        }
        out
    }
    /// max |A x - b| / max |b|.
    fn residual(&self, x: &[f64], b: &[f64]) -> f64 {
        let ax = self.product(x);
        let scale = b.iter().fold(0_f64, |m, v| m.max(v.abs()));
        ax.iter()
            .zip(b)
            .fold(0_f64, |m, (a, b)| m.max((a - b).abs()))
            / scale
    }
}

/// SplitMix64: deterministic test structure and values, not a model input.
struct SplitMix(u64);
impl SplitMix {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// Nonsymmetric, strictly column diagonally dominant values on given
/// per-column off-diagonal rows, so every pivot order is nonsingular.
fn dominant(n: usize, columns: &[Vec<usize>], random: &mut SplitMix) -> Csc {
    let mut csc = Csc::empty(n);
    for (j, off) in columns.iter().enumerate() {
        let mut rows: Vec<usize> = off.iter().copied().filter(|&r| r != j).collect();
        rows.push(j);
        rows.sort_unstable();
        rows.dedup();
        let entries: Vec<f64> = rows.iter().map(|_| random.unit() - 0.5).collect();
        let off_sum: f64 = rows
            .iter()
            .zip(&entries)
            .filter(|(r, _)| **r != j)
            .map(|(_, v)| v.abs())
            .sum();
        for (&row, &value) in rows.iter().zip(&entries) {
            csc.rows.push(row as i64);
            csc.values.push(if row == j {
                off_sum + 1. + value
            } else {
                value
            });
        }
        csc.pointers.push(csc.rows.len() as i64);
    }
    csc
}

#[test]
fn known_nonsymmetric_system_is_solved_and_factor_reused() {
    // Row-major A = [[0, 2, 1], [3, 0, 0], [1, 1, 4]]: zero diagonal entries.
    let a = Csc::dense(3, &[0., 3., 1., 2., 0., 1., 1., 0., 4.]);
    let mut lu = a.analyze();
    assert_eq!(
        (lu.dimension(), lu.nonzeros(), lu.is_factored()),
        (3, 6, false)
    );
    lu.factor(&a.values).unwrap();
    assert!(lu.is_factored());
    let x = [1., -2., 0.5];
    let mut b = a.product(&x);
    assert_eq!(b, [-3.5, 3., 1.]);
    lu.solve(&mut b).unwrap();
    for (computed, exact) in b.iter().zip(x) {
        assert!(
            (computed - exact).abs() <= 4. * f64::EPSILON,
            "{computed} vs {exact}"
        );
    }
    let mut second = [0., 3., 0.];
    lu.solve(&mut second).unwrap();
    assert!(a.residual(&second, &[0., 3., 0.]) <= 4. * f64::EPSILON);
    let rcond = lu.rcond().unwrap();
    assert!(rcond > 0. && rcond <= 1.);
    let mut identity = Csc::dense(2, &[1., 0., 0., 1.]).analyze();
    identity.factor(&[1., 1.]).unwrap();
    assert_eq!(identity.rcond().unwrap(), 1.);
}

#[test]
fn repeated_refactorization_tracks_changing_values_on_one_pattern() {
    let n = 50;
    let mut random = SplitMix(50);
    let columns: Vec<Vec<usize>> = (0..n)
        .map(|j| vec![(j + n - 1) % n, (j + 1) % n, (j + 7) % n])
        .collect();
    let base = dominant(n, &columns, &mut random);
    let x: Vec<f64> = (0..n).map(|i| (i as f64 * 0.37).sin() + 2.).collect();
    let mut lu = base.analyze();
    assert_eq!(lu.refactor(&base.values).unwrap_err(), Error::NotFactored);
    for step in 0..20 {
        // Off-diagonal values change sign and size; the diagonal stays dominant.
        let shift = 0.25 * f64::from(step);
        let mut a = Csc {
            values: base.values.clone(),
            pointers: base.pointers.clone(),
            rows: base.rows.clone(),
            n,
        };
        for (column, span) in a.pointers.windows(2).enumerate() {
            for p in span[0] as usize..span[1] as usize {
                if a.rows[p] as usize != column {
                    a.values[p] *= (shift + column as f64).cos();
                }
            }
        }
        if step == 0 {
            lu.factor(&a.values).unwrap();
        } else {
            lu.refactor(&a.values).unwrap();
        }
        let mut b = a.product(&x);
        let rhs = b.clone();
        lu.solve(&mut b).unwrap();
        assert!(a.residual(&b, &rhs) < 1e-14, "step {step}");
        let mut fresh = a.analyze();
        fresh.factor(&a.values).unwrap();
        let mut reference = rhs.clone();
        fresh.solve(&mut reference).unwrap();
        for (refactored, factored) in b.iter().zip(&reference) {
            assert!((refactored - factored).abs() < 1e-13 * factored.abs());
        }
        assert!(
            lu.rcond().unwrap() > 0.1,
            "dominant refactor stays well pivoted"
        );
    }
}

#[test]
fn singular_matrices_report_klu_status_and_leave_no_factorization() {
    let mut lu = SparseLu::analyze(2, &[0, 2, 4], &[0, 1, 0, 1]).unwrap();
    let singular = [1., 1., 2., 2.];
    let good = [2., 1., 1., 3.];
    let refused = |error: Error, operation: &str| match error {
        Error::Klu {
            operation: op,
            status,
            singular_column,
        } => {
            assert_eq!((op, status), (operation, KLU_SINGULAR));
            assert!(singular_column.is_some_and(|c| c < 2));
        }
        other => panic!("{other:?}"),
    };
    refused(lu.factor(&singular).unwrap_err(), "factor");
    assert!(!lu.is_factored());
    assert_eq!(lu.solve(&mut [1., 1.]).unwrap_err(), Error::NotFactored);
    assert_eq!(lu.rcond().unwrap_err(), Error::NotFactored);
    lu.factor(&good).unwrap();
    // Refactor keeps the earlier pivots and meets an exact zero pivot.
    refused(lu.refactor(&singular).unwrap_err(), "refactor");
    assert!(!lu.is_factored());
    assert_eq!(lu.solve(&mut [1., 1.]).unwrap_err(), Error::NotFactored);
    assert_eq!(lu.refactor(&good).unwrap_err(), Error::NotFactored);
    lu.factor(&good).unwrap();
    let mut b = [3., 4.];
    lu.solve(&mut b).unwrap();
    assert!((b[0] - 1.).abs() < 1e-15 && (b[1] - 1.).abs() < 1e-15);
    // Nearly singular values factor, and the diagnostic exposes them.
    let epsilon = 1e-6;
    lu.factor(&[1., 1., 1., 1. + epsilon]).unwrap();
    let rcond = lu.rcond().unwrap();
    assert!((rcond - epsilon / (1. + epsilon)).abs() < 1e-12, "{rcond}");
    // Structurally singular: column 1 stores nothing. KLU analyzes it and
    // the numerical factorization names the empty column.
    let mut empty = SparseLu::analyze(3, &[0, 2, 2, 4], &[0, 1, 0, 2]).unwrap();
    match empty.factor(&[1., 2., 3., 4.]).unwrap_err() {
        Error::Klu {
            operation: "factor",
            status: KLU_SINGULAR,
            singular_column,
        } => {
            assert_eq!(singular_column, Some(1));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn malformed_patterns_values_and_right_hand_sides_are_refused_before_klu() {
    let patterns: [(usize, &[i64], &[i64]); 9] = [
        (0, &[0], &[]),
        (2, &[0, 1], &[0]),
        (2, &[1, 1, 2], &[0, 1]),
        (2, &[0, 2, 1], &[0, 1]),
        (2, &[0, 1, 3], &[0, 1]),
        (2, &[0, 2, 2], &[1, 0]),
        (2, &[0, 2, 2], &[1, 1]),
        (2, &[0, 1, 2], &[0, 2]),
        (2, &[0, 1, 2], &[-1, 1]),
    ];
    for (n, pointers, rows) in patterns {
        let error = SparseLu::analyze(n, pointers, rows).err().unwrap();
        assert!(matches!(error, Error::Input(_)), "{error:?}");
    }
    let mut lu = SparseLu::analyze(2, &[0, 1, 2], &[0, 1]).unwrap();
    for values in [
        &[1.][..],
        &[1., 2., 3.],
        &[1., f64::NAN],
        &[f64::INFINITY, 1.],
    ] {
        assert!(matches!(lu.factor(values).unwrap_err(), Error::Input(_)));
    }
    assert!(!lu.is_factored());
    lu.factor(&[2., 4.]).unwrap();
    assert!(matches!(lu.refactor(&[2.]).unwrap_err(), Error::Input(_)));
    assert!(
        lu.is_factored(),
        "refused input leaves the factorization intact"
    );
    for rhs in [&mut [1.][..], &mut [1., f64::NAN], &mut [1., 2., 3.]] {
        assert!(matches!(lu.solve(rhs).unwrap_err(), Error::Input(_)));
    }
    let mut b = [1., 1.];
    lu.solve(&mut b).unwrap();
    assert_eq!(b, [0.5, 0.25]);
    // Overflowing finite values surface as a non-finite solution.
    lu.factor(&[1e-300, 1.]).unwrap();
    let mut huge = [1e300, 1.];
    assert_eq!(
        lu.solve(&mut huge).unwrap_err(),
        Error::NonFiniteSolution(0)
    );
}

fn fastest(repetitions: usize, mut run: impl FnMut()) -> f64 {
    (0..repetitions)
        .map(|_| {
            let started = Instant::now();
            run();
            started.elapsed().as_secs_f64()
        })
        .fold(f64::INFINITY, f64::min)
}

fn measure(name: &str, a: &Csc, repetitions: usize) {
    let started = Instant::now();
    let mut lu = a.analyze();
    let analyze_s = started.elapsed().as_secs_f64();
    let factor_s = fastest(repetitions, || lu.factor(&a.values).unwrap());
    let refactor_s = fastest(repetitions, || lu.refactor(&a.values).unwrap());
    let x: Vec<f64> = (0..a.n).map(|i| 1. + (i % 7) as f64).collect();
    let b = a.product(&x);
    let mut solution = b.clone();
    let solve_s = fastest(10, || {
        solution.copy_from_slice(&b);
        lu.solve(&mut solution).unwrap();
    });
    let residual = a.residual(&solution, &b);
    println!(
        "klu {name}: n={} nnz={} analyze={:.3} ms factor={:.3} ms refactor={:.3} ms solve={:.3} ms rcond={:.3e} residual={residual:.1e}",
        a.n,
        a.values.len(),
        analyze_s * 1e3,
        factor_s * 1e3,
        refactor_s * 1e3,
        solve_s * 1e3,
        lu.rcond().unwrap()
    );
    assert!(residual < 1e-12, "{name}: residual {residual}");
}

#[test]
fn dense_328_and_sparse_6000_factor_and_solve_measurement() {
    let mut random = SplitMix(328);
    let dense_columns: Vec<Vec<usize>> = (0..328).map(|_| (0..328).collect()).collect();
    measure(
        "dense pattern",
        &dominant(328, &dense_columns, &mut random),
        3,
    );
    let n: usize = 6000;
    let banded: Vec<Vec<usize>> = (0..n)
        .map(|j| (j.saturating_sub(10)..=(j + 10).min(n - 1)).collect())
        .collect();
    measure(
        "banded half-width 10",
        &dominant(n, &banded, &mut random),
        3,
    );
    // 19 random rows within +-150 of each column: fill already dominates.
    let local: Vec<Vec<usize>> = (0..n)
        .map(|j| {
            let mut rows = vec![j];
            while rows.len() < 20 {
                let row = (j + n + random.below(301) - 150) % n;
                if !rows.contains(&row) {
                    rows.push(row);
                }
            }
            rows
        })
        .collect();
    measure(
        "local random 20/column",
        &dominant(n, &local, &mut random),
        1,
    );
    // Uniformly random 20 rows/column at n=6000 did not finish one factor in
    // over 100 s on the development machine (AMD/BTF fill), so it is not run.
    // Composed residual structure, not a random graph, must supply locality.
}
