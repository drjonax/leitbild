//! Wiki strict blocks and receipt provenance shared by the S1 and S2
//! gate harnesses (moved unchanged from s1_hydraulics.rs): the single JSON
//! object of a fenced block, file hashes and the water build this binary
//! links, refused unless it is the one the receipt names.
//!
//! Include it with `#[path = "common/provenance.rs"] mod provenance;`.
#![allow(dead_code)] // Each test crate uses its own subset.
use leitbild_operating_plant::network::MetastableBand;
use serde::Deserialize;
use serde_json::Value;

/// The single JSON object inside one fenced strict block of a wiki page.
pub fn strict_block<T: for<'a> Deserialize<'a>>(page: &str, fence: &str) -> T {
    let text = std::fs::read_to_string(page).unwrap_or_else(|e| panic!("{page}: {e}"));
    let open = format!("```{fence}\n");
    let start = text
        .find(&open)
        .unwrap_or_else(|| panic!("{page} has no ```{fence} block"))
        + open.len();
    let end = start
        + text[start..]
            .find("\n```")
            .expect("unterminated strict block");
    serde_json::from_str(&text[start..end]).unwrap_or_else(|e| panic!("{fence}: {e}"))
}

/// The water build this binary links: build.rs links the IF97 archive in
/// `LD01_OPERATING_WATER_LIB_DIR`, and this test embeds that directory's
/// build receipt as it stood when the test was compiled.
pub const WATER_LIB_DIR: &str = env!("LD01_OPERATING_WATER_LIB_DIR");
pub const WATER_BUILD: &str = include_str!(concat!(
    env!("LD01_OPERATING_WATER_LIB_DIR"),
    "/water-build.json"
));
/// The water build's receipt in the exact layout
/// `reference-design-operating-water.ts` writes, parsed only to check it.
#[allow(dead_code)] // Parsed to check its exact layout; the S1 receipt carries the file itself.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WaterBuild {
    revision: String,
    header_sha256: String,
    license_sha256: String,
    adapter_sha256: String,
    library_sha256: String,
    platform: String,
    architecture: String,
    metastable_band: WaterBuildBand,
}
#[allow(dead_code)] // As for `WaterBuild`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WaterBuildBand {
    page: String,
    page_sha256: String,
    heading: String,
    fence: String,
    band: MetastableBand,
}
/// SHA-256 of a file, hex, by the system's `shasum`.
pub fn sha256_file(path: &str) -> Result<String, String> {
    let out = std::process::Command::new("shasum")
        .args(["-a", "256", path])
        .output()
        .map_err(|e| format!("shasum {path}: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    match text.split_whitespace().next() {
        Some(hash) if out.status.success() && hash.len() == 64 => Ok(hash.to_string()),
        _ => Err(format!(
            "shasum {path} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        )),
    }
}
/// The provenance of the water build this binary links, refused unless
/// sound: `receipt` (the receipt embedded at compile time) must still be
/// `directory`'s `water-build.json`, byte for byte; the directory's archive
/// must have the receipt's SHA-256, since the static archive is not
/// byte-reproducible and only its hash names the build; and the receipt's
/// band must be the packet's. Returns the receipt verbatim, parsed.
pub fn water_build(
    packet_band: &MetastableBand,
    receipt: &str,
    directory: &str,
) -> Result<Value, String> {
    let file = format!("{directory}/water-build.json");
    let on_disk = std::fs::read_to_string(&file).map_err(|e| format!("{file}: {e}"))?;
    if on_disk != receipt {
        return Err(format!(
            "{file} is not the build receipt this binary was compiled with"
        ));
    }
    let build: WaterBuild = serde_json::from_str(receipt).map_err(|e| format!("{file}: {e}"))?;
    let library = format!("{directory}/libld01_operating_water.a");
    let library_sha256 = sha256_file(&library)?;
    if library_sha256 != build.library_sha256 {
        return Err(format!(
            "{library} has SHA-256 {library_sha256}, not its receipt's {}",
            build.library_sha256
        ));
    }
    if build.metastable_band.band != *packet_band {
        return Err(format!(
            "the water build's band {:?} differs from the packet's {packet_band:?}",
            build.metastable_band.band
        ));
    }
    serde_json::from_str(receipt).map_err(|e| format!("{file}: {e}"))
}
