//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0013-coarse-local-pressure.md#numerical-treatment-of-uncredited-lumped-modes
//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#s2-design-choices-11-october-delegated
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/kinetics.md#post-trip-domain-extension
//! S2's zero-time spectral gate Z6 (G10) on the joined residual, with the
//! trip's excitations, and D3 (a)'s shutdown margin at the same state.
//!
//! These are zero-time receipts: one linearization, no time advanced. The
//! thresholds are S1's (`ld01-s1-gates` `spectrum`, G14). A receipt is
//! written only to a new path (`LD01_S2_SPECTRUM_RECEIPT`), never over a file.
//!
//! # The restriction (lead decision S2-D8)
//!
//! A dense pencil of all 18,603 coordinates does not fit (≈11–15 GB, hours of
//! `dggev`). Two pencils are decomposed instead, both from the joined
//! residual's own colored Jacobian at the state (`A = ∂F/∂y`,
//! `B = ∂F/∂y'`, the solver's scaled rows and coordinates):
//!
//! 1. **Restricted** (`R`): the network, both SG secondaries, the SG metal
//!    and the rod bodies with their guide passages (≈440 coordinates). The
//!    other blocks are frozen, declared explicitly:
//!    - every differential coordinate outside `R` (populations, precursors,
//!      inventories, histories, fuel, clad, helium and passive stores) is held
//!      at its state value: its perturbation is zero and its row is dropped;
//!    - every algebraic coordinate outside `R` (the clad and fuel surfaces)
//!      stays on its own constraint: it is eliminated exactly by the Schur
//!      complement of its block, `A_R = A_RR - A_Rs A_ss^-1 A_sR` (KLU), so
//!      the water sees the walls' instantaneous response at frozen stores.
//!      `B` has no entries in those rows or columns, which is checked.
//!
//!    The pencil with the surfaces held instead (a fixed-temperature wall) is
//!    reported as a sensitivity, not gated.
//! 2. **Coupled nuclear-thermal** (`K`, critic M3): a named restriction of
//!    the same Jacobian that keeps the feedback paths `R` freezes: the 24
//!    regional populations, every carrier's two fuel nodes (the Doppler
//!    functional reads them) and clad store (the heat path to the water), the
//!    network (moderator density, boron), the SG secondaries and metal, and
//!    the rods (rod reactivity). Surfaces are eliminated as in `R`.
//!    Everything else is held at zero perturbation: precursors, poison and
//!    fuel inventories, delayed-energy histories, helium and passive stores.
//!    The held linear blocks (precursors, inventories, histories) are diagonal
//!    in their own coordinates, so their own spectra are their decay
//!    constants (`-lambda`, checked and reported); what holding them drops is
//!    their coupling, chiefly the delayed-neutron return, so the check sees
//!    prompt kinetics. The count is set by the plant (24 + 772 + 386 + 261 +
//!    20 + 156 = 1,619), above the planned 1,000: `dggev` at that size is
//!    about a minute, on the same Accelerate path.
//!
//! Ungated sensitivities: `R` with the surfaces held (a fixed-temperature
//! wall), and the network alone (to attribute network-intrinsic modes).
//!
//! # Predicates (per pencil and state)
//!
//! - infinite modes equal the pencil's algebraic coordinates;
//! - no resolved positive real part;
//! - every marginal mode (sign of `Re λ` unresolved) is tied to a null
//!   direction: `|λ|` itself within its error bound, so `A v ≈ 0`;
//! - no mode above `fastModeHz` with damping below `lightDamping` excited
//!   above `maxExcitationRatio` times its tolerance by a trip event.
//!
//! The trip's events: (E1) the TURBINE TRIP's steam-demand ramp, taken as
//! its full step to zero demand (it bounds the ramp), on the held and the
//! released pencils; (E2) the holding opening, every cluster released, as the
//! residual change of the release at the unchanged state, on the released
//! pencil.
#![cfg(all(feature = "ida", target_os = "macos"))]
use leitbild_operating_plant::{
    initialization::SurfacePolicy,
    joined::{
        block::{Class, Command},
        operator::{Joined, RodPort, SecondaryPort},
        packet,
        post_trip_domain::{self, Extension, Fixed},
    },
    network::{
        Network, RotorState, ToleranceClasses, consistent_start,
        packet::Packet as NetworkPacket,
        prepare::{self, OperatingPoint, Settings},
    },
    rods::{RodBlock, Section as RodSection},
    rotor::{Shaft, SpeedRequest, Support},
    sg::{packet::Section as SecondarySection, secondary::Secondaries},
    source_feedback as sf,
    thermal::Scalar,
};
use leitbild_operating_water::{
    If97,
    ida::{Ida, Initial},
    klu::SparseLu,
    network::Integrated,
    spectrum::{self, Event, Kind},
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path, time::Instant};

// ---------------------------------------------------------------------------
// The composed state: joined_spine.rs's Z1 recipe (started_full_composition),
// unchanged: S1's network-only settling exports the settled flows, the
// flowing preparation composes them at the hot reference, the owners and
// surfaces are prepared, and the exact consistent start projects the state.

