//! The PZR shell bands and heads with the heater rods, against the
//! maintained IF97 boundary and the stratified cell. The heater blocks are
//! verbatim copies from Leitbild-wiki-p2 heater-equipment.md and the shell
//! block from pressurizer-thermal-state.md ("Shell and head metal"); the
//! opt-in test at the end compares the shell block with a wiki checkout.
use leitbild_operating_plant::{
    network::{
        Failure,
        heaters::{BanksBlock, Caloric304, ContactBlock, HeaterCase, Heaters},
        stratified::{self as st, Boundary, Case, Cell, Column, Coordinates, Receipt, WallElement},
        walls::{self, MetalRates, ShellBlock, WallCase, Walls},
    },
    thermal::{Scalar, WaterProperties},
};
use leitbild_operating_water::If97;

const ROOF_PA: f64 = 14_864_186.805_5;

const BANKS: &str = r#"{"banks":[{"id":"normal","equivalentRods":32,"rodDiameter_m":0.02,"spanBottomAbovePzrBottom_m":0,"spanTopAbovePzrBottom_m":1,"segments_m":[[0,1]],"nominalCapacity_W":120000,"lateralContactArea_m2":2.010619,"solidDisplacement_m3":0.0100531,"steelMass_kg":79.620524},{"id":"backup","equivalentRods":256,"rodDiameter_m":0.02,"spanBottomAbovePzrBottom_m":0,"spanTopAbovePzrBottom_m":3,"segments_m":[[0,1],[1,3]],"nominalCapacity_W":2880000,"lateralContactArea_m2":48.254863,"solidDisplacement_m3":0.2412743,"steelMass_kg":1910.892581}]}"#;
const CALORIC: &str = r#"{"density_kg_m3":7920,"cpConstant_J_kg_K":469.4448,"cpLinear_J_kg_K2":0.13480848,"datum_K":300,"minimum_K":290,"maximum_K":1600}"#;
const CONTACT: &str = r#"{"wet":{"sensibleCoefficient_W_m2K":2000,"onsetContactAngle_deg":38,"wallBirthFraction":1,"wallBirthFractionSensitivity":0.5,"bromleyCoefficient":1.13,"filmRadiationCoefficient":0.3,"minimumFilmBounds_K":[755.372222,898.705556],"filmConvectionSensitivity":[0.5,2]},"exposed":{"gasCoefficient_W_m2K":5,"gasCoefficientSensitivity":[0.5,2],"enclosureEmissivity":0.3,"condensationSpeed_m_s":0.01},"conductivity304":{"constant_W_m_K":8.116,"linear_W_m_K2":0.01618}}"#;

const SHELL: &str = r#"{"grossArea_m2":5,"shellThickness_m":0.15,"shellBands_m":[[0,1],[1,3],[3,6],[6,9],[9,12]],"shellMass_kg":119720.36964,"headThickness_m":0.15,"headMass_kg":5940,"bottomHeadContactArea_m2":4.838836,"topHeadContactArea_m2":4.950335,"wetSensibleCoefficient_W_m2K":1000,"shellFilmDevelopmentLength_m":12,"headFilmResistanceLength_m":0.001,"headFilmResistanceSensitivity_m":[0.0005,0.002],"insulation":{"thickness_m":0.1,"conductivity_W_m_K":0.06,"exteriorCoefficient_W_m2K":8,"ambient_K":313.15}}"#;

