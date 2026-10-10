//! RCP drive, rotor and seizure laws against the wiki identities. `P:n` cites
//! pumps-and-support.md and `R:n` reversible-pump-model.md (wiki d3bbbec). The
//! fixture is a test-only commissioning record: the compiled LD-01 rotor
//! values plus the powered-cycle P_fluid_0 that reproduces them exactly.
use leitbild_operating_plant::hydraulics::{self, Pump, Section, WallLaw};
use leitbild_operating_plant::rotor::{
    self, Error, Evaluation, Input, Locking, Parameters, ReleasePreparation, RotorRow, Shaft,
    SpeedRequest, Support, TorqueBranch,
};
use leitbild_operating_plant::thermal::Scalar;
use serde_json::json;

const J: f64 = 1714.614588335515;
const DRAG: f64 = 1.6976382062727868;
const OMEGA0: f64 = 157.07963267948966;
const FLUID0: f64 = 4188754.3780218355;
// Wiki selections used only to check the compiled identities (P:15-21).
const RPM: f64 = 1500.;
const DRAG_FRACTION: f64 = 0.01;
const DECAY_S: f64 = 10.;
const ETA0: f64 = 0.96;

fn packet() -> serde_json::Value {
    json!({
        "rotorInertia_kg_m2": J,
        "drag_Nm_per_rad_s": DRAG,
        "referenceOmega_rad_s": OMEGA0,
        "nominalFluidPower_W": FLUID0,
        "driveTrackingTime_s": 5.,
        "driveTorqueCapFactor": 1.5,
        "driveEfficiency": ETA0
    })
}
fn parameters() -> Parameters {
    serde_json::from_value(packet()).unwrap()
}
fn s(value: f64, direction: f64) -> Scalar {
    Scalar::new(value, direction)
}
fn input(omega: f64, rate: f64, fluid_torque: f64) -> Input {
    Input {
        omega_rad_s: s(omega, 0.),
        angular_momentum_rate_nm: s(rate, 0.),
        fluid_torque_nm: s(fluid_torque, 0.),
    }
}
fn close(a: f64, b: f64, rtol: f64) {
    assert!(
        (a - b).abs() <= rtol * a.abs().max(b.abs()).max(1.),
        "{a} != {b}"
    );
}
/// Agreement with a wiki figure to its printed digits.
fn printed(a: f64, figure: f64, half_unit: f64) {
    assert!((a - figure).abs() <= half_unit, "{a} vs printed {figure}");
}
fn free(e: &Evaluation) -> Scalar {
    match e.rotor {
        RotorRow::Free { residual_nm } => residual_nm,
        RotorRow::Locked { .. } => panic!("free rotor row expected"),
    }
}
fn locked(e: &Evaluation) -> (Scalar, Scalar) {
    match e.rotor {
        RotorRow::Locked {
            residual_rad_s,
            constraint_torque_nm,
        } => (residual_rad_s, constraint_torque_nm),
        RotorRow::Free { .. } => panic!("locked rotor row expected"),
    }
}

#[test]
fn compiled_rotor_values_satisfy_the_wiki_identities() {
    // P:15 omega0 from 1500 rpm; P:20 P_drag_0=0.01*P_fluid_0;
    // P:21 J=(P_fluid_0+P_drag_0)*10/omega0^2; P:23 T_drag=(P_drag_0/omega0^2)*omega.
    assert_eq!(OMEGA0, RPM * 2. * std::f64::consts::PI / 60.);
    let drag0 = DRAG_FRACTION * FLUID0;
    assert_eq!((FLUID0 + drag0) * DECAY_S / (OMEGA0 * OMEGA0), J);
    assert_eq!(drag0 / (OMEGA0 * OMEGA0), DRAG);
    // Either compiled coefficient alone recovers P_fluid_0 to rounding.
    close(DRAG * OMEGA0 * OMEGA0 / DRAG_FRACTION, FLUID0, 1e-15);
    close(
        J * OMEGA0 * OMEGA0 / (DECAY_S * (1. + DRAG_FRACTION)),
        FLUID0,
        1e-15,
    );
    printed(FLUID0, 4.188754e6, 0.5); // P:9
    printed(J, 1714.614588, 0.5e-6); // P:61
    // The derived P_drag_0 reproduces the selected fraction exactly; the
    // compiler owns these identities and validate() checks only domains.
    let p = parameters();
    assert_eq!(p.nominal_drag_power_w(), drag0);
    assert_eq!(p.nominal_power_w() * DECAY_S / (OMEGA0 * OMEGA0), J);
    assert_eq!(p.validate(), Ok(()));
}