const SETTINGS: Settings = Settings {
    pressure_tolerance_pa: 1e-6,
    max_passes: 50,
    level_match_m: 1e-9,
    eos_row_bound: 1e-12,
    tree_face_bound_pa: 1e-6,
    representation_search: 8,
};
fn rotors() -> Vec<RotorState> {
    vec![
        RotorState {
            support: Support::Supported(SpeedRequest::Nominal),
            shaft: Shaft::Free,
        };
        4
    ]
}
fn wiki_page(name: &str) -> String {
    let wiki = std::env::var("LD01_WIKI_ROOT").expect("LD01_WIKI_ROOT");
    std::fs::read_to_string(format!(
        "{wiki}/world/packs/process-plant/reference-designs/ld-01/{name}"
    ))
    .unwrap()
}
fn strict_block(page: &str, name: &str) -> Value {
    let open = format!("```{name}\n");
    let start = page.find(&open).unwrap_or_else(|| panic!("{name}")) + open.len();
    let end = start + page[start..].find("\n```").unwrap();
    serde_json::from_str(&page[start..end]).unwrap()
}
fn s1_gates() -> Value {
    strict_block(&wiki_page("model/build-readiness.md"), "ld01-s1-gates")
}
fn classes(gates: &Value) -> ToleranceClasses {
    let f = |k: &str| gates[k].as_f64().unwrap_or_else(|| panic!("gate {k}"));
    ToleranceClasses {
        relative: f("relativeTolerance"),
        stock_scaled: f("stockScaledAbsolute"),
        tracer_scaled: f("tracerScaledAbsolute"),
        rotor_scaled: f("rotorScaledAbsolute"),
        volume_flow_m3_s: f("volumeFlowAbsolute_m3_s"),
    }
}
fn cpu_s() -> f64 {
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
fn load_average() -> String {
    std::process::Command::new("sysctl")
        .args(["-n", "vm.loadavg"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
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
fn provenance(packet_path: &str, packet_bytes: &[u8]) -> Value {
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    };
    let wiki = std::env::var("LD01_WIKI_ROOT").ok();
    let water = std::env::var("LD01_OPERATING_WATER_LIB_DIR").ok();
    let water_receipt = water
        .as_ref()
        .and_then(|w| std::fs::read(Path::new(w).join("water-build.json")).ok())
        .map(|b| sha256(&b));
    json!({
        "app_commit": git(&["rev-parse", "HEAD"]),
        "app_worktree_dirty": !git(&["status", "--porcelain", "--untracked-files=no"]).is_empty(),
        "wiki": wiki,
        "wiki_commit": wiki.as_ref().map(|w| git(&["-C", w, "rev-parse", "HEAD"])),
        "packet": packet_path, "packet_sha256": sha256(packet_bytes),
        "water_build": water, "water_build_receipt_sha256": water_receipt,
        "sundials_prefix": std::env::var("LD01_OPERATING_SUNDIALS_PREFIX").ok(),
    })
}

/// S1's declared network-only settling (memo §3 (A)), run only to export the
/// settled face volume flows and rotor momenta.
fn s1_settled_flows(packet: &NetworkPacket, gates: &Value) -> (Vec<f64>, Vec<f64>, Value) {
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
    let (yp, _) = consistent_start(&mut probe, 0., &mut y, &ids, &weights, 1e-12, 2)
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
    ida.set_max_order(gates["maxOrder"].as_u64().unwrap() as usize)
        .unwrap();
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
    let summary = json!({
        "scope": "NOT-EVIDENCE: S1's declared network-only settling, run only to export settled flows (memo §3 (A))",
        "settled_at_s": settled_at, "steps": stats.steps, "cpu_s": cpu_s() - started,
    });
    assert!(settled_at.is_some(), "S1 settling did not rest: {summary}");
    (flows, momenta, summary)
}

struct Started {
    joined: Joined<If97>,
    raw: Value,
    t: f64,
    y: Vec<f64>,
    yp: Vec<f64>,
    network_ids: Vec<f64>,
    atol: Vec<f64>,
    rtol: f64,
    receipt: Value,
}

/// The joined operator composed at the hot reference and exactly started;
/// with `LD01_S2_SPECTRUM_STATE` (`{packet, t_s, y, yp}`, the settling
/// probe's export) the state is that one instead, on the same operator.
fn started() -> Started {
    let path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET")
        .expect("LD01_OPERATING_HOT_SPINE_PACKET names the joined packet");
    let bytes = std::fs::read(&path).expect("packet");
    let network_packet: NetworkPacket = serde_json::from_slice(&bytes).expect("network packet");
    let joined_packet: packet::Packet = serde_json::from_slice(&bytes).expect("joined packet");
    let raw: Value = serde_json::from_slice(&bytes).expect("packet json");
    let gates = s1_gates();
    let (flows, momenta, s1) = s1_settled_flows(&network_packet, &gates);
    let point = OperatingPoint::from(&network_packet.preparation.operating_point);
    let (mut network, mut prepared, hydrostatic) =
        prepare::prepare(&network_packet, If97, &point, &rotors(), &SETTINGS).expect("hydrostatic");
    let flowing = prepare::compose_flows(
        &mut network,
        &network_packet,
        &mut prepared.y,
        hydrostatic.port_pressure_pa,
        &flows,
        &momenta,
        &SETTINGS,
    )
    .expect("flowing preparation");
    let network_ids = prepared.differential.clone();
    let network: Network<If97> = network;
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
    let mut y = joined.prepared(&prepared.y).unwrap();
    let ids = joined.differential(&network_ids);
    joined
        .prepare_owners(0., &mut y)
        .expect("owner preparation");
    joined
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
    let classes = classes(&gates);
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
    let (yp, start) = leitbild_operating_water::joined::consistent_start(
        &mut joined,
        // The start's matrices since S2-D4 (6d1ee9be): the colored
        // reference, as this probe ran before; blocks are the production's.
        leitbild_operating_water::joined::Matrices::Colored,
        0.,
        &mut y,
        &ids,
        &weights,
        1e-12,
        3,
    )
    .expect("exact consistent start");
    let mut receipt = json!({
        "provenance": provenance(&path, &bytes),
        "s1_settling": s1, "flowing_preparation_max_cycle_drive_pa": serde_json::to_value(&flowing).unwrap()["max_cycle_drive_pa"].clone(),
        "composed_start": {"residual": [start.residual.value, start.residual.row], "constraint_rate": [start.constraint_rate.value, start.constraint_rate.row],
            "correction_wrms": start.correction_wrms, "projection_passes": start.projection_passes},
    });
    let (t, y, yp) = match std::env::var_os("LD01_S2_SPECTRUM_STATE") {
        None => {
            receipt["state"] = json!({"kind": "composed", "t_s": 0.});
            (0., y, yp)
        }
        Some(file) => {
            let bytes = std::fs::read(&file).expect("state file");
            let state: Value = serde_json::from_slice(&bytes).expect("state json");
            let v = |k: &str| -> Vec<f64> {
                serde_json::from_value(state[k].clone()).unwrap_or_else(|_| panic!("state {k}"))
            };
            let (ys, yps) = (v("y"), v("yp"));
            assert_eq!(ys.len(), y.len(), "state dimension");
            assert_eq!(
                state["packet"].as_str(),
                Some(path.as_str()),
                "state packet"
            );
            let t = state["t_s"].as_f64().expect("t_s");
            receipt["state"] = json!({"kind": "file", "file": file.to_string_lossy(), "sha256": sha256(&bytes), "t_s": t});
            (t, ys, yps)
        }
    };
    Started {
        joined,
        raw,
        t,
        y,
        yp,
        network_ids,
        atol,
        rtol: classes.relative,
        receipt,
    }
}

// ---------------------------------------------------------------------------
// Pencils.

/// `A = ∂F/∂y`, `B = ∂F/∂y'` on the joined structure pattern (colored, exact
/// directional derivatives): the `cj = 0` assembly and its `cj = 1` change.
fn pencil(joined: &mut Joined<If97>, t: f64, y: &[f64], yp: &[f64]) -> (Vec<f64>, Vec<f64>) {
    let nnz = joined.structure().unwrap().0.nonzeros();
    let (mut a, mut ab) = (vec![0.; nnz], vec![0.; nnz]);
    joined.jacobian(t, 0., y, yp, &mut a).expect("A");
    joined.jacobian(t, 1., y, yp, &mut ab).expect("A + B");
    let b = ab.iter().zip(&a).map(|(x, y)| x - y).collect();
    (a, b)
}
fn residual(joined: &mut Joined<If97>, t: f64, y: &[f64], yp: &[f64]) -> Vec<f64> {
    joined.evaluate(t, y, yp, None, 0., None).expect("residual");
    joined.rows().iter().map(|r| r.value).collect()
}

/// One dense pencil (column-major) and its coordinates' names, algebraic
/// flags and tolerances.
struct Dense {
    n: usize,
    a: Vec<f64>,
    b: Vec<f64>,
    labels: Vec<String>,
    algebraic: usize,
    tolerance: Vec<f64>,
}

/// The restricted pencil on `keep`, the coordinates in `eliminate` kept on
/// their constraints by the exact Schur complement (KLU), and each forcing
/// vector reduced the same way.
struct Restriction<'a> {
    pointers: &'a [usize],
    indices: &'a [usize],
    keep: &'a [usize],
    eliminate: &'a [usize],
}
impl Restriction<'_> {
    fn apply(
        &self,
        a: &[f64],
        b: &[f64],
        forcings: &[Vec<f64>],
        labels: &[String],
        ids: &[f64],
        tolerance: &[f64],
    ) -> (Dense, Vec<Vec<f64>>, Value) {
        let n_all = ids.len();
        let n = self.keep.len();
        let mut at_keep = vec![None; n_all];
        for (k, &i) in self.keep.iter().enumerate() {
            at_keep[i] = Some(k);
        }
        let mut at_elim = vec![None; n_all];
        for (k, &i) in self.eliminate.iter().enumerate() {
            at_elim[i] = Some(k);
        }
        let (mut da, mut db) = (vec![0.; n * n], vec![0.; n * n]);
        let mut b_coupling = 0f64;
        for (kj, &j) in self.keep.iter().enumerate() {
            for p in self.pointers[j]..self.pointers[j + 1] {
                let i = self.indices[p];
                if let Some(r) = at_keep[i] {
                    da[kj * n + r] = a[p];
                    db[kj * n + r] = b[p];
                } else if at_elim[i].is_some() {
                    b_coupling = b_coupling.max(b[p].abs());
                }
            }
        }
        for &j in self.eliminate {
            let column = &b[self.pointers[j]..self.pointers[j + 1]];
            b_coupling = column.iter().fold(b_coupling, |m, v| m.max(v.abs()));
        }
        assert_eq!(
            b_coupling, 0.,
            "an eliminated algebraic coordinate has a B entry"
        );
        let mut forced: Vec<Vec<f64>> = forcings
            .iter()
            .map(|f| self.keep.iter().map(|&i| f[i]).collect())
            .collect();
        let mut schur = json!({"eliminated": self.eliminate.len()});
        if !self.eliminate.is_empty() {
            let m = self.eliminate.len();
            let (mut pointers, mut rows, mut values) = (vec![0i64], Vec::new(), Vec::new());
            for &j in self.eliminate {
                for p in self.pointers[j]..self.pointers[j + 1] {
                    if let Some(r) = at_elim[self.indices[p]] {
                        rows.push(r as i64);
                        values.push(a[p]);
                    }
                }
                pointers.push(rows.len() as i64);
            }
            let mut lu = SparseLu::analyze(m, &pointers, &rows).expect("surface pattern");
            lu.factor(&values).expect("surface block factor");
            let rcond = lu.rcond().expect("rcond");
            // x = A_ss^-1 rhs; then the kept rows lose A_Rs x.
            let mut correct = |rhs: &mut Vec<f64>, out: &mut dyn FnMut(usize, f64)| {
                lu.solve(rhs).expect("surface solve");
                for (k, &s) in self.eliminate.iter().enumerate() {
                    let x = rhs[k];
                    if x == 0. {
                        continue;
                    }
                    for p in self.pointers[s]..self.pointers[s + 1] {
                        if let Some(r) = at_keep[self.indices[p]] {
                            out(r, a[p] * x);
                        }
                    }
                }
            };
            let mut columns = 0;
            for (kj, &j) in self.keep.iter().enumerate() {
                let mut rhs = vec![0.; m];
                let mut any = false;
                for p in self.pointers[j]..self.pointers[j + 1] {
                    if let Some(r) = at_elim[self.indices[p]] {
                        rhs[r] = a[p];
                        any |= a[p] != 0.;
                    }
                }
                if !any {
                    continue;
                }
                columns += 1;
                correct(&mut rhs, &mut |r, v| da[kj * n + r] -= v);
            }
            for (f, out) in forcings.iter().zip(forced.iter_mut()) {
                let mut rhs: Vec<f64> = self.eliminate.iter().map(|&i| f[i]).collect();
                if rhs.iter().all(|v| *v == 0.) {
                    continue;
                }
                correct(&mut rhs, &mut |r, v| out[r] -= v);
            }
            schur = json!({"eliminated": m, "kept_columns_coupled": columns, "klu_rcond": rcond});
        }
        (
            Dense {
                n,
                a: da,
                b: db,
                labels: self.keep.iter().map(|&i| labels[i].clone()).collect(),
                algebraic: self.keep.iter().filter(|&&i| ids[i] == 0.).count(),
                tolerance: self.keep.iter().map(|&i| tolerance[i]).collect(),
            },
            forced,
            schur,
        )
    }
}

/// The held linear blocks' own spectra: within the precursor, inventory and
/// history rows held outside `keep`, `B` is the identity and the coupling
/// graph of `A` is acyclic (decay chains I -> Xe, Pm -> Sm and the fission
/// feed from the fissile inventory; checked by a topological order), so the
/// held block is triangular and its eigenvalues are its diagonal: `-A_ii`,
/// the decay (and depletion) constants.
#[allow(clippy::too_many_arguments)] // One pencil's CSC, its restriction and its names.
fn held_linear_blocks(
    pointers: &[usize],
    indices: &[usize],
    a: &[f64],
    b: &[f64],
    keep: &[usize],
    eliminate: &[usize],
    classes: &[Class],
    labels: &[String],
) -> Value {
    let linear = |c: Class| {
        matches!(
            c,
            Class::Precursor
                | Class::Fissile
                | Class::Fertile
                | Class::Iodine
                | Class::Xenon
                | Class::Promethium
                | Class::Samarium
                | Class::FissionHistory
                | Class::CaptureHistory
        )
    };
    let n = classes.len();
    let mut held: Vec<bool> = classes.iter().map(|c| linear(*c)).collect();
    for &i in keep.iter().chain(eliminate) {
        held[i] = false;
    }
    let mut by: BTreeMap<String, (usize, f64, f64)> = BTreeMap::new();
    let mut largest_off = (0f64, String::new());
    let mut b_departure = 0f64;
    let mut indegree = vec![0usize; n];
    let mut out: Vec<Vec<usize>> = vec![Vec::new(); n];
    for j in 0..n {
        if !held[j] {
            continue;
        }
        for p in pointers[j]..pointers[j + 1] {
            let i = indices[p];
            if !held[i] {
                continue;
            }
            if i == j {
                let e = by.entry(format!("{:?}", classes[j])).or_insert((
                    0,
                    f64::INFINITY,
                    f64::NEG_INFINITY,
                ));
                // Row y' - (feed - lambda y): A_jj = lambda.
                e.0 += 1;
                e.1 = e.1.min(a[p]);
                e.2 = e.2.max(a[p]);
                b_departure = b_departure.max((b[p] - 1.).abs());
            } else {
                if b[p] != 0. {
                    b_departure = b_departure.max(b[p].abs());
                }
                if a[p] != 0. {
                    out[j].push(i);
                    indegree[i] += 1;
                    if a[p].abs() > largest_off.0 {
                        largest_off = (a[p].abs(), format!("{} <- {}", labels[i], labels[j]));
                    }
                }
            }
        }
    }
    // Kahn's order over the held coupling graph: every node ordered <=> acyclic.
    let mut ready: Vec<usize> = (0..n).filter(|&i| held[i] && indegree[i] == 0).collect();
    let mut ordered = 0;
    while let Some(j) = ready.pop() {
        ordered += 1;
        for &i in &out[j] {
            indegree[i] -= 1;
            if indegree[i] == 0 {
                ready.push(i);
            }
        }
    }
    let total = held.iter().filter(|h| **h).count();
    let blocks: serde_json::Map<String, Value> = by
        .into_iter()
        .map(|(k, (count, lo, hi))| {
            (
                k,
                json!({"coordinates": count, "diagonal_decay_constants_per_s": [lo, hi]}),
            )
        })
        .collect();
    json!({"held_coordinates": total, "blocks": blocks,
        "triangular": ordered == total, "own_eigenvalues": if ordered == total { "-A_ii: the decay and depletion constants" } else { "NOT triangular: eigenvalues not the diagonal" },
        "largest_off_diagonal_within_held": {"value": largest_off.0, "entry": largest_off.1},
        "largest_b_departure_from_identity": b_departure})
}

#[derive(Clone, Copy, Debug)]
struct Gate {
    fast_mode_hz: f64,
    light_damping: f64,
    max_excitation_ratio: f64,
}

/// Write one dense pencil for offline analysis into the directory named by
/// `LD01_S2_SPECTRUM_DUMP`, if set: `<name>.json` (labels, algebraic count)
/// and `<name>.a.f64`, `<name>.b.f64` (column-major, little-endian).
fn dump(name: &str, d: &Dense) {
    let Some(dir) = std::env::var_os("LD01_S2_SPECTRUM_DUMP") else {
        return;
    };
    let base = Path::new(&dir).join(name.replace('/', "-"));
    let bytes = |m: &[f64]| m.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>();
    for (ext, m) in [("a.f64", &d.a), ("b.f64", &d.b)] {
        let path = base.with_extension(ext);
        assert!(!path.exists(), "dumps are never overwritten");
        std::fs::write(path, bytes(m)).unwrap();
    }
    std::fs::write(
        base.with_extension("json"),
        serde_json::to_vec(&json!({"n": d.n, "labels": d.labels, "algebraic": d.algebraic, "tolerance": d.tolerance})).unwrap(),
    )
    .unwrap();
}

/// Decompose one pencil, excite its events and evaluate the predicates.
fn judge(name: &str, d: &Dense, events: &[(&str, Vec<f64>)], gate: Gate) -> (Value, bool) {
    dump(name, d);
    let started = cpu_s();
    let s = spectrum::decompose(d.n, &d.a, &d.b).unwrap_or_else(|e| panic!("{name}: {e}"));
    let evs: Vec<Event<'_>> = events
        .iter()
        .map(|(_, v)| Event {
            kind: Kind::Residual,
            vector: v,
        })
        .collect();
    let report = s.report(&evs, &d.tolerance).expect("excitation");
    let dominant = |m: usize, count: usize| -> Vec<Value> {
        let mut w: Vec<(f64, usize)> = s.shapes[m]
            .right
            .iter()
            .enumerate()
            .map(|(i, v)| (v.abs(), i))
            .collect();
        w.sort_by(|x, y| y.0.total_cmp(&x.0));
        w.iter()
            .take(count)
            .map(|(v, i)| json!({"coordinate": d.labels[*i], "weight": v}))
            .collect()
    };
    let norm_a = s.norm_a;
    let null_residual = |m: usize| -> f64 {
        // ||A v|| / (||A||_F ||v||) of the right vector.
        let v = &s.shapes[m].right;
        let mut out = vec![spectrum::Complex::default(); d.n];
        for (col, x) in d.a.chunks_exact(d.n).zip(v) {
            for (o, &aij) in out.iter_mut().zip(col) {
                *o = *o + *x * aij;
            }
        }
        let nv = v.iter().map(|z| z.abs().powi(2)).sum::<f64>().sqrt();
        out.iter().map(|z| z.abs().powi(2)).sum::<f64>().sqrt() / (norm_a * nv)
    };
    let resolved_growing: Vec<Value> = s
        .modes
        .iter()
        .enumerate()
        .filter(|(_, m)| m.unstable && !m.marginal)
        .map(|(i, m)| json!({"re": m.lambda.re, "im": m.lambda.im, "hz": m.frequency_hz, "error_bound": m.error_bound, "dominant": dominant(i, 6)}))
        .collect();
    let marginal: Vec<(bool, Value)> = s
        .modes
        .iter()
        .enumerate()
        .filter(|(_, m)| m.marginal)
        .map(|(i, m)| {
            let tied = m.lambda.abs() <= m.error_bound;
            (
                tied,
                json!({"re": m.lambda.re, "im": m.lambda.im, "abs": m.lambda.abs(), "error_bound": m.error_bound,
                    "positive": m.unstable, "tied_to_null_direction": tied, "a_v_relative": null_residual(i), "dominant": dominant(i, 6)}),
            )
        })
        .collect();
    let untied = marginal.iter().filter(|(t, _)| !t).count();
    let untied_positive = marginal
        .iter()
        .filter(|(t, v)| !t && v["positive"] == json!(true))
        .count();
    let mut excitations = Vec::new();
    let mut fast_excited_total = 0;
    for ((ename, _), ex) in events.iter().zip(&report.events) {
        let fast: Vec<Value> = ex
            .responses
            .iter()
            .zip(&report.modes)
            .enumerate()
            .filter(|(_, (r, m))| {
                m.frequency_hz > gate.fast_mode_hz
                    && m.damping_ratio.is_some_and(|z| z < gate.light_damping)
                    && r.ratio > gate.max_excitation_ratio
            })
            .map(|(i, (r, m))| json!({"hz": m.frequency_hz, "zeta": m.damping_ratio, "ratio": r.ratio, "coordinate": d.labels[r.coordinate], "dominant": dominant(i, 4)}))
            .collect();
        fast_excited_total += fast.len();
        // A mode with lambda = 0 within its bound turns a step forcing into a
        // drift, not a transient: its rate is reported apart (a degenerate
        // null space has no unique basis, so only the largest rate is kept).
        let null = |m: usize| report.modes[m].lambda.abs() <= report.modes[m].error_bound;
        let drift = (0..ex.responses.len())
            .filter(|&m| null(m))
            .map(|m| {
                let k = if report.modes[m].pair { 2. } else { 1. };
                let sensitivity = s.shapes[m]
                    .right
                    .iter()
                    .zip(&d.tolerance)
                    .map(|(v, t)| v.abs() / t)
                    .fold(0., f64::max);
                (k * ex.responses[m].projection.abs() * sensitivity, m)
            })
            .fold((0., None), |best: (f64, Option<usize>), (rate, m)| {
                if rate > best.0 { (rate, Some(m)) } else { best }
            });
        let max_resolved = (0..ex.responses.len())
            .filter(|&m| !null(m))
            .map(|m| ex.responses[m].ratio)
            .fold(0., f64::max);
        let top: Vec<Value> = {
            let mut idx: Vec<usize> = (0..ex.responses.len()).filter(|&m| !null(m)).collect();
            idx.sort_by(|&x, &y| ex.responses[y].ratio.total_cmp(&ex.responses[x].ratio));
            idx.iter()
                .take(5)
                .map(|&i| {
                    let (r, m) = (&ex.responses[i], &report.modes[i]);
                    json!({"ratio": r.ratio, "hz": m.frequency_hz, "zeta": m.damping_ratio, "re": m.lambda.re, "settle_s": r.settle_s,
                        "coordinate": d.labels[r.coordinate]})
                })
                .collect()
        };
        let fast_modes = (0..ex.responses.len())
            .filter(|&m| report.modes[m].frequency_hz > gate.fast_mode_hz)
            .map(|m| ex.responses[m].ratio)
            .fold(0., f64::max);
        excitations.push(json!({"event": ename, "max_ratio_nonnull_modes": max_resolved, "max_ratio_modes_above_fast_hz": fast_modes,
            "fast_lightly_damped_above_ratio": fast,
            "largest_ratios": top,
            "null_mode_drift": {"largest_rate_tolerances_per_s": drift.0, "dominant": drift.1.map(|m| dominant(m, 4))},
            "forcing_inf_norm_over_tolerance": events.iter().find(|e| e.0 == *ename).map(|e| e.1.iter().zip(&d.tolerance).map(|(f, t)| f.abs() / t).fold(0., f64::max))}));
    }
    let infinite_ok = report.infinite.count == d.algebraic;
    let go = infinite_ok && resolved_growing.is_empty() && untied == 0 && fast_excited_total == 0;
    let slowest: Vec<Value> = report
        .modes
        .iter()
        .take(12)
        .map(|m| json!({"re": m.lambda.re, "im": m.lambda.im, "hz": m.frequency_hz, "zeta": m.damping_ratio, "marginal": m.marginal}))
        .collect();
    let fastest_oscillatory: Vec<Value> = report
        .modes
        .iter()
        .rev()
        .filter(|m| m.frequency_hz > 0.)
        .take(8)
        .map(|m| json!({"hz": m.frequency_hz, "zeta": m.damping_ratio, "re": m.lambda.re}))
        .collect();
    let least_damped: Vec<Value> = {
        let mut osc: Vec<&spectrum::Mode> = report.modes.iter().filter(|m| m.pair).collect();
        osc.sort_by(|x, y| {
            x.damping_ratio
                .unwrap_or(0.)
                .total_cmp(&y.damping_ratio.unwrap_or(0.))
        });
        osc.iter()
            .take(8)
            .map(|m| json!({"hz": m.frequency_hz, "zeta": m.damping_ratio, "re": m.lambda.re}))
            .collect()
    };
    let largest_growth = report
        .modes
        .iter()
        .map(|m| m.lambda.re)
        .fold(f64::NEG_INFINITY, f64::max);
    (
        json!({
            "pencil": name, "dimension": d.n, "lapack_version": report.lapack_version, "dggev_s": report.dggev_seconds,
            "cpu_s": cpu_s() - started, "norm_a": report.norm_a, "norm_b": report.norm_b,
            "infinite": {"count": report.infinite.count, "algebraic_coordinates_expected": d.algebraic,
                "zero_columns_of_b": report.infinite.algebraic_coordinates, "threshold": report.infinite.threshold,
                "largest_relative_beta": report.infinite.largest_relative_beta, "smallest_finite_relative_beta": report.infinite.smallest_finite_relative_beta},
            "finite_eigenvalues": report.finite, "reported_modes": report.modes.len(),
            "unstable_flagged": report.unstable, "resolved_growing": resolved_growing, "largest_real_part": largest_growth,
            "marginal": marginal.iter().map(|(_, v)| v.clone()).collect::<Vec<_>>(),
            "marginal_untied": untied, "marginal_untied_positive": untied_positive,
            "excitations": excitations,
            "slowest_modes": slowest, "fastest_oscillatory": fastest_oscillatory, "least_damped_pairs": least_damped,
            "modes_above_fast_hz": report.modes.iter().filter(|m| m.frequency_hz > gate.fast_mode_hz).count(),
            "predicates": {"infinite_equals_algebraic": infinite_ok, "no_resolved_positive_real_part": resolved_growing.is_empty(),
                "marginal_tied_to_null_directions": untied == 0, "no_fast_lightly_damped_mode_excited_above_ratio": fast_excited_total == 0},
            "go": go,
        }),
        go,
    )
}

fn write_receipt(receipt: &Value) {
    if let Some(path) = std::env::var_os("LD01_S2_SPECTRUM_RECEIPT") {
        let path = Path::new(&path);
        assert!(
            !path.exists(),
            "receipts are never overwritten: {}",
            path.display()
        );
        std::fs::write(path, serde_json::to_vec_pretty(receipt).unwrap()).unwrap();
    }
}

/// D3 (a)'s record: the packet's `post_trip_domain` section, or for a packet
/// compiled before it (9eb6e37d) the source compiler's output for the same
/// wiki in the file `LD01_POST_TRIP_DOMAIN`.
fn extension(raw: &Value) -> (Extension, Value) {
    if raw.get("post_trip_domain").is_some() {
        let e = serde_json::from_value(raw["post_trip_domain"].clone()).expect("post_trip_domain");
        return (e, json!({"source": "packet section post_trip_domain"}));
    }
    let file = std::env::var("LD01_POST_TRIP_DOMAIN")
        .expect("pre-D3 packet: LD01_POST_TRIP_DOMAIN names the compiled post_trip_domain section");
    let bytes = std::fs::read(&file).expect("post-trip domain file");
    (
        serde_json::from_slice(&bytes).expect("post-trip domain record"),
        json!({"source": "compiled section file (pre-D3 packet)", "file": file, "sha256": sha256(&bytes)}),
    )
}

/// The margin `delta*` (Δk/k) of D3's operator: `alpha(M + delta* G) = 0`,
/// the smallest real eigenvalue of the pencil `(M, diag(G))` (`dggev`).
fn margin_value(m: &post_trip_domain::Margin) -> f64 {
    let r = m.reactivity_gain.len();
    let mut g = vec![0.; r * r];
    for i in 0..r {
        g[i * r + i] = m.reactivity_gain[i];
    }
    let s = spectrum::decompose(r, &m.operator, &g).expect("margin pencil");
    s.modes
        .iter()
        .map(|x| x.lambda.re)
        .fold(f64::INFINITY, f64::min)
}

#[test]
#[ignore = "zero-time receipt: requires the joined packet, the wiki, maintained IF97, stock IDA/KLU and Accelerate"]
fn z6_restricted_and_coupled_spectrum_with_the_trip_excitations() {
    let wall = Instant::now();
    let cpu0 = cpu_s();
    let Started {
        mut joined,
        t,
        y,
        yp,
        network_ids,
        atol,
        rtol,
        mut receipt,
        ..
    } = started();
    let gates = s1_gates();
    let gate = Gate {
        fast_mode_hz: gates["spectrum"]["fastModeHz"].as_f64().unwrap(),
        light_damping: gates["spectrum"]["lightDamping"].as_f64().unwrap(),
        max_excitation_ratio: gates["spectrum"]["maxExcitationRatio"].as_f64().unwrap(),
    };
    let composed_cpu = cpu_s() - cpu0;
    let o = joined.offsets();
    let n = joined.dimension();
    let labels: Vec<String> = joined
        .layouts()
        .into_iter()
        .flat_map(|(owner, l)| l.labels.into_iter().map(move |x| format!("{owner}/{x}")))
        .collect();
    let classes: Vec<Class> = joined
        .layouts()
        .into_iter()
        .flat_map(|(_, l)| l.classes)
        .collect();
    let tolerance = spectrum::tolerance(rtol, &y, &atol).expect("tolerance");
    // The restriction: network, secondary, rods, SG metal; surfaces eliminated.
    let keep: Vec<usize> = (0..n)
        .filter(|&i| {
            i < o.nuclear || i >= o.secondary || (i >= o.solids && classes[i] == Class::MetalEnergy)
        })
        .collect();
    let surfaces: Vec<usize> = (o.solids..o.secondary)
        .filter(|&i| classes[i] == Class::Surface)
        .collect();
    // The coupled restriction: regional N, fuel and clad stores, network,
    // SG secondaries and metal, rods; surfaces eliminated; the rest held.
    let coupled: Vec<usize> = (0..n)
        .filter(|&i| {
            keep.contains(&i)
                || matches!(
                    classes[i],
                    Class::RegionalPopulation | Class::FuelEnergy | Class::CladEnergy
                )
        })
        .collect();
    let network_only: Vec<usize> = (0..o.nuclear).collect();
    let (pointers, indices) = {
        let p = &joined.structure().unwrap().0;
        (p.pointers().to_vec(), p.indices().to_vec())
    };
    let owner_of = |i: usize| {
        if i < o.nuclear {
            "network"
        } else if i < o.solids {
            "nuclear"
        } else if i < o.secondary {
            "solids"
        } else if i < o.rods {
            "secondary"
        } else {
            "rods"
        }
    };
    let by_owner = |v: &[f64]| -> Value {
        let mut m: BTreeMap<&str, f64> = BTreeMap::new();
        for (i, x) in v.iter().enumerate() {
            let e = m.entry(owner_of(i)).or_insert(0.);
            *e = e.max(x.abs() / tolerance[i]);
        }
        json!(m)
    };

    // The held pencil at the state, then the TURBINE TRIP.
    let f_state = residual(&mut joined, t, &y, &yp);
    let ids_held = joined.differential(&network_ids);
    let (a0, b0) = pencil(&mut joined, t, &y, &yp);
    let mut y_cmd = y.clone();
    let done = joined
        .command(t, &mut y_cmd, Command::TurbineTrip)
        .expect("TURBINE TRIP");
    assert_eq!(y_cmd, y, "the command changes no coordinate");
    let open = joined.next_time_event(t).expect("the holding opening");
    let f_cmd = residual(&mut joined, t, &y, &yp);
    // The ramp end follows the opening; its full step bounds the ramp (E1).
    let ramp_end = {
        let rods_next = joined.rods().unwrap().next_time_event(t);
        let sg_next = joined.secondary().unwrap().next_time_event(t);
        assert_eq!(rods_next, Some(open));
        sg_next.expect("the steam-demand ramp end")
    };
    let f_ramped = residual(&mut joined, ramp_end, &y, &yp);
    let e1: Vec<f64> = f_ramped.iter().zip(&f_cmd).map(|(a, b)| a - b).collect();
    // The holding opening (E2) at the unchanged state.
    let f_held_open = residual(&mut joined, open, &y, &yp);
    let mut y_open = y.clone();
    let released = joined.time_events(open, &mut y_open).expect("opening");
    assert_eq!(y_open, y, "the release changes no coordinate");
    let ids_open = joined.differential(&network_ids);
    let f_released = residual(&mut joined, open, &y, &yp);
    let e2: Vec<f64> = f_released
        .iter()
        .zip(&f_held_open)
        .map(|(a, b)| a - b)
        .collect();
    let (a1, b1) = pencil(&mut joined, open, &y, &yp);
    let events = json!({
        "state_residual_max_over_tolerance": by_owner(&f_state),
        "turbine_trip": {"t_s": t, "transactions": done.len(), "holding_opening_s": open, "ramp_end_s": ramp_end,
            "command_residual_change_max_over_tolerance": by_owner(&f_cmd.iter().zip(&f_state).map(|(a, b)| a - b).collect::<Vec<_>>())},
        "E1_demand_step_max_over_tolerance": by_owner(&e1),
        "E2_release": {"transactions": released.len(), "released_clusters": released.first().and_then(|d| d.receipt["rods"].as_array().map(|a| a.len())),
            "algebraic_held": ids_held.iter().filter(|v| **v == 0.).count(), "algebraic_released": ids_open.iter().filter(|v| **v == 0.).count(),
            "max_over_tolerance": by_owner(&e2)},
    });

    // Restricted pencils.
    let restriction = Restriction {
        pointers: &pointers,
        indices: &indices,
        keep: &keep,
        eliminate: &surfaces,
    };
    let held_walls = Restriction {
        eliminate: &[],
        ..restriction
    };
    let coupled_restriction = Restriction {
        keep: &coupled,
        ..restriction
    };
    let network_alone = Restriction {
        keep: &network_only,
        eliminate: &[],
        ..restriction
    };
    let mut verdicts = Vec::new();
    let mut pencils = Vec::new();
    let mut held_blocks = Value::Null;
    for (state, a, b, ids, evs) in [
        (
            "held",
            &a0,
            &b0,
            &ids_held,
            vec![("E1 demand step", e1.clone())],
        ),
        (
            "released",
            &a1,
            &b1,
            &ids_open,
            vec![("E1 demand step", e1.clone()), ("E2 release", e2.clone())],
        ),
    ] {
        let forcings: Vec<Vec<f64>> = evs.iter().map(|(_, v)| v.clone()).collect();
        let mut run = |name: &str, r: &Restriction<'_>, gated: bool| {
            let (dense, forced, schur) = r.apply(a, b, &forcings, &labels, ids, &tolerance);
            let named: Vec<(&str, Vec<f64>)> = evs.iter().map(|(n, _)| *n).zip(forced).collect();
            let (mut verdict, go) = judge(&format!("{name}/{state}"), &dense, &named, gate);
            verdict["schur"] = schur;
            verdict["gated"] = json!(gated);
            if gated {
                verdicts.push(go);
            }
            pencils.push(verdict);
        };
        run("restricted", &restriction, true);
        run("coupled-nuclear-thermal", &coupled_restriction, true);
        run("restricted-held-walls", &held_walls, false);
        run("network-alone", &network_alone, false);
        if state == "held" {
            held_blocks = held_linear_blocks(
                &pointers, &indices, a, b, &coupled, &surfaces, &classes, &labels,
            );
        }
    }
    let go = verdicts.iter().all(|g| *g);
    receipt["kind"] = json!("s2-z6-restricted-spectrum");
    receipt["status"] = json!(
        "zero-time receipt (G10 Z6); S2 is not declared: not evidence until revision 7 is published"
    );
    receipt["gate"] = json!({"source": "ld01-s1-gates spectrum (G14)", "fastModeHz": gate.fast_mode_hz, "lightDamping": gate.light_damping, "maxExcitationRatio": gate.max_excitation_ratio});
    receipt["restriction"] = json!({
        "decision": "S2-D8 (lead): network + SG + metal + rods, plus a coupled nuclear-thermal check; both named restrictions of the joined Jacobian (critic M3); Accelerate dggev, no new dependency",
        "restricted": {"coordinates": keep.len(), "network": o.nuclear, "secondary": o.rods - o.secondary, "rods": o.end - o.rods,
            "sg_metal": keep.iter().filter(|&&i| i >= o.solids && i < o.secondary).count(), "pzr_metal": "absent until G6 composes it",
            "frozen_differential": n - keep.len() - surfaces.len(), "eliminated_algebraic_surfaces": surfaces.len(),
            "treatment": "frozen differential coordinates held (zero perturbation, rows dropped); algebraic surfaces on their constraints by the exact Schur complement; held-surface pencil reported as a sensitivity"},
        "coupled_nuclear_thermal": {"coordinates": coupled.len(),
            "kept": "regional populations, fuel nodes and clad stores of every carrier, the network, the SG secondaries and metal, the rods (named rows and columns of the joined Jacobian)",
            "regional_populations": coupled.iter().filter(|&&i| classes[i] == Class::RegionalPopulation).count(),
            "fuel_nodes": coupled.iter().filter(|&&i| classes[i] == Class::FuelEnergy).count(),
            "clad_stores": coupled.iter().filter(|&&i| classes[i] == Class::CladEnergy).count(),
            "eliminated_algebraic_surfaces": surfaces.len(),
            "held": "precursors, fissile/fertile/poison inventories, delayed-energy histories (linear, constant coefficients), helium and passive stores: zero perturbation",
            "held_linear_blocks": held_blocks,
            "planned_bound": "under 1,000 (S2-D8); the plant's 386 carriers x 3 stores set 1,619",
            "critic": "M3 (accepted): named restrictions of the model's own Jacobian, no aggregated surrogate"},
    });
    receipt["events"] = events;
    receipt["pencils"] = json!(pencils);
    receipt["verdict"] = json!(if go {
        "GO: every gated Z6 predicate holds at this state"
    } else {
        "NO-GO: a gated Z6 predicate failed; see pencils[].predicates"
    });
    receipt["cost"] = json!({"composition_cpu_s": composed_cpu, "total_cpu_s": cpu_s() - cpu0, "wall_s": wall.elapsed().as_secs_f64(), "load_average_end": load_average()});
    write_receipt(&receipt);
    println!("{}", serde_json::to_string(&receipt["verdict"]).unwrap());
    for p in &pencils {
        println!(
            "{} n={} infinite={}/{} growing={} marginal_untied={} predicates={}",
            p["pencil"],
            p["dimension"],
            p["infinite"]["count"],
            p["infinite"]["algebraic_coordinates_expected"],
            p["resolved_growing"].as_array().unwrap().len(),
            p["marginal_untied"],
            p["predicates"]
        );
    }
}

