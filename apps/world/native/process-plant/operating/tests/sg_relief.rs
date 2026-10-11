//! The SG relief characteristic, branch memory (F4 (a), H5) and disc seat on
//! explicit pressures and lifts; no property, solver or plant state.
//! Synthetic pressures only.
use leitbild_operating_plant::{
    sg::{Branch, Characteristic, Threshold, Valve},
    thermal::Scalar,
};

fn valve() -> Characteristic {
    // The relief record's selection (admission-and-protection.md).
    Characteristic::new(6.8e6, 7.0e6, 6.6e6, 0.1, (-10f64).exp()).unwrap()
}
fn target(c: &Characteristic, b: Branch, p: f64) -> f64 {
    c.target(b, Scalar::constant(p)).value
}
const LIFTED_UP: Valve = Valve::open(Branch::Ascending);
const LIFTED_DOWN: Valve = Valve::open(Branch::Descending);
const SEATED: Valve = Valve::SEATED;
const CLOSING: Valve = Valve::CLOSING;

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
        assert!((target(&c, Descending, p) - descending).abs() < 1e-12, "{p}");
    }
    assert_eq!(target(&c, Ascending, 7.0e6), target(&c, Descending, 7.0e6));
    assert_eq!(target(&c, Ascending, 6.6e6), target(&c, Descending, 6.6e6));
    let d = |b, p| c.target(b, Scalar::new(p, 1.)).direction;
    assert!((d(Ascending, 6.9e6) - 1. / 0.2e6).abs() < 1e-18);
    assert!((d(Descending, 6.9e6) - 1. / 0.4e6).abs() < 1e-18);
    assert_eq!(d(Ascending, 6.7e6), 0.);
    assert_eq!(d(Descending, 7.1e6), 0.);
    // First-order lag toward the target, 0.1 s.
    let rate = c.lift_rate(LIFTED_UP, Scalar::constant(6.9e6), Scalar::constant(0.2));
    assert!((rate.value - (0.5 - 0.2) / 0.1).abs() < 1e-12);
    assert_eq!(c.seat_lift.to_bits(), (-10f64).exp().to_bits());
}

#[test]
fn memory_switches_at_full_lift_and_reseat_only() {
    let c = valve();
    use Threshold::*;
    assert_eq!(Characteristic::armed(LIFTED_UP), &[Crack, FullLift]);
    assert_eq!(Characteristic::armed(SEATED), &[Crack, FullLift]);
    assert_eq!(Characteristic::armed(CLOSING), &[Crack, FullLift, Seat]);
    assert_eq!(Characteristic::armed(LIFTED_DOWN), &[Reseat]);
    let after = |v, t, d, l| c.transition(v, t, d, l).unwrap().after;
    assert_eq!(after(LIFTED_UP, FullLift, 1, 0.6), LIFTED_DOWN);
    assert_eq!(after(LIFTED_DOWN, Reseat, -1, 0.03), CLOSING);
    for (v, t, d) in [
        (LIFTED_UP, FullLift, -1),
        (LIFTED_UP, Reseat, -1),
        (LIFTED_UP, Seat, -1),
        (LIFTED_DOWN, Reseat, 1),
        (LIFTED_DOWN, FullLift, 1),
        (LIFTED_DOWN, Crack, -1),
        (LIFTED_DOWN, Seat, -1),
        (SEATED, Seat, -1),
        (SEATED, Crack, -1),
        (CLOSING, Crack, -1),
        (CLOSING, Seat, 1),
    ] {
        assert!(c.transition(v, t, d, 0.).is_err(), "{v:?} {t:?} {d}");
    }
    assert_eq!(c.root(FullLift, 7.0e6, 0.), 0.);
    assert!((c.root(Reseat, 6.5e6, 0.) + 0.1).abs() < 1e-12);
    assert_eq!(c.root(Seat, 6.5e6, c.seat_lift), 0.);
    // The rule's admission of a declared state.
    assert!(c.admits(LIFTED_UP, 6.99e6, 0.2) && !c.admits(LIFTED_UP, 7.0e6, 0.2));
    assert!(c.admits(LIFTED_DOWN, 6.61e6, 0.2) && !c.admits(LIFTED_DOWN, 6.6e6, 0.2));
    assert!(c.admits(SEATED, 6.0e6, 0.) && !c.admits(SEATED, 6.0e6, 1e-9));
    let seated_down = Valve {
        branch: Branch::Descending,
        seated: true,
        closing: false,
    };
    assert!(!c.admits(seated_down, 6.9e6, 0.));
}

