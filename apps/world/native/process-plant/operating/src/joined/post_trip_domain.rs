//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/kinetics.md#post-trip-domain-extension
//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#d3-kinetics-domain-after-a-trip-blocks-the-s2-trip
//! D3 (a): the post-trip kinetics domain, checked on accepted states.
//!
//! The `ld01-post-trip-domain` block widens two source-feedback domains, the
//! density ratio to `densityRatioMax` and the pressure down to
//! `pressureMin_Pa`, only while a checked shutdown margin holds: the
//! source-free regional operator, with the water term at
//! `marginWaterTermFactor` times its selected sensitivity, is at least
//! `shutdownMarginMin_dk_k` subcritical. Otherwise the compiled domains apply,
//! and a domain exit is an unsupported result, never clipped.
//!
//! # The operator and the check
//!
//! The source-free regional operator is the kinetics block's fixed-input
//! Jacobian ([`kinetics::Model::state_jacobian_entries`]) at the accepted
//! state's current inputs (`rho`, `G`, transfers, `W`, outside shares), with
//! the external source removed. Each precursor row is `C' = sum B - lambda C`,
//! so at `s = 0` its stock is `C = sum B/lambda`, and eliminating every
//! precursor gives the static regional operator
//! `M = J_NN + J_NC diag(1/lambda) J_CN` (24 x 24): prompt and delayed births,
//! their return through `W`, transfers and the delayed export. Its
//! off-diagonal entries are nonnegative (a Metzler matrix), and the full
//! `(N, C)` operator grows if and only if `M` does.
//!
//! "At least `m` subcritical" means a uniform insertion of `m` (Δk/k, added to
//! every region's `rho`) leaves the operator not supercritical:
//! `alpha(M_m) <= 0` for `M_m` assembled with `rho + (factor - 1) w + m`,
//! where `w` is the water term `water_worth (rho_H2O/rho_ref - 1)` that the
//! feedback evaluated. For a Metzler `M_m` that holds exactly when `-M_m` is an
//! M-matrix, which Gaussian elimination without pivoting decides in a finite
//! number of operations: every pivot positive (the last may be zero, a margin
//! of exactly `m`). No eigenvalue iteration, no tolerance and no solver: the
//! verdict is the sign of the pivots.
//!
//! The predicate judges; it changes no state, coefficient or tolerance.
use super::nuclear::Nuclear;
use crate::{kinetics, source_feedback as sf, thermal::Scalar};
use std::fmt;

/// The `ld01-post-trip-domain` record, as the source compiler emits it (the
/// joined packet's top-level `post_trip_domain` section).
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct Extension {
    /// Largest admitted `rho_H2O/rho_ref` while the margin holds.
    pub density_ratio_maximum: f64,
    /// Lowest admitted pressure while the margin holds (Pa).
    pub pressure_minimum_pa: f64,
    /// Smallest shutdown margin of the source-free operator (Δk/k).
    pub shutdown_margin_minimum: f64,
    /// Factor on the water term in the margin check.
    pub margin_water_term_factor: f64,
    /// Half, nominal and double sensitivity of this declared extrapolation;
    /// it selects which outputs are credited, not the check.
    pub extrapolation_sensitivity: [f64; 3],
}

/// Which domains admitted an accepted state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub enum Domain {
    /// The compiled `reference-operating-source` domains.
    Original,
    /// The D3 (a) extension, while the checked margin holds.
    Extended,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    /// The record is not a widening of the compiled domains, or is malformed.
    Extension(&'static str),
    Length(&'static str),
    /// The operator is not the kinetics block's precursor structure, or not
    /// Metzler: the M-matrix test would not decide the margin.
    Operator(&'static str),
    Kinetics(kinetics::Error),
    Feedback(sf::Error),
    /// A source-domain exit at an accepted state: an unsupported result.
    Unsupported {
        domain: Domain,
        margin_holds: bool,
        exit: sf::Error,
    },
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "D3 (a) post-trip domain: {self:?}")
    }
}
impl std::error::Error for Error {}
impl From<kinetics::Error> for Error {
    fn from(e: kinetics::Error) -> Self {
        Self::Kinetics(e)
    }
}

