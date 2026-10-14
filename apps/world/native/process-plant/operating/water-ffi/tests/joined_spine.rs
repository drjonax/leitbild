//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-spine-at-power
//! The joined hot spine on the actual compiled packet, with maintained IF97.
//!
//! These are zero-time receipts and NOT-EVIDENCE probes of the joined
//! residual, not S2 gate runs: S2 is declared separately. A receipt is
//! written only to a new path, never over an existing file.
//! The harness needs stock IDA/KLU (`--features ida`).
#![cfg(feature = "ida")]
use leitbild_operating_plant::{
    joined::{self, census, nuclear::Nuclear, packet, solids::Solids},
    network::{Network, PzrPreparation, packet::Packet as NetworkPacket},
};
use leitbild_operating_water::If97;
use serde_json::{Value, json};
use std::path::Path;
#[path = "ld01_regression/wiki.rs"]
mod wiki;

/// The S1 harness's declared PZR preparation controls (s1_hydraulics.rs).
const PZR: PzrPreparation = PzrPreparation {
    pressure_tolerance_pa: 1e-6,
    max_passes: 50,
};

pub fn packet_bytes() -> (String, Vec<u8>) {
    let path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET")
        .expect("LD01_OPERATING_HOT_SPINE_PACKET names the compiled spine packet");
    let bytes = std::fs::read(&path).expect("packet");
    (path, bytes)
}

/// App and wiki provenance of a receipt: commits and whether the worktrees
/// were clean. The wiki is the archive or checkout named by `LD01_WIKI_ROOT`;
/// its tree hash is recorded and `LD01_WIKI_COMMIT` is verified against it
/// (`ld01_regression/wiki.rs`), so an archive's receipt names its commit.
pub fn provenance() -> Value {
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    };
    let wiki = std::env::var("LD01_WIKI_ROOT").ok();
    json!({
        "app_commit": git(&["rev-parse", "HEAD"]),
        "app_worktree_dirty": !git(&["status", "--porcelain"]).is_empty(),
        "wiki": wiki,
        "wiki_provenance": wiki.as_ref().map(|w| wiki::provenance(Path::new(w)).expect("wiki provenance")),
    })
}

/// Write a receipt to a NEW file named by `LD01_JOINED_RECEIPT`, if set.
fn write_receipt(receipt: &Value) {
    if let Some(path) = std::env::var_os("LD01_JOINED_RECEIPT") {
        let path = Path::new(&path);
        assert!(
            !path.exists(),
            "receipts are never overwritten: {}",
            path.display()
        );
        std::fs::write(path, serde_json::to_vec_pretty(receipt).unwrap()).unwrap();
    }
}

#[test]
#[ignore = "requires the actual compiled spine packet and maintained IF97"]
fn joined_census_against_table_1_1() {
    let (path, bytes) = packet_bytes();
    let network_packet: NetworkPacket = serde_json::from_slice(&bytes).expect("network packet");
    let joined_packet: packet::Packet = serde_json::from_slice(&bytes).expect("joined packet");
    let (network, prepared) = Network::new(&network_packet, If97, &PZR).expect("network");
    let cells = network.cell_layout.len();
    let nuclear = Nuclear::new(&joined_packet, cells).expect("nuclear block");
    let solids = Solids::new(&joined_packet, cells).expect("solids block");
    let network_layout = joined::network_layout(&network);
    network_layout.validate("network").unwrap();
    let ids = |l: &joined::block::Layout| l.ids();
    let (n_ids, k_ids, s_ids) = (
        prepared.differential.clone(),
        ids(nuclear.layout()),
        ids(solids.layout()),
    );
    assert_eq!(n_ids, ids(&network_layout), "network identity");
    let c = census::census(
        &[
            census::Composed {
                owner: "network",
                layout: &network_layout,
                differential: &n_ids,
            },
            census::Composed {
                owner: "nuclear",
                layout: nuclear.layout(),
                differential: &k_ids,
            },
            census::Composed {
                owner: "solids",
                layout: solids.layout(),
                differential: &s_ids,
            },
        ],
        &[joined::pending_secondary(), joined::pending_rods()],
    );
    let row = |name: &str| {
        c.entries
            .iter()
            .find(|e| e.row.starts_with(name))
            .unwrap_or_else(|| panic!("row {name}"))
            .clone()
    };
    assert_eq!(row("Regional N").composed, Some([24, 0]));
    assert_eq!(row("Material precursors").composed, Some([2316, 0]));
    assert_eq!(row("Fissile, fertile").composed, Some([2316, 0]));
    assert_eq!(row("Delayed-energy").composed, Some([9650, 0]));
    assert_eq!(row("Fuel 2 + clad 1").composed, Some([1158, 0]));
    assert_eq!(row("Massless").composed, Some([0, 1158]));
    assert_eq!(row("Helium").composed, Some([193, 0]));
    assert_eq!(row("Guide/plenum").composed, Some([1351, 0]));
    assert_eq!(row("SG metal").composed, Some([8, 0]));
    // Decision 0014 with amendment 6: the stratified cell has 19 coordinates.
    assert_eq!(row("Network cells").composed, Some([152, 35]));
    assert_eq!(row("Network faces").composed, Some([70, 0]));
    assert_eq!(row("RCP rotors").composed, Some([4, 0]));
    assert_eq!(c.composed, [17242, 1193, 18435]);
    assert_eq!(c.with_pending, [17302, 1301, 18603]);
    let histories = nuclear.histories();
    assert_eq!(histories.len(), 9650);
    let receipt = json!({
        "kind": "s2-joined-census",
        "status": "NOT-EVIDENCE zero-time allocation; no residual evaluated, no trajectory",
        "packet": path,
        "packet_sha256": sha256(&bytes),
        "packet_identity": joined_packet.identity,
        "provenance": provenance(),
        "census": c,
        "linear_histories": {
            "rows": histories.len(),
            "structure": "E' = y F - lambda E: constant diagonal -lambda and constant feed coefficient y; feed = the carrier's achieved fissions (23 groups) or fertile captures (2 groups)",
            "decay_per_s_range": [
                histories.iter().map(|h| h.decay_per_s).fold(f64::INFINITY, f64::min),
                histories.iter().map(|h| h.decay_per_s).fold(0., f64::max)
            ]
        },
        "network": {"dimension": network.dimension(), "regular_cells": cells, "faces": network.face_count(), "rotors": network.rotor_count()},
    });
    println!("{}", serde_json::to_string(&receipt).unwrap());
    write_receipt(&receipt);
}

pub fn sha256(bytes: &[u8]) -> String {
    let out = std::process::Command::new("shasum")
        .args(["-a", "256"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            child.stdin.take().unwrap().write_all(bytes)?;
            child.wait_with_output()
        })
        .expect("shasum");
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_string()
}

pub mod z1 {
    use super::*;
    use leitbild_operating_plant::{
        joined::{
            block::SecondaryView,
            operator::{Joined, RodPort, SecondaryPort},
        },
        network::{
            RotorState, ToleranceClasses, consistent_start,
            prepare::{self, OperatingPoint, Settings},
        },
        rotor::{Shaft, SpeedRequest, Support},
        thermal::{Scalar, WaterProperties},
    };
    use leitbild_operating_water::{
        ida::{Ida, Initial},
        network::Integrated,
    };

    /// The S1 harness's hydrostatic preparation settings (s1_hydraulics.rs).
    pub const SETTINGS: Settings = Settings {
        pressure_tolerance_pa: 1e-6,
        max_passes: 50,
        level_match_m: 1e-9,
        eos_row_bound: 1e-12,
        tree_face_bound_pa: 1e-6,
        representation_search: 8,
    };
    pub fn rotors() -> Vec<RotorState> {
        vec![
            RotorState {
                support: Support::Supported(SpeedRequest::Nominal),
                shaft: Shaft::Free,
            };
            4
        ]
    }
    /// The `ld01-s1-gates` block of the wiki named by `LD01_WIKI_ROOT`.
    pub fn s1_gates() -> Value {
        let wiki = std::env::var("LD01_WIKI_ROOT").expect("LD01_WIKI_ROOT");
        let page = format!(
            "{wiki}/world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md"
        );
        let text = std::fs::read_to_string(&page).unwrap();
        let open = "```ld01-s1-gates\n";
        let start = text.find(open).expect("ld01-s1-gates") + open.len();
        let end = start + text[start..].find("\n```").unwrap();
        serde_json::from_str(&text[start..end]).unwrap()
    }
    pub fn classes(gates: &Value) -> ToleranceClasses {
        let f = |k: &str| gates[k].as_f64().unwrap_or_else(|| panic!("gate {k}"));
        ToleranceClasses {
            relative: f("relativeTolerance"),
            stock_scaled: f("stockScaledAbsolute"),
            tracer_scaled: f("tracerScaledAbsolute"),
            rotor_scaled: f("rotorScaledAbsolute"),
            volume_flow_m3_s: f("volumeFlowAbsolute_m3_s"),
        }
    }
    pub fn cpu_s() -> f64 {
        #[repr(C)]
        struct Timespec {
            seconds: i64,
            nanoseconds: i64,
        }
        unsafe extern "C" {
            fn clock_gettime(clock: i32, out: *mut Timespec) -> i32;
        }
        let mut t = Timespec {
            seconds: 0,
            nanoseconds: 0,
        };
        // SAFETY: one live output; CLOCK_PROCESS_CPUTIME_ID on macOS is 12.
        assert_eq!(unsafe { clock_gettime(12, &mut t) }, 0);
        t.seconds as f64 + 1e-9 * t.nanoseconds as f64
    }

