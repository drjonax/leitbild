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

/// The block assembly's network and nuclear columns against the colored
/// joined reference, entry by entry (column-relative), and the block
/// pattern against every colored nonzero. The owners' own two heat
/// responses (fuel heat into the solid rows, SG metal heat into the
/// secondary rows) are not in this assembly and are left out of the
/// comparison by row; every other row of those columns is compared.
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
    let JoinedHot { mut joined, y, .. } = joined_hot(&declared, &settled, full);
    let n = joined.dimension();
    let o = joined.offsets();
    let zero = vec![0.; n];
    let cj = 20.;
    let (reference, colored, colors, colored_s) = joined_colored(&mut joined, &y, &zero, cj);
    let started = cpu();
    let structure = JoinedJacobian::compile(&mut joined, 0., &y).expect("block compile");
    let compile_s = cpu() - started;
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
    let classes = Classes {
        network: true,
        nuclear: true,
        owners: false,
    };
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
    let excluded = |j: usize, row: usize| {
        if j < o.nuclear {
            (o.secondary..o.rods).contains(&row)
        } else {
            (o.solids..o.secondary).contains(&row)
        }
    };
    let mut worst = 0_f64;
    let mut worst_at = json!(null);
    let mut excluded_entries = 0usize;
    let mut differing = Vec::new();
    for j in 0..o.solids {
        let mut entries: BTreeMap<usize, [f64; 2]> = BTreeMap::new();
        for (row, v) in stored_column(&reference, &colored, j) {
            entries.entry(row).or_default()[0] = v;
        }
        for (row, v) in stored_column(mine, &values, j) {
            entries.entry(row).or_default()[1] = v;
        }
        let compared: Vec<(usize, [f64; 2])> = entries
            .into_iter()
            .filter(|(row, e)| {
                let out = excluded(j, *row);
                if out && e[0] != 0. {
                    excluded_entries += 1;
                }
                !out
            })
            .collect();
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
        "block_assembly_refused": refused,
        "klu_block_pattern": klu_blocks, "klu_structural_pattern": klu_structural,
        "composition": {"dimension": n, "offsets": o, "full_owners": full},
        "colored": {"pattern_nonzeros": reference.nonzeros(), "colors": colors, "ms": 1e3 * colored_s},
        "blocks": {"pattern_nonzeros": mine.nonzeros(), "compile_ms": 1e3 * compile_s,
            "network_and_nuclear_columns_ms": 1e3 * best},
        "colored_nonzeros_outside_block_pattern": outside.len(),
        "outside_sample": outside.iter().take(20).collect::<Vec<_>>(),
        "columns_compared": o.solids,
        "owner_chain_entries_left_out": excluded_entries,
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
