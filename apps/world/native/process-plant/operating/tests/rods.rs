//! The S2 rod block on explicit fixtures: the record geometry restated here
//! and the retained at-power field of the Z4 disposition with its printed
//! water properties (research `operating-joined-spine-s2/dispositions/
//! z4-receipt.json`). Sector shares are synthetic. Neither is a compiled
//! packet or an S2 state; the actual-packet receipt lives in water-ffi.
use leitbild_operating_plant::{
    joined::block::{CellVolume, Command, Coordinates, Fluid, Receipts, Rods},
    local_flow::{Cell, Phase},
    network::Water,
    rods::{
        Bodies, Cells, ClusterSection, Guide, Holding, Mode, Region, RodBlock, Section, Span,
        Spider, SpiderDrag,
    },
    sparse::{Coloring, Pattern, compare_with_dense, scatter},
    thermal::Scalar,
};
use std::time::Instant;

const G: f64 = 9.80665;
/// A swept cell of the independent formula: index, span, share, plenum.
type Swept = (usize, f64, f64, Box<dyn Fn(usize) -> f64>, bool);
const REGIONS: [(&str, f64); 12] = [
    ("LOWER", -3.),
    ("CORE.NE.1", -1.),
    ("CORE.NE.2", 1.),
    ("CORE.NW.1", -1.),
    ("CORE.NW.2", 1.),
    ("CORE.SW.1", -1.),
    ("CORE.SW.2", 1.),
    ("CORE.SE.1", -1.),
    ("CORE.SE.2", 1.),
    ("UPPER", 3.),
    ("HOUSING.MAIN", 6.),
    ("PZR", 18.5),
];
const REGULAR: usize = 11;
const VOLUMES: [f64; 11] = [
    28.1789708, 2.5690191, 2.5369520, 2.5690191, 2.5369520, 2.5690191, 2.5369520, 2.5690191,
    2.5369520, 32.0833548, 10.0618815,
];

fn span(region: &str, bottom: f64, top: f64) -> Span {
    Span {
        region: region.into(),
        bottom_m: bottom,
        top_m: top,
    }
}
fn section(drag: SpiderDrag) -> Section {
    let clusters = (0..52)
        .map(|c| {
            let mut shares = [0.; 4];
            if c % 13 == 0 {
                shares[c % 4] = 0.5;
                shares[(c + 1) % 4] = 0.5;
            } else {
                shares[c % 4] = 1.;
            }
            ClusterSection {
                id: format!("LD01.CR.{:03}", c + 1),
                fuel_assembly: format!("FA{c}"),
                lattice: [0, 0],
                sector_shares: shares,
            }
        })
        .collect();
    let core = ["NE", "NW", "SW", "SE"].map(|k| {
        [
            span(&format!("CORE.{k}.1"), -2., 0.),
            span(&format!("CORE.{k}.2"), 0., 2.),
        ]
    });
    Section {
        identity: "fixture".into(),
        clusters,
        // The record: 24 bodies of 9.5 mm, 4.65 m seated at -2.25 m; B4C and
        // steel 14.597 + 16.407 kg; the 4 kg spider at +2.40..+2.50 m.
        bodies: Bodies {
            count: 24,
            radius_m: 0.00475,
            length_m: 4.65,
            seated_bottom_m: -2.25,
            mass_kg: 14.597096105639615 + 16.407177491761953,
        },
        spider: Spider {
            mass_kg: 4.,
            volume_m3: 4. / 7920.,
            seated_bottom_m: 2.4,
            height_m: 0.1,
            radius_m: 0.115,
        },
        guide: Guide {
            bore_radius_m: 0.0055,
            lower_mouth_m: -2.25,
            upper_mouth_m: 2.4,
            roughness_m: 2e-6,
            lower_mouth_loss: 0.5,
            upper_mouth_loss: 0.5,
            blend_speed_m_s: 1e-3,
        },
        cells: Cells {
            lower: span("LOWER", -6.9, -2.),
            core,
            upper: span("UPPER", 2., 4.),
            housing_main: span("HOUSING.MAIN", 4., 8.),
        },
        gravity_m_s2: G,
        reference_travel_m: 2.8,
        normal_travel_m: 4.,
        holding: Holding {
            turbine_trip_to_opening_s: 0.2,
        },
        spider_drag: drag,
        provenance: Vec::new(),
    }
}
fn block(drag: SpiderDrag) -> RodBlock {
    let regions: Vec<Region<'_>> = REGIONS
        .iter()
        .map(|(id, z)| Region {
            id,
            elevation_m: *z,
        })
        .collect();
    RodBlock::new(&section(drag), &regions, REGULAR, 745.7088).unwrap()
}

