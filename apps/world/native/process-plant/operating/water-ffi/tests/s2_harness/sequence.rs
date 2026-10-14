//! The declared S2 sequence and its receipt (revision 7, "Work bound and
//! caps": S1 run 6; composed receipts; settle; settled receipts; hold and
//! its reference; trip with R0, R1 and R2; contrary cases), and the M4
//! smoke on the same machinery.
//!
//! - A **gate run** refuses before any work unless `ld01-s2-gates` is pinned
//!   and no TBD is open ([`super::guards`]), S1 run 6's receipt passes at
//!   this app commit (the hook, `LD01_S2_S1_RUN6_RECEIPT`), and every
//!   external zero-time receipt is named (`LD01_S2_ZERO_TIME_RECEIPTS`, a
//!   JSON object `{"Z2": path, …}` of the other lanes' receipts, each
//!   recorded with its SHA-256 and CPU). Every run is pre-checked against the
//!   remaining work bound; one that does not fit is not started and S2 is
//!   incomplete. Caps are the declared ones, enforced.
//! - A **smoke run** (NOT evidence) runs a short hold and trip from a saved
//!   settled state through the same runner, comparisons and gate formulas,
//!   with every cap reported only and every gate entry `judged: false`, and
//!   writes the full receipt schema.
use super::{
    compare::{
        self, Budgets, Credited, compare_timing, drift, drift_ceilings, insertion_times, key,
        settle_cap_fit, settled, settling_quantities, travel_difference,
    },
    compose::{self, Composed, Settled},
    gates::Declaration,
    guards::{self, Admission, WorkBound},
    outputs::{Reader, admit, extension},
    receipt::{self, gate},
    run::RunSpec,
    runner::{Run, Start, advance},
};
use crate::{
    cpu,
    filter::{CAP_CYCLE_RULE, EXCESS_SPECTRUM_METHOD, cap_cycle_output, content_above_band},
    provenance::{WATER_BUILD, WATER_LIB_DIR, git_provenance, water_build},
};
use leitbild_operating_plant::{
    joined::{block::Command, post_trip_domain::Extension},
    network::{MetastableBand, packet::Packet as NetworkPacket},
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode {
    Smoke,
    Gate,
}

/// Everything one sequence shares.
pub struct Harness {
    pub mode: Mode,
    pub d: Declaration,
    pub budgets: Budgets,
    pub extension: Extension,
    pub extension_source: Value,
    pub packet: compose::PacketFile,
    pub network_packet: NetworkPacket,
    pub reference_travel_m: f64,
    settled_flows: Option<Settled>,
    reader: Option<Reader>,
    pub work: WorkBound,
    pub sequence: Vec<Value>,
    pub runs: BTreeMap<String, Value>,
    pub work_runs: BTreeMap<String, Value>,
    process0: f64,
    wall: std::time::Instant,
    load_start: String,
}

impl Harness {
    pub fn new(mode: Mode) -> Result<Self, String> {
        let process0 = cpu::process_cpu_s();
        cpu::prefer_performance_core();
        let d = Declaration::load()?;
        let budgets = Budgets::from(&d)?;
        let packet = compose::packet_file();
        let raw: Value = serde_json::from_slice(&packet.bytes).map_err(|e| e.to_string())?;
        let network_packet: NetworkPacket =
            serde_json::from_slice(&packet.bytes).map_err(|e| e.to_string())?;
        let (extension, extension_source) = extension(&raw)?;
        let reference_travel_m = raw["rods"]["reference_travel_m"]
            .as_f64()
            .ok_or("the packet's rods section has no reference_travel_m")?;
        let work = WorkBound::new(&d.gates);
        Ok(Self {
            mode,
            d,
            budgets,
            extension,
            extension_source,
            packet,
            network_packet,
            reference_travel_m,
            settled_flows: None,
            reader: None,
            work,
            sequence: Vec::new(),
            runs: BTreeMap::new(),
            work_runs: BTreeMap::new(),
            process0,
            wall: std::time::Instant::now(),
            load_start: cpu::load_average(),
        })
    }

    /// A fresh composition, step (A)'s export (S1's network-only settling)
    /// computed once; every composition's CPU is charged to the work bound.
    pub fn compose(&mut self, item: &str) -> Composed {
        if self.settled_flows.is_none() {
            let started = cpu::process_cpu_s();
            self.settled_flows = Some(compose::s1_settled_flows(
                &self.network_packet,
                &self.d.shared,
            ));
            self.work.charge(
                "step (A): S1's network-only settling export",
                cpu::process_cpu_s() - started,
            );
        }
        let c = compose::compose_from(&self.d.shared, self.settled_flows.as_ref());
        if self.reader.is_none() {
            self.reader = Some(
                Reader::new(&c.joined, &self.network_packet, self.reference_travel_m)
                    .expect("credited output reader"),
            );
        }
        self.work
            .charge(&format!("composition for {item}"), c.cpu_s);
        c
    }

    pub fn reader(&self) -> &Reader {
        self.reader.as_ref().expect("a composition made the reader")
    }

    /// One declared run's spec at `duration_s` (the declared duration in a
    /// gate run; the smoke's own in a smoke).
    pub fn spec(&self, name: &str, duration_s: f64) -> Result<RunSpec, String> {
        let g = &self.d.gates;
        let s = &self.d.shared;
        let contract_rtol = s.number("/relativeTolerance");
        let factor = g.number("/referenceToleranceFactor");
        let smoke = self.mode == Mode::Smoke;
        let mut spec = RunSpec {
            name: name.to_string(),
            duration_s,
            window_s: duration_s,
            rtol: contract_rtol,
            atol_factor: 1.,
            max_step_s: None,
            newton_coefficient: g.number("/newtonCoefficient"),
            delta_cj_lsetup: g.number("/deltaCjLSetup"),
            first_step_s: g.number("/restartInitialStep_s"),
            max_order: g.count("/maxOrder") as usize,
            output_s: g.number("/outputInterval_s"),
            observation_s: Some(g.number("/observationInterval_s")),
            commands: Vec::new(),
            solver_cap_s: f64::INFINITY,
            total_guard_s: f64::INFINITY,
            report_only_step_cap: None,
            caps_report_only: smoke,
            rods_observed: false,
        };
        let window = g.number("/trip/window_s").min(duration_s);
        let trip = |spec: &mut RunSpec| {
            spec.commands = vec![(0., Command::TurbineTrip)];
            spec.rods_observed = true;
        };
        match name {
            "settle" | "resettle" => spec.observation_s = None,
            "hold" => {}
            "holdReference" => {
                spec.rtol = contract_rtol * factor;
                spec.atol_factor = factor;
            }
            "trip" => {
                trip(&mut spec);
                spec.window_s = window;
                spec.max_step_s = Some(s.number("/eventWindow/maxStep_s"));
            }
            "R1" => {
                trip(&mut spec);
                spec.max_step_s = Some(s.number("/eventReference/maxStep_s"));
            }
            "R2" => {
                trip(&mut spec);
                let f = s.number("/eventReference/secondRefinementToleranceFactor");
                spec.rtol = contract_rtol * f;
                spec.atol_factor = f;
            }
            "R0" => {
                trip(&mut spec);
                spec.caps_report_only = true;
                spec.report_only_step_cap = Some(g.count("/r0ReportOnly/stepCap") as i64);
            }
            "noTurbineTrip" => {
                spec.commands = vec![(0., Command::ManualReactorTrip)];
                spec.observation_s = None;
            }
            other => return Err(format!("{other} is not a run this model can execute")),
        }
        // Caps: the declared ones in a gate run; in a smoke, 2 x the
        // budget over the smoke's span where a budget exists, reported only.
        let samples = spec
            .observation_s
            .map_or(duration_s / spec.output_s, |dt| duration_s / dt);
        if smoke {
            if let Some(b) = guards::budget_s(g, name, duration_s) {
                spec.solver_cap_s = 2. * b;
            }
        } else {
            let declared_span = match name {
                "hold" | "holdReference" => g.number("/hold/duration_s"),
                "trip" | "R2" => g.number("/trip/duration_s"),
                "R1" => g.number("/trip/window_s"),
                "R0" => g.number("/trip/window_s") + s.number("/recovery/postWindow_s"),
                _ => duration_s,
            };
            let cap = guards::declared_cap(g, name, declared_span)?;
            spec.solver_cap_s = cap["cap_s"].as_f64().unwrap();
            spec.total_guard_s = guards::total_guard(g, spec.solver_cap_s, samples)?;
            if name == "R0" && !g.flag("/r0ReportOnly/cpuCap") {
                spec.caps_report_only = false;
            }
        }
        Ok(spec)
    }

    /// Pre-check, compose, run, charge.
    pub fn run(
        &mut self,
        spec: &RunSpec,
        start: &Start,
        settled_check: Option<&mut dyn FnMut(&Credited) -> bool>,
    ) -> Option<Run> {
        let guard = if spec.total_guard_s.is_finite() {
            spec.total_guard_s
        } else {
            std::env::var("LD01_S2_RUN_CPU_GUARD_S")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(f64::INFINITY)
        };
        if let Admission::Incomplete {
            remaining_s,
            guard_s,
        } = self.work.admit(&spec.name, guard)
        {
            self.sequence.push(json!({"run": spec.name, "started": false,
                "reason": format!("total guard {guard_s} CPU-s exceeds the remaining bound {remaining_s} CPU-s: not started, S2 incomplete")}));
            return None;
        }
        let c = self.compose(&spec.name);
        let run = advance(
            &self.d,
            c,
            start,
            spec,
            self.reader(),
            &self.extension,
            settled_check,
        );
        self.work.charge(&spec.name, run.record.process_cpu_s);
        self.work_runs.insert(
            spec.name.clone(),
            json!({"solver_cpu_s": run.attribution.solver_s(),
            "solver_cap_s": spec.solver_cap_s, "total_cpu_s": run.record.process_cpu_s,
            "total_guard_s": spec.total_guard_s, "cap_reached": run.record.cap_reached}),
        );
        self.sequence.push(json!({"run": spec.name, "started": true, "reached_s": run.record.reached_s,
            "failure": run.record.failure, "exit": run.record.exit, "process_cpu_s": run.record.process_cpu_s}));
        self.runs.insert(spec.name.clone(), run.record.json());
        Some(run)
    }

    /// The receipt's provenance, machine and configuration sections.
    pub fn header(&self) -> Value {
        let mut provenance = git_provenance();
        let water = water_build(
            &MetastableBand::from(&self.network_packet.pzr.cell.metastable),
            WATER_BUILD,
            WATER_LIB_DIR,
        )
        .unwrap_or_else(|e| json!({"refused": e}));
        for (k, v) in [
            ("packet", json!(self.packet.path)),
            ("packet_sha256", json!(self.packet.sha256)),
            ("water_build", water),
            (
                "features",
                json!(if cfg!(feature = "quadratures") {
                    ["ida", "quadratures"]
                } else {
                    ["ida", ""]
                }),
            ),
            ("d3_extension", self.extension_source.clone()),
        ] {
            provenance[k] = v;
        }
        let g = &self.d.gates;
        let s = &self.d.shared;
        let cpu_model = std::process::Command::new("sysctl")
            .args(["-n", "machdep.cpu.brand_string"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        json!({
            "provenance": provenance,
            "machine": {"cpu_model": cpu_model, "scheduling": cpu::SCHEDULING,
                "core_class": "performance core requested by QoS; placement not observable",
                "load_average_start": self.load_start, "load_average_end": cpu::load_average()},
            "configuration": {"rtol": s.number("/relativeTolerance"),
                "atol": {"stock_scaled": s.number("/stockScaledAbsolute"), "tracer_scaled": s.number("/tracerScaledAbsolute"),
                    "rotor_scaled": s.number("/rotorScaledAbsolute"), "volume_flow_m3_s": s.number("/volumeFlowAbsolute_m3_s")},
                "max_order": g.count("/maxOrder"), "newton_coefficient": g.number("/newtonCoefficient"),
                "delta_cj_lsetup": g.number("/deltaCjLSetup"), "cj_linear_refresh": g.flag("/cjLinearRefresh"),
                "restart_initial_step_s": g.number("/restartInitialStep_s"), "klu_ordering": g.text("/kluOrdering"),
                "output_s": g.number("/outputInterval_s"), "observation_s": g.number("/observationInterval_s"),
                "credited_band_hz": self.budgets.cutoff_hz, "assembly": g.text("/restartJacobian")}})
    }

    /// The full receipt.
    #[allow(clippy::too_many_arguments)] // One receipt: its status lines and every section the sequence filled.
    pub fn receipt(
        &self,
        kind: &str,
        status: &str,
        verdict: &str,
        pin: Value,
        tbd: Value,
        zero_time: Value,
        comparisons: Value,
        gates: Vec<Value>,
    ) -> Value {
        let mut declaration = self.d.receipt();
        declaration["pin"] = pin;
        declaration["tbd"] = tbd;
        let mut work = self.work.json();
        work["runs"] = json!(self.work_runs);
        let mut r = json!({"kind": kind, "status": status, "verdict": verdict,
            "declaration": declaration, "zero_time": zero_time, "runs": self.runs,
            "comparisons": comparisons, "gates": gates, "work_bound": work, "sequence": self.sequence,
            "cost": {"process_cpu_s": cpu::process_cpu_s() - self.process0, "wall_s": self.wall.elapsed().as_secs_f64()}});
        let header = self.header();
        for k in ["provenance", "machine", "configuration"] {
            r[k] = header[k].clone();
        }
        r
    }
}

/// The composed state as a run start.
pub fn composed_start(c: &Composed) -> Start {
    Start {
        t: 0.,
        y: c.y.clone(),
        yp: c.yp.clone(),
        from: "the composed state".into(),
    }
}

/// A saved state of this packet (`LD01_S2_SETTLED_STATE`), at its own time.
pub fn saved_start(path: &str, packet: &compose::PacketFile, dimension: usize) -> Start {
    let (t, y, yp) = compose::saved_state(path, packet, dimension);
    Start {
        t,
        y,
        yp,
        from: path.to_string(),
    }
}

/// Solver CPU and counts at the mark nearest `t` (s from the run's start).
fn mark_at(run: &Run, t: f64) -> Option<&super::runner::Mark> {
    run.marks
        .iter()
        .min_by(|a, b| {
            (a.t - run.origin - t)
                .abs()
                .total_cmp(&(b.t - run.origin - t).abs())
        })
        .filter(|m| (m.t - run.origin - t).abs() <= 1e-6)
}

fn comparison(run: &str, reference: &str, window: (f64, f64), metrics: Value) -> Value {
    let within = metrics["within"].clone();
    json!({"run": run, "reference": reference, "window_s": [window.0, window.1], "metrics": metrics, "within": within})
}

/// The hold's gates: cost, residuals per step, accuracy against its
/// reference, drift, conservation.
pub fn judge_hold(
    h: &Harness,
    hold: &Run,
    reference: Option<&Run>,
    comparisons: &mut serde_json::Map<String, Value>,
) -> Vec<Value> {
    let g = &h.d.gates;
    let judged = h.mode == Mode::Gate;
    let duration = hold.record.reached_s;
    let declared_from = g.number("/hold/measuredFrom_s");
    let from = if declared_from < duration {
        declared_from
    } else {
        0.
    };
    let basis_from = if from == declared_from {
        "hold.measuredFrom_s"
    } else {
        "smoke: hold shorter than measuredFrom_s, judged from 0"
    };
    let mut out = Vec::new();
    let (m0, m1) = (mark_at(hold, from), hold.marks.last());
    let budget = g.number("/hold/budget_cpu_s_per_s");
    let cost = m0
        .zip(m1)
        .map(|(a, b)| (b.solver_s - a.solver_s) / (b.t - a.t));
    out.push(gate(
        "hold.cost",
        json!(cost),
        json!(budget),
        cost.is_some_and(|c| c <= budget),
        judged,
        &format!("hold.budget_cpu_s_per_s, solver CPU (G11) from {basis_from}"),
    ));
    let per_step = m0.zip(m1).map(|(a, b)| {
        (b.counts.residuals - a.counts.residuals) as f64 / (b.counts.steps - a.counts.steps) as f64
    });
    let max_per_step = g.number("/hold/maxResidualsPerStep");
    g.text("/hold/residualCount");
    out.push(gate(
        "hold.residuals_per_step",
        json!(per_step),
        json!(max_per_step),
        per_step.is_some_and(|r| r <= max_per_step),
        judged,
        "hold.maxResidualsPerStep (IDAGetNumResEvals per IDAGetNumSteps)",
    ));
    if let Some(r) = reference {
        let m = compare::compare(
            &hold.credited,
            &r.credited,
            hold.origin,
            from,
            duration.min(r.record.reached_s),
            &h.budgets,
        );
        let within = m["within"] == json!(true);
        comparisons.insert(
            "hold_vs_holdReference".into(),
            comparison("hold", "holdReference", (from, duration), m),
        );
        out.push(gate(
            "hold.accuracy",
            json!(within),
            json!("within the contract (ld01-accuracy-contract, ld01-s2-accuracy)"),
            within,
            judged,
            "referenceToleranceFactor; E0",
        ));
    }
    g.text("/hold/averageCoolant");
    let d = drift(
        &hold.credited,
        hold.origin,
        from,
        &drift_ceilings(&h.d),
        hold.series_dt,
        h.budgets.cutoff_hz,
    );
    let within = d["within"] == json!(true);
    out.push(gate(
        "hold.drift",
        d,
        json!("hold.driftCeiling"),
        within,
        judged,
        &format!("each filtered output against its value at {from} s"),
    ));
    out.extend(conservation_gates(h, "hold", hold));
    out
}

fn conservation_gates(h: &Harness, name: &str, run: &Run) -> Vec<Value> {
    let judged = h.mode == Mode::Gate;
    let ids = &run.record.identities;
    let ledger = &run.record.ledger;
    vec![
        gate(
            &format!("{name}.identities"),
            json!(ids["unit_energy"]["max_relative"]),
            json!(h.d.gates.number("/identityRelative")),
            ids["pass"] == json!(true),
            judged,
            "identityRelative at every accepted sample",
        ),
        gate(
            &format!("{name}.ledgers"),
            json!(ledger["closures"]),
            json!(h.d.gates.number("/ledger/boundLocalToleranceUnits")),
            ledger["pass"] == json!(true),
            judged,
            "ledger.boundLocalToleranceUnits at every output (IDAS quadratures)",
        ),
    ]
}

/// The cap-cycle check (H2) over the window, every credited output with a
/// budget: content above the band, run RMS against R1's, above a floor.
fn cap_cycle(h: &Harness, trip: &Run, r1: &Run, window: f64) -> (Value, bool) {
    let s = &h.d.shared;
    let ratio_max = s.number("/eventReference/capCycleUncreditedRmsRatioMax");
    let fraction = s.number("/eventReference/capCycleFloorBudgetFraction");
    let b = &h.budgets;
    let dt = b.observation_s;
    let mut outputs = serde_json::Map::new();
    let mut pass = true;
    let floors: Vec<(&str, f64, f64)> = vec![
        (key::PZR_ROOF_PA, 1., b.roof_noise_pa),
        (key::CORE_DP_PA, 1., b.core_dp_pa),
        (key::LOOP_FLOW_KG_S, 1., b.loop_flow_kg_s),
        (key::CORE_POWER_W, b.power_basis_w, b.core_power_relative),
        (key::CORE_CELL_K, 1., b.core_cell_k),
        (key::SG_PRESSURE_PA, 1., b.sg_pressure_pa),
        (key::SG_LIQUID_M3, 1., b.sg_liquid_m3),
        (key::REGIONAL_FRACTION, 1., b.regional_fraction),
        (key::FUEL_DOPPLER_K, 1., b.fuel_doppler_k),
    ];
    let (ra, rb) = match (
        trip.credited.grid(trip.origin, 0., window, dt),
        r1.credited.grid(r1.origin, 0., window, dt),
    ) {
        (Ok(a), Ok(b)) => (a, b),
        (a, b) => {
            return (
                json!({"evaluable": false, "run": a.err(), "r1": b.err(), "pass": false}),
                false,
            );
        }
    };
    for (k, scale, budget) in floors {
        let (Ok(x), Ok(y)) = (trip.credited.output(k), r1.credited.output(k)) else {
            pass = false;
            continue;
        };
        for (i, (p, q)) in x.iter().zip(y).enumerate() {
            let a: Vec<f64> = p[ra.clone()].iter().map(|v| v / scale).collect();
            let c: Vec<f64> = q[rb.clone()].iter().map(|v| v / scale).collect();
            let (entry, ok) = cap_cycle_output(
                &content_above_band(&a, b.cutoff_hz, dt),
                &content_above_band(&c, b.cutoff_hz, dt),
                fraction * budget,
                ratio_max,
                dt,
                b.cutoff_hz,
            );
            pass &= ok;
            outputs.insert(format!("{k}[{i}]"), entry);
        }
    }
    (
        json!({"cutoff_hz": b.cutoff_hz, "window_s": window, "ratio_max": ratio_max, "floor_budget_fraction": fraction,
            "rule": CAP_CYCLE_RULE, "excess_spectrum": EXCESS_SPECTRUM_METHOD, "outputs": outputs, "pass": pass}),
        pass,
    )
}

/// The trip's gates against R0, R1 and R2.
pub fn judge_trip(
    h: &Harness,
    trip: &Run,
    r0: Option<&Run>,
    r1: Option<&Run>,
    r2: Option<&Run>,
    comparisons: &mut serde_json::Map<String, Value>,
) -> Vec<Value> {
    let g = &h.d.gates;
    let s = &h.d.shared;
    let judged = h.mode == Mode::Gate;
    let declared = g.number("/trip/duration_s");
    let duration = trip.record.spec.as_ref().map_or(declared, |x| x.duration_s);
    let window = g.number("/trip/window_s").min(duration);
    let post = s.number("/recovery/postWindow_s");
    let mut out = Vec::new();
    let completed = trip.record.failure.is_none()
        && trip.record.exit.is_none()
        && trip.record.reached_s >= duration - 1e-9;
    out.push(gate(
        "trip.completion",
        json!({"reached_s": trip.record.reached_s, "failure": trip.record.failure, "exit": trip.record.exit}),
        json!(declared),
        completed && duration >= declared,
        judged,
        "trip.duration_s with no no-go",
    ));
    // Cost: window, recovery, whole trip, step trigger.
    let solver_at = |t: f64| mark_at(trip, t).map(|m| m.solver_s);
    let window_budget = g.number("/trip/windowBudget_cpu_s_per_s");
    let window_cost = solver_at(window).map(|c| c / window);
    out.push(gate(
        "trip.window_cost",
        json!(window_cost),
        json!(window_budget),
        window_cost.is_some_and(|c| c <= window_budget),
        judged,
        &format!("trip.windowBudget_cpu_s_per_s over {window} s"),
    ));
    let recovery = solver_at(window + post).map(|c| c / (window + post));
    let failures = trip
        .record
        .window_counts
        .zip(mark_at(trip, window + post))
        .map(|(w, m)| m.counts.since(w).convergence_failures);
    let max_failures = s.count("/recovery/maxConvergenceFailures") as i64;
    out.push(gate(
        "trip.recovery",
        json!({"cpu_s_per_s": recovery, "convergence_failures": failures}),
        json!({"cpu_s_per_s": window_budget, "convergence_failures": max_failures}),
        recovery.is_some_and(|c| c <= window_budget) && failures.is_some_and(|f| f <= max_failures),
        judged,
        "H1, H1a: window plus recovery.postWindow_s",
    ));
    let whole_budget = g.number("/trip/wholeTripBudget_cpu_s_per_s");
    let whole = trip.marks.last().map(|m| m.solver_s / (m.t - trip.origin));
    out.push(gate(
        "trip.whole_trip_cost",
        json!(whole),
        json!(whole_budget),
        whole.is_some_and(|c| c <= whole_budget) && duration >= declared,
        judged,
        "trip.wholeTripBudget_cpu_s_per_s (G1)",
    ));
    let steps = mark_at(trip, window).map(|m| m.counts.steps);
    let step_cpu = solver_at(window).zip(steps).map(|(c, n)| c / n as f64);
    let trigger = g.number("/trip/stepTrigger/maxMeanSolverCpuPerStep_s");
    g.text("/trip/stepTrigger/judgedOn");
    g.text("/trip/stepTrigger/miss");
    out.push(gate(
        "trip.step_trigger",
        json!(step_cpu),
        json!(trigger),
        step_cpu.is_some_and(|c| c <= trigger),
        judged,
        "S2-D12: the window's mean solver CPU per accepted step",
    ));
    // Accuracy against R1 (window) and R2 (window and after).
    let compare_to = |name: &str,
                      r: &Run,
                      from: f64,
                      to: f64,
                      comparisons: &mut serde_json::Map<String, Value>| {
        let m = compare::compare(
            &trip.credited,
            &r.credited,
            trip.origin,
            from,
            to,
            &h.budgets,
        );
        let within = m["within"] == json!(true);
        comparisons.insert(
            format!("trip_vs_{name}_{from}_{to}"),
            comparison("trip", name, (from, to), m),
        );
        within
    };
    let reached = |r: &Run| r.record.reached_s;
    let mut accuracy = true;
    let mut evaluated = 0;
    if let Some(r) = r1 {
        accuracy &= compare_to("R1", r, 0., window.min(reached(r)), comparisons);
        evaluated += 1;
    }
    if let Some(r) = r2 {
        accuracy &= compare_to("R2", r, 0., window.min(reached(r)), comparisons);
        evaluated += 1;
        if duration > window && reached(r) > window {
            accuracy &= compare_to("R2", r, window, duration.min(reached(r)), comparisons);
        }
    }
    g.whole("/trip/referenceSpans");
    out.push(gate(
        "trip.accuracy",
        json!({"references_compared": evaluated}),
        json!("within the contract against R1 and R2 over the window, against R2 after it"),
        accuracy && evaluated == 2,
        judged,
        "E0 against R1, R2",
    ));
    if let (Some(a), Some(b)) = (r1, r2) {
        let m = compare::compare(
            &a.credited,
            &b.credited,
            a.origin,
            0.,
            window.min(reached(a)).min(reached(b)),
            &h.budgets,
        );
        comparisons.insert(
            "R1_vs_R2_window".into(),
            comparison("R1", "R2", (0., window), m),
        );
    }
    // Cap cycle (H2) against R1.
    if let Some(r) = r1 {
        let (v, pass) = cap_cycle(
            h,
            trip,
            r,
            window.min(reached(r)).min(trip.record.reached_s),
        );
        out.push(gate(
            "trip.cap_cycle",
            v,
            json!("RMS above the band <= ratio_max x R1's, judged above floor_budget_fraction x budget"),
            pass,
            judged,
            "H2",
        ));
    }
    // Rods: all seat, times to the fractions against R1 and R2.
    let clusters = h.reader().clusters();
    let all_seated = trip.seats.len() == clusters;
    let require = g.flag("/trip/requireSeating");
    out.push(gate(
        "trip.rods_seated",
        json!(trip.seats.len()),
        json!(clusters),
        all_seated || !require,
        judged,
        "trip.requireSeating (G4, G9)",
    ));
    let times = |r: &Run| {
        insertion_times(
            &r.credited,
            r.origin,
            h.reference_travel_m,
            &h.budgets.insertion_fractions,
            &r.seats,
        )
    };
    if let Ok(own) = times(trip) {
        let mut pass = true;
        let mut detail = serde_json::Map::new();
        for (name, r) in [("R1", r1), ("R2", r2)] {
            if let Some(r) = r
                && let Ok(theirs) = times(r)
            {
                let v = compare_timing(&own, &theirs, &h.budgets);
                pass &= v["within"] == json!(true);
                detail.insert(name.into(), v);
                detail.insert(
                    format!("{name}_travel"),
                    travel_difference(
                        &trip.credited,
                        &r.credited,
                        trip.origin,
                        0.,
                        window.min(reached(r)),
                        &h.budgets,
                    ),
                );
            } else {
                pass = false;
            }
        }
        out.push(gate(
            "trip.rod_timing",
            Value::Object(detail),
            json!(h.budgets.timing_s),
            pass,
            judged,
            "thresholdTiming_s per insertion fraction and seat (G4, P6)",
        ));
    }
    if let Some(r) = r0 {
        let fails = r.record.failure.is_some() && !r.record.cap_reached;
        out.push(gate(
            "trip.R0",
            json!({"reached_s": r.record.reached_s, "failure": r.record.failure, "exit": r.record.exit, "caps": r.record.caps}),
            json!("reported; its CPU and step caps report-only"),
            !fails,
            false,
            "H1: R0 never capped, contract tolerances, window plus recovery",
        ));
    }
    out.extend(conservation_gates(h, "trip", trip));
    out
}

/// D3 (a) and the exact start at a start state, as a zero-time entry.
pub fn state_receipt(h: &mut Harness, start: &Start, item: &str) -> Value {
    let mut c = h.compose(item);
    let mut y = start.y.clone();
    let weights = compose::error_weights(&y, c.rtol, &c.atol);
    let started = cpu::process_cpu_s();
    let result = leitbild_operating_water::joined::consistent_start(
        &mut c.joined,
        leitbild_operating_water::joined::Matrices::Blocks {
            structure: &c.structure,
            analyses: &mut c.analyses,
        },
        start.t,
        &mut y,
        &c.ids,
        &weights,
        compose::START_BOUND,
        3,
    );
    let cpu_s = cpu::process_cpu_s() - started;
    h.work.charge(item, cpu_s);
    match result {
        Ok((yp, report)) => {
            let d3 = match c.joined.evaluate(start.t, &y, &yp, None, 0., None) {
                Ok(()) => match admit(&c.joined, &h.extension, start.t) {
                    Ok(a) => json!({"domain": a.domain, "margin_holds": a.margin.holds,
                        "worst_pivot": a.margin.pivots.iter().copied().fold(f64::INFINITY, f64::min)}),
                    Err(e) => json!({"refused": format!("{e}")}),
                },
                Err(e) => json!({"refused": format!("{e:?}")}),
            };
            json!({"from": start.from, "t_s": start.t,
                "z1": {"residual": report.residual.value, "constraint_rate": report.constraint_rate.value,
                    "correction_wrms": report.correction_wrms, "projection_passes": report.projection_passes,
                    "rate_passes": report.rate_passes, "cpu_s": cpu_s, "bound": compose::START_BOUND},
                "d3_at_state": d3})
        }
        Err(e) => json!({"from": start.from, "refused": format!("{e:?}")}),
    }
}

/// External receipts named in `LD01_S2_ZERO_TIME_RECEIPTS` (`{"Z2": path,
/// …}`) and S1 run 6's (`LD01_S2_S1_RUN6_RECEIPT`), each with its SHA-256;
/// S1 run 6 must pass at this app commit, and its CPU is charged.
pub fn external_receipts(h: &mut Harness, app_commit: &str) -> Result<Value, Vec<String>> {
    let mut refusals = Vec::new();
    let mut out = serde_json::Map::new();
    match std::env::var("LD01_S2_S1_RUN6_RECEIPT") {
        Ok(path) => match std::fs::read(&path)
            .map_err(|e| e.to_string())
            .and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|e| e.to_string()))
        {
            Ok(r) => {
                let pass = r["kind"] == "s1-hydraulics-admission"
                    && r["verdict"].as_str().is_some_and(|v| v.starts_with("PASS"));
                let at_commit = r["app_commit"].as_str() == Some(app_commit);
                let cpu_s = r["total_cpu_s"].as_f64().unwrap_or(f64::NAN);
                if !pass {
                    refusals.push(format!("S1 run 6 ({path}) did not pass: {}", r["verdict"]));
                }
                if !at_commit {
                    refusals.push(format!(
                        "S1 run 6 ran at {} , not at the frozen app commit {app_commit}",
                        r["app_commit"]
                    ));
                }
                h.work.charge("S1 run 6", cpu_s);
                out.insert(
                    "s1_run6".into(),
                    json!({"path": path, "sha256": crate::provenance::sha256_file(&path).ok(),
                    "verdict": r["verdict"], "app_commit": r["app_commit"], "total_cpu_s": cpu_s,
                    "cap_cpu_s": h.d.gates.number("/caps_cpu_s/s1Run6")}),
                );
            }
            Err(e) => refusals.push(format!("S1 run 6's receipt {path}: {e}")),
        },
        Err(_) => refusals.push("LD01_S2_S1_RUN6_RECEIPT names no S1 run 6 receipt".into()),
    }
    match std::env::var("LD01_S2_ZERO_TIME_RECEIPTS") {
        Ok(text) => match serde_json::from_str::<BTreeMap<String, String>>(&text) {
            Ok(map) => {
                for z in ["Z2", "Z3", "Z4", "Z5", "Z6", "Z7"] {
                    match map.get(z) {
                        Some(p) => {
                            out.insert(z.into(), json!({"path": p, "sha256": crate::provenance::sha256_file(p).ok()}));
                        }
                        None => refusals.push(format!("no {z} receipt named")),
                    }
                }
            }
            Err(e) => refusals.push(format!("LD01_S2_ZERO_TIME_RECEIPTS: {e}")),
        },
        Err(_) => refusals.push("LD01_S2_ZERO_TIME_RECEIPTS names no zero-time receipts".into()),
    }
    // The values those receipts judge are delegated to them.
    out.insert(
        "delegated".into(),
        json!({"zeroTime": h.d.gates.whole("/zeroTime"), "spectral": h.d.gates.whole("/spectral"),
            "directionalCheck": h.d.gates.whole("/directionalCheck"), "preparation": h.d.gates.whole("/preparation"),
            "powerBasis": h.d.gates.whole("/powerBasis"), "projection": h.d.gates.whole("/projection")}),
    );
    if refusals.is_empty() {
        Ok(Value::Object(out))
    } else {
        Err(refusals)
    }
}

/// The receipt's path: a new file under `$LD01_RECEIPTS/<lane>/`.
pub fn receipt_path(lane: &str, name: &str) -> std::path::PathBuf {
    let dir = std::env::var("LD01_RECEIPTS").expect("LD01_RECEIPTS names the receipt root");
    std::path::Path::new(&dir).join(lane).join(name)
}

/// Writes the receipt, refused unless complete and new.
pub fn write(path: &std::path::Path, r: &Value) -> Result<(), String> {
    receipt::write(path, r)
}

/// The settle with its settled check and H4's fit, for the gate run (and
/// S2-07 previews).
pub fn settle(h: &mut Harness, start: &Start) -> Option<(Run, Value)> {
    let g = &h.d.gates;
    let max_simulated = g.open_number("/settling/maxSimulated_s")?;
    let window = g.number("/settling/window_s");
    g.text("/settling/measure");
    g.text("/settling/judgedOn");
    g.text("/settling/capFit");
    g.open_number("/settling/maxCpu_s");
    let quantities = settling_quantities(&h.d);
    let spec = h.spec("settle", max_simulated).ok()?;
    let (dt, cutoff) = (spec.output_s, h.budgets.cutoff_hz);
    let q2 = quantities.clone();
    let mut check = move |c: &Credited| settled(c, &q2, window, dt, cutoff).0;
    let run = h.run(&spec, start, Some(&mut check))?;
    let cpu: Vec<(f64, f64)> = run
        .marks
        .iter()
        .map(|m| (m.t - run.origin, m.process_s))
        .collect();
    let fit = settle_cap_fit(
        &run.credited,
        run.origin,
        &cpu,
        &quantities,
        window,
        dt,
        cutoff,
    );
    let (is_settled, last) = settled(&run.credited, &quantities, window, dt, cutoff);
    Some((
        run,
        json!({"settled": is_settled, "last_window": last, "settle_cap_fit": fit}),
    ))
}
