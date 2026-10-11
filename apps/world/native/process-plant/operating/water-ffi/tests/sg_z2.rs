//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-generation/thermodynamics.md#s2-secondary-block
//! Z2 zero-time receipt on the actual native laws: SG duty against secondary
//! pressure at 100% power, 6.0-6.6 MPa, and the emergent pressure where the
//! duty equals the constant A/B demand's duty. The SG primary cell is held at
//! its prepared state; each segment's stationary local wall balance is solved
//! with the same tube path, maintained IF97 and the same feed enthalpy the
//! block uses. No trajectory, no S2 gate. Writes the JSON body to
//! `LD01_OPERATING_SG_Z2_OUT`; the research driver adds provenance.
mod sg_harness;

use leitbild_operating_plant::{
    joined::block::SecondaryView,
    sg::{PrimaryPort, Secondaries, Segment, Tube},
    thermal::{self, Film, Scalar, WaterProperties},
};
use leitbild_operating_water::If97;
use serde_json::{Value, json};
use sg_harness::{prepared_stocks, probe, section};

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}

struct Sweep<'a> {
    tube: Tube,
    segments: Vec<Segment>,
    volume_m3: f64,
    crown_m3: f64,
    mass_kg: f64,
    feed_j_kg: f64,
    props: &'a If97,
}

impl Sweep<'_> {
    /// One SG at pressure p with the held inventory: chart liquid volume,
    /// per-segment stationary walls, duty and the demand's duty.
    fn at(&self, port: &PrimaryPort, p: f64, demand_kg_s: f64) -> Value {
        let sat = WaterProperties::saturation(self.props, s(p)).unwrap();
        let (rf, rg) = (sat.liquid.density.value, sat.vapor.density.value);
        let vl = (self.mass_kg - self.volume_m3 * rg) / (rf - rg);
        let view = SecondaryView {
            pressure: s(p),
            saturation_temperature: sat.temperature,
            liquid_volume: s(vl),
            steam_present: vl < self.volume_m3,
        };
        let walls: Vec<_> = self
            .segments
            .iter()
            .map(|g| self.tube.stationary(self.props, port, &view, g).unwrap())
            .collect();
        let duty: f64 = walls.iter().map(|w| w.metal_to_secondary_w).sum();
        let imbalance: f64 = walls
            .iter()
            .map(|w| (w.primary_to_metal_w - w.metal_to_secondary_w).abs())
            .fold(0., f64::max);
        let tp = port.temperature.value;
        let tw = walls[0].wall_k;
        let ts = sat.temperature.value;
        let hg = sat.vapor.enthalpy.value;
        json!({"secondaryPressure_Pa":p,"saturation_K":ts,"liquidVolume_m3":vl,"fullyWet":vl >= self.crown_m3,
            "wall_K":tw,"walls_K":walls.iter().map(|w| w.wall_k).collect::<Vec<_>>(),
            "dutyPerSG_W":duty,"largestSegmentImbalance_W":imbalance,
            "filmDrop_K":tp - tw,"boilingSuperheat_K":tw - ts,
            "primaryWholeAreaConductance_W_K":duty / (tp - tw),"secondaryEffectiveConductance_W_K":duty / (tw - ts),
            "primaryMode":walls[0].primary_mode,"secondaryWetMode":walls[0].secondary_wet_mode,
            "newtonIterations":walls.iter().map(|w| w.iterations).collect::<Vec<_>>(),
            "steamEnthalpy_J_kg":hg,"enthalpyRise_J_kg":hg - self.feed_j_kg,
            "demand_kg_s":demand_kg_s,"demandDuty_W":demand_kg_s * (hg - self.feed_j_kg),
            "dutyMinusDemand_W":duty - demand_kg_s * (hg - self.feed_j_kg)})
    }
    /// Root of f(p) on a sign-changing bracket by bisection to 1e-4 Pa.
    fn root(&self, f: impl Fn(f64) -> f64, mut lo: f64, mut hi: f64) -> (f64, usize) {
        let (mut flo, fhi) = (f(lo), f(hi));
        assert!(
            flo * fhi < 0.,
            "no sign change on [{lo}, {hi}]: {flo} {fhi}"
        );
        let mut iterations = 0;
        while hi - lo > 1e-4 {
            iterations += 1;
            let mid = 0.5 * (lo + hi);
            let fm = f(mid);
            if (fm > 0.) == (flo > 0.) {
                lo = mid;
                flo = fm;
            } else {
                hi = mid;
            }
        }
        (0.5 * (lo + hi), iterations)
    }
}

