//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#cost-premise-risk-not-a-decision
//! PERF's profile of the joined value residual on the actual packet: thread
//! CPU per `Joined::evaluate` at the hot reference (Z5's composition) and,
//! when `LD01_PERF_SETTLED_STATE` names one, at a settled joined state, with
//! the identity digests a bitwise claim needs: every row's value and
//! direction bits of the value residual and of fixed seeded evaluations,
//! the heats, the colored and the block Jacobian. A measurement and identity
//! check, not a production path and NOT S2 evidence.
#![cfg(all(feature = "ida", target_os = "macos"))]
mod jacobian_harness;
use jacobian_harness::*;
use leitbild_operating_plant::{joined::operator::Joined, thermal::Scalar};
use leitbild_operating_water::If97;
use serde_json::{Value, json};

/// FNV-1a over the little-endian bytes of `bits`, continued from `digest`.
fn fnv(mut digest: u64, bits: impl IntoIterator<Item = u64>) -> u64 {
    for b in bits {
        for byte in b.to_le_bytes() {
            digest = (digest ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3);
        }
    }
    digest
}
const FNV0: u64 = 0xcbf2_9ce4_8422_2325;
fn scalar_bits(v: &[Scalar]) -> impl Iterator<Item = u64> + '_ {
    v.iter()
        .flat_map(|s| [s.value.to_bits(), s.direction.to_bits()])
}
fn hex(d: u64) -> String {
    format!("{d:016x}")
}

/// One evaluation's rows and heats as a digest.
fn evaluation_digest(joined: &Joined<If97>) -> u64 {
    let h = joined.heats();
    let mut d = fnv(FNV0, scalar_bits(joined.rows()));
    d = fnv(d, scalar_bits(&h.nuclear.fuel_w));
    d = fnv(d, scalar_bits(&h.nuclear.coolant_w));
    d = fnv(
        d,
        scalar_bits(&[
            h.nuclear.event_w,
            h.nuclear.released_w,
            h.nuclear.stored_rate_w,
            h.coolant_w,
            h.solids.clad_to_water_w,
            h.solids.passive_to_water_w,
            h.solids.stored_rate_w,
        ]),
    );
    d = fnv(d, scalar_bits(&h.solids.primary_to_metal_w));
    fnv(d, scalar_bits(&h.solids.secondary_w))
}

/// Deterministic dense seeds (a 64-bit LCG in [-1, 1)).
fn seeds(n: usize, count: usize) -> Vec<Vec<f64>> {
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    (0..count)
        .map(|_| {
            (0..n)
                .map(|_| {
                    state = state
                        .wrapping_mul(6_364_136_223_846_793_005)
                        .wrapping_add(1_442_695_040_888_963_407);
                    ((state >> 11) as f64) / ((1u64 << 53) as f64) * 2. - 1.
                })
                .collect()
        })
        .collect()
}

struct State {
    label: &'static str,
    t: f64,
    y: Vec<f64>,
    yp: Vec<f64>,
}

/// Identity of every evaluation path a PERF change may touch at `state`.
fn identities(joined: &mut Joined<If97>, state: &State, dense: &[Vec<f64>], cj: f64) -> Value {
    joined
        .evaluate(state.t, &state.y, &state.yp, None, 0., None)
        .expect("value residual");
    let value = evaluation_digest(joined);
    let feedback = joined
        .nuclear()
        .feedback_output()
        .map(|o| {
            let mut d = fnv(
                FNV0,
                o.regions.iter().flat_map(|r| {
                    scalar_bits(&[r.reactivity, r.external_source_per_s]).collect::<Vec<_>>()
                }),
            );
            d = fnv(d, scalar_bits(&o.fissions_per_population_s));
            d = fnv(d, scalar_bits(&o.carrier_fissions_per_s));
            d = fnv(d, scalar_bits(&o.exposure_per_m2_s));
            d = fnv(d, scalar_bits(&o.rod_overlap));
            hex(d)
        })
        .unwrap_or_default();
    let mut seeded = FNV0;
    for seed in dense {
        joined
            .evaluate(state.t, &state.y, &state.yp, Some(seed), cj, None)
            .expect("seeded residual");
        seeded = fnv(seeded, [evaluation_digest(joined)]);
    }
    // The value residual again after seeded passes: no state carried over.
    joined
        .evaluate(state.t, &state.y, &state.yp, None, 0., None)
        .expect("value residual");
    let again = evaluation_digest(joined);
    json!({"state": state.label, "value_rows_and_heats": hex(value),
        "value_after_seeded": hex(again), "feedback_output": feedback,
        "dense_seeded": hex(seeded), "dense_seeds": dense.len()})
}

