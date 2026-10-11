use leitbild_operating_plant::thermal::*;
const PI: f64 = std::f64::consts::PI;
fn c(x: f64) -> Scalar {
    Scalar::constant(x)
}
fn close(a: f64, b: f64, tol: f64) {
    assert!((a - b).abs() <= tol * (1. + b.abs()), "{a} != {b}");
}
fn geom() -> FuelGeometry {
    FuelGeometry {
        fuel_radius_m: 0.0041,
        clad_inner_radius_m: 0.00418,
        clad_outer_radius_m: 0.00475,
        rod_length_m: 2.,
        rods: 264.,
        helium_volume_m3: 0.002,
        helium_nr_j_k: 20.,
        accommodation: 0.287,
        fuel_emissivity: 0.7,
        clad_emissivity: 0.7,
    }
}
fn temperatures(h: f64) -> FuelTemperatures {
    let seed = |v: f64, d: f64| Scalar::new(v + h * d, d);
    FuelTemperatures {
        inner_mean: seed(950., 4.),
        outer_mean: seed(850., -2.),
        fuel_surface: seed(800., 3.),
        helium: seed(650., 1.),
        clad_inner: seed(620., -1.),
        clad_mean: seed(600., 2.),
        clad_outer: seed(590., -3.),
    }
}
// Synthetic differentiable property fixture ONLY for independent chain-rule
// tests. Production has no substitute/default for the maintained native port.
struct Fixture;
impl WaterProperties for Fixture {
    fn liquid(&self, p: Scalar, t: Scalar) -> Result<WaterPoint> {
        Ok(WaterPoint {
            density: c(800.) - c(0.7) * (t - c(500.)) + c(1e-7) * p,
            viscosity: c(0.00015) - c(2e-7) * (t - c(500.)) + c(1e-13) * p,
            conductivity: c(0.6) - c(0.0005) * (t - c(500.)) + c(1e-10) * p,
            cp: c(4500.) + c(2.) * (t - c(500.)) + c(1e-6) * p,
            expansion: c(0.002) + c(1e-6) * (t - c(500.)),
            enthalpy: c(1e6) + c(4500.) * (t - c(500.)) + c(0.001) * p,
        })
    }
    fn vapor(&self, p: Scalar, t: Scalar) -> Result<WaterPoint> {
        Ok(WaterPoint {
            density: p / (c(461.5) * t),
            viscosity: c(2e-5) + c(2e-8) * (t - c(500.)),
            conductivity: c(0.04) + c(0.0001) * (t - c(500.)),
            cp: c(2000.) + t,
            expansion: c(1.) / t,
            enthalpy: c(2.8e6) + c(2500.) * (t - c(500.)) + c(0.001) * p,
        })
    }
    fn saturation(&self, p: Scalar) -> Result<Saturation> {
        let t = c(500.) + c(8e-6) * p;
        Ok(Saturation {
            temperature: t,
            liquid: self.liquid(p, t)?,
            vapor: self.vapor(p, t)?,
            surface_tension: c(0.025) - c(1e-10) * p,
        })
    }
    fn saturated_vapor_density(&self, t: Scalar) -> Result<Scalar> {
        Ok((t - c(500.)) / c(8e-6) / (c(461.5) * t))
    }
}
fn wall_law(film: Film) -> WallLaw {
    WallLaw {
        diameter_m: 0.02,
        film,
        emissivity: 0.3,
        material: WallMaterial {
            conductivity: c(15.),
            density: 8000.,
            cp: c(500.),
        },
    }
}

#[test]
fn nonlinear_caloric_charts_preserve_datum_and_current_heat_capacity() {
    for t in [
        290., 300., 350., 400., 600., 640., 850., 1090., 1093., 1113., 1200., 1248., 1500., 1800.,
    ] {
        for law in [fuel_caloric as fn(Scalar) -> Result<Caloric>, clad_caloric] {
            let q = law(Scalar::new(t, 2.)).unwrap();
            close(q.specific_energy.direction, 2. * q.cp.value, 2e-12);
            if t > 290. && t < 1800. && ![300., 400., 640., 1090., 1093., 1113., 1248.].contains(&t)
            {
                let h = 1e-4;
                let p = law(c(t + h)).unwrap();
                let m = law(c(t - h)).unwrap();
                close(
                    (p.specific_energy.value - m.specific_energy.value) / (2. * h),
                    q.cp.value,
                    1e-7,
                );
            }
        }
    }
    assert_eq!(fuel_caloric(c(300.)).unwrap().specific_energy.value, 0.);
    assert_eq!(clad_caloric(c(300.)).unwrap().specific_energy.value, 0.);
    assert!(fuel_caloric(c(2001.)).is_err());
    assert!(clad_caloric(c(1801.)).is_err());
    assert!(
        (fuel_caloric(c(1500.)).unwrap().cp.value - fuel_caloric(c(850.)).unwrap().cp.value).abs()
            > 1.
    );
}

