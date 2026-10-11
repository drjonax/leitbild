//! Z4: the S2 rod block's zero-time per-cluster force balance in the
//! retained at-power field, with maintained IF97, the compiled `rods`
//! section and the actual packet. NOT EVIDENCE: no S2 state exists (Z1),
//! no trajectory is run, and the field is the retained physical-fuel
//! reference of the earlier Z4 disposition, which this receipt reconciles.
//! The receipt is written once to `LD01_S2_Z4_RECEIPT`; an existing file is
//! refused, never overwritten.
use leitbild_operating_plant::{
    joined::block::{CellVolume, Coordinates, Fluid, Receipts, Rods},
    local_flow::{Cell, Phase},
    network::{
        Coupling, Failure, RotorState, Water,
        packet::Packet,
        prepare::{self, OperatingPoint, Settings},
    },
    rods::{RodBlock, RodPacket, Section, SpiderDrag},
    rotor::{Shaft, SpeedRequest, Support},
    thermal::Scalar,
};
use leitbild_operating_water::{Branch, If97, WaterPoint, point};
use serde_json::{Value, json};
use std::time::Instant;

const G: f64 = 9.80665;
const WATER_LIB_DIR: &str = env!("LD01_OPERATING_WATER_LIB_DIR");
const WATER_BUILD: &str = include_str!(concat!(
    env!("LD01_OPERATING_WATER_LIB_DIR"),
    "/water-build.json"
));

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}
fn sha256(path: &str) -> String {
    let out = std::process::Command::new("shasum")
        .args(["-a", "256", path])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .unwrap()
        .to_string()
}
fn git(dir: &str, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}
/// The one JSON object of a strict fenced block of a wiki page.
fn strict_block(page: &str, fence: &str) -> Value {
    let text = std::fs::read_to_string(page).unwrap();
    let open = format!("```{fence}\n");
    let start = text.find(&open).unwrap() + open.len();
    let end = start + text[start..].find("\n```").unwrap();
    serde_json::from_str(&text[start..end]).unwrap()
}

