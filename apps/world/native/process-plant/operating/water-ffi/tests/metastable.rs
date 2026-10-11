//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#bounded-metastable-admission
//! Bounded metastable admission on the explicitly requested branch, in the
//! band's two ranges: region-1 Eq. (7) above saturation; below it region-2
//! Eq. (15) for 10 < p <= 16 MPa and IF97's metastable-vapor Eq. (18) for
//! 5.9 < p <= 10 MPa; the trial-band refusal outside; the accepted-state band
//! report; and the liquid and vapor pressure ceilings.
use leitbild_operating_water::{
    Band, Branch, CaloricLinearization, Error, MetastableBand, WaterPoint, band_check, directional,
    eq18_reference, point, point_ph, point_pu,
};
use serde_json::Value;

fn saturation(p: f64) -> f64 {
    point(Branch::SaturatedLiquid, p, 0.).unwrap().temperature_k
}

/// The 10-16 MPa range (Eq. 15) and the 5.9-10 MPa range (Eq. 18).
const HIGH: [f64; 4] = [10e6 + 1., 12e6, 15.5e6, 16e6];
const LOW: [f64; 4] = [5.9e6 + 1., 7e6, 8.5e6, 10e6];

#[test]
fn compiled_band_is_the_receipt_band_from_the_wiki_block() {
    let directory = std::env::var("LD01_OPERATING_WATER_LIB_DIR").unwrap();
    let receipt: Value =
        serde_json::from_slice(&std::fs::read(format!("{directory}/water-build.json")).unwrap())
            .unwrap();
    let record = &receipt["metastableBand"];
    assert_eq!(record["fence"], "ld01-metastable-band");
    assert_eq!(record["pageSha256"].as_str().unwrap().len(), 64);
    let b = &record["block"];
    let l = &b["lowPressureBand"];
    assert_eq!(l["vaporEquation"], "IF97 Eq. (18)");
    let f = |v: &Value, k: &str| v[k].as_f64().unwrap();
    let c = MetastableBand::compiled();
    let [high, low] = c.ranges;
    assert_eq!((high.vapor_equation, low.vapor_equation), (15, 18));
    let compiled = [
        c.trial_max_k,
        c.credited_max_k,
        c.liquid_temperature_max_k,
        c.liquid_pressure_ceiling_pa,
        c.vapor_pressure_ceiling_pa,
        high.pressure_low_pa,
        high.pressure_high_pa,
        high.liquid_superheat_max_k,
        high.vapor_subcooling_max_k,
        low.pressure_low_pa,
        low.pressure_high_pa,
        low.liquid_superheat_max_k,
        low.vapor_subcooling_max_k,
    ];
    let block = [
        f(b, "trialMax_K"),
        f(b, "creditedMax_K"),
        f(b, "liquidTemperatureMax_K"),
        f(b, "liquidPressureCeiling_Pa"),
        f(b, "vaporPressureCeiling_Pa"),
        b["pressureRange_Pa"][0].as_f64().unwrap(),
        b["pressureRange_Pa"][1].as_f64().unwrap(),
        f(b, "liquidSuperheatMax_K"),
        f(b, "vaporSubcoolingMax_K"),
        l["pressureRange_Pa"][0].as_f64().unwrap(),
        l["pressureRange_Pa"][1].as_f64().unwrap(),
        f(l, "liquidSuperheatMax_K"),
        f(l, "vaporSubcoolingMax_K"),
    ];
    assert_eq!(compiled.map(f64::to_bits), block.map(f64::to_bits));
    assert_eq!(
        (
            high.lower_bound_exclusive != 0,
            low.lower_bound_exclusive != 0
        ),
        (
            b["lowerBoundExclusive"].as_bool().unwrap(),
            l["lowerBoundExclusive"].as_bool().unwrap()
        )
    );
}

/// IF97 Table 18: Eq. (18) at (T, p) gives v, h, u, s, cp, w; the published
/// values have nine significant digits.
#[test]
fn eq18_reproduces_if97_table_18() {
    for (t, p_mpa, table) in [
        (
            450.,
            1.,
            [
                0.192516540,
                2768.81115e3,
                2576.29461e3,
                6.56660377e3,
                2.76349265e3,
                498.408101,
            ],
        ),
        (
            440.,
            1.,
            [
                0.186212297,
                2740.15123e3,
                2553.93894e3,
                6.50218759e3,
                2.98166443e3,
                489.363295,
            ],
        ),
        (
            450.,
            1.5,
            [
                0.121685206,
                2721.34539e3,
                2538.81758e3,
                6.29170440e3,
                3.62795578e3,
                481.941819,
            ],
        ),
    ] {
        let q = eq18_reference(t, p_mpa * 1e6).unwrap();
        for (actual, expected) in q.iter().zip(table) {
            assert!(
                (actual / expected - 1.).abs() < 5e-9,
                "{t} K {p_mpa} MPa: {actual} versus {expected}"
            );
        }
    }
}

