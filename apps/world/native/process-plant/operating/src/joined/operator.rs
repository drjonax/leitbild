//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-spine-at-power
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-block-interface
//! The composed joined residual and its colored stage Jacobian.
//!
//! `y` is `[network | nuclear | solids | secondary | rods]`. One evaluation
//! takes the rods' travel and cell volumes, then evaluates the network with
//! this operator as its coupling: inside the coupling the SG views, the
//! solids' temperatures, the nuclear rows, the solids' rows and heats, the
//! rod rows and receipts and the secondary rows are evaluated on the
//! network's fluid state of the same call. Rows are the network's own scaled
//! rows, then every block's physical rows divided by their row scales.
//!
//! The joined structural pattern is the network's own pattern plus every
//! port dependency, conservatively: each column lists every row any state
//! can make it reach. The colored assembly scatters one exact directional
//! evaluation per color and refuses any response outside the pattern.
//!
//! A port may be `Prepared` while its owner is pending: the views or travel
//! at the packet's prepared state. Such an operator evaluates zero-time
//! receipts only, its Jacobian included (a consistent start of the composed
//! coordinates at t = 0); [`Joined::integrable`] is false, and the stock-IDA
//! adapter refuses it, so no integrator can advance it.
use super::{
    block::{CellVolume, Coordinates, Layout, Rods, Secondary, SecondaryView},
    nuclear::{self, Nuclear, RegionWater},
    packet::Packet,
    solids::{self, Solids},
};
use crate::{
    network::{
        Coupling, Failure, Fluid, Network, Properties, Receipts, Reuse,
        packet::Packet as NetworkPacket,
    },
    sparse::{self, Coloring, Pattern},
    thermal::{self, Scalar, WaterProperties},
};
use std::collections::BTreeSet;
use std::time::Instant;

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("joined operator: {}", reason.into()))
}
fn trial(reason: impl std::fmt::Display) -> Failure {
    Failure::Recoverable(format!("joined operator: {reason}"))
}

/// The SG secondary port.
pub enum SecondaryPort<P> {
    /// The owner's block, composed.
    Owner(Box<dyn Secondary<P>>),
    /// Zero-time only: each SG's view at the packet's prepared secondary.
    Prepared(Vec<SecondaryView>),
}
/// The rod port.
pub enum RodPort<P> {
    Owner(Box<dyn Rods<P>>),
    /// Zero-time only: the packet's prepared achieved travel per cluster,
    /// the compiled cell volumes and no guide passage.
    Prepared(Vec<f64>),
}

/// First global coordinate of every block.
#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct Offsets {
    pub nuclear: usize,
    pub solids: usize,
    pub secondary: usize,
    pub rods: usize,
    pub end: usize,
}

/// Wall time and counts of the joined evaluations, by owner.
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct Counters {
    pub residuals: usize,
    pub residual_wall_s: f64,
    pub coupled_wall_s: f64,
    pub jacobians: usize,
    pub jacobian_wall_s: f64,
}

/// The last evaluation's heats, for receipts and conservation.
#[derive(Clone, Debug, Default)]
pub struct Heats {
    pub nuclear: nuclear::Heat,
    pub solids: solids::Heat,
    /// Direct coolant deposition delivered into the network (W).
    pub coolant_w: Scalar,
}

/// One face's compiled endpoints and supporting cells.
#[derive(Clone, Debug)]
struct Face {
    from: usize,
    to: usize,
    supports: Vec<usize>,
}

struct Blocks<P> {
    properties: P,
    nuclear: Nuclear,
    solids: Solids,
    secondary: SecondaryPort<P>,
    rods: RodPort<P>,
    offsets: Offsets,
    source_water: Vec<usize>,
    compiled_volumes: Vec<f64>,
    nuclear_rows: Vec<Scalar>,
    solid_rows: Vec<Scalar>,
    secondary_rows: Vec<Scalar>,
    rod_rows: Vec<Scalar>,
    temperatures: solids::Temperatures,
    fuel_t: Vec<Scalar>,
    water: Vec<RegionWater>,
    travel: Vec<Scalar>,
    views: Vec<SecondaryView>,
    cell_volumes: Vec<CellVolume>,
    heats: Heats,
    coupled_wall_s: f64,
    /// Nuclear, solids, secondary and rods, in that order.
    scales: [Scales; 4],
    /// One startup evaluation lets the rod owner prepare its algebraic
    /// coordinates on that evaluation's fluid state ([`Joined::prepare_owners`]).
    prepare: Option<Vec<super::block::Transaction>>,
}

pub struct Joined<P: Properties> {
    pub network: Network<P>,
    blocks: Blocks<P>,
    faces: Vec<Face>,
    rows: Vec<Scalar>,
    structure: Option<(Pattern, Coloring)>,
    pub counters: Counters,
}

