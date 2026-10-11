//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#bounded-metastable-admission
//! Bounded metastable admission on the explicitly requested branch, one band
//! over its whole pressure range (owner decision request 3, H3): region-1
//! Eq. (7) for liquid and region-2 Eq. (15) for vapor, each on both sides of
//! saturation, with no second vapor equation below 10 MPa; the trial-band
//! refusal outside; the accepted-state band report at the band's edges;
//! saturated vapor through the caloric inverse; and the pressure ceilings.
use leitbild_operating_water::{
    Band, Branch, CaloricLinearization, Error, MetastableBand, WaterPoint, band_check, directional,
    directional_pu, point, point_ph, point_pu,
};
use serde_json::Value;

fn saturation(p: f64) -> f64 {
    point(Branch::SaturatedLiquid, p, 0.).unwrap().temperature_k
}

/// Pressures across the band: the PACTEL ATWS-10 trace minimum (5.36 MPa),
/// G2 (a)'s former 5.9 MPa edge, its 8-9 MPa saturated-vapor gap, both sides
/// of 10 MPa and the band's top.
const PRESSURES: [f64; 11] = [
    2.5e6, 5.36e6, 5.9e6, 8e6, 8.5e6, 9e6, 9.99e6, 10e6, 10.01e6, 15.5e6, 16e6,
];

#[test]
fn compiled_band_is_the_receipt_band_from_the_wiki_block() {
    let directory = std::env::var("LD01_OPERATING_WATER_LIB_DIR").unwrap();
    let receipt: Value =
        serde_json::from_slice(&std::fs::read(format!("{directory}/water-build.json")).unwrap())
            .unwrap();
    let block = &receipt["metastableBand"];
    assert_eq!(block["heading"], "Bounded metastable admission");
    assert_eq!(block["fence"], "ld01-metastable-band");
    assert_eq!(block["pageSha256"].as_str().unwrap().len(), 64);
    let b = &block["band"];
    let f = |k: &str| b[k].as_f64().unwrap();
    let c = MetastableBand::compiled();
    assert_eq!(
        [
            c.pressure_low_pa,
            c.pressure_high_pa,
            c.trial_max_k,
            c.liquid_superheat_max_k,
            c.vapor_subcooling_max_k,
            c.credited_max_k,
            c.liquid_temperature_max_k,
            c.liquid_pressure_ceiling_pa,
            c.vapor_pressure_ceiling_pa,
        ]
        .map(f64::to_bits),
        [
            b["pressureRange_Pa"][0].as_f64().unwrap(),
            b["pressureRange_Pa"][1].as_f64().unwrap(),
            f("trialMax_K"),
            f("liquidSuperheatMax_K"),
            f("vaporSubcoolingMax_K"),
            f("creditedMax_K"),
            f("liquidTemperatureMax_K"),
            f("liquidPressureCeiling_Pa"),
            f("vaporPressureCeiling_Pa"),
        ]
        .map(f64::to_bits)
    );
    assert_eq!(
        c.lower_bound_exclusive != 0,
        b["lowerBoundExclusive"].as_bool().unwrap()
    );
}

#[test]
fn metastable_states_are_admitted_inside_the_trial_band_only() {
    let band = MetastableBand::compiled();
    for p in PRESSURES
        .into_iter()
        .chain([2e6f64.next_up(), 2e6 + 1., 12e6])
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
        for t in [ts - 1e-9, ts - 1., bottom] {
            let q = point(Branch::Vapor, p, t).unwrap();
            assert_eq!(q.region, 2);
            assert_eq!(q.saturation_departure_k, t - ts);
        }
        assert_eq!(
            point(Branch::Vapor, p, bottom.next_down()).unwrap_err(),
            Error::TrialBand
        );
    }
    // The band's lower edge, 2 MPa, is excluded: at and below it a metastable
    // state is refused on both branches, forward and through the inverse.
    for p in [2e6, 2e6f64.next_down(), 1.5e6, 1e6, 1e5] {
        let ts = saturation(p);
        for (branch, t) in [
            (Branch::Vapor, ts - 0.5),
            (Branch::Vapor, ts - 1e-6),
            (Branch::Liquid, ts + 0.5),
            (Branch::Liquid, ts + 1e-6),
        ] {
            assert_eq!(point(branch, p, t).unwrap_err(), Error::TrialBand, "{p}");
        }
        let vapor = point(Branch::SaturatedVapor, p, 0.).unwrap();
        let liquid = point(Branch::SaturatedLiquid, p, 0.).unwrap();
        assert_eq!(
            point_pu(Branch::Vapor, p, vapor.internal_energy_j_kg - 1.).unwrap_err(),
            Error::TrialBand
        );
        assert_eq!(
            point_pu(Branch::Liquid, p, liquid.internal_energy_j_kg + 1.).unwrap_err(),
            Error::TrialBand
        );
        assert!(point(Branch::Vapor, p, ts + 0.5).is_ok());
        assert!(point(Branch::Liquid, p, ts - 0.5).is_ok());
    }
}

