//! The S2 declaration's numbers, read as data from its strict blocks.
//!
//! The S2 harness is the single numeric consumer of `ld01-s2-gates` and
//! `ld01-s2-accuracy` (the S2 declaration) and of the values S2 shares from
//! `ld01-s1-gates` and `ld01-accuracy-contract`. Nothing is hard-coded here:
//! every value is read by its JSON pointer from the block that owns it, a
//! missing or mistyped key refuses loudly, and every leaf of the S2 blocks
//! that no harness code read is listed ([`Block::unread`]) so a declared
//! value the harness does not implement can never pass silently: a gate run
//! refuses while any remains, a smoke run reports them.
//!
//! The declaration page is `LD01_S2_DECLARATION` (a markdown file holding
//! both S2 blocks: the research draft until revision 7 is published), else
//! the wiki's `build-readiness.md` under `LD01_WIKI_ROOT`.
use crate::provenance::sha256_file;
use serde_json::{Value, json};
use std::{cell::RefCell, collections::BTreeSet};

/// The model directory of the wiki named by `LD01_WIKI_ROOT`.
pub fn wiki_model() -> String {
    let wiki = std::env::var("LD01_WIKI_ROOT").expect("LD01_WIKI_ROOT names the wiki");
    format!("{wiki}/world/packs/process-plant/reference-designs/ld-01/model")
}

/// The page holding `ld01-s2-gates` and `ld01-s2-accuracy`.
pub fn declaration_page() -> String {
    std::env::var("LD01_S2_DECLARATION")
        .unwrap_or_else(|_| format!("{}/build-readiness.md", wiki_model()))
}

/// The text of one fenced strict block of a page, refused if absent or
/// unterminated.
pub fn fenced(text: &str, fence: &str, page: &str) -> Result<String, String> {
    let open = format!("```{fence}\n");
    let start = text
        .find(&open)
        .ok_or_else(|| format!("{page} has no ```{fence} block"))?
        + open.len();
    if text[start..].contains(&open) {
        return Err(format!("{page} has more than one ```{fence} block"));
    }
    let end = start
        + text[start..]
            .find("\n```")
            .ok_or_else(|| format!("unterminated ```{fence} block in {page}"))?;
    Ok(text[start..end].to_string())
}

/// One strict block as data: its JSON, where it came from, and which of its
/// leaves the harness has read.
#[derive(Debug)]
pub struct Block {
    pub fence: String,
    pub page: String,
    pub page_sha256: String,
    pub value: Value,
    read: RefCell<BTreeSet<String>>,
}

