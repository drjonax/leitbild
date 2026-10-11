//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#6-solver-properties-and-cost-obligations
//! Block stage-Jacobian pieces of the joined hot spine.
//!
//! The nuclear block's rows are linear in their stores for fixed inputs, so
//! its Jacobian is assembled from the same laws without seeded evaluation:
//! the constant linear template of the precursor and history rows
//! ([`Nuclear::linear_template`]), the kinetics' fixed-input entries, and
//! the exact partials of the inputs it reads (the source feedback's
//! reactivity and fission conversion, `sf::Model::partials`; the capture,
//! poison and history models' exact tangents along unit directions). Every
//! value is the residual's own at the same state; nothing is held beyond
//! one assembly and nothing falls back to another assembly.
use super::nuclear::{Nuclear, RegionWater};
use crate::{kinetics, network::Failure, poisons, source_feedback as sf, thermal::Scalar};

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn trial(reason: impl std::fmt::Display) -> Failure {
    Failure::Recoverable(format!("joined block Jacobian: {reason}"))
}
fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("joined block Jacobian: {}", reason.into()))
}

/// The nuclear block's non-template partials at one state, in physical
/// right-hand-side units per physical input unit (each row is
/// `x' - rhs`), with global joined indices.
#[derive(Clone, Debug, Default)]
pub struct NuclearPartials {
    /// Per template feed (`2a` fissions, `2a + 1` fertile captures):
    /// `(global column, d feed / d x)`.
    pub feeds: Vec<Vec<(usize, f64)>>,
    /// `(global row, global column, d rhs / d x)` of the regional
    /// population and material rows over populations and materials; the
    /// template's constant entries are not repeated. Duplicates add.
    pub own: Vec<(usize, usize, f64)>,
    /// `(global row, carrier, d rhs / d fuel feedback temperature)`.
    pub fuel_t: Vec<(usize, usize, f64)>,
    /// `(global row, region, d rhs / d [water density, boron ppm, pressure,
    /// liquid temperature])`.
    pub water: Vec<(usize, usize, [f64; 4])>,
    /// `(global row, rod cluster, d rhs / d achieved travel)`.
    pub travel: Vec<(usize, usize, f64)>,
    /// `(carrier, global column, d fuel heat / d x)`, non-template.
    pub fuel_w: Vec<(usize, usize, f64)>,
    /// `(carrier, global column, d direct coolant heat / d x)`.
    pub coolant_w: Vec<(usize, usize, f64)>,
}