#[test]
fn metastable_states_are_admitted_inside_the_trial_band_only() {
    let band = MetastableBand::compiled();
    for (p, equation) in HIGH
        .map(|p| (p, 15))
        .into_iter()
        .chain(LOW.map(|p| (p, 18)))
    {
        let ts = saturation(p);
        let top = (ts + band.trial_max_k).min(band.liquid_temperature_max_k);
        for t in [ts + 1e-9, ts + 1., top] {
            let q = point(Branch::Liquid, p, t).unwrap();
            assert_eq!(q.region, 1);
            assert_eq!(q.saturation_departure_k, t - ts);
        }
        assert_eq!(
            point(Branch::Liquid, p, top.next_up()).unwrap_err(),
            Error::TrialBand
        );
        let bottom = ts - band.trial_max_k;
        for t in [ts - 1e-6, ts - 1., bottom] {
            let q = point(Branch::Vapor, p, t).unwrap();
            assert_eq!(q.region, 2);
            assert_eq!(q.saturation_departure_k, t - ts);
            if equation == 18 {
                // The admitted state is Eq. (18)'s, not Eq. (15)'s.
                let r = eq18_reference(t, p).unwrap();
                assert_eq!(q.enthalpy_j_kg, r[1]);
                assert_eq!(1. / q.density_kg_m3, r[0]);
            }
        }
        assert_eq!(
            point(Branch::Vapor, p, bottom.next_down()).unwrap_err(),
            Error::TrialBand
        );
    }
    // The low range's lower edge (5.9 MPa) is excluded; below it there is none.
    for p in [5.9e6, 4e6, 1e5] {
        let ts = saturation(p);
        assert_eq!(
            point(Branch::Vapor, p, ts - 0.5).unwrap_err(),
            Error::TrialBand
        );
        assert_eq!(
            point(Branch::Liquid, p, ts + 0.5).unwrap_err(),
            Error::TrialBand
        );
        assert!(point(Branch::Vapor, p, ts + 0.5).is_ok());
        assert!(point(Branch::Liquid, p, ts - 0.5).is_ok());
    }
}

#[test]
fn pressure_ceilings_admit_stable_liquid_to_17_mpa_and_vapor_to_16_mpa() {
    let p = 16.24e6;
    let ts = saturation(p);
    let liquid = point(Branch::Liquid, p, 600.).unwrap();
    assert_eq!(liquid.region, 1);
    let recovered = point_pu(Branch::Liquid, p, liquid.internal_energy_j_kg).unwrap();
    assert!((recovered.temperature_k - 600.).abs() < 2e-8);
    assert_eq!(point(Branch::Vapor, p, 650.).unwrap_err(), Error::Domain);
    assert_eq!(
        point(Branch::SaturatedVapor, p, 0.).unwrap_err(),
        Error::Domain
    );
    // Above the band's pressure ranges a liquid is admitted only stable.
    assert_eq!(
        point(Branch::Liquid, p, ts + 0.1).unwrap_err(),
        Error::TrialBand
    );
    assert!(point(Branch::Liquid, 17e6, 600.).is_ok());
    assert_eq!(
        point(Branch::Liquid, 17e6f64.next_up(), 600.).unwrap_err(),
        Error::Domain
    );
    // Where saturation lies above the region-1 limit, the liquid inverse's
    // stable end is region 1 at 623.15 K and nothing above it is admitted.
    let p = 16.9e6;
    let u = point(Branch::Liquid, p, 620.).unwrap().internal_energy_j_kg;
    assert!((point_pu(Branch::Liquid, p, u).unwrap().temperature_k - 620.).abs() < 2e-8);
    let limit = point(Branch::Liquid, p, 623.15).unwrap();
    assert_eq!(
        point_pu(Branch::Liquid, p, limit.internal_energy_j_kg + 1.).unwrap_err(),
        Error::TrialBand
    );
    assert_eq!(point(Branch::Liquid, p, 623.2).unwrap_err(), Error::Domain);
}

