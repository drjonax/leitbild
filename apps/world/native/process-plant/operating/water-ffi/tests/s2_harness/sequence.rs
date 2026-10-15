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
    outputs::{Reader, admit, extension, reference_densities},
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
    /// The source feedback's reference water densities (D3 (a)).
    pub d3_reference: Vec<f64>,
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
        let d3_reference = reference_densities(&raw)?;
        Ok(Self {
            mode,
            d,
            budgets,
            extension,
            extension_source,
            packet,
            network_packet,
            reference_travel_m,
            d3_reference,
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
        let derived = compose::DerivedRule::from(&self.d).unwrap_or_else(|e| panic!("{e}"));
        let c = compose::compose_from(
            &self.d.shared,
            derived.as_ref(),
            self.settled_flows.as_ref(),
        );
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
            // D3 (a) as approved ends a trip-type run's declared part at its
            // labelled exit; the gate run continues it for information only
            // (every owner option), a smoke only when asked.
            domain_exit_stops: if smoke {
                std::env::var("LD01_S2_SMOKE_DOMAIN_EXIT").as_deref() != Ok("report")
            } else {
                !matches!(
                    name,
                    "trip" | "R0" | "R1" | "R2" | "noTurbineTrip" | "stuckCluster"
                )
            },
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
                // BDF2 at rtol/100; every absolute tolerance, S2-D24's
                // derived class included, scaled by referenceToleranceFactor
                // so R2 checks the derived class (PLAN §9).
                trip(&mut spec);
                let f = s.number("/eventReference/secondRefinementToleranceFactor");
                spec.rtol = contract_rtol * f;
                spec.atol_factor = factor;
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
            // G7's stuck cluster: the trip, outputs only. Its StuckCluster
            // command ahead of the TRIP names the highest-worth cluster at
            // the run's start state ([`Harness::stuck_cluster_spec`]).
            "stuckCluster" => {
                trip(&mut spec);
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

    /// The stuck-cluster contrary run's spec from `start`: the trip with the
    /// highest-worth cluster's [`Command::StuckCluster`] issued at t = 0
    /// ahead of the TRIP, and the selection's receipt ([`stuck_cluster`]).
    pub fn stuck_cluster_spec(
        &mut self,
        duration_s: f64,
        start: &Start,
    ) -> Result<(RunSpec, Value), String> {
        let selection = stuck_cluster(self, start)?;
        let cluster = selection["index"]
            .as_u64()
            .ok_or("the stuck-cluster selection names no index")? as usize;
        let mut spec = self.spec("stuckCluster", duration_s)?;
        spec.commands
            .insert(0, (0., Command::StuckCluster { cluster }));
        self.sequence
            .push(json!({"item": "stuckCluster selection", "selection": selection}));
        Ok((spec, selection))
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
            &self.d3_reference,
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

    /// What the next phase of a gate run restores: the work bound's
    /// charges, the sequence so far and the run records.
    pub fn handover(&self) -> Value {
        json!({"charged": self.work.charged.iter().map(|(k, c)| json!([k, c])).collect::<Vec<_>>(),
            "not_started": self.work.not_started, "sequence": self.sequence,
            "runs": self.runs, "work_runs": self.work_runs})
    }
    /// Restore a previous phase's [`Harness::handover`].
    pub fn restore(&mut self, v: &Value) -> Result<(), String> {
        let charged = v["charged"].as_array().ok_or("handover without charges")?;
        for c in charged {
            let item = c[0].as_str().ok_or("charge item")?;
            let cpu = c[1].as_f64().ok_or("charge CPU")?;
            self.work.charge(&format!("{item} (phase 1)"), cpu);
        }
        self.work.not_started = v["not_started"].as_array().cloned().unwrap_or_default();
        self.sequence = v["sequence"].as_array().cloned().unwrap_or_default();
        for (k, r) in v["runs"].as_object().ok_or("handover runs")? {
            self.runs.insert(k.clone(), r.clone());
        }
        for (k, r) in v["work_runs"].as_object().ok_or("handover work runs")? {
            self.work_runs.insert(k.clone(), r.clone());
        }
        Ok(())
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
        accepted: true,
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
        accepted: true,
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
            format!("trip_vs_{name}_{from:.1}-{to:.1}s"),
            comparison("trip", name, (from, to), m),
        );
        within
    };
    let reached = |r: &Run| r.record.reached_s;
    let mut accuracy = true;
    let mut evaluated = 0;
    for (name, reference, after_window) in [("R1", r1, false), ("R2", r2, true)] {
        let Some(r) = reference else { continue };
        for (from, to) in reference_spans(window, duration, reached(trip), reached(r), after_window)
        {
            accuracy &= compare_to(name, r, from, to, comparisons);
        }
        evaluated += 1;
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

/// The trip's comparison spans against one reference (`referenceSpans`:
/// R1 over the window, R2 over the window and after it), each within the
/// part both runs reached: a declared part ends at its own run's D3 (a)
/// exit, so neither run is compared where it has no samples.
pub fn reference_spans(
    window: f64,
    duration: f64,
    trip_reached: f64,
    reference_reached: f64,
    after_window: bool,
) -> Vec<(f64, f64)> {
    let end = trip_reached.min(reference_reached);
    let mut spans = vec![(0., window.min(end))];
    if after_window && duration > window && end > window {
        spans.push((window, duration.min(end)));
    }
    spans
}

/// A run's declared part: everything up to `until` (absolute time), its
/// D3 (a) exit when it continued past it for information.
pub fn truncated(run: &Run, until: f64) -> Run {
    let mut r = run.clone();
    let keep = r
        .credited
        .t
        .iter()
        .take_while(|t| **t <= until + 1e-9)
        .count();
    r.credited.t.truncate(keep);
    for series in r.credited.outputs.values_mut() {
        for s in series.iter_mut() {
            s.truncate(keep);
        }
    }
    r.marks.retain(|m| m.t <= until + 1e-9);
    r.seats.retain(|_, t| *t <= until + 1e-9);
    r.record.reached_s = until - r.origin;
    r
}

/// The trip's gates on each run's declared part (up to its D3 (a) exit),
/// and, where any run continued past its exit, the same gates on the whole
/// runs for information only (ids prefixed `information.`, never judged;
/// comparisons likewise), for the owner's options.
pub fn judge_trip_declared_and_information(
    h: &Harness,
    trip: &Run,
    r0: Option<&Run>,
    r1: Option<&Run>,
    r2: Option<&Run>,
    comparisons: &mut serde_json::Map<String, Value>,
) -> Vec<Value> {
    let cut = |r: &Run| {
        r.information_from
            .map_or_else(|| r.clone(), |at| truncated(r, at))
    };
    let (t, a, b, c) = (cut(trip), r0.map(cut), r1.map(cut), r2.map(cut));
    let mut out = judge_trip(h, &t, a.as_ref(), b.as_ref(), c.as_ref(), comparisons);
    let continued = [Some(trip), r0, r1, r2]
        .iter()
        .flatten()
        .any(|r| r.information_from.is_some());
    if continued {
        let mut info = serde_json::Map::new();
        for mut g in judge_trip(h, trip, r0, r1, r2, &mut info) {
            let id = format!("information.{}", g["id"].as_str().unwrap_or(""));
            let basis = format!(
                "INFORMATION ONLY (past the D3 (a) exit): {}",
                g["basis"].as_str().unwrap_or("")
            );
            g["id"] = json!(id);
            g["judged"] = json!(false);
            g["basis"] = json!(basis);
            out.push(g);
        }
        for (k, v) in info {
            comparisons.insert(format!("information.{k}"), v);
        }
    }
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
                        "worst_pivot": a.margin.pivots.iter().copied().fold(f64::INFINITY, f64::min),
                        "margins": super::outputs::d3_point(&c.joined, &h.extension, &h.d3_reference, start.t, start.t)}),
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

/// The receipts other tests wrote in the window, from the manifest
/// `LD01_S2_EXTERNAL_MANIFEST`: `{name: {"receipt": path, "process_cpu_s":
/// x}}`, the CPU measured around each test by the window script (`time -p`,
/// user + sys), or `{"receipt": path, "reused": true}` for a preview receipt
/// reused (charged nothing in the window). Each named one is read, hashed,
/// checked by its kind's pass rule, recorded and its CPU charged.
///
/// | Name | Pass rule |
/// | --- | --- |
/// | `S1run6` | kind `s1-hydraulics-admission`, verdict `PASS…`, app commit = this binary's (re-run in the window at the gate commit) |
/// | `Z6composed`, `Z6settled` | verdict `GO…` (a gate: recorded, never a refusal) |
/// | `Z3composed`, `Z3settled` | D3 (a)'s doubled-term margin holds at every Z3 envelope point (a gate) |
/// | `Z7` | `failures` = 0 (a gate) |
/// | `Z5` | kind `s2-z5-unit-costs` |
/// | others (`Z2`, `Z4`) | recorded; reported only (r7) |
pub fn external_receipts(
    h: &mut Harness,
    app_commit: &str,
    required: &[&str],
) -> Result<Value, Vec<String>> {
    let manifest: BTreeMap<String, Value> = match std::env::var("LD01_S2_EXTERNAL_MANIFEST") {
        Ok(path) => match std::fs::read(&path)
            .map_err(|e| e.to_string())
            .and_then(|b| serde_json::from_slice(&b).map_err(|e| e.to_string()))
        {
            Ok(m) => m,
            Err(e) => return Err(vec![format!("LD01_S2_EXTERNAL_MANIFEST {path}: {e}")]),
        },
        Err(_) => return Err(vec!["LD01_S2_EXTERNAL_MANIFEST names no manifest".into()]),
    };
    let (mut out, charges, refusals) = check_external(&manifest, required, app_commit);
    for (name, cpu) in charges {
        h.work.charge(&name, cpu);
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

/// What [`check_external`] found: the receipts' entries, the charges and
/// the refusals.
pub type Checked = (
    serde_json::Map<String, Value>,
    Vec<(String, f64)>,
    Vec<String>,
);

/// [`external_receipts`]' checks on a manifest: each required entry's
/// receipt read, hashed and judged by its kind's pass rule; the charges
/// (name, CPU) of those run in the window; the refusals.
pub fn check_external(
    manifest: &BTreeMap<String, Value>,
    required: &[&str],
    app_commit: &str,
) -> Checked {
    let mut refusals = Vec::new();
    let mut charges = Vec::new();
    let mut out = serde_json::Map::new();
    for name in required {
        let Some(entry) = manifest.get(*name) else {
            refusals.push(format!("the manifest names no {name} receipt"));
            continue;
        };
        let Some(path) = entry["receipt"].as_str() else {
            refusals.push(format!("{name}: no receipt path"));
            continue;
        };
        let r: Value = match std::fs::read(path)
            .map_err(|e| e.to_string())
            .and_then(|b| serde_json::from_slice(&b).map_err(|e| e.to_string()))
        {
            Ok(r) => r,
            Err(e) => {
                refusals.push(format!("{name} ({path}): {e}"));
                continue;
            }
        };
        let reused = entry["reused"] == json!(true);
        let cpu = entry["process_cpu_s"].as_f64();
        if !reused && cpu.is_none() {
            refusals.push(format!(
                "{name}: run in the window but no process_cpu_s measured"
            ));
        }
        // The pass rule by kind. S1 run 6 is a prerequisite (refuses unless
        // it passes) and Z5 a measurement (refuses unless it is one); Z3,
        // Z6 and Z7 are gates, recorded red or green, never a refusal.
        let pass = match *name {
            "S1run6" => json!(
                r["kind"] == "s1-hydraulics-admission"
                    && r["verdict"].as_str().is_some_and(|v| v.starts_with("PASS"))
                    && r["app_commit"].as_str() == Some(app_commit)
            ),
            "Z6composed" | "Z6settled" => {
                json!(r["verdict"].as_str().is_some_and(|v| v.starts_with("GO")))
            }
            // Z3's margin (r7): D3 (a)'s predicate with the doubled water
            // term holds at every point of the Z3 post-trip envelope.
            "Z3composed" | "Z3settled" => match r
                .pointer("/z3_envelope/every_point_holds_with_water_term_doubled")
                .and_then(Value::as_bool)
            {
                Some(holds) => json!(holds),
                None => {
                    refusals.push(format!(
                        "{name} ({path}) is not a D3 (a) margin receipt on the Z3 envelope"
                    ));
                    Value::Null
                }
            },
            "Z7" => json!(r["failures"] == json!(0)),
            "Z5" => json!(r["kind"] == "s2-z5-unit-costs"),
            _ => Value::Null,
        };
        if pass == json!(false) && matches!(*name, "S1run6" | "Z5") {
            refusals.push(format!(
                "{name} ({path}) does not pass: kind {}, verdict {}, app commit {} (this binary {app_commit})",
                r["kind"], r["verdict"], r["app_commit"]
            ));
        }
        if let Some(c) = cpu.filter(|_| !reused) {
            charges.push((name.to_string(), c));
        }
        out.insert(
            name.to_string(),
            json!({"receipt": path, "sha256": crate::provenance::sha256_file(path).ok(),
                "kind": r["kind"], "verdict": r["verdict"], "status": r["status"],
                "process_cpu_s": cpu, "reused": reused, "pass": pass}),
        );
    }
    (out, charges, refusals)
}

/// r7's zero-time gates as verdict entries: Z1 at each state (the exact
/// start's residual and constraint rate within the start bound), Z3's
/// margin and both Z6 pencils at both states, Z7, and S1 run 6 (a
/// prerequisite); Z2, Z4 and Z5 are reported (`judged` false).
pub fn zero_time_gates(zero_time: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for state in ["composed", "settled"] {
        let z1 = &zero_time[state]["z1"];
        let (residual, rate, bound) = (
            z1["residual"].as_f64(),
            z1["constraint_rate"].as_f64(),
            z1["bound"].as_f64(),
        );
        let pass = residual
            .zip(rate)
            .zip(bound)
            .is_some_and(|((r, c), b)| r <= b && c <= b);
        out.push(gate(
            &format!("zero_time.Z1.{state}"),
            json!({"residual": residual, "constraint_rate": rate}),
            json!(bound),
            pass,
            true,
            "Z1: the exact consistent start on the block Jacobian (residual and constraint rate within the start bound)",
        ));
    }
    let externals = [&zero_time["external_phase1"], &zero_time["external_phase2"]];
    let find = |name: &str| externals.iter().find_map(|e| e.get(name)).cloned();
    for (name, id, judged, basis) in [
        (
            "S1run6",
            "prerequisite.S1_run_6",
            true,
            "S1 run 6 PASS at the gate commit (G16)",
        ),
        (
            "Z3composed",
            "zero_time.Z3.composed",
            true,
            "Z3's margin: D3 (a) with the doubled water term >= 1 % at every Z3 envelope point",
        ),
        (
            "Z3settled",
            "zero_time.Z3.settled",
            true,
            "Z3's margin at the settled state",
        ),
        (
            "Z6composed",
            "zero_time.Z6.composed",
            true,
            "Z6: both named restrictions GO",
        ),
        (
            "Z6settled",
            "zero_time.Z6.settled",
            true,
            "Z6 at the settled state",
        ),
        (
            "Z7",
            "zero_time.Z7",
            true,
            "Z7: every directional check within 1e-6",
        ),
        ("Z2", "zero_time.Z2", false, "Z2: reported"),
        ("Z4", "zero_time.Z4", false, "Z4: reported"),
        (
            "Z5",
            "zero_time.Z5",
            false,
            "Z5: reported (its values are the S2-F16..F18 fills)",
        ),
    ] {
        let entry = find(name);
        let pass = entry.as_ref().is_some_and(|e| e["pass"] == json!(true));
        out.push(gate(
            id,
            entry.map_or(Value::Null, |e| json!({"receipt": e["receipt"], "sha256": e["sha256"], "verdict": e["verdict"], "pass": e["pass"]})),
            json!("its kind's pass rule"),
            if judged { pass } else { false },
            judged,
            basis,
        ));
    }
    out
}

/// The phase-1 hand-over: the gate run's settled state (the S2-07 format,
/// floats and exact bits) for the settled-state zero-time receipts and the
/// runs phase.
pub fn write_state(
    path: &std::path::Path,
    packet: &compose::PacketFile,
    s: &Start,
) -> Result<(), String> {
    if path.exists() {
        return Err(format!("never overwritten: {}", path.display()));
    }
    if !s.accepted {
        return Err(format!(
            "DR-P3-GATE-3: {} is not an accepted step and is never handed on",
            s.from
        ));
    }
    let bits =
        |v: &[f64]| -> Vec<String> { v.iter().map(|x| format!("{:016x}", x.to_bits())).collect() };
    let state = json!({"packet": packet.path, "packet_sha256": packet.sha256, "t_s": s.t,
        "y": s.y, "y_bits": bits(&s.y), "yp": s.yp, "yp_bits": bits(&s.yp)});
    std::fs::write(path, serde_json::to_vec(&state).unwrap())
        .map_err(|e| format!("{}: {e}", path.display()))
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

/// G7's "highest worth in the source feedback", as the harness computes it
/// (CONTRARY lane's proposal; the lead declares it).
pub const WORTH_RULE: &str = "each cluster's worth is the rod reactivity its full insertion (seated, travel 0) removes in the source feedback, every other cluster at its start travel, summed over the regions with weights n_i^2 / sum n^2 (first-order perturbation, self-adjoint approximation; n_i the regional populations at the start state); the highest worth is stuck; exact ties take the lowest index and are reported; the n_i-weighted ranking is reported beside it";

/// Per cluster, the weighted rod reactivity its full insertion removes:
/// `sum_i w_i (rho_rods,i(start) - rho_rods,i(cluster seated))`, from the
/// source feedback's own reactivity terms.
pub fn cluster_worths(
    model: &leitbild_operating_plant::source_feedback::Model,
    inputs: &leitbild_operating_plant::joined::nuclear::FeedbackInputs,
    travel_m: &[f64],
    weights: &[f64],
) -> Result<Vec<f64>, String> {
    use leitbild_operating_plant::{
        source_feedback::{Conditions, ReactivityTerms},
        thermal::Scalar,
    };
    let regions = inputs.neutrons.len();
    if weights.len() != regions || travel_m.len() != model.rod_count() {
        return Err("cluster worths: layout".into());
    }
    let c = |v: &[f64]| -> Vec<Scalar> { v.iter().map(|x| Scalar::constant(*x)).collect() };
    let (f, d, b, p, m) = (
        c(&inputs.fuel_temperature_k),
        c(&inputs.water_density_kg_m3),
        c(&inputs.boron_ppm_eq),
        c(&inputs.pressure_pa),
        c(&inputs.moderator_temperature_k),
    );
    let (fi, xe, sm, op) = (
        c(&inputs.fissile_atoms),
        c(&inputs.xenon_atoms),
        c(&inputs.samarium_atoms),
        c(&inputs.capture_loss_change_m2),
    );
    let rods = |travel: &[f64]| -> Result<Vec<f64>, String> {
        let t = c(travel);
        let mut out = vec![ReactivityTerms::default(); regions];
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
                    achieved_rod_travel_m: &t,
                    // The reactivity terms do not read the capsule age.
                    capsule_age_s: Scalar::constant(0.),
                },
                &mut out,
            )
            .map_err(|e| e.to_string())?;
        Ok(out.iter().map(|r| r.rods).collect())
    };
    let base = rods(travel_m)?;
    (0..travel_m.len())
        .map(|k| {
            let mut inserted = travel_m.to_vec();
            inserted[k] = 0.;
            let r = rods(&inserted)?;
            Ok(weights
                .iter()
                .zip(base.iter().zip(&r))
                .map(|(w, (a, b))| w * (a - b))
                .sum())
        })
        .collect()
}

/// Normalized region weights `n_i^power / sum n^power`.
pub fn population_weights(neutrons: &[f64], power: i32) -> Result<Vec<f64>, String> {
    let w: Vec<f64> = neutrons.iter().map(|n| n.powi(power)).collect();
    let total: f64 = w.iter().sum();
    if !(total.is_finite() && total > 0.) || w.iter().any(|v| !(v.is_finite() && *v >= 0.)) {
        return Err(format!(
            "region weights need finite nonnegative populations ({total})"
        ));
    }
    Ok(w.iter().map(|v| v / total).collect())
}

/// The highest worth's index (lowest among exact ties) and every index
/// that ties it.
pub fn highest_worth(worths: &[f64]) -> Result<(usize, Vec<usize>), String> {
    if worths.is_empty() || worths.iter().any(|w| !w.is_finite()) {
        return Err(format!(
            "cluster worths must be finite and present: {worths:?}"
        ));
    }
    let best = worths.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let ties: Vec<usize> = (0..worths.len()).filter(|c| worths[*c] == best).collect();
    Ok((ties[0], ties))
}

/// G7's stuck cluster at a start state, by [`WORTH_RULE`], with its receipt.
pub fn stuck_cluster(h: &mut Harness, start: &Start) -> Result<Value, String> {
    let declared = h.d.gates.text("/contrary/stuckCluster/cluster");
    let raw: Value = serde_json::from_slice(&h.packet.bytes).map_err(|e| e.to_string())?;
    let mut c = h.compose("stuck-cluster selection");
    let started = cpu::process_cpu_s();
    c.joined
        .evaluate(start.t, &start.y, &start.yp, None, 0., None)
        .map_err(|e| format!("stuck-cluster selection at the start state: {e:?}"))?;
    let inputs = c.joined.nuclear().feedback_inputs();
    let travel: Vec<f64> = c.joined.travel().iter().map(|s| s.value).collect();
    let model = c.joined.nuclear().feedback();
    let squared = cluster_worths(
        model,
        &inputs,
        &travel,
        &population_weights(&inputs.neutrons, 2)?,
    )?;
    let linear = cluster_worths(
        model,
        &inputs,
        &travel,
        &population_weights(&inputs.neutrons, 1)?,
    )?;
    h.work
        .charge("stuck-cluster selection", cpu::process_cpu_s() - started);
    let (index, ties) = highest_worth(&squared)?;
    let (linear_index, linear_ties) = highest_worth(&linear)?;
    let id = |k: usize| raw["rods"]["clusters"][k]["id"].clone();
    if id(index).is_null() || raw["rods"]["clusters"].as_array().map(Vec::len) != Some(travel.len())
    {
        return Err(
            "the packet's rods section does not name the source feedback's clusters".into(),
        );
    }
    Ok(
        json!({"declared": declared, "rule": WORTH_RULE, "from": start.from, "t_s": start.t,
        "index": index, "cluster": id(index), "worth": squared[index],
        "ties": ties.iter().map(|k| json!({"index": k, "cluster": id(*k)})).collect::<Vec<_>>(),
        "worths_n2": squared, "worths_n": linear,
        "n_weighted": {"index": linear_index, "ties": linear_ties, "agrees": linear_ties.contains(&index)},
        "travel_m": travel, "populations": inputs.neutrons}),
    )
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