#[test]
fn zero_capacitance_surface_defects_do_not_create_energy_in_signed_trials() {
    let q = fuel_heat_rates(
        &geom(),
        temperatures(0.),
        [Scalar::new(9e6, 8e4), Scalar::new(-2e6, -3e4)],
        Scalar::new(-1e6, 4e4),
    )
    .unwrap();
    let sum = q.fuel_inner + q.fuel_outer + q.helium + q.clad + q.water;
    close(sum.value, 7e6, 1e-12);
    close(sum.direction, 5e4, 1e-12);
    assert!(q.surface_residuals.iter().any(|x| x.value.abs() > 1e5));
}
#[test]
fn two_equal_area_mean_reconstruction_matches_constant_k_uniform_cylinder() {
    let g = geom();
    let t = c(800.);
    let k = fuel_conductivity(t).unwrap().value;
    let base = FuelTemperatures {
        inner_mean: Scalar::new(800., 1.),
        outer_mean: t,
        fuel_surface: t,
        helium: t,
        clad_inner: t,
        clad_mean: t,
        clad_outer: t,
    };
    let q = fuel_transfers(&g, base, c(0.)).unwrap();
    close(
        q.inner_to_outer.direction,
        4. * PI * g.rod_length_m * g.rods * k,
        1e-12,
    );
    let outer = FuelTemperatures {
        inner_mean: t,
        outer_mean: Scalar::new(800., 1.),
        ..base
    };
    let q = fuel_transfers(&g, outer, c(0.)).unwrap();
    close(
        q.outer_to_surface.direction,
        16. * PI * g.rod_length_m * g.rods * k,
        1e-12,
    );
    // Independent area-average of T=Ts+Q/(4πNLk)*(1-r²/rf²):
    // inner/outer equal-area means have excess3A/4 andA/4.
    let power = 1e6;
    let a = power / (4. * PI * g.rod_length_m * g.rods * k);
    let inner_minus_outer = a / 2.;
    let outer_minus_surface = a / 4.;
    close(
        q.outer_to_surface.direction * outer_minus_surface,
        power,
        1e-12,
    );
    close(
        4. * PI * g.rod_length_m * g.rods * k * inner_minus_outer,
        power / 2.,
        1e-12,
    );
}
#[test]
fn clad_logarithmic_mean_resistances_match_independent_volume_integral() {
    let g = geom();
    let ri = g.clad_inner_radius_m;
    let ro = g.clad_outer_radius_m;
    let mut integral = 0.;
    let n = 10000;
    for i in 0..=n {
        let x = i as f64 / n as f64;
        let r = (ri * ri + x * (ro * ro - ri * ri)).sqrt();
        integral += (if i == 0 || i == n {
            1.
        } else if i % 2 == 0 {
            2.
        } else {
            4.
        }) * (r / ri).ln();
    }
    integral /= 3. * n as f64;
    let t = c(600.);
    let temps = FuelTemperatures {
        inner_mean: t,
        outer_mean: t,
        fuel_surface: t,
        helium: t,
        clad_inner: Scalar::new(600., 1.),
        clad_mean: t,
        clad_outer: Scalar::new(600., -1.),
    };
    let q = fuel_transfers(&g, temps, c(0.)).unwrap();
    let scale = 2. * PI * g.rod_length_m * g.rods * clad_conductivity(t).unwrap().value;
    close(scale / q.clad_inner_to_mean.direction, integral, 1e-12);
    close(
        scale / q.clad_inner_to_mean.direction + scale / q.clad_mean_to_outer.direction,
        (ro / ri).ln(),
        1e-12,
    );
}
#[test]
fn complete_gap_is_split_once_and_shared_helium_is_not_a_thermostat() {
    let t = FuelTemperatures {
        inner_mean: c(800.),
        outer_mean: c(750.),
        fuel_surface: c(700.),
        helium: c(600.),
        clad_inner: c(500.),
        clad_mean: c(500.),
        clad_outer: c(500.),
    };
    let q = fuel_transfers(&geom(), t, c(0.)).unwrap();
    close(
        q.surface_to_helium.value,
        q.helium_to_clad_inner.value,
        1e-12,
    );
    assert!(q.gap_radiation.value > 0.);
    let varied = FuelTemperatures {
        helium: c(610.),
        ..t
    };
    let r = fuel_transfers(&geom(), varied, c(0.)).unwrap();
    assert!(r.surface_to_helium.value < r.helium_to_clad_inner.value);
    let entropy = q.surface_to_helium.value * (1. / 600. - 1. / 700.)
        + q.helium_to_clad_inner.value * (1. / 500. - 1. / 600.)
        + q.gap_radiation.value * (1. / 500. - 1. / 700.);
    assert!(entropy > 0.);
}
#[test]
fn full_fuel_direction_includes_gas_transport_radiation_and_all_surface_temperatures() {
    let exact = fuel_transfers(&geom(), temperatures(0.), Scalar::new(1e6, 700.)).unwrap();
    let h = 1e-3;
    let plus = fuel_transfers(&geom(), temperatures(h), c(1e6 + h * 700.)).unwrap();
    let minus = fuel_transfers(&geom(), temperatures(-h), c(1e6 - h * 700.)).unwrap();
    let fields = |q: FuelTransfers| {
        [
            q.inner_to_outer,
            q.outer_to_surface,
            q.surface_to_helium,
            q.helium_to_clad_inner,
            q.gap_radiation,
            q.clad_inner_to_mean,
            q.clad_mean_to_outer,
            q.surface_residuals[0],
            q.surface_residuals[1],
            q.surface_residuals[2],
        ]
    };
    for ((e, p), m) in fields(exact).iter().zip(fields(plus)).zip(fields(minus)) {
        close((p.value - m.value) / (2. * h), e.direction, 2e-7);
    }
}
#[test]
fn feedback_is_mean_sqrt_not_sqrt_mean_and_has_its_exact_direction() {
    let value = fuel_feedback_temperature(Scalar::new(600., 2.), Scalar::new(1200., -3.)).unwrap();
    close(
        value.value,
        (0.5 * (600_f64.sqrt() + 1200_f64.sqrt())).powi(2),
        1e-12,
    );
    assert!((value.value - 900.).abs() > 20.);
    let h = 1e-4;
    let p = fuel_feedback_temperature(c(600. + 2. * h), c(1200. - 3. * h)).unwrap();
    let m = fuel_feedback_temperature(c(600. - 2. * h), c(1200. + 3. * h)).unwrap();
    close((p.value - m.value) / (2. * h), value.direction, 1e-8);
}
#[test]
fn same_trial_liquid_property_and_flow_directions_match_full_contact_differences() {
    for (film, wall, bulk, flux) in [
        (Film::Core, 530., 520., 4000.),
        (Film::Tube, 530., 520., 4000.),
        (Film::External, 552., 547.5, 0.),
        (Film::External, 650., 547.5, 0.),
        (Film::External, 1000., 547.5, 0.),
    ] {
        let eval = |h: f64, seed: bool| {
            liquid_wall(
                &Fixture,
                Scalar::new(6e6 + h * 2e5, if seed { 2e5 } else { 0. }),
                Scalar::new(bulk + h * 0.3, if seed { 0.3 } else { 0. }),
                Scalar::new(wall + h * 0.7, if seed { 0.7 } else { 0. }),
                Scalar::new(flux + h * 10., if seed { 10. } else { 0. }),
                wall_law(film),
            )
            .unwrap()
        };
        let exact = eval(0., true);
        let h = 1e-4;
        let plus = eval(h, false);
        let minus = eval(-h, false);
        close(
            (plus.heat.value - minus.heat.value) / (2. * h),
            exact.heat.direction,
            3e-6,
        );
        close(
            exact.liquid_energy.value + exact.vapor_energy.value,
            exact.heat.value,
            1e-12,
        );
        close(
            exact.liquid_energy.direction + exact.vapor_energy.direction,
            exact.heat.direction,
            1e-12,
        );
    }
}
#[test]
fn zero_reversed_flow_equal_and_cold_wall_limits_are_not_hidden_heat_floors() {
    let forward = liquid_wall(
        &Fixture,
        c(6e6),
        c(520.),
        c(530.),
        c(4000.),
        wall_law(Film::Core),
    )
    .unwrap();
    let reverse = liquid_wall(
        &Fixture,
        c(6e6),
        c(520.),
        c(530.),
        c(-4000.),
        wall_law(Film::Core),
    )
    .unwrap();
    close(forward.heat.value, reverse.heat.value, 1e-12);
    let still = liquid_wall(
        &Fixture,
        c(6e6),
        c(520.),
        c(530.),
        c(0.),
        wall_law(Film::Core),
    )
    .unwrap();
    assert!(still.heat.value > 0. && still.heat.value < forward.heat.value);
    let equal = liquid_wall(
        &Fixture,
        c(6e6),
        c(520.),
        Scalar::new(520., 1.),
        c(0.),
        wall_law(Film::External),
    )
    .unwrap();
    assert_eq!(equal.heat.value, 0.);
    assert!(equal.heat.direction > 0.);
    let cold = liquid_wall(
        &Fixture,
        c(6e6),
        c(520.),
        c(510.),
        c(0.),
        wall_law(Film::Core),
    )
    .unwrap();
    assert!(cold.heat.value < 0.);
    assert_eq!(cold.vapor_mass.value, 0.);
}
#[test]
fn folded_contact_integral_preserves_material_location_and_exposes_top_cusp() {
    let all = (0..4)
        .map(|i| {
            folded_wet_fraction(5. * i as f64, 5. * (i + 1) as f64, Scalar::new(40., 1.)).unwrap()
        })
        .collect::<Vec<_>>();
    close(
        all.iter().map(|x| x.value).sum::<f64>() / 4.,
        0.5083333333333333,
        1e-12,
    );
    let h = 1e-4;
    for (i, expected) in all.iter().enumerate() {
        let p = folded_wet_fraction(5. * i as f64, 5. * (i + 1) as f64, c(40. + h)).unwrap();
        let m = folded_wet_fraction(5. * i as f64, 5. * (i + 1) as f64, c(40. - h)).unwrap();
        close((p.value - m.value) / (2. * h), expected.direction, 1e-8);
    }
    for i in 0..4 {
        let full = folded_wet_fraction(5. * i as f64, 5. * (i + 1) as f64, Scalar::new(71.25, 1.))
            .unwrap();
        close(full.value, 1., 1e-12);
        close(full.direction, 0., 1e-12);
    }
    // At H=12m only the full-wet RIGHT derivative is finite. The left
    // derivative diverges; event localization must not call it smooth.
}
#[test]
fn inward_crown_direction_is_unavailable_only_for_actual_crown_segments() {
    for (start, end) in [(10., 15.), (0., 20.), (9., 10.25), (10.25, 11.)] {
        assert_eq!(
            folded_wet_fraction(start, end, Scalar::new(71.25, -1.)).unwrap_err(),
            "inward SG crown wetting derivative is unbounded"
        );
    }
    for (start, end) in [(0., 5.), (5., 10.), (15., 20.), (10.3, 15.)] {
        let q = folded_wet_fraction(start, end, Scalar::new(71.25, -1.)).unwrap();
        close(q.value, 1., 1e-12);
        close(q.direction, 0., 1e-12);
    }
    let prepared = folded_wet_fraction(10., 15., Scalar::new(72., -1.)).unwrap();
    close(prepared.value, 1., 1e-12);
    close(prepared.direction, 0., 1e-12);
}
#[test]
fn finite_sg_and_guide_recipients_are_reciprocal_in_both_signs() {
    for (a, b) in [(3e6, 2e6), (-3e6, -2e6), (0., 0.)] {
        let q = steam_generator_rates(Scalar::new(a, 7.), Scalar::new(b, -2.)).unwrap();
        close((q.primary + q.metal + q.secondary).value, 0., 1e-12);
        close((q.primary + q.metal + q.secondary).direction, 0., 1e-12);
    }
    let hot = guide_radiation(c(900.), c(600.), c(10.), c(1.), 0.7).unwrap();
    let cold = guide_radiation(c(600.), c(900.), c(10.), c(1.), 0.7).unwrap();
    close(hot.value, -cold.value, 1e-12);
    assert_eq!(
        guide_radiation(c(900.), c(600.), c(0.), c(0.), 0.7)
            .unwrap()
            .value,
        0.
    );
    let wet = secondary_wall(
        &Fixture,
        c(6e6),
        c(548.),
        c(552.),
        c(72.),
        0.,
        5.,
        1250.,
        0.02,
        SteelContact {
            emissivity: 0.3,
            material: WallMaterial {
                conductivity: c(15.),
                density: 8000.,
                cp: c(500.),
            },
        },
        true,
    )
    .unwrap();
    assert!(wet.value > 0.);
    let dry = secondary_wall(
        &Fixture,
        c(6e6),
        c(600.),
        c(650.),
        c(0.),
        0.,
        5.,
        1250.,
        0.02,
        SteelContact {
            emissivity: 0.3,
            material: WallMaterial {
                conductivity: c(15.),
                density: 8000.,
                cp: c(500.),
            },
        },
        false,
    )
    .unwrap();
    close(dry.value, 1250. * 5. * 50., 1e-12);
}

