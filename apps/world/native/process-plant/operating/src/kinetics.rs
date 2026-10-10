//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#extensive-regional-kinetics
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/kinetics.md#selected-compact-source-and-material-ownership
//! Regional neutron-equivalent populations with ONE material-owned precursor bank.
//!
//! State: [N_region..., C_material,group...], six groups per material carrier.
//! At each region/material support, achieved fissions F_ai = G_ai * N_i
//! create B_ai,g = nu_delayed_a,g * F_ai. The SAME birth is withheld from the
//! regional prompt equation and added to its material precursor stock:
//!   N'_i = rho_i/Lambda_i*N_i - sum_a,g B_ai,g + S_i + transfers
//!          + sum_a,g W_ia*lambda_a,g*C_a,g
//!   C'_a,g = sum_i B_ai,g - lambda_a,g*C_a,g.
//!
//! G is production, NOT geometric overlap. W is current emission projection;
//! its explicit outside-domain share retains a paid export. Movement changes
//! G/W, never C. Identity mapping with nu_delayed_g*G=beta_g/Lambda recovers
//! conventional kinetics. Other projected operators need their OWN
//! critical/period/shape admission; conservation does not establish fidelity.
//!
//! N/C share one extensive equivalent-neutron normalization. C is neither
//! decay heat nor a resolved isotope assay. Lambda/rho/G must share the net
//! generation convention. There are no default coefficients, shapes, feedback
//! laws, equilibrium resets, solver or integration. Lambda, nu_delayed and
//! lambda are fixed within a compiled coefficient configuration; required
//! state dependence needs explicit input ports and derivatives.
//!
//! Finite signed Newton trials/directions are evaluated without clipping.
//! Admit accepted physical states AND inputs separately. Errors invalidate
//! caller output buffers. Stage evaluation performs no allocation.

use std::collections::BTreeSet;
use std::fmt;

pub const DELAYED_GROUPS: usize = 6;

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReactivityDomain {
    pub minimum: f64,
    pub maximum: f64,
}

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegionParameters {
    pub generation_time_s: f64,
    pub reactivity_domain: ReactivityDomain,
}

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialParameters {
    /// Equivalent delayed-neutron births per achieved fission, NOT beta alone.
    pub delayed_yields_per_fission: [f64; DELAYED_GROUPS],
    pub decay_constants_per_s: [f64; DELAYED_GROUPS],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Transfer {
    pub donor: usize,
    pub receiver: usize,
}

/// Reachable support; currently zero overlap retains its identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Support {
    pub region: usize,
    pub material: usize,
}

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegionInput {
    pub reactivity: f64,
    pub external_source_per_s: f64,
}

/// Current constitutive values, or signed directions with the same dimensions.
#[derive(Clone, Copy, Debug)]
pub struct Inputs<'a> {
    pub regions: &'a [RegionInput],
    pub transfer_rates_per_s: &'a [f64],
    /// G_ai per Support, fissions/(equivalent population * s).
    pub fissions_per_population_s: &'a [f64],
    /// W_ia per Support. Geometry may justify uniform emission, not G_ai.
    pub emission_fractions: &'a [f64],
    /// Explicit outside-domain emission fraction per material carrier.
    pub outside_fractions: &'a [f64],
}

#[derive(Clone, Copy, Debug)]
pub struct Balance {
    pub delayed_export_per_s: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    EmptyModel,
    DimensionOverflow,
    InvalidParameter {
        owner: usize,
        name: &'static str,
    },
    InvalidTopology {
        name: &'static str,
        index: usize,
    },
    Length {
        field: &'static str,
        expected: usize,
        actual: usize,
    },
    InvalidValue {
        field: &'static str,
        index: usize,
    },
    ReactivityOutsideDomain {
        region: usize,
    },
    EmissionNotPartitioned {
        material: usize,
        sum: f64,
    },
    NegativeAcceptedInventory {
        index: usize,
    },
    NonfiniteResult,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "material/regional kinetics: {self:?}")
    }
}
impl std::error::Error for Error {}

#[derive(Debug)]
pub struct Model {
    regions: Vec<RegionParameters>,
    materials: Vec<MaterialParameters>,
    transfers: Vec<Transfer>,
    supports: Vec<Support>,
    material_supports: Vec<Vec<usize>>,
    dimension: usize,
    structural_nonzeros: usize,
}

