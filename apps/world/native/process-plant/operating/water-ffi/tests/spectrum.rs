#![cfg(target_os = "macos")]
//! Analytic validation of the zero-time spectral diagnostic: index-1
//! oscillators with closed-form spectra and responses, and plant-sized random
//! stable pencils for residuals, modal completeness and dggev cost.
use leitbild_operating_water::spectrum::{
    self, Complex, Error, Event, Excitation, Kind, Report, Spectrum,
};
use serde_json::{Value, json};
use std::{f64::consts::PI, time::Instant};

fn dense(n: usize, entries: &[(usize, usize, f64)]) -> Vec<f64> {
    let mut m = vec![0.; n * n];
    for &(row, column, value) in entries {
        m[column * n + row] += value;
    }
    m
}

/// Real column-major `M x` for a complex `x`.
fn apply(m: &[f64], n: usize, x: &[Complex]) -> Vec<Complex> {
    let mut out = vec![Complex::default(); n];
    for (column, &xk) in m.chunks_exact(n).zip(x) {
        for (o, &mik) in out.iter_mut().zip(column) {
            *o = *o + xk * mik;
        }
    }
    out
}

/// Real column-major `M^T x` for a complex `x`.
fn apply_transpose(m: &[f64], n: usize, x: &[Complex]) -> Vec<Complex> {
    m.chunks_exact(n)
        .map(|column| {
            column
                .iter()
                .zip(x)
                .fold(Complex::default(), |sum, (&mki, &xk)| sum + xk * mki)
        })
        .collect()
}

fn inner(u: &[Complex], x: &[Complex]) -> Complex {
    u.iter()
        .zip(x)
        .fold(Complex::default(), |sum, (&u, &x)| sum + u.conj() * x)
}

fn norm(x: &[Complex]) -> f64 {
    x.iter().map(|z| z.abs().powi(2)).sum::<f64>().sqrt()
}

fn frobenius(m: &[f64]) -> f64 {
    m.iter().map(|x| x * x).sum::<f64>().sqrt()
}

/// Normwise backward errors of `(λ, v)` and `(λ, w^H)` for `A + λB`.
fn backward_errors(a: &[f64], b: &[f64], n: usize, s: &Spectrum, mode: usize) -> [f64; 2] {
    let (lambda, shape) = (s.modes[mode].lambda, &s.shapes[mode]);
    let scale = frobenius(a) + lambda.abs() * frobenius(b);
    let residual = |p: Vec<Complex>, q: Vec<Complex>, l: Complex| {
        norm(
            &p.iter()
                .zip(&q)
                .map(|(&p, &q)| p + l * q)
                .collect::<Vec<_>>(),
        )
    };
    let right = residual(apply(a, n, &shape.right), apply(b, n, &shape.right), lambda);
    // w^H (A + λB) = 0  <=>  A^T w + conj(λ) B^T w = 0.
    let left = residual(
        apply_transpose(a, n, &shape.left),
        apply_transpose(b, n, &shape.left),
        lambda.conj(),
    );
    [
        right / (scale * norm(&shape.right)),
        left / (scale * norm(&shape.left)),
    ]
}

/// Every finite eigenvalue, a pair expanded to both members.
fn eigenvalues(s: &Spectrum) -> Vec<Complex> {
    s.modes
        .iter()
        .flat_map(|m| {
            if m.pair {
                vec![m.lambda, m.lambda.conj()]
            } else {
                vec![m.lambda]
            }
        })
        .collect()
}

fn relative_miss(values: &[Complex], exact: Complex) -> f64 {
    values
        .iter()
        .map(|&z| (z - exact).abs())
        .fold(f64::INFINITY, f64::min)
        / exact.abs()
}

/// Finite-mode part of `δy(t)`: `Σ_m k Re(v_m q_m(t))` with the documented `q_m`.
fn finite_response(s: &Spectrum, e: &Excitation, t: Option<f64>) -> Vec<f64> {
    let mut y = vec![0.; s.dimension];
    for ((mode, shape), response) in s.modes.iter().zip(&s.shapes).zip(&e.responses) {
        // `None` is the limit t -> infinity of a stable spectrum.
        let decay = t.map_or(Complex::default(), |t| (mode.lambda * t).exp());
        let q = match e.kind {
            Kind::Residual => response.projection / mode.lambda * (Complex::new(1., 0.) - decay),
            Kind::Jump => response.projection * decay,
        };
        let weight = if mode.pair { 2. } else { 1. };
        for (yi, &vi) in y.iter_mut().zip(&shape.right) {
            *yi += weight * (vi * q).re;
        }
    }
    y
}

