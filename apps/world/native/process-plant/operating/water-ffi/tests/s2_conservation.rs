//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#s2-declaration-joined-hot-spine-at-power
//! The S2 conservation account on the actual joined packet: the identities
//! (unit energy, primary mass and boron, each SG) at the composed state and
//! their discrimination against a deliberately dropped term, and the IDAS
//! ledgers over a settle segment and across the trip's discrete restarts.
//!
//! These are NOT-EVIDENCE harness probes (S2-14 M2), not S2 gate runs: the
//! bounds are the declaration's (`identityRelative`, `ledger`), read as
//! data, and a receipt is written only to a new file.
#![cfg(feature = "quadratures")]
#[path = "common/counts.rs"]
mod counts;
#[path = "common/cpu.rs"]
mod cpu;
#[path = "common/filter.rs"]
mod filter;
#[path = "common/observe.rs"]
mod observe;
#[path = "common/provenance.rs"]
mod provenance;
mod s2_harness;
use conservation::Conservation;
pub use s2_harness::{compose, conservation, gates, receipt, run};

use leitbild_operating_plant::{
    joined::{
        account::{Account, Held, Plan},
        block::Command,
    },
    thermal::Scalar,
};
use leitbild_operating_water::{
    If97,
    ida::{Advance, Ida, Initial},
    joined::{Discrete, Integrated, Matrices, Restart, consistent_start, discrete_restart},
    joined_ledger::{self, Ledgered, Segment},
};
use serde_json::{Value, json};

/// The declaration and the composition at the hot reference.
fn setup() -> (gates::Declaration, compose::Composed) {
    let declaration = gates::Declaration::load().unwrap_or_else(|e| panic!("{e}"));
    let composed = compose::compose(&declaration.shared);
    (declaration, composed)
}

fn worst(account: &Account) -> Value {
    let w = account.worst();
    json!({"identity": w.name, "relative": w.relative(), "defect": w.defect})
}

/// The identities close at the composed state's exact consistent start,
/// and each catches a deliberately dropped term: the SG-A secondary's
/// energy row without the metal heat it received (a dropped heat term), and
/// its mass row without its feed. The mutations act on a copy of the joined
/// rows, as if the owner's row had lost the term; the operator is untouched.
#[test]
#[ignore = "NOT-EVIDENCE probe: requires the joined packet, the S2 declaration, the wiki, IF97 and stock IDAS/KLU"]
fn s2_identities_close_and_a_dropped_term_is_caught() {
    let (declaration, mut c) = setup();
    let bound = declaration.gates.number("/identityRelative");
    let plan = Plan::new(&c.joined).expect("account plan");
    let account = c
        .joined
        .account(&plan, 0., &c.y, &c.yp)
        .expect("account at the composed state");
    let receipt_identities = account.json();
    for i in account.identities() {
        assert!(i.closes(bound), "{} misses {bound}: {}", i.name, i.json());
    }
    let rows: Vec<Scalar> = c.joined.rows().to_vec();
    let scales = c.joined.scales();
    let (sg_mass, sg_energy) = plan.sg_stocks();
    let (m_a, u_a) = (sg_mass[0], sg_energy[0]);
    // The rows copy unchanged reads the same account.
    let same = plan.read_rows(&c.joined, &c.y, &c.yp, &rows).unwrap();
    assert_eq!(
        same.unit_energy.defect.to_bits(),
        account.unit_energy.defect.to_bits()
    );
    // A dropped heat term: SG A's U row without the metal heat Q, `row +
    // Q/scale` (the row is U' - (Q + feed h - out h)/scale).
    let heat = account
        .handovers
        .iter()
        .find(|h| h.name == format!("SG.{}.metal_heat_handover", plan.generators()[0]))
        .expect("SG A handover")
        .terms[0]
        .1;
    let mut dropped = rows.clone();
    dropped[u_a] = Scalar::constant(rows[u_a].value + heat / scales[u_a]);
    let mutated = plan.read_rows(&c.joined, &c.y, &c.yp, &dropped).unwrap();
    assert!(
        !mutated.unit_energy.closes(bound),
        "{}",
        mutated.unit_energy.json()
    );
    assert!(
        !mutated.sg_energy[0].closes(bound),
        "{}",
        mutated.sg_energy[0].json()
    );
    assert!(
        (mutated.unit_energy.defect - account.unit_energy.defect + heat).abs() <= 1e-6 * heat.abs(),
        "the unit identity misses by the dropped heat: {} against {heat}",
        mutated.unit_energy.defect
    );
    // A dropped feed: SG A's M row without its feed, `row + feed/scale`.
    let feed = plan
        .ledger_names()
        .iter()
        .position(|n| n == &format!("SG.{}.feed_kg", plan.generators()[0]))
        .map(|k| account.boundary[k])
        .expect("SG A feed");
    let mut no_feed = rows.clone();
    no_feed[m_a] = Scalar::constant(rows[m_a].value + feed / scales[m_a]);
    let starved = plan.read_rows(&c.joined, &c.y, &c.yp, &no_feed).unwrap();
    assert!(
        !starved.sg_mass[0].closes(bound),
        "{}",
        starved.sg_mass[0].json()
    );
    assert!(starved.sg_mass[1].closes(bound));
    let receipt = json!({
        "kind": "s2-conservation-identities-NOT-EVIDENCE",
        "provenance": provenance::git_provenance(),
        "packet": c.packet.path, "packet_sha256": c.packet.sha256,
        "declaration": declaration.receipt()["page"], "bound_relative": bound,
        "composed_state": receipt_identities, "worst": worst(&account),
        "mutations": {
            "dropped_sg_a_metal_heat": {"heat_w": heat, "unit_energy": mutated.unit_energy.json(), "sg_a_energy": mutated.sg_energy[0].json()},
            "dropped_sg_a_feed": {"feed_kg_s": feed, "sg_a_mass": starved.sg_mass[0].json()},
        },
        "composition": c.receipt,
    });
    println!("{}", serde_json::to_string(&receipt).unwrap());
    write_new(&receipt, "LD01_S2_IDENTITY_RECEIPT");
}

