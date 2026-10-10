//! The PZR heater rods against the maintained IF97 boundary and the
//! stratified cell. The three strict blocks are verbatim copies from
//! Leitbild-wiki-p2 f13b329 heater-equipment.md; the opt-in test at the end
//! compares them with a wiki checkout. The cell section is the stratified
//! test's mirror of `pzr.cell`.
use leitbild_operating_plant::{
    network::{
        Failure,
        heaters::{
            BanksBlock, Caloric304, ContactBlock, HeaterCase, Heaters, LiquidContact, Rates,
        },
        stratified::{self as st, Boundary, Case, Cell, Column, Coordinates, Receipt},
    },
    thermal::{Scalar, WaterProperties},
};
use leitbild_operating_water::If97;

const ROOF_PA: f64 = 14_864_186.805_5;

const BANKS: &str = r#"{"banks":[{"id":"normal","equivalentRods":32,"rodDiameter_m":0.02,"spanBottomAbovePzrBottom_m":0,"spanTopAbovePzrBottom_m":1,"segments_m":[[0,1]],"nominalCapacity_W":120000,"lateralContactArea_m2":2.010619,"solidDisplacement_m3":0.0100531,"steelMass_kg":79.620524},{"id":"backup","equivalentRods":256,"rodDiameter_m":0.02,"spanBottomAbovePzrBottom_m":0,"spanTopAbovePzrBottom_m":3,"segments_m":[[0,1],[1,3]],"nominalCapacity_W":2880000,"lateralContactArea_m2":48.254863,"solidDisplacement_m3":0.2412743,"steelMass_kg":1910.892581}]}"#;
const CALORIC: &str = r#"{"density_kg_m3":7920,"cpConstant_J_kg_K":469.4448,"cpLinear_J_kg_K2":0.13480848,"datum_K":300,"minimum_K":290,"maximum_K":1600}"#;
const CONTACT: &str = r#"{"wet":{"sensibleCoefficient_W_m2K":2000,"onsetContactAngle_deg":38,"wallBirthFraction":1,"wallBirthFractionSensitivity":0.5,"bromleyCoefficient":1.13,"filmRadiationCoefficient":0.3,"minimumFilmBounds_K":[755.372222,898.705556],"filmConvectionSensitivity":[0.5,2]},"exposed":{"gasCoefficient_W_m2K":5,"gasCoefficientSensitivity":[0.5,2],"enclosureEmissivity":0.3,"condensationSpeed_m_s":0.01},"conductivity304":{"constant_W_m_K":8.116,"linear_W_m_K2":0.01618}}"#;

const SECTION: &str = r#"{"index":28,"bottom_m":6.5,"top_m":18.5,"fluidVolume_m3":59.7486726,
 "freeArea":[{"from_m":6.5,"to_m":7.5,"area_m2":4.909522131576614},{"from_m":7.5,"to_m":9.5,"area_m2":4.9195752280681013},{"from_m":9.5,"to_m":18.5,"area_m2":5.0}],
 "ports":[{"id":"PZR.SURGE.MOUTH","kind":"surge","elevation_m":6.5,"face":34,"bore_m":0.3}],
 "taps":[{"id":"PT1","elevation_m":18.5},{"id":"LT.LOW","elevation_m":6.5},{"id":"LT.HIGH","elevation_m":18.5}],
 "heaters":{"bottom_m":6.5,"top_m":9.5,"displacement_m3":0.25132741228718347},
 "stratified":{"withdrawalScale_m":0.30,"admittedPreparationThickness_m":0.30,"inversionExchangeVelocity_m_s":320,"liquidRelaxationTime_s":0.3,"vaporRelaxationTime_s":0.5,"relaxationSensitivity":[0.5,1,2],"bubbleDiameter_m":0.00075,"sprayDropDiameter_m":0.003,"dropDiameterSensitivity_m":[0.0015,0.003,0.006],"resolvabilityFactor":1000},
 "metastable":{"pressureRange_Pa":[10000000,16000000],"lowerBoundExclusive":true,"liquidSuperheatMax_K":2.0,"vaporSubcoolingMax_K":1.4,"trialMax_K":3.0,"creditedMax_K":0.5,"liquidTemperatureMax_K":623.15,"liquidPressureCeiling_Pa":17000000,"vaporPressureCeiling_Pa":16000000},
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
fn uniform(h: &Heaters, t: f64) -> Vec<f64> {
    vec![t; h.segments().len()]
}