/// The extreme temperature on `branch` at `p` whose metastable departure
/// (liquid superheat or vapor subcooling) is within `limit`, and the next
/// representable temperature beyond it.
fn edge(branch: Branch, p: f64, limit: f64) -> (f64, f64) {
    let liquid = matches!(branch, Branch::Liquid);
    let metastable = |t: f64| {
        let d = point(branch, p, t).unwrap().saturation_departure_k;
        if liquid { d } else { -d }
    };
    let outward = |t: f64| if liquid { t.next_up() } else { t.next_down() };
    let ts = saturation(p);
    let mut t = if liquid { ts + limit } else { ts - limit };
    if metastable(t) > limit {
        t = if liquid { t.next_down() } else { t.next_up() };
    }
    assert!(metastable(t) <= limit && metastable(outward(t)) > limit);
    (t, outward(t))
}

/// The accepted band is liquid +2 K and vapor -1.4 K at every pressure of the
/// band: a state at the edge is admitted, the next one beyond it exceeds the
/// band (an applicability failure, still a trial state, never clamped), and
/// the caloric inverse reports the same on either side of the edge.
#[test]
fn accepted_states_are_admitted_to_liquid_plus_2_k_and_vapor_minus_1_4_k() {
    let band = MetastableBand::compiled();
    assert_eq!(
        (band.liquid_superheat_max_k, band.vapor_subcooling_max_k),
        (2., 1.4)
    );
    for p in PRESSURES {
        for (branch, limit, sign) in [
            (Branch::Liquid, band.liquid_superheat_max_k, 1.),
            (Branch::Vapor, band.vapor_subcooling_max_k, -1.),
        ] {
            let (inside, beyond) = edge(branch, p, limit);
            let report = |t: f64| band_check(branch, &point(branch, p, t).unwrap()).band;
            assert_eq!(
                report(inside),
                Band::Admitted { credited: false },
                "{branch:?} {p}"
            );
            assert_eq!(report(beyond), Band::Exceeded, "{branch:?} {p}");
            for (offset, expected) in [
                (-1e-6, Band::Admitted { credited: false }),
                (1e-6, Band::Exceeded),
            ] {
                let t = inside + sign * offset;
                let u = point(branch, p, t).unwrap().internal_energy_j_kg;
                let held = CaloricLinearization::internal_energy(branch, p, u).unwrap();
                assert_eq!(held.band().band, expected, "{branch:?} {p} {offset}");
                assert!((held.point().temperature_k - t).abs() < 2e-8);
            }
        }
    }
}

/// Whether three values one step apart lie on one smooth curve: the two
/// one-sided differences agree to 0.1% beyond rounding. A jump or a kink
/// between them, as a second equation on one side would leave, fails.
fn smooth(before: f64, at: f64, after: f64) -> bool {
    let (a, b) = (at - before, after - at);
    (b - a).abs() <= 1e-3 * (a.abs() + b.abs()) + 16. * f64::EPSILON * at.abs()
}

/// A first-order step from `at` by the exact slope `slope`, within 0.1%
/// beyond rounding.
fn tangent(at: f64, after: f64, slope: f64) -> bool {
    (after - at - slope).abs() <= 1e-3 * slope.abs() + 16. * f64::EPSILON * at.abs()
}

/// One equation per branch on both sides of saturation everywhere in the
/// band: the stable state, the saturated endpoint and the metastable state
/// 1e-5 K apart lie on one smooth curve, along the endpoint's exact rho/u/h
/// temperature slopes. (At 1e-5 K the cv rounding noise, about 300 ulps,
/// stays below 3e-4 of the one-sided differences.) A second equation on the
/// metastable side would leave a jump at saturation.
#[test]
fn each_branch_has_one_equation_on_both_sides_of_saturation() {
    let h = 1e-5;
    for p in PRESSURES.into_iter().chain([2e6 + 1.]) {
        let ts = saturation(p);
        // The metastable side is above Tsat for liquid and below it for vapor.
        for (branch, side) in [(Branch::Liquid, 1.), (Branch::Vapor, -1.)] {
            let at = |t: f64| fields(point(branch, p, t).unwrap());
            let (stable, end, metastable) = (at(ts - side * h), at(ts), at(ts + side * h));
            assert!(metastable[12] * side > 0. && stable[12] * side < 0.);
            for k in 2..=10 {
                assert!(
                    smooth(stable[k], end[k], metastable[k]),
                    "{branch:?} {p} field {k}: {} {} {}",
                    stable[k],
                    end[k],
                    metastable[k]
                );
            }
            let (_, d) = directional(branch, p, ts, 0., 1.).unwrap();
            for (k, slope) in [
                (2, d.density_kg_m3),
                (3, d.internal_energy_j_kg),
                (4, d.enthalpy_j_kg),
            ] {
                for (step, x) in [(-side * h, stable), (side * h, metastable)] {
                    assert!(
                        tangent(end[k], x[k], step * slope),
                        "{branch:?} {p} field {k}"
                    );
                }
            }
        }
    }
}

