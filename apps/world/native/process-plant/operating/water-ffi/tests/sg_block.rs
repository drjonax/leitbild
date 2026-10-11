//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-generation/thermodynamics.md#s2-secondary-block
//! The S2 SG secondary block on maintained IF97, at zero time: preparation
//! and derivations against their owners, the mass and energy identity of
//! every row, the declared structure against seeded and differenced
//! Jacobians, and the cost per evaluation. NOT S2 evidence: no trajectory.
//! Opt-in: `LD01_OPERATING_SG_SECTION` and `LD01_OPERATING_SG_PROBE` name
//! the compiled sections (`reference-design-operating-sg.ts`).
mod sg_harness;

use leitbild_operating_plant::{
    joined::block::{Command, Coordinates, Secondary, SecondaryView},
    sg::{Branch, Secondaries, Valve, chart, secondary},
    sparse,
    thermal::{Scalar, WaterProperties},
};
use leitbild_operating_water::If97;
use serde_json::json;
use sg_harness::{Counted, Heat, Standalone, cpu, held_ports, prepared_stocks, probe, section};

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn rel(a: f64, b: f64) -> f64 {
    (a - b).abs() / b.abs()
}

/// A nonsteady two-phase state with lifts on both branches: SG pressure
/// 6.9 MPa, liquid 72.8 m³ on the chart, lifts 0.35 (ascending) and 0.8
/// (descending), metal across the segments. Synthetic, not a plant state.
fn lifted<P: leitbild_operating_plant::sg::Properties>(sys: &mut Standalone<P>, y: &mut [f64]) {
    let sat = WaterProperties::saturation(&If97, s(6.9e6)).unwrap();
    let n_sg = sys.secondary.steam_generators().len();
    for k in 0..n_sg {
        let g = sys.secondary.steam_generators()[k].clone();
        let (m, u) = chart(g.volume_m3, s(72.8), s(6.9e6), &sat);
        let b = g.base;
        let sc = &sys.scales;
        y[b] = m.value / sc[b];
        y[b + 1] = u.value / sc[b + 1];
        y[b + 2] = 6.9e6 / sc[b + 2];
        y[b + 3] = 72.8 / sc[b + 3];
        y[b + 4] = 0.35;
        y[b + 5] = 0.8;
        sys.secondary
            .set_valve(k, 0, Valve::open(Branch::Ascending), 6.9e6, 0.35)
            .unwrap();
        sys.secondary
            .set_valve(k, 1, Valve::open(Branch::Descending), 6.9e6, 0.8)
            .unwrap();
        for i in 0..sys.segments.len() {
            let m = sys.secondary_len + k * sys.segments.len() + i;
            let t = 558.5 + 0.4 * i as f64 + 0.1 * k as f64;
            y[m] = sys.segments[i].capacity_j_k * (t - 273.15) / sys.scales[m];
        }
    }
}

#[test]
#[ignore = "requires LD01_OPERATING_SG_SECTION and LD01_OPERATING_SG_PROBE"]
fn preparation_and_derivations_reproduce_their_owners() {
    let (section, probe) = (section(), probe());
    let stocks = prepared_stocks(&If97, &section, &probe);
    // model/operating-hot-reference.md, maintained property and phase charts.
    for x in &stocks {
        assert!((x.mass_kg - 56_054.767893289).abs() < 5e-7, "{}", x.mass_kg);
        assert!(
            (x.energy_j - 69.639080018e9).abs() < 0.5e-3 * 1e3,
            "{}",
            x.energy_j
        );
    }
    let block = Secondaries::new(&section, &stocks, &If97).unwrap();
    let d = block.derived();
    // The rating reproduces itself through the runtime law exactly.
    let rating = section.relief.rating.mass_flow_kg_s;
    assert!(rel(d.relief_area_m2 * d.rating_flux_kg_m2_s, rating) < 1e-15);
    assert!(d.rating_choked && d.rating_throat_pa < 7e6 && d.rating_throat_pa > 0.101325e6);
    // IF97(7.2 MPa, 220 °C): research dispositions/g-sg2-demand-receipt.json.
    assert!((d.feed_enthalpy_j_kg - 945_022.767863453).abs() < 1e-3);
    // Metal preparation (operating-hot-reference.md, actual volumes).
    let sat =
        WaterProperties::saturation(&If97, s(probe.preparation.secondary_pressure_pa)).unwrap();
    let metal = 0.5 * (probe.preparation.metal_cold_temperature_k + sat.temperature.value);
    assert!((metal - 555.943205378).abs() < 5e-10);
    // The joined interface: 12 coordinates, 4 stocks, 4 chart, 4 lifts.
    let layout = Secondary::<If97>::layout(&block);
    assert_eq!(layout.len(), 12);
    assert_eq!(
        Secondary::<If97>::differential(&block)
            .iter()
            .filter(|v| **v == 0.)
            .count(),
        4
    );
    assert_eq!(Secondary::<If97>::root_count(&block), 20);
    assert_eq!(block.seated(), 4);
    eprintln!(
        "{}",
        json!({"scope":"zero-time derivations, NOT S2 evidence","derived":d,"preparationDefect":block.preparation_defect(),
            "stocks":stocks.iter().map(|x| json!({"id":x.id,"mass_kg":x.mass_kg,"energy_J":x.energy_j,"temperature_K":x.temperature_k})).collect::<Vec<_>>(),
            "metal_K":metal,"labels":layout.labels})
    );
    // A stock of another formulation is refused (IAPWS-95's 56,055.151 kg).
    let mut off = prepared_stocks(&If97, &section, &probe);
    off[0].mass_kg = 56_055.151;
    assert!(Secondaries::new(&section, &off, &If97).is_err());
}