/// One cell's water: pressure at its reference, liquid density, viscosity,
/// enthalpy and boron concentration, each with an explicit direction.
#[derive(Clone, Copy)]
struct Water1 {
    p: Scalar,
    rho: Scalar,
    mu: Scalar,
    h: Scalar,
    c: Scalar,
}
/// The retained at-power field of Z4 (connected-primary-initialization.md
/// :308): LOWER 15.2 MPa at -2 m (563.15 K), UPPER 15,056,166 Pa at +2 m
/// (593.15 K); HOUSING.MAIN shares UPPER's water at rest. Densities and
/// viscosities are Z4's IF97 values as printed.
fn z4_field(upper_shift_pa: f64) -> Vec<Water1> {
    let (rl, ml) = (745.708757, 9.238812e-05);
    let (ru, mu) = (678.920757, 8.023731e-05);
    let pl = 15_200_000. + rl * G * (-2. - -3.);
    let pu = 15_056_166. - upper_shift_pa - ru * G * (3. - 2.);
    let pm = 15_056_166. - upper_shift_pa - ru * G * (6. - 2.);
    let w = |p: f64, rho: f64, mu: f64, h: f64| Water1 {
        p: Scalar::constant(p),
        rho: Scalar::constant(rho),
        mu: Scalar::constant(mu),
        h: Scalar::constant(h),
        c: Scalar::constant(1e-3),
    };
    let core = w(15.1e6, 715.3, 8.6e-5, 1.39e6);
    let mut cells = vec![w(pl, rl, ml, 1.2715e6)];
    cells.extend([core; 8]);
    cells.push(w(pu, ru, mu, 1.4545e6));
    cells.push(w(pm, ru, mu, 1.4545e6));
    cells
}
struct FluidData {
    cells: Vec<Cell>,
    points: Vec<[Option<(Water, Water)>; 2]>,
    zeros: Vec<Scalar>,
    elevations: Vec<f64>,
    volumes: Vec<f64>,
    current: Vec<Scalar>,
}
fn fluid_data(water: &[Water1]) -> FluidData {
    let mut cells: Vec<Cell> = water
        .iter()
        .map(|w| Cell {
            pressure: w.p,
            phase: [
                Some(Phase {
                    fraction: Scalar::constant(1.),
                    density: w.rho,
                    enthalpy: w.h,
                    boron_concentration: w.c,
                }),
                None,
            ],
        })
        .collect();
    cells.push(cells[REGULAR - 1]);
    let points = water
        .iter()
        .map(|w| {
            let value = Water {
                pressure_pa: w.p.value,
                density_kg_m3: w.rho.value,
                enthalpy_j_kg: w.h.value,
                viscosity_pa_s: w.mu.value,
                ..Water::default()
            };
            let direction = Water {
                pressure_pa: w.p.direction,
                density_kg_m3: w.rho.direction,
                enthalpy_j_kg: w.h.direction,
                viscosity_pa_s: w.mu.direction,
                ..Water::default()
            };
            [Some((value, direction)), None]
        })
        .collect();
    let mut volumes = VOLUMES.to_vec();
    volumes.push(59.7);
    FluidData {
        cells,
        points,
        zeros: vec![Scalar::constant(0.); REGULAR],
        elevations: REGIONS.iter().map(|r| r.1).collect(),
        current: VOLUMES.iter().map(|v| Scalar::constant(*v)).collect(),
        volumes,
    }
}
fn fluid(d: &FluidData) -> Fluid<'_> {
    Fluid {
        cells: &d.cells,
        points: &d.points,
        liquid_mass: &d.zeros,
        vapor_mass: &d.zeros,
        tracer: &d.zeros,
        charts: &[],
        endpoints: &[],
        elevations: &d.elevations,
        volumes: &d.volumes,
        current_volumes: &d.current,
    }
}
fn solver(b: &RodBlock, physical: &[f64]) -> Vec<f64> {
    let scales = &Rods::<()>::layout(b).scales;
    physical.iter().zip(scales).map(|(v, s)| v / s).collect()
}
fn coordinates<'a>(
    b: &'a RodBlock,
    y: &'a [f64],
    yp: &'a [f64],
    seed: Option<&'a [f64]>,
    cj: f64,
) -> Coordinates<'a> {
    Coordinates::new(y, yp, seed, cj, &Rods::<()>::layout(b).scales).unwrap()
}
/// Rows, the per-cell receipts and the moving volumes of one evaluation.
fn evaluate(
    b: &mut RodBlock,
    y: &[f64],
    yp: &[f64],
    seed: Option<&[f64]>,
    cj: f64,
    water: &[Water1],
) -> (Vec<Scalar>, Vec<[[Scalar; 3]; 2]>, Vec<CellVolume>) {
    let d = fluid_data(water);
    let f = fluid(&d);
    let mut rows = vec![Scalar::constant(0.); y.len()];
    let mut cells = vec![[[Scalar::constant(0.); 3]; 2]; REGULAR];
    let scales = Rods::<()>::layout(b).scales.clone();
    let x = Coordinates::new(y, yp, seed, cj, &scales).unwrap();
    Rods::<()>::rows(b, &(), 0., x, &f, &mut Receipts::new(&mut cells), &mut rows).unwrap();
    let mut volumes = vec![
        CellVolume {
            volume_m3: Scalar::constant(0.),
            rate_m3_s: Scalar::constant(0.)
        };
        REGULAR
    ];
    Rods::<()>::volumes(b, x, &VOLUMES, &mut volumes).unwrap();
    (rows, cells, volumes)
}

/// Every cluster held at `travel` with the prepared currents of the field.
fn held(b: &mut RodBlock, water: &[Water1], travel: f64) -> Vec<f64> {
    for c in 0..52 {
        b.set_mode(c, Mode::Held);
    }
    let d = fluid_data(water);
    let f = fluid(&d);
    b.prepare_currents_at(&f, travel).unwrap();
    Rods::<()>::prepared(b)
}

#[test]
fn z4_force_balance_and_insertion_margins_are_reproduced() {
    let water = z4_field(0.);
    let mut b = block(SpiderDrag::Omitted);
    // Z4 "guide passage from LOWER" rows: travel, current, tip and top
    // pressure, end-face and wall force, bodies' net downward force.
    let z4 = [
        (
            2.8, 1.315701, 15180092.4, 15034860.6, 247.064, 30.691, 62.157,
        ),
        (
            1.25, 0.954673, 15192341.2, 15045180.4, 250.346, 31.169, 58.398,
        ),
        (
            0.1, 0.816464, 15201036.6, 15052837.0, 252.113, 31.315, 56.484,
        ),
    ];
    let mut minimum = f64::INFINITY;
    for (travel, current, tip, top, end, wall, net_down) in z4 {
        let physical = held(&mut b, &water, travel);
        let y = solver(&b, &physical);
        let yp = vec![0.; y.len()];
        let d = fluid_data(&water);
        let f = fluid(&d);
        let x = coordinates(&b, &y, &yp, None, 0.);
        for c in [0, 13, 51] {
            let forces = b.forces(c, &x, &f).unwrap();
            assert!(
                (physical[3 * c + 2] - current).abs() < 2e-6,
                "{travel}: current {}",
                physical[3 * c + 2]
            );
            assert!(
                (forces.tip_pressure.value - tip).abs() < 0.2,
                "{travel}: tip {}",
                forces.tip_pressure.value
            );
            println!(
                "{travel}: tip {} top {} end {} wall {} net {} current {}",
                forces.tip_pressure.value,
                forces.top_pressure.value,
                forces.end_face.value,
                forces.wall.value,
                forces.net.value,
                physical[3 * c + 2]
            );
            assert!((forces.top_pressure.value - top).abs() < 0.2);
            assert!(
                (forces.end_face.value - end).abs() < 2e-3,
                "{travel}: end {}",
                forces.end_face.value
            );
            assert!(
                (forces.wall.value - wall).abs() < 2e-3,
                "{travel}: wall {}",
                forces.wall.value
            );
            assert!(
                (-forces.net.value - net_down).abs() < 2e-3,
                "{travel}: net {}",
                forces.net.value
            );
            assert!(forces.passage_residual.value.abs() < 1e-6);
            minimum = minimum.min(-forces.net.value);
        }
    }
    // The H7 margins: 62 N at release, 56 N at the minimum over the travels.
    assert!(minimum > 56. && minimum < 57.);
}