    /// S1's declared network-only settling from rest (NOT-EVIDENCE probe of
    /// an S1 trajectory, run only to export the settled flows): the RCPs
    /// start from rest through the drive law and the network settles under
    /// S1's own tolerance classes and caps. Returns the settled liquid
    /// volume flow of every face, the rotors' angular momenta and a summary.
    pub fn s1_settled_flows(packet: &NetworkPacket, gates: &Value) -> (Vec<f64>, Vec<f64>, Value) {
        let started = cpu_s();
        let point = OperatingPoint::from(&packet.preparation.operating_point);
        let (network, prepared, _) =
            prepare::prepare(packet, If97, &point, &rotors(), &SETTINGS).expect("hydrostatic");
        let mut y = prepared.y.clone();
        for i in &network.rotor_index {
            y[*i] = 0.;
        }
        let classes = classes(gates);
        let atol = network.absolute_tolerances(&y, classes).unwrap();
        let rtol = classes.relative;
        let ids = prepared.differential.clone();
        let weights: Vec<f64> = y
            .iter()
            .zip(&atol)
            .map(|(v, a)| 1. / (rtol * v.abs() + a))
            .collect();
        let mut probe = network;
        let (yp, pair) = consistent_start(&mut probe, 0., &mut y, &ids, &weights, 1e-12, 2)
            .expect("S1 exact consistent start");
        let nonnegative = probe.nonnegative_stocks();
        let system = Integrated::colored(probe).unwrap();
        let mut ida = Ida::new(
            system,
            Initial {
                time: 0.,
                y: &y,
                yp: &yp,
                differential: &ids,
                absolute_tolerance: &atol,
                relative_tolerance: rtol,
            },
        )
        .unwrap();
        let max_order = gates["maxOrder"].as_u64().unwrap() as usize;
        ida.set_max_order(max_order).unwrap();
        ida.constrain_nonnegative(&nonnegative).unwrap();
        let settling = &gates["settling"];
        let cap = settling["maxSimulated_s"].as_f64().unwrap();
        let window = settling["window_s"].as_f64().unwrap();
        let rotor_rel = settling["rotorSpeedRelative"].as_f64().unwrap();
        let flow_rel = settling["loopFlowRelativeChange"].as_f64().unwrap();
        ida.stop_at(cap).unwrap();
        let face = |id: &str| {
            packet
                .mechanics
                .faces
                .iter()
                .position(|f| f.id == id)
                .unwrap()
        };
        let loops = [face("RETURN.A->DOWN"), face("RETURN.B->DOWN")];
        let (mut yv, mut ypv) = (y.clone(), yp.clone());
        let mut history: Vec<(f64, [f64; 2], Vec<f64>)> = Vec::new();
        let mut t = 0.;
        let settled_at = loop {
            t += 1.;
            ida.advance(t, &mut yv, &mut ypv)
                .unwrap()
                .reached()
                .unwrap();
            let net = &mut ida.system_mut().network;
            net.evaluate(t, &yv, &ypv, None, 0., None).unwrap();
            let flows = loops.map(|f| net.chart(f, 0).unwrap().mass_flow_kg_s.value);
            let omega: Vec<f64> = net
                .rotor_index
                .iter()
                .map(|i| yv[*i] * net.scales()[*i] / net.rotor_inertia())
                .collect();
            let w0 = net.drive().reference_omega_rad_s;
            history.push((t, flows, omega.clone()));
            let earlier = history.iter().rev().find(|h| h.0 <= t - window);
            let rested = earlier.is_some_and(|e| {
                omega.iter().all(|w| ((w - w0) / w0).abs() < rotor_rel)
                    && (0..2).all(|k| ((flows[k] - e.1[k]) / flows[k]).abs() < flow_rel)
            });
            if rested {
                break Some(t);
            }
            if t >= cap {
                break None;
            }
        };
        let stats = ida.stats().unwrap();
        let net = &mut ida.system_mut().network;
        net.evaluate(t, &yv, &ypv, None, 0., None).unwrap();
        let flows: Vec<f64> = (0..net.face_count())
            .map(|f| net.chart(f, 0).map_or(0., |c| c.volume_flow_m3_s.value))
            .collect();
        let momenta: Vec<f64> = net
            .rotor_index
            .iter()
            .map(|i| yv[*i] * net.scales()[*i])
            .collect();
        let last = history.last().unwrap();
        let summary = json!({
            "scope": "NOT-EVIDENCE: S1's declared network-only settling, run only to export settled flows (memo §3 (A))",
            "settled_at_s": settled_at,
            "loop_mass_flow_kg_s": last.1,
            "rotor_speed_rad_s": last.2,
            "steps": stats.steps, "residuals": stats.residuals, "jacobians": stats.jacobians,
            "error_failures": stats.error_failures, "convergence_failures": stats.convergence_failures,
            "initial_pair": format!("{pair:?}"),
            "cpu_s": cpu_s() - started,
        });
        assert!(settled_at.is_some(), "S1 settling did not rest: {summary}");
        (flows, momenta, summary)
    }

    /// The joined state at the hot reference (memo §3 (B)): a fresh
    /// hydrostatic preparation at the hot-reference water energies with the
    /// declared PZR, then the S1-settled volume flows and rotor momenta
    /// transferred by the flowing preparation.
    pub fn composed(
        packet: &NetworkPacket,
        flows: &[f64],
        momenta: &[f64],
    ) -> (
        leitbild_operating_plant::network::Network<If97>,
        Vec<f64>,
        Vec<f64>,
        Value,
    ) {
        let point = OperatingPoint::from(&packet.preparation.operating_point);
        let (mut network, mut prepared, hydrostatic) =
            prepare::prepare(packet, If97, &point, &rotors(), &SETTINGS).expect("hydrostatic");
        let receipt = prepare::compose_flows(
            &mut network,
            packet,
            &mut prepared.y,
            hydrostatic.port_pressure_pa,
            flows,
            momenta,
            &SETTINGS,
        )
        .expect("flowing preparation");
        let ids = prepared.differential.clone();
        (
            network,
            prepared.y,
            ids,
            serde_json::to_value(&receipt).unwrap(),
        )
    }

    /// The packet's prepared SG secondary and rod pose as zero-time ports.
    pub fn prepared_ports(joined_packet: &packet::Packet) -> (SecondaryPort<If97>, RodPort<If97>) {
        let views = joined_packet
            .thermal
            .secondaries
            .iter()
            .map(|c| {
                let p = Scalar::constant(c.pressure_pa);
                let t = WaterProperties::saturation(&If97, p).unwrap().temperature;
                SecondaryView {
                    pressure: p,
                    saturation_temperature: Scalar::constant(t.value),
                    liquid_volume: Scalar::constant(c.liquid_volume_m3),
                    steam_present: c.liquid_volume_m3 < c.volume_m3,
                }
            })
            .collect();
        (
            SecondaryPort::Prepared(views),
            RodPort::Prepared(
                joined_packet
                    .feedback_reference
                    .achieved_rod_travel_m
                    .clone(),
            ),
        )
    }

    /// Rows by census class: largest |scaled row|, its label and its
    /// physical value (scaled times row scale).
    pub fn by_class(joined: &Joined<If97>) -> Value {
        let mut classes: std::collections::BTreeMap<String, (f64, String, f64, usize)> =
            Default::default();
        let mut k = 0;
        for (owner, layout) in joined.layouts() {
            for i in 0..layout.len() {
                let r = joined.rows()[k].value;
                let key = format!("{owner}/{:?}", layout.classes[i]);
                let e = classes.entry(key).or_insert((0., String::new(), 0., 0));
                e.3 += 1;
                if r.is_nan() || r.abs() > e.0 {
                    *e = (
                        r.abs(),
                        layout.labels[i].clone(),
                        r * layout.row_scales[i],
                        e.3,
                    );
                }
                k += 1;
            }
        }
        json!(
            classes
                .into_iter()
                .map(|(k, (m, label, physical, count))| (
                    k,
                    json!({"rows":count,"max_abs_scaled":m,"at":label,"physical":physical})
                ))
                .collect::<serde_json::Map<String, Value>>()
        )
    }

    pub fn heats(joined: &Joined<If97>) -> Value {
        let h = joined.heats();
        let sum = |v: &[Scalar]| v.iter().map(|x| x.value).sum::<f64>();
        json!({
            "released_w": h.nuclear.released_w.value,
            "event_w": h.nuclear.event_w.value,
            "stored_history_rate_w": h.nuclear.stored_rate_w.value,
            "fuel_w": sum(&h.nuclear.fuel_w),
            "direct_coolant_w": h.coolant_w.value,
            "clad_to_water_w": h.solids.clad_to_water_w.value,
            "passive_to_water_w": h.solids.passive_to_water_w.value,
            "primary_to_sg_metal_w": sum(&h.solids.primary_to_metal_w),
            "sg_metal_to_secondary_w": h.solids.secondary_w.iter().map(|x| x.value).collect::<Vec<_>>(),
            "solid_stored_rate_w": h.solids.stored_rate_w.value,
        })
    }
}

#[test]
#[ignore = "requires the actual compiled spine packet, the wiki, maintained IF97 and stock IDA/KLU"]
fn z1_composed_residual_at_the_hot_reference() {
    z1_probe(false);
}

#[test]
#[ignore = "requires the actual compiled joined packet, the wiki, maintained IF97 and stock IDA/KLU"]
fn z1_full_composition_at_the_hot_reference() {
    z1_probe(true);
}