#[test]
fn caloric_inverse_recovers_metastable_states_and_refuses_beyond_the_trial_end() {
    let band = MetastableBand::compiled();
    for p in HIGH.into_iter().chain(LOW) {
        let ts = saturation(p);
        let top = (ts + band.trial_max_k).min(band.liquid_temperature_max_k);
        let bottom = ts - band.trial_max_k;
        for (branch, t) in [
            (Branch::Liquid, ts + 0.25),
            (Branch::Liquid, ts + 1.9),
            (Branch::Liquid, top),
            (Branch::Vapor, ts - 0.25),
            (Branch::Vapor, ts - 1.3),
            (Branch::Vapor, bottom),
        ] {
            let q = point(branch, p, t).unwrap();
            for enthalpy in [false, true] {
                let r = if enthalpy {
                    point_ph(branch, p, q.enthalpy_j_kg)
                } else {
                    point_pu(branch, p, q.internal_energy_j_kg)
                }
                .unwrap();
                assert!((r.temperature_k - t).abs() < 2e-8, "{branch:?} {p} {t}");
                assert_eq!(r.region, q.region);
                assert!((r.saturation_departure_k - (t - ts)).abs() < 2e-8);
            }
            // Directions inside the band; at a trial end its probes stay inside.
            let c =
                CaloricLinearization::internal_energy(branch, p, q.internal_energy_j_kg).unwrap();
            if t != top && t != bottom {
                let d = c.directional(1e4, 1e3).unwrap();
                assert!(fields(d).iter().all(|v| v.is_finite()));
            }
        }
        let top = point(Branch::Liquid, p, top).unwrap();
        assert_eq!(
            point_pu(Branch::Liquid, p, top.internal_energy_j_kg + 1.).unwrap_err(),
            Error::TrialBand
        );
        let bottom = point(Branch::Vapor, p, bottom).unwrap();
        assert_eq!(
            point_pu(Branch::Vapor, p, bottom.internal_energy_j_kg - 1.).unwrap_err(),
            Error::TrialBand
        );
    }
    // At the corner of the band's top pressure and its trial end, an outward
    // direction has no admitted probe on either side: refused, not clamped.
    let p = 16e6;
    let bottom = point(Branch::Vapor, p, saturation(p) - band.trial_max_k).unwrap();
    let corner =
        CaloricLinearization::internal_energy(Branch::Vapor, p, bottom.internal_energy_j_kg)
            .unwrap();
    assert_eq!(corner.directional(1e4, 1e3).unwrap_err(), Error::Domain);
}

/// Eq. (18) and the Eq. (15) endpoint differ at saturation. Where Eq. (18)'s
/// own saturated energy lies below the endpoint's, an energy between the two
/// is on neither branch and is refused; elsewhere energies just below the
/// endpoint are Eq. (18) states just below saturation.
#[test]
fn eq18_bracket_ends_at_its_own_saturation_state() {
    for p in [6e6, 7e6, 8e6, 9e6, 10e6] {
        let ts = saturation(p);
        let endpoint = point(Branch::SaturatedVapor, p, 0.).unwrap();
        let own = eq18_reference(ts, p).unwrap();
        let (u15, u18) = (endpoint.internal_energy_j_kg, own[2]);
        if u18 < u15 {
            assert_eq!(
                point_pu(Branch::Vapor, p, 0.5 * (u18 + u15)).unwrap_err(),
                Error::TrialBand
            );
            assert_eq!(
                point_pu(Branch::Vapor, p, u18).unwrap_err(),
                Error::TrialBand
            );
            let q = point_pu(Branch::Vapor, p, u18 - 1.).unwrap();
            assert!(q.saturation_departure_k < 0. && q.saturation_departure_k > -1e-3);
        } else {
            let q = point_pu(Branch::Vapor, p, u15 - 1.).unwrap();
            assert!(q.saturation_departure_k < 0. && q.saturation_departure_k > -1e-2);
        }
        // The stable side and the endpoint itself are unchanged.
        let q = point_pu(Branch::Vapor, p, u15).unwrap();
        assert_eq!(q.temperature_k, ts);
    }
}

