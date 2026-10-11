//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-power/admission-and-protection.md#turbine-trip-and-reset-semantics
//! The SG spring relief characteristic: crack, full lift and reseat on raw
//! SG pressure, a first-order lift lag toward the branch's linear opening
//! characteristic, and the branch memory of F4 (a) with H5.
//!
//! The ascending branch opens linearly from crack to full lift; the
//! descending branch from reseat to full lift. The memory switches from
//! ascending to descending when the inlet reaches full lift (not when the
//! lagged lift does), and back when the inlet falls to reseat. Both
//! characteristics are fully open at full lift and closed at reseat, so the
//! target opening is continuous across both switches. A lift that never
//! reaches full lift recloses along the ascending characteristic at crack.
//!
//! Each branch arms only its own roots: ascending the crack kink and the
//! full-lift switch, descending the reseat switch. A pressure hovering at
//! full lift after the switch therefore arms no root there, and one hovering
//! at reseat after the switch back arms none below crack: the memory cannot
//! chatter. The descending branch's own full-lift kink is C0 and unrooted.
//! No discrete state other than the branch exists; the lift is the lagged
//! coordinate the caller retains.
use crate::thermal::Scalar;
use serde::Serialize;

/// The branch memory of one valve.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Branch {
    Ascending,
    Descending,
}

/// A root threshold of the characteristic, on raw SG pressure.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Threshold {
    /// The ascending characteristic leaves zero: a C0 kink, no memory change.
    Crack,
    /// The inlet reaches full lift on the ascending branch: switch to descending.
    FullLift,
    /// The inlet falls to reseat on the descending branch: switch to ascending.
    Reseat,
}

/// Outcome of a located root crossing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Transition {
    pub before: Branch,
    pub after: Branch,
    pub threshold: Threshold,
    /// +1 rising, -1 falling.
    pub direction: i32,
}

/// The selected characteristic shared by every valve of the owner's block.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Characteristic {
    pub crack_pa: f64,
    pub full_lift_pa: f64,
    pub reseat_pa: f64,
    pub lag_s: f64,
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
    /// Admit the selection: reseat below crack below full lift, a positive lag.
    pub fn new(
        crack_pa: f64,
        full_lift_pa: f64,
        reseat_pa: f64,
        lag_s: f64,
    ) -> Result<Self, String> {
        let finite = [crack_pa, full_lift_pa, reseat_pa, lag_s]
            .iter()
            .all(|v| v.is_finite() && *v > 0.);
        if !finite || !(reseat_pa < crack_pa && crack_pa < full_lift_pa) {
            return Err(format!(
                "relief characteristic needs 0 < reseat < crack < full lift and a positive lag, not {reseat_pa}/{crack_pa}/{full_lift_pa} Pa, {lag_s} s"
            ));
        }
        Ok(Self {
            crack_pa,
            full_lift_pa,
            reseat_pa,
            lag_s,
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

    /// The first-order lift response toward the target: `(target - lift)/lag`.
    pub fn lift_rate(&self, branch: Branch, p: Scalar, lift: Scalar) -> Scalar {
        (self.target(branch, p) - lift) / Scalar::constant(self.lag_s)
    }

    /// The roots a branch arms, in a fixed order.
    pub fn armed(branch: Branch) -> &'static [Threshold] {
        match branch {
            Branch::Ascending => &[Threshold::Crack, Threshold::FullLift],
            Branch::Descending => &[Threshold::Reseat],
        }
    }

    pub fn threshold_pa(&self, threshold: Threshold) -> f64 {
        match threshold {
            Threshold::Crack => self.crack_pa,
            Threshold::FullLift => self.full_lift_pa,
            Threshold::Reseat => self.reseat_pa,
        }
    }

    /// Root function value in MPa: zero exactly at the threshold.
    pub fn root(&self, threshold: Threshold, p_pa: f64) -> f64 {
        (p_pa - self.threshold_pa(threshold)) * 1e-6
    }

    /// The branch memory after a located crossing. A crack crossing is a kink
    /// and keeps the branch. A threshold the branch does not arm, or a
    /// crossing in the direction its memory excludes, is refused: it would
    /// mean the declared memory contradicts the rule.
    pub fn transition(
        &self,
        branch: Branch,
        threshold: Threshold,
        direction: i32,
    ) -> Result<Transition, String> {
        let after = match (branch, threshold, direction) {
            (Branch::Ascending, Threshold::Crack, 1 | -1) => Branch::Ascending,
            (Branch::Ascending, Threshold::FullLift, 1) => Branch::Descending,
            (Branch::Descending, Threshold::Reseat, -1) => Branch::Ascending,
            _ => {
                return Err(format!(
                    "relief {threshold:?} crossing {direction} on the {branch:?} branch contradicts its memory"
                ));
            }
        };
        Ok(Transition {
            before: branch,
            after,
            threshold,
            direction,
        })
    }

    /// A declared memory must agree with the rule at an accepted pressure:
    /// ascending lies below full lift, descending above reseat.
    pub fn admits(&self, branch: Branch, p_pa: f64) -> bool {
        p_pa.is_finite()
            && match branch {
                Branch::Ascending => p_pa < self.full_lift_pa,
                Branch::Descending => p_pa > self.reseat_pa,
            }
    }
}