#[test]
fn passages_carry_donor_mass_enthalpy_and_tracer_conservatively() {
    let water = z4_field(0.);
    let mut b = block(SpiderDrag::Omitted);
    let mut physical = held(&mut b, &water, 2.8);
    // One reversed passage takes UPPER's water down.
    physical[3 * 7 + 2] = -0.4;
    let y = solver(&b, &physical);
    let (_, cells, _) = evaluate(&mut b, &y, &vec![0.; y.len()], None, 0., &water);
    let total: f64 = (0..52).map(|c| physical[3 * c + 2]).sum();
    let up: f64 = total + 0.4;
    let (lower, upper) = (0, 9);
    let [l, u] = [water[lower], water[upper]];
    let expect_lower = [
        -up + 0.4,
        -up * l.h.value + 0.4 * u.h.value,
        (-up + 0.4) * 1e-3,
    ];
    for k in 0..3 {
        assert!((cells[lower][0][k].value - expect_lower[k]).abs() <= 1e-9 * expect_lower[k].abs());
        // Exactly what leaves one plenum enters the other.
        assert_eq!(cells[lower][0][k].value + cells[upper][0][k].value, 0.);
        assert_eq!(cells[lower][1][k].value, 0.);
    }
    // Held bodies do no wall or drag work: no heat anywhere else.
    for (i, c) in cells.iter().enumerate() {
        if i != lower && i != upper {
            assert!(c[0].iter().all(|r| r.value == 0.), "cell {i}");
        }
    }
}

#[test]
fn moving_volumes_conserve_the_fluid_volume_and_match_the_preparation_geometry() {
    let water = z4_field(0.);
    let mut b = block(SpiderDrag::Omitted);
    let mut physical = held(&mut b, &water, 2.8);
    let travels: Vec<f64> = (0..52)
        .map(|c| 0.05 + 3.9 * ((c * 37) % 52) as f64 / 51.)
        .collect();
    let speeds: Vec<f64> = (0..52).map(|c| -1.9 + 0.07 * c as f64).collect();
    for c in 0..52 {
        physical[3 * c] = travels[c];
        physical[3 * c + 1] = speeds[c];
    }
    let y = solver(&b, &physical);
    let mut yp = vec![0.; y.len()];
    for c in 0..52 {
        yp[3 * c] = speeds[c] / Rods::<()>::layout(&b).scales[3 * c];
    }
    let (_, _, volumes) = evaluate(&mut b, &y, &yp, None, 0., &water);
    let before: f64 = VOLUMES.iter().sum();
    let after: f64 = volumes.iter().map(|v| v.volume_m3.value).sum();
    assert!(
        (after - before).abs() < 1e-12 * before,
        "{after} vs {before}"
    );
    let rate: f64 = volumes.iter().map(|v| v.rate_m3_s.value).sum();
    assert!(rate.abs() < 1e-15, "{rate}");
    // Independent preparation formula (operatingFluidGeometry): each cell's
    // free volume is its span minus the bodies' and spider's overlap.
    let ov = |lo: f64, hi: f64, a: f64, b: f64| (b.min(hi) - a.max(lo)).max(0.);
    let area = 24. * std::f64::consts::PI * 0.00475_f64.powi(2);
    let spider = 4. / 7920. / 0.1;
    let shares = |c: usize| section(SpiderDrag::Omitted).clusters[c].sector_shares;
    let displaced = |lo: f64,
                     hi: f64,
                     weight: &dyn Fn(usize) -> f64,
                     plenum: bool,
                     y: &dyn Fn(usize) -> f64| {
        (0..52)
            .map(|c| {
                let y = y(c);
                weight(c)
                    * (area * ov(lo, hi, -2.25 + y, 2.4 + y)
                        + if plenum {
                            spider * ov(lo, hi, 2.4 + y, 2.5 + y)
                        } else {
                            0.
                        })
            })
            .sum::<f64>()
    };
    let spans: Vec<Swept> = {
        let mut v: Vec<Swept> = vec![(0, -6.9, -2., Box::new(|_| 1.), true)];
        for k in 0..4 {
            for band in 0..2 {
                let (lo, hi) = if band == 0 { (-2., 0.) } else { (0., 2.) };
                v.push((
                    1 + 2 * k + band,
                    lo,
                    hi,
                    Box::new(move |c| shares(c)[k]),
                    false,
                ));
            }
        }
        v.push((9, 2., 4., Box::new(|_| 1.), true));
        v.push((10, 4., 8., Box::new(|_| 1.), true));
        v
    };
    for (cell, lo, hi, weight, plenum) in &spans {
        let expected = VOLUMES[*cell] + displaced(*lo, *hi, weight.as_ref(), *plenum, &|_| 2.8)
            - displaced(*lo, *hi, weight.as_ref(), *plenum, &|c| travels[c]);
        assert!(
            (volumes[*cell].volume_m3.value - expected).abs() < 1e-14 * VOLUMES[*cell],
            "cell {cell}: {} vs {expected}",
            volumes[*cell].volume_m3.value
        );
    }
    // At the prepared hold every cell is exactly at its compiled volume and
    // at rest, so the network evaluates it as fixed.
    let rest = held(&mut b, &water, 2.8);
    let y = solver(&b, &rest);
    let (_, _, volumes) = evaluate(&mut b, &y, &vec![0.; y.len()], None, 0., &water);
    for (v, c) in volumes.iter().zip(VOLUMES) {
        assert_eq!(
            (v.volume_m3.value, v.volume_m3.direction, v.rate_m3_s.value),
            (c, 0., 0.)
        );
    }
}