#[test]
fn a_closing_disc_seats_at_its_seat_lift() {
    let c = valve();
    let seat = c.seat_lift;
    use Threshold::*;
    // Crack falling: the target returns to zero and the disc closes.
    let x = c.transition(LIFTED_UP, Crack, -1, 0.3).unwrap();
    assert_eq!((x.after, x.seated_from_lift), (CLOSING, None));
    // The closing lift falling to the seat lift seats, removing that lift.
    let x = c.transition(CLOSING, Seat, -1, seat).unwrap();
    assert_eq!((x.after, x.seated_from_lift), (SEATED, Some(seat)));
    // Crack rising unseats a seated disc and stops a closing one.
    assert_eq!(c.transition(SEATED, Crack, 1, 0.).unwrap().after, LIFTED_UP);
    assert_eq!(c.transition(CLOSING, Crack, 1, 1e-3).unwrap().after, LIFTED_UP);
    // A target reaching zero with the lift already below the seat lift
    // seats at that crossing, at crack or at reseat.
    let x = c.transition(LIFTED_UP, Crack, -1, 1e-6).unwrap();
    assert_eq!((x.after, x.seated_from_lift), (SEATED, Some(1e-6)));
    let x = c.transition(LIFTED_DOWN, Reseat, -1, 1e-6).unwrap();
    assert_eq!((x.after, x.seated_from_lift), (SEATED, Some(1e-6)));
    // A seated disc does not move; a closing one decays toward zero.
    let held = c.lift_rate(SEATED, Scalar::new(6.5e6, 1.), Scalar::new(0., 1.));
    assert_eq!((held.value, held.direction), (0., 0.));
    let closing = c.lift_rate(CLOSING, Scalar::constant(6.5e6), Scalar::constant(0.01));
    assert!((closing.value + 0.1).abs() < 1e-15);
}

/// Walk an explicit pressure history through the armed roots, as an event
/// harness would: only the current state's thresholds can fire. A history
/// that dithers about full lift after the switch, and about reseat after the
/// switch back, produces exactly one switch each: no chatter.
#[test]
fn dithering_about_either_switch_produces_one_transition() {
    let c = valve();
    let history = [
        6.5e6, 6.79e6, 6.81e6, 6.95e6, 7.01e6, 6.99e6, 7.02e6, 6.98e6, 7.03e6, 6.9e6, 6.7e6,
        6.61e6, 6.59e6, 6.62e6, 6.58e6, 6.63e6, 6.5e6,
    ];
    let mut v = SEATED;
    let mut switches = Vec::new();
    let mut unseats = 0;
    for w in history.windows(2) {
        for t in Characteristic::armed(v) {
            // A lift well above the seat throughout: only pressure roots move.
            let (a, b) = (c.root(*t, w[0], 0.5), c.root(*t, w[1], 0.5));
            if a.signum() != b.signum() {
                let x = c.transition(v, *t, if b > a { 1 } else { -1 }, 0.5).unwrap();
                if x.after.branch != v.branch {
                    switches.push((w[1], v.branch, x.after.branch));
                } else if v.seated && !x.after.seated {
                    unseats += 1;
                }
                v = x.after;
                break;
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
    assert_eq!(unseats, 1);
    // Reseat with the lift above the seat lift leaves the disc closing.
    assert_eq!(v, CLOSING);
}

#[test]
fn a_lift_that_never_reaches_full_lift_recloses_at_crack() {
    let c = valve();
    let mut v = LIFTED_UP;
    for (from, to) in [(6.7e6, 6.95e6), (6.95e6, 6.7e6)] {
        for t in Characteristic::armed(v) {
            if c.root(*t, from, 0.2).signum() != c.root(*t, to, 0.2).signum() {
                v = c
                    .transition(v, *t, if to > from { 1 } else { -1 }, 0.2)
                    .unwrap()
                    .after;
                break;
            }
        }
    }
    assert_eq!(v, CLOSING);
    assert_eq!(target(&c, v.branch, 6.75e6), 0.);
    assert!(target(&c, Branch::Descending, 6.75e6) > 0.);
}

#[test]
fn the_selection_is_refused_out_of_order() {
    let seat = (-10f64).exp();
    assert!(Characteristic::new(6.8e6, 7.0e6, 6.9e6, 0.1, seat).is_err());
    assert!(Characteristic::new(7.1e6, 7.0e6, 6.6e6, 0.1, seat).is_err());
    assert!(Characteristic::new(6.8e6, 7.0e6, 6.6e6, 0., seat).is_err());
    assert!(Characteristic::new(6.8e6, f64::NAN, 6.6e6, 0.1, seat).is_err());
    assert!(Characteristic::new(6.8e6, 7.0e6, 6.6e6, 0.1, 1.).is_err());
    assert!(Characteristic::new(6.8e6, 7.0e6, 6.6e6, 0.1, 0.).is_err());
}