/// The nuclear block's partials at `x` (its own physical coordinates, in
/// layout order) and the port values `fuel_t`, `water` and `travel` that
/// [`Nuclear::rows`] reads, at simulated time `t`; `offset` is the block's
/// first global coordinate.
#[allow(clippy::too_many_arguments)] // One block's stage: its coordinates and three ports.
pub fn nuclear_partials(
    nuclear: &Nuclear,
    offset: usize,
    t: f64,
    x: &[f64],
    fuel_t: &[f64],
    water: &[RegionWater],
    travel: &[f64],
    out: &mut NuclearPartials,
) -> Result<(), Failure> {
    let (r, a) = (nuclear.regions(), nuclear.carriers());
    let k = nuclear.coefficients();
    let feedback = nuclear.feedback();
    let kinetics = nuclear.kinetics();
    let supports = nuclear.supports();
    if x.len() != nuclear.layout().len()
        || fuel_t.len() != a
        || water.len() != r
        || travel.len() != feedback.rod_count()
    {
        return Err(fatal("nuclear partials stage length"));
    }
    let m0 = r + kinetics::DELAYED_GROUPS * a;
    let material = |c: usize, m: usize| m0 + 6 * c + m;
    // The same conditions Nuclear::rows composes, as values.
    let neutrons: Vec<Scalar> = (0..r).map(|i| s(x[i])).collect();
    let fuel: Vec<Scalar> = fuel_t.iter().map(|v| s(*v)).collect();
    let density: Vec<Scalar> = water.iter().map(|w| s(w.density_kg_m3.value)).collect();
    let boron: Vec<Scalar> = water.iter().map(|w| s(w.boron_ppm_eq.value)).collect();
    let pressure: Vec<Scalar> = water.iter().map(|w| s(w.pressure_pa.value)).collect();
    let moderator: Vec<Scalar> = water.iter().map(|w| s(w.temperature_k.value)).collect();
    let fissile: Vec<Scalar> = (0..a).map(|c| s(x[material(c, 0)])).collect();
    let xenon: Vec<Scalar> = (0..a).map(|c| s(x[material(c, 3)])).collect();
    let samarium: Vec<Scalar> = (0..a).map(|c| s(x[material(c, 5)])).collect();
    let opacity: Vec<Scalar> = (0..a)
        .map(|c| s(k.capture.cross_section_m2) * (s(x[material(c, 1)]) - s(k.reference_fertile[c])))
        .collect();
    let rods: Vec<Scalar> = travel.iter().map(|v| s(*v)).collect();
    let conditions = sf::Conditions {
        fuel_temperature_k: &fuel,
        water_density_kg_m3: &density,
        boron_ppm_eq: &boron,
        pressure_pa: &pressure,
        moderator_temperature_k: &moderator,
        fissile_atoms: &fissile,
        xenon_atoms: &xenon,
        samarium_atoms: &samarium,
        capture_loss_change_m2: &opacity,
        achieved_rod_travel_m: &rods,
        capsule_age_s: s(k.capsule_age0_s + t),
    };
    let mut values = sf::Output::new(r, a, supports.len());
    feedback
        .evaluate(&neutrons, conditions, &mut values)
        .map_err(trial)?;
    let mut fp = sf::Partials::default();
    feedback.partials(conditions, &mut fp).map_err(trial)?;
    // Kinetics at the same inputs.
    let regions: Vec<kinetics::RegionInput> = values
        .regions
        .iter()
        .map(|v| kinetics::RegionInput {
            reactivity: v.reactivity.value,
            external_source_per_s: v.external_source_per_s.value,
        })
        .collect();
    let production: Vec<f64> = values
        .fissions_per_population_s
        .iter()
        .map(|g| g.value)
        .collect();
    let inputs = kinetics::Inputs {
        regions: &regions,
        transfer_rates_per_s: k.transfer_rates_per_s,
        fissions_per_population_s: &production,
        emission_fractions: k.emission_fractions,
        outside_fractions: k.outside_fractions,
    };
    out.feeds.clear();
    out.feeds.resize(2 * a, Vec::new());
    out.own.clear();
    out.fuel_t.clear();
    out.water.clear();
    out.travel.clear();
    out.fuel_w.clear();
    out.coolant_w.clear();
    // Fixed-input population entries over populations; the precursor rows
    // and the precursor columns of the population rows are the template's.
    kinetics
        .state_jacobian_entries(inputs, |row, column, v| {
            if row < r && column < r {
                out.own.push((offset + row, offset + column, v));
            }
        })
        .map_err(trial)?;
    // d N_i' / d rho_i = N_i / Lambda_i: the model's own reactivity action.
    let state: Vec<f64> = x[..m0].to_vec();
    let zero_state = vec![0.; m0];
    let zero_regions = vec![
        kinetics::RegionInput {
            reactivity: 0.,
            external_source_per_s: 0.
        };
        r
    ];
    let zero_transfer = vec![0.; k.transfer_rates_per_s.len()];
    let zero_production = vec![0.; production.len()];
    let zero_emission = vec![0.; k.emission_fractions.len()];
    let zero_outside = vec![0.; k.outside_fractions.len()];
    let mut rates = vec![0.; m0];
    let mut fissions = vec![0.; a];
    let mut per_reactivity = vec![0.; r];
    for i in 0..r {
        let mut d = zero_regions.clone();
        d[i].reactivity = 1.;
        kinetics
            .directional_derivative(
                &state,
                inputs,
                &zero_state,
                kinetics::Inputs {
                    regions: &d,
                    transfer_rates_per_s: &zero_transfer,
                    fissions_per_population_s: &zero_production,
                    emission_fractions: &zero_emission,
                    outside_fractions: &zero_outside,
                },
                &mut rates,
                &mut fissions,
            )
            .map_err(trial)?;
        per_reactivity[i] = rates[i];
    }
    let beta: Vec<f64> = k
        .delayed_yields_per_fission
        .iter()
        .map(|y| y.iter().sum())
        .collect();
    // Per carrier: d F / d fissile = sum_k dG_k/dfissile N_i(k).
    let mut fission_fissile = vec![0.; a];
    for (sk, sp) in supports.iter().zip(&fp.supports) {
        fission_fissile[sk.material] += sp.production_fissile * x[sk.region];
    }
    // Population rows: reactivity and conversion chains.
    for (sk, sp) in supports.iter().zip(&fp.supports) {
        let (i, c) = (sk.region, sk.material);
        let row = offset + i;
        let coef = per_reactivity[i];
        out.fuel_t.push((row, c, coef * sp.fuel_temperature));
        out.own.push((
            row,
            offset + material(c, 0),
            coef * sp.fissile - beta[c] * x[i] * sp.production_fissile,
        ));
        out.own.push((
            row,
            offset + material(c, 1),
            coef * sp.capture_loss * k.capture.cross_section_m2,
        ));
        out.own
            .push((row, offset + material(c, 3), coef * sp.xenon));
        out.own
            .push((row, offset + material(c, 5), coef * sp.samarium));
    }
    for (i, rp) in fp.regions.iter().enumerate() {
        let coef = per_reactivity[i];
        out.water.push((
            offset + i,
            i,
            [coef * rp.water_density, coef * rp.boron, 0., 0.],
        ));
        for (rod, d) in &rp.rods {
            out.travel.push((offset + i, *rod, coef * d));
        }
    }
    // Per carrier: fissions, captures, poisons and heats.
    let fission_model = k.fission;
    let mut prompt = vec![0.; fission_model.dimension()];
    let prompt_j = fission_model
        .tangent(&vec![0.; fission_model.dimension()], 1., &mut prompt)
        .map_err(trial)?
        .prompt_w;
    let mut by_carrier: Vec<Vec<usize>> = vec![Vec::new(); a];
    for (index, sk) in supports.iter().enumerate() {
        by_carrier[sk.material].push(index);
    }
    for c in 0..a {
        let fertile = x[material(c, 1)];
        let exposure = values.exposure_per_m2_s[c].value;
        let fissions_c = values.carrier_fissions_per_s[c].value;
        let fertile_d = k
            .capture
            .tangent(fertile, exposure, 1., 0.)
            .map_err(trial)?;
        let exposure_d = k
            .capture
            .tangent(fertile, exposure, 0., 1.)
            .map_err(trial)?;
        // d(any per-carrier quantity)/d columns through F and X.
        let through = |df: f64, dx: f64, extra: &mut Vec<(usize, f64)>| {
            for &index in &by_carrier[c] {
                let (sk, sp) = (supports[index], fp.supports[index]);
                extra.push((
                    offset + sk.region,
                    df * sp.production_per_s + dx * sp.exposure,
                ));
            }
            extra.push((offset + material(c, 0), df * fission_fissile[c]));
        };
        // Feeds.
        let mut fission_feed = Vec::new();
        through(1., 0., &mut fission_feed);
        out.feeds[2 * c] = fission_feed;
        let mut capture_feed = Vec::new();
        through(0., exposure_d.captures_per_s, &mut capture_feed);
        capture_feed.push((offset + material(c, 1), fertile_d.captures_per_s));
        out.feeds[2 * c + 1] = capture_feed;
        // Fissile row: rhs = -F.
        let mut entries = Vec::new();
        through(-1., 0., &mut entries);
        for (column, v) in entries.drain(..) {
            out.own.push((offset + material(c, 0), column, v));
        }
        // Fertile row: rhs = the capture target rate.
        through(0., exposure_d.target_rate_per_s, &mut entries);
        entries.push((offset + material(c, 1), fertile_d.target_rate_per_s));
        for (column, v) in entries.drain(..) {
            out.own.push((offset + material(c, 1), column, v));
        }
        // Poison rows: rhs = the poison rates at F and the Xe/Sm captures.
        let inventory = [2, 3, 4, 5].map(|m| x[material(c, m)]);
        let captures = [
            0.,
            k.xenon_cross_section_m2 * exposure,
            0.,
            k.samarium_cross_section_m2 * exposure,
        ];
        let input = poisons::Input {
            fissions_per_s: fissions_c,
            capture_per_s: captures,
        };
        let mut d = [0.; 4];
        for m in 0..4 {
            let mut e = [0.; 4];
            e[m] = 1.;
            k.poison
                .tangent(
                    &inventory,
                    input,
                    &e,
                    poisons::InputDirection {
                        fissions_per_s: 0.,
                        capture_per_s: [0.; 4],
                    },
                    &mut d,
                )
                .map_err(trial)?;
            for (row, v) in d.iter().enumerate() {
                out.own.push((
                    offset + material(c, 2 + row),
                    offset + material(c, 2 + m),
                    *v,
                ));
            }
        }
        let mut by_fission = [0.; 4];
        k.poison
            .tangent(
                &inventory,
                input,
                &[0.; 4],
                poisons::InputDirection {
                    fissions_per_s: 1.,
                    capture_per_s: [0.; 4],
                },
                &mut by_fission,
            )
            .map_err(trial)?;
        let mut by_exposure = [0.; 4];
        k.poison
            .tangent(
                &inventory,
                input,
                &[0.; 4],
                poisons::InputDirection {
                    fissions_per_s: 0.,
                    capture_per_s: [
                        0.,
                        k.xenon_cross_section_m2,
                        0.,
                        k.samarium_cross_section_m2,
                    ],
                },
                &mut by_exposure,
            )
            .map_err(trial)?;
        for row in 0..4 {
            through(by_fission[row], by_exposure[row], &mut entries);
            for (column, v) in entries.drain(..) {
                out.own.push((offset + material(c, 2 + row), column, v));
            }
        }
        // Heats: prompt through F, binding through fertile, X, Xe and Sm.
        let pm = fp.materials[c];
        let binding_x = exposure_d.binding_w
            + k.xenon_binding_j * pm.xenon_capture_per_xenon * pm.xenon
            + k.samarium_binding_j * pm.samarium_capture_per_samarium * pm.samarium;
        for (fraction_p, fraction_b, sink) in [
            (
                1. - k.prompt_coolant_fraction,
                1. - k.binding_coolant_fraction,
                &mut out.fuel_w,
            ),
            (
                k.prompt_coolant_fraction,
                k.binding_coolant_fraction,
                &mut out.coolant_w,
            ),
        ] {
            through(fraction_p * prompt_j, fraction_b * binding_x, &mut entries);
            entries.push((offset + material(c, 1), fraction_b * fertile_d.binding_w));
            entries.push((
                offset + material(c, 3),
                fraction_b * k.xenon_binding_j * pm.xenon_capture_per_xenon * exposure,
            ));
            entries.push((
                offset + material(c, 5),
                fraction_b * k.samarium_binding_j * pm.samarium_capture_per_samarium * exposure,
            ));
            for (column, v) in entries.drain(..) {
                sink.push((c, column, v));
            }
        }
    }
    let finite = out
        .own
        .iter()
        .map(|e| e.2)
        .chain(out.fuel_t.iter().map(|e| e.2))
        .chain(out.water.iter().flat_map(|e| e.2))
        .chain(out.travel.iter().map(|e| e.2))
        .chain(out.fuel_w.iter().map(|e| e.2))
        .chain(out.coolant_w.iter().map(|e| e.2))
        .chain(out.feeds.iter().flatten().map(|e| e.1))
        .all(f64::is_finite);
    if !finite {
        return Err(trial("nonfinite nuclear partial"));
    }
    Ok(())
}