/// A state with mixed modes away from kinks, and a fluid with directions.
fn mixed(b: &mut RodBlock, water: &[Water1]) -> (Vec<f64>, Vec<f64>) {
    let mut physical = held(b, water, 2.8);
    let mut rates = vec![0.; physical.len()];
    for c in 0..52 {
        let mode = [Mode::Held, Mode::Free, Mode::Free, Mode::Seated][c % 4];
        b.set_mode(c, mode);
        if mode == Mode::Free {
            physical[3 * c] = 0.4 + 0.035 * c as f64;
            physical[3 * c + 1] = -0.3 - 0.03 * c as f64;
            rates[3 * c] = physical[3 * c + 1];
            rates[3 * c + 1] = -1.1;
        } else if mode == Mode::Seated {
            physical[3 * c] = 0.;
        }
        physical[3 * c + 2] *= 1. + 0.01 * (c % 7) as f64;
    }
    let y = solver(b, &physical);
    let scales = Rods::<()>::layout(b).scales.clone();
    let yp = rates.iter().zip(&scales).map(|(r, s)| r / s).collect();
    (y, yp)
}

#[test]
fn analytic_directions_match_differences_and_the_colored_jacobian_is_the_dense_one() {
    let water = z4_field(0.);
    let mut b = block(SpiderDrag::EnvelopeDisk { coefficient: 1.28 });
    let (y, yp) = mixed(&mut b, &water);
    let n = y.len();
    let rows_scale = Rods::<()>::layout(&b).row_scales.clone();
    let cj = 37.;
    let scaled = |rows: &[Scalar]| -> Vec<f64> {
        rows.iter()
            .zip(&rows_scale)
            .map(|(r, s)| r.value / s)
            .collect()
    };
    let directions = |b: &mut RodBlock, d: &[f64]| -> Vec<f64> {
        let (rows, _, _) = evaluate(b, &y, &yp, Some(d), cj, &water);
        rows.iter()
            .zip(&rows_scale)
            .map(|(r, s)| r.direction / s)
            .collect()
    };
    // G10: every coordinate direction and 20 random ones, 1e-6 relative in
    // the scaled-row norm against central differences of y and y'.
    let mut seeds: Vec<Vec<f64>> = (0..n)
        .map(|j| (0..n).map(|i| if i == j { 1. } else { 0. }).collect())
        .collect();
    let mut state = 0x2545_f491_4f6c_dd1d_u64;
    for _ in 0..20 {
        seeds.push(
            (0..n)
                .map(|_| {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    (state % 2001) as f64 / 1000. - 1.
                })
                .collect(),
        );
    }
    let mut worst = 0_f64;
    for d in &seeds {
        let exact = directions(&mut b, d);
        let h = 1e-7;
        let arm = |b: &mut RodBlock, sign: f64| {
            let ys: Vec<f64> = y.iter().zip(d).map(|(v, e)| v + sign * h * e).collect();
            let yps: Vec<f64> = yp
                .iter()
                .zip(d)
                .map(|(v, e)| v + sign * h * cj * e)
                .collect();
            let (rows, _, _) = evaluate(b, &ys, &yps, None, 0., &water);
            scaled(&rows)
        };
        let (plus, minus) = (arm(&mut b, 1.), arm(&mut b, -1.));
        let fd: Vec<f64> = plus
            .iter()
            .zip(&minus)
            .map(|(p, m)| (p - m) / (2. * h))
            .collect();
        let norm = exact.iter().map(|v| v * v).sum::<f64>().sqrt();
        let error = exact
            .iter()
            .zip(&fd)
            .map(|(a, f)| (a - f) * (a - f))
            .sum::<f64>()
            .sqrt();
        if norm > 0. {
            worst = worst.max(error / norm);
        }
    }
    assert!(worst < 1e-6, "worst relative directional error {worst}");

    // Colored assembly over the declared own-coordinate structure.
    let structure = Rods::<()>::structure(&b);
    let columns: Vec<Vec<usize>> = (0..n)
        .map(|j| {
            let mut rows: Vec<usize> = (0..n).filter(|r| structure.own[*r].contains(&j)).collect();
            rows.sort_unstable();
            rows
        })
        .collect();
    let pattern = Pattern::from_columns(n, &columns).unwrap();
    let coloring = Coloring::greedy(&pattern);
    coloring.verify(&pattern).unwrap();
    assert_eq!(coloring.count(), 3);
    let signs = vec![1.; n];
    let mut values = vec![0.; pattern.nonzeros()];
    for color in 0..coloring.count() {
        let seed = coloring.seed(color, &signs).unwrap();
        let (rows, _, _) = evaluate(&mut b, &y, &yp, Some(&seed), cj, &water);
        let directions: Vec<f64> = rows.iter().map(|r| r.direction).collect();
        scatter(&pattern, &coloring, color, &directions, &signs, &mut values).unwrap();
    }
    let mut dense = vec![0.; n * n];
    for j in 0..n {
        let mut seed = vec![0.; n];
        seed[j] = 1.;
        let (rows, _, _) = evaluate(&mut b, &y, &yp, Some(&seed), cj, &water);
        for (i, r) in rows.iter().enumerate() {
            dense[j * n + i] = r.direction;
        }
    }
    let comparison = compare_with_dense(&pattern, &values, &dense).unwrap();
    assert!(comparison.is_bitwise_exact(), "{comparison:?}");
}

#[test]
fn fluid_directions_enter_rows_and_receipts_exactly() {
    let mut b = block(SpiderDrag::EnvelopeDisk { coefficient: 1.28 });
    let base = z4_field(0.);
    let (y, yp) = mixed(&mut b, &base);
    // Seed each plenum's and two tip cells' pressure, density, viscosity,
    // enthalpy and tracer (R2 takes the tip cells' displaced water).
    for cell in [0, 1, 4, 9, 10] {
        for field in 0..5 {
            let seeded = |sign: f64, direction: f64| {
                let mut w = base.clone();
                let x = &mut w[cell];
                let item = *[&mut x.p, &mut x.rho, &mut x.mu, &mut x.h, &mut x.c][field];
                let step = [10., 0.05, 1e-9, 1., 1e-7][field];
                let value = Scalar::new(item.value + sign * step, direction);
                match field {
                    0 => x.p = value,
                    1 => x.rho = value,
                    2 => x.mu = value,
                    3 => x.h = value,
                    _ => x.c = value,
                }
                (w, step)
            };
            let (w0, step) = seeded(0., 1.);
            let zero = vec![0.; y.len()];
            let (rows, cells, _) = evaluate(&mut b, &y, &yp, Some(&zero), 0., &w0);
            let (wp, _) = seeded(1., 0.);
            let (wm, _) = seeded(-1., 0.);
            let (rp, cp, _) = evaluate(&mut b, &y, &yp, None, 0., &wp);
            let (rm, cm, _) = evaluate(&mut b, &y, &yp, None, 0., &wm);
            let check = |exact: f64, p: f64, m: f64, what: &str| {
                let fd = (p - m) / (2. * step);
                // Central-difference roundoff of rows of magnitude |p|.
                let roundoff = 8. * f64::EPSILON * p.abs().max(m.abs()) / step;
                assert!(
                    (exact - fd).abs() <= 1e-5 * exact.abs().max(fd.abs()) + roundoff + 1e-10,
                    "cell {cell} field {field} {what}: {exact} vs {fd}"
                );
            };
            for i in 0..rows.len() {
                check(
                    rows[i].direction,
                    rp[i].value,
                    rm[i].value,
                    &format!("row {i}"),
                );
            }
            for i in 0..REGULAR {
                for k in 0..3 {
                    check(
                        cells[i][0][k].direction,
                        cp[i][0][k].value,
                        cm[i][0][k].value,
                        &format!("receipt {i}/{k}"),
                    );
                }
            }
        }
    }
}

