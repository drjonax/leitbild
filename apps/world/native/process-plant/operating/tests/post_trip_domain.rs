//! D3 (a) on synthetic states: the margin check against closed forms, the
//! boundary of "at least", and the domain each verdict selects. Synthetic
//! coefficients test the predicate, NOT LD-01 physical calibration.
use leitbild_operating_plant::{
    joined::post_trip_domain::{Domain, Error, Extension, Fixed, admit, shutdown_margin},
    kinetics::{self, Inputs, MaterialParameters, RegionInput, RegionParameters, Transfer},
    source_feedback::{self as sf, Bounds, Conditions, Domains},
    thermal::Scalar,
};

const LAMBDA: f64 = 2e-5;
const NU: f64 = 2.43;
const BETA: [f64; 6] = [0.00021, 0.00142, 0.00127, 0.00257, 0.00075, 0.00027];
const HALF_LIVES: [f64; 6] = [55.7, 22.7, 6.2, 2.3, 0.61, 0.23];

fn extension() -> Extension {
    Extension {
        density_ratio_maximum: 1.125,
        pressure_minimum_pa: 12.5e6,
        shutdown_margin_minimum: 0.01,
        margin_water_term_factor: 2.,
        extrapolation_sensitivity: [0.5, 1., 2.],
    }
}
fn region() -> RegionParameters {
    RegionParameters {
        generation_time_s: LAMBDA,
        reactivity_domain: kinetics::ReactivityDomain {
            minimum: -0.3,
            maximum: 0.15,
        },
    }
}
fn material() -> MaterialParameters {
    MaterialParameters {
        delayed_yields_per_fission: BETA.map(|b| NU * b),
        decay_constants_per_s: HALF_LIVES.map(|t| std::f64::consts::LN_2 / t),
    }
}
fn r(reactivity: f64) -> RegionInput {
    RegionInput {
        reactivity,
        // A source is present at the state; the check removes it.
        external_source_per_s: 1e3,
    }
}
fn point() -> kinetics::Model {
    kinetics::Model::new(
        vec![region()],
        vec![material()],
        vec![],
        vec![kinetics::Support {
            region: 0,
            material: 0,
        }],
    )
    .unwrap()
}
fn gamma() -> f64 {
    1. / (NU * LAMBDA)
}
fn point_inputs<'a>(
    regions: &'a [RegionInput],
    production: &'a [f64],
    emission: &'a [f64],
    outside: &'a [f64],
) -> Inputs<'a> {
    Inputs {
        regions,
        transfer_rates_per_s: &[],
        fissions_per_population_s: production,
        emission_fractions: emission,
        outside_fractions: outside,
    }
}

#[test]
fn a_point_operator_without_export_is_rho_over_lambda_and_its_margin_is_minus_rho() {
    let model = point();
    let check = |rho: f64| {
        let regions = [r(rho)];
        shutdown_margin(
            &model,
            point_inputs(&regions, &[gamma()], &[1.], &[0.]),
            &[0.],
            &extension(),
        )
        .unwrap()
    };
    let m = check(-0.02);
    assert!(m.holds, "{m:?}");
    // Delayed births withheld and returned in full: only rho/Lambda remains.
    let expected = -0.02 / LAMBDA;
    assert!(
        (m.operator[0] - expected).abs() <= 1e-12 * expected.abs(),
        "{m:?}"
    );
    assert!((m.reactivity_gain[0] - 1. / LAMBDA).abs() <= 1e-9 / LAMBDA);
    assert!(!check(-0.005).holds);
    // "At least": exactly the minimum holds; just inside and outside decide.
    assert!(check(-0.01).holds);
    assert!(check(-0.01 - 1e-9).holds);
    assert!(!check(-0.01 + 1e-9).holds);
}

