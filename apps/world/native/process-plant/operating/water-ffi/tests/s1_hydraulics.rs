//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#s1-declaration-hydraulics-admission
//! S1 hydraulics admission on the actual compiled packet.
//!
//! The configuration, gates and accuracy budgets are read from their wiki
//! owners (the S1 declaration's `ld01-s1-gates` block and the accuracy
//! contract's `ld01-accuracy-contract` block); nothing is retuned here. The
//! run order is the declared one: hydrostatic preparation, RCP start from
//! rest with capped settling, zero-time spectral go/no-go at the settled
//! state, then the hold against its rtol/10 reference, and RCP supply loss
//! and seizure, each in a capped event window against the 2.5 ms-capped and
//! rtol/100 references (request 2, E0-E3, with request 3's cap-cycle floor,
//! H2), then restarted at the window's end by the exact consistent start and
//! continued 10 s at stock settings, its recovery judged on cost (H1) beside
//! a never-capped reference run, R0, whose comparisons are reported only and
//! whose frozen failure rules apply as in every S1 run.
//! Credited outputs are observed every 0.002 s through one stock IDA root
//! function, which changes no step, and are compared after the contract's
//! zero-phase low-pass. A decisive failure stops dependent runs and is
//! reported.
#![cfg(all(feature = "ida", target_os = "macos"))]
use leitbild_operating_plant::{
    network::{
        Band, ConsistentPair, ConsistentSystem, CscOut, MetastableBand, Network, Properties,
        PzrPreparation, RotorState, ToleranceClasses, consistent_start,
        packet::Packet,
        prepare::{self, OperatingPoint, Settings},
        stratified,
    },
    rotor::{Shaft, SpeedRequest, Support},
};
use leitbild_operating_water::{
    If97,
    ida::{Advance, Failure, Ida, Initial, Stats, System},
    network::Integrated,
    spectrum::{self, Event, Kind},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{f64::consts::PI, time::Instant};

// Process CPU (CLOCK_PROCESS_CPUTIME_ID) and the 1-, 5- and 15-minute load
// averages, recorded at the receipt's start and end for the declared CPU
// measurement hygiene.
#[path = "common/cpu.rs"]
mod cpu;
use cpu::{load_average, process_cpu_s as cpu_s};
// The helpers S1 shares with the S2 gate harness (s2_gates.rs).
#[path = "common/counts.rs"]
mod counts;
#[path = "common/filter.rs"]
mod filter;
#[path = "common/observe.rs"]
mod observe;
#[path = "common/provenance.rs"]
mod provenance;
use counts::{CONVERGENCE_FAILURES_COUNTER, Counts, Mark};
use filter::{
    CAP_CYCLE_RULE, DECLARED_FILTER, EXCESS_SPECTRUM_METHOD, WELCH_SEGMENT_S, cap_cycle_output,
    content_above_band, deviation, excess_spectrum, larger, max_abs, mean, padding_s, welch,
    zero_phase_lowpass,
};
use observe::{Clock, Observed, whole};
use provenance::{WATER_BUILD, WATER_LIB_DIR, sha256_file, strict_block, water_build};

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
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Seizure {
    rotor: usize,
    #[serde(rename = "duration_s")]
    duration_s: f64,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SpectrumGate {
    fast_mode_hz: f64,
    light_damping: f64,
    max_excitation_ratio: f64,
}
/// E2: the capped event window and its cost budget.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct EventWindow {
    #[serde(rename = "maxStep_s")]
    max_step_s: f64,
    newton_coefficient_factor: f64,
    #[serde(rename = "budget_cpu_s_per_s")]
    budget_cpu_s_per_s: f64,
    #[serde(rename = "maxWindow_s")]
    max_window_s: f64,
    #[serde(rename = "fullUnitStepExit_s")]
    full_unit_step_exit_s: f64,
}
/// E3: the capped reference R1, the second refinement R2 and the bound on
/// content above the credited band; H2: the floor, as a fraction of each
/// output's credited budget, above which that bound is judged.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct EventReference {
    #[serde(rename = "maxStep_s")]
    max_step_s: f64,
    second_refinement_tolerance_factor: f64,
    cap_cycle_uncredited_rms_ratio_max: f64,
    cap_cycle_floor_budget_fraction: f64,
}
/// E0/E1: the filter and observation interval of the contract's comparison.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Comparison {
    filter: String,
    #[serde(rename = "observation_s")]
    observation_s: f64,
}
/// H1: the continuation after each event window, restarted at the window's
/// forced stop by the named restart and judged on cost, with at most
/// `max_convergence_failures` Newton convergence failures.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Recovery {
    #[serde(rename = "postWindow_s")]
    post_window_s: f64,
    restart: String,
    max_convergence_failures: u32,
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
    event_window: EventWindow,
    event_reference: EventReference,
    comparison: Comparison,
    recovery: Recovery,
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

/// The restart the harness implements at each event window's forced stop
/// ([`restart`], H1); the declared block must name it.
const DECLARED_RESTART: &str = "exact consistent start";
/// Stock IDA's Newton convergence coefficient (SUNDIALS 7.5.0 `ida.c`
/// EPCON), which the event window tightens by `newtonCoefficientFactor`.
/// Stock reads it once, in its first-call setup after construction or
/// IDAReInit, so the tightened value holds over the window only; H1's
/// restart sets this stock value again before the continuation's first step.
const STOCK_NEWTON_COEFFICIENT: f64 = 0.33;

impl Gates {
    /// Checks of the declared configuration before any run: the block names
    /// the implemented filter and restart; the observation interval divides
    /// the output interval, which divides every timed span; both event
    /// windows, each with its recovery continuation (H1), lie within E2's
    /// budget window; the projected full-unit step is below E2's exit; the
    /// cap-cycle floor is a fraction of the credited budget (H2); and the
    /// credited band lies below the observation's Nyquist frequency and the
    /// spectral fast-mode limit.
    fn check(&self, budgets: &Budgets) {
        assert_eq!(
            self.comparison.filter, DECLARED_FILTER,
            "undeclared comparison filter"
        );
        assert_eq!(
            self.recovery.restart, DECLARED_RESTART,
            "undeclared recovery restart"
        );
        let (dt, output) = (self.comparison.observation_s, self.output_interval_s);
        assert!(
            whole(output, dt) && output / dt >= 2.,
            "the {dt} s observation must divide the {output} s output interval"
        );
        for span in [
            self.hold.duration_s,
            self.hold.measured_from_s,
            self.supply_loss.duration_s,
            self.seizure.duration_s,
            self.recovery.post_window_s,
        ] {
            assert!(
                whole(span, output),
                "{span} s is not a whole number of {output} s outputs"
            );
        }
        for window in [self.supply_loss.duration_s, self.seizure.duration_s] {
            assert!(
                window + self.recovery.post_window_s <= self.event_window.max_window_s,
                "a {window} s event window and its {} s recovery exceed E2's {} s",
                self.recovery.post_window_s,
                self.event_window.max_window_s
            );
        }
        assert!(
            self.projected_full_unit_step_s <= self.event_window.full_unit_step_exit_s,
            "the projected full-unit step reaches E2's exit: E2 returns to the owner"
        );
        let floor = self.event_reference.cap_cycle_floor_budget_fraction;
        assert!(
            floor > 0. && floor < 1.,
            "the cap-cycle floor {floor} is not a fraction of the credited budget"
        );
        assert!(
            budgets.uncredited_above_hz > 0. && 2. * budgets.uncredited_above_hz * dt < 1.,
            "the credited band must lie below the observation's Nyquist frequency"
        );
        assert!(
            self.spectrum.fast_mode_hz >= budgets.uncredited_above_hz,
            "spectral fast-mode limit must not reach into the credited band"
        );
    }
    /// E2's cost budget in steps over a span: budget x span / projected
    /// full-unit step. Over the window it is E2's own gate; over the window
    /// and its continuation together, H1's recovery gate.
    fn budget_steps(&self, span_s: f64) -> f64 {
        self.event_window.budget_cpu_s_per_s * span_s / self.projected_full_unit_step_s
    }
    /// The run cap over a span, `runCapFactor` times its budget in steps;
    /// reaching it fails the run (frozen failure rules).
    fn cap_steps(&self, span_s: f64) -> i64 {
        (self.run_cap_factor * self.budget_steps(span_s)) as i64
    }
}

/// Named topology used by the credited outputs, resolved from packet ids.
/// The PZR roof pressure and level come from the stratified cell's taps.
struct Taps {
    /// The A layer's coordinate and the packet's `resolvabilityFactor`.
    admitted_mass: usize,
    resolvability_factor: f64,
    loop_faces: [usize; 2],
    lower: usize,
    upper: usize,
}
fn taps(packet: &Packet, network: &Network<If97>) -> Taps {
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
        admitted_mass: network.pzr.base + stratified::ADMITTED_MASS,
        resolvability_factor: packet.pzr.cell.stratified.resolvability_factor,
        loop_faces: [face("RETURN.A->DOWN"), face("RETURN.B->DOWN")],
        lower: region("LOWER"),
        upper: region("UPPER"),
    }
}

/// The outputs the accuracy contract budgets, at one observed state.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Credited {
    t: f64,
    roof_pa: f64,
    level_m: f64,
    core_dp_pa: f64,
    loop_kg_s: [f64; 2],
}
/// The credited outputs of the network's latest evaluation, at `t`.
fn read_credited<P: Properties>(
    network: &Network<P>,
    taps: &Taps,
    t: f64,
) -> Result<Credited, String> {
    let pzr = network
        .pzr_taps()
        .map_err(|e| format!("PZR taps at t={t}: {e:?}"))?;
    Ok(Credited {
        t,
        roof_pa: pzr.pt1_pa.value,
        level_m: pzr.collapsed_level_m.value,
        core_dp_pa: network.cell(taps.lower).pressure.value
            - network.cell(taps.upper).pressure.value,
        loop_kg_s: taps
            .loop_faces
            .map(|f| network.chart(f, 0).map_or(0., |c| c.mass_flow_kg_s.value)),
    })
}
/// Evaluate a probe network at an observed state and read its credited
/// outputs; the integrated network and the solver history are untouched.
fn observe<P: Properties>(
    probe: &mut Network<P>,
    taps: &Taps,
    t: f64,
    y: &[f64],
    yp: &[f64],
) -> Result<Credited, String> {
    probe
        .evaluate(t, y, yp, None, 0., None)
        .map_err(|e| format!("observation evaluation at t={t}: {e:?}"))?;
    read_credited(probe, taps, t)
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
    /// Sum of the identity's absolute terms, for its relative bound.
    energy_identity_terms_w: f64,
    /// Largest retained |volume flow| on a phase path with an absent donor.
    blocked_path_m3_s: f64,
    /// (face, phase) carrying it, if any.
    blocked_path_at: Option<(usize, usize)>,
    /// Accepted-state band reports of the vapor, A and R zones: signed
    /// `T - Tsat(p)`, beyond the admitted band, above the credited bound.
    departure_k: [f64; 3],
    band_exceeded: bool,
    uncredited: bool,
    /// Smallest drag-law gap margin of the bubble and drop terminals.
    gap_margin: f64,
    admitted_mass_kg: f64,
    /// Transit saturation-drift heats [bubbles, drops], W, and p_s'.
    transit_drift_w: [f64; 2],
    interface_pressure_rate_pa_s: f64,
}
impl Sample {
    fn credited(&self) -> Credited {
        Credited {
            t: self.t,
            roof_pa: self.roof_pa,
            level_m: self.pzr_level_m,
            core_dp_pa: self.core_dp_pa,
            loop_kg_s: self.loop_kg_s,
        }
    }
}
fn sample<P: Properties>(
    network: &mut Network<P>,
    taps: &Taps,
    t: f64,
    y: &[f64],
    yp: &[f64],
) -> Sample {
    network
        .evaluate(t, y, yp, None, 0., None)
        .unwrap_or_else(|e| panic!("accepted-output evaluation at t={t}: {e:?}"));
    let credited = read_credited(network, taps, t).unwrap_or_else(|e| panic!("{e}"));
    let pzr = network
        .pzr_taps()
        .unwrap_or_else(|e| panic!("PZR taps at t={t}: {e:?}"));
    let bands = network
        .pzr_band_reports()
        .unwrap_or_else(|e| panic!("PZR band reports at t={t}: {e:?}"));
    let flows = network
        .pzr_evaluation()
        .unwrap_or_else(|| panic!("PZR rows unevaluated at t={t}"))
        .flows;
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
        roof_pa: credited.roof_pa,
        pzr_level_m: credited.level_m,
        loop_kg_s: credited.loop_kg_s,
        core_dp_pa: credited.core_dp_pa,
        omega,
        energy_identity_w: budget["fluid_plus_rotor_plus_bearing_minus_motor_w"]
            .as_f64()
            .unwrap(),
        energy_identity_terms_w: budget["identity_terms_abs_sum_w"].as_f64().unwrap(),
        blocked_path_m3_s,
        blocked_path_at,
        departure_k: bands.map(|b| b.departure_k),
        band_exceeded: bands.iter().any(|b| b.band == Band::Exceeded),
        uncredited: bands
            .iter()
            .any(|b| b.band == Band::Admitted { credited: false }),
        gap_margin: flows.bubble.gap_margin.min(flows.drop.gap_margin),
        admitted_mass_kg: pzr.admitted_mass_kg.value,
        transit_drift_w: flows.transit_drift.map(|q| q.value),
        interface_pressure_rate_pa_s: flows.interface_pressure_rate.value,
        ..Sample::default()
    }
}

