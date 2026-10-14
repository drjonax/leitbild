//! One declared S2 run on stock IDAS/KLU: from a consistently started state
//! of a fresh composition, under its [`RunSpec`], to its record.
//!
//! - **System.** `Metered<Observed<Ledgered<If97>>>`: the joined operator on
//!   JAC's block Jacobian with the IDAS ledgers ([`Ledgered`]), one
//!   observation root after the owners' event roots ([`Observed`]), and every
//!   callback timed ([`Metered`]). None of the wrappers changes a step.
//! - **Stops.** Outputs every `output_s` by stock IDA_NORMAL targets;
//!   credited observations every `observation_s` strictly inside each output
//!   interval by the observation root; forced stops (stock tstop) at the
//!   owners' time events, the declared commands and the window's end.
//! - **Restarts.** Every command, time event and located owner root is one
//!   `discrete_restart` (transactions, bound placement, identity, the exact
//!   consistent start on the block Jacobian, IDAReInit with dcj, the Newton
//!   coefficient and the first step), the ledger carried by stock
//!   IDAQuadReInit; the conservation record is sampled on both sides. At the
//!   window's end of a run with a continuation, H1's restart, then no cap.
//! - **Samples.** At every output and observation: the account (one joined
//!   evaluation; the identities judged), the credited outputs read from that
//!   evaluation, and D3 (a) at the state; at every output, the ledger
//!   closures. Under S2-D23 a state outside the original kinetics domain
//!   ends the run there: "domain exit at t = …", a declared exit.
//! - **Caps.** Solver CPU against `solver_cap_s` and the run's process CPU
//!   against `total_guard_s` after every `IDASolve` call; reaching either
//!   fails the run, unless the spec reports caps only (R0, smoke runs), which
//!   record where each was reached. `LD01_S2_RUN_CPU_GUARD_S` is an outer
//!   process-CPU guard for smoke runs (never a declared value).
//! - **CPU.** [`super::meter::Attribution`] per call (see its module).
use super::{
    compare::Credited,
    compose::{Composed, START_BOUND, error_weights},
    conservation::Conservation,
    gates::Declaration,
    meter::{Attribution, Metered, Tally, jacobian_by_kind},
    outputs::{Reader, admit},
    run::{CpuBuckets, RunRecord, RunSpec},
};
use crate::{
    counts::Counts,
    cpu::{process_cpu_s, thread_cpu_s},
    observe::Observed,
};
use leitbild_operating_plant::joined::post_trip_domain::{Domain, Error as DomainError, Extension};
use leitbild_operating_water::{
    If97,
    ida::{Advance, Ida, Initial},
    joined::{
        Discrete, Integrated, JoinedSystem, Matrices, Restart, Restarted, consistent_start,
        discrete_restart,
    },
    joined_ledger::{self, Ledgered, Segment},
};
use serde_json::{Value, json};
use std::{cell::Cell, collections::BTreeMap, rc::Rc};

type System = Metered<Observed<Ledgered<If97>>>;
/// The run's inventories at a state (the account plan's, at the run's
/// tolerances).
type Inventory<'a> = dyn Fn(&Ida<System>, &[f64]) -> Result<Vec<leitbild_operating_plant::joined::account::Held>, String>
    + 'a;

/// A run's starting state.
#[derive(Clone, Debug)]
pub struct Start {
    pub t: f64,
    pub y: Vec<f64>,
    pub yp: Vec<f64>,
    pub from: String,
}

/// Cumulative counts and CPU at one output.
#[derive(Clone, Copy, Debug, Default)]
pub struct Mark {
    pub t: f64,
    pub counts: Counts,
    pub solver_s: f64,
    pub process_s: f64,
    pub observation_s: f64,
}

/// What a run produced: its schema record and the series its judgements
/// read.
pub struct Run {
    pub record: RunRecord,
    pub origin: f64,
    /// Credited outputs at every output and observation (the observation
    /// grid when observed, else the output grid).
    pub credited: Credited,
    pub series_dt: f64,
    pub marks: Vec<Mark>,
    /// Located seat time per cluster index.
    pub seats: BTreeMap<usize, f64>,
    /// The final state (time, y, y').
    pub end: Start,
    pub attribution: Attribution,
    pub conservation_pass: bool,
}

