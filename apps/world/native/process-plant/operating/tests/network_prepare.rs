//! Hydrostatic preparation checks on a synthetic packet and an analytic
//! two-branch property model that exist only in this file. Neither is LD-01
//! plant data, a water formulation or qualification evidence.
use leitbild_operating_plant::{
    hydraulics::{Pump as Impeller, Section, WallLaw},
    local_flow::{MomentumSupport, PressureSegment},
    network::{
        Failure, Network, Prepared, Properties, RotorState, Water,
        packet::*,
        prepare::{OperatingPoint, Receipt, RegionReceipt, Settings, prepare},
    },
    rotor::{Shaft, SpeedRequest, Support},
    thermal::{Saturation, Scalar, WaterPoint},
};

const G: f64 = 9.80665;
// Analytic chart: compressible liquid with expansion, ideal-gas vapor and a
// Clausius-Clapeyron saturation line. Values are synthetic.
const P0: f64 = 15.5e6;
const T0: f64 = 600.;
const RHO0: f64 = 650.;
const KAPPA: f64 = 1.5e-9;
const BETA: f64 = 3e-3;
const CL: f64 = 5500.;
const U0L: f64 = 1.5e6;
const R: f64 = 461.5;
const CV: f64 = 3000.;
const U0V: f64 = 2.5e6;
const TSAT0: f64 = 617.;
const LATENT: f64 = 1e6;

fn liquid(p: f64, t: f64) -> Water {
    let density = RHO0 * (KAPPA * (p - P0) - BETA * (t - T0)).exp();
    let u = U0L + CL * (t - T0);
    Water {
        pressure_pa: p,
        temperature_k: t,
        density_kg_m3: density,
        internal_energy_j_kg: u,
        enthalpy_j_kg: u + p / density,
        cp_j_kg_k: CL + p * BETA / density,
        expansion_per_k: BETA,
        compressibility_per_pa: KAPPA,
        viscosity_pa_s: 9e-5,
        conductivity_w_m_k: 0.5,
    }
}
fn vapor(p: f64, t: f64) -> Water {
    let u = U0V + CV * (t - T0);
    Water {
        pressure_pa: p,
        temperature_k: t,
        density_kg_m3: p / (R * t),
        internal_energy_j_kg: u,
        enthalpy_j_kg: u + R * t,
        cp_j_kg_k: CV + R,
        expansion_per_k: 1. / t,
        compressibility_per_pa: 1. / p,
        viscosity_pa_s: 2e-5,
        conductivity_w_m_k: 0.08,
    }
}
fn saturation_temperature(p: f64) -> f64 {
    1. / (1. / TSAT0 - R / LATENT * (p / P0).ln())
}
fn chart(p: f64, t: f64) -> Result<(), String> {
    if p.is_finite() && p > 0. && t.is_finite() && t > 0. {
        Ok(())
    } else {
        Err(format!("outside the analytic chart p={p} T={t}"))
    }
}

/// Value-only test properties: directions and enthalpy inversions refuse.
#[derive(Clone, Copy)]
struct Analytic;
impl Properties for Analytic {
    type Caloric = Water;
    fn forward(&self, vapor_branch: bool, p: f64, t: f64) -> Result<Water, String> {
        chart(p, t)?;
        Ok(if vapor_branch {
            vapor(p, t)
        } else {
            liquid(p, t)
        })
    }
    fn caloric(&self, vapor_branch: bool, p: f64, u: f64, enthalpy: bool) -> Result<Water, String> {
        if enthalpy {
            return Err("value-only analytic fixture has no enthalpy inversion".into());
        }
        let t = if vapor_branch {
            T0 + (u - U0V) / CV
        } else {
            T0 + (u - U0L) / CL
        };
        self.forward(vapor_branch, p, t)
    }
    fn values(&self, point: &Water) -> Water {
        *point
    }
    fn direction(&self, _: &Water, _: f64, _: f64) -> Result<Water, String> {
        Err("value-only analytic fixture has no directions".into())
    }
    fn saturation(&self, pressure: Scalar) -> Result<Saturation, String> {
        if pressure.direction != 0. {
            return Err("value-only analytic fixture has no directions".into());
        }
        let p = pressure.value;
        chart(p, 1.)?;
        let t = saturation_temperature(p);
        let c = Scalar::constant;
        let point = |w: Water| WaterPoint {
            density: c(w.density_kg_m3),
            viscosity: c(w.viscosity_pa_s),
            conductivity: c(w.conductivity_w_m_k),
            cp: c(w.cp_j_kg_k),
            expansion: c(w.expansion_per_k),
            enthalpy: c(w.enthalpy_j_kg),
        };
        Ok(Saturation {
            temperature: c(t),
            liquid: point(liquid(p, t)),
            vapor: point(vapor(p, t)),
            surface_tension: c(4e-3),
        })
    }
}