/// D3 (a) at the state (`admit_accepted`) and Z3's post-trip envelope
/// margin: rods fully in, fuel and moderator at the envelope's coolant
/// temperature, every region's water at its density there, the state's
/// inventories, boron and populations; each envelope point of the Z3
/// receipt in `LD01_Z3_ENVELOPE_RECEIPT` is judged against the 1 % with the
/// water term doubled, and its margin `delta*` reported (nominal factor too).
#[test]
#[ignore = "zero-time receipt: requires the joined packet, the wiki, maintained IF97, stock IDA/KLU, Accelerate and the Z3 envelope receipt"]
fn d3_shutdown_margin_at_the_state_and_on_the_z3_envelope() {
    let cpu0 = cpu_s();
    let Started {
        mut joined,
        raw,
        t,
        y,
        yp,
        mut receipt,
        ..
    } = started();
    let (ext, ext_source) = extension(&raw);
    joined.evaluate(t, &y, &yp, None, 0., None).expect("state");
    let phase = joined.region_phases().expect("region phases");
    let at_state =
        post_trip_domain::admit_accepted(joined.nuclear(), &phase, &ext, joined.travel(), t, 0.)
            .expect("the state itself is admitted");
    let nuclear = joined.nuclear();
    let feedback = nuclear.feedback();
    let f = nuclear.feedback_inputs();
    let co = nuclear.coefficients();
    let fixed = Fixed {
        transfer_rates_per_s: co.transfer_rates_per_s,
        emission_fractions: co.emission_fractions,
        outside_fractions: co.outside_fractions,
    };
    let reference: Vec<f64> = raw["feedback_metadata"]["regions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["reference_density_kg_m3"].as_f64().unwrap())
        .collect();
    let k = |v: &[f64]| v.iter().map(|x| Scalar::constant(*x)).collect::<Vec<_>>();
    let envelope_file = std::env::var("LD01_Z3_ENVELOPE_RECEIPT")
        .expect("LD01_Z3_ENVELOPE_RECEIPT names the Z3 trip-envelope receipt");
    let envelope_bytes = std::fs::read(&envelope_file).expect("Z3 envelope receipt");
    let envelope: Value = serde_json::from_slice(&envelope_bytes).unwrap();
    let mut nominal = ext;
    nominal.margin_water_term_factor = 1.;
    let mut points = Vec::new();
    let mut all_hold = true;
    for row in envelope["ratios"].as_array().unwrap() {
        let temperature = row["T_C"].as_f64().unwrap() + 273.15;
        let pressure = row["pressure_Pa"].as_f64().unwrap();
        let density = row["rho_kg_m3"].as_f64().unwrap();
        let r = reference.len();
        let (neutrons, boron, fissile, xenon, samarium, opacity) = (
            k(&f.neutrons),
            k(&f.boron_ppm_eq),
            k(&f.fissile_atoms),
            k(&f.xenon_atoms),
            k(&f.samarium_atoms),
            k(&f.capture_loss_change_m2),
        );
        let fuel = vec![Scalar::constant(temperature); f.fuel_temperature_k.len()];
        let water = vec![Scalar::constant(density); r];
        let p = vec![Scalar::constant(pressure); r];
        let moderator = vec![Scalar::constant(temperature); r];
        let travel = vec![Scalar::constant(0.); joined.travel().len()];
        let conditions = sf::Conditions {
            fuel_temperature_k: &fuel,
            water_density_kg_m3: &water,
            boron_ppm_eq: &boron,
            pressure_pa: &p,
            moderator_temperature_k: &moderator,
            fissile_atoms: &fissile,
            xenon_atoms: &xenon,
            samarium_atoms: &samarium,
            capture_loss_change_m2: &opacity,
            achieved_rod_travel_m: &travel,
            capsule_age_s: Scalar::constant(co.capsule_age0_s + t),
        };
        let judged = |e: &Extension| {
            post_trip_domain::admit(
                feedback,
                nuclear.kinetics(),
                fixed,
                &neutrons,
                conditions,
                0.,
                e,
            )
        };
        let doubled = judged(&ext);
        let once = judged(&nominal);
        let margin = |e: &Extension| {
            post_trip_domain::margin_at(
                feedback,
                nuclear.kinetics(),
                fixed,
                &neutrons,
                conditions,
                e,
            )
            .expect("margin at the envelope point")
        };
        let summary = |a: &Result<post_trip_domain::Admission, post_trip_domain::Error>,
                       m: &post_trip_domain::Margin| {
            let verdict = match a {
                Ok(a) => json!({"admitted": true, "domain": a.domain}),
                Err(post_trip_domain::Error::Unsupported { domain, exit, .. }) => {
                    json!({"admitted": false, "domain": domain, "exit": format!("{exit:?}")})
                }
                Err(e) => json!({"error": format!("{e:?}")}),
            };
            json!({"verdict": verdict, "margin_holds": m.holds, "margin_dk_k": margin_value(m),
                "water_term_range": [m.water_terms.iter().cloned().fold(f64::INFINITY, f64::min), m.water_terms.iter().cloned().fold(f64::NEG_INFINITY, f64::max)]})
        };
        let (m2, m1) = (margin(&ext), margin(&nominal));
        let holds = matches!(&doubled, Ok(a) if a.margin.holds);
        all_hold &= holds;
        let ratios: Vec<f64> = reference.iter().map(|rho| density / rho).collect();
        points.push(json!({"temperature": row["temperature"], "T_K": temperature, "pressure_Pa": pressure, "rho_kg_m3": density,
            "density_ratio_range": [ratios.iter().cloned().fold(f64::INFINITY, f64::min), ratios.iter().cloned().fold(f64::NEG_INFINITY, f64::max)],
            "water_term_doubled": summary(&doubled, &m2), "water_term_nominal": summary(&once, &m1)}));
    }
    receipt["kind"] = json!("s2-d3-post-trip-margin");
    receipt["status"] =
        json!("zero-time receipt (D3 (a) predicate and Z3 envelope margin); not a trajectory");
    receipt["extension"] = json!({"record": ext, "source": ext_source});
    let at_state_margin = margin_value(&at_state.margin);
    receipt["at_state"] = json!({"admission": at_state, "margin_dk_k": at_state_margin,
        "note": "at power the source-free operator is near critical, so the margin fails and the compiled domains apply"});
    receipt["z3_envelope"] = json!({"receipt": envelope_file, "sha256": sha256(&envelope_bytes),
        "substitution": "rods fully in (travel 0), fuel and moderator at the envelope coolant temperature, every region's water at the envelope density, the state's populations, boron, fissile, Xe, Sm and capture",
        "points": points, "every_point_holds_with_water_term_doubled": all_hold});
    receipt["cost"] = json!({"total_cpu_s": cpu_s() - cpu0, "load_average_end": load_average()});
    write_receipt(&receipt);
    println!(
        "{}",
        serde_json::to_string(&json!({"at_state": receipt["at_state"]["margin_dk_k"], "all_hold": all_hold, "points": receipt["z3_envelope"]["points"].as_array().unwrap().iter().map(|p| json!([p["temperature"], p["pressure_Pa"], p["water_term_doubled"]["margin_dk_k"], p["water_term_nominal"]["margin_dk_k"]])).collect::<Vec<_>>()})).unwrap()
    );
}
