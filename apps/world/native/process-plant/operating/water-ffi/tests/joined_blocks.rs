//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#6-solver-properties-and-cost-obligations
//! The joined block Jacobian's pieces against the exact seeded evaluation of
//! the residual they differentiate and against the colored joined matrix,
//! on the actual packet at the hot reference. Zero-time checks, NOT S2
//! evidence.
#![cfg(all(feature = "ida", target_os = "macos"))]
mod jacobian_harness;
use jacobian_harness::*;
use leitbild_operating_plant::{
    joined::{
        block::Coordinates,
        blocks::{NuclearPartials, nuclear_partials},
        nuclear::{Heat, LinearTemplate, Nuclear, RegionWater, Target},
        packet,
    },
    network::Properties,
    thermal::{self, Scalar},
};
use leitbild_operating_water::If97;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// The nuclear block's rhs Jacobian (physical) from the template and the
/// partials: rows and the two heat outputs (rows `usize::MAX - a` for fuel
/// heat, `usize::MAX / 2 - a` for coolant heat).
fn rhs_entries(template: &LinearTemplate, p: &NuclearPartials) -> BTreeMap<(usize, usize), f64> {
    let mut m = BTreeMap::new();
    let mut add = |row: usize, column: usize, v: f64| *m.entry((row, column)).or_insert(0.) += v;
    for (row, column, v) in &p.own {
        add(*row, *column, *v);
    }
    for r in &template.rows {
        add(r.row, r.row, -r.decay_per_s);
        for &(feed, c) in &template.terms[r.terms.clone()] {
            for &(column, d) in &p.feeds[feed] {
                add(r.row, column, c * d);
            }
        }
    }
    for (target, column, c) in &template.consumers {
        match target {
            Target::Row(row) => add(*row, *column, *c),
            Target::FuelHeat(a) => add(usize::MAX - a, *column, *c),
            Target::CoolantHeat(a) => add(usize::MAX / 2 - a, *column, *c),
        }
    }
    for (a, column, v) in &p.fuel_w {
        add(usize::MAX - a, *column, *v);
    }
    for (a, column, v) in &p.coolant_w {
        add(usize::MAX / 2 - a, *column, *v);
    }
    m
}

