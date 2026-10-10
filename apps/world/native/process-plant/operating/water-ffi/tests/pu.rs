use leitbild_operating_water::{
    Branch, CaloricLinearization, Error, WaterPoint, directional, directional_ph, directional_pu,
    point, point_ph, point_pu,
};

fn tuple(q: WaterPoint) -> [f64; 13] {
    [
        q.pressure_pa,
        q.temperature_k,
        q.density_kg_m3,
        q.internal_energy_j_kg,
        q.enthalpy_j_kg,
        q.cp_j_kg_k,
        q.cv_j_kg_k,
        q.expansion_per_k,
        q.compressibility_per_pa,
        q.viscosity_pa_s,
        q.conductivity_w_m_k,
        q.saturation_slope_k_pa,
        q.region as f64,
    ]
}

#[test]
fn prepared_caloric_points_reuse_values_not_derivatives_or_other_states() {
    for (branch, p, t) in [
        (Branch::Liquid, 1e5, 300.),
        (Branch::Liquid, 15e6, 600.),
        (Branch::Vapor, 1e5, 450.),
        (Branch::Vapor, 15e6, 630.),
    ] {
        let forward = point(branch, p, t).unwrap();
        for enthalpy in [false, true] {
            let recovered = if enthalpy {
                CaloricLinearization::enthalpy(branch, p, forward.enthalpy_j_kg)
            } else {
                CaloricLinearization::internal_energy(branch, p, forward.internal_energy_j_kg)
            }
            .unwrap();
            let q = recovered.point();
            assert!((q.temperature_k - t).abs() < 2e-8);
            for (dp, de) in [(0., 0.), (1e4, 0.), (0., 2000.), (-3e4, 5000.)] {
                // Independent direct native oracle at the recovered current
                // point; no one-shot caloric helper calls the code under test.
                let (ep, et) = if enthalpy {
                    (
                        (1. - q.temperature_k * q.expansion_per_k) / q.density_kg_m3,
                        q.cp_j_kg_k,
                    )
                } else {
                    (
                        (p * q.compressibility_per_pa - q.temperature_k * q.expansion_per_k)
                            / q.density_kg_m3,
                        q.cp_j_kg_k - p * q.expansion_per_k / q.density_kg_m3,
                    )
                };
                let expected = if dp == 0. && de == 0. {
                    WaterPoint::default()
                } else {
                    directional(branch, p, q.temperature_k, dp, (de - ep * dp) / et)
                        .unwrap()
                        .1
                };
                let actual = recovered.directional(dp, de).unwrap();
                assert_eq!(tuple(actual), tuple(expected));
                assert_eq!(tuple(recovered.point()), tuple(q));
            }
            assert_eq!(
                recovered.directional(f64::NAN, 0.).unwrap_err(),
                Error::Domain
            );
            assert_eq!(
                recovered.directional(0., f64::INFINITY).unwrap_err(),
                Error::Domain
            );
        }
        // A new pressure requires another actual recovery; neither an earlier
        // direction nor constructing another point mutates the prior one.
        let other =
            CaloricLinearization::internal_energy(branch, p * 1.001, forward.internal_energy_j_kg)
                .unwrap();
        assert_eq!(other.point().pressure_pa, p * 1.001);
        assert_ne!(other.point().temperature_k, forward.temperature_k);
    }
}

#[test]
fn maintained_pu_inverse_recovers_both_stable_branches_and_exact_endpoints() {
    for p in [1e5, 1e6, 15e6, 16e6] {
        let liquid = point(Branch::SaturatedLiquid, p, 0.).unwrap();
        let vapor = point(Branch::SaturatedVapor, p, 0.).unwrap();
        for (branch, t) in [
            (Branch::Liquid, 273.15),
            (Branch::Liquid, 0.5 * (273.15 + liquid.temperature_k)),
            (Branch::Liquid, liquid.temperature_k),
            (Branch::Vapor, vapor.temperature_k),
            (Branch::Vapor, 0.5 * (vapor.temperature_k + 1073.15)),
            (Branch::Vapor, 1073.15),
        ] {
            let expected = point(branch, p, t).unwrap();
            let actual = point_pu(branch, p, expected.internal_energy_j_kg).unwrap();
            assert!((actual.temperature_k - t).abs() < 2e-8);
            assert!(
                (actual.internal_energy_j_kg - expected.internal_energy_j_kg).abs()
                    <= 2.1e-12
                        * expected
                            .internal_energy_j_kg
                            .abs()
                            .max(expected.cp_j_kg_k * t)
                            .max(1.)
            );
            assert_eq!(actual.region, expected.region);
            let birth = point_ph(branch, p, expected.enthalpy_j_kg).unwrap();
            assert!((birth.temperature_k - t).abs() < 2e-8);
        }
    }
}