/// `y = (x, u, p)`: `x' = u`, `m u' = −p − c u + f`, `0 = p − k x`.
#[derive(Clone, Copy)]
struct Oscillator {
    m: f64,
    k: f64,
    c: f64,
}
impl Oscillator {
    fn pencil(self) -> (Vec<f64>, Vec<f64>) {
        let Self { m, k, c } = self;
        (
            dense(
                3,
                &[(0, 1, -1.), (1, 1, c), (1, 2, 1.), (2, 0, -k), (2, 2, 1.)],
            ),
            dense(3, &[(0, 0, 1.), (1, 1, m)]),
        )
    }
    /// Roots of `m λ² + c λ + k = 0` without cancellation.
    fn roots(self) -> [Complex; 2] {
        let Self { m, k, c } = self;
        let disc = c * c - 4. * m * k;
        if disc < 0. {
            let (re, im) = (-c / (2. * m), (-disc).sqrt() / (2. * m));
            [Complex::new(re, im), Complex::new(re, -im)]
        } else {
            let q = -0.5 * (c + c.signum() * disc.sqrt());
            [Complex::new(q / m, 0.), Complex::new(k / q, 0.)]
        }
    }
    fn sigma(self) -> f64 {
        -self.c / (2. * self.m)
    }
    fn omega_n(self) -> f64 {
        (self.k / self.m).sqrt()
    }
    fn omega_d(self) -> f64 {
        (self.k / self.m - self.sigma().powi(2)).sqrt()
    }
    /// Exact underdamped release from `(x0, u0)`:
    /// `x = e^{σt}(x0 cos ω_d t + (u0 − σx0)/ω_d sin ω_d t)` and its derivative.
    fn free(self, x0: f64, u0: f64, t: f64) -> [f64; 2] {
        let (s, w, n) = (self.sigma(), self.omega_d(), self.omega_n());
        let (e, cos, sin) = ((s * t).exp(), (w * t).cos(), (w * t).sin());
        [
            e * (x0 * cos + (u0 - s * x0) / w * sin),
            e * (u0 * cos + (s * u0 - n * n * x0) / w * sin),
        ]
    }
    /// Envelope amplitudes of `free`: `|x0 + i(u0 − σx0)/ω_d|` and its `u` analogue.
    fn envelope(self, x0: f64, u0: f64) -> [f64; 2] {
        let (s, w, n) = (self.sigma(), self.omega_d(), self.omega_n());
        [
            x0.hypot((u0 - s * x0) / w),
            u0.hypot((s * u0 - n * n * x0) / w),
        ]
    }
    /// Exact response to a force step `f` at rest: `f/k` plus a release from `−f/k`.
    fn step(self, f: f64, t: f64) -> [f64; 2] {
        let [x, u] = self.free(-f / self.k, 0., t);
        [f / self.k + x, u]
    }
}

const LIGHT: Oscillator = Oscillator {
    m: 2.,
    k: 50.,
    c: 0.6,
};

/// Check one pair excitation of `LIGHT` against its closed form: per-coordinate
/// envelopes, ratio, argmax and the reconstructed history. Returns the largest
/// relative envelope error.
fn closed_form(
    s: &Spectrum,
    e: &Excitation,
    tol: &[f64],
    envelope: [f64; 2],
    history: impl Fn(f64) -> [f64; 2],
) -> f64 {
    let o = LIGHT;
    assert_eq!((s.modes.len(), e.responses.len()), (1, 1));
    let response = e.responses[0];
    let exact = [envelope[0], envelope[1], o.k * envelope[0]];
    let mut worst: f64 = 0.;
    for (i, &exact) in exact.iter().enumerate() {
        let predicted = 2. * s.shapes[0].right[i].abs() * response.amplitude;
        worst = worst.max((predicted - exact).abs() / exact);
    }
    assert!(worst < 1e-10, "envelope error {worst:e}");
    let ratios: Vec<f64> = exact.iter().zip(tol).map(|(a, t)| a / t).collect();
    let ratio = ratios.iter().copied().fold(0., f64::max);
    let coordinate = ratios.iter().position(|&r| r == ratio).unwrap();
    assert!((response.ratio - ratio).abs() < 1e-10 * ratio);
    assert_eq!(response.coordinate, coordinate);
    assert_eq!((e.dominant, e.fastest_above_tolerance), (Some(0), Some(0)));
    let settle = ratio.ln() / -o.sigma();
    assert!((response.settle_s - settle).abs() < 1e-10 * settle);
    for step in 0..=600 {
        let t = 0.05 * f64::from(step);
        let y = finite_response(s, e, Some(t));
        let [x, u] = history(t);
        // The infinite mode carries any instantaneous algebraic offset; the
        // finite part of p is exactly k x.
        for (i, exact) in [x, u, o.k * x].into_iter().enumerate() {
            assert!(
                (y[i] - exact).abs() < 1e-10 * [envelope[0], envelope[1], o.k * envelope[0]][i],
                "t={t} coordinate {i}: {} vs {exact}",
                y[i]
            );
        }
    }
    worst
}

