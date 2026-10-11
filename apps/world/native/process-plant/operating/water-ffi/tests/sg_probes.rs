//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-generation/thermodynamics.md#s2-secondary-block
//! NOT-EVIDENCE probes of the S2 SG secondary block under stock IDA/KLU. S2 is
//! not declared; these are no S2 gate trajectories. The SG primary cell is
//! held at its prepared state (a probe boundary, not the network), or the
//! secondary heat is a declared piecewise-constant fixture. They check the
//! block's dynamics against its own zero-time balance, the relief memory over
//! an actual pressure history and the integrator-consistent receipt ledgers.
#![cfg(feature = "ida")]
mod sg_harness;

use leitbild_operating_plant::joined::block::Command;
use leitbild_operating_water::If97;
use serde_json::{Value, json};
use sg_harness::{
    Heat, Standalone, held_ports,
    integrate::{Spec, run},
    prepared_stocks, probe, section,
};

fn last(samples: &[Value], key: &str, k: usize) -> f64 {
    samples.last().unwrap()["sgs"][k][key].as_f64().unwrap()
}
fn worst(samples: &[Value], key: &str) -> f64 {
    samples
        .iter()
        .flat_map(|s| {
            s["sgs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|g| g[key].as_f64().unwrap().abs())
        })
        .fold(0., f64::max)
}
/// Relief transitions of a run: (t, valve, threshold, kind).
fn relief_events(events: &[Value]) -> Vec<(f64, String, String, String)> {
    let mut out = Vec::new();
    for e in events.iter().filter(|e| e["event"] == "root") {
        let t = e["t_s"].as_f64().unwrap();
        for r in e["receipt"]["relief"].as_array().unwrap() {
            let (b, a) = (&r["before"], &r["after"]);
            let mut kind = if r["superseded"] == true {
                "superseded".to_string()
            } else if b["branch"] != a["branch"] {
                format!("{}->{}", b["branch"].as_str().unwrap(), a["branch"].as_str().unwrap())
            } else if b["seated"] == true && a["seated"] == false {
                "unseat".to_string()
            } else if b["seated"] == false && a["seated"] == true {
                "seat".to_string()
            } else {
                "kink".to_string()
            };
            if r["seatedFromLift"].is_number() && kind.contains("->") {
                kind.push_str("+seat");
            }
            let name = |k: &str| r[k].as_str().unwrap().to_string();
            out.push((t, name("valve"), name("threshold"), kind));
        }
    }
    out
}
/// Counts of transitions by threshold and kind, and of restarts.
fn counts(events: &[Value]) -> Value {
    let mut by = std::collections::BTreeMap::<String, usize>::new();
    for e in relief_events(events) {
        *by.entry(format!("{}:{}", e.2, e.3)).or_default() += 1;
    }
    let count = |kind: &str| events.iter().filter(|e| e["event"] == kind).count();
    json!({"transitionsByThresholdAndKind":by,"rootReturns":count("root"),
        "exactConsistentRestarts":count("exact consistent restart"),"timeBoundaries":count("time boundary")})
}
fn write(name: &str, value: &Value) {
    if let Ok(dir) = std::env::var("LD01_OPERATING_SG_PROBE_OUT") {
        std::fs::write(
            format!("{dir}/{name}.json"),
            serde_json::to_string_pretty(value).unwrap(),
        )
        .unwrap();
    }
}

/// From the 6 MPa preparation with the SG primary cell held at its prepared
/// state, the secondary settles at its emergent pressure; at 60 s the manual
/// turbine TRIP ramps the demand to zero and the reliefs crack.
#[test]
#[ignore = "requires LD01_OPERATING_SG_SECTION and LD01_OPERATING_SG_PROBE"]
fn settles_at_the_emergent_pressure_then_the_trip_cracks_the_reliefs() {
    let (section, probe) = (section(), probe());
    let stocks = prepared_stocks(&If97, &section, &probe);
    let (sys, y0) = Standalone::new(
        If97,
        &section,
        &stocks,
        Heat::Tube(held_ports(&If97, &probe)),
        &probe,
    )
    .unwrap();
    let spec = Spec {
        t_end: 90.,
        rtol: 1e-6,
        atol: 1e-8,
        output_s: 0.5,
        commands: vec![(60., Command::TurbineTrip)],
        consistent_bound: 1e-9,
    };
    let out = run(sys, 0., y0, &spec).unwrap();
    write(
        "settle-trip",
        &json!({"samples":out.samples,"events":out.events,"counts":out.counts}),
    );
    let settled: Vec<&Value> = out
        .samples
        .iter()
        .filter(|s| s["t_s"].as_f64().unwrap() <= 60.)
        .collect();
    let at60 = settled.last().unwrap();
    let at40 = settled
        .iter()
        .rev()
        .find(|s| s["t_s"].as_f64().unwrap() <= 40.)
        .unwrap();
    let mut summary = Vec::new();
    for k in 0..2 {
        let p60 = at60["sgs"][k]["p_Pa"].as_f64().unwrap();
        let p40 = at40["sgs"][k]["p_Pa"].as_f64().unwrap();
        let heat = at60["sgs"][k]["heat_W"].as_f64().unwrap();
        summary.push(
            json!({"p60_Pa":p60,"drift40to60_Pa":p60 - p40,"heat60_W":heat,
            "steam60_kg_s":at60["sgs"][k]["steam_kg_s"],"metal60_K":at60["sgs"][k]["metal_K"]}),
        );
        assert!(
            (p60 - p40).abs() < 50.,
            "SG {k} still drifting: {p40} -> {p60}"
        );
    }
    let events = relief_events(&out.events);
    // The trip cracks every valve on the ascending branch; with the primary
    // held the pressure settles between crack and full lift.
    assert!(out.stopped.is_none(), "{:?}", out.stopped);
    let peak = out
        .samples
        .iter()
        .flat_map(|s| {
            s["sgs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|g| g["p_Pa"].as_f64().unwrap())
        })
        .fold(0., f64::max);
    // Every valve unseats once at crack after the trip; with the primary held
    // the pressure settles between crack and full lift, so nothing reseats.
    assert_eq!(events.len(), 4, "{events:?}");
    assert!(events.iter().all(|e| e.2 == "Crack" && e.3 == "unseat" && e.0 > 60.));
    // Ledgers: secondary energy and metal each close on their integrated
    // receipts to the integrator's own tolerance scale.
    let energy = worst(&out.samples, "energyLedgerDefect_J");
    let metal = worst(&out.samples, "metalLedgerDefect_J");
    let mass = worst(&out.samples, "massDefect_kg");
    eprintln!(
        "{}",
        json!({"scope":"NOT-EVIDENCE probe: held SG primary, 0-60 s settle, TRIP at 60 s","settled":summary,
            "peakPressure_Pa":peak,"reliefEvents":events,"eventCounts":counts(&out.events),"ledgerWorst":{"energy_J":energy,"metal_J":metal,"mass_kg":mass},
            "end":{"p_Pa":[last(&out.samples,"p_Pa",0),last(&out.samples,"p_Pa",1)],
                "lifts":[out.samples.last().unwrap()["sgs"][0]["lifts"].clone(),out.samples.last().unwrap()["sgs"][1]["lifts"].clone()]},
            "counts":out.counts})
    );
    assert_eq!(mass, 0.);
    assert!(
        energy < 1e3 && metal < 1e3,
        "ledger defects {energy} J, {metal} J"
    );
}

/// A declared heat fixture drives the pressure through crack and full lift,
/// then the reliefs and a declared net cooling depressurize it to reseat:
/// each valve switches to the descending branch once and back once, with no
/// chatter. With zero net heat the descending flow vanishes linearly at
/// reseat, so the pressure would only approach 6.6 MPa; reseat needs cooling.
#[test]
#[ignore = "requires LD01_OPERATING_SG_SECTION and LD01_OPERATING_SG_PROBE"]
fn the_relief_memory_switches_once_each_way() {
    let (section, probe) = (section(), probe());
    let stocks = prepared_stocks(&If97, &section, &probe);
    // Synthetic fixture: 3 GW into each secondary for 4 s, then 0.3 GW out
    // of each; demand tripped at t = 0. Not a plant boundary.
    let heat = Heat::Schedule(vec![(0., vec![3e9, 3e9]), (4., vec![-3e8, -3e8])]);
    let (sys, y0) = Standalone::new(If97, &section, &stocks, heat, &probe).unwrap();
    let spec = Spec {
        t_end: 25.,
        rtol: 1e-6,
        atol: 1e-8,
        output_s: 0.05,
        commands: vec![(0., Command::TurbineTrip)],
        consistent_bound: 1e-9,
    };
    let out = run_tripped_at_start(sys, y0, &spec);
    write(
        "relief-cycle",
        &json!({"samples":out.samples,"events":out.events,"counts":out.counts}),
    );
    let events = relief_events(&out.events);
    let mut per_valve = std::collections::BTreeMap::<String, Vec<(String, String)>>::new();
    for e in &events {
        per_valve
            .entry(e.1.clone())
            .or_default()
            .push((e.2.clone(), e.3.clone()));
    }
    for (valve, seq) in &per_valve {
        let kept: Vec<(&str, &str)> = seq
            .iter()
            .filter(|(_, k)| k != "kink")
            .map(|(t, k)| (t.as_str(), k.as_str()))
            .collect();
        // Seated at the start: unseat at crack, switch at full lift, switch
        // back at reseat, then seat as the lift decays below its seat lift.
        assert_eq!(
            kept,
            vec![
                ("Crack", "unseat"),
                ("FullLift", "Ascending->Descending"),
                ("Reseat", "Descending->Ascending"),
                ("Seat", "seat")
            ],
            "{valve}: {seq:?}"
        );
    }
    assert_eq!(per_valve.len(), 4);
    let peak = out
        .samples
        .iter()
        .map(|s| s["sgs"][0]["p_Pa"].as_f64().unwrap())
        .fold(0., f64::max);
    assert!(peak > 7.0e6);
    // After reseat the lift decays toward zero on the ascending branch.
    let end_lift = out.samples.last().unwrap()["sgs"][0]["lifts"][0]
        .as_f64()
        .unwrap();
    let energy = worst(&out.samples, "energyLedgerDefect_J");
    // The declared cooling continues after reseat until the shrinking liquid
    // uncovers the crown: the guard ends the run as an S2 domain exit.
    let stopped = out.stopped.clone().unwrap_or_default();
    eprintln!(
        "{}",
        json!({"scope":"NOT-EVIDENCE probe: declared 3 GW/SG heat for 4 s, then -0.3 GW, TRIP at 0 s","stopped":stopped,
            "end_s":out.samples.last().unwrap()["t_s"],"endLiquid_m3":last(&out.samples,"Vl_m3",0),"peakPressure_Pa":peak,
            "reliefEvents":events,"eventCounts":counts(&out.events),"endLift":end_lift,"endPressure_Pa":last(&out.samples,"p_Pa",0),
            "ledgerWorstEnergy_J":energy,"counts":out.counts})
    );
    assert_eq!(end_lift, 0.);
    assert!(energy < 1e3, "ledger defect {energy} J");
    assert!(
        stopped.contains("S2 domain exit") && stopped.contains("crown first uncovery"),
        "{stopped}"
    );
}

/// The TRIP at the start time is a command before the first step.
fn run_tripped_at_start(
    mut sys: Standalone<If97>,
    y0: Vec<f64>,
    spec: &Spec,
) -> sg_harness::integrate::Outcome {
    use leitbild_operating_plant::joined::block::Secondary;
    let commands: Vec<(f64, Command)> =
        spec.commands.iter().filter(|c| c.0 > 0.).copied().collect();
    for c in spec.commands.iter().filter(|c| c.0 <= 0.) {
        Secondary::<If97>::command(&mut sys.secondary, c.0, c.1).unwrap();
    }
    let spec = Spec { commands, ..*spec };
    run(sys, 0., y0, &spec).unwrap()
}