/// Z1 at the hot reference: the composed state of memo §3 (A)-(C), its
/// residual by class, the exact consistent start and its cost. `full`
/// composes the SG secondary and rod owners from the joined packet's
/// sections; otherwise their ports hold the packet's prepared views.
fn z1_probe(full: bool) {
    use leitbild_operating_plant::{
        initialization::SurfacePolicy,
        joined::operator::{Joined, RodPort, SecondaryPort},
        rods::{RodBlock, Section as RodSection},
        sg::{packet::Section as SecondarySection, secondary::Secondaries},
        thermal::{Scalar, WaterProperties},
    };
    let started = z1::cpu_s();
    let (path, bytes) = packet_bytes();
    let network_packet: NetworkPacket = serde_json::from_slice(&bytes).expect("network packet");
    let joined_packet: packet::Packet = serde_json::from_slice(&bytes).expect("joined packet");
    let raw: Value = serde_json::from_slice(&bytes).expect("packet json");
    let gates = z1::s1_gates();
    let (flows, momenta, s1) = z1::s1_settled_flows(&network_packet, &gates);
    let (network, y_network, network_ids, flowing) =
        z1::composed(&network_packet, &flows, &momenta);
    let (secondary, rods) = if full {
        let section: SecondarySection =
            serde_json::from_value(raw["secondary"].clone()).expect("secondary section");
        let rods: RodSection = serde_json::from_value(raw["rods"].clone()).expect("rods section");
        (
            SecondaryPort::Owner(Box::new(
                Secondaries::new(&section, &joined_packet.thermal.secondaries, &If97)
                    .expect("SG secondary owner"),
            )),
            RodPort::Owner(Box::new(
                RodBlock::from_packet(&rods, &network_packet).expect("rod owner"),
            )),
        )
    } else {
        z1::prepared_ports(&joined_packet)
    };
    let mut joined = Joined::new(
        network,
        &network_packet,
        &joined_packet,
        If97,
        secondary,
        rods,
    )
    .expect("joined operator");
    let mut y = joined.prepared(&y_network).unwrap();
    let ids = joined.differential(&network_ids);
    let zero = vec![0.; y.len()];
    let owners_prepared = if full {
        let done = joined
            .prepare_owners(0., &mut y)
            .expect("owner preparation");
        json!(done.iter().map(|t| t.receipt.clone()).collect::<Vec<_>>())
    } else {
        Value::Null
    };
    joined
        .evaluate(0., &y, &zero, None, 0., None)
        .expect("prepared residual");
    let prepared_rows = z1::by_class(&joined);
    let prepared_heats = z1::heats(&joined);
    let policy = SurfacePolicy {
        maximum_residual_w: 1e-3,
        maximum_correction_k: 1e-6,
        maximum_iterations: 16,
        maximum_backtracks: 12,
    };
    let surfaces = joined
        .initialize_surfaces(0., &mut y, policy)
        .expect("surfaces");
    let worst_surface = surfaces
        .iter()
        .map(|s| s.residual_w.iter().fold(0., |a: f64, r| a.max(r.abs())))
        .fold(0., f64::max);
    joined
        .evaluate(0., &y, &zero, None, 0., None)
        .expect("initialized residual");
    let initialized_rows = z1::by_class(&joined);
    let initialized_heats = z1::heats(&joined);
    let budget = joined.network.current_budget(
        &y[..joined.offsets().nuclear],
        &zero[..joined.offsets().nuclear],
    );
    // Cost of one value residual and one seeded residual at this state.
    let calls = 20;
    let timer = z1::cpu_s();
    for _ in 0..calls {
        joined.evaluate(0., &y, &zero, None, 0., None).unwrap();
    }
    let value_s = (z1::cpu_s() - timer) / calls as f64;
    let seed: Vec<f64> = (0..y.len())
        .map(|i| if i % 7 == 0 { 1. } else { 0. })
        .collect();
    let timer = z1::cpu_s();
    for _ in 0..calls {
        joined
            .evaluate(0., &y, &zero, Some(&seed), 1., None)
            .unwrap();
    }
    let seeded_s = (z1::cpu_s() - timer) / calls as f64;
    // The exact consistent start of the composed coordinates at t = 0.
    let classes = z1::classes(&gates);
    let n_net = joined.offsets().nuclear;
    let mut atol = joined
        .network
        .absolute_tolerances(&y[..n_net], classes)
        .unwrap();
    // G12: S1's scaled 1e-8 absolute floor for every new coordinate class.
    atol.resize(y.len(), classes.stock_scaled);
    let weights: Vec<f64> = y
        .iter()
        .zip(&atol)
        .map(|(v, a)| 1. / (classes.relative * v.abs() + a))
        .collect();
    let (pattern_nnz, colors) = {
        let (p, c) = joined.structure().unwrap();
        (p.nonzeros(), c.count())
    };
    let bound = 1e-12;
    // Lead decision S2-D4: the start runs on JAC's block assembly with
    // cached symbolic analyses; `LD01_START_ASSEMBLY=colored` runs the
    // colored reference. The block structure is compiled once per mode,
    // outside the start.
    let start_assembly = std::env::var("LD01_START_ASSEMBLY").unwrap_or_else(|_| "blocks".into());
    let timer = z1::cpu_s();
    let structure = match start_assembly.as_str() {
        "blocks" => Some(
            leitbild_operating_plant::joined::blocks::JoinedJacobian::compile(&mut joined, 0., &y)
                .expect("block structure"),
        ),
        "colored" => None,
        other => panic!("LD01_START_ASSEMBLY {other}: blocks or colored"),
    };
    let compile_cpu_s = z1::cpu_s() - timer;
    let mut analyses = leitbild_operating_water::joined::Analyses::default();
    let y_before = y.clone();
    let start_at = |joined: &mut Joined<If97>,
                    y: &mut [f64],
                    analyses: &mut leitbild_operating_water::joined::Analyses| {
        let matrices = match &structure {
            Some(structure) => leitbild_operating_water::joined::Matrices::Blocks {
                structure,
                analyses,
            },
            None => leitbild_operating_water::joined::Matrices::Colored,
        };
        let timer = z1::cpu_s();
        let start = leitbild_operating_water::joined::consistent_start(
            joined, matrices, 0., y, &ids, &weights, bound, 3,
        );
        (start, z1::cpu_s() - timer)
    };
    let (start, start_cpu_s) = start_at(&mut joined, &mut y, &mut analyses);
    // The same start again from the same state, on the analyses the first
    // made: a restart's own cost.
    let mut y_repeat = y_before.clone();
    let (repeat, repeat_cpu_s) = start_at(&mut joined, &mut y_repeat, &mut analyses);
    let repeat_receipt = match (&start, &repeat) {
        (Ok((yp, _)), Ok((yp_repeat, r))) => json!({
            "cpu_s": repeat_cpu_s, "analyses": r.analyses,
            "jacobian_wall_s": r.jacobian_s, "klu_factor_wall_s": r.factor_s, "klu_solve_wall_s": r.solve_s,
            "bitwise_equal_to_first": yp == yp_repeat && y == y_repeat}),
        (_, Err(e)) => json!({"refused": format!("{e:?}")}),
        _ => Value::Null,
    };
    let start_receipt = match &start {
        Ok((yp, r)) => {
            joined.evaluate(0., &y, yp, None, 0., None).unwrap();
            let after = z1::by_class(&joined);
            // Initial rates by class, physical: max |y' scale| and its label.
            let mut rates: std::collections::BTreeMap<String, (f64, String)> = Default::default();
            let mut k = 0;
            for (owner, layout) in joined.layouts() {
                for i in 0..layout.len() {
                    let v = yp[k] * layout.scales[i];
                    let e = rates
                        .entry(format!("{owner}/{:?}", layout.classes[i]))
                        .or_insert((0., String::new()));
                    if v.abs() > e.0 {
                        *e = (v.abs(), layout.labels[i].clone());
                    }
                    k += 1;
                }
            }
            json!({"assembly": r.assembly, "nonzeros": r.nonzeros, "analyses": r.analyses, "klu_analyze_wall_s": r.analyze_s,
                "bound": r.bound, "constraint_before": [r.constraint_before.value, r.constraint_before.row],
                "constraint_after": [r.constraint_after.value, r.constraint_after.row], "projection_passes": r.projection_passes,
                "correction": [r.correction.value, r.correction.row], "correction_wrms": r.correction_wrms,
                "residual": [r.residual.value, r.residual.row], "constraint_rate": [r.constraint_rate.value, r.constraint_rate.row], "rate_passes": r.rate_passes,
                "jacobian_cpu_wall_s": r.jacobian_s, "klu_factor_wall_s": r.factor_s, "klu_solve_wall_s": r.solve_s,
                "rows_by_class_after": after,
                "initial_rate_max_physical": rates.into_iter().map(|(k,(v,l))| (k, json!({"max_abs": v, "at": l}))).collect::<serde_json::Map<String, Value>>()})
        }
        Err(e) => json!({"refused": format!("{e:?}")}),
    };
    // Random-direction check of the colored Jacobian (cj = 1): the assembled
    // matrix times d against one seeded evaluation in direction d.
    let yp_now = start
        .as_ref()
        .map(|(yp, _)| yp.clone())
        .unwrap_or(zero.clone());
    let mut values = vec![0.; pattern_nnz];
    joined.jacobian(0., 1., &y, &yp_now, &mut values).unwrap();
    let (pointers, indices) = {
        let (p, _) = joined.structure().unwrap();
        (p.pointers().to_vec(), p.indices().to_vec())
    };
    let mut state = 0x9e3779b97f4a7c15u64;
    let mut random = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state >> 11) as f64 / (1u64 << 53) as f64 - 0.5
    };
    let mut direction_checks = Vec::new();
    for _ in 0..3 {
        let d: Vec<f64> = (0..y.len()).map(|_| random()).collect();
        let mut product = vec![0.; y.len()];
        for j in 0..y.len() {
            for q in pointers[j]..pointers[j + 1] {
                product[indices[q]] += values[q] * d[j];
            }
        }
        joined
            .evaluate(0., &y, &yp_now, Some(&d), 1., None)
            .unwrap();
        let (mut worst, mut norm) = (0_f64, 0_f64);
        for (r, p) in joined.rows().iter().zip(&product) {
            worst = worst.max((r.direction - p).abs());
            norm = norm.max(r.direction.abs());
        }
        direction_checks.push(json!({"max_abs_difference": worst, "max_abs_direction": norm, "relative": worst / norm}));
    }
    // G17: the duty the constant A/B steam demand implies against the
    // prepared history's release, at the prepared SG pressure and at Z2's
    // emergent 6.3631 MPa, and the RCP heat composed.
    let g17 = if full {
        let feed = &raw["secondary"]["feed"];
        let fp = feed["pressure_Pa"].as_f64().unwrap();
        let ft = feed["temperature_K"].as_f64().unwrap();
        let h_feed = WaterProperties::liquid(&If97, Scalar::constant(fp), Scalar::constant(ft))
            .unwrap()
            .enthalpy
            .value;
        let demand: Vec<f64> = raw["secondary"]["steamGenerators"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| g["steamDemand_kg_s"].as_f64().unwrap())
            .collect();
        let duty = |p: f64| {
            let hg = WaterProperties::saturation(&If97, Scalar::constant(p))
                .unwrap()
                .vapor
                .enthalpy
                .value;
            demand.iter().map(|m| m * (hg - h_feed)).sum::<f64>()
        };
        let released = joined.heats().nuclear.released_w.value;
        let shaft = budget["once_paid_shaft_power_w"].as_f64().unwrap();
        let prepared_p = joined_packet.thermal.secondaries[0].pressure_pa;
        let at = |p: f64| {
            let d = duty(p);
            json!({"sg_pressure_pa": p, "sg_demand_duty_w": d, "implied_core_power_w": d - shaft,
                "relative_to_history_release": (d - shaft) / released - 1.})
        };
        json!({"history_prepared_release_w": released, "rcp_once_paid_shaft_power_w": shaft,
            "feed_enthalpy_j_kg": h_feed, "steam_demand_kg_s": demand,
            "at_prepared_sg_pressure": at(prepared_p), "at_z2_emergent_sg_pressure": at(6.3631e6),
            "other_heat": "PZR boundary closed (no heater, wall loss or relief composed); no other sink or source in the composition",
            "confirmed_above": 2e-3})
    } else {
        Value::Null
    };
    let receipt = json!({
        "kind": if full { "s2-z1-full-composition" } else { "s2-z1-part1-composed-residual" },
        "owners_prepared": owners_prepared,
        "g17_power_basis": g17,
        "pattern": {"nonzeros": pattern_nnz, "colors": colors},
        "consistent_start": start_receipt,
        "consistent_start_cpu_s": start_cpu_s,
        "consistent_start_repeat": repeat_receipt,
        "start_assembly": {"assembly": start_assembly, "block_compile_cpu_s": compile_cpu_s,
            "basis": "lead decision S2-D4: block assembly on the element-exact pattern with KLU's symbolic analyses cached; colored is the reference (LD01_START_ASSEMBLY=colored)"},
        "colored_jacobian_random_directions": direction_checks,
        "status": if full {
            "NOT-EVIDENCE zero-time receipt; S2 is not declared. Z1 on the full composition: network, nuclear, solids, the SG secondary owner and the rod owner with its guide currents prepared at the composed state. The PZR boundary is closed: shell metal and relief pending (G6), heaters at zero by G6"
        } else {
            "NOT-EVIDENCE zero-time receipt; S2 is not declared. Part 1 of Z1: the SG secondary and rod owners are pending, so their ports hold the packet's prepared views (6 MPa, Tsat, 72 m3, steam present) and travel (2.8 m, compiled volumes, no guide passage). The exact consistent start is of the composed coordinates at t = 0 with those ports held; the PZR boundary is closed (shell metal and relief pending, heaters at zero by G6)"
        },
        "packet": path,
        "packet_sha256": sha256(&bytes),
        "provenance": provenance(),
        "s1_settling": s1,
        "flowing_preparation": flowing,
        "dimension": joined.dimension(),
        "offsets": joined.offsets(),
        "algebraic": ids.iter().filter(|v| **v == 0.).count(),
        "prepared": {"rows_by_class": prepared_rows, "heats": prepared_heats},
        "surface_initialization": {"policy": "max residual 1e-3 W, max undamped correction 1e-6 K, 16 iterations, 12 backtracks (operating-thermal.md)", "worst_residual_w": worst_surface,
            "max_iterations": surfaces.iter().map(|s| s.iterations).max()},
        "initialized": {"rows_by_class": initialized_rows, "heats": initialized_heats, "network_budget": budget},
        "cost": {"process_cpu_s_per_value_residual": value_s, "process_cpu_s_per_seeded_residual": seeded_s, "calls": calls,
            "load_average": String::from_utf8_lossy(&std::process::Command::new("sysctl").args(["-n","vm.loadavg"]).output().unwrap().stdout).trim().to_string()},
        "total_cpu_s": z1::cpu_s() - started,
    });
    println!("{}", serde_json::to_string(&receipt).unwrap());
    write_receipt(&receipt);
}

