//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressurizer-thermal-state.md#stratified-pzr-cell
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressurizer-thermal-state.md#stratified-pzr-closures
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#bounded-metastable-admission
//! The stratified PZR cell against the maintained IF97 boundary. The cell
//! section mirrors the contract's `pzr.cell` with the committed strict
//! blocks `ld01-pzr-stratified` and `ld01-metastable-band`; the roof
//! pressure is the S1 packet's declared operating point.
use leitbild_operating_plant::{
    network::{
        Failure, Properties,
        stratified::{self as st, Case, Cell, Coordinates, Heat, Parameters, Receipt},
    },
    thermal::Scalar,
};
use leitbild_operating_water::If97;

const ROOF_PA: f64 = 14_864_186.805_5;
const LEVEL_M: f64 = 6.0;
const G: f64 = 9.80665;

fn section(fluid_volume: f64) -> String {
    format!(
        r#"{{"index":28,"bottom_m":6.5,"top_m":18.5,"fluidVolume_m3":{fluid_volume},
 "freeArea":[{{"from_m":6.5,"to_m":7.5,"area_m2":4.909522131576614}},{{"from_m":7.5,"to_m":9.5,"area_m2":4.9195752280681013}},{{"from_m":9.5,"to_m":18.5,"area_m2":5.0}}],
 "ports":[{{"id":"PZR.SURGE.MOUTH","kind":"surge","elevation_m":6.5,"face":34,"bore_m":0.3}}],
 "taps":[{{"id":"PT1","elevation_m":18.5}},{{"id":"LT.LOW","elevation_m":6.5}},{{"id":"LT.HIGH","elevation_m":18.5}}],
 "heaters":{{"bottom_m":6.5,"top_m":9.5,"displacement_m3":0.25132741228718347}},
 "stratified":{{"withdrawalScale_m":0.30,"admittedPreparationThickness_m":0.30,"inversionExchangeVelocity_m_s":320,"liquidRelaxationTime_s":0.3,"vaporRelaxationTime_s":0.5,"relaxationSensitivity":[0.5,1,2],"bubbleDiameter_m":0.00075,"sprayDropDiameter_m":0.003,"dropDiameterSensitivity_m":[0.0015,0.003,0.006],"resolvabilityFactor":1000}},
 "metastable":{{"pressureRange_Pa":[10000000,16000000],"lowerBoundExclusive":true,"liquidSuperheatMax_K":2.0,"vaporSubcoolingMax_K":1.4,"trialMax_K":3.0,"creditedMax_K":0.5,"liquidTemperatureMax_K":623.15,"liquidPressureCeiling_Pa":17000000,"vaporPressureCeiling_Pa":16000000}},
 "absorberMassFraction":0.001,"interfacialLength_m":0.003}}"#
    )
}
fn parameters() -> Parameters {
    serde_json::from_str(&section(59.7486726)).unwrap()
}
fn cell() -> Cell {
    let p = parameters();
    let case = Case::nominal(&p);
    Cell::new(p, case).unwrap()
}
fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}

/// Test coordinate scales; the network owns the solver's scales. Prepared
/// magnitudes, with the zero transit stocks at a typical in-transit size.
fn scales(v: &[f64; st::COORDINATES]) -> [f64; st::COORDINATES] {
    let mut scales = *v;
    scales[st::BUBBLE_VOLUME] = 0.5;
    scales[st::DROP_VOLUME] = 0.05;
    scales[st::BUBBLE_MASS] = 50.;
    scales[st::DROP_MASS] = 30.;
    scales[st::DROP_BORON] = 0.03;
    scales
}

