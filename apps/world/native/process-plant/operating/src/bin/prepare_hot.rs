//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-reference.md#same-package-native-consumption
//! One strict, once-per-preparation JSON boundary. This consumes the SAME
//! owner-generated parameters/stocks as the TypeScript package, not a second
//! Rust fixture. It evaluates equations and independent receipts, not time.
use leitbild_operating_plant::{capture, heat_history, kinetics, poisons};
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeSet;
use std::error::Error;
use std::io::{self, Read};
use std::time::Instant;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    identity: String,
    source: Source,
    energy: Energy,
    fluid: Fluid,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    regions: Vec<kinetics::RegionParameters>,
    materials: Vec<kinetics::MaterialParameters>,
    transfers: Vec<kinetics::Transfer>,
    supports: Vec<kinetics::Support>,
    inputs: OwnedInputs,
    stationary_state: Vec<f64>,
    prepared_state: Vec<f64>,
    exposure_per_population_s_m2: Vec<f64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OwnedInputs {
    regions: Vec<kinetics::RegionInput>,
    transfer_rates_per_s: Vec<f64>,
    fissions_per_population_s: Vec<f64>,
    emission_fractions: Vec<f64>,
    outside_fractions: Vec<f64>,
}
impl OwnedInputs {
    fn borrowed(&self) -> kinetics::Inputs<'_> {
        kinetics::Inputs {
            regions: &self.regions,
            transfer_rates_per_s: &self.transfer_rates_per_s,
            fissions_per_population_s: &self.fissions_per_population_s,
            emission_fractions: &self.emission_fractions,
            outside_fractions: &self.outside_fractions,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Group {
    decay_per_s: f64,
    retained_joules_per_event: f64,
}
impl Group {
    fn native(&self) -> heat_history::Group {
        heat_history::Group {
            decay_per_s: self.decay_per_s,
            retained_joules_per_event: self.retained_joules_per_event,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Energy {
    fission_joules_per_event: f64,
    fission_cross_section_m2: f64,
    fertile_cross_section_m2: f64,
    fertile_binding_joules_per_capture: f64,
    xenon_binding_joules_per_capture: f64,
    samarium_binding_joules_per_capture: f64,
    xenon_cross_section_m2: f64,
    samarium_cross_section_m2: f64,
    binding_coolant_fraction: f64,
    prompt_fission_coolant_fraction: f64,
    fission_groups: Vec<Group>,
    capture_groups: Vec<Group>,
    poison_decay_per_s: [f64; 3],
    poison_yields_per_fission: [f64; 4],
    carriers: Vec<Carrier>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Carrier {
    id: String,
    fuel_store_ids: [String; 2],
    fuel_node_fractions: [f64; 2],
    clad_store_id: String,
    original_fissile_atoms: f64,
    original_fertile_atoms: f64,
    fissile_atoms: f64,
    fertile_atoms: f64,
    spent_fissions: f64,
    capture_product_atoms: f64,
    expected_exposure_per_m2_s: f64,
    expected_fissions_per_s: f64,
    expected_fuel_w: f64,
    expected_coolant_w: f64,
    stores_j: Vec<f64>,
    poison_atoms: [f64; 4],
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fluid {
    primary_mass_kg: f64,
    primary_energy_j: f64,
    primary_volume_m3: f64,
    regions: Vec<FluidRegion>,
    solid_stores: Vec<Solid>,
    source_band_to_region: Vec<usize>,
    direct_coolant_projection: PressureProjection,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Edge {
    from: usize,
    to: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PressureProjection {
    heat_w: Vec<f64>,
    edges: Vec<Edge>,
    donors: Vec<usize>,
    flows_kg_s: Vec<f64>,
    pressure_rate_pa_s: f64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FluidRegion {
    id: String,
    volume_m3: f64,
    density_kg_m3: f64,
    pressure_pa: f64,
    enthalpy_j_kg: f64,
    specific_internal_energy_j_kg: f64,
    mass_kg: f64,
    energy_j: f64,
    mass_p_at_energy_kg_pa: f64,
    mass_energy_at_pressure_kg_j: f64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Solid {
    id: String,
    energy_j: f64,
    capacity_j_k: f64,
}
fn require(ok: bool, message: &str) -> Result<(), Box<dyn Error>> {
    if !ok {
        return Err(message.into());
    }
    Ok(())
}
fn close(a: f64, b: f64) -> bool {
    a.is_finite() && b.is_finite() && (a - b).abs() <= 5e-12 * a.abs().max(b.abs()).max(1e-100)
}
fn main() -> Result<(), Box<dyn Error>> {
    let mut bytes = String::new();
    io::stdin().read_to_string(&mut bytes)?;
    let input: Input = serde_json::from_str(&bytes)?;
    let started = Instant::now();
    require(
        input.identity == "LD01-HOT-PREPARATION-1",
        "Unknown preparation identity",
    )?;
    let mut s = input.source;
    let r = s.regions.len();
    let a = s.materials.len();
    require(r == 24 && a == 386, "Wrong authored source allocation")?;
    require(
        s.prepared_state.len() == r + 6 * a && s.stationary_state.len() == r + 6 * a,
        "Source state length",
    )?;
    require(
        s.exposure_per_population_s_m2.len() == s.supports.len(),
        "Exposure support length",
    )?;
    let mut exposure = vec![0.; a];
    for (edge, support) in s.supports.iter().enumerate() {
        require(
            support.region < r && support.material < a,
            "Invalid exposure support",
        )?;
        exposure[support.material] +=
            s.exposure_per_population_s_m2[edge] * s.prepared_state[support.region];
    }
    let reference_scale: f64 = s
        .regions
        .iter()
        .enumerate()
        .map(|(i, p)| s.stationary_state[i] / p.generation_time_s)
        .sum();
    let supports = s.supports.clone();
    let model = kinetics::Model::new(s.regions, s.materials, s.transfers, s.supports)?;
    require(
        s.prepared_state.len() == model.state_dimension(),
        "Prepared source state length",
    )?;
    model.validate_accepted_state(&s.prepared_state)?;
    model.validate_accepted_state(&s.stationary_state)?;
    model.validate_accepted_inputs(s.inputs.borrowed())?;
    let mut rates = vec![0.; model.state_dimension()];
    let mut fissions = vec![0.; a];
    let current = model.rates(
        &s.prepared_state,
        s.inputs.borrowed(),
        &mut rates,
        &mut fissions,
    )?;
    let prepared_nuclear_rate = rates[..r].iter().map(|v| v.abs()).fold(0., f64::max);
    let external_sources: Vec<_> = s
        .inputs
        .regions
        .iter()
        .map(|v| v.external_source_per_s)
        .collect();
    for region in &mut s.inputs.regions {
        region.external_source_per_s = 0.;
    }
    let mut reference_rates = vec![0.; model.state_dimension()];
    let mut reference_fissions = vec![0.; a];
    model.rates(
        &s.stationary_state,
        s.inputs.borrowed(),
        &mut reference_rates,
        &mut reference_fissions,
    )?;
    let reference_relative_residual =
        reference_rates.iter().map(|v| v.abs()).fold(0., f64::max) / reference_scale;
    require(
        reference_relative_residual < 1e-12,
        "Source-off stationary reference is not critical",
    )?;
    let e = input.energy;
    require(e.carriers.len() == a, "Wrong material count")?;
    require(
        e.carriers
            .iter()
            .map(|c| &c.id)
            .collect::<BTreeSet<_>>()
            .len()
            == a,
        "Duplicated material identity",
    )?;
    for (edge, support) in supports.iter().enumerate() {
        require(
            s.exposure_per_population_s_m2[edge].is_finite()
                && s.exposure_per_population_s_m2[edge] >= 0.,
            "Invalid exposure support coefficient",
        )?;
        require(
            close(
                s.inputs.fissions_per_population_s[edge],
                e.fission_cross_section_m2
                    * e.carriers[support.material].fissile_atoms
                    * s.exposure_per_population_s_m2[edge],
            ),
            "Fission/exposure target law differs on a support",
        )?;
    }
    let store_ids: BTreeSet<_> = input
        .fluid
        .solid_stores
        .iter()
        .map(|v| v.id.as_str())
        .collect();
    require(
        store_ids.len() == input.fluid.solid_stores.len(),
        "Duplicate solid energy owner",
    )?;
    require(
        e.carriers.len() == a && e.fission_groups.len() == 23 && e.capture_groups.len() == 2,
        "Wrong material/history allocation",
    )?;
    require(
        [
            e.binding_coolant_fraction,
            e.prompt_fission_coolant_fraction,
        ]
        .iter()
        .all(|x| x.is_finite() && (0. ..=1.).contains(x)),
        "Invalid deposition projection",
    )?;
    let fission_model = heat_history::Model::new(
        e.fission_joules_per_event,
        e.fission_groups.iter().map(Group::native).collect(),
    )?;
    let capture_model = heat_history::Model::new(
        e.capture_groups
            .iter()
            .map(|g| g.retained_joules_per_event)
            .sum(),
        e.capture_groups.iter().map(Group::native).collect(),
    )?;
    let capture = capture::Parameters {
        cross_section_m2: e.fertile_cross_section_m2,
        binding_joules_per_capture: e.fertile_binding_joules_per_capture,
    };
    let poison = poisons::Model::new(poisons::Parameters {
        decay_per_s: e.poison_decay_per_s,
        direct_atoms_per_fission: e.poison_yields_per_fission,
    })?;
    let mut fuel_w = 0.;
    let mut coolant_w = 0.;
    let mut history_rate_w = 0.;
    let mut event_budget_w = 0.;
    let mut fertile_captures = 0.;
    let mut material_coolant_w = vec![0.; a];
    let mut fission_out = [0.; 23];
    let mut capture_out = [0.; 2];
    let mut poison_out = [0.; 4];
    for (i, carrier) in e.carriers.iter().enumerate() {
        require(!carrier.id.is_empty(), "Empty material identity")?;
        require(
            [carrier.original_fissile_atoms, carrier.fissile_atoms]
                .iter()
                .all(|v| v.is_finite() && *v > 0.)
                && carrier.spent_fissions.is_finite()
                && carrier.spent_fissions >= 0.,
            "Invalid finite fission donor",
        )?;
        require(
            carrier.fuel_store_ids
                == [
                    format!("{}/fuel/0", carrier.id),
                    format!("{}/fuel/1", carrier.id),
                ]
                && carrier.clad_store_id == format!("{}/clad", carrier.id)
                && carrier
                    .fuel_store_ids
                    .iter()
                    .all(|id| store_ids.contains(id.as_str()))
                && store_ids.contains(carrier.clad_store_id.as_str()),
            "Material heat has no unique finite fuel/clad recipient",
        )?;
        require(
            carrier
                .fuel_node_fractions
                .iter()
                .all(|f| f.is_finite() && *f >= 0.)
                && close(carrier.fuel_node_fractions.iter().sum(), 1.),
            "Fuel power allocation is not a partition",
        )?;
        require(carrier.stores_j.len() == 25, "Energy history length")?;
        require(
            close(
                carrier.original_fissile_atoms,
                carrier.fissile_atoms + carrier.spent_fissions,
            ) && close(
                carrier.original_fertile_atoms,
                carrier.fertile_atoms + carrier.capture_product_atoms,
            ),
            "Finite preparation did not debit its donor",
        )?;
        require(
            close(exposure[i], carrier.expected_exposure_per_m2_s)
                && close(fissions[i], carrier.expected_fissions_per_s),
            "Nuclear/material exposure or fission receipt differs",
        )?;
        capture::validate_accepted(
            carrier.fertile_atoms,
            carrier.capture_product_atoms,
            exposure[i],
        )?;
        let captured = capture.rates(carrier.fertile_atoms, exposure[i])?;
        fertile_captures += captured.captures_per_s;
        fission_model.validate_accepted_state(&carrier.stores_j[..23])?;
        capture_model.validate_accepted_state(&carrier.stores_j[23..])?;
        fission_model.validate_accepted_input(fissions[i])?;
        capture_model.validate_accepted_input(captured.captures_per_s)?;
        let f = fission_model.rates(&carrier.stores_j[..23], fissions[i], &mut fission_out)?;
        let c = capture_model.rates(
            &carrier.stores_j[23..],
            captured.captures_per_s,
            &mut capture_out,
        )?;
        poison.validate_accepted_state(&carrier.poison_atoms)?;
        let pi = poisons::Input {
            fissions_per_s: fissions[i],
            capture_per_s: [
                0.,
                e.xenon_cross_section_m2 * exposure[i],
                0.,
                e.samarium_cross_section_m2 * exposure[i],
            ],
        };
        poison.validate_accepted_input(pi)?;
        poison.rates(&carrier.poison_atoms, pi, &mut poison_out)?;
        let binding = captured.binding_w
            + e.xenon_binding_joules_per_capture * pi.capture_per_s[1] * carrier.poison_atoms[1]
            + e.samarium_binding_joules_per_capture * pi.capture_per_s[3] * carrier.poison_atoms[3];
        let fw = (1. - e.prompt_fission_coolant_fraction) * f.prompt_w
            + f.delayed_w
            + c.delayed_w
            + (1. - e.binding_coolant_fraction) * binding;
        let cw =
            e.prompt_fission_coolant_fraction * f.prompt_w + e.binding_coolant_fraction * binding;
        require(
            close(fw, carrier.expected_fuel_w) && close(cw, carrier.expected_coolant_w),
            "Native heat recipients differ from actual owner package",
        )?;
        fuel_w += fw;
        coolant_w += cw;
        material_coolant_w[i] = cw;
        history_rate_w += fission_out.iter().chain(&capture_out).sum::<f64>();
        event_budget_w += e.fission_joules_per_event * fissions[i] + c.retained_input_w + binding;
    }
    require(
        close(event_budget_w, fuel_w + coolant_w + history_rate_w),
        "Native actual event-energy ledger does not close",
    )?;
    let fluid = input.fluid;
    require(
        fluid.regions.len() == 26
            && fluid
                .regions
                .iter()
                .map(|r| &r.id)
                .collect::<BTreeSet<_>>()
                .len()
                == 26,
        "Wrong or duplicate primary territories",
    )?;
    let mut mass = 0.;
    let mut energy = 0.;
    let mut volume = 0.;
    let mut pressure_capacity = 0.;
    for region in &fluid.regions {
        require(
            !region.id.is_empty() && region.volume_m3 > 0. && region.density_kg_m3 > 0.,
            "Invalid fluid territory",
        )?;
        require(
            close(region.mass_kg, region.volume_m3 * region.density_kg_m3)
                && close(
                    region.energy_j,
                    region.mass_kg * region.specific_internal_energy_j_kg,
                ),
            "Finite hot water stock does not close",
        )?;
        require(
            close(
                region.enthalpy_j_kg,
                region.specific_internal_energy_j_kg + region.pressure_pa / region.density_kg_m3,
            ),
            "Fluid enthalpy/work convention differs",
        )?;
        require(
            region.mass_p_at_energy_kg_pa.is_finite()
                && region.mass_energy_at_pressure_kg_j.is_finite(),
            "Invalid pressure chart",
        )?;
        mass += region.mass_kg;
        energy += region.energy_j;
        volume += region.volume_m3;
        pressure_capacity += region.mass_p_at_energy_kg_pa;
    }
    require(
        close(mass, fluid.primary_mass_kg)
            && close(energy, fluid.primary_energy_j)
            && close(volume, fluid.primary_volume_m3),
        "Primary aggregate stocks differ",
    )?;
    require(
        pressure_capacity.is_finite() && pressure_capacity != 0.,
        "Singular aggregate inventory pressure",
    )?;
    require(
        !fluid.solid_stores.is_empty()
            && fluid.solid_stores.iter().all(|v| {
                !v.id.is_empty()
                    && v.energy_j.is_finite()
                    && v.capacity_j_k.is_finite()
                    && v.capacity_j_k > 0.
            }),
        "Missing finite solid heat recipient",
    )?;
    let projection = fluid.direct_coolant_projection;
    let n = fluid.regions.len();
    require(
        fluid.source_band_to_region.len() == r
            && fluid.source_band_to_region.iter().all(|i| *i < n)
            && projection.heat_w.len() == n
            && projection.edges.len() == projection.flows_kg_s.len()
            && projection.edges.len() == projection.donors.len()
            && projection.pressure_rate_pa_s.is_finite(),
        "Pressure preparation length or value",
    )?;
    let mut projected_heat = vec![0.; n];
    for (edge, support) in supports.iter().enumerate() {
        projected_heat[fluid.source_band_to_region[support.region]] +=
            material_coolant_w[support.material] * s.inputs.emission_fractions[edge];
    }
    require(
        projected_heat
            .iter()
            .zip(&projection.heat_w)
            .all(|(a, b)| close(*a, *b)),
        "Pressure preparation did not consume actual direct coolant heat",
    )?;
    let mut mass_rates = vec![0.; n];
    let mut energy_rates = projection.heat_w.clone();
    for (i, edge) in projection.edges.iter().enumerate() {
        require(
            edge.from < n && edge.to < n && edge.from != edge.to,
            "Invalid pressure continuity edge",
        )?;
        let q = projection.flows_kg_s[i];
        let donor = projection.donors[i];
        require(
            q.is_finite()
                && (donor == edge.from || donor == edge.to)
                && (q == 0. || donor == if q > 0. { edge.from } else { edge.to }),
            "Pressure preparation is off its donor branch",
        )?;
        let heat = q * fluid.regions[donor].enthalpy_j_kg;
        mass_rates[edge.from] -= q;
        mass_rates[edge.to] += q;
        energy_rates[edge.from] -= heat;
        energy_rates[edge.to] += heat;
    }
    let mut pressure_constraint_defect: f64 = 0.;
    for (i, region) in fluid.regions.iter().enumerate() {
        let lhs = region.mass_p_at_energy_kg_pa * projection.pressure_rate_pa_s
            + region.mass_energy_at_pressure_kg_j * energy_rates[i];
        let defect = (lhs - mass_rates[i]).abs();
        require(
            defect <= 1e-9 * lhs.abs().max(mass_rates[i].abs()).max(1.),
            "Actual hot differentiated volume/continuity constraint fails",
        )?;
        pressure_constraint_defect = pressure_constraint_defect.max(defect);
    }
    require(
        close(energy_rates.iter().sum(), coolant_w) && mass_rates.iter().sum::<f64>().abs() < 1e-10,
        "Partial pressure preparation mass/energy ledger fails",
    )?;
    println!(
        "{}",
        json!({
            "identity": input.identity, "native_equation_evaluation_seconds": started.elapsed().as_secs_f64(),
            "source_states": model.state_dimension(), "material_energy_stores": 25*a,
            "source_fixed_input_jacobian_nonzeros": model.structural_state_jacobian_nonzeros(),
            "source_off_stationary_relative_residual": reference_relative_residual,
            "prepared_max_abs_nuclear_rate_per_s": prepared_nuclear_rate,
            "actual_external_source_per_s": external_sources.iter().sum::<f64>(),
            "delayed_neutron_export_per_s": current.delayed_export_per_s,
            "actual_fissions_per_s": fissions.iter().sum::<f64>(), "actual_fertile_captures_per_s": fertile_captures,
            "actual_fuel_w": fuel_w, "actual_coolant_w": coolant_w, "history_inventory_rate_w": history_rate_w,
            "event_energy_balance_w": event_budget_w-fuel_w-coolant_w-history_rate_w,
            "finite_primary_mass_kg": mass, "finite_primary_energy_j": energy,
            "aggregate_mass_p_at_energy_kg_pa": pressure_capacity, "finite_solid_stores": fluid.solid_stores.len(),
            "partial_direct_coolant_pressure_rate_pa_s": projection.pressure_rate_pa_s,
            "partial_pressure_constraint_defect_kg_s": pressure_constraint_defect,
            "checks": ["actual source inputs/states admitted", "source-off stationary comparator", "finite donors debited",
              "one exposure feeds fission and capture", "23+2 native energy histories", "actual poison rates", "finite heat recipient sums",
              "native event-energy identity", "finite IF97 water stocks", "nonsingular aggregate pressure chart", "positive solid capacity"],
            "scope": "One actual prepared package evaluated by native equations; no time integration, connected hot balance, full index-1 admission or plant throughput."
        })
    );
    Ok(())
}
