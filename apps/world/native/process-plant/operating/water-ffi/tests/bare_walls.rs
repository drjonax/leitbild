//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressurizer-thermal-state.md#gate-3-pactel-atws-10-outsurge-blocked
//! The bare shell of a vessel without heads, insulation or rods (the PACTEL
//! prescription, gate 3): band admission, the coefficient-only exterior, Joule
//! power deposited in the band steel, and a walls-only liquid contact whose
//! minimum-film endpoint is the one the rods would compute. The blocks are
//! the heater_walls copies; the bare shell is the same 12 m vessel.
use leitbild_operating_plant::{
    network::{
        Failure,
        heaters::{BanksBlock, Caloric304, ContactBlock, HeaterCase, Heaters},
        stratified::{self as st, Case, Cell, Coordinates, WallElement},
        walls::{BareShellBlock, Rods, ShellBlock, WallCase, Walls},
    },
    thermal::Scalar,
};
use leitbild_operating_water::If97;

const ROOF_PA: f64 = 14_864_186.805_5;
const BANKS: &str = r#"{"banks":[{"id":"normal","equivalentRods":32,"rodDiameter_m":0.02,"spanBottomAbovePzrBottom_m":0,"spanTopAbovePzrBottom_m":1,"segments_m":[[0,1]],"nominalCapacity_W":120000,"lateralContactArea_m2":2.010619,"solidDisplacement_m3":0.0100531,"steelMass_kg":79.620524},{"id":"backup","equivalentRods":256,"rodDiameter_m":0.02,"spanBottomAbovePzrBottom_m":0,"spanTopAbovePzrBottom_m":3,"segments_m":[[0,1],[1,3]],"nominalCapacity_W":2880000,"lateralContactArea_m2":48.254863,"solidDisplacement_m3":0.2412743,"steelMass_kg":1910.892581}]}"#;
const CALORIC: &str = r#"{"density_kg_m3":7920,"cpConstant_J_kg_K":469.4448,"cpLinear_J_kg_K2":0.13480848,"datum_K":300,"minimum_K":290,"maximum_K":1600}"#;
const CONTACT: &str = r#"{"wet":{"sensibleCoefficient_W_m2K":2000,"onsetContactAngle_deg":38,"wallBirthFraction":1,"wallBirthFractionSensitivity":0.5,"bromleyCoefficient":1.13,"filmRadiationCoefficient":0.3,"minimumFilmBounds_K":[755.372222,898.705556],"filmConvectionSensitivity":[0.5,2]},"exposed":{"gasCoefficient_W_m2K":5,"gasCoefficientSensitivity":[0.5,2],"enclosureEmissivity":0.3,"condensationSpeed_m_s":0.01},"conductivity304":{"constant_W_m_K":8.116,"linear_W_m_K2":0.01618}}"#;
const SHELL: &str = r#"{"grossArea_m2":5,"shellThickness_m":0.15,"shellBands_m":[[0,1],[1,3],[3,6],[6,9],[9,12]],"shellMass_kg":119720.36964,"headThickness_m":0.15,"headMass_kg":5940,"bottomHeadContactArea_m2":4.838836,"topHeadContactArea_m2":4.950335,"wetSensibleCoefficient_W_m2K":1000,"shellFilmDevelopmentLength_m":12,"headFilmResistanceLength_m":0.001,"headFilmResistanceSensitivity_m":[0.0005,0.002],"insulation":{"thickness_m":0.1,"conductivity_W_m_K":0.06,"exteriorCoefficient_W_m2K":8,"ambient_K":313.15}}"#;
/// The same shell bands and mass, bare: no heads, no insulation.
const BARE: &str = r#"{"grossArea_m2":5,"shellThickness_m":0.15,"shellBands_m":[[0,1],[1,3],[3,6],[6,9],[9,12]],"shellMass_kg":119720.36964,"wetSensibleCoefficient_W_m2K":1000,"shellFilmDevelopmentLength_m":12,"exteriorCoefficient_W_m2K":3.44,"ambient_K":298}"#;
const SECTION: &str = r#"{"index":28,"bottom_m":6.5,"top_m":18.5,"fluidVolume_m3":59.7486726,
 "freeArea":[{"from_m":6.5,"to_m":7.5,"area_m2":4.909522131576614},{"from_m":7.5,"to_m":9.5,"area_m2":4.9195752280681013},{"from_m":9.5,"to_m":18.5,"area_m2":5.0}],
 "ports":[{"id":"PZR.SURGE.MOUTH","kind":"surge","elevation_m":6.5,"face":34,"bore_m":0.3}],
 "taps":[{"id":"PT1","elevation_m":18.5},{"id":"LT.LOW","elevation_m":6.5},{"id":"LT.HIGH","elevation_m":18.5}],
 "heaters":{"bottom_m":6.5,"top_m":9.5,"displacement_m3":0.25132741228718347},
 "stratified":{"withdrawalScale_m":0.30,"admittedPreparationThickness_m":0.30,"inversionExchangeVelocity_m_s":320,"liquidRelaxationTime_s":0.3,"vaporRelaxationTime_s":0.5,"relaxationSensitivity":[0.5,1,2],"bubbleDiameter_m":0.00075,"bubbleExchangeSensitivity":[0.5,1,2],"bubbleExchangeDiameterSensitivity_m":0.0005,"sprayDropDiameter_m":0.003,"dropDiameterSensitivity_m":[0.0015,0.003,0.006],"resolvabilityFactor":1000},
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
fn blocks() -> (Caloric304, ContactBlock) {
    (
        serde_json::from_str(CALORIC).unwrap(),
        serde_json::from_str(CONTACT).unwrap(),
    )
}
fn bare_block() -> BareShellBlock {
    serde_json::from_str(BARE).unwrap()
}
fn bare(c: &Cell) -> Walls {
    let (caloric, contact) = blocks();
    Walls::bare(
        c,
        bare_block(),
        caloric,
        contact,
        HeaterCase::nominal(&contact),
    )
    .unwrap()
}
fn energies(w: &Walls, caloric: &Caloric304, t: f64) -> Vec<Scalar> {
    let e = caloric.specific_energy(s(t)).unwrap().value;
    w.elements()
        .iter()
        .map(|x| s(x.steel_mass_kg * e))
        .collect()
}