/// The prepared cell, its scales and exactly reconstructing coordinates.
struct Prepared {
    cell: Cell,
    preparation: st::Preparation,
    scales: [f64; st::COORDINATES],
    y: [f64; st::COORDINATES],
}
fn prepared() -> Prepared {
    let cell = cell();
    let preparation = cell.prepare(&If97, ROOF_PA, LEVEL_M, 1e-6, 50).unwrap();
    let scales = scales(&preparation.values);
    let y = Cell::coordinates(&preparation.values, &scales, 64).unwrap();
    Prepared {
        cell,
        preparation,
        scales,
        y,
    }
}
/// Coordinates as the network reconstructs them: `y·scale`, seeded.
fn coordinates(y: &[f64], scales: &[f64], seed: Option<&[f64]>) -> Coordinates {
    let v: Vec<Scalar> = (0..st::COORDINATES)
        .map(|i| Scalar::new(y[i] * scales[i], seed.map_or(0., |d| d[i]) * scales[i]))
        .collect();
    Coordinates::from_slice(&v).unwrap()
}
fn rates(yp: &[f64], scales: &[f64], seed: Option<&[f64]>, cj: f64) -> Coordinates {
    let v: Vec<Scalar> = (0..st::COORDINATES)
        .map(|i| {
            Scalar::new(
                yp[i] * scales[i],
                seed.map_or(0., |d| d[i]) * cj * scales[i],
            )
        })
        .collect();
    Coordinates::from_slice(&v).unwrap()
}
fn physical(x: &Coordinates) -> [f64; st::COORDINATES] {
    x.to_array().map(|v| v.value)
}
fn evaluate(
    p: &Prepared,
    values: &[f64; st::COORDINATES],
    rate: &[f64; st::COORDINATES],
    receipt: Receipt,
    heat: Heat,
) -> Result<st::Evaluation, Failure> {
    let x = Coordinates::values(values);
    let r = Coordinates::values(rate);
    p.cell
        .residual(&If97, &x, &r, &[receipt], heat, &p.scales, None)
}
/// Specific internal energy and enthalpy of a branch at (p, T).
fn state(vapor: bool, p: f64, t: f64) -> (f64, f64) {
    let q = If97.forward(vapor, p, t).unwrap();
    (q.internal_energy_j_kg, q.enthalpy_j_kg)
}
fn tsat(p: f64) -> f64 {
    If97.saturation(s(p)).unwrap().temperature.value
}

#[test]
fn free_area_volume_and_level_round_trip_and_volume_is_admitted_against_its_integral() {
    let c = cell();
    let p = c.parameters();
    let mut integral = 0.;
    for band in &p.free_area {
        let (v0, v1) = (
            c.volume_below(s(band.from_m)).value,
            c.volume_below(s(band.to_m)).value,
        );
        assert!((v1 - v0 - band.area_m2 * (band.to_m - band.from_m)).abs() <= 1e-13);
        integral += band.area_m2 * (band.to_m - band.from_m);
        for k in 0..=20 {
            let z = band.from_m + (band.to_m - band.from_m) * f64::from(k) / 20.;
            let v = c.volume_below(Scalar::new(z, 1.));
            let back = c.level(v);
            assert!((back.value - z).abs() <= 4. * f64::EPSILON * z, "z={z}");
            assert!((back.direction - 1.).abs() <= 1e-14);
            if z < band.to_m {
                assert_eq!(v.direction, band.area_m2);
                assert_eq!(
                    c.level(Scalar::new(v.value, 1.)).direction,
                    1. / band.area_m2
                );
            }
        }
    }
    assert_eq!(c.volume_below(s(6.5)).value, 0.);
    let total = c.volume_below(s(18.5)).value;
    assert!((total - integral).abs() <= 1e-13 && (total - 59.7486726).abs() <= 1e-9 * 59.7486726);
    for v in [0., 0.5, 4.909522131576614, 7., 14.74867, 30., 59.7486] {
        let back = c.volume_below(c.level(s(v))).value;
        assert!((back - v).abs() <= 1e-14 * v.max(1.), "V={v}");
    }
    // Strictly increasing and continuous across the band boundaries.
    for z in [7.5_f64, 9.5] {
        let below = c.volume_below(s(z.next_down())).value;
        let above = c.volume_below(s(z)).value;
        assert!(above > below && above - below < 1e-12);
    }
    // A fluid volume that is not the free-area integral is refused.
    let bad: Parameters = serde_json::from_str(&section(59.7487)).unwrap();
    assert!(bad.validate().is_err());
    let close: Parameters =
        serde_json::from_str(&section(59.74867258771282 * (1. + 9e-10))).unwrap();
    assert!(close.validate().is_ok());
    let mut missing = parameters();
    missing.taps.retain(|t| t.id != "LT.HIGH");
    assert!(missing.validate().is_err());
}

