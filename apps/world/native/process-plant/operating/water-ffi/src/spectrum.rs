//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md
//! Zero-time modal diagnostic of one DAE linearization: the generalized
//! eigen-decomposition of its pencil and the modal excitation of a discrete
//! event, compared with the solver tolerance before any trajectory is run.
//! It integrates nothing, owns no physical model and is not another solver.
//!
//! # Pencil
//!
//! Linearizing `F(t, y, y') = 0` at one state gives `A = ∂F/∂y` and
//! `B = ∂F/∂y'`: the IDA Jacobian `∂F/∂y + cj ∂F/∂y'` at `cj = 0`, and its
//! `cj = 1` minus `cj = 0` difference, dense and column-major. A mode
//! `y = v e^{λt}` satisfies `(A + λB) v = 0`, i.e. `A v = μ B v` with
//! `λ = −μ`. Accelerate's maintained LAPACK `dggev` returns `μ = α/β`, right
//! vectors `A v = μ B v` and left vectors `u^H A = μ u^H B`. It applies only
//! permutation balancing; the caller supplies scaled coordinates.
//!
//! # Infinite modes
//!
//! An algebraic row or coordinate makes `B` singular and gives `β = 0`. QZ is
//! normwise backward stable: the computed `(α, β)` are exact for a pencil
//! `(A + E, B + F)` with `‖E‖_F ≲ η‖A‖_F`, `‖F‖_F ≲ η‖B‖_F`, `η = n ε`. A
//! `|β| ≤ η‖B‖_F` is therefore zero within the backward error: the mode is
//! counted as infinite and excluded, its `|λ| ≥ |α|/(η‖B‖_F)` being beyond
//! any resolvable time scale. LAPACK's own deflation sets such a `β` exactly
//! to zero in the ordinary case. If also `|α| ≤ η‖A‖_F`, the eigenvalue is
//! `0/0`: `det(A + λB)` vanishes identically within the backward error, the
//! DAE has no unique solution, and decomposition fails. Identically zero
//! columns of `B` are the structural algebraic coordinates. When they span the
//! null space of `B`, a regular index-1 pencil has exactly that many infinite
//! modes; a larger count discloses a further rank deficiency of `B` (a
//! constraint on differential coordinates) or a higher index.
//!
//! # Finite modes
//!
//! Reported once per real mode or conjugate pair (the member with
//! `Im λ > 0`): `λ`, `|Im λ|/2π` Hz, `ζ = −Re λ/|λ|`, the e-fold time
//! `1/|Re λ|` (infinite at `Re λ = 0`) and `Re λ > 0` (unstable). The
//! first-order perturbation bound `|δλ| ≤ η(‖A‖_F + |λ|‖B‖_F)‖w‖₂‖v‖₂` marks
//! a mode marginal when it covers `Re λ`: its sign is then unresolved at
//! working precision, as for an exactly conserved inventory with `λ = 0`.
//! `‖w‖₂‖Bv‖₂ ≥ 1`, the secant of the angle between `w` and `Bv`, measures
//! how far the modal coordinate amplifies; it diverges for a defective mode.
//!
//! # Event excitation
//!
//! With `w = u/conj(u^H B v)`: `w^H B v = 1`, `w^H A = μ w^H B`, and
//! `w_m^H B v_k = 0` for every other finite or infinite eigenvalue. The modal
//! coordinate `q_m = w_m^H B δy` therefore decouples:
//!
//! - (a) a residual forcing `r`, the change of `F` at the event with the
//!   state unchanged, gives `A δy + B δy' + r = 0`, so
//!   `q_m' = λ_m q_m − w_m^H r` with `q_m(0) = 0`, i.e.
//!   `q_m(t) = (w_m^H r/λ_m)(1 − e^{λ_m t})`: transient amplitude
//!   `|w_m^H r/λ_m|`, an unbounded drift `−(w_m^H r) t` at `λ_m = 0`;
//! - (b) a jump `dy0` of differential coordinates gives
//!   `q_m(t) = q_m(0) e^{λ_m t}` with `q_m(0) = w_m^H B dy0`.
//!
//! A real mode adds `v_m q_m` to `δy`; a conjugate pair adds `2 Re(v_m q_m)`,
//! whose envelope on coordinate `i` is `2|v_{m,i}||q_m|`. The excitation
//! ratio is `max_i envelope_i/tol_i` with the caller's
//! `tol_i = rtol|y_i| + atol_i` in the pencil's coordinates, together with its
//! argmax coordinate. The instantaneous algebraic response of the infinite
//! modes belongs to consistent reinitialization and is not reported here.