/// The restart configuration from `ld01-s2-gates` (G13, K4).
pub fn restart_configuration(d: &Declaration) -> Restart {
    let g = &d.gates;
    let check = g.number("/restarts/afterOwnerTransaction/constraintCheck");
    assert_eq!(
        check, START_BOUND,
        "the declared constraint check is the exact start's bound"
    );
    g.text("/restarts/afterOwnerTransaction/wrmsBoundExcludes");
    Restart {
        newton_coefficient: g.number("/newtonCoefficient"),
        delta_cj_lsetup: g.number("/deltaCjLSetup"),
        first_step_s: g.number("/restartInitialStep_s"),
        start_bound: START_BOUND,
        start_passes: g.count("/restarts/ordinaryPasses") as usize,
        transaction_passes: g.count("/restarts/afterOwnerTransaction/maxPasses") as usize,
        bound_placement: START_BOUND,
    }
}

/// Observation times `origin + j dt` strictly inside output intervals.
struct Clock {
    next: Rc<Cell<f64>>,
    origin: f64,
    dt: f64,
    per_output: usize,
    end: usize,
    never: f64,
    j: usize,
}
impl Clock {
    fn new(origin: f64, dt: f64, output_s: f64, span_s: f64, never: f64) -> Self {
        let mut c = Self {
            next: Rc::new(Cell::new(never)),
            origin,
            dt,
            per_output: (output_s / dt).round() as usize,
            end: (span_s / dt).round() as usize,
            never,
            j: 0,
        };
        c.arm();
        c
    }
    fn arm(&mut self) {
        self.j += 1;
        while self.j.is_multiple_of(self.per_output) {
            self.j += 1;
        }
        self.next.set(if self.j < self.end {
            self.origin + self.j as f64 * self.dt
        } else {
            self.never
        });
    }
}

/// A restart instant's kinds, from its transactions' receipts (as the
/// S2-10 probe names them) and the located roots.
fn kinds(done: &Restarted, discrete: &str) -> (Vec<String>, Vec<(String, f64)>, Value) {
    let mut kinds = Vec::new();
    let mut seats = Vec::new();
    let mut events = Vec::new();
    let push = |k: &str, kinds: &mut Vec<String>| {
        if !kinds.iter().any(|x| x == k) {
            kinds.push(k.to_string());
        }
    };
    for tr in &done.transactions {
        let r = &tr.receipt;
        if let Some(list) = r["rods"].as_array() {
            for e in list {
                match e["event"].as_str() {
                    Some("grip release") => push("opening", &mut kinds),
                    Some("seat") => {
                        push("rod seat group", &mut kinds);
                        if let (Some(c), Some(t)) = (e["cluster"].as_str(), e["t_s"].as_f64()) {
                            seats.push((c.to_string(), t));
                        }
                    }
                    Some("lift-off") => push("rod lift-off", &mut kinds),
                    _ => push("other", &mut kinds),
                }
            }
        } else if let Some(list) = r["relief"].as_array() {
            push("relief", &mut kinds);
            events.extend(list.iter().cloned());
        } else if r["event"] == "STOP ramp end" {
            push("ramp end", &mut kinds);
        } else if r["command"].is_string() || r["turbine_trip_s"].is_number() {
            push("command", &mut kinds);
        } else {
            push("other", &mut kinds);
            events.push(r.clone());
        }
    }
    if kinds.is_empty() {
        push(discrete, &mut kinds);
    }
    (kinds, seats, json!(events))
}

/// A segment's stock counters since its IDAReInit; a segment that made no
/// residual call did no work (stock resets the Jacobian count only at the
/// next linear setup, so its count would be the previous segment's).
fn worked(stats: &leitbild_operating_water::ida::Stats) -> Counts {
    if stats.residuals == 0 {
        Counts::default()
    } else {
        Counts::of(stats)
    }
}

/// The run's D3 (a) record (S2-D23).
#[derive(Default)]
struct DomainRecord {
    samples: u64,
    worst_pivot: Option<f64>,
    margin_failures: u64,
    first_margin_hold: Option<f64>,
    exit: Option<Value>,
}