#[test]
fn the_water_term_counts_at_its_factor() {
    let model = point();
    // The evaluated rho already holds the water term once; the check adds
    // (factor - 1) of it again.
    let check = |rho: f64, water: f64| {
        let regions = [r(rho)];
        shutdown_margin(
            &model,
            point_inputs(&regions, &[gamma()], &[1.], &[0.]),
            &[water],
            &extension(),
        )
        .unwrap()
        .holds
    };
    assert!(check(-0.015, 0.004)); // -0.015 + 0.004 = -0.011
    assert!(!check(-0.015, 0.006)); // -0.009
    assert!(check(-0.005, -0.006)); // a lighter-water term deepens the margin
    let mut once = extension();
    once.margin_water_term_factor = 1.;
    let regions = [r(-0.015)];
    assert!(
        shutdown_margin(
            &model,
            point_inputs(&regions, &[gamma()], &[1.], &[0.]),
            &[0.006],
            &once
        )
        .unwrap()
        .holds
    );
}

#[test]
fn a_delayed_export_deepens_the_margin_by_its_lost_births() {
    let model = point();
    let outside = 0.25;
    // Lost delayed births: Lambda * sum(nu beta) * G * outside, in dk/k.
    let lost = LAMBDA * NU * BETA.iter().sum::<f64>() * gamma() * outside;
    let check = |rho: f64| {
        let regions = [r(rho)];
        shutdown_margin(
            &model,
            point_inputs(&regions, &[gamma()], &[1. - outside], &[outside]),
            &[0.],
            &extension(),
        )
        .unwrap()
    };
    let m = check(-0.01 + lost - 1e-9);
    assert!(m.holds, "{m:?}");
    assert!(!check(-0.01 + lost + 1e-9).holds);
    let expected =
        (-0.01 + lost - 1e-9) / LAMBDA - NU * BETA.iter().sum::<f64>() * gamma() * outside;
    assert!((m.operator[0] - expected).abs() <= 1e-9 * expected.abs());
}

fn two_regions() -> kinetics::Model {
    kinetics::Model::new(
        vec![region(), region()],
        vec![material(), material()],
        vec![
            Transfer {
                donor: 0,
                receiver: 1,
            },
            Transfer {
                donor: 1,
                receiver: 0,
            },
        ],
        (0..2)
            .map(|i| kinetics::Support {
                region: i,
                material: i,
            })
            .collect(),
    )
    .unwrap()
}

#[test]
fn two_coupled_regions_match_the_closed_form_perron_margin() {
    let k = 1000.;
    let model = two_regions();
    let (rho0, rho1) = (-0.03, -0.004);
    // M = [[rho0/L - k, k], [k, rho1/L - k]]: alpha = mean + sqrt(d^2 + k^2).
    let (a, d) = (rho0 / LAMBDA - k, rho1 / LAMBDA - k);
    let alpha = (a + d) / 2. + (((a - d) / 2.).powi(2) + k * k).sqrt();
    let margin = -alpha * LAMBDA;
    assert!(margin > 0.004 && margin < 0.03, "{margin}");
    let check = |minimum: f64| {
        let regions = [r(rho0), r(rho1)];
        let mut e = extension();
        e.shutdown_margin_minimum = minimum;
        shutdown_margin(
            &model,
            Inputs {
                regions: &regions,
                transfer_rates_per_s: &[k, k],
                fissions_per_population_s: &[gamma(), gamma()],
                emission_fractions: &[1., 1.],
                outside_fractions: &[0., 0.],
            },
            &[0., 0.],
            &e,
        )
        .unwrap()
    };
    let m = check(margin * (1. - 1e-9));
    assert!(m.holds, "{m:?}");
    assert_eq!(m.pivots.len(), 2);
    let below = check(margin * (1. + 1e-9));
    assert!(!below.holds, "{below:?}");
    // The operator is the closed form, column-major.
    for (got, want) in m.operator.iter().zip([a, k, k, d]) {
        assert!(
            (got - want).abs() <= 1e-9 * want.abs().max(k),
            "{got} {want}"
        );
    }
}

