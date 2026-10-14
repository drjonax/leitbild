//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#s2-design-choices--11-october-delegated
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressurizer-thermal-state.md#shell-and-head-metal
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressure-and-inventory.md#independent-relief-candidate
//! The joined PZR block (G6): the stratified cell's heater rods, shell bands
//! and heads, and its relief lift, composed with the network through the
//! cell's boundary port (`network::Coupling::pzr_boundary`).
//!
//! Coordinates, in order: the relief lift in full strokes when the cell
//! declares a relief port, then one lumped 304 steel energy per heater rod
//! segment and per wall element (`Heaters::segments`, then
//! `Walls::elements`), exactly as the P2 verification cases compose them.
//! Every row is differential: the lift's `lift' = rate(motion)` and each
//! steel's `U' = Joule − fluid receipts − enclosure exchange − exterior
//! loss`, both evaluated by the walls' and heaters' own laws on the cell's
//! column of the same evaluation. The block hands the cell the heater and
//! wall receipts and the relief state (lift and the receiver's declared
//! backpressure); zone heat is zero, since every external heat into the
//! zones reaches them through the metal.
//!
//! G6 with P4 (S2 design choices, 11 October): the steel is prepared at the
//! composed cell's `Tsat(p_s)`, and the heater demand is the metal's
//! exterior loss (shell bands and both heads) at that temperature, computed
//! once and held constant. It stands in for the pressure controller's
//! steady output, which belongs to S3; control laws are S3.
//!
//! The relief is the independent device unchanged from its owner: demand
//! by root on raw PT1 (at the roof, so the roof pressure), finite lift
//! travel, and the mechanical stop at the end of travel, a transaction that
//! sets the lift exactly to 1 (open) or exactly to 0 (on the seat). The
//! block always reports two roots, the demand threshold and the travel; a
//! lift at rest reports the travel root as the constant [`DISARMED`].
use super::block::{Class, Coordinates, Layout, Transaction};
use crate::{
    network::{
        Failure,
        heaters::{BanksBlock, Caloric304, ContactBlock, HeaterCase, Heaters},
        stratified::{
            self, Boundary, Cell, Column, Heat, PortKind, ReliefDevice, ReliefMotion, ReliefState,
        },
        walls::{MetalRates, ShellBlock, WallCase, Walls},
    },
    thermal::{Scalar, WaterProperties},
};
use serde::Deserialize;
use serde_json::json;

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("joined PZR block: {}", reason.into()))
}

/// The travel root's value while the lift is at rest: constant, so it
/// never crosses zero.
pub const DISARMED: f64 = 1.;

/// The joined packet's `pzrMetal` section: the owners' strict blocks,
/// unchanged, and the relief receiver's backpressure.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Section {
    /// `ld01-pzr-heater-banks`.
    #[serde(rename = "heaterBanks")]
    pub heater_banks: BanksBlock,
    /// `ld01-pzr-heater-contact`.
    #[serde(rename = "heaterContact")]
    pub heater_contact: ContactBlock,
    /// `reference-304-caloric`.
    #[serde(rename = "caloric304")]
    pub caloric: Caloric304,
    /// `ld01-pzr-shell`.
    pub shell: ShellBlock,
    /// The relief receiver's backpressure, held constant: the containment
    /// at the relief device's calibration backpressure.
    #[serde(rename = "reliefBackPressure_Pa")]
    pub relief_back_pressure_pa: f64,
    /// The compiler's consumed pages, for receipts only.
    pub provenance: serde_json::Value,
}

/// The relief device and its discrete state, retained by the block.
#[derive(Clone, Copy, Debug)]
pub struct Relief {
    /// The relief port's index in the cell's ports.
    pub port: usize,
    pub device: ReliefDevice,
    pub back_pressure_pa: f64,
    pub motion: ReliefMotion,
    /// The demand's state: open above the opening pressure until the roof
    /// pressure falls through the reseat pressure.
    pub demand_open: bool,
}

/// What one relief transaction did, for its receipt.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ReliefEvent {
    pub before: (bool, ReliefMotion),
    pub after: (bool, ReliefMotion),
    pub stop: Option<stratified::Stop>,
}

