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
//! rtol/100 references and continued 10 s uncapped (request 2, E0-E4).
//! Credited outputs are observed every 0.002 s through one stock IDA root
//! function, which changes no step, and are compared after the contract's
//! zero-phase low-pass. A decisive failure stops dependent runs and is
//! reported.
#![cfg(all(feature = "ida", target_os = "macos"))]
use leitbild_operating_plant::{
    network::{
        Band, ConsistentPair, CscOut, Network, Properties, PzrPreparation, RotorState,
        ToleranceClasses, consistent_start,
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
use std::{cell::Cell as Slot, f64::consts::PI, rc::Rc, time::Instant};

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
/// The 1-, 5- and 15-minute load averages (`vm.loadavg`), recorded at the
/// receipt's start and end for the declared CPU measurement hygiene.
fn load_average() -> String {
    std::process::Command::new("sysctl")
        .args(["-n", "vm.loadavg"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .expect("load average")
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
/// content above the credited band.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct EventReference {
    #[serde(rename = "maxStep_s")]
    max_step_s: f64,
    second_refinement_tolerance_factor: f64,
    cap_cycle_uncredited_rms_ratio_max: f64,
}
/// E0/E1: the filter and observation interval of the contract's comparison.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Comparison {
    filter: String,
    #[serde(rename = "observation_s")]
    observation_s: f64,
}
/// E4: the uncapped continuation after each event window.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Recovery {
    #[serde(rename = "postWindow_s")]
    post_window_s: f64,
    max_step_rate_factor: f64,
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

/// The filter the harness implements; the declared block must name it.
const DECLARED_FILTER: &str = "zero-phase 4th-order Butterworth";
/// Stock IDA's Newton convergence coefficient (SUNDIALS 7.5.0 `ida.c`
/// EPCON), which the event window tightens by `newtonCoefficientFactor`.
/// Stock reads it only before its first step, so the window's value also
/// holds through the uncapped continuation (S1 declaration, E4).
const STOCK_NEWTON_COEFFICIENT: f64 = 0.33;

/// `span` is a whole number, at least one, of `unit`s, to rounding.
fn whole(span: f64, unit: f64) -> bool {
    let n = (span / unit).round();
    n >= 1. && (n * unit - span).abs() <= 1e-9 * span
}
impl Gates {
    /// Checks of the declared configuration before any run: the block names
    /// the implemented filter; the observation interval divides the output
    /// interval, which divides every timed span; both event windows lie
    /// within E2's budget window; the projected full-unit step is below E2's
    /// exit; and the credited band lies below the observation's Nyquist
    /// frequency and the spectral fast-mode limit.
    fn check(&self, budgets: &Budgets) {
        assert_eq!(
            self.comparison.filter, DECLARED_FILTER,
            "undeclared comparison filter"
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
                window <= self.event_window.max_window_s,
                "a {window} s event window exceeds E2's {} s",
                self.event_window.max_window_s
            );
        }
        assert!(
            self.projected_full_unit_step_s <= self.event_window.full_unit_step_exit_s,
            "the projected full-unit step reaches E2's exit: E2 returns to the owner"
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
    /// E2's window budget in steps: budget x window / projected full-unit step.
    fn window_steps(&self, window_s: f64) -> f64 {
        self.event_window.budget_cpu_s_per_s * window_s / self.projected_full_unit_step_s
    }
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

/// Delegates every stock-IDA callback unchanged and, when observing,
/// declares one root function g = t - next. Stock IDA locates its zeros on
/// its own interpolant after each step and returns there, so observing
/// changes no step, order, Newton iteration or Jacobian.
struct Observed<S> {
    inner: S,
    next: Option<Rc<Slot<f64>>>,
}
impl<S: System> Observed<S> {
    fn new(inner: S, next: Option<Rc<Slot<f64>>>) -> Self {
        assert_eq!(
            inner.root_count(),
            0,
            "the observed system declares roots of its own"
        );
        Self { inner, next }
    }
}
impl<S: System> System for Observed<S> {
    fn dimension(&self) -> usize {
        self.inner.dimension()
    }
    fn nonzeros(&self) -> usize {
        self.inner.nonzeros()
    }
    fn root_count(&self) -> usize {
        usize::from(self.next.is_some())
    }
    fn residual(
        &mut self,
        time: f64,
        y: &[f64],
        yp: &[f64],
        out: &mut [f64],
    ) -> Result<(), Failure> {
        self.inner.residual(time, y, yp, out)
    }
    fn jacobian(
        &mut self,
        time: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        data: &mut [f64],
        rows: &mut [i64],
        pointers: &mut [i64],
    ) -> Result<(), Failure> {
        self.inner.jacobian(time, cj, y, yp, data, rows, pointers)
    }
    fn roots(&mut self, time: f64, _: &[f64], _: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        match &self.next {
            Some(next) => {
                out.fill(time - next.get());
                Ok(())
            }
            None => Err(Failure::Fatal(
                "root evaluation without an observation clock".into(),
            )),
        }
    }
}
/// Fine observation times j*dt over [0, window], skipping the output grid
/// that `advance` targets reach; `next` is the root function's time.
struct Clock {
    next: Rc<Slot<f64>>,
    dt: f64,
    per_output: usize,
    /// Index of the window's end; observations by root lie below it.
    end: usize,
    /// A time past the run's end, never reached.
    never: f64,
    j: usize,
}
impl Clock {
    fn new(dt: f64, output_s: f64, window_s: f64, never: f64) -> Self {
        assert!(
            whole(output_s, dt) && output_s / dt >= 2. && whole(window_s, output_s),
            "fine observation grid: {dt} s within {output_s} s outputs over {window_s} s"
        );
        Self {
            next: Rc::new(Slot::new(never)),
            dt,
            per_output: (output_s / dt).round() as usize,
            end: (window_s / dt).round() as usize,
            never,
            j: 0,
        }
    }
    /// Arm the next observation strictly inside an output interval.
    fn arm(&mut self) {
        self.j += 1;
        while self.j.is_multiple_of(self.per_output) {
            self.j += 1;
        }
        self.next.set(if self.j < self.end {
            self.j as f64 * self.dt
        } else {
            self.never
        });
    }
}

/// Stock counters at one point of a run.
#[derive(Clone, Copy, Debug, Default)]
struct Counts {
    steps: i64,
    residuals: i64,
    jacobians: i64,
    nonlinear_iterations: i64,
    error_failures: i64,
    convergence_failures: i64,
    linear_setups: i64,
}
impl Counts {
    fn of(s: &Stats) -> Self {
        Self {
            steps: s.steps,
            residuals: s.residuals,
            jacobians: s.jacobians,
            nonlinear_iterations: s.nonlinear_iterations,
            error_failures: s.error_failures,
            convergence_failures: s.convergence_failures,
            linear_setups: s.linear_setups,
        }
    }
    /// The counts accumulated after `earlier` in the same history.
    fn since(self, earlier: Self) -> Self {
        Self {
            steps: self.steps - earlier.steps,
            residuals: self.residuals - earlier.residuals,
            jacobians: self.jacobians - earlier.jacobians,
            nonlinear_iterations: self.nonlinear_iterations - earlier.nonlinear_iterations,
            error_failures: self.error_failures - earlier.error_failures,
            convergence_failures: self.convergence_failures - earlier.convergence_failures,
            linear_setups: self.linear_setups - earlier.linear_setups,
        }
    }
    fn json(self) -> Value {
        json!({"steps":self.steps,"residuals":self.residuals,"jacobians":self.jacobians,"nonlinear_iterations":self.nonlinear_iterations,"error_failures":self.error_failures,"convergence_failures":self.convergence_failures,"linear_setups":self.linear_setups})
    }
}

/// Fine observation of a run's window on a probe network configured as the
/// run's own network (same packet, rotor states and event).
struct Observation {
    probe: Network<If97>,
    interval_s: f64,
}
/// E4: the same history continued after the window, with the step bound
/// removed; its step cap applies to the continuation's own steps.
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
    /// IDASetMaxStep over the window; +inf leaves stock unbounded.
    max_step_s: f64,
    /// IDASetNonlinConvCoef for the whole history; `None` keeps stock's.
    newton_coefficient: Option<f64>,
    observation: Option<Observation>,
    continuation: Option<Continuation>,
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
    total: Counts,
    /// Counts when the window's end was reached.
    window: Option<Counts>,
    cpu_s: f64,
    solver_cpu_s: f64,
    observation_cpu_s: f64,
    evaluation_wall_s: f64,
    jacobian_wall_s: f64,
    /// The run's exact consistent-rate solve at its start (no IDACalcIC).
    initial_pair: Option<ConsistentPair>,
    failure: Option<String>,
    rtol: f64,
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

/// Advance one declared run from a prepared, settled or event-changed state.
/// Its start projects the algebraic coordinates onto the constraints within
/// the run's own error weights (a bitwise no-op on an exact state) and then
/// solves the exact consistent rates, at t = 0 and every event alike;
/// IDACalcIC is never called. The window ends at a forced stop; a declared
/// continuation then removes the step bound and continues the same history
/// (no reinitialization, no new start) to its own end.
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
    } = spec;
    let started = cpu_s();
    let mut y = y0.to_vec();
    let weights: Vec<f64> = y0
        .iter()
        .zip(atol)
        .map(|(v, a)| 1. / (rtol * v.abs() + a))
        .collect();
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
    let end_s = duration_s + continuation.as_ref().map_or(0., |c| c.duration_s);
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
    let mut k = 1;
    while failure.is_none() {
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
                s.steps = stats.steps;
                s.last_step = stats.last_step;
                if in_window && clock.is_some() {
                    fine.push(s.credited());
                }
                let (counted, cap, phase) = match window {
                    None => (stats.steps, step_cap, "run"),
                    Some(w) => (
                        stats.steps - w.steps,
                        continuation.as_ref().map_or(i64::MAX, |c| c.step_cap),
                        "recovery",
                    ),
                };
                failure = frozen_rule(&s, taps, admitted_atol, blocked_path_limit_m3_s)
                    .or_else(|| {
                        (counted > cap).then(|| format!("{phase} cap reached: {counted} steps"))
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
                    // E4: the cap lifts at the window's end and the same
                    // history continues to the continuation's end.
                    if let Err(e) = ida.remove_max_step().and_then(|()| ida.stop_at(end_s)) {
                        failure = Some(format!("window end at t={t}: {e}"));
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
    Run {
        samples,
        fine,
        y,
        yp,
        total: Counts::of(&stats),
        window,
        cpu_s: cpu,
        solver_cpu_s: cpu - diagnostic_cpu - observation_cpu,
        observation_cpu_s: observation_cpu,
        evaluation_wall_s: network.counters.evaluation_wall_s,
        jacobian_wall_s: network.counters.jacobian_wall_s,
        initial_pair,
        failure,
        rtol,
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
    json!({"configuration":{"rtol":run.rtol,"max_step_s":run.max_step_s.is_finite().then_some(run.max_step_s),"newton_coefficient":run.newton_coefficient.unwrap_or(STOCK_NEWTON_COEFFICIENT),"window_s":run.duration_s,"end_s":run.end_s},
        "initial_pair":run.initial_pair,"pzr":pzr,
        "steps":run.total.steps,"residuals":run.total.residuals,"jacobians":run.total.jacobians,"error_failures":run.total.error_failures,"convergence_failures":run.total.convergence_failures,
        "counts":run.total.json(),"window_counts":run.window.map(Counts::json),"recovery_counts":run.window.filter(|_| continued).map(|w| run.total.since(w).json()),
        "observations":run.fine.len(),"cpu_s":run.cpu_s,"solver_cpu_s":run.solver_cpu_s,"observation_cpu_s":run.observation_cpu_s,"evaluation_wall_s":run.evaluation_wall_s,"jacobian_wall_s":run.jacobian_wall_s,
        "steps_per_simulated_s":run.total.steps as f64/reached,"solver_cpu_s_per_simulated_s":run.solver_cpu_s/reached,
        "max_identity_relative":identity,"reached_s":reached,"failure":run.failure})
}

// ---- The contract's comparison (E0, E1) and the E3 checks. ----
fn mean(v: &[f64]) -> f64 {
    v.iter().sum::<f64>() / v.len() as f64
}
/// Population standard deviation.
fn deviation(v: &[f64]) -> f64 {
    let m = mean(v);
    (v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / v.len() as f64).sqrt()
}
fn rms(v: &[f64]) -> f64 {
    (v.iter().map(|x| x * x).sum::<f64>() / v.len() as f64).sqrt()
}
/// The larger value; a NaN propagates rather than vanishing in a max.
fn larger(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}
fn max_abs(v: &[f64]) -> f64 {
    v.iter().fold(0., |m, x| larger(m, x.abs()))
}
/// Fourth-order Butterworth low-pass at `cutoff_hz` for samples every `dt`
/// s: two bilinear biquads prewarped at the cutoff, each [b0, b1, b2, a1, a2].
fn butterworth(cutoff_hz: f64, dt: f64) -> [[f64; 5]; 2] {
    let (s, c) = (2. * PI * cutoff_hz * dt).sin_cos();
    [
        1. / (2. * (PI / 8.).cos()),
        1. / (2. * (3. * PI / 8.).cos()),
    ]
    .map(|q| {
        let alpha = s / (2. * q);
        let a0 = 1. + alpha;
        [
            (1. - c) / 2. / a0,
            (1. - c) / a0,
            (1. - c) / 2. / a0,
            -2. * c / a0,
            (1. - alpha) / a0,
        ]
    })
}
/// The cascade in transposed direct form II, each section started in its
/// steady state for its first input (unit DC gain).
fn cascade(x: &mut [f64], sections: &[[f64; 5]; 2]) {
    for &[b0, b1, b2, a1, a2] in sections {
        let first = x[0];
        let mut z2 = (b2 - a2) * first;
        let mut z1 = (b1 - a1) * first + z2;
        for v in x.iter_mut() {
            let input = *v;
            let out = b0 * input + z1;
            z1 = b1 * input - a1 * out + z2;
            z2 = b2 * input - a2 * out;
            *v = out;
        }
    }
}
/// Odd-reflection padding at each end, 5/cutoff s: about 12 e-folds of the
/// slowest pole, whose decay rate is 2 pi f_c sin(pi/8).
fn padding_s(cutoff_hz: f64) -> f64 {
    5. / cutoff_hz
}
/// The declared zero-phase 4th-order Butterworth low-pass of samples every
/// `dt` s: the cascade forward, then backward (|H|^2, -6 dB at the cutoff),
/// over odd reflection padding at both ends.
fn zero_phase_lowpass(x: &[f64], cutoff_hz: f64, dt: f64) -> Vec<f64> {
    let n = x.len();
    assert!(n >= 2, "a filtered series needs two observations");
    let pad = ((padding_s(cutoff_hz) / dt).round() as usize).min(n - 1);
    let sections = butterworth(cutoff_hz, dt);
    let mut ext: Vec<f64> = (1..=pad).rev().map(|i| 2. * x[0] - x[i]).collect();
    ext.extend_from_slice(x);
    ext.extend((1..=pad).map(|i| 2. * x[n - 1] - x[n - 1 - i]));
    cascade(&mut ext, &sections);
    ext.reverse();
    cascade(&mut ext, &sections);
    ext.reverse();
    ext[pad..pad + n].to_vec()
}
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
/// E3's cap-cycle check: the RMS over the window of each credited output's
/// own content above the credited band, x - lowpass(x), in core DP, both
/// loop flows and roof pressure, may not exceed `ratio_max` times R1's.
fn cap_cycle(
    run: &Run,
    r1: &Run,
    window_s: f64,
    dt: f64,
    cutoff_hz: f64,
    ratio_max: f64,
) -> (Value, bool) {
    let names = ["core_dp_pa", "loop_a_kg_s", "loop_b_kg_s", "pzr_roof_pa"];
    let content = |r: &Run| -> Result<[f64; 4], String> {
        let s = window_series(r, window_s, dt)?;
        let above = |pick: &dyn Fn(&Credited) -> f64| {
            // Relative to the first value: the filter is linear with unit DC
            // gain, so the content is unchanged and rounding stays small.
            let x: Vec<f64> = s.iter().map(|c| pick(c) - pick(&s[0])).collect();
            let low = zero_phase_lowpass(&x, cutoff_hz, dt);
            rms(&x.iter().zip(&low).map(|(a, b)| a - b).collect::<Vec<_>>())
        };
        Ok([
            above(&|c| c.core_dp_pa),
            above(&|c| c.loop_kg_s[0]),
            above(&|c| c.loop_kg_s[1]),
            above(&|c| c.roof_pa),
        ])
    };
    match (content(run), content(r1)) {
        (Ok(a), Ok(b)) => {
            let pass = a.iter().zip(&b).all(|(x, y)| *x <= ratio_max * *y);
            let outputs: serde_json::Map<String, Value> = names
                .iter()
                .zip(a.iter().zip(&b))
                .map(|(n, (x, y))| (n.to_string(), json!({"run_rms":x,"r1_rms":y,"ratio":x / y})))
                .collect();
            (
                json!({"cutoff_hz":cutoff_hz,"window_s":window_s,"ratio_max":ratio_max,"outputs":outputs,"pass":pass}),
                pass,
            )
        }
        (a, b) => (
            json!({"evaluable":false,"run":a.err(),"r1":b.err(),"pass":false}),
            false,
        ),
    }
}

/// One declared event from its event-changed state (E2-E4): the window run
/// (20 ms cap, tightened Newton coefficient), continued uncapped through the
/// recovery interval; R1, the same run capped at 2.5 ms; R2, BDF2 at the
/// second refinement's tolerances with no cap and stock's coefficient. Over
/// the window, credited outputs must agree with both within the contract.
#[allow(clippy::too_many_arguments)] // The event's own state plus the declared owners.
fn event_case(
    event: &dyn Fn() -> (Network<If97>, Vec<f64>, Vec<f64>),
    taps: &Taps,
    atol: &[f64],
    gates: &Gates,
    budgets: &Budgets,
    window_s: f64,
    post_window_s: f64,
    quiet_rate: Option<f64>,
) -> (Value, bool, [Run; 3]) {
    let (ew, er) = (&gates.event_window, &gates.event_reference);
    let (dt, output, cutoff) = (
        gates.comparison.observation_s,
        gates.output_interval_s,
        budgets.uncredited_above_hz,
    );
    let rtol = gates.relative_tolerance;
    let tight = STOCK_NEWTON_COEFFICIENT * ew.newton_coefficient_factor;
    let allowed = gates.window_steps(window_s);
    let window_cap = (gates.run_cap_factor * allowed) as i64;
    let recovery_limit = quiet_rate.map(|r| gates.recovery.max_step_rate_factor * r);
    let recovery_cap = recovery_limit.map_or(i64::MAX, |r| {
        (gates.run_cap_factor * r * post_window_s) as i64
    });
    let never = |_: &[Sample]| false;
    // The window run (E2), continued uncapped (E4).
    let (network, y, ids) = event();
    let mut s = spec(gates, window_s, rtol, atol, window_cap);
    s.max_step_s = ew.max_step_s;
    s.newton_coefficient = Some(tight);
    s.continuation = Some(Continuation {
        duration_s: post_window_s,
        step_cap: recovery_cap,
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
    let vs_r1 = compare(&run, &r1, window_s, dt, output, cutoff);
    let vs_r2 = compare(&run, &r2, window_s, dt, output, cutoff);
    let r1_vs_r2 = compare(&r1, &r2, window_s, dt, output, cutoff);
    let (within_r1, within_r2) = (within(&vs_r1, budgets), within(&vs_r2, budgets));
    let (cap_cycle, cap_cycle_pass) = cap_cycle(
        &run,
        &r1,
        window_s,
        dt,
        cutoff,
        er.cap_cycle_uncredited_rms_ratio_max,
    );
    // E2: the window's steps at the projected full-unit step.
    let window_steps = run.window.map(|c| c.steps);
    let projected = window_steps.map(|n| n as f64 * gates.projected_full_unit_step_s / window_s);
    let budget_pass = projected.is_some_and(|p| p <= ew.budget_cpu_s_per_s);
    // E4: the continuation's step rate against the quiet-hold rate.
    let reached = run.samples.last().map_or(0., |s| s.t);
    let recovery = run.window.map(|w| run.total.since(w));
    let recovery_rate = recovery.map(|c| c.steps as f64 / post_window_s);
    let recovery_pass = run.failure.is_none()
        && reached >= window_s + post_window_s
        && matches!((recovery_rate, recovery_limit), (Some(r), Some(l)) if r <= l);
    let pass = run.failure.is_none()
        && r1.failure.is_none()
        && r2.failure.is_none()
        && budget_pass
        && within_r1
        && within_r2
        && cap_cycle_pass
        && recovery_pass;
    let receipt = json!({"window_s":window_s,"post_window_s":post_window_s,
        "configuration":{"window":{"max_step_s":ew.max_step_s,"newton_coefficient":tight,"stock_newton_coefficient":STOCK_NEWTON_COEFFICIENT,"newton_coefficient_factor":ew.newton_coefficient_factor},
            "recovery":{"max_step_s":null,"newton_coefficient":tight,"continuation":"one IDA history: the bound is removed at the window's forced stop, with no reinitialization and no new consistent start; stock reads the Newton coefficient only before its first step"},
            "r1":{"rtol":rtol,"atol_factor":1.,"max_step_s":er.max_step_s,"newton_coefficient":tight,"max_order":gates.max_order},
            "r2":{"rtol":rtol*f,"atol_factor":f,"max_step_s":null,"newton_coefficient":STOCK_NEWTON_COEFFICIENT,"max_order":gates.max_order}},
        "run":run_json(&run),"r1_capped":run_json(&r1),"r2_refined":run_json(&r2),
        "window_budget":{"steps":window_steps,"allowed_steps":allowed,"run_cap_steps":window_cap,"projected_full_unit_step_s":gates.projected_full_unit_step_s,"projected_cpu_s_per_s":projected,"budget_cpu_s_per_s":ew.budget_cpu_s_per_s,"pass":budget_pass},
        "versus_r1":vs_r1,"versus_r2":vs_r2,"r1_versus_r2":r1_vs_r2,"within_r1":within_r1,"within_r2":within_r2,
        "convergence_ratio":convergence_ratio(&vs_r1,&r1_vs_r2),
        "cap_cycle":cap_cycle,
        "recovery":{"post_window_s":post_window_s,"counts":recovery.map(Counts::json),"steps_per_s":recovery_rate,"quiet_hold_steps_per_s":quiet_rate,"max_step_rate_factor":gates.recovery.max_step_rate_factor,"max_steps_per_s":recovery_limit,"run_cap_steps":recovery_cap,"reached_s":reached,"pass":recovery_pass},
        "pass":pass});
    (receipt, pass, [run, r1, r2])
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
    let dt = gates.comparison.observation_s;
    let cutoff = budgets.uncredited_above_hz;
    let mut receipt = json!({"kind":"s1-hydraulics-admission","declaration":"S1 re-declared under owner decision request 2 (E0-E4) before the single re-run","packet":packet_path,"packet_sha256":packet_sha256,"app_commit":git(&["rev-parse","HEAD"]),"app_worktree_dirty":!git(&["status","--porcelain"]).is_empty(),"wiki":wiki,"wiki_commit":git(&["-C",wiki.as_str(),"rev-parse","HEAD"]),"wiki_worktree_dirty":!git(&["-C",wiki.as_str(),"status","--porcelain"]).is_empty(),"gates":format!("{gates:?}"),"budgets":format!("{budgets:?}"),"load_average_start":load_start,
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
    // The quiet-hold rate exists only for a hold that reached its end.
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
    // RCP supply loss and seizure (E2-E4).
    let (trip, trip_pass, trip_runs) = event_case(
        &supplied,
        &taps,
        &atol,
        &gates,
        &budgets,
        gates.supply_loss.duration_s,
        gates.recovery.post_window_s,
        quiet_rate,
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
        quiet_rate,
    );
    ok &= seize_pass;
    cases.insert("rcp_seizure".into(), seize);

    // 5. Joint cost check and conservation identity across every run.
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
/// of the declared RCP start, then the declared event pipeline (E0-E4) on a
/// short window from that spin-up state, to exercise its code before the
/// gate run. The pipeline's values here judge nothing.
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
        json!({"kind":"s1-harness-smoke-NOT-EVIDENCE","packet":packet_path,"preparation_passes":preparation.pass_changes_pa.len(),"max_eos_row":preparation.max_eos_row,"max_loop_rest_pa":preparation.max_loop_rest_pa,"max_phase_drive_pa":preparation.max_phase_drive_pa,"mass_change_kg":preparation.mass_change_kg,"run":run_json(&run),"samples":run.samples.iter().map(|s|json!({"t":s.t,"roof_pa":s.roof_pa,"loop_kg_s":s.loop_kg_s,"omega":s.omega,"steps":s.steps,"h":s.last_step,"energy_identity_w":s.energy_identity_w,"blocked_path_m3_s":s.blocked_path_m3_s})).collect::<Vec<_>>()})
    );
    assert!(run.failure.is_none(), "{:?}", run.failure);
    let from = || (fresh(&packet), run.y.clone(), prepared.differential.clone());
    let (case, _, runs) = event_case(&from, &taps, &atol, &gates, &budgets, 0.5, 0.5, None);
    println!(
        "{}",
        json!({"kind":"s1-harness-smoke-event-pipeline-NOT-EVIDENCE","from_t_s":run.samples.last().map(|s|s.t),"case":case})
    );
    for r in &runs {
        assert!(r.failure.is_none(), "{:?}", r.failure);
        assert_eq!(r.fine.len(), 251, "observations over the 0.5 s window");
    }
    assert!(case["versus_r1"]["evaluable"].as_bool() == Some(true));
    assert!(case["recovery"]["counts"]["steps"].as_i64() > Some(0));
}

/// Zero-time check of the declared configuration, NOT S1 evidence: the
/// gates block parses into exactly its fields and passes the declared
/// checks; the derived window budgets and caps are printed.
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
        let allowed = gates.window_steps(window);
        json!({"window_s":window,"allowed_steps":allowed,"run_cap_steps":(gates.run_cap_factor*allowed) as i64,"observations":(window/gates.comparison.observation_s).round()+1.})
    };
    println!(
        "{}",
        json!({"kind":"s1-declared-gates-NOT-EVIDENCE","wiki":wiki,"cutoff_hz":budgets.uncredited_above_hz,"padding_s":padding_s(budgets.uncredited_above_hz),
            "window_newton_coefficient":STOCK_NEWTON_COEFFICIENT*gates.event_window.newton_coefficient_factor,
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
    let (report, pass) = cap_cycle(&make(30.), &r1, window, dt, 2., 2.);
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
    assert!((report["outputs"]["pzr_roof_pa"]["ratio"].as_f64().unwrap() - 1.).abs() < 1e-9);
    // An output without content in either run passes with no ratio.
    assert!(
        report["outputs"]["loop_b_kg_s"]["ratio"].is_null(),
        "{report}"
    );
    let (report, pass) = cap_cycle(&make(50.), &r1, window, dt, 2., 2.);
    assert!(!pass, "{report}");
}