/// The full composition at the hot reference, consistently started.
pub struct Started {
    pub joined: leitbild_operating_plant::joined::operator::Joined<If97>,
    pub y: Vec<f64>,
    pub yp: Vec<f64>,
    /// Differential identity (joined, then the network's own), absolute
    /// tolerances and relative tolerance.
    pub ids: Vec<f64>,
    pub network_ids: Vec<f64>,
    pub atol: Vec<f64>,
    pub rtol: f64,
    /// A receipt of the preparation.
    pub receipt: Value,
    /// The composed state before its consistent start.
    pub unstarted: Vec<f64>,
    /// JAC's block structure compiled at the composed state, and the
    /// symbolic analyses the start made on it (lead decision S2-D4).
    pub structure: leitbild_operating_plant::joined::blocks::JoinedJacobian,
    pub analyses: leitbild_operating_water::joined::Analyses,
}

/// The full composition at the hot reference, consistently started: memo
/// §3 (A)-(D), the start on the block assembly (lead decision S2-D4).
pub fn started_full_composition() -> Started {
    use leitbild_operating_plant::{
        initialization::SurfacePolicy,
        joined::operator::{Joined, RodPort, SecondaryPort},
        rods::{RodBlock, Section as RodSection},
        sg::{packet::Section as SecondarySection, secondary::Secondaries},
    };
    let (path, bytes) = packet_bytes();
    let network_packet: NetworkPacket = serde_json::from_slice(&bytes).expect("network packet");
    let joined_packet: packet::Packet = serde_json::from_slice(&bytes).expect("joined packet");
    let raw: Value = serde_json::from_slice(&bytes).expect("packet json");
    let gates = z1::s1_gates();
    let (flows, momenta, s1) = z1::s1_settled_flows(&network_packet, &gates);
    let (network, y_network, network_ids, flowing) =
        z1::composed(&network_packet, &flows, &momenta);
    let section: SecondarySection =
        serde_json::from_value(raw["secondary"].clone()).expect("secondary section");
    let rods: RodSection = serde_json::from_value(raw["rods"].clone()).expect("rods section");
    let mut joined = Joined::new(
        network,
        &network_packet,
        &joined_packet,
        If97,
        SecondaryPort::Owner(Box::new(
            Secondaries::new(&section, &joined_packet.thermal.secondaries, &If97)
                .expect("SG secondary owner"),
        )),
        RodPort::Owner(Box::new(
            RodBlock::from_packet(&rods, &network_packet).expect("rod owner"),
        )),
    )
    .expect("joined operator");
    let mut y = joined.prepared(&y_network).unwrap();
    let ids = joined.differential(&network_ids);
    let owners = joined
        .prepare_owners(0., &mut y)
        .expect("owner preparation");
    let surfaces = joined
        .initialize_surfaces(
            0.,
            &mut y,
            SurfacePolicy {
                maximum_residual_w: 1e-3,
                maximum_correction_k: 1e-6,
                maximum_iterations: 16,
                maximum_backtracks: 12,
            },
        )
        .expect("surfaces");
    let classes = z1::classes(&gates);
    let n_net = joined.offsets().nuclear;
    let mut atol = joined
        .network
        .absolute_tolerances(&y[..n_net], classes)
        .unwrap();
    atol.resize(y.len(), classes.stock_scaled);
    let weights: Vec<f64> = y
        .iter()
        .zip(&atol)
        .map(|(v, a)| 1. / (classes.relative * v.abs() + a))
        .collect();
    let unstarted = y.clone();
    let timer = z1::cpu_s();
    let structure =
        leitbild_operating_plant::joined::blocks::JoinedJacobian::compile(&mut joined, 0., &y)
            .expect("block structure");
    let compile_cpu_s = z1::cpu_s() - timer;
    let mut analyses = leitbild_operating_water::joined::Analyses::default();
    let timer = z1::cpu_s();
    let (yp, start) = leitbild_operating_water::joined::consistent_start(
        &mut joined,
        leitbild_operating_water::joined::Matrices::Blocks {
            structure: &structure,
            analyses: &mut analyses,
        },
        0.,
        &mut y,
        &ids,
        &weights,
        1e-12,
        3,
    )
    .expect("exact consistent start");
    let start_cpu_s = z1::cpu_s() - timer;
    let receipt = json!({
        "packet": path, "packet_sha256": sha256(&bytes), "provenance": provenance(),
        "s1_settling": s1, "flowing_preparation_max_cycle_drive_pa": flowing["max_cycle_drive_pa"],
        "owners_prepared": owners.iter().map(|t| t.receipt.clone()).collect::<Vec<_>>(),
        "surfaces_worst_residual_w": surfaces.iter().map(|s| s.residual_w.iter().fold(0., |a: f64, r| a.max(r.abs()))).fold(0., f64::max),
        "start": {"residual": [start.residual.value, start.residual.row], "constraint_rate": [start.constraint_rate.value, start.constraint_rate.row],
            "correction_wrms": start.correction_wrms, "projection_passes": start.projection_passes, "rate_passes": start.rate_passes,
            "assembly": start.assembly, "analyses": start.analyses, "cpu_s": start_cpu_s, "block_compile_cpu_s": compile_cpu_s},
        "dimension": y.len(), "algebraic": ids.iter().filter(|v| **v == 0.).count(),
        "tolerances": {"relative": classes.relative, "network": "S1's tolerance classes (ld01-s1-gates)", "new_classes_scaled_absolute": classes.stock_scaled, "basis": "G12"},
    });
    Started {
        joined,
        y,
        yp,
        ids,
        network_ids,
        atol,
        rtol: classes.relative,
        receipt,
        unstarted,
        structure,
        analyses,
    }
}

/// One observation of the joined state at an accepted output.
pub fn observe(
    joined: &mut leitbild_operating_plant::joined::operator::Joined<If97>,
    t: f64,
    y: &[f64],
    yp: &[f64],
) -> Value {
    joined
        .evaluate(t, y, yp, None, 0., None)
        .expect("observed state");
    let heats = joined.heats();
    let temps = joined.temperatures();
    let net = &joined.network;
    let layouts = joined.layouts();
    let mut k = 0;
    let mut sg = Vec::new();
    for (owner, layout) in &layouts {
        for (i, label) in layout.labels.iter().enumerate() {
            if *owner == "secondary" && (label.ends_with(".p_s") || label.ends_with(".V_l")) {
                sg.push(json!({"coordinate": label, "value": y[k] * layout.scales[i]}));
            }
            k += 1;
        }
    }
    let taps = net.pzr_taps().ok();
    let fuel_max = temps.fuel.iter().map(|f| f[0].value).fold(0., f64::max);
    let clad_max = temps.fuel.iter().map(|f| f[2].value).fold(0., f64::max);
    let metal: Vec<f64> = temps.metal.iter().map(|m| m.value).collect();
    let liquid_t: Vec<f64> = (0..net.cell_layout.len())
        .map(|c| {
            let l = net.cell_layout[c];
            let p = y[l.base] * net.scales()[l.base];
            let m = y[l.mass[0]] * net.scales()[l.mass[0]];
            let u = y[l.energy[0]] * net.scales()[l.energy[0]];
            use leitbild_operating_plant::network::Properties;
            let q = net.properties().caloric(false, p, u / m, false).unwrap();
            net.properties().values(&q).temperature_k
        })
        .collect();
    let loop_kg_s =
        [22usize, 30].map(|f| net.chart(f, 0).map_or(f64::NAN, |c| c.mass_flow_kg_s.value));
    let return_drive = [22usize, 29].map(|f| net.face_drive(f, 0).value);
    json!({
        "t_s": t,
        "released_w": heats.nuclear.released_w.value,
        "fuel_w": heats.nuclear.fuel_w.iter().map(|x| x.value).sum::<f64>(),
        "clad_to_water_w": heats.solids.clad_to_water_w.value,
        "primary_to_sg_metal_w": heats.solids.primary_to_metal_w.iter().map(|x| x.value).sum::<f64>(),
        "sg_metal_to_secondary_w": heats.solids.secondary_w.iter().map(|x| x.value).collect::<Vec<_>>(),
        "sg": sg,
        "sg_metal_k": metal,
        "fuel_inner_max_k": fuel_max, "clad_mean_max_k": clad_max,
        "liquid_t_k": liquid_t,
        "pzr_pt1_pa": taps.map(|t| t.pt1_pa.value), "pzr_collapsed_level_m": taps.map(|t| t.collapsed_level_m.value),
        "loop_kg_s": loop_kg_s,
        "return_face_drive_pa": return_drive,
        "reactivity_max_abs": joined.nuclear().feedback_output().map(|o| o.regions.iter().map(|r| r.reactivity.value.abs()).fold(0., f64::max)),
    })
}