impl Model {
    pub fn new(
        regions: Vec<RegionParameters>,
        materials: Vec<MaterialParameters>,
        transfers: Vec<Transfer>,
        supports: Vec<Support>,
    ) -> Result<Self, Error> {
        if regions.is_empty() || materials.is_empty() {
            return Err(Error::EmptyModel);
        }
        let dimension = materials
            .len()
            .checked_mul(DELAYED_GROUPS)
            .and_then(|n| n.checked_add(regions.len()))
            .ok_or(Error::DimensionOverflow)?;
        for (owner, p) in regions.iter().enumerate() {
            if !p.generation_time_s.is_finite()
                || p.generation_time_s <= 0.
                || !p.generation_time_s.recip().is_finite()
            {
                return Err(Error::InvalidParameter {
                    owner,
                    name: "generation_time_s",
                });
            }
            let d = p.reactivity_domain;
            if !d.minimum.is_finite() || !d.maximum.is_finite() || d.minimum > d.maximum {
                return Err(Error::InvalidParameter {
                    owner,
                    name: "reactivity_domain",
                });
            }
        }
        for (owner, p) in materials.iter().enumerate() {
            if p.delayed_yields_per_fission
                .iter()
                .any(|x| !x.is_finite() || *x < 0.)
                || !p.delayed_yields_per_fission.iter().sum::<f64>().is_finite()
            {
                return Err(Error::InvalidParameter {
                    owner,
                    name: "delayed_yields_per_fission",
                });
            }
            if p.decay_constants_per_s
                .iter()
                .any(|x| !x.is_finite() || *x <= 0.)
            {
                return Err(Error::InvalidParameter {
                    owner,
                    name: "decay_constants_per_s",
                });
            }
        }
        let mut seen = BTreeSet::new();
        for (index, e) in transfers.iter().enumerate() {
            if e.donor >= regions.len()
                || e.receiver >= regions.len()
                || e.donor == e.receiver
                || !seen.insert((e.donor, e.receiver))
            {
                return Err(Error::InvalidTopology {
                    name: "transfer",
                    index,
                });
            }
        }
        seen.clear();
        let mut material_supports = vec![Vec::new(); materials.len()];
        for (index, s) in supports.iter().enumerate() {
            if s.region >= regions.len()
                || s.material >= materials.len()
                || !seen.insert((s.region, s.material))
            {
                return Err(Error::InvalidTopology {
                    name: "material support",
                    index,
                });
            }
            material_supports[s.material].push(index);
        }
        let structural_nonzeros = supports
            .len()
            .checked_mul(2 * DELAYED_GROUPS)
            .and_then(|n| n.checked_add(dimension))
            .and_then(|n| n.checked_add(transfers.len()))
            .ok_or(Error::DimensionOverflow)?;
        Ok(Self {
            regions,
            materials,
            transfers,
            supports,
            material_supports,
            dimension,
            structural_nonzeros,
        })
    }

    pub fn region_count(&self) -> usize {
        self.regions.len()
    }
    pub fn material_count(&self) -> usize {
        self.materials.len()
    }
    pub fn state_dimension(&self) -> usize {
        self.dimension
    }
    pub fn support_count(&self) -> usize {
        self.supports.len()
    }
    pub fn transfer_count(&self) -> usize {
        self.transfers.len()
    }
    /// Fixed-input block only: R+6A+E+12L, not the coupled plant census.
    pub fn structural_state_jacobian_nonzeros(&self) -> usize {
        self.structural_nonzeros
    }

    /// Visit additive fixed-input RHS Jacobian entries in O(R+6A+E+6L).
    /// Duplicate diagonal contributions MUST be summed, not overwritten.
    /// Zero entries retain the compiled support. This is not the complete
    /// plant Jacobian: current rho/G/W/k input dependencies add their chain
    /// rule contributions, and IDA assembles cj*dF/dy' + dF/dy separately.
    /// On error discard the assembly, including already visited entries.
    pub fn state_jacobian_entries(
        &self,
        inputs: Inputs<'_>,
        mut add: impl FnMut(usize, usize, f64),
    ) -> Result<(), Error> {
        self.validate_trial_inputs(inputs)?;
        let mut emit = |row, column, value: f64| {
            if !value.is_finite() {
                return Err(Error::NonfiniteResult);
            }
            add(row, column, value);
            Ok(())
        };
        for (i, (p, input)) in self.regions.iter().zip(inputs.regions).enumerate() {
            emit(i, i, input.reactivity / p.generation_time_s)?;
        }
        for (a, material) in self.materials.iter().enumerate() {
            for g in 0..DELAYED_GROUPS {
                let row = self.regions.len() + a * DELAYED_GROUPS + g;
                emit(row, row, -material.decay_constants_per_s[g])?;
            }
        }
        for (index, s) in self.supports.iter().enumerate() {
            let material = &self.materials[s.material];
            for g in 0..DELAYED_GROUPS {
                let row = self.regions.len() + s.material * DELAYED_GROUPS + g;
                let production = material.delayed_yields_per_fission[g]
                    * inputs.fissions_per_population_s[index];
                emit(s.region, s.region, -production)?;
                emit(row, s.region, production)?;
                emit(
                    s.region,
                    row,
                    inputs.emission_fractions[index] * material.decay_constants_per_s[g],
                )?;
            }
        }
        for (edge, &rate) in self.transfers.iter().zip(inputs.transfer_rates_per_s) {
            emit(edge.donor, edge.donor, -rate)?;
            emit(edge.receiver, edge.donor, rate)?;
        }
        Ok(())
    }

