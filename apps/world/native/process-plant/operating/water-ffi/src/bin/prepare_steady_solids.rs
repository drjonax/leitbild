//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-reference.md#steady-solid-state-at-the-reference-power
//! The steady solid state at the reference power (G18), a preparation step.
//!
//! Reads one provisional spine packet on stdin, with the SG owner's contact
//! record under `secondary` and `steady.coreMassFlux_kg_m2_s`, the core
//! walls' uniform mass flux from the preparation's enthalpy reference flow.
//! Its solid stocks are only Newton's seed. For every fuel assembly group
//! (both halves' fuel nodes, clad and surfaces, the shared helium, the
//! plenum and passive stores) it solves every solid energy rate equal to
//! zero with every surface constraint, using the joined solids' own laws
//! (`joined::solids`) and maintained IF97, at:
//! - each carrier's fuel heat from the joined nuclear block at the prepared
//!   nuclear state (the same code and inputs as the joined start);
//! - the prepared coolant cells of the packet's thermal section (pressure,
//!   liquid at its temperature, IF97), the core walls at the uniform flux.
//!
//! The solve is a safeguarded Newton per group on the laws' own seeded
//! directions (one dense LU per iteration). Any non-convergence, domain exit
//! or non-finite value refuses with a nonzero exit and writes nothing. On
//! success it writes one JSON document on stdout: every store's steady
//! temperature and energy, every half's steady surfaces, every carrier's
//! Doppler reference `[mean(sqrt T_inner, sqrt T_outer)]^2`, and per group its
//! Newton iterations and final scaled residual. Deterministic: one thread,
//! a fixed group order and no clock in the output.
use leitbild_operating_plant::{
    joined::{
        block::{Coordinates, Fluid, Receipts, SecondaryView},
        nuclear::{self, Nuclear, RegionWater},
        packet::Packet,
        solids::{self, Solids, WallWater},
    },
    network::{Properties, Water},
    thermal::{self, Scalar, WaterProperties},
};
use leitbild_operating_water::If97;
use std::io::{self, Read, Write};

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}

type Failure = Box<dyn std::error::Error>;

/// A network-side refusal as this binary's error, with its kind.
fn nf(e: leitbild_operating_plant::network::Failure) -> Failure {
    format!("{e:?}").into()
}

/// Newton's acceptance on the scaled rows and its iteration bound.
const TOLERANCE: f64 = 1e-12;
const ITERATIONS: usize = 60;
const BACKTRACKS: usize = 40;

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

/// Dense LU with partial pivoting, solving `a x = b` in place of `b`.
fn solve(n: usize, a: &mut [f64], b: &mut [f64]) -> Result<(), Failure> {
    for k in 0..n {
        let (p, big) = (k..n)
            .map(|i| (i, a[i * n + k].abs()))
            .fold((k, -1.), |m, v| if v.1 > m.1 { v } else { m });
        if !(big > 0. && big.is_finite()) {
            return Err(format!("singular steady Jacobian at column {k}").into());
        }
        if p != k {
            for j in 0..n {
                a.swap(k * n + j, p * n + j);
            }
            b.swap(k, p);
        }
        for i in k + 1..n {
            let f = a[i * n + k] / a[k * n + k];
            if f != 0. {
                for j in k..n {
                    a[i * n + j] -= f * a[k * n + j];
                }
                b[i] -= f * b[k];
            }
        }
    }
    for k in (0..n).rev() {
        let mut v = b[k];
        for j in k + 1..n {
            v -= a[k * n + j] * b[j];
        }
        b[k] = v / a[k * n + k];
    }
    if b.iter().any(|v| !v.is_finite()) {
        return Err("non-finite steady Newton step".into());
    }
    Ok(())
}