const SECTION: &str = r#"{"index":28,"bottom_m":6.5,"top_m":18.5,"fluidVolume_m3":59.7486726,
 "freeArea":[{"from_m":6.5,"to_m":7.5,"area_m2":4.909522131576614},{"from_m":7.5,"to_m":9.5,"area_m2":4.9195752280681013},{"from_m":9.5,"to_m":18.5,"area_m2":5.0}],
 "ports":[{"id":"PZR.SURGE.MOUTH","kind":"surge","elevation_m":6.5,"face":34,"bore_m":0.3}],
 "taps":[{"id":"PT1","elevation_m":18.5},{"id":"LT.LOW","elevation_m":6.5},{"id":"LT.HIGH","elevation_m":18.5}],
 "heaters":{"bottom_m":6.5,"top_m":9.5,"displacement_m3":0.25132741228718347},
 "stratified":{"withdrawalScale_m":0.30,"admittedPreparationThickness_m":0.30,"inversionExchangeVelocity_m_s":320,"liquidRelaxationTime_s":0.3,"vaporRelaxationTime_s":0.5,"relaxationSensitivity":[0.5,1,2],"bubbleDiameter_m":0.00075,"sprayDropDiameter_m":0.003,"dropDiameterSensitivity_m":[0.0015,0.003,0.006],"resolvabilityFactor":1000},
 "metastable":{"pressureRange_Pa":[2000000,16000000],"lowerBoundExclusive":true,"liquidSuperheatMax_K":2.0,"vaporSubcoolingMax_K":1.4,"trialMax_K":3.0,"creditedMax_K":0.5,"liquidTemperatureMax_K":623.15,"liquidPressureCeiling_Pa":17000000,"vaporPressureCeiling_Pa":16000000},
 "absorberMassFraction":0.001,"interfacialLength_m":0.003}"#;

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn cell() -> Cell {
    let p: st::Parameters = serde_json::from_str(SECTION).unwrap();
    let case = Case::nominal(&p);
    Cell::new(p, case).unwrap()
}
fn blocks() -> (BanksBlock, Caloric304, ContactBlock) {
    (
        serde_json::from_str(BANKS).unwrap(),
        serde_json::from_str(CALORIC).unwrap(),
        serde_json::from_str(CONTACT).unwrap(),
    )
}
fn heaters_with(cell: &Cell, banks: &BanksBlock, case: Option<HeaterCase>) -> Heaters {
    let (_, caloric, contact) = blocks();
    let case = case.unwrap_or_else(|| HeaterCase::nominal(&contact));
    Heaters::new(cell, banks, caloric, contact, case).unwrap()
}
fn heaters(cell: &Cell) -> Heaters {
    heaters_with(cell, &blocks().0, None)
}
fn tsat(p: f64) -> f64 {
    WaterProperties::saturation(&If97, s(p))
        .unwrap()
        .temperature
        .value
}

/// A prepared column at `level_m` above the bottom: every zone at
/// `Tsat(p_s)`, the mixture surface at `bottom + level_m`.
struct State {
    cell: Cell,
    values: [f64; st::COORDINATES],
    liquid_k: f64,
}
fn prepared(level_m: f64) -> State {
    let cell = cell();
    let prep = cell.prepare(&If97, ROOF_PA, level_m, 1e-6, 50).unwrap();
    State {
        cell,
        values: prep.values,
        liquid_k: prep.saturation_temperature_k,
    }
}
/// The column with every coordinate seeded by `d` (physical units).
fn column(state: &State, values: &[f64; st::COORDINATES], d: &[f64]) -> (Coordinates, Column) {
    let v: Vec<Scalar> = (0..st::COORDINATES)
        .map(|i| Scalar::new(values[i], d[i]))
        .collect();
    let x = Coordinates::from_slice(&v).unwrap();
    let c = state.cell.column(&If97, &x, None).unwrap();
    (x, c)
}
fn metal(h: &Heaters, temperatures: &[f64], d: &[f64]) -> Vec<Scalar> {
    h.segments()
        .iter()
        .zip(temperatures)
        .zip(d)
        .map(|((g, t), d)| {
            let e = h.caloric().specific_energy(s(*t)).unwrap().value;
            Scalar::new(g.steel_mass_kg * e, *d)
        })
        .collect()
}

fn shell() -> ShellBlock {
    serde_json::from_str(SHELL).unwrap()
}
fn walls_with(cell: &Cell, h: &Heaters, case: Option<WallCase>) -> Walls {
    let (_, caloric, contact) = blocks();
    let case = case.unwrap_or_else(|| WallCase::nominal(&contact, &shell()));
    Walls::new(cell, h, shell(), caloric, contact, case).unwrap()
}
fn wall_metal(w: &Walls, h: &Heaters, temperatures: &[f64], d: &[f64]) -> Vec<Scalar> {
    w.elements()
        .iter()
        .zip(temperatures)
        .zip(d)
        .map(|((e, t), d)| {
            Scalar::new(
                e.steel_mass_kg * h.caloric().specific_energy(s(*t)).unwrap().value,
                *d,
            )
        })
        .collect()
}
fn scales(values: &[f64; st::COORDINATES]) -> [f64; st::COORDINATES] {
    let mut scales = *values;
    scales[st::BUBBLE_VOLUME] = 0.5;
    scales[st::DROP_VOLUME] = 0.05;
    scales[st::BUBBLE_MASS] = 50.;
    scales[st::DROP_MASS] = 30.;
    scales[st::DROP_BORON] = 0.03;
    scales
}

