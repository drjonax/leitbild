//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#actual-local-pressure-pilot-and-step-work-blocker
//! Checks of the composed network's constituent identities with maintained
//! IF97. Advancing scenario evidence lives in the S1 hydraulics harness.
#![cfg(feature = "ida")]
use leitbild_operating_plant::{
    network::{
        Network, Reuse, Tolerances, Water, empty_energy_ratio,
        packet::Packet,
        properties::{inverse, saturation},
    },
    thermal::{self, Scalar, WaterProperties},
};
use leitbild_operating_water::{Branch, If97, point};
use serde_json::json;

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn rec(v: f64, d: f64) -> Scalar {
    Scalar::new(v, d)
}

#[test]
fn changed_void_section_work_uses_physical_profile_not_upwind_mass() {
    // Actual first-section parallel/serial weights, changed void, nonuniform
    // signed face flows and donor densities. This is an independent port-work
    // identity; it does not qualify a two-phase pump constitutive law.
    let weights = [0.5, 0.5, 0.5];
    let flow = [rec(1.2, 0.13), rec(-0.4, 0.07), rec(0.7, -0.11)];
    let aperture = rec(0.73, 0.08);
    let local_density = rec(650., -2.3);
    let drive = rec(2e5, 3e3);
    let profile = weights
        .iter()
        .zip(flow)
        .fold(s(0.), |sum, (w, q)| sum + s(*w) * q);
    let component_massflow = local_density * aperture * profile;
    let port_power = component_massflow / local_density * drive;
    let physical_force_power = weights
        .iter()
        .zip(flow)
        .fold(s(0.), |sum, (w, q)| sum + q * s(*w) * aperture * drive);
    let defect = port_power - physical_force_power;
    assert!(defect.value.abs() <= 8. * f64::EPSILON * port_power.value.abs());
    assert!(defect.direction.abs() <= 8. * f64::EPSILON * port_power.direction.abs());
    let donor_density = [510., 730., 610.];
    let donor_aperture = [0.9, 0.6, 0.82];
    let old_donor_mass = (0..3)
        .map(|j| weights[j] * donor_density[j] * donor_aperture[j] * flow[j].value)
        .sum::<f64>();
    assert!(
        (old_donor_mass / local_density.value * drive.value - port_power.value).abs()
            > 0.01 * port_power.value.abs()
    );
}

#[test]
fn numerical_empty_energy_admission_preserves_raw_values_and_rejects_excess() {
    let raw = [-1.3261133868407258e-45, 0., 10.];
    let before = raw.map(f64::to_bits);
    for energy in raw {
        assert!(empty_energy_ratio(energy, 10.).unwrap() <= 1.);
    }
    assert_eq!(raw.map(f64::to_bits), before);
    assert!(empty_energy_ratio(10.0001, 10.).is_err());
    assert!(empty_energy_ratio(-10.0001, 10.).is_err());
    assert!(empty_energy_ratio(f64::NAN, 10.).is_err());
    assert!(empty_energy_ratio(0., 0.).is_err());
}

fn water_bits(q: Water) -> [u64; 10] {
    [
        q.pressure_pa,
        q.temperature_k,
        q.density_kg_m3,
        q.internal_energy_j_kg,
        q.enthalpy_j_kg,
        q.cp_j_kg_k,
        q.expansion_per_k,
        q.compressibility_per_pa,
        q.viscosity_pa_s,
        q.conductivity_w_m_k,
    ]
    .map(f64::to_bits)
}
fn saturation_bits(q: thermal::Saturation) -> [[u64; 2]; 14] {
    [
        q.temperature,
        q.surface_tension,
        q.liquid.density,
        q.liquid.viscosity,
        q.liquid.conductivity,
        q.liquid.cp,
        q.liquid.expansion,
        q.liquid.enthalpy,
        q.vapor.density,
        q.vapor.viscosity,
        q.vapor.conductivity,
        q.vapor.cp,
        q.vapor.expansion,
        q.vapor.enthalpy,
    ]
    .map(|s| [s.value.to_bits(), s.direction.to_bits()])
}