struct Problem<'a> {
    solids: Solids,
    fluid: Fluid<'a>,
    fuel_w: Vec<Scalar>,
    views: Vec<SecondaryView>,
    scales: Vec<f64>,
    row_scales: Vec<f64>,
    temperatures: solids::Temperatures,
    sink: Vec<[[Scalar; 3]; 2]>,
    rows: Vec<(usize, Scalar)>,
    heat: solids::Heat,
    seed: Vec<f64>,
    zero: Vec<f64>,
}

impl Problem<'_> {
    /// The group's scaled rows at `y`, with the column of `seed` (when given)
    /// as their directions.
    fn rows(
        &mut self,
        y: &[f64],
        closed: &solids::Closed,
        stores: &[usize],
        seed: Option<usize>,
    ) -> Result<Vec<(usize, Scalar)>, Failure> {
        if let Some(j) = seed {
            self.seed[j] = 1.;
        }
        let x = Coordinates::new(
            y,
            &self.zero,
            seed.map(|_| &self.seed[..]),
            0.,
            &self.scales,
        )
        .map_err(nf)?;
        let result = (|| -> Result<(), Failure> {
            self.solids
                .temperatures_local(x, stores, &mut self.temperatures)
                .map_err(nf)?;
            self.sink.fill([[s(0.); 3]; 2]);
            self.solids
                .rows_local(
                    &If97,
                    x,
                    &self.temperatures,
                    &self.fuel_w,
                    &self.fluid,
                    &self.views,
                    closed,
                    &mut Receipts::new(&mut self.sink),
                    &mut self.rows,
                    &mut self.heat,
                )
                .map_err(nf)?;
            Ok(())
        })();
        if let Some(j) = seed {
            self.seed[j] = 0.;
        }
        result?;
        let mut out: Vec<(usize, Scalar)> = self
            .rows
            .iter()
            .map(|(i, r)| (*i, *r / s(self.row_scales[*i])))
            .collect();
        out.sort_by_key(|(i, _)| *i);
        Ok(out)
    }
}

fn norm(rows: &[(usize, Scalar)]) -> f64 {
    rows.iter().map(|(_, r)| r.value.abs()).fold(0., f64::max)
}

