//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-spine-at-power
//! The joined hot spine on the actual compiled packet, with maintained IF97.
//!
//! These are zero-time receipts and NOT-EVIDENCE probes of the joined
//! residual, not S2 gate runs: S2 is declared separately. A receipt is
//! written only to a new path, never over an existing file.
use leitbild_operating_plant::{
    joined::{self, census, nuclear::Nuclear, packet, solids::Solids},
    network::{Network, PzrPreparation, packet::Packet as NetworkPacket},
};
use leitbild_operating_water::If97;
use serde_json::{Value, json};
use std::path::Path;

/// The S1 harness's declared PZR preparation controls (s1_hydraulics.rs).
const PZR: PzrPreparation = PzrPreparation {
    pressure_tolerance_pa: 1e-6,
    max_passes: 50,
};

fn packet_bytes() -> (String, Vec<u8>) {
    let path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET")
        .expect("LD01_OPERATING_HOT_SPINE_PACKET names the compiled spine packet");
    let bytes = std::fs::read(&path).expect("packet");
    (path, bytes)
}

/// App and wiki provenance of a receipt: commits and whether the worktrees
/// were clean. The wiki is the archive or checkout named by `LD01_WIKI_ROOT`.
fn provenance() -> Value {
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    };
    let wiki = std::env::var("LD01_WIKI_ROOT").ok();
    json!({
        "app_commit": git(&["rev-parse", "HEAD"]),
        "app_worktree_dirty": !git(&["status", "--porcelain"]).is_empty(),
        "wiki": wiki,
        "wiki_commit": wiki.as_ref().map(|w| git(&["-C", w, "rev-parse", "HEAD"])),
    })
}

/// Write a receipt to a NEW file named by `LD01_JOINED_RECEIPT`, if set.
fn write_receipt(receipt: &Value) {
    if let Some(path) = std::env::var_os("LD01_JOINED_RECEIPT") {
        let path = Path::new(&path);
        assert!(
            !path.exists(),
            "receipts are never overwritten: {}",
            path.display()
        );
        std::fs::write(path, serde_json::to_vec_pretty(receipt).unwrap()).unwrap();
    }
}

#[test]
#[ignore = "requires the actual compiled spine packet and maintained IF97"]
fn joined_census_against_table_1_1() {
    let (path, bytes) = packet_bytes();
    let network_packet: NetworkPacket = serde_json::from_slice(&bytes).expect("network packet");
    let joined_packet: packet::Packet = serde_json::from_slice(&bytes).expect("joined packet");
    let (network, prepared) = Network::new(&network_packet, If97, &PZR).expect("network");
    let cells = network.cell_layout.len();
    let nuclear = Nuclear::new(&joined_packet, cells).expect("nuclear block");
    let solids = Solids::new(&joined_packet, cells).expect("solids block");
    let network_layout = joined::network_layout(&network);
    network_layout.validate("network").unwrap();
    let ids = |l: &joined::block::Layout| l.ids();
    let (n_ids, k_ids, s_ids) = (
        prepared.differential.clone(),
        ids(nuclear.layout()),
        ids(solids.layout()),
    );
    assert_eq!(n_ids, ids(&network_layout), "network identity");
    let c = census::census(
        &[
            census::Composed {
                owner: "network",
                layout: &network_layout,
                differential: &n_ids,
            },
            census::Composed {
                owner: "nuclear",
                layout: nuclear.layout(),
                differential: &k_ids,
            },
            census::Composed {
                owner: "solids",
                layout: solids.layout(),
                differential: &s_ids,
            },
        ],
        &[joined::pending_secondary(), joined::pending_rods()],
    );
    let row = |name: &str| {
        c.entries
            .iter()
            .find(|e| e.row.starts_with(name))
            .unwrap_or_else(|| panic!("row {name}"))
            .clone()
    };
    assert_eq!(row("Regional N").composed, Some([24, 0]));
    assert_eq!(row("Material precursors").composed, Some([2316, 0]));
    assert_eq!(row("Fissile, fertile").composed, Some([2316, 0]));
    assert_eq!(row("Delayed-energy").composed, Some([9650, 0]));
    assert_eq!(row("Fuel 2 + clad 1").composed, Some([1158, 0]));
    assert_eq!(row("Massless").composed, Some([0, 1158]));
    assert_eq!(row("Helium").composed, Some([193, 0]));
    assert_eq!(row("Guide/plenum").composed, Some([1351, 0]));
    assert_eq!(row("SG metal").composed, Some([8, 0]));
    assert_eq!(row("Network cells").composed, Some([151, 34]));
    assert_eq!(row("Network faces").composed, Some([70, 0]));
    assert_eq!(row("RCP rotors").composed, Some([4, 0]));
    assert_eq!(c.composed, [17241, 1192, 18433]);
    assert_eq!(c.with_pending, [17301, 1300, 18601]);
    let histories = nuclear.histories();
    assert_eq!(histories.len(), 9650);
    let receipt = json!({
        "kind": "s2-joined-census",
        "status": "NOT-EVIDENCE zero-time allocation; no residual evaluated, no trajectory",
        "packet": path,
        "packet_sha256": sha256(&bytes),
        "packet_identity": joined_packet.identity,
        "provenance": provenance(),
        "census": c,
        "linear_histories": {
            "rows": histories.len(),
            "structure": "E' = y F - lambda E: constant diagonal -lambda and constant feed coefficient y; feed = the carrier's achieved fissions (23 groups) or fertile captures (2 groups)",
            "decay_per_s_range": [
                histories.iter().map(|h| h.decay_per_s).fold(f64::INFINITY, f64::min),
                histories.iter().map(|h| h.decay_per_s).fold(0., f64::max)
            ]
        },
        "network": {"dimension": network.dimension(), "regular_cells": cells, "faces": network.face_count(), "rotors": network.rotor_count()},
    });
    println!("{}", serde_json::to_string(&receipt).unwrap());
    write_receipt(&receipt);
}

fn sha256(bytes: &[u8]) -> String {
    let out = std::process::Command::new("shasum")
        .args(["-a", "256"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            child.stdin.take().unwrap().write_all(bytes)?;
            child.wait_with_output()
        })
        .expect("shasum");
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_string()
}