#[test]
fn an_extension_must_widen_the_compiled_domains() {
    let original = domains();
    assert_eq!(extension().validate(&original), Ok(()));
    let refuse = |f: fn(&mut Extension)| {
        let mut e = extension();
        f(&mut e);
        assert!(
            matches!(e.validate(&original), Err(Error::Extension(_))),
            "{e:?}"
        );
    };
    refuse(|e| e.density_ratio_maximum = 1.09);
    refuse(|e| e.pressure_minimum_pa = 14.5e6);
    refuse(|e| e.pressure_minimum_pa = 0.);
    refuse(|e| e.shutdown_margin_minimum = 0.);
    refuse(|e| e.margin_water_term_factor = 0.5);
    refuse(|e| e.extrapolation_sensitivity = [1., 1., 2.]);
    refuse(|e| e.density_ratio_maximum = f64::NAN);
    let widened = extension().domains(original);
    assert_eq!(widened.density_ratio.maximum, 1.125);
    assert_eq!(widened.density_ratio.minimum, 0.85);
    assert_eq!(widened.pressure_pa.minimum, 12.5e6);
    assert_eq!(widened.pressure_pa.maximum, 16e6);
    assert_eq!(widened.moderator_temperature_k.minimum, 550.);
    let parsed: Extension = serde_json::from_str(
        r#"{"density_ratio_maximum":1.125,"pressure_minimum_pa":12500000,"shutdown_margin_minimum":0.01,"margin_water_term_factor":2,"extrapolation_sensitivity":[0.5,1,2]}"#,
    )
    .unwrap();
    assert_eq!(parsed, extension());
    assert!(
        serde_json::from_str::<Extension>(
            r#"{"density_ratio_maximum":1.125,"pressure_minimum_pa":12500000,"shutdown_margin_minimum":0.01,"margin_water_term_factor":2,"extrapolation_sensitivity":[0.5,1,2],"x":1}"#
        )
        .is_err()
    );
}

// --- A two-region source feedback with the same supports as its kinetics.

fn bounds(minimum: f64, maximum: f64) -> Bounds {
    Bounds { minimum, maximum }
}
fn domains() -> Domains {
    Domains {
        fuel_temperature_k: bounds(500., 1800.),
        moderator_temperature_k: bounds(550., 610.),
        pressure_pa: bounds(14e6, 16e6),
        density_ratio: bounds(0.85, 1.1),
        boron_ppm_eq: bounds(0., 2500.),
        fissile_ratio: bounds(0.95, 1.),
        reactivity: bounds(-0.3, 0.15),
        maximum_additional_reference_exposure_s: 172800.,
    }
}
const SUPPORTS: [(usize, usize); 4] = [(0, 0), (0, 1), (1, 0), (1, 1)];
fn feedback() -> sf::Model {
    let p = sf::Parameters {
        generation_time_s: LAMBDA,
        nu_effective: NU,
        doppler_per_sqrt_k: -0.00115,
        water_worth: 0.15,
        boron_per_ppm_eq: -8e-5,
        rod_worth: 0.10,
        sigma_xe_m2: 2e-22,
        sigma_sm_m2: 4e-24,
        capsule_births_per_s: 4e9,
        capsule_decay_per_s: std::f64::consts::LN_2 / 83469852.,
        inserted_active_bottom_m: -2.,
        rod_active_length_m: 4.,
        rod_maximum_travel_m: 4.,
        domains: domains(),
    };
    let regions = (0..2)
        .map(|i| sf::Region {
            rho_base: 0.002 * (i + 1) as f64,
            reference_density_kg_m3: 700.,
            reference_boron_ppm_eq: 1000.,
            reference_rod_overlap: if i == 0 { 0. } else { 0.6 },
            source_weight: 0.5,
            z0_m: -2. + 2. * i as f64,
            z1_m: 2. * i as f64,
            rod_weights: vec![0.5, 0.5],
        })
        .collect();
    let materials = (0..2)
        .map(|_| sf::Material {
            reference_fissile_atoms: 1e26,
            reference_fuel_temperature_k: 850.,
            reference_xenon_atoms: 2e17,
            reference_samarium_atoms: 1e18,
            reference_nonpoison_capture_opacity_m2: 0.001,
        })
        .collect();
    let supports = SUPPORTS
        .iter()
        .map(|&(region, material)| sf::Support {
            region,
            material,
            production_reference_per_s: 0.5 * gamma(),
            exposure_per_population_s_m2: 0.5 * gamma(),
            fuel_importance: 0.5,
        })
        .collect();
    sf::Model::new(p, regions, materials, supports).unwrap()
}
fn coupled() -> kinetics::Model {
    kinetics::Model::new(
        vec![region(), region()],
        vec![material(), material()],
        vec![
            Transfer {
                donor: 0,
                receiver: 1,
            },
            Transfer {
                donor: 1,
                receiver: 0,
            },
        ],
        SUPPORTS
            .iter()
            .map(|&(region, material)| kinetics::Support { region, material })
            .collect(),
    )
    .unwrap()
}
const TRANSFERS: [f64; 2] = [1000., 1000.];
const EMISSION: [f64; 4] = [0.5, 0.5, 0.5, 0.5];
const OUTSIDE: [f64; 2] = [0., 0.];
fn fixed() -> Fixed<'static> {
    Fixed {
        transfer_rates_per_s: &TRANSFERS,
        emission_fractions: &EMISSION,
        outside_fractions: &OUTSIDE,
    }
}

