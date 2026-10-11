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
        stratified::{self as st, Boundary, Case, Cell, Coordinates, Heat, Parameters, Receipt},
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
 "stratified":{{"withdrawalScale_m":0.30,"admittedPreparationThickness_m":0.30,"inversionExchangeVelocity_m_s":320,"liquidRelaxationTime_s":0.3,"vaporRelaxationTime_s":0.5,"relaxationSensitivity":[0.5,1,2],"bubbleDiameter_m":0.00075,"bubbleExchangeSensitivity":[0.5,1,2],"bubbleExchangeDiameterSensitivity_m":0.0005,"sprayDropDiameter_m":0.003,"dropDiameterSensitivity_m":[0.0015,0.003,0.006],"resolvabilityFactor":1000}},
 "metastable":{{"pressureRange_Pa":[2000000,16000000],"lowerBoundExclusive":true,"liquidSuperheatMax_K":2.0,"vaporSubcoolingMax_K":1.4,"trialMax_K":3.0,"creditedMax_K":0.5,"liquidTemperatureMax_K":623.15,"liquidPressureCeiling_Pa":17000000,"vaporPressureCeiling_Pa":16000000}},
 "absorberMassFraction":0.001,"interfacialLength_m":0.003}}"#
    )
}
fn parameters() -> Parameters {
    serde_json::from_str(&section(59.7486726)).unwrap()
}
/// The same cell with the spray inlet and the relief outlet at the roof.
fn all_ports() -> Parameters {
    let mut p = parameters();
    let upper: Vec<st::Port> = serde_json::from_str(
        r#"[{"id":"PZR.SPRAY","kind":"spray","elevation_m":18.5,"face":null,"bore_m":0.012},
            {"id":"PZR.RELIEF","kind":"relief","elevation_m":18.5,"bore_m":0.15,
             "relief":{"opening_Pa":15800000,"reseat_Pa":15600000,"fullStrokes_per_s":20,"effectiveAreaPerLift_m2":0.00411672057382}}]"#,
    )
    .unwrap();
    p.ports.extend(upper);
    p
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
    scales[st::ADMITTED_BUBBLE_VOLUME] = 0.5;
    scales[st::ADMITTED_BUBBLE_MASS] = 50.;
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
        .residual(&If97, &x, &r, &[receipt], &boundary(heat), &p.scales, None)
}
fn boundary(heat: Heat) -> Boundary {
    Boundary {
        heat,
        ..Boundary::closed()
    }
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
    let level = taps.level.expect("the LD-01 cell declares the LT pair");
    assert_eq!(level.low_pa.value, c.bottom_pressure.value);
    let weight = G
        * (x.admitted_mass.value * (c.boundary_elevation.value - 6.5) / x.admitted_volume.value
            + x.resident_mass.value * (12.5 - c.boundary_elevation.value)
                / x.resident_volume.value
            + x.vapor_mass.value * 6. / x.vapor_volume.value);
    assert!((level.difference_pa.value - weight).abs() < 1e-8 * weight);
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
            + implied[st::ADMITTED_BUBBLE_MASS]
            + implied[st::DROP_MASS];
        let boron =
            implied[st::ADMITTED_BORON] + implied[st::RESIDENT_BORON] + implied[st::DROP_BORON];
        let work: f64 = f.work.iter().map(|w| w.value).sum();
        let energy = implied[st::VAPOR_ENERGY]
            + implied[st::ADMITTED_ENERGY]
            + implied[st::RESIDENT_ENERGY]
            + work
            + (implied[st::BUBBLE_MASS] + implied[st::ADMITTED_BUBBLE_MASS])
                * sat.vapor.enthalpy.value
            + implied[st::DROP_MASS] * sat.liquid.enthalpy.value
            + f.transit_drift[0].value
            + f.transit_drift[1].value
            + f.admitted_transit_drift.value;
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
            .residual(&If97, &x, &r, &[receipt], &boundary(heat), &p.scales, None)
            .unwrap()
            .rows
    };
    let mut worst: f64 = 0.;
    for (n, seed) in [
        [
            0.3, -0.7, 0.2, 0.5, -0.4, 0.9, 0., 0.1, -0.2, 0.6, 0.3, -0.5, 0.8, -0.1, 0.4, 0.7,
            -0.3, 0.2, 0.,
        ],
        [
            0., 0., 0., 0., 0., 0., 0., 0., 1., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0.,
        ],
        [
            1., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0.,
        ],
        [
            0., 0., 1., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0.,
        ],
        [
            0., 0., 0., 0., 1., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 1., 0., 0., 0.,
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
        .residual(&If97, &x, &r, &receipt, &boundary(heat), &p.scales, None)
        .unwrap();
    let column = p.cell.column(&If97, &x, None).unwrap();
    let shared = p
        .cell
        .residual_on(&If97, column, &x, &r, &receipt, &boundary(heat), &p.scales)
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

#[test]
fn relief_full_lift_on_saturated_steam_reproduces_its_100_kg_s_calibration() {
    let p0 = 15.8e6;
    let sat = If97.saturation(s(p0)).unwrap();
    let flux = st::restriction_flux(&If97, true, s(p0), sat.vapor.enthalpy, s(101_325.)).unwrap();
    let rate = flux.mass_flux.value * 0.004_116_720_573_82;
    println!(
        "steam: G {} kg/(m2 s), throat {} Pa, choked {}, {} saturation calls, rate {rate} kg/s",
        flux.mass_flux.value, flux.throat_pressure_pa.value, flux.choked, flux.saturation_calls
    );
    let liquid =
        st::restriction_flux(&If97, false, s(p0), sat.liquid.enthalpy, s(101_325.)).unwrap();
    println!(
        "liquid: G {} kg/(m2 s), throat {} Pa, rate {} kg/s",
        liquid.mass_flux.value,
        liquid.throat_pressure_pa.value,
        liquid.mass_flux.value * 0.004_116_720_573_82
    );
    assert!(flux.choked && liquid.choked);
    // The area was calibrated once with IAPWS-95 (CoolProp); the native
    // IF97 path gives 99.986 kg/s. Halving the path step four times moves
    // it by 1e-6 relative, so the 1.4e-4 gap is the property formulation.
    assert!((rate - 100.).abs() < 0.02, "{rate}");
    assert!((liquid.mass_flux.value * 0.004_116_720_573_82 - 180.024_21).abs() < 0.1);
}

/// The cell's boundary with the relief closed and nothing else entering.
fn shut() -> Boundary {
    Boundary {
        relief: Some(st::ReliefState {
            lift: s(0.),
            back_pressure_pa: s(101_325.),
        }),
        ..Boundary::closed()
    }
}

/// The prepared state of the cell with every port kind.
fn prepared_all() -> Prepared {
    let base = prepared();
    let p = all_ports();
    let case = Case::nominal(&p);
    Prepared {
        cell: Cell::new(p, case).unwrap(),
        ..base
    }
}
/// One bank's receipt with its wet sources already per zone [A, R].
fn bank(
    bottom_m: f64,
    top_m: f64,
    q: [f64; 2],
    gamma: [f64; 2],
    exposed: f64,
    j: f64,
    hl: f64,
) -> st::HeaterReceipt {
    st::HeaterReceipt {
        bottom_m,
        top_m,
        wet_heat_w: q.map(s),
        wet_vapor_kg_s: gamma.map(s),
        exposed_heat_w: s(exposed),
        condensate_kg_s: s(j),
        condensate_enthalpy_j_kg: s(hl),
    }
}
fn evaluate_all(
    p: &Prepared,
    values: &[f64; st::COORDINATES],
    rate: &[f64; st::COORDINATES],
    receipts: [Receipt; 3],
    boundary: &Boundary,
) -> st::Evaluation {
    let x = Coordinates::values(values);
    let r = Coordinates::values(rate);
    p.cell
        .residual(&If97, &x, &r, &receipts, boundary, &p.scales, None)
        .unwrap()
}

#[test]
fn spray_is_heated_to_saturation_at_entry_by_condensing_vapor() {
    let p = prepared_all();
    let v = physical(&coordinates(&p.y, &p.scales, None));
    let zero = [0.; st::COORDINATES];
    let c = &p.preparation.column;
    let (hf, hg) = (
        c.interface_saturation.liquid.enthalpy.value,
        c.interface_saturation.vapor.enthalpy.value,
    );
    let hv = c.vapor.enthalpy.value;
    let w = 3.2;
    for (h_s, cold) in [(state(false, ROOF_PA, 565.).1, true), (hf + 4.0e4, false)] {
        let spray = Receipt {
            mass: s(w),
            enthalpy: s(w * h_s),
            boron: s(w * 0.0012),
        };
        let ev = evaluate_all(
            &p,
            &v,
            &zero,
            [Receipt::zero(), spray, Receipt::zero()],
            &shut(),
        );
        let f = &ev.flows;
        let vapor_h = if cold { hv } else { hg };
        let expected = w * (hf - h_s) / (vapor_h - hf);
        assert!((f.spray_condensation.value - expected).abs() <= 1e-12 * expected.abs());
        assert_eq!(expected > 0., cold);
        let src = &f.sources;
        assert!((src[st::DROP_MASS].value - (w + expected)).abs() <= 1e-12 * w);
        assert!((src[st::DROP_BORON].value - w * 0.0012).abs() <= 1e-18);
        // The vapor zone pays the condensate at its enthalpy, or receives the
        // flash at h_g,sat; the interface exchange is at rest here.
        let rest = f.interface.vapor.mass.value;
        assert!((src[st::VAPOR_MASS].value - (rest - expected)).abs() <= 1e-12 * w);
        let energy = src[st::VAPOR_ENERGY].value - f.interface.vapor.enthalpy.value;
        assert!((energy + expected * vapor_h).abs() <= 1e-9 * (expected * vapor_h).abs());
        // Entry balance: W_s h_s + W_c h_v = (W_s + W_c) h_f,sat.
        let entry = w * h_s + expected * vapor_h - (w + expected) * hf;
        assert!(entry.abs() <= 1e-9 * w * hf, "entry imbalance {entry}");
        let b = &ev.balance;
        assert!((b.energy_w.value - b.receipt_energy_w.value).abs() <= 1e-9 * w * hf);
        println!("spray h_s {h_s}: W_c {} kg/s", f.spray_condensation.value);
    }
}

#[test]
fn heater_sources_go_to_the_zones_the_rods_wet_by_level() {
    let p = prepared_all();
    let mut v = physical(&coordinates(&p.y, &p.scales, None));
    let zero = [0.; st::COORDINATES];
    let hg = p
        .preparation
        .column
        .interface_saturation
        .vapor
        .enthalpy
        .value;
    // Prepared levels: A to 6.80 m, the mixture to 12.5 m. Both banks wet.
    let receipts = [Receipt::zero(); 3];
    // Per-zone wet sources, as the heater owner evaluates them at each
    // zone's own state (A is deeper and more subcooled than R).
    let banks = vec![
        bank(6.5, 7.5, [2.9e4, 9.1e4], [0.004, 0.016], 0., 0., 0.),
        bank(6.5, 9.5, [1.6e4, 1.84e5], [0.003, 0.047], 0., 0., 0.),
    ];
    let boundary = Boundary {
        heaters: banks.clone(),
        ..shut()
    };
    let rest = evaluate_all(&p, &v, &zero, receipts, &shut()).flows.sources;
    let ev = evaluate_all(&p, &v, &zero, receipts, &boundary);
    let c = &ev.column;
    let mut expected = [0.; 2];
    let mut expected_mass = [0.; 2];
    for b in &banks {
        let w = p.cell.heater_wetting(c, b.bottom_m, b.top_m).unwrap();
        assert!(
            (w.wet_fraction.value - 1.).abs() < 1e-12 && w.exposed_length_m.value.abs() < 1e-12
        );
        assert!((w.admitted_length_m.value - 0.3).abs() < 1e-12);
        for k in 0..2 {
            let (q, gamma) = (b.wet_heat_w[k].value, b.wet_vapor_kg_s[k].value);
            expected[k] += q - gamma * hg;
            expected_mass[k] -= gamma;
        }
    }
    let src = &ev.flows.sources;
    let d = |i: usize| src[i].value - rest[i].value;
    assert!((d(st::ADMITTED_ENERGY) - expected[0]).abs() <= 1e-9 * expected[0].abs());
    assert!((d(st::RESIDENT_ENERGY) - expected[1]).abs() <= 1e-9 * expected[1].abs());
    assert!((d(st::ADMITTED_MASS) - expected_mass[0]).abs() <= 1e-15);
    assert!((d(st::RESIDENT_MASS) - expected_mass[1]).abs() <= 1e-15);
    // Each zone's wet boiling enters its own bubble stock (amendment 6).
    assert!((d(st::ADMITTED_BUBBLE_MASS) - 0.007).abs() <= 1e-15);
    assert!((d(st::BUBBLE_MASS) - 0.063).abs() <= 1e-15);
    assert!(d(st::VAPOR_ENERGY).abs() <= 1e-9);
    // Wet heat totals: the liquid layers and the bubbles' carried enthalpy.
    let total = d(st::ADMITTED_ENERGY)
        + d(st::RESIDENT_ENERGY)
        + (d(st::BUBBLE_MASS) + d(st::ADMITTED_BUBBLE_MASS)) * hg;
    assert!((total - 3.2e5).abs() <= 1e-9 * 3.2e5);

    // Mixture level lowered to 8.5 m: the backup bank is wet over 2 of its
    // 3 m (0.3 m in A, 1.7 m in R) and exposed over 1 m.
    v[st::RESIDENT_VOLUME] = p.cell.volume_below(s(8.5)).value - v[st::ADMITTED_VOLUME];
    let hl = 1.55e6;
    let banks = vec![bank(
        6.5,
        9.5,
        [0.15 * 1.5e5, 0.85 * 1.5e5],
        [0.15 * 0.03, 0.85 * 0.03],
        4.0e3,
        0.002,
        hl,
    )];
    let boundary = Boundary {
        heaters: banks,
        ..shut()
    };
    let rest = evaluate_all(&p, &v, &zero, receipts, &shut()).flows.sources;
    let ev = evaluate_all(&p, &v, &zero, receipts, &boundary);
    let w = p.cell.heater_wetting(&ev.column, 6.5, 9.5).unwrap();
    assert!((ev.column.mixture_elevation.value - 8.5).abs() < 1e-12);
    assert!((w.wet_fraction.value - 2. / 3.).abs() < 1e-12);
    assert!((w.admitted_length_m.value - 0.3).abs() < 1e-12);
    assert!((w.resident_length_m.value - 1.7).abs() < 1e-12);
    assert!((w.exposed_length_m.value - 1.).abs() < 1e-12);
    let src = &ev.flows.sources;
    let d = |i: usize| src[i].value - rest[i].value;
    let gv = ev.column.vapor.enthalpy.value;
    // The lowered level raises p_s; wall vapor is carried at its h_g,sat.
    let hg = ev.column.interface_saturation.vapor.enthalpy.value;
    assert!((d(st::ADMITTED_ENERGY) - 0.15 * (1.5e5 - 0.03 * hg)).abs() <= 1e-6);
    assert!((d(st::RESIDENT_ENERGY) - (0.85 * (1.5e5 - 0.03 * hg) + 0.002 * hl)).abs() <= 1e-6);
    assert!((d(st::VAPOR_ENERGY) - (4.0e3 - 0.002 * gv)).abs() <= 1e-6);
    assert!((d(st::VAPOR_MASS) + 0.002).abs() <= 1e-15);
    assert!((d(st::RESIDENT_MASS) - (0.002 - 0.85 * 0.03)).abs() <= 1e-15);
    let b = &ev.balance;
    assert!((b.energy_w.value - b.receipt_energy_w.value).abs() <= 1e-6);
}

#[test]
fn every_port_kind_and_both_banks_are_conserved_exactly() {
    let p = prepared_all();
    let v = active(&p);
    let rate = active_rates();
    let relief = st::ReliefState {
        lift: s(0.6),
        back_pressure_pa: s(3.0e5),
    };
    let boundary = Boundary {
        heat: Heat {
            vapor: s(1.1e4),
            admitted: s(0.),
            resident: s(5.0e4),
        },
        heaters: vec![
            bank(6.5, 7.5, [3.0e4, 8.0e4], [0.002, 0.008], 0., 0., 0.),
            bank(6.5, 9.5, [2.5e4, 2.05e5], [0.004, 0.036], 0., 0., 0.),
        ],
        walls: Vec::new(),
        relief: Some(relief),
    };
    let receipts = [
        Receipt {
            mass: s(-21.),
            enthalpy: s(-21. * 1.6e6 + 7.0e4),
            boron: s(-0.02),
        },
        Receipt {
            mass: s(2.4),
            enthalpy: s(2.4 * 1.25e6),
            boron: s(0.003),
        },
        Receipt::zero(),
    ];
    let ev = evaluate_all(&p, &v, &rate, receipts, &boundary);
    let f = &ev.flows;
    let out = f.relief.unwrap();
    assert!(
        out.vapor_kg_s.value > 0. && out.drop_kg_s.value > 0.,
        "partly wet outlet"
    );
    let implied: Vec<f64> = (0..st::COORDINATES)
        .map(|i| rate[i] - ev.rows[i].value * p.scales[i])
        .collect();
    let sat = &ev.column.interface_saturation;
    let mass = [
        st::VAPOR_MASS,
        st::ADMITTED_MASS,
        st::RESIDENT_MASS,
        st::BUBBLE_MASS,
        st::ADMITTED_BUBBLE_MASS,
        st::DROP_MASS,
    ]
    .iter()
    .map(|i| implied[*i])
    .sum::<f64>();
    let boron = implied[st::ADMITTED_BORON] + implied[st::RESIDENT_BORON] + implied[st::DROP_BORON];
    let work: f64 = f.work.iter().map(|w| w.value).sum();
    let energy = implied[st::VAPOR_ENERGY]
        + implied[st::ADMITTED_ENERGY]
        + implied[st::RESIDENT_ENERGY]
        + work
        + (implied[st::BUBBLE_MASS] + implied[st::ADMITTED_BUBBLE_MASS]) * sat.vapor.enthalpy.value
        + implied[st::DROP_MASS] * sat.liquid.enthalpy.value
        + f.transit_drift[0].value
        + f.transit_drift[1].value
        + f.admitted_transit_drift.value;
    let heater = 1.1e5 + 2.3e5;
    let expect_mass = -21. + 2.4 - out.vapor_kg_s.value - out.drop_kg_s.value;
    let expect_energy =
        -21. * 1.6e6 + 7.0e4 + 2.4 * 1.25e6 + 1.1e4 + 5.0e4 + heater - out.enthalpy_w.value;
    let expect_boron = -0.02 + 0.003 - out.boron_kg_s.value;
    assert!(
        (mass - expect_mass).abs() <= 1e-12 * 1e3,
        "mass {mass} vs {expect_mass}"
    );
    assert!(
        (boron - expect_boron).abs() <= 1e-12,
        "boron {boron} vs {expect_boron}"
    );
    assert!(
        (energy - expect_energy).abs() <= 1e-12 * 1e10,
        "energy {energy} vs {expect_energy}"
    );
    let b = &ev.balance;
    assert!((b.receipt_mass_kg_s.value - expect_mass).abs() <= 1e-12 * 1e3);
    assert!((b.energy_w.value - b.receipt_energy_w.value).abs() <= 1e-12 * 1e10);
    // The drops leave by their volume share of the vapor region.
    let alpha = v[st::DROP_VOLUME] / (v[st::VAPOR_VOLUME] + v[st::DROP_VOLUME]);
    let drop_flux = out.drop.unwrap().mass_flux.value;
    assert!((out.drop_kg_s.value - alpha * 0.6 * 0.004_116_720_573_82 * drop_flux).abs() <= 1e-12);
    println!(
        "relief at lift 0.6: vapor {} kg/s, drops {} kg/s",
        out.vapor_kg_s.value, out.drop_kg_s.value
    );
}

#[test]
fn relief_outlet_is_dry_without_drops_and_its_roots_follow_raw_pt1() {
    let p = prepared_all();
    let v = physical(&coordinates(&p.y, &p.scales, None));
    let zero = [0.; st::COORDINATES];
    let boundary = Boundary {
        relief: Some(st::ReliefState {
            lift: s(1.),
            back_pressure_pa: s(101_325.),
        }),
        ..Boundary::closed()
    };
    let ev = evaluate_all(&p, &v, &zero, [Receipt::zero(); 3], &boundary);
    let out = ev.flows.relief.unwrap();
    assert_eq!(out.drop_kg_s.value, 0.);
    assert!(out.drop.is_none() && out.vapor_kg_s.value > 0.);
    assert_eq!(out.boron_kg_s.value, 0.);
    // Closed relief: no flow and no restriction evaluation.
    let shut = Boundary {
        relief: Some(st::ReliefState {
            lift: s(0.),
            back_pressure_pa: s(101_325.),
        }),
        ..Boundary::closed()
    };
    let ev0 = evaluate_all(&p, &v, &zero, [Receipt::zero(); 3], &shut);
    let out0 = ev0.flows.relief.unwrap();
    assert!(out0.vapor.is_none() && out0.vapor_kg_s.value == 0.);
    // A relief port needs its state, and its receipt is the cell's own.
    let x = Coordinates::values(&v);
    let r = Coordinates::values(&zero);
    let missing = p.cell.residual(
        &If97,
        &x,
        &r,
        &[Receipt::zero(); 3],
        &Boundary::closed(),
        &p.scales,
        None,
    );
    assert!(matches!(missing, Err(Failure::Fatal(_))));
    let device = p.cell.parameters().ports[2].relief.unwrap();
    let roof = s(ROOF_PA);
    let closed = device.roots(roof, s(0.), false, st::ReliefMotion::Closed);
    assert!((closed.demand.value - (ROOF_PA - 15.8e6)).abs() < 1e-6 && closed.travel.is_none());
    let opening = device.roots(roof, s(0.3), true, st::ReliefMotion::Opening);
    assert!((opening.demand.value - (ROOF_PA - 15.6e6)).abs() < 1e-6);
    assert!((opening.travel.unwrap().value - 0.7).abs() < 1e-15);
    assert_eq!(device.lift_rate(st::ReliefMotion::Opening), 20.);
    assert_eq!(device.lift_rate(st::ReliefMotion::Closing), -20.);
    assert_eq!(device.lift_rate(st::ReliefMotion::Open), 0.);
    // Upper ports see p_roof and the vapor region's content.
    let view = p.cell.port_view(&ev.column, 1).unwrap();
    assert_eq!(view.pressure.value, ev.column.roof_pressure.value);
    assert!(view.phase[0].is_none() && view.phase[1].unwrap().fraction.value == 1.);
    println!(
        "dry relief at full lift: {} kg/s of vapor",
        out.vapor_kg_s.value
    );
}

#[test]
fn restriction_flux_directions_match_central_differences() {
    // Superheated steam (crossing into the dome on the path), saturated
    // liquid (flashing at once) and an unchoked low pressure ratio.
    let p0 = 15.2e6;
    let sat = If97.saturation(s(p0)).unwrap();
    let steam = state(true, p0, sat.temperature.value + 4.).1;
    // Drops saturated at p_s expand from the lower p_roof, so they start wet.
    let drops = If97
        .saturation(s(p0 + 6.0e3))
        .unwrap()
        .liquid
        .enthalpy
        .value;
    for (vapor, h0, back) in [
        (true, steam, 3.0e5),
        (false, drops, 3.0e5),
        (true, steam, 13.9e6),
    ] {
        let (dp, dh, db) = (2.0e3, 150., 1.0e3);
        let seeded = st::restriction_flux(
            &If97,
            vapor,
            Scalar::new(p0, dp),
            Scalar::new(h0, dh),
            Scalar::new(back, db),
        )
        .unwrap();
        let at = |e: f64| {
            st::restriction_flux(
                &If97,
                vapor,
                s(p0 + e * dp),
                s(h0 + e * dh),
                s(back + e * db),
            )
            .unwrap()
            .mass_flux
            .value
        };
        let (h1, h2) = (2e-3, 1e-3);
        let (coarse, fine) = (
            (at(h1) - at(-h1)) / (2. * h1),
            (at(h2) - at(-h2)) / (2. * h2),
        );
        let an = seeded.mass_flux.direction;
        let spread = (coarse - fine).abs();
        assert!(
            (an - fine).abs() <= 3. * spread + 1e-6 * an.abs().max(1.),
            "vapor {vapor} back {back}: analytic {an}, difference {fine}, spread {spread}"
        );
        assert_eq!(seeded.choked, back < 1e7, "choking at back {back}");
        println!(
            "vapor {vapor} back {back}: G {} direction {an} vs {fine}",
            seeded.mass_flux.value
        );
    }
}

fn wall(
    element: st::WallElement,
    wet: [f64; 2],
    vapor: [f64; 2],
    dry: f64,
    j: f64,
    hl: f64,
) -> st::WallReceipt {
    st::WallReceipt {
        element,
        wet_heat_w: wet.map(s),
        wet_vapor_kg_s: vapor.map(s),
        dry_heat_w: s(dry),
        condensate_kg_s: s(j),
        condensate_enthalpy_j_kg: s(hl),
    }
}

#[test]
fn wall_receipts_are_routed_to_the_zones_their_wetting_reports() {
    use st::WallElement::{Band, BottomHead, TopHead};
    let p = prepared_all();
    let v = physical(&coordinates(&p.y, &p.scales, None));
    let zero = [0.; st::COORDINATES];
    let receipts = [Receipt::zero(); 3];
    let rest = evaluate_all(&p, &v, &zero, receipts, &shut());
    let c = &rest.column;
    // Prepared levels: A to 6.80 m, the mixture to 12.5 m.
    let cases = [
        (
            Band {
                bottom_m: 6.5,
                top_m: 7.5,
            },
            [0.3, 0.7, 0.],
        ),
        (
            Band {
                bottom_m: 9.5,
                top_m: 13.5,
            },
            [0., 0.75, 0.25],
        ),
        (
            Band {
                bottom_m: 13.5,
                top_m: 18.5,
            },
            [0., 0., 1.],
        ),
        (BottomHead, [1., 0., 0.]),
        (TopHead, [0., 0., 1.]),
    ];
    let hg = c.interface_saturation.vapor.enthalpy.value;
    let gv = c.vapor.enthalpy.value;
    let hl = 1.5e6;
    let mut walls = Vec::new();
    let mut expected = [[0.; 2]; 3];
    let mut bubbles = 0.;
    let mut admitted_bubbles = 0.;
    for (n, (element, fractions)) in cases.iter().enumerate() {
        let w = p.cell.wall_wetting(c, *element).unwrap();
        let got = [
            w.admitted_fraction.value,
            w.resident_fraction.value,
            w.vapor_fraction.value,
        ];
        for (a, b) in got.iter().zip(fractions) {
            assert!((a - b).abs() < 1e-12, "{element:?}: {got:?}");
        }
        assert_eq!(w.band.is_some(), matches!(element, Band { .. }));
        // A wall owner scales its flux by the contact fractions.
        let flux = 1.0e4 * (n as f64 + 1.);
        let wet = [flux * got[0], flux * got[1]];
        let boil = [1e-3 * got[0], 2e-3 * got[1]];
        let (dry, j) = (300. * got[2], 4e-4 * got[2]);
        walls.push(wall(*element, wet, boil, dry, j, hl));
        expected[0][0] += wet[0] - boil[0] * hg;
        expected[0][1] -= boil[0];
        expected[1][0] += wet[1] - boil[1] * hg + j * hl;
        expected[1][1] += j - boil[1];
        expected[2][0] += dry - j * gv;
        expected[2][1] -= j;
        admitted_bubbles += boil[0];
        bubbles += boil[1];
    }
    let boundary = Boundary { walls, ..shut() };
    let ev = evaluate_all(&p, &v, &zero, receipts, &boundary);
    let d = |i: usize| ev.flows.sources[i].value - rest.flows.sources[i].value;
    for (zone, [e, m]) in [
        (st::ADMITTED_ENERGY, expected[0]),
        (st::RESIDENT_ENERGY, expected[1]),
        (st::VAPOR_ENERGY, expected[2]),
    ] {
        assert!(
            (d(zone) - e).abs() <= 1e-9 * e.abs().max(1.),
            "energy row {zone}"
        );
        assert!((d(zone - 1) - m).abs() <= 1e-15, "mass row {}", zone - 1);
    }
    assert!((d(st::BUBBLE_MASS) - bubbles).abs() <= 1e-15);
    assert!((d(st::ADMITTED_BUBBLE_MASS) - admitted_bubbles).abs() <= 1e-15);
    let b = &ev.balance;
    assert!((b.energy_w.value - b.receipt_energy_w.value).abs() <= 1e-6);
    // A wall cannot heat a zone it does not contact.
    let bad = Boundary {
        walls: vec![wall(
            Band {
                bottom_m: 13.5,
                top_m: 18.5,
            },
            [0., 1e3],
            [0.; 2],
            0.,
            0.,
            0.,
        )],
        ..shut()
    };
    let x = Coordinates::values(&v);
    let r = Coordinates::values(&zero);
    let refused = p
        .cell
        .residual(&If97, &x, &r, &receipts, &bad, &p.scales, None);
    assert!(matches!(refused, Err(Failure::Fatal(_))));
    let wet_top = Boundary {
        walls: vec![wall(TopHead, [1e3, 0.], [0.; 2], 0., 0., 0.)],
        ..shut()
    };
    assert!(
        p.cell
            .residual(&If97, &x, &r, &receipts, &wet_top, &p.scales, None)
            .is_err()
    );
}

#[test]
fn walls_with_every_port_kind_are_conserved_exactly() {
    use st::WallElement::{Band, BottomHead, TopHead};
    let p = prepared_all();
    let v = active(&p);
    let rate = active_rates();
    let probe = evaluate_all(&p, &v, &rate, [Receipt::zero(); 3], &shut());
    let c = probe.column;
    let mut walls = Vec::new();
    for (n, element) in [
        Band {
            bottom_m: 6.5,
            top_m: 9.5,
        },
        Band {
            bottom_m: 9.5,
            top_m: 14.5,
        },
        Band {
            bottom_m: 14.5,
            top_m: 18.5,
        },
        BottomHead,
        TopHead,
    ]
    .into_iter()
    .enumerate()
    {
        let w = p.cell.wall_wetting(&c, element).unwrap();
        let k = n as f64 + 1.;
        let f = [
            w.admitted_fraction.value,
            w.resident_fraction.value,
            w.vapor_fraction.value,
        ];
        walls.push(wall(
            element,
            [-2.0e3 * k * f[0], 3.0e3 * k * f[1]],
            [5e-4 * f[0], 7e-4 * f[1]],
            -150. * k * f[2],
            2e-4 * f[2],
            1.45e6,
        ));
    }
    let boundary = Boundary {
        heaters: vec![bank(6.5, 9.5, [1.2e4, 1.08e5], [0.002, 0.018], 0., 0., 0.)],
        walls: walls.clone(),
        relief: Some(st::ReliefState {
            lift: s(0.4),
            back_pressure_pa: s(2.5e5),
        }),
        ..Boundary::closed()
    };
    let receipts = [
        Receipt {
            mass: s(9.),
            enthalpy: s(9. * 1.28e6),
            boron: s(0.011),
        },
        Receipt {
            mass: s(1.1),
            enthalpy: s(1.1 * 1.3e6),
            boron: s(0.0013),
        },
        Receipt::zero(),
    ];
    let ev = evaluate_all(&p, &v, &rate, receipts, &boundary);
    let f = &ev.flows;
    let out = f.relief.unwrap();
    let implied: Vec<f64> = (0..st::COORDINATES)
        .map(|i| rate[i] - ev.rows[i].value * p.scales[i])
        .collect();
    let sat = &ev.column.interface_saturation;
    let mass = [
        st::VAPOR_MASS,
        st::ADMITTED_MASS,
        st::RESIDENT_MASS,
        st::BUBBLE_MASS,
        st::ADMITTED_BUBBLE_MASS,
        st::DROP_MASS,
    ]
    .iter()
    .map(|i| implied[*i])
    .sum::<f64>();
    let boron = implied[st::ADMITTED_BORON] + implied[st::RESIDENT_BORON] + implied[st::DROP_BORON];
    let work: f64 = f.work.iter().map(|w| w.value).sum();
    let energy = implied[st::VAPOR_ENERGY]
        + implied[st::ADMITTED_ENERGY]
        + implied[st::RESIDENT_ENERGY]
        + work
        + (implied[st::BUBBLE_MASS] + implied[st::ADMITTED_BUBBLE_MASS]) * sat.vapor.enthalpy.value
        + implied[st::DROP_MASS] * sat.liquid.enthalpy.value
        + f.transit_drift[0].value
        + f.transit_drift[1].value
        + f.admitted_transit_drift.value;
    let gv = ev.column.vapor.enthalpy.value;
    let walls_energy: f64 = walls
        .iter()
        .map(|w| {
            w.wet_heat_w[0].value + w.wet_heat_w[1].value + w.dry_heat_w.value
                - w.condensate_kg_s.value * gv
                + w.condensate_kg_s.value * w.condensate_enthalpy_j_kg.value
        })
        .sum();
    let expect_mass = 9. + 1.1 - out.vapor_kg_s.value - out.drop_kg_s.value;
    let expect_energy = 9. * 1.28e6 + 1.1 * 1.3e6 + 1.2e5 + walls_energy - out.enthalpy_w.value;
    let expect_boron = 0.011 + 0.0013 - out.boron_kg_s.value;
    assert!(
        (mass - expect_mass).abs() <= 1e-12 * 1e3,
        "mass {mass} vs {expect_mass}"
    );
    assert!(
        (boron - expect_boron).abs() <= 1e-12,
        "boron {boron} vs {expect_boron}"
    );
    assert!(
        (energy - expect_energy).abs() <= 1e-12 * 1e10,
        "energy {energy} vs {expect_energy}"
    );
    let b = &ev.balance;
    assert!((b.energy_w.value - b.receipt_energy_w.value).abs() <= 1e-12 * 1e10);
}

/// Cost of one 18-column directional Jacobian of the cell with the relief
/// open and drops present: one seeded residual per coordinate (and one for
/// the lift). A cost report only.
#[test]
#[ignore = "cost report only; run explicitly with --ignored --nocapture in release"]
fn relief_open_jacobian_cost_report() {
    let p = prepared_all();
    let v = active(&p);
    let rate = active_rates();
    let y: Vec<f64> = (0..st::COORDINATES).map(|i| v[i] / p.scales[i]).collect();
    let yp: Vec<f64> = (0..st::COORDINATES)
        .map(|i| rate[i] / p.scales[i])
        .collect();
    let receipts = [Receipt::zero(); 3];
    let jacobian = |reuse: bool| {
        let mut held = leitbild_operating_plant::network::Reuse::new(2, 2);
        let started = thread_cpu_s();
        for column in 0..=st::COORDINATES {
            let mut seed = vec![0.; st::COORDINATES];
            let mut lift = 0.;
            if column < st::COORDINATES {
                seed[column] = 1.;
            } else {
                lift = 1.;
            }
            let x = coordinates(&y, &p.scales, Some(&seed));
            let r = rates(&yp, &p.scales, Some(&seed), 40.);
            let boundary = Boundary {
                relief: Some(st::ReliefState {
                    lift: Scalar::new(0.6, lift),
                    back_pressure_pa: s(3.0e5),
                }),
                ..Boundary::closed()
            };
            let slots = st::Slots {
                vapor_and_resident: 0,
                admitted: 1,
                interface: 0,
                boundary: 1,
            };
            p.cell
                .residual(
                    &If97,
                    &x,
                    &r,
                    &receipts,
                    &boundary,
                    &p.scales,
                    reuse.then_some((&mut held, slots)),
                )
                .unwrap();
        }
        thread_cpu_s() - started
    };
    // Interleaved rounds, so a changing load affects both alike. Without a
    // matrix reuse every column takes its own directional pass, the cost
    // before the held partials.
    let mut best = [f64::INFINITY; 2];
    for _ in 0..7 {
        for (k, reuse) in [false, true].into_iter().enumerate() {
            best[k] = best[k].min(jacobian(reuse));
        }
    }
    println!(
        "18-column Jacobian with the relief open, thread CPU: per-column passes {:.3} ms, held partials {:.3} ms",
        best[0] * 1e3,
        best[1] * 1e3
    );
}

#[repr(C)]
struct Timespec {
    seconds: i64,
    nanoseconds: i64,
}
unsafe extern "C" {
    fn clock_gettime(clock: i32, out: *mut Timespec) -> i32;
}
/// CLOCK_THREAD_CPUTIME_ID (macOS 16, Linux 3).
const THREAD_CPU_CLOCK: i32 = if cfg!(target_os = "macos") { 16 } else { 3 };
fn thread_cpu_s() -> f64 {
    let mut t = Timespec {
        seconds: 0,
        nanoseconds: 0,
    };
    // SAFETY: one live stack Timespec matching the C layout; the C library
    // writes it and keeps no pointer.
    let status = unsafe { clock_gettime(THREAD_CPU_CLOCK, &mut t) };
    assert_eq!(status, 0, "thread CPU clock unavailable");
    t.seconds as f64 + t.nanoseconds as f64 * 1e-9
}

#[test]
fn held_relief_partials_reproduce_the_per_column_dual_directions() {
    let p = prepared_all();
    let v = active(&p);
    let rate = active_rates();
    let y: Vec<f64> = (0..st::COORDINATES).map(|i| v[i] / p.scales[i]).collect();
    let yp: Vec<f64> = (0..st::COORDINATES)
        .map(|i| rate[i] / p.scales[i])
        .collect();
    let receipts = [Receipt::zero(); 3];
    let slots = st::Slots {
        vapor_and_resident: 0,
        admitted: 1,
        interface: 0,
        boundary: 1,
    };
    let mut held = leitbild_operating_plant::network::Reuse::new(2, 2);
    let mut worst: f64 = 0.;
    for column in 0..=st::COORDINATES {
        let mut seed = vec![0.; st::COORDINATES];
        let mut lift = 0.;
        if column < st::COORDINATES {
            seed[column] = 1.;
        } else {
            lift = 1.;
        }
        let x = coordinates(&y, &p.scales, Some(&seed));
        let r = rates(&yp, &p.scales, Some(&seed), 40.);
        let boundary = Boundary {
            relief: Some(st::ReliefState {
                lift: Scalar::new(0.6, lift),
                back_pressure_pa: Scalar::new(3.0e5, 0.),
            }),
            ..Boundary::closed()
        };
        let dual = p
            .cell
            .residual(&If97, &x, &r, &receipts, &boundary, &p.scales, None)
            .unwrap();
        let reused = p
            .cell
            .residual(
                &If97,
                &x,
                &r,
                &receipts,
                &boundary,
                &p.scales,
                Some((&mut held, slots)),
            )
            .unwrap();
        let out = reused.flows.relief.unwrap();
        // The base point's partials are evaluated once; later columns hold them.
        if column > 0 {
            assert_eq!(out.vapor.unwrap().saturation_calls, 0, "column {column}");
        }
        for i in 0..st::COORDINATES {
            let (a, b) = (dual.rows[i], reused.rows[i]);
            assert_eq!(
                a.value.to_bits(),
                b.value.to_bits(),
                "column {column} row {i}"
            );
            let error = (a.direction - b.direction).abs() / a.direction.abs().max(1e-300);
            if a.direction != 0. {
                worst = worst.max(error);
            }
            assert!(
                (a.direction - b.direction).abs() <= 1e-10 * a.direction.abs() + 1e-300,
                "column {column} row {i}: dual {:e} held {:e}",
                a.direction,
                b.direction
            );
        }
    }
    println!("held relief partials against per-column duals: worst relative {worst:e}");
}

#[test]
fn relief_stops_exactly_at_its_ends_and_reports_the_transaction() {
    let p = all_ports();
    let device = p.ports[2].relief.unwrap();
    let mut lift = 1. - 3e-13;
    let stop = device
        .stop(st::ReliefMotion::Opening, &mut lift, 1e-9)
        .unwrap();
    assert_eq!(lift, 1.);
    assert_eq!(stop.motion_after, st::ReliefMotion::Open);
    assert_eq!(stop.lift_before, 1. - 3e-13);
    assert_eq!(stop.defect, stop.lift_before - 1.);
    assert_eq!(device.lift_rate(stop.motion_after), 0.);
    let mut seat = 2e-12;
    let stop = device
        .stop(st::ReliefMotion::Closing, &mut seat, 1e-9)
        .unwrap();
    assert_eq!((seat, stop.motion_after), (0., st::ReliefMotion::Closed));
    // Not at its root, or with no travel: refused, the lift unchanged.
    let mut far = 0.7;
    assert!(
        device
            .stop(st::ReliefMotion::Opening, &mut far, 1e-9)
            .is_err()
    );
    assert_eq!(far, 0.7);
    let mut open = 1.;
    assert!(
        device
            .stop(st::ReliefMotion::Open, &mut open, 1e-9)
            .is_err()
    );
}

#[test]
fn cases_take_bubble_diameters_only_from_the_declared_list() {
    let p = all_ports();
    let nominal = Case::nominal(&p);
    assert_eq!(nominal.bubble_diameter_m, 0.00075);
    assert!(Cell::new(p.clone(), nominal).is_ok());
    // Without a declared list only the nominal diameter is a case.
    let half = Case {
        bubble_diameter_m: 0.000375,
        ..nominal
    };
    assert!(Cell::new(p.clone(), half).is_err());
    // The verification cases declare the bubble family beside the nominal.
    let families: st::SensitivityFamilies = serde_json::from_str(
        r#"{"relaxation":[0.5,2],"sprayDrop_m":[0.0015,0.006],"bubble_m":[0.000375,0.0015]}"#,
    )
    .unwrap();
    assert!(Cell::for_case(p.clone(), half, Some(&families)).is_ok());
    let off = Case {
        bubble_diameter_m: 0.0009,
        ..nominal
    };
    assert!(Cell::for_case(p.clone(), off, Some(&families)).is_err());
    let disagreeing = st::SensitivityFamilies {
        spray_drop_m: vec![0.002],
        ..families
    };
    assert!(Cell::for_case(p.clone(), nominal, Some(&disagreeing)).is_err());
    // The spray port is a recorded boundary flow with no face.
    assert!(p.ports[1].face.is_none() && p.validate().is_ok());
}

#[test]
fn heater_wet_sources_are_refused_on_a_zone_the_span_does_not_touch() {
    let p = prepared_all();
    let v = physical(&coordinates(&p.y, &p.scales, None));
    let x = Coordinates::values(&v);
    let r = Coordinates::values(&[0.; st::COORDINATES]);
    let receipts = [Receipt::zero(); 3];
    let run = |heater: st::HeaterReceipt| {
        let boundary = Boundary {
            heaters: vec![heater],
            ..shut()
        };
        p.cell
            .residual(&If97, &x, &r, &receipts, &boundary, &p.scales, None)
    };
    // [6.5, 6.7] m lies wholly in A (to 6.80 m): R heat is refused.
    assert!(run(bank(6.5, 6.7, [1e3, 0.], [0.; 2], 0., 0., 0.)).is_ok());
    assert!(matches!(
        run(bank(6.5, 6.7, [1e3, 5e2], [0.; 2], 0., 0., 0.)),
        Err(Failure::Fatal(_))
    ));
    // A fully wet bank has no exposed length for exposed sources.
    assert!(matches!(
        run(bank(6.5, 9.5, [1e3, 1e3], [0.; 2], 50., 0., 0.)),
        Err(Failure::Fatal(_))
    ));
}
