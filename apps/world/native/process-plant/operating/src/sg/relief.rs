//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-power/admission-and-protection.md#turbine-trip-and-reset-semantics
//! The SG spring relief characteristic: crack, full lift and reseat on raw
//! SG pressure, a first-order lift lag toward the branch's linear opening
//! characteristic, the branch memory of F4 (a) with H5, and the disc seat.
//!
//! The ascending branch opens linearly from crack to full lift; the
//! descending branch from reseat to full lift. The memory switches from
//! ascending to descending when the inlet reaches full lift (not when the
//! lagged lift does), and back when the inlet falls to reseat. Both
//! characteristics are fully open at full lift and closed at reseat, so the
//! target opening is continuous across both switches. A lift that never
//! reaches full lift recloses along the ascending characteristic at crack.
//!
//! The lag alone approaches zero only asymptotically. With its target zero,
//! the disc seats when the lift falls to the declared seat lift: the lift is
//! set to exactly zero and held there, so the valve has no flow and needs no
//! nozzle evaluation until the target opens again at crack. A target that
//! reaches zero with the lift already below the seat lift (a crack or reseat
//! crossing) seats at that crossing.
//!
//! Each valve arms only its own roots: ascending crack and full lift,
//! descending reseat, and the seat while the disc is closing (lifted with its
//! target zero: ascending below crack, entered at a crack fall or a reseat).
//! A disarmed root never crosses, so the memory cannot chatter at either
//! switch, and an opening disc passing the seat lift is no event.
use crate::thermal::Scalar;
use serde::Serialize;

/// The branch memory of one valve.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Branch {
    Ascending,
    Descending,
}

/// The mechanical state of one valve.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Valve {
    pub branch: Branch,
    /// The disc rests on its seat: lift exactly zero, no flow.
    pub seated: bool,
    /// The lifted disc's target is zero (ascending below crack): it closes
    /// toward its seat.
    pub closing: bool,
}

impl Valve {
    pub const SEATED: Self = Self {
        branch: Branch::Ascending,
        seated: true,
        closing: false,
    };
    /// Lifted with its target open, on a branch.
    pub const fn open(branch: Branch) -> Self {
        Self {
            branch,
            seated: false,
            closing: false,
        }
    }
    pub const CLOSING: Self = Self {
        branch: Branch::Ascending,
        seated: false,
        closing: true,
    };
}

/// A root threshold of the characteristic.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Threshold {
    /// Inlet at crack on the ascending branch: a C0 kink; rising unseats a
    /// seated disc; falling seats a lift already below the seat lift.
    Crack,
    /// The inlet reaches full lift on the ascending branch: switch to descending.
    FullLift,
    /// The inlet falls to reseat on the descending branch: switch to ascending.
    Reseat,
    /// The closing disc's lift falls to the seat lift.
    Seat,
}

/// Outcome of a located root crossing.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Transition {
    pub before: Valve,
    pub after: Valve,
    pub threshold: Threshold,
    /// +1 rising, -1 falling.
    pub direction: i32,
    /// The located lift the seat removes, when the disc seats.
    pub seated_from_lift: Option<f64>,
}

/// The selected characteristic shared by every valve of the owner's block.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Characteristic {
    pub crack_pa: f64,
    pub full_lift_pa: f64,
    pub reseat_pa: f64,
    pub lag_s: f64,
    /// Lift (fraction of full lift) at which a closing disc seats.
    pub seat_lift: f64,
}

/// Unit clamp selected by value only, so a seeded evaluation stays linear in
/// its seed (an exact tie keeps the interior branch's direction).
fn unit(x: Scalar) -> Scalar {
    if x.value < 0. {
        Scalar::constant(0.)
    } else if x.value > 1. {
        Scalar::constant(1.)
    } else {
        x
    }
}

impl Characteristic {
    /// Admit the selection: reseat below crack below full lift, a positive
    /// lag, a seat lift strictly between zero and full lift.
    pub fn new(
        crack_pa: f64,
        full_lift_pa: f64,
        reseat_pa: f64,
        lag_s: f64,
        seat_lift: f64,
    ) -> Result<Self, String> {
        let finite = [crack_pa, full_lift_pa, reseat_pa, lag_s, seat_lift]
            .iter()
            .all(|v| v.is_finite() && *v > 0.);
        if !finite || !(reseat_pa < crack_pa && crack_pa < full_lift_pa) || seat_lift >= 1. {
            return Err(format!(
                "relief characteristic needs 0 < reseat < crack < full lift, a positive lag and 0 < seat lift < 1, not {reseat_pa}/{crack_pa}/{full_lift_pa} Pa, {lag_s} s, {seat_lift}"
            ));
        }
        Ok(Self {
            crack_pa,
            full_lift_pa,
            reseat_pa,
            lag_s,
            seat_lift,
        })
    }

