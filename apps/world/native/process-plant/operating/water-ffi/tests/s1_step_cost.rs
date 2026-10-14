//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#s1-declaration-hydraulics-admission
//! Step-cost attribution of the declared S1 settling start, in thread CPU
//! time. A measurement only, NOT S1 evidence: the first simulated second from
//! the S1 prepared state is advanced with the declared configuration, and
//! callbacks and property queries are timed by delegating wrappers. Colored
//! Jacobians are then replayed at the recorded states, split into their base
//! evaluation, seeded passes and scatter, and checked bit for bit against the
//! production assembly. Nothing here is a production path.
#![cfg(all(feature = "ida", target_os = "macos"))]
use leitbild_operating_plant::{
    network::{
        BandReport, MetastableBand, Network, Properties, RotorState, SparseJacobian,
        ToleranceClasses, Water,
        packet::Packet,
        prepare::{self, OperatingPoint, Settings},
    },
    rotor::{Shaft, SpeedRequest, Support},
    sparse::{self, Coloring, Pattern},
    thermal::{Saturation, Scalar},
};
use leitbild_operating_water::{
    CaloricLinearization, If97,
    ida::{Failure, Ida, Initial, System},
    network::Integrated,
};
use serde_json::{Value, json};
use std::{cell::RefCell, rc::Rc};

// Thread CPU (CLOCK_THREAD_CPUTIME_ID) and the performance-core request
// (macOS QOS_CLASS_USER_INTERACTIVE), which change no computation.
#[path = "common/cpu.rs"]
mod clock;
use clock::{prefer_performance_core, thread_cpu_s as cpu};

#[derive(Clone, Copy, Debug, Default)]
struct Tally {
    calls: u64,
    cpu: f64,
}
impl Tally {
    fn add(&mut self, seconds: f64) {
        self.calls += 1;
        self.cpu += seconds;
    }
    fn json(self) -> Value {
        json!({"calls": self.calls, "cpu_s": self.cpu,
            "per_call_us": if self.calls == 0 { 0. } else { 1e6 * self.cpu / self.calls as f64 }})
    }
}

/// Property queries by kind, in residual (0) or Jacobian (1) callbacks.
#[derive(Default)]
struct Ledger {
    in_jacobian: bool,
    caloric: [Tally; 2],
    direction: [Tally; 2],
    saturation_value: [Tally; 2],
    saturation_direction: [Tally; 2],
    forward: [Tally; 2],
    residual: Tally,
    jacobian: Tally,
    states: Vec<(f64, f64, Vec<f64>, Vec<f64>)>,
    matrices: Vec<Vec<f64>>,
    structure: Option<(Vec<i64>, Vec<i64>)>,
}
type Shared = Rc<RefCell<Ledger>>;

/// Delegates every query to the maintained IF97 adapter, unchanged.
struct Timed(Shared);
impl Timed {
    fn time<T>(&self, pick: fn(&mut Ledger) -> &mut [Tally; 2], f: impl FnOnce() -> T) -> T {
        let started = cpu();
        let result = f();
        let spent = cpu() - started;
        let mut ledger = self.0.borrow_mut();
        let context = usize::from(ledger.in_jacobian);
        pick(&mut ledger)[context].add(spent);
        result
    }
}
impl Properties for Timed {
    type Caloric = CaloricLinearization;
    fn forward(&self, vapor: bool, p: f64, t: f64) -> Result<Water, String> {
        self.time(|l| &mut l.forward, || If97.forward(vapor, p, t))
    }
    fn caloric(
        &self,
        vapor: bool,
        p: f64,
        target: f64,
        enthalpy: bool,
    ) -> Result<CaloricLinearization, String> {
        self.time(
            |l| &mut l.caloric,
            || If97.caloric(vapor, p, target, enthalpy),
        )
    }
    fn values(&self, point: &CaloricLinearization) -> Water {
        If97.values(point)
    }
    fn direction(&self, point: &CaloricLinearization, dp: f64, de: f64) -> Result<Water, String> {
        self.time(|l| &mut l.direction, || If97.direction(point, dp, de))
    }
    fn metastable_band(&self) -> Result<MetastableBand, String> {
        If97.metastable_band()
    }
    fn band(&self, point: &CaloricLinearization) -> BandReport {
        If97.band(point)
    }
    fn saturation(&self, pressure: Scalar) -> Result<Saturation, String> {
        if pressure.direction == 0. {
            self.time(
                |l| &mut l.saturation_value,
                || Properties::saturation(&If97, pressure),
            )
        } else {
            self.time(
                |l| &mut l.saturation_direction,
                || Properties::saturation(&If97, pressure),
            )
        }
    }
}

