//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-reference.md#steady-solid-state-at-the-reference-power
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-thermal.md#two-node-fuel-finite-helium-and-clad
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-thermal.md#finite-steam-generators
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#6-solver-properties-and-cost-obligations
//! The steady solid state at the reference power (G18, lead decisions S2-D2
//! and S2-D3), a preparation step.
//!
//! Reads one provisional joined spine packet on stdin with a `steady`
//! section (the declared G17 power basis and the wall mass fluxes). Its solid
//! stocks are only the initial state. The joined solids' own residual
//! (`joined::solids::Solids`: every fuel node, clad and surface of every
//! material half, the shared helium, the plenum and passive Zircaloy stores
//! and the SG tube metal) is integrated by stock SUNDIALS IDA with KLU, with
//! everything else frozen:
//! - each carrier's fuel heat is the joined nuclear block's heat at the
//!   packet's prepared nuclear state (the same code and inputs as the joined
//!   start), checked against the declared basis;
//! - the coolant is the packet's prepared thermal water (IF97 liquid at each
//!   cell's pressure and temperature), the core and SG primary walls at the
//!   declared mass fluxes;
//! - each SG secondary is held at the packet's prepared secondary stock
//!   (pressure, IF97 saturation, liquid volume, steam present).
//!
//! There is no nonlinear solver of its own: the tolerances, the observation
//! checkpoints and the steady criterion are fixed constants declared in the
//! output, and the run stops at the first checkpoint at whose latest accepted
//! IDA step every store meets the criterion, or refuses at the horizon. The
//! consistent start is stock IDACalcIC. Any refusal (input, IDA, criterion,
//! domain admission, basis) exits nonzero and writes nothing on stdout. On
//! success it writes one JSON document (the `Steady` type below) on stdout.
//! Deterministic: one thread, fixed order, no clock or path in the output;
//! the CPU time goes to stderr only.
use leitbild_operating_plant::{
    joined::{
        block::{Coordinates, Fluid, Receipts, SecondaryView},
        nuclear::{self, Nuclear, RegionWater},
        packet::Packet,
        solids::{self, Closed, Solids, WallWater},
    },
    network::{self, Properties, Water},
    sg::{Secondaries, packet::Section},
    thermal::{self, Scalar, WaterProperties},
};
use leitbild_operating_water::{
    If97,
    ida::{self, Ida, Initial, KluOrdering, System},
};
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}

type Failure = Box<dyn std::error::Error>;

/// A network-side refusal as this binary's error, with its kind.
fn nf(e: network::Failure) -> Failure {
    format!("{e:?}").into()
}

/// A network-side refusal as an IDA callback failure, keeping its kind.
fn callback(e: network::Failure) -> ida::Failure {
    match e {
        network::Failure::Recoverable(m) => ida::Failure::Recoverable(m),
        network::Failure::Fatal(m) => ida::Failure::Fatal(m),
    }
}

// ---------------------------------------------------------------------------
// Declared method constants (written into every output before any check).

/// IDA's relative tolerance and the absolute tolerance on every scaled
/// coordinate (energies over their packet scale, surfaces over their seed).
const RELATIVE_TOLERANCE: f64 = 1e-10;
const ABSOLUTE_TOLERANCE_SCALED: f64 = 1e-10;
const MAXIMUM_ORDER: usize = 5;
/// Observation checkpoints: 2^k s for k = 0..=CHECKPOINTS-1 (1 s to 2^17 s).
const CHECKPOINTS: usize = 18;
/// The steady criterion (the critic's screens, S2-04): a store passes when
/// its rate is under `RATE_W` or its temperature rate under
/// `TEMPERATURE_RATE_K_S`; every surface balance is under `SURFACE_W`.
const RATE_W: f64 = 1e-3;
const TEMPERATURE_RATE_K_S: f64 = 1e-6;
const SURFACE_W: f64 = 1e-3;
/// The nuclear block's prepared heat must equal the packet's own
/// `thermal.source_total_w` within `PACKET_RELATIVE` (one compile), and the
/// declared G17 basis within `BASIS_RELATIVE`, G17's power-basis mismatch
/// ceiling (build-readiness, P2 - G17 mechanics: confirmed above 2e-3).
/// The re-based source does not scale every capture and binding term
/// linearly, so the prepared heat sits near, not at, the basis.
const PACKET_RELATIVE: f64 = 1e-9;
const BASIS_RELATIVE: f64 = 2e-3;
/// Domain admission of the steady nodes beyond the feedback's fuel domain:
/// the surface initializer's admission (fuel surface 500-2000 K, clad
/// surfaces 290-1800 K; `initialization.rs`) and the Zircaloy caloric and
/// conductivity domain (290-1800 K; `thermal.rs`) for every clad mean and
/// passive store.
const FUEL_SURFACE_DOMAIN_K: [f64; 2] = [500., 2000.];
const CLAD_DOMAIN_K: [f64; 2] = [290., 1800.];

fn checkpoints() -> Vec<f64> {
    (0..CHECKPOINTS).map(|k| (1u64 << k) as f64).collect()
}

