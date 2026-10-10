//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#finite-surge-and-pzr-connection-equations
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressurizer-thermal-state.md#compact-common-pressure-hot-spine-allocation
//! Common-pressure pure-water PZR thermodynamics, not a completed vessel flow
//! solver. Actual ten-region geometry/ports are compiled separately. Present
//! phase energies remain separate; absent phases have no property query. The
//! first composed scope explicitly rejects air/nitrogen rather than replacing
//! them with water. Internal separate-phase cycle forces/rank remain open.

use crate::phase::Point;
pub type Result<T> = std::result::Result<T, &'static str>;

#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Active {
    Liquid,
    Vapor,
    TwoPhase,
}

#[derive(Clone, Copy, Debug)]
pub struct Chart {
    pub active: Active,
    pub pressure_pa: f64,
    pub vapor_fraction: f64,
    /// M,Ul,Ug,Vl. Physical species amounts are M*(1-x),M*x.
    pub stock: [f64; 4],
    /// Columns P,Tl,Tg,x; absent columns are zero, not cross-birth tangents.
    pub jacobian: [[f64; 4]; 4],
}

fn finite(a: &[f64]) -> Result<()> {
    if a.iter().all(|v| v.is_finite()) {
        Ok(())
    } else {
        Err("nonfinite PZR input/result")
    }
}
fn point(p: f64, q: Point) -> Result<()> {
    finite(&[
        q.pressure_pa,
        q.temperature_k,
        q.density_kg_m3,
        q.internal_energy_j_kg,
        q.enthalpy_j_kg,
        q.density_pressure,
        q.density_temperature,
        q.energy_pressure,
        q.energy_temperature,
    ])?;
    if q.pressure_pa != p || q.temperature_k <= 0. || q.density_kg_m3 <= 0. {
        return Err("PZR property point must use current common pressure");
    }
    Ok(())
}

/// Forward maintained-EOS chart. No stock inverse, fitted property, pressure
/// reset or equilibrium flash. Two-phase signed trials are evaluated if their
/// actual specific volume remains positive; physical admission is separate.
pub fn chart(
    v: f64,
    p: f64,
    x: f64,
    active: Active,
    liquid: Option<Point>,
    vapor: Option<Point>,
) -> Result<Chart> {
    finite(&[v, p, x])?;
    if v <= 0. || p <= 0. {
        return Err("positive PZR volume/pressure required");
    }
    let mut out = Chart {
        active,
        pressure_pa: p,
        vapor_fraction: x,
        stock: [0.; 4],
        jacobian: [[0.; 4]; 4],
    };
    match active {
        Active::Liquid | Active::Vapor => {
            let is_l = active == Active::Liquid;
            if x != if is_l { 0. } else { 1. }
                || if is_l {
                    vapor.is_some()
                } else {
                    liquid.is_some()
                }
            {
                return Err("absent PZR phase has no fraction/property coordinate");
            }
            let q =
                if is_l { liquid } else { vapor }.ok_or("missing present PZR phase property")?;
            point(p, q)?;
            let m = v * q.density_kg_m3;
            let energy = if is_l { 1 } else { 2 };
            let temperature = if is_l { 1 } else { 2 };
            out.stock[0] = m;
            out.stock[energy] = m * q.internal_energy_j_kg;
            out.stock[3] = if is_l { v } else { 0. };
            out.jacobian[0][0] = v * q.density_pressure;
            out.jacobian[0][temperature] = v * q.density_temperature;
            out.jacobian[energy][0] = v
                * (q.density_pressure * q.internal_energy_j_kg
                    + q.density_kg_m3 * q.energy_pressure);
            out.jacobian[energy][temperature] = v
                * (q.density_temperature * q.internal_energy_j_kg
                    + q.density_kg_m3 * q.energy_temperature);
        }
        Active::TwoPhase => {
            let l = liquid.ok_or("missing liquid PZR property")?;
            let g = vapor.ok_or("missing vapor PZR property")?;
            point(p, l)?;
            point(p, g)?;
            let rl = l.density_kg_m3;
            let rg = g.density_kg_m3;
            let y = 1. - x;
            let specific = y / rl + x / rg;
            if !specific.is_finite() || specific <= 0. {
                return Err("unavailable PZR trial specific volume");
            }
            let m = v / specific;
            let ds = [
                -y * l.density_pressure / (rl * rl) - x * g.density_pressure / (rg * rg),
                -y * l.density_temperature / (rl * rl),
                -x * g.density_temperature / (rg * rg),
                1. / rg - 1. / rl,
            ];
            out.stock = [
                m,
                m * y * l.internal_energy_j_kg,
                m * x * g.internal_energy_j_kg,
                m * y / rl,
            ];
            for (i, d) in ds.iter().enumerate() {
                let dm = -m / specific * d;
                let dx = if i == 3 { 1. } else { 0. };
                let dl = match i {
                    0 => l.energy_pressure,
                    1 => l.energy_temperature,
                    _ => 0.,
                };
                let dg = match i {
                    0 => g.energy_pressure,
                    2 => g.energy_temperature,
                    _ => 0.,
                };
                let dr = match i {
                    0 => l.density_pressure,
                    1 => l.density_temperature,
                    _ => 0.,
                };
                out.jacobian[0][i] = dm;
                out.jacobian[1][i] =
                    dm * y * l.internal_energy_j_kg + m * (y * dl - dx * l.internal_energy_j_kg);
                out.jacobian[2][i] =
                    dm * x * g.internal_energy_j_kg + m * (x * dg + dx * g.internal_energy_j_kg);
                out.jacobian[3][i] = dm * y / rl - m * dx / rl - m * y * dr / (rl * rl);
            }
        }
    }
    finite(&out.stock)?;
    for r in &out.jacobian {
        finite(r)?;
    }
    Ok(out)
}