/// One accepted state: post-trip-like water and fuel, rods at `travel`.
struct State {
    fuel: Vec<Scalar>,
    density: Vec<Scalar>,
    boron: Vec<Scalar>,
    pressure: Vec<Scalar>,
    moderator: Vec<Scalar>,
    fissile: Vec<Scalar>,
    xenon: Vec<Scalar>,
    samarium: Vec<Scalar>,
    capture: Vec<Scalar>,
    rods: Vec<Scalar>,
}
fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
impl State {
    fn new(travel_m: f64, density_ratio: f64, pressure_pa: f64) -> Self {
        Self {
            fuel: vec![s(560.); 2],
            density: vec![s(700. * density_ratio); 2],
            boron: vec![s(1000.); 2],
            pressure: vec![s(pressure_pa); 2],
            moderator: vec![s(556.); 2],
            fissile: vec![s(1e26); 2],
            xenon: vec![s(2e17); 2],
            samarium: vec![s(1e18); 2],
            capture: vec![s(0.); 2],
            rods: vec![s(travel_m); 2],
        }
    }
    fn conditions(&self) -> Conditions<'_> {
        Conditions {
            fuel_temperature_k: &self.fuel,
            water_density_kg_m3: &self.density,
            boron_ppm_eq: &self.boron,
            pressure_pa: &self.pressure,
            moderator_temperature_k: &self.moderator,
            fissile_atoms: &self.fissile,
            xenon_atoms: &self.xenon,
            samarium_atoms: &self.samarium,
            capture_loss_change_m2: &self.capture,
            achieved_rod_travel_m: &self.rods,
            capsule_age_s: s(0.),
        }
    }
    fn admit(
        &self,
    ) -> Result<leitbild_operating_plant::joined::post_trip_domain::Admission, Error> {
        admit(
            &feedback(),
            &coupled(),
            fixed(),
            &[s(1e6), s(1e6)],
            self.conditions(),
            0.,
            &extension(),
        )
    }
}
fn exit(result: Result<impl std::fmt::Debug, Error>) -> (Domain, bool, &'static str) {
    match result {
        Err(Error::Unsupported {
            domain,
            margin_holds,
            exit: sf::Error::OutsideDomain(name, _),
        }) => (domain, margin_holds, name),
        other => panic!("expected an unsupported domain exit, got {other:?}"),
    }
}

#[test]
fn rods_in_and_a_held_margin_admit_the_post_trip_envelope_in_the_extended_domain() {
    // Rods fully in (travel 0): about -7 % dk/k against rho_base.
    let a = State::new(0., 1.12, 13e6).admit().unwrap();
    assert!(a.margin.holds && a.domain == Domain::Extended, "{a:?}");
    // The evaluated water term is reported before its factor.
    for w in &a.margin.water_terms {
        assert!((w - 0.15 * 0.12).abs() <= 1e-12, "{w}");
    }
    // Inclusive boundaries of the extension.
    let edge = State::new(0., 1.125, 12.5e6).admit().unwrap();
    assert_eq!(edge.domain, Domain::Extended);
    assert_eq!(
        exit(State::new(0., 1.13, 13e6).admit()),
        (Domain::Extended, true, "density ratio")
    );
    assert_eq!(
        exit(State::new(0., 1.12, 12.4e6).admit()),
        (Domain::Extended, true, "pressure")
    );
}