#[test]
#[ignore = "requires LD01_OPERATING_SG_SECTION, LD01_OPERATING_SG_PROBE and LD01_OPERATING_SG_Z2_OUT"]
fn z2_sg_duty_sweep_on_the_native_laws() {
    let (section, probe) = (section(), probe());
    let props = If97;
    let stocks = prepared_stocks(&props, &section, &probe);
    let block = Secondaries::new(&section, &stocks, &props).unwrap();
    let derived = block.derived();
    let sweep = Sweep {
        tube: Tube::new(&section.contact, probe.tube.thermal_diameter_m).unwrap(),
        segments: probe.segments.iter().map(Segment::from).collect(),
        volume_m3: section.steam_generators[0].volume_m3,
        crown_m3: section.steam_generators[0].crown_liquid_volume_m3,
        mass_kg: stocks[0].mass_kg,
        feed_j_kg: derived.feed_enthalpy_j_kg,
        props: &props,
    };
    let pressures: Vec<f64> = (0..=12).map(|k| 6.0e6 + 0.05e6 * k as f64).collect();
    let q = &probe.primary;
    let port_at = |t_k: f64, m: f64| {
        PrimaryPort::held(&props, q.pressure_pa, t_k, m / q.flow_area_m2).unwrap()
    };
    let duty = |port: &PrimaryPort, p: f64| sweep.at(port, p, 0.)["dutyPerSG_W"].as_f64().unwrap();
    let mut cases = Vec::new();
    // Station duties of the asymmetric handoff (model/station-balance.md,
    // actual asymmetric primary-PZR handoff), the earlier Z2's targets.
    let station = [1_508.617683e6, 1_508.610303e6];
    for (k, g) in section.steam_generators.iter().enumerate() {
        let port = port_at(q.temperature_k, q.mass_flow_kg_s[k]);
        let rows: Vec<Value> = pressures
            .iter()
            .map(|p| sweep.at(&port, *p, g.steam_demand_kg_s))
            .collect();
        let (emergent, it1) = sweep.root(
            |p| {
                sweep.at(&port, p, g.steam_demand_kg_s)["dutyMinusDemand_W"]
                    .as_f64()
                    .unwrap()
            },
            6.0e6,
            6.6e6,
        );
        let (station_root, it2) = sweep.root(|p| duty(&port, p) - station[k], 6.0e6, 6.6e6);
        cases.push(json!({"sg":g.id,"primary":{"pressure_Pa":q.pressure_pa,"temperature_K":q.temperature_k,
                "massFlow_kg_s":q.mass_flow_kg_s[k],"massFlux_kg_m2_s":q.mass_flow_kg_s[k] / q.flow_area_m2},
            "sweep":rows,
            "emergentAtDemand":{"bisections":it1,"state":sweep.at(&port, emergent, g.steam_demand_kg_s)},
            "atStationDuty":{"stationDuty_W":station[k],"bisections":it2,"state":sweep.at(&port, station_root, g.steam_demand_kg_s)}}));
    }
    // Sensitivity: the primary at the cycle-sizing outlet (thermodynamics.md,
    // distributed primary heat-transfer sizing), SG.A flow and demand.
    let sizing_outlet = 289.764953 + 273.15;
    let port = port_at(sizing_outlet, q.mass_flow_kg_s[0]);
    let g = &section.steam_generators[0];
    let (sens, _) = sweep.root(
        |p| {
            sweep.at(&port, p, g.steam_demand_kg_s)["dutyMinusDemand_W"]
                .as_f64()
                .unwrap()
        },
        5.9e6,
        6.6e6,
    );
    // Formulation comparisons with the wiki's HEOS figures (not checks of IF97).
    let sat6 = WaterProperties::saturation(&props, s(6e6)).unwrap();
    let sizing_wall = 282.675682 + 273.15;
    let wet = thermal::liquid_wall(
        &props,
        s(6e6),
        sat6.temperature,
        s(sizing_wall),
        s(0.),
        thermal::WallLaw {
            film: Film::External,
            ..sweep.tube.law()
        },
    )
    .unwrap();
    let film = thermal::liquid_wall(
        &props,
        s(14.7e6),
        s(320. + 273.15),
        s(sizing_wall),
        s(8_821.130657 / q.flow_area_m2),
        sweep.tube.law(),
    )
    .unwrap();
    // Heat into the fluid per area over (wall - liquid): a positive coefficient.
    let conductance = film.heat.value / (sizing_wall - (320. + 273.15)) * 5000.;
    let out = json!({
        "probe":"Z2 SG duty versus secondary pressure at 100% power on the native laws (zero time, stationary local wall balance per segment)",
        "laws":"sg::tube::Tube::segment_heat (thermal::liquid_wall_current, Film::Tube; thermal::secondary_wall) with maintained IF97 (water-ffi If97); demand duty with the block's IF97 feed enthalpy",
        "derived":derived,"heldInventory_kg":sweep.mass_kg,"cases":cases,
        "temperatureSensitivity":{"primaryTemperature_K":sizing_outlet,"sg":"A",
            "emergentAtDemand":sweep.at(&port, sens, g.steam_demand_kg_s)},
        "formulation":{"if97Saturation6MPa_C":sat6.temperature.value - 273.15,"wikiHeosSaturation6MPa_C":275.584989992,
            "wetFluxAtSizingWall_kW_m2":wet.heat.value / 1e3,"wikiHeosWetFlux_kW_m2":710.743388,"wetMode":wet.mode,
            "primaryConductance8821_MW_K":conductance / 1e6,"wikiHeosPrimaryConductance_MW_K":298.740935}
    });
    let path = std::env::var("LD01_OPERATING_SG_Z2_OUT").expect("LD01_OPERATING_SG_Z2_OUT");
    std::fs::write(&path, serde_json::to_string(&out).unwrap()).unwrap();
    for c in &cases {
        let e = &c["emergentAtDemand"]["state"];
        eprintln!(
            "SG.{} emergent p_s {:.3} Pa, duty {:.6} MW, demand {:.6} MW; station-duty p_s {:.3} Pa",
            c["sg"].as_str().unwrap(),
            e["secondaryPressure_Pa"].as_f64().unwrap(),
            e["dutyPerSG_W"].as_f64().unwrap() / 1e6,
            e["demandDuty_W"].as_f64().unwrap() / 1e6,
            c["atStationDuty"]["state"]["secondaryPressure_Pa"]
                .as_f64()
                .unwrap()
        );
        assert!(e["fullyWet"].as_bool().unwrap());
        assert!(
            e["largestSegmentImbalance_W"].as_f64().unwrap()
                <= 1e-9 * e["dutyPerSG_W"].as_f64().unwrap()
        );
    }
}