#[derive(Clone, Copy, Debug)]
pub struct Reduced {
    /// Columns Pdot,Uldot,U gdot,xdot; current, NOT frozen cold coefficients.
    pub mass: [f64; 4],
    pub liquid_volume: [f64; 4],
}
impl Chart {
    pub fn validate_accepted(&self) -> Result<()> {
        finite(&self.stock)?;
        if self.stock[0] <= 0.
            || (self.active == Active::TwoPhase
                && !(0. < self.vapor_fraction && self.vapor_fraction < 1.))
        {
            return Err("inadmissible accepted PZR phase fraction/mass");
        }
        Ok(())
    }
    /// Eliminate only local temperature RATES. Global pressure and the nine
    /// tree continuity rows still compose simultaneously with enthalpy sources.
    pub fn reduced(&self) -> Result<Reduced> {
        let j = &self.jacobian;
        let reduce = |r: [f64; 4]| -> Result<[f64; 4]> {
            match self.active {
                Active::TwoPhase => {
                    let determinant = j[1][1] * j[2][2] - j[1][2] * j[2][1];
                    if !determinant.is_finite() || determinant == 0. {
                        return Err("singular two-phase PZR thermal chart");
                    }
                    let bl = (r[1] * j[2][2] - r[2] * j[2][1]) / determinant;
                    let bg = (r[2] * j[1][1] - r[1] * j[1][2]) / determinant;
                    Ok([
                        r[0] - bl * j[1][0] - bg * j[2][0],
                        bl,
                        bg,
                        r[3] - bl * j[1][3] - bg * j[2][3],
                    ])
                }
                Active::Liquid | Active::Vapor => {
                    let i = if self.active == Active::Liquid { 1 } else { 2 };
                    if j[i][i] == 0. || !j[i][i].is_finite() {
                        return Err("singular pure-phase PZR thermal chart");
                    }
                    let b = r[i] / j[i][i];
                    let mut a = [r[0] - b * j[i][0], 0., 0., 0.];
                    a[i] = b;
                    Ok(a)
                }
            }
        };
        let r = Reduced {
            mass: reduce(j[0])?,
            liquid_volume: reduce(j[3])?,
        };
        finite(&r.mass)?;
        finite(&r.liquid_volume)?;
        Ok(r)
    }
}