const AUTHORED_PA: f64 = 15.6e6;
const TRACER_PER_KG: f64 = 1e-3;
const SURGE: usize = 4;
const PZR: usize = 5;

fn segment(region: usize, length: f64, rise: f64) -> PressureSegment {
    PressureSegment {
        region,
        path_length_m: length,
        elevation_change_m: rise,
    }
}
fn support(region: usize, length: f64, area: f64) -> MomentumSupport {
    MomentumSupport {
        region,
        path_length_m: length,
        inverse_area_length_per_m: length / area,
        volume_m3: length * area,
    }
}
/// Two halves `(length, rise)`, one in each endpoint volume.
fn face(from: usize, to: usize, area: f64, halves: [(f64, f64); 2]) -> FacePacket {
    FacePacket {
        from,
        to,
        flow_area_m2: area,
        supports: vec![
            support(from, halves[0].0, area),
            support(to, halves[1].0, area),
        ],
        pressure_segments: vec![
            segment(from, halves[0].0, halves[0].1),
            segment(to, halves[1].0, halves[1].1),
        ],
    }
}

/// Four primary volumes in one loop (core, hot side, SG, cold side with a
/// pump section) at nonuniform temperature, a SURGE line volume and a
/// two-lane, five-band PZR (bands 10..20 m) whose bottom three bands are the
/// authored liquid. Authored pressure is flat, i.e. not hydrostatic rest.
fn packet() -> Packet {
    // (id, volume m3, temperature K); elevations 0, 6, 8, 1 m live in the
    // face segments, SURGE sits at 9 m.
    let primary = [
        ("CORE", 20., 590.),
        ("HOT", 10., 610.),
        ("SG", 15., 575.),
        ("COLD", 10., 565.),
    ];
    let mut regions: Vec<Region> = primary
        .iter()
        .map(|(id, volume, _)| Region {
            id: (*id).into(),
            volume_m3: *volume,
        })
        .collect();
    let water: Vec<WaterOwner> = primary
        .iter()
        .map(|(_, volume, t)| {
            let w = liquid(AUTHORED_PA, *t);
            WaterOwner {
                pressure_pa: AUTHORED_PA,
                temperature_k: *t,
                mass_kg: volume * w.density_kg_m3,
                energy_j: volume * w.density_kg_m3 * w.internal_energy_j_kg,
            }
        })
        .collect();
    let boron = water.iter().map(|w| TRACER_PER_KG * w.mass_kg).collect();
    regions.push(Region {
        id: "SURGE".into(),
        volume_m3: 0.8,
    });
    let surge_water = liquid(AUTHORED_PA, 605.);
    let surge_mass = 0.8 * surge_water.density_kg_m3;
    let t_sat = saturation_temperature(AUTHORED_PA);
    let mut pzr_regions = Vec::new();
    for band in 0..5 {
        for (lane, area, perimeter) in [("inner", 1., 3.5), ("outer", 2., 7.)] {
            let bottom = 10. + 2. * band as f64;
            let is_liquid = bottom + 2. <= 16.;
            let w = if is_liquid {
                liquid(AUTHORED_PA, t_sat)
            } else {
                vapor(AUTHORED_PA, t_sat)
            };
            let volume = 2. * area;
            let mass = volume * w.density_kg_m3;
            let energy = mass * w.internal_energy_j_kg;
            regions.push(Region {
                id: format!("PZR.{band}.{lane}"),
                volume_m3: volume,
            });
            pzr_regions.push(PzrRegion {
                initial_phase: if is_liquid { "liquid" } else { "vapor" }.into(),
                common_pressure_pa: AUTHORED_PA,
                water: PzrWater {
                    temperature_k: t_sat,
                },
                mass_kg: mass,
                liquid_energy_j: Some(if is_liquid { energy } else { 0. }),
                vapor_energy_j: Some(if is_liquid { 0. } else { energy }),
                absorber_tracer_kg_eq: if is_liquid { TRACER_PER_KG * mass } else { 0. },
                volume_m3: volume,
                axial_area_m2: area,
                top_m: bottom + 2.,
                bottom_m: bottom,
                solid_perimeter_m: perimeter,
                elevation_m: bottom + 1.,
            });
        }
    }
    let mut faces = vec![
        face(0, 1, 0.5, [(3., 3.), (3., 3.)]),
        face(1, 2, 0.5, [(4., 1.), (4., 1.)]),
        face(2, 3, 0.5, [(4., -3.5), (4., -3.5)]),
        face(3, 0, 0.3, [(2., -0.5), (2., -0.5)]),
        face(1, SURGE, 0.05, [(2., 1.5), (2., 1.5)]),
        face(SURGE, PZR + 1, 0.05, [(1., 1.), (1., 1.)]),
    ];
    let mut pzr_faces = Vec::new();
    for band in 0..5 {
        let radial_area = 2. * std::f64::consts::PI * (1. / std::f64::consts::PI).sqrt() * 2.;
        pzr_faces.push(PzrFace {
            from: 2 * band,
            to: 2 * band + 1,
            area_m2: radial_area,
            distance_m: 0.5,
            normal: [1., 0.],
        });
        let (from, to) = (PZR + 2 * band, PZR + 2 * band + 1);
        faces.push(FacePacket {
            from,
            to,
            flow_area_m2: radial_area,
            supports: vec![support(from, 0.3, 1.), support(to, 0.4, 2.)],
            pressure_segments: vec![segment(from, 0.3, 0.), segment(to, 0.4, 0.)],
        });
        if band < 4 {
            for (lane, area) in [(0, 1.), (1, 2.)] {
                pzr_faces.push(PzrFace {
                    from: 2 * band + lane,
                    to: 2 * band + 2 + lane,
                    area_m2: area,
                    distance_m: 2.,
                    normal: [0., 1.],
                });
                faces.push(face(
                    PZR + 2 * band + lane,
                    PZR + 2 * band + 2 + lane,
                    area,
                    [(1., 1.), (1., 1.)],
                ));
            }
        }
    }
    Packet {
        mechanics: Mechanics {
            regions,
            faces,
            force_projection: Vec::new(),
            section_force_projection: vec![SectionProjection {
                face: 3,
                section: 0,
                coefficient: 1.,
            }],
        },
        thermal: Thermal { water },
        water_boron_amount_kg_eq: boron,
        external_ports: ExternalPorts {
            surge_stock: SurgeStock {
                pressure_pa: AUTHORED_PA,
                temperature_k: 605.,
                mass_kg: surge_mass,
                internal_energy_j: surge_mass * surge_water.internal_energy_j_kg,
                absorber_tracer_kg_eq: TRACER_PER_KG * surge_mass,
            },
        },
        pzr: Pzr {
            regions: pzr_regions,
            faces: pzr_faces,
            selection: PzrSelection {
                interfacial_length_m: 0.01,
                solid_roughness_m: 1e-5,
            },
        },
        hydraulics: Hydraulics {
            pump: Pump {
                rotor_inertia_kg_m2: 500.,
                drag_nm_per_rad_s: 0.2,
                reference_omega_rad_s: 150.,
                nominal_fluid_power_w: 1e6,
                drive_tracking_time_s: 5.,
                drive_torque_cap_factor: 1.5,
                drive_efficiency: 0.96,
            },
            sections: vec![SectionEntry {
                region: 3,
                parameters: Section {
                    length_m: 2.,
                    area_m2: 0.3,
                    hydraulic_diameter_m: 0.,
                    elevation_change_m: -0.5,
                    gravity_m_s2: G,
                    wall: WallLaw::None,
                    form_loss: 0.5,
                    grid_count: 0,
                    grid_factor: 0.,
                    blockage_fraction: 0.,
                    pump: Some(Impeller {
                        a: 2.,
                        b: 0.5,
                        resistance: 0.1,
                        mixed_degradation_depth: 0.,
                    }),
                },
            }],
        },
    }
}