#[test]
fn trip_release_seat_and_the_stuck_cluster_follow_the_modes() {
    let water = z4_field(0.);
    let mut b = block(SpiderDrag::Omitted);
    let mut physical = held(&mut b, &water, 2.8);
    b.set_failed_release(5);
    let t = Rods::<()>::command(&mut b, 1.5, Command::TurbineTrip).unwrap();
    assert_eq!(b.holding_open_at(), Some(1.7));
    assert!(t.deposits.is_empty());
    let d = fluid_data(&water);
    let f = fluid(&d);
    let mut roots = vec![0.; 52];
    let y = solver(&b, &physical);
    let yp = vec![0.; y.len()];
    let scales = Rods::<()>::layout(&b).scales.clone();
    let x = Coordinates::new(&y, &yp, None, 0., &scales).unwrap();
    Rods::<()>::roots(&mut b, &(), 1.65, x, &f, &mut roots).unwrap();
    assert!((roots[0] + 0.05).abs() < 1e-12 && roots[5] == 1.);
    let mut directions = vec![1; 52];
    directions[5] = 0;
    Rods::<()>::transact(&mut b, &(), 1.7, &directions, &mut physical).unwrap();
    assert_eq!(b.modes()[0], Mode::Free);
    assert_eq!(b.modes()[5], Mode::Held);
    assert_eq!(Rods::<()>::differential(&b)[1], 1.);
    assert_eq!(Rods::<()>::differential(&b)[3 * 5 + 1], 0.);
    // A free body at the seat: inelastic, its energy into its fitting.
    physical[0] = 1e-13;
    physical[1] = -2.0;
    let mut directions = vec![0; 52];
    directions[0] = -1;
    let seat = Rods::<()>::transact(&mut b, &(), 2.9, &directions, &mut physical).unwrap();
    assert_eq!(b.modes()[0], Mode::Seated);
    assert_eq!((physical[0], physical[1]), (0., 0.));
    assert_eq!(seat.deposits.len(), 1);
    assert_eq!(seat.deposits[0].0, "FA0/top-fitting");
    assert!((seat.deposits[0].1 - 0.5 * b.moving_mass() * 4.).abs() < 1e-9);
    // A seated body's root is its seat reaction, positive in this field, at
    // the passage current consistent with the seated travel.
    let mut seated = block(SpiderDrag::Omitted);
    physical[2] = seated.prepare_currents_at(&f, 0.).unwrap()[0];
    let y = solver(&b, &physical);
    let x = Coordinates::new(&y, &yp, None, 0., &scales).unwrap();
    Rods::<()>::roots(&mut b, &(), 3., x, &f, &mut roots).unwrap();
    assert!(
        roots[0] > 56. && roots[0] < 57.,
        "seat reaction root {}",
        roots[0]
    );
    // A second trip command is refused.
    assert!(Rods::<()>::command(&mut b, 2., Command::TurbineTrip).is_err());
}

#[test]
fn the_holding_opening_releases_every_held_cluster_once_as_a_time_event() {
    let water = z4_field(0.);
    let mut b = block(SpiderDrag::Omitted);
    let mut physical = held(&mut b, &water, 2.8);
    b.set_failed_release(5);
    assert!(
        Rods::<()>::time_event(&mut b, &(), 1.7, &mut physical)
            .unwrap()
            .is_none()
    );
    Rods::<()>::command(&mut b, 1.5, Command::TurbineTrip).unwrap();
    let open = Rods::<()>::next_time_event(&b, 1.5).unwrap();
    assert!(
        Rods::<()>::time_event(&mut b, &(), 1.6, &mut physical)
            .unwrap()
            .is_none()
    );
    let before = physical.clone();
    let tx = Rods::<()>::time_event(&mut b, &(), open, &mut physical)
        .unwrap()
        .expect("the opening is due");
    assert!(tx.deposits.is_empty());
    assert_eq!(physical, before, "a release moves no coordinate");
    for c in 0..52 {
        let expected = if c == 5 { Mode::Held } else { Mode::Free };
        assert_eq!(b.modes()[c], expected, "cluster {c}");
    }
    // Transacted once: a second call at the same instant has nothing due.
    assert!(
        Rods::<()>::time_event(&mut b, &(), open, &mut physical)
            .unwrap()
            .is_none()
    );
    assert_eq!(Rods::<()>::next_time_event(&b, open), None);
}