#[test]
fn index_one_oscillator_matches_the_analytic_pencil_with_one_infinite_mode() {
    let mut worst: f64 = 0.;
    for c in [0.6, 30.] {
        let o = Oscillator { c, ..LIGHT };
        let (a, b) = o.pencil();
        let s = spectrum::decompose(3, &a, &b).unwrap();
        assert_eq!(s.infinite.count, 1);
        assert_eq!(s.infinite.algebraic_coordinates, 1);
        assert_eq!(eigenvalues(&s).len(), 2);
        for exact in o.roots() {
            let miss = relative_miss(&eigenvalues(&s), exact);
            worst = worst.max(miss);
            assert!(miss < 1e-10, "c={c}: eigenvalue error {miss:e}");
        }
        assert!(s.modes.iter().all(|m| !m.unstable && !m.marginal));
        assert!(s.infinite.largest_relative_beta.unwrap() <= s.infinite.threshold / s.norm_b);
        assert!(s.infinite.smallest_finite_relative_beta.unwrap() > 1e-3);
        if c < 1. {
            let mode = s.modes[0];
            let zeta = c / (2. * (o.k * o.m).sqrt());
            assert!(mode.pair && mode.lambda.im > 0.);
            assert!((mode.frequency_hz - o.omega_d() / (2. * PI)).abs() < 1e-12);
            assert!((mode.damping_ratio.unwrap() - zeta).abs() < 1e-12);
            assert!((mode.e_fold_s - 2. * o.m / c).abs() < 1e-10);
        } else {
            assert!(
                s.modes
                    .iter()
                    .all(|m| !m.pair && m.frequency_hz == 0. && m.damping_ratio == Some(1.))
            );
            assert!(s.modes[0].lambda.abs() < s.modes[1].lambda.abs());
        }
    }
    eprintln!("oscillator eigenvalue relative error {worst:.1e}");
}

