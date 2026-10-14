//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-block-interface
//! The interface every block of the joined hot spine is composed through.
//!
//! The joined residual `F(t, y, y')` is one square system. Each block owns a
//! contiguous slice of `y` and the same number of rows: one row per own
//! coordinate, in its declared order. A block declares its coordinates once
//! ([`Layout`]): label, census class, prepared differential identity, the
//! solver scale (physical value of one solver unit) and the row scale (the
//! physical row value of one solver unit). A differential row is the rate
//! defect of its own coordinate, so its row scale is that coordinate's scale
//! and the solver row is `y'_k - rhs_k/scale_k`, the network's convention.
//! Blocks evaluate their rows in physical units; the composing operator
//! divides by the row scale. Nothing is clipped, floored, seeded or iterated
//! here: a block that cannot evaluate a signed Newton trial returns
//! `Failure::Recoverable`, and an ownership/model error `Failure::Fatal`.
//!
//! Blocks meet only through typed ports, never through each other's
//! coordinates:
//! - the network's fluid state of the same evaluation ([`Fluid`]): local
//!   pressures, present phases and their maintained caloric points with
//!   directions, retained phase masses and tracer, and every face chart;
//! - per-cell receipts into the network ([`Receipts`]): mass, enthalpy and
//!   tracer per phase. The liquid enthalpy receipt is the single heat port.
//!   Positive values enter the cell;
//! - moving cell volumes ([`CellVolume`]) of the network's regular cells
//!   (declared; the network refuses a moving volume until its rigid-volume
//!   EOS row, rate closure and inertance consume one);
//! - the SG secondary state the SG metal contacts see ([`SecondaryView`])
//!   and, back, the metal-to-secondary heat per SG;
//! - achieved rod travel per cluster for the source feedback.
//!
//! Two block owners implement the traits here: the SG secondary owner
//! ([`Secondary`]) and the rod bodies, guide passages and moving volumes
//! owner ([`Rods`]). The nuclear, solid and network blocks are composed
//! directly by the joined operator. Discrete modes (held/free/seated rods,
//! relief branch memory, steam-demand schedule) are block-owned retained
//! state; a located root or a declared command changes them only through
//! [`Secondary::transact`]/[`Rods::transact`] or `command`, after which the
//! composing harness re-establishes consistency by the exact consistent start.
pub use crate::network::{CellVolume, Fluid, Receipts};
use crate::{network::Failure, thermal::Scalar};
use serde::Serialize;

/// Census class of one coordinate. The coordinate's own row carries the same
/// class: a differential coordinate's row is its balance, an algebraic
/// coordinate's row is its constraint.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub enum Class {
    // Nuclear and material histories.
    RegionalPopulation,
    Precursor,
    Fissile,
    Fertile,
    Iodine,
    Xenon,
    Promethium,
    Samarium,
    FissionHistory,
    CaptureHistory,
    // Solids.
    FuelEnergy,
    CladEnergy,
    Surface,
    HeliumEnergy,
    PassiveEnergy,
    MetalEnergy,
    // Network (decision 0013, stratified PZR of decision 0014).
    CellPressure,
    PhaseMass,
    PhaseEnergy,
    Tracer,
    PzrAlgebraic,
    PzrStock,
    Impulse,
    Rotor,
    // SG secondary owner.
    SecondaryStock,
    SecondaryChart,
    ReliefLift,
    // Rod bodies and guide passages owner.
    RodPosition,
    RodVelocity,
    GuideCurrent,
    // PZR metal and relief owner (G6).
    PzrMetal,
    PzrReliefLift,
}

/// One block's coordinate declaration, built once at composition.
#[derive(Clone, Debug, Default)]
pub struct Layout {
    pub labels: Vec<String>,
    pub classes: Vec<Class>,
    /// Prepared IDA identity: `true` differential, `false` algebraic. The
    /// current identity may change at an event (`differential()`).
    pub differential: Vec<bool>,
    /// Physical value of one solver unit of each coordinate; finite, > 0.
    pub scales: Vec<f64>,
    /// Physical row value of one solver unit; finite, > 0. For a
    /// differential coordinate it must equal the coordinate's scale.
    pub row_scales: Vec<f64>,
}