#[test]
fn the_stuck_cluster_command_keeps_one_grip_closed_at_the_opening() {
    let water = z4_field(0.);
    let mut b = block(SpiderDrag::Omitted);
    let mut physical = held(&mut b, &water, 2.8);
    let before = physical.clone();
    let identity = Rods::<()>::differential(&b);
    // G7's malfunction, declared on a held grip before the trip: nothing
    // moves and the differential identity is unchanged.
    let tx = Rods::<()>::command(&mut b, 1.5, Command::StuckCluster { cluster: 5 }).unwrap();
    assert!(tx.deposits.is_empty());
    assert_eq!(tx.receipt["command"], "StuckCluster");
    assert_eq!(tx.receipt["cluster"], "LD01.CR.006");
    assert_eq!(tx.receipt["index"], 5);
    assert!(b.failed_release(5));
    assert!((0..52).filter(|c| *c != 5).all(|c| !b.failed_release(c)));
    assert_eq!(Rods::<()>::differential(&b), identity);
    assert_eq!(Rods::<()>::next_time_event(&b, 1.5), None, "no time event");
    // Refused: twice, and a cluster that does not exist.
    assert!(Rods::<()>::command(&mut b, 1.5, Command::StuckCluster { cluster: 5 }).is_err());
    assert!(Rods::<()>::command(&mut b, 1.5, Command::StuckCluster { cluster: 52 }).is_err());
    // The trip that follows opens the circuit after its declared delay; a
    // second grip may still be declared stuck before the opening.
    Rods::<()>::command(&mut b, 1.5, Command::TurbineTrip).unwrap();
    let open = Rods::<()>::next_time_event(&b, 1.5).unwrap();
    Rods::<()>::command(&mut b, 1.6, Command::StuckCluster { cluster: 7 }).unwrap();
    // The stuck grips' release roots are disarmed; the others arm at the
    // opening.
    let d = fluid_data(&water);
    let f = fluid(&d);
    let y = solver(&b, &physical);
    let yp = vec![0.; y.len()];
    let scales = Rods::<()>::layout(&b).scales.clone();
    let x = Coordinates::new(&y, &yp, None, 0., &scales).unwrap();
    let mut roots = vec![0.; 52];
    Rods::<()>::roots(&mut b, &(), 1.65, x, &f, &mut roots).unwrap();
    for (c, root) in roots.iter().enumerate() {
        if c == 5 || c == 7 {
            assert_eq!(*root, 1., "cluster {c}");
        } else {
            assert!((root - (1.65 - open)).abs() < 1e-12, "cluster {c}");
        }
    }
    // The opening releases the other 50 once and keeps both stuck grips.
    let tx = Rods::<()>::time_event(&mut b, &(), open, &mut physical)
        .unwrap()
        .expect("the opening is due");
    assert_eq!(tx.receipt["rods"].as_array().unwrap().len(), 50);
    assert_eq!(physical, before, "a release moves no coordinate");
    for c in 0..52 {
        let expected = if c == 5 || c == 7 {
            Mode::Held
        } else {
            Mode::Free
        };
        assert_eq!(b.modes()[c], expected, "cluster {c}");
        assert_eq!(
            Rods::<()>::differential(&b)[3 * c + 1],
            if expected == Mode::Free { 1. } else { 0. }
        );
    }
    // After the opening a grip can no longer be declared stuck: a released
    // body is free, a held one's release was already due.
    assert!(Rods::<()>::command(&mut b, open, Command::StuckCluster { cluster: 0 }).is_err());
    let mut other = block(SpiderDrag::Omitted);
    held(&mut other, &water, 2.8);
    Rods::<()>::command(&mut other, 0., Command::ManualReactorTrip).unwrap();
    assert!(Rods::<()>::command(&mut other, 0., Command::StuckCluster { cluster: 5 }).is_err());
}

#[test]
fn a_free_body_refuses_a_pending_spider_drag_selection() {
    let water = z4_field(0.);
    let mut b = block(SpiderDrag::Pending);
    let physical = held(&mut b, &water, 2.8);
    b.set_mode(0, Mode::Free);
    let y = solver(&b, &physical);
    let d = fluid_data(&water);
    let f = fluid(&d);
    let mut rows = vec![Scalar::constant(0.); y.len()];
    let mut cells = vec![[[Scalar::constant(0.); 3]; 2]; REGULAR];
    let yp = vec![0.; y.len()];
    let scales = Rods::<()>::layout(&b).scales.clone();
    let x = Coordinates::new(&y, &yp, None, 0., &scales).unwrap();
    assert!(
        Rods::<()>::rows(
            &mut b,
            &(),
            0.,
            x,
            &f,
            &mut Receipts::new(&mut cells),
            &mut rows
        )
        .is_err()
    );
}

/// The packet's hydrostatic preparation: LOWER 745.7, core 715.3/679.3,
/// UPPER 679.3 kg/m3 with the network's well-balanced head and no flow.
fn hydrostatic() -> Vec<Water1> {
    let mut water = z4_field(0.);
    let (rl, r1, r2, ru) = (745.7088, 715.3052, 679.3369, 679.3369);
    let pl = 15.2e6;
    let pu = pl - G * (rl + 2. * r1 + 2. * r2 + ru);
    water[0].p = Scalar::constant(pl);
    water[0].rho = Scalar::constant(rl);
    water[9].p = Scalar::constant(pu);
    water[9].rho = Scalar::constant(ru);
    water[10].p = Scalar::constant(pu - 3. * ru * G);
    water[10].rho = Scalar::constant(ru);
    water
}
/// One cluster's passage residual and its exact current direction at
/// travel `y`, speed `v` and current `m`.
fn passage(b: &RodBlock, water: &[Water1], y: f64, v: f64, m: f64) -> Scalar {
    let d = fluid_data(water);
    let f = fluid(&d);
    let scales = Rods::<()>::layout(b).scales.clone();
    let mut x = vec![0.; 156];
    let mut seed = vec![0.; 156];
    x[0] = y / scales[0];
    x[1] = v / scales[1];
    x[2] = m / scales[2];
    seed[2] = 1. / scales[2];
    let yp = vec![0.; 156];
    let c = Coordinates::new(&x, &yp, Some(&seed), 0., &scales).unwrap();
    b.forces(0, &c, &f).unwrap().passage_residual
}