/// Positive sign is INTO the finite PZR region. These are thermal enthalpy plus
/// actual thermal/contact sources, NOT h+K+gz and NOT pressure/friction heaters.
#[derive(Clone, Copy, Debug, Default)]
pub struct Sources {
    pub liquid_mass_kg_s: f64,
    pub vapor_mass_kg_s: f64,
    pub liquid_energy_w: f64,
    pub vapor_energy_w: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct RateConstraints {
    pub mass_rate_kg_s: f64,
    pub liquid_volume_rate_m3_s: f64,
    /// Liquid/vapor mass and liquid/vapor U residuals.
    pub residual: [f64; 4],
}
pub fn rate_constraints(c: Chart, rates: [f64; 4], source: Sources) -> Result<RateConstraints> {
    finite(&rates)?;
    finite(&[
        source.liquid_mass_kg_s,
        source.vapor_mass_kg_s,
        source.liquid_energy_w,
        source.vapor_energy_w,
    ])?;
    if c.active != Active::TwoPhase
        && (rates[3] != 0. || rates[if c.active == Active::Liquid { 2 } else { 1 }] != 0.)
    {
        return Err("PZR phase appearance requires actual birth transaction");
    }
    let r = c.reduced()?;
    let dot = |a: [f64; 4]| a.into_iter().zip(rates).map(|(a, b)| a * b).sum::<f64>();
    let mdot = dot(r.mass);
    let vdot = dot(r.liquid_volume);
    let x = c.vapor_fraction;
    let transfer = c.stock[0] * rates[3];
    let out = RateConstraints {
        mass_rate_kg_s: mdot,
        liquid_volume_rate_m3_s: vdot,
        residual: [
            (1. - x) * mdot - transfer - source.liquid_mass_kg_s,
            x * mdot + transfer - source.vapor_mass_kg_s,
            rates[1] - source.liquid_energy_w + c.pressure_pa * vdot,
            rates[2] - source.vapor_energy_w - c.pressure_pa * vdot,
        ],
    };
    finite(&out.residual)?;
    Ok(out)
}

/// Same-pressure caloric admission of a responsible incoming/conversion receipt.
/// Caller supplies its maintained newborn property; cold incoming liquid or
/// wall condensate is NOT forced to saturation. Zero transfer skips the query.
#[derive(Clone, Copy, Debug, Default)]
pub struct Birth {
    pub mass_rate_kg_s: f64,
    pub volume_rate_m3_s: f64,
    pub internal_energy_rate_w: f64,
    pub caloric_residual_w: f64,
}
pub fn birth(
    p: f64,
    mass_rate: f64,
    thermal_enthalpy: f64,
    newborn: Option<Point>,
) -> Result<Birth> {
    finite(&[p, mass_rate, thermal_enthalpy])?;
    if p <= 0. || mass_rate < 0. {
        return Err("physical birth needs positive pressure/nonnegative actual arrival");
    }
    if mass_rate == 0. {
        return Ok(Birth::default());
    }
    let q = newborn.ok_or("nonzero PZR birth needs maintained caloric property")?;
    point(p, q)?;
    let dv = mass_rate / q.density_kg_m3;
    let du = mass_rate * thermal_enthalpy - p * dv;
    let out = Birth {
        mass_rate_kg_s: mass_rate,
        volume_rate_m3_s: dv,
        internal_energy_rate_w: du,
        caloric_residual_w: du - mass_rate * q.internal_energy_j_kg,
    };
    finite(&[dv, du, out.caloric_residual_w])?;
    Ok(out)
}

/// First composed residual is pure water. Amounts AND arrivals are checked;
/// this explicit domain refusal never turns transported NC into steam.
pub fn require_pure_water(
    air_kg: f64,
    nitrogen_kg: f64,
    air_rate: f64,
    nitrogen_rate: f64,
) -> Result<()> {
    finite(&[air_kg, nitrogen_kg, air_rate, nitrogen_rate])?;
    if [air_kg, nitrogen_kg, air_rate, nitrogen_rate]
        .iter()
        .any(|v| *v != 0.)
    {
        return Err("PZR noncondensable continuation not admitted in first hot spine");
    }
    Ok(())
}

/// Finite physical phase/event stock, not a padded absent-phase state. Momentum
/// is retained for the responsible material receipt even under the low-Mach
/// thermal reduction; no K/PE or friction heat is added to internal energy.
#[derive(Clone, Copy, Debug, Default)]
pub struct PhaseInventory {
    pub mass_kg: f64,
    pub internal_energy_j: f64,
    pub momentum_kg_m_s: [f64; 2],
    pub dissolved_boron_kg: f64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct FiniteReceipt {
    pub mass_kg: f64,
    pub thermal_enthalpy_j: f64,
    pub phase_volume_m3: f64,
    pub momentum_kg_m_s: [f64; 2],
    pub dissolved_boron_kg: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct PhaseTransition {
    pub inventory: [PhaseInventory; 2],
    pub active: Active,
    /// Caller must close this fixed-volume row and actual maintained-EOS
    /// caloric/volume rows at the candidate pressure before event admission.
    pub phase_volume_defect_m3: f64,
}
fn inventory(p: PhaseInventory, vapor: bool) -> Result<()> {
    finite(&[
        p.mass_kg,
        p.internal_energy_j,
        p.momentum_kg_m_s[0],
        p.momentum_kg_m_s[1],
        p.dissolved_boron_kg,
    ])?;
    if p.mass_kg < 0. || p.dissolved_boron_kg < 0. || (vapor && p.dissolved_boron_kg != 0.) {
        return Err("inadmissible physical PZR phase inventory");
    }
    if p.mass_kg == 0.
        && [
            p.internal_energy_j,
            p.momentum_kg_m_s[0],
            p.momentum_kg_m_s[1],
            p.dissolved_boron_kg,
        ]
        .iter()
        .any(|v| *v != 0.)
    {
        return Err("PZR exhaustion retains energy/momentum/tracer residue");
    }
    Ok(())
}
/// Apply an ACTUAL finite receipt at a candidate common pressure. This performs
/// no root localization, EOS recovery, pressure reset or epsilon seeding. Each
/// phase receives dU=dH-p*dV; their pressure work cancels only when the reported
/// fixed-volume row closes. A phase is removed only after the responsible
/// outflow/conversion carries its entire finite energy, momentum and tracer.
pub fn apply_phase_receipts(
    p: f64,
    before: [PhaseInventory; 2],
    receipt: [FiniteReceipt; 2],
) -> Result<PhaseTransition> {
    finite(&[p])?;
    if p <= 0. {
        return Err("positive PZR event pressure required");
    }
    let mut after = before;
    for k in 0..2 {
        inventory(before[k], k == 1)?;
        let r = receipt[k];
        finite(&[
            r.mass_kg,
            r.thermal_enthalpy_j,
            r.phase_volume_m3,
            r.momentum_kg_m_s[0],
            r.momentum_kg_m_s[1],
            r.dissolved_boron_kg,
        ])?;
        if k == 1 && r.dissolved_boron_kg != 0. {
            return Err("PZR vapor receipt cannot carry dissolved boron");
        }
        after[k].mass_kg += r.mass_kg;
        after[k].internal_energy_j += r.thermal_enthalpy_j - p * r.phase_volume_m3;
        for j in 0..2 {
            after[k].momentum_kg_m_s[j] += r.momentum_kg_m_s[j];
        }
        after[k].dissolved_boron_kg += r.dissolved_boron_kg;
        inventory(after[k], k == 1)?;
    }
    let active = match (after[0].mass_kg > 0., after[1].mass_kg > 0.) {
        (true, true) => Active::TwoPhase,
        (true, false) => Active::Liquid,
        (false, true) => Active::Vapor,
        (false, false) => return Err("empty PZR region needs a separate evacuated-domain chart"),
    };
    let phase_volume_defect_m3 = receipt[0].phase_volume_m3 + receipt[1].phase_volume_m3;
    finite(&[phase_volume_defect_m3])?;
    Ok(PhaseTransition {
        inventory: after,
        active,
        phase_volume_defect_m3,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    // Explicit local affine-property fixture ONLY; actual IF97 tested opt-in.
    fn l() -> Point {
        Point {
            pressure_pa: 15e6,
            temperature_k: 600.,
            density_kg_m3: 660.,
            internal_energy_j_kg: 1.4e6,
            enthalpy_j_kg: 1.4e6 + 15e6 / 660.,
            density_pressure: 2e-6,
            density_temperature: -2.,
            energy_pressure: -0.01,
            energy_temperature: 5000.,
        }
    }
    fn g() -> Point {
        Point {
            pressure_pa: 15e6,
            temperature_k: 630.,
            density_kg_m3: 80.,
            internal_energy_j_kg: 2.6e6,
            enthalpy_j_kg: 2.6e6 + 15e6 / 80.,
            density_pressure: 7e-6,
            density_temperature: -0.5,
            energy_pressure: -0.02,
            energy_temperature: 3000.,
        }
    }
    fn close(a: f64, b: f64) {
        assert!(
            (a - b).abs() < 1e-7 * a.abs().max(b.abs()).max(1.),
            "{a} != {b}"
        );
    }
    #[test]
    fn present_absent_and_current_derivatives() {
        let c = chart(3., 15e6, 0.2, Active::TwoPhase, Some(l()), Some(g())).unwrap();
        for i in 0..4 {
            let h = if i == 0 { 10. } else { 1e-5 };
            let shift = |s: f64| {
                let mut a = l();
                let mut b = g();
                let p = 15e6 + if i == 0 { s } else { 0. };
                a.pressure_pa = p;
                b.pressure_pa = p;
                if i == 0 {
                    a.density_kg_m3 += s * a.density_pressure;
                    a.internal_energy_j_kg += s * a.energy_pressure;
                    b.density_kg_m3 += s * b.density_pressure;
                    b.internal_energy_j_kg += s * b.energy_pressure;
                }
                if i == 1 {
                    a.temperature_k += s;
                    a.density_kg_m3 += s * a.density_temperature;
                    a.internal_energy_j_kg += s * a.energy_temperature;
                }
                if i == 2 {
                    b.temperature_k += s;
                    b.density_kg_m3 += s * b.density_temperature;
                    b.internal_energy_j_kg += s * b.energy_temperature;
                }
                chart(
                    3.,
                    p,
                    0.2 + if i == 3 { s } else { 0. },
                    Active::TwoPhase,
                    Some(a),
                    Some(b),
                )
                .unwrap()
            };
            let p = shift(h);
            let n = shift(-h);
            for k in 0..4 {
                close((p.stock[k] - n.stock[k]) / (2. * h), c.jacobian[k][i]);
            }
        }
        let r = c.reduced().unwrap();
        let tangent = [3., 0.2, -0.1, 0.003];
        let rates: [f64; 4] =
            std::array::from_fn(|k| c.jacobian[k].iter().zip(tangent).map(|(a, b)| a * b).sum());
        close(
            r.mass
                .iter()
                .zip([tangent[0], rates[1], rates[2], tangent[3]])
                .map(|(a, b)| a * b)
                .sum(),
            rates[0],
        );
        assert!(chart(3., 15e6, 0., Active::Liquid, Some(l()), None).is_ok());
        assert!(chart(3., 15e6, 1., Active::Vapor, None, Some(g())).is_ok());
        assert!(chart(3., 15e6, 0., Active::Liquid, Some(l()), Some(g())).is_err());
        assert!(
            chart(3., 15e6, 0., Active::TwoPhase, Some(l()), Some(g()))
                .unwrap()
                .reduced()
                .is_err()
        );
    }
    #[test]
    fn actual_receipt_birth_is_not_a_saturation_default() {
        assert_eq!(
            birth(15e6, 0., 0., None).unwrap().internal_energy_rate_w,
            0.
        );
        let q = l();
        let b = birth(15e6, 2., q.enthalpy_j_kg, Some(q)).unwrap();
        close(b.internal_energy_rate_w, 2. * q.internal_energy_j_kg);
        close(b.caloric_residual_w, 0.);
        let bad = birth(15e6, 2., q.enthalpy_j_kg + 100., Some(q)).unwrap();
        close(bad.caloric_residual_w, 200.);
        assert!(birth(15e6, 1., 0., None).is_err());
        assert!(birth(15e6, -1., 0., Some(q)).is_err());
        assert!(require_pure_water(0., 0., 0., 0.).is_ok());
        assert!(require_pure_water(0., 0., 1e-9, 0.).is_err());
    }
    #[test]
    fn phase_mass_rates_and_volume_work_are_reciprocal() {
        let c = chart(3., 15e6, 0.2, Active::TwoPhase, Some(l()), Some(g())).unwrap();
        let rates = [7., 200., 300., 0.001];
        let r = c.reduced().unwrap();
        let dot = |a: [f64; 4]| a.into_iter().zip(rates).map(|(a, b)| a * b).sum::<f64>();
        let mdot = dot(r.mass);
        let vdot = dot(r.liquid_volume);
        let source = Sources {
            liquid_mass_kg_s: 0.8 * mdot - c.stock[0] * rates[3],
            vapor_mass_kg_s: 0.2 * mdot + c.stock[0] * rates[3],
            liquid_energy_w: rates[1] + c.pressure_pa * vdot,
            vapor_energy_w: rates[2] - c.pressure_pa * vdot,
        };
        let out = rate_constraints(c, rates, source).unwrap();
        for a in out.residual {
            close(a, 0.);
        }
        close(source.liquid_energy_w + source.vapor_energy_w, 500.);
        close(source.liquid_mass_kg_s + source.vapor_mass_kg_s, mdot);
        let pure = chart(3., 15e6, 0., Active::Liquid, Some(l()), None).unwrap();
        assert!(rate_constraints(pure, [0., 0., 0., 1.], Sources::default()).is_err());
        let arrival = rate_constraints(
            pure,
            [0.; 4],
            Sources {
                vapor_mass_kg_s: 1.,
                vapor_energy_w: 100.,
                ..Sources::default()
            },
        )
        .unwrap();
        assert_eq!(arrival.residual[1], -1.);
        assert_eq!(arrival.residual[3], -100.);
    }
}
