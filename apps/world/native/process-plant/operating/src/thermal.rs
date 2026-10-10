//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-thermal.md#compact-hot-thermal-closure
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#derivatives-without-reimplementing-a-property-library
//! Compact physical thermal equations. Temperatures are current algebraic
//! coordinates; every returned heat has one finite donor and recipient. No
//! integrator, thermostat, fitted h, fuel/source reset or nested surface solve.
//! The same directional evaluation consumes native property first partials.

use std::ops::{Add, Div, Mul, Neg, Sub};
const PI: f64 = std::f64::consts::PI;
const SB: f64 = 5.670374419e-8;
const G: f64 = 9.80665;
const BTU: f64 = 1055.05585262 / 3600. / 0.3048 * 1.8;
pub type Result<T> = std::result::Result<T, &'static str>;

/// One current value and ONE directional derivative, not a state/history or
/// approximate property cache. Property adapters must populate both fields.
#[derive(Clone, Copy, Debug, Default)]
pub struct Scalar {
    pub value: f64,
    pub direction: f64,
}
impl Scalar {
    pub fn new(value: f64, direction: f64) -> Self {
        Self { value, direction }
    }
    pub fn constant(value: f64) -> Self {
        Self::new(value, 0.)
    }
    fn finite(self) -> Result<Self> {
        if self.value.is_finite() && self.direction.is_finite() {
            Ok(self)
        } else {
            Err("nonfinite thermal value/direction")
        }
    }
    fn exp(self) -> Self {
        let e = self.value.exp();
        Self::new(e, e * self.direction)
    }
    fn ln(self) -> Self {
        Self::new(self.value.ln(), self.direction / self.value)
    }
    fn pow(self, exponent: f64) -> Self {
        // q=0 has a finite tangent only for exponents >=1 or a zero seed.
        let d = if self.value == 0. && self.direction == 0. {
            0.
        } else {
            exponent * self.value.powf(exponent - 1.) * self.direction
        };
        Self::new(self.value.powf(exponent), d)
    }
    fn abs(self) -> Self {
        if self.value < 0. {
            -self
        } else if self.value == 0. {
            Self::new(0., 0.)
        } else {
            self
        }
    }
    fn max(self, other: Self) -> Self {
        if self.value >= other.value {
            self
        } else {
            other
        }
    }
    fn min(self, other: Self) -> Self {
        if self.value <= other.value {
            self
        } else {
            other
        }
    }
}
impl From<f64> for Scalar {
    fn from(x: f64) -> Self {
        Self::constant(x)
    }
}
impl Add for Scalar {
    type Output = Self;
    fn add(self, b: Self) -> Self {
        Self::new(self.value + b.value, self.direction + b.direction)
    }
}
impl Sub for Scalar {
    type Output = Self;
    fn sub(self, b: Self) -> Self {
        Self::new(self.value - b.value, self.direction - b.direction)
    }
}
impl Mul for Scalar {
    type Output = Self;
    fn mul(self, b: Self) -> Self {
        Self::new(
            self.value * b.value,
            self.direction * b.value + self.value * b.direction,
        )
    }
}
impl Div for Scalar {
    type Output = Self;
    fn div(self, b: Self) -> Self {
        Self::new(
            self.value / b.value,
            (self.direction * b.value - self.value * b.direction) / (b.value * b.value),
        )
    }
}
impl Neg for Scalar {
    type Output = Self;
    fn neg(self) -> Self {
        Self::new(-self.value, -self.direction)
    }
}
fn s(x: f64) -> Scalar {
    x.into()
}
fn positive(x: Scalar) -> Result<()> {
    x.finite()?;
    if x.value > 0. {
        Ok(())
    } else {
        Err("positive thermal property required")
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct WaterPoint {
    pub density: Scalar,
    pub viscosity: Scalar,
    pub conductivity: Scalar,
    pub cp: Scalar,
    pub expansion: Scalar,
    pub enthalpy: Scalar,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Saturation {
    pub temperature: Scalar,
    pub liquid: WaterPoint,
    pub vapor: WaterPoint,
    pub surface_tension: Scalar,
}
/// Current-call property boundary. There is deliberately no constant-property
/// default. The adapter propagates pressure/temperature seeds through ALL
/// supplied properties, including transport, expansion and surface tension.
pub trait WaterProperties {
    fn liquid(&self, pressure: Scalar, temperature: Scalar) -> Result<WaterPoint>;
    fn vapor(&self, pressure: Scalar, temperature: Scalar) -> Result<WaterPoint>;
    fn saturation(&self, pressure: Scalar) -> Result<Saturation>;
    fn saturated_vapor_density(&self, temperature: Scalar) -> Result<Scalar>;
}
fn check_water(w: WaterPoint) -> Result<()> {
    for v in [w.density, w.viscosity, w.conductivity, w.cp] {
        positive(v)?;
    }
    w.enthalpy.finite()?;
    w.expansion.finite()?;
    Ok(())
}

/// Hot conductivity potential, same CTF law as the material owner. The hot
/// source spine admits fuel>=500K; a colder thermal campaign must explicitly
/// select/implement the already-owned matched IAEA continuation.
pub fn fuel_conductivity(t: Scalar) -> Result<Scalar> {
    if !t.value.is_finite() || !(500. ..=2000.).contains(&t.value) {
        return Err("hot fuel conductivity domain 500--2000 K");
    }
    Ok(s(BTU)
        * ((s(2335.) / (t + s(190.85))).max(s(1.1038))
            + s(0.007027) * (s(0.001867) * (t - s(273.15))).exp()))
}
fn fuel_potential(t: Scalar) -> Result<Scalar> {
    fuel_conductivity(t)?;
    let switch = 2335. / 1.1038 - 190.85;
    let phonon = if t.value <= switch {
        s(2335.) * (t + s(190.85)).ln()
    } else {
        s(2335. * (switch + 190.85).ln()) + s(1.1038) * (t - s(switch))
    };
    Ok(s(BTU) * (phonon + s(0.007027 / 0.001867) * (s(0.001867) * (t - s(273.15))).exp()))
}
pub fn clad_conductivity(t: Scalar) -> Result<Scalar> {
    if !t.value.is_finite() || !(290. ..=1800.).contains(&t.value) {
        return Err("clad conductivity domain 290--1800 K");
    }
    Ok(s(7.51) + s(0.0209) * t - s(1.45e-5) * t * t + s(7.67e-9) * t * t * t)
}
fn clad_potential(t: Scalar) -> Result<Scalar> {
    clad_conductivity(t)?;
    Ok(
        s(7.51) * t + s(0.0209 / 2.) * t * t - s(1.45e-5 / 3.) * t * t * t
            + s(7.67e-9 / 4.) * t * t * t * t,
    )
}
fn clad_cp(t: Scalar) -> Result<Scalar> {
    clad_conductivity(t)?;
    let x = [
        300., 400., 640., 1090., 1093., 1113., 1133., 1153., 1173., 1193., 1213., 1233., 1248.,
        2098.,
    ];
    let y = [
        281., 302., 331., 375., 502., 590., 615., 719., 816., 770., 619., 469., 356., 356.,
    ];
    let i = if t.value < 300. {
        0
    } else {
        (0..x.len() - 1)
            .find(|&i| t.value < x[i + 1])
            .unwrap_or(x.len() - 2)
    };
    Ok(s(y[i]) + s((y[i + 1] - y[i]) / (x[i + 1] - x[i])) * (t - s(x[i])))
}

#[derive(Clone, Copy, Debug)]
pub struct Caloric {
    pub specific_energy: Scalar,
    pub cp: Scalar,
}
/// Existing reviewed material law with its explicit 300 K datum. The energy
/// chart is nonlinear: prepared cp is not a constant mission heat capacity.
pub fn fuel_caloric(t: Scalar) -> Result<Caloric> {
    t.finite()?;
    if !(290. ..=2000.).contains(&t.value) {
        return Err("fuel caloric domain 290--2000 K");
    }
    let primitive = |x: Scalar| {
        s(296.7 * 535.285) / ((s(535.285) / x).exp() - s(1.))
            + s(0.0243 / 2.) * x * x
            + s(8.745e7) * (-s(1.577e5 / 8.3143) / x).exp()
    };
    let q = s(535.285) / t;
    let exp = q.exp();
    let cp = s(296.7) * q * q * exp / ((exp - s(1.)) * (exp - s(1.)))
        + s(0.0243) * t
        + s(8.745e7 * 1.577e5 / 8.3143) / (t * t) * (-s(1.577e5 / 8.3143) / t).exp();
    positive(cp)?;
    Ok(Caloric {
        specific_energy: (primitive(t) - primitive(s(300.))).finite()?,
        cp: cp.finite()?,
    })
}
/// Piecewise-linear cp with its exact quadratic primitive. Knot tangents are
/// the selected right-hand cp slope; E and dE/dT remain continuous.
pub fn clad_caloric(t: Scalar) -> Result<Caloric> {
    t.finite()?;
    let cp = clad_cp(t)?;
    let x = [
        300., 400., 640., 1090., 1093., 1113., 1133., 1153., 1173., 1193., 1213., 1233., 1248.,
        2098.,
    ];
    let y = [
        281., 302., 331., 375., 502., 590., 615., 719., 816., 770., 619., 469., 356., 356.,
    ];
    let mut energy = if t.value < 300. {
        let dt = t - s(300.);
        s(281.) * dt + s(0.105) * dt * dt
    } else {
        s(0.)
    };
    if t.value >= 300. {
        for i in 0..x.len() - 1 {
            let width = if t.value < x[i] {
                s(0.)
            } else if t.value >= x[i + 1] {
                s(x[i + 1] - x[i])
            } else {
                t - s(x[i])
            };
            energy =
                energy + width * (s(y[i]) + s(0.5 * (y[i + 1] - y[i]) / (x[i + 1] - x[i])) * width);
        }
    }
    Ok(Caloric {
        specific_energy: energy.finite()?,
        cp: cp.finite()?,
    })
}

#[derive(Clone, Copy, Debug)]
pub struct FuelGeometry {
    pub fuel_radius_m: f64,
    pub clad_inner_radius_m: f64,
    pub clad_outer_radius_m: f64,
    pub rod_length_m: f64,
    pub rods: f64,
    pub helium_volume_m3: f64,
    pub helium_nr_j_k: f64,
    pub accommodation: f64,
    pub fuel_emissivity: f64,
    pub clad_emissivity: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct FuelTemperatures {
    pub inner_mean: Scalar,
    pub outer_mean: Scalar,
    pub fuel_surface: Scalar,
    pub helium: Scalar,
    pub clad_inner: Scalar,
    pub clad_mean: Scalar,
    pub clad_outer: Scalar,
}
#[derive(Clone, Copy, Debug)]
pub struct FuelTransfers {
    pub inner_to_outer: Scalar,
    pub outer_to_surface: Scalar,
    pub surface_to_helium: Scalar,
    pub helium_to_clad_inner: Scalar,
    pub gap_radiation: Scalar,
    pub clad_inner_to_mean: Scalar,
    pub clad_mean_to_outer: Scalar,
    /// Three ZERO-CAPACITY constraints, in W, not heat/source inventories.
    pub surface_residuals: [Scalar; 3],
}
#[derive(Clone, Copy, Debug)]
pub struct FuelHeatRates {
    pub fuel_inner: Scalar,
    pub fuel_outer: Scalar,
    pub helium: Scalar,
    pub clad: Scalar,
    pub water: Scalar,
    pub surface_residuals: [Scalar; 3],
}
/// Pair actual interface receipts even OFF the three surface constraints.
/// Thus a signed Newton trial cannot create energy through algebraic defects.
pub fn fuel_heat_rates(
    g: &FuelGeometry,
    t: FuelTemperatures,
    source: [Scalar; 2],
    water_heat: Scalar,
) -> Result<FuelHeatRates> {
    source[0].finite()?;
    source[1].finite()?;
    let q = fuel_transfers(g, t, water_heat)?;
    Ok(FuelHeatRates {
        fuel_inner: source[0] - q.inner_to_outer,
        fuel_outer: source[1] + q.inner_to_outer - q.surface_to_helium - q.gap_radiation,
        helium: q.surface_to_helium - q.helium_to_clad_inner,
        clad: q.helium_to_clad_inner + q.gap_radiation - water_heat,
        water: water_heat,
        surface_residuals: q.surface_residuals,
    })
}
pub fn fuel_transfers(
    g: &FuelGeometry,
    t: FuelTemperatures,
    wall_heat_to_water: Scalar,
) -> Result<FuelTransfers> {
    let rf = g.fuel_radius_m;
    let ri = g.clad_inner_radius_m;
    let ro = g.clad_outer_radius_m;
    if ![
        rf,
        ri,
        ro,
        g.rod_length_m,
        g.rods,
        g.helium_volume_m3,
        g.helium_nr_j_k,
        g.accommodation,
        g.fuel_emissivity,
        g.clad_emissivity,
    ]
    .iter()
    .all(|x| x.is_finite() && *x > 0.)
        || !(rf < ri && ri < ro)
        || g.fuel_emissivity > 1.
        || g.clad_emissivity > 1.
    {
        return Err("invalid prepared fuel/gap geometry");
    }
    positive(t.helium)?;
    let nl = g.rod_length_m * g.rods;
    let af = 2. * PI * rf * nl;
    // Exact volume-average logarithmic radius for the one clad mean node.
    let log_total = (ro / ri).ln();
    let log_inner = ro * ro * log_total / (ro * ro - ri * ri) - 0.5;
    let log_outer = log_total - log_inner;
    if log_inner <= 0. || log_outer <= 0. {
        return Err("invalid clad mean logarithmic radius");
    }
    let k_he = s(BTU * 1.314e-3) * (s(1.8) * t.helium).pow(0.668);
    let p_he = s(g.helium_nr_j_k / g.helium_volume_m3) * t.helium;
    let jump = s(0.3048 * 2.0358e-5 / BTU) * k_he * t.helium.pow(0.5)
        / (p_he / s(6894.757293168) * s(g.accommodation / 4.003_f64.sqrt()));
    let gap_r = (s(ri - rf) + s(1.845) * jump) / (s(af) * k_he);
    let q01 = s(4. * PI * nl) * (fuel_potential(t.inner_mean)? - fuel_potential(t.outer_mean)?);
    let q1s = s(16. * PI * nl) * (fuel_potential(t.outer_mean)? - fuel_potential(t.fuel_surface)?);
    let qfh = s(2.) * (t.fuel_surface - t.helium) / gap_r;
    let qhc = s(2.) * (t.helium - t.clad_inner) / gap_r;
    let qr = s(SB * af / (1. / g.fuel_emissivity + rf / ri * (1. / g.clad_emissivity - 1.)))
        * (t.fuel_surface.pow(4.) - t.clad_inner.pow(4.));
    let qci = s(2. * PI * nl / log_inner)
        * (clad_potential(t.clad_inner)? - clad_potential(t.clad_mean)?);
    let qco = s(2. * PI * nl / log_outer)
        * (clad_potential(t.clad_mean)? - clad_potential(t.clad_outer)?);
    let residuals = [q1s - qfh - qr, qhc + qr - qci, qco - wall_heat_to_water];
    for q in [
        q01,
        q1s,
        qfh,
        qhc,
        qr,
        qci,
        qco,
        residuals[0],
        residuals[1],
        residuals[2],
    ] {
        q.finite()?;
    }
    Ok(FuelTransfers {
        inner_to_outer: q01,
        outer_to_surface: q1s,
        surface_to_helium: qfh,
        helium_to_clad_inner: qhc,
        gap_radiation: qr,
        clad_inner_to_mean: qci,
        clad_mean_to_outer: qco,
        surface_residuals: residuals,
    })
}
/// Feed the existing source sqrt(T) port with this derived functional. This
/// adds no temperature/energy state and remains correct for unequal fuel nodes.
pub fn fuel_feedback_temperature(inner: Scalar, outer: Scalar) -> Result<Scalar> {
    positive(inner)?;
    positive(outer)?;
    Ok((s(0.5) * (inner.pow(0.5) + outer.pow(0.5))).pow(2.))
}

#[derive(Clone, Copy, Debug)]
pub enum Film {
    Core,
    Tube,
    External,
    /// The PZR heater rod's selected wet law: the shared CTF onset, CTF
    /// Gorenflo, boiling-increment turnover, minimum-film and transition
    /// structure with its own constants. The caller supplies the 304
    /// material at the self-consistent minimum-film temperature.
    Heater(HeaterFilm),
}
/// Constants of the PZR wet law (`ld01-pzr-heater-contact`, and the shell
/// and heads' `ld01-pzr-shell`), owned by the caller's strict blocks;
/// nothing here is defaulted. The shell and heads reuse the heater's
/// complete source construction with their own coefficient and film.
#[derive(Clone, Copy, Debug)]
pub struct HeaterFilm {
    /// Signed sensible contact `qFC = h (Tw − TL)`, W/(m² K).
    pub sensible_w_m2_k: f64,
    pub onset_contact_angle_deg: f64,
    /// `chi`: the boiling increment's share born as wall vapor.
    pub wall_birth_fraction: f64,
    /// Bounds of the CTF minimum-film selector, K.
    pub minimum_film_bounds_k: [f64; 2],
    pub film: FilmBranch,
}
/// The film-boiling branch of the PZR wet law, with the film radiation
/// `emissivity σ (Tw⁴ − Tsat⁴)` of the law in both.
#[derive(Clone, Copy, Debug)]
pub enum FilmBranch {
    /// Bromley's vertical film over a fixed development length (rods:
    /// the full rod length; shell: its declared length), its convection
    /// term scaled by a factor (1 or a declared sensitivity).
    Vertical {
        coefficient: f64,
        length_m: f64,
        convection_factor: f64,
    },
    /// The heads' effective vapor thermal resistance `kv(Tf) (Tw − Tsat) /
    /// length`; the length is not a film thickness.
    Resistance { length_m: f64 },
}
#[derive(Clone, Copy, Debug)]
pub struct WallMaterial {
    pub conductivity: Scalar,
    pub density: f64,
    pub cp: Scalar,
}
#[derive(Clone, Copy, Debug)]
pub struct WallLaw {
    pub diameter_m: f64,
    pub film: Film,
    pub emissivity: f64,
    pub material: WallMaterial,
}
#[derive(Clone, Copy, Debug)]
pub struct WallFlux {
    pub heat: Scalar,
    pub vapor_mass: Scalar,
    pub liquid_energy: Scalar,
    pub vapor_energy: Scalar,
    pub mode: &'static str,
}

// Reuse an EXACT same-call endpoint including its direction, not a cached or
// frozen property. This also preserves the native saturation-curve chart.
fn liquid_point<P: WaterProperties>(
    props: &P,
    pressure: Scalar,
    t: Scalar,
    sat: Saturation,
) -> Result<WaterPoint> {
    if t.value == sat.temperature.value && t.direction == sat.temperature.direction {
        Ok(sat.liquid)
    } else {
        props.liquid(pressure, t)
    }
}
// Explicit physical coordinates and same-call endpoint/bulk ports; bundling
// them solely for a lint would hide which property seeds this law consumes.
#[allow(clippy::too_many_arguments)]
fn liquid_film<P: WaterProperties>(
    p: &P,
    pressure: Scalar,
    bulk_t: Scalar,
    wall_t: Scalar,
    mass_flux: Scalar,
    law: WallLaw,
    sat: Saturation,
    bulk: WaterPoint,
) -> Result<Scalar> {
    check_water(bulk)?;
    let d = law.diameter_m;
    if !d.is_finite() || d <= 0. {
        return Err("invalid film diameter");
    }
    if let Film::Heater(f) = law.film {
        // The heater's selected constant sensible coefficient.
        return Ok(s(f.sensible_w_m2_k));
    }
    let pr = bulk.viscosity * bulk.cp / bulk.conductivity;
    if matches!(law.film, Film::Core) {
        let re = mass_flux.abs() * s(d) / bulk.viscosity;
        let n = if wall_t.value >= bulk_t.value {
            0.4
        } else {
            0.3
        };
        return Ok(s(7.86).max(s(0.023) * re.pow(0.8) * pr.pow(n)) * bulk.conductivity / s(d));
    }
    let tw = wall_t.min(sat.temperature);
    let film = liquid_point(p, pressure, s(0.5) * (bulk_t + tw), sat)?;
    check_water(film)?;
    let delta = (wall_t - bulk_t).abs();
    if matches!(law.film, Film::External) {
        let film_pr = film.viscosity * film.cp / film.conductivity;
        let ra = s(G * d.powi(3)) * film.expansion * delta * film.density * film.density * film.cp
            / (film.viscosity * film.conductivity);
        // At equality evaluate q=h*delta's finite derivative directly, not the
        // singular derivative of a harmless fractional-power correction.
        let nu = if delta.value == 0. {
            s(0.36)
        } else {
            (s(0.6)
                + s(0.387) * ra.pow(1. / 6.)
                    / (s(1.) + (s(0.559) / film_pr).pow(9. / 16.)).pow(8. / 27.))
            .pow(2.)
        };
        return Ok(nu * film.conductivity / s(d));
    }
    let wall = liquid_point(p, pressure, tw, sat)?;
    check_water(wall)?;
    let wall_pr = wall.viscosity * wall.cp / wall.conductivity;
    let re = mass_flux.abs() * s(d) / bulk.viscosity;
    let ra =
        s(G * d.powi(3)) * bulk.expansion * delta * pr * (film.density / bulk.viscosity).pow(2.);
    let natural = if delta.value == 0. {
        s(0.)
    } else {
        s(0.59) * ra.pow(0.25).max(s(0.13 / 0.59) * ra.pow(1. / 3.))
    };
    let turbulent = if re.value > 1000. {
        let f = (s(1.58) * re.ln() - s(3.28)).pow(-2.);
        let ratio = (pr / wall_pr).max(s(0.05)).min(s(20.));
        (f / s(2.)) * (re - s(1000.)) * pr
            / (s(1.) + s(12.7) * (f / s(2.)).pow(0.5) * (pr.pow(2. / 3.) - s(1.)))
            * ratio.pow(0.11)
    } else {
        s(0.)
    };
    Ok(s(3.66).max(natural).max(turbulent) * bulk.conductivity / s(d))
}
fn pool(pressure: Scalar, superheat: Scalar, core: bool) -> Scalar {
    if superheat.value <= 0. {
        return s(0.);
    }
    let r = pressure / s(22.064e6);
    let n = s(0.9) - s(0.3) * r.pow(0.15);
    let denom = if core { s(1.) - r * r } else { s(1.) - r };
    let fp = s(1.73) * r.pow(0.27) + s(6.1) * r * r + s(0.68) * r * r / denom;
    // Variable exponent, so use exp(log(x)/(1-n)), not a fixed exponent.
    ((s(5600.) * fp * superheat / (n * s(20000_f64.ln())).exp()).ln() / (s(1.) - n)).exp()
}
// Local wet law deliberately receives the same explicit physical/property
// coordinates as liquid_film, not an independently prepared correlation state.
#[allow(clippy::too_many_arguments)]
fn wet<P: WaterProperties>(
    props: &P,
    pressure: Scalar,
    bulk_t: Scalar,
    wall_t: Scalar,
    flux: Scalar,
    law: WallLaw,
    sat: Saturation,
    bulk: WaterPoint,
) -> Result<(Scalar, Scalar, Scalar, Scalar)> {
    let h = liquid_film(props, pressure, bulk_t, wall_t, flux, law, sat, bulk)?;
    let sensible = h * (wall_t - bulk_t);
    if let Film::Heater(f) = law.film
        && bulk.enthalpy.value >= sat.liquid.enthalpy.value
    {
        // Saturated or superheated bulk (SPEC 59a1c83): CTF's net boiling
        // increment on the wall superheat with zero initiation flux, added
        // to the signed sensible term outside the cube root. Continuous at
        // Tw = Tsat and with no branch at Tw = T_L.
        let onset = sat.temperature;
        if wall_t.value <= onset.value {
            return Ok((sensible, s(0.), onset, sensible));
        }
        let superheat = wall_t - sat.temperature;
        let wall_sensible = h * superheat;
        let boiling = (wall_sensible.pow(3.) + pool(pressure, superheat, true).pow(3.))
            .pow(1. / 3.)
            - wall_sensible;
        let gamma = s(f.wall_birth_fraction) * boiling / (sat.vapor.enthalpy - bulk.enthalpy);
        return Ok((sensible + boiling, gamma, onset, sensible));
    }
    if wall_t.value <= bulk_t.value {
        return Ok((sensible, s(0.), bulk_t, sensible));
    }
    let shape = if let Film::Heater(f) = law.film {
        let angle = f.onset_contact_angle_deg.to_radians();
        1. - (-angle.powi(3) - 0.5 * angle).exp()
    } else {
        1. - (-38_f64.to_radians().powi(3) - 0.5 * 38_f64.to_radians()).exp()
    };
    // The heater follows the CTF (core) choices: saturated-liquid
    // conductivity, the onset's saturation form and the CTF Gorenflo factor.
    let ctf = matches!(law.film, Film::Core | Film::Heater(_));
    let latent = sat.vapor.enthalpy - sat.liquid.enthalpy;
    let d0 = s(2. / (shape * shape)) * h * sat.surface_tension * sat.temperature
        / (sat.vapor.density
            * latent
            * if ctf {
                sat.liquid.conductivity
            } else {
                bulk.conductivity
            });
    let sub = sat.temperature - bulk_t;
    let onset = match law.film {
        // The heater reaches here only with subcooled bulk: the tangency.
        // Its step from the saturated combination at h_L = h_f,sat is the
        // heater page's declared discontinuity.
        Film::Core | Film::Heater(_) => {
            sat.temperature + s(0.5) * (d0 + (d0 * d0 + s(4.) * d0 * sub).pow(0.5))
        }
        Film::Tube | Film::External => {
            bulk_t + s(0.25) * (d0.pow(0.5) + (d0 + s(4.) * sub).pow(0.5)).pow(2.)
        }
    };
    if wall_t.value <= onset.value {
        return Ok((sensible, s(0.), onset, sensible));
    }
    let enhancement = pool(pressure, wall_t - sat.temperature, ctf)
        - pool(pressure, onset - sat.temperature, ctf);
    let q = (sensible.pow(3.) + enhancement.pow(3.)).pow(1. / 3.);
    let qb = q - sensible;
    if let Film::Heater(f) = law.film {
        // Wall birth pays the actual liquid subcooling (or superheat).
        let gamma = s(f.wall_birth_fraction) * qb / (sat.vapor.enthalpy - bulk.enthalpy);
        return Ok((q, gamma, onset, sensible));
    }
    let gamma = if matches!(law.film, Film::Core) {
        let pe = flux.abs() * s(law.diameter_m) * sat.liquid.cp / bulk.conductivity;
        let det = qb * s(law.diameter_m) * sat.liquid.cp
            / (bulk.conductivity * s(0.0065) * s(70000.).max(pe));
        let departure = if det.value > 0. {
            ((bulk.enthalpy - sat.liquid.enthalpy + det) / det)
                .max(s(0.))
                .min(s(1.))
        } else {
            s(0.)
        };
        let pumping = latent
            / (latent
                + (sat.liquid.enthalpy - bulk.enthalpy) * sat.liquid.density / sat.vapor.density);
        departure * pumping * qb / latent
    } else {
        s(0.)
    };
    Ok((q, gamma, onset, sensible))
}
/// The CTF equations 466–470 minimum-film selector with the law's material.
/// Public as the material-at-temperature hook: a caller that selects a
/// self-consistent endpoint `Tm = Tmin(material at Tm)` evaluates it here
/// and passes that material to [`liquid_wall`].
pub fn minimum_film(
    pressure: Scalar,
    bulk_t: Scalar,
    law: WallLaw,
    sat: Saturation,
) -> Result<Scalar> {
    positive(law.material.conductivity)?;
    positive(law.material.cp)?;
    let l = sat.liquid;
    let v = sat.vapor;
    let latent = v.enthalpy - l.enthalpy;
    let eff = (l.conductivity * l.density * l.cp
        / (law.material.conductivity * s(law.material.density) * law.material.cp))
        .pow(0.5);
    let x = s(3203.6) - pressure / s(6894.757293168);
    let hn =
        (s(705.44) - s(0.04722) * x + s(2.3907e-5) * x * x - s(5.8193e-9) * x * x * x - s(32.))
            * s(5. / 9.)
            + s(273.15);
    let hnc = hn + (hn - bulk_t) * eff;
    let tb = sat.temperature
        + s(0.127) * v.density * latent / v.conductivity
            * (s(G) * (l.density - v.density) / (l.density + v.density)).pow(2. / 3.)
            * (sat.surface_tension / (s(G) * (l.density - v.density))).pow(0.5)
            * (v.viscosity / (s(G) * (l.density - v.density))).pow(1. / 3.);
    let henry = tb
        + s(0.42)
            * (tb - bulk_t)
            * (eff * latent / (law.material.cp * (tb - sat.temperature))).pow(0.6);
    if let Film::Heater(f) = law.film {
        let [low, high] = f.minimum_film_bounds_k;
        return Ok(s(low).max(s(high).min(hnc.max(henry))));
    }
    Ok(s(755.3722222222222).max(s(898.7055555555555).min(hnc.max(henry))))
}
fn film_heat<P: WaterProperties>(
    props: &P,
    pressure: Scalar,
    wall_t: Scalar,
    law: WallLaw,
    sat: Saturation,
) -> Result<Scalar> {
    let vapor = props.vapor(pressure, s(0.5) * (wall_t + sat.temperature))?;
    check_water(vapor)?;
    let radiation = s(law.emissivity * SB) * (wall_t.pow(4.) - sat.temperature.pow(4.));
    // The PZR film: Bromley's vertical film over its fixed length, with the
    // latent-enthalpy form and a convection factor, or the heads' vapor
    // resistance.
    let (coefficient, length, latent, factor) = match law.film {
        Film::Core => (1.13, 0.25, sat.vapor.enthalpy - sat.liquid.enthalpy, None),
        Film::Heater(HeaterFilm {
            film: FilmBranch::Resistance { length_m },
            ..
        }) => {
            return Ok(vapor.conductivity * (wall_t - sat.temperature) / s(length_m) + radiation);
        }
        Film::Heater(HeaterFilm {
            film:
                FilmBranch::Vertical {
                    coefficient,
                    length_m,
                    convection_factor,
                },
            ..
        }) => (
            coefficient,
            length_m,
            sat.vapor.enthalpy - sat.liquid.enthalpy,
            Some(convection_factor),
        ),
        Film::Tube | Film::External => (
            0.62,
            law.diameter_m,
            vapor.enthalpy - sat.liquid.enthalpy,
            None,
        ),
    };
    let h = s(coefficient)
        * (vapor.conductivity.pow(3.)
            * vapor.density
            * (sat.liquid.density - vapor.density)
            * s(G)
            * latent
            / (s(length) * vapor.viscosity * (wall_t - sat.temperature)))
            .pow(0.25);
    let convection = match factor {
        Some(f) => s(f) * h * (wall_t - sat.temperature),
        None => h * (wall_t - sat.temperature),
    };
    Ok(convection + radiation)
}

fn liquid_wall_inputs(
    pressure: Scalar,
    bulk_t: Scalar,
    wall_t: Scalar,
    mass_flux: Scalar,
    law: WallLaw,
) -> Result<()> {
    positive(pressure)?;
    positive(bulk_t)?;
    positive(wall_t)?;
    mass_flux.finite()?;
    if !(1e5..=16e6).contains(&pressure.value) || !(0. ..=1.).contains(&law.emissivity) {
        return Err("hot thermal wet-contact domain");
    }
    Ok(())
}

/// Full selected wet contact. Constitutive endpoint localization is bounded;
/// it is not a material-surface solve or an integration method. The endpoint
/// tangent follows the implicit law, not the bisection's iteration history.
pub fn liquid_wall<P: WaterProperties>(
    props: &P,
    pressure: Scalar,
    bulk_t: Scalar,
    wall_t: Scalar,
    mass_flux: Scalar,
    law: WallLaw,
) -> Result<WallFlux> {
    liquid_wall_inputs(pressure, bulk_t, wall_t, mass_flux, law)?;
    let sat = props.saturation(pressure)?;
    let bulk = liquid_point(props, pressure, bulk_t, sat)?;
    liquid_wall_current(props, pressure, bulk_t, wall_t, mass_flux, law, sat, bulk)
}

/// Sibling composition may supply the SAME current saturation and bulk tuple
/// already recovered by its fluid chart. This is exact same-call reuse, not a
/// cache or a constant-property interface. The public wrapper remains the
/// standalone entry; both consume this one physical law and all its checks.
#[allow(clippy::too_many_arguments)]
pub(crate) fn liquid_wall_current<P: WaterProperties>(
    props: &P,
    pressure: Scalar,
    bulk_t: Scalar,
    wall_t: Scalar,
    mass_flux: Scalar,
    law: WallLaw,
    sat: Saturation,
    bulk: WaterPoint,
) -> Result<WallFlux> {
    liquid_wall_inputs(pressure, bulk_t, wall_t, mass_flux, law)?;
    // Preserve the standalone endpoint identity, including its seed: an exact
    // saturated bulk consumes that actual endpoint, not a nearby branch call.
    let bulk =
        if bulk_t.value == sat.temperature.value && bulk_t.direction == sat.temperature.direction {
            sat.liquid
        } else {
            bulk
        };
    check_water(bulk)?;
    // The heater admits metastable bulk liquid through its saturated-bulk
    // onset; the other films keep the stable recipient.
    if bulk_t.value > sat.temperature.value && !matches!(law.film, Film::Heater(_)) {
        return Err("stable liquid wall recipient required");
    }
    let (pre, pre_gamma, onset, _) =
        wet(props, pressure, bulk_t, wall_t, mass_flux, law, sat, bulk)?;
    // The heater's saturated-bulk combination boils above Tsat even with
    // the wall below a superheated liquid; its sensible region is below onset.
    let heater = matches!(law.film, Film::Heater(_));
    if wall_t.value <= onset.value || (!heater && wall_t.value <= bulk_t.value) {
        return Ok(WallFlux {
            heat: pre.finite()?,
            vapor_mass: s(0.),
            liquid_energy: pre,
            vapor_energy: s(0.),
            mode: "sensible",
        });
    }
    let qscale = s(0.131)
        * (sat.vapor.enthalpy - sat.liquid.enthalpy)
        * sat.vapor.density.pow(0.5)
        * (s(G) * sat.surface_tension * (sat.liquid.density - sat.vapor.density)).pow(0.25)
        * (sat.liquid.density / (sat.liquid.density + sat.vapor.density)).pow(0.5);
    let minimum = minimum_film(pressure, bulk_t, law, sat)?;
    let objective = |tw: Scalar,
                     p: Scalar,
                     t: Scalar,
                     g: Scalar,
                     l: WallLaw,
                     ss: Saturation,
                     b: WaterPoint|
     -> Result<Scalar> {
        let (q, _, _, sensible) = wet(props, p, t, tw, g, l, ss, b)?;
        Ok(if matches!(law.film, Film::External) {
            q - qscale
        } else {
            q - sensible - qscale
        })
    };
    let mut lo = onset.value;
    let mut hi = minimum.value;
    if objective(s(lo), pressure, bulk_t, mass_flux, law, sat, bulk)?.value >= 0.
        || objective(s(hi), pressure, bulk_t, mass_flux, law, sat, bulk)?.value <= 0.
    {
        return Err("unordered wet/film turnover endpoints");
    }
    for _ in 0..52 {
        let mid = 0.5 * (lo + hi);
        if objective(s(mid), pressure, bulk_t, mass_flux, law, sat, bulk)?.value > 0. {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    let root = 0.5 * (lo + hi);
    let fixed = objective(s(root), pressure, bulk_t, mass_flux, law, sat, bulk)?;
    // Wall seed only: all other current coordinates/properties have zero seed.
    let zero_point = |w: WaterPoint| WaterPoint {
        density: s(w.density.value),
        viscosity: s(w.viscosity.value),
        conductivity: s(w.conductivity.value),
        cp: s(w.cp.value),
        expansion: s(w.expansion.value),
        enthalpy: s(w.enthalpy.value),
    };
    let zero_sat = Saturation {
        temperature: s(sat.temperature.value),
        liquid: zero_point(sat.liquid),
        vapor: zero_point(sat.vapor),
        surface_tension: s(sat.surface_tension.value),
    };
    let zero_law = WallLaw {
        material: WallMaterial {
            conductivity: s(law.material.conductivity.value),
            density: law.material.density,
            cp: s(law.material.cp.value),
        },
        ..law
    };
    let seeded = objective(
        Scalar::new(root, 1.),
        s(pressure.value),
        s(bulk_t.value),
        s(mass_flux.value),
        zero_law,
        zero_sat,
        zero_point(bulk),
    )?;
    // qscale's captured seed is absent from ∂F/∂Tw: remove it explicitly.
    let derivative = seeded.direction + qscale.direction;
    if !derivative.is_finite() || derivative <= 0. {
        return Err("singular wet turnover derivative");
    }
    let turn = Scalar::new(root, -fixed.direction / derivative);
    let (peak, peak_gamma, _, _) = wet(props, pressure, bulk_t, turn, mass_flux, law, sat, bulk)?;
    let qmin = film_heat(props, pressure, minimum, law, sat)?;
    if !(onset.value < turn.value
        && turn.value < minimum.value
        && qmin.value > 0.
        && qmin.value < peak.value)
    {
        return Err("unordered complete wet/film endpoints");
    }
    let (q, gamma, mode) = if wall_t.value <= turn.value {
        (pre, pre_gamma, "nucleate")
    } else if wall_t.value < minimum.value {
        let weight = ((wall_t - minimum) / (turn - minimum)).pow(2.);
        let gm = qmin / (sat.vapor.enthalpy - bulk.enthalpy);
        (
            weight * peak + (s(1.) - weight) * qmin,
            weight * peak_gamma + (s(1.) - weight) * gm,
            "transition",
        )
    } else {
        let q = film_heat(props, pressure, wall_t, law, sat)?;
        (q, q / (sat.vapor.enthalpy - bulk.enthalpy), "film")
    };
    // SG fluids are equilibrium owners: gamma is a diagnostic ONLY for core's
    // separated-temperature recipient and the heater's wall birth into its
    // cell's bubble stock, never a second SG phase-mass source.
    let gamma = if matches!(law.film, Film::Core | Film::Heater(_)) {
        gamma
    } else {
        s(0.)
    };
    let gas_energy = gamma * sat.vapor.enthalpy;
    for x in [q, gamma, gas_energy, q - gas_energy] {
        x.finite()?;
    }
    Ok(WallFlux {
        heat: q,
        vapor_mass: gamma,
        liquid_energy: q - gas_energy,
        vapor_energy: gas_energy,
        mode,
    })
}

pub fn core_wall_material(temperature: Scalar, density: f64) -> Result<WallMaterial> {
    Ok(WallMaterial {
        conductivity: clad_conductivity(temperature)?,
        density,
        cp: clad_cp(temperature)?,
    })
}
/// Exposed core gas sensible law. Absent gas MUST be omitted by the caller;
/// solid/guide radiation remains a separate finite-receiver transfer.
pub fn gas_wall<P: WaterProperties>(
    props: &P,
    p: Scalar,
    tg: Scalar,
    tw: Scalar,
    flux: Scalar,
    diameter: f64,
) -> Result<Scalar> {
    let w = props.vapor(p, s(0.5) * (tg + tw))?;
    check_water(w)?;
    let re = flux.abs() * s(diameter) / w.viscosity;
    let pr = w.viscosity * w.cp / w.conductivity;
    let n = if tw.value >= tg.value { 0.4 } else { 0.3 };
    (s(10.)
        .max(s(0.023) * re.pow(0.8) * pr.pow(n))
        .max(s(0.07907) * re.pow(0.6774) * pr.pow(0.333))
        * w.conductivity
        / s(diameter)
        * (tw - tg))
        .finite()
}
/// Effective reciprocal rod/guide view: Fguide->rod=1. No ambient receiver.
pub fn guide_radiation(
    rod_t: Scalar,
    guide_t: Scalar,
    rod_area: Scalar,
    guide_area: Scalar,
    emissivity: f64,
) -> Result<Scalar> {
    if rod_area.value == 0. || guide_area.value == 0. {
        return Ok(s(0.));
    }
    positive(rod_area)?;
    positive(guide_area)?;
    if !(0. ..=1.).contains(&emissivity) || emissivity == 0. {
        return Err("invalid guide emissivity");
    }
    let resistance = s(1. / emissivity - 1.) / rod_area + s(1. / emissivity) / guide_area;
    (s(SB) * (rod_t.pow(4.) - guide_t.pow(4.)) / resistance).finite()
}

/// Existing nonfuel250/5 contact, not the rod boiling package. For guide
/// faces log_radius=r_face*ln(r_face/r_mean) (or its inner counterpart)
/// supplies the selected half-wall cylindrical resistance at current mean k.
/// Fittings/plenum have their owned direct mean-temperature contact (zero).
/// Apply actual complementary phase areas outside this local function.
pub fn nonfuel_wall(
    solid_t: Scalar,
    fluid_t: Scalar,
    area: Scalar,
    h: f64,
    log_radius: f64,
) -> Result<Scalar> {
    if area.value == 0. {
        return Ok(s(0.));
    }
    positive(area)?;
    positive(solid_t)?;
    positive(fluid_t)?;
    if !h.is_finite() || h <= 0. || !log_radius.is_finite() || log_radius < 0. {
        return Err("invalid selected passive contact");
    }
    let resistance = if log_radius == 0. {
        s(1. / h)
    } else {
        s(1. / h) + s(log_radius) / clad_conductivity(solid_t)?
    };
    (area * (solid_t - fluid_t) / resistance).finite()
}
/// Paired donor is the SAME sealed helium stock used by both active halves.
/// The coefficient is the owned confined-conduction reduction, not a new gas
/// heat capacity or imposed plenum temperature.
pub fn helium_to_plenum(
    helium_t: Scalar,
    plenum_t: Scalar,
    area: f64,
    inner_radius: f64,
    factor: f64,
) -> Result<Scalar> {
    positive(helium_t)?;
    positive(plenum_t)?;
    if ![area, inner_radius, factor]
        .iter()
        .all(|x| x.is_finite() && *x > 0.)
    {
        return Err("invalid plenum contact geometry");
    }
    let k_he = s(BTU * 1.314e-3) * (s(1.8) * helium_t).pow(0.668);
    (s(area * factor / inner_radius) * k_he * (helium_t - plenum_t)).finite()
}

/// Exact submerged developed length of one selected 20m fold SEGMENT. Smooth
/// interiors have their directional derivative; ordinary clip ties use the
/// selected active branch. The inward crown cusp has NO finite derivative.
/// Capacity is NEVER multiplied by the returned wet fraction.
pub fn folded_wet_fraction(start: f64, end: f64, liquid_volume: Scalar) -> Result<Scalar> {
    if !start.is_finite() || !end.is_finite() || start < 0. || end > 20. || start >= end {
        return Err("invalid SG material segment");
    }
    liquid_volume.finite()?;
    let r = 1.5 / (PI - 2.);
    let up = 9.5 - r;
    let arc = PI * r;
    let zc = 12. - r;
    let height = s(2.5) + liquid_volume / s(7.5);
    // The arc crown is at up+pi*r/2 = 10.25m exactly. Only segments
    // containing it have the square-root loss of wet length on uncovery.
    if height.value == 12. && liquid_volume.direction < 0. && start <= 10.25 && end >= 10.25 {
        return Err("inward SG crown wetting derivative is unbounded");
    }
    let clip = |x: Scalar, lo: f64, hi: f64| x.max(s(lo)).min(s(hi));
    let wet_up = clip(height - s(2.5), start.min(up), end.min(up)) - s(start.min(up));
    let arc_lo = (start - up).max(0.).min(arc);
    let arc_hi = (end - up).max(0.).min(arc);
    let wet_arc = if arc_hi <= arc_lo || height.value <= zc {
        s(0.)
    } else if height.value >= 12. {
        s(arc_hi - arc_lo)
    } else {
        let x = (height - s(zc)) / s(r);
        let angle = Scalar::new(
            x.value.asin(),
            x.direction / (1. - x.value * x.value).sqrt(),
        );
        let entry = s(r) * angle;
        let exit = s(arc) - entry;
        clip(entry, arc_lo, arc_hi) - s(arc_lo) + s(arc_hi) - clip(exit, arc_lo, arc_hi)
    };
    let down_lo = (start - up - arc).max(0.);
    let down_hi = (end - up - arc).max(0.);
    let wet_down = s(down_hi) - clip(s(zc) - height, down_lo, down_hi);
    ((wet_up + wet_arc + wet_down) / s(end - start)).finite()
}

#[derive(Clone, Copy, Debug)]
pub struct SteamGeneratorRates {
    pub primary: Scalar,
    pub metal: Scalar,
    pub secondary: Scalar,
}
pub fn steam_generator_rates(
    primary_to_metal: Scalar,
    metal_to_secondary: Scalar,
) -> Result<SteamGeneratorRates> {
    primary_to_metal.finite()?;
    metal_to_secondary.finite()?;
    Ok(SteamGeneratorRates {
        primary: -primary_to_metal,
        metal: primary_to_metal - metal_to_secondary,
        secondary: metal_to_secondary,
    })
}
/// Exposed gas contact on one square metre: signed sensible heat into the
/// gas and, below the dew point with steam present, the condensate.
#[derive(Clone, Copy, Debug)]
pub struct GasContact {
    /// `h (Tw − Tgas)`, W/m², from the wall into the gas.
    pub sensible: Scalar,
    /// Present only with steam and `Tw < Tsat(p)`.
    pub condensation: Option<Condensation>,
}
#[derive(Clone, Copy, Debug)]
pub struct Condensation {
    /// `speed · max(0, ρ_steam − ρ_sat,vapor(Tw))`, kg/(m² s).
    pub mass: Scalar,
    /// Donor steam enthalpy, J/kg.
    pub vapor_enthalpy: Scalar,
    /// Condensed liquid enthalpy at the wall temperature and local pressure.
    pub liquid_enthalpy: Scalar,
}
/// The selected exposed gas law with its components. `steam` supplies the
/// actual donor steam point at `(p, bulk_t)`; it is evaluated only below the
/// dew point, and `None` means no steam, with no saturation lookup.
pub fn gas_contact<P: WaterProperties, F: FnOnce() -> Result<WaterPoint>>(
    props: &P,
    p: Scalar,
    bulk_t: Scalar,
    wall_t: Scalar,
    coefficient: f64,
    speed: f64,
    steam: Option<F>,
) -> Result<GasContact> {
    let sensible = s(coefficient) * (wall_t - bulk_t);
    let mut condensation = None;
    if let Some(steam) = steam {
        let sat = props.saturation(p)?;
        if wall_t.value < sat.temperature.value {
            let vapor = steam()?;
            check_water(vapor)?;
            let demand =
                s(speed) * (vapor.density - props.saturated_vapor_density(wall_t)?).max(s(0.));
            let liquid = props.liquid(p, wall_t)?;
            check_water(liquid)?;
            condensation = Some(Condensation {
                mass: demand,
                vapor_enthalpy: vapor.enthalpy,
                liquid_enthalpy: liquid.enthalpy,
            });
        }
    }
    Ok(GasContact {
        sensible,
        condensation,
    })
}
/// Selected exposed SG gas law. h=5W/m²K and 0.01m/s are explicitly owned
/// service-contact reductions, not fabricated replacements for tube flow.
/// Condensation is ONLY an energy demand; no extra SG phase-mass source.
pub fn sg_gas_wall<P: WaterProperties>(
    props: &P,
    p: Scalar,
    bulk_t: Scalar,
    wall_t: Scalar,
    steam_present: bool,
) -> Result<Scalar> {
    let contact = gas_contact(
        props,
        p,
        bulk_t,
        wall_t,
        5.,
        0.01,
        steam_present.then_some(|| props.vapor(p, bulk_t)),
    )?;
    let mut q = contact.sensible;
    if let Some(c) = contact.condensation {
        q = q - c.mass * (c.vapor_enthalpy - c.liquid_enthalpy);
    }
    q.finite()
}
/// One local metal face; its physical area is partitioned, not its energy.
/// Native M/U/V decides phase amounts. At dry/wet endpoints omit unavailable
/// phase property calls. Inventory range admission is the fluid owner's job.
// Public physical port: current water/metal state plus actual segment/area
// geometry and phase-presence flag. No hidden prepared defaults/context.
#[allow(clippy::too_many_arguments)]
pub fn secondary_wall<P: WaterProperties>(
    props: &P,
    p: Scalar,
    bulk_t: Scalar,
    wall_t: Scalar,
    liquid_volume: Scalar,
    start: f64,
    end: f64,
    area: f64,
    diameter: f64,
    steam_present: bool,
) -> Result<Scalar> {
    if !area.is_finite() || area <= 0. {
        return Err("invalid SG thermal area");
    }
    let wet = folded_wet_fraction(start, end, liquid_volume)?;
    let law = WallLaw {
        diameter_m: diameter,
        film: Film::External,
        emissivity: 0.3,
        material: WallMaterial {
            conductivity: s(15.),
            density: 8000.,
            cp: s(500.),
        },
    };
    let liquid = if wet.value > 0. {
        liquid_wall(props, p, bulk_t, wall_t, s(0.), law)?.heat
    } else {
        s(0.)
    };
    let gas = if wet.value < 1. {
        sg_gas_wall(props, p, bulk_t, wall_t, steam_present)?
    } else {
        s(0.)
    };
    (s(area) * (wet * liquid + (s(1.) - wet) * gas)).finite()
}

#[cfg(test)]
mod current_port_regression {
    use super::*;
    use std::cell::Cell;

    // Synthetic endpoint fixture only; no production property fallback.
    #[derive(Default)]
    struct Properties {
        queries: Cell<usize>,
    }
    fn point(p: Scalar, t: Scalar, vapor: bool) -> WaterPoint {
        WaterPoint {
            density: s(if vapor { 30. } else { 700. }) + s(1e-7) * p - s(0.5) * (t - s(600.)),
            viscosity: s(if vapor { 2e-5 } else { 1e-4 }),
            conductivity: s(if vapor { 0.05 } else { 0.6 }) + s(1e-10) * p,
            cp: s(if vapor { 2500. } else { 5000. }) + s(1e-6) * p,
            expansion: s(0.002),
            enthalpy: s(if vapor { 2.8e6 } else { 1.4e6 })
                + s(5000.) * (t - s(600.))
                + s(0.001) * p,
        }
    }
    impl WaterProperties for Properties {
        fn liquid(&self, p: Scalar, t: Scalar) -> Result<WaterPoint> {
            self.queries.set(self.queries.get() + 1);
            Ok(point(p, t, false))
        }
        fn vapor(&self, p: Scalar, t: Scalar) -> Result<WaterPoint> {
            self.queries.set(self.queries.get() + 1);
            Ok(point(p, t, true))
        }
        fn saturation(&self, p: Scalar) -> Result<Saturation> {
            self.queries.set(self.queries.get() + 1);
            let temperature = s(600.) + s(1e-6) * (p - s(1e7));
            Ok(Saturation {
                temperature,
                liquid: point(p, temperature, false),
                vapor: point(p, temperature, true),
                surface_tension: s(0.025),
            })
        }
        fn saturated_vapor_density(&self, _: Scalar) -> Result<Scalar> {
            self.queries.set(self.queries.get() + 1);
            Ok(s(30.))
        }
    }
    fn law() -> WallLaw {
        WallLaw {
            diameter_m: 0.02,
            film: Film::Core,
            emissivity: 0.3,
            material: WallMaterial {
                conductivity: s(15.),
                density: 8000.,
                cp: s(500.),
            },
        }
    }

    #[test]
    fn supplied_current_endpoint_preserves_wrapper_value_and_direction() {
        let props = Properties::default();
        let p = Scalar::new(1e7, 1000.);
        let sat = props.saturation(p).unwrap();
        let wall = Scalar::new(590., 0.3);
        let flux = Scalar::new(500., 2.);
        let expected = liquid_wall(&props, p, sat.temperature, wall, flux, law()).unwrap();
        // The exact saturated temperature AND seed must replace this deliberately
        // different tuple with sat.liquid, just as the standalone wrapper does.
        let different = WaterPoint {
            density: s(1400.),
            conductivity: Scalar::new(2., -0.1),
            cp: s(9000.),
            ..sat.liquid
        };
        let actual = liquid_wall_current(
            &props,
            p,
            sat.temperature,
            wall,
            flux,
            law(),
            sat,
            different,
        )
        .unwrap();
        assert_ne!(expected.heat.value, 0.);
        assert_ne!(expected.heat.direction, 0.);
        assert_eq!(actual.mode, expected.mode);
        for (a, b) in [
            (actual.heat, expected.heat),
            (actual.vapor_mass, expected.vapor_mass),
            (actual.liquid_energy, expected.liquid_energy),
            (actual.vapor_energy, expected.vapor_energy),
        ] {
            assert_eq!(
                [a.value.to_bits(), a.direction.to_bits()],
                [b.value.to_bits(), b.direction.to_bits()]
            );
        }
    }

    #[test]
    fn wet_contact_input_refusal_precedes_property_queries() {
        for (p, bulk, wall, flux, emissivity) in [
            (-1., 590., 580., 500., 0.3),
            (2e4, 590., 580., 500., 0.3),
            (1e7, 0., 580., 500., 0.3),
            (1e7, 590., 0., 500., 0.3),
            (1e7, 590., 580., f64::NAN, 0.3),
            (1e7, 590., 580., 500., 1.1),
        ] {
            let props = Properties::default();
            let mut contact = law();
            contact.emissivity = emissivity;
            assert!(liquid_wall(&props, s(p), s(bulk), s(wall), s(flux), contact).is_err());
            assert_eq!(props.queries.get(), 0);
        }
    }
}
