//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-spine-at-power
//! S2-07: the one re-settle of the joined spine at the frozen tuple, a
//! PREVIEW under the S2 declaration's revision-7 draft (critic H4: its
//! results are recorded before any TBD fill). NOT evidence: S2 is not
//! declared.
//!
//! The run is revision 7's preparation and settling, steps (A)-(E): the
//! composition and exact consistent start of `joined_spine.rs` (included as
//! a module, so its ignored probes also list in this binary: run this one
//! by its exact name), then stock IDA at constant demand with BDF order at
//! most 2, stock's 0.33 Newton coefficient with dcj 0.1 and G13's 1e-4 s
//! first step at the start and every restart. Settling declares no event;
//! a root or owner time event that occurs is restarted by `discrete_restart`
//! under S2-D21 and reported.
//!
//! Settled (step (E)): for every credited quantity of the declared settling
//! block, the range (max - min) of its 2 Hz zero-phase-filtered output over
//! the last 20 s is within its threshold. The credited outputs are sampled
//! at the declared output interval; the filter is the harnesses' declared
//! zero-phase 4th-order Butterworth at the 2 Hz credited band (decision
//! 0015). Uncredited cells are reported only.
//!
//! Environment: the joined spine's (packet, wiki, IF97, SUNDIALS, water)
//! plus, all required (nothing here has a default):
//! - `LD01_S2_GATES_SOURCE`: the declaration draft whose `ld01-s2-gates`
//!   block declares the settling thresholds and the output interval;
//! - `LD01_S2_SETTLE_CAP_S` and `LD01_S2_SETTLE_CPU_CAP_S`: the lead's caps
//!   for this run (simulated s, process CPU s);
//! - `LD01_S2_SETTLE_CHECKPOINT_S`: the spacing of y/y' checkpoints (s);
//! - `LD01_S2_SETTLE_DIR`: a new directory for the log, the checkpoints,
//!   the settled state and the receipt.
#![cfg(all(feature = "ida", target_os = "macos"))]
#[path = "common/filter.rs"]
mod filter;
#[path = "joined_spine.rs"]
mod spine;

use leitbild_operating_plant::{
    joined::operator::Joined,
    network::{Properties, packet::Packet as NetworkPacket},
};
use leitbild_operating_water::{
    If97,
    ida::{Advance, Ida, Initial, KluOrdering, Stats, System},
    joined::{Discrete, Integrated, Restart, discrete_restart},
};
use serde_json::{Map, Value, json};
use spine::{
    DELTA_CJ_LSETUP, FIRST_STEP_S, NEWTON_COEFFICIENT, Started, started_full_composition, z1,
};
use std::{io::Write, path::PathBuf};

/// BDF order at most 2 (revision 7, Configuration).
const MAX_ORDER: usize = 2;
/// The credited band of decision 0015: the settling measure's filter cutoff.
const CREDITED_BAND_HZ: f64 = 2.;
/// A light log line every this many output samples (1 s at 0.1 s).
const LOG_EVERY: usize = 10;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}
fn env_f64(name: &str) -> f64 {
    env(name)
        .parse()
        .unwrap_or_else(|_| panic!("{name} is a number"))
}

/// The one fenced `ld01-s2-gates` block of the declaration draft.
fn gates_block(text: &str) -> Value {
    let fence = "```ld01-s2-gates";
    let mut found = text.match_indices(fence).map(|(i, _)| i);
    let start = found.next().expect("an ld01-s2-gates block");
    assert!(found.next().is_none(), "exactly one ld01-s2-gates block");
    let body = &text[start + fence.len()..];
    let end = body.find("\n```").expect("the block's closing fence");
    serde_json::from_str(body[..end].trim()).expect("the gates block's JSON")
}

