use leitbild_operating_plant::phase::{self, Stock};
use leitbild_operating_water::{Branch, If97, WaterPoint, directional, point};

fn close(a: f64, b: f64, relative: f64) {
    assert!(
        (a - b).abs() <= relative * a.abs().max(b.abs()).max(1.),
        "{a} != {b}"
    );
}
fn stock(v: f64, q: WaterPoint) -> Stock {
    Stock {
        mass_kg: v * q.density_kg_m3,
        internal_energy_j: v * q.density_kg_m3 * q.internal_energy_j_kg,
    }
}

#[test]
fn actual_c_abi_si_properties_and_endpoint_identities() {
    let q = point(Branch::Liquid, 3e6, 300.).unwrap();
    // Published IF97 region-1 verification density, not an LD-01 fitted value.
    close(q.density_kg_m3, 997.852940098482, 1e-11);
    close(
        q.enthalpy_j_kg,
        q.internal_energy_j_kg + q.pressure_pa / q.density_kg_m3,
        2e-13,
    );
    for p in [1e5, 6e6, 15.2e6, 16e6] {
        let l = point(Branch::SaturatedLiquid, p, 0.).unwrap();
        let g = point(Branch::SaturatedVapor, p, 0.).unwrap();
        assert_eq!(l.temperature_k, g.temperature_k);
        assert_eq!(l.pressure_pa, g.pressure_pa);
        assert!(l.density_kg_m3 > g.density_kg_m3);
        assert!(g.enthalpy_j_kg > l.enthalpy_j_kg);
        for a in [l, g] {
            close(
                a.enthalpy_j_kg,
                a.internal_energy_j_kg + p / a.density_kg_m3,
                2e-13,
            );
        }
    }
    assert!(point(Branch::Liquid, 17e6 + 1., 600.).is_err());
    assert!(point(Branch::Liquid, 15.2e6, 650.).is_err());
    assert!(point(Branch::Vapor, 6e6, 300.).is_err());
    assert!(point(Branch::Liquid, f64::NAN, 600.).is_err());
}

#[test]
fn exact_thermodynamic_partials_follow_real_forward_branch() {
    for (branch, p, t) in [(Branch::Liquid, 15.2e6, 580.), (Branch::Vapor, 6e6, 600.)] {
        let q = point(branch, p, t).unwrap().phase_point();
        let dp = 100.;
        let dt = 0.001;
        let ap = point(branch, p + dp, t).unwrap();
        let bp = point(branch, p - dp, t).unwrap();
        let at = point(branch, p, t + dt).unwrap();
        let bt = point(branch, p, t - dt).unwrap();
        close(
            q.density_pressure,
            (ap.density_kg_m3 - bp.density_kg_m3) / (2. * dp),
            1e-10,
        );
        close(
            q.density_temperature,
            (at.density_kg_m3 - bt.density_kg_m3) / (2. * dt),
            2e-8,
        );
        close(
            q.energy_pressure,
            (ap.internal_energy_j_kg - bp.internal_energy_j_kg) / (2. * dp),
            2e-8,
        );
        close(
            q.energy_temperature,
            (at.internal_energy_j_kg - bt.internal_energy_j_kg) / (2. * dt),
            2e-8,
        );
    }
}

#[test]
fn separated_two_temperature_chart_jacobian_uses_actual_same_trial_points() {
    let p = 6e6;
    let ts = point(Branch::SaturatedLiquid, p, 0.).unwrap().temperature_k;
    let l = point(Branch::Liquid, p, ts - 10.).unwrap();
    let g = point(Branch::Vapor, p, ts + 20.).unwrap();
    let ml = stock(6., l);
    let mg = stock(4., g);
    let c =
        phase::separated_constraints(10., 6., ml, mg, l.phase_point(), g.phase_point()).unwrap();
    for r in c.residual {
        close(r, 0., 1e-12);
    }
    // The two temperatures are genuinely different; no equilibrium reset.
    assert_eq!(g.temperature_k - l.temperature_k, 30.);
    let d = [1e4, -2., 3., 0.02];
    let h = 1e-4;
    let probe = |s: f64| {
        let a = point(Branch::Liquid, p + s * d[0], l.temperature_k + s * d[1]).unwrap();
        let b = point(Branch::Vapor, p + s * d[0], g.temperature_k + s * d[2]).unwrap();
        phase::separated_constraints(10., 6. + s * d[3], ml, mg, a.phase_point(), b.phase_point())
            .unwrap()
            .residual
    };
    let a = probe(h);
    let b = probe(-h);
    for i in 0..4 {
        let analytic: f64 = c.algebraic_jacobian[i]
            .iter()
            .zip(d)
            .map(|(x, v)| x * v)
            .sum();
        close(analytic, (a[i] - b[i]) / (2. * h), 2e-6);
    }
}