/// An Eq. (18) state's coefficient directions are probed on Eq. (18) only: a
/// pure temperature direction just below saturation matches an Eq. (18)
/// central difference, with no step onto Eq. (15).
#[test]
fn eq18_directions_do_not_mix_equations() {
    for p in [7e6, 8.5e6] {
        let ts = saturation(p);
        for t in [ts - 1e-3, ts - 0.5] {
            let (q, d) = directional(Branch::Vapor, p, t, 0., 1.).unwrap();
            assert_eq!(q.temperature_k, t);
            let h = 2e-4;
            let cp = |t: f64| eq18_reference(t, p).unwrap()[4];
            let reference = if t + h < ts {
                (cp(t + h) - cp(t - h)) / (2. * h)
            } else {
                (-3. * cp(t) + 4. * cp(t - h) - cp(t - 2. * h)) / (-2. * h)
            };
            assert!(
                (d.cp_j_kg_k - reference).abs() <= 2e-3 * reference.abs(),
                "{p} {t}: {} versus {reference}",
                d.cp_j_kg_k
            );
        }
    }
}

fn fields(q: WaterPoint) -> [f64; 13] {
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
        q.saturation_departure_k,
    ]
}

#[test]
fn band_check_reports_signed_departures_and_never_clamps() {
    for (p, vapor_limit) in [(15.5e6, 1.4), (8e6, 1.1)] {
        let ts = saturation(p);
        let check = |branch: Branch, t: f64| band_check(branch, &point(branch, p, t).unwrap());
        for (branch, t, band) in [
            (Branch::Liquid, ts - 5., Band::Stable),
            (Branch::Liquid, ts + 0.3, Band::Admitted { credited: true }),
            (Branch::Liquid, ts + 1.5, Band::Admitted { credited: false }),
            (Branch::Liquid, ts + 2.5, Band::Exceeded),
            (Branch::Vapor, ts + 5., Band::Stable),
            (Branch::Vapor, ts - 0.3, Band::Admitted { credited: true }),
            (
                Branch::Vapor,
                ts - (vapor_limit - 0.05),
                Band::Admitted { credited: false },
            ),
            (Branch::Vapor, ts - (vapor_limit + 0.05), Band::Exceeded),
        ] {
            let report = check(branch, t);
            assert_eq!(report.band, band, "{p} {branch:?} {}", t - ts);
            assert_eq!(report.departure_k, t - ts);
        }
        for branch in [Branch::SaturatedLiquid, Branch::SaturatedVapor] {
            let report = band_check(branch, &point(branch, p, 0.).unwrap());
            assert_eq!((report.departure_k, report.band), (0., Band::Stable));
        }
        let u = point(Branch::Liquid, p, ts + 2.5)
            .unwrap()
            .internal_energy_j_kg;
        let held = CaloricLinearization::internal_energy(Branch::Liquid, p, u).unwrap();
        assert_eq!(held.band().band, Band::Exceeded);
        assert!((held.band().departure_k - 2.5).abs() < 2e-8);
    }
}

fn compare(row: &Value, q: WaterPoint, values: &Value, keys: &[(&str, f64)]) -> f64 {
    let mut worst = 0f64;
    for (key, actual) in keys {
        let expected = values[*key].as_f64().unwrap();
        let rel = (actual / expected - 1.).abs();
        worst = worst.max(rel);
        assert!(rel <= 1e-12, "{key} {rel:e}: {row} {q:?}");
    }
    worst
}