// ---------------------------------------------------------------------------
// Input: the packet's `steady` section.

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SteadyInput {
    #[serde(rename = "basisPower_W")]
    pub basis_power_w: f64,
    #[serde(rename = "coreMassFlux_kg_m2_s")]
    pub core_mass_flux_kg_m2_s: f64,
    #[serde(rename = "sgPrimaryMassFlux_kg_m2_s")]
    pub sg_primary_mass_flux: Vec<SgFlux>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SgFlux {
    pub id: String,
    #[serde(rename = "massFlux_kg_m2_s")]
    pub mass_flux_kg_m2_s: f64,
}

// ---------------------------------------------------------------------------
// Output schema (`lanes/solids/schema.md`).

#[derive(Debug, Serialize)]
pub struct Steady {
    pub identity: &'static str,
    pub packet_identity: String,
    pub thermal_identity: String,
    pub method: Method,
    pub basis: Basis,
    pub carriers: Vec<Carrier>,
    pub helium: Vec<Helium>,
    pub passive: Vec<Store>,
    pub sg_metal: Vec<Metal>,
    pub steam_generators: Vec<Generator>,
    pub admission: Admission,
    pub steady: Reached,
    pub checkpoints: Vec<Checkpoint>,
    pub ida: IdaStats,
}

#[derive(Debug, Serialize)]
pub struct Method {
    pub solver: &'static str,
    pub frozen: Vec<&'static str>,
    pub relative_tolerance: f64,
    pub absolute_tolerance_scaled: f64,
    pub maximum_order: usize,
    pub initial_step_s: &'static str,
    pub consistent_start: &'static str,
    pub checkpoints_s: Vec<f64>,
    pub criterion: Criterion,
}

#[derive(Debug, Serialize)]
pub struct Criterion {
    pub rate_w: f64,
    pub temperature_rate_k_s: f64,
    pub surface_residual_w: f64,
    pub rule: &'static str,
}

#[derive(Debug, Serialize)]
pub struct Basis {
    pub basis_power_w: f64,
    pub fuel_heat_w: f64,
    pub coolant_heat_w: f64,
    pub total_heat_w: f64,
    /// (total - basis) / basis.
    pub relative_to_basis: f64,
    pub packet_source_total_w: f64,
    pub core_mass_flux_kg_m2_s: f64,
    pub wall_water: Vec<WallCell>,
    pub passive_water: Vec<PassiveCell>,
    pub secondaries: Vec<SecondaryBasis>,
}

#[derive(Debug, Serialize)]
pub struct WallCell {
    pub cell: usize,
    pub id: String,
    pub pressure_pa: f64,
    pub temperature_k: f64,
    pub mass_flux_kg_m2_s: f64,
}

#[derive(Debug, Serialize)]
pub struct PassiveCell {
    pub cell: usize,
    pub id: String,
    pub temperature_k: f64,
}

#[derive(Debug, Serialize)]
pub struct SecondaryBasis {
    pub id: String,
    pub pressure_pa: f64,
    pub saturation_k: f64,
    pub liquid_volume_m3: f64,
    pub primary_mass_flux_kg_m2_s: f64,
}

#[derive(Debug, Serialize)]
pub struct Carrier {
    pub id: String,
    pub fuel_store_ids: [String; 2],
    pub clad_store_id: String,
    pub fuel_temperatures_k: [f64; 2],
    pub fuel_energies_j: [f64; 2],
    pub clad_temperature_k: f64,
    pub clad_energy_j: f64,
    /// Fuel surface, clad inner, clad outer.
    pub surface_temperatures_k: [f64; 3],
    pub doppler_reference_k: f64,
    pub fuel_heat_w: f64,
    /// Inner fuel, outer fuel, clad.
    pub rates_w: [f64; 3],
    pub surface_residuals_w: [f64; 3],
    pub gap: Gap,
}

#[derive(Debug, Serialize)]
pub struct Gap {
    pub helium_k: f64,
    pub drop_k: f64,
    pub width_m: f64,
    pub jump_m: f64,
    pub jump_share: f64,
    pub accommodation: f64,
}

#[derive(Debug, Serialize)]
pub struct Helium {
    pub id: String,
    pub temperature_k: f64,
    pub energy_j: f64,
    pub pressure_pa: f64,
    pub rate_w: f64,
}

#[derive(Debug, Serialize)]
pub struct Store {
    pub id: String,
    pub temperature_k: f64,
    pub energy_j: f64,
    pub rate_w: f64,
}

#[derive(Debug, Serialize)]
pub struct Metal {
    pub id: String,
    pub generator: String,
    pub temperature_k: f64,
    pub energy_j: f64,
    pub primary_to_metal_w: f64,
    pub metal_to_secondary_w: f64,
    pub rate_w: f64,
}

#[derive(Debug, Serialize)]
pub struct Generator {
    pub id: String,
    pub primary_temperature_k: f64,
    pub saturation_k: f64,
    pub metal_temperature_k: [f64; 2],
    pub primary_to_metal_w: f64,
    pub metal_to_secondary_w: f64,
    /// The SG block's demand duty at the held secondary pressure:
    /// steam demand x (h_g(p) - feed enthalpy), IF97 and the block's feed.
    pub demand_duty_w: f64,
    pub duty_minus_demand_w: f64,
}

#[derive(Debug, Serialize)]
pub struct Admission {
    pub fuel_domain_k: [f64; 2],
    pub fuel_surface_domain_k: [f64; 2],
    pub clad_domain_k: [f64; 2],
    pub nodes_checked: usize,
    pub ordering: &'static str,
    pub ordering_checked: usize,
}

#[derive(Debug, Serialize)]
pub struct Reached {
    pub reached_s: f64,
    pub stores: usize,
    pub worst_rate_w: f64,
    pub worst_rate_store: String,
    pub worst_temperature_rate_k_s: f64,
    pub worst_temperature_rate_store: String,
    pub worst_surface_residual_w: f64,
    pub worst_surface: String,
    /// The final evaluation's balance: fuel heat = clad and passive heat into
    /// the water + metal and stored rates (W).
    pub clad_to_water_w: f64,
    pub passive_to_water_w: f64,
    pub stored_rate_w: f64,
}

#[derive(Debug, Serialize)]
pub struct Checkpoint {
    pub time_s: f64,
    pub step_time_s: f64,
    pub steps: i64,
    pub worst_rate_w: f64,
    pub worst_temperature_rate_k_s: f64,
    pub worst_surface_residual_w: f64,
    pub failing_stores: usize,
}

#[derive(Debug, Serialize)]
pub struct IdaStats {
    pub steps: i64,
    pub residuals: i64,
    pub jacobians: i64,
    pub nonlinear_iterations: i64,
    pub error_failures: i64,
    pub convergence_failures: i64,
    pub linear_setups: i64,
    pub last_order: i32,
    pub last_step_s: f64,
    pub jacobian_nonzeros: usize,
}

// ---------------------------------------------------------------------------
// The steady criterion and the gap diagnostics (pure; unit-tested).

/// One differential store at an observed state.
#[derive(Clone, Copy, Debug)]
pub struct StoreRate {
    pub rate_w: f64,
    /// dT/dU of the store's own caloric law (K/J).
    pub temperature_per_energy: f64,
}

/// Whether a store meets the declared criterion: |rate| < `RATE_W` or
/// |rate| dT/dU < `TEMPERATURE_RATE_K_S`.
pub fn store_passes(r: StoreRate) -> bool {
    r.rate_w.abs() < RATE_W || (r.rate_w * r.temperature_per_energy).abs() < TEMPERATURE_RATE_K_S
}

/// The gap's two resistive lengths at helium temperature `t_he`, from the
/// gap law of `thermal::fuel_transfers` (operating-thermal.md): the open
/// width `r_ci - r_f` and the temperature-jump term `1.845 g`, with the
/// helium conductivity. Receipt diagnostics only: the steady state itself
/// comes from the solids' residual, which a unit test ties this to.
pub fn gap_lengths(g: &thermal::FuelGeometry, t_he: f64) -> (f64, f64, f64) {
    // W/(m K) per BTU/(h ft F), as thermal.rs.
    const BTU: f64 = 1055.05585262 / 3600. / 0.3048 * 1.8;
    let k_he = BTU * 1.314e-3 * (1.8 * t_he).powf(0.668);
    let p_he = g.helium_nr_j_k / g.helium_volume_m3 * t_he;
    let jump = 0.3048 * 2.0358e-5 / BTU * k_he * t_he.sqrt()
        / (p_he / 6894.757293168 * (g.accommodation / 4.003_f64.sqrt()));
    (g.clad_inner_radius_m - g.fuel_radius_m, 1.845 * jump, k_he)
}

// ---------------------------------------------------------------------------
// The solids sub-residual as a stock IDA system.

/// One Jacobian column: the closed scope of the elements reading its
/// coordinate, the stores whose temperatures that scope reads, and its rows
/// (the scope's own coordinates, ascending: its CSC pattern).
struct Column {
    closed: Closed,
    stores: Vec<usize>,
    rows: Vec<usize>,
}

pub struct SolidsSystem {
    solids: Solids,
    points: Vec<[Option<(Water, Water)>; 2]>,
    fuel_w: Vec<Scalar>,
    views: Vec<SecondaryView>,
    scales: Vec<f64>,
    row_scales: Vec<f64>,
    temperatures: solids::Temperatures,
    rows: Vec<Scalar>,
    local: Vec<(usize, Scalar)>,
    sink: Vec<[[Scalar; 3]; 2]>,
    heat: solids::Heat,
    seed: Vec<f64>,
    columns: Vec<Column>,
    pointers: Vec<i64>,
    nonzeros: usize,
}

impl SolidsSystem {
    fn new(
        solids: Solids,
        points: Vec<[Option<(Water, Water)>; 2]>,
        fuel_w: Vec<Scalar>,
        views: Vec<SecondaryView>,
    ) -> Result<Self, Failure> {
        let layout = solids.layout().clone();
        let n = layout.len();
        let energies = 3 * solids.halves();
        let surfaces = energies..2 * energies;
        let mut columns = Vec::with_capacity(n);
        let mut pointers = Vec::with_capacity(n + 1);
        pointers.push(0i64);
        let mut nonzeros = 0usize;
        for j in 0..n {
            let (scope, _) = solids.column_scope(j).map_err(nf)?;
            let closed = solids.close(&scope);
            let rows = solids.scope_coordinates(&closed);
            if rows.binary_search(&j).is_err() {
                return Err(format!("column {j}'s closed scope omits its own row").into());
            }
            let stores = rows
                .iter()
                .copied()
                .filter(|i| !surfaces.contains(i))
                .collect();
            nonzeros += rows.len();
            pointers.push(nonzeros as i64);
            columns.push(Column {
                closed,
                stores,
                rows,
            });
        }
        let cells = points.len();
        Ok(Self {
            solids,
            points,
            fuel_w,
            views,
            scales: layout.scales.clone(),
            row_scales: layout.row_scales.clone(),
            temperatures: solids::Temperatures::default(),
            rows: vec![s(0.); n],
            local: Vec::new(),
            sink: vec![[[s(0.); 3]; 2]; cells],
            heat: solids::Heat::default(),
            seed: vec![0.; n],
            columns,
            pointers,
            nonzeros,
        })
    }

    /// Every own row in physical units at (`y`, `yp`), unseeded, with the
    /// heats of the evaluation in `self.heat`.
    fn physical_rows(&mut self, y: &[f64], yp: &[f64]) -> Result<(), network::Failure> {
        let x = Coordinates::new(y, yp, None, 0., &self.scales)?;
        self.solids.temperatures(x, &mut self.temperatures)?;
        self.sink.fill([[s(0.); 3]; 2]);
        let fluid = frozen_fluid(&self.points);
        self.solids.rows(
            &If97,
            x,
            &self.temperatures,
            &self.fuel_w,
            &fluid,
            &self.views,
            &mut Receipts::new(&mut self.sink),
            &mut self.rows,
            &mut self.heat,
        )
    }

    /// Each differential store's dT/dU from its own caloric inverse, by one
    /// evaluation seeded on every coordinate (each temperature reads only its
    /// own energy).
    fn temperature_per_energy(&self, y: &[f64]) -> Result<Vec<f64>, Failure> {
        let n = self.scales.len();
        let ones = vec![1.; n];
        let zero = vec![0.; n];
        let x = Coordinates::new(y, &zero, Some(&ones), 0., &self.scales).map_err(nf)?;
        let mut t = solids::Temperatures::default();
        self.solids.temperatures(x, &mut t).map_err(nf)?;
        let layout = self.solids.layout();
        let mut out = vec![0.; n];
        for (i, v) in out.iter_mut().enumerate() {
            if layout.differential[i] {
                let d = self.solids.temperature_of(i, &mut t).map_err(nf)?.direction;
                *v = d / self.scales[i];
            }
        }
        Ok(out)
    }
}

/// The frozen coolant as the solids read it: only the regular cells'
/// liquid caloric points (passive contacts); the wall slots are set
/// directly ([`Solids::set_wall_water`]).
fn frozen_fluid(points: &[[Option<(Water, Water)>; 2]]) -> Fluid<'_> {
    Fluid {
        cells: &[],
        points,
        liquid_mass: &[],
        vapor_mass: &[],
        tracer: &[],
        charts: &[],
        endpoints: &[],
        elevations: &[],
        volumes: &[],
        current_volumes: &[],
    }
}

