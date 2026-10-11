//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-generation/thermodynamics.md#s2-secondary-block
//! The SG tube heat path of one developed-length metal segment, by the
//! existing laws: the primary tube film from the SG primary cell into the
//! metal and the secondary wet/gas contact from the metal into the water.
//! In the joined spine the solids own the metal and both films; this is the
//! same composition as a tested function for zero-time receipts and
//! isolated probes, plus the stationary local wall balance of one segment.
//! It adds no law, fit, cache or held state.
use super::packet;
use crate::{
    joined::block::SecondaryView,
    network::Failure,
    thermal::{self, Film, Saturation, Scalar, WallLaw, WallMaterial, WaterPoint, WaterProperties},
};
use serde::Serialize;

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn recoverable(reason: impl Into<String>) -> Failure {
    Failure::Recoverable(reason.into())
}
fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(reason.into())
}

/// The SG primary cell at the current trial, with the exact saturation and
/// bulk tuples of the same call (same-call reuse, not a cache).
#[derive(Clone, Copy, Debug)]
pub struct PrimaryPort {
    pub pressure: Scalar,
    pub temperature: Scalar,
    pub saturation: Saturation,
    pub bulk: WaterPoint,
    /// Wall mass flux `sum(w m_face)/A_flow`, kg/(m² s).
    pub mass_flux: Scalar,
}

impl PrimaryPort {
    /// A held liquid primary state with its own maintained tuples.
    pub fn held<P: WaterProperties>(
        props: &P,
        pressure_pa: f64,
        temperature_k: f64,
        mass_flux_kg_m2_s: f64,
    ) -> Result<Self, Failure> {
        let (p, t) = (s(pressure_pa), s(temperature_k));
        Ok(Self {
            pressure: p,
            temperature: t,
            saturation: props
                .saturation(p)
                .map_err(|e| fatal(format!("primary saturation: {e}")))?,
            bulk: props
                .liquid(p, t)
                .map_err(|e| fatal(format!("primary liquid: {e}")))?,
            mass_flux: s(mass_flux_kg_m2_s),
        })
    }
}

/// One developed-length metal segment.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Segment {
    pub start_m: f64,
    pub end_m: f64,
    pub area_m2: f64,
    pub capacity_j_k: f64,
}

impl From<&packet::Segment> for Segment {
    fn from(g: &packet::Segment) -> Self {
        Self {
            start_m: g.developed_start_m,
            end_m: g.developed_end_m,
            area_m2: g.exchange_area_m2,
            capacity_j_k: g.capacity_j_k,
        }
    }
}

/// The two films' wall law constants: the tube film for the primary side;
/// the thermal diameter also for the secondary contact.
#[derive(Clone, Copy, Debug)]
pub struct Tube {
    law: WallLaw,
}

/// The stationary local wall balance of one segment at a held primary and
/// secondary: the metal temperature at which primary-to-metal heat equals
/// metal-to-secondary heat.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Stationary {
    pub wall_k: f64,
    pub primary_to_metal_w: f64,
    pub metal_to_secondary_w: f64,
    pub primary_mode: &'static str,
    /// The secondary wet law's branch at full wetting (a diagnostic of the
    /// same law; the heat is `metal_to_secondary_w`).
    pub secondary_wet_mode: &'static str,
    /// d(primary - secondary)/dT_wall at the root, W/K.
    pub slope_w_k: f64,
    pub iterations: usize,
}

impl Tube {
    pub fn new(t: &packet::Tube) -> Result<Self, Failure> {
        if ![
            t.thermal_diameter_m,
            t.steel_conductivity_w_mk,
            t.steel_density_kg_m3,
            t.steel_cp_j_kgk,
        ]
        .iter()
        .all(|v| v.is_finite() && *v > 0.)
            || !(t.emissivity > 0. && t.emissivity <= 1.)
        {
            return Err(fatal("SG tube law constants"));
        }
        Ok(Self {
            law: WallLaw {
                diameter_m: t.thermal_diameter_m,
                film: Film::Tube,
                emissivity: t.emissivity,
                material: WallMaterial {
                    conductivity: s(t.steel_conductivity_w_mk),
                    density: t.steel_density_kg_m3,
                    cp: s(t.steel_cp_j_kgk),
                },
            },
        })
    }

    pub fn law(&self) -> WallLaw {
        self.law
    }

