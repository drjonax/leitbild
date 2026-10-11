//! Opt-in actual owner-package consumption. JSON navigation belongs ONLY to
//! this test harness; stage equations remain typed, allocation-free native laws.
//! This evaluates uninitialized surface seeds, not a trajectory or steady plant.
use leitbild_operating_plant::initialization::{SurfacePolicy, initialize_fuel_surfaces};
use leitbild_operating_plant::thermal::*;
use leitbild_operating_water::If97;
use serde_json::Value;

/// The tube steel of `ld01-sg-contact` (emissivity and material), as the
/// SG owner's section carries it.
const SG_STEEL: SteelContact = SteelContact {
    emissivity: 0.3,
    material: WallMaterial {
        conductivity: Scalar {
            value: 15.,
            direction: 0.,
        },
        density: 8000.,
        cp: Scalar {
            value: 500.,
            direction: 0.,
        },
    },
};
use std::collections::HashMap;

fn n(v: &Value, key: &str) -> f64 {
    v[key]
        .as_f64()
        .unwrap_or_else(|| panic!("missing number {key}"))
}
fn a<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v[key].as_array().unwrap().as_slice()
}
fn idx(v: &Value, key: &str) -> usize {
    v[key].as_u64().unwrap() as usize
}
fn id(v: &Value) -> &str {
    v["id"].as_str().unwrap()
}
fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn near(value: f64, expected: f64) {
    assert!(value.is_finite() && expected.is_finite());
    assert!(
        (value - expected).abs() <= 3e-11 * expected.abs().max(1.),
        "{value} != {expected}"
    );
}
fn geometry(v: &Value) -> FuelGeometry {
    FuelGeometry {
        fuel_radius_m: n(v, "fuel_radius_m"),
        clad_inner_radius_m: n(v, "clad_inner_radius_m"),
        clad_outer_radius_m: n(v, "clad_outer_radius_m"),
        rod_length_m: n(v, "rod_length_m"),
        rods: n(v, "rods"),
        helium_volume_m3: n(v, "helium_volume_m3"),
        helium_nr_j_k: n(v, "helium_nr_j_k"),
        accommodation: n(v, "accommodation"),
        fuel_emissivity: n(v, "fuel_emissivity"),
        clad_emissivity: n(v, "clad_emissivity"),
    }
}

