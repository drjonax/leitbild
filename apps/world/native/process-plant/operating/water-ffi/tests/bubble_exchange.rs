//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressurizer-thermal-state.md#bulk-bubble-exchange
//! The stratified cell's bulk bubble exchange (request 4, K1) and zone A's
//! bubble stock (contract amendment 6) against the maintained IF97
//! boundary: the zero cases and signs of both stocks, their magnitude
//! against the lead's single-bubble hand estimate, rods inside A condensing
//! into A, the A–R crossing as A thins, the mass, energy and boron identity
//! with both exchanges active, and their directions against central
//! differences, in the cell and in the network's colored Jacobian. The cell
//! section mirrors the contract's `pzr.cell` with the committed strict
//! blocks; the roof pressure is the S1 packet's declared operating point.
use leitbild_operating_plant::network::{
    BandReport, MetastableBand, Water,
    properties::{Need, Partials, ThermodynamicPartials},
};
use leitbild_operating_plant::{
    network::{
        CscOut, Failure, Network, Properties, PzrPreparation, RotorState,
        packet::Packet,
        stratified::{
            self as st, Boundary, Case, Cell, Coordinates, ExchangeCase, Heat, HeaterReceipt,
            Parameters, Receipt, bubble_exchange, ranz_marshall, terminal_velocity,
        },
    },
    rotor::{Shaft, SpeedRequest, Support},
    sparse::compare_with_dense,
    thermal::{Saturation, Scalar, WaterPoint},
};
use leitbild_operating_water::{CaloricLinearization, If97};
use serde_json::json;
use std::cell::{Cell as Count, RefCell};

const ROOF_PA: f64 = 14_864_186.805_5;
const LEVEL_M: f64 = 6.0;