/// One credited quantity of the settling block: its name, its threshold on
/// the 20 s range, and whether the range is relative to the window's mean.
struct Credited {
    name: &'static str,
    key: &'static str,
    relative: bool,
}
const CREDITED: [Credited; 8] = [
    Credited {
        name: "core_power_w",
        key: "corePowerRelative",
        relative: true,
    },
    Credited {
        name: "average_coolant_k",
        key: "averageCoolant_K",
        relative: false,
    },
    Credited {
        name: "core_cell_liquid_k",
        key: "cellTemperature_K",
        relative: false,
    },
    Credited {
        name: "pt1_pa",
        key: "pzrRoofPressure_Pa",
        relative: false,
    },
    Credited {
        name: "sg_pressure_pa",
        key: "sgPressure_Pa",
        relative: false,
    },
    Credited {
        name: "pzr_level_m",
        key: "pzrLevel_m",
        relative: false,
    },
    Credited {
        name: "sg_liquid_m3",
        key: "sgLiquidVolume_m3",
        relative: false,
    },
    Credited {
        name: "loop_flow_kg_s",
        key: "loopFlowRelativeChange",
        relative: true,
    },
];

/// The credited outputs and the reported legs at `(t, y, y')`: as the
/// settled-state regression's `credited` (ld01_regression.rs) -- the 27
/// primary cells are every regular cell but SURGE, mass-weighted; the core
/// cells are CORE.*; the loops are RETURN.A/B->DOWN; the SG pressures and
/// liquid volumes are the secondary owner's -- plus every cell's liquid
/// temperature by id for the legs, reported only.
fn observe(
    joined: &mut Joined<If97>,
    packet: &NetworkPacket,
    loops: &[usize; 2],
    t: f64,
    y: &[f64],
    yp: &[f64],
) -> (Vec<Vec<f64>>, Map<String, Value>) {
    joined
        .evaluate(t, y, yp, None, 0., None)
        .expect("observed state");
    let released = joined.heats().nuclear.released_w.value;
    let net = &joined.network;
    let regions = &packet.mechanics.regions;
    let (mut mass, mut weighted, mut core) = (0., 0., Vec::new());
    let mut cells = Map::new();
    for (c, l) in net.cell_layout.iter().enumerate() {
        let id = regions[c].id.as_str();
        let p = y[l.base] * net.scales()[l.base];
        let m = y[l.mass[0]] * net.scales()[l.mass[0]];
        let u = y[l.energy[0]] * net.scales()[l.energy[0]];
        let q = net
            .properties()
            .caloric(false, p, u / m, false)
            .expect("cell caloric");
        let temperature = net.properties().values(&q).temperature_k;
        if id != "SURGE" {
            mass += m;
            weighted += m * temperature;
        }
        if id.starts_with("CORE.") {
            core.push(temperature);
        }
        cells.insert(id.to_string(), json!(temperature));
    }
    let taps = net.pzr_taps().expect("PZR taps");
    let flows: Vec<f64> = loops
        .iter()
        .map(|f| net.chart(*f, 0).expect("loop chart").mass_flow_kg_s.value)
        .collect();
    let (mut sg_p, mut sg_v) = (Vec::new(), Vec::new());
    let mut k = 0;
    for (owner, layout) in joined.layouts() {
        for (i, label) in layout.labels.iter().enumerate() {
            if owner == "secondary" && label.ends_with(".p_s") {
                sg_p.push(y[k] * layout.scales[i]);
            }
            if owner == "secondary" && label.ends_with(".V_l") {
                sg_v.push(y[k] * layout.scales[i]);
            }
            k += 1;
        }
    }
    let credited = vec![
        vec![released],
        vec![weighted / mass],
        core,
        vec![taps.pt1_pa.value],
        sg_p,
        vec![taps.collapsed_level_m.value],
        sg_v,
        flows,
    ];
    (credited, cells)
}

/// The 20 s range of each credited series (filtered, relative where
/// declared), the worst instance per quantity: (range, threshold, holds).
fn ranges(window: &[Vec<Vec<f64>>], dt: f64, thresholds: &[f64]) -> Vec<(f64, f64, bool)> {
    CREDITED
        .iter()
        .enumerate()
        .map(|(q, c)| {
            let instances = window[0][q].len();
            let worst = (0..instances)
                .map(|i| {
                    let series: Vec<f64> = window.iter().map(|s| s[q][i]).collect();
                    let f = filter::zero_phase_lowpass(&series, CREDITED_BAND_HZ, dt);
                    let hi = f.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                    let lo = f.iter().cloned().fold(f64::INFINITY, f64::min);
                    let range = hi - lo;
                    if c.relative {
                        (range / filter::mean(&f)).abs()
                    } else {
                        range
                    }
                })
                .fold(0., filter::larger);
            (worst, thresholds[q], worst <= thresholds[q])
        })
        .collect()
}