#[test]
fn heater_walls_compile_seven_lumped_elements_and_their_census() {
    let c = cell();
    let h = heaters(&c);
    let w = walls_with(&c, &h, None);
    let census = w.census();
    assert_eq!((census.differential, census.algebraic), (7, 0));
    println!("{census:#?}");
    let b = shell();
    let radius = (b.gross_area_m2 / std::f64::consts::PI).sqrt();
    let (mut mass, mut contact) = (0_f64, 0_f64);
    for e in &w.elements()[..5] {
        let WallElement::Band { bottom_m, top_m } = e.element else {
            panic!("bands first")
        };
        let dz = top_m - bottom_m;
        assert!((e.contact_area_m2 - 2. * std::f64::consts::PI * radius * dz).abs() <= 1e-12);
        assert!(
            (e.outer_area_m2 - 2. * std::f64::consts::PI * (radius + b.shell_thickness_m) * dz)
                .abs()
                <= 1e-12
        );
        mass += e.steel_mass_kg;
        contact += e.contact_area_m2;
    }
    assert!((mass - b.shell_mass_kg).abs() <= 1e-9 * b.shell_mass_kg);
    assert!((contact - 2. * (std::f64::consts::PI * b.gross_area_m2).sqrt() * 12.).abs() <= 1e-9);
    let [bottom, top] = [&w.elements()[5], &w.elements()[6]];
    assert!(matches!(bottom.element, WallElement::BottomHead) && bottom.enclosure.is_none());
    assert!(matches!(top.element, WallElement::TopHead) && top.enclosure == Some(4));
    assert_eq!(
        [
            bottom.contact_area_m2,
            top.contact_area_m2,
            bottom.outer_area_m2
        ],
        [
            b.bottom_head_contact_area_m2,
            b.top_head_contact_area_m2,
            b.gross_area_m2
        ]
    );
    // Every rod segment lies inside one shell band.
    assert_eq!(w.rod_band(), &[0, 0, 1]);
    let (_, caloric, contact_block) = blocks();
    let case = WallCase::nominal(&contact_block, &b);
    let mut heavy = shell();
    heavy.shell_mass_kg *= 1.01;
    let mut gap = shell();
    gap.shell_bands_m = vec![[0., 1.], [1., 3.], [3., 6.], [6., 9.], [9., 11.]];
    for block in [heavy, gap] {
        assert!(matches!(
            Walls::new(&c, &h, block, caloric, contact_block, case),
            Err(Failure::Fatal(_))
        ));
    }
    let undeclared = WallCase {
        head_film_resistance_length_m: 0.003,
        ..case
    };
    assert!(Walls::new(&c, &h, shell(), caloric, contact_block, undeclared).is_err());
}

/// Rates and the cell's own account with every rod and wall receipt.
#[allow(clippy::too_many_arguments)]
fn account(
    state: &State,
    h: &Heaters,
    w: &Walls,
    rods: &[f64],
    elements: &[f64],
    power: &[f64],
) -> (MetalRates, st::Evaluation) {
    let zero = [0.; st::COORDINATES];
    let (x, c) = column(state, &state.values, &zero);
    let r = w
        .rates(
            &state.cell,
            &c,
            h,
            &metal(h, rods, &[0.; 3]),
            power,
            &wall_metal(w, h, elements, &[0.; 7]),
            &If97,
        )
        .unwrap();
    let boundary = Boundary {
        heaters: r.heater_receipts(),
        walls: r.wall_receipts(),
        ..Boundary::closed()
    };
    let ev = state
        .cell
        .residual_on(
            &If97,
            c,
            &x,
            &Coordinates::values(&zero),
            &[Receipt::zero()],
            &boundary,
            &scales(&state.values),
        )
        .unwrap();
    (r, ev)
}