/// Delegates the stock-IDA callbacks unchanged; times them and records the
/// Jacobian states and iteration matrices for replay.
struct TimedSystem {
    inner: Integrated<Timed>,
    ledger: Shared,
}
impl System for TimedSystem {
    fn dimension(&self) -> usize {
        self.inner.dimension()
    }
    fn nonzeros(&self) -> usize {
        self.inner.nonzeros()
    }
    fn root_count(&self) -> usize {
        self.inner.root_count()
    }
    fn residual(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        let started = cpu();
        let result = self.inner.residual(t, y, yp, out);
        let spent = cpu() - started;
        self.ledger.borrow_mut().residual.add(spent);
        result
    }
    fn jacobian(
        &mut self,
        t: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        data: &mut [f64],
        rows: &mut [i64],
        pointers: &mut [i64],
    ) -> Result<(), Failure> {
        self.ledger.borrow_mut().in_jacobian = true;
        let started = cpu();
        let result = self.inner.jacobian(t, cj, y, yp, data, rows, pointers);
        let spent = cpu() - started;
        let mut ledger = self.ledger.borrow_mut();
        ledger.in_jacobian = false;
        ledger.jacobian.add(spent);
        ledger.states.push((t, cj, y.to_vec(), yp.to_vec()));
        ledger.matrices.push(data.to_vec());
        ledger
            .structure
            .get_or_insert_with(|| (rows.to_vec(), pointers.to_vec()));
        result
    }
    fn roots(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        self.inner.roots(t, y, yp, out)
    }
}

/// The single JSON object inside one fenced strict block of a wiki page.
fn strict_block(page: &str, fence: &str) -> Value {
    let text = std::fs::read_to_string(page).unwrap_or_else(|e| panic!("{page}: {e}"));
    let open = format!("```{fence}\n");
    let start = text.find(&open).expect("strict block") + open.len();
    let end = start + text[start..].find("\n```").expect("unterminated block");
    serde_json::from_str(&text[start..end]).expect("strict block JSON")
}

struct Declared {
    packet: Packet,
    gates: Value,
}
/// Network, initial y and y', differential ids and absolute tolerances.
type Prepared = (Network<Timed>, Vec<f64>, Vec<f64>, Vec<f64>, Vec<f64>);
impl Declared {
    fn load() -> Self {
        let packet_path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET").unwrap();
        let wiki = std::env::var("LD01_WIKI_ROOT").unwrap();
        let gates = strict_block(
            &format!(
                "{wiki}/world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md"
            ),
            "ld01-s1-gates",
        );
        let packet = serde_json::from_slice(&std::fs::read(packet_path).unwrap()).unwrap();
        Self { packet, gates }
    }
    fn gate(&self, path: &[&str]) -> f64 {
        path.iter()
            .fold(&self.gates, |v, k| &v[*k])
            .as_f64()
            .unwrap_or_else(|| panic!("gate {path:?}"))
    }
    /// The S1 harness's prepared state, RCPs at rest, its tolerances and ids.
    fn prepared(&self, ledger: &Shared) -> Prepared {
        let point = OperatingPoint::from(&self.packet.preparation.operating_point);
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
        let (network, prepared, _) = prepare::prepare(
            &self.packet,
            Timed(ledger.clone()),
            &point,
            &rotors,
            &settings,
        )
        .expect("hydrostatic preparation");
        let mut y0 = prepared.y.clone();
        for index in &network.rotor_index {
            y0[*index] = 0.;
        }
        let atol = network
            .absolute_tolerances(
                &y0,
                ToleranceClasses {
                    relative: self.gate(&["relativeTolerance"]),
                    stock_scaled: self.gate(&["stockScaledAbsolute"]),
                    tracer_scaled: self.gate(&["tracerScaledAbsolute"]),
                    rotor_scaled: self.gate(&["rotorScaledAbsolute"]),
                    volume_flow_m3_s: self.gate(&["volumeFlowAbsolute_m3_s"]),
                },
            )
            .expect("tolerances");
        (network, y0, prepared.yp, prepared.differential, atol)
    }
}