/// One run from `start` on the fresh composition `c` under `spec`.
/// `settled` (settling runs) is asked at each whole simulated second
/// whether the run may stop.
#[allow(clippy::too_many_arguments)] // One run: composition, start, spec, declaration and readers.
pub fn advance(
    d: &Declaration,
    c: Composed,
    start: &Start,
    spec: &RunSpec,
    reader: &Reader,
    extension: &Extension,
    mut settled: Option<&mut dyn FnMut(&Credited) -> bool>,
) -> Run {
    let process0 = process_cpu_s();
    let thread0 = thread_cpu_s();
    let restart = restart_configuration(d);
    let outer_guard: Option<f64> = std::env::var("LD01_S2_RUN_CPU_GUARD_S")
        .ok()
        .map(|v| v.parse().expect("LD01_S2_RUN_CPU_GUARD_S"));
    let Composed {
        mut joined,
        ids,
        network_ids,
        atol,
        rtol,
        structure,
        mut analyses,
        ..
    } = c;
    let atol: Vec<f64> = atol.iter().map(|a| a * spec.atol_factor).collect();
    let _contract_rtol = rtol;
    let rtol = spec.rtol;
    let mut attribution = Attribution::default();
    let mut record = RunRecord {
        spec: Some(spec.clone()),
        clock: "thread CPU of the run's thread (CLOCK_THREAD_CPUTIME_ID) by bucket; process CPU (CLOCK_PROCESS_CPUTIME_ID) in total".into(),
        ..RunRecord::default()
    };
    let t0 = start.t;
    let end = t0 + spec.duration_s;
    let window_end = t0 + spec.window_s;
    let continuation = spec.window_s < spec.duration_s && spec.max_step_s.is_some();
    // The exact consistent start at the run's start state.
    let (mut y, mut yp) = (start.y.clone(), start.yp.clone());
    let started = thread_cpu_s();
    let weights = error_weights(&y, rtol, &atol);
    let first = consistent_start(
        &mut joined,
        Matrices::Blocks {
            structure: &structure,
            analyses: &mut analyses,
        },
        t0,
        &mut y,
        &ids,
        &weights,
        START_BOUND,
        restart.start_passes,
    );
    let first_cpu = thread_cpu_s() - started;
    attribution.restart(first_cpu, 0);
    let (yp_start, report) = match first {
        Ok(v) => v,
        Err(e) => {
            record.failure = Some(format!("exact consistent start at {t0} s: {e:?}"));
            record.process_cpu_s = process_cpu_s() - process0;
            return Run {
                record,
                origin: t0,
                credited: Credited::default(),
                series_dt: spec.output_s,
                marks: Vec::new(),
                seats: BTreeMap::new(),
                end: start.clone(),
                attribution,
                conservation_pass: false,
            };
        }
    };
    yp.copy_from_slice(&yp_start);
    record.restarts.push(json!({"t_s": 0., "kind": "start", "discrete": "start", "from": start.from,
        "start": {"residual": report.residual.value, "constraint_rate": report.constraint_rate.value,
            "correction_wrms": report.correction_wrms, "projection_passes": report.projection_passes,
            "rate_passes": report.rate_passes, "analyses_made": report.analyses}, "cpu_s": first_cpu}));
    let nonnegative = joined.network.nonnegative_stocks();
    let integrated = Integrated::from_blocks(joined, structure, analyses).expect("integrated");
    let ledgered = Ledgered::new(integrated, thread_cpu_s).expect("ledgered system");
    let ledger_names = ledgered.names();
    let mut clock = spec
        .observation_s
        .map(|dt| Clock::new(t0, dt, spec.output_s, spec.duration_s, end + 1e6));
    let observed = Observed::after_roots(ledgered, clock.as_ref().map(|c| c.next.clone()));
    let mut ida: Ida<System> = Ida::new(
        Metered::new(observed),
        Initial {
            time: t0,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: rtol,
        },
    )
    .expect("stock IDAS");
    ida.set_max_order(spec.max_order).unwrap();
    ida.constrain_nonnegative(&nonnegative).unwrap();
    restart.configure(&mut ida).unwrap();
    ida.set_nonlinear_convergence_coefficient(spec.newton_coefficient)
        .unwrap();
    ida.set_delta_cj_lsetup(spec.delta_cj_lsetup).unwrap();
    ida.set_init_step(spec.first_step_s).unwrap();
    if let Some(h) = spec.max_step_s {
        ida.set_max_step(h).unwrap();
    }
    let mut segment = joined_ledger::start_ledger(&mut ida, t0, vec![0.; ledger_names.len()])
        .expect("ledger start");
    let plan = ida.system().inner.inner.plan.clone();
    let inventory = |ida: &Ida<System>, y: &[f64]| {
        plan.inventory(&ida.system().integrated().joined, y, &atol, rtol)
            .map_err(|e| format!("inventory: {e:?}"))
    };
    let held0 = inventory(&ida, &y).expect("inventory at the start");
    let mut conservation =
        Conservation::new(&d.gates, plan.clone(), held0, segment.started_q.clone());
    let mut credited = Credited::default();
    let mut marks: Vec<Mark> = Vec::new();
    let mut seats: BTreeMap<usize, f64> = BTreeMap::new();
    let cluster_index: BTreeMap<String, usize> = {
        let rods = ida.system().integrated().joined.layouts();
        rods.iter()
            .find(|(o, _)| *o == "rods")
            .map(|(_, l)| {
                l.labels
                    .iter()
                    .filter_map(|x| {
                        x.strip_prefix("y[")
                            .map(|v| v.trim_end_matches(']').to_string())
                    })
                    .enumerate()
                    .map(|(i, id)| (id, i))
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut domain = DomainRecord::default();
    let mut totals = Counts::default();
    let mut window_counts: Option<Counts> = None;
    let mut cap_reached_at: Option<f64> = None;
    let mut guard_reached_at: Option<f64> = None;
    let mut step_cap_reached_at: Option<f64> = None;
    let mut part = 0usize;

    // One accepted sample: account, credited outputs, D3; at outputs the
    // ledger closure and a mark.
    #[allow(clippy::too_many_arguments)] // The sample's state and every record it feeds.
    fn sample(
        ida: &mut Ida<System>,
        segment: &Segment,
        t: f64,
        y: &[f64],
        yp: &[f64],
        output: bool,
        record_series: bool,
        reader: &Reader,
        extension: &Extension,
        rods: bool,
        conservation: &mut Conservation,
        credited: &mut Credited,
        domain: &mut DomainRecord,
        attribution: &mut Attribution,
        inventory: &Inventory<'_>,
    ) -> Result<(), String> {
        let started = thread_cpu_s();
        let account = ida
            .system_mut()
            .inner
            .inner
            .account(t, y, yp)
            .map_err(|e| format!("account at {t} s: {e}"))?;
        conservation.sample(t, &account);
        let joined = &ida.system().integrated().joined;
        if record_series {
            let values = reader.read(joined, y, rods)?;
            credited.push(t, &values)?;
        }
        domain.samples += 1;
        match admit(joined, extension, t) {
            Ok(a) => {
                let pivot = a
                    .margin
                    .pivots
                    .iter()
                    .copied()
                    .fold(f64::INFINITY, f64::min);
                domain.worst_pivot = Some(domain.worst_pivot.map_or(pivot, |p| p.min(pivot)));
                domain.margin_failures += u64::from(!a.margin.holds);
                if a.margin.holds && domain.first_margin_hold.is_none() {
                    domain.first_margin_hold = Some(t);
                }
                if a.domain != Domain::Original && domain.exit.is_none() {
                    domain.exit = Some(
                        json!({"t_s": t, "domain": a.domain, "margin_holds": a.margin.holds,
                        "reason": "outside the original kinetics domain (S2-D23: no post-trip extension)"}),
                    );
                }
            }
            Err(DomainError::Unsupported {
                domain: dm,
                margin_holds,
                exit,
            }) => {
                if domain.exit.is_none() {
                    domain.exit =
                        Some(json!({"t_s": t, "domain": dm, "margin_holds": margin_holds,
                        "reason": format!("source-domain exit: {exit:?}")}));
                }
            }
            Err(e) => return Err(format!("D3 (a) at {t} s: {e}")),
        }
        attribution.observation_handler_s += thread_cpu_s() - started;
        if output {
            let started = thread_cpu_s();
            let q = joined_ledger::ledger_at(ida, segment, t)?;
            let held = inventory(ida, y)?;
            conservation.output(t, &held, &q);
            attribution.account_s += thread_cpu_s() - started;
        }
        Ok(())
    }
    // A conservation-only sample on one side of a restart.
    let side = |ida: &mut Ida<System>,
                t: f64,
                y: &[f64],
                yp: &[f64],
                conservation: &mut Conservation,
                attribution: &mut Attribution|
     -> Result<(), String> {
        let started = thread_cpu_s();
        let account = ida
            .system_mut()
            .inner
            .inner
            .account(t, y, yp)
            .map_err(|e| format!("account at {t} s: {e}"))?;
        conservation.sample(t, &account);
        attribution.account_s += thread_cpu_s() - started;
        Ok(())
    };
    let rods = spec.rods_observed;
    let mut failure: Option<String> = None;
    let mut exit: Option<String> = None;
    let mut outputs = 0usize;
    let mut observations = 0usize;
    // The start sample.
    if let Err(e) = sample(
        &mut ida,
        &segment,
        t0,
        &y,
        &yp,
        true,
        true,
        reader,
        extension,
        rods,
        &mut conservation,
        &mut credited,
        &mut domain,
        &mut attribution,
        &inventory,
    ) {
        failure = Some(e);
    }
    outputs += 1;
    marks.push(Mark {
        t: t0,
        counts: Counts::default(),
        solver_s: attribution.solver_s(),
        process_s: process_cpu_s() - process0,
        observation_s: attribution.observation(),
    });
    let mut commands: Vec<(f64, leitbild_operating_plant::joined::block::Command)> =
        spec.commands.iter().map(|(s, c)| (t0 + s, *c)).collect();
    commands.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut t = t0;
    let mut k = 1usize;
    // One discrete restart at `t`, the ledger carried.
    macro_rules! restart_at {
        ($discrete:expr, $name:expr) => {{
            totals = totals.plus(worked(&ida.stats().expect("stats")));
            if let Err(e) = side(&mut ida, t, &y, &yp, &mut conservation, &mut attribution) {
                failure = Some(e);
            }
            let carried = joined_ledger::ledger_at(&ida, &segment, t).expect("ledger at the restart");
            let started = thread_cpu_s();
            let outcome = discrete_restart(&mut ida, t, $discrete, &mut y, &network_ids, &atol, rtol, &restart);
            match outcome {
                Ok(done) => {
                    segment = joined_ledger::restart_ledger(&mut ida, t, carried).expect("ledger re-init");
                    conservation.restarted(t);
                    ida.set_max_order(spec.max_order).unwrap();
                    ida.set_nonlinear_convergence_coefficient(spec.newton_coefficient).unwrap();
                    ida.set_init_step(spec.first_step_s).unwrap();
                    if part == 0 {
                        if let Some(h) = spec.max_step_s {
                            ida.set_max_step(h).unwrap();
                        }
                    }
                    yp.copy_from_slice(&done.yp);
                    let cpu = thread_cpu_s() - started;
                    attribution.restart(cpu, part);
                    let (kinds, located, events) = kinds(&done, $name);
                    for (id, at) in &located {
                        if let Some(c) = cluster_index.get(id) {
                            seats.insert(*c, *at);
                        }
                    }
                    let r = &done.report;
                    record.restarts.push(json!({"t_s": t - t0, "kind": kinds.join(" + "), "kinds": kinds, "discrete": $name,
                        "transactions": done.transactions.len(), "placements": done.placements.len(), "events": events,
                        "seated": located.len(),
                        "start": {"residual": r.residual.value, "constraint_rate": r.constraint_rate.value,
                            "correction_wrms": r.correction_wrms, "projection_passes": r.projection_passes,
                            "rate_passes": r.rate_passes, "analyses_made": r.analyses,
                            "klu_wall_s": {"analyze": r.analyze_s.iter().sum::<f64>(), "factor": r.factor_s.iter().sum::<f64>(), "solve": r.solve_s.iter().sum::<f64>()},
                            "assembly_wall_s": r.jacobian_s.iter().sum::<f64>()},
                        "cpu_s": cpu, "ledger_reinitialised": true}));
                    if let Err(e) = side(&mut ida, t, &y, &yp, &mut conservation, &mut attribution) {
                        failure = Some(e);
                    }
                }
                Err(e) => {
                    attribution.restart(thread_cpu_s() - started, part);
                    failure = Some(format!("{} restart at {} s: {e}", $name, t - t0));
                }
            }
        }};
    }
    // Commands due at the start.
    while failure.is_none() && commands.first().is_some_and(|(at, _)| *at <= t0) {
        let (_, command) = commands.remove(0);
        restart_at!(Discrete::Command(command), "command");
    }
    let mut boundary_set: Option<f64> = None;
    let trace = std::env::var_os("LD01_S2_TRACE").is_some();
    while failure.is_none() && exit.is_none() && t < end {
        // The next forced stop: time event, command, window end, run end.
        let event = ida.system().integrated().joined.next_time_event(t);
        let mut boundary = end;
        if let Some(e) = event {
            boundary = boundary.min(e);
        }
        if let Some((at, _)) = commands.first() {
            boundary = boundary.min(*at);
        }
        if part == 0 && continuation {
            boundary = boundary.min(window_end);
        }
        if boundary_set != Some(boundary) {
            ida.stop_at(boundary).expect("stop boundary");
            boundary_set = Some(boundary);
        }
        let target = (t0 + k as f64 * spec.output_s).min(boundary);
        let steps0 = ida.stats().expect("stats").steps;
        let tally0: Tally = ida.system().tally;
        let c0 = thread_cpu_s();
        let outcome = ida.advance(target, &mut y, &mut yp);
        if trace {
            eprintln!(
                "trace t={t:.17} k={k} target={target:.17} boundary={boundary:.17} event={event:?} outcome={:?}",
                outcome.as_ref().map(|o| match o {
                    Advance::Reached(x) => format!("reached {x:.17}"),
                    Advance::Root { time, directions } => format!(
                        "root {time:.17} {}",
                        directions.iter().filter(|d| **d != 0).count()
                    ),
                })
            );
        }
        let call = thread_cpu_s() - c0;
        let tally = ida.system().tally.since(tally0);
        let stats = ida.stats().expect("stats");
        let stepped = stats.steps != steps0;
        match outcome {
            Err(e) => {
                attribution.call(call, tally, false, part);
                let refusal = ida.system().inner.inner.refusal.clone();
                failure = Some(format!(
                    "stock IDA at {} s (target {target}, boundary {boundary}, time event {event:?}): {e}; ledger refusal {refusal:?}",
                    t - t0
                ));
            }
            Ok(Advance::Reached(time)) => {
                attribution.call(call, tally, false, part);
                t = time;
                let on_output = (t - (t0 + k as f64 * spec.output_s)).abs() <= 1e-9;
                if on_output {
                    if let Err(e) = sample(
                        &mut ida,
                        &segment,
                        t,
                        &y,
                        &yp,
                        true,
                        true,
                        reader,
                        extension,
                        rods,
                        &mut conservation,
                        &mut credited,
                        &mut domain,
                        &mut attribution,
                        &inventory,
                    ) {
                        failure = Some(e);
                    }
                    outputs += 1;
                    k += 1;
                    marks.push(Mark {
                        t,
                        counts: totals.plus(worked(&stats)),
                        solver_s: attribution.solver_s(),
                        process_s: process_cpu_s() - process0,
                        observation_s: attribution.observation(),
                    });
                    if let Some(f) = settled.as_mut() {
                        let whole = ((t - t0) - (t - t0).round()).abs() < 1e-9;
                        if whole && f(&credited) {
                            exit = Some(format!("settled at t = {} s", t - t0));
                        }
                    }
                }
                if failure.is_none() && t == boundary && t < end {
                    boundary_set = None;
                    if event.is_some_and(|e| e == t) {
                        restart_at!(Discrete::TimeEvent, "time event");
                    }
                    while failure.is_none() && commands.first().is_some_and(|(at, _)| *at <= t) {
                        let (_, command) = commands.remove(0);
                        restart_at!(Discrete::Command(command), "command");
                    }
                    if failure.is_none() && part == 0 && continuation && t >= window_end {
                        window_counts = Some(totals.plus(worked(&ida.stats().expect("stats"))));
                        part = 1;
                        ida.remove_max_step().unwrap();
                        restart_at!(Discrete::TimeEvent, "H1");
                    }
                }
            }
            Ok(Advance::Root { time, directions }) => {
                t = time;
                let (own, observation) = ida.system().inner.split(&directions);
                let own_rooted = own.iter().any(|d| *d != 0);
                let own: Vec<i32> = own.to_vec();
                attribution.call(call, tally, observation && !own_rooted && !stepped, part);
                // An owner root located on an output time is that output.
                let on_output = (t - (t0 + k as f64 * spec.output_s)).abs() <= 1e-9;
                if observation || on_output {
                    if let Err(e) = sample(
                        &mut ida,
                        &segment,
                        t,
                        &y,
                        &yp,
                        on_output,
                        true,
                        reader,
                        extension,
                        rods,
                        &mut conservation,
                        &mut credited,
                        &mut domain,
                        &mut attribution,
                        &inventory,
                    ) {
                        failure = Some(e);
                    }
                    if on_output {
                        outputs += 1;
                        k += 1;
                        marks.push(Mark {
                            t,
                            counts: totals.plus(worked(&stats)),
                            solver_s: attribution.solver_s(),
                            process_s: process_cpu_s() - process0,
                            observation_s: attribution.observation(),
                        });
                    } else {
                        observations += 1;
                    }
                    if observation && let Some(c) = clock.as_mut() {
                        c.arm();
                    }
                }
                if own_rooted && failure.is_none() {
                    boundary_set = None;
                    restart_at!(Discrete::Roots(&own), "roots");
                }
            }
        }
        if let Some(x) = &domain.exit
            && exit.is_none()
        {
            exit = Some(format!(
                "domain exit at t = {} s",
                x["t_s"].as_f64().unwrap_or(t) - t0
            ));
        }
        // Caps and guards after every call.
        let solver = attribution.solver_s();
        let process = process_cpu_s() - process0;
        let steps = totals.plus(worked(&ida.stats().expect("stats"))).steps;
        if cap_reached_at.is_none() && solver > spec.solver_cap_s {
            cap_reached_at = Some(t - t0);
        }
        if guard_reached_at.is_none() && process > spec.total_guard_s {
            guard_reached_at = Some(t - t0);
        }
        if let Some(n) = spec.report_only_step_cap
            && step_cap_reached_at.is_none()
            && steps > n
        {
            step_cap_reached_at = Some(t - t0);
        }
        if !spec.caps_report_only && (cap_reached_at.is_some() || guard_reached_at.is_some()) {
            record.cap_reached = true;
            failure = Some(format!(
                "{} reached at {} s",
                if cap_reached_at.is_some() {
                    "solver-CPU cap"
                } else {
                    "total guard"
                },
                t - t0
            ));
        }
        if failure.is_none() && outer_guard.is_some_and(|g| process > g) {
            failure = Some(format!(
                "the smoke's outer CPU guard {} s (LD01_S2_RUN_CPU_GUARD_S) reached at {} s",
                outer_guard.unwrap(),
                t - t0
            ));
        }
    }
    totals = totals.plus(worked(&ida.stats().expect("stats")));
    if continuation && window_counts.is_none() {
        window_counts = Some(totals);
    }
    // The run's CPU by bucket.
    let process = process_cpu_s() - process0;
    let thread = thread_cpu_s() - thread0;
    let joined = &ida.system().integrated().joined;
    let counters = joined.counters;
    let coupler = joined.coupler_counters();
    let a = &attribution;
    let measured = a.solver_internals_s
        + a.residual.1
        + a.jacobian.1
        + a.roots.1
        + a.quadrature.1
        + a.consistent_start_s
        + a.observation()
        + a.account_s;
    let priced = d
        .gates
        .value
        .pointer("/projection/unitCosts")
        .cloned()
        .unwrap_or(Value::Null);
    record.cpu = CpuBuckets {
        solver_internals_s: a.solver_internals_s,
        residual_s: a.residual.1,
        jacobian_s: a.jacobian.1,
        jacobian_by_kind: jacobian_by_kind(
            a.jacobian.1,
            counters.jacobian_wall_s,
            counters.jacobians,
            coupler,
        ),
        klu_analyze_and_factor_s: None,
        klu_refactor_s: None,
        klu_solve_s: None,
        klu_note: json!({"attributed_in": "solver_internals_s",
            "why": "stock KLU's analyze, factor, refactor and solve run inside IDASolve; separating them needs a timing shim on the SUNLinSol_KLU ops in the lead-owned src/ida.c (S2-D16), proposed by HARNESS-B",
            "linear_setups": totals.linear_setups, "nonlinear_iterations": totals.nonlinear_iterations,
            "declared_unit_costs": priced}),
        consistent_start_s: a.consistent_start_s,
        root_s: a.roots.1,
        observation_s: a.observation(),
        ledger_s: a.quadrature.1,
        account_s: a.account_s,
        harness_s: thread - measured,
    };
    record.process_cpu_s = process;
    record.reached_s = t - t0;
    record.failure = failure;
    record.exit = exit;
    record.counts = totals;
    record.window_counts = window_counts;
    record.continuation_counts = window_counts
        .filter(|_| continuation)
        .map(|w| totals.since(w));
    record.outputs = outputs;
    record.observations = observations;
    record.identities = conservation.identities_json();
    record.ledger = conservation.ledger_json();
    record.caps = json!({"solver_cap_s": spec.solver_cap_s, "total_guard_s": spec.total_guard_s,
        "report_only": spec.caps_report_only, "solver_cap_reached_at_s": cap_reached_at,
        "total_guard_reached_at_s": guard_reached_at, "report_only_step_cap": spec.report_only_step_cap,
        "step_cap_reached_at_s": step_cap_reached_at, "outer_guard_s": outer_guard,
        "solver_s": attribution.solver_s(), "process_s": process,
        "solver_by_part_s": {"window": attribution.solver_by_part[0] + attribution.restarts_by_part[0],
            "after_window": attribution.solver_by_part[1] + attribution.restarts_by_part[1]},
        "solver_calls": attribution.solver_calls.0, "observation_returns": attribution.observation_returns.0,
        "rule": "solver CPU (G11) = IDASolve calls that advanced the step count or returned at an owner root, less the ledger quadrature, plus discrete restarts; checked against the cap after every call; the total guard against the run's process CPU"});
    record.domain = json!({"predicate": "joined::post_trip_domain::admit_accepted at every accepted sample (S2-D23: no post-trip extension; leaving the original domain ends the run)",
        "samples": domain.samples, "worst_pivot": domain.worst_pivot,
        "samples_margin_not_holding": domain.margin_failures,
        "first_margin_holds_at_s": domain.first_margin_hold.map(|x| x - t0),
        "margin_note": "the 1 % shutdown-margin test of the source-free operator; at power (critical) it does not hold, and it is reported, not a stop",
        "exit": domain.exit});
    let conservation_pass = conservation.identities_pass() && conservation.ledger_pass();
    let series_dt = spec.observation_s.unwrap_or(spec.output_s);
    record.credited = json!({"series_dt_s": series_dt, "samples": credited.len(),
        "keys": credited.outputs.iter().map(|(k, v)| (k.clone(), json!(v.len()))).collect::<serde_json::Map<_, _>>(),
        "seats": seats.len()});
    Run {
        record,
        origin: t0,
        credited,
        series_dt,
        marks,
        seats,
        end: Start {
            t,
            y,
            yp,
            from: format!("the end of {}", spec.name),
        },
        attribution,
        conservation_pass,
    }
}