#[test]
fn exact_current_property_reuse_matches_uncached_and_invalidates_every_key() {
    let mut reuse: Reuse<_> = Reuse::new(1, 1);
    for (k, p, t) in [
        (0, 15e6, 600.),
        (0, 15.01e6, 600.2),
        (1, 15e6, 630.),
        (1, 15.01e6, 630.2),
    ] {
        let q = point(
            if k == 0 {
                Branch::Liquid
            } else {
                Branch::Vapor
            },
            p,
            t,
        )
        .unwrap();
        for enthalpy in [false, true] {
            let target = if enthalpy {
                q.enthalpy_j_kg
            } else {
                q.internal_energy_j_kg
            };
            for (dp, de) in [(0., 0.), (2e4, 0.), (0., 1000.), (-3e4, 3000.)] {
                let expected =
                    inverse(&If97, rec(p, dp), rec(target, de), k, enthalpy, None).unwrap();
                let actual = inverse(
                    &If97,
                    rec(p, dp),
                    rec(target, de),
                    k,
                    enthalpy,
                    Some((&mut reuse, 0)),
                )
                .unwrap();
                assert_eq!(water_bits(actual.0), water_bits(expected.0));
                assert_eq!(water_bits(actual.1), water_bits(expected.1));
                assert_eq!(
                    reuse.caloric_key(0, k),
                    Some((p.to_bits(), target.to_bits(), enthalpy))
                );
            }
        }
    }
    assert!(inverse(&If97, s(17e6), s(1e6), 0, false, Some((&mut reuse, 0))).is_err());
    assert!(reuse.caloric_key(0, 0).is_none());
    let q = point(Branch::Liquid, 15e6, 600.).unwrap();
    inverse(
        &If97,
        s(15e6),
        s(q.internal_energy_j_kg),
        0,
        false,
        Some((&mut reuse, 0)),
    )
    .unwrap();
    assert!(
        inverse(
            &If97,
            rec(15e6, f64::NAN),
            s(q.internal_energy_j_kg),
            0,
            false,
            Some((&mut reuse, 0))
        )
        .is_err()
    );
    assert!(reuse.caloric_key(0, 0).is_none());
    for p in [15e6, 15e6, 15.01e6] {
        assert_eq!(
            saturation_bits(saturation(&If97, s(p), Some((&mut reuse, 0))).unwrap()),
            saturation_bits(If97.saturation(s(p)).unwrap())
        );
        let (key, held) = reuse.saturation_entry(0).unwrap();
        assert_eq!(key, p.to_bits());
        assert_eq!(
            saturation_bits(saturation(&If97, rec(p, 2e4), Some((&mut reuse, 0))).unwrap()),
            saturation_bits(If97.saturation(rec(p, 2e4)).unwrap())
        );
        assert_eq!(
            saturation_bits(reuse.saturation_entry(0).unwrap().1),
            saturation_bits(held)
        );
    }
    assert!(saturation(&If97, s(f64::NAN), Some((&mut reuse, 0))).is_err());
    assert!(reuse.saturation_entry(0).is_none());
}

#[test]
#[ignore = "requires actual compiled owner packet and maintained IF97"]
fn actual_prepared_network_admits_and_evaluates() {
    let path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET").unwrap();
    let packet: Packet = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let (mut network, prepared) = Network::new(&packet, If97).unwrap();
    network
        .select_leading_receipts(&prepared.y, &prepared.yp)
        .unwrap();
    let atol = vec![1e-8; prepared.y.len()];
    let tolerance = Tolerances {
        relative: 1e-6,
        absolute: &atol,
    };
    let (_, inventory) = network.inventory(&prepared.y, tolerance).unwrap();
    network
        .evaluate(0., &prepared.y, &prepared.yp, None, 0., None)
        .unwrap();
    let budget = network.current_budget(&prepared.y, &prepared.yp);
    println!(
        "{}",
        json!({"kind":"prepared-network-admission","packet":path,"unknowns":network.dimension(),"inventory":inventory,"current_budget":budget})
    );
}
