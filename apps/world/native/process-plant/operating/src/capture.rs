//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/heat-and-history.md#compact-hot-reference-energy-and-material-preparation
//! Finite effective fertile capture, using the SAME exposure as nuclear loss.
//!
//! A target atom becomes one effective product. The product is bookkeeping for
//! this admitted capture reserve, not a resolved U/Np/Pu isotope chain. Binding
//! heat is separate from the two postcapture energy stores. No fixed capture
//! to fission ratio, extra neutron-kinetic heater or irradiation reset exists.

use std::fmt;

#[derive(Clone, Copy, Debug)]
pub struct Parameters {
    pub cross_section_m2: f64,
    pub binding_joules_per_capture: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Receipt {
    pub captures_per_s: f64,
    pub target_rate_per_s: f64,
    pub product_rate_per_s: f64,
    pub binding_w: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Error;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid finite capture coefficient, trial or receipt")
    }
}
impl std::error::Error for Error {}

impl Parameters {
    pub fn validate(self) -> Result<(), Error> {
        if !self.cross_section_m2.is_finite()
            || self.cross_section_m2 <= 0.
            || !self.binding_joules_per_capture.is_finite()
            || self.binding_joules_per_capture < 0.
        {
            return Err(Error);
        }
        Ok(())
    }

    /// Signed finite solver trials are not accepted physical inventories.
    pub fn rates(self, target_atoms: f64, exposure_per_m2_s: f64) -> Result<Receipt, Error> {
        self.validate()?;
        if !target_atoms.is_finite() || !exposure_per_m2_s.is_finite() {
            return Err(Error);
        }
        self.receipt(self.cross_section_m2 * target_atoms * exposure_per_m2_s)
    }

    pub fn tangent(
        self,
        target_atoms: f64,
        exposure_per_m2_s: f64,
        target_direction: f64,
        exposure_direction: f64,
    ) -> Result<Receipt, Error> {
        self.validate()?;
        if ![
            target_atoms,
            exposure_per_m2_s,
            target_direction,
            exposure_direction,
        ]
        .iter()
        .all(|value| value.is_finite())
        {
            return Err(Error);
        }
        self.receipt(
            self.cross_section_m2
                * (target_direction * exposure_per_m2_s + target_atoms * exposure_direction),
        )
    }

    fn receipt(self, captures_per_s: f64) -> Result<Receipt, Error> {
        let binding_w = self.binding_joules_per_capture * captures_per_s;
        if !captures_per_s.is_finite() || !binding_w.is_finite() {
            return Err(Error);
        }
        Ok(Receipt {
            captures_per_s,
            target_rate_per_s: -captures_per_s,
            product_rate_per_s: captures_per_s,
            binding_w,
        })
    }
}

/// Admission is explicit and separate from trial evaluation.
pub fn validate_accepted(
    target_atoms: f64,
    product_atoms: f64,
    exposure: f64,
) -> Result<(), Error> {
    if ![target_atoms, product_atoms, exposure]
        .iter()
        .all(|value| value.is_finite() && *value >= 0.)
    {
        return Err(Error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: Parameters = Parameters {
        cross_section_m2: 4e-28,
        binding_joules_per_capture: 4.8063822 * 1.602_176_634e-13,
    };

    #[test]
    fn finite_target_and_exposure_not_fission_proxy_pay_one_capture() {
        let result = P.rates(2e25, 3e17).unwrap();
        assert_eq!(result.captures_per_s, 2.4e15);
        assert_eq!(result.target_rate_per_s + result.product_rate_per_s, 0.);
        assert_eq!(
            result.binding_w,
            result.captures_per_s * P.binding_joules_per_capture
        );
        assert_eq!(P.rates(0., 3e17).unwrap().binding_w, 0.);
        assert_eq!(P.rates(2e25, 0.).unwrap().captures_per_s, 0.);
        assert_eq!(
            P.rates(1e25, 3e17).unwrap().binding_w,
            result.binding_w / 2.
        );
    }

    #[test]
    fn complete_derivative_matches_joint_target_and_exposure_perturbation() {
        let (target, exposure, dt, dp) = (2e25, 3e17, -7e24, 2e17);
        let tangent = P.tangent(target, exposure, dt, dp).unwrap();
        let eps = 1e-5;
        let hi = P.rates(target + eps * dt, exposure + eps * dp).unwrap();
        let lo = P.rates(target - eps * dt, exposure - eps * dp).unwrap();
        let difference = (hi.binding_w - lo.binding_w) / (2. * eps);
        assert!((difference / tangent.binding_w - 1.).abs() < 1e-10);
        assert_eq!(tangent.target_rate_per_s + tangent.product_rate_per_s, 0.);
    }

    #[test]
    fn signed_trials_do_not_weaken_physical_admission_or_overflow_checks() {
        assert!(P.rates(-2e25, 3e17).unwrap().captures_per_s < 0.);
        assert!(validate_accepted(-1., 0., 0.).is_err());
        assert!(P.rates(f64::MAX, f64::MAX).is_err());
        assert!(P.tangent(1., 1., f64::NAN, 0.).is_err());
        assert!(
            Parameters {
                cross_section_m2: -1.,
                ..P
            }
            .rates(1., 1.)
            .is_err()
        );
    }
}
