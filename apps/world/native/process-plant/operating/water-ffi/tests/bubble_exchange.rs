//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressurizer-thermal-state.md#bulk-bubble-exchange
//! The stratified cell's bulk bubble exchange (request 4, K1) against the
//! maintained IF97 boundary: its zero cases and signs, its magnitude against
//! the lead's single-bubble hand estimate, the mass, energy and boron
//! identity with the exchange active, and its directions against central
//! differences, in the cell and in the network's colored Jacobian. The cell
//! section mirrors the contract's `pzr.cell` with the committed strict
//! blocks; the roof pressure is the S1 packet's declared operating point.
use leitbild_operating_plant::{
    network::{
        Failure, Properties,
        stratified::{
            self as st, Boundary, Case, Cell, Coordinates, ExchangeCase, Heat, Parameters, Receipt,
            bubble_exchange, ranz_marshall, terminal_velocity,
        },
    },
    thermal::Scalar,
};
use leitbild_operating_water::If97;

const ROOF_PA: f64 = 14_864_186.805_5;
const LEVEL_M: f64 = 6.0;

fn section() -> String {
    r#"{"index":28,"bottom_m":6.5,"top_m":18.5,"fluidVolume_m3":59.7486726,
 "freeArea":[{"from_m":6.5,"to_m":7.5,"area_m2":4.909522131576614},{"from_m":7.5,"to_m":9.5,"area_m2":4.9195752280681013},{"from_m":9.5,"to_m":18.5,"area_m2":5.0}],
 "ports":[{"id":"PZR.SURGE.MOUTH","kind":"surge","elevation_m":6.5,"face":34,"bore_m":0.3}],
 "taps":[{"id":"PT1","elevation_m":18.5},{"id":"LT.LOW","elevation_m":6.5},{"id":"LT.HIGH","elevation_m":18.5}],
 "heaters":{"bottom_m":6.5,"top_m":9.5,"displacement_m3":0.25132741228718347},
 "stratified":{"withdrawalScale_m":0.30,"admittedPreparationThickness_m":0.30,"inversionExchangeVelocity_m_s":320,"liquidRelaxationTime_s":0.3,"vaporRelaxationTime_s":0.5,"relaxationSensitivity":[0.5,1,2],"bubbleDiameter_m":0.00075,"bubbleVaporCoefficient_W_m2K":1000,"bubbleExchangeSensitivity":[0.5,1,2],"bubbleExchangeDiameterSensitivity_m":0.0005,"sprayDropDiameter_m":0.003,"dropDiameterSensitivity_m":[0.0015,0.003,0.006],"resolvabilityFactor":1000},
 "metastable":{"pressureRange_Pa":[2000000,16000000],"lowerBoundExclusive":true,"liquidSuperheatMax_K":2.0,"vaporSubcoolingMax_K":1.4,"trialMax_K":3.0,"creditedMax_K":0.5,"liquidTemperatureMax_K":623.15,"liquidPressureCeiling_Pa":17000000,"vaporPressureCeiling_Pa":16000000},
 "absorberMassFraction":0.001,"interfacialLength_m":0.003}"#
        .to_string()
}
fn parameters() -> Parameters {
    serde_json::from_str(&section()).unwrap()
}
fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}

