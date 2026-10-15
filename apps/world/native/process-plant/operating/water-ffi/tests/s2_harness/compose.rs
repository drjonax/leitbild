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
        blocks::{Classes, JoinedJacobian, jacobian_blocks},
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

/// Steps (A)-(D) on the packet named by `LD01_OPERATING_HOT_SPINE_PACKET`,
/// on G12's tolerance classes only.
pub fn compose(shared: &Block) -> Composed {
    compose_from(shared, None, None)
}

/// Steps (A)-(D), with step (A)'s export given (`Some`) or computed, and
/// with the declared derived tolerance class (S2-D24r,
/// [`derive_tolerances`]) applied when a rule is given.
pub fn compose_from(
    shared: &Block,
    derived: Option<&DerivedRule>,
    settled: Option<&Settled>,
) -> Composed {
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
    let mut atol = atol;
    let pressure_outputs = crate::outputs::cell_pressure_outputs(&joined, &network_packet)
        .expect("credited outputs on cell pressures");
    let derived = match derived {
        Some(rule) => derive_tolerances(
            &mut joined,
            &structure,
            rule,
            &pressure_outputs,
            classes.relative,
            0.,
            &y,
            &yp,
            &mut atol,
        )
        .expect("S2-D24r derived tolerance class"),
        None => {
            json!({"declared": false, "reason": "composed on G12's classes only (no derived class declared or given)"})
        }
    };
    let receipt = json!({
        "derived_tolerances": derived,
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
/// coordinates and the scaled stock floor on every other (G12). The
/// pressure-driven algebraic currents' derived classes (S2-D24) replace
/// their entries after the composed state's exact start, from the joined
/// Jacobian there ([`derive_tolerances`]).
pub fn joined_tolerances(joined: &Joined<If97>, y: &[f64], classes: ToleranceClasses) -> Vec<f64> {
    let n_net = joined.offsets().nuclear;
    let mut atol = joined
        .network
        .absolute_tolerances(&y[..n_net], classes)
        .unwrap();
    atol.resize(y.len(), classes.stock_scaled);
    atol
}

/// S2-D24 on a Jacobian in CSC (`pointers`, `rows`, `values`, the
/// stored order of the joined pattern, `∂F/∂y` in solver scaling): each
/// row `r` of `derived` is an algebraic current set by pressures; its
/// sensitivity to pressure column `j` is `∂m/∂p_j = −J[r,j] / J[r,r]`, and
/// its derived absolute tolerance is `max_j atol_j |∂m/∂p_j|` over the
/// pressure columns it reads (for a law of `Δp` alone, `atol_p |∂m/∂Δp|`).
/// Returns per row `(tolerance, |∂m/∂p| at the maximum, its column)`.
/// A row without a diagonal or without a pressure column refuses.
pub fn derived_tolerances(
    pointers: &[usize],
    rows: &[usize],
    values: &[f64],
    derived: &[usize],
    pressure: &[bool],
    atol: &[f64],
) -> Result<Vec<(f64, f64, usize)>, String> {
    let index: std::collections::BTreeMap<usize, usize> =
        derived.iter().enumerate().map(|(k, r)| (*r, k)).collect();
    let mut diagonal = vec![None; derived.len()];
    let mut entries: Vec<Vec<(usize, f64)>> = vec![Vec::new(); derived.len()];
    for j in 0..pointers.len() - 1 {
        for position in pointers[j]..pointers[j + 1] {
            if let Some(k) = index.get(&rows[position]) {
                if rows[position] == j {
                    diagonal[*k] = Some(values[position]);
                } else if pressure[j] {
                    entries[*k].push((j, values[position]));
                }
            }
        }
    }
    derived
        .iter()
        .enumerate()
        .map(|(k, r)| {
            let d = diagonal[k]
                .filter(|d| *d != 0. && d.is_finite())
                .ok_or_else(|| format!("row {r} has no finite nonzero diagonal"))?;
            entries[k]
                .iter()
                .map(|(j, v)| (atol[*j] * (v / d).abs(), (v / d).abs(), *j))
                .max_by(|a, b| a.0.total_cmp(&b.0))
                .ok_or_else(|| format!("row {r} reads no pressure column"))
        })
        .collect()
}

/// The pressure class whose columns set an S2-D24r current: the network's
/// cell pressures (decision 0013's pressure rows).
pub const PRESSURE_CLASS: &str = "network/CellPressure";

/// S2-D24r as `ld01-s2-gates` declares it (`derivedTolerance`): the covered
/// class (`owner/Class` of the joined layouts), the rule text, the decision,
/// the declared value in kg/s (TBD until filled) and G12's value, with every
/// credited output's absolute budget (the comparison's metrics of scale 1,
/// [`crate::compare::Budgets`]) from which the outputs each coordinate
/// determines take theirs ([`determined_tolerances`]).
#[derive(Clone, Debug)]
pub struct DerivedRule {
    pub class: String,
    pub rule: String,
    pub decision: String,
    pub g12_kg_s: f64,
    pub declared_kg_s: Option<f64>,
    /// `(credited output key, absolute budget)` of every compared output.
    pub budgets: Vec<(&'static str, f64)>,
}

impl DerivedRule {
    /// The rule from the declaration; `Ok(None)` when the block declares no
    /// derived class. The budgets are the credited blocks' own
    /// (`ld01-accuracy-contract`, `ld01-s2-accuracy`), read as the
    /// comparison reads them.
    pub fn from(d: &crate::gates::Declaration) -> Result<Option<Self>, String> {
        if d.gates.value.get("derivedTolerance").is_none() {
            return Ok(None);
        }
        let budgets = crate::compare::Budgets::from(d)?
            .metrics()
            .into_iter()
            .filter(|(_, _, scale, _)| *scale == 1.)
            .map(|(_, output, _, budget)| (output, budget))
            .collect();
        Ok(Some(Self {
            class: d.gates.text("/derivedTolerance/class"),
            rule: d.gates.text("/derivedTolerance/rule"),
            decision: d.gates.text("/derivedTolerance/decision"),
            g12_kg_s: d.gates.number("/derivedTolerance/g12Value_kg_s"),
            declared_kg_s: d.gates.open_number("/derivedTolerance/value_kg_s"),
            budgets,
        }))
    }

    /// The credited outputs on cell pressures with their budgets; an output
    /// without an absolute budget refuses.
    pub fn credited(
        &self,
        outputs: &[(&'static str, Vec<usize>)],
    ) -> Result<Vec<CreditedPressure>, String> {
        outputs
            .iter()
            .map(|(name, columns)| {
                let budget_pa = self
                    .budgets
                    .iter()
                    .find(|(k, _)| k == name)
                    .map(|(_, b)| *b)
                    .ok_or_else(|| format!("the credited output {name} has no absolute budget"))?;
                if !(budget_pa.is_finite() && budget_pa > 0.) {
                    return Err(format!(
                        "the credited output {name}'s budget is {budget_pa}"
                    ));
                }
                Ok(CreditedPressure {
                    name: (*name).to_string(),
                    budget_pa,
                    columns: columns.clone(),
                })
            })
            .collect()
    }
}

/// A credited output defined on pressure coordinates: its key, its budget
/// (Pa) and the joined coordinates it reads.
#[derive(Clone, Debug)]
pub struct CreditedPressure {
    pub name: String,
    pub budget_pa: f64,
    pub columns: Vec<usize>,
}

/// One credited output a derived coordinate determines.
#[derive(Clone, Debug, PartialEq)]
pub struct Determined {
    pub output: String,
    pub budget_pa: f64,
    /// `|∂m/∂p_j|` in SI (kg/s per Pa), the largest over the output's
    /// coordinates the row reads (for a difference output, `|∂m/∂Δp|`).
    pub sensitivity: f64,
    pub column: usize,
    /// `budget × sensitivity` (kg/s).
    pub tolerance: f64,
}

/// S2-D24r on a Jacobian in CSC (`pointers`, `rows`, `values`: the stored
/// order of the joined pattern, `∂F/∂y` in solver scaling; `scales` the
/// coordinates' SI scales): each row `r` of `derived` is an algebraic
/// current set by pressures, with `∂m/∂p_j = −J[r,j] / J[r,r]`. The credited
/// outputs it determines are those whose coordinates its row reads (a
/// nonzero entry); each gives `budget × |∂m/∂p|` over its own coordinates.
/// Returns per row the outputs it determines, tightest first: the first is
/// the row's derived tolerance (kg/s), so every determined output's budget
/// holds. A row without a finite nonzero diagonal, or that determines no
/// credited output, refuses.
pub fn determined_tolerances(
    pointers: &[usize],
    rows: &[usize],
    values: &[f64],
    derived: &[usize],
    credited: &[CreditedPressure],
    scales: &[f64],
) -> Result<Vec<Vec<Determined>>, String> {
    let index: std::collections::BTreeMap<usize, usize> =
        derived.iter().enumerate().map(|(k, r)| (*r, k)).collect();
    let mut diagonal = vec![None; derived.len()];
    let mut entries: Vec<Vec<(usize, f64)>> = vec![Vec::new(); derived.len()];
    for j in 0..pointers.len() - 1 {
        for position in pointers[j]..pointers[j + 1] {
            if let Some(k) = index.get(&rows[position]) {
                if rows[position] == j {
                    diagonal[*k] = Some(values[position]);
                } else if values[position] != 0. {
                    entries[*k].push((j, values[position]));
                }
            }
        }
    }
    derived
        .iter()
        .enumerate()
        .map(|(k, r)| {
            let d = diagonal[k]
                .filter(|d| *d != 0. && d.is_finite())
                .ok_or_else(|| format!("row {r} has no finite nonzero diagonal"))?;
            let mut determined: Vec<Determined> = credited
                .iter()
                .filter_map(|o| {
                    entries[k]
                        .iter()
                        .filter(|(j, _)| o.columns.contains(j))
                        .map(|(j, v)| ((v / d).abs() * scales[*r] / scales[*j], *j))
                        .max_by(|a, b| a.0.total_cmp(&b.0))
                        .map(|(sensitivity, column)| Determined {
                            output: o.name.clone(),
                            budget_pa: o.budget_pa,
                            sensitivity,
                            column,
                            tolerance: o.budget_pa * sensitivity,
                        })
                })
                .collect();
            if determined.is_empty() {
                return Err(format!(
                    "row {r} determines no credited output (it reads none of their coordinates)"
                ));
            }
            determined.sort_by(|a, b| a.tolerance.total_cmp(&b.tolerance));
            Ok(determined)
        })
        .collect()
}

/// S2-D24r applied to `atol` (lead decision, re-declared after the S2-15
/// result; the original S2-D24 used rtol·|p| as atol_p): every coordinate of
/// the rule's class takes the tightest credited budget among the credited
/// outputs it determines times its sensitivity, from the block Jacobian's
/// own row at `(t, y, y')` ([`determined_tolerances`] over `outputs`, the
/// credited outputs on cell pressures, [`crate::outputs::cell_pressure_outputs`];
/// for the rods' guide currents: core DP's budget × `|∂m/∂Δp|`). The declared
/// value is applied once filled; while it is open the derived one is
/// applied, labelled a preview. The receipt records every covered
/// coordinate's applied and derived tolerance, the outputs it determines
/// with their budgets and sensitivities, and the superseded rtol·|p| basis
/// beside it for the record.
#[allow(clippy::too_many_arguments)] // The operator, its structure, the rule, the outputs, the contract's rtol and the state.
pub fn derive_tolerances(
    joined: &mut Joined<If97>,
    structure: &JoinedJacobian,
    rule: &DerivedRule,
    outputs: &[(&'static str, Vec<usize>)],
    rtol: f64,
    t: f64,
    y: &[f64],
    yp: &[f64],
    atol: &mut [f64],
) -> Result<Value, String> {
    let class_of: Vec<String> = joined
        .layouts()
        .iter()
        .flat_map(|(owner, l)| l.classes.iter().map(move |c| format!("{owner}/{c:?}")))
        .collect();
    let labels: Vec<String> = joined
        .layouts()
        .iter()
        .flat_map(|(owner, l)| l.labels.iter().map(move |x| format!("{owner}/{x}")))
        .collect();
    if class_of.len() != y.len() {
        return Err("the layouts do not cover the joined coordinates".into());
    }
    let pressure: Vec<bool> = class_of.iter().map(|c| c == PRESSURE_CLASS).collect();
    let credited = rule.credited(outputs)?;
    for o in &credited {
        if let Some(j) = o
            .columns
            .iter()
            .find(|j| !pressure.get(**j).copied().unwrap_or(false))
        {
            return Err(format!(
                "{} reads coordinate {j}, which is not of the pressure class {PRESSURE_CLASS}",
                o.name
            ));
        }
    }
    let rows: Vec<usize> = (0..y.len())
        .filter(|i| class_of[*i] == rule.class)
        .collect();
    if rows.is_empty() {
        return Err(format!("no coordinate of the derived class {}", rule.class));
    }
    let scales = joined.scales();
    let mut values = vec![0.; structure.pattern.indices().len()];
    jacobian_blocks(joined, structure, t, 0., y, yp, &mut values, Classes::ALL)
        .map_err(|e| format!("block Jacobian at the composed state: {e:?}"))?;
    let (pointers, indices) = (structure.pattern.pointers(), structure.pattern.indices());
    let determined = determined_tolerances(pointers, indices, &values, &rows, &credited, &scales)?;
    let relative: Vec<f64> = y.iter().map(|v| rtol * v.abs()).collect();
    let superseded = derived_tolerances(pointers, indices, &values, &rows, &pressure, &relative)?;
    let mut per = Vec::new();
    let (mut applied_kg_s, mut derived_kg_s) = (Vec::new(), Vec::new());
    for ((r, d), old) in rows.iter().zip(&determined).zip(&superseded) {
        let scale = scales[*r];
        let tightest = &d[0];
        let applied = rule.declared_kg_s.unwrap_or(tightest.tolerance);
        per.push(
            json!({"coordinate": labels[*r], "g12_atol_kg_s": atol[*r] * scale,
            "applied_atol_kg_s": applied, "derived_atol_kg_s": tightest.tolerance,
            "determines": d.iter().map(|o| json!({"output": o.output, "budget_pa": o.budget_pa,
                "dm_ddp_kg_s_per_pa": o.sensitivity, "pressure_column": labels[o.column],
                "tolerance_kg_s": o.tolerance})).collect::<Vec<_>>(),
            "superseded_s2_d24_rtol_p_basis_kg_s": old.0 * scale}),
        );
        applied_kg_s.push(applied);
        derived_kg_s.push(tightest.tolerance);
        atol[*r] = applied / scale;
    }
    let range = |v: &[f64]| {
        [
            v.iter().copied().fold(f64::INFINITY, f64::min),
            v.iter().copied().fold(f64::NEG_INFINITY, f64::max),
        ]
    };
    let mut budgets: Vec<(String, f64)> = determined
        .iter()
        .map(|d| (d[0].output.clone(), d[0].budget_pa))
        .collect();
    budgets.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));
    budgets.dedup();
    Ok(
        json!({"declared": true, "decision": rule.decision, "class": rule.class, "rule": rule.rule,
        "credited_outputs_on_pressures": credited.iter().map(|o| json!({"output": o.name, "budget_pa": o.budget_pa,
            "coordinates": o.columns.iter().map(|j| labels[*j].clone()).collect::<Vec<_>>()})).collect::<Vec<_>>(),
        "tightest_budgets_applied": budgets, "pressure_class": PRESSURE_CLASS, "t_s": t,
        "g12_value_kg_s": rule.g12_kg_s, "declared_value_kg_s": rule.declared_kg_s,
        "applied": if rule.declared_kg_s.is_some() { "the declared value" } else { "PREVIEW: the derived value (value_kg_s is TBD(lead))" },
        "applied_kg_s_range": range(&applied_kg_s), "derived_kg_s_range": range(&derived_kg_s),
        "coordinates": per.len(), "per_coordinate": per}),
    )
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
    // The exact bits when the state carries them (the S2-07 format).
    let exact = |k: &str| -> Option<Vec<f64>> {
        state[format!("{k}_bits")].as_array().map(|a| {
            a.iter()
                .map(|v| f64::from_bits(u64::from_str_radix(v.as_str().unwrap(), 16).unwrap()))
                .collect()
        })
    };
    let (y, yp) = (
        exact("y").unwrap_or_else(|| vector("y")),
        exact("yp").unwrap_or_else(|| vector("yp")),
    );
    assert!(
        y.len() == dimension && yp.len() == dimension,
        "{path} has {} coordinates, the composition {dimension}",
        y.len()
    );
    (state["t_s"].as_f64().expect("t_s"), y, yp)
}
