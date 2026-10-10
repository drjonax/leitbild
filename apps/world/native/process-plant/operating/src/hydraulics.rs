//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hydraulics.md#actual-finite-geometry-and-force-placement
//! Actual hydraulic constitutive ports, NOT a completed low-Mach momentum chart.
//!
//! One implementation of reviewed signed RCP and passive pressure laws. The
//! compiler supplies geometry, force incidence and current retained material.
//! This module supplies constitutive force/work ports, not a momentum layout.
//! The selected decision0013 local-pressure network owns physical phase-path
//! impulses; the earlier two-main/five-split allocation is comparison evidence.
//! Neither pressure-cycle closure nor local tests qualify connected work.
//! Stage evaluation is allocation-free. Exact kinks have directional derivatives,
//! explicitly marked non-linearizable; they are not smooth Jacobian entries.

use std::ops::{Add, Div, Mul, Neg, Sub};

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WallLaw {
    None,
    Rod,
    SmoothPipe,
    CircularChurchill,
    AnnularChurchill,
}

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pump {
    pub a: f64,
    pub b: f64,
    pub resistance: f64,
    pub mixed_degradation_depth: f64,
}

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Section {
    pub length_m: f64,
    pub area_m2: f64,
    pub hydraulic_diameter_m: f64,
    pub elevation_change_m: f64,
    pub gravity_m_s2: f64,
    pub wall: WallLaw,
    pub form_loss: f64,
    pub grid_count: usize,
    pub grid_factor: f64,
    pub blockage_fraction: f64,
    pub pump: Option<Pump>,
}