#[test]
fn coupled_oscillators_reproduce_rayleigh_modes_with_biorthonormal_vectors() {
    let m = 1.5;
    let (w1, w2, z1, z2) = (2. * PI, 2. * PI * 1.25, 0.01, 0.02);
    let (k, kc) = (m * w1 * w1, m * (w2 * w2 - w1 * w1) / 2.);
    // Rayleigh C = αM + βK with α/ω_i + βω_i = 2ζ_i for both modes.
    let det = w2 / w1 - w1 / w2;
    let (alpha, beta) = (
        (2. * z1 * w2 - 2. * z2 * w1) / det,
        (2. * z2 / w1 - 2. * z1 / w2) / det,
    );
    let (c11, c12) = (alpha * m + beta * (k + kc), -beta * kc);
    // y = (x1, x2, u1, u2, s): s = kc(x1 − x2) is the algebraic coupling force.
    let a = dense(
        5,
        &[
            (0, 2, -1.),
            (1, 3, -1.),
            (2, 0, k),
            (2, 4, 1.),
            (2, 2, c11),
            (2, 3, c12),
            (3, 1, k),
            (3, 4, -1.),
            (3, 2, c12),
            (3, 3, c11),
            (4, 4, 1.),
            (4, 0, -kc),
            (4, 1, kc),
        ],
    );
    let b = dense(5, &[(0, 0, 1.), (1, 1, 1.), (2, 2, m), (3, 3, m)]);
    let s = spectrum::decompose(5, &a, &b).unwrap();
    assert_eq!((s.infinite.count, s.infinite.algebraic_coordinates), (1, 1));
    assert_eq!(s.modes.len(), 2);
    let mut worst: f64 = 0.;
    for (mode, (w, z)) in s.modes.iter().zip([(w1, z1), (w2, z2)]) {
        let exact = Complex::new(-z * w, w * (1. - z * z).sqrt());
        let miss = (mode.lambda - exact).abs() / exact.abs();
        worst = worst.max(miss);
        assert!(mode.pair && miss < 1e-10, "eigenvalue error {miss:e}");
        assert!((mode.frequency_hz - exact.im / (2. * PI)).abs() < 1e-10);
        assert!((mode.damping_ratio.unwrap() - z).abs() < 1e-10);
        assert!((mode.e_fold_s - 1. / (z * w)).abs() < 1e-8 / (z * w));
        assert!(mode.condition >= 1. && mode.condition < 1e3);
    }
    // w_m^H B v_k = δ_mk over both members of both pairs.
    let members: Vec<(Vec<Complex>, Vec<Complex>)> = s
        .shapes
        .iter()
        .flat_map(|x| {
            let conj = |v: &[Complex]| v.iter().map(|z| z.conj()).collect::<Vec<_>>();
            [
                (x.right.clone(), x.left.clone()),
                (conj(&x.right), conj(&x.left)),
            ]
        })
        .collect();
    let mut identity: f64 = 0.;
    for (i, (_, w)) in members.iter().enumerate() {
        for (j, (v, _)) in members.iter().enumerate() {
            let bv = apply(&b, 5, v);
            let value = inner(w, &bv);
            let target = Complex::new(if i == j { 1. } else { 0. }, 0.);
            let miss = (value - target).abs() / if i == j { 1. } else { norm(w) * norm(&bv) };
            identity = identity.max(miss);
            assert!(miss < 1e-12, "w{i}^H B v{j} = {value:?}");
        }
    }
    let residual = (0..2)
        .flat_map(|m| backward_errors(&a, &b, 5, &s, m))
        .fold(0., f64::max);
    assert!(residual < 1e-14, "backward error {residual:e}");
    eprintln!(
        "coupled eigenvalue relative error {worst:.1e}, biorthonormality {identity:.1e}, backward error {residual:.1e}"
    );
}

#[test]
fn residual_forcing_predicts_the_exact_step_response() {
    let o = LIGHT;
    let (a, b) = o.pencil();
    let s = spectrum::decompose(3, &a, &b).unwrap();
    let tol = spectrum::tolerance(1e-6, &[0.; 3], &[1e-6, 1e-5, 1e-4]).unwrap();
    let f = 3.;
    // A force step enters the momentum row (F1 = m u' + p + c u − f). A spring
    // preload of the algebraic row (F2 = p − k x − p0) acts as a force −p0 and
    // reaches the modes only through the left vector's algebraic component.
    let mut worst: f64 = 0.;
    for (r, force) in [([0., -f, 0.], f), ([0., 0., -f], -f)] {
        let e = s
            .excite(
                Event {
                    kind: Kind::Residual,
                    vector: &r,
                },
                &tol,
            )
            .unwrap();
        let envelope = o.envelope(-force / o.k, 0.);
        worst = worst.max(closed_form(&s, &e, &tol, envelope, |t| o.step(force, t)));
        // Transient and new equilibrium share the amplitude |w^H r/λ|.
        let settled = finite_response(&s, &e, None);
        assert!((settled[0] - force / o.k).abs() < 1e-12 * f / o.k);
    }
    let report = s
        .report(
            &[Event {
                kind: Kind::Residual,
                vector: &[0., -f, 0.],
            }],
            &tol,
        )
        .unwrap();
    eprintln!(
        "step-response envelope relative error {worst:.1e}; report {}",
        report_json(&report)
    );
}

