//! The S2 credited outputs at one state, read from the joined operator's
//! evaluation at that state (the caller evaluates; the account's evaluation
//! serves), and D3 (a)'s admission of the state (SPECTRUM's predicate,
//! `joined::post_trip_domain::admit_accepted`).
//!
//! | Key | Instances | Definition |
//! | --- | --- | --- |
//! | `core_power_w` | 1 | nuclear heat released (`heats().nuclear.released_w`) |
//! | `regional_fraction` | regions | region i's induced fissions `Σ_{k∈i} g_k N_i` over the core's, `g_k` the support's fissions per population |
//! | `fuel_doppler_k` | regions | production-weighted fuel temperature in the Doppler measure: `(Σ_{k∈i} g_k √T_{a(k)} / Σ_{k∈i} g_k)²`, `T_a` the carrier's `[mean √T]²` |
//! | `core_cell_k` | CORE.* cells | cell liquid temperature from its (p, u) |
//! | `average_coolant_k` | 1 | mass-weighted mean temperature of the 27 primary cells (every regular cell but SURGE) |
//! | `pzr_roof_pa`, `pzr_level_m` | 1 | the stratified cell's PT1 and collapsed level |
//! | `core_dp_pa` | 1 | LOWER less UPPER cell pressure (S1) |
//! | `loop_flow_kg_s` | 2 | RETURN.A->DOWN and RETURN.B->DOWN mass flow |
//! | `sg_pressure_pa`, `sg_liquid_m3` | SGs | each SG's `p_s` and `V_l` |
//! | `rod_travel_m` | clusters | achieved travel (trip runs only) |
use leitbild_operating_plant::{
    joined::{
        operator::Joined,
        post_trip_domain::{self, Admission, Extension},
    },
    network::{Properties, packet::Packet as NetworkPacket},
};
use leitbild_operating_water::If97;
use serde_json::{Value, json};

use super::compare::key;

/// Where each credited output lives in the composed operator.
#[derive(Clone, Debug)]
pub struct Reader {
    /// Per regular network cell: (primary, core).
    cells: Vec<(bool, bool)>,
    loop_faces: [usize; 2],
    lower: usize,
    upper: usize,
    /// Joined coordinates of each SG's `p_s` and `V_l`, with their scales.
    sg_pressure: Vec<(usize, f64)>,
    sg_liquid: Vec<(usize, f64)>,
    /// First rod coordinate, clusters, and the travel scales.
    rods: (usize, usize, Vec<f64>),
    pub reference_travel_m: f64,
    supports: Vec<(usize, usize)>,
    regions: usize,
}

impl Reader {
    pub fn new(
        joined: &Joined<If97>,
        packet: &NetworkPacket,
        reference_travel_m: f64,
    ) -> Result<Self, String> {
        let regions = &packet.mechanics.regions;
        let cells = joined
            .network
            .cell_layout
            .iter()
            .enumerate()
            .map(|(c, _)| {
                let id = regions[c].id.as_str();
                (id != "SURGE", id.starts_with("CORE."))
            })
            .collect();
        let face = |id: &str| {
            packet
                .mechanics
                .faces
                .iter()
                .position(|f| f.id == id)
                .ok_or_else(|| format!("no face {id}"))
        };
        let region = |id: &str| {
            regions
                .iter()
                .position(|r| r.id == id)
                .ok_or_else(|| format!("no region {id}"))
        };
        let (mut sg_pressure, mut sg_liquid) = (Vec::new(), Vec::new());
        let mut k = 0;
        for (owner, layout) in joined.layouts() {
            for (i, label) in layout.labels.iter().enumerate() {
                if owner == "secondary" && label.ends_with(".p_s") {
                    sg_pressure.push((k, layout.scales[i]));
                }
                if owner == "secondary" && label.ends_with(".V_l") {
                    sg_liquid.push((k, layout.scales[i]));
                }
                k += 1;
            }
        }
        if k != joined.dimension() || sg_pressure.is_empty() || sg_liquid.len() != sg_pressure.len()
        {
            return Err(format!(
                "layouts cover {k} of {} coordinates with {} SG pressures and {} liquid volumes",
                joined.dimension(),
                sg_pressure.len(),
                sg_liquid.len()
            ));
        }
        let o = joined.offsets();
        // The rods' block ends where the PZR block (G6) begins.
        let clusters = (o.pzr - o.rods) / 3;
        let scales = joined.scales();
        let travel_scales = (0..clusters).map(|c| scales[o.rods + 3 * c]).collect();
        let nuclear = joined.nuclear();
        Ok(Self {
            cells,
            loop_faces: [face("RETURN.A->DOWN")?, face("RETURN.B->DOWN")?],
            lower: region("LOWER")?,
            upper: region("UPPER")?,
            sg_pressure,
            sg_liquid,
            rods: (o.rods, clusters, travel_scales),
            reference_travel_m,
            supports: nuclear
                .supports()
                .iter()
                .map(|s| (s.region, s.material))
                .collect(),
            regions: nuclear.regions(),
        })
    }