fn point(level: f64) -> OperatingPoint {
    OperatingPoint {
        pzr_roof_pressure_pa: 15.5e6,
        pzr_roof_elevation_m: 20.,
        pzr_level_m: level,
    }
}
const RUNNING: RotorState = RotorState {
    support: Support::Supported(SpeedRequest::Nominal),
    shaft: Shaft::Free,
};
const SETTINGS: Settings = Settings {
    pressure_tolerance_pa: 1e-6,
    max_passes: 30,
    level_match_m: 1e-9,
    eos_row_bound: 1e-12,
    tree_face_bound_pa: 1e-6,
};

fn prepared(level: f64) -> (Network<Analytic>, Prepared, Receipt) {
    prepare(&packet(), Analytic, &point(level), &[RUNNING], &SETTINGS)
        .unwrap_or_else(|e| panic!("{e:?}"))
}
fn refusal(level: f64, settings: &Settings) -> String {
    match prepare(&packet(), Analytic, &point(level), &[RUNNING], settings) {
        Err(Failure::Fatal(message)) => message,
        Err(other) => panic!("unexpected failure class {other:?}"),
        Ok(_) => panic!("level {level} was not refused"),
    }
}

/// Independent rest residual `p_from - p_to - g sum(rho dz)` from the
/// receipt's prepared stocks, with rho = M / V.
fn rest_residuals(packet: &Packet, receipt: &Receipt) -> Vec<f64> {
    let density: Vec<f64> = receipt
        .regions
        .iter()
        .zip(&packet.mechanics.regions)
        .map(|(r, region)| r.after.mass_kg / region.volume_m3)
        .collect();
    let pressure: Vec<f64> = receipt
        .regions
        .iter()
        .map(|r| r.after.pressure_pa)
        .collect();
    packet
        .mechanics
        .faces
        .iter()
        .map(|f| {
            let head: f64 = f
                .pressure_segments
                .iter()
                .map(|s| density[s.region] * G * s.elevation_change_m)
                .sum();
            pressure[f.from] - pressure[f.to] - head
        })
        .collect()
}