#[test]
fn prepared_saturated_column_is_an_exact_rest_state() {
    let p = prepared();
    let x = coordinates(&p.y, &p.scales, None);
    let v = physical(&x);
    let ev = evaluate(
        &p,
        &v,
        &[0.; st::COORDINATES],
        Receipt::zero(),
        Heat::zero(),
    )
    .unwrap();
    let c = &ev.column;
    assert_eq!(
        c.calls,
        st::Calls {
            inversions: 3,
            saturations: 2
        }
    );
    // Geometry of the declaration: interface at 12.5 m, A/R at 6.80 m.
    assert!((c.mixture_elevation.value - 12.5).abs() < 1e-12);
    assert!((c.boundary_elevation.value - 6.8).abs() < 1e-12);
    // Every zone at Tsat(p_s): U/M is reproduced exactly and the caloric
    // inverse recovers T within its convergence bound, 2e-12·max(|u|, u_T T)
    // in u, a few nK here.
    let t = p.preparation.saturation_temperature_k;
    for z in [c.vapor, c.admitted, c.resident] {
        let bound = 2e-12 * z.specific_energy.value.abs().max(z.cp.value * t) / (0.5 * z.cp.value);
        assert!(
            (z.temperature.value - t).abs() <= bound,
            "{} vs {t}",
            z.temperature.value
        );
    }
    assert!((c.interface_saturation.temperature.value - t).abs() < 1e-11);
    for (i, row) in ev.rows.iter().enumerate() {
        assert!(row.value.abs() < 1e-12, "row {i} = {}", row.value);
    }
    let f = &ev.flows;
    for v in [
        f.admitted_flashing,
        f.resident_flashing,
        f.vapor_condensation,
        f.bubble_rise,
        f.drop_fall,
        f.inversion,
    ] {
        assert_eq!(v.value, 0.);
    }
    assert!(f.interface.liquid.mass.value.abs() < 1e-12);
    assert!(f.conduction.value.abs() < 1e-9);
    // A is stably denser than R in potential density, not only in situ.
    assert!(f.potential_density[0].value > f.potential_density[1].value);
    // Hydrostatic consistency of the column and taps.
    let taps = p.cell.taps(&If97, c).unwrap();
    assert_eq!(taps.pt1_pa.value, x.roof_pressure.value);
    assert_eq!(taps.level_low_pa.value, c.bottom_pressure.value);
    let weight = G
        * (x.admitted_mass.value * (c.boundary_elevation.value - 6.5) / x.admitted_volume.value
            + x.resident_mass.value * (12.5 - c.boundary_elevation.value)
                / x.resident_volume.value
            + x.vapor_mass.value * 6. / x.vapor_volume.value);
    assert!((taps.level_difference_pa.value - weight).abs() < 1e-8 * weight);
    assert!((taps.collapsed_level_m.value - 6.).abs() < 1e-12);
    // The surge port sees p_bottom and the φ = 1/2 A/R liquid mixture.
    let port = p.cell.port_view(c, 0).unwrap();
    assert_eq!(port.pressure.value, c.bottom_pressure.value);
    assert!((c.withdrawal_fraction.value - 0.5).abs() < 1e-12);
    let liquid = port.phase[0].unwrap();
    assert!(port.phase[1].is_none() && liquid.fraction.value == 1.);
    let h = 0.5 * (c.admitted.enthalpy.value + c.resident.enthalpy.value);
    assert!((liquid.enthalpy.value - h).abs() < 1e-9 * h);
    assert!((liquid.boron_concentration.value - 0.001).abs() < 1e-15);
    println!(
        "prepared: p_s={} Pa, Tsat={t} K, M_A={} kg, M_R={} kg, M_g={} kg, passes {:?}, max |row| {:e}",
        c.interface_pressure.value,
        x.admitted_mass.value,
        x.resident_mass.value,
        x.vapor_mass.value,
        p.preparation.pass_changes_pa,
        ev.rows.iter().map(|r| r.value.abs()).fold(0., f64::max)
    );
}