#[test]
#[ignore = "requires LD01_OPERATING_SG_SECTION and LD01_OPERATING_SG_PROBE"]
fn rows_close_mass_and_energy_and_the_trip_ramps_the_demand() {
    let (section, probe) = (section(), probe());
    let stocks = prepared_stocks(&If97, &section, &probe);
    let ports = held_ports(&If97, &probe);
    let (mut sys, mut y) =
        Standalone::new(If97, &section, &stocks, Heat::Tube(ports), &probe).unwrap();
    lifted(&mut sys, &mut y);
    let yp = vec![0.; sys.n()];
    sys.evaluate(0., &y, &yp, None, 0.).unwrap();
    let b = sys.secondary.boundaries().to_vec();
    let h_feed = sys.secondary.derived().feed_enthalpy_j_kg;
    for (k, x) in b.iter().enumerate() {
        let relief: f64 = x.relief_kg_s.iter().map(|m| m.value).sum();
        assert!(x.relief_kg_s.iter().all(|m| m.value > 0.));
        // The inventory-holding feed: zero mass receipt, exactly.
        assert_eq!(x.mass_receipt_kg_s.value, 0.);
        assert_eq!(x.feed_kg_s.value, x.steam_kg_s.value + relief);
        // Energy: heat in, feed in, gas out at h_g, nothing else.
        let expected = x.heat_w.value + x.feed_kg_s.value * h_feed
            - (x.steam_kg_s.value + relief) * x.steam_enthalpy_j_kg.value;
        assert!((x.energy_receipt_w.value - expected).abs() <= 1e-9 * x.heat_w.value.abs());
        // The secondary heat is exactly the metal's export of the same call.
        assert!(rel(x.heat_w.value, sys.observed.heat_w[k]) < 1e-15);
        assert_eq!(
            x.steam_kg_s.value,
            sys.secondary.steam_generators()[k].steam_demand_kg_s
        );
    }
    // The unit identity: what the metal and water store together equals heat
    // from the primary plus feed less gas, to roundoff.
    let mut stored = 0.;
    let mut boundary = 0.;
    for (k, x) in b.iter().enumerate() {
        stored += x.energy_receipt_w.value;
        for i in 0..sys.segments.len() {
            let m = sys.secondary_len + k * sys.segments.len() + i;
            stored += -sys.rows[m].value * sys.row_scales[m];
        }
        let relief: f64 = x.relief_kg_s.iter().map(|m| m.value).sum();
        boundary += sys.observed.primary_w[k] + x.feed_kg_s.value * h_feed
            - (x.steam_kg_s.value + relief) * x.steam_enthalpy_j_kg.value;
    }
    assert!(
        (stored - boundary).abs() <= 1e-9 * boundary.abs().max(1e6),
        "{stored} vs {boundary}"
    );
    // TRIP at t = 1 s: the demand ramps linearly over 0.3 s and stays zero.
    let tx = Secondary::<If97>::command(&mut sys.secondary, 1., Command::TurbineTrip).unwrap();
    assert_eq!(tx.receipt["rampEnd_s"], json!(1.3));
    for (t, fraction) in [(0.5, 1.), (1., 1.), (1.15, 0.5), (1.3, 0.), (2., 0.)] {
        assert!(
            (sys.secondary.steam_fraction(t) - fraction).abs() < 1e-12,
            "{t}"
        );
        sys.evaluate(t, &y, &yp, None, 0.).unwrap();
        let steam = sys.secondary.boundaries()[0].steam_kg_s.value;
        assert!(
            (steam - fraction * sys.secondary.steam_generators()[0].steam_demand_kg_s).abs() < 1e-9
        );
    }
    assert!(Secondary::<If97>::command(&mut sys.secondary, 2., Command::TurbineTrip).is_err());
}

