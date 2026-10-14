//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#6-solver-properties-and-cost-obligations
//! G10's Jacobian check on the joined operator at the hot reference: the
//! assembled stage Jacobian `dF/dy + cj dF/dy'` times a direction against
//! the residual's own difference directional derivative, on every
//! coordinate direction and on 20 random directions per block, in the
//! scaled-row max norm. Zero-time; NOT S2 evidence while S2 is undeclared.
//!
//! The difference derivative is one fixed rule, not a ladder: the
//! one-sided Richardson combination `2 D(h/2) - D(h)` of forward
//! differences `D(h) = (F(y + h d, y' + cj h d) - F(y, y')) / h`, with
//! `h = 1e-5 min_i max(1, |y_i|) / |d_i|` over the direction's support,
//! the largest step moving no coordinate by more than 1e-5 of its scale.
//! It follows the direction's own sign, as the one-sided donor charts do;
//! a coordinate direction and each random direction's components carry
//! the network's column signs, the side every assembly differentiates.
//! `LD01_JAC_Z7_MATRIX` selects the matrix: `colored` (the reference
//! assembly) or `blocks` (the block assembly, all classes).
#![cfg(all(feature = "ida", target_os = "macos"))]
mod jacobian_harness;
use jacobian_harness::*;
use leitbild_operating_plant::{
    joined::{
        blocks::{Classes, JoinedJacobian, jacobian_blocks},
        operator::Joined,
    },
    sparse::Pattern,
};
use leitbild_operating_water::If97;
use serde_json::{Value, json};

const STEP: f64 = 1e-5;
const RANDOM_PER_BLOCK: usize = 20;
const BOUND: f64 = 1e-6;
const RANDOM_SEED: u64 = 0x1d01_5207;

/// SplitMix64: a fixed, recorded pseudo-random sequence.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    /// Uniform in [-1, 1).
    fn uniform(&mut self) -> f64 {
        2. * ((self.next() >> 11) as f64 / (1u64 << 53) as f64) - 1.
    }
}

fn rows(joined: &Joined<If97>) -> Vec<f64> {
    joined.rows().iter().map(|r| r.value).collect()
}

/// `2 D(h/2) - D(h)` along `d` (sparse: (index, component)).
fn difference(
    joined: &mut Joined<If97>,
    y: &[f64],
    yp: &[f64],
    cj: f64,
    base: &[f64],
    d: &[(usize, f64)],
) -> Result<(Vec<f64>, f64), String> {
    // The largest step that moves no coordinate by more than STEP of
    // max(1, |y_i|).
    let h = STEP
        * d.iter()
            .map(|(i, v)| y[*i].abs().max(1.) / v.abs())
            .fold(f64::INFINITY, f64::min);
    let mut at = |step: f64| -> Result<Vec<f64>, String> {
        let (mut ys, mut yps) = (y.to_vec(), yp.to_vec());
        for (i, v) in d {
            ys[*i] += step * v;
            yps[*i] += cj * step * v;
        }
        joined
            .evaluate(0., &ys, &yps, None, 0., None)
            .map_err(|e| format!("{e:?}"))?;
        Ok(rows(joined)
            .iter()
            .zip(base)
            .map(|(f, f0)| (f - f0) / step)
            .collect())
    };
    let whole = at(h)?;
    let half = at(0.5 * h)?;
    Ok((
        half.iter().zip(&whole).map(|(a, b)| 2. * a - b).collect(),
        h,
    ))
}

fn product(pattern: &Pattern, values: &[f64], d: &[(usize, f64)], out: &mut [f64]) {
    out.fill(0.);
    for (j, v) in d {
        let span = pattern.pointers()[*j]..pattern.pointers()[*j + 1];
        for (row, a) in pattern.indices()[span.clone()].iter().zip(&values[span]) {
            out[*row] += a * v;
        }
    }
}