#[test]
fn packet_names_are_exact_and_invalid_coefficients_are_refused() {
    let mut extra = packet();
    extra["a"] = json!(0.048);
    assert!(serde_json::from_value::<Parameters>(extra).is_err());
    let mut missing = packet();
    missing.as_object_mut().unwrap().remove("driveEfficiency");
    assert!(serde_json::from_value::<Parameters>(missing).is_err());
    let p = parameters();
    for bad in [
        Parameters {
            inertia_kg_m2: 0.,
            ..p
        },
        Parameters {
            drag_nm_per_rad_s: -1e-3,
            ..p
        },
        Parameters {
            reference_omega_rad_s: 0.,
            ..p
        },
        Parameters {
            nominal_fluid_power_w: 0.,
            ..p
        },
        Parameters {
            tracking_time_s: 0.,
            ..p
        },
        Parameters {
            torque_cap_factor: 0.,
            ..p
        },
        Parameters {
            efficiency: 0.,
            ..p
        },
        Parameters {
            efficiency: 1.01,
            ..p
        },
        Parameters {
            tracking_time_s: f64::NAN,
            ..p
        },
    ] {
        assert_eq!(bad.validate(), Err(Error::InvalidParameter));
        assert!(
            bad.evaluate(Support::Unsupported, Shaft::Free, input(0., 0., 0.))
                .is_err()
        );
        assert!(bad.lock(Shaft::Free, OMEGA0).is_err());
    }
    let lossless = Parameters {
        efficiency: 1.,
        ..p
    };
    assert_eq!(lossless.validate(), Ok(()));
    assert_eq!(lossless.nominal_conversion_loss_w(), 0.);
}

#[test]
fn nominal_point_recovers_the_original_electrical_duty() {
    let p = parameters();
    let (t0, p0) = (p.nominal_torque_nm(), p.nominal_power_w());
    let e = p
        .evaluate(
            Support::Supported(SpeedRequest::Nominal),
            Shaft::Free,
            input(OMEGA0, 0., FLUID0 / OMEGA0),
        )
        .unwrap();
    // P:47 nominal torque/speed recovers the old electrical duty exactly.
    assert_eq!(e.branch, TorqueBranch::Tracking);
    assert_eq!(e.requested_omega_rad_s, Some(OMEGA0));
    close(e.motor_torque_nm.value, t0, 1e-12);
    close(e.motor_work_w.value, p0, 1e-12);
    close(
        e.conversion_loss_w.value,
        p.nominal_conversion_loss_w(),
        1e-12,
    );
    close(e.electric_w.value, p0 / ETA0, 1e-12);
    close(e.motor_heat_w.value, p0 * (1. / ETA0 - 1.), 1e-12);
    close(e.drag_heat_w.value, DRAG_FRACTION * FLUID0, 1e-12);
    assert!(free(&e).value.abs() <= 1e-12 * t0);
    printed(e.electric_w.value, 4.406919e6, 0.5); // P:9
    printed(p.nominal_conversion_loss_w(), 176276.747, 5e-4); // P:61
}