impl System for SolidsSystem {
    fn dimension(&self) -> usize {
        self.scales.len()
    }
    fn nonzeros(&self) -> usize {
        self.nonzeros
    }
    fn root_count(&self) -> usize {
        0
    }
    fn klu_ordering(&self) -> KluOrdering {
        KluOrdering::Amd
    }
    fn residual(
        &mut self,
        _time: f64,
        y: &[f64],
        yp: &[f64],
        out: &mut [f64],
    ) -> Result<(), ida::Failure> {
        self.physical_rows(y, yp).map_err(callback)?;
        for ((o, r), sc) in out.iter_mut().zip(&self.rows).zip(&self.row_scales) {
            *o = r.value / sc;
        }
        Ok(())
    }
    fn jacobian(
        &mut self,
        _time: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        data: &mut [f64],
        rows: &mut [i64],
        pointers: &mut [i64],
    ) -> Result<(), ida::Failure> {
        // Every store's unseeded temperature, then per column the laws' own
        // seeded direction over the column's closed scope (bitwise the full
        // evaluation's rows, `Solids::rows_local`).
        let x = Coordinates::new(y, yp, None, cj, &self.scales).map_err(callback)?;
        self.solids
            .temperatures(x, &mut self.temperatures)
            .map_err(callback)?;
        pointers.copy_from_slice(&self.pointers);
        let fluid = frozen_fluid(&self.points);
        for (j, column) in self.columns.iter().enumerate() {
            self.seed[j] = 1.;
            let result = (|| -> Result<(), network::Failure> {
                let x = Coordinates::new(y, yp, Some(&self.seed), cj, &self.scales)?;
                self.solids
                    .temperatures_local(x, &column.stores, &mut self.temperatures)?;
                self.sink.fill([[s(0.); 3]; 2]);
                self.solids.rows_local(
                    &If97,
                    x,
                    &self.temperatures,
                    &self.fuel_w,
                    &fluid,
                    &self.views,
                    &column.closed,
                    &mut Receipts::new(&mut self.sink),
                    &mut self.local,
                    &mut self.heat,
                )
            })();
            self.seed[j] = 0.;
            result.map_err(callback)?;
            let start = self.pointers[j] as usize;
            if self.local.len() != column.rows.len() {
                return Err(ida::Failure::Fatal(format!(
                    "column {j} wrote {} rows, its pattern holds {}",
                    self.local.len(),
                    column.rows.len()
                )));
            }
            for (k, r) in column.rows.iter().enumerate() {
                rows[start + k] = *r as i64;
                data[start + k] = 0.;
            }
            for (r, v) in &self.local {
                let k = column.rows.binary_search(r).map_err(|_| {
                    ida::Failure::Fatal(format!("column {j} wrote row {r} outside its pattern"))
                })?;
                data[start + k] = v.direction / self.row_scales[*r];
            }
        }
        // Leave every temperature unseeded for the next residual's readers.
        self.solids
            .temperatures(x, &mut self.temperatures)
            .map_err(callback)?;
        Ok(())
    }
    fn roots(
        &mut self,
        _time: f64,
        _y: &[f64],
        _yp: &[f64],
        _out: &mut [f64],
    ) -> Result<(), ida::Failure> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// The observation of a state against the criterion.

struct Observation {
    rates_w: Vec<f64>,
    worst_rate: (f64, usize),
    worst_temperature_rate: (f64, usize),
    worst_surface: (f64, usize),
    failing: usize,
    stores: usize,
}

impl Observation {
    fn passes(&self) -> bool {
        self.failing == 0 && self.worst_surface.0 < SURFACE_W
    }
}

/// The laws' rates (zero derivative) and surface balances at `y`.
fn observe(system: &mut SolidsSystem, y: &[f64]) -> Result<Observation, Failure> {
    let n = y.len();
    let zero = vec![0.; n];
    system.physical_rows(y, &zero).map_err(nf)?;
    let per_energy = system.temperature_per_energy(y)?;
    let layout = system.solids.layout();
    let mut rates_w = vec![0.; n];
    let (mut worst_rate, mut worst_t, mut worst_s) = ((0., 0), (0., 0), (0., 0));
    let (mut failing, mut stores) = (0, 0);
    for i in 0..n {
        // With zero derivative a differential row is minus its rate; an
        // algebraic row is its surface balance (W).
        let row = system.rows[i].value;
        if layout.differential[i] {
            let rate = -row;
            rates_w[i] = rate;
            stores += 1;
            let r = StoreRate {
                rate_w: rate,
                temperature_per_energy: per_energy[i],
            };
            if !store_passes(r) {
                failing += 1;
            }
            if rate.abs() > worst_rate.0 {
                worst_rate = (rate.abs(), i);
            }
            let tr = (rate * per_energy[i]).abs();
            if tr > worst_t.0 {
                worst_t = (tr, i);
            }
        } else {
            rates_w[i] = row;
            if row.abs() > worst_s.0 {
                worst_s = (row.abs(), i);
            }
        }
        if !row.is_finite() {
            return Err(
                format!("non-finite row {} at the observed state", layout.labels[i]).into(),
            );
        }
    }
    Ok(Observation {
        rates_w,
        worst_rate,
        worst_temperature_rate: worst_t,
        worst_surface: worst_s,
        failing,
        stores,
    })
}

// ---------------------------------------------------------------------------

fn zero_water() -> Water {
    Water {
        pressure_pa: 0.,
        temperature_k: 0.,
        density_kg_m3: 0.,
        internal_energy_j_kg: 0.,
        enthalpy_j_kg: 0.,
        cp_j_kg_k: 0.,
        expansion_per_k: 0.,
        compressibility_per_pa: 0.,
        viscosity_pa_s: 0.,
        conductivity_w_m_k: 0.,
    }
}

fn positive(v: f64, what: &str) -> Result<f64, Failure> {
    if v.is_finite() && v > 0. {
        Ok(v)
    } else {
        Err(format!("{what} must be a positive finite number, not {v}").into())
    }
}

fn within(v: f64, d: [f64; 2], what: &str) -> Result<(), Failure> {
    if v.is_finite() && d[0] <= v && v <= d[1] {
        Ok(())
    } else {
        Err(format!(
            "{what} = {v} K is outside its domain [{}, {}] K",
            d[0], d[1]
        )
        .into())
    }
}

fn ordered(hi: f64, lo: f64, what: &str) -> Result<(), Failure> {
    if hi >= lo {
        Ok(())
    } else {
        Err(format!("ordering {what}: {hi} K < {lo} K").into())
    }
}

fn run() -> Result<Steady, Failure> {
    let started = cpu_seconds();
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let raw: serde_json::Value = serde_json::from_str(&input)?;
    let out = settle(prepare(&raw)?)?;
    eprintln!(
        "prepare_steady_solids: {:.3} CPU-s",
        cpu_seconds() - started
    );
    Ok(out)
}

/// Everything the settle reads, from one input document.
pub struct Prepared {
    pub packet: Packet,
    pub section: Section,
    pub feed_j_kg: f64,
    pub basis: Basis,
    pub fuel_w: Vec<Scalar>,
    pub system: SolidsSystem,
    pub y: Vec<f64>,
    pub yp: Vec<f64>,
}

/// The frozen basis, the solids system and its initial state (the packet's
/// stocks and surface seeds, each store's rate there as the derivative
/// guess).
pub fn prepare(raw: &serde_json::Value) -> Result<Prepared, Failure> {
    let packet: Packet = serde_json::from_value(raw.clone())?;
    let steady: SteadyInput = serde_json::from_value(
        raw.get("steady")
            .cloned()
            .ok_or("the packet has no `steady` section")?,
    )?;
    let basis_power_w = positive(steady.basis_power_w, "steady.basisPower_W")?;
    let core_flux = positive(steady.core_mass_flux_kg_m2_s, "steady.coreMassFlux_kg_m2_s")?;
    let secondaries = &packet.thermal.secondaries;
    if steady.sg_primary_mass_flux.len() != secondaries.len()
        || steady
            .sg_primary_mass_flux
            .iter()
            .zip(secondaries)
            .any(|(f, g)| f.id != g.id)
    {
        return Err(
            "steady.sgPrimaryMassFlux_kg_m2_s must list every thermal.secondaries id in order"
                .into(),
        );
    }
    let sg_flux: Vec<f64> = steady
        .sg_primary_mass_flux
        .iter()
        .map(|f| positive(f.mass_flux_kg_m2_s, "an SG primary mass flux"))
        .collect::<Result<_, _>>()?;
    let water = &packet.thermal.water;
    let cells = water.len();
    // The prepared coolant: IF97 liquid at each cell's prepared state.
    let mut points = Vec::with_capacity(cells);
    for w in water {
        let q = If97
            .forward(false, w.pressure_pa, w.temperature_k)
            .map_err(|e| format!("prepared coolant {}: {e}", w.id))?;
        points.push([Some((q, zero_water())), None]);
    }
    // The carriers' fuel heat at the prepared nuclear state: the joined
    // nuclear block's own rows, at the packet's own feedback reference
    // conditions, frozen through the run.
    let mut nuclear = Nuclear::new(&packet, cells).map_err(nf)?;
    let nl = nuclear.layout().clone();
    let ny: Vec<f64> = nuclear
        .prepared()
        .iter()
        .zip(&nl.scales)
        .map(|(v, sc)| v / sc)
        .collect();
    let nyp = vec![0.; ny.len()];
    let region_water: Vec<RegionWater> = packet
        .source_water
        .iter()
        .map(|&j| {
            let w = &water[j];
            RegionWater {
                density_kg_m3: s(w.mass_kg / w.volume_m3),
                boron_ppm_eq: s(1e6 * packet.water_boron_amount_kg_eq[j] / w.mass_kg),
                pressure_pa: s(w.pressure_pa),
                temperature_k: s(w.temperature_k),
            }
        })
        .collect();
    let reference_fuel: Vec<Scalar> = packet
        .feedback_reference
        .fuel_temperature_k
        .iter()
        .map(|t| s(*t))
        .collect();
    let travel: Vec<Scalar> = packet
        .feedback_reference
        .achieved_rod_travel_m
        .iter()
        .map(|t| s(*t))
        .collect();
    let mut nrows = vec![s(0.); ny.len()];
    let mut nheat = nuclear::Heat::default();
    nuclear
        .rows(
            0.,
            Coordinates::new(&ny, &nyp, None, 0., &nl.scales).map_err(nf)?,
            &reference_fuel,
            &region_water,
            &travel,
            &mut nrows,
            &mut nheat,
        )
        .map_err(nf)?;
    let fuel_w = nheat.fuel_w.clone();
    let fuel_heat_w: f64 = fuel_w.iter().map(|v| v.value).sum();
    let coolant_heat_w: f64 = nheat.coolant_w.iter().map(|v| v.value).sum();
    let total_heat_w = fuel_heat_w + coolant_heat_w;
    let source_total_w = packet.thermal.source_total_w;
    let packet_gap = (total_heat_w - source_total_w).abs();
    if !packet_gap.is_finite() || packet_gap > PACKET_RELATIVE * source_total_w.abs() {
        return Err(format!(
            "the nuclear block's prepared heat {total_heat_w} W is not the packet's source total {source_total_w} W"
        )
        .into());
    }
    let relative_to_basis = (total_heat_w - basis_power_w) / basis_power_w;
    if !relative_to_basis.is_finite() || relative_to_basis.abs() > BASIS_RELATIVE {
        return Err(format!(
            "the packet's prepared nuclear heat {total_heat_w} W is not at the declared basis {basis_power_w} W ({relative_to_basis:e} relative)"
        )
        .into());
    }
    let mut solids = Solids::new(&packet, cells).map_err(nf)?;
    // Wall water: every wall cell is a core contact's or an SG primary's,
    // never both, at its declared mass flux.
    let mut flux: Vec<Option<f64>> = vec![None; cells];
    for (_, contacts) in &solids.incidence().halves {
        for &c in contacts {
            flux[c] = Some(core_flux);
        }
    }
    for &(c, k) in &solids.incidence().segments {
        if flux[c].is_some_and(|f| f != sg_flux[k]) {
            return Err(format!("wall cell {} is both core and SG primary", water[c].id).into());
        }
        flux[c] = Some(sg_flux[k]);
    }
    let wall_cells = solids.wall_cells().to_vec();
    let mut wall_water = Vec::with_capacity(wall_cells.len());
    for &c in &wall_cells {
        let w = &water[c];
        let m = flux[c].ok_or_else(|| format!("wall cell {} has no declared mass flux", w.id))?;
        let p = s(w.pressure_pa);
        solids
            .set_wall_water(
                c,
                WallWater {
                    pressure: p,
                    temperature: s(w.temperature_k),
                    bulk: WaterProperties::liquid(&If97, p, s(w.temperature_k))?,
                    saturation: WaterProperties::saturation(&If97, p)?,
                    mass_flux: s(m),
                },
            )
            .map_err(nf)?;
        wall_water.push(WallCell {
            cell: c,
            id: w.id.clone(),
            pressure_pa: w.pressure_pa,
            temperature_k: w.temperature_k,
            mass_flux_kg_m2_s: m,
        });
    }
    let mut passive_cells: Vec<usize> = solids.incidence().passive.iter().map(|p| p.1).collect();
    passive_cells.sort_unstable();
    passive_cells.dedup();
    let passive_water = passive_cells
        .iter()
        .map(|&c| PassiveCell {
            cell: c,
            id: water[c].id.clone(),
            temperature_k: water[c].temperature_k,
        })
        .collect();
    let mut views = Vec::with_capacity(secondaries.len());
    let mut secondary_basis = Vec::with_capacity(secondaries.len());
    for (k, g) in secondaries.iter().enumerate() {
        let p = s(positive(g.pressure_pa, "a secondary pressure")?);
        let saturation = WaterProperties::saturation(&If97, p)?;
        views.push(SecondaryView {
            pressure: p,
            saturation_temperature: saturation.temperature,
            liquid_volume: s(positive(g.liquid_volume_m3, "a secondary liquid volume")?),
            steam_present: true,
        });
        secondary_basis.push(SecondaryBasis {
            id: g.id.clone(),
            pressure_pa: g.pressure_pa,
            saturation_k: saturation.temperature.value,
            liquid_volume_m3: g.liquid_volume_m3,
            primary_mass_flux_kg_m2_s: sg_flux[k],
        });
    }
    // The SG block's demand duty at the held secondary pressure.
    let section: Section = serde_json::from_value(
        raw.get("secondary")
            .cloned()
            .ok_or("the packet has no `secondary` section")?,
    )?;
    let block = Secondaries::new(&section, secondaries, &If97).map_err(nf)?;
    let feed_j_kg = block.derived().feed_enthalpy_j_kg;
    if section.steam_generators.len() != secondaries.len() {
        return Err("the SG section and thermal.secondaries differ in count".into());
    }

    let layout = solids.layout().clone();
    let n = layout.len();
    let y: Vec<f64> = solids
        .prepared()
        .iter()
        .zip(&layout.scales)
        .map(|(v, sc)| v / sc)
        .collect();
    let mut system = SolidsSystem::new(solids, points, fuel_w.clone(), views)?;
    // The initial derivative guess: each store's rate at the packet's
    // stocks; stock IDACalcIC then makes the surfaces and rates consistent.
    let mut yp = vec![0.; n];
    let zero = vec![0.; n];
    system.physical_rows(&y, &zero).map_err(nf)?;
    for (i, v) in yp.iter_mut().enumerate() {
        if layout.differential[i] {
            *v = -system.rows[i].value / layout.row_scales[i];
        }
    }
    Ok(Prepared {
        basis: Basis {
            basis_power_w,
            fuel_heat_w,
            coolant_heat_w,
            total_heat_w,
            relative_to_basis,
            packet_source_total_w: source_total_w,
            core_mass_flux_kg_m2_s: core_flux,
            wall_water,
            passive_water,
            secondaries: secondary_basis,
        },
        packet,
        section,
        feed_j_kg,
        fuel_w,
        system,
        y,
        yp,
    })
}

/// One stock IDA run from the prepared state to the first checkpoint that
/// meets the criterion, then the steady state's receipt and admission.
pub fn settle(p: Prepared) -> Result<Steady, Failure> {
    let Prepared {
        packet,
        section,
        feed_j_kg,
        basis,
        fuel_w,
        system,
        mut y,
        mut yp,
    } = p;
    let layout = system.solids.layout().clone();
    let n = layout.len();
    let differential = layout.ids();
    let jacobian_nonzeros = system.nonzeros;
    let secondaries = &packet.thermal.secondaries;
    let water = &packet.thermal.water;
    let secondary_basis = &basis.secondaries;
    let marks = checkpoints();
    let atol = vec![ABSOLUTE_TOLERANCE_SCALED; n];
    let mut solver = Ida::new(
        system,
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &differential,
            absolute_tolerance: &atol,
            relative_tolerance: RELATIVE_TOLERANCE,
        },
    )?;
    solver.set_max_order(MAXIMUM_ORDER)?;
    solver.initialize(marks[0], &mut y, &mut yp)?;
    let mut observed = Vec::with_capacity(marks.len());
    let mut reached = None;
    let (mut ys, mut yps) = (vec![0.; n], vec![0.; n]);
    for &t in &marks {
        solver.advance(t, &mut y, &mut yp)?.reached()?;
        // The latest accepted step, not the interpolant at `t`.
        let step_time = solver.current_state(&mut ys, &mut yps)?;
        let o = observe(solver.system_mut(), &ys)?;
        let stats = solver.stats()?;
        observed.push(Checkpoint {
            time_s: t,
            step_time_s: step_time,
            steps: stats.steps,
            worst_rate_w: o.worst_rate.0,
            worst_temperature_rate_k_s: o.worst_temperature_rate.0,
            worst_surface_residual_w: o.worst_surface.0,
            failing_stores: o.failing,
        });
        eprintln!(
            "t {t} s (step {step_time} s, {} steps): worst rate {:e} W, worst dT/dt {:e} K/s, worst surface {:e} W, failing {}",
            stats.steps, o.worst_rate.0, o.worst_temperature_rate.0, o.worst_surface.0, o.failing
        );
        if o.passes() {
            reached = Some((step_time, o));
            break;
        }
    }
    let Some((reached_s, o)) = reached else {
        return Err(format!(
            "the steady criterion did not hold by the horizon {} s",
            marks[marks.len() - 1]
        )
        .into());
    };
    let stats = solver.stats()?;
    let system = solver.system_mut();
    // The final state: every temperature and heat from one evaluation.
    let zero = vec![0.; n];
    system.physical_rows(&ys, &zero).map_err(nf)?;
    let heat = system.heat.clone();
    let t = system.temperatures.clone();
    let solids = &system.solids;
    let physical: Vec<f64> = ys
        .iter()
        .zip(&layout.scales)
        .map(|(v, sc)| v * sc)
        .collect();
    let domains = &packet.feedback_metadata.parameters.domains;
    let fuel_domain = [
        domains.fuel_temperature_k.minimum,
        domains.fuel_temperature_k.maximum,
    ];
    let (mut nodes_checked, mut ordering_checked) = (0, 0);
    let mut carriers = Vec::with_capacity(solids.halves());
    for (a, band) in packet.thermal.fuel_bands.iter().enumerate() {
        let [inner, outer, clad] = t.fuel[a].map(|v| v.value);
        let surface = [0, 1, 2].map(|k| physical[solids.surface(a, k)]);
        let doppler = thermal::fuel_feedback_temperature(s(inner), s(outer))?.value;
        let helium_k = t.helium[band.helium].value;
        within(inner, fuel_domain, &format!("{} inner fuel", band.id))?;
        within(outer, fuel_domain, &format!("{} outer fuel", band.id))?;
        within(
            doppler,
            fuel_domain,
            &format!("{} Doppler reference", band.id),
        )?;
        within(
            surface[0],
            FUEL_SURFACE_DOMAIN_K,
            &format!("{} fuel surface", band.id),
        )?;
        within(
            surface[1],
            CLAD_DOMAIN_K,
            &format!("{} clad inner", band.id),
        )?;
        within(clad, CLAD_DOMAIN_K, &format!("{} clad mean", band.id))?;
        within(
            surface[2],
            CLAD_DOMAIN_K,
            &format!("{} clad outer", band.id),
        )?;
        nodes_checked += 7;
        ordered(inner, outer, &format!("{} inner/outer fuel", band.id))?;
        ordered(
            outer,
            surface[0],
            &format!("{} outer fuel/surface", band.id),
        )?;
        ordered(
            surface[0],
            surface[1],
            &format!("{} fuel surface/clad inner", band.id),
        )?;
        ordered(surface[1], clad, &format!("{} clad inner/mean", band.id))?;
        ordered(clad, surface[2], &format!("{} clad mean/outer", band.id))?;
        let contacts: Vec<usize> = solids.incidence().halves[a].1.clone();
        for c in &contacts {
            ordered(
                surface[2],
                water[*c].temperature_k,
                &format!("{} clad outer/water {}", band.id, water[*c].id),
            )?;
        }
        ordering_checked += 5 + contacts.len();
        let geometry = solids_geometry(&band.geometry);
        let (width, jump, _) = gap_lengths(&geometry, helium_k);
        let i = |k: usize| solids.energy(a, k);
        let si = |k: usize| solids.surface(a, k);
        carriers.push(Carrier {
            id: band.id.clone(),
            fuel_store_ids: band.fuel_store_ids.clone(),
            clad_store_id: band.clad_store_id.clone(),
            fuel_temperatures_k: [inner, outer],
            fuel_energies_j: [physical[i(0)], physical[i(1)]],
            clad_temperature_k: clad,
            clad_energy_j: physical[i(2)],
            surface_temperatures_k: surface,
            doppler_reference_k: doppler,
            fuel_heat_w: fuel_w[a].value,
            rates_w: [0, 1, 2].map(|k| o.rates_w[i(k)]),
            surface_residuals_w: [0, 1, 2].map(|k| o.rates_w[si(k)]),
            gap: Gap {
                helium_k,
                drop_k: surface[0] - surface[1],
                width_m: width,
                jump_m: jump,
                jump_share: jump / (width + jump),
                accommodation: band.geometry.accommodation,
            },
        });
    }
    // Helium: ordered between its halves' clad inner and fuel surfaces.
    let mut helium = Vec::with_capacity(packet.thermal.helium.len());
    for (h, record) in packet.thermal.helium.iter().enumerate() {
        let temperature = t.helium[h].value;
        let halves: Vec<usize> = (0..carriers.len())
            .filter(|a| packet.thermal.fuel_bands[*a].helium == h)
            .collect();
        let lo = halves
            .iter()
            .map(|a| carriers[*a].surface_temperatures_k[1])
            .fold(f64::INFINITY, f64::min);
        let hi = halves
            .iter()
            .map(|a| carriers[*a].surface_temperatures_k[0])
            .fold(f64::NEG_INFINITY, f64::max);
        ordered(
            hi,
            temperature,
            &format!("{} helium/fuel surfaces", record.id),
        )?;
        ordered(
            temperature,
            lo,
            &format!("{} helium/clad inners", record.id),
        )?;
        ordering_checked += 2;
        nodes_checked += 1;
        let k = solids.helium(h);
        helium.push(Helium {
            id: record.id.clone(),
            temperature_k: temperature,
            energy_j: physical[k],
            pressure_pa: record.nr_j_k * temperature / record.volume_m3,
            rate_w: o.rates_w[k],
        });
    }
    let mut passive = Vec::with_capacity(packet.thermal.passive_stores.len());
    for (p, record) in packet.thermal.passive_stores.iter().enumerate() {
        let temperature = t.passive[p].value;
        within(
            temperature,
            CLAD_DOMAIN_K,
            &format!("{} passive store", record.id),
        )?;
        nodes_checked += 1;
        let k = solids.passive(p);
        passive.push(Store {
            id: record.id.clone(),
            temperature_k: temperature,
            energy_j: physical[k],
            rate_w: o.rates_w[k],
        });
    }
    let mut sg_metal = Vec::with_capacity(packet.thermal.sg_segments.len());
    let mut generators: Vec<Generator> = secondaries
        .iter()
        .zip(secondary_basis)
        .zip(&section.steam_generators)
        .map(|((g, b), sg)| -> Result<Generator, Failure> {
            let hg = WaterProperties::saturation(&If97, s(g.pressure_pa))?
                .vapor
                .enthalpy
                .value;
            Ok(Generator {
                id: g.id.clone(),
                primary_temperature_k: f64::NAN,
                saturation_k: b.saturation_k,
                metal_temperature_k: [f64::INFINITY, f64::NEG_INFINITY],
                primary_to_metal_w: 0.,
                metal_to_secondary_w: 0.,
                demand_duty_w: sg.steam_demand_kg_s * (hg - feed_j_kg),
                duty_minus_demand_w: 0.,
            })
        })
        .collect::<Result<_, _>>()?;
    for (i, record) in packet.thermal.sg_segments.iter().enumerate() {
        let temperature = t.metal[i].value;
        let k = solids.metal(i);
        let primary_t = water[record.primary].temperature_k;
        let saturation = secondary_basis[record.secondary].saturation_k;
        ordered(
            primary_t,
            temperature,
            &format!("{} SG primary/metal", record.id),
        )?;
        ordered(
            temperature,
            saturation,
            &format!("{} SG metal/saturation", record.id),
        )?;
        if !(primary_t > temperature && temperature > saturation) {
            return Err(format!(
                "{} SG metal {temperature} K is not strictly between T_sat {saturation} K and the primary {primary_t} K",
                record.id
            )
            .into());
        }
        ordering_checked += 2;
        nodes_checked += 1;
        let primary_to_metal = heat.primary_to_metal_w[i].value;
        let rate = o.rates_w[k];
        let to_secondary = primary_to_metal - rate;
        let g = &mut generators[record.secondary];
        if g.primary_temperature_k.is_nan() {
            g.primary_temperature_k = primary_t;
        } else if g.primary_temperature_k != primary_t {
            return Err(format!("SG {}'s segments read different primary cells", g.id).into());
        }
        g.metal_temperature_k = [
            g.metal_temperature_k[0].min(temperature),
            g.metal_temperature_k[1].max(temperature),
        ];
        g.primary_to_metal_w += primary_to_metal;
        sg_metal.push(Metal {
            id: record.id.clone(),
            generator: secondaries[record.secondary].id.clone(),
            temperature_k: temperature,
            energy_j: physical[k],
            primary_to_metal_w: primary_to_metal,
            metal_to_secondary_w: to_secondary,
            rate_w: rate,
        });
    }
    for (k, g) in generators.iter_mut().enumerate() {
        g.metal_to_secondary_w = heat.secondary_w[k].value;
        g.duty_minus_demand_w = g.metal_to_secondary_w - g.demand_duty_w;
    }
    let stored_rate_w = heat.stored_rate_w.value;
    let out = Steady {
        identity: "LD01-STEADY-SOLIDS-1",
        packet_identity: packet.identity.clone(),
        thermal_identity: packet.thermal.identity.clone(),
        method: Method {
            solver: "stock SUNDIALS IDA (BDF) with KLU (AMD) over the joined solids sub-residual",
            frozen: vec![
                "nuclear state: the packet's prepared state; carrier fuel heat from the joined nuclear block there",
                "coolant: the packet's prepared thermal water cells, IF97 liquid at their pressure and temperature",
                "wall mass flux: steady.coreMassFlux_kg_m2_s on every core wall cell, steady.sgPrimaryMassFlux_kg_m2_s on each SG primary cell",
                "SG secondaries: the packet's prepared secondary stocks (pressure, IF97 saturation, liquid volume, steam present)",
            ],
            relative_tolerance: RELATIVE_TOLERANCE,
            absolute_tolerance_scaled: ABSOLUTE_TOLERANCE_SCALED,
            maximum_order: MAXIMUM_ORDER,
            initial_step_s: "stock default",
            consistent_start: "stock IDACalcIC (IDA_YA_YDP_INIT) from the packet's stocks and surface seeds",
            checkpoints_s: marks.clone(),
            criterion: Criterion {
                rate_w: RATE_W,
                temperature_rate_k_s: TEMPERATURE_RATE_K_S,
                surface_residual_w: SURFACE_W,
                rule: "at the latest accepted IDA step at or after a checkpoint, every differential store has |dU/dt| < rate_w or |dU/dt| dT/dU < temperature_rate_k_s, from the laws at zero derivative, and every surface balance is under surface_residual_w; the first checkpoint where this holds ends the run, none by the last refuses",
            },
        },
        basis,
        carriers,
        helium,
        passive,
        sg_metal,
        steam_generators: generators,
        admission: Admission {
            fuel_domain_k: fuel_domain,
            fuel_surface_domain_k: FUEL_SURFACE_DOMAIN_K,
            clad_domain_k: CLAD_DOMAIN_K,
            nodes_checked,
            ordering: "inner >= outer >= fuel surface >= clad inner >= clad mean >= clad outer >= each contact's water; each helium between its halves' clad inners and fuel surfaces; T_sat < SG metal < SG primary",
            ordering_checked,
        },
        steady: Reached {
            reached_s,
            stores: o.stores,
            worst_rate_w: o.worst_rate.0,
            worst_rate_store: layout.labels[o.worst_rate.1].clone(),
            worst_temperature_rate_k_s: o.worst_temperature_rate.0,
            worst_temperature_rate_store: layout.labels[o.worst_temperature_rate.1].clone(),
            worst_surface_residual_w: o.worst_surface.0,
            worst_surface: layout.labels[o.worst_surface.1].clone(),
            clad_to_water_w: heat.clad_to_water_w.value,
            passive_to_water_w: heat.passive_to_water_w.value,
            stored_rate_w,
        },
        checkpoints: observed,
        ida: IdaStats {
            steps: stats.steps,
            residuals: stats.residuals,
            jacobians: stats.jacobians,
            nonlinear_iterations: stats.nonlinear_iterations,
            error_failures: stats.error_failures,
            convergence_failures: stats.convergence_failures,
            linear_setups: stats.linear_setups,
            last_order: stats.last_order,
            last_step_s: stats.last_step,
            jacobian_nonzeros,
        },
    };
    Ok(out)
}