#[test]
fn sharp_hydrostatic_rest_at_the_declared_level() {
    let packet = packet();
    let (network, prepared, receipt) = prepared(6.);
    println!("{}", serde_json::to_string(&receipt).unwrap());
    assert_eq!(receipt.interface_elevation_m, 16.);
    assert_eq!(receipt.root_region, PZR + 8);
    // Passes contract to the fixed point within the declared tolerance.
    let passes = &receipt.pass_changes_pa;
    assert!(passes.len() >= 3 && *passes.last().unwrap() <= SETTINGS.pressure_tolerance_pa);
    assert!(
        passes
            .windows(2)
            .all(|w| w[1] < 1e-2 * w[0] || w[1] <= 1e-6)
    );

    // Round-off EOS and tree rest, evaluated by the network itself.
    assert!(receipt.max_eos_row <= 1e-14, "{}", receipt.max_eos_row);
    assert!(
        receipt.max_tree_face_pa <= 1e-7,
        "{}",
        receipt.max_tree_face_pa
    );
    let rest = rest_residuals(&packet, &receipt);
    let loops: Vec<usize> = receipt
        .faces
        .iter()
        .filter(|f| !f.tree)
        .map(|f| f.face)
        .collect();
    assert_eq!(
        loops,
        [2, 8, 11, 14, 17],
        "BFS from the roof: SG->COLD closes the primary loop, outer-lane axials the PZR loops"
    );
    for f in &receipt.faces {
        if f.tree || f.face != 2 {
            assert!(
                rest[f.face].abs() <= 1e-7,
                "face {} rest {}",
                f.face,
                rest[f.face]
            );
            assert!(
                f.largest_pa <= 1e-7,
                "face {} {:?}",
                f.face,
                f.pressure_gravity_pa
            );
        }
    }
    // The primary loop keeps its physical buoyancy drive: hot rising leg,
    // cold falling leg. Its value is the closed-loop integral -g sum(rho dz).
    let drive = receipt.faces[2].pressure_gravity_pa[0].unwrap();
    assert_eq!(receipt.faces[2].pressure_gravity_pa[1], None);
    assert!(drive > 4e3, "{drive}");
    assert!((drive - rest[2]).abs() <= 1e-9 * drive);
    let closed: f64 = [0, 1, 2, 3].iter().map(|&j| rest[j]).sum();
    assert!((closed - drive).abs() <= 1e-7);

    // Phases, saturation and preserved specific energy/concentration.
    for r in &receipt.regions {
        if r.region <= SURGE {
            assert_eq!((r.phase, r.saturation_margin_k), (0, None));
            let before = r.before.internal_energy_j / r.before.mass_kg;
            let after = r.after.internal_energy_j / r.after.mass_kg;
            assert!((after - before).abs() <= 1e-15 * before);
            assert!((r.after.temperature_k - r.before.temperature_k).abs() <= 1e-9);
            let c = r.after.tracer_kg_eq / r.after.mass_kg;
            assert!((c - TRACER_PER_KG).abs() <= 1e-15);
        } else {
            let band = (r.region - PZR) / 2;
            assert_eq!(r.phase, usize::from(band >= 3));
            assert_eq!(r.phase, r.authored_phase);
            assert!(r.saturation_margin_k.unwrap().abs() <= 1e-9);
            let expected = if r.phase == 0 {
                TRACER_PER_KG * r.after.mass_kg
            } else {
                0.
            };
            assert!((r.after.tracer_kg_eq - expected).abs() <= 1e-15 * r.after.mass_kg);
        }
    }
    // Roof gauge: root region at its centroid one metre below the roof.
    let root = &receipt.regions[PZR + 8];
    let rho = root.after.mass_kg / 2.;
    assert!((root.after.pressure_pa - 15.5e6 - rho * G).abs() <= 1e-8);
    // Lanes of one band share pressure; bands below are heavier.
    for band in 0..5 {
        let [a, b] = [0, 1].map(|lane| receipt.regions[PZR + 2 * band + lane].after.pressure_pa);
        assert_eq!(a, b);
    }
    // The 20 m column from the roof to the core lies between all-vapor and
    // all-liquid columns of the prepared densities.
    let core = receipt.regions[0].after.pressure_pa;
    assert!(core > receipt.regions[3].after.pressure_pa);
    let densities: Vec<f64> = receipt
        .regions
        .iter()
        .zip(&packet.mechanics.regions)
        .map(|(r, region)| r.after.mass_kg / region.volume_m3)
        .collect();
    let [lightest, heaviest] =
        [f64::min, f64::max].map(|f| densities.iter().copied().fold(densities[0], f));
    assert!(G * 20. * lightest < core - 15.5e6 && core - 15.5e6 < G * 20. * heaviest);

    // Totals are the sums of the per-region receipts.
    let sum = |f: fn(&RegionReceipt) -> f64| receipt.regions.iter().map(f).sum::<f64>();
    let mass = sum(|r| r.after.mass_kg) - sum(|r| r.before.mass_kg);
    assert!((receipt.mass_change_kg - mass).abs() <= 1e-9);
    let tracer = sum(|r| r.after.tracer_kg_eq) - sum(|r| r.before.tracer_kg_eq);
    assert!((receipt.tracer_change_kg_eq - tracer).abs() <= 1e-12);

    // Coordinates: overwritten stocks, untouched impulses and rotor, yp = 0.
    let (_, authored) = Network::new(&packet, Analytic).unwrap();
    for l in &network.face_layout {
        assert_eq!(prepared.y[l.index], 0.);
    }
    for &rotor in &network.rotor_index {
        assert_eq!(prepared.y[rotor].to_bits(), authored.y[rotor].to_bits());
    }
    assert!(prepared.yp.iter().all(|v| *v == 0.));
    assert_eq!(prepared.differential, authored.differential);
    for (node, l) in network.cell_layout.iter().enumerate() {
        let r = &receipt.regions[node];
        let scales = network.scales();
        assert_eq!(prepared.y[l.mass[1 - r.phase]], 0.);
        assert_eq!(prepared.y[l.energy[1 - r.phase]], 0.);
        assert_eq!(prepared.y[l.base] * scales[l.base], r.after.pressure_pa);
        let m = prepared.y[l.mass[r.phase]] * scales[l.mass[r.phase]];
        assert!((m - r.after.mass_kg).abs() <= 1e-15 * m);
    }
    // F(0, y, 0) is reported by row class; the pump starts from its head.
    let class = |name: &str| {
        receipt
            .initial_rows
            .iter()
            .find(|c| c.class == name)
            .unwrap()
            .max_abs
    };
    assert_eq!(class("eos"), receipt.max_eos_row);
    assert!(class("impulse") > 0.);
}

