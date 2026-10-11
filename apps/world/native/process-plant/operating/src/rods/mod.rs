//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/control-absorber-and-guide-water.md#s2-operating-rod-block
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/control-absorber-and-guide-water.md#grip-manual-disconnect-and-achieved-motion
//! spec: world/packs/process-plant/reference-designs/ld-01/safety/reactor-trip-and-hold.md#s2-holding-circuit-boundary
//! The S2 rod block: 52 moving spider-and-bodies (H7), their steady guide
//! passages (F1 (a), H4) and the network cell volumes they displace.
//!
//! Per cluster, in this order: achieved travel `y` (m), body velocity `v`
//! (m/s, upward positive) and the guide passage's upward mass current `m`
//! (kg/s). `y' = v` always. A FREE body obeys
//! `M v' = F_end + F_wall + B_spider + F_drag - M g`; a HELD or SEATED body
//! has the algebraic row `v = 0`. The passage row is its steady series
//! balance from LOWER through the lower mouth, the clear bores below the tips,
//! the moving annulus and the upper mouth into UPPER, on the donor water of
//! the current's sign; it sets the tip pressure the end faces see and the
//! annulus current of the wall law. The current carries mass, enthalpy and
//! tracer from its donor into the other plenum; the wall and spider-drag work
//! the bodies do on the water enter the swept cells through the single heat
//! port, and the network pays the boundary work `-p V'` of the displaced
//! volumes through its own rate closure. The stem stays with the drive line
//! (H7): it is not moved and is not part of the body mass. The holding circuit
//! opens at the declared delay after the manual turbine TRIP (H6); grip
//! release is then immediate, the armature's opening being the disclosed
//! omission G3. A seated body's arrival energy is deposited once into its
//! fuel assembly's top fitting. Every value comes from the compiled `rods`
//! section; nothing is defaulted, clipped or floored.
pub mod geometry;
pub mod guide;

use crate::{
    joined::block::{
        CellVolume, Class, Command, Coordinates, Fluid, Layout, Receipts, Rods, Structure,
        Transaction,
    },
    local_flow::Phase,
    network::{Failure, packet::Packet},
    thermal::Scalar,
};
use geometry::{Branch, overlap};
use guide::{Annulus, Passage, s};
use serde::Deserialize;
use serde_json::json;
use std::f64::consts::PI;