/// The retained at-power field (model/connected-primary-initialization.md
/// :308): LOWER 15.2 MPa at -2 m and 563.15 K, UPPER 15,056,166 Pa at +2 m
/// and 593.15 K, less a declared UPPER shift standing for extra core loss.
/// HOUSING.MAIN shares UPPER's water at rest, as in the first Z4.
struct Field {
    lower: WaterPoint,
    upper: WaterPoint,
    p_lower: f64,
    p_upper: f64,
}
fn field(upper_shift_pa: f64) -> Field {
    let (p_lower, p_upper) = (15_200_000., 15_056_166. - upper_shift_pa);
    Field {
        lower: point(Branch::Liquid, p_lower, 563.15).unwrap(),
        upper: point(Branch::Liquid, p_upper, 593.15).unwrap(),
        p_lower,
        p_upper,
    }
}
struct Data {
    cells: Vec<Cell>,
    points: Vec<[Option<(Water, Water)>; 2]>,
    zeros: Vec<Scalar>,
    elevations: Vec<f64>,
    volumes: Vec<f64>,
    current: Vec<Scalar>,
}
fn water(q: &WaterPoint) -> Water {
    Water {
        pressure_pa: q.pressure_pa,
        temperature_k: q.temperature_k,
        density_kg_m3: q.density_kg_m3,
        internal_energy_j_kg: q.internal_energy_j_kg,
        enthalpy_j_kg: q.enthalpy_j_kg,
        cp_j_kg_k: q.cp_j_kg_k,
        expansion_per_k: q.expansion_per_k,
        compressibility_per_pa: q.compressibility_per_pa,
        viscosity_pa_s: q.viscosity_pa_s,
        conductivity_w_m_k: q.conductivity_w_m_k,
    }
}
fn data(packet: &Packet, block: &RodBlock, f: &Field) -> Data {
    let regions = &packet.mechanics.regions;
    let [lower, upper, main] = block.plena();
    let cell = |p: f64, q: &WaterPoint| Cell {
        pressure: Scalar::constant(p),
        phase: [
            Some(Phase {
                fraction: Scalar::constant(1.),
                density: Scalar::constant(q.density_kg_m3),
                enthalpy: Scalar::constant(q.enthalpy_j_kg),
                boron_concentration: Scalar::constant(1e-3),
            }),
            None,
        ],
    };
    let z = |i: usize| regions[i].elevation_m;
    let mut cells: Vec<Cell> = (0..regions.len())
        .map(|i| {
            cell(
                f.p_upper - f.upper.density_kg_m3 * G * (z(i) - 2.),
                &f.upper,
            )
        })
        .collect();
    let mut points: Vec<[Option<(Water, Water)>; 2]> =
        vec![[Some((water(&f.upper), Water::default())), None]; regions.len() - 1];
    cells[lower] = cell(
        f.p_lower - f.lower.density_kg_m3 * G * (z(lower) + 2.),
        &f.lower,
    );
    points[lower] = [Some((water(&f.lower), Water::default())), None];
    for c in [upper, main] {
        cells[c] = cell(
            f.p_upper - f.upper.density_kg_m3 * G * (z(c) - 2.),
            &f.upper,
        );
    }
    let volumes: Vec<f64> = regions.iter().map(|r| r.volume_m3).collect();
    Data {
        cells,
        points,
        zeros: vec![Scalar::constant(0.); regions.len() - 1],
        elevations: regions.iter().map(|r| r.elevation_m).collect(),
        current: volumes[..regions.len() - 1]
            .iter()
            .map(|v| Scalar::constant(*v))
            .collect(),
        volumes,
    }
}
fn fluid(d: &Data) -> Fluid<'_> {
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
/// Cluster 0's forces at a held or moving zero-time state with its steady
/// passage current; all 52 see the same plena in this field.
fn balance(block: &RodBlock, f: &Fluid<'_>, travel: f64, speed: f64) -> Value {
    let m = block.passage_current(0, f, travel, speed).unwrap();
    let n = Rods::<()>::clusters(block);
    let scales = &Rods::<()>::layout(block).scales;
    let mut y = vec![0.; 3 * n];
    y[0] = travel / scales[0];
    y[1] = speed / scales[1];
    y[2] = m / scales[2];
    let yp = vec![0.; 3 * n];
    let x = Coordinates::new(&y, &yp, None, 0., scales).unwrap();
    let fo = block.forces(0, &x, f).unwrap();
    json!({"travel_m":travel,"speed_m_s":speed,"tip_m":-2.25 + travel,"guideCurrent_kg_s_per_cluster":m,"chi":fo.chi.value,
        "pTip_Pa":fo.tip_pressure.value,"pBodyTop_Pa":fo.top_pressure.value,"endFaceForce_N":fo.end_face.value,
        "annulusWallForce_N":fo.wall.value,"spiderBuoyancy_N":fo.spider_buoyancy.value,"spiderDrag_N":fo.spider_drag.value,
        "bodySpiderWeight_N":block.moving_mass() * G,"netUpward_N":fo.net.value,"bodySpiderNetDown_N":-fo.net.value,
        "passageResidual_Pa":fo.passage_residual.value})
}
/// The speed at which a falling body's net force vanishes, its passage
/// re-solved at each speed: a zero-time algebraic balance, not a drop.
fn terminal(block: &RodBlock, f: &Fluid<'_>, travel: f64) -> Option<f64> {
    let net = |v: f64| {
        balance(block, f, travel, v)["netUpward_N"]
            .as_f64()
            .unwrap()
    };
    let (mut lo, mut hi) = (-20., 0.);
    if net(lo) < 0. {
        return None;
    }
    for _ in 0..80 {
        let mid = 0.5 * (lo + hi);
        if net(mid) > 0. { lo = mid } else { hi = mid }
    }
    Some(0.5 * (lo + hi))
}

