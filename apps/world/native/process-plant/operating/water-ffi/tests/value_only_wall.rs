//! The value-only wet-contact law on maintained IF97 water: `liquid_wall`
//! evaluated on plain `f64` values returns bit for bit the values, mode and
//! refusal of the same law on `Scalar`s with zero directions, over every
//! film and every wet/film branch. A seeded evaluation's value parts are
//! the same values wherever its seeds leave the branch selection unchanged.
use leitbild_operating_plant::thermal::*;
use leitbild_operating_water::If97;

type Outcome = std::result::Result<(&'static str, [u64; 4]), &'static str>;

fn outcome<N: Number>(r: Result<WallFluxOf<N>>) -> Outcome {
    r.map(|q| {
        (
            q.mode,
            [q.heat, q.vapor_mass, q.liquid_energy, q.vapor_energy].map(|x| x.value().to_bits()),
        )
    })
}

fn steel() -> WallMaterial {
    WallMaterial {
        conductivity: Scalar::constant(16.2),
        density: 7900.,
        cp: Scalar::constant(500.),
    }
}

fn heater(film: FilmBranch) -> Film {
    Film::Heater(HeaterFilm {
        sensible_w_m2_k: 2000.,
        onset_contact_angle_deg: 38.,
        wall_birth_fraction: 1.,
        minimum_film_bounds_k: [755.372222, 898.705556],
        film,
    })
}

fn laws(wall_t: f64) -> Vec<(&'static str, WallLaw)> {
    let law = |film, material| WallLaw {
        diameter_m: 0.0195,
        film,
        emissivity: 0.3,
        material,
    };
    vec![
        (
            "core",
            law(
                Film::Core,
                core_wall_material(Scalar::constant(wall_t), 6550.).unwrap(),
            ),
        ),
        ("tube", law(Film::Tube, steel())),
        ("external", law(Film::External, steel())),
        (
            "heater vertical",
            law(
                heater(FilmBranch::Vertical {
                    coefficient: 1.13,
                    length_m: 1.5,
                    convection_factor: 1.,
                }),
                steel(),
            ),
        ),
        (
            "heater resistance",
            law(heater(FilmBranch::Resistance { length_m: 0.004 }), steel()),
        ),
    ]
}

#[test]
fn value_only_wet_contact_is_the_zero_direction_law_bit_for_bit() {
    let props = If97;
    let pressures = [1e5, 1e6, 5e6, 7e6, 1e7, 12e6, 15.5e6, 16e6];
    let subcooling = [60., 20., 5., 0.5, 0., -0.5];
    let superheat = [
        -10., 0.5, 2., 5., 10., 20., 30., 50., 80., 120., 200., 300., 450., 600.,
    ];
    let fluxes = [0., 300., 3000., -1500.];
    let mut modes = std::collections::BTreeMap::<(&str, &str), usize>::new();
    let mut refusals = std::collections::BTreeMap::<&str, usize>::new();
    let mut cases = 0;
    let mut seeded_compared = 0;
    for p in pressures {
        let sat = props
            .saturation(Scalar::constant(p))
            .unwrap()
            .temperature
            .value;
        for dt in subcooling {
            // The exact saturation temperature exercises the standalone
            // endpoint identity; the others a distinct bulk tuple.
            let bulk_t = if dt == 0. { sat } else { sat - dt };
            let mut walls: Vec<f64> = superheat.iter().map(|x| sat + x).collect();
            walls.extend([bulk_t - 5., bulk_t, bulk_t + 0.25]);
            for wall_t in walls {
                for flux in fluxes {
                    for (name, law) in laws(wall_t) {
                        let c = Scalar::constant;
                        let reference = outcome(liquid_wall(
                            &props,
                            c(p),
                            c(bulk_t),
                            c(wall_t),
                            c(flux),
                            law,
                        ));
                        let value = outcome(liquid_wall::<_, f64>(
                            &props,
                            p,
                            bulk_t,
                            wall_t,
                            flux,
                            law.values(),
                        ));
                        assert_eq!(
                            value, reference,
                            "{name} p {p} bulk {bulk_t} wall {wall_t} flux {flux}"
                        );
                        cases += 1;
                        match reference {
                            Ok((mode, _)) => *modes.entry((name, mode)).or_default() += 1,
                            Err(e) => *refusals.entry(e).or_default() += 1,
                        }
                        // Seeds change no value part: every Scalar operation's
                        // value is its f64 operation, and the adapter returns
                        // the same forward point for any direction. The exact
                        // saturated bulk is the one seed-dependent selection.
                        if dt != 0. {
                            let mut seeded = law;
                            seeded.material.conductivity.direction = 0.013;
                            seeded.material.cp.direction = -0.21;
                            let directed = outcome(liquid_wall(
                                &props,
                                Scalar::new(p, 1250.),
                                Scalar::new(bulk_t, -0.7),
                                Scalar::new(wall_t, 1.3),
                                Scalar::new(flux, 40.),
                                seeded,
                            ));
                            if let (Ok(a), Ok(b)) = (&directed, &value) {
                                assert_eq!(a, b, "seeded {name} p {p} bulk {bulk_t} wall {wall_t}");
                                seeded_compared += 1;
                            }
                        }
                    }
                }
            }
        }
    }
    eprintln!("cases {cases}, seeded value parts compared {seeded_compared}");
    for ((film, mode), n) in &modes {
        eprintln!("  {film:18} {mode:10} {n}");
    }
    for (e, n) in &refusals {
        eprintln!("  refused {n:5} {e}");
    }
    for (film, _) in laws(600.) {
        for mode in ["sensible", "nucleate", "transition", "film"] {
            assert!(
                modes.contains_key(&(film, mode)),
                "{film} never reached its {mode} branch"
            );
        }
    }
}