fn view<'a>(
    y: &'a [f64],
    yp: &'a [f64],
    seed: Option<&'a [f64]>,
    cj: f64,
    range: std::ops::Range<usize>,
    scales: &'a [f64],
) -> Result<Coordinates<'a>, Failure> {
    Coordinates::new(
        &y[range.clone()],
        &yp[range.clone()],
        seed.map(|d| &d[range]),
        cj,
        scales,
    )
}

/// Coordinate and row scales of one block, copied once at composition so a
/// coordinate view never borrows the block it is handed to.
#[derive(Clone, Debug, Default)]
struct Scales {
    coordinates: Vec<f64>,
    rows: Vec<f64>,
}
impl Scales {
    fn of(layout: &Layout) -> Self {
        Self {
            coordinates: layout.scales.clone(),
            rows: layout.row_scales.clone(),
        }
    }
}

impl<P: Properties + WaterProperties> Joined<P> {
    /// Compose the blocks on one packet. `properties` is a second instance
    /// of the network's maintained property implementation, for the blocks.
    pub fn new(
        network: Network<P>,
        network_packet: &NetworkPacket,
        packet: &Packet,
        properties: P,
        secondary: SecondaryPort<P>,
        rods: RodPort<P>,
    ) -> Result<Self, Failure> {
        let cells = network.cell_layout.len();
        let nuclear = Nuclear::new(packet, cells)?;
        let solids = Solids::new(packet, cells)?;
        let generators = solids.secondaries();
        let clusters = nuclear.feedback().rod_count();
        let secondary_len = match &secondary {
            SecondaryPort::Owner(b) => {
                b.layout().validate("secondary")?;
                if b.generators() != generators {
                    return Err(fatal("secondary generator count"));
                }
                b.layout().len()
            }
            SecondaryPort::Prepared(v) => {
                if v.len() != generators {
                    return Err(fatal("prepared secondary view count"));
                }
                0
            }
        };
        let rods_len = match &rods {
            RodPort::Owner(b) => {
                b.layout().validate("rods")?;
                if b.clusters() != clusters {
                    return Err(fatal("rod cluster count"));
                }
                b.layout().len()
            }
            RodPort::Prepared(t) => {
                if t.len() != clusters {
                    return Err(fatal("prepared rod travel count"));
                }
                0
            }
        };
        let n = network.dimension();
        let offsets = Offsets {
            nuclear: n,
            solids: n + nuclear.layout().len(),
            secondary: n + nuclear.layout().len() + solids.layout().len(),
            rods: n + nuclear.layout().len() + solids.layout().len() + secondary_len,
            end: n + nuclear.layout().len() + solids.layout().len() + secondary_len + rods_len,
        };
        let faces: Vec<Face> = network_packet
            .mechanics
            .faces
            .iter()
            .map(|f| Face {
                from: f.from,
                to: f.to,
                supports: f.supports.iter().map(|s| s.region).collect(),
            })
            .collect();
        if faces.len() != network.face_count() {
            return Err(fatal("network packet faces"));
        }
        let compiled_volumes = (0..cells).map(|c| network.volume(c)).collect();
        let scales = [
            Scales::of(nuclear.layout()),
            Scales::of(solids.layout()),
            match &secondary {
                SecondaryPort::Owner(b) => Scales::of(b.layout()),
                SecondaryPort::Prepared(_) => Scales::default(),
            },
            match &rods {
                RodPort::Owner(b) => Scales::of(b.layout()),
                RodPort::Prepared(_) => Scales::default(),
            },
        ];
        let blocks = Blocks {
            scales,
            prepare: None,
            nuclear_rows: vec![s(0.); nuclear.layout().len()],
            solid_rows: vec![s(0.); solids.layout().len()],
            secondary_rows: vec![s(0.); secondary_len],
            rod_rows: vec![s(0.); rods_len],
            temperatures: solids::Temperatures::default(),
            fuel_t: vec![s(0.); nuclear.carriers()],
            water: vec![
                RegionWater {
                    density_kg_m3: s(0.),
                    boron_ppm_eq: s(0.),
                    pressure_pa: s(0.),
                    temperature_k: s(0.),
                };
                nuclear.regions()
            ],
            travel: vec![s(0.); clusters],
            views: vec![
                SecondaryView {
                    pressure: s(0.),
                    saturation_temperature: s(0.),
                    liquid_volume: s(0.),
                    steam_present: false,
                };
                generators
            ],
            cell_volumes: vec![
                CellVolume {
                    volume_m3: s(0.),
                    rate_m3_s: s(0.),
                };
                cells
            ],
            heats: Heats::default(),
            coupled_wall_s: 0.,
            properties,
            nuclear,
            solids,
            secondary,
            rods,
            offsets,
            source_water: packet.source_water.clone(),
            compiled_volumes,
        };
        let mut joined = Self {
            network,
            blocks,
            faces,
            rows: vec![s(0.); offsets.end],
            structure: None,
            counters: Counters::default(),
        };
        let columns = joined.structural_pattern()?;
        let pattern = Pattern::from_columns(offsets.end, &columns).map_err(fatal)?;
        let coloring = Coloring::greedy(&pattern);
        coloring.verify(&pattern).map_err(fatal)?;
        joined.structure = Some((pattern, coloring));
        Ok(joined)
    }