#[test]
fn a_lower_level_turns_the_top_liquid_band_to_vapor() {
    let (network, prepared, receipt) = prepared(4.);
    assert_eq!(receipt.interface_elevation_m, 14.);
    for r in &receipt.regions[PZR + 4..PZR + 6] {
        assert_eq!(
            (r.authored_phase, r.phase, r.after.tracer_kg_eq),
            (0, 1, 0.)
        );
        let l = network.cell_layout[r.region];
        assert_eq!(prepared.y[l.mass[0]], 0.);
        assert!(prepared.y[l.mass[1]] > 0.);
    }
    assert!(receipt.max_eos_row <= 1e-14);
    assert!(receipt.max_tree_face_pa <= 1e-7);
    let dropped: f64 = receipt.regions[PZR + 4..PZR + 6]
        .iter()
        .map(|r| r.before.tracer_kg_eq)
        .sum();
    assert!(receipt.tracer_change_kg_eq < -0.9 * dropped);
}

#[test]
fn an_unrepresentable_or_unsupported_level_is_refused() {
    let inside = refusal(5., &SETTINGS);
    assert!(inside.contains("cannot represent level 5"), "{inside}");
    let near = refusal(6. + 1e-6, &SETTINGS);
    assert!(near.contains("not at a region boundary"), "{near}");
    let raised = refusal(8., &SETTINGS);
    assert!(
        raised.contains("no prepared liquid tracer concentration"),
        "{raised}"
    );
}

