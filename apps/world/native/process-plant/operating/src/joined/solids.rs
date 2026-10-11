//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-thermal.md#two-node-fuel-finite-helium-and-clad
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-thermal.md#actual-rod-and-passive-contacts
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-thermal.md#finite-steam-generators
//! The joined spine's finite solids: two fuel nodes and one clad energy per
//! material half, three massless surfaces per half, one sealed helium store
//! per assembly, the guide/plenum/fitting Zircaloy stores and the SG metal.
//!
//! Energies are the retained differential coordinates. Each solid's
//! temperature is eliminated by the exact local inverse of its own reviewed
//! caloric law (helium `1.5 nR T`, Zircaloy's piecewise quadratic, UO2 by a
//! safeguarded scalar Newton, SG metal `C (T - 273.15)`), which the
//! computational review permits for a well-conditioned inverse (§4.1). The
//! surfaces stay algebraic coordinates with their three heat balances: no
//! nested surface solve. Water state, saturation and wall mass flux come
//! from the network's own evaluation; every heat has one donor and one
//! recipient, and the water receives its heat through the network's single
//! liquid enthalpy port. The thermal laws are the retired hot spine's.
use super::{
    block::{Class, Coordinates, Fluid, Layout, Receipts, SecondaryView},
    packet::Packet,
};
use crate::{
    initialization,
    network::{Failure, Water},
    thermal::{self, Saturation, Scalar, WaterPoint, WaterProperties},
};

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("joined solids: {}", reason.into()))
}
fn trial(reason: impl std::fmt::Display) -> Failure {
    Failure::Recoverable(format!("joined solids: {reason}"))
}

/// One wet clad contact of a material half.
#[derive(Clone, Copy, Debug)]
struct Contact {
    water: usize,
    area: f64,
    diameter: f64,
}
#[derive(Clone, Debug)]
struct Band {
    geometry: thermal::FuelGeometry,
    helium: usize,
    fuel_mass: [f64; 2],
    clad_mass: f64,
    clad_density: f64,
    contacts: Vec<Contact>,
}
#[derive(Clone, Copy, Debug)]
struct Passive {
    solid: usize,
    water: usize,
    area: f64,
    liquid_h: f64,
    log_radius: f64,
}
#[derive(Clone, Copy, Debug)]
struct Plenum {
    helium: usize,
    solid: usize,
    area: f64,
    radius: f64,
    factor: f64,
}
#[derive(Clone, Copy, Debug)]
struct Segment {
    primary: usize,
    secondary: usize,
    start: f64,
    end: f64,
    area: f64,
    diameter: f64,
    capacity: f64,
}

/// The current water a wall contact sees, from the network's same call.
#[derive(Clone, Copy, Debug)]
pub struct WallWater {
    pub pressure: Scalar,
    pub temperature: Scalar,
    pub bulk: WaterPoint,
    pub saturation: Saturation,
    /// `sum(0.5 * liquid mass flow)` over incident faces over the main flow
    /// area, kg/(m2 s) (operating-thermal.md, actual rod contacts).
    pub mass_flux: Scalar,
}

/// The split of a half's fuel deposition between its two equal-area and
/// equal-mass radial fuel nodes, inner then outer (heat-and-history.md:
/// each node receives half of the carrier's fuel deposition). It enters
/// only the two fuel energy rows, as `-split * fuel_w`; nothing else in the
/// solids reads the fuel heat.
pub const FUEL_HEAT_SPLIT: [f64; 2] = [0.5, 0.5];

/// One wall slot's reads and the solid elements reading it
/// ([`Solids::wall_reads`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WallRead {
    pub cell: usize,
    pub faces: Vec<usize>,
    pub halves: Vec<usize>,
    pub segments: Vec<usize>,
}

/// Wall water a local refresh replaced: (slot, previous water).
#[must_use = "restore the replaced wall water after the local call"]
#[derive(Debug)]
pub struct ReplacedWall(Vec<(usize, Option<WallWater>)>);

/// Elements of one local evaluation, by index: core halves, passive
/// contacts, plenum contacts and SG segments.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SolidScope {
    pub bands: Vec<usize>,
    pub passive: Vec<usize>,
    pub plenum: Vec<usize>,
    pub segments: Vec<usize>,
}

/// A scope closed over incidence ([`Solids::close`]), with the stores and
/// SGs whose rows and heats it completes; every list is ascending.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Closed {
    pub bands: Vec<usize>,
    pub passive: Vec<usize>,
    pub plenum: Vec<usize>,
    pub segments: Vec<usize>,
    pub helium: Vec<usize>,
    pub stores: Vec<usize>,
    pub generators: Vec<usize>,
}

/// Structural incidence of the solids, for the joined sparse pattern.
#[derive(Clone, Debug, Default)]
pub struct Incidence {
    /// Per material half: its helium store and the cells its clad wets.
    pub halves: Vec<(usize, Vec<usize>)>,
    /// Passive contacts: (passive store, water cell).
    pub passive: Vec<(usize, usize)>,
    /// Plenum contacts: (helium store, passive store).
    pub plenum: Vec<(usize, usize)>,
    /// SG segments: (primary water cell, secondary).
    pub segments: Vec<(usize, usize)>,
}

/// A wall's water with every direction removed: the startup initializer's
/// closure may seed only the clad-outer temperature.
#[derive(Clone, Copy, Debug)]
struct WaterWall {
    pressure: Scalar,
    temperature: Scalar,
    bulk: WaterPoint,
    saturation: Saturation,
    mass_flux: Scalar,
}
impl WaterWall {
    fn of(w: WallWater) -> Self {
        let p = |q: WaterPoint| WaterPoint {
            density: s(q.density.value),
            viscosity: s(q.viscosity.value),
            conductivity: s(q.conductivity.value),
            cp: s(q.cp.value),
            expansion: s(q.expansion.value),
            enthalpy: s(q.enthalpy.value),
        };
        Self {
            pressure: s(w.pressure.value),
            temperature: s(w.temperature.value),
            bulk: p(w.bulk),
            saturation: Saturation {
                temperature: s(w.saturation.temperature.value),
                liquid: p(w.saturation.liquid),
                vapor: p(w.saturation.vapor),
                surface_tension: s(w.saturation.surface_tension.value),
            },
            mass_flux: s(w.mass_flux.value),
        }
    }
}