#[test]
#[ignore = "requires the S1 packet, the wiki gates, maintained IF97 and stock IDA/KLU"]
fn nuclear_partials_against_seeded_rows() {
    let declared = Declared::load();
    let full = false;
    let settled = settle(&declared, &[46.], Assembly::Blocks)
        .outputs
        .pop()
        .unwrap();
    let JoinedHot { mut joined, y, .. } = joined_hot(&declared, &settled, full);
    let n = joined.dimension();
    let zero = vec![0.; n];
    joined.evaluate(0., &y, &zero, None, 0., None).unwrap();
    let o = joined.offsets();
    let bytes = std::fs::read(&declared.packet_path).unwrap();
    let joined_packet: packet::Packet = serde_json::from_slice(&bytes).unwrap();
    let mut nuclear = Nuclear::new(&joined_packet, joined.network.cell_layout.len()).unwrap();
    let scales = nuclear.layout().scales.clone();
    let x: Vec<f64> = (o.nuclear..o.solids)
        .map(|i| y[i] * scales[i - o.nuclear])
        .collect();
    let temps = joined.temperatures().clone();
    let fuel_t: Vec<f64> = temps
        .fuel
        .iter()
        .map(|f| {
            thermal::fuel_feedback_temperature(f[0], f[1])
                .unwrap()
                .value
        })
        .collect();
    // The water each source region reads, from the same network state.
    let network = &joined.network;
    let water: Vec<RegionWater> = joined
        .source_water()
        .iter()
        .map(|&j| {
            let l = network.cell_layout[j];
            let sc = network.scales();
            let (ml, mv, b) = (
                y[l.mass[0]] * sc[l.mass[0]],
                y[l.mass[1]] * sc[l.mass[1]],
                y[l.boron] * sc[l.boron],
            );
            let u = y[l.energy[0]] * sc[l.energy[0]] / ml;
            let p = network.cell(j).pressure.value;
            let point = If97.caloric(false, p, u, false).unwrap();
            RegionWater {
                density_kg_m3: Scalar::constant((ml + mv) / network.current_volume(j).value),
                boron_ppm_eq: Scalar::constant(1e6 * b / ml),
                pressure_pa: Scalar::constant(p),
                temperature_k: Scalar::constant(If97.values(&point).temperature_k),
            }
        })
        .collect();
    let travel: Vec<f64> = joined.travel().iter().map(|t| t.value).collect();
    let template = nuclear.linear_template(o.nuclear);
    let mut partials = NuclearPartials::default();
    nuclear_partials(
        &nuclear,
        o.nuclear,
        0.,
        &x,
        &fuel_t,
        &water,
        &travel,
        &mut partials,
    )
    .expect("nuclear partials");
    let entries = rhs_entries(&template, &partials);
    let (r, a) = (nuclear.regions(), nuclear.carriers());
    let len = nuclear.layout().len();
    // Coordinate directions: every population, and every coordinate of a
    // few carriers.
    let mut columns: Vec<usize> = (0..r).collect();
    for c in [0, a / 2, a - 1] {
        for g in 0..6 {
            columns.push(nuclear.precursor(c, g));
            columns.push(nuclear.material(c, g));
        }
        for g in 0..25 {
            columns.push(nuclear.history(c, g));
        }
    }
    let yn: Vec<f64> = y[o.nuclear..o.solids].to_vec();
    let zn = vec![0.; len];
    let constant = |v: &[f64]| v.iter().map(|x| Scalar::constant(*x)).collect::<Vec<_>>();
    // One seeded nuclear evaluation: rhs and heat directions.
    let mut seeded =
        |seed: Option<&[f64]>, fuel: &[Scalar], water: &[RegionWater], rods: &[Scalar]| {
            let xc = Coordinates::new(&yn, &zn, seed, 0., &scales).unwrap();
            let mut rows = vec![Scalar::constant(0.); len];
            let mut heat = Heat::default();
            nuclear
                .rows(0., xc, fuel, water, rods, &mut rows, &mut heat)
                .expect("seeded rows");
            let rhs: Vec<f64> = rows.iter().map(|v| -v.direction).collect();
            let fuel_w: Vec<f64> = heat.fuel_w.iter().map(|v| v.direction).collect();
            let coolant_w: Vec<f64> = heat.coolant_w.iter().map(|v| v.direction).collect();
            (rhs, fuel_w, coolant_w)
        };
    let fuel0 = constant(&fuel_t);
    let rods0 = constant(&travel);
    let mut worst = 0_f64;
    let mut checked = 0;
    let mut report = Vec::new();
    let mut compare = |label: String, mine: Vec<f64>, reference: (Vec<f64>, Vec<f64>, Vec<f64>)| {
        let (rhs, fw, cw) = reference;
        let mine_rhs = &mine[..len];
        let mine_fw = &mine[len..len + a];
        let mine_cw = &mine[len + a..];
        let scale = rhs
            .iter()
            .chain(&fw)
            .chain(&cw)
            .map(|v| v.abs())
            .fold(0., f64::max)
            .max(1e-300);
        let diff = mine_rhs
            .iter()
            .zip(&rhs)
            .chain(mine_fw.iter().zip(&fw))
            .chain(mine_cw.iter().zip(&cw))
            .map(|(p, q)| (p - q).abs())
            .fold(0., f64::max)
            / scale;
        worst = worst.max(diff);
        checked += 1;
        if diff > 1e-12 {
            report.push(json!({"direction": label, "relative": diff}));
        }
    };
    for &col in &columns {
        let mut seed = vec![0.; len];
        seed[col] = 1.;
        let reference = seeded(Some(&seed), &fuel0, &water, &rods0);
        let global = o.nuclear + col;
        let mut mine = vec![0.; len + 2 * a];
        for ((row, column), v) in &entries {
            if *column != global {
                continue;
            }
            let value = v * scales[col];
            if *row >= usize::MAX / 2 - a && *row <= usize::MAX / 2 {
                mine[len + a + (usize::MAX / 2 - row)] += value;
            } else if *row >= usize::MAX - a {
                mine[len + (usize::MAX - row)] += value;
            } else {
                mine[row - o.nuclear] += value;
            }
        }
        compare(format!("coordinate {col}"), mine, reference);
    }
    // Port directions.
    let zero_seed = vec![0.; len];
    let lift = |rows_entries: Vec<(usize, f64)>| {
        let mut mine = vec![0.; len + 2 * a];
        for (row, v) in rows_entries {
            mine[row - o.nuclear] += v;
        }
        mine
    };
    for c in [0, a / 2, a - 1] {
        let mut fuel = fuel0.clone();
        fuel[c] = Scalar::new(fuel_t[c], 1.);
        let reference = seeded(Some(&zero_seed), &fuel, &water, &rods0);
        let mine = lift(
            partials
                .fuel_t
                .iter()
                .filter(|e| e.1 == c)
                .map(|e| (e.0, e.2))
                .collect(),
        );
        compare(format!("fuel temperature {c}"), mine, reference);
    }
    for i in [0, r / 2, r - 1] {
        for field in 0..2 {
            let mut w = water.clone();
            if field == 0 {
                w[i].density_kg_m3 = Scalar::new(w[i].density_kg_m3.value, 1.);
            } else {
                w[i].boron_ppm_eq = Scalar::new(w[i].boron_ppm_eq.value, 1.);
            }
            let reference = seeded(Some(&zero_seed), &fuel0, &w, &rods0);
            let mine = lift(
                partials
                    .water
                    .iter()
                    .filter(|e| e.1 == i)
                    .map(|e| (e.0, e.2[field]))
                    .collect(),
            );
            compare(format!("water {i} field {field}"), mine, reference);
        }
    }
    for rod in 0..travel.len().min(6) {
        let mut rods = rods0.clone();
        rods[rod] = Scalar::new(travel[rod], 1.);
        let reference = seeded(Some(&zero_seed), &fuel0, &water, &rods);
        let mine = lift(
            partials
                .travel
                .iter()
                .filter(|e| e.1 == rod)
                .map(|e| (e.0, e.2))
                .collect(),
        );
        compare(format!("travel {rod}"), mine, reference);
    }
    println!(
        "{}",
        json!({"kind": "nuclear-partials-check-NOT-EVIDENCE", "directions": checked,
        "worst_relative": worst, "above_1e-12": report})
    );
    assert!(
        worst <= 1e-12,
        "nuclear partials differ from the seeded rows: {worst}"
    );
}