#[test]
#[ignore = "requires LD01_OPERATING_SG_SECTION and LD01_OPERATING_SG_PROBE"]
fn declared_structure_holds_and_directions_match_differences() {
    let (section, probe) = (section(), probe());
    let stocks = prepared_stocks(&If97, &section, &probe);
    let mut report = Vec::new();
    for tube in [false, true] {
        let heat = if tube {
            Heat::Tube(held_ports(&If97, &probe))
        } else {
            Heat::Schedule(vec![(0., vec![1.4e9, 1.3e9])])
        };
        let (mut sys, mut y) = Standalone::new(If97, &section, &stocks, heat, &probe).unwrap();
        for state in ["prepared", "lifted"] {
            if state == "lifted" {
                lifted(&mut sys, &mut y);
            }
            let n = sys.n();
            let yp: Vec<f64> = (0..n).map(|i| 1e-3 * ((i % 5) as f64 - 2.)).collect();
            let cj = 37.5;
            let dense = sys.dense(0., cj, &y, &yp).unwrap();
            let mut colored = vec![0.; sys.pattern.nonzeros()];
            sys.colored(0., cj, &y, &yp, &mut colored).unwrap();
            let exact = sparse::compare_with_dense(&sys.pattern, &colored, &dense).unwrap();
            let mut fd = vec![0.; sys.pattern.nonzeros()];
            sys.colored_differences(0., cj, &y, &yp, &mut fd).unwrap();
            // Forward differences against the seeded entries, per column norm.
            let mut worst_fd: f64 = 0.;
            for j in 0..n {
                let col = &dense[j * n..(j + 1) * n];
                let norm = col.iter().map(|v| v * v).sum::<f64>().sqrt();
                for &r in sys.pattern.column(j) {
                    let p = sys.pattern.position(r, j).unwrap();
                    if norm > 0. {
                        worst_fd = worst_fd.max((fd[p] - col[r]).abs() / norm);
                    }
                }
            }
            // G10: analytic against central-difference directional derivatives
            // in the scaled-row norm, on every coordinate and 20 random
            // directions, over the secondary block's own coordinates.
            let ns = sys.secondary_len;
            let mut directions: Vec<Vec<f64>> = (0..ns)
                .map(|j| (0..n).map(|i| f64::from(u8::from(i == j))).collect())
                .collect();
            let mut state_rng: u64 = 0x5eed_0f52_5000;
            for _ in 0..20 {
                directions.push(
                    (0..n)
                        .map(|i| {
                            state_rng = state_rng
                                .wrapping_mul(6364136223846793005)
                                .wrapping_add(1442695040888963407);
                            if i < ns {
                                ((state_rng >> 11) as f64 / (1u64 << 53) as f64) * 2. - 1.
                            } else {
                                0.
                            }
                        })
                        .collect(),
                );
            }
            let mut worst_g10: f64 = 0.;
            let h = 1e-6;
            for d in &directions {
                sys.evaluate(0., &y, &yp, Some(d), cj).unwrap();
                let analytic: Vec<f64> = sys.rows[..ns].iter().map(|r| r.direction).collect();
                let shift = |sign: f64| -> (Vec<f64>, Vec<f64>) {
                    (
                        y.iter().zip(d).map(|(v, e)| v + sign * h * e).collect(),
                        yp.iter()
                            .zip(d)
                            .map(|(v, e)| v + sign * h * cj * e)
                            .collect(),
                    )
                };
                let (yu, ypu) = shift(1.);
                let (yl, ypl) = shift(-1.);
                let up = sys.values(0., &yu, &ypu).unwrap();
                let low = sys.values(0., &yl, &ypl).unwrap();
                let diff: Vec<f64> = (0..ns).map(|i| (up[i] - low[i]) / (2. * h)).collect();
                let norm = analytic.iter().map(|v| v * v).sum::<f64>().sqrt();
                let err = analytic
                    .iter()
                    .zip(&diff)
                    .map(|(a, b)| (a - b) * (a - b))
                    .sum::<f64>()
                    .sqrt();
                if norm > 0. {
                    worst_g10 = worst_g10.max(err / norm);
                }
            }
            assert!(exact.is_bitwise_exact(), "{tube} {state}: {exact:?}");
            assert!(
                worst_fd < 1e-5,
                "{tube} {state}: forward differences {worst_fd}"
            );
            assert!(worst_g10 < 1e-6, "{tube} {state}: G10 {worst_g10}");
            report.push(json!({"heat":if tube {"tube"} else {"port"},"state":state,"n":n,
                "nonzeros":sys.pattern.nonzeros(),"colors":sys.coloring.count(),
                "coloredVsDenseBitwise":exact.is_bitwise_exact(),"forwardDifferenceWorstColumnRelative":worst_fd,
                "g10WorstScaledRowRelative":worst_g10,"g10Directions":directions.len()}));
        }
    }
    eprintln!(
        "{}",
        json!({"scope":"Jacobian checks at zero time, NOT S2 evidence","cases":report})
    );
}