#[test]
#[ignore = "NOT-EVIDENCE zero-time check: requires the joined packet, the wiki, IF97 and stock IDA/KLU"]
fn the_holding_opening_releases_the_held_clusters_at_its_stop_and_restarts_exactly() {
    use leitbild_operating_plant::joined::block::Command;
    use leitbild_operating_water::{
        ida::{Ida, Initial},
        joined::{Discrete, Integrated, Restart, discrete_restart},
    };
    let Started {
        mut joined,
        y,
        yp,
        ids,
        network_ids,
        atol,
        rtol,
        structure,
        analyses,
        ..
    } = started_full_composition();
    let algebraic = |ids: &[f64]| ids.iter().filter(|v| **v == 0.).count();
    let held = algebraic(&ids);
    let mut y = y;
    // The manual turbine TRIP at t = 0: the holding circuit opens after its
    // declared delay and the STOP ramp ends after its travel.
    let trip = joined.command(0., &mut y, Command::TurbineTrip).unwrap();
    assert_eq!(
        trip.len(),
        2,
        "both owners take the command; nothing is due at once"
    );
    let open = joined.next_time_event(0.).expect("the holding opening");
    let rods = joined.rods().unwrap();
    assert_eq!(rods.next_time_event(0.), Some(open));
    assert!(joined.secondary().unwrap().next_time_event(0.).unwrap() > open);
    let restart = Restart {
        newton_coefficient: NEWTON_COEFFICIENT,
        delta_cj_lsetup: DELTA_CJ_LSETUP,
        first_step_s: FIRST_STEP_S,
        start_bound: 1e-12,
        start_passes: 2,
        bound_placement: 1e-12,
    };
    let mut ida = Ida::new(
        Integrated::from_blocks(joined, structure, analyses).unwrap(),
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: rtol,
        },
    )
    .unwrap();
    // Every joined solve is on AMD (decision 0013); COLAMD is unusable on
    // the exact pattern.
    assert_eq!(
        leitbild_operating_water::ida::System::klu_ordering(ida.system()),
        leitbild_operating_water::ida::KluOrdering::Amd
    );
    restart.configure(&mut ida).unwrap();
    let analyses_before = ida.system().analyses().made();
    // The stop at the opening, without stepping: the release root t - open
    // is exactly zero there, so only the time event can release.
    let timer = z1::cpu_s();
    let restarted = discrete_restart(
        &mut ida,
        open,
        Discrete::TimeEvent,
        &mut y,
        &network_ids,
        &atol,
        rtol,
        &restart,
    )
    .unwrap();
    let restart_cpu_s = z1::cpu_s() - timer;
    let (done, yp_open, report) = (&restarted.transactions, &restarted.yp, &restarted.report);
    // The release changes the algebraic set: the projection's analysis is
    // made again, the rate system's is reused.
    assert_eq!(report.assembly, "blocks");
    assert_eq!(report.analyses[0], 0, "the rate analysis is reused");
    assert_eq!(
        ida.system().analyses().made()[0],
        analyses_before[0],
        "no new rate analysis"
    );
    assert!(
        restarted.placements.is_empty(),
        "{:?}",
        restarted.placements
    );
    assert_eq!(done.len(), 1, "the rod owner's opening only: {done:?}");
    let releases = done[0].receipt["rods"].as_array().unwrap();
    let clusters = ida.system().joined.rods().unwrap().clusters();
    assert_eq!(releases.len(), clusters, "every held cluster releases");
    assert!(releases.iter().all(|r| r["event"] == "grip release"));
    let ids_open = ida.system().joined.differential(&network_ids);
    assert_eq!(
        algebraic(&ids_open),
        held - clusters,
        "each released cluster's speed becomes differential"
    );
    assert!(report.residual.value <= 1e-12 && report.constraint_rate.value <= 1e-12);
    assert!(yp_open.iter().all(|v| v.is_finite()));
    // Transacted once: nothing more is due at the opening.
    assert!(
        ida.system_mut()
            .joined
            .time_events(open, &mut y)
            .unwrap()
            .is_empty()
    );
    let end = ida
        .system()
        .joined
        .next_time_event(open)
        .expect("the ramp end");
    let ramp = ida.system_mut().joined.time_events(end, &mut y).unwrap();
    assert_eq!(ramp.len(), 1);
    assert_eq!(ramp[0].receipt["stateChanged"], json!(false));
    let receipt = json!({
        "kind": "s2-holding-opening-time-event",
        "status": "NOT-EVIDENCE zero-time check; no trajectory",
        "opening_s": open, "ramp_end_s": end, "released_clusters": clusters,
        "algebraic_before": held, "algebraic_after": algebraic(&ids_open),
        "start": {"residual": report.residual.value, "constraint_rate": report.constraint_rate.value,
            "projection_passes": report.projection_passes, "rate_passes": report.rate_passes,
            "assembly": report.assembly, "analyses_made": report.analyses, "jacobian_wall_s": report.jacobian_s,
            "klu_analyze_wall_s": report.analyze_s, "klu_factor_wall_s": report.factor_s, "klu_solve_wall_s": report.solve_s},
        "restart_cpu_s": restart_cpu_s,
        "configuration": {"newtonCoefficient": NEWTON_COEFFICIENT, "deltaCjLSetup": DELTA_CJ_LSETUP, "firstStep_s": FIRST_STEP_S},
    });
    println!("{}", serde_json::to_string(&receipt).unwrap());
}

/// Column-relative difference of a block matrix against the colored
/// reference on every column: per column, the largest |difference| of any
/// row stored by either over the column's largest |colored| entry (JAC's
/// oracle measure), and the same over the larger of that and `scale`'s
/// column (for `B`, formed as a difference of two assemblies, `A`'s).
fn column_relative(
    colored_pattern: &leitbild_operating_plant::sparse::Pattern,
    colored: &[f64],
    blocks_pattern: &leitbild_operating_plant::sparse::Pattern,
    blocks: &[f64],
    scale: Option<&[f64]>,
) -> Value {
    let n = colored_pattern.columns();
    let (mut worst, mut worst_at, mut outside) = (0_f64, Value::Null, 0usize);
    let mut worst_scaled = 0_f64;
    for j in 0..n {
        let mut entries: std::collections::BTreeMap<usize, [f64; 2]> = Default::default();
        let (cp, bp) = (colored_pattern.pointers(), blocks_pattern.pointers());
        let (cs, bs) = (cp[j]..cp[j + 1], bp[j]..bp[j + 1]);
        for (row, v) in colored_pattern.indices()[cs.clone()]
            .iter()
            .zip(&colored[cs.clone()])
        {
            entries.entry(*row).or_default()[0] = *v;
            if *v != 0. && blocks_pattern.position(*row, j).is_none() {
                outside += 1;
            }
        }
        for (row, v) in blocks_pattern.indices()[bs.clone()].iter().zip(&blocks[bs]) {
            entries.entry(*row).or_default()[1] = *v;
        }
        let column = entries.values().map(|e| e[0].abs()).fold(0., f64::max);
        let other = scale.map_or(0., |a| a[cs].iter().map(|v| v.abs()).fold(0., f64::max));
        for (row, e) in &entries {
            let d = (e[0] - e[1]).abs();
            let relative = d / column.max(1e-300);
            if relative > worst {
                worst = relative;
                worst_at = json!({"row": row, "column": j, "colored": e[0], "blocks": e[1]});
            }
            worst_scaled = worst_scaled.max(d / column.max(other).max(1e-300));
        }
    }
    json!({"worst_column_relative": worst, "worst_at": worst_at,
        "worst_over_the_larger_of_the_column_and_a": worst_scaled,
        "colored_nonzeros_outside_block_pattern": outside, "columns": n})
}

