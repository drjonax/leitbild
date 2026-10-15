//! The S2 gate run's guards, read from the declaration: the frozen-gates
//! pin (critic H4, RP1), the TBD register (a gate run refuses while any is
//! open), the remaining work-bound pre-check (critic M1) and the run caps by
//! the declared cap rule (critic H1).
//!
//! - **Pin.** The pinned value is the SHA-256 of the `ld01-s2-gates` block's
//!   *declared* form: its JSON with every value listed in `tbd` set to
//!   `null`, serialized canonically (object keys sorted, no whitespace,
//!   serde_json's shortest round-trip numbers). Filling a TBD is not a
//!   revision (revision 7, Tags), so the pin is invariant under fills and
//!   every other byte of meaning is pinned. The frozen value is read from the
//!   decision log (`LD01_S2_DECISION_LOG`, else the wiki's
//!   `decision-log.md`): the last table row whose ID starts with `RP1` and
//!   which names `ld01-s2-gates` and one 64-hex SHA-256. A gate run refuses
//!   unless the declared SHA equals it; a smoke run reports the comparison.
//! - **TBD register.** Every key of `tbd` names a dotted pointer into the
//!   block. A gate run refuses while any is `null`; a filled one must have
//!   its own decision-log row naming the key and a 64-hex receipt SHA-256.
//!   The last such row that no row supersedes counts: a row whose cell
//!   reads `Superseded: <ID>, ...` (a reopening, S2-F01r) removes those
//!   rows, so a reopened value needs a new fill row. A `null` in the block
//!   that `tbd` does not list refuses as undeclared.
//! - **Work bound.** `totalCpu_s` of process CPU covers every S2 receipt,
//!   run, reference, contrary case and S1 run 6. Before each run the
//!   remaining bound is compared with the run's total guard; a run that does
//!   not fit is not started, and S2 is then incomplete, not failed.
//! - **Caps.** A declared cap (`caps_cpu_s`) is read as data and checked
//!   against the cap rule's computable floor: at least 2 × the run's budget
//!   over its span, and for R1 at least `r1CapFloor_cpu_s`. The total guard
//!   is the cap plus 2 × observed samples × the per-sample observation cost.
use crate::gates::{Block, wiki_model};
use serde_json::{Value, json};

/// Canonical JSON: object keys sorted, no whitespace.
pub fn canonical(v: &Value) -> String {
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let body: Vec<String> = keys
                .iter()
                .map(|k| format!("{}:{}", Value::String((*k).clone()), canonical(&map[*k])))
                .collect();
            format!("{{{}}}", body.join(","))
        }
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        other => other.to_string(),
    }
}