    /// Both ports are composed owners: the operator may be integrated.
    pub fn integrable(&self) -> bool {
        matches!(self.blocks.secondary, SecondaryPort::Owner(_))
            && matches!(self.blocks.rods, RodPort::Owner(_))
    }
    pub fn dimension(&self) -> usize {
        self.blocks.offsets.end
    }
    pub fn offsets(&self) -> Offsets {
        self.blocks.offsets
    }
    pub fn nuclear(&self) -> &Nuclear {
        &self.blocks.nuclear
    }
    pub fn solids(&self) -> &Solids {
        &self.blocks.solids
    }
    pub fn heats(&self) -> &Heats {
        &self.blocks.heats
    }
    pub fn temperatures(&self) -> &solids::Temperatures {
        &self.blocks.temperatures
    }
    pub fn travel(&self) -> &[Scalar] {
        &self.blocks.travel
    }
    pub fn views(&self) -> &[SecondaryView] {
        &self.blocks.views
    }
    pub fn source_water(&self) -> &[usize] {
        &self.blocks.source_water
    }
    pub fn secondary(&self) -> Option<&dyn Secondary<P>> {
        match &self.blocks.secondary {
            SecondaryPort::Owner(b) => Some(b.as_ref()),
            SecondaryPort::Prepared(_) => None,
        }
    }
    pub fn rods(&self) -> Option<&dyn Rods<P>> {
        match &self.blocks.rods {
            RodPort::Owner(b) => Some(b.as_ref()),
            RodPort::Prepared(_) => None,
        }
    }
    pub fn secondary_mut(&mut self) -> Option<&mut (dyn Secondary<P> + 'static)> {
        match &mut self.blocks.secondary {
            SecondaryPort::Owner(b) => Some(b.as_mut()),
            SecondaryPort::Prepared(_) => None,
        }
    }
    pub fn rods_mut(&mut self) -> Option<&mut (dyn Rods<P> + 'static)> {
        match &mut self.blocks.rods {
            RodPort::Owner(b) => Some(b.as_mut()),
            RodPort::Prepared(_) => None,
        }
    }
    /// The joined rows of the last evaluation (solver scaling).
    pub fn rows(&self) -> &[Scalar] {
        &self.rows
    }
    pub fn properties(&self) -> &P {
        &self.blocks.properties
    }
    pub fn structure(&self) -> Option<&(Pattern, Coloring)> {
        self.structure.as_ref()
    }

    /// Every block's layout in global order: network, nuclear, solids and the
    /// composed owners.
    pub fn layouts(&self) -> Vec<(&'static str, Layout)> {
        let mut out = vec![
            ("network", super::network_layout(&self.network)),
            ("nuclear", self.blocks.nuclear.layout().clone()),
            ("solids", self.blocks.solids.layout().clone()),
        ];
        if let SecondaryPort::Owner(b) = &self.blocks.secondary {
            out.push(("secondary", b.layout().clone()));
        }
        if let RodPort::Owner(b) = &self.blocks.rods {
            out.push(("rods", b.layout().clone()));
        }
        out
    }

    /// Scales of every coordinate in global order.
    pub fn scales(&self) -> Vec<f64> {
        self.layouts()
            .into_iter()
            .flat_map(|(_, l)| l.scales)
            .collect()
    }

    /// Prepared coordinates in solver scaling: the network's given `y`, then
    /// every block's prepared physical values over its scales.
    pub fn prepared(&self, network_y: &[f64]) -> Result<Vec<f64>, Failure> {
        if network_y.len() != self.network.dimension() {
            return Err(fatal("network preparation length"));
        }
        let mut y = network_y.to_vec();
        let mut push = |values: &[f64], layout: &Layout| {
            y.extend(values.iter().zip(&layout.scales).map(|(v, s)| v / s));
        };
        push(self.blocks.nuclear.prepared(), self.blocks.nuclear.layout());
        push(self.blocks.solids.prepared(), self.blocks.solids.layout());
        if let SecondaryPort::Owner(b) = &self.blocks.secondary {
            push(&b.prepared(), b.layout());
        }
        if let RodPort::Owner(b) = &self.blocks.rods {
            push(&b.prepared(), b.layout());
        }
        Ok(y)
    }