#[derive(Clone, Copy, Debug, Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub massflow_kg_s: f64,
    pub density_kg_m3: f64,
    pub viscosity_pa_s: f64,
    pub pressure_drop_pa: f64,
    pub omega_rad_s: f64,
    pub gas_volume_fraction: f64,
}
impl Input {
    /// Physical accepted material input; signed Newton continuations of the
    /// degradation polynomial are evaluated separately without fraction clipping.
    pub fn validate_accepted(&self) -> Result<(), Error> {
        if ![
            self.massflow_kg_s,
            self.density_kg_m3,
            self.viscosity_pa_s,
            self.pressure_drop_pa,
            self.omega_rad_s,
            self.gas_volume_fraction,
        ]
        .iter()
        .all(|v| v.is_finite())
            || self.density_kg_m3 <= 0.
            || self.viscosity_pa_s <= 0.
            || !(0. ..=1.).contains(&self.gas_volume_fraction)
        {
            return Err(Error::InvalidInput);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Receipt {
    pub residual_drive_pa: f64,
    pub passive_loss_pa: f64,
    pub pump_euler_pa: f64,
    pub gravity_head_pa: f64,
    pub fluid_torque_nm: f64,
    pub shaft_power_w: f64,
    pub irreversible_power_w: f64,
    pub pressure_power_w: f64,
    pub gravity_power_w: f64,
    /// Uniform-throughflow snapshot ONLY, not the selected reduced state energy.
    pub uniform_kinetic_j: f64,
    pub wall_loss_pa: f64,
    pub grid_loss_pa: f64,
    pub form_loss_pa: f64,
    pub pump_loss_pa: f64,
    pub braking_power_w: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Evaluation {
    pub value: Receipt,
    pub direction: Receipt,
    /// False at a pump/grid/rod/transition kink for this direction.
    pub linearizable: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Error {
    InvalidGeometry,
    InvalidParameter,
    InvalidInput,
    NonfiniteResult,
    Length,
    InvalidIncidence,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "hydraulic constitutive port: {self:?}")
    }
}
impl std::error::Error for Error {}

// A local forward differential: no finite-difference properties, cache or heap.
#[derive(Clone, Copy, Debug)]
struct D {
    v: f64,
    d: f64,
}
impl D {
    fn c(v: f64) -> Self {
        Self { v, d: 0. }
    }
    fn new(v: f64, d: f64) -> Self {
        Self { v, d }
    }
    fn pow(self, n: f64) -> Self {
        Self {
            v: self.v.powf(n),
            d: n * self.v.powf(n - 1.) * self.d,
        }
    }
    fn ln(self) -> Self {
        Self {
            v: self.v.ln(),
            d: self.d / self.v,
        }
    }
    fn exp(self) -> Self {
        let v = self.v.exp();
        Self { v, d: v * self.d }
    }
    fn abs(self, linear: &mut bool) -> Self {
        if self.v == 0. {
            if self.d != 0. {
                *linear = false;
            }
            Self::new(0., self.d.abs())
        } else {
            Self::new(self.v.abs(), self.v.signum() * self.d)
        }
    }
}
impl Add for D {
    type Output = Self;
    fn add(self, b: Self) -> Self {
        Self::new(self.v + b.v, self.d + b.d)
    }
}
impl Sub for D {
    type Output = Self;
    fn sub(self, b: Self) -> Self {
        Self::new(self.v - b.v, self.d - b.d)
    }
}
impl Mul for D {
    type Output = Self;
    fn mul(self, b: Self) -> Self {
        Self::new(self.v * b.v, self.d * b.v + self.v * b.d)
    }
}
impl Div for D {
    type Output = Self;
    fn div(self, b: Self) -> Self {
        Self::new(self.v / b.v, (self.d - (self.v / b.v) * b.d) / b.v)
    }
}
impl Neg for D {
    type Output = Self;
    fn neg(self) -> Self {
        Self::new(-self.v, -self.d)
    }
}
fn maximum(a: D, b: D, linear: &mut bool) -> D {
    if a.v > b.v {
        a
    } else if b.v > a.v {
        b
    } else {
        if a.d != b.d {
            *linear = false;
        }
        D::new(a.v, a.d.max(b.d))
    }
}
fn log_add(a: D, b: D) -> D {
    if a.v == f64::NEG_INFINITY {
        return b;
    }
    if b.v == f64::NEG_INFINITY {
        return a;
    }
    let (hi, lo) = if a.v > b.v { (a, b) } else { (b, a) };
    hi + (D::c(1.) + (lo - hi).exp()).ln()
}

/// Churchill log expression: circular8/Re (Darcy64/Re), or the selected
/// narrow-annulus12/Re (Darcy96/Re). No roughness/flow floor.
fn churchill_log_darcy(re: D, laminar: f64) -> D {
    let lr = re.ln();
    let t = (lr - D::c(7_f64.ln())) * D::c(2.457 * 0.9);
    let la = if t.v == 0. {
        D::c(f64::NEG_INFINITY)
    } else {
        D::new(16. * t.v.abs().ln(), 16. * t.d / t.v)
    };
    let lb = (D::c(37530_f64.ln()) - lr) * D::c(16.);
    D::c(8_f64.ln())
        + log_add(
            (D::c(laminar.ln()) - lr) * D::c(12.),
            log_add(la, lb) * D::c(-1.5),
        ) / D::c(12.)
}

/// Smooth-wall Colebrook above4000, reviewed linear2300--4000 transition.
/// x=1/sqrt(f) uses a monotone scalar iteration; derivative is the implicit
/// equation derivative, never differentiation of an unfinished iteration.
fn pipe_darcy(re: D, linear: &mut bool) -> D {
    if (re.v == 2300. || re.v == 4000.) && re.d != 0. {
        *linear = false;
    }
    if re.v < 2300. || (re.v == 2300. && re.d <= 0.) {
        return D::c(64.) / re;
    }
    let mut x: f64 = 7.;
    for _ in 0..24 {
        let f = x + 2. * (2.51 * x / re.v).log10();
        let dx = f / (1. + 2. / (10_f64.ln() * x));
        x -= dx;
        if dx.abs() <= 4. * f64::EPSILON * x.abs() {
            break;
        }
    }
    let xd = (2. / (10_f64.ln() * re.v)) / (1. + 2. / (10_f64.ln() * x)) * re.d;
    let turbulent = D::new(x, xd).pow(-2.);
    if re.v > 4000. || (re.v == 4000. && re.d >= 0.) {
        return turbulent;
    }
    // Branch points have distinct one-sided derivatives and are explicit.
    let a = (re - D::c(2300.)) / D::c(1700.);
    (D::c(1.) - a) * D::c(64.) / re + a * turbulent
}

impl Section {
    pub fn validate(&self) -> Result<(), Error> {
        if ![self.length_m, self.area_m2, self.gravity_m_s2]
            .iter()
            .all(|x| x.is_finite() && *x > 0.)
            || !self.elevation_change_m.is_finite()
        {
            return Err(Error::InvalidGeometry);
        }
        if !self.hydraulic_diameter_m.is_finite()
            || self.hydraulic_diameter_m < 0.
            || (self.hydraulic_diameter_m == 0.
                && (!matches!(self.wall, WallLaw::None) || self.grid_count > 0))
        {
            return Err(Error::InvalidGeometry);
        }
        if ![self.form_loss, self.grid_factor, self.blockage_fraction]
            .iter()
            .all(|x| x.is_finite() && *x >= 0.)
            || self.blockage_fraction >= 1.
        {
            return Err(Error::InvalidParameter);
        }
        if let Some(p) = self.pump
            && (!p.a.is_finite()
                || p.a <= 0.
                || ![p.b, p.resistance, p.mixed_degradation_depth]
                    .iter()
                    .all(|x| x.is_finite() && *x >= 0.)
                || p.mixed_degradation_depth > 1.)
        {
            return Err(Error::InvalidParameter);
        }
        Ok(())
    }

    pub fn evaluate(&self, x: Input, d: Input) -> Result<Evaluation, Error> {
        self.validate()?;
        let values = |a: Input| {
            [
                a.massflow_kg_s,
                a.density_kg_m3,
                a.viscosity_pa_s,
                a.pressure_drop_pa,
                a.omega_rad_s,
                a.gas_volume_fraction,
            ]
        };
        if !values(x).into_iter().chain(values(d)).all(f64::is_finite)
            || x.density_kg_m3 <= 0.
            || x.viscosity_pa_s <= 0.
        {
            return Err(Error::InvalidInput);
        }
        let mut linear = true;
        let m = D::new(x.massflow_kg_s, d.massflow_kg_s);
        let rho = D::new(x.density_kg_m3, d.density_kg_m3);
        let mu = D::new(x.viscosity_pa_s, d.viscosity_pa_s);
        let omega = D::new(x.omega_rad_s, d.omega_rad_s);
        let pressure = D::new(x.pressure_drop_pa, d.pressure_drop_pa);
        let alpha = D::new(x.gas_volume_fraction, d.gas_volume_fraction);
        let area = D::c(self.area_m2);
        let dh = D::c(self.hydraulic_diameter_m);
        let q = m / rho;
        let mut scratch_linear = true;
        let absm = m.abs(&mut scratch_linear);
        let dynamic = m * absm / (D::c(2.) * rho * area * area);
        let re = absm * dh / (area * mu);
        let wall = if matches!(self.wall, WallLaw::None) {
            D::c(0.)
        } else if m.v == 0. {
            let factor = match self.wall {
                WallLaw::None => 0.,
                WallLaw::AnnularChurchill => 48.,
                _ => 32.,
            };
            // Analytic unique zero-flow derivative; no infinite Darcy lookup.
            D::c(factor * self.length_m) * mu * m / (rho * area * dh * dh)
        } else {
            match self.wall {
                WallLaw::None => D::c(0.),
                WallLaw::Rod => {
                    let f = maximum(
                        maximum(D::c(64.) / re, D::c(1.691) * re.pow(-0.43), &mut linear),
                        D::c(0.117) * re.pow(-0.14),
                        &mut linear,
                    );
                    f * dynamic * D::c(self.length_m) / dh
                }
                WallLaw::SmoothPipe => {
                    pipe_darcy(re, &mut linear) * dynamic * D::c(self.length_m) / dh
                }
                WallLaw::CircularChurchill | WallLaw::AnnularChurchill => {
                    let laminar = if matches!(self.wall, WallLaw::CircularChurchill) {
                        8.
                    } else {
                        12.
                    };
                    churchill_log_darcy(re, laminar).exp() * dynamic * D::c(self.length_m) / dh
                }
            }
        };
        let grids = if self.grid_count == 0 {
            D::c(0.)
        } else {
            let k = if re.v == 0. {
                D::c(20.)
            } else {
                -maximum(D::c(-20.), -D::c(196.) * re.pow(-0.333), &mut linear)
            };
            k * D::c(self.grid_count as f64 * self.grid_factor * self.blockage_fraction.powi(2))
                * dynamic
        };
        let form = D::c(self.form_loss) * dynamic;
        let passive = wall + grids + form;
        let (euler, pump_loss, torque, brake) = if let Some(p) = self.pump {
            let absq = q.abs(&mut linear);
            let g = D::c(1.) - D::c(4. * p.mixed_degradation_depth) * alpha * (D::c(1.) - alpha);
            let blade = D::c(p.a) * omega - D::c(p.b) * absq;
            let te = g * rho * q * blade;
            let euler = g * rho * omega * blade;
            let braking = if omega.v > 0. && (q.v < 0. || (q.v == 0. && q.d < 0.)) {
                maximum(D::c(0.), D::c(-2.) * te, &mut linear)
            } else {
                D::c(0.)
            };
            (
                euler,
                D::c(p.resistance) * rho * q * absq,
                te + braking,
                omega * braking,
            )
        } else {
            (D::c(0.), D::c(0.), D::c(0.), D::c(0.))
        };
        let loss = passive + pump_loss;
        let gravity = rho * D::c(self.gravity_m_s2 * self.elevation_change_m);
        let drive = pressure + euler - gravity - loss;
        let shaft = omega * torque;
        let irreversible = q * loss + brake;
        let pp = q * pressure;
        let gp = m * D::c(self.gravity_m_s2 * self.elevation_change_m);
        let kinetic = m * m * D::c(self.length_m) / (D::c(2.) * rho * area);
        let row = [
            drive,
            loss,
            euler,
            gravity,
            torque,
            shaft,
            irreversible,
            pp,
            gp,
            kinetic,
            wall,
            grids,
            form,
            pump_loss,
            brake,
        ];
        if !row.iter().all(|a| a.v.is_finite() && a.d.is_finite()) {
            return Err(Error::NonfiniteResult);
        }
        let receipt = |direction: bool| {
            let get = |i: usize| if direction { row[i].d } else { row[i].v };
            Receipt {
                residual_drive_pa: get(0),
                passive_loss_pa: get(1),
                pump_euler_pa: get(2),
                gravity_head_pa: get(3),
                fluid_torque_nm: get(4),
                shaft_power_w: get(5),
                irreversible_power_w: get(6),
                pressure_power_w: get(7),
                gravity_power_w: get(8),
                uniform_kinetic_j: get(9),
                wall_loss_pa: get(10),
                grid_loss_pa: get(11),
                form_loss_pa: get(12),
                pump_loss_pa: get(13),
                braking_power_w: get(14),
            }
        };
        Ok(Evaluation {
            value: receipt(false),
            direction: receipt(true),
            linearizable: linear,
        })
    }
}

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ForceIncidence {
    pub edge: usize,
    pub section: usize,
    pub weight: f64,
}
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GravityIncidence {
    pub edge: usize,
    pub region: usize,
    pub delta_z_m: f64,
}
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CycleIncidence {
    pub edge: usize,
    pub cycle: usize,
    pub weight: f64,
}

/// Pressure-Pa projection only. Does NOT assert a kinetic/thermal state chart.
/// Caller buffers are overwritten; failure invalidates them. Tree-force rows
/// not covered by a selected mechanical owner remain explicitly unsupported.
// Separate physical incidence/port buffers keep ownership visible at the join.
#[allow(clippy::too_many_arguments)]
pub fn project_forces(
    section: &[Receipt],
    pressure_drop: &[f64],
    density: &[f64],
    gravity: f64,
    forces: &[ForceIncidence],
    heads: &[GravityIncidence],
    cycles: &[CycleIncidence],
    edge_drive: &mut [f64],
    cycle_drive: &mut [f64],
) -> Result<(), Error> {
    if !density.iter().all(|v| v.is_finite() && *v > 0.) {
        return Err(Error::InvalidInput);
    }
    project_direction(
        section,
        pressure_drop,
        density,
        gravity,
        forces,
        heads,
        cycles,
        edge_drive,
        cycle_drive,
    )
}

/// Analytic linear contraction for directions in section receipts, physical
/// pressure drops and current densities. Signed directions are not accepted
/// material states; geometry/incidence/calibration are immutable in this chart.
#[allow(clippy::too_many_arguments)]
pub fn project_direction(
    section: &[Receipt],
    pressure_drop: &[f64],
    density: &[f64],
    gravity: f64,
    forces: &[ForceIncidence],
    heads: &[GravityIncidence],
    cycles: &[CycleIncidence],
    edge_drive: &mut [f64],
    cycle_drive: &mut [f64],
) -> Result<(), Error> {
    if pressure_drop.len() != edge_drive.len()
        || !gravity.is_finite()
        || gravity <= 0.
        || !pressure_drop.iter().all(|v| v.is_finite())
        || !density.iter().all(|v| v.is_finite())
    {
        return Err(Error::InvalidInput);
    }
    edge_drive.copy_from_slice(pressure_drop);
    cycle_drive.fill(0.);
    for t in forces {
        if t.edge >= edge_drive.len()
            || t.section >= section.len()
            || !t.weight.is_finite()
            || t.weight < 0.
        {
            return Err(Error::InvalidIncidence);
        }
        edge_drive[t.edge] +=
            t.weight * (section[t.section].pump_euler_pa - section[t.section].passive_loss_pa);
    }
    for t in heads {
        if t.edge >= edge_drive.len() || t.region >= density.len() || !t.delta_z_m.is_finite() {
            return Err(Error::InvalidIncidence);
        }
        edge_drive[t.edge] -= gravity * density[t.region] * t.delta_z_m;
    }
    for t in cycles {
        if t.edge >= edge_drive.len() || t.cycle >= cycle_drive.len() || !t.weight.is_finite() {
            return Err(Error::InvalidIncidence);
        }
        cycle_drive[t.cycle] += t.weight * edge_drive[t.edge];
    }
    if !edge_drive
        .iter()
        .chain(cycle_drive.iter())
        .all(|v| v.is_finite())
    {
        return Err(Error::NonfiniteResult);
    }
    Ok(())
}

/// Fixed geometric MAIN.A/B integrated-momentum metric, in m^-1. The compiler
/// sums (L/A) b b^T over once-owned channel supports. This is NOT the Hessian of
/// rho-dependent physical K: split/expansion acceleration is omitted under0012.
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MainInertance {
    pub aa: f64,
    pub ab: f64,
    pub bb: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct MainInput {
    pub momentum_pa_s: [f64; 2],
    pub momentum_rate_pa: [f64; 2],
    /// Current seven physical force rows from project_forces; no lagged forces.
    pub cycle_drive_pa: [f64; 7],
}

#[derive(Clone, Copy, Debug)]
pub struct MainEvaluation {
    pub current_kg_s: [f64; 2],
    pub current_direction_kg_s: [f64; 2],
    /// Xi_dot-Fmain followed by the five algebraic Fsplit rows, all in Pa.
    pub residual_pa: [f64; 7],
    pub residual_direction_pa: [f64; 7],
}

impl MainInertance {
    pub fn validate(&self) -> Result<(), Error> {
        let determinant = self.aa * self.bb - self.ab * self.ab;
        if ![self.aa, self.ab, self.bb, determinant]
            .iter()
            .all(|v| v.is_finite())
            || self.aa <= 0.
            || self.bb <= 0.
            || determinant <= 0.
        {
            return Err(Error::InvalidGeometry);
        }
        Ok(())
    }

    /// Signed initial/mapped currents, not a nominal-flow prescription.
    pub fn momentum(&self, current_kg_s: [f64; 2]) -> Result<[f64; 2], Error> {
        self.validate()?;
        if !current_kg_s.iter().all(|v| v.is_finite()) {
            return Err(Error::InvalidInput);
        }
        let result = [
            self.aa * current_kg_s[0] + self.ab * current_kg_s[1],
            self.ab * current_kg_s[0] + self.bb * current_kg_s[1],
        ];
        if !result.iter().all(|v| v.is_finite()) {
            return Err(Error::NonfiniteResult);
        }
        Ok(result)
    }

    /// Allocation-free chart/residual and exact analytic direction. Current
    /// split amplitudes are algebraic inputs upstream of force evaluation;
    /// this function does not solve or eliminate their five nonlinear rows.
    pub fn evaluate(&self, x: MainInput, d: MainInput) -> Result<MainEvaluation, Error> {
        self.validate()?;
        let finite = |a: MainInput| {
            a.momentum_pa_s
                .iter()
                .chain(a.momentum_rate_pa.iter())
                .chain(a.cycle_drive_pa.iter())
                .all(|v| v.is_finite())
        };
        if !finite(x) || !finite(d) {
            return Err(Error::InvalidInput);
        }
        let determinant = self.aa * self.bb - self.ab * self.ab;
        let currents = |a: [f64; 2]| {
            [
                (self.bb * a[0] - self.ab * a[1]) / determinant,
                (self.aa * a[1] - self.ab * a[0]) / determinant,
            ]
        };
        let residual = |a: MainInput| {
            let mut r = a.cycle_drive_pa;
            r[0] = a.momentum_rate_pa[0] - r[0];
            r[1] = a.momentum_rate_pa[1] - r[1];
            r
        };
        let result = MainEvaluation {
            current_kg_s: currents(x.momentum_pa_s),
            current_direction_kg_s: currents(d.momentum_pa_s),
            residual_pa: residual(x),
            residual_direction_pa: residual(d),
        };
        if !result
            .current_kg_s
            .iter()
            .chain(result.current_direction_kg_s.iter())
            .chain(result.residual_pa.iter())
            .chain(result.residual_direction_pa.iter())
            .all(|v| v.is_finite())
        {
            return Err(Error::NonfiniteResult);
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn section(wall: WallLaw) -> Section {
        Section {
            length_m: 2.,
            area_m2: 1.2,
            hydraulic_diameter_m: 0.012,
            elevation_change_m: 2.,
            gravity_m_s2: 9.80665,
            wall,
            form_loss: 1.5,
            grid_count: 4,
            grid_factor: 1.,
            blockage_fraction: 0.35,
            pump: None,
        }
    }
    fn input(m: f64) -> Input {
        Input {
            massflow_kg_s: m,
            density_kg_m3: 720.,
            viscosity_pa_s: 9e-5,
            pressure_drop_pa: 15000.,
            omega_rad_s: 157.,
            gas_volume_fraction: 0.,
        }
    }
    fn close(a: f64, b: f64, rtol: f64) {
        assert!(
            (a - b).abs() <= rtol * a.abs().max(b.abs()).max(1.),
            "{a} != {b}"
        );
    }
    fn fields(r: Receipt) -> [f64; 15] {
        [
            r.residual_drive_pa,
            r.passive_loss_pa,
            r.pump_euler_pa,
            r.gravity_head_pa,
            r.fluid_torque_nm,
            r.shaft_power_w,
            r.irreversible_power_w,
            r.pressure_power_w,
            r.gravity_power_w,
            r.uniform_kinetic_j,
            r.wall_loss_pa,
            r.grid_loss_pa,
            r.form_loss_pa,
            r.pump_loss_pa,
            r.braking_power_w,
        ]
    }
    #[test]
    fn two_geometric_momenta_and_five_current_split_rows() {
        let metric = MainInertance {
            aa: 4.,
            ab: 2.,
            bb: 5.,
        };
        let x = MainInput {
            momentum_pa_s: metric.momentum([8000., -2000.]).unwrap(),
            momentum_rate_pa: [100., -20.],
            cycle_drive_pa: [30., -5., 2., -3., 4., -5., 6.],
        };
        let d = MainInput {
            momentum_pa_s: metric.momentum([-3., 7.]).unwrap(),
            momentum_rate_pa: [2., 4.],
            cycle_drive_pa: [1., 2., 3., 4., 5., 6., 7.],
        };
        let a = metric.evaluate(x, d).unwrap();
        assert_eq!(a.current_kg_s, [8000., -2000.]);
        assert_eq!(a.current_direction_kg_s, [-3., 7.]);
        assert_eq!(a.residual_pa, [70., -15., 2., -3., 4., -5., 6.]);
        assert_eq!(a.residual_direction_pa, [1., 2., 3., 4., 5., 6., 7.]);
        let h = 0.001;
        let shift = |s: f64| MainInput {
            momentum_pa_s: std::array::from_fn(|i| x.momentum_pa_s[i] + s * d.momentum_pa_s[i]),
            momentum_rate_pa: std::array::from_fn(|i| {
                x.momentum_rate_pa[i] + s * d.momentum_rate_pa[i]
            }),
            cycle_drive_pa: std::array::from_fn(|i| x.cycle_drive_pa[i] + s * d.cycle_drive_pa[i]),
        };
        let p = metric.evaluate(shift(h), MainInput::default()).unwrap();
        let n = metric.evaluate(shift(-h), MainInput::default()).unwrap();
        for i in 0..2 {
            close(
                (p.current_kg_s[i] - n.current_kg_s[i]) / (2. * h),
                a.current_direction_kg_s[i],
                1e-9,
            );
        }
        for i in 0..7 {
            close(
                (p.residual_pa[i] - n.residual_pa[i]) / (2. * h),
                a.residual_direction_pa[i],
                1e-9,
            );
        }
        assert_eq!(
            metric
                .evaluate(MainInput::default(), MainInput::default())
                .unwrap()
                .current_kg_s,
            [0., 0.]
        );
        assert!(
            MainInertance {
                aa: 1.,
                ab: 1.,
                bb: 1.
            }
            .validate()
            .is_err()
        );
        assert!(
            MainInertance {
                aa: f64::INFINITY,
                ab: 0.,
                bb: 1.
            }
            .validate()
            .is_err()
        );
        assert!(metric.momentum([f64::NAN, 0.]).is_err());
        assert!(
            metric
                .evaluate(
                    MainInput {
                        cycle_drive_pa: [f64::NAN; 7],
                        ..x
                    },
                    d
                )
                .is_err()
        );
    }
    #[test]
    fn circular_churchill_has_circular_laminar_and_continuous_transition() {
        let mut section = section(WallLaw::CircularChurchill);
        section.grid_count = 0;
        section.form_loss = 0.;
        for re in [0., 100., 1200., 2300., 4000., 100000.] {
            let mut x = input(
                re * section.area_m2 * input(0.).viscosity_pa_s / section.hydraulic_diameter_m,
            );
            let d = Input {
                massflow_kg_s: 1.,
                ..Input::default()
            };
            let e = section.evaluate(x, d).unwrap();
            if re <= 100. {
                let slope = 32. * section.length_m * x.viscosity_pa_s
                    / (x.density_kg_m3 * section.area_m2 * section.hydraulic_diameter_m.powi(2));
                close(e.value.wall_loss_pa, slope * x.massflow_kg_s, 1e-12);
                close(e.direction.wall_loss_pa, slope, 1e-12);
            }
            assert!(e.linearizable);
            x.massflow_kg_s = -x.massflow_kg_s;
            let reverse = section.evaluate(x, d).unwrap();
            close(e.value.wall_loss_pa, -reverse.value.wall_loss_pa, 1e-12);
            close(
                e.direction.wall_loss_pa,
                reverse.direction.wall_loss_pa,
                1e-12,
            );
            if re > 100. {
                let step = x.massflow_kg_s.abs() * 1e-5;
                let plus = section
                    .evaluate(
                        Input {
                            massflow_kg_s: x.massflow_kg_s + step,
                            ..x
                        },
                        Input::default(),
                    )
                    .unwrap();
                let minus = section
                    .evaluate(
                        Input {
                            massflow_kg_s: x.massflow_kg_s - step,
                            ..x
                        },
                        Input::default(),
                    )
                    .unwrap();
                close(
                    reverse.direction.wall_loss_pa,
                    (plus.value.wall_loss_pa - minus.value.wall_loss_pa) / (2. * step),
                    1e-7,
                );
            }
        }
    }
    #[test]
    fn passive_signed_and_zero_limits() {
        for law in [
            WallLaw::None,
            WallLaw::Rod,
            WallLaw::SmoothPipe,
            WallLaw::CircularChurchill,
            WallLaw::AnnularChurchill,
        ] {
            let s = section(law);
            let p = s.evaluate(input(4000.), Input::default()).unwrap().value;
            let n = s.evaluate(input(-4000.), Input::default()).unwrap().value;
            close(p.passive_loss_pa, -n.passive_loss_pa, 1e-13);
            assert!(p.irreversible_power_w > 0. && n.irreversible_power_w > 0.);
            let z = s
                .evaluate(
                    input(0.),
                    Input {
                        massflow_kg_s: 1.,
                        ..Input::default()
                    },
                )
                .unwrap();
            assert_eq!(z.value.passive_loss_pa, 0.);
            assert!(z.direction.passive_loss_pa >= 0.);
            assert_eq!(z.value.irreversible_power_w, 0.);
            assert!(z.linearizable);
        }
    }
    #[test]
    fn complete_current_material_direction() {
        let d = Input {
            massflow_kg_s: 100.,
            density_kg_m3: 7.,
            viscosity_pa_s: 2e-6,
            pressure_drop_pa: 100.,
            omega_rad_s: 3.,
            gas_volume_fraction: 0.02,
        };
        for law in [
            WallLaw::None,
            WallLaw::Rod,
            WallLaw::SmoothPipe,
            WallLaw::CircularChurchill,
            WallLaw::AnnularChurchill,
        ] {
            let mut s = section(law);
            s.pump = Some(Pump {
                a: 0.048,
                b: 0.25,
                resistance: 4.,
                mixed_degradation_depth: 0.5,
            });
            for m in [-4000., 4000.] {
                let mut x = input(m);
                x.gas_volume_fraction = 0.1;
                let a = s.evaluate(x, d).unwrap();
                assert!(a.linearizable);
                let h = 1e-4;
                let plus = Input {
                    massflow_kg_s: x.massflow_kg_s + h * d.massflow_kg_s,
                    density_kg_m3: x.density_kg_m3 + h * d.density_kg_m3,
                    viscosity_pa_s: x.viscosity_pa_s + h * d.viscosity_pa_s,
                    pressure_drop_pa: x.pressure_drop_pa + h * d.pressure_drop_pa,
                    omega_rad_s: x.omega_rad_s + h * d.omega_rad_s,
                    gas_volume_fraction: x.gas_volume_fraction + h * d.gas_volume_fraction,
                };
                let minus = Input {
                    massflow_kg_s: x.massflow_kg_s - h * d.massflow_kg_s,
                    density_kg_m3: x.density_kg_m3 - h * d.density_kg_m3,
                    viscosity_pa_s: x.viscosity_pa_s - h * d.viscosity_pa_s,
                    pressure_drop_pa: x.pressure_drop_pa - h * d.pressure_drop_pa,
                    omega_rad_s: x.omega_rad_s - h * d.omega_rad_s,
                    gas_volume_fraction: x.gas_volume_fraction - h * d.gas_volume_fraction,
                };
                for ((p, n), expected) in fields(s.evaluate(plus, Input::default()).unwrap().value)
                    .into_iter()
                    .zip(fields(s.evaluate(minus, Input::default()).unwrap().value))
                    .zip(fields(a.direction))
                {
                    close((p - n) / (2. * h), expected, 2e-7);
                }
            }
        }
    }
    #[test]
    fn pump_quadrants_work_and_zero_cusp() {
        let mut s = section(WallLaw::None);
        s.form_loss = 0.;
        s.grid_count = 0;
        s.elevation_change_m = 0.;
        s.pump = Some(Pump {
            a: 0.048,
            b: 0.25,
            resistance: 4.,
            mixed_degradation_depth: 0.5,
        });
        for m in [-4000., 0., 4000.] {
            for omega in [-157., 0., 157.] {
                let mut x = input(m);
                x.omega_rad_s = omega;
                let r = s.evaluate(x, Input::default()).unwrap().value;
                let q = m / x.density_kg_m3;
                close(
                    r.shaft_power_w - q * (r.pump_euler_pa - r.passive_loss_pa),
                    r.irreversible_power_w,
                    1e-12,
                );
                assert!(r.irreversible_power_w >= 0.);
                if omega == 0. {
                    assert_eq!(r.shaft_power_w, 0.);
                }
                if m == 0. {
                    assert_eq!(r.fluid_torque_nm, 0.);
                }
            }
        }
        for dm in [-1., 1.] {
            let r = s
                .evaluate(
                    input(0.),
                    Input {
                        massflow_kg_s: dm,
                        ..Input::default()
                    },
                )
                .unwrap();
            assert!(!r.linearizable);
            assert!(r.direction.fluid_torque_nm > 0.);
        }
    }
    #[test]
    fn kinetic_mass_derivative_is_not_fixed_mass() {
        let s = section(WallLaw::None);
        let x = input(4000.);
        let d = Input {
            density_kg_m3: 3.,
            massflow_kg_s: 2.,
            ..Input::default()
        };
        let a = s.evaluate(x, d).unwrap();
        close(
            a.direction.uniform_kinetic_j,
            a.value.uniform_kinetic_j
                * (2. * d.massflow_kg_s / x.massflow_kg_s - d.density_kg_m3 / x.density_kg_m3),
            1e-13,
        );
    }
    #[test]
    fn projection_and_bad_inputs() {
        let r = Receipt {
            pump_euler_pa: 12.,
            passive_loss_pa: 2.,
            ..Receipt::default()
        };
        let mut edges = [0.; 2];
        let mut cycle = [0.];
        project_forces(
            &[r],
            &[3., -3.],
            &[700.],
            10.,
            &[
                ForceIncidence {
                    edge: 0,
                    section: 0,
                    weight: 0.5,
                },
                ForceIncidence {
                    edge: 1,
                    section: 0,
                    weight: 0.5,
                },
            ],
            &[
                GravityIncidence {
                    edge: 0,
                    region: 0,
                    delta_z_m: 2.,
                },
                GravityIncidence {
                    edge: 1,
                    region: 0,
                    delta_z_m: -2.,
                },
            ],
            &[
                CycleIncidence {
                    edge: 0,
                    cycle: 0,
                    weight: 1.,
                },
                CycleIncidence {
                    edge: 1,
                    cycle: 0,
                    weight: 1.,
                },
            ],
            &mut edges,
            &mut cycle,
        )
        .unwrap();
        close(cycle[0], 10., 1e-12);
        let s = section(WallLaw::Rod);
        let mut bad = input(0.);
        bad.density_kg_m3 = 0.;
        assert!(s.evaluate(bad, Input::default()).is_err());
        bad = input(0.);
        bad.massflow_kg_s = f64::NAN;
        assert!(s.evaluate(bad, Input::default()).is_err());
    }

    #[test]
    fn pipe_transition_directions_are_not_advertised_smooth() {
        let mut s = section(WallLaw::SmoothPipe);
        s.area_m2 = 1.;
        s.hydraulic_diameter_m = 1.;
        s.form_loss = 0.;
        s.grid_count = 0;
        s.elevation_change_m = 0.;
        for re in [2300., 4000.] {
            for dm in [-1., 1.] {
                let mut x = input(re);
                x.viscosity_pa_s = 1.;
                let d = Input {
                    massflow_kg_s: dm,
                    ..Input::default()
                };
                let a = s.evaluate(x, d).unwrap();
                assert!(!a.linearizable);
                let h = 0.001;
                x.massflow_kg_s += h * dm;
                let b = s.evaluate(x, Input::default()).unwrap();
                close(
                    (b.value.passive_loss_pa - a.value.passive_loss_pa) / h,
                    a.direction.passive_loss_pa,
                    2e-5,
                );
            }
        }
    }

    #[test]
    fn signed_fraction_trials_are_not_accepted_material() {
        let mut s = section(WallLaw::None);
        s.pump = Some(Pump {
            a: 0.048,
            b: 0.25,
            resistance: 4.,
            mixed_degradation_depth: 0.5,
        });
        let mut x = input(4000.);
        x.gas_volume_fraction = -0.01;
        assert!(s.evaluate(x, Input::default()).is_ok());
        assert!(x.validate_accepted().is_err());
        x.gas_volume_fraction = 0.;
        assert!(x.validate_accepted().is_ok());
    }
}