#[test]
fn hydraulic_fluid_torque_is_the_rotor_load_at_the_nominal_intersection() {
    // Test-only commissioning record of the signed-flow calibration (R:33-40).
    let (rho0, m0, dp0, sigma) = (745.3288701999253, 4424.53961576215, 600000., 0.2);
    let (q0, e0) = (m0 / rho0, FLUID0 / m0);
    let a = e0 / ((1. - sigma) * OMEGA0 * OMEGA0);
    let section = Section {
        length_m: 1.,
        area_m2: 1.,
        hydraulic_diameter_m: 0.,
        elevation_change_m: 0.,
        gravity_m_s2: 9.80665,
        wall: WallLaw::None,
        form_loss: 0.,
        grid_count: 0,
        grid_factor: 0.,
        blockage_fraction: 0.,
        pump: Some(Pump {
            a,
            b: sigma * a * OMEGA0 / q0,
            resistance: (rho0 * e0 - dp0) / (rho0 * q0 * q0),
            mixed_degradation_depth: 0.5,
        }),
    };
    let h = section
        .evaluate(
            hydraulics::Input {
                massflow_kg_s: m0,
                density_kg_m3: rho0,
                viscosity_pa_s: 1e-4,
                pressure_drop_pa: 0.,
                omega_rad_s: OMEGA0,
                gas_volume_fraction: 0.,
            },
            hydraulics::Input::default(),
        )
        .unwrap()
        .value;
    close(h.fluid_torque_nm, FLUID0 / OMEGA0, 1e-12);
    let p = parameters();
    let e = p
        .evaluate(
            Support::Supported(SpeedRequest::Nominal),
            Shaft::Free,
            input(OMEGA0, 0., h.fluid_torque_nm),
        )
        .unwrap();
    close(e.motor_torque_nm.value, p.nominal_torque_nm(), 1e-12);
    close(e.electric_w.value, p.nominal_power_w() / ETA0, 1e-12);
    assert!(free(&e).value.abs() <= 1e-12 * p.nominal_torque_nm());
}

#[test]
fn withdrawn_torque_has_zero_conversion_loss_and_drag_still_dissipates() {
    let p = parameters();
    let t0 = p.nominal_torque_nm();
    for w in [-1., -0.2, 0., 0.3, 1.] {
        for t in [-1., 0., 1.] {
            let (omega, tf, rate) = (w * OMEGA0, t * t0, 1200.);
            let x = Input {
                omega_rad_s: s(omega, 1.),
                angular_momentum_rate_nm: s(rate, 0.),
                fluid_torque_nm: s(tf, 3.),
            };
            let e = p.evaluate(Support::Unsupported, Shaft::Free, x).unwrap();
            assert_eq!(e.branch, TorqueBranch::Withdrawn);
            assert!(e.requested_torque_nm.is_none() && e.requested_omega_rad_s.is_none());
            for z in [
                e.motor_torque_nm,
                e.motor_work_w,
                e.conversion_loss_w,
                e.electric_w,
                e.motor_heat_w,
            ] {
                assert_eq!((z.value, z.direction), (0., 0.));
            }
            close(e.drag_heat_w.value, DRAG * omega * omega, 1e-15);
            close(free(&e).value, rate + tf + DRAG * omega, 1e-15);
        }
    }
}