/// Temperatures recovered from the current energies.
#[derive(Clone, Debug, Default)]
pub struct Temperatures {
    /// Per material half: inner fuel, outer fuel, clad mean.
    pub fuel: Vec<[Scalar; 3]>,
    pub helium: Vec<Scalar>,
    pub passive: Vec<Scalar>,
    pub metal: Vec<Scalar>,
}

/// Heats of the last evaluation, for receipts and conservation checks.
#[derive(Clone, Debug, Default)]
pub struct Heat {
    /// Per SG: metal to secondary (W).
    pub secondary_w: Vec<Scalar>,
    /// Per SG segment: primary water to metal (W).
    pub primary_to_metal_w: Vec<Scalar>,
    /// Clad to water summed over every core contact (W).
    pub clad_to_water_w: Scalar,
    /// Passive Zircaloy to water summed over every contact (W).
    pub passive_to_water_w: Scalar,
    /// Sum of every solid energy rate (W).
    pub stored_rate_w: Scalar,
}

pub struct Solids {
    layout: Layout,
    prepared: Vec<f64>,
    bands: Vec<Band>,
    helium_nr: Vec<f64>,
    passive_mass: Vec<f64>,
    passive: Vec<Passive>,
    plenum: Vec<Plenum>,
    segments: Vec<Segment>,
    secondaries: usize,
    flow_area: Vec<f64>,
    /// Cells with a wall law reading saturation and mass flux.
    wall_cells: Vec<usize>,
    /// Per network regular cell: its index in `wall_cells`, if any.
    wall_slot: Vec<Option<usize>>,
    wall: Vec<Option<WallWater>>,
    helium_rate: Vec<Scalar>,
    passive_rate: Vec<Scalar>,
    passive_ids: Vec<String>,
    /// Every element: the full evaluation's scope.
    all: Closed,
    /// The SG tube steel (`ld01-sg-contact`).
    steel: thermal::SteelContact,
    /// Structural incidence and its inverse, compiled once.
    incidence: Incidence,
    inverse: Inverse,
}

/// The inverse of [`Incidence`], each list ascending: for local scopes in
/// time proportional to the scope rather than to every element.
#[derive(Clone, Debug, Default)]
struct Inverse {
    /// Per helium store: the halves on it and its plenum contacts.
    helium_bands: Vec<Vec<usize>>,
    helium_plenum: Vec<Vec<usize>>,
    /// Per passive store: its plenum contacts and passive contacts.
    store_plenum: Vec<Vec<usize>>,
    store_passive: Vec<Vec<usize>>,
    /// Per SG: its segments.
    generator_segments: Vec<Vec<usize>>,
    /// Per network regular cell: the halves its water wets, its passive
    /// contacts and the SG segments whose primary it is.
    cell_bands: Vec<Vec<usize>>,
    cell_passive: Vec<Vec<usize>>,
    cell_segments: Vec<Vec<usize>>,
}