#[test]
fn existing_nonfuel_contact_and_shared_plenum_have_no_parallel_rod_film() {
    let ro = 0.0061_f64;
    let ri = 0.0055_f64;
    let rm = ((ro * ro + ri * ri) / 2.).sqrt();
    let log = ro * (ro / rm).ln();
    let area = 3.;
    let eval = |step: f64, seed: bool| {
        nonfuel_wall(
            Scalar::new(600. + step * 2., if seed { 2. } else { 0. }),
            Scalar::new(580. - step, if seed { -1. } else { 0. }),
            c(area),
            250.,
            log,
        )
        .unwrap()
    };
    let q = eval(0., true);
    let k = clad_conductivity(c(600.)).unwrap().value;
    close(q.value, area * 20. / (1. / 250. + log / k), 1e-12);
    let h = 1e-4;
    close(
        (eval(h, false).value - eval(-h, false).value) / (2. * h),
        q.direction,
        1e-8,
    );
    close(
        nonfuel_wall(c(600.), c(580.), c(0.1), 5., 0.)
            .unwrap()
            .value,
        10.,
        1e-12,
    );
    let plenum = helium_to_plenum(
        Scalar::new(650., 1.),
        Scalar::new(600., -2.),
        1.733405163,
        0.00418,
        2.,
    )
    .unwrap();
    let p = helium_to_plenum(c(650. + h), c(600. - 2. * h), 1.733405163, 0.00418, 2.).unwrap();
    let m = helium_to_plenum(c(650. - h), c(600. + 2. * h), 1.733405163, 0.00418, 2.).unwrap();
    close((p.value - m.value) / (2. * h), plenum.direction, 1e-8);
    assert!(plenum.value > 0.);
    assert_eq!(
        helium_to_plenum(c(600.), c(600.), 1.733405163, 0.00418, 2.)
            .unwrap()
            .value,
        0.
    );
}

