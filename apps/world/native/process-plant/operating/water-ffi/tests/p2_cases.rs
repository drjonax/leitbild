//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressurizer-thermal-state.md#stratified-pzr-verification-cases
//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0014-stratified-pzr-cell.md#work-bound-and-stop-rules
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressure-and-inventory.md#independent-relief-candidate
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressurizer-surge-history.md#frozen-numerical-prescription
//! The P2 verification case set of the stratified PZR cell, on its own
//! standalone DAE (`p2_harness`).
//!
//! The case block `ld01-p2-cases` is the single numeric owner of the set:
//! boundaries, source states, durations, CPU gates, sensitivities and the
//! relief lift's tolerance class. The other tolerance classes, orders and
//! output interval are the S1 declaration's (`ld01-s1-gates`), the
//! refinement budgets the accuracy contract's (`ld01-accuracy-contract`) and
//! the benchmark its frozen prescription (`reference-pressurizer-transport`).
//! Every block is read from the wiki's committed HEAD and hashed into each
//! receipt. The cell, its spray and relief ports and the relief calibration
//! are the case-set packet's `pzr` section, unchanged. Nothing is retuned: a
//! failure is a result.
#![cfg(all(feature = "ida", target_os = "macos"))]
mod p2_harness;

use leitbild_operating_plant::{
    network::{
        ConsistentSystem, Failure as CellFailure, Properties, consistent_start,
        heaters::{BanksBlock, Caloric304, ContactBlock, HeaterCase, Heaters},
        properties as props,
        stratified::{
            self as st, Case, Cell, Parameters, PortKind, ReliefDevice, ReliefMotion,
            SensitivityFamilies,
        },
        walls::{ShellBlock, WallCase, Walls},
    },
    pzr_field as pf,
    thermal::{Scalar, WaterPoint},
};
use leitbild_operating_water::{
    If97,
    ida::{Advance, Failure, Ida, Initial, System},
};
use p2_harness::{
    CellSystem, Counters, Cutout, End, Flow, Metal, Relief, Root, Run, RunSpec,
    Table, cpu_s, ledger, run, run_json, thread_cpu_s,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{io::Write, path::Path, process::Command};

const PTS: &str = "world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressurizer-thermal-state.md";
const READINESS: &str =
    "world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md";
const HOT_SPINE: &str =
    "world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md";
const SURGE_HISTORY: &str = "world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressurizer-surge-history.md";
const HEATER_EQUIPMENT: &str =
    "world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/heater-equipment.md";

/// The low-level heater cutout's settings, transcribed from their owning
/// prose because no strict block declares them (reported to the lead):
/// `LD01.PROT.PZR.LOW_LEVEL` (ld-01/safety/source-and-primary-protection.md,
/// "Observation ownership and commissioning settings": indication <=3.00 m
/// for 0.5 s), the common isolator's 0.05 s contact delay (heater-equipment.md,
/// "Physical isolation, protection and recovery"), and the electronic
/// differential level's 0.5 s lag, 0.01 m quantization and 15 MPa
/// calibration (instrumentation/phase-dependent-measurements.md, "PZR
/// electronic differential level"). The tap span and gravity come from the
/// packet; the sampling is the S1 output interval, the protection's 0.1 s.
const CUTOUT_SETTING_M: f64 = 3.00;
const CUTOUT_PERSISTENCE_S: f64 = 0.5;
const ISOLATOR_CONTACT_DELAY_S: f64 = 0.05;
const LT_LAG_S: f64 = 0.5;
const LT_QUANTUM_M: f64 = 0.01;
const LT_CALIBRATION_PA: f64 = 15.0e6;

/// The S1 harness's declared PZR preparation controls (`s1_hydraulics.rs`).
const PREPARATION_TOLERANCE_PA: f64 = 1e-6;
const PREPARATION_PASSES: usize = 50;
/// The S1 harness's exact-representation search.
const REPRESENTATION_SEARCH: usize = 8;
/// The S1 harness's consistent-pair bound and passes (lead ruling): every
/// start, at t = 0 and at every event, holds every scaled row to it.
const CONSISTENT_ROW_BOUND: f64 = 1e-12;
const CONSISTENT_PASSES: usize = 2;

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn sh(args: &[&str], dir: &str) -> String {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .expect("git")
}
/// The 1-, 5- and 15-minute load averages, recorded beside every CPU
/// measurement on the shared machine.
fn load_average() -> Value {
    let out = Command::new("sysctl")
        .args(["-n", "vm.loadavg"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    let v: Vec<f64> = out
        .split_whitespace()
        .filter_map(|w| w.parse().ok())
        .collect();
    json!(v)
}
fn sha256(bytes: &[u8]) -> String {
    let mut child = Command::new("shasum")
        .args(["-a", "256"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("shasum");
    child.stdin.take().unwrap().write_all(bytes).unwrap();
    let out = child.wait_with_output().unwrap();
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string()
}

/// One strict block read from the wiki's committed HEAD: text and value.
struct Block {
    page: &'static str,
    fence: &'static str,
    text: String,
    value: Value,
}
impl Block {
    fn read(wiki: &str, page: &'static str, fence: &'static str) -> Self {
        let text = sh(&["show", &format!("HEAD:{page}")], wiki);
        let open = format!("```{fence}\n");
        let start = text
            .find(&open)
            .unwrap_or_else(|| panic!("{page} has no ```{fence} block at HEAD"))
            + open.len();
        let end = start + text[start..].find("\n```").expect("unterminated block");
        let body = text[start..end].to_string();
        let value = serde_json::from_str(&body).unwrap_or_else(|e| panic!("{fence}: {e}"));
        Self {
            page,
            fence,
            text: body,
            value,
        }
    }
    fn provenance(&self) -> Value {
        json!({"page":self.page,"block":self.fence,"sha256":sha256(self.text.as_bytes())})
    }
    fn f64(&self, path: &[&str]) -> f64 {
        let mut v = &self.value;
        for k in path {
            v = &v[*k];
        }
        v.as_f64()
            .unwrap_or_else(|| panic!("{} has no number at {path:?}", self.fence))
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceState {
    #[serde(rename = "pressure_Pa")]
    pressure_pa: f64,
    #[serde(rename = "temperature_K")]
    temperature_k: f64,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Sources {
    surge: SourceState,
    spray: SourceState,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CaseTolerances {
    #[serde(rename = "reliefLiftScaledAbsolute")]
    relief_lift_scaled_absolute: f64,
}
#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)] // `vessel`, `observation`, `boundaries` and `heater` are carried in receipts via the raw entry.
struct Entry {
    gate: Option<u32>,
    id: String,
    vessel: String,
    blocked: Option<bool>,
    observation: Option<Value>,
    boundaries: Option<Value>,
    #[serde(rename = "roofPressure_Pa")]
    roof_pressure_pa: Option<f64>,
    level_m: Option<f64>,
    #[serde(rename = "duration_s")]
    duration_s: Option<f64>,
    #[serde(rename = "maxDuration_s")]
    max_duration_s: Option<f64>,
    #[serde(rename = "runCpu_s")]
    run_cpu_s: Option<f64>,
    #[serde(rename = "sprayMassFlow_kg_s")]
    spray: Option<Vec<[f64; 2]>>,
    #[serde(rename = "surgeMassFlow_kg_s")]
    surge: Option<Vec<[f64; 2]>>,
    #[serde(rename = "heaterRequest_W")]
    heater: Option<Vec<[f64; 2]>>,
    #[serde(rename = "lowLevelHeaterCutout")]
    low_level_heater_cutout: Option<bool>,
    #[serde(rename = "segmentRefinement")]
    segment_refinement: Option<bool>,
    relief: Option<bool>,
    #[serde(rename = "disclosedLimit")]
    disclosed_limit: Option<bool>,
    #[serde(rename = "pressureTarget")]
    pressure_target: Option<Value>,
    /// Absent exactly for the blocked experimental cases.
    sensitivities: Option<Vec<String>>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReliefJudgement {
    #[serde(rename = "pt1ExclusionAroundEvent_s")]
    pt1_exclusion_around_event_s: f64,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CaseSet {
    #[serde(rename = "cpuBound_s")]
    cpu_bound_s: f64,
    run_cap_factor: f64,
    sensitivity_families: SensitivityFamilies,
    sources: Sources,
    #[serde(rename = "reliefBackPressure_Pa")]
    relief_back_pressure_pa: f64,
    tolerance_classes: CaseTolerances,
    relief_judgement: ReliefJudgement,
    /// Stock IDA's first step after every event restart (request 4, K4).
    #[serde(rename = "eventRestartFirstStep_s")]
    event_restart_first_step_s: f64,
    cases: Vec<Entry>,
}

/// Everything a case reads, once.
struct Context {
    wiki: String,
    packet_path: String,
    receipts_dir: String,
    provenance: Value,
    set: CaseSet,
    cases_block: Block,
    gates: Block,
    budgets: Block,
    transport: Block,
    parameters: Parameters,
    /// The packet's `pzr.reliefCalibration`, from the relief device owner.
    relief_calibration: Value,
    /// The PZR metal's strict blocks.
    banks: BanksBlock,
    caloric: Caloric304,
    contact: ContactBlock,
    shell: ShellBlock,
    gravity_m_s2: f64,
}
impl Context {
    fn load() -> Self {
        let packet_path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET")
            .expect("LD01_OPERATING_HOT_SPINE_PACKET names the P2 packet");
        let wiki = std::env::var("LD01_WIKI_ROOT").expect("LD01_WIKI_ROOT names the wiki worktree");
        let cases_block = Block::read(&wiki, PTS, "ld01-p2-cases");
        let gates = Block::read(&wiki, READINESS, "ld01-s1-gates");
        let budgets = Block::read(&wiki, HOT_SPINE, "ld01-accuracy-contract");
        let transport = Block::read(&wiki, SURGE_HISTORY, "reference-pressurizer-transport");
        let banks_block = Block::read(&wiki, HEATER_EQUIPMENT, "ld01-pzr-heater-banks");
        let contact_block = Block::read(&wiki, HEATER_EQUIPMENT, "ld01-pzr-heater-contact");
        let caloric_block = Block::read(&wiki, HEATER_EQUIPMENT, "reference-304-caloric");
        let shell_block = Block::read(&wiki, PTS, "ld01-pzr-shell");
        let banks: BanksBlock =
            serde_json::from_value(banks_block.value.clone()).expect("heater banks");
        let contact: ContactBlock =
            serde_json::from_value(contact_block.value.clone()).expect("heater contact");
        let caloric: Caloric304 =
            serde_json::from_value(caloric_block.value.clone()).expect("304 caloric");
        let shell: ShellBlock = serde_json::from_value(shell_block.value.clone()).expect("shell");
        let set: CaseSet = serde_json::from_value(cases_block.value.clone()).expect("case set");
        let bytes = std::fs::read(&packet_path).expect("packet");
        let packet: Value = serde_json::from_slice(&bytes).expect("packet json");
        let parameters: Parameters =
            serde_json::from_value(packet["pzr"]["cell"].clone()).expect("pzr.cell");
        let relief_calibration = packet["pzr"]["reliefCalibration"].clone();
        let gravity_m_s2 = packet["hydraulics"]["gravity_m_s2"]
            .as_f64()
            .expect("packet gravity");
        // The case-set packet's composition record, when it sits beside it.
        let sidecar = packet_path.replace(".json", ".provenance.json");
        let composition: Value = std::fs::read(&sidecar)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or(Value::Null);
        // The maintained water build this binary links: its own build
        // receipt and the library's hash as found.
        let water = std::env::var("LD01_OPERATING_WATER_LIB_DIR")
            .expect("LD01_OPERATING_WATER_LIB_DIR names the water build");
        let water_receipt: Value = serde_json::from_slice(
            &std::fs::read(format!("{water}/water-build.json")).expect("the water build's receipt"),
        )
        .expect("water-build.json");
        let library = std::fs::read(format!("{water}/libld01_operating_water.a"))
            .expect("the water library");
        let water_build = json!({"directory":water,"library_sha256":sha256(&library),"receipt":water_receipt});
        let app = std::env::current_dir().unwrap().display().to_string();
        let provenance = json!({
            "app_commit":sh(&["rev-parse","HEAD"],&app),"app_dirty":!sh(&["status","--porcelain"],&app).is_empty(),
            "wiki_root":wiki,"wiki_commit":sh(&["rev-parse","HEAD"],&wiki),"wiki_dirty":!sh(&["status","--porcelain"],&wiki).is_empty(),
            "blocks_read_from":"wiki HEAD",
            "packet":packet_path,"packet_sha256":sha256(&bytes),"packet_composition":composition,"water_build":water_build,
            "case_block":cases_block.provenance(),"gates_block":gates.provenance(),"accuracy_block":budgets.provenance(),
            "transport_block":transport.provenance(),"heater_banks_block":banks_block.provenance(),"heater_contact_block":contact_block.provenance(),
            "caloric_304_block":caloric_block.provenance(),"shell_block":shell_block.provenance()});
        let receipts_dir = format!(
            "{}/cases",
            Path::new(&packet_path).parent().unwrap().display()
        );
        Self {
            wiki,
            packet_path,
            receipts_dir,
            provenance,
            set,
            cases_block,
            gates,
            budgets,
            transport,
            parameters,
            relief_calibration,
            banks,
            caloric,
            contact,
            shell,
            gravity_m_s2,
        }
    }
    fn rtol(&self) -> f64 {
        self.gates.f64(&["relativeTolerance"])
    }
    fn output_s(&self) -> f64 {
        self.gates.f64(&["outputInterval_s"])
    }
    /// The packet's relief port device.
    fn relief_device(&self) -> ReliefDevice {
        self.parameters
            .ports
            .iter()
            .find(|p| p.kind == PortKind::Relief)
            .and_then(|p| p.relief)
            .expect("the case-set packet declares the relief port")
    }
    /// A relief lift farther than its own scaled tolerance from the stop is
    /// not that travel root (`ReliefDevice::stop`), in full strokes.
    fn lift_root_bound(&self) -> f64 {
        self.set.tolerance_classes.relief_lift_scaled_absolute
    }
    /// Writes a new receipt; an existing receipt is never overwritten.
    fn write(&self, id: &str, receipt: &Value) {
        std::fs::create_dir_all(&self.receipts_dir).unwrap();
        let path = format!("{}/{id}.json", self.receipts_dir);
        assert!(
            !std::path::Path::new(&path).exists(),
            "receipt {path} exists; move the previous run's receipts first"
        );
        std::fs::write(&path, serde_json::to_vec_pretty(receipt).unwrap()).unwrap();
        println!("receipt {path}");
    }
}

/// One run's sensitivity selection.
#[derive(Clone, Copy, Debug)]
struct Variant {
    relaxation_factor: f64,
    drop_diameter_m: f64,
    bubble_diameter_m: f64,
    /// Gate 5's segment refinement: every heater segment halved.
    halved_segments: bool,
}

/// The heater banks block, with every segment halved for the refinement.
fn banks(ctx: &Context, halved: bool) -> BanksBlock {
    let mut b = ctx.banks.clone();
    if halved {
        for bank in &mut b.banks {
            bank.segments_m = bank
                .segments_m
                .iter()
                .flat_map(|[lo, hi]| {
                    let mid = 0.5 * (lo + hi);
                    [[*lo, mid], [mid, *hi]]
                })
                .collect();
        }
    }
    b
}

/// The PZR metal from its blocks: the rods (nominal contact case) and the
/// shell and heads, with the case's recorded heater request when declared.
fn metal(ctx: &Context, entry: &Entry, cell: &Cell, halved: bool) -> Metal {
    let heaters = Heaters::new(
        cell,
        &banks(ctx, halved),
        ctx.caloric,
        ctx.contact,
        HeaterCase::nominal(&ctx.contact),
    )
    .expect("heaters");
    let walls = Walls::new(
        cell,
        &heaters,
        ctx.shell.clone(),
        ctx.caloric,
        ctx.contact,
        WallCase::nominal(&ctx.contact, &ctx.shell),
    )
    .expect("walls");
    let maximum = ctx
        .caloric
        .specific_energy(s(ctx.caloric.maximum_k))
        .expect("304 maximum")
        .value;
    let limit_energy_j = heaters
        .segments()
        .iter()
        .map(|g| g.steel_mass_kg * maximum)
        .chain(walls.elements().iter().map(|e| e.steel_mass_kg * maximum))
        .collect();
    Metal {
        heaters,
        walls,
        request: entry
            .heater
            .as_ref()
            .map(|t| Table::new(t.clone()).unwrap()),
        isolated: false,
        limit_energy_j,
    }
}

fn enthalpy(state: &SourceState) -> f64 {
    If97.forward(false, state.pressure_pa, state.temperature_k)
        .expect("source state")
        .enthalpy_j_kg
}

/// Solver scales (contract amendment 4): prepared roof pressure, zone
/// volumes, masses and energies; transit volumes by `fluidVolume_m3`;
/// transit masses by their host zone's mass (bubbles by g, drops by R);
/// tracers by host mass times `absorberMassFraction`. The relief lift, when
/// the case arms the outlet, by its full stroke, the unit of its declared
/// tolerance class and of `effectiveAreaPerLift_m2`.
fn scales(p: &Parameters, values: &[f64; st::COORDINATES], relief: bool) -> Vec<f64> {
    let mut sc = values.to_vec();
    sc[st::BUBBLE_VOLUME] = p.fluid_volume_m3;
    sc[st::DROP_VOLUME] = p.fluid_volume_m3;
    sc[st::BUBBLE_MASS] = values[st::VAPOR_MASS];
    sc[st::DROP_MASS] = values[st::RESIDENT_MASS];
    for (tracer, host) in [
        (st::ADMITTED_BORON, st::ADMITTED_MASS),
        (st::RESIDENT_BORON, st::RESIDENT_MASS),
        (st::DROP_BORON, st::DROP_MASS),
    ] {
        sc[tracer] = sc[host] * p.absorber_mass_fraction;
    }
    if relief {
        sc.push(1.);
    }
    assert!(
        sc.iter().all(|v| v.is_finite() && *v > 0.),
        "nonpositive scale {sc:?}"
    );
    sc
}

/// Absolute tolerances from the S1 classes: volumes, masses and energies
/// the stock class, tracers the tracer class, the roof pressure
/// `relative / (κ_eff · scale)` with the prepared cell's effective isentropic
/// compressibility, as the network weights it; the relief lift the case
/// block's `toleranceClasses.reliefLiftScaledAbsolute`.
fn tolerances(ctx: &Context, column: &st::Column, sc: &[f64], rtol: f64, armed: bool) -> Vec<f64> {
    let stock = ctx.gates.f64(&["stockScaledAbsolute"]);
    let tracer = ctx.gates.f64(&["tracerScaledAbsolute"]);
    // Every steel energy takes the stock class, as the cell's energies.
    let mut atol = vec![stock; sc.len()];
    if armed {
        atol[p2_harness::LIFT] = ctx.lift_root_bound();
    }
    for t in [st::ADMITTED_BORON, st::RESIDENT_BORON, st::DROP_BORON] {
        atol[t] = tracer;
    }
    let zones = [column.vapor, column.admitted, column.resident];
    let volume: f64 = zones.iter().map(|z| z.volume.value).sum();
    let kappa = zones
        .iter()
        .map(|z| {
            z.volume.value
                * (z.compressibility.value
                    - z.temperature.value * z.expansion.value.powi(2)
                        / (z.density.value * z.cp.value))
        })
        .sum::<f64>()
        / volume;
    assert!(kappa.is_finite() && kappa > 0.);
    atol[st::ROOF_PRESSURE] = rtol / (kappa * sc[st::ROOF_PRESSURE]);
    atol
}

/// The prepared case: system template, initial coordinates and receipt data.
struct Prepared {
    y0: Vec<f64>,
    scales: Vec<f64>,
    column: st::Column,
    preparation: Value,
}

/// The 6.00 m saturated preparation, then the metal at the prepared fluid
/// temperature `Tsat(p_s)`; each steel energy is scaled by its prepared
/// value.
fn prepare(ctx: &Context, entry: &Entry, halved: bool) -> Prepared {
    let p = ctx.parameters.clone();
    let cell = Cell::new(p.clone(), Case::nominal(&p)).expect("cell");
    let roof = entry.roof_pressure_pa.expect("roofPressure_Pa");
    let level = entry.level_m.expect("level_m");
    let preparation = cell
        .prepare(
            &If97,
            roof,
            level,
            PREPARATION_TOLERANCE_PA,
            PREPARATION_PASSES,
        )
        .expect("preparation");
    let sc = scales(&p, &preparation.values, entry.relief == Some(true));
    let mut cell_scales = [0.; st::COORDINATES];
    cell_scales.copy_from_slice(&sc[..st::COORDINATES]);
    let y = Cell::coordinates(&preparation.values, &cell_scales, REPRESENTATION_SEARCH)
        .expect("exact coordinates");
    let mut y0 = y.to_vec();
    if entry.relief == Some(true) {
        y0.push(0.);
    }
    let m = metal(ctx, entry, &cell, halved);
    let temperature = preparation.saturation_temperature_k;
    let mut steel = m
        .heaters
        .prepared_energy(temperature)
        .expect("rod preparation");
    steel.extend(
        m.walls
            .prepared_energy(temperature)
            .expect("wall preparation"),
    );
    let mut sc = sc;
    for e in &steel {
        assert!(
            e.is_finite() && *e > 0.,
            "nonpositive prepared steel energy {e}"
        );
        sc.push(*e);
        y0.push(1.);
    }
    let c = &preparation.column;
    let prepared = json!({"roof_pressure_pa":roof,"level_m":level,"passes":preparation.pass_changes_pa,"saturation_temperature_k":preparation.saturation_temperature_k,
        "z_mix_m":c.mixture_elevation.value,"z_ar_m":c.boundary_elevation.value,"p_s_pa":c.interface_pressure.value,
        "mass_kg":{"g":preparation.values[st::VAPOR_MASS],"A":preparation.values[st::ADMITTED_MASS],"R":preparation.values[st::RESIDENT_MASS]},
        "volume_m3":{"g":preparation.values[st::VAPOR_VOLUME],"A":preparation.values[st::ADMITTED_VOLUME],"R":preparation.values[st::RESIDENT_VOLUME]},
        "metal":{"temperature_k":temperature,"rods":m.heaters.census().coordinates,"walls":m.walls.census().coordinates,"steel_energy_j":steel},
        "y0":y0});
    Prepared {
        y0,
        scales: sc,
        column: preparation.column,
        preparation: prepared,
    }
}

fn system(ctx: &Context, entry: &Entry, prepared: &Prepared, v: Variant) -> CellSystem {
    let p = ctx.parameters.clone();
    let cell = Cell::for_case(
        p.clone(),
        Case {
            relaxation_factor: v.relaxation_factor,
            drop_diameter_m: v.drop_diameter_m,
            bubble_diameter_m: v.bubble_diameter_m,
        },
        Some(&ctx.set.sensitivity_families),
    )
    .expect("cell variant");
    let metal = metal(ctx, entry, &cell, v.halved_segments);
    let port = |kind: PortKind| p.ports.iter().position(|q| q.kind == kind);
    let c = p.absorber_mass_fraction;
    let surge = entry.surge.as_ref().map(|tb| Flow {
        port: port(PortKind::Surge).unwrap(),
        table: Table::new(tb.clone()).unwrap(),
        enthalpy_j_kg: enthalpy(&ctx.set.sources.surge),
        concentration: c,
    });
    let spray = entry.spray.as_ref().map(|tb| Flow {
        port: port(PortKind::Spray).unwrap(),
        table: Table::new(tb.clone()).unwrap(),
        enthalpy_j_kg: enthalpy(&ctx.set.sources.spray),
        concentration: c,
    });
    // The packet declares the relief port for every case; only a case with
    // `relief: true` arms it. The receiver backpressure is the case block's.
    let relief = port(PortKind::Relief).map(|port| Relief {
        port,
        device: ctx.relief_device(),
        back_pressure_pa: ctx.set.relief_back_pressure_pa,
        motion: ReliefMotion::Closed,
        demand_open: false,
        armed: entry.relief == Some(true),
    });
    // Internal free-area band edges for the mixture level and A/R boundary,
    // then the structural limits.
    let edges: Vec<f64> = p.free_area[..p.free_area.len() - 1]
        .iter()
        .map(|b| b.to_m)
        .collect();
    let mut fixed_roots: Vec<Root> = edges.iter().map(|e| Root::MixtureEdge(*e)).collect();
    fixed_roots.extend(edges.iter().map(|e| Root::BoundaryEdge(*e)));
    fixed_roots.extend([
        Root::ZoneMass(st::VAPOR_MASS),
        Root::ZoneMass(st::ADMITTED_MASS),
        Root::ZoneMass(st::RESIDENT_MASS),
        Root::MixtureTop,
    ]);
    CellSystem {
        cell,
        scales: prepared.scales.clone(),
        surge,
        spray,
        relief,
        metal: Some(metal),
        fixed_roots,
        counters: Counters::default(),
    }
}

fn breakpoints(entry: &Entry) -> Vec<f64> {
    let mut b: Vec<f64> = entry
        .surge
        .iter()
        .chain(entry.spray.iter())
        .flat_map(|t| t.iter().map(|p| p[0]))
        .collect();
    b.sort_by(f64::total_cmp);
    b.dedup();
    b
}

fn variants(ctx: &Context, entry: &Entry) -> Vec<(String, Variant, bool)> {
    let x = &ctx.parameters.stratified;
    let nominal = Variant {
        relaxation_factor: 1.,
        drop_diameter_m: x.spray_drop_diameter_m,
        bubble_diameter_m: x.bubble_diameter_m,
        halved_segments: false,
    };
    let f = &ctx.set.sensitivity_families;
    let mut out = vec![("nominal".to_string(), nominal, false)];
    if entry.segment_refinement == Some(true) {
        out.push((
            "segments halved".to_string(),
            Variant {
                halved_segments: true,
                ..nominal
            },
            false,
        ));
    }
    let refined_declared = matches!(entry.gate, Some(4..=7));
    if refined_declared {
        out.push(("refined".to_string(), nominal, true));
    }
    for name in entry
        .sensitivities
        .as_ref()
        .expect("a runnable case declares its sensitivities")
    {
        match name.as_str() {
            "relaxation" => {
                for v in &f.relaxation {
                    out.push((
                        format!("relaxation x{v}"),
                        Variant {
                            relaxation_factor: *v,
                            ..nominal
                        },
                        false,
                    ));
                }
            }
            "sprayDrop" => {
                for v in &f.spray_drop_m {
                    out.push((
                        format!("spray drop {v} m"),
                        Variant {
                            drop_diameter_m: *v,
                            ..nominal
                        },
                        false,
                    ));
                }
            }
            "bubble" => {
                for v in &f.bubble_m {
                    out.push((
                        format!("bubble {v} m"),
                        Variant {
                            bubble_diameter_m: *v,
                            ..nominal
                        },
                        false,
                    ));
                }
            }
            other => panic!("undeclared sensitivity family {other}"),
        }
    }
    out
}

/// Nominal against refined at common output times, within the contract.
/// The 4th-order Butterworth low-pass at `fc` for sampling interval `dt` as
/// two bilinear-transformed second-order sections `[b0, b1, b2, a1, a2]`,
/// with the analog cutoff prewarped.
fn butterworth4(fc: f64, dt: f64) -> [[f64; 5]; 2] {
    let k = (std::f64::consts::PI * fc * dt).tan();
    [1., 3.].map(|m: f64| {
        let q = 1. / (2. * (m * std::f64::consts::PI / 8.).cos());
        let norm = 1. / (1. + k / q + k * k);
        let b0 = k * k * norm;
        [
            b0,
            2. * b0,
            b0,
            2. * (k * k - 1.) * norm,
            (1. - k / q + k * k) * norm,
        ]
    })
}
/// One pass of the sections over `x`, each started at its steady state for
/// the first value (transposed direct form II).
fn sections(x: &[f64], sos: &[[f64; 5]; 2]) -> Vec<f64> {
    let mut y = x.to_vec();
    for [b0, b1, b2, a1, a2] in sos.iter().copied() {
        let gain = (b0 + b1 + b2) / (1. + a1 + a2);
        let (x0, y0) = (y[0], gain * y[0]);
        let (mut z1, mut z2) = ((b1 + b2) * x0 - (a1 + a2) * y0, b2 * x0 - a2 * y0);
        for v in y.iter_mut() {
            let input = *v;
            let output = b0 * input + z1;
            z1 = b1 * input - a1 * output + z2;
            z2 = b2 * input - a2 * output;
            *v = output;
        }
    }
    y
}
/// Zero-phase filtering: forward and backward over an odd extension of
/// three cutoff periods at each end, which is then removed.
fn filtfilt(x: &[f64], fc: f64, dt: f64) -> Vec<f64> {
    let n = x.len();
    if n < 3 {
        return x.to_vec();
    }
    let pad = ((3. / (fc * dt)).ceil() as usize).min(n - 1);
    let mut ext = Vec::with_capacity(n + 2 * pad);
    ext.extend((1..=pad).rev().map(|i| 2. * x[0] - x[i]));
    ext.extend_from_slice(x);
    ext.extend((1..=pad).map(|i| 2. * x[n - 1] - x[n - 1 - i]));
    let sos = butterworth4(fc, dt);
    let mut f = sections(&ext, &sos);
    f.reverse();
    let mut b = sections(&f, &sos);
    b.reverse();
    b[pad..pad + n].to_vec()
}

/// Nominal against a reference run with the contract's comparison (request
/// 2, E0/E1): the observed differences of PT1 and both levels filtered by
/// the zero-phase 4th-order Butterworth at `uncreditedAbove_Hz`; roof bias as
/// the mean |filtered difference|, roof noise as the standard deviation of
/// its 0.1 s changes, levels as the maximum. With `exclusion` (E5) PT1 is
/// judged only outside ±`exclusion` of every located relief event of either
/// run. Relief events and a cutout are compared on their located times.
fn compare(a: &Run, b: &Run, ctx: &Context, exclusion: Option<f64>) -> Value {
    let fc = ctx.budgets.f64(&["uncreditedAbove_Hz"]);
    let dt = ctx.gates.f64(&["comparison", "observation_s"]);
    let ratio = (ctx.output_s() / dt).round() as usize;
    let n = a.observations.len().min(b.observations.len());
    let grid = (0..n).all(|i| (a.observations[i][0] - b.observations[i][0]).abs() < 1e-9);
    let difference = |k: usize| -> Vec<f64> {
        (0..n)
            .map(|i| a.observations[i][k] - b.observations[i][k])
            .collect()
    };
    let (raw_pt1, raw_collapsed, raw_mixture) = (difference(1), difference(2), difference(3));
    let (pt1, collapsed, mixture) = (
        filtfilt(&raw_pt1, fc, dt),
        filtfilt(&raw_collapsed, fc, dt),
        filtfilt(&raw_mixture, fc, dt),
    );
    let events: Vec<f64> = a
        .relief_events
        .iter()
        .chain(&b.relief_events)
        .filter_map(|e| e["t"].as_f64())
        .collect();
    let included = |i: usize| {
        let t = a.observations[i][0];
        exclusion.is_none_or(|m| events.iter().all(|e| (t - e).abs() > m))
    };
    let kept: Vec<usize> = (0..n).filter(|i| included(*i)).collect();
    let bias = kept.iter().map(|i| pt1[*i].abs()).sum::<f64>() / kept.len().max(1) as f64;
    let changes: Vec<f64> = (0..n)
        .step_by(ratio)
        .collect::<Vec<_>>()
        .windows(2)
        .filter(|w| included(w[0]) && included(w[1]))
        .map(|w| pt1[w[1]] - pt1[w[0]])
        .collect();
    let mean_change = changes.iter().sum::<f64>() / changes.len().max(1) as f64;
    let noise = (changes
        .iter()
        .map(|c| (c - mean_change).powi(2))
        .sum::<f64>()
        / changes.len().max(1) as f64)
        .sqrt();
    let max_abs = |v: &[f64]| v.iter().map(|x| x.abs()).fold(0., f64::max);
    let level = max_abs(&collapsed);
    let cutout = match (&a.cutout, &b.cutout) {
        (Some(x), Some(y)) => {
            Some((x["cause_s"].as_f64().unwrap() - y["cause_s"].as_f64().unwrap()).abs())
        }
        (None, None) => None,
        _ => Some(f64::INFINITY),
    };
    // Relief events inside the window both runs cover.
    let window = a.reached_s.min(b.reached_s);
    let kinds = |r: &Run| -> Vec<(f64, String)> {
        r.relief_events
            .iter()
            .filter(|e| e["t"].as_f64().unwrap() <= window)
            .map(|e| {
                (
                    e["t"].as_f64().unwrap(),
                    format!("{}->{}", e["before"]["motion"], e["after"]["motion"]),
                )
            })
            .collect()
    };
    let (ea, eb) = (kinds(a), kinds(b));
    let same_sequence = ea.len() == eb.len() && ea.iter().zip(&eb).all(|(x, y)| x.1 == y.1);
    let timing = if same_sequence {
        ea.iter()
            .zip(&eb)
            .map(|(x, y)| (x.0 - y.0).abs())
            .fold(0., f64::max)
    } else {
        f64::INFINITY
    };
    let budget = ctx.budgets.f64(&["pzrRoofPressureBias_Pa"]);
    let lvl = ctx.budgets.f64(&["pzrLevel_m"]);
    let tim = ctx.budgets.f64(&["thresholdTiming_s"]);
    let noise_budget = ctx.budgets.f64(&["pzrRoofPressureSampleNoise_Pa"]);
    let pass = grid
        && !kept.is_empty()
        && bias <= budget
        && level <= lvl
        && timing <= tim
        && cutout.is_none_or(|c| c <= tim);
    json!({"comparison":"contract (E0/E1): zero-phase 4th-order Butterworth, forward and backward with three-period odd extensions and steady-state starts",
        "cutoff_hz":fc,"observation_s":dt,"observations":n,"same_grid":grid,"pt1_judged_observations":kept.len(),"pt1_exclusion_s":exclusion,
        "pt1_bias_mean_abs_filtered_pa":bias,"pt1_noise_std_of_0p1s_changes_pa":noise,"pt1_max_abs_filtered_pa":kept.iter().map(|i| pt1[*i].abs()).fold(0., f64::max),
        "collapsed_level_max_abs_filtered_m":level,"mixture_level_max_abs_filtered_m":max_abs(&mixture),
        "raw":{"pt1_max_abs_pa":max_abs(&raw_pt1),"collapsed_level_max_abs_m":max_abs(&raw_collapsed),"mixture_level_max_abs_m":max_abs(&raw_mixture)},
        "cutout_cause_time_difference_s":cutout.map(|c| if c.is_finite() {json!(c)} else {json!(null)}),
        "common_window_s":window,
        "relief_events":{"nominal":ea.len(),"refined":eb.len(),"same_sequence":same_sequence,"max_crossing_time_difference_s":if timing.is_finite() {json!(timing)} else {json!(null)}},
        "budgets":{"pzrRoofPressureBias_Pa":budget,"pzrRoofPressureSampleNoise_Pa":noise_budget,"pzrLevel_m":lvl,"thresholdTiming_s":tim},
        "pass":pass})
}

/// Rejections near each free-area crossing: failures counted between the
/// samples bracketing a window of two local steps around it.
fn crossing_rejections(run: &Run) -> Vec<Value> {
    let total_steps = run.totals.steps.max(1) as f64;
    let rate = (run.totals.error_failures + run.totals.convergence_failures) as f64 / total_steps;
    run.area_crossings
        .iter()
        .map(|c| {
            let t = c["t"].as_f64().unwrap();
            let h = c["last_step_s"].as_f64().unwrap_or(0.).max(1e-3);
            let w = 2. * h;
            let before = run.samples.iter().rev().find(|s| s.t <= t - w);
            let after = run.samples.iter().find(|s| s.t >= t + w);
            let count = |f: fn(&p2_harness::Sample) -> i64| match (before, after) {
                (Some(b), Some(a)) => json!(f(a) - f(b)),
                _ => json!(null),
            };
            json!({"crossing":c,"window_s":[t-w,t+w],"error_test_failures":count(|s| s.error_failures),
                "convergence_failures":count(|s| s.convergence_failures),"steps":count(|s| s.steps),
                "run_rejections_per_step":rate})
        })
        .collect()
}

/// Wet-law onset crossings: a contacted liquid zone (A or R) crossing its
/// saturation between consecutive samples, with the step rejections in the
/// samples' interval.
fn onset_crossings(run: &Run) -> Vec<Value> {
    let names = ["A", "R"];
    let mut out = Vec::new();
    for w in run.samples.windows(2) {
        for (z, k) in [(0, 1), (1, 2)] {
            let (a, b) = (w[0].departure_k[k], w[1].departure_k[k]);
            if (a > 0.) != (b > 0.) {
                out.push(json!({"zone":names[z],"from_s":w[0].t,"to_s":w[1].t,"direction":if b > a {1} else {-1},
                    "error_test_failures":w[1].error_failures - w[0].error_failures,"convergence_failures":w[1].convergence_failures - w[0].convergence_failures,
                    "steps":w[1].steps - w[0].steps}));
            }
        }
    }
    out
}

fn ended(run: &Run) -> bool {
    run.end == End::Completed
}

/// One LD-01 case of gates 4, 6, 7 and 8: every declared run, comparisons,
/// conservation, the gate's own checks and its verdict.
fn ld01_case(ctx: &Context, entry: &Entry, deadline: f64, smoke: Option<f64>) -> Value {
    let gate = entry.gate.unwrap();
    let limit = gate == 8;
    let declared = entry.duration_s.or(entry.max_duration_s).expect("duration");
    let duration = smoke.map_or(declared, |d| d.min(declared));
    let cap = entry.run_cpu_s.expect("runCpu_s") * ctx.set.run_cap_factor;
    let armed = entry.relief == Some(true);
    let prepared_nominal = prepare(ctx, entry, false);
    let prepared_halved =
        (entry.segment_refinement == Some(true)).then(|| prepare(ctx, entry, true));
    let rtol = ctx.rtol();
    let factor = ctx.gates.f64(&["referenceToleranceFactor"]);
    let judgement = &ctx.set.relief_judgement;
    // Gate 5's low-level cutout chain.
    let cutout = (entry.low_level_heater_cutout == Some(true)).then(|| {
        let sat = If97
            .saturation(s(LT_CALIBRATION_PA))
            .expect("calibration saturation");
        let p = &ctx.parameters;
        Cutout {
            setting_m: CUTOUT_SETTING_M,
            persistence_s: CUTOUT_PERSISTENCE_S,
            contact_delay_s: ISOLATOR_CONTACT_DELAY_S,
            lag_s: LT_LAG_S,
            quantum_m: LT_QUANTUM_M,
            liquid_reference_kg_m3: sat.liquid.density.value,
            vapor_reference_kg_m3: sat.vapor.density.value,
            gravity_m_s2: ctx.gravity_m_s2,
            span_m: p.tap(st::LT_HIGH).unwrap() - p.tap(st::LT_LOW).unwrap(),
        }
    });
    // Receipt series stride; a smoke run may ask for every sample.
    let stride = match (smoke, std::env::var("LD01_P2_SMOKE_STRIDE")) {
        (Some(_), Ok(s)) => s.parse::<usize>().expect("LD01_P2_SMOKE_STRIDE"),
        _ => ((duration / ctx.output_s()) / 300.).ceil() as usize,
    };
    let mut runs: Vec<(String, Variant, bool, Run)> = Vec::new();
    let mut declared_runs = variants(ctx, entry);
    if smoke.is_some() {
        // A smoke run exercises the harness only: the nominal variant.
        declared_runs.truncate(1);
    }
    for (label, v, refined) in declared_runs {
        if cpu_s() >= deadline {
            runs.push((label.clone(), v, refined, skipped(&label)));
            continue;
        }
        let credited = !limit && (label == "nominal" || refined);
        let prepared = if v.halved_segments {
            prepared_halved.as_ref().expect("halved preparation")
        } else {
            &prepared_nominal
        };
        let atol = tolerances(ctx, &prepared.column, &prepared.scales, rtol, armed);
        let spec = RunSpec {
            label: label.clone(),
            rtol: if refined { rtol * factor } else { rtol },
            atol: atol
                .iter()
                .map(|a| if refined { a * factor } else { *a })
                .collect(),
            // Decision 0015: the refined run is BDF2 at rtol/10.
            max_order: ctx.gates.f64(&["maxOrder"]) as usize,
            duration_s: duration,
            output_s: ctx.output_s(),
            observation_s: ctx.gates.f64(&["comparison", "observation_s"]),
            breakpoints: breakpoints(entry),
            nonnegative: vec![st::BUBBLE_MASS, st::DROP_MASS, st::DROP_BORON],
            cpu_cap_s: cap,
            set_deadline_cpu_s: deadline,
            credited,
            limit,
            resolvability_factor: ctx.parameters.stratified.resolvability_factor,
            consistent_bound: CONSISTENT_ROW_BOUND,
            consistent_passes: CONSISTENT_PASSES,
            lift_root_bound: ctx.lift_root_bound(),
            event_restart_first_step_s: ctx.set.event_restart_first_step_s,
            cutout,
        };
        let sys = system(ctx, entry, prepared, v);
        let r = run(sys, &prepared.y0, &spec);
        println!(
            "{} {}: end {:?} at {} s, {} steps, {:.2} CPU-s",
            entry.id, label, r.end, r.reached_s, r.totals.steps, r.cpu_s
        );
        runs.push((label, v, refined, r));
    }
    let surge = entry.surge.as_ref().map(|t| Table::new(t.clone()).unwrap());
    let spray = entry.spray.as_ref().map(|t| Table::new(t.clone()).unwrap());
    let mut runs_json = serde_json::Map::new();
    let mut ledgers = serde_json::Map::new();
    for (label, v, refined, r) in &runs {
        let mut j = run_json(r, stride);
        j["variant"] = json!({"relaxation_factor":v.relaxation_factor,"spray_drop_diameter_m":v.drop_diameter_m,"bubble_diameter_m":v.bubble_diameter_m,"halved_segments":v.halved_segments,"refined":refined});
        j["cpu_cap_s"] = json!(cap);
        let l = ledger(r, surge.as_ref(), spray.as_ref());
        j["conservation"] = l.clone();
        j["area_step_rejections"] = json!(crossing_rejections(r));
        ledgers.insert(label.clone(), l);
        runs_json.insert(label.clone(), j);
    }
    let get = |name: &str| runs.iter().find(|r| r.0 == name).map(|r| &r.3);
    let nominal = get("nominal").unwrap();
    let mut checks = serde_json::Map::new();
    let mut failures: Vec<String> = Vec::new();
    // Every run against its CPU cap and the set bound.
    for (label, _, _, r) in &runs {
        match r.end {
            End::CpuCap => failures.push(format!("{label}: run CPU cap {cap} s reached")),
            End::SetBound => failures.push(format!("{label}: set CPU bound reached")),
            _ => {}
        }
    }
    let conservation_ok = |r: &Run| {
        let l = ledger(r, surge.as_ref(), spray.as_ref());
        l["mass"]["within_solver_tolerance"].as_bool() == Some(true)
            && l["boron"]["within_solver_tolerance"].as_bool() == Some(true)
    };
    // Gate 5: the steel-range applicability limit is a reported physical
    // result, not a case failure.
    let steel_limit =
        |r: &Run| matches!(&r.end, End::Limit { label } if label.starts_with("steel-range"));
    if !limit {
        if !ended(nominal) && !(gate == 5 && steel_limit(nominal)) {
            failures.push(format!("nominal did not complete: {:?}", nominal.end));
        }
        if let End::StopRule { rule, reason } = &nominal.end {
            failures.push(format!("D1 stop rule {rule} in the nominal run: {reason}"));
        }
        if !conservation_ok(nominal) {
            failures.push("nominal mass or boron closure outside the solver tolerance".into());
        }
        if let Some(halved) = get("segments halved") {
            let cmp = compare(nominal, halved, ctx, None);
            if !(ended(halved) || steel_limit(halved)) {
                failures.push(format!(
                    "segments-halved run did not complete: {:?}",
                    halved.end
                ));
            }
            if cmp["pass"].as_bool() != Some(true) {
                failures.push(
                    "nominal and segments-halved runs disagree beyond the contract budgets".into(),
                );
            }
            checks.insert("segment_refinement_agreement".into(), cmp);
        }
        if let Some(refined) = get("refined") {
            let cmp = compare(
                nominal,
                refined,
                ctx,
                armed.then_some(judgement.pt1_exclusion_around_event_s),
            );
            if !ended(refined) {
                failures.push(format!("refined did not complete: {:?}", refined.end));
            }
            if cmp["pass"].as_bool() != Some(true) {
                failures.push("nominal and refined disagree beyond the contract budgets".into());
            }
            checks.insert("refined_agreement".into(), cmp);
        }
    }
    let p = &ctx.parameters;
    let top = p.top_m;
    checks.insert(
        "wet_onset_crossings".into(),
        json!(onset_crossings(nominal)),
    );
    match gate {
        5 => {
            let at = |t: f64| nominal.samples.iter().find(|s| s.t >= t - 1e-9);
            let state = |s: &p2_harness::Sample| {
                json!({"t":s.t,"rod_temperature_k":s.rod_temperature_k,"bank_exposed_length_m":s.bank_exposed_m,
                "bank_wet_fraction":s.bank_wet_fraction,"mixture_level_m":s.mixture_level_m,"collapsed_level_m":s.collapsed_level_m,"lt_indication_m":s.lt_indication_m,"joule_w":s.joule_w})
            };
            let open = nominal
                .cutout
                .as_ref()
                .and_then(|c| c["isolator_open_s"].as_f64());
            // Quasi-steady full-power inversion: T_A − T_R over the last 20 s
            // of full power before the outsurge at 120 s.
            let window: Vec<&p2_harness::Sample> = nominal
                .samples
                .iter()
                .filter(|s| s.event.is_none() && s.t >= 100. && s.t <= 120.)
                .collect();
            let inversion = window
                .iter()
                .map(|s| s.temperatures_k[1] - s.temperatures_k[2])
                .sum::<f64>()
                / window.len().max(1) as f64;
            let extreme = |f: fn(&p2_harness::Sample) -> f64| {
                let v: Vec<f64> = nominal.samples.iter().map(f).collect();
                json!([
                    v.iter().copied().fold(f64::INFINITY, f64::min),
                    v.iter().copied().fold(f64::NEG_INFINITY, f64::max)
                ])
            };
            let rod_max = nominal
                .samples
                .iter()
                .flat_map(|s| s.rod_temperature_k.iter().copied())
                .fold(f64::NEG_INFINITY, f64::max);
            let l = ledgers.get("nominal").cloned().unwrap_or(Value::Null);
            checks.insert("heater".into(), json!({
                "cutout":nominal.cutout,"state_at_isolator_open":open.and_then(at).map(state),"state_at_end":nominal.samples.last().map(state),
                "electrical_delivery":{"electrical_j":l["energy"]["electrical_j"],"rod_energy_change_j":l["energy"]["rod_energy_change_j"],"wall_energy_change_j":l["energy"]["wall_energy_change_j"],
                    "fluid_internal_energy_change_j":l["energy"]["internal_energy_change_j"],"port_receipts_j":l["energy"]["port_receipts_j"],"exterior_loss_j":l["energy"]["exterior_loss_j"],
                    "hydrostatic_remainder_j":l["energy"]["hydrostatic_remainder_j"],"closure_j":l["energy"]["closure_j"],"max_closure_over_solver_tolerance":l["energy"]["max_closure_over_solver_tolerance"]},
                "quasi_steady_inversion_k":inversion,"selection_inversion_k":0.072,
                "rod_temperature_max_k":rod_max,"steel_limit_reached":steel_limit(nominal),
                "ranges":{"pt1_pa":extreme(|s|s.pt1_pa),"inversion_exchange_kg_s":extreme(|s|s.inversion_kg_s),"bubble_stock_kg":extreme(|s|s.masses[3]),
                    "swell_m":extreme(|s|s.mixture_level_m - s.collapsed_level_m),"mixture_level_m":extreme(|s|s.mixture_level_m),"collapsed_level_m":extreme(|s|s.collapsed_level_m),
                    "flashing_kg_s":extreme(|s|s.flashing_kg_s[0] + s.flashing_kg_s[1]),"joule_w":extreme(|s|s.joule_w),"exterior_w":extreme(|s|s.exterior_w),
                    "metal_identity_w":extreme(|s|s.metal_identity_w)}}));
            if open.is_none() {
                failures.push("the low-level cutout did not act".into());
            }
        }
        4 => {
            // Drop stock against the quasi-steady (W_s + W_c)(top − z_mix)/u_d:
            // the drops carry the spray and the vapor condensed at entry.
            let quasi: Vec<Value> = nominal
                .samples
                .iter()
                .filter(|s| s.event.is_none() && s.spray_kg_s > 0. && (s.t.fract() < 1e-9 || s.t.fract() > 1. - 1e-9) && (s.t as i64) % 5 == 0)
                .map(|s| {
                    let q = (s.spray_kg_s + s.spray_condensation_kg_s) * (top - (s.mixture_level_m + p.bottom_m)) / s.drop_velocity_m_s;
                    json!({"t":s.t,"drop_stock_kg":s.masses[4],"quasi_steady_kg":q,"ratio":s.masses[4]/q,"spray_kg_s":s.spray_kg_s,"entry_condensation_kg_s":s.spray_condensation_kg_s,"rain_kg_s":s.rain_kg_s,"drop_velocity_m_s":s.drop_velocity_m_s})
                })
                .collect();
            checks.insert("drop_stock_vs_quasi_steady".into(), json!(quasi));
            let extreme = |f: fn(&p2_harness::Sample) -> f64| {
                let v: Vec<f64> = nominal.samples.iter().map(f).collect();
                json!({"min":v.iter().copied().fold(f64::INFINITY,f64::min),"max":v.iter().copied().fold(f64::NEG_INFINITY,f64::max)})
            };
            checks.insert("ranges".into(), json!({"pt1_pa":extreme(|s|s.pt1_pa),"vapor_departure_k":extreme(|s|s.departure_k[0]),"resident_temperature_k":extreme(|s|s.temperatures_k[2]),"drop_stock_kg":extreme(|s|s.masses[4]),"rain_kg_s":extreme(|s|s.rain_kg_s),"entry_condensation_kg_s":extreme(|s|s.spray_condensation_kg_s),"lt_dp_pa":extreme(|s|s.lt_dp_pa)}));
        }
        6 | 8 if entry.relief == Some(true) => {
            let device = ctx.relief_device();
            let events = &nominal.relief_events;
            let opened = events.iter().any(|e| e["after"]["motion"] == "Opening");
            // Opening at rising opening_Pa and reseat at falling reseat_Pa
            // are located by root on raw PT1; the PT1 at each is reported.
            let crossings: Vec<Value> = events
                .iter()
                .filter(|e| e["demand_root"].is_i64())
                .map(|e| json!({"t":e["t"],"pt1_pa":e["pt1_pa"],"direction":e["demand_root"],"after":e["after"]}))
                .collect();
            // Full travel takes 1/fullStrokes_per_s from rest to the stop.
            let mut travel = Vec::new();
            for w in events.windows(2) {
                let (a, b) = (&w[0], &w[1]);
                if a["after"]["motion"] == "Opening"
                    && a["lift_located"].as_f64() == Some(0.)
                    && b["after"]["motion"] == "Open"
                {
                    travel.push(json!({"from_s":a["t"],"to_s":b["t"],"duration_s":b["t"].as_f64().unwrap()-a["t"].as_f64().unwrap(),"declared_s":1./device.full_strokes_per_s}));
                }
            }
            let cal = &ctx.relief_calibration;
            let p0 = cal["inletPressure_Pa"].as_f64().unwrap();
            let back = cal["backPressure_Pa"].as_f64().unwrap();
            let sat = If97.saturation(s(p0)).expect("saturation");
            let flux = st::restriction_flux(&If97, true, s(p0), sat.vapor.enthalpy, s(back))
                .expect("calibration flux");
            let rate = flux.mass_flux.value * device.effective_area_per_lift_m2;
            let declared = cal["massFlow_kg_s"].as_f64().unwrap();
            checks.insert("relief".into(), json!({"exercised":opened,"events":events.len(),"demand_crossings":crossings,"full_travel":travel,
                "calibration":{"rate_kg_s":rate,"declared_kg_s":declared,"relative_difference":(rate-declared)/declared,"choked":flux.choked,
                    "owner_statement":"the IF97 restriction gives 99.986 kg/s at this point; the 1.4e-4 relative difference is formulation consistency, not a recalibration",
                    "reproduces_owner_stated_if97_value":format!("{rate:.3}")=="99.986"}}));
            if gate == 6 && !opened {
                checks.insert("relief_not_exercised".into(), json!(format!("{} never reached {} Pa: the relief was not exercised; boundaries unchanged", entry.id, device.opening_pa)));
            }
            if gate == 6 {
                for t in &travel {
                    let d = t["duration_s"].as_f64().unwrap();
                    if (d - 1. / device.full_strokes_per_s).abs()
                        > ctx.budgets.f64(&["thresholdTiming_s"])
                    {
                        failures.push(format!(
                            "lift travel {d} s differs from the declared stroke"
                        ));
                    }
                }
                if !(flux.choked && format!("{rate:.3}") == "99.986") {
                    failures.push(format!("calibration point gives {rate} kg/s"));
                }
            }
            let relief_mass: (f64, f64, f64) =
                nominal.samples.windows(2).fold((0., 0., 0.), |acc, w| {
                    let dt = w[1].t - w[0].t;
                    (
                        acc.0 + 0.5 * dt * (w[0].relief_vapor_kg_s + w[1].relief_vapor_kg_s),
                        acc.1 + 0.5 * dt * (w[0].relief_drop_kg_s + w[1].relief_drop_kg_s),
                        acc.2 + 0.5 * dt * (w[0].relief_boron_kg_s + w[1].relief_boron_kg_s),
                    )
                });
            checks.insert("relief_withdrawn".into(), json!({"vapor_kg":relief_mass.0,"drops_kg":relief_mass.1,"drop_boron_kg":relief_mass.2}));
        }
        7 => {
            let target = entry.level_m.unwrap();
            let count = |f: fn(&p2_harness::Sample) -> f64| {
                nominal
                    .samples
                    .windows(2)
                    .filter(|w| (f(&w[0]) - target).signum() != (f(&w[1]) - target).signum())
                    .count()
            };
            let range = |f: fn(&p2_harness::Sample) -> f64| {
                let v: Vec<f64> = nominal.samples.iter().map(f).collect();
                json!([
                    v.iter().copied().fold(f64::INFINITY, f64::min),
                    v.iter().copied().fold(f64::NEG_INFINITY, f64::max)
                ])
            };
            checks.insert("cycling".into(), json!({"level_crossings_of_setpoint":{"mixture":count(|s|s.mixture_level_m),"collapsed":count(|s|s.collapsed_level_m)},
                "mixture_level_m":range(|s|s.mixture_level_m),"collapsed_level_m":range(|s|s.collapsed_level_m),"pt1_pa":range(|s|s.pt1_pa),
                "admitted_mass_kg":range(|s|s.masses[1]),"admitted_thickness_m":range(|s|s.admitted_thickness_m),"admitted_temperature_k":range(|s|s.temperatures_k[1]),"phi":range(|s|s.withdrawal_fraction),"lt_dp_pa":range(|s|s.lt_dp_pa),
                "structural_events":nominal.structural.len(),"resolvability_reports":nominal.resolvability.len()}));
        }
        _ => {}
    }
    if limit {
        // The limit report: what was reached, when, the zone states and the
        // ledger up to it. Reaching it is the expected outcome.
        let label = match &nominal.end {
            End::Limit { label } => Some(label.clone()),
            _ => None,
        };
        let last = nominal.samples.last().map(p2_harness::sample_json);
        let declared_kind = label.as_ref().is_some_and(|l| {
            l.starts_with("structural event")
                || l.starts_with("structural limit")
                || l.starts_with("property-domain edge")
                || l.starts_with("maxDuration")
        });
        checks.insert("limit_report".into(), json!({"limit":label,"t_s":nominal.reached_s,"zone_states":last,"ledger":ledgers.get("nominal"),"declared_limit_kind":declared_kind}));
        if !declared_kind {
            failures.push(format!(
                "limit report missing or not a declared limit: {:?}",
                nominal.end
            ));
        }
    }
    let verdict = if failures.is_empty() {
        "PASS".to_string()
    } else {
        format!("FAIL: {}", failures.join("; "))
    };
    let stop_rules: Vec<Value> = runs
        .iter()
        .filter_map(|(label, _, _, r)| match &r.end {
            End::StopRule { rule, reason } => {
                Some(json!({"run":label,"rule":rule,"reason":reason}))
            }
            _ => None,
        })
        .collect();
    let set_cpu: f64 = runs.iter().map(|r| r.3.cpu_s).sum();
    json!({"kind":"ld01-p2-case","case":entry.id,"gate":gate,"entry":entry_value(ctx, &entry.id),"smoke_duration_s":smoke,
        "provenance":ctx.provenance,
        "configuration":{"rtol":rtol,"atol":tolerances(ctx, &prepared_nominal.column, &prepared_nominal.scales, rtol, armed),"scales":prepared_nominal.scales,"max_order":ctx.gates.f64(&["maxOrder"]),"refined":{"rtol_factor":factor,"max_order":ctx.gates.f64(&["maxOrder"])},
            "event_restart_first_step_s":ctx.set.event_restart_first_step_s,"pt1_exclusion_around_event_s":armed.then_some(judgement.pt1_exclusion_around_event_s),
            "cutout_settings_source":cutout.map(|_| "transcribed from prose (safety LD01.PROT.PZR.LOW_LEVEL, heater isolator, electronic differential level); no strict block declares them"),
            "observation_s":ctx.gates.f64(&["comparison", "observation_s"]),"cutoff_hz":ctx.budgets.f64(&["uncreditedAbove_Hz"]),
            "output_interval_s":ctx.output_s(),"breakpoints":breakpoints(entry),"run_cpu_cap_s":cap,"nonnegative_constraints":["M_b","M_d","B_d"],
            "ports":p.ports.iter().map(|q| json!({"id":q.id,"kind":format!("{:?}",q.kind),"elevation_m":q.elevation_m,"face":q.face,"bore_m":q.bore_m,"relief":q.relief.map(|d| json!({"opening_Pa":d.opening_pa,"reseat_Pa":d.reseat_pa,"fullStrokes_per_s":d.full_strokes_per_s,"effectiveAreaPerLift_m2":d.effective_area_per_lift_m2}))})).collect::<Vec<_>>(),
            "sources":{"surge_enthalpy_j_kg":enthalpy(&ctx.set.sources.surge),"spray_enthalpy_j_kg":enthalpy(&ctx.set.sources.spray),"absorber_mass_fraction":p.absorber_mass_fraction},
            "relief_back_pressure_pa":ctx.set.relief_back_pressure_pa},
        "preparation":prepared_nominal.preparation,"runs":Value::Object(runs_json),"checks":Value::Object(checks),"stop_rules":stop_rules,
        "case_cpu_s":set_cpu,"verdict":verdict})
}

fn entry_value(ctx: &Context, id: &str) -> Value {
    ctx.cases_block.value["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .cloned()
        .unwrap()
}

fn skipped(label: &str) -> Run {
    Run {
        label: label.into(),
        samples: Vec::new(),
        accepted_checks: 0,
        accepted_peaks: [(f64::NAN, 0.); 3],
        accepted_band_violation: None,
        relief_events: Vec::new(),
        area_crossings: Vec::new(),
        structural: Vec::new(),
        initializations: Vec::new(),
        resolvability: Vec::new(),
        uncredited: Vec::new(),
        handle_stats: Vec::new(),
        step_probe: Vec::new(),
        cutout: None,
        observations: Vec::new(),
        end: End::SetBound,
        totals: Default::default(),
        handles: 0,
        counters: Counters::default(),
        cpu_s: 0.,
        thread_cpu_s: 0.,
        diagnostic_cpu_s: 0.,
        wall_s: 0.,
        y: Vec::new(),
        yp: Vec::new(),
        reached_s: 0.,
    }
}

/// A case the declaration does not run: a disclosed limit (gate 2, G1 (b)),
/// or blocked as its text states (gate 3 after G2 (a): the band's 5.9 MPa
/// lower edge and the unadmitted surge-line initial state).
fn blocked_case(ctx: &Context, entry: &Entry) -> Value {
    let verdict = if entry.disclosed_limit == Some(true) {
        "DISCLOSED LIMIT (owner, request 2 G1 (b)); not run"
    } else {
        "BLOCKED by the case declaration; not run"
    };
    json!({"kind":"ld01-p2-case","case":entry.id,"gate":entry.gate,"entry":entry_value(ctx,&entry.id),"provenance":ctx.provenance,
        "verdict":verdict,"runs":{},"case_cpu_s":0.})
}

// ---------------------------------------------------------------------------
// Frozen withdrawal benchmark: the P2 layer laws only, at constant pressure
// and zero gravity in the frozen 60 m³ / 5 m² vessel.

#[derive(Clone, Copy, Debug)]
enum Stroke {
    Admit {
        enthalpy: f64,
        concentration: f64,
        rate: f64,
    },
    Withdraw {
        rate: f64,
    },
    Hold,
}

/// Six differential coordinates: `M_A, H_A, B_A, M_R, H_R, B_R`. At constant
/// pressure each layer's enthalpy is its energy coordinate (`U' + p V' = H'`).
#[derive(Clone)]
struct Bench {
    pressure_pa: f64,
    area_m2: f64,
    withdrawal_scale_m: f64,
    exchange_m_s: f64,
    scales: [f64; 6],
    stroke: Stroke,
    residuals: u64,
    jacobians: u64,
}
#[derive(Clone, Copy)]
struct Layer {
    mass: Scalar,
    enthalpy: Scalar,
    boron: Scalar,
    density: Scalar,
    temperature: Scalar,
    water: WaterPoint,
}
impl Bench {
    fn layer(&self, m: Scalar, h: Scalar, b: Scalar) -> Result<Layer, String> {
        let (q, d) = props::inverse(&If97, s(self.pressure_pa), h / m, 0, true, None)
            .map_err(|e| format!("{e:?}"))?;
        let f = Scalar::new;
        Ok(Layer {
            mass: m,
            enthalpy: h / m,
            boron: b,
            density: f(q.density_kg_m3, d.density_kg_m3),
            temperature: f(q.temperature_k, d.temperature_k),
            water: WaterPoint {
                density: f(q.density_kg_m3, d.density_kg_m3),
                viscosity: f(q.viscosity_pa_s, d.viscosity_pa_s),
                conductivity: f(q.conductivity_w_m_k, d.conductivity_w_m_k),
                cp: f(q.cp_j_kg_k, d.cp_j_kg_k),
                expansion: f(q.expansion_per_k, d.expansion_per_k),
                enthalpy: f(q.enthalpy_j_kg, d.enthalpy_j_kg),
            },
        })
    }
    /// Sources of the six stocks and the outlet's specific enthalpy.
    fn sources(&self, x: &[Scalar; 6]) -> Result<([Scalar; 6], Scalar, Scalar), String> {
        let a = self.layer(x[0], x[1], x[2])?;
        let r = self.layer(x[3], x[4], x[5])?;
        let area = s(self.area_m2);
        let (va, vr) = (a.mass / a.density, r.mass / r.density);
        let delta = va / area;
        let hw = s(self.withdrawal_scale_m);
        let phi = delta * delta / (delta * delta + hw * hw);
        let mut src = [s(0.); 6];
        match self.stroke {
            Stroke::Admit {
                enthalpy,
                concentration,
                rate,
            } => {
                src[0] = s(rate);
                src[1] = s(rate * enthalpy);
                src[2] = s(rate * concentration);
            }
            Stroke::Withdraw { rate } => {
                let w = s(rate);
                src[0] = src[0] - phi * w;
                src[1] = src[1] - phi * w * a.enthalpy;
                src[2] = src[2] - phi * w * a.boron / a.mass;
                src[3] = src[3] - (s(1.) - phi) * w;
                src[4] = src[4] - (s(1.) - phi) * w * r.enthalpy;
                src[5] = src[5] - (s(1.) - phi) * w * r.boron / r.mass;
            }
            Stroke::Hold => {}
        }
        // Zero gravity: both layers at the one pressure, so the potential
        // densities at p_AR are the in-situ densities.
        let contrast = r.density - a.density;
        let e = if contrast.value > 0. {
            area * s(self.exchange_m_s) * contrast
        } else if contrast.value < 0. {
            s(0.)
        } else {
            Scalar::new(
                0.,
                (area * s(self.exchange_m_s) * contrast).direction.max(0.),
            )
        };
        src[1] = src[1] + e * (r.enthalpy - a.enthalpy);
        src[4] = src[4] - e * (r.enthalpy - a.enthalpy);
        src[2] = src[2] + e * (r.boron / r.mass - a.boron / a.mass);
        src[5] = src[5] - e * (r.boron / r.mass - a.boron / a.mass);
        let phase = |l: &Layer, v: Scalar| pf::Phase {
            mass: l.mass,
            volume: v,
            temperature: l.temperature,
            water: l.water,
            velocity: [s(0.); 2],
            boron_mass: l.boron,
        };
        // Centroid distance of the two regions in the constant-area vessel.
        let distance = (va + vr) / (s(2.) * area);
        let q = pf::conduction(phase(&a, va), phase(&r, vr), area / distance);
        src[1] = src[1] + q;
        src[4] = src[4] - q;
        let outlet = phi * a.enthalpy + (s(1.) - phi) * r.enthalpy;
        Ok((src, outlet, phi))
    }
    fn rows(
        &self,
        y: &[f64],
        yp: &[f64],
        seed: Option<(usize, f64)>,
    ) -> Result<[Scalar; 6], String> {
        let dir = |i: usize, rate: bool| match seed {
            Some((j, cj)) if j == i => {
                if rate {
                    cj * self.scales[i]
                } else {
                    self.scales[i]
                }
            }
            _ => 0.,
        };
        let x: [Scalar; 6] =
            std::array::from_fn(|i| Scalar::new(y[i] * self.scales[i], dir(i, false)));
        let (src, _, _) = self.sources(&x)?;
        Ok(std::array::from_fn(|i| {
            (Scalar::new(yp[i] * self.scales[i], dir(i, true)) - src[i]) / s(self.scales[i])
        }))
    }
}
/// Exact consistent rates of the benchmark's rows (all six differential):
/// its stroke starts never use IDACalcIC either.
impl ConsistentSystem for Bench {
    fn system_dimension(&self) -> usize {
        6
    }
    fn rows_at(&mut self, _: f64, y: &[f64], yp: &[f64]) -> Result<Vec<f64>, CellFailure> {
        let r = self.rows(y, yp, None).map_err(CellFailure::Recoverable)?;
        Ok(r.iter().map(|v| v.value).collect())
    }
    fn pencil_at(
        &mut self,
        _: f64,
        y: &[f64],
        yp: &[f64],
    ) -> Result<(Vec<f64>, Vec<f64>), CellFailure> {
        let (mut a, mut b) = (vec![0.; 36], vec![0.; 36]);
        for j in 0..6 {
            let ra = self
                .rows(y, yp, Some((j, 0.)))
                .map_err(CellFailure::Recoverable)?;
            let rb = self
                .rows(y, yp, Some((j, 1.)))
                .map_err(CellFailure::Recoverable)?;
            for i in 0..6 {
                a[j * 6 + i] = ra[i].direction;
                b[j * 6 + i] = rb[i].direction - ra[i].direction;
            }
        }
        Ok((a, b))
    }
}
impl System for Bench {
    fn dimension(&self) -> usize {
        6
    }
    fn nonzeros(&self) -> usize {
        36
    }
    fn root_count(&self) -> usize {
        0
    }
    fn residual(&mut self, _: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        self.residuals += 1;
        let r = self.rows(y, yp, None).map_err(Failure::Recoverable)?;
        for (o, v) in out.iter_mut().zip(r) {
            *o = v.value;
        }
        Ok(())
    }
    fn jacobian(
        &mut self,
        _: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        data: &mut [f64],
        rows: &mut [i64],
        pointers: &mut [i64],
    ) -> Result<(), Failure> {
        self.jacobians += 1;
        for j in 0..6 {
            let r = self
                .rows(y, yp, Some((j, cj)))
                .map_err(Failure::Recoverable)?;
            pointers[j] = (j * 6) as i64;
            for i in 0..6 {
                rows[j * 6 + i] = i as i64;
                data[j * 6 + i] = r[i].direction;
            }
        }
        pointers[6] = 36;
        Ok(())
    }
    fn roots(&mut self, _: f64, _: &[f64], _: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        if out.is_empty() {
            Ok(())
        } else {
            Err(Failure::Fatal("the benchmark declares no roots".into()))
        }
    }
}

fn benchmark(ctx: &Context, entry: &Entry, deadline: f64) -> Value {
    let b = &ctx.transport.value;
    let started = cpu_s();
    let thread_started = thread_cpu_s();
    let cap = entry.run_cpu_s.unwrap() * ctx.set.run_cap_factor;
    let p = b["pressure_MPa"].as_f64().unwrap() * 1e6;
    let area = b["area_m2"].as_f64().unwrap();
    let x = &ctx.parameters.stratified;
    let ppm = 1e-6;
    let state = |k: &str| {
        let t = b[k]["temperature_K"].as_f64().unwrap();
        let q = If97.forward(false, p, t).unwrap();
        (
            t,
            q.enthalpy_j_kg,
            q.density_kg_m3,
            b[k]["boron_ppm"].as_f64().unwrap() * ppm,
        )
    };
    let (t0, h0, rho0, c0) = state("initial");
    let initial_volume = b["initialVolume_m3"].as_f64().unwrap();
    let va = area * x.withdrawal_scale_m;
    let vr = initial_volume - va;
    let values = [
        rho0 * va,
        rho0 * va * h0,
        rho0 * va * c0,
        rho0 * vr,
        rho0 * vr * h0,
        rho0 * vr * c0,
    ];
    let rate = b["strokeRate_kg_s"].as_f64().unwrap();
    // Stroke schedule and the ordered (piston) comparator stack, bottom first.
    let mut schedule: Vec<(f64, f64, Stroke, &str)> = Vec::new();
    let mut stack: Vec<(f64, f64, f64, String)> =
        vec![(values[0] + values[3], t0, h0, "original".into())];
    let mut reference: Vec<(f64, f64, f64, String)> = Vec::new();
    let mut t = 0.;
    for stroke in b["strokes"].as_array().unwrap() {
        match stroke["kind"].as_str().unwrap() {
            "admit" => {
                let src = stroke["source"].as_str().unwrap();
                let (ts, hs, _, cs) = state(src);
                let m = stroke["mass_kg"].as_f64().unwrap();
                schedule.push((
                    t,
                    t + m / rate,
                    Stroke::Admit {
                        enthalpy: hs,
                        concentration: cs,
                        rate,
                    },
                    "admit",
                ));
                t += m / rate;
                stack.insert(0, (m, ts, hs, src.into()));
            }
            "withdraw" => {
                let mut m = stroke["mass_kg"].as_f64().unwrap();
                schedule.push((t, t + m / rate, Stroke::Withdraw { rate }, "withdraw"));
                t += m / rate;
                while m > 0. {
                    let take = m.min(stack[0].0);
                    reference.push((take, stack[0].1, stack[0].2, stack[0].3.clone()));
                    stack[0].0 -= take;
                    m -= take;
                    if stack[0].0 == 0. {
                        stack.remove(0);
                    }
                }
            }
            "hold" => {
                let d = stroke["duration_s"].as_f64().unwrap();
                schedule.push((t, t + d, Stroke::Hold, "hold"));
                t += d;
            }
            other => panic!("undeclared stroke {other}"),
        }
    }
    let scales = values;
    let stock = ctx.gates.f64(&["stockScaledAbsolute"]);
    let tracer = ctx.gates.f64(&["tracerScaledAbsolute"]);
    let atol = [stock, stock, tracer, stock, stock, tracer];
    let rtol = ctx.rtol();
    let output = ctx.output_s();
    let bench = Bench {
        pressure_pa: p,
        area_m2: area,
        withdrawal_scale_m: x.withdrawal_scale_m,
        exchange_m_s: x.inversion_exchange_velocity_m_s,
        scales,
        stroke: schedule[0].2,
        residuals: 0,
        jacobians: 0,
    };
    let mut y = vec![1.; 6];
    let mut bench = bench;
    let mut pairs: Vec<Value> = Vec::new();
    let weights = |y: &[f64]| -> Vec<f64> {
        y.iter()
            .zip(&atol)
            .map(|(v, a)| 1. / (rtol * v.abs() + a))
            .collect()
    };
    let w0 = weights(&y);
    let (mut yp, pair) = consistent_start(
        &mut bench,
        0.,
        &mut y,
        &[1.; 6],
        &w0,
        CONSISTENT_ROW_BOUND,
        CONSISTENT_PASSES,
    )
    .expect("benchmark consistent start");
    pairs.push(json!({"t":0.,"pair":pair}));
    let mut ida = Ida::new(
        bench,
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &[1.; 6],
            absolute_tolerance: &atol,
            relative_tolerance: rtol,
        },
    )
    .expect("benchmark IDA");
    ida.set_max_order(ctx.gates.f64(&["maxOrder"]) as usize)
        .unwrap();
    let mut failure = None;
    let mut totals = (0_i64, 0_i64, 0_i64, 0_i64, 0_i64);
    let mut withdrawn = 0.;
    let mut outlet: Vec<(f64, f64, f64, f64)> = Vec::new(); // (m, T_out, h_out, t)
    let mut samples = Vec::new();
    'strokes: for (k, (from, to, stroke, kind)) in schedule.iter().enumerate() {
        if k > 0 {
            if let Ok(st) = ida.stats() {
                totals.0 += st.steps;
                totals.1 += st.residuals;
                totals.2 += st.jacobians;
                totals.3 += st.error_failures;
                totals.4 += st.convergence_failures;
            }
            ida.system_mut().stroke = *stroke;
            // The stroke changes the receipts discontinuously: the exact
            // consistent rates at the stroke start, then IDAReInit.
            let w = weights(&y);
            match consistent_start(
                ida.system_mut(),
                *from,
                &mut y,
                &[1.; 6],
                &w,
                CONSISTENT_ROW_BOUND,
                CONSISTENT_PASSES,
            ) {
                Ok((rates, pair)) => {
                    yp = rates;
                    pairs.push(json!({"t":from,"pair":pair}));
                }
                Err(e) => {
                    failure = Some(format!("consistent start at {from} s: {e:?}"));
                    break;
                }
            }
            if let Err(e) = ida.reinitialize(*from, &y, &yp) {
                failure = Some(e);
                break;
            }
        }
        ida.stop_at(*to).unwrap();
        if let Stroke::Withdraw { .. } = stroke {
            let sys = ida.system();
            let xv: [Scalar; 6] = std::array::from_fn(|i| s(y[i] * sys.scales[i]));
            match sys.sources(&xv) {
                Ok((_, h_out, _)) => {
                    let t_out = If97
                        .caloric(false, p, h_out.value, true)
                        .map(|c| If97.values(&c).temperature_k)
                        .unwrap_or(f64::NAN);
                    outlet.push((withdrawn, t_out, h_out.value, *from));
                }
                Err(e) => {
                    failure = Some(format!("withdrawal start at {from} s: {e}"));
                    break;
                }
            }
        }
        let mut j = 1;
        loop {
            let target = (from + j as f64 * output).min(*to);
            match ida.advance(target, &mut y, &mut yp) {
                Ok(Advance::Reached(tr)) => {
                    let sys = ida.system();
                    let xv: [Scalar; 6] = std::array::from_fn(|i| s(y[i] * sys.scales[i]));
                    match sys.sources(&xv) {
                        Ok((_, h_out, phi)) => {
                            let a = sys.layer(xv[0], xv[1], xv[2]).unwrap();
                            let r = sys.layer(xv[3], xv[4], xv[5]).unwrap();
                            if let Stroke::Withdraw { rate } = stroke {
                                let m = withdrawn + rate * (tr - from);
                                let t_out = If97
                                    .caloric(false, p, h_out.value, true)
                                    .map(|c| If97.values(&c).temperature_k)
                                    .unwrap_or(f64::NAN);
                                outlet.push((m, t_out, h_out.value, tr));
                            }
                            if j % 10 == 0 || tr == *to {
                                samples.push(json!({"t":tr,"stroke":kind,"M_A":xv[0].value,"T_A":a.temperature.value,"M_R":xv[3].value,"T_R":r.temperature.value,"phi":phi.value,"h_out":h_out.value}));
                            }
                        }
                        Err(e) => {
                            failure = Some(format!("accepted state at {tr} s: {e}"));
                            break 'strokes;
                        }
                    }
                    if tr >= *to {
                        break;
                    }
                    j += 1;
                }
                Ok(Advance::Root { time, .. }) => {
                    failure = Some(format!("unexpected root at {time} s"));
                    break 'strokes;
                }
                Err(e) => {
                    failure = Some(e);
                    break 'strokes;
                }
            }
            if cpu_s() - started > cap {
                failure = Some(format!("run CPU cap {cap} s reached"));
                break 'strokes;
            }
            if cpu_s() > deadline {
                failure = Some("set CPU bound reached".into());
                break 'strokes;
            }
        }
        if let Stroke::Withdraw { rate } = stroke {
            withdrawn += rate * (to - from);
        }
    }
    if let Ok(st) = ida.stats() {
        totals.0 += st.steps;
        totals.1 += st.residuals;
        totals.2 += st.jacobians;
        totals.3 += st.error_failures;
        totals.4 += st.convergence_failures;
    }
    // Comparator: ordered withdrawal masses, temperatures and enthalpies.
    let edges: Vec<(f64, f64, f64)> = reference
        .iter()
        .scan(0., |m, (dm, tr, hr, _)| {
            *m += dm;
            Some((*m, *tr, *hr))
        })
        .collect();
    let t_ref = |m: f64| {
        edges
            .iter()
            .find(|e| m < e.0)
            .or(edges.last())
            .map(|e| e.1)
            .unwrap()
    };
    let mut weighted = 0.;
    let mut total_m = 0.;
    let mut max_local: f64 = 0.;
    let mut h_model = 0.;
    for w in outlet.windows(2) {
        let (m0, t0, h0, _) = w[0];
        let (m1, t1, h1, _) = w[1];
        let dm = m1 - m0;
        if dm <= 0. {
            continue;
        }
        let mid = 0.5 * (m0 + m1);
        weighted += (0.5 * (t0 + t1) - t_ref(mid)).abs() * dm;
        total_m += dm;
        h_model += 0.5 * (h0 + h1) * dm;
    }
    for (m, t_out, _, _) in &outlet {
        max_local = max_local.max((t_out - t_ref(*m)).abs());
    }
    let h_ref: f64 = reference.iter().map(|(dm, _, hr, _)| dm * hr).sum();
    let mean_error = weighted / total_m;
    let enthalpy_error = (h_model - h_ref) / h_ref;
    let screen_t = b["maximumOutletMeanAbsoluteError_K"].as_f64().unwrap();
    let screen_h = b["maximumRelativeWithdrawnEnthalpyError"].as_f64().unwrap();
    let sys = ida.system();
    json!({"kind":"ld01-p2-case","case":entry.id,"gate":null,"entry":entry_value(ctx,&entry.id),"provenance":ctx.provenance,
        "model":"P2 layer laws only: insurge into A, withdrawal by phi, inversion exchange on in-situ densities (zero gravity, one pressure) and stable conduction; constant-pressure boundary replaces the vapor zone; no phase law",
        "configuration":{"pressure_pa":p,"area_m2":area,"withdrawalScale_m":x.withdrawal_scale_m,"inversionExchangeVelocity_m_s":x.inversion_exchange_velocity_m_s,"rtol":rtol,"atol":atol,"scales":scales,"max_order":ctx.gates.f64(&["maxOrder"]),"output_interval_s":output,"initial_admitted_volume_m3":va},
        "comparator":{"ordered_withdrawals":reference.iter().map(|(m,t,h,src)| json!({"source":src,"mass_kg":m,"temperature_k":t,"enthalpy_j_kg":h})).collect::<Vec<_>>(),"withdrawn_enthalpy_j":h_ref},
        "result":{"mass_weighted_mean_abs_outlet_error_k":mean_error,"max_local_outlet_error_k":max_local,"withdrawn_enthalpy_relative_error":enthalpy_error,
            "integrated_withdrawn_mass_kg":total_m,"screens":{"maximumOutletMeanAbsoluteError_K":screen_t,"maximumRelativeWithdrawnEnthalpyError":screen_h},
            "meets_history_screen":mean_error <= screen_t,"meets_enthalpy_screen":enthalpy_error.abs() <= screen_h},
        "consistent_pairs":pairs,"run":{"failure":failure,"steps":totals.0,"residuals":totals.1,"jacobians":totals.2,"error_test_failures":totals.3,"convergence_failures":totals.4,
            "harness_residual_calls":sys.residuals,"harness_jacobian_calls":sys.jacobians,"cpu_s":cpu_s()-started,"thread_cpu_s":thread_cpu_s()-thread_started,"cpu_cap_s":cap},
        "series":samples,
        "verdict":if failure.is_none() { "REPORTED (not a P2 gate)" } else { "FAILED RUN" }})
}

/// Runs the named cases (all when `None`); `write` names the receipt suffix.
fn run_set(ids: Option<&[&str]>, write: Option<&str>, smoke: Option<f64>) -> Value {
    let ctx = Context::load();
    let set_started = cpu_s();
    let deadline = set_started + ctx.set.cpu_bound_s;
    let mut summary = Vec::new();
    for entry in &ctx.set.cases {
        if let Some(ids) = ids
            && !ids.contains(&entry.id.as_str())
        {
            continue;
        }
        let case_started = cpu_s();
        let load_start = load_average();
        let mut receipt = if entry.blocked == Some(true) {
            blocked_case(&ctx, entry)
        } else if entry.gate.is_none() {
            benchmark(&ctx, entry, deadline)
        } else {
            ld01_case(&ctx, entry, deadline, smoke)
        };
        let cpu = cpu_s() - case_started;
        receipt["load_average"] = json!({"start":load_start,"end":load_average(),"cores":8,
            "note":"process CPU on the shared machine; the S1 declaration's hygiene rule replays a CPU-only miss once on a quiet machine when the 1-minute load exceeds 8"});
        summary.push(json!({"case":entry.id,"gate":entry.gate,"verdict":receipt["verdict"],"cpu_s":cpu,"load_average":receipt["load_average"]}));
        if let Some(suffix) = write {
            ctx.write(&format!("{}{suffix}", entry.id), &receipt);
        } else {
            let dump = std::env::var("LD01_P2_SMOKE_DUMP").ok();
            match dump {
                Some(path) => std::fs::write(
                    format!("{path}/{}.json", entry.id),
                    serde_json::to_vec_pretty(&receipt).unwrap(),
                )
                .unwrap(),
                None => println!(
                    "{}",
                    serde_json::to_string(&json!({"case":entry.id,"verdict":receipt["verdict"]}))
                        .unwrap()
                ),
            }
        }
    }
    let total = cpu_s() - set_started;
    let set = json!({"kind":"ld01-p2-case-set","provenance":ctx.provenance,"load_average_end":load_average(),"cpu_bound_s":ctx.set.cpu_bound_s,"set_cpu_s":total,"within_bound":total <= ctx.set.cpu_bound_s,"cases":summary});
    if let Some(suffix) = write {
        ctx.write(&format!("set{suffix}"), &set);
    }
    let _ = &ctx.wiki;
    let _ = &ctx.packet_path;
    set
}

/// The declared P2 case set, in the block's order, with receipts.
#[test]
#[ignore = "requires the P2 packet, the wiki, maintained IF97 and stock IDA/KLU"]
fn p2_case_set() {
    let set = run_set(None, Some(""), None);
    println!("{}", serde_json::to_string_pretty(&set).unwrap());
}

/// Harness smoke test only, NOT evidence: the named cases (comma separated
/// in `LD01_P2_SMOKE`) with receipts printed, never written.
#[test]
#[ignore = "requires the P2 packet, the wiki, maintained IF97 and stock IDA/KLU"]
fn p2_harness_smoke() {
    let ids = std::env::var("LD01_P2_SMOKE").expect("LD01_P2_SMOKE lists case ids");
    let ids: Vec<&str> = ids.split(',').collect();
    let duration = std::env::var("LD01_P2_SMOKE_DURATION_S")
        .ok()
        .map(|d| d.parse::<f64>().expect("smoke duration"));
    run_set(Some(&ids), None, duration);
}

/// The S1 declaration's hygiene replay: a CPU-only miss under a 1-minute load
/// above 8 is run once more on a quiet machine. The named cases (comma
/// separated in `LD01_P2_REPLAY`) run in full, with receipts `<id>-replay.json`.
#[test]
#[ignore = "requires the P2 packet, the wiki, maintained IF97 and stock IDA/KLU"]
fn p2_case_replay() {
    let ids = std::env::var("LD01_P2_REPLAY").expect("LD01_P2_REPLAY lists case ids");
    let ids: Vec<&str> = ids.split(',').collect();
    let set = run_set(Some(&ids), Some("-replay"), None);
    println!("{}", serde_json::to_string_pretty(&set).unwrap());
}
