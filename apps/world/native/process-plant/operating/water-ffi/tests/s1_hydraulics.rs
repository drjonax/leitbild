//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#s1-declaration-hydraulics-admission
//! S1 hydraulics admission on the actual compiled packet.
//!
//! The configuration, gates and accuracy budgets are read from their wiki
//! owners (the S1 declaration's `ld01-s1-gates` block and the accuracy
//! contract's `ld01-accuracy-contract` block); nothing is retuned here. The
//! run order is the declared one: hydrostatic preparation, RCP start from
//! rest with capped settling, zero-time spectral go/no-go at the settled
//! state, then hold, RCP supply loss and seizure with refined and order-5
//! references. A decisive failure stops dependent runs and is reported.
#![cfg(all(feature = "ida", target_os = "macos"))]
use leitbild_operating_plant::{
    network::{
        CscOut, Network, RotorState, ToleranceClasses,
        packet::Packet,
        prepare::{self, OperatingPoint, Settings},
    },
    rotor::{Shaft, SpeedRequest, Support},
};
use leitbild_operating_water::{
    If97,
    ida::{Advance, Ida, Initial},
    network::Integrated,
    spectrum::{self, Event, Kind},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Instant;

#[repr(C)]
struct Timespec {
    seconds: i64,
    nanoseconds: i64,
}
unsafe extern "C" {
    fn clock_gettime(clock: i32, out: *mut Timespec) -> i32;
}
/// CLOCK_PROCESS_CPUTIME_ID on macOS.
const PROCESS_CPU_CLOCK: i32 = 12;
fn cpu_s() -> f64 {
    let mut t = Timespec {
        seconds: 0,
        nanoseconds: 0,
    };
    // SAFETY: one live stack Timespec matching the C layout; the C library
    // writes it and keeps no pointer.
    let status = unsafe { clock_gettime(PROCESS_CPU_CLOCK, &mut t) };
    assert_eq!(status, 0, "process CPU clock unavailable");
    t.seconds as f64 + t.nanoseconds as f64 * 1e-9
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Settling {
    #[serde(rename = "maxSimulated_s")]
    max_simulated_s: f64,
    #[serde(rename = "maxCpu_s")]
    max_cpu_s: f64,
    #[serde(rename = "window_s")]
    window_s: f64,
    rotor_speed_relative: f64,
    loop_flow_relative_change: f64,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Hold {
    #[serde(rename = "duration_s")]
    duration_s: f64,
    #[serde(rename = "measuredFrom_s")]
    measured_from_s: f64,
    max_steps_per_second: f64,
    max_residuals_per_step: f64,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SupplyLoss {
    rotor: usize,
    #[serde(rename = "duration_s")]
    duration_s: f64,
    #[serde(rename = "earlyWindow_s")]
    early_window_s: f64,
    max_early_steps_per_second: f64,
    max_late_steps_per_second: f64,
    #[serde(rename = "controlWindow_s")]
    control_window_s: f64,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Seizure {
    rotor: usize,
    #[serde(rename = "duration_s")]
    duration_s: f64,
    #[serde(rename = "maxExtraCpu_s")]
    max_extra_cpu_s: f64,
    #[serde(rename = "recoveryWithin_s")]
    recovery_within_s: f64,
    recovery_step_factor: f64,
    #[serde(rename = "controlWindow_s")]
    control_window_s: f64,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SpectrumGate {
    fast_mode_hz: f64,
    light_damping: f64,
    max_excitation_ratio: f64,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Gates {
    relative_tolerance: f64,
    stock_scaled_absolute: f64,
    tracer_scaled_absolute: f64,
    rotor_scaled_absolute: f64,
    #[serde(rename = "volumeFlowAbsolute_m3_s")]
    volume_flow_absolute_m3_s: f64,
    max_order: usize,
    reference_tolerance_factor: f64,
    control_max_order: usize,
    #[serde(rename = "outputInterval_s")]
    output_interval_s: f64,
    #[serde(rename = "projectedFullUnitStep_s")]
    projected_full_unit_step_s: f64,
    #[serde(rename = "integratorBudget_cpu_s_per_s")]
    integrator_budget_cpu_s_per_s: f64,
    #[serde(rename = "totalCpu_s")]
    total_cpu_s: f64,
    run_cap_factor: f64,
    settling: Settling,
    hold: Hold,
    supply_loss: SupplyLoss,
    seizure: Seizure,
    spectrum: SpectrumGate,
    #[serde(rename = "blockedPathMaxVolumeFlow_m3_s")]
    blocked_path_max_volume_flow_m3_s: f64,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Budgets {
    #[serde(rename = "pzrRoofPressureBias_Pa")]
    pzr_roof_pressure_bias_pa: f64,
    #[serde(rename = "pzrRoofPressureSampleNoise_Pa")]
    pzr_roof_pressure_sample_noise_pa: f64,
    #[serde(rename = "pzrLevel_m")]
    pzr_level_m: f64,
    #[serde(rename = "coreDifferentialPressure_Pa")]
    core_differential_pressure_pa: f64,
    #[serde(rename = "hydraulicHead_Pa")]
    hydraulic_head_pa: f64,
    #[serde(rename = "loopFlow_kg_s")]
    loop_flow_kg_s: f64,
    #[serde(rename = "thresholdTiming_s")]
    threshold_timing_s: f64,
    #[serde(rename = "uncreditedAbove_Hz")]
    uncredited_above_hz: f64,
}

/// The single JSON object inside one fenced strict block of a wiki page.
fn strict_block<T: for<'a> Deserialize<'a>>(page: &str, fence: &str) -> T {
    let text = std::fs::read_to_string(page).unwrap_or_else(|e| panic!("{page}: {e}"));
    let open = format!("```{fence}\n");
    let start = text
        .find(&open)
        .unwrap_or_else(|| panic!("{page} has no ```{fence} block"))
        + open.len();
    let end = start
        + text[start..]
            .find("\n```")
            .expect("unterminated strict block");
    serde_json::from_str(&text[start..end]).unwrap_or_else(|e| panic!("{fence}: {e}"))
}

/// Named topology used by the credited outputs, resolved from packet ids.
/// The PZR roof pressure and level come from the stratified cell's taps.
struct Taps {
    loop_faces: [usize; 2],
    lower: usize,
    upper: usize,
}
fn taps(packet: &Packet) -> Taps {
    let face = |id: &str| {
        packet
            .mechanics
            .faces
            .iter()
            .position(|f| f.id == id)
            .unwrap_or_else(|| panic!("no face {id}"))
    };
    let region = |id: &str| {
        packet
            .mechanics
            .regions
            .iter()
            .position(|r| r.id == id)
            .unwrap_or_else(|| panic!("no region {id}"))
    };
    Taps {
        loop_faces: [face("RETURN.A->DOWN"), face("RETURN.B->DOWN")],
        lower: region("LOWER"),
        upper: region("UPPER"),
    }
}

#[derive(Clone, Debug, Default)]
struct Sample {
    t: f64,
    roof_pa: f64,
    pzr_level_m: f64,
    loop_kg_s: [f64; 2],
    core_dp_pa: f64,
    omega: Vec<f64>,
    steps: i64,
    last_step: f64,
    energy_identity_w: f64,
    /// Largest retained |volume flow| on a phase path with an absent donor.
    blocked_path_m3_s: f64,
    /// (face, phase) carrying it, if any.
    blocked_path_at: Option<(usize, usize)>,
}
fn sample<P: leitbild_operating_plant::network::Properties>(
    network: &mut Network<P>,
    taps: &Taps,
    t: f64,
    y: &[f64],
    yp: &[f64],
) -> Sample {
    network
        .evaluate(t, y, yp, None, 0., None)
        .unwrap_or_else(|e| panic!("accepted-output evaluation at t={t}: {e:?}"));
    let pzr = network
        .pzr_taps()
        .unwrap_or_else(|e| panic!("PZR taps at t={t}: {e:?}"));
    let loop_kg_s = taps
        .loop_faces
        .map(|f| network.chart(f, 0).map_or(0., |c| c.mass_flow_kg_s.value));
    let omega = network
        .rotor_index
        .iter()
        .map(|i| y[*i] * network.scales()[*i] / network.rotor_inertia())
        .collect();
    let budget = network.current_budget(y, yp);
    let (blocked_path_m3_s, blocked_path_at) = (0..network.face_count())
        .flat_map(|f| (0..2).map(move |k| (f, k)))
        .filter_map(|(f, k)| network.chart(f, k).map(|c| (f, k, c)))
        .filter(|(_, _, c)| c.blocked_absent_donor)
        .map(|(f, k, c)| (c.volume_flow_m3_s.value.abs(), Some((f, k))))
        .fold(
            (0., None),
            |best, next| if next.0 > best.0 { next } else { best },
        );
    Sample {
        t,
        roof_pa: pzr.roof_pressure_pa,
        pzr_level_m: pzr.level_m,
        loop_kg_s,
        core_dp_pa: network.cell(taps.lower).pressure.value
            - network.cell(taps.upper).pressure.value,
        omega,
        energy_identity_w: budget["fluid_plus_rotor_plus_bearing_minus_motor_w"]
            .as_f64()
            .unwrap(),
        blocked_path_m3_s,
        blocked_path_at,
        ..Sample::default()
    }
}

struct Run {
    samples: Vec<Sample>,
    y: Vec<f64>,
    yp: Vec<f64>,
    steps: i64,
    residuals: i64,
    jacobians: i64,
    error_failures: i64,
    convergence_failures: i64,
    cpu_s: f64,
    solver_cpu_s: f64,
    evaluation_wall_s: f64,
    jacobian_wall_s: f64,
    failure: Option<String>,
}
struct Spec<'a> {
    rtol: f64,
    atol: &'a [f64],
    max_order: usize,
    duration_s: f64,
    output_s: f64,
    step_cap: i64,
    cpu_cap_s: f64,
    blocked_path_limit_m3_s: f64,
}
/// Advance one declared run from a consistent or event-changed state.
#[allow(clippy::too_many_arguments)] // One run's complete, explicit inputs.
fn advance_run(
    network: Network<If97>,
    taps: &Taps,
    y0: &[f64],
    yp0: &[f64],
    ids: &[f64],
    spec: Spec<'_>,
    stop: &dyn Fn(&[Sample]) -> bool,
) -> Run {
    let started = cpu_s();
    let mut y = y0.to_vec();
    let mut yp = yp0.to_vec();
    let system = Integrated::colored(network).expect("colored assembly");
    let mut ida = Ida::new(
        system,
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: ids,
            absolute_tolerance: spec.atol,
            relative_tolerance: spec.rtol,
        },
    )
    .expect("stock IDA construction");
    ida.set_max_order(spec.max_order).expect("max order");
    let stocks = ida.system().network.nonnegative_stocks();
    ida.constrain_nonnegative(&stocks)
        .expect("nonnegative stocks");
    ida.stop_at(spec.duration_s).expect("stop time");
    let mut failure = ida.initialize(spec.output_s, &mut y, &mut yp).err();
    let mut samples = Vec::new();
    let mut diagnostic_cpu = 0.;
    if failure.is_none() {
        let d = cpu_s();
        samples.push(sample(&mut ida.system_mut().network, taps, 0., &y, &yp));
        diagnostic_cpu += cpu_s() - d;
    }
    let mut k = 1;
    while failure.is_none() {
        let target = (k as f64 * spec.output_s).min(spec.duration_s);
        match ida.advance(target, &mut y, &mut yp) {
            Ok(Advance::Reached(t)) => {
                let stats = ida.stats().expect("stats");
                let d = cpu_s();
                let mut s = sample(&mut ida.system_mut().network, taps, t, &y, &yp);
                diagnostic_cpu += cpu_s() - d;
                s.steps = stats.steps;
                s.last_step = stats.last_step;
                samples.push(s);
                let blocked = samples.last().map_or(0., |s: &Sample| s.blocked_path_m3_s);
                if blocked > spec.blocked_path_limit_m3_s {
                    let at = samples.last().and_then(|s: &Sample| s.blocked_path_at);
                    failure = Some(format!(
                        "phantom momentum: blocked phase path (face, phase) {at:?} carries {blocked} m3/s at t={t}"
                    ));
                } else if stats.steps > spec.step_cap {
                    failure = Some(format!("run cap reached: {} steps", stats.steps));
                } else if cpu_s() - started > spec.cpu_cap_s {
                    failure = Some(format!("run CPU cap {} s reached", spec.cpu_cap_s));
                } else if t >= spec.duration_s || stop(&samples) {
                    break;
                }
                k += 1;
            }
            Ok(Advance::Root { time, .. }) => {
                failure = Some(format!("unexpected root at {time} s (S1 declares none)"));
            }
            Err(e) => failure = Some(e),
        }
    }
    let stats = ida.stats().expect("stats");
    let cpu = cpu_s() - started;
    let network = &ida.system().network;
    Run {
        samples,
        y,
        yp,
        steps: stats.steps,
        residuals: stats.residuals,
        jacobians: stats.jacobians,
        error_failures: stats.error_failures,
        convergence_failures: stats.convergence_failures,
        cpu_s: cpu,
        solver_cpu_s: cpu - diagnostic_cpu,
        evaluation_wall_s: network.counters.evaluation_wall_s,
        jacobian_wall_s: network.counters.jacobian_wall_s,
        failure,
    }
}

fn steps_between(run: &Run, from: f64, to: f64) -> f64 {
    let at = |t: f64| {
        run.samples
            .iter()
            .rev()
            .find(|s| s.t <= t + 1e-12)
            .map_or(0, |s| s.steps)
    };
    (at(to) - at(from)) as f64
}
fn run_json(run: &Run, duration: f64) -> Value {
    json!({"steps":run.steps,"residuals":run.residuals,"jacobians":run.jacobians,"error_failures":run.error_failures,"convergence_failures":run.convergence_failures,"cpu_s":run.cpu_s,"solver_cpu_s":run.solver_cpu_s,"evaluation_wall_s":run.evaluation_wall_s,"jacobian_wall_s":run.jacobian_wall_s,"steps_per_simulated_s":run.steps as f64/duration,"solver_cpu_s_per_simulated_s":run.solver_cpu_s/duration,"reached_s":run.samples.last().map(|s|s.t),"failure":run.failure})
}
/// Largest credited-output differences between two runs at common times.
fn compare(a: &Run, b: &Run, window_s: f64) -> Value {
    let mut roof: f64 = 0.;
    let mut level: f64 = 0.;
    let mut dp: f64 = 0.;
    let mut flow: f64 = 0.;
    let mut noise: f64 = 0.;
    let mut previous: Option<f64> = None;
    let mut compared = 0;
    for sa in &a.samples {
        if sa.t > window_s + 1e-12 {
            break;
        }
        let Some(sb) = b.samples.iter().find(|s| (s.t - sa.t).abs() < 1e-9) else {
            continue;
        };
        let difference = sa.roof_pa - sb.roof_pa;
        if let Some(p) = previous {
            noise = noise.max((difference - p).abs());
        }
        previous = Some(difference);
        roof = roof.max(difference.abs());
        level = level.max((sa.pzr_level_m - sb.pzr_level_m).abs());
        dp = dp.max((sa.core_dp_pa - sb.core_dp_pa).abs());
        for k in 0..2 {
            flow = flow.max((sa.loop_kg_s[k] - sb.loop_kg_s[k]).abs());
        }
        compared += 1;
    }
    json!({"window_s":window_s,"compared_samples":compared,"pzr_roof_pressure_pa":roof,"pzr_roof_sample_noise_pa":noise,"pzr_level_m":level,"core_dp_pa":dp,"loop_flow_kg_s":flow})
}
fn within(diff: &Value, budgets: &Budgets) -> bool {
    diff["compared_samples"].as_u64().unwrap() > 0
        && diff["pzr_roof_pressure_pa"].as_f64().unwrap() <= budgets.pzr_roof_pressure_bias_pa
        && diff["pzr_roof_sample_noise_pa"].as_f64().unwrap()
            <= budgets.pzr_roof_pressure_sample_noise_pa
        && diff["pzr_level_m"].as_f64().unwrap() <= budgets.pzr_level_m
        && diff["core_dp_pa"].as_f64().unwrap() <= budgets.core_differential_pressure_pa
        && diff["loop_flow_kg_s"].as_f64().unwrap() <= budgets.loop_flow_kg_s
}

fn running(network: &mut Network<If97>) {
    for r in 0..network.rotor_count() {
        network.set_rotor_state(
            r,
            RotorState {
                support: Support::Supported(SpeedRequest::Nominal),
                shaft: Shaft::Free,
            },
        );
    }
}
fn fresh(packet: &Packet) -> Network<If97> {
    let (mut network, _) = Network::new(packet, If97).expect("network");
    running(&mut network);
    network
}

/// Dense pencil A=dF/dy, B=dF/dy' at a state, column-major.
fn pencil(network: &mut Network<If97>, y: &[f64], yp: &[f64]) -> (Vec<f64>, Vec<f64>) {
    let n = y.len();
    let mut dense = |cj: f64| {
        let (mut d, mut r, mut p) = (vec![0.; n * n], vec![0i64; n * n], vec![0i64; n + 1]);
        network
            .jacobian_dense(
                0.,
                cj,
                y,
                yp,
                CscOut {
                    data: &mut d,
                    rows: &mut r,
                    pointers: &mut p,
                },
            )
            .expect("dense pencil");
        d
    };
    let a = dense(0.);
    let ab = dense(1.);
    let b = ab.iter().zip(&a).map(|(x, y)| x - y).collect();
    (a, b)
}
fn rows(network: &mut Network<If97>, y: &[f64], yp: &[f64]) -> Vec<f64> {
    network
        .evaluate(0., y, yp, None, 0., None)
        .expect("residual");
    network.rows().iter().map(|r| r.value).collect()
}

#[test]
#[ignore = "requires the actual S1 packet, the wiki, maintained IF97 and stock IDA/KLU"]
fn s1_hydraulics_admission() {
    let packet_path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET").unwrap();
    let wiki = std::env::var("LD01_WIKI_ROOT").unwrap();
    let model = format!("{wiki}/world/packs/process-plant/reference-designs/ld-01/model");
    let gates: Gates = strict_block(&format!("{model}/build-readiness.md"), "ld01-s1-gates");
    let budgets: Budgets = strict_block(
        &format!("{model}/operating-hot-spine.md"),
        "ld01-accuracy-contract",
    );
    let packet: Packet =
        serde_json::from_slice(&std::fs::read(&packet_path).unwrap()).expect("packet");
    let declared = &packet.preparation.operating_point;
    assert_eq!(
        declared.rcp_speed_request, "nominal",
        "only the nominal request is selected"
    );
    // The declared 6.00 m saturated preparation (S1 re-declaration).
    let point = OperatingPoint::from(declared);
    let taps = taps(&packet);
    assert!(
        gates.spectrum.fast_mode_hz >= budgets.uncredited_above_hz,
        "spectral fast-mode limit must not reach into the credited band"
    );
    let total_started = cpu_s();
    let wall_started = Instant::now();
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .expect("git provenance")
    };
    let packet_sha256 = std::process::Command::new("shasum")
        .args(["-a", "256", &packet_path])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_string()
        })
        .expect("packet hash");
    let mut receipt = json!({"kind":"s1-hydraulics-admission","packet":packet_path,"packet_sha256":packet_sha256,"app_commit":git(&["rev-parse","HEAD"]),"app_worktree_dirty":!git(&["status","--porcelain"]).is_empty(),"gates":format!("{gates:?}"),"budgets":format!("{budgets:?}")});

    // 1. Hydrostatic preparation at the declared operating point.
    let rotors = vec![
        RotorState {
            support: Support::Supported(SpeedRequest::Nominal),
            shaft: Shaft::Free,
        };
        4
    ];
    let settings = Settings {
        pressure_tolerance_pa: 1e-6,
        max_passes: 50,
        level_match_m: 1e-9,
        eos_row_bound: 1e-12,
        tree_face_bound_pa: 1e-6,
        representation_search: 8,
    };
    let (network, prepared, preparation) =
        prepare::prepare(&packet, If97, &point, &rotors, &settings)
            .expect("hydrostatic preparation");
    receipt["preparation"] = serde_json::to_value(&preparation).unwrap();
    // Declared: the RCPs start from rest through the drive law.
    let mut y0 = prepared.y.clone();
    for index in &network.rotor_index {
        y0[*index] = 0.;
    }
    let classes = ToleranceClasses {
        relative: gates.relative_tolerance,
        stock_scaled: gates.stock_scaled_absolute,
        tracer_scaled: gates.tracer_scaled_absolute,
        rotor_scaled: gates.rotor_scaled_absolute,
        volume_flow_m3_s: gates.volume_flow_absolute_m3_s,
    };
    let atol = network
        .absolute_tolerances(&y0, classes)
        .expect("tolerances");

    // 2. Declared settling run.
    let settle_window = gates.settling.window_s;
    let rotor_rel = gates.settling.rotor_speed_relative;
    let flow_rel = gates.settling.loop_flow_relative_change;
    let omega0 = network.drive().reference_omega_rad_s;
    let settled = move |samples: &[Sample]| {
        let last = samples.last().unwrap();
        let Some(earlier) = samples.iter().rev().find(|s| s.t <= last.t - settle_window) else {
            return false;
        };
        last.omega
            .iter()
            .all(|w| ((w - omega0) / omega0).abs() < rotor_rel)
            && (0..2).all(|k| {
                ((last.loop_kg_s[k] - earlier.loop_kg_s[k]) / last.loop_kg_s[k]).abs() < flow_rel
            })
    };
    // A hydrostatic rest start has no physical phase birth at t=0, so no
    // leading-receipt selection is made; a later birth is the declared no-go.
    let settle_network = network;
    let settle = advance_run(
        settle_network,
        &taps,
        &y0,
        &prepared.yp,
        &prepared.differential,
        Spec {
            rtol: gates.relative_tolerance,
            atol: &atol,
            max_order: gates.max_order,
            duration_s: gates.settling.max_simulated_s,
            output_s: 1.,
            step_cap: i64::MAX,
            cpu_cap_s: gates.settling.max_cpu_s,
            blocked_path_limit_m3_s: gates.blocked_path_max_volume_flow_m3_s,
        },
        &settled,
    );
    let settle_reached = settle.samples.last().map_or(0., |s| s.t);
    let settled_ok = settle.failure.is_none() && settled(&settle.samples);
    receipt["settling"] = json!({"run":run_json(&settle, settle_reached.max(1e-9)),"settled":settled_ok,"final":format!("{:?}", settle.samples.last())});
    let finish = |receipt: &mut Value, verdict: &str| {
        receipt["verdict"] = json!(verdict);
        receipt["total_cpu_s"] = json!(cpu_s() - total_started);
        receipt["total_wall_s"] = json!(wall_started.elapsed().as_secs_f64());
        let out = format!(
            "{}/s1-hydraulics-admission.json",
            std::path::Path::new(&packet_path)
                .parent()
                .unwrap()
                .display()
        );
        std::fs::write(&out, serde_json::to_vec_pretty(receipt).unwrap()).unwrap();
        println!("{}", serde_json::to_string(receipt).unwrap());
    };
    if !settled_ok {
        // Diagnostic only (not a gate): the zero-time spectrum at the last
        // accepted settling state, to attribute what the network was doing.
        let mut probe = fresh(&packet);
        let (a, b) = pencil(&mut probe, &settle.y, &settle.yp);
        if let Ok(stop) = spectrum::decompose(settle.y.len(), &a, &b) {
            let algebraic = prepared.differential.iter().filter(|v| **v == 0.).count();
            let labels = probe.labels();
            let localize = |m: usize| -> Vec<Value> {
                let mut weight: Vec<(f64, usize)> = stop.shapes[m]
                    .right
                    .iter()
                    .enumerate()
                    .map(|(i, v)| (v.abs(), i))
                    .collect();
                weight.sort_by(|a, b| b.0.total_cmp(&a.0));
                weight
                    .iter()
                    .take(4)
                    .map(|(w, i)| json!({"coordinate":labels[*i].1,"weight":w}))
                    .collect()
            };
            let unstable: Vec<Value> = stop
                .modes
                .iter()
                .enumerate()
                .filter(|(_, m)| m.unstable)
                .map(|(i, m)| json!({"hz":m.frequency_hz,"re":m.lambda.re,"e_fold_s":m.e_fold_s,"dominant":localize(i)}))
                .collect();
            receipt["diagnostic_spectrum_at_stop"] = json!({"finite":stop.modes.len(),"infinite":stop.infinite.count,"algebraic":algebraic,"unstable":unstable,"marginal":stop.modes.iter().filter(|m|m.marginal).count()});
        }
        receipt["stop_sample"] = json!(format!("{:?}", settle.samples.last()));
        finish(
            &mut receipt,
            "STOP: settling did not reach the declared mechanical rest",
        );
        panic!("S1 settling failed: {:?}", settle.failure);
    }
    let (ys, yps) = (settle.y.clone(), settle.yp.clone());

    // 3. Zero-time spectrum at the settled state, before any event run.
    let tol = spectrum::tolerance(gates.relative_tolerance, &ys, &atol).expect("tolerance");
    let mut probe = fresh(&packet);
    let (a, b) = pencil(&mut probe, &ys, &yps);
    let before = rows(&mut probe, &ys, &yps);
    probe.set_rotor_state(
        gates.supply_loss.rotor,
        RotorState {
            support: Support::Unsupported,
            shaft: Shaft::Free,
        },
    );
    let after = rows(&mut probe, &ys, &yps);
    let supply: Vec<f64> = after.iter().zip(&before).map(|(x, y)| x - y).collect();
    let pre = spectrum::decompose(ys.len(), &a, &b).expect("settled spectrum");
    let pre_report = pre
        .report(
            &[Event {
                kind: Kind::Residual,
                vector: &supply,
            }],
            &tol,
        )
        .expect("supply-loss excitation");
    let mut locked = fresh(&packet);
    let mut y_post = ys.clone();
    let locking = locked
        .seize(gates.seizure.rotor, &mut y_post)
        .expect("seizure");
    let (a2, b2) = pencil(&mut locked, &y_post, &yps);
    let seizure_forcing = rows(&mut locked, &y_post, &yps);
    let post = spectrum::decompose(ys.len(), &a2, &b2).expect("post-seizure spectrum");
    let post_report = post
        .report(
            &[Event {
                kind: Kind::Residual,
                vector: &seizure_forcing,
            }],
            &tol,
        )
        .expect("seizure excitation");
    let algebraic = prepared.differential.iter().filter(|v| **v == 0.).count();
    let fast_excited = |report: &spectrum::Report| -> Vec<Value> {
        report.events[0]
            .responses
            .iter()
            .zip(&report.modes)
            .filter(|(r, m)| {
                m.frequency_hz > gates.spectrum.fast_mode_hz
                    && m.damping_ratio.is_some_and(|z| z < gates.spectrum.light_damping)
                    && r.ratio > gates.spectrum.max_excitation_ratio
            })
            .map(|(r, m)| json!({"hz":m.frequency_hz,"zeta":m.damping_ratio,"ratio":r.ratio,"coordinate":r.coordinate}))
            .collect()
    };
    let spectral = json!({
        "pre":{"finite":pre_report.finite,"infinite":pre_report.infinite.count,"algebraic":algebraic,"unstable":pre_report.unstable,"marginal":pre_report.marginal,"fast_excited":fast_excited(&pre_report),"max_ratio":pre_report.events[0].max_ratio,"dggev_s":pre_report.dggev_seconds,
            "modes_above_fast_hz":pre_report.modes.iter().filter(|m|m.frequency_hz>gates.spectrum.fast_mode_hz).map(|m|json!({"hz":m.frequency_hz,"zeta":m.damping_ratio})).collect::<Vec<_>>(),
            "slowest_oscillatory":pre_report.modes.iter().filter(|m|m.frequency_hz>0.).take(8).map(|m|json!({"hz":m.frequency_hz,"zeta":m.damping_ratio,"e_fold_s":m.e_fold_s})).collect::<Vec<_>>()},
        "post_seizure":{"finite":post_report.finite,"infinite":post_report.infinite.count,"algebraic":algebraic+1,"unstable":post_report.unstable,"marginal":post_report.marginal,"fast_excited":fast_excited(&post_report),"max_ratio":post_report.events[0].max_ratio,"removed_rotor_energy_j":locking.event.map(|e|e.removed_kinetic_energy_j)}
    });
    let go = pre_report.unstable == 0
        && post_report.unstable == 0
        && pre_report.infinite.count == algebraic
        && post_report.infinite.count == algebraic + 1
        && spectral["pre"]["fast_excited"]
            .as_array()
            .unwrap()
            .is_empty()
        && spectral["post_seizure"]["fast_excited"]
            .as_array()
            .unwrap()
            .is_empty();
    receipt["spectrum"] = spectral;
    if !go {
        finish(
            &mut receipt,
            "NO-GO: zero-time spectral criterion failed; escalate",
        );
        panic!("S1 spectral no-go");
    }

    // 4. Event runs with references.
    let interval = gates.output_interval_s;
    let base = |duration: f64, rate: f64, rtol: f64, atol: &'static [f64], order: usize| Spec {
        rtol,
        atol,
        max_order: order,
        duration_s: duration,
        output_s: interval,
        step_cap: (gates.run_cap_factor * rate * duration) as i64,
        cpu_cap_s: gates.total_cpu_s,
        blocked_path_limit_m3_s: gates.blocked_path_max_volume_flow_m3_s,
    };
    let atol_static: &'static [f64] = Box::leak(atol.clone().into_boxed_slice());
    let refined: &'static [f64] = Box::leak(
        atol.iter()
            .map(|v| v * gates.reference_tolerance_factor)
            .collect::<Vec<_>>()
            .into_boxed_slice(),
    );
    let rtol = gates.relative_tolerance;
    let rtol_ref = rtol * gates.reference_tolerance_factor;
    let never = |_: &[Sample]| false;
    let ids = prepared.differential.clone();
    let event_network = |kind: &str, y: &mut Vec<f64>| -> (Network<If97>, Vec<f64>) {
        let mut n = fresh(&packet);
        let ids = match kind {
            "supply" => {
                n.set_rotor_state(
                    gates.supply_loss.rotor,
                    RotorState {
                        support: Support::Unsupported,
                        shaft: Shaft::Free,
                    },
                );
                ids.clone()
            }
            "seizure" => {
                n.seize(gates.seizure.rotor, y).expect("seizure");
                n.differential(&ids)
            }
            _ => ids.clone(),
        };
        (n, ids)
    };
    let hold_rate = gates.hold.max_steps_per_second;
    let mut cases = serde_json::Map::new();
    let mut ok = true;
    // Hold.
    let (n, i) = event_network("hold", &mut ys.clone());
    let hold = advance_run(
        n,
        &taps,
        &ys,
        &yps,
        &i,
        base(
            gates.hold.duration_s,
            hold_rate,
            rtol,
            atol_static,
            gates.max_order,
        ),
        &never,
    );
    let (n, i) = event_network("hold", &mut ys.clone());
    let hold_ref = advance_run(
        n,
        &taps,
        &ys,
        &yps,
        &i,
        base(
            gates.hold.duration_s,
            f64::INFINITY,
            rtol_ref,
            refined,
            gates.max_order,
        ),
        &never,
    );
    let measured = gates.hold.duration_s - gates.hold.measured_from_s;
    let hold_rate_measured =
        steps_between(&hold, gates.hold.measured_from_s, gates.hold.duration_s) / measured;
    let hold_residuals = hold.residuals as f64 / hold.steps.max(1) as f64;
    let hold_diff = compare(&hold, &hold_ref, gates.hold.duration_s);
    let hold_pass = hold.failure.is_none()
        && hold_rate_measured <= hold_rate
        && hold_residuals <= gates.hold.max_residuals_per_step
        && within(&hold_diff, &budgets);
    ok &= hold_pass;
    let quiet_step = 1. / hold_rate_measured.max(1e-9);
    cases.insert("hold".into(), json!({"run":run_json(&hold,gates.hold.duration_s),"reference":run_json(&hold_ref,gates.hold.duration_s),"steps_per_s_measured":hold_rate_measured,"residuals_per_step":hold_residuals,"reference_difference":hold_diff,"pass":hold_pass}));
    // RCP supply loss.
    let sl = &gates.supply_loss;
    let mut y = ys.clone();
    let (n, i) = event_network("supply", &mut y);
    let trip = advance_run(
        n,
        &taps,
        &y,
        &yps,
        &i,
        base(
            sl.duration_s,
            sl.max_early_steps_per_second,
            rtol,
            atol_static,
            gates.max_order,
        ),
        &never,
    );
    let (n, i) = event_network("supply", &mut ys.clone());
    let trip_ref = advance_run(
        n,
        &taps,
        &ys,
        &yps,
        &i,
        base(
            sl.duration_s,
            f64::INFINITY,
            rtol_ref,
            refined,
            gates.max_order,
        ),
        &never,
    );
    let (n, i) = event_network("supply", &mut ys.clone());
    let trip_ctl = advance_run(
        n,
        &taps,
        &ys,
        &yps,
        &i,
        base(
            sl.control_window_s,
            f64::INFINITY,
            rtol,
            atol_static,
            gates.control_max_order,
        ),
        &never,
    );
    let early = steps_between(&trip, 0., sl.early_window_s) / sl.early_window_s;
    let late = steps_between(&trip, sl.early_window_s, sl.duration_s)
        / (sl.duration_s - sl.early_window_s);
    let trip_ref_diff = compare(&trip, &trip_ref, sl.duration_s);
    let trip_ctl_diff = compare(&trip, &trip_ctl, sl.control_window_s);
    let trip_pass = trip.failure.is_none()
        && early <= sl.max_early_steps_per_second
        && late <= sl.max_late_steps_per_second
        && within(&trip_ref_diff, &budgets)
        && within(&trip_ctl_diff, &budgets);
    ok &= trip_pass;
    cases.insert("rcp_supply_loss".into(), json!({"run":run_json(&trip,sl.duration_s),"reference":run_json(&trip_ref,sl.duration_s),"order5_control":run_json(&trip_ctl,sl.control_window_s),"early_steps_per_s":early,"late_steps_per_s":late,"reference_difference":trip_ref_diff,"control_difference":trip_ctl_diff,"pass":trip_pass}));
    // RCP seizure.
    let sz = &gates.seizure;
    let mut y = ys.clone();
    let (n, i) = event_network("seizure", &mut y);
    let seize_cap_rate =
        sz.max_extra_cpu_s / gates.projected_full_unit_step_s / sz.duration_s + hold_rate;
    let seize = advance_run(
        n,
        &taps,
        &y,
        &yps,
        &i,
        base(
            sz.duration_s,
            seize_cap_rate,
            rtol,
            atol_static,
            gates.max_order,
        ),
        &never,
    );
    let mut y = ys.clone();
    let (n, i) = event_network("seizure", &mut y);
    let seize_ref = advance_run(
        n,
        &taps,
        &y,
        &yps,
        &i,
        base(
            sz.duration_s,
            f64::INFINITY,
            rtol_ref,
            refined,
            gates.max_order,
        ),
        &never,
    );
    let mut y = ys.clone();
    let (n, i) = event_network("seizure", &mut y);
    let seize_ctl = advance_run(
        n,
        &taps,
        &y,
        &yps,
        &i,
        base(
            sz.control_window_s,
            f64::INFINITY,
            rtol,
            atol_static,
            gates.control_max_order,
        ),
        &never,
    );
    let extra_steps = (seize.steps as f64 - hold_rate_measured * sz.duration_s).max(0.);
    let extra_cpu = extra_steps * gates.projected_full_unit_step_s;
    let recovered = seize
        .samples
        .iter()
        .find(|s| s.t >= sz.recovery_within_s - 1e-12)
        .is_some_and(|s| s.last_step * sz.recovery_step_factor >= quiet_step);
    let seize_ref_diff = compare(&seize, &seize_ref, sz.duration_s);
    let seize_ctl_diff = compare(&seize, &seize_ctl, sz.control_window_s);
    let seize_pass = seize.failure.is_none()
        && extra_cpu <= sz.max_extra_cpu_s
        && recovered
        && within(&seize_ref_diff, &budgets)
        && within(&seize_ctl_diff, &budgets);
    ok &= seize_pass;
    cases.insert("rcp_seizure".into(), json!({"run":run_json(&seize,sz.duration_s),"reference":run_json(&seize_ref,sz.duration_s),"order5_control":run_json(&seize_ctl,sz.control_window_s),"extra_steps":extra_steps,"extra_cpu_at_projected_step_s":extra_cpu,"recovered_step_within_s":recovered,"reference_difference":seize_ref_diff,"control_difference":seize_ctl_diff,"pass":seize_pass}));

    // 5. Joint cost check and conservation identity across every run.
    let joint = hold_rate_measured * gates.projected_full_unit_step_s;
    let joint_pass = joint <= gates.integrator_budget_cpu_s_per_s;
    ok &= joint_pass;
    let identity = [&hold, &trip, &seize]
        .iter()
        .flat_map(|r| r.samples.iter().map(|s| s.energy_identity_w.abs()))
        .fold(0., f64::max);
    let total = cpu_s() - total_started;
    let within_budget = total <= gates.total_cpu_s;
    ok &= within_budget;
    receipt["cases"] = Value::Object(cases);
    receipt["joint"] = json!({"quiet_steps_per_s":hold_rate_measured,"projected_full_unit_step_s":gates.projected_full_unit_step_s,"projected_integrator_cpu_s_per_s":joint,"pass":joint_pass});
    receipt["energy_identity_max_abs_w"] = json!(identity);
    receipt["budgets_not_exercised"] = json!({"hydraulic_head_pa":budgets.hydraulic_head_pa,"threshold_timing_s":budgets.threshold_timing_s,"reason":"S1 has forced circulation only and no root-found protection thresholds; natural-circulation head and trip timing are exercised from S2/S3"});
    receipt["total_cpu_within_budget"] = json!(within_budget);
    finish(
        &mut receipt,
        if ok {
            "PASS: all S1 gates met"
        } else {
            "FAIL: at least one S1 gate missed"
        },
    );
    assert!(ok, "S1 gates missed; see the receipt");
}

/// Harness smoke test only, NOT S1 evidence: preparation and a few seconds
/// of the declared RCP start, to exercise the pipeline before the gate run.
#[test]
#[ignore = "requires the actual packet, the wiki, maintained IF97 and stock IDA/KLU"]
fn s1_harness_smoke() {
    let packet_path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET").unwrap();
    let wiki = std::env::var("LD01_WIKI_ROOT").unwrap();
    let model = format!("{wiki}/world/packs/process-plant/reference-designs/ld-01/model");
    let gates: Gates = strict_block(&format!("{model}/build-readiness.md"), "ld01-s1-gates");
    let packet: Packet =
        serde_json::from_slice(&std::fs::read(&packet_path).unwrap()).expect("packet");
    let declared = &packet.preparation.operating_point;
    // The declared 6.00 m saturated preparation (S1 re-declaration).
    let point = OperatingPoint::from(declared);
    let taps = taps(&packet);
    let rotors = vec![
        RotorState {
            support: Support::Supported(SpeedRequest::Nominal),
            shaft: Shaft::Free,
        };
        4
    ];
    let settings = Settings {
        pressure_tolerance_pa: 1e-6,
        max_passes: 50,
        level_match_m: 1e-9,
        eos_row_bound: 1e-12,
        tree_face_bound_pa: 1e-6,
        representation_search: 8,
    };
    let (network, prepared, preparation) =
        prepare::prepare(&packet, If97, &point, &rotors, &settings).expect("preparation");
    let mut y0 = prepared.y.clone();
    for index in &network.rotor_index {
        y0[*index] = 0.;
    }
    let atol = network
        .absolute_tolerances(
            &y0,
            ToleranceClasses {
                relative: gates.relative_tolerance,
                stock_scaled: gates.stock_scaled_absolute,
                tracer_scaled: gates.tracer_scaled_absolute,
                rotor_scaled: gates.rotor_scaled_absolute,
                volume_flow_m3_s: gates.volume_flow_absolute_m3_s,
            },
        )
        .expect("tolerances");
    let run = advance_run(
        network,
        &taps,
        &y0,
        &prepared.yp,
        &prepared.differential,
        Spec {
            rtol: gates.relative_tolerance,
            atol: &atol,
            max_order: gates.max_order,
            duration_s: 3.,
            output_s: 0.5,
            step_cap: 200_000,
            cpu_cap_s: 60.,
            blocked_path_limit_m3_s: gates.blocked_path_max_volume_flow_m3_s,
        },
        &|_: &[Sample]| false,
    );
    println!(
        "{}",
        json!({"kind":"s1-harness-smoke-NOT-EVIDENCE","packet":packet_path,"preparation_passes":preparation.pass_changes_pa.len(),"max_eos_row":preparation.max_eos_row,"max_loop_rest_pa":preparation.max_loop_rest_pa,"max_phase_drive_pa":preparation.max_phase_drive_pa,"mass_change_kg":preparation.mass_change_kg,"run":run_json(&run,3.),"samples":run.samples.iter().map(|s|json!({"t":s.t,"roof_pa":s.roof_pa,"loop_kg_s":s.loop_kg_s,"omega":s.omega,"steps":s.steps,"h":s.last_step,"energy_identity_w":s.energy_identity_w,"blocked_path_m3_s":s.blocked_path_m3_s})).collect::<Vec<_>>()})
    );
}