impl Block {
    /// The block `fence` of `page`.
    pub fn from_page(page: &str, fence: &str) -> Result<Self, String> {
        let text = std::fs::read_to_string(page).map_err(|e| format!("{page}: {e}"))?;
        let value = serde_json::from_str(&fenced(&text, fence, page)?)
            .map_err(|e| format!("{fence} in {page}: {e}"))?;
        Ok(Self {
            fence: fence.into(),
            page: page.into(),
            page_sha256: sha256_file(page)?,
            value,
            read: RefCell::default(),
        })
    }
    /// A block given as JSON text (unit tests and fixtures).
    pub fn from_json(fence: &str, text: &str) -> Result<Self, String> {
        Ok(Self {
            fence: fence.into(),
            page: "(fixture)".into(),
            page_sha256: String::new(),
            value: serde_json::from_str(text).map_err(|e| format!("{fence}: {e}"))?,
            read: RefCell::default(),
        })
    }
    fn at(&self, pointer: &str) -> Result<&Value, String> {
        let v = self
            .value
            .pointer(pointer)
            .ok_or_else(|| format!("{} declares no {pointer}", self.fence))?;
        self.read.borrow_mut().insert(pointer.into());
        Ok(v)
    }
    /// A finite number.
    pub fn number(&self, pointer: &str) -> f64 {
        let v = self.at(pointer).unwrap_or_else(|e| panic!("{e}"));
        v.as_f64()
            .filter(|x| x.is_finite())
            .unwrap_or_else(|| panic!("{}{pointer} is not a finite number: {v}", self.fence))
    }
    /// A finite number or the declared `null` of an open value.
    pub fn open_number(&self, pointer: &str) -> Option<f64> {
        let v = self.at(pointer).unwrap_or_else(|e| panic!("{e}"));
        if v.is_null() {
            return None;
        }
        Some(
            v.as_f64().filter(|x| x.is_finite()).unwrap_or_else(|| {
                panic!("{}{pointer} is neither null nor finite: {v}", self.fence)
            }),
        )
    }
    /// A nonnegative whole number.
    pub fn count(&self, pointer: &str) -> u64 {
        let v = self.at(pointer).unwrap_or_else(|e| panic!("{e}"));
        v.as_u64()
            .unwrap_or_else(|| panic!("{}{pointer} is not a whole count: {v}", self.fence))
    }
    pub fn text(&self, pointer: &str) -> String {
        let v = self.at(pointer).unwrap_or_else(|e| panic!("{e}"));
        v.as_str()
            .unwrap_or_else(|| panic!("{}{pointer} is not text: {v}", self.fence))
            .to_string()
    }
    pub fn flag(&self, pointer: &str) -> bool {
        let v = self.at(pointer).unwrap_or_else(|e| panic!("{e}"));
        v.as_bool()
            .unwrap_or_else(|| panic!("{}{pointer} is not a flag: {v}", self.fence))
    }
    /// An array of finite numbers.
    pub fn numbers(&self, pointer: &str) -> Vec<f64> {
        let v = self.at(pointer).unwrap_or_else(|e| panic!("{e}"));
        v.as_array()
            .unwrap_or_else(|| panic!("{}{pointer} is not an array: {v}", self.fence))
            .iter()
            .map(|x| {
                x.as_f64()
                    .filter(|x| x.is_finite())
                    .unwrap_or_else(|| panic!("{}{pointer} holds {x}", self.fence))
            })
            .collect()
    }
    /// An array of text.
    pub fn texts(&self, pointer: &str) -> Vec<String> {
        let v = self.at(pointer).unwrap_or_else(|e| panic!("{e}"));
        v.as_array()
            .unwrap_or_else(|| panic!("{}{pointer} is not an array: {v}", self.fence))
            .iter()
            .map(|x| {
                x.as_str()
                    .unwrap_or_else(|| panic!("{}{pointer} holds {x}", self.fence))
                    .to_string()
            })
            .collect()
    }
    /// Every leaf pointer of the block (arrays count as one leaf).
    pub fn leaves(&self) -> Vec<String> {
        fn walk(v: &Value, at: String, out: &mut Vec<String>) {
            match v {
                Value::Object(map) => {
                    for (k, x) in map {
                        walk(
                            x,
                            format!("{at}/{}", k.replace('~', "~0").replace('/', "~1")),
                            out,
                        );
                    }
                }
                _ => out.push(at),
            }
        }
        let mut out = Vec::new();
        walk(&self.value, String::new(), &mut out);
        out
    }
    /// Leaves no harness code has read, in pointer order. An object read
    /// whole (a pointer to it) counts for every leaf under it.
    pub fn unread(&self) -> Vec<String> {
        let read = self.read.borrow();
        self.leaves()
            .into_iter()
            .filter(|leaf| {
                !read
                    .iter()
                    .any(|r| leaf == r || leaf.starts_with(&format!("{r}/")))
            })
            .collect()
    }
    /// The block's provenance and consumption, for the receipt.
    pub fn receipt(&self) -> Value {
        json!({"fence": self.fence, "page": self.page, "page_sha256": self.page_sha256,
            "block": self.value, "unread": self.unread()})
    }
}

/// Everything S2 reads as declared data.
#[derive(Debug)]
pub struct Declaration {
    /// `ld01-s2-gates`: the S2 declaration's own configuration and gates.
    pub gates: Block,
    /// `ld01-s2-accuracy`: the S2 budgets beside the S1 contract.
    pub accuracy: Block,
    /// `ld01-s1-gates`: the values S2 shares from S1 (`sharedFrom`).
    pub shared: Block,
    /// `ld01-accuracy-contract`: the S1 budgets S2's comparison keeps
    /// (`thresholdTiming_s`, `uncreditedAbove_Hz`).
    pub contract: Block,
}