use std::{
    f64::consts::PI,
    ffi::c_char,
    fmt,
    ops::{Add, Div, Mul, Neg, Sub},
    time::Instant,
};

#[link(name = "Accelerate", kind = "framework")]
unsafe extern "C" {
    // Accelerate's maintained LAPACK with 64-bit integers: the `dggev_` that
    // lapack.h declares under ACCELERATE_NEW_LAPACK + ACCELERATE_LAPACK_ILP64.
    // The deprecated legacy CLAPACK export `dggev_` is not used.
    #[link_name = "dggev$NEWLAPACK$ILP64"]
    fn dggev(
        jobvl: *const c_char,
        jobvr: *const c_char,
        n: *const i64,
        a: *mut f64,
        lda: *const i64,
        b: *mut f64,
        ldb: *const i64,
        alphar: *mut f64,
        alphai: *mut f64,
        beta: *mut f64,
        vl: *mut f64,
        ldvl: *const i64,
        vr: *mut f64,
        ldvr: *const i64,
        work: *mut f64,
        lwork: *const i64,
        info: *mut i64,
    );
    #[link_name = "ilaver$NEWLAPACK$ILP64"]
    fn ilaver(major: *mut i64, minor: *mut i64, patch: *mut i64);
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Complex {
    pub re: f64,
    pub im: f64,
}
impl Complex {
    pub const fn new(re: f64, im: f64) -> Self {
        Self { re, im }
    }
    pub fn conj(self) -> Self {
        Self::new(self.re, -self.im)
    }
    pub fn abs(self) -> f64 {
        self.re.hypot(self.im)
    }
    pub fn exp(self) -> Self {
        let magnitude = self.re.exp();
        Self::new(magnitude * self.im.cos(), magnitude * self.im.sin())
    }
}
impl Add for Complex {
    type Output = Self;
    fn add(self, other: Self) -> Self {
        Self::new(self.re + other.re, self.im + other.im)
    }
}
impl Sub for Complex {
    type Output = Self;
    fn sub(self, other: Self) -> Self {
        Self::new(self.re - other.re, self.im - other.im)
    }
}
impl Mul for Complex {
    type Output = Self;
    fn mul(self, other: Self) -> Self {
        Self::new(
            self.re * other.re - self.im * other.im,
            self.re * other.im + self.im * other.re,
        )
    }
}
impl Mul<f64> for Complex {
    type Output = Self;
    fn mul(self, scale: f64) -> Self {
        Self::new(self.re * scale, self.im * scale)
    }
}
impl Div for Complex {
    type Output = Self;
    /// Smith's division: no intermediate overflow from squaring the divisor.
    fn div(self, d: Self) -> Self {
        if d.re.abs() >= d.im.abs() {
            let r = d.im / d.re;
            let s = d.re + d.im * r;
            Self::new((self.re + self.im * r) / s, (self.im - self.re * r) / s)
        } else {
            let r = d.re / d.im;
            let s = d.re * r + d.im;
            Self::new((self.re * r + self.im) / s, (self.im * r - self.re) / s)
        }
    }
}
impl Neg for Complex {
    type Output = Self;
    fn neg(self) -> Self {
        Self::new(-self.re, -self.im)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    /// Dimension, finiteness or tolerance of a caller argument.
    Argument(&'static str),
    /// `dggev` INFO: negative for an argument, 1..=n when QZ did not converge,
    /// n+1 for another DHGEQZ failure, n+2 for a DTGEVC failure.
    Lapack { info: i64 },
    /// A conjugate pair broke the documented `dggev` column layout.
    PairLayout { index: usize },
    /// `α` and `β` both vanish within the backward error: `det(A + λB) ≡ 0`.
    SingularPencil { index: usize },
    /// `u^H B v` vanished: no biorthonormal modal coordinate exists.
    Defective { index: usize },
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "operating spectrum: {self:?}")
    }
}
impl std::error::Error for Error {}

/// Classification evidence of the infinite modes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Infinite {
    /// Infinite eigenvalues (`|β| ≤ threshold`).
    pub count: usize,
    /// Identically zero columns of `B`; equals `count` for a regular index-1
    /// pencil whose null space of `B` they span.
    pub algebraic_coordinates: usize,
    /// `n ε ‖B‖_F`.
    pub threshold: f64,
    /// Largest `|β|/‖B‖_F` classified infinite; `None` without infinite modes.
    pub largest_relative_beta: Option<f64>,
    /// Smallest `|β|/‖B‖_F` classified finite; `None` without finite modes.
    pub smallest_finite_relative_beta: Option<f64>,
}