    pub fn validate_accepted_state(&self, state: &[f64]) -> Result<(), Error> {
        finite("state", state, self.dimension)?;
        for (index, &value) in state.iter().enumerate() {
            if value < 0. {
                return Err(Error::NegativeAcceptedInventory { index });
            }
        }
        Ok(())
    }

    pub fn validate_accepted_inputs(&self, inputs: Inputs<'_>) -> Result<(), Error> {
        self.validate_trial_inputs(inputs)?;
        for (region, (p, value)) in self.regions.iter().zip(inputs.regions).enumerate() {
            if value.external_source_per_s < 0. {
                return Err(Error::InvalidValue {
                    field: "accepted source",
                    index: region,
                });
            }
            if value.reactivity < p.reactivity_domain.minimum
                || value.reactivity > p.reactivity_domain.maximum
            {
                return Err(Error::ReactivityOutsideDomain { region });
            }
        }
        for (field, values) in [
            ("accepted transfer", inputs.transfer_rates_per_s),
            (
                "accepted fission coefficient",
                inputs.fissions_per_population_s,
            ),
            ("accepted emission fraction", inputs.emission_fractions),
            ("accepted outside fraction", inputs.outside_fractions),
        ] {
            for (index, &v) in values.iter().enumerate() {
                if v < 0. {
                    return Err(Error::InvalidValue { field, index });
                }
            }
        }
        for (material, edges) in self.material_supports.iter().enumerate() {
            let sum = edges
                .iter()
                .fold(inputs.outside_fractions[material], |sum, &edge| {
                    sum + inputs.emission_fractions[edge]
                });
            // Arithmetic accumulation allowance, not a physical leakage floor.
            let roundoff = 16. * f64::EPSILON * (edges.len() + 1) as f64;
            if !sum.is_finite() || (sum - 1.).abs() > roundoff {
                return Err(Error::EmissionNotPartitioned { material, sum });
            }
        }
        Ok(())
    }

    /// The SAME achieved material fissions feed the heat and poison blocks.
    pub fn rates(
        &self,
        state: &[f64],
        inputs: Inputs<'_>,
        out: &mut [f64],
        material_fissions_per_s: &mut [f64],
    ) -> Result<Balance, Error> {
        finite("state", state, self.dimension)?;
        self.validate_trial_inputs(inputs)?;
        length("rates", out.len(), self.dimension)?;
        length(
            "material fissions",
            material_fissions_per_s.len(),
            self.materials.len(),
        )?;
        let balance = self.action(inputs, state, out, material_fissions_per_s);
        for (i, input) in inputs.regions.iter().enumerate() {
            out[i] += input.external_source_per_s;
        }
        self.validate_result(out, material_fissions_per_s, balance)
    }

    /// Exact state AND constitutive-input derivative, including changing G/W.
    /// Constrained projection directions need sum(dW)+dOutside=0 from their
    /// actual geometry/constitutive owner; arbitrary finite directions are valid.
    pub fn directional_derivative(
        &self,
        state: &[f64],
        inputs: Inputs<'_>,
        state_direction: &[f64],
        input_direction: Inputs<'_>,
        out: &mut [f64],
        material_fission_direction: &mut [f64],
    ) -> Result<Balance, Error> {
        finite("state", state, self.dimension)?;
        finite("state direction", state_direction, self.dimension)?;
        self.validate_trial_inputs(inputs)?;
        self.validate_trial_inputs(input_direction)?;
        length("tangent", out.len(), self.dimension)?;
        length(
            "material fission direction",
            material_fission_direction.len(),
            self.materials.len(),
        )?;
        let mut balance = self.action(inputs, state_direction, out, material_fission_direction);
        for (i, (p, d)) in self.regions.iter().zip(input_direction.regions).enumerate() {
            out[i] += d.reactivity / p.generation_time_s * state[i] + d.external_source_per_s;
        }
        for (edge, &rate) in self
            .transfers
            .iter()
            .zip(input_direction.transfer_rates_per_s)
        {
            let flow = rate * state[edge.donor];
            out[edge.donor] -= flow;
            out[edge.receiver] += flow;
        }
        for (index, s) in self.supports.iter().enumerate() {
            let fission = input_direction.fissions_per_population_s[index] * state[s.region];
            material_fission_direction[s.material] += fission;
            let material = &self.materials[s.material];
            for g in 0..DELAYED_GROUPS {
                let row = self.regions.len() + s.material * DELAYED_GROUPS + g;
                let birth = material.delayed_yields_per_fission[g] * fission;
                out[s.region] -= birth;
                out[row] += birth;
                out[s.region] += input_direction.emission_fractions[index]
                    * material.decay_constants_per_s[g]
                    * state[row];
            }
        }
        for (a, material) in self.materials.iter().enumerate() {
            for g in 0..DELAYED_GROUPS {
                balance.delayed_export_per_s += input_direction.outside_fractions[a]
                    * material.decay_constants_per_s[g]
                    * state[self.regions.len() + a * DELAYED_GROUPS + g];
            }
        }
        self.validate_result(out, material_fission_direction, balance)
    }