struct Settle {
    ledger: Ledger,
    ida_cpu: f64,
    steps: i64,
    residuals: i64,
    jacobians: i64,
    nonlinear_iterations: i64,
    linear_setups: i64,
    reached: f64,
    y: Vec<f64>,
}

/// The S1 settling run's first output: declared order, constraints, stop
/// boundary and IDACalcIC horizon, advanced to t = 1 s.
fn settle(declared: &Declared) -> Settle {
    let ledger: Shared = Rc::default();
    let (network, y0, yp0, ids, atol) = declared.prepared(&ledger);
    let stocks = network.nonnegative_stocks();
    *ledger.borrow_mut() = Ledger::default();
    let system = TimedSystem {
        inner: Integrated::colored(network).expect("colored assembly"),
        ledger: ledger.clone(),
    };
    let (mut y, mut yp) = (y0.clone(), yp0.clone());
    let mut ida = Ida::new(
        system,
        Initial {
            time: 0.,
            y: &y0,
            yp: &yp0,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: declared.gate(&["relativeTolerance"]),
        },
    )
    .expect("stock IDA construction");
    ida.set_max_order(declared.gate(&["maxOrder"]) as usize)
        .expect("max order");
    ida.constrain_nonnegative(&stocks).expect("nonnegative");
    ida.stop_at(declared.gate(&["settling", "maxSimulated_s"]))
        .expect("stop");
    let started = cpu();
    ida.initialize(1., &mut y, &mut yp).expect("IDACalcIC");
    let reached = ida.advance(1., &mut y, &mut yp).expect("advance");
    let ida_cpu = cpu() - started;
    let stats = ida.stats().expect("stats");
    drop(ida);
    let ledger = Rc::try_unwrap(ledger)
        .ok()
        .expect("sole ledger")
        .into_inner();
    Settle {
        ledger,
        ida_cpu,
        steps: stats.steps,
        residuals: stats.residuals,
        jacobians: stats.jacobians,
        nonlinear_iterations: stats.nonlinear_iterations,
        linear_setups: stats.linear_setups,
        reached: reached.reached().expect("no roots"),
        y,
    }
}

/// Production colored assembly versus its replay in four timed parts.
#[derive(Default)]
struct Split {
    production: f64,
    base: f64,
    passes: f64,
    pass_directions: Tally,
    pass_saturation: Tally,
    scatter: f64,
    fresh_residual: f64,
}