impl Solids {
    /// Compile once from the packet's thermal section; `water_cells` is the
    /// network's regular cell count and `face_endpoints` its faces.
    pub fn new(packet: &Packet, water_cells: usize) -> Result<Self, Failure> {
        let t = &packet.thermal;
        let a = t.fuel_bands.len();
        if a == 0
            || packet.hot.energy.carriers.len() != a
            || t.surface_algebraic_count != 3 * a
            || packet.water_flow_area_m2.len() > water_cells
        {
            return Err(fatal("inconsistent solid allocation"));
        }
        let store = |id: &str| {
            t.passive_stores
                .iter()
                .position(|p| p.id == id)
                .ok_or_else(|| fatal(format!("unknown passive store {id}")))
        };
        let mut bands = Vec::with_capacity(a);
        for (i, b) in t.fuel_bands.iter().enumerate() {
            if b.id != packet.hot.energy.carriers[i].id || b.helium >= t.helium.len() {
                return Err(fatal(format!("band {i} identity or helium owner")));
            }
            let g = b.geometry;
            let geometry = thermal::FuelGeometry {
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
            };
            let contacts: Vec<Contact> = t
                .core_contacts
                .iter()
                .filter(|c| c.band == i)
                .map(|c| Contact {
                    water: c.water,
                    area: c.area_m2,
                    diameter: c.hydraulic_diameter_m,
                })
                .collect();
            if contacts.is_empty()
                || contacts.iter().any(|c| {
                    c.water >= water_cells
                        || !(c.area.is_finite() && c.area > 0.)
                        || !(c.diameter.is_finite() && c.diameter > 0.)
                })
                || !b
                    .fuel_masses_kg
                    .iter()
                    .chain([&b.clad_mass_kg])
                    .all(|m| m.is_finite() && *m > 0.)
            {
                return Err(fatal(format!("band {i} contacts or masses")));
            }
            let clad_density = b.clad_mass_kg
                / (std::f64::consts::PI
                    * (g.clad_outer_radius_m.powi(2) - g.clad_inner_radius_m.powi(2))
                    * g.rod_length_m
                    * g.rods);
            bands.push(Band {
                geometry,
                helium: b.helium,
                fuel_mass: b.fuel_masses_kg,
                clad_mass: b.clad_mass_kg,
                clad_density,
                contacts,
            });
        }
        let mut passive = Vec::with_capacity(t.passive_contacts.len());
        for c in &t.passive_contacts {
            let p = Passive {
                solid: store(&c.store_id)?,
                water: c.water,
                area: c.area_m2,
                liquid_h: c.liquid_h_w_m2_k,
                log_radius: c.wall_log_radius_m,
            };
            if p.water >= water_cells
                || !(p.area.is_finite() && p.area > 0.)
                || !(p.liquid_h.is_finite() && p.liquid_h > 0.)
                || !(p.log_radius.is_finite() && p.log_radius >= 0.)
            {
                return Err(fatal(format!("passive contact {}", c.store_id)));
            }
            passive.push(p);
        }
        let mut plenum = Vec::with_capacity(t.plenum_contacts.len());
        for c in &t.plenum_contacts {
            let p = Plenum {
                helium: c.helium,
                solid: store(&c.store_id)?,
                area: c.area_m2,
                radius: c.inner_radius_m,
                factor: c.conduction_factor,
            };
            if p.helium >= t.helium.len()
                || ![p.area, p.radius, p.factor]
                    .iter()
                    .all(|v| v.is_finite() && *v > 0.)
            {
                return Err(fatal(format!("plenum contact {}", c.store_id)));
            }
            plenum.push(p);
        }
        let mut segments = Vec::with_capacity(t.sg_segments.len());
        for g in &t.sg_segments {
            let segment = Segment {
                primary: g.primary,
                secondary: g.secondary,
                start: g.developed_start_m,
                end: g.developed_end_m,
                area: g.area_m2,
                diameter: g.thermal_diameter_m,
                capacity: g.capacity_j_k,
            };
            if segment.primary >= water_cells
                || segment.secondary >= t.secondaries.len()
                || !(segment.capacity.is_finite() && segment.capacity > 0.)
                || !(segment.start.is_finite() && segment.end.is_finite())
                || segment.start >= segment.end
                || !(segment.area.is_finite() && segment.area > 0.)
                || !(segment.diameter.is_finite() && segment.diameter > 0.)
            {
                return Err(fatal(format!("SG segment {}", g.id)));
            }
            segments.push(segment);
        }
        // The tube steel and exchange area of `ld01-sg-contact`: every SG's
        // segments tile its exchange area.
        let c = &packet.secondary.contact;
        if ![
            c.exchange_area_m2,
            c.steel_conductivity_w_mk,
            c.steel_density_kg_m3,
            c.steel_cp_j_kgk,
        ]
        .iter()
        .all(|v| v.is_finite() && *v > 0.)
            || !(c.emissivity > 0. && c.emissivity <= 1.)
        {
            return Err(fatal("SG contact constants"));
        }
        for k in 0..t.secondaries.len() {
            let area: f64 = segments
                .iter()
                .filter(|g| g.secondary == k)
                .map(|g| g.area)
                .sum();
            if (area - c.exchange_area_m2).abs() > 1e-12 * c.exchange_area_m2 {
                return Err(fatal(format!(
                    "SG {k}'s segments tile {area} m2, not the contact law's {} m2",
                    c.exchange_area_m2
                )));
            }
        }
        let steel = thermal::SteelContact {
            emissivity: c.emissivity,
            material: thermal::WallMaterial {
                conductivity: s(c.steel_conductivity_w_mk),
                density: c.steel_density_kg_m3,
                cp: s(c.steel_cp_j_kgk),
            },
        };
        let helium_nr: Vec<f64> = t.helium.iter().map(|h| h.nr_j_k).collect();
        let passive_mass: Vec<f64> = t.passive_stores.iter().map(|p| p.mass_kg).collect();
        if helium_nr
            .iter()
            .chain(&passive_mass)
            .any(|v| !(v.is_finite() && *v > 0.))
            || t.passive_stores.iter().any(|p| p.material != "zircaloy")
        {
            return Err(fatal("helium amount, passive mass or passive material"));
        }
        // Wall cells: every water owner a core contact or SG segment wets.
        let mut wall_cells: Vec<usize> = bands
            .iter()
            .flat_map(|b| b.contacts.iter().map(|c| c.water))
            .chain(segments.iter().map(|g| g.primary))
            .collect();
        wall_cells.sort_unstable();
        wall_cells.dedup();
        let mut flow_area = vec![0.; water_cells];
        flow_area[..packet.water_flow_area_m2.len()].copy_from_slice(&packet.water_flow_area_m2);
        let mut wall_slot = vec![None; water_cells];
        for (k, c) in wall_cells.iter().enumerate() {
            if !(flow_area[*c].is_finite() && flow_area[*c] > 0.) {
                return Err(fatal(format!("wall cell {c} has no main flow area")));
            }
            wall_slot[*c] = Some(k);
        }
        // Layout: per half U_inner, U_outer, U_clad; per half the three
        // surfaces; helium; passive; SG metal.
        let mut layout = Layout::default();
        let mut prepared = Vec::new();
        for b in &t.fuel_bands {
            for (k, u) in b.fuel_energies_j.iter().enumerate() {
                layout.push(
                    format!("U_fuel[{}][{k}]", b.id),
                    Class::FuelEnergy,
                    true,
                    *u,
                    *u,
                );
                prepared.push(*u);
            }
            layout.push(
                format!("U_clad[{}]", b.id),
                Class::CladEnergy,
                true,
                b.clad_energy_j,
                b.clad_energy_j,
            );
            prepared.push(b.clad_energy_j);
        }
        for (i, b) in t.fuel_bands.iter().enumerate() {
            // A surface row is a heat balance (W); one solver unit is the
            // half's prepared source, so the row reads in source fractions.
            let source = b.source_w[0] + b.source_w[1];
            if !(source.is_finite() && source > 0.) {
                return Err(fatal(format!("band {i} has no prepared source scale")));
            }
            for (k, name) in ["fuel_surface", "clad_inner", "clad_outer"]
                .iter()
                .enumerate()
            {
                layout.push(
                    format!("T_{name}[{}]", b.id),
                    Class::Surface,
                    false,
                    b.surface_seed_k[k],
                    source,
                );
                prepared.push(b.surface_seed_k[k]);
            }
        }
        for h in &t.helium {
            layout.push(
                format!("U_helium[{}]", h.id),
                Class::HeliumEnergy,
                true,
                h.energy_j,
                h.energy_j,
            );
            prepared.push(h.energy_j);
        }
        for p in &t.passive_stores {
            layout.push(
                format!("U_passive[{}]", p.id),
                Class::PassiveEnergy,
                true,
                p.energy_j,
                p.energy_j,
            );
            prepared.push(p.energy_j);
        }
        for g in &t.sg_segments {
            layout.push(
                format!("U_metal[{}]", g.id),
                Class::MetalEnergy,
                true,
                g.energy_j,
                g.energy_j,
            );
            prepared.push(g.energy_j);
        }
        layout.validate("joined solids")?;
        let wall = vec![None; wall_cells.len()];
        let all = Closed {
            bands: (0..bands.len()).collect(),
            passive: (0..passive.len()).collect(),
            plenum: (0..plenum.len()).collect(),
            segments: (0..segments.len()).collect(),
            helium: (0..helium_nr.len()).collect(),
            stores: (0..passive_mass.len()).collect(),
            generators: (0..t.secondaries.len()).collect(),
        };
        let mut solids = Self {
            steel,
            all,
            incidence: Incidence::default(),
            inverse: Inverse::default(),
            layout,
            prepared,
            helium_rate: vec![s(0.); helium_nr.len()],
            passive_rate: vec![s(0.); passive_mass.len()],
            passive_ids: t.passive_stores.iter().map(|p| p.id.clone()).collect(),
            bands,
            helium_nr,
            passive_mass,
            passive,
            plenum,
            segments,
            secondaries: t.secondaries.len(),
            flow_area,
            wall_cells,
            wall_slot,
            wall,
        };
        solids.compile_incidence(water_cells)?;
        Ok(solids)
    }

