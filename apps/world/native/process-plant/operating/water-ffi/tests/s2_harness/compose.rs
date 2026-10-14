//! The S2 composition at the hot reference (memo §3 (A)-(D), declaration
//! steps (A)-(D)), as `joined_spine.rs` composes it for Z1 and the settling
//! probe: S1's network-only settling exports the flows, the hydrostatic and
//! flowing preparations compose the network, the joined operator composes
//! the nuclear, solids, SG secondary and rod owners, the owners prepare
//! their algebraic coordinates, the fixed-stock surfaces initialize, and the
//! exact consistent start projects and solves the rates. No IDACalcIC.
//!
//! The tolerance classes are S1's (`ld01-s1-gates`, shared by S2): the
//! network's own classes and the scaled stock floor for every new coordinate
//! class (G12).
use crate::{cpu::process_cpu_s, gates::Block, provenance::sha256_file};
use leitbild_operating_plant::{
    initialization::SurfacePolicy,
    joined::{
        blocks::JoinedJacobian,
        operator::{Joined, RodPort, SecondaryPort},
        packet,
    },
    network::{
        Network, RotorState, ToleranceClasses, consistent_start,
        packet::Packet as NetworkPacket,
        prepare::{self, OperatingPoint, Settings},
    },
    rods::{RodBlock, Section as RodSection},
    rotor::{Shaft, SpeedRequest, Support},
    sg::{packet::Section as SecondarySection, secondary::Secondaries},
};
use leitbild_operating_water::{
    If97,
    ida::{Ida, Initial},
    joined::{Analyses, Matrices, consistent_start as joined_start},
    network::Integrated as NetworkIntegrated,
};
use serde_json::{Value, json};

/// The S1 harness's hydrostatic preparation settings (s1_hydraulics.rs).
pub const SETTINGS: Settings = Settings {
    pressure_tolerance_pa: 1e-6,
    max_passes: 50,
    level_match_m: 1e-9,
    eos_row_bound: 1e-12,
    tree_face_bound_pa: 1e-6,
    representation_search: 8,
};
/// The exact consistent start's declared row bound (decision 0013's exit).
pub const START_BOUND: f64 = 1e-12;

pub fn rotors() -> Vec<RotorState> {
    vec![
        RotorState {
            support: Support::Supported(SpeedRequest::Nominal),
            shaft: Shaft::Free,
        };
        4
    ]
}

/// S1's tolerance classes, read from the shared block.
pub fn classes(shared: &Block) -> ToleranceClasses {
    ToleranceClasses {
        relative: shared.number("/relativeTolerance"),
        stock_scaled: shared.number("/stockScaledAbsolute"),
        tracer_scaled: shared.number("/tracerScaledAbsolute"),
        rotor_scaled: shared.number("/rotorScaledAbsolute"),
        volume_flow_m3_s: shared.number("/volumeFlowAbsolute_m3_s"),
    }
}

/// The packet named by `LD01_OPERATING_HOT_SPINE_PACKET`: path, bytes, hash.
pub struct PacketFile {
    pub path: String,
    pub bytes: Vec<u8>,
    pub sha256: String,
}
pub fn packet_file() -> PacketFile {
    let path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET")
        .expect("LD01_OPERATING_HOT_SPINE_PACKET names the compiled joined packet");
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let sha256 = sha256_file(&path).expect("packet hash");
    PacketFile {
        path,
        bytes,
        sha256,
    }
}