#[test]
fn a_bare_shell_compiles_its_bands_alone_and_refuses_an_inconsistent_mass() {
    let c = cell();
    let w = bare(&c);
    let census = w.census();
    assert_eq!((census.differential, census.algebraic), (5, 0));
    assert!(w.rod_band().is_empty());
    let b = bare_block();
    let radius = (b.gross_area_m2 / std::f64::consts::PI).sqrt();
    let mass: f64 = w.elements().iter().map(|e| e.steel_mass_kg).sum();
    assert!((mass - b.shell_mass_kg).abs() <= 1e-9 * b.shell_mass_kg);
    for (j, e) in w.elements().iter().enumerate() {
        let WallElement::Band { bottom_m, top_m } = e.element else {
            panic!("a bare shell has bands only")
        };
        let dz = top_m - bottom_m;
        assert_eq!(e.enclosure, Some(j));
        assert!(
            (e.outer_area_m2 - 2. * std::f64::consts::PI * (radius + b.shell_thickness_m) * dz)
                .abs()
                <= 1e-12
        );
    }
    let (caloric, contact) = blocks();
    let mut heavy = bare_block();
    heavy.shell_mass_kg *= 1.01;
    let mut short = bare_block();
    short.shell_bands_m = vec![[0., 1.], [1., 3.], [3., 6.], [6., 9.], [9., 11.]];
    let mut open = bare_block();
    open.exterior_coefficient_w_m2_k = 0.;
    for block in [heavy, short, open] {
        assert!(matches!(
            Walls::bare(&c, block, caloric, contact, HeaterCase::nominal(&contact)),
            Err(Failure::Fatal(_))
        ));
    }
}