    fn compile_incidence(&mut self, water_cells: usize) -> Result<(), Failure> {
        let incidence = Incidence {
            halves: self
                .bands
                .iter()
                .map(|b| (b.helium, b.contacts.iter().map(|c| c.water).collect()))
                .collect(),
            passive: self.passive.iter().map(|c| (c.solid, c.water)).collect(),
            plenum: self.plenum.iter().map(|c| (c.helium, c.solid)).collect(),
            segments: self
                .segments
                .iter()
                .map(|g| (g.primary, g.secondary))
                .collect(),
        };
        let mut inv = Inverse {
            helium_bands: vec![Vec::new(); self.helium_nr.len()],
            helium_plenum: vec![Vec::new(); self.helium_nr.len()],
            store_plenum: vec![Vec::new(); self.passive_mass.len()],
            store_passive: vec![Vec::new(); self.passive_mass.len()],
            generator_segments: vec![Vec::new(); self.secondaries],
            cell_bands: vec![Vec::new(); water_cells],
            cell_passive: vec![Vec::new(); water_cells],
            cell_segments: vec![Vec::new(); water_cells],
        };
        let at = |v: &mut Vec<Vec<usize>>, k: usize, e: usize| -> Result<(), Failure> {
            v.get_mut(k)
                .ok_or_else(|| fatal(format!("solid incidence index {k} outside its owner")))?
                .push(e);
            Ok(())
        };
        for (b, (helium, cells)) in incidence.halves.iter().enumerate() {
            at(&mut inv.helium_bands, *helium, b)?;
            for c in cells {
                at(&mut inv.cell_bands, *c, b)?;
            }
        }
        for (c, (store, cell)) in incidence.passive.iter().enumerate() {
            at(&mut inv.store_passive, *store, c)?;
            at(&mut inv.cell_passive, *cell, c)?;
        }
        for (c, (helium, store)) in incidence.plenum.iter().enumerate() {
            at(&mut inv.helium_plenum, *helium, c)?;
            at(&mut inv.store_plenum, *store, c)?;
        }
        for (g, (cell, sg)) in incidence.segments.iter().enumerate() {
            at(&mut inv.generator_segments, *sg, g)?;
            at(&mut inv.cell_segments, *cell, g)?;
        }
        for v in [
            &mut inv.cell_bands,
            &mut inv.cell_passive,
            &mut inv.cell_segments,
        ] {
            for list in v.iter_mut() {
                list.dedup();
            }
        }
        self.incidence = incidence;
        self.inverse = inv;
        Ok(())
    }

    pub fn layout(&self) -> &Layout {
        &self.layout
    }
    pub fn prepared(&self) -> &[f64] {
        &self.prepared
    }
    pub fn halves(&self) -> usize {
        self.bands.len()
    }
    pub fn secondaries(&self) -> usize {
        self.secondaries
    }
    /// The network cells whose water a wall law reads.
    pub fn wall_cells(&self) -> &[usize] {
        &self.wall_cells
    }
    fn helium0(&self) -> usize {
        6 * self.bands.len()
    }
    fn passive0(&self) -> usize {
        self.helium0() + self.helium_nr.len()
    }
    fn metal0(&self) -> usize {
        self.passive0() + self.passive_mass.len()
    }
    /// Local index of half `a`'s energy `k` (inner fuel, outer fuel, clad).
    pub fn energy(&self, a: usize, k: usize) -> usize {
        3 * a + k
    }
    pub fn helium(&self, h: usize) -> usize {
        self.helium0() + h
    }
    pub fn passive(&self, p: usize) -> usize {
        self.passive0() + p
    }
    pub fn metal(&self, i: usize) -> usize {
        self.metal0() + i
    }
    /// Local index of the passive store named `id`, for energy deposits.
    pub fn passive_store(&self, id: &str) -> Option<usize> {
        self.passive_ids
            .iter()
            .position(|p| p == id)
            .map(|p| self.passive(p))
    }
    /// Every core half whose clad wets one of `cells`, ascending.
    pub fn halves_wetting(&self, cells: &[usize]) -> Vec<usize> {
        self.union(cells, &self.inverse.cell_bands)
    }
    /// The passive contacts whose water is one of `cells`, ascending.
    pub fn passive_wetted_by(&self, cells: &[usize]) -> Vec<usize> {
        self.union(cells, &self.inverse.cell_passive)
    }
    /// The SG segments whose primary water is one of `cells`, ascending.
    pub fn segments_wetted_by(&self, cells: &[usize]) -> Vec<usize> {
        self.union(cells, &self.inverse.cell_segments)
    }
    /// The segments of the listed SGs, ascending.
    pub fn segments_of(&self, generators: &[usize]) -> Vec<usize> {
        self.union(generators, &self.inverse.generator_segments)
    }
    fn union(&self, keys: &[usize], map: &[Vec<usize>]) -> Vec<usize> {
        let mut out: Vec<usize> = keys
            .iter()
            .filter_map(|k| map.get(*k))
            .flatten()
            .copied()
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }
    pub fn incidence(&self) -> &Incidence {
        &self.incidence
    }
    /// What each wall slot reads and feeds, in slot order: its network
    /// cell (the cell's pressure and liquid caloric point: `p`, `M_l`,
    /// `U_l`), the faces whose liquid charts its mass flux reads (every face
    /// with the cell as an endpoint, `endpoints` in face order), and the
    /// core halves and SG segments whose rows read it. Passive contacts read
    /// only their cell's liquid temperature, never a wall slot
    /// ([`Solids::passive_wetted_by`]).
    pub fn wall_reads(&self, endpoints: &[(usize, usize)]) -> Vec<WallRead> {
        self.wall_cells
            .iter()
            .map(|&cell| WallRead {
                cell,
                faces: endpoints
                    .iter()
                    .enumerate()
                    .filter(|(_, (from, to))| *from == cell || *to == cell)
                    .map(|(f, _)| f)
                    .collect(),
                halves: self.inverse.cell_bands[cell].clone(),
                segments: self.inverse.cell_segments[cell].clone(),
            })
            .collect()
    }
    /// The unclosed scope of the elements that read own coordinate `i`
    /// (energy, surface or store), and the store whose temperature `i`
    /// sets, if any.
    pub fn column_scope(&self, i: usize) -> Result<(SolidScope, Option<usize>), Failure> {
        let energies = 3 * self.bands.len();
        let (h0, p0, m0) = (self.helium0(), self.passive0(), self.metal0());
        let mut scope = SolidScope::default();
        let store = if i < 2 * energies {
            // A half's energy or surface: that half alone reads it.
            scope.bands.push(if i < energies {
                i / 3
            } else {
                (i - energies) / 3
            });
            (i < energies).then_some(i)
        } else if (h0..p0).contains(&i) {
            scope.bands = self.inverse.helium_bands[i - h0].clone();
            scope.plenum = self.inverse.helium_plenum[i - h0].clone();
            Some(i)
        } else if (p0..m0).contains(&i) {
            scope.passive = self.inverse.store_passive[i - p0].clone();
            scope.plenum = self.inverse.store_plenum[i - p0].clone();
            Some(i)
        } else if i < self.layout.len() {
            scope.segments.push(i - m0);
            Some(i)
        } else {
            return Err(fatal(format!("solid coordinate {i} outside the layout")));
        };
        Ok((scope, store))
    }
    /// Local index of half `a`'s surface `k` (fuel surface, clad inner,
    /// clad outer).
    pub fn surface(&self, a: usize, k: usize) -> usize {
        3 * self.bands.len() + 3 * a + k
    }