    /// Heat from the primary cell into the segment's metal and from the metal
    /// into the secondary, both W, at metal temperature `wall_k`.
    pub fn segment_heat<P: WaterProperties>(
        &self,
        props: &P,
        port: &PrimaryPort,
        view: &SecondaryView,
        wall_k: Scalar,
        segment: &Segment,
    ) -> Result<(Scalar, Scalar), Failure> {
        let primary = thermal::liquid_wall_current(
            props,
            port.pressure,
            port.temperature,
            wall_k,
            port.mass_flux,
            self.law,
            port.saturation,
            port.bulk,
        )
        .map_err(|e| recoverable(format!("SG tube primary film: {e}")))?;
        if primary.vapor_mass.value != 0. || primary.vapor_mass.direction != 0. {
            return Err(recoverable(
                "SG-primary wall vapor needs its phase transaction",
            ));
        }
        let secondary = thermal::secondary_wall(
            props,
            view.pressure,
            view.saturation_temperature,
            wall_k,
            view.liquid_volume,
            segment.start_m,
            segment.end_m,
            segment.area_m2,
            self.law.diameter_m,
            view.steam_present,
        )
        .map_err(|e| recoverable(format!("SG tube secondary contact: {e}")))?;
        Ok((-primary.heat * s(segment.area_m2), secondary))
    }

    /// Solve the stationary local wall balance of one segment by safeguarded
    /// Newton on the exact wall direction, bracketed between the secondary
    /// saturation and the primary temperature. Requires a primary hotter than
    /// the secondary saturation; stops at `|q_p - q_s| <= 1e-12 |q_s|` or a
    /// bracket narrower than one ulp.
    pub fn stationary<P: WaterProperties>(
        &self,
        props: &P,
        port: &PrimaryPort,
        view: &SecondaryView,
        segment: &Segment,
    ) -> Result<Stationary, Failure> {
        let (mut lo, mut hi) = (view.saturation_temperature.value, port.temperature.value);
        if lo.is_nan() || hi.is_nan() || lo >= hi {
            return Err(fatal(
                "stationary wall needs a primary hotter than secondary saturation",
            ));
        }
        let fixed = |v: &SecondaryView| SecondaryView {
            pressure: s(v.pressure.value),
            saturation_temperature: s(v.saturation_temperature.value),
            liquid_volume: s(v.liquid_volume.value),
            steam_present: v.steam_present,
        };
        let view = fixed(view);
        let balance = |tw: f64| -> Result<(f64, f64, f64), Failure> {
            let (qp, qs) = self.segment_heat(props, port, &view, Scalar::new(tw, 1.), segment)?;
            Ok((qp.value - qs.value, qp.direction - qs.direction, qs.value))
        };
        let mut tw = 0.5 * (lo + hi);
        for iteration in 1..=200 {
            let (f, df, qs) = balance(tw)?;
            if f > 0. {
                lo = tw;
            } else {
                hi = tw;
            }
            let converged = f.abs() <= 1e-12 * qs.abs() || hi.next_down() <= lo;
            if converged {
                let (qp, qs) = self.segment_heat(props, port, &view, s(tw), segment)?;
                let primary = thermal::liquid_wall_current(
                    props,
                    port.pressure,
                    port.temperature,
                    s(tw),
                    port.mass_flux,
                    self.law,
                    port.saturation,
                    port.bulk,
                )
                .map_err(|e| recoverable(e.to_string()))?;
                let secondary = thermal::liquid_wall(
                    props,
                    view.pressure,
                    view.saturation_temperature,
                    s(tw),
                    s(0.),
                    WallLaw {
                        film: Film::External,
                        ..self.law
                    },
                )
                .map_err(|e| recoverable(e.to_string()))?;
                return Ok(Stationary {
                    wall_k: tw,
                    primary_to_metal_w: qp.value,
                    metal_to_secondary_w: qs.value,
                    primary_mode: primary.mode,
                    secondary_wet_mode: secondary.mode,
                    slope_w_k: df,
                    iterations: iteration,
                });
            }
            let newton = tw - f / df;
            tw = if df < 0. && newton > lo && newton < hi {
                newton
            } else {
                0.5 * (lo + hi)
            };
        }
        Err(fatal(
            "stationary wall balance did not converge in 200 iterations",
        ))
    }
}
