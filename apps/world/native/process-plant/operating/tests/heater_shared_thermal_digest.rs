//! Guard for the shared thermal laws that the heater edit touches.
//!
//! The cases cover every existing `liquid_wall` branch (Core, Tube, External;
//! sensible, nucleate, transition and film, and their refusals), the exposed
//! SG gas law and the SG secondary wall, with directions on every input. The
//! baseline is the unmodified thermal.rs at ed9fa309; later edits must
//! reproduce it.
//!
//! The laws call the platform's `exp`, `ln` and `powf`, whose last bits differ
//! between libms. At ed9fa309, Apple's libm and glibc differ in 8 of the 802
//! cases, by at most 1 ULP in values and 1.35e-14 relative in directions, with
//! identical outcomes, modes and refusals. So the guard has two parts:
//! - bitwise: the digest of every result's exact bits equals the one recorded
//!   at ed9fa309 on the same target and build profile;
//! - portable: every case matches the committed baseline table with identical
//!   outcome, mode and refusal text, and values and directions within
//!   `PORTABLE_RELATIVE`.
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

/// One evaluated case: `ok` or `err <refusal>`, the mode (`-` if none) and
/// every (value, direction) in hashing order.
struct Case {
    outcome: String,
    mode: String,
    scalars: Vec<(f64, f64)>,
}

/// FNV-1a over the exact bits (no hashing dependency), keeping each case.
struct Digest {
    hash: u64,
    cases: Vec<Case>,
}
impl Digest {
    fn bytes(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.hash ^= u64::from(*b);
            self.hash = self.hash.wrapping_mul(0x100_0000_01b3);
        }
    }
    fn case(&mut self) -> &mut Case {
        self.cases
            .last_mut()
            .expect("a result belongs to an outcome")
    }
    fn scalar(&mut self, x: Scalar) {
        self.bytes(&x.value.to_bits().to_le_bytes());
        self.bytes(&x.direction.to_bits().to_le_bytes());
        self.case().scalars.push((x.value, x.direction));
    }
    fn outcome<T>(&mut self, r: &Result<T>, write: impl Fn(&mut Self, &T)) {
        let outcome = match r {
            Ok(_) => "ok".to_string(),
            Err(e) => format!("err {e}"),
        };
        self.cases.push(Case {
            outcome,
            mode: "-".to_string(),
            scalars: Vec::new(),
        });
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
    d.case().mode = q.mode.to_string();
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
fn shared_digest() -> (u64, [usize; 6], Vec<Case>) {
    let props = Fixture;
    let mut d = Digest {
        hash: 0xcbf2_9ce4_8422_2325,
        cases: Vec::new(),
    };
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
    (d.hash, modes, d.cases)
}

#[test]
fn heater_edit_keeps_core_tube_external_and_sg_branches_bitwise() {
    let (digest, modes, _) = shared_digest();
    let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
    println!("shared thermal digest {digest:#018x} on {os}-{arch}, modes {modes:?}");
    // Every branch is exercised, so the digest guards each of them.
    assert!(modes.iter().all(|&n| n > 0), "modes {modes:?}");
    let Some(recorded) = recorded(os, arch) else {
        panic!(
            "no bitwise baseline is recorded for {os}-{arch}: run this test at \
             ed9fa309 on this target and record that digest, never one from \
             later code"
        );
    };
    assert_eq!(
        digest, recorded,
        "shared thermal laws changed bitwise on {os}-{arch}; the portable \
         baseline comparison tells a law change from a libm change"
    );
}

#[test]
fn shared_thermal_laws_match_the_pre_edit_baseline_portably() {
    let (_, _, cases) = shared_digest();
    let baseline = baseline_cases(include_str!("heater_shared_thermal_baseline.txt"));
    assert_eq!(cases.len(), baseline.len(), "case count");
    let mut inexact = 0;
    let mut worst = 0_f64;
    for (i, (case, base)) in cases.iter().zip(&baseline).enumerate() {
        assert_eq!(case.outcome, base.outcome, "case {i} outcome");
        assert_eq!(case.mode, base.mode, "case {i} mode");
        assert_eq!(case.scalars.len(), base.scalars.len(), "case {i} results");
        for (&(value, direction), &(base_value, base_direction)) in
            case.scalars.iter().zip(&base.scalars)
        {
            for (x, y) in [(value, base_value), (direction, base_direction)] {
                if x.to_bits() == y.to_bits() {
                    continue;
                }
                inexact += 1;
                if x == y {
                    continue; // +0 against -0
                }
                let relative = (x - y).abs() / x.abs().max(y.abs());
                worst = worst.max(relative);
                assert!(
                    relative <= PORTABLE_RELATIVE,
                    "case {i}: {x:e} against the baseline's {y:e} (relative {relative:e})"
                );
            }
        }
    }
    println!("{inexact} results differ from the baseline's bits, worst relative {worst:e}");
}

/// The digest recorded at ed9fa309 per target and build profile. The
/// optimized build rounds the last bits of the Tube transition-branch
/// directions differently (values agree), so each profile keeps its own.
fn recorded(os: &str, arch: &str) -> Option<u64> {
    let debug = cfg!(debug_assertions);
    match (os, arch) {
        // Apple libm (Darwin 25), rustc 1.97.1.
        ("macos", "aarch64") => Some(if debug {
            0xf796_7ba8_97ab_ad31
        } else {
            0x68ed_99d2_b37b_6651
        }),
        // GitHub ubuntu-latest: glibc 2.39, AMD EPYC with FMA, rustc 1.97.1,
        // recorded at ed9fa309 in Actions run 38162140292.
        ("linux", "x86_64") => Some(if debug {
            0x97f8_597f_7e11_3de0
        } else {
            0x763a_76b4_a823_8084
        }),
        _ => None,
    }
}

/// Relative agreement required of every value and direction against the
/// baseline table. The largest platform or profile difference measured at
/// ed9fa309 is 1.35e-14 (a Tube transition direction); a law change moves
/// results by many orders more.
const PORTABLE_RELATIVE: f64 = 1e-12;

/// The committed baseline: one line per case, `ok <mode or -> v:d ...` with
/// the exact bits in hex, or `err <refusal>`; `#` lines are comments.
fn baseline_cases(text: &str) -> Vec<Case> {
    let bits = |hex: &str| f64::from_bits(u64::from_str_radix(hex, 16).expect("hex bits"));
    text.lines()
        .filter(|line| !line.starts_with('#'))
        .map(|line| {
            if let Some(refusal) = line.strip_prefix("err ") {
                return Case {
                    outcome: format!("err {refusal}"),
                    mode: "-".to_string(),
                    scalars: Vec::new(),
                };
            }
            let mut fields = line.split(' ');
            assert_eq!(fields.next(), Some("ok"), "baseline line {line}");
            let mode = fields.next().expect("baseline mode").to_string();
            let scalars = fields
                .map(|pair| {
                    let (value, direction) = pair.split_once(':').expect("value:direction");
                    (bits(value), bits(direction))
                })
                .collect();
            Case {
                outcome: "ok".to_string(),
                mode,
                scalars,
            }
        })
        .collect()
}