impl Extension {
    /// A widening of `original` with a positive margin and a factor of at
    /// least one: the only form D3 (a) selects.
    pub fn validate(&self, original: &sf::Domains) -> Result<(), Error> {
        let finite = [
            self.density_ratio_maximum,
            self.pressure_minimum_pa,
            self.shutdown_margin_minimum,
            self.margin_water_term_factor,
        ]
        .iter()
        .chain(&self.extrapolation_sensitivity)
        .all(|v| v.is_finite());
        if !finite {
            return Err(Error::Extension("nonfinite"));
        }
        if self.density_ratio_maximum < original.density_ratio.maximum {
            return Err(Error::Extension("density ratio maximum narrows the domain"));
        }
        if !(self.pressure_minimum_pa > 0.
            && self.pressure_minimum_pa <= original.pressure_pa.minimum)
        {
            return Err(Error::Extension("pressure minimum narrows the domain"));
        }
        if !(self.shutdown_margin_minimum > 0. && self.shutdown_margin_minimum < 1.) {
            return Err(Error::Extension("shutdown margin outside (0, 1)"));
        }
        if self.margin_water_term_factor < 1. {
            return Err(Error::Extension("water term factor below one"));
        }
        let [low, nominal, high] = self.extrapolation_sensitivity;
        if !(low > 0. && low < nominal && nominal == 1. && nominal < high) {
            return Err(Error::Extension(
                "sensitivity is not half/nominal/double-like",
            ));
        }
        Ok(())
    }
    /// The compiled domains widened by this record.
    pub fn domains(&self, original: sf::Domains) -> sf::Domains {
        sf::Domains {
            density_ratio: sf::Bounds {
                minimum: original.density_ratio.minimum,
                maximum: self.density_ratio_maximum,
            },
            pressure_pa: sf::Bounds {
                minimum: self.pressure_minimum_pa,
                maximum: original.pressure_pa.maximum,
            },
            ..original
        }
    }
}

/// The margin check at one state.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Margin {
    /// The operator with the water term at the factor and the minimum margin
    /// inserted is not supercritical.
    pub holds: bool,
    /// Pivots of `-M_m` in elimination order, up to and including the first
    /// that decides a failure.
    pub pivots: Vec<f64>,
    /// Per region, the water term `water_worth (rho_H2O/rho_ref - 1)` as
    /// evaluated (before the factor).
    pub water_terms: Vec<f64>,
    /// `M`: the static source-free operator with the water term at the
    /// factor and no margin inserted, column-major regions x regions (1/s).
    pub operator: Vec<f64>,
    /// `d M_ii / d rho_i = 1/Lambda_i` of the same assembly (1/s per Δk/k):
    /// the margin `delta*` solves `alpha(M + delta* diag(gain)) = 0`.
    pub reactivity_gain: Vec<f64>,
}

/// The static source-free regional operator at `inputs` (external sources
/// ignored), column-major `R x R`.
fn static_operator(
    model: &kinetics::Model,
    inputs: kinetics::Inputs<'_>,
) -> Result<Vec<f64>, Error> {
    let r = model.region_count();
    let n = model.state_dimension();
    let mut nn = vec![0.; r * r];
    let mut decay = vec![0.; n - r];
    let mut births: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n - r];
    let mut returns: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n - r];
    let mut coupled = false;
    model.state_jacobian_entries(inputs, |row, column, value| match (row < r, column < r) {
        (true, true) => nn[column * r + row] += value,
        (false, true) => births[row - r].push((column, value)),
        (true, false) => returns[column - r].push((row, value)),
        (false, false) if row == column => decay[row - r] += value,
        (false, false) => coupled = true,
    })?;
    if coupled {
        return Err(Error::Operator("precursor rows couple to each other"));
    }
    for c in 0..n - r {
        let lambda = -decay[c];
        if !(lambda.is_finite() && lambda > 0.) {
            return Err(Error::Operator("precursor without a positive decay"));
        }
        for &(i, w) in &returns[c] {
            for &(j, b) in &births[c] {
                nn[j * r + i] += w * b / lambda;
            }
        }
    }
    if nn.iter().any(|v| !v.is_finite()) {
        return Err(Error::Operator("nonfinite operator"));
    }
    for j in 0..r {
        for i in 0..r {
            if i != j && nn[j * r + i] < 0. {
                return Err(Error::Operator("negative off-diagonal: not Metzler"));
            }
        }
    }
    Ok(nn)
}

/// Pivots of the Z-matrix `-m` (column-major `r x r`) by elimination without
/// pivoting, and whether it is an M-matrix: every pivot positive, the last
/// nonnegative. Stops at the first pivot that decides a failure.
fn m_matrix(r: usize, m: &[f64]) -> (bool, Vec<f64>) {
    let mut a: Vec<f64> = m.iter().map(|v| -v).collect();
    let mut pivots = Vec::with_capacity(r);
    for k in 0..r {
        let pivot = a[k * r + k];
        pivots.push(pivot);
        let last = k + 1 == r;
        if !(pivot > 0. || (last && pivot == 0.)) {
            return (false, pivots);
        }
        if last {
            break;
        }
        for j in k + 1..r {
            let akj = a[j * r + k];
            if akj == 0. {
                continue;
            }
            let factor = akj / pivot;
            for i in k + 1..r {
                a[j * r + i] -= a[k * r + i] * factor;
            }
        }
    }
    (true, pivots)
}