/// The block assembly (every class) against the colored joined reference,
/// entry by entry and column-relative, and the block pattern against every
/// colored nonzero; stock KLU on both patterns.
#[test]
#[ignore = "requires the S1 packet, the wiki gates, maintained IF97 and stock IDA/KLU; zero-time check"]
fn joined_blocks_against_colored() {
    use leitbild_operating_plant::joined::blocks::{Classes, JoinedJacobian, jacobian_blocks};
    prefer_performance_core();
    let full = std::env::var("LD01_JAC_PREPARED_PORTS").is_err();
    let declared = Declared::load();
    let settled = settle(&declared, &[46.], Assembly::Blocks)
        .outputs
        .pop()
        .unwrap();
    let JoinedHot {
        mut joined, y: y0, ..
    } = joined_hot(&declared, &settled, full);
    let n = joined.dimension();
    let o = joined.offsets();
    let zero = vec![0.; n];
    let cj = 20.;
    // The structure is compiled at the hot reference; LD01_JAC_PERTURB
    // (relative) moves every coordinate by a recorded pseudo-random factor
    // before both assemblies, so the pattern is checked at another state.
    let started = cpu();
    let structure = JoinedJacobian::compile(&mut joined, 0., &y0).expect("block compile");
    let compile_s = cpu() - started;
    let perturb: f64 = std::env::var("LD01_JAC_PERTURB").map_or(0., |v| v.parse().unwrap());
    let mut state = 0x5eed_u64;
    let y: Vec<f64> = y0
        .iter()
        .map(|v| {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let u = 2. * ((state >> 11) as f64 / (1u64 << 53) as f64) - 1.;
            v * (1. + perturb * u)
        })
        .collect();
    let (reference, colored, colors, colored_s) = joined_colored(&mut joined, &y, &zero, cj);
    let mine = &structure.pattern;
    // Every colored nonzero lies in the block pattern.
    let mut outside = Vec::new();
    for j in 0..n {
        for (row, v) in stored_column(&reference, &colored, j) {
            if v != 0. && mine.position(row, j).is_none() {
                outside.push(json!({"row": row, "column": j, "value": v}));
            }
        }
    }
    let classes = Classes::ALL;
    let mut values = vec![0.; mine.nonzeros()];
    let mut best = f64::INFINITY;
    let mut refused = None;
    for _ in 0..3 {
        let s = cpu();
        if let Err(e) = jacobian_blocks(
            &mut joined,
            &structure,
            0.,
            cj,
            &y,
            &zero,
            &mut values,
            classes,
        ) {
            refused = Some(format!("{e:?}"));
            break;
        }
        best = best.min(cpu() - s);
    }
    let mut worst = 0_f64;
    let mut worst_at = json!(null);
    let mut differing = Vec::new();
    for j in 0..n {
        let mut entries: BTreeMap<usize, [f64; 2]> = BTreeMap::new();
        for (row, v) in stored_column(&reference, &colored, j) {
            entries.entry(row).or_default()[0] = v;
        }
        for (row, v) in stored_column(mine, &values, j) {
            entries.entry(row).or_default()[1] = v;
        }
        let compared: Vec<(usize, [f64; 2])> = entries.into_iter().collect();
        let scale = compared
            .iter()
            .map(|(_, e)| e[0].abs())
            .fold(0., f64::max)
            .max(1e-300);
        for (row, e) in &compared {
            let d = (e[0] - e[1]).abs() / scale;
            if d > worst {
                worst = d;
                worst_at = json!({"row": row, "column": j, "colored": e[0], "blocks": e[1]});
            }
            if d > 1e-9 && differing.len() < 200000 {
                differing.push(json!({"row": row, "column": j, "colored": e[0], "blocks": e[1], "relative": d}));
            }
        }
    }
    // Stock KLU on the block pattern, with the colored matrix's own values
    // (every colored nonzero lies in it), against the structural pattern.
    let mut on_mine = vec![0.; mine.nonzeros()];
    for j in 0..n {
        for (row, v) in stored_column(&reference, &colored, j) {
            if let Some(k) = mine.position(row, j) {
                on_mine[k] = v;
            }
        }
    }
    let klu = |p: &leitbild_operating_plant::sparse::Pattern, v: &[f64]| {
        let (pointers, rows) = p.to_i64().unwrap();
        json!({"colamd": klu_profile(&pointers, &rows, &[v.to_vec()], 3),
            "amd": klu_profile_ordered(&pointers, &rows, &[v.to_vec()], 3, 0)})
    };
    let klu_blocks = if outside.is_empty() {
        klu(mine, &on_mine)
    } else {
        json!(null)
    };
    let klu_structural = klu(&reference, &colored);
    let receipt = json!({
        "kind": "s2-joined-blocks-against-colored-NOT-EVIDENCE",
        "relative_state_perturbation": perturb,
        "block_assembly_refused": refused,
        "klu_block_pattern": klu_blocks, "klu_structural_pattern": klu_structural,
        "composition": {"dimension": n, "offsets": o, "full_owners": full},
        "colored": {"pattern_nonzeros": reference.nonzeros(), "colors": colors, "ms": 1e3 * colored_s},
        "blocks": {"pattern_nonzeros": mine.nonzeros(), "compile_ms": 1e3 * compile_s,
            "jacobian_ms": 1e3 * best},
        "colored_nonzeros_outside_block_pattern": outside.len(),
        "outside_sample": outside.iter().take(20).collect::<Vec<_>>(),
        "columns_compared": n,
        "worst_column_relative": worst, "worst_at": worst_at,
        "above_1e-9": differing,
    });
    println!("{}", serde_json::to_string(&receipt).unwrap());
    assert!(
        outside.is_empty(),
        "colored nonzeros outside the block pattern"
    );
    assert!(
        worst <= 1e-9,
        "block columns differ from the colored reference: {worst}"
    );
}

/// Diagnostic: one coordinate's exact seeded joined direction (the dense
/// column), its rows' owners in the network layout, and whether the
/// operator's structural pattern stores each nonzero row.
#[test]
#[ignore = "diagnostic; LD01_JAC_PROBE_COLUMN selects the coordinate"]
fn joined_single_column_probe() {
    let columns: Vec<usize> = std::env::var("LD01_JAC_PROBE_COLUMN")
        .expect("LD01_JAC_PROBE_COLUMN")
        .split(',')
        .map(|c| c.parse().unwrap())
        .collect();
    let declared = Declared::load();
    let full = std::env::var("LD01_JAC_PREPARED_PORTS").is_err();
    let settled = settle(&declared, &[46.], Assembly::Blocks)
        .outputs
        .pop()
        .unwrap();
    let JoinedHot { mut joined, y, .. } = joined_hot(&declared, &settled, full);
    let n = joined.dimension();
    let zero = vec![0.; n];
    let structural = joined.structural_pattern().unwrap();
    let cell_layout = joined.network.cell_layout.clone();
    let face_layout = joined.network.face_layout.clone();
    let pzr = joined.network.pzr.coordinates();
    let owner = |i: usize| -> String {
        for (c, l) in cell_layout.iter().enumerate() {
            if i == l.boron || l.mass.contains(&i) || l.energy.contains(&i) || i == l.base {
                return format!("cell {c} (base {})", l.base);
            }
        }
        for l in &face_layout {
            if l.index == i {
                return format!("face {} phase {}", l.face, l.phase);
            }
        }
        if pzr.contains(&i) {
            return format!("pzr +{}", i - pzr.start);
        }
        format!("joined {i}")
    };
    let mut seed = vec![0.; n];
    for &j in &columns {
        seed.fill(0.);
        seed[j] = 1.;
        joined
            .evaluate(0., &y, &zero, Some(&seed), 20., None)
            .unwrap();
        let rows: Vec<Value> = joined
            .rows()
            .iter()
            .enumerate()
            .filter(|(_, r)| r.direction != 0.)
            .map(|(i, r)| {
                json!({"row": i, "owner": owner(i), "d": r.direction,
                    "stored": structural[j].binary_search(&i).is_ok()})
            })
            .collect();
        println!(
            "{}",
            json!({"column": j, "owner": owner(j), "nonzero_rows": rows})
        );
    }
}