impl Declaration {
    /// The declaration page's S2 blocks and the wiki's shared S1 blocks.
    pub fn load() -> Result<Self, String> {
        let page = declaration_page();
        let model = wiki_model();
        let declaration = Self {
            gates: Block::from_page(&page, "ld01-s2-gates")?,
            accuracy: Block::from_page(&page, "ld01-s2-accuracy")?,
            shared: Block::from_page(&format!("{model}/build-readiness.md"), "ld01-s1-gates")?,
            contract: Block::from_page(
                &format!("{model}/operating-hot-spine.md"),
                "ld01-accuracy-contract",
            )?,
        };
        declaration.check()?;
        Ok(declaration)
    }
    /// The declaration's own consistency, before any run: the shared block
    /// is the one it names, the build and KLU ordering are the ones this
    /// harness links and sets, and the observation interval divides the
    /// output interval.
    pub fn check(&self) -> Result<(), String> {
        let shared = self.gates.text("/sharedFrom");
        if shared != self.shared.fence {
            return Err(format!(
                "ld01-s2-gates shares from {shared}, not {}",
                self.shared.fence
            ));
        }
        let build = self.gates.text("/build");
        if build != "quadratures" || !cfg!(feature = "quadratures") {
            return Err(format!(
                "the declared build is {build}; this binary is built {}",
                if cfg!(feature = "quadratures") {
                    "with quadratures"
                } else {
                    "without quadratures"
                }
            ));
        }
        let ordering = self.gates.text("/kluOrdering");
        if ordering != "AMD" {
            return Err(format!(
                "the declared KLU ordering is {ordering}; the joined system sets AMD"
            ));
        }
        let dt = self.shared.number("/comparison/observation_s");
        let output = self.gates.number("/outputInterval_s");
        let n = (output / dt).round();
        if n < 2. || (n * dt - output).abs() > 1e-9 * output {
            return Err(format!(
                "the {dt} s observation must divide the {output} s output interval"
            ));
        }
        Ok(())
    }
    /// Every S2 leaf not yet consumed, by block.
    pub fn unread(&self) -> Value {
        json!({"ld01-s2-gates": self.gates.unread(), "ld01-s2-accuracy": self.accuracy.unread()})
    }
    /// True when every S2 leaf has been consumed (a gate run's precondition).
    pub fn fully_consumed(&self) -> bool {
        self.gates.unread().is_empty() && self.accuracy.unread().is_empty()
    }
    pub fn receipt(&self) -> Value {
        json!({"page": declaration_page(), "gates": self.gates.receipt(), "accuracy": self.accuracy.receipt(),
            "shared": {"fence": self.shared.fence, "page": self.shared.page, "page_sha256": self.shared.page_sha256},
            "contract": {"fence": self.contract.fence, "page": self.contract.page, "page_sha256": self.contract.page_sha256, "block": self.contract.value}})
    }
}

/// Derived run caps, each from its declared basis (the work-bound table):
/// a quiet or trip run's solver-CPU cap is `runCapFactor` times its budget
/// over its duration; the references' caps are declared directly.
pub fn solver_cap_s(gates: &Block, run: &str) -> f64 {
    let factor = gates.number("/runCapFactor");
    match run {
        "hold" => {
            factor * gates.number("/hold/budget_cpu_s_per_s") * gates.number("/hold/duration_s")
        }
        "trip" => {
            factor
                * gates.number("/trip/wholeTripBudget_cpu_s_per_s")
                * gates.number("/trip/duration_s")
        }
        "holdReference" | "R0" | "R1" | "R2" => {
            gates.number(&format!("/referenceCaps_cpu_s/{run}"))
        }
        "zeroTime" => gates.number("/zeroTime/maxSolverCpu_s"),
        other => panic!("no declared solver-CPU cap basis for run {other}"),
    }
}