#[test]
fn the_bare_exterior_is_the_outer_coefficient_alone() {
    let c = cell();
    let w = bare(&c);
    let b = bare_block();
    for (k, e) in w.elements().iter().enumerate() {
        assert_eq!(w.exterior(k, s(b.ambient_k)).value, 0.);
        let q = w.exterior(k, Scalar::new(547., 1.));
        let expected = e.outer_area_m2 * b.exterior_coefficient_w_m2_k * (547. - b.ambient_k);
        assert!((q.value - expected).abs() <= 1e-12 * expected);
        assert!(
            (q.direction - e.outer_area_m2 * b.exterior_coefficient_w_m2_k).abs()
                <= 1e-12 * q.direction
        );
    }
}

/// The walls-only contact gives the bands the endpoint the rods compute,
/// so a bare shell's wet bands are those of the same shell with rods; and
/// Joule power in a band's steel enters its metal rate exactly.
#[test]
fn bare_bands_contact_as_with_rods_and_their_joule_power_enters_the_steel() {
    let c = cell();
    let prep = c.prepare(&If97, ROOF_PA, 6.0, 1e-6, 50).unwrap();
    let x = Coordinates::values(&prep.values);
    let column = c.column(&If97, &x, None).unwrap();
    let (caloric, contact) = blocks();
    let banks: BanksBlock = serde_json::from_str(BANKS).unwrap();
    let heaters =
        Heaters::new(&c, &banks, caloric, contact, HeaterCase::nominal(&contact)).unwrap();
    let shell: ShellBlock = serde_json::from_str(SHELL).unwrap();
    let lumped = Walls::new(
        &c,
        &heaters,
        shell.clone(),
        caloric,
        contact,
        WallCase::nominal(&contact, &shell),
    )
    .unwrap();
    let w = bare(&c);
    let t = prep.saturation_temperature_k - 5.;
    let rod_energy = {
        let e = caloric.specific_energy(s(t)).unwrap().value;
        heaters
            .segments()
            .iter()
            .map(|g| s(g.steel_mass_kg * e))
            .collect::<Vec<_>>()
    };
    let powers = vec![0.; heaters.banks().len()];
    let with_rods = lumped
        .rates_with(
            &c,
            &column,
            Some(Rods {
                heaters: &heaters,
                metal: &rod_energy,
                bank_power_w: &powers,
            }),
            &energies(&lumped, &caloric, t),
            None,
            &If97,
        )
        .unwrap();
    let alone = w
        .rates_with(&c, &column, None, &energies(&w, &caloric, t), None, &If97)
        .unwrap();
    assert!(alone.rods.is_empty());
    for z in 0..2 {
        let (a, b) = (with_rods.contacts[z].unwrap(), alone.contacts[z].unwrap());
        assert_eq!(a.minimum_film.value, b.minimum_film.value);
        assert_eq!(a.minimum_film.direction, b.minimum_film.direction);
    }
    // The bands' wet fluxes per square metre agree bit for bit.
    for k in 0..5 {
        let (a, b) = (&with_rods.walls[k], &alone.walls[k]);
        for (fa, fb) in [(a.admitted, b.admitted), (a.resident, b.resident)] {
            match (fa, fb) {
                (Some(fa), Some(fb)) => assert_eq!(fa.heat.value, fb.heat.value),
                (None, None) => {}
                _ => panic!("wetting differs between the two shells"),
            }
        }
    }
    // Joule power: each band's metal rate rises by exactly its power.
    let joule = [100., 200., 0., 50., 0.];
    let heated = w
        .rates_with(
            &c,
            &column,
            None,
            &energies(&w, &caloric, t),
            Some(&joule),
            &If97,
        )
        .unwrap();
    for k in 0..5 {
        assert_eq!(heated.walls[k].joule_w.value, joule[k]);
        let d = heated.walls[k].metal_rate.value - alone.walls[k].metal_rate.value;
        assert!((d - joule[k]).abs() <= 1e-9 * (1. + alone.walls[k].metal_rate.value.abs()));
    }
    assert!(
        w.rates_with(
            &c,
            &column,
            None,
            &energies(&w, &caloric, t),
            Some(&joule[..4]),
            &If97
        )
        .is_err()
    );
}