#[test]
fn tracking_error_engages_the_cap_and_a_negative_request_the_floor() {
    let p = parameters();
    let (t0, cap, l0) = (
        p.nominal_torque_nm(),
        p.torque_cap_nm(),
        p.nominal_conversion_loss_w(),
    );
    close(cap, 1.5 * t0, 1e-15);
    let e = p
        .evaluate(
            Support::Supported(SpeedRequest::Nominal),
            Shaft::Free,
            Input {
                omega_rad_s: s(0.1 * OMEGA0, 1.),
                angular_momentum_rate_nm: s(0., 0.),
                fluid_torque_nm: s(0.2 * t0, 1.),
            },
        )
        .unwrap();
    assert_eq!(e.branch, TorqueBranch::Cap);
    assert!(e.requested_torque_nm.unwrap().value > cap);
    assert_eq!(
        (e.motor_torque_nm.value, e.motor_torque_nm.direction),
        (cap, 0.)
    );
    close(e.conversion_loss_w.value, 1.5 * 1.5 * l0, 1e-12);
    close(
        e.electric_w.value,
        cap * 0.1 * OMEGA0 + 1.5 * 1.5 * l0,
        1e-12,
    );
    assert!(e.linearizable);
    // A zero request at speed asks for negative torque: the drive coasts.
    let e = p
        .evaluate(
            Support::Supported(SpeedRequest::Zero),
            Shaft::Free,
            input(OMEGA0, 0., FLUID0 / OMEGA0),
        )
        .unwrap();
    assert_eq!(e.branch, TorqueBranch::Floor);
    assert!(e.requested_torque_nm.unwrap().value < 0.);
    assert_eq!(e.motor_torque_nm.value, 0.);
    assert_eq!(e.electric_w.value, 0.);
    assert_eq!(e.motor_heat_w.value, 0.);
}

#[test]
fn exact_limits_use_the_entered_branch_one_sided_direction() {
    let p = parameters();
    let cap = p.torque_cap_nm();
    let zero = Support::Supported(SpeedRequest::Zero);
    // At omega=0 a zero request equals the fluid torque exactly.
    for (value, d, branch, motor_d, linear) in [
        (0., 1., TorqueBranch::Tracking, 1., false),
        (0., -1., TorqueBranch::Floor, 0., false),
        (0., 0., TorqueBranch::Floor, 0., true),
        (cap, 1., TorqueBranch::Cap, 0., false),
        (cap, -1., TorqueBranch::Tracking, -1., false),
    ] {
        let x = Input {
            omega_rad_s: s(0., 0.),
            angular_momentum_rate_nm: s(0., 0.),
            fluid_torque_nm: s(value, d),
        };
        let e = p.evaluate(zero, Shaft::Free, x).unwrap();
        assert_eq!(e.requested_torque_nm.unwrap().value, value);
        assert_eq!(e.branch, branch);
        assert_eq!(e.motor_torque_nm.value, value.min(cap));
        assert_eq!(e.motor_torque_nm.direction, motor_d);
        assert_eq!(e.linearizable, linear);
    }
    // W=0 at omega=0 under capped torque: the work sign kink is one-sided.
    for (d, electric_d, heat_d) in [(1., cap, 0.), (-1., 0., cap)] {
        let x = Input {
            omega_rad_s: s(0., d),
            angular_momentum_rate_nm: s(0., 0.),
            fluid_torque_nm: s(0., 0.),
        };
        let e = p
            .evaluate(Support::Supported(SpeedRequest::Nominal), Shaft::Free, x)
            .unwrap();
        assert_eq!(e.branch, TorqueBranch::Cap);
        assert!(!e.linearizable);
        assert_eq!(e.electric_w.direction, electric_d);
        assert_eq!(e.motor_heat_w.direction, heat_d);
    }
}