/// Lead decision S2-D4's check of the block start against the colored
/// reference (NOT-EVIDENCE zero-time check): `A = dF/dy` (cj = 0) and
/// `B = dF/dy'` (the cj = 1 assembly less A, as the start forms it), from
/// JAC's block assembly and from the colored assemblies, column-relative on
/// every column, at the composed state and at the released state (the TG
/// TRIP's holding opening: all 52 clusters free); and the two consistent
/// starts from the same state at each.
#[test]
#[ignore = "NOT-EVIDENCE zero-time check: requires the joined packet, the wiki, IF97 and stock IDA/KLU"]
fn the_block_start_matrices_match_the_colored_reference_at_the_composed_and_released_states() {
    use leitbild_operating_plant::joined::{
        block::Command,
        blocks::{Classes, jacobian_blocks},
        operator::Joined,
    };
    use leitbild_operating_water::joined::{Analyses, Matrices, consistent_start};
    let started = z1::cpu_s();
    let Started {
        mut joined,
        y,
        ids,
        network_ids,
        atol,
        rtol,
        unstarted,
        structure,
        mut analyses,
        receipt: preparation,
        ..
    } = started_full_composition();
    let n = y.len();
    let zero = vec![0.; n];
    let matrices = |joined: &mut Joined<If97>, t: f64, y: &[f64]| -> Value {
        let colored_pattern = joined.structure().unwrap().0.clone();
        let mut ca = vec![0.; colored_pattern.nonzeros()];
        let mut cab = ca.clone();
        joined.jacobian(t, 0., y, &zero, &mut ca).unwrap();
        joined.jacobian(t, 1., y, &zero, &mut cab).unwrap();
        let bp = &structure.pattern;
        let mut ba = vec![0.; bp.nonzeros()];
        let mut bab = ba.clone();
        jacobian_blocks(joined, &structure, t, 0., y, &zero, &mut ba, Classes::ALL).unwrap();
        jacobian_blocks(joined, &structure, t, 1., y, &zero, &mut bab, Classes::ALL).unwrap();
        let cb: Vec<f64> = cab.iter().zip(&ca).map(|(x, a)| x - a).collect();
        let bb: Vec<f64> = bab.iter().zip(&ba).map(|(x, a)| x - a).collect();
        // B as the start forms it carries one rounding of A + B in each
        // path; at cj = 2^20 (exact scaling) that rounding is of B's own
        // size, so this B compares the two assemblies' dF/dy' itself.
        let big = 1048576.;
        let mut cbig = vec![0.; colored_pattern.nonzeros()];
        let mut bbig = vec![0.; bp.nonzeros()];
        joined.jacobian(t, big, y, &zero, &mut cbig).unwrap();
        jacobian_blocks(
            joined,
            &structure,
            t,
            big,
            y,
            &zero,
            &mut bbig,
            Classes::ALL,
        )
        .unwrap();
        let cb_big: Vec<f64> = cbig.iter().zip(&ca).map(|(x, a)| (x - a) / big).collect();
        let bb_big: Vec<f64> = bbig.iter().zip(&ba).map(|(x, a)| (x - a) / big).collect();
        json!({"a": column_relative(&colored_pattern, &ca, bp, &ba, None),
            "b": column_relative(&colored_pattern, &cb_big, bp, &bb_big, None),
            "b_as_the_start_forms_it_at_cj_1": column_relative(&colored_pattern, &cb, bp, &bb, Some(&ca)),
            "b_definition": "b: (J(cj = 2^20) - J(cj = 0)) / 2^20 on each path; b_as_the_start_forms_it_at_cj_1: J(cj = 1) - J(cj = 0), whose rounding of A + B is up to one ulp of the column's A in either path"})
    };
    let weights = |y: &[f64]| -> Vec<f64> {
        y.iter()
            .zip(&atol)
            .map(|(v, a)| 1. / (rtol * v.abs() + a))
            .collect()
    };
    // Both starts from the same state: projected states and rates.
    let starts = |joined: &mut Joined<If97>,
                  analyses: &mut Analyses,
                  t: f64,
                  y0: &[f64],
                  ids: &[f64]|
     -> Value {
        let w = weights(y0);
        let (mut yb, mut yc) = (y0.to_vec(), y0.to_vec());
        let timer = z1::cpu_s();
        let (pb, rb) = consistent_start(
            joined,
            Matrices::Blocks {
                structure: &structure,
                analyses,
            },
            t,
            &mut yb,
            ids,
            &w,
            1e-12,
            3,
        )
        .expect("block start");
        let block_cpu_s = z1::cpu_s() - timer;
        let timer = z1::cpu_s();
        let (pc, rc) = consistent_start(joined, Matrices::Colored, t, &mut yc, ids, &w, 1e-12, 3)
            .expect("colored start");
        let colored_cpu_s = z1::cpu_s() - timer;
        let (mut dy, mut dyp, mut ypmax) = (0_f64, (0_f64, 0usize), 0_f64);
        for i in 0..n {
            dy = dy.max((yb[i] - yc[i]).abs() * w[i]);
            if (pb[i] - pc[i]).abs() > dyp.0 {
                dyp = ((pb[i] - pc[i]).abs(), i);
            }
            ypmax = ypmax.max(pc[i].abs());
        }
        let summary = |r: &leitbild_operating_water::joined::Report, cpu: f64| {
            json!({"assembly": r.assembly, "cpu_s": cpu, "residual": [r.residual.value, r.residual.row],
                "constraint_rate": [r.constraint_rate.value, r.constraint_rate.row],
                "projection_passes": r.projection_passes, "rate_passes": r.rate_passes,
                "correction_wrms": r.correction_wrms, "analyses_made": r.analyses,
                "jacobian_wall_s": r.jacobian_s, "klu_analyze_wall_s": r.analyze_s,
                "klu_factor_wall_s": r.factor_s, "klu_solve_wall_s": r.solve_s})
        };
        json!({"blocks": summary(&rb, block_cpu_s), "colored": summary(&rc, colored_cpu_s),
            "projected_state_max_weighted_difference": dy,
            "rates_max_abs_difference": dyp.0, "rates_max_at": dyp.1,
            "rates_max_abs_difference_over_max_abs_rate": dyp.0 / ypmax.max(1e-300)})
    };
    let composed_matrices = matrices(&mut joined, 0., &y);
    let composed_starts = starts(&mut joined, &mut analyses, 0., &unstarted, &ids);
    // The released state: the manual turbine TRIP at t = 0 and its holding
    // opening, transacted at its time.
    let mut released = y.clone();
    joined
        .command(0., &mut released, Command::TurbineTrip)
        .unwrap();
    let open = joined.next_time_event(0.).expect("the holding opening");
    let done = joined.time_events(open, &mut released).unwrap();
    let ids_open = joined.differential(&network_ids);
    let algebraic = |ids: &[f64]| ids.iter().filter(|v| **v == 0.).count();
    let released_matrices = matrices(&mut joined, open, &released);
    let released_starts = starts(&mut joined, &mut analyses, open, &released, &ids_open);
    let receipt = json!({
        "kind": "s2-block-start-against-colored",
        "status": "NOT-EVIDENCE zero-time check of lead decision S2-D4; no trajectory",
        "preparation": preparation,
        "criterion": {"matrices_column_relative": 1e-13, "start_bound": 1e-12},
        "composed": {"t_s": 0., "algebraic": algebraic(&ids), "matrices": composed_matrices, "starts": composed_starts},
        "released": {"t_s": open, "transactions": done.len(), "algebraic": algebraic(&ids_open),
            "matrices": released_matrices, "starts": released_starts},
        "analyses_made_in_total": analyses.made(),
        "total_cpu_s": z1::cpu_s() - started,
        "load_average": String::from_utf8_lossy(&std::process::Command::new("sysctl").args(["-n","vm.loadavg"]).output().unwrap().stdout).trim().to_string(),
    });
    println!("{}", serde_json::to_string(&receipt).unwrap());
    write_receipt(&receipt);
    for state in ["composed", "released"] {
        for m in ["a", "b"] {
            let c = &receipt[state]["matrices"][m];
            assert_eq!(
                c["colored_nonzeros_outside_block_pattern"],
                json!(0),
                "{state} {m}"
            );
            assert!(
                c["worst_column_relative"].as_f64().unwrap() <= 1e-13,
                "{state} {m}: {c}"
            );
        }
    }
}

/// Per-block wall time of the block Jacobians so far: the local coupler's
/// calls by kind, and the rest (the network's element replay, the nuclear
/// template and partials, the base evaluation and the chained ports), per
/// Jacobian. Timing only; no value changes.
fn jacobian_attribution(
    joined: &leitbild_operating_plant::joined::operator::Joined<If97>,
) -> Value {
    let c = joined.counters;
    let k = joined.coupler_counters();
    let n = c.jacobians.max(1) as f64;
    let kinds = [
        ("network_columns_local", k.local),
        ("solid_columns", k.solid_columns),
        ("secondary_columns", k.secondary_columns),
        ("rod_columns", k.rod_columns),
        ("fuel_heat_columns", k.fuel_heat_columns),
        ("secondary_heat_columns", k.secondary_heat_columns),
    ];
    let coupler: f64 = kinds.iter().map(|(_, t)| t.wall_s).sum();
    let mut per = serde_json::Map::new();
    for (name, t) in kinds {
        per.insert(
            name.into(),
            json!({"wall_s_per_jacobian": t.wall_s / n, "calls_per_jacobian": t.calls as f64 / n}),
        );
    }
    for (name, t) in [
        ("within_local_solids", k.local_solids),
        ("within_local_rods", k.local_rods),
    ] {
        per.insert(
            name.into(),
            json!({"wall_s_per_jacobian": t.wall_s / n, "calls_per_jacobian": t.calls as f64 / n}),
        );
    }
    per.insert(
        "rest_network_replay_nuclear_base_ports".into(),
        json!({"wall_s_per_jacobian": (c.jacobian_wall_s - coupler) / n}),
    );
    json!({"jacobians": c.jacobians, "wall_s_per_jacobian": c.jacobian_wall_s / n, "by_kind": per})
}

