//! The PZR phase-contact laws the stratified cell reuses, on synthetic
//! smooth properties only, and the finite phase-receipt transaction.
use leitbild_operating_plant::{
    pzr::{self, Active, FiniteReceipt, PhaseInventory},
    pzr_field::{Phase, exchange},
    thermal::{Saturation, Scalar, WaterPoint},
};
fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn close(a: f64, b: f64, t: f64) {
    assert!(
        (a - b).abs() <= t * (1. + a.abs().max(b.abs())),
        "{a} != {b}"
    );
}
fn properties(t: Scalar, vapor: bool) -> WaterPoint {
    WaterPoint {
        density: s(if vapor { 80. } else { 660. })
            - s(if vapor { 0.2 } else { 0.7 }) * (t - s(600.)),
        viscosity: s(if vapor { 2e-5 } else { 1e-4 }) + s(1e-8) * (t - s(600.)),
        conductivity: s(if vapor { 0.06 } else { 0.6 }) + s(1e-5) * (t - s(600.)),
        cp: s(if vapor { 3000. } else { 5000. }) + s(0.3) * (t - s(600.)),
        expansion: s(0.002),
        enthalpy: s(if vapor { 2.6e6 } else { 1.4e6 }) + s(4000.) * (t - s(600.)),
    }
}
fn saturation(h: f64) -> Saturation {
    let t = Scalar::new(615. + h * 0.01, 0.01);
    Saturation {
        temperature: t,
        liquid: properties(t, false),
        vapor: properties(t, true),
        surface_tension: s(0.025),
    }
}
fn phase(t: f64, vapor: bool, rise: f64) -> Phase {
    let temperature = s(t);
    let water = properties(temperature, vapor);
    Phase {
        mass: s(10.),
        volume: s(10.) / water.density,
        temperature,
        water,
        velocity: [s(0.), s(rise)],
        boron_mass: s(0.),
    }
}

#[test]
fn zero_slip_heat_value_keeps_sqrt_cusp_and_declares_inexact_linearization() {
    let sat = {
        let mut q = saturation(0.);
        q.temperature.direction = 0.;
        q.liquid = properties(q.temperature, false);
        q.vapor = properties(q.temperature, true);
        q
    };
    let liquid = phase(605., false, 0.);
    let run = |rise: f64| {
        let mut vapor = phase(630., true, rise);
        vapor.velocity[1].direction = 1.;
        exchange(0.003, liquid, vapor, s(2.), sat)
    };
    let base = run(0.);
    assert!(base.zero_slip_inexact);
    assert_eq!(base.liquid.enthalpy.direction, 0.);
    let da = run(1e-8).liquid.enthalpy.value - base.liquid.enthalpy.value;
    let db = run(4e-8).liquid.enthalpy.value - base.liquid.enthalpy.value;
    assert!(da.abs() > 1e-3);
    close(db / da, 2., 1e-7);
    // The one-sided quotient grows as 1/sqrt(delta); returned zero is explicitly
    // an inexact Newton coefficient, not a finite exact physical derivative.
    assert!((da / 1e-8).abs() > (db / 4e-8).abs() * 1.9);
    assert!(!run(1e-8).zero_slip_inexact);
}

#[test]
fn actual_finite_birth_and_exhaustion_preserve_work_momentum_and_residue() {
    let before = [
        PhaseInventory::default(),
        PhaseInventory {
            mass_kg: 10.,
            internal_energy_j: 26e6,
            momentum_kg_m_s: [1., 2.],
            dissolved_boron_kg: 0.,
        },
    ];
    let receipt = [
        FiniteReceipt {
            mass_kg: 1.,
            thermal_enthalpy_j: 1.4e6,
            phase_volume_m3: 0.002,
            momentum_kg_m_s: [0.3, -0.1],
            dissolved_boron_kg: 0.0005,
        },
        FiniteReceipt {
            phase_volume_m3: -0.002,
            ..FiniteReceipt::default()
        },
    ];
    let born = pzr::apply_phase_receipts(15e6, before, receipt).unwrap();
    assert_eq!(born.active, Active::TwoPhase);
    assert_eq!(born.phase_volume_defect_m3, 0.);
    close(
        born.inventory.iter().map(|p| p.internal_energy_j).sum(),
        27.4e6,
        1e-14,
    );
    assert_eq!(born.inventory[1].momentum_kg_m_s, before[1].momentum_kg_m_s);
    let mut removal = [
        FiniteReceipt {
            mass_kg: -1.,
            thermal_enthalpy_j: -1.4e6,
            phase_volume_m3: -0.002,
            momentum_kg_m_s: [-0.3, 0.1],
            dissolved_boron_kg: 0.,
        },
        FiniteReceipt {
            phase_volume_m3: 0.002,
            ..FiniteReceipt::default()
        },
    ];
    assert!(
        pzr::apply_phase_receipts(15e6, born.inventory, removal)
            .unwrap_err()
            .contains("residue")
    );
    removal[0].dissolved_boron_kg = -0.0005;
    let gone = pzr::apply_phase_receipts(15e6, born.inventory, removal).unwrap();
    assert_eq!(gone.active, Active::Vapor);
    assert_eq!(gone.inventory[0].mass_kg, 0.);
    assert_eq!(
        gone.inventory[1].internal_energy_j,
        before[1].internal_energy_j
    );
    // Actual transfer destination must own removed boron; it cannot disappear
    // through a phase-layout change or be reassigned to vapor.
    let mut wrong = receipt;
    wrong[1].dissolved_boron_kg = 0.0005;
    assert!(pzr::apply_phase_receipts(15e6, before, wrong).is_err());
    // Each updated phase energy remains finite, but the aggregate volume row
    // must also refuse overflow rather than publish an infinite diagnostic.
    let finite_stocks = [PhaseInventory {
        mass_kg: 1.,
        ..PhaseInventory::default()
    }; 2];
    let overflowing_volume = [FiniteReceipt {
        phase_volume_m3: 1e308,
        ..FiniteReceipt::default()
    }; 2];
    assert!(pzr::apply_phase_receipts(1., finite_stocks, overflowing_volume).is_err());
}
