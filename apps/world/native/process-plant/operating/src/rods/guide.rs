//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/control-absorber-and-guide-water.md#finite-guide-water-force-and-heat-interfaces
//! The guide-passage laws of one cluster's 24 bores, evaluated on the
//! actual signed current and donor water with one current direction.
//!
//! A seated guide runs from its lower mouth to its upper mouth. Below the
//! body tips the bores are clear (Churchill Darcy with the 2 um roughness);
//! from the tips to the upper mouth each body moves inside its bore (the
//! exact concentric moving-inner-wall solution). Each open mouth has its
//! selected dimensionless loss on the local area. The annulus applies the
//! selected enhancement `chi = max(1, f(Re) Re / C_ann)` to the exact laminar
//! gradient and wall traction alike, `chi = 1` at zero motion. Nothing is
//! floored or clipped; the only branch points are the selected ones (the
//! `chi` maximum and the current's sign through `|m|`), each evaluated on
//! its value with the one-sided direction of the selected branch.
use crate::thermal::Scalar;
use std::f64::consts::PI;

pub(super) fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn ln(x: Scalar) -> Scalar {
    Scalar::new(x.value.ln(), x.direction / x.value)
}
/// `ln|x|` with its direction, for `x != 0`.
fn ln_abs(x: Scalar) -> Scalar {
    Scalar::new(x.value.abs().ln(), x.direction / x.value)
}
fn exp(x: Scalar) -> Scalar {
    let e = x.value.exp();
    Scalar::new(e, e * x.direction)
}
fn sqrt(x: Scalar) -> Scalar {
    let r = x.value.sqrt();
    Scalar::new(r, 0.5 * x.direction / r)
}
/// `x|x|` with its direction `2|x| dx` (smooth through zero).
pub(super) fn signed_square(x: Scalar) -> Scalar {
    Scalar::new(x.value * x.value.abs(), 2. * x.value.abs() * x.direction)
}
/// `|x|` away from zero; at zero the caller's branch never reads it.
fn abs(x: Scalar) -> Scalar {
    if x.value < 0. { -x } else { x }
}
/// `ln(e^a + e^b)` without overflow; `-inf` is an absent term.
fn log_add(a: Scalar, b: Scalar) -> Scalar {
    if a.value == f64::NEG_INFINITY {
        return b;
    }
    if b.value == f64::NEG_INFINITY {
        return a;
    }
    let (hi, lo) = if a.value >= b.value { (a, b) } else { (b, a) };
    hi + ln(s(1.) + exp(lo - hi))
}

/// Below this Reynolds number Churchill's turbulent terms are below 1e-22 of
/// its laminar `64/Re` term for any roughness, so the exact laminar law is
/// evaluated there: an identity of the formula at f64, not a model switch.
pub(super) const LAMINAR_IDENTITY_RE: f64 = 500.;

/// Churchill's Darcy factor `f(Re, eps/D)` with the circular `64/Re` laminar
/// term, in the log domain of the selected surge-route implementation.
pub(super) fn log_darcy(re: Scalar, relative_roughness: f64) -> Scalar {
    let log_re = ln(re);
    let roughness = if relative_roughness > 0. {
        s((0.27 * relative_roughness).ln())
    } else {
        s(f64::NEG_INFINITY)
    };
    let term = log_add(s(0.9) * (s(7_f64.ln()) - log_re), roughness);
    let log_a = if term.value == 0. {
        s(f64::NEG_INFINITY)
    } else {
        s(16.) * ln_abs(s(-2.457) * term)
    };
    let log_b = s(16.) * (s(37530_f64.ln()) - log_re);
    s(8_f64.ln())
        + log_add(
            s(12.) * (s(8_f64.ln()) - log_re),
            s(-1.5) * log_add(log_a, log_b),
        ) / s(12.)
}

