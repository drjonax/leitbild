//! Bitwise guard for the shared thermal laws that the heater edit touches.
//!
//! The digest covers every existing `liquid_wall` branch (Core, Tube,
//! External; sensible, nucleate, transition and film, and their refusals),
//! the exposed SG gas law and the SG secondary wall, with directions on every
//! input. It was recorded on the unmodified thermal.rs; the heater additions
//! must reproduce it exactly.
use leitbild_operating_plant::thermal::*;

fn c(x: f64) -> Scalar {
    Scalar::constant(x)
}

// Synthetic differentiable property fixture ONLY for this regression; the
// production path has no substitute for the maintained native port.
struct Fixture;
impl WaterProperties for Fixture {
    fn liquid(&self, p: Scalar, t: Scalar) -> Result<WaterPoint> {
        Ok(WaterPoint {
            density: c(800.) - c(0.7) * (t - c(500.)) + c(1e-7) * p,
            viscosity: c(0.00015) - c(2e-7) * (t - c(500.)) + c(1e-13) * p,
            conductivity: c(0.6) - c(0.0005) * (t - c(500.)) + c(1e-10) * p,
            cp: c(4500.) + c(2.) * (t - c(500.)) + c(1e-6) * p,
            expansion: c(0.002) + c(1e-6) * (t - c(500.)),
            enthalpy: c(1e6) + c(4500.) * (t - c(500.)) + c(0.001) * p,
        })
    }
    fn vapor(&self, p: Scalar, t: Scalar) -> Result<WaterPoint> {
        Ok(WaterPoint {
            density: p / (c(461.5) * t),
            viscosity: c(2e-5) + c(2e-8) * (t - c(500.)),
            conductivity: c(0.04) + c(0.0001) * (t - c(500.)),
            cp: c(2000.) + t,
            expansion: c(1.) / t,
            enthalpy: c(2.8e6) + c(2500.) * (t - c(500.)) + c(0.001) * p,
        })
    }
    fn saturation(&self, p: Scalar) -> Result<Saturation> {
        let t = c(500.) + c(8e-6) * p;
        Ok(Saturation {
            temperature: t,
            liquid: self.liquid(p, t)?,
            vapor: self.vapor(p, t)?,
            surface_tension: c(0.025) - c(1e-10) * p,
        })
    }
    fn saturated_vapor_density(&self, t: Scalar) -> Result<Scalar> {
        Ok((t - c(500.)) / c(8e-6) / (c(461.5) * t))
    }
}

/// FNV-1a over the exact bits; no hashing dependency.
struct Digest(u64);
impl Digest {
    fn bytes(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 ^= u64::from(*b);
            self.0 = self.0.wrapping_mul(0x100_0000_01b3);
        }
    }
    fn scalar(&mut self, x: Scalar) {
        self.bytes(&x.value.to_bits().to_le_bytes());
        self.bytes(&x.direction.to_bits().to_le_bytes());
    }
    fn outcome<T>(&mut self, r: &Result<T>, write: impl Fn(&mut Self, &T)) {
        match r {
            Ok(v) => {
                self.bytes(b"ok");
                write(self, v);
            }
            Err(e) => {
                self.bytes(b"err");
                self.bytes(e.as_bytes());
            }
        }
    }
}

fn flux(d: &mut Digest, q: &WallFlux) {
    for x in [q.heat, q.vapor_mass, q.liquid_energy, q.vapor_energy] {
        d.scalar(x);
    }
    d.bytes(q.mode.as_bytes());
}

fn law(film: Film, conductivity: Scalar) -> WallLaw {
    WallLaw {
        diameter_m: 0.02,
        film,
        emissivity: 0.3,
        material: WallMaterial {
            conductivity,
            density: 8000.,
            cp: Scalar::new(500., 0.7),
        },
    }
}