#[test]
fn incoming_enthalpy_inverse_has_its_own_correct_implicit_direction() {
    let p = 15e6;
    let dp = 120_000.;
    let dh = 30_000.;
    let step = 1e-4;
    for (branch, t) in [(Branch::Liquid, 600.), (Branch::Vapor, 630.)] {
        let h = point(branch, p, t).unwrap().enthalpy_j_kg;
        let (_, d) = directional_ph(branch, p, h, dp, dh).unwrap();
        let a = point_ph(branch, p + step * dp, h + step * dh).unwrap();
        let b = point_ph(branch, p - step * dp, h - step * dh).unwrap();
        assert!((d.enthalpy_j_kg - dh).abs() < 1e-8);
        assert!((d.temperature_k - (a.temperature_k - b.temperature_k) / (2. * step)).abs() < 1e-6);
        assert!((d.density_kg_m3 - (a.density_kg_m3 - b.density_kg_m3) / (2. * step)).abs() < 1e-6);
    }
}

#[test]
fn implicit_pu_direction_matches_independent_changed_pressure_energy_points() {
    let p = 15e6;
    let dp = 120_000.;
    let du = 30_000.;
    let step = 1e-4;
    for (branch, t) in [(Branch::Liquid, 600.), (Branch::Vapor, 630.)] {
        let u = point(branch, p, t).unwrap().internal_energy_j_kg;
        let (q, d) = directional_pu(branch, p, u, dp, du).unwrap();
        let a = point_pu(branch, p + step * dp, u + step * du).unwrap();
        let b = point_pu(branch, p - step * dp, u - step * du).unwrap();
        assert!((q.temperature_k - t).abs() < 2e-8);
        assert!((d.internal_energy_j_kg - du).abs() < 1e-8);
        for (actual, finite) in [
            (
                d.temperature_k,
                (a.temperature_k - b.temperature_k) / (2. * step),
            ),
            (
                d.density_kg_m3,
                (a.density_kg_m3 - b.density_kg_m3) / (2. * step),
            ),
            (
                d.enthalpy_j_kg,
                (a.enthalpy_j_kg - b.enthalpy_j_kg) / (2. * step),
            ),
            (d.cp_j_kg_k, (a.cp_j_kg_k - b.cp_j_kg_k) / (2. * step)),
        ] {
            assert!(
                (actual - finite).abs() < 3e-6 * actual.abs().max(1.),
                "{actual} versus {finite}"
            );
        }
    }
}

#[test]
fn pu_does_not_flash_clamp_or_query_an_undefined_phase() {
    let p = 15e6;
    let l = point(Branch::SaturatedLiquid, p, 0.).unwrap();
    let g = point(Branch::SaturatedVapor, p, 0.).unwrap();
    let gap = 0.5 * (l.internal_energy_j_kg + g.internal_energy_j_kg);
    // Between the saturated energies lies no state of either branch: the gap
    // is beyond both bounded metastable trial bands, never a flash.
    assert_eq!(
        point_pu(Branch::Liquid, p, gap).unwrap_err(),
        Error::TrialBand
    );
    assert_eq!(
        point_pu(Branch::Vapor, p, gap).unwrap_err(),
        Error::TrialBand
    );
    assert_eq!(
        point_pu(Branch::Liquid, p, f64::NAN).unwrap_err(),
        Error::Domain
    );
    assert_eq!(
        point_pu(Branch::Liquid, 17.5e6, l.internal_energy_j_kg).unwrap_err(),
        Error::Domain
    );
    assert_eq!(
        point_pu(Branch::SaturatedLiquid, p, l.internal_energy_j_kg).unwrap_err(),
        Error::AbiArgument
    );
    assert!(directional_pu(Branch::Vapor, p, g.internal_energy_j_kg, f64::NAN, 0.).is_err());

    // IF97's energy datum crosses zero in ordinary cold liquid. Inverse
    // convergence must not become impossible merely because U is near zero.
    let cold = point_pu(Branch::Liquid, 1e5, 0.).unwrap();
    assert!(cold.temperature_k > 273.15 && cold.temperature_k < 274.);
    let ut = cold.cp_j_kg_k - 1e5 * cold.expansion_per_k / cold.density_kg_m3;
    assert!(cold.internal_energy_j_kg.abs() <= 2e-12 * ut * cold.temperature_k);
}