/// One finite real mode or conjugate pair.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mode {
    /// `(A + λB) v = 0`; for a pair the member with `Im λ > 0`.
    pub lambda: Complex,
    pub pair: bool,
    pub frequency_hz: f64,
    /// `−Re λ/|λ|`; `None` only at `λ = 0`.
    pub damping_ratio: Option<f64>,
    /// `1/|Re λ|`, infinite at `Re λ = 0`.
    pub e_fold_s: f64,
    /// `Re λ > 0`.
    pub unstable: bool,
    /// `|Re λ| ≤ error_bound`: the sign of `Re λ` is unresolved.
    pub marginal: bool,
    /// `n ε (‖A‖_F + |λ|‖B‖_F)‖w‖₂‖v‖₂`, first order in the QZ backward error.
    pub error_bound: f64,
    /// `‖w‖₂‖Bv‖₂ ≥ 1`.
    pub condition: f64,
}

/// Vectors of one `Mode`, in the pencil's coordinates.
#[derive(Clone, Debug)]
pub struct Shape {
    /// `v` with the `dggev` scaling: the largest `|Re| + |Im|` is one.
    pub right: Vec<Complex>,
    /// `w` with `w^H (A + λB) = 0` and `w^H B v = 1`.
    pub left: Vec<Complex>,
}

#[derive(Clone, Debug)]
pub struct Spectrum {
    pub dimension: usize,
    /// Accelerate's LAPACK version from `ilaver`.
    pub lapack_version: [i64; 3],
    /// Wall time inside `dggev` (workspace query and decomposition).
    pub dggev_seconds: f64,
    pub norm_a: f64,
    pub norm_b: f64,
    pub infinite: Infinite,
    /// Finite modes in ascending `|λ|`, a conjugate pair once.
    pub modes: Vec<Mode>,
    /// `shapes[m]` belongs to `modes[m]`.
    pub shapes: Vec<Shape>,
    b: Vec<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// `vector = r`: the change of `F` at the event with the state unchanged.
    Residual,
    /// `vector = dy0`: the jump of differential coordinates. `B` annihilates
    /// algebraic entries; their consistent values follow from the modes.
    Jump,
}

#[derive(Clone, Copy, Debug)]
pub struct Event<'a> {
    pub kind: Kind,
    pub vector: &'a [f64],
}

/// Response of one `Mode` to one event.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Response {
    /// `w^H r` (residual: `q(t) = (w^H r/λ)(1 − e^{λt})`) or `w^H B dy0`
    /// (jump: `q(t) = q(0) e^{λt}`).
    pub projection: Complex,
    /// Modal transient amplitude: `|w^H r/λ|` or `|w^H B dy0|`.
    pub amplitude: f64,
    /// `max_i envelope_i/tol_i`, envelope `k|v_i| amplitude` (`k = 2` for a pair).
    pub ratio: f64,
    /// The argmax coordinate of `ratio`.
    pub coordinate: usize,
    /// Time for the envelope to fall below tolerance: `ln(ratio)/(−Re λ)`;
    /// zero when `ratio ≤ 1`, infinite when it never decays.
    pub settle_s: f64,
}

#[derive(Clone, Debug)]
pub struct Excitation {
    pub kind: Kind,
    /// `responses[m]` belongs to `Spectrum::modes[m]`.
    pub responses: Vec<Response>,
    /// Largest ratio and its mode; zero and `None` without finite modes.
    pub max_ratio: f64,
    pub dominant: Option<usize>,
    /// The mode of largest `|λ|` among those with `ratio > 1`.
    pub fastest_above_tolerance: Option<usize>,
}

/// Plain summary of one diagnostic, without vectors, for serialization.
#[derive(Clone, Debug)]
pub struct Report {
    pub dimension: usize,
    pub lapack_version: [i64; 3],
    pub dggev_seconds: f64,
    pub norm_a: f64,
    pub norm_b: f64,
    pub infinite: Infinite,
    /// Finite eigenvalues, both members of a pair counted.
    pub finite: usize,
    /// Reported modes (a pair once) flagged `unstable`.
    pub unstable: usize,
    /// Reported modes (a pair once) flagged `marginal`.
    pub marginal: usize,
    pub modes: Vec<Mode>,
    /// In the order of the events given to `Spectrum::report`.
    pub events: Vec<Excitation>,
}

