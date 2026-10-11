//! Hydrostatic preparation checks on a synthetic packet and an analytic
//! two-branch property model that exist only in this file. Neither is LD-01
//! plant data, a water formulation or qualification evidence.
use leitbild_operating_plant::{
    hydraulics::{Pump as Impeller, Section, WallLaw},
    local_flow::{MomentumSupport, PressureSegment},
    network::{
        Band, BandReport, ConsistentSystem, Failure, MetastableBand, Network, Properties,
        PzrPreparation, RotorState, Water, consistent_rates, consistent_start,
        packet::*,
        prepare::{OperatingPoint, Receipt, Settings, prepare},
        stratified::{Band as FreeArea, Heaters, Metastable, PortKind, Stratified, Tap},
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
    pressure_range_pa: [2e6, 16e6],
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
/// Free-area integral of the fixture's PZR cell: 1 m at 2.9 m2, 9 m at 3 m2.
const PZR_VOLUME: f64 = 29.9;

fn surge_port() -> PzrPort {
    PzrPort {
        id: "PZR.SURGE.MOUTH".into(),
        kind: PortKind::Surge,
        elevation_m: 10.,
        face: Some(5),
        bore_m: 0.25,
        relief: None,
    }
}

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
        volume_m3: PZR_VOLUME,
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
                fluid_volume_m3: PZR_VOLUME,
                free_area: vec![
                    FreeArea {
                        from_m: 10.,
                        to_m: 11.,
                        area_m2: 2.9,
                    },
                    FreeArea {
                        from_m: 11.,
                        to_m: 20.,
                        area_m2: 3.,
                    },
                ],
                ports: vec![surge_port()],
                taps: [("PT1", 20.), ("LT.LOW", 10.), ("LT.HIGH", 20.)]
                    .map(|(id, elevation_m)| Tap {
                        id: id.into(),
                        elevation_m,
                    })
                    .to_vec(),
                heaters: Heaters {
                    bottom_m: 10.,
                    top_m: 11.,
                    displacement_m3: 0.1,
                },
                stratified: Stratified {
                    withdrawal_scale_m: 0.25,
                    admitted_preparation_thickness_m: 0.25,
                    inversion_exchange_velocity_m_s: 300.,
                    liquid_relaxation_time_s: 0.3,
                    vapor_relaxation_time_s: 0.5,
                    relaxation_sensitivity: [0.5, 1., 2.],
                    bubble_diameter_m: 0.00075,
                    spray_drop_diameter_m: 0.003,
                    drop_diameter_sensitivity_m: [0.0015, 0.003, 0.006],
                    resolvability_factor: 1000.,
                },
                metastable: Metastable {
                    pressure_range_pa: BAND.pressure_range_pa,
                    lower_bound_exclusive: BAND.lower_bound_exclusive,
                    liquid_superheat_max_k: BAND.liquid_superheat_max_k,
                    vapor_subcooling_max_k: BAND.vapor_subcooling_max_k,
                    trial_max_k: BAND.trial_max_k,
                    credited_max_k: BAND.credited_max_k,
                    liquid_temperature_max_k: BAND.liquid_temperature_max_k,
                    liquid_pressure_ceiling_pa: BAND.liquid_pressure_ceiling_pa,
                    vapor_pressure_ceiling_pa: BAND.vapor_pressure_ceiling_pa,
                },
                absorber_mass_fraction: TRACER_PER_KG,
                interfacial_length_m: 0.003,
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
const CONTROLS: PzrPreparation = PzrPreparation {
    pressure_tolerance_pa: SETTINGS.pressure_tolerance_pa,
    max_passes: SETTINGS.max_passes,
};
fn compile(packet: &Packet) -> String {
    fatal(Network::new(packet, Analytic, &CONTROLS))
}

fn prepared(level: f64) -> (Network<Analytic>, Vec<f64>, Receipt) {
    let (network, prepared, receipt) =
        prepare(&packet(), Analytic, &point(level), &[RUNNING], &SETTINGS)
            .unwrap_or_else(|e| panic!("{e:?}"));
    (network, prepared.y, receipt)
}

#[test]
fn the_network_compiles_and_prepares_the_stratified_cell() {
    let (network, prepared) = Network::new(&packet(), Analytic, &CONTROLS).unwrap();
    // 5 regular cells, one 17-coordinate PZR, 6 faces of two paths, 1 rotor.
    assert_eq!(network.dimension(), 5 * 6 + 17 + 6 * 2 + 1);
    let algebraic = prepared.differential.iter().filter(|v| **v == 0.).count();
    assert_eq!(algebraic, 5 + 6);
    let pzr = network.pzr.coordinates();
    assert!(
        prepared.differential[pzr.start..pzr.start + 6]
            .iter()
            .all(|v| *v == 0.)
    );
    assert!(
        prepared.differential[pzr.start + 6..pzr.end]
            .iter()
            .all(|v| *v == 1.)
    );
    // Every prepared zone volume, mass, energy and roof pressure is y = 1.
    for offset in [0, 1, 2, 3, 6, 7, 8, 9, 11, 12] {
        assert_eq!(prepared.y[pzr.start + offset], 1., "offset {offset}");
    }
}

#[test]
fn hydrostatic_preparation_is_at_rest_and_reconstructs_the_cell_exactly() {
    let (network, y, receipt) = prepared(6.);
    assert!(receipt.max_eos_row <= 1e-14, "{}", receipt.max_eos_row);
    assert!(
        receipt.max_tree_rest_pa <= 1e-7,
        "{}",
        receipt.max_tree_rest_pa
    );
    let port = &receipt.faces[5];
    assert!(port.tree && port.rest_pa.abs() <= 1e-7, "{port:?}");
    assert_eq!(receipt.root_region, SURGE);
    let pzr = &receipt.pzr;
    assert!(
        pzr["representation_steps"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s.as_u64() == Some(0))
    );
    assert!(
        pzr["specific_energy_exact"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s.as_bool() == Some(true))
    );
    assert_eq!(pzr["mixture_level_m"].as_f64(), Some(6.));
    // The algebraic rows hold exactly. The stock rows are not at rest here:
    // this analytic chart's u(T) is not a consistent EOS with rho(p, T), so
    // its deeper liquid reads as superheated and relaxes; maintained IF97
    // gives round-off on the actual packet.
    let algebraic = receipt
        .initial_rows
        .iter()
        .find(|c| c.class == "pzr pressure and volume")
        .unwrap();
    assert!(algebraic.max_abs <= 1e-12, "{}", algebraic.max_abs);
    let (inventory, _) = network
        .inventory(
            &y,
            leitbild_operating_plant::network::Tolerances {
                relative: 1e-6,
                absolute: &vec![1e-8; y.len()],
            },
        )
        .unwrap();
    assert!(inventory[0] > 0. && inventory[1] > 0.);
}

#[test]
fn preparation_is_bitwise_deterministic() {
    let (_, a, ra) = prepared(6.);
    let (_, b, rb) = prepared(6.);
    let bits = |y: &[f64]| y.iter().map(|v| v.to_bits()).collect::<Vec<_>>();
    assert_eq!(bits(&a), bits(&b));
    assert_eq!(ra, rb);
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
    ports.pzr.cell.ports.push(surge_port());
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

#[test]
fn the_network_constraints_are_autonomous() {
    let (mut network, prepared, _) =
        prepare(&packet(), Analytic, &point(6.), &[RUNNING], &SETTINGS).unwrap();
    // The algebraic rows (EOS and volume rows) carry no time: the same state
    // evaluates them bitwise equal at different t, so dg/dt = 0.
    network
        .evaluate(0., &prepared.y, &prepared.yp, None, 0., None)
        .unwrap();
    let at_zero: Vec<u64> = network.rows().iter().map(|r| r.value.to_bits()).collect();
    network
        .evaluate(123.4, &prepared.y, &prepared.yp, None, 0., None)
        .unwrap();
    for (i, r) in network.rows().iter().enumerate() {
        if prepared.differential[i] == 0. {
            assert_eq!(r.value.to_bits(), at_zero[i], "row {i}");
        }
    }
}

/// A small index-1 system shaped like the PZR rows: the algebraic rate z'
/// enters a differential row, as V_k' enters the zone energy rows.
/// x' + 3 z' - (2 - x) = 0, w' - x z = 0, g = z - x w / 2 = 0.
struct Toy;
impl ConsistentSystem for Toy {
    fn system_dimension(&self) -> usize {
        3
    }
    fn rows_at(&mut self, _: f64, y: &[f64], yp: &[f64]) -> Result<Vec<f64>, Failure> {
        let (x, w, z) = (y[0], y[1], y[2]);
        Ok(vec![
            yp[0] + 3. * yp[2] - (2. - x),
            yp[1] - x * z,
            z - x * w / 2.,
        ])
    }
    fn pencil_at(&mut self, _: f64, y: &[f64], _: &[f64]) -> Result<(Vec<f64>, Vec<f64>), Failure> {
        let (x, w, z) = (y[0], y[1], y[2]);
        // Column-major dF/dy and dF/dy'.
        let a = vec![1., -z, -w / 2., 0., 0., -x / 2., 0., -x, 1.];
        let b = vec![1., 0., 0., 0., 1., 0., 3., 0., 0.];
        Ok((a, b))
    }
}

#[test]
fn the_exact_consistent_rate_solve_takes_algebraic_rates_from_the_constraints() {
    let (x, w) = (0.5, 2.);
    let y = [x, w, x * w / 2.];
    let ids = [1., 1., 0.];
    let (yp, pair) = consistent_rates(&mut Toy, 0., &y, &ids, 1e-12, 2).unwrap();
    // Exact: w' = x z; z' = (x' w + x w')/2; x' = 2 - x - 3 z'.
    let wp = x * y[2];
    let xp = (2. - x - 1.5 * x * wp) / (1. + 1.5 * w);
    let zp = (xp * w + x * wp) / 2.;
    for (got, want) in yp.iter().zip([xp, wp, zp]) {
        assert!((got - want).abs() <= 1e-15, "{yp:?}");
    }
    assert_eq!(pair.passes, 1, "linear in y': one pass is exact");
    assert!(pair.residual.value <= 1e-15 && pair.constraint_rate.value <= 1e-15);
    // A state off its constraint refuses, naming the row.
    match consistent_rates(&mut Toy, 0., &[x, w, 0.6], &ids, 1e-12, 2) {
        Err(Failure::Fatal(m)) => assert!(m.contains("algebraic row 2"), "{m}"),
        other => panic!("{other:?}"),
    }
    // The projection is a bitwise no-op on an exact state, removes Newton
    // slack inside the error scale, and refuses a larger correction.
    let weights: Vec<f64> = y.iter().map(|v| 1. / (1e-5 * v.abs() + 1e-8)).collect();
    let mut exact = y;
    let (_, start) = consistent_start(&mut Toy, 0., &mut exact, &ids, &weights, 1e-12, 2).unwrap();
    assert_eq!(exact.map(f64::to_bits), y.map(f64::to_bits));
    assert_eq!(start.projection.as_ref().unwrap().passes, 0);
    let mut slack = [x, w, y[2] + 1e-9];
    let (rates, start) =
        consistent_start(&mut Toy, 0., &mut slack, &ids, &weights, 1e-12, 2).unwrap();
    let projection = start.projection.unwrap();
    assert_eq!(
        [slack[0], slack[1]].map(f64::to_bits),
        [x, w].map(f64::to_bits)
    );
    assert!((slack[2] - y[2]).abs() <= 1e-15 && projection.correction_wrms <= 1.);
    assert!((rates[2] - zp).abs() <= 1e-15);
    let mut unconverged = [x, w, y[2] + 1e-3];
    match consistent_start(&mut Toy, 0., &mut unconverged, &ids, &weights, 1e-12, 2) {
        Err(Failure::Fatal(m)) => assert!(m.contains("error scale") && m.contains("row 2"), "{m}"),
        other => panic!("{other:?}"),
    }
}