/// Z5 cost of the joined block Jacobian at the hot reference: thread CPU
/// by column class and by piece, the property calls of each, the value
/// residual, the colored reference and stock KLU on the block pattern,
/// in interleaved rounds so that ratios within a round survive machine
/// load. Each class alone includes the common base (one joined evaluation,
/// the nuclear partials and the replay's network base pass).
#[test]
#[ignore = "requires the S1 packet, the wiki gates, maintained IF97 and stock IDA/KLU; zero-time Z5 measurement"]
fn joined_blocks_profile() {
    use leitbild_operating_plant::joined::blocks::{
        Classes, JoinedJacobian, Profile, jacobian_blocks, jacobian_blocks_profiled,
    };
    use std::{cell::RefCell, rc::Rc};
    prefer_performance_core();
    let rounds: usize = std::env::var("LD01_JAC_ROUNDS").map_or(5, |r| r.parse().unwrap());
    let declared = Declared::load();
    let load_start = load_average();
    let commit = command("git", &["rev-parse", "HEAD"]);
    let dirty = !command("git", &["status", "--porcelain"]).is_empty();
    let settled = settle(&declared, &[46.], Assembly::Blocks)
        .outputs
        .pop()
        .unwrap();
    let ledger: Shared = Rc::new(RefCell::new(Ledger::default()));
    let JoinedHot { mut joined, y, .. } =
        joined_hot_with(&declared, &settled, true, || Timed(ledger.clone()));
    let n = joined.dimension();
    let o = joined.offsets();
    let zero = vec![0.; n];
    let cj = 20.;
    let started = cpu();
    let structure = JoinedJacobian::compile(&mut joined, 0., &y).expect("block compile");
    let compile_ms = 1e3 * (cpu() - started);
    let mut values = vec![0.; structure.pattern.nonzeros()];
    let configurations: [(&str, Classes); 7] = [
        ("base only", Classes::NONE),
        (
            "network columns",
            Classes {
                network: true,
                ..Classes::NONE
            },
        ),
        (
            "nuclear columns",
            Classes {
                nuclear: true,
                ..Classes::NONE
            },
        ),
        (
            "solid columns",
            Classes {
                solids: true,
                ..Classes::NONE
            },
        ),
        (
            "secondary columns",
            Classes {
                secondary: true,
                ..Classes::NONE
            },
        ),
        (
            "rod columns",
            Classes {
                rods: true,
                ..Classes::NONE
            },
        ),
        ("all", Classes::ALL),
    ];
    let mut times: Vec<Vec<f64>> = vec![Vec::new(); configurations.len() + 2];
    let mut calls = Vec::new();
    let mut pieces: std::collections::BTreeMap<&str, (u64, f64)> = Default::default();
    let mut ratios = Vec::new();
    let mut klu = json!(null);
    for round in 0..rounds {
        // The value residual, best of 5 within the round.
        let mut value = f64::INFINITY;
        for _ in 0..5 {
            let s = cpu();
            joined.evaluate(0., &y, &zero, None, 0., None).unwrap();
            value = value.min(cpu() - s);
        }
        times[configurations.len()].push(value);
        let mut this = Vec::new();
        for (k, (label, classes)) in configurations.iter().enumerate() {
            let before = ledger.borrow().snapshot();
            let s = cpu();
            jacobian_blocks(
                &mut joined,
                &structure,
                0.,
                cj,
                &y,
                &zero,
                &mut values,
                *classes,
            )
            .expect("block assembly");
            let spent = cpu() - s;
            times[k].push(spent);
            this.push(spent);
            if round == 0 {
                let after = ledger.borrow().snapshot();
                calls.push(
                    json!({"classes": label, "property_calls": Ledger::between(&before, &after)}),
                );
            }
        }
        let mut profile = Profile::new(cpu);
        jacobian_blocks_profiled(
            &mut joined,
            &structure,
            0.,
            cj,
            &y,
            &zero,
            &mut values,
            Classes::ALL,
            &mut profile,
        )
        .expect("profiled block assembly");
        if round == 0 {
            for (piece, (c, sec)) in profile.pieces {
                pieces.insert(piece, (c, sec));
            }
        } else {
            for (piece, (_, sec)) in profile.pieces {
                let e = pieces.get_mut(piece).unwrap();
                e.1 = e.1.min(sec);
            }
        }
        // The colored reference once per round.
        let (reference, colored, _, colored_s) = joined_colored(&mut joined, &y, &zero, cj);
        times[configurations.len() + 1].push(colored_s);
        let all = *this.last().unwrap();
        ratios.push(
            json!({"round": round, "all_ms": 1e3 * all, "colored_ms": 1e3 * colored_s,
            "value_residual_ms": 1e3 * value, "colored_over_blocks": colored_s / all,
            "blocks_over_value_residual": all / value}),
        );
        if round == 0 {
            jacobian_blocks(
                &mut joined,
                &structure,
                0.,
                cj,
                &y,
                &zero,
                &mut values,
                Classes::ALL,
            )
            .unwrap();
            let (pointers, rows) = structure.pattern.to_i64().unwrap();
            let _ = (reference, colored);
            klu = json!({"colamd": klu_profile(&pointers, &rows, &[values.clone()], 3),
                "amd": klu_profile_ordered(&pointers, &rows, &[values.clone()], 3, 0)});
        }
    }
    let summary = |v: &Vec<f64>| {
        let mut w = v.clone();
        w.sort_by(f64::total_cmp);
        json!({"min_ms": 1e3 * w[0], "median_ms": 1e3 * w[w.len() / 2]})
    };
    let by_class: Vec<Value> = configurations
        .iter()
        .enumerate()
        .map(|(k, (label, _))| json!({"classes": label, "cpu": summary(&times[k])}))
        .collect();
    let receipt = json!({
        "kind": "s2-z5-joined-block-jacobian-cost-NOT-EVIDENCE",
        "team": "JAC",
        "status": "zero-time measurement at the hot reference; S2 is not declared",
        "clock": "CLOCK_THREAD_CPUTIME_ID, QOS_CLASS_USER_INTERACTIVE",
        "app_commit": commit, "app_dirty": dirty,
        "packet": declared.packet_path, "packet_sha256": sha256_file(&declared.packet_path),
        "load_average_start": load_start,
        "composition": {"dimension": n, "offsets": o},
        "cj_per_s": cj, "rounds": rounds,
        "block_pattern_nonzeros": structure.pattern.nonzeros(), "compile_ms": compile_ms,
        "value_residual": summary(&times[configurations.len()]),
        "colored_reference": summary(&times[configurations.len() + 1]),
        "by_class": by_class,
        "pieces_of_all_min_over_rounds_ms": pieces.iter().map(|(k, (c, sec))| json!({"piece": k, "calls": c, "ms": 1e3 * sec})).collect::<Vec<_>>(),
        "property_calls_round_0": calls,
        "within_round": ratios,
        "klu_block_pattern": klu,
        "load_average_end": load_average(),
    });
    println!("{}", serde_json::to_string(&receipt).unwrap());
    if let Ok(path) = std::env::var("LD01_JAC_RECEIPT") {
        write_receipt(&path, &receipt);
    }
}