/// Fixed annular factors of one cluster's guide bores around their bodies.
#[derive(Clone, Copy, Debug)]
pub struct Annulus {
    /// Total annular area of the bores, m2.
    pub area: f64,
    /// Wall-driven mobility `Q = B v + C_q G`, m2.
    pub couette: f64,
    /// Wall shear coefficient of the moving inner wall, per unit length.
    pub shear: f64,
    /// Pressure conductance times viscosity, m4.
    pub conductance: f64,
    pub hydraulic_diameter: f64,
    /// Exact laminar Darcy shape `C_ann` of the concentric annulus.
    pub laminar_darcy: f64,
}
impl Annulus {
    /// The exact concentric moving-inner-wall factors without thin-gap
    /// cancellation, `n` identical bores.
    pub fn new(outer: f64, inner: f64, n: f64) -> Result<Self, String> {
        if ![outer, inner, n].iter().all(|v| v.is_finite())
            || !(outer > inner && inner > 0. && n > 0.)
        {
            return Err("invalid guide annulus geometry".into());
        }
        let eta = ((outer - inner) / inner).ln_1p();
        let e2 = (2. * eta).exp();
        let shape = if eta < 1e-3 {
            let z = eta * eta;
            4. * inner.powi(4)
                * e2
                * eta.powi(3)
                * (1. / 3. + z * (4. / 45. + z * (1. / 105. + z * 8. / 14175.)))
        } else {
            outer.powi(4) - inner.powi(4) - ((outer - inner) * (outer + inner)).powi(2) / eta
        };
        let couette = if eta < 1e-3 {
            inner
                * inner
                * eta
                * (1.
                    + eta
                        * (2. / 3.
                            + eta
                                * (1. / 3.
                                    + eta * (2. / 15. + eta * (2. / 45. + eta * 4. / 315.)))))
        } else {
            inner * inner * ((2. * eta).exp_m1() / (2. * eta) - 1.)
        };
        let dh = 2. * (outer - inner);
        let a = Self {
            area: n * PI * (outer - inner) * (outer + inner),
            couette: n * PI * couette,
            shear: n * 2. * PI / eta,
            conductance: n * PI * shape / 8.,
            hydraulic_diameter: dh,
            laminar_darcy: 16. * (outer - inner) * (outer + inner) * dh * dh / shape,
        };
        if ![a.area, a.couette, a.shear, a.conductance, a.laminar_darcy]
            .iter()
            .all(|v| v.is_finite() && *v > 0.)
        {
            return Err("unrepresentable guide annulus mobility".into());
        }
        Ok(a)
    }
}

/// One annulus evaluation (positive upward current and wall force).
#[derive(Clone, Copy, Debug)]
pub struct AnnulusFlow {
    /// Pressure drop over the annulus less its hydrostatic head, including
    /// the upper mouth, Pa.
    pub loss: Scalar,
    /// Fluid traction on the bodies' walls, N, upward positive.
    pub wall_force: Scalar,
    pub chi: Scalar,
    /// Positive enhanced annulus dissipation of the wall-driven and
    /// pressure-driven flow, W (diagnostic).
    pub dissipation: Scalar,
}

/// One cluster's 24 guide bores: clear below the tips, annular around the
/// bodies above them, with their mouths.
#[derive(Clone, Copy, Debug)]
pub struct Passage {
    pub annulus: Annulus,
    /// Total clear area of the bores, m2, and one bore's diameter, m.
    pub clear_area: f64,
    pub bore_diameter: f64,
    pub roughness: f64,
    pub lower_mouth_loss: f64,
    pub upper_mouth_loss: f64,
}

impl Passage {
    /// The moving annulus of `length` (m) at mass current `m` (kg/s), body
    /// speed `v` (m/s) and donor water `rho, mu`, with the upper mouth.
    pub fn annulus(
        &self,
        m: Scalar,
        v: Scalar,
        rho: Scalar,
        mu: Scalar,
        length: Scalar,
    ) -> AnnulusFlow {
        let a = &self.annulus;
        let q = m / rho;
        // Q = B v + (C_q0/mu) G: invert for the laminar driving gradient.
        let gradient = (q - s(a.couette) * v) * mu / s(a.conductance);
        let wall = length * (s(a.couette) * gradient - s(a.shear) * mu * v);
        let dissipation =
            length * (s(a.conductance) / mu * gradient * gradient + s(a.shear) * mu * v * v);
        let u = q / s(a.area);
        let speed_squared = (u * u + (u - v) * (u - v)) * s(0.5);
        let scale = rho * s(a.hydraulic_diameter) / mu;
        let re_squared = speed_squared * scale * scale;
        let chi = if re_squared.value < LAMINAR_IDENTITY_RE * LAMINAR_IDENTITY_RE {
            // f = 64/Re there, so f Re / C_ann = 64 / C_ann < 1 for any annulus.
            s(1.)
        } else {
            let re = sqrt(re_squared);
            let raw =
                exp(log_darcy(re, self.roughness / a.hydraulic_diameter)) * re / s(a.laminar_darcy);
            if raw.value > 1. { raw } else { s(1.) }
        };
        let mouth_loss =
            s(self.upper_mouth_loss) * signed_square(m) / (s(2.) * rho * s(a.area * a.area));
        AnnulusFlow {
            loss: chi * gradient * length + mouth_loss,
            wall_force: chi * wall,
            chi,
            dissipation: chi * dissipation + mouth_loss * q,
        }
    }