#[test]
fn heater_blocks_compile_to_three_lumped_segments_and_their_census() {
    let c = cell();
    let h = heaters(&c);
    let census = h.census();
    assert_eq!((census.differential, census.algebraic), (3, 0));
    assert_eq!(census.coordinates.len(), 3);
    println!("{census:#?}");
    let spans: Vec<(usize, f64, f64)> = h
        .segments()
        .iter()
        .map(|g| (g.bank, g.bottom_m, g.top_m))
        .collect();
    assert_eq!(spans, vec![(0, 6.5, 7.5), (1, 6.5, 7.5), (1, 7.5, 9.5)]);
    for (k, b) in h.banks().iter().enumerate() {
        let (mut mass, mut area, mut share) = (0., 0., 0.);
        for g in h.segments().iter().filter(|g| g.bank == k) {
            mass += g.steel_mass_kg;
            area += g.lateral_area_m2;
            share += g.power_share;
        }
        assert!((mass - b.steel_mass_kg).abs() <= 1e-12 * b.steel_mass_kg);
        assert!((area - b.lateral_area_m2).abs() <= 1e-12 * b.lateral_area_m2);
        assert!((share - 1.).abs() <= 1e-15);
        assert_eq!(b.top_m - b.bottom_m, [1., 3.][k]);
    }
    // The page's continuous request split, refusing a request out of range.
    assert_eq!(h.bank_powers(3e6).unwrap(), vec![1.2e5, 2.88e6]);
    assert_eq!(h.bank_powers(6e4).unwrap(), vec![6e4, 0.]);
    assert_eq!(h.bank_powers(0.).unwrap(), vec![0., 0.]);
    for bad in [-1., 3e6 + 1., f64::NAN] {
        assert!(matches!(h.bank_powers(bad), Err(Failure::Fatal(_))));
    }
    // Gate 5's refinement halves every segment: six coordinates.
    let mut halved: BanksBlock = serde_json::from_str(BANKS).unwrap();
    halved.banks[0].segments_m = vec![[0., 0.5], [0.5, 1.]];
    halved.banks[1].segments_m = vec![[0., 0.5], [0.5, 1.], [1., 2.], [2., 3.]];
    assert_eq!(heaters_with(&c, &halved, None).census().differential, 6);
    // Inconsistent declarations are refused, never repaired.
    let (_, caloric, contact) = blocks();
    let case = HeaterCase::nominal(&contact);
    let mut gap: BanksBlock = serde_json::from_str(BANKS).unwrap();
    gap.banks[1].segments_m = vec![[0., 1.], [1.5, 3.]];
    let mut short: BanksBlock = serde_json::from_str(BANKS).unwrap();
    short.banks[1].segments_m = vec![[0., 1.], [1., 2.]];
    let mut area: BanksBlock = serde_json::from_str(BANKS).unwrap();
    area.banks[0].lateral_contact_area_m2 *= 1.01;
    for block in [gap, short, area] {
        assert!(matches!(
            Heaters::new(&c, &block, caloric, contact, case),
            Err(Failure::Fatal(_))
        ));
    }
    let undeclared = HeaterCase {
        wall_birth_fraction: 0.7,
        ..case
    };
    assert!(Heaters::new(&c, &blocks().0, caloric, contact, undeclared).is_err());
}
/// Prepared levels with the mixture inside each segment class: all wet
/// (6 m), the backup's upper segment partly exposed (2 m) and both banks'
/// lower segments partly exposed (0.6 m).
const LEVELS: [f64; 3] = [6.0, 2.0, 0.6];