/// An active off-manifold state: superheated R, an A inversion, slightly
/// subcooled vapor, transit stocks and perturbed volumes.
fn active(p: &Prepared) -> [f64; st::COORDINATES] {
    let mut v = physical(&coordinates(&p.y, &p.scales, None));
    let c = &p.preparation.column;
    let t = p.preparation.saturation_temperature_k;
    let pr = c.resident.pressure.value;
    let pa = c.admitted.pressure.value;
    let pg = c.vapor.pressure.value;
    v[st::RESIDENT_ENERGY] = v[st::RESIDENT_MASS] * state(false, pr, t + 0.25).0;
    v[st::ADMITTED_ENERGY] = v[st::ADMITTED_MASS] * state(false, pa, t + 0.4).0;
    v[st::VAPOR_ENERGY] = v[st::VAPOR_MASS] * state(true, pg, t - 0.3).0;
    v[st::BUBBLE_MASS] = 40.;
    v[st::BUBBLE_VOLUME] = 0.41;
    v[st::DROP_MASS] = 15.;
    v[st::DROP_VOLUME] = 0.026;
    v[st::DROP_BORON] = 0.012;
    v[st::VAPOR_VOLUME] -= 0.35;
    v[st::RESIDENT_VOLUME] -= 0.07;
    v[st::ADMITTED_VOLUME] += 0.01;
    v[st::ROOF_PRESSURE] -= 2.0e4;
    v
}
fn active_rates() -> [f64; st::COORDINATES] {
    let mut r = [0.; st::COORDINATES];
    r[st::ROOF_PRESSURE] = -1.7e4;
    r[st::VAPOR_VOLUME] = 0.06;
    r[st::ADMITTED_VOLUME] = -0.011;
    r[st::RESIDENT_VOLUME] = -0.04;
    r[st::BUBBLE_VOLUME] = -0.008;
    r[st::DROP_VOLUME] = 0.0004;
    r[st::VAPOR_MASS] = 2.5;
    r[st::VAPOR_ENERGY] = 6.0e6;
    r[st::ADMITTED_MASS] = -7.;
    r[st::ADMITTED_ENERGY] = -1.1e7;
    r[st::ADMITTED_BORON] = -0.007;
    r[st::RESIDENT_MASS] = -9.;
    r[st::RESIDENT_ENERGY] = -1.3e7;
    r[st::RESIDENT_BORON] = -0.009;
    r[st::BUBBLE_MASS] = 1.5;
    r[st::DROP_MASS] = 0.4;
    r[st::DROP_BORON] = 0.0003;
    r
}

