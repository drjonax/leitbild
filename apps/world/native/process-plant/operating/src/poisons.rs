//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#poison-memory
//! I-135/Xe-135 and Pm-149/Sm-149 inventory kinetics.
//!
//! Direct production yields and actual local capture-rate coefficients are
//! explicit inputs, not cumulative daughter yields or fission-rate proxies.
//! Sm-149 is stable in this model. Decay to species outside these four and
//! captures leave this local tracked set; full material/energy accounting and
//! the feedback from absorption to regional reactivity have separate owners.
//! Reference fuel history and aggregation/movement are not supplied here.

use std::fmt;

pub const IODINE_135: usize = 0;
pub const XENON_135: usize = 1;
pub const PROMETHIUM_149: usize = 2;
pub const SAMARIUM_149: usize = 3;
pub const DIMENSION: usize = 4;
pub type Inventory = [f64; DIMENSION];

#[derive(Clone, Copy, Debug)]
pub struct Parameters {
    /// I-135, Xe-135, Pm-149. Sm-149 has no decay coefficient.
    pub decay_per_s: [f64; 3],
    pub direct_atoms_per_fission: [f64; DIMENSION],
}

#[derive(Clone, Copy, Debug)]
pub struct Input {
    pub fissions_per_s: f64,
    pub capture_per_s: [f64; DIMENSION],
}

/// Signed constitutive-input direction for a full coupled Jacobian action.
#[derive(Clone, Copy, Debug)]
pub struct InputDirection {
    pub fissions_per_s: f64,
    pub capture_per_s: [f64; DIMENSION],
}

#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    InvalidParameter(&'static str),
    InvalidValue(&'static str),
    NegativeAcceptedInventory { index: usize },
    NonfiniteResult,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "poison inventory: {self:?}")
    }
}

impl std::error::Error for Error {}

#[derive(Debug)]
pub struct Model {
    parameters: Parameters,
}

impl Model {
    pub fn new(parameters: Parameters) -> Result<Self, Error> {
        if parameters
            .decay_per_s
            .iter()
            .any(|x| !x.is_finite() || *x <= 0.)
        {
            return Err(Error::InvalidParameter("decay_per_s"));
        }
        if parameters
            .direct_atoms_per_fission
            .iter()
            .any(|x| !x.is_finite() || *x < 0.)
        {
            return Err(Error::InvalidParameter("direct_atoms_per_fission"));
        }
        Ok(Self { parameters })
    }

    pub fn validate_accepted_state(&self, inventory: &Inventory) -> Result<(), Error> {
        validate_finite(inventory)?;
        for (index, &value) in inventory.iter().enumerate() {
            if value < 0. {
                return Err(Error::NegativeAcceptedInventory { index });
            }
        }
        Ok(())
    }

    /// Physical admission is distinct from signed constitutive Newton trials.
    pub fn validate_accepted_input(&self, input: Input) -> Result<(), Error> {
        validate_input(input)?;
        if input.fissions_per_s < 0. || input.capture_per_s.iter().any(|x| *x < 0.) {
            return Err(Error::InvalidValue("negative accepted physical input"));
        }
        Ok(())
    }

    pub fn rates(
        &self,
        inventory: &Inventory,
        input: Input,
        out: &mut Inventory,
    ) -> Result<(), Error> {
        validate_finite(inventory)?;
        validate_input(input)?;
        let p = &self.parameters;
        let loss = [
            p.decay_per_s[0] + input.capture_per_s[0],
            p.decay_per_s[1] + input.capture_per_s[1],
            p.decay_per_s[2] + input.capture_per_s[2],
            input.capture_per_s[3],
        ];
        for i in 0..DIMENSION {
            out[i] = p.direct_atoms_per_fission[i] * input.fissions_per_s - loss[i] * inventory[i];
        }
        out[XENON_135] += p.decay_per_s[0] * inventory[IODINE_135];
        out[SAMARIUM_149] += p.decay_per_s[2] * inventory[PROMETHIUM_149];
        validate_result(out)
    }

    /// Includes the derivative of capture losses, not only a frozen-input partial.
    pub fn tangent(
        &self,
        inventory: &Inventory,
        input: Input,
        inventory_direction: &Inventory,
        input_direction: InputDirection,
        out: &mut Inventory,
    ) -> Result<(), Error> {
        validate_finite(inventory)?;
        validate_finite(inventory_direction)?;
        validate_input(input)?;
        if !input_direction.fissions_per_s.is_finite()
            || input_direction.capture_per_s.iter().any(|x| !x.is_finite())
        {
            return Err(Error::InvalidValue("input direction"));
        }
        let p = &self.parameters;
        let loss = [
            p.decay_per_s[0] + input.capture_per_s[0],
            p.decay_per_s[1] + input.capture_per_s[1],
            p.decay_per_s[2] + input.capture_per_s[2],
            input.capture_per_s[3],
        ];
        for i in 0..DIMENSION {
            out[i] = p.direct_atoms_per_fission[i] * input_direction.fissions_per_s
                - loss[i] * inventory_direction[i]
                - input_direction.capture_per_s[i] * inventory[i];
        }
        out[XENON_135] += p.decay_per_s[0] * inventory_direction[IODINE_135];
        out[SAMARIUM_149] += p.decay_per_s[2] * inventory_direction[PROMETHIUM_149];
        validate_result(out)
    }
}

fn validate_finite(values: &Inventory) -> Result<(), Error> {
    if values.iter().any(|x| !x.is_finite()) {
        return Err(Error::InvalidValue("inventory or direction"));
    }
    Ok(())
}

fn validate_input(input: Input) -> Result<(), Error> {
    if !input.fissions_per_s.is_finite() || input.capture_per_s.iter().any(|x| !x.is_finite()) {
        return Err(Error::InvalidValue("physical input"));
    }
    Ok(())
}

fn validate_result(values: &Inventory) -> Result<(), Error> {
    if values.iter().any(|x| !x.is_finite()) {
        return Err(Error::NonfiniteResult);
    }
    Ok(())
}