#[test]
fn heater_wet_and_exposed_areas_follow_the_cells_wetting() {
    for level in LEVELS {
        let state = prepared(level);
        let h = heaters(&state.cell);
        let zero = [0.; st::COORDINATES];
        let (_, c) = column(&state, &state.values, &zero);
        // Unpowered rods above the liquid temperature: every contact acts.
        let m = metal(&h, &uniform(&h, state.liquid_k + 8.), &[0.; 3]);
        let r = h.rates(&state.cell, &c, &m, &[0., 0.], &If97).unwrap();
        for (g, out) in h.segments().iter().zip(&r.segments) {
            let w = state.cell.heater_wetting(&c, g.bottom_m, g.top_m).unwrap();
            let length = g.top_m - g.bottom_m;
            let expected = [w.admitted_length_m, w.resident_length_m, w.exposed_length_m]
                .map(|l| g.lateral_area_m2 * l.value / length);
            for (a, e) in out.areas.iter().zip(expected) {
                assert!((a.value - e).abs() <= 1e-14 * g.lateral_area_m2);
            }
            let total: f64 = out.areas.iter().map(|a| a.value).sum();
            assert!((total - g.lateral_area_m2).abs() <= 1e-13 * g.lateral_area_m2);
            assert_eq!(out.wetting.wet_fraction.value, w.wet_fraction.value);
            assert_eq!(
                (out.receipt.bottom_m, out.receipt.top_m),
                (g.bottom_m, g.top_m)
            );
            // A contact exists exactly where its area does.
            assert_eq!(out.admitted.is_some(), out.areas[0].value != 0.);
            assert_eq!(out.resident.is_some(), out.areas[1].value != 0.);
            assert_eq!(out.exposed.is_some(), out.areas[2].value != 0.);
            if out.areas[0].value == 0. && out.areas[1].value == 0. {
                assert_eq!(out.receipt.wet_heat_w.value, 0.);
                assert_eq!(out.receipt.wet_vapor_kg_s.value, 0.);
            }
            println!(
                "level {level} m segment [{}, {}]: f_wet {:.4}, areas {:?} m², wet {:.1} W, exposed {:.1} W",
                g.bottom_m,
                g.top_m,
                w.wet_fraction.value,
                out.areas.map(|a| a.value),
                out.receipt.wet_heat_w.value,
                out.receipt.exposed_heat_w.value
            );
        }
        // Exposure appears exactly at the lower levels.
        let exposed = r.segments.iter().filter(|x| x.areas[2].value > 0.).count();
        assert_eq!(
            exposed,
            [0, 1, 3][LEVELS.iter().position(|l| *l == level).unwrap()]
        );
        if exposed > 0 {
            // A powered bank with exposed rods needs the unowned shell member.
            let err = h
                .rates(&state.cell, &c, &m, &[1.2e5, 2.88e6], &If97)
                .unwrap_err();
            match err {
                Failure::Recoverable(e) => {
                    assert!(e.contains("shell radiation recipient not owned"), "{e}")
                }
                Failure::Fatal(e) => panic!("{e}"),
            }
        }
    }
}

/// Rates and the cell's own receipt account of one state.
fn account(
    state: &State,
    h: &Heaters,
    temperatures: &[f64],
    power: &[f64],
) -> (Rates, st::Evaluation) {
    let zero = [0.; st::COORDINATES];
    let (x, c) = column(state, &state.values, &zero);
    let m = metal(h, temperatures, &[0.; 3]);
    let r = h.rates(&state.cell, &c, &m, power, &If97).unwrap();
    let mut scales = state.values;
    scales[st::BUBBLE_VOLUME] = 0.5;
    scales[st::DROP_VOLUME] = 0.05;
    scales[st::BUBBLE_MASS] = 50.;
    scales[st::DROP_MASS] = 30.;
    scales[st::DROP_BORON] = 0.03;
    let boundary = Boundary {
        heaters: r.receipts(),
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
            &scales,
        )
        .unwrap();
    (r, ev)
}