#[test]
fn state_jump_predicts_the_exact_free_response() {
    let o = LIGHT;
    let (a, b) = o.pencil();
    let s = spectrum::decompose(3, &a, &b).unwrap();
    let tol = spectrum::tolerance(1e-4, &[0.02, 0.1, 1.], &[1e-6, 1e-5, 1e-4]).unwrap();
    let mut worst: f64 = 0.;
    // A displaced and a speed-jumped release. The algebraic entry is arbitrary:
    // B annihilates it and the modes carry the consistent p = k x.
    for (dy0, x0, u0) in [([0.01, 0., 7.], 0.01, 0.), ([0., 0.2, -3.], 0., 0.2)] {
        let e = s
            .excite(
                Event {
                    kind: Kind::Jump,
                    vector: &dy0,
                },
                &tol,
            )
            .unwrap();
        worst = worst.max(closed_form(&s, &e, &tol, o.envelope(x0, u0), |t| {
            o.free(x0, u0, t)
        }));
    }
    eprintln!("free-response envelope relative error {worst:.1e}");
}

#[test]
fn a_conserved_inventory_is_marginal_and_never_settles() {
    // x' = u, m u' = −c u + f: x is a free inventory (λ = 0), u decays at −c/m.
    let (m, c) = (2., 0.6);
    let a = dense(2, &[(0, 1, -1.), (1, 1, c)]);
    let b = dense(2, &[(0, 0, 1.), (1, 1, m)]);
    let s = spectrum::decompose(2, &a, &b).unwrap();
    assert_eq!((s.modes.len(), s.infinite.count), (2, 0));
    let (zero, decay) = (s.modes[0], s.modes[1]);
    assert!(zero.marginal && zero.lambda.abs() <= zero.error_bound);
    assert!(zero.e_fold_s > 1e12 && !decay.marginal && !decay.unstable);
    assert!((decay.lambda.re + c / m).abs() < 1e-12 && decay.damping_ratio == Some(1.));
    let tol = [1e-6; 2];
    // A constant force drifts the inventory without bound.
    let push = s
        .excite(
            Event {
                kind: Kind::Residual,
                vector: &[0., -1.],
            },
            &tol,
        )
        .unwrap();
    assert!(push.responses[0].ratio > 1e12 && push.responses[0].settle_s > 1e12);
    assert_eq!(push.dominant, Some(0));
    // A speed jump u0 decays as u0 e^{−ct/m} and leaves x displaced by m u0/c.
    let u0 = 1.;
    let kick = s
        .excite(
            Event {
                kind: Kind::Jump,
                vector: &[0., u0],
            },
            &tol,
        )
        .unwrap();
    let held = m * u0 / c;
    let [x_zero, x_decay, u_decay] = [
        s.shapes[0].right[0].abs() * kick.responses[0].amplitude,
        s.shapes[1].right[0].abs() * kick.responses[1].amplitude,
        s.shapes[1].right[1].abs() * kick.responses[1].amplitude,
    ];
    for (predicted, exact) in [(x_zero, held), (x_decay, held), (u_decay, u0)] {
        assert!((predicted - exact).abs() < 1e-12 * exact);
    }
    assert!(kick.responses[0].settle_s > 1e12);
    let settle = (held / 1e-6).ln() / (c / m);
    assert!((kick.responses[1].settle_s - settle).abs() < 1e-10 * settle);
}

#[test]
fn singular_pencils_and_malformed_arguments_are_refused() {
    // det(A + λB) ≡ 0: A = B shares the null vector (2, −1).
    let shared = dense(2, &[(0, 0, 1.), (0, 1, 2.), (1, 0, 2.), (1, 1, 4.)]);
    assert!(matches!(
        spectrum::decompose(2, &shared, &shared),
        Err(Error::SingularPencil { .. })
    ));
    let lone = dense(2, &[(0, 0, 1.)]);
    assert!(matches!(
        spectrum::decompose(2, &lone, &lone),
        Err(Error::SingularPencil { .. })
    ));
    let argument = |r: Result<Spectrum, Error>| matches!(r, Err(Error::Argument(_)));
    assert!(argument(spectrum::decompose(0, &[], &[])));
    assert!(argument(spectrum::decompose(2, &shared[..3], &shared)));
    let mut bad = shared.clone();
    bad[1] = f64::NAN;
    assert!(argument(spectrum::decompose(2, &bad, &shared)));
    let (a, b) = LIGHT.pencil();
    let s = spectrum::decompose(3, &a, &b).unwrap();
    let excite = |vector: &[f64], tol: &[f64]| {
        matches!(
            s.excite(
                Event {
                    kind: Kind::Residual,
                    vector
                },
                tol
            ),
            Err(Error::Argument(_))
        )
    };
    assert!(excite(&[1., 0.], &[1e-6; 3]));
    assert!(excite(&[f64::INFINITY, 0., 0.], &[1e-6; 3]));
    assert!(excite(&[1., 0., 0.], &[1e-6, 0., 1e-6]));
    assert!(excite(&[1., 0., 0.], &[1e-6, f64::NAN, 1e-6]));
    for refused in [
        spectrum::tolerance(-1., &[0.], &[1.]),
        spectrum::tolerance(1e-6, &[0.], &[0.]),
        spectrum::tolerance(1e-6, &[0., 1.], &[1.]),
        spectrum::tolerance(1e-6, &[f64::NAN], &[1.]),
    ] {
        assert!(matches!(refused, Err(Error::Argument(_))));
    }
}

