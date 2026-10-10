//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#finite-surge-and-pzr-connection-equations
//! PZR phase-contact laws the stratified cell reuses (decision 0014): the
//! liquid/vapor interface exchange, interphase drag factor and same-phase
//! conduction, with their value/direction helpers. The ten-region field that
//! first owned them is removed. Thermal receipts use h only; mechanical
//! conversion losses remain diagnostics and are never stacked onto paid
//! shaft heat or phase-volume pressure work.

use crate::thermal::{Saturation, Scalar, WaterPoint};
pub type Result<T> = std::result::Result<T, &'static str>;
fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
pub fn finite(v: Scalar) -> Result<()> {
    if v.value.is_finite() && v.direction.is_finite() {
        Ok(())
    } else {
        Err("nonfinite PZR field value/direction")
    }
}
pub fn positive(v: Scalar) -> Result<()> {
    finite(v)?;
    if v.value > 0. {
        Ok(())
    } else {
        Err("unavailable PZR positive constitutive property")
    }
}
pub fn pow(v: Scalar, p: f64) -> Scalar {
    Scalar::new(
        v.value.powf(p),
        if v.value == 0. && v.direction == 0. {
            0.
        } else {
            p * v.value.powf(p - 1.) * v.direction
        },
    )
}
pub fn dot(a: [Scalar; 2], b: [Scalar; 2]) -> Scalar {
    a[0] * b[0] + a[1] * b[1]
}
pub fn norm(a: [Scalar; 2]) -> Scalar {
    let v = a[0].value.hypot(a[1].value);
    if v == 0. {
        s(0.)
    } else {
        Scalar::new(
            v,
            (a[0].value * a[0].direction + a[1].value * a[1].direction) / v,
        )
    }
}
pub fn sub(a: [Scalar; 2], b: [Scalar; 2]) -> [Scalar; 2] {
    [a[0] - b[0], a[1] - b[1]]
}
pub fn water(w: WaterPoint) -> Result<()> {
    for v in [w.density, w.viscosity, w.conductivity, w.cp] {
        positive(v)?;
    }
    finite(w.expansion)?;
    finite(w.enthalpy)
}