/// The D3 (a) margin check at the current kinetics `inputs` of one state:
/// `water_terms` are that state's per-region water terms.
pub fn shutdown_margin(
    model: &kinetics::Model,
    inputs: kinetics::Inputs<'_>,
    water_terms: &[f64],
    extension: &Extension,
) -> Result<Margin, Error> {
    let r = model.region_count();
    if inputs.regions.len() != r || water_terms.len() != r {
        return Err(Error::Length("regions"));
    }
    if water_terms.iter().any(|w| !w.is_finite()) {
        return Err(Error::Length("nonfinite water term"));
    }
    let with = |inserted: f64| -> Vec<kinetics::RegionInput> {
        inputs
            .regions
            .iter()
            .zip(water_terms)
            .map(|(x, w)| kinetics::RegionInput {
                reactivity: x.reactivity + (extension.margin_water_term_factor - 1.) * w + inserted,
                external_source_per_s: 0.,
            })
            .collect()
    };
    let m = extension.shutdown_margin_minimum;
    let (plain, inserted) = (with(0.), with(m));
    let operator = static_operator(
        model,
        kinetics::Inputs {
            regions: &plain,
            ..inputs
        },
    )?;
    let shifted = static_operator(
        model,
        kinetics::Inputs {
            regions: &inserted,
            ..inputs
        },
    )?;
    let reactivity_gain = (0..r)
        .map(|i| (shifted[i * r + i] - operator[i * r + i]) / m)
        .collect();
    let (holds, pivots) = m_matrix(r, &shifted);
    Ok(Margin {
        holds,
        pivots,
        water_terms: water_terms.to_vec(),
        operator,
        reactivity_gain,
    })
}

/// One accepted state's admission.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Admission {
    pub margin: Margin,
    pub domain: Domain,
}

/// The current transport and emission inputs of the kinetics block, which
/// the source feedback does not recompute.
#[derive(Clone, Copy, Debug)]
pub struct Fixed<'a> {
    pub transfer_rates_per_s: &'a [f64],
    pub emission_fractions: &'a [f64],
    pub outside_fractions: &'a [f64],
}

/// The margin check at one state from its source-feedback conditions: the
/// current `rho`, `G` and water terms the feedback evaluates there.
pub fn margin_at(
    feedback: &sf::Model,
    kinetics: &kinetics::Model,
    fixed: Fixed<'_>,
    neutrons: &[Scalar],
    conditions: sf::Conditions<'_>,
    extension: &Extension,
) -> Result<Margin, Error> {
    let r = feedback.region_count();
    let mut terms = vec![sf::ReactivityTerms::default(); r];
    feedback
        .reactivity_terms(conditions, &mut terms)
        .map_err(Error::Feedback)?;
    let mut out = sf::Output::new(r, feedback.material_count(), feedback.support_count());
    feedback
        .evaluate(neutrons, conditions, &mut out)
        .map_err(Error::Feedback)?;
    let regions: Vec<kinetics::RegionInput> = out
        .regions
        .iter()
        .map(|x| kinetics::RegionInput {
            reactivity: x.reactivity.value,
            external_source_per_s: x.external_source_per_s.value,
        })
        .collect();
    let production: Vec<f64> = out
        .fissions_per_population_s
        .iter()
        .map(|g| g.value)
        .collect();
    let water: Vec<f64> = terms.iter().map(|t| t.water_density).collect();
    shutdown_margin(
        kinetics,
        kinetics::Inputs {
            regions: &regions,
            transfer_rates_per_s: fixed.transfer_rates_per_s,
            fissions_per_population_s: &production,
            emission_fractions: fixed.emission_fractions,
            outside_fractions: fixed.outside_fractions,
        },
        &water,
        extension,
    )
}

