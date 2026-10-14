//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-spine-at-power
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-block-interface
//! The composed joined residual and its colored stage Jacobian.
//!
//! `y` is `[network | nuclear | solids | secondary | rods | pzr]`. One evaluation
//! takes the rods' travel and cell volumes, then evaluates the network with
//! this operator as its coupling: inside the coupling the SG views, the
//! solids' temperatures, the nuclear rows, the solids' rows and heats, the
//! rod rows and receipts and the secondary rows are evaluated on the
//! network's fluid state of the same call; the PZR block (G6) is evaluated
//! inside the network's stratified rows, on the cell's column of the same
//! call, as the cell's boundary (`Coupling::pzr_boundary`). Rows are the
//! network's own scaled rows, then every block's physical rows divided by
//! their row scales.
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
    pzr::Pzr,
    solids::{self, Solids},
};
use crate::{
    network::{
        Coupling, Failure, Fluid, Network, PZR_PRESSURE, Properties, Receipts, Reuse,
        packet::Packet as NetworkPacket, stratified,
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
    /// The PZR metal and relief block (G6); empty while its owner is not
    /// composed.
    pub pzr: usize,
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
    /// The PZR metal and relief owner (G6), from the packet's `pzrMetal`
    /// section; `None` for a packet compiled before G6, whose cell then
    /// declares no relief and keeps a closed boundary.
    pzr: Option<Pzr>,
    offsets: Offsets,
    source_water: Vec<usize>,
    compiled_volumes: Vec<f64>,
    nuclear_rows: Vec<Scalar>,
    solid_rows: Vec<Scalar>,
    secondary_rows: Vec<Scalar>,
    rod_rows: Vec<Scalar>,
    pzr_rows: Vec<Scalar>,
    temperatures: solids::Temperatures,
    fuel_t: Vec<Scalar>,
    water: Vec<RegionWater>,
    travel: Vec<Scalar>,
    views: Vec<SecondaryView>,
    cell_volumes: Vec<CellVolume>,
    heats: Heats,
    coupled_wall_s: f64,
    /// Nuclear, solids, secondary, rods and the PZR block, in that order.
    scales: [Scales; 5],
    /// One startup evaluation lets the rod owner prepare its algebraic
    /// coordinates on that evaluation's fluid state ([`Joined::prepare_owners`]).
    prepare: Option<Vec<super::block::Transaction>>,
    /// A root evaluation collects the rod owner's roots on the same fluid
    /// state ([`Joined::roots`]).
    rod_roots: Option<Vec<f64>>,
    /// The rod owner's network reads and receipt cells, for local coupling.
    rod_reads: Option<RodReads>,
    /// Per SG: the secondary owner's own coordinates its view reads.
    secondary_outputs: Vec<Vec<usize>>,
    /// Per solid coordinate: the closed scope of its owner column and the
    /// store whose temperature it sets, compiled at first use.
    column_scopes: Vec<Option<(solids::Closed, Option<usize>)>>,
    /// Wall time of the local coupler's calls, by kind.
    coupler: CouplerCounters,
}

/// Calls and wall time of the local coupler during block Jacobians, by
/// kind: network columns' `local`, the owner columns by owner, and the two
/// port columns.
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct CouplerCounters {
    pub local: Tally,
    /// Inside `local`: the solids' wall refresh and closed-scope rows, and
    /// the rod clusters' evaluation when reached.
    pub local_solids: Tally,
    pub local_rods: Tally,
    /// The PZR block's terms: network PZR columns' boundaries and its own
    /// columns (G6).
    pub pzr: Tally,
    pub solid_columns: Tally,
    pub secondary_columns: Tally,
    pub rod_columns: Tally,
    pub fuel_heat_columns: Tally,
    pub secondary_heat_columns: Tally,
}
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct Tally {
    pub calls: usize,
    pub wall_s: f64,
}
impl Tally {
    fn add(&mut self, started: Instant) {
        self.calls += 1;
        self.wall_s += started.elapsed().as_secs_f64();
    }
}

/// Network cells and faces any rod row or receipt reads, and the cells its
/// receipts enter (from the owner's [`Structure`](super::block::Structure)).
#[derive(Clone, Debug)]
struct RodReads {
    cells: Vec<bool>,
    faces: Vec<bool>,
    receipt_cells: Vec<usize>,
    /// Cells whose volume the rods move.
    volume_cells: Vec<usize>,
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
        // G6: the PZR owner composes from its section, its steel at the
        // prepared cell's Tsat(p_s); a relief port needs it.
        let pzr = match &packet.pzr_metal {
            Some(section) => Some(Pzr::new(
                network.stratified(),
                section,
                network.pzr_saturation_temperature_k(),
            )?),
            None => {
                if let Some(port) = network
                    .stratified()
                    .parameters()
                    .ports
                    .iter()
                    .find(|p| p.kind == stratified::PortKind::Relief)
                {
                    return Err(fatal(format!(
                        "relief port {} needs the PZR owner's packet section (pzrMetal)",
                        port.id
                    )));
                }
                None
            }
        };
        let pzr_len = pzr.as_ref().map_or(0, |b| b.layout().len());
        let n = network.dimension();
        let rods_at = n + nuclear.layout().len() + solids.layout().len() + secondary_len;
        let offsets = Offsets {
            nuclear: n,
            solids: n + nuclear.layout().len(),
            secondary: n + nuclear.layout().len() + solids.layout().len(),
            rods: rods_at,
            pzr: rods_at + rods_len,
            end: rods_at + rods_len + pzr_len,
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
            pzr.as_ref()
                .map_or_else(Scales::default, |b| Scales::of(b.layout())),
        ];
        let rod_reads = match &rods {
            RodPort::Owner(b) => {
                let st = b.structure();
                let mut reads = RodReads {
                    cells: vec![false; cells],
                    faces: vec![false; faces.len()],
                    receipt_cells: st.receipts.iter().map(|r| r.0).collect(),
                    volume_cells: st.volumes.iter().map(|v| v.0).collect(),
                };
                for c in st
                    .cells
                    .iter()
                    .flatten()
                    .chain(st.receipts.iter().flat_map(|r| &r.2))
                {
                    *reads.cells.get_mut(*c).ok_or_else(|| {
                        fatal("rod structure reads a cell outside the regular cells")
                    })? = true;
                }
                for f in st.faces.iter().flatten() {
                    *reads
                        .faces
                        .get_mut(*f)
                        .ok_or_else(|| fatal("rod structure reads an unknown face"))? = true;
                }
                reads.receipt_cells.sort_unstable();
                reads.receipt_cells.dedup();
                Some(reads)
            }
            RodPort::Prepared(_) => None,
        };
        let secondary_outputs = match &secondary {
            SecondaryPort::Owner(b) => b.structure().outputs,
            SecondaryPort::Prepared(_) => Vec::new(),
        };
        let blocks = Blocks {
            scales,
            prepare: None,
            rod_roots: None,
            rod_reads,
            secondary_outputs,
            column_scopes: vec![None; solids.layout().len()],
            coupler: CouplerCounters::default(),
            nuclear_rows: vec![s(0.); nuclear.layout().len()],
            solid_rows: vec![s(0.); solids.layout().len()],
            secondary_rows: vec![s(0.); secondary_len],
            rod_rows: vec![s(0.); rods_len],
            pzr_rows: vec![s(0.); pzr_len],
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
            pzr,
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
    /// The local coupler's calls and wall time over every block Jacobian.
    pub fn coupler_counters(&self) -> CouplerCounters {
        self.blocks.coupler
    }
    pub fn temperatures(&self) -> &solids::Temperatures {
        &self.blocks.temperatures
    }
    pub fn travel(&self) -> &[Scalar] {
        &self.blocks.travel
    }
    /// The source feedback's water conditions of the last evaluation, per
    /// region: exactly the port values the nuclear rows read.
    pub fn region_water(&self) -> &[RegionWater] {
        &self.blocks.water
    }
    /// Each carrier's feedback fuel temperature of the last evaluation.
    pub fn fuel_feedback_temperatures(&self) -> &[Scalar] {
        &self.blocks.fuel_t
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
    /// The PZR metal and relief owner (G6), when composed.
    pub fn pzr(&self) -> Option<&Pzr> {
        self.blocks.pzr.as_ref()
    }
    pub fn pzr_mut(&mut self) -> Option<&mut Pzr> {
        self.blocks.pzr.as_mut()
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
        if let Some(b) = &self.blocks.pzr {
            out.push(("pzr", b.layout().clone()));
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
        if let Some(b) = &self.blocks.pzr {
            push(b.prepared(), b.layout());
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
        if let Some(b) = &self.blocks.pzr {
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

    /// Root functions: the secondary owner's, the rod owner's (on one
    /// value evaluation's fluid state), then the PZR relief's (on the roof
    /// pressure and the lift). Stock IDA cannot retry a root, so every
    /// failure is fatal.
    pub fn root_count(&self) -> usize {
        self.secondary().map_or(0, |b| b.root_count())
            + self.rods().map_or(0, |b| b.root_count())
            + self.pzr().map_or(0, |b| b.root_count())
    }
    /// The PZR block's physical coordinates and the roof pressure of `y`.
    fn pzr_state(&self, y: &[f64]) -> (Vec<f64>, f64) {
        let o = self.blocks.offsets;
        let roof = self.network.pzr.base + PZR_PRESSURE;
        (
            (o.pzr..o.end)
                .zip(&self.blocks.scales[4].coordinates)
                .map(|(i, s)| y[i] * s)
                .collect(),
            y[roof] * self.network.scales()[roof],
        )
    }
    pub fn roots(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        let o = self.blocks.offsets;
        let ns = self.secondary().map_or(0, |b| b.root_count());
        let nr = self.rods().map_or(0, |b| b.root_count());
        let np = self.pzr().map_or(0, |b| b.root_count());
        if out.len() != ns + nr + np {
            return Err(fatal("root layout"));
        }
        if let Some(b) = self.pzr() {
            let (x, roof) = self.pzr_state(y);
            b.roots(roof, &x, &mut out[ns + nr..])?;
        }
        if let SecondaryPort::Owner(b) = &mut self.blocks.secondary {
            let x = view(
                y,
                yp,
                None,
                0.,
                o.secondary..o.rods,
                &self.blocks.scales[2].coordinates,
            )?;
            b.roots(&self.blocks.properties, t, x, &mut out[..ns])?;
        }
        if nr > 0 {
            self.blocks.rod_roots = Some(vec![0.; nr]);
            let evaluated = self.evaluate(t, y, yp, None, 0., None);
            let roots = self.blocks.rod_roots.take().unwrap_or_default();
            evaluated.map_err(|e| match e {
                Failure::Recoverable(r) | Failure::Fatal(r) => {
                    fatal(format!("root evaluation: {r}"))
                }
            })?;
            out[ns..ns + nr].copy_from_slice(&roots);
        }
        Ok(())
    }
    /// The owners' transactions at located roots (`directions` per root,
    /// owners' order): each owner may change its own coordinates of `y`
    /// (solver scaling here, physical in the owner); energy deposits enter
    /// their named passive stores once. Consistency is then the caller's
    /// exact consistent start.
    pub fn transact(
        &mut self,
        t: f64,
        directions: &[i32],
        y: &mut [f64],
    ) -> Result<Vec<super::block::Transaction>, Failure> {
        let o = self.blocks.offsets;
        let ns = self.secondary().map_or(0, |b| b.root_count());
        let nr = self.rods().map_or(0, |b| b.root_count());
        if directions.len() != self.root_count() {
            return Err(fatal("transaction root layout"));
        }
        let (mut pzr_x, roof) = self.pzr_state(y);
        let mut done = Vec::new();
        let b = &mut self.blocks;
        if let SecondaryPort::Owner(owner) = &mut b.secondary
            && directions[..ns].iter().any(|d| *d != 0)
        {
            let scales = &b.scales[2].coordinates;
            let mut x: Vec<f64> = (o.secondary..o.rods)
                .zip(scales)
                .map(|(i, s)| y[i] * s)
                .collect();
            done.push(owner.transact(&b.properties, t, &directions[..ns], &mut x)?);
            for ((i, v), s) in (o.secondary..o.rods).zip(&x).zip(scales) {
                y[i] = v / s;
            }
        }
        if let RodPort::Owner(owner) = &mut b.rods
            && directions[ns..ns + nr].iter().any(|d| *d != 0)
        {
            let scales = &b.scales[3].coordinates;
            let mut x: Vec<f64> = (o.rods..o.pzr).zip(scales).map(|(i, s)| y[i] * s).collect();
            done.push(owner.transact(&b.properties, t, &directions[ns..ns + nr], &mut x)?);
            for ((i, v), s) in (o.rods..o.pzr).zip(&x).zip(scales) {
                y[i] = v / s;
            }
        }
        if let Some(owner) = &mut b.pzr
            && directions[ns + nr..].iter().any(|d| *d != 0)
        {
            done.push(owner.transact(t, &directions[ns + nr..], roof, &mut pzr_x)?);
            for ((i, v), s) in (o.pzr..o.end).zip(&pzr_x).zip(&b.scales[4].coordinates) {
                y[i] = v / s;
            }
        }
        self.deposit(&done, y)?;
        Ok(done)
    }
    /// A declared command to every composed owner, in order, followed by
    /// any time event the command makes due at once ([`Joined::time_events`]).
    pub fn command(
        &mut self,
        t: f64,
        y: &mut [f64],
        command: super::block::Command,
    ) -> Result<Vec<super::block::Transaction>, Failure> {
        let mut done = Vec::new();
        if let Some(b) = self.secondary_mut() {
            done.push(b.command(t, command)?);
        }
        if let Some(b) = self.rods_mut() {
            done.push(b.command(t, command)?);
        }
        if let Some(b) = self.pzr() {
            done.push(b.command(t, command));
        }
        self.deposit(&done, y)?;
        done.extend(self.time_events(t, y)?);
        Ok(done)
    }
    /// The owners' transactions of every time event due exactly at `t`: at
    /// a stop at [`Joined::next_time_event`] and after a command. Each owner
    /// changes only its own coordinates of `y` (written back in solver
    /// scaling before any restart); deposits enter their passive stores
    /// once. The caller then updates the differential identity and restarts
    /// by the exact consistent start.
    pub fn time_events(
        &mut self,
        t: f64,
        y: &mut [f64],
    ) -> Result<Vec<super::block::Transaction>, Failure> {
        let o = self.blocks.offsets;
        let mut done = Vec::new();
        let b = &mut self.blocks;
        if let SecondaryPort::Owner(owner) = &mut b.secondary {
            let scales = &b.scales[2].coordinates;
            let mut x: Vec<f64> = (o.secondary..o.rods)
                .zip(scales)
                .map(|(i, s)| y[i] * s)
                .collect();
            if let Some(d) = owner.time_event(&b.properties, t, &mut x)? {
                done.push(d);
                for ((i, v), s) in (o.secondary..o.rods).zip(&x).zip(scales) {
                    y[i] = v / s;
                }
            }
        }
        if let RodPort::Owner(owner) = &mut b.rods {
            let scales = &b.scales[3].coordinates;
            let mut x: Vec<f64> = (o.rods..o.pzr).zip(scales).map(|(i, s)| y[i] * s).collect();
            if let Some(d) = owner.time_event(&b.properties, t, &mut x)? {
                done.push(d);
                for ((i, v), s) in (o.rods..o.pzr).zip(&x).zip(scales) {
                    y[i] = v / s;
                }
            }
        }
        self.deposit(&done, y)?;
        Ok(done)
    }
    /// The earliest declared time event of any owner strictly after `t`.
    pub fn next_time_event(&self, t: f64) -> Option<f64> {
        [
            self.secondary().and_then(|b| b.next_time_event(t)),
            self.rods().and_then(|b| b.next_time_event(t)),
        ]
        .into_iter()
        .flatten()
        .reduce(f64::min)
    }
    fn deposit(&self, done: &[super::block::Transaction], y: &mut [f64]) -> Result<(), Failure> {
        let o = self.blocks.offsets;
        for (store, energy) in done.iter().flat_map(|t| &t.deposits) {
            let i = self
                .blocks
                .solids
                .passive_store(store)
                .ok_or_else(|| fatal(format!("deposit into unknown passive store {store}")))?;
            let scale = self.blocks.scales[1].coordinates[i];
            y[o.solids + i] += energy / scale;
        }
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

    /// The network and a local coupler over the blocks, borrowed disjointly,
    /// for a block Jacobian's network columns at `(t, y, y')` and `cj`.
    pub fn local_parts<'a>(
        &'a mut self,
        t: f64,
        y: &'a [f64],
        yp: &'a [f64],
        cj: f64,
    ) -> (&'a Network<P>, LocalCoupler<'a, P>) {
        let endpoints = self.faces.iter().map(|f| (f.from, f.to)).collect();
        let rod_rows = Vec::new();
        let scratch = Scratch {
            seed: vec![0.; self.blocks.offsets.end],
            secondary_rows: vec![s(0.); self.blocks.secondary_rows.len()],
            sink: vec![[[s(0.); 3]; 2]; self.blocks.compiled_volumes.len()],
            ..Scratch::default()
        };
        (
            &self.network,
            LocalCoupler {
                blocks: &mut self.blocks,
                t,
                rod_rows,
                scratch,
                y,
                yp,
                cj,
                endpoints,
                last: LocalRows::default(),
                solid_rows: Vec::new(),
                heat: solids::Heat::default(),
                last_pzr: Vec::new(),
            },
        )
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
        // 5. The PZR block (G6): each steel row reads the cell's column (the
        // cell's coordinates) and the steels its enclosure couples; the lift
        // row its own lift. The cell's rows read every block coordinate
        // through the boundary: heater and wall receipts and the relief.
        if let Some(b) = &self.blocks.pzr {
            let cell: BTreeSet<usize> = self.network.pzr.coordinates().collect();
            let metal: BTreeSet<usize> = (o.pzr + b.metal_base()..o.end).collect();
            let mut cols = cell.clone();
            cols.extend(metal.iter().copied());
            add(&mut columns, &metal, &cols);
            let own: BTreeSet<usize> = (o.pzr..o.end).collect();
            add(&mut columns, &cell, &own);
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
                let x = view(y, yp, seed, cj, o.rods..o.pzr, &self.scales[3].coordinates)?;
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
            *w = region_water(fluid, i, source_water[i])?;
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
            if let Some(out) = self.rod_roots.as_mut() {
                let x = view(y, yp, seed, cj, o.rods..o.pzr, &scales[3].coordinates)?;
                b.roots(properties, t, x, fluid, out)?;
            }
            let x = view(y, yp, seed, cj, o.rods..o.pzr, &scales[3].coordinates)?;
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

    /// The PZR block's rows (into the joined `rows`, block scaling) and the
    /// stratified cell's boundary on `column`, at the block's coordinates
    /// with `seed`. With no PZR owner (a packet compiled before G6, whose
    /// cell declares no relief) the boundary is closed.
    #[allow(clippy::too_many_arguments)] // The coupling's stage inputs and the cell's column.
    fn pzr_boundary(
        &mut self,
        y: &[f64],
        yp: &[f64],
        seed: Option<&[f64]>,
        cj: f64,
        cell: &stratified::Cell,
        column: &stratified::Column,
        rows: &mut [Scalar],
    ) -> Result<stratified::Boundary, Failure> {
        let o = self.offsets;
        let Some(b) = self.pzr.as_mut() else {
            return Ok(stratified::Boundary::closed());
        };
        let x = view(y, yp, seed, cj, o.pzr..o.end, &self.scales[4].coordinates)?;
        let boundary = b.boundary(
            &self.properties,
            cell,
            column,
            x,
            &mut self.pzr_rows,
            seed.is_none(),
        )?;
        let first = o.pzr - o.nuclear;
        for (k, (r, row_scale)) in self.pzr_rows.iter().zip(&self.scales[4].rows).enumerate() {
            let v = *r / s(*row_scale);
            if !(v.value.is_finite() && v.direction.is_finite()) {
                return Err(trial("nonfinite PZR block row"));
            }
            rows[first + k] = v;
        }
        Ok(boundary)
    }
}

/// The source feedback's water of region `i` from its owner cell `j`:
/// `rho = (M_l + M_v)/V(y)`, ppm from the liquid tracer, the local pressure
/// and the liquid temperature, with their directions.
fn region_water(fluid: &Fluid<'_>, i: usize, j: usize) -> Result<RegionWater, Failure> {
    let liquid = fluid.liquid_mass[j];
    let (q, d) = fluid.points[j][0]
        .ok_or_else(|| trial(format!("source region {i}'s cell {j} has no liquid")))?;
    Ok(RegionWater {
        density_kg_m3: (liquid + fluid.vapor_mass[j]) / fluid.current_volumes[j],
        boron_ppm_eq: s(1e6) * fluid.tracer[j] / liquid,
        pressure_pa: fluid.cells[j].pressure,
        temperature_k: Scalar::new(q.temperature_k, d.temperature_k),
    })
}

/// What one owner column of a block Jacobian moved, all with their
/// directions for a unit seed on the column: global joined rows in solver
/// scaling (solids, secondary and rods), the feedback fuel temperature per
/// carrier, travel per cluster, moving cell volumes and the complete
/// metal-to-secondary heat per SG reached.
#[derive(Clone, Debug, Default)]
pub struct OwnerRows {
    pub rows: Vec<(usize, Scalar)>,
    pub fuel_t: Vec<(usize, Scalar)>,
    pub travel: Vec<(usize, Scalar)>,
    pub volumes: Vec<(usize, CellVolume)>,
    pub secondary_w: Vec<(usize, Scalar)>,
}
impl OwnerRows {
    fn clear(&mut self) {
        self.rows.clear();
        self.fuel_t.clear();
        self.travel.clear();
        self.volumes.clear();
        self.secondary_w.clear();
    }
}

/// Reused buffers of the owner columns.
#[derive(Default)]
struct Scratch {
    /// Global unit seed, zero outside the current column.
    seed: Vec<f64>,
    views: Vec<SecondaryView>,
    heat_w: Vec<Scalar>,
    secondary_rows: Vec<Scalar>,
    travel: Vec<Scalar>,
    volumes: Vec<CellVolume>,
    /// Receipts of a port whose receipts must stay without direction.
    sink: Vec<[[Scalar; 3]; 2]>,
    /// The rod clusters one call evaluates.
    clusters: Vec<usize>,
}

/// What one local coupling call re-evaluated: global joined rows in solver
/// scaling, the source feedback's water of the regions whose owner cell is
/// listed, and the complete metal-to-secondary heat of each SG reached.
#[derive(Clone, Debug, Default)]
pub struct LocalRows {
    pub rows: Vec<(usize, Scalar)>,
    pub water: Vec<(usize, RegionWater)>,
    pub secondary_w: Vec<(usize, Scalar)>,
}

/// The joined blocks' port terms for one network column of a block
/// Jacobian, on a borrow disjoint from the network ([`Joined::local_parts`]).
/// It requires a preceding unseeded [`Joined::evaluate`] at the same
/// `(t, y, y')`: temperatures, nuclear heat, SG views and every wall water
/// outside the column are that evaluation's, and the owners' coordinates
/// are read unseeded, since a network column moves only the fluid.
pub struct LocalCoupler<'a, P> {
    blocks: &'a mut Blocks<P>,
    t: f64,
    /// The evaluated rod clusters' rows, `(own row, value)`.
    rod_rows: Vec<(usize, Scalar)>,
    scratch: Scratch,
    y: &'a [f64],
    yp: &'a [f64],
    cj: f64,
    endpoints: Vec<(usize, usize)>,
    last: LocalRows,
    solid_rows: Vec<(usize, Scalar)>,
    heat: solids::Heat,
    /// The PZR block's rows of the last PZR call, global joined rows in
    /// solver scaling.
    last_pzr: Vec<(usize, Scalar)>,
}

impl<P: Properties + WaterProperties> LocalCoupler<'_, P> {
    /// The wall cells a column reaches: its listed cells and the endpoints
    /// of its listed faces, each read by a wall's mass flux.
    fn wall_cells(&self, cells: &[usize], faces: &[usize]) -> Vec<usize> {
        let mut wall: Vec<usize> = cells
            .iter()
            .copied()
            .chain(
                faces
                    .iter()
                    .flat_map(|f| [self.endpoints[*f].0, self.endpoints[*f].1]),
            )
            .collect();
        wall.sort_unstable();
        wall.dedup();
        wall
    }
    fn scope(&self, cells: &[usize], wall: &[usize]) -> solids::Closed {
        let sol = &self.blocks.solids;
        sol.close(&solids::SolidScope {
            bands: sol.halves_wetting(wall),
            passive: sol.passive_wetted_by(cells),
            plenum: Vec::new(),
            segments: sol.segments_wetted_by(wall),
        })
    }
    /// Whether the rod owner reads any of `cells` or `faces`.
    fn rods_reached(&self, cells: &[usize], faces: &[usize]) -> bool {
        self.blocks
            .rod_reads
            .as_ref()
            .is_some_and(|r| cells.iter().any(|c| r.cells[*c]) || faces.iter().any(|f| r.faces[*f]))
    }
    /// Re-evaluate only the port terms reading `cells` (whose fluid state
    /// moved) and `faces` (whose liquid flux moved), closed over incidence,
    /// adding their receipts into `receipts`. [`LocalCoupler::last`] then
    /// holds every row they complete, value for value equal to the full
    /// coupling's. The column's wall water is refreshed for the call and
    /// put back after it, so every other column reads the base water. The
    /// rod clusters that read a listed cell whose fluid moved are evaluated:
    /// their rows and guide receipts ([`Rods::readers`]).
    pub fn local(
        &mut self,
        cells: &[usize],
        faces: &[usize],
        fluid: &Fluid<'_>,
        receipts: &mut Receipts<'_>,
    ) -> Result<(), Failure> {
        let started = Instant::now();
        let result = self.local_terms(cells, faces, fluid, receipts);
        self.blocks.coupler.local.add(started);
        result
    }
    fn local_terms(
        &mut self,
        cells: &[usize],
        faces: &[usize],
        fluid: &Fluid<'_>,
        receipts: &mut Receipts<'_>,
    ) -> Result<(), Failure> {
        let wall = self.wall_cells(cells, faces);
        let scope = self.scope(cells, &wall);
        let o = self.blocks.offsets;
        let Blocks {
            properties,
            solids,
            temperatures,
            views,
            heats,
            scales,
            source_water,
            coupler,
            ..
        } = &mut *self.blocks;
        let solids_started = Instant::now();
        let replaced = solids.wall_water_local(properties, fluid, &wall)?;
        let solved = view(
            self.y,
            self.yp,
            None,
            self.cj,
            o.solids..o.secondary,
            &scales[1].coordinates,
        )
        .and_then(|x| {
            solids.rows_local(
                properties,
                x,
                temperatures,
                &heats.nuclear.fuel_w,
                fluid,
                views,
                &scope,
                receipts,
                &mut self.solid_rows,
                &mut self.heat,
            )
        });
        solids.restore_wall_water(replaced);
        coupler.local_solids.add(solids_started);
        solved?;
        self.last.rows.clear();
        self.last.rows.extend(
            self.solid_rows
                .iter()
                .map(|(i, r)| (o.solids + i, *r / s(scales[1].rows[*i]))),
        );
        self.last.secondary_w.clear();
        self.last.secondary_w.extend(
            scope
                .generators
                .iter()
                .map(|g| (*g, self.heat.secondary_w[*g])),
        );
        self.last.water.clear();
        for (i, j) in source_water.iter().enumerate() {
            if cells.contains(j) {
                self.last.water.push((i, region_water(fluid, i, *j)?));
            }
        }
        if self.rods_reached(cells, faces) {
            let rods_started = Instant::now();
            let Blocks {
                properties,
                rods,
                scales,
                ..
            } = &mut *self.blocks;
            let RodPort::Owner(b) = rods else {
                return Err(fatal("rod reads without a rod owner"));
            };
            let x = view(
                self.y,
                self.yp,
                None,
                self.cj,
                o.rods..o.pzr,
                &scales[3].coordinates,
            )?;
            // Only the clusters reading a moved cell take a direction.
            let clusters = &mut self.scratch.clusters;
            let evaluated = b.readers(x, fluid, cells, faces, clusters).and_then(|()| {
                b.rows_local(
                    properties,
                    self.t,
                    x,
                    fluid,
                    clusters,
                    receipts,
                    &mut self.rod_rows,
                )
            });
            self.blocks.coupler.local_rods.add(rods_started);
            evaluated?;
            let scales = &self.blocks.scales;
            self.last.rows.extend(
                self.rod_rows
                    .iter()
                    .map(|(i, r)| (o.rods + i, *r / s(scales[3].rows[*i]))),
            );
        }
        Ok(())
    }
    pub fn last(&self) -> &LocalRows {
        &self.last
    }
    /// The PZR block's rows of the last [`LocalCoupler::pzr_boundary`] or
    /// [`LocalCoupler::pzr_column`] call.
    pub fn last_pzr(&self) -> &[(usize, Scalar)] {
        &self.last_pzr
    }
    /// The stratified cell's boundary on `column`, a network PZR column's
    /// (base values with its directions), with the block's own coordinates
    /// unseeded; its rows are [`LocalCoupler::last_pzr`]. Closed with no
    /// PZR owner.
    pub fn pzr_boundary(
        &mut self,
        cell: &stratified::Cell,
        column: &stratified::Column,
    ) -> Result<stratified::Boundary, Failure> {
        let started = Instant::now();
        let result = self.pzr_terms(None, cell, column);
        self.blocks.coupler.pzr.add(started);
        result
    }
    /// One PZR block column (global index): the block's rows with a unit
    /// seed on it at the base column `column`, and the boundary with that
    /// seed's directions, which the network's stratified rows read
    /// (`NetworkSeed::pzr_boundary`).
    pub fn pzr_column(
        &mut self,
        global: usize,
        cell: &stratified::Cell,
        column: &stratified::Column,
    ) -> Result<stratified::Boundary, Failure> {
        let o = self.blocks.offsets;
        if !(o.pzr..o.end).contains(&global) {
            return Err(fatal(format!("PZR column {global} outside the PZR block")));
        }
        let started = Instant::now();
        self.scratch.seed[global] = 1.;
        let result = self.pzr_terms(Some(global), cell, column);
        self.scratch.seed[global] = 0.;
        self.blocks.coupler.pzr.add(started);
        result
    }
    fn pzr_terms(
        &mut self,
        seeded: Option<usize>,
        cell: &stratified::Cell,
        column: &stratified::Column,
    ) -> Result<stratified::Boundary, Failure> {
        let o = self.blocks.offsets;
        self.last_pzr.clear();
        let Blocks {
            properties,
            pzr,
            pzr_rows,
            scales,
            ..
        } = &mut *self.blocks;
        let Some(b) = pzr.as_mut() else {
            return Ok(stratified::Boundary::closed());
        };
        let x = view(
            self.y,
            self.yp,
            seeded.map(|_| &self.scratch.seed[..]),
            self.cj,
            o.pzr..o.end,
            &scales[4].coordinates,
        )?;
        let boundary = b.boundary(properties, cell, column, x, pzr_rows, false)?;
        self.last_pzr.extend(
            pzr_rows
                .iter()
                .zip(&scales[4].rows)
                .enumerate()
                .map(|(k, (r, row_scale))| (o.pzr + k, *r / s(*row_scale))),
        );
        Ok(boundary)
    }
    /// What [`LocalCoupler::local`] would reach, without evaluating: the
    /// network cells its receipts enter and the global joined rows it
    /// writes (region water and SG heat are its separate ports).
    pub fn reach(&self, cells: &[usize], faces: &[usize]) -> (Vec<usize>, Vec<usize>) {
        let wall = self.wall_cells(cells, faces);
        let scope = self.scope(cells, &wall);
        let sol = &self.blocks.solids;
        let o = self.blocks.offsets;
        let incidence = sol.incidence();
        let rods = self.rods_reached(cells, faces);
        let rod_receipts = self
            .blocks
            .rod_reads
            .iter()
            .filter(|_| rods)
            .flat_map(|r| r.receipt_cells.iter().copied());
        let mut receipt_cells: Vec<usize> = scope
            .bands
            .iter()
            .flat_map(|b| incidence.halves[*b].1.iter().copied())
            .chain(scope.passive.iter().map(|k| incidence.passive[*k].1))
            .chain(scope.segments.iter().map(|k| incidence.segments[*k].0))
            .chain(rod_receipts)
            .collect();
        receipt_cells.sort_unstable();
        receipt_cells.dedup();
        let rod_rows = if rods { o.rods..o.pzr } else { 0..0 };
        let mut rows: Vec<usize> = scope
            .bands
            .iter()
            .flat_map(|b| (0..3).flat_map(move |k| [sol.energy(*b, k), sol.surface(*b, k)]))
            .chain(scope.helium.iter().map(|h| sol.helium(*h)))
            .chain(scope.stores.iter().map(|p| sol.passive(*p)))
            .chain(scope.segments.iter().map(|g| sol.metal(*g)))
            .map(|i| o.solids + i)
            .chain(rod_rows)
            .collect();
        rows.sort_unstable();
        (receipt_cells, rows)
    }

    /// One solid, secondary or rod column (global index): every owner term
    /// that reads it, with a unit seed on it at the base state and the fluid
    /// unseeded, adding the owners' receipt directions into `receipts`.
    /// - Solids: the closed scope of the elements reading the column, with
    ///   the seeded store's temperature; the feedback fuel temperature of a
    ///   fuel energy; the heat of every SG reached.
    /// - Secondary: the seeded views of the SGs reading the column, their
    ///   segments' metal rows, then the secondary rows with the seeded own
    ///   coordinates and the seeded heat. The heat's path is therefore
    ///   already in `rows`, and `secondary_w` stays empty: chaining it again
    ///   through [`LocalCoupler::secondary_heat_column`] would count it twice.
    /// - Rods: travel, moving volumes, and the rows and guide receipts of
    ///   the clusters reading the column.
    pub fn owner_column(
        &mut self,
        column: usize,
        fluid: &Fluid<'_>,
        receipts: &mut Receipts<'_>,
        out: &mut OwnerRows,
    ) -> Result<(), Failure> {
        let o = self.blocks.offsets;
        out.clear();
        if !(o.solids..o.pzr).contains(&column) {
            return Err(fatal(format!(
                "owner column {column} outside the solid, secondary and rod coordinates"
            )));
        }
        let started = Instant::now();
        self.scratch.seed[column] = 1.;
        let result = if column < o.secondary {
            self.solid_column(column - o.solids, fluid, receipts, out)
        } else if column < o.rods {
            self.secondary_column(column - o.secondary, fluid, receipts, out)
        } else {
            self.rod_column(column, fluid, receipts, out)
        };
        self.scratch.seed[column] = 0.;
        let c = &mut self.blocks.coupler;
        if column < o.secondary {
            c.solid_columns.add(started);
        } else if column < o.rods {
            c.secondary_columns.add(started);
        } else {
            c.rod_columns.add(started);
        }
        result
    }

    /// The solids' rows reading local solid coordinate `i`. Its closed
    /// scope is compiled once per coordinate; the seeded store's
    /// temperature is set in place for the call and restored after it.
    fn solid_column(
        &mut self,
        i: usize,
        fluid: &Fluid<'_>,
        receipts: &mut Receipts<'_>,
        out: &mut OwnerRows,
    ) -> Result<(), Failure> {
        let o = self.blocks.offsets;
        let Blocks {
            properties,
            solids,
            temperatures,
            views,
            heats,
            scales,
            column_scopes,
            ..
        } = &mut *self.blocks;
        if column_scopes[i].is_none() {
            let (scope, store) = solids.column_scope(i)?;
            column_scopes[i] = Some((solids.close(&scope), store));
        }
        let Some((closed, store)) = &column_scopes[i] else {
            return Err(fatal("solid column scope"));
        };
        let x = view(
            self.y,
            self.yp,
            Some(&self.scratch.seed),
            self.cj,
            o.solids..o.secondary,
            &scales[1].coordinates,
        )?;
        let saved = match store {
            Some(k) => Some((*k, *solids.temperature_of(*k, temperatures)?)),
            None => None,
        };
        let evaluated = (|| {
            if let Some((k, _)) = saved {
                solids.temperatures_local(x, &[k], temperatures)?;
            }
            solids.rows_local(
                properties,
                x,
                temperatures,
                &heats.nuclear.fuel_w,
                fluid,
                views,
                closed,
                receipts,
                &mut self.solid_rows,
                &mut self.heat,
            )?;
            let energies = 3 * solids.halves();
            if i < energies && i % 3 < 2 {
                let a = i / 3;
                out.fuel_t.push((
                    a,
                    thermal::fuel_feedback_temperature(
                        temperatures.fuel[a][0],
                        temperatures.fuel[a][1],
                    )
                    .map_err(trial)?,
                ));
            }
            Ok(())
        })();
        if let Some((k, t)) = saved {
            *solids.temperature_of(k, temperatures)? = t;
        }
        evaluated?;
        out.rows.extend(
            self.solid_rows
                .iter()
                .map(|(r, v)| (o.solids + r, *v / s(scales[1].rows[*r]))),
        );
        out.secondary_w.extend(
            closed
                .generators
                .iter()
                .map(|g| (*g, self.heat.secondary_w[*g])),
        );
        Ok(())
    }

    /// The SG views, metal rows and secondary rows reading local secondary
    /// coordinate `j`.
    fn secondary_column(
        &mut self,
        j: usize,
        fluid: &Fluid<'_>,
        receipts: &mut Receipts<'_>,
        out: &mut OwnerRows,
    ) -> Result<(), Failure> {
        let o = self.blocks.offsets;
        let t = self.t;
        let Blocks {
            properties,
            solids,
            secondary,
            temperatures,
            views,
            heats,
            scales,
            secondary_outputs,
            ..
        } = &mut *self.blocks;
        let SecondaryPort::Owner(b) = secondary else {
            return Err(fatal("a secondary column without a secondary owner"));
        };
        let x = view(
            self.y,
            self.yp,
            Some(&self.scratch.seed),
            self.cj,
            o.secondary..o.rods,
            &scales[2].coordinates,
        )?;
        let seeded = &mut self.scratch.views;
        seeded.clone_from(views);
        b.views(properties, x, seeded)?;
        let generators: Vec<usize> = (0..secondary_outputs.len())
            .filter(|k| secondary_outputs[*k].contains(&j))
            .collect();
        let heat_w = &mut self.scratch.heat_w;
        heat_w.clone_from(&heats.solids.secondary_w);
        if !generators.is_empty() {
            let closed = solids.close(&solids::SolidScope {
                segments: solids.segments_of(&generators),
                ..solids::SolidScope::default()
            });
            let xs = view(
                self.y,
                self.yp,
                None,
                self.cj,
                o.solids..o.secondary,
                &scales[1].coordinates,
            )?;
            solids.rows_local(
                properties,
                xs,
                temperatures,
                &heats.nuclear.fuel_w,
                fluid,
                seeded,
                &closed,
                receipts,
                &mut self.solid_rows,
                &mut self.heat,
            )?;
            out.rows.extend(
                self.solid_rows
                    .iter()
                    .map(|(r, v)| (o.solids + r, *v / s(scales[1].rows[*r]))),
            );
            for g in &closed.generators {
                heat_w[*g] = self.heat.secondary_w[*g];
            }
        }
        let rows = &mut self.scratch.secondary_rows;
        b.rows(properties, t, x, heat_w, rows)?;
        out.rows.extend(
            rows.iter()
                .zip(&scales[2].rows)
                .enumerate()
                .map(|(i, (r, row_scale))| (o.secondary + i, *r / s(*row_scale))),
        );
        Ok(())
    }

    /// Travel, moving volumes, and the rows and guide receipts of the
    /// clusters reading the seeded rod coordinate (global `column`).
    fn rod_column(
        &mut self,
        column: usize,
        fluid: &Fluid<'_>,
        receipts: &mut Receipts<'_>,
        out: &mut OwnerRows,
    ) -> Result<(), Failure> {
        let o = self.blocks.offsets;
        let Blocks {
            properties,
            rods,
            scales,
            compiled_volumes,
            rod_reads,
            ..
        } = &mut *self.blocks;
        let RodPort::Owner(b) = rods else {
            return Err(fatal("a rod column without a rod owner"));
        };
        let x = view(
            self.y,
            self.yp,
            Some(&self.scratch.seed),
            self.cj,
            o.rods..o.pzr,
            &scales[3].coordinates,
        )?;
        let travel = &mut self.scratch.travel;
        travel.resize(b.clusters(), s(0.));
        b.travel(x, travel)?;
        out.travel.extend(travel.iter().copied().enumerate());
        let volumes = &mut self.scratch.volumes;
        volumes.resize(
            compiled_volumes.len(),
            CellVolume {
                volume_m3: s(0.),
                rate_m3_s: s(0.),
            },
        );
        b.volumes(x, compiled_volumes, volumes)?;
        let moved = rod_reads.as_ref().map_or(&[][..], |r| &r.volume_cells[..]);
        out.volumes.extend(moved.iter().map(|c| (*c, volumes[*c])));
        // Only the clusters reading the seeded coordinate take a direction.
        let clusters = &mut self.scratch.clusters;
        b.coordinate_readers(column - o.rods, clusters)?;
        b.rows_local(
            properties,
            self.t,
            x,
            fluid,
            clusters,
            receipts,
            &mut self.rod_rows,
        )?;
        out.rows.extend(
            self.rod_rows
                .iter()
                .map(|(i, r)| (o.rods + i, *r / s(scales[3].rows[*i]))),
        );
        Ok(())
    }

    /// The owner rows' response to a unit direction (W) in carrier `a`'s
    /// fuel heat, the nuclear block's `fuel_w` port: that half's rows through
    /// the solids' own split, every coordinate and the fluid unseeded. The
    /// fuel heat enters no receipt; a receipt direction is refused.
    pub fn fuel_heat_column(
        &mut self,
        a: usize,
        fluid: &Fluid<'_>,
        out: &mut OwnerRows,
    ) -> Result<(), Failure> {
        let started = Instant::now();
        let result = self.fuel_heat_terms(a, fluid, out);
        self.blocks.coupler.fuel_heat_columns.add(started);
        result
    }
    fn fuel_heat_terms(
        &mut self,
        a: usize,
        fluid: &Fluid<'_>,
        out: &mut OwnerRows,
    ) -> Result<(), Failure> {
        let o = self.blocks.offsets;
        out.clear();
        let Blocks {
            properties,
            solids,
            temperatures,
            views,
            heats,
            scales,
            ..
        } = &mut *self.blocks;
        if a >= solids.halves() {
            return Err(fatal(format!("fuel heat carrier {a} outside the halves")));
        }
        let closed = solids.close(&solids::SolidScope {
            bands: vec![a],
            ..solids::SolidScope::default()
        });
        let x = view(
            self.y,
            self.yp,
            None,
            self.cj,
            o.solids..o.secondary,
            &scales[1].coordinates,
        )?;
        let fuel_w = &mut self.scratch.heat_w;
        fuel_w.clone_from(&heats.nuclear.fuel_w);
        fuel_w[a] = Scalar::new(fuel_w[a].value, 1.);
        let sink = &mut self.scratch.sink;
        sink.fill([[s(0.); 3]; 2]);
        solids.rows_local(
            properties,
            x,
            temperatures,
            fuel_w,
            fluid,
            views,
            &closed,
            &mut Receipts::new(sink),
            &mut self.solid_rows,
            &mut self.heat,
        )?;
        if sink.iter().flatten().flatten().any(|r| r.direction != 0.) {
            return Err(fatal(
                "fuel heat reaches a network receipt: fuel_heat_column needs a receipt port",
            ));
        }
        out.rows.extend(
            self.solid_rows
                .iter()
                .map(|(r, v)| (o.solids + r, *v / s(scales[1].rows[*r]))),
        );
        Ok(())
    }

    /// The secondary rows' response to a unit direction (W) in SG `g`'s
    /// metal-to-secondary heat, every coordinate unseeded.
    pub fn secondary_heat_column(&mut self, g: usize, out: &mut OwnerRows) -> Result<(), Failure> {
        let started = Instant::now();
        let result = self.secondary_heat_terms(g, out);
        self.blocks.coupler.secondary_heat_columns.add(started);
        result
    }
    fn secondary_heat_terms(&mut self, g: usize, out: &mut OwnerRows) -> Result<(), Failure> {
        let o = self.blocks.offsets;
        out.clear();
        let Blocks {
            properties,
            secondary,
            heats,
            scales,
            ..
        } = &mut *self.blocks;
        let SecondaryPort::Owner(b) = secondary else {
            return Err(fatal("a secondary heat column without a secondary owner"));
        };
        let heat_w = &mut self.scratch.heat_w;
        heat_w.clone_from(&heats.solids.secondary_w);
        let Some(h) = heat_w.get_mut(g) else {
            return Err(fatal(format!("secondary heat column {g} outside the SGs")));
        };
        *h = Scalar::new(h.value, 1.);
        let x = view(
            self.y,
            self.yp,
            None,
            self.cj,
            o.secondary..o.rods,
            &scales[2].coordinates,
        )?;
        let rows = &mut self.scratch.secondary_rows;
        b.rows(properties, self.t, x, heat_w, rows)?;
        out.rows.extend(
            rows.iter()
                .zip(&scales[2].rows)
                .enumerate()
                .map(|(i, (r, row_scale))| (o.secondary + i, *r / s(*row_scale))),
        );
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
    fn pzr_boundary(
        &mut self,
        cell: &stratified::Cell,
        column: &stratified::Column,
    ) -> Result<stratified::Boundary, Failure> {
        self.blocks
            .pzr_boundary(self.y, self.yp, self.seed, self.cj, cell, column, self.rows)
    }
}