#[test]
fn heater_electrical_input_equals_steel_rate_plus_fluid_receipts() {
    // (level, steel temperature offset from the liquid or absolute, power)
    let cases: [(f64, f64, bool, [f64; 2]); 7] = [
        (6.0, 1., true, [1.2e5, 2.88e6]),     // nucleate at full power
        (6.0, 0., true, [1.2e5, 2.88e6]),     // the prepared rest: zero flux
        (6.0, 12., true, [1.2e5, 2.88e6]),    // transition
        (6.0, 1000., false, [1.2e5, 2.88e6]), // film boiling
        (2.0, 700., false, [0., 0.]),         // transition and exposed gas
        (2.0, 600., false, [0., 0.]),         // cold rods: condensate
        (0.6, 650., false, [0., 0.]),         // both banks partly exposed
    ];
    for (level, t, offset, power) in cases {
        let state = prepared(level);
        let h = heaters(&state.cell);
        let steel = if offset { state.liquid_k + t } else { t };
        let (r, ev) = account(&state, &h, &uniform(&h, steel), &power);
        let joule: f64 = r.segments.iter().map(|x| x.joule_w).sum();
        let metal: f64 = r.segments.iter().map(|x| x.metal_rate.value).sum();
        let fluid: f64 = r.segments.iter().map(|x| x.fluid_energy_w.value).sum();
        let size: f64 = r
            .segments
            .iter()
            .map(|x| x.joule_w.abs() + x.metal_rate.value.abs() + x.fluid_energy_w.value.abs())
            .sum::<f64>()
            .max(1.);
        assert!(
            (joule - metal - fluid).abs() <= 1e-13 * size,
            "{joule} != {metal} + {fluid}"
        );
        // The cell books the same receipts and closes its own account.
        let b = &ev.balance;
        assert!((b.receipt_energy_w.value - fluid).abs() <= 1e-12 * size);
        assert!((joule - metal - b.receipt_energy_w.value).abs() <= 1e-12 * size);
        assert!((b.energy_w.value - b.receipt_energy_w.value).abs() <= 1e-6);
        assert!(b.mass_kg_s.value.abs() <= 1e-12 && b.receipt_mass_kg_s.value == 0.);
        let condensate: f64 = r
            .segments
            .iter()
            .map(|x| x.receipt.condensate_kg_s.value)
            .sum();
        let vapor: f64 = r
            .segments
            .iter()
            .map(|x| x.receipt.wet_vapor_kg_s.value)
            .sum();
        let modes: Vec<_> = r
            .segments
            .iter()
            .map(|x| {
                [x.admitted, x.resident]
                    .map(|q| q.map_or("-", |q| q.mode))
                    .join("/")
            })
            .collect();
        println!(
            "level {level} m, steel {steel:.3} K: Joule {joule:.1} W = steel {metal:.1} W + fluid {fluid:.1} W; wall vapor {vapor:.5} kg/s, condensate {condensate:.6} kg/s, modes {modes:?}, saturation calls {}",
            r.saturation_calls
        );
        if level == 2.0 && steel < 610. {
            assert!(condensate > 0.);
        }
        if steel == state.liquid_k {
            // Rods at the prepared liquid temperature carry no heat, to the
            // zone inverses' temperature agreement with Tsat(p_s).
            let zone = |z: &st::Zone| (z.temperature.value - state.liquid_k).abs();
            let (_, c) = column(&state, &state.values, &[0.; st::COORDINATES]);
            let spread = zone(&c.admitted).max(zone(&c.resident));
            let area: f64 = h.segments().iter().map(|g| g.lateral_area_m2).sum();
            let coefficient: ContactBlock = serde_json::from_str(CONTACT).unwrap();
            let bound = coefficient.wet.sensible_coefficient_w_m2_k * area * (spread + 1e-12);
            println!(
                "rest: zone temperatures within {spread:e} K of Tsat(p_s), fluid {fluid:e} W, bound {bound:e} W"
            );
            assert!(fluid.abs() <= bound && (metal - joule).abs() <= bound);
        }
    }
}

/// The boiling curve's mode at a wall temperature.
fn mode(h: &Heaters, bank: usize, c: &LiquidContact, t: f64) -> &'static str {
    h.wet_flux(bank, c, s(t), &If97).unwrap().mode
}
/// Adjacent floats on either side of a mode boundary in `(lo, hi)`.
fn boundary(h: &Heaters, bank: usize, c: &LiquidContact, lo: f64, hi: f64) -> (f64, f64) {
    let below = mode(h, bank, c, lo);
    let (mut lo, mut hi) = (lo, hi);
    assert_ne!(below, mode(h, bank, c, hi));
    loop {
        let mid = 0.5 * (lo + hi);
        if mid <= lo || mid >= hi {
            return (lo, hi);
        }
        if mode(h, bank, c, mid) == below {
            lo = mid;
        } else {
            hi = mid;
        }
    }
}