/// S1's declared network-only settling from rest (step (A)), run only to
/// export the settled flows: the RCPs start from rest through the drive
/// law and the network settles under S1's own tolerance classes and caps.
/// Returns every face's settled liquid volume flow, the rotors' angular
/// momenta and a summary.
pub fn s1_settled_flows(packet: &NetworkPacket, shared: &Block) -> (Vec<f64>, Vec<f64>, Value) {
    let started = process_cpu_s();
    let point = OperatingPoint::from(&packet.preparation.operating_point);
    let (network, prepared, _) =
        prepare::prepare(packet, If97, &point, &rotors(), &SETTINGS).expect("hydrostatic");
    let mut y = prepared.y.clone();
    for i in &network.rotor_index {
        y[*i] = 0.;
    }
    let classes = classes(shared);
    let atol = network.absolute_tolerances(&y, classes).unwrap();
    let rtol = classes.relative;
    let ids = prepared.differential.clone();
    let weights: Vec<f64> = y
        .iter()
        .zip(&atol)
        .map(|(v, a)| 1. / (rtol * v.abs() + a))
        .collect();
    let mut probe = network;
    let (yp, _) = consistent_start(&mut probe, 0., &mut y, &ids, &weights, START_BOUND, 2)
        .expect("S1 exact consistent start");
    let nonnegative = probe.nonnegative_stocks();
    let mut ida = Ida::new(
        NetworkIntegrated::colored(probe).unwrap(),
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
    ida.set_max_order(shared.count("/maxOrder") as usize)
        .unwrap();
    ida.constrain_nonnegative(&nonnegative).unwrap();
    let cap = shared.number("/settling/maxSimulated_s");
    let window = shared.number("/settling/window_s");
    let rotor_rel = shared.number("/settling/rotorSpeedRelative");
    let flow_rel = shared.number("/settling/loopFlowRelativeChange");
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
    let summary = json!({
        "scope": "S1's declared network-only settling, run only to export settled flows (step (A))",
        "settled_at_s": settled_at,
        "loop_mass_flow_kg_s": history.last().map(|h| h.1),
        "steps": stats.steps, "residuals": stats.residuals, "jacobians": stats.jacobians,
        "cpu_s": process_cpu_s() - started,
    });
    assert!(settled_at.is_some(), "S1 settling did not rest: {summary}");
    (flows, momenta, summary)
}

/// Step (B): a fresh hydrostatic preparation at the hot-reference water
/// energies with the declared PZR, then the S1-settled volume flows and
/// rotor momenta transferred by the flowing preparation.
pub fn composed_network(
    packet: &NetworkPacket,
    flows: &[f64],
    momenta: &[f64],
) -> (Network<If97>, Vec<f64>, Vec<f64>, Value) {
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

/// The full composition, consistently started at `t = 0`.
pub struct Composed {
    pub joined: Joined<If97>,
    pub y: Vec<f64>,
    pub yp: Vec<f64>,
    /// Joined differential identity, and the network's own (for restarts).
    pub ids: Vec<f64>,
    pub network_ids: Vec<f64>,
    pub atol: Vec<f64>,
    pub rtol: f64,
    pub packet: PacketFile,
    /// JAC's block structure compiled at the composed state and the
    /// symbolic analyses the start made on it (S2-D4), for
    /// `Integrated::from_blocks`.
    pub structure: JoinedJacobian,
    pub analyses: Analyses,
    /// The composition's receipt: S1 settling, owners, surfaces, the start.
    pub receipt: Value,
    pub cpu_s: f64,
}

/// Step (A)'s export: S1's settled face volume flows, rotor momenta and
/// summary ([`s1_settled_flows`]), deterministic for one packet and build,
/// so a harness composing several runs computes it once.
pub type Settled = (Vec<f64>, Vec<f64>, Value);

/// Steps (A)-(D) on the packet named by `LD01_OPERATING_HOT_SPINE_PACKET`.
pub fn compose(shared: &Block) -> Composed {
    compose_from(shared, None)
}

/// Steps (A)-(D), with step (A)'s export given (`Some`) or computed.
pub fn compose_from(shared: &Block, settled: Option<&Settled>) -> Composed {
    let started = process_cpu_s();
    let packet = packet_file();
    let network_packet: NetworkPacket =
        serde_json::from_slice(&packet.bytes).expect("network packet");
    let joined_packet: packet::Packet =
        serde_json::from_slice(&packet.bytes).expect("joined packet");
    let raw: Value = serde_json::from_slice(&packet.bytes).expect("packet json");
    let (flows, momenta, s1) = match settled {
        Some((flows, momenta, s1)) => (
            flows.clone(),
            momenta.clone(),
            json!({"reused": "step (A)'s export computed once by this harness", "export": s1}),
        ),
        None => s1_settled_flows(&network_packet, shared),
    };
    let (network, y_network, network_ids, flowing) =
        composed_network(&network_packet, &flows, &momenta);
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
    let classes = classes(shared);
    let atol = joined_tolerances(&joined, &y, classes);
    // G6: the PZR relief lift's absolute tolerance (the scaled floor at its
    // unit scale, G12) bounds its distance from a stop at a travel root.
    if let Some(b) = joined.pzr_mut() {
        b.declare_lift_root_bound(classes.stock_scaled)
            .expect("lift root bound");
    }
    let weights = error_weights(&y, classes.relative, &atol);
    let compile_cpu = process_cpu_s();
    let structure = JoinedJacobian::compile(&mut joined, 0., &y).expect("block structure");
    let compile_cpu_s = process_cpu_s() - compile_cpu;
    let mut analyses = Analyses::default();
    let start_cpu = process_cpu_s();
    let (yp, start) = joined_start(
        &mut joined,
        Matrices::Blocks {
            structure: &structure,
            analyses: &mut analyses,
        },
        0.,
        &mut y,
        &ids,
        &weights,
        START_BOUND,
        3,
    )
    .expect("exact consistent start");
    let start_cpu_s = process_cpu_s() - start_cpu;
    let receipt = json!({
        "s1_settling": s1, "flowing_preparation_max_cycle_drive_pa": flowing["max_cycle_drive_pa"],
        "owners_prepared": owners.iter().map(|t| t.receipt.clone()).collect::<Vec<_>>(),
        "surfaces_worst_residual_w": surfaces.iter().map(|s| s.residual_w.iter().fold(0., |a: f64, r| a.max(r.abs()))).fold(0., f64::max),
        "start": {"residual": [start.residual.value, start.residual.row], "constraint_rate": [start.constraint_rate.value, start.constraint_rate.row],
            "correction_wrms": start.correction_wrms, "projection_passes": start.projection_passes, "rate_passes": start.rate_passes, "cpu_s": start_cpu_s,
            "assembly": "blocks (S2-D4)", "block_compile_cpu_s": compile_cpu_s},
        "dimension": y.len(), "algebraic": ids.iter().filter(|v| **v == 0.).count(),
    });
    Composed {
        joined,
        y,
        yp,
        ids,
        network_ids,
        atol,
        rtol: classes.relative,
        packet,
        structure,
        analyses,
        receipt,
        cpu_s: process_cpu_s() - started,
    }
}

/// The joined absolute tolerances: the network's classes on its own
/// coordinates and the scaled stock floor on every other (G12).
pub fn joined_tolerances(joined: &Joined<If97>, y: &[f64], classes: ToleranceClasses) -> Vec<f64> {
    let n_net = joined.offsets().nuclear;
    let mut atol = joined
        .network
        .absolute_tolerances(&y[..n_net], classes)
        .unwrap();
    atol.resize(y.len(), classes.stock_scaled);
    atol
}

/// The integrator's error weights at a state, `1 / (rtol |y| + atol)`.
pub fn error_weights(y: &[f64], rtol: f64, atol: &[f64]) -> Vec<f64> {
    y.iter()
        .zip(atol)
        .map(|(v, a)| 1. / (rtol * v.abs() + a))
        .collect()
}

/// A saved state `{t_s, y, yp, packet}` (the settling probe's
/// `LD01_SETTLED_STATE_OUT`), refused unless it names this packet and has
/// the composed dimension. Its owners' discrete modes are the composed ones
/// (no event during settling), so the caller re-establishes consistency by
/// the exact consistent start at it.
pub fn saved_state(path: &str, packet: &PacketFile, dimension: usize) -> (f64, Vec<f64>, Vec<f64>) {
    let state: Value =
        serde_json::from_slice(&std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}")))
            .expect("saved state");
    assert_eq!(
        state["packet"].as_str(),
        Some(packet.path.as_str()),
        "{path} was saved on another packet"
    );
    let vector = |k: &str| -> Vec<f64> {
        state[k]
            .as_array()
            .unwrap_or_else(|| panic!("{path} has no {k}"))
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect()
    };
    let (y, yp) = (vector("y"), vector("yp"));
    assert!(
        y.len() == dimension && yp.len() == dimension,
        "{path} has {} coordinates, the composition {dimension}",
        y.len()
    );
    (state["t_s"].as_f64().expect("t_s"), y, yp)
}