#[test]
fn powered_lock_heats_at_standstill_from_the_actual_passage_load() {
    let p = parameters();
    let (t0, cap, l0) = (
        p.nominal_torque_nm(),
        p.torque_cap_nm(),
        p.nominal_conversion_loss_w(),
    );
    // A nominal request at rest reaches the unchanged cap after the actual
    // load is evaluated; the trial omega and its rate do not enter (P:47, P:61).
    for load in [-0.05 * t0, 0., 0.05 * t0] {
        let x = Input {
            omega_rad_s: s(2e-6, 1.),
            angular_momentum_rate_nm: s(40., 2.),
            fluid_torque_nm: s(load, 0.),
        };
        let e = p
            .evaluate(Support::Supported(SpeedRequest::Nominal), Shaft::Locked, x)
            .unwrap();
        assert_eq!(e.branch, TorqueBranch::Cap);
        close(
            e.requested_torque_nm.unwrap().value,
            load + J * OMEGA0 / p.tracking_time_s,
            1e-12,
        );
        assert_eq!(e.motor_work_w.value, 0.);
        assert_eq!(e.drag_torque_nm.value, 0.);
        assert_eq!(e.drag_heat_w.value, 0.);
        close(e.conversion_loss_w.value, 1.5 * 1.5 * l0, 1e-12);
        assert_eq!(e.electric_w.value, e.conversion_loss_w.value);
        assert_eq!(e.motor_heat_w.value, e.conversion_loss_w.value);
        printed(e.motor_heat_w.value, 396622.680, 5e-4); // P:61
        let (residual, constraint) = locked(&e);
        assert_eq!((residual.value, residual.direction), (2e-6, 1.));
        close(constraint.value, -(cap - load), 1e-12);
    }
    // A zero request holds against reverse-flow load with that actual load,
    // not a substituted rated or capped torque (P:47).
    let hold = 0.2 * t0;
    let zero = Support::Supported(SpeedRequest::Zero);
    let e = p
        .evaluate(zero, Shaft::Locked, input(0., 0., hold))
        .unwrap();
    assert_eq!(e.branch, TorqueBranch::Tracking);
    assert_eq!(e.motor_torque_nm.value, hold);
    close(e.motor_heat_w.value, 0.2 * 0.2 * l0, 1e-12);
    assert_eq!(locked(&e).1.value, 0.);
    // Forward-flow load needs no holding torque; the support takes it.
    let e = p
        .evaluate(zero, Shaft::Locked, input(0., 0., -hold))
        .unwrap();
    assert_eq!(e.branch, TorqueBranch::Floor);
    assert_eq!(e.motor_heat_w.value, 0.);
    assert_eq!(locked(&e).1.value, -hold);
    // Withdrawn torque: zero electrical heat, the reaction balances the load.
    let e = p
        .evaluate(Support::Unsupported, Shaft::Locked, input(0., 0., hold))
        .unwrap();
    assert_eq!(e.electric_w.value, 0.);
    assert_eq!(e.motor_heat_w.value, 0.);
    assert_eq!(locked(&e).1.value, hold);
}

#[test]
fn every_signed_combination_closes_energy_and_never_exports_electricity() {
    let p = parameters();
    let (t0, cap) = (p.nominal_torque_nm(), p.torque_cap_nm());
    let mut braking = 0;
    for support in [
        Support::Unsupported,
        Support::Supported(SpeedRequest::Zero),
        Support::Supported(SpeedRequest::Nominal),
        Support::Supported(SpeedRequest::EngineeringTest {
            omega_rad_s: 0.5 * OMEGA0,
        }),
    ] {
        for shaft in [Shaft::Free, Shaft::Locked] {
            for w in [-1.25, -0.5, -1e-3, 0., 1e-3, 0.5, 1., 1.25] {
                for t in [-1.5, -1. / 3., 0., 1. / 3., 1., 1.5] {
                    let (omega, tf) = (w * OMEGA0, t * t0);
                    let x = Input {
                        omega_rad_s: s(omega, 1.),
                        angular_momentum_rate_nm: s(0., 0.),
                        fluid_torque_nm: s(tf, -2.),
                    };
                    let e = p.evaluate(support, shaft, x).unwrap();
                    let (work, loss) = (e.motor_work_w, e.conversion_loss_w);
                    let (electric, heat) = (e.electric_w, e.motor_heat_w);
                    let scale = work.value.abs().max(electric.value).max(1.);
                    // P:44 identity, in value and direction.
                    assert!((electric.value - work.value - heat.value).abs() <= 1e-12 * scale);
                    let d_scale = work.direction.abs().max(electric.direction.abs()).max(1.);
                    assert!(
                        (electric.direction - work.direction - heat.direction).abs()
                            <= 1e-12 * d_scale
                    );
                    assert!(electric.value >= 0. && heat.value >= 0. && loss.value >= 0.);
                    assert!(e.drag_heat_w.value >= 0.);
                    assert!((0. ..=cap).contains(&e.motor_torque_nm.value));
                    if shaft == Shaft::Locked {
                        assert_eq!(work.value, 0.);
                        assert_eq!(e.drag_heat_w.value, 0.);
                    }
                    // P:51: negative work is paid braking heat, never export.
                    if work.value < 0. {
                        braking += 1;
                        assert_eq!(electric.value, loss.value);
                        assert_eq!(heat.value, loss.value - work.value);
                    }
                    if shaft == Shaft::Free {
                        // R:51-52 with the free row solved for dL/dt: electric
                        // input is rotor energy change, fluid work and heats,
                        // dE_rotor/dt=omega*dL/dt.
                        let rate = e.motor_torque_nm.value - tf - e.drag_torque_nm.value;
                        let f = p.evaluate(support, shaft, input(omega, rate, tf)).unwrap();
                        assert!(free(&f).value.abs() <= 1e-12 * rate.abs().max(t0));
                        let ledger =
                            omega * rate + omega * tf + f.drag_heat_w.value - f.motor_work_w.value;
                        assert!(ledger.abs() <= 1e-12 * scale.max(omega.abs() * tf.abs()));
                        close(f.electric_w.value, electric.value, 1e-15);
                    }
                }
            }
        }
    }
    assert!(braking > 0);
}