/// D3 (a) at one accepted state from its source-feedback conditions: the
/// margin check, then the source domains it selects.
pub fn admit(
    feedback: &sf::Model,
    kinetics: &kinetics::Model,
    fixed: Fixed<'_>,
    neutrons: &[Scalar],
    conditions: sf::Conditions<'_>,
    additional_reference_exposure_s: f64,
    extension: &Extension,
) -> Result<Admission, Error> {
    let original = feedback.domains();
    extension.validate(&original)?;
    let margin = margin_at(feedback, kinetics, fixed, neutrons, conditions, extension)?;
    let mut out = sf::Output::new(
        feedback.region_count(),
        feedback.material_count(),
        feedback.support_count(),
    );
    let (domain, domains) = if margin.holds {
        (Domain::Extended, extension.domains(original))
    } else {
        (Domain::Original, original)
    };
    match feedback.validate_accepted_within(
        neutrons,
        conditions,
        additional_reference_exposure_s,
        &mut out,
        domains,
    ) {
        Ok(()) => Ok(Admission { margin, domain }),
        Err(exit @ sf::Error::OutsideDomain(..)) => Err(Error::Unsupported {
            domain,
            margin_holds: margin.holds,
            exit,
        }),
        Err(e) => Err(Error::Feedback(e)),
    }
}

/// The source-feedback conditions of one accepted state of the joined
/// operator, owned: the nuclear block's feedback inputs of its last
/// evaluation (call it after the joined evaluation AT that state), the rods'
/// achieved travel of the same evaluation and the capsule age `age0 + t`.
pub struct AcceptedConditions {
    pub neutrons: Vec<Scalar>,
    fuel: Vec<Scalar>,
    density: Vec<Scalar>,
    boron: Vec<Scalar>,
    pressure: Vec<Scalar>,
    moderator: Vec<Scalar>,
    fissile: Vec<Scalar>,
    xenon: Vec<Scalar>,
    samarium: Vec<Scalar>,
    opacity: Vec<Scalar>,
    travel: Vec<Scalar>,
    capsule_age_s: f64,
}
impl AcceptedConditions {
    pub fn of(nuclear: &Nuclear, travel: &[Scalar], t: f64) -> Self {
        let f = nuclear.feedback_inputs();
        let k = |v: &[f64]| v.iter().map(|x| Scalar::constant(*x)).collect::<Vec<_>>();
        Self {
            neutrons: k(&f.neutrons),
            fuel: k(&f.fuel_temperature_k),
            density: k(&f.water_density_kg_m3),
            boron: k(&f.boron_ppm_eq),
            pressure: k(&f.pressure_pa),
            moderator: k(&f.moderator_temperature_k),
            fissile: k(&f.fissile_atoms),
            xenon: k(&f.xenon_atoms),
            samarium: k(&f.samarium_atoms),
            opacity: k(&f.capture_loss_change_m2),
            travel: travel.iter().map(|x| Scalar::constant(x.value)).collect(),
            capsule_age_s: nuclear.coefficients().capsule_age0_s + t,
        }
    }
    pub fn conditions(&self) -> sf::Conditions<'_> {
        sf::Conditions {
            fuel_temperature_k: &self.fuel,
            water_density_kg_m3: &self.density,
            boron_ppm_eq: &self.boron,
            pressure_pa: &self.pressure,
            moderator_temperature_k: &self.moderator,
            fissile_atoms: &self.fissile,
            xenon_atoms: &self.xenon,
            samarium_atoms: &self.samarium,
            capture_loss_change_m2: &self.opacity,
            achieved_rod_travel_m: &self.travel,
            capsule_age_s: Scalar::constant(self.capsule_age_s),
        }
    }
}

/// The kinetics block's fixed transport and emission inputs.
pub fn fixed(nuclear: &Nuclear) -> Fixed<'_> {
    let c = nuclear.coefficients();
    Fixed {
        transfer_rates_per_s: c.transfer_rates_per_s,
        emission_fractions: c.emission_fractions,
        outside_fractions: c.outside_fractions,
    }
}

/// D3 (a) at one accepted state of the joined operator. Call it after the
/// joined evaluation AT that accepted state: it reads the nuclear block's
/// feedback inputs of the last evaluation. `travel` is the rods' achieved
/// travel of the same evaluation (`Joined::travel`), `t` the simulated time
/// since preparation (the capsule age is `age0 + t`, as in the rows).
pub fn admit_accepted(
    nuclear: &Nuclear,
    extension: &Extension,
    travel: &[Scalar],
    t: f64,
    additional_reference_exposure_s: f64,
) -> Result<Admission, Error> {
    let at = AcceptedConditions::of(nuclear, travel, t);
    admit(
        nuclear.feedback(),
        nuclear.kinetics(),
        fixed(nuclear),
        &at.neutrons,
        at.conditions(),
        additional_reference_exposure_s,
        extension,
    )
}