/// The packet geometry as the thermal law's.
fn solids_geometry(
    g: &leitbild_operating_plant::joined::packet::Geometry,
) -> thermal::FuelGeometry {
    thermal::FuelGeometry {
        fuel_radius_m: g.fuel_radius_m,
        clad_inner_radius_m: g.clad_inner_radius_m,
        clad_outer_radius_m: g.clad_outer_radius_m,
        rod_length_m: g.rod_length_m,
        rods: g.rods,
        helium_volume_m3: g.helium_volume_m3,
        helium_nr_j_k: g.helium_nr_j_k,
        accommodation: g.accommodation,
        fuel_emissivity: g.fuel_emissivity,
        clad_emissivity: g.clad_emissivity,
    }
}

/// This process's CPU time (s), for stderr only.
fn cpu_seconds() -> f64 {
    // `std` exposes no process CPU clock; wall time would be wrong under
    // load, so read getrusage through libc's stable C ABI.
    #[repr(C)]
    struct Timeval {
        sec: i64,
        usec: i64,
    }
    #[repr(C)]
    struct Rusage {
        user: Timeval,
        system: Timeval,
        rest: [i64; 14],
    }
    unsafe extern "C" {
        fn getrusage(who: i32, usage: *mut Rusage) -> i32;
    }
    let mut u = Rusage {
        user: Timeval { sec: 0, usec: 0 },
        system: Timeval { sec: 0, usec: 0 },
        rest: [0; 14],
    };
    // SAFETY: RUSAGE_SELF (0) into a correctly sized, owned struct.
    if unsafe { getrusage(0, &mut u) } != 0 {
        return f64::NAN;
    }
    let t = |v: &Timeval| v.sec as f64 + v.usec as f64 * 1e-6;
    t(&u.user) + t(&u.system)
}