    pub fn clusters(&self) -> usize {
        self.rods.1
    }

    /// The credited outputs of the operator's last evaluation at `y`.
    pub fn read(
        &self,
        joined: &Joined<If97>,
        y: &[f64],
        rods: bool,
    ) -> Result<Vec<(&'static str, Vec<f64>)>, String> {
        let net = &joined.network;
        let scales = net.scales();
        let (mut mass, mut weighted, mut core) = (0., 0., Vec::new());
        for (c, l) in net.cell_layout.iter().enumerate() {
            let p = y[l.base] * scales[l.base];
            let m = y[l.mass[0]] * scales[l.mass[0]];
            let u = y[l.energy[0]] * scales[l.energy[0]];
            let q = net
                .properties()
                .caloric(false, p, u / m, false)
                .map_err(|e| format!("cell {c} caloric: {e:?}"))?;
            let temperature = net.properties().values(&q).temperature_k;
            let (primary, in_core) = self.cells[c];
            if primary {
                mass += m;
                weighted += m * temperature;
            }
            if in_core {
                core.push(temperature);
            }
        }
        let taps = net.pzr_taps().map_err(|e| format!("PZR taps: {e:?}"))?;
        let loops = self
            .loop_faces
            .iter()
            .map(|f| {
                net.chart(*f, 0)
                    .map(|c| c.mass_flow_kg_s.value)
                    .ok_or_else(|| format!("no chart on face {f}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let nuclear = joined.nuclear();
        let output = nuclear
            .feedback_output()
            .ok_or("the nuclear block has no evaluation")?;
        let inputs = nuclear.feedback_inputs();
        let g: Vec<f64> = output
            .fissions_per_population_s
            .iter()
            .map(|s| s.value)
            .collect();
        if g.len() != self.supports.len() || inputs.neutrons.len() != self.regions {
            return Err("the feedback output is not the compiled supports' layout".into());
        }
        // The supports' order is the feedback output's: each carrier's
        // fissions recombine from them.
        let mut carrier = vec![0.; output.carrier_fissions_per_s.len()];
        let mut fissions = vec![0.; self.regions];
        let (mut weight, mut root_t) = (vec![0.; self.regions], vec![0.; self.regions]);
        for (k, (i, a)) in self.supports.iter().enumerate() {
            let f = g[k] * inputs.neutrons[*i];
            carrier[*a] += f;
            fissions[*i] += f;
            weight[*i] += g[k];
            root_t[*i] += g[k] * inputs.fuel_temperature_k[*a].sqrt();
        }
        for (a, f) in carrier.iter().enumerate() {
            let expected = output.carrier_fissions_per_s[a].value;
            if (f - expected).abs() > 1e-10 * expected.abs().max(1.) {
                return Err(format!(
                    "carrier {a}'s fissions {f} do not recombine from the supports ({expected})"
                ));
            }
        }
        let total: f64 = fissions.iter().sum();
        let fractions = fissions.iter().map(|f| f / total).collect();
        let doppler = root_t
            .iter()
            .zip(&weight)
            .map(|(r, w)| (r / w).powi(2))
            .collect();
        let mut out = vec![
            (
                key::CORE_POWER_W,
                vec![joined.heats().nuclear.released_w.value],
            ),
            (key::REGIONAL_FRACTION, fractions),
            (key::FUEL_DOPPLER_K, doppler),
            (key::CORE_CELL_K, core),
            (key::AVERAGE_COOLANT_K, vec![weighted / mass]),
            (key::PZR_ROOF_PA, vec![taps.pt1_pa.value]),
            (key::PZR_LEVEL_M, vec![taps.collapsed_level_m.value]),
            (
                key::CORE_DP_PA,
                vec![net.cell(self.lower).pressure.value - net.cell(self.upper).pressure.value],
            ),
            (key::LOOP_FLOW_KG_S, loops),
            (
                key::SG_PRESSURE_PA,
                self.sg_pressure.iter().map(|(k, s)| y[*k] * s).collect(),
            ),
            (
                key::SG_LIQUID_M3,
                self.sg_liquid.iter().map(|(k, s)| y[*k] * s).collect(),
            ),
        ];
        if rods {
            let (offset, clusters, scales) = &self.rods;
            out.push((
                key::ROD_TRAVEL_M,
                (0..*clusters)
                    .map(|c| y[offset + 3 * c] * scales[c])
                    .collect(),
            ));
        }
        Ok(out)
    }
}

/// The credited outputs defined on the network's cell-pressure coordinates
/// (the class S2-D24r's sensitivities are taken on), each with the joined
/// coordinates it reads: `core_dp_pa` = p(LOWER) − p(UPPER), as
/// [`Reader::read`] computes it. No other credited output is one: the PZR
/// roof is a tap of the stratified column and the SG pressures are the
/// secondary's `p_s`.
pub fn cell_pressure_outputs(
    joined: &Joined<If97>,
    packet: &NetworkPacket,
) -> Result<Vec<(&'static str, Vec<usize>)>, String> {
    let base = |id: &str| {
        packet
            .mechanics
            .regions
            .iter()
            .position(|r| r.id == id)
            .and_then(|c| joined.network.cell_layout.get(c))
            .map(|l| l.base)
            .ok_or_else(|| format!("no regular cell {id}"))
    };
    Ok(vec![(
        key::CORE_DP_PA,
        vec![base("LOWER")?, base("UPPER")?],
    )])
}

/// D3 (a)'s record: the packet's `post_trip_domain` section, or for a
/// packet compiled before it (9eb6e37d) the source compiler's output for
/// the same wiki in the file `LD01_POST_TRIP_DOMAIN` (as SPECTRUM reads it).
pub fn extension(raw: &Value) -> Result<(Extension, Value), String> {
    if let Some(section) = raw.get("post_trip_domain") {
        let e = serde_json::from_value(section.clone())
            .map_err(|e| format!("post_trip_domain: {e}"))?;
        return Ok((e, json!({"source": "packet section post_trip_domain"})));
    }
    let file = std::env::var("LD01_POST_TRIP_DOMAIN").map_err(|_| {
        "pre-D3 packet: LD01_POST_TRIP_DOMAIN names the compiled post_trip_domain section"
            .to_string()
    })?;
    let bytes = std::fs::read(&file).map_err(|e| format!("{file}: {e}"))?;
    Ok((
        serde_json::from_slice(&bytes).map_err(|e| format!("{file}: {e}"))?,
        json!({"source": "compiled section file (pre-D3 packet)", "file": file,
            "sha256": crate::provenance::sha256_file(&file)?}),
    ))
}

/// D3 (a) at the operator's last evaluation at `t`.
pub fn admit(
    joined: &Joined<If97>,
    extension: &Extension,
    t: f64,
) -> Result<Admission, post_trip_domain::Error> {
    // Owner answer B1: the regions' coolant phase at the same evaluation.
    let phase = joined
        .region_phases()
        .map_err(|f| post_trip_domain::Error::Phase(format!("{f:?}")))?;
    post_trip_domain::admit_accepted(joined.nuclear(), &phase, extension, joined.travel(), t, 0.)
}

/// D3 (a) at one sample, for every owner option (the operator evaluated
/// there): the compiled-domain admission, and the source-free operator's
/// margin `delta*` (Δk/k, the smallest real eigenvalue of the 24 × 24
/// pencil `(M, diag(1/Λ))` by stock `dggev`) with the record's doubled water
/// term and with the nominal one, beside the densities and pressures that
/// bound the domains. The S2-10 probe's measure (`s2_trip_probe::d3_at`).
pub fn d3_point(
    joined: &Joined<If97>,
    extension: &Extension,
    reference_density: &[f64],
    t: f64,
    origin: f64,
) -> Value {
    use leitbild_operating_plant::source_feedback as sf;
    let n = joined.nuclear();
    let at = post_trip_domain::AcceptedConditions::of(n, joined.travel(), t);
    let feedback = n.feedback();
    let mut out = sf::Output::new(
        feedback.region_count(),
        feedback.material_count(),
        feedback.support_count(),
    );
    let original = match feedback.validate_accepted(&at.neutrons, at.conditions(), t, &mut out) {
        Ok(()) => json!("inside"),
        Err(e) => json!(format!("{e:?}")),
    };
    let margin = |e: &Extension| -> Value {
        match post_trip_domain::margin_at(
            feedback,
            n.kinetics(),
            post_trip_domain::fixed(n),
            &at.neutrons,
            at.conditions(),
            e,
        ) {
            Ok(m) => {
                let r = m.reactivity_gain.len();
                let mut g = vec![0.; r * r];
                for i in 0..r {
                    g[i * r + i] = m.reactivity_gain[i];
                }
                let delta = leitbild_operating_water::spectrum::decompose(r, &m.operator, &g)
                    .map(|s| {
                        s.modes
                            .iter()
                            .map(|x| x.lambda.re)
                            .fold(f64::INFINITY, f64::min)
                    })
                    .ok();
                json!({"holds": m.holds, "margin_dk_k": delta})
            }
            Err(e) => json!({"error": format!("{e:?}")}),
        }
    };
    let mut nominal = *extension;
    nominal.margin_water_term_factor = 1.;
    let water = joined.region_water();
    let ratio = water
        .iter()
        .zip(reference_density)
        .map(|(w, r)| w.density_kg_m3.value / r)
        .fold(f64::NEG_INFINITY, f64::max);
    let pressure = water
        .iter()
        .map(|w| w.pressure_pa.value)
        .fold(f64::INFINITY, f64::min);
    json!({"t_s": t - origin, "original_domain": original, "density_ratio_max": ratio,
        "pressure_min_pa": pressure,
        "margin_water_doubled": margin(extension), "margin_water_nominal": margin(&nominal)})
}

/// The regions' reference water densities of the source feedback (the
/// packet's `feedback_metadata.regions[].reference_density_kg_m3`), for
/// D3 (a)'s density ratio.
pub fn reference_densities(raw: &Value) -> Result<Vec<f64>, String> {
    raw["feedback_metadata"]["regions"]
        .as_array()
        .ok_or("the packet has no feedback_metadata.regions")?
        .iter()
        .map(|r| {
            r["reference_density_kg_m3"]
                .as_f64()
                .ok_or_else(|| "a region without reference_density_kg_m3".to_string())
        })
        .collect()
}