/// Write a receipt to the NEW file named by `variable`, if set.
fn write_new(receipt: &Value, variable: &str) {
    if let Some(path) = std::env::var_os(variable) {
        let path = std::path::Path::new(&path);
        assert!(
            !path.exists(),
            "receipts are never overwritten: {}",
            path.display()
        );
        std::fs::write(path, serde_json::to_vec_pretty(receipt).unwrap()).unwrap();
    }
}

/// A settle segment, then the turbine trip's first second, on the IDAS
/// ledgers: from the composed state, or from a saved settled state of this
/// packet (`LD01_S2_SETTLED_STATE`, re-started exactly). At every output the
/// identities close within the declared bound and every ledger closes within
/// its declared tolerance units; the trip's restarts (the command, the
/// holding opening, the ramp end and any root) each carry the ledger into
/// the next segment by stock IDAQuadReInit. The ledger changes no step: the
/// first `LD01_S2_BITWISE_S` seconds are integrated again without it and
/// compared bit for bit.
#[test]
#[ignore = "NOT-EVIDENCE probe: requires the joined packet, the S2 declaration, the wiki, IF97 and stock IDAS/KLU"]
fn s2_ledgers_close_over_a_settle_segment_and_carry_across_restarts() {
    let wall = std::time::Instant::now();
    let process0 = cpu::process_cpu_s();
    let env = |k: &str, default: f64| -> f64 {
        std::env::var(k).map_or(default, |v| v.parse().unwrap_or_else(|_| panic!("{k}={v}")))
    };
    let settle_s = env("LD01_S2_SEGMENT_S", 10.);
    let trip_s = env("LD01_S2_TRIP_S", 1.);
    let bitwise_s = env("LD01_S2_BITWISE_S", 0.5);
    let (declaration, c) = setup();
    let g = &declaration.gates;
    let window_cap_s = declaration.shared.number("/eventWindow/maxStep_s");
    let output_s = g.number("/outputInterval_s");
    let restart = Restart {
        newton_coefficient: g.number("/newtonCoefficient"),
        delta_cj_lsetup: g.number("/deltaCjLSetup"),
        first_step_s: g.number("/restartInitialStep_s"),
        start_bound: compose::START_BOUND,
        start_passes: 2,
        bound_placement: compose::START_BOUND,
    };
    let max_order = g.count("/maxOrder") as usize;
    // The start: the composed pair, or a saved state restarted exactly.
    let saved = std::env::var("LD01_S2_SETTLED_STATE").ok();
    let start = |mut c: compose::Composed| -> (compose::Composed, Value) {
        let Some(path) = saved.as_ref() else {
            return (c, json!({"from": "composed state"}));
        };
        let (t_saved, y, _) = compose::saved_state(path, &c.packet, c.y.len());
        let mut y = y;
        let weights = compose::error_weights(&y, c.rtol, &c.atol);
        let started = cpu::process_cpu_s();
        let (yp, report) = consistent_start(
            &mut c.joined,
            Matrices::Blocks {
                structure: &c.structure,
                analyses: &mut c.analyses,
            },
            0.,
            &mut y,
            &c.ids,
            &weights,
            compose::START_BOUND,
            3,
        )
        .expect("exact consistent start at the saved state");
        let receipt = json!({"from": path, "saved_at_s": t_saved, "restarted_at_s": 0.,
            "start": {"residual": report.residual.value, "constraint_rate": report.constraint_rate.value, "correction_wrms": report.correction_wrms, "cpu_s": cpu::process_cpu_s() - started}});
        c.y = y;
        c.yp = yp;
        (c, receipt)
    };
    let (c, from) = start(c);
    let compose::Composed {
        joined,
        y,
        yp,
        ids,
        network_ids,
        atol,
        rtol,
        packet,
        structure,
        analyses,
        receipt: composition,
        ..
    } = c;
    let (y0, yp0) = (y.clone(), yp.clone());
    let nonnegative = joined.network.nonnegative_stocks();
    let integrated = Integrated::from_blocks(joined, structure, analyses).unwrap();
    let system = Ledgered::new(integrated, cpu::thread_cpu_s).expect("ledgered system");
    let names = system.names();
    let mut ida = Ida::new(
        system,
        Initial {
            time: 0.,
            y: &y0,
            yp: &yp0,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: rtol,
        },
    )
    .unwrap();
    ida.set_max_order(max_order).unwrap();
    ida.constrain_nonnegative(&nonnegative).unwrap();
    restart.configure(&mut ida).unwrap();
    let mut segment = joined_ledger::start_ledger(&mut ida, 0., vec![0.; names.len()]).unwrap();
    let (mut y, mut yp) = (y0.clone(), yp0.clone());
    let plan = ida.system().plan.clone();
    let inventory = |ida: &Ida<Ledgered<If97>>, y: &[f64]| -> Vec<Held> {
        plan.inventory(&ida.system().integrated.joined, y, &atol, rtol)
            .expect("inventory")
    };
    let held0 = inventory(&ida, &y);
    let mut settle = Conservation::new(g, plan.clone(), held0, segment.started_q.clone());
    let mut restarts: Vec<Value> = Vec::new();
    let mut bitwise_state: Option<Vec<f64>> = None;
    // One accepted output: the identities at the state and the ledger's
    // closure against the inventories there.
    let observe = |ida: &mut Ida<Ledgered<If97>>,
                   segment: &Segment,
                   t: f64,
                   y: &[f64],
                   yp: &[f64],
                   record: &mut Conservation| {
        let q = joined_ledger::ledger_at(ida, segment, t).expect("ledger");
        let account = ida.system_mut().account(t, y, yp).expect("account");
        record.sample(t, &account);
        record.output(t, &inventory(ida, y), &q);
    };
    observe(&mut ida, &segment, 0., &y, &yp, &mut settle);
    // The settle segment: no event is declared; a root or time event fails.
    ida.stop_at(settle_s).unwrap();
    let mut t = 0.;
    let mut k = 1;
    while t < settle_s - 1e-12 {
        let target = (k as f64 * output_s).min(settle_s);
        match ida
            .advance(target, &mut y, &mut yp)
            .expect("settle segment")
        {
            Advance::Reached(time) => {
                t = time;
                observe(&mut ida, &segment, t, &y, &yp, &mut settle);
                if bitwise_state.is_none() && (t - bitwise_s).abs() < 1e-9 {
                    bitwise_state = Some(y.clone());
                }
                k += 1;
            }
            Advance::Root { time, directions } => {
                panic!("a root at {time} s in the settle segment: {directions:?}")
            }
        }
    }
    let settle_counts = ida.stats().unwrap();
    // The trip: its own record from the segment's end, the command there,
    // then the owners' time events and roots, each a discrete restart
    // carrying the ledger.
    let mut trip = Conservation::new(
        g,
        plan.clone(),
        inventory(&ida, &y),
        joined_ledger::ledger_at(&ida, &segment, t).unwrap(),
    );
    observe(&mut ida, &segment, t, &y, &yp, &mut trip);
    let trip_end = settle_s + trip_s;
    let restart_at = |ida: &mut Ida<Ledgered<If97>>,
                      segment: &mut Segment,
                      t: f64,
                      discrete: Discrete<'_>,
                      kind: &str,
                      y: &mut Vec<f64>,
                      yp: &mut Vec<f64>,
                      restarts: &mut Vec<Value>,
                      record: &mut Conservation| {
        let carried = joined_ledger::ledger_at(ida, segment, t).expect("ledger at the restart");
        let started = cpu::process_cpu_s();
        let done = discrete_restart(ida, t, discrete, y, &network_ids, &atol, rtol, &restart)
            .unwrap_or_else(|e| panic!("{kind} restart at {t} s: {e}"));
        *segment = joined_ledger::restart_ledger(ida, t, carried.clone()).expect("ledger re-init");
        record.restarted(t);
        ida.set_max_order(max_order).unwrap();
        ida.set_max_step(window_cap_s).unwrap();
        ida.stop_at(
            ida.system()
                .integrated
                .joined
                .next_time_event(t)
                .map_or(trip_end, |e| e.min(trip_end)),
        )
        .unwrap();
        yp.copy_from_slice(&done.yp);
        let after = joined_ledger::ledger_at(ida, segment, t).unwrap();
        restarts.push(json!({"t_s": t, "kind": kind, "transactions": done.transactions.len(),
            "start_residual": done.report.residual.value, "start_cpu_s": cpu::process_cpu_s() - started,
            "ledger_carried": after == carried, "ledger_reinitialised": true}));
    };
    restart_at(
        &mut ida,
        &mut segment,
        settle_s,
        Discrete::Command(Command::TurbineTrip),
        "command: turbine trip",
        &mut y,
        &mut yp,
        &mut restarts,
        &mut trip,
    );
    observe(&mut ida, &segment, settle_s, &y, &yp, &mut trip);
    while t < trip_end - 1e-12 {
        let event = ida.system().integrated.joined.next_time_event(t);
        let target = (t + output_s)
            .min(trip_end)
            .min(event.unwrap_or(f64::INFINITY));
        match ida.advance(target, &mut y, &mut yp).expect("trip") {
            Advance::Reached(time) => {
                t = time;
                observe(&mut ida, &segment, t, &y, &yp, &mut trip);
                if event.is_some_and(|e| (e - t).abs() <= 1e-12 * e.abs().max(1.)) {
                    restart_at(
                        &mut ida,
                        &mut segment,
                        t,
                        Discrete::TimeEvent,
                        "time event",
                        &mut y,
                        &mut yp,
                        &mut restarts,
                        &mut trip,
                    );
                    observe(&mut ida, &segment, t, &y, &yp, &mut trip);
                }
            }
            Advance::Root { time, directions } => {
                t = time;
                observe(&mut ida, &segment, t, &y, &yp, &mut trip);
                restart_at(
                    &mut ida,
                    &mut segment,
                    t,
                    Discrete::Roots(&directions),
                    "roots",
                    &mut y,
                    &mut yp,
                    &mut restarts,
                    &mut trip,
                );
                observe(&mut ida, &segment, t, &y, &yp, &mut trip);
            }
        }
    }
    let ledger_cpu = ida.system().counters;
    // The ledger changes no step: the same start without quadratures.
    let bitwise = bitwise_state.map(|ledgered| {
        let (_, c2) = setup();
        let (c2, _) = start(c2);
        let integrated = Integrated::from_blocks(c2.joined, c2.structure, c2.analyses).unwrap();
        let mut plain = Ida::new(
            integrated,
            Initial {
                time: 0.,
                y: &c2.y,
                yp: &c2.yp,
                differential: &c2.ids,
                absolute_tolerance: &c2.atol,
                relative_tolerance: c2.rtol,
            },
        )
        .unwrap();
        plain.set_max_order(max_order).unwrap();
        plain.constrain_nonnegative(&nonnegative).unwrap();
        restart.configure(&mut plain).unwrap();
        plain.stop_at(settle_s).unwrap();
        let (mut yb, mut ypb) = (c2.y.clone(), c2.yp.clone());
        let mut tb = 0.;
        let mut k = 1;
        while tb < bitwise_s - 1e-12 {
            tb = plain
                .advance((k as f64 * output_s).min(bitwise_s), &mut yb, &mut ypb)
                .unwrap()
                .reached()
                .unwrap();
            k += 1;
        }
        let differing = yb
            .iter()
            .zip(&ledgered)
            .filter(|(a, b)| a.to_bits() != b.to_bits())
            .count();
        json!({"at_s": bitwise_s, "coordinates_differing": differing})
    });
    let receipt = json!({
        "kind": "s2-conservation-ledgers-NOT-EVIDENCE",
        "status": "NOT-EVIDENCE harness probe (S2-14 M2); S2 is not declared. PZR boundary closed (G6 pending)",
        "provenance": provenance::git_provenance(),
        "packet": packet.path, "packet_sha256": packet.sha256,
        "declaration": declaration.receipt()["page"],
        "start": from, "composition": composition,
        "configuration": {"rtol": rtol, "max_order": max_order, "newton_coefficient": restart.newton_coefficient, "delta_cj_lsetup": restart.delta_cj_lsetup,
            "first_step_s": restart.first_step_s, "output_s": output_s, "settle_s": settle_s, "trip_s": trip_s, "trip_window_max_step_s": window_cap_s},
        "settle": {"identities": settle.identities_json(), "ledger": settle.ledger_json(),
            "steps": settle_counts.steps, "residuals": settle_counts.residuals, "jacobians": settle_counts.jacobians},
        "trip": {"identities": trip.identities_json(), "ledger": trip.ledger_json(), "restarts": restarts},
        "ledger_changes_no_step": bitwise,
        "ledger_cost": {"calls": ledger_cpu.calls, "thread_cpu_s": ledger_cpu.cpu_s},
        "cost": {"process_cpu_s": cpu::process_cpu_s() - process0, "wall_s": wall.elapsed().as_secs_f64(), "load_average": cpu::load_average()},
    });
    let brief = |r: &Value| {
        json!({"identities_pass": r["identities"]["pass"], "unit_energy": r["identities"]["unit_energy"]["max_relative"],
        "worst_kinetics": r["identities"]["kinetics_source_balance"]["max_relative"],
        "ledger_pass": r["ledger"]["pass"], "ledger": r["ledger"]["closures"], "reinitialised_at_s": r["ledger"]["reinitialised_at_s"]})
    };
    println!("{}", serde_json::to_string(&json!({"settle": brief(&receipt["settle"]), "trip": brief(&receipt["trip"]), "ledger_changes_no_step": receipt["ledger_changes_no_step"], "ledger_cost": receipt["ledger_cost"], "cost": receipt["cost"]})).unwrap());
    write_new(&receipt, "LD01_S2_LEDGER_RECEIPT");
    assert!(settle.identities_pass(), "{}", settle.identities_json());
    assert!(settle.ledger_pass(), "{}", settle.ledger_json()["closures"]);
    assert!(trip.ledger_pass(), "{}", trip.ledger_json()["closures"]);
    assert!(
        restarts.iter().all(|r| r["ledger_carried"] == json!(true)) && restarts.len() >= 3,
        "{restarts:?}"
    );
    if let Some(b) = receipt["ledger_changes_no_step"].as_object() {
        assert_eq!(b["coordinates_differing"], json!(0), "{b:?}");
    }
}