/// Fine observation of a run's window on a probe network configured as the
/// run's own network (same packet, rotor states and event).
struct Observation {
    probe: Network<If97>,
    interval_s: f64,
}
/// H1: the continuation after the window, restarted at its forced stop
/// ([`restart`]); its step cap applies to the window's and the
/// continuation's steps together.
struct Continuation {
    duration_s: f64,
    step_cap: i64,
}
struct Spec<'a> {
    rtol: f64,
    atol: &'a [f64],
    max_order: usize,
    /// The window from the run's start, s; its end is a forced stop.
    duration_s: f64,
    output_s: f64,
    /// Steps over the window that fail the run.
    step_cap: i64,
    cpu_cap_s: f64,
    blocked_path_limit_m3_s: f64,
    /// IDASetMaxStep over the window; +inf leaves stock unbounded. A
    /// continuation restarts unbounded.
    max_step_s: f64,
    /// IDASetNonlinConvCoef over the window; `None` keeps stock's. A
    /// continuation restarts at stock's.
    newton_coefficient: Option<f64>,
    observation: Option<Observation>,
    continuation: Option<Continuation>,
    /// An output time at which the run's counts and step are recorded
    /// ([`Mark`]) without a forced stop: R0's window end.
    mark_s: Option<f64>,
}
/// A run's declared integration from the gates: contract order and output
/// interval, the work bound as CPU cap and the phantom-momentum guard;
/// uncapped, at stock's Newton coefficient, unobserved and not continued
/// until its case says otherwise.
fn spec<'a>(gates: &Gates, duration_s: f64, rtol: f64, atol: &'a [f64], step_cap: i64) -> Spec<'a> {
    Spec {
        rtol,
        atol,
        max_order: gates.max_order,
        duration_s,
        output_s: gates.output_interval_s,
        step_cap,
        cpu_cap_s: gates.total_cpu_s,
        blocked_path_limit_m3_s: gates.blocked_path_max_volume_flow_m3_s,
        max_step_s: f64::INFINITY,
        newton_coefficient: None,
        observation: None,
        continuation: None,
        mark_s: None,
    }
}
/// The same spec, observed on `probe` every `interval_s` over its window.
fn observed(mut spec: Spec<'_>, probe: Network<If97>, interval_s: f64) -> Spec<'_> {
    spec.observation = Some(Observation { probe, interval_s });
    spec
}

#[derive(Default)]
struct Run {
    samples: Vec<Sample>,
    /// Credited outputs at every observation of the window, t = 0 included.
    fine: Vec<Credited>,
    y: Vec<f64>,
    yp: Vec<f64>,
    /// The window's counts plus the continuation's.
    total: Counts,
    /// Counts when the window's end was reached.
    window: Option<Counts>,
    /// Counts of the continuation from its restart: stock restarts its
    /// integrator counters at IDAReInit and its Jacobian count at the
    /// continuation's first setup.
    continuation: Option<Counts>,
    /// Stock's last accepted step and its BDF order at the run's end, the
    /// continuation's end for a continued run.
    last_step_s: f64,
    last_order: i32,
    cpu_s: f64,
    solver_cpu_s: f64,
    observation_cpu_s: f64,
    evaluation_wall_s: f64,
    jacobian_wall_s: f64,
    /// The run's exact consistent-rate solve at its start (no IDACalcIC).
    initial_pair: Option<ConsistentPair>,
    /// H1's restart at the window's forced stop, when the run continued.
    restart_pair: Option<ConsistentPair>,
    /// The counts and step at the spec's mark, when it was reached.
    mark: Option<Mark>,
    failure: Option<String>,
    /// The failure is the run's step cap, reached with no frozen rule
    /// tripped at that output.
    cap_reached: bool,
    rtol: f64,
    max_order: usize,
    max_step_s: f64,
    newton_coefficient: Option<f64>,
    duration_s: f64,
    end_s: f64,
}

/// The frozen failure rules on one accepted sample (S1 declaration).
fn frozen_rule(s: &Sample, taps: &Taps, admitted_atol: f64, blocked_limit: f64) -> Option<String> {
    let t = s.t;
    if !identity_closes(s) {
        Some(format!(
            "energy identity open at t={t}: {} W against terms {} W",
            s.energy_identity_w, s.energy_identity_terms_w
        ))
    } else if s.band_exceeded {
        Some(format!(
            "metastable departure beyond the admitted band at t={t}: {:?}",
            s.departure_k
        ))
    } else if s.uncredited {
        Some(format!(
            "credited departure above creditedMax_K at nominal theta at t={t}: {:?}",
            s.departure_k
        ))
    } else if s.admitted_mass_kg < taps.resolvability_factor * admitted_atol {
        Some(format!(
            "A-layer resolvability report at t={t}: M_A={} kg < {} x atol {admitted_atol} kg",
            s.admitted_mass_kg, taps.resolvability_factor
        ))
    } else if s.blocked_path_m3_s > blocked_limit {
        Some(format!(
            "phantom momentum: blocked phase path (face, phase) {:?} carries {} m3/s at t={t}",
            s.blocked_path_at, s.blocked_path_m3_s
        ))
    } else {
        None
    }
}

/// The integrator's error weights at a state, `1 / (rtol |y| + atol)`, the
/// scale of the consistent start's projection guard.
fn error_weights(y: &[f64], rtol: f64, atol: &[f64]) -> Vec<f64> {
    y.iter()
        .zip(atol)
        .map(|(v, a)| 1. / (rtol * v.abs() + a))
        .collect()
}

/// The stock-IDA settings a continuation restarts with: the window's
/// tolerances, differential identity, order cap and nonnegative stocks.
struct Segment<'a> {
    rtol: f64,
    atol: &'a [f64],
    differential: &'a [f64],
    max_order: usize,
    nonnegative: &'a [usize],
}

/// H1's restart at a window's forced stop `time`, from its accepted state
/// (`y`, `yp`): the exact consistent start there (the algebraic projection
/// under its guard, the correction's WRMS at most 1 with the integrator's
/// error weights at the state, then the exact rate solve to the declared
/// row bound), then stock IDAReInit at that pair with stock's Newton
/// coefficient set before its first step, no step cap, the segment's order
/// cap and nonnegative stocks, and a stop at `end_s`. IDAReInit keeps the
/// tolerances and differential identity and restarts stock's counters.
/// `consistent` reaches the residual the start is solved on inside the
/// integrated system. On success `y` and `yp` hold the restart pair; on a
/// refusal they are unchanged and so is the history unless IDAReInit ran.
fn restart<S: System, C: ConsistentSystem>(
    ida: &mut Ida<S>,
    consistent: impl Fn(&mut S) -> &mut C,
    time: f64,
    y: &mut [f64],
    yp: &mut [f64],
    segment: &Segment<'_>,
    end_s: f64,
) -> Result<ConsistentPair, String> {
    let weights = error_weights(y, segment.rtol, segment.atol);
    let mut projected = y.to_vec();
    let (rates, pair) = consistent_start(
        consistent(ida.system_mut()),
        time,
        &mut projected,
        segment.differential,
        &weights,
        CONSISTENT_ROW_BOUND,
        2,
    )
    .map_err(|e| format!("{DECLARED_RESTART} at t={time}: {e:?}"))?;
    ida.reinitialize(time, &projected, &rates)?;
    ida.set_nonlinear_convergence_coefficient(STOCK_NEWTON_COEFFICIENT)?;
    ida.set_max_step(f64::INFINITY)?;
    ida.set_max_order(segment.max_order)?;
    ida.constrain_nonnegative(segment.nonnegative)?;
    ida.stop_at(end_s)?;
    y.copy_from_slice(&projected);
    yp.copy_from_slice(&rates);
    Ok(pair)
}

