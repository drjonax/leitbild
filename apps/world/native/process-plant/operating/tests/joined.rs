//! Synthetic equation checks of the joined spine's own pieces: the exact
//! caloric inverses its solids use, the block layout contract and the
//! census bookkeeping. No plant coefficient or package is involved.
use leitbild_operating_plant::{
    joined::{
        block::{Class, Coordinates, Layout},
        census,
    },
    thermal::{self, Scalar},
};

#[test]
fn clad_inverse_reproduces_the_forward_law_on_every_piece_and_its_direction() {
    let mut worst = 0_f64;
    for k in 0..=1510 {
        let t = 290. + k as f64;
        let forward = thermal::clad_caloric(Scalar::new(t, 1.)).unwrap();
        let back = thermal::clad_temperature(Scalar::new(
            forward.specific_energy.value,
            forward.specific_energy.direction,
        ))
        .unwrap();
        worst = worst.max((back.value - t).abs());
        // d T/du * du/dT = 1 at the same point.
        assert!(
            (back.direction - 1.).abs() < 1e-12,
            "T={t}: direction {}",
            back.direction
        );
    }
    assert!(worst < 1e-9, "clad inverse round trip {worst} K");
    assert!(thermal::clad_temperature(Scalar::constant(1e9)).is_err());
    assert!(thermal::clad_temperature(Scalar::constant(f64::NAN)).is_err());
}

#[test]
fn fuel_inverse_reproduces_the_forward_law_and_its_direction() {
    let mut worst = 0_f64;
    for k in 0..=171 {
        let t = 290. + 10. * k as f64;
        let forward = thermal::fuel_caloric(Scalar::new(t, 1.)).unwrap();
        let back = thermal::fuel_temperature(Scalar::new(
            forward.specific_energy.value,
            forward.specific_energy.direction,
        ))
        .unwrap();
        worst = worst.max((back.value - t).abs());
        assert!(
            (back.direction - 1.).abs() < 1e-9,
            "T={t}: direction {}",
            back.direction
        );
    }
    assert!(worst < 1e-8, "fuel inverse round trip {worst} K");
    let hot = thermal::fuel_caloric(Scalar::constant(2000.)).unwrap();
    assert!(thermal::fuel_temperature(Scalar::constant(hot.specific_energy.value * 1.01)).is_err());
}

#[test]
fn a_layout_refuses_a_differential_row_scaled_apart_from_its_coordinate() {
    let mut layout = Layout::default();
    layout.push("U".into(), Class::FuelEnergy, true, 2., 2.);
    layout.push("T".into(), Class::Surface, false, 600., 7e6);
    assert!(layout.validate("fixture").is_ok());
    assert_eq!(layout.ids(), vec![1., 0.]);
    layout.push("E".into(), Class::FissionHistory, true, 3., 4.);
    assert!(layout.validate("fixture").is_err());
    let mut bad = Layout::default();
    bad.push("x".into(), Class::Tracer, false, 0., 1.);
    assert!(bad.validate("fixture").is_err());
}

#[test]
fn coordinates_carry_the_seed_and_the_stage_coefficient_in_physical_units() {
    let (y, yp, d, scales) = ([2., 3.], [0.5, -1.], [1., -2.], [10., 100.]);
    let x = Coordinates::new(&y, &yp, Some(&d), 4., &scales).unwrap();
    assert_eq!((x.value(1).value, x.value(1).direction), (300., -200.));
    assert_eq!((x.rate(0).value, x.rate(0).direction), (5., 40.));
    let unseeded = Coordinates::new(&y, &yp, None, 4., &scales).unwrap();
    assert_eq!(unseeded.rate(1).direction, 0.);
    assert!(Coordinates::new(&y, &yp[..1], None, 1., &scales).is_err());
}

#[test]
fn the_census_counts_composed_classes_and_keeps_pending_owners_apart() {
    let mut layout = Layout::default();
    for i in 0..3 {
        layout.push(format!("N[{i}]"), Class::RegionalPopulation, true, 1., 1.);
    }
    layout.push("T".into(), Class::Surface, false, 1., 1.);
    let ids = [1., 1., 1., 0.];
    let pending = census::Pending {
        owner: "rods",
        by: "fixture owner",
        classes: vec![(Class::GuideCurrent, [0, 5])],
    };
    let c = census::census(
        &[census::Composed {
            owner: "fixture",
            layout: &layout,
            differential: &ids,
        }],
        &[pending],
    );
    assert_eq!(c.composed, [3, 1, 4]);
    assert_eq!(c.with_pending, [3, 6, 9]);
    let n = c
        .entries
        .iter()
        .find(|e| e.row == "Regional N, 24 regions")
        .unwrap();
    assert_eq!(n.composed, Some([3, 0]));
    let guide = c
        .entries
        .iter()
        .find(|e| e.row == "Guide passages, 1 per cluster")
        .unwrap();
    assert_eq!((guide.composed, guide.declared), (None, Some([0, 5])));
    assert_eq!(
        census::MEMO_TOTAL[0] + census::MEMO_TOTAL[1],
        census::MEMO_TOTAL[2]
    );
    let memo: [usize; 2] = census::TABLE_1_1
        .iter()
        .fold([0, 0], |a, r| [a[0] + r.memo[0], a[1] + r.memo[1]]);
    assert_eq!(memo, [census::MEMO_TOTAL[0], census::MEMO_TOTAL[1]]);
}