impl Relief {
    /// The two roots at the roof pressure and the lift: the demand
    /// threshold (`p_roof − reseat` with demand open, `p_roof − opening`
    /// with it closed) and the distance to the end of travel while moving,
    /// [`DISARMED`] at rest.
    pub fn roots(&self, roof_pressure_pa: f64, lift: f64) -> [f64; 2] {
        let r = self
            .device
            .roots(s(roof_pressure_pa), s(lift), self.demand_open, self.motion);
        [r.demand.value, r.travel.map_or(DISARMED, |t| t.value)]
    }
    /// The transaction at located roots, `[demand, travel]` directions as
    /// IDAGetRootInfo. The travel root first: the mechanical stop sets the
    /// lift exactly to 1 or 0 (`ReliefDevice::stop`, refused beyond
    /// `root_bound` full strokes from the stop). Then the demand: rising
    /// through the opening pressure with demand closed opens it, falling
    /// through the reseat pressure with demand open closes it; a crossing
    /// in the other direction refuses. Opening demand starts a closed or
    /// closing lift opening, closing demand starts an open or opening lift
    /// closing.
    pub fn transact(
        &mut self,
        directions: [i32; 2],
        lift: &mut f64,
        root_bound: f64,
    ) -> Result<ReliefEvent, Failure> {
        let before = (self.demand_open, self.motion);
        let mut stop = None;
        if directions[1] != 0 {
            let report = self.device.stop(self.motion, lift, root_bound)?;
            self.motion = report.motion_after;
            stop = Some(report);
        }
        if directions[0] != 0 {
            let expected = if self.demand_open { -1 } else { 1 };
            if directions[0] != expected {
                return Err(fatal(format!(
                    "relief demand root crossed in direction {} with demand_open = {}",
                    directions[0], self.demand_open
                )));
            }
            self.demand_open = !self.demand_open;
            self.motion = match (self.demand_open, self.motion) {
                (true, ReliefMotion::Closed | ReliefMotion::Closing) => ReliefMotion::Opening,
                (false, ReliefMotion::Open | ReliefMotion::Opening) => ReliefMotion::Closing,
                (_, m) => m,
            };
        }
        Ok(ReliefEvent {
            before,
            after: (self.demand_open, self.motion),
            stop,
        })
    }
}

/// The joined PZR block.
pub struct Pzr {
    heaters: Heaters,
    walls: Walls,
    relief: Option<Relief>,
    /// P4's constant heater demand (W) and each bank's delivered power.
    request_w: f64,
    bank_power_w: Vec<f64>,
    /// `Tsat(p_s)` of the composed cell: the prepared steel temperature.
    saturation_temperature_k: f64,
    /// A travel root's lift farther than this from its stop (full strokes)
    /// is not that root; declared by the harness before any transaction.
    lift_root_bound: Option<f64>,
    layout: Layout,
    prepared: Vec<f64>,
    /// The metal's sources of the last value evaluation.
    rates: Option<MetalRates>,
}