/// The nominal exchange and the request's three exchange sensitivities.
fn cases() -> [(&'static str, ExchangeCase); 4] {
    let nominal = ExchangeCase::nominal();
    [
        ("nominal", nominal),
        (
            "exchange x0.5",
            ExchangeCase {
                factor: 0.5,
                ..nominal
            },
        ),
        (
            "exchange x2",
            ExchangeCase {
                factor: 2.,
                ..nominal
            },
        ),
        (
            "exchange-only 0.5 mm",
            ExchangeCase {
                diameter_m: Some(0.0005),
                ..nominal
            },
        ),
    ]
}

/// Test coordinate scales; the network owns the solver's scales.
fn scales(v: &[f64; st::COORDINATES]) -> [f64; st::COORDINATES] {
    let mut scales = *v;
    scales[st::BUBBLE_VOLUME] = 0.5;
    scales[st::DROP_VOLUME] = 0.05;
    scales[st::BUBBLE_MASS] = 50.;
    scales[st::DROP_MASS] = 30.;
    scales[st::DROP_BORON] = 0.03;
    scales
}

struct Prepared {
    cell: Cell,
    preparation: st::Preparation,
    scales: [f64; st::COORDINATES],
}
fn prepared_with(exchange: ExchangeCase) -> Prepared {
    let p = parameters();
    let case = Case::nominal(&p);
    let cell = Cell::new(p, case).unwrap().with_exchange(exchange).unwrap();
    let preparation = cell.prepare(&If97, ROOF_PA, LEVEL_M, 1e-6, 50).unwrap();
    let scales = scales(&preparation.values);
    Prepared {
        cell,
        preparation,
        scales,
    }
}
fn prepared() -> Prepared {
    prepared_with(ExchangeCase::nominal())
}

/// The prepared values with `bubbles` kg in transit, their volume, and R
/// at `T_R = Tsat(p_s) + excess` at its own centroid pressure. The column's
/// pressures follow from masses and volumes alone, so R's energy sets its
/// temperature against this state's own `Tsat(p_s)`.
fn with_bubbles(p: &Prepared, excess_k: f64, bubbles: f64) -> [f64; st::COORDINATES] {
    let mut v = p.preparation.values;
    let prepared = &p.preparation.column.interface_saturation;
    v[st::BUBBLE_MASS] = bubbles;
    v[st::BUBBLE_VOLUME] = bubbles / prepared.vapor.density.value;
    let c = p
        .cell
        .column(&If97, &Coordinates::values(&v), None)
        .unwrap();
    let t = c.interface_saturation.temperature.value + excess_k;
    let u = If97
        .forward(false, c.resident.pressure.value, t)
        .unwrap()
        .internal_energy_j_kg;
    v[st::RESIDENT_ENERGY] = v[st::RESIDENT_MASS] * u;
    v
}

fn evaluate(
    p: &Prepared,
    values: &[f64; st::COORDINATES],
    rate: &[f64; st::COORDINATES],
    receipt: Receipt,
    heat: Heat,
) -> Result<st::Evaluation, Failure> {
    p.cell.residual(
        &If97,
        &Coordinates::values(values),
        &Coordinates::values(rate),
        &[receipt],
        &Boundary {
            heat,
            ..Boundary::closed()
        },
        &p.scales,
        None,
    )
}
fn at_rest(p: &Prepared, values: &[f64; st::COORDINATES]) -> st::Evaluation {
    evaluate(
        p,
        values,
        &[0.; st::COORDINATES],
        Receipt::zero(),
        Heat::zero(),
    )
    .unwrap()
}

#[test]
fn the_exchange_is_zero_without_bubbles_and_for_liquid_at_or_above_saturation() {
    let p = prepared();
    // The prepared rest state: no bubbles, so nothing condenses.
    let ev = at_rest(&p, &p.preparation.values);
    let x = &ev.flows.bubble_exchange;
    assert_eq!(x.condensation.value, 0.);
    assert_eq!(x.area_m2.value, 0.);
    // R subcooled by 2 K but no bubbles: zero, with the linear law's slope
    // along the stock still present for the Jacobian.
    let v = with_bubbles(&p, -2., 0.);
    let ev = at_rest(&p, &v);
    assert_eq!(ev.flows.bubble_exchange.condensation.value, 0.);
    let mut seeded = Coordinates::values(&v);
    seeded.bubble_mass = Scalar::new(0., 1.);
    let ev = p
        .cell
        .residual(
            &If97,
            &seeded,
            &Coordinates::values(&[0.; st::COORDINATES]),
            &[Receipt::zero()],
            &Boundary::closed(),
            &p.scales,
            None,
        )
        .unwrap();
    // dW_x/dM_b = 6 h_L (T_s - T_R)/(ρ_g,sat d h_fg) at that state: the
    // other factors multiply the zero area.
    let slope = ev.flows.bubble_exchange.condensation.direction;
    let (c, f) = (&ev.column, &ev.flows);
    let sat = &c.interface_saturation;
    let d = p.cell.case().bubble_diameter_m;
    let (h, _) = ranz_marshall(d, f.bubble.velocity, &c.resident.water());
    let expected = 6. * h.value * (sat.temperature.value - c.resident.temperature.value)
        / (sat.vapor.density.value * d * (sat.vapor.enthalpy.value - sat.liquid.enthalpy.value));
    assert!(
        slope > 0. && (slope - expected).abs() <= 1e-12 * expected,
        "{slope} vs {expected}"
    );
    // R at or above the stock's saturation: zero value and zero directions,
    // whichever coordinate is seeded. The flashing relaxation takes R's
    // superheat; the two never act together.
    for excess in [1e-3, 0.05, 0.3] {
        let v = with_bubbles(&p, excess, 40.);
        let ev = at_rest(&p, &v);
        let f = &ev.flows;
        let r_minus_ts =
            ev.column.resident.temperature.value - ev.column.interface_saturation.temperature.value;
        assert!(r_minus_ts > 0., "R must sit above Tsat(p_s): {r_minus_ts}");
        assert_eq!(f.bubble_exchange.condensation.value, 0., "+{excess} K");
        assert_eq!(f.bubble_exchange.liquid_heat_w.value, 0.);
        if excess == 0.3 {
            assert!(f.resident_flashing.value > 0., "R +0.3 K flashes");
        }
        for j in 0..st::COORDINATES {
            let mut x = Coordinates::values(&v).to_array();
            x[j] = Scalar::new(x[j].value, 1e-3 * p.scales[j]);
            let x = Coordinates::from_slice(&x).unwrap();
            let ev = p
                .cell
                .residual(
                    &If97,
                    &x,
                    &Coordinates::values(&[0.; st::COORDINATES]),
                    &[Receipt::zero()],
                    &Boundary::closed(),
                    &p.scales,
                    None,
                )
                .unwrap();
            let c = ev.flows.bubble_exchange.condensation;
            assert_eq!((c.value, c.direction), (0., 0.), "column {j}");
        }
    }
    // R subcooled: condensation, no flashing; the vapor side is the
    // saturated stock's and is exactly zero in value and direction.
    let v = with_bubbles(&p, -0.5, 40.);
    let ev = at_rest(&p, &v);
    let f = &ev.flows;
    assert!(f.bubble_exchange.condensation.value > 0.);
    assert_eq!(f.resident_flashing.value, 0.);
    for j in 0..st::COORDINATES {
        let mut x = Coordinates::values(&v).to_array();
        x[j] = Scalar::new(x[j].value, 1e-3 * p.scales[j]);
        let ev = p
            .cell
            .residual(
                &If97,
                &Coordinates::from_slice(&x).unwrap(),
                &Coordinates::values(&[0.; st::COORDINATES]),
                &[Receipt::zero()],
                &Boundary::closed(),
                &p.scales,
                None,
            )
            .unwrap();
        let q = ev.flows.bubble_exchange.vapor_heat_w;
        assert_eq!((q.value, q.direction), (0., 0.), "column {j}");
    }
    // Liquid at Tsat(p_s), within the caloric inverse's bound: the exchange
    // is at most that bound's share. It is continuous through saturation:
    // linear in the subcooling down to zero.
    let v = with_bubbles(&p, 0., 40.);
    let ev = at_rest(&p, &v);
    let gap = (ev.column.interface_saturation.temperature.value
        - ev.column.resident.temperature.value)
        .abs();
    assert!(gap < 1e-6, "{gap} K");
    let condensation = |subcooling: f64| {
        at_rest(&p, &with_bubbles(&p, -subcooling, 40.))
            .flows
            .bubble_exchange
            .condensation
            .value
    };
    let per_kelvin = condensation(1.);
    assert!(ev.flows.bubble_exchange.condensation.value <= 2. * per_kelvin * gap);
    let small = condensation(1e-3);
    assert!(
        (small / (1e-3 * per_kelvin) - 1.).abs() < 0.01,
        "{small} against {}",
        1e-3 * per_kelvin
    );
}

/// One shrinking bubble in an unbounded bath at constant subcooling, the
/// lead's hand estimate: `dd/dt = −2 h_L(d) ΔT/(ρ_g h_fg)` with the cell's
/// own Ranz–Marshall coefficient at the bubble's terminal speed `u(d)` (the
/// cell's own drag balance), and `dz/dt = u(d)`. Midpoint quadrature over
/// the diameter; returns the collapse time and rise distance.
fn single_bubble_collapse(
    d0: f64,
    bath: &leitbild_operating_plant::thermal::WaterPoint,
    sat: &leitbild_operating_plant::thermal::Saturation,
    subcooling_k: f64,
) -> (f64, f64) {
    let (rho_g, hfg) = (
        sat.vapor.density.value,
        sat.vapor.enthalpy.value - sat.liquid.enthalpy.value,
    );
    let n = 4000;
    let step = d0 / n as f64;
    let (mut time, mut rise) = (0., 0.);
    for k in 0..n {
        let d = (k as f64 + 0.5) * step;
        let u = terminal_velocity(d, sat.liquid, sat.vapor.density)
            .unwrap()
            .velocity;
        let (h, _) = ranz_marshall(d, u, bath);
        let dt = rho_g * hfg / (2. * h.value * subcooling_k) * step;
        time += dt;
        rise += u.value * dt;
    }
    (time, rise)
}

#[test]
fn subcooled_liquid_condenses_the_stock_at_the_hand_estimate() {
    let p = prepared();
    // Request 4, K1: at 4.5 K a 0.75 mm bubble collapses in about 0.5 s over
    // about 4 cm; at 0.5 K in about 4.5 s over about 35 cm.
    for (subcooling, collapse_s, rise_m) in [(4.5, 0.5, 0.04), (0.5, 4.5, 0.35)] {
        let bubbles = 1.;
        let v = with_bubbles(&p, -subcooling, bubbles);
        let ev = at_rest(&p, &v);
        let f = &ev.flows;
        let x = &f.bubble_exchange;
        let c = &ev.column;
        let sat = &c.interface_saturation;
        let r = &c.resident;
        let dt = sat.temperature.value - r.temperature.value;
        assert!((dt - subcooling).abs() < 1e-4, "{dt}");
        // Sign: the stock loses W_x to R, which gains it with h_g,sat(p_s).
        let w = x.condensation.value;
        assert!(w > 0. && x.liquid_heat_w.value < 0.);
        let (hf, hg) = (sat.liquid.enthalpy.value, sat.vapor.enthalpy.value);
        assert!(
            (f.sources[st::BUBBLE_MASS].value + f.bubble_rise.value + w).abs() <= 1e-12 * w,
            "the stock's sinks are rise and condensation only here"
        );
        assert!((x.liquid_heat_w.value + w * (hg - hf)).abs() <= 1e-12 * w * (hg - hf));
        // The law from its public pieces: A_i h_L (T_s - T_R) / h_fg.
        let d = p.cell.case().bubble_diameter_m;
        assert_eq!(x.diameter_m, d);
        let (h, re) = ranz_marshall(d, f.bubble.velocity, &r.water());
        let area = 6. * bubbles / (sat.vapor.density.value * d);
        let expected = area * h.value * dt / (hg - hf);
        assert!((w - expected).abs() <= 1e-12 * w, "{w} vs {expected}");
        assert_eq!(x.liquid_coefficient.value, h.value);
        assert_eq!(x.reynolds.value, re.value);
        // The residual's exchange is the public law on its own inputs.
        let again = bubble_exchange(
            p.cell.exchange_diameter_m(),
            p.cell.exchange().factor,
            p.cell
                .parameters()
                .stratified
                .bubble_vapor_coefficient_w_m2k,
            s(bubbles),
            f.bubble.velocity,
            r,
            sat,
        );
        assert_eq!(again.condensation.value.to_bits(), w.to_bits());
        // The maintained-diameter rate, and the single-bubble estimate that
        // starts at the same coefficient: dd/dt(0) = d W_x/(3 M_b).
        let rate = w / bubbles;
        let shrink = 2. * h.value * dt / (sat.vapor.density.value * (hg - hf));
        assert!((shrink - d * rate / 3.).abs() <= 1e-12 * shrink);
        let (time, rise) = single_bubble_collapse(d, &r.water(), sat, dt);
        println!(
            "{subcooling} K: W_x/M_b = {rate:.4} 1/s (e-folding {:.3} s), u_b = {:.4} m/s, Re_x = {:.1}, We = {:.3}, h_L = {:.0} W/(m2 K); one bubble collapses in {time:.3} s over {:.2} cm",
            1. / rate,
            f.bubble.velocity.value,
            re.value,
            x.weber.value,
            h.value,
            100. * rise
        );
        // The hand estimate's own two figures.
        assert!(
            (time / collapse_s - 1.).abs() <= 0.1,
            "{time} s against about {collapse_s} s"
        );
        assert!(
            (rise / rise_m - 1.).abs() <= 0.1,
            "{rise} m against about {rise_m} m"
        );
    }
}

#[test]
fn sensitivities_scale_the_exchange_and_change_only_its_diameter() {
    let mut rates = Vec::new();
    for (name, exchange) in cases() {
        let prepared = prepared_with(exchange);
        let v = with_bubbles(&prepared, -1., 5.);
        let ev = at_rest(&prepared, &v);
        let x = ev.flows.bubble_exchange;
        // Drag always at the bubble diameter: the rise is the nominal one.
        assert_eq!(prepared.cell.case().bubble_diameter_m, 0.00075, "{name}");
        rates.push((name, x.condensation.value, ev.flows.bubble_rise.value, x));
    }
    let (_, nominal, rise, nominal_exchange) = rates[0];
    assert!(nominal > 0.);
    for (name, w, r, x) in &rates[1..] {
        assert_eq!(*r, rise, "{name}: the rise must not change");
        match *name {
            "exchange x0.5" => assert!((w / nominal - 0.5).abs() <= 1e-14),
            "exchange x2" => assert!((w / nominal - 2.).abs() <= 1e-14),
            _ => {
                // The earlier selection's 0.5 mm: larger area per mass and a
                // smaller Reynolds number at the same rise speed.
                assert_eq!(x.diameter_m, 0.0005);
                let area = x.area_m2.value / nominal_exchange.area_m2.value;
                assert!((area - 1.5).abs() <= 1e-14, "{area}");
                assert!(x.reynolds.value < nominal_exchange.reynolds.value);
                assert!(w / nominal > 1.5, "{}", w / nominal);
            }
        }
        println!("{name}: W_x = {w} kg/s ({} x nominal)", w / nominal);
    }
}

#[test]
fn cases_take_the_exchange_factor_and_diameter_only_from_the_block() {
    let p = parameters();
    let cell = || Cell::new(p.clone(), Case::nominal(&p)).unwrap();
    // A new cell exchanges at factor 1 and at its bubble diameter.
    assert_eq!(cell().exchange(), ExchangeCase::nominal());
    assert_eq!(
        ExchangeCase::nominal(),
        ExchangeCase {
            factor: 1.,
            diameter_m: None
        }
    );
    assert_eq!(cell().exchange_diameter_m(), 0.00075);
    for (name, exchange) in cases() {
        assert!(cell().with_exchange(exchange).is_ok(), "{name}");
    }
    let half = cell().with_exchange(cases()[3].1).unwrap();
    assert_eq!(
        (half.exchange_diameter_m(), half.case().bubble_diameter_m),
        (0.0005, 0.00075)
    );
    // The bubble family moves drag and exchange together.
    let families: st::SensitivityFamilies = serde_json::from_str(
        r#"{"relaxation":[0.5,2],"sprayDrop_m":[0.0015,0.006],"bubble_m":[0.000375,0.0015]}"#,
    )
    .unwrap();
    let small = Cell::for_case(
        p.clone(),
        Case {
            bubble_diameter_m: 0.000375,
            ..Case::nominal(&p)
        },
        Some(&families),
    )
    .unwrap();
    assert_eq!(small.exchange_diameter_m(), 0.000375);
    let nominal = ExchangeCase::nominal();
    for refused in [
        ExchangeCase {
            factor: 3.,
            ..nominal
        },
        ExchangeCase {
            diameter_m: Some(0.0006),
            ..nominal
        },
        ExchangeCase {
            diameter_m: Some(0.00075),
            ..nominal
        },
    ] {
        assert!(cell().with_exchange(refused).is_err(), "{refused:?}");
    }
    // The block refuses a factor list without the nominal 1 and an
    // exchange-only diameter equal to the bubble diameter it varies.
    let mut bad = parameters();
    bad.stratified.bubble_exchange_sensitivity = [0.5, 1.5, 2.];
    assert!(bad.validate().is_err());
    let mut bad = parameters();
    bad.stratified.bubble_exchange_diameter_sensitivity_m = 0.00075;
    assert!(bad.validate().is_err());
    let mut bad = parameters();
    bad.stratified.bubble_vapor_coefficient_w_m2k = 0.;
    assert!(bad.validate().is_err());
    // The block's keys are required: a section without them does not parse.
    let missing = section().replace(r#""bubbleVaporCoefficient_W_m2K":1000,"#, "");
    assert!(serde_json::from_str::<Parameters>(&missing).is_err());
}

/// An active state with the exchange on: R 1.5 K below Tsat(p_s), A in a
/// slight inversion, the vapor slightly superheated, both transit stocks and
/// perturbed volumes.
fn active(p: &Prepared) -> [f64; st::COORDINATES] {
    let mut v = with_bubbles(p, -1.5, 40.);
    let c = &p.preparation.column;
    let t = c.interface_saturation.temperature.value;
    let state = |vapor: bool, pressure: f64, t: f64| {
        If97.forward(vapor, pressure, t)
            .unwrap()
            .internal_energy_j_kg
    };
    v[st::ADMITTED_ENERGY] =
        v[st::ADMITTED_MASS] * state(false, c.admitted.pressure.value, t - 1.2);
    v[st::VAPOR_ENERGY] = v[st::VAPOR_MASS] * state(true, c.vapor.pressure.value, t + 0.4);
    v[st::DROP_MASS] = 15.;
    v[st::DROP_VOLUME] = 0.026;
    v[st::DROP_BORON] = 0.012;
    v[st::VAPOR_VOLUME] -= 0.35;
    v[st::RESIDENT_VOLUME] -= 0.07;
    v[st::ADMITTED_VOLUME] += 0.01;
    v[st::ROOF_PRESSURE] += 2.0e4;
    v
}
fn active_rates() -> [f64; st::COORDINATES] {
    let mut r = [0.; st::COORDINATES];
    r[st::ROOF_PRESSURE] = 1.7e4;
    r[st::VAPOR_VOLUME] = -0.06;
    r[st::ADMITTED_VOLUME] = 0.011;
    r[st::RESIDENT_VOLUME] = 0.04;
    r[st::BUBBLE_VOLUME] = -0.008;
    r[st::DROP_VOLUME] = 0.0004;
    r[st::VAPOR_MASS] = -2.5;
    r[st::VAPOR_ENERGY] = -6.0e6;
    r[st::ADMITTED_MASS] = 7.;
    r[st::ADMITTED_ENERGY] = 1.1e7;
    r[st::ADMITTED_BORON] = 0.007;
    r[st::RESIDENT_MASS] = 9.;
    r[st::RESIDENT_ENERGY] = 1.3e7;
    r[st::RESIDENT_BORON] = 0.009;
    r[st::BUBBLE_MASS] = -1.5;
    r[st::DROP_MASS] = 0.4;
    r[st::DROP_BORON] = 0.0003;
    r
}

#[test]
fn mass_energy_and_boron_close_at_roundoff_with_the_exchange_active() {
    let heat = Heat {
        vapor: s(1.3e4),
        admitted: s(2.4e5),
        resident: s(7.7e4),
    };
    for (name, exchange) in cases() {
        let p = prepared_with(exchange);
        let v = active(&p);
        let rate = active_rates();
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
            for (what, q) in [
                ("exchange", f.bubble_exchange.condensation),
                ("rise", f.bubble_rise),
                ("fall", f.drop_fall),
                ("inversion", f.inversion),
                ("drift", f.transit_drift[0]),
            ] {
                assert!(q.value.abs() > 0., "{name}: {what} inactive");
            }
            assert!(f.bubble_exchange.condensation.value > 1., "{name}");
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
            let bound = |x: f64| 1e-12 * x.abs().max(1.);
            assert!(
                (mass - receipt.mass.value).abs() <= bound(1e3),
                "{name}: mass {mass}"
            );
            assert!(
                (boron - receipt.boron.value).abs() <= bound(1.),
                "{name}: boron {boron}"
            );
            assert!(
                (energy - expected_energy).abs() <= bound(1e10),
                "{name}: energy {energy} vs {expected_energy}"
            );
            let b = &ev.balance;
            assert!((b.mass_kg_s.value - b.receipt_mass_kg_s.value).abs() <= bound(1e3));
            assert!((b.energy_w.value - b.receipt_energy_w.value).abs() <= bound(1e10));
            assert!((b.boron_kg_s.value - b.receipt_boron_kg_s.value).abs() <= bound(1.));
            // The latent heat enters R once: its energy source carries the
            // condensate at h_g,sat, i.e. its sensible share and -Q_L.
            let x = &f.bubble_exchange;
            let (hf, hg) = (sat.liquid.enthalpy.value, sat.vapor.enthalpy.value);
            let w = x.condensation.value;
            assert!(
                (w * hg - (w * hf - x.liquid_heat_w.value - x.vapor_heat_w.value)).abs()
                    <= 1e-12 * w * hg
            );
        }
    }
}

#[test]
fn seeded_directions_match_central_differences_with_the_exchange_active() {
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
        let x: Vec<Scalar> = (0..st::COORDINATES)
            .map(|i| Scalar::new(y[i] * p.scales[i], seed.map_or(0., |d| d[i]) * p.scales[i]))
            .collect();
        let r: Vec<Scalar> = (0..st::COORDINATES)
            .map(|i| {
                Scalar::new(
                    yp[i] * p.scales[i],
                    seed.map_or(0., |d| d[i]) * cj * p.scales[i],
                )
            })
            .collect();
        p.cell
            .residual(
                &If97,
                &Coordinates::from_slice(&x).unwrap(),
                &Coordinates::from_slice(&r).unwrap(),
                &[receipt],
                &Boundary {
                    heat,
                    ..Boundary::closed()
                },
                &p.scales,
                None,
            )
            .unwrap()
    };
    let base = run(&y, &yp, None);
    assert!(base.flows.bubble_exchange.condensation.value > 1.);
    // Every unit column of the dense stage Jacobian dF/dy + cj dF/dy', and
    // the exchange alone, against two central differences.
    let mut worst: f64 = 0.;
    let mut worst_exchange: f64 = 0.;
    for j in 0..st::COORDINATES {
        let mut d = vec![0.; st::COORDINATES];
        d[j] = 1e-3;
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
            let rows: Vec<f64> = (0..st::COORDINATES)
                .map(|i| (plus.rows[i].value - minus.rows[i].value) / (2. * h))
                .collect();
            let exchange = (plus.flows.bubble_exchange.condensation.value
                - minus.flows.bubble_exchange.condensation.value)
                / (2. * h);
            (rows, exchange)
        };
        let ((coarse, coarse_x), (fine, fine_x)) = (difference(0.1), difference(0.05));
        for i in 0..st::COORDINATES {
            let an = seeded.rows[i].direction;
            let fd = fine[i];
            let spread = (coarse[i] - fine[i]).abs();
            let size = an.abs().max(fd.abs()).max(1e-12);
            let error = (an - fd).abs();
            if size > 1e-9 {
                worst = worst.max(error / size);
            }
            assert!(
                error <= 3. * spread + 2e-6 * size + 1e-12,
                "column {j} row {i}: analytic {an:e}, difference {fd:e}, spread {spread:e}"
            );
        }
        let an = seeded.flows.bubble_exchange.condensation.direction;
        let spread = (coarse_x - fine_x).abs();
        let size = an.abs().max(fine_x.abs()).max(1e-15);
        let error = (an - fine_x).abs();
        if size > 1e-12 {
            worst_exchange = worst_exchange.max(error / size);
        }
        assert!(
            error <= 3. * spread + 2e-6 * size + 1e-15,
            "column {j}: exchange direction {an:e}, difference {fine_x:e}, spread {spread:e}"
        );
    }
    println!("worst relative direction error: rows {worst:e}, exchange {worst_exchange:e}");
}