impl Layout {
    pub fn len(&self) -> usize {
        self.labels.len()
    }
    pub fn is_empty(&self) -> bool {
        self.labels.is_empty()
    }
    pub fn push(&mut self, label: String, class: Class, differential: bool, scale: f64, row: f64) {
        self.labels.push(label);
        self.classes.push(class);
        self.differential.push(differential);
        self.scales.push(scale);
        self.row_scales.push(row);
    }
    /// Refuse an inconsistent declaration before any composition.
    pub fn validate(&self, owner: &str) -> Result<(), Failure> {
        let n = self.labels.len();
        if [
            self.classes.len(),
            self.differential.len(),
            self.scales.len(),
            self.row_scales.len(),
        ]
        .iter()
        .any(|k| *k != n)
        {
            return Err(Failure::Fatal(format!("{owner}: layout lengths differ")));
        }
        for i in 0..n {
            let (s, r) = (self.scales[i], self.row_scales[i]);
            if !(s.is_finite() && s > 0. && r.is_finite() && r > 0.) {
                return Err(Failure::Fatal(format!(
                    "{owner}: coordinate {i} ({}) has scale {s} and row scale {r}",
                    self.labels[i]
                )));
            }
            if self.differential[i] && s != r {
                return Err(Failure::Fatal(format!(
                    "{owner}: differential coordinate {i} ({}) must use its own scale as row scale",
                    self.labels[i]
                )));
            }
        }
        Ok(())
    }
    /// Prepared IDA id vector (1 differential, 0 algebraic).
    pub fn ids(&self) -> Vec<f64> {
        self.differential
            .iter()
            .map(|d| if *d { 1. } else { 0. })
            .collect()
    }
}

/// One block's coordinates of one evaluation in physical units. With a
/// seed `d`, a value carries the direction `d*scale` and a rate
/// `cj*d*scale`: the directional derivative `dF/dy d + cj dF/dy' d`, the
/// network's own convention. Without a seed every direction is zero.
#[derive(Clone, Copy, Debug)]
pub struct Coordinates<'a> {
    y: &'a [f64],
    yp: &'a [f64],
    seed: Option<&'a [f64]>,
    cj: f64,
    scales: &'a [f64],
}

impl<'a> Coordinates<'a> {
    /// The block's own slices of `y`, `y'`, the seed and its scales.
    pub fn new(
        y: &'a [f64],
        yp: &'a [f64],
        seed: Option<&'a [f64]>,
        cj: f64,
        scales: &'a [f64],
    ) -> Result<Self, Failure> {
        if y.len() != scales.len()
            || yp.len() != scales.len()
            || seed.is_some_and(|d| d.len() != scales.len())
            || !cj.is_finite()
        {
            return Err(Failure::Fatal("block coordinate view layout".into()));
        }
        Ok(Self {
            y,
            yp,
            seed,
            cj,
            scales,
        })
    }
    pub fn len(&self) -> usize {
        self.scales.len()
    }
    pub fn is_empty(&self) -> bool {
        self.scales.is_empty()
    }
    /// Physical value of coordinate `i` and its direction.
    pub fn value(&self, i: usize) -> Scalar {
        Scalar::new(
            self.y[i] * self.scales[i],
            self.seed.map_or(0., |d| d[i]) * self.scales[i],
        )
    }
    /// Physical rate of coordinate `i` and its direction `cj*d*scale`.
    pub fn rate(&self, i: usize) -> Scalar {
        Scalar::new(
            self.yp[i] * self.scales[i],
            self.seed.map_or(0., |d| d[i]) * self.cj * self.scales[i],
        )
    }
    pub fn seeded(&self) -> bool {
        self.seed.is_some()
    }
}

/// The SG secondary state one SG's metal contacts see (memo Table 1.2).
#[derive(Clone, Copy, Debug)]
pub struct SecondaryView {
    pub pressure: Scalar,
    /// `T_sat(p_s)` from the maintained saturation of the same pressure.
    pub saturation_temperature: Scalar,
    pub liquid_volume: Scalar,
    pub steam_present: bool,
}

/// Declared interventions the composing harness issues at their times.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub enum Command {
    /// The manual turbine TRIP (`LD01.TG` TRIP), F5 (a): the STOP ramps the
    /// steam demand to zero over its travel; the trip requests the reactor
    /// trip through its named cause and the holding circuit opens after the
    /// declared delay (H6). Each owner applies its own part.
    TurbineTrip,
    /// The manual reactor-trip interrupt: the holding circuit opens at the
    /// command's time, with no turbine trip (G7's contrary case). The steam
    /// demand stays at its constant A/B values as a declared boundary.
    ManualReactorTrip,
}