fn replay(
    network: &mut Network<Timed>,
    ledger: &Shared,
    structure: &SparseJacobian,
    (t, cj, y, yp): &(f64, f64, Vec<f64>, Vec<f64>),
) -> (Split, Vec<f64>) {
    let mut split = Split::default();
    let mut production = vec![0.; structure.pattern.nonzeros()];
    let started = cpu();
    network
        .jacobian_colored(*t, *cj, y, yp, structure, &mut production)
        .expect("production colored Jacobian");
    split.production = cpu() - started;

    let mut values = vec![0.; production.len()];
    let started = cpu();
    let mut reuse = network.reuse();
    network
        .evaluate(*t, y, yp, None, 0., Some(&mut reuse))
        .expect("base evaluation");
    split.base = cpu() - started;
    let signs = network.column_signs(y);
    let n = y.len();
    let (mut seed, mut directions) = (vec![0.; n], vec![0.; n]);
    let before = {
        let l = ledger.borrow();
        (l.direction[0], l.saturation_direction[0])
    };
    for color in 0..structure.coloring.count() {
        let started = cpu();
        structure
            .coloring
            .seed_into(color, &signs, &mut seed)
            .unwrap();
        network
            .evaluate(*t, y, yp, Some(&seed), *cj, Some(&mut reuse))
            .expect("seeded pass");
        split.passes += cpu() - started;
        for (d, r) in directions.iter_mut().zip(network.rows()) {
            *d = r.direction;
        }
        let started = cpu();
        sparse::scatter(
            &structure.pattern,
            &structure.coloring,
            color,
            &directions,
            &signs,
            &mut values,
        )
        .expect("scatter");
        split.scatter += cpu() - started;
    }
    let l = ledger.borrow();
    let delta = |a: Tally, b: Tally| Tally {
        calls: a.calls - b.calls,
        cpu: a.cpu - b.cpu,
    };
    split.pass_directions = delta(l.direction[0], before.0);
    split.pass_saturation = delta(l.saturation_direction[0], before.1);
    drop(l);
    assert_eq!(
        values.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
        production.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
        "replayed colored assembly differs from production"
    );
    let started = cpu();
    network
        .evaluate(*t, y, yp, None, 0., None)
        .expect("fresh residual");
    split.fresh_residual = cpu() - started;
    (split, production)
}

/// Greedy distance-1 column coloring in a given column order.
fn greedy_in(pattern: &Pattern, order: &[usize]) -> Vec<usize> {
    let mut by_row = vec![Vec::new(); pattern.rows()];
    for c in 0..pattern.columns() {
        for &r in pattern.column(c) {
            by_row[r].push(c);
        }
    }
    let mut colors = vec![usize::MAX; pattern.columns()];
    for &c in order {
        let mut taken: Vec<usize> = pattern
            .column(c)
            .iter()
            .flat_map(|&r| by_row[r].iter().map(|&o| colors[o]))
            .filter(|&k| k != usize::MAX)
            .collect();
        taken.sort_unstable();
        taken.dedup();
        colors[c] = (0..).find(|k| taken.binary_search(k).is_err()).unwrap();
    }
    colors
}
fn csc(pattern: &Pattern) -> (Vec<usize>, usize, Vec<usize>) {
    let (pointers, rows) = pattern.to_i64().expect("pattern");
    (
        rows.iter().map(|&r| r as usize).collect(),
        pattern.columns(),
        pointers.iter().map(|&p| p as usize).collect(),
    )
}

/// Smallest-last order of the column intersection graph (Matula-Beck).
fn smallest_last(pattern: &Pattern) -> Vec<usize> {
    let (indices, columns, pointers) = csc(pattern);
    let mut by_row = vec![Vec::new(); pattern.rows()];
    for c in 0..columns {
        for &r in &indices[pointers[c]..pointers[c + 1]] {
            by_row[r].push(c);
        }
    }
    let neighbours: Vec<Vec<usize>> = (0..columns)
        .map(|c| {
            let mut n: Vec<usize> = indices[pointers[c]..pointers[c + 1]]
                .iter()
                .flat_map(|&r| by_row[r].iter().copied())
                .filter(|&o| o != c)
                .collect();
            n.sort_unstable();
            n.dedup();
            n
        })
        .collect();
    let mut degree: Vec<usize> = neighbours.iter().map(Vec::len).collect();
    let mut removed = vec![false; columns];
    let mut order = Vec::with_capacity(columns);
    for _ in 0..columns {
        let c = (0..columns)
            .filter(|&c| !removed[c])
            .min_by_key(|&c| (degree[c], c))
            .unwrap();
        removed[c] = true;
        order.push(c);
        for &o in &neighbours[c] {
            if !removed[o] {
                degree[o] -= 1;
            }
        }
    }
    order.reverse();
    order
}