/// The compiled `rods` section of the spine packet.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Section {
    pub identity: String,
    /// The 52 clusters in the source feedback's rod order.
    pub clusters: Vec<ClusterSection>,
    pub bodies: Bodies,
    pub spider: Spider,
    pub guide: Guide,
    pub cells: Cells,
    pub gravity_m_s2: f64,
    /// Achieved travel of the prepared hold.
    pub reference_travel_m: f64,
    /// Upper end of the admitted travel geometry.
    pub normal_travel_m: f64,
    pub holding: Holding,
    pub spider_drag: SpiderDrag,
    pub provenance: Vec<Provenance>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClusterSection {
    pub id: String,
    pub fuel_assembly: String,
    pub lattice: [i32; 2],
    /// Share of the cluster's body area in the sectors NE, NW, SW, SE.
    pub sector_shares: [f64; 4],
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bodies {
    pub count: u32,
    pub radius_m: f64,
    pub length_m: f64,
    pub seated_bottom_m: f64,
    /// The bodies' B4C and steel of one cluster.
    pub mass_kg: f64,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Spider {
    pub mass_kg: f64,
    pub volume_m3: f64,
    pub seated_bottom_m: f64,
    pub height_m: f64,
    pub radius_m: f64,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Guide {
    pub bore_radius_m: f64,
    pub lower_mouth_m: f64,
    pub upper_mouth_m: f64,
    pub roughness_m: f64,
    pub lower_mouth_loss: f64,
    pub upper_mouth_loss: f64,
    /// R3's blend band, as an annulus speed: the passage's water is blended
    /// over |annulus volume current| below this speed times the annulus area.
    pub blend_speed_m_s: f64,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Span {
    pub region: String,
    pub bottom_m: f64,
    pub top_m: f64,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cells {
    pub lower: Span,
    /// Sectors NE, NW, SW, SE, each with its lower and upper core band.
    pub core: [[Span; 2]; 4],
    pub upper: Span,
    pub housing_main: Span,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Holding {
    /// Declared S2 boundary from the manual turbine TRIP to the holding
    /// circuit opening (H6).
    pub turbine_trip_to_opening_s: f64,
}
/// The broad spider drag in S2: an open selection is carried explicitly.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, tag = "selection", rename_all = "kebab-case")]
pub enum SpiderDrag {
    /// Not yet selected: a free body refuses to evaluate.
    Pending,
    /// `F = -0.5 rho C pi r^2 v|v|` on the spider envelope disk.
    EnvelopeDisk { coefficient: f64 },
    /// Declared omission.
    Omitted,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Provenance {
    pub name: String,
    pub sha256: String,
}
/// The `rods` key of the spine packet, read beside the other sections.
#[derive(Debug, Deserialize)]
pub struct RodPacket {
    pub rods: Section,
}

/// Discrete mode of one spider-and-bodies, retained block state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub enum Mode {
    Held,
    Free,
    Seated,
}

/// One network region as the block sees it.
#[derive(Clone, Copy, Debug)]
pub struct Region<'a> {
    pub id: &'a str,
    pub elevation_m: f64,
}

#[derive(Clone, Debug)]
struct Cluster {
    id: String,
    fuel_assembly: String,
}
/// One rod-swept network cell: index, axial span, and per cluster the share
/// of the body area it takes (1 in a plenum, the sector share in the core).
#[derive(Clone, Debug)]
struct SweptCell {
    index: usize,
    bottom: f64,
    top: f64,
    weights: Vec<f64>,
    /// The spider's steel enters the plena only (it never reaches the core).
    spider: bool,
}

/// Every force of one cluster in one evaluation (physical, upward positive).
#[derive(Clone, Copy, Debug)]
pub struct Forces {
    pub tip_pressure: Scalar,
    pub top_pressure: Scalar,
    pub end_face: Scalar,
    pub wall: Scalar,
    pub spider_buoyancy: Scalar,
    pub spider_drag: Scalar,
    /// `F_end + F_wall + B_spider + F_drag - M g`.
    pub net: Scalar,
    pub passage_residual: Scalar,
    pub chi: Scalar,
    pub annulus_dissipation: Scalar,
    /// The annulus mass current in the bores' water, the passage current
    /// plus the displacement (R2), kg/s.
    pub annulus_current: Scalar,
    /// The plenum whose water the bores mostly hold (R2: the annulus
    /// current's source; R3: the blend weight's side).
    pub donor: usize,
    /// R3's blend weight on LOWER's water: 1 above the band, 0 below.
    pub blend_weight: Scalar,
    pub donor_density: Scalar,
    pub donor_viscosity: Scalar,
}

/// R3's C1 weight on the annulus volume current over its band, `x`:
/// `1/2 + 3x/4 - x^3/4` on `|x| < 1`, with zero slope at both edges.
fn blend(x: Scalar) -> Scalar {
    s(0.5) + s(0.75) * x - s(0.25) * x * x * x
}

fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(reason.into())
}
fn recoverable(reason: impl Into<String>) -> Failure {
    Failure::Recoverable(reason.into())
}

pub struct RodBlock {
    clusters: Vec<Cluster>,
    regular: usize,
    cells: Vec<SweptCell>,
    lower: usize,
    upper: usize,
    main: usize,
    /// Pressure-reference elevations of LOWER, UPPER and HOUSING.MAIN.
    z_lower: f64,
    z_upper: f64,
    z_main: f64,
    /// The UPPER/HOUSING.MAIN plane.
    z_interface: f64,
    body_area: f64,
    body_bottom: f64,
    body_top: f64,
    spider_bottom: f64,
    spider_height: f64,
    spider_volume: f64,
    spider_area: f64,
    mass: f64,
    guide_bottom: f64,
    guide_top: f64,
    passage: Passage,
    /// R3's band in annulus volume current, m3/s.
    blend_volume_current: f64,
    gravity: f64,
    reference_travel: f64,
    span: (f64, f64),
    spider_drag: SpiderDrag,
    holding_delay: f64,
    /// Displaced volume of each cluster in each swept cell at the prepared
    /// travel, which the compiled cell volumes already exclude.
    reference_displacement: Vec<Vec<f64>>,
    layout: Layout,
    prepared: Vec<f64>,
    modes: Vec<Mode>,
    failed_release: Vec<bool>,
    holding_open_at: Option<f64>,
}

impl RodBlock {
    /// Compile the block from its section and the network packet it moves:
    /// its region identities and elevations, and the prepared LOWER water
    /// density that sets the passage scales.
    pub fn from_packet(section: &Section, network: &Packet) -> Result<Self, Failure> {
        let regions: Vec<Region<'_>> = network
            .mechanics
            .regions
            .iter()
            .map(|r| Region {
                id: &r.id,
                elevation_m: r.elevation_m,
            })
            .collect();
        let lower = regions
            .iter()
            .position(|r| r.id == section.cells.lower.region)
            .ok_or_else(|| fatal("rods: no LOWER region"))?;
        let water = network
            .thermal
            .water
            .get(lower)
            .ok_or_else(|| fatal("rods: LOWER has no prepared water owner"))?;
        let density = water.mass_kg / network.mechanics.regions[lower].volume_m3;
        Self::new(section, &regions, network.pzr.cell.index, density)
    }

    /// Compile the block over the network's regions (packet order; the first
    /// `regular` are regular cells) with the prepared LOWER water density
    /// that sets the passage scales. The guide currents of the prepared hold
    /// are solved by [`RodBlock::prepare_currents`] at the composed at-power
    /// fluid state; until then they are zero.
    pub fn new(
        section: &Section,
        regions: &[Region<'_>],
        regular: usize,
        lower_density: f64,
    ) -> Result<Self, Failure> {
        let index = |id: &str| {
            regions
                .iter()
                .position(|r| r.id == id)
                .ok_or_else(|| fatal(format!("rods: no network region {id}")))
        };
        let positive = |name: &str, v: f64| {
            if v.is_finite() && v > 0. {
                Ok(v)
            } else {
                Err(fatal(format!(
                    "rods: {name} must be finite and positive, got {v}"
                )))
            }
        };
        let n = section.clusters.len();
        let b = &section.bodies;
        let g = &section.guide;
        let sp = &section.spider;
        for (name, v) in [
            ("body radius", b.radius_m),
            ("body length", b.length_m),
            ("body mass", b.mass_kg),
            ("spider mass", sp.mass_kg),
            ("spider volume", sp.volume_m3),
            ("spider height", sp.height_m),
            ("spider radius", sp.radius_m),
            ("bore radius", g.bore_radius_m),
            ("gravity", section.gravity_m_s2),
            ("reference travel", section.reference_travel_m),
            ("normal travel", section.normal_travel_m),
            ("holding delay", section.holding.turbine_trip_to_opening_s),
            ("lower mouth loss", g.lower_mouth_loss),
            ("upper mouth loss", g.upper_mouth_loss),
            ("passage blend speed", g.blend_speed_m_s),
        ] {
            positive(name, v)?;
        }
        if n == 0
            || b.count == 0
            || g.roughness_m < 0.
            || !g.roughness_m.is_finite()
            || b.radius_m >= g.bore_radius_m
            || g.upper_mouth_m <= g.lower_mouth_m
            || b.seated_bottom_m != g.lower_mouth_m
            || b.seated_bottom_m + b.length_m < g.upper_mouth_m
            || section.reference_travel_m > section.normal_travel_m
        {
            return Err(fatal(
                "rods: the bodies must be seated at the guides' lower mouths and span them",
            ));
        }
        if let SpiderDrag::EnvelopeDisk { coefficient } = section.spider_drag {
            positive("spider drag coefficient", coefficient)?;
        }
        let mut clusters = Vec::with_capacity(n);
        for c in &section.clusters {
            if c.sector_shares.iter().any(|w| !(0. ..=1.).contains(w))
                || (c.sector_shares.iter().sum::<f64>() - 1.).abs() > 1e-14
            {
                return Err(fatal(format!(
                    "rods: {} sector shares {:?} do not close",
                    c.id, c.sector_shares
                )));
            }
            clusters.push(Cluster {
                id: c.id.clone(),
                fuel_assembly: c.fuel_assembly.clone(),
            });
        }
        let cl = &section.cells;
        let plenum = |span: &Span| -> Result<SweptCell, Failure> {
            Ok(SweptCell {
                index: index(&span.region)?,
                bottom: span.bottom_m,
                top: span.top_m,
                weights: vec![1.; n],
                spider: true,
            })
        };
        let mut cells = vec![plenum(&cl.lower)?];
        for (k, sector) in cl.core.iter().enumerate() {
            for band in sector {
                cells.push(SweptCell {
                    index: index(&band.region)?,
                    bottom: band.bottom_m,
                    top: band.top_m,
                    weights: section
                        .clusters
                        .iter()
                        .map(|c| c.sector_shares[k])
                        .collect(),
                    spider: false,
                });
            }
        }
        cells.push(plenum(&cl.upper)?);
        cells.push(plenum(&cl.housing_main)?);
        // The plena tile the axis: LOWER below the core, the four sector
        // columns over the core, UPPER, then HOUSING.MAIN.
        let core = &cl.core[0];
        if !(cl.lower.top_m == core[0].bottom_m
            && cl.core.iter().all(|s| {
                s[0].bottom_m == core[0].bottom_m
                    && s[0].top_m == s[1].bottom_m
                    && s[1].top_m == core[1].top_m
            })
            && core[1].top_m == cl.upper.bottom_m
            && cl.upper.top_m == cl.housing_main.bottom_m
            && cells.iter().all(|c| c.top > c.bottom))
        {
            return Err(fatal("rods: swept cell spans do not tile the axis"));
        }
        let mut seen: Vec<usize> = cells.iter().map(|c| c.index).collect();
        seen.sort_unstable();
        seen.dedup();
        if seen.len() != cells.len() || cells.iter().any(|c| c.index >= regular) {
            return Err(fatal("rods: swept cells must be distinct regular cells"));
        }
        let (lower, upper, main) = (
            cells[0].index,
            cells[cells.len() - 2].index,
            cells[cells.len() - 1].index,
        );
        let elevation = |i: usize| regions[i].elevation_m;
        let annulus = Annulus::new(g.bore_radius_m, b.radius_m, b.count as f64).map_err(fatal)?;
        let density = positive("prepared LOWER density", lower_density)?;
        let head = density * section.gravity_m_s2 * (g.upper_mouth_m - g.lower_mouth_m);
        let clear_area = b.count as f64 * PI * g.bore_radius_m * g.bore_radius_m;
        // Scales: the admitted travel, the free-fall speed over it, the guide's
        // hydrostatic head, and the current a free jet would carry under it.
        let travel_scale = section.normal_travel_m;
        let speed_scale = (2. * section.gravity_m_s2 * travel_scale).sqrt();
        let current_scale = clear_area * (2. * density * head).sqrt();
        positive("guide head scale", head)?;
        let mut layout = Layout::default();
        let mut prepared = Vec::with_capacity(3 * n);
        for c in &clusters {
            layout.push(
                format!("y[{}]", c.id),
                Class::RodPosition,
                true,
                travel_scale,
                travel_scale,
            );
            layout.push(
                format!("v[{}]", c.id),
                Class::RodVelocity,
                false,
                speed_scale,
                speed_scale,
            );
            layout.push(
                format!("m_guide[{}]", c.id),
                Class::GuideCurrent,
                false,
                current_scale,
                head,
            );
            prepared.extend([section.reference_travel_m, 0., 0.]);
        }
        layout.validate("rods")?;
        let mut block = Self {
            clusters,
            regular,
            lower,
            upper,
            main,
            z_lower: elevation(lower),
            z_upper: elevation(upper),
            z_main: elevation(main),
            z_interface: cl.upper.top_m,
            body_area: b.count as f64 * PI * b.radius_m * b.radius_m,
            body_bottom: b.seated_bottom_m,
            body_top: b.seated_bottom_m + b.length_m,
            spider_bottom: sp.seated_bottom_m,
            spider_height: sp.height_m,
            spider_volume: sp.volume_m3,
            spider_area: PI * sp.radius_m * sp.radius_m,
            mass: b.mass_kg + sp.mass_kg,
            guide_bottom: g.lower_mouth_m,
            guide_top: g.upper_mouth_m,
            passage: Passage {
                annulus,
                clear_area,
                bore_diameter: 2. * g.bore_radius_m,
                roughness: g.roughness_m,
                lower_mouth_loss: g.lower_mouth_loss,
                upper_mouth_loss: g.upper_mouth_loss,
            },
            blend_volume_current: g.blend_speed_m_s * annulus.area,
            gravity: section.gravity_m_s2,
            reference_travel: section.reference_travel_m,
            span: (cl.lower.bottom_m, cl.housing_main.top_m),
            spider_drag: section.spider_drag,
            holding_delay: section.holding.turbine_trip_to_opening_s,
            reference_displacement: Vec::new(),
            cells,
            layout,
            prepared,
            modes: vec![Mode::Held; n],
            failed_release: vec![false; n],
            holding_open_at: None,
        };
        if block.z_interface >= block.z_main {
            return Err(fatal(
                "rods: HOUSING.MAIN's reference lies below its bottom plane",
            ));
        }
        block.reference_displacement = (0..block.cells.len())
            .map(|k| {
                (0..n)
                    .map(|c| {
                        block
                            .displacement(k, c, section.reference_travel_m, Branch::Insertion)
                            .0
                    })
                    .collect()
            })
            .collect();
        Ok(block)
    }

    /// Displaced volume of cluster `c` in swept cell `k` at travel `y`, and
    /// its one-sided slope in `y`.
    fn displacement(&self, k: usize, c: usize, y: f64, branch: Branch) -> (f64, f64) {
        let cell = &self.cells[k];
        let w = cell.weights[c];
        let (body, body_slope) = overlap(
            cell.bottom,
            cell.top,
            (self.body_bottom + y, 1.),
            (self.body_top + y, 1.),
            branch,
        );
        let mut value = w * self.body_area * body;
        let mut slope = w * self.body_area * body_slope;
        if cell.spider {
            let density = self.spider_volume / self.spider_height;
            let (spider, spider_slope) = overlap(
                cell.bottom,
                cell.top,
                (self.spider_bottom + y, 1.),
                (self.spider_bottom + self.spider_height + y, 1.),
                branch,
            );
            value += density * spider;
            slope += density * spider_slope;
        }
        (value, slope)
    }

    fn admit_travel(&self, c: usize, y: f64) -> Result<(), Failure> {
        let top = self.spider_bottom + self.spider_height + y;
        if !y.is_finite()
            || self.body_bottom + y < self.span.0
            || top > self.span.1
            || self.guide_top - (self.body_bottom + y) <= 0.
        {
            return Err(recoverable(format!(
                "rods: {} travel {y} m leaves the swept-cell geometry",
                self.clusters[c].id
            )));
        }
        Ok(())
    }

    /// The bodies' mode, discrete retained state.
    pub fn modes(&self) -> &[Mode] {
        &self.modes
    }
    pub fn set_mode(&mut self, c: usize, mode: Mode) {
        self.modes[c] = mode;
    }
    /// The contrary case's stuck cluster (G7): its grip never releases.
    pub fn set_failed_release(&mut self, c: usize) {
        self.failed_release[c] = true;
    }
    /// The holding circuit opens at `t`: the manual reactor-trip interrupt
    /// of G7's no-turbine-trip case. The turbine TRIP opens it after the
    /// declared delay instead ([`Command::TurbineTrip`]).
    pub fn open_holding_circuit(&mut self, t: f64) -> Result<Transaction, Failure> {
        if self.holding_open_at.is_some() {
            return Err(fatal(
                "rods: the holding circuit is already open or opening",
            ));
        }
        self.holding_open_at = Some(t);
        Ok(Transaction {
            deposits: Vec::new(),
            receipt: json!({"holding_circuit_opens_s": t, "grip_release": "at the opening (armature omitted, G3)"}),
        })
    }
    pub fn holding_open_at(&self) -> Option<f64> {
        self.holding_open_at
    }
    /// Network cell indices of LOWER, UPPER and HOUSING.MAIN.
    pub fn plena(&self) -> [usize; 3] {
        [self.lower, self.upper, self.main]
    }
    /// Moving mass of one cluster (bodies and spider), kg.
    pub fn moving_mass(&self) -> f64 {
        self.mass
    }
    /// Achieved travel of the prepared hold, m.
    pub fn reference_travel(&self) -> f64 {
        self.reference_travel
    }
    /// Network cell indices of the swept cells: LOWER, the eight core cells
    /// (sector by sector, lower band first), UPPER and HOUSING.MAIN.
    pub fn swept_cells(&self) -> Vec<usize> {
        self.cells.iter().map(|c| c.index).collect()
    }

    /// Network static pressure at elevation `z` (with its direction) along
    /// the UPPER/HOUSING.MAIN column. Each cell carries its own well-balanced
    /// head about its reference; between the interface plane and
    /// HOUSING.MAIN's reference the two reconstructions' mismatch at the
    /// interface is distributed linearly, which is the network's own face
    /// path reconstruction (`pressure_after_segments`) of the vertical
    /// UPPER-to-HOUSING.MAIN face, so the end-face pressure is continuous
    /// when a body top crosses the plane.
    fn column_pressure(&self, fluid: &Fluid<'_>, z: Scalar) -> Scalar {
        let g = s(self.gravity);
        let at = |cell: usize, reference: f64, z: Scalar| {
            fluid.cells[cell].pressure + fluid.mixture_density(cell) * g * (s(reference) - z)
        };
        let upper = |z: Scalar| at(self.upper, self.z_upper, z);
        let main = |z: Scalar| at(self.main, self.z_main, z);
        if z.value <= self.z_interface {
            upper(z)
        } else if z.value < self.z_main {
            let plane = s(self.z_interface);
            let mismatch = upper(plane) - main(plane);
            main(z) + mismatch * (s(self.z_main) - z) / s(self.z_main - self.z_interface)
        } else {
            main(z)
        }
    }

    /// Mixture-density weighted overlap of the spider with the plena, and
    /// each plenum's share of the spider height.
    fn spider_cells(
        &self,
        fluid: &Fluid<'_>,
        y: Scalar,
        branch: Branch,
    ) -> [(usize, Scalar, Scalar); 2] {
        let k_upper = self.cells.len() - 2;
        [k_upper, k_upper + 1].map(|k| {
            let cell = &self.cells[k];
            let (value, slope) = overlap(
                cell.bottom,
                cell.top,
                (self.spider_bottom + y.value, 1.),
                (self.spider_bottom + self.spider_height + y.value, 1.),
                branch,
            );
            let fraction = Scalar::new(value, slope * y.direction) / s(self.spider_height);
            (cell.index, fluid.mixture_density(cell.index), fraction)
        })
    }

    /// Every force of cluster `c` at these coordinates and this fluid state.
    pub fn forces(
        &self,
        c: usize,
        x: &Coordinates<'_>,
        fluid: &Fluid<'_>,
    ) -> Result<Forces, Failure> {
        let (y, v, m) = (x.value(3 * c), x.value(3 * c + 1), x.value(3 * c + 2));
        self.admit_travel(c, y.value)?;
        let branch = Branch::of_rate(x.rate(3 * c).value);
        // R2: the bores' displaced water joins the passage current in the
        // annulus, D = -A_b v upward (a dashpot current while falling). The
        // bores hold the water of the annulus current's source: LOWER's while
        // it flows up, whatever the clear current's sign, UPPER's when it
        // flows down (F1 (a)'s donor at rest). R3: within one band of the
        // annulus volume current's reversal, the two plena's density and
        // viscosity are blended by one C1 weight, so the balance is
        // continuous and strictly decreasing there.
        let displacement = -s(self.body_area) * v;
        let water = |cell: usize| -> Result<(Scalar, Scalar), Failure> {
            let phase = fluid.cells[cell].phase[0].ok_or_else(|| {
                recoverable(format!("rods: guide plenum cell {cell} has no liquid"))
            })?;
            let (point, direction) = fluid.points[cell][0].ok_or_else(|| {
                recoverable(format!(
                    "rods: guide plenum cell {cell} has no liquid point"
                ))
            })?;
            Ok((
                phase.density,
                Scalar::new(point.viscosity_pa_s, direction.viscosity_pa_s),
            ))
        };
        let (rho_lower, mu_lower) = water(self.lower)?;
        let reversal = (m / rho_lower + displacement) / s(self.blend_volume_current);
        let (rho, mu, weight) = if reversal.value >= 1. {
            (rho_lower, mu_lower, s(1.))
        } else {
            let (rho_upper, mu_upper) = water(self.upper)?;
            if reversal.value <= -1. {
                (rho_upper, mu_upper, s(0.))
            } else {
                if rho_upper.value > rho_lower.value {
                    return Err(recoverable(format!(
                        "rods: {} passage current {} kg/s lies in the R3 blend band with UPPER denser than LOWER ({} > {} kg/m3): an inverted column has no unique passage state",
                        self.clusters[c].id, m.value, rho_upper.value, rho_lower.value
                    )));
                }
                let w = blend(reversal);
                (
                    w * rho_lower + (s(1.) - w) * rho_upper,
                    w * mu_lower + (s(1.) - w) * mu_upper,
                    w,
                )
            }
        };
        let donor = if weight.value >= 0.5 {
            self.lower
        } else {
            self.upper
        };
        let g = s(self.gravity);
        let lower_mouth = fluid.cells[self.lower].pressure
            + fluid.mixture_density(self.lower) * g * s(self.z_lower - self.guide_bottom);
        let upper_mouth = fluid.cells[self.upper].pressure
            + fluid.mixture_density(self.upper) * g * s(self.z_upper - self.guide_top);
        let tip = s(self.body_bottom) + y;
        let clear_length = tip - s(self.guide_bottom);
        let annulus_length = s(self.guide_top) - tip;
        let annulus_current = m + rho * displacement;
        let clear = self.passage.clear(m, rho, mu, clear_length);
        let ann = self
            .passage
            .annulus(annulus_current, v, rho, mu, annulus_length);
        let passage = lower_mouth
            - upper_mouth
            - rho * g * s(self.guide_top - self.guide_bottom)
            - clear
            - ann.loss;
        let tip_pressure = lower_mouth - rho * g * clear_length - clear;
        let top_pressure = self.column_pressure(fluid, s(self.body_top) + y);
        let end_face = s(self.body_area) * (tip_pressure - top_pressure);
        // Mixture density over the spider's height, cell by cell.
        let mut spider_density = s(0.);
        for (_, density, fraction) in self.spider_cells(fluid, y, branch) {
            spider_density = spider_density + density * fraction;
        }
        let spider_buoyancy = spider_density * g * s(self.spider_volume);
        let spider_drag = match self.spider_drag {
            SpiderDrag::EnvelopeDisk { coefficient } => {
                s(-0.5 * coefficient * self.spider_area) * spider_density * guide::signed_square(v)
            }
            SpiderDrag::Omitted | SpiderDrag::Pending => s(0.),
        };
        let net = end_face + ann.wall_force + spider_buoyancy + spider_drag - s(self.mass) * g;
        Ok(Forces {
            tip_pressure,
            top_pressure,
            end_face,
            wall: ann.wall_force,
            spider_buoyancy,
            spider_drag,
            net,
            passage_residual: passage,
            chi: ann.chi,
            annulus_dissipation: ann.dissipation,
            annulus_current,
            donor,
            blend_weight: weight,
            donor_density: rho,
            donor_viscosity: mu,
        })
    }

    /// Solve every passage's steady series balance at the bodies' current
    /// travel and rest, at this fluid state, and keep the currents as the
    /// prepared ones. The balance is monotone in the current, so a bracketed
    /// Newton finds its unique root. A donor-density gap, where the upward
    /// current's balance is negative at zero and the downward one's positive,
    /// has no steady passage state and is refused.
    pub fn prepare_currents(&mut self, fluid: &Fluid<'_>) -> Result<Vec<f64>, Failure> {
        self.prepare_currents_at(fluid, self.reference_travel)
    }

    /// [`RodBlock::prepare_currents`] with every body held at `travel`, which
    /// becomes the prepared travel.
    pub fn prepare_currents_at(
        &mut self,
        fluid: &Fluid<'_>,
        travel: f64,
    ) -> Result<Vec<f64>, Failure> {
        let n = self.clusters.len();
        for c in 0..n {
            self.admit_travel(c, travel)?;
            self.prepared[3 * c] = travel;
            self.prepared[3 * c + 1] = 0.;
        }
        let mut currents = Vec::with_capacity(n);
        for c in 0..n {
            let m = self.passage_current(c, fluid, travel, 0.)?;
            self.prepared[3 * c + 2] = m;
            currents.push(m);
        }
        Ok(currents)
    }

    /// The steady passage current of cluster `c` at `travel` and body speed
    /// `speed` in this fluid state: the unique root of its strictly
    /// decreasing series balance (R3's blend makes it continuous through the
    /// annulus current's reversal), by a bracketed Newton. An inverted
    /// column, UPPER denser than LOWER, is refused. Convergence is declared
    /// at `1e-12` of the row scale plus the balance's rounding floor between
    /// the plena pressures.
    pub fn passage_current(
        &self,
        c: usize,
        fluid: &Fluid<'_>,
        travel: f64,
        speed: f64,
    ) -> Result<f64, Failure> {
        let n = self.clusters.len();
        self.admit_travel(c, travel)?;
        let residual = |m: f64, dm: f64| -> Result<Scalar, Failure> {
            let mut yv = vec![0.; 3 * n];
            let mut seed = vec![0.; 3 * n];
            yv[3 * c] = travel / self.layout.scales[3 * c];
            yv[3 * c + 1] = speed / self.layout.scales[3 * c + 1];
            yv[3 * c + 2] = m / self.layout.scales[3 * c + 2];
            seed[3 * c + 2] = dm / self.layout.scales[3 * c + 2];
            let yp = vec![0.; 3 * n];
            let x = Coordinates::new(&yv, &yp, Some(&seed), 0., &self.layout.scales)?;
            Ok(self.forces(c, &x, fluid)?.passage_residual)
        };
        // R3: with LOWER no lighter than UPPER the blended balance is
        // continuous and strictly decreasing, so it has exactly one root.
        // Bracket it on the blend band around the annulus current's reversal,
        // then outward by doubling.
        let density = |cell: usize| -> Result<f64, Failure> {
            Ok(fluid.cells[cell].phase[0]
                .ok_or_else(|| fatal("rods: a plenum has no liquid to prepare the passages"))?
                .density
                .value)
        };
        let (rho_lower, rho_upper) = (density(self.lower)?, density(self.upper)?);
        if rho_upper > rho_lower {
            return Err(fatal(format!(
                "rods: {} has no unique passage state: UPPER is denser than LOWER ({rho_upper} > {rho_lower} kg/m3), an inverted column (R3)",
                self.clusters[c].id
            )));
        }
        let centre = rho_lower * self.body_area * speed;
        let half = rho_lower * self.blend_volume_current;
        let (mut lo, mut hi) = (centre - half, centre + half);
        let (at_lo, at_hi) = (residual(lo, 0.)?.value, residual(hi, 0.)?.value);
        if at_hi > 0. {
            let mut step = half;
            lo = hi;
            hi = lo + step;
            while residual(hi, 0.)?.value > 0. {
                if step > 1e6 * half.max(1.) {
                    return Err(fatal(format!(
                        "rods: {} passage balance stays positive up to {hi} kg/s",
                        self.clusters[c].id
                    )));
                }
                lo = hi;
                step *= 2.;
                hi = lo + step;
            }
        } else if at_lo < 0. {
            let mut step = half;
            hi = lo;
            lo = hi - step;
            while residual(lo, 0.)?.value < 0. {
                if step > 1e6 * half.max(1.) {
                    return Err(fatal(format!(
                        "rods: {} passage balance stays negative down to {lo} kg/s",
                        self.clusters[c].id
                    )));
                }
                hi = lo;
                step *= 2.;
                lo = hi - step;
            }
        }
        // Declared convergence: 1e-12 of the passage's row scale, above the
        // rounding floor of a balance taken between ~15 MPa plenum pressures.
        let plena = fluid.cells[self.lower].pressure.value.abs()
            + fluid.cells[self.upper].pressure.value.abs();
        let tolerance = 1e-12 * self.layout.row_scales[3 * c + 2] + 8. * f64::EPSILON * plena;
        let mut m = 0.5 * (lo + hi);
        for _ in 0..200 {
            let r = residual(m, 1.)?;
            if r.value.abs() <= tolerance {
                return Ok(m);
            }
            // The balance decreases with the current.
            if r.value > 0. {
                lo = m;
            } else {
                hi = m;
            }
            let newton = m - r.value / r.direction;
            m = if r.direction < 0. && newton > lo && newton < hi {
                newton
            } else {
                0.5 * (lo + hi)
            };
        }
        let (below, above) = (residual(lo, 0.)?.value, residual(hi, 0.)?.value);
        Err(fatal(format!(
            "rods: {} passage balance did not close to {tolerance} Pa on [{lo}, {hi}] kg/s ({below} to {above} Pa)",
            self.clusters[c].id
        )))
    }

    /// The swept cells holding cluster `c`'s body tips, with each one's share
    /// of the tips (the side the tips move into at a plane).
    fn tip_cells(&self, c: usize, y: f64, branch: Branch) -> Vec<(usize, f64)> {
        let tip = self.body_bottom + y;
        self.cells
            .iter()
            .filter_map(|cell| {
                // The half-line above the tips loses length as they rise.
                let (_, slope) = overlap(cell.bottom, cell.top, (tip, 1.), (cell.top, 0.), branch);
                let share = -slope * cell.weights[c];
                (share != 0.).then_some((cell.index, share))
            })
            .collect()
    }

    /// Cluster `c`'s guide transport, per network cell `[mass, enthalpy,
    /// tracer]` into the cell. The clear current `m` joins, at the tips, the
    /// water the bodies displace from the cells holding the tips (R2: their
    /// own water leaves as their free volume shrinks), and the annulus
    /// carries the sum into UPPER. The tip junction has no storage: what
    /// flows out carries the mixture of what flows in, so mass, enthalpy and
    /// tracer are conserved exactly. Each stream's source follows its sign.
    #[allow(clippy::type_complexity)]
    fn transport(
        &self,
        c: usize,
        x: &Coordinates<'_>,
        fluid: &Fluid<'_>,
    ) -> Result<Vec<(usize, [Scalar; 3])>, Failure> {
        let (y, v, m) = (x.value(3 * c), x.value(3 * c + 1), x.value(3 * c + 2));
        let branch = Branch::of_rate(x.rate(3 * c).value);
        let liquid = |cell: usize| {
            fluid.cells[cell].phase[0]
                .ok_or_else(|| recoverable(format!("rods: guide cell {cell} has no liquid")))
        };
        // Streams into the junction (positive) or out of it, with the cell
        // they come from or go to and that cell's water.
        let mut streams: Vec<(usize, Scalar, Phase)> = vec![(self.lower, m, liquid(self.lower)?)];
        let mut displaced = s(0.);
        for (cell, share) in self.tip_cells(c, y.value, branch) {
            let water = liquid(cell)?;
            let mass = water.density * s(self.body_area * share) * -v;
            displaced = displaced + mass;
            streams.push((cell, mass, water));
        }
        // The annulus takes the sum into UPPER: an outflow of the junction.
        streams.push((self.upper, -(m + displaced), liquid(self.upper)?));
        let (mut inflow, mut enthalpy, mut tracer) = (s(0.), s(0.), s(0.));
        for (_, mass, water) in &streams {
            if mass.value > 0. {
                inflow = inflow + *mass;
                enthalpy = enthalpy + *mass * water.enthalpy;
                tracer = tracer + *mass * water.boron_concentration;
            }
        }
        if inflow.value == 0. {
            return Ok(Vec::new());
        }
        let (mix_h, mix_c) = (enthalpy / inflow, tracer / inflow);
        Ok(streams
            .into_iter()
            .map(|(cell, mass, water)| {
                // Into the junction is out of the cell, at the cell's water.
                let (h, b) = if mass.value > 0. {
                    (water.enthalpy, water.boron_concentration)
                } else {
                    (mix_h, mix_c)
                };
                (cell, [-mass, -mass * h, -mass * b])
            })
            .collect())
    }

    /// The moving bodies' mechanical and fluid power ledger of one cluster
    /// (W): bodies' fluid-force power, heat paid to the swept water, and the
    /// boundary work the network pays through `-p V'` on the cell pressures.
    pub fn power(
        &self,
        c: usize,
        x: &Coordinates<'_>,
        fluid: &Fluid<'_>,
    ) -> Result<[f64; 3], Failure> {
        let f = self.forces(c, x, fluid)?;
        let v = x.value(3 * c + 1).value;
        let fluid_force = f.net.value + self.mass * self.gravity;
        let heat = -(f.wall.value + f.spider_drag.value) * v;
        let branch = Branch::of_rate(x.rate(3 * c).value);
        let rate = x.rate(3 * c).value;
        let mut boundary = 0.;
        for (k, cell) in self.cells.iter().enumerate() {
            let (_, slope) = self.displacement(k, c, x.value(3 * c).value, branch);
            boundary += fluid.cells[cell.index].pressure.value * slope * rate;
        }
        Ok([fluid_force * v, heat, boundary])
    }
}

impl<P> Rods<P> for RodBlock {
    fn layout(&self) -> &Layout {
        &self.layout
    }
    fn prepared(&self) -> Vec<f64> {
        self.prepared.clone()
    }
    fn differential(&self) -> Vec<f64> {
        self.modes
            .iter()
            .flat_map(|mode| [1., if *mode == Mode::Free { 1. } else { 0. }, 0.])
            .collect()
    }
    fn next_time_event(&self, t: f64) -> Option<f64> {
        self.holding_open_at.filter(|open| *open > t)
    }
    fn time_event(&mut self, p: &P, t: f64, y: &mut [f64]) -> Result<Option<Transaction>, Failure> {
        // The holding circuit opens at `t`: every held cluster that is not
        // stuck releases here, since its release root (t - open) is exactly
        // zero at the stop and would never report a crossing. A release the
        // root already transacted left no held cluster: nothing is due.
        let directions: Vec<i32> = (0..self.clusters.len())
            .map(|c| i32::from(self.modes[c] == Mode::Held && !self.failed_release[c]))
            .collect();
        if self.holding_open_at != Some(t) || directions.iter().all(|d| *d == 0) {
            return Ok(None);
        }
        Rods::<P>::transact(self, p, t, &directions, y).map(Some)
    }
    fn prepare(&mut self, _: &P, fluid: &Fluid<'_>) -> Result<Transaction, Failure> {
        let currents = self.prepare_currents(fluid)?;
        Ok(Transaction {
            deposits: Vec::new(),
            receipt: json!({"prepared_guide_currents_kg_s": currents}),
        })
    }
    fn clusters(&self) -> usize {
        self.clusters.len()
    }
    fn travel(&self, x: Coordinates<'_>, out: &mut [Scalar]) -> Result<(), Failure> {
        if out.len() != self.clusters.len() || x.len() != self.layout.len() {
            return Err(fatal("rods: travel layout"));
        }
        for (c, t) in out.iter_mut().enumerate() {
            *t = x.value(3 * c);
        }
        Ok(())
    }
    fn volumes(
        &self,
        x: Coordinates<'_>,
        compiled_m3: &[f64],
        out: &mut [CellVolume],
    ) -> Result<(), Failure> {
        if out.len() != compiled_m3.len()
            || compiled_m3.len() != self.regular
            || x.len() != self.layout.len()
        {
            return Err(fatal("rods: cell volume layout"));
        }
        for (o, v) in out.iter_mut().zip(compiled_m3) {
            *o = CellVolume {
                volume_m3: s(*v),
                rate_m3_s: s(0.),
            };
        }
        for c in 0..self.clusters.len() {
            self.admit_travel(c, x.value(3 * c).value)?;
        }
        for (k, cell) in self.cells.iter().enumerate() {
            let mut volume = s(compiled_m3[cell.index]);
            let mut rate = s(0.);
            for c in 0..self.clusters.len() {
                let y = x.value(3 * c);
                let r = x.rate(3 * c);
                let (d, slope) = self.displacement(k, c, y.value, Branch::of_rate(r.value));
                // V = V_compiled + D(y_ref) - D(y); V' = -dD/dy y'.
                volume = volume
                    + Scalar::new(self.reference_displacement[k][c] - d, -slope * y.direction);
                rate = rate - s(slope) * r;
            }
            out[cell.index] = CellVolume {
                volume_m3: volume,
                rate_m3_s: rate,
            };
        }
        Ok(())
    }
    fn rows(
        &mut self,
        _: &P,
        _: f64,
        x: Coordinates<'_>,
        fluid: &Fluid<'_>,
        receipts: &mut Receipts<'_>,
        rows: &mut [Scalar],
    ) -> Result<(), Failure> {
        if rows.len() != self.layout.len() || x.len() != self.layout.len() {
            return Err(fatal("rods: row layout"));
        }
        for c in 0..self.clusters.len() {
            let f = self.forces(c, &x, fluid)?;
            let (y, v) = (x.value(3 * c), x.value(3 * c + 1));
            rows[3 * c] = x.rate(3 * c) - v;
            rows[3 * c + 1] = match self.modes[c] {
                Mode::Free => {
                    if self.spider_drag == SpiderDrag::Pending {
                        return Err(fatal(
                            "rods: a free body needs the S2 spider-drag selection, which is pending (envelope disk or declared omission)",
                        ));
                    }
                    x.rate(3 * c + 1) - f.net / s(self.mass)
                }
                Mode::Held | Mode::Seated => v,
            };
            rows[3 * c + 2] = f.passage_residual;
            for (cell, [mass, enthalpy, tracer]) in self.transport(c, &x, fluid)? {
                receipts.add(cell, 0, mass, enthalpy, tracer)?;
            }
            // Wall work over the annulus span, by swept length and share.
            let branch = Branch::of_rate(x.rate(3 * c).value);
            let wall_work = -f.wall * v;
            let tip = self.body_bottom + y.value;
            let length = s(self.guide_top) - (s(self.body_bottom) + y);
            for cell in &self.cells {
                let (value, slope) = overlap(
                    cell.bottom,
                    cell.top,
                    (tip, 1.),
                    (self.guide_top, 0.),
                    branch,
                );
                if value == 0. && slope == 0. {
                    continue;
                }
                let share = s(cell.weights[c]) * Scalar::new(value, slope * y.direction) / length;
                receipts.heat(cell.index, share * wall_work)?;
            }
            let drag_work = -f.spider_drag * v;
            for (cell, _, fraction) in self.spider_cells(fluid, y, branch) {
                if fraction.value != 0. || fraction.direction != 0. {
                    receipts.heat(cell, fraction * drag_work)?;
                }
            }
        }
        Ok(())
    }
    fn structure(&self) -> Structure {
        let n = self.clusters.len();
        let plena = vec![self.lower, self.upper, self.main];
        let mut st = Structure {
            own: Vec::with_capacity(3 * n),
            cells: Vec::with_capacity(3 * n),
            faces: vec![Vec::new(); 3 * n],
            heat: vec![Vec::new(); 3 * n],
            receipts: Vec::new(),
            volumes: Vec::new(),
            outputs: (0..n).map(|c| vec![3 * c]).collect(),
        };
        for c in 0..n {
            let own = vec![3 * c, 3 * c + 1, 3 * c + 2];
            st.own.push(vec![3 * c, 3 * c + 1]);
            st.cells.push(Vec::new());
            st.own.push(own.clone());
            st.cells.push(plena.clone());
            st.own.push(own);
            st.cells.push(plena.clone());
        }
        // Receipts read the plena and, through the tip junction (R2), the
        // water of every cell a tip can be in.
        let read: Vec<usize> = self.cells.iter().map(|c| c.index).collect();
        for cell in &self.cells {
            let writers: Vec<usize> = (0..n)
                .filter(|c| cell.weights[*c] != 0.)
                .flat_map(|c| [3 * c, 3 * c + 1, 3 * c + 2])
                .collect();
            if !writers.is_empty() {
                st.receipts.push((cell.index, writers, read.clone()));
            }
            let movers: Vec<usize> = (0..n)
                .filter(|c| cell.weights[*c] != 0.)
                .map(|c| 3 * c)
                .collect();
            if !movers.is_empty() {
                st.volumes.push((cell.index, movers));
            }
        }
        st
    }
    fn root_count(&self) -> usize {
        self.clusters.len()
    }
    fn roots(
        &mut self,
        _: &P,
        t: f64,
        x: Coordinates<'_>,
        fluid: &Fluid<'_>,
        out: &mut [f64],
    ) -> Result<(), Failure> {
        if out.len() != self.clusters.len() {
            return Err(fatal("rods: root layout"));
        }
        for (c, root) in out.iter_mut().enumerate() {
            *root = match self.modes[c] {
                // Release when the holding circuit opens, unless stuck.
                Mode::Held => match self.holding_open_at {
                    Some(open) if !self.failed_release[c] => t - open,
                    _ => 1.,
                },
                // Seat at zero travel.
                Mode::Free => x.value(3 * c).value,
                // Lift-off when the seat would have to pull.
                Mode::Seated => -self.forces(c, &x, fluid)?.net.value,
            };
        }
        Ok(())
    }
    fn transact(
        &mut self,
        _: &P,
        t: f64,
        directions: &[i32],
        y: &mut [f64],
    ) -> Result<Transaction, Failure> {
        if directions.len() != self.clusters.len() || y.len() != self.layout.len() {
            return Err(fatal("rods: transaction layout"));
        }
        let mut deposits = Vec::new();
        let mut events = Vec::new();
        for c in 0..self.clusters.len() {
            if directions[c] == 0 {
                continue;
            }
            let id = &self.clusters[c].id;
            match self.modes[c] {
                Mode::Held => {
                    let open = self.holding_open_at.ok_or_else(|| {
                        fatal(format!(
                            "rods: {id} released with the holding circuit closed"
                        ))
                    })?;
                    if self.failed_release[c] || t < open {
                        return Err(fatal(format!(
                            "rods: {id} release root without its release"
                        )));
                    }
                    self.modes[c] = Mode::Free;
                    events.push(json!({"cluster": id, "event": "grip release", "t_s": t, "travel_m": y[3 * c]}));
                }
                Mode::Free => {
                    if directions[c] > 0 {
                        return Err(fatal(format!("rods: {id} crossed its seat upward")));
                    }
                    // Fully inelastic seat: the arrival energy enters the
                    // contacted fitting once; the body rests on the seat.
                    let speed = y[3 * c + 1];
                    let energy = 0.5 * self.mass * speed * speed;
                    let residue = y[3 * c];
                    y[3 * c] = 0.;
                    y[3 * c + 1] = 0.;
                    self.modes[c] = Mode::Seated;
                    let store = format!("{}/top-fitting", self.clusters[c].fuel_assembly);
                    deposits.push((store.clone(), energy));
                    events.push(json!({"cluster": id, "event": "seat", "t_s": t, "arrival_speed_m_s": speed, "arrival_energy_j": energy, "fitting": store, "located_travel_residue_m": residue, "potential_energy_residue_j": self.mass * self.gravity * residue}));
                }
                Mode::Seated => {
                    if directions[c] > 0 {
                        return Err(fatal(format!("rods: {id} seat reaction rose through zero")));
                    }
                    self.modes[c] = Mode::Free;
                    events.push(json!({"cluster": id, "event": "lift-off", "t_s": t}));
                }
            }
        }
        Ok(Transaction {
            deposits,
            receipt: json!({"rods": events}),
        })
    }
    fn command(&mut self, t: f64, command: Command) -> Result<Transaction, Failure> {
        match command {
            Command::ManualReactorTrip => self.open_holding_circuit(t),
            Command::TurbineTrip => {
                let open = t + self.holding_delay;
                if self.holding_open_at.is_some() {
                    return Err(fatal(
                        "rods: the holding circuit is already open or opening",
                    ));
                }
                self.holding_open_at = Some(open);
                Ok(Transaction {
                    deposits: Vec::new(),
                    receipt: json!({"turbine_trip_s": t, "holding_circuit_opens_s": open, "declared_delay_s": self.holding_delay, "grip_release": "at the opening (armature omitted, G3)"}),
                })
            }
        }
    }
}
