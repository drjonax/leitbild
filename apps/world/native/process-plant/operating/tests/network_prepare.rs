//! Hydrostatic preparation checks on a synthetic packet and an analytic
//! two-branch property model that exist only in this file. Neither is LD-01
//! plant data, a water formulation or qualification evidence.
use leitbild_operating_plant::{
    hydraulics::{Pump as Impeller, Section, WallLaw},
    local_flow::{MomentumSupport, PressureSegment},
    network::{
        Band, BandReport, Failure, MetastableBand, Network, Properties, PzrPreparation, RotorState,
        Water,
        packet::*,
        prepare::{OperatingPoint, Settings, prepare},
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
    fn metastable_band(&self) -> Result<MetastableBand, String> {
        Ok(BAND)
    }
    /// The fixture's caloric point carries no branch, so its departure is
    /// read against the liquid side only; it is never used by these tests.
    fn band(&self, point: &Water) -> BandReport {
        let departure_k = point.temperature_k - saturation_temperature(point.pressure_pa);
        BandReport {
            departure_k,
            band: if departure_k <= 0. {
                Band::Stable
            } else if departure_k <= BAND.liquid_superheat_max_k {
                Band::Admitted {
                    credited: departure_k <= BAND.credited_max_k,
                }
            } else {
                Band::Exceeded
            },
        }
    }
}

/// Synthetic band shared by the fixture properties and packet.
const BAND: MetastableBand = MetastableBand {
    pressure_range_pa: [10e6, 16e6],
    lower_bound_exclusive: true,
    liquid_superheat_max_k: 2.,
    vapor_subcooling_max_k: 1.4,
    trial_max_k: 3.,
    credited_max_k: 0.5,
    liquid_temperature_max_k: 623.15,
    liquid_pressure_ceiling_pa: 17e6,
    vapor_pressure_ceiling_pa: 16e6,
};

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
/// pump section) at nonuniform temperature, a SURGE line volume and the one
/// stratified PZR cell (10..20 m, uniform 3 m2). Face 5 is the port face:
/// SURGE supports and segments only, ending at the 10 m mouth.
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
    regions.push(Region {
        id: "PZR".into(),
        volume_m3: 30.,
        elevation_m: 20.,
    });
    let surge_water = liquid(AUTHORED_PA, 605.);
    let surge_mass = 0.8 * surge_water.density_kg_m3;
    let faces = vec![
        face("CORE->HOT".into(), 0, 1, 0.5, [(3., 3.), (3., 3.)]),
        face("HOT->SG".into(), 1, 2, 0.5, [(4., 1.), (4., 1.)]),
        face("SG->COLD".into(), 2, 3, 0.5, [(4., -3.5), (4., -3.5)]),
        face("COLD->CORE".into(), 3, 0, 0.3, [(2., -0.5), (2., -0.5)]),
        face("HOT->SURGE".into(), 1, SURGE, 0.05, [(2., 1.5), (2., 1.5)]),
        FacePacket {
            id: "SURGE->PZR.SURGE.MOUTH".into(),
            from: SURGE,
            to: PZR,
            flow_area_m2: 0.05,
            supports: vec![support(SURGE, 2., 0.05)],
            pressure_segments: vec![segment(SURGE, 2., 1.)],
        },
    ];
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
            cell: PzrCell {
                index: PZR,
                bottom_m: 10.,
                top_m: 20.,
                fluid_volume_m3: 30.,
                ports: vec![PzrPort {
                    id: "PZR.SURGE.MOUTH".into(),
                    kind: "surge".into(),
                    elevation_m: 10.,
                    face: 5,
                    bore_m: 0.25,
                }],
                metastable: BAND,
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

fn fatal<T>(result: Result<T, Failure>) -> String {
    match result {
        Err(Failure::Fatal(message)) => message,
        Err(other) => panic!("unexpected failure class {other:?}"),
        Ok(_) => panic!("not refused"),
    }
}
fn compile(packet: &Packet) -> String {
    fatal(Network::new(
        packet,
        Analytic,
        &PzrPreparation {
            pressure_tolerance_pa: SETTINGS.pressure_tolerance_pa,
            max_passes: SETTINGS.max_passes,
        },
    ))
}

#[test]
fn network_and_preparation_refuse_at_the_stratified_integration_point() {
    let message = compile(&packet());
    assert!(
        message.contains("stratified PZR cell not integrated"),
        "{message}"
    );
    let prepared = fatal(prepare(
        &packet(),
        Analytic,
        &point(6.),
        &[RUNNING],
        &SETTINGS,
    ));
    assert!(
        prepared.contains("stratified PZR cell not integrated"),
        "{prepared}"
    );
}

#[test]
fn compile_refuses_a_misplaced_pzr_cell_port_or_force() {
    let mut last = packet();
    last.pzr.cell.index = SURGE;
    assert!(compile(&last).contains("last compiled region"));
    let mut volume = packet();
    volume.pzr.cell.fluid_volume_m3 = 29.;
    assert!(compile(&volume).contains("last compiled region"));
    let mut force = packet();
    force.mechanics.force_projection.push(FaceProjection {
        face: 5,
        region: PZR,
        coefficient_per_m2: 0.1,
        normal: [0., 1.],
    });
    assert!(compile(&force).contains("force projection refuses"));
    let mut band = packet();
    band.pzr.cell.metastable.credited_max_k = 0.6;
    assert!(compile(&band).contains("compiled band"));
    let mut ports = packet();
    let extra = PzrPort {
        id: "PZR.SPRAY".into(),
        kind: "spray".into(),
        elevation_m: 19.,
        face: 5,
        bore_m: 0.1,
    };
    ports.pzr.cell.ports.push(extra);
    assert!(compile(&ports).contains("exactly one port"));
    let mut reverse = packet();
    let f = &mut reverse.mechanics.faces[5];
    (f.from, f.to) = (PZR, SURGE);
    assert!(compile(&reverse).contains("port face"));
    let mut supported = packet();
    supported.mechanics.faces[5]
        .supports
        .push(support(PZR, 0.5, 3.));
    assert!(compile(&supported).contains("SURGE supports and segments only"));
    let mut second = packet();
    second
        .mechanics
        .faces
        .push(face("SG->PZR".into(), 2, PZR, 0.05, [(1., 1.), (1., 1.)]));
    assert!(compile(&second).contains("port face"));
}

#[test]
fn the_declared_point_must_match_the_compiled_cell() {
    let refused = |point: &OperatingPoint, settings: &Settings| {
        fatal(prepare(&packet(), Analytic, point, &[RUNNING], settings))
    };
    for level in [0., -0.5, 10., 10.5] {
        let outside = refused(&point(level), &SETTINGS);
        assert!(outside.contains("outside the PZR"), "{outside}");
    }
    for declared in [
        OperatingPoint {
            pzr_bottom_elevation_m: 9.9,
            ..point(6.)
        },
        OperatingPoint {
            pzr_roof_elevation_m: 19.,
            ..point(6.)
        },
    ] {
        let datum = refused(&declared, &SETTINGS);
        assert!(datum.contains("differ from the compiled cell"), "{datum}");
    }
    let nan = refused(
        &OperatingPoint {
            pzr_roof_pressure_pa: f64::NAN,
            ..point(6.)
        },
        &SETTINGS,
    );
    assert!(nan.contains("invalid operating point"), "{nan}");
    for bound in [0., -1., f64::NAN] {
        let invalid = refused(
            &point(6.),
            &Settings {
                eos_row_bound: bound,
                ..SETTINGS
            },
        );
        assert!(invalid.contains("invalid settings"), "{invalid}");
    }
}