/// Metastable vapor across 10 MPa, where IF97 would hand vapor to Eq. (18):
/// at fixed temperatures below Tsat(10 MPa) every field is smooth through
/// 10 MPa, at 1 Pa and at one ulp, and rho/u/h follow their exact pressure
/// slopes on both sides.
#[test]
fn metastable_vapor_is_continuous_across_10_mpa() {
    let p = 10e6;
    let ts = saturation(p);
    for d in [1e-3, 0.25, 1., 1.4, 2.9] {
        let t = ts - d;
        let at = |p: f64| fields(point(Branch::Vapor, p, t).unwrap());
        let (low, mid, high) = (at(p - 1.), at(p), at(p + 1.));
        let (below, above) = (at(p.next_down()), at(p.next_up()));
        assert!(low[12] < 0. && high[12] < 0.);
        for k in 2..=10 {
            assert!(smooth(low[k], mid[k], high[k]), "{d} K field {k}");
            assert!(smooth(below[k], mid[k], above[k]), "{d} K field {k}");
        }
        let (_, slope) = directional(Branch::Vapor, p, t, 1., 0.).unwrap();
        for (k, s) in [
            (2, slope.density_kg_m3),
            (3, slope.internal_energy_j_kg),
            (4, slope.enthalpy_j_kg),
        ] {
            assert!(
                tangent(mid[k], low[k], -s) && tangent(mid[k], high[k], s),
                "{d} K field {k}"
            );
        }
    }
}

