//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/control-absorber-and-guide-water.md#s2-moving-cell-volumes
//! Axial incidence of the moving spider and bodies on the network cells.
//!
//! Each cluster's 24 bodies occupy `[b0 + y, t0 + y]` and its spider
//! `[s0 + y, s0 + h + y]`, the spider's steel spread uniformly over its
//! height (the preparation's own axial reduction). A cell has a fixed axial
//! span; a sector cell takes the cluster's actual sector share of its body
//! area. The displaced volume is piecewise linear in `y` with C0 kinks where
//! a body or spider end crosses a cell plane. At a kink the one-sided slope
//! of the declared travel branch is taken (the value is the same on both
//! sides): the side the body moves into, insertion at rest.

/// Side of a kink whose slope is taken: the travel direction's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Branch {
    /// Decreasing travel (insertion), and rest.
    Insertion,
    Withdrawal,
}
impl Branch {
    /// The branch of a current travel rate: insertion unless withdrawing.
    pub fn of_rate(rate: f64) -> Self {
        if rate > 0. {
            Self::Withdrawal
        } else {
            Self::Insertion
        }
    }
}

/// Overlap of the fixed span `[lo, hi]` with `[bottom, top]`, whose ends
/// move with `y` at the slopes `db, dt` (0 or 1), and the overlap's
/// one-sided slope in `y` on `branch`.
pub fn overlap(
    lo: f64,
    hi: f64,
    bottom: (f64, f64),
    top: (f64, f64),
    branch: Branch,
) -> (f64, f64) {
    let (b, db) = bottom;
    let (t, dt) = top;
    let upper = t.min(hi);
    let lower = b.max(lo);
    let raw = upper - lower;
    let value = raw.max(0.);
    // Slopes of min(hi, t) and max(lo, b) just on the branch's side.
    let (d_upper, d_lower) = match branch {
        Branch::Insertion => (
            if t < hi || (t == hi && dt > 0.) {
                dt
            } else {
                0.
            },
            if b > lo { db } else { 0. },
        ),
        Branch::Withdrawal => (
            if t < hi { dt } else { 0. },
            if b > lo || (b == lo && db > 0.) {
                db
            } else {
                0.
            },
        ),
    };
    let slope = d_upper - d_lower;
    let open = match branch {
        // Just below y the overlap is raw - eps*slope, just above raw + eps*slope.
        Branch::Insertion => raw > 0. || (raw == 0. && slope < 0.),
        Branch::Withdrawal => raw > 0. || (raw == 0. && slope > 0.),
    };
    (value, if open { slope } else { 0. })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn probe(lo: f64, hi: f64, b0: f64, t0: f64, y: f64, branch: Branch) -> (f64, f64) {
        overlap(lo, hi, (b0 + y, 1.), (t0 + y, 1.), branch)
    }
    #[test]
    fn slopes_are_the_one_sided_differences_at_every_kink() {
        let (lo, hi, b0, t0) = (0., 2., -2.25, 2.4);
        // Kinks of a body in CORE.2: bottom crosses 0 at y = 2.25, 2 at 4.25;
        // top crosses 2 at y = -0.4; plus an interior point.
        for y in [-0.4, 0.3, 2.25, 4.25, 5.] {
            let h = 1e-6;
            let left = (probe(lo, hi, b0, t0, y, Branch::Insertion).0
                - probe(lo, hi, b0, t0, y - h, Branch::Insertion).0)
                / h;
            let right = (probe(lo, hi, b0, t0, y + h, Branch::Insertion).0
                - probe(lo, hi, b0, t0, y, Branch::Insertion).0)
                / h;
            assert!(
                (probe(lo, hi, b0, t0, y, Branch::Insertion).1 - left).abs() < 1e-6,
                "{y}"
            );
            assert!(
                (probe(lo, hi, b0, t0, y, Branch::Withdrawal).1 - right).abs() < 1e-6,
                "{y}"
            );
        }
    }
    #[test]
    fn a_fixed_top_moving_bottom_span_has_its_own_slope() {
        // The annulus from the tip to the guide top inside UPPER (2..4).
        let (v, d) = overlap(2., 4., (-2.25 + 4.5, 1.), (2.4, 0.), Branch::Insertion);
        assert!((v - 0.15).abs() < 1e-15 && d == -1.);
        let (v, d) = overlap(2., 4., (-2.25 + 4.25, 1.), (2.4, 0.), Branch::Insertion);
        assert!((v - 0.4).abs() < 1e-15 && d == 0.);
        let (_, d) = overlap(2., 4., (-2.25 + 4.25, 1.), (2.4, 0.), Branch::Withdrawal);
        assert_eq!(d, -1.);
    }
}
