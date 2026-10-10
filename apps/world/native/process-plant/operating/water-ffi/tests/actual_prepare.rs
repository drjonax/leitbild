//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0013-coarse-local-pressure.md#mechanical-ownership-and-terminology
//! spec: world/packs/process-plant/reference-designs/ld-01/model/computational-design-review.md#pressure-realization-approved-10-october (exit 3: a consistent initial pair)
//! Maintained-IF97 hydrostatic preparation of an actual compiled packet at
//! its declared operating point, the stratified PZR cell at its declared
//! level. A receipt run that advances no time; it is not gate evidence.
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

fn summary(receipt: &Receipt) -> Value {
    let loops: Vec<Value> = receipt
        .faces
        .iter()
        .filter(|f| !f.tree)
        .map(|f| json!({"face":f.face,"rest_pa":f.rest_pa,"phase_pa":f.pressure_gravity_pa}))
        .collect();
    json!({"root":receipt.root_region,"port_pressure_pa":receipt.port_pressure_pa,"pzr":receipt.pzr,"passes":receipt.pass_changes_pa,"max_eos_row":receipt.max_eos_row,"max_tree_rest_pa":receipt.max_tree_rest_pa,"max_loop_rest_pa":receipt.max_loop_rest_pa,"max_phase_drive_pa":receipt.max_phase_drive_pa,"representation_offset":receipt.representation_offset,"mass_change_kg":receipt.mass_change_kg,"energy_change_j":receipt.energy_change_j,"tracer_change_kg_eq":receipt.tracer_change_kg_eq,"loop_faces":loops,"initial_rows":receipt.initial_rows,"rotor_states":receipt.rotor_states})
}

#[test]
#[ignore = "requires LD01_OPERATING_HOT_SPINE_PACKET and the maintained IF97 archive"]
fn actual_packet_prepares_at_its_declared_level() {
    let path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET").unwrap();
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
    let point = OperatingPoint::from(&packet.preparation.operating_point);
    let (_, prepared, receipt) = prepare(&packet, If97, &point, &rotors, &SETTINGS)
        .unwrap_or_else(|e| panic!("{point:?}: {e:?}"));
    let algebraic = prepared.differential.iter().filter(|v| **v == 0.).count();
    println!(
        "{}",
        json!({"kind":"actual-hydrostatic-preparation","packet":path,"declared":point,"coordinates":prepared.y.len(),"algebraic":algebraic,"receipt":summary(&receipt)})
    );
}