/// splitmix64: a reproducible pencil without another crate.
struct Random(u64);
impl Random {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    fn uniform(&mut self, low: f64, high: f64) -> f64 {
        low + (high - low) * ((self.next() >> 11) as f64 / (1u64 << 53) as f64)
    }
    fn index(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// A random stable index-1 pencil with plant-like sparsity (about seven
/// entries per row), coordinates interleaved by a symmetric permutation.
/// `Sym(A_dd)` is diagonally dominant with diagonal ≥ 10 (radius ≤ 0.65 of
/// it unless a column draws over ten couplings), skew couplings add
/// oscillation, `B_dd` is SPD and `‖A_da A_aa⁻¹ A_ad‖₂ < 1`. Every finite
/// `μ = v^H S v / v^H B_dd v` of the Schur complement `S` thus has
/// `Re μ > 0`, i.e. `Re λ < 0`, and `A_aa` is nonsingular (index 1).
fn plant_like(n: usize, algebraic: usize, seed: u64) -> (Vec<f64>, Vec<f64>, Vec<bool>) {
    let mut r = Random(seed);
    let d = n - algebraic;
    let at = |i: usize, j: usize| j * n + i;
    let (mut a, mut b) = (vec![0.; n * n], vec![0.; n * n]);
    let diagonal: Vec<f64> = (0..d).map(|_| 10f64.powf(r.uniform(1., 3.))).collect();
    let mass: Vec<f64> = (0..d).map(|_| r.uniform(0.5, 2.)).collect();
    for i in 0..d {
        a[at(i, i)] += diagonal[i];
        b[at(i, i)] += mass[i];
        for _ in 0..3 {
            let j = r.index(d);
            if j != i {
                a[at(i, j)] += r.uniform(-0.1, 0.1) * diagonal[i].min(diagonal[j]);
            }
        }
        for _ in 0..2 {
            let j = r.index(d);
            if j != i {
                let g = r.uniform(-3., 3.) * (diagonal[i] * diagonal[j]).sqrt();
                a[at(i, j)] += g;
                a[at(j, i)] -= g;
            }
        }
        let j = r.index(d);
        if j != i {
            let e = r.uniform(-0.02, 0.02) * mass[i].min(mass[j]);
            b[at(i, j)] += e;
            b[at(j, i)] += e;
        }
    }
    for q in d..n {
        let c = r.uniform(1., 10.);
        a[at(q, q)] += c;
        let other = d + r.index(algebraic);
        if other != q {
            a[at(q, other)] += r.uniform(-0.1, 0.1) * c;
        }
        for _ in 0..3 {
            let j = r.index(d);
            a[at(q, j)] += r.uniform(-1., 1.);
        }
        for _ in 0..2 {
            let i = r.index(d);
            a[at(i, q)] += r.uniform(-0.002, 0.002);
        }
    }
    let mut order: Vec<usize> = (0..n).collect();
    for i in (1..n).rev() {
        order.swap(i, r.index(i + 1));
    }
    let permute = |m: &[f64]| -> Vec<f64> {
        (0..n * n)
            .map(|k| m[at(order[k % n], order[k / n])])
            .collect()
    };
    (
        permute(&a),
        permute(&b),
        order.iter().map(|&o| o >= d).collect(),
    )
}

/// Dense Gaussian elimination with partial pivoting: an independent `A^{-1} x`.
fn solve(n: usize, a: &[f64], rhs: &[f64]) -> Vec<f64> {
    let mut m: Vec<f64> = (0..n * n).map(|k| a[(k % n) * n + k / n]).collect();
    let mut x = rhs.to_vec();
    for col in 0..n {
        let pivot = (col..n)
            .max_by(|&i, &j| m[i * n + col].abs().total_cmp(&m[j * n + col].abs()))
            .unwrap();
        if pivot != col {
            for j in 0..n {
                m.swap(col * n + j, pivot * n + j);
            }
            x.swap(col, pivot);
        }
        let (head, tail) = m.split_at_mut((col + 1) * n);
        let row = &head[col * n..];
        for (offset, below) in tail.chunks_exact_mut(n).enumerate() {
            let factor = below[col] / row[col];
            if factor != 0. {
                for (target, &source) in below[col..].iter_mut().zip(&row[col..]) {
                    *target -= factor * source;
                }
                x[col + 1 + offset] -= factor * x[col];
            }
        }
    }
    for i in (0..n).rev() {
        let tail: f64 = (i + 1..n).map(|j| m[i * n + j] * x[j]).sum();
        x[i] = (x[i] - tail) / m[i * n + i];
    }
    x
}

#[test]
fn plant_sized_random_index_one_pencils_decompose_with_small_residuals() {
    for (n, algebraic, seed) in [(328, 96, 0x1d01_u64), (400, 120, 0x1d02)] {
        let (a, b, is_algebraic) = plant_like(n, algebraic, seed);
        let nonzeros = a.iter().filter(|&&x| x != 0.).count();
        let (mut dggev, mut whole) = (f64::INFINITY, f64::INFINITY);
        let mut decomposed = None;
        for _ in 0..3 {
            let started = Instant::now();
            let s = spectrum::decompose(n, &a, &b).unwrap();
            whole = whole.min(started.elapsed().as_secs_f64());
            dggev = dggev.min(s.dggev_seconds);
            decomposed = Some(s);
        }
        let s = decomposed.unwrap();
        assert_eq!(s.infinite.count, algebraic);
        assert_eq!(s.infinite.algebraic_coordinates, algebraic);
        assert_eq!(eigenvalues(&s).len(), n - algebraic);
        assert!(s.infinite.largest_relative_beta.unwrap() <= s.infinite.threshold / s.norm_b);
        assert!(s.infinite.smallest_finite_relative_beta.unwrap() > 1e-6);
        assert!(
            s.modes
                .iter()
                .all(|m| m.lambda.re < 0. && !m.unstable && !m.marginal)
        );
        assert!(s.modes.iter().any(|m| m.pair));
        let mut residual: f64 = 0.;
        let mut identity: f64 = 0.;
        for (m, shape) in s.shapes.iter().enumerate() {
            residual = backward_errors(&a, &b, n, &s, m)
                .into_iter()
                .fold(residual, f64::max);
            let value = inner(&shape.left, &apply(&b, n, &shape.right));
            identity = identity.max((value - Complex::new(1., 0.)).abs());
        }
        assert!(residual < 1e-12, "n={n}: backward error {residual:e}");
        assert!(identity < 1e-10, "n={n}: w^H B v - 1 = {identity:e}");

        let mut r = Random(seed ^ 0xe5e5);
        let tol = spectrum::tolerance(
            1e-6,
            &(0..n).map(|_| r.uniform(-1., 1.)).collect::<Vec<_>>(),
            &vec![1e-8; n],
        )
        .unwrap();
        // A jump of differential coordinates is the finite modes' t = 0 state.
        let jump: Vec<f64> = is_algebraic
            .iter()
            .map(|&alg| if alg { 0. } else { r.uniform(-1., 1.) })
            .collect();
        // A residual forcing on every row settles at −A⁻¹r on the differential
        // coordinates; the infinite modes carry only algebraic offsets.
        let forcing: Vec<f64> = (0..n).map(|_| r.uniform(-1., 1.)).collect();
        let events = [
            Event {
                kind: Kind::Jump,
                vector: &jump,
            },
            Event {
                kind: Kind::Residual,
                vector: &forcing,
            },
        ];
        let report = s.report(&events, &tol).unwrap();
        let start = finite_response(&s, &report.events[0], Some(0.));
        let settled = finite_response(&s, &report.events[1], None);
        let exact = solve(n, &a, &forcing.iter().map(|x| -x).collect::<Vec<_>>());
        let scale = |v: &[f64]| v.iter().fold(0f64, |m, x| m.max(x.abs()));
        let (mut completeness, mut steady): (f64, f64) = (0., 0.);
        for i in (0..n).filter(|&i| !is_algebraic[i]) {
            completeness = completeness.max((start[i] - jump[i]).abs() / scale(&jump));
            steady = steady.max((settled[i] - exact[i]).abs() / scale(&exact));
        }
        // The finite modes' t = 0 state is consistent: algebraic rows of A δy vanish.
        let consistency = (0..n)
            .filter(|&i| is_algebraic[i])
            .map(|i| (0..n).map(|j| a[j * n + i] * start[j]).sum::<f64>().abs())
            .fold(0., f64::max)
            / (frobenius(&a) * scale(&start));
        assert!(
            completeness < 1e-9,
            "n={n}: jump completeness {completeness:e}"
        );
        assert!(steady < 1e-9, "n={n}: steady response {steady:e}");
        assert!(consistency < 1e-12, "n={n}: consistency {consistency:e}");

        let value = report_json(&report);
        let text = serde_json::to_string(&value).unwrap();
        let back: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(back["infinite"]["count"], algebraic);
        assert_eq!(back["modes"].as_array().unwrap().len(), s.modes.len());
        assert_eq!(back["events"][1]["kind"], "residual");
        let condition = s.modes.iter().map(|m| m.condition).fold(0., f64::max);
        eprintln!(
            "n={n} nnz(A)={nonzeros}: dggev {:.1} ms, decompose {:.1} ms (best of 3, LAPACK {:?}); \
             {} modes ({} finite, {} infinite), |λ| {:.2e}..{:.2e}, max condition {condition:.1e}; \
             backward error {residual:.1e}, w^H B v - 1 {identity:.1e}, jump completeness \
             {completeness:.1e}, steady response {steady:.1e}, consistency {consistency:.1e}; \
             largest infinite |β|/‖B‖ {:e}, smallest finite {:.1e}; max ratio jump {:.2e} \
             residual {:.2e}; report {} bytes",
            dggev * 1e3,
            whole * 1e3,
            s.lapack_version,
            s.modes.len(),
            report.finite,
            report.infinite.count,
            s.modes[0].lambda.abs(),
            s.modes[s.modes.len() - 1].lambda.abs(),
            report.infinite.largest_relative_beta.unwrap(),
            report.infinite.smallest_finite_relative_beta.unwrap(),
            report.events[0].max_ratio,
            report.events[1].max_ratio,
            text.len(),
        );
    }
}

fn complex(z: Complex) -> Value {
    json!({ "re": z.re, "im": z.im })
}

/// A `Report` as JSON; serde_json writes non-finite numbers as null.
fn report_json(r: &Report) -> Value {
    json!({
        "dimension": r.dimension,
        "lapack_version": r.lapack_version,
        "dggev_ms": r.dggev_seconds * 1e3,
        "norm_a": r.norm_a,
        "norm_b": r.norm_b,
        "infinite": {
            "count": r.infinite.count,
            "algebraic_coordinates": r.infinite.algebraic_coordinates,
            "threshold": r.infinite.threshold,
            "largest_relative_beta": r.infinite.largest_relative_beta,
            "smallest_finite_relative_beta": r.infinite.smallest_finite_relative_beta,
        },
        "finite": r.finite,
        "unstable": r.unstable,
        "marginal": r.marginal,
        "modes": r.modes.iter().map(|m| json!({
            "lambda": complex(m.lambda),
            "pair": m.pair,
            "frequency_hz": m.frequency_hz,
            "damping_ratio": m.damping_ratio,
            "e_fold_s": m.e_fold_s,
            "unstable": m.unstable,
            "marginal": m.marginal,
            "error_bound": m.error_bound,
            "condition": m.condition,
        })).collect::<Vec<_>>(),
        "events": r.events.iter().map(|e| json!({
            "kind": match e.kind { Kind::Residual => "residual", Kind::Jump => "jump" },
            "max_ratio": e.max_ratio,
            "dominant": e.dominant,
            "fastest_above_tolerance": e.fastest_above_tolerance,
            "responses": e.responses.iter().map(|x| json!({
                "projection": complex(x.projection),
                "amplitude": x.amplitude,
                "ratio": x.ratio,
                "coordinate": x.coordinate,
                "settle_s": x.settle_s,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
}
