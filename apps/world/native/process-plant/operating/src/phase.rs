//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hydraulics.md#local-pressure-and-phase-path-impulse
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#separate-liquid-and-steam-thermal-histories
//! Local pure-water pressure/phase constraints and reciprocal interphase work.
//!
//! Separated liquid/gas energy remains separated (the selected PZR carrier).
//! An SG's explicitly selected saturated equilibrium chart is a different
//! function, not a fallback for the PZR. Maintained property values/partials are
//! supplied at the SAME trial point. No EOS fit, inverse, integrator, seed phase,
//! common-temperature reset, or accepted-state clipping lives here.

use std::fmt;

use crate::thermal::Scalar;

#[derive(Clone, Copy, Debug, Default)]
pub struct Point {
    pub pressure_pa: f64,
    pub temperature_k: f64,
    pub density_kg_m3: f64,
    pub internal_energy_j_kg: f64,
    pub enthalpy_j_kg: f64,
    pub density_pressure: f64,
    pub density_temperature: f64,
    pub energy_pressure: f64,
    pub energy_temperature: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Stock {
    pub mass_kg: f64,
    pub internal_energy_j: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Error {
    InvalidInput(&'static str),
    InvalidAcceptedState(&'static str),
    SingularChart,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "operating phase: {self:?}")
    }
}
impl std::error::Error for Error {}

fn finite(values: &[f64]) -> Result<(), Error> {
    if values.iter().any(|v| !v.is_finite()) {
        Err(Error::InvalidInput("nonfinite"))
    } else {
        Ok(())
    }
}
fn point(p: Point) -> Result<(), Error> {
    finite(&[
        p.pressure_pa,
        p.temperature_k,
        p.density_kg_m3,
        p.internal_energy_j_kg,
        p.enthalpy_j_kg,
        p.density_pressure,
        p.density_temperature,
        p.energy_pressure,
        p.energy_temperature,
    ])?;
    if p.pressure_pa <= 0. || p.temperature_k <= 0. || p.density_kg_m3 <= 0. {
        return Err(Error::InvalidInput("positive physical property point"));
    }
    Ok(())
}
fn volume(v: f64) -> Result<(), Error> {
    if !v.is_finite() || v <= 0. {
        Err(Error::InvalidInput("volume"))
    } else {
        Ok(())
    }
}

/// Four local algebraic rows for [p,Tl,Tg,Vl]. Stocks are independently retained
/// Ml,Ul,Mg,Ug. Both phase properties must use the same mechanical pressure.
#[derive(Clone, Copy, Debug)]
pub struct Separated {
    pub residual: [f64; 4],
    /// Columns p,Tl,Tg,Vl; no frozen-property approximation.
    pub algebraic_jacobian: [[f64; 4]; 4],
    /// Columns Ml,Ul,Mg,Ug.
    pub stock_jacobian: [[f64; 4]; 4],
}

pub fn separated_constraints(
    v: f64,
    vl: f64,
    l: Stock,
    g: Stock,
    lp: Point,
    gp: Point,
) -> Result<Separated, Error> {
    volume(v)?;
    point(lp)?;
    point(gp)?;
    finite(&[
        vl,
        l.mass_kg,
        l.internal_energy_j,
        g.mass_kg,
        g.internal_energy_j,
    ])?;
    if lp.pressure_pa != gp.pressure_pa {
        return Err(Error::InvalidInput("different phase pressures"));
    }
    let rl = lp.density_kg_m3;
    let rg = gp.density_kg_m3;
    let rows = Separated {
        residual: [
            l.internal_energy_j - l.mass_kg * lp.internal_energy_j_kg,
            g.internal_energy_j - g.mass_kg * gp.internal_energy_j_kg,
            vl - l.mass_kg / rl,
            v - vl - g.mass_kg / rg,
        ],
        algebraic_jacobian: [
            [
                -l.mass_kg * lp.energy_pressure,
                -l.mass_kg * lp.energy_temperature,
                0.,
                0.,
            ],
            [
                -g.mass_kg * gp.energy_pressure,
                0.,
                -g.mass_kg * gp.energy_temperature,
                0.,
            ],
            [
                l.mass_kg * lp.density_pressure / (rl * rl),
                l.mass_kg * lp.density_temperature / (rl * rl),
                0.,
                1.,
            ],
            [
                g.mass_kg * gp.density_pressure / (rg * rg),
                0.,
                g.mass_kg * gp.density_temperature / (rg * rg),
                -1.,
            ],
        ],
        stock_jacobian: [
            [-lp.internal_energy_j_kg, 1., 0., 0.],
            [0., 0., -gp.internal_energy_j_kg, 1.],
            [-1. / rl, 0., 0., 0.],
            [0., 0., -1. / rg, 0.],
        ],
    };
    finite(&rows.residual)?;
    for row in rows
        .algebraic_jacobian
        .iter()
        .chain(rows.stock_jacobian.iter())
    {
        finite(row)?;
    }
    Ok(rows)
}

/// Pure branch has two constraints and NO absent-phase temperature/energy.
/// Density/energy map uses only its actual retained mass and internal energy.
pub fn single_constraints(v: f64, s: Stock, p: Point) -> Result<([f64; 2], [[f64; 2]; 2]), Error> {
    volume(v)?;
    point(p)?;
    finite(&[s.mass_kg, s.internal_energy_j])?;
    let r = p.density_kg_m3;
    let residual = [
        s.internal_energy_j - s.mass_kg * p.internal_energy_j_kg,
        v - s.mass_kg / r,
    ];
    let jacobian = [
        [
            -s.mass_kg * p.energy_pressure,
            -s.mass_kg * p.energy_temperature,
        ],
        [
            s.mass_kg * p.density_pressure / (r * r),
            s.mass_kg * p.density_temperature / (r * r),
        ],
    ];
    finite(&residual)?;
    for row in &jacobian {
        finite(row)?;
    }
    Ok((residual, jacobian))
}

#[derive(Clone, Copy, Debug)]
pub struct PhaseRates {
    pub pressure_rate_pa_s: f64,
    /// An absent phase has no temperature; an exact newborn's T is fixed by
    /// its responsible receipt row, not an independent finite-stock T rate.
    pub temperature_rate_k_s: [Option<f64>; 2],
    pub volume_rate_m3_s: [f64; 2],
    pub internal_energy_rate_w: [f64; 2],
}

/// Current phase properties and their complete caller-supplied direction.
/// `Some` means a present phase or an explicitly selected responsible birth
/// chart; it does not create an absent-phase temperature or seed stock.
#[derive(Clone, Copy, Debug)]
pub struct ScalarRatePhase {
    pub mass: Scalar,
    pub density: Scalar,
    pub specific_u: Scalar,
    pub rho_p: Scalar,
    pub rho_t: Scalar,
    pub u_p: Scalar,
    pub u_t: Scalar,
}

#[derive(Clone, Copy, Debug)]
pub struct ScalarPhaseRates {
    pub pressure_rate_pa_s: Scalar,
    pub volume_rate_m3_s: [Scalar; 2],
    pub internal_energy_rate_w: [Scalar; 2],
}

/// Locally eliminated rigid-volume M/U rates, with current directional values.
///
/// Cancel the phase mass analytically BEFORE evaluating the caloric/volume
/// elimination. This avoids a `1/M` coefficient or a finite-difference probe
/// across an exact-zero mass. Signed off-manifold Newton masses are evaluable;
/// no stock is modified or accepted here. Actual phase-volume work is paid
/// once, and cancels between phases of the rigid cell.
///
/// At an exact birth the caller owns the responsible receipt row `H'=h M'`.
/// On that row this gives `V'=M'/rho`. Away from it, the same mass-cancelled
/// formula is an explicit Newton residual extension, NOT an admitted physical
/// birth or an alternate heat/flash source. An absent `None` phase has neither
/// receipts nor a receipt direction; its appearance needs a selected chart.
pub fn current_rates(
    pressure: Scalar,
    phases: [Option<ScalarRatePhase>; 2],
    mass_rate: [Scalar; 2],
    enthalpy_rate: [Scalar; 2],
) -> Result<ScalarPhaseRates, Error> {
    phase_rates(pressure, phases, mass_rate, enthalpy_rate, None)
}

/// The same local elimination for a cell whose free volume moves: the phase
/// volume rates sum to the boundary's actual rate `volume_rate` (with its
/// direction) instead of zero. Each phase still pays `-p V_k'` once, so the
/// cell's fluid receives the boundary work `-p V'` exactly once.
pub fn current_rates_with_boundary(
    pressure: Scalar,
    phases: [Option<ScalarRatePhase>; 2],
    mass_rate: [Scalar; 2],
    enthalpy_rate: [Scalar; 2],
    volume_rate: Scalar,
) -> Result<ScalarPhaseRates, Error> {
    phase_rates(
        pressure,
        phases,
        mass_rate,
        enthalpy_rate,
        Some(volume_rate),
    )
}

fn phase_rates(
    pressure: Scalar,
    phases: [Option<ScalarRatePhase>; 2],
    mass_rate: [Scalar; 2],
    enthalpy_rate: [Scalar; 2],
    boundary: Option<Scalar>,
) -> Result<ScalarPhaseRates, Error> {
    let check = |values: &[Scalar]| -> Result<(), Error> {
        for x in values {
            finite(&[x.value, x.direction])?;
        }
        Ok(())
    };
    check(&[pressure])?;
    check(&mass_rate)?;
    check(&enthalpy_rate)?;
    if let Some(rate) = boundary {
        check(&[rate])?;
    }
    if pressure.value <= 0. {
        return Err(Error::InvalidInput("positive physical property pressure"));
    }
    let zero = Scalar::constant(0.);
    let mut expansion = [zero; 2];
    let mut compliance = [zero; 2];
    for i in 0..2 {
        let Some(s) = phases[i] else {
            if [mass_rate[i], enthalpy_rate[i]]
                .iter()
                .any(|x| x.value != 0. || x.direction != 0.)
            {
                return Err(Error::InvalidInput("absent phase requires birth chart"));
            }
            continue;
        };
        check(&[
            s.mass,
            s.density,
            s.specific_u,
            s.rho_p,
            s.rho_t,
            s.u_p,
            s.u_t,
        ])?;
        if s.density.value <= 0. {
            return Err(Error::InvalidInput("positive physical property density"));
        }
        let density_squared = s.density * s.density;
        let a = -s.rho_p / density_squared;
        let b = -s.rho_t / density_squared;
        let ap = s.u_p + pressure * a;
        let at = s.u_t + pressure * b;
        check(&[a, b, ap, at])?;
        if at.value == 0. {
            return Err(Error::SingularChart);
        }
        let h = s.specific_u + pressure / s.density;
        expansion[i] = mass_rate[i] / s.density + b / at * (enthalpy_rate[i] - h * mass_rate[i]);
        compliance[i] = s.mass * (a - b * ap / at);
    }
    check(&expansion)?;
    check(&compliance)?;
    let total_compliance = compliance[0] + compliance[1];
    if total_compliance.value == 0. {
        return Err(Error::SingularChart);
    }
    let pressure_rate = match boundary {
        None => -(expansion[0] + expansion[1]) / total_compliance,
        Some(rate) => (rate - (expansion[0] + expansion[1])) / total_compliance,
    };
    let volume_rate = std::array::from_fn(|i| expansion[i] + compliance[i] * pressure_rate);
    let energy_rate = std::array::from_fn(|i| enthalpy_rate[i] - pressure * volume_rate[i]);
    check(&[pressure_rate])?;
    check(&volume_rate)?;
    check(&energy_rate)?;
    Ok(ScalarPhaseRates {
        pressure_rate_pa_s: pressure_rate,
        volume_rate_m3_s: volume_rate,
        internal_energy_rate_w: energy_rate,
    })
}

/// Differentiate a rigid cell's caloric and volume constraints locally.
///
/// `enthalpy_rate` contains actual advected enthalpy and heat receipts, BEFORE
/// phase-volume work. The returned energy rates pay `-p V_i'` once. This small
/// local elimination avoids differentiating algebraic p/T solver variables in
/// the differential M/U equations. It does not advance or alter any stock.
///
/// Present stocks must be nonzero, but signed Newton trial masses are not
/// clipped or confused with accepted-state admission. An exact-zero newborn
/// phase needs its responsible one-sided receipt/enthalpy chart instead;
/// neither a seed mass nor an absent-phase temperature is supplied here.
pub fn present_rates(
    v: f64,
    stocks: [Option<Stock>; 2],
    points: [Option<Point>; 2],
    mass_rate: [f64; 2],
    enthalpy_rate: [f64; 2],
) -> Result<PhaseRates, Error> {
    local_rates(v, stocks, points, mass_rate, enthalpy_rate, false)
}

/// The same local rate closure with explicitly selected exact-zero births.
///
/// `Some(Stock { mass_kg: 0., internal_energy_j: 0. })` and a property point
/// identify a newborn, NOT an arbitrary absent-phase seed. The caller must
/// obtain this point from an actual positive receipt (or its responsible
/// one-sided onset), enforce `h(p,T) = H'/M'` as the active caloric row, and
/// admit its stable branch. This function supplies no inverse, default T,
/// flash partition, phase layout change, or independent newborn T rate.
///
/// At zero mass, `V' = M'/rho` and `U' = H' - p V'`. This expansion participates
/// in the existing finite phase's pressure closure. Once mass is nonzero,
/// the ordinary present-phase caloric constraint and rate apply again.
/// Finite off-manifold U trials are evaluable: U does not enter these rate
/// coefficients. The accepted birth transaction still requires exactly zero
/// retained U; this constitutive evaluator does not reset or admit a stock.
pub fn rates_with_birth(
    v: f64,
    stocks: [Option<Stock>; 2],
    points: [Option<Point>; 2],
    mass_rate: [f64; 2],
    enthalpy_rate: [f64; 2],
) -> Result<PhaseRates, Error> {
    local_rates(v, stocks, points, mass_rate, enthalpy_rate, true)
}

fn local_rates(
    v: f64,
    stocks: [Option<Stock>; 2],
    points: [Option<Point>; 2],
    mass_rate: [f64; 2],
    enthalpy_rate: [f64; 2],
    allow_birth: bool,
) -> Result<PhaseRates, Error> {
    volume(v)?;
    finite(&mass_rate)?;
    finite(&enthalpy_rate)?;
    let mut pressure = None;
    // Per phase: V_p, V_T, caloric p/T coefficients, and caloric receipt.
    let mut coefficients = [[0.; 5]; 2];
    let mut expansion = 0.;
    let mut compliance = 0.;
    for i in 0..2 {
        let (s, p) = match (stocks[i], points[i]) {
            (Some(s), Some(p)) => (s, p),
            (None, None) => {
                if mass_rate[i] != 0. || enthalpy_rate[i] != 0. {
                    return Err(Error::InvalidInput("absent phase requires birth chart"));
                }
                continue;
            }
            _ => return Err(Error::InvalidInput("phase stock/property mismatch")),
        };
        point(p)?;
        finite(&[s.mass_kg, s.internal_energy_j])?;
        if pressure.is_some_and(|previous| previous != p.pressure_pa) {
            return Err(Error::InvalidInput("different phase pressures"));
        }
        pressure = Some(p.pressure_pa);
        if s.mass_kg == 0. {
            if !allow_birth {
                return Err(Error::InvalidInput("zero phase mass requires birth chart"));
            }
            if mass_rate[i] < 0. || (mass_rate[i] == 0. && enthalpy_rate[i] != 0.) {
                return Err(Error::InvalidInput("invalid exact-zero birth receipt"));
            }
            expansion += mass_rate[i] / p.density_kg_m3;
            continue;
        }
        let density_squared = p.density_kg_m3 * p.density_kg_m3;
        let vp = -s.mass_kg * p.density_pressure / density_squared;
        let vt = -s.mass_kg * p.density_temperature / density_squared;
        let ap = s.mass_kg * p.energy_pressure + p.pressure_pa * vp;
        let at = s.mass_kg * p.energy_temperature + p.pressure_pa * vt;
        // Use the identity from the retained caloric constraint itself; the
        // independently supplied property h is used by transport, not as an
        // alternate caloric convention in this differentiated row.
        let h = p.internal_energy_j_kg + p.pressure_pa / p.density_kg_m3;
        let receipt = enthalpy_rate[i] - h * mass_rate[i];
        finite(&[vp, vt, ap, at, receipt])?;
        if at == 0. {
            return Err(Error::SingularChart);
        }
        expansion += mass_rate[i] / p.density_kg_m3 + vt * receipt / at;
        compliance += vp - vt * ap / at;
        coefficients[i] = [vp, vt, ap, at, receipt];
    }
    let pressure = pressure.ok_or(Error::InvalidInput("no present phase"))?;
    finite(&[expansion, compliance])?;
    if compliance == 0. {
        return Err(Error::SingularChart);
    }
    let pd = -expansion / compliance;
    let mut out = PhaseRates {
        pressure_rate_pa_s: pd,
        temperature_rate_k_s: [None; 2],
        volume_rate_m3_s: [0.; 2],
        internal_energy_rate_w: [0.; 2],
    };
    for i in 0..2 {
        if let Some(p) = points[i] {
            if stocks[i].is_some_and(|s| s.mass_kg == 0.) {
                let vd = mass_rate[i] / p.density_kg_m3;
                let ud = enthalpy_rate[i] - pressure * vd;
                finite(&[pd, vd, ud])?;
                out.volume_rate_m3_s[i] = vd;
                out.internal_energy_rate_w[i] = ud;
                continue;
            }
            let [vp, vt, ap, at, receipt] = coefficients[i];
            let td = (receipt - ap * pd) / at;
            let vd = mass_rate[i] / p.density_kg_m3 + vp * pd + vt * td;
            let ud = enthalpy_rate[i] - pressure * vd;
            finite(&[pd, td, vd, ud])?;
            out.temperature_rate_k_s[i] = Some(td);
            out.volume_rate_m3_s[i] = vd;
            out.internal_energy_rate_w[i] = ud;
        }
    }
    Ok(out)
}

pub fn validate_separated_accepted(v: f64, vl: f64, l: Stock, g: Stock) -> Result<(), Error> {
    volume(v)?;
    finite(&[
        vl,
        l.mass_kg,
        l.internal_energy_j,
        g.mass_kg,
        g.internal_energy_j,
    ])?;
    if vl <= 0. || vl >= v || l.mass_kg <= 0. || g.mass_kg <= 0. {
        return Err(Error::InvalidAcceptedState(
            "two present finite phases required",
        ));
    }
    // Internal energy has the maintained EOS datum, not a generic positivity
    // rule. Property/coherence admission is performed on the actual chart.
    Ok(())
}

pub fn validate_single_accepted(present: Stock, absent: Stock) -> Result<(), Error> {
    finite(&[
        present.mass_kg,
        present.internal_energy_j,
        absent.mass_kg,
        absent.internal_energy_j,
    ])?;
    if present.mass_kg <= 0. || absent.mass_kg != 0. || absent.internal_energy_j != 0. {
        return Err(Error::InvalidAcceptedState("absent phase has no stock"));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Exchange {
    pub liquid_mass_kg_s: f64,
    pub vapor_mass_kg_s: f64,
    pub liquid_energy_w: f64,
    pub vapor_energy_w: f64,
}

/// Actual two-sided Stefan receipt at a same-pressure interface. ql/qg are
/// signed heat FROM their bulk phase TO the interface. hli/hgi are maintained
/// saturation endpoint enthalpies at this pressure. No latent heat is paid a
/// second time. Phase-volume work belongs in addition to this source vector.
pub fn interphase(ql: f64, qg: f64, hli: f64, hgi: f64) -> Result<Exchange, Error> {
    finite(&[ql, qg, hli, hgi])?;
    let latent = hgi - hli;
    if latent <= 0. {
        return Err(Error::InvalidInput("positive latent enthalpy"));
    }
    let gamma = (ql + qg) / latent;
    let out = Exchange {
        liquid_mass_kg_s: -gamma,
        vapor_mass_kg_s: gamma,
        liquid_energy_w: -gamma * hli - ql,
        vapor_energy_w: gamma * hgi - qg,
    };
    finite(&[
        out.liquid_mass_kg_s,
        out.vapor_mass_kg_s,
        out.liquid_energy_w,
        out.vapor_energy_w,
    ])?;
    Ok(out)
}

pub fn interphase_direction(
    ql: f64,
    qg: f64,
    hli: f64,
    hgi: f64,
    direction: [f64; 4],
) -> Result<Exchange, Error> {
    let value = interphase(ql, qg, hli, hgi)?;
    finite(&direction)?;
    let [dql, dqg, dhli, dhgi] = direction;
    let gamma = value.vapor_mass_kg_s;
    let dgamma = (dql + dqg - gamma * (dhgi - dhli)) / (hgi - hli);
    let out = Exchange {
        liquid_mass_kg_s: -dgamma,
        vapor_mass_kg_s: dgamma,
        liquid_energy_w: -dgamma * hli - gamma * dhli - dql,
        vapor_energy_w: dgamma * hgi + gamma * dhgi - dqg,
    };
    finite(&[
        out.liquid_mass_kg_s,
        out.vapor_mass_kg_s,
        out.liquid_energy_w,
        out.vapor_energy_w,
    ])?;
    Ok(out)
}

/// Local internal-energy pressure work for a FIXED total-volume cell.
/// Equal/opposite phase work cancels, but each local energy equation needs it.
pub fn phase_volume_work(
    pressure_pa: f64,
    liquid_volume_rate_m3_s: f64,
) -> Result<[f64; 2], Error> {
    finite(&[pressure_pa, liquid_volume_rate_m3_s])?;
    if pressure_pa <= 0. {
        return Err(Error::InvalidInput("pressure work pressure"));
    }
    let work = pressure_pa * liquid_volume_rate_m3_s;
    finite(&[work])?;
    Ok([-work, work])
}

#[derive(Clone, Copy, Debug)]
pub struct Equilibrium {
    pub mass_kg: f64,
    pub internal_energy_j: f64,
    /// Derivatives [dM/dp,dM/dVl,dU/dp,dU/dVl] along saturation.
    pub derivative: [f64; 4],
}

/// Selected SG pure-water saturated chart, INCLUDING Vl=0 and Vl=V. At either
/// endpoint it supplies a conservative birth/exhaustion tangent. It is not a
/// nonequilibrium PZR closure, does not integrate and does not seed a phase.
pub fn equilibrium_chart(
    v: f64,
    vl: f64,
    lp: Point,
    gp: Point,
    saturation_slope: f64,
) -> Result<Equilibrium, Error> {
    volume(v)?;
    point(lp)?;
    point(gp)?;
    finite(&[vl, saturation_slope])?;
    if vl < 0.
        || vl > v
        || lp.pressure_pa != gp.pressure_pa
        || lp.temperature_k != gp.temperature_k
        || saturation_slope <= 0.
    {
        return Err(Error::InvalidInput("saturation chart"));
    }
    let vg = v - vl;
    let drl = lp.density_pressure + lp.density_temperature * saturation_slope;
    let drg = gp.density_pressure + gp.density_temperature * saturation_slope;
    let dul = lp.energy_pressure + lp.energy_temperature * saturation_slope;
    let dug = gp.energy_pressure + gp.energy_temperature * saturation_slope;
    let out = Equilibrium {
        mass_kg: vl * lp.density_kg_m3 + vg * gp.density_kg_m3,
        internal_energy_j: vl * lp.density_kg_m3 * lp.internal_energy_j_kg
            + vg * gp.density_kg_m3 * gp.internal_energy_j_kg,
        derivative: [
            vl * drl + vg * drg,
            lp.density_kg_m3 - gp.density_kg_m3,
            vl * (drl * lp.internal_energy_j_kg + lp.density_kg_m3 * dul)
                + vg * (drg * gp.internal_energy_j_kg + gp.density_kg_m3 * dug),
            lp.density_kg_m3 * lp.internal_energy_j_kg - gp.density_kg_m3 * gp.internal_energy_j_kg,
        ],
    };
    finite(&[out.mass_kg, out.internal_energy_j])?;
    finite(&out.derivative)?;
    Ok(out)
}

impl Equilibrium {
    /// Coordinate rates [p',Vl'] from actual signed M'/U', not a prescribed
    /// boiling curve. A direction pointing outside [0,V] switches to its actual
    /// pure-phase chart at the root; caller must not continue or clip it.
    pub fn rates(self, mass_rate_kg_s: f64, energy_rate_w: f64) -> Result<[f64; 2], Error> {
        finite(&[mass_rate_kg_s, energy_rate_w])?;
        let [mp, mv, ep, ev] = self.derivative;
        let determinant = mp * ev - mv * ep;
        if !determinant.is_finite() || determinant == 0. {
            return Err(Error::SingularChart);
        }
        let out = [
            (ev * mass_rate_kg_s - mv * energy_rate_w) / determinant,
            (mp * energy_rate_w - ep * mass_rate_kg_s) / determinant,
        ];
        finite(&out)?;
        Ok(out)
    }
}
