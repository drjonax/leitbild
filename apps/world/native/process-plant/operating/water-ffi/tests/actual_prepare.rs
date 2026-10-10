//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0013-coarse-local-pressure.md#mechanical-ownership-and-terminology
//! spec: world/packs/process-plant/reference-designs/ld-01/model/computational-design-review.md#pressure-realization-approved-10-october (exit 3: a consistent initial pair)
//! Maintained-IF97 hydrostatic preparation of an actual compiled packet at
//! its declared operating point and at one level inside a PZR band. A
//! receipt run that advances no time; it is not gate evidence.
use leitbild_operating_plant::{
    network::{
        RotorState,
        packet::Packet,
        prepare::{OperatingPoint, Receipt, Settings, prepare},
    },
    rotor::{Shaft, SpeedRequest, Support},
};
use leitbild_operating_water::If97;
use serde_json::{Value, json};

const SETTINGS: Settings = Settings {
    pressure_tolerance_pa: 1e-6,
    max_passes: 30,
    level_match_m: 1e-9,
    eos_row_bound: 1e-12,
    tree_face_bound_pa: 1e-6,
    representation_search: 4,
};
/// Level inside PZR.3 (12.5..15.5 m) above the S1 packet's 6.5 m datum.
const INSIDE_BAND_LEVEL_M: f64 = 7.5;

fn summary(receipt: &Receipt) -> Value {
    let pzr: Vec<Value> = receipt
        .regions
        .iter()
        .filter(|r| r.id.starts_with("PZR."))
        .map(|r| {
            json!({"id":r.id,"pressure_pa":r.pressure_pa,"vapor_fraction":r.vapor_fraction,"liquid_kg":r.phases[0].map(|p|p.mass_kg),"vapor_kg":r.phases[1].map(|p|p.mass_kg),"tracer_kg_eq":r.tracer_kg_eq,"eos_row":r.eos_row})
        })
        .collect();
    let loops: Vec<Value> = receipt
        .faces
        .iter()
        .filter(|f| !f.tree)
        .map(|f| json!({"face":f.face,"rest_pa":f.rest_pa,"phase_pa":f.pressure_gravity_pa}))
        .collect();
    let phase_drives: Vec<Value> = receipt
        .faces
        .iter()
        .filter(|f| {
            f.pressure_gravity_pa
                .iter()
                .flatten()
                .any(|t| (t - f.rest_pa).abs() > 1e-6)
        })
        .map(|f| json!({"face":f.face,"tree":f.tree,"rest_pa":f.rest_pa,"phase_pa":f.pressure_gravity_pa}))
        .collect();
    json!({"surface_m":receipt.surface_elevation_m,"on_boundary":receipt.on_boundary,"root":receipt.root_region,"passes":receipt.pass_changes_pa,"max_eos_row":receipt.max_eos_row,"max_tree_rest_pa":receipt.max_tree_rest_pa,"max_loop_rest_pa":receipt.max_loop_rest_pa,"max_phase_drive_pa":receipt.max_phase_drive_pa,"representation_offset":receipt.representation_offset,"mass_change_kg":receipt.mass_change_kg,"energy_change_j":receipt.energy_change_j,"tracer_change_kg_eq":receipt.tracer_change_kg_eq,"pzr":pzr,"loop_faces":loops,"relative_phase_drives":phase_drives,"initial_rows":receipt.initial_rows,"rotor_states":receipt.rotor_states})
}

#[test]
#[ignore = "requires LD01_OPERATING_S1_PACKET and the maintained IF97 archive"]
fn actual_packet_prepares_at_its_declared_and_an_inside_band_level() {
    let path = std::env::var("LD01_OPERATING_S1_PACKET").unwrap();
    let packet: Packet = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let request = match packet
        .preparation
        .operating_point
        .rcp_speed_request
        .as_str()
    {
        "nominal" => SpeedRequest::Nominal,
        other => panic!("undeclared RCP speed request {other}"),
    };
    let pumps = packet
        .hydraulics
        .sections
        .iter()
        .filter(|s| s.parameters.pump.is_some())
        .count();
    let rotors = vec![
        RotorState {
            support: Support::Supported(request),
            shaft: Shaft::Free,
        };
        pumps
    ];
    let declared = OperatingPoint::from(&packet.preparation.operating_point);
    for point in [
        declared,
        OperatingPoint {
            pzr_level_m: INSIDE_BAND_LEVEL_M,
            ..declared
        },
    ] {
        let (_, _, receipt) = prepare(&packet, If97, &point, &rotors, &SETTINGS)
            .unwrap_or_else(|e| panic!("{point:?}: {e:?}"));
        println!(
            "{}",
            json!({"kind":"actual-hydrostatic-preparation","packet":path,"declared":point,"receipt":summary(&receipt)})
        );
        let mixed = receipt
            .regions
            .iter()
            .filter(|r| r.vapor_fraction > 0. && r.vapor_fraction < 1.)
            .count();
        assert_eq!(mixed, if receipt.on_boundary { 0 } else { 2 });
    }
}