/// (level, rod temperature, element temperatures, temperatures are offsets
/// from the liquid, bank powers).
type EnergyCase = (f64, f64, [f64; 7], bool, [f64; 2]);
/// (level, rod temperatures, element temperatures, bank powers).
type DirectionCase = (f64, [f64; 3], [f64; 7], [f64; 2]);

#[test]
fn heater_walls_energy_closes_over_rods_walls_enclosure_and_exterior() {
    // (level, rods, walls) with temperatures relative to the liquid when
    // offset, and bank power.
    let cases: [EnergyCase; 5] = [
        (6.0, 1., [0.; 7], true, [1.2e5, 2.88e6]),
        (6.0, 0., [0.; 7], true, [0., 0.]),
        (
            2.0,
            650.,
            [600., 610., 620., 590., 580., 605., 570.],
            false,
            [1.2e5, 2.88e6],
        ),
        (
            0.6,
            700.,
            [640., 630., 615., 600., 590., 650., 580.],
            false,
            [0., 0.],
        ),
        (
            0.6,
            590.,
            [700., 680., 660., 640., 620., 700., 610.],
            false,
            [1.2e5, 2.88e6],
        ),
    ];
    for (level, rod_t, wall_t, offset, power) in cases {
        let state = prepared(level);
        let h = heaters(&state.cell);
        let w = walls_with(&state.cell, &h, None);
        let rods = if offset {
            vec![state.liquid_k + rod_t; 3]
        } else {
            vec![rod_t; 3]
        };
        let elements: Vec<f64> = wall_t
            .iter()
            .map(|t| if offset { state.liquid_k + t } else { *t })
            .collect();
        let (r, ev) = account(&state, &h, &w, &rods, &elements, &power);
        let joule: f64 = r.rods.iter().map(|x| x.joule_w).sum();
        let rod_metal: f64 = r.rod_metal_rates().iter().map(|x| x.value).sum();
        let wall_metal: f64 = r.wall_metal_rates().iter().map(|x| x.value).sum();
        let fluid: f64 = r.rods.iter().map(|x| x.fluid_energy_w.value).sum::<f64>()
            + r.walls.iter().map(|x| x.fluid_energy_w.value).sum::<f64>();
        let exterior: f64 = r.walls.iter().map(|x| x.exterior_w.value).sum();
        let radiation: f64 = r.rod_radiation_w.iter().map(|x| x.value).sum::<f64>()
            + r.walls.iter().map(|x| x.radiation_w.value).sum::<f64>();
        let size =
            joule.abs() + rod_metal.abs() + wall_metal.abs() + fluid.abs() + exterior.abs() + 1.;
        assert!(
            (joule - rod_metal - wall_metal - fluid - exterior).abs() <= 1e-12 * size,
            "{joule} != {rod_metal} + {wall_metal} + {fluid} + {exterior}"
        );
        assert!(radiation.abs() <= 1e-12 * size);
        let b = &ev.balance;
        assert!((b.receipt_energy_w.value - fluid).abs() <= 1e-12 * size);
        assert!((b.energy_w.value - b.receipt_energy_w.value).abs() <= 1e-6 * size.max(1.));
        assert!(b.mass_kg_s.value.abs() <= 1e-12 * size && b.receipt_mass_kg_s.value == 0.);
        let rad: Vec<String> = r
            .rod_radiation_w
            .iter()
            .map(|q| format!("{:.1}", q.value))
            .collect();
        println!(
            "level {level} m: Joule {joule:.1} W = rods {rod_metal:.1} + walls {wall_metal:.1} + fluid {fluid:.1} + exterior {exterior:.1} W; rod radiation {rad:?} W"
        );
        if !offset {
            // The rods exposed while powered now exchange with their band.
            assert!(r.rods.iter().any(|x| x.areas[2].value > 0.));
        }
    }
}