/// Structural dependencies of one block, in its own indices, for the joined
/// sparse pattern. It must contain every dependency any state can produce,
/// including through modes and branches; a colored assembly refuses a
/// response outside it.
#[derive(Clone, Debug, Default)]
pub struct Structure {
    /// Per own row: own coordinates it reads, values or rates.
    pub own: Vec<Vec<usize>>,
    /// Per own row: network regular cells whose fluid state it reads.
    pub cells: Vec<Vec<usize>>,
    /// Per own row: network faces whose charts it reads.
    pub faces: Vec<Vec<usize>>,
    /// Per own row: SGs whose metal-to-secondary heat it reads (secondary
    /// owner only).
    pub heat: Vec<Vec<usize>>,
    /// Receipts it writes: (network cell, own coordinates the receipt reads,
    /// network cells whose fluid state the receipt reads).
    pub receipts: Vec<(usize, Vec<usize>, Vec<usize>)>,
    /// Moving volumes it writes: (network cell, own coordinates read).
    pub volumes: Vec<(usize, Vec<usize>)>,
    /// Per exported view (SG view per SG, travel per cluster): own
    /// coordinates read.
    pub outputs: Vec<Vec<usize>>,
}

/// Outcome of one discrete transaction at a located root or command.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Transaction {
    /// Energy deposited once into named finite solid stores (J), such as a
    /// seated body's arrival energy into its contacted fitting.
    pub deposits: Vec<(String, f64)>,
    /// What changed, for the event receipt: modes, totals before/after.
    pub receipt: serde_json::Value,
}

/// The SG secondary owner: one equilibrium volume per SG with its steam,
/// relief and feed ports (memo §2). Heat enters only through the SG metal,
/// whose contacts the joined operator evaluates against [`SecondaryView`].
pub trait Secondary<P> {
    fn layout(&self) -> &Layout;
    /// Prepared physical coordinates, layout order.
    fn prepared(&self) -> Vec<f64>;
    /// Current IDA identity (1 differential, 0 algebraic), layout order.
    fn differential(&self) -> Vec<f64>;
    /// Number of SGs; views and heats are indexed by the packet's
    /// `thermal.secondaries` index.
    fn generators(&self) -> usize;
    /// The state every SG's metal contacts see at these coordinates.
    fn views(
        &mut self,
        properties: &P,
        x: Coordinates<'_>,
        out: &mut [SecondaryView],
    ) -> Result<(), Failure>;
    /// Every own row in physical units, given the actual metal-to-secondary
    /// heat of each SG (W) from the same evaluation.
    fn rows(
        &mut self,
        properties: &P,
        t: f64,
        x: Coordinates<'_>,
        heat_w: &[Scalar],
        rows: &mut [Scalar],
    ) -> Result<(), Failure>;
    fn structure(&self) -> Structure;
    /// Root functions on accepted states (relief crack/full lift/reseat,
    /// geometric guards). Stock IDA cannot retry a root: refuse only fatally.
    fn root_count(&self) -> usize;
    fn roots(
        &mut self,
        properties: &P,
        t: f64,
        x: Coordinates<'_>,
        out: &mut [f64],
    ) -> Result<(), Failure>;
    /// The discrete transaction at located roots (`directions` per root
    /// function as IDAGetRootInfo). `y` holds own physical coordinates and
    /// may be changed only by conserving transactions.
    fn transact(
        &mut self,
        properties: &P,
        t: f64,
        directions: &[i32],
        y: &mut [f64],
    ) -> Result<Transaction, Failure>;
    fn command(&mut self, t: f64, command: Command) -> Result<Transaction, Failure>;
    /// The earliest declared time event strictly after `t` (for example the
    /// end of the STOP ramp), or `None`. The harness stops there and restarts
    /// by the exact consistent start.
    fn next_time_event(&self, t: f64) -> Option<f64>;
    /// The transaction of this owner's own declared time event when one is
    /// due exactly at `t` and not yet transacted, `None` otherwise. It is
    /// called at every time-event stop and after every command, because a
    /// root that is exactly zero at a restart never reports a crossing. Like
    /// `transact`, it changes own coordinates only by conserving
    /// transactions.
    fn time_event(
        &mut self,
        properties: &P,
        t: f64,
        y: &mut [f64],
    ) -> Result<Option<Transaction>, Failure>;
}