#[test]
fn without_the_margin_the_compiled_domain_applies() {
    // Rods at the at-power pose: the source-free operator is supercritical.
    let at_power = State::new(2.8, 1.0, 15.2e6).admit().unwrap();
    assert!(!at_power.margin.holds && at_power.domain == Domain::Original);
    assert_eq!(
        exit(State::new(2.8, 1.12, 15.2e6).admit()),
        (Domain::Original, false, "density ratio")
    );
    assert_eq!(
        exit(State::new(2.8, 1.05, 13e6).admit()),
        (Domain::Original, false, "pressure")
    );
    // Inside the original domain the verdict does not matter.
    let inside = State::new(2.8, 1.1, 14e6).admit().unwrap();
    assert_eq!(inside.domain, Domain::Original);
}

#[test]
fn the_margin_is_judged_on_the_doubled_water_term() {
    // Rods partly in: a margin that holds with the water term once but not
    // with it doubled must not widen the domain.
    let travel = (0..=280)
        .map(|k| k as f64 * 0.01)
        .find(|&t| {
            let st = State::new(t, 1.12, 13e6);
            let mut once = extension();
            once.margin_water_term_factor = 1.;
            let at = |e: &Extension| {
                admit(
                    &feedback(),
                    &coupled(),
                    fixed(),
                    &[s(1e6), s(1e6)],
                    st.conditions(),
                    0.,
                    e,
                )
            };
            at(&once).is_ok_and(|a| a.margin.holds)
                && matches!(
                    at(&extension()),
                    Err(Error::Unsupported {
                        margin_holds: false,
                        ..
                    })
                )
        })
        .expect("a pose where only the doubled water term fails the margin");
    let (domain, holds, name) = exit(State::new(travel, 1.12, 13e6).admit());
    assert_eq!(
        (domain, holds, name),
        (Domain::Original, false, "density ratio")
    );
}

/// Owner answer B1 as kinetics.md states it (S2-D42): an accepted state's
/// core regions must hold no vapour; the first region that does is the exit.
/// Liquid at or above saturation without vapour (G1's metastable liquid up to
/// its +0.5 K birth) is phase-absent; a phase that cannot be evaluated fails.
#[test]
fn a_region_with_vapour_or_an_unevaluable_phase_is_a_phase_absence_exit() {
    use leitbild_operating_plant::source_feedback::{
        Error, PHASE_ABSENCE, RegionPhase, phase_absence,
    };
    let liquid = RegionPhase {
        saturation_departure_k: -20.,
        vapor_kg: 0.,
    };
    assert_eq!(phase_absence(&[liquid; 3]), Ok(()));
    // At saturation and metastable up to G1's birth: no vapour, phase-absent.
    for departure in [0., 0.3, 0.5] {
        let mut metastable = [liquid; 3];
        metastable[1].saturation_departure_k = departure;
        assert_eq!(phase_absence(&metastable), Ok(()), "{departure} K");
    }
    let mut vapour = [liquid; 3];
    vapour[2].vapor_kg = 1e-12;
    vapour[0].saturation_departure_k = 0.4;
    assert_eq!(
        phase_absence(&vapour),
        Err(Error::OutsideDomain(PHASE_ABSENCE, 2))
    );
    assert_eq!(PHASE_ABSENCE, "phase absence");
    for bad in [f64::NAN, f64::INFINITY] {
        let mut departure = [liquid; 3];
        departure[0].saturation_departure_k = bad;
        assert_eq!(
            phase_absence(&departure),
            Err(Error::OutsideDomain(PHASE_ABSENCE, 0)),
            "{bad}"
        );
        let mut vapour = [liquid; 3];
        vapour[1].vapor_kg = bad;
        assert_eq!(
            phase_absence(&vapour),
            Err(Error::OutsideDomain(PHASE_ABSENCE, 1)),
            "{bad}"
        );
    }
}