#[test]
fn heater_walls_band_enclosure_is_reciprocal_local_and_second_law() {
    let members = [
        (Scalar::new(2., 0.1), Scalar::new(900., 1.)),
        (Scalar::new(0.5, -0.2), Scalar::new(600., 0.)),
        (Scalar::new(3., 0.), Scalar::new(700., -2.)),
    ];
    let q = walls::enclosure(&members, 0.3);
    let sum = q.iter().fold(s(0.), |a, x| a + *x);
    assert!(sum.value.abs() <= 1e-9 && sum.direction.abs() <= 1e-9);
    assert!(q[0].value > 0. && q[1].value < 0.);
    let entropy: f64 = q
        .iter()
        .zip(&members)
        .map(|(x, (_, t))| -x.value / t.value)
        .sum();
    assert!(entropy >= 0.);
    let equal = walls::enclosure(&[(s(1.), s(700.)), (s(2.), s(700.))], 0.3);
    assert!(equal.iter().all(|x| x.value.abs() <= 1e-9));
    assert!(
        walls::enclosure(&[(s(0.), s(900.)), (s(0.), s(300.))], 0.3)
            .iter()
            .all(|x| x.value == 0. && x.direction == 0.)
    );
    // In the cell: rods exchange only with their own band's members.
    let state = prepared(0.6);
    let h = heaters(&state.cell);
    let w = walls_with(&state.cell, &h, None);
    let (r, _) = account(
        &state,
        &h,
        &w,
        &[800., 700., 900.],
        &[600., 640., 620., 610., 600., 615., 605.],
        &[0., 0.],
    );
    let band = |k: usize| {
        r.walls[k].radiation_w.value
            + (0..3)
                .filter(|j| w.rod_band()[*j] == k)
                .map(|j| r.rod_radiation_w[j].value)
                .sum::<f64>()
            + if k == 4 {
                r.walls[6].radiation_w.value
            } else {
                0.
            }
    };
    for k in 0..5 {
        assert!(
            band(k).abs() <= 1e-9 * r.rod_radiation_w[2].value.abs().max(1.),
            "band {k}"
        );
    }
    assert_eq!(r.walls[5].radiation_w.value, 0.);
    println!(
        "0.6 m, rods 800/700/900 K: rod radiation {:?} W",
        r.rod_radiation_w
            .iter()
            .map(|x| x.value)
            .collect::<Vec<_>>()
    );
}

/// The frozen shell/head receipt `pzr-shell-contact-ports.json` (CoolProp
/// 8.0.0) against the native walls on IF97, 20 K subcooled at 15 MPa and
/// the head resistance sensitivity at 1 MPa and 950 K.
#[test]
fn heater_walls_shell_and_head_laws_reproduce_the_frozen_offline_rates() {
    let c = cell();
    let h = heaters(&c);
    let w = walls_with(&c, &h, None);
    let p = 15e6;
    let ts = tsat(p);
    let tl = ts - 20.;
    let ct = h
        .liquid_contact_at(s(p), s(tl), If97.liquid(s(p), s(tl)).unwrap(), &If97)
        .unwrap();
    let offline_ts = 615.3053921917832;
    // (element, wall offset above Tsat or absolute, offline q)
    for (k, wall, offline) in [
        (0, 620.0306990817486 - offline_ts, 2717739.3554642405),
        (0, 950., 82179.61406920372),
        (5, 950., 39172.73197089617),
        (6, 950., 39172.73197089617),
        (5, 898.705556, 31652.51619927072),
        (0, 898.705556, 71467.67498200753),
    ] {
        let t = if wall < 100. { ts + wall } else { wall };
        let q = w.wet_flux(k, &ct, s(t), &If97).unwrap();
        println!(
            "15 MPa, element {k}, wall {t:.4} K: native {:.2} ({}), offline {offline:.2} W/m²",
            q.heat.value, q.mode
        );
        assert!((q.heat.value - offline).abs() <= 1e-2 * offline);
    }
    // The film law's mean-film vapor point (Tw + Tsat)/2 leaves the
    // maintained IF97 vapor domain (1073.15 K) above about 1531 K at
    // 15 MPa: the offline 1600 K rows refuse here by name.
    assert!(w.wet_flux(0, &ct, s(1500.), &If97).is_ok());
    match w.wet_flux(0, &ct, s(1600.), &If97) {
        Err(Failure::Recoverable(m)) => assert!(m.contains("IF97 vapor domain"), "{m}"),
        other => panic!("{other:?}"),
    }
    let p = 1e6;
    let sat = WaterProperties::saturation(&If97, s(p)).unwrap();
    let (_, caloric, contact) = blocks();
    for (length, offline) in [
        (0.0005, 71620.32977651265),
        (0.001, 42379.73396522459),
        (0.002, 27759.436059580563),
    ] {
        let case = WallCase {
            head_film_resistance_length_m: length,
            ..WallCase::nominal(&contact, &shell())
        };
        let wh = Walls::new(&c, &h, shell(), caloric, contact, case).unwrap();
        let ct = h
            .liquid_contact_at(s(p), sat.temperature, sat.liquid, &If97)
            .unwrap();
        let q = wh.wet_flux(5, &ct, s(950.), &If97).unwrap();
        assert_eq!(q.mode, "film");
        println!(
            "1 MPa, 950 K, head resistance {length} m: native {:.2}, offline {offline:.2} W/m²",
            q.heat.value
        );
        assert!((q.heat.value - offline).abs() <= 1e-2 * offline);
    }
}

