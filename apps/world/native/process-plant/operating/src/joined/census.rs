//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-coordinate-census
//! Coordinate and row census of the joined residual by class, against the
//! S2 design memo's Table 1.1 allocation.
//!
//! Every coordinate has exactly one row of its own class, so the census of
//! rows equals that of coordinates; the row kind (balance or constraint) is
//! stated per class. Composed blocks are counted from their compiled
//! layouts and current IDA identity. A block whose owner has not composed
//! it yet is listed as pending with the counts its interface declares, and
//! never counted as composed. Differences from the memo carry their reason.
use super::block::{Class, Layout};
use serde::Serialize;

/// One Table 1.1 row of the memo (`s2-design-memo-2026-10-10.md`, §1).
#[derive(Clone, Copy, Debug, Serialize)]
pub struct MemoRow {
    pub row: &'static str,
    pub owner: &'static str,
    pub classes: &'static [Class],
    /// The memo's [differential, algebraic] counts.
    pub memo: [usize; 2],
    /// Row kind of the class: what the coordinate's own row is.
    pub rows: &'static str,
}

/// Table 1.1 of the memo, in its order, then the two rows of G6 (S2 design
/// choices, 11 October), which the memo predates: its counts are zero.
pub const TABLE_1_1: [MemoRow; 18] = [
    MemoRow {
        row: "Regional N, 24 regions",
        owner: "nuclear",
        classes: &[Class::RegionalPopulation],
        memo: [24, 0],
        rows: "generator balance N' = rho/Lambda N - births + emission + S + transfers",
    },
    MemoRow {
        row: "Material precursors C (386x6)",
        owner: "nuclear",
        classes: &[Class::Precursor],
        memo: [2316, 0],
        rows: "C' = sum B - lambda C",
    },
    MemoRow {
        row: "Fissile, fertile, I, Xe, Pm, Sm (386x6)",
        owner: "nuclear",
        classes: &[
            Class::Fissile,
            Class::Fertile,
            Class::Iodine,
            Class::Xenon,
            Class::Promethium,
            Class::Samarium,
        ],
        memo: [2316, 0],
        rows: "depletion, capture and poison-chain balances",
    },
    MemoRow {
        row: "Delayed-energy reservoirs (386x(23+2))",
        owner: "nuclear",
        classes: &[Class::FissionHistory, Class::CaptureHistory],
        memo: [9650, 0],
        rows: "linear E' = y F - lambda E (constant structure, Nuclear::histories)",
    },
    MemoRow {
        row: "Fuel 2 + clad 1 energies per carrier",
        owner: "solids",
        classes: &[Class::FuelEnergy, Class::CladEnergy],
        memo: [1158, 1158],
        rows: "energy balance; temperature by exact local caloric inverse",
    },
    MemoRow {
        row: "Massless fuel/clad surfaces",
        owner: "solids",
        classes: &[Class::Surface],
        memo: [0, 1158],
        rows: "three surface heat balances per half (W)",
    },
    MemoRow {
        row: "Helium, 1 per FA",
        owner: "solids",
        classes: &[Class::HeliumEnergy],
        memo: [193, 193],
        rows: "energy balance; T = U/(1.5 nR)",
    },
    MemoRow {
        row: "Guide/plenum/fitting Zry stores",
        owner: "solids",
        classes: &[Class::PassiveEnergy],
        memo: [1351, 1351],
        rows: "energy balance; temperature by the exact Zircaloy inverse",
    },
    MemoRow {
        row: "SG metal, 4 per SG",
        owner: "solids",
        classes: &[Class::MetalEnergy],
        memo: [8, 8],
        rows: "e' = q_p - q_s; T = U/C + 273.15 K",
    },
    MemoRow {
        row: "Network cells 38 x (M_l,U_l,M_v,U_v,B; p)",
        owner: "network",
        classes: &[
            Class::CellPressure,
            Class::PhaseMass,
            Class::PhaseEnergy,
            Class::Tracer,
            Class::PzrAlgebraic,
            Class::PzrStock,
        ],
        memo: [190, 38],
        rows: "stock rows; EOS volume rows; the stratified cell's own rows",
    },
    MemoRow {
        row: "Network faces 48 x 2 phase impulses",
        owner: "network",
        classes: &[Class::Impulse],
        memo: [96, 0],
        rows: "Pi' = pressure/gravity + projected forces",
    },
    MemoRow {
        row: "RCP rotors",
        owner: "network",
        classes: &[Class::Rotor],
        memo: [4, 0],
        rows: "J omega' = tau",
    },
    MemoRow {
        row: "SG secondary x2",
        owner: "secondary",
        classes: &[Class::SecondaryStock, Class::SecondaryChart],
        memo: [4, 4],
        rows: "M, U balances; equilibrium chart rows for p, V_l",
    },
    MemoRow {
        row: "SG relief lift x4 valves",
        owner: "secondary",
        classes: &[Class::ReliefLift],
        memo: [4, 0],
        rows: "0.1 s lift lag",
    },
    MemoRow {
        row: "Rods 52 x (y, v) of the spider and bodies",
        owner: "rods",
        classes: &[Class::RodPosition, Class::RodVelocity],
        memo: [104, 0],
        rows: "y' = v; Newton per body (v algebraic when held or seated)",
    },
    MemoRow {
        row: "Guide passages, 1 per cluster",
        owner: "rods",
        classes: &[Class::GuideCurrent],
        memo: [0, 52],
        rows: "steady series balance of the guide passage",
    },
    MemoRow {
        row: "PZR heater rod segments, shell bands and heads (G6)",
        owner: "pzr",
        classes: &[Class::PzrMetal],
        memo: [0, 0],
        rows: "U' = Joule - fluid receipts - enclosure exchange - exterior loss; T by the exact 304 inverse",
    },
    MemoRow {
        row: "PZR relief lift (G6)",
        owner: "pzr",
        classes: &[Class::PzrReliefLift],
        memo: [0, 0],
        rows: "lift' = full strokes per second of the motion; stops by transaction",
    },
];
/// The memo's totals: differential, algebraic, all.
pub const MEMO_TOTAL: [usize; 3] = [17418, 3962, 21380];