#[test]
fn heater_boiling_curve_is_continuous_where_its_law_is() {
    let state = prepared(6.0);
    let h = heaters(&state.cell);
    let (_, c) = column(&state, &state.values, &[0.; st::COORDINATES]);
    let p = 15e6;
    let t20 = tsat(p) - 20.;
    let subcooled = h
        .liquid_contact_at(s(p), s(t20), If97.liquid(s(p), s(t20)).unwrap(), &If97)
        .unwrap();
    for (name, contact) in [
        ("prepared R", h.liquid_contact(&c.resident, &If97).unwrap()),
        ("prepared A", h.liquid_contact(&c.admitted, &If97).unwrap()),
        ("15 MPa, 20 K subcooled", subcooled),
    ] {
        let ts = contact.saturation.temperature.value;
        let hfg =
            contact.saturation.vapor.enthalpy.value - contact.saturation.liquid.enthalpy.value;
        for bank in [0, 1] {
            let onset = boundary(
                &h,
                bank,
                &contact,
                contact.temperature.value + 1e-9,
                ts + 3.,
            );
            let turn = boundary(&h, bank, &contact, onset.1, contact.minimum_film.value - 1.);
            let film = boundary(&h, bank, &contact, turn.1, contact.minimum_film.value + 1.);
            let at = |t: f64| h.wet_flux(bank, &contact, s(t), &If97).unwrap();
            let peak = at(turn.1).heat.value;
            for (edge, (lo, hi)) in [("onset", onset), ("turnover", turn), ("minimum film", film)] {
                let (a, b) = (at(lo), at(hi));
                let dq = (b.heat.value - a.heat.value).abs() / peak;
                let dg = (b.vapor_mass.value - a.vapor_mass.value).abs() / (peak / hfg);
                println!(
                    "{name}, bank {bank}, {edge} at {lo:.9} K ({} -> {}): relative jumps q {dq:.1e}, Γ {dg:.1e}",
                    a.mode, b.mode
                );
                assert!(dq <= 1e-9 && dg <= 1e-9, "{name} {edge}: {dq:e} {dg:e}");
            }
            // Ordered endpoints with positive ordered heat.
            let qmin = at(film.1).heat.value;
            assert!(onset.1 < turn.1 && turn.1 < film.1 && 0. < qmin && qmin < peak);
            assert!((film.1 - contact.minimum_film.value).abs() <= 1e-9);
        }
    }
    // The declared onset step at saturation: subcooled bulk keeps the
    // tangency, saturated bulk boils once Tw > Tsat. Its flux step is the
    // pool flux at the onset superheat, reported here.
    let sat = WaterProperties::saturation(&If97, s(p)).unwrap();
    let saturated = h
        .liquid_contact_at(s(p), sat.temperature, sat.liquid, &If97)
        .unwrap();
    let below = sat.temperature.value - 1e-9;
    let nearly = h
        .liquid_contact_at(s(p), s(below), If97.liquid(s(p), s(below)).unwrap(), &If97)
        .unwrap();
    let onset = boundary(&h, 1, &nearly, below + 1e-9, sat.temperature.value + 1.);
    // Just below the subcooled onset the subcooled bulk is sensible only,
    // while the saturated bulk already boils: the step is the saturated
    // side's boiling increment there.
    let wall = s(onset.0);
    assert_eq!(mode(&h, 1, &nearly, onset.0), "sensible");
    let boiling = h.wet_flux(1, &saturated, wall, &If97).unwrap();
    assert_eq!(boiling.mode, "nucleate");
    let contact: ContactBlock = serde_json::from_str(CONTACT).unwrap();
    let sensible = contact.wet.sensible_coefficient_w_m2_k * (onset.0 - sat.temperature.value);
    let step = boiling.heat.value - sensible;
    println!(
        "onset step at 15 MPa: d0 = {:.3e} K; boiling increment {step:.3e} W/m² and wall vapor {:.3e} kg/(m² s) at the subcooled onset",
        onset.1 - sat.temperature.value,
        boiling.vapor_mass.value
    );
    assert!(onset.1 - sat.temperature.value > 0. && onset.1 - sat.temperature.value < 1e-2);
    assert!(step.abs() < 1e-6 && boiling.vapor_mass.value.abs() < 1e-12);
}

