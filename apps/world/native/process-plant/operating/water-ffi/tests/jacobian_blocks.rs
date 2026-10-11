//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#6-solver-properties-and-cost-obligations
//! The block stage-Jacobian assembly checked on the actual S1 packet. A
//! verification and cost measurement, NOT S1 or S2 evidence:
//! - at every stage-Jacobian state of the S1 settling run, the block
//!   assembly against the colored assembly IDA used there;
//! - at three of them, every column against a dense finite difference of
//!   the value residual, and random directional products `J v` against
//!   central differences along `v` (the S2 Z7 receipt type);
//! - both assemblies' thread CPU per call, the block assembly's property
//!   calls, and stock KLU on its matrices with nnz(L+U) (the Z5 type);
//! - the S1 settling run advanced by stock IDA with each assembly, compared
//!   in the integrator's own error weights.
#![cfg(all(feature = "ida", target_os = "macos"))]
mod jacobian_harness;
use jacobian_harness::*;
use leitbild_operating_plant::{
    network::{BlockJacobian, Network, Properties, SparseJacobian},
    sparse::Pattern,
};
use leitbild_operating_water::If97;
use serde_json::{Value, json};
use std::rc::Rc;

/// What a coordinate is, for reports.
fn kind<P: Properties>(network: &Network<P>, i: usize) -> String {
    for (c, l) in network.cell_layout.iter().enumerate() {
        for (name, index) in [
            ("p", l.base),
            ("B", l.boron),
            ("M_l", l.mass[0]),
            ("M_g", l.mass[1]),
            ("U_l", l.energy[0]),
            ("U_g", l.energy[1]),
        ] {
            if index == i {
                return format!("cell {c} {name}");
            }
        }
    }
    if network.pzr.coordinates().contains(&i) {
        return format!("pzr {}", i - network.pzr.base);
    }
    if let Some(f) = network.face_layout.iter().find(|f| f.index == i) {
        return format!("face {} phase {}", f.face, f.phase);
    }
    if let Some(r) = network.rotor_index.iter().position(|r| *r == i) {
        return format!("rotor {r}");
    }
    "other".into()
}

/// Entrywise comparison of two value arrays on one pattern.
fn compare<P: Properties>(
    network: &Network<P>,
    pattern: &Pattern,
    a: &[f64],
    b: &[f64],
) -> (f64, f64, usize, Value) {
    let (mut column_max, mut entry_max, mut bitwise) = (0_f64, 0_f64, 0);
    let mut worst = json!(null);
    for j in 0..pattern.columns() {
        let range = pattern.pointers()[j]..pattern.pointers()[j + 1];
        let scale = range
            .clone()
            .map(|p| b[p].abs().max(a[p].abs()))
            .fold(0., f64::max);
        for p in range {
            let (x, y) = (a[p], b[p]);
            if x == y {
                bitwise += 1;
                continue;
            }
            let difference = (x - y).abs();
            let column = difference / scale;
            if column > column_max {
                column_max = column;
                let row = pattern.indices()[p];
                worst = json!({"row": kind(network, row), "column": kind(network, j),
                    "blocks": x, "colored": y, "column_max": scale});
            }
            let size = x.abs().max(y.abs());
            if size >= 1e-12 * scale {
                entry_max = entry_max.max(difference / size);
            }
        }
    }
    (column_max, entry_max, bitwise, worst)
}

/// A finite-difference stage-Jacobian column `(F(y+h e, y'+cj h e) - ...)/(.)`,
/// central where the coordinate is nonzero, one-sided along its seed sign at
/// an exact zero (the one-sided chart the assemblies select). `None` when a
/// perturbed residual is refused (an absent phase cannot be perturbed).
fn fd_column(
    network: &mut Network<If97>,
    (t, cj, y, yp): &State,
    j: usize,
    sign: f64,
    base: &[f64],
) -> Option<Vec<f64>> {
    let mut eval = |delta: f64| -> Option<Vec<f64>> {
        let (mut y1, mut yp1) = (y.clone(), yp.clone());
        y1[j] += delta;
        yp1[j] += cj * delta;
        network.evaluate(*t, &y1, &yp1, None, 0., None).ok()?;
        Some(network.rows().iter().map(|r| r.value).collect())
    };
    if y[j] == 0. {
        let h = 1e-7 * sign;
        let plus = eval(h)?;
        Some(plus.iter().zip(base).map(|(a, b)| (a - b) / h).collect())
    } else {
        let h = 1e-6 * y[j].abs().max(1.);
        let (plus, minus) = (eval(h)?, eval(-h)?);
        Some(
            plus.iter()
                .zip(&minus)
                .map(|(a, b)| (a - b) / (2. * h))
                .collect(),
        )
    }
}