    /// Every solid temperature from its energy by the exact caloric inverse.
    pub fn temperatures(&self, x: Coordinates<'_>, out: &mut Temperatures) -> Result<(), Failure> {
        let a = self.bands.len();
        out.fuel.resize(a, [s(0.); 3]);
        out.helium.resize(self.helium_nr.len(), s(0.));
        out.passive.resize(self.passive_mass.len(), s(0.));
        out.metal.resize(self.segments.len(), s(0.));
        for (i, b) in self.bands.iter().enumerate() {
            out.fuel[i] = [
                thermal::fuel_temperature(x.value(3 * i) / s(b.fuel_mass[0])).map_err(trial)?,
                thermal::fuel_temperature(x.value(3 * i + 1) / s(b.fuel_mass[1])).map_err(trial)?,
                thermal::clad_temperature(x.value(3 * i + 2) / s(b.clad_mass)).map_err(trial)?,
            ];
        }
        let h0 = self.helium0();
        for (i, nr) in self.helium_nr.iter().enumerate() {
            out.helium[i] = x.value(h0 + i) / s(1.5 * nr);
        }
        let p0 = self.passive0();
        for (i, m) in self.passive_mass.iter().enumerate() {
            out.passive[i] = thermal::clad_temperature(x.value(p0 + i) / s(*m)).map_err(trial)?;
        }
        let m0 = self.metal0();
        for (i, g) in self.segments.iter().enumerate() {
            out.metal[i] = x.value(m0 + i) / s(g.capacity) + s(273.15);
        }
        Ok(())
    }

    /// The water every wall law of this evaluation reads: the network's own
    /// liquid caloric point (value and direction), one saturation tuple per
    /// wall cell at its pressure and the incident-face mass flux.
    pub fn wall_water<P: WaterProperties>(
        &mut self,
        properties: &P,
        fluid: &Fluid<'_>,
    ) -> Result<(), Failure> {
        for k in 0..self.wall_cells.len() {
            self.wall_water_at_slot(properties, fluid, k)?;
        }
        Ok(())
    }

    /// [`Solids::wall_water`] for the listed network cells only (those that
    /// are wall cells); every other wall cell keeps its last water. It
    /// returns the replaced water, which [`Solids::restore_wall_water`] puts
    /// back so a local call leaves no seeded water behind; on a refusal it
    /// restores it itself.
    pub fn wall_water_local<P: WaterProperties>(
        &mut self,
        properties: &P,
        fluid: &Fluid<'_>,
        cells: &[usize],
    ) -> Result<ReplacedWall, Failure> {
        let mut replaced = ReplacedWall(Vec::with_capacity(cells.len()));
        for cell in cells {
            if let Some(k) = self.wall_slot.get(*cell).copied().flatten() {
                replaced.0.push((k, self.wall[k]));
                if let Err(e) = self.wall_water_at_slot(properties, fluid, k) {
                    self.restore_wall_water(replaced);
                    return Err(e);
                }
            }
        }
        Ok(replaced)
    }

    /// Put back the wall water a [`Solids::wall_water_local`] call replaced.
    pub fn restore_wall_water(&mut self, replaced: ReplacedWall) {
        for (k, w) in replaced.0.into_iter().rev() {
            self.wall[k] = w;
        }
    }

    fn wall_water_at_slot<P: WaterProperties>(
        &mut self,
        properties: &P,
        fluid: &Fluid<'_>,
        k: usize,
    ) -> Result<(), Failure> {
        let cell = self.wall_cells[k];
        let Some((q, d)) = fluid.points[cell][0] else {
            return Err(trial(format!("wall cell {cell} has no liquid")));
        };
        if fluid.points[cell][1].is_some() {
            return Err(trial(format!(
                "wall cell {cell} holds vapor: primary phase presence needs its transaction (S3)"
            )));
        }
        let pressure = fluid.cells[cell].pressure;
        // Saturation reads the pressure alone: an undirected pressure equal
        // to the slot's undirected one gives the same tuple bit for bit.
        let saturation = match self.wall[k] {
            Some(w)
                if pressure.direction == 0.
                    && w.pressure.direction == 0.
                    && w.pressure.value.to_bits() == pressure.value.to_bits() =>
            {
                w.saturation
            }
            _ => properties.saturation(pressure).map_err(trial)?,
        };
        let mut flow = s(0.);
        for (face, (from, to)) in fluid.endpoints.iter().enumerate() {
            if *from == cell || *to == cell {
                flow = flow + s(0.5) * fluid.liquid_mass_flow(face);
            }
        }
        self.wall[k] = Some(WallWater {
            pressure,
            temperature: Scalar::new(q.temperature_k, d.temperature_k),
            bulk: point(q, d),
            saturation,
            mass_flux: flow / s(self.flow_area[cell]),
        });
        Ok(())
    }