#[test]
fn reverse_rotation_refuses_start_but_an_energized_rotor_keeps_its_law() {
    assert_eq!(rotor::admit_start(-1e-9), Err(Error::ReverseRotationStart));
    assert_eq!(
        rotor::admit_start(-OMEGA0),
        Err(Error::ReverseRotationStart)
    );
    assert_eq!(rotor::admit_start(0.), Ok(()));
    assert_eq!(rotor::admit_start(OMEGA0), Ok(()));
    assert_eq!(rotor::admit_start(f64::NAN), Err(Error::InvalidInput));
    // P:51: already energized and driven through zero, the drive brakes.
    let p = parameters();
    let t0 = p.nominal_torque_nm();
    let e = p
        .evaluate(
            Support::Supported(SpeedRequest::Nominal),
            Shaft::Free,
            input(-0.1 * OMEGA0, 0., -0.5 * t0),
        )
        .unwrap();
    assert!(e.motor_torque_nm.value > 0. && e.motor_work_w.value < 0.);
    assert_eq!(e.electric_w.value, e.conversion_loss_w.value);
    assert!(e.motor_heat_w.value > e.conversion_loss_w.value);
}

#[test]
fn speed_requests_and_the_supply_envelope_are_explicit() {
    let p = parameters();
    let t0 = p.nominal_torque_nm();
    let x = input(0.4 * OMEGA0, 0., 0.3 * t0);
    for omega in [0., OMEGA0, 1.1 * OMEGA0, -1., f64::NAN, f64::INFINITY] {
        let request = SpeedRequest::EngineeringTest { omega_rad_s: omega };
        assert_eq!(
            p.evaluate(Support::Supported(request), Shaft::Free, x)
                .unwrap_err(),
            Error::InvalidSpeedRequest
        );
    }
    let request = SpeedRequest::EngineeringTest {
        omega_rad_s: 0.5 * OMEGA0,
    };
    let e = p
        .evaluate(Support::Supported(request), Shaft::Free, x)
        .unwrap();
    assert_eq!(e.requested_omega_rad_s, Some(0.5 * OMEGA0));
    assert_eq!(e.branch, TorqueBranch::Tracking);
    close(
        e.requested_torque_nm.unwrap().value,
        0.3 * t0 + DRAG * 0.4 * OMEGA0 + J * 0.1 * OMEGA0 / p.tracking_time_s,
        1e-12,
    );
    for shaft in [Shaft::Free, Shaft::Locked] {
        assert_eq!(
            p.evaluate(Support::OutsideSupplyEnvelope, shaft, x)
                .unwrap_err(),
            Error::UnsupportedSupplyEnvelope
        );
    }
    for bad in [
        Input {
            fluid_torque_nm: s(f64::NAN, 0.),
            ..x
        },
        Input {
            omega_rad_s: s(0., f64::INFINITY),
            ..x
        },
        Input {
            angular_momentum_rate_nm: s(f64::NEG_INFINITY, 0.),
            ..x
        },
    ] {
        assert_eq!(
            p.evaluate(Support::Unsupported, Shaft::Free, bad)
                .unwrap_err(),
            Error::InvalidInput
        );
    }
}