#[derive(Clone, Copy, Debug)]
pub struct Phase {
    pub mass: Scalar,
    pub volume: Scalar,
    pub temperature: Scalar,
    /// Dissolved liquid tracer only; retained dry residue remains caller-owned.
    pub water: WaterPoint,
    pub velocity: [Scalar; 2],
    pub boron_mass: Scalar,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Sources {
    pub mass: Scalar,
    pub enthalpy: Scalar,
    pub momentum: [Scalar; 2],
    pub boron: Scalar,
}
impl Sources {
    pub fn add(&mut self, b: Self, sign: f64) {
        self.mass = self.mass + s(sign) * b.mass;
        self.enthalpy = self.enthalpy + s(sign) * b.enthalpy;
        self.boron = self.boron + s(sign) * b.boron;
        for i in 0..2 {
            self.momentum[i] = self.momentum[i] + s(sign) * b.momentum[i];
        }
    }
    pub fn check(self) -> Result<()> {
        for v in [
            self.mass,
            self.enthalpy,
            self.boron,
            self.momentum[0],
            self.momentum[1],
        ] {
            finite(v)?;
        }
        Ok(())
    }
}

/// Receipts of one liquid/vapor interface exchange. Liquid and vapor receive
/// opposite mass and momentum; neither carries dissolved boron.
#[derive(Clone, Copy, Debug)]
pub struct Exchange {
    pub liquid: Sources,
    pub vapor: Sources,
    /// Kinetic mixing loss of the converted mass, owned by its receiver, W.
    pub conversion_loss_w: Scalar,
    /// The net conversion evaporates liquid; false condenses vapor.
    pub evaporation: bool,
    /// Zero slip away from saturation: the zero Nusselt slope is an inexact
    /// Newton coefficient (the physical function has a square-root cusp).
    pub zero_slip_inexact: bool,
    /// The conversion sign was selected from its direction at exact zero.
    pub selected_branch_direction: bool,
}

/// Interface exchange between liquid `l` and vapor `g` over `area` at the
/// interface saturation `sat`: Ranz-Marshall film coefficients on each side
/// over `interfacial_length_m`, net latent conversion `(ql+qg)/hfg`.
pub fn exchange(
    interfacial_length_m: f64,
    l: Phase,
    g: Phase,
    area: Scalar,
    sat: Saturation,
) -> Exchange {
    let slip = sub(g.velocity, l.velocity);
    let speed = norm(slip);
    let zero = speed.value == 0.;
    let zero_slip_inexact = zero
        && (l.temperature.value != sat.temperature.value
            || g.temperature.value != sat.temperature.value);
    let h = |p: Phase| {
        let re = p.water.density * speed * s(interfacial_length_m) / p.water.viscosity;
        let pr = p.water.cp * p.water.viscosity / p.water.conductivity;
        // Explicit approved INEXACT coefficient slope at zero slip. Nu's
        // physical value stays exactly 2; there is no epsilon or smoothing.
        let root = if zero { s(0.) } else { pow(re, 0.5) };
        p.water.conductivity / s(interfacial_length_m) * (s(2.) + s(0.6) * root * pow(pr, 1. / 3.))
    };
    let ql = area * h(l) * (l.temperature - sat.temperature);
    let qg = area * h(g) * (g.temperature - sat.temperature);
    let gamma = (ql + qg) / (sat.vapor.enthalpy - sat.liquid.enthalpy);
    let evaporation = gamma.value > 0. || (gamma.value == 0. && gamma.direction >= 0.);
    let donor = if evaporation { l } else { g };
    let receiver = if evaporation { g } else { l };
    let momentum = [gamma * donor.velocity[0], gamma * donor.velocity[1]];
    let magnitude = if evaporation { gamma } else { -gamma };
    let delta = sub(donor.velocity, receiver.velocity);
    Exchange {
        liquid: Sources {
            mass: -gamma,
            enthalpy: -gamma * sat.liquid.enthalpy - ql,
            momentum: [-momentum[0], -momentum[1]],
            boron: s(0.),
        },
        vapor: Sources {
            mass: gamma,
            enthalpy: gamma * sat.vapor.enthalpy - qg,
            momentum,
            boron: s(0.),
        },
        conversion_loss_w: s(0.5) * magnitude * dot(delta, delta),
        evaporation,
        zero_slip_inexact,
        selected_branch_direction: gamma.value == 0. && gamma.direction != 0.,
    }
}

/// Same-phase conduction into `a` from `b` through a face of geometric
/// conductance `area_per_distance_m` (open area over centre distance, times
/// the shared phase fraction): harmonic-mean conductivity times `T_b - T_a`.
pub fn conduction(a: Phase, b: Phase, area_per_distance_m: Scalar) -> Scalar {
    let kh = s(2.) * a.water.conductivity * b.water.conductivity
        / (a.water.conductivity + b.water.conductivity);
    area_per_distance_m * kh * (b.temperature - a.temperature)
}

/// Schiller-Naumann `Cd*Re` below Re=1000 and Newton `0.44*Re` above; the
/// flag marks an exact tie at the selected transition (no smoothing).
pub fn interphase_drag_factor(re: Scalar) -> (Scalar, bool) {
    (
        if re.value < 1000. {
            s(24.) * (s(1.) + s(0.15) * pow(re, 0.687))
        } else {
            s(0.44) * re
        },
        re.value == 1000.,
    )
}

#[cfg(test)]
mod branch_tests {
    use super::*;
    #[test]
    fn free_exchange_conserves_mass_momentum_and_energy_and_flags_zero_slip() {
        let point = |t: f64, vapor: bool| WaterPoint {
            density: s(if vapor { 80. } else { 660. }),
            viscosity: s(if vapor { 2e-5 } else { 1e-4 }),
            conductivity: s(if vapor { 0.06 } else { 0.6 }),
            cp: s(if vapor { 3000. } else { 5000. }),
            expansion: s(0.002),
            enthalpy: s(if vapor { 2.6e6 } else { 1.4e6 } + 4000. * (t - 600.)),
        };
        let phase = |t: Scalar, vapor: bool, v: [Scalar; 2]| Phase {
            mass: s(10.),
            volume: s(0.1),
            temperature: t,
            water: point(t.value, vapor),
            velocity: v,
            boron_mass: s(0.),
        };
        let sat = Saturation {
            temperature: Scalar::new(615., 0.01),
            liquid: point(615., false),
            vapor: point(615., true),
            surface_tension: s(0.025),
        };
        for (tl, tg, slip) in [(612., 618., 0.1), (616., 619., -0.2), (612., 613., 0.)] {
            let l = phase(Scalar::new(tl, 0.2), false, [s(0.), s(0.01)]);
            let g = phase(Scalar::new(tg, -0.1), true, [s(0.), s(0.01 + slip)]);
            let e = exchange(0.003, l, g, Scalar::new(2., 0.1), sat);
            assert_eq!((e.liquid.mass + e.vapor.mass).value, 0.);
            assert_eq!((e.liquid.mass + e.vapor.mass).direction, 0.);
            for d in 0..2 {
                assert_eq!((e.liquid.momentum[d] + e.vapor.momentum[d]).value, 0.);
            }
            // Net enthalpy receipt is gamma*hfg - ql - qg = 0 to rounding.
            let net = e.liquid.enthalpy + e.vapor.enthalpy;
            assert!(net.value.abs() <= 1e-9 * e.vapor.enthalpy.value.abs().max(1.));
            assert_eq!(e.evaporation, e.vapor.mass.value >= 0.);
            assert_eq!(e.zero_slip_inexact, slip == 0.);
            assert!(e.conversion_loss_w.value >= 0.);
        }
        let a = phase(Scalar::new(600., 1.), false, [s(0.); 2]);
        let b = phase(Scalar::new(610., 0.), false, [s(0.); 2]);
        let heat = conduction(a, b, s(4.));
        assert_eq!(heat.value, 4. * 0.6 * 10.);
        assert_eq!(heat.direction, -4. * 0.6);
        assert_eq!((heat + conduction(b, a, s(4.))).value, 0.);
    }

    #[test]
    fn drag_transition_tie_is_explicit_not_smoothed() {
        let below = interphase_drag_factor(Scalar::new(1000. - 1e-6, 1.));
        let at = interphase_drag_factor(Scalar::new(1000., 1.));
        let above = interphase_drag_factor(Scalar::new(1000. + 1e-6, 1.));
        assert!(!below.1 && at.1 && !above.1);
        assert!((below.0.value - at.0.value).abs() > 1.);
        assert_eq!(at.0.value, 440.);
        assert_eq!(at.0.direction, 0.44);
    }
}