#[test]
fn arbitrary_receipts_are_conserved_exactly_by_the_assembled_rows() {
    let p = prepared();
    let v = active(&p);
    let rate = active_rates();
    let heat = Heat {
        vapor: s(1.3e4),
        admitted: s(2.4e5),
        resident: s(7.7e4),
    };
    for receipt in [
        Receipt {
            mass: s(-31.7),
            enthalpy: s(-31.7 * 1.6e6 - 2.9e5),
            boron: s(-0.041),
        },
        Receipt {
            mass: s(18.3),
            enthalpy: s(18.3 * 1.21e6),
            boron: s(0.023),
        },
    ] {
        let ev = evaluate(&p, &v, &rate, receipt, heat).unwrap();
        let f = &ev.flows;
        // Every internal process is active in this state.
        for (name, q) in [
            ("R flashing", f.resident_flashing),
            ("A flashing", f.admitted_flashing),
            ("vapor condensation", f.vapor_condensation),
            ("rise", f.bubble_rise),
            ("fall", f.drop_fall),
            ("inversion", f.inversion),
            ("drift", f.transit_drift[0]),
        ] {
            assert!(q.value.abs() > 0., "{name} inactive");
        }
        // Rates that zero every stock row, with the same volume rates.
        let implied: Vec<f64> = (0..st::COORDINATES)
            .map(|i| rate[i] - ev.rows[i].value * p.scales[i])
            .collect();
        let sat = &ev.column.interface_saturation;
        let mass = implied[st::VAPOR_MASS]
            + implied[st::ADMITTED_MASS]
            + implied[st::RESIDENT_MASS]
            + implied[st::BUBBLE_MASS]
            + implied[st::DROP_MASS];
        let boron =
            implied[st::ADMITTED_BORON] + implied[st::RESIDENT_BORON] + implied[st::DROP_BORON];
        let work: f64 = f.work.iter().map(|w| w.value).sum();
        let energy = implied[st::VAPOR_ENERGY]
            + implied[st::ADMITTED_ENERGY]
            + implied[st::RESIDENT_ENERGY]
            + work
            + implied[st::BUBBLE_MASS] * sat.vapor.enthalpy.value
            + implied[st::DROP_MASS] * sat.liquid.enthalpy.value
            + f.transit_drift[0].value
            + f.transit_drift[1].value;
        let expected_energy = receipt.enthalpy.value + 1.3e4 + 2.4e5 + 7.7e4;
        let scale = |x: f64| 1e-12 * x.abs().max(1.);
        assert!(
            (mass - receipt.mass.value).abs() <= scale(1e3),
            "mass {mass}"
        );
        assert!(
            (boron - receipt.boron.value).abs() <= scale(1.),
            "boron {boron}"
        );
        assert!(
            (energy - expected_energy).abs() <= scale(1e10),
            "energy {energy} vs {expected_energy}"
        );
        let b = &ev.balance;
        assert!((b.mass_kg_s.value - b.receipt_mass_kg_s.value).abs() <= scale(1e3));
        assert!((b.energy_w.value - b.receipt_energy_w.value).abs() <= scale(1e10));
        assert!((b.boron_kg_s.value - b.receipt_boron_kg_s.value).abs() <= scale(1.));
        // The outsurge splits by φ; the insurge enters A only.
        let a_mass = ev.flows.sources[st::ADMITTED_MASS].value + f.admitted_flashing.value;
        let w = receipt.mass.value;
        let expected_a = if w > 0. {
            w
        } else {
            ev.column.withdrawal_fraction.value * w
        };
        assert!((a_mass - expected_a).abs() <= 1e-12 * w.abs());
    }
}

#[test]
fn admitted_layer_follows_the_analytic_lower_bound_under_a_long_outsurge() {
    let p = prepared();
    let base = physical(&coordinates(&p.y, &p.scales, None));
    let c0 = &p.preparation.column;
    let rho = c0.admitted.density.value;
    let u = base[st::ADMITTED_ENERGY] / base[st::ADMITTED_MASS];
    let area = p.cell.free_area(6.5);
    let h_w = p.cell.parameters().stratified.withdrawal_scale_m;
    let w = 40.;
    // M_A' from the assembled A-mass source of an outsurge receipt at
    // fixed density (the layer law only; no other A process acts here).
    let rate = |m: f64| {
        let mut v = base;
        v[st::ADMITTED_MASS] = m;
        v[st::ADMITTED_ENERGY] = m * u;
        v[st::ADMITTED_BORON] = m * 0.001;
        v[st::ADMITTED_VOLUME] = m / rho;
        let receipt = Receipt {
            mass: s(-w),
            enthalpy: s(-w * 1.6e6),
            boron: s(-w * 0.001),
        };
        let ev = evaluate(&p, &v, &[0.; st::COORDINATES], receipt, Heat::zero()).unwrap();
        let f = &ev.flows;
        assert_eq!(f.admitted_flashing.value, 0.);
        ev.flows.sources[st::ADMITTED_MASS].value
    };
    let m0 = base[st::ADMITTED_MASS];
    let k = w / (rho * area * h_w).powi(2);
    let bound = |t: f64| m0 / (1. + k * m0 * t);
    let (mut m, mut t, dt) = (m0, 0., 1.);
    let mut ratio = 0.;
    while t < 1800. {
        let k1 = rate(m);
        let k2 = rate(m + 0.5 * dt * k1);
        let k3 = rate(m + 0.5 * dt * k2);
        let k4 = rate(m + dt * k3);
        m += dt / 6. * (k1 + 2. * k2 + 2. * k3 + k4);
        t += dt;
        assert!(m > 0., "A emptied at {t} s");
        assert!(
            m >= bound(t),
            "M_A {m} below the bound {} at {t} s",
            bound(t)
        );
        ratio = m / bound(t);
    }
    // 72 t withdrawn; A keeps a positive layer approaching the bound.
    assert!(ratio < 1.05, "M_A/bound = {ratio} at {t} s");
    println!(
        "after {t} s of {w} kg/s: M_A = {m} kg, bound {} kg",
        bound(t)
    );
}