/// Diagnostic: sizes of the solids' incidence and of the closed scopes the
/// owner columns evaluate.
#[test]
#[ignore = "diagnostic of the solids' closed scopes"]
fn joined_solid_scopes() {
    use leitbild_operating_plant::joined::solids::SolidScope;
    let declared = Declared::load();
    let settled = settle(&declared, &[46.], Assembly::Blocks)
        .outputs
        .pop()
        .unwrap();
    let JoinedHot { joined, .. } = joined_hot(&declared, &settled, true);
    let solids = joined.solids();
    let inc = solids.incidence();
    let halves = solids.halves();
    for a in [192usize, 193, 194, 195] {
        println!(
            "half {a}: helium {} wets {:?}",
            inc.halves[a].0, inc.halves[a].1
        );
    }
    println!("passive (first 5): {:?}", &inc.passive[..5]);
    println!("segments: {:?}", inc.segments);
    for c in [0usize, 1, 9, 10] {
        println!(
            "flux reads of cell {c}: {:?}",
            joined.network.liquid_flux_reads(c)
        );
    }
    let mut sizes = BTreeMap::new();
    for a in 0..halves {
        let c = solids.close(&SolidScope {
            bands: vec![a],
            ..Default::default()
        });
        *sizes
            .entry((
                c.bands.len(),
                c.plenum.len(),
                c.passive.len(),
                c.helium.len(),
            ))
            .or_insert(0) += 1;
    }
    let helium = inc
        .halves
        .iter()
        .map(|h| h.0)
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    let wets: Vec<usize> = inc.halves.iter().map(|h| h.1.len()).collect();
    println!(
        "{}",
        json!({"halves": halves, "helium_stores": helium, "passive_contacts": inc.passive.len(),
            "plenum_contacts": inc.plenum.len(), "segments": inc.segments.len(),
            "max_cells_wetted_per_half": wets.iter().max(),
            "closed_scope_of_one_half (bands, plenum, passive, helium) -> halves": sizes.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>()})
    );
}