#[test]
fn heater_walls_exterior_path_and_rest_preparation() {
    let state = prepared(6.0);
    let h = heaters(&state.cell);
    let w = walls_with(&state.cell, &h, None);
    let b = shell();
    let i = &b.insulation;
    let resistance = i.thickness_m / i.conductivity_w_m_k + 1. / i.exterior_coefficient_w_m2_k;
    for (k, e) in w.elements().iter().enumerate() {
        assert_eq!(w.exterior(k, s(i.ambient_k)).value, 0.);
        let q = w.exterior(k, Scalar::new(600., 1.));
        let expected = e.outer_area_m2 * (600. - i.ambient_k) / resistance;
        assert!((q.value - expected).abs() <= 1e-12 * expected);
        assert!((q.direction - e.outer_area_m2 / resistance).abs() <= 1e-12 * q.direction);
    }
    // Prepared metal at Tsat(p_s): contact heat vanishes to the zone
    // inverses' agreement, and the exterior loss is the only metal flow.
    let t = state.liquid_k;
    let (r, _) = account(&state, &h, &w, &[t; 3], &[t; 7], &[0., 0.]);
    let exterior: f64 = r.walls.iter().map(|x| x.exterior_w.value).sum();
    let fluid: f64 = r.rods.iter().map(|x| x.fluid_energy_w.value).sum::<f64>()
        + r.walls.iter().map(|x| x.fluid_energy_w.value).sum::<f64>();
    let area: f64 = r
        .walls
        .iter()
        .map(|x| x.areas.iter().map(|a| a.value).sum::<f64>())
        .sum::<f64>()
        + r.rods
            .iter()
            .map(|x| x.areas.iter().map(|a| a.value).sum::<f64>())
            .sum::<f64>();
    println!("rest at {t:.6} K: exterior {exterior:.1} W, contact {fluid:e} W over {area:.1} m²");
    assert!(exterior > 0.);
    assert!(fluid.abs() <= 2000. * area * 1e-8);
}