/// Every existing branch on one grid, with seeds on every input.
fn shared_digest() -> (u64, [usize; 6]) {
    let props = Fixture;
    let mut d = Digest(0xcbf2_9ce4_8422_2325);
    // Modes reached: sensible, nucleate, transition, film, refusals, SG.
    let mut modes = [0_usize; 6];
    let mut count = |r: &Result<WallFlux>| match r {
        Ok(q) => match q.mode {
            "sensible" => modes[0] += 1,
            "nucleate" => modes[1] += 1,
            "transition" => modes[2] += 1,
            "film" => modes[3] += 1,
            other => panic!("unexpected mode {other}"),
        },
        Err(_) => modes[4] += 1,
    };
    for film in [Film::Core, Film::Tube, Film::External] {
        for p in [2e6, 6e6, 12e6] {
            let tsat = 500. + 8e-6 * p;
            for subcooling in [0., 0.5, 20.] {
                for superheat in [-5., 0.5, 3., 10., 30., 100., 200., 400., 700.] {
                    for mass_flux in [0., 500., 4000.] {
                        let pressure = Scalar::new(p, 2e5);
                        let bulk = if subcooling == 0. {
                            // The exact saturated endpoint, seed included.
                            props.saturation(pressure).unwrap().temperature
                        } else {
                            Scalar::new(tsat - subcooling, 0.3)
                        };
                        let wall = Scalar::new(tsat + superheat, 0.7);
                        let g = Scalar::new(mass_flux, 10.);
                        let contact = law(film, Scalar::new(15., 0.01));
                        let q = liquid_wall(&props, pressure, bulk, wall, g, contact);
                        count(&q);
                        d.outcome(&q, flux);
                    }
                }
            }
            // Refusals: superheated recipient and domain.
            let hot = liquid_wall(
                &props,
                c(p),
                c(tsat + 1.),
                c(tsat + 10.),
                c(0.),
                law(film, c(15.)),
            );
            count(&hot);
            d.outcome(&hot, flux);
        }
    }
    for steam in [false, true] {
        for p in [2e6, 6e6] {
            let tsat = 500. + 8e-6 * p;
            for (bulk, wall) in [
                (tsat + 20., tsat - 30.),
                (tsat + 20., tsat + 30.),
                (tsat, tsat - 1.),
                (tsat - 2., tsat - 10.),
            ] {
                let q = sg_gas_wall(
                    &props,
                    Scalar::new(p, 1e5),
                    Scalar::new(bulk, 0.2),
                    Scalar::new(wall, -0.4),
                    steam,
                );
                if q.is_ok() {
                    modes[5] += 1;
                }
                d.outcome(&q, |d, x| d.scalar(*x));
                for liquid_volume in [0., 40., 72.] {
                    let w = secondary_wall(
                        &props,
                        Scalar::new(p, 1e5),
                        Scalar::new(bulk, 0.2),
                        Scalar::new(wall, -0.4),
                        Scalar::new(liquid_volume, 1.),
                        0.,
                        5.,
                        1250.,
                        0.02,
                        SteelContact {
                            emissivity: 0.3,
                            material: WallMaterial {
                                conductivity: Scalar::new(15., 0.),
                                density: 8000.,
                                cp: Scalar::new(500., 0.),
                            },
                        },
                        steam,
                    );
                    d.outcome(&w, |d, x| d.scalar(*x));
                }
            }
        }
    }
    (d.0, modes)
}

#[test]
fn heater_edit_keeps_core_tube_external_and_sg_branches_bitwise() {
    let (digest, modes) = shared_digest();
    println!("shared thermal digest {digest:#018x}, modes {modes:?}");
    // Every branch is exercised, so the digest guards each of them.
    assert!(modes.iter().all(|&n| n > 0), "modes {modes:?}");
    assert_eq!(digest, RECORDED, "shared thermal laws changed bitwise");
}

/// Recorded on the unmodified thermal.rs, once per build profile: the
/// optimized build rounds the last bits of the Tube transition-branch
/// directions differently (values agree), so each profile keeps its own.
const RECORDED: u64 = if cfg!(debug_assertions) {
    0xf796_7ba8_97ab_ad31
} else {
    0x68ed_99d2_b37b_6651
};