#[test]
#[ignore = "requires the S1 packet, the wiki gates, maintained IF97 and stock IDA/KLU; zero-time G10 check"]
fn joined_jacobian_directional_check() {
    prefer_performance_core();
    let matrix =
        std::env::var("LD01_JAC_Z7_MATRIX").expect("LD01_JAC_Z7_MATRIX: colored or blocks");
    let declared = Declared::load();
    let load_start = load_average();
    let commit = command("git", &["rev-parse", "HEAD"]);
    let dirty = !command("git", &["status", "--porcelain"]).is_empty();
    let settled = settle(&declared, &[46.], Assembly::Blocks)
        .outputs
        .pop()
        .unwrap();
    let JoinedHot { mut joined, y, .. } = joined_hot(&declared, &settled, true);
    let n = joined.dimension();
    let o = joined.offsets();
    let yp = vec![0.; n];
    let cj = 20.;
    let (pattern, values) = match matrix.as_str() {
        "colored" => {
            let (p, v, ..) = joined_colored(&mut joined, &y, &yp, cj);
            (p, v)
        }
        "blocks" => {
            let structure = JoinedJacobian::compile(&mut joined, 0., &y).expect("block compile");
            let mut v = vec![0.; structure.pattern.nonzeros()];
            jacobian_blocks(
                &mut joined,
                &structure,
                0.,
                cj,
                &y,
                &yp,
                &mut v,
                Classes::ALL,
            )
            .expect("block assembly");
            (structure.pattern, v)
        }
        other => panic!("LD01_JAC_Z7_MATRIX {other}"),
    };
    joined.evaluate(0., &y, &yp, None, 0., None).unwrap();
    let signs: Vec<f64> = {
        let mut s = vec![1.; n];
        s[..o.nuclear].copy_from_slice(&joined.network.column_signs(&y[..o.nuclear]));
        s
    };
    let base = rows(&joined);
    // Exact-absence coordinates: a phase mass at exactly zero, and the
    // impulse of a face phase at zero impulse with exactly zero inertance.
    // A step of either sign leaves the residual's domain on this branch
    // (a phase born without energy or negative mass; finite impulse at
    // zero inertia is refused), so no difference derivative exists there.
    // Their analytic columns are checked against the colored matrix
    // (joined_blocks_against_colored), not here.
    let mut absent = vec![false; n];
    for l in &joined.network.cell_layout {
        for k in 0..2 {
            if y[l.mass[k]] == 0. {
                absent[l.mass[k]] = true;
            }
        }
    }
    for l in &joined.network.face_layout {
        let chart = joined.network.chart(l.face, l.phase);
        if y[l.index] == 0. && chart.is_none_or(|c| c.inertance_kg_m4.value == 0.) {
            absent[l.index] = true;
        }
    }
    let absent_list: Vec<usize> = (0..n).filter(|i| absent[*i]).collect();
    let blocks = [
        ("network", 0..o.nuclear),
        ("nuclear", o.nuclear..o.solids),
        ("solids", o.solids..o.secondary),
        ("secondary", o.secondary..o.rods),
        ("rods", o.rods..o.pzr),
        ("pzr", o.pzr..o.end),
    ];
    let started = cpu();
    let mut analytic = vec![0.; n];
    let mut failures = Vec::new();
    let mut check = |label: Value, d: Vec<(usize, f64)>, block: &str| -> f64 {
        product(&pattern, &values, &d, &mut analytic);
        let (fd, h) = match difference(&mut joined, &y, &yp, cj, &base, &d) {
            Ok(r) => r,
            Err(e) => {
                failures.push(json!({"direction": label, "refused": e}));
                return f64::INFINITY;
            }
        };
        let norm = fd.iter().map(|v| v.abs()).fold(0., f64::max);
        let (mut diff, mut at) = (0_f64, 0);
        for (i, (a, b)) in analytic.iter().zip(&fd).enumerate() {
            if (a - b).abs() > diff {
                diff = (a - b).abs();
                at = i;
            }
        }
        let relative = if norm > 0. { diff / norm } else { diff };
        if relative > BOUND {
            failures.push(
                json!({"direction": label, "block": block, "relative": relative,
                "row": at, "analytic": analytic[at], "difference": fd[at], "norm": norm, "h": h}),
            );
        }
        relative
    };
    let mut per_block = Vec::new();
    // A diagnostic may name a subset of blocks; a G10 receipt runs all.
    let only: Option<Vec<String>> = std::env::var("LD01_JAC_Z7_BLOCKS")
        .ok()
        .map(|v| v.split(',').map(str::to_owned).collect());
    for (name, range) in blocks.iter().cloned() {
        if only.as_ref().is_some_and(|o| !o.iter().any(|b| b == name)) {
            continue;
        }
        let mut coordinate_worst = 0_f64;
        for j in range.clone().filter(|j| !absent[*j]) {
            let r = check(json!({"coordinate": j}), vec![(j, signs[j])], name);
            coordinate_worst = coordinate_worst.max(r);
        }
        let mut rng = Rng(RANDOM_SEED ^ (range.start as u64));
        let mut random_worst = 0_f64;
        for k in 0..RANDOM_PER_BLOCK {
            let d: Vec<(usize, f64)> = range
                .clone()
                .map(|j| (j, signs[j] * rng.uniform().abs()))
                .filter(|(j, _)| !absent[*j])
                .collect();
            let r = check(json!({"random": k, "block": name}), d, name);
            random_worst = random_worst.max(r);
        }
        let absent_here = range.clone().filter(|j| absent[*j]).count();
        per_block.push(json!({"block": name, "coordinates": range.len(),
            "coordinate_directions_checked": range.len() - absent_here,
            "exact_absence_coordinates": absent_here,
            "coordinate_worst_relative": coordinate_worst,
            "random_directions": RANDOM_PER_BLOCK, "random_worst_relative": random_worst}));
    }
    let seconds = cpu() - started;
    let receipt = json!({
        "kind": if matrix == "blocks" { "s2-z7-joined-blocks-directional-NOT-EVIDENCE" } else { "s2-joined-colored-reference-directional-NOT-EVIDENCE" },
        "team": "JAC",
        "status": "zero-time G10 check at the hot reference; S2 is not declared",
        "matrix": matrix,
        "app_commit": commit, "app_dirty": dirty,
        "packet": declared.packet_path, "packet_sha256": sha256_file(&declared.packet_path),
        "load_average_start": load_start,
        "composition": {"dimension": n, "offsets": o},
        "cj_per_s": cj, "bound_relative_scaled_row_max_norm": BOUND,
        "difference_rule": "2 D(h/2) - D(h), D(h) = (F(y + h d, y' + cj h d) - F(y, y'))/h, h = 1e-5 min over supp d of max(1, |y_i|)/|d_i|; directions carry the network column signs",
        "random_seed": RANDOM_SEED,
        "exact_absence_rule": "a phase mass at exactly 0, or a face phase impulse at exactly 0 with exactly 0 inertance: no difference derivative exists on this branch; random directions carry 0 there",
        "exact_absence_coordinates": absent_list,
        "blocks": per_block, "block_subset": only,
        "failures": failures.len(),
        "failure_sample": failures.iter().take(400).collect::<Vec<_>>(),
        "check_cpu_s": seconds,
        "load_average_end": load_average(),
    });
    println!("{}", serde_json::to_string(&receipt).unwrap());
    if let Ok(path) = std::env::var("LD01_JAC_RECEIPT") {
        write_receipt(&path, &receipt);
    }
    assert!(
        failures.is_empty(),
        "{} directions exceed {BOUND}",
        failures.len()
    );
}