fn run() -> Result<serde_json::Value, Failure> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let raw: serde_json::Value = serde_json::from_str(&input)?;
    let packet: Packet = serde_json::from_value(raw.clone())?;
    let flux = raw["steady"]["coreMassFlux_kg_m2_s"]
        .as_f64()
        .filter(|g| g.is_finite() && *g > 0.)
        .ok_or("steady.coreMassFlux_kg_m2_s must be a positive number")?;
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
    let fluid = Fluid {
        cells: &[],
        points: &points,
        liquid_mass: &[],
        vapor_mass: &[],
        tracer: &[],
        charts: &[],
        endpoints: &[],
        elevations: &[],
        volumes: &[],
        current_volumes: &[],
    };
    // The carriers' fuel heat at the prepared nuclear state: the joined
    // nuclear block's own rows (independent of the feedback temperatures).
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
    let seed_fuel: Vec<Scalar> = packet
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
            &seed_fuel,
            &region_water,
            &travel,
            &mut nrows,
            &mut nheat,
        )
        .map_err(nf)?;
    let fuel_w = nheat.fuel_w.clone();
    let mut solids = Solids::new(&packet, cells).map_err(nf)?;
    // Wall water: the core walls at the uniform flux; the solve reads no
    // other wall slot (the SG segments belong to no group).
    let mut core_cells: Vec<usize> = (0..solids.halves())
        .flat_map(|b| solids.incidence().halves[b].1.clone())
        .collect();
    core_cells.sort_unstable();
    core_cells.dedup();
    for &c in &core_cells {
        let w = &water[c];
        let p = s(w.pressure_pa);
        solids
            .set_wall_water(
                c,
                WallWater {
                    pressure: p,
                    temperature: s(w.temperature_k),
                    bulk: WaterProperties::liquid(&If97, p, s(w.temperature_k))?,
                    saturation: WaterProperties::saturation(&If97, p)?,
                    mass_flux: s(flux),
                },
            )
            .map_err(nf)?;
    }
    let views: Vec<SecondaryView> = packet
        .thermal
        .secondaries
        .iter()
        .map(|g| -> Result<SecondaryView, Failure> {
            let p = s(g.pressure_pa);
            Ok(SecondaryView {
                pressure: p,
                saturation_temperature: WaterProperties::saturation(&If97, p)?.temperature,
                liquid_volume: s(g.liquid_volume_m3),
                steam_present: true,
            })
        })
        .collect::<Result<_, _>>()?;
    let layout = solids.layout().clone();
    let n = layout.len();
    let mut y: Vec<f64> = solids
        .prepared()
        .iter()
        .zip(&layout.scales)
        .map(|(v, sc)| v / sc)
        .collect();
    let groups = solids.assembly_groups().map_err(nf)?;
    let mut problem = Problem {
        temperatures: solids::Temperatures::default(),
        solids,
        fluid,
        fuel_w,
        views,
        scales: layout.scales.clone(),
        row_scales: layout.row_scales.clone(),
        sink: vec![[[s(0.); 3]; 2]; cells],
        rows: Vec::new(),
        heat: solids::Heat::default(),
        seed: vec![0.; n],
        zero: vec![0.; n],
    };
    {
        let x = Coordinates::new(&y, &problem.zero, None, 0., &problem.scales).map_err(nf)?;
        problem
            .solids
            .temperatures(x, &mut problem.temperatures)
            .map_err(nf)?;
    }
    let stores_of = |own: &[usize], solids: &Solids| -> Vec<usize> {
        let surfaces = 3 * solids.halves()..6 * solids.halves();
        own.iter()
            .copied()
            .filter(|i| !surfaces.contains(i))
            .collect()
    };
    let mut report = Vec::with_capacity(groups.len());
    for (g, (closed, own)) in groups.iter().enumerate() {
        let stores = stores_of(own, &problem.solids);
        let m = own.len();
        let mut f = problem.rows(&y, closed, &stores, None)?;
        if f.len() != m || f.iter().zip(own).any(|((i, _), j)| i != j) {
            return Err(format!("group {g}'s rows are not its coordinates").into());
        }
        let mut iterations = 0;
        while norm(&f) > TOLERANCE {
            if iterations == ITERATIONS {
                return Err(format!(
                    "group {g} (first coordinate {}) did not converge in {ITERATIONS} iterations: residual {:e}",
                    layout.labels[own[0]],
                    norm(&f)
                )
                .into());
            }
            iterations += 1;
            let mut jac = vec![0.; m * m];
            for (c, &j) in own.iter().enumerate() {
                let col = problem.rows(&y, closed, &stores, Some(j))?;
                for (r, (_, v)) in col.iter().enumerate() {
                    jac[r * m + c] = v.direction;
                }
            }
            let mut step: Vec<f64> = f.iter().map(|(_, v)| -v.value).collect();
            solve(m, &mut jac, &mut step)?;
            let before = norm(&f);
            let mut lambda = 1.;
            let mut accepted = None;
            for _ in 0..BACKTRACKS {
                let mut trial = y.clone();
                for (c, &j) in own.iter().enumerate() {
                    trial[j] += lambda * step[c];
                }
                if let Ok(ft) = problem.rows(&trial, closed, &stores, None)
                    && norm(&ft).is_finite()
                    && (norm(&ft) < before || norm(&ft) <= TOLERANCE)
                {
                    accepted = Some((trial, ft));
                    break;
                }
                lambda *= 0.5;
            }
            let Some((trial, ft)) = accepted else {
                return Err(format!(
                    "group {g} (first coordinate {}): no decreasing step at residual {before:e}",
                    layout.labels[own[0]]
                )
                .into());
            };
            y = trial;
            f = ft;
        }
        // Keep the converged temperatures of this group for the next ones.
        let x = Coordinates::new(&y, &problem.zero, None, 0., &problem.scales).map_err(nf)?;
        problem
            .solids
            .temperatures_local(x, &stores, &mut problem.temperatures)
            .map_err(nf)?;
        report.push(
            serde_json::json!({"group": g, "first": layout.labels[own[0]], "coordinates": m,
            "iterations": iterations, "residual": norm(&f)}),
        );
    }
    // The full rows at the steady state, for the receipt.
    let all = problem.solids.close(&solids::SolidScope {
        bands: (0..problem.solids.halves()).collect(),
        ..solids::SolidScope::default()
    });
    let x = Coordinates::new(&y, &problem.zero, None, 0., &problem.scales).map_err(nf)?;
    let physical: Vec<f64> = y.iter().zip(&layout.scales).map(|(v, sc)| v * sc).collect();
    let mut temperatures = solids::Temperatures::default();
    problem
        .solids
        .temperatures(x, &mut temperatures)
        .map_err(nf)?;
    let steady_rows = problem.rows(
        &y,
        &all,
        &stores_of(&problem.solids.scope_coordinates(&all), &problem.solids),
        None,
    )?;
    let worst_rate_w = steady_rows
        .iter()
        .map(|(i, r)| (r.value * layout.row_scales[*i]).abs())
        .fold(0., f64::max);
    let halves = problem.solids.halves();
    let mut carriers = Vec::with_capacity(halves);
    for a in 0..halves {
        let [inner, outer, clad] = temperatures.fuel[a];
        let doppler = thermal::fuel_feedback_temperature(inner, outer)?;
        carriers.push(serde_json::json!({
            "fuel_temperatures_k": [inner.value, outer.value],
            "fuel_energies_j": [physical[problem.solids.energy(a, 0)], physical[problem.solids.energy(a, 1)]],
            "clad_temperature_k": clad.value,
            "clad_energy_j": physical[problem.solids.energy(a, 2)],
            "surface_temperatures_k": (0..3).map(|k| physical[problem.solids.surface(a, k)]).collect::<Vec<_>>(),
            "doppler_reference_k": doppler.value,
        }));
    }
    let helium: Vec<serde_json::Value> = temperatures
        .helium
        .iter()
        .enumerate()
        .map(|(h, t)| serde_json::json!({"temperature_k": t.value, "energy_j": physical[problem.solids.helium(h)]}))
        .collect();
    let passive: Vec<serde_json::Value> = temperatures
        .passive
        .iter()
        .enumerate()
        .map(|(p, t)| serde_json::json!({"temperature_k": t.value, "energy_j": physical[problem.solids.passive(p)]}))
        .collect();
    if carriers
        .iter()
        .chain(&helium)
        .chain(&passive)
        .any(|v| serde_json::to_string(v).map_or(true, |t| t.contains("null")))
    {
        return Err("non-finite steady solid value".into());
    }
    let iterations: Vec<usize> = report
        .iter()
        .map(|r| r["iterations"].as_u64().unwrap_or(0) as usize)
        .collect();
    Ok(serde_json::json!({
        "identity": "LD01-STEADY-SOLIDS-1",
        "basis": {"coreMassFlux_kg_m2_s": flux, "coolant": "the packet's prepared thermal water cells, IF97 liquid", "fuelHeat": "the joined nuclear block at the prepared nuclear state", "tolerance": TOLERANCE},
        "carriers": carriers,
        "helium": helium,
        "passive": passive,
        "groups": report.len(),
        "newton_iterations": {"min": iterations.iter().min(), "max": iterations.iter().max(), "total": iterations.iter().sum::<usize>()},
        "group_report": report,
        "worst_solid_rate_w": worst_rate_w,
        "fuel_heat_w": problem.fuel_w.iter().map(|v| v.value).sum::<f64>(),
    }))
}

fn main() {
    match run() {
        Ok(out) => {
            let text = serde_json::to_string(&out).expect("steady solids output");
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