#[test]
fn seizure_is_one_idempotent_energy_credit() {
    let p = parameters();
    let first = p.lock(Shaft::Free, OMEGA0).unwrap();
    assert_eq!(first.shaft, Shaft::Locked);
    let event = first.event.unwrap();
    close(
        event.removed_kinetic_energy_j,
        0.5 * J * OMEGA0 * OMEGA0,
        1e-15,
    );
    printed(event.removed_kinetic_energy_j, 21.153210e6, 0.5); // P:61
    close(event.rotor_angular_impulse_nms, -J * OMEGA0, 1e-15);
    assert_eq!(
        event.support_angular_impulse_nms,
        -event.rotor_angular_impulse_nms
    );
    for omega in [OMEGA0, 0., -3.] {
        assert_eq!(
            p.lock(first.shaft, omega).unwrap(),
            Locking {
                shaft: Shaft::Locked,
                event: None
            }
        );
    }
    let reverse = p.lock(Shaft::Free, -0.5 * OMEGA0).unwrap().event.unwrap();
    close(
        reverse.removed_kinetic_energy_j,
        0.125 * J * OMEGA0 * OMEGA0,
        1e-15,
    );
    close(reverse.rotor_angular_impulse_nms, 0.5 * J * OMEGA0, 1e-15);
    let rest = p.lock(Shaft::Free, 0.).unwrap().event.unwrap();
    assert_eq!(rest.removed_kinetic_energy_j, 0.);
    assert_eq!(p.lock(Shaft::Free, f64::NAN), Err(Error::InvalidInput));
}

#[test]
fn seizure_keeps_support_and_intent_and_only_a_prepared_release_frees() {
    let p = parameters();
    let t0 = p.nominal_torque_nm();
    let support = Support::Supported(SpeedRequest::Nominal);
    let load = -0.05 * t0;
    let lock = p.lock(Shaft::Free, OMEGA0).unwrap();
    // The unchanged support value keeps an energized lock heating: no trip.
    let e = p
        .evaluate(support, lock.shaft, input(0., 0., load))
        .unwrap();
    assert_eq!(e.branch, TorqueBranch::Cap);
    assert!(e.motor_heat_w.value > 0.);
    // Actual STOP withdraws torque and heat; the constraint persists (R:75).
    let e = p
        .evaluate(Support::Unsupported, lock.shaft, input(0., 0., load))
        .unwrap();
    assert_eq!(e.motor_heat_w.value, 0.);
    assert_eq!(locked(&e).1.value, load);
    for (electrically_isolated, retained_stop) in [(false, false), (true, false), (false, true)] {
        assert_eq!(
            rotor::release(ReleasePreparation {
                electrically_isolated,
                retained_stop
            }),
            Err(Error::ReleaseNotPrepared)
        );
    }
    let released = rotor::release(ReleasePreparation {
        electrically_isolated: true,
        retained_stop: true,
    })
    .unwrap();
    assert_eq!(released, Shaft::Free);
    // Released from rest, forward flow load windmills it forward (R:75).
    let e = p
        .evaluate(Support::Unsupported, released, input(0., 0., load))
        .unwrap();
    assert_eq!(free(&e).value, load);
}