    /// Current IDA identity in global order.
    pub fn differential(&self, network_ids: &[f64]) -> Vec<f64> {
        let mut ids = self.network.differential(network_ids);
        ids.extend(self.blocks.nuclear.layout().ids());
        ids.extend(self.blocks.solids.layout().ids());
        if let SecondaryPort::Owner(b) = &self.blocks.secondary {
            ids.extend(b.differential());
        }
        if let RodPort::Owner(b) = &self.blocks.rods {
            ids.extend(b.differential());
        }
        ids
    }

    /// Evaluate every joined row; with `seed`, also its directions.
    pub fn evaluate(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
        seed: Option<&[f64]>,
        cj: f64,
        reuse: Option<&mut Reuse<P::Caloric>>,
    ) -> Result<(), Failure> {
        let started = Instant::now();
        let o = self.blocks.offsets;
        if y.len() != o.end || yp.len() != o.end || seed.is_some_and(|d| d.len() != o.end) {
            return Err(fatal("stage length"));
        }
        self.blocks.pre_network(y, yp, seed, cj)?;
        // The rod owner's moving volumes; a prepared pose lists none, so every
        // cell keeps its compiled volume. Taken out for the call, so the
        // coupling may borrow the blocks while the network reads them.
        let volumes = match self.blocks.rods {
            RodPort::Owner(_) => std::mem::take(&mut self.blocks.cell_volumes),
            RodPort::Prepared(_) => Vec::new(),
        };
        let (network_rows, block_rows) = self.rows.split_at_mut(o.nuclear);
        let mut coupler = Coupler {
            blocks: &mut self.blocks,
            t,
            y,
            yp,
            seed,
            cj,
            rows: block_rows,
        };
        let result = self.network.evaluate_joined(
            t,
            &y[..o.nuclear],
            &yp[..o.nuclear],
            seed.map(|d| &d[..o.nuclear]),
            cj,
            reuse,
            Some(&mut coupler),
            &volumes,
        );
        if matches!(self.blocks.rods, RodPort::Owner(_)) {
            self.blocks.cell_volumes = volumes;
        }
        result?;
        network_rows.copy_from_slice(self.network.rows());
        self.counters.residuals += 1;
        self.counters.residual_wall_s += started.elapsed().as_secs_f64();
        self.counters.coupled_wall_s = self.blocks.coupled_wall_s;
        Ok(())
    }

    /// Startup only: let the composed owners prepare their algebraic
    /// coordinates on the fluid state of one value evaluation at `(t, y, 0)`
    /// (the rods' steady guide currents), then write their prepared
    /// coordinates into `y`. No differential coordinate of any block moves.
    pub fn prepare_owners(
        &mut self,
        t: f64,
        y: &mut [f64],
    ) -> Result<Vec<super::block::Transaction>, Failure> {
        let zero = vec![0.; y.len()];
        self.blocks.prepare = Some(Vec::new());
        let evaluated = self.evaluate(t, y, &zero, None, 0., None);
        let done = self.blocks.prepare.take().unwrap_or_default();
        evaluated?;
        let o = self.blocks.offsets;
        if let RodPort::Owner(b) = &self.blocks.rods {
            let ids = b.differential();
            for (i, (v, scale)) in b
                .prepared()
                .iter()
                .zip(&self.blocks.scales[3].coordinates)
                .enumerate()
            {
                let new = v / scale;
                if ids[i] != 0. && new != y[o.rods + i] {
                    return Err(fatal(format!(
                        "the rod owner's preparation moved differential coordinate {i}"
                    )));
                }
                y[o.rods + i] = new;
            }
        }
        Ok(done)
    }

    /// Memo §3 (C): the fixed-stock surface initializer at the state's own
    /// water and flows. One value evaluation at `(t, y, 0)` supplies them;
    /// only the surface coordinates of `y` are rewritten.
    pub fn initialize_surfaces(
        &mut self,
        t: f64,
        y: &mut [f64],
        policy: crate::initialization::SurfacePolicy,
    ) -> Result<Vec<crate::initialization::SurfaceInitialization>, Failure> {
        let zero = vec![0.; y.len()];
        self.evaluate(t, y, &zero, None, 0., None)?;
        let o = self.blocks.offsets;
        let b = &self.blocks;
        let x = view(
            y,
            &zero,
            None,
            0.,
            o.solids..o.secondary,
            &b.scales[1].coordinates,
        )?;
        let solved = b
            .solids
            .initialize_surfaces(&b.properties, x, &b.temperatures, policy)?;
        for (i, r) in solved.iter().enumerate() {
            let t = r.temperatures;
            for (k, v) in [t.fuel_surface, t.clad_inner, t.clad_outer]
                .iter()
                .enumerate()
            {
                let index = b.solids.surface(i, k);
                y[o.solids + index] = v.value / b.scales[1].coordinates[index];
            }
        }
        Ok(solved)
    }

