//! The SG relief characteristic and branch memory (F4 (a), H5) on explicit
//! pressures; no property, solver or plant state. Synthetic pressures only.
use leitbild_operating_plant::{
    sg::{Branch, Characteristic, Threshold},
    thermal::Scalar,
};

fn valve() -> Characteristic {
    // The relief record's selection (admission-and-protection.md).
    Characteristic::new(6.8e6, 7.0e6, 6.6e6, 0.1).unwrap()
}
fn target(c: &Characteristic, b: Branch, p: f64) -> f64 {
    c.target(b, Scalar::constant(p)).value
}

#[test]
fn characteristics_open_linearly_and_agree_at_both_switches() {
    let c = valve();
    use Branch::*;
    for (p, ascending, descending) in [
        (6.5e6, 0., 0.),
        (6.6e6, 0., 0.),
        (6.7e6, 0., 0.25),
        (6.8e6, 0., 0.5),
        (6.9e6, 0.5, 0.75),
        (7.0e6, 1., 1.),
        (7.2e6, 1., 1.),
    ] {
        assert!((target(&c, Ascending, p) - ascending).abs() < 1e-12, "{p}");
        assert!(
            (target(&c, Descending, p) - descending).abs() < 1e-12,
            "{p}"
        );
    }
    // The switch points: full lift (both fully open) and reseat (both shut).
    assert_eq!(target(&c, Ascending, 7.0e6), target(&c, Descending, 7.0e6));
    assert_eq!(target(&c, Ascending, 6.6e6), target(&c, Descending, 6.6e6));
    // Interior directions are the characteristic slopes; outside, zero.
    let d = |b, p| c.target(b, Scalar::new(p, 1.)).direction;
    assert!((d(Ascending, 6.9e6) - 1. / 0.2e6).abs() < 1e-18);
    assert!((d(Descending, 6.9e6) - 1. / 0.4e6).abs() < 1e-18);
    assert_eq!(d(Ascending, 6.7e6), 0.);
    assert_eq!(d(Descending, 7.1e6), 0.);
    // First-order lag toward the target, 0.1 s.
    let rate = c.lift_rate(Ascending, Scalar::constant(6.9e6), Scalar::constant(0.2));
    assert!((rate.value - (0.5 - 0.2) / 0.1).abs() < 1e-12);
}

#[test]
fn memory_switches_at_full_lift_and_reseat_only() {
    let c = valve();
    use {Branch::*, Threshold::*};
    assert_eq!(Characteristic::armed(Ascending), &[Crack, FullLift]);
    assert_eq!(Characteristic::armed(Descending), &[Reseat]);
    // Crack is a kink in either direction; full lift rising switches.
    assert_eq!(c.transition(Ascending, Crack, 1).unwrap().after, Ascending);
    assert_eq!(c.transition(Ascending, Crack, -1).unwrap().after, Ascending);
    assert_eq!(
        c.transition(Ascending, FullLift, 1).unwrap().after,
        Descending
    );
    assert_eq!(
        c.transition(Descending, Reseat, -1).unwrap().after,
        Ascending
    );
    // Crossings the memory excludes, or thresholds a branch does not arm.
    for (b, t, d) in [
        (Ascending, FullLift, -1),
        (Ascending, Reseat, -1),
        (Descending, Reseat, 1),
        (Descending, FullLift, 1),
        (Descending, Crack, -1),
    ] {
        assert!(c.transition(b, t, d).is_err(), "{b:?} {t:?} {d}");
    }
    // Root values in MPa, zero at each threshold.
    assert_eq!(c.root(FullLift, 7.0e6), 0.);
    assert!((c.root(Reseat, 6.5e6) + 0.1).abs() < 1e-12);
    // The rule's admission of a declared memory.
    assert!(c.admits(Ascending, 6.99e6) && !c.admits(Ascending, 7.0e6));
    assert!(c.admits(Descending, 6.61e6) && !c.admits(Descending, 6.6e6));
}

/// Walk an explicit pressure history through the armed roots, as an event
/// harness would: only the current branch's thresholds can fire. A history
/// that dithers about full lift after the switch, and about reseat after
/// the switch back, produces exactly one switch each: no chatter.
#[test]
fn dithering_about_either_switch_produces_one_transition() {
    let c = valve();
    let history = [
        6.5e6, 6.79e6, 6.81e6, 6.95e6, 7.01e6, 6.99e6, 7.02e6, 6.98e6, 7.03e6, 6.9e6, 6.7e6,
        6.61e6, 6.59e6, 6.62e6, 6.58e6, 6.63e6, 6.5e6,
    ];
    let mut branch = Branch::Ascending;
    let mut switches = Vec::new();
    let mut kinks = 0;
    for w in history.windows(2) {
        for t in Characteristic::armed(branch) {
            let (a, b) = (c.root(*t, w[0]), c.root(*t, w[1]));
            if a.signum() != b.signum() {
                let direction = if b > a { 1 } else { -1 };
                let x = c.transition(branch, *t, direction).unwrap();
                if x.after == branch {
                    kinks += 1;
                } else {
                    switches.push((w[1], x.before, x.after));
                    branch = x.after;
                    break;
                }
            }
        }
    }
    assert_eq!(
        switches,
        vec![
            (7.01e6, Branch::Ascending, Branch::Descending),
            (6.59e6, Branch::Descending, Branch::Ascending),
        ]
    );
    // Crack crossed rising once before full lift; after reseat the history
    // stays below crack, so no further root is crossed.
    assert_eq!(kinks, 1);
    assert_eq!(branch, Branch::Ascending);
}

#[test]
fn a_lift_that_never_reaches_full_lift_recloses_at_crack() {
    let c = valve();
    // Rising to 6.95 MPa and falling back stays on the ascending branch, so
    // the target is zero below crack, not along the descending line.
    let mut branch = Branch::Ascending;
    for (from, to) in [(6.7e6, 6.95e6), (6.95e6, 6.7e6)] {
        for t in Characteristic::armed(branch) {
            if c.root(*t, from).signum() != c.root(*t, to).signum() {
                branch = c
                    .transition(branch, *t, if to > from { 1 } else { -1 })
                    .unwrap()
                    .after;
            }
        }
    }
    assert_eq!(branch, Branch::Ascending);
    assert_eq!(target(&c, branch, 6.75e6), 0.);
    assert!(target(&c, Branch::Descending, 6.75e6) > 0.);
}

#[test]
fn the_selection_is_refused_out_of_order() {
    assert!(Characteristic::new(6.8e6, 7.0e6, 6.9e6, 0.1).is_err());
    assert!(Characteristic::new(7.1e6, 7.0e6, 6.6e6, 0.1).is_err());
    assert!(Characteristic::new(6.8e6, 7.0e6, 6.6e6, 0.).is_err());
    assert!(Characteristic::new(6.8e6, f64::NAN, 6.6e6, 0.1).is_err());
}