/// The packet's hydrostatic preparation seen through the network's port.
struct Gap<'a> {
    block: &'a RodBlock,
    out: Option<Value>,
}
impl Coupling for Gap<'_> {
    fn couple(&mut self, fluid: &Fluid<'_>, _: &mut Receipts<'_>) -> Result<(), Failure> {
        let n = Rods::<()>::clusters(self.block);
        let scales = &Rods::<()>::layout(self.block).scales;
        let at = |m: f64| -> Result<f64, Failure> {
            let mut y = vec![0.; 3 * n];
            y[0] = self.block.reference_travel() / scales[0];
            y[2] = m / scales[2];
            let yp = vec![0.; 3 * n];
            let x = Coordinates::new(&y, &yp, None, 0., scales)?;
            Ok(self.block.forces(0, &x, fluid)?.passage_residual.value)
        };
        let refused = self
            .block
            .passage_current(0, fluid, self.block.reference_travel(), 0.)
            .err()
            .map(|e| format!("{e:?}"));
        self.out = Some(
            json!({"upwardDonorBalanceAtZero_Pa":at(0.)?,"downwardDonorBalanceAtZero_Pa":at(-f64::MIN_POSITIVE)?,"preparation":refused}),
        );
        Ok(())
    }
}

#[test]
#[ignore = "requires the compiled rods section, the actual packet, the wiki, maintained IF97 and the Z4 disposition"]
fn z4_zero_time_rod_force_balance() {
    let out = env("LD01_S2_Z4_RECEIPT");
    assert!(
        !std::path::Path::new(&out).exists(),
        "{out} exists: a receipt is never overwritten"
    );
    let section_path = env("LD01_OPERATING_RODS_SECTION");
    let packet_path = env("LD01_OPERATING_HOT_SPINE_PACKET");
    let wiki = env("LD01_WIKI_ROOT");
    let disposition = env("LD01_S2_Z4_DISPOSITION");
    let section: Section = serde_json::from_slice(&std::fs::read(&section_path).unwrap())
        .or_else(|_| {
            serde_json::from_slice::<RodPacket>(&std::fs::read(&section_path).unwrap())
                .map(|p| p.rods)
        })
        .unwrap();
    let packet: Packet = serde_json::from_slice(&std::fs::read(&packet_path).unwrap()).unwrap();
    let with_drag = |drag: SpiderDrag| {
        let mut s = section.clone();
        s.spider_drag = drag;
        RodBlock::from_packet(&s, &packet).unwrap()
    };
    let block = with_drag(section.spider_drag);
    let disk = with_drag(SpiderDrag::EnvelopeDisk { coefficient: 1.28 });
    let omitted = with_drag(SpiderDrag::Omitted);

    // 1. The force balance at zero speed, three travels, as the first Z4.
    let base = field(0.);
    let d = data(&packet, &block, &base);
    let f = fluid(&d);
    let travels = [2.8, 1.25, 0.1];
    let rows: Vec<Value> = travels
        .iter()
        .map(|t| balance(&block, &f, *t, 0.))
        .collect();
    let earlier: Value = serde_json::from_slice(&std::fs::read(&disposition).unwrap()).unwrap();
    let reconcile: Vec<Value> = travels
        .iter()
        .zip(&rows)
        .map(|(t, r)| {
            let e = earlier["results_base"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["y_m"].as_f64() == Some(*t) && e["tipPressureSource"] == "guide passage from LOWER")
                .unwrap();
            let diff = |a: &str, b: &str| r[a].as_f64().unwrap() - e[b].as_f64().unwrap();
            json!({"travel_m":t,
                "guideCurrent_kg_s":{"block":r["guideCurrent_kg_s_per_cluster"],"z4":e["guideCurrent_kg_s_per_cluster"],"difference":diff("guideCurrent_kg_s_per_cluster","guideCurrent_kg_s_per_cluster")},
                "pTip_Pa":{"block":r["pTip_Pa"],"z4":e["pTip_Pa"],"difference":diff("pTip_Pa","pTip_Pa")},
                "pBodyTop_Pa":{"block":r["pBodyTop_Pa"],"z4":e["pBodyTop_Pa"],"difference":diff("pBodyTop_Pa","pBodyTop_Pa")},
                "endFaceForce_N":{"block":r["endFaceForce_N"],"z4":e["endFaceForce_N"],"difference":diff("endFaceForce_N","endFaceForce_N")},
                "annulusWallForce_N":{"block":r["annulusWallForce_N"],"z4":e["annulusWallForce_N"],"difference":diff("annulusWallForce_N","annulusWallForce_N")},
                "spiderBuoyancy_N":{"block":r["spiderBuoyancy_N"],"z4":e["spiderBuoyancy_N"],"difference":diff("spiderBuoyancy_N","spiderBuoyancy_N")},
                "bodySpiderNetDown_N":{"block":r["bodySpiderNetDown_N"],"z4":e["bodySpiderNetDown_N"],"difference":diff("bodySpiderNetDown_N","bodySpiderNetDown_N")}})
        })
        .collect();
    let net = |r: &Value| r["bodySpiderNetDown_N"].as_f64().unwrap();
    let release = net(&rows[0]);
    let minimum = rows.iter().map(net).fold(f64::INFINITY, f64::min);
    for r in &reconcile {
        assert!(
            r["bodySpiderNetDown_N"]["difference"]
                .as_f64()
                .unwrap()
                .abs()
                < 2e-3,
            "{r}"
        );
        assert!(
            r["guideCurrent_kg_s"]["difference"].as_f64().unwrap().abs() < 2e-6,
            "{r}"
        );
    }
    assert!(release > 62. && release < 62.5 && minimum > 56. && minimum < 57.);

    // 2. Extra core loss, as an UPPER shift: the margin's slope and stall.
    let shifted = |shift: f64| {
        let fi = field(shift);
        let d = data(&packet, &block, &fi);
        let f = fluid(&d);
        travels
            .iter()
            .map(|t| balance(&block, &f, *t, 0.))
            .collect::<Vec<Value>>()
    };
    let (minus30, plus10) = (shifted(30_000.), shifted(-10_000.));
    let slope = (net(&minus30[0]) - net(&rows[0])) / 30.;
    let stall_kpa = -release / slope;

    // 3. Zero-time balances at falling speeds with the passage re-solved,
    // for both spider-drag choices: the stakes of the open selection.
    let speeds = [-0.5, -1., -1.5, -2.];
    let moving: Vec<Value> = travels
        .iter()
        .map(|t| {
            json!({"travel_m":t,
                "envelopeDisk":speeds.iter().map(|v| balance(&disk, &f, *t, *v)).collect::<Vec<_>>(),
                "omitted":speeds.iter().map(|v| balance(&omitted, &f, *t, *v)).collect::<Vec<_>>(),
                "terminalSpeed_m_s":{"envelopeDisk":terminal(&disk, &f, *t),"omitted":terminal(&omitted, &f, *t)}})
        })
        .collect();
    let displacement: Vec<Value> = speeds
        .iter()
        .map(|v| {
            let area = 24. * std::f64::consts::PI * 0.00475_f64.powi(2);
            json!({"speed_m_s":v,"displacedWater_kg_s_per_cluster":area * v.abs() * base.lower.density_kg_m3,"passageCurrent_kg_s_at_release":balance(&disk, &f, 2.8, *v)["guideCurrent_kg_s_per_cluster"]})
        })
        .collect();

    // 4. The packet's hydrostatic preparation: the donor gap.
    let point = OperatingPoint::from(&packet.preparation.operating_point);
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
    let (mut network, prepared, _) =
        prepare::prepare(&packet, If97, &point, &rotors, &settings).unwrap();
    let yp = vec![0.; prepared.y.len()];
    let mut gap = Gap {
        block: &block,
        out: None,
    };
    network
        .evaluate_coupled(0., &prepared.y, &yp, None, 0., None, Some(&mut gap))
        .unwrap();
    let gap = gap.out.unwrap();

    // 5. G3: the omitted armature's opening on this record (closed form).
    let page = format!(
        "{wiki}/world/packs/process-plant/reference-designs/ld-01/systems/reactor/control-absorber-and-guide-water.md"
    );
    let r = strict_block(&page, "reference-control-absorber");
    let num = |k: &str| r[k].as_f64().unwrap();
    let (ma, k, b, stroke, cap) = (
        num("gapArmature_kg"),
        num("gapSpring_N_m"),
        num("gapDamping_N_s_m"),
        num("gapStroke_m"),
        num("forceLimitPerCluster_N"),
    );
    let (alpha, omega) = (b / (2. * ma), (k / ma - (b / (2. * ma)).powi(2)).sqrt());
    let equilibrium = stroke + ma * G / k;
    let gap_at = |t: f64| {
        equilibrium
            * (1. - (-alpha * t).exp() * ((omega * t).cos() + alpha / omega * (omega * t).sin()))
    };
    let time_to = |target: f64| {
        let (mut lo, mut hi) = (0., std::f64::consts::PI / omega);
        for _ in 0..200 {
            let mid = 0.5 * (lo + hi);
            if gap_at(mid) < target {
                lo = mid
            } else {
                hi = mid
            }
        }
        0.5 * (lo + hi)
    };
    let stem_mass = num("steelDensity_kg_m3")
        * std::f64::consts::PI
        * (num("stemDiameter_m") / 2.).powi(2)
        * num("stemLength_m");
    let stem_net =
        (stem_mass - base.upper.density_kg_m3 * stem_mass / num("steelDensity_kg_m3")) * G;
    let slip = stem_net + release;
    let joint = stem_net - stem_mass * release / block.moving_mass();
    let armature = json!({"record":{"armature_kg":ma,"spring_N_m":k,"damping_N_s_m":b,"stroke_m":stroke,"closedCapacity_N":cap},
        "stemNetWeight_N":stem_net,"gripSlipBelow_N":slip,"jointOpensBelow_N":joint,
        "gripSlip_ms":1e3 * time_to(stroke * (1. - slip / cap)),"jointOpens_ms":1e3 * time_to(stroke * (1. - joint / cap)),"stopReached_ms":1e3 * time_to(stroke),
        "disposition":"G3: omitted and disclosed; grip release at the holding-circuit opening (lead, 11 October, build-readiness S2 design choices)"});

    // 6. Cost of one block evaluation (52 clusters, volumes and rows).
    let n = Rods::<()>::clusters(&disk);
    let mut cost_block = with_drag(SpiderDrag::EnvelopeDisk { coefficient: 1.28 });
    let scales = Rods::<()>::layout(&cost_block).scales.clone();
    let mut y = vec![0.; 3 * n];
    let mut ypr = vec![0.; 3 * n];
    for c in 0..n {
        cost_block.set_mode(c, leitbild_operating_plant::rods::Mode::Free);
        y[3 * c] = (0.3 + 0.05 * c as f64) / scales[3 * c];
        y[3 * c + 1] = -1.2 / scales[3 * c + 1];
        y[3 * c + 2] = 1.1 / scales[3 * c + 2];
        ypr[3 * c] = -1.2 / scales[3 * c];
    }
    let seed: Vec<f64> = (0..3 * n).map(|i| (i % 5) as f64 - 2.).collect();
    let mut rows_out = vec![Scalar::constant(0.); 3 * n];
    let regular = d.current.len();
    let mut receipts = vec![[[Scalar::constant(0.); 3]; 2]; regular];
    let mut volumes = vec![
        CellVolume {
            volume_m3: Scalar::constant(0.),
            rate_m3_s: Scalar::constant(0.)
        };
        regular
    ];
    let compiled: Vec<f64> = d.volumes[..regular].to_vec();
    let mut time = |seeded: bool| {
        let mut samples = Vec::new();
        for _ in 0..5000 {
            let x = Coordinates::new(&y, &ypr, seeded.then_some(&seed[..]), 23., &scales).unwrap();
            let started = Instant::now();
            Rods::<()>::volumes(&cost_block, x, &compiled, &mut volumes).unwrap();
            Rods::<()>::rows(
                &mut cost_block,
                &(),
                0.,
                x,
                &f,
                &mut Receipts::new(&mut receipts),
                &mut rows_out,
            )
            .unwrap();
            samples.push(started.elapsed().as_secs_f64());
        }
        samples.sort_by(f64::total_cmp);
        json!({"median_us":1e6 * samples[samples.len() / 2],"p95_us":1e6 * samples[samples.len() * 95 / 100]})
    };
    let cost = json!({"clusters":n,"all_free_with_drag":true,"value":time(false),"seeded":time(true),
        "note":"one evaluation of volumes() and rows() for 52 free clusters, release build, development machine; the Jacobian couples each cluster's 3 coordinates with the LOWER/UPPER/HOUSING.MAIN states (3 colors over the block's own coordinates)"});

    let app = env!("CARGO_MANIFEST_DIR");
    let receipt = json!({
        "kind":"s2-z4-zero-time-rod-force-balance-operating-block",
        "status":"NOT-EVIDENCE zero-time balance: no S2 state (Z1) exists, no trajectory is run; the field is the retained physical-fuel at-power reference of the first Z4 disposition",
        "date":"2026-10-11",
        "provenance":{"app_commit":git(app,&["rev-parse","HEAD"]),"app_dirty":!git(app,&["status","--porcelain"]).is_empty(),
            "wiki":wiki,"wiki_commit":git(&wiki,&["rev-parse","HEAD"]),"wiki_dirty":!git(&wiki,&["status","--porcelain"]).is_empty(),
            "rods_section":section_path,"rods_section_sha256":sha256(&section_path),"rods_section_pages":section.provenance.iter().map(|p| json!({"name":p.name,"sha256":p.sha256})).collect::<Vec<_>>(),
            "packet":packet_path,"packet_sha256":sha256(&packet_path),
            "water_build":serde_json::from_str::<Value>(WATER_BUILD).unwrap(),"water_build_dir":WATER_LIB_DIR,
            "reconciled":disposition,"reconciled_sha256":sha256(&disposition)},
        "block":"apps/world/native/process-plant/operating/src/rods (RodBlock::forces, passage_current), the S2 operating rod block; the laws are the page's: Churchill clear bores with the 2 um roughness, the exact moving annulus with chi, mouth losses 0.5, end-face pressures from the network's well-balanced head, spider buoyancy; donor LOWER water for the upward current",
        "field":{"pressures_Pa":{"LOWER@-2m":base.p_lower,"UPPER@+2m":base.p_upper},"temperatures_K":{"LOWER":563.15,"UPPER/HOUSING":593.15},
            "properties":{"LOWER":{"rho":base.lower.density_kg_m3,"mu":base.lower.viscosity_pa_s},"UPPER":{"rho":base.upper.density_kg_m3,"mu":base.upper.viscosity_pa_s}},
            "cells":"LOWER, UPPER and HOUSING.MAIN of the actual packet at their reference elevations, pressures reconstructed with the network's head from the field's port pressures; HOUSING.MAIN shares UPPER's water at rest"},
        "movingBody":{"mass_kg":block.moving_mass(),"weight_N":block.moving_mass() * G,"selection":"H7: spider and bodies; the stem stays with the drive line"},
        "results_zero_speed":rows,
        "margins":{"release_2p8m_N":release,"minimum_over_2p8_1p25_0p1_N":minimum,"selection":"H7 bodies only"},
        "reconciliation_with_first_z4":reconcile,
        "coreLossShift":{"upperMinus30kPa":minus30,"upperPlus10kPa":plus10,"releaseSlope_N_per_kPa_extraCoreLoss":slope,"stallAt_kPa_extraCoreLoss":stall_kpa},
        "moving_zero_time":{"note":"zero-time algebraic balances at the listed downward speeds with each passage re-solved at that speed; NOT a drop trajectory or an insertion time","rows":moving},
        "displacementCurrent":{"note":"F1 (a) carries no displacement current: the displaced bore water leaves through the network's core route; the annulus wall law sees the passage current only","rows":displacement},
        "hydrostaticPreparation":gap,
        "armature_G3":armature,
        "cost":cost,
    });
    std::fs::write(&out, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    println!("{}", serde_json::to_string(&receipt).unwrap());
}