fn shifted(x: Input, h: f64) -> Input {
    let m = |a: Scalar| s(a.value + h * a.direction, 0.);
    Input {
        omega_rad_s: m(x.omega_rad_s),
        angular_momentum_rate_nm: m(x.angular_momentum_rate_nm),
        fluid_torque_nm: m(x.fluid_torque_nm),
    }
}
fn outputs(e: &Evaluation) -> [Scalar; 10] {
    let (a, b) = match e.rotor {
        RotorRow::Free { residual_nm } => (residual_nm, s(0., 0.)),
        RotorRow::Locked {
            residual_rad_s,
            constraint_torque_nm,
        } => (residual_rad_s, constraint_torque_nm),
    };
    [
        e.requested_torque_nm.unwrap_or(s(0., 0.)),
        e.motor_torque_nm,
        e.drag_torque_nm,
        e.motor_work_w,
        e.conversion_loss_w,
        e.electric_w,
        e.motor_heat_w,
        e.drag_heat_w,
        a,
        b,
    ]
}

#[test]
fn directions_match_centred_differences_away_from_branch_points() {
    let p = parameters();
    let t0 = p.nominal_torque_nm();
    let x = |w: f64, dw: f64, rate: f64, drate: f64, t: f64, dt: f64| Input {
        omega_rad_s: s(w * OMEGA0, dw),
        angular_momentum_rate_nm: s(rate, drate),
        fluid_torque_nm: s(t * t0, dt),
    };
    let nominal = Support::Supported(SpeedRequest::Nominal);
    let zero = Support::Supported(SpeedRequest::Zero);
    let test = Support::Supported(SpeedRequest::EngineeringTest {
        omega_rad_s: 0.5 * OMEGA0,
    });
    for (support, shaft, input, branch) in [
        (
            nominal,
            Shaft::Free,
            x(0.8, 3., 2., 0.5, 0.9, -40.),
            TorqueBranch::Tracking,
        ),
        (
            zero,
            Shaft::Free,
            x(-0.3, 2., -1., 0.2, -0.2, 25.),
            TorqueBranch::Tracking,
        ),
        (
            test,
            Shaft::Free,
            x(0.5, -1., 0., 1., 0.3, 10.),
            TorqueBranch::Tracking,
        ),
        (
            nominal,
            Shaft::Free,
            x(0.05, 4., 1., 0., 0.5, 30.),
            TorqueBranch::Cap,
        ),
        (
            zero,
            Shaft::Free,
            x(1., 2., -3., 0.1, 1., 15.),
            TorqueBranch::Floor,
        ),
        (
            Support::Unsupported,
            Shaft::Free,
            x(-0.4, 1.5, -2., 0.3, 0.2, -20.),
            TorqueBranch::Withdrawn,
        ),
        (
            zero,
            Shaft::Locked,
            x(1e-6, 0.7, 5., 1., 0.1, 35.),
            TorqueBranch::Tracking,
        ),
        (
            nominal,
            Shaft::Locked,
            x(-1e-6, 0.3, 0., 0., -0.05, 12.),
            TorqueBranch::Cap,
        ),
    ] {
        let e = p.evaluate(support, shaft, input).unwrap();
        assert_eq!(e.branch, branch);
        assert!(e.linearizable);
        let h = 1e-2;
        let plus = p.evaluate(support, shaft, shifted(input, h)).unwrap();
        let minus = p.evaluate(support, shaft, shifted(input, -h)).unwrap();
        assert_eq!((plus.branch, minus.branch), (branch, branch));
        for ((a, b), d) in outputs(&plus)
            .into_iter()
            .zip(outputs(&minus))
            .zip(outputs(&e))
        {
            close((a.value - b.value) / (2. * h), d.direction, 1e-8);
        }
    }
}
