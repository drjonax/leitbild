//! Hydrostatic preparation checks on a synthetic packet and an analytic
//! two-branch property model that exist only in this file. Neither is LD-01
//! plant data, a water formulation or qualification evidence.
use leitbild_operating_plant::{
    hydraulics::{Pump as Impeller, Section, WallLaw},
    local_flow::{MomentumSupport, PressureSegment},
    network::{
        Failure, Network, Prepared, Properties, RotorState, Water,
        packet::*,
        prepare::{
            OperatingPoint, PhaseState, Receipt, Settings, Stock, overwrite_stocks, prepare,
        },
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
fn liquid_density(p: f64, t: f64) -> f64 {
    liquid(p, t).density_kg_m3
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
fn face(id: String, from: usize, to: usize, area: f64, halves: [(f64, f64); 2]) -> FacePacket {
    FacePacket {
        id,
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
/// two-lane, five-band PZR (bands of 2 m from 10 to 20 m) whose bottom three
/// bands are the authored liquid. Authored pressure is flat, i.e. not rest.
/// Mechanics faces: 0..=5 primary/SURGE; band b has radial face 6+3b and,
/// below band 4, inner/outer axial faces 7+3b and 8+3b up to band b+1.
fn packet() -> Packet {
    let primary = [
        ("CORE", 20., 0., 590.),
        ("HOT", 10., 6., 610.),
        ("SG", 15., 8., 575.),
        ("COLD", 10., 1., 565.),
    ];
    let mut regions: Vec<Region> = primary
        .iter()
        .map(|(id, volume, elevation, _)| Region {
            id: (*id).into(),
            volume_m3: *volume,
            elevation_m: *elevation,
        })
        .collect();
    let water: Vec<WaterOwner> = primary
        .iter()
        .map(|(_, volume, _, t)| {
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
        elevation_m: 9.,
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
                elevation_m: bottom + 1.,
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
        face("CORE->HOT".into(), 0, 1, 0.5, [(3., 3.), (3., 3.)]),
        face("HOT->SG".into(), 1, 2, 0.5, [(4., 1.), (4., 1.)]),
        face("SG->COLD".into(), 2, 3, 0.5, [(4., -3.5), (4., -3.5)]),
        face("COLD->CORE".into(), 3, 0, 0.3, [(2., -0.5), (2., -0.5)]),
        face("HOT->SURGE".into(), 1, SURGE, 0.05, [(2., 1.5), (2., 1.5)]),
        face(
            "SURGE->PZR".into(),
            SURGE,
            PZR + 1,
            0.05,
            [(1., 1.), (1., 1.)],
        ),
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
            id: format!("PZR.RADIAL.{band}"),
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
                    format!("PZR.AXIAL.{band}.{lane}"),
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
        preparation: Preparation {
            operating_point: leitbild_operating_plant::network::packet::OperatingPoint {
                pzr_roof_pressure_pa: 15.5e6,
                pzr_roof_elevation_m: 20.,
                pzr_level_m: 6.,
                pzr_bottom_elevation_m: 10.,
                rcp_speed_request: "nominal".into(),
            },
        },
    }
}

/// The packet's declared point with another indicated level.
fn point(level: f64) -> OperatingPoint {
    OperatingPoint {
        pzr_level_m: level,
        ..OperatingPoint::from(&packet().preparation.operating_point)
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
    representation_search: 4,
};

fn prepared(level: f64) -> (Network<Analytic>, Prepared, Receipt) {
    prepare(&packet(), Analytic, &point(level), &[RUNNING], &SETTINGS)
        .unwrap_or_else(|e| panic!("{e:?}"))
}
fn refused(point: &OperatingPoint, settings: &Settings) -> String {
    match prepare(&packet(), Analytic, point, &[RUNNING], settings) {
        Err(Failure::Fatal(message)) => message,
        Err(other) => panic!("unexpected failure class {other:?}"),
        Ok(_) => panic!("{point:?} was not refused"),
    }
}
fn mass(r: &leitbild_operating_plant::network::prepare::RegionReceipt) -> f64 {
    r.phases.iter().flatten().map(|p| p.mass_kg).sum()
}
fn phase(receipt: &Receipt, region: usize, k: usize) -> PhaseState {
    receipt.regions[region].phases[k].unwrap_or_else(|| panic!("region {region} lacks phase {k}"))
}

/// Independent rest residual `p_from - p_to - g sum(rho_mix dz)` from the
/// receipt's prepared stocks, with rho_mix = total mass / V.
fn rest_residuals(packet: &Packet, receipt: &Receipt) -> Vec<f64> {
    let density: Vec<f64> = receipt
        .regions
        .iter()
        .zip(&packet.mechanics.regions)
        .map(|(r, region)| mass(r) / region.volume_m3)
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
            receipt.regions[f.from].pressure_pa - receipt.regions[f.to].pressure_pa - head
        })
        .collect()
}

/// Round-off checks common to every prepared state.
fn at_rest(packet: &Packet, receipt: &Receipt) -> Vec<f64> {
    assert!(receipt.max_eos_row <= 1e-14, "{}", receipt.max_eos_row);
    assert!(
        receipt.max_tree_rest_pa <= 1e-7,
        "{}",
        receipt.max_tree_rest_pa
    );
    let rest = rest_residuals(packet, receipt);
    for f in &receipt.faces {
        assert!((f.rest_pa - rest[f.face]).abs() <= 1e-7, "face {}", f.face);
        if f.face != 2 {
            assert!(
                rest[f.face].abs() <= 1e-7,
                "face {} rest {}",
                f.face,
                rest[f.face]
            );
        }
    }
    for r in &receipt.regions {
        for p in r.phases.iter().flatten() {
            if r.region > SURGE {
                assert!(p.saturation_margin_k.unwrap().abs() <= 1e-9);
            }
        }
        let volume: f64 = r.phases.iter().flatten().map(|p| p.volume_m3).sum();
        let v = packet.mechanics.regions[r.region].volume_m3;
        assert!((volume - v).abs() <= 1e-14 * v);
    }
    rest
}

#[test]
fn sharp_hydrostatic_rest_at_a_boundary_level() {
    let packet = packet();
    let (network, prepared, receipt) = prepared(6.);
    println!("{}", serde_json::to_string(&receipt).unwrap());
    assert_eq!(
        (receipt.surface_elevation_m, receipt.on_boundary),
        (16., true)
    );
    assert_eq!(receipt.root_region, PZR + 8);
    let passes = &receipt.pass_changes_pa;
    assert!(passes.len() >= 3 && *passes.last().unwrap() <= SETTINGS.pressure_tolerance_pa);
    assert!(
        passes
            .windows(2)
            .all(|w| w[1] < 1e-2 * w[0] || w[1] <= 1e-6)
    );
    let rest = at_rest(&packet, &receipt);
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
    // A sharp interface leaves every phase path at rest except the primary
    // loop, which keeps its buoyancy drive -g*sum(rho dz) around the loop.
    for f in &receipt.faces {
        for term in f.pressure_gravity_pa.iter().flatten() {
            assert!(f.face == 2 || term.abs() <= 1e-7, "face {} {term}", f.face);
        }
    }
    let drive = receipt.faces[2].pressure_gravity_pa[0].unwrap();
    assert_eq!(receipt.faces[2].pressure_gravity_pa[1], None);
    assert!(drive > 4e3, "{drive}");
    assert!((drive - rest[2]).abs() <= 1e-9 * drive);
    let closed: f64 = [0, 1, 2, 3].iter().map(|&j| rest[j]).sum();
    assert!((closed - drive).abs() <= 1e-7);
    assert_eq!(receipt.max_loop_rest_pa, receipt.faces[2].rest_pa.abs());

    // Phases, preserved specific energy and concentration.
    for r in &receipt.regions {
        if r.region <= SURGE {
            assert_eq!(r.vapor_fraction, 0.);
            let liquid = r.phases[0].unwrap();
            let before = r.before.internal_energy_j / r.before.mass_kg;
            let after = liquid.internal_energy_j / liquid.mass_kg;
            assert!((after - before).abs() <= 1e-15 * before);
            assert!((liquid.temperature_k - r.before.temperature_k).abs() <= 1e-9);
            assert!((r.tracer_kg_eq / liquid.mass_kg - TRACER_PER_KG).abs() <= 1e-15);
        } else {
            let band = (r.region - PZR) / 2;
            let vapor = band >= 3;
            assert_eq!(r.vapor_fraction, if vapor { 1. } else { 0. });
            assert_eq!(usize::from(vapor), r.authored_phase);
            assert!(r.phases[usize::from(!vapor)].is_none());
        }
    }
    let root = &receipt.regions[PZR + 8];
    let rho = mass(root) / 2.;
    assert!((root.pressure_pa - 15.5e6 - rho * G).abs() <= 1e-8);
    for band in 0..5 {
        let [a, b] = [0, 1].map(|lane| receipt.regions[PZR + 2 * band + lane].pressure_pa);
        assert_eq!(a, b);
    }
    // The 20 m column from the roof to the core lies between all-vapor and
    // all-liquid columns of the prepared densities.
    let core = receipt.regions[0].pressure_pa;
    let densities: Vec<f64> = receipt
        .regions
        .iter()
        .zip(&packet.mechanics.regions)
        .map(|(r, region)| mass(r) / region.volume_m3)
        .collect();
    let [lightest, heaviest] =
        [f64::min, f64::max].map(|f| densities.iter().copied().fold(densities[0], f));
    assert!(G * 20. * lightest < core - 15.5e6 && core - 15.5e6 < G * 20. * heaviest);

    let total = |f: fn(&PhaseState) -> f64| {
        receipt
            .regions
            .iter()
            .flat_map(|r| r.phases.iter().flatten())
            .map(f)
            .sum::<f64>()
    };
    let before: f64 = receipt.regions.iter().map(|r| r.before.mass_kg).sum();
    assert!((receipt.mass_change_kg - (total(|p| p.mass_kg) - before)).abs() <= 1e-9);

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
    let scales = network.scales();
    for (node, l) in network.cell_layout.iter().enumerate() {
        let r = &receipt.regions[node];
        assert_eq!(prepared.y[l.base] * scales[l.base], r.pressure_pa);
        for k in 0..2 {
            let m = prepared.y[l.mass[k]] * scales[l.mass[k]];
            let expected = r.phases[k].map_or(0., |p| p.mass_kg);
            assert!((m - expected).abs() <= 1e-15 * m.max(1.));
        }
    }
    let class = |name: &str| {
        receipt
            .initial_rows
            .iter()
            .find(|c| c.class == name)
            .unwrap()
            .max_abs
    };
    assert_eq!(class("eos"), receipt.max_eos_row);
    assert!(
        class("impulse") > 0.,
        "the pump starts from its shutoff head"
    );
}

#[test]
fn a_level_inside_a_vapor_band_makes_that_band_two_phase() {
    let packet = packet();
    // Surface 17 m, the middle of band 3 (16..18 m), which was authored vapor.
    let (_, _, receipt) = prepared(7.);
    println!("{}", serde_json::to_string(&receipt).unwrap());
    assert_eq!(
        (receipt.surface_elevation_m, receipt.on_boundary),
        (17., false)
    );
    at_rest(&packet, &receipt);
    for lane in 0..2 {
        let node = PZR + 6 + lane;
        let r = &receipt.regions[node];
        let v = packet.mechanics.regions[node].volume_m3;
        assert_eq!((r.authored_phase, r.vapor_fraction), (1, 0.5));
        let [liquid, vapor] = [0, 1].map(|k| phase(&receipt, node, k));
        for p in [liquid, vapor] {
            assert!((p.volume_m3 - v / 2.).abs() <= 1e-14 * v);
        }
        // Saturated phases at the band's own pressure.
        let t = saturation_temperature(r.pressure_pa);
        assert!(
            (liquid.mass_kg - v / 2. * liquid_density(r.pressure_pa, t)).abs()
                <= 1e-12 * liquid.mass_kg
        );
        assert!((vapor.mass_kg - v / 2. * r.pressure_pa / (R * t)).abs() <= 1e-12 * vapor.mass_kg);
        // Liquid tracer at the concentration of the liquid band below.
        let below = &receipt.regions[node - 2];
        let c = below.tracer_kg_eq / phase(&receipt, node - 2, 0).mass_kg;
        assert!((r.tracer_kg_eq - c * liquid.mass_kg).abs() <= 1e-15 * r.tracer_kg_eq);
        // Mixture-hydrostatic lanes share the band pressure.
        assert_eq!(r.pressure_pa, receipt.regions[PZR + 6].pressure_pa);
    }
    // The mixed band keeps each phase's relative buoyancy on its axial faces,
    // f_l*f_v*(rho_l - rho_v)*g*dz for the 1 m half-segment inside the band:
    // liquid toward band 2, vapor toward band 4. Radial faces stay at rest.
    let node = PZR + 6;
    let [liquid, vapor] = [0, 1].map(|k| phase(&receipt, node, k));
    let relative = 0.25 * (liquid.mass_kg - vapor.mass_kg) / (0.5 * 2.) * G;
    for face in [13, 14, 16, 17] {
        let [l, g] = receipt.faces[face].pressure_gravity_pa.map(Option::unwrap);
        assert!(
            (l + relative).abs() <= 1e-9 * relative,
            "face {face} liquid {l}"
        );
        assert!(
            (g - relative).abs() <= 1e-9 * relative,
            "face {face} vapor {g}"
        );
    }
    for term in receipt.faces[15].pressure_gravity_pa.iter().flatten() {
        assert!(term.abs() <= 1e-7);
    }
    assert!(receipt.max_phase_drive_pa >= relative);
}

#[test]
fn the_network_reconstructs_the_prepared_saturated_states_exactly() {
    for level in [6., 7.] {
        let (network, prepared, receipt) = prepared(level);
        assert!(receipt.representation_offset <= SETTINGS.representation_search);
        let scales = network.scales();
        for (node, l) in network.cell_layout.iter().enumerate() {
            let r = &receipt.regions[node];
            let p = prepared.y[l.base] * scales[l.base];
            assert_eq!(p.to_bits(), r.pressure_pa.to_bits());
            assert_eq!(network.cell(node).pressure.value.to_bits(), p.to_bits());
            for k in 0..2 {
                let (m, u) = (
                    prepared.y[l.mass[k]] * scales[l.mass[k]],
                    prepared.y[l.energy[k]] * scales[l.energy[k]],
                );
                let Some(phase) = r.phases[k] else {
                    assert_eq!((m, u), (0., 0.));
                    continue;
                };
                assert_eq!((m, u), (phase.mass_kg, phase.internal_energy_j));
                if node > SURGE {
                    // Exactly the saturated specific energy at the network's
                    // own pressure: on the stable-branch bound, not across it.
                    let t = saturation_temperature(p);
                    let saturated = if k == 0 { liquid(p, t) } else { vapor(p, t) };
                    assert_eq!((u / m).to_bits(), saturated.internal_energy_j_kg.to_bits());
                }
            }
        }
    }
}

#[test]
fn the_stock_writer_refuses_absent_or_unrepresentable_stocks() {
    let (network, prepared, _) = prepared(6.);
    let good = Stock {
        pressure_pa: 15.5e6,
        mass_kg: [1000., 0.],
        specific_energy_j_kg: [1.5e6, 0.],
        tracer_kg_eq: 1.,
    };
    let mut stocks = vec![good; network.cells()];
    let mut y = prepared.y.clone();
    let written = overwrite_stocks(&network, &mut y, &stocks, 4).unwrap();
    assert!(written.iter().all(|w| w.pressure_pa == 15.5e6));
    for bad in [
        Stock {
            mass_kg: [0., 0.],
            ..good
        },
        Stock {
            mass_kg: [-1., 2.],
            ..good
        },
        Stock {
            specific_energy_j_kg: [1.5e6, 2.5e6],
            ..good
        },
        Stock {
            mass_kg: [0., 10.],
            specific_energy_j_kg: [0., 2.5e6],
            ..good
        },
        Stock {
            pressure_pa: 0.,
            ..good
        },
    ] {
        stocks[2] = bad;
        assert!(
            overwrite_stocks(&network, &mut y, &stocks, 4).is_err(),
            "{bad:?}"
        );
    }
    assert!(overwrite_stocks(&network, &mut y, &stocks[1..], 4).is_err());
}

#[test]
fn a_level_inside_a_liquid_band_keeps_its_own_tracer_concentration() {
    let packet = packet();
    // Surface 15 m inside band 2 (14..16 m), authored liquid.
    let (_, _, receipt) = prepared(5.);
    at_rest(&packet, &receipt);
    for node in [PZR + 4, PZR + 5] {
        let r = &receipt.regions[node];
        assert_eq!((r.authored_phase, r.vapor_fraction), (0, 0.5));
        let c = r.tracer_kg_eq / phase(&receipt, node, 0).mass_kg;
        assert!((c - TRACER_PER_KG).abs() <= 1e-15);
        assert!(receipt.regions[node + 2].phases[0].is_none());
    }
    // A level within level_match_m of a boundary is that boundary.
    let (_, _, snapped) = prepared(6. + 1e-10);
    assert!(snapped.on_boundary);
    assert_eq!(snapped.surface_elevation_m, 16.);
}

#[test]
fn boundary_levels_move_whole_bands_between_phases() {
    // Lowered: band 2 becomes vapor and its liquid tracer leaves with it.
    let (network, prepared_low, low) = prepared(4.);
    assert_eq!(low.surface_elevation_m, 14.);
    at_rest(&packet(), &low);
    for r in &low.regions[PZR + 4..PZR + 6] {
        assert_eq!(
            (r.authored_phase, r.vapor_fraction, r.tracer_kg_eq),
            (0, 1., 0.)
        );
        let l = network.cell_layout[r.region];
        assert_eq!(prepared_low.y[l.mass[0]], 0.);
        assert!(prepared_low.y[l.mass[1]] > 0.);
    }
    let dropped: f64 = low.regions[PZR + 4..PZR + 6]
        .iter()
        .map(|r| r.before.tracer_kg_eq)
        .sum();
    assert!(low.tracer_change_kg_eq < -0.9 * dropped);
    // Raised: band 3, authored vapor, becomes liquid with the band below's
    // prepared concentration.
    let (_, _, high) = prepared(8.);
    assert_eq!(high.surface_elevation_m, 18.);
    at_rest(&packet(), &high);
    for node in [PZR + 6, PZR + 7] {
        let r = &high.regions[node];
        assert_eq!((r.authored_phase, r.vapor_fraction), (1, 0.));
        let c = r.tracer_kg_eq / phase(&high, node, 0).mass_kg;
        assert!((c - TRACER_PER_KG).abs() <= 1e-15);
    }
}

#[test]
fn explicit_limits_and_inputs_are_enforced() {
    for level in [-0.5, 10.5] {
        let outside = refused(&point(level), &SETTINGS);
        assert!(outside.contains("outside the PZR"), "{outside}");
    }
    let datum = refused(
        &OperatingPoint {
            pzr_bottom_elevation_m: 9.9,
            ..point(6.)
        },
        &SETTINGS,
    );
    assert!(datum.contains("bottom datum"), "{datum}");
    let unconverged = refused(
        &point(6.),
        &Settings {
            max_passes: 2,
            ..SETTINGS
        },
    );
    assert!(unconverged.contains("did not converge"), "{unconverged}");
    let strict = refused(
        &point(7.),
        &Settings {
            eos_row_bound: 1e-300,
            ..SETTINGS
        },
    );
    assert!(strict.contains("EOS rows are not at round-off"), "{strict}");
    let wide = refused(
        &point(6.),
        &Settings {
            level_match_m: 1.,
            ..SETTINGS
        },
    );
    assert!(wide.contains("half of every PZR region height"), "{wide}");
    let roof = refused(
        &OperatingPoint {
            pzr_roof_elevation_m: 21.,
            ..point(6.)
        },
        &SETTINGS,
    );
    assert!(roof.contains("lies in no PZR region"), "{roof}");
    let nan = refused(
        &OperatingPoint {
            pzr_roof_pressure_pa: f64::NAN,
            ..point(6.)
        },
        &SETTINGS,
    );
    assert!(nan.contains("invalid operating point"), "{nan}");
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

#[test]
fn preparation_is_bitwise_deterministic() {
    for level in [6., 7.] {
        let (_, a, ra) = prepared(level);
        let (_, b, rb) = prepared(level);
        let bits = |y: &[f64]| y.iter().map(|v| v.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&a.y), bits(&b.y));
        assert_eq!(ra, rb);
    }
}
