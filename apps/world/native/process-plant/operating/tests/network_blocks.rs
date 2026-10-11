//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#6-solver-properties-and-cost-obligations
//! The block stage-Jacobian assembly against the colored assembly on a
//! synthetic packet with an analytic, exactly differentiable two-branch
//! property model, both of which exist only in this file. The packet is
//! `network_prepare.rs`'s synthetic loop, copied. Neither is LD-01 plant
//! data, a water formulation or qualification evidence.
use leitbild_operating_plant::{
    hydraulics::{Pump as Impeller, Section, WallLaw},
    local_flow::{self as flow, MomentumSupport, PressureSegment},
    network::{
        Band, BandReport, MetastableBand, Network, Properties, RotorState, Water,
        packet::*,
        prepare::{OperatingPoint, Settings, prepare},
        stratified::{Band as FreeArea, Heaters, Metastable, PortKind, Stratified, Tap},
    },
    rotor::{Shaft, SpeedRequest, Support},
    sparse::Pattern,
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
/// Exact directional derivative of every field along (dp, dT).
fn along(vapor_branch: bool, w: &Water, dp: f64, dt: f64) -> Water {
    let (p, t, rho) = (w.pressure_pa, w.temperature_k, w.density_kg_m3);
    if vapor_branch {
        let drho = dp / (R * t) - p * dt / (R * t * t);
        Water {
            pressure_pa: dp,
            temperature_k: dt,
            density_kg_m3: drho,
            internal_energy_j_kg: CV * dt,
            enthalpy_j_kg: (CV + R) * dt,
            cp_j_kg_k: 0.,
            expansion_per_k: -dt / (t * t),
            compressibility_per_pa: -dp / (p * p),
            viscosity_pa_s: 0.,
            conductivity_w_m_k: 0.,
        }
    } else {
        let drho = rho * (KAPPA * dp - BETA * dt);
        Water {
            pressure_pa: dp,
            temperature_k: dt,
            density_kg_m3: drho,
            internal_energy_j_kg: CL * dt,
            enthalpy_j_kg: CL * dt + dp / rho - p * drho / (rho * rho),
            cp_j_kg_k: BETA * dp / rho - p * BETA * drho / (rho * rho),
            expansion_per_k: 0.,
            compressibility_per_pa: 0.,
            viscosity_pa_s: 0.,
            conductivity_w_m_k: 0.,
        }
    }
}
fn saturation_temperature(p: f64) -> f64 {
    1. / (1. / TSAT0 - R / LATENT * (p / P0).ln())
}

/// Differentiable test properties on internal-energy targets.
#[derive(Clone, Copy)]
struct Analytic;
impl Properties for Analytic {
    /// The branch and the forward point.
    type Caloric = (bool, Water);
    fn forward(&self, vapor_branch: bool, p: f64, t: f64) -> Result<Water, String> {
        Ok(if vapor_branch {
            vapor(p, t)
        } else {
            liquid(p, t)
        })
    }
    fn caloric(
        &self,
        vapor_branch: bool,
        p: f64,
        u: f64,
        enthalpy: bool,
    ) -> Result<(bool, Water), String> {
        if enthalpy || !(p.is_finite() && p > 0. && u.is_finite()) {
            return Err("outside the analytic fixture".into());
        }
        let t = if vapor_branch {
            T0 + (u - U0V) / CV
        } else {
            T0 + (u - U0L) / CL
        };
        Ok((vapor_branch, self.forward(vapor_branch, p, t)?))
    }
    fn values(&self, point: &(bool, Water)) -> Water {
        point.1
    }
    fn direction(&self, point: &(bool, Water), dp: f64, du: f64) -> Result<Water, String> {
        let dt = du / if point.0 { CV } else { CL };
        Ok(along(point.0, &point.1, dp, dt))
    }
    fn saturation(&self, pressure: Scalar) -> Result<Saturation, String> {
        let p = pressure.value;
        let t = saturation_temperature(p);
        let dp = pressure.direction;
        let dt = t * t * R / LATENT / p * dp;
        let point = |vapor_branch: bool| {
            let w = if vapor_branch {
                vapor(p, t)
            } else {
                liquid(p, t)
            };
            let d = along(vapor_branch, &w, dp, dt);
            let f = Scalar::new;
            WaterPoint {
                density: f(w.density_kg_m3, d.density_kg_m3),
                viscosity: f(w.viscosity_pa_s, d.viscosity_pa_s),
                conductivity: f(w.conductivity_w_m_k, d.conductivity_w_m_k),
                cp: f(w.cp_j_kg_k, d.cp_j_kg_k),
                expansion: f(w.expansion_per_k, d.expansion_per_k),
                enthalpy: f(w.enthalpy_j_kg, d.enthalpy_j_kg),
            }
        };
        Ok(Saturation {
            temperature: Scalar::new(t, dt),
            liquid: point(false),
            vapor: point(true),
            surface_tension: Scalar::constant(4e-3),
        })
    }
    fn metastable_band(&self) -> Result<MetastableBand, String> {
        Ok(BAND)
    }
    fn band(&self, point: &(bool, Water)) -> BandReport {
        let departure_k = point.1.temperature_k - saturation_temperature(point.1.pressure_pa);
        BandReport {
            departure_k,
            band: Band::Stable,
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
                    bubble_exchange_sensitivity: [0.5, 1., 2.],
                    bubble_exchange_diameter_sensitivity_m: 0.0005,
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
fn prepared() -> (Network<Analytic>, Vec<f64>, Vec<f64>) {
    let point = OperatingPoint {
        pzr_level_m: 6.,
        ..OperatingPoint::from(&packet().preparation.operating_point)
    };
    let (network, prepared, _) = prepare(&packet(), Analytic, &point, &[RUNNING], &SETTINGS)
        .unwrap_or_else(|e| panic!("{e:?}"));
    (network, prepared.y, prepared.yp)
}

/// Largest |block - colored| over each column's largest entry.
fn column_relative(pattern: &Pattern, a: &[f64], b: &[f64]) -> f64 {
    let mut worst = 0_f64;
    for j in 0..pattern.columns() {
        let range = pattern.pointers()[j]..pattern.pointers()[j + 1];
        let scale = range
            .clone()
            .map(|p| a[p].abs().max(b[p].abs()))
            .fold(0., f64::max);
        for p in range {
            if a[p] != b[p] {
                worst = worst.max((a[p] - b[p]).abs() / scale);
            }
        }
    }
    worst
}

/// Both assemblies at one state; returns the comparison.
fn both(network: &mut Network<Analytic>, cj: f64, y: &[f64], yp: &[f64]) -> f64 {
    let colored = network.sparse_jacobian().unwrap();
    let blocks = network.block_jacobian().unwrap();
    assert_eq!(colored.pattern, blocks.pattern);
    let mut c = vec![0.; colored.pattern.nonzeros()];
    let mut b = vec![0.; c.len()];
    network
        .jacobian_colored(0., cj, y, yp, &colored, &mut c)
        .expect("colored");
    network
        .jacobian_blocks(0., cj, y, yp, &blocks, &mut b)
        .expect("blocks");
    assert!(b.iter().all(|v| v.is_finite()));
    column_relative(&blocks.pattern, &b, &c)
}

#[test]
fn blocks_equal_the_colored_assembly_at_rest() {
    // Every impulse is exactly zero: each face takes its one-sided chart
    // along the column's seed sign.
    let (mut network, y, yp) = prepared();
    for cj in [1e-2, 10., 1e4] {
        let difference = both(&mut network, cj, &y, &yp);
        assert!(difference <= 1e-13, "cj {cj}: {difference}");
    }
}

#[test]
fn blocks_equal_the_colored_assembly_while_flowing_and_after_seizure() {
    let (mut network, mut y, _) = prepared();
    let layouts = network.face_layout.clone();
    for l in &layouts {
        if l.phase == 0 {
            // Loop flow, an outsurge at the port face, and one exactly
            // stagnant face that keeps its one-sided chart.
            y[l.index] = match l.face {
                4 => 0.,
                5 => -0.05,
                _ => 0.2,
            };
        }
    }
    let yp: Vec<f64> = (0..y.len()).map(|i| 1e-4 * ((i % 7) as f64 - 3.)).collect();
    let difference = both(&mut network, 25., &y, &yp);
    assert!(difference <= 1e-13, "flowing: {difference}");
    network.seize(0, &mut y).expect("seizure");
    let difference = both(&mut network, 25., &y, &yp);
    assert!(difference <= 1e-13, "seized: {difference}");
}

#[test]
fn a_face_chart_reads_no_inertance_rate() {
    // The block assembly reuses a column's stage-one chart for an impulse
    // row of nonzero inertance; that is exact only while chart_from_path
    // reads no inertance rate. A changed law must revisit blocks.rs.
    let (mut network, mut y, yp) = prepared();
    for l in network.face_layout.clone() {
        if l.phase == 0 {
            y[l.index] = 0.3;
        }
    }
    network.evaluate(0., &y, &yp, None, 0., None).unwrap();
    let cells: Vec<_> = (0..network.cells()).map(|i| network.cell(i)).collect();
    for f in &packet().mechanics.faces {
        let face = flow::Face {
            from: f.from,
            to: f.to,
            flow_area_m2: f.flow_area_m2,
            supports: f.supports.clone(),
            pressure_segments: f.pressure_segments.clone(),
        };
        let pi = Scalar::new(800., 1.);
        let path = |rate: f64| flow::PathKinematics {
            inertance_kg_m4: Scalar::new(4e3, 0.5),
            inertance_rate_kg_m4_s: Scalar::new(rate, rate),
            volume_flow_m3_s: pi / Scalar::new(4e3, 0.5),
        };
        let a = flow::chart_from_path(&face, &cells, 0, pi, path(0.)).unwrap();
        let b = flow::chart_from_path(&face, &cells, 0, pi, path(7.)).unwrap();
        let bits = |c: flow::Chart| {
            [
                c.inertance_kg_m4,
                c.volume_flow_m3_s,
                c.mass_flow_kg_s,
                c.enthalpy_flow_w,
                c.boron_flow_kg_s,
                c.pressure_gravity_pa,
                c.kinetic_j,
            ]
            .map(|v| (v.value.to_bits(), v.direction.to_bits()))
        };
        assert_eq!(bits(a), bits(b), "face {}", f.id);
    }
}
