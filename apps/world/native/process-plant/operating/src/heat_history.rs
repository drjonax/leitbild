//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#decay-heat-is-stored-energy-not-delayed-neutron-population
//! Event-fed decay energy stores, separate from prompt deposition.
//!
//! For each group: E' = q * event_rate - lambda * E. The current release is
//! lambda * E, not a percentage of current reactor power. One instance has one
//! physical event feed. Fission and fertile capture therefore use SEPARATE
//! instances and their actual respective rates; do not feed capture stores with
//! a fission-rate proxy. Capture binding energy has its own deposition owner.
//!
//! The caller supplies coefficients and the recoverable event-energy budget.
//! No coefficients, precursor history, spatial mapping or successful initial
//! condition are invented here. The existing LD-01 23+2 history selection can
//! use these equations without replacing it with a smaller arbitrary fit.

use std::fmt;

#[derive(Clone, Copy, Debug)]
pub struct Group {
    pub decay_per_s: f64,
    pub retained_joules_per_event: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    InvalidParameter(&'static str),
    Length { expected: usize, actual: usize },
    InvalidValue(&'static str),
    NegativeAcceptedInventory { index: usize },
    NonfiniteResult,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "decay energy history: {self:?}")
    }
}

impl std::error::Error for Error {}

#[derive(Debug)]
pub struct Model {
    groups: Vec<Group>,
    prompt_joules_per_event: f64,
    retained_joules_per_event: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Heat {
    pub prompt_w: f64,
    pub delayed_w: f64,
    pub retained_input_w: f64,
}

impl Model {
    /// Compile one event feed with one non-overlapping energy budget.
    pub fn new(recoverable_joules_per_event: f64, groups: Vec<Group>) -> Result<Self, Error> {
        if !recoverable_joules_per_event.is_finite() || recoverable_joules_per_event < 0. {
            return Err(Error::InvalidParameter("recoverable_joules_per_event"));
        }
        let mut retained = 0.;
        for group in &groups {
            if !group.decay_per_s.is_finite() || group.decay_per_s <= 0. {
                return Err(Error::InvalidParameter("decay_per_s"));
            }
            if !group.retained_joules_per_event.is_finite() || group.retained_joules_per_event < 0.
            {
                return Err(Error::InvalidParameter("retained_joules_per_event"));
            }
            retained += group.retained_joules_per_event;
        }
        if !retained.is_finite() || retained > recoverable_joules_per_event {
            return Err(Error::InvalidParameter(
                "retained energy exceeds event budget",
            ));
        }
        Ok(Self {
            groups,
            prompt_joules_per_event: recoverable_joules_per_event - retained,
            retained_joules_per_event: retained,
        })
    }

    pub fn dimension(&self) -> usize {
        self.groups.len()
    }

    /// Solver trials may be signed; accepted physical stores may not.
    pub fn validate_accepted_state(&self, energy_j: &[f64]) -> Result<(), Error> {
        self.validate_trial(energy_j)?;
        for (index, &energy) in energy_j.iter().enumerate() {
            if energy < 0. {
                return Err(Error::NegativeAcceptedInventory { index });
            }
        }
        Ok(())
    }

    /// Reject unphysical feeds at accepted states, not signed Newton trials.
    pub fn validate_accepted_input(&self, events_per_s: f64) -> Result<(), Error> {
        validate_event_rate(events_per_s)?;
        if events_per_s < 0. {
            return Err(Error::InvalidValue("negative accepted event rate"));
        }
        Ok(())
    }

    /// Caller-owned output; no stage allocation, clipping or hidden integration.
    /// A finite signed event rate is a trial continuation, not physical admission.
    pub fn rates(
        &self,
        energy_j: &[f64],
        events_per_s: f64,
        out: &mut [f64],
    ) -> Result<Heat, Error> {
        self.validate_trial(energy_j)?;
        self.validate_length(out.len())?;
        validate_event_rate(events_per_s)?;
        let mut delayed_w = 0.;
        for ((group, &energy), rate) in self.groups.iter().zip(energy_j).zip(out.iter_mut()) {
            let release = group.decay_per_s * energy;
            *rate = group.retained_joules_per_event * events_per_s - release;
            delayed_w += release;
            if !rate.is_finite() || !delayed_w.is_finite() {
                return Err(Error::NonfiniteResult);
            }
        }
        let heat = Heat {
            prompt_w: self.prompt_joules_per_event * events_per_s,
            delayed_w,
            retained_input_w: self.retained_joules_per_event * events_per_s,
        };
        if !heat.prompt_w.is_finite() || !heat.retained_input_w.is_finite() {
            return Err(Error::NonfiniteResult);
        }
        Ok(heat)
    }

    /// Exact directional derivative in energy AND event-rate directions.
    /// The system owner supplies the event-rate derivative of its nuclear law.
    pub fn tangent(
        &self,
        energy_direction_j: &[f64],
        event_rate_direction_per_s: f64,
        out: &mut [f64],
    ) -> Result<Heat, Error> {
        // This entire operator is linear: its derivative is the same operator
        // applied to the directions. One implementation avoids equation drift.
        self.rates(energy_direction_j, event_rate_direction_per_s, out)
    }

    fn validate_trial(&self, values: &[f64]) -> Result<(), Error> {
        self.validate_length(values.len())?;
        if values.iter().any(|value| !value.is_finite()) {
            return Err(Error::InvalidValue("energy or direction"));
        }
        Ok(())
    }

    fn validate_length(&self, actual: usize) -> Result<(), Error> {
        if actual != self.dimension() {
            return Err(Error::Length {
                expected: self.dimension(),
                actual,
            });
        }
        Ok(())
    }
}

fn validate_event_rate(rate: f64) -> Result<(), Error> {
    if !rate.is_finite() {
        return Err(Error::InvalidValue("events_per_s"));
    }
    Ok(())
}
