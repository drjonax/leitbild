//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-thermal.md#two-node-fuel-finite-helium-and-clad
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#initialization-and-pressure-projection-have-limited-roles
//! Startup-only initialization of the three existing massless fuel surfaces.
//! All finite energies, nuclear histories and current water/flow coordinates
//! remain owned by the caller. This is NOT a stage inverse or time integrator.
use crate::thermal::{self, FuelGeometry, FuelTemperatures, Scalar};

#[derive(Clone, Copy, Debug)]
pub struct SurfacePolicy {
    pub maximum_residual_w: f64,
    pub maximum_correction_k: f64,
    pub maximum_iterations: usize,
    pub maximum_backtracks: usize,
}

#[derive(Clone, Copy, Debug)]
pub struct SurfaceInitialization {
    pub temperatures: FuelTemperatures,
    pub water_heat_w: f64,
    pub residual_w: [f64; 3],
    pub maximum_correction_k: f64,
    pub iterations: usize,
    pub wall_evaluations: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    InvalidPolicy,
    InvalidCoordinates,
    Constitutive(&'static str),
    SingularJacobian,
    NoConvergence {
        maximum_residual_w: f64,
        maximum_correction_k: f64,
        iterations: usize,
    },
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "fixed-stock surface initialization: {self:?}")
    }
}
impl std::error::Error for Error {}
impl From<&'static str> for Error {
    fn from(message: &'static str) -> Self {
        Self::Constitutive(message)
    }
}
fn constant(x: f64) -> Scalar {
    Scalar::constant(x)
}
fn coordinates(mut fixed: FuelTemperatures, x: [f64; 3]) -> FuelTemperatures {
    fixed.fuel_surface = constant(x[0]);
    fixed.clad_inner = constant(x[1]);
    fixed.clad_outer = constant(x[2]);
    fixed
}
fn norm(values: [f64; 3]) -> f64 {
    values.into_iter().map(f64::abs).fold(0., f64::max)
}
fn admitted(x: [f64; 3]) -> bool {
    x.iter().all(|v| v.is_finite())
        && (500. ..=2000.).contains(&x[0])
        && (290. ..=1800.).contains(&x[1])
        && (290. ..=1800.).contains(&x[2])
}

/// Fixed stock temperatures must already satisfy their actual caloric charts.
/// The wall closure consumes the CURRENT water state and actual flow; its
/// Scalar seed is ONLY the clad-outer temperature seed. All other closure
/// coordinate directions must be zero for this startup Jacobian.
///
/// Only algebraic surfaces are returned. No mutable stock/history argument is
/// accepted, so initialization cannot re-equilibrate or resize finite owners.
pub fn initialize_fuel_surfaces<F>(
    g: &FuelGeometry,
    fixed: FuelTemperatures,
    seed: [f64; 3],
    policy: SurfacePolicy,
    wall: F,
) -> Result<SurfaceInitialization, Error>
where
    F: Fn(Scalar) -> thermal::Result<Scalar>,
{
    if ![policy.maximum_residual_w, policy.maximum_correction_k]
        .iter()
        .all(|x| x.is_finite() && *x > 0.)
        || policy.maximum_iterations == 0
        || policy.maximum_backtracks == 0
    {
        return Err(Error::InvalidPolicy);
    }
    if !admitted(seed)
        || [
            fixed.inner_mean,
            fixed.outer_mean,
            fixed.clad_mean,
            fixed.helium,
        ]
        .iter()
        .any(|x| !x.value.is_finite() || x.direction != 0.)
    {
        return Err(Error::InvalidCoordinates);
    }
    let mut x = seed;
    let mut wall_evaluations = 0;
    let mut last_residual = f64::INFINITY;
    let mut last_correction = f64::INFINITY;
    for iteration in 0..=policy.maximum_iterations {
        let t = coordinates(fixed, x);
        wall_evaluations += 1;
        let water = wall(t.clad_outer)?;
        if !water.value.is_finite() || water.direction != 0. {
            return Err(Error::InvalidCoordinates);
        }
        let q = thermal::fuel_transfers(g, t, water)?;
        let residual = q.surface_residuals.map(|r| r.value);
        let mut jac = [[0.; 3]; 3];
        for column in [0usize, 1, 2] {
            let mut seeded = t;
            match column {
                0 => seeded.fuel_surface.direction = 1.,
                1 => seeded.clad_inner.direction = 1.,
                _ => seeded.clad_outer.direction = 1.,
            }
            let heat = if column == 2 {
                wall_evaluations += 1;
                wall(seeded.clad_outer)?
            } else {
                constant(water.value)
            };
            let derivative = thermal::fuel_transfers(g, seeded, heat)?.surface_residuals;
            for (row, derivative) in jac.iter_mut().zip(derivative) {
                row[column] = derivative.direction;
            }
        }
        // Exact current dependency: a coupled two-surface block and one
        // independent outer surface. This is not a general nonlinear solver.
        if jac[0][2] != 0. || jac[1][2] != 0. || jac[2][0] != 0. || jac[2][1] != 0. {
            return Err(Error::SingularJacobian);
        }
        let [a, b] = [jac[0][0], jac[0][1]];
        let [c, d] = [jac[1][0], jac[1][1]];
        let determinant = a * d - b * c;
        let e = jac[2][2];
        if !determinant.is_finite() || determinant == 0. || !e.is_finite() || e == 0. {
            return Err(Error::SingularJacobian);
        }
        let correction = [
            (b * residual[1] - d * residual[0]) / determinant,
            (c * residual[0] - a * residual[1]) / determinant,
            -residual[2] / e,
        ];
        last_residual = norm(residual);
        last_correction = norm(correction);
        if !last_residual.is_finite() || !last_correction.is_finite() {
            return Err(Error::SingularJacobian);
        }
        if last_residual <= policy.maximum_residual_w
            && last_correction <= policy.maximum_correction_k
        {
            return Ok(SurfaceInitialization {
                temperatures: t,
                water_heat_w: water.value,
                residual_w: residual,
                maximum_correction_k: last_correction,
                iterations: iteration,
                wall_evaluations,
            });
        }
        // Check the actual final applied update before reporting exhaustion.
        if iteration == policy.maximum_iterations {
            break;
        }
        let mut accepted = None;
        let mut damping = 1.;
        for _ in 0..policy.maximum_backtracks {
            let candidate = std::array::from_fn(|i| x[i] + damping * correction[i]);
            if admitted(candidate) && candidate != x {
                let trial = coordinates(fixed, candidate);
                wall_evaluations += 1;
                if let Ok(heat) = wall(trial.clad_outer)
                    && heat.direction == 0.
                    && let Ok(flux) = thermal::fuel_transfers(g, trial, heat)
                    && norm(flux.surface_residuals.map(|r| r.value)) < last_residual
                {
                    accepted = Some(candidate);
                    break;
                }
            }
            damping *= 0.5;
        }
        match accepted {
            Some(candidate) => x = candidate,
            None => {
                return Err(Error::NoConvergence {
                    maximum_residual_w: last_residual,
                    maximum_correction_k: last_correction,
                    iterations: iteration + 1,
                });
            }
        }
    }
    Err(Error::NoConvergence {
        maximum_residual_w: last_residual,
        maximum_correction_k: last_correction,
        iterations: policy.maximum_iterations,
    })
}