fn section() -> String {
    r#"{"index":28,"bottom_m":6.5,"top_m":18.5,"fluidVolume_m3":59.7486726,
 "freeArea":[{"from_m":6.5,"to_m":7.5,"area_m2":4.909522131576614},{"from_m":7.5,"to_m":9.5,"area_m2":4.9195752280681013},{"from_m":9.5,"to_m":18.5,"area_m2":5.0}],
 "ports":[{"id":"PZR.SURGE.MOUTH","kind":"surge","elevation_m":6.5,"face":34,"bore_m":0.3}],
 "taps":[{"id":"PT1","elevation_m":18.5},{"id":"LT.LOW","elevation_m":6.5},{"id":"LT.HIGH","elevation_m":18.5}],
 "heaters":{"bottom_m":6.5,"top_m":9.5,"displacement_m3":0.25132741228718347},
 "stratified":{"withdrawalScale_m":0.30,"admittedPreparationThickness_m":0.30,"inversionExchangeVelocity_m_s":320,"liquidRelaxationTime_s":0.3,"vaporRelaxationTime_s":0.5,"relaxationSensitivity":[0.5,1,2],"bubbleDiameter_m":0.00075,"bubbleExchangeSensitivity":[0.5,1,2],"bubbleExchangeDiameterSensitivity_m":0.0005,"sprayDropDiameter_m":0.003,"dropDiameterSensitivity_m":[0.0015,0.003,0.006],"resolvabilityFactor":1000},
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
    scales[st::ADMITTED_BUBBLE_VOLUME] = 0.5;
    scales[st::ADMITTED_BUBBLE_MASS] = 50.;
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

/// Both bubble stocks and the two liquids' temperatures against
/// `Tsat(p_s)`; `None` keeps a liquid's prepared energy.
#[derive(Clone, Copy)]
struct Stocks {
    bubbles: f64,
    admitted_bubbles: f64,
    resident_excess_k: Option<f64>,
    admitted_excess_k: Option<f64>,
}
/// The prepared values with both stocks in transit with their volumes, and
/// each named liquid at `T = Tsat(p_s) + excess` at its own centroid
/// pressure. The column's pressures follow from masses and volumes alone,
/// so the liquids' energies set their temperatures against this state's own
/// `Tsat(p_s)`.
fn with_stocks(p: &Prepared, stocks: Stocks) -> [f64; st::COORDINATES] {
    let mut v = p.preparation.values;
    let rho = p
        .preparation
        .column
        .interface_saturation
        .vapor
        .density
        .value;
    v[st::BUBBLE_MASS] = stocks.bubbles;
    v[st::BUBBLE_VOLUME] = stocks.bubbles / rho;
    v[st::ADMITTED_BUBBLE_MASS] = stocks.admitted_bubbles;
    v[st::ADMITTED_BUBBLE_VOLUME] = stocks.admitted_bubbles / rho;
    let c = p
        .cell
        .column(&If97, &Coordinates::values(&v), None)
        .unwrap();
    let tsat = c.interface_saturation.temperature.value;
    for (excess, zone, mass, energy) in [
        (
            stocks.resident_excess_k,
            c.resident,
            st::RESIDENT_MASS,
            st::RESIDENT_ENERGY,
        ),
        (
            stocks.admitted_excess_k,
            c.admitted,
            st::ADMITTED_MASS,
            st::ADMITTED_ENERGY,
        ),
    ] {
        if let Some(excess) = excess {
            let u = If97
                .forward(false, zone.pressure.value, tsat + excess)
                .unwrap()
                .internal_energy_j_kg;
            v[energy] = v[mass] * u;
        }
    }
    v
}
/// R at `Tsat(p_s) + excess` with `bubbles` kg in b only.
fn with_bubbles(p: &Prepared, excess_k: f64, bubbles: f64) -> [f64; st::COORDINATES] {
    with_stocks(
        p,
        Stocks {
            bubbles,
            admitted_bubbles: 0.,
            resident_excess_k: Some(excess_k),
            admitted_excess_k: None,
        },
    )
}
/// A at `Tsat(p_s) + excess` with `bubbles` kg in b_A only.
fn with_admitted_bubbles(p: &Prepared, excess_k: f64, bubbles: f64) -> [f64; st::COORDINATES] {
    with_stocks(
        p,
        Stocks {
            bubbles: 0.,
            admitted_bubbles: bubbles,
            resident_excess_k: None,
            admitted_excess_k: Some(excess_k),
        },
    )
}

fn evaluate_with(
    p: &Prepared,
    values: &[f64; st::COORDINATES],
    rate: &[f64; st::COORDINATES],
    receipt: Receipt,
    boundary: &Boundary,
) -> Result<st::Evaluation, Failure> {
    p.cell.residual(
        &If97,
        &Coordinates::values(values),
        &Coordinates::values(rate),
        &[receipt],
        boundary,
        &p.scales,
        None,
    )
}
fn evaluate(
    p: &Prepared,
    values: &[f64; st::COORDINATES],
    rate: &[f64; st::COORDINATES],
    receipt: Receipt,
    heat: Heat,
) -> Result<st::Evaluation, Failure> {
    evaluate_with(
        p,
        values,
        rate,
        receipt,
        &Boundary {
            heat,
            ..Boundary::closed()
        },
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
/// The residual at rest with one coordinate seeded.
fn seeded(p: &Prepared, values: &[f64; st::COORDINATES], j: usize) -> st::Evaluation {
    let mut x = Coordinates::values(values).to_array();
    x[j] = Scalar::new(x[j].value, 1e-3 * p.scales[j]);
    p.cell
        .residual(
            &If97,
            &Coordinates::from_slice(&x).unwrap(),
            &Coordinates::values(&[0.; st::COORDINATES]),
            &[Receipt::zero()],
            &Boundary::closed(),
            &p.scales,
            None,
        )
        .unwrap()
}
/// The maintained-diameter rate per kg, `6 h_L (T_s − T_L)/(ρ_g,sat d h_fg)`,
/// from the public coefficient on a liquid's state.
fn rate_per_kg(d: f64, u: Scalar, liquid: &st::Zone, sat: &Saturation) -> f64 {
    let (h, _) = ranz_marshall(d, u, &liquid.water());
    6. * h.value * (sat.temperature.value - liquid.temperature.value)
        / (sat.vapor.density.value * d * (sat.vapor.enthalpy.value - sat.liquid.enthalpy.value))
}

#[test]
fn the_exchange_is_zero_without_bubbles_and_for_liquid_at_or_above_saturation() {
    let p = prepared();
    let d = p.cell.exchange_diameter_m();
    // The prepared rest state: no bubbles, so nothing condenses or crosses.
    let ev = at_rest(&p, &p.preparation.values);
    let f = &ev.flows;
    for x in [f.bubble_exchange, f.admitted_bubble_exchange] {
        assert_eq!((x.condensation.value, x.area_m2.value), (0., 0.));
    }
    assert_eq!(f.bubble_crossing.value, 0.);
    // Each liquid 2 K below Tsat(p_s) without bubbles: zero, with the linear
    // law's slope along its stock present for the Jacobian. The other
    // factors multiply the zero area.
    for (v, stock, host) in [
        (with_bubbles(&p, -2., 0.), st::BUBBLE_MASS, false),
        (
            with_admitted_bubbles(&p, -2., 0.),
            st::ADMITTED_BUBBLE_MASS,
            true,
        ),
    ] {
        let ev = at_rest(&p, &v);
        let x = if host {
            ev.flows.admitted_bubble_exchange
        } else {
            ev.flows.bubble_exchange
        };
        assert_eq!(x.condensation.value, 0.);
        let zone = if host {
            ev.column.admitted
        } else {
            ev.column.resident
        };
        let expected = rate_per_kg(
            d,
            ev.flows.bubble.velocity,
            &zone,
            &ev.column.interface_saturation,
        );
        let ev = seeded(&p, &v, stock);
        let x = if host {
            ev.flows.admitted_bubble_exchange
        } else {
            ev.flows.bubble_exchange
        };
        let slope = x.condensation.direction / (1e-3 * p.scales[stock]);
        assert!(
            slope > 0. && (slope - expected).abs() <= 1e-12 * expected,
            "{slope} vs {expected}"
        );
    }
    // Both liquids at or above the stocks' saturation: zero value and zero
    // directions, whichever coordinate is seeded. The flashing relaxation
    // takes a liquid's superheat; the two never act together.
    for excess in [1e-3, 0.05, 0.3] {
        let stocks = Stocks {
            bubbles: 40.,
            admitted_bubbles: 5.,
            resident_excess_k: Some(excess),
            admitted_excess_k: Some(excess),
        };
        let v = with_stocks(&p, stocks);
        let ev = at_rest(&p, &v);
        let c = &ev.column;
        let tsat = c.interface_saturation.temperature.value;
        assert!(c.resident.temperature.value > tsat && c.admitted.temperature.value > tsat);
        let f = &ev.flows;
        assert_eq!(f.bubble_exchange.condensation.value, 0., "+{excess} K");
        assert_eq!(f.admitted_bubble_exchange.condensation.value, 0.);
        if excess == 0.3 {
            assert!(f.resident_flashing.value > 0., "R +0.3 K flashes");
        }
        for j in 0..st::COORDINATES {
            let f = seeded(&p, &v, j).flows;
            for x in [f.bubble_exchange, f.admitted_bubble_exchange] {
                let c = x.condensation;
                assert_eq!((c.value, c.direction), (0., 0.), "column {j}");
            }
        }
    }
    // Subcooled liquids: condensation, no flashing.
    let v = with_stocks(
        &p,
        Stocks {
            bubbles: 40.,
            admitted_bubbles: 5.,
            resident_excess_k: Some(-0.5),
            admitted_excess_k: Some(-0.5),
        },
    );
    let f = at_rest(&p, &v).flows;
    assert!(f.bubble_exchange.condensation.value > 0.);
    assert!(f.admitted_bubble_exchange.condensation.value > 0.);
    assert_eq!(
        (f.resident_flashing.value, f.admitted_flashing.value),
        (0., 0.)
    );
    // At Tsat(p_s), within the caloric inverse's bound, each exchange is at
    // most that bound's share; it is linear in the subcooling down to zero,
    // so continuous through saturation.
    for host in [false, true] {
        let stocks = |excess: f64| Stocks {
            bubbles: if host { 0. } else { 40. },
            admitted_bubbles: if host { 40. } else { 0. },
            resident_excess_k: (!host).then_some(excess),
            admitted_excess_k: host.then_some(excess),
        };
        let condensation = |excess: f64| {
            let ev = at_rest(&p, &with_stocks(&p, stocks(excess)));
            let x = if host {
                ev.flows.admitted_bubble_exchange
            } else {
                ev.flows.bubble_exchange
            };
            let zone = if host {
                ev.column.admitted
            } else {
                ev.column.resident
            };
            let gap =
                (ev.column.interface_saturation.temperature.value - zone.temperature.value).abs();
            (x.condensation.value, gap)
        };
        let (at, gap) = condensation(0.);
        assert!(gap < 1e-6, "{gap} K");
        let (per_kelvin, _) = condensation(-1.);
        assert!(at <= 2. * per_kelvin * gap);
        let (small, _) = condensation(-1e-3);
        assert!(
            (small / (1e-3 * per_kelvin) - 1.).abs() < 0.01,
            "{small} against {}",
            1e-3 * per_kelvin
        );
    }
}

/// One shrinking bubble in an unbounded bath at constant subcooling, the
/// lead's hand estimate: `dd/dt = −2 h_L(d) ΔT/(ρ_g h_fg)` with the cell's
/// own Ranz–Marshall coefficient at the bubble's terminal speed `u(d)` (the
/// cell's own drag balance), and `dz/dt = u(d)`. Midpoint quadrature over
/// the diameter; returns the collapse time and rise distance.
fn single_bubble_collapse(
    d0: f64,
    bath: &WaterPoint,
    sat: &Saturation,
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
fn subcooled_liquid_condenses_each_stock_at_the_hand_estimate() {
    let p = prepared();
    // Request 4, K1: at 4.5 K a 0.75 mm bubble collapses in about 0.5 s over
    // about 4 cm; at 0.5 K in about 4.5 s over about 35 cm. The same law
    // condenses b in R and b_A in A, each against its own host's state.
    for host in ["R", "A"] {
        for (subcooling, collapse_s, rise_m) in [(4.5, 0.5, 0.04), (0.5, 4.5, 0.35)] {
            let bubbles = 1.;
            let v = if host == "R" {
                with_bubbles(&p, -subcooling, bubbles)
            } else {
                with_admitted_bubbles(&p, -subcooling, bubbles)
            };
            let ev = at_rest(&p, &v);
            let f = &ev.flows;
            let c = &ev.column;
            let (x, zone, stock) = if host == "R" {
                (&f.bubble_exchange, &c.resident, st::BUBBLE_MASS)
            } else {
                (
                    &f.admitted_bubble_exchange,
                    &c.admitted,
                    st::ADMITTED_BUBBLE_MASS,
                )
            };
            let sat = &c.interface_saturation;
            let dt = sat.temperature.value - zone.temperature.value;
            assert!((dt - subcooling).abs() < 1e-6, "{dt}");
            // Sign: the stock loses W_x to its host, which gains it with
            // h_g,sat(p_s); b's other sink is the rise into g, b_A's the
            // crossing into b.
            let w = x.condensation.value;
            let (hf, hg) = (sat.liquid.enthalpy.value, sat.vapor.enthalpy.value);
            assert!(w > 0. && x.liquid_heat_w.value < 0.);
            let other = if host == "R" {
                f.bubble_rise.value
            } else {
                f.bubble_crossing.value
            };
            assert!(
                (f.sources[stock].value + other + w).abs() <= 1e-12 * w,
                "{host}: the stock's sinks"
            );
            assert!((x.liquid_heat_w.value + w * (hg - hf)).abs() <= 1e-12 * w * (hg - hf));
            // The law from its public pieces: A_i h_L (T_s - T_L) / h_fg.
            let d = p.cell.exchange_diameter_m();
            assert_eq!(x.diameter_m, d);
            let (h, re) = ranz_marshall(d, f.bubble.velocity, &zone.water());
            let area = 6. * bubbles / (sat.vapor.density.value * d);
            let expected = area * h.value * dt / (hg - hf);
            assert!((w - expected).abs() <= 1e-12 * w, "{w} vs {expected}");
            assert_eq!(
                (x.liquid_coefficient.value, x.reynolds.value),
                (h.value, re.value)
            );
            let again = bubble_exchange(
                d,
                p.cell.exchange().factor,
                s(bubbles),
                f.bubble.velocity,
                zone,
                sat,
            );
            assert_eq!(again.condensation.value.to_bits(), w.to_bits());
            // The maintained-diameter rate, and the single-bubble estimate
            // that starts at the same coefficient: dd/dt(0) = d W_x/(3 M).
            let rate = w / bubbles;
            let shrink = 2. * h.value * dt / (sat.vapor.density.value * (hg - hf));
            assert!((shrink - d * rate / 3.).abs() <= 1e-12 * shrink);
            let (time, rise) = single_bubble_collapse(d, &zone.water(), sat, dt);
            println!(
                "{host} {subcooling} K: W_x/M = {rate:.4} 1/s (e-folding {:.3} s), u_b = {:.4} m/s, Re_x = {:.1}, We = {:.3}, h_L = {:.0} W/(m2 K); one bubble collapses in {time:.3} s over {:.2} cm",
                1. / rate,
                f.bubble.velocity.value,
                re.value,
                x.weber.value,
                h.value,
                100. * rise
            );
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
}

/// The normal bank's span, 6.5–7.5 m, wets A over its lowest 0.30 m and R
/// above: a receipt with heat and wall-born vapor on both contacts.
fn normal_bank(vapor_a: f64, vapor_r: f64) -> HeaterReceipt {
    HeaterReceipt {
        bottom_m: 6.5,
        top_m: 7.5,
        wet_heat_w: [s(1.2e5), s(2.8e5)],
        wet_vapor_kg_s: [s(vapor_a), s(vapor_r)],
        exposed_heat_w: s(0.),
        condensate_kg_s: s(0.),
        condensate_enthalpy_j_kg: s(0.),
    }
}

#[test]
fn rods_inside_a_condense_into_a() {
    let p = prepared();
    let (vapor_a, vapor_r) = (0.08, 0.19);
    for subcooling in [1., 4.5] {
        let bubbles = 1.;
        let v = with_stocks(
            &p,
            Stocks {
                bubbles,
                admitted_bubbles: bubbles,
                resident_excess_k: Some(-subcooling),
                admitted_excess_k: Some(-subcooling),
            },
        );
        let boundary = Boundary {
            heaters: vec![normal_bank(vapor_a, vapor_r)],
            ..Boundary::closed()
        };
        let ev = evaluate_with(&p, &v, &[0.; st::COORDINATES], Receipt::zero(), &boundary).unwrap();
        let (f, c) = (&ev.flows, &ev.column);
        let (wa, wr) = (
            f.admitted_bubble_exchange.condensation.value,
            f.bubble_exchange.condensation.value,
        );
        let crossing = f.bubble_crossing.value;
        assert_eq!(f.admitted_flashing.value, 0.);
        // A's rod vapor is born into b_A, R's into b: the stocks' sources.
        let tight = |a: f64, b: f64| (a - b).abs() <= 1e-12 * a.abs().max(b.abs()).max(1.);
        assert!(tight(
            f.sources[st::ADMITTED_BUBBLE_MASS].value,
            vapor_a - crossing - wa
        ));
        assert!(tight(
            f.sources[st::BUBBLE_MASS].value,
            vapor_r + crossing - f.bubble_rise.value - wr
        ));
        // A pays its rod vapor and receives b_A's condensate; R receives
        // nothing of A's vapor but what crosses into its stock (beside its
        // own free-surface exchange).
        assert!(tight(f.sources[st::ADMITTED_MASS].value, -vapor_a + wa));
        assert!(tight(
            f.sources[st::RESIDENT_MASS].value,
            -vapor_r + wr + f.interface.liquid.mass.value
        ));
        // The crossing is the stock's rise over A's region thickness, which
        // counts b_A's own volume.
        let thickness = c.boundary_elevation.value - c.bottom_m;
        assert!(tight(
            crossing,
            bubbles * f.bubble.velocity.value / thickness
        ));
        // Quasi-steady b_A, M_bA' = 0: A condenses the share λ_A/(λ_A + u_b/δ)
        // of its own births, both rates linear in the stock.
        let lambda = rate_per_kg(
            p.cell.exchange_diameter_m(),
            f.bubble.velocity,
            &c.admitted,
            &c.interface_saturation,
        );
        assert!(tight(wa / bubbles, lambda));
        let leave = crossing / bubbles;
        let condensed_in_a = lambda / (lambda + leave);
        // A plug of bubbles crossing δ at u_b would keep exp(−λ δ/u_b).
        let plug = 1. - (-lambda * thickness / f.bubble.velocity.value).exp();
        println!(
            "{subcooling} K: A condenses {:.1}% of its rod vapor at quasi-steady b_A (a plug crossing would condense {:.1}%); λ_A = {lambda:.3} 1/s, u_b/δ_A = {leave:.3} 1/s, δ_A = {thickness:.4} m",
            100. * condensed_in_a,
            100. * plug
        );
        assert!(condensed_in_a > if subcooling > 2. { 0.9 } else { 0.6 });
    }
}

#[test]
fn the_crossing_stays_finite_and_continuous_as_a_thins() {
    let p = prepared();
    let base = with_admitted_bubbles(&p, -1., 1.);
    let mut previous: Option<(f64, f64)> = None;
    for thinning in [1., 0.1, 0.01, 1e-3, 1e-4, 1e-6] {
        // A's liquid shrinks at its own state; the stock stays 1 kg.
        let mut v = base;
        for i in [
            st::ADMITTED_VOLUME,
            st::ADMITTED_MASS,
            st::ADMITTED_ENERGY,
            st::ADMITTED_BORON,
        ] {
            v[i] *= thinning;
        }
        let ev = at_rest(&p, &v);
        assert!(ev.rows.iter().all(|r| r.value.is_finite()));
        let (f, c) = (&ev.flows, &ev.column);
        let u = f.bubble.velocity.value;
        let area = p.cell.free_area(c.bottom_m);
        // A's region is still inside the first band, so its thickness is
        // (V_A + V_bA)/A_0, and the crossing is the stock's own density
        // M_bA/V_bA times A_0 u_b times A's void fraction: bounded by that
        // product however thin the liquid is.
        let (mb, vb) = (v[st::ADMITTED_BUBBLE_MASS], v[st::ADMITTED_BUBBLE_VOLUME]);
        let void = vb / (v[st::ADMITTED_VOLUME] + vb);
        let bound = mb / vb * area * u;
        let crossing = f.bubble_crossing.value;
        assert!(
            (crossing - bound * void).abs() <= 1e-12 * bound,
            "{crossing} vs {}",
            bound * void
        );
        assert!(crossing < bound);
        // The share of A's births condensed in A falls continuously toward
        // zero as A thins: its births pass to b, with no switch.
        let condensed = f.admitted_bubble_exchange.condensation.value;
        let share = condensed / (condensed + crossing);
        if let Some((last_crossing, last_share)) = previous {
            assert!(crossing > last_crossing && share < last_share);
        }
        println!(
            "A x{thinning:e}: δ_A = {:.3e} m, void {void:.4}, crossing {crossing:.3} kg/s (bound {bound:.2}), condensed in A {:.2}%",
            c.boundary_elevation.value - c.bottom_m,
            100. * share
        );
        previous = Some((crossing, share));
    }
}

#[test]
fn sensitivities_scale_the_exchange_and_change_only_its_diameter() {
    let mut rates = Vec::new();
    for (name, exchange) in cases() {
        let prepared = prepared_with(exchange);
        let v = with_stocks(
            &prepared,
            Stocks {
                bubbles: 5.,
                admitted_bubbles: 2.,
                resident_excess_k: Some(-1.),
                admitted_excess_k: Some(-1.),
            },
        );
        let ev = at_rest(&prepared, &v);
        let f = ev.flows;
        // Drag always at the bubble diameter: the rise and crossing are the
        // nominal ones.
        assert_eq!(prepared.cell.case().bubble_diameter_m, 0.00075, "{name}");
        rates.push((name, f));
    }
    let (_, nominal) = rates[0];
    for (name, f) in &rates[1..] {
        assert_eq!(f.bubble_rise.value, nominal.bubble_rise.value, "{name}");
        assert_eq!(f.bubble_crossing.value, nominal.bubble_crossing.value);
        for (x, x0) in [
            (f.bubble_exchange, nominal.bubble_exchange),
            (f.admitted_bubble_exchange, nominal.admitted_bubble_exchange),
        ] {
            let ratio = x.condensation.value / x0.condensation.value;
            match *name {
                "exchange x0.5" => assert!((ratio - 0.5).abs() <= 1e-14),
                "exchange x2" => assert!((ratio - 2.).abs() <= 1e-14),
                _ => {
                    // The earlier selection's 0.5 mm: larger area per mass
                    // and a smaller Reynolds number at the same rise speed.
                    assert_eq!(x.diameter_m, 0.0005);
                    let area = x.area_m2.value / x0.area_m2.value;
                    assert!((area - 1.5).abs() <= 1e-14, "{area}");
                    assert!(x.reynolds.value < x0.reynolds.value);
                    assert!(ratio > 1.5, "{ratio}");
                }
            }
            println!("{name}: W_x {} x nominal", ratio);
        }
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
    // The exchange's keys are required, and the dropped vapor-side
    // coefficient is refused, not read.
    let missing = section().replace(r#""bubbleExchangeSensitivity":[0.5,1,2],"#, "");
    assert!(serde_json::from_str::<Parameters>(&missing).is_err());
    let dropped = section().replace(
        r#""bubbleDiameter_m":0.00075,"#,
        r#""bubbleDiameter_m":0.00075,"bubbleVaporCoefficient_W_m2K":1000,"#,
    );
    assert!(serde_json::from_str::<Parameters>(&dropped).is_err());
}

/// An active state with both exchanges on: R 1.5 K and A 1.2 K below
/// Tsat(p_s), the vapor slightly superheated, every transit stock present
/// and perturbed volumes.
fn active(p: &Prepared) -> [f64; st::COORDINATES] {
    let mut v = with_stocks(
        p,
        Stocks {
            bubbles: 40.,
            admitted_bubbles: 3.,
            resident_excess_k: Some(-1.5),
            admitted_excess_k: Some(-1.2),
        },
    );
    let c = &p.preparation.column;
    let t = c.interface_saturation.temperature.value;
    let u = If97
        .forward(true, c.vapor.pressure.value, t + 0.4)
        .unwrap()
        .internal_energy_j_kg;
    v[st::VAPOR_ENERGY] = v[st::VAPOR_MASS] * u;
    v[st::DROP_MASS] = 15.;
    v[st::DROP_VOLUME] = 0.026;
    v[st::DROP_BORON] = 0.012;
    v[st::VAPOR_VOLUME] -= 0.35;
    v[st::RESIDENT_VOLUME] -= 0.07;
    v[st::ADMITTED_VOLUME] += 0.01;
    v[st::ADMITTED_BUBBLE_VOLUME] += 0.002;
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
    r[st::ADMITTED_BUBBLE_VOLUME] = -0.001;
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
    r[st::ADMITTED_BUBBLE_MASS] = -0.2;
    r
}

#[test]
fn mass_energy_and_boron_close_at_roundoff_with_both_exchanges_active() {
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
            let boundary = Boundary {
                heat,
                heaters: vec![normal_bank(0.08, 0.19)],
                ..Boundary::closed()
            };
            let ev = evaluate_with(&p, &v, &rate, receipt, &boundary).unwrap();
            let f = &ev.flows;
            for (what, q) in [
                ("R exchange", f.bubble_exchange.condensation),
                ("A exchange", f.admitted_bubble_exchange.condensation),
                ("crossing", f.bubble_crossing),
                ("rise", f.bubble_rise),
                ("fall", f.drop_fall),
                ("drift b", f.transit_drift[0]),
                ("drift b_A", f.admitted_transit_drift),
            ] {
                assert!(q.value.abs() > 0., "{name}: {what} inactive");
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
            let expected_energy = receipt.enthalpy.value + 1.3e4 + 2.4e5 + 7.7e4 + 1.2e5 + 2.8e5;
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
            // The latent heat enters each host once: the condensate carries
            // h_g,sat, i.e. its sensible share and -Q_L.
            let (hf, hg) = (sat.liquid.enthalpy.value, sat.vapor.enthalpy.value);
            for x in [f.bubble_exchange, f.admitted_bubble_exchange] {
                let w = x.condensation.value;
                assert!((w * hg - (w * hf - x.liquid_heat_w.value)).abs() <= 1e-12 * w * hg);
            }
        }
    }
}

#[test]
fn seeded_directions_match_central_differences_with_both_exchanges_active() {
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
    let run_with = |properties: &Offset, y: &[f64], yp: &[f64], seed: Option<&[f64]>| {
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
                properties,
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
    let run = |y: &[f64], yp: &[f64], seed: Option<&[f64]>| run_with(&Offset::none(), y, yp, seed);
    let base = run(&y, &yp, None);
    assert!(base.flows.bubble_exchange.condensation.value > 1.);
    assert!(base.flows.admitted_bubble_exchange.condensation.value > 0.1);
    let flows = |e: &st::Evaluation| {
        [
            e.flows.bubble_exchange.condensation,
            e.flows.admitted_bubble_exchange.condensation,
            e.flows.bubble_crossing,
        ]
    };
    let entries = |e: &st::Evaluation| -> Vec<f64> {
        e.rows
            .iter()
            .map(|r| r.value)
            .chain(flows(e).iter().map(|q| q.value))
            .collect()
    };
    // The caloric inverse returns the exact state of a target within its
    // declared tolerance tau_k of the requested one (water-ffi `converged`),
    // so each evaluated entry carries at most nu_i = sum_k |dF_i/du_k| tau_k
    // over the evaluation's inverses k, to first order. dF_i/du_k is the
    // entry's response to offsetting inverse k's target alone, by a central
    // difference of 1e4 tau_k (its own inversion noise is 1e-4 of it).
    let probe = Offset::none();
    run_with(&probe, &y, &yp, None);
    let tolerances = probe.tolerances.borrow().clone();
    assert!(!tolerances.is_empty(), "the cell inverts its zones");
    let mut noise = [0.; st::COORDINATES + 3];
    for (k, tau) in tolerances.iter().enumerate() {
        let delta = 1e4 * tau;
        let plus = entries(&run_with(&Offset::at(k, delta), &y, &yp, None));
        let minus = entries(&run_with(&Offset::at(k, -delta), &y, &yp, None));
        for (n, (a, b)) in noise.iter_mut().zip(plus.iter().zip(&minus)) {
            *n += (a - b).abs() / (2. * delta) * tau;
        }
    }
    // Every unit column of the dense stage Jacobian dF/dy + cj dF/dy', and
    // the two exchanges and the crossing alone, against two central
    // differences.
    let mut worst: f64 = 0.;
    let mut tightest = (0., 0, 0, 0., 0., 0., 0.);
    let mut beyond_floor = 0;
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
            let mut out: Vec<f64> = (0..st::COORDINATES)
                .map(|i| (plus.rows[i].value - minus.rows[i].value) / (2. * h))
                .collect();
            out.extend(
                flows(&plus)
                    .iter()
                    .zip(flows(&minus))
                    .map(|(a, b)| (a.value - b.value) / (2. * h)),
            );
            out
        };
        let (coarse_step, fine_step) = (0.1, 0.05);
        let (coarse, fine) = (difference(coarse_step), difference(fine_step));
        let analytic: Vec<f64> = seeded
            .rows
            .iter()
            .map(|r| r.direction)
            .chain(flows(&seeded).iter().map(|q| q.direction))
            .collect();
        // The bound: the difference's truncation (three spreads), a 2e-6
        // relative allowance, the floating-point floor of the evaluation
        // (1e-12 of a row: 1e-9 of the 1e-3 seed; a flow's 1e-9 of its own
        // size) and the fine difference's inversion noise: each of its two
        // evaluations is within nu_i of the exact entry, so their central
        // difference is within nu_i / step of the exact difference.
        let flow_sizes: Vec<f64> = flows(&base).iter().map(|q| q.value.abs()).collect();
        for (i, an) in analytic.iter().enumerate() {
            let fd = fine[i];
            let spread = (coarse[i] - fine[i]).abs();
            let size = an.abs().max(fd.abs()).max(1e-12);
            let error = (an - fd).abs();
            let floor = if i < st::COORDINATES {
                1e-12
            } else {
                1e-9 * flow_sizes[i - st::COORDINATES]
            };
            let inversion = noise[i] / fine_step;
            if size > 1e-9 {
                worst = worst.max(error / size);
            }
            let bound = 3. * spread + 2e-6 * size + floor + inversion;
            if error / bound > tightest.0 {
                tightest = (error / bound, j, i, error, spread, floor, inversion);
            }
            if error > 3. * spread + 2e-6 * size + floor {
                beyond_floor += 1;
                println!(
                    "column {j} entry {i} within the inversion noise only: error {error:e}, spread {spread:e}, inversion noise {inversion:e}"
                );
            }
            assert!(
                error <= bound,
                "column {j} entry {i}: analytic {an:e}, difference {fd:e}, spread {spread:e}, inversion noise {inversion:e}"
            );
        }
    }
    println!("worst relative direction error of entries above 1e-9: {worst:e}");
    println!(
        "inverses per evaluation {}, tolerances {tolerances:?}; tightest error/bound {:e} at column {} entry {} (error {:e}, spread {:e}, floor {:e}, inversion noise {:e}); entries beyond the bound without inversion noise: {beyond_floor}",
        tolerances.len(),
        tightest.0,
        tightest.1,
        tightest.2,
        tightest.3,
        tightest.4,
        tightest.5,
        tightest.6
    );
}

/// If97 with the target of its `k`-th caloric inverse (in call order)
/// offset by `offset`, recording every inverse's declared tolerance
/// `2e-12 max(|u|, u_T T, 1)` at the returned state (water-ffi
/// `converged`). Every other query, and every default of the boundary, is
/// If97's own.
struct Offset {
    k: Option<usize>,
    offset: f64,
    calls: Count<usize>,
    tolerances: RefCell<Vec<f64>>,
}
impl Offset {
    fn none() -> Self {
        Self {
            k: None,
            offset: 0.,
            calls: Count::new(0),
            tolerances: RefCell::new(Vec::new()),
        }
    }
    fn at(k: usize, offset: f64) -> Self {
        Self {
            k: Some(k),
            offset,
            ..Self::none()
        }
    }
}
impl Properties for Offset {
    type Caloric = CaloricLinearization;
    fn forward(&self, vapor: bool, p: f64, t: f64) -> Result<Water, String> {
        If97.forward(vapor, p, t)
    }
    fn caloric(
        &self,
        vapor: bool,
        p: f64,
        target: f64,
        enthalpy: bool,
    ) -> Result<CaloricLinearization, String> {
        self.caloric_for(vapor, p, target, enthalpy, Need::Complete)
    }
    fn caloric_for(
        &self,
        vapor: bool,
        p: f64,
        target: f64,
        enthalpy: bool,
        need: Need,
    ) -> Result<CaloricLinearization, String> {
        let call = self.calls.get();
        self.calls.set(call + 1);
        let shifted = if self.k == Some(call) {
            target + self.offset
        } else {
            target
        };
        let point = If97.caloric_for(vapor, p, shifted, enthalpy, need)?;
        let w = If97.values(&point);
        let ut = if enthalpy {
            w.cp_j_kg_k
        } else {
            w.cp_j_kg_k - w.pressure_pa * w.expansion_per_k / w.density_kg_m3
        };
        self.tolerances
            .borrow_mut()
            .push(2e-12 * target.abs().max(ut * w.temperature_k).max(1.));
        Ok(point)
    }
    fn complete(&self, point: &CaloricLinearization) -> Result<CaloricLinearization, String> {
        If97.complete(point)
    }
    fn values(&self, point: &CaloricLinearization) -> Water {
        If97.values(point)
    }
    fn partials(&self, point: &CaloricLinearization) -> Result<Partials, String> {
        If97.partials(point)
    }
    fn thermodynamic_partials(
        &self,
        point: &CaloricLinearization,
    ) -> Result<ThermodynamicPartials, String> {
        If97.thermodynamic_partials(point)
    }
    fn direction(&self, point: &CaloricLinearization, dp: f64, de: f64) -> Result<Water, String> {
        If97.direction(point, dp, de)
    }
    fn saturation(&self, pressure: Scalar) -> Result<Saturation, String> {
        Properties::saturation(&If97, pressure)
    }
    fn saturation_caloric(&self, pressure: Scalar) -> Result<Saturation, String> {
        If97.saturation_caloric(pressure)
    }
    fn metastable_band(&self) -> Result<MetastableBand, String> {
        If97.metastable_band()
    }
    fn band(&self, point: &CaloricLinearization) -> BandReport {
        If97.band(point)
    }
}

/// The fixture's stratified block against a wiki checkout's strict block,
/// which the exchange's keys extend.
#[test]
#[ignore = "requires LD01_WIKI_DIR, a Leitbild wiki checkout"]
fn the_embedded_stratified_block_equals_the_wiki_strict_block() {
    let root = std::env::var_os("LD01_WIKI_DIR").expect("LD01_WIKI_DIR");
    let page = std::fs::read_to_string(std::path::Path::new(&root).join(
        "world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressurizer-thermal-state.md",
    ))
    .unwrap();
    let fence = "```ld01-pzr-stratified\n";
    let start = page.find(fence).expect("ld01-pzr-stratified") + fence.len();
    let end = start + page[start..].find("```").unwrap();
    let wiki: serde_json::Value = serde_json::from_str(&page[start..end]).unwrap();
    let section: serde_json::Value = serde_json::from_str(&section()).unwrap();
    assert_eq!(section["stratified"], wiki);
}

// ---- The network with the actual S1 packet (opt-in). ----

const PZR: PzrPreparation = PzrPreparation {
    pressure_tolerance_pa: 1e-6,
    max_passes: 50,
};

/// The network from the packet with its rotors running, and a state with
/// both exchanges active: the prepared coordinates with 20 kg of bubbles in R
/// and 5 kg in A, both liquids 1 K below this state's own `Tsat(p_s)`, a
/// small insurge on the port face and moving PZR volumes and roof pressure.
fn network_with_bubbles() -> (Network<If97>, Vec<f64>, Vec<f64>, String) {
    let path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET").unwrap();
    let packet: Packet = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let (mut network, prepared) = Network::new(&packet, If97, &PZR).unwrap();
    for r in 0..network.rotor_count() {
        network.set_rotor_state(
            r,
            RotorState {
                support: Support::Supported(SpeedRequest::Nominal),
                shaft: Shaft::Free,
            },
        );
    }
    network
        .select_leading_receipts(&prepared.y, &prepared.yp)
        .unwrap();
    let base = network.pzr.base;
    let scales = network.scales()[network.pzr.coordinates()].to_vec();
    let scale = |o: usize| scales[o];
    let mut y = prepared.y.clone();
    let mut yp = prepared.yp.clone();
    let sat = network
        .pzr_column()
        .unwrap()
        .interface_saturation
        .vapor
        .density
        .value;
    let (bubbles, admitted_bubbles) = (20., 5.);
    y[base + st::BUBBLE_MASS] = bubbles / scale(st::BUBBLE_MASS);
    y[base + st::BUBBLE_VOLUME] = bubbles / sat / scale(st::BUBBLE_VOLUME);
    y[base + st::ADMITTED_BUBBLE_MASS] = admitted_bubbles / scale(st::ADMITTED_BUBBLE_MASS);
    y[base + st::ADMITTED_BUBBLE_VOLUME] =
        admitted_bubbles / sat / scale(st::ADMITTED_BUBBLE_VOLUME);
    let port = network
        .face_layout
        .iter()
        .find(|l| l.face == network.pzr.port_face && l.phase == 0)
        .unwrap()
        .index;
    y[port] = 0.01;
    for (o, rate) in [
        (st::ROOF_PRESSURE, 1e3),
        (st::VAPOR_VOLUME, -0.01),
        (st::ADMITTED_VOLUME, 0.002),
        (st::RESIDENT_VOLUME, 0.008),
    ] {
        yp[base + o] = rate / scale(o);
    }
    network.evaluate(0., &y, &yp, None, 0., None).unwrap();
    let c = *network.pzr_column().unwrap();
    for (zone, energy) in [
        (c.resident, st::RESIDENT_ENERGY),
        (c.admitted, st::ADMITTED_ENERGY),
    ] {
        let u = If97
            .forward(
                false,
                zone.pressure.value,
                c.interface_saturation.temperature.value - 1.,
            )
            .unwrap()
            .internal_energy_j_kg;
        y[base + energy] = zone.mass.value * u / scale(energy);
    }
    network.evaluate(0., &y, &yp, None, 0., None).unwrap();
    let f = &network.pzr_evaluation().unwrap().flows;
    assert!(f.bubble_exchange.condensation.value > 1., "{f:?}");
    assert!(f.admitted_bubble_exchange.condensation.value > 0.1, "{f:?}");
    (network, y, yp, path)
}

#[test]
#[ignore = "requires the actual S1 packet and maintained IF97"]
fn the_colored_jacobian_matches_central_differences_with_the_exchange_active() {
    let (mut network, y, yp, path) = network_with_bubbles();
    let n = y.len();
    let cj = 2.1;
    let structure = network.sparse_jacobian().unwrap();
    let mut values = vec![0.; structure.pattern.nonzeros()];
    network
        .jacobian_colored(0., cj, &y, &yp, &structure, &mut values)
        .unwrap();
    // The production colored assembly is the dense seeded one, bit for bit.
    let (mut dense, mut rows, mut pointers) =
        (vec![0.; n * n], vec![0i64; n * n], vec![0i64; n + 1]);
    network
        .jacobian_dense(
            0.,
            cj,
            &y,
            &yp,
            CscOut {
                data: &mut dense,
                rows: &mut rows,
                pointers: &mut pointers,
            },
        )
        .unwrap();
    let bitwise = compare_with_dense(&structure.pattern, &values, &dense).unwrap();
    assert!(bitwise.is_bitwise_exact(), "{bitwise:?}");
    // Every row of the PZR block's columns and the port face's liquid
    // impulse against two central differences of the network residual.
    let port = network
        .face_layout
        .iter()
        .find(|l| l.face == network.pzr.port_face && l.phase == 0)
        .unwrap()
        .index;
    let columns: Vec<usize> = network.pzr.coordinates().chain([port]).collect();
    let mut residual = |y: &[f64], yp: &[f64]| -> Vec<f64> {
        network.evaluate(0., y, yp, None, 0., None).unwrap();
        network.rows().iter().map(|r| r.value).collect()
    };
    let (mut worst, mut checked) = (0_f64, 0usize);
    for &j in &columns {
        let mut difference = |h: f64| {
            let shift = |sign: f64| {
                let mut ys = y.clone();
                let mut yps = yp.clone();
                ys[j] += sign * h;
                yps[j] += sign * h * cj;
                (ys, yps)
            };
            let (plus, minus) = (shift(1.), shift(-1.));
            let (a, b) = (residual(&plus.0, &plus.1), residual(&minus.0, &minus.1));
            a.iter()
                .zip(&b)
                .map(|(p, m)| (p - m) / (2. * h))
                .collect::<Vec<f64>>()
        };
        let (coarse, fine) = (difference(1e-4), difference(5e-5));
        for i in 0..n {
            let an = structure.pattern.position(i, j).map_or(0., |k| values[k]);
            let fd = fine[i];
            let spread = (coarse[i] - fine[i]).abs();
            let size = an.abs().max(fd.abs());
            let error = (an - fd).abs();
            if size > 1e-6 {
                worst = worst.max(error / size);
            }
            checked += 1;
            assert!(
                error <= 3. * spread + 2e-6 * size + 1e-9,
                "row {i} column {j}: colored {an:e}, difference {fd:e}, spread {spread:e}"
            );
        }
    }
    println!(
        "{}",
        json!({"kind":"colored-jacobian-against-central-differences-with-the-bulk-exchange","packet":path,"unknowns":n,"columns":columns.len(),"entries_checked":checked,"worst_relative_error_above_1e-6":worst,"colors":structure.coloring.count()})
    );
}

#[test]
#[ignore = "requires the actual S1 packet and maintained IF97"]
fn the_network_energy_pairs_with_the_exchange_active() {
    let (network, y, yp, path) = network_with_bubbles();
    let evaluation = network.pzr_evaluation().unwrap();
    let b = &evaluation.balance;
    assert!(
        (b.energy_w.value - b.receipt_energy_w.value).abs()
            <= 1e-12 * b.receipt_energy_w.value.abs().max(1e10)
    );
    assert!((b.mass_kg_s.value - b.receipt_mass_kg_s.value).abs() <= 1e-12 * 1e3);
    let budget = network.current_budget(&y, &yp);
    let fluid = budget["fluid_energy_minus_shaft_w"].as_f64().unwrap();
    let terms = budget["fluid_energy_receipt_abs_sum_w"].as_f64().unwrap();
    assert!(fluid.abs() <= 1e-9 * (1. + terms), "{budget}");
    println!(
        "{}",
        json!({"kind":"network-energy-pairing-with-the-bulk-exchange","packet":path,"condensation_kg_s":[evaluation.flows.bubble_exchange.condensation.value,evaluation.flows.admitted_bubble_exchange.condensation.value],"crossing_kg_s":evaluation.flows.bubble_crossing.value,"fluid_energy_minus_shaft_w":fluid,"terms_abs_w":terms,"pzr":budget["pzr"]})
    );
}

#[cfg(target_os = "macos")]
mod cost {
    #[repr(C)]
    struct Timespec {
        seconds: i64,
        nanoseconds: i64,
    }
    unsafe extern "C" {
        fn clock_gettime(clock: i32, out: *mut Timespec) -> i32;
        fn pthread_set_qos_class_self_np(class: u32, priority: i32) -> i32;
    }
    /// CLOCK_THREAD_CPUTIME_ID on macOS.
    pub fn thread_cpu_s() -> f64 {
        let mut t = Timespec {
            seconds: 0,
            nanoseconds: 0,
        };
        // SAFETY: one live stack Timespec matching the C layout; the C
        // library writes it and keeps no pointer.
        let status = unsafe { clock_gettime(16, &mut t) };
        assert_eq!(status, 0, "thread CPU clock unavailable");
        t.seconds as f64 + t.nanoseconds as f64 * 1e-9
    }
    /// QOS_CLASS_USER_INTERACTIVE, so that core placement does not enter.
    pub fn prefer_performance_core() {
        // SAFETY: plain scalar arguments; affects only this thread's
        // scheduling.
        let status = unsafe { pthread_set_qos_class_self_np(0x21, 0) };
        assert_eq!(status, 0, "thread QoS unavailable");
    }
}

/// Residual cost on the S1 packet, a report only: thread CPU per network
/// residual at the prepared state and at a PZR state with 5 kg of bubbles in
/// R subcooled by 1 K below `Tsat(p_s)`, best of five batches of 2000 calls.
#[cfg(target_os = "macos")]
#[test]
#[ignore = "cost report only; requires the S1 packet and maintained IF97"]
fn s1_packet_residual_cost_report() {
    cost::prefer_performance_core();
    let path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET").unwrap();
    let bytes = std::fs::read(&path).unwrap();
    let packet: Packet = serde_json::from_slice(&bytes).unwrap();
    let (mut network, prepared) = Network::new(&packet, If97, &PZR).unwrap();
    for r in 0..network.rotor_count() {
        network.set_rotor_state(
            r,
            RotorState {
                support: Support::Supported(SpeedRequest::Nominal),
                shaft: Shaft::Free,
            },
        );
    }
    network
        .select_leading_receipts(&prepared.y, &prepared.yp)
        .unwrap();
    network
        .evaluate(0., &prepared.y, &prepared.yp, None, 0., None)
        .unwrap();
    let column = *network.pzr_column().unwrap();
    let base = network.pzr.base;
    let scale = |o: usize| network.scales()[base + o];
    let mut active = prepared.y.clone();
    let tsat = column.interface_saturation.temperature.value;
    let resident = column.resident;
    let u = If97
        .forward(false, resident.pressure.value, tsat - 1.)
        .unwrap()
        .internal_energy_j_kg;
    active[base + st::RESIDENT_ENERGY] = resident.mass.value * u / scale(st::RESIDENT_ENERGY);
    let bubbles = 5.;
    active[base + st::BUBBLE_MASS] = bubbles / scale(st::BUBBLE_MASS);
    active[base + st::BUBBLE_VOLUME] =
        bubbles / column.interface_saturation.vapor.density.value / scale(st::BUBBLE_VOLUME);
    let mut report = Vec::new();
    for (name, y) in [
        ("prepared", &prepared.y),
        ("bubbles in subcooled R", &active),
    ] {
        let mut best = f64::INFINITY;
        for _ in 0..5 {
            let started = cost::thread_cpu_s();
            for _ in 0..2000 {
                network
                    .evaluate(0., y, &prepared.yp, None, 0., None)
                    .unwrap();
            }
            best = best.min((cost::thread_cpu_s() - started) / 2000.);
        }
        report.push(json!({"state":name,"residual_us":1e6*best}));
    }
    println!(
        "{}",
        json!({"kind":"s1-packet-residual-cost-NOT-EVIDENCE","clock":"CLOCK_THREAD_CPUTIME_ID","packet":path,"unknowns":network.dimension(),"batches":5,"calls_per_batch":2000,"states":report})
    );
}