    /// The clear bores below the tips over `length` (m), with the lower
    /// mouth, at mass current `m`: pressure drop less hydrostatic head, Pa.
    pub fn clear(&self, m: Scalar, rho: Scalar, mu: Scalar, length: Scalar) -> Scalar {
        let (area, diameter) = (self.clear_area, self.bore_diameter);
        let dynamic = signed_square(m) / (s(2.) * rho * s(area * area));
        let re_value = m.value.abs() * diameter / (area * mu.value);
        let friction = if re_value < LAMINAR_IDENTITY_RE {
            // 64/Re (L/D) m|m|/(2 rho A^2) = 32 mu L m / (rho A D^2).
            s(32.) * mu * length * m / (rho * s(area * diameter * diameter))
        } else {
            let re = abs(m) * s(diameter / area) / mu;
            exp(log_darcy(re, self.roughness / diameter)) * length / s(diameter) * dynamic
        };
        friction + s(self.lower_mouth_loss) * dynamic
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn d(v: f64, dir: f64) -> Scalar {
        Scalar::new(v, dir)
    }
    fn passage(mouth: f64) -> Passage {
        Passage {
            annulus: Annulus::new(0.0055, 0.00475, 24.).unwrap(),
            clear_area: 24. * PI * 0.0055 * 0.0055,
            bore_diameter: 0.011,
            roughness: 2e-6,
            lower_mouth_loss: mouth,
            upper_mouth_loss: mouth,
        }
    }
    #[test]
    fn churchill_is_the_reviewed_laminar_and_turbulent_law() {
        // Laminar identity at the switch and the smooth-pipe turbulent limit.
        let f = exp(log_darcy(s(LAMINAR_IDENTITY_RE), 2e-6 / 0.011)).value;
        assert!((f * LAMINAR_IDENTITY_RE / 64. - 1.).abs() < 1e-14);
        let turbulent = exp(log_darcy(s(1e5), 0.)).value;
        assert!((turbulent - 0.0180).abs() < 4e-4, "{turbulent}");
        // Exact direction against a central difference in Re.
        let re = d(8500., 1.);
        let g = log_darcy(re, 1.8e-4);
        let h = 1e-3;
        let fd = (log_darcy(s(8500. + h), 1.8e-4).value - log_darcy(s(8500. - h), 1.8e-4).value)
            / (2. * h);
        assert!((g.direction - fd).abs() < 1e-8 * fd.abs());
    }
    #[test]
    fn the_annulus_is_reciprocal_and_dissipative_in_every_quadrant() {
        let p = passage(0.);
        for m in [-1.4, -0.2, 0., 0.3, 1.3] {
            for v in [-2., -0.5, 0., 0.4] {
                let r = p.annulus(s(m), s(v), s(745.7), s(9.2e-5), s(4.));
                // Pressure work of the current less the wall work on the body
                // is the positive dissipation.
                let work = r.loss.value * m / 745.7 - r.wall_force.value * v;
                assert!(r.dissipation.value >= 0.);
                assert!(
                    (work - r.dissipation.value).abs() <= 1e-9 * (1. + r.dissipation.value),
                    "m {m} v {v}: {work} vs {}",
                    r.dissipation.value
                );
            }
        }
        // Zero motion is chi = 1 and exactly no force or loss.
        let rest = passage(0.5).annulus(s(0.), s(0.), s(745.7), s(9.2e-5), s(4.));
        assert_eq!(
            (rest.chi.value, rest.loss.value, rest.wall_force.value),
            (1., 0., 0.)
        );
    }
    #[test]
    fn passage_directions_match_central_differences() {
        let p = passage(0.5);
        let base = [1.31, -1.2, 745.7, 9.24e-5, 1.85];
        let dir = [0.3, -0.7, 2.1, 1e-6, -0.4];
        let eval = |x: [f64; 5], dx: [f64; 5]| {
            let [m, v, rho, mu, l] = [0, 1, 2, 3, 4].map(|i| d(x[i], dx[i]));
            let r = p.annulus(m, v, rho, mu, l);
            let c = p.clear(m, rho, mu, s(4.65) - l);
            [r.loss, r.wall_force, c]
        };
        let exact = eval(base, dir);
        let h = 1e-7;
        let shift = |sg: f64| std::array::from_fn(|i| base[i] + sg * h * dir[i]);
        let (p, q) = (eval(shift(1.), [0.; 5]), eval(shift(-1.), [0.; 5]));
        for k in 0..3 {
            let fd = (p[k].value - q[k].value) / (2. * h);
            assert!(
                (exact[k].direction - fd).abs() <= 1e-6 * fd.abs().max(1e-6),
                "{k}: {} vs {fd}",
                exact[k].direction
            );
        }
    }
}
