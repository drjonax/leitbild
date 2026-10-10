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

#[test]
#[ignore = "requires actual compiled owner packet and maintained IF97"]
fn structural_pattern_contains_sampled_dense_jacobians() {
    use leitbild_operating_plant::network::CscOut;
    let path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET").unwrap();
    let packet: Packet = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let (mut network, prepared) = Network::new(&packet, If97).unwrap();
    network
        .select_leading_receipts(&prepared.y, &prepared.yp)
        .unwrap();
    let pattern = network.structural_pattern();
    let n = prepared.y.len();
    let nnz: usize = pattern.iter().map(Vec::len).sum();
    let mut states = vec![prepared.y.clone()];
    for (sign, magnitude) in [(1., 0.015), (-1., 0.02)] {
        let mut y = prepared.y.clone();
        for (j, l) in network.face_layout.iter().enumerate() {
            let liquid_supports = packet.mechanics.faces[l.face]
                .supports
                .iter()
                .all(|s| network.cell_layout[s.region].phase == 0);
            if l.phase == 0 && liquid_supports && j % 5 != 0 {
                y[l.index] = sign * magnitude * if j % 2 == 0 { 1. } else { -0.6 };
            }
        }
        states.push(y);
    }
    let mut checked = 0usize;
    let mut largest_dense = 0usize;
    for y in &states {
        let (mut data, mut rows, mut pointers) =
            (vec![0.; n * n], vec![0i64; n * n], vec![0i64; n + 1]);
        network
            .jacobian_dense(
                0.,
                1.3,
                y,
                &prepared.yp,
                CscOut {
                    data: &mut data,
                    rows: &mut rows,
                    pointers: &mut pointers,
                },
            )
            .unwrap();
        let mut dense_nnz = 0;
        for col in 0..n {
            for row in 0..n {
                let v = data[col * n + row];
                if v != 0. {
                    dense_nnz += 1;
                    assert!(
                        pattern[col].binary_search(&row).is_ok(),
                        "dense entry outside structural pattern: row {row} col {col} value {v}"
                    );
                }
                checked += 1;
            }
        }
        largest_dense = largest_dense.max(dense_nnz);
    }
    println!(
        "{}",
        json!({"kind":"structural-pattern-containment","packet":path,"unknowns":n,"structural_nonzeros":nnz,"dense_entries_checked":checked,"largest_sampled_dense_nonzeros":largest_dense,"states":states.len()})
    );
}

#[test]
#[ignore = "requires actual compiled owner packet and maintained IF97"]
fn colored_jacobian_equals_dense_jacobian_bitwise() {
    use leitbild_operating_plant::{network::CscOut, sparse::compare_with_dense};
    let path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET").unwrap();
    let packet: Packet = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let (mut network, prepared) = Network::new(&packet, If97).unwrap();
    network
        .select_leading_receipts(&prepared.y, &prepared.yp)
        .unwrap();
    let structure = network.sparse_jacobian().unwrap();
    let n = prepared.y.len();
    let mut mixed = prepared.y.clone();
    for (j, l) in network.face_layout.iter().enumerate() {
        let liquid = packet.mechanics.faces[l.face]
            .supports
            .iter()
            .all(|s| network.cell_layout[s.region].phase == 0);
        if l.phase == 0 && liquid && j % 3 != 0 {
            mixed[l.index] = if j % 2 == 0 { 0.02 } else { -0.013 };
        }
    }
    let mut reports = Vec::new();
    for y in [&prepared.y, &mixed] {
        let (mut dense, mut rows, mut pointers) =
            (vec![0.; n * n], vec![0i64; n * n], vec![0i64; n + 1]);
        network
            .jacobian_dense(
                0.,
                2.1,
                y,
                &prepared.yp,
                CscOut {
                    data: &mut dense,
                    rows: &mut rows,
                    pointers: &mut pointers,
                },
            )
            .unwrap();
        let before = network.counters;
        let mut values = vec![0.; structure.pattern.nonzeros()];
        let started = std::time::Instant::now();
        network
            .jacobian_colored(0., 2.1, y, &prepared.yp, &structure, &mut values)
            .unwrap();
        let colored_wall = started.elapsed().as_secs_f64();
        let comparison = compare_with_dense(&structure.pattern, &values, &dense).unwrap();
        assert!(comparison.is_bitwise_exact(), "{comparison:?}");
        reports.push(json!({"colors":structure.coloring.count(),"structural_nonzeros":structure.pattern.nonzeros(),"colored_wall_s":colored_wall,"evaluations":network.counters.evaluations-before.evaluations}));
    }
    println!(
        "{}",
        json!({"kind":"colored-jacobian-bitwise-gate","packet":path,"unknowns":n,"states":reports})
    );
}