fn main() {
    match run() {
        Ok(out) => {
            let text = match serde_json::to_string(&out) {
                Ok(t) if !t.contains("null") => t,
                Ok(_) => {
                    eprintln!("prepare_steady_solids refused: a non-finite output value");
                    std::process::exit(1);
                }
                Err(e) => {
                    eprintln!("prepare_steady_solids refused: {e}");
                    std::process::exit(1);
                }
            };
            let mut stdout = io::stdout().lock();
            if stdout
                .write_all(text.as_bytes())
                .and_then(|()| stdout.write_all(b"\n"))
                .is_err()
            {
                std::process::exit(2);
            }
        }
        Err(e) => {
            eprintln!("prepare_steady_solids refused: {e}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_criterion_admits_a_store_by_either_screen() {
        let fuel = 1. / 4.8e4; // K/J of a ~145 kg UO2 node
        assert!(store_passes(StoreRate {
            rate_w: 9e-4,
            temperature_per_energy: fuel
        }));
        // 0.04 W on 4.8e4 J/K is 8.3e-7 K/s: passes by temperature rate.
        assert!(store_passes(StoreRate {
            rate_w: -0.04,
            temperature_per_energy: fuel
        }));
        assert!(!store_passes(StoreRate {
            rate_w: 0.05,
            temperature_per_energy: fuel
        }));
        // SG metal, 3.75e7 J/K: 30 W is 8e-7 K/s.
        let metal = 1. / 3.75e7;
        assert!(store_passes(StoreRate {
            rate_w: 30.,
            temperature_per_energy: metal
        }));
        assert!(!store_passes(StoreRate {
            rate_w: 40.,
            temperature_per_energy: metal
        }));
        assert!(!store_passes(StoreRate {
            rate_w: f64::NAN,
            temperature_per_energy: metal
        }));
    }

    #[test]
    fn checkpoints_are_declared_powers_of_two() {
        let c = checkpoints();
        assert_eq!(c.len(), CHECKPOINTS);
        assert_eq!(c[0], 1.);
        assert_eq!(c[CHECKPOINTS - 1], 131_072.);
        assert!(c.windows(2).all(|w| w[1] == 2. * w[0]));
    }

    /// The receipt's gap lengths reproduce the gap law's own transfer: the
    /// conduction across the gap at any temperatures equals
    /// 2 (T_s - T_he) / ((width + jump) / (A_f k_he)).
    #[test]
    fn gap_lengths_match_the_gap_law() {
        let g = thermal::FuelGeometry {
            fuel_radius_m: 0.004096,
            clad_inner_radius_m: 0.004180,
            clad_outer_radius_m: 0.004750,
            rod_length_m: 1.83,
            rods: 264.,
            helium_volume_m3: 0.00582,
            helium_nr_j_k: 38.8,
            accommodation: 0.2755,
            fuel_emissivity: 0.8,
            clad_emissivity: 0.8,
        };
        for (ts, th, tci) in [(700., 660., 620.), (800., 700., 640.), (650., 640., 600.)] {
            let t = thermal::FuelTemperatures {
                inner_mean: s(1100.),
                outer_mean: s(900.),
                fuel_surface: s(ts),
                helium: s(th),
                clad_inner: s(tci),
                clad_mean: s(610.),
                clad_outer: s(600.),
            };
            let q = thermal::fuel_transfers(&g, t, s(0.)).unwrap();
            let (width, jump, k) = gap_lengths(&g, th);
            let area = 2. * std::f64::consts::PI * g.fuel_radius_m * g.rod_length_m * g.rods;
            let own = 2. * (ts - th) / ((width + jump) / (area * k));
            let rel = (own - q.surface_to_helium.value).abs() / q.surface_to_helium.value.abs();
            assert!(
                rel < 1e-12,
                "gap law {} against {own}: {rel:e}",
                q.surface_to_helium.value
            );
            assert!(jump > 0. && jump < width);
        }
    }

    /// The packet named by `LD01_OPERATING_HOT_SPINE_PACKET` with a steady
    /// section at its own source total and fixed trial fluxes.
    fn packet_input() -> serde_json::Value {
        let path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET")
            .expect("LD01_OPERATING_HOT_SPINE_PACKET");
        let mut raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).expect("packet")).expect("packet json");
        let total = raw["thermal"]["source_total_w"]
            .as_f64()
            .expect("source total");
        let ids: Vec<serde_json::Value> = raw["thermal"]["secondaries"]
            .as_array()
            .expect("secondaries")
            .iter()
            .map(|g| serde_json::json!({"id": g["id"], "massFlux_kg_m2_s": 6972.5}))
            .collect();
        raw["steady"] = serde_json::json!({"basisPower_W": total,
            "coreMassFlux_kg_m2_s": 3725.0, "sgPrimaryMassFlux_kg_m2_s": ids});
        raw
    }

    /// Every CSC column of the stock-IDA Jacobian (the column's closed
    /// scope, `Solids::rows_local`) equals the full evaluation seeded on
    /// that column bitwise inside its pattern, and the full evaluation's
    /// direction is exactly zero outside it.
    #[test]
    #[ignore = "requires LD01_OPERATING_HOT_SPINE_PACKET and the water library"]
    fn jacobian_columns_equal_the_full_evaluation() {
        let p = prepare(&packet_input()).expect("prepared");
        let mut system = p.system;
        let n = system.dimension();
        let nnz = system.nonzeros();
        let (mut data, mut rows, mut pointers) =
            (vec![0.; nnz], vec![0i64; nnz], vec![0i64; n + 1]);
        let cj = 3.7;
        system
            .jacobian(0., cj, &p.y, &p.yp, &mut data, &mut rows, &mut pointers)
            .expect("jacobian");
        assert_eq!(pointers[n] as usize, nnz);
        let mut seed = vec![0.; n];
        let mut temperatures = solids::Temperatures::default();
        let mut full = vec![s(0.); n];
        let mut sink = vec![[[s(0.); 3]; 2]; system.points.len()];
        let mut heat = solids::Heat::default();
        let (mut inside, mut outside) = (0usize, 0usize);
        for j in 0..n {
            seed[j] = 1.;
            let x = Coordinates::new(&p.y, &p.yp, Some(&seed), cj, &system.scales).unwrap();
            system.solids.temperatures(x, &mut temperatures).unwrap();
            let fluid = frozen_fluid(&system.points);
            system
                .solids
                .rows(
                    &If97,
                    x,
                    &temperatures,
                    &system.fuel_w,
                    &fluid,
                    &system.views,
                    &mut Receipts::new(&mut sink),
                    &mut full,
                    &mut heat,
                )
                .unwrap();
            seed[j] = 0.;
            let (a, b) = (pointers[j] as usize, pointers[j + 1] as usize);
            let pattern: Vec<usize> = rows[a..b].iter().map(|r| *r as usize).collect();
            for (i, v) in full.iter().enumerate() {
                let d = v.direction / system.row_scales[i];
                match pattern.binary_search(&i) {
                    Ok(k) => {
                        assert_eq!(
                            data[a + k].to_bits(),
                            d.to_bits(),
                            "column {j} row {i}: {} against {d}",
                            data[a + k]
                        );
                        inside += 1;
                    }
                    Err(_) => {
                        assert_eq!(d, 0., "column {j} row {i} outside the pattern: {d}");
                        outside += 1;
                    }
                }
            }
        }
        assert_eq!(inside, nnz);
        eprintln!("{n} columns, {nnz} pattern entries bitwise, {outside} zeros outside");
    }

    /// Two settles of the same input give the same document, byte for
    /// byte; the criterion, the admission and the SG ordering hold.
    #[test]
    #[ignore = "requires LD01_OPERATING_HOT_SPINE_PACKET and the SUNDIALS build"]
    fn the_settle_is_deterministic_and_meets_its_criterion() {
        let raw = packet_input();
        let a = serde_json::to_string(&settle(prepare(&raw).unwrap()).unwrap()).unwrap();
        let b = serde_json::to_string(&settle(prepare(&raw).unwrap()).unwrap()).unwrap();
        assert_eq!(a, b);
        let out: serde_json::Value = serde_json::from_str(&a).unwrap();
        let steady = &out["steady"];
        assert!(steady["worst_surface_residual_w"].as_f64().unwrap() < SURFACE_W);
        assert!(out["checkpoints"].as_array().unwrap().last().unwrap()["failing_stores"] == 0);
        for c in out["carriers"].as_array().unwrap() {
            let d = c["doppler_reference_k"].as_f64().unwrap();
            let [inner, outer] = [0, 1].map(|k| c["fuel_temperatures_k"][k].as_f64().unwrap());
            assert!(outer < d && d < inner);
        }
        for g in out["steam_generators"].as_array().unwrap() {
            let [lo, hi] = [0, 1].map(|k| g["metal_temperature_k"][k].as_f64().unwrap());
            assert!(g["saturation_k"].as_f64().unwrap() < lo);
            assert!(hi < g["primary_temperature_k"].as_f64().unwrap());
            let (i, o) = (
                g["primary_to_metal_w"].as_f64().unwrap(),
                g["metal_to_secondary_w"].as_f64().unwrap(),
            );
            // Four segments, each within the metal's temperature-rate screen.
            assert!((i - o).abs() < 4. * TEMPERATURE_RATE_K_S * 3.75e7);
        }
    }

    /// The declared basis, the SG flux ids and the steady section refuse
    /// visibly.
    #[test]
    #[ignore = "requires LD01_OPERATING_HOT_SPINE_PACKET and the water library"]
    fn the_preparation_refuses_inconsistent_inputs() {
        let refuse = |raw: &serde_json::Value, needle: &str| {
            let e = prepare(raw).err().expect("refused").to_string();
            assert!(e.contains(needle), "{e}");
        };
        let mut raw = packet_input();
        let total = raw["steady"]["basisPower_W"].as_f64().unwrap();
        raw["steady"]["basisPower_W"] = serde_json::json!(total * 1.0021);
        refuse(&raw, "declared basis");
        let mut raw = packet_input();
        raw["steady"]["sgPrimaryMassFlux_kg_m2_s"][0]["id"] = serde_json::json!("B");
        refuse(&raw, "thermal.secondaries id");
        let mut raw = packet_input();
        raw["steady"]["coreMassFlux_kg_m2_s"] = serde_json::json!(-1.);
        refuse(&raw, "coreMassFlux");
        let mut raw = packet_input();
        raw.as_object_mut().unwrap().remove("steady");
        refuse(&raw, "no `steady` section");
        let mut raw = packet_input();
        raw["steady"]["extra"] = serde_json::json!(1);
        refuse(&raw, "unknown field");
    }
}