#[test]
#[ignore = "NOT-EVIDENCE probe: requires the joined packet, the wiki, IF97 and stock IDA/KLU"]
fn reactivity_decomposition_at_the_prepared_and_settled_states() {
    use leitbild_operating_plant::{
        joined::nuclear::FeedbackInputs,
        network::Properties,
        source_feedback::{Conditions, ReactivityTerms},
        thermal::Scalar,
    };
    use leitbild_operating_water::{
        ida::{Ida, Initial},
        joined::{Integrated, Restart},
    };
    let started = z1::cpu_s();
    let Started {
        mut joined,
        y,
        yp,
        ids,
        atol,
        rtol,
        receipt: preparation,
        ..
    } = started_full_composition();
    let settle_s: f64 = std::env::var("LD01_SETTLING_CAP_S").map_or(600., |v| v.parse().unwrap());
    joined.evaluate(0., &y, &yp, None, 0., None).unwrap();
    let inputs0 = joined.nuclear().feedback_inputs();
    let travel0: Vec<Scalar> = joined.travel().to_vec();
    // The same settling as probe 4: BDF order 2 on the block Jacobian, the
    // stock coefficient with dcj 0.1 and G13's first step.
    let nonnegative = joined.network.nonnegative_stocks();
    let mut ida = Ida::new(
        Integrated::with_blocks(joined, 0., &y).unwrap(),
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: rtol,
        },
    )
    .unwrap();
    ida.set_max_order(2).unwrap();
    ida.constrain_nonnegative(&nonnegative).unwrap();
    Restart {
        newton_coefficient: NEWTON_COEFFICIENT,
        delta_cj_lsetup: DELTA_CJ_LSETUP,
        first_step_s: FIRST_STEP_S,
        start_bound: 1e-12,
        start_passes: 2,
        bound_placement: 1e-12,
    }
    .configure(&mut ida)
    .unwrap();
    ida.stop_at(settle_s).unwrap();
    let (mut ys, mut yps) = (y.clone(), yp.clone());
    let mut t = 0.;
    while t < settle_s {
        t = ida
            .advance((t + ADVANCE_CHUNK_S).min(settle_s), &mut ys, &mut yps)
            .unwrap()
            .reached()
            .unwrap();
    }
    let joined = &mut ida.system_mut().joined;
    joined.evaluate(t, &ys, &yps, None, 0., None).unwrap();
    let inputs1 = joined.nuclear().feedback_inputs();
    let travel1: Vec<Scalar> = joined.travel().to_vec();
    let model = joined.nuclear().feedback();
    let terms = |i: &FeedbackInputs, travel: &[Scalar]| -> Vec<ReactivityTerms> {
        let c = |v: &[f64]| -> Vec<Scalar> { v.iter().map(|x| Scalar::constant(*x)).collect() };
        let (f, d, b, p, m) = (
            c(&i.fuel_temperature_k),
            c(&i.water_density_kg_m3),
            c(&i.boron_ppm_eq),
            c(&i.pressure_pa),
            c(&i.moderator_temperature_k),
        );
        let (fi, xe, sm, op) = (
            c(&i.fissile_atoms),
            c(&i.xenon_atoms),
            c(&i.samarium_atoms),
            c(&i.capture_loss_change_m2),
        );
        let mut out = vec![ReactivityTerms::default(); i.neutrons.len()];
        model
            .reactivity_terms(
                Conditions {
                    fuel_temperature_k: &f,
                    water_density_kg_m3: &d,
                    boron_ppm_eq: &b,
                    pressure_pa: &p,
                    moderator_temperature_k: &m,
                    fissile_atoms: &fi,
                    xenon_atoms: &xe,
                    samarium_atoms: &sm,
                    capture_loss_change_m2: &op,
                    achieved_rod_travel_m: travel,
                    capsule_age_s: Scalar::constant(0.),
                },
                &mut out,
            )
            .unwrap();
        out
    };
    // State A: the prepared coolant with the settled fuel; state B: settled.
    let mut prepared_with_settled_fuel = inputs0.clone();
    prepared_with_settled_fuel.fuel_temperature_k = inputs1.fuel_temperature_k.clone();
    // The settled liquid's density at the prepared pressure: the moderator
    // temperature part; the rest of the density change is the pressure part.
    let mut thermal_only = inputs0.clone();
    thermal_only.water_density_kg_m3 = inputs0
        .pressure_pa
        .iter()
        .zip(&inputs1.moderator_temperature_k)
        .map(|(p, t)| If97.forward(false, *p, *t).unwrap().density_kg_m3)
        .collect();
    let base0: Vec<f64> = inputs0
        .pressure_pa
        .iter()
        .zip(&inputs0.moderator_temperature_k)
        .map(|(p, t)| If97.forward(false, *p, *t).unwrap().density_kg_m3)
        .collect();
    let mut eos0 = inputs0.clone();
    eos0.water_density_kg_m3 = base0;
    let t0 = terms(&inputs0, &travel0);
    let ta = terms(&prepared_with_settled_fuel, &travel0);
    let tb = terms(&inputs1, &travel1);
    let tt = terms(&thermal_only, &travel0);
    let te = terms(&eos0, &travel0);
    // Region weights: the neutron population, and its square (first-order
    // perturbation with a self-adjoint approximation), at each state.
    let weigh = |n: &[f64], power: i32| -> Vec<f64> {
        let w: Vec<f64> = n.iter().map(|v| v.powi(power)).collect();
        let total: f64 = w.iter().sum();
        w.iter().map(|v| v / total).collect()
    };
    let pcm = 1e5;
    let summary = |name: &str, f: &dyn Fn(usize) -> f64, n: &[f64]| -> Value {
        let per: Vec<f64> = (0..n.len()).map(|i| f(i) * pcm).collect();
        let avg = |p: i32| per.iter().zip(weigh(n, p)).map(|(v, w)| v * w).sum::<f64>();
        json!({"term": name, "pcm_population_weighted": avg(1), "pcm_population_squared_weighted": avg(2),
            "pcm_min": per.iter().cloned().fold(f64::INFINITY, f64::min), "pcm_max": per.iter().cloned().fold(f64::NEG_INFINITY, f64::max)})
    };
    let n0 = &inputs0.neutrons;
    let n1 = &inputs1.neutrons;
    let d = |a: &[ReactivityTerms],
             b: &[ReactivityTerms],
             g: fn(&ReactivityTerms) -> f64,
             i: usize| g(&b[i]) - g(&a[i]);
    let moderator = |r: &ReactivityTerms| r.water_density + r.boron;
    let state_a = vec![
        summary("doppler", &|i| d(&t0, &ta, |r| r.doppler, i), n0),
        summary("total", &|i| ta[i].total() - t0[i].total(), n0),
    ];
    let state_b = vec![
        summary("doppler", &|i| d(&t0, &tb, |r| r.doppler, i), n1),
        summary(
            "moderator_density_temperature (water and boron)",
            &|i| d(&te, &tt, moderator, i),
            n1,
        ),
        summary(
            "moderator_density_pressure_and_rest (water and boron)",
            &|i| moderator(&tb[i]) - moderator(&t0[i]) - (moderator(&tt[i]) - moderator(&te[i])),
            n1,
        ),
        summary(
            "moderator_density_total (water and boron)",
            &|i| d(&t0, &tb, moderator, i),
            n1,
        ),
        summary("rods", &|i| d(&t0, &tb, |r| r.rods, i), n1),
        summary("fissile", &|i| d(&t0, &tb, |r| r.fissile, i), n1),
        summary("xenon", &|i| d(&t0, &tb, |r| r.xenon, i), n1),
        summary("samarium", &|i| d(&t0, &tb, |r| r.samarium, i), n1),
        summary(
            "nonpoison_capture",
            &|i| d(&t0, &tb, |r| r.nonpoison_capture, i),
            n1,
        ),
        summary("total_change", &|i| tb[i].total() - t0[i].total(), n1),
        summary("total_at_state", &|i| tb[i].total(), n1),
    ];
    let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
    let receipt = json!({
        "kind": "s2-reactivity-decomposition",
        "status": "NOT-EVIDENCE probe for G18's condition; terms are source_feedback::Model::reactivity_terms, the same formulas as evaluate",
        "preparation": preparation,
        "settled_s": t,
        "configuration": {"maxOrder": 2, "newtonCoefficient": NEWTON_COEFFICIENT, "deltaCjLSetup": DELTA_CJ_LSETUP, "firstStep_s": FIRST_STEP_S, "jacobian": "block"},
        "states": {
            "prepared": {"fuel_feedback_k_mean": mean(&inputs0.fuel_temperature_k), "moderator_k_mean": mean(&inputs0.moderator_temperature_k), "pressure_pa_mean": mean(&inputs0.pressure_pa), "density_mean": mean(&inputs0.water_density_kg_m3), "reactivity_total_pcm_population_weighted": summary("t", &|i| t0[i].total(), n0)["pcm_population_weighted"]},
            "settled": {"fuel_feedback_k_mean": mean(&inputs1.fuel_temperature_k), "fuel_feedback_k_min": inputs1.fuel_temperature_k.iter().cloned().fold(f64::INFINITY, f64::min), "fuel_feedback_k_max": inputs1.fuel_temperature_k.iter().cloned().fold(f64::NEG_INFINITY, f64::max), "moderator_k_mean": mean(&inputs1.moderator_temperature_k), "pressure_pa_mean": mean(&inputs1.pressure_pa), "density_mean": mean(&inputs1.water_density_kg_m3)},
        },
        "prepared_coolant_with_settled_fuel_minus_prepared": state_a,
        "settled_minus_prepared": state_b,
        "region_terms_pcm": {"prepared": t0.iter().map(|r| json!(r)).collect::<Vec<_>>(), "settled": tb.iter().map(|r| json!(r)).collect::<Vec<_>>()},
        "cpu_s": z1::cpu_s() - started,
    });
    if let Some(path) = std::env::var_os("LD01_SETTLED_STATE_OUT") {
        assert!(!Path::new(&path).exists(), "states are never overwritten");
        std::fs::write(
            &path,
            serde_json::to_vec(
                &json!({"t_s": t, "y": ys, "yp": yps, "packet": preparation["packet"]}),
            )
            .unwrap(),
        )
        .unwrap();
    }
    write_receipt(&receipt);
    println!("{}", serde_json::to_string(&json!({"a": receipt["prepared_coolant_with_settled_fuel_minus_prepared"], "b": receipt["settled_minus_prepared"], "states": receipt["states"]})).unwrap());
}

/// S2's Newton configuration (claude/ld01-wiki c968921, "Configuration
/// superseded the same day"): stock's own 0.33 Newton coefficient and an
/// iteration-matrix refresh when cj changes by 10% (IDASetDeltaCjLSetup).
pub const NEWTON_COEFFICIENT: f64 = 0.33;
pub const DELTA_CJ_LSETUP: f64 = 0.1;
/// G13: the first step at every restart (s).
pub const FIRST_STEP_S: f64 = 1e-4;
/// Output target spacing of one stock IDA call (s).
const ADVANCE_CHUNK_S: f64 = 0.01;

