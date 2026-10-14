//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-reference.md#steady-solid-state-at-the-reference-power
//! The steady solids preparation binary at its process boundary (G18,
//! S2-D2, S2-D3): a refusal writes nothing on stdout and exits nonzero, and
//! two runs on one packet write the same bytes.
#![cfg(feature = "ida")]
use std::{
    io::Write,
    process::{Command, Output, Stdio},
};

fn run(input: &[u8]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_prepare_steady_solids"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn prepare_steady_solids");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(input)
        .expect("write input");
    child.wait_with_output().expect("wait")
}

#[test]
fn a_refusal_writes_nothing_and_exits_nonzero() {
    for input in [&b"{}"[..], b"not json", b""] {
        let out = run(input);
        assert_eq!(out.status.code(), Some(1));
        assert!(out.stdout.is_empty());
        assert!(
            String::from_utf8_lossy(&out.stderr).starts_with("prepare_steady_solids refused: ")
        );
    }
}

#[test]
#[ignore = "requires LD01_OPERATING_HOT_SPINE_PACKET, the water library and the SUNDIALS build"]
fn two_runs_write_the_same_bytes() {
    let path =
        std::env::var("LD01_OPERATING_HOT_SPINE_PACKET").expect("LD01_OPERATING_HOT_SPINE_PACKET");
    let mut raw: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).expect("packet")).expect("packet json");
    let total = raw["thermal"]["source_total_w"]
        .as_f64()
        .expect("source total");
    let fluxes: Vec<serde_json::Value> = raw["thermal"]["secondaries"]
        .as_array()
        .expect("secondaries")
        .iter()
        .map(|g| serde_json::json!({"id": g["id"], "massFlux_kg_m2_s": 6972.5}))
        .collect();
    raw["steady"] = serde_json::json!({"basisPower_W": total,
        "coreMassFlux_kg_m2_s": 3725.0, "sgPrimaryMassFlux_kg_m2_s": fluxes});
    let input = serde_json::to_vec(&raw).unwrap();
    let (a, b) = (run(&input), run(&input));
    assert!(a.status.success(), "{}", String::from_utf8_lossy(&a.stderr));
    assert!(b.status.success());
    assert_eq!(a.stdout, b.stdout);
    let out: serde_json::Value = serde_json::from_slice(&a.stdout).expect("output json");
    assert_eq!(out["identity"], "LD01-STEADY-SOLIDS-1");
    assert_eq!(
        out["carriers"].as_array().unwrap().len(),
        raw["thermal"]["fuel_bands"].as_array().unwrap().len()
    );
    assert_eq!(
        out["sg_metal"].as_array().unwrap().len(),
        raw["thermal"]["sg_segments"].as_array().unwrap().len()
    );
}