    /// The colored stage Jacobian `dF/dy + cj dF/dy'` at `(t, y, y')` into
    /// `values`, in the stored order of the compiled pattern.
    pub fn jacobian(
        &mut self,
        t: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        values: &mut [f64],
    ) -> Result<(), Failure> {
        let started = Instant::now();
        let Some((pattern, coloring)) = self.structure.take() else {
            return Err(fatal("the joined structure is held by another assembly"));
        };
        let result = (|| {
            let n = self.dimension();
            let mut reuse = self.network.reuse();
            self.evaluate(t, y, yp, None, 0., Some(&mut reuse))?;
            let mut signs = vec![1.; n];
            signs[..self.blocks.offsets.nuclear]
                .copy_from_slice(&self.network.column_signs(&y[..self.blocks.offsets.nuclear]));
            let mut seed = vec![0.; n];
            let mut directions = vec![0.; n];
            for color in 0..coloring.count() {
                coloring
                    .seed_into(color, &signs, &mut seed)
                    .map_err(fatal)?;
                self.evaluate(t, y, yp, Some(&seed), cj, Some(&mut reuse))?;
                for (d, r) in directions.iter_mut().zip(&self.rows) {
                    *d = r.direction;
                }
                sparse::scatter(&pattern, &coloring, color, &directions, &signs, values)
                    .map_err(|e| fatal(format!("color {color}: {e}")))?;
            }
            Ok(())
        })();
        self.structure = Some((pattern, coloring));
        self.counters.jacobians += 1;
        self.counters.jacobian_wall_s += started.elapsed().as_secs_f64();
        result
    }

    /// Network coordinates of a regular cell (or the PZR block).
    fn cell(&self, c: usize) -> std::ops::Range<usize> {
        if c == self.network.pzr.cell {
            return self.network.pzr.coordinates();
        }
        let base = self.network.cell_layout[c].base;
        base..base + 6
    }
    fn impulses(&self, f: usize) -> [usize; 2] {
        [
            self.network.face_layout[2 * f].index,
            self.network.face_layout[2 * f + 1].index,
        ]
    }
    /// Every coordinate a face's chart reads: impulses, supports, endpoints.
    fn face_flux(&self, f: usize, out: &mut BTreeSet<usize>) {
        out.extend(self.impulses(f));
        let face = &self.faces[f];
        for r in face.supports.iter().chain([&face.from, &face.to]) {
            out.extend(self.cell(*r));
        }
    }
    /// Every coordinate a wall law at cell `c` reads: its water and the
    /// charts of its incident faces (the mass flux).
    fn wall(&self, c: usize, out: &mut BTreeSet<usize>) {
        out.extend(self.cell(c));
        for f in 0..self.faces.len() {
            if self.faces[f].from == c || self.faces[f].to == c {
                self.face_flux(f, out);
            }
        }
    }