    /// The wall water of the last [`Solids::wall_water`] call at `cell`.
    pub fn wall_water_at(&self, cell: usize) -> Option<WallWater> {
        self.wall_slot
            .get(cell)
            .copied()
            .flatten()
            .and_then(|k| self.wall[k])
    }

    /// The fixed-stock surface initializer (operating-thermal.md) for every
    /// half, at its current finite temperatures and the wall water of the
    /// last [`Solids::wall_water`] call: the composed state's own flows. It
    /// returns surface temperatures only; no energy, history or water
    /// coordinate is changed. The surfaces' current values are the seeds.
    pub fn initialize_surfaces<P: WaterProperties>(
        &self,
        properties: &P,
        x: Coordinates<'_>,
        temperatures: &Temperatures,
        policy: initialization::SurfacePolicy,
    ) -> Result<Vec<initialization::SurfaceInitialization>, Failure> {
        let mut out = Vec::with_capacity(self.bands.len());
        for (i, b) in self.bands.iter().enumerate() {
            let [inner, outer, clad_mean] = temperatures.fuel[i].map(|t| s(t.value));
            let seed = [0, 1, 2].map(|k| x.value(self.surface(i, k)).value);
            let fixed = thermal::FuelTemperatures {
                inner_mean: inner,
                outer_mean: outer,
                fuel_surface: s(seed[0]),
                helium: s(temperatures.helium[b.helium].value),
                clad_inner: s(seed[1]),
                clad_mean,
                clad_outer: s(seed[2]),
            };
            let walls: Vec<(Contact, WaterWall)> = b
                .contacts
                .iter()
                .map(|c| self.wall_at(c.water).map(|w| (*c, WaterWall::of(w))))
                .collect::<Result<_, _>>()?;
            let wall = |outer: Scalar| -> thermal::Result<Scalar> {
                let mut heat = s(0.);
                for (c, w) in &walls {
                    let q = thermal::liquid_wall_current(
                        properties,
                        w.pressure,
                        w.temperature,
                        outer,
                        w.mass_flux,
                        thermal::WallLaw {
                            diameter_m: c.diameter,
                            film: thermal::Film::Core,
                            emissivity: b.geometry.clad_emissivity,
                            material: thermal::core_wall_material(clad_mean, b.clad_density)?,
                        },
                        w.saturation,
                        w.bulk,
                    )?;
                    if q.vapor_mass.value != 0. {
                        return Err("initial core wall vapor departure");
                    }
                    heat = heat + s(c.area) * q.heat;
                }
                Ok(heat)
            };
            out.push(
                initialization::initialize_fuel_surfaces(&b.geometry, fixed, seed, policy, wall)
                    .map_err(|e| fatal(format!("half {i}: {e}")))?,
            );
        }
        Ok(out)
    }

    fn wall_at(&self, cell: usize) -> Result<WallWater, Failure> {
        self.wall_slot[cell]
            .and_then(|k| self.wall[k])
            .ok_or_else(|| fatal(format!("wall water of cell {cell} not evaluated")))
    }

    /// Every own row (physical units), the heats into the network's water
    /// (its liquid enthalpy port) and into each SG secondary: the scoped
    /// evaluation over every element, so there is one arithmetic path.
    #[allow(clippy::too_many_arguments)] // One block's stage: its coordinates, temperatures and ports.
    pub fn rows<P: WaterProperties>(
        &mut self,
        properties: &P,
        x: Coordinates<'_>,
        temperatures: &Temperatures,
        fuel_heat_w: &[Scalar],
        fluid: &Fluid<'_>,
        secondary: &[SecondaryView],
        receipts: &mut Receipts<'_>,
        rows: &mut [Scalar],
        heat: &mut Heat,
    ) -> Result<(), Failure> {
        if rows.len() != self.layout.len() {
            return Err(fatal("stage length"));
        }
        let all = std::mem::take(&mut self.all);
        let result = self.evaluate_scope(
            properties,
            x,
            temperatures,
            fuel_heat_w,
            fluid,
            secondary,
            &all,
            receipts,
            &mut |i, r| rows[i] = r,
            heat,
        );
        self.all = all;
        result?;
        if rows
            .iter()
            .chain(&heat.secondary_w)
            .any(|v| !(v.value.is_finite() && v.direction.is_finite()))
        {
            return Err(trial("nonfinite solid row or heat"));
        }
        Ok(())
    }