#[test]
#[ignore = "requires actual owner-generated LD01_OPERATING_THERMAL_PACKET"]
fn actual_finite_thermal_package_consumes_maintained_water_and_closes_reciprocal_receipts() {
    let path = std::env::var_os("LD01_OPERATING_THERMAL_PACKET")
        .expect("actual thermal package is required");
    let packet: Value = serde_json::from_reader(std::fs::File::open(path).unwrap()).unwrap();
    assert_eq!(packet["identity"], "LD01-HOT-THERMAL-1");
    let bands = a(&packet, "fuel_bands");
    let water = a(&packet, "water");
    let helium = a(&packet, "helium");
    let passive = a(&packet, "passive_stores");
    let segments = a(&packet, "sg_segments");
    let secondary = a(&packet, "secondaries");
    assert_eq!(
        (
            bands.len(),
            water.len(),
            helium.len(),
            passive.len(),
            segments.len(),
            secondary.len()
        ),
        (386, 26, 193, 1351, 8, 2)
    );
    let passive_index: HashMap<_, _> = passive
        .iter()
        .enumerate()
        .map(|(i, v)| (id(v), i))
        .collect();
    assert_eq!(passive_index.len(), passive.len());
    let props = If97;
    let mut water_rates = vec![0.; water.len()];
    let mut band_wall = vec![0.; bands.len()];
    let mut helium_rates = vec![0.; helium.len()];
    let mut passive_rates = vec![0.; passive.len()];
    let mut secondary_rates = vec![0.; secondary.len()];
    let mut total = 0.;
    let mut max_surface_defect = 0_f64;
    let mut max_caloric_relative_defect = 0_f64;
    let started = std::time::Instant::now();
    // The selected preparation has ZERO circulation. This is explicit initial
    // constitutive input, not a solved expansion/momentum/pressure field.
    for contact in a(&packet, "core_contacts") {
        let b = idx(contact, "band");
        let w = idx(contact, "water");
        let clad = s(n(&bands[b], "clad_temperature_k"));
        let g = geometry(&bands[b]["geometry"]);
        let density = n(&bands[b], "clad_mass_kg")
            / (std::f64::consts::PI
                * (g.clad_outer_radius_m.powi(2) - g.clad_inner_radius_m.powi(2))
                * g.rod_length_m
                * g.rods);
        let law = WallLaw {
            diameter_m: n(contact, "hydraulic_diameter_m"),
            film: Film::Core,
            emissivity: g.clad_emissivity,
            material: core_wall_material(clad, density).unwrap(),
        };
        let q = liquid_wall(
            &props,
            s(n(&water[w], "pressure_pa")),
            s(n(&water[w], "temperature_k")),
            s(a(&bands[b], "surface_seed_k")[2].as_f64().unwrap()),
            s(0.),
            law,
        )
        .unwrap();
        assert_eq!(
            q.vapor_mass.value, 0.,
            "hot preparation must not hide phase birth"
        );
        let heat = q.heat.value * n(contact, "area_m2");
        band_wall[b] += heat;
        water_rates[w] += heat;
    }
    for (i, b) in bands.iter().enumerate() {
        let temps = a(b, "fuel_temperatures_k");
        let seeds = a(b, "surface_seed_k");
        let he = idx(b, "helium");
        let t = FuelTemperatures {
            inner_mean: s(temps[0].as_f64().unwrap()),
            outer_mean: s(temps[1].as_f64().unwrap()),
            fuel_surface: s(seeds[0].as_f64().unwrap()),
            helium: s(n(&helium[he], "temperature_k")),
            clad_inner: s(seeds[1].as_f64().unwrap()),
            clad_mean: s(n(b, "clad_temperature_k")),
            clad_outer: s(seeds[2].as_f64().unwrap()),
        };
        for (j, temperature) in temps.iter().enumerate() {
            let expected = a(b, "fuel_masses_kg")[j].as_f64().unwrap()
                * fuel_caloric(s(temperature.as_f64().unwrap()))
                    .unwrap()
                    .specific_energy
                    .value;
            let actual = a(b, "fuel_energies_j")[j].as_f64().unwrap();
            near(actual, expected);
            max_caloric_relative_defect =
                max_caloric_relative_defect.max((actual - expected).abs() / expected.abs().max(1.));
        }
        near(
            n(b, "clad_energy_j"),
            n(b, "clad_mass_kg") * clad_caloric(t.clad_mean).unwrap().specific_energy.value,
        );
        let source = a(b, "source_w");
        let q = fuel_heat_rates(
            &geometry(&b["geometry"]),
            t,
            [
                s(source[0].as_f64().unwrap()),
                s(source[1].as_f64().unwrap()),
            ],
            s(band_wall[i]),
        )
        .unwrap();
        total += q.fuel_inner.value + q.fuel_outer.value + q.clad.value;
        helium_rates[he] += q.helium.value;
        for r in q.surface_residuals {
            max_surface_defect = max_surface_defect.max(r.value.abs());
        }
        near(
            fuel_feedback_temperature(t.inner_mean, t.outer_mean)
                .unwrap()
                .value,
            t.inner_mean.value,
        );
    }
    // Finite guide/fitting/plenum calorics and both sides of actual contacts.
    for p in passive {
        near(
            n(p, "energy_j"),
            n(p, "mass_kg")
                * clad_caloric(s(n(p, "temperature_k")))
                    .unwrap()
                    .specific_energy
                    .value,
        );
    }
    for p in helium {
        near(
            n(p, "energy_j"),
            1.5 * n(p, "nr_j_k") * n(p, "temperature_k"),
        );
    }
    for c in a(&packet, "passive_contacts") {
        let solid = passive_index[c["store_id"].as_str().unwrap()];
        let w = idx(c, "water");
        let q = nonfuel_wall(
            s(n(&passive[solid], "temperature_k")),
            s(n(&water[w], "temperature_k")),
            s(n(c, "area_m2")),
            n(c, "liquid_h_w_m2_k"),
            n(c, "wall_log_radius_m"),
        )
        .unwrap()
        .value;
        passive_rates[solid] -= q;
        water_rates[w] += q;
    }
    for c in a(&packet, "plenum_contacts") {
        let he = idx(c, "helium");
        let p = passive_index[c["store_id"].as_str().unwrap()];
        let q = helium_to_plenum(
            s(n(&helium[he], "temperature_k")),
            s(n(&passive[p], "temperature_k")),
            n(c, "area_m2"),
            n(c, "inner_radius_m"),
            n(c, "conduction_factor"),
        )
        .unwrap()
        .value;
        helium_rates[he] -= q;
        passive_rates[p] += q;
    }
    let mut sg_metal_rate = 0.;
    let mut sg_to_secondary = 0.;
    for metal in segments {
        let w = idx(metal, "primary");
        let sec = idx(metal, "secondary");
        let t = s(n(metal, "temperature_k"));
        near(
            n(metal, "energy_j"),
            n(metal, "capacity_j_k") * (t.value - 273.15),
        );
        let law = WallLaw {
            diameter_m: n(metal, "thermal_diameter_m"),
            film: Film::Tube,
            emissivity: 0.3,
            material: WallMaterial {
                conductivity: s(15.),
                density: 8000.,
                cp: s(500.),
            },
        };
        let primary_to_metal = -n(metal, "area_m2")
            * liquid_wall(
                &props,
                s(n(&water[w], "pressure_pa")),
                s(n(&water[w], "temperature_k")),
                t,
                s(0.),
                law,
            )
            .unwrap()
            .heat
            .value;
        let sg = &secondary[sec];
        let metal_to_secondary = secondary_wall(
            &props,
            s(n(sg, "pressure_pa")),
            s(n(sg, "temperature_k")),
            t,
            s(n(sg, "liquid_volume_m3")),
            n(metal, "developed_start_m"),
            n(metal, "developed_end_m"),
            n(metal, "area_m2"),
            n(metal, "thermal_diameter_m"),
            SG_STEEL,
            true,
        )
        .unwrap()
        .value;
        if sec == 0 && n(metal, "developed_start_m") == 0. {
            // Same actual endpoint/property branch with pressure-dependent Ts.
            // This verifies a joined water/correlation direction, not just a
            // synthetic constant-property thermal fixture.
            let pressure = Scalar::new(n(sg, "pressure_pa"), 1e4);
            let saturated = props.saturation(pressure).unwrap();
            let directional = secondary_wall(
                &props,
                pressure,
                saturated.temperature,
                Scalar::new(t.value, 1.),
                Scalar::new(n(sg, "liquid_volume_m3"), -0.1),
                n(metal, "developed_start_m"),
                n(metal, "developed_end_m"),
                n(metal, "area_m2"),
                n(metal, "thermal_diameter_m"),
                SG_STEEL,
                true,
            )
            .unwrap();
            let probe = |offset: f64| {
                let p = s(pressure.value + offset * pressure.direction);
                let ts = props.saturation(p).unwrap().temperature;
                secondary_wall(
                    &props,
                    p,
                    ts,
                    s(t.value + offset),
                    s(n(sg, "liquid_volume_m3") - 0.1 * offset),
                    n(metal, "developed_start_m"),
                    n(metal, "developed_end_m"),
                    n(metal, "area_m2"),
                    n(metal, "thermal_diameter_m"),
                    SG_STEEL,
                    true,
                )
                .unwrap()
                .value
            };
            let epsilon = 1e-4;
            let numeric = (probe(epsilon) - probe(-epsilon)) / (2. * epsilon);
            assert!(
                (directional.direction - numeric).abs() < 2e-5 * numeric.abs().max(1.),
                "actual SG JVP {} vs {numeric}",
                directional.direction
            );
        }
        let rates = steam_generator_rates(s(primary_to_metal), s(metal_to_secondary)).unwrap();
        water_rates[w] += rates.primary.value;
        sg_metal_rate += rates.metal.value;
        secondary_rates[sec] += rates.secondary.value;
        sg_to_secondary += metal_to_secondary;
    }
    for (i, source) in a(&packet, "direct_water_source_w").iter().enumerate() {
        water_rates[i] += source.as_f64().unwrap();
    }
    total += water_rates.iter().sum::<f64>()
        + helium_rates.iter().sum::<f64>()
        + passive_rates.iter().sum::<f64>()
        + sg_metal_rate
        + secondary_rates.iter().sum::<f64>();
    near(total, n(&packet, "source_total_w"));
    assert!(
        max_surface_defect > 1.,
        "uninitialized surfaces must be reported, not disguised as consistent"
    );
    eprintln!(
        "{}",
        serde_json::json!({"scope":"actual native constitutive evaluation, zero simulated time; surface seeds NOT initialized",
        "fuel_bands":bands.len(),"core_contacts":a(&packet,"core_contacts").len(),
        "passive_contacts":a(&packet,"passive_contacts").len(),"source_w":n(&packet,"source_total_w"),
        "reciprocal_defect_w":total-n(&packet,"source_total_w"),"max_surface_seed_residual_w":max_surface_defect,
        "max_fuel_caloric_relative_defect":max_caloric_relative_defect,"sg_to_secondary_w":sg_to_secondary,
        "evaluation_seconds_including_test_navigation":started.elapsed().as_secs_f64()})
    );
}