/// The rod bodies (spider and bodies, H7), their guide passages (F1 (a),
/// H4) and the network cell volumes they displace (memo §4).
pub trait Rods<P> {
    fn layout(&self) -> &Layout;
    fn prepared(&self) -> Vec<f64>;
    fn differential(&self) -> Vec<f64>;
    /// Number of clusters; travel is indexed as the source feedback's rods.
    fn clusters(&self) -> usize;
    /// Achieved travel per cluster (m) for the source feedback's overlap.
    fn travel(&self, x: Coordinates<'_>, out: &mut [Scalar]) -> Result<(), Failure>;
    /// Current fluid volume and rate of every regular network cell, from the
    /// compiled (packet) volumes and the bodies' current displacement.
    fn volumes(
        &self,
        x: Coordinates<'_>,
        compiled_m3: &[f64],
        out: &mut [CellVolume],
    ) -> Result<(), Failure>;
    /// Every own row in physical units, and the guide-passage receipts into
    /// the network cells, from the same evaluation's fluid state.
    fn rows(
        &mut self,
        properties: &P,
        t: f64,
        x: Coordinates<'_>,
        fluid: &Fluid<'_>,
        receipts: &mut Receipts<'_>,
        rows: &mut [Scalar],
    ) -> Result<(), Failure>;
    /// [`Rods::rows`] of the listed clusters only, as `(own row, value)`,
    /// each bitwise the full evaluation's, with only their receipts.
    #[allow(clippy::too_many_arguments)] // As rows, with the clusters.
    fn rows_local(
        &mut self,
        properties: &P,
        t: f64,
        x: Coordinates<'_>,
        fluid: &Fluid<'_>,
        clusters: &[usize],
        receipts: &mut Receipts<'_>,
        out: &mut Vec<(usize, Scalar)>,
    ) -> Result<(), Failure>;
    /// The clusters whose rows or receipts read, at these coordinates, a
    /// listed cell whose fluid state carries a direction in `fluid`, or a
    /// listed face's chart. Every other cluster's rows and receipts take no
    /// direction from them.
    fn readers(
        &self,
        x: Coordinates<'_>,
        fluid: &Fluid<'_>,
        cells: &[usize],
        faces: &[usize],
        out: &mut Vec<usize>,
    ) -> Result<(), Failure>;
    /// The clusters whose rows, receipts, travel or volumes read own
    /// coordinate `i`.
    fn coordinate_readers(&self, i: usize, out: &mut Vec<usize>) -> Result<(), Failure>;
    fn structure(&self) -> Structure;
    /// Root functions on accepted states (seats, kinks if declared).
    fn root_count(&self) -> usize;
    fn roots(
        &mut self,
        properties: &P,
        t: f64,
        x: Coordinates<'_>,
        fluid: &Fluid<'_>,
        out: &mut [f64],
    ) -> Result<(), Failure>;
    fn transact(
        &mut self,
        properties: &P,
        t: f64,
        directions: &[i32],
        y: &mut [f64],
    ) -> Result<Transaction, Failure>;
    fn command(&mut self, t: f64, command: Command) -> Result<Transaction, Failure>;
    /// The earliest declared time event strictly after `t` (for example the
    /// holding circuit's opening after its declared delay), or `None`.
    fn next_time_event(&self, t: f64) -> Option<f64>;
    /// As [`Secondary::time_event`]: the transaction of a time event due
    /// exactly at `t` (the holding circuit's opening releases every held
    /// cluster that is not stuck), `None` otherwise.
    fn time_event(
        &mut self,
        properties: &P,
        t: f64,
        y: &mut [f64],
    ) -> Result<Option<Transaction>, Failure>;
    /// Startup only: solve the owner's algebraic coordinates at the composed
    /// fluid state (the guide passages' steady currents), after which
    /// `prepared()` holds them. No differential coordinate changes.
    fn prepare(&mut self, properties: &P, fluid: &Fluid<'_>) -> Result<Transaction, Failure>;
}