/// One composed block's coordinates: its layout and current IDA identity.
pub struct Composed<'a> {
    pub owner: &'static str,
    pub layout: &'a Layout,
    /// Current identity (1 differential, 0 algebraic), layout order.
    pub differential: &'a [f64],
}

/// A block whose owner has not composed it: the counts its interface or
/// the memo declares per class.
pub struct Pending {
    pub owner: &'static str,
    pub by: &'static str,
    pub classes: Vec<(Class, [usize; 2])>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Entry {
    pub row: &'static str,
    pub owner: &'static str,
    pub rows: &'static str,
    pub memo: [usize; 2],
    /// Counted from composed layouts, or `None` while the owner is pending.
    pub composed: Option<[usize; 2]>,
    /// Declared counts of a pending owner.
    pub declared: Option<[usize; 2]>,
    pub pending_by: Option<&'static str>,
    pub per_class: Vec<(Class, [usize; 2])>,
    pub difference: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Census {
    pub entries: Vec<Entry>,
    /// Composed blocks only: differential, algebraic, all.
    pub composed: [usize; 3],
    /// Composed plus the pending owners' declared counts.
    pub with_pending: [usize; 3],
    pub memo: [usize; 3],
    pub scope: &'static str,
}

/// Reasons for every expected difference from Table 1.1.
fn difference(row: &str) -> Option<&'static str> {
    Some(match row {
        "Fuel 2 + clad 1 energies per carrier"
        | "Helium, 1 per FA"
        | "Guide/plenum/fitting Zry stores"
        | "SG metal, 4 per SG" => {
            "caloric temperatures eliminated by exact local inverses (memo §1 [P]; computational-design-review.md §4.1)"
        }
        "Network cells 38 x (M_l,U_l,M_v,U_v,B; p)" => {
            "decision 0014 with amendment 6: 28 regular cells x 6 plus one 19-coordinate stratified PZR cell (7 algebraic, 12 differential, zone A's bubble stock included) replace the 10 PZR volumes"
        }
        "Network faces 48 x 2 phase impulses" => {
            "decision 0014: 35 faces (the PZR's 13 internal faces removed)"
        }
        "Rods 52 x (y, v) of the spider and bodies" => {
            "a held or seated body's v row is algebraic (memo §4): 52 move to algebraic at the hold"
        }
        "PZR heater rod segments, shell bands and heads (G6)" | "PZR relief lift (G6)" => {
            "G6 (S2 design choices, 11 October): the PZR shell, heads, heater metal and relief join S2 after the memo's allocation"
        }
        _ => return None,
    })
}

/// The census of composed and pending blocks against Table 1.1.
pub fn census(composed: &[Composed<'_>], pending: &[Pending]) -> Census {
    let mut entries = Vec::new();
    let mut total = [0usize; 2];
    let mut with_pending = [0usize; 2];
    for memo in TABLE_1_1 {
        let mut per_class: Vec<(Class, [usize; 2])> = Vec::new();
        let mut counted = [0usize; 2];
        let mut found = false;
        for block in composed {
            for (i, class) in block.layout.classes.iter().enumerate() {
                if memo.classes.contains(class) {
                    found = true;
                    let k = usize::from(block.differential[i] == 0.);
                    counted[k] += 1;
                    match per_class.iter_mut().find(|(c, _)| c == class) {
                        Some((_, n)) => n[k] += 1,
                        None => {
                            let mut n = [0, 0];
                            n[k] = 1;
                            per_class.push((*class, n));
                        }
                    }
                }
            }
        }
        let mut declared = None;
        let mut pending_by = None;
        if !found {
            for p in pending {
                let mut d = [0usize; 2];
                let mut any = false;
                for (class, n) in &p.classes {
                    if memo.classes.contains(class) {
                        any = true;
                        d[0] += n[0];
                        d[1] += n[1];
                        per_class.push((*class, *n));
                    }
                }
                if any {
                    declared = Some(d);
                    pending_by = Some(p.by);
                }
            }
        }
        if found {
            total[0] += counted[0];
            total[1] += counted[1];
            with_pending[0] += counted[0];
            with_pending[1] += counted[1];
        } else if let Some(d) = declared {
            with_pending[0] += d[0];
            with_pending[1] += d[1];
        }
        let shown = if found { Some(counted) } else { declared };
        entries.push(Entry {
            row: memo.row,
            owner: memo.owner,
            rows: memo.rows,
            memo: memo.memo,
            composed: found.then_some(counted),
            declared,
            pending_by,
            per_class,
            difference: shown.filter(|c| *c != memo.memo).and(difference(memo.row)),
        });
    }
    Census {
        entries,
        composed: [total[0], total[1], total[0] + total[1]],
        with_pending: [
            with_pending[0],
            with_pending[1],
            with_pending[0] + with_pending[1],
        ],
        memo: MEMO_TOTAL,
        scope: "coordinates = rows; one row per coordinate of its class; pending owners are declared counts, not composed",
    }
}