/// `rtol |y_i| + atol_i`: the denominator of IDA's error weight.
pub fn tolerance(relative: f64, y: &[f64], absolute: &[f64]) -> Result<Vec<f64>, Error> {
    if !(relative.is_finite() && relative >= 0.)
        || y.len() != absolute.len()
        || y.iter().any(|v| !v.is_finite())
        || absolute.iter().any(|a| !(a.is_finite() && *a > 0.))
    {
        return Err(Error::Argument(
            "tolerance needs rtol >= 0, finite y and positive atol of equal length",
        ));
    }
    Ok(y.iter()
        .zip(absolute)
        .map(|(y, a)| relative * y.abs() + a)
        .collect())
}

/// Decompose the pencil of dense column-major `n x n` `A = ∂F/∂y`, `B = ∂F/∂y'`.
pub fn decompose(n: usize, a: &[f64], b: &[f64]) -> Result<Spectrum, Error> {
    let size = n
        .checked_mul(n)
        .filter(|&size| n > 0 && a.len() == size && b.len() == size)
        .ok_or(Error::Argument(
            "pencil must be two dense column-major n x n arrays",
        ))?;
    if a.iter().chain(b).any(|v| !v.is_finite()) {
        return Err(Error::Argument("pencil entries must be finite"));
    }
    let order = i64::try_from(n)
        .ok()
        .filter(|order| order.checked_mul(8).is_some())
        .ok_or(Error::Argument("pencil dimension exceeds LAPACK indices"))?;
    let norm_a = frobenius(a);
    let norm_b = frobenius(b);
    let (mut s, mut t) = (a.to_vec(), b.to_vec());
    let (mut alphar, mut alphai, mut beta) = (vec![0.; n], vec![0.; n], vec![0.; n]);
    let (mut vl, mut vr) = (vec![0.; size], vec![0.; size]);
    let job = b'V' as c_char;
    let mut info = 0;
    let started = Instant::now();
    let mut call = |work: &mut [f64], lwork: i64, info: &mut i64| {
        // SAFETY: Accelerate's ILP64 dggev reads `n`, the four leading
        // dimensions (all `n`) and `lwork` through references to live locals,
        // reads the single ASCII job bytes, and reads/writes only the unique
        // n x n column-major A/B/VL/VR buffers, the three length-n eigenvalue
        // buffers and `work`, whose length is at least `lwork` (one for the
        // query). It keeps no pointer and allocates nothing the caller frees.
        unsafe {
            dggev(
                &job,
                &job,
                &order,
                s.as_mut_ptr(),
                &order,
                t.as_mut_ptr(),
                &order,
                alphar.as_mut_ptr(),
                alphai.as_mut_ptr(),
                beta.as_mut_ptr(),
                vl.as_mut_ptr(),
                &order,
                vr.as_mut_ptr(),
                &order,
                work.as_mut_ptr(),
                &lwork,
                info,
            )
        }
    };
    let mut optimal = [0.];
    call(&mut optimal, -1, &mut info);
    if info != 0 {
        return Err(Error::Lapack { info });
    }
    if !(optimal[0].is_finite() && optimal[0] >= 1. && optimal[0] < i64::MAX as f64) {
        return Err(Error::Argument("dggev workspace query out of range"));
    }
    let lwork = (optimal[0].ceil() as i64).max(8 * order);
    let mut work = vec![0.; usize::try_from(lwork).expect("positive workspace")];
    call(&mut work, lwork, &mut info);
    let dggev_seconds = started.elapsed().as_secs_f64();
    if info != 0 {
        return Err(Error::Lapack { info });
    }

    let eta = n as f64 * f64::EPSILON;
    let threshold = eta * norm_b;
    let relative = |k: usize| {
        if norm_b > 0. {
            beta[k].abs() / norm_b
        } else {
            0.
        }
    };
    let column = |m: &[f64], k: usize| (k * n..(k + 1) * n).map(|i| m[i]).collect::<Vec<_>>();
    let mut infinite = 0;
    let mut largest_infinite: Option<f64> = None;
    let mut smallest_finite: Option<f64> = None;
    let mut found = Vec::new();
    let mut j = 0;
    while j < n {
        let pair = alphai[j] != 0.;
        let small = |k: usize| beta[k].abs() <= threshold;
        if pair && !(alphai[j] > 0. && j + 1 < n && alphai[j + 1] < 0. && small(j) == small(j + 1))
        {
            return Err(Error::PairLayout { index: j });
        }
        let members = j..j + 1 + usize::from(pair);
        if small(j) {
            if Complex::new(alphar[j], alphai[j]).abs() <= eta * norm_a {
                return Err(Error::SingularPencil { index: j });
            }
            infinite += members.len();
            for k in members {
                largest_infinite =
                    Some(largest_infinite.map_or(relative(k), |x| x.max(relative(k))));
            }
            j += 1 + usize::from(pair);
            continue;
        }
        for k in members {
            smallest_finite = Some(smallest_finite.map_or(relative(k), |x| x.min(relative(k))));
        }
        // Column j holds μ_j = α_j/β_j with v_j = VR_j + i VR_{j+1}; its
        // conjugate member is VR_j − i VR_{j+1}. Report the λ = −μ with Im λ > 0.
        let mu = Complex::new(alphar[j] / beta[j], alphai[j] / beta[j]);
        let sign = if mu.im > 0. { -1. } else { 1. };
        let lambda = -Complex::new(mu.re, sign * mu.im);
        let vector = |real: Vec<f64>, imaginary: Option<Vec<f64>>| -> Vec<Complex> {
            match imaginary {
                Some(imaginary) => real
                    .iter()
                    .zip(&imaginary)
                    .map(|(&re, &im)| Complex::new(re, sign * im))
                    .collect(),
                None => real.iter().map(|&re| Complex::new(re, 0.)).collect(),
            }
        };
        let imaginary = |m: &[f64]| pair.then(|| column(m, j + 1));
        let right = vector(column(&vr, j), imaginary(&vr));
        let u = vector(column(&vl, j), imaginary(&vl));
        let bv = vector(
            product(b, n, &column(&vr, j)),
            pair.then(|| product(b, n, &column(&vr, j + 1))),
        );
        let scale = inner(&u, &bv);
        if !(scale.abs() > 0. && scale.abs().is_finite()) {
            return Err(Error::Defective { index: j });
        }
        let left: Vec<Complex> = u.iter().map(|&x| x / scale.conj()).collect();
        let (norm_w, norm_v, norm_bv) = (norm(&left), norm(&right), norm(&bv));
        let magnitude = lambda.abs();
        let error_bound = eta * (norm_a + magnitude * norm_b) * norm_w * norm_v;
        found.push((
            Mode {
                lambda,
                pair,
                frequency_hz: lambda.im.abs() / (2. * PI),
                damping_ratio: (magnitude > 0.).then(|| -lambda.re / magnitude),
                e_fold_s: 1. / lambda.re.abs(),
                unstable: lambda.re > 0.,
                marginal: lambda.re.abs() <= error_bound,
                error_bound,
                condition: norm_w * norm_bv,
            },
            Shape { right, left },
        ));
        j += 1 + usize::from(pair);
    }
    found.sort_by(|(x, _), (y, _)| {
        x.lambda
            .abs()
            .total_cmp(&y.lambda.abs())
            .then(x.lambda.im.total_cmp(&y.lambda.im))
            .then(x.lambda.re.total_cmp(&y.lambda.re))
    });
    let (modes, shapes) = found.into_iter().unzip();
    let mut version = [0; 3];
    let [major, minor, patch] = &mut version;
    // SAFETY: ilaver writes one integer through each pointer to a live local.
    unsafe { ilaver(major, minor, patch) };
    Ok(Spectrum {
        dimension: n,
        lapack_version: version,
        dggev_seconds,
        norm_a,
        norm_b,
        infinite: Infinite {
            count: infinite,
            algebraic_coordinates: b
                .chunks_exact(n)
                .filter(|column| column.iter().all(|&x| x == 0.))
                .count(),
            threshold,
            largest_relative_beta: largest_infinite,
            smallest_finite_relative_beta: smallest_finite,
        },
        modes,
        shapes,
        b: b.to_vec(),
    })
}

