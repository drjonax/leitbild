//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-scale-realization.md#high-performance-mathematics-without-changing-the-physical-question
//! Exact compressed Jacobian recovery on deterministic pseudo-random, banded
//! and hand-built structures; small test matrices only, no plant physics.
use leitbild_operating_plant::{
    sparse::{self, Coloring, Pattern},
    thermal::Scalar,
};
use std::{collections::BTreeSet, time::Instant};

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
    fn sign(&mut self) -> f64 {
        if self.next() & 1 == 0 { 1. } else { -1. }
    }
    /// Nonzero integer in -8..=8: products and sums below stay exact.
    fn integer(&mut self) -> f64 {
        let magnitude = 1 + self.below(8) as i32;
        f64::from(magnitude) * self.sign()
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// Diagonal plus distinct random rows, `per_column` stored rows per column.
fn random_lists(n: usize, per_column: usize, seed: u64) -> Vec<Vec<usize>> {
    let mut random = SplitMix(seed);
    (0..n)
        .map(|j| {
            let mut rows = vec![j];
            while rows.len() < per_column.min(n) {
                let row = random.below(n);
                if !rows.contains(&row) {
                    rows.push(row);
                }
            }
            rows.sort_unstable();
            rows
        })
        .collect()
}

fn random_pattern(n: usize, per_column: usize, seed: u64) -> Pattern {
    Pattern::from_columns(n, &random_lists(n, per_column, seed)).unwrap()
}

/// Rows within `half_width` of the diagonal: a local network-like coupling.
fn banded_pattern(n: usize, half_width: usize) -> Pattern {
    let columns: Vec<Vec<usize>> = (0..n)
        .map(|j| (j.saturating_sub(half_width)..=(j + half_width).min(n - 1)).collect())
        .collect();
    Pattern::from_columns(n, &columns).unwrap()
}

fn max_row_degree(pattern: &Pattern) -> usize {
    let mut counts = vec![0; pattern.rows()];
    for &row in pattern.indices() {
        counts[row] += 1;
    }
    counts.into_iter().max().unwrap_or(0)
}

/// Column-major dense copy of CSC values.
fn dense(pattern: &Pattern, values: &[f64]) -> Vec<f64> {
    let mut out = vec![0.; pattern.rows() * pattern.columns()];
    for column in 0..pattern.columns() {
        for position in pattern.pointers()[column]..pattern.pointers()[column + 1] {
            out[column * pattern.rows() + pattern.indices()[position]] = values[position];
        }
    }
    out
}

/// Full product J*d that visits every column, including unseeded ones.
fn product(pattern: &Pattern, values: &[f64], direction: &[f64]) -> Vec<f64> {
    let mut out = vec![0.; pattern.rows()];
    for (column, &d) in direction.iter().enumerate() {
        for position in pattern.pointers()[column]..pattern.pointers()[column + 1] {
            out[pattern.indices()[position]] += values[position] * d;
        }
    }
    out
}

fn recover(
    pattern: &Pattern,
    coloring: &Coloring,
    signs: &[f64],
    mut evaluate: impl FnMut(&[f64]) -> Vec<f64>,
) -> Vec<f64> {
    let mut values = vec![f64::NAN; pattern.nonzeros()];
    let mut direction = vec![0.; pattern.columns()];
    for color in 0..coloring.count() {
        coloring.seed_into(color, signs, &mut direction).unwrap();
        let response = evaluate(&direction);
        sparse::scatter(pattern, coloring, color, &response, signs, &mut values).unwrap();
    }
    values
}

#[test]
fn pattern_admission_rejects_malformed_structure_explicitly() {
    let cases = [
        (3, vec![0, 2, 3], vec![1, 0, 2], "not strictly increasing"),
        (3, vec![0, 2, 3], vec![1, 1, 2], "not strictly increasing"),
        (2, vec![0, 1], vec![2], "outside 0..2"),
        (2, vec![1, 1], vec![0], "start at 0"),
        (2, vec![0, 2, 1], vec![0, 1], "never decrease"),
        (2, vec![0, 1, 1], vec![0, 1], "end at 2"),
        (2, vec![], vec![], "start at 0"),
    ];
    for (rows, pointers, indices, reason) in cases {
        let error = Pattern::new(rows, pointers, indices).unwrap_err();
        assert!(error.contains(reason), "{error}");
    }
    assert!(Pattern::from_columns(3, &[vec![2, 0]]).is_err());
    assert!(
        Pattern::from_rows(2, &[vec![0, 2]])
            .unwrap_err()
            .contains("row 0")
    );
    assert!(Pattern::from_rows(3, &[vec![1, 1]]).is_err());

    // 3x4: columns [0,2], [], [1], [0,1,2]; rows [0,3], [2,3], [0,3].
    let by_columns =
        Pattern::from_columns(3, &[vec![0, 2], vec![], vec![1], vec![0, 1, 2]]).unwrap();
    let by_rows = Pattern::from_rows(4, &[vec![0, 3], vec![2, 3], vec![0, 3]]).unwrap();
    assert_eq!(by_columns, by_rows);
    assert_eq!(
        (
            by_columns.rows(),
            by_columns.columns(),
            by_columns.nonzeros()
        ),
        (3, 4, 6)
    );
    assert_eq!(by_columns.pointers(), &[0, 2, 2, 3, 6]);
    assert_eq!(by_columns.column(3), &[0, 1, 2]);
    assert_eq!(by_columns.position(2, 0), Some(1));
    assert_eq!(by_columns.position(1, 0), None);
    assert_eq!(by_columns.position(1, 3), Some(4));
    assert_eq!(
        by_columns.to_i64().unwrap(),
        (vec![0, 2, 2, 3, 6], vec![0, 2, 1, 0, 1, 2])
    );
    let empty = Pattern::from_columns(4, &[]).unwrap();
    assert_eq!((empty.columns(), empty.nonzeros()), (0, 0));
}

#[test]
fn union_is_the_entrywise_structural_union() {
    let a = Pattern::from_columns(3, &[vec![0, 2], vec![1], vec![]]).unwrap();
    let b = Pattern::from_columns(3, &[vec![1, 2], vec![], vec![0]]).unwrap();
    let expected = Pattern::from_columns(3, &[vec![0, 1, 2], vec![1], vec![0]]).unwrap();
    assert_eq!(a.union(&b).unwrap(), expected);
    assert_eq!(b.union(&a).unwrap(), expected);
    assert_eq!(a.union(&a).unwrap(), a);
    let wide = Pattern::from_columns(3, &[vec![0], vec![0], vec![0], vec![0]]).unwrap();
    assert!(a.union(&wide).unwrap_err().contains("equal shapes"));
    let tall = Pattern::from_columns(4, &[vec![0], vec![0], vec![0]]).unwrap();
    assert!(a.union(&tall).is_err());

    for seed in 0..8 {
        let (x, y) = (random_lists(200, 5, seed), random_lists(200, 7, seed + 100));
        let reference: Vec<Vec<usize>> = x
            .iter()
            .zip(&y)
            .map(|(p, q)| {
                p.iter()
                    .chain(q)
                    .copied()
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect()
            })
            .collect();
        let union = Pattern::from_columns(200, &x)
            .unwrap()
            .union(&Pattern::from_columns(200, &y).unwrap())
            .unwrap();
        assert_eq!(union, Pattern::from_columns(200, &reference).unwrap());
    }
}

#[test]
fn greedy_coloring_is_structurally_orthogonal_and_visits_by_degree() {
    let mut patterns = vec![
        banded_pattern(10, 1),
        banded_pattern(57, 4),
        random_pattern(1, 1, 3),
    ];
    for (n, per_column, seed) in [(7, 3, 1), (50, 1, 2), (50, 8, 3), (300, 6, 4), (300, 12, 5)] {
        patterns.push(random_pattern(n, per_column, seed));
    }
    for pattern in &patterns {
        let coloring = Coloring::greedy(pattern);
        coloring.verify(pattern).unwrap();
        // Every column of one row needs its own color.
        assert!(coloring.count() >= max_row_degree(pattern));
        let grouped: usize = (0..coloring.count())
            .map(|color| coloring.columns(color).unwrap().len())
            .sum();
        assert_eq!(grouped, pattern.columns());
        for color in 0..coloring.count() {
            for &column in coloring.columns(color).unwrap() {
                assert_eq!(coloring.color(column), color);
            }
        }
        assert_eq!(Coloring::greedy(pattern), coloring, "deterministic");
    }
    assert_eq!(Coloring::greedy(&banded_pattern(10, 1)).count(), 3);
    assert_eq!(Coloring::greedy(&banded_pattern(57, 4)).count(), 9);
    let diagonal = Pattern::from_columns(5, &(0..5).map(|j| vec![j]).collect::<Vec<_>>()).unwrap();
    assert_eq!(Coloring::greedy(&diagonal).count(), 1);
    let full = Pattern::from_columns(4, &vec![vec![0, 1, 2, 3]; 4]).unwrap();
    assert_eq!(Coloring::greedy(&full).count(), 4);

    // Arrow: column 3 has the most rows and is colored first; columns 0..3
    // share no row with each other, only with column 3.
    let arrow =
        Pattern::from_columns(4, &[vec![0, 3], vec![1, 3], vec![2], vec![0, 1, 2, 3]]).unwrap();
    let coloring = Coloring::greedy(&arrow);
    assert_eq!(coloring.color(3), 0);
    assert_eq!(coloring.columns(1).unwrap(), &[0, 2]);
    assert_eq!(coloring.columns(2).unwrap(), &[1]);
    assert!(coloring.columns(3).unwrap_err().contains("outside 0..3"));
}

#[test]
fn explicit_colorings_are_verified_before_use() {
    let arrow =
        Pattern::from_columns(4, &[vec![0, 3], vec![1, 3], vec![2], vec![0, 1, 2, 3]]).unwrap();
    let identity = Coloring::new(&arrow, vec![0, 1, 2, 3]).unwrap();
    assert_eq!(identity.count(), 4);
    assert!(
        Coloring::new(&arrow, vec![1, 1, 2, 0])
            .unwrap_err()
            .contains("row 3")
    );
    assert!(Coloring::new(&arrow, vec![0, 2, 1, 3]).is_ok());
    assert!(
        Coloring::new(&arrow, vec![0, 1, 2, 2])
            .unwrap_err()
            .contains("color 2 gives row 2")
    );
    assert!(
        Coloring::new(&arrow, vec![0, 2, 0, 3])
            .unwrap_err()
            .contains("color 1 has no column")
    );
    assert!(
        Coloring::new(&arrow, vec![0, 1, 2])
            .unwrap_err()
            .contains("3 colors for 4")
    );
    assert!(
        Coloring::new(&arrow, vec![0, 1, 2, 4])
            .unwrap_err()
            .contains("exceeds")
    );
    let other = banded_pattern(4, 1);
    assert!(
        identity
            .verify(&other)
            .unwrap_err()
            .contains("not built for this pattern")
    );
}

#[test]
fn compressed_recovery_equals_the_dense_jacobian_bitwise() {
    for (n, per_column, seed) in [(1, 1, 9), (40, 4, 10), (300, 6, 11), (300, 15, 12)] {
        let pattern = random_pattern(n, per_column, seed);
        let mut random = SplitMix(seed ^ 0xA5A5);
        let values: Vec<f64> = (0..pattern.nonzeros()).map(|_| random.integer()).collect();
        let signs: Vec<f64> = (0..n).map(|_| random.sign()).collect();
        let coloring = Coloring::greedy(&pattern);
        let recovered = recover(&pattern, &coloring, &signs, |d| {
            product(&pattern, &values, d)
        });
        let comparison =
            sparse::compare_with_dense(&pattern, &recovered, &dense(&pattern, &values)).unwrap();
        assert!(comparison.is_bitwise_exact(), "{comparison:?}");
        assert!(
            recovered
                .iter()
                .zip(&values)
                .all(|(a, b)| a.to_bits() == b.to_bits())
        );
        assert!(
            coloring.count() < n.max(2),
            "compression must use fewer evaluations"
        );
    }
    let banded = banded_pattern(500, 3);
    let values: Vec<f64> = (0..banded.nonzeros())
        .map(|k| (k % 13) as f64 - 6.5)
        .collect();
    let signs = vec![-1.; 500];
    let coloring = Coloring::greedy(&banded);
    assert_eq!(coloring.count(), 7);
    let recovered = recover(&banded, &coloring, &signs, |d| product(&banded, &values, d));
    assert!(
        sparse::compare_with_dense(&banded, &recovered, &dense(&banded, &values))
            .unwrap()
            .is_bitwise_exact()
    );
}

/// F_i = y_i * sum_k a_ik y_k + b_i / (1 + y_i^2) on a row-declared pattern.
struct Residual {
    rows: Vec<Vec<usize>>,
    a: Vec<Vec<f64>>,
    b: Vec<f64>,
    y: Vec<f64>,
}
impl Residual {
    fn new(n: usize, per_row: usize, seed: u64) -> Self {
        let rows = random_lists(n, per_row, seed);
        let mut random = SplitMix(seed ^ 0x5A5A);
        Self {
            a: rows
                .iter()
                .map(|r| r.iter().map(|_| random.unit() - 0.5).collect())
                .collect(),
            b: (0..n).map(|_| random.unit() + 0.5).collect(),
            y: (0..n).map(|_| 2. * random.unit() - 1.).collect(),
            rows,
        }
    }
    fn direction(&self, d: &[f64]) -> Vec<f64> {
        let y: Vec<Scalar> = self
            .y
            .iter()
            .zip(d)
            .map(|(&v, &d)| Scalar::new(v, d))
            .collect();
        let one = Scalar::constant(1.);
        (0..self.y.len())
            .map(|i| {
                let coupling = self.rows[i]
                    .iter()
                    .zip(&self.a[i])
                    .fold(Scalar::constant(0.), |sum, (&k, &a)| {
                        sum + Scalar::constant(a) * y[k]
                    });
                (y[i] * coupling + Scalar::constant(self.b[i]) / (one + y[i] * y[i])).direction
            })
            .collect()
    }
    fn analytic(&self, pattern: &Pattern) -> Vec<f64> {
        let mut values = vec![0.; pattern.nonzeros()];
        for (i, row) in self.rows.iter().enumerate() {
            let yi = self.y[i];
            for (&k, &a) in row.iter().zip(&self.a[i]) {
                values[pattern.position(i, k).unwrap()] += a * yi;
            }
            let coupling: f64 = row
                .iter()
                .zip(&self.a[i])
                .map(|(&k, &a)| a * self.y[k])
                .sum();
            let diagonal = pattern.position(i, i).unwrap();
            values[diagonal] += coupling - 2. * self.b[i] * yi / (1. + yi * yi).powi(2);
        }
        values
    }
}

#[test]
fn dual_residual_compression_matches_per_column_evaluation_bitwise() {
    for (n, per_row, seed) in [(25, 3, 21), (400, 9, 22)] {
        let residual = Residual::new(n, per_row, seed);
        let pattern = Pattern::from_rows(n, &residual.rows).unwrap();
        let mut random = SplitMix(seed);
        let signs: Vec<f64> = (0..n).map(|_| random.sign()).collect();
        let coloring = Coloring::greedy(&pattern);
        let compressed = recover(&pattern, &coloring, &signs, |d| residual.direction(d));
        let identity = Coloring::new(&pattern, (0..n).collect()).unwrap();
        let per_column = recover(&pattern, &identity, &signs, |d| residual.direction(d));
        assert!(
            compressed
                .iter()
                .zip(&per_column)
                .all(|(a, b)| a.to_bits() == b.to_bits()),
            "one evaluation per color must reproduce per-column evaluation exactly"
        );
        let analytic = residual.analytic(&pattern);
        for (actual, expected) in compressed.iter().zip(&analytic) {
            assert!(
                (actual - expected).abs() <= 1e-14 * (1. + expected.abs()),
                "{actual} {expected}"
            );
        }
        assert!(
            coloring.count() * 2 < n,
            "{} colors for {n} columns",
            coloring.count()
        );
        println!("dual residual n={n}: {} colors", coloring.count());
    }
}

#[test]
fn scatter_refuses_omitted_dependencies_bad_seeds_and_nonfinite_responses() {
    // Columns 0 and 2 share color 0; column 1 couples rows 0 and 1.
    let pattern = Pattern::from_columns(3, &[vec![0], vec![0, 1], vec![2]]).unwrap();
    let coloring = Coloring::new(&pattern, vec![0, 1, 0]).unwrap();
    let color = coloring.color(0);
    assert_eq!(coloring.columns(color).unwrap(), &[0, 2]);
    let signs = [1., -1., -1.];
    assert_eq!(coloring.seed(color, &signs).unwrap(), vec![1., 0., -1.]);
    let sentinel = [7.; 4];
    let refuse = |response: &[f64], signs: &[f64], color: usize, values: &mut [f64]| {
        let error =
            sparse::scatter(&pattern, &coloring, color, response, signs, values).unwrap_err();
        assert_eq!(values, sentinel, "refusal must not write");
        error
    };
    let mut values = sentinel;
    // Row 1 belongs to column 1 only; a response there under color {0,2}
    // proves that column 0 or 2 also drives row 1.
    assert!(refuse(&[2., 1e-300, -3.], &signs, color, &mut values).contains("omits a dependency"));
    assert!(refuse(&[2., f64::NAN, -3.], &signs, color, &mut values).contains("row 1"));
    assert!(refuse(&[f64::INFINITY, 0., -3.], &signs, color, &mut values).contains("non-finite"));
    assert!(refuse(&[2., 0., f64::NAN], &signs, color, &mut values).contains("non-finite"));
    for bad in [0.5, 0., -0., f64::NAN, 2.] {
        let error = refuse(&[2., 0., -3.], &[bad, 1., 1.], color, &mut values);
        assert!(error.contains("seed sign"), "{error}");
        assert!(coloring.seed(color, &[bad, 1., 1.]).is_err());
    }
    assert!(refuse(&[2., 0.], &signs, color, &mut values).contains("row directions length"));
    assert!(
        refuse(&[2., 0., -3.], &signs[..2], color, &mut values).contains("column signs length")
    );
    assert!(refuse(&[2., 0., -3.], &signs, 2, &mut values).contains("outside"));
    assert!(
        sparse::scatter(
            &pattern,
            &coloring,
            color,
            &[2., 0., -3.],
            &signs,
            &mut [0.; 3]
        )
        .is_err()
    );
    let other = Pattern::from_columns(3, &[vec![0], vec![1], vec![2]]).unwrap();
    assert!(
        sparse::scatter(
            &other,
            &coloring,
            color,
            &[2., 0., -3.],
            &signs,
            &mut [0.; 3]
        )
        .is_err()
    );
    assert!(coloring.seed_into(color, &signs, &mut [0.; 2]).is_err());

    // Accepted: signed zero at an unclaimed row is still exactly zero.
    sparse::scatter(
        &pattern,
        &coloring,
        color,
        &[2., -0., -3.],
        &signs,
        &mut values,
    )
    .unwrap();
    assert_eq!(values, [2., 7., 7., 3.]);
    let other_color = coloring.color(1);
    sparse::scatter(
        &pattern,
        &coloring,
        other_color,
        &[4., -5., 0.],
        &signs,
        &mut values,
    )
    .unwrap();
    assert_eq!(values, [2., -4., 5., 3.]);
    let reference = [2., 0., 0., -4., 5., 0., 0., 0., 3.];
    assert!(
        sparse::compare_with_dense(&pattern, &values, &reference)
            .unwrap()
            .is_bitwise_exact()
    );
}

#[test]
fn dense_comparison_reports_stored_and_unstored_discrepancies() {
    let pattern = Pattern::from_columns(2, &[vec![0], vec![0, 1]]).unwrap();
    let reference = [1., 0., 2., 3.];
    let exact = sparse::compare_with_dense(&pattern, &[1., 2., 3.], &reference).unwrap();
    assert!(exact.is_bitwise_exact());
    assert_eq!(exact, sparse::DenseComparison::default());
    let off =
        sparse::compare_with_dense(&pattern, &[1., 2.5, f64::NAN], &[1., -4., 2., 3.]).unwrap();
    assert_eq!(off.bitwise_differences, 2);
    assert_eq!(
        off.largest_stored_difference.unwrap().row,
        1,
        "NaN ranks as infinite"
    );
    assert_eq!(off.unstored_nonzeros, 1);
    let unstored = off.largest_unstored.unwrap();
    assert_eq!(
        (unstored.row, unstored.column, unstored.expected),
        (1, 0, -4.)
    );
    let signed = sparse::compare_with_dense(&pattern, &[1., -0., 3.], &[1., 0., 0., 3.]).unwrap();
    assert_eq!(
        signed.bitwise_differences, 1,
        "bitwise comparison keeps the sign of zero"
    );
    assert_eq!(
        signed.largest_stored_difference.unwrap().actual.to_bits(),
        (-0_f64).to_bits()
    );
    assert!(sparse::compare_with_dense(&pattern, &[1., 2.], &reference).is_err());
    assert!(sparse::compare_with_dense(&pattern, &[1., 2., 3.], &reference[..3]).is_err());
}

fn fastest<T>(repetitions: usize, mut run: impl FnMut() -> T) -> (f64, T) {
    let mut best = f64::INFINITY;
    let mut last = None;
    for _ in 0..repetitions {
        let started = Instant::now();
        let value = run();
        best = best.min(started.elapsed().as_secs_f64());
        last = Some(value);
    }
    (best, last.unwrap())
}

#[test]
fn six_thousand_column_coloring_measurement() {
    let n = 6000;
    let cases = [
        (
            "uniform random, 20 rows/column",
            random_pattern(n, 20, 6000),
        ),
        (
            "banded half-width 10 (21 rows/column)",
            banded_pattern(n, 10),
        ),
    ];
    for (name, pattern) in &cases {
        let (coloring_s, coloring) = fastest(5, || Coloring::greedy(pattern));
        coloring.verify(pattern).unwrap();
        let mut random = SplitMix(n as u64);
        let values: Vec<f64> = (0..pattern.nonzeros()).map(|_| random.integer()).collect();
        let signs: Vec<f64> = (0..n).map(|_| random.sign()).collect();
        let responses: Vec<Vec<f64>> = (0..coloring.count())
            .map(|color| product(pattern, &values, &coloring.seed(color, &signs).unwrap()))
            .collect();
        let mut recovered = vec![0.; pattern.nonzeros()];
        let (scatter_s, ()) = fastest(5, || {
            for (color, response) in responses.iter().enumerate() {
                sparse::scatter(pattern, &coloring, color, response, &signs, &mut recovered)
                    .unwrap();
            }
        });
        assert!(
            recovered
                .iter()
                .zip(&values)
                .all(|(a, b)| a.to_bits() == b.to_bits())
        );
        println!(
            "sparse coloring {name}: n={n} nnz={} max row degree={} colors={} greedy={:.3} ms scatter(all colors)={:.3} ms",
            pattern.nonzeros(),
            max_row_degree(pattern),
            coloring.count(),
            coloring_s * 1e3,
            scatter_s * 1e3
        );
        assert!(coloring.count() >= max_row_degree(pattern));
        assert!(coloring_s < 1., "greedy coloring took {coloring_s} s");
    }
}