#[test]
fn explicit_limits_and_inputs_are_enforced() {
    let unconverged = refusal(
        6.,
        &Settings {
            max_passes: 2,
            ..SETTINGS
        },
    );
    assert!(unconverged.contains("did not converge"), "{unconverged}");
    let strict = refusal(
        6.,
        &Settings {
            eos_row_bound: 1e-300,
            ..SETTINGS
        },
    );
    assert!(strict.contains("EOS rows are not at round-off"), "{strict}");
    let wide = refusal(
        6.,
        &Settings {
            level_match_m: 1.,
            ..SETTINGS
        },
    );
    assert!(wide.contains("half of every PZR region height"), "{wide}");
    let roof = match prepare(
        &packet(),
        Analytic,
        &OperatingPoint {
            pzr_roof_elevation_m: 21.,
            ..point(6.)
        },
        &[RUNNING],
        &SETTINGS,
    ) {
        Err(Failure::Fatal(m)) => m,
        _ => panic!("roof above the PZR was accepted"),
    };
    assert!(roof.contains("lies in no PZR region"), "{roof}");
    assert!(
        prepare(
            &packet(),
            Analytic,
            &OperatingPoint {
                pzr_roof_pressure_pa: f64::NAN,
                ..point(6.)
            },
            &[RUNNING],
            &SETTINGS
        )
        .is_err()
    );
    for rotors in [&[][..], &[RUNNING, RUNNING][..]] {
        match prepare(&packet(), Analytic, &point(6.), rotors, &SETTINGS) {
            Err(Failure::Fatal(m)) => assert!(m.contains("rotor states declared"), "{m}"),
            _ => panic!("{} rotor states were accepted", rotors.len()),
        }
    }
}