#[test]
fn actual_sg_saturation_endpoints_have_conservative_nonseeded_birth_tangent() {
    let p = 6e6;
    let v = 120.;
    let l = point(Branch::SaturatedLiquid, p, 0.).unwrap();
    let g = point(Branch::SaturatedVapor, p, 0.).unwrap();
    for vl in [0., 72., v] {
        let c = phase::equilibrium_chart(
            v,
            vl,
            l.phase_point(),
            g.phase_point(),
            l.saturation_slope_k_pa,
        )
        .unwrap();
        let rates = c.rates(0., 1e6).unwrap();
        let [mp, mv, ep, ev] = c.derivative;
        close(mp * rates[0] + mv * rates[1], 0., 1e-10);
        close(ep * rates[0] + ev * rates[1], 1e6, 1e-12);
        if vl == v {
            // A sealed full liquid heats INTO the compressed-liquid branch,
            // not necessarily into boiling. Real saturated-liquid withdrawal
            // instead creates a flash-volume tangent at this endpoint.
            assert!(rates[1] > 0.);
            let flashing = c.rates(-1., -l.enthalpy_j_kg).unwrap();
            assert!(flashing[1] < 0., "withdrawal opens physical vapor volume");
        }
    }
    // No stocks are altered by changing only a boundary's coordinate chart.
    let q = phase::equilibrium_chart(
        v,
        v,
        l.phase_point(),
        g.phase_point(),
        l.saturation_slope_k_pa,
    )
    .unwrap();
    let r = phase::single_constraints(
        v,
        Stock {
            mass_kg: q.mass_kg,
            internal_energy_j: q.internal_energy_j,
        },
        l.phase_point(),
    )
    .unwrap()
    .0;
    for x in r {
        close(x, 0., 1e-8);
    }
}

#[test]
fn all_thermal_property_seeds_are_real_not_frozen() {
    use leitbild_operating_plant::thermal::{Scalar, WaterProperties};
    for branch in [
        Branch::Liquid,
        Branch::Vapor,
        Branch::SaturatedLiquid,
        Branch::SaturatedVapor,
    ] {
        let p = 6e6;
        let ts = point(Branch::SaturatedLiquid, p, 0.).unwrap().temperature_k;
        let t = match branch {
            Branch::Liquid => ts - 10.,
            Branch::Vapor => ts + 20.,
            _ => ts,
        };
        let (q, d) = directional(branch, p, t, 10000., 2.).unwrap();
        let h = 1e-4;
        let a = point(branch, p + h * 10000., t + h * 2.).unwrap();
        let b = point(branch, p - h * 10000., t - h * 2.).unwrap();
        for (derivative, probe) in [
            (d.cp_j_kg_k, (a.cp_j_kg_k - b.cp_j_kg_k) / (2. * h)),
            (
                d.expansion_per_k,
                (a.expansion_per_k - b.expansion_per_k) / (2. * h),
            ),
            (
                d.viscosity_pa_s,
                (a.viscosity_pa_s - b.viscosity_pa_s) / (2. * h),
            ),
            (
                d.conductivity_w_m_k,
                (a.conductivity_w_m_k - b.conductivity_w_m_k) / (2. * h),
            ),
        ] {
            assert!(derivative != 0.);
            assert!(
                (derivative - probe).abs() <= 1e-5 * probe.abs().max(1e-18),
                "{derivative} vs {probe}"
            );
        }
        let (same, zero) = directional(branch, p, t, 0., 0.).unwrap();
        assert_eq!(same.density_kg_m3, q.density_kg_m3);
        assert_eq!(zero.viscosity_pa_s, 0.);
    }
    let sat = If97.saturation(Scalar::new(6e6, 10000.)).unwrap();
    assert!(sat.surface_tension.value > 0.);
    assert!(sat.surface_tension.direction < 0.);
    let q = If97
        .saturated_vapor_density(Scalar::new(sat.temperature.value, 1.))
        .unwrap();
    assert!(q.direction > 0.);
    close(q.value, sat.vapor.density.value, 1e-12);
}

#[test]
fn coefficient_derivatives_at_a_boundary_probe_inward_without_clipping() {
    let p = 16e6;
    let t = point(Branch::SaturatedLiquid, p, 0.).unwrap().temperature_k;
    // Outward positive-temperature trial direction uses a second-order inward
    // coefficient probe, while the physical query remains exactly at the root.
    let (q, d) = directional(Branch::Liquid, p, t, 0., 1.).unwrap();
    assert_eq!(q.pressure_pa, p);
    assert_eq!(q.temperature_k, t);
    let h = 0.001;
    let a = point(Branch::Liquid, p, t - h).unwrap();
    let b = point(Branch::Liquid, p, t - 2. * h).unwrap();
    let probe = (3. * q.viscosity_pa_s - 4. * a.viscosity_pa_s + b.viscosity_pa_s) / (2. * h);
    assert!((probe - d.viscosity_pa_s).abs() <= 1e-5 * probe.abs());
    assert!(directional(Branch::Liquid, 17e6 + 1., t, 0., 0.).is_err());
}