fn quantile(sorted: &[f64], q: f64) -> f64 {
    sorted[((sorted.len() - 1) as f64 * q).round() as usize]
}

#[test]
#[ignore = "requires the S1 packet, the wiki gates, maintained IF97 and stock IDA/KLU; PERF cost and identity probe"]
fn joined_residual_profile() {
    use leitbild_operating_plant::joined::blocks::{Classes, JoinedJacobian, jacobian_blocks};
    prefer_performance_core();
    let rounds: usize = std::env::var("LD01_PERF_ROUNDS").map_or(7, |r| r.parse().unwrap());
    let samples: usize = std::env::var("LD01_PERF_SAMPLES").map_or(7, |r| r.parse().unwrap());
    let calls: usize = std::env::var("LD01_PERF_CALLS").map_or(20, |r| r.parse().unwrap());
    let jacobians = std::env::var("LD01_PERF_JACOBIANS").map_or(true, |v| v != "0");
    let declared = Declared::load();
    let load_start = load_average();
    let commit = command("git", &["rev-parse", "HEAD"]);
    let dirty = !command("git", &["status", "--porcelain", "--untracked-files=no"]).is_empty();
    let started = cpu();
    let settled = settle(&declared, &[46.], Assembly::Blocks)
        .outputs
        .pop()
        .unwrap();
    let JoinedHot { mut joined, y, .. } = joined_hot_with(&declared, &settled, true, || If97);
    let preparation_cpu_s = cpu() - started;
    let n = joined.dimension();
    let mut states = vec![State {
        label: "hot reference (Z5 composition, t 0, y' 0)",
        t: 0.,
        y: y.clone(),
        yp: vec![0.; n],
    }];
    let mut settled_source = Value::Null;
    if let Ok(path) = std::env::var("LD01_PERF_SETTLED_STATE") {
        let raw: Value = serde_json::from_slice(&std::fs::read(&path).expect("settled state"))
            .expect("settled state JSON");
        let vector = |k: &str| -> Vec<f64> {
            raw[k]
                .as_array()
                .unwrap_or_else(|| panic!("settled state {k}"))
                .iter()
                .map(|v| v.as_f64().unwrap())
                .collect()
        };
        let (ys, yps) = (vector("y"), vector("yp"));
        assert_eq!(ys.len(), n, "settled state dimension");
        settled_source = json!({"path": path, "sha256": sha256_file(&path), "packet": raw["packet"], "t_s": raw["t_s"]});
        states.push(State {
            label: "settled joined state",
            t: raw["t_s"].as_f64().unwrap(),
            y: ys,
            yp: yps,
        });
    }
    let cj = 20.;
    let dense = seeds(n, 4);
    let identity: Vec<Value> = states
        .iter()
        .map(|s| identities(&mut joined, s, &dense, cj))
        .collect();
    // Optionally every value-residual row per state, for comparing a change
    // that is not bitwise against its base, entry by entry.
    if let Ok(path) = std::env::var("LD01_PERF_ROWS_OUT") {
        let rows: Vec<Value> = states
            .iter()
            .map(|s| {
                joined
                    .evaluate(s.t, &s.y, &s.yp, None, 0., None)
                    .expect("value residual");
                json!({"state": s.label, "rows": joined.rows().iter().map(|r| r.value).collect::<Vec<_>>()})
            })
            .collect();
        write_receipt(&path, &json!({"app_commit": commit, "rows": rows}));
    }
    let mut jacobian_identity = Value::Null;
    if jacobians {
        let hot = &states[0];
        let structure = JoinedJacobian::compile(&mut joined, hot.t, &hot.y).expect("block compile");
        let mut values = vec![0.; structure.pattern.nonzeros()];
        jacobian_blocks(
            &mut joined,
            &structure,
            hot.t,
            cj,
            &hot.y,
            &hot.yp,
            &mut values,
            Classes::ALL,
        )
        .expect("block assembly");
        let blocks = hex(fnv(FNV0, values.iter().map(|v| v.to_bits())));
        let (_, colored, colors, colored_s) = joined_colored(&mut joined, &hot.y, &hot.yp, cj);
        jacobian_identity = json!({"state": hot.label, "cj": cj,
            "blocks": blocks, "block_nonzeros": values.len(),
            "colored": hex(fnv(FNV0, colored.iter().map(|v| v.to_bits()))),
            "colored_nonzeros": colored.len(), "colors": colors, "colored_cpu_s": colored_s});
    }
    // Interleaved rounds: per state, `samples` x `calls` value residuals.
    let mut per_state: Vec<Vec<f64>> = vec![Vec::new(); states.len()];
    let mut by_round = Vec::new();
    for round in 0..rounds {
        let load = load_average();
        let mut row = Vec::new();
        for (k, s) in states.iter().enumerate() {
            let before = joined.counters;
            let mut this = Vec::with_capacity(samples);
            for _ in 0..samples {
                let c = cpu();
                for _ in 0..calls {
                    joined.evaluate(s.t, &s.y, &s.yp, None, 0., None).unwrap();
                }
                this.push((cpu() - c) / calls as f64);
            }
            let after = joined.counters;
            let evaluations = (after.residuals - before.residuals) as f64;
            let coupled = (after.coupled_wall_s - before.coupled_wall_s) / evaluations;
            let total = (after.residual_wall_s - before.residual_wall_s) / evaluations;
            this.sort_by(f64::total_cmp);
            row.push(json!({"state": s.label, "best_ms": 1e3 * this[0],
                "median_ms": 1e3 * quantile(&this, 0.5),
                "wall_ms": 1e3 * total, "coupled_owners_wall_ms": 1e3 * coupled,
                "network_wall_ms": 1e3 * (total - coupled)}));
            per_state[k].extend(this);
        }
        by_round.push(json!({"round": round, "load": load, "states": row}));
    }
    let summary: Vec<Value> = states
        .iter()
        .zip(&per_state)
        .map(|(s, v)| {
            let mut w = v.clone();
            w.sort_by(f64::total_cmp);
            json!({"state": s.label, "samples": w.len(), "calls_per_sample": calls,
                "best_ms": 1e3 * w[0], "q25_ms": 1e3 * quantile(&w, 0.25),
                "median_ms": 1e3 * quantile(&w, 0.5), "q75_ms": 1e3 * quantile(&w, 0.75)})
        })
        .collect();
    // An optional spin for an external sampler: value residuals for the
    // given CPU seconds at the last state.
    if let Ok(spin) = std::env::var("LD01_PERF_SPIN_S") {
        let spin: f64 = spin.parse().unwrap();
        let s = states.last().unwrap();
        println!(
            "spinning {spin} s at {} (pid {})",
            s.label,
            std::process::id()
        );
        let c = cpu();
        while cpu() - c < spin {
            joined.evaluate(s.t, &s.y, &s.yp, None, 0., None).unwrap();
        }
    }
    let receipt = json!({
        "kind": "perf-joined-value-residual-profile-NOT-EVIDENCE",
        "team": "PERF",
        "status": "cost and identity measurement of the composed joined residual; S2 is not declared",
        "clock": "CLOCK_THREAD_CPUTIME_ID per value residual, QOS_CLASS_USER_INTERACTIVE",
        "app_commit": commit, "app_tracked_dirty": dirty,
        "packet": declared.packet_path, "packet_sha256": sha256_file(&declared.packet_path),
        "wiki": std::env::var("LD01_WIKI_ROOT").ok(),
        "water_lib_dir": env!("LD01_OPERATING_WATER_LIB_DIR"),
        "settled_state": settled_source,
        "dimension": n, "offsets": joined.offsets(),
        "preparation_cpu_s": preparation_cpu_s,
        "load_average_start": load_start,
        "identity": identity, "jacobian_identity": jacobian_identity,
        "summary": summary, "rounds": by_round,
        "load_average_end": load_average(),
    });
    println!("{}", serde_json::to_string(&receipt).unwrap());
    if let Ok(path) = std::env::var("LD01_PERF_RECEIPT") {
        write_receipt(&path, &receipt);
    }
}
