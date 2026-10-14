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
    post_trip_domain::admit_accepted(joined.nuclear(), extension, joined.travel(), t, 0.)
}