#[test]
fn relaxation_flashes_superheated_liquid_and_condenses_subcooled_vapor() {
    let p = prepared();
    let base = physical(&coordinates(&p.y, &p.scales, None));
    let c = &p.preparation.column;
    let t = p.preparation.saturation_temperature_k;
    let sat = &c.interface_saturation;
    let (hf, hg) = (sat.liquid.enthalpy.value, sat.vapor.enthalpy.value);
    let case = p.cell.case();
    let theta_l = p.cell.parameters().stratified.liquid_relaxation_time_s * case.relaxation_factor;
    let theta_g = p.cell.parameters().stratified.vapor_relaxation_time_s * case.relaxation_factor;
    let pr = c.resident.pressure.value;
    let pg = c.vapor.pressure.value;
    let zero = [0.; st::COORDINATES];
    // Superheated R: +0.3 K above Tsat(p_s), metastable at its own centroid.
    let (u, h) = state(false, pr, t + 0.3);
    assert!(
        t + 0.3 > tsat(pr),
        "R state must be superheated at its centroid"
    );
    let mut v = base;
    v[st::RESIDENT_ENERGY] = v[st::RESIDENT_MASS] * u;
    let ev = evaluate(&p, &v, &zero, Receipt::zero(), Heat::zero()).unwrap();
    let f = &ev.flows;
    let expected = v[st::RESIDENT_MASS] * (h - hf) / ((hg - hf) * theta_l);
    assert!(f.resident_flashing.value > 0.);
    assert!((f.resident_flashing.value - expected).abs() <= 1e-9 * expected);
    assert_eq!(f.vapor_condensation.value, 0.);
    assert_eq!(f.admitted_flashing.value, 0.);
    // R pays h_g,sat per kg into the bubble stock.
    assert!(ev.flows.sources[st::BUBBLE_MASS].value == f.resident_flashing.value);
    // Its departure is reported positive (metastable), inside the band.
    let taps = p.cell.taps(&If97, &ev.column).unwrap();
    let d = taps.departures[2];
    assert!(d.departure_k > 0. && d.metastable_k == d.departure_k);
    assert!(d.within_band && d.credited);
    println!(
        "R +0.3 K: flashing {} kg/s, departure {} K",
        f.resident_flashing.value, d.departure_k
    );

    // Subcooled vapor: 0.4 K below Tsat(p_s), metastable at its centroid.
    let (u, h) = state(true, pg, t - 0.4);
    assert!(
        t - 0.4 < tsat(pg),
        "vapor state must be subcooled at its centroid"
    );
    let mut v = base;
    v[st::VAPOR_ENERGY] = v[st::VAPOR_MASS] * u;
    let ev = evaluate(&p, &v, &zero, Receipt::zero(), Heat::zero()).unwrap();
    let f = &ev.flows;
    let expected = v[st::VAPOR_MASS] * (hg - h) / ((hg - hf) * theta_g);
    assert!(f.vapor_condensation.value > 0.);
    assert!((f.vapor_condensation.value - expected).abs() <= 1e-9 * expected);
    assert_eq!(f.resident_flashing.value, 0.);
    assert!(ev.flows.sources[st::DROP_MASS].value == f.vapor_condensation.value);
    // The condensing vapor pays h_f,sat per kg; its energy source is that.
    let interface = f.interface.vapor.enthalpy.value;
    let energy = ev.flows.sources[st::VAPOR_ENERGY].value;
    assert!(
        (energy - (interface - f.vapor_condensation.value * hf)).abs()
            <= 1e-9 * energy.abs().max(1.)
    );
    let taps = p.cell.taps(&If97, &ev.column).unwrap();
    let d = taps.departures[0];
    assert!(d.departure_k < 0. && d.metastable_k == -d.departure_k && d.metastable_k > 0.);
    assert!(d.within_band && d.credited);
    println!(
        "vapor -0.4 K: condensation {} kg/s, departure {} K",
        f.vapor_condensation.value, d.departure_k
    );
}