#[test]
#[ignore = "requires actual owner-generated LD01_OPERATING_THERMAL_PACKET"]
fn actual_fixed_stock_surfaces_initialize_with_current_maintained_wall_laws() {
    let path = std::env::var_os("LD01_OPERATING_THERMAL_PACKET")
        .expect("actual thermal package is required");
    let packet: Value = serde_json::from_reader(std::fs::File::open(path).unwrap()).unwrap();
    let immutable = packet.clone();
    let bands = a(&packet, "fuel_bands");
    let water = a(&packet, "water");
    let helium = a(&packet, "helium");
    let contacts = a(&packet, "core_contacts");
    let policy = SurfacePolicy {
        maximum_residual_w: 1e-3,
        maximum_correction_k: 1e-6,
        maximum_iterations: 16,
        maximum_backtracks: 12,
    };
    let props = If97;
    // These are explicitly CONDITIONAL current-flow boundaries, not a solved
    // primary expansion/momentum field. The joined operator supplies its own
    // actual half-face flow mapping. No preparation circulation claim implies
    // zero expansion flux, and neither test writes this boundary into stocks.
    for mass_flux in [0., 500.] {
        let started = std::time::Instant::now();
        let mut maximum_residual_w = 0_f64;
        let mut maximum_correction_k = 0_f64;
        let mut maximum_iterations = 0;
        let mut wall_evaluations = 0;
        let mut maximum_seed_temperature_difference_k = 0_f64;
        let mut helium_rate = 0.;
        let mut helium_rates = vec![0.; helium.len()];
        let mut fuel_rate = 0.;
        let mut water_rate = 0.;
        for (i, b) in bands.iter().enumerate() {
            let g = geometry(&b["geometry"]);
            let temperatures = a(b, "fuel_temperatures_k");
            let seed = a(b, "surface_seed_k")
                .iter()
                .map(|v| v.as_f64().unwrap())
                .collect::<Vec<_>>();
            let fixed = FuelTemperatures {
                inner_mean: s(temperatures[0].as_f64().unwrap()),
                outer_mean: s(temperatures[1].as_f64().unwrap()),
                fuel_surface: s(seed[0]),
                helium: s(n(&helium[idx(b, "helium")], "temperature_k")),
                clad_inner: s(seed[1]),
                clad_mean: s(n(b, "clad_temperature_k")),
                clad_outer: s(seed[2]),
            };
            let density = n(b, "clad_mass_kg")
                / (std::f64::consts::PI
                    * (g.clad_outer_radius_m.powi(2) - g.clad_inner_radius_m.powi(2))
                    * g.rod_length_m
                    * g.rods);
            let incident = contacts
                .iter()
                .filter(|contact| idx(contact, "band") == i)
                .collect::<Vec<_>>();
            assert!(!incident.is_empty());
            let wall = |outer: Scalar| -> Result<Scalar> {
                let mut heat = s(0.);
                for contact in &incident {
                    let w = idx(contact, "water");
                    let law = WallLaw {
                        diameter_m: n(contact, "hydraulic_diameter_m"),
                        film: Film::Core,
                        emissivity: g.clad_emissivity,
                        material: core_wall_material(fixed.clad_mean, density)?,
                    };
                    let q = liquid_wall(
                        &props,
                        s(n(&water[w], "pressure_pa")),
                        s(n(&water[w], "temperature_k")),
                        outer,
                        s(mass_flux),
                        law,
                    )?;
                    assert_eq!(
                        q.vapor_mass.value, 0.,
                        "conditional hot initialization must not conceal phase birth"
                    );
                    heat = heat + s(n(contact, "area_m2")) * q.heat;
                }
                Ok(heat)
            };
            let solved =
                initialize_fuel_surfaces(&g, fixed, [seed[0], seed[1], seed[2]], policy, wall)
                    .unwrap();
            let other =
                initialize_fuel_surfaces(&g, fixed, [750., 630., 590.], policy, wall).unwrap();
            for (left, right) in [
                (
                    solved.temperatures.fuel_surface,
                    other.temperatures.fuel_surface,
                ),
                (
                    solved.temperatures.clad_inner,
                    other.temperatures.clad_inner,
                ),
                (
                    solved.temperatures.clad_outer,
                    other.temperatures.clad_outer,
                ),
            ] {
                maximum_seed_temperature_difference_k =
                    maximum_seed_temperature_difference_k.max((left.value - right.value).abs());
            }
            for (left, right) in [
                (solved.temperatures.inner_mean, fixed.inner_mean),
                (solved.temperatures.outer_mean, fixed.outer_mean),
                (solved.temperatures.helium, fixed.helium),
                (solved.temperatures.clad_mean, fixed.clad_mean),
            ] {
                assert_eq!(left.value.to_bits(), right.value.to_bits());
                assert_eq!(left.direction, right.direction);
            }
            maximum_residual_w = maximum_residual_w.max(
                solved
                    .residual_w
                    .into_iter()
                    .map(f64::abs)
                    .fold(0., f64::max),
            );
            maximum_correction_k = maximum_correction_k.max(solved.maximum_correction_k);
            maximum_iterations = maximum_iterations.max(solved.iterations);
            wall_evaluations += solved.wall_evaluations + other.wall_evaluations;
            let source = a(b, "source_w");
            let rates = fuel_heat_rates(
                &g,
                solved.temperatures,
                [
                    s(source[0].as_f64().unwrap()),
                    s(source[1].as_f64().unwrap()),
                ],
                s(solved.water_heat_w),
            )
            .unwrap();
            near(
                (rates.fuel_inner + rates.fuel_outer + rates.helium + rates.clad + rates.water)
                    .value,
                source[0].as_f64().unwrap() + source[1].as_f64().unwrap(),
            );
            helium_rate += rates.helium.value;
            helium_rates[idx(b, "helium")] += rates.helium.value;
            fuel_rate += rates.fuel_inner.value + rates.fuel_outer.value;
            water_rate += rates.water.value;
        }
        assert!(maximum_residual_w <= policy.maximum_residual_w);
        assert!(maximum_correction_k <= policy.maximum_correction_k);
        assert!(maximum_seed_temperature_difference_k < 1e-7);
        assert!(
            helium_rate.abs() > 1.,
            "consistent massless surfaces are not steady finite helium"
        );
        // The common helium owner also pays its existing finite plenum contact.
        let passive = a(&packet, "passive_stores");
        for contact in a(&packet, "plenum_contacts") {
            let he = idx(contact, "helium");
            let plenum = passive
                .iter()
                .find(|p| id(p) == contact["store_id"].as_str().unwrap())
                .unwrap();
            helium_rates[he] -= helium_to_plenum(
                s(n(&helium[he], "temperature_k")),
                s(n(plenum, "temperature_k")),
                n(contact, "area_m2"),
                n(contact, "inner_radius_m"),
                n(contact, "conduction_factor"),
            )
            .unwrap()
            .value;
        }
        let maximum_helium_temperature_rate_k_s = helium_rates
            .iter()
            .zip(helium)
            .map(|(rate, he)| (rate / (1.5 * n(he, "nr_j_k"))).abs())
            .fold(0., f64::max);
        eprintln!(
            "{}",
            serde_json::json!({"scope":"actual386 fixed-stock massless-surface initialization; conditional current wall flow, not a solved momentum field or trajectory",
            "conditional_mass_flux_kg_m2_s":mass_flux,"surface_count":3*bands.len(),"maximum_residual_w":maximum_residual_w,
            "maximum_undamped_correction_k":maximum_correction_k,"maximum_newton_updates":maximum_iterations,
            "maximum_two_seed_temperature_difference_k":maximum_seed_temperature_difference_k,
            "wall_evaluations_for_two_seeds":wall_evaluations,"helium_rate_w":helium_rate,"fuel_rate_w":fuel_rate,"water_rate_w":water_rate,
            "maximum_helium_temperature_rate_k_s_including_plenum":maximum_helium_temperature_rate_k_s,
            "initialization_seconds_including_two_seeds_and_test_navigation":started.elapsed().as_secs_f64()})
        );
    }
    assert_eq!(
        packet, immutable,
        "all finite thermal packet fields and source receipts remain byte-identical"
    );
}