#[test]
fn heater_steel_refuses_outside_its_290_to_1600_k_caloric() {
    let c = cell();
    let h = heaters(&c);
    let q = h.caloric();
    assert_eq!(q.specific_energy(s(300.)).unwrap().value, 0.);
    for t in [290., 450., 615., 973.15, 1600.] {
        let e = q.specific_energy(Scalar::new(t, 1.)).unwrap();
        // de/dT is cp, and the inverse recovers T with dT = de/cp.
        assert!((e.direction - q.cp(s(t)).value).abs() <= 1e-12 * e.direction);
        let back = q.temperature(Scalar::new(e.value, 1.)).unwrap();
        assert!((back.value - t).abs() <= 1e-12 * t);
        assert!((back.direction - 1. / q.cp(s(t)).value).abs() <= 1e-15);
        let dt = 1e-3;
        let fd = (q.specific_energy(s((t + dt).min(1600.))).unwrap().value
            - q.specific_energy(s((t - dt).max(290.))).unwrap().value)
            / ((t + dt).min(1600.) - (t - dt).max(290.));
        assert!((fd - q.cp(s(t)).value).abs() <= 1e-6 * fd);
    }
    let low = q.specific_energy(s(290.)).unwrap().value;
    let high = q.specific_energy(s(1600.)).unwrap().value;
    for e in [low - 1., high + 1.] {
        match q.temperature(s(e)) {
            Err(Failure::Recoverable(m)) => assert!(m.contains("290–1600 K"), "{m}"),
            other => panic!("{other:?}"),
        }
    }
    for t in [289.9, 1600.1, f64::NAN] {
        assert!(matches!(
            q.specific_energy(s(t)),
            Err(Failure::Recoverable(_))
        ));
    }
    // A segment's steel energy outside the domain refuses the evaluation.
    let state = prepared(6.0);
    let (_, col) = column(&state, &state.values, &[0.; st::COORDINATES]);
    let g = h.segments()[2];
    let mut m = metal(&h, &uniform(&h, 700.), &[0.; 3]);
    m[2] = s(g.steel_mass_kg * (high + 1.));
    assert!(matches!(
        h.rates(&state.cell, &col, &m, &[0., 0.], &If97),
        Err(Failure::Recoverable(_))
    ));
}

#[test]
fn heater_directions_match_central_differences() {
    let cases: [(f64, f64, bool, [f64; 2]); 5] = [
        (6.0, 1., true, [1.2e5, 2.88e6]),
        (6.0, 12., true, [1.2e5, 2.88e6]),
        (6.0, 1000., false, [1.2e5, 2.88e6]),
        (2.0, 700., false, [0., 0.]),
        (2.0, 600., false, [0., 0.]),
    ];
    let pattern = [
        0.3, -0.7, 0.2, 0.5, 0., 0., 0.1, -0.2, 0.6, 0.3, -0.5, 0.8, -0.1, 0.4, 0., 0., 0.,
    ];
    let mut worst: f64 = 0.;
    for (level, t, offset, power) in cases {
        let state = prepared(level);
        let h = heaters(&state.cell);
        let steel = if offset { state.liquid_k + t } else { t };
        let temperatures: Vec<f64> = (0..3).map(|j| steel + 3. * j as f64).collect();
        // Coordinate seeds relative to each value; steel energies by cp.
        let d: Vec<f64> = (0..st::COORDINATES)
            .map(|i| pattern[i] * 1e-4 * state.values[i].abs())
            .collect();
        let dm: Vec<f64> = h
            .segments()
            .iter()
            .enumerate()
            .map(|(j, g)| [0.4, -0.9, 0.7][j] * g.steel_mass_kg * 500. * 0.05)
            .collect();
        let outputs = |r: &Rates| -> Vec<Scalar> {
            r.segments
                .iter()
                .flat_map(|x| {
                    let k = x.receipt;
                    [
                        x.metal_rate,
                        k.wet_heat_w,
                        k.wet_vapor_kg_s,
                        k.exposed_heat_w,
                        k.condensate_kg_s,
                        k.condensate_kg_s * k.condensate_enthalpy_j_kg,
                    ]
                })
                .collect()
        };
        let run = |sign: f64, h_step: f64, seeded: bool| {
            let mut v = state.values;
            for i in 0..st::COORDINATES {
                v[i] += sign * h_step * d[i];
            }
            let seed: Vec<f64> = if seeded {
                d.clone()
            } else {
                vec![0.; st::COORDINATES]
            };
            let (_, c) = column(&state, &v, &seed);
            let base = metal(&h, &temperatures, &[0.; 3]);
            let m: Vec<Scalar> = base
                .iter()
                .zip(&dm)
                .map(|(u, dm)| {
                    Scalar::new(u.value + sign * h_step * dm, if seeded { *dm } else { 0. })
                })
                .collect();
            outputs(&h.rates(&state.cell, &c, &m, &power, &If97).unwrap())
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
            let an = an.direction;
            let fd = fine[n];
            let spread = (coarse[n] - fine[n]).abs();
            let size = an.abs().max(fd.abs());
            let error = (an - fd).abs();
            if size > 1e-6 {
                worst = worst.max(error / size);
            }
            assert!(
                error <= 3. * spread + 1e-5 * size + 1e-9,
                "level {level}, steel {steel}: output {n}: analytic {an:e}, difference {fd:e}, spread {spread:e}"
            );
        }
    }
    println!("worst relative direction error: {worst:e}");
}

