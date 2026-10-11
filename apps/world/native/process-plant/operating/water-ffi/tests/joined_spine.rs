//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-spine-at-power
//! The joined hot spine on the actual compiled packet, with maintained IF97.
//!
//! These are zero-time receipts and NOT-EVIDENCE probes of the joined
//! residual, not S2 gate runs: S2 is declared separately. A receipt is
//! written only to a new path, never over an existing file.
use leitbild_operating_plant::{
    joined::{self, census, nuclear::Nuclear, packet, solids::Solids},
    network::{Network, PzrPreparation, packet::Packet as NetworkPacket},
};
use leitbild_operating_water::If97;
use serde_json::{Value, json};
use std::path::Path;

/// The S1 harness's declared PZR preparation controls (s1_hydraulics.rs).
const PZR: PzrPreparation = PzrPreparation {
    pressure_tolerance_pa: 1e-6,
    max_passes: 50,
};

fn packet_bytes() -> (String, Vec<u8>) {
    let path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET")
        .expect("LD01_OPERATING_HOT_SPINE_PACKET names the compiled spine packet");
    let bytes = std::fs::read(&path).expect("packet");
    (path, bytes)
}

/// App and wiki provenance of a receipt: commits and whether the worktrees
/// were clean. The wiki is the archive or checkout named by `LD01_WIKI_ROOT`.
fn provenance() -> Value {
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
        "wiki_commit": wiki.as_ref().map(|w| git(&["-C", w, "rev-parse", "HEAD"])),
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
    assert_eq!(row("Network cells").composed, Some([151, 34]));
    assert_eq!(row("Network faces").composed, Some([70, 0]));
    assert_eq!(row("RCP rotors").composed, Some([4, 0]));
    assert_eq!(c.composed, [17241, 1192, 18433]);
    assert_eq!(c.with_pending, [17301, 1300, 18601]);
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

fn sha256(bytes: &[u8]) -> String {
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

mod z1 {
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
    use leitbild_operating_plant::{initialization::SurfacePolicy, joined::operator::Joined};
    let started = z1::cpu_s();
    let (path, bytes) = packet_bytes();
    let network_packet: NetworkPacket = serde_json::from_slice(&bytes).expect("network packet");
    let joined_packet: packet::Packet = serde_json::from_slice(&bytes).expect("joined packet");
    let gates = z1::s1_gates();
    let (flows, momenta, s1) = z1::s1_settled_flows(&network_packet, &gates);
    let (network, y_network, network_ids, flowing) =
        z1::composed(&network_packet, &flows, &momenta);
    let (secondary, rods) = z1::prepared_ports(&joined_packet);
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
    let receipt = json!({
        "kind": "s2-z1-part1-composed-residual",
        "status": "NOT-EVIDENCE zero-time receipt; S2 is not declared. Part 1 of Z1: the SG secondary and rod owners are pending, so their ports hold the packet's prepared views (6 MPa, Tsat, 72 m3, steam present) and travel (2.8 m), with no guide passage and no exact consistent start yet",
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