    /// The closure of `scope` over incidence, so that every row it writes is
    /// complete: a helium store with both halves of its assembly and its
    /// plenum contacts, a passive store with every contact and its plenum
    /// contact, an SG's secondary heat with all its segments.
    pub fn close(&self, scope: &SolidScope) -> Closed {
        use std::collections::BTreeSet;
        // One worklist over the incidence and its inverse: every element
        // reached is visited once, so the cost follows the closed scope.
        enum Item {
            Band(usize),
            Passive(usize),
            Plenum(usize),
            Segment(usize),
            Helium(usize),
            Store(usize),
            Generator(usize),
        }
        let (mut bands, mut passive, mut plenum, mut segments) = (
            BTreeSet::new(),
            BTreeSet::new(),
            BTreeSet::new(),
            BTreeSet::new(),
        );
        let (mut helium, mut stores, mut generators) =
            (BTreeSet::new(), BTreeSet::new(), BTreeSet::new());
        let mut work: Vec<Item> = scope
            .bands
            .iter()
            .map(|b| Item::Band(*b))
            .chain(scope.passive.iter().map(|c| Item::Passive(*c)))
            .chain(scope.plenum.iter().map(|c| Item::Plenum(*c)))
            .chain(scope.segments.iter().map(|g| Item::Segment(*g)))
            .collect();
        let inv = &self.inverse;
        while let Some(item) = work.pop() {
            match item {
                Item::Band(b) => {
                    if bands.insert(b) {
                        work.push(Item::Helium(self.bands[b].helium));
                    }
                }
                Item::Passive(c) => {
                    if passive.insert(c) {
                        work.push(Item::Store(self.passive[c].solid));
                    }
                }
                Item::Plenum(c) => {
                    if plenum.insert(c) {
                        work.push(Item::Helium(self.plenum[c].helium));
                        work.push(Item::Store(self.plenum[c].solid));
                    }
                }
                Item::Segment(g) => {
                    if segments.insert(g) {
                        work.push(Item::Generator(self.segments[g].secondary));
                    }
                }
                Item::Helium(h) => {
                    if helium.insert(h) {
                        work.extend(inv.helium_bands[h].iter().map(|b| Item::Band(*b)));
                        work.extend(inv.helium_plenum[h].iter().map(|c| Item::Plenum(*c)));
                    }
                }
                Item::Store(p) => {
                    if stores.insert(p) {
                        work.extend(inv.store_plenum[p].iter().map(|c| Item::Plenum(*c)));
                        work.extend(inv.store_passive[p].iter().map(|c| Item::Passive(*c)));
                    }
                }
                Item::Generator(k) => {
                    if generators.insert(k) {
                        work.extend(inv.generator_segments[k].iter().map(|g| Item::Segment(*g)));
                    }
                }
            }
        }
        Closed {
            bands: bands.into_iter().collect(),
            passive: passive.into_iter().collect(),
            plenum: plenum.into_iter().collect(),
            segments: segments.into_iter().collect(),
            helium: helium.into_iter().collect(),
            stores: stores.into_iter().collect(),
            generators: generators.into_iter().collect(),
        }
    }

    /// The rows of a closed scope only, in physical units with own indices,
    /// and its terms' receipts. Every written row is complete, so its value
    /// equals [`Solids::rows`] bitwise; receipts hold only the scope's terms.
    #[allow(clippy::too_many_arguments)] // One block's stage over a scope.
    pub fn rows_local<P: WaterProperties>(
        &mut self,
        properties: &P,
        x: Coordinates<'_>,
        temperatures: &Temperatures,
        fuel_heat_w: &[Scalar],
        fluid: &Fluid<'_>,
        secondary: &[SecondaryView],
        scope: &Closed,
        receipts: &mut Receipts<'_>,
        out: &mut Vec<(usize, Scalar)>,
        heat: &mut Heat,
    ) -> Result<(), Failure> {
        out.clear();
        self.evaluate_scope(
            properties,
            x,
            temperatures,
            fuel_heat_w,
            fluid,
            secondary,
            scope,
            receipts,
            &mut |i, r| out.push((i, r)),
            heat,
        )
    }