impl Pzr {
    /// Compose the block on the cell from the packet's section, with the
    /// steel at `saturation_temperature_k`, the composed cell's
    /// `Tsat(p_s)`. Refuses a relief port whose demand would not read the
    /// roof pressure (PT1 below the roof), a nonpositive backpressure or a
    /// heater demand outside the banks' range.
    pub fn new(
        cell: &Cell,
        section: &Section,
        saturation_temperature_k: f64,
    ) -> Result<Self, Failure> {
        let contact = section.heater_contact;
        let heaters = Heaters::new(
            cell,
            &section.heater_banks,
            section.caloric,
            contact,
            HeaterCase::nominal(&contact),
        )?;
        let walls = Walls::new(
            cell,
            &heaters,
            section.shell.clone(),
            section.caloric,
            contact,
            WallCase::nominal(&contact, &section.shell),
        )?;
        let p = cell.parameters();
        let relief = match p
            .ports
            .iter()
            .enumerate()
            .find(|(_, port)| port.kind == PortKind::Relief)
        {
            None => None,
            Some((index, port)) => {
                let device = port
                    .relief
                    .ok_or_else(|| fatal(format!("relief port {} without its device", port.id)))?;
                if p.tap(stratified::PT1)? != p.top_m {
                    return Err(fatal(
                        "the relief demand reads raw PT1, which must be the roof tap",
                    ));
                }
                let back = section.relief_back_pressure_pa;
                if !(back.is_finite() && back > 0.) {
                    return Err(fatal(format!(
                        "relief backpressure {back} Pa must be positive"
                    )));
                }
                Some(Relief {
                    port: index,
                    device,
                    back_pressure_pa: back,
                    motion: ReliefMotion::Closed,
                    demand_open: false,
                })
            }
        };
        if !(saturation_temperature_k.is_finite() && saturation_temperature_k > 0.) {
            return Err(fatal(format!(
                "steel preparation temperature {saturation_temperature_k} K"
            )));
        }
        let steel_t = s(saturation_temperature_k);
        let request_w = (0..walls.elements().len())
            .map(|i| walls.exterior(i, steel_t).value)
            .sum::<f64>();
        let bank_power_w = heaters.bank_powers(request_w)?;
        let mut energy = heaters.prepared_energy(saturation_temperature_k)?;
        energy.extend(walls.prepared_energy(saturation_temperature_k)?);
        let mut layout = Layout::default();
        let mut prepared = Vec::new();
        if relief.is_some() {
            layout.push(
                "PZR relief lift (full strokes)".into(),
                Class::PzrReliefLift,
                true,
                1.,
                1.,
            );
            prepared.push(0.);
        }
        let labels = heaters
            .census()
            .coordinates
            .into_iter()
            .chain(walls.census().coordinates);
        for (label, e) in labels.zip(&energy) {
            if !(e.is_finite() && *e > 0.) {
                return Err(fatal(format!("{label}: prepared steel energy {e} J")));
            }
            layout.push(label, Class::PzrMetal, true, *e, *e);
            prepared.push(*e);
        }
        layout.validate("pzr")?;
        Ok(Self {
            heaters,
            walls,
            relief,
            request_w,
            bank_power_w,
            saturation_temperature_k,
            lift_root_bound: None,
            layout,
            prepared,
            rates: None,
        })
    }

    pub fn layout(&self) -> &Layout {
        &self.layout
    }
    /// Prepared physical coordinates: the lift on its seat, every steel at
    /// the composed `Tsat(p_s)`.
    pub fn prepared(&self) -> &[f64] {
        &self.prepared
    }
    /// Every coordinate is differential in every mode.
    pub fn differential(&self) -> Vec<f64> {
        self.layout.ids()
    }
    pub fn heaters(&self) -> &Heaters {
        &self.heaters
    }
    pub fn walls(&self) -> &Walls {
        &self.walls
    }
    pub fn relief(&self) -> Option<Relief> {
        self.relief
    }
    /// P4's constant heater demand, W.
    pub fn request_w(&self) -> f64 {
        self.request_w
    }
    pub fn bank_power_w(&self) -> &[f64] {
        &self.bank_power_w
    }
    pub fn saturation_temperature_k(&self) -> f64 {
        self.saturation_temperature_k
    }
    /// The metal's sources of the last value evaluation.
    pub fn rates(&self) -> Option<&MetalRates> {
        self.rates.as_ref()
    }
    /// First steel coordinate.
    pub fn metal_base(&self) -> usize {
        usize::from(self.relief.is_some())
    }
    /// Declare the lift's root bound (full strokes): the harness's absolute
    /// tolerance of the lift (G12: S1's scaled floor times its scale).
    pub fn declare_lift_root_bound(&mut self, bound: f64) -> Result<(), Failure> {
        if !(bound.is_finite() && bound >= 0.) {
            return Err(fatal(format!("lift root bound {bound}")));
        }
        self.lift_root_bound = Some(bound);
        Ok(())
    }