/// The former S6 obligation. Under G2 (a), Eq. (18) and the region-2 endpoint
/// left a 5-14 J/kg vapor-energy gap at Tsat between 8 and 9 MPa that the
/// inverse refused. On one equation, saturated vapor there (u and v of
/// Eq. (15) at Tsat) is the inverse's own endpoint, energies across the former
/// gap are Eq. (15) states just below saturation, and Newton in pressure on
/// v(p, u) = v recovers the saturated pressure from the metastable side.
#[test]
fn saturated_vapor_at_8_to_9_mpa_is_representable_by_the_inverse() {
    for p in [8e6, 8.5e6, 9e6] {
        let sat = point(Branch::SaturatedVapor, p, 0.).unwrap();
        let (ts, u, v) = (
            sat.temperature_k,
            sat.internal_energy_j_kg,
            1. / sat.density_kg_m3,
        );
        let q = point_pu(Branch::Vapor, p, u).unwrap();
        assert_eq!(
            [q.temperature_k, q.density_kg_m3, q.internal_energy_j_kg].map(f64::to_bits),
            [ts, sat.density_kg_m3, u].map(f64::to_bits)
        );
        // Energies below the endpoint, across the former gap: Eq. (15) states
        // just below saturation along the endpoint's exact slope du/dT.
        let ut = sat.cp_j_kg_k - p * sat.expansion_per_k / sat.density_kg_m3;
        let mut below = Vec::new();
        for du in [1e-6, 1., 5., 10., 14., 20.] {
            let q = point_pu(Branch::Vapor, p, u - du).unwrap();
            let dt = q.saturation_departure_k;
            assert!(
                dt < 0. && (dt + du / ut).abs() <= 1e-3 * du / ut + 2e-9,
                "{p} {du}: {dt} versus {}",
                -du / ut
            );
            assert!(q.density_kg_m3 > sat.density_kg_m3);
            below.push(
                serde_json::json!({"du_J_kg": -du, "dT_K": dt, "v_m3_kg": 1. / q.density_kg_m3}),
            );
        }
        // (u, v) -> p: Newton in pressure on v(p, u) = v, from 1e-4 below the
        // saturated pressure, where u lies below that pressure's endpoint.
        let start = p * (1. - 1e-4);
        let first = point_pu(Branch::Vapor, start, u).unwrap();
        assert!(first.saturation_departure_k < 0.);
        let (mut x, mut steps) = (start, Vec::new());
        while steps.len() < 20 {
            let (q, d) = directional_pu(Branch::Vapor, x, u, 1., 0.).unwrap();
            let step =
                (1. / q.density_kg_m3 - v) * q.density_kg_m3 * q.density_kg_m3 / d.density_kg_m3;
            x += step;
            steps.push(step);
            if step.abs() <= 1e-9 * p {
                break;
            }
        }
        let end = point_pu(Branch::Vapor, x, u).unwrap();
        assert!(steps.len() < 20 && (x - p).abs() <= 1e-9 * p, "{p}: {x}");
        assert!((end.temperature_k - ts).abs() <= 1e-8);
        assert!((1. / end.density_kg_m3 / v - 1.).abs() <= 1e-10);
        println!(
            "{}",
            serde_json::json!({"kind":"saturated-vapor-inverse","p_Pa":p,"Tsat_K":ts,"u_J_kg":u,
                "v_m3_kg":v,"below_endpoint":below,"newton_start_Pa":start,
                "newton_start_dT_K":first.saturation_departure_k,"newton_steps_Pa":steps,
                "recovered_p_minus_psat_Pa":x - p,"recovered_T_minus_Tsat_K":end.temperature_k - ts,
                "recovered_v_relative":1. / end.density_kg_m3 / v - 1.})
        );
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
    // Above the band's pressure range a liquid is admitted only stable.
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
    for p in PRESSURES.into_iter().chain([2e6 + 1e3, 12.5e6]) {
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
    for p in [5.36e6, 8e6, 15.5e6] {
        let ts = saturation(p);
        let check = |branch: Branch, t: f64| band_check(branch, &point(branch, p, t).unwrap());
        for (branch, t, band) in [
            (Branch::Liquid, ts - 5., Band::Stable),
            (Branch::Liquid, ts + 0.3, Band::Admitted { credited: true }),
            (Branch::Liquid, ts + 1.5, Band::Admitted { credited: false }),
            (Branch::Liquid, ts + 2.5, Band::Exceeded),
            (Branch::Vapor, ts + 5., Band::Stable),
            (Branch::Vapor, ts - 0.3, Band::Admitted { credited: true }),
            (Branch::Vapor, ts - 1., Band::Admitted { credited: false }),
            (Branch::Vapor, ts - 2., Band::Exceeded),
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

fn admitted(band: &MetastableBand, liquid: bool, p: f64, t: f64, departure: f64) -> bool {
    let ceiling = if liquid {
        band.liquid_pressure_ceiling_pa
    } else {
        band.vapor_pressure_ceiling_pa
    };
    let in_range = p > band.pressure_low_pa && p <= band.pressure_high_pa;
    p <= ceiling
        && (departure < 0.
            || (in_range
                && departure <= band.trial_max_k
                && !(liquid && t > band.liquid_temperature_max_k)))
}

/// Team M's receipt evaluated the same region-1/region-2 basic equations
/// through the adapter's gibbs(). Admitted rows must match it; rows beyond the
/// band, the pressure range or a ceiling must be refused.
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
        // Rows within 1e-9 K of a band edge may fall either side of it.
        let edge = (departure.abs() - band.trial_max_k).abs() < 1e-9
            || (liquid && (t - band.liquid_temperature_max_k).abs() < 1e-9)
            || departure.abs() < 1e-9;
        let admitted = admitted(&band, liquid, p, t, departure);
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
    // 10 MPa now lies inside the band: its metastable rows are admitted too.
    assert!(matched >= 180);
}

/// Team M's low-pressure receipt, 2-10 MPa and 5.9 MPa: liquid on Eq. (7)
/// and vapor on Eq. (15) on both sides of saturation (its "eq15" variant;
/// Eq. (18) is not this boundary's). Admitted rows must match; metastable rows
/// at the excluded 2 MPa edge must be refused.
#[test]
#[ignore = "requires LD01_METASTABLE_LOW_RECEIPT (low-pressure metastable-band receipt)"]
fn admitted_states_match_the_low_pressure_receipt() {
    let path = std::env::var("LD01_METASTABLE_LOW_RECEIPT").unwrap();
    let receipt: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let band = MetastableBand::compiled();
    let (mut matched, mut metastable_vapor, mut refused, mut worst) =
        (0usize, 0usize, 0usize, 0f64);
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
        let admitted = admitted(&band, liquid, p, t, departure);
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
                let equation = if liquid { "eq7" } else { "eq15" };
                let values = &row["variants"][equation]["values"];
                worst = worst.max(compare(row, q, values, &keys));
                matched += 1;
                metastable_vapor += usize::from(!liquid && departure > 0.);
            }
            Err(e) => {
                assert!(!admitted || edge, "refused inside the band ({e:?}): {row}");
                refused += 1;
            }
        }
    }
    println!(
        "{}",
        serde_json::json!({"kind":"metastable-low-receipt-comparison","matched":matched,"metastable_vapor_eq15":metastable_vapor,"refused":refused,"max_relative":worst})
    );
    // Every row off the edges except the metastable ones at 2 MPa.
    assert!(matched >= 190 && metastable_vapor >= 45);
}