/// SHA-256 of bytes, hex, by the system's `shasum` (as the file hashes).
pub fn sha256_bytes(bytes: &[u8]) -> Result<String, String> {
    use std::io::Write;
    let mut child = std::process::Command::new("shasum")
        .args(["-a", "256"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("shasum: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("shasum stdin")?
        .write_all(bytes)
        .map_err(|e| format!("shasum: {e}"))?;
    let out = child
        .wait_with_output()
        .map_err(|e| format!("shasum: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    match text.split_whitespace().next() {
        Some(h) if out.status.success() && h.len() == 64 => Ok(h.to_string()),
        _ => Err("shasum failed".into()),
    }
}

/// `a.b.c` → `/a/b/c`.
pub fn dotted_pointer(key: &str) -> String {
    format!("/{}", key.replace('.', "/"))
}

/// The TBD register of `ld01-s2-gates`: `(key, owning lane, value)`.
pub fn tbd_register(gates: &Block) -> Result<Vec<(String, String, Value)>, String> {
    let register = gates
        .value
        .get("tbd")
        .and_then(Value::as_object)
        .ok_or("ld01-s2-gates declares no tbd register")?;
    let mut out = Vec::new();
    for (key, lane) in register {
        let pointer = dotted_pointer(key);
        let value = gates
            .value
            .pointer(&pointer)
            .ok_or_else(|| format!("tbd lists {key}, which the block does not declare"))?
            .clone();
        out.push((
            key.clone(),
            lane.as_str()
                .ok_or_else(|| format!("tbd.{key} names no lane"))?
                .to_string(),
            value,
        ));
    }
    // Read through the block so the register counts as consumed.
    gates.whole("/tbd");
    Ok(out)
}

/// Every `null` leaf of the block that the TBD register does not list.
pub fn undeclared_nulls(gates: &Block) -> Result<Vec<String>, String> {
    let listed: Vec<String> = tbd_register(gates)?
        .into_iter()
        .map(|(k, _, _)| dotted_pointer(&k))
        .collect();
    Ok(gates
        .leaves()
        .into_iter()
        .filter(|p| gates.value.pointer(p).is_some_and(Value::is_null) && !listed.contains(p))
        .collect())
}

/// The block's declared form: every TBD value set to `null`.
pub fn declared_form(gates: &Block) -> Result<Value, String> {
    let mut v = gates.value.clone();
    for (key, _, _) in tbd_register(gates)? {
        *v.pointer_mut(&dotted_pointer(&key)).unwrap() = Value::Null;
    }
    Ok(v)
}

/// The pin's SHA-256 (see the module text).
pub fn declared_sha256(gates: &Block) -> Result<String, String> {
    sha256_bytes(canonical(&declared_form(gates)?).as_bytes())
}

/// The decision log page.
pub fn decision_log_page() -> String {
    std::env::var("LD01_S2_DECISION_LOG")
        .unwrap_or_else(|_| format!("{}/decision-log.md", wiki_model()))
}

fn hex64(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_ascii_hexdigit())
        .filter(|w| w.len() == 64)
        .map(|w| w.to_ascii_lowercase())
        .collect()
}

/// Table rows of a markdown page as their cells.
fn rows(page: &str) -> Vec<Vec<String>> {
    page.lines()
        .filter(|l| l.trim_start().starts_with('|'))
        .map(|l| {
            l.trim()
                .trim_matches('|')
                .split('|')
                .map(|c| c.trim().to_string())
                .collect()
        })
        .collect()
}

/// The IDs of rows another row supersedes: every row ID named, as a whole
/// token, after `Superseded:` in a cell (`Superseded: S2-F01`).
fn superseded_rows(log_rows: &[Vec<String>]) -> std::collections::BTreeSet<String> {
    let ids: std::collections::BTreeSet<&str> = log_rows
        .iter()
        .filter_map(|c| c.first().map(String::as_str))
        .collect();
    log_rows
        .iter()
        .flatten()
        .filter_map(|cell| cell.split_once("Superseded:").map(|(_, rest)| rest))
        .flat_map(|rest| rest.split(|c: char| c == ',' || c == ';' || c.is_whitespace()))
        .filter(|token| ids.contains(token))
        .map(str::to_string)
        .collect()
}

/// The frozen SHA of `ld01-s2-gates` the log pins: the last RP1 row naming
/// the block and exactly one 64-hex value. `Ok(None)` when no row pins it.
pub fn frozen_sha256(log: &str) -> Result<Option<(String, String)>, String> {
    let mut found = None;
    for cells in rows(log) {
        let id = cells.first().cloned().unwrap_or_default();
        let text = cells.join(" | ");
        if !id.starts_with("RP1") || !text.contains("ld01-s2-gates") {
            continue;
        }
        let shas = hex64(&text);
        match shas.len() {
            0 => {}
            1 => found = Some((id, shas[0].clone())),
            _ => {
                return Err(format!(
                    "decision-log row {id} names {} SHA-256 values",
                    shas.len()
                ));
            }
        }
    }
    Ok(found)
}

/// The pin check. `Ok` carries the receipt entry; a gate run refuses on
/// `pinned: false`.
pub fn pin(gates: &Block, log: Option<&str>) -> Result<Value, String> {
    let declared = declared_sha256(gates)?;
    let raw = sha256_bytes(canonical(&gates.value).as_bytes())?;
    let frozen = match log {
        Some(text) => frozen_sha256(text)?,
        None => None,
    };
    let pinned = frozen.as_ref().is_some_and(|(_, sha)| *sha == declared);
    Ok(
        json!({"rule": "sha256 of the canonical ld01-s2-gates JSON with every tbd value set to null, against the last decision-log RP1 row naming ld01-s2-gates and one sha256",
        "declared_sha256": declared, "filled_block_sha256": raw, "decision_log": decision_log_page(), "log_read": log.is_some(),
        "frozen_row": frozen.as_ref().map(|f| f.0.clone()), "frozen_sha256": frozen.map(|f| f.1), "pinned": pinned}),
    )
}

/// The TBD register's state: open values, fills and whether each fill has
/// its own log row naming the key and a 64-hex receipt SHA-256.
pub fn tbd_state(gates: &Block, log: Option<&str>) -> Result<Value, String> {
    let register = tbd_register(gates)?;
    let log_rows = log.map(rows).unwrap_or_default();
    let superseded = superseded_rows(&log_rows);
    let mut open = Vec::new();
    let mut fills = Vec::new();
    for (key, lane, value) in &register {
        if value.is_null() {
            open.push(json!({"key": key, "lane": lane}));
        } else {
            // The LAST row naming the key with a receipt SHA-256 (as the pin
            // takes the last RP1 row) that no row supersedes: a reopened
            // value is matched only by a fill logged for it, never by the
            // superseded one.
            let row = log_rows.iter().rev().find(|cells| {
                let text = cells.join(" | ");
                text.contains(key.as_str())
                    && !hex64(&text).is_empty()
                    && !cells.first().is_some_and(|id| superseded.contains(id))
            });
            fills.push(json!({"key": key, "lane": lane, "value": value,
                "logged_row": row.and_then(|c| c.first().cloned()),
                "receipt_sha256": row.map(|c| hex64(&c.join(" | ")))}));
        }
    }
    let unlogged = fills.iter().filter(|f| f["logged_row"].is_null()).count();
    let undeclared = undeclared_nulls(gates)?;
    Ok(
        json!({"open": open, "fills": fills, "unlogged_fills": unlogged, "undeclared_nulls": undeclared,
        "closed": open.is_empty() && unlogged == 0 && undeclared.is_empty()}),
    )
}

/// Why a gate run may not start, from the pin and TBD entries; empty when
/// it may.
pub fn gate_run_refusals(pin: &Value, tbd: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if pin["pinned"] != json!(true) {
        out.push(format!(
            "ld01-s2-gates is not pinned: declared sha256 {} against the frozen {}",
            pin["declared_sha256"], pin["frozen_sha256"]
        ));
    }
    for o in tbd["open"].as_array().into_iter().flatten() {
        out.push(format!("TBD({}) {} is open", o["lane"], o["key"]));
    }
    for f in tbd["fills"].as_array().into_iter().flatten() {
        if f["logged_row"].is_null() {
            out.push(format!("the fill of {} has no decision-log row", f["key"]));
        }
    }
    for n in tbd["undeclared_nulls"].as_array().into_iter().flatten() {
        out.push(format!("{n} is null but not in the TBD register"));
    }
    out
}

// --------------------------------------------------------------- work bound

/// The S2 work bound: process CPU charged by item against `totalCpu_s`.
#[derive(Clone, Debug)]
pub struct WorkBound {
    pub bound_s: f64,
    pub charged: Vec<(String, f64)>,
    /// Runs not started because their guard exceeded the remaining bound.
    pub not_started: Vec<Value>,
}

/// What the pre-check decided for one run.
#[derive(Clone, Debug, PartialEq)]
pub enum Admission {
    Start,
    /// Not started: S2 is incomplete, not failed.
    Incomplete {
        remaining_s: f64,
        guard_s: f64,
    },
}

impl WorkBound {
    pub fn new(gates: &Block) -> Self {
        Self {
            bound_s: gates.number("/totalCpu_s"),
            charged: Vec::new(),
            not_started: Vec::new(),
        }
    }
    pub fn used(&self) -> f64 {
        self.charged.iter().map(|(_, c)| c).sum()
    }
    pub fn remaining(&self) -> f64 {
        self.bound_s - self.used()
    }
    pub fn charge(&mut self, item: &str, cpu_s: f64) {
        self.charged.push((item.to_string(), cpu_s));
    }
    /// M1's pre-check: a run starts only if its total guard fits the
    /// remaining bound; otherwise it is recorded as not started.
    pub fn admit(&mut self, run: &str, guard_s: f64) -> Admission {
        let remaining = self.remaining();
        if guard_s.is_finite() && guard_s <= remaining {
            Admission::Start
        } else {
            self.not_started
                .push(json!({"run": run, "guard_s": guard_s, "remaining_s": remaining}));
            Admission::Incomplete {
                remaining_s: remaining,
                guard_s,
            }
        }
    }
    pub fn json(&self) -> Value {
        json!({"bound_s": self.bound_s, "total_cpu_s": self.used(), "remaining_s": self.remaining(),
            "within": self.used() <= self.bound_s,
            "charged": self.charged.iter().map(|(k, c)| json!({"item": k, "cpu_s": c})).collect::<Vec<_>>(),
            "not_started": self.not_started,
            "rule": "M1: a run whose total guard exceeds the remaining bound is not started; S2 is then incomplete, not failed"})
    }
}

// --------------------------------------------------------------------- caps

/// A declared run's budget over its span (CPU-s): the hold's
/// `budget_cpu_s_per_s` and the trip's whole-trip average; none for the
/// references and contrary cases.
pub fn budget_s(gates: &Block, run: &str, duration_s: f64) -> Option<f64> {
    match run {
        "hold" => Some(gates.number("/hold/budget_cpu_s_per_s") * duration_s),
        "trip" => Some(gates.number("/trip/wholeTripBudget_cpu_s_per_s") * duration_s),
        _ => None,
    }
}

/// The `caps_cpu_s` key of a run kind.
pub fn cap_key(run: &str) -> Result<&'static str, String> {
    Ok(match run {
        "s1Run6" => "s1Run6",
        "zeroTime" => "zeroTime",
        "settle" | "resettle" | "headerReservoir" => "settling",
        "hold" => "hold",
        "holdReference" => "holdReference",
        "trip" => "trip",
        "R0" => "R0",
        "R1" => "R1",
        "R2" => "R2",
        "stuckCluster" | "noTurbineTrip" => "contraryTripEach",
        other => return Err(format!("no declared cap for run kind {other}")),
    })
}

/// The declared solver-CPU cap of a run kind, checked against the cap
/// rule's computable floor at the run's declared span. `Err` while the cap
/// is open (TBD) or below its floor.
pub fn declared_cap(gates: &Block, run: &str, declared_span_s: f64) -> Result<Value, String> {
    let k = cap_key(run)?;
    let rule = gates.text("/capRule");
    let cap = gates
        .open_number(&format!("/caps_cpu_s/{k}"))
        .ok_or_else(|| format!("caps_cpu_s.{k} is open (TBD)"))?;
    let mut floor = budget_s(gates, run, declared_span_s).map_or(0., |b| 2. * b);
    if run == "R1" {
        floor = floor.max(gates.number("/r1CapFloor_cpu_s"));
    }
    if cap < floor {
        return Err(format!(
            "caps_cpu_s.{k} = {cap} CPU-s is below the cap rule's floor {floor} ({rule})"
        ));
    }
    Ok(
        json!({"run": run, "key": k, "cap_s": cap, "rule": rule, "floor_s": floor, "span_s": declared_span_s}),
    )
}

/// The total guard of a run: its cap plus 2 × observed samples × the
/// per-sample observation cost (`totalGuard.perSampleObservation_s`).
pub fn total_guard(gates: &Block, cap_s: f64, samples: f64) -> Result<f64, String> {
    gates.text("/totalGuard/rule");
    let per = gates
        .open_number("/totalGuard/perSampleObservation_s")
        .ok_or("totalGuard.perSampleObservation_s is open (TBD(HARNESS))")?;
    Ok(cap_s + 2. * samples * per)
}