/// Team M's receipt evaluated the same region-1/region-2 basic equations
/// through the adapter's gibbs(). Admitted rows must match it; rows beyond the
/// band, its pressure ranges or a ceiling must be refused. Vapor rows on the
/// metastable side at 10 MPa belong to Eq. (18) and the low-pressure receipt.
#[test]
#[ignore = "requires LD01_METASTABLE_RECEIPT (metastable-band-check receipt)"]
fn admitted_states_match_the_metastable_band_receipt() {
    let path = std::env::var("LD01_METASTABLE_RECEIPT").unwrap();
    let receipt: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let band = MetastableBand::compiled();
    let (mut matched, mut refused, mut worst) = (0usize, 0usize, 0f64);
    for row in receipt["rows"].as_array().unwrap() {
        let p = row["pMPa"].as_f64().unwrap() * 1e6;
        let t = row["T"].as_f64().unwrap();
        let liquid = row["branch"] == "liquid";
        let branch = if liquid {
            Branch::Liquid
        } else {
            Branch::Vapor
        };
        let ts = saturation(p);
        let departure = if liquid { t - ts } else { ts - t };
        if !liquid && departure > 1e-9 && band.ranges[1].contains(p) {
            continue;
        }
        let ceiling = if liquid {
            band.liquid_pressure_ceiling_pa
        } else {
            band.vapor_pressure_ceiling_pa
        };
        let edge = (departure.abs() - band.trial_max_k).abs() < 1e-9
            || (liquid && (t - band.liquid_temperature_max_k).abs() < 1e-9)
            || departure.abs() < 1e-9;
        let admitted = p <= ceiling
            && (departure < 0.
                || (band.range_at(p).is_some()
                    && departure <= band.trial_max_k
                    && !(liquid && t > band.liquid_temperature_max_k)));
        match point(branch, p, t) {
            Ok(q) => {
                assert!(admitted || edge, "admitted outside the band: {row}");
                let keys = [
                    ("rho", q.density_kg_m3),
                    ("u", q.internal_energy_j_kg),
                    ("h", q.enthalpy_j_kg),
                    ("cp", q.cp_j_kg_k),
                    ("cv", q.cv_j_kg_k),
                    ("alpha", q.expansion_per_k),
                    ("kappa", q.compressibility_per_pa),
                    ("mu", q.viscosity_pa_s),
                    ("k", q.conductivity_w_m_k),
                ];
                worst = worst.max(compare(row, q, &row["if97"]["values"], &keys));
                matched += 1;
            }
            Err(e) => {
                assert!(!admitted || edge, "refused inside the band ({e:?}): {row}");
                refused += 1;
            }
        }
    }
    println!(
        "{}",
        serde_json::json!({"kind":"metastable-receipt-comparison","matched":matched,"refused":refused,"max_relative":worst})
    );
    assert!(matched >= 150);
}

/// Team M's low-pressure receipt: liquid on Eq. (7), metastable vapor on
/// Eq. (18) and stable vapor on Eq. (15), 2-10 MPa and 5.9 MPa. Admitted
/// rows (5.9 < p <= 10 MPa on the metastable side, every stable row) must
/// match the equation the boundary uses; the others must be refused.
#[test]
#[ignore = "requires LD01_METASTABLE_LOW_RECEIPT (low-pressure metastable-band receipt)"]
fn admitted_states_match_the_low_pressure_receipt() {
    let path = std::env::var("LD01_METASTABLE_LOW_RECEIPT").unwrap();
    let receipt: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let band = MetastableBand::compiled();
    let (mut matched, mut refused, mut eq18, mut worst) = (0usize, 0usize, 0usize, 0f64);
    for row in receipt["rows"].as_array().unwrap() {
        let p = row["pMPa"].as_f64().unwrap() * 1e6;
        let t = row["T"].as_f64().unwrap();
        let liquid = row["branch"] == "liquid";
        let branch = if liquid {
            Branch::Liquid
        } else {
            Branch::Vapor
        };
        let ts = saturation(p);
        let departure = if liquid { t - ts } else { ts - t };
        let edge = (departure.abs() - band.trial_max_k).abs() < 1e-9 || departure.abs() < 1e-9;
        let metastable = departure > 0.;
        let admitted = !metastable || (band.ranges[1].contains(p) && departure <= band.trial_max_k);
        let equation = if liquid {
            "eq7"
        } else if metastable {
            "eq18"
        } else {
            "eq15"
        };
        match point(branch, p, t) {
            Ok(q) => {
                assert!(admitted || edge, "admitted outside the band: {row}");
                if edge {
                    continue;
                }
                let keys = [
                    ("rho", q.density_kg_m3),
                    ("u", q.internal_energy_j_kg),
                    ("h", q.enthalpy_j_kg),
                    ("cp", q.cp_j_kg_k),
                    ("cv", q.cv_j_kg_k),
                    ("alpha", q.expansion_per_k),
                    ("kappaT", q.compressibility_per_pa),
                ];
                let values = &row["variants"][equation]["values"];
                worst = worst.max(compare(row, q, values, &keys));
                matched += 1;
                eq18 += usize::from(equation == "eq18");
            }
            Err(e) => {
                assert!(!admitted || edge, "refused inside the band ({e:?}): {row}");
                refused += 1;
            }
        }
    }
    println!(
        "{}",
        serde_json::json!({"kind":"metastable-low-receipt-comparison","matched":matched,"eq18":eq18,"refused":refused,"max_relative":worst})
    );
    assert!(matched >= 100 && eq18 >= 25);
}