    /// The joined structural pattern: rows per column, sorted and unique.
    pub fn structural_pattern(&self) -> Result<Vec<Vec<usize>>, Failure> {
        let o = self.blocks.offsets;
        let n = o.end;
        let mut columns: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); n];
        let add =
            |columns: &mut Vec<BTreeSet<usize>>, rows: &BTreeSet<usize>, cols: &BTreeSet<usize>| {
                for c in cols {
                    columns[*c].extend(rows.iter().copied());
                }
            };
        for (c, rows) in self.network.structural_pattern().into_iter().enumerate() {
            columns[c].extend(rows);
        }
        let nuc = &self.blocks.nuclear;
        let sol = &self.blocks.solids;
        let (regions, carriers) = (nuc.regions(), nuc.carriers());
        let mut regions_of = vec![BTreeSet::new(); carriers];
        let mut carriers_of = vec![BTreeSet::new(); regions];
        for support in nuc.supports() {
            regions_of[support.material].insert(support.region);
            carriers_of[support.region].insert(support.material);
        }
        let n_of = |i: usize| o.nuclear + i;
        let carrier_vars = |a: usize, out: &mut BTreeSet<usize>| {
            for g in 0..6 {
                out.insert(o.nuclear + nuc.precursor(a, g));
                out.insert(o.nuclear + nuc.material(a, g));
            }
            for g in 0..nuclear::HISTORIES {
                out.insert(o.nuclear + nuc.history(a, g));
            }
        };
        let carrier_rows = |a: usize| {
            let mut rows = BTreeSet::new();
            carrier_vars(a, &mut rows);
            rows
        };
        // Every nuclear row of a carrier: its own nuclear state and the
        // populations of its support regions.
        let heat_source = |a: usize, out: &mut BTreeSet<usize>| {
            carrier_vars(a, out);
            out.extend(regions_of[a].iter().map(|i| n_of(*i)));
        };
        // A carrier's prompt and binding heat: its fissions and captures,
        // which read the support populations, fissile, fertile, Xe and Sm.
        let events = |a: usize, out: &mut BTreeSet<usize>| {
            for k in [0, 1, 3, 5] {
                out.insert(o.nuclear + nuc.material(a, k));
            }
            out.extend(regions_of[a].iter().map(|i| n_of(*i)));
        };
        // Its fuel heat adds the released history energy.
        let fuel_heat = |a: usize, out: &mut BTreeSet<usize>| {
            events(a, out);
            for g in 0..nuclear::HISTORIES {
                out.insert(o.nuclear + nuc.history(a, g));
            }
        };
        let half_vars = |a: usize, out: &mut BTreeSet<usize>| {
            for k in 0..3 {
                out.insert(o.solids + sol.energy(a, k));
                out.insert(o.solids + sol.surface(a, k));
            }
        };
        let incidence = sol.incidence();
        let rod_outputs: BTreeSet<usize> = match &self.blocks.rods {
            RodPort::Owner(b) => b
                .structure()
                .outputs
                .iter()
                .flatten()
                .map(|i| o.rods + i)
                .collect(),
            RodPort::Prepared(_) => BTreeSet::new(),
        };
        let secondary_outputs: Vec<BTreeSet<usize>> = match &self.blocks.secondary {
            SecondaryPort::Owner(b) => b
                .structure()
                .outputs
                .iter()
                .map(|v| v.iter().map(|i| o.secondary + i).collect())
                .collect(),
            SecondaryPort::Prepared(_) => vec![BTreeSet::new(); sol.secondaries()],
        };
        // 1. Nuclear rows.
        for (i, carriers_i) in carriers_of.iter().enumerate() {
            let rows = BTreeSet::from([n_of(i)]);
            let mut cols: BTreeSet<usize> = (0..regions).map(n_of).collect();
            for a in carriers_i {
                for g in 0..6 {
                    cols.insert(o.nuclear + nuc.precursor(*a, g));
                }
                for k in [0, 1, 3, 5] {
                    cols.insert(o.nuclear + nuc.material(*a, k));
                }
                cols.insert(o.solids + sol.energy(*a, 0));
                cols.insert(o.solids + sol.energy(*a, 1));
            }
            cols.extend(self.cell(self.blocks.source_water[i]));
            cols.extend(rod_outputs.iter().copied());
            add(&mut columns, &rows, &cols);
        }
        for a in 0..carriers {
            let rows = carrier_rows(a);
            let mut cols = BTreeSet::new();
            heat_source(a, &mut cols);
            add(&mut columns, &rows, &cols);
        }
        // 2. Solid rows.
        for (a, (helium, cells)) in incidence.halves.iter().enumerate() {
            let mut rows = BTreeSet::new();
            half_vars(a, &mut rows);
            let mut cols = rows.clone();
            cols.insert(o.solids + sol.helium(*helium));
            fuel_heat(a, &mut cols);
            for c in cells {
                self.wall(*c, &mut cols);
            }
            add(&mut columns, &rows, &cols);
        }
        for h in 0..incidence
            .halves
            .iter()
            .map(|(h, _)| h + 1)
            .max()
            .unwrap_or(0)
        {
            let rows = BTreeSet::from([o.solids + sol.helium(h)]);
            let mut cols = rows.clone();
            for (a, (helium, _)) in incidence.halves.iter().enumerate() {
                if *helium == h {
                    half_vars(a, &mut cols);
                }
            }
            for (helium, p) in &incidence.plenum {
                if *helium == h {
                    cols.insert(o.solids + sol.passive(*p));
                }
            }
            add(&mut columns, &rows, &cols);
        }
        let passive_count = incidence
            .passive
            .iter()
            .map(|(p, _)| p + 1)
            .chain(incidence.plenum.iter().map(|(_, p)| p + 1))
            .max()
            .unwrap_or(0);
        for p in 0..passive_count {
            let rows = BTreeSet::from([o.solids + sol.passive(p)]);
            let mut cols = rows.clone();
            for (q, c) in &incidence.passive {
                if *q == p {
                    cols.extend(self.cell(*c));
                }
            }
            for (h, q) in &incidence.plenum {
                if *q == p {
                    cols.insert(o.solids + sol.helium(*h));
                }
            }
            add(&mut columns, &rows, &cols);
        }
        for (i, (primary, secondary)) in incidence.segments.iter().enumerate() {
            let rows = BTreeSet::from([o.solids + sol.metal(i)]);
            let mut cols = rows.clone();
            self.wall(*primary, &mut cols);
            cols.extend(secondary_outputs[*secondary].iter().copied());
            add(&mut columns, &rows, &cols);
        }
        // 3. Network stock rows through the heat port.
        let cells = self.network.cell_layout.len();
        for c in 0..cells {
            let rows: BTreeSet<usize> = self.cell(c).collect();
            let mut cols = BTreeSet::new();
            for (a, (_, wets)) in incidence.halves.iter().enumerate() {
                if wets.contains(&c) {
                    half_vars(a, &mut cols);
                }
            }
            for (a, deposits) in nuc.deposition().iter().enumerate() {
                if deposits.iter().any(|(cell, _)| *cell == c) {
                    events(a, &mut cols);
                }
            }
            for (p, water) in &incidence.passive {
                if *water == c {
                    cols.insert(o.solids + sol.passive(*p));
                }
            }
            for (i, (primary, _)) in incidence.segments.iter().enumerate() {
                if *primary == c {
                    cols.insert(o.solids + sol.metal(i));
                }
            }
            add(&mut columns, &rows, &cols);
        }
        // 4. The owners' rows and receipts.
        if let RodPort::Owner(b) = &self.blocks.rods {
            let st = b.structure();
            for (r, own) in st.own.iter().enumerate() {
                let rows = BTreeSet::from([o.rods + r]);
                let mut cols: BTreeSet<usize> = own.iter().map(|i| o.rods + i).collect();
                for c in st.cells.get(r).into_iter().flatten() {
                    cols.extend(self.cell(*c));
                }
                for f in st.faces.get(r).into_iter().flatten() {
                    self.face_flux(*f, &mut cols);
                }
                add(&mut columns, &rows, &cols);
            }
            for (cell, own, read) in &st.receipts {
                let mut rows: BTreeSet<usize> = self.cell(*cell).collect();
                for (f, face) in self.faces.iter().enumerate() {
                    if face.supports.contains(cell) {
                        rows.extend(self.impulses(f));
                    }
                }
                let mut cols: BTreeSet<usize> = own.iter().map(|i| o.rods + i).collect();
                for c in read {
                    cols.extend(self.cell(*c));
                }
                add(&mut columns, &rows, &cols);
            }
        }
        if let SecondaryPort::Owner(b) = &self.blocks.secondary {
            let st = b.structure();
            for (r, own) in st.own.iter().enumerate() {
                let rows = BTreeSet::from([o.secondary + r]);
                let mut cols: BTreeSet<usize> = own.iter().map(|i| o.secondary + i).collect();
                for g in st.heat.get(r).into_iter().flatten() {
                    for (i, (primary, secondary)) in incidence.segments.iter().enumerate() {
                        if secondary == g {
                            cols.insert(o.solids + sol.metal(i));
                            self.wall(*primary, &mut cols);
                        }
                    }
                    cols.extend(secondary_outputs[*g].iter().copied());
                }
                add(&mut columns, &rows, &cols);
            }
        }
        // Moving volumes: a cell's volume reaches every row its own
        // coordinates reach (EOS, fractions, inertance, feedback density).
        if let RodPort::Owner(b) = &self.blocks.rods {
            for (cell, own) in &b.structure().volumes {
                let mut rows = BTreeSet::new();
                for c in self.cell(*cell) {
                    rows.extend(columns[c].iter().copied());
                }
                let cols: BTreeSet<usize> = own.iter().map(|i| o.rods + i).collect();
                add(&mut columns, &rows, &cols);
            }
        }
        for (c, rows) in columns.iter_mut().enumerate() {
            rows.insert(c);
        }
        Ok(columns
            .into_iter()
            .map(|rows| rows.into_iter().collect())
            .collect())
    }
}