    /// The cell's boundary on `column` and every own row in physical units
    /// (`rows`, layout order), at the block's coordinates `x`; `record`
    /// keeps the metal's sources (a value evaluation's).
    pub fn boundary<P: WaterProperties>(
        &mut self,
        properties: &P,
        cell: &Cell,
        column: &Column,
        x: Coordinates<'_>,
        rows: &mut [Scalar],
        record: bool,
    ) -> Result<Boundary, Failure> {
        let n = self.layout.len();
        if x.len() != n || rows.len() != n {
            return Err(fatal("block coordinate layout"));
        }
        let base = self.metal_base();
        let segments = self.heaters.segments().len();
        let rod: Vec<Scalar> = (base..base + segments).map(|i| x.value(i)).collect();
        let wall: Vec<Scalar> = (base + segments..n).map(|i| x.value(i)).collect();
        let rates = self.walls.rates(
            cell,
            column,
            &self.heaters,
            &rod,
            &self.bank_power_w,
            &wall,
            properties,
        )?;
        let sources = rates
            .rod_metal_rates()
            .into_iter()
            .chain(rates.wall_metal_rates());
        for (j, source) in sources.enumerate() {
            rows[base + j] = x.rate(base + j) - source;
        }
        let relief = self.relief.map(|r| {
            rows[0] = x.rate(0) - s(r.device.lift_rate(r.motion));
            ReliefState {
                lift: x.value(0),
                back_pressure_pa: Some(s(r.back_pressure_pa)),
            }
        });
        let boundary = Boundary {
            heat: Heat::zero(),
            heaters: rates.heater_receipts(),
            walls: rates.wall_receipts(),
            relief,
        };
        if record {
            self.rates = Some(rates);
        }
        Ok(boundary)
    }