#[test]
fn heater_walls_directions_match_central_differences() {
    let cases: [DirectionCase; 3] = [
        // 5.5 m keeps the mixture level off the shell bands' edges.
        (
            5.5,
            [615.4, 615.6, 615.8],
            [614.0, 614.3, 614.6, 614.9, 615.2, 615.0, 614.5],
            [1.2e5, 2.88e6],
        ),
        (
            2.0,
            [650., 700., 750.],
            [600., 610., 620., 590., 580., 605., 570.],
            [0., 0.],
        ),
        (
            0.6,
            [590., 595., 700.],
            [700., 680., 660., 640., 620., 700., 610.],
            [1.2e5, 2.88e6],
        ),
    ];
    let pattern = [
        0.3, -0.7, 0.2, 0.5, 0., 0., 0.1, -0.2, 0.6, 0.3, -0.5, 0.8, -0.1, 0.4, 0., 0., 0.,
    ];
    let mut worst: f64 = 0.;
    for (level, rods, elements, power) in cases {
        let state = prepared(level);
        let h = heaters(&state.cell);
        let w = walls_with(&state.cell, &h, None);
        let d: Vec<f64> = (0..st::COORDINATES)
            .map(|i| pattern[i] * 1e-4 * state.values[i].abs())
            .collect();
        let dr: Vec<f64> = h
            .segments()
            .iter()
            .enumerate()
            .map(|(j, g)| [0.4, -0.9, 0.7][j] * g.steel_mass_kg * 500. * 0.05)
            .collect();
        let dw: Vec<f64> = w
            .elements()
            .iter()
            .enumerate()
            .map(|(k, e)| [0.3, -0.6, 0.9, -0.2, 0.5, -0.8, 0.4][k] * e.steel_mass_kg * 500. * 0.05)
            .collect();
        let outputs = |r: &MetalRates| -> Vec<Scalar> {
            let mut out = r.rod_metal_rates();
            out.extend(r.wall_metal_rates());
            for x in &r.walls {
                let k = x.receipt;
                out.extend([
                    k.wet_heat_w[0],
                    k.wet_heat_w[1],
                    k.wet_vapor_kg_s[0],
                    k.wet_vapor_kg_s[1],
                    k.dry_heat_w,
                    k.condensate_kg_s,
                    k.condensate_kg_s * k.condensate_enthalpy_j_kg,
                    x.radiation_w,
                ]);
            }
            out.extend(r.rod_radiation_w.iter().copied());
            out
        };
        let run = |sign: f64, step: f64, seeded: bool| {
            let mut v = state.values;
            for i in 0..st::COORDINATES {
                v[i] += sign * step * d[i];
            }
            let seed: Vec<f64> = if seeded {
                d.clone()
            } else {
                vec![0.; st::COORDINATES]
            };
            let (_, c) = column(&state, &v, &seed);
            let shift = |base: Vec<Scalar>, dd: &[f64]| -> Vec<Scalar> {
                base.iter()
                    .zip(dd)
                    .map(|(u, d)| {
                        Scalar::new(u.value + sign * step * d, if seeded { *d } else { 0. })
                    })
                    .collect()
            };
            let rm = shift(metal(&h, &rods, &[0.; 3]), &dr);
            let wm = shift(wall_metal(&w, &h, &elements, &[0.; 7]), &dw);
            outputs(
                &w.rates(&state.cell, &c, &h, &rm, &power, &wm, &If97)
                    .unwrap(),
            )
        };
        let analytic = run(0., 0., true);
        let difference = |step: f64| -> Vec<f64> {
            let (plus, minus) = (run(1., step, false), run(-1., step, false));
            plus.iter()
                .zip(&minus)
                .map(|(a, b)| (a.value - b.value) / (2. * step))
                .collect()
        };
        let (coarse, fine) = (difference(1.), difference(0.5));
        for (n, an) in analytic.iter().enumerate() {
            let (an, fd) = (an.direction, fine[n]);
            let spread = (coarse[n] - fine[n]).abs();
            let size = an.abs().max(fd.abs());
            let error = (an - fd).abs();
            if size > 1e-6 {
                worst = worst.max(error / size);
            }
            assert!(
                error <= 3. * spread + 1e-5 * size + 1e-9,
                "level {level}: output {n}: analytic {an:e}, difference {fd:e}, spread {spread:e}"
            );
        }
    }
    println!("worst relative direction error: {worst:e}");
}

/// The embedded shell block against a wiki checkout's PTS page.
#[test]
#[ignore = "requires LD01_WIKI_DIR, a Leitbild wiki checkout"]
fn heater_walls_embedded_shell_block_equals_the_wiki() {
    let root = std::env::var_os("LD01_WIKI_DIR").expect("LD01_WIKI_DIR");
    let page = std::fs::read_to_string(std::path::Path::new(&root).join(
        "world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressurizer-thermal-state.md",
    ))
    .unwrap();
    let name = "ld01-pzr-shell";
    let start = page.find(&format!("```{name}\n")).expect(name) + name.len() + 4;
    let end = start + page[start..].find("```").unwrap();
    let wiki: serde_json::Value = serde_json::from_str(&page[start..end]).unwrap();
    let mine: serde_json::Value = serde_json::from_str(SHELL).unwrap();
    assert_eq!(wiki, mine);
}