impl<P: Properties + WaterProperties> Blocks<P> {
    /// The rods' travel and cell volumes before the network's cells.
    fn pre_network(
        &mut self,
        y: &[f64],
        yp: &[f64],
        seed: Option<&[f64]>,
        cj: f64,
    ) -> Result<(), Failure> {
        let o = self.offsets;
        match &self.rods {
            RodPort::Owner(b) => {
                let x = view(y, yp, seed, cj, o.rods..o.end, &self.scales[3].coordinates)?;
                b.travel(x, &mut self.travel)?;
                b.volumes(x, &self.compiled_volumes, &mut self.cell_volumes)?;
            }
            RodPort::Prepared(travel) => {
                for (t, v) in self.travel.iter_mut().zip(travel) {
                    *t = s(*v);
                }
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)] // The coupling's stage inputs.
    fn couple(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
        seed: Option<&[f64]>,
        cj: f64,
        fluid: &Fluid<'_>,
        receipts: &mut Receipts<'_>,
        rows: &mut [Scalar],
    ) -> Result<(), Failure> {
        let started = Instant::now();
        let o = self.offsets;
        let Blocks {
            properties,
            nuclear,
            solids,
            secondary,
            rods,
            source_water,
            nuclear_rows,
            solid_rows,
            secondary_rows,
            rod_rows,
            temperatures,
            fuel_t,
            water,
            travel,
            views,
            heats,
            scales,
            ..
        } = self;
        match secondary {
            SecondaryPort::Owner(b) => {
                let x = view(y, yp, seed, cj, o.secondary..o.rods, &scales[2].coordinates)?;
                b.views(properties, x, views)?;
            }
            SecondaryPort::Prepared(v) => views.copy_from_slice(v),
        }
        let xs = view(
            y,
            yp,
            seed,
            cj,
            o.solids..o.secondary,
            &scales[1].coordinates,
        )?;
        solids.temperatures(xs, temperatures)?;
        for (a, f) in fuel_t.iter_mut().enumerate() {
            *f = thermal::fuel_feedback_temperature(
                temperatures.fuel[a][0],
                temperatures.fuel[a][1],
            )
            .map_err(trial)?;
        }
        for (i, w) in water.iter_mut().enumerate() {
            let j = source_water[i];
            let liquid = fluid.liquid_mass[j];
            let (q, d) = fluid.points[j][0]
                .ok_or_else(|| trial(format!("source region {i}'s cell {j} has no liquid")))?;
            *w = RegionWater {
                density_kg_m3: (liquid + fluid.vapor_mass[j]) / fluid.current_volumes[j],
                boron_ppm_eq: s(1e6) * fluid.tracer[j] / liquid,
                pressure_pa: fluid.cells[j].pressure,
                temperature_k: Scalar::new(q.temperature_k, d.temperature_k),
            };
        }
        let xn = view(y, yp, seed, cj, o.nuclear..o.solids, &scales[0].coordinates)?;
        nuclear.rows(
            t,
            xn,
            fuel_t,
            water,
            travel,
            nuclear_rows,
            &mut heats.nuclear,
        )?;
        heats.coolant_w = s(0.);
        for (a, deposits) in nuclear.deposition().iter().enumerate() {
            for (cell, fraction) in deposits {
                let q = s(*fraction) * heats.nuclear.coolant_w[a];
                heats.coolant_w = heats.coolant_w + q;
                receipts.heat(*cell, q)?;
            }
        }
        solids.wall_water(properties, fluid)?;
        solids.rows(
            properties,
            xs,
            temperatures,
            &heats.nuclear.fuel_w,
            fluid,
            views,
            receipts,
            solid_rows,
            &mut heats.solids,
        )?;
        if let RodPort::Owner(b) = rods {
            if let Some(done) = self.prepare.as_mut() {
                done.push(b.prepare(properties, fluid)?);
            }
            let x = view(y, yp, seed, cj, o.rods..o.end, &scales[3].coordinates)?;
            b.rows(properties, t, x, fluid, receipts, rod_rows)?;
        }
        if let SecondaryPort::Owner(b) = secondary {
            let x = view(y, yp, seed, cj, o.secondary..o.rods, &scales[2].coordinates)?;
            b.rows(properties, t, x, &heats.solids.secondary_w, secondary_rows)?;
        }
        // Scale every block's physical rows into the joined rows.
        let mut k = 0;
        for (physical, block) in [nuclear_rows, solid_rows, secondary_rows, rod_rows]
            .into_iter()
            .zip(scales.iter())
        {
            for (r, row_scale) in physical.iter().zip(&block.rows) {
                rows[k] = *r / s(*row_scale);
                k += 1;
            }
        }
        if rows
            .iter()
            .any(|r| !(r.value.is_finite() && r.direction.is_finite()))
        {
            return Err(trial("nonfinite joined block row"));
        }
        self.coupled_wall_s += started.elapsed().as_secs_f64();
        Ok(())
    }
}

/// The joined blocks as the network's coupling for one evaluation.
struct Coupler<'a, P> {
    blocks: &'a mut Blocks<P>,
    t: f64,
    y: &'a [f64],
    yp: &'a [f64],
    seed: Option<&'a [f64]>,
    cj: f64,
    rows: &'a mut [Scalar],
}

impl<P: Properties + WaterProperties> Coupling for Coupler<'_, P> {
    fn couple(&mut self, fluid: &Fluid<'_>, receipts: &mut Receipts<'_>) -> Result<(), Failure> {
        self.blocks.couple(
            self.t, self.y, self.yp, self.seed, self.cj, fluid, receipts, self.rows,
        )
    }
}