    /// Lower edge of a branch's linear opening characteristic.
    pub fn lower_edge_pa(&self, branch: Branch) -> f64 {
        match branch {
            Branch::Ascending => self.crack_pa,
            Branch::Descending => self.reseat_pa,
        }
    }

    /// Target opening of the branch's characteristic at inlet pressure `p`:
    /// zero below its lower edge, one at and above full lift, linear between.
    pub fn target(&self, branch: Branch, p: Scalar) -> Scalar {
        let low = self.lower_edge_pa(branch);
        unit((p - Scalar::constant(low)) / Scalar::constant(self.full_lift_pa - low))
    }

    /// The lift rate: the first-order response `(target - lift)/lag` of a
    /// lifted disc, exactly zero for a seated one.
    pub fn lift_rate(&self, valve: Valve, p: Scalar, lift: Scalar) -> Scalar {
        if valve.seated {
            Scalar::constant(0.)
        } else {
            (self.target(valve.branch, p) - lift) / Scalar::constant(self.lag_s)
        }
    }

    /// The roots a valve arms, in a fixed order.
    pub fn armed(valve: Valve) -> &'static [Threshold] {
        match (valve.branch, valve.closing) {
            (Branch::Ascending, true) => &[Threshold::Crack, Threshold::FullLift, Threshold::Seat],
            (Branch::Ascending, false) => &[Threshold::Crack, Threshold::FullLift],
            (Branch::Descending, _) => &[Threshold::Reseat],
        }
    }

    /// Root function value: pressure thresholds in MPa, the seat in lift.
    pub fn root(&self, threshold: Threshold, p_pa: f64, lift: f64) -> f64 {
        match threshold {
            Threshold::Crack => (p_pa - self.crack_pa) * 1e-6,
            Threshold::FullLift => (p_pa - self.full_lift_pa) * 1e-6,
            Threshold::Reseat => (p_pa - self.reseat_pa) * 1e-6,
            Threshold::Seat => lift - self.seat_lift,
        }
    }

    /// The valve after a located crossing, at its located lift.
    /// A threshold the valve does not arm, or a crossing its memory
    /// excludes, is refused: the declared state would contradict the rule.
    pub fn transition(
        &self,
        valve: Valve,
        threshold: Threshold,
        direction: i32,
        lift: f64,
    ) -> Result<Transition, String> {
        let refuse = || {
            Err(format!(
                "relief {threshold:?} crossing {direction} for {valve:?} contradicts its memory"
            ))
        };
        if !Self::armed(valve).contains(&threshold) || !(direction == 1 || direction == -1) {
            return refuse();
        }
        // Where the target becomes zero, a lift already at or below the seat
        // lift seats at once; otherwise the disc closes toward its seat.
        let closes = |seated_from_lift: &mut Option<f64>| {
            if lift <= self.seat_lift {
                *seated_from_lift = Some(lift);
                Valve::SEATED
            } else {
                Valve::CLOSING
            }
        };
        let mut seated_from_lift = None;
        let after = match (valve.branch, threshold, direction, valve.seated, valve.closing) {
            // Crack rising opens the target: it unseats or stops a closing.
            (Branch::Ascending, Threshold::Crack, 1, _, _) => Valve::open(Branch::Ascending),
            // Crack falling: the target returns to zero.
            (Branch::Ascending, Threshold::Crack, -1, false, false) => closes(&mut seated_from_lift),
            (Branch::Ascending, Threshold::FullLift, 1, _, _) => Valve::open(Branch::Descending),
            (Branch::Descending, Threshold::Reseat, -1, _, _) => closes(&mut seated_from_lift),
            (Branch::Ascending, Threshold::Seat, -1, false, true) => {
                seated_from_lift = Some(lift);
                Valve::SEATED
            }
            _ => return refuse(),
        };
        Ok(Transition {
            before: valve,
            after,
            threshold,
            direction,
            seated_from_lift,
        })
    }

    /// A declared state must agree with the rule at an accepted pressure and
    /// lift: ascending lies below full lift, descending above reseat; a
    /// seated disc is ascending with exactly zero lift, a closing one
    /// ascending and lifted (the crack root, not this check, locates where
    /// the target changes).
    pub fn admits(&self, valve: Valve, p_pa: f64, lift: f64) -> bool {
        p_pa.is_finite()
            && lift.is_finite()
            && match valve.branch {
                Branch::Ascending => p_pa < self.full_lift_pa,
                Branch::Descending => p_pa > self.reseat_pa,
            }
            && !(valve.seated && valve.closing)
            && (!valve.seated || (lift == 0. && valve.branch == Branch::Ascending))
            && (!valve.closing || valve.branch == Branch::Ascending)
    }
}