/// The frozen offline receipt `pzr-heater-contact-solid-extension.json`
/// (CoolProp 8.0.0, IAPWS-95) against the native branch on IF97, at each
/// formulation's own saturation temperature.
#[test]
fn heater_wet_law_reproduces_the_frozen_offline_endpoints() {
    let c = cell();
    let h = heaters(&c);
    // (p, subcooling, bank, onset superheat, turnover superheat, Tm, peak, qmin)
    let endpoints = [
        (
            15e6,
            20.,
            1,
            615.4658817938079 - 615.3053921917832,
            620.0472988525596 - 615.3053921917832,
            898.7055555555555,
            2742497.861895814,
            97484.05515448989,
        ),
        (
            15e6,
            20.,
            0,
            615.4658817938079 - 615.3053921917832,
            620.0472988525596 - 615.3053921917832,
            898.7055555555555,
            2742497.861895814,
            125559.48044745837,
        ),
        (
            15e6,
            0.,
            1,
            f64::NAN,
            620.020386166287 - 615.3053921917832,
            898.7055555555555,
            2702444.0365232215,
            97484.05515448989,
        ),
        (
            1e6,
            20.,
            1,
            454.0628771679898 - 453.02800788167445,
            472.24839182365497 - 453.02800788167445,
            898.7055555555555,
            2685328.57044024,
            76788.6168629306,
        ),
    ];
    for (p, sub, bank, onset_sh, turn_sh, tm, peak, qmin) in endpoints {
        let sat = WaterProperties::saturation(&If97, s(p)).unwrap();
        let ts = sat.temperature.value;
        let contact = if sub == 0. {
            h.liquid_contact_at(s(p), sat.temperature, sat.liquid, &If97)
        } else {
            let t = ts - sub;
            h.liquid_contact_at(s(p), s(t), If97.liquid(s(p), s(t)).unwrap(), &If97)
        }
        .unwrap();
        let start = if sub == 0. { ts } else { ts - sub + 1e-9 };
        let onset = boundary(&h, bank, &contact, start, ts + 3.);
        let turn = boundary(&h, bank, &contact, onset.1, contact.minimum_film.value - 1.);
        let q = |t: f64| h.wet_flux(bank, &contact, s(t), &If97).unwrap().heat.value;
        let close = |a: f64, b: f64, tol: f64, what: &str| {
            println!(
                "{p} Pa, {sub} K subcooled, bank {bank}: {what} native {a:.6}, offline {b:.6}"
            );
            assert!((a - b).abs() <= tol * b.abs(), "{what}: {a} vs {b}");
        };
        if sub > 0. {
            // d0 ∝ σ/(ρv hfg k_l) differs by 0.6% between the formulations'
            // saturated properties; the onset superheat by half of that.
            close(onset.1 - ts, onset_sh, 1e-2, "onset superheat (K)");
        } else {
            // The saturated-bulk continuation: onset at Tsat itself.
            assert!(onset.1 - ts <= 1e-9);
        }
        close(turn.1 - ts, turn_sh, 2e-3, "turnover superheat (K)");
        close(contact.minimum_film.value, tm, 1e-9, "minimum film (K)");
        close(q(turn.1), peak, 3e-3, "peak (W/m²)");
        close(
            q(contact.minimum_film.value),
            qmin,
            1e-2,
            "minimum-film heat (W/m²)",
        );
    }
    // Film rows at 950 K and the film convection sensitivity (1 MPa, backup).
    let p = 1e6;
    let sat = WaterProperties::saturation(&If97, s(p)).unwrap();
    for (factor, expected) in [
        (1., 86480.88463995612),
        (0.5, 49810.01139694632),
        (2., 159822.6311259757),
    ] {
        let (_, caloric, contact) = blocks();
        let case = HeaterCase {
            film_convection_factor: factor,
            ..HeaterCase::nominal(&contact)
        };
        let hf = Heaters::new(&c, &blocks().0, caloric, contact, case).unwrap();
        let ct = hf
            .liquid_contact_at(s(p), sat.temperature, sat.liquid, &If97)
            .unwrap();
        let q = hf.wet_flux(1, &ct, s(950.), &If97).unwrap();
        assert_eq!(q.mode, "film");
        println!(
            "1 MPa, 950 K, film factor {factor}: native {:.2}, offline {expected:.2} W/m²",
            q.heat.value
        );
        assert!((q.heat.value - expected).abs() <= 1e-2 * expected);
    }
}