#[test]
fn declared_rotor_states_are_evaluated_without_touching_angular_momentum() {
    let (_, authored) = Network::new(&packet(), Analytic).unwrap();
    let locked = RotorState {
        support: Support::Unsupported,
        shaft: Shaft::Locked,
    };
    let (network, prepared, receipt) =
        prepare(&packet(), Analytic, &point(6.), &[locked], &SETTINGS).unwrap();
    let index = network.rotor_index[0];
    assert_eq!(prepared.y[index].to_bits(), authored.y[index].to_bits());
    assert_eq!(
        prepared.differential[index], 0.,
        "a locked speed row is algebraic"
    );
    assert_eq!(network.rotor_state(0), Some(locked));
    assert_eq!(receipt.rotor_states, [format!("{:?}", Some(locked))]);
    let rotor = receipt
        .initial_rows
        .iter()
        .find(|c| c.class == "rotor")
        .unwrap();
    assert_eq!(rotor.row, index);
    assert!(
        rotor.max_abs > 0.,
        "the compiled speed is not the locked omega = 0"
    );
}

/// Structural admission of the actual compiled packet with the synthetic
/// analytic chart (not IF97 values): the level is the packet's own authored
/// PZR phase boundary and the roof is its top at the authored top pressure.
#[test]
#[ignore = "requires LD01_OPERATING_HOT_SPINE_PACKET; structural only"]
fn actual_packet_admits_a_sharp_preparation_at_its_authored_boundary() {
    let path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET").unwrap();
    let packet: Packet = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let regions = &packet.pzr.regions;
    let datum = regions
        .iter()
        .map(|r| r.bottom_m)
        .fold(f64::INFINITY, f64::min);
    let boundary = regions
        .iter()
        .filter(|r| r.initial_phase == "liquid")
        .map(|r| r.top_m)
        .fold(f64::NEG_INFINITY, f64::max);
    let top = regions
        .iter()
        .max_by(|a, b| a.top_m.total_cmp(&b.top_m))
        .unwrap();
    let declared = OperatingPoint {
        pzr_roof_pressure_pa: top.common_pressure_pa,
        pzr_roof_elevation_m: top.top_m,
        pzr_level_m: boundary - datum,
    };
    let rotors = vec![
        RUNNING;
        packet
            .hydraulics
            .sections
            .iter()
            .filter(|s| s.parameters.pump.is_some())
            .count()
    ];
    let (_, _, receipt) = prepare(&packet, Analytic, &declared, &rotors, &SETTINGS)
        .unwrap_or_else(|e| panic!("{e:?}"));
    let loops: Vec<(usize, f64)> = receipt
        .faces
        .iter()
        .filter(|f| !f.tree)
        .map(|f| (f.face, f.largest_pa))
        .collect();
    println!(
        "{}",
        serde_json::json!({"packet":path,"declared":declared,"interface_m":receipt.interface_elevation_m,"root":receipt.root_region,"passes":receipt.pass_changes_pa,"max_eos_row":receipt.max_eos_row,"max_tree_face_pa":receipt.max_tree_face_pa,"loop_faces_pa":loops,"initial_rows":receipt.initial_rows})
    );
    assert_eq!(
        receipt
            .regions
            .iter()
            .filter(|r| r.phase != r.authored_phase)
            .count(),
        0
    );
}

#[test]
fn preparation_is_bitwise_deterministic() {
    let (_, a, ra) = prepared(6.);
    let (_, b, rb) = prepared(6.);
    let bits = |y: &[f64]| y.iter().map(|v| v.to_bits()).collect::<Vec<_>>();
    assert_eq!(bits(&a.y), bits(&b.y));
    assert_eq!(ra, rb);
}