#[test]
fn the_hydrostatic_field_has_exactly_one_band_set_passage_root() {
    let water = hydrostatic();
    let mut b = block(SpiderDrag::Omitted);
    let d = fluid_data(&water);
    let f = fluid(&d);
    let currents = b.prepare_currents_at(&f, 2.8).unwrap();
    // R3: the root lies inside the band and is set by it (DONOR's estimate
    // -1.26e-4 kg/s per cluster, about 6.6e-3 kg/s over the 52).
    let band =
        745.7088 * 1e-3 * 24. * std::f64::consts::PI * (0.0055_f64.powi(2) - 0.00475_f64.powi(2));
    // rho_L (1 mm/s) A_ann: 745.7 kg/m3 times 5.796e-4 m2, 4.32e-4 kg/s.
    assert!((band - 4.322e-4).abs() < 1e-7, "{band}");
    let m = currents[0];
    assert!((m + 1.26e-4).abs() < 0.005e-4, "root {m}");
    let total: f64 = currents.iter().sum();
    assert!((total + 6.6e-3).abs() < 0.05e-3, "total {total}");
    assert!(passage(&b, &water, 2.8, 0., m).value.abs() < 1e-6);
    // Strictly decreasing, hence exactly one root, across and beyond the band.
    let mut previous = f64::INFINITY;
    for k in -300..=300 {
        let r = passage(&b, &water, 2.8, 0., k as f64 * band / 100.).value;
        assert!(r < previous, "not decreasing at {k}");
        previous = r;
    }
    // An inverted column refuses visibly.
    let mut inverted = water.clone();
    inverted[9].rho = Scalar::constant(760.);
    inverted[10].rho = Scalar::constant(760.);
    let d = fluid_data(&inverted);
    let error = b.prepare_currents_at(&fluid(&d), 2.8).unwrap_err();
    assert!(
        format!("{error:?}").contains("inverted column"),
        "{error:?}"
    );
}

#[test]
fn the_blended_passage_is_continuous_and_c1_through_zero_and_its_reversal() {
    let band = 4.35e-4;
    // At rest in the hydrostatic field, and falling at 4.8 m/s in the
    // at-power field, where the annulus current reverses near 5 m/s.
    for (water, v) in [(hydrostatic(), 0.), (z4_field(0.), -4.8)] {
        let b = block(SpiderDrag::Omitted);
        let centre = 745.7088 * 24. * std::f64::consts::PI * 0.00475_f64.powi(2) * v;
        for offset in [-band, -0.3 * band, 0., 0.6 * band, band] {
            let m = centre + offset;
            let h = 1e-9;
            let r = passage(&b, &water, 1.25, v, m);
            let (left, right) = (
                passage(&b, &water, 1.25, v, m - h).value,
                passage(&b, &water, 1.25, v, m + h).value,
            );
            // Continuous (no jump beyond the slope's own change), and both
            // one-sided slopes agree with the exact one: C1.
            assert!((right - left).abs() <= 2.0001 * h * r.direction.abs() + 1e-6);
            let (dl, dr) = ((r.value - left) / h, (right - r.value) / h);
            for slope in [dl, dr] {
                assert!(
                    (slope - r.direction).abs() <= 2e-4 * r.direction.abs(),
                    "v {v} offset {offset}: {dl} {dr} vs {}",
                    r.direction
                );
            }
        }
    }
}

#[test]
fn g10_directions_hold_inside_the_blend_band() {
    // The hydrostatic field with every passage near its band-set root,
    // a quarter of the bodies falling slowly with their annulus current
    // still inside the band.
    let water = hydrostatic();
    let mut b = block(SpiderDrag::EnvelopeDisk { coefficient: 1.28 });
    let d = fluid_data(&water);
    let f = fluid(&d);
    let root = b.prepare_currents_at(&f, 2.8).unwrap()[0];
    let scales = Rods::<()>::layout(&b).scales.clone();
    let mut physical = Rods::<()>::prepared(&b);
    let mut rates = vec![0.; 156];
    let area = 24. * std::f64::consts::PI * 0.00475_f64.powi(2);
    for c in 0..52 {
        physical[3 * c + 2] = root * (1. + 0.3 * ((c % 5) as f64 - 2.) / 2.);
        if c % 4 == 1 {
            b.set_mode(c, Mode::Free);
            let v = -0.0001 * (1 + c % 3) as f64;
            physical[3 * c + 1] = v;
            physical[3 * c + 2] += 745.7088 * area * v;
            rates[3 * c] = v;
            rates[3 * c + 1] = -1.;
        }
    }
    let y: Vec<f64> = physical.iter().zip(&scales).map(|(v, s)| v / s).collect();
    let yp: Vec<f64> = rates.iter().zip(&scales).map(|(v, s)| v / s).collect();
    let rows_scale = Rods::<()>::layout(&b).row_scales.clone();
    let cj = 23.;
    let n = y.len();
    let mut worst = 0_f64;
    let mut state = 0x9e37_79b9_7f4a_7c15_u64;
    let mut seeds: Vec<Vec<f64>> = (0..n)
        .map(|j| (0..n).map(|i| if i == j { 1. } else { 0. }).collect())
        .collect();
    for _ in 0..20 {
        seeds.push(
            (0..n)
                .map(|_| {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    (state % 2001) as f64 / 1000. - 1.
                })
                .collect(),
        );
    }
    for d in &seeds {
        let (rows, _, _) = evaluate(&mut b, &y, &yp, Some(d), cj, &water);
        let exact: Vec<f64> = rows
            .iter()
            .zip(&rows_scale)
            .map(|(r, s)| r.direction / s)
            .collect();
        let h = 1e-9;
        let mut arm = |sign: f64| {
            let ys: Vec<f64> = y.iter().zip(d).map(|(v, e)| v + sign * h * e).collect();
            let yps: Vec<f64> = yp
                .iter()
                .zip(d)
                .map(|(v, e)| v + sign * h * cj * e)
                .collect();
            let (rows, _, _) = evaluate(&mut b, &ys, &yps, None, 0., &water);
            rows.iter()
                .zip(&rows_scale)
                .map(|(r, s)| r.value / s)
                .collect::<Vec<f64>>()
        };
        let (plus, minus) = (arm(1.), arm(-1.));
        let norm = exact.iter().map(|v| v * v).sum::<f64>().sqrt();
        let error = exact
            .iter()
            .zip(plus.iter().zip(&minus))
            .map(|(a, (p, m))| (a - (p - m) / (2. * h)).powi(2))
            .sum::<f64>()
            .sqrt();
        if norm > 0. {
            worst = worst.max(error / norm);
        }
    }
    assert!(
        worst < 1e-6,
        "worst relative directional error in the band {worst}"
    );
    // Conservation holds in the band too.
    let (_, cells, volumes) = evaluate(&mut b, &y, &yp, None, 0., &water);
    let mass: f64 = cells.iter().map(|c| c[0][0].value).sum();
    let scale: f64 = cells.iter().map(|c| c[0][0].value.abs()).sum();
    assert!(mass.abs() <= 1e-13 * scale);
    let rate: f64 = volumes.iter().map(|v| v.rate_m3_s.value).sum();
    assert!(rate.abs() < 1e-18);
}