    /// The entry of `temperatures` that own store coordinate `i` sets.
    pub fn temperature_of<'t>(
        &self,
        i: usize,
        temperatures: &'t mut Temperatures,
    ) -> Result<&'t mut Scalar, Failure> {
        let (h0, p0, m0) = (self.helium0(), self.passive0(), self.metal0());
        let entry = if i < 3 * self.bands.len() {
            temperatures.fuel.get_mut(i / 3).map(|t| &mut t[i % 3])
        } else if (h0..p0).contains(&i) {
            temperatures.helium.get_mut(i - h0)
        } else if (p0..m0).contains(&i) {
            temperatures.passive.get_mut(i - p0)
        } else if i >= m0 {
            temperatures.metal.get_mut(i - m0)
        } else {
            None
        };
        entry.ok_or_else(|| fatal(format!("coordinate {i} has no temperature")))
    }

    /// Recompute the temperatures of the listed own coordinates only (their
    /// energies), leaving every other entry of `out` as it was.
    pub fn temperatures_local(
        &self,
        x: Coordinates<'_>,
        stores: &[usize],
        out: &mut Temperatures,
    ) -> Result<(), Failure> {
        let (h0, p0, m0) = (self.helium0(), self.passive0(), self.metal0());
        for &i in stores {
            if i < 3 * self.bands.len() {
                let (a, k) = (i / 3, i % 3);
                let b = &self.bands[a];
                out.fuel[a][k] = if k < 2 {
                    thermal::fuel_temperature(x.value(i) / s(b.fuel_mass[k])).map_err(trial)?
                } else {
                    thermal::clad_temperature(x.value(i) / s(b.clad_mass)).map_err(trial)?
                };
            } else if (h0..p0).contains(&i) {
                out.helium[i - h0] = x.value(i) / s(1.5 * self.helium_nr[i - h0]);
            } else if (p0..m0).contains(&i) {
                out.passive[i - p0] =
                    thermal::clad_temperature(x.value(i) / s(self.passive_mass[i - p0]))
                        .map_err(trial)?;
            } else if i >= m0 && i < self.layout.len() {
                out.metal[i - m0] = x.value(i) / s(self.segments[i - m0].capacity) + s(273.15);
            } else {
                return Err(fatal(format!("coordinate {i} has no temperature")));
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)] // One block's stage over a scope.
    fn evaluate_scope<P: WaterProperties>(
        &mut self,
        properties: &P,
        x: Coordinates<'_>,
        temperatures: &Temperatures,
        fuel_heat_w: &[Scalar],
        fluid: &Fluid<'_>,
        secondary: &[SecondaryView],
        scope: &Closed,
        receipts: &mut Receipts<'_>,
        write: &mut dyn FnMut(usize, Scalar),
        heat: &mut Heat,
    ) -> Result<(), Failure> {
        let a = self.bands.len();
        if x.len() != self.layout.len()
            || fuel_heat_w.len() != a
            || secondary.len() != self.secondaries
        {
            return Err(fatal("stage length"));
        }
        heat.secondary_w.clear();
        heat.secondary_w.resize(self.secondaries, s(0.));
        heat.primary_to_metal_w.clear();
        heat.primary_to_metal_w.resize(self.segments.len(), s(0.));
        heat.clad_to_water_w = s(0.);
        heat.passive_to_water_w = s(0.);
        heat.stored_rate_w = s(0.);
        for h in &scope.helium {
            self.helium_rate[*h] = s(0.);
        }
        for p in &scope.stores {
            self.passive_rate[*p] = s(0.);
        }
        for &i in &scope.bands {
            let b = &self.bands[i];
            let [inner, outer, clad_mean] = temperatures.fuel[i];
            let surface = x.value(self.surface(i, 0));
            let clad_inner = x.value(self.surface(i, 1));
            let clad_outer = x.value(self.surface(i, 2));
            let mut wall = s(0.);
            for c in &b.contacts {
                let water = self.wall_at(c.water)?;
                let q = thermal::liquid_wall_current(
                    properties,
                    water.pressure,
                    water.temperature,
                    clad_outer,
                    water.mass_flux,
                    thermal::WallLaw {
                        diameter_m: c.diameter,
                        film: thermal::Film::Core,
                        emissivity: b.geometry.clad_emissivity,
                        material: thermal::core_wall_material(clad_mean, b.clad_density)
                            .map_err(trial)?,
                    },
                    water.saturation,
                    water.bulk,
                )
                .map_err(trial)?;
                if q.vapor_mass.value != 0. || q.vapor_mass.direction != 0. {
                    return Err(trial(
                        "core wall vapor departure needs its primary phase transaction (S3)",
                    ));
                }
                let into_water = q.heat * s(c.area);
                wall = wall + into_water;
                receipts.heat(c.water, into_water)?;
            }
            heat.clad_to_water_w = heat.clad_to_water_w + wall;
            let q = thermal::fuel_heat_rates(
                &b.geometry,
                thermal::FuelTemperatures {
                    inner_mean: inner,
                    outer_mean: outer,
                    fuel_surface: surface,
                    helium: temperatures.helium[b.helium],
                    clad_inner,
                    clad_mean,
                    clad_outer,
                },
                FUEL_HEAT_SPLIT.map(|f| fuel_heat_w[i] * s(f)),
                wall,
            )
            .map_err(trial)?;
            let rates = [q.fuel_inner, q.fuel_outer, q.clad];
            for (k, rate) in rates.into_iter().enumerate() {
                write(3 * i + k, x.rate(3 * i + k) - rate);
                heat.stored_rate_w = heat.stored_rate_w + rate;
            }
            for k in 0..3 {
                write(self.surface(i, k), q.surface_residuals[k]);
            }
            self.helium_rate[b.helium] = self.helium_rate[b.helium] + q.helium;
        }
        for &k in &scope.passive {
            let c = self.passive[k];
            let water_t = fluid.points[c.water][0]
                .map(|(q, d)| Scalar::new(q.temperature_k, d.temperature_k))
                .ok_or_else(|| trial(format!("passive contact cell {} has no liquid", c.water)))?;
            let q = thermal::nonfuel_wall(
                temperatures.passive[c.solid],
                water_t,
                s(c.area),
                c.liquid_h,
                c.log_radius,
            )
            .map_err(trial)?;
            self.passive_rate[c.solid] = self.passive_rate[c.solid] - q;
            heat.passive_to_water_w = heat.passive_to_water_w + q;
            receipts.heat(c.water, q)?;
        }
        for &k in &scope.plenum {
            let c = self.plenum[k];
            let q = thermal::helium_to_plenum(
                temperatures.helium[c.helium],
                temperatures.passive[c.solid],
                c.area,
                c.radius,
                c.factor,
            )
            .map_err(trial)?;
            self.helium_rate[c.helium] = self.helium_rate[c.helium] - q;
            self.passive_rate[c.solid] = self.passive_rate[c.solid] + q;
        }
        let m0 = self.metal0();
        for &i in &scope.segments {
            let g = self.segments[i];
            let water = self.wall_at(g.primary)?;
            let metal_t = temperatures.metal[i];
            let q = thermal::liquid_wall_current(
                properties,
                water.pressure,
                water.temperature,
                metal_t,
                water.mass_flux,
                thermal::WallLaw {
                    diameter_m: g.diameter,
                    film: thermal::Film::Tube,
                    emissivity: self.steel.emissivity,
                    material: self.steel.material,
                },
                water.saturation,
                water.bulk,
            )
            .map_err(trial)?;
            if q.vapor_mass.value != 0. || q.vapor_mass.direction != 0. {
                return Err(trial(
                    "SG primary wall vapor departure needs its transaction",
                ));
            }
            let primary_to_metal = -q.heat * s(g.area);
            let view = secondary[g.secondary];
            let out = thermal::secondary_wall(
                properties,
                view.pressure,
                view.saturation_temperature,
                metal_t,
                view.liquid_volume,
                g.start,
                g.end,
                g.area,
                g.diameter,
                self.steel,
                view.steam_present,
            )
            .map_err(trial)?;
            receipts.heat(g.primary, -primary_to_metal)?;
            heat.primary_to_metal_w[i] = primary_to_metal;
            heat.secondary_w[g.secondary] = heat.secondary_w[g.secondary] + out;
            let rate = primary_to_metal - out;
            heat.stored_rate_w = heat.stored_rate_w + rate;
            write(m0 + i, x.rate(m0 + i) - rate);
        }
        let h0 = self.helium0();
        for &h in &scope.helium {
            let rate = self.helium_rate[h];
            write(h0 + h, x.rate(h0 + h) - rate);
            heat.stored_rate_w = heat.stored_rate_w + rate;
        }
        let p0 = self.passive0();
        for &p in &scope.stores {
            let rate = self.passive_rate[p];
            write(p0 + p, x.rate(p0 + p) - rate);
            heat.stored_rate_w = heat.stored_rate_w + rate;
        }
        Ok(())
    }
}

/// The thermal laws' water tuple from the network's caloric point.
fn point(q: Water, d: Water) -> WaterPoint {
    WaterPoint {
        density: Scalar::new(q.density_kg_m3, d.density_kg_m3),
        viscosity: Scalar::new(q.viscosity_pa_s, d.viscosity_pa_s),
        conductivity: Scalar::new(q.conductivity_w_m_k, d.conductivity_w_m_k),
        cp: Scalar::new(q.cp_j_kg_k, d.cp_j_kg_k),
        expansion: Scalar::new(q.expansion_per_k, d.expansion_per_k),
        enthalpy: Scalar::new(q.enthalpy_j_kg, d.enthalpy_j_kg),
    }
}