#[test]
fn metastable_departures_are_signed_and_banded_never_clamped() {
    let p = prepared();
    let base = physical(&coordinates(&p.y, &p.scales, None));
    let c = &p.preparation.column;
    let zero = [0.; st::COORDINATES];
    // Prepared: liquid stably subcooled and vapor stably superheated by
    // their hydrostatic offsets.
    let taps = p.cell.taps(&If97, c).unwrap();
    assert_eq!(taps.saturation_calls, 3);
    let [g, a, r] = taps.departures;
    assert!(g.departure_k > 0. && g.metastable_k < 0.);
    assert!(a.departure_k < 0. && a.metastable_k < 0.);
    assert!(r.departure_k < 0. && r.metastable_k < 0.);
    assert!(a.departure_k < r.departure_k, "A sits deeper than R");
    for d in [g, a, r] {
        assert!(d.within_band && d.credited);
    }
    // Liquid departures across the credited, accepted and trial limits.
    let pr = c.resident.pressure.value;
    let ts = tsat(pr);
    for (excess, credited, within) in [(0.4, true, true), (0.8, false, true), (2.5, false, false)] {
        let mut v = base;
        v[st::RESIDENT_ENERGY] = v[st::RESIDENT_MASS] * state(false, pr, ts + excess).0;
        let ev = evaluate(&p, &v, &zero, Receipt::zero(), Heat::zero()).unwrap();
        let d = p.cell.taps(&If97, &ev.column).unwrap().departures[2];
        assert!(
            (d.departure_k - excess).abs() < 1e-6,
            "{} vs {excess}",
            d.departure_k
        );
        assert_eq!(
            (d.credited, d.within_band),
            (credited, within),
            "{excess} K"
        );
        assert!(ev.column.resident.temperature.value > ts, "never clamped");
    }
    // Vapor subcooling beyond the accepted 1.4 K band but inside the trial.
    let pg = c.vapor.pressure.value;
    let mut v = base;
    v[st::VAPOR_ENERGY] = v[st::VAPOR_MASS] * state(true, pg, tsat(pg) - 2.0).0;
    let ev = evaluate(&p, &v, &zero, Receipt::zero(), Heat::zero()).unwrap();
    let d = p.cell.taps(&If97, &ev.column).unwrap().departures[0];
    assert!((d.metastable_k - 2.0).abs() < 1e-6 && !d.within_band && !d.credited);
}