fn add(total: &mut [i64; 7], s: &Stats) {
    for (a, b) in total.iter_mut().zip([
        s.steps,
        s.residuals,
        s.jacobians,
        s.nonlinear_iterations,
        s.error_failures,
        s.convergence_failures,
        s.linear_setups,
    ]) {
        *a += b;
    }
}
fn named(c: &[i64; 7]) -> Value {
    json!({"steps": c[0], "residuals": c[1], "jacobians": c[2], "nonlinear_iterations": c[3],
        "error_failures": c[4], "convergence_failures": c[5], "linear_setups": c[6]})
}
fn bits(v: &[f64]) -> Vec<String> {
    v.iter().map(|x| format!("{:016x}", x.to_bits())).collect()
}

#[test]
#[ignore = "S2-07 re-settle (PREVIEW, NOT evidence): requires the joined packet, the wiki, IF97, stock IDA/KLU and the run's environment"]
fn s2_07_resettle_to_the_declared_settling_thresholds() {
    let started = z1::cpu_s();
    let gates_path = env("LD01_S2_GATES_SOURCE");
    let gates_text = std::fs::read_to_string(&gates_path).expect("declaration draft");
    let gates = gates_block(&gates_text);
    let settling = &gates["settling"];
    let window_s = settling["window_s"].as_f64().expect("settling window");
    let output_s = gates["outputInterval_s"].as_f64().expect("output interval");
    assert_eq!(
        settling["measure"].as_str(),
        Some("range (max - min) of the 2 Hz-filtered credited output over the window"),
        "the declared settling measure"
    );
    let thresholds: Vec<f64> = CREDITED
        .iter()
        .map(|c| {
            settling[c.key]
                .as_f64()
                .unwrap_or_else(|| panic!("settling.{}", c.key))
        })
        .collect();
    let cap_s = env_f64("LD01_S2_SETTLE_CAP_S");
    let cpu_cap_s = env_f64("LD01_S2_SETTLE_CPU_CAP_S");
    let checkpoint_s = env_f64("LD01_S2_SETTLE_CHECKPOINT_S");
    let dir = PathBuf::from(env("LD01_S2_SETTLE_DIR"));
    assert!(!dir.exists(), "never overwritten: {}", dir.display());
    std::fs::create_dir_all(&dir).unwrap();
    let mut log = std::fs::File::create(dir.join("settle-log.jsonl")).unwrap();
    let samples_per_window = (window_s / output_s).round() as usize;
    assert!(
        ((samples_per_window as f64) * output_s - window_s).abs() < 1e-9,
        "the window is a whole number of outputs"
    );
    let checkpoint_every = (checkpoint_s / output_s).round() as usize;
    let (packet_path, packet_bytes) = spine::packet_bytes();
    let packet_sha256 = spine::sha256(&packet_bytes);
    let network_packet: NetworkPacket =
        serde_json::from_slice(&packet_bytes).expect("network packet");
    let face = |id: &str| {
        network_packet
            .mechanics
            .faces
            .iter()
            .position(|f| f.id == id)
            .unwrap_or_else(|| panic!("face {id}"))
    };
    let loops = [face("RETURN.A->DOWN"), face("RETURN.B->DOWN")];

    let Started {
        mut joined,
        y,
        yp,
        ids,
        network_ids,
        atol,
        rtol,
        receipt: preparation,
        structure,
        analyses,
        ..
    } = started_full_composition();
    let preparation_cpu_s = z1::cpu_s() - started;
    let (credited0, cells0) = observe(&mut joined, &network_packet, &loops, 0., &y, &yp);
    let nonnegative = joined.network.nonnegative_stocks();
    let restart = Restart {
        newton_coefficient: NEWTON_COEFFICIENT,
        delta_cj_lsetup: DELTA_CJ_LSETUP,
        first_step_s: FIRST_STEP_S,
        start_bound: 1e-12,
        start_passes: 2,
        // Lead decision S2-D21: P_tx after an owner transaction.
        transaction_passes: 12,
        bound_placement: 1e-12,
    };
    let mut ida = Ida::new(
        Integrated::from_blocks(joined, structure, analyses).expect("integrable"),
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: rtol,
        },
    )
    .expect("stock IDA");
    assert_eq!(ida.system().klu_ordering(), KluOrdering::Amd);
    ida.set_max_order(MAX_ORDER).unwrap();
    ida.constrain_nonnegative(&nonnegative).unwrap();
    restart.configure(&mut ida).unwrap();

    let (mut y, mut yp) = (y, yp);
    let mut t = 0.;
    // The credited samples of the current window (and one more).
    let mut window: std::collections::VecDeque<Vec<Vec<f64>>> = std::collections::VecDeque::new();
    window.push_back(credited0.clone());
    let mut k: usize = 0; // output samples taken after t = 0
    let mut totals = [0i64; 7];
    let mut first_second: Option<Value> = None;
    let mut restarts: Vec<Value> = Vec::new();
    let mut checkpoints: Vec<Value> = Vec::new();
    let mut history: Vec<Value> = Vec::new();
    let mut verdict = Value::Null;
    let mut failure: Option<String> = None;
    let mut observation_cpu_s = 0.;
    let mut restart_cpu_s = 0.;
    let mut last_ranges: Vec<(f64, f64, bool)> = Vec::new();
    let write_state = |name: &str, t: f64, y: &[f64], yp: &[f64]| -> Value {
        let path = dir.join(name);
        assert!(!path.exists(), "never overwritten: {}", path.display());
        let bytes = serde_json::to_vec(
            &json!({"t_s": t, "y": y, "yp": yp, "y_bits": bits(y), "yp_bits": bits(yp),
            "packet": packet_path, "packet_sha256": packet_sha256}),
        )
        .unwrap();
        std::fs::write(&path, &bytes).unwrap();
        json!({"file": name, "t_s": t, "sha256": spine::sha256(&bytes)})
    };
    loop {
        let cpu = z1::cpu_s() - started;
        if cpu > cpu_cap_s {
            failure = Some(format!("CPU cap {cpu_cap_s} s reached at t = {t} s"));
            break;
        }
        let next_output = (k + 1) as f64 * output_s;
        let event = ida.system().joined.next_time_event(t);
        let stop = event.map_or(cap_s, |e| e.min(cap_s));
        ida.stop_at(stop).unwrap();
        let target = next_output.min(stop);
        let outcome = ida.advance(target, &mut y, &mut yp);
        match outcome {
            Ok(Advance::Reached(time)) => {
                t = time;
                if (t - next_output).abs() <= 1e-9 * next_output.max(1.) {
                    k += 1;
                    let timer = z1::cpu_s();
                    let (c, cells) = observe(
                        &mut ida.system_mut().joined,
                        &network_packet,
                        &loops,
                        t,
                        &y,
                        &yp,
                    );
                    window.push_back(c.clone());
                    while window.len() > samples_per_window + 1 {
                        window.pop_front();
                    }
                    let st = ida.stats().unwrap();
                    let mut cumulative = totals;
                    add(&mut cumulative, &st);
                    if k == (1. / output_s).round() as usize {
                        first_second = Some(named(&cumulative));
                    }
                    let full = window.len() == samples_per_window + 1;
                    if k.is_multiple_of(LOG_EVERY) {
                        let rs = if full {
                            let w: Vec<Vec<Vec<f64>>> = window.iter().cloned().collect();
                            ranges(&w, output_s, &thresholds)
                        } else {
                            Vec::new()
                        };
                        let line = json!({"t_s": t, "credited": CREDITED.iter().zip(&c).map(|(q, v)| (q.name.to_string(), json!(v))).collect::<Map<String, Value>>(),
                            "ranges_20s": CREDITED.iter().zip(&rs).map(|(q, r)| (q.name.to_string(), json!([r.0, r.1, r.2]))).collect::<Map<String, Value>>(),
                            "cells_k": cells, "ida": named(&cumulative), "last_step_s": st.last_step, "order": st.last_order,
                            "cpu_s": z1::cpu_s() - started});
                        writeln!(log, "{}", serde_json::to_string(&line).unwrap()).unwrap();
                        log.flush().unwrap();
                        if k.is_multiple_of(LOG_EVERY * 10) {
                            history.push(line);
                        }
                        eprintln!(
                            "settle t = {t:.1} s: P = {:.6e} W, p_s = {:?}, steps {}, CPU {:.1} s",
                            c[0][0],
                            c[4],
                            cumulative[0],
                            z1::cpu_s() - started
                        );
                        if full {
                            last_ranges = rs.clone();
                            if rs.iter().all(|r| r.2) {
                                verdict = json!({"settled_at_s": t, "window_s": window_s,
                                    "ranges": CREDITED.iter().zip(&rs).map(|(q, r)| (q.name.to_string(), json!({"range": r.0, "threshold": r.1, "holds": r.2}))).collect::<Map<String, Value>>()});
                            }
                        }
                    }
                    if k.is_multiple_of(checkpoint_every) {
                        checkpoints.push(write_state(
                            &format!("checkpoint-{:05}s.json", t.round() as i64),
                            t,
                            &y,
                            &yp,
                        ));
                    }
                    observation_cpu_s += z1::cpu_s() - timer;
                    if !verdict.is_null() {
                        break;
                    }
                }
                if t >= cap_s {
                    failure = Some(format!(
                        "simulated cap {cap_s} s reached before the thresholds held"
                    ));
                    break;
                }
                if event.is_some_and(|e| (e - t).abs() <= 1e-12 * t.max(1.)) {
                    // Settling declares no time event; one that occurs
                    // restarts exactly (S2-D21) and is reported.
                    let st = ida.stats().unwrap();
                    add(&mut totals, &st);
                    let timer = z1::cpu_s();
                    match discrete_restart(
                        &mut ida,
                        t,
                        Discrete::TimeEvent,
                        &mut y,
                        &network_ids,
                        &atol,
                        rtol,
                        &restart,
                    ) {
                        Ok(r) => {
                            yp.copy_from_slice(&r.yp);
                            restarts.push(json!({"t_s": t, "discrete": "time event", "transacted": r.transacted,
                                "passes_allowed": r.passes_allowed, "projection_passes": r.report.projection_passes,
                                "residual": r.report.residual.value, "constraint_rate": r.report.constraint_rate.value}));
                        }
                        Err(e) => {
                            failure = Some(format!("time-event restart at {t} s: {e}"));
                            break;
                        }
                    }
                    restart_cpu_s += z1::cpu_s() - timer;
                }
            }
            Ok(Advance::Root { time, directions }) => {
                t = time;
                let st = ida.stats().unwrap();
                add(&mut totals, &st);
                let timer = z1::cpu_s();
                let roots: Vec<Value> = directions
                    .iter()
                    .enumerate()
                    .filter(|(_, d)| **d != 0)
                    .map(|(i, d)| json!([i, d]))
                    .collect();
                match discrete_restart(
                    &mut ida,
                    t,
                    Discrete::Roots(&directions),
                    &mut y,
                    &network_ids,
                    &atol,
                    rtol,
                    &restart,
                ) {
                    Ok(r) => {
                        yp.copy_from_slice(&r.yp);
                        restarts.push(json!({"t_s": t, "discrete": "roots", "roots": roots, "transacted": r.transacted,
                            "passes_allowed": r.passes_allowed, "projection_passes": r.report.projection_passes,
                            "residual": r.report.residual.value, "constraint_rate": r.report.constraint_rate.value}));
                    }
                    Err(e) => {
                        failure = Some(format!("root restart at {t} s with roots {roots:?}: {e}"));
                        break;
                    }
                }
                restart_cpu_s += z1::cpu_s() - timer;
            }
            Err(e) => {
                failure = Some(format!("stock IDA at {t} s: {e}"));
                break;
            }
        }
    }
    let st = ida.stats().unwrap();
    add(&mut totals, &st);
    let total_cpu_s = z1::cpu_s() - started;
    let settled_state = write_state("settled-state.json", t, &y, &yp);
    let (final_credited, final_cells) = observe(
        &mut ida.system_mut().joined,
        &network_packet,
        &loops,
        t,
        &y,
        &yp,
    );
    let joined = &ida.system().joined;
    let c = joined.counters;
    let receipt = json!({
        "kind": "s2-07-resettle",
        "status": "PREVIEW (critic H4), NOT evidence: S2 is not declared. Results recorded before any TBD fill.",
        "provenance": spine::provenance(),
        "packet": packet_path, "packet_sha256": packet_sha256,
        "gates": {"source": gates_path, "sha256": spine::sha256(gates_text.as_bytes()), "settling": settling, "outputInterval_s": output_s},
        "preparation": preparation,
        "configuration": {"max_order": MAX_ORDER, "newton_coefficient": NEWTON_COEFFICIENT, "delta_cj_lsetup": DELTA_CJ_LSETUP,
            "first_step_s": FIRST_STEP_S, "relative_tolerance": rtol, "jacobian": "block, cached KLU analyses (S2-D4)", "klu_ordering": "AMD",
            "restart": {"start_passes": 2, "transaction_passes": 12, "rule": "S2-D21"},
            "measure": {"filter": filter::DECLARED_FILTER, "cutoff_hz": CREDITED_BAND_HZ, "sampled_s": output_s, "window_s": window_s,
                "checked": "every 1 s once a full window exists; the worst instance per quantity"},
            "caps": {"simulated_s": cap_s, "process_cpu_s": cpu_cap_s, "source": "lead's S2-07 brief"},
            "checkpoint_s": checkpoint_s},
        "verdict": verdict,
        "failure": failure,
        "reached_s": t,
        "last_ranges_20s": CREDITED.iter().zip(&last_ranges).map(|(q, r)| (q.name.to_string(), json!({"range": r.0, "threshold": r.1, "holds": r.2}))).collect::<Map<String, Value>>(),
        "credited_names": CREDITED.iter().map(|q| q.name).collect::<Vec<_>>(),
        "composed": {"credited": credited0, "cells_k": cells0},
        "settled": {"credited": final_credited, "cells_k": final_cells, "state": settled_state},
        "first_second_counts": first_second,
        "first_second_reference": {"probe_4": {"steps": 1403, "jacobians": 507}},
        "counts": named(&totals),
        "restarts": restarts,
        "checkpoints": checkpoints,
        "cpu": {"process_total_s": total_cpu_s, "preparation_s": preparation_cpu_s, "observation_s": observation_cpu_s,
            "restarts_s": restart_cpu_s, "solver_s": total_cpu_s - preparation_cpu_s - observation_cpu_s - restart_cpu_s,
            "per_simulated_s": (total_cpu_s - preparation_cpu_s) / t.max(1e-9),
            "joined_counters": c,
            "residual_wall_s_per_call": c.residual_wall_s / c.residuals.max(1) as f64,
            "jacobian_wall_s_per_call": c.jacobian_wall_s / c.jacobians.max(1) as f64,
            "load_average_end": String::from_utf8_lossy(&std::process::Command::new("sysctl").args(["-n","vm.loadavg"]).output().unwrap().stdout).trim().to_string()},
        "history_every_10_s": history,
    });
    std::fs::write(
        dir.join("receipt.json"),
        serde_json::to_vec_pretty(&receipt).unwrap(),
    )
    .unwrap();
    println!(
        "{}",
        json!({"verdict": receipt["verdict"], "failure": receipt["failure"], "reached_s": t, "counts": receipt["counts"], "cpu": receipt["cpu"]["process_total_s"]})
    );
}