impl Spectrum {
    /// Modal excitation of one event against `tolerance` (see [`tolerance`]).
    pub fn excite(&self, event: Event<'_>, tolerance: &[f64]) -> Result<Excitation, Error> {
        let n = self.dimension;
        if event.vector.len() != n || tolerance.len() != n {
            return Err(Error::Argument(
                "event and tolerance need the pencil dimension",
            ));
        }
        if event.vector.iter().any(|v| !v.is_finite()) {
            return Err(Error::Argument("event entries must be finite"));
        }
        if tolerance.iter().any(|t| !(t.is_finite() && *t > 0.)) {
            return Err(Error::Argument("tolerances must be finite and positive"));
        }
        let forcing = match event.kind {
            Kind::Residual => event.vector.to_vec(),
            Kind::Jump => product(&self.b, n, event.vector),
        };
        let responses: Vec<Response> = self
            .modes
            .iter()
            .zip(&self.shapes)
            .map(|(mode, shape)| {
                let projection = shape
                    .left
                    .iter()
                    .zip(&forcing)
                    .fold(Complex::default(), |sum, (w, &x)| sum + w.conj() * x);
                let amplitude = match event.kind {
                    Kind::Jump => projection.abs(),
                    Kind::Residual if projection.abs() == 0. => 0.,
                    // |λ| = 0 with a nonzero projection is an unbounded drift.
                    Kind::Residual => projection.abs() / mode.lambda.abs(),
                };
                // max_i |v_i|/tol_i > 0: the dggev scaling keeps a component
                // with |Re| + |Im| = 1, so a zero or infinite amplitude stays exact.
                let (coordinate, sensitivity) =
                    argmax(shape.right.iter().zip(tolerance).map(|(v, t)| v.abs() / t))
                        .expect("a pencil has at least one coordinate");
                let ratio = if mode.pair { 2. } else { 1. } * amplitude * sensitivity;
                let settle_s = if ratio <= 1. {
                    0.
                } else if mode.lambda.re < 0. {
                    ratio.ln() / -mode.lambda.re
                } else {
                    f64::INFINITY
                };
                Response {
                    projection,
                    amplitude,
                    ratio,
                    coordinate,
                    settle_s,
                }
            })
            .collect();
        let dominant = argmax(responses.iter().map(|r| r.ratio));
        let fastest_above_tolerance = (0..responses.len())
            .filter(|&m| responses[m].ratio > 1.)
            .reduce(|best, m| {
                if self.modes[m].lambda.abs() > self.modes[best].lambda.abs() {
                    m
                } else {
                    best
                }
            });
        Ok(Excitation {
            kind: event.kind,
            max_ratio: dominant.map_or(0., |(_, ratio)| ratio),
            dominant: dominant.map(|(m, _)| m),
            fastest_above_tolerance,
            responses,
        })
    }