#[test]
fn seeded_directions_match_central_differences_on_an_active_state() {
    let p = prepared();
    let v = active(&p);
    let rate = active_rates();
    let y: Vec<f64> = (0..st::COORDINATES).map(|i| v[i] / p.scales[i]).collect();
    let yp: Vec<f64> = (0..st::COORDINATES)
        .map(|i| rate[i] / p.scales[i])
        .collect();
    let receipt = Receipt {
        mass: s(-23.),
        enthalpy: s(-23. * 1.6e6),
        boron: s(-0.023),
    };
    let heat = Heat {
        vapor: s(0.),
        admitted: s(1.5e5),
        resident: s(4.0e4),
    };
    let cj = 37.;
    let run = |y: &[f64], yp: &[f64], seed: Option<&[f64]>| {
        let x = coordinates(y, &p.scales, seed);
        let r = rates(yp, &p.scales, seed, cj);
        p.cell
            .residual(&If97, &x, &r, &[receipt], heat, &p.scales, None)
            .unwrap()
            .rows
    };
    let mut worst: f64 = 0.;
    for (n, seed) in [
        [
            0.3, -0.7, 0.2, 0.5, -0.4, 0.9, 0.1, -0.2, 0.6, 0.3, -0.5, 0.8, -0.1, 0.4, 0.7, -0.3,
            0.2,
        ],
        [
            0., 0., 0., 0., 0., 0., 0., 1., 0., 0., 0., 0., 0., 0., 0., 0., 0.,
        ],
        [
            1., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0.,
        ],
        [
            0., 0., 1., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0.,
        ],
        [
            0., 0., 0., 0., 1., 0., 0., 0., 0., 0., 0., 0., 0., 0., 1., 0., 0.,
        ],
    ]
    .iter()
    .enumerate()
    {
        let d = seed.map(|v| v * 1e-3);
        let seeded = run(&y, &yp, Some(&d));
        let difference = |h: f64| {
            let shift = |sign: f64| {
                let ys: Vec<f64> = (0..st::COORDINATES)
                    .map(|i| y[i] + sign * h * d[i])
                    .collect();
                let yps: Vec<f64> = (0..st::COORDINATES)
                    .map(|i| yp[i] + sign * h * cj * d[i])
                    .collect();
                run(&ys, &yps, None)
            };
            let (plus, minus) = (shift(1.), shift(-1.));
            (0..st::COORDINATES)
                .map(|i| (plus[i].value - minus[i].value) / (2. * h))
                .collect::<Vec<f64>>()
        };
        // Two central differences, 1e-4 and 5e-5 scaled steps. Their spread
        // measures the difference's own uncertainty, which the caloric
        // inverse's convergence noise dominates for small entries.
        let (coarse, fine) = (difference(0.1), difference(0.05));
        for i in 0..st::COORDINATES {
            let an = seeded[i].direction;
            let fd = fine[i];
            let uncertainty = (coarse[i] - fine[i]).abs();
            let size = an.abs().max(fd.abs()).max(1e-12);
            // 1e-12 absolute is 1e-9 of the 1e-3 seed: the scale at which
            // the inverse's converged state is only accurate to its bound.
            let allowed = 3. * uncertainty + 2e-6 * size + 1e-12;
            let error = (an - fd).abs();
            if size > 1e-9 {
                worst = worst.max(error / size);
            }
            assert!(
                error <= allowed,
                "seed {n} row {i}: analytic {an:e}, difference {fd:e}, spread {uncertainty:e}"
            );
        }
    }
    println!("worst relative direction error of entries above 1e-9: {worst:e}");
}

#[test]
fn residual_on_a_shared_column_is_bitwise_the_residual() {
    let p = prepared();
    let v = active(&p);
    let rate = active_rates();
    let seed: Vec<f64> = (0..st::COORDINATES)
        .map(|i| 1e-3 * ((i as f64) * 0.37).sin())
        .collect();
    let y: Vec<f64> = (0..st::COORDINATES).map(|i| v[i] / p.scales[i]).collect();
    let yp: Vec<f64> = (0..st::COORDINATES)
        .map(|i| rate[i] / p.scales[i])
        .collect();
    let x = coordinates(&y, &p.scales, Some(&seed));
    let r = rates(&yp, &p.scales, Some(&seed), 11.);
    let receipt = [Receipt {
        mass: Scalar::new(-12., 0.3),
        enthalpy: Scalar::new(-12. * 1.6e6, 4e5),
        boron: Scalar::new(-0.012, 3e-4),
    }];
    let heat = Heat {
        vapor: s(0.),
        admitted: s(1e5),
        resident: s(2e4),
    };
    let whole = p
        .cell
        .residual(&If97, &x, &r, &receipt, heat, &p.scales, None)
        .unwrap();
    let column = p.cell.column(&If97, &x, None).unwrap();
    let shared = p
        .cell
        .residual_on(column, &x, &r, &receipt, heat, &p.scales)
        .unwrap();
    for i in 0..st::COORDINATES {
        assert_eq!(
            whole.rows[i].value.to_bits(),
            shared.rows[i].value.to_bits(),
            "row {i}"
        );
        assert_eq!(
            whole.rows[i].direction.to_bits(),
            shared.rows[i].direction.to_bits(),
            "row {i}"
        );
    }
}