#[test]
#[ignore = "NOT-EVIDENCE settling probe: requires the joined packet, the wiki, IF97 and stock IDA/KLU"]
fn settling_probe_toward_a_consistent_100_percent_state() {
    use leitbild_operating_water::{
        ida::{Advance, Ida, Initial},
        joined::Integrated,
    };
    let started = z1::cpu_s();
    let Started {
        joined,
        y: y0,
        yp: yp0,
        ids,
        atol,
        rtol,
        receipt: preparation,
        ..
    } = started_full_composition();
    let preparation_cpu_s = z1::cpu_s() - started;
    // Declared NOT-EVIDENCE caps and criteria: the S2 memo's draft settling
    // block (s2-design-memo §7), not a declared S2 gate.
    let cap_s: f64 = std::env::var("LD01_SETTLING_CAP_S").map_or(600., |v| v.parse().unwrap());
    let cpu_cap_s: f64 =
        std::env::var("LD01_SETTLING_CPU_CAP_S").map_or(2400., |v| v.parse().unwrap());
    let window_s = 20.;
    let log = std::env::var_os("LD01_SETTLING_LOG").map(|p| {
        assert!(
            !std::path::Path::new(&p).exists(),
            "logs are never overwritten"
        );
        std::fs::File::create(p).unwrap()
    });
    let nonnegative = joined.network.nonnegative_stocks();
    // JAC's block assembly by default (checked against the colored matrix
    // entry by entry); `LD01_SETTLING_ASSEMBLY=colored` runs the reference.
    let assembly = std::env::var("LD01_SETTLING_ASSEMBLY").unwrap_or_else(|_| "blocks".into());
    let system = match assembly.as_str() {
        "blocks" => Integrated::with_blocks(joined, 0., &y0),
        "colored" => Integrated::new(joined),
        other => panic!("LD01_SETTLING_ASSEMBLY {other}: blocks or colored"),
    }
    .expect("integrable joined system");
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
    .expect("stock IDA");
    ida.set_max_order(2).unwrap();
    ida.constrain_nonnegative(&nonnegative).unwrap();
    // S2's numerical configuration at every start and restart, set
    // explicitly because stock IDAReInit retains it: the stock Newton
    // coefficient with dcj 0.1 (claude/ld01-wiki c968921) and G13's 1e-4 s
    // first step, applied here at the start as well so the start does not
    // depend on the output grid.
    ida.set_nonlinear_convergence_coefficient(NEWTON_COEFFICIENT)
        .unwrap();
    ida.set_delta_cj_lsetup(DELTA_CJ_LSETUP).unwrap();
    ida.set_init_step(FIRST_STEP_S).unwrap();
    ida.stop_at(cap_s).unwrap();
    let (mut y, mut yp) = (y0.clone(), yp0.clone());
    let mut t = 0.;
    let mut samples: Vec<Value> = Vec::new();
    let mut events = Vec::new();
    let mut counts = (0i64, 0i64, 0i64, 0i64, 0i64, 0i64);
    let push = |samples: &mut Vec<Value>, s: Value, log: &Option<std::fs::File>| {
        if let Some(mut f) = log.as_ref() {
            use std::io::Write;
            writeln!(f, "{}", serde_json::to_string(&s).unwrap()).unwrap();
        }
        samples.push(s);
    };
    let s0 = observe(&mut ida.system_mut().joined, 0., &y, &yp);
    push(&mut samples, s0, &log);
    let settled = |samples: &[Value]| -> Option<Value> {
        let last = samples.last()?;
        let t = last["t_s"].as_f64()?;
        let earlier = samples
            .iter()
            .rev()
            .find(|s| s["t_s"].as_f64().unwrap() <= t - window_s)?;
        let rel = |k: &str| (last[k].as_f64()? / earlier[k].as_f64()? - 1.).abs().into();
        let power: Option<f64> = rel("released_w");
        let cell_dt = last["liquid_t_k"]
            .as_array()?
            .iter()
            .zip(earlier["liquid_t_k"].as_array()?)
            .map(|(a, b)| (a.as_f64().unwrap() - b.as_f64().unwrap()).abs())
            .fold(0., f64::max);
        let pt1 = (last["pzr_pt1_pa"].as_f64()? - earlier["pzr_pt1_pa"].as_f64()?).abs();
        let ps = last["sg"]
            .as_array()?
            .iter()
            .zip(earlier["sg"].as_array()?)
            .filter(|(a, _)| a["coordinate"].as_str().unwrap().ends_with(".p_s"))
            .map(|(a, b)| (a["value"].as_f64().unwrap() - b["value"].as_f64().unwrap()).abs())
            .fold(0., f64::max);
        let power = power?;
        let ok = power < 1e-4 && cell_dt < 0.01 && pt1 < 1000. && ps < 1000.;
        ok.then(|| json!({"window_s": window_s, "power_relative": power, "cell_temperature_k": cell_dt, "pzr_pt1_pa": pt1, "sg_pressure_pa": ps}))
    };
    let mut verdict = Value::Null;
    let mut failure = None;
    let mut next_output = 1.;
    while t < cap_s {
        if z1::cpu_s() - started > cpu_cap_s {
            failure = Some(format!("probe CPU cap {cpu_cap_s} s reached at t = {t} s"));
            break;
        }
        let event = ida.system().joined.next_time_event(t);
        if let Some(e) = event {
            // Settling declares none; stop exactly at it, never step past.
            ida.stop_at(e.min(cap_s)).unwrap();
        }
        // Stock IDA_NORMAL steps past an output target and interpolates, so
        // the chunk changes no step; it only keeps each call within stock's
        // per-call step limit.
        let target = event
            .map_or(next_output, |e| e.min(next_output))
            .min(cap_s)
            .min(t + ADVANCE_CHUNK_S);
        match ida.advance(target, &mut y, &mut yp) {
            Ok(Advance::Reached(time)) => {
                t = time;
                if (t - next_output).abs() < 1e-9 || t >= cap_s {
                    let s = observe(&mut ida.system_mut().joined, t, &y, &yp);
                    let mut s = s;
                    let st = ida.stats().unwrap();
                    s["ida"] = json!({"steps": counts.0 + st.steps, "residuals": counts.1 + st.residuals, "jacobians": counts.2 + st.jacobians,
                        "nonlinear_iterations": counts.3 + st.nonlinear_iterations, "error_failures": counts.4 + st.error_failures,
                        "convergence_failures": counts.5 + st.convergence_failures, "last_step_s": st.last_step, "last_order": st.last_order});
                    s["cpu_s"] = json!(z1::cpu_s() - started);
                    let c = ida.system().joined.counters;
                    s["joined_counters"] = json!(c);
                    s["coupler_counters"] = json!(ida.system().joined.coupler_counters());
                    eprintln!(
                        "settling t = {t} s: P = {:.6e} W, steps {}, residuals {}, Jacobians {}, CPU {:.1} s",
                        s["released_w"].as_f64().unwrap_or(f64::NAN),
                        s["ida"]["steps"],
                        s["ida"]["residuals"],
                        s["ida"]["jacobians"],
                        s["cpu_s"].as_f64().unwrap_or(f64::NAN)
                    );
                    push(&mut samples, s, &log);
                    next_output += 1.;
                    if let Some(v) = settled(&samples) {
                        verdict = json!({"settled_at_s": t, "criteria": v});
                        break;
                    }
                }
                if event.is_some_and(|e| (e - t).abs() < 1e-12) {
                    failure = Some(format!(
                        "an owner time event at {t} s; settling declares none"
                    ));
                    break;
                }
            }
            Ok(Advance::Root { time, directions }) => {
                events.push(json!({"t_s": time, "roots": directions}));
                failure = Some(format!(
                    "a root at {time} s during settling: {directions:?} (settling declares no event)"
                ));
                t = time;
                break;
            }
            Err(e) => {
                failure = Some(e);
                break;
            }
        }
    }
    let st = ida.stats().ok();
    let internal_s = st.as_ref().map(|s| s.internal_time);
    counts.0 += st.as_ref().map_or(0, |s| s.steps);
    counts.1 += st.as_ref().map_or(0, |s| s.residuals);
    counts.2 += st.as_ref().map_or(0, |s| s.jacobians);
    let total = z1::cpu_s() - started;
    let c = ida.system().joined.counters;
    let simulated = internal_s
        .filter(|_| failure.is_some())
        .map_or(t, |i| i.max(t));
    let receipt = json!({
        "kind": "s2-settling-probe",
        "predecessors": ["settling-probe-1-log.jsonl (ac0f7106) was stopped before its first 1 s output: its 0.01 Newton coefficient was superseded the same day",
            "settling-probe-2-log.jsonl (1590dae0, colored Jacobian) was stopped before its first 1 s output when the block Jacobian landed; its packet lacked R3's passageBlendSpeed",
            "settling-probe-3-log.jsonl (c0db454d, block Jacobian) was stopped before its first 1 s output to add the coupler's scope-proportional calls and the per-block Jacobian attribution; values are unchanged (JAC's oracle, b1b9bfd3)"],
        "status": "NOT-EVIDENCE probe; S2 is not declared. PZR boundary closed: shell metal and relief pending (G6), heaters at zero (G6)",
        "preparation": preparation,
        "configuration": {"maxOrder": 2, "relativeTolerance": rtol, "absoluteTolerance": "the S1 classes' scaled floor for every new class (G12)",
            "newtonCoefficient": NEWTON_COEFFICIENT, "deltaCjLSetup": DELTA_CJ_LSETUP, "newtonSource": "claude/ld01-wiki c968921 (supersedes a66ee83's 0.01): stock coefficient 0.33 with IDASetDeltaCjLSetup 0.1 at every IDA start and restart",
            "firstStep_s": FIRST_STEP_S, "firstStepSource": "G13 (request 4 K4) at every restart; also at the start", "maxStep_s": null,
            "advanceChunk_s": ADVANCE_CHUNK_S, "advanceChunk": "IDA_NORMAL output targets only; no step is shortened",
            "jacobian": if assembly == "blocks" { "JAC's block assembly (claude/ld01-jac 54f6d7b4), checked against the colored matrix to 5.8e-15 column-relative" } else { "colored joined assembly (reference)" }},
        "criteria": {"source": "S2 memo §7 draft settling block (not declared)", "window_s": window_s, "corePowerRelative": 1e-4, "cellTemperature_K": 0.01, "pzrRoofPressure_Pa": 1000, "sgPressure_Pa": 1000, "cap_s": cap_s, "probe_cpu_cap_s": cpu_cap_s},
        "verdict": verdict,
        "failure": failure,
        "events": events,
        "simulated_s": simulated,
        "cost": {"total_cpu_s": total, "preparation_cpu_s": preparation_cpu_s,
            "steps": counts.0, "residuals": counts.1, "jacobians": counts.2,
            "cpu_s_per_step": (total - preparation_cpu_s) / counts.0.max(1) as f64,
            "cpu_s_per_simulated_s": (total - preparation_cpu_s) / simulated.max(1e-9),
            "residual_wall_s_per_call": c.residual_wall_s / c.residuals.max(1) as f64,
            "jacobian_wall_s_per_call": c.jacobian_wall_s / c.jacobians.max(1) as f64,
            "jacobian_attribution": jacobian_attribution(&ida.system().joined),
            "load_average": String::from_utf8_lossy(&std::process::Command::new("sysctl").args(["-n","vm.loadavg"]).output().unwrap().stdout).trim().to_string()},
        "samples": samples,
    });
    write_receipt(&receipt);
    println!("{}", serde_json::to_string(&json!({"verdict": receipt["verdict"], "failure": receipt["failure"], "simulated_s": simulated, "cost": receipt["cost"]})).unwrap());
}