#[test]
fn cost_per_evaluation() {
    let water = z4_field(0.);
    let mut b = block(SpiderDrag::EnvelopeDisk { coefficient: 1.28 });
    let (y, yp) = mixed(&mut b, &water);
    let d = fluid_data(&water);
    let f = fluid(&d);
    let scales = Rods::<()>::layout(&b).scales.clone();
    let mut rows = vec![Scalar::constant(0.); y.len()];
    let mut cells = vec![[[Scalar::constant(0.); 3]; 2]; REGULAR];
    let mut volumes = vec![
        CellVolume {
            volume_m3: Scalar::constant(0.),
            rate_m3_s: Scalar::constant(0.)
        };
        REGULAR
    ];
    let seed: Vec<f64> = (0..y.len()).map(|i| (i % 3) as f64).collect();
    let mut time = |seeded: bool| {
        let mut samples = Vec::new();
        for _ in 0..2000 {
            let x = Coordinates::new(&y, &yp, seeded.then_some(&seed[..]), 11., &scales).unwrap();
            let started = Instant::now();
            Rods::<()>::volumes(&b, x, &VOLUMES, &mut volumes).unwrap();
            Rods::<()>::rows(
                &mut b,
                &(),
                0.,
                x,
                &f,
                &mut Receipts::new(&mut cells),
                &mut rows,
            )
            .unwrap();
            samples.push(started.elapsed().as_secs_f64());
        }
        samples.sort_by(f64::total_cmp);
        samples[samples.len() / 2]
    };
    let (value, seeded) = (time(false), time(true));
    println!(
        "{{\"kind\":\"rods-cost-NOT-EVIDENCE\",\"clusters\":52,\"value_median_us\":{:.2},\"seeded_median_us\":{:.2}}}",
        value * 1e6,
        seeded * 1e6
    );
    assert!(value < 1e-3 && seeded < 1e-3);
}

#[test]
fn the_bodies_work_enters_the_water_once() {
    let water = z4_field(0.);
    let mut b = block(SpiderDrag::EnvelopeDisk { coefficient: 1.28 });
    let (y, yp) = mixed(&mut b, &water);
    let (_, cells, volumes) = evaluate(&mut b, &y, &yp, None, 0., &water);
    let d = fluid_data(&water);
    let f = fluid(&d);
    let scales = Rods::<()>::layout(&b).scales.clone();
    let x = Coordinates::new(&y, &yp, None, 0., &scales).unwrap();
    let (mut heat, mut boundary) = (0., 0.);
    for c in 0..52 {
        let [_, h, w] = b.power(c, &x, &f).unwrap();
        let forces = b.forces(c, &x, &f).unwrap();
        let v = x.value(3 * c + 1).value;
        assert!(
            (h + (forces.wall.value + forces.spider_drag.value) * v).abs()
                <= 1e-12 * h.abs().max(1.)
        );
        heat += h;
        boundary += w;
    }
    // The heat port carries exactly the wall and drag work: the passage's
    // own enthalpy flux cancels between the plena.
    let delivered: f64 = cells.iter().map(|c| c[0][1].value).sum();
    assert!(
        (delivered - heat).abs() <= 1e-9 * heat.abs(),
        "{delivered} vs {heat}"
    );
    assert!(heat > 0.);
    // The boundary work the network pays, -p V', is the bodies' own.
    let paid: f64 = volumes
        .iter()
        .enumerate()
        .map(|(i, v)| -water[i].p.value * v.rate_m3_s.value)
        .sum();
    assert!(
        (paid - boundary).abs() <= 1e-9 * boundary.abs(),
        "{paid} vs {boundary}"
    );
}

#[test]
fn moving_bodies_conserve_volume_mass_energy_and_tracer_through_the_annulus() {
    let water = z4_field(0.);
    let mut b = block(SpiderDrag::EnvelopeDisk { coefficient: 1.28 });
    let (y, yp) = mixed(&mut b, &water);
    let (_, cells, volumes) = evaluate(&mut b, &y, &yp, None, 0., &water);
    let d = fluid_data(&water);
    let f = fluid(&d);
    let scales = Rods::<()>::layout(&b).scales.clone();
    let x = Coordinates::new(&y, &yp, None, 0., &scales).unwrap();
    let mut heat = 0.;
    for c in 0..52 {
        heat += b.power(c, &x, &f).unwrap()[1];
    }
    let sum = |k: usize| cells.iter().map(|c| c[0][k].value).sum::<f64>();
    let scale = |k: usize| cells.iter().map(|c| c[0][k].value.abs()).sum::<f64>();
    // Volume: the swept cells' free volume is constant.
    let volume_rate: f64 = volumes.iter().map(|v| v.rate_m3_s.value).sum();
    assert!(volume_rate.abs() < 1e-15);
    // Mass and tracer: what leaves a cell enters another.
    assert!(sum(0).abs() <= 1e-13 * scale(0), "mass {}", sum(0));
    assert!(sum(2).abs() <= 1e-13 * scale(2), "tracer {}", sum(2));
    // Energy: the transported enthalpy cancels; only the bodies' work stays.
    assert!(
        (sum(1) - heat).abs() <= 1e-12 * scale(1),
        "enthalpy {} vs work {heat}",
        sum(1)
    );
    // R2: each core cell loses exactly the water its shrinking free volume
    // displaces, through the annulus, not through the core route.
    let mut moved = 0;
    for cell in 1..9 {
        let expected = water[cell].rho.value * volumes[cell].rate_m3_s.value;
        if expected != 0. {
            moved += 1;
        }
        assert!(
            (cells[cell][0][0].value - expected).abs() <= 1e-12 * expected.abs().max(1e-30),
            "cell {cell}: {} vs {expected}",
            cells[cell][0][0].value
        );
    }
    assert!(moved > 0);
    // The annulus delivers the passage currents plus the displaced water.
    let passages: f64 = (0..52).map(|c| x.value(3 * c + 2).value).sum();
    let displaced: f64 = (1..9).map(|c| -cells[c][0][0].value).sum();
    let upper = cells[9][0][0].value;
    assert!((upper - passages - displaced).abs() <= 1e-12 * upper.abs());
}