/// Mean thread CPU (µs) and property calls per views+rows evaluation; with
/// `distinct`, each repetition moves the SG pressures by 1e-9 relative so no
/// exact same-input reuse can repeat across calls.
#[allow(clippy::too_many_arguments)]
fn time_block(
    block: &mut Secondaries,
    props: &Counted,
    scales: &[f64],
    y: &[f64],
    seed: Option<&[f64]>,
    reps: usize,
    distinct: bool,
) -> (f64, f64) {
    let n = scales.len();
    let yp = vec![0.; n];
    let mut views = vec![
        SecondaryView {
            pressure: s(0.),
            saturation_temperature: s(0.),
            liquid_volume: s(0.),
            steam_present: true,
        };
        2
    ];
    let mut rows = vec![s(0.); n];
    let heat = [s(1.5e9), s(1.5e9)];
    let mut y = y.to_vec();
    let base = [y[2], y[8]];
    props.reset();
    let started = cpu();
    for r in 0..reps {
        if distinct {
            y[2] = base[0] * (1. + 1e-9 * r as f64);
            y[8] = base[1] * (1. + 1e-9 * r as f64);
        }
        let x = Coordinates::new(&y, &yp, seed, 20., scales).unwrap();
        Secondary::<Counted>::views(block, props, x, &mut views).unwrap();
        Secondary::<Counted>::rows(block, props, 0., x, &heat, &mut rows).unwrap();
    }
    (
        1e6 * (cpu() - started) / reps as f64,
        props.total() as f64 / reps as f64,
    )
}

/// Mean thread CPU (µs) and property calls of the block's own colored
/// assembly: per repetition one seeded pass per color at a distinct state.
fn time_jacobian(
    block: &mut Secondaries,
    props: &Counted,
    scales: &[f64],
    y: &[f64],
    reps: usize,
) -> (f64, f64, usize) {
    let n = scales.len();
    let st = Secondary::<Counted>::structure(block);
    let pattern = sparse::Pattern::from_rows(n, &st.own).unwrap();
    let coloring = sparse::Coloring::greedy(&pattern);
    let mut values = vec![0.; pattern.nonzeros()];
    let mut seed = vec![0.; n];
    let yp = vec![0.; n];
    let mut views = vec![
        SecondaryView {
            pressure: s(0.),
            saturation_temperature: s(0.),
            liquid_volume: s(0.),
            steam_present: true,
        };
        2
    ];
    let mut rows = vec![s(0.); n];
    let heat = [s(1.5e9), s(1.5e9)];
    let mut y = y.to_vec();
    let base = [y[2], y[8]];
    props.reset();
    let started = cpu();
    for r in 0..reps {
        y[2] = base[0] * (1. + 1e-9 * r as f64);
        y[8] = base[1] * (1. + 1e-9 * r as f64);
        for c in 0..coloring.count() {
            coloring.seed_into(c, &vec![1.; n], &mut seed).unwrap();
            let x = Coordinates::new(&y, &yp, Some(&seed), 20., scales).unwrap();
            Secondary::<Counted>::views(block, props, x, &mut views).unwrap();
            Secondary::<Counted>::rows(block, props, 0., x, &heat, &mut rows).unwrap();
            let directions: Vec<f64> = rows.iter().map(|r| r.direction).collect();
            sparse::scatter(
                &pattern,
                &coloring,
                c,
                &directions,
                &vec![1.; n],
                &mut values,
            )
            .unwrap();
        }
    }
    (
        1e6 * (cpu() - started) / reps as f64,
        props.total() as f64 / reps as f64,
        coloring.count(),
    )
}