/// The embedded blocks against a wiki checkout's heater page.
#[test]
#[ignore = "requires LD01_WIKI_DIR, a Leitbild wiki checkout"]
fn heater_embedded_blocks_equal_the_wiki_strict_blocks() {
    let root = std::env::var_os("LD01_WIKI_DIR").expect("LD01_WIKI_DIR");
    let page = std::fs::read_to_string(
        std::path::Path::new(&root)
            .join("world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/heater-equipment.md"),
    )
    .unwrap();
    let block = |name: &str| -> serde_json::Value {
        let start = page.find(&format!("```{name}\n")).expect(name) + name.len() + 4;
        let end = start + page[start..].find("```").unwrap();
        serde_json::from_str(&page[start..end]).unwrap()
    };
    for (name, embedded) in [
        ("ld01-pzr-heater-banks", BANKS),
        ("reference-304-caloric", CALORIC),
        ("ld01-pzr-heater-contact", CONTACT),
    ] {
        let mine: serde_json::Value = serde_json::from_str(embedded).unwrap();
        assert_eq!(block(name), mine, "{name}");
    }
}

/// Metastable bulk liquid inside the bounded band is admitted unchanged:
/// the saturated-bulk onset applies, nucleate boiling acts once the wall
/// is above the liquid, and a wall between Tsat and T_L cools the liquid.
#[test]
fn heater_wet_law_admits_metastable_bulk_liquid_through_the_saturated_onset() {
    let c = cell();
    let h = heaters(&c);
    let contact: ContactBlock = serde_json::from_str(CONTACT).unwrap();
    let (chi, coefficient) = (
        contact.wet.wall_birth_fraction,
        contact.wet.sensible_coefficient_w_m2_k,
    );
    let p = 15e6;
    let ts = tsat(p);
    for superheat in [0.01, 0.1, 1., 2.] {
        let tl = ts + superheat;
        let point = If97.liquid(s(p), s(tl)).unwrap();
        let ct = h.liquid_contact_at(s(p), s(tl), point, &If97).unwrap();
        let hg = ct.saturation.vapor.enthalpy.value;
        // A wall between Tsat and the liquid: sensible cooling, no birth.
        let cool = h.wet_flux(1, &ct, s(ts + 0.5 * superheat), &If97).unwrap();
        assert_eq!(cool.mode, "sensible");
        assert!(cool.heat.value < 0. && cool.vapor_mass.value == 0.);
        // Above the liquid: nucleate with chi qb / (hg,sat − h_L).
        let wall = tl + 0.5;
        let hot = h.wet_flux(1, &ct, s(wall), &If97).unwrap();
        assert_eq!(hot.mode, "nucleate");
        let qb = hot.heat.value - coefficient * (wall - tl);
        let gamma = chi * qb / (hg - point.enthalpy.value);
        assert!((hot.vapor_mass.value - gamma).abs() <= 1e-12 * gamma);
        // The wall-temperature step at T_w = T_L that the shared wall <=
        // liquid branch leaves for strictly superheated bulk, reported.
        let at = h.wet_flux(1, &ct, s(tl), &If97).unwrap().heat.value;
        let above = h.wet_flux(1, &ct, s(tl.next_up()), &If97).unwrap();
        println!(
            "15 MPa, bulk {superheat} K above Tsat: q at T_w = T_L {at:.3e} W/m², just above {:.3e} W/m² ({})",
            above.heat.value, above.mode
        );
    }
}