/// Advance one declared run from a prepared, settled or event-changed state.
/// Its start projects the algebraic coordinates onto the constraints within
/// the run's own error weights (a bitwise no-op on an exact state) and then
/// solves the exact consistent rates, at t = 0 and every event alike;
/// IDACalcIC is never called. The window ends at a forced stop; a declared
/// continuation then restarts there by the same exact consistent start
/// ([`restart`], H1), with stock IDA reinitialized at no step cap and stock's
/// Newton coefficient, and runs to its own end.
fn advance_run(
    mut network: Network<If97>,
    taps: &Taps,
    y0: &[f64],
    ids: &[f64],
    spec: Spec<'_>,
    stop: &dyn Fn(&[Sample]) -> bool,
) -> Run {
    let Spec {
        rtol,
        atol,
        max_order,
        duration_s,
        output_s,
        step_cap,
        cpu_cap_s,
        blocked_path_limit_m3_s,
        max_step_s,
        newton_coefficient,
        observation,
        continuation,
        mark_s,
    } = spec;
    let started = cpu_s();
    let mut y = y0.to_vec();
    let weights = error_weights(y0, rtol, atol);
    let end_s = duration_s + continuation.as_ref().map_or(0., |c| c.duration_s);
    // The mark's index on the output grid k * output_s.
    let mark_output = mark_s.map(|m| {
        assert!(
            whole(m, output_s) && m < end_s,
            "a mark at {m} s must be an output before the run's end"
        );
        (m / output_s).round() as usize
    });
    let mut mark = None;
    let (mut yp, initial_pair, mut failure) = match consistent_start(
        &mut network,
        0.,
        &mut y,
        ids,
        &weights,
        CONSISTENT_ROW_BOUND,
        2,
    ) {
        Ok((yp, pair)) => (yp, Some(pair), None),
        Err(e) => (
            vec![0.; y0.len()],
            None,
            Some(format!("consistent-rate solve: {e:?}")),
        ),
    };
    let (mut probe, mut clock) = match observation {
        Some(o) => (
            Some(o.probe),
            Some(Clock::new(o.interval_s, output_s, duration_s, end_s + 1.)),
        ),
        None => (None, None),
    };
    let system = Observed::new(
        Integrated::colored(network).expect("colored assembly"),
        clock.as_ref().map(|c| c.next.clone()),
    );
    let mut ida = Ida::new(
        system,
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: ids,
            absolute_tolerance: atol,
            relative_tolerance: rtol,
        },
    )
    .expect("stock IDA construction");
    ida.set_max_order(max_order).expect("max order");
    if max_step_s.is_finite() {
        ida.set_max_step(max_step_s).expect("max step");
    }
    if let Some(coefficient) = newton_coefficient {
        ida.set_nonlinear_convergence_coefficient(coefficient)
            .expect("Newton coefficient");
    }
    let stocks = ida.system().inner.network.nonnegative_stocks();
    ida.constrain_nonnegative(&stocks)
        .expect("nonnegative stocks");
    ida.stop_at(duration_s).expect("stop time");
    let admitted_atol =
        atol[taps.admitted_mass] * ida.system().inner.network.scales()[taps.admitted_mass];
    let mut samples = Vec::new();
    let mut fine = Vec::new();
    let (mut diagnostic_cpu, mut observation_cpu) = (0., 0.);
    if failure.is_none() {
        let d = cpu_s();
        let s = sample(&mut ida.system_mut().inner.network, taps, 0., &y, &yp);
        diagnostic_cpu += cpu_s() - d;
        if let Some(c) = clock.as_mut() {
            fine.push(s.credited());
            c.arm();
        }
        samples.push(s);
    }
    let mut window: Option<Counts> = None;
    let mut restart_pair = None;
    let mut cap_reached = false;
    let mut k = 1;
    while failure.is_none() {
        // Past the window the history is the continuation's, restarted at
        // the window's end (a window without one ends the run there).
        let in_window = window.is_none();
        // Output k of the grid from t = 0; each phase's last output is its
        // end, reached exactly.
        let horizon = if in_window { duration_s } else { end_s };
        let target = if k as f64 >= (horizon / output_s).round() {
            horizon
        } else {
            k as f64 * output_s
        };
        match ida.advance(target, &mut y, &mut yp) {
            Ok(Advance::Reached(t)) => {
                let stats = ida.stats().expect("stats");
                let d = cpu_s();
                let mut s = sample(&mut ida.system_mut().inner.network, taps, t, &y, &yp);
                diagnostic_cpu += cpu_s() - d;
                // The run's steps: the window's, then the continuation's
                // counted from its restart.
                let run_steps = window.map_or(0, |w| w.steps) + stats.steps;
                s.steps = run_steps;
                s.last_step = stats.last_step;
                if in_window && clock.is_some() {
                    fine.push(s.credited());
                }
                if mark_output == Some(k) {
                    let here = Counts::of(&stats);
                    mark = Some(Mark {
                        t,
                        counts: window.map_or(here, |w| w.plus(here)),
                        last_step_s: stats.last_step,
                        last_order: stats.last_order,
                        current_step_s: stats.current_step,
                    });
                }
                let (cap, phase) = if in_window {
                    (step_cap, "run")
                } else {
                    (
                        continuation.as_ref().map_or(i64::MAX, |c| c.step_cap),
                        "recovery",
                    )
                };
                let rule = frozen_rule(&s, taps, admitted_atol, blocked_path_limit_m3_s);
                // The step cap stops the run where no frozen rule tripped
                // first; R0 reports this stop and fails on every other.
                cap_reached = rule.is_none() && run_steps > cap;
                failure = rule
                    .or_else(|| {
                        cap_reached.then(|| {
                            format!("{phase} cap reached: {run_steps} steps from the run's start")
                        })
                    })
                    .or_else(|| {
                        (cpu_s() - started > cpu_cap_s)
                            .then(|| format!("run CPU cap {cpu_cap_s} s reached"))
                    });
                samples.push(s);
                if failure.is_some() {
                    break;
                }
                if in_window && t >= duration_s {
                    window = Some(Counts::of(&stats));
                    if continuation.is_none() {
                        break;
                    }
                    // H1: the cap and the tightened coefficient end with the
                    // window; the run restarts from its accepted state there.
                    let segment = Segment {
                        rtol,
                        atol,
                        differential: ids,
                        max_order,
                        nonnegative: &stocks,
                    };
                    match restart(
                        &mut ida,
                        |s| &mut s.inner.network,
                        t,
                        &mut y,
                        &mut yp,
                        &segment,
                        end_s,
                    ) {
                        Ok(pair) => restart_pair = Some(pair),
                        Err(e) => failure = Some(format!("window-end restart: {e}")),
                    }
                } else if (!in_window && t >= end_s) || stop(&samples) {
                    break;
                }
                k += 1;
            }
            Ok(Advance::Root { time, .. }) => match (probe.as_mut(), clock.as_mut()) {
                (Some(p), Some(c)) => {
                    let d = cpu_s();
                    match observe(p, taps, time, &y, &yp) {
                        Ok(o) => fine.push(o),
                        Err(e) => failure = Some(e),
                    }
                    observation_cpu += cpu_s() - d;
                    c.arm();
                }
                _ => {
                    failure = Some(format!(
                        "unexpected root at {time} s (no observation declared)"
                    ))
                }
            },
            Err(e) => failure = Some(e),
        }
    }
    let stats = ida.stats().expect("stats");
    let cpu = cpu_s() - started;
    let network = &ida.system().inner.network;
    // Stock restarted its counters at the restart, so the continuation's are
    // read whole and added to the window's. Without a restart (none
    // declared, or refused before a continuation step) the window's counts
    // are the run's.
    let last = Counts::of(&stats);
    let (continued, total) = match (window, restart_pair.is_some()) {
        (Some(w), true) => (Some(last), w.plus(last)),
        (Some(w), false) => (None, w),
        (None, _) => (None, last),
    };
    Run {
        samples,
        fine,
        y,
        yp,
        total,
        window,
        continuation: continued,
        last_step_s: stats.last_step,
        last_order: stats.last_order,
        cpu_s: cpu,
        solver_cpu_s: cpu - diagnostic_cpu - observation_cpu,
        observation_cpu_s: observation_cpu,
        evaluation_wall_s: network.counters.evaluation_wall_s,
        jacobian_wall_s: network.counters.jacobian_wall_s,
        initial_pair,
        restart_pair,
        mark,
        failure,
        cap_reached,
        rtol,
        max_order,
        max_step_s,
        newton_coefficient,
        duration_s,
        end_s,
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
fn run_json(run: &Run) -> Value {
    let reached = run.samples.last().map_or(0., |s| s.t);
    let extreme = |f: fn(&Sample) -> f64| {
        run.samples.iter().map(f).fold(f64::NAN, |a: f64, b| {
            if a.is_nan() || b.abs() > a.abs() {
                b
            } else {
                a
            }
        })
    };
    let pzr = json!({"max_departure_k":[extreme(|s|s.departure_k[0]),extreme(|s|s.departure_k[1]),extreme(|s|s.departure_k[2])],"min_gap_margin":run.samples.iter().map(|s|s.gap_margin).fold(f64::INFINITY,f64::min),"min_admitted_mass_kg":run.samples.iter().map(|s|s.admitted_mass_kg).fold(f64::INFINITY,f64::min),"max_transit_drift_w":[extreme(|s|s.transit_drift_w[0]),extreme(|s|s.transit_drift_w[1])],"max_interface_pressure_rate_pa_s":extreme(|s|s.interface_pressure_rate_pa_s)});
    let identity = run
        .samples
        .iter()
        .map(|s| s.energy_identity_w.abs() / (1. + s.energy_identity_terms_w))
        .fold(0., f64::max);
    let continued = run.end_s > run.duration_s;
    let continuation = continued.then(|| json!({"from_s":run.duration_s,"restart":DECLARED_RESTART,"max_step_s":null,"newton_coefficient":STOCK_NEWTON_COEFFICIENT}));
    json!({"configuration":{"rtol":run.rtol,"max_step_s":run.max_step_s.is_finite().then_some(run.max_step_s),"newton_coefficient":run.newton_coefficient.unwrap_or(STOCK_NEWTON_COEFFICIENT),"max_order":run.max_order,"window_s":run.duration_s,"end_s":run.end_s,"continuation":continuation},
        "initial_pair":run.initial_pair,"restart_pair":run.restart_pair,"pzr":pzr,
        "steps":run.total.steps,"residuals":run.total.residuals,"jacobians":run.total.jacobians,"error_failures":run.total.error_failures,"convergence_failures":run.total.convergence_failures,
        "counts":run.total.json(),"window_counts":run.window.map(Counts::json),"continuation_counts":run.continuation.map(Counts::json),
        "last_step_s":run.last_step_s,"last_order":run.last_order,
        "observations":run.fine.len(),"cpu_s":run.cpu_s,"solver_cpu_s":run.solver_cpu_s,"observation_cpu_s":run.observation_cpu_s,"evaluation_wall_s":run.evaluation_wall_s,"jacobian_wall_s":run.jacobian_wall_s,
        "steps_per_simulated_s":run.total.steps as f64/reached,"solver_cpu_s_per_simulated_s":run.solver_cpu_s/reached,
        "max_identity_relative":identity,"reached_s":reached,"failure":run.failure})
}

// ---- The contract's comparison (E0, E1) and the E3 checks. ----
/// A run's credited series over [0, window]: every observation present, on
/// the grid j*dt.
fn window_series(run: &Run, window_s: f64, dt: f64) -> Result<&[Credited], String> {
    let n = (window_s / dt).round() as usize;
    let Some(series) = run.fine.get(..=n) else {
        return Err(format!(
            "{} of {} observations over {window_s} s",
            run.fine.len(),
            n + 1
        ));
    };
    let off = series
        .iter()
        .enumerate()
        .map(|(j, c)| (c.t - j as f64 * dt).abs())
        .fold(0., larger);
    if off <= 1e-9 {
        Ok(series)
    } else {
        Err(format!(
            "observation times leave the {dt} s grid by {off} s"
        ))
    }
}
/// E0/E1, the contract's comparison of the credited outputs of `a` - `b`
/// over [0, window]: each difference, observed every `dt`, is low-passed by
/// the zero-phase Butterworth at the credited band. Roof bias is the mean
/// |filtered difference| over every observation; roof noise the standard
/// deviation of the filtered roof error's change between successive
/// output-interval samples; level, core DP and loop flow (both loops) the
/// largest |filtered difference| over every observation.
fn compare(a: &Run, b: &Run, window_s: f64, dt: f64, output_s: f64, cutoff_hz: f64) -> Value {
    let (sa, sb) = match (
        window_series(a, window_s, dt),
        window_series(b, window_s, dt),
    ) {
        (Ok(sa), Ok(sb)) => (sa, sb),
        (ea, eb) => {
            return json!({"window_s":window_s,"evaluable":false,"run":ea.err(),"reference":eb.err()});
        }
    };
    let per_output = (output_s / dt).round() as usize;
    let difference = |pick: &dyn Fn(&Credited) -> f64| -> (Vec<f64>, Vec<f64>) {
        let raw: Vec<f64> = sa.iter().zip(sb).map(|(p, q)| pick(p) - pick(q)).collect();
        (zero_phase_lowpass(&raw, cutoff_hz, dt), raw)
    };
    let (roof, roof_raw) = difference(&|c| c.roof_pa);
    let (level, level_raw) = difference(&|c| c.level_m);
    let (dp, dp_raw) = difference(&|c| c.core_dp_pa);
    let (la, la_raw) = difference(&|c| c.loop_kg_s[0]);
    let (lb, lb_raw) = difference(&|c| c.loop_kg_s[1]);
    let at_outputs = |v: &[f64]| -> Vec<f64> { v.iter().step_by(per_output).copied().collect() };
    let roof_outputs = at_outputs(&roof);
    let changes: Vec<f64> = roof_outputs.windows(2).map(|w| w[1] - w[0]).collect();
    let abs = |v: &[f64]| -> Vec<f64> { v.iter().map(|x| x.abs()).collect() };
    json!({"window_s":window_s,"evaluable":true,"observations":sa.len(),"observation_s":dt,"output_s":output_s,"cutoff_hz":cutoff_hz,"filter":DECLARED_FILTER,"padding_s":padding_s(cutoff_hz),
        "pzr_roof_bias_pa":mean(&abs(&roof)),
        "pzr_roof_sample_noise_pa":deviation(&changes),
        "pzr_level_m":max_abs(&level),
        "core_dp_pa":max_abs(&dp),
        "loop_flow_kg_s":larger(max_abs(&la),max_abs(&lb)),
        "detail":{"pzr_roof_signed_mean_pa":mean(&roof),"pzr_roof_max_abs_pa":max_abs(&roof),"pzr_roof_max_abs_output_change_pa":max_abs(&changes),"output_changes":changes.len(),
            "loop_flow_kg_s_by_loop":[max_abs(&la),max_abs(&lb)],
            "at_outputs":{"pzr_roof_bias_pa":mean(&abs(&roof_outputs)),"pzr_level_m":max_abs(&at_outputs(&level)),"core_dp_pa":max_abs(&at_outputs(&dp)),"loop_flow_kg_s":larger(max_abs(&at_outputs(&la)),max_abs(&at_outputs(&lb)))},
            "unfiltered_max_abs":{"pzr_roof_pa":max_abs(&roof_raw),"pzr_level_m":max_abs(&level_raw),"core_dp_pa":max_abs(&dp_raw),"loop_flow_kg_s":larger(max_abs(&la_raw),max_abs(&lb_raw))}}})
}
/// The comparison is evaluable and every credited metric is within budget.
fn within(diff: &Value, budgets: &Budgets) -> bool {
    let m = |k: &str| diff[k].as_f64().unwrap_or(f64::NAN);
    diff["evaluable"].as_bool() == Some(true)
        && m("pzr_roof_bias_pa") <= budgets.pzr_roof_pressure_bias_pa
        && m("pzr_roof_sample_noise_pa") <= budgets.pzr_roof_pressure_sample_noise_pa
        && m("pzr_level_m") <= budgets.pzr_level_m
        && m("core_dp_pa") <= budgets.core_differential_pressure_pa
        && m("loop_flow_kg_s") <= budgets.loop_flow_kg_s
}
/// The compared metrics, in receipt order.
const METRICS: [&str; 5] = [
    "pzr_roof_bias_pa",
    "pzr_roof_sample_noise_pa",
    "pzr_level_m",
    "core_dp_pa",
    "loop_flow_kg_s",
];
/// E3's convergence ratio per credited metric: |run - R1| / |R1 - R2|, the
/// successive differences of the refinement sequence run, R1, R2.
fn convergence_ratio(run_r1: &Value, r1_r2: &Value) -> Value {
    let mut out = serde_json::Map::new();
    out.insert(
        "definition".into(),
        json!("metric(run - R1) / metric(R1 - R2) for each filtered credited metric"),
    );
    for k in METRICS {
        let (x, y) = (run_r1[k].as_f64(), r1_r2[k].as_f64());
        out.insert(
            k.into(),
            json!({"run_minus_r1":x,"r1_minus_r2":y,"ratio":x.zip(y).map(|(x, y)| x / y)}),
        );
    }
    Value::Object(out)
}
/// The cap-cycle check's outputs, in receipt order.
const CAP_CYCLE_OUTPUTS: [&str; 4] = ["core_dp_pa", "loop_a_kg_s", "loop_b_kg_s", "pzr_roof_pa"];
/// H2's floors of the cap-cycle check, in [`CAP_CYCLE_OUTPUTS`] order:
/// `fraction` of each output's credited budget, the core-DP and loop-flow
/// budgets and, for the roof, its sample-noise budget.
fn cap_cycle_floors(budgets: &Budgets, fraction: f64) -> [f64; 4] {
    [
        budgets.core_differential_pressure_pa,
        budgets.loop_flow_kg_s,
        budgets.loop_flow_kg_s,
        budgets.pzr_roof_pressure_sample_noise_pa,
    ]
    .map(|budget| fraction * budget)
}
/// A credited series' own content above the credited band, x - lowpass(x),
/// taken relative to its first value: the filter is linear with unit DC
/// gain, so the content is unchanged and rounding stays small.
fn above_band(
    series: &[Credited],
    pick: fn(&Credited) -> f64,
    cutoff_hz: f64,
    dt: f64,
) -> Vec<f64> {
    let raw: Vec<f64> = series.iter().map(pick).collect();
    content_above_band(&raw, cutoff_hz, dt)
}
/// E3's cap-cycle check as amended by H2: the RMS over the window of each
/// credited output's content above the credited band ([`above_band`]), in
/// core DP, both loop flows and roof pressure. An output passes if its RMS
/// is at or below its `floors` entry, or at most `ratio_max` times R1's; the
/// ratio is judged only above the floor. Each output also carries the
/// excess spectrum ([`excess_spectrum`]), a diagnostic that judges nothing.
fn cap_cycle(
    run: &Run,
    r1: &Run,
    window_s: f64,
    dt: f64,
    cutoff_hz: f64,
    ratio_max: f64,
    floors: [f64; 4],
) -> (Value, bool) {
    let picks: [fn(&Credited) -> f64; 4] = [
        |c| c.core_dp_pa,
        |c| c.loop_kg_s[0],
        |c| c.loop_kg_s[1],
        |c| c.roof_pa,
    ];
    let content = |r: &Run| -> Result<Vec<Vec<f64>>, String> {
        let s = window_series(r, window_s, dt)?;
        Ok(picks
            .iter()
            .map(|pick| above_band(s, *pick, cutoff_hz, dt))
            .collect())
    };
    match (content(run), content(r1)) {
        (Ok(a), Ok(b)) => {
            let mut outputs = serde_json::Map::new();
            let mut pass = true;
            for (i, name) in CAP_CYCLE_OUTPUTS.iter().enumerate() {
                let (output, output_pass) =
                    cap_cycle_output(&a[i], &b[i], floors[i], ratio_max, dt, cutoff_hz);
                pass &= output_pass;
                outputs.insert(name.to_string(), output);
            }
            (
                json!({"cutoff_hz":cutoff_hz,"window_s":window_s,"ratio_max":ratio_max,
                    "rule":CAP_CYCLE_RULE,
                    "excess_spectrum":EXCESS_SPECTRUM_METHOD,
                    "outputs":outputs,"pass":pass}),
                pass,
            )
        }
        (a, b) => (
            json!({"evaluable":false,"run":a.err(),"r1":b.err(),"pass":false}),
            false,
        ),
    }
}

/// H1's recovery gate on an event run continued past its window, judged on
/// cost: the run reached the window plus the continuation without failure,
/// the continuation had at most the declared Newton convergence failures,
/// and the window's and the continuation's steps together, at the projected
/// full-unit step, stay within E2's budget over both spans. The receipt
/// gives the continuation's step rate over the interval it actually reached,
/// its last step and order, and the restart's projection and residual.
fn recovery(gates: &Gates, run: &Run, window_s: f64, post_window_s: f64) -> (Value, bool) {
    let span = window_s + post_window_s;
    let reached = run.samples.last().map_or(0., |s| s.t);
    let completed = run.failure.is_none() && reached >= span;
    let continuation = run.continuation;
    let window_steps = run.window.map(|w| w.steps);
    let steps = window_steps.zip(continuation).map(|(w, c)| w + c.steps);
    let projected = steps.map(|n| n as f64 * gates.projected_full_unit_step_s / span);
    let budget = gates.event_window.budget_cpu_s_per_s;
    let failures = continuation.map(|c| c.convergence_failures);
    let max_failures = i64::from(gates.recovery.max_convergence_failures);
    let interval = continuation.map(|_| reached - window_s);
    let rate = continuation
        .zip(interval)
        .filter(|(_, i)| *i > 0.)
        .map(|(c, i)| c.steps as f64 / i);
    let pass = completed
        && failures.is_some_and(|f| f <= max_failures)
        && projected.is_some_and(|p| p <= budget);
    let restart = run.restart_pair.as_ref().map(|p| {
        json!({"at_s":window_s,"projection_wrms":p.projection.as_ref().map(|q| q.correction_wrms),"projection_passes":p.projection.as_ref().map(|q| q.passes),"largest_scaled_residual":p.residual.value,"bound":p.bound})
    });
    (
        json!({"post_window_s":post_window_s,"span_s":span,"restart":DECLARED_RESTART,"restart_pair":restart,
            "reached_s":reached,"completed":completed,"interval_reached_s":interval,
            "counts":continuation.map(Counts::json),"steps_per_s":rate,
            "last_step_s":continuation.map(|_| run.last_step_s),"last_order":continuation.map(|_| run.last_order),
            "window_steps":window_steps,"continuation_steps":continuation.map(|c| c.steps),"steps":steps,
            "allowed_steps":gates.budget_steps(span),"run_cap_steps":gates.cap_steps(span),
            "projected_full_unit_step_s":gates.projected_full_unit_step_s,"projected_cpu_s_per_s":projected,"budget_cpu_s_per_s":budget,
            "convergence_failures":failures,"max_convergence_failures":max_failures,"convergence_failures_counter":CONVERGENCE_FAILURES_COUNTER,"pass":pass}),
        pass,
    )
}

/// R0 is an S1 run: its frozen failure rules (the energy identity, the
/// metastable band, the credited departure, A-layer resolvability and the
/// phantom-momentum guard) and every other failure, such as a
/// property-domain exit surfacing through stock IDA, fail the event. Only
/// stopping at its own step cap is reported and not failed.
fn r0_fails(r0: &Run) -> bool {
    r0.failure.is_some() && !r0.cap_reached
}

/// The diagnostic beside H1's cost gate, whose comparisons judge nothing:
/// H1 bounds the window's and continuation's cost together, so a
/// continuation that never left the cap's rate could still pass it. R0, the
/// never-capped run from the same event start in one history, shows what
/// the plant asks for over the same interval: its steps, error-test and
/// Newton convergence failures over the window and over [window, window +
/// post], its step at the window's end, and the event run's continuation
/// steps over R0's where both covered that interval. R0's window counts are
/// read at its window-end output ([`Mark`]). Whether R0's own failure fails
/// the event ([`r0_fails`]) is stated with it; reaching its run cap does
/// not.
fn natural_reference(
    run: &Run,
    r0: &Run,
    window_s: f64,
    post_window_s: f64,
    run_cap_steps: i64,
) -> Value {
    let span = window_s + post_window_s;
    let reached = |r: &Run| r.samples.last().map_or(0., |s| s.t);
    let covered = |r: &Run| reached(r) >= span;
    let window = r0.mark.map(|m| m.counts);
    let interval = window.map(|w| r0.total.since(w));
    let counts = |c: Counts| json!({"steps":c.steps,"error_failures":c.error_failures,"convergence_failures":c.convergence_failures});
    let ratio = run
        .continuation
        .zip(interval)
        .filter(|_| covered(run) && covered(r0))
        .map(|(c, i)| c.steps as f64 / i.steps as f64);
    let rate = interval
        .filter(|_| covered(r0))
        .map(|i| i.steps as f64 / post_window_s);
    json!({"diagnostic":"the never-capped run R0 from the same event start, one IDA history to window + post_window_s with no forced stop or restart at the window's end; its window counts are read at the window-end output, which stock reaches by interpolation, so the step straddling the window's end counts in R0's window. Its counts, step and ratio judge nothing and reaching its run cap is reported only; as an S1 run, R0's frozen failure rules and any other failure fail the event (fails_event)",
        "configuration":{"rtol":r0.rtol,"atol_factor":1.,"max_step_s":r0.max_step_s.is_finite().then_some(r0.max_step_s),"newton_coefficient":r0.newton_coefficient.unwrap_or(STOCK_NEWTON_COEFFICIENT),"max_order":r0.max_order,"run_cap_steps":run_cap_steps},
        "window":window.map(counts),"interval":interval.map(counts),"interval_s":[window_s, span],"interval_steps_per_s":rate,
        "marked_at_s":r0.mark.map(|m| m.t),"step_at_window_end_s":r0.mark.map(|m| m.last_step_s),"order_at_window_end":r0.mark.map(|m| m.last_order),"next_step_at_window_end_s":r0.mark.map(|m| m.current_step_s),
        "continuation_over_r0_steps":ratio,"continuation_steps":run.continuation.map(|c| c.steps),
        "reached_s":reached(r0),"covered":covered(r0),"run_cap_reached":r0.cap_reached,"failure":r0.failure,"fails_event":r0_fails(r0),
        "cpu_s":r0.cpu_s,"solver_cpu_s":r0.solver_cpu_s,"run":run_json(r0)})
}

/// One declared event from its event-changed state: the window run (E2:
/// 20 ms cap, tightened Newton coefficient), restarted at the window's end
/// by the exact consistent start and continued at stock settings through
/// the recovery interval (H1); R1, the same window capped at 2.5 ms; R2,
/// BDF2 at the second refinement's tolerances with no cap and stock's
/// coefficient (E3). Over the window, credited outputs must agree with both
/// within the contract, and the cap-cycle check holds above its floor (H2).
/// R0, the never-capped run over the window and the recovery interval, is
/// reported beside the recovery gate ([`natural_reference`]); its
/// comparisons judge nothing, but as an S1 run its failures other than its
/// run cap fail the event ([`r0_fails`]). The returned runs are the window
/// run, R1, R2 and R0.
fn event_case(
    event: &dyn Fn() -> (Network<If97>, Vec<f64>, Vec<f64>),
    taps: &Taps,
    atol: &[f64],
    gates: &Gates,
    budgets: &Budgets,
    window_s: f64,
    post_window_s: f64,
) -> (Value, bool, [Run; 4]) {
    let (ew, er) = (&gates.event_window, &gates.event_reference);
    let (dt, output, cutoff) = (
        gates.comparison.observation_s,
        gates.output_interval_s,
        budgets.uncredited_above_hz,
    );
    let rtol = gates.relative_tolerance;
    let tight = STOCK_NEWTON_COEFFICIENT * ew.newton_coefficient_factor;
    let allowed = gates.budget_steps(window_s);
    let window_cap = gates.cap_steps(window_s);
    let never = |_: &[Sample]| false;
    // The window run (E2), restarted at its end and continued (H1).
    let (network, y, ids) = event();
    let mut s = spec(gates, window_s, rtol, atol, window_cap);
    s.max_step_s = ew.max_step_s;
    s.newton_coefficient = Some(tight);
    s.continuation = Some(Continuation {
        duration_s: post_window_s,
        step_cap: gates.cap_steps(window_s + post_window_s),
    });
    let run = advance_run(network, taps, &y, &ids, observed(s, event().0, dt), &never);
    // R1: the same run with the 2.5 ms cap over the window.
    let (network, y, ids) = event();
    let mut s = spec(gates, window_s, rtol, atol, i64::MAX);
    s.max_step_s = er.max_step_s;
    s.newton_coefficient = Some(tight);
    let r1 = advance_run(network, taps, &y, &ids, observed(s, event().0, dt), &never);
    // R2: BDF2 at rtol and atol times the second refinement factor.
    let f = er.second_refinement_tolerance_factor;
    let second: Vec<f64> = atol.iter().map(|v| v * f).collect();
    let (network, y, ids) = event();
    let s = spec(gates, window_s, rtol * f, &second, i64::MAX);
    let r2 = advance_run(network, taps, &y, &ids, observed(s, event().0, dt), &never);
    // R0, the natural reference: never capped, contract tolerances, stock's
    // coefficient and order cap, one history over the window and the
    // recovery interval, its window counts marked at the window's end, and
    // capped at the recovery's run cap, which it reports only.
    let span = window_s + post_window_s;
    let r0_cap = gates.cap_steps(span);
    let (network, y, ids) = event();
    let mut s = spec(gates, span, rtol, atol, r0_cap);
    s.mark_s = Some(window_s);
    let r0 = advance_run(network, taps, &y, &ids, s, &never);
    let vs_r1 = compare(&run, &r1, window_s, dt, output, cutoff);
    let vs_r2 = compare(&run, &r2, window_s, dt, output, cutoff);
    let r1_vs_r2 = compare(&r1, &r2, window_s, dt, output, cutoff);
    let (within_r1, within_r2) = (within(&vs_r1, budgets), within(&vs_r2, budgets));
    let (mut cap_cycle, cap_cycle_pass) = cap_cycle(
        &run,
        &r1,
        window_s,
        dt,
        cutoff,
        er.cap_cycle_uncredited_rms_ratio_max,
        cap_cycle_floors(budgets, er.cap_cycle_floor_budget_fraction),
    );
    cap_cycle["floor_budget_fraction"] = json!(er.cap_cycle_floor_budget_fraction);
    // E2: the window's steps at the projected full-unit step.
    let window_steps = run.window.map(|c| c.steps);
    let projected = window_steps.map(|n| n as f64 * gates.projected_full_unit_step_s / window_s);
    let budget_pass = projected.is_some_and(|p| p <= ew.budget_cpu_s_per_s);
    // H1: the window and its continuation on cost, with R0 beside it.
    let (mut recovery, recovery_pass) = recovery(gates, &run, window_s, post_window_s);
    recovery["natural_reference"] = natural_reference(&run, &r0, window_s, post_window_s, r0_cap);
    let pass = run.failure.is_none()
        && r1.failure.is_none()
        && r2.failure.is_none()
        && !r0_fails(&r0)
        && budget_pass
        && within_r1
        && within_r2
        && cap_cycle_pass
        && recovery_pass;
    let receipt = json!({"window_s":window_s,"post_window_s":post_window_s,
        "configuration":{"window":{"max_step_s":ew.max_step_s,"newton_coefficient":tight,"stock_newton_coefficient":STOCK_NEWTON_COEFFICIENT,"newton_coefficient_factor":ew.newton_coefficient_factor},
            "recovery":{"restart":DECLARED_RESTART,"max_step_s":null,"newton_coefficient":STOCK_NEWTON_COEFFICIENT,"max_order":gates.max_order,"continuation":format!("restarted at the window's forced stop from its accepted state: the exact consistent start there (the algebraic projection, its correction's WRMS at most 1 with the integrator's error weights at the state, then the exact rate solve to {CONSISTENT_ROW_BOUND:e}), then stock IDAReInit at that pair with no step cap and stock's Newton coefficient set before its first step, and the window's tolerances, differential identity, order cap and nonnegative stocks. Stock restarts its counters there: the continuation is counted from the restart and the run's counts add the window's")},
            "r1":{"rtol":rtol,"atol_factor":1.,"max_step_s":er.max_step_s,"newton_coefficient":tight,"max_order":gates.max_order},
            "r2":{"rtol":rtol*f,"atol_factor":f,"max_step_s":null,"newton_coefficient":STOCK_NEWTON_COEFFICIENT,"max_order":gates.max_order}},
        "run":run_json(&run),"r1_capped":run_json(&r1),"r2_refined":run_json(&r2),
        "window_budget":{"steps":window_steps,"allowed_steps":allowed,"run_cap_steps":window_cap,"projected_full_unit_step_s":gates.projected_full_unit_step_s,"projected_cpu_s_per_s":projected,"budget_cpu_s_per_s":ew.budget_cpu_s_per_s,"pass":budget_pass},
        "versus_r1":vs_r1,"versus_r2":vs_r2,"r1_versus_r2":r1_vs_r2,"within_r1":within_r1,"within_r2":within_r2,
        "convergence_ratio":convergence_ratio(&vs_r1,&r1_vs_r2),
        "cap_cycle":cap_cycle,
        "recovery":recovery,
        "pass":pass});
    (receipt, pass, [run, r1, r2, r0])
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
/// The declared S1 exit: the energy identity closes within
/// `1e-9 (1 + sum |terms|)` at every accepted sample.
const IDENTITY_RELATIVE_BOUND: f64 = 1e-9;
fn identity_closes(s: &Sample) -> bool {
    s.energy_identity_w.abs() <= IDENTITY_RELATIVE_BOUND * (1. + s.energy_identity_terms_w)
}

/// Largest scaled row of the consistent initial pair at t = 0 (lead ruling).
const CONSISTENT_ROW_BOUND: f64 = 1e-12;

/// The harness's declared preparation controls; the PZR cell of every fresh
/// network is prepared with the same values as the hydrostatic preparation.
const PZR: PzrPreparation = PzrPreparation {
    pressure_tolerance_pa: 1e-6,
    max_passes: 50,
};
fn fresh(packet: &Packet) -> Network<If97> {
    let (mut network, _) = Network::new(packet, If97, &PZR).expect("network");
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
    gates.check(&budgets);
    let packet: Packet =
        serde_json::from_slice(&std::fs::read(&packet_path).unwrap()).expect("packet");
    let declared = &packet.preparation.operating_point;
    assert_eq!(
        declared.rcp_speed_request, "nominal",
        "only the nominal request is selected"
    );
    // No receipt is written without the water build this binary links.
    let water = water_build(
        &MetastableBand::from(&packet.pzr.cell.metastable),
        WATER_BUILD,
        WATER_LIB_DIR,
    )
    .unwrap_or_else(|e| panic!("no S1 receipt without its water build: {e}"));
    // The declared 6.00 m saturated preparation (S1 re-declaration).
    let point = OperatingPoint::from(declared);
    let taps = taps(&packet, &fresh(&packet));
    let total_started = cpu_s();
    let wall_started = Instant::now();
    let load_start = load_average();
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .expect("git provenance")
    };
    let packet_sha256 = sha256_file(&packet_path).expect("packet hash");
    let dt = gates.comparison.observation_s;
    let cutoff = budgets.uncredited_above_hz;
    let mut receipt = json!({"kind":"s1-hydraulics-admission","declaration":"S1 re-declared under owner decision request 2 (E0-E3) and amended under owner decision request 3 (H1 recovery restart and cost gate, replacing E4, with H1a's convergence-failure allowance and the never-capped R0 reported beside it; H2 cap-cycle floor) before run 5","packet":packet_path,"packet_sha256":packet_sha256,"app_commit":git(&["rev-parse","HEAD"]),"app_worktree_dirty":!git(&["status","--porcelain"]).is_empty(),"wiki":wiki,"wiki_commit":git(&["-C",wiki.as_str(),"rev-parse","HEAD"]),"wiki_worktree_dirty":!git(&["-C",wiki.as_str(),"status","--porcelain"]).is_empty(),"gates":format!("{gates:?}"),"budgets":format!("{budgets:?}"),"load_average_start":load_start,
        "provenance":{"water_build":water,"water_build_file":format!("{WATER_LIB_DIR}/water-build.json"),
            "water_build_checks":"the build receipt embedded at compile time is the directory's water-build.json byte for byte, the directory's libld01_operating_water.a has its librarySha256, and its band equals the packet's pzr.cell.metastable"},
        "observation":{"interval_s":dt,"method":"one stock IDA root function g = t - next per observation time inside each output interval, located on IDA's own interpolant; the same history continues, so no step, order, Newton iteration or Jacobian changes; observed states are evaluated on a probe network configured as the run's"},
        "comparison":{"filter":DECLARED_FILTER,"cutoff_hz":cutoff,"design":"two bilinear biquads prewarped at the cutoff (Q = 1/(2 cos(pi/8)) and 1/(2 cos(3 pi/8))), forward then backward (|H|^2, -6 dB at the cutoff), each pass started in steady state over odd reflection padding","padding_s":padding_s(cutoff),
            "metrics":{"pzr_roof_bias_pa":"mean |filtered difference| over every observation of the compared interval","pzr_roof_sample_noise_pa":"population standard deviation of the filtered roof error's change between successive output-interval samples","pzr_level_m, core_dp_pa, loop_flow_kg_s":"max |filtered difference| over every observation (both loops for flow)"}}});

    // 1. Hydrostatic preparation at the declared operating point.
    let rotors = vec![
        RotorState {
            support: Support::Supported(SpeedRequest::Nominal),
            shaft: Shaft::Free,
        };
        4
    ];
    let settings = Settings {
        pressure_tolerance_pa: PZR.pressure_tolerance_pa,
        max_passes: PZR.max_passes,
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
    // Decision 0013's exit: the run starts from the exact consistent pair of
    // the preparation, with no IDACalcIC at t = 0.
    let mut settling = spec(
        &gates,
        gates.settling.max_simulated_s,
        gates.relative_tolerance,
        &atol,
        i64::MAX,
    );
    settling.output_s = 1.;
    settling.cpu_cap_s = gates.settling.max_cpu_s;
    let settle = advance_run(
        network,
        &taps,
        &y0,
        &prepared.differential,
        settling,
        &settled,
    );
    let settled_ok = settle.failure.is_none() && settled(&settle.samples);
    receipt["settling"] = json!({"run":run_json(&settle),"settled":settled_ok,"final":format!("{:?}", settle.samples.last())});
    let finish = |receipt: &mut Value, verdict: &str| {
        receipt["verdict"] = json!(verdict);
        receipt["total_cpu_s"] = json!(cpu_s() - total_started);
        receipt["total_wall_s"] = json!(wall_started.elapsed().as_secs_f64());
        receipt["load_average_end"] = json!(load_average());
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
    // Diagnostic only: the full energy/mass budget at the settled state.
    receipt["settled_budget"] = probe.current_budget(&ys, &yps);
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
    // Diagnostic only (not a gate): locate each growing mode on its dominant
    // coordinates, with its growth rate, so a no-go is attributable.
    let labels = probe.labels();
    let growing = |spectrum: &spectrum::Spectrum| -> Vec<Value> {
        spectrum
            .modes
            .iter()
            .enumerate()
            .filter(|(_, m)| m.unstable)
            .map(|(i, m)| {
                let mut weight: Vec<(f64, usize)> = spectrum.shapes[i]
                    .right
                    .iter()
                    .enumerate()
                    .map(|(j, v)| (v.abs(), j))
                    .collect();
                weight.sort_by(|a, b| b.0.total_cmp(&a.0));
                let dominant: Vec<Value> = weight
                    .iter()
                    .take(6)
                    .map(|(w, j)| json!({"coordinate":labels[*j].1,"weight":w}))
                    .collect();
                json!({"hz":m.frequency_hz,"re":m.lambda.re,"im":m.lambda.im,"e_fold_s":m.e_fold_s,"marginal":m.marginal,"error_bound":m.error_bound,"condition":m.condition,"dominant":dominant})
            })
            .collect()
    };
    let growing_pre = growing(&pre);
    let growing_post = growing(&post);
    let spectral = json!({
        "growing_pre": growing_pre,
        "growing_post": growing_post,
        "pre":{"finite":pre_report.finite,"infinite":pre_report.infinite.count,"algebraic":algebraic,"unstable":pre_report.unstable,"marginal":pre_report.marginal,"fast_excited":fast_excited(&pre_report),"max_ratio":pre_report.events[0].max_ratio,"dggev_s":pre_report.dggev_seconds,
            "modes_above_fast_hz":pre_report.modes.iter().filter(|m|m.frequency_hz>gates.spectrum.fast_mode_hz).map(|m|json!({"hz":m.frequency_hz,"zeta":m.damping_ratio})).collect::<Vec<_>>(),
            "slowest_oscillatory":pre_report.modes.iter().filter(|m|m.frequency_hz>0.).take(8).map(|m|json!({"hz":m.frequency_hz,"zeta":m.damping_ratio,"e_fold_s":m.e_fold_s})).collect::<Vec<_>>()},
        "post_seizure":{"finite":post_report.finite,"infinite":post_report.infinite.count,"algebraic":algebraic+1,"unstable":post_report.unstable,"marginal":post_report.marginal,"fast_excited":fast_excited(&post_report),"max_ratio":post_report.events[0].max_ratio,"removed_rotor_energy_j":locking.event.map(|e|e.removed_kinetic_energy_j)}
    });
    // A positive real part counts only where it is resolved: a mode whose
    // first-order error bound covers Re λ has an unresolved sign (the
    // spectrum's `marginal`), as for an exactly conserved inventory.
    let resolved_growing = |spectrum: &spectrum::Spectrum| {
        spectrum
            .modes
            .iter()
            .filter(|m| m.unstable && !m.marginal)
            .count()
    };
    let (resolved_pre, resolved_post) = (resolved_growing(&pre), resolved_growing(&post));
    let go = resolved_pre == 0
        && resolved_post == 0
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
    receipt["spectrum"]["resolved_growing_pre"] = json!(resolved_pre);
    receipt["spectrum"]["resolved_growing_post"] = json!(resolved_post);
    if !go {
        finish(
            &mut receipt,
            "NO-GO: zero-time spectral criterion failed; escalate",
        );
        panic!("S1 spectral no-go");
    }

    // 4. The hold against rtol/10, then each event window with R1 and R2.
    // Every run starts from its state by the exact consistent start.
    let interval = gates.output_interval_s;
    let rtol = gates.relative_tolerance;
    let factor = gates.reference_tolerance_factor;
    let refined: Vec<f64> = atol.iter().map(|v| v * factor).collect();
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
    let start = |kind: &str| {
        let mut y = ys.clone();
        let (n, i) = event_network(kind, &mut y);
        (n, y, i)
    };
    let held = || start("hold");
    let supplied = || start("supply");
    let seized = || start("seizure");
    let mut cases = serde_json::Map::new();
    let mut ok = true;
    // Hold: unchanged gates, against rtol/10 with the filtered metrics.
    let hold_cap =
        (gates.run_cap_factor * gates.hold.max_steps_per_second * gates.hold.duration_s) as i64;
    let (n, y, i) = held();
    let hold = advance_run(
        n,
        &taps,
        &y,
        &i,
        observed(
            spec(&gates, gates.hold.duration_s, rtol, &atol, hold_cap),
            held().0,
            dt,
        ),
        &never,
    );
    let (n, y, i) = held();
    let hold_ref = advance_run(
        n,
        &taps,
        &y,
        &i,
        observed(
            spec(
                &gates,
                gates.hold.duration_s,
                rtol * factor,
                &refined,
                i64::MAX,
            ),
            held().0,
            dt,
        ),
        &never,
    );
    let measured = gates.hold.duration_s - gates.hold.measured_from_s;
    let hold_rate_measured =
        steps_between(&hold, gates.hold.measured_from_s, gates.hold.duration_s) / measured;
    // The quiet-hold rate, for the joint cost check, exists only for a hold
    // that reached its end.
    let quiet_rate = hold.failure.is_none().then_some(hold_rate_measured);
    let hold_residuals = hold.total.residuals as f64 / hold.total.steps.max(1) as f64;
    let hold_diff = compare(
        &hold,
        &hold_ref,
        gates.hold.duration_s,
        dt,
        interval,
        cutoff,
    );
    let hold_pass = hold.failure.is_none()
        && hold_ref.failure.is_none()
        && hold_rate_measured <= gates.hold.max_steps_per_second
        && hold_residuals <= gates.hold.max_residuals_per_step
        && within(&hold_diff, &budgets);
    ok &= hold_pass;
    cases.insert("hold".into(), json!({"run":run_json(&hold),"reference":run_json(&hold_ref),"reference_rtol":rtol*factor,"reference_atol_factor":factor,"steps_per_s_measured":hold_rate_measured,"measured_from_s":gates.hold.measured_from_s,"max_steps_per_s":gates.hold.max_steps_per_second,"run_cap_steps":hold_cap,"residuals_per_step":hold_residuals,"max_residuals_per_step":gates.hold.max_residuals_per_step,"reference_difference":hold_diff,"pass":hold_pass}));
    // RCP supply loss and seizure (E2, E3, H1, H2).
    let (trip, trip_pass, trip_runs) = event_case(
        &supplied,
        &taps,
        &atol,
        &gates,
        &budgets,
        gates.supply_loss.duration_s,
        gates.recovery.post_window_s,
    );
    ok &= trip_pass;
    cases.insert("rcp_supply_loss".into(), trip);
    let (seize, seize_pass, seize_runs) = event_case(
        &seized,
        &taps,
        &atol,
        &gates,
        &budgets,
        gates.seizure.duration_s,
        gates.recovery.post_window_s,
    );
    ok &= seize_pass;
    cases.insert("rcp_seizure".into(), seize);

    // 5. Joint cost check, and the conservation identity across every run,
    // each event's R0 included.
    let joint = quiet_rate.map(|r| r * gates.projected_full_unit_step_s);
    let joint_pass = joint.is_some_and(|j| j <= gates.integrator_budget_cpu_s_per_s);
    ok &= joint_pass;
    let runs: Vec<&Run> = [&hold, &hold_ref]
        .into_iter()
        .chain(&trip_runs)
        .chain(&seize_runs)
        .collect();
    let identity = runs
        .iter()
        .flat_map(|r| r.samples.iter().map(|s| s.energy_identity_w.abs()))
        .fold(0., f64::max);
    let identity_relative = runs
        .iter()
        .flat_map(|r| {
            r.samples
                .iter()
                .map(|s| s.energy_identity_w.abs() / (1. + s.energy_identity_terms_w))
        })
        .fold(0., f64::max);
    let total = cpu_s() - total_started;
    let within_budget = total <= gates.total_cpu_s;
    ok &= within_budget;
    receipt["cases"] = Value::Object(cases);
    receipt["joint"] = json!({"quiet_steps_per_s":quiet_rate,"projected_full_unit_step_s":gates.projected_full_unit_step_s,"projected_integrator_cpu_s_per_s":joint,"budget_cpu_s_per_s":gates.integrator_budget_cpu_s_per_s,"pass":joint_pass});
    receipt["energy_identity_max_abs_w"] = json!(identity);
    receipt["energy_identity_max_relative"] = json!(identity_relative);
    receipt["energy_identity_relative_bound"] = json!(IDENTITY_RELATIVE_BOUND);
    receipt["budgets_not_exercised"] = json!({"hydraulic_head_pa":budgets.hydraulic_head_pa,"threshold_timing_s":budgets.threshold_timing_s,"reason":"S1 has forced circulation only and no root-found protection thresholds; natural-circulation head and trip timing are exercised from S2/S3"});
    receipt["total_cpu_budget_s"] = json!(gates.total_cpu_s);
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
/// of the declared RCP start, then the declared event pipeline (E0-E3, H1,
/// H2) on a short window from that spin-up state, to exercise its code
/// before the gate run, including the window-end restart and its counts.
/// The pipeline's values here judge nothing.
#[test]
#[ignore = "requires the actual packet, the wiki, maintained IF97 and stock IDA/KLU"]
fn s1_harness_smoke() {
    let packet_path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET").unwrap();
    let wiki = std::env::var("LD01_WIKI_ROOT").unwrap();
    let model = format!("{wiki}/world/packs/process-plant/reference-designs/ld-01/model");
    let gates: Gates = strict_block(&format!("{model}/build-readiness.md"), "ld01-s1-gates");
    let budgets: Budgets = strict_block(
        &format!("{model}/operating-hot-spine.md"),
        "ld01-accuracy-contract",
    );
    gates.check(&budgets);
    let packet: Packet =
        serde_json::from_slice(&std::fs::read(&packet_path).unwrap()).expect("packet");
    // The gate run's water-build provenance, on the build this binary links.
    let water = water_build(
        &MetastableBand::from(&packet.pzr.cell.metastable),
        WATER_BUILD,
        WATER_LIB_DIR,
    )
    .expect("water build");
    assert!(water["librarySha256"].as_str().is_some(), "{water}");
    let declared = &packet.preparation.operating_point;
    // The declared 6.00 m saturated preparation (S1 re-declaration).
    let point = OperatingPoint::from(declared);
    let taps = taps(&packet, &fresh(&packet));
    let rotors = vec![
        RotorState {
            support: Support::Supported(SpeedRequest::Nominal),
            shaft: Shaft::Free,
        };
        4
    ];
    let settings = Settings {
        pressure_tolerance_pa: PZR.pressure_tolerance_pa,
        max_passes: PZR.max_passes,
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
    let mut s = spec(&gates, 3., gates.relative_tolerance, &atol, 200_000);
    s.output_s = 0.5;
    s.cpu_cap_s = 60.;
    let run = advance_run(
        network,
        &taps,
        &y0,
        &prepared.differential,
        s,
        &|_: &[Sample]| false,
    );
    println!(
        "{}",
        json!({"kind":"s1-harness-smoke-NOT-EVIDENCE","packet":packet_path,"water_build":water,"preparation_passes":preparation.pass_changes_pa.len(),"max_eos_row":preparation.max_eos_row,"max_loop_rest_pa":preparation.max_loop_rest_pa,"max_phase_drive_pa":preparation.max_phase_drive_pa,"mass_change_kg":preparation.mass_change_kg,"run":run_json(&run),"samples":run.samples.iter().map(|s|json!({"t":s.t,"roof_pa":s.roof_pa,"loop_kg_s":s.loop_kg_s,"omega":s.omega,"steps":s.steps,"h":s.last_step,"energy_identity_w":s.energy_identity_w,"blocked_path_m3_s":s.blocked_path_m3_s})).collect::<Vec<_>>()})
    );
    assert!(run.failure.is_none(), "{:?}", run.failure);
    let from = || (fresh(&packet), run.y.clone(), prepared.differential.clone());
    let (case, _, runs) = event_case(&from, &taps, &atol, &gates, &budgets, 0.5, 0.5);
    println!(
        "{}",
        json!({"kind":"s1-harness-smoke-event-pipeline-NOT-EVIDENCE","from_t_s":run.samples.last().map(|s|s.t),"case":case})
    );
    let [event, r1, r2, r0] = &runs;
    for r in [event, r1, r2] {
        assert!(r.failure.is_none(), "{:?}", r.failure);
        assert_eq!(r.fine.len(), 251, "observations over the 0.5 s window");
    }
    // R0 is unobserved, and as an S1 run it must not fail.
    assert!(r0.failure.is_none() && !r0_fails(r0), "{:?}", r0.failure);
    assert!(r0.fine.is_empty());
    assert!(case["versus_r1"]["evaluable"].as_bool() == Some(true));
    // H1: the event run restarted at the window's end by the exact
    // consistent start and reached its continuation's end; its counts are
    // the window's and the continuation's, which only it has.
    let pair = event.restart_pair.as_ref().expect("restart pair");
    assert!(pair.residual.value <= CONSISTENT_ROW_BOUND, "{pair:?}");
    assert!(
        pair.constraint_rate.value <= CONSISTENT_ROW_BOUND,
        "{pair:?}"
    );
    assert!(
        pair.projection
            .as_ref()
            .is_some_and(|p| p.correction_wrms <= 1.),
        "{pair:?}"
    );
    let (window, continued) = (event.window.unwrap(), event.continuation.unwrap());
    assert!(continued.steps > 0);
    assert_eq!(
        event.total,
        window.plus(continued),
        "the run's counts are the window's plus the continuation's"
    );
    assert!(r1.continuation.is_none() && r2.continuation.is_none());
    assert_eq!(Some(r1.total), r1.window);
    assert_eq!(case["recovery"]["reached_s"].as_f64(), Some(1.));
    assert_eq!(
        case["recovery"]["steps"].as_i64(),
        Some(window.steps + continued.steps)
    );
    // R0 beside the gate: one never-capped history over the window and the
    // recovery interval, marked at the window's end; its two intervals add
    // to its total, and its CPU is stated.
    let natural = &case["recovery"]["natural_reference"];
    assert_eq!(natural["reached_s"].as_f64(), Some(1.), "{natural}");
    assert_eq!(natural["covered"], json!(true), "{natural}");
    assert_eq!(natural["failure"], Value::Null, "{natural}");
    assert_eq!(
        (&natural["fails_event"], &natural["run_cap_reached"]),
        (&json!(false), &json!(false)),
        "{natural}"
    );
    let steps = |part: &str| natural[part]["steps"].as_i64().unwrap();
    assert_eq!(
        steps("window") + steps("interval"),
        natural["run"]["steps"].as_i64().unwrap()
    );
    assert!(
        natural["step_at_window_end_s"]
            .as_f64()
            .is_some_and(|h| h > 0.),
        "{natural}"
    );
    assert!(
        natural["continuation_over_r0_steps"]
            .as_f64()
            .is_some_and(|r| r.is_finite() && r > 0.),
        "{natural}"
    );
    assert!(natural["cpu_s"].as_f64().is_some_and(|c| c > 0.));
    assert_eq!(natural["run"]["observations"], json!(0));
    // H2: every cap-cycle output reports its floor, judgement and excess
    // spectrum.
    for name in CAP_CYCLE_OUTPUTS {
        let output = &case["cap_cycle"]["outputs"][name];
        assert!(output["floor"].as_f64().is_some_and(|f| f > 0.), "{output}");
        assert!(output["judged"].is_boolean() && output["pass"].is_boolean());
        assert!(
            output["excess_spectrum"]["resolution_hz"]
                .as_f64()
                .is_some()
        );
    }
}

/// Zero-time check of the declared configuration, NOT S1 evidence: the
/// gates block parses into exactly its fields and passes the declared
/// checks; the derived window and recovery budgets and caps, the restart
/// and the cap-cycle floors are printed.
#[test]
#[ignore = "requires the wiki"]
fn s1_declared_gates() {
    let wiki = std::env::var("LD01_WIKI_ROOT").unwrap();
    let model = format!("{wiki}/world/packs/process-plant/reference-designs/ld-01/model");
    let gates: Gates = strict_block(&format!("{model}/build-readiness.md"), "ld01-s1-gates");
    let budgets: Budgets = strict_block(
        &format!("{model}/operating-hot-spine.md"),
        "ld01-accuracy-contract",
    );
    gates.check(&budgets);
    let event = |window: f64| {
        let span = window + gates.recovery.post_window_s;
        json!({"window_s":window,"allowed_steps":gates.budget_steps(window),"run_cap_steps":gates.cap_steps(window),"observations":(window/gates.comparison.observation_s).round()+1.,
            "recovery":{"span_s":span,"allowed_steps":gates.budget_steps(span),"run_cap_steps":gates.cap_steps(span)}})
    };
    let floors = cap_cycle_floors(
        &budgets,
        gates.event_reference.cap_cycle_floor_budget_fraction,
    );
    println!(
        "{}",
        json!({"kind":"s1-declared-gates-NOT-EVIDENCE","wiki":wiki,"cutoff_hz":budgets.uncredited_above_hz,"padding_s":padding_s(budgets.uncredited_above_hz),
            "window_newton_coefficient":STOCK_NEWTON_COEFFICIENT*gates.event_window.newton_coefficient_factor,
            "recovery":{"restart":gates.recovery.restart,"newton_coefficient":STOCK_NEWTON_COEFFICIENT,"max_convergence_failures":gates.recovery.max_convergence_failures},
            "cap_cycle_floors":CAP_CYCLE_OUTPUTS.iter().zip(floors).map(|(n, f)| (n.to_string(), json!(f))).collect::<serde_json::Map<_, _>>(),
            "r2_rtol":gates.relative_tolerance*gates.event_reference.second_refinement_tolerance_factor,
            "seizure":event(gates.seizure.duration_s),"supply_loss":event(gates.supply_loss.duration_s),
            "hold_run_cap_steps":(gates.run_cap_factor*gates.hold.max_steps_per_second*gates.hold.duration_s) as i64})
    );
}

/// Zero-time check, NOT S1 evidence: the declared 6.00 m preparation, RCPs at
/// rest, and its consistent initial pair built from the residual's own forces
/// (no IDACalcIC at t = 0), asserted at the declared bound; with the census,
/// structure, calls per residual and PZR band state. Advances no time.
#[test]
#[ignore = "requires the actual packet, the wiki, maintained IF97 and stock IDA/KLU"]
fn s1_zero_time_consistent_pair() {
    let packet_path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET").unwrap();
    let packet: Packet =
        serde_json::from_slice(&std::fs::read(&packet_path).unwrap()).expect("packet");
    let point = OperatingPoint::from(&packet.preparation.operating_point);
    let rotors = vec![
        RotorState {
            support: Support::Supported(SpeedRequest::Nominal),
            shaft: Shaft::Free,
        };
        4
    ];
    let settings = Settings {
        pressure_tolerance_pa: PZR.pressure_tolerance_pa,
        max_passes: PZR.max_passes,
        level_match_m: 1e-9,
        eos_row_bound: 1e-12,
        tree_face_bound_pa: 1e-6,
        representation_search: 8,
    };
    let (mut network, prepared, preparation) =
        prepare::prepare(&packet, If97, &point, &rotors, &settings).expect("preparation");
    let mut y = prepared.y.clone();
    for index in &network.rotor_index {
        y[*index] = 0.;
    }
    let structure = network.sparse_jacobian().expect("structure");
    let algebraic = prepared.differential.iter().filter(|v| **v == 0.).count();
    let before = network.counters;
    let atol = network
        .absolute_tolerances(
            &y,
            ToleranceClasses {
                relative: 1e-5,
                stock_scaled: 1e-8,
                tracer_scaled: 1e-8,
                rotor_scaled: 1e-8,
                volume_flow_m3_s: 1e-3,
            },
        )
        .expect("tolerances");
    let weights: Vec<f64> = y
        .iter()
        .zip(&atol)
        .map(|(v, a)| 1. / (1e-5 * v.abs() + a))
        .collect();
    let mut projected = y.clone();
    let (yp, pair) = consistent_start(
        &mut network,
        0.,
        &mut projected,
        &prepared.differential,
        &weights,
        CONSISTENT_ROW_BOUND,
        2,
    )
    .expect("consistent prepared pair");
    // The prepared state is exact: the projection is a bitwise no-op.
    assert_eq!(
        projected.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
        y.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
    );
    assert_eq!(pair.projection.as_ref().map(|p| p.passes), Some(0));
    let during = network.counters;
    assert!(pair.residual.value <= CONSISTENT_ROW_BOUND, "{pair:?}");
    assert!(
        pair.constraint_rate.value <= CONSISTENT_ROW_BOUND,
        "{pair:?}"
    );
    let labels = network.labels();
    // At rest the stock and algebraic rates vanish to rounding; the impulse
    // rates carry the loop drive.
    let algebraic_rate = prepared
        .differential
        .iter()
        .zip(&yp)
        .filter(|(id, _)| **id == 0.)
        .map(|(_, v)| v.abs())
        .fold(0., f64::max);
    assert!(algebraic_rate <= CONSISTENT_ROW_BOUND, "{algebraic_rate}");
    let impulse = network
        .face_layout
        .iter()
        .map(|l| (yp[l.index] * network.scales()[l.index]).abs())
        .fold(0., f64::max);
    let taps = network.pzr_taps().expect("taps");
    let bands = network.pzr_band_reports().expect("band reports");
    println!(
        "{}",
        json!({"kind":"s1-zero-time-consistent-pair-NOT-EVIDENCE","packet":packet_path,
            "census":{"coordinates":y.len(),"algebraic":algebraic,"differential":y.len()-algebraic},
            "structure":{"nonzeros":structure.pattern.nonzeros(),"colors":structure.coloring.count()},
            "preparation":{"max_eos_row":preparation.max_eos_row,"max_tree_rest_pa":preparation.max_tree_rest_pa,"max_loop_rest_pa":preparation.max_loop_rest_pa,"pzr_representation_steps":preparation.pzr["representation_steps"],"pzr_specific_energy_exact":preparation.pzr["specific_energy_exact"]},
            "initial_pair":{"pair":pair,"residual_coordinate":labels[pair.residual.row].1,"largest_algebraic_rate":algebraic_rate,"largest_impulse_rate_pa":impulse,"evaluations":during.evaluations-before.evaluations,"pzr_columns":during.pzr_columns-before.pzr_columns},
            "pzr":{"pt1_pa":taps.pt1_pa.value,"collapsed_level_m":taps.collapsed_level_m.value,"mixture_level_m":taps.mixture_level_m.value,"departure_k":bands.map(|b|b.departure_k),"bands":format!("{:?}",bands.map(|b|b.band))}})
    );
}

/// Test fixture, NOT S1 evidence and no gate: the declared settling segment
/// from the consistent prepared pair, then the energy identity at the settled
/// state against the declared bound, with the PZR's split recorded.
#[test]
#[ignore = "requires the actual packet, the wiki, maintained IF97 and stock IDA/KLU"]
fn s1_settled_energy_identity() {
    let packet_path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET").unwrap();
    let wiki = std::env::var("LD01_WIKI_ROOT").unwrap();
    let model = format!("{wiki}/world/packs/process-plant/reference-designs/ld-01/model");
    let gates: Gates = strict_block(&format!("{model}/build-readiness.md"), "ld01-s1-gates");
    let packet: Packet =
        serde_json::from_slice(&std::fs::read(&packet_path).unwrap()).expect("packet");
    let point = OperatingPoint::from(&packet.preparation.operating_point);
    let rotors = vec![
        RotorState {
            support: Support::Supported(SpeedRequest::Nominal),
            shaft: Shaft::Free,
        };
        4
    ];
    let settings = Settings {
        pressure_tolerance_pa: PZR.pressure_tolerance_pa,
        max_passes: PZR.max_passes,
        level_match_m: 1e-9,
        eos_row_bound: 1e-12,
        tree_face_bound_pa: 1e-6,
        representation_search: 8,
    };
    let taps = taps(&packet, &fresh(&packet));
    let (network, prepared, _) =
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
    let (window, rotor_rel, flow_rel) = (
        gates.settling.window_s,
        gates.settling.rotor_speed_relative,
        gates.settling.loop_flow_relative_change,
    );
    let omega0 = network.drive().reference_omega_rad_s;
    let settled = move |samples: &[Sample]| {
        let last = samples.last().unwrap();
        let Some(earlier) = samples.iter().rev().find(|s| s.t <= last.t - window) else {
            return false;
        };
        last.omega
            .iter()
            .all(|w| ((w - omega0) / omega0).abs() < rotor_rel)
            && (0..2).all(|k| {
                ((last.loop_kg_s[k] - earlier.loop_kg_s[k]) / last.loop_kg_s[k]).abs() < flow_rel
            })
    };
    let mut settling = spec(
        &gates,
        gates.settling.max_simulated_s,
        gates.relative_tolerance,
        &atol,
        i64::MAX,
    );
    settling.output_s = 1.;
    settling.cpu_cap_s = gates.settling.max_cpu_s;
    let run = advance_run(
        network,
        &taps,
        &y0,
        &prepared.differential,
        settling,
        &settled,
    );
    assert!(run.failure.is_none(), "{:?}", run.failure);
    let mut probe = fresh(&packet);
    probe
        .evaluate(0., &run.y, &run.yp, None, 0., None)
        .expect("settled residual");
    let budget = probe.current_budget(&run.y, &run.yp);
    let identity = budget["fluid_plus_rotor_plus_bearing_minus_motor_w"]
        .as_f64()
        .unwrap();
    let terms = budget["identity_terms_abs_sum_w"].as_f64().unwrap();
    println!(
        "{}",
        json!({"kind":"s1-settled-energy-identity-FIXTURE-NOT-EVIDENCE","packet":packet_path,"settled_t_s":run.samples.last().map(|s|s.t),"identity_w":identity,"terms_abs_w":terms,"bound_w":IDENTITY_RELATIVE_BOUND*(1.+terms),"budget":budget,"max_sample_identity_w":run.samples.iter().map(|s|s.energy_identity_w.abs()).fold(0.,f64::max)})
    );
    assert!(
        identity.abs() <= IDENTITY_RELATIVE_BOUND * (1. + terms),
        "identity {identity} W against terms {terms} W"
    );
    // The event transactions at that state, each started by the exact
    // consistent-rate solve (no IDACalcIC).
    let mut supply = fresh(&packet);
    supply.set_rotor_state(
        gates.supply_loss.rotor,
        RotorState {
            support: Support::Unsupported,
            shaft: Shaft::Free,
        },
    );
    let weights = |y: &[f64]| -> Vec<f64> {
        y.iter()
            .zip(&atol)
            .map(|(v, a)| 1. / (gates.relative_tolerance * v.abs() + a))
            .collect()
    };
    let mut y_supply = run.y.clone();
    let supply_pair = consistent_start(
        &mut supply,
        0.,
        &mut y_supply,
        &prepared.differential,
        &weights(&run.y),
        CONSISTENT_ROW_BOUND,
        2,
    );
    let mut locked = fresh(&packet);
    let mut y_post = run.y.clone();
    locked
        .seize(gates.seizure.rotor, &mut y_post)
        .expect("seizure");
    let locked_ids = locked.differential(&prepared.differential);
    let seizure_weights = weights(&y_post);
    let seizure_pair = consistent_start(
        &mut locked,
        0.,
        &mut y_post,
        &locked_ids,
        &seizure_weights,
        CONSISTENT_ROW_BOUND,
        2,
    );
    println!(
        "{}",
        json!({"kind":"s1-event-consistent-pairs-FIXTURE-NOT-EVIDENCE","initial":run.initial_pair,"supply_loss":supply_pair.as_ref().map(|(_, p)| p.clone()).map_err(|e| format!("{e:?}")),"seizure":seizure_pair.as_ref().map(|(_, p)| p.clone()).map_err(|e| format!("{e:?}"))})
    );
    supply_pair.expect("supply-loss consistent pair");
    seizure_pair.expect("seizure consistent pair");
}

// ---- Harness unit tests (no packet; stock IDA for the clock). ----

/// y0' = -y0 (differential) and y1 = 2 y0 (algebraic): a stock-IDA fixture
/// for the observation clock.
struct Decay;
impl System for Decay {
    fn dimension(&self) -> usize {
        2
    }
    fn nonzeros(&self) -> usize {
        3
    }
    fn root_count(&self) -> usize {
        0
    }
    fn roots(&mut self, _: f64, _: &[f64], _: &[f64], _: &mut [f64]) -> Result<(), Failure> {
        Ok(())
    }
    fn residual(&mut self, _: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        out[0] = yp[0] + y[0];
        out[1] = y[1] - 2. * y[0];
        Ok(())
    }
    fn jacobian(
        &mut self,
        _: f64,
        cj: f64,
        _: &[f64],
        _: &[f64],
        data: &mut [f64],
        rows: &mut [i64],
        pointers: &mut [i64],
    ) -> Result<(), Failure> {
        data.copy_from_slice(&[cj + 1., -2., 1.]);
        rows.copy_from_slice(&[0, 1, 1]);
        pointers.copy_from_slice(&[0, 2, 3]);
        Ok(())
    }
}
/// The decay over [0, 1] at a 20 ms cap and a tightened coefficient, output
/// every 0.1 s and, when observing, every 2 ms by root returns.
fn decay_observed(observing: bool) -> (Vec<(f64, f64)>, Stats, [f64; 2]) {
    let (mut y, mut yp) = ([1., 2.], [-1., -2.]);
    let mut clock = Clock::new(0.002, 0.1, 1., 2.);
    let mut ida = Ida::new(
        Observed::new(Decay, observing.then(|| clock.next.clone())),
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &[1., 0.],
            absolute_tolerance: &[1e-10; 2],
            relative_tolerance: 1e-8,
        },
    )
    .unwrap();
    ida.set_max_order(2).unwrap();
    ida.set_max_step(0.02).unwrap();
    ida.set_nonlinear_convergence_coefficient(0.033).unwrap();
    ida.stop_at(1.).unwrap();
    let mut seen = vec![(0., y[0])];
    if observing {
        clock.arm();
    }
    let mut k = 1;
    loop {
        match ida
            .advance((f64::from(k) / 10.).min(1.), &mut y, &mut yp)
            .unwrap()
        {
            Advance::Reached(t) => {
                seen.push((t, y[0]));
                if t >= 1. {
                    break;
                }
                k += 1;
            }
            Advance::Root { time, .. } => {
                seen.push((time, y[0]));
                clock.arm();
            }
        }
    }
    (seen, ida.stats().unwrap(), y)
}
#[test]
fn observing_by_one_root_function_changes_no_step() {
    let (plain, a, ya) = decay_observed(false);
    let (fine, b, yb) = decay_observed(true);
    let counts = |s: &Stats| {
        [
            s.steps,
            s.residuals,
            s.jacobians,
            s.nonlinear_iterations,
            s.error_failures,
            s.convergence_failures,
            s.linear_setups,
        ]
    };
    assert_eq!(counts(&a), counts(&b));
    assert!(a.steps >= 50, "{} steps under the 20 ms cap", a.steps);
    assert_eq!(a.root_evaluations, 0);
    assert!(b.root_evaluations > 0);
    assert_eq!(ya.map(f64::to_bits), yb.map(f64::to_bits));
    assert_eq!(plain.len(), 11);
    assert_eq!(fine.len(), 501);
    for (j, (t, v)) in fine.iter().enumerate() {
        assert!(
            (t - j as f64 * 0.002).abs() <= 1e-12,
            "observation {j} at {t}"
        );
        assert!((v - (-t).exp()).abs() <= 1e-6, "y0({t}) = {v}");
    }
    // The outputs are the same interpolants with or without observation.
    for (p, q) in plain.iter().zip(fine.iter().step_by(50)) {
        assert_eq!(
            (p.0.to_bits(), p.1.to_bits()),
            (q.0.to_bits(), q.1.to_bits())
        );
    }
}

#[test]
fn the_zero_phase_butterworth_has_the_declared_response() {
    let (dt, fc, n) = (0.002, 2., 10_001);
    let t = |j: usize| j as f64 * dt;
    // A constant passes unchanged to the recursion's rounding (poles near
    // z = 1 at fc dt = 0.004), and a ramp nearly so, edges included.
    let constant = zero_phase_lowpass(&vec![3.5; n], fc, dt);
    let worst = constant.iter().map(|v| (v - 3.5).abs()).fold(0., f64::max);
    assert!(worst <= 1e-11 * 3.5, "constant {worst}");
    let ramp: Vec<f64> = (0..n).map(|j| 1e5 + 40. * t(j)).collect();
    let low = zero_phase_lowpass(&ramp, fc, dt);
    let worst = ramp
        .iter()
        .zip(&low)
        .map(|(a, b)| (a - b).abs())
        .fold(0., f64::max);
    assert!(worst <= 1e-3, "ramp {worst}");
    // Steady sinusoids: the prewarped design's |H|^2, with no lag.
    for f in [0.2, 0.7, 2., 6.5, 20.] {
        let x: Vec<f64> = (0..n).map(|j| (2. * PI * f * t(j)).sin()).collect();
        let y = zero_phase_lowpass(&x, fc, dt);
        let gain = 1. / (1. + ((PI * f * dt).tan() / (PI * fc * dt).tan()).powi(8));
        let worst = (2500..n - 2500)
            .map(|j| (y[j] - gain * x[j]).abs())
            .fold(0., f64::max);
        assert!(worst <= 1e-9, "{f} Hz: {worst} at gain {gain}");
    }
    // Linear in its input, padding included: filtering a difference equals
    // the difference of the filtered outputs.
    let a: Vec<f64> = (0..n)
        .map(|j| (2. * PI * 0.7 * t(j)).sin() + 3. * t(j))
        .collect();
    let b: Vec<f64> = (0..n)
        .map(|j| 30. * (2. * PI * 9. * t(j)).cos() - 2.)
        .collect();
    let d: Vec<f64> = a.iter().zip(&b).map(|(p, q)| p - q).collect();
    let (la, lb, ld) = (
        zero_phase_lowpass(&a, fc, dt),
        zero_phase_lowpass(&b, fc, dt),
        zero_phase_lowpass(&d, fc, dt),
    );
    let worst = (0..n)
        .map(|j| (ld[j] - (la[j] - lb[j])).abs())
        .fold(0., f64::max);
    assert!(worst <= 1e-9, "linearity {worst}");
}

fn synthetic(fine: Vec<Credited>) -> Run {
    Run {
        fine,
        ..Run::default()
    }
}
fn budgets() -> Budgets {
    Budgets {
        pzr_roof_pressure_bias_pa: 1000.,
        pzr_roof_pressure_sample_noise_pa: 200.,
        pzr_level_m: 0.01,
        core_differential_pressure_pa: 50.,
        hydraulic_head_pa: 500.,
        loop_flow_kg_s: 40.,
        threshold_timing_s: 0.05,
        uncredited_above_hz: 2.,
    }
}
#[test]
fn the_comparison_takes_the_contract_metrics_of_the_filtered_difference() {
    let (dt, window, n) = (0.002, 10., 5001);
    let reference: Vec<Credited> = (0..n)
        .map(|j| {
            let t = j as f64 * dt;
            Credited {
                t,
                roof_pa: 15.5e6 + 3e4 * (2. * PI * 0.05 * t).sin(),
                level_m: 6. + 0.1 * t,
                core_dp_pa: 1.2e5,
                loop_kg_s: [4600., 4610.],
            }
        })
        .collect();
    // Credited differences plus content above the band that a raw sample
    // comparison would alias (23 Hz roof, 30 Hz core DP).
    let run: Vec<Credited> = reference
        .iter()
        .map(|c| {
            let t = c.t;
            Credited {
                t,
                roof_pa: c.roof_pa + 300. + 50. * (PI * t).sin() + 1e3 * (2. * PI * 23. * t).sin(),
                level_m: c.level_m + 0.004 * (2. * PI * 0.3 * t).sin(),
                core_dp_pa: c.core_dp_pa + 20. + 200. * (2. * PI * 30. * t).sin(),
                loop_kg_s: [c.loop_kg_s[0] + 5., c.loop_kg_s[1] - 7.],
            }
        })
        .collect();
    let diff = compare(
        &synthetic(run.clone()),
        &synthetic(reference.clone()),
        window,
        dt,
        0.1,
        2.,
    );
    let m = |k: &str| diff[k].as_f64().unwrap();
    assert!((m("pzr_roof_bias_pa") - 300.).abs() < 0.1, "{diff}");
    // 0.5 Hz sampled at 0.1 s: the change's deviation is sqrt(2) 50 sin(0.05 pi).
    let noise = 2_f64.sqrt() * 50. * (0.05 * PI).sin();
    assert!(
        (m("pzr_roof_sample_noise_pa") - noise).abs() < 0.05,
        "{diff}"
    );
    assert!((m("pzr_level_m") - 0.004).abs() < 1e-6, "{diff}");
    assert!((m("core_dp_pa") - 20.).abs() < 1e-3, "{diff}");
    assert!((m("loop_flow_kg_s") - 7.).abs() < 1e-9, "{diff}");
    assert!(diff["detail"]["unfiltered_max_abs"]["core_dp_pa"].as_f64() > Some(200.));
    assert!(within(&diff, &budgets()));
    // One missed budget fails, and an incomplete series is not evaluable.
    let shifted: Vec<Credited> = run
        .iter()
        .map(|c| Credited {
            core_dp_pa: c.core_dp_pa + 40.,
            ..*c
        })
        .collect();
    let missed = compare(
        &synthetic(shifted),
        &synthetic(reference.clone()),
        window,
        dt,
        0.1,
        2.,
    );
    assert!(!within(&missed, &budgets()), "{missed}");
    let short = compare(
        &synthetic(run[..n - 1].to_vec()),
        &synthetic(reference),
        window,
        dt,
        0.1,
        2.,
    );
    assert_eq!(short["evaluable"], json!(false));
    assert!(!within(&short, &budgets()));
}

#[test]
fn the_cap_cycle_check_bounds_content_above_the_credited_band() {
    let (dt, window, n) = (0.002, 10., 5001);
    let make = |dp: f64| {
        synthetic(
            (0..n)
                .map(|j| {
                    let t = j as f64 * dt;
                    Credited {
                        t,
                        roof_pa: 15.5e6
                            + 2e3 * (2. * PI * 0.3 * t).sin()
                            + 100. * (2. * PI * 8.5 * t).sin(),
                        level_m: 6.,
                        core_dp_pa: 1.2e5 + dp * (2. * PI * 6.5 * t).sin(),
                        loop_kg_s: [4600. + 0.5 * (2. * PI * 6.5 * t).sin(), 4610.],
                    }
                })
                .collect(),
        )
    };
    let r1 = make(20.);
    // The declared floors: 5 Pa, 4 kg/s, 4 kg/s and 20 Pa.
    let floors = cap_cycle_floors(&budgets(), 0.1);
    let (report, pass) = cap_cycle(&make(30.), &r1, window, dt, 2., 2., floors);
    assert!(pass, "{report}");
    let core = &report["outputs"]["core_dp_pa"];
    assert!(
        (core["ratio"].as_f64().unwrap() - 1.5).abs() < 1e-3,
        "{report}"
    );
    assert!(
        (core["run_rms"].as_f64().unwrap() - 30. / 2_f64.sqrt()).abs() < 0.01,
        "{report}"
    );
    assert_eq!(core["floor"].as_f64(), Some(5.));
    assert_eq!(core["judged"], json!(true));
    let roof = &report["outputs"]["pzr_roof_pa"];
    assert!((roof["ratio"].as_f64().unwrap() - 1.).abs() < 1e-9);
    assert_eq!(
        (&roof["floor"], &roof["judged"]),
        (&json!(20.), &json!(true))
    );
    // Loop A's 0.35 kg/s lies below its 4 kg/s floor and is not judged.
    let loop_a = &report["outputs"]["loop_a_kg_s"];
    assert_eq!(
        (&loop_a["judged"], &loop_a["pass"]),
        (&json!(false), &json!(true))
    );
    // An output without content in either run passes with no ratio.
    assert!(
        report["outputs"]["loop_b_kg_s"]["ratio"].is_null(),
        "{report}"
    );
    let (report, pass) = cap_cycle(&make(50.), &r1, window, dt, 2., 2., floors);
    assert!(!pass, "{report}");
    let core = &report["outputs"]["core_dp_pa"];
    assert_eq!(
        (&core["judged"], &core["pass"]),
        (&json!(true), &json!(false))
    );
    // The diagnostic names the excess's frequency; identical content has
    // none, and an output without content has no dominant frequency.
    let spectrum = |name: &str| &report["outputs"][name]["excess_spectrum"];
    let df = spectrum("core_dp_pa")["resolution_hz"].as_f64().unwrap();
    assert!((spectrum("core_dp_pa")["excess_hz"].as_f64().unwrap() - 6.5).abs() <= df);
    assert!(spectrum("pzr_roof_pa")["excess_hz"].is_null(), "{report}");
    assert!((spectrum("pzr_roof_pa")["run_dominant_hz"].as_f64().unwrap() - 8.5).abs() <= df);
    assert!(
        spectrum("loop_b_kg_s")["run_dominant_hz"].is_null(),
        "{report}"
    );
}

#[test]
fn the_cap_cycle_floor_passes_content_below_it_and_judges_the_rest_by_the_ratio() {
    let (dt, window, n) = (0.002, 10., 5001);
    let floors = cap_cycle_floors(&budgets(), 0.1);
    assert_eq!(floors, [5., 4., 4., 20.]);
    // One 6.5 Hz component of amplitude a per output (core DP, loop A,
    // loop B, roof): a content RMS of a / sqrt 2.
    let make = |a: [f64; 4]| {
        synthetic(
            (0..n)
                .map(|j| {
                    let t = j as f64 * dt;
                    let s = (2. * PI * 6.5 * t).sin();
                    Credited {
                        t,
                        roof_pa: 15.5e6 + a[3] * s,
                        level_m: 6.,
                        core_dp_pa: 1.2e5 + a[0] * s,
                        loop_kg_s: [4600. + a[1] * s, 4610. + a[2] * s],
                    }
                })
                .collect(),
        )
    };
    let judge = |run: [f64; 4], r1: [f64; 4], floors: [f64; 4]| {
        cap_cycle(&make(run), &make(r1), window, dt, 2., 2., floors)
    };
    // Below every floor (4.2 Pa, 3.5 kg/s, 3.5 kg/s, 17.7 Pa) each output
    // passes unjudged, whatever its ratio (here 10).
    let small = [6., 5., 5., 25.];
    let (report, pass) = judge(small, small.map(|a| a / 10.), floors);
    assert!(pass, "{report}");
    for name in CAP_CYCLE_OUTPUTS {
        let output = &report["outputs"][name];
        assert_eq!(
            (&output["judged"], &output["pass"]),
            (&json!(false), &json!(true)),
            "{report}"
        );
        assert!((output["ratio"].as_f64().unwrap() - 10.).abs() < 1e-6);
    }
    // Above its floor each output is judged by the ratio: 2.5 fails it and
    // the whole check, 1.5 passes; the others stay unjudged.
    let large = [10., 8., 8., 40.];
    for (i, name) in CAP_CYCLE_OUTPUTS.iter().enumerate() {
        for (ratio, expected) in [(2.5, false), (1.5, true)] {
            let (mut run, mut r1) = (small, small);
            run[i] = large[i];
            r1[i] = large[i] / ratio;
            let (report, pass) = judge(run, r1, floors);
            assert_eq!(pass, expected, "{name} at {ratio}: {report}");
            let output = &report["outputs"][name];
            assert_eq!(
                (&output["judged"], &output["pass"]),
                (&json!(true), &json!(expected)),
                "{report}"
            );
            for other in CAP_CYCLE_OUTPUTS.iter().filter(|o| *o != name) {
                assert_eq!(report["outputs"][other]["judged"], json!(false));
            }
        }
    }
    // Content exactly at its floor passes unjudged.
    let (report, _) = judge(large, large.map(|a| a / 2.5), floors);
    let at = CAP_CYCLE_OUTPUTS.map(|name| report["outputs"][name]["run_rms"].as_f64().unwrap());
    let (report, pass) = judge(large, large.map(|a| a / 2.5), at);
    assert!(pass, "{report}");
    for name in CAP_CYCLE_OUTPUTS {
        assert_eq!(report["outputs"][name]["judged"], json!(false));
    }
}

#[test]
fn the_excess_spectrum_recovers_a_tone_within_one_bin() {
    let (dt, n) = (0.002, 5001);
    let tone = |f: f64, a: f64| -> Vec<f64> {
        (0..n)
            .map(|j| a * (2. * PI * f * j as f64 * dt).sin())
            .collect()
    };
    let sum = |a: &[f64], b: &[f64]| -> Vec<f64> { a.iter().zip(b).map(|(x, y)| x + y).collect() };
    // The density over 2 s Hann segments at 50% overlap: 0.5 Hz bins, nine
    // segments in 10 s, and its sum over the bins is the variance.
    let (density, df, segments) = welch(&tone(6.5, 3.), dt, WELCH_SEGMENT_S);
    assert_eq!((density.len(), segments), (501, 9));
    assert!((df - 0.5).abs() < 1e-12, "{df}");
    let variance = density.iter().sum::<f64>() * df;
    assert!((variance - 4.5).abs() < 0.05, "{variance}");
    // Both share a 6.5 Hz tone and a larger 0.7 Hz one below the cutoff;
    // the run adds 11.3 Hz, off the bin grid.
    let r1 = sum(&tone(6.5, 3.), &tone(0.7, 10.));
    let run = sum(&r1, &tone(11.3, 1.));
    let report = excess_spectrum(&run, &r1, dt, 2.);
    let at = |k: &str| report[k].as_f64().unwrap();
    assert!((at("excess_hz") - 11.3).abs() <= df, "{report}");
    assert!(at("excess_density") > 0.);
    // Only bins above the cutoff compete: the run's own dominant frequency
    // is its 6.5 Hz tone, not the 0.7 Hz one.
    assert!((at("run_dominant_hz") - 6.5).abs() <= df, "{report}");
    // The added tone is a tenth of the run's power above the cutoff, spread
    // by the Hann main lobe over its neighbouring bins.
    let share = at("excess_share");
    assert!(share > 0.02 && share < 0.1, "{report}");
    assert!((at("run_power_above_cutoff") - 5.).abs() < 0.1, "{report}");
    // Content equal to R1's has no excess, but still its dominant frequency.
    let same = excess_spectrum(&r1, &r1, dt, 2.);
    assert!(
        same["excess_hz"].is_null() && same["excess_share"].is_null(),
        "{same}"
    );
    assert!((same["run_dominant_hz"].as_f64().unwrap() - 6.5).abs() <= df);
    // A window shorter than a segment is one segment of its own length.
    let short = excess_spectrum(&run[..751], &r1[..751], dt, 2.);
    assert_eq!(short["segments"], json!(1));
    let coarse = short["resolution_hz"].as_f64().unwrap();
    assert!((coarse - 1. / 1.502).abs() < 1e-12, "{short}");
    assert!(
        (short["excess_hz"].as_f64().unwrap() - 11.3).abs() <= coarse,
        "{short}"
    );
}

/// The amended `ld01-s1-gates` values (owner decision request 3, with its
/// follow-up H1a) as a unit fixture, NOT their owner: the harness reads the
/// wiki's block.
const GATES_FIXTURE: &str = r#"{"relativeTolerance":1e-05,"stockScaledAbsolute":1e-08,"tracerScaledAbsolute":1e-08,"rotorScaledAbsolute":1e-08,"volumeFlowAbsolute_m3_s":0.001,"maxOrder":2,"referenceToleranceFactor":0.1,"outputInterval_s":0.1,"projectedFullUnitStep_s":0.008,"integratorBudget_cpu_s_per_s":0.35,"totalCpu_s":1200,"runCapFactor":2,"settling":{"maxSimulated_s":120,"maxCpu_s":300,"window_s":5,"rotorSpeedRelative":0.0001,"loopFlowRelativeChange":0.0005},"hold":{"duration_s":60,"measuredFrom_s":10,"maxStepsPerSecond":40,"maxResidualsPerStep":1.5},"supplyLoss":{"rotor":0,"duration_s":30},"seizure":{"rotor":0,"duration_s":10},"spectrum":{"fastModeHz":50,"lightDamping":0.001,"maxExcitationRatio":30},"blockedPathMaxVolumeFlow_m3_s":0.01,"eventWindow":{"maxStep_s":0.02,"newtonCoefficientFactor":0.1,"budget_cpu_s_per_s":0.5,"maxWindow_s":60,"fullUnitStepExit_s":0.01},"eventReference":{"maxStep_s":0.0025,"secondRefinementToleranceFactor":0.01,"capCycleUncreditedRmsRatioMax":2.0,"capCycleFloorBudgetFraction":0.1},"comparison":{"filter":"zero-phase 4th-order Butterworth","observation_s":0.002},"recovery":{"postWindow_s":10,"restart":"exact consistent start","maxConvergenceFailures":2}}"#;
/// The fixture with one text replaced; the replaced text must occur.
fn gates_fixture_with(from: &str, to: &str) -> String {
    assert!(GATES_FIXTURE.contains(from), "the fixture has no {from}");
    GATES_FIXTURE.replace(from, to)
}

#[test]
fn recovery_is_judged_on_the_window_and_continuation_cost() {
    let gates: Gates = serde_json::from_str(GATES_FIXTURE).expect("fixture gates");
    gates.check(&budgets());
    // The withdrawn E4 rate factor is refused, not ignored.
    let withdrawn = gates_fixture_with(
        r#""postWindow_s":10,"#,
        r#""postWindow_s":10,"maxStepRateFactor":2.0,"#,
    );
    assert!(serde_json::from_str::<Gates>(&withdrawn).is_err());
    // E2's window gates stay: 625 and 1,875 steps, capped at 1,250 and
    // 3,750. H1 over the window and its 10 s: 1,250 and 2,500, capped at
    // 2,500 and 5,000.
    assert_eq!(
        [10., 30., 20., 40.].map(|s| gates.budget_steps(s)),
        [625., 1875., 1250., 2500.]
    );
    assert_eq!(
        [10., 30., 20., 40.].map(|s| gates.cap_steps(s)),
        [1250, 3750, 2500, 5000]
    );
    let continued =
        |reached: f64, window: i64, steps: i64, newton: i64, failure: Option<&str>| Run {
            samples: vec![Sample {
                t: reached,
                ..Sample::default()
            }],
            window: Some(Counts {
                steps: window,
                ..Counts::default()
            }),
            continuation: Some(Counts {
                steps,
                convergence_failures: newton,
                ..Counts::default()
            }),
            failure: failure.map(str::to_string),
            ..Run::default()
        };
    // Seizure (10 s + 10 s): run 4's 595 window steps leave 655 for the
    // continuation, at exactly 0.5 CPU-s/s; one more step misses.
    let (report, pass) = recovery(&gates, &continued(20., 595, 655, 0, None), 10., 10.);
    assert!(pass, "{report}");
    assert_eq!(report["steps"], json!(1250));
    assert_eq!(report["projected_cpu_s_per_s"].as_f64(), Some(0.5));
    assert_eq!(report["steps_per_s"].as_f64(), Some(65.5));
    assert!(
        report["convergence_failures_counter"]
            .as_str()
            .is_some_and(
                |s| s.starts_with("IDAGetNumNonlinSolvConvFails") && s.contains("fresh Jacobian")
            ),
        "{report}"
    );
    let (report, pass) = recovery(&gates, &continued(20., 595, 656, 0, None), 10., 10.);
    assert!(!pass, "{report}");
    // The block's maxConvergenceFailures is the only threshold: at H1a's 2,
    // two Newton convergence failures in the continuation pass and three
    // fail; at H1's first-approved 0, one fails.
    for (newton, expected) in [(2, true), (3, false)] {
        let (report, pass) = recovery(&gates, &continued(20., 595, 100, newton, None), 10., 10.);
        assert_eq!(pass, expected, "{report}");
        assert_eq!(report["max_convergence_failures"], json!(2));
    }
    let none: Gates = serde_json::from_str(&gates_fixture_with(
        r#""maxConvergenceFailures":2"#,
        r#""maxConvergenceFailures":0"#,
    ))
    .expect("fixture gates at 0");
    for (newton, expected) in [(0, true), (1, false)] {
        let (report, pass) = recovery(&none, &continued(20., 595, 100, newton, None), 10., 10.);
        assert_eq!(pass, expected, "{report}");
        assert_eq!(report["max_convergence_failures"], json!(0));
    }
    // Supply loss (30 s + 10 s): 1,508 window steps leave 992.
    let (report, pass) = recovery(&gates, &continued(40., 1508, 992, 0, None), 30., 10.);
    assert!(pass, "{report}");
    let (_, pass) = recovery(&gates, &continued(40., 1508, 993, 0, None), 30., 10.);
    assert!(!pass);
    // A run that stopped short (run 4's supply loss: 25 continuation steps
    // to 36.8 s, then its cap) fails, with its rate over the 6.8 s reached.
    let (report, pass) = recovery(
        &gates,
        &continued(36.8, 1508, 25, 0, Some("recovery cap reached")),
        30.,
        10.,
    );
    assert!(!pass, "{report}");
    let rate = report["steps_per_s"].as_f64().unwrap();
    assert!((rate - 25. / 6.8).abs() < 1e-9, "{report}");
    assert!((report["interval_reached_s"].as_f64().unwrap() - 6.8).abs() < 1e-9);
    // Without a continuation (a refused restart) there is nothing to judge.
    let refused = Run {
        continuation: None,
        failure: Some("window-end restart refused".into()),
        ..continued(30., 1508, 0, 0, None)
    };
    let (report, pass) = recovery(&gates, &refused, 30., 10.);
    assert!(!pass && report["steps"].is_null(), "{report}");
}

#[test]
fn r0_is_reported_beside_the_continuation_and_fails_the_event_except_at_its_cap() {
    let counts = |steps, error_failures, convergence_failures| Counts {
        steps,
        error_failures,
        convergence_failures,
        ..Counts::default()
    };
    let r0 = |reached: f64, at_window: Counts, total: Counts| Run {
        samples: vec![Sample {
            t: reached,
            ..Sample::default()
        }],
        mark: Some(Mark {
            t: 10.,
            counts: at_window,
            last_step_s: 0.06,
            last_order: 2,
            current_step_s: 0.07,
        }),
        total,
        rtol: 1e-5,
        max_step_s: f64::INFINITY,
        max_order: 2,
        cpu_s: 1.5,
        ..Run::default()
    };
    let run = Run {
        samples: vec![Sample {
            t: 20.,
            ..Sample::default()
        }],
        window: Some(counts(595, 1, 0)),
        continuation: Some(counts(120, 3, 0)),
        ..Run::default()
    };
    // R0 took 300 steps over the 10 s window and 150 over [10, 20] s: the
    // continuation's 120 are 0.8 of R0's over the same interval.
    let report = natural_reference(
        &run,
        &r0(20., counts(300, 2, 0), counts(450, 5, 1)),
        10.,
        10.,
        2500,
    );
    assert_eq!(
        report["window"],
        json!({"steps":300,"error_failures":2,"convergence_failures":0})
    );
    assert_eq!(
        report["interval"],
        json!({"steps":150,"error_failures":3,"convergence_failures":1})
    );
    assert_eq!(report["continuation_over_r0_steps"].as_f64(), Some(0.8));
    assert_eq!(report["interval_steps_per_s"].as_f64(), Some(15.));
    assert_eq!(report["step_at_window_end_s"].as_f64(), Some(0.06));
    assert_eq!(report["cpu_s"].as_f64(), Some(1.5));
    let configuration = &report["configuration"];
    assert_eq!(
        (
            &configuration["max_step_s"],
            &configuration["newton_coefficient"]
        ),
        (&Value::Null, &json!(STOCK_NEWTON_COEFFICIENT))
    );
    assert_eq!(
        (
            &report["covered"],
            &report["run_cap_reached"],
            &report["fails_event"]
        ),
        (&json!(true), &json!(false), &json!(false))
    );
    // An R0 that stopped at its cap short of the interval's end is reported
    // with its counts so far and no ratio, and does not fail the event.
    let capped = Run {
        failure: Some("run cap reached: 2501 steps from the run's start".into()),
        cap_reached: true,
        ..r0(16.8, counts(300, 2, 0), counts(2501, 9, 0))
    };
    assert!(!r0_fails(&capped));
    let short = natural_reference(&run, &capped, 10., 10., 2500);
    assert!(
        short["continuation_over_r0_steps"].is_null() && short["interval_steps_per_s"].is_null(),
        "{short}"
    );
    assert_eq!(
        (
            &short["covered"],
            &short["run_cap_reached"],
            &short["fails_event"]
        ),
        (&json!(false), &json!(true), &json!(false))
    );
    assert_eq!(short["interval"]["steps"], json!(2201));
    assert!(short.get("pass").is_none());
    // R0 is an S1 run: a frozen-rule trip, or any other failure such as a
    // property-domain exit through stock IDA, fails the event.
    for failure in [
        "energy identity open at t=14.3: 2 W against terms 1 W",
        "fatal IDA callback: property evaluation outside the admitted domain",
    ] {
        let tripped = Run {
            failure: Some(failure.into()),
            ..r0(14.3, counts(300, 2, 0), counts(400, 3, 0))
        };
        assert!(r0_fails(&tripped), "{failure}");
        let report = natural_reference(&run, &tripped, 10., 10., 2500);
        assert_eq!(
            (&report["fails_event"], &report["run_cap_reached"]),
            (&json!(true), &json!(false))
        );
    }
    assert!(!r0_fails(&r0(20., counts(300, 2, 0), counts(450, 5, 1))));
}

#[test]
fn the_water_build_is_carried_verbatim_and_refused_unless_it_matches() {
    let directory = format!(
        "{}/s1-water-build-{}",
        env!("CARGO_TARGET_TMPDIR"),
        std::process::id()
    );
    std::fs::create_dir_all(&directory).unwrap();
    let library = format!("{directory}/libld01_operating_water.a");
    std::fs::write(&library, b"a stand-in archive for this unit test").unwrap();
    let library_sha256 = sha256_file(&library).unwrap();
    let file = format!("{directory}/water-build.json");
    // H3's single band, as a packet carries it.
    let band = MetastableBand {
        pressure_range_pa: [2e6, 16e6],
        lower_bound_exclusive: true,
        liquid_superheat_max_k: 2.,
        vapor_subcooling_max_k: 1.4,
        trial_max_k: 3.,
        credited_max_k: 0.5,
        liquid_temperature_max_k: 623.15,
        liquid_pressure_ceiling_pa: 17e6,
        vapor_pressure_ceiling_pa: 16e6,
    };
    let receipt = |library_sha256: &str, band: Value| {
        serde_json::to_string_pretty(&json!({"revision":"0be7b51f","headerSha256":"83693f04","licenseSha256":"e22c3d30","adapterSha256":"4446186e","librarySha256":library_sha256,"platform":"darwin","architecture":"arm64",
            "metastableBand":{"page":"world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md","pageSha256":"0138902a","heading":"Bounded metastable admission","fence":"ld01-metastable-band","band":band}}))
        .unwrap()
            + "\n"
    };
    // The receipt written to the directory, then checked as the embedded one.
    let check = |text: &str, packet: &MetastableBand| {
        std::fs::write(&file, text).unwrap();
        water_build(packet, text, &directory)
    };
    let good = receipt(&library_sha256, serde_json::to_value(band).unwrap());
    // A sound build is carried verbatim.
    let carried = check(&good, &band).unwrap();
    assert_eq!(carried, serde_json::from_str::<Value>(&good).unwrap());
    // A band other than the packet's is refused: G2 (a)'s 5.9 MPa edge.
    let other = MetastableBand {
        pressure_range_pa: [5.9e6, 16e6],
        ..band
    };
    let refused = check(&good, &other).unwrap_err();
    assert!(refused.contains("differs from the packet's"), "{refused}");
    // So is an archive without the receipt's hash: the archive is not
    // byte-reproducible, so only its hash names the build.
    let rebuilt = receipt(&"0".repeat(64), serde_json::to_value(band).unwrap());
    let refused = check(&rebuilt, &band).unwrap_err();
    assert!(refused.contains("not its receipt's"), "{refused}");
    // And a receipt that is not the directory's file, byte for byte.
    std::fs::write(&file, &good).unwrap();
    let stale = good.replace("4446186e", "a0775503");
    let refused = water_build(&band, &stale, &directory).unwrap_err();
    assert!(refused.contains("not the build receipt"), "{refused}");
    // A receipt in the withdrawn two-range layout does not parse.
    let legacy = receipt(
        &library_sha256,
        json!({"ranges":[{"pressure_low_pa":1e7,"pressure_high_pa":1.6e7}]}),
    );
    assert!(check(&legacy, &band).is_err());
    // And a missing receipt is refused.
    std::fs::remove_file(&file).unwrap();
    let refused = water_build(&band, &good, &directory).unwrap_err();
    assert!(refused.contains("water-build.json"), "{refused}");
    std::fs::remove_dir_all(&directory).unwrap();
}

/// y0' = -y0 (differential) and 0 = y1 + y1^3 - y0 (algebraic, nonlinear),
/// with its exact pencil: a stock-IDA fixture for H1's restart.
struct Cubic;
impl System for Cubic {
    fn dimension(&self) -> usize {
        2
    }
    fn nonzeros(&self) -> usize {
        3
    }
    fn root_count(&self) -> usize {
        0
    }
    fn roots(&mut self, _: f64, _: &[f64], _: &[f64], _: &mut [f64]) -> Result<(), Failure> {
        Ok(())
    }
    fn residual(&mut self, _: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        out[0] = yp[0] + y[0];
        out[1] = y[1] + y[1].powi(3) - y[0];
        Ok(())
    }
    fn jacobian(
        &mut self,
        _: f64,
        cj: f64,
        y: &[f64],
        _: &[f64],
        data: &mut [f64],
        rows: &mut [i64],
        pointers: &mut [i64],
    ) -> Result<(), Failure> {
        data.copy_from_slice(&[cj + 1., -1., 1. + 3. * y[1] * y[1]]);
        rows.copy_from_slice(&[0, 1, 1]);
        pointers.copy_from_slice(&[0, 2, 3]);
        Ok(())
    }
}
impl ConsistentSystem for Cubic {
    fn system_dimension(&self) -> usize {
        2
    }
    fn rows_at(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
    ) -> Result<Vec<f64>, leitbild_operating_plant::network::Failure> {
        let mut out = vec![0.; 2];
        self.residual(t, y, yp, &mut out)
            .expect("the fixture residual");
        Ok(out)
    }
    /// dF/dy and dF/dy', column-major.
    fn pencil_at(
        &mut self,
        _: f64,
        y: &[f64],
        _: &[f64],
    ) -> Result<(Vec<f64>, Vec<f64>), leitbild_operating_plant::network::Failure> {
        Ok((
            vec![1., -1., 0., 1. + 3. * y[1] * y[1]],
            vec![1., 0., 0., 0.],
        ))
    }
}

#[test]
fn the_window_end_restart_starts_exactly_and_continues_as_a_fresh_history() {
    let (rtol, atol, ids) = (1e-4, [1e-6; 2], [1., 0.]);
    let start = |time: f64, y: &[f64], yp: &[f64]| {
        let mut ida = Ida::new(
            Observed::new(Cubic, None),
            Initial {
                time,
                y,
                yp,
                differential: &ids,
                absolute_tolerance: &atol,
                relative_tolerance: rtol,
            },
        )
        .unwrap();
        ida.set_max_order(2).unwrap();
        ida.constrain_nonnegative(&[0]).unwrap();
        ida
    };
    // The run's exact consistent start at t = 0 (Cardano's root of
    // y^3 + y = 1), then the window: 20 ms cap, tightened coefficient,
    // forced stop at 0.5 s.
    let root = 1. / 2. + (1. / 4. + 1. / 27_f64).sqrt();
    let mut y = [1., root.cbrt() - (root - 1.).cbrt()];
    let weights = error_weights(&y, rtol, &atol);
    let (rates, _) = consistent_start(
        &mut Cubic,
        0.,
        &mut y,
        &ids,
        &weights,
        CONSISTENT_ROW_BOUND,
        2,
    )
    .unwrap();
    let mut yp = [rates[0], rates[1]];
    let mut ida = start(0., &y, &yp);
    ida.set_max_step(0.02).unwrap();
    ida.set_nonlinear_convergence_coefficient(0.033).unwrap();
    ida.stop_at(0.5).unwrap();
    let mut capped: f64 = 0.;
    for k in 1..=5 {
        let t = f64::from(k) / 10.;
        assert_eq!(
            ida.advance(t, &mut y, &mut yp).unwrap(),
            Advance::Reached(t)
        );
        capped = capped.max(ida.stats().unwrap().last_step);
    }
    let window = ida.stats().unwrap();
    assert!(
        capped <= 0.02 * (1. + 1e-12) && window.steps >= 25,
        "{window:?}"
    );
    // Stock's own pair there holds the differential row only to its BDF
    // rate error.
    let own = Cubic.rows_at(0.5, &y, &yp).unwrap();
    assert!(own[0].abs() > CONSISTENT_ROW_BOUND, "{own:?}");
    let segment = Segment {
        rtol,
        atol: &atol,
        differential: &ids,
        max_order: 2,
        nonnegative: &[0],
    };
    // A state outside the projection's guard (here an algebraic offset two
    // Newton passes remove, at a correction WRMS of about 4.6) is refused,
    // not repaired: the pair and stock's history are left as they were.
    let (mut off, mut off_rates) = ([y[0], y[1] + 3e-4], yp);
    let refused = restart(
        &mut ida,
        |s| &mut s.inner,
        0.5,
        &mut off,
        &mut off_rates,
        &segment,
        1.5,
    )
    .unwrap_err();
    assert!(
        refused.contains("exceeds the solver's error scale"),
        "{refused}"
    );
    assert_eq!((off, off_rates), ([y[0], y[1] + 3e-4], yp));
    assert_eq!(Counts::of(&ida.stats().unwrap()), Counts::of(&window));
    // H1's restart from the accepted state: the exact start's level, and
    // stock's counters restart there.
    let pair = restart(
        &mut ida,
        |s| &mut s.inner,
        0.5,
        &mut y,
        &mut yp,
        &segment,
        1.5,
    )
    .unwrap();
    assert!(
        pair.residual.value <= CONSISTENT_ROW_BOUND
            && pair.constraint_rate.value <= CONSISTENT_ROW_BOUND,
        "{pair:?}"
    );
    // The projection starts from stock's accepted state, whose algebraic
    // row holds only to its Newton tolerance, and stays within its guard.
    let projection = pair.projection.as_ref().expect("projection");
    assert_eq!(projection.before.value, own[1].abs(), "{pair:?}");
    assert!(projection.after.value <= CONSISTENT_ROW_BOUND, "{pair:?}");
    assert!(projection.correction_wrms <= 1., "{pair:?}");
    let rows = Cubic.rows_at(0.5, &y, &yp).unwrap();
    assert!(
        rows.iter().all(|r| r.abs() <= CONSISTENT_ROW_BOUND),
        "restart pair {rows:?}; stock's own pair at the forced stop {own:?}"
    );
    let restarted = ida.stats().unwrap();
    assert_eq!((restarted.steps, restarted.internal_time), (0, 0.5));
    // A fresh handle at the restart pair with stock's coefficient and no
    // cap: the continuation is that same history, counted alone.
    let mut fresh = start(0.5, &y, &yp);
    fresh.stop_at(1.5).unwrap();
    let (mut fy, mut fyp) = (y, yp);
    let mut longest: f64 = 0.;
    for k in 6..=15 {
        let t = f64::from(k) / 10.;
        assert_eq!(
            ida.advance(t, &mut y, &mut yp).unwrap(),
            Advance::Reached(t)
        );
        assert_eq!(
            fresh.advance(t, &mut fy, &mut fyp).unwrap(),
            Advance::Reached(t)
        );
        longest = longest.max(ida.stats().unwrap().last_step);
        assert!((y[0] - (-t).exp()).abs() < 1e-3, "y0({t}) = {}", y[0]);
        // Interpolated outputs hold the constraint to the error scale.
        assert!((y[1] + y[1].powi(3) - y[0]).abs() < rtol, "{y:?}");
    }
    let (continued, independent) = (ida.stats().unwrap(), fresh.stats().unwrap());
    assert!(longest > 0.02, "the cap ended with the window: {longest}");
    assert!(continued.steps > 0, "{continued:?}");
    assert_eq!(Counts::of(&continued), Counts::of(&independent));
    assert_eq!(
        (continued.last_step, continued.last_order),
        (independent.last_step, independent.last_order)
    );
    assert_eq!(y.map(f64::to_bits), fy.map(f64::to_bits));
}