    /// Root functions: the relief's demand and travel, none without one.
    pub fn root_count(&self) -> usize {
        if self.relief.is_some() { 2 } else { 0 }
    }
    /// The roots at the roof pressure and the block's physical coordinates.
    pub fn roots(&self, roof_pressure_pa: f64, x: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        if x.len() != self.layout.len() || out.len() != self.root_count() {
            return Err(fatal("root layout"));
        }
        if let Some(r) = &self.relief {
            out.copy_from_slice(&r.roots(roof_pressure_pa, x[0]));
        }
        if out.iter().any(|v| !v.is_finite()) {
            return Err(fatal("nonfinite relief root"));
        }
        Ok(())
    }
    /// The relief's transaction at located roots on the block's physical
    /// coordinates `y`; only the lift may change, by the mechanical stop.
    pub fn transact(
        &mut self,
        t: f64,
        directions: &[i32],
        roof_pressure_pa: f64,
        y: &mut [f64],
    ) -> Result<Transaction, Failure> {
        if directions.len() != self.root_count() || y.len() != self.layout.len() {
            return Err(fatal("transaction layout"));
        }
        let Some(relief) = self.relief.as_mut() else {
            return Ok(Transaction {
                deposits: Vec::new(),
                receipt: json!({"owner":"pzr","t_s":t,"relief":null}),
            });
        };
        let located = y[0];
        let bound = match (directions[1], self.lift_root_bound) {
            (0, _) => 0.,
            (_, Some(b)) => b,
            (_, None) => {
                return Err(fatal(
                    "a relief travel stop needs the declared lift root bound",
                ));
            }
        };
        let event = relief.transact([directions[0], directions[1]], &mut y[0], bound)?;
        Ok(Transaction {
            deposits: Vec::new(),
            receipt: json!({"owner":"pzr","t_s":t,"roof_pressure_pa":roof_pressure_pa,
                "demand_root":directions[0],"travel_root":directions[1],
                "before":{"demand_open":event.before.0,"motion":format!("{:?}",event.before.1)},
                "after":{"demand_open":event.after.0,"motion":format!("{:?}",event.after.1)},
                "lift_located":located,"lift_after":y[0],
                "stop":event.stop.map(|r| json!({"motion_before":format!("{:?}",r.motion_before),
                    "motion_after":format!("{:?}",r.motion_after),"lift_before":r.lift_before,
                    "lift_after":r.lift_after,"defect":r.defect})),
                "lift_rate_per_s":relief.device.lift_rate(relief.motion),
                "stateChanged":event.before != event.after}),
        })
    }
    /// The heater demand stays P4's constant and the relief answers its own
    /// demand: a command changes nothing here.
    pub fn command(&self, t: f64, command: super::block::Command) -> Transaction {
        Transaction {
            deposits: Vec::new(),
            receipt: json!({"owner":"pzr","t_s":t,"command":command,
                "heaterDemand_W":self.request_w,"note":"constant heater demand (P4); control laws are S3"}),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn relief() -> Relief {
        Relief {
            port: 2,
            device: ReliefDevice {
                opening_pa: 15.8e6,
                reseat_pa: 15.6e6,
                full_strokes_per_s: 20.,
                effective_area_per_lift_m2: 0.004,
            },
            back_pressure_pa: 101_325.,
            motion: ReliefMotion::Closed,
            demand_open: false,
        }
    }

    #[test]
    fn closed_relief_watches_the_opening_pressure_with_travel_disarmed() {
        let r = relief();
        assert_eq!(r.roots(15.0e6, 0.), [15.0e6 - 15.8e6, DISARMED]);
        assert_eq!(r.roots(15.9e6, 0.), [15.9e6 - 15.8e6, DISARMED]);
    }

    #[test]
    fn rising_demand_opens_and_the_full_lift_stop_sets_exactly_one() {
        let mut r = relief();
        let mut lift = 0.;
        let e = r.transact([1, 0], &mut lift, 1e-8).unwrap();
        assert_eq!(e.after, (true, ReliefMotion::Opening));
        assert_eq!(lift, 0.);
        // While opening the demand watches the reseat and travel 1 − lift.
        assert_eq!(r.roots(15.9e6, 0.25), [15.9e6 - 15.6e6, 0.75]);
        let mut lift = 1. - 3e-9;
        let e = r.transact([0, -1], &mut lift, 1e-8).unwrap();
        assert_eq!(lift, 1.);
        assert_eq!(e.after, (true, ReliefMotion::Open));
        let stop = e.stop.unwrap();
        assert_eq!(stop.lift_after, 1.);
        assert_eq!(stop.defect, (1. - 3e-9) - 1.);
        assert_eq!(r.roots(15.7e6, 1.)[1], DISARMED);
    }

    #[test]
    fn falling_demand_closes_and_the_seat_transaction_sets_exactly_zero() {
        let mut r = Relief {
            motion: ReliefMotion::Open,
            demand_open: true,
            ..relief()
        };
        let mut lift = 1.;
        let e = r.transact([-1, 0], &mut lift, 1e-8).unwrap();
        assert_eq!(e.after, (false, ReliefMotion::Closing));
        // Closing: demand watches the opening pressure again, travel = lift.
        assert_eq!(r.roots(15.5e6, 0.4), [15.5e6 - 15.8e6, 0.4]);
        let mut lift = 2e-9;
        let e = r.transact([0, -1], &mut lift, 1e-8).unwrap();
        assert_eq!(lift, 0.);
        assert_eq!(e.after, (false, ReliefMotion::Closed));
        assert_eq!(e.stop.unwrap().lift_after, 0.);
    }

    #[test]
    fn a_reversal_mid_travel_turns_the_lift_without_a_stop() {
        let mut r = Relief {
            motion: ReliefMotion::Opening,
            demand_open: true,
            ..relief()
        };
        let mut lift = 0.6;
        let e = r.transact([-1, 0], &mut lift, 1e-8).unwrap();
        assert_eq!(e.after, (false, ReliefMotion::Closing));
        assert_eq!(lift, 0.6);
        assert!(e.stop.is_none());
        let e = r.transact([1, 0], &mut lift, 1e-8).unwrap();
        assert_eq!(e.after, (true, ReliefMotion::Opening));
    }

    #[test]
    fn a_stop_and_a_demand_at_the_same_instant_take_the_stop_first() {
        let mut r = Relief {
            motion: ReliefMotion::Opening,
            demand_open: true,
            ..relief()
        };
        let mut lift = 1.;
        let e = r.transact([-1, -1], &mut lift, 1e-8).unwrap();
        assert_eq!(lift, 1.);
        assert_eq!(e.stop.unwrap().motion_after, ReliefMotion::Open);
        assert_eq!(e.after, (false, ReliefMotion::Closing));
    }

    #[test]
    fn contradicting_crossings_and_far_stops_refuse() {
        let mut r = relief();
        let mut lift = 0.;
        assert!(matches!(
            r.transact([-1, 0], &mut lift, 1e-8),
            Err(Failure::Fatal(_))
        ));
        let mut r = Relief {
            motion: ReliefMotion::Closing,
            ..relief()
        };
        let mut lift = 1e-6;
        assert!(r.transact([0, -1], &mut lift, 1e-8).is_err());
        assert_eq!(lift, 1e-6);
        // A lift at rest has no travel to stop.
        let mut r = relief();
        let mut lift = 0.;
        assert!(r.transact([0, 1], &mut lift, 1e-8).is_err());
    }
}