/// Diagnostic: the block pattern's densest rows and columns, and stock KLU
/// on the same matrix with its `k` densest coordinates bordered out (their
/// rows and columns replaced by the unit diagonal), the remainder a
/// bordered solve would factor. A measurement for the linear-solver
/// decision; nothing here changes the solver.
#[test]
#[ignore = "diagnostic of the block pattern's dense lines and their KLU fill"]
fn joined_dense_lines() {
    use leitbild_operating_plant::{
        joined::blocks::{Classes, JoinedJacobian, jacobian_blocks},
        sparse::Pattern,
    };
    let declared = Declared::load();
    let settled = settle(&declared, &[46.], Assembly::Blocks)
        .outputs
        .pop()
        .unwrap();
    let JoinedHot { mut joined, y, .. } = joined_hot(&declared, &settled, true);
    let n = joined.dimension();
    let o = joined.offsets();
    let zero = vec![0.; n];
    let structure = JoinedJacobian::compile(&mut joined, 0., &y).expect("block compile");
    let p = &structure.pattern;
    let mut values = vec![0.; p.nonzeros()];
    jacobian_blocks(
        &mut joined,
        &structure,
        0.,
        20.,
        &y,
        &zero,
        &mut values,
        Classes::ALL,
    )
    .expect("block assembly");
    let mut row_count = vec![0usize; n];
    for &r in p.indices() {
        row_count[r] += 1;
    }
    let col_count: Vec<usize> = (0..n).map(|j| p.column(j).len()).collect();
    let block = |i: usize| match i {
        i if i < o.nuclear => "network",
        i if i < o.solids => "nuclear",
        i if i < o.secondary => "solids",
        i if i < o.rods => "secondary",
        _ => "rods",
    };
    let mut lines: Vec<(usize, usize)> = (0..n).map(|i| (row_count[i] + col_count[i], i)).collect();
    lines.sort_unstable_by(|a, b| b.cmp(a));
    let top: Vec<Value> = lines
        .iter()
        .take(40)
        .map(|(c, i)| json!({"coordinate": i, "block": block(*i), "row_nnz": row_count[*i], "column_nnz": col_count[*i], "sum": c}))
        .collect();
    // Stored entries that are exactly zero at this state, by (column
    // block, row block): what the pattern holds beyond this state's needs.
    let mut zeros: BTreeMap<String, [usize; 2]> = BTreeMap::new();
    for j in 0..n {
        for (row, v) in stored_column(p, &values, j) {
            let e = zeros
                .entry(format!("{} column / {} row", block(j), block(row)))
                .or_insert([0, 0]);
            e[0] += 1;
            if v == 0. {
                e[1] += 1;
            }
        }
    }
    println!(
        "{}",
        json!({"stored_and_exact_zero_by_block": zeros.iter().map(|(k, v)| json!({"blocks": k, "stored": v[0], "exact_zero": v[1]})).collect::<Vec<_>>()})
    );
    // Stock KLU on this state's nonzeros only (the diagonal kept): the
    // bound on what an element-exact pattern could reach here.
    {
        let mut columns = vec![Vec::new(); n];
        let mut v = Vec::new();
        for (j, column) in columns.iter_mut().enumerate() {
            for (row, value) in stored_column(p, &values, j) {
                if value != 0. || row == j {
                    column.push(row);
                    v.push(value);
                }
            }
        }
        let q = Pattern::from_columns(n, &columns).unwrap();
        let (pointers, rows) = q.to_i64().unwrap();
        let colamd = klu_profile(&pointers, &rows, &[v.clone()], 3);
        let amd = klu_profile_ordered(&pointers, &rows, &[v], 3, 0);
        println!(
            "{}",
            json!({"state_nonzeros": q.nonzeros(),
                "colamd": {"refactor_ms": colamd["refactor_ms"], "factor_ms": colamd["factor_ms"], "lnz_plus_unz": colamd["lnz_plus_unz"]},
                "amd": {"refactor_ms": amd["refactor_ms"], "factor_ms": amd["factor_ms"], "lnz_plus_unz": amd["lnz_plus_unz"]}})
        );
    }
    // What the nonzero cross-block entries are, by coordinate kind.
    {
        let net = &joined.network;
        let solids = joined.solids();
        let halves = solids.halves();
        let network_kind = |i: usize| -> String {
            for l in &net.cell_layout {
                for (name, index) in [
                    ("p", l.base),
                    ("B", l.boron),
                    ("M_l", l.mass[0]),
                    ("U_l", l.energy[0]),
                    ("M_v", l.mass[1]),
                    ("U_v", l.energy[1]),
                ] {
                    if index == i {
                        return name.into();
                    }
                }
            }
            for l in &net.face_layout {
                if l.index == i {
                    return format!("impulse phase {}", l.phase);
                }
            }
            if net.pzr.coordinates().contains(&i) {
                return "pzr".into();
            }
            "rotor".into()
        };
        let solid_kind = |i: usize| -> String {
            let k = i - o.solids;
            if k < 3 * halves {
                format!("energy {}", k % 3)
            } else if k < 6 * halves {
                format!("surface {}", (k - 3 * halves) % 3)
            } else if k < solids.passive(0) {
                "helium".into()
            } else if k < solids.metal(0) {
                "passive".into()
            } else {
                "metal".into()
            }
        };
        let kind = |i: usize| -> String {
            match block(i) {
                "network" => format!("network {}", network_kind(i)),
                "solids" => format!("solids {}", solid_kind(i)),
                b => b.to_string(),
            }
        };
        let mut kinds: BTreeMap<String, [usize; 2]> = BTreeMap::new();
        for j in 0..n {
            for (row, v) in stored_column(p, &values, j) {
                let (cb, rb) = (block(j), block(row));
                if cb == rb && cb != "network" {
                    continue;
                }
                if !["network", "solids", "rods"].contains(&cb)
                    || !["network", "solids"].contains(&rb)
                {
                    continue;
                }
                let e = kinds
                    .entry(format!("{} -> {}", kind(j), kind(row)))
                    .or_insert([0, 0]);
                e[0] += 1;
                if v != 0. {
                    e[1] += 1;
                }
            }
        }
        println!(
            "{}",
            json!({"cross_kinds_stored_nonzero": kinds.iter().map(|(k, v)| json!([k, v[0], v[1]])).collect::<Vec<_>>()})
        );
    }
    // Stock KLU (AMD) with this state's exact zeros dropped in one
    // (column block, row block) at a time: which closures cost the fill.
    {
        let mut by_category = Vec::new();
        for (cb, rb) in [
            ("rods", "solids"),
            ("network", "solids"),
            ("nuclear", "solids"),
            ("solids", "network"),
            ("rods", "network"),
            ("nuclear", "network"),
            ("network", "network"),
            ("solids", "solids"),
        ] {
            let mut columns = vec![Vec::new(); n];
            let mut v = Vec::new();
            for (j, column) in columns.iter_mut().enumerate() {
                for (row, value) in stored_column(p, &values, j) {
                    let dropped = value == 0. && row != j && block(j) == cb && block(row) == rb;
                    if !dropped {
                        column.push(row);
                        v.push(value);
                    }
                }
            }
            let q = Pattern::from_columns(n, &columns).unwrap();
            let (pointers, rows) = q.to_i64().unwrap();
            let amd = klu_profile_ordered(&pointers, &rows, &[v], 3, 0);
            by_category.push(
                json!({"zeros_dropped_in": format!("{cb} columns / {rb} rows"),
                "nonzeros": q.nonzeros(), "amd_refactor_ms": amd["refactor_ms"]["mean"],
                "amd_lnz_plus_unz": amd["lnz_plus_unz"]["max"]}),
            );
        }
        println!("{}", json!({"zeros_dropped_by_category": by_category}));
    }
    // Where the densest column's rows lie, and the densest rows.
    let densest = lines[0].1;
    let mut histogram: BTreeMap<&str, usize> = BTreeMap::new();
    for r in p.column(densest) {
        *histogram.entry(block(*r)).or_insert(0) += 1;
    }
    let mut by_row: Vec<(usize, usize)> = (0..n).map(|i| (row_count[i], i)).collect();
    by_row.sort_unstable_by(|a, b| b.cmp(a));
    let dense_rows: Vec<Value> = by_row
        .iter()
        .take(12)
        .map(|(c, i)| json!({"row": i, "block": block(*i), "row_nnz": c}))
        .collect();
    let mut by_col: Vec<(usize, usize)> = (0..n).map(|i| (col_count[i], i)).collect();
    by_col.sort_unstable_by(|a, b| b.cmp(a));
    let dense_column_blocks: BTreeMap<&str, usize> =
        by_col
            .iter()
            .take(100)
            .fold(BTreeMap::new(), |mut m, (_, i)| {
                *m.entry(block(*i)).or_insert(0) += 1;
                m
            });
    println!(
        "{}",
        json!({"densest_column": densest, "its_rows_by_block": histogram, "densest_rows": dense_rows,
            "top_100_columns_by_block": dense_column_blocks,
            "columns_over_1000": by_col.iter().filter(|c| c.0 > 1000).count(),
            "rows_over_1000": by_row.iter().filter(|c| c.0 > 1000).count()})
    );
    let mut bordered = Vec::new();
    for k in [0usize, 24, 48, 100] {
        let out: std::collections::BTreeSet<usize> = lines.iter().take(k).map(|l| l.1).collect();
        let mut columns = vec![Vec::new(); n];
        let mut v = Vec::new();
        for (j, column) in columns.iter_mut().enumerate() {
            if out.contains(&j) {
                column.push(j);
                v.push(1.);
                continue;
            }
            for (row, value) in stored_column(p, &values, j) {
                if !out.contains(&row) {
                    column.push(row);
                    v.push(value);
                }
            }
        }
        let q = Pattern::from_columns(n, &columns).unwrap();
        let (pointers, rows) = q.to_i64().unwrap();
        let colamd = klu_profile(&pointers, &rows, &[v.clone()], 3);
        let amd = klu_profile_ordered(&pointers, &rows, &[v], 3, 0);
        bordered.push(json!({"bordered_out": k, "nonzeros": q.nonzeros(),
            "colamd": {"refactor_ms": colamd["refactor_ms"], "lnz_plus_unz": colamd["lnz_plus_unz"]},
            "amd": {"refactor_ms": amd["refactor_ms"], "lnz_plus_unz": amd["lnz_plus_unz"]}}));
    }
    println!(
        "{}",
        json!({"kind": "joined-dense-lines-NOT-EVIDENCE", "dimension": n, "offsets": o,
            "nonzeros": p.nonzeros(), "densest": top, "bordered": bordered})
    );
}