#[test]
fn saturated_same_call_point_is_reused_without_freezing_its_direction() {
    use std::cell::Cell;
    struct Count {
        liquid: Cell<usize>,
        saturation: Cell<usize>,
        vapor: Cell<usize>,
    }
    impl WaterProperties for Count {
        fn liquid(&self, p: Scalar, t: Scalar) -> Result<WaterPoint> {
            self.liquid.set(self.liquid.get() + 1);
            Fixture.liquid(p, t)
        }
        fn vapor(&self, p: Scalar, t: Scalar) -> Result<WaterPoint> {
            self.vapor.set(self.vapor.get() + 1);
            Fixture.vapor(p, t)
        }
        fn saturation(&self, p: Scalar) -> Result<Saturation> {
            self.saturation.set(self.saturation.get() + 1);
            Fixture.saturation(p)
        }
        fn saturated_vapor_density(&self, t: Scalar) -> Result<Scalar> {
            Fixture.saturated_vapor_density(t)
        }
    }
    let props = Count {
        liquid: Cell::new(0),
        saturation: Cell::new(0),
        vapor: Cell::new(0),
    };
    let p = Scalar::new(6e6, 10000.);
    let t = Fixture.saturation(p).unwrap().temperature;
    let q = liquid_wall(
        &props,
        p,
        t,
        Scalar::new(560., 0.3),
        c(0.),
        wall_law(Film::External),
    )
    .unwrap();
    assert_eq!(props.liquid.get(), 0);
    assert_eq!(props.saturation.get(), 1);
    assert_eq!(props.vapor.get(), 1);
    assert!(q.heat.direction != 0.);
    let eval = |h: f64| {
        let p = c(6e6 + h * 10000.);
        let t = Fixture.saturation(p).unwrap().temperature;
        liquid_wall(
            &Fixture,
            p,
            t,
            c(560. + h * 0.3),
            c(0.),
            wall_law(Film::External),
        )
        .unwrap()
        .heat
        .value
    };
    let h = 1e-4;
    close((eval(h) - eval(-h)) / (2. * h), q.heat.direction, 3e-6);
}