    fn action(
        &self,
        inputs: Inputs<'_>,
        values: &[f64],
        out: &mut [f64],
        fissions: &mut [f64],
    ) -> Balance {
        out.fill(0.);
        fissions.fill(0.);
        let mut exported = 0.;
        for (i, (p, input)) in self.regions.iter().zip(inputs.regions).enumerate() {
            out[i] = input.reactivity / p.generation_time_s * values[i];
        }
        for (a, material) in self.materials.iter().enumerate() {
            for g in 0..DELAYED_GROUPS {
                let row = self.regions.len() + a * DELAYED_GROUPS + g;
                let decay = material.decay_constants_per_s[g] * values[row];
                out[row] = -decay;
                exported += inputs.outside_fractions[a] * decay;
            }
        }
        for (index, s) in self.supports.iter().enumerate() {
            let fission = inputs.fissions_per_population_s[index] * values[s.region];
            fissions[s.material] += fission;
            let material = &self.materials[s.material];
            for g in 0..DELAYED_GROUPS {
                let row = self.regions.len() + s.material * DELAYED_GROUPS + g;
                let birth = material.delayed_yields_per_fission[g] * fission;
                out[s.region] -= birth;
                out[row] += birth;
                out[s.region] += inputs.emission_fractions[index]
                    * material.decay_constants_per_s[g]
                    * values[row];
            }
        }
        for (edge, &rate) in self.transfers.iter().zip(inputs.transfer_rates_per_s) {
            let flow = rate * values[edge.donor];
            out[edge.donor] -= flow;
            out[edge.receiver] += flow;
        }
        Balance {
            delayed_export_per_s: exported,
        }
    }

    fn validate_trial_inputs(&self, inputs: Inputs<'_>) -> Result<(), Error> {
        length("region inputs", inputs.regions.len(), self.regions.len())?;
        finite(
            "transfer rates",
            inputs.transfer_rates_per_s,
            self.transfers.len(),
        )?;
        finite(
            "fission coefficients",
            inputs.fissions_per_population_s,
            self.supports.len(),
        )?;
        finite(
            "emission fractions",
            inputs.emission_fractions,
            self.supports.len(),
        )?;
        finite(
            "outside fractions",
            inputs.outside_fractions,
            self.materials.len(),
        )?;
        for (index, p) in inputs.regions.iter().enumerate() {
            if !p.reactivity.is_finite() || !p.external_source_per_s.is_finite() {
                return Err(Error::InvalidValue {
                    field: "region input",
                    index,
                });
            }
        }
        Ok(())
    }

    fn validate_result(
        &self,
        out: &[f64],
        fissions: &[f64],
        balance: Balance,
    ) -> Result<Balance, Error> {
        if out.iter().chain(fissions).any(|x| !x.is_finite())
            || !balance.delayed_export_per_s.is_finite()
        {
            return Err(Error::NonfiniteResult);
        }
        Ok(balance)
    }
}

fn length(field: &'static str, actual: usize, expected: usize) -> Result<(), Error> {
    if actual != expected {
        Err(Error::Length {
            field,
            expected,
            actual,
        })
    } else {
        Ok(())
    }
}
fn finite(field: &'static str, values: &[f64], expected: usize) -> Result<(), Error> {
    length(field, values.len(), expected)?;
    for (index, &v) in values.iter().enumerate() {
        if !v.is_finite() {
            return Err(Error::InvalidValue { field, index });
        }
    }
    Ok(())
}