    /// Excite every event against one tolerance and summarize without vectors.
    pub fn report(&self, events: &[Event<'_>], tolerance: &[f64]) -> Result<Report, Error> {
        let events = events
            .iter()
            .map(|&event| self.excite(event, tolerance))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Report {
            dimension: self.dimension,
            lapack_version: self.lapack_version,
            dggev_seconds: self.dggev_seconds,
            norm_a: self.norm_a,
            norm_b: self.norm_b,
            infinite: self.infinite,
            finite: self.dimension - self.infinite.count,
            unstable: self.modes.iter().filter(|m| m.unstable).count(),
            marginal: self.modes.iter().filter(|m| m.marginal).count(),
            modes: self.modes.clone(),
            events,
        })
    }
}

/// First index of the largest of NaN-free values.
fn argmax(values: impl Iterator<Item = f64>) -> Option<(usize, f64)> {
    values.enumerate().fold(None, |best, (i, x)| match best {
        Some((_, top)) if top >= x => best,
        _ => Some((i, x)),
    })
}

/// Overflow-safe Frobenius norm.
fn frobenius(m: &[f64]) -> f64 {
    let scale = m.iter().fold(0f64, |s, x| s.max(x.abs()));
    if scale == 0. {
        return 0.;
    }
    scale * m.iter().map(|x| (x / scale).powi(2)).sum::<f64>().sqrt()
}

fn norm(x: &[Complex]) -> f64 {
    x.iter()
        .map(|z| z.re * z.re + z.im * z.im)
        .sum::<f64>()
        .sqrt()
}

/// `u^H x`.
fn inner(u: &[Complex], x: &[Complex]) -> Complex {
    u.iter()
        .zip(x)
        .fold(Complex::default(), |sum, (&u, &x)| sum + u.conj() * x)
}

/// Dense column-major `M x`.
fn product(matrix: &[f64], n: usize, x: &[f64]) -> Vec<f64> {
    let mut out = vec![0.; n];
    for (column, &xk) in matrix.chunks_exact(n).zip(x) {
        if xk != 0. {
            for (o, &m) in out.iter_mut().zip(column) {
                *o += m * xk;
            }
        }
    }
    out
}