#[test]
#[ignore = "requires LD01_OPERATING_SG_SECTION and LD01_OPERATING_SG_PROBE"]
fn cost_per_evaluation() {
    let (section, probe) = (section(), probe());
    let stocks = prepared_stocks(&If97, &section, &probe);
    let props = Counted::default();
    let mut block = Secondaries::new(&section, &stocks, &props).unwrap();
    let layout = Secondary::<Counted>::layout(&block).clone();
    let n = layout.len();
    let scales = layout.scales.clone();
    let prepared = Secondary::<Counted>::prepared(&block);
    let mut y: Vec<f64> = prepared.iter().zip(&scales).map(|(v, s)| v / s).collect();
    let mut seed = vec![0.; n];
    seed[2] = 1.;
    seed[8] = 1.;
    // Every valve seated, as prepared: no flow and no nozzle evaluation.
    assert_eq!(block.seated(), 4);
    let seated_value = time_block(&mut block, &props, &scales, &y, None, 2000, true);
    let seated_seeded = time_block(&mut block, &props, &scales, &y, Some(&seed), 2000, true);
    let seated_jacobian = time_jacobian(&mut block, &props, &scales, &y, 500);
    // Every valve lifted at 0.5 on the ascending branch: the nozzle runs.
    for (k, b) in [(0, 0), (1, 6)] {
        for j in 0..2 {
            y[b + 4 + j] = 0.5;
            block
                .set_valve(k, j, Valve::open(Branch::Ascending), 6e6, 0.5)
                .unwrap();
        }
    }
    let lifted_value = time_block(&mut block, &props, &scales, &y, None, 200, true);
    let lifted_seeded = time_block(&mut block, &props, &scales, &y, Some(&seed), 200, true);
    let lifted_jacobian = time_jacobian(&mut block, &props, &scales, &y, 50);
    // The composed standalone with the tube path of 2 x 4 segments, seated.
    let (mut sys, ys) = Standalone::new(
        If97,
        &section,
        &stocks,
        Heat::Tube(held_ports(&If97, &probe)),
        &probe,
    )
    .unwrap();
    let ypz = vec![0.; sys.n()];
    let started = cpu();
    for _ in 0..200 {
        sys.evaluate(0., &ys, &ypz, None, 0.).unwrap();
    }
    let composed_us = 1e6 * (cpu() - started) / 200.;
    let mut colored = vec![0.; sys.pattern.nonzeros()];
    let started = cpu();
    for _ in 0..20 {
        sys.colored(0., 20., &ys, &ypz, &mut colored).unwrap();
    }
    let composed_jacobian_us = 1e6 * (cpu() - started) / 20.;
    let cell = |x: (f64, f64)| json!({"us":x.0,"propertyCalls":x.1});
    eprintln!(
        "{}",
        json!({"scope":"cost per evaluation, thread CPU, release build, NOT S2 evidence",
            "secondaryBlock":{"coordinates":n,"structuralNonzeros":Secondary::<Counted>::structure(&block).own.iter().map(Vec::len).sum::<usize>(),
                "colorsAlone":seated_jacobian.2,
                "seated":{"value":cell(seated_value),"seededPressure":cell(seated_seeded),
                    "coloredJacobian":cell((seated_jacobian.0,seated_jacobian.1))},
                "lifted":{"value":cell(lifted_value),"seededPressure":cell(lifted_seeded),
                    "coloredJacobian":cell((lifted_jacobian.0,lifted_jacobian.1))}},
            "composedWithTubeSeated":{"coordinates":sys.n(),"colors":sys.coloring.count(),"value_us":composed_us,
                "coloredJacobian_us":composed_jacobian_us}})
    );
    // Seated valves make no nozzle call: two saturations per evaluation.
    assert_eq!(seated_value.1, 2.);
    assert!(seated_jacobian.1 <= 2. * seated_jacobian.2 as f64);
    assert!(lifted_value.1 > seated_value.1);
    assert_eq!(secondary::DISARMED, 1.);
}