/// Diagnostic: the linear template's rows eliminated exactly. If the
/// template block `J_EE` (precursor and history coordinates) is diagonal,
/// `S = J_RR - J_RE D^-1 J_ER` is the system a template-eliminating solve
/// would factor; stock KLU is timed on `S` beside the whole matrix. A
/// measurement for the linear-solver decision; nothing here changes it.
#[test]
#[ignore = "diagnostic of the template-eliminated KLU system"]
fn joined_template_schur() {
    use leitbild_operating_plant::{
        joined::blocks::{Classes, JoinedJacobian, jacobian_blocks},
        sparse::Pattern,
    };
    let declared = Declared::load();
    let settled = settle(&declared, &[46.], Assembly::Blocks)
        .outputs
        .pop()
        .unwrap();
    let JoinedHot { mut joined, y, .. } = joined_hot(&declared, &settled, true);
    let n = joined.dimension();
    let o = joined.offsets();
    let zero = vec![0.; n];
    let structure = JoinedJacobian::compile(&mut joined, 0., &y).expect("block compile");
    let p = &structure.pattern;
    let mut values = vec![0.; p.nonzeros()];
    jacobian_blocks(
        &mut joined,
        &structure,
        0.,
        20.,
        &y,
        &zero,
        &mut values,
        Classes::ALL,
    )
    .expect("block assembly");
    let template = joined.nuclear().linear_template(o.nuclear);
    let mut eliminated = vec![false; n];
    for r in &template.rows {
        eliminated[r.row] = true;
    }
    let e_count = template.rows.len();
    // Rows of the eliminated coordinates (row-major) and the diagonal.
    let mut e_rows: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];
    let mut diagonal = vec![0.; n];
    let mut off_diagonal_ee = 0usize;
    for j in 0..n {
        for (row, v) in stored_column(p, &values, j) {
            if eliminated[row] {
                if row == j {
                    diagonal[row] = v;
                } else if eliminated[j] {
                    if v != 0. {
                        off_diagonal_ee += 1;
                    }
                } else {
                    e_rows[row].push((j, v));
                }
            }
        }
    }
    let started = cpu();
    let kept: Vec<usize> = (0..n).filter(|i| !eliminated[*i]).collect();
    let mut index = vec![usize::MAX; n];
    for (k, i) in kept.iter().enumerate() {
        index[*i] = k;
    }
    let mut s_columns: Vec<std::collections::BTreeMap<usize, f64>> =
        vec![Default::default(); kept.len()];
    for (k, &j) in kept.iter().enumerate() {
        for (row, v) in stored_column(p, &values, j) {
            if !eliminated[row] {
                *s_columns[k].entry(index[row]).or_insert(0.) += v;
            }
        }
    }
    let mut fill_terms = 0usize;
    for e in 0..n {
        if !eliminated[e] {
            continue;
        }
        let consumers: Vec<(usize, f64)> = stored_column(p, &values, e)
            .into_iter()
            .filter(|(r, v)| !eliminated[*r] && *v != 0.)
            .collect();
        for (c, a) in &e_rows[e] {
            if *a == 0. {
                continue;
            }
            for (r, b) in &consumers {
                *s_columns[index[*c]].entry(index[*r]).or_insert(0.) -= b * a / diagonal[e];
                fill_terms += 1;
            }
        }
    }
    let formation_ms = 1e3 * (cpu() - started);
    let mut columns = Vec::with_capacity(kept.len());
    let mut v = Vec::new();
    for (k, column) in s_columns.iter().enumerate() {
        let mut rows: Vec<usize> = column.keys().copied().collect();
        if !column.contains_key(&k) {
            rows.push(k);
            rows.sort_unstable();
        }
        for r in &rows {
            v.push(column.get(r).copied().unwrap_or(0.));
        }
        columns.push(rows);
    }
    let s = Pattern::from_columns(kept.len(), &columns).unwrap();
    let (pointers, rows) = s.to_i64().unwrap();
    let colamd = klu_profile(&pointers, &rows, &[v.clone()], 3);
    let amd = klu_profile_ordered(&pointers, &rows, &[v], 3, 0);
    let (fp, fr) = p.to_i64().unwrap();
    let whole_amd = klu_profile_ordered(&fp, &fr, &[values.clone()], 3, 0);
    println!(
        "{}",
        json!({"kind": "joined-template-schur-NOT-EVIDENCE", "dimension": n,
            "eliminated": e_count, "off_diagonal_template_entries": off_diagonal_ee,
            "kept": kept.len(), "schur_nonzeros": s.nonzeros(), "fill_terms": fill_terms,
            "formation_ms_test_code": formation_ms,
            "whole_amd": {"refactor_ms": whole_amd["refactor_ms"], "lnz_plus_unz": whole_amd["lnz_plus_unz"]},
            "schur_colamd": {"refactor_ms": colamd["refactor_ms"], "lnz_plus_unz": colamd["lnz_plus_unz"], "solve_ms": colamd["solve_ms"], "symbolic": colamd["symbolic"]},
            "schur_amd": {"refactor_ms": amd["refactor_ms"], "lnz_plus_unz": amd["lnz_plus_unz"], "solve_ms": amd["solve_ms"]}})
    );
}