/// Deterministic standard normals (xorshift64* and Box-Muller).
struct Normals(u64);
impl Normals {
    fn uniform(&mut self) -> f64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        ((self.0.wrapping_mul(0x2545F4914F6CDD1D) >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    }
    fn next(&mut self) -> f64 {
        let (u, v) = (self.uniform(), self.uniform());
        (-2. * u.ln()).sqrt() * (2. * std::f64::consts::PI * v).cos()
    }
}

fn matvec(pattern: &Pattern, values: &[f64], v: &[f64]) -> Vec<f64> {
    let mut out = vec![0.; pattern.rows()];
    for (j, vj) in v.iter().enumerate() {
        for p in pattern.pointers()[j]..pattern.pointers()[j + 1] {
            out[pattern.indices()[p]] += values[p] * vj;
        }
    }
    out
}
fn norm(v: &[f64]) -> f64 {
    v.iter().map(|x| x * x).sum::<f64>().sqrt()
}

/// Dense FD and directional checks at one recorded state.
fn finite_differences(
    network: &mut Network<If97>,
    pattern: &Pattern,
    state: &State,
    blocks: &[f64],
    colored: &[f64],
    signs: &[f64],
) -> Value {
    let (t, _, y, yp) = state;
    network
        .evaluate(*t, y, yp, None, 0., None)
        .expect("base residual");
    let base: Vec<f64> = network.rows().iter().map(|r| r.value).collect();
    let n = y.len();
    let (mut errors_b, mut errors_c) = (Vec::new(), Vec::new());
    let mut refused = Vec::new();
    let mut worst = (0., json!(null));
    let mut perturbable = vec![false; n];
    for j in 0..n {
        let Some(fd) = fd_column(network, state, j, signs[j], &base) else {
            refused.push(kind(network, j));
            continue;
        };
        perturbable[j] = true;
        let mut column_b = vec![0.; n];
        let mut column_c = vec![0.; n];
        for p in pattern.pointers()[j]..pattern.pointers()[j + 1] {
            column_b[pattern.indices()[p]] = blocks[p];
            column_c[pattern.indices()[p]] = colored[p];
        }
        let size = |c: &[f64]| c.iter().map(|v| v.abs()).fold(0., f64::max);
        let scale = size(&column_b).max(size(&fd)).max(1e-300);
        let error = |c: &[f64]| {
            c.iter()
                .zip(&fd)
                .map(|(a, b)| (a - b).abs())
                .fold(0., f64::max)
                / scale
        };
        let (eb, ec) = (error(&column_b), error(&column_c));
        if eb > worst.0 {
            worst = (
                eb,
                json!({"column": kind(network, j), "relative": eb,
                "colored_relative": ec, "y": y[j], "one_sided": y[j] == 0.}),
            );
        }
        errors_b.push(eb);
        errors_c.push(ec);
    }
    let summary = |v: &mut Vec<f64>| {
        v.sort_by(f64::total_cmp);
        let at = |q: f64| v[((v.len() - 1) as f64 * q).round() as usize];
        json!({"max": at(1.), "p99": at(0.99), "median": at(0.5), "columns": v.len()})
    };
    // Random directions over the two-sided perturbable columns.
    let mut normals = Normals(0x9E3779B97F4A7C15 ^ (*t).to_bits());
    let mut directional = Vec::new();
    for _ in 0..8 {
        let v: Vec<f64> = (0..n)
            .map(|j| {
                if perturbable[j] && y[j] != 0. {
                    normals.next() * y[j].abs().max(1.)
                } else {
                    0.
                }
            })
            .collect();
        let h = 1e-6 / norm(&v).max(1.) * (n as f64).sqrt();
        let (_, cj, _, _) = state;
        let mut eval = |delta: f64| {
            let y1: Vec<f64> = y.iter().zip(&v).map(|(a, b)| a + delta * b).collect();
            let yp1: Vec<f64> = yp.iter().zip(&v).map(|(a, b)| a + cj * delta * b).collect();
            network
                .evaluate(*t, &y1, &yp1, None, 0., None)
                .expect("directional residual");
            network.rows().iter().map(|r| r.value).collect::<Vec<f64>>()
        };
        let (plus, minus) = (eval(h), eval(-h));
        let fd: Vec<f64> = plus
            .iter()
            .zip(&minus)
            .map(|(a, b)| (a - b) / (2. * h))
            .collect();
        let jb = matvec(pattern, blocks, &v);
        let jc = matvec(pattern, colored, &v);
        let rel = |a: &[f64]| {
            let d: Vec<f64> = a.iter().zip(&fd).map(|(x, y)| x - y).collect();
            norm(&d) / norm(&fd)
        };
        let db: Vec<f64> = jb.iter().zip(&jc).map(|(x, y)| x - y).collect();
        directional.push(json!({"blocks_vs_fd": rel(&jb), "colored_vs_fd": rel(&jc),
            "blocks_vs_colored": norm(&db) / norm(&jc)}));
    }
    json!({"t": t, "columns_refused": refused.len(), "refused": refused,
        "blocks_vs_fd_column": summary(&mut errors_b), "colored_vs_fd_column": summary(&mut errors_c),
        "worst_column": worst.1, "directional": directional,
        "method": "central differences of the value residual, h = 1e-6 max(1, |y_j|) in solver units with y' moved by cj h; one-sided h = 1e-7 along the seed sign at an exact-zero coordinate; column error = max |J - FD| over the column's rows / max(|J|, |FD|) of the column; directional: 8 normal directions over the two-sided perturbable columns, scaled by max(1, |y_j|), central differences, relative 2-norm"})
}

/// WRMS of a difference in IDA's error weights at `y`.
fn wrms(a: &[f64], b: &[f64], rtol: f64, atol: &[f64]) -> f64 {
    let sum: f64 = a
        .iter()
        .zip(b)
        .zip(atol)
        .map(|((x, y), w)| ((x - y) / (rtol * y.abs() + w)).powi(2))
        .sum();
    (sum / a.len() as f64).sqrt()
}

#[test]
#[ignore = "requires the S1 packet, the wiki gates, maintained IF97 and stock IDA/KLU"]
fn jacobian_blocks_s1() {
    prefer_performance_core();
    let declared = Declared::load();
    let load_start = load_average();
    let commit = command("git", &["rev-parse", "HEAD"]);
    let dirty = !command("git", &["status", "--porcelain"]).is_empty();
    let outputs = [0.25, 0.5, 1., 2., 5., 10., 20., 46.];
    let colored_run = settle(&declared, &outputs, Assembly::Colored);
    let (mut network, ..) = declared.prepared(If97);
    let colored_structure: SparseJacobian = network.sparse_jacobian().expect("colored structure");
    let structure: BlockJacobian = network.block_jacobian().expect("block structure");
    assert_eq!(
        structure.pattern, colored_structure.pattern,
        "one pattern for both assemblies"
    );
    let pattern = &structure.pattern;

    // Every recorded state: block assembly against the colored matrix IDA used.
    let mut comparisons = Vec::new();
    let mut block_values = Vec::new();
    let (mut column_max, mut entry_max) = (0_f64, 0_f64);
    let mut bitwise = 0;
    for (state, colored) in colored_run.states.iter().zip(&colored_run.matrices) {
        let (t, cj, y, yp) = state;
        let mut values = vec![0.; pattern.nonzeros()];
        network
            .jacobian_blocks(*t, *cj, y, yp, &structure, &mut values)
            .expect("block assembly");
        let (c, e, b, worst) = compare(&network, pattern, &values, colored);
        column_max = column_max.max(c);
        entry_max = entry_max.max(e);
        bitwise += b;
        comparisons.push(json!({"t": t, "cj": cj, "column_relative_max": c,
            "entry_relative_max": e, "bitwise_entries": b, "worst": worst}));
        block_values.push(values);
    }
    let calls = colored_run.states.len();

    // Dense FD and directional checks at the first, a middle and the last state.
    let picks = [0, calls / 2, calls - 1];
    let mut fd = Vec::new();
    for &k in &picks {
        let state = &colored_run.states[k];
        network
            .evaluate(state.0, &state.2, &state.3, None, 0., None)
            .unwrap();
        let signs = network.column_signs(&state.2);
        fd.push(finite_differences(
            &mut network,
            pattern,
            state,
            &block_values[k],
            &colored_run.matrices[k],
            &signs,
        ));
    }

    // Thread CPU per call, best of 3, and the block assembly's property calls.
    let shared: Shared = Rc::default();
    let (mut timed, ..) = declared.prepared(Timed(shared.clone()));
    let timed_structure = timed.block_jacobian().unwrap();
    let timed_colored = timed.sparse_jacobian().unwrap();
    let (mut colored_ms, mut blocks_ms, mut base_ms) = (0., 0., 0.);
    let mut ledger = Calls {
        caloric: Tally::default(),
        direction_nonzero: Tally::default(),
        direction_zero: Tally::default(),
        saturation_value: Tally::default(),
        saturation_direction: Tally::default(),
    };
    let add = |a: Tally, b: Tally| Tally {
        calls: a.calls + b.calls,
        cpu: a.cpu + b.cpu,
    };
    for (k, (t, cj, y, yp)) in colored_run.states.iter().enumerate() {
        let mut values = vec![0.; pattern.nonzeros()];
        let (mut c, mut b, mut e) = (f64::INFINITY, f64::INFINITY, f64::INFINITY);
        for _ in 0..3 {
            let started = cpu();
            timed
                .jacobian_colored(*t, *cj, y, yp, &timed_colored, &mut values)
                .unwrap();
            c = c.min(cpu() - started);
            let started = cpu();
            timed
                .jacobian_blocks(*t, *cj, y, yp, &timed_structure, &mut values)
                .unwrap();
            b = b.min(cpu() - started);
            let mut reuse = timed.reuse();
            let started = cpu();
            timed
                .evaluate(*t, y, yp, None, 0., Some(&mut reuse))
                .unwrap();
            e = e.min(cpu() - started);
        }
        assert_eq!(
            values.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            block_values[k]
                .iter()
                .map(|v| v.to_bits())
                .collect::<Vec<_>>(),
            "the timed block assembly is the untimed one"
        );
        colored_ms += 1e3 * c;
        blocks_ms += 1e3 * b;
        base_ms += 1e3 * e;
        *shared.borrow_mut() = Ledger::default();
        timed
            .jacobian_blocks(*t, *cj, y, yp, &timed_structure, &mut values)
            .unwrap();
        let l = shared.borrow();
        ledger = Calls {
            caloric: add(ledger.caloric, l.caloric),
            direction_nonzero: add(ledger.direction_nonzero, l.direction_nonzero),
            direction_zero: add(ledger.direction_zero, l.direction_zero),
            saturation_value: add(ledger.saturation_value, l.saturation_value),
            saturation_direction: add(ledger.saturation_direction, l.saturation_direction),
        };
    }
    let per = calls as f64;

    // Stock IDA with each assembly over the same settling run.
    let blocks_run = settle(&declared, &outputs, Assembly::Blocks);
    let trajectory: Vec<Value> = outputs
        .iter()
        .enumerate()
        .map(|(i, t)| {
            json!({"t": t, "wrms_blocks_minus_colored": wrms(&blocks_run.outputs[i],
                &colored_run.outputs[i], colored_run.relative_tolerance,
                &colored_run.absolute_tolerance)})
        })
        .collect();
    let max_wrms = trajectory
        .iter()
        .map(|t| t["wrms_blocks_minus_colored"].as_f64().unwrap())
        .fold(0., f64::max);
    let stats = |s: &leitbild_operating_water::ida::Stats, cpu_s: f64| {
        json!({"steps": s.steps, "residuals": s.residuals, "jacobians": s.jacobians,
            "nonlinear_iterations": s.nonlinear_iterations,
            "convergence_failures": s.convergence_failures, "error_failures": s.error_failures,
            "linear_setups": s.linear_setups, "ida_thread_cpu_s": cpu_s})
    };
    // The S1 events from the settled state, 2 s each, with each assembly.
    let settled = colored_run.outputs.last().unwrap().clone();
    let mut events = serde_json::Map::new();
    let mut event_matrices = Vec::new();
    for (name, kind) in [
        ("seizure", Event::Seizure),
        ("supply_loss", Event::SupplyLoss),
    ] {
        let c = event(&declared, &settled, kind, Assembly::Colored, 2., 0.1);
        let b = event(&declared, &settled, kind, Assembly::Blocks, 2., 0.1);
        let worst = c
            .outputs
            .iter()
            .zip(&b.outputs)
            .map(|(yc, yb)| wrms(yb, yc, c.relative_tolerance, &c.absolute_tolerance))
            .fold(0., f64::max);
        // Block against colored at the colored run's own Jacobian states.
        let (mut column, mut entry, mut same) = (0_f64, 0_f64, 0);
        let (mut locked, ..) = declared.prepared(If97);
        let mut y = settled.clone();
        if kind == Event::Seizure {
            locked
                .seize(declared.gate(&["seizure", "rotor"]) as usize, &mut y)
                .unwrap();
        } else {
            locked.set_rotor_state(
                declared.gate(&["supplyLoss", "rotor"]) as usize,
                leitbild_operating_plant::network::RotorState {
                    support: leitbild_operating_plant::rotor::Support::Unsupported,
                    shaft: leitbild_operating_plant::rotor::Shaft::Free,
                },
            );
        }
        let event_structure = locked.block_jacobian().unwrap();
        for ((t, cj, y, yp), colored) in c.states.iter().zip(&c.matrices) {
            let mut values = vec![0.; pattern.nonzeros()];
            locked
                .jacobian_blocks(*t, *cj, y, yp, &event_structure, &mut values)
                .expect("event block assembly");
            let (col, ent, bit, _) = compare(&locked, pattern, &values, colored);
            column = column.max(col);
            entry = entry.max(ent);
            same += bit;
        }
        events.insert(
            name.into(),
            json!({"duration_s": 2., "max_wrms_blocks_minus_colored": worst,
            "colored": stats(&c.stats, c.cpu_s), "blocks": stats(&b.stats, b.cpu_s),
            "against_colored": {"calls": c.states.len(), "column_relative_max": column,
                "entry_relative_max": entry, "bitwise_entries": same,
                "entries": c.states.len() * pattern.nonzeros()}}),
        );
        event_matrices.extend(b.matrices);
    }
    let (pointers, rows) = &blocks_run.structure;
    let mut all_matrices = blocks_run.matrices.clone();
    all_matrices.extend(event_matrices);
    let klu = klu_profile(pointers, rows, &all_matrices, 5);
    let receipt = json!({
        "kind": "jacobian-blocks-s1-NOT-EVIDENCE",
        "team": "JAC",
        "clock": "CLOCK_THREAD_CPUTIME_ID, QOS_CLASS_USER_INTERACTIVE, best of 3 per recorded call",
        "app_commit": commit, "app_dirty": dirty,
        "packet": declared.packet_path, "packet_sha256": sha256_file(&declared.packet_path),
        "water_build": serde_json::from_str::<Value>(include_str!(concat!(env!("LD01_OPERATING_WATER_LIB_DIR"), "/water-build.json"))).unwrap(),
        "sundials_prefix": env!("LD01_OPERATING_SUNDIALS_PREFIX"),
        "load_average_start": load_start,
        "structure": {"columns": pattern.columns(), "nonzeros": pattern.nonzeros(),
            "colored_colors": colored_structure.coloring.count()},
        "against_colored": {"calls": calls, "column_relative_max": column_max,
            "entry_relative_max": entry_max, "bitwise_entries": bitwise,
            "entries": calls * pattern.nonzeros(), "per_call": comparisons,
            "measure": "column_relative = |blocks - colored| / max |entry| of the column; entry_relative over entries at least 1e-12 of their column's largest"},
        "finite_differences": fd,
        "cost_per_call_ms": {"colored": colored_ms / per, "blocks": blocks_ms / per,
            "speedup": colored_ms / blocks_ms,
            "blocks_base_evaluation_with_reuse": base_ms / per,
            "blocks_properties": {
                "caloric_inversions": ledger.caloric.json(per),
                "nonzero_directions": ledger.direction_nonzero.json(per),
                "zero_directions": ledger.direction_zero.json(per),
                "saturation_values": ledger.saturation_value.json(per),
                "saturation_directions": ledger.saturation_direction.json(per)}},
        "ida": {"outputs": trajectory, "max_wrms_blocks_minus_colored": max_wrms,
            "colored": stats(&colored_run.stats, colored_run.cpu_s),
            "blocks": stats(&blocks_run.stats, blocks_run.cpu_s),
            "colored_marks": colored_run.marks, "blocks_marks": blocks_run.marks,
            "measure": "WRMS of y_blocks - y_colored at each requested output in IDA's weights 1/(rtol |y_colored| + atol); the Newton test accepts corrections below 0.33 in this norm"},
        "events": events,
        "klu_on_block_matrices": klu,
        "load_average_end": load_average(),
    });
    println!("{}", serde_json::to_string(&receipt).unwrap());
    if let Ok(path) = std::env::var("LD01_JAC_RECEIPT") {
        write_receipt(&path, &receipt);
    }
}
