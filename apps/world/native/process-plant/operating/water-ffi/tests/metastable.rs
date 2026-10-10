//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#bounded-metastable-admission
//! Bounded metastable admission on the explicitly requested branch: region-1
//! Eq. (7) above saturation and region-2 Eq. (15) below it, inside the band's
//! pressure range and trial departure only; the trial-band refusal outside;
//! the accepted-state band report; and the liquid and vapor pressure ceilings.
use leitbild_operating_water::{
    Band, Branch, CaloricLinearization, Error, MetastableBand, WaterPoint, band_check, point,
    point_ph, point_pu,
};
use serde_json::Value;

fn saturation(p: f64) -> f64 {
    point(Branch::SaturatedLiquid, p, 0.).unwrap().temperature_k
}

#[test]
fn compiled_band_is_the_receipt_band_from_the_wiki_block() {
    let directory = std::env::var("LD01_OPERATING_WATER_LIB_DIR").unwrap();
    let receipt: Value =
        serde_json::from_slice(&std::fs::read(format!("{directory}/water-build.json")).unwrap())
            .unwrap();
    let block = &receipt["metastableBand"];
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
    for p in [10e6 + 1., 12e6, 15.5e6, 16e6] {
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
    // The band's lower pressure edge is excluded; below it there is none.
    for p in [10e6, 6e6, 1e5] {
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
    for p in [10e6 + 1e3, 12.5e6, 15.5e6, 16e6] {
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
    let p = 15.5e6;
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
        assert_eq!(report.band, band, "{branch:?} {}", t - ts);
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
        let in_range = p > band.pressure_low_pa && p <= band.pressure_high_pa;
        let ceiling = if liquid {
            band.liquid_pressure_ceiling_pa
        } else {
            band.vapor_pressure_ceiling_pa
        };
        let outcome = point(branch, p, t);
        // Rows within 1e-9 K of a band edge may fall either side of it.
        let edge = (departure.abs() - band.trial_max_k).abs() < 1e-9
            || (liquid && (t - band.liquid_temperature_max_k).abs() < 1e-9)
            || departure.abs() < 1e-9;
        let admitted = p <= ceiling
            && (departure < 0.
                || (in_range
                    && departure <= band.trial_max_k
                    && !(liquid && t > band.liquid_temperature_max_k)));
        match outcome {
            Ok(q) => {
                assert!(admitted || edge, "admitted outside the band: {row}");
                let v = &row["if97"]["values"];
                for (key, actual) in [
                    ("rho", q.density_kg_m3),
                    ("u", q.internal_energy_j_kg),
                    ("h", q.enthalpy_j_kg),
                    ("cp", q.cp_j_kg_k),
                    ("cv", q.cv_j_kg_k),
                    ("alpha", q.expansion_per_k),
                    ("kappa", q.compressibility_per_pa),
                    ("mu", q.viscosity_pa_s),
                    ("k", q.conductivity_w_m_k),
                ] {
                    let expected = v[key].as_f64().unwrap();
                    let rel = (actual / expected - 1.).abs();
                    worst = worst.max(rel);
                    assert!(rel <= 1e-12, "{key} {rel:e}: {row}");
                }
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