/// Diagnostic: the template rows' feeds lifted into explicit unknowns.
/// Every template row is `x' - sum_f c_f feed_f + lambda x`, so its
/// off-diagonal entries are `-c_f g_f / row scale` with `g_f` the feed's
/// whole gradient (ports chained). The lifted Newton system adds one
/// unknown and one row `phi_f - g_f . dy = 0` per feed and gives the
/// template rows a single entry per feed instead of the gradient. The
/// linear systems are equivalent exactly; this checks the rank structure
/// on the assembled matrix and times stock KLU on the lifted one. A
/// measurement for the linear-solver decision; nothing here changes it.
#[test]
#[ignore = "diagnostic of the feed-lifted KLU system"]
fn joined_lifted_feeds() {
    use leitbild_operating_plant::{
        joined::blocks::{Classes, JoinedJacobian, jacobian_blocks},
        sparse::Pattern,
    };
    let declared = Declared::load();
    let settled = settle(&declared, &[46.], Assembly::Blocks)
        .outputs
        .pop()
        .unwrap();
    let JoinedHot { mut joined, y, .. } = joined_hot(&declared, &settled, true);
    let n = joined.dimension();
    let o = joined.offsets();
    let zero = vec![0.; n];
    let structure = JoinedJacobian::compile(&mut joined, 0., &y).expect("block compile");
    let p = &structure.pattern;
    let mut values = vec![0.; p.nonzeros()];
    jacobian_blocks(
        &mut joined,
        &structure,
        0.,
        20.,
        &y,
        &zero,
        &mut values,
        Classes::ALL,
    )
    .expect("block assembly");
    let row_scales: Vec<f64> = joined
        .layouts()
        .into_iter()
        .flat_map(|(_, l)| l.row_scales)
        .collect();
    let template = joined.nuclear().linear_template(o.nuclear);
    let feeds = template.feeds.len();
    let mut terms_of = vec![Vec::new(); n];
    for r in &template.rows {
        terms_of[r.row] = template.terms[r.terms.clone()].to_vec();
    }
    // Row-major off-diagonal entries of the template rows.
    let mut rows_of: Vec<BTreeMap<usize, f64>> = vec![BTreeMap::new(); n];
    for j in 0..n {
        for (row, v) in stored_column(p, &values, j) {
            if !terms_of[row].is_empty() && row != j && v != 0. {
                rows_of[row].insert(j, v);
            }
        }
    }
    // Each feed's gradient from a row reading it alone.
    let mut gradient: Vec<Option<BTreeMap<usize, f64>>> = vec![None; feeds];
    for r in &template.rows {
        let t = &terms_of[r.row];
        if t.len() == 1 && gradient[t[0].0].is_none() && t[0].1 != 0. {
            let (f, c) = t[0];
            gradient[f] = Some(
                rows_of[r.row]
                    .iter()
                    .map(|(col, v)| (*col, -v * row_scales[r.row] / c))
                    .collect(),
            );
        }
    }
    let missing = gradient.iter().filter(|g| g.is_none()).count();
    // Check every template row against its terms' gradients.
    let mut worst = 0_f64;
    for r in &template.rows {
        let mut rebuilt: BTreeMap<usize, f64> = BTreeMap::new();
        for (f, c) in &terms_of[r.row] {
            if let Some(g) = &gradient[*f] {
                for (col, v) in g {
                    *rebuilt.entry(*col).or_insert(0.) -= c * v / row_scales[r.row];
                }
            }
        }
        let scale = rows_of[r.row]
            .values()
            .map(|v| v.abs())
            .fold(0., f64::max)
            .max(1e-300);
        let cols: std::collections::BTreeSet<usize> = rows_of[r.row]
            .keys()
            .chain(rebuilt.keys())
            .copied()
            .collect();
        for col in cols {
            let a = rows_of[r.row].get(&col).copied().unwrap_or(0.);
            let b = rebuilt.get(&col).copied().unwrap_or(0.);
            worst = worst.max((a - b).abs() / scale);
        }
    }
    // The lifted matrix: n + feeds unknowns.
    let m = n + feeds;
    let sigma: Vec<f64> = gradient
        .iter()
        .map(|g| {
            g.as_ref().map_or(1., |g| {
                g.values().map(|v| v.abs()).fold(0., f64::max).max(1e-300)
            })
        })
        .collect();
    let mut columns: Vec<BTreeMap<usize, f64>> = vec![BTreeMap::new(); m];
    for (j, column) in columns.iter_mut().enumerate().take(n) {
        for (row, v) in stored_column(p, &values, j) {
            if terms_of[row].is_empty() || row == j {
                *column.entry(row).or_insert(0.) += v;
            }
        }
    }
    for r in &template.rows {
        for (f, c) in &terms_of[r.row] {
            *columns[n + f].entry(r.row).or_insert(0.) -= c * sigma[*f] / row_scales[r.row];
        }
    }
    for (f, g) in gradient.iter().enumerate() {
        columns[n + f].insert(n + f, 1.);
        for (col, v) in g.iter().flatten() {
            *columns[*col].entry(n + f).or_insert(0.) -= v / sigma[f];
        }
    }
    let mut lists = Vec::with_capacity(m);
    let mut v = Vec::new();
    for column in &columns {
        lists.push(column.keys().copied().collect::<Vec<_>>());
        v.extend(column.values().copied());
    }
    let lifted = Pattern::from_columns(m, &lists).unwrap();
    let (pointers, rows) = lifted.to_i64().unwrap();
    let colamd = klu_profile(&pointers, &rows, &[v.clone()], 3);
    let amd = klu_profile_ordered(&pointers, &rows, &[v], 3, 0);
    let (fp, fr) = p.to_i64().unwrap();
    let whole_colamd = klu_profile(&fp, &fr, &[values.clone()], 3);
    let whole_amd = klu_profile_ordered(&fp, &fr, &[values.clone()], 3, 0);
    let pick = |k: &Value| json!({"refactor_ms": k["refactor_ms"], "factor_ms": k["factor_ms"], "lnz_plus_unz": k["lnz_plus_unz"], "solve_ms": k["solve_ms"], "nblocks": k["symbolic"]["nblocks"], "maxblock": k["symbolic"]["maxblock"]});
    println!(
        "{}",
        json!({"kind": "joined-lifted-feeds-NOT-EVIDENCE", "dimension": n, "feeds": feeds,
            "feeds_without_a_single_term_row": missing,
            "template_rows_rebuilt_worst_relative": worst,
            "whole": {"nonzeros": p.nonzeros(), "colamd": pick(&whole_colamd), "amd": pick(&whole_amd)},
            "lifted": {"dimension": m, "nonzeros": lifted.nonzeros(), "colamd": pick(&colamd), "amd": pick(&amd)}})
    );
}