#[test]
#[ignore = "requires the S1 packet, the wiki gates, maintained IF97 and stock IDA/KLU; cost report only"]
fn s1_settling_step_cost() {
    prefer_performance_core();
    let declared = Declared::load();
    let budget = declared.gate(&["integratorBudget_cpu_s_per_s"]);
    let step_target = declared.gate(&["projectedFullUnitStep_s"]);
    // Best of three identical runs by IDA thread CPU.
    let runs: Vec<Settle> = (0..3).map(|_| settle(&declared)).collect();
    for r in &runs[1..] {
        assert_eq!(
            (r.steps, r.residuals, r.jacobians),
            (runs[0].steps, runs[0].residuals, runs[0].jacobians)
        );
        assert_eq!(
            r.y.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            runs[0].y.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
        );
    }
    let best = runs
        .iter()
        .min_by(|a, b| a.ida_cpu.total_cmp(&b.ida_cpu))
        .unwrap();
    let l = &best.ledger;
    let callbacks = l.residual.cpu + l.jacobian.cpu;

    // Replay every recorded Jacobian state on a fresh prepared network.
    let ledger: Shared = Rc::default();
    let (mut network, ..) = declared.prepared(&ledger);
    let structure = network.sparse_jacobian().expect("structure");
    let mut totals = Split::default();
    for state in &l.states {
        let splits: Vec<Split> = (0..3)
            .map(|_| replay(&mut network, &ledger, &structure, state).0)
            .collect();
        let min = |f: fn(&Split) -> f64| splits.iter().map(f).fold(f64::INFINITY, f64::min);
        totals.production += min(|s| s.production);
        totals.base += min(|s| s.base);
        totals.passes += min(|s| s.passes);
        totals.scatter += min(|s| s.scatter);
        totals.fresh_residual += min(|s| s.fresh_residual);
        let fastest = splits
            .iter()
            .min_by(|a, b| a.pass_directions.cpu.total_cmp(&b.pass_directions.cpu))
            .unwrap();
        totals.pass_directions.calls += fastest.pass_directions.calls;
        totals.pass_directions.cpu += fastest.pass_directions.cpu;
        totals.pass_saturation.calls += fastest.pass_saturation.calls;
        totals.pass_saturation.cpu += fastest.pass_saturation.cpu;
    }
    let jac = l.states.len() as f64;

    // Coloring alternatives: lower bound, smallest-last order, and their
    // measured production assembly cost at the recorded states.
    let pattern = &structure.pattern;
    let (indices, columns, _) = csc(pattern);
    let mut row_counts = vec![0usize; pattern.rows()];
    for &r in &indices {
        row_counts[r] += 1;
    }
    let lower_bound = row_counts.iter().copied().max().unwrap();
    let mut alternatives = Vec::new();
    let natural: Vec<usize> = (0..columns).collect();
    for (name, order) in [
        ("natural", natural),
        ("smallest-last", smallest_last(pattern)),
    ] {
        let colors = greedy_in(pattern, &order);
        let coloring = Coloring::new(pattern, colors).expect("valid coloring");
        let alternative = SparseJacobian {
            pattern: pattern.clone(),
            coloring,
        };
        let mut cpu_total = 0.;
        for (k, (t, cj, y, yp)) in l.states.iter().enumerate() {
            let mut values = vec![0.; pattern.nonzeros()];
            let mut fastest = f64::INFINITY;
            for _ in 0..3 {
                let started = cpu();
                network
                    .jacobian_colored(*t, *cj, y, yp, &alternative, &mut values)
                    .expect("alternative coloring");
                fastest = fastest.min(cpu() - started);
            }
            cpu_total += fastest;
            let (_, reference) = replay(&mut network, &ledger, &structure, &l.states[k]);
            assert_eq!(
                values.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                reference.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                "{name} coloring changes the assembled values"
            );
        }
        alternatives.push(
            json!({"order": name, "colors": alternative.coloring.count(),
            "jacobian_ms": 1e3 * cpu_total / jac}),
        );
    }
    // Dense-row separation: rows above a threshold leave the coloring (their
    // entries would need their own per-column evaluation); the remaining
    // pattern is colored by the production greedy rule.
    let kind = |r: usize| -> String {
        for (i, c) in network.cell_layout.iter().enumerate() {
            for (name, index) in [
                ("base", c.base),
                ("boron", c.boron),
                ("mass_l", c.mass[0]),
                ("mass_g", c.mass[1]),
                ("energy_l", c.energy[0]),
                ("energy_g", c.energy[1]),
            ] {
                if index == r {
                    return format!("cell {i} {name}");
                }
            }
        }
        if network.pzr.coordinates().contains(&r) {
            return format!("pzr {}", r - network.pzr.base);
        }
        if let Some(f) = network.face_layout.iter().find(|f| f.index == r) {
            return format!("face {} phase {}", f.face, f.phase);
        }
        if network.rotor_index.contains(&r) {
            return "rotor".into();
        }
        "other".into()
    };
    let mut ranked: Vec<usize> = (0..pattern.rows()).collect();
    ranked.sort_by_key(|&r| std::cmp::Reverse(row_counts[r]));
    let densest: Vec<Value> = ranked[..12]
        .iter()
        .map(|&r| json!({"row": r, "nonzeros": row_counts[r], "unknown": kind(r)}))
        .collect();
    let separation: Vec<Value> = [80usize, 60, 40, 30, 20]
        .iter()
        .map(|&limit| {
            let kept: Vec<Vec<usize>> = (0..columns)
                .map(|c| {
                    pattern
                        .column(c)
                        .iter()
                        .copied()
                        .filter(|&r| row_counts[r] <= limit)
                        .collect()
                })
                .collect();
            let reduced = Pattern::from_columns(pattern.rows(), &kept).unwrap();
            let dense = row_counts.iter().filter(|&&n| n > limit).count();
            let dense_entries: usize = row_counts.iter().filter(|&&n| n > limit).sum();
            json!({"row_limit": limit, "dense_rows": dense, "dense_entries": dense_entries,
                "colors_without_dense_rows": Coloring::greedy(&reduced).count()})
        })
        .collect();
    // The same with every PZR row left out: the stratified cell's block and
    // the rows of the face ending at its port.
    let mechanics = &declared.packet.mechanics;
    let mut pzr_rows = vec![false; pattern.rows()];
    for r in network.pzr.coordinates() {
        pzr_rows[r] = true;
    }
    for f in &network.face_layout {
        let face = &mechanics.faces[f.face];
        if face.from == network.pzr.cell || face.to == network.pzr.cell {
            pzr_rows[f.index] = true;
        }
    }
    let kept: Vec<Vec<usize>> = (0..columns)
        .map(|c| {
            pattern
                .column(c)
                .iter()
                .copied()
                .filter(|&r| !pzr_rows[r])
                .collect()
        })
        .collect();
    let without_pzr = Pattern::from_columns(pattern.rows(), &kept).unwrap();
    let pzr_separation = json!({
        "pzr_rows": pzr_rows.iter().filter(|&&p| p).count(),
        "pzr_row_entries": (0..pattern.rows()).filter(|&r| pzr_rows[r]).map(|r| row_counts[r]).sum::<usize>(),
        "max_row_nonzeros_without_pzr": (0..pattern.rows()).filter(|&r| !pzr_rows[r]).map(|r| row_counts[r]).max(),
        "colors_without_pzr_rows": Coloring::greedy(&without_pzr).count(),
    });
    let claimed: usize = pattern.nonzeros();
    if let Ok(path) = std::env::var("LD01_STEP_COST_MATRICES") {
        let (rows, pointers) = l.structure.clone().unwrap();
        let mut bytes = Vec::new();
        for v in [best.steps, best.nonlinear_iterations, best.linear_setups] {
            bytes.extend(v.to_le_bytes());
        }
        bytes.extend((pointers.len() as i64 - 1).to_le_bytes());
        bytes.extend((rows.len() as i64).to_le_bytes());
        bytes.extend((l.matrices.len() as i64).to_le_bytes());
        pointers.iter().for_each(|v| bytes.extend(v.to_le_bytes()));
        rows.iter().for_each(|v| bytes.extend(v.to_le_bytes()));
        l.matrices
            .iter()
            .flatten()
            .for_each(|v| bytes.extend(v.to_le_bytes()));
        std::fs::write(path, bytes).unwrap();
    }
    let steps = best.steps as f64;
    println!(
        "{}",
        json!({
            "kind": "s1-settling-step-cost-NOT-EVIDENCE",
            "clock": "CLOCK_THREAD_CPUTIME_ID",
            "segment_s": best.reached,
            "runs": runs.len(),
            "steps": best.steps, "residuals": best.residuals, "jacobians": best.jacobians,
            "nonlinear_iterations": best.nonlinear_iterations, "linear_setups": best.linear_setups,
            "ida_cpu_s": best.ida_cpu,
            "ida_cpu_per_run_s": runs.iter().map(|r| r.ida_cpu).collect::<Vec<_>>(),
            "per_step_ms": 1e3 * best.ida_cpu / steps,
            "budget_cpu_s_per_s": budget, "projected_full_unit_step_s": step_target,
            "residual_callbacks": l.residual.json(),
            "jacobian_callbacks": l.jacobian.json(),
            "ida_minus_callbacks_s": best.ida_cpu - callbacks,
            "properties": {
                "residual": {"caloric": l.caloric[0].json(), "direction": l.direction[0].json(),
                    "saturation_value": l.saturation_value[0].json(),
                    "saturation_direction": l.saturation_direction[0].json(), "forward": l.forward[0].json()},
                "jacobian": {"caloric": l.caloric[1].json(), "direction": l.direction[1].json(),
                    "saturation_value": l.saturation_value[1].json(),
                    "saturation_direction": l.saturation_direction[1].json(), "forward": l.forward[1].json()},
            },
            "replay_per_jacobian_ms": {
                "production": 1e3 * totals.production / jac,
                "base_evaluation": 1e3 * totals.base / jac,
                "seeded_passes": 1e3 * totals.passes / jac,
                "of_which_caloric_directions": 1e3 * totals.pass_directions.cpu / jac,
                "caloric_directions_per_jacobian": totals.pass_directions.calls as f64 / jac,
                "of_which_saturation_directions": 1e3 * totals.pass_saturation.cpu / jac,
                "saturation_directions_per_jacobian": totals.pass_saturation.calls as f64 / jac,
                "scatter": 1e3 * totals.scatter / jac,
                "fresh_residual_at_states": 1e3 * totals.fresh_residual / jac,
            },
            "coloring": {"columns": columns, "rows": pattern.rows(), "nonzeros": claimed,
                "greedy_colors": structure.coloring.count(), "max_row_nonzeros_lower_bound": lower_bound,
                "alternatives": alternatives, "row_nonzeros_mean": claimed as f64 / pattern.rows() as f64,
                "densest_rows": densest, "dense_row_separation": separation,
                "pzr_row_separation": pzr_separation},
        })
    );
}
